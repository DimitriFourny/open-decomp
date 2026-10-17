import assert from 'node:assert/strict';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { z } from 'zod';
import { contentHash, newIdentity, type ToolResult } from '../../src/core/index.js';
import { analysisReuseScope } from '../../src/project/cache/dependencies.js';
import { QueryService } from '../../src/service/queries/index.js';
import {
  canonicalIncrementalComputation,
  parseIncrementalWirePayload,
  type IncrementalWirePayload,
} from './incremental-equivalence.js';
import {
  prepareIncrementalOutputOracle,
  type IncrementalOracleKind,
} from './incremental-output-oracles.js';

// Driven by incremental-controlled.py. No production force-compute mechanism.
// The Python owner clones CLOSED snapshots and logs the exact benchmark-only
// cache-index deletion; this driver only makes ordinary public service requests.
const flags = new Map<string, string>();
for (let index = 2; index < process.argv.length; index += 2) {
  const name = process.argv[index],
    value = process.argv[index + 1];
  assert.ok(
    name &&
      value &&
      [
        '--mode',
        '--output',
        '--experiment',
        '--sqlite',
        '--case',
        '--project',
        '--spec',
        '--role',
        '--lifecycle',
        '--left',
        '--right',
      ].includes(name),
  );
  flags.set(name, value);
}
const mode = z.enum(['plan', 'prepare', 'measure', 'compare']).parse(flags.get('--mode'));
const output = resolve(flags.get('--output')!);
assert.ok(flags.has('--output'));
await mkdir(output, { recursive: false });
const experiment = await realpath(resolve(flags.get('--experiment')!));
const owner = z
  .strictObject({ schema: z.literal('open-decomp/incremental-controlled-owner/1') })
  .parse(JSON.parse(await readFile(join(experiment, 'owner.json'), 'utf8')));
assert.ok(owner);
assert.ok(
  output.startsWith(experiment + sep),
  'All benchmark evidence must be inside its newly owned experiment',
);
const sqlite = flags.get('--sqlite');
assert.ok(sqlite, 'Keep the real SQLite cases alongside every historical/small case');
interface CaseSpec {
  kind: IncrementalOracleKind;
  binary: string;
  a: string;
  b: string;
  complexity: string;
}
const cases: readonly CaseSpec[] = [
  {
    kind: 'maximum',
    binary: resolve('fixtures/bin/macho-arm64-symbols'),
    a: '_fixture_arithmetic',
    b: '_fixture_maximum',
    complexity: 'historical two-argument signed maximum leaf',
  },
  {
    kind: 'sum-loop',
    binary: resolve('fixtures/bin/macho-arm64-symbols'),
    a: '_fixture_arithmetic',
    b: '_fixture_loop',
    complexity:
      'source-valid pointer/count loop with loads, zero trip, wraparound and loop-carried state',
  },
  {
    kind: 'threadsafe',
    binary: resolve(sqlite),
    a: '_sqlite3_libversion_number',
    b: '_sqlite3_threadsafe',
    complexity: 'historical real SQLite constant-return leaf',
  },
  {
    kind: 'strnicmp',
    binary: resolve(sqlite),
    a: '_sqlite3_threadsafe',
    b: '_sqlite3_strnicmp',
    complexity:
      'real SQLite multi-exit lookup-table loop: NULLs, bounded comparisons, mismatch/equality and signed count',
  },
];
const specSchema = z.strictObject({
  schema: z.literal('open-decomp/incremental-controlled-spec/1'),
  experiment: z.string(),
  kind: z.enum(['maximum', 'sum-loop', 'threadsafe', 'strnicmp']),
  binary: z.string(),
  binary_sha256: z.string(),
  a: z.string(),
  b: z.string(),
  a_id: z.string(),
  b_id: z.string(),
  image_id: z.string(),
  project_id: z.string(),
  revision: z.number(),
  baseline_revision: z.number(),
  baseline_artifact_id: z.string(),
  baseline_payload: z.string(),
  baseline_payload_sha256: z.string(),
  candidate_scope: z.string(),
  original_request: z.json(),
  oracle_cases: z.number(),
  oracle_provenance: z.string(),
});
function emit(value: object): void {
  console.log(JSON.stringify(value));
}
function inlineData(payload: IncrementalWirePayload) {
  assert.ok('data' in payload.result && payload.result.data.delivery === 'inline');
  return payload.result.data;
}
if (mode === 'plan') {
  const plan = [];
  for (const entry of cases) {
    const oracle = await prepareIncrementalOutputOracle(entry.binary, entry.kind);
    plan.push({
      ...entry,
      binary_sha256: oracle.binary_sha256,
      oracle_cases: oracle.cases,
      oracle_provenance: oracle.provenance,
    });
  }
  await writeFile(
    join(output, 'plan.json'),
    JSON.stringify(
      {
        schema: 'open-decomp/incremental-controlled-plan/1',
        cases: plan,
        treatment:
          'Offline exact-B analysis_reuse index unavailability in owned closed clone only; ordinary production requests unchanged',
        histories:
          'Byte-identical closed seed copies; identical fresh-worker public warmups; balanced serialized control/reuse order; separate matched post-analysis reopen copies',
        target_executed: false,
      },
      null,
      2,
    ),
  );
  emit({ kind: 'plan', path: join(output, 'plan.json'), cases: plan.map((entry) => entry.kind) });
} else if (mode === 'compare') {
  const leftPath = flags.get('--left')!,
    rightPath = flags.get('--right')!;
  assert.ok(
    resolve(leftPath).startsWith(experiment + sep) &&
      resolve(rightPath).startsWith(experiment + sep),
  );
  const left = parseIncrementalWirePayload(JSON.parse(await readFile(leftPath, 'utf8')));
  const right = parseIncrementalWirePayload(JSON.parse(await readFile(rightPath, 'utf8')));
  assert.deepEqual(
    left.identity,
    right.identity,
    'Matched histories require exact same current revision, target, versions, options, capacities and function',
  );
  const normalizedLeft = canonicalIncrementalComputation(left),
    normalizedRight = canonicalIncrementalComputation(right);
  await writeFile(join(output, 'left-canonical.json'), JSON.stringify(normalizedLeft, null, 2));
  await writeFile(join(output, 'right-canonical.json'), JSON.stringify(normalizedRight, null, 2));
  const equality = {
    left: leftPath,
    right: rightPath,
    identity_equal: true,
    raw_payload_equal:
      contentHash(await readFile(leftPath)) === contentHash(await readFile(rightPath)),
    equivalence:
      'All result/catalog fields checked, modulo declared proof-ID/original-proof-revision alpha-equivalence. Raw evidence/proof revisions retained unchanged.',
    left_proof_revisions: [...new Set(left.catalog.evidence.map((proof) => proof.revision))].sort(),
    right_proof_revisions: [
      ...new Set(right.catalog.evidence.map((proof) => proof.revision)),
    ].sort(),
  };
  await writeFile(join(output, 'comparison.json'), JSON.stringify(equality, null, 2));
  assert.deepEqual(
    normalizedLeft,
    normalizedRight,
    'Full semantic output/catalog equivalence failed; do not omit this case or erase unknowns/diagnostics',
  );
  emit({ kind: 'comparison', ...equality, full_semantic_equivalence: true });
} else {
  const entry = cases.find((candidate) => candidate.kind === flags.get('--case'));
  assert.ok(entry);
  const oracle = await prepareIncrementalOutputOracle(entry.binary, entry.kind);
  const sourceRuntime = import.meta.url.endsWith('.ts');
  process.env['OPEN_DECOMP_INCREMENTAL_CONTROLLED_METRICS'] = join(output, 'worker.jsonl');
  const project = mode === 'prepare' ? join(output, 'project') : resolve(flags.get('--project')!);
  assert.ok(
    project.startsWith(experiment + sep),
    'Never open a real user project for a cache-control experiment',
  );
  const service = await QueryService.create({
    authorized_roots: [experiment, await realpath(dirname(entry.binary))],
    max_workers: 1,
    entry_point: new URL(
      `./incremental-controlled-worker.${sourceRuntime ? 'ts' : 'js'}`,
      import.meta.url,
    ),
    exec_argv: sourceRuntime ? ['--import', 'tsx'] : [],
  });
  const requestHistory: object[] = [];
  let project_id = '',
    revision = 0,
    image_id = '';
  async function decompile(function_id: string, label: string) {
    const request = {
      project_id,
      revision,
      function_id,
      wait: true,
      delivery: 'artifact' as const,
    };
    requestHistory.push({ operation: 'function_decompile', label, request });
    const before = process.memoryUsage(),
      start = performance.now();
    const result: ToolResult<'function_decompile'> = await service.execute(
      'function_decompile',
      request,
    );
    const response_ms = performance.now() - start;
    assert.ok('data' in result && result.data.delivery === 'artifact', JSON.stringify(result));
    const descriptor = result.data;
    const artifact = result.artifacts.find((handle) => handle.id === descriptor.artifact_id);
    assert.ok(artifact);
    const chunks: Buffer[] = [];
    let offset = '0x0',
      received = 0;
    for (;;) {
      const readRequest = { project_id, revision, artifact_id: artifact.id, offset, length: 65536 };
      requestHistory.push({ operation: 'artifact_read', label, request: readRequest });
      const page = await service.readArtifact(readRequest);
      const bytes = Buffer.from(page.bytes_hex, 'hex');
      received += bytes.length;
      assert.ok(received <= 16 * 1024 * 1024);
      chunks.push(bytes);
      if (page.next_offset === null) break;
      offset = page.next_offset;
    }
    const bytes = Buffer.concat(chunks);
    assert.equal(
      contentHash(bytes),
      artifact.sha256,
      'Consumer verifies the exact published artifact bytes',
    );
    const payload = parseIncrementalWirePayload(JSON.parse(bytes.toString('utf8')));
    assert.equal(payload.result.revision, revision);
    assert.equal(artifact.revision, revision);
    const delivery_ms = performance.now() - start;
    return {
      result,
      payload,
      artifact,
      response_ms,
      delivery_ms,
      parent_before: before,
      parent_after: process.memoryUsage(),
      bytes: bytes.length,
      raw: bytes,
      payload_file: join(output, `${label}-payload.json`),
    };
  }
  async function note(value: string) {
    const request = {
      project_id,
      expected_revision: revision,
      author: 'incremental-matched-history-oracle',
      origin: 'user' as const,
      edits: [
        {
          operation: 'set' as const,
          id: newIdentity('annotation'),
          entity_id: activeA,
          value: { kind: 'note' as const, value },
          status: 'asserted' as const,
          evidence_ids: [],
        },
      ],
    };
    requestHistory.push({ operation: 'annotations_apply', request });
    const result = await service.execute('annotations_apply', request);
    assert.equal(result.state, 'complete', JSON.stringify(result));
    assert.ok(result.revision !== null && result.revision > revision);
    revision = result.revision;
  }
  let activeA = '';
  try {
    const openRequest =
      mode === 'prepare'
        ? {
            source: { kind: 'import' as const, input_path: entry.binary, project_path: project },
            wait: true,
          }
        : { source: { kind: 'resume' as const, project_path: project }, wait: true };
    requestHistory.push({ operation: 'project_open', request: openRequest });
    const opened = await service.execute('project_open', openRequest);
    assert.ok(
      'data' in opened && opened.project_id && opened.revision && opened.data.image,
      JSON.stringify(opened),
    );
    project_id = opened.project_id;
    revision = opened.revision;
    image_id = opened.data.image.id;
    async function find(name: string) {
      const request = {
        project_id,
        revision,
        image_id,
        query: { text: name, match: 'exact' as const, case_sensitive: true },
        page: { limit: 20 },
      };
      requestHistory.push({ operation: 'functions_find', request });
      const result = await service.execute('functions_find', request);
      assert.ok('data' in result);
      assert.equal(
        result.data.items.length,
        1,
        `Do not replace or omit requested function ${name}`,
      );
      return result.data.items[0]!.id;
    }
    activeA = await find(entry.a);
    const b = await find(entry.b);
    if (mode === 'prepare') {
      const seedA = await decompile(activeA, 'seed-A');
      await writeFile(seedA.payload_file, seedA.raw);
      const baseline = await decompile(b, 'baseline-B');
      oracle.check(inlineData(baseline.payload).emission);
      await writeFile(baseline.payload_file, baseline.raw);
      assert.equal(baseline.result.data.cache, 'computed');
      const baseline_revision = revision;
      await note('Unrelated source review before the matched-history B request');
      const spec = {
        schema: 'open-decomp/incremental-controlled-spec/1' as const,
        experiment,
        kind: entry.kind,
        binary: entry.binary,
        binary_sha256: oracle.binary_sha256,
        a: entry.a,
        b: entry.b,
        a_id: activeA,
        b_id: b,
        image_id,
        project_id,
        revision,
        baseline_revision,
        baseline_artifact_id: baseline.artifact.id,
        baseline_payload: baseline.payload_file,
        baseline_payload_sha256: baseline.artifact.sha256,
        candidate_scope: analysisReuseScope(baseline.payload.identity),
        original_request: {
          options: baseline.payload.identity.options,
          budget: baseline.payload.identity.budget,
          target: baseline.payload.identity.target,
          versions: baseline.payload.identity.versions,
        },
        oracle_cases: oracle.cases,
        oracle_provenance: oracle.provenance,
      };
      await writeFile(join(output, 'spec.json'), JSON.stringify(specSchema.parse(spec), null, 2));
      emit({ kind: 'seed', case: entry.kind, project, spec: join(output, 'spec.json'), revision });
    } else {
      const spec = specSchema.parse(JSON.parse(await readFile(flags.get('--spec')!, 'utf8')));
      assert.equal(spec.experiment, experiment);
      assert.equal(spec.kind, entry.kind);
      assert.equal(spec.binary_sha256, oracle.binary_sha256);
      assert.equal(project_id, spec.project_id);
      assert.equal(revision, spec.revision);
      assert.equal(activeA, spec.a_id);
      assert.equal(b, spec.b_id);
      const role = z.enum(['control', 'reuse']).parse(flags.get('--role'));
      const lifecycle = z.enum(['first', 'reopen']).parse(flags.get('--lifecycle'));
      const warmup = await decompile(activeA, 'warmup-A');
      await writeFile(warmup.payload_file, warmup.raw);
      assert.equal(
        warmup.result.data.cache,
        'computed',
        'Both fresh matched workers take the same actual warmup compute path',
      );
      const phase = `${entry.kind}/${lifecycle}/${role}`;
      emit({
        kind: 'window',
        state: 'begin',
        phase,
        monotonic_ns: process.hrtime.bigint().toString(),
      });
      let measured;
      try {
        measured = await decompile(b, 'measured-B');
      } finally {
        emit({
          kind: 'window',
          state: 'end',
          phase,
          monotonic_ns: process.hrtime.bigint().toString(),
        });
      }
      await writeFile(measured.payload_file, measured.raw);
      const data = inlineData(measured.payload);
      oracle.check(data.emission);
      assert.equal(measured.result.data.cache, role === 'reuse' ? 'hit' : 'computed');
      assert.notEqual(measured.artifact.id, spec.baseline_artifact_id);
      assert.equal(measured.artifact.revision, spec.revision);
      const baselineBytes = await readFile(spec.baseline_payload);
      assert.equal(contentHash(baselineBytes), spec.baseline_payload_sha256);
      const baseline = parseIncrementalWirePayload(JSON.parse(baselineBytes.toString('utf8')));
      assert.equal(analysisReuseScope(measured.payload.identity), spec.candidate_scope);
      if (role === 'reuse')
        assert.deepEqual(
          data,
          inlineData(baseline),
          'Reuse must preserve full baseline data, not merely emitted text or a nonempty payload',
        );
      const report = {
        schema: 'open-decomp/incremental-controlled-run/1',
        case: entry.kind,
        role,
        lifecycle,
        phase,
        project,
        project_id,
        revision: spec.revision,
        function_id: b,
        oracle_cases: oracle.cases,
        oracle_provenance: oracle.provenance,
        identity: measured.payload.identity,
        baseline_artifact_id: spec.baseline_artifact_id,
        artifact: measured.artifact,
        response_ms: measured.response_ms,
        full_delivery_ms: measured.delivery_ms,
        parent_before: measured.parent_before,
        parent_after: measured.parent_after,
        full_artifact_bytes: measured.bytes,
        payload: measured.payload_file,
        warmup_payload: warmup.payload_file,
        warmup_payload_sha256: warmup.artifact.sha256,
        cache: measured.result.data.cache,
        state: measured.payload.result.state,
        proof_revisions: [
          ...new Set(measured.payload.catalog.evidence.map((proof) => proof.revision)),
        ].sort(),
        target_executed: false,
        forced_gc: false,
        history: requestHistory,
      };
      await writeFile(join(output, 'run.json'), JSON.stringify(report, null, 2));
      if (lifecycle === 'first') {
        await note('Unrelated source review after analysis, before the matched reopen request');
        await writeFile(
          join(output, 'post-spec.json'),
          JSON.stringify(
            {
              ...spec,
              revision,
              baseline_revision: measured.artifact.revision,
              baseline_artifact_id: measured.artifact.id,
              baseline_payload: measured.payload_file,
              baseline_payload_sha256: measured.artifact.sha256,
            },
            null,
            2,
          ),
        );
      }
      emit({ kind: 'run', case: entry.kind, role, lifecycle, report: join(output, 'run.json') });
    }
    requestHistory.push({ operation: 'project_close', request: { project_id, revision } });
    await service.execute('project_close', { project_id, revision });
  } finally {
    await service.close('cancel');
    await writeFile(join(output, 'request-history.json'), JSON.stringify(requestHistory, null, 2));
  }
}
