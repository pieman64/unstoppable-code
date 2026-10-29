import { JSDOM } from 'jsdom';
import type { BrowserCdpSend } from '../actionability';
import type { ActionLaneContext } from '../action-lane';
import type { ResolvedActionTarget } from '../../frames/action-targets';
import type { FormActionOptions } from '../form-action';
import { runSetChecked } from '../set-checked';

interface Harness {
  dom: JSDOM;
  target: Element;
  options: FormActionOptions;
  send: jest.MockedFunction<BrowserCdpSend>;
  click: jest.MockedFunction<FormActionOptions['click']>;
  focus: jest.MockedFunction<FormActionOptions['focus']>;
  lane: ActionLaneContext;
  dispatched: number;
  clicked: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function isElement(value: unknown): value is Element {
  return (
    typeof value === 'object' &&
    value !== null &&
    'nodeType' in value &&
    value.nodeType === 1 &&
    'tagName' in value &&
    'dispatchEvent' in value
  );
}

function pageArguments(value: unknown): unknown[] {
  if (!Array.isArray(value)) return [];
  return value.map((item: unknown) =>
    isRecord(item) && 'value' in item ? item.value : undefined,
  );
}

function harness(markup: string, secret = false): Harness {
  const dom = new JSDOM(markup, {
    url: 'https://example.test/',
    runScripts: 'outside-only',
  });
  const target = dom.window.document.querySelector('[data-target]');
  if (!target) throw new Error('Test markup needs a [data-target] element.');

  const objects = new Map<string, Element>([['target', target]]);
  const backendNodeIds = new Map<string, number>([['target', 11]]);
  let nextObject = 0;
  let nextBackend = 12;
  let dispatched = 0;
  const clicked: string[] = [];
  const lane: ActionLaneContext = {
    signal: new AbortController().signal,
    sequence: 1,
    beginDispatch: (): void => {
      dispatched += 1;
    },
    // The real lane refuses to track a command before input is sent.
    trackCommand: <T>(command: Promise<T>): Promise<T> => {
      if (dispatched === 0)
        throw new Error('Commands cannot be tracked before dispatch.');
      return command;
    },
    registerCleanup: (): void => undefined,
  };
  const send = jest.fn<ReturnType<BrowserCdpSend>, Parameters<BrowserCdpSend>>(
    (method: string, params: Record<string, unknown>): Promise<unknown> => {
      if (method === 'Runtime.callFunctionOn') {
        const objectId = readString(params.objectId);
        const declaration = readString(params.functionDeclaration);
        const object = objectId ? objects.get(objectId) : undefined;
        if (!object || !declaration)
          return Promise.resolve({ exceptionDetails: {} });
        Object.defineProperty(dom.window, '__canopyFormTarget', {
          configurable: true,
          value: object,
        });
        Object.defineProperty(dom.window, '__canopyFormArgs', {
          configurable: true,
          value: pageArguments(params.arguments),
        });
        const value: unknown = dom.window.eval(
          `(${declaration}).apply(window.__canopyFormTarget, window.__canopyFormArgs)`,
        );
        if (params.returnByValue === true)
          return Promise.resolve({ result: { value } });
        if (isElement(value)) {
          const childObjectId = `element-${++nextObject}`;
          objects.set(childObjectId, value);
          backendNodeIds.set(childObjectId, nextBackend++);
          return Promise.resolve({ result: { objectId: childObjectId } });
        }
        return Promise.resolve({ result: { value } });
      }
      if (method === 'DOM.describeNode') {
        const objectId = readString(params.objectId);
        const backendNodeId = objectId
          ? backendNodeIds.get(objectId)
          : undefined;
        return Promise.resolve(
          backendNodeId === undefined ? {} : { node: { backendNodeId } },
        );
      }
      if (method === 'Runtime.releaseObject') return Promise.resolve({});
      return Promise.resolve({});
    },
  );
  const click = jest.fn<
    ReturnType<FormActionOptions['click']>,
    Parameters<FormActionOptions['click']>
  >((clickedTarget): Promise<{ completed: true; inputMode: 'trusted' }> => {
    lane.beginDispatch();
    const object = objects.get(clickedTarget.objectId);
    clicked.push(object?.tagName.toLowerCase() ?? 'missing');
    object?.dispatchEvent(
      new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }),
    );
    return Promise.resolve({ completed: true, inputMode: 'trusted' });
  });
  const focus = jest.fn<
    ReturnType<FormActionOptions['focus']>,
    Parameters<FormActionOptions['focus']>
  >(
    (): Promise<{
      focused: true;
      inputMode: 'trusted';
      completed: true;
    }> => {
      lane.beginDispatch();
      target.dispatchEvent(new dom.window.FocusEvent('focus'));
      return Promise.resolve({
        focused: true,
        inputMode: 'trusted',
        completed: true,
      });
    },
  );
  const resolvedTarget: ResolvedActionTarget = {
    identity: {
      frameId: 'frame-1',
      sessionId: 'session-1',
      loaderId: 'loader-1',
      backendNodeId: 11,
    },
    frameRef: 'frame-1',
    objectId: 'target',
    objectGroup: 'test-form-action',
    outOfProcess: false,
  };
  const options: FormActionOptions = {
    send,
    cleanupSend: send,
    lane,
    target: resolvedTarget,
    secret,
    click,
    focus,
  };
  return {
    dom,
    target,
    options,
    send,
    click,
    focus,
    lane,
    get dispatched(): number {
      return dispatched;
    },
    clicked,
  };
}

describe('runSetChecked', () => {
  it('returns without input when a native checkbox already matches', async () => {
    const h = harness('<input data-target type="checkbox" checked>');

    const result = await runSetChecked({ ...h.options, checked: true });

    expect(result).toMatchObject({ target: { checked: true } });
    expect(result.inputMode).toBeUndefined();
    expect(h.click).not.toHaveBeenCalled();
    expect(h.dispatched).toBe(0);
  });

  it.each([
    ['native disabled', '<input data-target type="checkbox" checked disabled>'],
    [
      'ARIA-disabled ancestor',
      '<div aria-disabled="true"><button data-target role="checkbox" aria-checked="true">Toggle</button></div>',
    ],
  ])(
    'refuses a no-op request for a %s checked control',
    async (_name, markup) => {
      const h = harness(markup);

      await expect(
        runSetChecked({ ...h.options, checked: true }),
      ).rejects.toMatchObject({
        error: {
          code: 'target_disabled',
          message: 'This checked control is disabled.',
          retryable: true,
        },
      });
      expect(h.click).not.toHaveBeenCalled();
      expect(h.dispatched).toBe(0);
    },
  );

  it('uses a real click and reads the final native checkbox state', async () => {
    const h = harness('<input data-target type="checkbox">');

    const result = await runSetChecked({ ...h.options, checked: true });

    expect(h.click).toHaveBeenCalledTimes(1);
    expect(h.clicked).toEqual(['input']);
    expect(result).toMatchObject({
      inputMode: 'trusted',
      target: { checked: true },
    });
  });

  it('clicks the associated label for a clipped native checkbox', async () => {
    const h = harness(
      '<input id="terms" data-target type="checkbox" style="position:absolute;width:0;height:0;clip:rect(0 0 0 0)"><label for="terms">Accept terms</label>',
    );

    const result = await runSetChecked({ ...h.options, checked: true });

    expect(h.clicked).toEqual(['label']);
    expect(result).toMatchObject({ target: { checked: true } });
  });

  it('uses an associated label when an overflow ancestor clips the control', async () => {
    const h = harness(
      '<div style="overflow:hidden;width:20px;height:20px"><input id="terms" data-target type="checkbox"></div><label for="terms">Accept terms</label>',
    );
    const inputRect = h.target.getBoundingClientRect();
    const originalGetComputedStyle = h.dom.window.getComputedStyle.bind(
      h.dom.window,
    );
    Object.defineProperty(h.dom.window, 'getComputedStyle', {
      configurable: true,
      value: (element: Element) => {
        const style = originalGetComputedStyle(element);
        if (element === h.target) {
          Object.defineProperties(style, {
            clipPath: { value: 'none' },
            clip: { value: 'auto' },
          });
        }
        return style;
      },
    });
    Object.defineProperties(inputRect, {
      x: { value: 30 },
      y: { value: 30 },
      left: { value: 30 },
      top: { value: 30 },
      right: { value: 40 },
      bottom: { value: 40 },
      width: { value: 10 },
      height: { value: 10 },
    });
    Object.defineProperty(h.target, 'getBoundingClientRect', {
      configurable: true,
      value: () => inputRect,
    });
    const parent = h.target.parentElement;
    if (!parent) throw new Error('Expected an overflow clipping ancestor.');
    const ancestorRect = parent.getBoundingClientRect();
    Object.defineProperties(ancestorRect, {
      x: { value: 0 },
      y: { value: 0 },
      left: { value: 0 },
      top: { value: 0 },
      right: { value: 20 },
      bottom: { value: 20 },
      width: { value: 20 },
      height: { value: 20 },
    });
    Object.defineProperty(parent, 'getBoundingClientRect', {
      configurable: true,
      value: () => ancestorRect,
    });

    const result = await runSetChecked({ ...h.options, checked: true });

    expect(h.clicked).toEqual(['label']);
    expect(result).toMatchObject({ target: { checked: true } });
  });

  it.each(['checkbox', 'switch', 'radio', 'menuitemcheckbox'])(
    'supports the ARIA %s role and verifies aria-checked',
    async (role) => {
      const h = harness(
        `<button data-target role="${role}" aria-checked="false">Toggle</button>`,
      );
      h.target.addEventListener('click', () => {
        h.target.setAttribute('aria-checked', 'true');
      });

      const result = await runSetChecked({ ...h.options, checked: true });

      expect(h.click).toHaveBeenCalledTimes(1);
      expect(result).toMatchObject({
        inputMode: 'trusted',
        target: { checked: true },
      });
    },
  );

  it('treats an ARIA mixed state as not checked', async () => {
    const h = harness(
      '<button data-target role="checkbox" aria-checked="mixed">Toggle</button>',
    );

    const result = await runSetChecked({ ...h.options, checked: false });

    expect(result.inputMode).toBeUndefined();
    expect(h.click).not.toHaveBeenCalled();
    expect(h.dispatched).toBe(0);
  });

  it('refuses to uncheck a checked radio before dispatch', async () => {
    const h = harness('<input data-target type="radio" checked>');

    await expect(
      runSetChecked({ ...h.options, checked: false }),
    ).rejects.toMatchObject({
      error: {
        code: 'unsupported_control',
        message:
          'A radio button cannot be unchecked. Check another option in its group.',
      },
    });
    expect(h.click).not.toHaveBeenCalled();
    expect(h.dispatched).toBe(0);
  });

  it('refuses to uncheck an ARIA radio before dispatch', async () => {
    const h = harness(
      '<div data-target role="radio" aria-checked="true">Selected</div>',
    );

    await expect(
      runSetChecked({ ...h.options, checked: false }),
    ).rejects.toMatchObject({
      error: {
        code: 'unsupported_control',
        message:
          'A radio button cannot be unchecked. Check another option in its group.',
      },
    });
    expect(h.click).not.toHaveBeenCalled();
    expect(h.dispatched).toBe(0);
  });

  it('refuses controls outside the native and ARIA checked roles before dispatch', async () => {
    const h = harness('<button data-target>Not a checked control</button>');

    await expect(
      runSetChecked({ ...h.options, checked: true }),
    ).rejects.toMatchObject({
      error: { code: 'unsupported_control' },
    });
    expect(h.click).not.toHaveBeenCalled();
    expect(h.dispatched).toBe(0);
  });

  it('falls back once to a synthetic click and reports an unchanged ARIA state', async () => {
    const h = harness(
      '<button data-target role="checkbox" aria-checked="false">Toggle</button>',
    );
    h.click.mockImplementationOnce(
      (): Promise<{
        completed: true;
        inputMode: 'trusted';
      }> => {
        h.lane.beginDispatch();
        return Promise.resolve({ completed: true, inputMode: 'trusted' });
      },
    );

    const result = await runSetChecked({ ...h.options, checked: true });

    expect(h.click).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      inputMode: 'synthetic',
      readback: { code: 'state_unchanged' },
      target: { checked: false },
      warnings: [expect.any(String)],
    });
    const calls = h.send.mock.calls.filter(
      ([method]) => method === 'Runtime.callFunctionOn',
    );
    const mutation = calls.find(([, params]) =>
      readString(params.functionDeclaration)?.includes('this.click()'),
    );
    expect(mutation?.[1].userGesture).toBe(true);
    expect(
      calls
        .filter(
          ([, params]) =>
            !readString(params.functionDeclaration)?.includes('this.click()'),
        )
        .every(([, params]) => params.userGesture === undefined),
    ).toBe(true);
  });
});
