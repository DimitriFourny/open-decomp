import assert from 'node:assert/strict';
import test from 'node:test';
import { createOperationContext, newIdentity, type AbiSignature } from '../../src/core/index.js';
import { darwinArm64Abi } from '../../src/abi/darwin-arm64/index.js';
import { sysvAMD64Abi } from '../../src/abi/sysv-amd64/index.js';
import { windowsX64Abi } from '../../src/abi/windows-x64/index.js';
import { constructSSA } from '../../src/analysis/ssa/index.js';
import { recoverTypes } from '../../src/analysis/types/index.js';
import { integer, type SSAForm } from '../../src/ir/index.js';
import { builder, image, slice } from '../ir/support.js';
import { emit, execute } from '../emitters/c/support.js';

for (const abi of [darwinArm64Abi, sysvAMD64Abi, windowsX64Abi]) {
  test(`${abi.id}: proven format actuals preserve register/stack values in both dialects`, () => {
    const signature: AbiSignature = {
      returns: { kind: 'integer', bits: 32, signed: true },
      parameters: [{ kind: 'pointer' }, { kind: 'integer', bits: 32, signed: true }],
      variadic: true,
      fixed_parameter_count: 1,
      argument_list_complete: true,
    };
    const b = builder(`format-actuals-${abi.id}`),
      block = b.block('entry');
    const frame = block.int(
      'sub',
      block.readRegister(abi.stack_pointer),
      block.constant(integer(64), 64n),
    );
    block.writeRegister(abi.stack_pointer, frame);
    for (const parameter of abi.classifyCall(signature).parameters) {
      const location = parameter.locations[0]!;
      const width =
        location.kind === 'register'
          ? location.register.width_bits
          : parameter.index === 0
            ? 64
            : 32;
      const value = block.constant(integer(width), parameter.index === 0 ? 0x3000n : 37n);
      if (location.kind === 'register') block.writeRegister(location.register, value);
      else if (location.kind === 'stack')
        block.store(
          block.int(
            'add',
            frame,
            block.constant(integer(64), location.offset - abi.stack_return_address_bytes),
          ),
          value,
        );
      else assert.fail('scalar argument must have direct storage');
    }
    block.call(
      { kind: 'direct', address: { image_id: image, space: 'va', value: 0x2000n } },
      [],
      [],
      abi.unknown_call_clobbers,
      [newIdentity('evidence')],
    );
    block.return([block.constant(integer(32), 99n)]);
    const ir = constructSSA(b.finish(block, [integer(32)])).value as SSAForm;
    const types = recoverTypes(ir, abi, createOperationContext(), {
      image_id: image,
      slice_id: slice,
      revision: 0,
    });
    const call = ir.blocks[0]!.instructions.find((node) => node.kind === 'call')!;
    const source = {
      abi,
      callees: [],
      addresses: [],
      call_argument_signatures: new Map([[call.id, signature]]),
    };
    for (const language of ['c-like', 'python-like'] as const) {
      const output = emit(ir, { types, source }, language).emission;
      assert.doesNotMatch(output.text, /entry_sp|unknown_argument/);
      assert.ok(output.local_validation?.some((record) => record.rule === 'arity_closure'));
      let calls = 0;
      const result = execute(
        output,
        new Map(),
        new Map(),
        0n,
        new Map(),
        new Map(),
        new Map([
          [
            'sub_2000',
            (args, context) => {
              calls++;
              assert.deepEqual(args, [0x3000n, 37n]);
              assert.equal(context.arguments_complete, true);
              return 0n;
            },
          ],
        ]),
      );
      assert.equal(calls, 1);
      assert.deepEqual(result.values, [99n]);
      assert.equal(
        emit(ir, { types, source }, language, 'checked').emission.text,
        emit(ir, { types, source: { abi, callees: [], addresses: [] } }, language, 'checked')
          .emission.text,
        'source-only format evidence must not alter checked text',
      );
    }
  });
}
