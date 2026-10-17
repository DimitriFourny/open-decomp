import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { openBinary } from '../../../src/api/index.js';
import { execute, emittedFormals, type SourceCallOracle } from '../../emitters/c/support.js';

// Focused actual-runtime acceptance, deliberately not a repository test runner.
// Execute only the separately compiled trusted oracle, never the analyzed image.
const root = await mkdtemp(join(tmpdir(), 'native-context-oracle-'));
const retain = process.env.NATIVE_CONTEXT_ORACLE_RETAIN === '1';
const source = resolve('test/service/analysis/native-context-source.c');
const analyzed = join(root, 'analyzed'), trusted = join(root, 'trusted');
const flags = ['-target', 'arm64-apple-macos13.0', '-O1', '-g0', '-fno-builtin', '-fno-optimize-sibling-calls'];
for (const [binary, definitions] of [[analyzed, []], [trusted, ['-DCONTEXT_TRUSTED_ORACLE']]] as const) {
  const result = spawnSync('/usr/bin/clang', [...flags, ...definitions, source, '-o', binary], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
}
const native = spawnSync(trusted, [], { encoding: 'utf8' });
assert.equal(native.status, 0, native.stderr);
const expected = new Map(native.stdout.trim().split('\n').map((line) => {
  const [name, index, bits] = line.split(' '); return [`${name}:${index}`, BigInt(`0x${bits}`)] as const;
}));
assert.equal(expected.size, 48);
const session = await openBinary(analyzed, { cachePath: join(root, 'cache') });
try {
  const values = [0n, 1n, 0x7fffffffn, 0x80000000n, 0xffffffffffffffffn, 0x1234567887654321n];
  const addresses = new Map<string, bigint>();
  const found = await session.findFunctions({ query: { text: '_context_', match: 'contains', case_sensitive: true }, page: { limit: 100 } });
  assert.ok('data' in found);
  for (const fn of found.data.items)
    if (fn.original_name) addresses.set(fn.original_name, BigInt(fn.entry.value));
  const u64 = (bits: bigint) => BigInt.asUintN(64, bits);
  let outcomes = 0;
  const evidence = new Map<string, unknown>();
  const observations: unknown[] = [];
  for (const emitter of ['c-like', 'python-like'] as const)
    for (const [name, symbol] of [['two', 'two'], ['recursive', 'recursive_caller'], ['same', 'same'],
      ['conflict', 'conflict_caller'], ['words', 'words_caller'], ['words_direct', 'words'], ['scalar', 'increment']] as const) {
      const result = await session.decompile({ name: `_context_${symbol}` }, { emitter });
      assert.ok('data' in result && result.data.delivery === 'inline');
      const emission = result.data.emission;
      assert.ok(emission.inferences, 'Native context recovery must publish canonical inference metadata');
      const calls = emission.inferences.filter((inference) => inference.details.kind === 'call');
      if (name === 'two') {
        assert.equal(calls.length, 2);
        const contexts = calls.map((inference) => inference.details.kind === 'call' ? inference.details.context_assumptions : undefined);
        assert.ok(contexts.every((assumptions) => assumptions !== undefined), 'Both uses must publish their own proven input context');
        const modes = contexts.map((assumptions) => assumptions!.constants.find((item) => item.register.root === 'arm64:x0')?.bits);
        assert.deepEqual(modes, ['0', '1']);
        assert.ok(calls.every((inference) => inference.details.kind === 'call' && !inference.details.arity_complete));
        const proofs = result.evidence.filter((proof) => proof.origin.kind === 'analysis' && proof.origin.analyzer === 'native-context');
        assert.ok(proofs.some((proof) => proof.claim.includes(`@${addresses.get('_context_increment')}`)));
        assert.ok(proofs.some((proof) => proof.claim.includes(`@${addresses.get('_context_double')}`)));
      }
      if (name === 'recursive')
        assert.ok(result.diagnostics.some((diagnostic) => /context limit.*generic/.test(diagnostic.message)));
      if (name === 'same' || name === 'conflict')
        assert.ok(calls.some((inference) => inference.details.kind === 'call' && inference.details.context_assumptions?.aliases.length),
          `${emitter} ${name}: ${JSON.stringify({ calls, diagnostics: result.diagnostics,
            context: result.evidence.filter((proof) => proof.origin.kind === 'analysis' && proof.origin.analyzer === 'native-context') })}`);
      if (name === 'words')
        assert.ok(calls.some((inference) => inference.details.kind === 'call' &&
          inference.details.result_width_bits.length === 2 && inference.details.result_width_bits.every((width) => width === 64)));
      if (name === 'words_direct') {
        assert.equal(result.state, 'partial');
        assert.ok(result.diagnostics.some((diagnostic) => diagnostic.message.startsWith('The source return list is unresolved')));
        const unresolved = emission.requirements?.find((requirement) => requirement.kind === 'unresolved' &&
          requirement.explanation.startsWith('The source return list is incomplete'));
        assert.ok(unresolved && unresolved.status === 'unresolved');
        assert.ok(unresolved.explanation.includes('arm64:x1[0:64]'));
        assert.ok(unresolved.instruction_ids.length && unresolved.ranges.length && unresolved.output_spans.length);
        assert.ok(unresolved.sites.every((site) => emission.mappings.some((mapping) =>
          mapping.statement_id === site.subject_ids[0])), 'Uncertainty must attach to the original return boundary');
      }
      if (name === 'scalar')
        assert.ok(!result.diagnostics.some((diagnostic) => diagnostic.message.startsWith('The source return list is unresolved')));
      if (name === 'two' || name === 'same' || name === 'conflict') {
        const fields = emission.inferences.filter((inference) => inference.details.kind === 'field' &&
          inference.explanation.startsWith('Callee-observed'));
        assert.ok(fields.some((inference) => inference.details.kind === 'field' && inference.details.offset === '0'));
        assert.ok(fields.every((inference) => inference.details.kind === 'field' && inference.details.bounds === 'unknown'));
        if (name !== 'conflict')
          assert.ok(fields.some((inference) => inference.details.kind === 'field' && inference.details.offset === '8'));
        else {
          assert.ok(fields.some((inference) => inference.details.kind === 'field' && inference.details.width_bits === 8));
          assert.ok(fields.some((inference) => inference.details.kind === 'field' && inference.details.width_bits === 64));
          assert.ok(emission.inferences.some((inference) => inference.details.kind === 'conflict'));
        }
      }
      evidence.set(`${emitter}:${name}`, { diagnostics: result.diagnostics, text: emission.text,
        inferences: emission.inferences, requirements: emission.requirements });
      for (const [index, value] of values.entries()) {
        const stack = 0x9000n, record = 0xa000n, memory = new Map<bigint, number>();
        for (let offset = -512n; offset < 64n; offset++) memory.set(stack + offset, 0xa5);
        for (const [word, bits] of [value, u64(value + 17n)].entries())
          for (let byte = 0; byte < 8; byte++) memory.set(record + BigInt(word * 8 + byte), Number((bits >> BigInt(byte * 8)) & 255n));
        const read = (address: bigint) => {
          let bits = 0n; for (let byte = 0; byte < 8; byte++) bits |= BigInt(memory.get(address + BigInt(byte))!) << BigInt(byte * 8); return bits;
        };
        const oracles = new Map<string, SourceCallOracle>();
        const add = (symbol: string, oracle: SourceCallOracle) => {
          oracles.set(symbol, oracle); const address = addresses.get(symbol); if (address !== undefined) oracles.set(`0x${address.toString(16)}`, oracle);
        };
        add('_context_choose', (args, context) => {
          assert.equal(context.arguments_complete, false);
          assert.equal(args.length, 3, 'Constant-assumed mode and callback must survive specialization');
          const input = read(args[1]! + (args[0] === 0n ? 0n : 8n));
          if (args[2] === addresses.get('_context_increment')) return u64(input + 7n);
          assert.equal(args[2], addresses.get('_context_double'));
          return u64(input * 2n);
        });
        add('_context_recursive', (args) => { assert.equal(args.length, 2); return u64(args[1]! + args[0]! * 6n + 3n); });
        add('_context_alias', (args) => { assert.equal(args.length, 2); assert.equal(args[0], args[1]); return u64(read(args[0]!) + read(args[1]! + 8n)); });
        add('_context_conflict', (args) => { assert.equal(args.length, 2); assert.equal(args[0], args[1]);
          return u64(read(args[0]!) + BigInt(memory.get(args[1]!)!)); });
        add('_context_words', (args) => { assert.equal(args.length, 1); return [u64(args[0]! + 11n), args[0]! ^ 0xfedcba9876543210n]; });
        const arguments_ = emittedFormals(emission), inputs = arguments_.filter((argument) => argument.name !== 'entry_sp');
        assert.equal(inputs.length, 1, `${emitter} ${name}\n${emission.text}`);
        const formals = new Map(arguments_.map((argument) => [argument.statement_id,
          argument.name === 'entry_sp' ? stack : name === 'two' || name === 'same' || name === 'conflict' ? record : value]));
        const observed = execute(emission, formals, memory, 0n, new Map(), new Map([['non-argument entry register', 0n]]), oracles);
        assert.equal(observed.exit, 'machine_return', `${emitter} ${name} ${index}`);
        assert.deepEqual(observed.values, [expected.get(`${name === 'words_direct' ? 'word_first' : name}:${index}`)!],
          `${emitter} ${name} ${index}\n${emission.text}\n${JSON.stringify(result.diagnostics)}`);
        if (name === 'words_direct') {
          const secondary = observed.registers.get('arm64:x1');
          assert.ok(secondary);
          assert.equal(secondary.known, 0xffffffffffffffffn, 'Both observed machine words must remain available');
          assert.equal(secondary.bits, expected.get(`word_second:${index}`));
        }
        if (name === 'scalar') assert.ok(!observed.registers.has('arm64:x1'), 'Unchanged storage is not a new result channel');
        if (name === 'recursive')
          assert.equal(observed.registers.get('arm64:x1')?.known, 0n, 'Unclassified call clobbers must remain unknown, not forced values');
        observations.push({ emitter, name, index, values: observed.values, registers: [...observed.registers] });
        outcomes++;
      }
    }
  console.log(JSON.stringify({ outcomes, trusted_native: expected.size, dialects: 2,
    analyzed_image: retain ? analyzed : null, evidence: [...evidence], observations }, (_, value) =>
    typeof value === 'bigint' ? value.toString() : value));
} finally {
  await session.close();
  if (!retain) await rm(root, { recursive: true, force: true });
}
