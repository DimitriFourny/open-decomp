#!/usr/bin/env node
// Focused real SDK/MCP oracle; compiles/analyzes but never executes its input.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { newIdentity, toolSchemas } from '../../src/core/index.ts';
import { artifactUri } from '../../src/mcp/resources.ts';

const [binaryArg, outputArg] = process.argv.slice(2);
assert.ok(
  binaryArg && outputArg,
  'usage: node --import tsx scripts/bench/investigation-sdk-oracle.mjs BINARY NEW_OUTPUT',
);
const binary = resolve(binaryArg),
  output = resolve(outputArg);
await mkdir(output, { recursive: false });
const client = new Client({ name: 'investigation-sdk-oracle', version: '1' });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [
    '--import',
    'tsx',
    resolve('src/cli/entry.ts'),
    'mcp',
    'start',
    '--root',
    resolve(binary, '..'),
    '--root',
    output,
  ],
  stderr: 'pipe',
});
const calls = [];
let stderr = '';
transport.stderr?.on('data', (chunk) => {
  stderr += chunk;
});
let checks = 0;
const check = (condition, message) => {
  assert.ok(condition, message);
  checks++;
};
async function call(name, args) {
  const wire = await client.callTool({ name, arguments: args }, undefined, { timeout: 360000 });
  calls.push({ name, args, response: wire });
  await writeFile(join(output, 'calls.json'), JSON.stringify(calls, null, 2));
  if (!wire.structuredContent) return wire;
  const result = toolSchemas[name].output.parse(wire.structuredContent);
  if (name === 'function_get' && result.data?.view === 'investigation') {
    const model = JSON.parse(wire.content.find((item) => item.type === 'text').text);
    check(
      model.artifact_id === result.data.artifact_id &&
        model.analysis_state === result.data.analysis_state,
      'compact text preserves exact artifact and analysis state',
    );
    const counts = result.data.selection.counts;
    check(
      JSON.stringify(model.scope.inferences) ===
        JSON.stringify([counts.inferences.selected, counts.inferences.total]) &&
        JSON.stringify(model.scope.requirements) ===
          JSON.stringify([counts.requirements.selected, counts.requirements.total]) &&
        JSON.stringify(model.scope.unresolved_sites) ===
          JSON.stringify([counts.unresolved_sites.selected, counts.unresolved_sites.total]) &&
        JSON.stringify(model.scope.helpers) ===
          JSON.stringify([counts.helpers.selected, counts.helpers.total]) &&
        JSON.stringify(model.scope.omitted_statuses) ===
          JSON.stringify(result.data.selection.omitted_inference_statuses) &&
        JSON.stringify(model.scope.omitted_requirements) ===
          JSON.stringify(result.data.selection.omitted_requirement_kinds),
      'compact text preserves selected/omitted uncertainty scope',
    );
    check(
      new Set(model.references).size === model.references.length,
      'compact model references interned once',
    );
    check(
      model.diagnostics.length === result.data.analysis_diagnostics.length &&
        model.diagnostics.every(
          (diagnostic, index) =>
            diagnostic.code === result.data.analysis_diagnostics[index].code &&
            diagnostic.severity === result.data.analysis_diagnostics[index].severity &&
            diagnostic.artifact_index === result.data.analysis_diagnostics[index].artifact_index,
        ),
      'all original diagnostic codes/severities/artifact locators remain visible',
    );
    const coreQuotes = result.data.items.filter((item) => item.kind === 'source');
    const modelQuotes = model.items.filter((item) => item.kind === 'source');
    check(
      JSON.stringify(modelQuotes.map((item) => [item.span, item.text])) ===
        JSON.stringify(coreQuotes.map((item) => [item.span, item.text])),
      'model source quotations unchanged from strict structured data',
    );
    const coreHelpers = result.data.items.filter((item) => item.kind === 'helper');
    const modelHelpers = model.items.filter((item) => item.kind === 'helper');
    check(
      JSON.stringify(modelHelpers) === JSON.stringify(coreHelpers),
      'model helper items (index, exact name, untruncated explanation, semantic-domain label, locator) unchanged from strict structured data',
    );
    for (const item of model.items.filter(
      (item) => item.kind === 'inference' && item.record.details.kind === 'field',
    )) {
      const core = result.data.items.find(
        (candidate) => candidate.kind === 'inference' && candidate.record.id === item.record.id,
      );
      check(
        ['offset', 'width_bits', 'stride', 'dynamic', 'bounds'].every(
          (field) => item.record.details[field] === core.record.details[field],
        ),
        'compact field facts and unknown bounds unchanged',
      );
    }
  }
  return result;
}
function originalProvenance(item, references) {
  if (item.kind === 'signature' || item.kind === 'helper') return item;
  if (item.kind === 'source')
    return { ...item, instruction_ids: item.instruction_refs.map((index) => references[index]) };
  return {
    ...item,
    record: {
      ...item.record,
      instruction_ids: item.record.instruction_refs.map((index) => references[index]),
    },
  };
}
try {
  await client.connect(transport);
  const opened = await call('project_open', {
    source: { kind: 'import', input_path: binary, project_path: join(output, 'project') },
    wait: true,
  });
  check(opened.data?.image, 'actual MCP import image');
  let scope = { project_id: opened.project_id, revision: opened.revision };
  const found = await call('functions_find', {
    ...scope,
    image_id: opened.data.image.id,
    query: { text: '_investigation_field', match: 'exact', case_sensitive: true },
  });
  const fn = found.data.items[0];
  check(fn, 'trusted selected field function');
  const findOther = await call('functions_find', {
    ...scope,
    image_id: opened.data.image.id,
    query: { text: '_investigation_mix', match: 'exact', case_sensitive: true },
  });
  const other = findOther.data.items[0];
  const base = { ...scope, function_id: fn.id };
  const missing = await call('function_get', { ...base, view: 'investigation' });
  check(missing.isError === true, 'explicit artifact argument required at MCP admission');
  const decompiled = await call('function_decompile', { ...base, wait: true });
  const artifact = decompiled.artifacts[0];
  check(artifact, 'published artifact handle');
  const preferred = await call('function_decompile', { ...base, wait: true, delivery: 'artifact' });
  check(
    preferred.data?.delivery === 'artifact' &&
      preferred.data.delivery_reason === 'requested' &&
      preferred.state === decompiled.state &&
      preferred.data.cache === 'hit',
    'requested artifact delivery preserves semantic state and uses exact cache hit',
  );
  check(
    preferred.artifacts[0].id === artifact.id &&
      preferred.artifacts[0].sha256 === artifact.sha256 &&
      JSON.stringify(preferred.budget) === JSON.stringify(decompiled.budget) &&
      JSON.stringify(preferred.coverage) === JSON.stringify(decompiled.coverage) &&
      JSON.stringify(preferred.diagnostics) === JSON.stringify(decompiled.diagnostics),
    'delivery preference does not change identity/budget/coverage/diagnostics',
  );
  const resourcePages = [],
    resourceChunks = [];
  let uri = artifactUri(artifact);
  while (uri) {
    const response = await client.readResource({ uri });
    resourcePages.push({ uri, response });
    const part = response.contents[0];
    resourceChunks.push(Buffer.from(part.text, 'utf8'));
    uri = part._meta['open-decomp/artifact'].next_uri;
  }
  await writeFile(join(output, 'resources.json'), JSON.stringify(resourcePages, null, 2));
  const resourceBytes = Buffer.concat(resourceChunks);
  check(
    createHash('sha256').update(resourceBytes).digest('hex') === artifact.sha256,
    'actual SDK artifact pages reproduce published hash',
  );
  const stored = JSON.parse(resourceBytes);
  check(
    stored.result.data.emission.text === decompiled.data.emission.text &&
      !('delivery' in stored.identity) &&
      JSON.stringify(stored.identity.budget) === JSON.stringify(decompiled.budget),
    'same original immutable body and exact identity survive requested delivery',
  );
  const defaultAgain = await call('function_decompile', { ...base, wait: true });
  check(
    defaultAgain.data?.delivery === 'inline' &&
      defaultAgain.data.cache === 'hit' &&
      defaultAgain.artifacts[0].sha256 === artifact.sha256,
    'default body delivery remains unchanged and cached',
  );
  const request = { ...base, view: 'investigation', artifact_id: artifact.id, page: { limit: 1 } };
  const invalidLimit = await call('function_get', { ...request, page: { limit: 1001 } });
  check(invalidLimit.isError === true, 'MCP limit bound rejects overlarge page');
  const bounded = await call('function_get', {
    ...request,
    page: { limit: 100 },
    budget: { output_bytes: 8192 },
  });
  check(
    bounded.data &&
      Buffer.byteLength(JSON.stringify(bounded)) <= 8192 &&
      bounded.data.page.next_cursor,
    'actual output bound retains continuation',
  );
  const artifactPath = join(output, 'project', 'artifacts', artifact.id);
  const originalBytes = await readFile(artifactPath);
  const tamperedBytes = Buffer.from(originalBytes);
  tamperedBytes[tamperedBytes.length - 1] ^= 1;
  try {
    await writeFile(artifactPath, tamperedBytes);
    const corrupt = await call('function_get', request);
    check(
      corrupt.state === 'failed' && corrupt.error.code === 'invalid_input',
      'tampered artifact never leaks semantic data',
    );
  } finally {
    await writeFile(artifactPath, originalBytes);
  }
  const all = [],
    cursors = new Set();
  let next;
  do {
    const page = await call('function_get', {
      ...request,
      page: { limit: 1, ...(next ? { cursor: next } : {}) },
    });
    check(page.data?.view === 'investigation', 'SDK paged investigation');
    check(
      page.data.items.length <= 1 &&
        page.data.artifact_id === artifact.id &&
        page.artifacts[0].sha256 === artifact.sha256,
      'bounded exact artifact page',
    );
    check(
      new Set(page.data.references).size === page.data.references.length,
      'page provenance interned exactly once',
    );
    const emitted = decompiled.data.emission;
    for (const reference of page.data.references) {
      if (reference.startsWith('entity_')) continue;
      check(
        emitted.mappings.some((mapping) => {
          const range = emitted.ranges[mapping.range_refs[0]];
          return (
            mapping.instruction_refs.length === 1 &&
            mapping.range_refs.length === 1 &&
            range.start.image_id === opened.data.image.id &&
            `${range.start.space}:${range.start.value}+${range.size}` === reference
          );
        }),
        'instruction address requires exact single-instruction original mapping',
      );
    }
    all.push(...page.data.items.map((item) => originalProvenance(item, page.data.references)));
    next = page.data.page.next_cursor;
    if (next) {
      check(!cursors.has(next), 'progressing page cursor');
      cursors.add(next);
    }
  } while (next);
  check(all.length > 1 && cursors.size > 0, 'actual continuation exercised');
  const declaration = decompiled.data.emission.declaration_span;
  check(
    declaration && declaration.end > declaration.start,
    'producer publishes exact declaration interval',
  );
  const expectedQuoteCoverage = new Uint8Array(decompiled.data.emission.text.length);
  for (const mapping of decompiled.data.emission.mappings)
    if (mapping.instruction_refs.length) expectedQuoteCoverage.fill(1, mapping.start, mapping.end);
  expectedQuoteCoverage.fill(0, declaration.start, declaration.end);
  const actualQuoteCoverage = new Uint8Array(expectedQuoteCoverage.length);
  for (const item of all.filter((item) => item.kind === 'source'))
    actualQuoteCoverage.fill(1, item.span.start, item.span.end);
  check(
    expectedQuoteCoverage.every((bit, index) => bit === actualQuoteCoverage[index]),
    'quotation coverage removes only declaration; every mapped body/note interval remains',
  );
  const field = all.find(
    (item) => item.kind === 'inference' && item.record.details.kind === 'field',
  );
  check(field?.record.instruction_ids.length, 'field instruction proof references');
  check(field.record.details.bounds === 'unknown', 'unknown bounds retained');
  const originalField = decompiled.data.emission.inferences.find(
    (record) => record.id === field.record.id,
  );
  const subject = originalField.details.field_ids[0];
  const provenanceSubject = decompiled.data.emission.ids[originalField.subject_refs[0]];
  const provenanceReview = await call('function_get', {
    ...base,
    view: 'metadata',
    artifact_id: artifact.id,
    subject_id: provenanceSubject,
  });
  check(
    provenanceReview.data?.reviewed_subject_id === provenanceSubject &&
      provenanceReview.data.annotation_eligible === false,
    'original instruction provenance review does not grant annotation authority',
  );
  const filtered = await call('function_get', {
    ...request,
    kinds: ['field'],
    subject_id: subject,
    page: { limit: 100 },
  });
  check(
    filtered.data.items.length > 0 &&
      filtered.data.items.every(
        (item) =>
          item.kind === 'inference' &&
          item.record.details.kind === 'field' &&
          decompiled.data.emission.inferences.some(
            (record) =>
              record.id === item.record.id &&
              record.subject_refs.some((ref) => decompiled.data.emission.ids[ref] === subject),
          ),
      ),
    'kind and original subject filtering',
  );
  check(
    filtered.data.items.every(
      (item) =>
        item.kind !== 'signature' &&
        (item.kind !== 'inference' || item.record.details.kind !== 'parameter'),
    ),
    'requesting field facts never silently adds all parameters or signature',
  );
  check(
    filtered.diagnostics.length === 0 &&
      filtered.data.analysis_diagnostics.length === stored.result.diagnostics.length &&
      filtered.data.analysis_diagnostics.every((diagnostic, index) => {
        const original = stored.result.diagnostics[index];
        return (
          diagnostic.artifact_index === index &&
          diagnostic.code === original.code &&
          diagnostic.severity === original.severity &&
          diagnostic.entity_known === (original.entity_id !== undefined) &&
          diagnostic.evidence_count === original.evidence_ids.length &&
          !('message' in diagnostic)
        );
      }),
    'compact diagnostic records retain every original code/severity/index/presence/count without graph/message copies',
  );
  const quoted = await call('function_get', {
    ...request,
    kinds: ['source', 'field'],
    subject_id: subject,
    include_quotes: true,
    page: { limit: 100 },
  });
  const sourceQuotes = quoted.data.items.filter((item) => item.kind === 'source');
  check(
    sourceQuotes.length > 0 &&
      sourceQuotes.every(
        (quote) =>
          quote.text === decompiled.data.emission.text.slice(quote.span.start, quote.span.end) &&
          quote.text.length <= 512 &&
          quote.mapping_indexes.length > 0,
      ),
    'bounded original mapped output quotations remain exact',
  );
  check(
    quoted.data.selection.counts.inferences.total >=
      quoted.data.selection.counts.inferences.selected,
    'selected scope does not hide omitted inference extent',
  );
  // Paged helper contracts are compared with the immutable artifact bytes (hash-checked), never with
  // another query projection: every actual helper of the artifact, exact names/explanations, original indexes.
  const helperProof = [];
  const helperDomain =
    'renderer pseudocode semantic contract; not original source or an executable helper definition';
  for (const name of [
    'investigation_field',
    'investigation_mix',
    'investigation_caller',
    'investigation_signed',
    'investigation_callback',
  ]) {
    const located = await call('functions_find', {
      ...scope,
      image_id: opened.data.image.id,
      query: { text: '_' + name, match: 'exact', case_sensitive: true },
    });
    check(located.data.items.length === 1, `exact frozen function ${name}`);
    const target = located.data.items[0];
    const body = await call('function_decompile', { ...scope, function_id: target.id, wait: true });
    const handle = body.artifacts[0];
    const bytes = await readFile(join(output, 'project', 'artifacts', handle.id));
    check(
      createHash('sha256').update(bytes).digest('hex') === handle.sha256,
      `${name} immutable artifact bytes match published hash`,
    );
    const original = JSON.parse(bytes).result.data.emission;
    const helperRequest = {
      ...scope,
      function_id: target.id,
      view: 'investigation',
      artifact_id: handle.id,
      kinds: ['helper'],
    };
    const paged = [];
    let helperCursor;
    do {
      const page = await call('function_get', {
        ...helperRequest,
        page: { limit: 1, ...(helperCursor ? { cursor: helperCursor } : {}) },
      });
      check(
        page.data?.view === 'investigation' &&
          page.data.items.length <= 1 &&
          page.data.items.every((item) => item.kind === 'helper') &&
          page.data.references.length === 0 &&
          page.data.artifact_id === handle.id &&
          page.artifacts[0].sha256 === handle.sha256,
        `${name} helper-only page: no signature/source/inference records, no proof aliases, exact artifact`,
      );
      check(
        page.data.selection.counts.helpers.total === original.helpers.length &&
          page.data.selection.counts.helpers.selected === original.helpers.length,
        `${name} selection counts every actual helper`,
      );
      check(
        JSON.stringify(page.data.helpers) ===
          JSON.stringify(
            original.helpers.map((helper, index) => ({
              name: helper.name,
              artifact_helper_index: index,
            })),
          ),
        `${name} discovery menu matches original helper indexes`,
      );
      paged.push(...page.data.items);
      helperCursor = page.data.page.next_cursor;
    } while (helperCursor);
    check(
      JSON.stringify(
        paged.map((item) => [item.artifact_helper_index, item.name, item.explanation]),
      ) ===
        JSON.stringify(
          original.helpers.map((helper, index) => [index, helper.name, helper.explanation]),
        ),
      `${name} paged helper contracts equal every original artifact helper with exact untruncated names/explanations`,
    );
    check(
      paged.every(
        (item) =>
          item.semantic_domain === helperDomain &&
          item.explanation.length > 0 &&
          item.explanation.length <= 8192,
      ),
      `${name} helpers are labelled renderer contracts and keep full explanations`,
    );
    const allKinds = [];
    let allCursor;
    do {
      const page = await call('function_get', {
        ...helperRequest,
        kinds: undefined,
        include_quotes: true,
        page: { limit: 100, ...(allCursor ? { cursor: allCursor } : {}) },
      });
      check(
        page.data?.view === 'investigation' && page.data.selection.kinds === null,
        `${name} default selection includes all kinds`,
      );
      allKinds.push(...page.data.items);
      allCursor = page.data.page.next_cursor;
    } while (allCursor);
    check(
      allKinds.filter((item) => item.kind === 'helper').length === original.helpers.length &&
        allKinds.some((item) => item.kind === 'source') &&
        allKinds.some((item) => item.kind === 'signature'),
      `${name} default paged selection retains source, signature and every helper`,
    );
    helperProof.push({
      function: name,
      helpers: original.helpers.length,
      helper_names: original.helpers.map((helper) => helper.name),
    });
  }
  check(
    helperProof.some((entry) => entry.helpers > 0),
    'at least one frozen function exposes actual helper contracts to the paged consumer; none were selected favorably',
  );
  const noHelpers = await call('function_get', {
    ...request,
    kinds: ['signature'],
    page: { limit: 100 },
  });
  check(
    noHelpers.data.selection.counts.helpers.selected === 0 &&
      noHelpers.data.items.every((item) => item.kind !== 'helper') &&
      noHelpers.data.selection.counts.helpers.total === decompiled.data.emission.helpers.length,
    'unrequested helper kind is omitted while its total extent stays visible',
  );
  const cursor = [...cursors][0];
  const changed = await call('function_get', {
    ...request,
    kinds: ['call'],
    page: { limit: 1, cursor },
  });
  check(
    changed.state === 'failed' && changed.error.code === 'stale_cursor',
    'cursor rejects changed filter',
  );
  const foreign = await call('function_get', { ...request, function_id: other.id });
  check(foreign.state === 'failed', 'foreign function artifact rejected');
  const unknown = await call('function_get', { ...request, artifact_id: newIdentity('artifact') });
  check(unknown.state === 'failed', 'unknown artifact rejected');
  const second = await call('project_open', {
    source: { kind: 'import', input_path: binary, project_path: join(output, 'foreign-project') },
    wait: true,
  });
  check(second.data?.image, 'second exact image project opened');
  const foreignProject = await call('function_get', {
    ...request,
    project_id: second.project_id,
    revision: second.revision,
  });
  check(
    foreignProject.state === 'failed',
    'foreign project artifact rejected even for identical binary and function IDs',
  );
  await call('project_close', { project_id: second.project_id });
  const foreignSubject = await call('function_get', { ...request, subject_id: other.id });
  check(foreignSubject.state === 'failed', 'foreign subject rejected');
  const noTrust = await call('function_get', { ...base, view: 'metadata', subject_id: subject });
  check(noTrust.state === 'failed', 'derived review requires trusted artifact');
  const annotation = newIdentity('annotation');
  for (const status of ['hypothesis', 'asserted', 'retracted']) {
    const applied = await call('annotations_apply', {
      project_id: scope.project_id,
      expected_revision: scope.revision,
      author: 'investigation-sdk-oracle',
      origin: status === 'hypothesis' ? 'llm' : 'user',
      edits:
        status === 'retracted'
          ? [{ operation: 'retract', id: annotation }]
          : [
              {
                operation: 'set',
                id: annotation,
                entity_id: subject,
                status,
                evidence_ids: [],
                value: { kind: 'note', value: 'Scope-bound review note' },
              },
            ],
    });
    check(applied.state === 'complete', `${status} annotation accepted`);
    scope = { ...scope, revision: applied.revision };
    const stale = await call('function_get', { ...request, ...scope });
    check(stale.state === 'failed', `${status} rejects stale artifact`);
    const oldRevision = await call('function_get', request);
    check(
      oldRevision.state === 'failed' && oldRevision.error.code === 'stale_revision',
      'historical artifact rejected',
    );
    const refreshed = await call('function_decompile', {
      ...scope,
      function_id: fn.id,
      wait: true,
    });
    check(refreshed.artifacts[0], 'current artifact refreshed explicitly');
    const reviewed = await call('function_get', {
      ...scope,
      function_id: fn.id,
      view: 'metadata',
      subject_id: subject,
      artifact_id: refreshed.artifacts[0].id,
    });
    check(reviewed.data?.reviewed_subject_id === subject, 'explicit reviewed original subject');
    check(
      reviewed.data.annotations.some((item) => item.id === annotation && item.status === status),
      `${status} remains visible`,
    );
    check(Array.isArray(reviewed.data.lineage), 'original subject lineage exposed');
    const projected = await call('function_get', {
      ...scope,
      function_id: fn.id,
      view: 'investigation',
      artifact_id: refreshed.artifacts[0].id,
      kinds: ['annotation'],
      subject_id: subject,
    });
    const annotations = projected.data.items.filter((item) => item.kind === 'inference');
    if (status === 'retracted')
      check(
        !annotations.some((item) => item.record.details.annotation_id === annotation),
        'historical retraction not active semantics',
      );
    else
      check(
        annotations.some(
          (item) =>
            item.record.status === status && item.record.details.annotation_id === annotation,
        ),
        'annotation status never promoted',
      );
  }
  const functionNote = newIdentity('annotation'),
    noteText = 'Declaration-scope oracle note';
  const noted = await call('annotations_apply', {
    project_id: scope.project_id,
    expected_revision: scope.revision,
    author: 'investigation-sdk-oracle',
    origin: 'user',
    edits: [
      {
        operation: 'set',
        id: functionNote,
        entity_id: fn.id,
        status: 'asserted',
        evidence_ids: [],
        value: { kind: 'note', value: noteText },
      },
    ],
  });
  check(noted.state === 'complete', 'function-root note accepted');
  scope = { ...scope, revision: noted.revision };
  const notedBody = await call('function_decompile', { ...scope, function_id: fn.id, wait: true });
  const notedView = await call('function_get', {
    ...scope,
    function_id: fn.id,
    view: 'investigation',
    artifact_id: notedBody.artifacts[0].id,
    kinds: ['source', 'annotation'],
    page: { limit: 100 },
  });
  const notedQuotes = notedView.data.items.filter((item) => item.kind === 'source');
  check(
    notedQuotes.some((item) => item.text.includes(noteText)),
    'root-ID note quotation is retained, not mistaken for declaration',
  );
  check(
    notedQuotes.every(
      (item) =>
        item.span.end <= notedBody.data.emission.declaration_span.start ||
        item.span.start >= notedBody.data.emission.declaration_span.end,
    ),
    'exact declaration alone is excluded despite same-root note mappings',
  );
  await call('project_close', { project_id: scope.project_id });
  const result = {
    checks,
    selected_records: all.length,
    pages: all.length,
    annotation_states: ['hypothesis', 'asserted', 'retracted'],
    helper_proof: helperProof,
    target_executed: false,
    repository_suite_run: false,
    sdk: '@modelcontextprotocol/client 2.3.1',
  };
  await writeFile(join(output, 'result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} catch (error) {
  await writeFile(
    join(output, 'failure.json'),
    JSON.stringify({ checks, error: String(error), stack: error.stack }, null, 2),
  );
  throw error;
} finally {
  await client.close();
  await writeFile(join(output, 'stderr.txt'), stderr);
}
