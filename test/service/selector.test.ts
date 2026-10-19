import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { QueryService } from '../../src/service/queries/index.js';
import {
  FunctionSelectionError,
  parseFunctionHandle,
  selectFunction,
} from '../../src/service/queries/selector.js';
import type { FunctionRecord } from '../../src/service/queries/selector.js';

const scope = {
  project_id: `project_${'1'.repeat(64)}`,
  revision: 2,
  image_id: `image_${'2'.repeat(64)}`,
};
const record = (hex: string, name: string, value: string): FunctionRecord =>
  ({
    id: `entity_${hex}`,
    original_name: name,
    display_name: name,
    entry: { image_id: scope.image_id, space: 'va', value },
  }) as FunctionRecord;
const functions = [
  record('ab12cd34ef56' + '0'.repeat(52), '_alpha', '0x1000'),
  record('ab12cd34ef56' + '1'.repeat(52), '_beta', '0x2000'),
  record('cafe00112233' + '0'.repeat(52), '_gamma', '0x3000'),
];

/** A function index holding `functions`, answering the queries the selector issues. */
function index(indexState: 'complete' | 'partial'): Pick<QueryService, 'execute'> {
  const execute = async (operation: string, input: Record<string, unknown>) => {
    if (operation === 'symbols_find')
      return { state: 'complete', data: { items: [], page: { index_state: indexState, next_cursor: null } } };
    assert.equal(operation, 'functions_find');
    const query = input['query'] as { text: string } | undefined;
    const address = input['address'] as { value: string } | undefined;
    const items = functions.filter(
      (item) =>
        (input['id'] === undefined || item.id === input['id']) &&
        (input['id_prefix'] === undefined || item.id.startsWith(input['id_prefix'] as string)) &&
        (address === undefined || item.entry.value === address.value) &&
        (query === undefined || item.original_name === query.text),
    );
    return {
      state: indexState === 'complete' ? 'complete' : 'partial',
      data: { items, page: { index_state: indexState, next_cursor: null } },
    };
  };
  return { execute: execute as unknown as QueryService['execute'] };
}

test('function handles: full ID, ID prefix, address and name are told apart', () => {
  const id = `entity_${'a'.repeat(64)}`;
  assert.deepEqual(parseFunctionHandle(id), { id });
  assert.deepEqual(parseFunctionHandle('entity_' + 'a'.repeat(12)), {
    id_prefix: 'entity_' + 'a'.repeat(12),
  });
  assert.deepEqual(parseFunctionHandle('va:0x1000A'), { address: { space: 'va', value: '0x1000a' } });
  assert.deepEqual(parseFunctionHandle('rva:0x10'), { address: { space: 'rva', value: '0x10' } });
  // Fewer than 12 digits is not a prefix: it can only be a name.
  assert.deepEqual(parseFunctionHandle('entity_abc'), { name: 'entity_abc' });
  assert.deepEqual(parseFunctionHandle('_main'), { name: '_main' });
});

test('selecting a function never guesses: unique match, ambiguity and absence are distinct', async () => {
  const complete = index('complete');
  const byPrefix = await selectFunction(complete, scope, parseFunctionHandle('entity_cafe00112233'));
  assert.equal(byPrefix.original_name, '_gamma');
  assert.equal((await selectFunction(complete, scope, { name: '_beta' })).id, functions[1]!.id);
  assert.equal(
    (await selectFunction(complete, scope, parseFunctionHandle('va:0x1000'))).id,
    functions[0]!.id,
  );
  await assert.rejects(
    selectFunction(complete, scope, parseFunctionHandle('entity_ab12cd34ef56')),
    (error: unknown) =>
      error instanceof FunctionSelectionError &&
      error.reason === 'ambiguous' &&
      error.candidates.length === 2,
  );
  await assert.rejects(
    selectFunction(complete, scope, { name: '_missing' }),
    (error: unknown) => error instanceof FunctionSelectionError && error.reason === 'not_found',
  );
  // A partial index cannot prove that a name is absent or unique.
  await assert.rejects(
    selectFunction(index('partial'), scope, { name: '_missing' }),
    (error: unknown) => error instanceof FunctionSelectionError && error.reason === 'incomplete',
  );
});
