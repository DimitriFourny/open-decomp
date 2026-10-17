import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { openBinary } from '../../../src/api/index.js';
import { acknowledgeRequirements, emittedFormals, execute } from '../../emitters/c/support.js';

// Scalar FP remains one known primary result; changed possible ABI storage is
// an uncertain machine overlay, including uncovered bits of that same root.
const root = await mkdtemp(join(tmpdir(), 'native-return-storage-oracle-'));
const source = resolve('test/service/analysis/native-return-storage-source.c');
const analyzed = join(root, 'analyzed'), trusted = join(root, 'trusted');
for (const [binary, defines] of [[analyzed, []], [trusted, ['-DNATIVE_RETURN_TRUSTED_ORACLE']]] as const) {
  const result = spawnSync('/usr/bin/clang', ['-target', 'arm64-apple-macos13.0', '-O1', '-g0', '-fno-builtin',
    ...defines, source, '-o', binary], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
}
const native = spawnSync(trusted, [], { encoding: 'utf8' }); // Never execute analyzed.
assert.equal(native.status, 0, native.stderr);
const expected = new Map(native.stdout.trim().split('\n').map((line) => {
  const [kind, index, primary, raw] = line.split(' ');
  return [`${kind}:${index}`, { primary: BigInt(`0x${primary}`), raw: BigInt(`0x${raw}`) }] as const;
}));
assert.equal(expected.size, 12);
const session = await openBinary(analyzed, { cachePath: join(root, 'cache') });
try {
  const values = [0n, 1n, 0x7fffffffn, 0x80000000n, 0xffffffffffffffffn, 0x1234567887654321n];
  const mask = 0xffffffffffffffffn, inputFp = 0x3ff8000000000000n;
  let outcomes = 0;
  const evidence: unknown[] = [];
  const observations: unknown[] = [];
  for (const emitter of ['c-like', 'python-like'] as const)
    for (const kind of ['scratch', 'clean'] as const) {
      const result = await session.decompile({ name: `_return_probe_fp_${kind}` }, { emitter });
      assert.ok('data' in result && result.data.delivery === 'inline');
      const emission = result.data.emission;
      const returnDiagnostics = result.diagnostics.filter((diagnostic) =>
        diagnostic.message.startsWith('The source return list is unresolved'));
      assert.equal(result.state, 'partial');
      assert.ok(returnDiagnostics.length);
      assert.ok(returnDiagnostics.some((diagnostic) => diagnostic.message.includes('arm64:v0[64:64]')),
        'A scalar D0 primary does not authorize dropping changed possible vector upper bits');
      assert.equal(returnDiagnostics.some((diagnostic) => diagnostic.message.includes('arm64:x0[')), kind === 'scratch',
        'Unchanged GP storage is not a new return channel; changed GP storage remains accessible without an aggregate claim');
      const unresolved = emission.requirements?.find((requirement) => requirement.kind === 'unresolved' &&
        requirement.explanation.startsWith('The source return list is incomplete'));
      assert.ok(unresolved && unresolved.explanation.includes('arm64:v0[64:64]'));
      assert.ok(unresolved.instruction_refs.length && unresolved.range_refs.length && unresolved.output_spans.length);
      evidence.push({ emitter, kind, diagnostics: result.diagnostics, emission });
      const formals = emittedFormals(emission).filter((formal) => formal.name !== 'entry_sp');
      assert.equal(formals.length, kind === 'scratch' ? 2 : 1, emission.text);
      for (const [index, value] of values.entries()) {
        const gold = expected.get(`${kind}:${index}`)!;
        assert.equal(gold.raw, kind === 'scratch' ? BigInt.asUintN(64, value + 1n) : value,
          'Trusted native register capture must match the source-backed register write/preservation');
        const inputs = new Map(formals.map((formal, ordinal) => [formal.statement_id,
          kind === 'scratch' && ordinal === 0 ? value : inputFp]));
        const entry = new Map([['arm64:x0', { bits: value, known: mask }]]);
        const observed = execute(emission, inputs, new Map(), 0n, entry, new Map(), new Map(), acknowledgeRequirements(emission));
        assert.equal(observed.exit, 'machine_return');
        assert.deepEqual(observed.values, [gold.primary], 'FP primary stays scalar, not a guessed aggregate');
        const gp = observed.registers.get('arm64:x0');
        assert.ok(gp); assert.equal(gp.known & mask, mask); assert.equal(gp.bits & mask, gold.raw);
        const vector = observed.registers.get('arm64:v0');
        assert.ok(vector); assert.equal((vector.known >> 64n) & mask, mask);
        assert.equal((vector.bits >> 64n) & mask, 0n, 'Architectural upper-root clearing remains observable');
        observations.push({ emitter, kind, index, values: observed.values, gp, vector, trusted: gold });
        outcomes++;
      }
    }
  console.log(JSON.stringify({ outcomes, trusted_native: expected.size, dialects: 2, evidence, observations },
    (_, value) => typeof value === 'bigint' ? String(value) : value));
} finally {
  await session.close();
  await rm(root, { recursive: true, force: true });
}
