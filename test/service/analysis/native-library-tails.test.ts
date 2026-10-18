import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createOperationContext } from '../../../src/core/index.js';
import { darwinArm64Abi as abi } from '../../../src/abi/darwin-arm64/index.js';
import { constructSSA } from '../../../src/analysis/ssa/index.js';
import { integer, type SSAForm } from '../../../src/ir/index.js';
import { recoverLibraryContracts } from '../../../src/metadata/library-contracts/index.js';
import { nativeLibraryTails } from '../../../src/service/analysis/native-library-tails.js';
import { loadBytes } from '../../metadata/fixture.js';
import { builder } from '../../ir/support.js';
import { emit, execute } from '../../emitters/c/support.js';

const image = loadBytes(
  readFileSync(new URL('../../../fixtures/bin/macho-arm64-symbols', import.meta.url)),
);
const library = recoverLibraryContracts({ image, abi, revision: 0 }, createOperationContext());
const contract = library.contracts.find(
  (item) => item.linkage_name === '_puts' && item.callable_entry,
);
assert.ok(contract?.callable_entry);

function fixture(tail: boolean) {
  const b = builder(`import-tail-${tail}`),
    block = b.block('entry');
  const parameter = abi.classifyCall(contract!.abi_signature).parameters[0]!.locations[0]!;
  assert.equal(parameter.kind, 'register');
  if (parameter.kind !== 'register') throw new Error('Expected register puts argument');
  block.writeRegister(
    parameter.register,
    block.constant(integer(parameter.register.width_bits), 0x3000n),
  );
  block.terminate({
    kind: 'indirect',
    target: block.constant(integer(64), contract!.callable_entry!.value),
    ...(tail ? { tail_call: true as const } : {}),
    reason: 'fixture-established direct tail',
  });
  return constructSSA(b.finish(block)).value as SSAForm;
}

test('established imported tails close from real loader/library contracts only in source view', () => {
  const ir = fixture(true);
  const tails = nativeLibraryTails(ir, image, [], [], library, abi, createOperationContext());
  assert.equal(tails.length, 1);
  assert.equal(tails[0]!.argument_list_closure, 'library_contract');
  const source = {
    abi,
    callees: [],
    source_callees: tails,
    addresses: [{ address: contract!.callable_entry!, name: 'puts' }],
  };
  for (const language of ['c-like', 'python-like'] as const) {
    const output = emit(ir, { source }, language).emission;
    assert.doesNotMatch(output.text, /unknown_argument|indirect_exit/);
    let calls = 0;
    const observed = execute(
      output,
      new Map(),
      new Map(),
      0n,
      new Map(),
      new Map(),
      new Map([
        [
          'puts',
          (args, context) => {
            calls++;
            assert.deepEqual(args, [0x3000n]);
            assert.equal(context.arguments_complete, true);
            return 7n;
          },
        ],
      ]),
    );
    assert.equal(calls, 1);
    assert.deepEqual(observed.values, [7n]);
    assert.equal(
      emit(ir, { source }, language, 'checked').emission.text,
      emit(ir, { source: { ...source, source_callees: [] } }, language, 'checked').emission.text,
    );
  }
});

test('unestablished transfers, missing contracts and conflicting import contracts stay open', () => {
  assert.deepEqual(
    nativeLibraryTails(fixture(false), image, [], [], library, abi, createOperationContext()),
    [],
  );
  const ir = fixture(true);
  assert.deepEqual(
    nativeLibraryTails(
      ir,
      image,
      [],
      [],
      { ...library, contracts: [] },
      abi,
      createOperationContext(),
    ),
    [],
  );
  assert.deepEqual(
    nativeLibraryTails(
      ir,
      image,
      [],
      [],
      {
        ...library,
        contracts: library.contracts.map((item) => ({ ...item, conflicts_with: ['conflict'] })),
      },
      abi,
      createOperationContext(),
    ),
    [],
  );
});
