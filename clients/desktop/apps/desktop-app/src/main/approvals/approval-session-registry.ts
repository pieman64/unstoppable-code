import type { ApprovalCheck, ApprovalMode } from '@canopy/desktop-shared/types';
import type { ApprovalCheckDisplay, ApprovalOutcome } from './approval-service';

const NO_PROMPT_MESSAGE =
  'This chat has no approval prompt available, so the request was denied.';

/**
 * Registry of live approval handles, keyed by chat identity (CAN-3083).
 *
 * A chat can legitimately own more than one handle at a time — an agent
 * session and a `claude-terminal-session-service` session, for instance — so
 * the value is a set and a broadcast fans out to all of them.
 *
 * This registry, rather than `ApprovalSessionHandle.setMode`, is the trigger
 * point for re-evaluating standing prompts. `setMode` is a bookkeeping setter
 * with several callers that re-apply the current mode at turn start, and two
 * of its callers *roll the mode back* when applying it to the provider fails —
 * i.e. they conclude the escalation did not take effect. Auto-approving inside
 * the setter would have granted authority the system then decided it could not
 * grant, after the tool had already run. Enrolment here keeps the setter inert
 * and lets the one deliberate authorization site in `ipc/chat.ts` dispatch,
 * while still covering every current and future `createApprovalSession` caller
 * with zero adapter changes.
 */
export interface RegisteredApprovalSession {
  /**
   * `previousMode` is the mode the chat was in *before* this widening. It has
   * to travel with the broadcast because the handle cannot recover it: the
   * dispatcher applies the new mode to every runtime owner — which includes
   * calling `setMode` on this very handle — before it broadcasts, so the
   * handle's own mode is already the widened one by the time it is asked.
   */
  reevaluatePendingApprovals(
    mode: ApprovalMode,
    previousMode?: ApprovalMode,
  ): Promise<void>;
  /** `ApprovalSessionHandle.check`: evaluates, and prompts in the chat when asked to. */
  check(
    check: ApprovalCheck,
    display: ApprovalCheckDisplay,
  ): Promise<ApprovalOutcome>;
}

function chatKey(
  projectId: string,
  worktreeId: string,
  chatId: string,
): string {
  return `${projectId}:${worktreeId}:${chatId}`;
}

const sessionsByChat = new Map<string, Set<RegisteredApprovalSession>>();

export function registerApprovalSession(
  projectId: string,
  worktreeId: string,
  chatId: string,
  session: RegisteredApprovalSession,
): () => void {
  const key = chatKey(projectId, worktreeId, chatId);
  const existing = sessionsByChat.get(key);
  const sessions = existing ?? new Set<RegisteredApprovalSession>();
  if (!existing) {
    sessionsByChat.set(key, sessions);
  }
  sessions.add(session);
  return () => {
    const current = sessionsByChat.get(key);
    if (!current) return;
    current.delete(session);
    if (current.size === 0) {
      sessionsByChat.delete(key);
    }
  };
}

/**
 * Asks every live handle for this chat to re-run its standing prompt(s) under
 * `mode`. One handle throwing must not stop the others, so the fan-out is
 * `allSettled` and this never rejects.
 */
export async function reevaluatePendingApprovalsForChat(
  projectId: string,
  worktreeId: string,
  chatId: string,
  mode: ApprovalMode,
  previousMode?: ApprovalMode,
): Promise<void> {
  const sessions = sessionsByChat.get(chatKey(projectId, worktreeId, chatId));
  if (!sessions || sessions.size === 0) {
    return;
  }
  await Promise.allSettled(
    Array.from(sessions).map((session) =>
      session.reevaluatePendingApprovals(mode, previousMode),
    ),
  );
}

/**
 * Raises an approval check from code that runs outside a provider's tool
 * interception, such as a Canopy action, through the chat's own approval
 * session, so it follows that chat's mode, rules, and prompt dock. The newest
 * live handle answers. No handle, or a handle that fails, denies: the
 * subsystem fails closed. Never rejects.
 */
export async function requestChatApproval(
  projectId: string,
  worktreeId: string,
  chatId: string,
  check: ApprovalCheck,
  display: ApprovalCheckDisplay,
): Promise<ApprovalOutcome> {
  const sessions = sessionsByChat.get(chatKey(projectId, worktreeId, chatId));
  const live = sessions ? Array.from(sessions) : [];
  const newest = live[live.length - 1];
  if (!newest) return { decision: 'deny', message: NO_PROMPT_MESSAGE };
  try {
    return await newest.check(check, display);
  } catch {
    return { decision: 'deny', message: NO_PROMPT_MESSAGE };
  }
}

/** Test-only: drops every enrolment so suites do not leak handles into each other. */
export function resetApprovalSessionRegistryForTests(): void {
  sessionsByChat.clear();
}
