import * as PageModelModule from '../page-model';
import { FrameRegistry } from '../frame-registry';
import type { BrowserPageModel } from '../model-types';
import { PageModelHost } from '../page-model-host';
import { PASSWORD_HISTORY_RESOLVER_KEY } from '@canopy/desktop-shared/browser/secret-fields';
import { HOST_WORLD_NAME } from '../host-cdp';
import { TRACKER_WORLD_NAME } from '../trackers';
import {
  encodeTrackerWitness,
  TRACKER_WITNESS_RESOLVER_KEY,
} from '@canopy/desktop-shared/browser/page-trackers';

function modelBuild(model: BrowserPageModel): PageModelModule.PageModelBuild {
  return { model, withheld: () => model };
}

function harness(): {
  host: PageModelHost;
  send: jest.Mock<Promise<unknown>, [string, Record<string, unknown>, string?]>;
} {
  const send = jest.fn<
    Promise<unknown>,
    [string, Record<string, unknown>, string?]
  >();
  send.mockImplementation((method) => {
    if (method === 'DOM.resolveNode')
      return Promise.resolve({ object: { objectId: 'element' } });
    if (method === 'Runtime.callFunctionOn')
      return Promise.resolve({ result: { value: [false] } });
    if (method === 'DOM.describeNode')
      return Promise.resolve({ node: { backendNodeId: 1 } });
    return Promise.resolve({});
  });
  const host = new PageModelHost({ send, now: Date.now });
  host.noteEvent('Page.frameNavigated', {
    frame: { id: 'root', loaderId: 'load', url: 'https://example.test' },
  });
  host.noteEvent('Runtime.executionContextCreated', {
    context: { id: 7, auxData: { frameId: 'root', type: 'isolated' } },
  });
  return { send, host };
}

describe('PageModelHost', () => {
  async function emptyModel(): Promise<BrowserPageModel> {
    return PageModelModule.buildPageModel({
      registry: new FrameRegistry(),
      now: Date.now,
      send: () => Promise.resolve({}),
      isPasswordEverSeen: () => Promise.resolve([]),
    });
  }
  it.each(['DOM.attributeModified', 'action', 'Page.frameNavigated'])(
    'invalidates cached models within the 500ms TTL: %s',
    async (event) => {
      const model = await emptyModel();
      const builder = jest
        .spyOn(PageModelModule, 'buildPageModelWithFallback')
        .mockResolvedValue(modelBuild(model));
      const { host } = harness();
      expect((await host.build()).cached).toBe(false);
      expect((await host.build()).cached).toBe(true);
      if (event === 'action') host.actionBoundary();
      else
        host.noteEvent(
          event,
          { frame: { id: 'root', loaderId: 'next', url: 'https://next.test' } },
          '',
        );
      expect((await host.build()).cached).toBe(false);
      expect(builder).toHaveBeenCalledTimes(2);
    },
  );
  it('discards a build invalidated in flight and retries with the new revision', async () => {
    const model = await emptyModel();
    let finish: (value: BrowserPageModel) => void = () => undefined;
    const pending = new Promise<BrowserPageModel>((resolve) => {
      finish = resolve;
    });
    const builder = jest
      .spyOn(PageModelModule, 'buildPageModelWithFallback')
      .mockReturnValueOnce(pending.then(modelBuild))
      .mockResolvedValue(modelBuild(model));
    const { host } = harness();
    const built = host.build();
    host.noteEvent('DOM.childNodeRemoved', {}, 'child');
    finish(model);
    expect((await built).cached).toBe(false);
    expect(builder).toHaveBeenCalledTimes(2);
    expect((await host.build()).cached).toBe(true);
  });
  it('does not cache bypass builds, distinguishes optional stage configurations, and expires at 500ms', async () => {
    const model = await emptyModel();
    jest.useFakeTimers();
    const builder = jest
      .spyOn(PageModelModule, 'buildPageModelWithFallback')
      .mockResolvedValue(modelBuild(model));
    const { host } = harness();
    expect((await host.build({ cache: 'bypass' })).cached).toBe(false);
    expect((await host.build()).cached).toBe(false);
    expect((await host.build()).cached).toBe(true);
    expect(
      (await host.build({ cache: 'use', accessibility: true })).cached,
    ).toBe(false);
    await jest.advanceTimersByTimeAsync(500);
    expect(
      (await host.build({ cache: 'use', accessibility: true })).cached,
    ).toBe(false);
    expect(builder).toHaveBeenCalledTimes(4);
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });
  it('restores a root frame whose commit was missed, keeping the child frames already seen', async () => {
    const send = jest.fn<
      Promise<unknown>,
      [string, Record<string, unknown>, string?]
    >();
    const child = {
      id: 'child',
      parentId: 'root',
      loaderId: 'child-load',
      url: 'https://example.test/child',
    };
    send.mockImplementation((method) =>
      Promise.resolve(
        method === 'Page.getFrameTree'
          ? {
              frameTree: {
                frame: {
                  id: 'root',
                  loaderId: 'load',
                  url: 'https://example.test/frames',
                },
                childFrames: [{ frame: child }],
              },
            }
          : {},
      ),
    );
    const host = new PageModelHost({ send, now: Date.now });
    // The root committed before Page.enable; only the child's event arrived.
    host.noteEvent('Page.frameNavigated', { frame: child });
    expect(host.hasNavigatedRoot()).toBe(false);
    const childRef = host.registry.frames()[0]?.frameRef;

    await host.discoverFrames();

    expect(host.hasNavigatedRoot()).toBe(true);
    const frames = host.registry.frames();
    expect(frames).toHaveLength(2);
    expect(frames).toContainEqual(
      expect.objectContaining({
        frameId: 'root',
        sessionId: '',
        loaderId: 'load',
      }),
    );
    // The known child keeps its identity: discovery must not reset it.
    expect(frames).toContainEqual(
      expect.objectContaining({
        frameId: 'child',
        parentId: 'root',
        loaderId: 'child-load',
        frameRef: childRef,
      }),
    );
  });

  it('knows each frame main-world context per session, and forgets destroyed ones', async () => {
    const { host } = harness();
    const created = (
      id: number,
      frameId: string,
      aux: Record<string, unknown>,
      sessionId = '',
    ): void =>
      host.noteEvent(
        'Runtime.executionContextCreated',
        { context: { id, auxData: { frameId, ...aux } } },
        sessionId,
      );
    created(11, 'child', { isDefault: false, type: 'isolated' });
    expect(host.mainWorldContextId('child', '')).toBeUndefined();
    created(12, 'child', { isDefault: true, type: 'default' });
    created(12, 'child', { isDefault: true, type: 'default' }, 'other');
    expect(host.mainWorldContextId('child', '')).toBe(12);
    // A navigation creates a new default context; the newest wins.
    created(13, 'child', { isDefault: true, type: 'default' });
    expect(host.mainWorldContextId('child', '')).toBe(13);
    host.noteEvent('Runtime.executionContextDestroyed', {
      executionContextId: 13,
    });
    expect(host.mainWorldContextId('child', '')).toBe(12);
    host.noteEvent('Runtime.executionContextsCleared', {});
    expect(host.mainWorldContextId('child', '')).toBeUndefined();
    expect(host.mainWorldContextId('child', 'other')).toBe(12);

    // Builds hand the lookup to the model.
    const model = await emptyModel();
    const builder = jest
      .spyOn(PageModelModule, 'buildPageModelWithFallback')
      .mockResolvedValue(modelBuild(model));
    await host.build({ cache: 'bypass' });
    expect(
      builder.mock.calls[0]?.[0].mainWorldContextId?.('child', 'other'),
    ).toBe(12);
  });

  it('never looks for the preload bridges in its own worlds, and hands tracker queries to builds', async () => {
    const send = jest.fn<
      Promise<unknown>,
      [string, Record<string, unknown>, string?]
    >();
    const host = new PageModelHost({ send, now: Date.now });
    host.noteEvent('Page.frameNavigated', {
      frame: { id: 'root', loaderId: 'load', url: 'https://example.test' },
    });
    // The host's worlds are older than the preload's here.
    for (const [id, name] of [
      [8, TRACKER_WORLD_NAME],
      [9, HOST_WORLD_NAME],
      [10, 'Electron Isolated Context'],
    ] as const) {
      host.noteEvent('Runtime.executionContextCreated', {
        context: { id, name, auxData: { frameId: 'root', type: 'isolated' } },
      });
    }
    send.mockImplementation((method, params) => {
      if (method === 'DOM.resolveNode')
        return Promise.resolve({ object: { objectId: 'element' } });
      if (method === 'Runtime.callFunctionOn')
        return Promise.resolve({
          result: {
            value: params.executionContextId === 10 ? [true] : undefined,
          },
        });
      return Promise.resolve({});
    });
    expect(await host.isPasswordEverSeen('root', '', [1])).toEqual([true]);
    expect(
      send.mock.calls
        .filter(([method]) => method === 'DOM.resolveNode')
        .map(([, params]) => params.executionContextId),
    ).toEqual([10]);

    const model = await emptyModel();
    const builder = jest
      .spyOn(PageModelModule, 'buildPageModelWithFallback')
      .mockResolvedValue(modelBuild(model));
    await host.build({ cache: 'bypass' });
    const deps = builder.mock.calls[0]?.[0];
    expect(
      await deps?.controlHistory?.('root', '', 'shadow', [1]),
    ).toBeUndefined();
    expect(
      await host.trackerHistory('root', '', 'shadow', [1]),
    ).toBeUndefined();
  });

  it("asks the preload's witness for the top document and its tracker world for a child frame (E4)", async () => {
    const send = jest.fn<
      Promise<unknown>,
      [string, Record<string, unknown>, string?]
    >();
    const host = new PageModelHost({ send, now: Date.now });
    host.noteEvent('Page.frameNavigated', {
      frame: { id: 'root', loaderId: 'load', url: 'https://example.test' },
    });
    host.noteEvent('Page.frameNavigated', {
      frame: {
        id: 'child',
        parentId: 'root',
        loaderId: 'child-load',
        url: 'https://example.test/child',
      },
    });
    for (const [id, frameId, name, type] of [
      [8, 'root', TRACKER_WORLD_NAME, 'isolated'],
      [9, 'root', HOST_WORLD_NAME, 'isolated'],
      [10, 'root', 'Electron Isolated Context', 'isolated'],
      [11, 'root', '', 'default'],
      [20, 'child', TRACKER_WORLD_NAME, 'isolated'],
      [21, 'child', '', 'default'],
    ] as const) {
      host.noteEvent('Runtime.executionContextCreated', {
        context: {
          id,
          name,
          auxData: { frameId, type, isDefault: type === 'default' },
        },
      });
    }
    const preloadKey = `__canopyPageModelTracker_${'a'.repeat(32)}`;
    send.mockImplementation((_method, params) => {
      const declaration = String(params.functionDeclaration);
      const contextId = params.executionContextId;
      if (
        contextId === 10 &&
        declaration.includes(TRACKER_WITNESS_RESOLVER_KEY)
      )
        return Promise.resolve({
          result: {
            value: encodeTrackerWitness({ early: true, key: preloadKey }),
          },
        });
      if (contextId === 11 && declaration.includes(preloadKey))
        return Promise.resolve({ result: { value: 'E1' } });
      if (
        contextId === 20 ||
        (contextId === 21 && declaration.includes(host.trackerKey))
      )
        return Promise.resolve({ result: { value: 'E0' } });
      return Promise.resolve({ result: { value: undefined } });
    });
    expect(await host.trackerSummary('root', '', 'shadow')).toBe('some');
    expect(await host.trackerSummary('child', '', 'shadow')).toBe('none');
    expect(host.trackerStatus('root', '')).toBe('tracked');
    expect(host.trackerStatus('child', '')).toBe('tracked');
    const askedContexts = send.mock.calls.map(
      ([, params]) => params.executionContextId,
    );
    // Neither the root's CDP tracker world nor the host's world is asked.
    expect(askedContexts).not.toContain(8);
    expect(askedContexts).not.toContain(9);
    expect(askedContexts).toEqual([10, 11, 20, 21]);
  });

  it('records child identities and DOM revisions before host routing can return', () => {
    const { host } = harness();
    host.noteEvent('Target.attachedToTarget', {
      sessionId: 'child',
      targetInfo: { targetId: 'target', type: 'iframe', url: '' },
    });
    host.noteEvent('Target.targetInfoChanged', {
      targetInfo: {
        targetId: 'target',
        type: 'iframe',
        url: 'https://child.test',
      },
    });
    host.noteEvent(
      'Page.frameNavigated',
      {
        frame: {
          id: 'target',
          parentId: 'root',
          loaderId: 'child-load',
          url: 'https://child.test',
        },
      },
      'child',
    );
    const revision = host.key.domEventRevision;
    host.noteEvent('DOM.attributeModified', {}, 'child');
    expect(host.key.domEventRevision).toBe(revision + 1);
    expect(host.key.navigationSequence).toBe(2);
    expect(host.registry.frames()).toContainEqual(
      expect.objectContaining({
        frameId: 'target',
        sessionId: 'child',
        url: 'https://child.test',
      }),
    );
  });
  it.each(['Page.frameDetached', 'Target.detachedFromTarget'])(
    '%s drops refs',
    (method) => {
      const { host } = harness();
      host.noteEvent('Target.attachedToTarget', {
        sessionId: 'child',
        targetInfo: { targetId: 'target', type: 'iframe' },
      });
      host.noteEvent(
        'Page.frameNavigated',
        {
          frame: {
            id: 'target',
            parentId: 'root',
            loaderId: 'child-load',
            url: '',
          },
        },
        'child',
      );
      const ref = host.registry.mintRef({
        sessionId: 'child',
        frameId: 'target',
        loaderId: 'child-load',
        backendNodeId: 1,
      });
      host.noteEvent(method, { frameId: 'target', sessionId: 'child' });
      expect(host.registry.resolveRef(ref)).toBeUndefined();
    },
  );
  it('calls the password bridge in the matching frame isolated context and releases its group', async () => {
    const { host, send } = harness();
    expect(await host.isPasswordEverSeen('root', '', [1])).toEqual([false]);
    expect(send).toHaveBeenCalledWith(
      'DOM.resolveNode',
      expect.objectContaining({
        backendNodeId: 1,
        executionContextId: 7,
      }),
      '',
    );
    expect(
      send.mock.calls.find(
        ([method]) => method === 'Runtime.callFunctionOn',
      )?.[1].functionDeclaration,
    ).toContain(PASSWORD_HISTORY_RESOLVER_KEY);
    expect(send).toHaveBeenCalledWith(
      'Runtime.releaseObjectGroup',
      expect.any(Object),
      '',
    );
  });
  it.each([
    'missing resolver',
    'missing context',
    'resolution failure',
    'timeout',
  ])('fails closed: %s', async (failure) => {
    const { host, send } = harness();
    if (failure === 'missing context')
      host.noteEvent('Runtime.executionContextsCleared', {});
    if (failure === 'missing resolver')
      send.mockImplementation(() => Promise.resolve({ result: {} }));
    if (failure === 'resolution failure')
      send.mockRejectedValue(new Error('removed'));
    if (failure === 'timeout') {
      jest.useFakeTimers();
      send.mockImplementation(() => new Promise(() => undefined));
    }
    const pending = host.isPasswordEverSeen('root', '', [1, 2]);
    if (failure === 'timeout') await jest.advanceTimersByTimeAsync(2001);
    expect(await pending).toEqual([true, true]);
  });
  it('keeps inspect trust from the scope ask, whatever a remembered-only ask answers', async () => {
    const { host, send } = harness();
    const model = await emptyModel();
    const builder = jest
      .spyOn(PageModelModule, 'buildPageModelWithFallback')
      .mockResolvedValue(modelBuild(model));
    await host.build({ cache: 'bypass' });
    const deps = builder.mock.calls[0]?.[0];
    if (!deps) throw new Error('No build deps');
    expect(await deps.isPasswordEverSeen('root', '', [1])).toEqual([false]);
    expect(host.historyTrusted('root')).toBe(true);
    send.mockImplementation(() => Promise.resolve({ result: {} }));
    expect(
      await deps.isPasswordEverSeen('root', '', [2], 'remembered'),
    ).toEqual([true]);
    expect(host.historyTrusted('root')).toBe(true);
    expect(await deps.isPasswordEverSeen('root', '', [3])).toEqual([true]);
    expect(host.historyTrusted('root')).toBe(false);
    // Builds also get the trackers' summaries.
    expect(await deps.controlHistorySummary?.('root', '', 'shadow')).toBe(
      'unknown',
    );
  });
  it('rejects stale identities and falls back when inspect enrichment fails', async () => {
    const { host, send } = harness();
    const identity = {
      sessionId: '',
      frameId: 'root',
      loaderId: 'load',
      backendNodeId: 1,
    };
    send.mockRejectedValue(new Error('gone'));
    // S2b E3: typed, with a plain message.
    await expect(host.assertLive(identity)).rejects.toMatchObject({
      code: 'target_stale',
      message:
        'That reference is no longer on the page. Run browser.input_snapshot for current references.',
    });
    expect(await host.enrich(identity)).toBeNull();
  });
  it('batches bridge arguments at 200 and keeps context ids isolated by CDP session', async () => {
    const { host, send } = harness();
    host.noteEvent(
      'Runtime.executionContextCreated',
      { context: { id: 7, auxData: { frameId: 'child', type: 'isolated' } } },
      'child-session',
    );
    send.mockImplementation((method, params) => {
      if (method === 'DOM.resolveNode')
        return Promise.resolve({ object: { objectId: 'resolved' } });
      if (method === 'Runtime.callFunctionOn') {
        const args: unknown = params.arguments;
        return Promise.resolve({
          result: { value: Array.isArray(args) ? args.map(() => false) : [] },
        });
      }
      return Promise.resolve({});
    });
    const ids = Array.from({ length: 401 }, (_, index) => index + 1);
    expect(
      await host.isPasswordEverSeen('child', 'child-session', ids),
    ).toEqual(ids.map(() => false));
    const calls = send.mock.calls.filter(
      ([method]) => method === 'Runtime.callFunctionOn',
    );
    expect(calls).toHaveLength(3);
    expect(
      calls.map(([, params]) =>
        Array.isArray(params.arguments) ? params.arguments.length : 0,
      ),
    ).toEqual([200, 200, 1]);
    expect(calls.every(([, , session]) => session === 'child-session')).toBe(
      true,
    );
    expect(
      send.mock.calls
        .filter(([method]) => method === 'DOM.resolveNode')
        .every(
          ([, params, session]) =>
            params.executionContextId === 7 && session === 'child-session',
        ),
    ).toBe(true);
    const groups = new Set(
      send.mock.calls
        .filter(([method]) => method === 'DOM.resolveNode')
        .map(([, params]) => params.objectGroup),
    );
    expect(groups.size).toBe(1);
  });
  it('uses only the matching isolated context for exact-element inspect enrichment', async () => {
    const { host, send } = harness();
    send.mockImplementation((method) => {
      if (method === 'DOM.resolveNode')
        return Promise.resolve({ object: { objectId: 'exact-element' } });
      if (method === 'Runtime.callFunctionOn')
        return Promise.resolve({
          result: {
            value: {
              locatorCandidates: [],
              domPath: ['html', 'body', 'input'],
              outerHtml: '<input>',
            },
          },
        });
      return Promise.resolve({});
    });
    const identity = {
      frameId: 'root',
      sessionId: '',
      loaderId: 'load',
      backendNodeId: 5,
    };
    expect(await host.enrich(identity)).toEqual({
      locatorCandidates: [],
      domPath: ['html', 'body', 'input'],
      outerHtml: '<input>',
    });
    expect(send).toHaveBeenCalledWith(
      'DOM.resolveNode',
      expect.objectContaining({ backendNodeId: 5, executionContextId: 7 }),
      '',
    );
    expect(send).toHaveBeenCalledWith(
      'Runtime.callFunctionOn',
      expect.objectContaining({ objectId: 'exact-element' }),
      '',
    );
  });
  describe('secret controls for inspect enrichment (PR #4917 finding 1)', () => {
    const target = {
      frameId: 'root',
      sessionId: '',
      loaderId: 'load',
      backendNodeId: 5,
    };
    const control = (backendNodeId: number): typeof target => ({
      ...target,
      backendNodeId,
    });
    const enrichment = {
      locatorCandidates: [],
      domPath: ['html', 'body', 'form'],
      outerHtml: '<form></form>',
    };

    it('resolves each secret control in the target context and group and passes the handles', async () => {
      const { host, send } = harness();
      send.mockImplementation((method, params) => {
        if (method === 'DOM.resolveNode')
          return Promise.resolve({
            object: { objectId: `object-${String(params.backendNodeId)}` },
          });
        if (method === 'Runtime.callFunctionOn')
          return Promise.resolve({ result: { value: enrichment } });
        return Promise.resolve({});
      });
      expect(await host.enrich(target, [control(8), control(9)])).toEqual(
        enrichment,
      );
      const resolves = send.mock.calls.filter(
        ([method]) => method === 'DOM.resolveNode',
      );
      expect(resolves.map(([, params]) => params.backendNodeId)).toEqual([
        5, 8, 9,
      ]);
      expect(
        new Set(resolves.map(([, params]) => params.executionContextId)),
      ).toEqual(new Set([7]));
      expect(
        new Set(resolves.map(([, params]) => params.objectGroup)).size,
      ).toBe(1);
      const call = send.mock.calls.find(
        ([method]) => method === 'Runtime.callFunctionOn',
      );
      expect(call?.[1]).toMatchObject({
        objectId: 'object-5',
        arguments: [{ objectId: 'object-8' }, { objectId: 'object-9' }],
      });
      expect(call?.[1].functionDeclaration).toContain('...secrets');
    });

    it('does not enrich when any secret control fails to resolve', async () => {
      const { host, send } = harness();
      send.mockImplementation((method, params) => {
        if (method === 'DOM.resolveNode')
          return params.backendNodeId === 9
            ? Promise.reject(new Error('No node with given id found'))
            : Promise.resolve({ object: { objectId: 'object' } });
        if (method === 'Runtime.callFunctionOn')
          return Promise.resolve({ result: { value: enrichment } });
        return Promise.resolve({});
      });
      expect(await host.enrich(target, [control(8), control(9)])).toBeNull();
      expect(
        send.mock.calls.some(([method]) => method === 'Runtime.callFunctionOn'),
      ).toBe(false);
    });

    it('does not enrich with more than 200 secret controls or controls from another document', async () => {
      const { host, send } = harness();
      send.mockImplementation((method) => {
        if (method === 'DOM.resolveNode')
          return Promise.resolve({ object: { objectId: 'object' } });
        if (method === 'Runtime.callFunctionOn')
          return Promise.resolve({ result: { value: enrichment } });
        return Promise.resolve({});
      });
      const many = Array.from({ length: 201 }, (_, index) =>
        control(100 + index),
      );
      expect(await host.enrich(target, many)).toBeNull();
      expect(
        await host.enrich(target, [{ ...control(8), frameId: 'child' }]),
      ).toBeNull();
      expect(send).not.toHaveBeenCalledWith(
        'Runtime.callFunctionOn',
        expect.anything(),
        expect.anything(),
      );
    });
  });

  it('reads styles in the frame isolated world, one call per 200 elements', async () => {
    const { host, send } = harness();
    send.mockImplementation((method, params) => {
      if (method === 'DOM.resolveNode') {
        return params.backendNodeId === 3
          ? Promise.reject(new Error('Could not find node'))
          : Promise.resolve({
              object: { objectId: `object-${String(params.backendNodeId)}` },
            });
      }
      if (method === 'Runtime.callFunctionOn') {
        const args: unknown = params.arguments;
        return Promise.resolve({
          result: {
            value: Array.isArray(args)
              ? args.map(() => ['none', 'visible'])
              : [],
          },
        });
      }
      return Promise.resolve({});
    });
    const ids = Array.from({ length: 201 }, (_, index) => index + 1);
    const sessions = new Set<string>();
    const result = await host.readStyles('root', '', ids, 'group-1', sessions);
    expect(result).toHaveLength(201);
    expect(result?.[0]).toEqual({ display: 'none', visibility: 'visible' });
    expect(result?.[2]).toBeUndefined();
    const calls = send.mock.calls.filter(
      ([method]) => method === 'Runtime.callFunctionOn',
    );
    expect(
      calls.map(([, params]) =>
        Array.isArray(params.arguments) ? params.arguments.length : 0,
      ),
    ).toEqual([199, 1]);
    expect(
      calls.every(
        ([, params]) =>
          params.executionContextId === 7 && params.objectGroup === 'group-1',
      ),
    ).toBe(true);
    expect(sessions).toEqual(new Set(['']));
  });

  it('creates a page-model world for a frame without one and reports no context when that fails', async () => {
    const { host, send } = harness();
    send.mockImplementation((method) => {
      if (method === 'Page.createIsolatedWorld')
        return Promise.resolve({ executionContextId: 31 });
      if (method === 'DOM.resolveNode')
        return Promise.resolve({ object: { objectId: 'element' } });
      if (method === 'Runtime.callFunctionOn')
        return Promise.resolve({
          result: { value: [['inline-block', 'visible']] },
        });
      return Promise.resolve({});
    });
    expect(
      await host.readStyles('child-frame', 'child', [5], 'group', new Set()),
    ).toEqual([{ display: 'inline-block', visibility: 'visible' }]);
    expect(send).toHaveBeenCalledWith(
      'Page.createIsolatedWorld',
      expect.objectContaining({ frameId: 'child-frame' }),
      'child',
    );
    send.mockImplementation(() => Promise.reject(new Error('no frame')));
    expect(
      await host.readStyles('gone', 'child', [5], 'group', new Set()),
    ).toBeUndefined();
  });

  it('wires readStyles into builds and releases its object group', async () => {
    const model = await emptyModel();
    const { host, send } = harness();
    jest
      .spyOn(PageModelModule, 'buildPageModelWithFallback')
      .mockImplementation(async (deps) => {
        await deps.readStyles?.('root', '', [1]);
        return modelBuild(model);
      });
    await host.build({ cache: 'bypass' });
    const group = send.mock.calls.find(
      ([method]) => method === 'DOM.resolveNode',
    )?.[1].objectGroup;
    expect(send).toHaveBeenCalledWith(
      'Runtime.releaseObjectGroup',
      { objectGroup: group },
      '',
    );
  });

  it('returns a model for a page that mutates during every build (M6)', async () => {
    const model = await emptyModel();
    const withheldModel = await emptyModel();
    const withheld = jest.fn(() => withheldModel);
    const { host } = harness();
    const builder = jest
      .spyOn(PageModelModule, 'buildPageModelWithFallback')
      .mockImplementation(() => {
        host.noteEvent('DOM.attributeModified', {}, '');
        return Promise.resolve({ model, withheld });
      });
    // The last capture is re-assembled with every form control secret.
    await expect(host.build()).resolves.toMatchObject({
      model: withheldModel,
      cached: false,
    });
    expect(withheld).toHaveBeenCalledTimes(1);
    expect(builder).toHaveBeenCalledTimes(
      PageModelModule.MAX_CONSISTENT_BUILD_ATTEMPTS,
    );
    // Nothing was cached under a key the page no longer has.
    await host.build();
    expect(builder).toHaveBeenCalledTimes(
      PageModelModule.MAX_CONSISTENT_BUILD_ATTEMPTS * 2,
    );
  });

  it('rebuilds once when a locator finds the model node IDs stale (m1)', async () => {
    const { host, send } = harness();
    const frameRef = host.registry.frameRefFor('root');
    const model = await emptyModel();
    model.registry = host.registry;
    model.frames = [
      {
        frameId: 'root',
        frameRef,
        sessionId: '',
        loaderId: 'load',
        url: 'https://example.test',
        documentNodeId: 1,
        queryRootNodeIds: [1],
        depth: 0,
        viewportTransform: { x: 0, y: 0, scaleX: 1, scaleY: 1 },
        clip: { x: 0, y: 0, width: 1280, height: 800 },
      },
    ];
    model.nodes = [
      {
        identity: {
          sessionId: '',
          frameId: 'root',
          loaderId: 'load',
          backendNodeId: 1,
        },
        nodeId: 2,
        nodeType: 1,
        frameRef,
        inShadowRoot: false,
        scopeNodeId: 1,
        tagName: 'button',
        attributes: { id: 'save' },
        computedStyles: {},
        hidden: false,
        bounds: { x: 0, y: 0, width: 10, height: 10 },
        frameLocalBounds: { x: 0, y: 0, width: 10, height: 10 },
        inViewport: true,
        text: 'Save',
        labelText: 'Save',
        nameText: 'Save',
        ownText: 'Save',
        secret: false,
        insideSecretSelect: false,
        hasSecretDescendant: false,
        childIndexes: [],
      },
    ];
    const builder = jest
      .spyOn(PageModelModule, 'buildPageModelWithFallback')
      .mockResolvedValue(modelBuild(model));
    let queries = 0;
    send.mockImplementation((method) => {
      if (method === 'DOM.querySelectorAll') {
        queries += 1;
        return queries === 1
          ? Promise.reject(new Error('Could not find node with given id'))
          : Promise.resolve({ nodeIds: [2] });
      }
      if (method === 'DOM.describeNode')
        return Promise.resolve({ node: { backendNodeId: 1 } });
      return Promise.resolve({});
    });
    const inspected = await host.inspect(
      { browserId: 'test', locator: '#save' },
      () => Promise.resolve(model.page),
    );
    expect(inspected.attributes.id).toBe('save');
    expect(builder).toHaveBeenCalledTimes(2);
  });

  it('replaces a stale cached model after locator recovery instead of rebuilding on every inspect (minor 6)', async () => {
    const { host, send } = harness();
    const frameRef = host.registry.frameRefFor('root');
    const modelFor = async (rootNodeId: number): Promise<BrowserPageModel> => {
      const model = await emptyModel();
      model.registry = host.registry;
      model.frames = [
        {
          frameId: 'root',
          frameRef,
          sessionId: '',
          loaderId: 'load',
          url: 'https://example.test',
          documentNodeId: rootNodeId,
          queryRootNodeIds: [rootNodeId],
          depth: 0,
          viewportTransform: { x: 0, y: 0, scaleX: 1, scaleY: 1 },
          clip: { x: 0, y: 0, width: 1280, height: 800 },
        },
      ];
      model.nodes = [
        {
          identity: {
            sessionId: '',
            frameId: 'root',
            loaderId: 'load',
            backendNodeId: 1,
          },
          nodeId: rootNodeId + 1,
          nodeType: 1,
          frameRef,
          inShadowRoot: false,
          scopeNodeId: rootNodeId,
          tagName: 'button',
          attributes: { id: 'save' },
          computedStyles: {},
          hidden: false,
          bounds: { x: 0, y: 0, width: 10, height: 10 },
          frameLocalBounds: { x: 0, y: 0, width: 10, height: 10 },
          inViewport: true,
          text: 'Save',
          labelText: 'Save',
          nameText: 'Save',
          ownText: 'Save',
          secret: false,
          insideSecretSelect: false,
          hasSecretDescendant: false,
          childIndexes: [],
        },
      ];
      return model;
    };
    // The first model's frontend IDs are invalidated by a later getDocument.
    const stale = await modelFor(1);
    const fresh = await modelFor(100);
    const builder = jest
      .spyOn(PageModelModule, 'buildPageModelWithFallback')
      .mockResolvedValueOnce(modelBuild(stale))
      .mockResolvedValue(modelBuild(fresh));
    send.mockImplementation((method, params) => {
      if (method === 'DOM.querySelectorAll') {
        return params.nodeId === 1
          ? Promise.reject(new Error('Could not find node with given id'))
          : Promise.resolve({ nodeIds: [101] });
      }
      if (method === 'DOM.describeNode')
        return Promise.resolve({ node: { backendNodeId: 1 } });
      return Promise.resolve({});
    });
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const inspected = await host.inspect(
        { browserId: 'test', locator: '#save' },
        () => Promise.resolve(fresh.page),
      );
      expect(inspected.attributes.id).toBe('save');
    }
    expect(builder).toHaveBeenCalledTimes(2);
    expect((await host.build()).cached).toBe(true);
  });

  it.each(['unknown', 'failed'])(
    'keeps sensitive inspect minimal and safe for %s password history',
    async (history) => {
      const model = await emptyModel();
      const { host, send } = harness();
      const identity = {
        frameId: 'root',
        sessionId: '',
        loaderId: 'load',
        backendNodeId: 1,
      };
      model.registry = host.registry;
      model.frames = [
        {
          frameId: 'root',
          frameRef: host.registry.frameRefFor('root'),
          sessionId: '',
          loaderId: 'load',
          url: 'https://example.test',
          documentNodeId: 1,
          queryRootNodeIds: [1],
          depth: 0,
          viewportTransform: { x: 0, y: 0, scaleX: 1, scaleY: 1 },
          clip: { x: 0, y: 0, width: 1280, height: 800 },
        },
      ];
      model.nodes = [
        {
          identity,
          nodeId: 2,
          nodeType: 1,
          frameRef: host.registry.frameRefFor('root'),
          inShadowRoot: false,
          scopeNodeId: 1,
          tagName: 'input',
          attributes: { type: 'text', value: '[redacted]' },
          computedStyles: {},
          hidden: false,
          bounds: { x: 0, y: 0, width: 10, height: 10 },
          frameLocalBounds: { x: 0, y: 0, width: 10, height: 10 },
          inViewport: true,
          text: '',
          labelText: '',
          ownText: '',
          secret: true,
          insideSecretSelect: false,
          hasSecretDescendant: false,
          childIndexes: [],
        },
      ];
      model.page.runtimeGeneration = 7;
      if (history === 'unknown')
        host.noteEvent('Runtime.executionContextsCleared', {});
      else
        send.mockImplementation((method) =>
          Promise.resolve(
            method === 'DOM.describeNode' ? { node: { backendNodeId: 1 } } : {},
          ),
        );
      expect(await host.isPasswordEverSeen('root', '', [1])).toEqual([true]);
      jest
        .spyOn(PageModelModule, 'buildPageModelWithFallback')
        .mockResolvedValue(modelBuild(model));
      const enrich = jest.spyOn(host, 'enrich').mockResolvedValue({
        locatorCandidates: [],
        domPath: [],
        outerHtml: 'canopy-forbidden-secret',
      });
      const ref = host.registry.mintRef(identity);
      const inspected = await host.inspect({ browserId: 'test', ref }, () =>
        Promise.resolve(model.page),
      );
      expect(enrich).not.toHaveBeenCalled();
      expect(inspected.valueRedacted).toBe(true);
      expect(inspected.value).toBeUndefined();
      expect(inspected.runtimeGeneration).toBe(7);
      expect(JSON.stringify(inspected)).not.toContain(
        'canopy-forbidden-secret',
      );
    },
  );
});
