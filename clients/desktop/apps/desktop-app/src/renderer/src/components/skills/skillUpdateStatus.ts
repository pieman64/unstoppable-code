import { useSyncExternalStore } from 'react';

/**
 * Update availability learned in this renderer since the inventory was read
 * (CAN-4264), shared by every mounted `useInstalledSkillActions`, so the
 * Installed Skills list and a skill's detail page cannot disagree.
 *
 * Every entry records the sequence number of the operation that produced
 * it. A check result carries its check's start, an applied update the
 * moment it succeeded, so a check that started before an update can never
 * restore that skill's availability. A key absent here falls back to the
 * inventory's cached `updateAvailable`.
 */
interface UpdateStatusEntry {
  available: boolean;
  sequence: number;
  /** When it was recorded; a later install or update supersedes it. */
  recordedAt: number;
}

interface UpdateStatusState {
  entries: ReadonlyMap<string, UpdateStatusEntry>;
  /** When a check last completed in this renderer; `null` before one. */
  checkedAt: number | null;
  /** Skills an update is running for, from any mounted view. */
  applying: ReadonlySet<string>;
  /** Successful updates per skill, so a page showing it can reload. */
  applied: ReadonlyMap<string, number>;
}

let sequence = 0;
let state: UpdateStatusState = {
  entries: new Map(),
  checkedAt: null,
  applying: new Set(),
  applied: new Map(),
};
const listeners = new Set<() => void>();

function commit(next: Partial<UpdateStatusState>): void {
  state = { ...state, ...next };
  listeners.forEach((listener) => listener());
}

/** A sequence number for a check starting now. */
export function beginSkillUpdateCheck(): number {
  sequence += 1;
  return sequence;
}

/**
 * Merges a whole-inventory check result. Keys the result omits keep what
 * is known; explicit `false` replaces a known `true`. Entries recorded after
 * the check started win.
 */
export function recordSkillUpdateCheck(
  updateMap: Record<string, boolean>,
  checkSequence: number,
): void {
  const next = new Map(state.entries);
  for (const [key, available] of Object.entries(updateMap)) {
    const known = next.get(key);
    if (known && known.sequence >= checkSequence) {
      // With no correlated start, false is the conservative result: clear
      // an old positive, but never resurrect an update after a newer apply.
      if (checkSequence === 0 && !available && known.available) {
        next.set(key, {
          available: false,
          sequence: known.sequence,
          recordedAt: Date.now(),
        });
      }
      continue;
    }
    next.set(key, {
      available,
      sequence: checkSequence,
      recordedAt: Date.now(),
    });
  }
  // A completed check is news even when nothing changed: the detail page
  // may now say the skill is up to date.
  commit({ entries: next, checkedAt: Date.now() });
}

/** The skill was updated: no update is known until a later check. */
export function recordSkillUpdateApplied(key: string): void {
  sequence += 1;
  const next = new Map(state.entries);
  next.set(key, { available: false, sequence, recordedAt: Date.now() });
  const applied = new Map(state.applied);
  applied.set(key, (applied.get(key) ?? 0) + 1);
  commit({ entries: next, applied });
}

/**
 * Claims `key` for an update. The detail page and the Installed Skills list
 * behind it are separate views; only one may update a skill at a time.
 * Returns false when an update of `key` is already running.
 */
export function beginSkillUpdateApply(key: string): boolean {
  if (state.applying.has(key)) return false;
  commit({ applying: new Set(state.applying).add(key) });
  return true;
}

/** Releases `key` once its update settled, whatever the outcome. */
export function endSkillUpdateApply(key: string): void {
  if (!state.applying.has(key)) return;
  const next = new Set(state.applying);
  next.delete(key);
  commit({ applying: next });
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return (): void => {
    listeners.delete(listener);
  };
}

function snapshot(): UpdateStatusState {
  return state;
}

/**
 * Availability for `key`, or `cached` when nothing newer is known. A record
 * the inventory says changed after the entry (`changedAt`: a reinstall or
 * an update made elsewhere) supersedes it, so a removed and reinstalled
 * skill never inherits its old update.
 */
export function useSkillUpdateAvailability(): (
  key: string,
  cached: boolean,
  changedAt?: number,
) => boolean {
  const current = useSyncExternalStore(subscribe, snapshot, snapshot);
  return (key, cached, changedAt) => {
    const known = current.entries.get(key);
    if (!known) return cached;
    if (changedAt !== undefined && changedAt > known.recordedAt) return cached;
    return known.available;
  };
}

/**
 * How many updates of `key` succeeded in this renderer. A page showing the
 * skill reloads its content when this changes, whichever view started the
 * update and whether or not it was left and reopened meanwhile.
 */
export function useSkillUpdateAppliedRevision(key: string): number {
  return (
    useSyncExternalStore(subscribe, snapshot, snapshot).applied.get(key) ?? 0
  );
}

/** Skills an update is running for, from any mounted view. */
export function useSkillUpdatesApplying(): ReadonlySet<string> {
  return useSyncExternalStore(subscribe, snapshot, snapshot).applying;
}

/** When a check for updates last completed in this renderer, if ever. */
export function useSkillUpdateCheckedAt(): number | null {
  return useSyncExternalStore(subscribe, snapshot, snapshot).checkedAt;
}
