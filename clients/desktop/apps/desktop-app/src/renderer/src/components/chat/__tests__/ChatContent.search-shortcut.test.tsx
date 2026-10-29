/**
 * @jest-environment jsdom
 */
import { act } from 'react';
import type * as ReactNamespace from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ChatContent } from '../ChatContent';
import { ChatMessageList } from '../ChatMessageList';
import { useSurfaceFindStore } from '@/stores/surfaceFindStore';
import { PanelHostContext } from '@/lib/panels/panel-host-context';
import { useCancelShortcutConfirmationStore } from '../useCancelRunningChatShortcut';
import type { ActiveComposerView, ActiveTranscriptView } from '../types';

const loadChatTranscriptPageMock = jest.fn();

jest.mock('@/stores/chat/transcript-pages', () => ({
  loadChatTranscriptPage: (...args: unknown[]): unknown =>
    loadChatTranscriptPageMock(...args),
  TRANSCRIPT_PAGE_LOAD_ERROR: "Couldn't load messages.",
}));

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

jest.mock('../ChatInput', () => {
  const react = jest.requireActual<typeof ReactNamespace>('react');
  return {
    ChatInput: jest.fn((): unknown =>
      react.createElement('div', { 'data-testid': 'mock-chat-input' }),
    ),
  };
});

jest.mock('../ChatMessageList', () => {
  const react = jest.requireActual<typeof ReactNamespace>('react');
  return {
    ChatMessageList: jest.fn(
      ({ pagingControls }: { pagingControls?: ReactNamespace.ReactNode }) =>
        react.createElement(
          'div',
          { 'data-testid': 'mock-message-list' },
          pagingControls,
        ),
    ),
  };
});

const mockExecutors: Array<{ clearHighlights: jest.Mock }> = [];

jest.mock('@/lib/dom-search-highlight', () => ({
  createDomSearchExecutor: jest.fn(() => {
    const executor = {
      findMatches: jest.fn(() => 0),
      clearHighlights: jest.fn(),
      setActiveMatch: jest.fn(),
      scrollToMatch: jest.fn(),
    };
    mockExecutors.push(executor);
    return executor;
  }),
}));

const transcript: ActiveTranscriptView = {
  id: 'chat-1',
  messages: [
    {
      id: 'message-1',
      role: 'user',
      blocks: [{ type: 'text', text: 'hello' }],
      timestamp: 0,
    },
  ],
  queuedMessages: [],
};

const streamingComposer: ActiveComposerView = {
  id: 'chat-1',
  title: 'Chat',
  status: 'streaming',
  error: null,
  planMode: false,
  proposalMode: 'optional',
  thinkingLevel: 'high',
  modelConfig: { thinkingLevel: 'high', fastMode: false },
  hasStartedSession: true,
};

function cmdF(): KeyboardEvent {
  return new KeyboardEvent('keydown', {
    key: 'f',
    metaKey: true,
    bubbles: true,
    cancelable: true,
  });
}

describe('ChatContent search shortcut focus gating', () => {
  let container: HTMLDivElement;
  let root: Root;
  let hasFocus: jest.Mock<boolean, []>;

  beforeEach(() => {
    useCancelShortcutConfirmationStore.getState().setArmedChatKey(null);
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    hasFocus = jest.fn(() => true);
    loadChatTranscriptPageMock.mockReset().mockResolvedValue(undefined);
    Object.defineProperty(document, 'hasFocus', {
      configurable: true,
      value: hasFocus,
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    useSurfaceFindStore.getState().close();
  });

  async function render(
    searchShortcutActive = true,
    findSurfaceVisible?: boolean,
  ): Promise<void> {
    act(() => {
      root.render(
        <ChatContent
          transcript={transcript}
          composerTab={null}
          onClearQueuedMessage={jest.fn()}
          searchShortcutActive={searchShortcutActive}
          {...(findSurfaceVisible === undefined ? {} : { findSurfaceVisible })}
        />,
      );
    });
    await act(async () => {});
  }

  function lastListProps(): { searchActive?: boolean } | undefined {
    return jest.mocked(ChatMessageList).mock.calls.at(-1)?.[0];
  }

  it('leaves Cmd+F to the shared find bar instead of an inline tray', async () => {
    await render();

    const event = cmdF();
    act(() => {
      document.dispatchEvent(event);
    });

    expect(event.defaultPrevented).toBe(false);
    expect(container.querySelector('[data-testid="content-search-bar"]')).toBe(
      null,
    );
    const marker = container.querySelector('[data-find-surface="chat"]');
    expect(marker?.getAttribute('data-find-scope')).toBe('chat-1');
  });

  it('titles the chat scope from its tab title, or Chat without one', async () => {
    await render(true);
    expect(
      useSurfaceFindStore.getState().controllers['chat:chat-1']?.title,
    ).toBe('Chat');

    act(() => {
      root.render(
        <ChatContent
          transcript={transcript}
          composerTab={{ ...streamingComposer, title: 'Plan the launch' }}
          onClearQueuedMessage={jest.fn()}
          searchShortcutActive
        />,
      );
    });
    await act(async () => {});
    expect(
      useSurfaceFindStore.getState().controllers['chat:chat-1']?.title,
    ).toBe('Plan the launch');
  });

  it('registers a find controller while the surface is shown, active or not', async () => {
    let registrations = 0;
    const unsubscribe = useSurfaceFindStore.subscribe((state, previous) => {
      if (
        Object.keys(state.controllers).length >
        Object.keys(previous.controllers).length
      ) {
        registrations += 1;
      }
    });
    // Off screen (another tab of its group): not searchable.
    await render(false, false);
    expect(useSurfaceFindStore.getState().hasController('chat', 'chat-1')).toBe(
      false,
    );

    // Shown beside the active browser group: searchable, so the bar can
    // offer the chat toggle without the user clicking into the chat first.
    await render(false, true);
    expect(useSurfaceFindStore.getState().hasController('chat', 'chat-1')).toBe(
      true,
    );
    // Becoming the active panel changes nothing about registration.
    await render(true, true);
    expect(registrations).toBe(1);

    // Without the visibility bit, activity still decides (single-instance
    // hosts pass neither and register from the default).
    await render(false);
    expect(useSurfaceFindStore.getState().hasController('chat', 'chat-1')).toBe(
      false,
    );
    unsubscribe();
  });

  it('marks the list searched while the bar targets this chat and clears on close', async () => {
    await render();
    expect(lastListProps()?.searchActive).toBe(false);

    act(() => {
      useSurfaceFindStore.getState().openFor('chat', 'chat-1');
    });
    expect(lastListProps()?.searchActive).toBe(true);

    const executor = mockExecutors.at(-1);
    act(() => {
      useSurfaceFindStore.getState().close();
    });
    expect(lastListProps()?.searchActive).toBe(false);
    expect(executor?.clearHighlights).toHaveBeenCalled();
  });

  it('returns focus to the transcript host when the bar closes without an opener', async () => {
    await render();
    act(() => {
      useSurfaceFindStore.getState().openFor('chat', 'chat-1');
    });
    act(() => {
      useSurfaceFindStore.getState().close();
    });
    const anchor = container.querySelector(
      '[data-find-surface="chat"]',
    )?.firstElementChild;
    expect(anchor).not.toBeNull();
    expect(document.activeElement).toBe(anchor);
  });

  it('closes the bar when the searched chat stops being active', async () => {
    await render();
    act(() => {
      useSurfaceFindStore.getState().openFor('chat', 'chat-1');
    });
    expect(useSurfaceFindStore.getState().open).toBe(true);

    await render(false);
    expect(useSurfaceFindStore.getState().open).toBe(false);
  });

  it('closes the bar when the main page hosting the chat is hidden', async () => {
    const renderInHost = async (visible: boolean): Promise<void> => {
      act(() => {
        root.render(
          <PanelHostContext.Provider
            value={{ viewMode: 'list', viewModeReady: true, visible }}
          >
            <ChatContent
              transcript={transcript}
              composerTab={null}
              onClearQueuedMessage={jest.fn()}
              searchShortcutActive
            />
          </PanelHostContext.Provider>,
        );
      });
      await act(async () => {});
    };
    await renderInHost(true);
    act(() => {
      useSurfaceFindStore.getState().openFor('chat', 'chat-1');
    });
    expect(useSurfaceFindStore.getState().open).toBe(true);

    // Navigating to Home hides MainPage without unmounting the chat.
    await renderInHost(false);
    expect(useSurfaceFindStore.getState().open).toBe(false);
    expect(useSurfaceFindStore.getState().hasController('chat', 'chat-1')).toBe(
      false,
    );
  });

  it('centers a shared onboarding host in an empty chat instead of the default hint', () => {
    act(() => {
      root.render(
        <ChatContent
          transcript={{ ...transcript, messages: [] }}
          composerTab={null}
          onClearQueuedMessage={jest.fn()}
          emptyStateCenter={
            <div data-testid="shared-onboarding">Getting started</div>
          }
        />,
      );
    });
    expect(
      container.querySelector('[data-testid="shared-onboarding"]'),
    ).not.toBeNull();
    expect(container.textContent).not.toContain(
      'Send a message to start working',
    );
  });

  it.each([
    { name: 'bounded raw page', view: undefined, before: 10, reload: true },
    {
      name: 'complete raw page',
      view: undefined,
      before: undefined,
      reload: false,
    },
    {
      name: 'turn-aware page',
      view: 'turns' as const,
      before: 10,
      reload: false,
    },
  ])(
    'retains turn framing for a loaded $name',
    async ({ view, before, reload }) => {
      // Raw tail pages can omit the owning prompt and timer. Upgrade those to
      // the turn-aware view; complete and already framed pages need no reread.
      const loadedTranscript: ActiveTranscriptView = {
        ...transcript,
        transcript: {
          format: 'complete-message-jsonl-v1',
          committedMessageCount: 1,
          committedByteLength: 100,
          transcriptRevision: 3,
          hasActiveSidecar: false,
        },
        transcriptLoaded: true,
        transcriptWindow: {
          view,
          before,
          totalMessages: 500,
          transcriptRevision: 3,
        },
      };

      act(() => {
        root.render(
          <ChatContent
            transcript={loadedTranscript}
            composerTab={null}
            onClearQueuedMessage={jest.fn()}
            targetOverride={{
              projectId: 'p',
              worktreeId: 'w',
              chatId: 'chat-1',
            }}
          />,
        );
      });
      await act(async () => {
        await Promise.resolve();
      });

      expect(loadChatTranscriptPageMock).toHaveBeenCalledTimes(reload ? 1 : 0);
    },
  );

  it('hides transcript page failure details behind the canonical retry copy', async () => {
    let rejectLoad: ((reason?: unknown) => void) | undefined;
    loadChatTranscriptPageMock.mockReturnValue(
      new Promise<void>((_resolve, reject) => {
        rejectLoad = reject;
      }),
    );
    const pagedTranscript: ActiveTranscriptView = {
      ...transcript,
      transcriptLoaded: false,
    };

    act(() => {
      root.render(
        <ChatContent
          transcript={pagedTranscript}
          composerTab={null}
          onClearQueuedMessage={jest.fn()}
          targetOverride={{ projectId: 'p', worktreeId: 'w', chatId: 'chat-1' }}
        />,
      );
    });
    await act(async () => {
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(loadChatTranscriptPageMock).toHaveBeenCalled();
    const reject = rejectLoad;
    if (!reject) throw new Error('Missing transcript page rejection');
    await act(async () => {
      reject(new Error('private backend transcript detail'));
      await Promise.resolve();
    });
    expect(container.textContent).toContain("Couldn't load messages.");
    expect(container.textContent).not.toContain(
      'private backend transcript detail',
    );
  });

  it('does not arm cancellation from outside its own chat surface', async () => {
    const outside = document.createElement('button');
    document.body.append(outside);
    act(() => {
      root.render(
        <ChatContent
          transcript={transcript}
          composerTab={streamingComposer}
          onClearQueuedMessage={jest.fn()}
          targetOverride={{
            projectId: 'pipeline-editor',
            worktreeId: 'pipeline-editor',
            chatId: 'chat-1',
          }}
        />,
      );
    });
    await act(async () => {});

    act(() => {
      outside.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Escape',
          bubbles: true,
          cancelable: true,
        }),
      );
    });

    expect(
      useCancelShortcutConfirmationStore.getState().armedChatKey,
    ).toBeNull();
    outside.remove();
  });
});
