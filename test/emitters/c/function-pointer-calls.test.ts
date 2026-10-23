import assert from 'node:assert/strict';
import test from 'node:test';
import { sysvAMD64Abi } from '../../../src/abi/sysv-amd64/index.js';
import { constructSSA } from '../../../src/analysis/ssa/index.js';
import type { RegisterDescriptor } from '../../../src/core/index.js';
import { integer, type SSAForm } from '../../../src/ir/index.js';
import { builder } from '../../ir/support.js';
import { emit, emittedFormals, execute } from './support.js';

const u64 = integer(64);
const CALLBACK = 0x7000n;
const writing = { registers: [], flags: [], memory: 'unknown_read_write' as const };

function argumentRegisters(count: number): RegisterDescriptor[] {
  const word = { kind: 'integer', bits: 64, signed: false } as const;
  return sysvAMD64Abi
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
const [rdi, rsi, rdx] = argumentRegisters(3) as [
  RegisterDescriptor,
  RegisterDescriptor,
  RegisterDescriptor,
];
const rax = sysvAMD64Abi.unknown_call_clobbers.registers.find(
  (register) => register.root.endsWith(':rax') && register.width_bits === 64,
)!;

/** f(callback, a, b) = callback(a, b) + 1, the callback an indirect call whose observed
 * interface is the argument prefix (rsi, rdx) with the list open. */
function indirect() {
  const b = builder('function-pointer-open'),
    entry = b.block('entry');
  const callback = entry.readRegister(rdi);
  const [result] = entry.call(
    { kind: 'indirect', value: callback },
    [entry.readRegister(rsi), entry.readRegister(rdx)],
    [u64],
    writing,
  );
  entry.return([entry.int('add', result!, entry.constant(u64, 1n))]);
  const ir = constructSSA(b.finish(entry, [u64])).value as SSAForm;
  const callees = ir.blocks.flatMap((block) =>
    block.instructions.flatMap((node) =>
      node.kind === 'call'
        ? [
            {
              call_id: node.id,
              parameters: [rsi, rdx],
              returns: [rax],
              argument_list_complete: false,
              evidence_ids: [],
            },
          ]
        : [],
    ),
  );
  return { ir, extra: { source: { abi: sysvAMD64Abi, callees, addresses: [] } } };
}

for (const language of ['c-like', 'python-like'] as const) {
  test(`${language} an open indirect call prints no ellipsis in its function-pointer type, states the open arity in the header, and calls the callback with the printed arguments`, () => {
    const { ir, extra } = indirect();
    const output = emit(ir, extra, language).emission;
    // A `...` in a C function-pointer type declares a variadic prototype: the type names
    // exactly the two printed arguments, and the header says the call may take more.
    if (language === 'c-like')
      assert.match(output.text, /\(\w+ \(\*\)\(uint64_t, uint64_t\)\)/, output.text);
    else assert.match(output.text, /function_pointer\(\w+, "\w+ \(\*\)\(uint64_t, uint64_t\)"\)/);
    assert.doesNotMatch(output.text, /\.\.\./, output.text);
    assert.match(output.text, /open arity \(proven args only\): indirect call/);
    assert.ok(
      output.local_validation?.some(
        (record) => record.kind === 'presentation' && record.rule === 'function_pointer_call',
      ),
    );
    // The checked view keeps the physical call.
    assert.doesNotMatch(
      emit(ir, extra, language, 'checked').emission.text,
      /open arity|\(\*\)\(uint64_t, uint64_t\)/,
    );

    const formals = emittedFormals(output);
    assert.equal(formals.length, 3, output.text);
    const received: { arguments: bigint[]; complete: boolean }[] = [];
    for (const [a, b] of [
      [3n, 4n],
      [0xffffffffffffffffn, 0n],
    ] as const) {
      received.length = 0;
      const result = execute(
        output,
        new Map(
          formals.map((formal, index) => [formal.statement_id, [CALLBACK, a, b][index]!] as const),
        ),
        new Map(),
        0n,
        new Map(),
        new Map(),
        new Map([
          [
            `0x${CALLBACK.toString(16)}`,
            (args: readonly bigint[], context: { readonly arguments_complete: boolean }) => {
              received.push({ arguments: [...args], complete: context.arguments_complete });
              return 0x20n;
            },
          ],
        ]),
      );
      assert.deepEqual(result.values, [0x21n], output.text);
      // The callback receives exactly the cast's named positions, and the unresolved
      // remainder of the interface stays marked.
      assert.deepEqual(received, [{ arguments: [a, b], complete: false }], output.text);
    }
  });
}
