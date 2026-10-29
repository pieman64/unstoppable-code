/**
 * @jest-environment jsdom
 *
 * Phase 15 (P2 chat store split) render-count guard.
 *
 * One chat's streamed content (a message upsert, a transcript descriptor
 * update and an activity-only runtime patch, applied through the revisioned
 * sync and phase 12's per-frame render path) must reach only the surfaces
 * that show that chat's transcript:
 * - the sidebar rows (this chat's worktree and another one), the badges and
 *   the tab strip re-render and recompute nothing;
 * - an unrelated chat surface (same worktree, and another worktree)
 *   re-renders and recomputes nothing;
 * - the chat's own surface still re-renders, once per frame.
 *
 * The probes call the production hooks and components. Selector work is
 * counted where the derivation is expensive: the badge derivation walks
 * every worktree and tab, and a surface's composer projection walks its
 * transcript.
 */
import { act, Profiler, type JSX, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { WorktreeRowSlotContext } from '@canopy/ui-app';
import type {
  ChatStateChangedEvent,
  ChatStateSnapshot,
  PersistedChatMessage,
  PersistedChatTab,
} from '@canopy/desktop-shared/types';
import type { TranscriptDescriptor } from '@canopy/agent-transcript/transcript-storage';
import { chatStoreRenderView, useChatStore } from '@/stores/chatStore';
import { applyChatStateChangedForRender } from '@/stores/chat/render-cadence';
import type { FrameScheduler } from '@/stores/chat/frame-batched-store-view';
import { useWorktreeChatTabSurfaceState } from '@/components/chat/useWorktreeChatSurfaceState';
import { useChatBadgeKeys } from '@/components/sidebar/useChatBadgeKeys';
import {
  setDesktopRowLiveKeys,
  useDesktopWorktreeRowOverrides,
} from '@/components/sidebar/desktopWorktreeRowOverrides';
import { ChatTabBar } from '@/components/chat/ChatTabBar';
import type * as IdleWatcherChatsModule from '@/components/worktree/idle-watcher-chats';
import type * as ChatBadgeKeysModule from '@/components/sidebar/chatBadgeKeys';
import type * as ChatTypesModule from '@/components/chat/types';

const mockBadgeDerivations = { count: 0 };
const mockComposerProjections: Record<string, number> = {};
const mockIdleWatcherChecks: Record<string, number> = {};

jest.mock('@/components/worktree/idle-watcher-chats', () => {
  const actual = jest.requireActual<typeof IdleWatcherChatsModule>(
    '@/components/worktree/idle-watcher-chats',
  );
  return {
    ...actual,
    hasIdleWatcherChat: (
      ...args: Parameters<typeof actual.hasIdleWatcherChat>
    ): ReturnType<typeof actual.hasIdleWatcherChat> => {
      const key = args[0].worktreeId;
      mockIdleWatcherChecks[key] = (mockIdleWatcherChecks[key] ?? 0) + 1;
      return actual.hasIdleWatcherChat(...args);
    },
  };
});

jest.mock('@/components/sidebar/chatBadgeKeys', () => {
  const actual = jest.requireActual<typeof ChatBadgeKeysModule>(
    '@/components/sidebar/chatBadgeKeys',
  );
  return {
    ...actual,
    deriveChatBadgeKeys: (
      ...args: Parameters<typeof actual.deriveChatBadgeKeys>
    ): ReturnType<typeof actual.deriveChatBadgeKeys> => {
      mockBadgeDerivations.count += 1;
      return actual.deriveChatBadgeKeys(...args);
    },
  };
});

jest.mock('@/components/chat/types', () => {
  const actual = jest.requireActual<typeof ChatTypesModule>(
    '@/components/chat/types',
  );
  return {
    ...actual,
    toActiveComposerView: (
      ...args: Parameters<typeof actual.toActiveComposerView>
    ): ReturnType<typeof actual.toActiveComposerView> => {
      const id = args[0].id;
      mockComposerProjections[id] = (mockComposerProjections[id] ?? 0) + 1;
      return actual.toActiveComposerView(...args);
    },
  };
});

jest.mock('@/components/chat/ArchivedChatTranscriptModal', () => ({
  ArchivedChatTranscriptModal: (): null => null,
}));

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

const PROJECT = 'proj';
// Each test hydrates its own pair of worktrees: the chat store module, and
// the revisions it has applied, persist across the tests of this file.
let WT1 = 'wt1';
let WT2 = 'wt2';
let W1 = { projectId: PROJECT, worktreeId: WT1 };
let W2 = { projectId: PROJECT, worktreeId: WT2 };
let suite = 0;

const getStateMock = jest.fn<
  Promise<ChatStateSnapshot>,
  [{ projectId: string; worktreeId: string }]
>();

function message(
  id: string,
  role: 'user' | 'assistant',
  text: string,
  timestamp: number,
): PersistedChatMessage {
  return { id, role, blocks: [{ type: 'text', text }], timestamp };
}

function descriptor(revision: number, count: number): TranscriptDescriptor {
  return {
    format: 'complete-message-jsonl-v1',
    committedMessageCount: count,
    committedByteLength: count,
    transcriptRevision: revision,
    hasActiveSidecar: true,
    messageCount: count,
  };
}

function persistedTab(id: string): PersistedChatTab {
  return {
    id,
    title: `Tab ${id}`,
    messages: [
      message(`${id}-u1`, 'user', `hello ${id}`, 1),
      message(`${id}-a1`, 'assistant', `reply ${id}`, 2),
    ],
    createdAt: '2026-10-01T00:00:00.000Z',
  };
}

function snapshot(worktreeId: string, chatIds: string[]): ChatStateSnapshot {
  return {
    schemaVersion: 1,
    projectId: PROJECT,
    worktreeId,
    revision: 5,
    tabsFile: {
      version: 1,
      tabs: chatIds.map(persistedTab),
      activeTabId: chatIds[0],
    },
    archives: [],
    runtimeByChatId: Object.fromEntries(
      chatIds.map((chatId) => [
        chatId,
        chatId === 'b1'
          ? { status: 'streaming', queuedMessageIds: [], lastActivityAt: 50 }
          : { status: 'completed', queuedMessageIds: [], lastActivityAt: 10 },
      ]),
    ),
    queue: [],
  };
}

/** Streamed content in chat `b1` of worktree 2 (one provider commit). */
function streamedContent(
  revision: number,
  text: string,
): ChatStateChangedEvent {
  return {
    schemaVersion: 1,
    eventId: `content-${revision}`,
    occurredAt: '2026-10-01T00:00:00.000Z',
    projectId: PROJECT,
    worktreeId: WT2,
    baseRevision: revision - 1,
    revision,
    changes: [
      {
        type: 'message.upserted',
        chatId: 'b1',
        message: message('b1-a2', 'assistant', text, revision),
      },
      {
        type: 'runtime.patched',
        chatId: 'b1',
        runtime: {
          status: 'streaming',
          queuedMessageIds: [],
          lastActivityAt: revision * 10,
        },
      },
      {
        type: 'transcript.updated',
        chatId: 'b1',
        transcript: descriptor(revision, 3),
        reset: false,
      },
    ],
  };
}

function manualScheduler(): FrameScheduler & { runFrame(): void } {
  const frames = new Map<number, () => void>();
  let next = 1;
  return {
    requestFrame(callback): number {
      const handle = next++;
      frames.set(handle, callback);
      return handle;
    },
    cancelFrame(handle): void {
      frames.delete(handle);
    },
    setTimer(): number {
      return next++;
    },
    clearTimer(): void {
      return undefined;
    },
    isHidden(): boolean {
      return false;
    },
    runFrame(): void {
      const callbacks = Array.from(frames.values());
      frames.clear();
      for (const callback of callbacks) callback();
    },
  };
}

function installApi(): void {
  const subscribe = jest.fn(() => jest.fn());
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      loadPreferences: jest
        .fn()
        .mockRejectedValue(new Error('preferences unavailable')),
      savePreferences: jest.fn().mockResolvedValue(undefined),
      discoverWorktreeEnv: jest.fn(),
      getDiffStatsBatch: jest.fn().mockResolvedValue([]),
      loadCanopyCloudAccount: jest.fn().mockResolvedValue({
        hasApiKey: false,
        storageAvailable: false,
      }),
      runs: { share: jest.fn() },
      github: {
        setForegroundWorktree: jest.fn().mockResolvedValue(undefined),
        requestFastRefresh: jest.fn().mockResolvedValue(undefined),
        requestKnownPrFastRefresh: jest.fn().mockResolvedValue(false),
      },
      approvals: {
        pendingRequests: jest.fn().mockResolvedValue([]),
        getResolvedDefault: jest.fn().mockResolvedValue('ask'),
        setMode: jest.fn().mockResolvedValue(undefined),
        onRequest: subscribe,
      },
      chat: {
        loadTabs: jest.fn(),
        activeSessions: jest.fn().mockResolvedValue({ activeChatIds: [] }),
        saveTabs: jest.fn().mockResolvedValue(undefined),
        saveTabsPartial: jest.fn().mockResolvedValue({ needsFullSave: false }),
        getChatQueueSnapshot: jest.fn().mockResolvedValue([]),
        getState: getStateMock,
        setStateScopes: jest.fn().mockResolvedValue(undefined),
        archiveTab: jest.fn().mockResolvedValue([]),
        command: jest.fn(),
        listArchived: jest.fn().mockResolvedValue([]),
      },
    },
  });
  Object.defineProperty(window, 'pipelines', {
    configurable: true,
    value: {
      listSharedTeams: jest
        .fn()
        .mockResolvedValue({ success: true, data: { data: [] } }),
      listSharedOrganizations: jest
        .fn()
        .mockResolvedValue({ success: true, data: { data: [] } }),
    },
  });
}

function slotContext(worktreeId: string): WorktreeRowSlotContext {
  return {
    workspace: { localId: PROJECT, name: PROJECT, type: 'single-repo' },
    worktree: {
      localId: worktreeId,
      workspaceLocalId: PROJECT,
      branch: 'main',
    },
    selected: false,
    hidden: false,
    sortable: false,
    worktreeRemoval: undefined,
  };
}

const renders: Record<string, number> = {};

function count(id: string): void {
  renders[id] = (renders[id] ?? 0) + 1;
}

function SidebarRow({ worktreeId }: { worktreeId: string }): null {
  count(`row:${worktreeId}`);
  useDesktopWorktreeRowOverrides(slotContext(worktreeId));
  return null;
}

function Badges(): null {
  count('badges');
  useChatBadgeKeys();
  return null;
}

function Surface({
  chatId,
  worktree,
}: {
  chatId: string;
  worktree: { projectId: string; worktreeId: string };
}): null {
  count(`surface:${chatId}`);
  useWorktreeChatTabSurfaceState(chatId, worktree);
  return null;
}

function Counted({
  id,
  children,
}: {
  id: string;
  children: ReactNode;
}): JSX.Element {
  return (
    <Profiler id={id} onRender={(): void => count(id)}>
      {children}
    </Profiler>
  );
}

let container: HTMLDivElement;
let root: Root;

async function hydrate(): Promise<void> {
  getStateMock.mockImplementation((request) =>
    Promise.resolve(
      request.worktreeId === WT1
        ? snapshot(WT1, ['a1', 'a2'])
        : snapshot(WT2, ['b1', 'b2']),
    ),
  );
  await act(async () => {
    await useChatStore.getState().loadTabsForTarget(PROJECT, WT1);
    await useChatStore.getState().loadTabsForTarget(PROJECT, WT2);
    useChatStore.getState().selectWorktree(PROJECT, WT2);
  });
}

function mount(): void {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root.render(
      <>
        <SidebarRow worktreeId={WT1} />
        <SidebarRow worktreeId={WT2} />
        <Badges />
        <Counted id="tab-strip">
          <ChatTabBar scope={W2} />
        </Counted>
        <Surface chatId="a1" worktree={W1} />
        <Surface chatId="b2" worktree={W2} />
        <Surface chatId="b1" worktree={W2} />
      </>,
    );
  });
}

function resetCounts(): void {
  for (const key of Object.keys(renders)) delete renders[key];
  for (const key of Object.keys(mockComposerProjections)) {
    delete mockComposerProjections[key];
  }
  for (const key of Object.keys(mockIdleWatcherChecks)) {
    delete mockIdleWatcherChecks[key];
  }
  mockBadgeDerivations.count = 0;
}

describe('chat store split: streamed content reaches only its own chat', () => {
  beforeEach(async () => {
    suite += 1;
    WT1 = `wt1-${suite}`;
    WT2 = `wt2-${suite}`;
    W1 = { projectId: PROJECT, worktreeId: WT1 };
    W2 = { projectId: PROJECT, worktreeId: WT2 };
    installApi();
    setDesktopRowLiveKeys(null);
    await hydrate();
    mount();
    expect(
      useChatStore.getState().worktreeChats[`${PROJECT}/${WT2}`]?.tabs,
    ).toHaveLength(2);
    resetCounts();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    act(() => {
      const state = useChatStore.getState();
      state.releaseChatScopeRevisioned(PROJECT, WT1);
      state.releaseChatScopeRevisioned(PROJECT, WT2);
      useChatStore.setState({
        worktreeChats: {},
        runtimeByChatId: {},
        archivedChats: {},
        pendingQuestions: {},
      });
    });
  });

  it.each(['per-frame', 'direct'] as const)(
    'leaves sidebar rows, badges, the tab strip and other surfaces alone (%s)',
    (mode) => {
      const scheduler = manualScheduler();
      [6, 7, 8].forEach((revision, index) => {
        act(() => {
          const event = streamedContent(revision, `streamed ${index}`);
          const state = useChatStore.getState();
          if (mode === 'direct') {
            state.handleChatStateChanged(event);
            return;
          }
          applyChatStateChangedForRender(event, {
            apply: state.handleChatStateChanged,
            runtimeByChatId: state.runtimeByChatId,
            view: chatStoreRenderView,
            scheduler,
          });
        });
      });
      act(() => scheduler.runFrame());

      // The store applied every event.
      const b1 = useChatStore
        .getState()
        .worktreeChats[
          `${PROJECT}/${WT2}`
        ]?.tabs.find((tab) => tab.id === 'b1');
      expect(b1?.messages.map((entry) => entry.id)).toEqual([
        'b1-u1',
        'b1-a1',
        'b1-a2',
      ]);

      // The streaming chat's own surface still renders: once for the frame,
      // or once per event when the events are applied directly.
      const ownRenders = renders['surface:b1'] ?? 0;
      const ownProjections = mockComposerProjections.b1 ?? 0;
      expect(ownRenders).toBe(mode === 'direct' ? 3 : 1);
      expect(ownProjections).toBeGreaterThanOrEqual(ownRenders);
      delete renders['surface:b1'];
      delete mockComposerProjections.b1;

      // Nothing else renders or recomputes.
      expect({
        renders: { ...renders },
        badgeDerivations: mockBadgeDerivations.count,
        idleWatcherChecks: { ...mockIdleWatcherChecks },
        composerProjections: { ...mockComposerProjections },
      }).toEqual({
        renders: {},
        badgeDerivations: 0,
        idleWatcherChecks: {},
        composerProjections: {},
      });
    },
  );
});
