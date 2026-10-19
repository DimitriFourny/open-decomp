import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import {
  applyVariant,
  loadQuestions,
  QUESTIONS_PATH,
  INPUTS_ENV,
  resolveInputs,
  sha256,
  verifySpans,
} from './questions.js';
import {
  BYTES_PER_TOKEN,
  CONFIGS,
  McpBench,
  describeRepo,
  estimateTokens,
  exportFunction,
  exportMaterial,
  functionKey,
  ghidraMaterial,
  packetText,
} from './packets.js';
import type { Config, Material } from './packets.js';
import { buildScoreReport, markdownReport, readAnswer } from './report.js';
import type { ManifestPacket } from './report.js';

const USAGE = `Usage: node --import tsx scripts/bench/llm-tasks/run.ts COMMAND [flags]

  build   --repo PATH --out DIR [--inputs DIR] [--binary ID=PATH]... [--sources DIR]
          [--ghidra DIR] [--configs mcp-default,export-file,ghidra,disasm] [--only ID,ID]
          Build packets/<config>/<question>.md and manifest.json from the checkout PATH (needs dist/).
          [--variant sqlite3-dylib]: same questions over libsqlite3.3.54.0.dylib (no Ghidra packets).
          Use a fresh --out per build (project caches under DIR/work are version specific).
  score   --packets DIR (--answers DIR | --answer-cmd CMD) [--out DIR]
          Score answers (DIR/<config>/<id>.json {"answer": "..."} or .txt). --answer-cmd runs CMD per
          packet (prompt on stdin, answer on stdout) and stores the answers under OUT/answers.
  verify  --sources DIR   Check every question's source span and anchor text against sqlite3.c / brotli.c.
  fetch-sources --sources DIR   Download brotli.c (tag v1.2.0) and verify its pinned SHA-256.

Binaries: ID is sqlite3-arm64 or brotli; --inputs DIR (or $${INPUTS_ENV}) holds them by file name.`;

function parseFlags(args: readonly string[]): Map<string, string[]> {
  const flags = new Map<string, string[]>();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index]!;
    const value = args[index + 1];
    assert.ok(key.startsWith('--') && value !== undefined, `Malformed argument ${key}\n${USAGE}`);
    flags.set(key, [...(flags.get(key) ?? []), value]);
  }
  return flags;
}
const one = (flags: Map<string, string[]>, name: string): string | undefined =>
  flags.get(name)?.[0];
function required(flags: Map<string, string[]>, name: string): string {
  const value = one(flags, name);
  assert.ok(value !== undefined, `${name} is required\n${USAGE}`);
  return value;
}

async function toolVersions(): Promise<Record<string, string | null>> {
  const probe = (command: string, args: string[]): Promise<string | null> =>
    new Promise((done) => {
      const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'ignore'] });
      let out = '';
      child.stdout.on('data', (chunk: Buffer) => (out += chunk.toString()));
      child.on('error', () => done(null));
      child.on('close', () => done(out.trim().split('\n')[0] ?? null));
    });
  return {
    node: process.version,
    bun: await probe('bun', ['--version']),
    clang: await probe('clang', ['--version']),
  };
}

async function build(flags: Map<string, string[]>): Promise<void> {
  const out = resolve(required(flags, '--out'));
  const frozen = await loadQuestions(one(flags, '--questions') ?? QUESTIONS_PATH);
  const variant = one(flags, '--variant');
  const set = variant === undefined ? frozen : applyVariant(frozen, variant);
  const only = one(flags, '--only')?.split(',');
  const configs = (one(flags, '--configs')?.split(',') ?? [...CONFIGS]) as Config[];
  for (const config of configs) assert.ok(CONFIGS.includes(config), `Unknown config ${config}`);
  const questions = set.questions.filter(
    (question) => only === undefined || only.includes(question.id),
  );
  assert.ok(questions.length > 0, 'No questions selected');

  const needed = new Set(questions.map((question) => question.binary));
  const overrides = new Map(
    (flags.get('--binary') ?? []).map((item) => item.split('=', 2) as [string, string]),
  );
  const inputsDir = one(flags, '--inputs') ?? process.env[INPUTS_ENV];
  const paths = await resolveInputs(
    {
      ...set,
      binaries: Object.fromEntries(
        Object.entries(set.binaries).map(([id, spec]) => [
          id,
          { ...spec, file: overrides.get(id) ?? spec.file },
        ]),
      ),
    },
    inputsDir,
    undefined,
    { binaries: needed, sources: new Set() },
  );
  const sourcesDir = one(flags, '--sources');
  if (sourcesDir !== undefined) await runVerify(sourcesDir, false);

  const repo = await describeRepo(resolve(required(flags, '--repo')));
  const ghidraDir = one(flags, '--ghidra');

  const work = join(out, 'work');
  const materials = new Map<string, Partial<Record<Config, Material | null>>>();
  const functions = new Map<string, { binary: string; address: string; function: string }>();
  for (const question of questions)
    functions.set(functionKey(question), {
      binary: question.binary,
      address: question.address,
      function: question.function,
    });

  const mcp =
    configs.includes('mcp-default') || configs.includes('disasm')
      ? await McpBench.start(repo, join(work, 'mcp'), [
          ...new Set(Object.values(paths.binaries).map((path) => dirname(path))),
        ])
      : null;
  try {
    for (const item of functions.values()) {
      const key = functionKey(item);
      const found: Partial<Record<Config, Material | null>> = {};
      const started = Date.now();
      if (mcp !== null) {
        await mcp.open(item.binary, paths.binaries[item.binary]!);
        if (configs.includes('mcp-default'))
          found['mcp-default'] = await mcp.decompile(item.binary, item.address);
        if (configs.includes('disasm'))
          found.disasm = await mcp.disassemble(item.binary, item.address);
      }
      if (configs.includes('export-file'))
        found['export-file'] = exportMaterial(
          await exportFunction(
            repo,
            paths.binaries[item.binary]!,
            join(work, 'export-cache', item.binary),
            join(work, 'export', item.binary, item.function),
            item.function,
            item.address,
          ),
        );
      if (
        configs.includes('ghidra') &&
        ghidraDir !== undefined &&
        variant === undefined &&
        item.binary === 'sqlite3-arm64'
      )
        found.ghidra = await ghidraMaterial(ghidraDir, item);
      materials.set(key, found);
      console.error(
        `built ${item.function} ${item.address} (${((Date.now() - started) / 1000).toFixed(1)}s)`,
      );
    }
  } finally {
    await mcp?.close();
  }

  const packets: (ManifestPacket & {
    function: string;
    address: string;
    binary: string;
    material_source: unknown;
  })[] = [];
  for (const question of questions) {
    const found = materials.get(functionKey(question))!;
    for (const config of configs) {
      const material = found[config];
      if (material === undefined || material === null) continue;
      const text = packetText(set, question, material);
      const file = join('packets', config, `${question.id}.md`);
      await mkdir(dirname(join(out, file)), { recursive: true });
      await writeFile(join(out, file), text);
      const materialBytes = Buffer.byteLength(material.text);
      packets.push({
        id: question.id,
        config,
        file,
        binary: question.binary,
        function: question.function,
        address: question.address,
        material_bytes: materialBytes,
        material_tokens: estimateTokens(materialBytes),
        material_sha256: sha256(material.text),
        packet_bytes: Buffer.byteLength(text),
        state: material.state,
        material_source: material.source,
      });
    }
  }

  const summary = configs.map((config) => {
    const own = packets.filter((packet) => packet.config === config);
    const bytes = own.map((packet) => packet.material_bytes).sort((a, b) => a - b);
    const total = bytes.reduce((sum, value) => sum + value, 0);
    return {
      config,
      packets: own.length,
      material_bytes_total: total,
      material_bytes_median: bytes[Math.floor(bytes.length / 2)] ?? 0,
      material_bytes_max: bytes[bytes.length - 1] ?? 0,
      material_tokens_total: estimateTokens(total),
      states: Object.fromEntries(
        [...new Set(own.map((packet) => packet.state))].map((state) => [
          state,
          own.filter((packet) => packet.state === state).length,
        ]),
      ),
    };
  });
  const manifest = {
    schema: 1,
    built_at: new Date().toISOString(),
    questions_sha256: sha256(await readFile(one(flags, '--questions') ?? QUESTIONS_PATH)),
    variant: variant ?? null,
    question_count: questions.length,
    estimator: `ceil(UTF-8 bytes / ${BYTES_PER_TOKEN}) approximate tokens; no tokenizer is available offline`,
    repo,
    tools: await toolVersions(),
    ghidra:
      ghidraDir === undefined
        ? null
        : { version: '12.1.4 (archived run, sqlite3-arm64 only)', dir: ghidraDir },
    binaries: Object.fromEntries(
      Object.entries(paths.binaries).map(([id, path]) => [
        id,
        { path, sha256: set.binaries[id]!.sha256 },
      ]),
    ),
    functions: [...functions.values()],
    summary,
    packets,
  };
  await writeFile(join(out, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`packets: ${packets.length} in ${join(out, 'packets')}`);
  console.log('config\tpackets\tmaterial bytes (total / median / max)\test. tokens (total)');
  for (const row of summary)
    console.log(
      `${row.config}\t${row.packets}\t${row.material_bytes_total} / ${row.material_bytes_median} / ${row.material_bytes_max}\t${row.material_tokens_total}`,
    );
}

/** Runs CMD through the shell: packet on stdin, answer on stdout. */
function runAnswerCommand(command: string, prompt: string): Promise<string> {
  return new Promise((done, fail) => {
    const child = spawn('/bin/sh', ['-c', command], { stdio: ['pipe', 'pipe', 'inherit'] });
    let out = '';
    child.stdout.on('data', (chunk: Buffer) => (out += chunk.toString()));
    child.on('error', fail);
    child.on('close', (code) =>
      code === 0 ? done(out.trim()) : fail(new Error(`answer command exited ${code}`)),
    );
    child.stdin.end(prompt);
  });
}

async function score(flags: Map<string, string[]>): Promise<void> {
  const packetsDir = resolve(required(flags, '--packets'));
  const manifest = JSON.parse(await readFile(join(packetsDir, 'manifest.json'), 'utf8')) as {
    questions_sha256: string;
    estimator: string;
    packets: ManifestPacket[];
  };
  const questionsPath = one(flags, '--questions') ?? QUESTIONS_PATH;
  assert.equal(
    sha256(await readFile(questionsPath)),
    manifest.questions_sha256,
    'questions.json differs from the set the packets were built from',
  );
  const set = await loadQuestions(questionsPath);
  const out = resolve(one(flags, '--out') ?? join(packetsDir, 'score'));
  await mkdir(out, { recursive: true });
  let answersDir = one(flags, '--answers');
  const command = one(flags, '--answer-cmd');
  assert.ok(
    (answersDir === undefined) !== (command === undefined),
    'Pass exactly one of --answers / --answer-cmd',
  );
  if (command !== undefined) {
    answersDir = join(out, 'answers');
    for (const packet of manifest.packets) {
      const answer = await runAnswerCommand(
        command,
        await readFile(join(packetsDir, packet.file), 'utf8'),
      );
      await mkdir(join(answersDir, packet.config), { recursive: true });
      await writeFile(
        join(answersDir, packet.config, `${packet.id}.json`),
        `${JSON.stringify({ answer, command }, null, 2)}\n`,
      );
    }
  }
  const answers = new Map<string, string | undefined>();
  for (const packet of manifest.packets)
    answers.set(
      `${packet.config}/${packet.id}`,
      await readAnswer(answersDir!, packet.config, packet.id),
    );
  const { report, rows } = buildScoreReport(set.questions, manifest.packets, answers, {
    packets_manifest: join(packetsDir, 'manifest.json'),
    answers: answersDir!,
    estimator: manifest.estimator,
  });
  await writeFile(join(out, 'score.json'), `${JSON.stringify(report, null, 2)}\n`);
  const markdown = markdownReport(report, rows, set.questions);
  await writeFile(join(out, 'score.md'), markdown);
  console.log(markdown);
}

async function runVerify(sourcesDir: string, print: boolean): Promise<void> {
  const set = await loadQuestions();
  const sources = new Map<string, string>();
  for (const [name, spec] of Object.entries(set.sources)) {
    const bytes = await readFile(join(resolve(sourcesDir), name));
    assert.equal(sha256(bytes), spec.sha256, `${name}: SHA-256 differs from the pin`);
    sources.set(name, bytes.toString('utf8'));
  }
  const failures = verifySpans(set, sources).filter((item) => !item.ok);
  for (const item of failures) console.error(`span check failed: ${item.id}: ${item.reason}`);
  assert.equal(failures.length, 0, 'Source span verification failed');
  if (print) console.log(`verified ${set.questions.length} source spans in ${sources.size} files`);
}

async function fetchSources(flags: Map<string, string[]>): Promise<void> {
  const dir = resolve(required(flags, '--sources'));
  const set = await loadQuestions();
  const spec = set.sources['brotli.c']!;
  assert.ok(spec.url, 'brotli.c has no pinned URL');
  const response = await fetch(spec.url);
  assert.ok(response.ok, `GET ${spec.url}: ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  assert.equal(sha256(bytes), spec.sha256, 'Downloaded brotli.c differs from the pinned SHA-256');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'brotli.c'), bytes);
  console.log(
    `brotli.c ${spec.sha256} -> ${join(dir, 'brotli.c')} (sqlite3.c: extract from the sqlite-autoconf-3540000 archive)`,
  );
}

const [command, ...rest] = process.argv.slice(2);
const flags = parseFlags(rest);
if (command === 'build') await build(flags);
else if (command === 'score') await score(flags);
else if (command === 'verify') await runVerify(required(flags, '--sources'), true);
else if (command === 'fetch-sources') await fetchSources(flags);
else {
  console.error(USAGE);
  process.exit(2);
}
