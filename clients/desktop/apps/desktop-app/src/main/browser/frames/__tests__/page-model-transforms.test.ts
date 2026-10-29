import type { BrowserPageModel } from '../model-types';
import { buildPageModel } from '../page-model';
import { projectInputSnapshot } from '../projections';
import {
  loadRecording,
  recordedDeps,
  recordedSend,
  type Recording,
} from './fixtures/recorded-cdp';
import {
  findTreeNode,
  hasAttribute,
  numberField,
  treeRoot,
} from './fixtures/recording-edit';
import { expectedTopLevelRect } from './fixtures/transform-truth';

const PAGE = { browserId: 'transforms', url: '', title: '' };

/**
 * Child-frame rows on the recorded `transforms` page, whose frame owners are
 * scaled (an out-of-process frame scaled about its center with border and
 * padding, a frame in a scaled ancestor, a frame nested in a scaled frame)
 * or rotated and mirrored (omitted). Bounds are checked against what the
 * page reports through `getBoundingClientRect`, mapped by the test.
 */
describe('frames under transformed owners (PR #4917 finding 3)', () => {
  function rowBounds(
    model: BrowserPageModel,
  ): Map<string, { x: number; y: number; width: number; height: number }> {
    const bounds = new Map<
      string,
      { x: number; y: number; width: number; height: number }
    >();
    for (const row of projectInputSnapshot(
      model,
      { browserId: 'transforms', limit: 100 },
      PAGE,
    ).inputs) {
      const identity = model.registry.resolveRef(row.ref);
      const node = model.nodes.find(
        (candidate) =>
          identity !== undefined &&
          candidate.identity.frameId === identity.frameId &&
          candidate.identity.backendNodeId === identity.backendNodeId,
      );
      const id = node?.attributes.id;
      if (id) bounds.set(id, row.bounds);
    }
    return bounds;
  }

  it.each([
    ['button-scaled', ['scaled']],
    ['button-in-scaled', ['in-scaled']],
    ['button-outer', ['outer']],
    ['button-nested-outer', ['outer', 'nested-outer']],
    ['main-button', []],
  ])('%s is placed where the page reports it', async (buttonId, owners) => {
    const recording = loadRecording('transforms');
    const measurements = recording.measurements ?? {};
    const model = await buildPageModel(recordedDeps(recording));
    const actual = rowBounds(model).get(buttonId);
    const expected = expectedTopLevelRect(measurements, owners, buttonId);
    expect(actual).toBeDefined();
    for (const key of ['x', 'y', 'width', 'height'] as const) {
      // Rows are rounded like the preload's rectFor.
      const difference = Math.abs((actual?.[key] ?? NaN) - expected[key]);
      expect([key, difference <= 1, expected[key]]).toEqual([
        key,
        true,
        expected[key],
      ]);
    }
  });

  it('omits rotated and mirrored owners and the frames inside them', async () => {
    const recording = loadRecording('transforms');
    const model = await buildPageModel(recordedDeps(recording));
    const transformed = model.coverage.filter(
      (entry) => entry.reason === 'owner_transformed',
    );
    expect(
      transformed.map((entry) => new URL(entry.url).pathname).sort(),
    ).toEqual([
      '/transforms-child.html',
      '/transforms-child.html',
      '/transforms-outer.html',
    ]);
    const ids = Array.from(rowBounds(model).keys());
    for (const id of [
      'button-rotated',
      'button-nested-rotated',
      'button-mirrored',
    ]) {
      expect(ids).not.toContain(id);
    }
    expect(ids).toEqual(
      expect.arrayContaining([
        'main-button',
        'button-scaled',
        'button-in-scaled',
        'button-outer',
        'button-nested-outer',
      ]),
    );
  });

  it('clips a child row to the scaled owner and reports it in the viewport', async () => {
    const recording = loadRecording('transforms');
    const model = await buildPageModel(recordedDeps(recording));
    const button = model.nodes.find(
      (node) => node.attributes.id === 'button-scaled',
    );
    expect(button?.inViewport).toBe(true);
    const frame = model.frames.find(
      (candidate) => candidate.frameRef === button?.frameRef,
    );
    expect(frame?.depth).toBe(1);
  });
});

describe('owner geometry requests (PR #4917 finding 3)', () => {
  it('reads geometry only for owners that pass the visibility check', async () => {
    const recording = loadRecording('oopif');
    const replay = recordedSend(recording);
    const boxModels: number[] = [];
    const model = await buildPageModel(
      recordedDeps(recording, {
        send: (method, params, sessionId) => {
          if (method === 'DOM.getBoxModel') {
            boxModels.push(Number(params.backendNodeId));
          }
          return replay(method, params, sessionId);
        },
      }),
    );
    // The tiny and the hidden out-of-process owners are rejected first.
    expect(boxModels).toHaveLength(1);
    expect(
      model.coverage.filter((entry) => entry.reason === 'owner_not_visible'),
    ).toHaveLength(2);
  });

  it('omits a frame whose owner geometry cannot be read', async () => {
    const recording = loadRecording('transforms');
    const replay = recordedSend(recording);
    const inScaled = ownerBackendNodeId(recording, 'in-scaled');
    const model = await buildPageModel(
      recordedDeps(recording, {
        send: (method, params, sessionId) =>
          method === 'DOM.getBoxModel' && params.backendNodeId === inScaled
            ? Promise.reject(new Error('Could not compute box model.'))
            : replay(method, params, sessionId),
      }),
    );
    expect(
      model.coverage.filter(
        (entry) => entry.reason === 'owner_geometry_unavailable',
      ),
    ).toHaveLength(1);
    expect(
      model.nodes.some((node) => node.attributes.id === 'button-in-scaled'),
    ).toBe(false);
    expect(
      model.nodes.some((node) => node.attributes.id === 'button-outer'),
    ).toBe(true);
  });
});

function ownerBackendNodeId(recording: Recording, id: string): number {
  return numberField(
    findTreeNode(treeRoot(recording), (node) => hasAttribute(node, 'id', id)),
    'backendNodeId',
  );
}
