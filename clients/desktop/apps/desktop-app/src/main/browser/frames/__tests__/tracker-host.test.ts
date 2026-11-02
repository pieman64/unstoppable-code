import {
  encodeTrackerWitness,
  TRACKER_WITNESS_RESOLVER_KEY,
} from '@canopy/desktop-shared/browser/page-trackers';
import { ExecutionContexts } from '../execution-contexts';
import { FrameRegistry } from '../frame-registry';
import { PageTrackers } from '../tracker-host';
import {
  isolatedTrackerSource,
  mainWorldTrackerSource,
  TRACKER_WORLD_NAME,
  trackerCallDeclaration,
} from '../trackers';

const KEY = '__canopyPageModelTracker_hosttest';

type Send = (
  method: string,
  params: Record<string, unknown>,
  sessionId?: string,
) => Promise<unknown>;

interface Sent {
  method: string;
  params: Record<string, unknown>;
  sessionId: string;
}

/**
 * Answers like Chromium for a frame with tracker world contexts: `answers`
 * maps an execution context id to what its resolver returns for a call.
 */
function scripted(
  answers: Map<number, (count: number) => unknown>,
  options: { failResolve?: boolean } = {},
): { send: Send; sent: Sent[] } {
  const sent: Sent[] = [];
  let script = 0;
  const send: Send = (method, params, sessionId = '') => {
    sent.push({ method, params, sessionId });
    if (method === 'Page.addScriptToEvaluateOnNewDocument') {
      script += 1;
      return Promise.resolve({ identifier: String(script) });
    }
    if (method === 'DOM.resolveNode') {
      if (options.failResolve) return Promise.reject(new Error('No node'));
      return Promise.resolve({
        object: {
          objectId: `${String(params.executionContextId)}:${String(params.backendNodeId)}`,
        },
      });
    }
    if (method === 'Runtime.callFunctionOn') {
      const contextId = Number(params.executionContextId);
      const answer = answers.get(contextId);
      if (!answer)
        return Promise.reject(
          new Error('Cannot find context with specified id'),
        );
      const argumentsList = Array.isArray(params.arguments)
        ? params.arguments
        : [];
      return Promise.resolve({
        result: { type: 'string', value: answer(argumentsList.length) },
      });
    }
    return Promise.resolve({});
  };
  return { send, sent };
}

function setup(answers: Map<number, (count: number) => unknown>): {
  trackers: PageTrackers;
  contexts: ExecutionContexts;
  registry: FrameRegistry;
  sent: Sent[];
} {
  const { send, sent } = scripted(answers);
  const contexts = new ExecutionContexts();
  const registry = new FrameRegistry();
  registry.noteFrameNavigated('', {
    id: 'root',
    loaderId: 'l0',
    url: 'https://a.test/',
  });
  registry.noteFrameNavigated('', {
    id: 'child',
    loaderId: 'l1',
    url: 'https://a.test/child',
    parentId: 'root',
  });
  const trackers = new PageTrackers({ send }, contexts, KEY);
  return { trackers, contexts, registry, sent };
}

function created(
  contexts: ExecutionContexts,
  id: number,
  frameId: string,
  aux: Record<string, unknown>,
  name = '',
  sessionId = '',
): void {
  contexts.noteEvent(
    'Runtime.executionContextCreated',
    { context: { id, name, auxData: { frameId, ...aux } } },
    sessionId,
  );
}

/** A tracker that ran at document start and remembers nothing. */
const early = (count: number): string =>
  count === 0 ? 'E0' : `E${'0'.repeat(count)}`;

describe('tracker installation', () => {
  it('registers the main-world tracker, then the isolated one, at document start only', async () => {
    const { trackers, sent } = setup(new Map());
    expect(await trackers.install('child-session')).toBe(true);
    expect(sent).toEqual([
      {
        method: 'Page.addScriptToEvaluateOnNewDocument',
        params: { source: mainWorldTrackerSource(KEY, { documents: 'child' }) },
        sessionId: 'child-session',
      },
      {
        method: 'Page.addScriptToEvaluateOnNewDocument',
        params: {
          source: isolatedTrackerSource(KEY),
          worldName: TRACKER_WORLD_NAME,
        },
        sessionId: 'child-session',
      },
    ]);
  });

  it('replaces its own registrations on a session, removing the witness first', async () => {
    const { trackers, sent } = setup(new Map());
    await trackers.install('');
    sent.length = 0;
    await trackers.install('');
    expect(
      sent.map((entry) => [entry.method, entry.params.identifier]),
    ).toEqual([
      ['Page.removeScriptToEvaluateOnNewDocument', '2'],
      ['Page.removeScriptToEvaluateOnNewDocument', '1'],
      ['Page.addScriptToEvaluateOnNewDocument', undefined],
      ['Page.addScriptToEvaluateOnNewDocument', undefined],
    ]);
  });

  it('sends both registrations before either answers, so a held session runs them before its first documents', async () => {
    // A never-navigated view holds renderer-bound commands until its first
    // navigation starts a renderer. Waiting for the main-world reply before
    // sending the witness let that navigation's child documents start
    // untracked (H108).
    const sent: Sent[] = [];
    const release: Array<() => void> = [];
    const trackers = new PageTrackers(
      {
        send: (method, params, sessionId = ''): Promise<unknown> => {
          sent.push({ method, params, sessionId });
          const identifier = String(sent.length);
          return new Promise((resolve) => {
            release.push(() => resolve({ identifier }));
          });
        },
      },
      new ExecutionContexts(),
      KEY,
    );
    const installed = trackers.install('');
    expect(sent.map((entry) => entry.params.worldName)).toEqual([
      undefined,
      TRACKER_WORLD_NAME,
    ]);
    for (const answer of release) answer();
    expect(await installed).toBe(true);
  });

  it('removes the witness when the main-world tracker fails to register', async () => {
    const sent: Array<[string, unknown]> = [];
    const trackers = new PageTrackers(
      {
        send: (method, params): Promise<unknown> => {
          sent.push([method, params.identifier ?? params.worldName]);
          if (method !== 'Page.addScriptToEvaluateOnNewDocument')
            return Promise.resolve({});
          return params.worldName === TRACKER_WORLD_NAME
            ? Promise.resolve({ identifier: 'witness' })
            : Promise.reject(new Error('Page domain disabled'));
        },
      },
      new ExecutionContexts(),
      KEY,
    );
    expect(await trackers.install('')).toBe(false);
    expect(sent).toEqual([
      ['Page.addScriptToEvaluateOnNewDocument', undefined],
      ['Page.addScriptToEvaluateOnNewDocument', TRACKER_WORLD_NAME],
      ['Page.removeScriptToEvaluateOnNewDocument', 'witness'],
    ]);
    // Nothing is retained, so a later install starts by registering.
    sent.length = 0;
    await trackers.install('');
    expect(sent[0]).toEqual([
      'Page.addScriptToEvaluateOnNewDocument',
      undefined,
    ]);
  });

  it('reports failure but keeps the main-world tracker when only the witness fails', async () => {
    const sent: Array<[string, unknown]> = [];
    const trackers = new PageTrackers(
      {
        send: (method, params): Promise<unknown> => {
          sent.push([method, params.identifier]);
          if (method !== 'Page.addScriptToEvaluateOnNewDocument')
            return Promise.resolve({});
          return params.worldName === TRACKER_WORLD_NAME
            ? Promise.reject(new Error('Session closed'))
            : Promise.resolve({ identifier: 'main' });
        },
      },
      new ExecutionContexts(),
      KEY,
    );
    expect(await trackers.install('')).toBe(false);
    sent.length = 0;
    await trackers.install('');
    expect(sent[0]).toEqual([
      'Page.removeScriptToEvaluateOnNewDocument',
      'main',
    ]);
  });
});

describe('tracker queries', () => {
  it('asks a child frame light-DOM tracker in its confirmed world, skipping empty same-named worlds', async () => {
    const answers = new Map<number, (count: number) => unknown>([
      [21, (): unknown => undefined],
      [
        22,
        (count: number): string =>
          count === 0 ? 'E0' : `E${'01'.slice(0, count)}`,
      ],
    ]);
    const { trackers, contexts, sent } = setup(answers);
    created(contexts, 21, 'child', { type: 'isolated' }, TRACKER_WORLD_NAME);
    created(contexts, 22, 'child', { type: 'isolated' }, TRACKER_WORLD_NAME);
    created(
      contexts,
      23,
      'child',
      { type: 'isolated' },
      'Electron Isolated Context',
    );
    expect(await trackers.history('child', '', 'light', [5, 6])).toEqual([
      'never',
      'was',
    ]);
    const resolves = sent.filter((entry) => entry.method === 'DOM.resolveNode');
    expect(resolves.map((entry) => entry.params)).toEqual([
      expect.objectContaining({ backendNodeId: 5, executionContextId: 22 }),
      expect.objectContaining({ backendNodeId: 6, executionContextId: 22 }),
    ]);
    const calls = sent.filter(
      (entry) => entry.method === 'Runtime.callFunctionOn',
    );
    const call = calls[calls.length - 1];
    expect(call?.params).toMatchObject({
      executionContextId: 22,
      functionDeclaration: trackerCallDeclaration(KEY, 2),
      arguments: [{ objectId: '22:5' }, { objectId: '22:6' }],
      returnByValue: true,
    });
    expect(call?.params.objectId).toBeUndefined();
    expect(sent.map((entry) => entry.method)).toContain(
      'Runtime.releaseObjectGroup',
    );
  });

  it('asks the main-world tracker about shadow roots only when the frame witness ran at document start', async () => {
    const answers = new Map<number, (count: number) => unknown>([
      [22, early],
      [30, (count: number): string => `E${'1'.repeat(count)}`],
    ]);
    const { trackers, contexts, sent } = setup(answers);
    created(contexts, 22, 'child', { type: 'isolated' }, TRACKER_WORLD_NAME);
    created(contexts, 30, 'child', { type: 'default', isDefault: true });
    expect(await trackers.history('child', '', 'shadow', [7])).toEqual(['was']);
    expect(
      sent
        .filter((entry) => entry.method === 'DOM.resolveNode')
        .map((entry) => entry.params.executionContextId),
    ).toEqual([30]);
  });

  it.each([
    [
      'late',
      (count: number): string => `L${count === 0 ? '0' : '2'.repeat(count)}`,
    ],
    ['absent', (): unknown => undefined],
  ])(
    'reports unavailable when the witness is %s, without resolving nodes',
    async (_label, witness) => {
      const answers = new Map<number, (count: number) => unknown>([
        [22, witness],
        [30, (count: number): string => `E${'0'.repeat(count)}`],
      ]);
      const { trackers, contexts, sent } = setup(answers);
      created(contexts, 22, 'child', { type: 'isolated' }, TRACKER_WORLD_NAME);
      created(contexts, 30, 'child', { type: 'default', isDefault: true });
      for (const scope of ['light', 'shadow'] as const) {
        expect(
          await trackers.history('child', '', scope, [7, 8]),
        ).toBeUndefined();
      }
      expect(sent.some((entry) => entry.method === 'DOM.resolveNode')).toBe(
        false,
      );
    },
  );

  it('reports unavailable without a tracker world, a main world, or a well-formed answer', async () => {
    const malformed = new Map<number, (count: number) => unknown>([
      [22, (count: number): string => (count === 0 ? 'E0' : 'E0x')],
    ]);
    const { trackers, contexts } = setup(malformed);
    expect(
      await trackers.history('child', '', 'light', [7, 8]),
    ).toBeUndefined();
    created(contexts, 22, 'child', { type: 'isolated' }, TRACKER_WORLD_NAME);
    expect(
      await trackers.history('child', '', 'shadow', [7, 8]),
    ).toBeUndefined();
    expect(
      await trackers.history('child', '', 'light', [7, 8]),
    ).toBeUndefined();
  });

  it('reports unavailable when a node cannot be resolved in the tracker world', async () => {
    const { send } = scripted(new Map([[22, early]]), { failResolve: true });
    const contexts = new ExecutionContexts();
    const trackers = new PageTrackers({ send }, contexts, KEY);
    created(contexts, 22, 'child', { type: 'isolated' }, TRACKER_WORLD_NAME);
    expect(await trackers.history('child', '', 'light', [7])).toBeUndefined();
  });

  it('summarizes whether each holder remembers any password, fresh each time', async () => {
    let mainRemembers = false;
    const answers = new Map<number, (count: number) => unknown>([
      [22, (count: number): string => (count === 0 ? 'E1' : 'E1')],
      [30, (): string => (mainRemembers ? 'E1' : 'E0')],
    ]);
    const { trackers, contexts } = setup(answers);
    expect(await trackers.summary('child', '', 'shadow')).toBe('unknown');
    created(contexts, 22, 'child', { type: 'isolated' }, TRACKER_WORLD_NAME);
    expect(await trackers.summary('child', '', 'shadow')).toBe('unknown');
    created(contexts, 30, 'child', { type: 'default', isDefault: true });
    expect(await trackers.summary('child', '', 'light')).toBe('some');
    expect(await trackers.summary('child', '', 'shadow')).toBe('none');
    mainRemembers = true;
    expect(await trackers.summary('child', '', 'shadow')).toBe('some');
  });

  it('trusts no summary from a late or malformed tracker', async () => {
    for (const witness of ['L1', 'E', 'E7', undefined]) {
      const answers = new Map<number, (count: number) => unknown>([
        [22, (): unknown => witness],
        [30, (): string => 'E1'],
      ]);
      const { trackers, contexts } = setup(answers);
      created(contexts, 22, 'child', { type: 'isolated' }, TRACKER_WORLD_NAME);
      created(contexts, 30, 'child', { type: 'default', isDefault: true });
      for (const holder of ['light', 'shadow'] as const)
        expect([
          witness,
          holder,
          await trackers.summary('child', '', holder),
        ]).toEqual([witness, holder, 'unknown']);
    }
  });

  it('keeps a confirmation per frame document, until its world goes or the frame navigates', async () => {
    const answers = new Map<number, (count: number) => unknown>([
      [22, early],
      [24, early],
    ]);
    const { trackers, contexts, registry, sent } = setup(answers);
    created(contexts, 22, 'child', { type: 'isolated' }, TRACKER_WORLD_NAME);
    const probes = (): number =>
      sent.filter(
        (entry) =>
          entry.method === 'Runtime.callFunctionOn' &&
          entry.params.functionDeclaration === trackerCallDeclaration(KEY, 0),
      ).length;
    await trackers.history('child', '', 'light', [1]);
    await trackers.history('child', '', 'light', [1]);
    expect(probes()).toBe(1);
    expect(trackers.status('child', '')).toBe('tracked');
    contexts.noteEvent('Runtime.executionContextDestroyed', {
      executionContextId: 22,
    });
    expect(trackers.status('child', '')).toBe('unconfirmed');
    created(contexts, 24, 'child', { type: 'isolated' }, TRACKER_WORLD_NAME);
    await trackers.history('child', '', 'light', [1]);
    expect(probes()).toBe(2);
    registry.noteFrameNavigated('', {
      id: 'child',
      loaderId: 'l2',
      url: 'https://a.test/next',
      parentId: 'root',
    });
    trackers.noteFrameNavigated('child');
    expect(trackers.status('child', '')).toBe('unconfirmed');
    await trackers.history('child', '', 'light', [1]);
    expect(probes()).toBe(3);
    trackers.forgetSession('');
    expect(trackers.status('child', '')).toBe('unconfirmed');
  });
});

describe('the top document is witnessed by the preload (E4)', () => {
  const PRELOAD_KEY = `__canopyPageModelTracker_${'7'.repeat(32)}`;
  const PRELOAD_WORLD = 'Electron Isolated Context';

  /** Root is the top document; its preload world is context 40. */
  function topSetup(
    answers: Map<number, (count: number) => unknown>,
  ): ReturnType<typeof setup> & { trackers: PageTrackers } {
    const { send, sent } = scripted(answers);
    const contexts = new ExecutionContexts();
    const registry = new FrameRegistry();
    registry.noteFrameNavigated('', {
      id: 'root',
      loaderId: 'l0',
      url: 'https://a.test/',
    });
    const trackers = new PageTrackers(
      {
        send,
        isTopDocument: (frameId, sessionId): boolean =>
          registry.getFrame(frameId)?.parentId === undefined &&
          sessionId === '',
        preloadContexts: (frameId, sessionId): number[] =>
          contexts.isolated(frameId, sessionId, [TRACKER_WORLD_NAME]),
      },
      contexts,
      KEY,
    );
    created(contexts, 22, 'root', { type: 'isolated' }, TRACKER_WORLD_NAME);
    created(contexts, 30, 'root', { type: 'default', isDefault: true });
    created(contexts, 40, 'root', { type: 'isolated' }, PRELOAD_WORLD);
    return { trackers, contexts, registry, sent };
  }

  const witnessCalls = (sent: Sent[]): Sent[] =>
    sent.filter(
      (entry) =>
        entry.method === 'Runtime.callFunctionOn' &&
        String(entry.params.functionDeclaration).includes(
          TRACKER_WITNESS_RESOLVER_KEY,
        ),
    );

  it("asks the preload's witness, then the main world under the preload's key", async () => {
    const answers = new Map<number, (count: number) => unknown>([
      // The CDP witness would also answer; it is not asked in a top document.
      [22, early],
      [
        30,
        (count: number): string =>
          count === 0 ? 'E1' : `E${'1'.repeat(count)}`,
      ],
      [
        40,
        (): string => encodeTrackerWitness({ early: true, key: PRELOAD_KEY }),
      ],
    ]);
    const { trackers, sent } = topSetup(answers);
    expect(await trackers.history('root', '', 'shadow', [7])).toEqual(['was']);
    expect(await trackers.summary('root', '', 'shadow')).toBe('some');
    expect(
      witnessCalls(sent).map((entry) => entry.params.executionContextId),
    ).toEqual([40]);
    const asked = sent.filter(
      (entry) =>
        entry.method === 'Runtime.callFunctionOn' &&
        entry.params.executionContextId === 30,
    );
    expect(asked.map((entry) => entry.params.functionDeclaration)).toEqual([
      trackerCallDeclaration(PRELOAD_KEY, 1),
      trackerCallDeclaration(PRELOAD_KEY, 0),
    ]);
    expect(
      sent.some(
        (entry) =>
          entry.method === 'Runtime.callFunctionOn' &&
          entry.params.executionContextId === 22,
      ),
    ).toBe(false);
    expect(trackers.status('root', '')).toBe('tracked');
  });

  it.each([
    ['late', (): string => encodeTrackerWitness({ early: false })],
    ['missing', (): unknown => undefined],
    ['malformed', (): string => 'E__canopyPageModelTracker_x'],
    [
      'throwing',
      (): unknown => {
        throw new Error('Execution context was destroyed.');
      },
    ],
  ])(
    'reports unavailable for a top document whose preload witness is %s, even if the host key answers',
    async (_label, witness) => {
      const answers = new Map<number, (count: number) => unknown>([
        [22, early],
        // A resolver under the host's own key is never trusted in a top document.
        [30, (count: number): string => `E${'0'.repeat(count)}`],
        [40, witness],
      ]);
      const { trackers, sent } = topSetup(answers);
      expect(
        await trackers.history('root', '', 'shadow', [7, 8]),
      ).toBeUndefined();
      expect(await trackers.summary('root', '', 'shadow')).toBe('unknown');
      expect(sent.some((entry) => entry.method === 'DOM.resolveNode')).toBe(
        false,
      );
    },
  );

  it('reports unavailable for a key the main world does not hold (the preload asked, the tracker did not install)', async () => {
    const answers = new Map<number, (count: number) => unknown>([
      [30, (): unknown => undefined],
      [
        40,
        (): string => encodeTrackerWitness({ early: true, key: PRELOAD_KEY }),
      ],
    ]);
    const { trackers } = topSetup(answers);
    expect(await trackers.history('root', '', 'shadow', [7])).toBeUndefined();
    expect(await trackers.summary('root', '', 'shadow')).toBe('unknown');
  });

  it('has no light-DOM tracker for a top document (the preload answers for it)', async () => {
    const answers = new Map<number, (count: number) => unknown>([
      [22, (count: number): string => `E${'1'.repeat(count)}`],
      [
        40,
        (): string => encodeTrackerWitness({ early: true, key: PRELOAD_KEY }),
      ],
    ]);
    const { trackers } = topSetup(answers);
    expect(await trackers.history('root', '', 'light', [7])).toBeUndefined();
    expect(await trackers.summary('root', '', 'light')).toBe('unknown');
  });

  it('confirms each top document again: the witness of a replaced document is not reused', async () => {
    const answers = new Map<number, (count: number) => unknown>([
      [30, (count: number): string => `E${'0'.repeat(count)}`],
      [
        40,
        (): string => encodeTrackerWitness({ early: true, key: PRELOAD_KEY }),
      ],
    ]);
    const { trackers, contexts, sent } = topSetup(answers);
    await trackers.history('root', '', 'shadow', [7]);
    trackers.noteFrameNavigated('root');
    contexts.noteEvent('Runtime.executionContextDestroyed', {
      executionContextId: 40,
    });
    expect(trackers.status('root', '')).toBe('unconfirmed');
    expect(await trackers.history('root', '', 'shadow', [7])).toBeUndefined();
    expect(witnessCalls(sent)).toHaveLength(1);
  });
});

describe('history availability (S6 G1)', () => {
  afterEach(() => jest.useRealTimers());

  it('keeps an early tracker real per-element 2 as unknown', async () => {
    const { trackers, contexts } = setup(
      new Map([[22, (count: number): string => (count === 0 ? 'E0' : 'E2')]]),
    );
    created(contexts, 22, 'child', { type: 'isolated' }, TRACKER_WORLD_NAME);
    expect(await trackers.history('child', '', 'light', [7])).toEqual([
      'unknown',
    ]);
  });

  it.each(['L0', 'E', 'E00', 'E7', undefined])(
    'reports unavailable for a late or malformed per-input answer %s',
    async (answer) => {
      const { trackers, contexts } = setup(
        new Map([
          [22, (count: number): unknown => (count === 0 ? 'E0' : answer)],
        ]),
      );
      created(contexts, 22, 'child', { type: 'isolated' }, TRACKER_WORLD_NAME);
      expect(await trackers.history('child', '', 'light', [7])).toBeUndefined();
    },
  );

  it.each(['confirmation', 'resolve', 'answer'] as const)(
    'reports unavailable at its bound when %s never answers',
    async (phase) => {
      jest.useFakeTimers();
      const contexts = new ExecutionContexts();
      created(contexts, 22, 'child', { type: 'isolated' }, TRACKER_WORLD_NAME);
      const { send: replay } = scripted(new Map([[22, early]]));
      const trackers = new PageTrackers(
        {
          send: (method, params, sessionId): Promise<unknown> => {
            const count = Array.isArray(params.arguments)
              ? params.arguments.length
              : 0;
            if (
              (phase === 'resolve' && method === 'DOM.resolveNode') ||
              (method === 'Runtime.callFunctionOn' &&
                (phase === 'confirmation' || (phase === 'answer' && count > 0)))
            )
              return new Promise(() => {});
            return replay(method, params, sessionId);
          },
        },
        contexts,
        KEY,
      );
      let finished = false;
      const history = trackers
        .history('child', '', 'light', [7])
        .then((value) => {
          finished = true;
          return value;
        });
      await jest.advanceTimersByTimeAsync(1999);
      expect(finished).toBe(false);
      await jest.advanceTimersByTimeAsync(1);
      expect(await history).toBeUndefined();
    },
  );

  it('reports unavailable when the per-input call rejects', async () => {
    const { trackers, contexts } = setup(
      new Map([
        [
          22,
          (count: number): string => {
            if (count > 0) throw new Error('Destroyed context');
            return 'E0';
          },
        ],
      ]),
    );
    created(contexts, 22, 'child', { type: 'isolated' }, TRACKER_WORLD_NAME);
    expect(await trackers.history('child', '', 'light', [7])).toBeUndefined();
  });
});

describe('malformed node resolution availability (S6 G1)', () => {
  it('reports unavailable when resolveNode returns no object id', async () => {
    const contexts = new ExecutionContexts();
    created(contexts, 22, 'child', { type: 'isolated' }, TRACKER_WORLD_NAME);
    const { send: replay } = scripted(new Map([[22, early]]));
    const trackers = new PageTrackers(
      {
        send: (method, params, sessionId): Promise<unknown> =>
          method === 'DOM.resolveNode'
            ? Promise.resolve({ object: {} })
            : replay(method, params, sessionId),
      },
      contexts,
      KEY,
    );
    expect(await trackers.history('child', '', 'light', [7])).toBeUndefined();
  });
});
