/**
 * @jest-environment jsdom
 *
 * The Chat visuals source cache keeps a closed chat's host so its visuals stay
 * readable. The host must not keep the closed list's render alive: a callback
 * created during render shares that render's closure scope, which holds the
 * transcript, the virtualizer and every ref.
 */
// eslint-disable-next-line no-restricted-imports -- jsdom has no TextEncoder to size agent artifact receipts.
import { TextEncoder as NodeTextEncoder } from 'node:util';
// eslint-disable-next-line no-restricted-imports -- the test needs a real garbage collection.
import { setFlagsFromString } from 'node:v8';
// eslint-disable-next-line no-restricted-imports -- the test needs a real garbage collection.
import { runInNewContext } from 'node:vm';
import { act, type JSX } from 'react';
import { createRoot } from 'react-dom/client';
import {
  useChatVisualsSource,
  type ChatVisualsSource,
} from '@canopy/ui-app/code/chat-visuals-source';
import { CanopyClientProvider } from '@canopy/app-state';
import { ipcCanopyClient } from '@/client/ipc-canopy-client';
import { ChatMessageList } from '../ChatMessageList';
import { desktopChatVisualsKey } from '@/lib/desktop-chat-visual-host';
import type { ChatMessage } from '@/stores/chatStore';
import type * as ChatRenderStoresTestUtils from '@/test-utils/chatRenderStores';

const mockChatId = 'chat-visual-host-retention';
const projectId = 'project-retention';
const worktreeId = 'worktree-retention';

jest.mock('@/stores/chatStore', () => {
  const mockState = (): unknown => ({
    selectedWorktree: {
      projectId: 'project-retention',
      worktreeId: 'worktree-retention',
    },
    worktreeChats: {
      'project-retention/worktree-retention': {
        activeTabId: 'chat-visual-host-retention',
        tabs: [{ id: 'chat-visual-host-retention' }],
      },
    },
    pendingQuestions: {},
    pendingApprovals: {},
    runtimeByChatId: {},
  });
  return {
    useChatStore: (selector: (state: unknown) => unknown): unknown =>
      selector(mockState()),
    ...jest
      .requireActual<
        typeof ChatRenderStoresTestUtils
      >('@/test-utils/chatRenderStores')
      .mockChatRenderHooks(mockState),
  };
});

jest.mock('@/hooks/useInvocableInventory', () => ({
  useInvocableInventory: (): { entries: [] } => ({ entries: [] }),
}));

jest.mock('@/stores/fileListStore', () => ({
  getWorktreeCacheKey: (project: string, worktree: string): string =>
    `${project}/${worktree}`,
  useFileListStore: (
    selector: (state: {
      indexCache: Record<string, never>;
      indexErrors: Record<string, never>;
      indexLoading: Set<string>;
      fetchFileIndex: jest.Mock;
    }) => unknown,
  ): unknown =>
    selector({
      indexCache: {},
      indexErrors: {},
      indexLoading: new Set(),
      fetchFileIndex: jest.fn(),
    }),
}));

jest.mock('../ForkedFromLink', () => ({ ForkedFromLink: (): null => null }));
jest.mock('../TurnGroupRenderer', () => ({
  TurnGroupRenderer: (): null => null,
}));
jest.mock('../ChatMessageItem', () => ({ ChatMessageItem: (): null => null }));
jest.mock('../QueuedMessageBubble', () => ({
  QueuedMessageBubble: (): null => null,
}));
jest.mock('../QueuedMessageEditor', () => ({
  QueuedMessageEditor: (): null => null,
}));

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});
Object.assign(globalThis, { TextEncoder: NodeTextEncoder });

class TestResizeObserver implements ResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

function isGarbageCollector(value: unknown): value is () => void {
  return typeof value === 'function';
}

function garbageCollector(): () => void {
  setFlagsFromString('--expose-gc');
  const gc: unknown = runInNewContext('gc');
  if (!isGarbageCollector(gc)) throw new Error('gc is unavailable');
  return gc;
}

function transcript(): ChatMessage[] {
  return [
    {
      id: 'user-1',
      role: 'user',
      blocks: [{ type: 'text', text: 'Show me a chart' }],
      timestamp: 1,
    },
    {
      id: 'assistant-1',
      role: 'assistant',
      blocks: [{ type: 'text', text: 'Here it is.' }],
      timestamp: 2,
    },
  ];
}

let observedSource: ChatVisualsSource | null = null;

function SourceProbe({ sourceKey }: { sourceKey: string }): JSX.Element | null {
  observedSource = useChatVisualsSource(sourceKey);
  return null;
}

/** Mounts and unmounts a list, returning only a weak handle to its transcript. */
function mountAndClose(): WeakRef<ChatMessage[]> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  const messages = transcript();
  act(() => {
    // The list stops native tasks through the client (turn-state D5).
    root.render(
      <CanopyClientProvider client={ipcCanopyClient}>
        <ChatMessageList
          messages={messages}
          queuedMessages={[]}
          chatId={mockChatId}
          transcriptTurns={[]}
          onLoadTurn={(): Promise<void> => Promise.resolve()}
          targetOverride={{ projectId, worktreeId, chatId: mockChatId }}
          onClearQueuedMessage={(): void => undefined}
        />
      </CanopyClientProvider>,
    );
  });
  act(() => {
    root.unmount();
  });
  host.remove();
  return new WeakRef(messages);
}

async function collect(gc: () => void): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    // A WeakRef target stays alive until the current job ends.
    await new Promise((resolve) => setTimeout(resolve, 0));
    gc();
  }
}

beforeEach(() => {
  globalThis.ResizeObserver = TestResizeObserver;
  observedSource = null;
});

describe('ChatMessageList chat visual host retention', () => {
  it('keeps a closed chat visuals source without keeping its transcript', async () => {
    const gc = garbageCollector();
    const closedTranscript = mountAndClose();

    await collect(gc);

    expect(closedTranscript.deref()).toBeUndefined();

    const sourceKey = desktopChatVisualsKey({
      projectId,
      worktreeId,
      chatId: mockChatId,
    });
    const probeHost = document.createElement('div');
    const probeRoot = createRoot(probeHost);
    act(() => {
      probeRoot.render(<SourceProbe sourceKey={sourceKey} />);
    });
    expect(typeof observedSource?.host.expand).toBe('function');
    act(() => {
      probeRoot.unmount();
    });
  });
});
