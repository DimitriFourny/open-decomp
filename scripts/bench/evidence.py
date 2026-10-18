# SPDX-License-Identifier: MIT
"""Resolve pinned archives outside git; verify each resolved asset once per process."""
import hashlib
import json
import os
from pathlib import Path

_HERE = Path(__file__).resolve().parent
_MANIFEST = json.loads((_HERE / 'evidence-assets.json').read_text())
if _MANIFEST['schema'] != 1:
    raise RuntimeError('Unsupported evidence manifest')
_ASSETS = {asset['path']: asset for asset in _MANIFEST['assets']}
_VERIFIED = set()


def evidence_path(repo_relative_path: str) -> Path:
    asset = _ASSETS.get(repo_relative_path)
    if asset is None:
        raise ValueError(f'Unknown evidence archive: {repo_relative_path}')
    store = Path(os.environ.get(_MANIFEST['store_env'], _HERE.parent.parent / _MANIFEST['default_store']))
    path = (store / repo_relative_path).resolve()
    if path not in _VERIFIED:
        try:
            with path.open('rb') as stream:
                if not path.is_file() or os.fstat(stream.fileno()).st_size != asset['bytes']:
                    raise RuntimeError(f'{repo_relative_path}: evidence size mismatch')
                digest = hashlib.file_digest(stream, 'sha256').hexdigest()
                if stream.tell() != asset['bytes'] or digest != asset['sha256']:
                    raise RuntimeError(f'{repo_relative_path}: evidence SHA256/size mismatch')
        except FileNotFoundError as error:
            raise FileNotFoundError(
                f'Missing evidence archive: {path}. Run: node --import tsx scripts/bench/fetch-evidence.ts '
                f'--only {path.name} (with exactly one of --from DIR or --url-base URL).'
            ) from error
        _VERIFIED.add(path)
    return path
