import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createOperationContext,
  newIdentity,
  type AbiProfile,
  type Emission,
  type RegisterDescriptor,
} from '../../src/core/index.js';
import { darwinArm64Abi } from '../../src/abi/darwin-arm64/index.js';
import { sysvAMD64Abi } from '../../src/abi/sysv-amd64/index.js';
import { observePreparedTailInterfaces } from '../../src/analysis/calls/observed.js';
import { constructSSA } from '../../src/analysis/ssa/index.js';
import { recoverTypes } from '../../src/analysis/types/index.js';
import { integer, type RegisterIR, type SSAForm } from '../../src/ir/index.js';
import { structureControlFlow } from '../../src/presentation/index.js';
import { reconstruct } from '../../src/reconstruction/index.js';
import type { Reconstruction } from '../../src/reconstruction/model.js';
import { builder, image, slice } from '../ir/support.js';
import { acknowledgeRequirements, emit, emittedFormals, execute } from '../emitters/c/support.js';

const u64 = integer(64),
  u8 = integer(8);
const INNER = 0x2000n,
  TARGET = 0x9000n;
const REASON = 'Indirect branch target is unresolved';

function argumentRegisters(abi: AbiProfile, count: number): RegisterDescriptor[] {
  const word = { kind: 'integer', bits: 64, signed: false } as const;
  return abi
    .classifyCall({
      returns: { kind: 'void' },
      parameters: Array.from({ length: count }, () => word),
      variadic: false,
      fixed_parameter_count: count,
    })
    .parameters.map((parameter) => {
      const location = parameter.locations[0]!;
      if (location.kind !== 'register') throw new Error('Expected register argument');
      return location.register;
    });
}
const named = (registers: readonly RegisterDescriptor[], name: string): RegisterDescriptor =>
  registers.find((register) => register.root.endsWith(`:${name}`) && register.width_bits === 64)!;

/** The pipeline's inputs for an IR-built function: stack-aware types, the tail
 * argument prefixes `recoverSourceEvidence` publishes, and an observed inner
 * callee that takes the first argument register and returns in it. */
function prepare(input: RegisterIR, abi: AbiProfile) {
  const ir = constructSSA(input).value as SSAForm;
  const types = recoverTypes(ir, abi, createOperationContext(), {
    image_id: image,
    slice_id: slice,
    revision: 0,
  });
  const [first] = argumentRegisters(abi, 1);
  const callees = ir.blocks.flatMap((block) =>
    block.instructions.flatMap((node) =>
      node.kind === 'call'
        ? [
            {
              call_id: node.id,
              parameters: [first!],
              returns: [first!],
              argument_list_complete: false,
              evidence_ids: [],
            },
          ]
        : [],
    ),
  );
  const extra = {
    types,
    source: {
      abi,
      callees,
      source_callees: observePreparedTailInterfaces(ir, abi, createOperationContext()),
      addresses: [],
      // 0x1000..0x3000 is code; the tail target 0x9000 is not in the image.
      executable_ranges: [{ start: 0x1000n, end: 0x3000n }],
    },
  };
  const structured = structureControlFlow(ir, createOperationContext());
  assert.ok(structured.value);
  const program = (view: 'source' | 'checked') =>
    reconstruct({ function: structured.value!, ...extra }, createOperationContext(), view);
  return { ir, extra, source: program('source'), checked: program('checked') };
}

type Arm64Shape =
  'valid' | 'link-overwritten' | 'sp-unrestored' | 'table' | 'known-target' | 'frame-escape';

/** f(x0, x1, x2, x3): a frame saving x29/x30/x19, `x19 = x3`, an inner call of
 * x0 (or of a frame address), then `return 7` when the inner result is even,
 * else the epilogue and `br x16` with x16 = x19 and x0 = the inner result + 1. */
function arm64(shape: Arm64Shape) {
  const abi = darwinArm64Abi;
  const registers = argumentRegisters(abi, 4),
    x0 = registers[0]!,
    x3 = registers[3]!;
  const preserved = abi.preserved,
    x19 = named(preserved, 'x19'),
    x29 = named(preserved, 'x29'),
    x16 = named(abi.unknown_call_clobbers.registers, 'x16'),
    lr = abi.link_register!,
    sp = abi.stack_pointer;
  const b = builder(`indirect-tail-arm64-${shape}`),
    entry = b.block('entry'),
    done = b.block('done'),
    tail = b.block('tail');
  const sp0 = entry.readRegister(sp);
  const frame = entry.int('sub', sp0, entry.constant(u64, 32n));
  entry.writeRegister(sp, frame);
  const slot = (offset: bigint) => entry.int('add', frame, entry.constant(u64, offset));
  const x19Slot = slot(8n),
    fpSlot = slot(16n),
    lrSlot = slot(24n);
  entry.store(x19Slot, entry.readRegister(x19));
  entry.store(fpSlot, entry.readRegister(x29));
  entry.store(lrSlot, entry.readRegister(lr));
  entry.writeRegister(x29, fpSlot);
  entry.writeRegister(x19, entry.readRegister(x3));
  if (shape === 'frame-escape') entry.writeRegister(x0, frame);
  entry.writeRegister(lr, entry.constant(u64, 0x1234n));
  entry.call(
    { kind: 'direct', address: { image_id: image, space: 'va', value: INNER } },
    [],
    [],
    abi.unknown_call_clobbers,
    [newIdentity('evidence')],
  );
  entry.branch(entry.extract(entry.readRegister(x0), 0, 1), entry.edge(tail), entry.edge(done));
  const epilogue = (block: typeof tail) => {
    block.writeRegister(x19, block.load(u64, x19Slot));
    block.writeRegister(x29, block.load(u64, fpSlot));
    block.writeRegister(
      lr,
      shape === 'link-overwritten' ? block.constant(u64, 0x2400n) : block.load(u64, lrSlot),
    );
    block.writeRegister(sp, shape === 'sp-unrestored' && block === tail ? frame : sp0);
  };
  epilogue(done);
  done.return([done.constant(u64, 7n)]);
  tail.writeRegister(x16, tail.readRegister(x19));
  tail.writeRegister(x0, tail.int('add', tail.readRegister(x0), tail.constant(u64, 1n)));
  epilogue(tail);
  const target =
    shape === 'table'
      ? tail.int(
          'add',
          tail.constant(u64, 0x1800n),
          tail.int(
            'shl',
            tail.cast('zero_extend', u64, tail.load(u8, tail.readRegister(x16))),
            tail.constant(u64, 2n),
          ),
        )
      : shape === 'known-target'
        ? tail.int('add', tail.constant(u64, 0x8000n), tail.constant(u64, 0x800n))
        : tail.readRegister(x16);
  tail.terminate({ kind: 'indirect', target, reason: REASON });
  return prepare(b.finish(entry, [u64]), abi);
}

type X86Shape = 'valid' | 'return-slot-store' | 'pointer-argument';

/** g(rdi, rsi, rdx): `push rdx; mov rdi, rdx; mov rax, rsi; add rsp, 8; jmp rax`,
 * optionally writing rdi over the return address at the entry SP first, or (`pointer-argument`)
 * first reading `[rdx]`, so that the forwarded argument is a declared pointer local. */
function x86(shape: X86Shape) {
  const abi = sysvAMD64Abi;
  const [rdi, rsi, rdx] = argumentRegisters(abi, 3);
  const rax = named(abi.unknown_call_clobbers.registers, 'rax'),
    sp = abi.stack_pointer;
  const b = builder(`indirect-tail-x86-${shape}`),
    block = b.block('entry');
  const sp0 = block.readRegister(sp);
  const pushed = block.int('sub', sp0, block.constant(u64, 8n));
  block.writeRegister(sp, pushed);
  block.store(pushed, block.readRegister(rdx!));
  if (shape === 'return-slot-store') block.store(sp0, block.readRegister(rdi!));
  block.writeRegister(rdi!, block.readRegister(rdx!));
  block.writeRegister(rax, block.readRegister(rsi!));
  if (shape === 'pointer-argument')
    block.writeRegister(rsi!, block.load(u64, block.readRegister(rdx!)));
  block.writeRegister(sp, sp0);
  block.terminate({ kind: 'indirect', target: block.readRegister(rax), reason: REASON });
  return prepare(b.finish(block, []), abi);
}

const accepted = (program: Reconstruction) =>
  program.local_validation?.some(
    (record) => record.kind === 'presentation' && record.rule === 'indirect_tail_call',
  ) ?? false;

/** Inputs of the emitted formals by name (`argN` numbers the formals in ABI order). */
function inputs(output: Emission, values: ReadonlyMap<string, bigint>): Map<string, bigint> {
  const result = new Map<string, bigint>();
  for (const formal of emittedFormals(output)) {
    const value = values.get(formal.name);
    assert.ok(value !== undefined, `unexpected formal ${formal.name}:\n${output.text}`);
    result.set(formal.statement_id, value);
  }
  return result;
}

test('darwin-arm64: frame, call, restore and br of a saved argument is a value-target tail that forwards the result and passes x0', () => {
  const { ir, extra, source, checked } = arm64('valid');
  assert.ok(accepted(source));
  const tail = [...source.tails.values()].find((candidate) => candidate.target === null);
  assert.ok(tail && tail.target === null);
  assert.equal(tail.boundary.arguments.length, 1);
  assert.equal(tail.boundary.argument_list_complete, false);
  // The x30 reload proves the return location under the frame-save premise.
  assert.ok(
    source.local_validation_session?.abiConformance.some(
      (site) => site.rule === 'indirect_tail_call',
    ),
  );
  assert.equal(source.source?.frame_saves?.stores.size, 3);
  // (g) The checked view keeps the unresolved exit.
  assert.equal(checked.tails.size, 0);
  assert.ok(!accepted(checked));
  assert.match(emit(ir, extra, 'c-like', 'checked').emission.text, /indirect_exit/);
  for (const language of ['c-like', 'python-like'] as const) {
    const output = emit(ir, extra, language).emission;
    assert.doesNotMatch(output.text, /indirect_exit|entry_sp|physical_return/, output.text);
    for (const inner of [5n, 6n]) {
      const received: bigint[][] = [];
      const result = execute(
        output,
        inputs(
          output,
          new Map([
            ['arg0', 0x41n],
            ['arg1', TARGET],
          ]),
        ),
        new Map(),
        0n,
        new Map(),
        new Map(),
        new Map([
          [
            `sub_${INNER.toString(16)}`,
            (args: readonly bigint[]) => {
              assert.deepEqual(args, [0x41n]);
              return inner;
            },
          ],
          [
            `0x${TARGET.toString(16)}`,
            (args: readonly bigint[]) => {
              received.push([...args]);
              return 0xabcn;
            },
          ],
        ]),
        acknowledgeRequirements(output),
      );
      // Odd inner results tail-call the target with them; even ones return 7.
      assert.deepEqual(result.values, inner & 1n ? [0xabcn] : [7n], output.text);
      assert.deepEqual(received, inner & 1n ? [[inner + 1n]] : []);
    }
  }
});

for (const [shape, reason] of [
  ['link-overwritten', 'x30 holds neither its entry value nor a frame-save reload'],
  ['sp-unrestored', 'SP is not the entry SP'],
  ['table', 'the target is a code base plus a table entry'],
  ['known-target', 'the target is a known (constant-only) destination'],
  ['frame-escape', 'a frame address is passed to the inner call'],
] as const)
  test(`darwin-arm64: no tail when ${reason}`, () => {
    const { ir, extra, source } = arm64(shape);
    assert.ok(!accepted(source));
    assert.ok(![...source.tails.values()].some((tail) => tail.target === null));
    assert.match(emit(ir, extra).emission.text, /indirect_exit/);
  });

test('sysv-amd64: `add rsp, 8; jmp rax` is a tail call; a store to the entry SP keeps the exit', () => {
  const { ir, extra, source, checked } = x86('valid');
  assert.ok(accepted(source));
  assert.ok(!accepted(checked));
  // No frame save is involved: the return address is never written.
  assert.ok(
    !source.local_validation_session?.abiConformance.some(
      (site) => site.rule === 'indirect_tail_call',
    ),
  );
  for (const language of ['c-like', 'python-like'] as const) {
    const output = emit(ir, extra, language).emission;
    assert.doesNotMatch(output.text, /indirect_exit/, output.text);
    const received: bigint[][] = [];
    const result = execute(
      output,
      inputs(
        output,
        new Map([
          ['arg0', TARGET],
          ['arg1', 0x55n],
        ]),
      ),
      new Map(),
      0n,
      new Map(),
      new Map(),
      new Map([
        [
          `0x${TARGET.toString(16)}`,
          (args: readonly bigint[]) => {
            received.push([...args]);
            return [];
          },
        ],
      ]),
      acknowledgeRequirements(output),
    );
    assert.deepEqual(result.values, []);
    assert.deepEqual(received, [[0x55n]]);
    // The pushed slot is private and never read; the call is the only effect.
    assert.deepEqual(result.events, ['call']);
  }
  const blocked = x86('return-slot-store');
  assert.ok(!accepted(blocked.source));
  assert.match(emit(blocked.ir, blocked.extra).emission.text, /indirect_exit/);
});

test('sysv-amd64: a declared pointer local forwarded to a tail call prints as itself, and the open cast names the printed arguments', () => {
  const { ir, extra, source } = x86('pointer-argument');
  assert.ok(accepted(source));
  const tail = [...source.tails.values()].find((candidate) => candidate.target === null);
  assert.ok(tail && tail.boundary.arguments.length === 2);
  assert.equal(tail.boundary.argument_list_complete, false);
  const c = emit(ir, extra, 'c-like').emission;
  // `(void (*)(uint64_t*, uint64_t))arg0(address, *address)`: the pointer is passed as
  // itself, the cast has no `...` (it would declare a variadic prototype), and the header
  // note states that the call may take more arguments.
  assert.match(c.text, /\(\w+ \(\*\)\(uint64_t\*, uint64_t\)\)\w+\)\(address, \*address\)/, c.text);
  assert.doesNotMatch(c.text, /uintptr_t|\.\.\./, c.text);
  assert.match(c.text, /open arity \([^)]*\): indirect call/, c.text);
  const python = emit(ir, extra, 'python-like').emission;
  assert.match(python.text, /open arity \([^)]*\): indirect call/, python.text);
  assert.doesNotMatch(python.text, /function_pointer\([^\n]*\.\.\./, python.text);
  for (const emitted of [c, python]) {
    const received: { arguments: bigint[]; complete: boolean }[] = [];
    const memory = new Map(
      Array.from({ length: 8 }, (_, offset) => [0x5000n + BigInt(offset), 0x10 + offset]),
    );
    const result = execute(
      emitted,
      inputs(
        emitted,
        new Map([
          ['arg0', TARGET],
          ['address', 0x5000n],
        ]),
      ),
      memory,
      0n,
      new Map(),
      new Map(),
      new Map([
        [
          `0x${TARGET.toString(16)}`,
          (args: readonly bigint[], context: { readonly arguments_complete: boolean }) => {
            received.push({ arguments: [...args], complete: context.arguments_complete });
            return [];
          },
        ],
      ]),
      acknowledgeRequirements(emitted),
    );
    assert.deepEqual(result.values, [], emitted.text);
    // The incoming rdx and the quadword it addresses, with the unresolved remainder marked.
    assert.deepEqual(
      received,
      [{ arguments: [0x5000n, 0x1716151413121110n], complete: false }],
      emitted.text,
    );
  }
});

test('sysv-amd64: a declared pointer local forwarded to a direct tail call prints as itself', () => {
  const abi = sysvAMD64Abi;
  const [rdi, rsi] = argumentRegisters(abi, 2);
  const rax = named(abi.unknown_call_clobbers.registers, 'rax');
  const b = builder('direct-tail-pointer-argument'),
    block = b.block('entry');
  // `mov rsi, [rdi]; jmp 0x9000`: rdi is a pointer local (it is dereferenced) and a tail argument.
  block.writeRegister(rsi!, block.load(u64, block.readRegister(rdi!)));
  block.terminate({
    kind: 'indirect',
    target: block.constant(u64, TARGET),
    tail_call: true,
    reason: 'trusted fixture tail',
  });
  const ir = constructSSA(b.finish(block, [])).value as SSAForm;
  const control = ir.blocks
    .map((candidate) => candidate.terminator)
    .find((candidate) => candidate.kind === 'indirect')!;
  const extra = {
    source: {
      abi,
      callees: [
        {
          call_id: control.id,
          target: { image_id: image, space: 'va' as const, value: TARGET },
          parameters: [rdi!, rsi!],
          returns: [rax],
          argument_list_complete: false,
          evidence_ids: [],
        },
      ],
      addresses: [],
    },
  };
  for (const language of ['c-like', 'python-like'] as const) {
    const output = emit(ir, extra, language).emission;
    assert.match(output.text, /return sub_9000\(address, /, output.text);
    assert.doesNotMatch(output.text, /uintptr_t/, output.text);
  }
});
