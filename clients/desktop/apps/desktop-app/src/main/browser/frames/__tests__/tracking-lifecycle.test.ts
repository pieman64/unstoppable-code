import { DomTracking } from '../dom-tracking';
import { PIERCED_DOCUMENT_DEPTH } from '../pierced-document';
import { loadRecording } from './fixtures/recorded-cdp';
import { recordedHost, type SentRequest } from './fixtures/recorded-host';

/**
 * D11: DOM tracking follows agent activity. A build, a wait probe or an
 * action establishes it; after an idle period with nothing in flight the
 * host releases each possibly streaming session (DOM.disable, then DOM.enable
 * with whitespace) and bumps the cache revision.
 */

function domCalls(sent: SentRequest[]): string[] {
  return sent
    .filter((entry) =>
      ['DOM.disable', 'DOM.enable', 'DOM.getDocument'].includes(entry.method),
    )
    .map(
      (entry) =>
        `${entry.method}${entry.method === 'DOM.enable' ? JSON.stringify(entry.params) : ''}@${entry.sessionId || 'root'}`,
    );
}

describe('DOM tracking lifecycle (D11)', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('releases every possibly streaming session after the idle period, and bumps the revision', async () => {
    jest.useFakeTimers({ doNotFake: ['queueMicrotask', 'setImmediate'] });
    const { host, sent } = recordedHost(loadRecording('oopif'), (method) =>
      ['DOM.disable', 'DOM.enable'].includes(method)
        ? Promise.resolve({})
        : undefined,
    );
    await host.build();
    expect(host.trackingState).toBe('on');
    const revision = host.key.domEventRevision;
    const streamingSessions = Array.from(
      new Set(
        sent
          .filter((entry) => entry.method === 'DOM.getDocument')
          .map((entry) => entry.sessionId || 'root'),
      ),
    );
    sent.length = 0;
    await jest.advanceTimersByTimeAsync(host.trackingIdleMs - 1);
    expect(domCalls(sent)).toEqual([]);
    await jest.advanceTimersByTimeAsync(1);
    expect(host.trackingState).toBe('off');
    // Only sessions sent a pierced request, whether captured or not.
    expect(domCalls(sent).sort()).toEqual(
      streamingSessions
        .flatMap((session) => [
          `DOM.disable@${session}`,
          `DOM.enable{"includeWhitespace":"all"}@${session}`,
        ])
        .sort(),
    );
    expect(host.key.domEventRevision).toBeGreaterThan(revision);
  });

  it('never releases while an action is in flight, and re-establishes for the next one', async () => {
    jest.useFakeTimers({ doNotFake: ['queueMicrotask', 'setImmediate'] });
    const { host, sent } = recordedHost(loadRecording('oopif'), (method) =>
      ['DOM.disable', 'DOM.enable'].includes(method)
        ? Promise.resolve({})
        : undefined,
    );
    await host.build();
    const end = host.beginActivity();
    await jest.advanceTimersByTimeAsync(host.trackingIdleMs * 3);
    expect(host.trackingState).toBe('on');
    expect(sent.some((entry) => entry.method === 'DOM.disable')).toBe(false);
    end();
    await jest.advanceTimersByTimeAsync(host.trackingIdleMs);
    expect(host.trackingState).toBe('off');
    sent.length = 0;
    const next = host.beginActivity();
    await host.establishTracking();
    expect(host.trackingState).toBe('on');
    expect(
      sent
        .filter((entry) => entry.method === 'DOM.getDocument')
        .map((entry) => [entry.sessionId, entry.params]),
    ).toEqual(
      ['', 'oopif-1', 'oopif-2', 'oopif-3'].map((session) => [
        session,
        { depth: PIERCED_DOCUMENT_DEPTH, pierce: true },
      ]),
    );
    next();
  });

  it('waits for a release in progress before a build starts', async () => {
    jest.useFakeTimers({ doNotFake: ['queueMicrotask', 'setImmediate'] });
    let finishDisable: () => void = () => undefined;
    const order: string[] = [];
    const { host } = recordedHost(loadRecording('form-controls'), (method) => {
      if (method === 'DOM.disable') {
        order.push('disable');
        return new Promise((resolve) => {
          finishDisable = (): void => resolve({});
        });
      }
      if (method === 'DOM.enable') {
        order.push('enable');
        return Promise.resolve({});
      }
      if (method === 'DOM.getDocument') order.push('getDocument');
      return undefined;
    });
    await host.build();
    order.length = 0;
    await jest.advanceTimersByTimeAsync(host.trackingIdleMs);
    const building = host.build({ cache: 'bypass' });
    await jest.advanceTimersByTimeAsync(10);
    expect(order).toEqual(['disable']);
    finishDisable();
    await building;
    expect(order).toEqual(['disable', 'enable', 'getDocument']);
    expect(host.trackingState).toBe('on');
  });
});

describe('establishment owned as an activity (review R2 finding 5)', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('must idle-release tracking established after the owning action was cancelled', async () => {
    jest.useFakeTimers();
    let finish: (value: unknown) => void = () => undefined;
    const send = jest.fn(
      (method: string): Promise<unknown> =>
        method === 'DOM.getDocument'
          ? new Promise((resolve) => {
              finish = resolve;
            })
          : Promise.resolve({}),
    );
    const tracking = new DomTracking({
      send,
      sessions: (): string[] => [''],
      onReleased: (): void => undefined,
      idleMs: 10,
    });
    const end = tracking.begin();
    const establish = tracking.establish();
    await Promise.resolve();
    // The lane's cleanup ends the activity while getDocument is in flight.
    end();
    finish({ root: { nodeId: 1 } });
    await establish;
    await jest.advanceTimersByTimeAsync(100);
    expect(send.mock.calls.map(([method]) => method)).toContain('DOM.disable');
    expect(tracking.state).toBe('off');
    tracking.dispose();
  });

  it('never marks a disposed tracker on, whatever finishes after the disposal', async () => {
    let finish: (value: unknown) => void = () => undefined;
    const send = jest.fn(
      (method: string): Promise<unknown> =>
        method === 'DOM.getDocument'
          ? new Promise((resolve) => {
              finish = resolve;
            })
          : Promise.resolve({}),
    );
    const tracking = new DomTracking({
      send,
      sessions: (): string[] => [''],
      onReleased: (): void => undefined,
      idleMs: 10,
    });
    const establish = tracking.establish();
    await Promise.resolve();
    tracking.dispose();
    finish({ root: { nodeId: 1 } });
    await establish;
    expect(tracking.state).toBe('off');
    tracking.capture()(['']);
    expect(tracking.state).toBe('off');
  });

  it('sends one getDocument per session for concurrent establishments', async () => {
    const send = jest.fn(
      (method: string): Promise<unknown> => Promise.resolve({ method }),
    );
    const tracking = new DomTracking({
      send,
      sessions: (): string[] => ['', 'child'],
      onReleased: (): void => undefined,
      idleMs: 10,
    });
    await Promise.all([tracking.establish(), tracking.establish()]);
    expect(send.mock.calls.map(([method]) => method)).toEqual([
      'DOM.getDocument',
      'DOM.getDocument',
    ]);
    tracking.dispose();
  });
});

describe('every host target API waits for a release in progress (review R2 question 6)', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  async function releasing(): Promise<{
    host: ReturnType<typeof recordedHost>['host'];
    sent: SentRequest[];
    finishDisable: () => void;
    ref: string;
    identity: {
      frameId: string;
      sessionId: string;
      loaderId: string;
      backendNodeId: number;
    };
  }> {
    jest.useFakeTimers({ doNotFake: ['queueMicrotask', 'setImmediate'] });
    let finish: () => void = () => undefined;
    const { host, sent } = recordedHost(
      loadRecording('form-controls'),
      (method) => {
        if (method === 'DOM.disable')
          return new Promise((resolve) => {
            finish = (): void => resolve({});
          });
        if (method === 'DOM.enable') return Promise.resolve({});
        if (method === 'DOM.resolveNode')
          return Promise.resolve({ object: { objectId: 'target' } });
        if (method === 'Runtime.callFunctionOn')
          return Promise.resolve({ result: { value: true } });
        if (method === 'DOM.getNodeForLocation')
          return Promise.reject(new Error('No node found at given location'));
        if (method === 'Page.getLayoutMetrics')
          return Promise.resolve({ cssLayoutViewport: { pageX: 0, pageY: 0 } });
        return undefined;
      },
    );
    const { model } = await host.build();
    const node = model.nodes.find(
      (candidate) => candidate.tagName.toLowerCase() === 'button',
    );
    if (!node) throw new Error('No recorded button');
    const ref = host.registry.mintRef(node.identity);
    // The idle release starts and its DOM.disable is not answered yet.
    await jest.advanceTimersByTimeAsync(host.trackingIdleMs);
    sent.length = 0;
    return {
      host,
      sent,
      finishDisable: () => finish(),
      ref,
      identity: node.identity,
    };
  }

  it.each(['ref', 'point', 'focused'] as const)(
    'must wait for an idle DOM release already in progress before resolving a %s target',
    async (kind) => {
      const { host, sent, finishDisable, ref } = await releasing();
      const end = host.beginActivity();
      const resolution = host.resolveActionTarget(
        kind === 'ref'
          ? { kind, ref }
          : kind === 'point'
            ? { kind, x: 10, y: 10 }
            : { kind },
      );
      await jest.advanceTimersByTimeAsync(1);
      expect(sent.map((entry) => entry.method)).toEqual([]);
      finishDisable();
      const result = await resolution;
      const methods = sent.map((entry) => entry.method);
      expect(methods.slice(0, 1)).toEqual(['DOM.enable']);
      expect(methods.length).toBeGreaterThan(1);
      if (result.status === 'found')
        await host.releaseActionTarget(result.target);
      end();
      host.dispose();
    },
  );

  it('holds the other target APIs the same way', async () => {
    const { host, sent, finishDisable, identity } = await releasing();
    const target = { identity };
    const calls = [
      host.documentMapping(target),
      host.outerHitTest(target, { x: 1, y: 1 }),
      host.mapToAncestors(target, { x: 1, y: 1 }),
      host.armInputRecorder(target),
      host.waitProbe({}),
    ];
    await jest.advanceTimersByTimeAsync(1);
    expect(sent.map((entry) => entry.method)).toEqual([]);
    finishDisable();
    await Promise.allSettled(calls);
    expect(sent[0]?.method).toBe('DOM.enable');
    host.dispose();
  });
});

describe('wait probe with a frame scope', () => {
  it('counts only in the scoped frame, counts nothing for a missing frame, and rejects an invalid frame selector', async () => {
    const { host } = recordedHost(loadRecording('frames'), (method, params) => {
      if (method === 'Page.createIsolatedWorld')
        return Promise.resolve({ executionContextId: 5 });
      if (
        method === 'Runtime.evaluate' &&
        params.expression === 'document.readyState'
      )
        return Promise.resolve({
          result: { type: 'string', value: 'complete' },
        });
      if (
        method === 'DOM.querySelectorAll' &&
        typeof params.selector === 'string' &&
        params.selector.startsWith('[[')
      )
        return Promise.reject(new Error('DOM Error while querying'));
      return undefined;
    });
    expect(
      await host.waitProbe({
        locator: "page.locator('button')",
        frame: 'iframe#framed',
      }),
    ).toEqual({ matchCount: 1, visibleCount: 1, readyState: 'complete' });
    expect(
      await host.waitProbe({
        locator: "page.locator('button')",
        frame: 'iframe#missing',
      }),
    ).toEqual({ matchCount: 0, visibleCount: 0, readyState: 'complete' });
    await expect(
      host.waitProbe({ text: 'Frame action', frame: '[[' }),
    ).rejects.toThrow(/Invalid CSS locator/);
  });
});

describe('bounded DOM tracking requests (S5 F2)', () => {
  afterEach(() => jest.useRealTimers());

  it('skips a non-answering getDocument after 4 seconds while establishing other sessions', async () => {
    jest.useFakeTimers();
    const send = jest.fn(
      (
        _method: string,
        _params: Record<string, unknown>,
        sessionId?: string,
      ): Promise<unknown> =>
        sessionId === 'hung' ? new Promise(() => {}) : Promise.resolve({}),
    );
    const tracking = new DomTracking({
      send,
      sessions: (): string[] => ['', 'hung'],
      onReleased: (): void => undefined,
    });
    let finished = false;
    const establishing = tracking.establish().then(() => {
      finished = true;
    });
    await jest.advanceTimersByTimeAsync(3_999);
    expect(finished).toBe(false);
    await jest.advanceTimersByTimeAsync(1);
    expect(finished).toBe(true);
    await establishing;
    expect(tracking.state).toBe('on');
    expect(send.mock.calls.map(([, , session]) => session)).toEqual([
      '',
      'hung',
    ]);
    tracking.dispose();
  });

  it.each(['DOM.disable', 'DOM.enable'])(
    'finishes release despite a non-answering %s and allows later establishment',
    async (hungMethod) => {
      jest.useFakeTimers();
      const send = jest.fn(
        (method: string): Promise<unknown> =>
          method === hungMethod ? new Promise(() => {}) : Promise.resolve({}),
      );
      const released = jest.fn();
      const tracking = new DomTracking({
        send,
        sessions: (): string[] => [''],
        onReleased: released,
        idleMs: 10,
      });
      await tracking.establish();
      await jest.advanceTimersByTimeAsync(10);
      const pending = tracking.pending();
      let finished = false;
      const establishing = tracking.establish().then(() => {
        finished = true;
      });
      await jest.advanceTimersByTimeAsync(999);
      expect(finished).toBe(false);
      await jest.advanceTimersByTimeAsync(1);
      expect(finished).toBe(true);
      await pending;
      await establishing;
      expect(released).toHaveBeenCalledTimes(3);
      expect(
        send.mock.calls.filter(([method]) => method === 'DOM.getDocument'),
      ).toHaveLength(2);
      tracking.dispose();
    },
  );
});

describe('per-session DOM establishment (S5 F3)', () => {
  it('pushes a session added while on, leaving established sessions alone', async () => {
    const sessions = [''];
    const send = jest.fn((): Promise<unknown> => Promise.resolve({}));
    const tracking = new DomTracking({
      send,
      sessions: (): string[] => sessions,
      onReleased: (): void => undefined,
    });
    await tracking.establish();
    sessions.push('child');
    await tracking.establish();
    expect(send.mock.calls).toHaveLength(2);
    tracking.dispose();
  });

  it.each(['DOM.documentUpdated', 'Page.frameNavigated', 'detach'])(
    're-pushes only the session invalidated by %s',
    async (event) => {
      const { host, sent } = recordedHost(loadRecording('oopif'), (method) =>
        method === 'DOM.getDocument' ? Promise.resolve({}) : undefined,
      );
      await host.establishTracking();
      sent.length = 0;
      if (event === 'detach') {
        host.detachSession('oopif-1');
        host.noteEvent('Target.attachedToTarget', {
          sessionId: 'oopif-1',
          targetInfo: {
            targetId: 'reattached',
            type: 'iframe',
            url: 'https://child.test',
          },
        });
      } else {
        host.noteEvent(
          event,
          {
            frame: {
              id: 'replacement',
              loaderId: 'replacement-load',
              parentId: 'root',
              url: 'https://child.test',
            },
          },
          'oopif-1',
        );
      }
      await host.establishTracking();
      expect(
        sent
          .filter((entry) => entry.method === 'DOM.getDocument')
          .map((entry) => entry.sessionId),
      ).toEqual(['oopif-1']);
      host.dispose();
    },
  );

  it('a build leaves sessions it did not capture for establishment, which invalidates a still-fresh cache', async () => {
    const recording = loadRecording('oopif');
    const { host, sent } = recordedHost({
      ...recording,
      frames: recording.frames.filter((frame) => frame.sessionId !== 'oopif-3'),
    });
    const first = await host.build();
    const captured = new Set(
      first.model.frames.map((frame) => frame.sessionId),
    );
    const all = ['', 'oopif-1', 'oopif-2'];
    const missing = all.filter((session) => !captured.has(session));
    expect(captured.size).toBe(2);
    expect(missing).toHaveLength(1);
    expect((await host.build()).cached).toBe(true);
    sent.length = 0;
    const revision = host.key.domEventRevision;
    await host.establishTracking();
    expect(
      sent
        .filter((entry) => entry.method === 'DOM.getDocument')
        .map((entry) => entry.sessionId),
    ).toEqual(missing);
    expect(host.key.domEventRevision).toBeGreaterThan(revision);
    expect((await host.build()).cached).toBe(false);
    host.dispose();
  });

  it('does not let a stale push replace a concurrent new-generation push', async () => {
    const finishes: Array<() => void> = [];
    const { host, sent } = recordedHost(
      loadRecording('form-controls'),
      (method) =>
        method === 'DOM.getDocument'
          ? new Promise((resolve) => {
              finishes.push(() => resolve({}));
            })
          : undefined,
    );
    const old = host.establishTracking();
    await Promise.resolve();
    host.noteEvent('DOM.documentUpdated', {});
    const current = host.establishTracking();
    await Promise.resolve();
    expect(finishes).toHaveLength(2);
    finishes[0]?.();
    await old;
    // The new-generation request is already sent and may stream, but has
    // not established the document; the next call must still coalesce.
    expect(host.trackingState).toBe('on');
    const shared = host.establishTracking();
    await Promise.resolve();
    expect(
      sent.filter((entry) => entry.method === 'DOM.getDocument'),
    ).toHaveLength(2);
    finishes[1]?.();
    await Promise.all([current, shared]);
    expect(host.trackingState).toBe('on');
    host.dispose();
  });

  it('does not mark a replaced or detached session from a stale build completion', () => {
    const tracking = new DomTracking({
      send: (): Promise<unknown> => Promise.resolve({}),
      sessions: (): string[] => ['', 'child'],
      onReleased: (): void => undefined,
    });
    const markCaptured = tracking.capture();
    tracking.invalidateSession('');
    tracking.invalidateSession('child');
    markCaptured(['', 'child']);
    expect(tracking.state).toBe('off');
    tracking.dispose();
  });

  it('a push invalidated before completion cannot establish the new document', async () => {
    let finish: () => void = () => undefined;
    let held = true;
    const { host, sent } = recordedHost(
      loadRecording('form-controls'),
      (method) => {
        if (method !== 'DOM.getDocument') return undefined;
        if (!held) return Promise.resolve({});
        return new Promise((resolve) => {
          finish = (): void => resolve({});
        });
      },
    );
    const establishing = host.establishTracking();
    await Promise.resolve();
    host.noteEvent('DOM.documentUpdated', {});
    finish();
    await establishing;
    expect(host.trackingState).toBe('off');
    held = false;
    await host.establishTracking();
    expect(
      sent.filter((entry) => entry.method === 'DOM.getDocument'),
    ).toHaveLength(2);
    expect(host.trackingState).toBe('on');
    host.dispose();
  });
});

describe('streaming sessions without establishment (S6 G2)', () => {
  afterEach(() => jest.useRealTimers());

  it('releases root mutations after a same-process child frame navigates', async () => {
    jest.useFakeTimers();
    const recording = loadRecording('frames');
    const { host, sent } = recordedHost(recording, (method) =>
      ['DOM.disable', 'DOM.enable'].includes(method)
        ? Promise.resolve({})
        : undefined,
    );
    await host.build();
    const child = recording.frames.find(
      (frame) => frame.parentId !== undefined && frame.sessionId === '',
    );
    if (!child) throw new Error('Missing same-process child');
    host.noteEvent('Page.frameNavigated', {
      frame: {
        id: child.frameId,
        parentId: child.parentId,
        loaderId: 'new-child',
        url: child.url,
      },
    });
    host.noteEvent('DOM.attributeModified', {
      nodeId: 1,
      name: 'data-mutating',
      value: 'yes',
    });
    await jest.advanceTimersByTimeAsync(host.trackingIdleMs);
    expect(
      sent
        .filter((entry) => entry.method === 'DOM.disable')
        .map((entry) => entry.sessionId),
    ).toEqual(['']);
    expect(host.trackingState).toBe('off');
    host.dispose();
  });

  it('releases a successful document push even when all snapshots fail', async () => {
    jest.useFakeTimers();
    const { host, sent } = recordedHost(
      loadRecording('form-controls'),
      (method) => {
        if (method === 'DOMSnapshot.captureSnapshot')
          return Promise.reject(new Error('Snapshot unavailable'));
        if (['DOM.disable', 'DOM.enable'].includes(method))
          return Promise.resolve({});
        return undefined;
      },
    );
    const { model } = await host.build();
    expect(model.frames).toHaveLength(0);
    expect(sent.some((entry) => entry.method === 'DOM.getDocument')).toBe(true);
    await jest.advanceTimersByTimeAsync(host.trackingIdleMs);
    expect(
      sent
        .filter((entry) => entry.method === 'DOM.disable')
        .map((entry) => entry.sessionId),
    ).toEqual(['']);
    host.dispose();
  });

  it('releases a push invalidated mid-flight by a frame navigation', async () => {
    jest.useFakeTimers();
    let finish: () => void = () => undefined;
    const { host, sent } = recordedHost(
      loadRecording('form-controls'),
      (method) => {
        if (method === 'DOM.getDocument')
          return new Promise((resolve) => {
            finish = (): void => resolve({});
          });
        if (['DOM.disable', 'DOM.enable'].includes(method))
          return Promise.resolve({});
        return undefined;
      },
    );
    const pushing = host.establishTracking();
    await Promise.resolve();
    host.noteEvent('Page.frameNavigated', {
      frame: { id: 'new', loaderId: 'new', url: 'https://new.test' },
    });
    finish();
    await pushing;
    await jest.advanceTimersByTimeAsync(host.trackingIdleMs);
    expect(
      sent
        .filter((entry) => entry.method === 'DOM.disable')
        .map((entry) => entry.sessionId),
    ).toEqual(['']);
    host.dispose();
  });

  it('does not disable a sole streaming session after documentUpdated retires it', async () => {
    jest.useFakeTimers();
    const { host, sent } = recordedHost(loadRecording('form-controls'));
    await host.build();
    host.noteEvent('DOM.documentUpdated', {});
    await jest.advanceTimersByTimeAsync(host.trackingIdleMs);
    expect(host.trackingState).toBe('off');
    expect(sent.some((entry) => entry.method === 'DOM.disable')).toBe(false);
    host.dispose();
  });
});

describe('conservative streaming retirement (S6 G2)', () => {
  afterEach(() => jest.useRealTimers());

  it('releases even a rejected pierced request, which may already have started events', async () => {
    jest.useFakeTimers();
    const send = jest.fn(
      (method: string): Promise<unknown> =>
        method === 'DOM.getDocument'
          ? Promise.reject(new Error('Lost response'))
          : Promise.resolve({}),
    );
    const tracking = new DomTracking({
      send,
      sessions: (): string[] => [''],
      onReleased: (): void => undefined,
      idleMs: 10,
    });
    await tracking.establish();
    expect(tracking.state).toBe('on');
    await jest.advanceTimersByTimeAsync(10);
    expect(send.mock.calls.map(([method]) => method)).toEqual([
      'DOM.getDocument',
      'DOM.disable',
      'DOM.enable',
    ]);
    tracking.dispose();
  });

  it.each(['DOM.documentUpdated', 'detach'])(
    'retires only the affected stream on %s',
    async (event) => {
      jest.useFakeTimers();
      const { host, sent } = recordedHost(loadRecording('oopif'), (method) =>
        ['DOM.getDocument', 'DOM.disable', 'DOM.enable'].includes(method)
          ? Promise.resolve({})
          : undefined,
      );
      await host.establishTracking();
      if (event === 'detach') host.detachSession('oopif-1');
      else host.noteEvent(event, {}, 'oopif-1');
      await jest.advanceTimersByTimeAsync(host.trackingIdleMs);
      expect(
        sent
          .filter((entry) => entry.method === 'DOM.disable')
          .map((entry) => entry.sessionId)
          .sort(),
      ).toEqual(['', 'oopif-2', 'oopif-3']);
      host.dispose();
    },
  );
});
