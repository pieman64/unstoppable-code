import { FrameRegistry, type NodeIdentity } from '../frame-registry';

function identity(
  frameId: string,
  sessionId: string,
  loaderId: string,
  backendNodeId: number,
): NodeIdentity {
  return { frameId, sessionId, loaderId, backendNodeId };
}

describe('FrameRegistry', () => {
  it('registers attached targets provisionally and reconciles navigation without changing frame identity', () => {
    const registry = new FrameRegistry();
    const attached = registry.noteAttached('child-session', {
      targetId: 'child-target',
      type: 'iframe',
      url: '',
    });
    if (attached === undefined) throw new Error('Expected an iframe record.');

    expect(attached).toEqual({
      frameId: 'child-target',
      sessionId: 'child-session',
      loaderId: '',
      url: '',
      targetId: 'child-target',
      frameRef: attached.frameRef,
    });
    expect(attached.frameRef).toMatch(/^f-.+-1$/);

    const navigated = registry.noteFrameNavigated('child-session', {
      id: 'child-frame',
      loaderId: 'loader-1',
      url: 'https://frame.example/path',
      parentId: 'root-frame',
    });

    expect(navigated).toMatchObject({
      frameId: 'child-frame',
      sessionId: 'child-session',
      loaderId: 'loader-1',
      url: 'https://frame.example/path',
      parentId: 'root-frame',
      targetId: 'child-target',
      frameRef: attached.frameRef,
    });
    expect(registry.getFrame('child-target')).toBeUndefined();
    expect(registry.getFrame('child-frame')).toEqual(navigated);
    expect(registry.frames()).toEqual([navigated]);
  });

  it('ignores attached targets that are not iframe targets', () => {
    const registry = new FrameRegistry();

    expect(
      registry.noteAttached('page-session', {
        targetId: 'page-target',
        type: 'page',
        url: 'https://example.test',
      }),
    ).toBeUndefined();
    expect(registry.frames()).toEqual([]);
  });

  it('accepts an empty root session id and provisions unknown frames on demand', () => {
    const registry = new FrameRegistry();
    const root = registry.noteFrameNavigated('', {
      id: 'root-frame',
      loaderId: 'root-loader',
      url: 'https://same.example/page',
    });

    const frameRef = registry.frameRefFor('late-frame', {
      sessionId: 'late-session',
      loaderId: 'late-loader',
      url: 'https://same.example/page',
      parentId: 'root-frame',
    });

    expect(registry.getFrame('root-frame')).toMatchObject({
      sessionId: '',
      frameRef: root.frameRef,
    });
    expect(registry.getFrame('late-frame')).toEqual({
      frameId: 'late-frame',
      sessionId: 'late-session',
      loaderId: 'late-loader',
      url: 'https://same.example/page',
      parentId: 'root-frame',
      frameRef,
    });
    expect(frameRef).not.toBe(root.frameRef);
  });

  it('keeps same-URL frames distinct and updates late target URLs without changing identity', () => {
    const registry = new FrameRegistry();
    const first = registry.noteAttached('session-a', {
      targetId: 'target-a',
      type: 'iframe',
      url: '',
    });
    const second = registry.noteAttached('session-b', {
      targetId: 'target-b',
      type: 'iframe',
      url: '',
    });
    if (first === undefined || second === undefined) {
      throw new Error('Expected attached iframe records.');
    }

    registry.noteTargetInfoChanged({
      targetId: 'target-a',
      type: 'iframe',
      url: 'https://same.example/page',
    });
    registry.noteTargetInfoChanged({
      targetId: 'target-b',
      type: 'iframe',
      url: 'https://same.example/page',
    });

    expect(registry.getFrame('target-a')).toMatchObject({
      frameRef: first.frameRef,
      sessionId: 'session-a',
      targetId: 'target-a',
      url: 'https://same.example/page',
    });
    expect(registry.getFrame('target-b')).toMatchObject({
      frameRef: second.frameRef,
      sessionId: 'session-b',
      targetId: 'target-b',
      url: 'https://same.example/page',
    });
    expect(first.frameRef).not.toBe(second.frameRef);

    const late = registry.noteTargetInfoChanged({
      targetId: 'target-c',
      type: 'iframe',
      url: 'https://late.example/document',
    });
    const attachedLater = registry.noteAttached('session-c', {
      targetId: 'target-c',
      type: 'iframe',
      url: '',
    });
    if (attachedLater === undefined)
      throw new Error('Expected an iframe record.');

    expect(late).toBeUndefined();
    expect(attachedLater.url).toBe('https://late.example/document');
    expect(attachedLater.frameId).toBe('target-c');
    expect(attachedLater.targetId).toBe('target-c');
  });

  it('keeps frontend refs distinct when backend node ids collide across sessions', () => {
    const registry = new FrameRegistry();
    registry.noteFrameNavigated('session-a', {
      id: 'frame-a',
      loaderId: 'loader-a',
      url: 'https://a.example',
    });
    registry.noteFrameNavigated('session-b', {
      id: 'frame-b',
      loaderId: 'loader-b',
      url: 'https://b.example',
    });

    const first = identity('frame-a', 'session-a', 'loader-a', 42);
    const second = identity('frame-b', 'session-b', 'loader-b', 42);
    const firstRef = registry.mintRef(first);
    const secondRef = registry.mintRef(second);

    expect(firstRef).not.toBe(secondRef);
    expect(registry.resolveRef(firstRef)).toEqual(first);
    expect(registry.resolveRef(secondRef)).toEqual(second);
  });

  it('keeps refs stable in one document and invalidates them when that document is replaced', () => {
    const registry = new FrameRegistry();
    registry.noteFrameNavigated('session-a', {
      id: 'frame-a',
      loaderId: 'loader-a',
      url: 'https://same.example/page',
    });
    const original = identity('frame-a', 'session-a', 'loader-a', 7);
    const originalRef = registry.mintRef(original);
    const frameRef = registry.getFrame('frame-a')?.frameRef;

    expect(registry.mintRef(original)).toBe(originalRef);
    expect(registry.resolveRef(originalRef)).toEqual(original);

    registry.resetDocument('frame-a', 'loader-b');

    const replacement = identity('frame-a', 'session-a', 'loader-b', 7);
    const replacementRef = registry.mintRef(replacement);
    expect(registry.resolveRef(originalRef)).toBeUndefined();
    expect(replacementRef).not.toBe(originalRef);
    expect(registry.resolveRef(replacementRef)).toEqual(replacement);
    expect(registry.getFrame('frame-a')?.frameRef).toBe(frameRef);
    expect(() => registry.mintRef(original)).toThrow(/stale|document/i);
  });

  it('drops child-document refs recursively when a parent document is replaced', () => {
    const registry = new FrameRegistry();
    registry.noteFrameNavigated('', {
      id: 'root',
      loaderId: 'root-loader-1',
      url: 'https://root.example/one',
    });
    registry.noteFrameNavigated('child-session', {
      id: 'child',
      loaderId: 'child-loader',
      url: 'https://child.example',
      parentId: 'root',
    });
    registry.noteFrameNavigated('grandchild-session', {
      id: 'grandchild',
      loaderId: 'grandchild-loader',
      url: 'https://grandchild.example',
      parentId: 'child',
    });

    const childRef = registry.mintRef(
      identity('child', 'child-session', 'child-loader', 9),
    );
    const grandchildRef = registry.mintRef(
      identity('grandchild', 'grandchild-session', 'grandchild-loader', 9),
    );
    registry.resetDocument('root', 'root-loader-2');

    expect(registry.getFrame('root')).toMatchObject({
      loaderId: 'root-loader-2',
    });
    expect(registry.getFrame('child')).toBeUndefined();
    expect(registry.getFrame('grandchild')).toBeUndefined();
    expect(registry.resolveRef(childRef)).toBeUndefined();
    expect(registry.resolveRef(grandchildRef)).toBeUndefined();
  });

  it('drops refs recursively when an iframe frame or its session detaches', () => {
    const registry = new FrameRegistry();
    registry.noteFrameNavigated('', {
      id: 'root',
      loaderId: 'root-loader',
      url: 'https://root.example',
    });
    registry.noteFrameNavigated('child-session', {
      id: 'child',
      loaderId: 'child-loader',
      url: 'https://child.example',
      parentId: 'root',
    });
    registry.noteFrameNavigated('grandchild-session', {
      id: 'grandchild',
      loaderId: 'grandchild-loader',
      url: 'https://grandchild.example',
      parentId: 'child',
    });
    registry.noteFrameNavigated('sibling-session', {
      id: 'sibling',
      loaderId: 'sibling-loader',
      url: 'https://sibling.example',
      parentId: 'root',
    });

    const childRef = registry.mintRef(
      identity('child', 'child-session', 'child-loader', 10),
    );
    const grandchildRef = registry.mintRef(
      identity('grandchild', 'grandchild-session', 'grandchild-loader', 10),
    );
    const siblingRef = registry.mintRef(
      identity('sibling', 'sibling-session', 'sibling-loader', 10),
    );

    registry.noteFrameDetached('child');
    expect(registry.getFrame('child')).toBeUndefined();
    expect(registry.getFrame('grandchild')).toBeUndefined();
    expect(registry.resolveRef(childRef)).toBeUndefined();
    expect(registry.resolveRef(grandchildRef)).toBeUndefined();
    expect(registry.resolveRef(siblingRef)).toBeDefined();

    registry.noteSessionDetached('');
    expect(registry.getFrame('root')).toBeUndefined();
    expect(registry.getFrame('sibling')).toBeUndefined();
    expect(registry.resolveRef(siblingRef)).toBeUndefined();
  });

  it('never re-registers a detached frame when minting a ref (m2)', () => {
    const registry = new FrameRegistry();
    registry.noteFrameNavigated('', {
      id: 'root',
      loaderId: 'root-loader',
      url: 'https://a.example',
    });
    registry.noteFrameNavigated('child-session', {
      id: 'child',
      loaderId: 'child-loader',
      url: 'https://b.example',
      parentId: 'root',
    });
    registry.noteFrameDetached('child');
    expect(() =>
      registry.mintRef(identity('child', 'child-session', 'child-loader', 4)),
    ).toThrow('frame_detached:');
    expect(registry.getFrame('child')).toBeUndefined();
    expect(registry.frames().map((frame) => frame.frameId)).toEqual(['root']);
    expect(() =>
      registry.mintRef(identity('root', '', 'stale-loader', 4)),
    ).toThrow('frame_detached:');
  });

  it('evicts the least recently used ref, so reused refs survive (m3)', () => {
    const registry = new FrameRegistry();
    registry.noteFrameNavigated('', {
      id: 'frame-a',
      loaderId: 'loader-a',
      url: 'https://a.example',
    });
    const reused = registry.mintRef(identity('frame-a', '', 'loader-a', 1));
    const unused = registry.mintRef(identity('frame-a', '', 'loader-a', 2));
    for (let backendNodeId = 3; backendNodeId <= 5001; backendNodeId += 1) {
      registry.mintRef(identity('frame-a', '', 'loader-a', backendNodeId));
      // A projection returning this node again refreshes its ref.
      if (backendNodeId % 1000 === 0) {
        expect(registry.mintRef(identity('frame-a', '', 'loader-a', 1))).toBe(
          reused,
        );
      }
    }
    expect(registry.resolveRef(reused)).toEqual(
      identity('frame-a', '', 'loader-a', 1),
    );
    expect(registry.resolveRef(unused)).toBeUndefined();
  });

  it('refreshes a ref when it is resolved, so the last inspected ref survives eviction (minor 7)', () => {
    const registry = new FrameRegistry();
    registry.noteFrameNavigated('', {
      id: 'frame-a',
      loaderId: 'loader-a',
      url: 'https://a.example',
    });
    const inspected = registry.mintRef(identity('frame-a', '', 'loader-a', 1));
    const untouched = registry.mintRef(identity('frame-a', '', 'loader-a', 2));
    for (let backendNodeId = 3; backendNodeId <= 5000; backendNodeId += 1) {
      registry.mintRef(identity('frame-a', '', 'loader-a', backendNodeId));
    }
    expect(registry.resolveRef(inspected)).toEqual(
      identity('frame-a', '', 'loader-a', 1),
    );
    registry.mintRef(identity('frame-a', '', 'loader-a', 5001));
    registry.mintRef(identity('frame-a', '', 'loader-a', 5002));
    expect(registry.resolveRef(untouched)).toBeUndefined();
    expect(registry.resolveRef(inspected)).toEqual(
      identity('frame-a', '', 'loader-a', 1),
    );
  });

  it('evicts refs FIFO at the per-browser limit without reusing an evicted ref', () => {
    const registry = new FrameRegistry();
    registry.noteFrameNavigated('', {
      id: 'frame-a',
      loaderId: 'loader-a',
      url: 'https://a.example',
    });

    const firstRef = registry.mintRef(identity('frame-a', '', 'loader-a', 1));
    for (let backendNodeId = 2; backendNodeId <= 5001; backendNodeId += 1) {
      registry.mintRef(identity('frame-a', '', 'loader-a', backendNodeId));
    }

    expect(registry.resolveRef(firstRef)).toBeUndefined();
    const newRef = registry.mintRef(identity('frame-a', '', 'loader-a', 1));
    expect(newRef).not.toBe(firstRef);
    expect(registry.resolveRef(newRef)).toEqual(
      identity('frame-a', '', 'loader-a', 1),
    );
  });
});
