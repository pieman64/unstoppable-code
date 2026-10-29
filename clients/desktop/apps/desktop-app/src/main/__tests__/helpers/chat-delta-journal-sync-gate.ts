/**
 * Control over delta-journal syncs for the group-commit suites: hold every
 * journal sync until released, delay each by a seeded amount, fail the next
 * one, and count what completed. The spy is a Jest spy; the suite's
 * `jest.restoreAllMocks()` removes it.
 */
import fs from 'node:fs/promises';
import { sep } from 'node:path';
import { DELTA_JOURNAL_FILE_NAME } from '../../lib/chat-delta-journal/format';

export interface JournalSyncGate {
  /** Journal syncs that completed, across every scope. */
  completed(): number;
  /** Completed journal syncs of the scope whose directory is named `scopeId`. */
  completedFor(scopeId: string): number;
  /** Journal syncs that started and have not completed. */
  waiting(): number;
  /** Make journal syncs wait until {@link release}. */
  hold(): void;
  release(): void;
  /** The nth journal sync from now (1 is the next) rejects with `error`. */
  failSync(nth: number, error: Error): void;
  /** Each journal sync first waits `delay()` milliseconds. */
  delayEach(delay: () => number): void;
}

export function gateJournalSyncs(): JournalSyncGate {
  let held = false;
  let opened = (): void => undefined;
  let gate: Promise<void> = Promise.resolve();
  let waiting = 0;
  let started = 0;
  let delay: (() => number) | undefined;
  const failures = new Map<number, Error>();
  const completed: string[] = [];
  const open = fs.open;
  jest.spyOn(fs, 'open').mockImplementation(async (path, flags, mode) => {
    const handle = await open(path, flags, mode);
    if (
      typeof path !== 'string' ||
      !path.endsWith(DELTA_JOURNAL_FILE_NAME) ||
      flags !== 'r+'
    )
      return handle;
    const sync = handle.sync.bind(handle);
    handle.sync = async (): Promise<void> => {
      started += 1;
      const ordinal = started;
      waiting += 1;
      try {
        const wait = delay?.() ?? 0;
        if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
        while (held) await gate;
        const failure = failures.get(ordinal);
        if (failure) {
          failures.delete(ordinal);
          throw failure;
        }
        await sync();
        completed.push(path);
      } finally {
        waiting -= 1;
      }
    };
    return handle;
  });
  return {
    completed: (): number => completed.length,
    completedFor: (scopeId): number =>
      completed.filter((path) => path.split(sep).includes(scopeId)).length,
    waiting: (): number => waiting,
    hold: (): void => {
      if (held) return;
      held = true;
      gate = new Promise<void>((resolve) => {
        opened = resolve;
      });
    },
    release: (): void => {
      held = false;
      opened();
    },
    failSync: (nth, error): void => {
      failures.set(started + nth, error);
    },
    delayEach: (next): void => {
      delay = next;
    },
  };
}

/** Poll until `condition` holds; fails with `label` after ten seconds. */
export async function eventually(
  condition: () => boolean | Promise<boolean>,
  label: string,
): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** Whether `work` settled within `ms`. */
export async function settlesWithin(
  work: Promise<unknown>,
  ms: number,
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const settled = work.then(
    () => true,
    () => true,
  );
  const result = await Promise.race([
    settled,
    new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), ms);
    }),
  ]);
  clearTimeout(timer);
  return result;
}
