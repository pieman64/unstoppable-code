import { AsyncLocalStorage } from 'node:async_hooks';
import { W5FileWriteRefusedError } from '@canopy/core-runtime/node/w5/commit-log-file-store';
import { currentW5CommitScope } from './w5-commit-scope';
import { logMainProcessWarn } from './main-process-logging';

/*
 * A18′ bounded retry (W6g, CAN-5498). Over the daemon-backed record port a
 * write is decided against a fresh authority read, so a write another
 * authority-routed writer made between that read and this write's CAS is a
 * pre-decision fingerprint conflict. Only the outermost effect-free unit
 * reruns it: read, apply, reconciler `beforeWrite` and CAS, with the
 * reconciler's rollback undoing each refused attempt. In-process stores keep
 * one attempt, so their behavior is unchanged.
 */

interface PreEffectUnit {
  /** A commit scope opened inside the unit; its work may have run effects. */
  scoped: boolean;
  /** False once its attempt settles; detached work it started is outside it. */
  running: boolean;
}

const units = new AsyncLocalStorage<PreEffectUnit>();
let attempts = 1;

function currentUnit(): PreEffectUnit | undefined {
  const unit = units.getStore();
  return unit?.running ? unit : undefined;
}

/** How each conflict was handled, by unit or commit-log label. */
export type W5ConflictDisposition =
  | 'retried'
  | 'exhausted'
  | 'post-effect'
  | 'surfaced';

const conflictCounts = new Map<string, number>();

function countConflict(
  operation: string,
  disposition: W5ConflictDisposition,
  kind = 'fingerprint',
): void {
  const key = `${operation} ${kind} ${disposition}`;
  conflictCounts.set(key, (conflictCounts.get(key) ?? 0) + 1);
  logMainProcessWarn('W5 record commit conflict', {
    operation,
    kind,
    disposition,
  });
}

/** Conflict counts, keyed `<operation> <kind> <disposition>`: the measured rate. */
export function w5ConflictCounts(): ReadonlyMap<string, number> {
  return conflictCounts;
}

/**
 * Trusted daemon-backed composition only: the attempts each outermost unit
 * gets. Returns the restore.
 */
export function setW5PreEffectAttempts(next: number): () => void {
  if (!Number.isSafeInteger(next) || next < 1)
    throw new Error('W5 pre-effect attempts must be a positive integer');
  const previous = attempts;
  attempts = next;
  return (): void => {
    attempts = previous;
  };
}

/** Marks the current unit as one whose work may have run effects. */
export function noteW5CommitScopeOpened(): void {
  const unit = currentUnit();
  if (unit) unit.scoped = true;
}

/**
 * A refused or unapplied decision the record port reported. Inside a unit
 * the unit counts it; outside one it surfaces unchanged and is counted here.
 */
export function recordW5PortConflict(operation: string, kind: string): void {
  if (kind === 'fingerprint' && currentUnit()) return;
  countConflict(operation, 'surfaced', kind);
}

/**
 * Runs `work`, effect-free work that reads, decides and writes W5 records
 * without a commit scope, retrying it on a pre-decision fingerprint conflict.
 * Never retries a revision conflict, `recovery-required`, `unapplied-change`
 * or a thrown transport failure, whose outcome is uncertain. Nested in a
 * unit or a commit scope it runs once, and the conflict surfaces to the
 * outer unit or scope. Exhaustion throws the last conflict, as today.
 */
export async function runW5PreEffectUnit<T>(
  operation: string,
  work: () => Promise<T>,
): Promise<T> {
  if (attempts <= 1 || currentUnit() || currentW5CommitScope()) return work();
  for (let attempt = 1; ; attempt += 1) {
    const unit: PreEffectUnit = { scoped: false, running: true };
    try {
      return await units.run(unit, work);
    } catch (error) {
      if (!(error instanceof W5FileWriteRefusedError)) throw error;
      if (unit.scoped) {
        countConflict(operation, 'post-effect');
        throw error;
      }
      if (attempt >= attempts) {
        countConflict(operation, 'exhausted');
        throw error;
      }
      countConflict(operation, 'retried');
    } finally {
      unit.running = false;
    }
  }
}
