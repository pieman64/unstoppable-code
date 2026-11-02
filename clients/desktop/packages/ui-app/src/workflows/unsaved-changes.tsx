'use client';

import { useCallback, useEffect, useRef, useState, type JSX } from 'react';
import { ConfirmDialog } from '@canopy/ui-shared/components';
import { REPLAY_MASK_CLASS } from '@canopy/ui-shared/lib/replay-privacy';

/** What a save attempt came to. A failure keeps the editor and the draft. */
export type UnsavedChangesSaveResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly message?: string };

export interface UseUnsavedChangesGuardOptions {
  readonly isDirty: boolean;
  /**
   * Saves the draft. Resolve `{ ok: false }` for a validation failure or a
   * failed request: the editor shows the issue in place, nothing is written
   * and the pending navigation is dropped.
   */
  readonly save: () => Promise<UnsavedChangesSaveResult>;
  /** Drops the draft. Called before a Discard lets the navigation through. */
  readonly discard?: () => void;
  /**
   * Identifies what is being edited. When it changes the guard forgets any
   * open prompt, so one item's prompt never answers for another.
   */
  readonly targetKey: string;
}

export interface UnsavedChangesGuard {
  /**
   * Ask before leaving. Resolves `true` when the host may navigate: the
   * draft is clean, the user discarded it, or the save succeeded. Resolves
   * `false` when the user kept editing or the save failed.
   */
  readonly confirmLeave: () => Promise<boolean>;
  /**
   * The draft is clean, so leaving needs no prompt. A host whose navigation
   * seam is synchronous checks this first and calls `confirmLeave` only when
   * it is `false`, so a clean draft never defers the navigation.
   */
  readonly canLeaveNow: () => boolean;
  /** A prompt is open. */
  readonly prompting: boolean;
  /** The prompt's Save is running. */
  readonly saving: boolean;
  /** Why the last save from the prompt failed. */
  readonly error: string | null;
  readonly onSave: () => void;
  readonly onDiscard: () => void;
  /** X, Escape or a click outside: keep editing. */
  readonly onKeepEditing: () => void;
}

/**
 * One unsaved-changes guard for Workflows editors (CAN-3981). A host wires
 * `confirmLeave` into its navigation seam and into the editor's own target
 * switches, and renders `UnsavedChangesDialog` from the rest.
 *
 * Only one prompt is open at a time: a second `confirmLeave` while one is
 * pending resolves the first as "kept editing" and takes its place.
 */
export function useUnsavedChangesGuard({
  isDirty,
  save,
  discard,
  targetKey,
}: UseUnsavedChangesGuardOptions): UnsavedChangesGuard {
  const [prompting, setPrompting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const resolverRef = useRef<((leave: boolean) => void) | null>(null);
  // Read through refs so `confirmLeave` keeps one identity for the host's
  // navigation seam while the draft changes underneath it.
  const dirtyRef = useRef(isDirty);
  const saveRef = useRef(save);
  const discardRef = useRef(discard);
  dirtyRef.current = isDirty;
  saveRef.current = save;
  discardRef.current = discard;

  /** A save is running, whichever prompt started it. */
  const savingRef = useRef(false);
  const targetKeyRef = useRef(targetKey);
  targetKeyRef.current = targetKey;

  const settle = useCallback((leave: boolean): void => {
    const resolve = resolverRef.current;
    resolverRef.current = null;
    setPrompting(false);
    setSaving(false);
    resolve?.(leave);
  }, []);

  const canLeaveNow = useCallback((): boolean => !dirtyRef.current, []);

  const confirmLeave = useCallback((): Promise<boolean> => {
    if (!dirtyRef.current) return Promise.resolve(true);
    resolverRef.current?.(false);
    setError(null);
    // A save still running was started from the prompt this one replaces;
    // this prompt waits for it and is answered by its result.
    setSaving(savingRef.current);
    setPrompting(true);
    return new Promise<boolean>((resolve) => {
      resolverRef.current = resolve;
    });
  }, []);

  const onSave = useCallback((): void => {
    if (resolverRef.current === null || savingRef.current) return;
    const savedTarget = targetKeyRef.current;
    savingRef.current = true;
    setSaving(true);
    setError(null);
    // Called inside the chain, so a save that throws ends like one that
    // rejects.
    void Promise.resolve()
      .then(() => saveRef.current())
      .finally(() => {
        savingRef.current = false;
      })
      .then(
        (result): UnsavedChangesSaveResult => result,
        (reason: unknown): UnsavedChangesSaveResult => ({
          ok: false,
          message: reason instanceof Error ? reason.message : undefined,
        }),
      )
      .then((result) => {
        // Another item is being edited now: this save says nothing about it.
        if (targetKeyRef.current !== savedTarget) {
          setSaving(false);
          return;
        }
        // The save answers whichever prompt is open, the one that started it
        // or one that replaced it. With none open there is nothing to answer.
        if (resolverRef.current === null) return;
        if (result.ok) {
          settle(true);
          return;
        }
        // A failed save keeps the editor open and drops the navigation; the
        // editor shows the issue in place.
        setError(result.message ?? null);
        settle(false);
      });
  }, [settle]);

  const onDiscard = useCallback((): void => {
    if (resolverRef.current === null) return;
    discardRef.current?.();
    settle(true);
  }, [settle]);

  const onKeepEditing = useCallback((): void => {
    settle(false);
  }, [settle]);

  useEffect(() => {
    return (): void => {
      // A different item, or the editor unmounting: the old prompt no longer
      // applies, and its navigation must not continue.
      resolverRef.current?.(false);
      resolverRef.current = null;
      setPrompting(false);
      setSaving(false);
      setError(null);
    };
  }, [targetKey]);

  return {
    confirmLeave,
    canLeaveNow,
    prompting,
    saving,
    error,
    onSave,
    onDiscard,
    onKeepEditing,
  };
}

export interface UnsavedChangesDialogProps {
  /** The item's name, shown in the title. */
  readonly name: string;
  readonly saving?: boolean;
  readonly onSave: () => void;
  readonly onDiscard: () => void;
  /** Cancel, Escape or a click outside: keep editing. */
  readonly onKeepEditing: () => void;
}

/**
 * `Save changes to “…”?`, a two-way choice: Cancel keeps editing, then
 * Discard and the default Save changes, which Enter presses.
 */
export function UnsavedChangesDialog({
  name,
  saving = false,
  onSave,
  onDiscard,
  onKeepEditing,
}: UnsavedChangesDialogProps): JSX.Element {
  return (
    <ConfirmDialog
      title={
        <span>
          Save changes to “<span className={REPLAY_MASK_CLASS}>{name}</span>”?
        </span>
      }
      message="Discarding loses the edits you haven’t saved."
      confirmLabel="Save changes"
      busyLabel="Saving…"
      busy={saving}
      onConfirm={onSave}
      onCancel={onKeepEditing}
      secondaryAction={{
        label: 'Discard',
        onSelect: onDiscard,
        testId: 'workflows-unsaved-discard',
      }}
      dataTestId="workflows-unsaved-dialog"
      confirmTestId="workflows-unsaved-save"
      cancelTestId="workflows-unsaved-cancel"
    />
  );
}
