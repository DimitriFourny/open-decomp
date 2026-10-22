import assert from 'node:assert/strict';
import {
  createOperationContext,
  newIdentity,
  type AbiProfile,
  type Emission,
  type RegisterDescriptor,
} from '../../src/core/index.js';
import { constructSSA } from '../../src/analysis/ssa/index.js';
import { recoverTypes } from '../../src/analysis/types/index.js';
import {
  evaluateIR,
  integer,
  type RegisterIR,
  type SSAForm,
  type TrustedCall,
  type Value,
} from '../../src/ir/index.js';
import type { EmissionInput } from '../../src/emitters/model.js';
import { structureControlFlow } from '../../src/presentation/index.js';
import { reconstruct } from '../../src/reconstruction/index.js';
import { builder, image, slice } from '../ir/support.js';
import {
  acknowledgeRequirements,
  emit,
  emittedFormals,
  execute,
  type Observation,
} from '../emitters/c/support.js';

const u64 = integer(64);

export function firstArgument(abi: AbiProfile): RegisterDescriptor {
  const location = abi.classifyCall({
    returns: { kind: 'void' },
    parameters: [{ kind: 'integer', bits: 64, signed: false }],
    variadic: false,
    fixed_parameter_count: 1,
  }).parameters[0]!.locations[0]!;
  if (location.kind !== 'register') throw new Error('Expected register argument');
  return location.register;
}

export interface Fixture {
  readonly ir: SSAForm;
  readonly extra: Omit<EmissionInput, 'function'>;
}

/** SSA, recovered types and one open-arity callee per call (its first
 * argument register proven). */
export function prepare(input: RegisterIR, abi: AbiProfile): Fixture {
  const ir = constructSSA(input).value as SSAForm;
  const types = recoverTypes(ir, abi, createOperationContext(), {
    image_id: image,
    slice_id: slice,
    revision: 0,
  });
  const callees = ir.blocks.flatMap((block) =>
    block.instructions.flatMap((node) =>
      node.kind === 'call'
        ? [
            {
              call_id: node.id,
              parameters: [firstArgument(abi)],
              returns: [],
              argument_list_complete: false,
              argument_list_closure: 'callee_reads' as const,
              evidence_ids: [],
            },
          ]
        : [],
    ),
  );
  return { ir, extra: { types, source: { abi, callees, addresses: [] } } };
}

/** The source-view reconstruction of a fixture. */
export function sourcePlan(fixture: Fixture) {
  const structured = structureControlFlow(fixture.ir, createOperationContext());
  assert.ok(structured.value);
  return reconstruct(
    { function: structured.value, ...fixture.extra },
    createOperationContext(),
    'source',
  );
}

export const ENTRY_SP = 0x8000n;
/** The byte every call writes through its first argument. */
export const WRITTEN = 0x55n;

const savedRegister = (abi: AbiProfile): RegisterDescriptor =>
  abi.preserved.find(
    (register) => register.bank === 'integer' && register.root !== abi.stack_pointer.root,
  )!;

/** A 32-byte frame below the entry SP whose bytes `[save, save + 8)` save a
 * preserved register, restored on return; `at(k)` is entry-SP address `k`
 * computed from the allocated SP; `call(p)` passes `p` to `sub_2000`. */
export function savedFrame(abi: AbiProfile, name: string, save = -8n) {
  const b = builder(`saved-frame-${name}-${abi.id}`),
    block = b.block('entry');
  const saved = savedRegister(abi);
  const argument = block.readRegister(firstArgument(abi));
  const entry = block.readRegister(abi.stack_pointer);
  const sp = block.int('sub', entry, block.constant(u64, 32n));
  block.writeRegister(abi.stack_pointer, sp);
  const at = (offset: bigint) => block.int('add', sp, block.constant(u64, 32n + offset));
  const slot = at(save);
  block.store(slot, block.readRegister(saved));
  block.writeRegister(saved, block.constant(u64, 5n));
  const call = (address: Value) => {
    block.writeRegister(firstArgument(abi), address);
    block.call(
      { kind: 'direct', address: { image_id: image, space: 'va', value: 0x2000n } },
      [],
      [],
      abi.unknown_call_clobbers,
      [newIdentity('evidence')],
    );
  };
  const finish = (result: Value) => {
    block.writeRegister(saved, block.load(u64, slot));
    block.writeRegister(abi.stack_pointer, entry);
    block.return([result]);
    const input = b.finish(block, [u64]);
    return { input, ...prepare(input, abi) };
  };
  return { block, argument, at, call, finish, incoming: abi.stack_return_address_bytes };
}

/** Runs emitted source with the entry SP (when printed) at `ENTRY_SP` over 16
 * mapped incoming bytes; `sub_2000` writes `WRITTEN` to the byte its first
 * argument designates. */
export function runSource(emission: Emission, abi: AbiProfile, argument: bigint): Observation {
  const memory = new Map<bigint, number>();
  for (let offset = 0n; offset < 16n; offset++) memory.set(ENTRY_SP + offset, 0);
  const incoming = ENTRY_SP + abi.stack_return_address_bytes;
  return execute(
    emission,
    new Map([
      ...emittedFormals(emission).map((formal): [string, bigint] => [
        formal.statement_id,
        formal.name === 'entry_sp' ? ENTRY_SP : formal.name === 'stack_args' ? incoming : argument,
      ]),
      ...(/\bva_start\(/.test(emission.text) ? [['...', incoming] as [string, bigint]] : []),
    ]),
    memory,
    0n,
    new Map(),
    new Map(),
    new Map([
      [
        'sub_2000',
        (args: readonly bigint[]) => {
          memory.set(args[0]!, Number(WRITTEN));
          return [];
        },
      ],
    ]),
    acknowledgeRequirements(emission),
  );
}

/** The trusted IR interpretation of the same activation: entry SP at
 * `ENTRY_SP`, every call writing `WRITTEN` through its first argument. */
export function runIR(input: RegisterIR, abi: AbiProfile, argument: bigint): bigint {
  const write: TrustedCall = (call) => ({
    results: [],
    writes: [{ address: call.readRegister(firstArgument(abi)), width: 8, bits: WRITTEN }],
  });
  const result = evaluateIR(input, {
    registers: new Map([
      [abi.stack_pointer.root, ENTRY_SP],
      [firstArgument(abi).root, argument],
      [savedRegister(abi).root, 0x1234n],
    ]),
    memory: [{ base: ENTRY_SP - 64n, bytes: new Uint8Array(96), writable: true }],
    calls: new Map(
      input.blocks.flatMap((block) =>
        block.instructions.flatMap((node) =>
          node.kind === 'call' ? [[node.id, write] as const] : [],
        ),
      ),
    ),
  });
  assert.equal(result.status, 'returned', result.reason ?? undefined);
  const value = result.values[0];
  assert.ok(value?.kind === 'bits');
  return value.bits;
}

/** Both dialects of the source view return the IR interpretation's value. */
export function assertMatchesIR(
  fixture: Fixture & { readonly input: RegisterIR },
  abi: AbiProfile,
  argumentsToTry: readonly bigint[],
): void {
  for (const language of ['c-like', 'python-like'] as const) {
    const output = emit(fixture.ir, fixture.extra, language).emission;
    for (const argument of argumentsToTry)
      assert.deepEqual(
        runSource(output, abi, argument).values,
        [runIR(fixture.input, abi, argument)],
        `${language} ${argument}\n${output.text}`,
      );
  }
}
