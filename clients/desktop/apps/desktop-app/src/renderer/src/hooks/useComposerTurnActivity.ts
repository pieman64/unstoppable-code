import { useCallback, useEffect, useRef, useState } from 'react';
import {
  useChatTabRenderState,
  type ChatRenderTarget,
  type ChatTab,
} from '@/stores/chatStore';
import {
  composerTurnActivity,
  type ComposerTurnActivity,
} from '@/stores/chat/turn-activity';
import {
  confirmCanonicalTurn,
  type CanonicalTurnConfirmation,
} from '@/stores/chat/turn-confirmation';

export interface ComposerTurnActivityState {
  /** What the composer shows: canonical runtime plus a pending send. */
  activity: ComposerTurnActivity;
  /** An awaited read of this chat's canonical runtime from main. */
  confirmTurn: () => Promise<CanonicalTurnConfirmation>;
  /**
   * True only when a fresh read finds the chat running the turn the renderer
   * shows as active (any active turn when the renderer knows none). A failed
   * or unknown read answers false.
   */
  confirmStuckTurn: () => Promise<boolean>;
}

const UNKNOWN_TURN: CanonicalTurnConfirmation = { state: 'unknown' };

/**
 * The composer's turn activity for one chat. Canonical runtime decides; a
 * pending sending lease counts until its deadline, and the hook re-renders
 * at that deadline. `status` is the tab's own status, used only when the
 * chat has no canonical runtime entry.
 */
export function useComposerTurnActivity(
  target: ChatRenderTarget | null,
  status: ChatTab['status'] | undefined,
): ComposerTurnActivityState {
  const sendingLease = useChatTabRenderState(
    target,
    (entry) => entry.tab?.sendingLease,
  );
  const runtime = useChatTabRenderState(target, (entry) => entry.runtime);

  // Advanced only at a pending lease's deadline, so a lease issued later is
  // always compared against an earlier time and reads as sending.
  const [now, setNow] = useState(() => Date.now());
  const leaseDeadline =
    sendingLease?.state === 'pending' ? sendingLease.deadline : undefined;
  useEffect(() => {
    if (leaseDeadline === undefined) return;
    const timer = window.setTimeout(
      () => setNow(Date.now()),
      Math.max(0, leaseDeadline - Date.now()),
    );
    return (): void => window.clearTimeout(timer);
  }, [leaseDeadline]);

  const activity = composerTurnActivity(
    { status: status ?? 'idle', sendingLease },
    runtime,
    now,
  );

  const activeTurnIdRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    activeTurnIdRef.current = runtime?.activeTurn?.userMessageId;
  }, [runtime]);

  const projectId = target?.projectId;
  const worktreeId = target?.worktreeId;
  const chatId = target?.chatId;
  const confirmTurn = useCallback(
    (): Promise<CanonicalTurnConfirmation> =>
      projectId && worktreeId && chatId
        ? confirmCanonicalTurn({ projectId, worktreeId, chatId })
        : Promise.resolve(UNKNOWN_TURN),
    [chatId, projectId, worktreeId],
  );
  const confirmStuckTurn = useCallback(async (): Promise<boolean> => {
    const shownTurnId = activeTurnIdRef.current;
    try {
      const confirmation = await confirmTurn();
      return (
        confirmation.state === 'active' &&
        (shownTurnId === undefined ||
          confirmation.userMessageId === undefined ||
          confirmation.userMessageId === shownTurnId)
      );
    } catch {
      return false;
    }
  }, [confirmTurn]);

  return { activity, confirmTurn, confirmStuckTurn };
}
