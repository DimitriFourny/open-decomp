import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { constants, cpSync, mkdtempSync, rmSync } from 'node:fs';
import { availableParallelism, tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_BUDGET,
  OperationError,
  createOperationContext,
  type FunctionRecord,
  type OperationContext,
  type ProjectStore,
  type ReferenceRecord,
} from '../../core/index.js';
import { createAnalysisReadset } from '../../project/cache/index.js';
import { SqliteProjectStore } from '../../project/store/index.js';
import { loadImage } from '../queries/scope.js';
import { nativePreparationInput } from './index.js';
import type { NativePreparationInput } from './native-prepare.js';
import { nativeSummaryScope } from './native-summaries.js';
import {
  nativeLibraryContracts,
  nativeLoadAllowanceBound,
  nativeUnitLoader,
  preparedUnitCache,
  preparedUnitIdentity,
} from './source-facts.js';

/** The open-time job (docs/internals/project-cache.md §5a): prepare the generic native unit
 * of every indexed function, callees first, in helper processes over private copies of the
 * project, and import the retained units into the project's persisted unit store. It is not
 * a request: it runs under its own work budget, and a request that reuses one of its units
 * replays the unit's exact charge, so request work never depends on whether it ran. */
export interface NativeOpenJobOptions {
  /** Helper processes (default: half the cores, at most 8; never more than the work needs). */
  readonly jobs?: number;
  /** Work the helpers may charge in total (default `DEFAULT_OPEN_JOB_WORK`). */
  readonly work?: number;
  readonly signal?: AbortSignal;
}
export interface NativeOpenJobReport {
  /** `completed`: every pending function was prepared; `limited`: the job's work budget or
   * the unit store's byte cap stopped it; `cancelled` and `failed` import nothing;
   * `skipped`: nothing to prepare, or the store is full. */
  readonly state: 'completed' | 'limited' | 'cancelled' | 'failed' | 'skipped';
  readonly ms: number;
  /** Work the helpers charged. */
  readonly work: number;
  readonly jobs: number;
  /** Functions the job prepared (or tried to). */
  readonly prepared: number;
  /** Of those, units retained (the rest hit a limit and keep nothing). */
  readonly retained: number;
  /** Compressed payload bytes the helpers wrote (units and markers). */
  readonly bytes: number;
  /** Rows imported into the project's store (units and markers), callees first within the
   * store's byte cap. */
  readonly stored: number;
  readonly message?: string;
}

export const DEFAULT_OPEN_JOB_WORK = 1_000_000_000;
/** Functions handed to a helper at a time: small enough to balance, large enough that the
 * round trip is negligible. */
const BATCH = 8;
/** At least this many functions per helper before another one is started. */
const FUNCTIONS_PER_HELPER = 16;

/** Callees before their callers: a postorder of the established direct-call graph (cycles
 * broken at the back edge), then every function no call reaches, all in index order. */
export function calleesFirst(
  functions: readonly FunctionRecord[],
  references: readonly ReferenceRecord[],
): FunctionRecord[] {
  const byId = new Map(functions.map((fn) => [fn.id, fn]));
  const byEntry = new Map<string, FunctionRecord>();
  for (const fn of functions)
    byEntry.set(`${fn.entry.image_id}:${fn.entry.space}:${fn.entry.value}`, fn);
  const callees = new Map<string, string[]>();
  for (const reference of references) {
    if (
      (reference.kind !== 'call' && reference.kind !== 'tail_call') ||
      reference.status !== 'established' ||
      reference.from_function === null ||
      reference.to === null
    )
      continue;
    const target =
      (reference.to_entity !== null ? byId.get(reference.to_entity) : undefined) ??
      byEntry.get(`${reference.to.image_id}:${reference.to.space}:${reference.to.value}`);
    if (!target) continue;
    const list = callees.get(reference.from_function);
    if (list) list.push(target.id);
    else callees.set(reference.from_function, [target.id]);
  }
  const ordered: FunctionRecord[] = [];
  const state = new Map<string, 'open' | 'done'>();
  for (const root of functions) {
    if (state.has(root.id)) continue;
    const stack: { id: string; next: number }[] = [{ id: root.id, next: 0 }];
    state.set(root.id, 'open');
    while (stack.length) {
      const top = stack[stack.length - 1]!;
      const next = callees.get(top.id)?.[top.next++];
      if (next !== undefined) {
        if (!state.has(next)) {
          state.set(next, 'open');
          stack.push({ id: next, next: 0 });
        }
        continue;
      }
      stack.pop();
      state.set(top.id, 'done');
      ordered.push(byId.get(top.id)!);
    }
  }
  return ordered;
}

type HelperCommand =
  | { readonly kind: 'open'; readonly project: string }
  | { readonly kind: 'prepare'; readonly ids: readonly string[] }
  | { readonly kind: 'finish' };
type HelperEvent =
  | { readonly kind: 'ready' }
  | {
      readonly kind: 'prepared';
      readonly work: number;
      readonly retained: number;
      readonly bytes: number;
    }
  | { readonly kind: 'finished' }
  | { readonly kind: 'error'; readonly message: string };

const helperEntry = new URL(
  import.meta.url.endsWith('.ts') ? '../../workers/units-entry.ts' : '../../workers/units-entry.js',
  import.meta.url,
);

/** One helper process: its project copy, a line protocol over stdin/stdout. */
class Helper {
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #events: HelperEvent[] = [];
  #waiting: ((event: HelperEvent) => void) | undefined;
  readonly exited: Promise<void>;
  constructor(readonly project: string) {
    const entry = fileURLToPath(helperEntry);
    this.#child = spawn(
      process.execPath,
      [...(entry.endsWith('.ts') ? ['--import', 'tsx'] : []), entry],
      { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true },
    );
    this.#child.stderr.resume();
    this.#child.stdin.on('error', () => {});
    createInterface({ input: this.#child.stdout }).on('line', (line) => {
      let event: HelperEvent;
      try {
        event = JSON.parse(line) as HelperEvent;
      } catch {
        event = { kind: 'error', message: 'Invalid helper output' };
      }
      const waiting = this.#waiting;
      this.#waiting = undefined;
      if (waiting) waiting(event);
      else this.#events.push(event);
    });
    // The compile target's lib predates Promise.withResolvers.
    this.exited = new Promise((resolve) => this.#child.on('close', () => resolve()));
    void this.exited.then(() => {
      const waiting = this.#waiting;
      this.#waiting = undefined;
      waiting?.({ kind: 'error', message: 'Open-time job helper exited' });
    });
  }

  send(command: HelperCommand): void {
    this.#child.stdin.write(`${JSON.stringify(command)}\n`);
  }

  next(): Promise<HelperEvent> {
    const queued = this.#events.shift();
    if (queued) return Promise.resolve(queued);
    if (this.#child.exitCode !== null || this.#child.signalCode !== null)
      return Promise.resolve({ kind: 'error', message: 'Open-time job helper exited' });
    return new Promise((resolve) => (this.#waiting = resolve));
  }

  kill(): void {
    this.#child.kill('SIGKILL');
  }
}

/** The job's owner side, in the process that owns the project. Never throws: a failure or a
 * cancellation is a report, and the project is left as it was (nothing is imported). */
export async function runNativeOpenJob(
  store: ProjectStore,
  options: NativeOpenJobOptions = {},
): Promise<NativeOpenJobReport> {
  const started = performance.now();
  const signal = options.signal;
  let jobs = 0,
    work = 0,
    prepared = 0,
    retained = 0,
    bytes = 0,
    stored = 0;
  const report = (state: NativeOpenJobReport['state'], message?: string): NativeOpenJobReport => ({
    state,
    ms: performance.now() - started,
    work,
    jobs,
    prepared,
    retained,
    bytes,
    stored,
    ...(message === undefined ? {} : { message }),
  });
  if (
    typeof store.copyProject !== 'function' ||
    typeof store.importNativeSummaries !== 'function' ||
    typeof store.nativeSummaryFunctions !== 'function' ||
    typeof store.nativeSummaryUsage !== 'function'
  )
    return report('skipped', 'The project store keeps no native units');
  const helpers: Helper[] = [];
  let scratch: string | undefined;
  const onAbort = (): void => {
    for (const helper of helpers) helper.kill();
  };
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    signal?.throwIfAborted();
    const snapshot = store.snapshot();
    const images = snapshot.images;
    if (images.length !== 1) return report('skipped', 'The open-time job needs exactly one image');
    const revision = snapshot.revision;
    const context = createOperationContext({
      budget: { work: 100_000_000, deadline_ms: 300_000 },
      ...(signal ? { signal } : {}),
    });
    const scope = { store, context, job_id: 'open-time-job' };
    const input = nativePreparationInput(
      scope,
      revision,
      loadImage(store, revision, images[0]!.image_id),
    );
    const key = nativeSummaryScope(preparedUnitIdentity(input));
    const present = store.nativeSummaryFunctions(key);
    const pending = calleesFirst(input.functions, input.references).filter(
      (fn) => !present.has(fn.id),
    );
    if (pending.length === 0) return report('skipped');
    // The job stops handing out functions once the helpers wrote what the cap leaves room
    // for, and does not start for less than a sixteenth of it (a capped store stays nearly
    // full once the job filled it: requests' rows replace the oldest).
    const usage = store.nativeSummaryUsage();
    const room = usage.cap - usage.bytes;
    if (room <= 0 || room < usage.cap / 16)
      return report('skipped', 'The unit store is at its byte cap');
    jobs = Math.max(
      1,
      Math.min(
        options.jobs ?? Math.min(8, Math.max(1, availableParallelism() >> 1)),
        Math.ceil(pending.length / FUNCTIONS_PER_HELPER),
      ),
    );
    const budget = options.work ?? DEFAULT_OPEN_JOB_WORK;
    scratch = mkdtempSync(join(tmpdir(), 'open-decomp-units-'));
    const base = join(scratch, 'base');
    store.copyProject(base);
    // One owner per project database: every helper gets its own copy (copy-on-write where
    // the filesystem supports it).
    for (let index = 0; index < jobs; index++) {
      const project = index === 0 ? base : join(scratch, `h${index}`);
      if (index > 0) cpSync(base, project, { recursive: true, mode: constants.COPYFILE_FICLONE });
      helpers.push(new Helper(project));
    }
    let next = 0,
      exhausted = false,
      full = false;
    const run = async (helper: Helper): Promise<void> => {
      helper.send({ kind: 'open', project: helper.project });
      for (;;) {
        const event = await helper.next();
        if (event.kind === 'error') throw new Error(event.message);
        if (event.kind === 'prepared') {
          work += event.work;
          retained += event.retained;
          bytes += event.bytes;
        }
        if (event.kind === 'finished') return;
        if (work >= budget) exhausted = true;
        if (bytes >= room) full = true;
        if (signal?.aborted || exhausted || full || next >= pending.length) {
          helper.send({ kind: 'finish' });
          continue;
        }
        const ids = pending.slice(next, next + BATCH).map((fn) => fn.id);
        next += ids.length;
        prepared += ids.length;
        helper.send({ kind: 'prepare', ids });
      }
    };
    await Promise.all(helpers.map(run));
    signal?.throwIfAborted();
    stored = store.importNativeSummaries(
      helpers.map((helper) => helper.project),
      key,
      pending.map((fn) => fn.id),
    );
    if (next >= pending.length) return report('completed');
    return report(
      'limited',
      exhausted ? 'The job work budget was exhausted' : 'The unit store byte cap was reached',
    );
  } catch (error) {
    if (signal?.aborted) return report('cancelled');
    return report('failed', error instanceof Error ? error.message : String(error));
  } finally {
    signal?.removeEventListener('abort', onAbort);
    for (const helper of helpers) helper.kill();
    await Promise.all(helpers.map((helper) => helper.exited));
    if (scratch !== undefined) rmSync(scratch, { recursive: true, force: true });
  }
}

/** One function's generic unit, prepared exactly as a request's worklist load under the
 * largest allowance such a load can receive, through the shared loader: a retained unit is
 * persisted with its exact charge and reads (a marker row otherwise). Returns its work and
 * whether it was retained. */
function prepareForStore(
  input: NativePreparationInput,
  fn: FunctionRecord,
): { readonly work: number; readonly retained: boolean } {
  const { store, job_id } = input.scope;
  const context = createOperationContext({ budget: DEFAULT_BUDGET });
  const dependencies = createAnalysisReadset(store, input.revision, context);
  const unitInput: NativePreparationInput = {
    ...input,
    scope: { store: dependencies.store, context, job_id, dependencies },
  };
  const cache = preparedUnitCache(unitInput);
  const allowance = nativeLoadAllowanceBound(DEFAULT_BUDGET.work);
  let used = 0;
  const bounded: OperationContext = {
    ...context,
    remainingWork: () => Math.max(0, Math.min(allowance - used, context.remainingWork!())),
    checkpoint(amount) {
      if (used + amount > allowance)
        throw new OperationError({
          code: 'resource_limit',
          severity: 'warning',
          message: 'Open-time job unit allowance exhausted',
          evidence_ids: [],
          details: { kind: 'limit', resource: 'work', limit: allowance, consumed: used + amount },
        });
      context.checkpoint(amount);
      used += amount;
    },
  };
  const load = nativeUnitLoader(
    unitInput,
    cache,
    nativeLibraryContracts(unitInput),
    (charge, reads) =>
      charge <= bounded.remainingWork!() && charge + reads <= context.remainingWork!(),
  );
  try {
    load(fn, bounded);
  } catch (error) {
    // A unit the job cannot prepare within its allowance (or at all) is left to requests.
    if (error instanceof OperationError && error.code === 'cancelled') throw error;
  }
  const retained = cache.entries.get(fn.id)?.stored !== undefined;
  if (!retained) cache.persistence?.skip(fn);
  store.releaseNativeSummaries();
  return { work: context.consumedWork!(), retained };
}

/** The helper process: opens its project copy, prepares what it is handed, writes its
 * summaries and exits on `finish`. */
export function runNativeUnitHelper(): void {
  let store: SqliteProjectStore | undefined;
  let input: NativePreparationInput | undefined;
  let byId: ReadonlyMap<string, FunctionRecord> | undefined;
  // Payload bytes written so far (the copy's own rows included).
  let written = 0;
  const send = (event: HelperEvent): void => {
    process.stdout.write(`${JSON.stringify(event)}\n`);
  };
  const lines = createInterface({ input: process.stdin });
  lines.on('line', (line) => {
    try {
      const command = JSON.parse(line) as HelperCommand;
      if (command.kind === 'open') {
        // The copy keeps every row; the owner chooses what fits its cap at import.
        store = SqliteProjectStore.open(command.project, 'resume', {
          native_summary_bytes: Number.MAX_SAFE_INTEGER,
        });
        written = store.nativeSummaryUsage().bytes;
        const snapshot = store.snapshot();
        const image = snapshot.images[0]!;
        const context = createOperationContext({
          budget: { work: 100_000_000, deadline_ms: 300_000 },
        });
        input = nativePreparationInput(
          { store, context, job_id: 'open-time-job' },
          snapshot.revision,
          loadImage(store, snapshot.revision, image.image_id),
        );
        byId = new Map(input.functions.map((fn) => [fn.id, fn]));
        send({ kind: 'ready' });
      } else if (command.kind === 'prepare') {
        let work = 0,
          retained = 0;
        for (const id of command.ids) {
          const fn = byId?.get(id);
          if (!fn || !input) continue;
          const result = prepareForStore(input, fn);
          work += result.work;
          if (result.retained) retained++;
        }
        // Written now, so the owner can stop at its byte cap.
        store?.flushNativeSummaries();
        const now = store?.nativeSummaryUsage().bytes ?? written;
        send({ kind: 'prepared', work, retained, bytes: now - written });
        written = now;
      } else {
        store?.flushNativeSummaries();
        void store?.close().then(() => {
          send({ kind: 'finished' });
          lines.close();
        });
      }
    } catch (error) {
      send({ kind: 'error', message: error instanceof Error ? error.message : String(error) });
      process.exitCode = 1;
      lines.close();
    }
  });
}
