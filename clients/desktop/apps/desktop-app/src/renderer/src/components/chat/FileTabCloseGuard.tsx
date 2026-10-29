import { useState, type JSX } from 'react';
import { DialogModal } from '@/components/shared';
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
      if (!saved) return; // keep modal open; the shared error is already shown
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
    <DialogModal
      onClose={handleDismiss}
      title={`Save changes to ${pending.title}?`}
      maxWidth="md"
      closeOnBackdrop={!isSaving}
      dataTestId="file-tab-close-guard"
    >
      <div className="space-y-4 px-5 pb-5 pt-2">
        <p className="text-s fg-secondary">
          Your changes will be lost if you close this tab without saving.
        </p>
        {error && (
          <p
            className="text-s fg-destructive"
            data-testid="file-tab-close-guard-error"
          >
            {error}
          </p>
        )}
        <div className="flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={handleDismiss}
            disabled={isSaving}
            data-testid="file-tab-close-guard-cancel"
            className="rounded-md border bg-base px-3 py-1.5 text-s fg-primary transition hover:bg-accent-subtle disabled:cursor-default disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleDontSave}
            disabled={isSaving}
            data-testid="file-tab-close-guard-discard"
            className="rounded-md border bg-secondary px-3 py-1.5 text-s fg-primary transition hover:bg-accent-subtle disabled:cursor-default disabled:opacity-50"
          >
            Don&apos;t save
          </button>
          <button
            type="button"
            onClick={() => {
              void handleSave();
            }}
            disabled={isSaving}
            data-testid="file-tab-close-guard-save"
            className="rounded-md bg-accent px-3 py-1.5 text-s font-medium fg-emphasis transition hover:bg-accent/90 disabled:cursor-default disabled:opacity-50"
          >
            {isSaving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </DialogModal>
  );
}
