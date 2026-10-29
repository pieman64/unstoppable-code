/**
 * @jest-environment jsdom
 *
 * Phase 12: received `chat:state-changed` events apply to the chat store on
 * arrival, in order; streamed content reaches React once per animation
 * frame, and user input, a hidden window and unsubscribe publish it sooner.
 */
import { act, Profiler, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useChatEventSubscriptions } from '../useChatEventSubscriptions';
import { chatStoreRenderView, useChatStore } from '@/stores/chatStore';
import { CHAT_RENDER_FRAME_FALLBACK_MS } from '@/stores/chat/frame-batched-store-view';
import type {
  ChatRuntimeState,
  ChatStateChangedEvent,
} from '@canopy/desktop-shared/types';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

const applied: number[] = [];
const rendered: (number | undefined)[] = [];
let commits = 0;

function runtime(
  status: ChatRuntimeState['status'],
  lastActivityAt: number,
): ChatRuntimeState {
  return { status, queuedMessageIds: [], lastActivityAt };
}

/** A provider commit: content plus an activity-only runtime patch. */
function contentEvent(revision: number): ChatStateChangedEvent {
  return {
    schemaVersion: 1,
    eventId: `event-${revision}`,
    occurredAt: '2026-10-01T00:00:00.000Z',
    projectId: 'project-1',
    worktreeId: 'worktree-1',
    baseRevision: revision - 1,
    revision,
    changes: [
      {
        type: 'message.upserted',
        chatId: 'chat',
        message: {
          id: 'reply',
          role: 'assistant',
          blocks: [{ type: 'text', text: `reply ${revision}` }],
          timestamp: revision,
        },
      },
      {
        type: 'runtime.patched',
        chatId: 'chat',
        runtime: runtime('streaming', revision),
      },
    ],
  };
}

/** A lifecycle commit: the turn completes. */
function completionEvent(revision: number): ChatStateChangedEvent {
  return {
    ...contentEvent(revision),
    changes: [
      {
        type: 'runtime.patched',
        chatId: 'chat',
        runtime: runtime('completed', revision),
      },
    ],
  };
}

function Probe(): JSX.Element | null {
  useChatEventSubscriptions();
  const activity = useChatStore(
    (state) => state.runtimeByChatId.chat?.lastActivityAt,
  );
  rendered.push(activity);
  return null;
}

describe('useChatEventSubscriptions render cadence', () => {
  let container: HTMLDivElement;
  let root: Root;
  let originalApi: Window['api'] | undefined;
  let stateHandler: ((event: ChatStateChangedEvent) => void) | null;
  const frames = new Map<number, FrameRequestCallback>();
  let nextFrame = 1;
  let visibility: DocumentVisibilityState = 'visible';
  const unsubscribeState = jest.fn();

  function runFrame(): void {
    act(() => {
      const callbacks = Array.from(frames.values());
      frames.clear();
      for (const callback of callbacks) callback(performance.now());
    });
  }

  function receive(event: ChatStateChangedEvent): void {
    act(() => {
      if (!stateHandler) throw new Error('state listener not registered');
      stateHandler(event);
    });
  }

  beforeEach(() => {
    jest.useFakeTimers();
    applied.length = 0;
    rendered.length = 0;
    commits = 0;
    frames.clear();
    stateHandler = null;
    visibility = 'visible';
    unsubscribeState.mockClear();
    jest
      .spyOn(window, 'requestAnimationFrame')
      .mockImplementation((callback: FrameRequestCallback): number => {
        const handle = nextFrame++;
        frames.set(handle, callback);
        return handle;
      });
    jest
      .spyOn(window, 'cancelAnimationFrame')
      .mockImplementation((handle: number): void => {
        frames.delete(handle);
      });
    jest
      .spyOn(document, 'visibilityState', 'get')
      .mockImplementation(() => visibility);
    useChatStore.setState({
      pendingApprovals: {},
      worktreeChats: {},
      runtimeByChatId: { chat: runtime('streaming', 1) },
      // Stand-in for the revisioned apply: record order, write the runtime.
      handleChatStateChanged: (event: ChatStateChangedEvent): void => {
        applied.push(event.revision);
        for (const change of event.changes) {
          if (change.type !== 'runtime.patched') continue;
          useChatStore.setState((state) => ({
            runtimeByChatId: {
              ...state.runtimeByChatId,
              [change.chatId]: change.runtime,
            },
          }));
        }
      },
      verifyStreamingTabs: (): Promise<void> => Promise.resolve(),
    });
    originalApi = window.api;
    const subscribe = jest.fn(() => jest.fn());
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        approvals: {
          pendingRequests: jest.fn().mockResolvedValue([]),
          onRequest: subscribe,
          onCancelled: subscribe,
          onAutoResolved: subscribe,
          onRuleAdded: subscribe,
        },
        chat: {
          onStateChanged: jest.fn(
            (handler: (event: ChatStateChangedEvent) => void) => {
              stateHandler = handler;
              return unsubscribeState;
            },
          ),
          onChatQueueUpdated: subscribe,
          onChatEvent: subscribe,
          onScheduledTerminalPrompt: subscribe,
          onHookTabStarted: subscribe,
          onChatSessionImported: subscribe,
          onMcpAskUser: subscribe,
          onMcpExpireAskUser: subscribe,
          onPlanExitRequest: subscribe,
          onTabDescriptionUpdated: subscribe,
          onDeferredToolsReloadEvent: subscribe,
          getTransientRetrySnapshot: jest.fn().mockResolvedValue([]),
        },
      },
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root.render(
        <Profiler
          id="probe"
          onRender={(): void => {
            commits += 1;
          }}
        >
          <Probe />
        </Profiler>,
      );
    });
    rendered.length = 0;
    commits = 0;
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    jest.useRealTimers();
    jest.restoreAllMocks();
    if (originalApi === undefined) {
      Reflect.deleteProperty(window, 'api');
    } else {
      Object.defineProperty(window, 'api', {
        configurable: true,
        value: originalApi,
      });
    }
  });

  it('applies streamed content to the store on arrival and renders it once per frame', () => {
    receive(contentEvent(2));
    receive(contentEvent(3));
    receive(contentEvent(4));

    expect(applied).toEqual([2, 3, 4]);
    expect(useChatStore.getState().runtimeByChatId.chat?.lastActivityAt).toBe(
      4,
    );
    expect(rendered).toEqual([]);
    expect(commits).toBe(0);
    expect(frames.size).toBe(1);

    runFrame();

    expect(rendered).toEqual([4]);
    expect(commits).toBe(1);
    expect(chatStoreRenderView.getState()).toBe(useChatStore.getState());
  });

  it('renders a lifecycle change at once, with the content before it', () => {
    receive(contentEvent(2));
    receive(completionEvent(3));

    expect(applied).toEqual([2, 3]);
    expect(rendered).toEqual([3]);
    expect(commits).toBe(1);
    expect(frames.size).toBe(0);
  });

  it('publishes before user input, on the fallback timer, and while hidden', () => {
    receive(contentEvent(2));
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    });
    expect(rendered).toEqual([2]);

    receive(contentEvent(3));
    act(() => {
      window.dispatchEvent(new Event('pointerdown'));
    });
    expect(rendered).toEqual([2, 3]);

    receive(contentEvent(4));
    act(() => {
      jest.advanceTimersByTime(CHAT_RENDER_FRAME_FALLBACK_MS);
    });
    expect(rendered).toEqual([2, 3, 4]);

    receive(contentEvent(5));
    visibility = 'hidden';
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(rendered).toEqual([2, 3, 4, 5]);

    receive(contentEvent(6));
    expect(rendered).toEqual([2, 3, 4, 5, 6]);
    expect(frames.size).toBe(0);
  });

  it('lets a React input handler see pending streamed content, even for a dispatched event', () => {
    const seen: (number | undefined)[] = [];
    function InputProbe(): JSX.Element {
      useChatEventSubscriptions();
      const activity = useChatStore(
        (state) => state.runtimeByChatId.chat?.lastActivityAt,
      );
      return (
        <input
          onKeyDown={(): void => {
            seen.push(activity);
          }}
          onPointerDown={(): void => {
            seen.push(activity);
          }}
        />
      );
    }
    act(() => {
      root.render(<InputProbe />);
    });
    const input = container.querySelector('input');
    if (!input) throw new Error('input not rendered');

    // An event dispatched from code gets no microtask checkpoint between the
    // window's capture listener and React's handler, so the capture listener
    // must commit the pending render itself.
    receive(contentEvent(2));
    expect(chatStoreRenderView.hasPendingNotification()).toBe(true);
    act(() => {
      input.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'a', bubbles: true }),
      );
    });
    receive(contentEvent(3));
    act(() => {
      input.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    });

    expect(seen).toEqual([2, 3]);
    expect(chatStoreRenderView.hasPendingNotification()).toBe(false);
  });

  it('publishes pending content on unsubscribe', () => {
    receive(contentEvent(2));
    expect(chatStoreRenderView.hasPendingNotification()).toBe(true);

    act(() => {
      root.unmount();
    });
    root = createRoot(container);

    expect(unsubscribeState).toHaveBeenCalledTimes(1);
    expect(chatStoreRenderView.hasPendingNotification()).toBe(false);
    expect(chatStoreRenderView.getState()).toBe(useChatStore.getState());
  });
});
