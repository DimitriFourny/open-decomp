import assert from 'node:assert/strict';
import { copyFile, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { newIdentity, type ToolInput } from '../../src/core/index.js';
import { QueryService } from '../../src/service/queries/index.js';

// sigfix-stripped (test/metadata/fixtures/signatures): a program linked with libsigfix.a,
// without symbols. Function entries are those of sigfix-symbols.
const SIG_DUP = '0x1230',
  SIG_COUNT = '0x1200',
  MAIN = '0x1090';

test(
  'library_match annotations name functions with provenance and supply declarations to callers',
  { timeout: 300_000 },
  async (t) => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'open-decomp-library-matches-')));
    const binary = join(root, 'sigfix-stripped');
    await copyFile(resolve('test/metadata/fixtures/signatures/sigfix-stripped'), binary);
    const service = await QueryService.create({ authorized_roots: [root], max_workers: 1 });
    t.after(async () => {
      await service.close('cancel');
      await rm(root, { recursive: true, force: true });
    });
    const opened = await service.execute('project_open', {
      source: { kind: 'import', input_path: binary, project_path: join(root, 'project') },
      wait: true,
    });
    assert.ok('data' in opened && opened.data.image && opened.project_id && opened.revision);
    const project_id = opened.project_id,
      image_id = opened.data.image.id;
    let revision = opened.revision;
    for (;;) {
      const step = await service.execute('functions_discover', { project_id, revision, image_id });
      assert.ok('data' in step, JSON.stringify(step));
      if (!step.data.progressed) break;
      revision = step.data.revision;
    }
    const list = async () => {
      const found = await service.execute('functions_find', {
        project_id,
        revision,
        image_id,
        page: { limit: 1000 },
      });
      assert.ok('data' in found);
      return found.data.items;
    };
    const at = async (entry: string) => {
      const items = await list();
      const fn = items.find((item) => item.entry.value === entry);
      assert.ok(fn, `no function at ${entry}: ${items.map((item) => item.entry.value).join(' ')}`);
      return fn;
    };
    const decompileMain = async () => {
      const result = await service.execute('function_decompile', {
        project_id,
        revision,
        function_id: (await at(MAIN)).id,
        wait: true,
      });
      assert.ok('data' in result && result.data.delivery === 'inline', JSON.stringify(result));
      return result.data.emission.text;
    };
    const apply = async (edits: ToolInput<'annotations_apply'>['edits']) => {
      const result = await service.execute('annotations_apply', {
        project_id,
        expected_revision: revision,
        author: 'test',
        origin: 'user',
        edits,
      });
      assert.ok('data' in result, JSON.stringify(result));
      revision = result.data.revision;
    };
    const before = await decompileMain();
    assert.match(before, /sub_1230\(/);
    const dup = await at(SIG_DUP),
      count = await at(SIG_COUNT);
    assert.equal(dup.display_name, null);
    // sig_dup implements strdup's declaration; sig_count is matched without one.
    const match = newIdentity('annotation'),
      plain = newIdentity('annotation');
    await apply([
      {
        operation: 'set',
        id: match,
        entity_id: dup.id,
        value: {
          kind: 'library_match',
          library: 'sigfix-test',
          name: 'sig_dup',
          contract: { library: 'libc.so.6', name: 'strdup' },
        },
        status: 'asserted',
        evidence_ids: [],
      },
      {
        operation: 'set',
        id: plain,
        entity_id: count.id,
        value: { kind: 'library_match', library: 'sigfix-test', name: 'sig_count', contract: null },
        status: 'asserted',
        evidence_ids: [],
      },
    ]);
    const presented = await at(SIG_DUP);
    assert.equal(presented.display_name, 'sig_dup');
    assert.deepEqual(presented.library_match, { library: 'sigfix-test', name: 'sig_dup' });
    const after = await decompileMain();
    // Callers name the function and type its call with the declaration (strdup's char *).
    assert.match(after, /sig_dup\(/);
    assert.match(after, /sig_count\(/);
    assert.match(after, /char\* sig_dup\(const char\*\)|char \*sig_dup\(const char \*\)/);
    // A user's name wins over a library match, and the provenance stays visible.
    await apply([
      {
        operation: 'set',
        id: newIdentity('annotation'),
        entity_id: dup.id,
        value: { kind: 'name', value: 'my_dup' },
        status: 'asserted',
        evidence_ids: [],
      },
    ]);
    const renamed = await at(SIG_DUP);
    assert.equal(renamed.display_name, 'my_dup');
    assert.equal(renamed.library_match, undefined);
    const metadata = await service.execute('function_get', {
      project_id,
      revision,
      function_id: dup.id,
      view: 'metadata',
    });
    assert.ok('data' in metadata && metadata.data.view === 'metadata');
    assert.ok(
      (metadata.data.annotations as { value: { kind: string } }[]).some(
        (annotation) => annotation.value.kind === 'library_match',
      ),
    );
    // Removing the match restores the unnamed function.
    await apply([{ operation: 'remove', id: plain }]);
    assert.equal((await at(SIG_COUNT)).display_name, null);
    // A library match names functions only.
    const rejected = await service.execute('annotations_apply', {
      project_id,
      expected_revision: revision,
      author: 'test',
      origin: 'user',
      edits: [
        {
          operation: 'set',
          id: newIdentity('annotation'),
          address: { image_id, space: 'va', value: '0x4010' },
          value: { kind: 'library_match', library: 'x', name: 'x', contract: null },
          status: 'asserted',
          evidence_ids: [],
        },
      ],
    });
    assert.ok(!('data' in rejected) || rejected.state !== 'complete');
  },
);
