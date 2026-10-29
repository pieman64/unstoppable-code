import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

export type WindowsClosureFamily = 'git-host' | 'git' | 'identity' | 'acl';
export interface WindowsClosureEdge {
  unsafe(): void;
  close(): void;
}
export interface WindowsClosureReport {
  readonly runId: string;
  readonly started: number;
  readonly pending: number;
  readonly unsafe: boolean;
}

interface WindowsClosureContext {
  begin: WindowsClosureEdgeFactory;
  invalidate(): void;
}
const scope = new AsyncLocalStorage<WindowsClosureContext>();
type WindowsClosureEdgeFactory = (
  family: WindowsClosureFamily,
) => WindowsClosureEdge;

/** Relative-import qualification seam, inert outside an explicitly owned run. */
export function observeWindowsClosure(
  family: WindowsClosureFamily,
): WindowsClosureEdge | undefined {
  return scope.getStore()?.begin(family);
}

/** A preexisting/cross-context creator cannot silently contribute partial evidence. */
export function captureWindowsClosureContext(): () => void {
  const owner = scope.getStore();
  return (): void => {
    const current = scope.getStore();
    if (current !== owner) {
      owner?.invalidate();
      current?.invalidate();
    }
  };
}

/**
 * A necessary closure gate, NOT a lineage certificate: the caller must bind
 * executable/configuration semantics and close every creation-capable owner.
 * Reports are usable only with this live instance's accepts(), never as JSON.
 */
export function createWindowsClosureWitness(): {
  run<T>(work: () => T | Promise<T>): Promise<T>;
  finalize(): WindowsClosureReport;
  accepts(report: unknown): boolean;
} {
  const runId = randomUUID();
  let started = 0;
  let pending = 0;
  let unsafe = false;
  let running = false;
  let ran = false;
  let report: WindowsClosureReport | undefined;
  const begin: WindowsClosureEdgeFactory = () => {
    // Constant memory; exhaustion never truncates to success.
    if (report || !running || started >= 4096) unsafe = true;
    if (started < 4096) started++;
    pending++;
    let closed = false;
    return {
      unsafe: (): void => {
        unsafe = true;
      },
      close: (): void => {
        if (closed) unsafe = true;
        else {
          closed = true;
          pending--;
        }
      },
    };
  };
  return Object.freeze({
    async run<T>(work: () => T | Promise<T>): Promise<T> {
      if (ran || report || scope.getStore()) {
        unsafe = true;
        throw new Error('Windows closure run reused or nested');
      }
      ran = running = true;
      try {
        return await scope.run(
          {
            begin,
            invalidate: (): void => {
              unsafe = true;
            },
          },
          work,
        );
      } catch (error) {
        unsafe = true;
        throw error;
      } finally {
        running = false;
      }
    },
    finalize(): WindowsClosureReport {
      if (report || !ran || running) unsafe = true;
      // An early failure is frozen: later cleanup cannot upgrade it.
      report ??= Object.freeze({ runId, started, pending, unsafe });
      return report;
    },
    accepts(candidate: unknown): boolean {
      return (
        candidate === report &&
        report !== undefined &&
        ran &&
        !running &&
        !unsafe &&
        !report.unsafe &&
        started > 0 &&
        pending === 0 &&
        report.pending === 0
      );
    },
  });
}
