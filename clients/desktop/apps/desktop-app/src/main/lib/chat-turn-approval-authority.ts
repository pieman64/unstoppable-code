import {
  FAIL_CLOSED_APPROVAL_MODE,
  type ApprovalMode,
  type ApprovalRule,
  type ChatSendAdmittedApproval,
  type PersistedChatTab,
} from '@canopy/desktop-shared/types';
import {
  narrowApprovalMode,
  turnSessionApprovalRules,
} from '@canopy/desktop-shared/lib/send-approval-narrowing';
import { boundingApprovalMode } from '../approvals/live-approval-modes';
import {
  getApprovalSettingsRevision,
  getChatApprovalStateRevision,
} from '../approvals/rule-revisions';
import {
  ChatSendAdmissionRefusedError,
  chatSendAdmissionCheck,
} from '../services/chat-send-admission';
import { resolvePersistedApprovalMode } from './approval-mode-resolution';
import { readChatTabsFile } from './chat-tabs-reader';
import { logMainProcessWarn } from './main-process-logging';

export interface ChatTurnApprovalTarget {
  projectId: string;
  worktreeId: string;
  chatId: string;
  userMessageId: string;
  /** The send's own mode: it can only narrow the chat's. */
  approvalMode?: ApprovalMode;
  /** The send's own rules: only its deny rules apply. */
  sessionApprovalRules?: readonly ApprovalRule[];
  /** What an agent send was admitted against: a limit, never a grant. */
  admittedApproval?: ChatSendAdmittedApproval;
}

export interface ChatTurnApprovalAuthority {
  approvalMode: ApprovalMode;
  sessionApprovalRules: ApprovalRule[];
  /**
   * `approvalMode` without an admitted agent send's cap: what the chat itself
   * runs at, so the cap does not outlast this turn.
   */
  chatApprovalMode: ApprovalMode;
}

const MISSING_CHAT_REFUSAL = 'The chat for this message could not be found.';

/**
 * The approval mode and session rules a chat's turn starts with, read from the
 * chat's saved tab when the turn starts, so a change committed after the
 * message was sent or queued still applies to it. The send's own fields only
 * narrow that authority (see `send-approval-narrowing`), and so does what an
 * agent send was admitted against (`admittedApproval`), so a mode or session
 * grant the chat gained between admission and turn start does not reach it.
 * Known limits: a mode the user widens while the turn runs does reach it, and
 * project and global rules are read at each tool check, uncapped (CAN-4723).
 * A chat without a saved mode uses its workspace and surface defaults.
 * Without a saved tab the turn gets none of the send's grants, and without a
 * readable one it also starts at Ask. Unless `checkAdmission` is false, a send-admission check
 * registered for this message (`withChatSendAdmission`) is applied to the same
 * tab and stops the turn with `ChatSendAdmissionRefusedError` when it refuses.
 */
export async function resolveChatTurnApprovalAuthority(
  target: ChatTurnApprovalTarget,
  { checkAdmission = true }: { checkAdmission?: boolean } = {},
): Promise<ChatTurnApprovalAuthority> {
  let tab: PersistedChatTab | undefined;
  let readable = true;
  try {
    tab = (
      await readChatTabsFile(target.projectId, target.worktreeId, {
        chatIds: [target.chatId],
      })
    ).tabs.find((candidate) => candidate.id === target.chatId);
  } catch (error) {
    readable = false;
    logMainProcessWarn(
      `[chat-turn] Could not read the approval settings of ${target.projectId}/${target.worktreeId}/${target.chatId}; the turn starts without grants`,
      error,
    );
  }
  const check = checkAdmission ? chatSendAdmissionCheck(target) : undefined;
  if (check) {
    const refusal = tab ? check(tab) : MISSING_CHAT_REFUSAL;
    if (refusal !== undefined) throw new ChatSendAdmissionRefusedError(refusal);
  }
  const savedMode = readable
    ? await resolvePersistedApprovalMode(
        target.projectId,
        target.worktreeId,
        tab?.approvalMode,
      )
    : FAIL_CLOSED_APPROVAL_MODE;
  return chatTurnApprovalAuthorityFor(
    target,
    savedMode,
    tab?.sessionApprovalRules ?? [],
  );
}

/**
 * The authority a turn starts with, given the chat's saved mode (or its
 * default when it has none) and its session rules: narrowed by the send and
 * by what it was admitted against, and bounded by the chat's live and pending
 * mode. Synchronous, so a check right before a handoff can use it.
 */
export function chatTurnApprovalAuthorityFor(
  target: ChatTurnApprovalTarget,
  savedMode: ApprovalMode,
  savedRules: readonly ApprovalRule[],
): ChatTurnApprovalAuthority {
  const admitted = target.admittedApproval;
  const chatApprovalMode = boundingApprovalMode(
    target.projectId,
    target.worktreeId,
    target.chatId,
    narrowApprovalMode(savedMode, target.approvalMode),
  );
  return {
    approvalMode: narrowApprovalMode(chatApprovalMode, admitted?.approvalMode),
    chatApprovalMode,
    sessionApprovalRules: turnSessionApprovalRules(
      savedRules,
      target.sessionApprovalRules,
      admitted?.sessionApprovalRules,
    ),
  };
}

/**
 * What deciding a steer needs read ahead of its synchronous check: the
 * default of a chat without a saved mode, and the revisions it was read at.
 */
export interface SteeringApprovalRead {
  /** Undefined when the chat had a saved mode or the read failed. */
  defaultMode: ApprovalMode | undefined;
  settingsRevision: number;
  chatRevision: number;
}

/** Reads, before a steer, what `steeringTurnApproval` needs for `tab`. */
export async function readSteeringApproval(
  target: ChatTurnApprovalTarget,
  tab: Pick<PersistedChatTab, 'approvalMode'>,
): Promise<SteeringApprovalRead> {
  const settingsRevision = getApprovalSettingsRevision();
  const chatRevision = getChatApprovalStateRevision(target);
  let defaultMode: ApprovalMode | undefined;
  if (tab.approvalMode === undefined) {
    try {
      defaultMode = await resolvePersistedApprovalMode(
        target.projectId,
        target.worktreeId,
      );
    } catch (error) {
      logMainProcessWarn(
        `[chat-turn] Could not read the default approval mode of ${target.projectId}/${target.worktreeId}/${target.chatId}; the message is not steered`,
        error,
      );
    }
  }
  return { defaultMode, settingsRevision, chatRevision };
}

/**
 * The authority a message's own turn would start with against `tab`, computed
 * as `resolveChatTurnApprovalAuthority` does, for deciding whether it may
 * steer into a running session instead. Synchronous. Undefined, so the
 * message is not steered and its turn start decides, when an approval setting
 * or the chat's approval state changed since `read`, when the default it needs
 * was not read, or when the message's admission check refuses `tab`.
 */
export function steeringTurnApproval(
  target: ChatTurnApprovalTarget,
  tab: PersistedChatTab,
  read: SteeringApprovalRead,
): ChatTurnApprovalAuthority | undefined {
  if (
    getApprovalSettingsRevision() !== read.settingsRevision ||
    getChatApprovalStateRevision(target) !== read.chatRevision
  )
    return undefined;
  const savedMode = tab.approvalMode ?? read.defaultMode;
  if (savedMode === undefined) return undefined;
  try {
    if (chatSendAdmissionCheck(target)?.(tab) !== undefined) return undefined;
  } catch (error) {
    if (error instanceof ChatSendAdmissionRefusedError) return undefined;
    throw error;
  }
  return chatTurnApprovalAuthorityFor(
    target,
    savedMode,
    tab.sessionApprovalRules ?? [],
  );
}
