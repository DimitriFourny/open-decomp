/**
 * odbench OD worker: one process per binary (isolated memory, cold timing). Usage:
 * `node --import tsx od-worker.ts <request.json>` with an `OdWorkerRequest`. It imports the measured
 * checkout's built API by file URL, opens the binary with a fresh cache, decompiles each function
 * sequentially and appends one `OdWorkerLine` (JSON) per event to `request.out`, so a crash
 * loses only the functions that had not finished. Progress goes to stderr.
 */
import { appendFileSync, readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import type * as Api from '../../../src/api/index.js';
import { digestDiagnostics } from './diagnostics.js';
import type { OdWorkerLine, OdWorkerRequest } from './lane-od.js';
import type { FunctionDiagnostic, FunctionWork } from './types.js';

const request = JSON.parse(readFileSync(process.argv[2] ?? '', 'utf8')) as OdWorkerRequest;

function emit(line: OdWorkerLine): void {
  appendFileSync(request.out, `${JSON.stringify(line)}\n`);
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface Interpreted {
  state: 'complete' | 'partial' | 'failed';
  reason: string | null;
  text: string | null;
  work: FunctionWork | null;
  /** Distinct diagnostics of the result envelope (every state carries them). */
  diagnostics: FunctionDiagnostic[];
}

function interpret(result: Api.ToolResult<'function_decompile'>): Interpreted {
  const diagnostics = digestDiagnostics(result.diagnostics);
  if ('data' in result) {
    if (result.data.delivery !== 'inline')
      return {
        state: 'failed',
        reason: 'decompilation artifact was not materialized',
        text: null,
        work: null,
        diagnostics,
      };
    const text = result.data.emission.text;
    const work =
      result.data.work === undefined
        ? null
        : { consumed: result.data.work, limit: result.budget.work };
    return result.state === 'partial'
      ? { state: 'partial', reason: result.reason, text, work, diagnostics }
      : { state: 'complete', reason: null, text, work, diagnostics };
  }
  if ('error' in result) {
    // A work-limit failure has no result envelope; its diagnostic reports the count at which
    // the limit tripped (the first charge past it) and the limit.
    const details = result.error.details;
    const work =
      details?.kind === 'limit' && details.resource === 'work'
        ? { consumed: details.consumed, limit: details.limit }
        : null;
    return {
      state: 'failed',
      reason: `${result.error.code}: ${result.error.message}`,
      text: null,
      work,
      diagnostics,
    };
  }
  return {
    state: 'failed',
    reason: `unexpected result state ${result.state}`,
    text: null,
    work: null,
    diagnostics,
  };
}

const suffix =
  request.repeat.total > 1 ? ` [repeat ${request.repeat.index + 1}/${request.repeat.total}]` : '';

async function main(): Promise<void> {
  const started = performance.now();
  let session: Api.BinarySession;
  let openFinished: number;
  try {
    // Runtime-selected module: the measured checkout is a parameter, so a static import cannot work.
    const api = (await import(request.api)) as typeof Api;
    const openStarted = performance.now();
    session = await api.openBinary(request.input, {
      cachePath: request.cachePath,
      openJob: request.open_job ? {} : false,
    });
    openFinished = performance.now();
    // A build without the open-time job has no `openJob` field.
    const job = (session as { openJob?: Api.OpenJobReport | null }).openJob ?? null;
    emit({
      kind: 'open',
      import_ms: openFinished - openStarted,
      ...(job === null ? {} : { open_job_ms: job.ms, open_job_work: job.work }),
    });
    if (job !== null)
      process.stderr.write(
        `od: ${request.binary} open-time job ${job.state}: ${job.prepared} functions, ${job.retained} retained, ${job.jobs} helpers, ${Math.round(job.ms)} ms, work ${job.work}${job.message ? ` (${job.message})` : ''}\n`,
      );
  } catch (error) {
    emit({ kind: 'open_error', message: message(error) });
    process.stderr.write(`od: ${request.binary} open failed: ${message(error)}\n`);
    return;
  }
  try {
    let decompileTotal = 0;
    for (const [index, fn] of request.functions.entries()) {
      emit({ kind: 'start', id: fn.id });
      const callStarted = performance.now();
      let outcome: Interpreted;
      let notFound = false;
      try {
        outcome = interpret(
          await session.decompile(
            { address: { space: 'va', value: fn.va } },
            { emitter: 'c-like', view: 'source', inference: request.inference },
          ),
        );
      } catch (error) {
        notFound = error instanceof Error && error.name === 'FunctionSelectionError';
        outcome = {
          state: 'failed',
          reason: message(error),
          text: null,
          work: null,
          diagnostics: [],
        };
      }
      const ms = performance.now() - callStarted;
      decompileTotal += ms;
      emit({
        kind: 'fn',
        id: fn.id,
        state: notFound ? 'not_found' : outcome.state,
        reason: outcome.reason,
        ms,
        at_ms: performance.now() - openFinished,
        text: outcome.text,
        work: outcome.work,
        diagnostics: outcome.diagnostics,
      });
      const detail = notFound
        ? 'not_found'
        : outcome.state === 'complete'
          ? 'complete'
          : `${outcome.state}(${outcome.reason ?? ''})`;
      process.stderr.write(
        `od: ${request.binary} ${index + 1}/${request.functions.length} ${fn.name ?? fn.va} ${Math.round(ms)} ms ${detail}${suffix}\n`,
      );
    }
    emit({
      kind: 'done',
      cold_ms: performance.now() - started,
      decompile_ms_total: decompileTotal,
      worker_peak_rss_bytes: process.resourceUsage().maxRSS * 1024,
    });
  } finally {
    await session.close();
  }
}

try {
  await main();
} catch (error) {
  process.stderr.write(`od: ${request.binary} worker failed: ${message(error)}\n`);
  process.exitCode = 1;
}
process.exit();
