import { useState, type JSX } from 'react';
import { ConfirmDialog } from '@canopy/ui-shared/components';
import { useChatStore } from '@/stores/chatStore';
import {
  useFileTabUiStore,
  type PendingUnsavedFileClose,
} from '@/stores/fileTabUiStore';
import {
  desktopFileSessionController,
  useDesktopFileTabSession,
} from '@/lib/file-viewer/desktop-file-session-controller';

/**
 * Mounted once from `App`. Listens to `pendingUnsavedClose` on the file-tab UI
 * store and renders the unsaved-changes confirmation modal. All dirty/save
 * state comes from the shared file-viewer session (via the controller), never a
 * legacy mirror.
 *
 * The component reads `pendingUnsavedClose` itself, so it can mount
 * unconditionally — when there is no pending close, this returns null.
 */
export function FileTabCloseGuard(): JSX.Element | null {
  const pending = useFileTabUiStore((s) => s.pendingUnsavedClose);

  if (!pending) return null;

  return <FileTabCloseGuardModal pending={pending} />;
}

interface FileTabCloseGuardModalProps {
  pending: PendingUnsavedFileClose;
}

function FileTabCloseGuardModal({
  pending,
}: FileTabCloseGuardModalProps): JSX.Element {
  const [isSaving, setIsSaving] = useState(false);
  // Read status/error/dirty from the shared session matching BOTH tabId and the
  // captured fileKey — so a replacement file opened under the same tab id can't
  // surface a stale error or be closed against the wrong session.
  const session = useDesktopFileTabSession(pending.tabId, pending.fileKey);
  const error = session?.status === 'error' ? (session.error ?? null) : null;

  function handleDismiss(): void {
    if (isSaving) return; // ignore X / Esc while a save is in flight
    useFileTabUiStore.getState().clearPendingUnsavedClose();
  }

  function handleDontSave(): void {
    if (isSaving) return;
    // Identity check BEFORE the destructive discard: if the tab id has been
    // re-registered to a different file since this modal was requested, the
    // modal is stale — clear it without discarding or force-closing the
    // replacement file.
    if (!desktopFileSessionController.matches(pending.tabId, pending.fileKey)) {
      useFileTabUiStore.getState().clearPendingUnsavedClose();
      return;
    }
    // Discard the shared buffer and force-close so a reopen reads disk rather
    // than resurrecting the draft.
    desktopFileSessionController.discardTab(pending.tabId);
    useChatStore.getState().closeTab(pending.tabId, {
      force: true,
      projectId: pending.projectId,
      worktreeId: pending.worktreeId,
    });
    useFileTabUiStore.getState().clearPendingUnsavedClose();
  }

  async function handleSave(): Promise<void> {
    if (!desktopFileSessionController.matches(pending.tabId, pending.fileKey)) {
      // Stale modal: the tab id now hosts a different file. Never write the
      // replacement file's buffer on behalf of this request.
      useFileTabUiStore.getState().clearPendingUnsavedClose();
      return;
    }
    setIsSaving(true);
    try {
      const saved = await desktopFileSessionController.saveTab(pending.tabId);
      if (!saved) {
        if (
          desktopFileSessionController.matches(
            pending.tabId,
            pending.fileKey,
          ) &&
          useFileTabUiStore.getState().pendingUnsavedClose === pending &&
          desktopFileSessionController.getSession(pending.tabId)?.saveConflict
        ) {
          // Recovery lives in the shared viewer. Remove the blocking modal
          // without closing the dirty tab, then request focus on its choices.
          useFileTabUiStore.getState().clearPendingUnsavedClose();
          void desktopFileSessionController.saveTab(pending.tabId);
        }
        return;
      }
      // If the user kept typing into the (still-mounted) editor while the save
      // was in flight, the latest buffer is unsaved. Don't drop those edits —
      // leave the modal open so the user can Save again or Cancel/Don't Save.
      if (desktopFileSessionController.isDirty(pending.tabId)) return;
      // Identity check: confirm this modal is still bound to the same pending
      // request AND the tab is still registered to the same canonical key
      // before mutating store state.
      if (
        !desktopFileSessionController.matches(pending.tabId, pending.fileKey)
      ) {
        return;
      }
      const current = useFileTabUiStore.getState().pendingUnsavedClose;
      if (
        !current ||
        current.tabId !== pending.tabId ||
        current.fileKey !== pending.fileKey ||
        current.projectId !== pending.projectId ||
        current.worktreeId !== pending.worktreeId ||
        current.title !== pending.title ||
        current.filePath !== pending.filePath
      ) {
        return;
      }
      useChatStore.getState().closeTab(pending.tabId, {
        force: true,
        projectId: pending.projectId,
        worktreeId: pending.worktreeId,
      });
      useFileTabUiStore.getState().clearPendingUnsavedClose();
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <ConfirmDialog
      title={`Save changes to “${pending.title}”?`}
      message="Discarding loses the edits you haven’t saved."
      confirmLabel="Save changes"
      busyLabel="Saving…"
      busy={isSaving}
      errorMessage={error}
      onConfirm={() => {
        void handleSave();
      }}
      onCancel={handleDismiss}
      secondaryAction={{
        label: 'Discard',
        onSelect: handleDontSave,
        testId: 'file-tab-close-guard-discard',
      }}
      dataTestId="file-tab-close-guard"
      confirmTestId="file-tab-close-guard-save"
      cancelTestId="file-tab-close-guard-cancel"
    />
  );
}
