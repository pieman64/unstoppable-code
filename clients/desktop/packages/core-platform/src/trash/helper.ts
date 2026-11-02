import type {
  PlatformExecutionOutput,
  PlatformExecutionProcess,
  PlatformExecutionProcessServices,
} from '@canopy/core-runtime';

export interface TrashHelperCommand {
  readonly executable: string;
  readonly args: readonly string[];
  readonly environment: Readonly<Record<string, string>>;
}

/** `exited` only when the helper ended on its own with all of its output. */
export type TrashHelperReport =
  | {
      readonly kind: 'exited';
      readonly code: number | null;
      readonly stdout: string;
      readonly stderr: string;
    }
  | { readonly kind: 'unfinished' };

export interface TrashHelperLimits {
  readonly timeoutMs: number;
  /** Per stream; past it the helper is stopped and its report is unread. */
  readonly outputBytes: number;
}

// A move is one rename; the timeout only ends a helper that hangs, for
// example on a privacy prompt nobody answers.
const LIMITS: TrashHelperLimits = { timeoutMs: 60_000, outputBytes: 4096 };
const UNFINISHED: TrashHelperReport = Object.freeze({ kind: 'unfinished' });

/**
 * Runs one Trash helper to completion under execution-process custody, with
 * stdin closed, `/` as its working directory, bounded output and a timeout.
 * The helper is stopped forcefully on timeout or overflow. A report counts
 * only when the helper exited on its own and all of its output was read.
 */
export async function runTrashHelper(
  processes: PlatformExecutionProcessServices,
  command: TrashHelperCommand,
  limits: TrashHelperLimits = LIMITS,
): Promise<TrashHelperReport> {
  let child: PlatformExecutionProcess;
  try {
    child = await processes.start({
      executable: command.executable,
      args: command.args,
      cwd: '/',
      environment: command.environment,
      stdin: 'ignore',
      stderr: 'pipe',
      outputWindowBytes: limits.outputBytes,
    });
  } catch {
    return UNFINISHED;
  }
  let unread = false;
  const stop = (): void => {
    child.terminate({ mode: 'force' }).catch(() => undefined);
  };
  const timer = setTimeout(stop, limits.timeoutMs);
  const collect = async (
    stream: PlatformExecutionOutput | null,
  ): Promise<string> => {
    if (stream === null) return '';
    const decoder = new TextDecoder();
    let text = '';
    let total = 0;
    try {
      for (;;) {
        const bytes = await stream.read();
        if (bytes === null) return text + decoder.decode();
        stream.acknowledge(bytes.byteLength);
        total += bytes.byteLength;
        if (total > limits.outputBytes) {
          unread = true;
          stop();
          return '';
        }
        text += decoder.decode(bytes, { stream: true });
      }
    } catch {
      unread = true;
      stop();
      return '';
    }
  };
  try {
    const [stdout, stderr, outcome] = await Promise.all([
      collect(child.stdout),
      collect(child.stderr),
      child.outcome,
    ]);
    if (unread || outcome.kind !== 'exited' || outcome.output !== 'complete')
      return UNFINISHED;
    return { kind: 'exited', code: outcome.code, stdout, stderr };
  } finally {
    clearTimeout(timer);
  }
}
