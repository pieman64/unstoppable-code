import { ActionLane } from '../action-lane';
import type { BrowserCdpSend } from '../actionability';
import {
  dispatchClick,
  dispatchFill,
  dispatchFocus,
  dispatchPress,
  dispatchTargetedPress,
} from '../input-dispatch';
import { buildKeyEventSequence, parseKeyCombo } from '../key-definitions';

describe('input dispatch', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  function lane(): ActionLane {
    const runtimeKey = {};
    return new ActionLane({ runtimeKey, generation: 1, isCurrent: () => true });
  }

  it('releases no button and no key whose press was refused before it was sent', async () => {
    // The action's sender refuses input synchronously when the target's
    // document was replaced (review R2 finding 1): nothing was pressed.
    const refused = (method: string, params: Record<string, unknown>): void => {
      if (params.type === 'mousePressed' || params.type === 'keyDown')
        throw new Error(`refused ${method}`);
    };
    const mouse: string[] = [];
    const clicked = await lane().run((context) =>
      dispatchClick({
        send: (method, params) => {
          refused(method, params);
          mouse.push(String(params.type));
          return Promise.resolve({});
        },
        cleanupSend: (_method, params) => {
          mouse.push(`cleanup:${String(params.type)}`);
          return Promise.resolve({});
        },
        lane: context,
        point: { x: 8, y: 9 },
        moveDelayMs: 0,
        pressDelayMs: 0,
      }),
    );
    expect(clicked.status).toBe('outcome_unknown');
    expect(mouse).toEqual(['mouseMoved']);
    const keys: string[] = [];
    const combo = parseKeyCombo('Shift+A', 'linux');
    if (!combo.ok) throw new Error('No combo');
    const pressed = await lane().run((context) =>
      dispatchPress({
        send: (method, params) => {
          if (params.type === 'keyDown' && params.key === 'A')
            throw new Error(`refused ${method}`);
          keys.push(`${String(params.type)}:${String(params.key)}`);
          return Promise.resolve({});
        },
        cleanupSend: (_method, params) => {
          keys.push(`cleanup:${String(params.type)}:${String(params.key)}`);
          return Promise.resolve({});
        },
        lane: context,
        events: buildKeyEventSequence(combo, 'linux'),
      }),
    );
    expect(pressed.status).toBe('outcome_unknown');
    // Shift was pressed and is released; A was never sent and is not.
    expect(keys).toEqual(['rawKeyDown:Shift', 'cleanup:keyUp:Shift']);
  });

  it('begins at first mouse event, attributes it, and releases on success', async () => {
    const events: string[] = [];
    const send = jest.fn((method: string, params: Record<string, unknown>) => {
      events.push(`${method}:${String(params.type)}`);
      return Promise.resolve({});
    });
    const outcome = await lane().run((context) =>
      dispatchClick({
        send,
        lane: context,
        point: { x: 8, y: 9 },
        moveDelayMs: 0,
        pressDelayMs: 0,
        beforeInput: (event) => events.push(`attributed:${event.type}`),
      }),
    );
    expect(outcome.status).toBe('executed');
    expect(events).toEqual([
      'attributed:mouseMoved',
      'Input.dispatchMouseEvent:mouseMoved',
      'attributed:mousePressed',
      'Input.dispatchMouseEvent:mousePressed',
      'attributed:mouseReleased',
      'Input.dispatchMouseEvent:mouseReleased',
    ]);
  });

  it('moves with no button before pressing and releasing the left button', async () => {
    const send = jest.fn<Promise<object>, [string, Record<string, unknown>]>(
      () => Promise.resolve({}),
    );
    await lane().run((context) =>
      dispatchClick({
        send,
        lane: context,
        point: { x: 8, y: 9 },
        moveDelayMs: 0,
        pressDelayMs: 0,
      }),
    );
    expect(send.mock.calls.map(([, params]) => params.button)).toEqual([
      'none',
      'left',
      'left',
    ]);
    expect(send.mock.calls.map(([, params]) => params.buttons)).toEqual([
      0, 1, 0,
    ]);
  });

  it.each([
    ['left', 1],
    ['right', 2],
    ['middle', 4],
  ] as const)(
    'dispatches the %s button with its CDP bitmask',
    async (button, bitmask) => {
      const send = jest.fn<Promise<object>, [string, Record<string, unknown>]>(
        (): Promise<object> => Promise.resolve({}),
      );
      const clickOptions = { button };
      await lane().run((context) =>
        dispatchClick({
          send,
          lane: context,
          point: { x: 8, y: 9 },
          moveDelayMs: 0,
          pressDelayMs: 0,
          ...clickOptions,
        }),
      );
      expect(send.mock.calls.map(([, params]) => params.button)).toEqual([
        'none',
        button,
        button,
      ]);
      expect(send.mock.calls.map(([, params]) => params.buttons)).toEqual([
        0,
        bitmask,
        0,
      ]);
    },
  );

  it('dispatches each click count as a matching press/release pair', async () => {
    const send = jest.fn<Promise<object>, [string, Record<string, unknown>]>(
      (): Promise<object> => Promise.resolve({}),
    );
    const clickOptions = { clickCount: 3 };
    await lane().run((context) =>
      dispatchClick({
        send,
        lane: context,
        point: { x: 8, y: 9 },
        moveDelayMs: 0,
        pressDelayMs: 0,
        ...clickOptions,
      }),
    );
    expect(
      send.mock.calls.map(([, params]) => ({
        type: params.type,
        clickCount: params.clickCount,
      })),
    ).toEqual([
      { type: 'mouseMoved', clickCount: 0 },
      { type: 'mousePressed', clickCount: 1 },
      { type: 'mouseReleased', clickCount: 1 },
      { type: 'mousePressed', clickCount: 2 },
      { type: 'mouseReleased', clickCount: 2 },
      { type: 'mousePressed', clickCount: 3 },
      { type: 'mouseReleased', clickCount: 3 },
    ]);
  });

  it.each([
    ['Alt', 1],
    ['Control', 2],
    ['Meta', 4],
    ['Shift', 8],
  ] as const)(
    'encodes the %s modifier with its CDP bit',
    async (modifier, bitmask) => {
      const send = jest.fn<Promise<object>, [string, Record<string, unknown>]>(
        (): Promise<object> => Promise.resolve({}),
      );
      const clickOptions = { modifiers: [modifier] };
      await lane().run((context) =>
        dispatchClick({
          send,
          lane: context,
          point: { x: 8, y: 9 },
          moveDelayMs: 0,
          pressDelayMs: 0,
          ...clickOptions,
        }),
      );
      expect(send.mock.calls.map(([, params]) => params.modifiers)).toEqual([
        bitmask,
        bitmask,
        bitmask,
      ]);
    },
  );

  it('releases the held non-left button through cleanup', async () => {
    jest.useFakeTimers();
    const controller = new AbortController();
    const send = jest.fn(
      (_method: string, params: Record<string, unknown>): Promise<object> => {
        if (params.type === 'mousePressed')
          setTimeout(() => controller.abort(), 10);
        return Promise.resolve({});
      },
    );
    const cleanupSend = jest.fn((): Promise<object> => Promise.resolve({}));
    const currentLane = lane();
    const pending = currentLane.run(
      (context) =>
        dispatchClick({
          send,
          cleanupSend,
          lane: context,
          point: { x: 8, y: 9 },
          pressDelayMs: 100,
          ...{ button: 'right' },
        }),
      { signal: controller.signal },
    );
    await jest.advanceTimersByTimeAsync(200);
    await pending;
    await jest.advanceTimersByTimeAsync(0);
    expect(cleanupSend).toHaveBeenCalledWith(
      'Input.dispatchMouseEvent',
      expect.objectContaining({
        type: 'mouseReleased',
        button: 'right',
        buttons: 0,
      }),
      undefined,
    );
    jest.useRealTimers();
  });

  it('focuses directly and reports a trusted focus result', async () => {
    const send = jest.fn(
      (method: string): Promise<object> =>
        Promise.resolve(
          method === 'Runtime.callFunctionOn'
            ? { result: { value: true } }
            : {},
        ),
    );
    const outcome = await lane().run((context) =>
      dispatchFocus({
        send,
        lane: context,
        objectId: 'object',
        backendNodeId: 4,
      }),
    );
    expect(outcome).toMatchObject({
      status: 'executed',
      value: {
        focused: true,
        completed: true,
        inputMode: 'trusted',
      },
    });
    expect(send.mock.calls.map(([method]) => method)).toEqual([
      'DOM.focus',
      'Runtime.callFunctionOn',
    ]);
  });

  it('returns a pending dialog when direct focus is blocked', async () => {
    const dialog = {
      id: 'dialog',
      browserId: 'browser-1',
      type: 'alert' as const,
      message: 'Pause',
      url: 'https://example.test/',
      openedAt: 1,
    };
    const send = jest.fn(
      (method: string): Promise<unknown> =>
        method === 'DOM.focus'
          ? Promise.reject(new Error('blocked by dialog'))
          : Promise.resolve({}),
    );
    const outcome = await lane().run((context) =>
      dispatchFocus({
        send,
        lane: context,
        objectId: 'object',
        backendNodeId: 4,
        getPendingDialog: () => dialog,
      }),
    );
    expect(outcome).toMatchObject({
      status: 'executed',
      value: { focused: false, completed: false, inputMode: 'trusted', dialog },
    });
    expect(send.mock.calls.map(([method]) => method)).toEqual(['DOM.focus']);
  });

  it('uses a trusted hit-tested click when direct focus does not move focus', async () => {
    jest.useFakeTimers();
    let focusChecks = 0;
    const send = jest.fn(
      (method: string, params: Record<string, unknown>): Promise<object> => {
        if (
          method === 'Runtime.callFunctionOn' &&
          String(params.functionDeclaration).includes('activeElement')
        ) {
          focusChecks++;
          return Promise.resolve({ result: { value: focusChecks > 1 } });
        }
        if (
          method === 'Runtime.callFunctionOn' &&
          String(params.functionDeclaration).includes('function(x, y)')
        )
          return Promise.resolve({
            result: { value: { receivesEvents: true } },
          });
        if (method === 'DOM.getContentQuads')
          return Promise.resolve({ quads: [[10, 20, 50, 20, 50, 50, 10, 50]] });
        if (method === 'Runtime.callFunctionOn')
          return Promise.resolve({
            result: {
              value: {
                attached: true,
                visible: true,
                enabled: true,
                rect: { x: 10, y: 20, width: 40, height: 30 },
                viewport: { width: 200, height: 200 },
                receivesEvents: true,
              },
            },
          });
        return Promise.resolve({});
      },
    );
    const pending = lane().run((context) =>
      dispatchFocus({
        send,
        lane: context,
        objectId: 'object',
        backendNodeId: 4,
        timeoutMs: 250,
      }),
    );
    await jest.advanceTimersByTimeAsync(300);
    await expect(pending).resolves.toMatchObject({
      status: 'executed',
      value: { focused: true, completed: true, inputMode: 'trusted' },
    });
    expect(send.mock.calls.map(([method]) => method)).toContain(
      'Input.dispatchMouseEvent',
    );
    jest.useRealTimers();
  });

  it("clicks a frame target for focus at its session point, through its document's mapping and the outer hit test", async () => {
    jest.useFakeTimers();
    let focusChecks = 0;
    const send = jest.fn<
      Promise<object>,
      [string, Record<string, unknown>, string?]
    >((method: string, params: Record<string, unknown>): Promise<object> => {
      if (
        method === 'Runtime.callFunctionOn' &&
        String(params.functionDeclaration).includes('activeElement')
      ) {
        focusChecks++;
        return Promise.resolve({ result: { value: focusChecks > 1 } });
      }
      if (
        method === 'Runtime.callFunctionOn' &&
        String(params.functionDeclaration).includes('function(x, y)')
      )
        return Promise.resolve({
          result: { value: { receivesEvents: true } },
        });
      // Session coordinates: the document's (10, 20)-(50, 50) at +100, +50.
      if (method === 'DOM.getContentQuads')
        return Promise.resolve({
          quads: [[110, 70, 150, 70, 150, 100, 110, 100]],
        });
      if (method === 'Runtime.callFunctionOn')
        return Promise.resolve({
          result: {
            value: {
              attached: true,
              visible: true,
              enabled: true,
              rect: { x: 10, y: 20, width: 40, height: 30 },
              viewport: { width: 200, height: 200 },
              receivesEvents: true,
            },
          },
        });
      return Promise.resolve({});
    });
    const outerHitTest = jest.fn(() =>
      Promise.resolve({ receivesEvents: true }),
    );
    const pending = lane().run((context) =>
      dispatchFocus({
        send,
        sessionId: 'child',
        lane: context,
        objectId: 'object',
        backendNodeId: 4,
        timeoutMs: 250,
        frameMapping: () =>
          Promise.resolve({ originX: 100, originY: 50, scaleX: 1, scaleY: 1 }),
        outerHitTest,
      }),
    );
    await jest.advanceTimersByTimeAsync(300);
    await expect(pending).resolves.toMatchObject({
      status: 'executed',
      value: { focused: true, completed: true },
    });
    expect(outerHitTest).toHaveBeenCalledWith({ x: 130, y: 85 });
    const pressed = send.mock.calls.find(
      ([method, params]) =>
        method === 'Input.dispatchMouseEvent' && params.type === 'mousePressed',
    );
    expect(pressed?.[1]).toMatchObject({ x: 130, y: 85 });
    expect(pressed?.[2]).toBe('child');
    jest.useRealTimers();
  });

  it('warns after direct and trusted focus attempts both fail', async () => {
    jest.useFakeTimers();
    const send = jest.fn(
      (method: string, params: Record<string, unknown>): Promise<object> => {
        if (
          method === 'Runtime.callFunctionOn' &&
          String(params.functionDeclaration).includes('activeElement')
        )
          return Promise.resolve({ result: { value: false } });
        if (
          method === 'Runtime.callFunctionOn' &&
          String(params.functionDeclaration).includes('function(x, y)')
        )
          return Promise.resolve({
            result: { value: { receivesEvents: true } },
          });
        if (method === 'DOM.getContentQuads')
          return Promise.resolve({ quads: [[10, 20, 50, 20, 50, 50, 10, 50]] });
        if (method === 'Runtime.callFunctionOn')
          return Promise.resolve({
            result: {
              value: {
                attached: true,
                visible: true,
                enabled: true,
                rect: { x: 10, y: 20, width: 40, height: 30 },
                viewport: { width: 200, height: 200 },
                receivesEvents: true,
              },
            },
          });
        return Promise.resolve({});
      },
    );
    const pending = lane().run((context) =>
      dispatchFocus({
        send,
        lane: context,
        objectId: 'object',
        backendNodeId: 4,
        timeoutMs: 250,
      }),
    );
    await jest.advanceTimersByTimeAsync(300);
    const outcome = await pending;
    if (outcome.status !== 'executed')
      throw new Error('Focus fallback did not complete.');
    expect(outcome.value).toMatchObject({
      focused: false,
      completed: true,
      inputMode: 'trusted',
    });
    if (!outcome.value.completed || outcome.value.focused)
      throw new Error('Expected a completed focus fallback.');
    expect(typeof outcome.value.warning).toBe('string');
    expect(send.mock.calls.map(([method]) => method)).toContain(
      'Input.dispatchMouseEvent',
    );
    jest.useRealTimers();
  });

  it('bounds the focus click-point sample to 250ms even with a longer timeout', async () => {
    jest.useFakeTimers();
    let settled = false;
    const send = jest.fn(
      (method: string, params: Record<string, unknown>): Promise<object> => {
        if (
          method === 'Runtime.callFunctionOn' &&
          String(params.functionDeclaration).includes('activeElement')
        )
          return Promise.resolve({ result: { value: false } });
        if (method === 'Runtime.callFunctionOn')
          return Promise.resolve({
            result: {
              value: {
                attached: true,
                visible: false,
                enabled: true,
                rect: { x: 10, y: 20, width: 0, height: 0 },
                viewport: { width: 200, height: 200 },
              },
            },
          });
        return Promise.resolve({});
      },
    );
    const pending = lane().run((context) =>
      dispatchFocus({
        send,
        lane: context,
        objectId: 'object',
        backendNodeId: 4,
        timeoutMs: 10_000,
      }),
    );
    void pending.then(() => {
      settled = true;
    });
    await jest.advanceTimersByTimeAsync(250);
    const settledWithinBudget = settled;
    if (!settled) await jest.advanceTimersByTimeAsync(10_000);
    const outcome = await pending;
    if (outcome.status !== 'executed')
      throw new Error('Focus fallback did not complete.');
    expect(outcome.value).toMatchObject({
      focused: false,
      completed: true,
      inputMode: 'trusted',
    });
    if (!outcome.value.completed || outcome.value.focused)
      throw new Error('Expected a completed focus fallback.');
    expect(typeof outcome.value.warning).toBe('string');
    expect(settledWithinBudget).toBe(true);
  });

  it.each(['press', 'fill'] as const)(
    'returns a pending dialog from a %s command failure',
    async (kind) => {
      const dialog = {
        id: 'dialog',
        browserId: 'browser-1',
        type: 'alert' as const,
        message: 'Pause',
        url: 'https://example.test/',
        openedAt: 1,
      };
      const failed = (): Promise<unknown> =>
        Promise.reject(new Error('blocked by dialog'));
      const parsed = parseKeyCombo('Enter', 'darwin');
      if (!parsed.ok) throw new Error(parsed.error.message);
      const outcome = await lane().run(async (context) =>
        kind === 'press'
          ? await dispatchPress({
              send: failed,
              lane: context,
              events: buildKeyEventSequence(parsed, 'darwin'),
              getPendingDialog: () => dialog,
            })
          : await dispatchFill({
              lane: context,
              fillPrepared: failed,
              getPendingDialog: () => dialog,
            }),
      );
      expect(outcome).toMatchObject({
        status: 'executed',
        value: { completed: false, dialog },
      });
    },
  );

  it.each(['mousePressed', 'mouseReleased'] as const)(
    'maps a %s command timeout to dispatch_timeout without a dialog',
    async (blockedType) => {
      jest.useFakeTimers();
      let finish = (): void => {};
      const pendingCommand = new Promise<void>((resolve) => {
        finish = resolve;
      });
      const send = (
        _method: string,
        params: Record<string, unknown>,
      ): Promise<unknown> =>
        params.type === blockedType ? pendingCommand : Promise.resolve({});
      const currentLane = lane();
      const result = currentLane.run((context) =>
        dispatchClick({
          send,
          lane: context,
          point: { x: 8, y: 9 },
          moveDelayMs: 0,
          pressDelayMs: 0,
        }),
      );
      await jest.advanceTimersByTimeAsync(
        blockedType === 'mousePressed' ? 3_000 : 5_000,
      );
      expect(await result).toMatchObject({
        status: 'outcome_unknown',
        reason: 'dispatch_timeout',
        detail: 'CDP input command timed out',
      });
      finish();
      await jest.advanceTimersByTimeAsync(0);
      jest.useRealTimers();
    },
  );

  it('retains the pending-dialog result on a mouse command timeout', async () => {
    jest.useFakeTimers();
    let finish = (): void => {};
    const pendingCommand = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const dialog = {
      id: 'dialog',
      browserId: 'browser-1',
      type: 'confirm' as const,
      message: 'Continue?',
      url: 'https://example.test/',
      openedAt: 1,
    };
    const send = (
      _method: string,
      params: Record<string, unknown>,
    ): Promise<unknown> =>
      params.type === 'mousePressed' ? pendingCommand : Promise.resolve({});
    const result = lane().run((context) =>
      dispatchClick({
        send,
        lane: context,
        point: { x: 8, y: 9 },
        moveDelayMs: 0,
        getPendingDialog: () => dialog,
      }),
    );
    await jest.advanceTimersByTimeAsync(3_000);
    expect(await result).toMatchObject({
      status: 'executed',
      value: { completed: false, dialog },
    });
    finish();
    await jest.advanceTimersByTimeAsync(0);
    jest.useRealTimers();
  });

  it('dispatches Enter as a keyDown with its text and no native key code', async () => {
    const combo = parseKeyCombo('Enter', 'darwin');
    if (!combo.ok) throw new Error(combo.error.message);
    const send = jest.fn<Promise<unknown>, Parameters<BrowserCdpSend>>(
      (): Promise<object> => Promise.resolve({}),
    );
    const outcome = await lane().run((context) =>
      dispatchPress({
        send,
        lane: context,
        events: buildKeyEventSequence(combo, 'darwin'),
      }),
    );
    expect(outcome.status).toBe('executed');
    const sent = send.mock.calls.map((call) => call[1]);
    expect(sent).toEqual([
      expect.objectContaining({ type: 'keyDown', key: 'Enter', text: '\r' }),
      expect.objectContaining({ type: 'keyUp', key: 'Enter' }),
    ]);
    for (const params of sent)
      expect(params).not.toHaveProperty('nativeVirtualKeyCode');
  });

  it('treats DOM.focus as dispatch and falls back if focus does not move', async () => {
    const combo = parseKeyCombo('Enter', 'darwin');
    if (!combo.ok) throw new Error(combo.error.message);
    const send = jest.fn(
      (method: string): Promise<object> =>
        Promise.resolve(
          method === 'Runtime.callFunctionOn'
            ? { result: { value: false } }
            : {},
        ),
    );
    const outcome = await lane().run((context) =>
      dispatchTargetedPress({
        send,
        objectId: 'object',
        lane: context,
        events: buildKeyEventSequence(combo, 'darwin'),
      }),
    );
    expect(outcome).toMatchObject({
      status: 'executed',
      value: { inputMode: 'synthetic' },
    });
    expect(send.mock.calls.map(([method]) => method)).toEqual([
      'DOM.focus',
      'Runtime.callFunctionOn',
      'Runtime.callFunctionOn',
    ]);
  });

  it('uses the retained synthetic callback instead of raw CDP fallback when supplied', async () => {
    const combo = parseKeyCombo('Enter', 'darwin');
    if (!combo.ok) throw new Error(combo.error.message);
    const send = jest.fn(
      (method: string): Promise<object> =>
        Promise.resolve(
          method === 'Runtime.callFunctionOn'
            ? { result: { value: false } }
            : {},
        ),
    );
    const syntheticFallback = jest.fn((): Promise<void> => {
      return Promise.resolve();
    });
    const outcome = await lane().run((context) =>
      dispatchTargetedPress({
        send,
        objectId: 'object',
        lane: context,
        events: buildKeyEventSequence(combo, 'darwin'),
        syntheticFallback,
      }),
    );
    expect(outcome).toMatchObject({
      status: 'executed',
      value: { inputMode: 'synthetic' },
    });
    expect(syntheticFallback).toHaveBeenCalledTimes(1);
    expect(send.mock.calls.map(([method]) => method)).toEqual([
      'DOM.focus',
      'Runtime.callFunctionOn',
    ]);
  });

  it('sends no fallback keydown when the press is cancelled during focus', async () => {
    const combo = parseKeyCombo('Enter', 'darwin');
    if (!combo.ok) throw new Error(combo.error.message);
    const controller = new AbortController();
    const send = jest.fn((method: string): Promise<object> => {
      if (method !== 'DOM.focus') return Promise.resolve({});
      controller.abort();
      return Promise.reject(new Error('focus interrupted'));
    });
    const syntheticFallback = jest.fn((): Promise<void> => Promise.resolve());
    const outcome = await lane().run(
      (context) =>
        dispatchTargetedPress({
          send,
          objectId: 'object',
          lane: context,
          events: buildKeyEventSequence(combo, 'darwin'),
          syntheticFallback,
        }),
      { signal: controller.signal },
    );
    expect(outcome.status).not.toBe('executed');
    expect(syntheticFallback).not.toHaveBeenCalled();
    expect(send.mock.calls.map(([method]) => method)).toEqual(['DOM.focus']);
  });

  it('marks fill-prepared as the first dispatch command', async () => {
    const fillPrepared = jest.fn(
      (): Promise<object> => Promise.resolve({ completed: true }),
    );
    const outcome = await lane().run((context) =>
      dispatchFill({
        lane: context,
        fillPrepared,
      }),
    );
    expect(outcome).toMatchObject({
      status: 'executed',
      value: { completed: true },
    });
    expect(fillPrepared).toHaveBeenCalledTimes(1);
  });

  it('uses the unfenced cleanup sender after an ordinary keyUp rejects', async () => {
    const combo = parseKeyCombo('Enter', 'darwin');
    if (!combo.ok) throw new Error(combo.error.message);
    const send = jest.fn(
      (_method: string, params: Record<string, unknown>): Promise<object> => {
        if (params.type === 'keyUp')
          return Promise.reject(new Error('normal sender fenced'));
        return Promise.resolve({});
      },
    );
    const cleanupSend = jest.fn((): Promise<object> => Promise.resolve({}));
    const outcome = await lane().run((context) =>
      dispatchPress({
        send,
        cleanupSend,
        lane: context,
        events: buildKeyEventSequence(combo, 'darwin'),
      }),
    );
    expect(outcome.status).toBe('outcome_unknown');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(cleanupSend).toHaveBeenCalledWith(
      'Input.dispatchKeyEvent',
      expect.objectContaining({ type: 'keyUp', key: 'Enter' }),
      undefined,
    );
  });

  it('releases a held shifted key without its text or unmodified text', async () => {
    const combo = parseKeyCombo('Shift+a', 'linux');
    if (!combo.ok) throw new Error(combo.error.message);
    const send = jest.fn(
      (_method: string, params: Record<string, unknown>): Promise<object> =>
        params.type === 'keyUp'
          ? Promise.reject(new Error('normal sender fenced'))
          : Promise.resolve({}),
    );
    const released: Array<Record<string, unknown>> = [];
    const cleanupSend = jest.fn(
      (_method: string, params: Record<string, unknown>): Promise<object> => {
        released.push(params);
        return Promise.resolve({});
      },
    );
    await lane().run((context) =>
      dispatchPress({
        send,
        cleanupSend,
        lane: context,
        events: buildKeyEventSequence(combo, 'linux'),
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(released.map((params) => params.key)).toEqual(['A', 'Shift']);
    for (const params of released) {
      expect(params).toMatchObject({ type: 'keyUp' });
      expect(params).not.toHaveProperty('text');
      expect(params).not.toHaveProperty('unmodifiedText');
    }
  });
});
