import type { PersistedChatTab } from '@canopy/desktop-shared/types';
import type { TerminalDrivenChatTab } from '../lib/terminal-driven-chat';

/** The canonical settings of the chat a send is admitted into. */
export type ChatSendAdmissionTab = TerminalDrivenChatTab &
  Pick<
    PersistedChatTab,
    'approvalMode' | 'sessionApprovalRules' | 'selectedRepoId'
  >;

/**
 * Decides, synchronously and against the canonical tab in the step that
 * commits the message, whether a send may be admitted. Returns the refusal,
 * or undefined to admit.
 */
export type ChatSendAdmissionCheck = (
  tab: ChatSendAdmissionTab,
) => string | undefined;

export interface ChatSendAdmissionTarget {
  projectId: string;
  worktreeId: string;
  chatId: string;
  userMessageId: string;
}

const checks = new Map<string, ChatSendAdmissionCheck>();

function admissionKey(target: ChatSendAdmissionTarget): string {
  return [
    target.projectId,
    target.worktreeId,
    target.chatId,
    target.userMessageId,
  ].join('\u0000');
}

/**
 * Runs `send` with `check` guarding the admission of this one message: the
 * chat state owner applies it in the same synchronous step that commits the
 * message, so nothing it checked can change before the turn is admitted.
 */
export async function withChatSendAdmission<T>(
  target: ChatSendAdmissionTarget,
  check: ChatSendAdmissionCheck,
  send: () => Promise<T>,
): Promise<T> {
  const key = admissionKey(target);
  checks.set(key, check);
  try {
    return await send();
  } finally {
    if (checks.get(key) === check) checks.delete(key);
  }
}

/** The admission check a send of this message must pass, if any. */
export function chatSendAdmissionCheck(
  target: ChatSendAdmissionTarget,
): ChatSendAdmissionCheck | undefined {
  return checks.get(admissionKey(target));
}
