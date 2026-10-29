/** @jest-environment jsdom */

/**
 * The started aggregator end to end: the window timer, the preload send, the
 * long-animation-frame observer, the interest subscription, the remote
 * window flag, and the terminal client counting a delivery once.
 */
import type { TerminalOutputEvent } from '@canopy/protocol/terminal';
import type { ChatEvent } from '@canopy/desktop-shared/types';
import type { RendererDiagnosticsSummary } from '@canopy/desktop-shared/types/observability';
import type { ChatInterest, ChatInterestListener } from '@/lib/chat-interest';
import { ipcTerminalClient } from '@/client/ipc-terminal-client';
import {
  recordChatEventApplied,
  recordTerminalOutputApplied,
  startRendererDiagnostics,
} from '..';
import { RENDERER_DIAGNOSTICS_WINDOW_MS } from '../aggregator';

let mockInterest: ChatInterest | null = null;
const mockInterestListeners = new Set<ChatInterestListener>();

jest.mock('@/lib/chat-interest', () => ({
  getChatInterest: (): ChatInterest | null => mockInterest,
  subscribeChatInterest: (listener: ChatInterestListener): (() => void) => {
    mockInterestListeners.add(listener);
    return (): void => {
      mockInterestListeners.delete(listener);
    };
  },
}));

const recordRendererSummary = jest.fn<void, [RendererDiagnosticsSummary]>();
const outputListeners = new Set<(event: TerminalOutputEvent) => void>();
let remoteMode: 'local' | 'remote' = 'local';

class FakePerformanceObserver {
  static supportedEntryTypes: readonly string[] = ['long-animation-frame'];
  static instances: FakePerformanceObserver[] = [];
  readonly observe = jest.fn();
  readonly disconnect = jest.fn();
  constructor(
    readonly callback: (list: { getEntries: () => unknown[] }) => void,
  ) {
    FakePerformanceObserver.instances.push(this);
  }
  emit(entries: unknown[]): void {
    this.callback({ getEntries: () => entries });
  }
}

function setVisibility(state: DocumentVisibilityState): void {
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => state,
  });
}

function chatEvent(chatId: string): ChatEvent {
  return { projectId: 'p', worktreeId: 'w', chatId, data: { type: 'x' } };
}

let stop: (() => void) | null = null;

beforeEach(() => {
  jest.useFakeTimers();
  mockInterest = null;
  mockInterestListeners.clear();
  outputListeners.clear();
  recordRendererSummary.mockClear();
  FakePerformanceObserver.instances = [];
  remoteMode = 'local';
  setVisibility('visible');
  Object.defineProperty(window, 'PerformanceObserver', {
    configurable: true,
    writable: true,
    value: FakePerformanceObserver,
  });
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      observability: { recordRendererSummary },
      remoteControl: {
        getContext: () =>
          remoteMode === 'remote'
            ? {
                mode: 'remote',
                deviceId: 'd',
                name: 'n',
                platform: 'darwin',
              }
            : { mode: 'local' },
      },
      terminal: {
        onOutput: (listener: (event: TerminalOutputEvent) => void) => {
          outputListeners.add(listener);
          return (): void => {
            outputListeners.delete(listener);
          };
        },
      },
    },
  });
});

afterEach(() => {
  stop?.();
  stop = null;
  jest.useRealTimers();
});

function endWindow(): void {
  jest.advanceTimersByTime(RENDERER_DIAGNOSTICS_WINDOW_MS);
}

describe('startRendererDiagnostics', () => {
  it('sends one summary per window with data, and nothing otherwise', () => {
    stop = startRendererDiagnostics();
    endWindow();
    expect(recordRendererSummary).not.toHaveBeenCalled();

    recordChatEventApplied(chatEvent('a'), performance.now());
    endWindow();
    expect(recordRendererSummary).toHaveBeenCalledTimes(1);
    const summary = recordRendererSummary.mock.calls[0]?.[0];
    expect(summary?.remoteWindow).toBe(false);
    expect(summary?.windowMs).toBeGreaterThan(0);
    expect(summary?.chatEvent.onScreenEvents).toBe(1);

    endWindow();
    expect(recordRendererSummary).toHaveBeenCalledTimes(1);
  });

  it('sends nothing for a window that ends while hidden', () => {
    stop = startRendererDiagnostics();
    recordChatEventApplied(chatEvent('a'), performance.now());
    setVisibility('hidden');
    endWindow();
    setVisibility('visible');
    endWindow();
    expect(recordRendererSummary).not.toHaveBeenCalled();
  });

  it('marks a window that shows another computer', () => {
    remoteMode = 'remote';
    stop = startRendererDiagnostics();
    recordChatEventApplied(chatEvent('a'), performance.now());
    endWindow();
    expect(recordRendererSummary.mock.calls[0]?.[0].remoteWindow).toBe(true);
  });

  it('splits by the interest it subscribes to, including one set before start', () => {
    mockInterest = {
      focused: [{ projectId: 'p', worktreeId: 'w', chatId: 'a' }],
      warm: [],
    };
    stop = startRendererDiagnostics();
    recordChatEventApplied(chatEvent('a'), performance.now());
    recordChatEventApplied(chatEvent('b'), performance.now());
    const next: ChatInterest = {
      focused: [{ projectId: 'p', worktreeId: 'w', chatId: 'b' }],
      warm: [],
    };
    mockInterest = next;
    mockInterestListeners.forEach((listener) => listener(next));
    recordChatEventApplied(chatEvent('b'), performance.now());
    endWindow();
    const summary = recordRendererSummary.mock.calls[0]?.[0];
    expect(summary?.chatEvent.onScreenEvents).toBe(2);
    expect(summary?.chatEvent.offScreenEvents).toBe(1);
  });

  it('observes long animation frames without buffered entries', () => {
    stop = startRendererDiagnostics();
    const observer = FakePerformanceObserver.instances[0];
    expect(observer?.observe).toHaveBeenCalledWith({
      type: 'long-animation-frame',
      buffered: false,
    });
    observer?.emit([
      {
        duration: 120,
        blockingDuration: 70,
        scripts: [{ invokerType: 'event-listener' }],
      },
    ]);
    endWindow();
    expect(recordRendererSummary.mock.calls[0]?.[0].frames).toEqual({
      count: 1,
      p95Ms: 120,
      maxMs: 120,
      blockingMs: 70,
      invokers: { userCallback: 0, eventListener: 1, promise: 0, script: 0 },
    });
    stop();
    stop = null;
    expect(observer?.disconnect).toHaveBeenCalled();
  });

  it('skips the frame observer where long animation frames are unsupported', () => {
    FakePerformanceObserver.supportedEntryTypes = ['longtask'];
    try {
      stop = startRendererDiagnostics();
      expect(FakePerformanceObserver.instances).toEqual([]);
    } finally {
      FakePerformanceObserver.supportedEntryTypes = ['long-animation-frame'];
    }
  });

  it('counts a terminal delivery once with several subscribers', () => {
    stop = startRendererDiagnostics();
    const received: TerminalOutputEvent[] = [];
    const unsubscribers = [
      ipcTerminalClient.subscribe('terminal.output', (event) =>
        received.push(event),
      ),
      ipcTerminalClient.subscribe('terminal.output', (event) =>
        received.push(event),
      ),
      ipcTerminalClient.subscribe(
        'terminal.output',
        (event) => received.push(event),
        { projectId: 'other' },
      ),
    ];
    const deliver = (seq: number): void => {
      const event: TerminalOutputEvent = {
        projectId: 'p',
        worktreeId: 'w',
        terminalId: 't',
        data: new Uint8Array([seq]),
        seq,
      };
      outputListeners.forEach((listener) => listener(event));
    };
    deliver(1);
    deliver(2);
    unsubscribers.forEach((unsubscribe) => unsubscribe());
    endWindow();
    expect(received).toHaveLength(4);
    expect(recordRendererSummary.mock.calls[0]?.[0].terminal.deliveries).toBe(
      2,
    );
  });

  it('records nothing after it stops', () => {
    stop = startRendererDiagnostics();
    stop();
    stop = null;
    recordTerminalOutputApplied('t', 1, performance.now());
    endWindow();
    expect(recordRendererSummary).not.toHaveBeenCalled();
  });

  it('is idempotent while running', () => {
    stop = startRendererDiagnostics();
    expect(startRendererDiagnostics()).toBe(stop);
    expect(FakePerformanceObserver.instances).toHaveLength(1);
  });
});
