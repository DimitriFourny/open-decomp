#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { arch, platform, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Client } from '@modelcontextprotocol/client';
import {
  imageIdentity,
  sliceIdentity,
  type Budget,
  type ToolResult,
  type WireJob,
} from '../src/core/index.js';
import {
  callMcpTool,
  readAnalysis,
  readMcpFixture,
  resultData,
  runMcpWorkflows,
  withMcpClient,
  type McpWorkflowOptions,
} from './mcp-workflow.js';

interface Scope {
  readonly project_id: string;
  readonly revision: number;
}
const digest = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const hex = (value: number | bigint): string => `0x${value.toString(16)}`;
const host = { platform: platform(), architecture: arch(), node: process.version };
function evidence(scenario: string, details: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify({ scenario, host, outcome: 'passed', ...details })}\n`);
}
function scopeOf(result: ToolResult<'project_open'>): Scope {
  assert.ok(result.project_id !== null && result.revision !== null);
  return { project_id: result.project_id, revision: result.revision };
}
async function open(client: Client, input_path: string, project_path: string, slice_id?: string) {
  const result = await callMcpTool(client, 'project_open', {
    source: { kind: 'import', input_path, project_path, ...(slice_id ? { slice_id } : {}) },
    wait: true,
  });
  assert.equal(result.state, 'complete', JSON.stringify(result));
  const image = resultData(result).image;
  assert.ok(image);
  return { scope: scopeOf(result), image };
}
async function close(client: Client, scope: Scope): Promise<void> {
  assert.equal(
    resultData(await callMcpTool(client, 'project_close', { ...scope, running_jobs: 'wait' }))
      .persisted_revision,
    scope.revision,
  );
}
async function readBytes(
  client: Client,
  scope: Scope,
  image_id: string,
  space: 'file' | 'va' | 'rva',
  value: string,
  expected: Uint8Array,
): Promise<void> {
  const result = await callMcpTool(client, 'memory_read', {
    ...scope,
    address: { image_id, space, value },
    length: expected.length,
  });
  assert.equal(result.state, 'complete');
  const data = resultData(result);
  assert.equal(data.segments.length, 1);
  const segment = data.segments[0]!;
  assert.equal(segment.kind, 'mapped');
  if (segment.kind !== 'mapped') assert.fail('Expected immutable file backing');
  assert.equal(segment.bytes_hex, Buffer.from(expected).toString('hex'));
}
async function findFunction(client: Client, scope: Scope, image_id: string, address: string) {
  const functions = resultData(
    await callMcpTool(client, 'functions_find', {
      ...scope,
      image_id,
      address: { image_id, space: 'va', value: address },
    }),
  );
  const fn = functions.items.find((item) => item.entry.value === address);
  assert.ok(fn, `No function at ${address}`);
  return fn;
}
async function terminalJob(client: Client, scope: Scope, admitted: WireJob): Promise<WireJob> {
  // Each iteration awaits the real status response; there is no timing-dependent sleep or race gate.
  const deadline = Date.now() + 90000;
  do {
    const status = resultData(
      await callMcpTool(client, 'analysis_status', { ...scope, job_id: admitted.id }),
    );
    assert.equal(status.known_revision, scope.revision);
    assert.equal(status.job.id, admitted.id);
    if (!['queued', 'running'].includes(status.job.state)) return status.job;
  } while (Date.now() < deadline);
  assert.fail(`Job ${admitted.id} did not reach a terminal state`);
}

async function nativeVariants(
  client: Client,
  options: McpWorkflowOptions,
  root: string,
): Promise<void> {
  const thin = await readMcpFixture(options.fixtures, 'bin/macho-arm64-symbols');
  const universal = await readMcpFixture(options.fixtures, 'bin/macho-universal');
  assert.deepEqual(universal.subarray(32768, 32768 + thin.length), thin);
  const selected = sliceIdentity(
    imageIdentity(digest(universal)),
    32768n,
    BigInt(thin.length),
    'arm64',
  );
  const { scope, image } = await open(
    client,
    join(options.fixtures, 'macho-universal'),
    join(root, 'universal'),
    selected,
  );
  assert.equal(image.sha256, digest(universal));
  assert.equal(image.selected_slice_id, selected);
  assert.equal(image.target.architecture, 'arm64');
  assert.equal(image.target.abi, 'darwin-arm64');
  const slice = image.slices.find((item) => item.id === selected);
  assert.ok(slice);
  assert.equal(BigInt(slice.offset), 32768n);
  assert.equal(BigInt(slice.size), BigInt(thin.length));
  assert.equal(slice.supported, true);
  assert.ok(image.slices.some((item) => item.architecture === 'x86_64' && !item.supported));
  assert.ok(
    image.entry_points.some((entry) => entry.space === 'va' && entry.value === '0x100000a8c'),
  );
  const fn = await findFunction(client, scope, image.id, '0x100000574');
  const instructions = resultData(
    await callMcpTool(client, 'function_get', {
      ...scope,
      function_id: fn.id,
      view: 'disassembly',
    }),
  );
  assert.ok(instructions.view === 'disassembly');
  assert.equal(instructions.items[0]?.address.value, '0x100000574');
  await readBytes(client, scope, image.id, 'file', hex(32768 + 1396), thin.subarray(1396, 1416));
  await readBytes(client, scope, image.id, 'va', '0x100000574', thin.subarray(1396, 1416));
  const mappings = resultData(
    await callMcpTool(client, 'binary_info', { ...scope, view: 'mappings' }),
  );
  assert.ok(mappings.view === 'mappings');
  assert.ok(
    mappings.items.some((item) => item.va === '0x100000000' && BigInt(item.file_offset) === 32768n),
  );
  await close(client, scope);
  evidence('universal-arm64-selection', {
    fixture: 'macho-universal',
    sha256: image.sha256,
    slice_offset: slice.offset,
    va: fn.entry.value,
    container_file_offset: hex(32768 + 1396),
  });

  for (const file of ['pe-x86_64-symbols.exe', 'pe-x86_64-stripped.exe']) {
    const bytes = await readMcpFixture(options.fixtures, `bin/${file}`);
    const opened = await open(client, join(options.fixtures, file), join(root, file));
    const { scope, image } = opened;
    assert.equal(image.sha256, digest(bytes));
    assert.equal(image.target.format, 'pe');
    assert.equal(image.target.architecture, 'x86_64');
    assert.equal(image.target.abi, 'windows-x64');
    assert.equal(image.image_base, '0x140000000');
    assert.ok(
      image.entry_points.some((entry) => entry.value === '0x140001000' && entry.space === 'va'),
    );
    const headers = resultData(
      await callMcpTool(client, 'binary_info', { ...scope, view: 'headers' }),
    );
    assert.ok(headers.view === 'headers');
    const machine = headers.items
      .flatMap((item) => item.fields)
      .find((field) => field.name === 'Machine');
    assert.ok(machine?.kind === 'integer');
    assert.equal(BigInt(machine.value), 0x8664n);
    const imports = resultData(
      await callMcpTool(client, 'symbols_find', {
        ...scope,
        image_id: image.id,
        kinds: ['import'],
      }),
    );
    const names = imports.items
      .map((item) => {
        assert.ok(item.kind === 'import');
        assert.ok(item.import.slot);
        return `${item.import.library}!${item.import.original_name}`;
      })
      .sort();
    assert.deepEqual(
      names,
      ['KERNEL32.dll!ExitProcess', 'corpus-symbols.dll!fixture_check'].sort(),
    );
    const fn = await findFunction(client, scope, image.id, '0x140001000');
    const disassembly = resultData(
      await callMcpTool(client, 'function_get', {
        ...scope,
        function_id: fn.id,
        view: 'disassembly',
      }),
    );
    assert.ok(disassembly.view === 'disassembly');
    for (const item of imports.items) {
      assert.ok(item.kind === 'import' && item.import.slot);
      const refs = resultData(
        await callMcpTool(client, 'xrefs_get', {
          ...scope,
          target: { kind: 'address', address: item.import.slot },
          direction: 'incoming',
        }),
      );
      assert.ok(
        refs.items.some(
          (ref) =>
            ref.from_function === fn.id &&
            disassembly.items.some((instruction) => instruction.id === ref.from_instruction),
        ),
      );
    }
    const text = bytes.subarray(1024, 1024 + 54);
    for (const [space, value] of [
      ['file', '0x400'],
      ['va', '0x140001000'],
      ['rva', '0x1000'],
    ] as const)
      await readBytes(client, scope, image.id, space, value, text);
    const zeros = resultData(
      await callMcpTool(client, 'memory_read', {
        ...scope,
        address: { image_id: image.id, space: 'va', value: '0x140003000' },
        length: 4,
      }),
    );
    assert.equal(zeros.segments.length, 1);
    assert.equal(zeros.segments[0]!.kind, 'zero_fill');
    await close(client, scope);
    evidence('pe-executable-import-navigation', {
      fixture: file,
      sha256: image.sha256,
      imports: names,
      entry: fn.entry.value,
      byte_spaces: ['file', 'va', 'rva'],
      zero_fill_bytes: 4,
    });
  }
  for (const file of ['libcorpus-arm64-symbols.dylib', 'libcorpus-arm64-stripped.dylib']) {
    const bytes = await readMcpFixture(options.fixtures, `bin/${file}`);
    const { scope, image } = await open(client, join(options.fixtures, file), join(root, file));
    assert.equal(image.sha256, digest(bytes));
    assert.equal(image.target.abi, 'darwin-arm64');
    assert.deepEqual(image.entry_points, []);
    const exports = resultData(
      await callMcpTool(client, 'symbols_find', {
        ...scope,
        image_id: image.id,
        kinds: ['export'],
        query: { text: '_fixture_arithmetic', match: 'exact' },
      }),
    );
    assert.ok(
      exports.items.some(
        (item) => item.kind === 'export' && item.export.address?.value === '0x43c',
      ),
    );
    await readBytes(client, scope, image.id, 'va', '0x43c', bytes.subarray(1084, 1104));
    await close(client, scope);
    evidence('macho-dylib-exports', { fixture: file, sha256: image.sha256, arithmetic: '0x43c' });
  }
}

async function malformedImages(
  client: Client,
  options: McpWorkflowOptions,
  root: string,
): Promise<void> {
  for (const [file, code] of [
    ['empty.bin', 'malformed_image'],
    ['macho-header-truncated.bin', 'malformed_image'],
    ['macho-command-overrun.bin', 'malformed_image'],
    ['macho-command-zero.bin', 'malformed_image'],
    ['macho-unsupported-cpu.bin', 'unsupported_target'],
    ['fat-slice-overrun.bin', 'malformed_image'],
    ['pe-dos-truncated.bin', 'malformed_image'],
    ['pe-header-overrun.bin', 'malformed_image'],
    ['pe-section-overrun.bin', 'malformed_image'],
    ['pe-directory-overrun.bin', 'malformed_image'],
    ['pe-unsupported-machine.bin', 'unsupported_target'],
  ] as const) {
    const bytes = await readMcpFixture(options.fixtures, `malformed/${file}`);
    const input_path = join(root, file),
      project_path = join(root, `${file}-project`);
    await writeFile(input_path, bytes);
    const failed = await callMcpTool(client, 'project_open', {
      source: { kind: 'import', input_path, project_path },
      wait: true,
    });
    assert.equal(failed.state, 'failed', JSON.stringify(failed));
    if (failed.state !== 'failed') assert.fail('Malformed or unsupported target must be rejected');
    assert.equal(failed.error.code, code);
    assert.deepEqual(failed.artifacts, []);
    const resumed = await callMcpTool(client, 'project_open', {
      source: { kind: 'resume', project_path },
    });
    assert.ok(resumed.state === 'partial');
    assert.equal(resumed.reason, 'incomplete_index');
    assert.equal(resumed.revision, 0);
    assert.equal(resumed.data.image, null);
    const scope = scopeOf(resumed);
    const absent = await callMcpTool(client, 'binary_info', scope);
    assert.ok(absent.state === 'failed');
    assert.equal(absent.error.code, 'not_found');
    await close(client, scope);
    evidence('rejected-image-persisted-inspection', {
      fixture: file,
      sha256: digest(bytes),
      error: code,
      persisted_revision: 0,
      image: null,
    });
  }
}

async function boundedAnalysis(
  client: Client,
  options: McpWorkflowOptions,
  root: string,
): Promise<void> {
  for (const [file, address] of [
    ['macho-arm64-symbols', '0x100000574'],
    ['corpus-symbols.dll', '0x180001030'],
  ] as const) {
    const bytes = await readMcpFixture(options.fixtures, `bin/${file}`);
    const project_path = join(root, `${file}-bounds`);
    const { scope, image } = await open(client, join(options.fixtures, file), project_path);
    assert.equal(image.sha256, digest(bytes));
    const fn = await findFunction(client, scope, image.id, address);
    const jobs: WireJob[] = [];
    for (const budget of [
      { instructions: 1 },
      { ir_nodes: 1 },
      { work: 1 },
    ] satisfies Partial<Budget>[]) {
      for (let attempt = 0; attempt < 2; attempt++) {
        const queued = await callMcpTool(client, 'function_decompile', {
          ...scope,
          function_id: fn.id,
          budget,
        });
        assert.ok(queued.state === 'queued');
        const job = await terminalJob(client, scope, queued.job);
        assert.equal(job.state, 'failed');
        assert.equal(job.published_revision, null);
        assert.deepEqual(job.artifacts, []);
        assert.ok(job.diagnostics.some((item) => item.code === 'resource_limit'));
        jobs.push(job);
      }
    }
    await close(client, scope);
    const resumed = await callMcpTool(client, 'project_open', {
      source: { kind: 'resume', project_path },
    });
    assert.equal(resumed.state, 'complete');
    assert.deepEqual(scopeOf(resumed), scope);
    for (const job of jobs)
      assert.deepEqual(
        resultData(await callMcpTool(client, 'analysis_status', { ...scope, job_id: job.id })).job,
        job,
      );
    const normal = await callMcpTool(client, 'function_decompile', {
      ...scope,
      function_id: fn.id,
      wait: true,
    });
    const payload = await readAnalysis(client, normal.artifacts[0]!);
    assert.equal(payload.result.state, 'complete');
    assert.equal(resultData(payload.result).cache, 'computed');
    const disassembly = resultData(
      await callMcpTool(client, 'function_get', {
        ...scope,
        function_id: fn.id,
        view: 'disassembly',
      }),
    );
    const data = resultData(payload.result);
    assert.ok(disassembly.view === 'disassembly' && data.delivery === 'inline');
    for (const instruction of disassembly.items) {
      const ref = data.emission.ids.indexOf(instruction.id);
      assert.ok(data.emission.mappings.some((mapping) => mapping.instruction_refs.includes(ref)));
    }
    const cached = await callMcpTool(client, 'function_decompile', {
      ...scope,
      function_id: fn.id,
      wait: true,
    });
    assert.equal(resultData(cached).cache, 'hit');
    assert.deepEqual(cached.artifacts, normal.artifacts);
    await close(client, scope);
    evidence('analysis-bounds-no-publication', {
      fixture: file,
      sha256: image.sha256,
      failed_jobs: jobs.length,
      budgets: ['instructions', 'ir_nodes', 'work'],
      persisted_revision: scope.revision,
      recovered_cache: 'computed-then-hit',
    });
  }
}

async function unsupportedEffects(
  client: Client,
  options: McpWorkflowOptions,
  root: string,
): Promise<void> {
  for (const scenario of [
    {
      file: 'macho-arm64-symbols',
      offset: 1396,
      address: '0x100000574',
      // DMB ISH (d5033bbf) is a supported memory_fence since 098a336 (docs/ARM64.md);
      // DSB ISH remains an unsupported barrier family (test/lifters/arm64/barrier.test.ts).
      encoding: '9f3b03d5',
      operation: 'dsb ish',
    },
    {
      file: 'corpus-symbols.dll',
      offset: 1072,
      address: '0x180001030',
      encoding: 'd9e890',
      operation: 'fld1; nop (same three-byte instruction footprint)',
    },
  ]) {
    const bytes = await readMcpFixture(options.fixtures, `bin/${scenario.file}`);
    const source_sha256 = digest(bytes);
    const patch = Buffer.from(scenario.encoding, 'hex');
    bytes.set(patch, scenario.offset);
    const input_path = join(root, `${scenario.file}-unsupported-input`),
      project_path = join(root, `${scenario.file}-unsupported-project`);
    await writeFile(input_path, bytes);
    const { scope, image } = await open(client, input_path, project_path);
    assert.equal(image.sha256, digest(bytes));
    const fn = await findFunction(client, scope, image.id, scenario.address);
    const disassembly = resultData(
      await callMcpTool(client, 'function_get', {
        ...scope,
        function_id: fn.id,
        view: 'disassembly',
      }),
    );
    // Omitted `detail` is the full form (tools.ts disassembly schema); only compact is tagged.
    assert.ok(disassembly.view === 'disassembly' && disassembly.detail !== 'compact');
    const instruction = disassembly.items.find((item) => item.address.value === scenario.address);
    assert.ok(instruction);
    assert.equal(
      instruction.validity,
      'valid',
      'Recognized but unsupported semantics must not be mislabeled invalid decoding',
    );
    assert.equal(
      instruction.flow.kind,
      'fallthrough',
      'Unsupported semantics must not be invented decoder traps',
    );
    await readBytes(client, scope, image.id, 'va', scenario.address, patch);
    const response = await callMcpTool(client, 'function_decompile', {
      ...scope,
      function_id: fn.id,
      wait: true,
    });
    const payload = await readAnalysis(client, response.artifacts[0]!);
    assert.ok(payload.result.state === 'partial');
    assert.equal(payload.result.reason, 'unsupported_subset');
    assert.ok(
      payload.result.coverage.some(
        (item) =>
          item.layer === 'lift' &&
          item.state === 'partial' &&
          typeof item.total_units === 'number' &&
          item.completed_units < item.total_units,
      ),
    );
    assert.ok(payload.result.diagnostics.some((item) => item.code === 'unavailable_semantics'));
    const data = resultData(payload.result);
    assert.ok(data.delivery === 'inline');
    const instructionRef = data.emission.ids.indexOf(instruction.id);
    assert.ok(
      data.emission.mappings.some(
        (mapping) =>
          mapping.instruction_refs.includes(instructionRef) &&
          mapping.range_refs.some((ref) => {
            const range = data.emission.ranges[ref]!;
            return (
              range.start.image_id === image.id &&
              range.start.space === instruction.bytes.start.space &&
              range.start.value === instruction.bytes.start.value &&
              range.size === instruction.bytes.size
            );
          }),
      ),
      'The unsupported instruction must retain its exact original byte provenance',
    );
    const artifact = response.artifacts[0]!;
    await close(client, scope);
    // Destroy only our temporary source: resume must use the project-owned immutable image and artifact.
    await writeFile(input_path, Buffer.alloc(bytes.length));
    const resumed = await callMcpTool(client, 'project_open', {
      source: { kind: 'resume', project_path },
    });
    assert.equal(resumed.state, 'complete');
    assert.deepEqual(scopeOf(resumed), scope);
    assert.equal(resultData(resumed).image?.sha256, image.sha256);
    await readBytes(client, scope, image.id, 'va', scenario.address, patch);
    const cached = await callMcpTool(client, 'function_decompile', {
      ...scope,
      function_id: fn.id,
      wait: true,
    });
    assert.equal(resultData(cached).cache, 'hit');
    assert.deepEqual(cached.artifacts, [artifact]);
    assert.deepEqual((await readAnalysis(client, artifact)).result, payload.result);
    await close(client, scope);
    evidence('unsupported-effect-immutable-resume', {
      fixture: scenario.file,
      source_sha256,
      sha256: image.sha256,
      mutation: {
        file_offset: hex(scenario.offset),
        bytes: scenario.encoding,
        operation: scenario.operation,
      },
      state: 'partial',
      reason: 'unsupported_subset',
      diagnostic: 'unavailable_semantics',
      resumed_cache: 'hit',
    });
  }
}

/** Reuse the complete release oracle against either compiled or installed servers. */
export async function runReleaseAcceptance(options: McpWorkflowOptions): Promise<void> {
  for (const summary of await runMcpWorkflows(options))
    evidence('full-investigation', { ...summary, server_entry: options.serverEntry });
  const root = await realpath(
    await mkdtemp(join(options.temporaryRoot ?? tmpdir(), 'open-decomp-release-')),
  );
  try {
    await withMcpClient(options, root, async (client) => {
      await nativeVariants(client, options, root);
      await malformedImages(client, options, root);
      await boundedAnalysis(client, options, root);
      await unsupportedEffects(client, options, root);
    });
    evidence('release-scenarios-complete', {
      server_entry: options.serverEntry,
      fixtures: options.fixtures,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let serverEntry = fileURLToPath(new URL('../src/cli/entry.js', import.meta.url));
  let fixtures = resolve('fixtures/bin');
  const seen = new Set<string>();
  for (let index = 2; index < process.argv.length; index++) {
    const flag = process.argv[index]!;
    if (flag === '--help' && process.argv.length === 3) {
      process.stderr.write(
        'Usage: node dist/scripts/release-acceptance.js [--server-entry PATH] [--fixtures PATH]\nRun the maintained Mach-O/Darwin, PE/Windows and ELF/SysV investigations plus cross-target release failure/native-variant scenarios through compiled or installed MCP stdio. Fixtures is the bin directory alongside manifest.json, elf-manifest.json and malformed/. Never executes targets. Output is JSON Lines host/scenario evidence; failures exit nonzero.\n',
      );
      process.exit(0);
    }
    if (flag !== '--server-entry' && flag !== '--fixtures')
      throw new Error('Unknown release acceptance argument');
    if (seen.has(flag)) throw new Error(`Duplicate ${flag}`);
    seen.add(flag);
    const value = process.argv[++index];
    if (!value || value.startsWith('--') || value.includes('\0'))
      throw new Error(`Missing or malformed ${flag}`);
    if (flag === '--server-entry') serverEntry = resolve(value);
    else fixtures = resolve(value);
  }
  await runReleaseAcceptance({ serverEntry, fixtures });
}
