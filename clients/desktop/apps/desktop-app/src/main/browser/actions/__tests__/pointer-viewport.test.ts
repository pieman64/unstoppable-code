import { validateBrowserAutomationCommand } from '../automation-validation';
import { checkActionability } from '../actionability';

describe('pointer and viewport validation', () => {
  it.each([
    { kind: 'hover', ref: 'r' },
    { kind: 'hover', x: 5, y: 8 },
    { kind: 'hover', x: 300, y: -5 },
    { kind: 'scroll', direction: 'down' },
    { kind: 'scroll', ref: 'r', intoView: true },
    { kind: 'scroll', toText: 'Below', frame: 'f' },
    { kind: 'drag', from: { ref: 'r' }, to: { dx: -10, dy: 0 } },
  ])('accepts %p', (command) =>
    expect(validateBrowserAutomationCommand(command)).toBeUndefined(),
  );
  it.each([
    { kind: 'hover', ref: 'r', x: 5, y: 8 },
    { kind: 'hover', x: NaN, y: 1 },
    { kind: 'hover', ref: 'r', frame: 'f' },
    { kind: 'hover', ref: ' ' },
    { kind: 'scroll', direction: 'down', pages: 1, pixels: 10 },
    { kind: 'scroll', direction: 'up', frame: 'f' },
    { kind: 'scroll', direction: 'up', pixels: 100001 },
    { kind: 'scroll', intoView: false, ref: 'r' },
    { kind: 'scroll', toText: ' ' },
    { kind: 'scroll', toText: 'a', ref: 'r' },
    { kind: 'drag', from: {}, to: { x: 0, y: 0 } },
    { kind: 'drag', from: { ref: 'r' }, to: { x: 0, y: 0, dx: 1, dy: 1 } },
    { kind: 'drag', from: { ref: 'r' }, to: { ref: 'd', extra: true } },
    {
      kind: 'drag',
      from: { ref: 'r' },
      to: { ref: 'd' },
      modifiers: ['Alt', 'Alt'],
    },
  ])('rejects %p', (command) =>
    expect(validateBrowserAutomationCommand(command)).toEqual(
      expect.any(String),
    ),
  );
});

describe('hover actionability', () => {
  afterEach(() => jest.useRealTimers());
  function sample(overrides: Record<string, unknown> = {}): object {
    return {
      result: {
        value: {
          attached: true,
          visible: true,
          enabled: false,
          rect: { x: 0, y: 0, width: 100, height: 100 },
          viewport: { width: 200, height: 200 },
          receivesEvents: true,
          ...overrides,
        },
      },
    };
  }
  it('hovers disabled controls without a fallback', async () => {
    jest.useFakeTimers();
    const send = jest.fn(async (method: string) => {
      await Promise.resolve();
      return method === 'Runtime.callFunctionOn' ? sample() : {};
    });
    const result = checkActionability({
      send,
      action: 'hover',
      objectId: 'o',
      backendNodeId: 1,
    });
    await jest.advanceTimersByTimeAsync(200);
    await expect(result).resolves.toEqual({
      status: 'ready',
      point: { x: 50, y: 50 },
    });
  });
  it('keeps the cover in an obscured failure', async () => {
    jest.useFakeTimers();
    const send = jest.fn(async (method: string) => {
      await Promise.resolve();
      return method === 'Runtime.callFunctionOn'
        ? sample({ receivesEvents: false, cover: 'div.overlay' })
        : {};
    });
    const result = checkActionability({
      send,
      action: 'hover',
      objectId: 'o',
      backendNodeId: 1,
      timeoutMs: 200,
    });
    await jest.advanceTimersByTimeAsync(200);
    await expect(result).resolves.toMatchObject({
      status: 'not_executed',
      code: 'target_obscured',
    });
    const value = await result;
    if (value.status !== 'not_executed')
      throw new Error('Expected obscured failure');
    expect(value.message).toContain('div.overlay');
  });
  it('refuses the never-shown viewport without scrolling', async () => {
    const send = jest.fn(async () => {
      await Promise.resolve();
      return sample({ viewport: { width: 0, height: 0 } });
    });
    await expect(
      checkActionability({
        send,
        action: 'hover',
        objectId: 'o',
        backendNodeId: 1,
        timeoutMs: 0,
      }),
    ).resolves.toMatchObject({
      status: 'not_executed',
      code: 'target_not_visible',
    });
    expect(send).toHaveBeenCalledTimes(1);
  });
  it('keeps exact coordinate hovers and does not scroll', async () => {
    jest.useFakeTimers();
    const send = jest.fn(
      async (method: string, params: Record<string, unknown>) => {
        await Promise.resolve();
        return method === 'Runtime.callFunctionOn'
          ? String(params.functionDeclaration).includes('function(x, y)')
            ? { result: { value: { receivesEvents: true } } }
            : sample()
          : {};
      },
    );
    const result = checkActionability({
      send,
      action: 'hover',
      objectId: 'o',
      backendNodeId: 1,
      exactPoint: { x: 7, y: 9 },
      scrollIntoView: false,
    });
    await jest.advanceTimersByTimeAsync(100);
    await expect(result).resolves.toEqual({
      status: 'ready',
      point: { x: 7, y: 9 },
    });
    expect(
      send.mock.calls.some(([m]) => m === 'DOM.scrollIntoViewIfNeeded'),
    ).toBe(false);
  });
});

describe('a label over its control', () => {
  afterEach(() => jest.useRealTimers());

  // Runs the page-side hit tests on <label for="field"> laid over #field.
  function labelledControl(): {
    send: (method: string, params: Record<string, unknown>) => Promise<unknown>;
  } {
    const label = {
      tagName: 'LABEL',
      className: 'field-label',
      contains: (): boolean => false,
    };
    const scope = { elementFromPoint: (): unknown => label };
    const view = {
      innerWidth: 200,
      innerHeight: 200,
      getComputedStyle: (): unknown => ({
        display: 'block',
        visibility: 'visible',
      }),
    };
    const control = {
      isConnected: true,
      ownerDocument: { defaultView: view },
      labels: [label],
      parentElement: null,
      matches: (): boolean => false,
      closest: (): null => null,
      contains: (): boolean => false,
      getRootNode: (): unknown => scope,
      getBoundingClientRect: (): unknown => ({
        x: 0,
        y: 0,
        left: 0,
        top: 0,
        width: 100,
        height: 100,
      }),
    };
    return {
      send: async (method, params): Promise<unknown> => {
        const { runInNewContext } = await import('node:vm');
        if (
          method !== 'Runtime.callFunctionOn' ||
          typeof params.functionDeclaration !== 'string'
        )
          return {};
        const supplied = Array.isArray(params.arguments)
          ? params.arguments
          : [];
        const value: unknown = runInNewContext(
          `(${params.functionDeclaration}).apply(control, args)`,
          {
            control,
            args: supplied.map(
              (argument: { value?: unknown }) => argument.value,
            ),
          },
        );
        return { result: { value } };
      },
    };
  }

  it('is a click on the control', async () => {
    jest.useFakeTimers();
    const result = checkActionability({
      send: labelledControl().send,
      action: 'click',
      objectId: 'control',
      backendNodeId: 1,
    });
    await jest.advanceTimersByTimeAsync(400);
    await expect(result).resolves.toMatchObject({ status: 'ready' });
  });

  it.each(['hover', 'drag'] as const)(
    'is in the way of a %s: the pointer would be over the label',
    async (action) => {
      jest.useFakeTimers();
      const result = checkActionability({
        send: labelledControl().send,
        action,
        objectId: 'control',
        backendNodeId: 1,
      });
      await jest.advanceTimersByTimeAsync(400);
      await expect(result).resolves.toEqual({
        status: 'not_executed',
        code: 'target_obscured',
        message: 'The target is covered by label.field-label.',
      });
    },
  );
});
