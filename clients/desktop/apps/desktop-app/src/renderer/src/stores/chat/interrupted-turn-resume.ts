import { create } from 'zustand';
import type { CanopyCapabilities } from '@canopy/app-core';
import {
  APP_ADVISOR_PROJECT_ID,
  CODE_REVIEW_CHAT_PROJECT_ID,
  PIPELINE_EDITOR_PROJECT_ID,
  PLAN_EXPLORE_CHAT_PROJECT_ID,
  type UsageLimitedChatTarget,
  type UsageLimitedChatItem,
} from '@canopy/desktop-shared/types';
import { describeUsageLimitResumePromptKind } from '@canopy/desktop-shared/lib/usage-limit-resume-prompt';
import { latestRootUserMessageId } from './latest-root-user-message';
import { getEffectiveClaudeChatInterfaceMode } from '@/lib/claude-tui-chats';
import { chatStoreApi } from './store-ref';
import {
  selectVisibleUsageLimitBanner,
  useAiCreditsBannerStore,
} from '../aiCreditsBannerStore';
import { clearResumedChatUsageLimitBanner } from './tab-utils';
import type { ChatTab } from './types';

/**
 * In-chat resume for a turn cut off when the app closed (CAN-5177).
 *
 * Main owns the interruption (`interruptedTurns`) and the resume itself
 * (`resumeUsageLimitedChats` builds the trusted prompt, claims the chat, and
 * cleans up the Home registry). The renderer only decides whether to offer
 * Resume and keeps three facts for this session: the user dismissed the offer,
 * a request is in flight or was accepted, or the last attempt failed. Each is
 * keyed by the full chat target and the interruption, never the active tab.
 */

export type InterruptedTurnResumePromptKind = NonNullable<
  UsageLimitedChatItem['resumePromptKind']
>;

export interface InterruptedTurnResumeOffer {
  /** User-message id of the interrupted turn; the `interruptedTurns` key. */
  userMessageId: string;
  /** What Resume sends; absent when the history cannot tell. */
  promptKind?: InterruptedTurnResumePromptKind;
}

/**
 * The open interruption the composer may offer to resume, or `undefined`.
 *
 * Only the latest turn qualifies: an older entry, even one still open, would
 * resume work the chat has moved past. The chat must be idle with nothing
 * pending or queued, its history loaded, and not running in a terminal.
 */
export function presentableInterruptedTurnResume(
  tab: Pick<
    ChatTab,
    | 'status'
    | 'messages'
    | 'interruptedTurns'
    | 'pendingTurn'
    | 'pendingUserMessages'
    | 'queuedMessages'
    | 'editingQueuedMessageIndex'
    | 'interfaceMode'
    | 'transcriptLoaded'
    | 'transcriptStale'
    | 'transcriptWindow'
    | 'kind'
    | 'readOnly'
  >,
): InterruptedTurnResumeOffer | undefined {
  if (!tab.interruptedTurns) return undefined;
  if (tab.transcriptLoaded === false || tab.transcriptStale) return undefined;
  if (tab.kind === 'file' || tab.readOnly) return undefined;
  if (getEffectiveClaudeChatInterfaceMode(tab.interfaceMode) !== 'canopy') {
    return undefined;
  }
  if (tab.status !== 'idle') return undefined;
  if (tab.pendingTurn || (tab.pendingUserMessages?.length ?? 0) > 0) {
    return undefined;
  }
  if (tab.queuedMessages.length > 0) return undefined;
  if (tab.editingQueuedMessageIndex !== undefined) return undefined;
  // Main keys the interruption by the root turn and resumes only the latest
  // root user turn, so subagent prompts and tool-result carriers after it
  // must not hide the offer.
  const userMessageId = latestRootUserMessageId(tab.messages);
  if (userMessageId === undefined) return undefined;
  const interruption = Object.prototype.hasOwnProperty.call(
    tab.interruptedTurns,
    userMessageId,
  )
    ? tab.interruptedTurns[userMessageId]
    : undefined;
  if (!interruption) return undefined;
  if (interruption.resumedBy !== undefined || interruption.abandoned) {
    return undefined;
  }
  // `before` marks an interior transcript gap. `complete` describes the
  // turn outcome, not loaded history; an unfinished turn can be fully loaded.
  if (
    tab.transcriptWindow?.turns?.some(
      (turn) => turn.id === userMessageId && turn.before !== undefined,
    )
  )
    return undefined;
  // The same root-chain history main builds the trusted prompt from.
  const promptKind = describeUsageLimitResumePromptKind(
    tab.messages.filter(
      (message) => !message.parentBlockId && !message.parentToolUseId,
    ),
  );
  return promptKind ? { userMessageId, promptKind } : undefined;
}

// Built-in chats outside the workspace index, which the resume cannot reach.
const UNSUPPORTED_PROJECT_IDS: ReadonlySet<string> = new Set([
  APP_ADVISOR_PROJECT_ID,
  CODE_REVIEW_CHAT_PROJECT_ID,
  PIPELINE_EDITOR_PROJECT_ID,
  PLAN_EXPLORE_CHAT_PROJECT_ID,
]);

/**
 * Whether this host can resume an interrupted turn for this chat in place.
 * Default-deny: an unset capability means no offer and no dispatch.
 */
export function supportsInterruptedTurnResume(
  capabilities: Pick<CanopyCapabilities, 'chatWorkflows'>,
  target: UsageLimitedChatTarget,
): boolean {
  return (
    capabilities.chatWorkflows?.interruptedTurnResume === true &&
    !UNSUPPORTED_PROJECT_IDS.has(target.projectId)
  );
}

/**
 * Whether the composer shows the offer. A visible usage-limit banner already
 * carries Resume, so it wins; a dismissed or accepted offer stays hidden.
 */
export function shouldShowInterruptedTurnResume(input: {
  capabilities: Pick<CanopyCapabilities, 'chatWorkflows'>;
  target: UsageLimitedChatTarget | null;
  userMessageId: string | undefined;
  session: InterruptedTurnResumeSession | undefined;
  usageLimitBannerVisible: boolean;
}): boolean {
  if (input.target === null || input.userMessageId === undefined) return false;
  if (!supportsInterruptedTurnResume(input.capabilities, input.target)) {
    return false;
  }
  if (input.usageLimitBannerVisible) return false;
  return !input.session?.dismissed && input.session?.phase !== 'accepted';
}

/** Choose the fallback without exposing a second resume for an accepted turn. */
export function shouldShowStoppedTurnResume(input: {
  stoppedUserMessageId: string | undefined;
  interruptedUserMessageId: string | undefined;
  interruptedSession: InterruptedTurnResumeSession | undefined;
  interruptedNoticeVisible: boolean;
  usageLimitBannerVisible: boolean;
}): boolean {
  return (
    input.stoppedUserMessageId !== undefined &&
    !input.usageLimitBannerVisible &&
    !input.interruptedNoticeVisible &&
    !(
      input.interruptedSession?.phase === 'accepted' &&
      input.interruptedUserMessageId === input.stoppedUserMessageId
    )
  );
}

/** Fallback copy; main's resume reports failed targets without a reason. */
export const INTERRUPTED_TURN_RESUME_FAILED_MESSAGE =
  'Could not resume this chat. Try again.';

export interface InterruptedTurnResumeSession {
  /** Hidden for the rest of this renderer session; Home is unaffected. */
  dismissed?: true;
  /**
   * `resuming` while the request is in flight; `accepted` once main took it,
   * which keeps Resume hidden until canonical state resolves the turn.
   */
  phase?: 'resuming' | 'accepted';
  error?: string;
}

interface InterruptedTurnResumeStoreState {
  sessions: Readonly<Record<string, InterruptedTurnResumeSession>>;
}

/** Renderer-session state only: never persisted, reset by a restart. */
export const useInterruptedTurnResumeStore =
  create<InterruptedTurnResumeStoreState>(() => ({ sessions: {} }));

export function interruptedTurnResumeKey(
  target: UsageLimitedChatTarget,
  userMessageId: string,
): string {
  return JSON.stringify([
    target.projectId,
    target.worktreeId,
    target.chatId,
    userMessageId,
  ]);
}

const sessionTargets = new Map<
  string,
  {
    target: UsageLimitedChatTarget;
    userMessageId: string;
  }
>();
// A claim outlives canonical retirement of its interruption. A new interruption
// in this chat must wait for that request to settle too.
const inFlightChats = new Set<string>();

/** Retire only obsolete interruption state, retaining dismissal while busy. */
export function reconcileInterruptedTurnResumeSessions(): void {
  if (sessionTargets.size === 0) return;
  const sessions = useInterruptedTurnResumeStore.getState().sessions;
  const next = { ...sessions };
  let changed = false;
  for (const [key, { target, userMessageId }] of Array.from(sessionTargets)) {
    const tab = currentTab(target);
    const interruption =
      tab?.interruptedTurns &&
      Object.prototype.hasOwnProperty.call(tab.interruptedTurns, userMessageId)
        ? tab.interruptedTurns[userMessageId]
        : undefined;
    if (
      tab &&
      interruption &&
      interruption.resumedBy === undefined &&
      !interruption.abandoned &&
      (tab.transcriptLoaded === false ||
        latestRootUserMessageId(tab.messages) === userMessageId)
    )
      continue;
    delete next[key];
    sessionTargets.delete(key);
    changed = true;
  }
  if (changed) useInterruptedTurnResumeStore.setState({ sessions: next });
}

function updateSession(
  key: string,
  update: (
    current: InterruptedTurnResumeSession,
  ) => InterruptedTurnResumeSession,
): void {
  useInterruptedTurnResumeStore.setState((state) => ({
    sessions: { ...state.sessions, [key]: update(state.sessions[key] ?? {}) },
  }));
}

function currentTab(target: UsageLimitedChatTarget): ChatTab | undefined {
  return chatStoreApi()
    .getState()
    .worktreeChats[`${target.projectId}/${target.worktreeId}`]?.tabs.find(
      (candidate) => candidate.id === target.chatId,
    );
}

function currentOffer(
  target: UsageLimitedChatTarget,
): InterruptedTurnResumeOffer | undefined {
  const tab = currentTab(target);
  return tab ? presentableInterruptedTurnResume(tab) : undefined;
}

export function dismissInterruptedTurnResume(
  target: UsageLimitedChatTarget,
  userMessageId: string,
): void {
  const key = interruptedTurnResumeKey(target, userMessageId);
  const session = useInterruptedTurnResumeStore.getState().sessions[key];
  if (session?.phase !== undefined) return;
  if (currentOffer(target)?.userMessageId !== userMessageId) return;
  sessionTargets.set(key, { target, userMessageId });
  updateSession(key, () => ({ dismissed: true }));
}

/**
 * Resumes exactly the interruption the user saw. Refuses when that turn is no
 * longer the chat's open interruption, or when a request for it is already in
 * flight or accepted. The result applies only to its own key, so switching
 * chats or a newer interruption never picks up a late reply.
 */
export async function resumeInterruptedTurn(
  target: UsageLimitedChatTarget,
  userMessageId: string,
  capabilities: Pick<CanopyCapabilities, 'chatWorkflows'>,
): Promise<void> {
  if (!supportsInterruptedTurnResume(capabilities, target)) return;
  const key = interruptedTurnResumeKey(target, userMessageId);
  const session = useInterruptedTurnResumeStore.getState().sessions[key];
  if (session?.phase !== undefined || session?.dismissed) return;
  if (currentOffer(target)?.userMessageId !== userMessageId) return;
  if (
    selectVisibleUsageLimitBanner(
      useAiCreditsBannerStore.getState(),
      target,
    ) !== null
  )
    return;
  const chatKey = JSON.stringify([
    target.projectId,
    target.worktreeId,
    target.chatId,
  ]);
  if (inFlightChats.has(chatKey)) return;
  inFlightChats.add(chatKey);
  sessionTargets.set(key, { target, userMessageId });
  const requestSession: InterruptedTurnResumeSession = { phase: 'resuming' };
  updateSession(key, () => requestSession);
  let accepted = false;
  try {
    const response = await window.api.resumeUsageLimitedChats({
      targets: [
        {
          projectId: target.projectId,
          worktreeId: target.worktreeId,
          chatId: target.chatId,
        },
      ],
    });
    accepted =
      response.resumedCount === 1 &&
      !response.failedTargets.some(
        (failed) =>
          failed.projectId === target.projectId &&
          failed.worktreeId === target.worktreeId &&
          failed.chatId === target.chatId,
      );
  } catch {
    accepted = false;
  } finally {
    inFlightChats.delete(chatKey);
  }
  // Canonical changes may have retired this request while IPC was pending.
  // Never resurrect its session or attach a result to a later interruption.
  reconcileInterruptedTurnResumeSessions();
  if (useInterruptedTurnResumeStore.getState().sessions[key] !== requestSession)
    return;
  if (accepted) {
    updateSession(key, () => ({ phase: 'accepted' }));
    clearResumedChatUsageLimitBanner(target);
    return;
  }
  updateSession(key, () => ({ error: INTERRUPTED_TURN_RESUME_FAILED_MESSAGE }));
}
