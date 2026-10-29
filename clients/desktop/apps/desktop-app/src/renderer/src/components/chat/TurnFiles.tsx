import { memo, useEffect, useRef, useState, type JSX } from 'react';
import type { ShowFilesWorkspaceTarget } from '@canopy/desktop-shared/types';
import { APP_ADVISOR_PROJECT_ID } from '@canopy/desktop-shared/types';
import { FileIcon } from '@canopy/ui-shared/icons';
import { showFilesInRenderer } from '@/lib/show-files';
import { onTurnFileViewerClosed } from '@/lib/turn-file-viewer';
import { detectChatStoreSurface } from '@/stores/chat/surface';

export interface TurnFileChipProps {
  /** Transcript path; the host resolves and authorizes it when opening. */
  path: string;
  /** Explicit workspace selected by an App Advisor ShowFiles call. */
  target?: ShowFilesWorkspaceTarget;
  /** Creation still in flight: shown, not openable. */
  pending?: boolean;
  projectId: string;
  worktreeId: string;
  chatId: string;
}

const OPEN_FAILED = 'Unable to open this file. Try again.';

/**
 * Compact chip for a file the turn created or presented. Sits beside the
 * changed-file cards in the turn summary and opens the file in the existing
 * viewer beside the chat; an App Advisor chip opens it in the main window.
 */
export const TurnFileChip = memo(function TurnFileChip({
  path,
  target: explicitTarget,
  pending = false,
  projectId,
  worktreeId,
  chatId,
}: TurnFileChipProps): JSX.Element {
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState<string>();
  const openingRef = useRef(false);
  const focusReturnIdRef = useRef<string | undefined>(undefined);
  const browserIdRef = useRef<string | undefined>(undefined);
  const focusCleanup = useRef<(() => void) | undefined>(undefined);
  useEffect(() => (): void => focusCleanup.current?.(), []);
  const filename = path.split(/[\\/]/).pop() ?? path;

  const open = async (): Promise<void> => {
    if (openingRef.current) return;
    openingRef.current = true;
    setOpening(true);
    setError(undefined);
    const origin = document.activeElement;
    try {
      const target = explicitTarget ?? { projectId, worktreeId };
      const chatOrigin = { projectId, worktreeId, chatTabId: chatId };
      const surface = detectChatStoreSurface();
      const opensInMainWindow =
        surface === 'app-advisor' &&
        target.projectId !== APP_ADVISOR_PROJECT_ID;
      focusCleanup.current?.();
      focusCleanup.current = undefined;
      if (opensInMainWindow) {
        const focusReturnId = focusReturnIdRef.current ?? crypto.randomUUID();
        focusReturnIdRef.current = focusReturnId;
        focusCleanup.current = window.api.appAdvisor.onTurnFileClosed(
          (closedId) => {
            if (
              closedId !== focusReturnId ||
              !(origin instanceof HTMLElement) ||
              !origin.isConnected
            )
              return;
            focusCleanup.current?.();
            focusCleanup.current = undefined;
            void window.api.appAdvisor
              .openWindow({ focus: true })
              .then(() => {
                if (origin.isConnected) origin.focus({ preventScroll: true });
              })
              .catch(() => {
                if (origin.isConnected) origin.focus({ preventScroll: true });
              });
          },
        );
      }
      const result = opensInMainWindow
        ? await window.api.appAdvisor.openTurnFile({
            path,
            focusReturnId: focusReturnIdRef.current,
            target,
            origin: chatOrigin,
            ...(browserIdRef.current
              ? { reuseBrowserId: browserIdRef.current }
              : {}),
          })
        : await showFilesInRenderer(
            {
              // A tile click is the user's own open: never backgrounded or
              // deferred by an agent presentation policy (CAN-4663).
              intent: 'user',
              target,
              origin: chatOrigin,
              files: [{ path }],
            },
            surface,
            { reuseBrowserId: browserIdRef.current },
          );
      const opened = result.files[0];
      browserIdRef.current = opened?.browserId;
      if (!opened?.ok) {
        focusCleanup.current?.();
        focusCleanup.current = undefined;
        setError(opened?.error ?? OPEN_FAILED);
      }
      if (opensInMainWindow) return;
      // The file viewer owns closing. Restore the initiating chip's focus
      // when its tab is removed, without scrolling the transcript.
      focusCleanup.current?.();
      const restoreFocus = (): void => {
        focusCleanup.current?.();
        focusCleanup.current = undefined;
        if (origin instanceof HTMLElement && origin.isConnected)
          origin.focus({ preventScroll: true });
      };
      focusCleanup.current = onTurnFileViewerClosed(
        target,
        opened,
        restoreFocus,
      );
    } catch (cause) {
      focusCleanup.current?.();
      focusCleanup.current = undefined;
      setError(cause instanceof Error ? cause.message : OPEN_FAILED);
    } finally {
      openingRef.current = false;
      setOpening(false);
    }
  };

  const busy = opening || pending;
  const status = error ?? (opening ? 'Opening…' : pending ? 'Creating…' : '');
  return (
    <button
      type="button"
      data-testid="turn-file-chip"
      onClick={
        busy
          ? undefined
          : (): void => {
              void open();
            }
      }
      aria-label={pending ? `Creating ${filename}` : `Open ${filename}`}
      aria-busy={busy}
      aria-disabled={busy}
      title={path}
      className="focus-ring min-w-0 max-w-full cursor-pointer rounded-md border bg-fg-primary/[0.02] px-2 py-1.5 text-left text-xs transition hover:bg-fg-primary/[0.04] aria-disabled:cursor-default"
    >
      <span className="flex items-center gap-1.5">
        <span className="flex h-3 w-3 shrink-0 items-center justify-center fg-secondary">
          <FileIcon width={12} height={12} aria-hidden="true" />
        </span>
        <span className="min-w-0 flex-1 truncate fg-primary">{filename}</span>
      </span>
      {status && (
        <span className="mt-1 block truncate text-3xs fg-secondary">
          {status}
        </span>
      )}
    </button>
  );
});
