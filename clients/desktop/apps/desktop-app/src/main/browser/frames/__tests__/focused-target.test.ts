/**
 * @jest-environment jsdom
 */
import {
  resolveFocusedTarget,
  type ActionTargetDeps,
  type ActionTargetResolution,
} from '../action-targets';
import { ExecutionContexts } from '../execution-contexts';
import { buildPageModel } from '../page-model';
import { loadRecording, recordedDeps } from './fixtures/recorded-cdp';

/**
 * Review R1 finding 2: an untargeted press resolves the element that has
 * focus, through closed shadow roots too. Focus is real (a jsdom realm whose
 * nodes stand for the recorded `shadow` page's), and every function the
 * host sends is evaluated in that realm; CDP's part (describe with pierce,
 * resolve by backend id) answers in Chromium's shapes.
 */

beforeAll(() => {
  // jsdom lacks structuredClone; the fixture records are JSON only.
  Reflect.set(globalThis, 'structuredClone', (value: unknown): unknown => {
    const copy: unknown = JSON.parse(JSON.stringify(value));
    return copy;
  });
});

/** Recorded backend ids of the `shadow` page. */
const IDS = {
  closedHost: 60,
  closedRoot: 61,
  closedInput: 64,
  closedInputAgentRoot: 65,
  nestHost: 85,
  nestRoot: 86,
  innerHost: 87,
  innerRoot: 88,
  deep: 89,
};

interface Page {
  view: Window;
  document: Document;
  evaluate(source: string): unknown;
  closedHost: HTMLElement;
  closedInput: HTMLElement;
  deep: HTMLElement;
  /** Closed roots by host, as only CDP can reach them. */
  roots: Map<Element, ShadowRoot>;
}

function page(): Page {
  const frame = document.createElement('iframe');
  document.body.append(frame);
  const view = frame.contentWindow;
  const doc = frame.contentDocument;
  if (!view || !doc?.body) throw new Error('No realm');
  doc.body.innerHTML =
    '<x-card id="closed-host" tabindex="0"></x-card><section id="nest-host"></section>';
  const roots = new Map<Element, ShadowRoot>();
  const closedHost = doc.getElementById('closed-host');
  const nestHost = doc.getElementById('nest-host');
  if (!closedHost || !nestHost) throw new Error('No hosts');
  const closed = closedHost.attachShadow({ mode: 'closed' });
  roots.set(closedHost, closed);
  closed.innerHTML = '<input id="closed-input">';
  const outer = nestHost.attachShadow({ mode: 'open' });
  roots.set(nestHost, outer);
  outer.innerHTML = '<div id="inner-host"></div>';
  const innerHost = outer.getElementById('inner-host');
  if (!innerHost) throw new Error('No inner host');
  const inner = innerHost.attachShadow({ mode: 'closed' });
  roots.set(innerHost, inner);
  inner.innerHTML = '<button id="deep">Deep</button>';
  const closedInput = closed.getElementById('closed-input');
  const deep = inner.getElementById('deep');
  if (!closedInput || !deep) throw new Error('No targets');
  return {
    view,
    document: doc,
    evaluate: (source): unknown => {
      const evaluator: unknown = Reflect.get(view, 'eval');
      if (typeof evaluator !== 'function') throw new Error('No eval');
      const value: unknown = Reflect.apply(evaluator, view, [source]);
      return value;
    },
    closedHost,
    closedInput,
    deep,
    roots,
  };
}

/** `instanceof` the page realm's constructor (not this test realm's). */
function isRealmNode(
  target: Page,
  name: 'Element',
  value: unknown,
): value is Element;
function isRealmNode(
  target: Page,
  name: 'ShadowRoot',
  value: unknown,
): value is ShadowRoot;
function isRealmNode(
  target: Page,
  name: 'Element' | 'ShadowRoot',
  value: unknown,
): boolean {
  const constructor: unknown = Reflect.get(target.view, name);
  return typeof constructor === 'function' && value instanceof constructor;
}

function backendIdOf(target: Page, node: unknown): number | undefined {
  if (node === target.closedHost) return IDS.closedHost;
  if (node === target.closedInput) return IDS.closedInput;
  if (node === target.deep) return IDS.deep;
  if (node === target.roots.get(target.closedHost)) return IDS.closedRoot;
  const nestHost = target.document.getElementById('nest-host');
  if (node === nestHost) return IDS.nestHost;
  if (nestHost && node === target.roots.get(nestHost)) return IDS.nestRoot;
  for (const [host, root] of Array.from(target.roots.entries())) {
    if (host.id === 'inner-host') {
      if (node === host) return IDS.innerHost;
      if (node === root) return IDS.innerRoot;
    }
  }
  return undefined;
}

async function resolve(
  target: Page,
  options: { failRootRead?: boolean } = {},
): Promise<{ resolution: ActionTargetResolution; methods: string[] }> {
  const recording = loadRecording('shadow');
  const replay = recordedDeps(recording);
  await buildPageModel(replay);
  const objects = new Map<string, unknown>();
  let next = 0;
  const register = (value: unknown): string => {
    next += 1;
    const id = `object-${next}`;
    objects.set(id, value);
    return id;
  };
  const byBackendId = (backendNodeId: number): unknown => {
    for (const node of [
      target.closedHost,
      target.closedInput,
      target.deep,
      ...Array.from(target.roots.keys()),
      ...Array.from(target.roots.values()),
    ]) {
      if (backendIdOf(target, node) === backendNodeId) return node;
    }
    return undefined;
  };
  const methods: string[] = [];
  const send: ActionTargetDeps['send'] = (method, params) => {
    methods.push(method);
    if (method === 'Page.createIsolatedWorld')
      return Promise.resolve({ executionContextId: 30 });
    if (method === 'Runtime.evaluate') {
      const value = target.evaluate(String(params.expression));
      return Promise.resolve({
        result:
          value === null
            ? { type: 'object', subtype: 'null', value: null }
            : { type: 'object', subtype: 'node', objectId: register(value) },
      });
    }
    if (method === 'DOM.describeNode') {
      const value =
        typeof params.objectId === 'string'
          ? objects.get(params.objectId)
          : byBackendId(Number(params.backendNodeId));
      const backendNodeId = backendIdOf(target, value);
      if (backendNodeId === undefined)
        return Promise.reject(new Error('Could not find node'));
      const shadowRoots: Array<Record<string, unknown>> = [];
      // Chromium reports roots (user-agent ones too) only with pierce.
      if (params.pierce === true && isRealmNode(target, 'Element', value)) {
        const root = target.roots.get(value);
        if (root)
          shadowRoots.push({
            nodeId: 0,
            backendNodeId: backendIdOf(target, root),
            nodeType: 11,
            nodeName: '#document-fragment',
            shadowRootType: root.mode,
          });
        if (value === target.closedInput)
          shadowRoots.push({
            nodeId: 0,
            backendNodeId: IDS.closedInputAgentRoot,
            nodeType: 11,
            nodeName: '#document-fragment',
            shadowRootType: 'user-agent',
          });
      }
      return Promise.resolve({
        node: {
          nodeId: 0,
          backendNodeId,
          nodeType: isRealmNode(target, 'ShadowRoot', value) ? 11 : 1,
          nodeName: 'X',
          ...(shadowRoots.length > 0 ? { shadowRoots } : {}),
        },
      });
    }
    if (method === 'DOM.resolveNode') {
      const value = byBackendId(Number(params.backendNodeId));
      return value === undefined
        ? Promise.reject(new Error('No node with given id found'))
        : Promise.resolve({ object: { objectId: register(value) } });
    }
    if (method === 'Runtime.callFunctionOn') {
      const self = objects.get(String(params.objectId));
      if (isRealmNode(target, 'ShadowRoot', self)) {
        if (options.failRootRead)
          return Promise.reject(new Error('Execution context was destroyed.'));
        const fn: unknown = target.evaluate(
          `(${String(params.functionDeclaration)})`,
        );
        if (typeof fn !== 'function') throw new Error('Not a function');
        const value: unknown = Reflect.apply(fn, self, []);
        return Promise.resolve({
          result:
            value === null
              ? { type: 'object', subtype: 'null', value: null }
              : { type: 'object', subtype: 'node', objectId: register(value) },
        });
      }
      // The retained target's connectedness check.
      return Promise.resolve({ result: { type: 'boolean', value: true } });
    }
    if (method === 'Runtime.releaseObjectGroup') return Promise.resolve({});
    return Promise.reject(new Error(`Unexpected ${method}`));
  };
  return {
    resolution: await resolveFocusedTarget({
      send,
      registry: replay.registry,
      contexts: new ExecutionContexts(),
    }),
    methods,
  };
}

function focus(element: HTMLElement): void {
  const method: unknown = Reflect.get(element, 'focus');
  if (typeof method !== 'function') throw new Error('Not focusable');
  Reflect.apply(method, element, []);
}

describe('the focused element behind closed shadow roots (review R1 finding 2)', () => {
  it('follows focus into a closed root to the input, not its host', async () => {
    const target = page();
    focus(target.closedInput);
    expect(target.document.activeElement).toBe(target.closedHost);
    const { resolution } = await resolve(target);
    expect(resolution).toMatchObject({
      status: 'found',
      target: { identity: { backendNodeId: IDS.closedInput } },
    });
  });

  it('follows nested open and closed roots', async () => {
    const target = page();
    focus(target.deep);
    const { resolution } = await resolve(target);
    expect(resolution).toMatchObject({
      status: 'found',
      target: { identity: { backendNodeId: IDS.deep } },
    });
  });

  it('reports a focused host itself when nothing in its root has focus', async () => {
    const target = page();
    focus(target.closedHost);
    const { resolution } = await resolve(target);
    expect(resolution).toMatchObject({
      status: 'found',
      target: { identity: { backendNodeId: IDS.closedHost } },
    });
  });

  it('fails rather than report the host when its root cannot be read', async () => {
    const target = page();
    focus(target.closedInput);
    const { resolution } = await resolve(target, { failRootRead: true });
    expect(resolution.status).toBe('target_not_found');
  });
});
