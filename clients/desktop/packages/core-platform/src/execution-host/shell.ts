import * as path from 'node:path';
import { Worker } from 'node:worker_threads';
import {
  EXECUTION_HOST_LIMIT_EXIT_CODES,
  type ExecutionHostBudget,
  type ExecutionHostLimit,
} from './port';

/**
 * The execution host shell enforces a host's budget from inside its process,
 * which works where Node options cannot be passed: the closed single
 * executable refuses them. The host entry runs on a worker thread; the main
 * thread only relays stdio, so it stays responsive while the entry runs
 * synchronous work, and it stops the entry once the entry's sampled heap or
 * the process's resident set passes the budget. Stopping or
 * losing the entry thread tears down its isolate, which closes every SQLite
 * connection it still holds, so a limit, a cancel or a shutdown never leaves
 * a writer open the way a process abort would.
 */

const ENTRY_ARG = '--canopy-execution-host=';
const HEAP_ARG = '--canopy-execution-host-heap-mb=';
const RSS_ARG = '--canopy-execution-host-rss-mb=';
const MEBIBYTE = 1024 * 1024;
/** How long a stopping entry may take to unwind before the shell exits. */
const STOP_GRACE_MS = 1_500;
const SIGNAL_EXIT_CODES = Object.freeze({ SIGTERM: 143, SIGINT: 130 });

export interface ExecutionHostShellRequest {
  /** A bundled entry file name, such as `code-graph-build-host.js`. */
  readonly entry: string;
  readonly budget: ExecutionHostBudget;
}

/**
 * The entries a shell-capable executable serves. The shell runs only these,
 * from its own directory, so the entry mode cannot run arbitrary code under
 * the executable's identity.
 */
export interface ExecutionHostShellEntries {
  /** Directory holding the bundled entries, fully qualified. */
  readonly directory: string;
  readonly names: readonly string[];
}

/** Bundled entries only: a plain `.js` file name, never a path. */
export const EXECUTION_HOST_ENTRY_PATTERN = /^[a-z0-9][a-z0-9-]*\.js$/;

function isBudgetValue(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

/** The arguments that ask a shell-capable executable to run `request`. */
export function executionHostShellArgs(
  request: ExecutionHostShellRequest,
): string[] {
  if (!EXECUTION_HOST_ENTRY_PATTERN.test(request.entry))
    throw new Error('Unknown execution host entry.');
  if (
    !isBudgetValue(request.budget.heapMb) ||
    !isBudgetValue(request.budget.rssMb)
  )
    throw new Error('An execution host budget must be positive whole MiB.');
  return [
    `${ENTRY_ARG}${request.entry}`,
    `${HEAP_ARG}${request.budget.heapMb}`,
    `${RSS_ARG}${request.budget.rssMb}`,
  ];
}

/**
 * The shell request in `args`, or undefined when they do not ask for one.
 * Arguments that ask for a shell but do not form a valid request throw.
 */
export function parseExecutionHostShellArgs(
  args: readonly string[],
): ExecutionHostShellRequest | undefined {
  const value = (prefix: string): string | undefined =>
    args.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
  const entry = value(ENTRY_ARG);
  if (entry === undefined) return undefined;
  const heapMb = Number(value(HEAP_ARG));
  const rssMb = Number(value(RSS_ARG));
  if (
    args.length !== 3 ||
    !EXECUTION_HOST_ENTRY_PATTERN.test(entry) ||
    !isBudgetValue(heapMb) ||
    !isBudgetValue(rssMb)
  )
    throw new Error('Malformed execution host shell arguments.');
  return { entry, budget: { heapMb, rssMb } };
}

export interface ExecutionHostShellOptions {
  /** Interval for sampling the entry's heap and the resident set. */
  readonly sampleIntervalMs?: number;
}

/** The heap limits the shell holds an entry to. */
export interface ExecutionHostHeapLimits {
  /** Sampled used heap above which the shell stops the entry. */
  readonly stopBytes: number;
  /** The worker's V8 old-generation cap, a backstop above `stopBytes`. */
  readonly v8CapMb: number;
}

/**
 * The sampled heap is held to the budget, above the young generation's share.
 * It is the limit that stops the entry: at its own cap V8 gives a worker only
 * 16 MiB of grace to stop, and an entry that allocates past it aborts the
 * whole process (134) with its writers open. So V8's cap sits a headroom
 * above the sampled limit and is only a backstop. V8 starts a full collection
 * by about the midpoint of the live heap and its cap, so with this cap
 * uncollected garbage is unlikely to carry the sampled heap past the limit
 * while the live heap stays within the budget; only the young generation
 * and allocation during marking can add to it. A V8 heap option on the process
 * (NODE_OPTIONS or the executable's own arguments) silently lifts that cap;
 * the sampled limit holds either way. When the budget's heap is close to its
 * resident limit, the resident limit fires first, as it did when V8's cap
 * equalled the heap budget.
 */
export function executionHostHeapLimits(
  budget: ExecutionHostBudget,
): ExecutionHostHeapLimits {
  const headroomMb = Math.max(64, budget.heapMb / 8);
  return {
    stopBytes: (budget.heapMb + headroomMb) * MEBIBYTE,
    v8CapMb: Math.ceil(budget.heapMb + 2 * headroomMb),
  };
}

/**
 * Runs `request.entry` under its budget and exits this process with the
 * entry's exit code, or with a limit's code from
 * {@link EXECUTION_HOST_LIMIT_EXIT_CODES} once a limit stops it.
 */
export function runExecutionHostShell(
  request: ExecutionHostShellRequest,
  entries: ExecutionHostShellEntries,
  options: ExecutionHostShellOptions = {},
): void {
  if (!entries.names.includes(request.entry))
    throw new Error('Unknown execution host entry.');
  // The headroom between the sampled heap limit and V8's cap absorbs what the
  // entry allocates between samples, and the collections during which the
  // entry cannot answer a sample or stop.
  const heapLimits = executionHostHeapLimits(request.budget);
  const worker = new Worker(path.join(entries.directory, request.entry), {
    argv: [],
    stdin: true,
    stdout: true,
    stderr: true,
    resourceLimits: {
      maxOldGenerationSizeMb: heapLimits.v8CapMb,
    },
  });
  let exitCode: number | undefined;
  let finished = false;
  let unwinding: NodeJS.Timeout | undefined;
  const outputs = [
    new Promise<void>((resolve) => worker.stdout.once('end', resolve)),
    new Promise<void>((resolve) => worker.stderr.once('end', resolve)),
  ];
  worker.stdout.pipe(process.stdout, { end: false });
  worker.stderr.pipe(process.stderr, { end: false });
  if (worker.stdin) process.stdin.pipe(worker.stdin);

  const finish = (code: number): void => {
    if (finished) return;
    finished = true;
    clearInterval(sampler);
    // Every byte the entry wrote reaches the launcher before the exit, so a
    // terminal message is never lost to the shell's own exit.
    void Promise.all(outputs).then(() =>
      process.stdout.write('', () =>
        process.stderr.write(
          `The execution host peaked at ${Math.ceil(peakHeapBytes / MEBIBYTE)} MiB of heap and ${Math.ceil(peakRssBytes / MEBIBYTE)} MiB resident.\n`,
          () => process.exit(code),
        ),
      ),
    );
  };
  const stop = (code: number, reason?: ExecutionHostLimit): void => {
    if (exitCode !== undefined) return;
    exitCode = code;
    if (reason === 'heap')
      process.stderr.write(
        `The execution host reached its heap limit of ${request.budget.heapMb} MiB.\n`,
      );
    if (reason === 'rss')
      process.stderr.write(
        `The execution host reached its resident memory limit of ${request.budget.rssMb} MiB.\n`,
      );
    void worker.terminate();
    // An entry blocked in native code cannot be interrupted; exiting the
    // process still ends it.
    unwinding = setTimeout(() => process.exit(code), STOP_GRACE_MS);
  };

  // Peaks are sampled, so they are a lower bound; they let a launcher size
  // budgets from real runs.
  let peakHeapBytes = 0;
  let peakRssBytes = 0;
  const rssLimitBytes = request.budget.rssMb * MEBIBYTE;
  // One heap sample at a time. A sample the entry never answers stops only
  // heap sampling; the resident set is still sampled on every tick.
  let sampling = false;
  const sampler = setInterval(() => {
    const rss = process.memoryUsage.rss();
    peakRssBytes = Math.max(peakRssBytes, rss);
    if (rss > rssLimitBytes) stop(EXECUTION_HOST_LIMIT_EXIT_CODES.rss, 'rss');
    if (sampling) return;
    sampling = true;
    worker
      .getHeapStatistics()
      .then(
        (heap) => {
          peakHeapBytes = Math.max(peakHeapBytes, heap.used_heap_size);
          if (heap.used_heap_size > heapLimits.stopBytes)
            stop(EXECUTION_HOST_LIMIT_EXIT_CODES.heap, 'heap');
        },
        () => undefined,
      )
      .finally(() => {
        sampling = false;
      });
  }, options.sampleIntervalMs ?? 100);
  for (const signal of ['SIGTERM', 'SIGINT'] as const)
    process.once(signal, () => stop(SIGNAL_EXIT_CODES[signal]));

  worker.on('error', (error: Error) => {
    if (Reflect.get(error, 'code') === 'ERR_WORKER_OUT_OF_MEMORY') {
      stop(EXECUTION_HOST_LIMIT_EXIT_CODES.heap, 'heap');
      return;
    }
    // An uncaught exception ends a host, as it would on a main thread.
    process.stderr.write(`${error.stack ?? String(error)}\n`);
    exitCode ??= 1;
  });
  worker.once('exit', (code) => {
    clearTimeout(unwinding);
    finish(exitCode ?? code);
  });
}

/** The exit code of a shell asked for with malformed or unknown arguments. */
export const EXECUTION_HOST_SHELL_USAGE_EXIT_CODE = 64;

/**
 * Runs the shell when `args` ask for one. Returns false, doing nothing, when
 * they do not, so an executable can call it before its own startup. A
 * malformed request or an entry the shell does not serve exits with
 * {@link EXECUTION_HOST_SHELL_USAGE_EXIT_CODE} and fixed text.
 */
export function runRequestedExecutionHostShell(
  args: readonly string[],
  entries: ExecutionHostShellEntries,
): boolean {
  const refuse = (): true => {
    process.stderr.write('Malformed execution host request.\n');
    process.exitCode = EXECUTION_HOST_SHELL_USAGE_EXIT_CODE;
    return true;
  };
  let request: ExecutionHostShellRequest | undefined;
  try {
    request = parseExecutionHostShellArgs(args);
  } catch {
    return refuse();
  }
  if (request === undefined) return false;
  if (!entries.names.includes(request.entry)) return refuse();
  runExecutionHostShell(request, entries);
  return true;
}
