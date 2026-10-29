/**
 * @jest-environment jsdom
 */
import type { ActionLaneContext } from '../action-lane';
import { checkActionability, type BrowserCdpSend } from '../actionability';
import { dispatchFocus, dispatchTargetedPress } from '../input-dispatch';
import { buildKeyEventSequence, parseKeyCombo } from '../key-definitions';

/**
 * Review R2 finding 4: controls in shadow roots. The production page
 * functions run in this jsdom realm with real open and closed roots and
 * real focus. jsdom has no hit testing, so `elementFromPoint` is supplied
 * as Chromium answers: the document's retargets a hit in a shadow root to
 * its host; a shadow root's gives the deepest element in its own scope, and
 * an element of the document tree (an overlay) as it is.
 */

afterEach(() => {
  document.body.innerHTML = '';
  Reflect.deleteProperty(document, 'elementFromPoint');
});

interface ShadowTarget {
  host: HTMLElement;
  root: ShadowRoot;
  input: HTMLInputElement;
  sibling: HTMLElement;
  send: BrowserCdpSend;
  /** What a hit test at the input's center finds, in the root's scope. */
  hitInRoot(element: Element): void;
}

function shadowTarget(mode: 'open' | 'closed'): ShadowTarget {
  const host = document.createElement('div');
  document.body.append(host);
  const root = host.attachShadow({ mode });
  const input = document.createElement('input');
  const sibling = document.createElement('div');
  root.append(input, sibling);
  input.getBoundingClientRect = (): DOMRect => new DOMRect(10, 20, 40, 20);
  let hit: Element = input;
  // The document's hit test stops at the host (or the document overlay).
  Object.defineProperty(document, 'elementFromPoint', {
    configurable: true,
    value: (): Element => (hit.getRootNode() === root ? host : hit),
  });
  Object.defineProperty(root, 'elementFromPoint', {
    configurable: true,
    value: (): Element => hit,
  });
  const send: BrowserCdpSend = (method, params) => {
    if (method === 'Runtime.callFunctionOn') {
      const evaluate: unknown = Reflect.get(window, 'eval');
      if (typeof evaluate !== 'function') throw new Error('No eval');
      const fn: unknown = Reflect.apply(evaluate, window, [
        `(${String(params.functionDeclaration)})`,
      ]);
      if (typeof fn !== 'function') throw new Error('Not a function');
      const args = Array.isArray(params.arguments)
        ? params.arguments.map((arg: unknown): unknown => {
            if (typeof arg !== 'object' || arg === null) return undefined;
            const argument: unknown = Reflect.get(arg, 'value');
            return argument;
          })
        : [];
      const value: unknown = Reflect.apply(fn, input, args);
      return Promise.resolve({ result: { value } });
    }
    if (method === 'DOM.focus') {
      input.focus();
      return Promise.resolve({});
    }
    if (method === 'DOM.getContentQuads')
      return Promise.resolve({ quads: [[10, 20, 50, 20, 50, 40, 10, 40]] });
    if (method === 'DOM.getBoxModel')
      return Promise.resolve({
        model: { border: [10, 20, 50, 20, 50, 40, 10, 40] },
      });
    return Promise.resolve({});
  };
  return {
    host,
    root,
    input,
    sibling,
    send,
    hitInRoot: (element): void => {
      hit = element;
    },
  };
}

function lane(): ActionLaneContext {
  return {
    signal: new AbortController().signal,
    sequence: 1,
    beginDispatch: (): void => undefined,
    trackCommand: <T>(command: Promise<T>): Promise<T> => command,
    registerCleanup: (): void => undefined,
  };
}

function keys(combo: string): ReturnType<typeof buildKeyEventSequence> {
  const parsed = parseKeyCombo(combo, 'linux');
  if (!parsed.ok) throw new Error(`No combo ${combo}`);
  return buildKeyEventSequence(parsed, 'linux');
}

describe.each(['open', 'closed'] as const)(
  'controls in a %s shadow root (review R2 finding 4)',
  (mode) => {
    it('allows a trusted click on an uncovered control', async () => {
      const target = shadowTarget(mode);
      expect(
        await checkActionability({
          send: target.send,
          objectId: 'input',
          backendNodeId: 1,
          action: 'click',
          timeoutMs: 300,
        }),
      ).toMatchObject({ status: 'ready', point: { x: 30, y: 30 } });
    });

    it('allows a positioned trusted click on an uncovered control', async () => {
      const target = shadowTarget(mode);
      expect(
        await checkActionability({
          send: target.send,
          objectId: 'input',
          backendNodeId: 1,
          action: 'click',
          position: { x: 5, y: 5 },
          timeoutMs: 300,
        }),
      ).toMatchObject({ status: 'ready', point: { x: 15, y: 25 } });
    });

    it('still counts a sibling in the same root, or an overlay in the document, as covering it', async () => {
      for (const cover of ['sibling', 'overlay'] as const) {
        const target = shadowTarget(mode);
        const overlay = document.createElement('section');
        document.body.append(overlay);
        target.hitInRoot(cover === 'sibling' ? target.sibling : overlay);
        expect([
          cover,
          await checkActionability({
            send: target.send,
            objectId: 'input',
            backendNodeId: 1,
            action: 'click',
            timeoutMs: 300,
          }),
        ]).toEqual([
          cover,
          expect.objectContaining({ status: 'fallback', reason: 'covered' }),
        ]);
        expect([
          cover,
          await checkActionability({
            send: target.send,
            objectId: 'input',
            backendNodeId: 1,
            action: 'click',
            position: { x: 5, y: 5 },
            timeoutMs: 300,
          }),
        ]).toEqual([
          cover,
          { status: 'not_executed', code: 'target_obscured' },
        ]);
      }
    });

    it.each(['Enter', 'Tab'])(
      'sends a real %s when DOM.focus focused the exact control',
      async (key) => {
        const target = shadowTarget(mode);
        const syntheticFallback = jest.fn(() => Promise.resolve());
        const pressed = await dispatchTargetedPress({
          send: target.send,
          objectId: 'input',
          events: keys(key),
          syntheticFallback,
          lane: lane(),
        });
        expect(target.root.activeElement).toBe(target.input);
        expect(document.activeElement).toBe(target.host);
        expect(pressed).toMatchObject({ inputMode: 'trusted' });
        expect(syntheticFallback).not.toHaveBeenCalled();
      },
    );

    it('falls back when focus went to another control of the same root', async () => {
      const target = shadowTarget(mode);
      const other = document.createElement('button');
      target.root.append(other);
      const send: BrowserCdpSend = (method, params, sessionId) => {
        if (method === 'DOM.focus') {
          other.focus();
          return Promise.resolve({});
        }
        return target.send(method, params, sessionId);
      };
      const syntheticFallback = jest.fn(() => Promise.resolve());
      const pressed = await dispatchTargetedPress({
        send,
        objectId: 'input',
        events: keys('Enter'),
        syntheticFallback,
        lane: lane(),
      });
      expect(pressed).toMatchObject({ inputMode: 'synthetic' });
      expect(syntheticFallback).toHaveBeenCalledTimes(1);
    });

    it('reports the control focused after DOM.focus', async () => {
      const target = shadowTarget(mode);
      expect(
        await dispatchFocus({
          send: target.send,
          objectId: 'input',
          backendNodeId: 1,
          lane: lane(),
        }),
      ).toMatchObject({ focused: true, completed: true });
    });
  },
);
