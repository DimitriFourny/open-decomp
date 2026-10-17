import assert from 'node:assert/strict';
import test from 'node:test';
import {
  decodeAnnotation,
  encodeAnnotation,
  decodeAnnotationEdit,
  encodeAnnotationEdit,
  decodeTypeDefinition,
  encodeTypeDefinition,
  decodeArtifact,
  encodeArtifact,
  decodeEmission,
  encodeEmission,
  decodeJob,
  encodeJob,
} from '../../src/core/serialization.js';
import { artifactSchema } from '../../src/core/primitives.js';
import { emissionSchema, jobSchema } from '../../src/core/tools.js';

const entity = `entity_${'a'.repeat(64)}`;
const project = `project_${'b'.repeat(64)}`;
const image = `image_${'c'.repeat(64)}`;

test('recovered type and annotation integers remain bigint without rewriting hex-looking notes', () => {
  const definition = {
    kind: 'structure' as const,
    size: '0x20000000000001',
    alignment: 8,
    fields: [{ id: entity, name: 'field', offset: '0x20000000000000', type_id: entity }],
  };
  const decoded = decodeTypeDefinition(definition);
  assert.equal(decoded.kind, 'structure');
  if (decoded.kind === 'structure') {
    assert.equal(decoded.size, 0x20000000000001n);
    assert.equal(decoded.fields[0]?.offset, 0x20000000000000n);
  }
  assert.deepEqual(encodeTypeDefinition(decoded), definition);
  const wire = {
    id: `annotation_${'d'.repeat(64)}`,
    entity_id: entity,
    value: { kind: 'type' as const, type_id: entity, definition },
    author: 'analyst',
    origin: 'user' as const,
    status: 'hypothesis' as const,
    evidence_ids: [],
    revision: 1,
  };
  assert.deepEqual(encodeAnnotation(decodeAnnotation(wire)), wire);
  const edit = {
    operation: 'set' as const,
    id: wire.id,
    entity_id: entity,
    value: wire.value,
    status: wire.status,
    evidence_ids: [],
  };
  assert.deepEqual(encodeAnnotationEdit(decodeAnnotationEdit(edit)), edit);
  const note = { ...wire, value: { kind: 'note' as const, value: '0xffffffffffffffff' } };
  assert.deepEqual(encodeAnnotation(decodeAnnotation(note)), note);
  for (const operation of ['retract', 'remove'] as const) {
    assert.deepEqual(encodeAnnotationEdit(decodeAnnotationEdit({ operation, id: wire.id })), {
      operation,
      id: wire.id,
    });
  }
});

test('artifact, job and emitted source-map codecs round-trip full-width metadata', () => {
  const artifact = artifactSchema.parse({
    id: `artifact_${'e'.repeat(64)}`,
    project_id: project,
    revision: 1,
    media_type: 'application/json',
    size: '0xffffffffffffffff',
    sha256: 'f'.repeat(64),
    schema_version: 1,
  });
  assert.equal(decodeArtifact(artifact).size, 0xffffffffffffffffn);
  assert.deepEqual(encodeArtifact(decodeArtifact(artifact)), artifact);
  const emission = emissionSchema.parse({
    language: 'c-like',
    emitter_version: '1',
    text: 'return;',
    span_unit: 'utf16',
    reconstruction: 'pseudocode',
    helpers: [],
    mappings: [
      {
        statement_id: entity,
        start: 0,
        end: 7,
        semantic_ids: [entity],
        instruction_ids: [entity],
        ranges: [
          { start: { image_id: image, space: 'va', value: '0xfffffffffffffff0' }, size: '0x4' },
        ],
        evidence_ids: [],
      },
    ],
  });
  assert.deepEqual(encodeEmission(decodeEmission(emission)), emission);
  const job = jobSchema.parse({
    id: `job_${'1'.repeat(64)}`,
    project_id: project,
    input_revision: 1,
    operation: 'function_decompile',
    state: 'completed',
    progress: { phase: 'emit', completed: 1, total: 1 },
    artifacts: [artifact],
    diagnostics: [],
    published_revision: 1,
  });
  assert.deepEqual(encodeJob(decodeJob(job)), job);
});
