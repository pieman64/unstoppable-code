import {
  parseSseFrames,
  runPortalCommandSseTransport,
  type PortalCommandSseDeps,
} from '../command-sse-transport';

function sseResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller): void {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
  return new Response(stream);
}

/** A stream that errors mid-read, so `consumeStream` throws rather than ending. */
function failingStreamResponse(error: Error): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller): void {
      controller.error(error);
    },
  });
  return new Response(stream);
}

const POLL_FRAME = (seq: number): string =>
  `id: ${seq}\nevent: poll\ndata: ${JSON.stringify({
    session: { status: 'active', connectionStatus: 'active' },
    commands: [],
    nextCursor: seq,
  })}\n\n`;

interface Harness {
  deps: PortalCommandSseDeps;
  openCalls: number;
  pollData: string[];
  networkFailures: number;
  inactiveCalls: number;
  delays: number[];
  armTimeoutMs: number[];
  clock: number;
  clockStep: number;
  abort: () => void;
}

function makeHarness(overrides: Partial<PortalCommandSseDeps> = {}): Harness {
  let aborted = false;
  const harness: Harness = {
    openCalls: 0,
    pollData: [],
    networkFailures: 0,
    inactiveCalls: 0,
    delays: [],
    armTimeoutMs: [],
    // A monotonic clock that advances clockStep on each read; default makes
    // every connection "healthy" (duration >= minHealthyConnectionMs).
    clock: 0,
    clockStep: 5_000,
    abort: (): void => {
      aborted = true;
    },
    deps: {
      isAborted: (): boolean => aborted,
      getSessionId: (): string | null => 'session-1',
      getCursor: (): number => 0,
      openStream: (): Promise<Response> => {
        harness.openCalls += 1;
        return Promise.resolve(sseResponse([POLL_FRAME(1)]));
      },
      onPollFrame: (data): Promise<'ok' | 'stopped'> => {
        harness.pollData.push(data);
        return Promise.resolve('ok');
      },
      classifyErrorFrame: (): 'terminal' | 'transient' => 'transient',
      flushOutbox: (): Promise<void> => Promise.resolve(),
      onNetworkFailure: (): void => {
        harness.networkFailures += 1;
      },
      isInactiveSessionError: (): boolean => false,
      onInactiveSessionResponse: (): Promise<'revived' | 'terminal'> => {
        harness.inactiveCalls += 1;
        return Promise.resolve('terminal');
      },
      is404: (): boolean => false,
      delay: (ms): Promise<void> => {
        harness.delays.push(ms);
        return Promise.resolve();
      },
      now: (): number => {
        const value = harness.clock;
        harness.clock += harness.clockStep;
        return value;
      },
      connectTimeoutMs: 30_000,
      armTimeout: (ms): (() => void) => {
        harness.armTimeoutMs.push(ms);
        // Default: never fires; return a no-op cancel.
        return (): void => undefined;
      },
      setAbortController: (): void => undefined,
      backoffMs: [1, 2, 3],
      maxImmediateFailures: 3,
      minHealthyConnectionMs: 1_000,
      idleTimeoutMs: 60_000,
      ...overrides,
    },
  };
  return harness;
}

describe('parseSseFrames', () => {
  it('parses id/event/data and strips one leading space', () => {
    const { frames, remainder } = parseSseFrames(
      'id: 7\nevent: poll\ndata: {"a":1}\n\n',
    );
    expect(remainder).toBe('');
    expect(frames).toEqual([{ id: '7', event: 'poll', data: '{"a":1}' }]);
  });

  it('joins multi-line data and ignores comments/keepalive', () => {
    const { frames } = parseSseFrames(
      ': keepalive\n\nevent: poll\ndata: line1\ndata: line2\n\n',
    );
    expect(frames).toEqual([{ id: null, event: 'poll', data: 'line1\nline2' }]);
  });

  it('returns the unterminated remainder for the next chunk', () => {
    const { frames, remainder } = parseSseFrames(
      'event: poll\ndata: whole\n\nevent: poll\ndata: par',
    );
    expect(frames).toHaveLength(1);
    expect(remainder).toBe('event: poll\ndata: par');
  });

  it('handles CRLF line endings', () => {
    const { frames } = parseSseFrames('event: poll\r\ndata: x\r\n\r\n');
    expect(frames).toEqual([{ id: null, event: 'poll', data: 'x' }]);
  });
});

describe('runPortalCommandSseTransport', () => {
  it('delivers poll frames then stops when aborted mid-stream', async () => {
    const harness = makeHarness();
    // Deliver one frame, then abort so consumeStream exits promptly.
    harness.deps.onPollFrame = (data): Promise<'ok' | 'stopped'> => {
      harness.pollData.push(data);
      harness.abort();
      return Promise.resolve('ok');
    };

    const outcome = await runPortalCommandSseTransport(harness.deps);
    expect(outcome).toBe('stopped');
    expect(harness.pollData).toHaveLength(1);
    const parsed: unknown = JSON.parse(harness.pollData[0]);
    expect(parsed).toMatchObject({ nextCursor: 1 });
    expect(harness.openCalls).toBe(1);
  });

  it('falls back immediately when the endpoint is 404', async () => {
    const harness = makeHarness({
      openStream: (): Promise<Response> =>
        Promise.reject(new Error('not found')),
      is404: (): boolean => true,
    });
    const outcome = await runPortalCommandSseTransport(harness.deps);
    expect(outcome).toBe('fallback');
  });

  it('falls back after repeated immediate failures', async () => {
    let opens = 0;
    const harness = makeHarness({
      openStream: (): Promise<Response> => {
        opens += 1;
        return Promise.reject(new Error('boom'));
      },
    });
    const outcome = await runPortalCommandSseTransport(harness.deps);
    expect(outcome).toBe('fallback');
    // maxImmediateFailures = 3
    expect(opens).toBe(3);
    expect(harness.networkFailures).toBe(3);
  });

  it('aborts and falls back when the connection watchdog fires', async () => {
    const captured: {
      fireConnectWatchdog: (() => void) | null;
      signal: AbortSignal | null;
    } = { fireConnectWatchdog: null, signal: null };
    const harness = makeHarness({
      maxImmediateFailures: 1,
      openStream: (input): Promise<Response> => {
        captured.signal = input.signal;
        return new Promise<Response>((_resolve, reject) => {
          input.signal.addEventListener(
            'abort',
            () => reject(new DOMException('Aborted', 'AbortError')),
            { once: true },
          );
        });
      },
      armTimeout: (ms, onFire): (() => void) => {
        if (ms === 30_000) {
          captured.fireConnectWatchdog = onFire;
        }
        return (): void => undefined;
      },
    });

    const outcomePromise = runPortalCommandSseTransport(harness.deps);
    await Promise.resolve();
    captured.fireConnectWatchdog?.();

    await expect(outcomePromise).resolves.toBe('fallback');
    expect(captured.signal?.aborted).toBe(true);
    expect(harness.networkFailures).toBe(1);
  });

  it('cancels the connection watchdog after openStream resolves', async () => {
    let connectWatchdogCancelled = false;
    const harness = makeHarness({
      armTimeout: (ms): (() => void) => {
        if (ms !== 30_000) {
          return (): void => undefined;
        }
        return (): void => {
          connectWatchdogCancelled = true;
        };
      },
    });
    harness.deps.onPollFrame = (): Promise<'ok' | 'stopped'> => {
      harness.abort();
      return Promise.resolve('ok');
    };

    await runPortalCommandSseTransport(harness.deps);

    expect(connectWatchdogCancelled).toBe(true);
  });

  it('backs off and falls back when a received poll frame fails to apply', async () => {
    const harness = makeHarness({ maxImmediateFailures: 2 });
    let applyCalls = 0;
    harness.deps.openStream = (): Promise<Response> => {
      harness.openCalls += 1;
      return harness.openCalls === 1
        ? Promise.resolve(sseResponse([POLL_FRAME(1), POLL_FRAME(2)]))
        : Promise.reject(new Error('reconnect failed'));
    };
    harness.deps.onPollFrame = (): Promise<'ok' | 'stopped'> => {
      applyCalls += 1;
      return applyCalls === 1
        ? Promise.resolve('ok')
        : Promise.reject(new Error('apply failed'));
    };

    const outcome = await runPortalCommandSseTransport(harness.deps);

    expect(outcome).toBe('fallback');
    expect(harness.openCalls).toBe(2);
    expect(harness.networkFailures).toBe(2);
    expect(harness.delays).toEqual([1]);
  });

  it('stops when a poll frame applies a portal teardown', async () => {
    const harness = makeHarness({
      onPollFrame: (): Promise<'ok' | 'stopped'> => Promise.resolve('stopped'),
    });
    const outcome = await runPortalCommandSseTransport(harness.deps);
    expect(outcome).toBe('stopped');
  });

  it('handles a terminal inactive-session error by tearing down', async () => {
    const harness = makeHarness({
      openStream: (): Promise<Response> =>
        Promise.reject(new Error('inactive')),
      isInactiveSessionError: (): boolean => true,
    });
    const outcome = await runPortalCommandSseTransport(harness.deps);
    expect(outcome).toBe('stopped');
    expect(harness.inactiveCalls).toBe(1);
  });

  // CAN-2651: this transport also flushes the outbox at the top of every
  // reconnect, so on reconnect after a sleep/Wi-Fi drop it is the first
  // request to land — the same race the long-poll loop has. A 409 here is far
  // more often the server's recoverable stale flag than a real teardown, and
  // treating it as terminal is what silently killed live sessions.
  it('retries instead of tearing down when a 409 probe reports the session revived', async () => {
    const harness = makeHarness({
      isInactiveSessionError: (): boolean => true,
      onInactiveSessionResponse: (): Promise<'revived' | 'terminal'> => {
        harness.inactiveCalls += 1;
        return Promise.resolve('revived');
      },
    });
    let opens = 0;
    harness.deps.openStream = (): Promise<Response> => {
      opens += 1;
      if (opens === 1) {
        return Promise.reject(new Error('inactive'));
      }
      harness.abort();
      return Promise.resolve(sseResponse([POLL_FRAME(1)]));
    };

    const outcome = await runPortalCommandSseTransport(harness.deps);

    expect(harness.inactiveCalls).toBe(1);
    // Reconnected on the existing backoff rather than ending the session.
    expect(opens).toBe(2);
    expect(harness.delays).toEqual([1]);
    // The heartbeat probe already marked the transport healthy; a revived 409
    // must not also be reported as a network failure.
    expect(harness.networkFailures).toBe(0);
    expect(outcome).toBe('stopped');
  });

  it('retries a revived 409 raised while consuming the stream', async () => {
    const harness = makeHarness({
      isInactiveSessionError: (): boolean => true,
      onInactiveSessionResponse: (): Promise<'revived' | 'terminal'> => {
        harness.inactiveCalls += 1;
        return Promise.resolve('revived');
      },
    });
    let opens = 0;
    harness.deps.openStream = (): Promise<Response> => {
      opens += 1;
      if (opens === 1) {
        return Promise.resolve(failingStreamResponse(new Error('inactive')));
      }
      harness.abort();
      return Promise.resolve(sseResponse([POLL_FRAME(1)]));
    };

    const outcome = await runPortalCommandSseTransport(harness.deps);

    expect(harness.inactiveCalls).toBe(1);
    expect(opens).toBe(2);
    expect(harness.networkFailures).toBe(0);
    expect(outcome).toBe('stopped');
  });

  it('reconnects immediately (no backoff) after a healthy delivered connection', async () => {
    const harness = makeHarness(); // clockStep 5000 → connections are healthy
    let opens = 0;
    harness.deps.openStream = (): Promise<Response> => {
      opens += 1;
      if (opens >= 2) {
        harness.abort();
      }
      return Promise.resolve(sseResponse([POLL_FRAME(opens)]));
    };
    const outcome = await runPortalCommandSseTransport(harness.deps);
    expect(outcome).toBe('stopped');
    expect(opens).toBe(2);
    expect(harness.delays).toEqual([]); // healthy → reconnect with no backoff
  });

  it('backs off after a short-lived delivered connection (reconnect-storm guard)', async () => {
    const harness = makeHarness();
    harness.clockStep = 0; // zero-duration connections are never "healthy"
    let opens = 0;
    harness.deps.openStream = (): Promise<Response> => {
      opens += 1;
      if (opens >= 2) {
        harness.abort();
      }
      return Promise.resolve(sseResponse([POLL_FRAME(opens)]));
    };
    const outcome = await runPortalCommandSseTransport(harness.deps);
    expect(outcome).toBe('stopped');
    expect(harness.delays).toEqual([1]); // one backoff after the short delivered conn
  });

  it('arms the idle-read watchdog while consuming', async () => {
    const harness = makeHarness();
    harness.deps.onPollFrame = (data): Promise<'ok' | 'stopped'> => {
      harness.pollData.push(data);
      harness.abort();
      return Promise.resolve('ok');
    };
    await runPortalCommandSseTransport(harness.deps);
    expect(harness.armTimeoutMs).toContain(60_000);
  });

  it('falls back immediately on a terminal error frame', async () => {
    const errorFrame = `event: error\ndata: ${JSON.stringify({
      status: 404,
      error: 'gone',
    })}\n\n`;
    const harness = makeHarness({
      openStream: (): Promise<Response> =>
        Promise.resolve(sseResponse([errorFrame])),
      classifyErrorFrame: (): 'terminal' | 'transient' => 'terminal',
    });
    const outcome = await runPortalCommandSseTransport(harness.deps);
    expect(outcome).toBe('fallback');
  });

  it('reconnects on a transient error frame, then falls back after the streak', async () => {
    const errorFrame = `event: error\ndata: ${JSON.stringify({
      status: 500,
    })}\n\n`;
    let opens = 0;
    const harness = makeHarness({
      openStream: (): Promise<Response> => {
        opens += 1;
        return Promise.resolve(sseResponse([errorFrame]));
      },
      classifyErrorFrame: (): 'terminal' | 'transient' => 'transient',
    });
    const outcome = await runPortalCommandSseTransport(harness.deps);
    expect(outcome).toBe('fallback');
    expect(opens).toBe(3); // maxImmediateFailures
  });

  it('does not re-arm the idle watchdog for keepalive-only reads (CAN-2358)', async () => {
    const harness = makeHarness();
    harness.deps.openStream = (): Promise<Response> => {
      harness.openCalls += 1;
      return Promise.resolve(
        sseResponse([': keepalive\n\n', ': keepalive\n\n', POLL_FRAME(1)]),
      );
    };
    harness.deps.onPollFrame = (): Promise<'ok' | 'stopped'> =>
      Promise.resolve('stopped');

    const outcome = await runPortalCommandSseTransport(harness.deps);

    expect(outcome).toBe('stopped');
    // One initial idle arm plus ONE frame-driven re-arm; the two
    // keepalive-only reads must not re-arm the watchdog, otherwise a wedged
    // poll loop stays undetected while comment bytes keep flowing.
    expect(harness.armTimeoutMs.filter((ms) => ms === 60_000)).toHaveLength(2);
  });
});
