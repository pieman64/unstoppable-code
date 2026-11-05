/** Prefetch likely switches into the cache without changing navigation or unread. */
import { useEffect } from 'react';
import type { ChatInterestChatRef } from '@canopy/desktop-shared/types';
import {
  flushChatInterest,
  getChatInterest,
  warmUpChat,
} from '@/lib/chat-interest';
import { chatInterestRefKey } from '@/lib/chat-interest/tracker';
import { resolveAttentionLanding } from './attention-landing';
import { chatScopeKey } from './revisioned-sync';
import { chatStoreApi } from './store-ref';
import type { ChatState } from './state';
import type { ChatTab } from './types';
import { catchUpStaleChat, isStaleChatCatchUpRunning } from './stale-catch-up';

/** What a click would show: a chat, or a worktree's active/landing chat. */
export type ChatPrefetchTarget =
  | ({ kind: 'chat' } & ChatInterestChatRef)
  | {
      kind: 'worktree';
      projectId: string;
      worktreeId: string;
      /** Resolve the implicit entry destination instead of its active tab. */
      attentionLanding?: boolean;
    };

/** Pointer intents wait for a short dwell; keyboard focus acts at once. */
export type ChatPrefetchSource = 'pointer' | 'focus';

export interface ChatPrefetchHost {
  getState(): Pick<
    ChatState,
    | 'worktreeChats'
    | 'chatStateSync'
    | 'hiddenChatTabIds'
    | 'pendingQuestions'
    | 'pendingApprovals'
    | 'pendingPlanExits'
  >;
  subscribe(callback: () => void): () => void;
  focused(): readonly ChatInterestChatRef[];
  isCatchingUp(target: ChatInterestChatRef): boolean;
  hydrate: ChatState['hydrateChatScopeRevisioned'];
  warmUp(target: ChatInterestChatRef): Promise<void>;
  catchUp(
    target: ChatInterestChatRef,
    flush: () => Promise<void>,
  ): Promise<void>;
  flush: () => Promise<void>;
  scheduleIdle: (callback: () => void) => () => void;
}

interface Intent {
  target: ChatPrefetchTarget;
  timer?: ReturnType<typeof setTimeout>;
}

const DWELL_MS = 80;
const QUEUE_LIMIT = 8;
let running: {
  note(target: ChatPrefetchTarget, source: ChatPrefetchSource): void;
  end(target: ChatPrefetchTarget): void;
  dispose: () => void;
} | null = null;

function targetKey(target: ChatPrefetchTarget): string {
  return JSON.stringify([
    target.projectId,
    target.worktreeId,
    target.kind === 'chat' ? target.chatId : null,
    target.kind === 'worktree' && target.attentionLanding === true,
  ]);
}

/** The pointer rests on, or focus moved onto, an element that shows `target`. */
export const noteChatIntent: (
  target: ChatPrefetchTarget,
  source: ChatPrefetchSource,
) => void = (target, source) => running?.note(target, source);

/** The pointer or focus left `target`: cancel its prefetch if not started. */
export const endChatIntent: (target: ChatPrefetchTarget) => void = (target) =>
  running?.end(target);

/** One scheduler per main renderer; all store/transport effects are host ports. */
export function startChatPrefetch(host: ChatPrefetchHost): () => void {
  running?.dispose();
  let disposed = false;
  let active = 0;
  let idleActive = false;
  let cancelIdle: (() => void) | undefined;
  const intents = new Map<string, Intent>();
  const inFlight = new Set<string>();
  const queue: Intent[] = [];
  // A failed idle read must not spin on the same cached tab. A new projection
  // can be tried again, and old projections do not remain retained here.
  const idleAttempted = new WeakSet<ChatTab>();

  const allowed = (): boolean => !disposed;
  const skip = (ref: ChatInterestChatRef): boolean =>
    host.isCatchingUp(ref) ||
    host
      .focused()
      .some(
        (focused) => chatInterestRefKey(focused) === chatInterestRefKey(ref),
      );

  const prefetch = async (target: ChatPrefetchTarget): Promise<void> => {
    const scope = chatScopeKey(target.projectId, target.worktreeId);
    const untracked = !host.getState().chatStateSync[scope];
    if (target.kind === 'chat' && skip(target)) return;
    if (untracked) {
      const result = await host.hydrate(target.projectId, target.worktreeId);
      if (result !== 'installed' || !allowed()) return;
    }
    const chatState = host.getState();
    const state = chatState.worktreeChats[scope];
    let chatId = target.kind === 'chat' ? target.chatId : state?.activeTabId;
    if (target.kind === 'worktree' && target.attentionLanding && state) {
      chatId =
        resolveAttentionLanding({
          projectId: target.projectId,
          worktreeId: target.worktreeId,
          tabs: state.tabs,
          activeTabId: state.activeTabId,
          hiddenChatTabIds: chatState.hiddenChatTabIds,
          pendingQuestions: chatState.pendingQuestions,
          pendingApprovals: chatState.pendingApprovals,
          pendingPlanExits: chatState.pendingPlanExits,
        }).tabId ?? state.activeTabId;
    }
    if (!chatId) return;
    const ref: ChatInterestChatRef = {
      projectId: target.projectId,
      worktreeId: target.worktreeId,
      chatId,
    };
    const tab = state?.tabs.find((entry) => entry.id === chatId);
    const key = chatInterestRefKey(ref);
    if (
      !tab ||
      tab.kind === 'file' ||
      // A tracked chat needs a read only when stale or never loaded.
      (!untracked && !tab.transcriptStale && tab.transcriptLoaded !== false) ||
      skip(ref) ||
      inFlight.has(key)
    )
      return;
    inFlight.add(key);
    try {
      await host.warmUp(ref);
      if (allowed() && !skip(ref)) await host.catchUp(ref, host.flush);
    } finally {
      inFlight.delete(key);
    }
  };

  const launch = (intent: Intent, idle = false): void => {
    active += 1;
    if (idle) idleActive = true;
    void prefetch(intent.target)
      .catch(() => undefined)
      .finally(() => {
        active -= 1;
        if (idle) idleActive = false;
        if (intents.get(targetKey(intent.target)) === intent)
          intents.delete(targetKey(intent.target));
        drain();
        scheduleIdle();
      });
  };

  const drain = (): void => {
    while (allowed() && active < 2 && queue.length) {
      const intent = queue.shift();
      if (intent && intents.get(targetKey(intent.target)) === intent)
        launch(intent);
    }
  };

  const scheduleIdle = (): void => {
    if (!allowed() || cancelIdle || idleActive || active >= 2) return;
    cancelIdle = host.scheduleIdle(() => {
      cancelIdle = undefined;
      if (!allowed() || idleActive || active >= 2) return;
      let newest:
        | { ref: ChatInterestChatRef; tab: ChatTab; at: number }
        | undefined;
      for (const [scope, state] of Object.entries(
        host.getState().worktreeChats,
      )) {
        const slash = scope.indexOf('/');
        if (slash < 0) continue;
        for (const tab of state.tabs) {
          const ref = {
            projectId: scope.slice(0, slash),
            worktreeId: scope.slice(slash + 1),
            chatId: tab.id,
          };
          if (
            !tab.unread ||
            !tab.transcriptStale ||
            tab.kind === 'file' ||
            idleAttempted.has(tab) ||
            inFlight.has(chatInterestRefKey(ref)) ||
            skip(ref)
          )
            continue;
          const at =
            tab.lastEventAt ??
            tab.messages[tab.messages.length - 1]?.timestamp ??
            (Date.parse(tab.createdAt) || 0);
          if (!newest || at > newest.at) newest = { ref, tab, at };
        }
      }
      if (newest) {
        idleAttempted.add(newest.tab);
        launch({ target: { kind: 'chat', ...newest.ref } }, true);
      }
    });
  };

  const clearPending = (): void => {
    for (const intent of Array.from(intents.values()))
      clearTimeout(intent.timer);
    intents.clear();
    queue.length = 0;
    cancelIdle?.();
    cancelIdle = undefined;
  };
  const unsubscribeStore = host.subscribe(scheduleIdle);
  const scheduler: NonNullable<typeof running> = {
    note: (target, source): void => {
      if (!allowed()) return;
      const key = targetKey(target);
      const previous = intents.get(key);
      if (previous) {
        if (source !== 'focus' || previous.timer === undefined) return;
        clearTimeout(previous.timer);
        previous.timer = undefined;
        enqueue(previous);
      } else {
        const intent: Intent = { target };
        intents.set(key, intent);
        if (source === 'pointer') {
          intent.timer = setTimeout(() => {
            intent.timer = undefined;
            enqueue(intent);
          }, DWELL_MS);
          return;
        }
        enqueue(intent);
      }
    },
    end: (target): void => {
      const key = targetKey(target);
      clearTimeout(intents.get(key)?.timer);
      intents.delete(key);
    },
    dispose: (): void => {
      if (disposed) return;
      disposed = true;
      clearPending();
      unsubscribeStore();
      if (running === scheduler) running = null;
    },
  };
  const enqueue = (intent: Intent): void => {
    queue.unshift(intent);
    while (queue.length > QUEUE_LIMIT) {
      const dropped = queue.pop();
      if (dropped && intents.get(targetKey(dropped.target)) === dropped)
        intents.delete(targetKey(dropped.target));
    }
    drain();
  };
  running = scheduler;
  scheduleIdle();
  return scheduler.dispose;
}

function scheduleBrowserIdle(callback: () => void): () => void {
  if (typeof window.requestIdleCallback === 'function') {
    const id = window.requestIdleCallback(callback, { timeout: 1000 });
    return (): void => window.cancelIdleCallback(id);
  }
  const timer = setTimeout(callback, 1000);
  return (): void => clearTimeout(timer);
}

const browserHost: ChatPrefetchHost = {
  getState: () => chatStoreApi().getState(),
  subscribe: (callback) =>
    chatStoreApi().subscribe((state, previous) => {
      if (state.worktreeChats !== previous.worktreeChats) callback();
    }),
  focused: () => getChatInterest()?.focused ?? [],
  isCatchingUp: isStaleChatCatchUpRunning,
  hydrate: (projectId, worktreeId) =>
    chatStoreApi()
      .getState()
      .hydrateChatScopeRevisioned(projectId, worktreeId, {
        speculative: true,
      }),
  warmUp: warmUpChat,
  catchUp: catchUpStaleChat,
  flush: flushChatInterest,
  scheduleIdle: scheduleBrowserIdle,
};

export function useChatPrefetch(): void {
  useEffect(() => startChatPrefetch(browserHost), []);
}
