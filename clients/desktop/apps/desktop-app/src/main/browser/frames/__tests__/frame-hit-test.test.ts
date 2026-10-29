import { mapToAncestors, type ActionTargetDeps } from '../action-targets';
import { ExecutionContexts } from '../execution-contexts';
import { documentMapping, outerHitTest } from '../frame-hit-test';
import type { BrowserPageModel, PageModelNode } from '../model-types';
import { buildPageModel } from '../page-model';
import {
  loadRecording,
  recordedDeps,
  recordedSend,
} from './fixtures/recorded-cdp';

/**
 * The coordinate rule and the cross-document hit test (D9) on the recorded
 * `trackers` page: a same-process frame and an out-of-process frame, with
 * Chromium's own hit-test answers at each row's center.
 */
/** Answers a request instead of the recording, or leaves it to it. */
type Override = (
  method: string,
  params: Record<string, unknown>,
  sessionId?: string,
) => Promise<unknown> | undefined;

async function setup(
  overrides: Override = (): undefined => undefined,
  name: 'trackers' | 'frames' = 'trackers',
): Promise<{ deps: ActionTargetDeps; model: BrowserPageModel }> {
  const recording = loadRecording(name);
  const replay = recordedSend(recording);
  const replayDeps = recordedDeps(recording);
  const model = await buildPageModel(replayDeps);
  const owners = new Map<string, number>();
  for (const frame of model.frames) {
    const owner =
      frame.ownerNodeIndex === undefined
        ? undefined
        : model.nodes[frame.ownerNodeIndex];
    if (owner) owners.set(frame.frameId, owner.identity.backendNodeId);
  }
  return {
    model,
    deps: {
      registry: replayDeps.registry,
      contexts: new ExecutionContexts(),
      send: (method, params, sessionId): Promise<unknown> => {
        const overridden = overrides(method, params, sessionId);
        if (overridden) return overridden;
        // Same-process owners were never asked for during recording.
        if (method === 'DOM.getFrameOwner' && sessionId === '') {
          const owner = owners.get(String(params.frameId));
          if (owner !== undefined)
            return Promise.resolve({ backendNodeId: owner });
        }
        if (method === 'DOM.describeNode')
          return Promise.resolve({
            node: {
              nodeId: 0,
              backendNodeId: params.backendNodeId,
              nodeType: 1,
              nodeName: 'DIV',
              attributes: ['class', 'overlay banner'],
            },
          });
        return replay(method, params, sessionId);
      },
    },
  };
}

function nodeWithId(model: BrowserPageModel, id: string): PageModelNode {
  const node = model.nodes.find((candidate) => candidate.attributes.id === id);
  if (!node) throw new Error(`Missing #${id}`);
  return node;
}

function center(rectangle: {
  x: number;
  y: number;
  width: number;
  height: number;
}): {
  x: number;
  y: number;
} {
  return {
    x: rectangle.x + rectangle.width / 2,
    y: rectangle.y + rectangle.height / 2,
  };
}

describe('document coordinates to session coordinates', () => {
  it('is the identity at a session top: the main frame and an out-of-process frame', async () => {
    const { deps, model } = await setup();
    for (const id of ['open-plain', 'cross-plain']) {
      expect(
        await documentMapping(deps, nodeWithId(model, id).identity),
      ).toEqual({
        originX: 0,
        originY: 0,
        scaleX: 1,
        scaleY: 1,
      });
    }
  });

  it("maps a same-process frame's document through its owner's content box", async () => {
    const { deps, model } = await setup();
    const node = nodeWithId(model, 'frame-plain');
    const mapping = await documentMapping(deps, node.identity);
    if (!mapping) throw new Error('No mapping');
    const local = center(node.frameLocalBounds);
    const top = center(node.bounds);
    expect(
      Math.abs(mapping.originX + mapping.scaleX * local.x - top.x),
    ).toBeLessThan(0.5);
    expect(
      Math.abs(mapping.originY + mapping.scaleY * local.y - top.y),
    ).toBeLessThan(0.5);
  });

  it('maps the recorded `frames` page: a same-process frame and one nested in it', async () => {
    const { deps, model } = await setup(undefined, 'frames');
    for (const id of ['frame-button', 'nested-button']) {
      const node = nodeWithId(model, id);
      const mapping = await documentMapping(deps, node.identity);
      if (!mapping) throw new Error(`No mapping for #${id}`);
      const local = center(node.frameLocalBounds);
      const top = center(node.bounds);
      expect([
        id,
        Math.round(mapping.originX + mapping.scaleX * local.x - top.x),
        Math.round(mapping.originY + mapping.scaleY * local.y - top.y),
      ]).toEqual([id, 0, 0]);
    }
  });

  it('is unavailable for a frame that is gone', async () => {
    const { deps, model } = await setup();
    expect(
      await documentMapping(deps, {
        ...nodeWithId(model, 'frame-plain').identity,
        frameId: 'gone',
      }),
    ).toBeUndefined();
  });
});

describe('hit test in the documents above the target (D9)', () => {
  it('passes every row of the same-process and out-of-process frames at its center', async () => {
    const { deps, model } = await setup();
    const frameIds = new Set(
      model.frames
        .filter((frame) => frame.parentFrameId !== undefined)
        .map((frame) => frame.frameId),
    );
    const rows = model.nodes.filter(
      (node) =>
        frameIds.has(node.identity.frameId) &&
        ['frame-plain', 'frame-note', 'cross-plain', 'cross-button'].includes(
          node.attributes.id ?? '',
        ),
    );
    expect(rows).toHaveLength(4);
    for (const node of rows) {
      const mapping = await documentMapping(deps, node.identity);
      if (!mapping) throw new Error('No mapping');
      const local = center(node.frameLocalBounds);
      const sessionPoint = {
        x: mapping.originX + mapping.scaleX * local.x,
        y: mapping.originY + mapping.scaleY * local.y,
      };
      expect([
        node.attributes.id,
        await outerHitTest(deps, node.identity, sessionPoint),
      ]).toEqual([node.attributes.id, { receivesEvents: true }]);
    }
  });

  it('reports an element of another document at the point as covering the target', async () => {
    const { deps, model } = await setup((method, params, sessionId) =>
      method === 'DOM.getNodeForLocation' && sessionId === ''
        ? Promise.resolve({
            backendNodeId: 9_999,
            frameId: model.frames[0]?.frameId,
          })
        : undefined,
    );
    for (const id of ['frame-plain', 'cross-plain']) {
      const node = nodeWithId(model, id);
      expect(
        await outerHitTest(deps, node.identity, center(node.frameLocalBounds)),
      ).toEqual({ receivesEvents: false, cover: 'div.overlay.banner' });
    }
  });

  it("hit tests at each session's document coordinates when it is scrolled", async () => {
    const hits: Array<[string, unknown, unknown]> = [];
    const held: { model?: BrowserPageModel } = {};
    const { deps, model } = await setup((method, params, sessionId = '') => {
      if (method === 'Page.getLayoutMetrics')
        return Promise.resolve({
          cssLayoutViewport: { pageX: 0, pageY: sessionId === '' ? 60 : 25 },
        });
      if (method !== 'DOM.getNodeForLocation') return undefined;
      hits.push([sessionId, params.x, params.y]);
      const answer = held.model?.frames.find(
        (frame) => frame.parentFrameId !== undefined,
      );
      const owner = held.model?.nodes.find(
        (node) => node.attributes.id === 'cross',
      );
      return sessionId === ''
        ? Promise.resolve(
            params.y === 160
              ? { backendNodeId: 1, frameId: answer?.frameId }
              : {
                  backendNodeId: owner?.identity.backendNodeId,
                  frameId: owner?.identity.frameId,
                },
          )
        : undefined;
    });
    held.model = model;
    const same = nodeWithId(model, 'frame-plain');
    const sameFrame = model.frames.find(
      (frame) => frame.frameId === same.identity.frameId,
    );
    if (!sameFrame) throw new Error('No frame');
    held.model = {
      ...model,
      frames: [sameFrame],
    };
    expect(
      await outerHitTest(deps, same.identity, { x: 10.4, y: 100 }),
    ).toEqual({ receivesEvents: true });
    expect(hits).toEqual([['', 10, 160]]);
    hits.length = 0;
    const cross = nodeWithId(model, 'cross-plain');
    await outerHitTest(deps, cross.identity, { x: 5, y: 5 });
    const [hop] = hits;
    const mapping = await mapToAncestors(deps, cross.identity, { x: 5, y: 5 });
    if (mapping.status !== 'mapped') throw new Error('Not mapped');
    expect(hop).toEqual([
      '',
      Math.round(mapping.hops[0]?.point.x ?? 0),
      Math.round((mapping.hops[0]?.point.y ?? 0) + 60),
    ]);
  });

  it('needs no hit test above the main frame', async () => {
    const sent: string[] = [];
    const { deps, model } = await setup((method) => {
      sent.push(method);
      return undefined;
    });
    const node = nodeWithId(model, 'open-plain');
    expect(await outerHitTest(deps, node.identity, { x: 1, y: 1 })).toEqual({
      receivesEvents: true,
    });
    expect(sent).toEqual([]);
  });

  it('cannot pass a target whose ancestors cannot be mapped', async () => {
    const { deps, model } = await setup((method) =>
      method === 'DOM.getFrameOwner'
        ? Promise.reject(new Error('Frame with given id not found'))
        : undefined,
    );
    const node = nodeWithId(model, 'cross-plain');
    expect(await mapToAncestors(deps, node.identity, { x: 1, y: 1 })).toEqual({
      status: 'frame_unavailable',
    });
    expect(
      await outerHitTest(deps, node.identity, center(node.frameLocalBounds)),
    ).toEqual({
      receivesEvents: false,
      cover: 'a frame owner that could not be found',
    });
  });
});
