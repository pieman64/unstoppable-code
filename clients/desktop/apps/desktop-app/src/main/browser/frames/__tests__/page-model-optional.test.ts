import type { BrowserPageModel, PageModelDeps } from '../model-types';
import { buildPageModel } from '../page-model';
import {
  loadRecording,
  recordedDeps,
  recordedRegistry,
  recordedSend,
  type Recording,
} from './fixtures/recorded-cdp';

function spy(
  recording: Recording,
  extra?: PageModelDeps['send'],
): {
  send: PageModelDeps['send'];
  methods: string[];
} {
  const replay = recordedSend(recording);
  const methods: string[] = [];
  return {
    methods,
    send: (method, params, sessionId): Promise<unknown> => {
      methods.push(method);
      return extra &&
        !method.startsWith('DOM') &&
        !method.startsWith('Page.getLayout')
        ? extra(method, params, sessionId)
        : replay(method, params, sessionId);
    },
  };
}

function byId(model: BrowserPageModel, id: string): number {
  const node = model.nodes.find((candidate) => candidate.attributes.id === id);
  if (!node) throw new Error(`Missing #${id}`);
  return node.identity.backendNodeId;
}

function namesFor(
  model: BrowserPageModel,
  frameId: string,
): Map<number, string> {
  const names = new Map<number, string>();
  for (const node of model.accessibility) {
    if (
      node.frameId === frameId &&
      node.backendNodeId !== undefined &&
      node.name
    ) {
      names.set(node.backendNodeId, node.name);
    }
  }
  return names;
}

describe('optional accessibility stage on recorded Chromium trees', () => {
  it('does not request accessibility data when the stage is disabled', async () => {
    const recording = loadRecording('frames');
    const { send, methods } = spy(recording);
    const model = await buildPageModel(recordedDeps(recording, { send }));
    expect(methods).not.toContain('Accessibility.getFullAXTree');
    expect(model.accessibility).toEqual([]);
    expect(model.timings.accessibilityMs).toBe(0);
  });

  it('fetches one tree per frame, keeps content names only in frames without secrets, and drops text leaves', async () => {
    const recording = loadRecording('frames');
    const { send, methods } = spy(recording);
    const model = await buildPageModel(recordedDeps(recording, { send }), {
      accessibility: true,
    });
    expect(
      methods.filter((method) => method === 'Accessibility.getFullAXTree'),
    ).toHaveLength(3);
    const [root, child, nested] = model.frames;
    if (!root || !child || !nested) throw new Error('Unexpected frames');
    // The main and nested documents have no secrets: content names stay.
    expect(namesFor(model, root.frameId).get(byId(model, 'before'))).toBe(
      'Before frame',
    );
    expect(
      namesFor(model, nested.frameId).get(byId(model, 'nested-button')),
    ).toBe('Nested action');
    // The child frame's input is secret (D3): only attribute names survive there.
    expect(
      namesFor(model, child.frameId).get(byId(model, 'frame-button')),
    ).toBeUndefined();
    expect(
      namesFor(model, child.frameId).get(byId(model, 'frame-name')),
    ).toBeUndefined();
    expect(
      model.accessibility.some(
        (node) =>
          ['StaticText', 'InlineTextBox'].includes(node.role ?? '') &&
          node.name,
      ),
    ).toBe(false);
  });

  it('caches each document tree beyond 500 ms and re-redacts cached names for the current secrets', async () => {
    const recording = loadRecording('form-controls');
    const registry = recordedRegistry(recording);
    const { send, methods } = spy(recording);
    const open = await buildPageModel(
      recordedDeps(recording, { registry, send }),
      {
        accessibility: true,
      },
    );
    const rootFrameId = open.frames[0]?.frameId ?? '';
    // No input was ever a password: the frame has no secrets, names are kept.
    expect(namesFor(open, rootFrameId).get(byId(open, 'email'))).toBe(
      'Email address',
    );
    expect(
      methods.filter((method) => method === 'Accessibility.getFullAXTree'),
    ).toHaveLength(1);
    // Password history now fails closed, so every input is secret.
    const closed = await buildPageModel(
      recordedDeps(recording, {
        registry,
        send,
        now: () => 1_900_000_000_000,
        isPasswordEverSeen: () => Promise.reject(new Error('bridge missing')),
      }),
      { accessibility: true },
    );
    expect(
      methods.filter((method) => method === 'Accessibility.getFullAXTree'),
    ).toHaveLength(1);
    const names = namesFor(closed, rootFrameId);
    expect(names.get(byId(closed, 'email'))).toBeUndefined();
    // Attribute-sourced names (aria-label) remain.
    expect(Array.from(names.values())).toContain('Feature');
  });

  it('fetches again for a new document and prunes the old entry', async () => {
    const recording = loadRecording('form-controls');
    const registry = recordedRegistry(recording);
    const { send, methods } = spy(recording);
    await buildPageModel(recordedDeps(recording, { registry, send }), {
      accessibility: true,
    });
    const root = recording.frames[0];
    if (!root) throw new Error('Unexpected recording');
    registry.noteFrameNavigated('', {
      id: root.frameId,
      loaderId: 'next-document',
      url: root.url,
    });
    await buildPageModel(recordedDeps(recording, { registry, send }), {
      accessibility: true,
    });
    expect(
      methods.filter((method) => method === 'Accessibility.getFullAXTree'),
    ).toHaveLength(2);
  });
});

describe('optional listener stage', () => {
  function listenerSend(scan: unknown): PageModelDeps['send'] {
    return (method, params) => {
      // The root frame is its session's top frame: its main world, no id.
      if (method === 'Runtime.evaluate' && params.contextId === undefined) {
        return Promise.resolve({ result: { type: 'object', value: scan } });
      }
      return Promise.reject(new Error(`Unexpected ${method}`));
    };
  }

  function rootFrameId(model: BrowserPageModel): string {
    const frameId = model.frames[0]?.frameId;
    if (!frameId) throw new Error('Missing root frame');
    return frameId;
  }

  it('maps scan paths onto the document and open roots, skipping closed roots', async () => {
    const recording = loadRecording('shadow');
    const scan = {
      count: 40,
      hits: [
        // Scope 1 is the first open root (#open-host); scope 2 the next (#nest-host).
        { scope: 1, path: [{ tag: 'button', position: 1 }] },
        {
          scope: 0,
          path: [
            { tag: 'html', position: 1 },
            { tag: 'body', position: 1 },
            { tag: 'x-card', position: 1 },
            { tag: 'button', position: 1 },
          ],
        },
        { scope: 2, path: [{ tag: 'div', position: 1 }] },
        { scope: 9, path: [{ tag: 'div', position: 1 }] },
        {
          scope: 0,
          path: [
            { tag: 'html', position: 1 },
            { tag: 'body', position: 4 },
          ],
        },
      ],
    };
    const { send } = spy(recording, listenerSend(scan));
    const model = await buildPageModel(recordedDeps(recording, { send }), {
      listeners: true,
    });
    expect(model.listeners).toEqual([
      {
        sessionId: '',
        frameId: rootFrameId(model),
        backendNodeIds: [
          byId(model, 'shadow-button'),
          byId(model, 'slotted-button'),
          byId(model, 'inner-host'),
        ],
        skipped: 'closed_shadow_roots_not_scanned',
      },
    ]);
  });

  it('reports a scan above 10,000 elements as skipped', async () => {
    const recording = loadRecording('form-controls');
    const { send } = spy(
      recording,
      listenerSend({ count: 10_001, hits: [], skipped: 'node_limit' }),
    );
    const model = await buildPageModel(recordedDeps(recording, { send }), {
      listeners: true,
    });
    expect(model.listeners).toEqual([
      {
        sessionId: '',
        frameId: rootFrameId(model),
        backendNodeIds: [],
        skipped: 'node_limit',
      },
    ]);
  });

  it('keeps at most 100 hits per build', async () => {
    const recording = loadRecording('form-controls');
    const hits = Array.from({ length: 150 }, () => ({
      scope: 0,
      path: [
        { tag: 'html', position: 1 },
        { tag: 'body', position: 1 },
        { tag: 'form', position: 1 },
        { tag: 'input', position: 1 },
      ],
    }));
    const { send } = spy(recording, listenerSend({ count: 60, hits }));
    const model = await buildPageModel(recordedDeps(recording, { send }), {
      listeners: true,
    });
    expect(model.listeners[0]?.backendNodeIds).toEqual([byId(model, 'email')]);
  });

  it('reports a frame whose scan fails', async () => {
    const recording = loadRecording('form-controls');
    const { send } = spy(recording, () =>
      Promise.reject(new Error('Execution context was destroyed.')),
    );
    const model = await buildPageModel(recordedDeps(recording, { send }), {
      listeners: true,
    });
    expect(model.listeners).toEqual([
      {
        sessionId: '',
        frameId: rootFrameId(model),
        backendNodeIds: [],
        skipped: 'scan_failed',
      },
    ]);
  });

  it('accepts no skip reason from the page other than node_limit', async () => {
    const recording = loadRecording('form-controls');
    const { send } = spy(
      recording,
      listenerSend({ count: 3, hits: [], skipped: 'page-chosen text' }),
    );
    const model = await buildPageModel(recordedDeps(recording, { send }), {
      listeners: true,
    });
    expect(model.listeners).toEqual([
      {
        sessionId: '',
        frameId: rootFrameId(model),
        backendNodeIds: [],
        skipped: 'scan_failed',
      },
    ]);
  });
});
