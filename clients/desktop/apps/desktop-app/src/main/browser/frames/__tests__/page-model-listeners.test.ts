import type { BrowserPageModel, PageModelDeps } from '../model-types';
import { buildPageModel } from '../page-model';
import {
  loadRecording,
  recordedDeps,
  recordedSend,
  type ReplayOptions,
} from './fixtures/recorded-cdp';

/**
 * The optional listener stage on the recorded `listeners` page: click and
 * pointerdown via `addEventListener`, an inline `onclick`, a listener in an
 * open shadow root, one in a same-process iframe and one in a cross-site
 * (out-of-process) iframe, next to elements with none or with only a
 * keydown listener.
 */
const EXPECTED_HITS = [
  'click-target',
  'pointer-target',
  'inline-target',
  'shadow-target',
  'frame-target',
  'cross-target',
];

function hitIds(model: BrowserPageModel): string[] {
  const ids: string[] = [];
  for (const frame of model.listeners) {
    for (const backendNodeId of frame.backendNodeIds) {
      const node = model.nodes.find(
        (candidate) =>
          candidate.identity.sessionId === frame.sessionId &&
          candidate.identity.backendNodeId === backendNodeId,
      );
      ids.push(node?.attributes.id ?? `?${backendNodeId}`);
    }
  }
  return ids.sort();
}

async function build(
  options: ReplayOptions = {},
): Promise<{ model: BrowserPageModel; methods: string[] }> {
  const recording = loadRecording('listeners');
  const replay = options.send ?? recordedSend(recording);
  const methods: string[] = [];
  const send: PageModelDeps['send'] = (method, params, sessionId) => {
    methods.push(method);
    return replay(method, params, sessionId);
  };
  const model = await buildPageModel(
    recordedDeps(recording, { ...options, send }),
    { listeners: true },
  );
  return { model, methods };
}

describe('optional listener stage on recorded Chromium scans', () => {
  it('finds the page listeners in every frame main world, and nothing else', async () => {
    const { model, methods } = await build();
    expect(hitIds(model)).toEqual([...EXPECTED_HITS].sort());
    expect(model.listeners.every((frame) => frame.skipped === undefined)).toBe(
      true,
    );
    expect(methods).not.toContain('Page.createIsolatedWorld');
    expect(model.timings.listenersMs).toBeGreaterThanOrEqual(0);
  });

  it('evaluates silently, bounded by Chromium, in each frame main world', async () => {
    const recording = loadRecording('listeners');
    const replay = recordedSend(recording);
    const evaluations: Array<{
      sessionId: string;
      params: Record<string, unknown>;
    }> = [];
    await build({
      send: (method, params, sessionId) => {
        if (method === 'Runtime.evaluate') {
          evaluations.push({ sessionId: sessionId ?? '', params });
        }
        return replay(method, params, sessionId);
      },
    });
    const sameProcessContext = recording.mainWorlds?.[0]?.contextId;
    expect(sameProcessContext).toEqual(expect.any(Number));
    const targets = evaluations.map(({ sessionId, params }) => [
      sessionId,
      params.contextId,
    ]);
    expect(targets).toHaveLength(3);
    expect(targets).toEqual(
      expect.arrayContaining([
        // The root session's top frame and the cross-site frame's session
        // top need no id; the same-process frame uses its default context.
        ['', undefined],
        ['', sameProcessContext],
        [expect.stringMatching(/^oopif-/), undefined],
      ]),
    );
    for (const { params } of evaluations) {
      // Chromium terminates a scan the page keeps busy, so a hostile page
      // cannot hang its renderer for later requests.
      expect(params).toMatchObject({
        includeCommandLineAPI: true,
        returnByValue: true,
        silent: true,
        timeout: 10_000,
      });
    }
  });

  it('skips a same-process frame whose main-world context is unknown', async () => {
    const { model, methods } = await build({
      mainWorldContextId: () => undefined,
    });
    const rootFrameId = model.frames[0]?.frameId;
    const sameProcess = model.frames.find(
      (frame) => frame.parentFrameId === rootFrameId && frame.sessionId === '',
    );
    expect(sameProcess).toBeDefined();
    expect(model.listeners).toContainEqual({
      sessionId: '',
      frameId: sameProcess?.frameId,
      backendNodeIds: [],
      skipped: 'main_world_unavailable',
    });
    // The session top frames need no context id and still report hits.
    expect(hitIds(model)).toEqual(
      [
        'click-target',
        'pointer-target',
        'inline-target',
        'shadow-target',
        'cross-target',
      ].sort(),
    );
    // Never an isolated world, where page listeners are invisible.
    expect(methods).not.toContain('Page.createIsolatedWorld');
  });

  it.each([
    [
      'throws',
      (): Promise<unknown> => Promise.reject(new Error('Target closed.')),
    ],
    [
      'throws in the page',
      (): Promise<unknown> =>
        Promise.resolve({
          result: { type: 'object', subtype: 'error' },
          exceptionDetails: { text: 'Uncaught TypeError' },
        }),
    ],
    [
      'returns garbage',
      (): Promise<unknown> =>
        Promise.resolve({
          result: { type: 'object', value: { count: 'many', hits: 'all' } },
        }),
    ],
  ])(
    'reports a frame whose scan %s as skipped, without failing the build',
    async (_label, scan) => {
      const recording = loadRecording('listeners');
      const replay = recordedSend(recording);
      const { model } = await build({
        send: (method, params, sessionId) =>
          method === 'Runtime.evaluate'
            ? scan()
            : replay(method, params, sessionId),
      });
      expect(model.nodes.length).toBeGreaterThan(10);
      expect(model.listeners).toHaveLength(3);
      for (const frame of model.listeners) {
        expect(frame).toMatchObject({
          backendNodeIds: [],
          skipped: 'scan_failed',
        });
      }
    },
  );

  it('ignores hits whose path does not resolve or uses an invalid tag', async () => {
    const recording = loadRecording('listeners');
    const replay = recordedSend(recording);
    const { model } = await build({
      send: (method, params, sessionId) =>
        method === 'Runtime.evaluate'
          ? Promise.resolve({
              result: {
                type: 'object',
                value: {
                  count: 10,
                  hits: [
                    { scope: 0, path: [{ tag: 'html', position: 9 }] },
                    { scope: 0, path: [{ tag: 'img src=x', position: 1 }] },
                    { scope: 7, path: [{ tag: 'button', position: 1 }] },
                    {
                      scope: 0,
                      path: Array.from({ length: 600 }, () => ({
                        tag: 'div',
                        position: 1,
                      })),
                    },
                  ],
                },
              },
            })
          : replay(method, params, sessionId),
    });
    expect(hitIds(model)).toEqual([]);
  });
});
