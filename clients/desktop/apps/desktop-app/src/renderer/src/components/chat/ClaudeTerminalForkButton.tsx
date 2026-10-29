import { useCallback, useRef, useState, type JSX } from 'react';
import { useChatStore } from '@/stores/chatStore';
import { reportRendererConsoleError } from '@/lib/renderer-error-logging';
import { ForkChatButton } from './ForkChatButton';

const SYNC_FAILURE_FORK_WARNING =
  'Transcript sync failed before fork. This fork is still usable, but it may be missing the latest Claude Code terminal output.';

export interface ClaudeTerminalForkButtonProps {
  projectId: string;
  worktreeId: string;
  chatId: string;
  sdkSessionId: string;
}

export function ClaudeTerminalForkButton({
  projectId,
  worktreeId,
  chatId,
  sdkSessionId,
}: ClaudeTerminalForkButtonProps): JSX.Element {
  const forkTab = useChatStore((s) => s.forkTab);
  const handleChatEvent = useChatStore((s) => s.handleChatEvent);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);

  const handleFork = useCallback((): void => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    void (async (): Promise<void> => {
      let syncWarning: string | undefined;
      try {
        const sync = await window.api.claudeTerminal.syncTranscript({
          projectId,
          worktreeId,
          chatId,
        });
        if (sync.errors?.length) {
          syncWarning = SYNC_FAILURE_FORK_WARNING;
          reportRendererConsoleError(
            'Claude terminal pre-fork transcript sync returned errors',
            { errors: sync.errors },
          );
        }
        if (sync.event) {
          handleChatEvent({
            projectId,
            worktreeId,
            chatId,
            data: sync.event,
          });
        }
      } catch (error) {
        syncWarning = SYNC_FAILURE_FORK_WARNING;
        reportRendererConsoleError(
          'Claude terminal pre-fork transcript sync failed',
          { error },
        );
      } finally {
        busyRef.current = false;
        setBusy(false);
        try {
          forkTab(
            chatId,
            { projectId, worktreeId },
            {
              includeActiveTurn: true,
              sourceSdkSessionId: sdkSessionId,
              ...(syncWarning ? { syncWarning } : {}),
            },
          );
        } catch (error) {
          reportRendererConsoleError('Claude terminal fork failed', { error });
        }
      }
    })();
  }, [chatId, forkTab, handleChatEvent, projectId, sdkSessionId, worktreeId]);

  return <ForkChatButton onClick={handleFork} disabled={busy} />;
}
