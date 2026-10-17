#!/usr/bin/env node
/** Deterministic public/source smoke. Only the separately compiled trusted
 * source oracle executes natively; the analyzed image is never executed. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { openBinary } from '../../src/api/index.js';
import type { WireEmission } from '../../src/core/index.js';
import { requirementSchema } from '../../src/core/inference.js';
import {
  acknowledgeRequirements,
  emittedFormals,
  execute,
  type RequirementAcknowledgments,
  type SourceCallOracle,
} from '../../test/emitters/c/support.js';
import { checkKnownUnsupportedAfterCall } from '../../test/emitters/c/uncertainty-fixture.js';

const root = resolve(process.argv[2] ?? `/tmp/open-decomp-localized-uncertainty-${Date.now()}`);
await mkdir(root, { recursive: true });
const source = resolve('scripts/bench/localized-uncertainty.c');
const oracle = join(root, 'trusted-oracle'),
  binary = join(root, 'analyzed-only');
function command(program: string, args: string[]): string {
  const result = spawnSync(program, args, { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}
const flags = ['-target', 'arm64-apple-macos13.0', '-O1', '-ffp-contract=off'];
command('/usr/bin/clang', [...flags, '-DUNCERTAINTY_ORACLE', source, '-o', oracle]);
command('/usr/bin/clang', [...flags, source, '-o', binary]);
const expectedText = command(oracle, []);
const expected = new Map(
  expectedText
    .trim()
    .split('\n')
    .map((line) => {
      const [name, value, memory] = line.split(' ');
      return [name!, { value: BigInt(`0x${value}`), memory: BigInt(`0x${memory}`) }] as const;
    }),
);
await writeFile(join(root, 'trusted-oracle.txt'), expectedText);
const pointer = 0x2000n,
  stack = 0x9000n;
const fp = new DataView(new ArrayBuffer(8));
function bits(value: number): bigint {
  fp.setFloat64(0, value, true);
  return fp.getBigUint64(0, true);
}
function memory(): Map<bigint, number> {
  const result = new Map<bigint, number>();
  for (let offset = 0n; offset < 8n; offset++) result.set(pointer + offset, 0xa5);
  for (let offset = -1024n; offset < 128n; offset++) result.set(stack + offset, 0x5a);
  return result;
}
function word(bytes: ReadonlyMap<bigint, number>): bigint {
  let result = 0n;
  for (let offset = 0n; offset < 8n; offset++)
    result |= BigInt(bytes.get(pointer + offset)!) << (8n * offset);
  return result;
}
function inputs(emission: WireEmission, values: readonly bigint[]): Map<string, bigint> {
  let index = 0;
  const result = new Map(
    emittedFormals(emission).map((formal) => [
      formal.statement_id,
      formal.name === 'entry_sp' ? stack : values[index++]!,
    ]),
  );
  assert.equal(
    index,
    values.length,
    'All actual source formals are supplied, with no invented arity',
  );
  return result;
}
function run(
  emission: WireEmission,
  args: readonly bigint[],
  acknowledgments: RequirementAcknowledgments = [],
  calls: ReadonlyMap<string, SourceCallOracle> = new Map(),
  bytes = memory(),
) {
  return execute(
    emission,
    inputs(emission, args),
    bytes,
    0n,
    new Map(),
    new Map([['non-argument entry register', 0n]]),
    calls,
    acknowledgments,
  );
}
const emissions: { name: string; emission: WireEmission }[] = [];
let observations = checkKnownUnsupportedAfterCall();
// These are independent helper-grammar counterexamples, not analyzed target
// execution. An explicit known-false predicate must win over acknowledgment.
for (const text of [
  'uint64_t fn() { if (requirement_predicate("r", "s", "e", 0x0, 0x1)) { return 0x1; } else { return 0x2; } }',
  [
    'def fn():',
    '    if requirement_predicate("r", "s", "e", 0x0, 0x1):',
    '        return 0x1',
    '    else:',
    '        return 0x2',
    '',
  ].join('\n'),
]) {
  const observed = execute(
    { text, ids: [], mappings: [] },
    new Map(),
    new Map(),
    0n,
    new Map(),
    new Map(),
    new Map(),
    [{ requirement_id: 'r', site_id: 's', state_epoch: 'e' }],
  );
  assert.deepEqual(observed.values, [2n]);
  observations++;
}
const session = await openBinary(binary, { cachePath: join(root, 'cache') });
try {
  for (const emitter of ['c-like', 'python-like'] as const) {
    const get = async (name: string): Promise<WireEmission> => {
      const result = await session.decompile({ name: `_uncertainty_${name}` }, { emitter });
      assert.ok('data' in result && result.data.delivery === 'inline', JSON.stringify(result));
      const emission = result.data.emission;
      for (const requirement of emission.requirements ?? []) {
        requirementSchema.parse(requirement);
        for (const span of requirement.output_spans) assert.ok(span.end <= emission.text.length);
        for (const span of requirement.output_spans)
          assert.ok(
            emission.mappings.some(
              (mapping) => mapping.start === span.start && mapping.end === span.end,
            ),
            'Every requirement span resolves to an exact original mapping',
          );
        // Sites and mappings cite the same emission ids table, so refs compare exactly.
        for (const site of requirement.sites) {
          assert.ok(
            emission.mappings.some((mapping) => mapping.semantic_refs[0] === site.subject_refs[0]),
            'Every site anchors an actual emitted original statement/control',
          );
          for (const instruction of site.instruction_refs)
            assert.ok(
              emission.mappings.some((mapping) => mapping.instruction_refs.includes(instruction)),
              'Every affected machine instruction remains accessible in original mappings',
            );
        }
      }
      emissions.push({ name, emission });
      return emission;
    };
    const mixed = await get('mixed');
    const known = run(mixed, [pointer, 7n, 0n]);
    assert.equal(known.exit, 'machine_return');
    assert.deepEqual(known.values, [expected.get('mixed')!.value]);
    assert.equal(word(known.memory), expected.get('mixed')!.memory);
    assert.deepEqual(known.events, ['store']);
    observations++;
    const unknown = run(mixed, [pointer, 7n, 1n]);
    assert.equal(unknown.exit, 'unknown');
    assert.equal(word(unknown.memory), 10n);
    assert.deepEqual(unknown.events, ['store', 'unknown']);
    assert.ok(
      mixed.requirements?.some(
        (item) => item.kind === 'unresolved' && item.instruction_refs.length > 0,
      ),
    );
    observations++;

    const arithmetic = await get('fp');
    const requirements = arithmetic.requirements!.filter((item) => item.kind === 'fp_environment');
    assert.equal(requirements.length, 1, 'Repeated FP guards share one function-level description');
    const guards = requirements[0]!.sites.filter((site) => site.predicate_value_id !== undefined);
    assert.ok(guards.length >= 2, 'Both original FP guards remain explicit');
    const unacknowledged = run(arithmetic, [pointer, bits(4), bits(3)]);
    assert.equal(unacknowledged.exit, 'unknown');
    assert.equal(word(unacknowledged.memory), 17n);
    assert.deepEqual(unacknowledged.events, ['store']);
    observations++;
    const supported = run(
      arithmetic,
      [pointer, bits(4), bits(3)],
      acknowledgeRequirements(arithmetic),
    );
    assert.equal(supported.exit, 'machine_return');
    assert.deepEqual(supported.values, [expected.get('fp')!.value]);
    assert.equal(word(supported.memory), expected.get('fp')!.memory);
    assert.deepEqual(supported.events, ['store', 'store']);
    observations++;
    const mismatched = acknowledgeRequirements(arithmetic).map((ack) => ({
      ...ack,
      state_epoch: `${ack.state_epoch}:wrong`,
    }));
    assert.equal(run(arithmetic, [pointer, bits(4), bits(3)], mismatched).exit, 'unknown');
    observations++;

    const callEpoch = await get('call_epoch');
    const callGuards = callEpoch
      .requirements!.filter((item) => item.kind === 'fp_environment')
      .flatMap((item) => item.sites.filter((site) => site.predicate_value_id !== undefined));
    assert.ok(callGuards.length >= 2);
    const callSites = callEpoch.inferences?.filter((item) => item.details.kind === 'call') ?? [];
    assert.ok(callSites.length > 0, 'Original callback boundary remains explained');
    let callbackMemory = memory();
    const callback: SourceCallOracle = (_arguments, context) => {
      assert.equal(
        context.arguments_complete,
        false,
        'Observed empty prefix is not established zero arity',
      );
      assert.equal(
        word(callbackMemory),
        31n,
        'The pre-call store must precede the actual callback',
      );
      return [];
    };
    const calls = new Map<string, SourceCallOracle>([['_uncertainty_callback', callback]]);
    const allAck = acknowledgeRequirements(callEpoch);
    const firstOnly = allAck.slice(0, 1);
    assert.notEqual(
      firstOnly[0]!.state_epoch,
      allAck.at(-1)!.state_epoch,
      'An unknown call creates a distinct FP state epoch',
    );
    const afterCall = run(callEpoch, [pointer, bits(4), bits(3)], firstOnly, calls, callbackMemory);
    assert.equal(afterCall.exit, 'unknown');
    assert.equal(word(afterCall.memory), 37n);
    assert.equal(afterCall.events.filter((event) => event === 'call').length, 1);
    observations++;
    callbackMemory = memory();
    const trustedCall = run(callEpoch, [pointer, bits(4), bits(3)], allAck, calls, callbackMemory);
    assert.equal(trustedCall.exit, 'machine_return');
    assert.deepEqual(trustedCall.values, [expected.get('call')!.value]);
    assert.equal(word(trustedCall.memory), expected.get('call')!.memory);
    observations++;

    const stateChange = await get('state_change');
    // The opaque environment write clobbers the later FP inputs; only the
    // observed pointer prefix is projected, not a fabricated complete arity.
    const changed = run(stateChange, [pointer], acknowledgeRequirements(stateChange));
    assert.equal(
      changed.exit,
      'unknown',
      'Acknowledgment cannot erase an unsupported environment-changing effect',
    );
    assert.equal(word(changed.memory), 41n);
    assert.deepEqual(changed.events, ['store', 'unknown']);
    observations++;
  }
} finally {
  await session.close();
}
const x86Binary = join(root, 'analyzed-only-x86.so');
command('/usr/bin/clang', [
  '-target',
  'x86_64-unknown-linux-gnu',
  '-O1',
  '-ffp-contract=off',
  '-ffreestanding',
  '-fuse-ld=lld',
  '-nostdlib',
  '-shared',
  resolve('scripts/bench/localized-uncertainty-x86.c'),
  '-o',
  x86Binary,
]);
const x86Session = await openBinary(x86Binary, { cachePath: join(root, 'x86-cache') });
try {
  for (const emitter of ['c-like', 'python-like'] as const) {
    const result = await x86Session.decompile({ name: 'uncertainty_x86_fp' }, { emitter });
    assert.ok('data' in result && result.data.delivery === 'inline', JSON.stringify(result));
    const emission = result.data.emission;
    const requirements = emission.requirements!.filter((item) => item.kind === 'fp_environment');
    assert.equal(requirements.length, 1);
    for (const requirement of requirements) requirementSchema.parse(requirement);
    const guards = requirements[0]!.sites.filter((site) => site.predicate_value_id !== undefined);
    assert.ok(guards.length >= 2);
    assert.ok(
      guards.every((site) => site.supported_predicate_value === false),
      'x86 tests unsupported state: acknowledgment must select false, not ARM true',
    );
    const args = [pointer, bits(4), bits(3)];
    const unacknowledged = run(emission, args);
    assert.equal(unacknowledged.exit, 'unknown');
    assert.equal(word(unacknowledged.memory), 17n);
    observations++;
    const supported = run(emission, args, acknowledgeRequirements(emission));
    assert.equal(supported.exit, 'machine_return');
    assert.deepEqual(supported.values, [expected.get('fp')!.value]);
    assert.equal(word(supported.memory), 23n);
    observations++;
    const unsupported = execute(
      emission,
      inputs(emission, args),
      memory(),
      0n,
      new Map(),
      new Map([['MXCSR environment', 0n]]),
      new Map(),
      acknowledgeRequirements(emission),
    );
    assert.equal(
      unsupported.exit,
      'unknown_exit',
      'Known unsupported MXCSR must win over matching acknowledgment',
    );
    assert.equal(word(unsupported.memory), 17n);
    observations++;
    emissions.push({ name: 'x86_fp', emission });
  }
} finally {
  await x86Session.close();
}
const evidence = {
  scope: 'Trusted source oracle and actual public source emissions; no analyzed-target execution',
  dialects: ['c-like', 'python-like'],
  architectures: ['arm64', 'x86_64'],
  observations,
  facts: [
    'Mixed known return/memory remains normal beside an unsupported residual site',
    'Unacknowledged FP state stays unknown after the original earlier store',
    'Repeated guard sites share one requirement description without sharing predicates',
    'Acknowledgments match requirement, site and exact SSA epoch',
    'Unknown callback preserves its boundary/order and invalidates earlier epoch acknowledgment',
    'An environment-changing opaque effect remains ordered and unknown even when every later FP guard is acknowledged',
    'x86 bad-state guard orientation stays false-for-supported and known unsupported MXCSR cannot be acknowledged away',
  ],
  limitations: [
    'No claim for exceptional FP environments, status registers, arbitrary unknown effects or whole-function semantic coverage',
    'No repository test suite, build, lint or formatter was run',
  ],
  emissions,
};
await writeFile(join(root, 'evidence.json'), JSON.stringify(evidence, null, 2) + '\n');
console.log(JSON.stringify({ root, observations, dialects: evidence.dialects }));
