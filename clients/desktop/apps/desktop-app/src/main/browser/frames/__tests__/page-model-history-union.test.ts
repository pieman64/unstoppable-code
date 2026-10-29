import { ExecutionContexts } from '../execution-contexts';
import { PageTrackers } from '../tracker-host';
import { TRACKER_WORLD_NAME } from '../trackers';
import type {
  BrowserPageModel,
  ControlHistory,
  PageModelDeps,
  PageModelNode,
  TrackerMemory,
  TrackerScope,
} from '../model-types';
import { buildPageModel } from '../page-model';
import { projectInputSnapshot } from '../projections';
import {
  loadRecording,
  recordedDeps,
  type Recording,
} from './fixtures/recorded-cdp';
import {
  appendChild,
  cloneRecording,
  elementRecord,
  findTreeNode,
  numberField,
  treeRoot,
} from './fixtures/recording-edit';

/**
 * D5, history belongs to the element: every holder that can know an input
 * is asked, any "was" makes it secret, and "never" needs its current
 * scope's holder. Holders: the preload (main-frame light DOM), the isolated
 * tracker (`light`, a child frame's light DOM) and the main-world tracker
 * (`shadow`, shadow roots in its frame).
 */

const PAGE = { browserId: 'union', url: '', title: '' };

type HolderAnswers = Partial<
  Record<TrackerScope, Record<string, ControlHistory>>
>;

interface Asked {
  scope: TrackerScope;
  frameId: string;
  ids: string[];
}

/** Element ids by session and backend node id, from the recorded trees. */
function elementIds(recording: Recording): Map<string, string> {
  const ids = new Map<string, string>();
  for (const entry of recording.responses) {
    if (entry.method !== 'DOM.getDocument') continue;
    const pending = [treeRoot(recording, entry.sessionId)];
    while (pending.length > 0) {
      const node = pending.pop();
      if (!node) break;
      const attributes = Array.isArray(node.attributes) ? node.attributes : [];
      const index = attributes.indexOf('id');
      if (index >= 0 && index % 2 === 0) {
        ids.set(
          `${entry.sessionId}\u0000${numberField(node, 'backendNodeId')}`,
          String(attributes[index + 1]),
        );
      }
      for (const key of ['children', 'shadowRoots']) {
        const list: unknown = node[key];
        const children: unknown[] = Array.isArray(list) ? list : [];
        for (const child of children)
          if (typeof child === 'object' && child !== null)
            pending.push(Object.fromEntries(Object.entries(child)));
      }
      if (
        typeof node.contentDocument === 'object' &&
        node.contentDocument !== null
      )
        pending.push(Object.fromEntries(Object.entries(node.contentDocument)));
    }
  }
  return ids;
}

/**
 * Tracker stand-ins: each holder answers from its map by element id and
 * `unknown` for anything else; `memory` is what its summary says.
 */
function holders(
  recording: Recording,
  answers: HolderAnswers,
  memory: Partial<Record<TrackerScope, TrackerMemory>>,
  options: { remembered?: string[]; failNonScope?: boolean } = {},
): {
  deps: Partial<PageModelDeps>;
  asked: Asked[];
  summaries: TrackerScope[];
  preloadRemembered: string[][];
} {
  const ids = elementIds(recording);
  const idOf = (sessionId: string, backendNodeId: number): string =>
    ids.get(`${sessionId}\u0000${backendNodeId}`) ?? `?${backendNodeId}`;
  const asked: Asked[] = [];
  const summaries: TrackerScope[] = [];
  const preloadRemembered: string[][] = [];
  const replayDeps = recordedDeps(recording);
  const replay = (
    frameId: string,
    sessionId: string,
    backendNodeIds: number[],
  ): Promise<boolean[]> =>
    replayDeps.isPasswordEverSeen(frameId, sessionId, backendNodeIds);
  return {
    asked,
    summaries,
    preloadRemembered,
    deps: {
      controlHistory: (
        frameId,
        sessionId,
        scope,
        backendNodeIds,
      ): Promise<ControlHistory[]> => {
        const named = backendNodeIds.map((id) => idOf(sessionId, id));
        asked.push({ scope, frameId, ids: named });
        const map = answers[scope] ?? {};
        if (
          options.failNonScope &&
          named.every((id) => map[id] === undefined || map[id] === 'unknown')
        )
          return Promise.reject(new Error('Tracker gone.'));
        return Promise.resolve(named.map((id) => map[id] ?? 'unknown'));
      },
      controlHistorySummary: (
        _frameId,
        _sessionId,
        scope,
      ): Promise<TrackerMemory> => {
        summaries.push(scope);
        return Promise.resolve(memory[scope] ?? 'unknown');
      },
      isPasswordEverSeen: (
        frameId,
        sessionId,
        backendNodeIds,
        purpose,
      ): Promise<boolean[]> => {
        if (purpose !== 'remembered')
          return replay(frameId, sessionId, backendNodeIds);
        const named = backendNodeIds.map((id) => idOf(sessionId, id));
        preloadRemembered.push(named);
        if (options.failNonScope)
          return Promise.reject(new Error('Bridge gone.'));
        return Promise.resolve(
          named.map((id) => options.remembered?.includes(id) === true),
        );
      },
    },
  };
}

function nodeWithId(model: BrowserPageModel, id: string): PageModelNode {
  const node = model.nodes.find((candidate) => candidate.attributes.id === id);
  if (!node) throw new Error(`Missing #${id}`);
  return node;
}

function row(
  model: BrowserPageModel,
  id: string,
): { value?: string; valueRedacted?: boolean } | undefined {
  const node = nodeWithId(model, id);
  return projectInputSnapshot(
    model,
    { browserId: 'union', limit: 100 },
    PAGE,
  ).inputs.find(
    (item) =>
      model.registry.resolveRef(item.ref)?.backendNodeId ===
      node.identity.backendNodeId,
  );
}

describe('history union across holders in the main frame (D5)', () => {
  it('keeps a light input secret when the main-world tracker remembers it from a shadow root', async () => {
    const recording = loadRecording('shadow');
    const stand = holders(
      recording,
      {
        shadow: {
          note: 'never',
          'shadow-revealed': 'never',
          'closed-input': 'never',
          'slotted-input': 'was',
        },
      },
      { shadow: 'some' },
    );
    const model = await buildPageModel(recordedDeps(recording, stand.deps));
    expect(row(model, 'slotted-input')).toMatchObject({ valueRedacted: true });
    expect(row(model, 'slotted-input')?.value).toBeUndefined();
    // The main-world tracker was asked about the light input.
    expect(
      stand.asked.some(
        (ask) => ask.scope === 'shadow' && ask.ids.includes('slotted-input'),
      ),
    ).toBe(true);
    expect(model.trackerHistory).toMatchObject({ summaries: 1 });
  });

  it('asks nothing outside the scope when the holder remembers no password', async () => {
    const recording = loadRecording('shadow');
    const stand = holders(
      recording,
      { shadow: { note: 'never', 'closed-input': 'never' } },
      { shadow: 'none' },
    );
    const model = await buildPageModel(recordedDeps(recording, stand.deps));
    expect(stand.asked.flatMap((entry) => entry.ids)).not.toContain(
      'slotted-input',
    );
    expect(row(model, 'slotted-input')).toMatchObject({
      value: 'slotted value',
    });
  });

  it('keeps a shadow input secret when the preload remembers it from light DOM', async () => {
    const recording = loadRecording('shadow');
    const stand = holders(
      recording,
      {
        shadow: {
          note: 'never',
          'shadow-revealed': 'never',
          'closed-input': 'never',
        },
      },
      { shadow: 'none' },
      { remembered: ['note'] },
    );
    const model = await buildPageModel(recordedDeps(recording, stand.deps));
    expect(row(model, 'note')).toMatchObject({ valueRedacted: true });
    expect(row(model, 'closed-input')).toMatchObject({
      value: 'SEED-SHADOW-CLOSED-2299',
    });
    expect(stand.preloadRemembered).toEqual([
      ['note', 'shadow-revealed', 'closed-input'],
    ]);
  });

  it('preserves the main light-DOM limit but fails closed in shadow when another holder fails', async () => {
    const recording = loadRecording('shadow');
    const stand = holders(
      recording,
      { shadow: { note: 'never', 'closed-input': 'never' } },
      { shadow: 'some' },
      { failNonScope: true },
    );
    const model = await buildPageModel(recordedDeps(recording, stand.deps));
    expect(row(model, 'slotted-input')).toMatchObject({
      value: 'slotted value',
    });
    expect(row(model, 'note')).toMatchObject({ valueRedacted: true });
  });

  it('withholds light inputs the budget left unasked while a password is remembered', async () => {
    const recording = cloneRecording(loadRecording('shadow'));
    const host = findTreeNode(
      treeRoot(recording),
      (node) => node.localName === 'body',
    );
    for (let index = 0; index < 250; index += 1) {
      appendChild(
        host,
        elementRecord(
          9_700 + index,
          'input',
          { id: `bulk-${index}`, value: 'x' },
          [],
        ),
      );
    }
    const stand = holders(recording, {}, { shadow: 'some' });
    const model = await buildPageModel(
      recordedDeps(recording, {
        ...stand.deps,
        // Every light input is a "never" for the preload.
        isPasswordEverSeen: (_frameId, _sessionId, ids, purpose) =>
          Promise.resolve(ids.map(() => purpose === 'remembered' && false)),
      }),
    );
    const askedLight = stand.asked
      .filter((entry) => entry.scope === 'shadow')
      .flatMap((entry) => entry.ids)
      .filter((id) => id.startsWith('bulk-'));
    // Three shadow inputs use the budget first, then the page's two light
    // inputs (slotted and unslotted) before the added ones.
    expect(askedLight).toHaveLength(195);
    expect(nodeWithId(model, 'bulk-0').secret).toBe(false);
    expect(nodeWithId(model, 'bulk-249').secret).toBe(true);
  });
});

describe('history union across holders in a child frame (D5)', () => {
  it('keeps child-frame inputs secret when the other holder remembers them', async () => {
    const recording = loadRecording('trackers');
    const plain = holders(
      recording,
      {
        light: { 'frame-plain': 'never', 'frame-shadow-plain': 'was' },
        shadow: { 'frame-shadow-plain': 'never', 'frame-plain': 'was' },
      },
      { light: 'some', shadow: 'some' },
    );
    const model = await buildPageModel(recordedDeps(recording, plain.deps));
    expect(row(model, 'frame-plain')).toMatchObject({ valueRedacted: true });
    expect(row(model, 'frame-shadow-plain')).toMatchObject({
      valueRedacted: true,
    });
    const baseline = await buildPageModel(recordedDeps(recording));
    expect(row(baseline, 'frame-plain')).toMatchObject({
      value: 'frame plain value',
    });
    expect(row(baseline, 'frame-shadow-plain')).toMatchObject({
      value: 'frame shadow plain',
    });
  });
});

describe('real tracker failure shapes across child holders (S6 G1)', () => {
  it.each([
    ['light to shadow', 'frame-lts', 'light'],
    ['shadow to light', 'frame-stl', 'shadow'],
  ] as const)(
    'withholds a moved revealed input %s on failure, but accepts a real unknown vouch',
    async (_direction, movedId, rememberingHolder) => {
      const recording = loadRecording('trackers');
      const ids = elementIds(recording);
      for (const failed of [true, false]) {
        const contexts = new ExecutionContexts();
        const targetAsks: string[] = [];
        let nextContext = 10;
        const scopes = new Map<number, TrackerScope>();
        for (const frame of recording.frames.filter(
          (frame) => frame.parentId !== undefined,
        )) {
          for (const scope of ['light', 'shadow'] as const) {
            nextContext += 1;
            scopes.set(nextContext, scope);
            contexts.noteEvent(
              'Runtime.executionContextCreated',
              {
                context: {
                  id: nextContext,
                  name: scope === 'light' ? TRACKER_WORLD_NAME : '',
                  auxData: {
                    frameId: frame.frameId,
                    type: scope === 'light' ? 'isolated' : 'default',
                    isDefault: scope === 'shadow',
                  },
                },
              },
              frame.sessionId,
            );
          }
        }
        const trackers = new PageTrackers(
          {
            send: (method, params, sessionId = ''): Promise<unknown> => {
              if (method === 'DOM.resolveNode')
                return Promise.resolve({
                  object: {
                    objectId:
                      ids.get(
                        `${sessionId}\u0000${String(params.backendNodeId)}`,
                      ) ?? '?',
                  },
                });
              if (method !== 'Runtime.callFunctionOn')
                return Promise.resolve({});
              const scope = scopes.get(Number(params.executionContextId));
              const args: unknown[] = Array.isArray(params.arguments)
                ? params.arguments
                : [];
              if (args.length === 0)
                return Promise.resolve({ result: { value: 'E1' } });
              const named = args.map((arg) =>
                typeof arg === 'object' && arg !== null && 'objectId' in arg
                  ? String(arg.objectId)
                  : '?',
              );
              if (named.includes(movedId)) {
                targetAsks.push(scope ?? '?');
                if (scope === rememberingHolder && failed)
                  return Promise.reject(
                    new Error('Remembering holder lost its context'),
                  );
              }
              return Promise.resolve({
                result: {
                  value: `E${named.map((id) => (id === movedId && scope === rememberingHolder ? '2' : '0')).join('')}`,
                },
              });
            },
          },
          contexts,
        );
        const model = await buildPageModel(
          recordedDeps(recording, {
            controlHistory: (frameId, sessionId, scope, backendNodeIds) =>
              trackers.history(frameId, sessionId, scope, backendNodeIds),
            controlHistorySummary: (frameId, sessionId, scope) =>
              trackers.summary(frameId, sessionId, scope),
          }),
        );
        expect(targetAsks).toContain(rememberingHolder);
        expect(nodeWithId(model, movedId).secret).toBe(failed);
        if (failed) {
          expect(row(model, movedId)).toMatchObject({ valueRedacted: true });
          expect(row(model, movedId)?.value).toBeUndefined();
        } else {
          expect(row(model, movedId)?.value).toBeTruthy();
          expect(nodeWithId(model, movedId).secret).toBe(false);
        }
      }
    },
  );
});
