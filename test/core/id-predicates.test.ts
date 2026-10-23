import assert from 'node:assert/strict';
import test from 'node:test';
import {
  entityIdSchema,
  evidenceIdSchema,
  isEntityId,
  isEvidenceId,
} from '../../src/core/primitives.js';

// Deterministic generator: valid ids, one-character mutations of them, and structural near misses.
let state = 0x9e3779b9;
const next = (): number => {
  state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
  return state;
};
const HEX = '0123456789abcdef';
const digest = (length = 64): string => {
  let out = '';
  for (let i = 0; i < length; i++) out += HEX[next() % 16];
  return out;
};
const noise = ['A', 'F', 'g', 'z', '_', ' ', '\n', '\u0000', '\u00e9', '\u0661', '0x', '-'];

function candidates(): unknown[] {
  const out: unknown[] = [];
  for (const prefix of ['entity', 'evidence', 'project', 'image', 'slice', 'entit', 'Entity', '']) {
    for (let i = 0; i < 40; i++) {
      const base = `${prefix}_${digest()}`;
      out.push(base);
      // Every kind of single-character damage at a random position.
      const at = next() % base.length;
      for (const bad of noise) {
        out.push(base.slice(0, at) + bad + base.slice(at + 1));
        out.push(base.slice(0, at) + bad + base.slice(at));
      }
      out.push(base.slice(0, -1), `${base}0`, `${base}\n`, `\n${base}`, ` ${base}`, `${base} `);
      out.push(base.toUpperCase(), `${prefix}${digest()}`, `${prefix}__${digest()}`);
      out.push(`${prefix}_${digest(63)}`, `${prefix}_${digest(65)}`, `${prefix}_${digest(0)}`);
      out.push(`${base}\r\n${base}`, `${base}\u2028`);
    }
  }
  out.push('', 'entity', 'evidence_', undefined, null, 0, 64n, {}, [], ['entity_' + digest()]);
  out.push(new String(`entity_${digest()}`));
  return out;
}

test('isEntityId / isEvidenceId accept exactly what the zod schemas accept', () => {
  const inputs = candidates();
  let validEntity = 0,
    validEvidence = 0;
  for (const value of inputs) {
    const entity = entityIdSchema.safeParse(value).success;
    const evidence = evidenceIdSchema.safeParse(value).success;
    assert.equal(isEntityId(value), entity, `entity predicate disagrees on ${String(value)}`);
    assert.equal(isEvidenceId(value), evidence, `evidence predicate disagrees on ${String(value)}`);
    if (entity) validEntity++;
    if (evidence) validEvidence++;
  }
  // The generator must exercise both outcomes, or the equivalence would be vacuous.
  assert.ok(validEntity >= 40 && validEvidence >= 40);
  assert.ok(inputs.length - validEntity > 1000);
});

test('the predicates are stateless across repeated calls', () => {
  const id = `entity_${digest()}`;
  for (let i = 0; i < 5; i++) {
    assert.equal(isEntityId(id), true);
    assert.equal(isEntityId(`${id}x`), false);
    assert.equal(isEvidenceId(id), false);
  }
});
