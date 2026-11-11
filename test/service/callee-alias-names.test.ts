import assert from 'node:assert/strict';
import { copyFile, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { QueryService } from '../../src/service/queries/index.js';

// alias-exported (test/metadata/fixtures/names): `scale(int, int)` at 0x1000 is a function
// and the dynamic export `_Z5scaleii`; `entry` at 0x1006 calls it twice.
test(
  'a call to a function with a differently spelled export alias prints the function name',
  { timeout: 300_000 },
  async (t) => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'open-decomp-alias-names-')));
    const binary = join(root, 'alias-exported');
    await copyFile(resolve('test/metadata/fixtures/names/alias-exported'), binary);
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
    const found = await service.execute('functions_find', {
      project_id,
      revision,
      image_id,
      page: { limit: 1000 },
    });
    assert.ok('data' in found);
    const entry = found.data.items.find((item) => item.entry.value === '0x1006'),
      scale = found.data.items.find((item) => item.entry.value === '0x1000');
    assert.ok(entry && scale);
    assert.equal(scale.display_name, 'scale(int, int)');
    const result = await service.execute('function_decompile', {
      project_id,
      revision,
      function_id: entry.id,
      wait: true,
    });
    assert.ok('data' in result && result.data.delivery === 'inline', JSON.stringify(result));
    const text = result.data.emission.text;
    assert.equal(text.match(/\bscale_int__int_\(/g)?.length, 2, text);
    assert.doesNotMatch(text, /sub_1000/);
  },
);
