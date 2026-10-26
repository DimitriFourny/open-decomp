import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  DEFAULT_BUDGET,
  newIdentity,
  type ResultEnvelope,
  type ToolInput,
  type ToolResult,
} from '../../src/core/index.js';
import { QueryService } from '../../src/service/queries/index.js';
import type { WorkerPoolOptions } from '../../src/workers/index.js';
import { runtimeBytes } from '../metadata/fixture.js';
import { waitForWorkerPause } from '../workers/gate.js';

const fixtures = resolve('fixtures/bin');
function data<T>(result: ResultEnvelope<T>): T {
  assert.ok('data' in result, JSON.stringify(result));
  return result.data;
}
function openedImage(result: ToolResult<'project_open'>) {
  const image = data(result).image;
  assert.ok(image, 'Expected a ready loaded image, not an unfinished import');
  return image;
}
async function setup(t: TestContext, options: Partial<WorkerPoolOptions> = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'open-decomp-queries-')));
  const service = await QueryService.create({
    authorized_roots: [root, fixtures, resolve('test/metadata/fixtures')],
    max_workers: 2,
    max_queued: 4,
    ...options,
  });
  t.after(async () => {
    await service.close('cancel');
    await rm(root, { recursive: true, force: true });
  });
  return { root, service };
}

for (const fixture of [
  {
    name: 'macho-arm64-symbols',
    architecture: 'arm64',
    entry: 0x100000708n,
    arithmetic: 0x100000574n,
    instructions: 5,
    magic: 'cffaedfe',
  },
  {
    name: 'macho-arm64-stripped',
    architecture: 'arm64',
    entry: 0x100000708n,
    arithmetic: 0x100000574n,
    instructions: 5,
    magic: 'cffaedfe',
  },
  {
    name: 'corpus-symbols.dll',
    architecture: 'x86_64',
    entry: 0x180001200n,
    arithmetic: 0x180001030n,
    instructions: 4,
    magic: '4d5a',
  },
  {
    name: 'corpus-stripped.dll',
    architecture: 'x86_64',
    entry: 0x180001200n,
    arithmetic: 0x180001030n,
    instructions: 4,
    magic: '4d5a',
  },
])
  test(
    `real child ${fixture.name}: strings -> references -> function -> CFG/disassembly/bytes and reopen`,
    { timeout: 60000 },
    async (t) => {
      const { root, service } = await setup(t),
        projectPath = join(root, 'project');
      const opened = await service.execute('project_open', {
        wait: true,
        source: {
          kind: 'import',
          input_path: join(fixtures, fixture.name),
          project_path: projectPath,
        },
      });
      const image = openedImage(opened);
      assert.equal(image.target.architecture, fixture.architecture);
      assert.equal(opened.revision, 2);
      assert.ok(opened.project_id);
      const scope = {
        project_id: opened.project_id,
        revision: opened.revision!,
        image_id: image.id,
      };
      const headers = data(await service.execute('binary_info', { ...scope, view: 'headers' }));
      assert.equal(headers.view, 'headers');
      if (headers.view !== 'headers') assert.fail('Wrong binary view');
      const machine = headers.items
        .flatMap((header) => header.fields)
        .find((field) => field.name === (fixture.architecture === 'arm64' ? 'cputype' : 'Machine'));
      assert.ok(machine?.kind === 'integer');
      assert.equal(BigInt(machine.value), fixture.architecture === 'arm64' ? 0x100000cn : 0x8664n);
      const strings = data(
        await service.execute('strings_find', {
          ...scope,
          query: { text: 'open-decomp trusted fixture v1', match: 'exact' },
        }),
      );
      assert.equal(strings.items.length, 1);
      assert.equal(strings.items[0]!.status, 'referenced');
      const xrefs = await service.execute('xrefs_get', {
        project_id: scope.project_id,
        revision: scope.revision,
        target: { kind: 'entity', id: strings.items[0]!.id },
        direction: 'incoming',
      });
      const reference = data(xrefs).items.find(
        (item) => item.kind === 'address' && item.from_function !== null,
      );
      assert.ok(reference?.from_function && reference.from_instruction);
      assert.deepEqual(xrefs.evidence, [], 'navigation delivers evidence by reference');
      assert.equal(data(xrefs).page.evidence_delivery, 'by_reference');
      assert.ok(reference.evidence_ids.length > 0);
      const resolved = data(
        await service.execute('evidence_get', {
          project_id: scope.project_id,
          revision: scope.revision,
          evidence_ids: reference.evidence_ids,
        }),
      );
      assert.deepEqual(
        resolved.items.map((item) => item.id).toSorted(),
        [...new Set(reference.evidence_ids)].toSorted(),
      );
      const metadata = data(
        await service.execute('function_get', {
          project_id: scope.project_id,
          revision: scope.revision,
          function_id: reference.from_function,
        }),
      );
      assert.equal(metadata.view, 'metadata');
      if (metadata.view !== 'metadata') assert.fail('Wrong function view');
      assert.equal(BigInt(metadata.function.entry.value), fixture.entry);
      const disassembly = data(
        await service.execute('function_get', {
          project_id: scope.project_id,
          revision: scope.revision,
          function_id: reference.from_function,
          view: 'disassembly',
          page: { limit: 1000 },
        }),
      );
      assert.equal(disassembly.view, 'disassembly');
      if (disassembly.view !== 'disassembly') assert.fail('Wrong function view');
      const use = disassembly.items.find((item) => item.id === reference.from_instruction);
      assert.ok(use);
      const cfg = data(
        await service.execute('function_get', {
          project_id: scope.project_id,
          revision: scope.revision,
          function_id: reference.from_function,
          view: 'cfg',
          page: { limit: 1000 },
        }),
      );
      assert.equal(cfg.view, 'cfg');
      if (cfg.view !== 'cfg') assert.fail('Wrong function view');
      assert.ok(cfg.items.some((block) => block.instructions.includes(use.id)));
      const blockIds = new Set(cfg.items.map((block) => block.id));
      for (const block of cfg.items)
        for (const edge of block.edges) if (edge.to !== null) assert.ok(blockIds.has(edge.to));
      const memory = data(
        await service.execute('memory_read', {
          project_id: scope.project_id,
          revision: scope.revision,
          address: use.address,
          length: use.size,
        }),
      );
      const mappings = data(await service.execute('binary_info', { ...scope, view: 'mappings' }));
      if (mappings.view !== 'mappings') assert.fail('Wrong binary view');
      const mapping = mappings.items.find(
        (item) =>
          BigInt(use.address.value) >= BigInt(item.va) &&
          BigInt(use.address.value) < BigInt(item.va) + BigInt(item.file_size),
      );
      assert.ok(mapping);
      const raw = await readFile(join(fixtures, fixture.name));
      const offset = Number(
        BigInt(mapping.file_offset) + BigInt(use.address.value) - BigInt(mapping.va),
      );
      assert.deepEqual(
        memory.segments.map((segment) =>
          segment.kind === 'mapped' ? segment.bytes_hex : segment.kind,
        ),
        [raw.subarray(offset, offset + use.size).toString('hex')],
      );
      const magic = data(
        await service.execute('memory_read', {
          project_id: scope.project_id,
          revision: scope.revision,
          address: { image_id: image.id, space: 'file', value: '0x0' },
          length: fixture.magic.length / 2,
        }),
      );
      assert.equal(magic.segments[0]!.kind, 'mapped');
      if (magic.segments[0]!.kind === 'mapped')
        assert.equal(magic.segments[0]!.bytes_hex, fixture.magic);
      const arithmetic = data(
        await service.execute('functions_find', {
          ...scope,
          address: {
            image_id: image.id,
            space: 'va',
            value: `0x${fixture.arithmetic.toString(16)}`,
          },
        }),
      ).items.find((item) => BigInt(item.entry.value) === fixture.arithmetic);
      assert.ok(arithmetic);
      const instructions = data(
        await service.execute('function_get', {
          project_id: scope.project_id,
          revision: scope.revision,
          function_id: arithmetic.id,
          view: 'disassembly',
          page: { limit: 1000 },
        }),
      );
      if (instructions.view !== 'disassembly') assert.fail('Wrong function view');
      assert.equal(instructions.items.length, fixture.instructions);
      assert.equal(instructions.items.at(-1)!.flow.kind, 'return');
      assert.equal(instructions.page.index_state, 'complete');
      const pagedInstructions: string[] = [];
      let instructionCursor: string | undefined;
      do {
        const page = data(
          await service.execute('function_get', {
            project_id: scope.project_id,
            revision: scope.revision,
            function_id: arithmetic.id,
            view: 'disassembly',
            page: { limit: 1, ...(instructionCursor ? { cursor: instructionCursor } : {}) },
          }),
        );
        if (page.view !== 'disassembly') assert.fail('Wrong function view');
        pagedInstructions.push(...page.items.map((item) => item.id));
        instructionCursor = page.page.next_cursor ?? undefined;
      } while (instructionCursor);
      assert.deepEqual(
        pagedInstructions,
        instructions.items.map((item) => item.id),
      );
      const boundedDecode = await service.execute('function_get', {
        project_id: scope.project_id,
        revision: scope.revision,
        function_id: arithmetic.id,
        view: 'disassembly',
        budget: { instructions: 1 },
      });
      assert.equal(boundedDecode.state, 'partial');
      if (boundedDecode.state === 'partial') assert.equal(boundedDecode.reason, 'budget');
      const boundedInstructions = data(boundedDecode);
      if (boundedInstructions.view !== 'disassembly') assert.fail('Wrong function view');
      assert.ok(boundedInstructions.items.length <= 1);
      assert.ok(boundedInstructions.gaps.some((gap) => gap.reason === 'budget'));
      const before = opened.revision;
      const closed = await service.execute('project_close', {
        project_id: scope.project_id,
        revision: scope.revision,
      });
      assert.equal(data(closed).persisted_revision, before);
      const resumed = await service.execute('project_open', {
        source: { kind: 'resume', project_path: projectPath },
      });
      assert.equal(resumed.project_id, scope.project_id);
      assert.equal(resumed.revision, before);
      assert.equal(openedImage(resumed).id, image.id);
      const persisted = data(
        await service.execute('strings_find', {
          ...scope,
          query: { text: 'open-decomp trusted fixture v1', match: 'exact' },
        }),
      );
      assert.deepEqual(persisted.items, strings.items);
      const reopenedFunction = data(
        await service.execute('function_get', {
          project_id: scope.project_id,
          revision: scope.revision,
          function_id: reference.from_function,
        }),
      );
      if (reopenedFunction.view !== 'metadata') assert.fail('Wrong function view');
      assert.deepEqual(reopenedFunction.function, metadata.function);
      const old = await service.execute('binary_info', { ...scope, revision: 1, view: 'summary' });
      assert.equal(old.state, 'failed');
      if (old.state === 'failed') assert.equal(old.error.code, 'not_found');
    },
  );

for (const fixture of [
  { name: 'macho-arm64-symbols', native: '_fixture_arithmetic', underscore: true },
  { name: 'corpus-symbols.dll', native: 'fixture_arithmetic', underscore: false },
])
  test(
    `real child ${fixture.name}: name queries apply the platform C-symbol convention only to symbol names`,
    { timeout: 60000 },
    async (t) => {
      const { root, service } = await setup(t);
      const opened = await service.execute('project_open', {
        wait: true,
        source: {
          kind: 'import',
          input_path: join(fixtures, fixture.name),
          project_path: join(root, 'project'),
        },
      });
      const image = openedImage(opened);
      const scope = {
        project_id: opened.project_id!,
        revision: opened.revision!,
        image_id: image.id,
      };
      const exact = (text: string) => ({ text, match: 'exact' as const, case_sensitive: true });
      const find = async (text: string) =>
        data(await service.execute('functions_find', { ...scope, query: exact(text) })).items;
      const symbols = async (text: string) =>
        data(
          await service.execute('symbols_find', {
            ...scope,
            kinds: ['symbol'],
            query: exact(text),
          }),
        ).items;
      assert.equal((await find(fixture.native)).length, 1);
      assert.equal((await symbols(fixture.native)).length, 1);
      // The C spelling is the native spelling minus the Mach-O underscore; no other format has one.
      assert.equal((await find('fixture_arithmetic')).length, 1);
      assert.equal((await symbols('fixture_arithmetic')).length, 1);
      assert.equal((await find('_fixture_arithmetic')).length, fixture.underscore ? 1 : 0);
      assert.equal((await find('__fixture_arithmetic')).length, 0);
      assert.equal(
        data(
          await service.execute('strings_find', {
            ...scope,
            query: { text: '_', match: 'exact', case_sensitive: true },
          }),
        ).items.length,
        0,
      );
    },
  );

test(
  'navigation delivers evidence by ID and evidence_get resolves direct records, closures and pages',
  { timeout: 60000 },
  async (t) => {
    const { root, service } = await setup(t);
    const opened = await service.execute('project_open', {
      wait: true,
      source: {
        kind: 'import',
        input_path: join(fixtures, 'macho-arm64-symbols'),
        project_path: join(root, 'project'),
      },
    });
    const image = openedImage(opened);
    const base = { project_id: opened.project_id!, revision: opened.revision! };
    const functions = await service.execute('functions_find', { ...base, image_id: image.id });
    assert.deepEqual(functions.evidence, []);
    const found = data(functions);
    assert.equal(found.page.evidence_delivery, 'by_reference');
    const fn = found.items.find((item) => item.evidence_ids.length > 0)!;
    assert.ok(fn);
    const direct = data(
      await service.execute('evidence_get', { ...base, evidence_ids: fn.evidence_ids }),
    );
    assert.deepEqual(
      direct.items.map((item) => item.id).toSorted(),
      [...new Set(fn.evidence_ids)].toSorted(),
    );
    const closure = async (limit: number) => {
      const ids: string[] = [];
      let cursor: string | undefined;
      do {
        const page = data(
          await service.execute('evidence_get', {
            ...base,
            evidence_ids: fn.evidence_ids,
            derivation: 'closure',
            page: { limit, ...(cursor === undefined ? {} : { cursor }) },
          }),
        );
        ids.push(...page.items.map((item) => item.id));
        cursor = page.page.next_cursor ?? undefined;
      } while (cursor !== undefined);
      return ids;
    };
    const whole = await closure(1000),
      paged = await closure(1);
    assert.deepEqual(paged, whole);
    assert.equal(new Set(whole).size, whole.length);
    assert.ok(whole.length > direct.items.length, 'closure reaches derived records');
    const all = data(
      await service.execute('evidence_get', {
        ...base,
        evidence_ids: fn.evidence_ids,
        derivation: 'closure',
      }),
    );
    for (const record of all.items)
      for (const id of [...record.derived_from, ...record.conflicts_with])
        assert.ok(whole.includes(id), 'closure is transitively complete');
    const absent = await service.execute('evidence_get', {
      ...base,
      evidence_ids: [fn.evidence_ids[0]!, `evidence_${'0'.repeat(64)}`],
    });
    assert.ok(absent.state === 'failed' && absent.error.code === 'not_found');
    const metadata = data(await service.execute('function_get', { ...base, function_id: fn.id }));
    assert.ok(metadata.view === 'metadata' && metadata.evidence_delivery === 'by_reference');
    const cfg = data(
      await service.execute('function_get', { ...base, function_id: fn.id, view: 'cfg' }),
    );
    assert.ok(cfg.view === 'cfg' && cfg.page.evidence_delivery === 'inline');
  },
);

for (const fixture of [
  { name: 'macho-arm64-symbols', imported: '_puts', instruction: 0x100000aa8n },
  { name: 'pe-x86_64-symbols.exe', imported: 'fixture_check', instruction: 0x140001004n },
])
  test(
    `real child ${fixture.name}: native import navigation and fixed-revision pagination`,
    { timeout: 60000 },
    async (t) => {
      const { root, service } = await setup(t);
      const opened = await service.execute('project_open', {
        wait: true,
        source: {
          kind: 'import',
          input_path: join(fixtures, fixture.name),
          project_path: join(root, 'project'),
        },
      });
      const image = openedImage(opened),
        scope = { project_id: opened.project_id!, revision: opened.revision!, image_id: image.id };
      const imports = data(
        await service.execute('symbols_find', {
          ...scope,
          kinds: ['import'],
          query: { text: fixture.imported, match: 'exact', case_sensitive: true },
        }),
      );
      const references = [];
      for (const item of imports.items) {
        if (item.kind !== 'import') assert.fail('Wrong symbol kind');
        const xrefs = data(
          await service.execute('xrefs_get', {
            project_id: scope.project_id,
            revision: scope.revision,
            target: { kind: 'entity', id: item.import.id },
            direction: 'incoming',
            kinds: ['call'],
          }),
        );
        references.push(...xrefs.items);
      }
      const call = references.find((item) => BigInt(item.from.value) === fixture.instruction);
      assert.ok(call?.from_function && call.from_instruction);
      const metadata = data(
        await service.execute('function_get', {
          project_id: scope.project_id,
          revision: scope.revision,
          function_id: call.from_function,
        }),
      );
      if (metadata.view !== 'metadata') assert.fail('Wrong function view');
      assert.ok(
        metadata.function.ranges.some(
          (range) =>
            fixture.instruction >= BigInt(range.start.value) &&
            fixture.instruction < BigInt(range.start.value) + BigInt(range.size),
        ),
      );
      const collect = async (limit: number) => {
        const ids: string[] = [];
        let cursor: string | undefined;
        do {
          const page = data(
            await service.execute('functions_find', {
              ...scope,
              page: { limit, ...(cursor ? { cursor } : {}) },
            }),
          );
          ids.push(...page.items.map((item) => item.id));
          cursor = page.page.next_cursor ?? undefined;
        } while (cursor);
        return ids;
      };
      const singles = await collect(1),
        wide = await collect(1000);
      assert.deepEqual(singles, wide);
      assert.equal(new Set(singles).size, singles.length);
      // The PE entry executable has one grounded function but two native imports.
      const first = data(
        await service.execute('symbols_find', { ...scope, kinds: ['import'], page: { limit: 1 } }),
      );
      assert.ok(first.page.next_cursor);
      const mismatch = await service.execute('symbols_find', {
        ...scope,
        kinds: ['import'],
        query: { text: 'different' },
        page: { cursor: first.page.next_cursor },
      });
      assert.equal(mismatch.state, 'failed');
      if (mismatch.state === 'failed') assert.equal(mismatch.error.code, 'stale_cursor');
      const stale = await service.execute('symbols_find', {
        ...scope,
        kinds: ['import'],
        revision: 1,
        page: { cursor: first.page.next_cursor },
      });
      assert.equal(stale.state, 'failed');
      if (stale.state === 'failed') assert.equal(stale.error.code, 'stale_cursor');
      const partial = await service.execute('xrefs_get', {
        project_id: scope.project_id,
        revision: scope.revision,
        target: { kind: 'entity', id: call.from_function },
        direction: 'outgoing',
      });
      assert.equal(partial.state, 'partial');
      assert.equal(data(partial).page.index_state, 'partial');
      const limited = await service.execute('symbols_find', { ...scope, budget: { work: 1 } });
      assert.equal(limited.state, 'failed');
      if (limited.state === 'failed') assert.equal(limited.error.code, 'resource_limit');
      const ticket = await service.submit('functions_find', scope);
      const cancelled = await ticket.cancel();
      assert.equal(cancelled.job.state, 'cancelled');
      const status = data(
        await service.execute('analysis_status', {
          project_id: scope.project_id,
          revision: scope.revision,
          job_id: ticket.id,
        }),
      );
      assert.equal(status.job.state, 'cancelled');
      const cancelAgain = data(
        await service.execute('analysis_cancel', {
          project_id: scope.project_id,
          revision: scope.revision,
          job_id: ticket.id,
        }),
      );
      assert.equal(cancelAgain.outcome, 'cancelled');
      assert.equal((await service.execute('binary_info', { ...scope })).revision, scope.revision);
    },
  );

test(
  'real child memory reads preserve full-width typed bits, zero-fill, holes and bounded continuation',
  { timeout: 60000 },
  async (t) => {
    const { root, service } = await setup(t);
    const opened = await service.execute('project_open', {
      wait: true,
      source: {
        kind: 'import',
        input_path: join(fixtures, 'corpus-symbols.dll'),
        project_path: join(root, 'project'),
      },
    });
    const image = openedImage(opened),
      scope = { project_id: opened.project_id!, revision: opened.revision!, image_id: image.id };
    const mappings = data(await service.execute('binary_info', { ...scope, view: 'mappings' }));
    if (mappings.view !== 'mappings') assert.fail('Wrong binary view');
    const zero = mappings.items.find((item) => BigInt(item.memory_size) > BigInt(item.file_size));
    assert.ok(zero);
    const zeroAddress = {
      image_id: image.id,
      space: 'va' as const,
      value: `0x${(BigInt(zero.va) + BigInt(zero.file_size)).toString(16)}`,
    };
    const zeros = data(
      await service.execute('memory_read', {
        project_id: scope.project_id,
        revision: scope.revision,
        address: zeroAddress,
        length: 8,
        interpretation: 'u64',
      }),
    );
    assert.equal(zeros.segments[0]!.kind, 'zero_fill');
    assert.equal(zeros.values[0]!.bits, '0x0');
    const hole = data(
      await service.execute('memory_read', {
        project_id: scope.project_id,
        revision: scope.revision,
        address: { image_id: image.id, space: 'va', value: '0x1' },
        length: 8,
        interpretation: 'i64',
      }),
    );
    assert.equal(hole.segments[0]!.kind, 'unmapped');
    assert.deepEqual(hole.values, []);
    const raw = await readFile(join(fixtures, 'corpus-symbols.dll'));
    const offset = raw.findIndex(
      (_byte, index) => index + 8 <= raw.length && raw[index + 7]! >= 128,
    );
    assert.ok(offset >= 0);
    assert.ok(raw.readBigUInt64LE(offset) >= 1n << 63n);
    for (const interpretation of ['i64', 'u64', 'pointer'] as const)
      for (const endian of ['little', 'big'] as const) {
        const read = data(
          await service.execute('memory_read', {
            project_id: scope.project_id,
            revision: scope.revision,
            address: { image_id: image.id, space: 'file', value: `0x${offset.toString(16)}` },
            length: 8,
            interpretation,
            endian,
          }),
        );
        assert.equal(
          BigInt(read.values[0]!.bits),
          endian === 'little' ? raw.readBigUInt64LE(offset) : raw.readBigUInt64BE(offset),
        );
      }
    const request: ToolInput<'memory_read'> = {
      project_id: scope.project_id,
      revision: scope.revision,
      address: { image_id: image.id, space: 'file', value: '0x0' },
      length: 4096,
      interpretation: 'bytes',
      endian: 'little',
      budget: { ...DEFAULT_BUDGET, output_bytes: 2048 },
    };
    const bounded = await service.execute('memory_read', request);
    assert.equal(bounded.state, 'partial');
    assert.ok(data(bounded).next_address);
    const prefix = data(bounded)
      .segments.map((segment) => (segment.kind === 'mapped' ? segment.bytes_hex : ''))
      .join('');
    assert.equal(
      prefix,
      raw.subarray(0, Number(BigInt(data(bounded).next_address!.value))).toString('hex'),
    );
  },
);

test(
  'committed annotation revisions and future-revision rejection keep job controls responsive with a stopped owner',
  { timeout: 120000 },
  async (t) => {
    const { root, service } = await setup(t, {
      entry_point: new URL(
        import.meta.url.endsWith('.ts') ? './pause-query.ts' : './pause-query.js',
        import.meta.url,
      ),
      cancel_grace_ms: 10,
    });
    const opened = await service.execute('project_open', {
      wait: true,
      source: {
        kind: 'import',
        input_path: join(fixtures, 'pe-x86_64-symbols.exe'),
        project_path: join(root, 'project'),
      },
    });
    const scope = {
      project_id: opened.project_id!,
      revision: opened.revision!,
      image_id: openedImage(opened).id,
    };
    const sections = data(await service.execute('binary_info', { ...scope, view: 'sections' }));
    assert.ok(sections.view === 'sections');
    const edited = data(
      await service.execute('annotations_apply', {
        project_id: scope.project_id,
        expected_revision: scope.revision,
        author: 'control-regression',
        origin: 'user',
        edits: [
          {
            operation: 'set',
            id: newIdentity('annotation'),
            entity_id: sections.items[0]!.id,
            value: {
              kind: 'note',
              value: 'A committed edit must be visible to host-side controls',
            },
            status: 'asserted',
            evidence_ids: [],
          },
        ],
      }),
    );
    scope.revision = edited.revision;
    let started!: () => void;
    const running = new Promise<void>((resolve) => {
      started = resolve;
    });
    const ticket = await service.submit('functions_find', scope, {
      onProgress: (job) => {
        if (job.state === 'running') started();
      },
    });
    await running;
    await waitForWorkerPause(ticket.id, t);
    const future = await service.execute('analysis_status', {
      project_id: scope.project_id,
      revision: scope.revision + 1,
      job_id: ticket.id,
    });
    assert.ok(future.state === 'failed');
    assert.equal(future.error.code, 'stale_revision');
    assert.equal(future.current_revision, scope.revision);
    const status = data(
      await service.execute('analysis_status', {
        project_id: scope.project_id,
        revision: scope.revision,
        job_id: ticket.id,
      }),
    );
    assert.equal(status.job.state, 'running');
    const reject = await service.execute('project_close', {
      project_id: scope.project_id,
      revision: scope.revision,
      running_jobs: 'reject',
    });
    assert.equal(reject.state, 'failed');
    if (reject.state === 'failed') assert.equal(reject.error.code, 'invalid_input');
    const cancelled = data(
      await service.execute('analysis_cancel', {
        project_id: scope.project_id,
        revision: scope.revision,
        job_id: ticket.id,
      }),
    );
    assert.equal(cancelled.job.state, 'cancelled');
    assert.equal((await ticket.result).job.state, 'cancelled');
    let secondStarted!: () => void;
    const secondRunning = new Promise<void>((resolve) => {
      secondStarted = resolve;
    });
    const second = await service.submit('functions_find', scope, {
      onProgress: (job) => {
        if (job.state === 'running') secondStarted();
      },
    });
    await secondRunning;
    await waitForWorkerPause(second.id, t);
    const closed = data(
      await service.execute('project_close', {
        project_id: scope.project_id,
        revision: scope.revision,
        running_jobs: 'cancel',
      }),
    );
    assert.equal(closed.closed, true);
    assert.equal(closed.persisted_revision, scope.revision);
    assert.equal((await second.result).job.state, 'cancelled');
  },
);

test(
  'lost annotation responses preserve one committed revision and never retry the mutation',
  { timeout: 120000 },
  async (t) => {
    const { root, service } = await setup(t, {
      entry_point: new URL(
        import.meta.url.endsWith('.ts') ? './pause-annotation.ts' : './pause-annotation.js',
        import.meta.url,
      ),
      cancel_grace_ms: 10,
    });
    const project_path = join(root, 'project');
    const opened = await service.execute('project_open', {
      wait: true,
      source: { kind: 'import', input_path: join(fixtures, 'pe-x86_64-symbols.exe'), project_path },
    });
    const scope = { project_id: opened.project_id!, revision: opened.revision! };
    const fn = data(
      await service.execute('functions_find', { ...scope, image_id: openedImage(opened).id }),
    ).items[0]!;
    const id = newIdentity('annotation');
    let started!: (job: string) => void;
    const running = new Promise<string>((resolve) => {
      started = resolve;
    });
    const response = service.execute(
      'annotations_apply',
      {
        project_id: scope.project_id,
        expected_revision: scope.revision,
        author: 'lost-response-regression',
        origin: 'user',
        edits: [
          {
            operation: 'set',
            id,
            entity_id: fn.id,
            value: { kind: 'note', value: 'Committed exactly once' },
            status: 'asserted',
            evidence_ids: [],
          },
        ],
      },
      {
        onProgress: (job) => {
          if (job.progress.phase === 'annotations') started(job.id);
        },
      },
    );
    const job_id = await running;
    await waitForWorkerPause(job_id, t);
    const cancelled = data(await service.execute('analysis_cancel', { ...scope, job_id }));
    assert.equal(cancelled.job.state, 'completed');
    assert.equal(cancelled.outcome, 'already_finished');
    const lost = await response;
    assert.ok(lost.state === 'failed');
    assert.equal(lost.error.code, 'not_found');
    assert.equal(lost.current_revision, scope.revision + 1);
    const current = data(
      await service.execute('function_get', {
        ...scope,
        revision: scope.revision + 1,
        function_id: fn.id,
        view: 'metadata',
      }),
    );
    assert.ok(current.view === 'metadata');
    assert.deepEqual(
      current.annotations
        .filter((annotation) => annotation.id === id)
        .map((annotation) => annotation.value),
      [{ kind: 'note', value: 'Committed exactly once' }],
    );
    const historical = data(
      await service.execute('function_get', { ...scope, function_id: fn.id, view: 'metadata' }),
    );
    assert.ok(historical.view === 'metadata');
    assert.equal(
      historical.annotations.some((annotation) => annotation.id === id),
      false,
    );
    const closed = data(
      await service.execute('project_close', { ...scope, revision: scope.revision + 1 }),
    );
    assert.equal(closed.persisted_revision, scope.revision + 1);
  },
);

test(
  'navigation presents only unique asserted names and keeps native names searchable across batches',
  { timeout: 60000 },
  async (t) => {
    const { root, service } = await setup(t);
    const opened = await service.execute('project_open', {
      wait: true,
      source: {
        kind: 'import',
        input_path: join(fixtures, 'macho-arm64-symbols'),
        project_path: join(root, 'project'),
      },
    });
    const scope = {
      project_id: opened.project_id!,
      revision: opened.revision!,
      image_id: openedImage(opened).id,
    };
    const listed = data(await service.execute('functions_find', scope)).items;
    assert.ok(listed.length >= 3, 'fixture must contain three functions');
    const [unique, conflicting, hypothesized] = listed as [
      (typeof listed)[number],
      (typeof listed)[number],
      (typeof listed)[number],
    ];
    const name = (entity_id: string, value: string, status: 'asserted' | 'hypothesis') => ({
      operation: 'set' as const,
      id: newIdentity('annotation'),
      entity_id,
      value: { kind: 'name' as const, value },
      status,
      evidence_ids: [],
    });
    const edited = data(
      await service.execute('annotations_apply', {
        project_id: scope.project_id,
        expected_revision: scope.revision,
        author: 'batched-presentation',
        origin: 'user',
        edits: [
          name(unique.id, 'reviewed_unique', 'asserted'),
          name(conflicting.id, 'reviewed_first', 'asserted'),
          name(conflicting.id, 'reviewed_second', 'asserted'),
          name(hypothesized.id, 'reviewed_hypothesis', 'hypothesis'),
        ],
      }),
    );
    const current = { ...scope, revision: edited.revision };
    const find = async (text: string, match: 'exact' | 'contains' = 'exact') =>
      data(
        await service.execute('functions_find', {
          ...current,
          query: { text, match, case_sensitive: true },
        }),
      ).items;
    assert.deepEqual(
      (await find('reviewed_unique')).map((fn) => [fn.id, fn.display_name, fn.original_name]),
      [[unique.id, 'reviewed_unique', unique.original_name]],
    );
    // The previous native name stays searchable, but presents the assertion.
    assert.ok(
      (await find(unique.original_name!)).some(
        (fn) => fn.id === unique.id && fn.display_name === 'reviewed_unique',
      ),
    );
    assert.deepEqual(await find('reviewed_first'), []);
    assert.deepEqual(await find('reviewed_hypothesis'), []);
    const all = data(await service.execute('functions_find', current)).items;
    assert.equal(all.length, listed.length);
    assert.equal(
      all.find((fn) => fn.id === conflicting.id)?.display_name,
      conflicting.display_name,
    );
    assert.equal(
      all.find((fn) => fn.id === hypothesized.id)?.display_name,
      hypothesized.display_name,
    );
    // An early revision never sees later assertions.
    assert.deepEqual(
      data(
        await service.execute('functions_find', {
          ...scope,
          query: { text: 'reviewed_unique', match: 'exact', case_sensitive: true },
        }),
      ).items,
      [],
    );
    const symbol = data(
      await service.execute('symbols_find', { ...current, kinds: ['symbol'] }),
    ).items.find((item) => item.kind === 'symbol' && item.symbol.original_name !== null);
    assert.ok(symbol?.kind === 'symbol');
    const renamed = data(
      await service.execute('annotations_apply', {
        project_id: scope.project_id,
        expected_revision: edited.revision,
        author: 'batched-presentation',
        origin: 'user',
        edits: [name(symbol.symbol.id, 'reviewed_symbol', 'asserted')],
      }),
    );
    const presented = data(
      await service.execute('symbols_find', {
        ...scope,
        revision: renamed.revision,
        kinds: ['symbol'],
        query: { text: 'reviewed_symbol', match: 'exact', case_sensitive: true },
      }),
    ).items;
    assert.deepEqual(
      presented.map((item) => item.kind === 'symbol' && [item.symbol.id, item.symbol.display_name]),
      [[symbol.symbol.id, 'reviewed_symbol']],
    );
  },
);

for (const [file, fragment] of [
  ['objc-cxx.dylib', 'fixture::bar'],
  ['metadata.dll', 'fixture::bar'],
  ['swift.dylib', 'FixtureMetadata.metadataSum'],
] as const)
  test(
    `real child metadata ${file}: native and decorated names remain searchable`,
    { timeout: 60000 },
    async (t) => {
      const { root, service } = await setup(t);
      const opened = await service.execute('project_open', {
        wait: true,
        source: {
          kind: 'import',
          input_path: resolve('test/metadata/fixtures', file),
          project_path: join(root, 'project'),
        },
      });
      const scope = {
        project_id: opened.project_id!,
        revision: opened.revision!,
        image_id: openedImage(opened).id,
      };
      const decorated = data(
        await service.execute('symbols_find', {
          ...scope,
          kinds: ['symbol', 'export'],
          query: { text: fragment },
        }),
      );
      const labels = decorated.items.map((item) =>
        item.kind === 'symbol' ? item.symbol : item.kind === 'export' ? item.export : item.import,
      );
      const named = labels.find(
        (item) => item.original_name && item.display_name?.includes(fragment),
      );
      assert.ok(named?.original_name);
      const native = data(
        await service.execute('symbols_find', {
          ...scope,
          kinds: ['symbol', 'export'],
          query: { text: named.original_name, match: 'exact', case_sensitive: true },
        }),
      );
      assert.ok(
        native.items.some(
          (item) =>
            (item.kind === 'symbol'
              ? item.symbol.id
              : item.kind === 'export'
                ? item.export.id
                : item.import.id) === named.id,
        ),
      );
      const functions = data(
        await service.execute('functions_find', { ...scope, query: { text: fragment } }),
      );
      assert.ok(functions.items.some((fn) => fn.display_name?.includes(fragment)));
      if (file === 'objc-cxx.dylib') {
        const runtime = data(
          await service.execute('symbols_find', {
            ...scope,
            kinds: ['symbol'],
            query: { text: '-[ODObject number]', match: 'exact' },
          }),
        );
        const method = runtime.items.find(
          (item) => item.kind === 'symbol' && item.symbol.kind === 'function',
        );
        assert.ok(method?.kind === 'symbol' && method.symbol.address);
        const code = data(
          await service.execute('functions_find', { ...scope, address: method.symbol.address }),
        );
        assert.ok(code.items.some((fn) => fn.entry.value === method.symbol.address!.value));
        const objects = data(
          await service.execute('symbols_find', {
            ...scope,
            kinds: ['symbol'],
            query: { text: 'ODObject', match: 'exact' },
          }),
        );
        const object = objects.items.find(
          (item) => item.kind === 'symbol' && item.symbol.kind === 'object',
        );
        assert.ok(object?.kind === 'symbol' && object.symbol.address);
        const nonCode = data(
          await service.execute('functions_find', { ...scope, address: object.symbol.address }),
        );
        assert.deepEqual(nonCode.items, []);
      }
    },
  );

test(
  'real child discovery retains truncated entry gaps without sweeping through metadata or unbacked bytes',
  { timeout: 60000 },
  async (t) => {
    const { root, service } = await setup(t);
    const macho = runtimeBytes([]);
    const commandBytes = macho.bytes.readUInt32LE(20),
      command = 32 + commandBytes;
    macho.u32(16, macho.bytes.readUInt32LE(16) + 1);
    macho.u32(20, commandBytes + 24);
    macho.u32(command, 0x80000028);
    macho.u32(command + 4, 24);
    // Aligned ARM64 entry with only two file-backed bytes, followed by unmapped VA.
    macho.u64(64, BigInt(macho.bytes.length - 2));
    macho.u64(80, BigInt(macho.bytes.length - 2));
    macho.u64(command + 8, BigInt(macho.bytes.length - 4));
    macho.u64(command + 16, 0n);
    const pe = await readFile(join(fixtures, 'pe-x86_64-symbols.exe'));
    const nt = pe.readUInt32LE(0x3c),
      optional = nt + 24;
    const sections = optional + pe.readUInt16LE(nt + 20);
    let text = -1;
    for (let index = 0; index < pe.readUInt16LE(nt + 6); index++) {
      const at = sections + index * 40;
      if (
        pe
          .subarray(at, at + 8)
          .toString('ascii')
          .replace(/\0.*$/, '') === '.text'
      )
        text = at;
    }
    assert.ok(text >= 0);
    const rawSize = pe.readUInt32LE(text + 16),
      rawOffset = pe.readUInt32LE(text + 20);
    pe.writeUInt32LE(pe.readUInt32LE(text + 12) + rawSize - 1, optional + 16);
    pe[rawOffset + rawSize - 1] = 0x0f;
    for (const [index, bytes, available] of [
      [0, macho.bytes.subarray(0, -2), 2],
      [1, pe, 1],
    ] as const) {
      const source = join(root, `truncated-${index}`);
      await writeFile(source, bytes);
      const opened = await service.execute('project_open', {
        wait: true,
        source: {
          kind: 'import',
          input_path: source,
          project_path: join(root, `project-${index}`),
        },
      });
      const image = openedImage(opened),
        address = image.entry_points[0];
      assert.ok(address);
      const scope = {
        project_id: opened.project_id!,
        revision: opened.revision!,
        image_id: image.id,
      };
      const fn = data(await service.execute('functions_find', { ...scope, address })).items.find(
        (item) => item.entry.value === address.value,
      );
      assert.ok(fn);
      const decoded = await service.execute('function_get', {
        project_id: scope.project_id,
        revision: scope.revision,
        function_id: fn.id,
        view: 'disassembly',
      });
      assert.equal(decoded.state, 'partial');
      const view = data(decoded);
      if (view.view !== 'disassembly') assert.fail('Wrong function view');
      assert.deepEqual(view.items, []);
      assert.ok(
        view.gaps.some(
          (gap) => gap.reason === 'truncated' && Number(BigInt(gap.range.size)) === available,
        ),
      );
      const memory = data(
        await service.execute('memory_read', {
          project_id: scope.project_id,
          revision: scope.revision,
          address,
          length: 4,
        }),
      );
      assert.equal(memory.segments[0]!.kind, 'mapped');
      assert.equal(Number(BigInt(memory.segments[0]!.range.size)), available);
      assert.equal(memory.segments[1]!.kind, 'unmapped');
      data(
        await service.execute('project_close', {
          project_id: scope.project_id,
          revision: scope.revision,
        }),
      );
    }
  },
);

test(
  'types_declare commits one revision per batch, redeclares in place and rejects any parse error whole',
  { timeout: 120000 },
  async (t) => {
    const { root, service } = await setup(t);
    const opened = await service.execute('project_open', {
      wait: true,
      source: {
        kind: 'import',
        input_path: join(fixtures, 'pe-x86_64-symbols.exe'),
        project_path: join(root, 'project'),
      },
    });
    const image_id = openedImage(opened).id,
      project_id = opened.project_id!;
    let revision = opened.revision!;
    const declare = (source: string) =>
      service.execute('types_declare', {
        project_id,
        expected_revision: revision,
        image_id,
        author: 'type-library',
        origin: 'llm',
        source,
      });
    const library = async () => {
      const types = data(
        await service.execute('binary_info', { project_id, revision, image_id, view: 'types' }),
      );
      assert.ok(types.view === 'types');
      return types.library;
    };
    // windows-x64 is LLP64: `long` is 32-bit.
    const first = data(
      await declare(
        'typedef struct Item { long count; char tag; struct Item *next; } Item;\nunion Word { uint32_t u; float f; };',
      ),
    );
    assert.equal(first.revision, revision + 1);
    revision = first.revision;
    const named = (name: string) => first.types.find((type) => type.name === name)!;
    const keyed = (types: typeof first.types, key: string) =>
      types.find((type) => type.key === key)!;
    assert.deepEqual(
      (await library()).filter((item) => item.name !== null).map((item) => item.declaration),
      [
        'struct Item { int32_t count; int8_t tag; struct Item *next; };',
        'union Word { uint32_t u; float f; };',
      ],
    );
    // Each named type gets one pointer type (no name, key `Name*`): the parser's own
    // `struct Item *` is that type.
    const itemPointer = keyed(first.types, 'Item*');
    assert.equal(itemPointer.name, null);
    assert.equal(keyed(first.types, 'Item$next').type_id, itemPointer.type_id);
    assert.equal(keyed(first.types, 'Item$next').annotation_id, itemPointer.annotation_id);
    assert.deepEqual(
      (await library())
        .filter((item) => item.name === null && item.declaration.endsWith('*'))
        .map((item) => item.declaration)
        .sort(),
      ['struct Item *', 'union Word *'],
    );
    const failed = await declare(
      'struct Item { int32_t count; };\nstruct Broken { int32_t x: 1; };',
    );
    assert.equal(failed.state, 'failed');
    assert.ok('error' in failed && /line 2/.test(failed.error.message));
    assert.ok('current_revision' in failed && failed.current_revision === revision);
    const second = data(await declare('struct Item { int64_t count; };'));
    assert.equal(second.revision, revision + 1);
    assert.equal(
      second.types.find((type) => type.name === 'Item')!.annotation_id,
      named('Item').annotation_id,
    );
    assert.deepEqual(keyed(second.types, 'Item*'), itemPointer, 'the pointer type is stable');
    revision = second.revision;
    const items = await library();
    assert.equal(items.filter((item) => item.name === 'Item').length, 1);
    assert.equal(
      items.find((item) => item.name === 'Item')!.declaration,
      'struct Item { int64_t count; };',
    );
    assert.ok(
      items.some((item) => item.name === 'Word'),
      'other declarations stay',
    );
    // A tag only mentioned (here through a pointer typedef) keeps its library definition.
    const third = data(await declare('typedef struct Item *ItemRef;'));
    revision = third.revision;
    assert.equal(
      third.types.find((type) => type.name === 'Item')!.annotation_id,
      named('Item').annotation_id,
    );
    assert.deepEqual(
      (await library())
        .filter((item) => item.name === 'Item' || item.name === 'ItemRef')
        .map((item) => item.declaration),
      ['struct Item { int64_t count; };', 'typedef struct Item *ItemRef;'],
    );
    assert.equal(
      (await library()).find((item) => item.type_id === keyed(third.types, 'ItemRef*').type_id)!
        .declaration,
      'ItemRef *',
    );
    const forward = await declare('struct Item;');
    assert.equal(forward.state, 'failed');
  },
);
