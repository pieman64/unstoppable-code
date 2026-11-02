import { useCallback, useEffect, useRef, useState } from 'react';
import type { SettingsSaveState } from '@canopy/ui-shared/components';

/** How long a settled change keeps saying "Saved" before the line rests. */
export const AUTOSAVE_SAVED_HOLD_MS = 2400;

/** Quiet time after the last edit before it is written. */
export const AUTOSAVE_DELAY_MS = 600;

export interface UseAutosaveOptions {
  /**
   * The unsaved draft, serialized, or null when nothing differs from what is
   * saved. Each new value restarts the delay, so typing saves once it pauses.
   */
  readonly pending: string | null;
  /**
   * False holds the save, for a draft that cannot be written yet: an invalid
   * field, or an editor that is still busy. The draft stays pending.
   */
  readonly enabled?: boolean;
  readonly delayMs?: number;
  /** Writes the current draft. A rejection is reported as the error. */
  readonly save: () => Promise<void>;
}

export interface AutosaveResult {
  readonly state: SettingsSaveState;
  readonly error: string | null;
  /**
   * Writes a pending draft now, such as when the page closes. Resolves false
   * when the write failed, or when a draft is pending but held (`enabled` is
   * false), so the caller can keep the draft on screen.
   */
  readonly flush: () => Promise<boolean>;
}

/**
 * Saves a settings draft a moment after each change, one write at a time.
 * A change made while a write is in flight is written right after it. A
 * failed write keeps the draft and reports the error; the next change tries
 * again.
 */
export function useAutosave({
  pending,
  enabled = true,
  delayMs = AUTOSAVE_DELAY_MS,
  save,
}: UseAutosaveOptions): AutosaveResult {
  const [state, setState] = useState<SettingsSaveState>('idle');
  const [error, setError] = useState<string | null>(null);
  const saveRef = useRef(save);
  saveRef.current = save;
  const pendingRef = useRef(pending);
  pendingRef.current = pending;
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  const timerRef = useRef<number | null>(null);
  const settleTimerRef = useRef<number | null>(null);
  const inFlightRef = useRef<Promise<boolean> | null>(null);
  const rerunRef = useRef(false);
  const mountedRef = useRef(true);
  // The draft the last successful write stored, until the saved value
  // reloads (pending turns null). The same draft is not written twice while
  // that reload is on its way.
  const writtenRef = useRef<string | null>(null);
  if (pending === null) writtenRef.current = null;

  useEffect(() => {
    mountedRef.current = true;
    return (): void => {
      mountedRef.current = false;
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
      if (settleTimerRef.current !== null) {
        window.clearTimeout(settleTimerRef.current);
      }
    };
  }, []);

  const run = useCallback((): Promise<boolean> => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    if (inFlightRef.current) {
      rerunRef.current = true;
      return inFlightRef.current;
    }
    // Nothing to write is a success; a held draft is not written, so it is
    // not one.
    const writing = pendingRef.current;
    if (writing === null || writing === writtenRef.current) {
      return Promise.resolve(true);
    }
    if (!enabledRef.current) return Promise.resolve(false);
    if (settleTimerRef.current !== null) {
      window.clearTimeout(settleTimerRef.current);
      settleTimerRef.current = null;
    }
    setState('saving');
    setError(null);
    const write = (async (): Promise<boolean> => {
      let failed = false;
      try {
        await saveRef.current();
      } catch (cause) {
        failed = true;
        if (mountedRef.current) {
          setState('error');
          setError(
            cause instanceof Error && cause.message
              ? cause.message
              : 'Couldn’t save this change.',
          );
        }
      } finally {
        inFlightRef.current = null;
      }
      if (!failed) writtenRef.current = writing;
      if (!mountedRef.current) return !failed;
      if (rerunRef.current) {
        rerunRef.current = false;
        if (pendingRef.current !== null && enabledRef.current) {
          return run();
        }
      }
      if (failed) return false;
      setState('saved');
      settleTimerRef.current = window.setTimeout(() => {
        settleTimerRef.current = null;
        setState((current) => (current === 'saved' ? 'idle' : current));
      }, AUTOSAVE_SAVED_HOLD_MS);
      return true;
    })();
    inFlightRef.current = write;
    return write;
  }, []);

  useEffect(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    if (pending === null || !enabled) return;
    if (inFlightRef.current) {
      rerunRef.current = true;
      return;
    }
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      void run();
    }, delayMs);
  }, [delayMs, enabled, pending, run]);

  const flush = useCallback(async (): Promise<boolean> => {
    // A running save that fails is a failed flush, even when the failure
    // also dropped the draft and nothing is left for `run` to write.
    if (inFlightRef.current && !(await inFlightRef.current)) return false;
    return run();
  }, [run]);

  return { state, error, flush };
}

/**
 * Combines the save lines of a page's independent writers (the page draft,
 * a section with its own store) into the one line beside the page title.
 */
export function combineSaveStates(
  states: readonly SettingsSaveState[],
): SettingsSaveState {
  if (states.includes('saving')) return 'saving';
  if (states.includes('error')) return 'error';
  if (states.includes('saved')) return 'saved';
  return 'idle';
}
