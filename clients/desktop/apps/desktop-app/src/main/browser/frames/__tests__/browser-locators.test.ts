import type {
  BrowserPageModel,
  PageModelFrame,
  PageModelNode,
} from '../model-types';
import { parseLocator } from '@canopy/desktop-shared/browser/locator-grammar';
import { FrameRegistry, type NodeIdentity } from '../frame-registry';
import {
  evaluateLocator,
  isStaleLocatorError,
  type LocatorEvaluationDeps,
  type ParsedLocator,
} from '../locators';
import { buildPageModel } from '../page-model';
import { isInteractiveAttributes, roleForAttributes } from '../model-semantics';
import {
  loadRecording,
  recordedDeps,
  recordedSend,
} from './fixtures/recorded-cdp';

interface NodeFixture {
  identity: NodeIdentity;
  frameRef: string;
  nodeId: number;
  scopeNodeId: number;
  tagName: string;
  nodeType?: number;
  attributes?: Record<string, string>;
  text?: string;
  labelText?: string;
  ownText?: string;
  childIndexes?: number[];
  parentIndex?: number;
  childFrameId?: string;
  insideSecretSelect?: boolean;
  secret?: boolean;
  hasSecretDescendant?: boolean;
}

interface SendCall {
  method: string;
  params: Record<string, unknown>;
  sessionId?: string;
}

interface FakeDeps {
  deps: LocatorEvaluationDeps;
  calls: SendCall[];
}

const RECTANGLE = { x: 0, y: 0, width: 10, height: 10 };

function identity(
  frameId: string,
  sessionId: string,
  loaderId: string,
  backendNodeId: number,
): NodeIdentity {
  return { frameId, sessionId, loaderId, backendNodeId };
}

function frame(
  frameId: string,
  sessionId: string,
  loaderId: string,
  frameRef: string,
  queryRootNodeIds: number[],
  options: {
    parentFrameId?: string;
    ownerNodeIndex?: number;
    url?: string;
  } = {},
): PageModelFrame {
  const documentNodeId = queryRootNodeIds[0] ?? 0;
  return {
    frameId,
    frameRef,
    sessionId,
    loaderId,
    url: options.url ?? `https://${frameId}.example/page`,
    documentNodeId,
    queryRootNodeIds,
    depth: options.parentFrameId === undefined ? 0 : 1,
    viewportTransform: { x: 0, y: 0, scaleX: 1, scaleY: 1 },
    clip: { x: 0, y: 0, width: 1280, height: 800 },
    ...(options.parentFrameId === undefined
      ? {}
      : { parentFrameId: options.parentFrameId }),
    ...(options.ownerNodeIndex === undefined
      ? {}
      : { ownerNodeIndex: options.ownerNodeIndex }),
  };
}

function node(fixture: NodeFixture): PageModelNode {
  return {
    identity: fixture.identity,
    nodeId: fixture.nodeId,
    nodeType: fixture.nodeType ?? 1,
    frameRef: fixture.frameRef,
    inShadowRoot: false,
    scopeNodeId: fixture.scopeNodeId,
    tagName: fixture.tagName,
    attributes: fixture.attributes ?? {},
    computedStyles: {},
    hidden: false,
    bounds: RECTANGLE,
    frameLocalBounds: RECTANGLE,
    inViewport: true,
    text: fixture.text ?? '',
    labelText: fixture.labelText ?? '',
    ownText: fixture.ownText ?? '',
    secret: fixture.secret ?? false,
    insideSecretSelect: fixture.insideSecretSelect ?? false,
    hasSecretDescendant: fixture.hasSecretDescendant ?? false,
    childIndexes: fixture.childIndexes ?? [],
    ...(fixture.parentIndex === undefined
      ? {}
      : { parentIndex: fixture.parentIndex }),
    ...(fixture.childFrameId === undefined
      ? {}
      : { childFrameId: fixture.childFrameId }),
  };
}

function model(
  nodes: PageModelNode[],
  frames: PageModelFrame[],
): BrowserPageModel {
  return {
    nodes,
    frames,
    coverage: [],
    registry: new FrameRegistry(),
    capturedAt: '2026-10-08T00:00:00.000Z',
    page: {
      browserId: 'browser-test',
      url: 'https://root.example/page',
      title: 'Fixture',
      viewport: { width: 800, height: 600, deviceScaleFactor: 1 },
      themeMode: 'light',
    },
    accessibility: [],
    listeners: [],
    styleSupplement: { candidates: 0, read: 0, skipped: 0 },
    trackerHistory: {
      inputs: 0,
      queried: 0,
      never: 0,
      was: 0,
      calls: 0,
      summaries: 0,
      durationMs: 0,
    },
    timings: {
      extractionMs: 0,
      assemblyMs: 0,
      accessibilityMs: 0,
      listenersMs: 0,
      styleSupplementMs: 0,
      totalMs: 0,
    },
  };
}

function fakeDeps(
  responses: ReadonlyMap<string, unknown> = new Map(),
): FakeDeps {
  const calls: SendCall[] = [];
  return {
    calls,
    deps: {
      send: async (
        method: string,
        params: Record<string, unknown>,
        sessionId?: string,
      ): Promise<unknown> => {
        await Promise.resolve();
        calls.push({
          method,
          params,
          ...(sessionId === undefined ? {} : { sessionId }),
        });
        const rootNodeId = params.nodeId;
        if (typeof rootNodeId !== 'number') return null;
        const result = responses.get(`${sessionId ?? ''}:${rootNodeId}`);
        return result === undefined ? { nodeIds: [] } : result;
      },
    },
  };
}

async function evaluate(
  pageModel: BrowserPageModel,
  parsed: ParsedLocator,
  scope?: { frameRef?: string },
): Promise<NodeIdentity[]> {
  return evaluateLocator(pageModel, fakeDeps().deps, parsed, scope);
}

describe('evaluateLocator', () => {
  it.each(['css=.secret', "page.locator('.secret')", '.secret'])(
    'permits CSS secret-select inspection only with an explicit host option: %s',
    async (locator) => {
      const root = frame('main', '', 'load', 'f-main', [1]);
      const nodes = ['option', 'optgroup', 'span', 'textarea'].map(
        (tagName, index) =>
          node({
            identity: identity('main', '', 'load', index + 2),
            frameRef: 'f-main',
            nodeId: index + 2,
            scopeNodeId: 1,
            tagName,
            insideSecretSelect: true,
            secret: true,
            attributes: {
              'data-testid': '[redacted]',
              placeholder: '[redacted]',
            },
          }),
      );
      const fixture = model(nodes, [root]);
      const deps = fakeDeps(new Map([[':1', { nodeIds: [2, 3, 4, 5] }]])).deps;
      const parsed = parseLocator(locator);
      if (parsed.kind === 'invalid') throw new Error(parsed.message);
      expect(await evaluateLocator(fixture, deps, parsed)).toEqual([]);
      expect(
        await evaluateLocator(fixture, deps, parsed, undefined, {
          purpose: 'inspect',
        }),
      ).toEqual(nodes.map((candidate) => candidate.identity));
      const semantic = parseLocator("page.getByTestId('[redacted]')");
      if (semantic.kind === 'invalid') throw new Error(semantic.message);
      expect(
        await evaluateLocator(fixture, deps, semantic, undefined, {
          purpose: 'inspect',
        }),
      ).toEqual([]);
    },
  );

  it('queries every document and shadow root, scopes frontend IDs by session/root/frame, and deduplicates identities in model order', async () => {
    const mainFrame = frame('main', '', 'main-loader', 'f-main', [10, 11]);
    const childFrame = frame(
      'child',
      'child-session',
      'child-loader',
      'f-child',
      [20],
      { parentFrameId: 'main', url: 'https://shared.example/page' },
    );
    const otherFrame = frame('other', '', 'other-loader', 'f-other', [30], {
      parentFrameId: 'main',
      url: 'https://shared.example/page',
    });
    const otherNode = node({
      identity: identity('other', '', 'other-loader', 77),
      frameRef: 'f-other',
      nodeId: 1,
      scopeNodeId: 30,
      tagName: 'button',
      text: 'Other',
    });
    const shadowNode = node({
      identity: identity('main', '', 'main-loader', 78),
      frameRef: 'f-main',
      nodeId: 2,
      scopeNodeId: 11,
      tagName: 'button',
      text: 'Shadow',
    });
    const childNode = node({
      identity: identity('child', 'child-session', 'child-loader', 77),
      frameRef: 'f-child',
      nodeId: 1,
      scopeNodeId: 20,
      tagName: 'button',
      text: 'Child',
    });
    const mainNode = node({
      identity: identity('main', '', 'main-loader', 77),
      frameRef: 'f-main',
      nodeId: 1,
      scopeNodeId: 10,
      tagName: 'button',
      text: 'Main',
    });
    const duplicateIdentity = node({
      identity: identity('main', '', 'main-loader', 77),
      frameRef: 'f-main',
      nodeId: 3,
      scopeNodeId: 10,
      tagName: 'button',
      text: 'Duplicate model entry',
    });
    const wrongRoot = node({
      identity: identity('main', '', 'main-loader', 79),
      frameRef: 'f-main',
      nodeId: 1,
      scopeNodeId: 99,
      tagName: 'button',
      text: 'Wrong root',
    });
    const wrongFrame = node({
      identity: identity('other', '', 'other-loader', 80),
      frameRef: 'f-other',
      nodeId: 1,
      scopeNodeId: 10,
      tagName: 'button',
      text: 'Wrong frame',
    });
    const fixture = model(
      [
        otherNode,
        shadowNode,
        childNode,
        mainNode,
        duplicateIdentity,
        wrongRoot,
        wrongFrame,
      ],
      [mainFrame, childFrame, otherFrame],
    );
    const responses = new Map<string, unknown>([
      [':10', { nodeIds: [1, 3, 1] }],
      [':11', { nodeIds: [2, 2] }],
      ['child-session:20', { nodeIds: [1, 999] }],
      [':30', { nodeIds: [1] }],
    ]);
    const { deps, calls } = fakeDeps(responses);

    const matches = await evaluateLocator(fixture, deps, {
      kind: 'css',
      selector: 'button',
      explicit: false,
    });

    expect(matches).toEqual([
      otherNode.identity,
      shadowNode.identity,
      childNode.identity,
      mainNode.identity,
    ]);
    expect(calls.map((call) => call.params.nodeId)).toEqual([10, 11, 20, 30]);
    expect(calls.map((call) => call.sessionId)).toEqual([
      '',
      '',
      'child-session',
      '',
    ]);
    expect(calls.every((call) => call.method === 'DOM.querySelectorAll')).toBe(
      true,
    );
  });

  it('uses case-sensitive roles and accessible names for getByRole', async () => {
    const exact = node({
      identity: identity('main', '', 'loader', 1),
      frameRef: 'f-main',
      nodeId: 1,
      scopeNodeId: 10,
      tagName: 'button',
      attributes: { 'aria-label': 'Save changes' },
    });
    const partial = node({
      identity: identity('main', '', 'loader', 2),
      frameRef: 'f-main',
      nodeId: 2,
      scopeNodeId: 10,
      tagName: 'button',
      attributes: { 'aria-label': 'Save changes now' },
    });
    const wrongCase = node({
      identity: identity('main', '', 'loader', 3),
      frameRef: 'f-main',
      nodeId: 3,
      scopeNodeId: 10,
      tagName: 'div',
      attributes: { role: 'Button', 'aria-label': 'Save changes' },
    });
    const textNode = node({
      identity: identity('main', '', 'loader', 4),
      frameRef: 'f-main',
      nodeId: 4,
      scopeNodeId: 10,
      nodeType: 3,
      tagName: '#text',
      attributes: { role: 'button', 'aria-label': 'Save changes' },
    });
    const fixture = model(
      [exact, partial, wrongCase, textNode],
      [frame('main', '', 'loader', 'f-main', [10])],
    );

    expect(
      await evaluate(fixture, {
        kind: 'role',
        role: 'button',
        name: 'Save changes',
      }),
    ).toEqual([exact.identity, partial.identity]);
  });

  // Agents target headings, images, and landmarks by role; native elements
  // had no implicit role for them, so getByRole('heading') matched nothing.
  it('gives headings and main landmarks their implicit roles for getByRole', async () => {
    const at = (
      index: number,
      tagName: string,
      attributes = {},
    ): PageModelNode =>
      node({
        identity: identity('main', '', 'loader', index),
        frameRef: 'f-main',
        nodeId: index,
        scopeNodeId: 10,
        tagName,
        attributes,
      });
    const heading = at(1, 'h2', { 'aria-label': 'History' });
    const image = at(2, 'img', { alt: 'Logo' });
    const nav = at(4, 'nav');
    const main = at(5, 'main');
    const fixture = model(
      [heading, image, nav, main],
      [frame('main', '', 'loader', 'f-main', [10])],
    );

    expect(
      await evaluate(fixture, {
        kind: 'role',
        role: 'heading',
        name: 'History',
      }),
    ).toEqual([heading.identity]);
    // Images are reached with getByAltText, as the preload generated them.
    expect(await evaluate(fixture, { kind: 'role', role: 'img' })).toEqual([]);
    expect(
      await evaluate(fixture, { kind: 'role', role: 'navigation' }),
    ).toEqual([nav.identity]);
    expect(await evaluate(fixture, { kind: 'role', role: 'main' })).toEqual([
      main.identity,
    ]);
    // Unknown tags named like Object.prototype members are not roles.
    for (const tag of ['constructor', 'toString', '__proto__'])
      expect(roleForAttributes(tag, () => undefined)).toBeUndefined();
    expect(isInteractiveAttributes('constructor', () => undefined)).toBe(false);
  });

  it('matches all three test-id attributes with preload attribute precedence', async () => {
    const dataTestId = node({
      identity: identity('main', '', 'loader', 1),
      frameRef: 'f-main',
      nodeId: 1,
      scopeNodeId: 10,
      tagName: 'button',
      attributes: { 'data-testid': 'save' },
    });
    const dataTest = node({
      identity: identity('main', '', 'loader', 2),
      frameRef: 'f-main',
      nodeId: 2,
      scopeNodeId: 10,
      tagName: 'button',
      attributes: { 'data-test': 'save' },
    });
    const dataCy = node({
      identity: identity('main', '', 'loader', 3),
      frameRef: 'f-main',
      nodeId: 3,
      scopeNodeId: 10,
      tagName: 'button',
      attributes: { 'data-cy': 'save' },
    });
    const fixture = model(
      [dataTestId, dataTest, dataCy],
      [frame('main', '', 'loader', 'f-main', [10])],
    );

    expect(await evaluate(fixture, { kind: 'testId', value: 'save' })).toEqual([
      dataTestId.identity,
    ]);
    expect(await evaluate(fixture, { kind: 'testId', value: 'Save' })).toEqual(
      [],
    );

    const dataTestFixture = model(
      [dataTest],
      [frame('main', '', 'loader', 'f-main', [10])],
    );
    const dataCyFixture = model(
      [dataCy],
      [frame('main', '', 'loader', 'f-main', [10])],
    );
    expect(
      await evaluate(dataTestFixture, { kind: 'testId', value: 'save' }),
    ).toEqual([dataTest.identity]);
    expect(
      await evaluate(dataCyFixture, { kind: 'testId', value: 'save' }),
    ).toEqual([dataCy.identity]);
  });

  it('resolves explicit labels to arbitrary targets and wrapped labels to only their first control, including buttons', async () => {
    const explicitLabel = node({
      identity: identity('main', '', 'loader', 1),
      frameRef: 'f-main',
      nodeId: 1,
      scopeNodeId: 10,
      tagName: 'label',
      attributes: { for: 'custom-target' },
      text: 'Account destination',
      labelText: 'Account destination',
    });
    const arbitraryTarget = node({
      identity: identity('main', '', 'loader', 2),
      frameRef: 'f-main',
      nodeId: 2,
      scopeNodeId: 10,
      tagName: 'div',
      attributes: { id: 'custom-target' },
    });
    const wrappedLabel = node({
      identity: identity('main', '', 'loader', 3),
      frameRef: 'f-main',
      nodeId: 3,
      scopeNodeId: 10,
      tagName: 'label',
      text: 'Continue safely',
      labelText: 'Continue safely',
      childIndexes: [3, 4],
    });
    const firstButton = node({
      identity: identity('main', '', 'loader', 4),
      frameRef: 'f-main',
      nodeId: 4,
      scopeNodeId: 10,
      tagName: 'button',
      parentIndex: 2,
    });
    const secondInput = node({
      identity: identity('main', '', 'loader', 5),
      frameRef: 'f-main',
      nodeId: 5,
      scopeNodeId: 10,
      tagName: 'input',
      parentIndex: 2,
    });
    const fixture = model(
      [explicitLabel, arbitraryTarget, wrappedLabel, firstButton, secondInput],
      [frame('main', '', 'loader', 'f-main', [10])],
    );

    expect(
      await evaluate(fixture, { kind: 'label', value: 'destination' }),
    ).toEqual([arbitraryTarget.identity]);
    expect(
      await evaluate(fixture, { kind: 'label', value: 'Continue' }),
    ).toEqual([firstButton.identity]);
  });

  it('does not match text nodes and prefers exact text before interactive or leaf matches', async () => {
    const nonExactButton = node({
      identity: identity('main', '', 'loader', 1),
      frameRef: 'f-main',
      nodeId: 1,
      scopeNodeId: 10,
      tagName: 'button',
      text: 'Search the store',
    });
    const exactParent = node({
      identity: identity('main', '', 'loader', 2),
      frameRef: 'f-main',
      nodeId: 2,
      scopeNodeId: 10,
      tagName: 'div',
      text: 'Search',
      childIndexes: [3],
    });
    const textChild = node({
      identity: identity('main', '', 'loader', 3),
      frameRef: 'f-main',
      nodeId: 3,
      scopeNodeId: 10,
      nodeType: 3,
      tagName: '#text',
      text: 'Search',
      parentIndex: 1,
    });
    const fixture = model(
      [nonExactButton, exactParent, textChild],
      [frame('main', '', 'loader', 'f-main', [10])],
    );

    expect(await evaluate(fixture, { kind: 'text', value: 'Search' })).toEqual([
      exactParent.identity,
    ]);

    const exactButton = node({
      identity: identity('main', '', 'loader', 4),
      frameRef: 'f-main',
      nodeId: 4,
      scopeNodeId: 10,
      tagName: 'button',
      text: 'Search',
    });
    const exactLeaf = node({
      identity: identity('main', '', 'loader', 5),
      frameRef: 'f-main',
      nodeId: 5,
      scopeNodeId: 10,
      tagName: 'span',
      text: 'Search',
    });
    const parentWithMatchingElementChild = node({
      identity: identity('main', '', 'loader', 6),
      frameRef: 'f-main',
      nodeId: 6,
      scopeNodeId: 10,
      tagName: 'div',
      text: 'Search',
      childIndexes: [3],
    });
    const bodyChild = node({
      identity: identity('main', '', 'loader', 7),
      frameRef: 'f-main',
      nodeId: 7,
      scopeNodeId: 10,
      tagName: 'body',
      text: 'Search',
      parentIndex: 1,
    });
    const exactTextFixture = model(
      [exactButton, parentWithMatchingElementChild, exactLeaf, bodyChild],
      [frame('main', '', 'loader', 'f-main', [10])],
    );

    expect(
      await evaluate(exactTextFixture, { kind: 'text', value: 'Search' }),
    ).toEqual([exactButton.identity, exactLeaf.identity]);
  });

  it('matches placeholders and alt text exactly and excludes secret-select descendants', async () => {
    const placeholder = node({
      identity: identity('main', '', 'loader', 1),
      frameRef: 'f-main',
      nodeId: 1,
      scopeNodeId: 10,
      tagName: 'input',
      attributes: { PLACEHOLDER: 'Email address' },
    });
    const placeholderWrongCase = node({
      identity: identity('main', '', 'loader', 2),
      frameRef: 'f-main',
      nodeId: 2,
      scopeNodeId: 10,
      tagName: 'input',
      attributes: { placeholder: 'email address' },
    });
    const alt = node({
      identity: identity('main', '', 'loader', 3),
      frameRef: 'f-main',
      nodeId: 3,
      scopeNodeId: 10,
      tagName: 'img',
      attributes: { alt: 'Canopy icon' },
    });
    const secretTestId = node({
      identity: identity('main', '', 'loader', 4),
      frameRef: 'f-main',
      nodeId: 4,
      scopeNodeId: 10,
      tagName: 'option',
      attributes: { 'data-testid': 'secret-option' },
      insideSecretSelect: true,
    });
    const fixture = model(
      [placeholder, placeholderWrongCase, alt, secretTestId],
      [frame('main', '', 'loader', 'f-main', [10])],
    );

    expect(
      await evaluate(fixture, {
        kind: 'placeholder',
        value: 'Email address',
      }),
    ).toEqual([placeholder.identity]);
    expect(
      await evaluate(fixture, { kind: 'alt', value: 'Canopy icon' }),
    ).toEqual([alt.identity]);
    expect(
      await evaluate(fixture, { kind: 'testId', value: 'secret-option' }),
    ).toEqual([]);
  });

  it('narrows frame locators through owner iframe identity, never URL equality', async () => {
    const selectedOwner = node({
      identity: identity('main', '', 'main-loader', 1),
      frameRef: 'f-main',
      nodeId: 1,
      scopeNodeId: 10,
      tagName: 'iframe',
      attributes: { id: 'selected' },
      childFrameId: 'selected-frame',
    });
    const sameUrlOwner = node({
      identity: identity('main', '', 'main-loader', 2),
      frameRef: 'f-main',
      nodeId: 2,
      scopeNodeId: 10,
      tagName: 'iframe',
      attributes: { id: 'not-selected' },
      childFrameId: 'other-frame',
    });
    const selectedButton = node({
      identity: identity(
        'selected-frame',
        'selected-session',
        'selected-loader',
        3,
      ),
      frameRef: 'f-selected',
      nodeId: 3,
      scopeNodeId: 20,
      tagName: 'button',
      attributes: { 'aria-label': 'Continue' },
    });
    const sameUrlButton = node({
      identity: identity('other-frame', 'other-session', 'other-loader', 4),
      frameRef: 'f-other',
      nodeId: 4,
      scopeNodeId: 30,
      tagName: 'button',
      attributes: { 'aria-label': 'Continue' },
    });
    const sharedUrl = 'https://frames.example/same';
    const fixture = model(
      [selectedOwner, sameUrlOwner, selectedButton, sameUrlButton],
      [
        frame('main', '', 'main-loader', 'f-main', [10]),
        frame(
          'selected-frame',
          'selected-session',
          'selected-loader',
          'f-selected',
          [20],
          {
            parentFrameId: 'main',
            ownerNodeIndex: 0,
            url: sharedUrl,
          },
        ),
        frame('other-frame', 'other-session', 'other-loader', 'f-other', [30], {
          parentFrameId: 'main',
          ownerNodeIndex: 1,
          url: sharedUrl,
        }),
      ],
    );
    const { deps, calls } = fakeDeps(
      new Map<string, unknown>([[':10', { nodeIds: [1] }]]),
    );

    const matches = await evaluateLocator(fixture, deps, {
      kind: 'frame',
      frameSelector: 'iframe#selected',
      inner: { kind: 'role', role: 'button', name: 'Continue' },
    });

    expect(matches).toEqual([selectedButton.identity]);
    expect(calls.map((call) => call.params.nodeId)).toEqual([10, 20, 30]);
    expect(calls.map((call) => call.sessionId)).toEqual([
      '',
      'selected-session',
      'other-session',
    ]);
  });

  it('uses exact frameRef scope and otherwise searches all included frames', async () => {
    const mainButton = node({
      identity: identity('main', '', 'main-loader', 1),
      frameRef: 'f-main',
      nodeId: 1,
      scopeNodeId: 10,
      tagName: 'button',
      attributes: { 'aria-label': 'Shared action' },
    });
    const childButton = node({
      identity: identity('child', 'child-session', 'child-loader', 1),
      frameRef: 'f-child',
      nodeId: 1,
      scopeNodeId: 20,
      tagName: 'button',
      attributes: { 'aria-label': 'Shared action' },
    });
    const fixture = model(
      [mainButton, childButton],
      [
        frame('main', '', 'main-loader', 'f-main', [10]),
        frame('child', 'child-session', 'child-loader', 'f-child', [20]),
      ],
    );
    const locator: ParsedLocator = {
      kind: 'role',
      role: 'button',
      name: 'Shared action',
    };

    expect(await evaluate(fixture, locator)).toEqual([
      mainButton.identity,
      childButton.identity,
    ]);
    expect(await evaluate(fixture, locator, { frameRef: 'f-child' })).toEqual([
      childButton.identity,
    ]);
    expect(
      await evaluate(fixture, locator, { frameRef: 'https://child.example' }),
    ).toEqual([]);
  });

  it('falls back from empty CSS matches to embedded test IDs, including explicit CSS', async () => {
    const target = node({
      identity: identity('main', '', 'loader', 1),
      frameRef: 'f-main',
      nodeId: 1,
      scopeNodeId: 10,
      tagName: 'button',
      attributes: { 'data-testid': 'save-button' },
    });
    const fixture = model(
      [target],
      [frame('main', '', 'loader', 'f-main', [10])],
    );
    const { deps, calls } = fakeDeps(
      new Map<string, unknown>([[':10', { nodeIds: [] }]]),
    );

    const matches = await evaluateLocator(fixture, deps, {
      kind: 'css',
      selector: "prefix getByTestId('save-button') trailing",
      explicit: true,
    });

    expect(matches).toEqual([target.identity]);
    expect(calls).toEqual([
      {
        method: 'DOM.querySelectorAll',
        params: {
          nodeId: 10,
          selector: "prefix getByTestId('save-button') trailing",
        },
        sessionId: '',
      },
    ]);
  });

  it('uses the parsed trailing getByTestId fallback with the parsed explicit selector', async () => {
    const target = node({
      identity: identity('main', '', 'loader', 1),
      frameRef: 'f-main',
      nodeId: 1,
      scopeNodeId: 10,
      tagName: 'button',
      attributes: { 'data-testid': 'save' },
    });
    const fixture = model(
      [target],
      [frame('main', '', 'loader', 'f-main', [10])],
    );
    const parsed = parseLocator("page.locator('#missing') getByTestId('save')");
    if (parsed.kind === 'invalid') throw new Error(parsed.message);

    expect(parsed).toEqual({
      kind: 'css',
      selector: '#missing',
      explicit: true,
      testIdFallback: 'save',
    });
    expect(
      await evaluateLocator(
        fixture,
        fakeDeps(new Map<string, unknown>([[':10', { nodeIds: [] }]])).deps,
        parsed,
      ),
    ).toEqual([target.identity]);
  });

  it('tries implicit semantic fallback after CSS misses but does not apply it to explicit CSS', async () => {
    const target = node({
      identity: identity('main', '', 'loader', 1),
      frameRef: 'f-main',
      nodeId: 1,
      scopeNodeId: 10,
      tagName: 'button',
      attributes: { 'aria-label': 'Apply changes' },
    });
    const fixture = model(
      [target],
      [frame('main', '', 'loader', 'f-main', [10])],
    );
    const deps = fakeDeps(
      new Map<string, unknown>([[':10', { nodeIds: [] }]]),
    ).deps;
    const selector = "getByRole('button', { name: 'Apply' })";

    expect(
      await evaluateLocator(fixture, deps, {
        kind: 'css',
        selector,
        explicit: false,
      }),
    ).toEqual([target.identity]);
    expect(
      await evaluateLocator(fixture, deps, {
        kind: 'css',
        selector,
        explicit: true,
      }),
    ).toEqual([]);
  });

  it('ignores malformed or untrusted CDP node ID payloads', async () => {
    const candidate = node({
      identity: identity('main', '', 'loader', 1),
      frameRef: 'f-main',
      nodeId: 1,
      scopeNodeId: 10,
      tagName: 'button',
    });
    const fixture = model(
      [candidate],
      [frame('main', '', 'loader', 'f-main', [10, 11, 12, 13])],
    );
    const responses = new Map<string, unknown>([
      [':10', null],
      [':11', { nodeIds: 'not an array' }],
      [':12', { nodeIds: [1, '1', 0, -1, 1.5, Number.NaN] }],
      [':13', { nodeIds: 1 }],
    ]);

    expect(
      await evaluateLocator(fixture, fakeDeps(responses).deps, {
        kind: 'css',
        selector: 'button',
        explicit: false,
      }),
    ).toEqual([]);
  });
});

describe('evaluateLocator on recorded Chromium pages', () => {
  function idsOf(
    pageModel: BrowserPageModel,
    identities: NodeIdentity[],
  ): string[] {
    return identities.map((target) => {
      const match = pageModel.nodes.find(
        (candidate) =>
          candidate.identity.frameId === target.frameId &&
          candidate.identity.backendNodeId === target.backendNodeId,
      );
      return match?.attributes.id ?? match?.tagName ?? '?';
    });
  }

  it('matches inside open, closed and nested shadow roots and slotted light DOM with one query per root (B3)', async () => {
    const recording = loadRecording('shadow');
    const pageModel = await buildPageModel(recordedDeps(recording));
    const replay = recordedSend(recording);
    const calls: string[] = [];
    const deps: LocatorEvaluationDeps = {
      send: (method, params, sessionId) => {
        calls.push(method);
        return replay(method, params, sessionId);
      },
    };
    const css = (selector: string): ParsedLocator => ({
      kind: 'css',
      selector,
      explicit: true,
    });
    expect(
      idsOf(pageModel, await evaluateLocator(pageModel, deps, css('#note'))),
    ).toEqual(['note']);
    expect(
      idsOf(pageModel, await evaluateLocator(pageModel, deps, css('#deep'))),
    ).toEqual(['deep']);
    expect(
      idsOf(
        pageModel,
        await evaluateLocator(pageModel, deps, css('#slotted-input')),
      ),
    ).toEqual(['slotted-input']);
    calls.length = 0;
    expect(
      idsOf(pageModel, await evaluateLocator(pageModel, deps, css('button'))),
    ).toEqual(['shadow-button', 'slotted-button', 'deep']);
    // The document and the four author shadow roots: never one per element.
    expect(calls).toHaveLength(5);
    expect(
      idsOf(pageModel, await evaluateLocator(pageModel, deps, css('input'))),
    ).toEqual([
      'note',
      'shadow-revealed',
      'slotted-input',
      'unslotted-input',
      'closed-input',
    ]);
  });

  it('scopes a frame locator through its owner iframe on recorded frames', async () => {
    const recording = loadRecording('frames');
    const pageModel = await buildPageModel(recordedDeps(recording));
    const deps: LocatorEvaluationDeps = { send: recordedSend(recording) };
    const scoped = parseLocator(
      "page.frameLocator('iframe').locator('#frame-name')",
    );
    if (scoped.kind === 'invalid') throw new Error(scoped.message);
    expect(
      idsOf(pageModel, await evaluateLocator(pageModel, deps, scoped)),
    ).toEqual(['frame-name']);
    const unscoped = parseLocator('button');
    if (unscoped.kind === 'invalid') throw new Error(unscoped.message);
    expect(
      idsOf(pageModel, await evaluateLocator(pageModel, deps, unscoped)),
    ).toEqual(['before', 'frame-button', 'nested-button', 'after']);
  });

  it('reports stale frontend node IDs as a stale target, not as no match (m1)', async () => {
    const pageModel = await buildPageModel(
      recordedDeps(loadRecording('form-controls')),
    );
    const deps: LocatorEvaluationDeps = {
      send: () =>
        Promise.reject(new Error('Could not find node with given id')),
    };
    const promise = evaluateLocator(pageModel, deps, {
      kind: 'css',
      selector: '#email',
      explicit: false,
    });
    await expect(promise).rejects.toMatchObject({ name: 'StaleLocatorError' });
    await expect(promise).rejects.toThrow('target_stale');
    expect(
      isStaleLocatorError(await promise.catch((error: unknown) => error)),
    ).toBe(true);
  });

  it('bounds each locator query with a timeout (m1)', async () => {
    jest.useFakeTimers();
    try {
      const pageModel = await buildPageModel(
        recordedDeps(loadRecording('form-controls')),
      );
      const pending = evaluateLocator(
        pageModel,
        { send: () => new Promise(() => undefined) },
        { kind: 'css', selector: '#email', explicit: true },
      );
      const settled = pending.catch((error: unknown) => error);
      await jest.advanceTimersByTimeAsync(5_000);
      expect(await settled).toMatchObject({
        message: 'Locator evaluation timed out.',
      });
    } finally {
      jest.useRealTimers();
    }
  });
});
