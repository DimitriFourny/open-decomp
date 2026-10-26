import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  entityIdentity,
  expandEmission,
  newIdentity,
  typeLibraryIdentity,
  userTypeIdentity,
  type ToolInput,
} from '../../../src/core/index.js';
import { QueryService } from '../../../src/service/queries/index.js';
import { CLANG, nativeOracleSkip } from '../../support/host-tools.js';

const SOURCE = `#include <stdint.h>
struct Node { int32_t value; struct Node *next; };
__attribute__((noinline)) int32_t node_sum(struct Node *p) {
  int32_t s = 0;
  for (; p; p = p->next) s += p->value;
  return s;
}
__attribute__((noinline)) int32_t node_twice(struct Node *p) { return node_sum(p) * 2 + p->value; }
__attribute__((noinline)) int32_t scale(int32_t x) { return x * 3 + 1; }
int main(int argc, char **argv) { struct Node n = {argc, 0}; return node_twice(&n) + scale(argc); }
`;

test(
  'a type library declared once names structures and fields in every function that uses it',
  { skip: nativeOracleSkip(), timeout: 300_000 },
  async (t) => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'open-decomp-type-library-')));
    await writeFile(join(root, 'list.c'), SOURCE);
    const binary = join(root, 'list');
    const compiled = spawnSync(
      CLANG,
      [
        '-target',
        'arm64-apple-macos13.0',
        '-O1',
        '-g0',
        '-fno-inline',
        join(root, 'list.c'),
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
      slice = opened.data.image.selected_slice_id,
      library = typeLibraryIdentity(slice);
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
    const decompile = async (name: string, emitter: 'c-like' | 'python-like' = 'c-like') => {
      const result = await service.execute('function_decompile', {
        project_id,
        revision,
        function_id: id(name),
        wait: true,
        options: { emitter },
      });
      assert.ok('data' in result && result.data.delivery === 'inline', JSON.stringify(result));
      return result.data;
    };
    const declare = (source: string) =>
      service.execute('types_declare', {
        project_id,
        expected_revision: revision,
        image_id,
        author: 'type-library-test',
        origin: 'llm',
        source,
      });
    const apply = (edits: ToolInput<'annotations_apply'>['edits']) =>
      service.execute('annotations_apply', {
        project_id,
        expected_revision: revision,
        author: 'type-library-test',
        origin: 'llm',
        edits,
      });
    const set = (
      entity_id: string,
      value: Extract<
        ToolInput<'annotations_apply'>['edits'][number],
        { operation: 'set' }
      >['value'],
    ) => ({
      operation: 'set' as const,
      id: newIdentity('annotation'),
      entity_id,
      value,
      status: 'asserted' as const,
      evidence_ids: [],
    });

    const before = (await decompile('node_sum')).emission.text;
    assert.doesNotMatch(before, /struct Node|->value/);

    // Parse errors reject the whole batch and leave the revision unchanged.
    const bad = await declare('struct Good { int32_t a; }; struct Bad { int32_t x: 3; };');
    assert.equal(bad.state, 'failed');
    assert.ok('current_revision' in bad && bad.current_revision === revision);

    const declared = await declare(
      'struct Node { int32_t value; struct Node *next; }; typedef struct Node Node; typedef int32_t total_t;',
    );
    assert.ok('data' in declared, JSON.stringify(declared));
    assert.equal(declared.data.revision, revision + 1);
    assert.equal(declared.data.library_id, library);
    revision = declared.data.revision;
    const typeOf = (name: string): string =>
      declared.data.types.find((type) => type.name === name || type.key === name)!.type_id;
    const node = typeOf('Node');
    assert.equal(node, entityIdentity(slice, 'user-type', ['Node']));
    // Every named type comes with its pointer type; the parser's `struct Node *` is that type.
    const pointer = typeOf('Node*');
    assert.equal(pointer, userTypeIdentity(slice, 'Node*'));
    assert.equal(typeOf('Node$next'), pointer);
    assert.equal(typeOf('total_t*'), userTypeIdentity(slice, 'total_t*'));

    // Binding only: a value subject takes the library pointer type; an unknown type is rejected.
    const parameter = expandEmission((await decompile('node_sum')).emission).inferences!.find(
      (inference) => inference.details.kind === 'parameter' && inference.details.ordinal === 0,
    );
    assert.ok(parameter?.details.kind === 'parameter');
    const value = parameter.details.value_ids[0]!;
    const unknown = await apply([
      set(value, { kind: 'type', type_id: entityIdentity(slice, 'type-library-test', ['none']) }),
    ]);
    assert.equal(unknown.state, 'failed');
    assert.ok('error' in unknown && unknown.error.code === 'not_found');
    const bound = await apply([set(value, { kind: 'type', type_id: pointer })]);
    assert.ok('data' in bound, JSON.stringify(bound));
    revision = bound.data.revision;
    const boundText = (await decompile('node_sum')).emission.text;
    assert.match(boundText, /struct Node\* \w+/);
    assert.match(boundText, /->value/);
    assert.match(boundText, /->next/);

    // A signature using the library types reaches the function and its callers.
    const signed = await apply([
      set(id('node_sum'), {
        kind: 'signature',
        value: {
          abi: 'darwin-arm64',
          return_type: typeOf('total_t'),
          parameters: [
            {
              id: entityIdentity(slice, 'type-library-test', ['p']),
              name: 'list',
              type_id: pointer,
            },
          ],
          variadic: false,
          noreturn: false,
          evidence_ids: [],
        },
      }),
    ]);
    assert.ok('data' in signed, JSON.stringify(signed));
    revision = signed.data.revision;
    const sum = (await decompile('node_sum')).emission.text;
    assert.match(
      sum,
      /struct Node \{ int32_t value; uint8_t pad_0x4\[4\]; struct Node\* next; \};/,
    );
    assert.match(sum, /^typedef int32_t total_t;$/m);
    assert.match(sum, /total_t node_sum\(struct Node\* list\)/);
    assert.match(sum, /list->value/);
    assert.match(sum, /list = list->next;/);
    const twice = (await decompile('node_twice')).emission.text;
    assert.match(twice, /struct Node \{ int32_t value; \};/);
    assert.match(twice, /node_twice\(struct Node\* \w+\)/);
    assert.match(twice, /\w+->value/);
    assert.match((await decompile('node_sum', 'python-like')).emission.text, /pointer\[Node\]/);
    const listed = await service.execute('binary_info', {
      project_id,
      revision,
      image_id,
      view: 'types',
    });
    assert.ok('data' in listed && listed.data.view === 'types');
    assert.deepEqual(
      listed.data.library.map((item) => [item.name, item.type_id, item.declaration]),
      [
        ['Node', node, 'struct Node { int32_t value; struct Node *next; };'],
        ['total_t', typeOf('total_t'), 'typedef int32_t total_t;'],
        ...[
          [null, typeOf('int32_t'), 'int32_t'],
          [null, pointer, 'struct Node *'],
          [null, typeOf('total_t*'), 'total_t *'],
        ].sort((a, b) => (a[1]! < b[1]! ? -1 : 1)),
      ],
    );

    // Redeclaring Node replaces its declaration: one revision, users recompute,
    // functions that never used the type are served from the cache.
    const unrelated = await decompile('scale');
    assert.equal(unrelated.cache, 'computed');
    const redeclared = await declare('struct Node { uint32_t count; struct Node *link; };');
    assert.ok('data' in redeclared, JSON.stringify(redeclared));
    assert.equal(redeclared.data.revision, revision + 1);
    assert.equal(
      redeclared.data.types.find((type) => type.name === 'Node')!.annotation_id,
      declared.data.types.find((type) => type.name === 'Node')!.annotation_id,
    );
    revision = redeclared.data.revision;
    const changed = await decompile('node_sum');
    assert.equal(changed.cache, 'computed');
    assert.match(changed.emission.text, /list->count/);
    assert.match(changed.emission.text, /list = list->link;/);
    assert.equal((await decompile('scale')).cache, 'hit');
  },
);
