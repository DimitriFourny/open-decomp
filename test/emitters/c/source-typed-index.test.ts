import assert from 'node:assert/strict';
import test from 'node:test';
import { sysvAMD64Abi } from '../../../src/abi/sysv-amd64/index.js';
import { constructSSA } from '../../../src/analysis/ssa/index.js';
import { recoverTypes } from '../../../src/analysis/types/index.js';
import { createOperationContext } from '../../../src/core/index.js';
import { integer, type DataType, type SSAForm } from '../../../src/ir/index.js';
import { builder, image, register, slice } from '../../ir/support.js';
import { emit, emittedFormals, execute } from './support.js';

const i64 = integer(64);
const rdi = register('rdi', 64, 0, 'replace_root', 'x86_64:rdi');
const rsi = register('rsi', 64, 0, 'replace_root', 'x86_64:rsi');
const source = { abi: sysvAMD64Abi, callees: [], addresses: [] };

/** Where the constant joins `p + index * width`: the order the lifter and the
 * inliner leave it in differs per access. */
type Shape = 'base_index_const' | 'const_base_index' | 'base_const_index';
interface Access {
  /** Signed byte displacement from `p` (plus the index term when `indexed`). */
  readonly bytes: bigint;
  readonly indexed: boolean;
  readonly store?: boolean;
  readonly shape?: Shape;
}
let sequence = 0;
function program(
  bits: number,
  accesses: readonly Access[],
  kind: 'integer' | 'float' = 'integer',
  narrow = false,
) {
  const b = builder(`typed-index-${sequence++}`),
    block = b.block('entry');
  const pointer = block.readRegister(rdi);
  // A narrow index is the zero extension of a 32-bit formal (a loop counter).
  const index = narrow
    ? block.cast('zero_extend', i64, block.cast('truncate', integer(32), block.readRegister(rsi)))
    : block.readRegister(rsi);
  const type: DataType =
    kind === 'float' ? { kind: 'float', bits: bits as 32 | 64 } : integer(bits);
  const shift = BigInt(Math.log2(bits / 8));
  let sum = block.constant(i64, 0n);
  for (const access of accesses) {
    const scaled = block.int('shl', index, block.constant(i64, shift));
    const constant = block.constant(i64, BigInt.asUintN(64, access.bytes));
    let address = pointer;
    const shape = access.shape ?? 'base_index_const';
    if (shape === 'const_base_index') {
      address = block.int('add', constant, address);
      if (access.indexed) address = block.int('add', address, scaled);
    } else if (shape === 'base_const_index') {
      address = block.int('add', address, constant);
      if (access.indexed) address = block.int('add', address, scaled);
    } else {
      if (access.indexed) address = block.int('add', address, scaled);
      address = block.int('add', address, constant);
    }
    if (access.store) {
      block.store(address, block.constant(integer(bits), 0x5an));
      continue;
    }
    const loaded = block.load(type, address);
    const bitsValue = kind === 'float' ? block.cast('bitcast', integer(bits), loaded) : loaded;
    sum = block.int(
      'add',
      sum,
      bits === 64 ? bitsValue : block.cast('zero_extend', i64, bitsValue),
    );
  }
  block.return([sum]);
  return constructSSA(b.finish(block, [i64])).value as SSAForm;
}

const BASE = 0x2000n,
  INDEX = 3n;
function memoryImage(): Map<bigint, number> {
  return new Map(
    Array.from(
      { length: 0x100 },
      (_, offset) => [BASE + BigInt(offset), (offset * 37 + 11) & 255] as const,
    ),
  );
}
function word(memory: ReadonlyMap<bigint, number>, address: bigint, bytes: number): bigint {
  let value = 0n;
  for (let byte = 0; byte < bytes; byte++)
    value |= BigInt(memory.get(address + BigInt(byte))!) << BigInt(8 * byte);
  return value;
}
/** Run the emitted text against an independent byte model of the accesses. */
function check(
  bits: number,
  accesses: readonly Access[],
  language: 'c-like' | 'python-like',
  narrow = false,
  kind: 'integer' | 'float' = 'integer',
) {
  const output = emit(program(bits, accesses, kind, narrow), { source }, language).emission;
  const [pointer, index] = emittedFormals(output);
  const start = memoryImage();
  const memory = new Map(start);
  const address = (access: Access): bigint =>
    BASE + 0x80n + (access.indexed ? INDEX * BigInt(bits / 8) : 0n) + access.bytes;
  const observed = execute(
    output,
    new Map([
      ...pointer!.semantic_ids.map((id) => [id, BASE + 0x80n] as const),
      ...(index?.semantic_ids ?? []).map((id) => [id, INDEX] as const),
    ]),
    memory,
  );
  let expected = 0n;
  const model = new Map(start);
  for (const access of accesses) {
    if (access.store) {
      for (let byte = 0; byte < bits / 8; byte++)
        model.set(address(access) + BigInt(byte), byte === 0 ? 0x5a : 0);
    } else expected += word(model, address(access), bits / 8);
  }
  assert.deepEqual(observed.values, [BigInt.asUintN(64, expected)]);
  assert.deepEqual(observed.memory, model);
  return output;
}

const subscripts = (text: string): string[] =>
  [...text.matchAll(/\b[A-Za-z_]\w*\[([^\]\n]+)\]/g)].map((match) => match[1]!);

for (const bits of [8, 16, 32, 64] as const) {
  const width = BigInt(bits / 8);
  test(`typed index: ${bits}-bit loads with positive and negative displacements join the index`, () => {
    const accesses: Access[] = [
      { bytes: 2n * width, indexed: true },
      { bytes: -width, indexed: true, shape: 'const_base_index' },
      { bytes: 5n * width, indexed: true, shape: 'base_const_index' },
      { bytes: -3n * width, indexed: true, shape: 'base_const_index' },
    ];
    // A bare 64-bit formal is ambiguous beside a byte pointer, so bytes use only
    // the narrow (zero-extended 32-bit) index.
    for (const narrow of width === 1n ? [true] : [false, true]) {
      const c = check(bits, accesses, 'c-like', narrow);
      assert.deepEqual(
        subscripts(c.text).map((text) => /([+-] \d+)$/.exec(text)?.[1]),
        ['+ 2', '- 1', '+ 5', '- 3'],
      );
      assert.match(c.text, /\[\w+ \+ 2\]/);
      assert.ok(c.local_validation?.some((record) => record.rule === 'typed_index'));
      assert.doesNotMatch(c.text, /uintptr_t/);
      const python = check(bits, accesses, 'python-like', narrow);
      assert.ok(python.local_validation?.some((record) => record.rule === 'typed_address_sum'));
      assert.doesNotMatch(python.text, /memory\.u\d+\[uint64\(uint64\(/);
    }
  });
  test(`typed index: ${bits}-bit constant displacements print element subscripts`, () => {
    const accesses: Access[] = [
      { bytes: 3n * width, indexed: false },
      { bytes: -2n * width, indexed: false },
      { bytes: 0n, indexed: true },
    ];
    const c = check(bits, accesses, 'c-like');
    assert.deepEqual(
      subscripts(c.text).sort(),
      ['-2', '3', subscripts(c.text).find((text) => /^[A-Za-z_]\w*$/.test(text))!].sort(),
    );
    assert.ok(subscripts(c.text).some((text) => /^[A-Za-z_]\w*$/.test(text)));
    check(bits, accesses, 'python-like');
  });
  test(`typed index: ${bits}-bit stores and loads share the subscript`, () => {
    const accesses: Access[] = [
      { bytes: 4n * width, indexed: true, store: true },
      { bytes: 4n * width, indexed: true },
      { bytes: -width, indexed: false, store: true },
      { bytes: -width, indexed: false },
    ];
    const c = check(bits, accesses, 'c-like');
    assert.match(c.text, /\w+\[\w+ \+ 4\] = /);
    assert.match(c.text, /\w+\[-1\] = /);
    assert.doesNotMatch(c.text, /uintptr_t/);
    check(bits, accesses, 'python-like');
  });
}

for (const bits of [16, 32, 64] as const)
  test(`typed index: ${bits}-bit misaligned displacements keep the explicit address`, () => {
    const misaligned = BigInt(bits / 8 + 1);
    for (const indexed of [true, false]) {
      const accesses: Access[] = [
        { bytes: misaligned, indexed },
        { bytes: -misaligned, indexed, store: true },
      ];
      const c = check(bits, accesses, 'c-like');
      assert.deepEqual(subscripts(c.text), []);
      assert.match(c.text, new RegExp(`\\*\\((?:uint${bits}_t) \\*\\)`));
      assert.ok(!c.local_validation?.some((record) => record.rule === 'typed_index'));
      check(bits, accesses, 'python-like');
    }
  });

test('typed index: a constant joins a zero-extended index in 64-bit arithmetic', () => {
  for (const bits of [8, 32] as const) {
    const accesses: Access[] = [{ bytes: BigInt(bits / 8) * 2n, indexed: true }];
    const c = check(bits, accesses, 'c-like', true);
    // 32-bit `index + 2` would wrap where the 64-bit address sum does not.
    assert.match(c.text, /\[\(uint64_t\)\w+ \+ 2\]/);
    const bare = check(bits, [{ bytes: 0n, indexed: true }], 'c-like', true);
    assert.match(bare.text, /\[\w+\]/);
  }
});

test('typed index: an aligned access beside a misaligned one is refused individually', () => {
  const accesses: Access[] = [
    { bytes: 8n, indexed: true },
    { bytes: 6n, indexed: true },
  ];
  const c = check(32, accesses, 'c-like');
  assert.deepEqual(
    subscripts(c.text).map((text) => text.replace(/^\w+ /, '')),
    ['+ 2'],
  );
  assert.match(c.text, /\*\(uint32_t \*\)\(\(uintptr_t\)\w+ \+ \(\w+ << 2\) \+ 6\)/);
});

for (const bits of [32, 64] as const)
  test(`typed index: ${bits}-bit IEEE accesses index a floating element pointer`, () => {
    const width = BigInt(bits / 8);
    const accesses: Access[] = [
      { bytes: 2n * width, indexed: true },
      { bytes: -width, indexed: true, shape: 'const_base_index' },
      { bytes: 3n * width, indexed: false },
      { bytes: width + 1n, indexed: true },
    ];
    const element = bits === 32 ? 'float' : 'double';
    const typed = accesses.slice(0, 3);
    const c = check(bits, typed, 'c-like', false, 'float');
    assert.match(c.text, new RegExp(`const ${element}\\*`));
    assert.deepEqual(
      subscripts(c.text).map((text) => text.replace(/^\w+ /, '')),
      ['+ 2', '- 1', '3'],
    );
    assert.doesNotMatch(c.text, /uintptr_t/);
    assert.ok(c.local_validation?.some((record) => record.rule === 'typed_index'));
    const python = check(bits, typed, 'python-like', false, 'float');
    assert.ok(python.local_validation?.some((record) => record.rule === 'typed_address_sum'));
    assert.match(
      python.text,
      new RegExp(`memory\\.f${bits}\\[uint64\\(\\w+ \\+ \\w+ \\* ${width} \\+ ${2n * width}\\)\\]`),
    );
    // A misaligned displacement keeps the cast dereference of the actual address.
    const mixed = check(bits, accesses.slice(2), 'c-like', false, 'float');
    assert.match(
      mixed.text,
      new RegExp(
        `\\*\\(${element} \\*\\)\\(\\(uintptr_t\\)\\w+ \\+ \\(\\w+ << ${Math.log2(bits / 8)}\\) \\+ ${width + 1n}\\)`,
      ),
    );
  });

test('typed index: an integer access through an IEEE pointer (mixed kind) stays explicit', () => {
  const b = builder(`typed-index-kind-${sequence++}`),
    block = b.block('entry');
  const pointer = block.readRegister(rdi),
    index = block.readRegister(rsi);
  const address = block.int(
    'add',
    block.int('add', pointer, block.int('shl', index, block.constant(i64, 3n))),
    block.constant(i64, 16n),
  );
  const real = block.cast('bitcast', i64, block.load({ kind: 'float', bits: 64 }, pointer));
  block.return([block.int('add', real, block.load(i64, address))]);
  const output = emit(
    constructSSA(b.finish(block, [i64])).value as SSAForm,
    { source },
    'c-like',
  ).emission;
  assert.doesNotMatch(output.text, /double\*/);
  assert.ok(!output.local_validation?.some((record) => record.rule === 'typed_index'));
});

/** `p = p + index * 4 + bytes` in a loop over a declared `uint32_t*`. */
function steppedPointer(bytes: bigint, indexed: boolean) {
  const rdx = register('rdx', 64, 0, 'replace_root', 'x86_64:rdx');
  const b = builder(`typed-step-${sequence++}`),
    entry = b.block('entry'),
    loop = b.block('loop'),
    step = b.block('step'),
    done = b.block('done');
  entry.jump(loop);
  loop.branch(
    loop.compare('eq', loop.readRegister(rdx), loop.constant(i64, 0n)),
    loop.edge(done),
    loop.edge(step),
  );
  const pointer = step.readRegister(rdi);
  let moved = pointer;
  if (indexed)
    moved = step.int('add', moved, step.int('shl', step.readRegister(rsi), step.constant(i64, 2n)));
  moved = step.int('add', moved, step.constant(i64, BigInt.asUintN(64, bytes)));
  step.writeRegister(rdi, moved);
  step.writeRegister(rdx, step.int('sub', step.readRegister(rdx), step.constant(i64, 1n)));
  step.jump(loop);
  done.return([done.cast('zero_extend', i64, done.load(integer(32), done.readRegister(rdi)))]);
  const ssa = constructSSA(b.finish(entry, [i64])).value as SSAForm;
  const bindings = ssa.register_states.find((state) => state.block === ssa.entry)!.entry;
  const types = recoverTypes(ssa, sysvAMD64Abi, createOperationContext(), {
    slice_id: slice,
    image_id: image,
    revision: 1,
    types: [
      {
        id: 'word',
        definition: { kind: 'integer', bits: 32, signed: false },
        source: 'debug',
        status: 'established',
        evidence_ids: [],
      },
      {
        id: 'word-pointer',
        definition: { kind: 'pointer', bits: 64, to: 'word' },
        source: 'debug',
        status: 'established',
        evidence_ids: [],
      },
    ],
    bindings: [
      {
        subject_id: bindings.find((binding) => binding.register.root === rdi.root)!.value.id,
        type_id: 'word-pointer',
        source: 'debug',
        status: 'established',
        evidence_ids: [],
      },
    ],
  });
  return emit(ssa, { types, source }, 'c-like');
}

// The stepped pointer shares the formal's variable (no copy into a second
// local); the step prints as a statement or in a `for` header.
for (const [bytes, indexed, text] of [
  [8n, true, /address = address \+ \w+ \+ 2[;)]/],
  [-8n, true, /address = address \+ \w+ - 2[;)]/],
  [12n, false, /address = address \+ 3[;)]/],
  [-12n, false, /address = address - 3[;)]/],
  [6n, true, /address = \(uint32_t\*\)\(\(uintptr_t\)address \+ \(\w+ << 2\) \+ 6\)[;)]/],
  [6n, false, /address = \(uint32_t\*\)\(\(uintptr_t\)address \+ 6\)[;)]/],
] as const)
  test(`typed index: pointer update by ${bytes} bytes${indexed ? ' plus a scaled index' : ''} executes as pointer arithmetic or stays explicit`, () => {
    const output = steppedPointer(bytes, indexed);
    assert.match(output.emission.text, text);
    const aligned = bytes % 4n === 0n;
    assert.equal(
      output.emission.local_validation?.some(
        (record) => record.rule === 'scaled_pointer_arithmetic',
      ),
      aligned,
    );
    const formals = emittedFormals(output.emission);
    const memory = new Map(memoryImage());
    const count = 2n,
      stride = 3n,
      start = BASE + 0x80n;
    const inputs = new Map<string, bigint>();
    const values = indexed ? [start, stride, count] : [start, count];
    formals.forEach((formal, position) => {
      for (const id of formal.semantic_ids) inputs.set(id, values[position]!);
    });
    const observed = execute(output.emission, inputs, memory);
    const final = start + count * ((indexed ? stride * 4n : 0n) + BigInt.asUintN(64, bytes));
    assert.deepEqual(observed.values, [word(memoryImage(), BigInt.asUintN(64, final), 4)]);
  });
