import {
  toPersistedTabsWithCache,
  toPersistedMessage,
} from '../persisted-tabs';
import { toPersistedPendingQuestions } from '../pending-questions';
import { emptyWorktreeChat } from '../tab-utils';
import type { ChatTab, PendingQuestion, WorktreeChatState } from '../types';
import type { PersistedChatTab } from '@canopy/desktop-shared/types';

function makeTab(overrides?: Partial<ChatTab>): ChatTab {
  return {
    id: 'chat',
    title: 'Chat',
    messages: [],
    status: 'idle',
    error: null,
    createdAt: '2026-03-19T00:00:00.000Z',
    queuedMessages: [],
    planMode: false,
    proposalMode: 'optional',
    thinkingLevel: 'high',
    model: 'claude-sonnet-4-5-20250514',
    providerType: 'claude',
    ...overrides,
  };
}

function makeState(tabs: ChatTab[], activeTabId: string): WorktreeChatState {
  return {
    ...emptyWorktreeChat(),
    tabs,
    activeTabId,
  };
}

const options = {
  projectId: 'project',
  worktreeId: 'worktree',
  pendingQuestions: {},
};

describe('toPersistedTabsWithCache', () => {
  it('reports every tab as changed on the first build and none on an identical rebuild', () => {
    const cache = new WeakMap<ChatTab, PersistedChatTab>();
    const tabA = makeTab({ id: 'a' });
    const tabB = makeTab({ id: 'b' });
    const state = makeState([tabA, tabB], 'a');

    const first = toPersistedTabsWithCache(
      state,
      options,
      cache,
      new Set<string>(),
    );
    expect(first.changedEntries.map((entry) => entry.persisted.id)).toEqual([
      'a',
      'b',
    ]);
    expect(first.file.tabs.map((tab) => tab.id)).toEqual(['a', 'b']);

    // Simulate a successful save committing the cache.
    for (const entry of first.changedEntries) {
      cache.set(entry.tab, entry.persisted);
    }

    const second = toPersistedTabsWithCache(
      state,
      options,
      cache,
      new Set(['a', 'b']),
    );
    expect(second.changedEntries).toEqual([]);
    expect(second.removedTabIds).toEqual([]);
    // Cached payloads are reused by reference — no re-serialization.
    expect(second.file.tabs[0]).toBe(first.file.tabs[0]);
    expect(second.file.tabs[1]).toBe(first.file.tabs[1]);
  });

  it('reports only the replaced tab object as changed and detects removals', () => {
    const cache = new WeakMap<ChatTab, PersistedChatTab>();
    const tabA = makeTab({ id: 'a' });
    const tabB = makeTab({ id: 'b' });
    const initial = toPersistedTabsWithCache(
      makeState([tabA, tabB], 'a'),
      options,
      cache,
      new Set<string>(),
    );
    for (const entry of initial.changedEntries) {
      cache.set(entry.tab, entry.persisted);
    }

    // Immutable update: tab B replaced, tab A keeps identity, and tab B's
    // previous object disappears along with a removal of tab A.
    const updatedTabB: ChatTab = { ...tabB, title: 'Renamed' };
    const delta = toPersistedTabsWithCache(
      makeState([updatedTabB], 'b'),
      options,
      cache,
      new Set(['a', 'b']),
    );

    expect(delta.changedEntries.map((entry) => entry.persisted.id)).toEqual([
      'b',
    ]);
    expect(delta.removedTabIds).toEqual(['a']);
    expect(delta.file.activeTabId).toBe('b');
  });

  it('does not mutate the cache during the build', () => {
    const cache = new WeakMap<ChatTab, PersistedChatTab>();
    const tab = makeTab({ id: 'a' });
    toPersistedTabsWithCache(
      makeState([tab], 'a'),
      options,
      cache,
      new Set<string>(),
    );
    // A failed save must leave the tab dirty: the builder itself never
    // commits entries.
    expect(cache.get(tab)).toBeUndefined();
  });
});

describe('toPersistedPendingQuestions answered-record serialization', () => {
  const answered: PendingQuestion = {
    requestId: 'answered',
    projectId: 'project',
    worktreeId: 'worktree',
    chatId: 'chat',
    questions: [
      { id: 'q1', question: 'Enter API token', options: [], secret: true },
    ],
    // Redacted display answers (raw secret already swapped for `[hidden]`).
    answers: [
      {
        questionId: 'q1',
        question: 'Enter API token',
        selectedOptions: [],
        freeformText: '[hidden]',
      },
    ],
    answeredAt: 1_717_000_000_000,
    toolUseId: 'codex-call-1',
  };

  const unanswered: PendingQuestion = {
    requestId: 'unanswered',
    projectId: 'project',
    worktreeId: 'worktree',
    chatId: 'chat',
    questions: [{ id: 'q2', question: 'Pick one', options: ['a', 'b'] }],
  };

  it('round-trips an answered record (answeredAt + answers) while leaving an unanswered record untouched', () => {
    const state = makeState([makeTab({ id: 'chat' })], 'chat');

    const persisted = toPersistedPendingQuestions(
      'project',
      'worktree',
      state,
      {
        answered,
        unanswered,
      },
    );

    expect(persisted).toBeDefined();
    const byRequestId = new Map(
      (persisted ?? []).map((entry) => [entry.requestId, entry]),
    );

    // Answered record is retained (not gated out) and serializes both the
    // `answeredAt` marker and the redacted display `answers`.
    expect(byRequestId.get('answered')).toEqual({
      requestId: 'answered',
      chatId: 'chat',
      questions: answered.questions,
      answers: answered.answers,
      answeredAt: 1_717_000_000_000,
      toolUseId: 'codex-call-1',
    });

    // Unanswered record is unaffected: no `answeredAt`, no `answers`.
    const unansweredPersisted = byRequestId.get('unanswered');
    expect(unansweredPersisted).toEqual({
      requestId: 'unanswered',
      chatId: 'chat',
      questions: unanswered.questions,
    });
    expect(unansweredPersisted).not.toHaveProperty('answeredAt');
    expect(unansweredPersisted).not.toHaveProperty('answers');
  });
});

it('retains hidden orchestration metadata through the message persistence and hydration boundary', () => {
  const message = {
    id: 'delivery',
    role: 'user' as const,
    hidden: true,
    timestamp: 1,
    blocks: [{ type: 'text' as const, text: 'completion evidence' }],
  };
  expect(toPersistedMessage(message)).toEqual(message);
});
