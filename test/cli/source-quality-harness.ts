import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openBinary } from '../../src/api/index.js';
import {
  contentHash,
  toolSchemas,
  type WireEmission,
  type ToolResult,
} from '../../src/core/index.js';
import { callMcpTool, readAnalysis, withMcpClient } from '../../scripts/mcp-workflow.js';
import {
  acknowledgeRequirements,
  emittedFormals,
  execute,
  type EmittedFormal,
  type SourceCallOracle,
} from '../emitters/c/support.js';
import { strnicmpCases, strnicmpOracle } from '../emitters/c/strnicmp-fixture.js';
import { loadBytes } from '../metadata/fixture.js';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const entry = fileURLToPath(new URL('../../src/cli/entry.ts', import.meta.url));
const corpus = fileURLToPath(new URL('../../fixtures/source/corpus.c', import.meta.url));
const fixture = fileURLToPath(new URL('./source-quality.c', import.meta.url));
const dialects = ['c-like', 'python-like'] as const;
export type SourceQualityConsumer = 'cli' | 'api' | 'mcp';
type Dialect = (typeof dialects)[number];
type Result = ToolResult<'function_decompile'>;
type Scenario = 'stack' | 'float' | 'strnicmp' | 'memory' | 'loop' | 'effects';
interface NativeCase {
  scenario: Scenario;
  index: number;
  value: string;
  memory?: string;
  calls?: { argument: string; result: string; memory: string }[];
}
export interface SourceQualityFixture {
  root: string;
  binary: string;
  expected: readonly NativeCase[];
  imageMemory: ReadonlyMap<bigint, number>;
}
export interface SourceQualityEvidence {
  consumer: SourceQualityConsumer;
  function: string;
  dialect: Dialect;
  cases: number;
  state: Result['state'];
  response: string;
}

const stackCases = [
  Array.from({ length: 10 }, (_, index) => BigInt(index + 1)),
  Array<bigint>(10).fill(0n),
  Array<bigint>(10).fill(0xffffffffffffffffn),
  Array.from({ length: 10 }, (_, index) => 0x8000000000000000n + BigInt(index)),
  [
    0n,
    1n,
    0x7fffffffffffffffn,
    0x8000000000000000n,
    0xffffffffffffffffn,
    0x100000000n,
    0xffffffffn,
    0x123456789abcdef0n,
    0xfedcba9876543210n,
    0xffffffffffffffffn,
  ],
  ...Array.from({ length: 10 }, (_, active) =>
    Array.from({ length: 10 }, (_, index) => (index === active ? 0xffffffffffffffffn : 0n)),
  ),
  ...Array.from({ length: 10 }, (_, active) =>
    Array.from({ length: 10 }, (_, index) => (index === active ? 0x8000000000000000n : 0n)),
  ),
];
const floatCases = [
  [4, 3],
  [-2, 0.5],
  [0, 0],
  [-0, -0],
  [1, -3],
  [2 ** 52 + 1, -(2 ** 52)],
  [2 ** -1022, -(2 ** -1022)],
  [Number.MIN_VALUE, Number.MIN_VALUE],
  [Number.MIN_VALUE * 3, -Number.MIN_VALUE],
  [Number.MAX_VALUE / 4, -Number.MAX_VALUE / 4],
] as const;
const memoryCases = [
  [0n, 0n],
  [7n, 11n],
  [0xffffffffffffffffn, 1n],
  [0x8000000000000000n, 0xffffffffffffffffn],
] as const;
const loopCases = [[], [0], [1], [1, 2, 3, 4], [0xffffffff, 1, 5], [0x80000000, 0x80000000]];
const effectCases = [
  [5n, 0n],
  [5n, 2n],
  [0xffffffffffffffffn, 1n],
  [0x8000000000000000n, 0xffffffffffffffffn],
] as const;
const functions: readonly { name: string; scenario: Scenario }[] = [
  { name: '_fixture_stack_args', scenario: 'stack' },
  { name: '_fixture_float', scenario: 'float' },
  { name: '_quality_strnicmp', scenario: 'strnicmp' },
  { name: '_fixture_memory', scenario: 'memory' },
  { name: '_fixture_loop', scenario: 'loop' },
  { name: '_quality_effects', scenario: 'effects' },
];

function bits(value: number): bigint {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, value, true);
  return view.getBigUint64(0, true);
}

function nativeRunner(): string {
  const pair = (values: readonly bigint[]) =>
    `{${values.map((value) => `0x${value.toString(16)}ULL`).join(',')}}`;
  const strings = strnicmpCases
    .map(([left, right], index) =>
      [left, right]
        .map((value, side) =>
          value === null
            ? ''
            : `static const unsigned char s${index}_${side}[] = {${[...value]
                .map((char) => char.charCodeAt(0))
                .concat(0)
                .join(',')}};`,
        )
        .join('\n'),
    )
    .join('\n');
  const comparisons = strnicmpCases
    .map(
      ([left, right, count], index) =>
        `printf("{\\"scenario\\":\\"strnicmp\\",\\"index\\":${index},\\"value\\":\\"%08x\\"}\\n", (unsigned)quality_strnicmp(${left === null ? '0' : `(const char*)s${index}_0`}, ${right === null ? '0' : `(const char*)s${index}_1`}, ${count}));`,
    )
    .join('\n');
  const loops = loopCases
    .map(
      (values, index) => `{
    const u32 values[] = {${values.length ? values.join(',') : '0'}};
    printf("{\\"scenario\\":\\"loop\\",\\"index\\":${index},\\"value\\":\\"%08x\\"}\\n", fixture_loop(values, ${values.length}));
  }`,
    )
    .join('\n');
  return `#include "corpus.h"
#include <stdint.h>
#include <stdio.h>
#include <string.h>
extern int quality_strnicmp(const char*, const char*, int);
extern u64 quality_effects(u64*, u64);
extern u64 quality_call_args[4], quality_call_results[4], quality_call_memory[4];
extern u32 quality_call_count;
extern u64 *quality_observed_pointer;
${strings}
int main(void) {
  /* Explicit supported environment: nearest-even, gradual underflow, no traps.
     The emitted evaluator still requires its own explicit environment assumption. */
  __asm__ volatile("msr fpcr, %0" :: "r"((uint64_t)0));
  const u64 stack[][10] = {${stackCases.map(pair).join(',\n')}};
  for (unsigned i = 0; i < sizeof(stack)/sizeof(stack[0]); ++i) {
    const u64 *v = stack[i];
    printf("{\\"scenario\\":\\"stack\\",\\"index\\":%u,\\"value\\":\\"%016llx\\"}\\n", i,
      fixture_stack_args(v[0],v[1],v[2],v[3],v[4],v[5],v[6],v[7],v[8],v[9]));
  }
  const u64 floats[][2] = {${floatCases.map(([a, b]) => pair([bits(a), bits(b)])).join(',\n')}};
  for (unsigned i = 0; i < sizeof(floats)/sizeof(floats[0]); ++i) {
    double a, b, value; u64 raw;
    memcpy(&a, &floats[i][0], 8); memcpy(&b, &floats[i][1], 8);
    value = fixture_float(a, b); memcpy(&raw, &value, 8);
    printf("{\\"scenario\\":\\"float\\",\\"index\\":%u,\\"value\\":\\"%016llx\\"}\\n", i, raw);
  }
  ${comparisons}
  const u64 memories[][2] = {${memoryCases.map(pair).join(',\n')}};
  for (unsigned i = 0; i < sizeof(memories)/sizeof(memories[0]); ++i) {
    u64 value = memories[i][0]; const u64 result = fixture_memory(&value, memories[i][1]);
    printf("{\\"scenario\\":\\"memory\\",\\"index\\":%u,\\"value\\":\\"%016llx\\",\\"memory\\":\\"%016llx\\"}\\n", i, result, value);
  }
  ${loops}
  const u64 effects[][2] = {${effectCases.map(pair).join(',\n')}};
  for (unsigned i = 0; i < sizeof(effects)/sizeof(effects[0]); ++i) {
    u64 value = effects[i][0]; quality_call_count = 0; quality_observed_pointer = &value;
    const u64 result = quality_effects(&value, effects[i][1]);
    printf("{\\"scenario\\":\\"effects\\",\\"index\\":%u,\\"value\\":\\"%016llx\\",\\"memory\\":\\"%016llx\\",\\"calls\\":[", i, result, value);
    for (unsigned j = 0; j < quality_call_count; ++j) {
      printf("%s{\\"argument\\":\\"%016llx\\",\\"result\\":\\"%016llx\\",\\"memory\\":\\"%016llx\\"}", j ? "," : "", quality_call_args[j], quality_call_results[j], quality_call_memory[j]);
    }
    puts("]}");
  }
  return 0;
}
`;
}

/** Only this exact executable, freshly built from checked-in trusted source, runs. */
export async function prepareSourceQuality(root: string): Promise<SourceQualityFixture> {
  assert.equal(process.platform, 'darwin');
  assert.equal(process.arch, 'arm64');
  const oracle = join(root, 'oracle.c');
  const binary = join(root, 'trusted-source-quality');
  const source = nativeRunner();
  await writeFile(oracle, source);
  const args = [
    '-target',
    'arm64-apple-macos13.0',
    '-std=c11',
    '-O1',
    '-g0',
    '-ffp-contract=off',
    '-fno-builtin',
    '-fno-stack-protector',
    '-I',
    resolve(repo, 'fixtures/source'),
    corpus,
    fixture,
    oracle,
    '-o',
    binary,
  ];
  const compiled = spawnSync('/usr/bin/clang', args, { encoding: 'utf8', timeout: 60000 });
  await writeFile(
    join(root, 'compile.json'),
    JSON.stringify(
      {
        command: ['/usr/bin/clang', ...args],
        status: compiled.status,
        stdout: compiled.stdout,
        stderr: compiled.stderr,
      },
      null,
      2,
    ),
  );
  assert.equal(compiled.status, 0, compiled.stderr);
  const native = spawnSync(binary, [], { encoding: 'utf8', timeout: 10000 });
  await writeFile(join(root, 'oracle.stdout.jsonl'), native.stdout);
  assert.equal(native.status, 0, native.stderr);
  const expected = native.stdout
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as NativeCase);
  assert.equal(
    expected.find((row) => row.scenario === 'stack' && row.index === 0)?.value,
    '0000000000000181',
  );
  for (const [index, args] of strnicmpCases.entries()) {
    const row = expected.find((row) => row.scenario === 'strnicmp' && row.index === index)!;
    assert.equal(BigInt(`0x${row.value}`), BigInt.asUintN(32, strnicmpOracle(...args)));
  }
  const bytes = await readFile(binary);
  const image = loadBytes(bytes);
  const imageMemory = new Map<bigint, number>();
  for (const mapping of image.mappings) {
    if (mapping.memory_size > 1_048_576n) continue; // No enormous unmapped PAGEZERO allocation.
    for (let i = 0n; i < mapping.memory_size; i++)
      imageMemory.set(
        mapping.va + i,
        i < mapping.file_size ? image.bytes.at(Number(mapping.file_offset + i)) : 0,
      );
  }
  await writeFile(
    join(root, 'provenance.json'),
    JSON.stringify(
      {
        target_executed:
          'Only this newly built trusted source executable; no retained/baseline target',
        binary,
        sha256: contentHash(bytes),
        sources: {
          [corpus]: contentHash(await readFile(corpus)),
          [fixture]: contentHash(await readFile(fixture)),
          [oracle]: contentHash(Buffer.from(source)),
        },
        fp_environment:
          'FPCR=0: nearest-even, gradual underflow, traps disabled; finite input cases only',
      },
      null,
      2,
    ),
  );
  return { root, binary, expected, imageMemory };
}

function put(memory: Map<bigint, number>, address: bigint, value: bigint, width: number): void {
  for (let index = 0; index < width; index++)
    memory.set(address + BigInt(index), Number((value >> BigInt(index * 8)) & 255n));
}

function read64(memory: ReadonlyMap<bigint, number>, address: bigint): bigint {
  let value = 0n;
  for (let index = 0; index < 8; index++)
    value |= BigInt(memory.get(address + BigInt(index))!) << BigInt(index * 8);
  return value;
}

function checkBehavior(
  p: SourceQualityFixture,
  scenario: Scenario,
  emission: WireEmission,
): number {
  const parameters: readonly EmittedFormal[] = emittedFormals(emission);
  const formals: readonly EmittedFormal[] = parameters.filter(
    (formal) => formal.name !== 'entry_sp',
  );
  const entryStack = parameters.find((formal) => formal.name === 'entry_sp');
  const expectedArity = { stack: 10, float: 2, strnicmp: 3, memory: 2, loop: 2, effects: 2 };
  assert.equal(formals.length, expectedArity[scenario], emission.text);
  const cases = p.expected.filter((row) => row.scenario === scenario);
  for (const row of cases) {
    const memory = new Map(p.imageMemory);
    const pointer = 0x2000n;
    let values: readonly bigint[];
    if (scenario === 'stack') values = stackCases[row.index]!;
    else if (scenario === 'float') values = floatCases[row.index]!.map(bits);
    else if (scenario === 'strnicmp') {
      const [left, right, count] = strnicmpCases[row.index]!;
      for (const [address, text] of [
        [pointer, left],
        [0x3000n, right],
      ] as const)
        if (text !== null)
          for (let i = 0; i <= text.length; i++)
            memory.set(address + BigInt(i), text.charCodeAt(i) || 0);
      values = [
        left === null ? 0n : pointer,
        right === null ? 0n : 0x3000n,
        BigInt.asUintN(32, BigInt(count)),
      ];
    } else if (scenario === 'loop') {
      const array = loopCases[row.index]!;
      array.forEach((value, index) => put(memory, pointer + BigInt(index * 4), BigInt(value), 4));
      values = [pointer, BigInt(array.length)];
    } else {
      const args = (scenario === 'memory' ? memoryCases : effectCases)[row.index]!;
      put(memory, pointer, args[0], 8);
      values = [pointer, args[1]];
    }
    const inputs = new Map(formals.map((mapping, index) => [mapping.statement_id, values[index]!]));
    if (entryStack) {
      // Explicit machine-boundary input, not an invented source parameter. The
      // source pointers do not alias this supplied mapped caller stack.
      inputs.set(entryStack.statement_id, 0x9000n);
      for (let offset = -128; offset < 128; offset++) memory.set(0x9000n + BigInt(offset), 0);
    }
    const before = new Map(memory);
    let calls = 0;
    const sourceCalls = new Map<string, SourceCallOracle>();
    if (scenario === 'effects') {
      const record: SourceCallOracle = (args) => {
        const expected = row.calls![calls++];
        assert.ok(expected, 'No additional call is authorized by the trusted source oracle');
        assert.deepEqual(args, [BigInt(`0x${expected.argument}`)]);
        assert.equal(
          read64(memory, pointer),
          BigInt(`0x${expected.memory}`),
          'Store/call ordering must match native source',
        );
        return BigInt(`0x${expected.result}`);
      };
      // The source view prints the C spelling; the checked view the Mach-O symbol.
      sourceCalls.set('quality_record', record).set('_quality_record', record);
    }
    const unknownValues = new Map<string, bigint>();
    if (entryStack) unknownValues.set('non-argument entry register', 0x1122334455667788n);
    const observed = execute(
      emission,
      inputs,
      memory,
      0n,
      new Map(),
      unknownValues,
      sourceCalls,
      scenario === 'float' ? acknowledgeRequirements(emission) : [],
    );
    const description = `${scenario}[${row.index}] ${emission.language}`;
    assert.equal(observed.exit, 'machine_return', description);
    assert.deepEqual(observed.values, [BigInt(`0x${row.value}`)], description);
    if (row.memory !== undefined)
      assert.equal(read64(observed.memory, pointer), BigInt(`0x${row.memory}`), description);
    if (scenario === 'effects') {
      assert.equal(calls, row.calls!.length, description);
      assert.deepEqual(
        observed.source_calls?.map((call) => call.arguments),
        row.calls!.map((call) => [BigInt(`0x${call.argument}`)]),
      );
    } else {
      assert.deepEqual(observed.calls, [], description);
      assert.deepEqual(observed.source_calls, [], description);
      if (scenario !== 'memory') assert.deepEqual(observed.memory, before, description);
    }
    if (scenario === 'float' && row.index === 0)
      assert.equal(
        execute(emission, inputs, new Map(before)).exit,
        'unknown',
        'Unsupported/unacknowledged FP environment must remain unknown',
      );
  }
  return cases.length;
}

async function checkResult(
  p: SourceQualityFixture,
  consumer: SourceQualityConsumer,
  name: string,
  scenario: Scenario,
  dialect: Dialect,
  result: Result,
): Promise<SourceQualityEvidence> {
  const response = join(p.root, `${consumer}-${name}-${dialect}.json`);
  await writeFile(response, JSON.stringify(result, null, 2));
  assert.ok('data' in result && result.data.delivery === 'inline', JSON.stringify(result));
  assert.equal(result.data.emission.language, dialect);
  const cases = checkBehavior(p, scenario, result.data.emission);
  return { consumer, function: name, dialect, cases, state: result.state, response };
}

/** Public results, never request echoes, are evaluated against trusted native source. */
export async function exerciseSourceQuality(
  p: SourceQualityFixture,
  consumer: SourceQualityConsumer,
): Promise<SourceQualityEvidence[]> {
  const evidence: SourceQualityEvidence[] = [];
  const retain = async (
    name: string,
    scenario: Scenario,
    dialect: Dialect,
    result: Result,
  ): Promise<void> => {
    evidence.push(await checkResult(p, consumer, name, scenario, dialect, result));
    await writeFile(join(p.root, `${consumer}-evidence.json`), JSON.stringify(evidence, null, 2));
  };
  if (consumer === 'api') {
    const session = await openBinary(p.binary, { cachePath: join(p.root, 'api-cache') });
    try {
      for (const { name, scenario } of functions)
        for (const dialect of dialects)
          await retain(
            name,
            scenario,
            dialect,
            await session.decompile({ name }, { emitter: dialect }),
          );
    } finally {
      await session.close();
    }
  } else if (consumer === 'cli') {
    for (const { name, scenario } of functions)
      for (const dialect of dialects) {
        const args = [
          '--import',
          'tsx',
          entry,
          'decompile',
          p.binary,
          '--function',
          name,
          '--language',
          dialect,
          '--cache',
          join(p.root, 'cli-cache'),
          '--json',
        ];
        const child = spawnSync(process.execPath, args, {
          cwd: repo,
          encoding: 'utf8',
          timeout: 90000,
          maxBuffer: 32 * 1024 * 1024,
        });
        await writeFile(join(p.root, `cli-${name}-${dialect}.stderr.txt`), child.stderr);
        await writeFile(join(p.root, `cli-${name}-${dialect}.stdout.json`), child.stdout);
        assert.ok(child.status === 0 || child.status === 2, child.stderr);
        const decoded = JSON.parse(child.stdout) as { result: unknown };
        await retain(
          name,
          scenario,
          dialect,
          toolSchemas.function_decompile.output.parse(decoded.result),
        );
      }
  } else {
    await withMcpClient(
      { serverEntry: entry, fixtures: p.root, nodeArgs: ['--import', 'tsx'] },
      p.root,
      async (client) => {
        const opened = await callMcpTool(client, 'project_open', {
          wait: true,
          source: {
            kind: 'import',
            input_path: p.binary,
            project_path: join(p.root, 'mcp-project'),
          },
        });
        assert.ok('data' in opened && opened.data.image);
        const scope = { project_id: opened.project_id!, revision: opened.revision! };
        try {
          for (const { name, scenario } of functions) {
            const found: ToolResult<'functions_find'> = await callMcpTool(
              client,
              'functions_find',
              {
                ...scope,
                image_id: opened.data.image.id,
                query: { text: name, match: 'exact', case_sensitive: true },
              },
            );
            assert.ok('data' in found);
            assert.equal(found.data.items.length, 1);
            for (const dialect of dialects) {
              let result = await callMcpTool(client, 'function_decompile', {
                ...scope,
                function_id: found.data.items[0]!.id,
                options: { emitter: dialect },
                wait: true,
              });
              if ('data' in result && result.data.delivery === 'artifact') {
                const artifactId = result.data.artifact_id;
                const artifact = result.artifacts.find((artifact) => artifact.id === artifactId);
                assert.ok(artifact);
                result = (await readAnalysis(client, artifact)).result;
              }
              await retain(name, scenario, dialect, result);
            }
          }
        } finally {
          await callMcpTool(client, 'project_close', scope);
        }
      },
    );
  }
  return evidence;
}
