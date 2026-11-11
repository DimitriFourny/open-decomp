import assert from 'node:assert/strict';
import test from 'node:test';
import { createOperationContext } from '../../../src/core/index.js';
import { sysvAMD64Abi } from '../../../src/abi/sysv-amd64/index.js';
import { UNWINDER_ENTRY_REASONS } from '../../../src/analysis/discovery/index.js';
import { constructSSA } from '../../../src/analysis/ssa/index.js';
import { integer, type RegisterIR, type SSAForm } from '../../../src/ir/index.js';
import {
  nativeWrittenRegisters,
  writtenRegisterDomain,
} from '../../../src/service/analysis/native-written.js';
import { builder, image, register } from '../../ir/support.js';

const i64 = integer(64);
const gpr = (name: string) => register(name, 64, 0, 'replace_root', `x86_64:${name}`);
const ssa = (ir: RegisterIR): SSAForm => {
  const built = constructSSA(ir);
  assert.equal(built.value.form, 'ssa');
  return built.value as SSAForm;
};
const written = (ir: SSAForm, coverage: readonly string[] = []) =>
  nativeWrittenRegisters(
    ir,
    coverage,
    new Map(),
    writtenRegisterDomain(sysvAMD64Abi),
    createOperationContext(),
  )?.map((slice) => slice.root);

test('written-register sets: a returning body names what it writes', () => {
  const ir = builder('writes-rax');
  const b = ir.block('entry');
  b.writeRegister(gpr('rax'), b.constant(i64, 7n));
  b.return();
  assert.deepEqual(written(ssa(ir.finish(b, [])))?.sort(), ['x86_64:rax']);
});

// An unwinder may enter a landing pad the graph lacks and return from there (C++
// `catch (...) { return 7; }` after a call discovery proves noreturn): the static
// exits prove nothing about that path. Contested instruction boundaries likewise.
for (const reason of [
  ...UNWINDER_ENTRY_REASONS,
  'overlapping instructions',
  'conflicting boundaries',
])
  test(`written-register sets: no set for a graph with coverage reason "${reason}"`, () => {
    const ir = builder(`covered-${reason}`);
    const b = ir.block('entry');
    b.return();
    assert.equal(written(ssa(ir.finish(b, [])), [reason]), undefined);
  });

test('written-register sets: no set for a body without a return or tail exit', () => {
  // `bl thrower; brk`: the only returning path (the landing pad) is outside the graph.
  const ir = builder('no-exit');
  const b = ir.block('entry');
  b.call({ kind: 'direct', address: { image_id: image, space: 'va', value: 0x2000n } }, [], [], {
    registers: sysvAMD64Abi.unknown_call_clobbers.registers,
    flags: [],
    memory: 'unknown_read_write',
  });
  b.terminate({ kind: 'trap', reason: 'Established architectural trap instruction' });
  assert.equal(written(ssa(ir.finish(b, []))), undefined);
});
