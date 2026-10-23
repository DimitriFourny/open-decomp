import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import {
  DEFAULT_ANALYSIS_OPTIONS,
  boundDiagnostics,
  createOperationContext,
  emissionSchema,
  encodeEmission,
  entityIdentity,
  mergeOmissions,
  provenanceCoverage,
  shedEmissionMetadata,
  type Diagnostic,
} from '../../src/core/index.js';
import { IRBuilder, integer } from '../../src/ir/index.js';
import { structureControlFlow } from '../../src/presentation/index.js';
import { emitC } from '../../src/emitters/c/index.js';
import { emitPythonLike } from '../../src/emitters/python-like/index.js';
import { image, provenance, slice } from '../ir/support.js';
import { execute } from './c/support.js';

const i32 = integer(32);

/** A straight-line function whose mapped statements carry distinct provenance. */
function fixture(statements: number) {
  const b = new IRBuilder(
    slice,
    entityIdentity(slice, 'function', 'metadata-limits'),
    provenance,
    'ssa',
  );
  const entry = b.block('entry');
  let sum = entry.constant(i32, 1n);
  for (let index = 0; index < statements; index++) {
    entry.source({
      instruction_ids: [entityIdentity(slice, 'instruction', BigInt(0x1000 + index * 4))],
      ranges: [
        {
          start: { image_id: image, space: 'va' as const, value: BigInt(0x1000 + index * 4) },
          size: 4n,
        },
      ],
      evidence_ids: [`evidence_${(index % 10).toString().repeat(64)}`],
      synthetic: [],
    });
    sum = entry.int('add', sum, entry.constant(i32, BigInt(index + 2)));
  }
  entry.return([sum]);
  const structured = structureControlFlow(b.finish(entry, [i32]), createOperationContext());
  assert.ok(structured.value);
  return structured.value;
}

for (const language of ['c-like', 'python-like'] as const)
  describe(language, () => {
    const emit = language === 'c-like' ? emitC : emitPythonLike;
    const options = { ...DEFAULT_ANALYSIS_OPTIONS, emitter: language, view: 'checked' as const };

    test('provenance beyond its bound sheds metadata and keeps the identical pseudocode text', () => {
      const body = fixture(24);
      const full = emit({ function: body }, options, createOperationContext());
      assert.equal(full.emission.omitted, undefined);
      assert.ok(full.emission.mappings.length > 0);
      const textBytes = Buffer.byteLength(full.emission.text);
      // The text fits this budget; the mappings and inference records do not.
      const budget = 1024;
      assert.ok(textBytes < budget, `fixture text (${textBytes} bytes) must fit ${budget}`);
      const bounded = emit(
        { function: body },
        options,
        createOperationContext({ budget: { output_bytes: budget } }),
      );
      assert.equal(bounded.emission.text, full.emission.text);
      assert.deepEqual(bounded.diagnostics, full.diagnostics);
      assert.deepEqual(bounded.coverage, full.coverage);
      assert.equal(bounded.emission.mappings.length, 0);
      assert.equal(bounded.emission.ids.length, 0);
      assert.deepEqual(bounded.emission.inferences, []);
      assert.deepEqual(
        bounded.emission.omitted?.map((item) => [item.kind, item.reason]),
        [
          ['mappings', 'output_limit'],
          ['inferences', 'output_limit'],
          ['requirements', 'output_limit'],
        ],
      );
      assert.equal(bounded.emission.omitted![0]!.omitted, full.emission.mappings.length);
      emissionSchema.parse(encodeEmission(bounded.emission));
    });
  });

for (const language of ['c-like', 'python-like'] as const)
  for (const view of ['source', 'checked'] as const)
    test(`${language} ${view}: a render the remaining work cannot pay with metadata prints the identical text first, omitted for budget`, () => {
      const emit = language === 'c-like' ? emitC : emitPythonLike;
      const options = { ...DEFAULT_ANALYSIS_OPTIONS, emitter: language, view };
      const body = fixture(24);
      const unbounded = createOperationContext();
      const full = emit({ function: body }, options, unbounded);
      assert.equal(full.emission.omitted, undefined);
      assert.ok(full.emission.mappings.length > 0);
      // Oracle: 1 + (2 + 3 + ... + 25).
      assert.deepEqual(execute(full.emission).values, [325n]);
      const work = unbounded.consumedWork!();
      const chosen = new Set<string>();
      for (
        let budget = Math.floor(work / 8);
        budget <= work * 64;
        budget = Math.ceil(budget * 1.1)
      ) {
        let bounded;
        try {
          bounded = emit(
            { function: body },
            options,
            createOperationContext({ budget: { work: budget } }),
          );
        } catch (error) {
          assert.equal((error as { code?: string }).code, 'resource_limit');
          continue;
        }
        // Every rendered text is the full render's text; only metadata may be absent.
        assert.equal(bounded.emission.text, full.emission.text);
        assert.deepEqual(execute(bounded.emission).values, [325n]);
        if (bounded.emission.omitted === undefined) {
          assert.deepEqual(bounded.emission.mappings, full.emission.mappings);
          chosen.add('full');
          continue;
        }
        assert.deepEqual(
          bounded.emission.omitted.map((item) => [item.kind, item.reason]),
          [
            ['mappings', 'budget'],
            ['inferences', 'budget'],
            ['requirements', 'budget'],
          ],
        );
        assert.equal(bounded.emission.mappings.length, 0);
        emissionSchema.parse(encodeEmission(bounded.emission));
        assert.match(
          provenanceCoverage(bounded.emission.omitted).reasons[0]!,
          /^budget: \d+ source mappings omitted; the pseudocode text is complete$/,
        );
        chosen.add('text');
      }
      // Both choices occur: the text renders first below the full render's work.
      assert.deepEqual([...chosen].sort(), ['full', 'text']);
    });

describe('shedding delivered metadata', () => {
  const body = fixture(24);
  const emission = encodeEmission(
    emitC(
      { function: body },
      { ...DEFAULT_ANALYSIS_OPTIONS, view: 'checked' },
      createOperationContext(),
    ).emission,
  );

  test('shed classes disappear, tables compact, and every remaining reference still resolves', () => {
    assert.ok((emission.inferences?.length ?? 0) > 0 && emission.mappings.length > 0);
    const shed = shedEmissionMetadata(emission, ['inferences']);
    emissionSchema.parse(shed);
    assert.equal(shed.text, emission.text);
    assert.deepEqual(shed.inferences, []);
    assert.deepEqual(
      shed.mappings.map((m) => [m.start, m.end]),
      emission.mappings.map((m) => [m.start, m.end]),
    );
    for (const [index, mapping] of shed.mappings.entries()) {
      const before = emission.mappings[index]!;
      assert.deepEqual(
        mapping.semantic_refs.map((ref) => shed.ids[ref]),
        before.semantic_refs.map((ref) => emission.ids[ref]),
      );
      assert.deepEqual(
        mapping.evidence_refs.map((ref) => shed.evidence[ref]),
        before.evidence_refs.map((ref) => emission.evidence[ref]),
      );
    }
    assert.deepEqual(shed.omitted, [
      { kind: 'inferences', reason: 'output_limit', omitted: emission.inferences!.length },
    ]);
    const bare = shedEmissionMetadata(shed, ['mappings', 'requirements']);
    emissionSchema.parse(bare);
    assert.equal(bare.text, emission.text);
    assert.equal(bare.mappings.length, 0);
    assert.ok(bare.ids.length <= shed.ids.length);
    assert.deepEqual(
      bare.omitted!.map((item) => item.kind),
      ['inferences', 'mappings'],
    );
  });

  test('provenance coverage names each omitted class and a lost count is never reported as known', () => {
    assert.equal(provenanceCoverage([]).state, 'complete');
    const merged = mergeOmissions(
      [{ kind: 'inferences', reason: 'output_limit', omitted: 3 }],
      [{ kind: 'inferences', reason: 'output_limit', omitted: null }],
    );
    assert.deepEqual(merged, [{ kind: 'inferences', reason: 'output_limit', omitted: null }]);
    const coverage = provenanceCoverage(merged);
    assert.equal(coverage.state, 'partial');
    assert.equal(coverage.layer, 'provenance');
    assert.match(coverage.reasons[0]!, /output_limit.*inference records omitted/);
  });
});

test('diagnostic lists beyond the wire bound keep a counted summary instead of failing', () => {
  const many: Diagnostic[] = Array.from({ length: 1500 }, (_, index) => ({
    code: index % 2 ? 'unavailable_semantics' : 'conflicting_evidence',
    severity: 'warning',
    message: `diagnostic ${index}`,
    evidence_ids: [],
  }));
  const bounded = boundDiagnostics(many);
  assert.equal(bounded.length, 1000);
  assert.deepEqual(bounded.slice(0, 999), many.slice(0, 999));
  const summary = bounded.at(-1)!;
  assert.equal(summary.code, 'unavailable_semantics');
  assert.match(summary.message, /251 unavailable_semantics, 250 conflicting_evidence/);
  assert.equal(boundDiagnostics(many.slice(0, 1000)).length, 1000);
});
