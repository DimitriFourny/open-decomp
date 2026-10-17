#!/usr/bin/env node
// Trusted benchmark-only loader hooks. The on-disk compiled build is never edited.
// Exact build/spec/observer hashes and AST selector counts fail closed. This is
// instrumentation overhead, not an uninstrumented engine-only measurement.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';

const ownPath = fileURLToPath(import.meta.url);
const specPath = fileURLToPath(new URL('./quality-persistent-hooks.json', import.meta.url));
const observerName = '__openDecompQualityObserver';
const reference = `globalThis.${observerName}`;
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const memory = () => ({ ...process.memoryUsage(), process_lifetime_max_rss_bytes: process.resourceUsage().maxRSS * 1024 });

function readPins(path) {
  assert.ok(path && isAbsolute(path), 'An absolute trusted observer pins path is required');
  const pins = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(pins.schema, 1);
  assert.ok(isAbsolute(pins.root));
  assert.ok(isAbsolute(pins.prepared));
  assert.equal(hash(readFileSync(ownPath)), pins.observer_sha256, 'Observer changed after pinning');
  assert.equal(hash(readFileSync(specPath)), pins.spec_sha256, 'Hook specification changed after pinning');
  return pins;
}

function instrument(source, file, specification, ts) {
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  assert.equal(ast.parseDiagnostics.length, 0, `Compiled observer input cannot be parsed: ${file}`);
  const edits = [];
  const counts = (specification.spans ?? []).map(() => 0);
  let entries = 0, computes = 0, serial = 0;
  const name = (node) => node && (ts.isIdentifier(node) || ts.isStringLiteral(node)) ? node.text : undefined;
  function visit(node) {
    if (specification.worker_entry && ts.isCallExpression(node) && name(node.expression) === 'runProjectWorker') {
      assert.equal(node.arguments.length, 1);
      assert.equal(name(node.arguments[0]), 'queryWorkerHandler');
      entries++;
      edits.push({ start: node.getStart(ast), end: node.end,
        text: `runProjectWorker(${reference}.handler(queryWorkerHandler), ${reference}.runtime)` });
    }
    if (specification.compute_call && ts.isCallExpression(node) && name(node.expression) === 'compute') {
      assert.equal(node.arguments.length, 0);
      computes++;
      edits.push({ start: node.getStart(ast), end: node.end, text: `${reference}.compute(compute)` });
    }
    for (const [index, selector] of (specification.spans ?? []).entries()) {
      const matched = selector.function
        ? ts.isFunctionDeclaration(node) && name(node.name) === selector.function
        : ts.isMethodDeclaration(node) && name(node.name) === selector.method &&
          ts.isClassDeclaration(node.parent) && name(node.parent.name) === selector.class;
      if (!matched) continue;
      counts[index]++;
      assert.ok(node.body && ts.isBlock(node.body), `Missing callable body: ${file}`);
      const token = `__quality_phase_${serial}`;
      const error = `__quality_error_${serial++}`;
      assert.ok(!source.includes(token) && !source.includes(error), 'Observer identifier collision');
      const asynchronous = node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword);
      function returns(child) {
        if (ts.isFunctionLike(child)) return; // Never change nested callbacks/closures.
        if (ts.isReturnStatement(child) && child.expression && (asynchronous || selector.observe_image_identity)) {
          const expression = source.slice(child.expression.getStart(ast), child.expression.end);
          const value = asynchronous ? `await (${expression})` : `(${expression})`;
          edits.push({ start: child.getStart(ast), end: child.end,
            text: `return ${selector.observe_image_identity ? `${reference}.imageResult(${token}, ${value})` : value};` });
          return;
        }
        ts.forEachChild(child, returns);
      }
      ts.forEachChild(node.body, returns);
      edits.push({ start: node.body.getStart(ast) + 1, end: node.body.getStart(ast) + 1,
        text: `\nconst ${token} = ${reference}.begin(${JSON.stringify(selector.phase)});\ntry {\n` });
      edits.push({ start: node.body.end - 1, end: node.body.end - 1,
        text: `\n} catch (${error}) { ${reference}.failure(${token}, ${error}); throw ${error}; } finally { ${reference}.end(${token}); }\n` });
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
  for (const [index, count] of counts.entries()) assert.equal(count, 1, `Hook selector mismatch in ${file}: ${JSON.stringify(specification.spans[index])}`);
  assert.equal(entries, specification.worker_entry ? 1 : 0, 'Worker entry observer seam changed');
  assert.equal(computes, specification.compute_call ? 1 : 0, 'Analysis computation boundary changed');
  edits.sort((left, right) => right.start - left.start || right.end - left.end);
  let previous = source.length;
  for (const edit of edits) {
    assert.ok(edit.end <= previous, `Overlapping benchmark hooks: ${file}`);
    source = source.slice(0, edit.start) + edit.text + source.slice(edit.end);
    previous = edit.start;
  }
  const transformed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  assert.equal(transformed.parseDiagnostics.length, 0, `Generated observation hooks cannot be parsed: ${file}`);
  return source;
}

if (process.argv[1] && resolve(process.argv[1]) === ownPath) {
  assert.equal(process.argv[2], '--prepare');
  const pins = readPins(process.argv[3]);
  // Parse once before measurement; measured CLI/worker processes load no TS compiler.
  const ts = (await import('typescript')).default;
  const spec = JSON.parse(readFileSync(specPath, 'utf8'));
  mkdirSync(pins.prepared, { recursive: true });
  const modules = {};
  for (const [file, selectors] of Object.entries(spec.modules)) {
    const original = readFileSync(join(pins.root, file));
    assert.equal(hash(original), pins.files[file], `Compiled hook input changed: ${file}`);
    const source = instrument(original.toString('utf8'), file, selectors, ts);
    const destination = join(pins.prepared, file);
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, source, { flag: 'wx', mode: 0o600 });
    modules[file] = { original_sha256: pins.files[file], observed_sha256: hash(source) };
  }
  writeFileSync(join(pins.prepared, 'modules.json'), JSON.stringify(modules, null, 2), { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ modules: Object.keys(modules).length, parser_version: ts.version, target_executed: false, measurements_exercised: false }));
} else {
  const pins = readPins(process.env.OPEN_DECOMP_PHASE_PINS);
  const modules = JSON.parse(readFileSync(join(pins.prepared, 'modules.json'), 'utf8'));
  const directory = process.env.OPEN_DECOMP_PHASE_METRICS;
  assert.ok(directory && isAbsolute(directory), 'Absolute phase sidecar directory is required');
  mkdirSync(directory, { recursive: true });
  const destination = join(directory, `${process.pid}.jsonl`);
  const seenImages = new WeakSet();
  const spans = [];
  let active = null, records = [], sequence = 0;
  function persist() {
    if (!records.length) return;
    appendFileSync(destination, records.map((record) => JSON.stringify(record)).join('\n') + '\n', { mode: 0o600 });
    records = [];
  }
  function boundary(phase) {
    records.push({ kind: 'boundary', phase, pid: process.pid, job_id: active?.id ?? null,
      operation: active?.operation ?? null, function_id: active?.function_id ?? null,
      monotonic_ns: process.hrtime.bigint().toString(), memory: memory() });
  }
  const observer = {
    begin(phase) {
      const before = memory();
      const token = { id: ++sequence, parent: spans.at(-1)?.id ?? null, phase,
        job_id: active?.id ?? null, operation: active?.operation ?? null,
        function_id: active?.function_id ?? null, before, start: performance.now() };
      spans.push(token);
      return token;
    },
    failure(token, error) {
      token.error = { name: error?.name ?? typeof error, message: String(error?.message ?? error).slice(0, 2048) };
    },
    imageResult(token, value) {
      assert.ok(value && typeof value === 'object', 'Loaded image observer result changed');
      token.image_identity = seenImages.has(value) ? 'reused' : 'materialized';
      seenImages.add(value);
      return value;
    },
    end(token) {
      const elapsed_ms = performance.now() - token.start;
      const position = spans.indexOf(token);
      assert.ok(position >= 0, 'Unknown phase token');
      spans.splice(position, 1);
      const { start: _start, ...details } = token;
      records.push({ kind: 'phase', pid: process.pid, ...details, elapsed_ms, after: memory() });
    },
    async compute(computation) {
      const token = observer.begin('analysis_compute');
      try { return await computation(); }
      catch (error) { observer.failure(token, error); throw error; }
      finally { observer.end(token); }
    },
    handler(original) {
      assert.equal(typeof original.execute, 'function');
      assert.equal(typeof original.prepareImport, 'function');
      const context = (base) => ({ ...base, progress(phase, completed, total) {
        boundary(`progress:${phase}`);
        base.progress(phase, completed, total);
      } });
      return {
        async prepareImport(image, scope) {
          const token = observer.begin('handler_prepare_import');
          try { return await original.prepareImport(image, { ...scope, context: context(scope.context) }); }
          catch (error) { observer.failure(token, error); throw error; }
          finally { observer.end(token); }
        },
        async execute(operation, args, scope) {
          if (active) active.function_id = args.function_id ?? null;
          const token = observer.begin('handler_execute');
          try { return await original.execute(operation, args, { ...scope, context: context(scope.context) }); }
          catch (error) { observer.failure(token, error); throw error; }
          finally { observer.end(token); boundary('handler_return'); persist(); }
        },
      };
    },
    runtime: { phase(phase, job) {
      if (phase === 'running') { persist(); active = { id: job.id, operation: job.operation, function_id: null }; }
      boundary(`runtime:${phase}`);
      if (phase === 'published') persist();
    } },
  };
  assert.equal(globalThis[observerName], undefined, 'Phase observer already registered');
  globalThis[observerName] = observer;
  registerHooks({ load(url, context, nextLoad) {
    const loaded = nextLoad(url, context);
    if (!url.startsWith('file:')) return loaded;
    const file = relative(pins.root, fileURLToPath(url)).split(sep).join('/');
    const pinned = modules[file];
    if (!pinned) return loaded;
    assert.equal(loaded.format, 'module', 'Only the pinned compiled ESM build is observed');
    const original = loaded.source === undefined || loaded.source === null
      ? readFileSync(fileURLToPath(url)) : Buffer.from(loaded.source);
    assert.equal(hash(original), pinned.original_sha256, `Live compiled input changed: ${file}`);
    const observed = readFileSync(join(pins.prepared, file));
    assert.equal(hash(observed), pinned.observed_sha256, `Prepared observation changed: ${file}`);
    records.push({ kind: 'hooked_module', file, pid: process.pid,
      original_sha256: pinned.original_sha256, observed_sha256: pinned.observed_sha256 });
    return { ...loaded, source: observed.toString('utf8') };
  } });
  boundary('observer_start');
  persist();
  process.once('exit', () => { boundary('observer_exit'); persist(); });
}
