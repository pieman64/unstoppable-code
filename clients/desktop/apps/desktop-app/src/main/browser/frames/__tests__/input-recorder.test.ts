/**
 * @jest-environment jsdom
 */
import { ExecutionContexts } from '../execution-contexts';
import { FrameRegistry } from '../frame-registry';
import {
  armInputRecorder,
  inputMatches,
  type RecordedInput,
} from '../input-recorder';

/**
 * Delivery confirmation for targets in child frames: the main frame's
 * preload never sees their input, so a recorder in the target document's
 * host world does. The page function runs in this jsdom window, standing
 * for that world. jsdom cannot make trusted events, so recording trusted
 * input is proven in the live probe (`live-probe-s2.ts`, RECORDER lines);
 * here script-made events must not count.
 */

function deps(): {
  send: jest.Mock<Promise<unknown>, [string, Record<string, unknown>, string?]>;
  registry: FrameRegistry;
  contexts: ExecutionContexts;
} {
  const objects = new Map<string, unknown>();
  let next = 0;
  const send = jest.fn(
    (method: string, params: Record<string, unknown>): Promise<unknown> => {
      if (method === 'Page.createIsolatedWorld')
        return Promise.resolve({ executionContextId: 31 });
      if (method === 'Runtime.callFunctionOn') {
        const self =
          typeof params.objectId === 'string'
            ? objects.get(params.objectId)
            : window;
        // Indirect eval: the declaration is compiled in the global scope.
        const evaluate: unknown = Reflect.get(window, 'eval');
        if (typeof evaluate !== 'function') throw new Error('No eval');
        const fn: unknown = Reflect.apply(evaluate, window, [
          `(${String(params.functionDeclaration)})`,
        ]);
        if (typeof fn !== 'function') throw new Error('Not a function');
        const value: unknown = Reflect.apply(fn, self, []);
        if (params.returnByValue === true) {
          const copy: unknown = JSON.parse(JSON.stringify(value ?? null));
          return Promise.resolve({ result: { type: 'object', value: copy } });
        }
        next += 1;
        objects.set(`recorder-${next}`, value);
        return Promise.resolve({
          result: { type: 'object', objectId: `recorder-${next}` },
        });
      }
      if (method === 'Runtime.releaseObjectGroup') return Promise.resolve({});
      return Promise.reject(new Error(`Unexpected ${method}`));
    },
  );
  const registry = new FrameRegistry();
  registry.noteFrameNavigated('child', {
    id: 'frame-1',
    loaderId: 'loader-1',
    url: 'https://child.test/',
  });
  return { send, registry, contexts: new ExecutionContexts() };
}

const IDENTITY = {
  sessionId: 'child',
  frameId: 'frame-1',
  loaderId: 'loader-1',
  backendNodeId: 7,
};

describe('the input recorder of a frame target', () => {
  it("listens in the target document's host world, counts no script-made event, and stops and releases once", async () => {
    const cdp = deps();
    const recorder = await armInputRecorder(cdp, IDENTITY);
    if (!recorder) throw new Error('No recorder');
    const arm = cdp.send.mock.calls.find(
      ([method]) => method === 'Runtime.callFunctionOn',
    );
    expect(arm?.[1]).toMatchObject({
      executionContextId: 31,
      returnByValue: false,
    });
    expect(arm?.[2]).toBe('child');
    window.dispatchEvent(
      new MouseEvent('pointerdown', { button: 0, clientX: 40, clientY: 12 }),
    );
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'q' }));
    expect(await recorder.read()).toEqual([]);
    await recorder.dispose();
    await recorder.dispose();
    expect(
      cdp.send.mock.calls.filter(
        ([method, , session]) =>
          method === 'Runtime.releaseObjectGroup' && session === 'child',
      ),
    ).toHaveLength(1);
    expect(await recorder.read()).toBeUndefined();
  });

  it('is unavailable when the frame is gone or its world cannot be made', async () => {
    const cdp = deps();
    expect(
      await armInputRecorder(cdp, { ...IDENTITY, frameId: 'gone' }),
    ).toBeUndefined();
    cdp.send.mockImplementation(() =>
      Promise.reject(new Error('Target closed')),
    );
    expect(await armInputRecorder(cdp, IDENTITY)).toBeUndefined();
  });

  it('must not arm a recorder for an old loader in the replacement document (review R2 finding 1)', async () => {
    const cdp = deps();
    cdp.registry.noteFrameNavigated('child', {
      id: 'frame-1',
      loaderId: 'loader-2',
      url: 'https://child.test/',
    });
    const recorder = await armInputRecorder(cdp, IDENTITY);
    expect(recorder).toBeUndefined();
    expect(
      cdp.send.mock.calls.some(
        ([method]) => method === 'Runtime.callFunctionOn',
      ),
    ).toBe(false);
  });

  it('releases a recorder armed while the document was replaced', async () => {
    const cdp = deps();
    const answer = cdp.send.getMockImplementation();
    cdp.send.mockImplementation((method, params, sessionId) => {
      // The document is replaced while the host world is being made.
      if (method === 'Page.createIsolatedWorld')
        cdp.registry.noteFrameNavigated('child', {
          id: 'frame-1',
          loaderId: 'loader-2',
          url: 'https://child.test/',
        });
      return answer
        ? answer(method, params, sessionId)
        : Promise.reject(new Error('No mock'));
    });
    expect(await armInputRecorder(cdp, IDENTITY)).toBeUndefined();
    cdp.send.mockImplementation((method, params, sessionId) => {
      // ...or while the recorder is being installed.
      if (method === 'Runtime.callFunctionOn' && params.objectId === undefined)
        cdp.registry.noteFrameNavigated('child', {
          id: 'frame-1',
          loaderId: 'loader-3',
          url: 'https://child.test/',
        });
      return answer
        ? answer(method, params, sessionId)
        : Promise.reject(new Error('No mock'));
    });
    expect(
      await armInputRecorder(cdp, { ...IDENTITY, loaderId: 'loader-2' }),
    ).toBeUndefined();
    // The installed recorder was stopped and its object group released.
    const methods = cdp.send.mock.calls.map(([method]) => method);
    expect(methods.slice(-2)).toEqual([
      'Runtime.callFunctionOn',
      'Runtime.releaseObjectGroup',
    ]);
  });

  it('reads nothing once the document is gone', async () => {
    const cdp = deps();
    const recorder = await armInputRecorder(cdp, IDENTITY);
    cdp.send.mockImplementation(() =>
      Promise.reject(new Error('Cannot find context with specified id')),
    );
    expect(await recorder?.read()).toBeUndefined();
  });
});

describe('matching recorded input to the dispatched input', () => {
  const pointer: RecordedInput = {
    type: 'pointerdown',
    button: 0,
    clientX: 40.5,
    clientY: 12,
    at: 1_000,
  };

  it('matches the button and the point in document coordinates', () => {
    expect(
      inputMatches(pointer, {
        at: 1_000,
        type: 'pointerdown',
        button: 0,
        point: { x: 41, y: 13 },
      }),
    ).toBe(true);
    expect(
      inputMatches(pointer, {
        at: 1_000,
        type: 'pointerdown',
        button: 2,
        point: { x: 41, y: 13 },
      }),
    ).toBe(false);
    expect(
      inputMatches(pointer, {
        at: 1_000,
        type: 'pointerdown',
        button: 0,
        point: { x: 60, y: 13 },
      }),
    ).toBe(false);
  });

  it('matches a key by its key value', () => {
    const key: RecordedInput = { type: 'keydown', key: 'Enter', at: 1_000 };
    expect(
      inputMatches(key, { at: 1_000, type: 'keydown', key: 'Enter' }),
    ).toBe(true);
    // Recorded before the press was sent: not this action's input.
    expect(
      inputMatches(key, { at: 1_001, type: 'keydown', key: 'Enter' }),
    ).toBe(false);
    expect(inputMatches(key, { at: 1_000, type: 'keydown', key: 'a' })).toBe(
      false,
    );
    expect(
      inputMatches(key, {
        at: 1_000,
        type: 'pointerdown',
        button: 0,
        point: { x: 0, y: 0 },
      }),
    ).toBe(false);
  });
});
