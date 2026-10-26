import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { entityIdentity, newIdentity, type ToolInput } from '../../../src/core/index.js';
import { QueryService } from '../../../src/service/queries/index.js';
import { CLANG, nativeOracleSkip } from '../../support/host-tools.js';

// rec_id and rec_kind never call each other: they share one recovered class only
// through their common callee rec_size and their common caller main.
const SOURCE = `#include <stdint.h>
struct Rec { int32_t id; int32_t kind; int64_t size; double weight; };
__attribute__((noinline)) int64_t rec_size(struct Rec *r) { return r->size; }
__attribute__((noinline)) int32_t rec_id(struct Rec *r) { return r->id + (int32_t)rec_size(r); }
__attribute__((noinline)) int32_t rec_kind(struct Rec *r) { return r->kind * 3 + (int32_t)rec_size(r); }
__attribute__((noinline)) int32_t unrelated(int32_t x) { return x * 7 + 3; }
int main(int argc, char **argv) { struct Rec r = {argc, argc + 1, 8, 1.0}; return rec_id(&r) + rec_kind(&r); }
`;

test(
  'an asserted signature on one function binds the recovered image type everywhere it appears',
  { skip: nativeOracleSkip(), timeout: 300_000 },
  async (t) => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'open-decomp-image-type-binding-')));
    await writeFile(join(root, 'rec.c'), SOURCE);
    const binary = join(root, 'rec');
    const compiled = spawnSync(
      CLANG,
      [
        '-target',
        'arm64-apple-macos13.0',
        '-O1',
        '-g0',
        '-fno-inline',
        join(root, 'rec.c'),
        '-o',
        binary,
      ],
      { encoding: 'utf8' },
    );
    assert.equal(compiled.status, 0, compiled.stderr);
    const service = await QueryService.create({ authorized_roots: [root], max_workers: 1 });
    t.after(async () => {
      await service.close();
      await rm(root, { recursive: true, force: true });
    });
    const opened = await service.execute('project_open', {
      source: { kind: 'import', input_path: binary, project_path: join(root, 'project') },
      wait: true,
    });
    assert.ok('data' in opened && opened.data.image && opened.project_id && opened.revision);
    const project_id = opened.project_id,
      image_id = opened.data.image.id,
      slice = opened.data.image.selected_slice_id;
    let revision = opened.revision;
    const found = await service.execute('functions_find', {
      project_id,
      revision,
      image_id,
      page: { limit: 100 },
    });
    assert.ok('data' in found);
    const id = (name: string): string =>
      found.data.items.find((fn) => fn.original_name === `_${name}`)!.id;
    const decompile = async (name: string) => {
      const result = await service.execute('function_decompile', {
        project_id,
        revision,
        function_id: id(name),
        wait: true,
        options: {},
      });
      assert.ok('data' in result && result.data.delivery === 'inline', JSON.stringify(result));
      return {
        text: result.data.emission.text,
        cache: result.data.cache,
        diagnostics: result.diagnostics.map((item) => `${item.severity}: ${item.message}`),
      };
    };
    const declare = async (source: string) => {
      const result = await service.execute('types_declare', {
        project_id,
        expected_revision: revision,
        image_id,
        author: 'image-type-binding-test',
        origin: 'llm',
        source,
      });
      assert.ok('data' in result, JSON.stringify(result));
      revision = result.data.revision;
      return (name: string): string =>
        result.data.types.find((type) => type.name === name || type.key === name)!.type_id;
    };
    const apply = async (edits: ToolInput<'annotations_apply'>['edits']): Promise<void> => {
      const result = await service.execute('annotations_apply', {
        project_id,
        expected_revision: revision,
        author: 'image-type-binding-test',
        origin: 'llm',
        edits,
      });
      assert.ok('data' in result, JSON.stringify(result));
      revision = result.data.revision;
    };
    const signature = (annotation: string, name: string, pointer: string, result: string) => ({
      operation: 'set' as const,
      id: annotation,
      entity_id: id(name),
      value: {
        kind: 'signature' as const,
        value: {
          abi: 'darwin-arm64' as const,
          return_type: result,
          parameters: [
            {
              id: entityIdentity(slice, 'image-type-binding-test', [name]),
              name: 'record',
              type_id: pointer,
            },
          ],
          variadic: false,
          noreturn: false,
          evidence_ids: [],
        },
      },
      status: 'asserted' as const,
      evidence_ids: [],
    });

    // Before any declaration both functions print the same recovered class.
    const label = /\bstruct_[0-9a-f]{6,}\b/;
    const kindBefore = await decompile('rec_kind');
    const idBefore = await decompile('rec_id');
    const recovered = label.exec(kindBefore.text)?.[0];
    assert.ok(recovered, kindBefore.text);
    assert.equal(label.exec(idBefore.text)?.[0], recovered, idBefore.text);
    assert.match(kindBefore.text, new RegExp(`rec_kind\\(${recovered}\\* \\w+\\)`));
    assert.doesNotMatch(kindBefore.text, /struct Rec/);

    const typeOf = await declare(
      'struct Rec { int32_t id; int32_t kind; int64_t size; double weight; }; struct Other { int64_t a; int64_t b; };',
    );
    const recSignature = newIdentity('annotation');
    await apply([signature(recSignature, 'rec_id', typeOf('Rec*'), typeOf('int32_t'))]);

    // rec_kind carries no annotation: the binding through the shared class names it.
    const bound = await decompile('rec_kind');
    assert.equal(bound.cache, 'computed');
    assert.match(bound.text, /struct Rec \{ uint8_t pad_0x0\[4\]; int32_t kind; \};/);
    assert.match(bound.text, /rec_kind\(struct Rec\* (\w+)\)/);
    assert.match(bound.text, /\w+->kind/);
    assert.doesNotMatch(bound.text, label);
    const size = await decompile('rec_size');
    assert.match(size.text, /rec_size\(struct Rec\* \w+\)/);
    assert.match(size.text, /return \w+->size;/);
    const types = await service.execute('binary_info', {
      project_id,
      revision,
      image_id,
      view: 'types',
    });
    assert.ok('data' in types && types.data.view === 'types');
    assert.match(
      types.data.text,
      new RegExp(
        `/\\* ${recovered} is struct Rec: declared by the asserted signature of rec_id parameter 0 \\(record\\);`,
      ),
    );
    assert.match(
      types.data.text,
      /^struct Rec \{ int32_t id; int32_t kind; int64_t size; double weight; \};$/m,
    );
    assert.doesNotMatch(types.data.text, new RegExp(`typedef struct ${recovered}`));

    // An annotation on a function outside the class leaves the decompilation reusable.
    await apply([
      {
        operation: 'set',
        id: newIdentity('annotation'),
        entity_id: id('unrelated'),
        value: { kind: 'name', value: 'scaled' },
        status: 'asserted',
        evidence_ids: [],
      },
    ]);
    const reused = await decompile('rec_kind');
    assert.equal(reused.cache, 'hit');
    assert.equal(reused.text, bound.text);

    // Two declared structures for one class: no binding, an info diagnostic names both.
    const otherSignature = newIdentity('annotation');
    await apply([signature(otherSignature, 'rec_kind', typeOf('Other*'), typeOf('int32_t'))]);
    const conflicted = await decompile('rec_size');
    assert.match(conflicted.text, new RegExp(`rec_size\\(${recovered}\\* \\w+\\)`));
    assert.ok(
      conflicted.diagnostics.some(
        (item) =>
          item.startsWith(`info: Image type ${recovered} stays unbound`) &&
          item.includes('struct Other: rec_kind parameter 0 (record)') &&
          item.includes('struct Rec: rec_id parameter 0 (record)'),
      ),
      conflicted.diagnostics.join('\n'),
    );
    await apply([{ operation: 'retract', id: otherSignature }]);
    assert.match((await decompile('rec_size')).text, /rec_size\(struct Rec\* \w+\)/);

    // A declaration contradicting observed accesses still binds, with a warning; the
    // accesses it lacks print without a member name.
    await declare('struct Rec { int64_t id; int64_t size; };');
    const mismatched = await decompile('rec_kind');
    assert.equal(mismatched.cache, 'computed');
    assert.match(mismatched.text, /rec_kind\(struct Rec\* (\w+)\)/);
    assert.match(mismatched.text, /\*\(uint32_t \*\)\(\(uintptr_t\)\w+ \+ 4\)/);
    assert.doesNotMatch(mismatched.text, /->kind/);
    assert.ok(
      mismatched.diagnostics.some(
        (item) =>
          item.startsWith(`warning: Image type ${recovered} is bound to struct Rec`) &&
          item.includes('+0x4 (32 bits)'),
      ),
      mismatched.diagnostics.join('\n'),
    );
    assert.match((await decompile('rec_size')).text, /return \w+->size;/);

    // Retracting the signature restores the recovered class in every function.
    await apply([{ operation: 'retract', id: recSignature }]);
    const restored = await decompile('rec_kind');
    assert.equal(restored.cache, 'computed');
    assert.equal(label.exec(restored.text)?.[0], recovered, restored.text);
    assert.doesNotMatch(restored.text, /struct Rec/);
    assert.equal(label.exec((await decompile('rec_size')).text)?.[0], recovered);
  },
);
