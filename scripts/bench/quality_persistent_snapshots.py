"""Trusted benchmark-only closed SQLite snapshot copies; never opens a target executable.

Project IDs/revisions and native context scope are preserved byte-for-byte. Each
copy has a distinct directory and is opened only after the previous MCP owner
has closed. Manifests include every regular file, including WAL/cache artifacts.
"""
import hashlib
import json
from pathlib import Path
import shutil
import sqlite3
import stat

import quality


def project_manifest(directory):
    directory = Path(directory)
    quality.require(directory.is_dir() and not directory.is_symlink(), 'Snapshot root must be a real directory')
    files = []
    for path in sorted(directory.rglob('*')):
        mode = path.lstat().st_mode
        quality.require(not stat.S_ISLNK(mode), f'Snapshot cannot contain symlinks: {path}')
        quality.require(stat.S_ISREG(mode) or stat.S_ISDIR(mode), f'Snapshot contains a non-file object: {path}')
        if stat.S_ISREG(mode):
            files.append({'path': str(path.relative_to(directory)), 'bytes': path.stat().st_size,
                          'sha256': quality.digest(path)})
    quality.require(any(row['path'] == 'project.sqlite' for row in files), 'Snapshot has no SQLite project')
    return files


def closed_project_facts(directory):
    """Logical import facts exclude only the random project handle and job history.

    Both are retained separately/in the full file manifest. No inference/context
    IDs are rewritten. This fingerprint is for initial imports, not permission
    to treat independent post-analysis contexts as equivalent.
    """
    directory = Path(directory)
    project_manifest(directory)
    directory = directory.resolve()
    database = directory / 'project.sqlite'
    connection = sqlite3.connect(database.as_uri() + '?mode=ro', uri=True, timeout=0)
    try:
        cursor = connection.execute('SELECT * FROM metadata WHERE singleton=1')
        row = cursor.fetchone()
        quality.require(row is not None, 'Closed project has no acknowledged identity')
        metadata = dict(zip((column[0] for column in cursor.description), row))
        logical_metadata = {
            name: {'blob_bytes': len(value), 'blob_sha256': hashlib.sha256(value).hexdigest()}
            if isinstance(value, bytes) else value
            for name, value in metadata.items() if name != 'project_id'}
        schema_version = connection.execute('PRAGMA user_version').fetchone()[0]
        schema = connection.execute(
            "SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name"
        ).fetchall()
        tables = {}
        for (table,) in connection.execute(
                "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"):
            if table in ('metadata', 'jobs'):
                continue
            quoted = '"' + table.replace('"', '""') + '"'
            cursor = connection.execute(f'SELECT * FROM {quoted}')
            columns = [column[0] for column in cursor.description]
            rows = []
            for row in cursor:
                values = [{'blob_bytes': len(value), 'blob_sha256': hashlib.sha256(value).hexdigest()}
                          if isinstance(value, bytes) else value for value in row]
                encoded = json.dumps(values, ensure_ascii=False, separators=(',', ':'), allow_nan=False).encode()
                rows.append(hashlib.sha256(encoded).hexdigest())
            payload = json.dumps({'columns': columns, 'rows': sorted(rows)}, separators=(',', ':')).encode()
            tables[table] = {'rows': len(rows), 'sha256': hashlib.sha256(payload).hexdigest()}
        facts = {'revision': metadata['revision'], 'metadata': logical_metadata,
                 'schema_version': schema_version, 'schema': schema, 'tables': tables}
        encoded = json.dumps(facts, sort_keys=True, separators=(',', ':')).encode()
        return {'project_id': metadata['project_id'], **facts,
                'facts_sha256': hashlib.sha256(encoded).hexdigest(),
                'published_artifacts': tables.get('artifacts', {}).get('rows', 0)}
    finally:
        connection.close()


def freeze_closed_project(source, destination, cache_cold=False):
    source, destination = Path(source), Path(destination)
    quality.require(not source.is_symlink() and not destination.is_symlink(), 'Snapshot roots cannot be symlinks')
    source, destination = source.resolve(), destination.resolve()
    quality.require(not destination.exists(), 'Never overwrite an existing snapshot')
    before = closed_project_facts(source)
    if cache_cold:
        quality.require(before['published_artifacts'] == 0, 'Post-import control must have no decompilation artifacts')
    files = project_manifest(source)
    destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.copytree(source, destination, symlinks=True)
    quality.require(project_manifest(destination) == files, 'Closed project copy is not byte-identical')
    after = closed_project_facts(destination)
    quality.require(after == before, 'Copied project changed identity, revision, facts or cache state')
    # A read-only WAL reader may create/remove SQLite bookkeeping files. Capture
    # the final closed snapshot after validation, then clone those exact bytes.
    manifest = {'source': str(source), 'directory': str(destination),
                'cache_cold': cache_cold, 'facts': after,
                'files': project_manifest(destination), 'target_executed': False}
    path = destination.parent / f'{destination.name}.manifest.json'
    quality.save(path, manifest)
    return {**manifest, 'manifest': str(path), 'manifest_sha256': quality.digest(path)}


def clone_snapshot(snapshot, destination):
    source, destination = Path(snapshot['directory']), Path(destination)
    quality.require(not destination.exists(), 'Never overwrite retained project evidence')
    quality.require(project_manifest(source) == snapshot['files'], 'Frozen snapshot changed before cloning')
    destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.copytree(source, destination, symlinks=True)
    quality.require(project_manifest(destination) == snapshot['files'], 'Control project clone is not byte-identical')
    return {'snapshot_manifest': snapshot['manifest'], 'snapshot_manifest_sha256': snapshot['manifest_sha256'],
            'project_id': snapshot['facts']['project_id'], 'revision': snapshot['facts']['revision'],
            'facts_sha256': snapshot['facts']['facts_sha256'],
            'published_artifacts': snapshot['facts']['published_artifacts'],
            'directory': str(destination)}
