import { useEffect, useMemo, useRef } from 'react';
import type {
  AppWindowApi,
  AppWindowConfirmCloseResponder,
} from '@canopy/desktop-shared/types';
import {
  useUnsavedChangesGuard,
  type UnsavedChangesSaveResult,
  type WorkflowEditUnsavedPrompt,
} from '@canopy/ui-app/workflows';
import {
  registerNavigationGuard,
  runWithoutNavigationGuard,
} from '@/stores/navigationStore';

export interface WorkflowEditGuardOptions {
  readonly isDirty: boolean;
  readonly save: () => Promise<UnsavedChangesSaveResult>;
  /** Drops the draft before a Discard lets the navigation through. */
  readonly discard?: () => void;
  /** The shown item's `workflowEditKey`. */
  readonly targetKey: string;
}

export interface WorkflowEditGuard {
  /** Resolves `true` when leaving is allowed; see `useUnsavedChangesGuard`. */
  readonly confirmLeave: () => Promise<boolean>;
  readonly canLeaveNow: () => boolean;
  /** The shell's `unsavedPrompt`: set while the prompt is open. */
  readonly prompt: WorkflowEditUnsavedPrompt | null;
  /** Why the last save from the prompt failed. */
  readonly error: string | null;
  /** Navigates without asking: Delete and post-save navigations. */
  readonly runWithoutNavigationGuard: <T>(fn: () => T) => T;
}

function getAppWindowApi(): AppWindowApi | undefined {
  return typeof window !== 'undefined' ? window.api?.appWindow : undefined;
}

function reportUnsavedChanges(dirty: boolean): Promise<void> {
  const api = getAppWindowApi();
  if (!api) return Promise.resolve();
  return api.setUnsavedChanges(dirty).catch(() => undefined);
}

/**
 * The edit shell's unsaved-changes guard (CAN-4072). It wraps the shared
 * `useUnsavedChangesGuard` and, for the shell's lifetime:
 *
 * - registers the navigation guard, so Back, another item, the sidebar and
 *   history all ask;
 * - reports the dirty state to main, which asks through `onConfirmClose`
 *   before the window closes or the app quits. The renderer acknowledges once
 *   the dialog is mounted and answers with the user's choice; main only
 *   proceeds unanswered when that acknowledgement never comes.
 */
export function useWorkflowEditGuard({
  isDirty,
  save,
  discard,
  targetKey,
}: WorkflowEditGuardOptions): WorkflowEditGuard {
  const guard = useUnsavedChangesGuard({ isDirty, save, discard, targetKey });
  const { canLeaveNow, confirmLeave, prompting } = guard;

  useEffect(
    () =>
      registerNavigationGuard(() => (canLeaveNow() ? true : confirmLeave())),
    [canLeaveNow, confirmLeave],
  );

  useEffect(() => {
    void reportUnsavedChanges(isDirty);
  }, [isDirty]);
  useEffect(
    () => (): void => {
      void reportUnsavedChanges(false);
    },
    [],
  );

  // A close or quit request waits here until the dialog it opened is
  // mounted, so main's acknowledgement timeout only covers a dead renderer.
  const pendingAckRef = useRef<AppWindowConfirmCloseResponder | null>(null);
  const promptingRef = useRef(prompting);
  promptingRef.current = prompting;
  useEffect(() => {
    if (!prompting) return;
    const responder = pendingAckRef.current;
    pendingAckRef.current = null;
    responder?.acknowledgeShown();
  }, [prompting]);

  useEffect(() => {
    const api = getAppWindowApi();
    if (!api) return undefined;
    return api.onConfirmClose((_request, responder) => {
      if (canLeaveNow()) {
        responder.acknowledgeShown();
        responder.resolve(true);
        return;
      }
      // A dialog already open for a navigation stays mounted and answers
      // this request instead, so `prompting` does not change and the effect
      // above never runs: acknowledge now, or main's timeout would close
      // the window while the user reads the dialog.
      const alreadyShown = promptingRef.current;
      if (!alreadyShown) pendingAckRef.current = responder;
      const decision = confirmLeave();
      if (alreadyShown) responder.acknowledgeShown();
      void decision.then(async (proceed) => {
        if (pendingAckRef.current === responder) {
          // Answered before the dialog rendered (a replaced prompt).
          pendingAckRef.current = null;
          responder.acknowledgeShown();
        }
        // Clear the report first so main's second close is not asked about.
        if (proceed) await reportUnsavedChanges(false);
        responder.resolve(proceed);
      });
    });
  }, [canLeaveNow, confirmLeave]);

  const prompt = useMemo<WorkflowEditUnsavedPrompt | null>(
    () =>
      guard.prompting
        ? {
            saving: guard.saving,
            onSave: guard.onSave,
            onDiscard: guard.onDiscard,
            onKeepEditing: guard.onKeepEditing,
          }
        : null,
    [
      guard.prompting,
      guard.saving,
      guard.onSave,
      guard.onDiscard,
      guard.onKeepEditing,
    ],
  );

  return {
    confirmLeave,
    canLeaveNow,
    prompt,
    error: guard.error,
    runWithoutNavigationGuard,
  };
}
