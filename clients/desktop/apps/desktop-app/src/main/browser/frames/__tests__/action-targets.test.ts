import {
  mapToAncestors,
  releaseActionTarget,
  resolveFocusedTarget,
  resolveLocatorTarget,
  resolvePointTarget,
  resolveRefTarget,
  type ActionTargetDeps,
  type ActionTargetResolution,
  type ResolvedActionTarget,
} from '../action-targets';
import { ExecutionContexts } from '../execution-contexts';
import { HOST_WORLD_NAME } from '../host-cdp';
import type { BrowserPageModel, PageModelNode } from '../model-types';
import { buildPageModel } from '../page-model';
import { projectInputSnapshot } from '../projections';
import {
  loadRecording,
  recordedDeps,
  recordedSend,
  type Recording,
} from './fixtures/recorded-cdp';

interface Sent {
  method: string;
  params: Record<string, unknown>;
  sessionId: string;
}

type Handler = (
  params: Record<string, unknown>,
  sessionId: string,
) => Promise<unknown> | undefined;

/**
 * Replays the recording, with handlers for the targeting requests. Their
 * responses copy Chromium's shapes from the S1 probe: `DOM.getNodeForLocation`
 * gives `{ backendNodeId, frameId }`, `DOM.describeNode` a node whose
 * `frameId` on an owner is its child frame, `DOM.getBoxModel` quads.
 */
function targeting(
  recording: Recording,
  handlers: Record<string, Handler>,
): { deps: ActionTargetDeps; sent: Sent[]; built: Promise<BrowserPageModel> } {
  const replay = recordedSend(recording);
  const sent: Sent[] = [];
  const send: ActionTargetDeps['send'] = (method, params, sessionId = '') => {
    sent.push({ method, params, sessionId });
    const handled = handlers[method]?.(params, sessionId);
    if (handled) return handled;
    if (method === 'DOM.resolveNode')
      return Promise.resolve({
        object: {
          type: 'object',
          subtype: 'node',
          objectId: `object:${sessionId}:${String(params.backendNodeId)}`,
        },
      });
    if (method === 'Runtime.callFunctionOn')
      return Promise.resolve({ result: { type: 'boolean', value: true } });
    return replay(method, params, sessionId);
  };
  const replayDeps = recordedDeps(recording);
  return {
    deps: {
      send,
      registry: replayDeps.registry,
      contexts: new ExecutionContexts(),
    },
    sent,
    built: buildPageModel(replayDeps),
  };
}

function nodeWithId(model: BrowserPageModel, id: string): PageModelNode {
  const node = model.nodes.find((candidate) => candidate.attributes.id === id);
  if (!node) throw new Error(`Missing #${id}`);
  return node;
}

function found(resolution: ActionTargetResolution): ResolvedActionTarget {
  if (resolution.status !== 'found')
    throw new Error(`Not found: ${resolution.status}`);
  return resolution.target;
}

function refFor(model: BrowserPageModel, id: string): string {
  const node = nodeWithId(model, id);
  const row = projectInputSnapshot(
    model,
    { browserId: 'targets', limit: 100 },
    { browserId: 'targets', url: '', title: '' },
  ).inputs.find((item) => {
    const identity = model.registry.resolveRef(item.ref);
    return identity?.backendNodeId === node.identity.backendNodeId;
  });
  if (!row) throw new Error(`No row for #${id}`);
  return row.ref;
}

describe('resolving a ref (D7)', () => {
  it('resolves once to the identity and a retained main-world object, in the node own session', async () => {
    for (const [name, id, outOfProcess] of [
      ['frames', 'frame-button', false],
      ['oopif', 'child-button', true],
    ] as const) {
      const recording = loadRecording(name);
      const { deps, sent, built } = targeting(recording, {});
      const model = await built;
      const node = nodeWithId(model, id);
      const target = found(await resolveRefTarget(deps, refFor(model, id)));
      expect(target).toMatchObject({
        identity: node.identity,
        frameRef: node.frameRef,
        outOfProcess,
        objectId: `object:${node.identity.sessionId}:${node.identity.backendNodeId}`,
      });
      expect(target.ref).toMatch(/^r-/);
      const resolve = sent.find((entry) => entry.method === 'DOM.resolveNode');
      expect(resolve).toEqual({
        method: 'DOM.resolveNode',
        params: {
          backendNodeId: node.identity.backendNodeId,
          objectGroup: target.objectGroup,
        },
        sessionId: node.identity.sessionId,
      });
      // Nothing frontend-node-id based: no DOM.getDocument, no requestNode.
      expect(
        sent.some((entry) =>
          ['DOM.getDocument', 'DOM.requestNode'].includes(entry.method),
        ),
      ).toBe(false);
    }
  });

  it('reports a ref whose document or node is gone as stale', async () => {
    const recording = loadRecording('frames');
    const detached = targeting(recording, {
      'Runtime.callFunctionOn': () =>
        Promise.resolve({ result: { type: 'boolean', value: false } }),
    });
    const model = await detached.built;
    const ref = refFor(model, 'frame-button');
    expect(await resolveRefTarget(detached.deps, ref)).toMatchObject({
      status: 'target_stale',
    });
    const gone = targeting(recording, {
      'DOM.resolveNode': () =>
        Promise.reject(new Error('No node with given id found')),
    });
    const goneModel = await gone.built;
    expect(
      await resolveRefTarget(gone.deps, refFor(goneModel, 'frame-button')),
    ).toMatchObject({ status: 'target_stale' });
    expect(
      await resolveRefTarget(
        gone.deps,
        'r-00000000-0000-0000-0000-000000000000-1',
      ),
    ).toMatchObject({ status: 'target_stale' });
    const navigated = targeting(recording, {});
    const navigatedModel = await navigated.built;
    const navigatedRef = refFor(navigatedModel, 'frame-button');
    const child = nodeWithId(navigatedModel, 'frame-button').identity;
    navigated.deps.registry.noteFrameNavigated('', {
      id: child.frameId,
      loaderId: 'next',
      url: 'about:srcdoc',
    });
    expect(await resolveRefTarget(navigated.deps, navigatedRef)).toMatchObject({
      status: 'target_stale',
    });
  });
});

describe('resolving a locator with an optional frame', () => {
  it('finds a unique match in any frame', async () => {
    const recording = loadRecording('frames');
    const { deps, built } = targeting(recording, {});
    const model = await built;
    const target = found(
      await resolveLocatorTarget(deps, model, "page.locator('#frame-name')"),
    );
    expect(target.identity).toEqual(nodeWithId(model, 'frame-name').identity);
  });

  it('reports matches in several frames as ambiguous, naming the frames', async () => {
    const recording = loadRecording('frames');
    const { deps, built } = targeting(recording, {});
    const model = await built;
    const resolution = await resolveLocatorTarget(
      deps,
      model,
      "page.locator('button')",
    );
    expect(resolution).toMatchObject({
      status: 'target_ambiguous',
      matchCount: 4,
    });
    if (resolution.status !== 'target_ambiguous')
      throw new Error('unreachable');
    expect(
      resolution.candidates.map((candidate) => candidate.frameRef),
    ).toEqual([
      model.frames[0]?.frameRef,
      model.frames[1]?.frameRef,
      model.frames[2]?.frameRef,
      model.frames[0]?.frameRef,
    ]);
    expect(resolution.candidates[1]).toMatchObject({
      tagName: 'button',
      role: 'button',
      name: 'Frame action',
    });
  });

  it('narrows to the frame field, and reports an unavailable frame', async () => {
    const recording = loadRecording('frames');
    const { deps, built } = targeting(recording, {});
    const model = await built;
    const child = model.frames[1];
    if (!child) throw new Error('Missing child frame');
    for (const frame of [child.frameRef, 'iframe#framed']) {
      expect(
        found(
          await resolveLocatorTarget(
            deps,
            model,
            "page.locator('button')",
            frame,
          ),
        ).identity,
      ).toEqual(nodeWithId(model, 'frame-button').identity);
    }
    expect(
      await resolveLocatorTarget(
        deps,
        model,
        "page.locator('button')",
        'iframe#missing',
      ),
    ).toMatchObject({ status: 'frame_unavailable' });
  });

  it('reports no match and unsupported locators distinctly', async () => {
    const recording = loadRecording('frames');
    const { deps, built } = targeting(recording, {});
    const model = await built;
    expect(
      await resolveLocatorTarget(deps, model, 'getByText("No such text")'),
    ).toMatchObject({ status: 'target_not_found' });
    expect(
      await resolveLocatorTarget(deps, model, "page.getByTitle('x')"),
    ).toMatchObject({ status: 'invalid_locator' });
  });
});

describe('resolving coordinates', () => {
  it('uses the root hit test, which reaches into same-process frames and shadow roots', async () => {
    const recording = loadRecording('frames');
    const held: { model?: BrowserPageModel } = {};
    const { deps, built } = targeting(recording, {
      'DOM.getNodeForLocation': (params, sessionId) => {
        const node = held.model && nodeWithId(held.model, 'frame-button');
        // Chromium rejects non-integer coordinates ("Invalid parameters").
        if (!Number.isInteger(params.x) || !Number.isInteger(params.y))
          return Promise.reject(new Error('Invalid parameters'));
        return sessionId === '' && params.x === 30 && params.y === 40 && node
          ? Promise.resolve({
              backendNodeId: node.identity.backendNodeId,
              frameId: node.identity.frameId,
            })
          : Promise.reject(new Error('No node found at given location'));
      },
      'DOM.describeNode': (params) =>
        Promise.resolve({
          node: {
            nodeId: 0,
            backendNodeId: params.backendNodeId,
            nodeType: 1,
            nodeName: 'BUTTON',
            localName: 'button',
          },
        }),
    });
    const model = await built;
    held.model = model;
    expect(found(await resolvePointTarget(deps, 30.4, 39.6)).identity).toEqual(
      nodeWithId(model, 'frame-button').identity,
    );
    expect(await resolvePointTarget(deps, 5_000, 5_000)).toMatchObject({
      status: 'target_not_found',
    });
  });

  it('resolves a hit on generated content to the element that owns it', async () => {
    const recording = loadRecording('frames');
    const held: { model?: BrowserPageModel } = {};
    // DOM.getNodeForLocation reports a ::before or ::after box as its own node.
    const pseudo = 9_000_001;
    const { deps, built, sent } = targeting(recording, {
      'DOM.getNodeForLocation': () => {
        const owner = held.model && nodeWithId(held.model, 'frame-button');
        return owner
          ? Promise.resolve({
              backendNodeId: pseudo,
              frameId: owner.identity.frameId,
            })
          : Promise.reject(new Error('No node found at given location'));
      },
      'DOM.describeNode': (params) => {
        const owner = held.model && nodeWithId(held.model, 'frame-button');
        return Promise.resolve({
          node:
            params.objectId === 'owner-object' && owner
              ? {
                  nodeId: 0,
                  backendNodeId: owner.identity.backendNodeId,
                  nodeType: 1,
                  nodeName: 'BUTTON',
                  localName: 'button',
                }
              : {
                  nodeId: 0,
                  backendNodeId: params.backendNodeId,
                  nodeType: 1,
                  nodeName: '::before',
                  localName: '::before',
                  pseudoType: 'before',
                },
        });
      },
      'Runtime.callFunctionOn': (params) =>
        params.objectId === `object::${String(pseudo)}`
          ? Promise.resolve({
              result: {
                type: 'object',
                subtype: 'node',
                objectId: 'owner-object',
              },
            })
          : undefined,
    });
    const model = await built;
    held.model = model;
    expect(found(await resolvePointTarget(deps, 30, 40)).identity).toEqual(
      nodeWithId(model, 'frame-button').identity,
    );
    const lookup = sent.find(
      (call) =>
        call.method === 'DOM.resolveNode' &&
        call.params.backendNodeId === pseudo,
    );
    expect(sent).toContainEqual({
      method: 'Runtime.releaseObjectGroup',
      params: { objectGroup: lookup?.params.objectGroup },
      sessionId: '',
    });
  });

  it('descends into an out-of-process frame through its owner content box', async () => {
    const recording = loadRecording('oopif');
    const held: { model?: BrowserPageModel } = {};
    const hits: Array<{ sessionId: string; x: unknown; y: unknown }> = [];
    const { deps, built } = targeting(recording, {
      'DOM.getNodeForLocation': (params, sessionId) => {
        hits.push({ sessionId, x: params.x, y: params.y });
        if (!Number.isInteger(params.x) || !Number.isInteger(params.y))
          return Promise.reject(new Error('Invalid parameters'));
        if (!held.model) return undefined;
        const node = nodeWithId(
          held.model,
          sessionId === '' ? 'visible-frame' : 'child-button',
        );
        return Promise.resolve({
          backendNodeId: node.identity.backendNodeId,
          frameId: node.identity.frameId,
        });
      },
      'DOM.describeNode': (params, sessionId) => {
        if (!held.model) return undefined;
        const owner = nodeWithId(held.model, 'visible-frame');
        const isOwner =
          sessionId === '' &&
          params.backendNodeId === owner.identity.backendNodeId;
        return Promise.resolve({
          node: {
            nodeId: 0,
            backendNodeId: params.backendNodeId,
            nodeType: 1,
            nodeName: isOwner ? 'IFRAME' : 'BUTTON',
            localName: isOwner ? 'iframe' : 'button',
            ...(isOwner ? { frameId: owner.childFrameId } : {}),
          },
        });
      },
      // The owner: border 2px at (8, 30), content 300 x 120 at (10, 32).
      'DOM.getBoxModel': () =>
        Promise.resolve({
          model: {
            content: [10, 32, 310, 32, 310, 152, 10, 152],
            padding: [10, 32, 310, 32, 310, 152, 10, 152],
            border: [8, 30, 312, 30, 312, 154, 8, 154],
            margin: [8, 30, 312, 30, 312, 154, 8, 154],
            width: 304,
            height: 124,
          },
        }),
    });
    const model = await built;
    held.model = model;
    const button = nodeWithId(model, 'child-button');
    const target = found(await resolvePointTarget(deps, 60.2, 52.4));
    expect(target.identity).toEqual(button.identity);
    expect(target.outOfProcess).toBe(true);
    expect(hits).toEqual([
      { sessionId: '', x: 60, y: 52 },
      { sessionId: button.identity.sessionId, x: 50, y: 20 },
    ]);
  });

  it("hit tests in each session's document coordinates when its document is scrolled", async () => {
    // Chromium's DOM.getNodeForLocation takes document coordinates: on a
    // page scrolled by 60, the viewport point hits another node (S2 probe,
    // HITTEST lines). Each session's own scroll applies.
    const recording = loadRecording('oopif');
    const held: { model?: BrowserPageModel } = {};
    const hits: Array<{ sessionId: string; x: unknown; y: unknown }> = [];
    const { deps, built } = targeting(recording, {
      'Page.getLayoutMetrics': (_params, sessionId) =>
        Promise.resolve({
          cssLayoutViewport: {
            pageX: sessionId === '' ? 4 : 0,
            pageY: sessionId === '' ? 60 : 25,
            clientWidth: 300,
            clientHeight: 120,
          },
        }),
      'DOM.getNodeForLocation': (params, sessionId) => {
        hits.push({ sessionId, x: params.x, y: params.y });
        if (!held.model) return undefined;
        const node = nodeWithId(
          held.model,
          sessionId === '' ? 'visible-frame' : 'child-button',
        );
        return Promise.resolve({
          backendNodeId: node.identity.backendNodeId,
          frameId: node.identity.frameId,
        });
      },
      'DOM.describeNode': (params, sessionId) => {
        if (!held.model) return undefined;
        const owner = nodeWithId(held.model, 'visible-frame');
        const isOwner =
          sessionId === '' &&
          params.backendNodeId === owner.identity.backendNodeId;
        return Promise.resolve({
          node: {
            nodeId: 0,
            backendNodeId: params.backendNodeId,
            nodeType: 1,
            nodeName: isOwner ? 'IFRAME' : 'BUTTON',
            localName: isOwner ? 'iframe' : 'button',
            ...(isOwner ? { frameId: owner.childFrameId } : {}),
          },
        });
      },
      // Box models are viewport coordinates, scrolled or not.
      'DOM.getBoxModel': () =>
        Promise.resolve({
          model: {
            content: [10, 32, 310, 32, 310, 152, 10, 152],
            padding: [10, 32, 310, 32, 310, 152, 10, 152],
            border: [8, 30, 312, 30, 312, 154, 8, 154],
            margin: [8, 30, 312, 30, 312, 154, 8, 154],
            width: 304,
            height: 124,
          },
        }),
    });
    held.model = await built;
    const button = nodeWithId(held.model, 'child-button');
    expect(found(await resolvePointTarget(deps, 60.2, 52.4)).identity).toEqual(
      button.identity,
    );
    expect(hits).toEqual([
      { sessionId: '', x: 64, y: 112 },
      { sessionId: button.identity.sessionId, x: 50, y: 45 },
    ]);
  });

  it('finds nothing when a session cannot report its scroll', async () => {
    const recording = loadRecording('frames');
    const { deps, sent } = targeting(recording, {
      'Page.getLayoutMetrics': () => Promise.reject(new Error('Target closed')),
    });
    expect(await resolvePointTarget(deps, 30, 40)).toMatchObject({
      status: 'target_not_found',
    });
    expect(
      sent.some((entry) => entry.method === 'DOM.getNodeForLocation'),
    ).toBe(false);
  });
});

describe('resolving the focused element for an untargeted press', () => {
  it('follows the active element through frames in the host world', async () => {
    const recording = loadRecording('frames');
    const held: { model?: BrowserPageModel } = {};
    const { deps, sent, built } = targeting(recording, {
      'Page.createIsolatedWorld': (params) =>
        Promise.resolve({
          executionContextId:
            params.frameId === held.model?.frames[0]?.frameId ? 61 : 62,
        }),
      'Runtime.evaluate': (params) =>
        Promise.resolve({
          result: {
            type: 'object',
            subtype: 'node',
            objectId: `active:${String(params.contextId)}`,
          },
        }),
      'DOM.describeNode': (params) => {
        if (!held.model) return undefined;
        const inRoot = params.objectId === 'active:61';
        const node = nodeWithId(held.model, inRoot ? 'framed' : 'frame-name');
        return Promise.resolve({
          node: {
            nodeId: 0,
            backendNodeId: node.identity.backendNodeId,
            nodeType: 1,
            nodeName: inRoot ? 'IFRAME' : 'INPUT',
            localName: inRoot ? 'iframe' : 'input',
            ...(inRoot ? { frameId: node.childFrameId } : {}),
          },
        });
      },
    });
    const model = await built;
    held.model = model;
    const target = found(await resolveFocusedTarget(deps));
    expect(target.identity).toEqual(nodeWithId(model, 'frame-name').identity);
    expect(
      sent
        .filter((entry) => entry.method === 'Page.createIsolatedWorld')
        .map((entry) => entry.params.worldName),
    ).toEqual([HOST_WORLD_NAME, HOST_WORLD_NAME]);
  });
});

describe('a focused root element', () => {
  it("is retained: its frame id is its own document's, not a child's", async () => {
    const recording = loadRecording('frames');
    const held: { model?: BrowserPageModel } = {};
    const { deps, built } = targeting(recording, {
      'Page.createIsolatedWorld': () =>
        Promise.resolve({ executionContextId: 61 }),
      'Runtime.evaluate': () =>
        Promise.resolve({
          result: { type: 'object', subtype: 'node', objectId: 'active' },
        }),
      // Chromium sets frameId on every <html>, as it does on a frame owner.
      'DOM.describeNode': () => {
        if (!held.model) return undefined;
        const root = nodeWithId(held.model, 'framed');
        return Promise.resolve({
          node: {
            nodeId: 0,
            backendNodeId: root.identity.backendNodeId,
            nodeType: 1,
            nodeName: 'HTML',
            localName: 'html',
            frameId: root.identity.frameId,
          },
        });
      },
    });
    const model = await built;
    held.model = model;
    const target = found(await resolveFocusedTarget(deps));
    expect(target.identity).toEqual(nodeWithId(model, 'framed').identity);
  });
});

describe('mapping a point to ancestor sessions (D9)', () => {
  it('maps through each out-of-process owner, with the owner the hit test must return', async () => {
    const recording = loadRecording('oopif');
    const held: { model?: BrowserPageModel } = {};
    const { deps, built } = targeting(recording, {
      'DOM.getFrameOwner': () => {
        const owner = held.model && nodeWithId(held.model, 'visible-frame');
        return owner
          ? Promise.resolve({ backendNodeId: owner.identity.backendNodeId })
          : undefined;
      },
      'DOM.getBoxModel': () =>
        Promise.resolve({
          model: {
            content: [10, 32, 160, 32, 160, 92, 10, 92],
            border: [8, 30, 162, 30, 162, 94, 8, 94],
            width: 308,
            height: 128,
          },
        }),
    });
    const model = await built;
    held.model = model;
    const button = nodeWithId(model, 'child-button');
    const owner = nodeWithId(model, 'visible-frame');
    // The owner is scaled by one half.
    expect(
      await mapToAncestors(deps, button.identity, { x: 40, y: 20 }),
    ).toEqual({
      status: 'mapped',
      hops: [
        {
          sessionId: '',
          frameId: button.identity.frameId,
          ownerBackendNodeId: owner.identity.backendNodeId,
          point: { x: 30, y: 42 },
        },
      ],
    });
    const main = nodeWithId(model, 'main-button');
    expect(await mapToAncestors(deps, main.identity, { x: 1, y: 1 })).toEqual({
      status: 'mapped',
      hops: [],
    });
  });

  it('reports rotated owners and unknown frames', async () => {
    const recording = loadRecording('oopif');
    const held: { model?: BrowserPageModel } = {};
    const { deps, built } = targeting(recording, {
      'DOM.getFrameOwner': () => {
        const owner = held.model && nodeWithId(held.model, 'visible-frame');
        return owner
          ? Promise.resolve({ backendNodeId: owner.identity.backendNodeId })
          : undefined;
      },
      'DOM.getBoxModel': () =>
        Promise.resolve({
          model: {
            content: [60, 0, 120, 60, 60, 120, 0, 60],
            border: [60, -2, 122, 60, 60, 122, -2, 60],
            width: 88,
            height: 88,
          },
        }),
    });
    const model = await built;
    held.model = model;
    const button = nodeWithId(model, 'child-button');
    expect(await mapToAncestors(deps, button.identity, { x: 1, y: 1 })).toEqual(
      {
        status: 'owner_transformed',
      },
    );
    expect(
      await mapToAncestors(
        deps,
        { ...button.identity, frameId: 'gone' },
        { x: 1, y: 1 },
      ),
    ).toEqual({ status: 'frame_unavailable' });
  });
});

describe('releasing a target', () => {
  it('releases its object group in its own session', async () => {
    const recording = loadRecording('oopif');
    const { deps, sent, built } = targeting(recording, {});
    const model = await built;
    const target = found(
      await resolveRefTarget(deps, refFor(model, 'child-button')),
    );
    await releaseActionTarget(deps, target);
    expect(sent[sent.length - 1]).toEqual({
      method: 'Runtime.releaseObjectGroup',
      params: { objectGroup: target.objectGroup },
      sessionId: target.identity.sessionId,
    });
  });
});

describe('targeting on a recorded Chromium page', () => {
  it('resolves every row center to that row, in same-process frames, closed roots and an out-of-process frame', async () => {
    const recording = loadRecording('trackers');
    const { deps, built } = targeting(recording, {});
    const model = await built;
    const rows = projectInputSnapshot(
      model,
      { browserId: 'targets', limit: 100 },
      { browserId: 'targets', url: '', title: '' },
    ).inputs;
    expect(rows.length).toBeGreaterThan(15);
    const misses: string[] = [];
    for (const row of rows) {
      const expected = model.registry.resolveRef(row.ref);
      const resolution = await resolvePointTarget(
        deps,
        row.bounds.x + row.bounds.width / 2,
        row.bounds.y + row.bounds.height / 2,
      );
      if (
        resolution.status !== 'found' ||
        resolution.target.identity.backendNodeId !== expected?.backendNodeId ||
        resolution.target.identity.sessionId !== expected.sessionId
      ) {
        misses.push(`${row.tagName} ${row.name ?? ''}: ${resolution.status}`);
      }
    }
    expect(misses).toEqual([]);
  });

  it('maps an out-of-process row center back to the top-level point, through its real owner', async () => {
    const recording = loadRecording('trackers');
    const { deps, built } = targeting(recording, {});
    const model = await built;
    const cross = model.frames.find((frame) => frame.sessionId !== '');
    if (!cross) throw new Error('Missing out-of-process frame');
    const owner = model.nodes[cross.ownerNodeIndex ?? -1];
    const rows = projectInputSnapshot(
      model,
      { browserId: 'targets', limit: 100 },
      { browserId: 'targets', url: '', title: '' },
    ).inputs.filter((row) => row.frameRef === cross.frameRef);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      const identity = model.registry.resolveRef(row.ref);
      if (!identity) throw new Error('Unresolvable row');
      const x = row.bounds.x + row.bounds.width / 2;
      const y = row.bounds.y + row.bounds.height / 2;
      const { x: tx, y: ty, scaleX, scaleY } = cross.viewportTransform;
      const mapping = await mapToAncestors(deps, identity, {
        x: (x - tx) / scaleX,
        y: (y - ty) / scaleY,
      });
      if (mapping.status !== 'mapped') throw new Error(mapping.status);
      expect(mapping.hops).toHaveLength(1);
      const [hop] = mapping.hops;
      expect(hop?.ownerBackendNodeId).toBe(owner?.identity.backendNodeId);
      expect(hop?.sessionId).toBe('');
      expect(Math.abs((hop?.point.x ?? 0) - x)).toBeLessThan(0.01);
      expect(Math.abs((hop?.point.y ?? 0) - y)).toBeLessThan(0.01);
    }
  });
});
