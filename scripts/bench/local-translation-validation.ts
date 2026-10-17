import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { openBinary, type BinarySession } from '../../src/api/index.js';
import { emissionSchema } from '../../src/core/tools.js';
import { emittedFormals, execute } from '../../test/emitters/c/support.js';
import { localValidationCounterexamples } from '../../test/reconstruction/local-validation-cases.js';

localValidationCounterexamples();
console.log('counterexamples: carry loss, signed shift, cyclic copy, uninitialized/aliased/endian storage, wrong exit rejected; good 32/64-bit paths verified; unknown/allowance/outer failures honest');
if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('Trusted-source public smoke requires Darwin arm64 clang target');
const root = await mkdtemp(join(tmpdir(), 'open-decomp-local-translation-'));
let session: BinarySession | undefined;
try {
  const binary = join(root, 'translation');
  const compiled = spawnSync('/usr/bin/clang', ['-target', 'arm64-apple-macos13.0', '-O1', '-fno-builtin',
    resolve('test/reconstruction/translation-source.c'), '-o', binary], { encoding: 'utf8' });
  assert.equal(compiled.status, 0, compiled.stderr);
  const native = spawnSync(binary, [], { encoding: 'utf8' });
  assert.equal(native.status, 0, native.stderr);
  const oracle = native.stdout.trim().split('\n').map((line) => line.split(' ').slice(1).map((bits) => BigInt(`0x${bits}`)));
  assert.equal(oracle.length, 5);
  const inputs = [0n, 1n, 0xffffffffffffffffn, 0x8000000000000000n, 0x5555555555555555n];
  session = await openBinary(binary, { cachePath: join(root, 'cache') });
  for (const emitter of ['c-like', 'python-like'] as const) {
    for (const [column, name] of ['translation_arithmetic', 'translation_stack', 'translation_loop'].entries()) {
      const result = await session.decompile({ name: `_${name}` }, { emitter });
      assert.ok('data' in result && result.data.delivery === 'inline', JSON.stringify(result));
      const emission = result.data.emission;
      emissionSchema.parse(emission);
      assert.ok(emission.local_validation, 'structured consumer-visible validation status');
      assert.ok(emission.local_validation.every((record) => record.status !== 'rejected'), JSON.stringify(emission.local_validation));
      for (const record of emission.local_validation) {
        if (record.kind !== 'parallel-copy' && record.kind !== 'stack-promotion') continue;
        assert.ok(record.subject_ids?.length, 'storage/copy checks retain original mapped consumer subjects');
        for (const id of record.subject_ids)
          assert.ok(emission.mappings.some((mapping) => mapping.statement_id === id || mapping.semantic_ids.includes(id)),
            `Validation subject has no emitted provenance mapping: ${id}`);
      }
      const formals = emittedFormals(emission);
      for (let i = 0; i < inputs.length; i++) {
        const args = [inputs[i]!, inputs[4 - i]!, BigInt(i)];
        const values = new Map<string, bigint>();
        let argument = 0;
        for (const formal of formals) values.set(formal.statement_id, formal.name === 'entry_sp' ? 0x9000n : args[argument++]!);
        const environment = new Map<string, bigint>([['non-argument entry register', 0n]]);
        const observed = execute(emission, values, new Map(), 0n, new Map(), environment);
        assert.equal(observed.exit, 'machine_return', `${emitter}/${name}/${i}`);
        assert.deepEqual(observed.values, [oracle[i]![column]!], `${emitter}/${name}/${i}`);
      }
      const status = emission.local_validation.reduce<Record<string, number>>((counts, record) => {
        const key = `${record.kind}/${record.status}`; counts[key] = (counts[key] ?? 0) + 1; return counts;
      }, {});
      console.log(JSON.stringify({ emitter, name, outcomes: 5, validation: status }));
    }
  }
} finally {
  await session?.close();
  await rm(root, { recursive: true, force: true });
}
