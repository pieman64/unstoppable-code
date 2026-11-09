import { memo, useCallback, type JSX } from 'react';
import { requestTerminalFocus } from '@/lib/terminal-focus-intent';
import { useChatStore } from '@/stores/chatStore';
import { ToolApprovalDock } from './ToolApprovalDock';

export interface ClaudeTerminalApprovalDockProps {
  projectId: string;
  worktreeId: string;
  chatId: string;
  /** The live managed terminal, which takes focus back after an approval. */
  terminalId: string | undefined;
  ownerDocument: Document | undefined;
}

/**
 * The chat's approval card under the managed Claude Code terminal. The
 * composer that carries it in the Canopy view is hidden while the terminal
 * shows, and the mode toggle is locked during a turn, so without this a
 * terminal turn waits on an approval nothing on screen can answer (CAN-5968).
 */
export const ClaudeTerminalApprovalDock = memo(
  function ClaudeTerminalApprovalDock({
    projectId,
    worktreeId,
    chatId,
    terminalId,
    ownerDocument,
  }: ClaudeTerminalApprovalDockProps): JSX.Element {
    const hasPendingApproval = useChatStore((s) =>
      Object.values(s.pendingApprovals).some(
        (p) =>
          p.projectId === projectId &&
          p.worktreeId === worktreeId &&
          p.chatId === chatId,
      ),
    );
    // A card never takes focus on arrival, so keystrokes keep reaching the
    // CLI; answering the last card that held focus returns it to the terminal.
    const focusTerminal = useCallback((): void => {
      if (terminalId) requestTerminalFocus(terminalId, ownerDocument);
    }, [terminalId, ownerDocument]);
    return (
      // Mounted while empty so the first arrival is announced; padded only
      // while a card shows, so an idle terminal keeps its full height.
      <div
        className={`mx-auto w-full max-w-[var(--chat-composer-shell-width)] shrink-0 px-4${hasPendingApproval ? ' pt-2' : ''}`}
      >
        <ToolApprovalDock
          projectId={projectId}
          worktreeId={worktreeId}
          chatId={chatId}
          focusComposer={focusTerminal}
        />
      </div>
    );
  },
);
