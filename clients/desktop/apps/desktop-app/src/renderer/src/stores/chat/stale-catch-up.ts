import { useEffect } from 'react';
import type {
  ChatInterestChatRef,
  ChatStateChange,
  ChatStateChangedEvent,
} from '@canopy/desktop-shared/types';
import type {
  ChatInterest,
  ChatInterestListener,
} from '@/lib/chat-interest/tracker';
import { chatInterestRefKey } from '@/lib/chat-interest/tracker';
import { applyCanonicalChanges } from './canonical-changes';
import { chatScopeKey } from './revisioned-sync';
import { chatStoreApi } from './store-ref';
import {
  installTranscriptPage,
  loadChatTranscriptPage,
  TRANSCRIPT_PAGE_LOAD_ERROR,
} from './transcript-pages';

export interface StaleChatCatchUpHost {
  current(): ChatInterest | null;
  subscribe(listener: ChatInterestListener): () => void;
  flush(): Promise<void>;
}

export interface StaleChatCatchUpState {
  readonly loading: boolean;
  readonly error: string | null;
}

interface Recording {
  target: ChatInterestChatRef;
  generation: number;
  cancelled: boolean;
  changes: Array<{ revision: number; changes: ChatStateChange[] }>;
}

const recordings = new Map<string, Recording>();
const states = new Map<string, StaleChatCatchUpState>();
const listeners = new Set<() => void>();
const idle: StaleChatCatchUpState = { loading: false, error: null };

export function getStaleChatCatchUpState(
  target: ChatInterestChatRef,
): StaleChatCatchUpState {
  return states.get(chatInterestRefKey(target)) ?? idle;
}

/** A catch-up read for `target` is running (including its first 300 ms). */
export function isStaleChatCatchUpRunning(
  target: ChatInterestChatRef,
): boolean {
  return recordings.has(chatInterestRefKey(target));
}

export function subscribeStaleChatCatchUp(listener: () => void): () => void {
  listeners.add(listener);
  return (): void => {
    listeners.delete(listener);
  };
}

function publish(
  target: ChatInterestChatRef,
  state: StaleChatCatchUpState,
): void {
  const key = chatInterestRefKey(target);
  if (!state.loading && state.error === null) states.delete(key);
  else states.set(key, state);
  listeners.forEach((listener) => listener());
}

/** Called inside canonical publication, before store subscribers can start a read.
 * Cadence batches may contain several transcript revisions; retain each boundary. */
export function recordStaleChatCatchUpChanges(
  event: ChatStateChangedEvent,
): void {
  for (const recording of Array.from(recordings.values())) {
    const { target } = recording;
    if (
      target.projectId !== event.projectId ||
      target.worktreeId !== event.worktreeId
    )
      continue;
    let pending: ChatStateChange[] = [];
    for (const change of event.changes) {
      if (
        change.type === 'tab.upserted' &&
        change.tab.id === target.chatId &&
        change.tab.transcriptLoaded !== false
      ) {
        recording.generation += 1;
      }
      if (!('chatId' in change) || change.chatId !== target.chatId) continue;
      switch (change.type) {
        case 'messages.omitted':
        case 'messages.replaced':
          recording.generation += 1;
          break;
        case 'message.upserted':
        case 'message.removed':
          pending.push(change);
          break;
        case 'transcript.updated':
          if (change.reset) recording.generation += 1;
          pending.push(change);
          recording.changes.push({
            revision: change.transcript.transcriptRevision,
            changes: pending,
          });
          pending = [];
          break;
      }
    }
    if (pending.length) {
      recording.changes.push({
        revision: Number.POSITIVE_INFINITY,
        changes: pending,
      });
    }
  }
}

/** A scope snapshot supersedes any body history recorded during its read. */
export function invalidateStaleChatCatchUpScope(
  projectId: string,
  worktreeId: string,
): void {
  for (const recording of Array.from(recordings.values())) {
    if (
      recording.target.projectId === projectId &&
      recording.target.worktreeId === worktreeId
    ) {
      recording.generation += 1;
    }
  }
}

class RestartCatchUp extends Error {}

/** Keep cached rows until one newest page plus its live overlap installs atomically. */
export async function catchUpStaleChat(
  target: ChatInterestChatRef,
  flushInterest: () => Promise<void>,
): Promise<void> {
  const key = chatInterestRefKey(target);
  if (recordings.has(key)) return;
  const api = chatStoreApi();
  const scopeKey = chatScopeKey(target.projectId, target.worktreeId);
  const recording: Recording = {
    target,
    generation: 0,
    cancelled: false,
    changes: [],
  };
  recordings.set(key, recording);
  const cached = api
    .getState()
    .worktreeChats[scopeKey]?.tabs.find((tab) => tab.id === target.chatId)
    ?.messages.length;
  publish(target, { loading: !cached, error: null });
  const timer = setTimeout(() => {
    if (!recording.cancelled) publish(target, { loading: true, error: null });
  }, 300);
  try {
    // Record before awaiting the acknowledgement too: main can publish a body
    // after applying focus but before the invoke reply reaches this window.
    await flushInterest();
    if (api.getState().chatStateSync[scopeKey]?.phase !== 'live') {
      const result = await api
        .getState()
        .hydrateChatScopeRevisioned(target.projectId, target.worktreeId);
      if (result !== 'installed') throw new Error(TRANSCRIPT_PAGE_LOAD_ERROR);
    }
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (recording.cancelled) return;
      recording.changes = [];
      const generation = recording.generation;
      try {
        await loadChatTranscriptPage(
          target,
          false,
          undefined,
          (current, page) => {
            if (recording.cancelled || generation !== recording.generation)
              throw new RestartCatchUp();
            const installed = installTranscriptPage(current, page, false);
            const changes = recording.changes.flatMap((entry) =>
              entry.revision > page.transcriptRevision ? entry.changes : [],
            );
            const projection = applyCanonicalChanges(
              {
                chatState: { tabs: [installed], activeTabId: target.chatId },
                archives: [],
                runtimeByChatId: {},
                pendingQuestions: {},
              },
              changes,
              target,
            );
            const next = projection.chatState.tabs[0];
            // TODOs fold the full canonical transcript, not only this newest page.
            next.currentTodos = current.currentTodos;
            next.currentTaskTodos = current.currentTaskTodos;
            delete next.transcriptStale;
            return next;
          },
        );
        if (!recording.cancelled) publish(target, idle);
        return;
      } catch (error) {
        if (!(error instanceof RestartCatchUp) || attempt === 2) throw error;
      }
    }
  } catch {
    if (!recording.cancelled)
      publish(target, { loading: false, error: TRANSCRIPT_PAGE_LOAD_ERROR });
    throw new Error(TRANSCRIPT_PAGE_LOAD_ERROR);
  } finally {
    clearTimeout(timer);
    if (recordings.get(key) === recording) recordings.delete(key);
  }
}

export function startStaleChatCatchUp(host: StaleChatCatchUpHost): () => void {
  const api = chatStoreApi();
  let focused = new Set<string>();
  const check = (): void => {
    const refs = host.current()?.focused ?? [];
    const previous = focused;
    focused = new Set(refs.map(chatInterestRefKey));
    for (const target of refs) {
      const tab = api
        .getState()
        .worktreeChats[
          chatScopeKey(target.projectId, target.worktreeId)
        ]?.tabs.find((tab) => tab.id === target.chatId);
      // Only stale tabs; an unhydrated focused chat stays with today's
      // selection path.
      if (
        tab?.transcriptStale &&
        (!previous.has(chatInterestRefKey(target)) ||
          !states.has(chatInterestRefKey(target)))
      ) {
        void catchUpStaleChat(target, () => host.flush()).catch(
          () => undefined,
        );
      }
    }
  };
  const unsubscribeInterest = host.subscribe(check);
  const unsubscribeStore = api.subscribe((state, previous) => {
    if (state.worktreeChats !== previous.worktreeChats) check();
  });
  check();
  return (): void => {
    unsubscribeInterest();
    unsubscribeStore();
    for (const [key, recording] of Array.from(recordings.entries())) {
      recording.cancelled = true;
      recordings.delete(key);
    }
    states.clear();
  };
}

export function useStaleChatCatchUp(host: StaleChatCatchUpHost): void {
  useEffect(() => startStaleChatCatchUp(host), [host]);
}
