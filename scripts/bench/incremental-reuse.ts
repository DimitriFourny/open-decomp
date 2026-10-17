import assert from 'node:assert/strict';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { z } from 'zod';
import {
  newIdentity,
  entityIdentity,
  functionDecompileResultSchema,
  type AnnotationEdit,
  type ToolResult,
  type ResultMetadata,
  encodeAnnotationEdit,
  contentHash,
} from '../../src/core/index.js';
import { QueryService } from '../../src/service/queries/index.js';
import type { InlineDecompileData } from '../../src/project/cache/index.js';
import { emittedFormals, execute as executePseudocode } from '../../test/emitters/c/support.js';

// Source-runtime functional/measurement oracle, NOT a repository test runner.
// node --import tsx scripts/bench/incremental-reuse.ts --output /new/evidence-dir
//   [--sqlite /reviewed/public/sqlite3-arm64] [--iterations 3]
// Every binary is analyzed statically only. No comparator/heldout data is read.
const flags = new Map<string, string>();
for (let index = 2; index < process.argv.length; index += 2) {
  const key = process.argv[index],
    value = process.argv[index + 1];
  assert.ok(key && value && ['--output', '--sqlite', '--iterations'].includes(key));
  flags.set(key, value);
}
assert.ok(flags.has('--output'), 'Use a new retained output directory');
const output = resolve(flags.get('--output')!);
await mkdir(output, { recursive: false });
const root = await realpath(output);
const iterations = Number(flags.get('--iterations') ?? 3);
assert.ok(Number.isSafeInteger(iterations) && iterations >= 1 && iterations <= 30);
const measurements = join(root, 'worker.jsonl');
process.env['OPEN_DECOMP_INCREMENTAL_METRICS'] = measurements;
interface Sample {
  workload: string;
  iteration: number;
  label: string;
  elapsed_ms: number;
  cache: string;
  revision: number;
  artifact_id: string;
  scope: Pick<ResultMetadata, 'versions' | 'options' | 'budget' | 'coverage'>;
}
const samples: Sample[] = [];
const assertions: string[] = [];
const memorySchema = z.object({ rss: z.number(), heapUsed: z.number() });
const measurementSchema = z.object({
  operation: z.string(),
  job_id: z.string(),
  pid: z.number(),
  lifts: z.number(),
  image_reads: z.number(),
  image_validation_ms: z.number(),
  execute_ms: z.number(),
  before: memorySchema,
  after: memorySchema,
  lifetime_max_rss_kib: z.number(),
});
function distribution(values: readonly number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (fraction: number) => sorted[Math.floor((sorted.length - 1) * fraction)] ?? null;
  return {
    n: sorted.length,
    min: at(0),
    p25: at(0.25),
    median: at(0.5),
    p75: at(0.75),
    max: at(1),
  };
}
const inputs = [
  {
    name: 'checked-in-small-arm64',
    path: resolve('fixtures/bin/macho-arm64-symbols'),
    a: '_fixture_arithmetic',
    b: '_fixture_maximum',
    caller: '_fixture_direct',
  },
  ...(flags.has('--sqlite')
    ? [
        {
          name: 'public-sqlite-arm64',
          path: resolve(flags.get('--sqlite')!),
          a: '_sqlite3_libversion_number',
          b: '_sqlite3_threadsafe',
          caller: null,
        },
      ]
    : []),
];
const input_provenance = await Promise.all(
  inputs.map(async (input) => {
    const bytes = await readFile(input.path);
    return { ...input, bytes: bytes.length, sha256: contentHash(bytes) };
  }),
);

async function run(input: (typeof inputs)[number], iteration: number) {
  const project_path = join(root, `${input.name}-${iteration}`);
  const service = await QueryService.create({
    authorized_roots: [root, await realpath(dirname(input.path))],
    max_workers: 1,
    entry_point: new URL('./incremental-reuse-worker.ts', import.meta.url),
    exec_argv: ['--import', 'tsx'],
  });
  let project_id = '',
    revision = 0;
  try {
    const opened = await service.execute('project_open', {
      source: { kind: 'import', input_path: input.path, project_path },
      wait: true,
    });
    assert.ok(
      'data' in opened && opened.data.image && opened.project_id && opened.revision,
      JSON.stringify(opened),
    );
    project_id = opened.project_id;
    revision = opened.revision;
    const image_id = opened.data.image.id;
    const slice_id = opened.data.image.selected_slice_id;
    async function find(name: string) {
      const result = await service.execute('functions_find', {
        project_id,
        revision,
        image_id,
        query: { text: name, match: 'exact', case_sensitive: true },
        page: { limit: 20 },
      });
      assert.ok('data' in result, JSON.stringify(result));
      assert.equal(result.data.items.length, 1, `Missing exact public function ${name}`);
      return result.data.items[0]!;
    }
    const a = await find(input.a),
      b = await find(input.b),
      caller = input.caller ? await find(input.caller) : null;
    async function decompile(id: string, label: string) {
      const start = performance.now();
      const result = await service.execute('function_decompile', {
        project_id,
        revision,
        function_id: id,
        wait: true,
      });
      const elapsed_ms = performance.now() - start;
      assert.ok('data' in result, JSON.stringify(result));
      let full: ToolResult<'function_decompile'> = result;
      if (result.data.delivery === 'artifact') {
        const bytes: Buffer[] = [];
        let offset = '0x0';
        for (;;) {
          const page = await service.readArtifact({
            project_id,
            revision,
            artifact_id: result.artifacts[0]!.id,
            offset,
            length: 65536,
          });
          bytes.push(Buffer.from(page.bytes_hex, 'hex'));
          if (page.next_offset === null) break;
          offset = page.next_offset;
        }
        const payload: unknown = JSON.parse(Buffer.concat(bytes).toString('utf8'));
        assert.ok(payload && typeof payload === 'object' && 'result' in payload);
        full = functionDecompileResultSchema.parse(payload.result);
      }
      assert.ok('data' in full && full.data.delivery === 'inline');
      samples.push({
        workload: input.name,
        iteration,
        label,
        elapsed_ms,
        cache: result.data.cache,
        revision: result.revision!,
        artifact_id: result.artifacts[0]!.id,
        scope: {
          versions: result.versions,
          options: result.options,
          budget: result.budget,
          coverage: result.coverage,
        },
      });
      return { response: result, full, data: full.data };
    }
    async function annotate(edits: readonly AnnotationEdit[]) {
      const result = await service.execute('annotations_apply', {
        project_id,
        expected_revision: revision,
        author: 'incremental-public-oracle',
        origin: 'user',
        edits: edits.map(encodeAnnotationEdit),
      });
      assert.equal(result.state, 'complete', JSON.stringify(result));
      assert.ok(result.revision !== null && result.revision > revision);
      revision = result.revision;
    }
    function sourceOracle(data: InlineDecompileData) {
      const formals = emittedFormals(data.emission);
      if (input.caller === null) {
        // Reviewed public SQLite build uses SQLITE_THREADSAFE=1.
        assert.equal(formals.length, 0);
        const result = executePseudocode(data.emission);
        assert.equal(result.exit, 'machine_return');
        assert.deepEqual(result.values, [1n]);
      } else {
        // fixtures/source/corpus.c: signed int32 maximum(a,b).
        assert.equal(formals.length, 2);
        for (const [left, right] of [
          [0, 0],
          [1, 7],
          [-5, -3],
          [2147483647, -2147483648],
          [-2147483648, -2147483648],
        ] as const) {
          const inputs = new Map(
            formals.map((formal, index) => [
              formal.statement_id,
              BigInt.asUintN(32, BigInt(index === 0 ? left : right)),
            ]),
          );
          const result = executePseudocode(data.emission, inputs);
          assert.equal(result.exit, 'machine_return');
          assert.equal(result.values.length, 1);
          assert.equal(
            BigInt.asUintN(32, result.values[0]!),
            BigInt.asUintN(32, BigInt(Math.max(left, right))),
          );
        }
      }
    }
    const beforeA = await decompile(a.id, 'initial-A');
    const beforeB = await decompile(b.id, 'computed-B');
    sourceOracle(beforeB.data);
    const beforeCaller = caller ? await decompile(caller.id, 'initial-caller') : null;
    const name = newIdentity('annotation');
    await annotate([
      {
        operation: 'set',
        id: name,
        entity_id: a.id,
        value: { kind: 'name', value: 'incremental_reviewed_a' },
        status: 'asserted',
        evidence_ids: [],
      },
    ]);
    const reusedB = await decompile(b.id, 'reused-B');
    assert.equal(reusedB.response.data.cache, 'hit');
    assert.notEqual(reusedB.response.artifacts[0]!.id, beforeB.response.artifacts[0]!.id);
    assert.equal(reusedB.response.revision, revision);
    assert.deepEqual(
      { ...reusedB.data, cache: 'computed' },
      { ...beforeB.data, cache: 'computed' },
    );
    sourceOracle(reusedB.data);
    if (input.caller && iteration === 0) {
      const callFacts = (data: InlineDecompileData) =>
        (data.emission.inferences ?? [])
          .filter((inference) => inference.details.kind === 'call')
          .map((inference) => {
            const details = inference.details;
            assert.ok(details.kind === 'call');
            return {
              call_id: details.call_id,
              ordered_arguments: details.ordered_arguments,
              result_width_bits: details.result_width_bits,
              arity_complete: details.arity_complete,
            };
          });
      assert.ok(callFacts(beforeCaller!.data).length > 0);
      const changedA = await decompile(a.id, 'renamed-A');
      assert.equal(changedA.response.data.cache, 'computed');
      assert.ok(changedA.data.emission.text.includes('incremental_reviewed_a'));
      const changedCaller = await decompile(caller!.id, 'dependent-caller');
      assert.equal(changedCaller.response.data.cache, 'computed');
      assert.ok(changedCaller.data.emission.text.includes('incremental_reviewed_a'));
      assert.notEqual(changedCaller.data.emission.text, beforeCaller!.data.emission.text);
      assert.deepEqual(callFacts(changedCaller.data), callFacts(beforeCaller!.data));
      const note = newIdentity('annotation'),
        hypothesis = newIdentity('annotation');
      await annotate([
        {
          operation: 'set',
          id: note,
          entity_id: a.id,
          value: { kind: 'note', value: 'Reviewed source formula, not a new machine fact' },
          status: 'asserted',
          evidence_ids: [],
        },
        {
          operation: 'set',
          id: hypothesis,
          entity_id: a.id,
          value: { kind: 'name', value: 'unproven_alias' },
          status: 'hypothesis',
          evidence_ids: [],
        },
      ]);
      const noted = await decompile(a.id, 'note-hypothesis-A');
      assert.equal(noted.response.data.cache, 'computed');
      assert.ok(noted.data.emission.text.includes('Reviewed source formula'));
      assert.ok(
        noted.full.diagnostics.some((diagnostic) => diagnostic.code === 'conflicting_evidence'),
      );
      const hypotheticalCaller = await decompile(caller!.id, 'hypothesis-caller');
      assert.equal(hypotheticalCaller.response.data.cache, 'computed');
      assert.equal(hypotheticalCaller.data.emission.text.includes('incremental_reviewed_a'), false);
      assert.equal(hypotheticalCaller.data.emission.text.includes('unproven_alias'), false);
      assert.ok(
        hypotheticalCaller.full.diagnostics.some(
          (diagnostic) => diagnostic.code === 'conflicting_evidence',
        ),
      );
      assert.deepEqual(callFacts(hypotheticalCaller.data), callFacts(beforeCaller!.data));
      const type = newIdentity('annotation'),
        signature = newIdentity('annotation');
      const type_id = entityIdentity(slice_id, 'incremental-public-type', a.id);
      await annotate([
        {
          operation: 'set',
          id: type,
          entity_id: a.id,
          value: {
            kind: 'type',
            type_id,
            definition: { kind: 'integer', bits: 32, signed: false },
          },
          status: 'asserted',
          evidence_ids: [],
        },
        {
          operation: 'set',
          id: signature,
          entity_id: a.id,
          value: {
            kind: 'signature',
            value: {
              abi: 'darwin-arm64',
              return_type: type_id,
              parameters: ['a', 'b'].map((parameter) => ({
                id: entityIdentity(slice_id, 'incremental-public-parameter', [a.id, parameter]),
                name: parameter,
                type_id,
              })),
              variadic: false,
              noreturn: false,
              evidence_ids: [],
            },
          },
          status: 'asserted',
          evidence_ids: [],
        },
      ]);
      const typed = await decompile(a.id, 'type-signature-A');
      assert.equal(typed.response.data.cache, 'computed');
      assert.equal(typed.data.signature?.return_type, type_id);
      assert.equal(typed.data.signature?.parameters.length, 2);
      await annotate(
        [name, note, hypothesis, type, signature].map((id) => ({
          operation: 'retract' as const,
          id,
        })),
      );
      const retracted = await decompile(a.id, 'retracted-A');
      assert.equal(retracted.response.data.cache, 'computed');
      assert.equal(retracted.data.signature, beforeA.data.signature);
      assert.equal(retracted.data.emission.text, beforeA.data.emission.text);
      const retractedCaller = await decompile(caller!.id, 'retracted-caller');
      assert.equal(retractedCaller.response.data.cache, 'computed');
      assert.equal(retractedCaller.data.emission.text, beforeCaller!.data.emission.text);
      assert.deepEqual(callFacts(retractedCaller.data), callFacts(beforeCaller!.data));
      await annotate(
        ['first_asserted', 'second_asserted'].map((value) => ({
          operation: 'set' as const,
          id: newIdentity('annotation'),
          entity_id: a.id,
          value: { kind: 'name' as const, value },
          status: 'asserted' as const,
          evidence_ids: [],
        })),
      );
      const conflict = await decompile(a.id, 'conflicting-A');
      assert.equal(conflict.response.data.cache, 'computed');
      assert.ok(
        conflict.full.diagnostics.some((diagnostic) => diagnostic.code === 'conflicting_evidence'),
      );
      const conflictingCaller = await decompile(caller!.id, 'conflicting-caller');
      assert.equal(conflictingCaller.response.data.cache, 'computed');
      assert.equal(conflictingCaller.data.emission.text.includes('first_asserted'), false);
      assert.equal(conflictingCaller.data.emission.text.includes('second_asserted'), false);
      assert.ok(
        conflictingCaller.full.diagnostics.some(
          (diagnostic) => diagnostic.code === 'conflicting_evidence',
        ),
      );
      assert.deepEqual(callFacts(conflictingCaller.data), callFacts(beforeCaller!.data));
      assertions.push(
        'Public original-subject name/note/type/signature/hypothesis/retraction/conflict and caller invalidation passed',
      );
    }
    await service.execute('project_close', { project_id, revision });
    const reopened = await service.execute('project_open', {
      source: { kind: 'resume', project_path },
      wait: true,
    });
    assert.ok('data' in reopened && reopened.revision === revision, JSON.stringify(reopened));
    // A changed revision without B being requested proves persistent candidate discovery after reopen.
    await annotate([
      {
        operation: 'set',
        id: newIdentity('annotation'),
        entity_id: a.id,
        value: { kind: 'note', value: 'Unrelated edit after reopen' },
        status: 'asserted',
        evidence_ids: [],
      },
    ]);
    const reopenedB = await decompile(b.id, 'reopened-reused-B');
    assert.equal(reopenedB.response.data.cache, 'hit');
    assert.deepEqual(
      { ...reopenedB.data, cache: 'computed' },
      { ...beforeB.data, cache: 'computed' },
    );
    sourceOracle(reopenedB.data);
    assertions.push(
      `${input.name}/${iteration}: trusted output oracle, fresh current-revision artifact, equivalent unchanged B and reopen reuse passed`,
    );
    await service.execute('project_close', { project_id, revision });
  } finally {
    await service.close('cancel');
  }
}
try {
  for (const input of inputs)
    for (let iteration = 0; iteration < iterations; iteration++) await run(input, iteration);
} finally {
  const worker = (await readFile(measurements, 'utf8'))
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => measurementSchema.parse(JSON.parse(line)));
  const decomps = worker.filter((entry) => entry.operation === 'function_decompile');
  assert.equal(
    decomps.length,
    samples.length,
    'Every timed request must have actual worker evidence',
  );
  const joined = samples.map((sample, index) => ({ ...sample, worker: decomps[index]! }));
  for (const sample of joined) {
    if (sample.label.includes('reused-B'))
      assert.equal(sample.worker.lifts, 0, 'Unchanged reused body must not lift');
    if (sample.label === 'computed-B')
      assert.ok(sample.worker.lifts > 0, 'Cold body must actually lift');
  }
  const distributions = inputs.map((input) => ({
    workload: input.name,
    samples: ['computed-B', 'reused-B', 'reopened-reused-B'].map((label) => {
      const selected = joined.filter(
        (sample) => sample.workload === input.name && sample.label === label,
      );
      return {
        label,
        elapsed_ms: distribution(selected.map((sample) => sample.elapsed_ms)),
        worker_rss_bytes: distribution(selected.map((sample) => sample.worker.after.rss)),
        worker_heap_used_bytes: distribution(
          selected.map((sample) => sample.worker.after.heapUsed),
        ),
        image_validation_ms: distribution(
          selected.map((sample) => sample.worker.image_validation_ms),
        ),
      };
    }),
  }));
  const report = {
    schema: 'open-decomp/incremental-reuse/1',
    node: process.version,
    iterations,
    input_provenance,
    scope:
      'Actual public QueryService, persistent SQLite workers, checked-in fixture and optional explicitly selected public SQLite. No analyzed binary execution.',
    limitations:
      'Observed source-runtime requests on a shared host; source-loader/observer overhead and warm filesystem/JIT vary. Distributions are not normalized speed claims; overlapping ranges are retained. RSS endpoints/lifetime maxima are not operation allocation or combined process-tree peaks. Each readLoadedImage still validates complete SHA256; its measured duration includes metadata/cache work. Fresh imports are excluded from timed requests.',
    assertions,
    distributions,
    samples: joined,
  };
  await writeFile(join(root, 'results.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ output: root, assertions, distributions }, null, 2));
}
