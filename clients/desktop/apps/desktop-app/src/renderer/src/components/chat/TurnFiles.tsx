import { memo, useEffect, useRef, useState, type JSX } from 'react';
import type { ShowFilesWorkspaceTarget } from '@canopy/desktop-shared/types';
import { APP_ADVISOR_PROJECT_ID } from '@canopy/desktop-shared/types';
import {
  restoreTurnFileFocus,
  TurnFileChipView,
} from '@canopy/ui-shared/components';
import {
  isLocalFileActionAvailable,
  REVEAL_FILE_FAILED,
  resolveLocalFileActionRequest,
} from '@/lib/file-reveal';
import { pt } from '@/lib/platform-text';
import { uiText } from '@/lib/ui-text';
import { useWorkspaceIsReadOnly } from '@/lib/workspace-access';
import { useProjectsStore } from '@/stores/projectsStore';
import { showFilesInRenderer } from '@/lib/show-files';
import { onTurnFileViewerClosed } from '@/lib/turn-file-viewer';
import { detectChatStoreSurface } from '@/stores/chat/surface';
import { useChatStore } from '@/stores/chatStore';

export interface TurnFileChipProps {
  /** Transcript path; the host resolves and authorizes it when opening. */
  path: string;
  /**
   * Normalized absolute path of a completed file, used to reveal it in the
   * platform file manager. Absent for pending entries.
   */
  absolutePath?: string;
  /** Explicit workspace selected by an App Advisor ShowFiles call. */
  target?: ShowFilesWorkspaceTarget;
  /** Edit of an existing file; omitted for saved files. */
  change?: 'updated';
  presentation?: 'row' | 'summary';
  /** Change still in flight: shown, not openable. */
  pending?: boolean;
  /** The pending change waits for approval rather than running. */
  waiting?: boolean;
  projectId: string;
  worktreeId: string;
  chatId: string;
}

const OPEN_FAILED = 'Unable to open this file. Try again.';
const UNNAMED_LOCATION = 'project folder';

/**
 * Compact chip for a file the turn created, updated or presented. Sits beside the
 * changed-file cards in the turn summary and opens the file in the existing
 * viewer beside the chat; an App Advisor chip opens it in the main window.
 */
export const TurnFileChip = memo(function TurnFileChip({
  path,
  absolutePath,
  target: explicitTarget,
  change,
  presentation = 'row',
  pending = false,
  waiting = false,
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
  const chatReadOnly = useWorkspaceIsReadOnly();
  // Each chip names its own owning project, so a chip that targets another
  // workspace never borrows the current chat's project name.
  const ownerProjectId = explicitTarget?.projectId ?? projectId;
  const ownerProjectName = useProjectsStore(
    (state) =>
      state.projects.find((project) => project.id === ownerProjectId)?.name,
  );
  const location = `${change === 'updated' ? 'Updated' : 'Saved'} in ${
    ownerProjectName ?? UNNAMED_LOCATION
  }`;
  const revealRequest =
    pending || !isLocalFileActionAvailable('showInFinder')
      ? undefined
      : resolveLocalFileActionRequest({
          absolutePath,
          target: explicitTarget,
          surfaceScope: { projectId, worktreeId },
          surfaceReadOnly: chatReadOnly,
        });

  const reveal = (): void => {
    if (!revealRequest) return;
    setError(undefined);
    window.api.showInFinder(revealRequest).catch(() => {
      setError(REVEAL_FILE_FAILED);
    });
  };

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
                restoreTurnFileFocus(origin);
              })
              .catch(() => {
                restoreTurnFileFocus(origin);
              });
          },
        );
      }
      if (!opensInMainWindow && absolutePath) {
        const key = `${target.projectId}/${target.worktreeId}`;
        const isClosing = (): boolean => {
          const state = useChatStore.getState();
          return (
            state.worktreeChats[key]?.tabs.some(
              (tab) =>
                tab.kind === 'file' &&
                tab.filePath === absolutePath &&
                state.closingChatTabs[key]?.has(tab.id),
            ) ?? false
          );
        };
        // The panel disappears optimistically before its tab close commits.
        // Opening that same tab during the gap would reuse a closing identity.
        if (isClosing())
          await new Promise<void>((resolve) => {
            const unsubscribe = useChatStore.subscribe(() => {
              if (isClosing()) return;
              unsubscribe();
              resolve();
            });
          });
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
        if (origin instanceof HTMLElement) restoreTurnFileFocus(origin);
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

  // A pending chip says its own status ("Creating…", "Waiting for approval").
  const status = error ?? (opening ? 'Opening…' : '');
  return (
    <TurnFileChipView
      filename={filename}
      presentation={presentation}
      {...(change ? { change } : {})}
      pending={pending}
      waiting={waiting}
      opening={opening}
      status={status}
      location={location}
      onOpen={(): void => {
        void open();
      }}
      {...(revealRequest
        ? {
            reveal: {
              label: pt(uiText.fileManager.showNamedItem)(filename),
              tooltip: pt(uiText.fileManager.showItem),
              actionLabel: pt(uiText.fileManager.openItem),
              onReveal: reveal,
            },
          }
        : {})}
    />
  );
});
