import type {
  ChatStateChange,
  ChatStateChangedEvent,
  TerminalOutputEvent,
} from '@canopy/desktop-shared/types';
import { IPC_CHANNELS } from '@canopy/desktop-shared/types';
import { ChatStateDelivery } from '../ipc/chat-state-delivery';
import {
  addRendererDeliveryBarrier,
  sendToWebContents,
} from '../lib/web-contents-send';
import {
  TERMINAL_OUTPUT_FRAME_BYTES,
  TERMINAL_OUTPUT_FRAME_MS,
  TerminalOutputDelivery,
} from '../terminal/output-delivery';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function outputEvents(terminalId = 'terminal-1'): {
  next(text: string): TerminalOutputEvent;
} {
  let seq = 0;
  return {
    next: (text): TerminalOutputEvent => {
      const data = encoder.encode(text);
      seq += data.length;
      return {
        projectId: 'project-1',
        worktreeId: 'wt-1',
        terminalId,
        data,
        seq,
      };
    },
  };
}

function setup(): {
  delivery: TerminalOutputDelivery;
  delivered: TerminalOutputEvent[];
  texts: () => string[];
} {
  const delivered: TerminalOutputEvent[] = [];
  const delivery = new TerminalOutputDelivery({
    deliver: (event): void => {
      delivered.push(event);
    },
    now: (): number => Date.now(),
    setTimer: (callback, delayMs): (() => void) => {
      const timer = setTimeout(callback, delayMs);
      return (): void => {
        clearTimeout(timer);
      };
    },
  });
  return {
    delivery,
    delivered,
    texts: () => delivered.map((event) => decoder.decode(event.data)),
  };
}

describe('TerminalOutputDelivery', () => {
  beforeEach(() => {
    jest.useFakeTimers({ now: 1_000_000 });
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it("sends a lone keystroke's echo at once, without waiting for a frame", () => {
    const { delivery, delivered, texts } = setup();
    const terminal = outputEvents();

    delivery.push(terminal.next('l'));
    expect(texts()).toEqual(['l']);

    // The next keystroke, a frame later, is also immediate.
    jest.advanceTimersByTime(TERMINAL_OUTPUT_FRAME_MS);
    delivery.push(terminal.next('s'));
    expect(texts()).toEqual(['l', 's']);
    expect(delivered.map((event) => event.seq)).toEqual([1, 2]);
  });

  it('coalesces a burst into one event per frame with the last seq', () => {
    const { delivery, delivered, texts } = setup();
    const terminal = outputEvents();
    const chunks = Array.from({ length: 50 }, (_, index) => `line ${index}\n`);

    for (const chunk of chunks.slice(0, 25))
      delivery.push(terminal.next(chunk));
    // The first goes at once; the rest wait for the frame to end.
    expect(delivered).toHaveLength(1);
    jest.advanceTimersByTime(TERMINAL_OUTPUT_FRAME_MS - 1);
    expect(delivered).toHaveLength(1);
    jest.advanceTimersByTime(1);
    expect(delivered).toHaveLength(2);

    for (const chunk of chunks.slice(25)) delivery.push(terminal.next(chunk));
    jest.advanceTimersByTime(TERMINAL_OUTPUT_FRAME_MS);
    expect(delivered).toHaveLength(3);

    // Exactly the bytes, in order, and seq is the byte count after each event.
    expect(texts().join('')).toBe(chunks.join(''));
    let bytes = 0;
    for (const event of delivered) {
      bytes += event.data.length;
      expect(event.seq).toBe(bytes);
    }
  });

  it('sends 64 KiB of held output without waiting for the frame', () => {
    const { delivery, delivered } = setup();
    const terminal = outputEvents();
    delivery.push(terminal.next('first'));
    const chunk = 'x'.repeat(8 * 1024);
    for (let index = 0; index < 8; index += 1)
      delivery.push(terminal.next(chunk));
    expect(delivered).toHaveLength(2);
    expect(delivered[1]?.data.length).toBe(TERMINAL_OUTPUT_FRAME_BYTES);
  });

  it('keeps terminals apart and sends held output before anything else', () => {
    const { delivery, delivered, texts } = setup();
    const first = outputEvents('terminal-1');
    const second = outputEvents('terminal-2');
    delivery.push(first.next('a1'));
    delivery.push(second.next('b1'));
    delivery.push(first.next('a2'));
    delivery.push(second.next('b2'));
    delivery.push(first.next('a3'));
    expect(texts()).toEqual(['a1', 'b1']);

    // A barrier (another message to the window) flushes everything held.
    delivery.flushAll();
    expect(texts()).toEqual(['a1', 'b1', 'a2a3', 'b2']);
    expect(delivered.map((event) => event.terminalId)).toEqual([
      'terminal-1',
      'terminal-2',
      'terminal-1',
      'terminal-2',
    ]);
    jest.advanceTimersByTime(TERMINAL_OUTPUT_FRAME_MS);
    expect(delivered).toHaveLength(4);
  });

  it('does not send other held output from inside its own send', () => {
    const delivered: string[] = [];
    const barrier = { flushes: false };
    const delivery = new TerminalOutputDelivery({
      deliver: (event): void => {
        // A barrier of this send (another projection flushing) runs first.
        if (barrier.flushes) delivery.flushAll();
        delivered.push(decoder.decode(event.data));
      },
      now: (): number => Date.now(),
      setTimer: (callback, delayMs): (() => void) => {
        const timer = setTimeout(callback, delayMs);
        return (): void => {
          clearTimeout(timer);
        };
      },
    });
    const first = outputEvents('terminal-1');
    const second = outputEvents('terminal-2');
    delivery.push(first.next('a1'));
    delivery.push(second.next('b1'));
    delivery.push(first.next('a2'));
    delivery.push(second.next('b2'));
    barrier.flushes = true;
    jest.advanceTimersByTime(TERMINAL_OUTPUT_FRAME_MS);
    expect(delivered).toEqual(['a1', 'b1', 'a2', 'b2']);
  });

  it('forgets an exited terminal after sending what it held', () => {
    const { delivery, texts } = setup();
    const terminal = outputEvents();
    delivery.push(terminal.next('a'));
    delivery.push(terminal.next('b'));
    delivery.forget('terminal-1');
    expect(texts()).toEqual(['a', 'b']);
    // A restarted terminal with the same id starts with an immediate send.
    delivery.push(outputEvents().next('c'));
    expect(texts()).toEqual(['a', 'b', 'c']);
  });
});

describe('TerminalOutputDelivery beside the chat state delivery', () => {
  const removals: Array<() => void> = [];
  beforeEach(() => {
    jest.useFakeTimers({ now: 1_000_000 });
  });
  afterEach(() => {
    removals.splice(0).forEach((remove) => {
      remove();
    });
    jest.useRealTimers();
  });

  function stateEvent(
    worktreeId: string,
    baseRevision: number,
    changes: ChatStateChange[],
  ): ChatStateChangedEvent {
    return {
      schemaVersion: 1,
      eventId: `${worktreeId}:${String(baseRevision + 1)}`,
      occurredAt: new Date(1_000_000).toISOString(),
      projectId: 'project-1',
      worktreeId,
      baseRevision,
      revision: baseRevision + 1,
      changes,
    };
  }

  function streaming(lastActivityAt: number): ChatStateChange {
    return {
      type: 'runtime.patched',
      chatId: 'chat-1',
      runtime: { status: 'streaming', queuedMessageIds: [], lastActivityAt },
    };
  }

  function upsert(text: string): ChatStateChange {
    return {
      type: 'message.upserted',
      chatId: 'chat-1',
      message: {
        id: 'assistant-1',
        role: 'assistant',
        blocks: [{ type: 'text', text }],
        timestamp: 2,
      },
    };
  }

  it('sends each held message once, in publication order, when the two release into each other', () => {
    const received: string[] = [];
    const win = {
      send: (channel: string, payload: unknown): void => {
        if (channel === IPC_CHANNELS.terminalOutput && isOutput(payload)) {
          received.push(`terminal ${decoder.decode(payload.data)}`);
        } else if (
          channel === IPC_CHANNELS.chatStateChanged &&
          isStateEvent(payload)
        ) {
          received.push(
            `state ${payload.worktreeId} r${String(payload.revision)}`,
          );
        } else {
          received.push(channel);
        }
      },
    };
    const setTimer = (callback: () => void, delayMs: number): (() => void) => {
      const timer = setTimeout(callback, delayMs);
      return (): void => {
        clearTimeout(timer);
      };
    };
    // Wired as main/ipc/chat-state.ts and main/ipc/terminal.ts wire them.
    const chat = new ChatStateDelivery<object>({
      deliver: (target, event): void => {
        sendToWebContents(win, IPC_CHANNELS.chatStateChanged, event);
      },
      setTimer,
      now: (): number => Date.now(),
    });
    removals.push(
      addRendererDeliveryBarrier((target, channel): void => {
        if (channel !== IPC_CHANNELS.chatStateChanged) chat.flushTarget(target);
      }),
    );
    const output = new TerminalOutputDelivery({
      deliver: (event): void => {
        sendToWebContents(win, IPC_CHANNELS.terminalOutput, event);
      },
      now: (): number => Date.now(),
      setTimer,
    });
    removals.push(
      addRendererDeliveryBarrier((_target, channel): void => {
        if (channel !== IPC_CHANNELS.terminalOutput) output.flushAll();
      }),
    );
    const terminal = outputEvents();

    chat.publish(stateEvent('A', 0, [streaming(0)]), [win]);
    chat.publish(stateEvent('B', 0, [streaming(0)]), [win]);
    jest.advanceTimersByTime(1);
    output.push(terminal.next('x'));
    jest.advanceTimersByTime(1);
    // Held: y until its frame ends, then A r2 and B r2 until their tick.
    output.push(terminal.next('y'));
    chat.publish(stateEvent('A', 1, [upsert('a'), streaming(1)]), [win]);
    chat.publish(stateEvent('B', 1, [upsert('b'), streaming(1)]), [win]);
    expect(received).toEqual(['state A r1', 'state B r1', 'terminal x']);

    jest.advanceTimersByTime(30);
    expect(received).toEqual([
      'state A r1',
      'state B r1',
      'terminal x',
      'terminal y',
      'state A r2',
      'state B r2',
    ]);
    chat.dispose();
    output.dispose();
  });

  it("delivers another window's held chat state before output released into it", () => {
    const received = new Map<string, string[]>();
    const windowNamed = (
      name: string,
    ): { send: (channel: string, payload: unknown) => void } => {
      const log: string[] = [];
      received.set(name, log);
      return {
        send: (channel, payload): void => {
          if (channel === IPC_CHANNELS.terminalOutput && isOutput(payload)) {
            log.push(`terminal ${decoder.decode(payload.data)}`);
          } else if (
            channel === IPC_CHANNELS.chatStateChanged &&
            isStateEvent(payload)
          ) {
            log.push(
              `state ${payload.worktreeId} r${String(payload.revision)}`,
            );
          } else {
            log.push(channel);
          }
        },
      };
    };
    const main = windowNamed('main');
    const advisor = windowNamed('advisor');
    const setTimer = (callback: () => void, delayMs: number): (() => void) => {
      const timer = setTimeout(callback, delayMs);
      return (): void => {
        clearTimeout(timer);
      };
    };
    const chat = new ChatStateDelivery<object>({
      deliver: (target, event): void => {
        sendToWebContents(target, IPC_CHANNELS.chatStateChanged, event);
      },
      setTimer,
      now: (): number => Date.now(),
    });
    removals.push(
      addRendererDeliveryBarrier((target, channel): void => {
        if (channel !== IPC_CHANNELS.chatStateChanged) chat.flushTarget(target);
      }),
    );
    // The terminal lives in the App Advisor window.
    const output = new TerminalOutputDelivery({
      deliver: (event): void => {
        sendToWebContents(advisor, IPC_CHANNELS.terminalOutput, event);
      },
      now: (): number => Date.now(),
      setTimer,
    });
    removals.push(
      addRendererDeliveryBarrier((_target, channel): void => {
        if (channel !== IPC_CHANNELS.terminalOutput) output.flushAll();
      }),
    );
    const terminal = outputEvents();

    chat.publish(stateEvent('B', 0, [streaming(0)]), [advisor]);
    output.push(terminal.next('x'));
    jest.advanceTimersByTime(1);
    // Both held for the advisor: its chat state first, then terminal output.
    chat.publish(stateEvent('B', 1, [upsert('b'), streaming(1)]), [advisor]);
    jest.advanceTimersByTime(1);
    output.push(terminal.next('y'));
    jest.advanceTimersByTime(1);
    // A message to the main window releases the held output into the
    // advisor, which must first receive the chat state published before it.
    chat.publish(stateEvent('A', 0, [streaming(0)]), [main]);

    expect(received.get('main')).toEqual(['state A r1']);
    expect(received.get('advisor')).toEqual([
      'state B r1',
      'terminal x',
      'state B r2',
      'terminal y',
    ]);
    chat.dispose();
    output.dispose();
  });
});

function isOutput(value: unknown): value is TerminalOutputEvent {
  return typeof value === 'object' && value !== null && 'data' in value;
}

function isStateEvent(value: unknown): value is ChatStateChangedEvent {
  return typeof value === 'object' && value !== null && 'revision' in value;
}
