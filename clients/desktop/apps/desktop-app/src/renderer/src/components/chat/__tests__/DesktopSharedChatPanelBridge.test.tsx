/** @jest-environment jsdom */
import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  CanopyClientProvider,
  useChatStore,
  type ChatThreadState,
} from '@canopy/app-state';
import type {
  CanopyCapabilities,
  CanopyClient,
  CommandMap,
  CommandName,
  QueryMap,
  QueryName,
  Unsubscribe,
} from '@canopy/app-core';
import type { WorktreeSelection } from '@canopy/desktop-shared/types';

jest.mock('@/components/chat/ChatInput', () => ({
  ChatInput: (): JSX.Element => <div />,
}));
jest.mock('@/components/chat/ChatContent', () => ({
  ChatContent: (): JSX.Element => <div />,
}));
jest.mock('@/components/chat/ClaudeCodeTerminalExperience', () => ({
  ClaudeCodeTerminalExperience: (): JSX.Element => <div />,
}));

import { DesktopSharedChatPanelBridge } from '../WorktreeChatSurface';
import type { ActiveComposerView, ActiveTranscriptView } from '../types';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

const selection: WorktreeSelection = {
  projectId: 'project-1',
  worktreeId: 'worktree-1',
};

function mockCanopyClient(): CanopyClient {
  const capabilities: CanopyCapabilities = {
    localExecution: true,
    terminalPty: true,
    fileSystemAccess: 'read-write',
    voice: true,
    settingsScope: 'full',
    pipelines: 'execute',
    routing: 'in-memory',
  };
  return {
    capabilities,
    query<K extends QueryName>(): Promise<QueryMap[K]['result']> {
      return Promise.reject(new Error('unused'));
    },
    command<K extends CommandName>(): Promise<CommandMap[K]['result']> {
      return Promise.reject(new Error('unused'));
    },
    subscribe(): Unsubscribe {
      return (): void => {};
    },
  };
}

const client = mockCanopyClient();

function composer(
  overrides: Partial<ActiveComposerView> = {},
): ActiveComposerView {
  return {
    id: 'chat-1',
    title: 'Chat',
    status: 'streaming',
    error: null,
    planMode: true,
    proposalMode: 'required',
    thinkingLevel: 'max',
    modelConfig: { thinkingLevel: 'max', fastMode: false },
    hasStartedSession: true,
    shareSessionBusy: true,
    ...overrides,
  };
}

function transcript(
  messages: ActiveTranscriptView['messages'],
): ActiveTranscriptView {
  return {
    id: 'chat-1',
    messages,
    queuedMessages: [],
  };
}

let observedThread: ReturnType<typeof useThread>;

function useThread(chatId: string): ChatThreadState | undefined {
  return useChatStore((state) => state.threads[chatId]);
}

function StoreProbe({ chatId }: { chatId: string }): JSX.Element {
  observedThread = useThread(chatId);
  return <></>;
}

describe('DesktopSharedChatPanelBridge', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    observedThread = undefined;
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  // Phase 12 gates the transcript projection off while nothing on desktop
  // renders the shared thread (`shared-chat-projection-gate.ts`): the bridge
  // still synchronizes status and settings, but projects no messages.
  it('synchronizes live status and settings without projecting the gated transcript', () => {
    const onSend = jest.fn();
    const onStop = jest.fn();
    const firstTranscript = transcript([
      {
        id: 'message-1',
        role: 'user',
        blocks: [{ type: 'text', text: 'hello' }],
        timestamp: 1_000,
      },
    ]);

    act(() => {
      root.render(
        <CanopyClientProvider client={client}>
          <DesktopSharedChatPanelBridge
            chatId="chat-1"
            selectedWorktree={selection}
            transcript={firstTranscript}
            composerTab={composer()}
            onSend={onSend}
            onStop={onStop}
            renderTranscript={() => <div data-testid="native-transcript" />}
            renderComposer={(controls): JSX.Element => (
              <div>
                <button onClick={() => controls.onSend?.('routed')}>
                  send
                </button>
                <button onClick={controls.onStop}>stop</button>
              </div>
            )}
          />
          <StoreProbe chatId="chat-1" />
        </CanopyClientProvider>,
      );
    });

    expect(observedThread).toMatchObject({
      status: 'streaming',
      turnActive: true,
      planMode: true,
      proposalMode: 'required',
      thinkingLevel: 'max',
      route: {
        scope: 'worktree',
        workspaceLocalId: 'project-1',
        worktreeLocalId: 'worktree-1',
      },
      messages: [],
    });
    expect(
      host.querySelector('[data-testid="native-transcript"]'),
    ).not.toBeNull();

    act(() => {
      host.querySelectorAll('button')[0]?.click();
      host.querySelectorAll('button')[1]?.click();
    });
    expect(onSend).toHaveBeenCalledWith('routed');
    // The desktop adapter discards the shared `ChatPanelSendContext` (CAN-1429):
    // its text-only host callback is invoked with EXACTLY one argument, so the
    // widened shared `ChatPanel.onSend` never leaks a second arg into desktop.
    expect(onSend.mock.calls[0]).toEqual(['routed']);
    expect(onStop).toHaveBeenCalledTimes(1);

    act(() => {
      root.render(
        <CanopyClientProvider client={client}>
          <DesktopSharedChatPanelBridge
            chatId="chat-1"
            selectedWorktree={selection}
            transcript={transcript([])}
            composerTab={composer({
              status: 'idle',
              planMode: false,
              proposalMode: 'optional',
              thinkingLevel: 'high',
            })}
            onSend={onSend}
            onStop={onStop}
            renderTranscript={() => <div />}
            renderComposer={() => <div />}
          />
          <StoreProbe chatId="chat-1" />
        </CanopyClientProvider>,
      );
    });

    expect(observedThread).toMatchObject({
      status: 'idle',
      turnActive: false,
      planMode: false,
      proposalMode: 'optional',
      thinkingLevel: 'high',
      messages: [],
    });
  });
});
beforeAll(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
});
