import {
  decodeDOMSnapshot,
  decodeDomTree,
  restoreWhitespaceText,
} from '../cdp-decode';
import { FrameRegistry } from '../frame-registry';
import { isHiddenElement } from '../model-semantics';
import type {
  BrowserPageModel,
  PageModelDeps,
  PageModelNode,
} from '../model-types';
import { buildPageModel } from '../page-model';
import { projectInputSnapshot } from '../projections';
import {
  loadRecording,
  recordedDeps,
  recordedRegistry,
  recordedSend,
  type Recording,
} from './fixtures/recorded-cdp';
import { syntheticInputsPage } from './fixtures/synthetic-cdp';

const PAGE = { browserId: 'model', url: '', title: '' };

function rows(
  model: BrowserPageModel,
): ReturnType<typeof projectInputSnapshot>['inputs'] {
  return projectInputSnapshot(model, { browserId: 'model', limit: 100 }, PAGE)
    .inputs;
}

/** Each row's element id (or tag), through its ref and the registry. */
function rowIds(model: BrowserPageModel): string[] {
  return rows(model).map((row) => {
    const identity = model.registry.resolveRef(row.ref);
    const node = model.nodes.find(
      (candidate) =>
        identity !== undefined &&
        candidate.identity.frameId === identity.frameId &&
        candidate.identity.backendNodeId === identity.backendNodeId,
    );
    return node?.attributes.id ?? row.tagName;
  });
}

function nodeById(model: BrowserPageModel, id: string): PageModelNode {
  const node = model.nodes.find((candidate) => candidate.attributes.id === id);
  if (!node) throw new Error(`Missing model node #${id}`);
  return node;
}

function recordedResponse(
  recording: Recording,
  method: string,
  sessionId = '',
): unknown {
  const entry = recording.responses.find(
    (candidate) =>
      candidate.method === method && candidate.sessionId === sessionId,
  );
  if (!entry) throw new Error(`Missing ${method}`);
  return entry.response;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function spySend(recording: Recording): {
  send: PageModelDeps['send'];
  calls: Array<{ method: string; sessionId: string }>;
} {
  const replay = recordedSend(recording);
  const calls: Array<{ method: string; sessionId: string }> = [];
  return {
    calls,
    send: (method, params, sessionId): Promise<unknown> => {
      calls.push({ method, sessionId: sessionId ?? '' });
      return replay(method, params, sessionId);
    },
  };
}

const ALL_RECORDINGS = [
  'form-controls',
  'lists-pseudo',
  'shadow',
  'frames',
  'hidden',
  'secrets',
  'oopif',
];

describe('buildPageModel on recorded Chromium CDP', () => {
  it.each(ALL_RECORDINGS)(
    '%s: builds rows and reports the root as included (B1)',
    async (name) => {
      const recording = loadRecording(name);
      const model = await buildPageModel(recordedDeps(recording));
      expect(model.nodes.length).toBeGreaterThan(10);
      expect(rows(model).length).toBeGreaterThan(0);
      expect(model.coverage[0]).toMatchObject({ status: 'included' });
      expect(model.frames[0]?.depth).toBe(0);
    },
  );

  it('maps documents to frames although Chromium puts frameId on <html> and owners, not #document (B1)', async () => {
    const recording = loadRecording('frames');
    const raw = recordedResponse(recording, 'DOM.getDocument');
    const tree = decodeDomTree(raw);
    if (!tree) throw new Error('Undecodable recording');
    expect(tree.root.frameId).toBeUndefined();
    expect(
      tree.root.children.find((child) => child.nodeType === 1)?.frameId,
    ).toEqual(expect.any(String));
    const model = await buildPageModel(recordedDeps(recording));
    expect(model.frames.map((frame) => frame.depth)).toEqual([0, 1, 2]);
    expect(model.frames[0]?.documentNodeId).toBe(tree.root.nodeId);
    expect(model.coverage.map((entry) => entry.status)).toEqual([
      'included',
      'included',
      'included',
    ]);
  });

  it('keeps the first layout entry when Chromium repeats a pseudo-element box (B2)', async () => {
    const recording = loadRecording('lists-pseudo');
    const raw = recordedResponse(recording, 'DOMSnapshot.captureSnapshot');
    if (
      !record(raw) ||
      !Array.isArray(raw.documents) ||
      !record(raw.documents[0])
    ) {
      throw new Error('Unexpected recording');
    }
    const layout = raw.documents[0].layout;
    if (!record(layout) || !Array.isArray(layout.nodeIndex))
      throw new Error('No layout');
    const nodeIndexes = layout.nodeIndex;
    expect(new Set(nodeIndexes).size).toBeLessThan(nodeIndexes.length);
    expect(decodeDOMSnapshot(raw)).toBeDefined();
    const model = await buildPageModel(recordedDeps(recording));
    expect(rows(model).map((row) => [row.tagName, row.name])).toEqual([
      ['a', 'First'],
      ['a', 'Second'],
      ['button', 'Third'],
      ['span', 'Option C'],
      ['span', 'Tree item'],
    ]);
    expect(model.nodes.some((node) => node.tagName.startsWith('::'))).toBe(
      false,
    );
  });

  it('takes shadow structure, scope and order from the pierced document (B3)', async () => {
    const recording = loadRecording('shadow');
    const snapshot = recordedResponse(recording, 'DOMSnapshot.captureSnapshot');
    // The snapshot is flat: no shadow-root node to build structure from.
    expect(JSON.stringify(snapshot)).not.toContain('#document-fragment');
    const model = await buildPageModel(recordedDeps(recording));
    const roots = model.nodes.filter((node) => node.nodeType === 11);
    expect(roots.map((root) => root.shadowRootType)).toEqual([
      'open',
      'closed',
      'open',
      'closed',
    ]);
    expect(model.frames[0]?.queryRootNodeIds).toEqual([
      model.frames[0]?.documentNodeId,
      ...roots.map((root) => root.nodeId),
    ]);
    const slotted = nodeById(model, 'slotted-input');
    expect(slotted).toMatchObject({
      inShadowRoot: false,
      secret: false,
      value: 'slotted value',
    });
    expect(slotted.scopeNodeId).toBe(model.frames[0]?.documentNodeId);
    const deep = nodeById(model, 'deep');
    expect(deep).toMatchObject({
      inShadowRoot: true,
      shadowRootType: 'closed',
      text: 'Two levels deep',
    });
    expect(deep.scopeNodeId).toBe(roots[3]?.nodeId);
    expect(nodeById(model, 'note')).toMatchObject({
      inShadowRoot: true,
      secret: true,
    });
    expect(nodeById(model, 'shadow-button').text).toBe('Open action');
    const host = nodeById(model, 'closed-host');
    expect(host.text).toBe('Save draft');
    const snapshotRows = rows(model);
    const card = snapshotRows.find((row) => row.tagName === 'x-card');
    expect(card).toMatchObject({ role: 'button', name: 'Save draft' });
    // E1: light DOM says nothing about shadow roots.
    expect(card).not.toHaveProperty('inShadowRoot');
    // Shadow content follows its host, before the host's light children.
    expect(rowIds(model)).toEqual([
      'note',
      'shadow-button',
      'shadow-revealed',
      'shadow-textarea',
      'shadow-secret-note',
      'slotted-input',
      'unslotted-input',
      'slotted-button',
      'closed-host',
      'closed-input',
      'closed-select',
      'deep',
    ]);
  });

  it('reads live textarea values from textValue and selects from optionSelected (M2)', async () => {
    const model = await buildPageModel(
      recordedDeps(loadRecording('form-controls')),
    );
    expect(nodeById(model, 'notes')).toMatchObject({
      value: 'live notes',
      text: 'default notes',
    });
    expect(nodeById(model, 'color').value).toBe('Plain text option');
    expect(nodeById(model, 'email').value).toBe('live@example.test');
    expect(nodeById(model, 'subscribe').checked).toBe(true);
    expect(nodeById(model, 'size-large').checked).toBe(true);
  });

  it('rounds projected bounds like the preload (M3)', async () => {
    const model = await buildPageModel(
      recordedDeps(loadRecording('lists-pseudo')),
    );
    expect(
      model.nodes.some((node) => !Number.isInteger(node.bounds.width)),
    ).toBe(true);
    for (const row of rows(model)) {
      for (const value of Object.values(row.bounds))
        expect(Number.isInteger(value)).toBe(true);
    }
  });

  it('restores whitespace-only text when DOM was enabled without includeWhitespace', async () => {
    const without = loadRecording('form-controls.no-whitespace');
    const tree = decodeDomTree(recordedResponse(without, 'DOM.getDocument'));
    const snapshot = decodeDOMSnapshot(
      recordedResponse(without, 'DOMSnapshot.captureSnapshot'),
    );
    if (!tree || !snapshot) throw new Error('Undecodable recording');
    expect(
      restoreWhitespaceText(tree, snapshot.whitespaceTexts),
    ).toBeGreaterThan(10);
    const withWhitespace = loadRecording('form-controls');
    const restoredTree = decodeDomTree(
      recordedResponse(withWhitespace, 'DOM.getDocument'),
    );
    const restoredSnapshot = decodeDOMSnapshot(
      recordedResponse(withWhitespace, 'DOMSnapshot.captureSnapshot'),
    );
    if (!restoredTree || !restoredSnapshot)
      throw new Error('Undecodable recording');
    expect(
      restoreWhitespaceText(restoredTree, restoredSnapshot.whitespaceTexts),
    ).toBe(0);
    const comparable = (model: BrowserPageModel): unknown =>
      rows(model).map((row) => ({ ...row, ref: '', frameRef: '' }));
    const restored = await buildPageModel(recordedDeps(without));
    const expected = await buildPageModel(recordedDeps(withWhitespace));
    expect(comparable(restored)).toEqual(comparable(expected));
    expect(rows(restored).find((row) => row.tagName === 'button')?.name).toBe(
      'Save now',
    );
  });

  it('places frame content at the owner content box, not its border box (m10)', async () => {
    const model = await buildPageModel(recordedDeps(loadRecording('frames')));
    const owner = nodeById(model, 'framed');
    const name = nodeById(model, 'frame-name');
    // #framed has a 5px border and 7px/3px padding.
    expect(name.bounds.x).toBeCloseTo(
      owner.bounds.x + 5 + 3 + name.frameLocalBounds.x,
      5,
    );
    expect(name.bounds.y).toBeCloseTo(
      owner.bounds.y + 5 + 7 + name.frameLocalBounds.y,
      5,
    );
    expect(rows(model).map((row) => row.name)).toEqual([
      'Before frame',
      'Name',
      // The plain textarea is named by its text; the secret one has none.
      'frame note',
      undefined,
      'Frame action',
      'Nested action',
      'After frame',
    ]);
    const nestedFrame = model.frames.find((frame) => frame.depth === 2);
    expect(nestedFrame?.ownerNodeIndex).toBe(
      model.nodes.indexOf(nodeById(model, 'nested')),
    );
  });

  it('walks an out-of-process frame only when its owner is visible, and never captures hidden ones (m6)', async () => {
    const recording = loadRecording('oopif');
    const { send, calls } = spySend(recording);
    const model = await buildPageModel(recordedDeps(recording, { send }));
    expect(model.coverage.map((entry) => [entry.status, entry.reason])).toEqual(
      [
        ['included', undefined],
        ['included', undefined],
        ['omitted', 'owner_not_visible'],
        ['omitted', 'owner_not_visible'],
      ],
    );
    const captured = new Set(
      calls
        .filter((call) => call.method === 'DOM.getDocument')
        .map((call) => call.sessionId),
    );
    expect(captured).toEqual(new Set(['', 'oopif-1']));
    // E1: only child-frame rows carry a frameRef.
    const childRows = rows(model).filter((row) => row.frameRef !== undefined);
    expect(childRows.map((row) => [row.name, row.valueRedacted])).toEqual([
      ['Child name', true],
      ['Child action', undefined],
    ]);
  });

  it('reads missing-layout styles for row candidates only, in one batch per frame (M5)', async () => {
    const recording = loadRecording('hidden');
    const recorded = recordedDeps(recording);
    const readStyles = jest.fn(
      (frameId: string, sessionId: string, ids: number[]) =>
        recorded.readStyles?.(frameId, sessionId, ids) ??
        Promise.resolve(undefined),
    );
    const { send, calls } = spySend(recording);
    const model = await buildPageModel(
      recordedDeps(recording, { send, readStyles }),
    );
    expect(readStyles).toHaveBeenCalledTimes(1);
    expect(calls.some((call) => call.method.startsWith('CSS.'))).toBe(false);
    expect(model.styleSupplement).toEqual({
      candidates: 8,
      read: 8,
      skipped: 0,
    });
    expect(rowIds(model)).toEqual([
      'visible',
      'button',
      'contents-button',
      'in-contents',
      'under-display-none',
      'tab-under-none',
      'button',
      'in-details',
    ]);
    expect(nodeById(model, 'stylesheet-none').computedStyles).toEqual({
      display: 'none',
      visibility: 'visible',
    });
  });

  it('hides only the row whose style read failed; its descendants are unaffected', async () => {
    const recording = loadRecording('hidden');
    const model = await buildPageModel(
      recordedDeps(recording, {
        readStyles: async (frameId, sessionId, ids) => {
          const read = await recordedDeps(recording).readStyles?.(
            frameId,
            sessionId,
            ids,
          );
          // Fail every read: the display: contents wrapper among them.
          return read?.map(() => undefined);
        },
      }),
    );
    expect(model.styleSupplement).toMatchObject({
      candidates: 8,
      read: 0,
      skipped: 8,
      reason: 'error',
    });
    const wrapper = nodeById(model, 'contents-button');
    expect(wrapper.styleUnknown).toBe(true);
    expect(isHiddenElement(wrapper)).toBe(true);
    expect(isHiddenElement(nodeById(model, 'in-contents'))).toBe(false);
  });

  it('falls back to CSS.getComputedStyleForNode without an isolated context and disables CSS after', async () => {
    const recording = loadRecording('hidden');
    const replay = recordedSend(recording);
    const recordedStyles = new Map<
      number,
      { display: string; visibility: string }
    >();
    for (const call of recording.styles) {
      call.backendNodeIds.forEach((id, index) => {
        const read = call.result?.[index];
        if (read) recordedStyles.set(id, read);
      });
    }
    const tree = decodeDomTree(recordedResponse(recording, 'DOM.getDocument'));
    if (!tree) throw new Error('Undecodable recording');
    const backendByNodeId = new Map(
      Array.from(tree.byBackendNodeId.values(), (node) => [
        node.nodeId,
        node.backendNodeId,
      ]),
    );
    const calls: string[] = [];
    const model = await buildPageModel(
      recordedDeps(recording, {
        readStyles: () => Promise.resolve(undefined),
        send: (method, params, sessionId) => {
          calls.push(method);
          if (method === 'CSS.enable' || method === 'CSS.disable')
            return Promise.resolve({});
          if (method === 'CSS.getComputedStyleForNode') {
            const backendNodeId = backendByNodeId.get(Number(params.nodeId));
            const read =
              backendNodeId === undefined
                ? undefined
                : recordedStyles.get(backendNodeId);
            return Promise.resolve({
              computedStyle: read
                ? [
                    { name: 'color', value: 'rgb(0, 0, 0)' },
                    { name: 'display', value: read.display },
                    { name: 'visibility', value: read.visibility },
                  ]
                : [],
            });
          }
          return replay(method, params, sessionId);
        },
      }),
    );
    expect(calls.filter((method) => method.startsWith('CSS.'))).toEqual([
      'CSS.enable',
      ...Array.from({ length: 8 }, () => 'CSS.getComputedStyleForNode'),
      'CSS.disable',
    ]);
    expect(model.styleSupplement).toEqual({
      candidates: 8,
      read: 8,
      skipped: 0,
    });
    expect(nodeById(model, 'stylesheet-none').computedStyles).toEqual({
      display: 'none',
      visibility: 'visible',
    });
  });

  it('caps missing-layout style reads at 1,000 per build', async () => {
    const page = syntheticInputsPage(1_005);
    const registry = new FrameRegistry();
    registry.noteFrameNavigated('', {
      id: page.frameId,
      loaderId: page.loaderId,
      url: page.url,
    });
    const readStyles = jest.fn(
      (_frame: string, _session: string, ids: number[]) =>
        Promise.resolve(
          ids.map(() => ({ display: 'inline-block', visibility: 'visible' })),
        ),
    );
    const model = await buildPageModel({
      registry,
      now: () => 0,
      readStyles,
      isPasswordEverSeen: (_frame, _session, ids) =>
        Promise.resolve(ids.map(() => false)),
      send: (method) => {
        if (method === 'DOM.getDocument') return Promise.resolve(page.document);
        if (method === 'DOMSnapshot.captureSnapshot')
          return Promise.resolve(page.snapshot);
        if (method === 'Page.getLayoutMetrics')
          return Promise.resolve(page.metrics);
        return Promise.reject(new Error(`Unexpected ${method}`));
      },
    });
    expect(readStyles.mock.calls[0]?.[2]).toHaveLength(1_000);
    expect(model.styleSupplement).toEqual({
      candidates: 1_005,
      read: 1_000,
      skipped: 5,
      reason: 'cap',
    });
    const projected = projectInputSnapshot(
      model,
      { browserId: 'model', limit: 100, offset: 1_000 },
      PAGE,
    );
    expect(model.nodes.filter((node) => node.styleUnknown)).toHaveLength(5);
    expect(projected.total).toBe(1_000);
  });

  it('gives up style reads after their 2 s budget and hides those rows', async () => {
    jest.useFakeTimers();
    try {
      const recording = loadRecording('hidden');
      let clock = 0;
      const built = buildPageModel(
        recordedDeps(recording, {
          now: () => clock,
          readStyles: () => new Promise(() => undefined),
        }),
      );
      for (let step = 0; step < 50; step += 1) {
        await Promise.resolve();
      }
      clock = 2_001;
      await jest.advanceTimersByTimeAsync(2_001);
      const model = await built;
      expect(model.styleSupplement).toMatchObject({
        read: 0,
        skipped: 8,
        reason: 'error',
      });
      expect(isHiddenElement(nodeById(model, 'under-display-none'))).toBe(true);
    } finally {
      jest.useRealTimers();
    }
  });

  it.each([
    [
      'rejects',
      (): Promise<boolean[]> => Promise.reject(new Error('bridge missing')),
    ],
    [
      'returns the wrong length',
      (): Promise<boolean[]> => Promise.resolve([false]),
    ],
  ])(
    'treats every main-frame input as a password when history %s',
    async (_label, history) => {
      const model = await buildPageModel(
        recordedDeps(loadRecording('secrets'), { isPasswordEverSeen: history }),
      );
      expect(nodeById(model, 'username')).toMatchObject({ secret: true });
      expect(rows(model).find((row) => row.name === 'Username')).toMatchObject({
        valueRedacted: true,
      });
    },
  );

  it('treats every main-frame input as a password when history never answers', async () => {
    jest.useFakeTimers();
    try {
      const built = buildPageModel(
        recordedDeps(loadRecording('secrets'), {
          isPasswordEverSeen: () => new Promise(() => undefined),
        }),
      );
      await jest.advanceTimersByTimeAsync(2_001);
      const model = await built;
      expect(nodeById(model, 'username').secret).toBe(true);
    } finally {
      jest.useRealTimers();
    }
  });

  it('retries a failed capture once and omits a session whose retry also fails', async () => {
    const recording = loadRecording('form-controls');
    const replay = recordedSend(recording);
    let failures = 1;
    const retried = await buildPageModel(
      recordedDeps(recording, {
        send: (method, params, sessionId) => {
          if (method === 'DOM.getDocument' && failures > 0) {
            failures -= 1;
            return Promise.reject(new Error('transient'));
          }
          return replay(method, params, sessionId);
        },
      }),
    );
    expect(rows(retried).length).toBe(19);
    const failed = await buildPageModel(
      recordedDeps(recording, {
        send: (method, params, sessionId) =>
          method === 'DOMSnapshot.captureSnapshot'
            ? Promise.resolve({ documents: [{}], strings: [] })
            : replay(method, params, sessionId),
      }),
    );
    expect(failed.nodes).toEqual([]);
    expect(failed.coverage).toEqual([
      expect.objectContaining({
        status: 'omitted',
        reason: 'session_unavailable',
      }),
    ]);
  });

  it('chooses the parentless root-session frame as the root (m4)', async () => {
    const recording = loadRecording('frames');
    const registry = new FrameRegistry();
    const [root, child, nested] = recording.frames;
    if (!root || !child || !nested) throw new Error('Unexpected recording');
    // A same-process child registered first must not be taken for the root.
    for (const frame of [nested, child, root]) {
      registry.noteFrameNavigated('', {
        id: frame.frameId,
        loaderId: frame.loaderId,
        url: frame.url,
        ...(frame.parentId === undefined ? {} : { parentId: frame.parentId }),
      });
    }
    const model = await buildPageModel(recordedDeps(recording, { registry }));
    expect(model.frames[0]?.frameId).toBe(root.frameId);
    expect(rows(model)).toHaveLength(7);
  });

  it('reports an unregistered frame document once, and registry omissions once (m5)', async () => {
    const recording = loadRecording('frames');
    const registry = recordedRegistry(recording);
    const nested = recording.frames.find(
      (frame) =>
        frame.parentId !== undefined &&
        frame.parentId !== recording.frames[0]?.frameId,
    );
    if (!nested) throw new Error('Unexpected recording');
    registry.noteFrameDetached(nested.frameId);
    const model = await buildPageModel(recordedDeps(recording, { registry }));
    expect(
      model.coverage.filter(
        (entry) => entry.reason === 'unmatched_frame_identity',
      ),
    ).toHaveLength(1);
    expect(model.coverage).toHaveLength(3);
    expect(rows(model).map((row) => row.name)).not.toContain('Nested action');
  });

  it('omits frames beyond five levels and one hundred frames without capturing them', async () => {
    const recording = loadRecording('form-controls');
    const registry = recordedRegistry(recording);
    const root = recording.frames[0];
    if (!root) throw new Error('Unexpected recording');
    let parent = root.frameId;
    for (let depth = 1; depth <= 6; depth += 1) {
      const frameId = `deep-${depth}`;
      registry.noteFrameNavigated('', {
        id: frameId,
        loaderId: `l-${depth}`,
        url: 'https://a.test/',
        parentId: parent,
      });
      parent = frameId;
    }
    for (let index = 0; index < 100; index += 1) {
      registry.noteFrameNavigated(`session-${index}`, {
        id: `wide-${index}`,
        loaderId: `w-${index}`,
        url: 'https://b.test/',
        parentId: root.frameId,
      });
    }
    const { send, calls } = spySend(recording);
    const model = await buildPageModel(
      recordedDeps(recording, { registry, send }),
    );
    const reasons = model.coverage.map((entry) => entry.reason ?? entry.status);
    expect(reasons.filter((reason) => reason === 'max_depth')).toHaveLength(1);
    expect(
      reasons.filter((reason) => reason === 'max_child_frames'),
    ).toHaveLength(6);
    expect(model.coverage).toHaveLength(1 + 6 + 100);
    expect(new Set(calls.map((call) => call.sessionId))).toEqual(new Set(['']));
  });

  it('returns root_not_navigated without any CDP request before the first navigation', async () => {
    const send = jest.fn<
      Promise<unknown>,
      [string, Record<string, unknown>, string?]
    >();
    const model = await buildPageModel({
      registry: new FrameRegistry(),
      now: () => 0,
      send,
      isPasswordEverSeen: () => Promise.resolve([]),
    });
    expect(send).not.toHaveBeenCalled();
    expect(model.coverage).toEqual([
      {
        frameRef: '',
        url: '',
        status: 'omitted',
        reason: 'root_not_navigated',
      },
    ]);
  });

  it('aborts outstanding CDP work without leaving timers', async () => {
    jest.useFakeTimers();
    try {
      const controller = new AbortController();
      const built = buildPageModel(
        recordedDeps(loadRecording('form-controls'), {
          signal: controller.signal,
          send: () => new Promise(() => undefined),
        }),
      );
      controller.abort();
      await expect(built).rejects.toMatchObject({ name: 'AbortError' });
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('restoreWhitespaceText', () => {
  function wideDocument(count: number): unknown {
    const children = Array.from({ length: count }, (_, index) => ({
      nodeId: 10 + index,
      backendNodeId: 10 + index,
      nodeType: 1,
      nodeName: 'SPAN',
      localName: 'span',
      nodeValue: '',
      childNodeCount: 0,
      children: [],
      attributes: [],
    }));
    return {
      root: {
        nodeId: 1,
        backendNodeId: 1,
        nodeType: 9,
        nodeName: '#document',
        children: [
          {
            nodeId: 2,
            backendNodeId: 2,
            nodeType: 1,
            nodeName: 'HTML',
            attributes: [],
            children: [
              {
                nodeId: 3,
                backendNodeId: 3,
                nodeType: 1,
                nodeName: 'BODY',
                attributes: [],
                children,
              },
            ],
          },
        ],
      },
    };
  }

  it('restores whitespace between tens of thousands of siblings in linear time (major 4)', () => {
    const count = 40_000;
    const tree = decodeDomTree(wideDocument(count));
    if (!tree) throw new Error('Undecodable tree');
    // Whitespace before the first span, after every span, and a run of two
    // adjacent text nodes, as the snapshot reports them.
    const texts = [
      { backendNodeId: 1_000_000, parentBackendNodeId: 3, value: '\n' },
      ...Array.from({ length: count }, (_, index) => ({
        backendNodeId: 1_000_001 + index,
        parentBackendNodeId: 3,
        previousBackendNodeId: 10 + index,
        value: ' ',
      })),
      {
        backendNodeId: 2_000_000,
        parentBackendNodeId: 3,
        previousBackendNodeId: 1_000_000 + count,
        value: '\n',
      },
    ];
    const started = performance.now();
    expect(restoreWhitespaceText(tree, texts)).toBe(count + 2);
    expect(performance.now() - started).toBeLessThan(750);
    const body = tree.byBackendNodeId.get(3);
    const order = body?.children.map((child) => child.backendNodeId) ?? [];
    expect(order).toHaveLength(2 * count + 2);
    expect(order.slice(0, 5)).toEqual([
      1_000_000, 10, 1_000_001, 11, 1_000_002,
    ]);
    expect(order.slice(-3)).toEqual([9 + count, 1_000_000 + count, 2_000_000]);
    expect(body?.children.every((child) => child.parent === body)).toBe(true);
  });
});
