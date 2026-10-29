import { buildPageModel } from '../page-model';
import { projectInputSnapshot } from '../projections';
import { loadRecording, recordedDeps } from './fixtures/recorded-cdp';
import { PageModelHost } from '../page-model-host';
import { readScrollState, writeScrollBy } from '../scroll-state';
import { ExecutionContexts } from '../execution-contexts';
import { FrameRegistry } from '../frame-registry';
import type { ActionTargetDeps, ResolvedActionTarget } from '../action-targets';
import { resolveTextTarget } from '../action-targets';

it('projects top telemetry unchanged by a frame filter, and omits unavailable telemetry', async () => {
  const model = await buildPageModel(recordedDeps(loadRecording('frames')));
  model.page.telemetry = {
    viewport: { width: 600, height: 400 },
    scroll: { x: 0, y: 120, maxX: 20, maxY: 800 },
  };
  expect(
    projectInputSnapshot(model, {}, model.page, {
      frames: model.frames.slice(1),
    }),
  ).toMatchObject(model.page.telemetry);
  delete model.page.telemetry;
  expect(projectInputSnapshot(model, {}, model.page)).not.toHaveProperty(
    'scroll',
  );
});

it('searches a full text node beyond its compacted display prefix', async () => {
  const model = await buildPageModel(
    recordedDeps(loadRecording('form-controls')),
  );
  const node = model.nodes.find(
    (n) =>
      n.nodeType === 3 &&
      !n.secret &&
      !n.insideSecretSelect &&
      n.parentIndex !== undefined,
  );
  if (!node) throw new Error('Expected recorded text node');
  node.fullText = 'prefix '.repeat(30) + 'Needle HERE';
  const parent = model.nodes[node.parentIndex ?? -1];
  if (!parent) throw new Error('Expected parent');
  parent.hidden = false;
  const send = jest.fn(async (method: string) => {
    await Promise.resolve();
    return method === 'DOM.resolveNode'
      ? { object: { objectId: 'held' } }
      : { result: { value: true } };
  });
  const result = await resolveTextTarget(
    { registry: model.registry, send, contexts: new ExecutionContexts() },
    model,
    'needle here',
  );
  expect(result).toMatchObject({
    status: 'found',
    // The text node is what gets scrolled to; its element is what is held.
    target: {
      identity: parent.identity,
      scrollNode: node.identity.backendNodeId,
    },
  });
});

// "History" first matched a "View history" tab above the History heading.
it('prefers an exact text match, then a same-case one, over an earlier partial match', async () => {
  const model = await buildPageModel(
    recordedDeps(loadRecording('form-controls')),
  );
  const texts = model.nodes.filter(
    (n) =>
      n.nodeType === 3 &&
      !n.secret &&
      !n.insideSecretSelect &&
      n.parentIndex !== undefined &&
      model.nodes[n.parentIndex]?.nodeType === 1,
  );
  if (texts.length < 3) throw new Error('Expected recorded text nodes');
  const [partial, sameCase, exact] = texts;
  for (const node of [partial, sameCase, exact]) {
    const parent = model.nodes[node.parentIndex ?? -1];
    if (parent) {
      parent.hidden = false;
      parent.secret = false;
      parent.insideSecretSelect = false;
    }
  }
  const send = jest.fn(async (method: string) => {
    await Promise.resolve();
    return method === 'DOM.resolveNode'
      ? { object: { objectId: 'held' } }
      : { result: { value: true } };
  });
  const deps = {
    registry: model.registry,
    send,
    contexts: new ExecutionContexts(),
  };
  const scrolledTo = async (query: string): Promise<unknown> => {
    const result = await resolveTextTarget(deps, model, query);
    return result.status === 'found' ? result.target.scrollNode : result.status;
  };

  partial.fullText = 'View history';
  sameCase.fullText = 'History of browsers';
  exact.fullText = '  History ';
  expect(await scrolledTo('History')).toBe(exact.identity.backendNodeId);
  exact.fullText = 'unrelated';
  expect(await scrolledTo('History')).toBe(sameCase.identity.backendNodeId);
  sameCase.fullText = 'unrelated';
  expect(await scrolledTo('History')).toBe(partial.identity.backendNodeId);
});

it('reads snapshot layout dimensions in a host world and omits both fields after loader replacement', async () => {
  const host = new PageModelHost({
    now: Date.now,
    send: async (method: string): Promise<unknown> => {
      await Promise.resolve();

      if (method === 'Page.createIsolatedWorld')
        return { executionContextId: 7 };
      if (method === 'Runtime.evaluate') {
        host.registry.noteFrameNavigated('', {
          id: 'root',
          loaderId: 'new',
          url: 'http://localhost',
        });
        return {
          result: {
            value: {
              viewport: { width: 500, height: 400 },
              scroll: { x: 0, y: 5, maxX: 0, maxY: 10 },
            },
          },
        };
      }
      return {};
    },
  });
  host.registry.noteFrameNavigated('', {
    id: 'root',
    loaderId: 'old',
    url: 'http://localhost',
  });
  await expect(host.readViewportTelemetry()).resolves.toBeUndefined();
  host.dispose();
});

it('resolves the held backend node in its host world for reads and instant writes, and normalizes RTL', async () => {
  const registry = new FrameRegistry();
  registry.noteFrameNavigated('', {
    id: 'root',
    loaderId: 'old',
    url: 'http://localhost',
  });
  const target: ResolvedActionTarget = {
    identity: {
      frameId: 'root',
      sessionId: '',
      loaderId: 'old',
      backendNodeId: 5,
    },
    frameRef: 'f',
    objectId: 'MAIN',
    objectGroup: 'group',
    outOfProcess: false,
  };
  const send = jest.fn(
    async (method: string, params: Record<string, unknown>) => {
      await Promise.resolve();

      if (method === 'Page.createIsolatedWorld')
        return { executionContextId: 7 };
      if (method === 'DOM.resolveNode') return { object: { objectId: 'HOST' } };
      if (
        method === 'Runtime.callFunctionOn' &&
        String(params.functionDeclaration).includes('scrollHeight')
      )
        return {
          result: {
            value: {
              x: 40,
              y: 2,
              maxX: 100,
              maxY: 200,
              width: 100,
              height: 100,
              scrollWidth: 200,
              scrollHeight: 300,
              scriptX: true,
              scriptY: true,
              point: { x: 40, y: 40 },
            },
          },
        };
      return { result: { value: true } };
    },
  );
  const deps = { registry, send, contexts: new ExecutionContexts() };
  expect(await readScrollState(deps, target)).toMatchObject({
    x: 40,
    maxX: 100,
  });
  await writeScrollBy(deps, target, 10, 20);
  expect(
    send.mock.calls
      .filter(([m]) => m === 'DOM.resolveNode')
      .every(([, p]) => p.executionContextId === 7),
  ).toBe(true);
  expect(
    send.mock.calls
      .filter(([m]) => m === 'Runtime.callFunctionOn')
      .every(([, p]) => p.objectId === 'HOST'),
  ).toBe(true);
  expect(
    send.mock.calls.some(([, p]) =>
      String(p.functionDeclaration).includes("behavior: 'instant'"),
    ),
  ).toBe(true);
});

it('normalizes negative RTL scrollLeft in the host-world function', async () => {
  const { runInNewContext } = await import('node:vm');
  const registry = new FrameRegistry();
  registry.noteFrameNavigated('', {
    id: 'root',
    loaderId: 'old',
    url: 'http://localhost',
  });
  const target: ResolvedActionTarget = {
    identity: {
      frameId: 'root',
      sessionId: '',
      loaderId: 'old',
      backendNodeId: 5,
    },
    frameRef: 'f',
    objectId: 'MAIN',
    objectGroup: 'group',
    outOfProcess: false,
  };
  const win = {
    innerWidth: 200,
    innerHeight: 100,
    document: {},
    getComputedStyle: (): {
      direction: string;
      overflowX: string;
      overflowY: string;
    } => ({ direction: 'rtl', overflowX: 'auto', overflowY: 'auto' }),
  };
  const doc = { defaultView: win, scrollingElement: {} };
  win.document = doc;
  const element = {
    ownerDocument: doc,
    isConnected: true,
    scrollWidth: 200,
    scrollHeight: 300,
    clientWidth: 100,
    clientHeight: 100,
    scrollLeft: -60,
    scrollTop: 20,
    getBoundingClientRect: (): {
      left: number;
      right: number;
      top: number;
      bottom: number;
    } => ({ left: 0, right: 100, top: 0, bottom: 100 }),
  };
  const send = (
    method: string,
    params: Record<string, unknown>,
  ): Promise<unknown> => {
    if (method === 'Page.createIsolatedWorld')
      return Promise.resolve({ executionContextId: 7 });
    if (method === 'DOM.resolveNode')
      return Promise.resolve({ object: { objectId: 'HOST' } });
    if (
      method === 'Runtime.callFunctionOn' &&
      typeof params.functionDeclaration === 'string'
    ) {
      const value: unknown = runInNewContext(
        `(${params.functionDeclaration}).call(element)`,
        { element },
      );
      return Promise.resolve({ result: { value } });
    }
    return Promise.resolve({});
  };
  await expect(
    readScrollState(
      { registry, send, contexts: new ExecutionContexts() },
      target,
    ),
  ).resolves.toMatchObject({ x: 40, maxX: 100, y: 20 });
});

it('registers parent-session groups before an ancestor resolve can fail', async () => {
  const { scrollAncestors } = await import('../scroll-state');
  const registry = new FrameRegistry();
  registry.noteFrameNavigated('', {
    id: 'root',
    loaderId: 'r',
    url: 'http://localhost',
  });
  registry.noteFrameNavigated('child-session', {
    id: 'child',
    parentId: 'root',
    loaderId: 'c',
    url: 'http://other',
  });
  const target: ResolvedActionTarget = {
    identity: {
      frameId: 'child',
      sessionId: 'child-session',
      loaderId: 'c',
      backendNodeId: 5,
    },
    frameRef: 'f',
    objectId: 'MAIN',
    objectGroup: 'group',
    outOfProcess: true,
  };
  const register = jest.fn();
  const send = async (
    method: string,
    _params: Record<string, unknown>,
    sessionId?: string,
  ): Promise<unknown> => {
    await Promise.resolve();
    if (method === 'Page.createIsolatedWorld') return { executionContextId: 7 };
    if (method === 'DOM.resolveNode' && sessionId === 'child-session')
      return { object: { objectId: 'HOST' } };
    if (method === 'Runtime.callFunctionOn') return { result: { value: 0 } };
    if (method === 'DOM.getFrameOwner') return { backendNodeId: 8 };
    if (method === 'DOM.resolveNode') {
      expect(register).toHaveBeenCalledWith('');
      throw new Error('parent detached');
    }
    return {};
  };
  await expect(
    scrollAncestors(
      { registry, send, contexts: new ExecutionContexts() },
      target,
      0,
      register,
    ),
  ).rejects.toThrow();
  expect(register).toHaveBeenCalledWith('');
});

it('searches only text the page has laid out', async () => {
  const model = await buildPageModel(
    recordedDeps(loadRecording('form-controls')),
  );
  const send = jest.fn(async (method: string) => {
    await Promise.resolve();
    return method === 'DOM.resolveNode'
      ? { object: { objectId: 'held' } }
      : { result: { value: true } };
  });
  const deps = {
    registry: model.registry,
    send,
    contexts: new ExecutionContexts(),
  };
  // Title, style, script, closed-select option and textarea default text
  // are in the tree but never drawn.
  const undrawn = model.nodes.filter(
    (node) =>
      node.nodeType === 3 &&
      ['title', 'style', 'script', 'option', 'textarea'].includes(
        model.nodes[node.parentIndex ?? -1]?.tagName ?? '',
      ),
  );
  expect(undrawn.length).toBeGreaterThanOrEqual(5);
  expect(undrawn.filter((node) => node.fullText !== undefined)).toEqual([]);
  for (const text of ['font: 14px/1.4 sans-serif', 'Plain text option'])
    await expect(resolveTextTarget(deps, model, text)).resolves.toMatchObject({
      status: 'target_not_found',
    });
  // Drawn text still resolves, to the element that holds it.
  const drawn = model.nodes.find(
    (node) =>
      node.nodeType === 3 &&
      node.fullText !== undefined &&
      node.fullText.length > 3 &&
      model.nodes[node.parentIndex ?? -1]?.tagName === 'button',
  );
  if (!drawn?.fullText) throw new Error('Expected drawn button text');
  await expect(
    resolveTextTarget(deps, model, drawn.fullText),
  ).resolves.toMatchObject({
    status: 'found',
    target: { identity: model.nodes[drawn.parentIndex ?? -1]?.identity },
  });
});

describe('the wheel point', () => {
  const wheelHost = (
    hitNode: Record<string, unknown>,
  ): { host: PageModelHost; target: ResolvedActionTarget } => {
    const host = new PageModelHost({
      now: Date.now,
      send: async (
        method: string,
        params: Record<string, unknown>,
      ): Promise<unknown> => {
        await Promise.resolve();
        if (method === 'Page.createIsolatedWorld')
          return { executionContextId: 7 };
        if (method === 'Page.getLayoutMetrics')
          return { cssLayoutViewport: { pageX: 0, pageY: 0 } };
        if (method === 'DOM.getNodeForLocation')
          return { backendNodeId: 9, frameId: 'root' };
        if (method === 'DOM.describeNode' && params.backendNodeId === 9)
          return { node: { backendNodeId: 9, nodeType: 1, ...hitNode } };
        if (method === 'DOM.resolveNode')
          return {
            object: { objectId: `object-${String(params.backendNodeId)}` },
          };
        // The owner walk from the hit reaches the container either way,
        // past no ancestor that could host a closed root.
        if (method === 'Runtime.callFunctionOn')
          return { result: { type: 'object', objectId: 'unseen' } };
        if (method === 'Runtime.getProperties') return { result: [] };
        return {};
      },
    });
    host.registry.noteFrameNavigated('', {
      id: 'root',
      loaderId: 'loader',
      url: 'http://localhost',
    });
    return {
      host,
      target: {
        identity: {
          frameId: 'root',
          sessionId: '',
          loaderId: 'loader',
          backendNodeId: 5,
        },
        frameRef: 'f',
        objectId: 'MAIN',
        objectGroup: 'group',
        outOfProcess: false,
      },
    };
  };

  it('is the centre when an ordinary element of the container is under it', async () => {
    const { host, target } = wheelHost({ nodeName: 'DIV' });
    await expect(
      host.wheelPoint(target, { x: 30, y: 40 }, 'y'),
    ).resolves.toEqual({ x: 30, y: 40 });
    host.dispose();
  });

  it("is the centre over the document's own <html>, which carries its own frame's id", async () => {
    // Chromium sets frameId on every document element, not only on frame
    // owners. A page whose body is short shows bare <html> at the centre.
    const { host, target } = wheelHost({ nodeName: 'HTML', frameId: 'root' });
    await expect(
      host.wheelPoint(target, { x: 30, y: 40 }, 'y'),
    ).resolves.toEqual({ x: 30, y: 40 });
    host.dispose();
  });

  it('is withheld over a frame: Chromium would send the wheel into its document', async () => {
    // In the container's session a cross-site frame is just its owner
    // element, which is inside the container.
    const { host, target } = wheelHost({
      nodeName: 'IFRAME',
      frameId: 'child',
    });
    await expect(
      host.wheelPoint(target, { x: 30, y: 40 }, 'y'),
    ).resolves.toBeUndefined();
    host.dispose();
  });
});

it("reads an element's box origin as the corner of its bounds, as boundingBox() does", async () => {
  const boxHost = (border: unknown): PageModelHost => {
    const host = new PageModelHost({
      now: Date.now,
      send: async (method: string): Promise<unknown> => {
        await Promise.resolve();
        return method === 'DOM.getBoxModel' ? { model: { border } } : {};
      },
    });
    host.registry.noteFrameNavigated('', {
      id: 'root',
      loaderId: 'loader',
      url: 'http://localhost',
    });
    return host;
  };
  const target: ResolvedActionTarget = {
    identity: {
      frameId: 'root',
      sessionId: '',
      loaderId: 'loader',
      backendNodeId: 5,
    },
    frameRef: 'f',
    objectId: 'MAIN',
    objectGroup: 'group',
    outOfProcess: false,
  };
  // A rotated box: no corner of the quad is the corner of its bounds.
  const rotated = boxHost([30, 10, 130, 30, 110, 130, 10, 110]);
  await expect(rotated.boxOrigin(target)).resolves.toEqual({ x: 10, y: 10 });
  rotated.dispose();
  const unread = boxHost([30, 10, 'x']);
  await expect(unread.boxOrigin(target)).resolves.toBeUndefined();
  unread.dispose();
});

/** Fake DOM for the page-side scroll functions, which run here in a VM. */
type FakeNode = Record<string, unknown>;

function fakeDocument(): {
  doc: FakeNode;
  page: FakeNode;
  element: (properties?: FakeNode) => FakeNode;
} {
  const win: FakeNode = {
    innerWidth: 800,
    innerHeight: 600,
    getComputedStyle: (node: FakeNode): unknown => ({
      direction: 'ltr',
      display: 'block',
      flexDirection: 'row',
      flexWrap: 'nowrap',
      writingMode: 'horizontal-tb',
      overflowX: 'visible',
      overflowY: 'visible',
      ...(typeof node.style === 'object' ? node.style : {}),
    }),
  };
  const doc: FakeNode = { defaultView: win };
  win.document = doc;
  const element = (properties: FakeNode = {}): FakeNode => ({
    nodeType: 1,
    localName: 'div',
    ownerDocument: doc,
    isConnected: true,
    assignedSlot: null,
    parentElement: null,
    shadowRoot: null,
    scrollWidth: 100,
    clientWidth: 100,
    scrollHeight: 100,
    clientHeight: 100,
    scrollLeft: 0,
    scrollTop: 0,
    getRootNode: (): FakeNode => doc,
    getBoundingClientRect: (): FakeNode => ({
      left: 0,
      right: 100,
      top: 0,
      bottom: 100,
    }),
    ...properties,
  });
  const page = element({ localName: 'html', scrollHeight: 3000 });
  doc.scrollingElement = page;
  doc.documentElement = page;
  return { doc, page, element };
}

/** A CDP send that runs each page function on the fake objects by id. */
function fakeSend(
  objects: Record<string, FakeNode>,
  closedHosts: FakeNode[] = [],
): ActionTargetDeps['send'] {
  const ids = new Map<unknown, string>(
    Object.entries(objects).map(([id, object]) => [object, id]),
  );
  const lists = new Map<string, unknown[]>();
  return async (method, params) => {
    const { runInNewContext } = await import('node:vm');
    if (method === 'Page.createIsolatedWorld') return { executionContextId: 7 };
    if (method === 'DOM.resolveNode')
      return {
        object: {
          objectId: params.backendNodeId === 5 ? 'owner' : 'hit',
        },
      };
    if (
      method === 'Runtime.callFunctionOn' &&
      typeof params.functionDeclaration === 'string' &&
      typeof params.objectId === 'string'
    ) {
      const supplied = Array.isArray(params.arguments) ? params.arguments : [];
      const args = supplied.map((argument: FakeNode) =>
        typeof argument.objectId === 'string'
          ? objects[argument.objectId]
          : argument.value,
      );
      const value: unknown = runInNewContext(
        `(${params.functionDeclaration}).apply(self, args)`,
        { self: objects[params.objectId], args },
      );
      if (Array.isArray(value)) {
        const id = `list-${String(lists.size)}`;
        lists.set(id, value);
        return { result: { type: 'object', objectId: id } };
      }
      return { result: { value } };
    }
    if (
      method === 'Runtime.getProperties' &&
      typeof params.objectId === 'string'
    )
      return {
        result: (lists.get(params.objectId) ?? []).map((item, index) => ({
          name: String(index),
          value: { type: 'object', objectId: ids.get(item) },
        })),
      };
    if (method === 'DOM.describeNode' && typeof params.objectId === 'string')
      return {
        node: {
          backendNodeId: 40,
          nodeType: 1,
          ...(closedHosts.includes(objects[params.objectId])
            ? { shadowRoots: [{ backendNodeId: 41, shadowRootType: 'closed' }] }
            : {}),
        },
      };
    return {};
  };
}

function ownerTarget(): {
  registry: FrameRegistry;
  target: ResolvedActionTarget;
} {
  const registry = new FrameRegistry();
  registry.noteFrameNavigated('', {
    id: 'root',
    loaderId: 'loader',
    url: 'http://localhost',
  });
  return {
    registry,
    target: {
      identity: {
        frameId: 'root',
        sessionId: '',
        loaderId: 'loader',
        backendNodeId: 5,
      },
      frameRef: 'f',
      objectId: 'MAIN',
      objectGroup: 'group',
      outOfProcess: false,
    },
  };
}

describe('the wheel owner follows the flat tree', () => {
  const scroller = { overflowY: 'auto' };
  const matches = async (
    objects: Record<string, FakeNode>,
    closedHosts: FakeNode[] = [],
  ): Promise<boolean> => {
    const { wheelOwnerMatches } = await import('../scroll-state');
    const { registry, target } = ownerTarget();
    return wheelOwnerMatches(
      {
        registry,
        send: fakeSend(objects, closedHosts),
        contexts: new ExecutionContexts(),
      },
      target,
      9,
      'y',
    );
  };

  it('is the page for ordinary content', async () => {
    const { page, element } = fakeDocument();
    const section = element({ parentElement: page });
    const hit = element({ parentElement: section });
    await expect(matches({ owner: page, hit, section })).resolves.toBe(true);
  });

  it('is a scroller around the slot for content slotted into an open root', async () => {
    const { page, element } = fakeDocument();
    const host = element({ parentElement: page, shadowRoot: {} });
    const root: FakeNode = { host };
    // <div style="overflow: auto"><slot></slot></div> in the host's tree.
    const wrapper = element({
      style: scroller,
      scrollHeight: 900,
      getRootNode: (): FakeNode => root,
    });
    const slot = element({
      localName: 'slot',
      parentElement: wrapper,
      getRootNode: (): FakeNode => root,
    });
    const hit = element({ parentElement: host, assignedSlot: slot });
    await expect(
      matches({ owner: page, hit, host, wrapper, slot }),
    ).resolves.toBe(false);
    // Asked to scroll that wrapper, the same wheel is the right one.
    await expect(
      matches({ owner: wrapper, hit, host, slot, page }),
    ).resolves.toBe(true);
  });

  it('is unknown under a closed root, whose slots script cannot see', async () => {
    const { page, element } = fakeDocument();
    const host = element({ parentElement: page });
    const hit = element({ parentElement: host });
    const objects = { owner: page, hit, host };
    await expect(matches(objects, [host])).resolves.toBe(false);
    // The same tree without a root on the parent is ordinary content.
    await expect(matches(objects)).resolves.toBe(true);
  });
});

describe('scroll offsets of reversed containers', () => {
  const state = async (properties: FakeNode): Promise<unknown> => {
    const { page, element } = fakeDocument();
    const list = element({
      parentElement: page,
      scrollHeight: 1100,
      scrollWidth: 100,
      ...properties,
    });
    const { registry, target } = ownerTarget();
    return readScrollState(
      {
        registry,
        send: fakeSend({ owner: list }),
        contexts: new ExecutionContexts(),
      },
      target,
    );
  };
  const reversed = { display: 'flex', flexDirection: 'column-reverse' };

  it('counts a negative offset from the top of the range', async () => {
    // column-reverse: 0 is the bottom, and scrolling up goes negative.
    await expect(
      state({ style: reversed, scrollTop: -400 }),
    ).resolves.toMatchObject({ y: 600, maxY: 1000 });
    await expect(
      state({ style: reversed, scrollTop: -1000 }),
    ).resolves.toMatchObject({ y: 0, maxY: 1000 });
  });

  it('reads a reversed container at rest as being at its end', async () => {
    await expect(
      state({ style: reversed, scrollTop: 0 }),
    ).resolves.toMatchObject({ y: 1000, maxY: 1000 });
    await expect(state({ scrollTop: 0 })).resolves.toMatchObject({
      y: 0,
      maxY: 1000,
    });
    await expect(state({ scrollTop: 250 })).resolves.toMatchObject({ y: 250 });
  });
});

it('reads the snapshot viewport from the scrolling element, which in quirks mode is the body', async () => {
  const { runInNewContext } = await import('node:vm');
  const registry = new FrameRegistry();
  registry.noteFrameNavigated('', {
    id: 'root',
    loaderId: 'loader',
    url: 'http://localhost',
  });
  // Quirks mode: html is as tall as its content; body reports the viewport.
  const html = { clientWidth: 800, clientHeight: 3000 };
  const body = {
    clientWidth: 800,
    clientHeight: 600,
    scrollWidth: 800,
    scrollHeight: 3000,
    scrollLeft: 0,
    scrollTop: 120,
  };
  const send: ActionTargetDeps['send'] = async (method, params) => {
    await Promise.resolve();
    if (method === 'Page.createIsolatedWorld') return { executionContextId: 7 };
    if (
      method === 'Runtime.evaluate' &&
      typeof params.expression === 'string'
    ) {
      const value: unknown = runInNewContext(params.expression, {
        document: { documentElement: html, scrollingElement: body },
        innerWidth: 815,
        innerHeight: 600,
        getComputedStyle: (): unknown => ({
          direction: 'ltr',
          display: 'block',
          flexDirection: 'row',
          flexWrap: 'nowrap',
          writingMode: 'horizontal-tb',
        }),
      });
      return { result: { value } };
    }
    return {};
  };
  const { readViewportTelemetry } = await import('../scroll-state');
  await expect(
    readViewportTelemetry({
      registry,
      send,
      contexts: new ExecutionContexts(),
    }),
  ).resolves.toEqual({
    viewport: { width: 800, height: 600 },
    scroll: { x: 0, y: 120, maxX: 0, maxY: 2400 },
  });
});

it('scrolls to text that sits directly in a shadow root by its host', async () => {
  const model = await buildPageModel(recordedDeps(loadRecording('shadow')));
  const root = model.nodes.find((node) => node.nodeType === 11);
  if (!root) throw new Error('Expected a recorded shadow root');
  const rootIndex = model.nodes.indexOf(root);
  const host = model.nodes[root.parentIndex ?? -1];
  if (!host) throw new Error('Expected the shadow host');
  const text = model.nodes.find(
    (node) => node.nodeType === 3 && node.fullText !== undefined,
  );
  if (!text) throw new Error('Expected recorded text');
  // As in <host>#shadow-root: "Loading…" <slot></slot>.
  text.parentIndex = rootIndex;
  text.fullText = 'bare text of the phase 05 root';
  host.hidden = false;
  const send = jest.fn(async (method: string) => {
    await Promise.resolve();
    return method === 'DOM.resolveNode'
      ? { object: { objectId: 'held' } }
      : { result: { value: true } };
  });
  await expect(
    resolveTextTarget(
      { registry: model.registry, send, contexts: new ExecutionContexts() },
      model,
      'Bare text of the phase 05 root',
    ),
  ).resolves.toMatchObject({
    status: 'found',
    target: { identity: host.identity },
  });
});

describe('scrolling to matched text', () => {
  /** The replay's page function, run on the fake DOM as the page runs it. */
  const centre = async (
    node: FakeNode,
    text: string,
    look?: boolean,
  ): Promise<unknown> => {
    const { CENTER_TEXT_MATCH } = await import('../scroll-state');
    const { runInNewContext } = await import('node:vm');
    const result: unknown = runInNewContext(
      `(${CENTER_TEXT_MATCH})(node, text, look)`,
      { node, text, look },
    );
    return result;
  };

  /** A document whose ranges report `match()` for the words and `whole` for a whole node. */
  const ranged = (
    match: () => FakeNode,
    whole: FakeNode = { top: 0, bottom: 0, left: 0, right: 0 },
  ): ReturnType<typeof fakeDocument> & {
    offsets: Array<[string, number]>;
  } => {
    const fake = fakeDocument();
    const offsets: Array<[string, number]> = [];
    fake.doc.createRange = (): FakeNode => {
      let all = false;
      return {
        setStart: (_node: unknown, offset: number): void => {
          offsets.push(['start', offset]);
        },
        setEnd: (_node: unknown, offset: number): void => {
          offsets.push(['end', offset]);
        },
        selectNodeContents: (): void => {
          all = true;
        },
        getBoundingClientRect: (): FakeNode => (all ? whole : match()),
      };
    };
    fake.page.scrollBy = (): void => {};
    return { ...fake, offsets };
  };

  const textIn = (doc: FakeNode, parent: FakeNode): FakeNode => ({
    nodeType: 3,
    data: 'Line 1\n   Line 60 HERE\nLine 61',
    ownerDocument: doc,
    parentElement: parent,
    assignedSlot: null,
    getRootNode: (): FakeNode => doc,
  });

  it('centres the matched words, not the text node, in the scroller that hides them', async () => {
    // One text node holding a whole log, as a <pre> does.
    let match = { top: 900, bottom: 918, left: 10, right: 90 };
    const { doc, page, element, offsets } = ranged(() => match);
    const scrolls: Array<[string, unknown]> = [];
    const log = element({
      parentElement: page,
      getBoundingClientRect: (): FakeNode => ({
        top: 100,
        bottom: 300,
        left: 0,
        right: 400,
      }),
      scrollBy: (by: FakeNode): void => {
        scrolls.push(['log', by]);
        match = { top: 191, bottom: 209, left: 10, right: 90 };
      },
    });
    page.scrollBy = (by: FakeNode): void => {
      scrolls.push(['page', by]);
    };
    const text = textIn(doc, log);
    await expect(centre(text, 'line 60 here')).resolves.toBe(true);
    // "Line 60 HERE" is characters 10 to 21 of the node.
    expect(offsets).toEqual([
      ['start', 10],
      ['end', 22],
    ]);
    // Only the axis that hides the match moves, and only the box that hides it.
    expect(scrolls).toEqual([
      ['log', { left: 0, top: 709, behavior: 'instant' }],
    ]);
    // Words that are no longer in the node are neither shown nor hidden.
    await expect(centre(text, 'absent')).resolves.toBeNull();
  });

  it('scrolls a scaled container by its own pixels, not by the pixels measured on screen', async () => {
    // transform: scale(2): 200 by 100 of layout fills 400 by 200 of screen,
    // and one pixel of scroll moves the content two pixels on screen.
    let scrolled = 0;
    const scrolls: unknown[] = [];
    const { doc, page, element } = ranged(() => ({
      top: 900 - scrolled * 2,
      bottom: 918 - scrolled * 2,
      left: 10,
      right: 90,
    }));
    const log = element({
      parentElement: page,
      offsetWidth: 200,
      offsetHeight: 100,
      style: { overflowY: 'auto' },
      getBoundingClientRect: (): FakeNode => ({
        top: 100,
        bottom: 300,
        left: 0,
        right: 400,
      }),
    });
    log.scrollBy = (by: { top: number }): void => {
      scrolls.push(by);
      scrolled += by.top;
      log.scrollTop = scrolled;
    };
    await expect(centre(textIn(doc, log), 'line 60 here')).resolves.toBe(true);
    // 709 pixels of screen is 354.5 of the container's own.
    expect(scrolls).toEqual([{ left: 0, top: 354.5, behavior: 'instant' }]);
  });

  /** A box that clips the words and has nothing to scroll (overflow: hidden). */
  const clipped = (): {
    text: FakeNode;
    pageY: () => number;
    deps: ActionTargetDeps;
    target: ResolvedActionTarget;
  } => {
    let pageY = 0;
    const { doc, page, element } = ranged(() => ({
      top: 900 - pageY,
      bottom: 918 - pageY,
      left: 10,
      right: 90,
    }));
    const log = element({
      parentElement: page,
      style: { overflowY: 'hidden' },
      getBoundingClientRect: (): FakeNode => ({
        top: 100 - pageY,
        bottom: 300 - pageY,
        left: 0,
        right: 400,
      }),
      scrollBy: (): void => {},
    });
    page.scrollBy = (by: { top: number }): void => {
      pageY += by.top;
      page.scrollTop = pageY;
    };
    const text = textIn(doc, log);
    const { registry, target } = ownerTarget();
    return {
      text,
      pageY: () => pageY,
      deps: {
        registry,
        send: fakeSend({ owner: log, hit: text }),
        contexts: new ExecutionContexts(),
      },
      target: { ...target, scrollNode: 9 },
    };
  };

  it('reports words that a box still clips after every scroll', async () => {
    const { text, pageY } = clipped();
    await expect(centre(text, 'line 60 here')).resolves.toBe(false);
    // The page did bring them into the viewport; the box is what hides them.
    expect(pageY()).toBe(609);
  });

  it('centres text that is slotted, in the scroller around its slot', async () => {
    // <host>the log</host>, with <div overflow:auto><slot></slot></div> in
    // the host's open root: the text's parent in the flat tree is the slot.
    let scrolled = 0;
    const { doc, page, element } = ranged(() => ({
      top: 900 - scrolled,
      bottom: 918 - scrolled,
      left: 10,
      right: 90,
    }));
    const box = (): FakeNode => ({
      top: 100,
      bottom: 300,
      left: 0,
      right: 400,
    });
    const hostElement = element({
      parentElement: page,
      localName: 'x-log',
      getBoundingClientRect: box,
      scrollBy: (): void => {},
    });
    const root: FakeNode = { host: hostElement };
    const wrapper = element({
      style: { overflowY: 'auto' },
      getRootNode: (): FakeNode => root,
      getBoundingClientRect: box,
    });
    wrapper.scrollBy = (by: { top: number }): void => {
      scrolled += by.top;
      wrapper.scrollTop = scrolled;
    };
    const slot = element({
      localName: 'slot',
      parentElement: wrapper,
      getRootNode: (): FakeNode => root,
      getBoundingClientRect: (): FakeNode => ({
        top: 0,
        bottom: 0,
        left: 0,
        right: 0,
      }),
      scrollBy: (): void => {},
    });
    const text = { ...textIn(doc, hostElement), assignedSlot: slot };
    await expect(centre(text, 'line 60 here')).resolves.toBe(true);
    expect(scrolled).toBe(709);
    // With the scroller back at the top the words are clipped, and a look
    // says so without moving anything.
    scrolled = 0;
    await expect(centre(text, 'line 60 here', true)).resolves.toBe(false);
    expect(scrolled).toBe(0);
  });

  it('measures the words from the corner of their text node, for the scroll Chromium does', async () => {
    const { textMatchRect } = await import('../scroll-state');
    const { doc, page, element } = ranged(
      () => ({ top: 1575, bottom: 1590, left: 34, right: 167.5 }),
      { top: 90, bottom: 3090, left: 24, right: 220 },
    );
    const log = element({ parentElement: page });
    const text = textIn(doc, log);
    const { registry, target } = ownerTarget();
    const deps = {
      registry,
      send: fakeSend({ owner: log, hit: text }),
      contexts: new ExecutionContexts(),
    };
    await expect(
      textMatchRect(deps, { ...target, scrollNode: 9 }, 'line 60 here'),
    ).resolves.toEqual({ x: 10, y: 1485, width: 133.5, height: 15 });
    await expect(
      textMatchRect(deps, { ...target, scrollNode: 9 }, 'absent'),
    ).resolves.toBeUndefined();
    // Not a text match: there is no node to measure in.
    await expect(
      textMatchRect(deps, target, 'line 60 here'),
    ).resolves.toBeUndefined();
  });

  it('looks at where the words are without scrolling anything', async () => {
    const { textMatchShown } = await import('../scroll-state');
    const { deps, target, pageY } = clipped();
    await expect(textMatchShown(deps, target, 'line 60 here')).resolves.toBe(
      false,
    );
    expect(pageY()).toBe(0);
    await expect(
      textMatchShown(deps, target, 'absent'),
    ).resolves.toBeUndefined();
  });
});

it('collects the scrollers of a text match from its text node, through its slot', async () => {
  const { scrollAncestors } = await import('../scroll-state');
  const { runInNewContext } = await import('node:vm');
  const { doc, page, element } = fakeDocument();
  // <x-log>text</x-log> with <div overflow:auto><slot></slot></div> in its
  // open root. Walking up from <x-log> never meets that <div>.
  const hostElement = element({ parentElement: page, localName: 'x-log' });
  const root: FakeNode = { host: hostElement };
  const wrapper = element({
    scrollHeight: 900,
    getRootNode: (): FakeNode => root,
  });
  const slot = element({
    localName: 'slot',
    parentElement: wrapper,
    getRootNode: (): FakeNode => root,
  });
  const text: FakeNode = {
    nodeType: 3,
    ownerDocument: doc,
    parentElement: hostElement,
    assignedSlot: slot,
    getRootNode: (): FakeNode => doc,
  };
  const nodes = new Map<number, FakeNode>([
    [9, text],
    [5, hostElement],
    [31, slot],
    [32, wrapper],
    [1, page],
  ]);
  const backendId = (node: unknown): number | undefined =>
    Array.from(nodes).find(([, candidate]) => candidate === node)?.[0];
  const send: ActionTargetDeps['send'] = async (method, params) => {
    await Promise.resolve();
    if (method === 'Page.createIsolatedWorld') return { executionContextId: 7 };
    if (method === 'DOM.resolveNode')
      return { object: { objectId: `node-${String(params.backendNodeId)}` } };
    const self =
      typeof params.objectId === 'string'
        ? nodes.get(Number(params.objectId.slice(5)))
        : undefined;
    if (method === 'DOM.describeNode')
      return { node: { backendNodeId: backendId(self), nodeType: 1 } };
    if (
      method === 'Runtime.callFunctionOn' &&
      typeof params.functionDeclaration === 'string'
    ) {
      const supplied = Array.isArray(params.arguments) ? params.arguments : [];
      const value: unknown = runInNewContext(
        `(${params.functionDeclaration}).apply(self, args)`,
        { self, args: supplied.map((argument: FakeNode) => argument.value) },
      );
      const id = backendId(value);
      return id === undefined
        ? { result: { value } }
        : { result: { type: 'object', objectId: `node-${String(id)}` } };
    }
    return {};
  };
  const { registry, target } = ownerTarget();
  const deps = { registry, send, contexts: new ExecutionContexts() };
  const ancestors = await scrollAncestors(deps, { ...target, scrollNode: 9 });
  // The page scrolls too (3,000 px tall in this fake); the slot and the
  // host do not.
  expect(ancestors.map((ancestor) => ancestor.identity.backendNodeId)).toEqual([
    32, 1,
  ]);
  expect(ancestors.every((ancestor) => ancestor.scrollNode === undefined)).toBe(
    true,
  );
  // From the element itself, as for scroll into view, the slot is not on the way.
  const fromElement = await scrollAncestors(deps, target);
  expect(
    fromElement.map((ancestor) => ancestor.identity.backendNodeId),
  ).toEqual([1]);
});
