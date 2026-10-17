import assert from 'node:assert/strict';
import { createOperationContext } from '../../../src/core/index.js';
import { constructSSA } from '../../../src/analysis/ssa/index.js';
import { sysvAMD64Abi } from '../../../src/abi/sysv-amd64/index.js';
import type { TypeRecoveryResult } from '../../../src/analysis/types/index.js';
import { integer, type RegisterIR, type SSAForm } from '../../../src/ir/index.js';
import { structureControlFlow } from '../../../src/presentation/index.js';
import { reconstruct } from '../../../src/reconstruction/index.js';
import { builder, image, register } from '../../ir/support.js';
import { emit, execute, type Observation } from './support.js';

const i32 = integer(32),
  i64 = integer(64);
const argument = [
  register('rdi', 64, 0, 'replace_root', 'x86_64:rdi'),
  register('rsi', 64, 0, 'replace_root', 'x86_64:rsi'),
  register('rdx', 64, 0, 'replace_root', 'x86_64:rdx'),
] as const;
const local = (name: string) => register(name, 64, 0, 'replace_root', `x86_64:${name}`);
const source = { abi: sysvAMD64Abi, callees: [], addresses: [] };
const u64 = (value: bigint): bigint => BigInt.asUintN(64, value);
const packed = (sum: bigint, a: bigint, b: bigint, c: bigint): bigint =>
  u64(sum + a * 257n + b * 65537n + c * 16777217n);

function ssa(input: RegisterIR): SSAForm {
  const converted = constructSSA(input);
  assert.equal(converted.state, 'complete');
  assert.equal(converted.value.form, 'ssa');
  if (converted.value.form !== 'ssa') assert.fail('Expected SSA');
  return converted.value;
}
function zeroMemory(): Map<bigint, number> {
  return new Map(Array.from({ length: 32 }, (_, index) => [0x1000n + BigInt(index), 0]));
}
function read64(memory: ReadonlyMap<bigint, number>, address = 0x1000n): bigint {
  let value = 0n;
  for (let byte = 0; byte < 8; byte++)
    value |= BigInt(memory.get(address + BigInt(byte))!) << BigInt(byte * 8);
  return value;
}
function inputs(ir: SSAForm, args: readonly bigint[]): Map<string, bigint> {
  const roots = new Map(argument.map((descriptor, index) => [descriptor.root, args[index] ?? 0n]));
  const entry = ir.blocks.find((block) => block.id === ir.entry)!;
  const values = new Map(entry.parameters.map((value) => [value.id, 0n]));
  for (const binding of ir.register_states.find((state) => state.block === ir.entry)!.entry)
    values.set(
      binding.value.id,
      BigInt.asUintN(
        binding.register.width_bits,
        (roots.get(binding.register.root) ?? 0n) >> BigInt(binding.register.offset_bits),
      ),
    );
  return values;
}
function outputs(ir: SSAForm, types?: TypeRecoveryResult) {
  return [false, true].flatMap((sourceMode) =>
    ['c-like', 'python-like'].map((language) => {
      const dialect = language as 'c-like' | 'python-like';
      return {
        label: `${dialect}/${sourceMode ? 'source' : 'machine'}`,
        output: emit(
          ir,
          { ...(sourceMode ? { source } : {}), ...(types ? { types } : {}) },
          dialect,
        ),
      };
    }),
  );
}
export function declaredTypes(
  subject: string,
  bits: 32 | 64,
  parameters: number,
): TypeRecoveryResult {
  return {
    state: 'complete',
    work: 0,
    subjects: [],
    associations: [],
    shapes: [],
    conflicts: [],
    evidence: [],
    diagnostics: [],
    calls: null,
    types: [
      {
        id: 'unsigned',
        definition: { kind: 'integer', bits, signed: false },
        source: 'debug',
        status: 'asserted',
        evidence_ids: [],
      },
    ],
    signatures: [
      {
        id: 'fixture-signature',
        subject_id: subject,
        source: 'debug',
        status: 'asserted',
        evidence_ids: [],
        abi_state: 'complete',
        implicit_register_inputs: [],
        signature: {
          abi: 'sysv-amd64',
          return_type: 'unsigned',
          parameters: Array.from({ length: parameters }, (_, index) => ({
            id: `argument${index}`,
            name: null,
            type_id: 'unsigned',
          })),
          variadic: false,
          noreturn: false,
          evidence_ids: [],
        },
      },
    ],
  };
}

/** Source-derived unsigned algorithm (all arithmetic is modulo 2^64):
 * a=3; b=8; c=13; sum=0;
 * for(i=0;i<outer;i++) for(j=0;j<inner;j++) switch(mode) {
 *   case 0: log(10); (a,b,c)=(b,c,a); continue;
 *   case 1: log(20); break inner;
 *   case 2: log(30); if(i==1) return pack()+2^48; otherwise execute body;
 *   default: log(50); sum+=a; break;
 *   case 3: log(40); continue outer;
 * }
 * return pack();
 * log(k) appends k+4*i+j to a rolling memory journal. Its ordered loads/stores
 * observe every selected branch, including the early-return boundary.
 */
function nestedLoops(): SSAForm {
  const b = builder('source-backed-nested-switch-exits');
  const entry = b.block('entry'),
    outer = b.block('outer'),
    startInner = b.block('start-inner');
  const inner = b.block('inner'),
    dispatch = b.block('dispatch'),
    rotate = b.block('rotate');
  const leaveInner = b.block('leave-inner'),
    early = b.block('early'),
    body = b.block('body');
  const leaveOuterIteration = b.block('continue-outer'),
    innerLatch = b.block('inner-latch');
  const outerLatch = b.block('outer-latch'),
    done = b.block('done'),
    returnedEarly = b.block('early-return');
  const i = local('r8'),
    j = local('r9'),
    a = local('r10'),
    bb = local('r11');
  const c = local('r12'),
    sum = local('r13');
  for (const descriptor of argument) entry.readRegister(descriptor);
  for (const [descriptor, value] of [
    [i, 0n],
    [a, 3n],
    [bb, 8n],
    [c, 13n],
    [sum, 0n],
  ] as const)
    entry.writeRegister(descriptor, entry.constant(i64, value));
  entry.jump(outer);
  outer.branch(
    outer.compare('uge', outer.readRegister(i), outer.readRegister(argument[0])),
    outer.edge(done),
    outer.edge(startInner),
  );
  startInner.writeRegister(j, startInner.constant(i64, 0n));
  startInner.jump(inner);
  inner.branch(
    inner.compare('uge', inner.readRegister(j), inner.readRegister(argument[1])),
    inner.edge(outerLatch),
    inner.edge(dispatch),
  );
  dispatch.terminate({
    kind: 'switch',
    value: dispatch.readRegister(argument[2]),
    cases: [
      { bits: 0n, edge: dispatch.edge(rotate) },
      { bits: 1n, edge: dispatch.edge(leaveInner) },
      { bits: 2n, edge: dispatch.edge(early) },
      { bits: 3n, edge: dispatch.edge(leaveOuterIteration) },
    ],
    otherwise: dispatch.edge(body),
  });
  const journal = (block: typeof entry, marker: bigint) => {
    const address = block.constant(i64, 0x1000n);
    const tag = block.int(
      'add',
      block.constant(i64, marker),
      block.int(
        'add',
        block.int('mul', block.readRegister(i), block.constant(i64, 4n)),
        block.readRegister(j),
      ),
    );
    block.store(
      address,
      block.int('add', block.int('mul', block.load(i64, address), block.constant(i64, 17n)), tag),
    );
  };
  journal(rotate, 10n);
  const oldA = rotate.readRegister(a),
    oldB = rotate.readRegister(bb),
    oldC = rotate.readRegister(c);
  rotate.writeRegister(a, oldB);
  rotate.writeRegister(bb, oldC);
  rotate.writeRegister(c, oldA);
  rotate.jump(innerLatch);
  journal(leaveInner, 20n);
  leaveInner.jump(outerLatch);
  journal(early, 30n);
  early.branch(
    early.compare('eq', early.readRegister(i), early.constant(i64, 1n)),
    early.edge(returnedEarly),
    early.edge(body),
  );
  journal(leaveOuterIteration, 40n);
  leaveOuterIteration.jump(outerLatch);
  journal(body, 50n);
  body.writeRegister(sum, body.int('add', body.readRegister(sum), body.readRegister(a)));
  body.jump(innerLatch);
  innerLatch.writeRegister(
    j,
    innerLatch.int('add', innerLatch.readRegister(j), innerLatch.constant(i64, 1n)),
  );
  innerLatch.jump(inner);
  outerLatch.writeRegister(
    i,
    outerLatch.int('add', outerLatch.readRegister(i), outerLatch.constant(i64, 1n)),
  );
  outerLatch.jump(outer);
  for (const [block, marker] of [
    [done, 0n],
    [returnedEarly, 1n << 48n],
  ] as const) {
    let value = block.int('add', block.readRegister(sum), block.constant(i64, marker));
    for (const [descriptor, weight] of [
      [a, 257n],
      [bb, 65537n],
      [c, 16777217n],
    ] as const)
      value = block.int(
        'add',
        value,
        block.int('mul', block.readRegister(descriptor), block.constant(i64, weight)),
      );
    block.return([value]);
  }
  return ssa(b.finish(entry, [i64]));
}
function nestedOracle(outer: number, inner: number, mode: number) {
  let a = 3n,
    b = 8n,
    c = 13n,
    sum = 0n,
    journal = 0n,
    logs = 0;
  const log = (tag: number) => {
    journal = u64(journal * 17n + BigInt(tag));
    logs++;
  };
  outerLoop: for (let i = 0; i < outer; i++) {
    for (let j = 0; j < inner; j++) {
      const index = i * 4 + j;
      switch (mode) {
        case 0:
          log(10 + index);
          [a, b, c] = [b, c, a];
          continue;
        case 1:
          log(20 + index);
          continue outerLoop;
        case 2:
          log(30 + index);
          if (i === 1) return { value: packed(sum, a, b, c) + (1n << 48n), journal, logs };
          break;
        case 3:
          log(40 + index);
          continue outerLoop;
      }
      log(50 + index);
      sum = u64(sum + a);
    }
  }
  return { value: packed(sum, a, b, c), journal, logs };
}

/** Source oracle: if ((flags&1) && *p && callback(*p,flags)) {
 * *out=99; return 1; } else return 0;
 * The call result is supplied by the trusted evaluator's independent call oracle.
 * An unmapped p is legal whenever the first condition is false.
 */
function shortCircuit(): SSAForm {
  const b = builder('source-backed-short-circuit-effects');
  const entry = b.block('entry'),
    load = b.block('load'),
    call = b.block('call');
  const yes = b.block('yes'),
    no = b.block('no');
  const flags = entry.readRegister(argument[0]);
  entry.readRegister(argument[1]);
  entry.branch(
    entry.compare('ne', entry.int('and', flags, entry.constant(i64, 1n)), entry.constant(i64, 0n)),
    entry.edge(load),
    entry.edge(no),
  );
  const loaded = load.load(i64, load.readRegister(argument[1]));
  load.writeRegister(local('r8'), loaded);
  load.branch(load.compare('ne', loaded, load.constant(i64, 0n)), load.edge(call), load.edge(no));
  const flagsForCall = call.readRegister(argument[0]);
  call.writeRegister(argument[0], call.readRegister(local('r8')));
  call.writeRegister(argument[1], flagsForCall);
  call.call({ kind: 'direct', address: { image_id: image, space: 'va', value: 0x2200n } }, [], [], {
    registers: [local('rax')],
    flags: [],
    memory: 'unknown_read_write',
  });
  call.branch(
    call.compare('ne', call.readRegister(local('rax')), call.constant(i64, 0n)),
    call.edge(yes),
    call.edge(no),
  );
  yes.store(yes.constant(i64, 0x1010n), yes.constant(i64, 99n));
  yes.return([yes.constant(i64, 1n)]);
  no.return([no.constant(i64, 0n)]);
  return ssa(b.finish(entry, [i64]));
}

/** Source oracle: select initial high/low halves on distinct edges, then swap
 * halves count times, store the assembled uint64 and return it XOR 0x55.
 * Reading the full register after partial writes forces source concatenation of
 * phi-carried cells; the assembled result is used in two successor blocks.
 */
function splitRegisterScope(): SSAForm {
  const b = builder('source-backed-split-register-scope');
  const entry = b.block('entry'),
    left = b.block('left'),
    right = b.block('right');
  const loop = b.block('loop'),
    rotate = b.block('rotate'),
    join = b.block('join');
  const store = b.block('store'),
    result = b.block('result');
  const full = local('r8'),
    count = local('r9');
  const low = register('r8-low', 32, 0, 'preserve_other_bits', full.root);
  const high = register('r8-high', 32, 32, 'preserve_other_bits', full.root);
  for (const descriptor of argument) entry.readRegister(descriptor);
  entry.writeRegister(count, entry.readRegister(argument[1]));
  entry.branch(
    entry.compare('eq', entry.readRegister(argument[2]), entry.constant(i64, 0n)),
    entry.edge(left),
    entry.edge(right),
  );
  for (const [block, complement] of [
    [left, false],
    [right, true],
  ] as const) {
    let value = block.readRegister(argument[0]);
    if (complement) value = block.int('xor', value, block.constant(i64, 0xffffffffffffffffn));
    block.writeRegister(low, block.cast('truncate', i32, value));
    block.writeRegister(
      high,
      block.cast('truncate', i32, block.int('lshr', value, block.constant(i64, 32n))),
    );
    block.jump(loop);
  }
  loop.branch(
    loop.compare('eq', loop.readRegister(count), loop.constant(i64, 0n)),
    loop.edge(join),
    loop.edge(rotate),
  );
  const oldLow = rotate.readRegister(low),
    oldHigh = rotate.readRegister(high);
  rotate.writeRegister(low, oldHigh);
  rotate.writeRegister(high, oldLow);
  rotate.writeRegister(
    count,
    rotate.int('sub', rotate.readRegister(count), rotate.constant(i64, 1n)),
  );
  rotate.jump(loop);
  const assembled = join.readRegister(full);
  join.writeRegister(local('r10'), assembled);
  join.jump(store);
  store.store(store.constant(i64, 0x1000n), store.readRegister(local('r10')));
  store.jump(result);
  result.return([
    result.int('xor', result.readRegister(local('r10')), result.constant(i64, 0x55n)),
  ]);
  return ssa(b.finish(entry, [i64]));
}

/** uint32_t source algorithm, with every addition modulo 2^32:
 * y = a & 1 ? a * 4096 : a * 1024;
 * y *= 16; *out = y; return y ^ 0x55;
 * Shared doubling DAGs are deliberately inside separate branch scopes and their
 * joined value is consumed in later blocks. Narrow asserted ABI inputs force
 * real source synthetic definitions rather than only original SSA temporaries.
 */
export function narrowSyntheticScope(): SSAForm {
  const b = builder('source-backed-narrow-synthetic-scope');
  const entry = b.block('entry'),
    left = b.block('left'),
    right = b.block('right');
  const join = b.block('join'),
    store = b.block('store'),
    returned = b.block('returned');
  const eax = register('eax', 32, 0, 'zero_extend_root', 'x86_64:rax');
  const value = entry.cast('truncate', i32, entry.readRegister(argument[0]));
  entry.branch(
    entry.compare('ne', entry.int('and', value, entry.constant(i32, 1n)), entry.constant(i32, 0n)),
    entry.edge(left),
    entry.edge(right),
  );
  for (const [block, doubles] of [
    [left, 12],
    [right, 10],
  ] as const) {
    let current = block.readRegister(argument[0]);
    for (let index = 0; index < doubles; index++) current = block.int('add', current, current);
    block.writeRegister(eax, block.cast('truncate', i32, current));
    block.jump(join);
  }
  let current = join.readRegister(eax);
  for (let index = 0; index < 4; index++) current = join.int('add', current, current);
  join.writeRegister(eax, current);
  join.jump(store);
  store.store(store.constant(i64, 0x1000n), store.readRegister(eax));
  store.jump(returned);
  const result = returned.int('xor', returned.readRegister(eax), returned.constant(i32, 0x55n));
  returned.writeRegister(eax, result);
  returned.return([result]);
  return ssa(b.finish(entry, [i32]));
}

export function checkExitRegressions(): { observations: number; fixtures: number } {
  let observations = 0;
  const check = (result: Observation, expected: bigint, label: string) => {
    assert.equal(result.exit, 'machine_return', label);
    assert.deepEqual(result.values, [expected], label);
    observations++;
  };
  const nested = nestedLoops();
  for (const { label, output } of outputs(nested))
    for (let outer = 0; outer <= 3; outer++)
      for (let inner = 0; inner <= 3; inner++)
        for (let mode = 0; mode <= 4; mode++) {
          const expected = nestedOracle(outer, inner, mode);
          const observed = execute(
            output.emission,
            inputs(nested, [BigInt(outer), BigInt(inner), BigInt(mode)]),
            zeroMemory(),
          );
          const description = `${label}: nested ${outer}/${inner}/${mode}`;
          check(observed, expected.value, description);
          assert.equal(read64(observed.memory), expected.journal, description);
          assert.deepEqual(
            observed.events,
            Array.from({ length: expected.logs }, () => ['load', 'store']).flat(),
            description,
          );
          assert.deepEqual(observed.calls, []);
        }
  const short = shortCircuit();
  const called = short.blocks
    .flatMap((block) => block.instructions)
    .find((node) => node.kind === 'call')!;
  for (const { label, output } of outputs(short, declaredTypes(called.id, 64, 2))) {
    const callName = output.identifiers.find(
      (identifier) => identifier.entity_id === called.id,
    )?.identifier;
    assert.ok(callName, 'Known fixture callee retains its original call identity');
    for (const flags of [0n, 1n, 2n, 3n])
      for (const loaded of [0n, 7n])
        for (const callResult of [0n, 9n]) {
          const memory = zeroMemory();
          memory.set(0x1000n, Number(loaded));
          const pointer = (flags & 1n) === 0n ? 0xdead0000n : 0x1000n;
          const observed = execute(
            output.emission,
            inputs(short, [flags, pointer]),
            memory,
            callResult,
            new Map(),
            new Map(),
            new Map([[callName, () => callResult]]),
          );
          const reachesLoad = (flags & 1n) !== 0n,
            reachesCall = reachesLoad && loaded !== 0n;
          const returnsTrue = reachesCall && callResult !== 0n;
          const description = `${label}: short-circuit ${flags}/${loaded}/${callResult}`;
          check(observed, returnsTrue ? 1n : 0n, description);
          assert.deepEqual(
            observed.events,
            [
              ...(reachesLoad ? ['load'] : []),
              ...(reachesCall ? ['call'] : []),
              ...(returnsTrue ? ['store'] : []),
            ],
            description,
          );
          assert.deepEqual(
            observed.source_calls,
            reachesCall ? [{ name: callName, arguments: [loaded, flags] }] : [],
            description,
          );
          assert.deepEqual(observed.calls, [], description);
          assert.equal(read64(observed.memory, 0x1010n), returnsTrue ? 99n : 0n, description);
        }
    const fault = execute(
      output.emission,
      inputs(short, [1n, 0xdead0000n]),
      zeroMemory(),
      9n,
      new Map(),
      new Map(),
      new Map([[callName, () => 9n]]),
    );
    assert.equal(fault.exit, 'fault', label);
    assert.deepEqual(fault.events, ['load'], label);
    assert.deepEqual(fault.source_calls ?? [], [], label);
    assert.equal(read64(fault.memory, 0x1010n), 0n, label);
    observations++;
  }
  const split = splitRegisterScope();
  const structured = structureControlFlow(split, createOperationContext());
  assert.ok(structured.value);
  const projected = reconstruct({ function: structured.value, source }, createOperationContext());
  assert.ok(
    projected.source?.value_origins?.size,
    'Source projection synthesizes values with original contributors',
  );
  for (const { label, output } of outputs(split))
    for (const value of [0n, 0x0123456789abcdefn, 0x80000000ffffffffn, 0xffffffffffffffffn])
      for (const count of [0n, 1n, 2n, 3n])
        for (const selected of [0n, 1n]) {
          let expected = selected === 0n ? value : u64(~value);
          if (count % 2n !== 0n) expected = u64((expected << 32n) | (expected >> 32n));
          const observed = execute(
            output.emission,
            inputs(split, [value, count, selected]),
            zeroMemory(),
          );
          const description = `${label}: split ${value}/${count}/${selected}`;
          check(observed, expected ^ 0x55n, description);
          assert.equal(read64(observed.memory), expected, description);
          assert.deepEqual(observed.events, ['store'], description);
        }
  const narrow = narrowSyntheticScope(),
    types = declaredTypes(narrow.id, 32, 1);
  const narrowStructured = structureControlFlow(narrow, createOperationContext());
  assert.ok(narrowStructured.value);
  const narrowProgram = reconstruct(
    { function: narrowStructured.value, source, types },
    createOperationContext(),
  );
  const definitions = [...narrowProgram.source!.definitions!.values()].flat();
  assert.ok(
    definitions.length >= 12,
    'Shared narrow arithmetic creates non-inline synthetic source definitions',
  );
  const original = new Set(
    narrow.blocks.flatMap((block) => block.instructions.map((node) => node.id)),
  );
  assert.ok([...narrowProgram.source!.definitions!.keys()].every((anchor) => original.has(anchor)));
  for (const { label, output } of outputs(narrow, types))
    for (const value of [0n, 1n, 2n, 0x7fffffffn, 0x80000000n, 0xffffffffn, 0x123456789abcdef0n]) {
      const low = BigInt.asUintN(32, value);
      const expected = BigInt.asUintN(32, low * ((low & 1n) !== 0n ? 4096n : 1024n) * 16n);
      const observed = execute(output.emission, inputs(narrow, [value]), zeroMemory());
      const description = `${label}: synthetic scope ${value}`;
      check(observed, expected ^ 0x55n, description);
      assert.equal(read64(observed.memory), expected, description);
      assert.deepEqual(observed.events, ['store'], description);
    }
  return { observations, fixtures: 4 };
}
