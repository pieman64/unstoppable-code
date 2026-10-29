// Turn-level thumbs up/down feedback (CAN-1521).
//
// A rating is written optimistically as `pending`, then settled to `synced` or
// `failed` by the IPC ack. A `failed` rating KEEPS the rating — a rejected
// upload must never silently revert the user's click, and the main-process
// outbox will retry it on the next sign-in or startup flush.
import type { StateCreator } from 'zustand';
import type {
  TurnFeedbackEntry,
  TurnFeedbackListResponseIpc,
} from '@canopy/desktop-shared/types';
import {
  APP_ADVISOR_PROJECT_ID,
  PIPELINE_EDITOR_PROJECT_ID,
} from '@canopy/desktop-shared/types';
import { CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT } from '@canopy/desktop-shared/constants/canopy-cloud';
import type {
  TurnFeedbackReason,
  TurnFeedbackSummary,
} from '@canopy/protocol/turn-feedback';
import { isCoworkChatTarget } from '@/lib/cowork';
import { getWorktreeChatContext, updateCapturedChatTab } from '../context';
import type { ChatState, ChatTurnFeedbackSlice } from '../state';
import type { ChatTab } from '../types';

/**
 * Technical context denormalized onto the feedback row so the warehouse can
 * slice ratings without joining `transcript_turns`, which does not exist when
 * telemetry is disabled. Mirrors how the main process classifies a chat turn
 * for the audit entry; unknown values are dropped server-side rather than
 * rejected, so a mismatch degrades to a null column, never to a failed rating.
 */
function eventTypeForTarget(projectId: string): string {
  if (projectId === APP_ADVISOR_PROJECT_ID) return 'app_advisor';
  if (projectId === PIPELINE_EDITOR_PROJECT_ID) return 'pipeline_editor';
  return isCoworkChatTarget(projectId) ? 'standalone_chat' : 'worktree_chat';
}

/**
 * `terminal` for a Claude Code terminal transcript, `canopy` for a native one.
 * In practice only Canopy-native transcripts render turn groups today, but
 * deriving it keeps the column honest if that ever changes.
 */
function chatModeForTab(tab: ChatTab): string {
  return tab.interfaceMode === 'claude-code' ? 'terminal' : 'canopy';
}

/**
 * The preload bindings are probed rather than assumed so this UI slice can
 * land (and be unit-tested) without the main-process handlers present.
 */
function hasTurnFeedbackApi(): boolean {
  return typeof window.api?.rateTurnFeedback === 'function';
}

/**
 * Chats whose server-side ratings have already been pulled this renderer
 * session, keyed `${projectId}/${worktreeId}/${chatId}`. Rehydration is what
 * makes a rating recorded on another device show up here; the local tab copy
 * already covers the same-device restart.
 */
const hydratedFeedbackChats = new Set<string>();

/**
 * Forget which chats have been hydrated.
 *
 * Called when the signed-in Canopy Cloud account changes. Without it a chat
 * opened while signed out stays marked hydrated for the life of the renderer,
 * so the rows the outbox flushes on sign-in — and anything that account rated
 * on another device — would not appear until the app restarted.
 */
export function resetTurnFeedbackHydration(): void {
  hydratedFeedbackChats.clear();
}

// Sign-in/sign-out already broadcasts this window event (see
// `SidebarAccountMenu`), so the reset rides on the signal the renderer
// maintains rather than a second account subscription.
//
// The guard probes `addEventListener` itself, not just `window`. Node-env test
// suites that import this slice transitively (chatStore.test.ts) install a
// partial `window` stub for `window.api`, so `typeof window !== 'undefined'`
// is true there while `addEventListener` is missing — a `window`-only check
// throws at module load and takes the whole importing suite down with it.
if (
  typeof window !== 'undefined' &&
  typeof window.addEventListener === 'function'
) {
  window.addEventListener(
    CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT,
    resetTurnFeedbackHydration,
  );
}

function writeTurnFeedback(
  tab: ChatTab,
  userMessageId: string,
  entry: TurnFeedbackEntry | null,
): ChatTab {
  const next: Record<string, TurnFeedbackEntry> = { ...tab.turnFeedback };
  if (entry === null) {
    delete next[userMessageId];
  } else {
    next[userMessageId] = entry;
  }
  if (Object.keys(next).length === 0) {
    const rest = { ...tab };
    delete rest.turnFeedback;
    return rest;
  }
  return { ...tab, turnFeedback: next };
}

export const createTurnFeedbackSlice: StateCreator<
  ChatState,
  [],
  [],
  ChatTurnFeedbackSlice
> = (set, get) => ({
  setTurnFeedback: async (userMessageId, rating, target): Promise<void> => {
    const context = getWorktreeChatContext(get(), target);
    if (!context || !context.activeTab) return;
    const tab = context.activeTab;

    // Clearing retracts the rating everywhere, not just here: the queued
    // outbox entry is dropped so it cannot upload on the next flush, and any
    // server row is deleted so `loadTurnFeedback` cannot rehydrate the thumb
    // the user just cleared. Local state clears first and unconditionally —
    // the click must feel instant and must not depend on the network.
    if (rating === null) {
      const existing = tab.turnFeedback?.[userMessageId];
      set((state) =>
        updateCapturedChatTab(state, context, (candidate) =>
          writeTurnFeedback(candidate, userMessageId, null),
        ),
      );
      if (typeof window.api?.clearTurnFeedback === 'function') {
        await window.api.clearTurnFeedback({
          clientUserMessageId: userMessageId,
          ...(existing?.feedbackId ? { feedbackId: existing.feedbackId } : {}),
        });
      }
      return;
    }

    const optimistic: TurnFeedbackEntry = {
      rating,
      syncState: 'pending',
      ratedAt: Date.now(),
    };
    set((state) =>
      updateCapturedChatTab(state, context, (candidate) =>
        writeTurnFeedback(candidate, userMessageId, optimistic),
      ),
    );

    if (!hasTurnFeedbackApi()) return;

    const response = await window.api.rateTurnFeedback({
      clientUserMessageId: userMessageId,
      clientChatId: context.chatId,
      // The rated work, so main can attribute the rating to its bound owner
      // instead of the server guessing an organization (CAN-3465). Main keeps
      // both ids off the wire and sends only the resolved owner.
      projectId: context.selection.projectId,
      worktreeId: context.selection.worktreeId,
      rating,
      ...(tab.providerType ? { provider: tab.providerType } : {}),
      ...(tab.model ? { model: tab.model } : {}),
      eventType: eventTypeForTarget(context.selection.projectId),
      chatMode: chatModeForTab(tab),
    });

    set((state) =>
      updateCapturedChatTab(state, context, (candidate) => {
        const current = candidate.turnFeedback?.[userMessageId];
        // The user re-rated (or cleared) while the call was in flight —
        // leave the newer intent alone.
        if (!current || current.ratedAt !== optimistic.ratedAt) {
          return candidate;
        }
        return writeTurnFeedback(candidate, userMessageId, {
          ...current,
          syncState: response.recorded || response.queued ? 'synced' : 'failed',
          ...(response.feedbackId ? { feedbackId: response.feedbackId } : {}),
        });
      }),
    );
  },

  submitTurnFeedbackDetail: async (
    userMessageId,
    detail,
    target,
  ): Promise<void> => {
    const context = getWorktreeChatContext(get(), target);
    if (!context || !context.activeTab) return;
    const existing = context.activeTab.turnFeedback?.[userMessageId];
    if (!existing) return;

    const reason: TurnFeedbackReason | undefined = detail.reason;
    const comment = detail.comment;

    set((state) =>
      updateCapturedChatTab(state, context, (candidate) => {
        const current = candidate.turnFeedback?.[userMessageId];
        if (!current) return candidate;
        return writeTurnFeedback(candidate, userMessageId, {
          ...current,
          ...(reason ? { reason } : {}),
          ...(comment !== undefined && comment.length > 0
            ? { hasComment: true }
            : {}),
        });
      }),
    );

    if (typeof window.api?.submitTurnFeedbackDetail !== 'function') return;

    await window.api.submitTurnFeedbackDetail({
      clientUserMessageId: userMessageId,
      ...(existing.feedbackId ? { feedbackId: existing.feedbackId } : {}),
      ...(reason ? { reason } : {}),
      ...(comment !== undefined && comment.length > 0 ? { comment } : {}),
    });
  },

  mergeServerTurnFeedback: (summaries, target): void => {
    const context = getWorktreeChatContext(get(), target);
    if (!context) return;

    set((state) =>
      updateCapturedChatTab(state, context, (candidate) => {
        const next: Record<string, TurnFeedbackEntry> = {
          ...candidate.turnFeedback,
        };
        let changed = false;
        for (const summary of summaries) {
          const local = next[summary.clientUserMessageId];
          // A local pending/failed entry is newer intent than anything the
          // server knows about; never let rehydration clobber it.
          if (local && local.syncState !== 'synced') continue;
          const merged: TurnFeedbackEntry = {
            rating: summary.rating,
            syncState: 'synced',
            ratedAt: local?.ratedAt ?? Date.parse(summary.createdAt),
            ...(summary.reason ? { reason: summary.reason } : {}),
            ...(summary.hasComment ? { hasComment: true } : {}),
            feedbackId: summary.feedbackId,
          };
          // `next` is already a fresh copy of the tab's map, so assign into
          // it rather than rebuilding the whole object per summary.
          next[summary.clientUserMessageId] = merged;
          changed = true;
        }
        if (!changed) return candidate;
        return { ...candidate, turnFeedback: next };
      }),
    );
  },

  loadTurnFeedback: async (target): Promise<void> => {
    if (typeof window.api?.listTurnFeedback !== 'function') return;
    const context = getWorktreeChatContext(get(), target);
    if (!context) return;

    // One fetch per chat per renderer session: the callers are mount effects,
    // and a chat panel remounts often (tab switches, split panes, popouts).
    // Marked before the await so two concurrent mounts do not both fetch.
    const hydrationKey = `${context.key}/${context.chatId}`;
    if (hydratedFeedbackChats.has(hydrationKey)) return;
    hydratedFeedbackChats.add(hydrationKey);

    let response: TurnFeedbackListResponseIpc;
    try {
      response = await window.api.listTurnFeedback({
        clientChatId: context.chatId,
      });
    } catch {
      // The IPC handler resolves rather than rejects, but a missing/stubbed
      // preload binding must not leave the chat permanently un-hydratable.
      hydratedFeedbackChats.delete(hydrationKey);
      return;
    }
    const summaries: TurnFeedbackSummary[] = response.feedback;
    if (summaries.length === 0) return;
    get().mergeServerTurnFeedback(summaries, target);
  },
});
