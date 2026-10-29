import { runInNewContext } from 'node:vm';
import { checkActionability } from '../actionability';

function sample(overrides: Record<string, unknown> = {}): object {
  return {
    result: {
      value: {
        attached: true,
        visible: true,
        enabled: true,
        editable: true,
        focusable: true,
        rect: { x: 10, y: 20, width: 40, height: 30 },
        viewport: { width: 200, height: 200 },
        receivesEvents: true,
        ...overrides,
      },
    },
  };
}

describe('checkActionability', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it.each([
    { width: 0, height: 0 },
    { width: 0, height: 200 },
    { width: 200, height: 0 },
  ])('immediately falls back for an empty viewport %p', async (viewport) => {
    jest.useFakeTimers();
    const send = jest.fn(
      (): Promise<object> =>
        Promise.resolve(sample({ viewport, visible: false })),
    );
    const started = Date.now();
    const result = checkActionability({
      send,
      objectId: 'object',
      backendNodeId: 4,
      action: 'click',
    });
    await jest.advanceTimersByTimeAsync(0);
    await expect(result).resolves.toEqual({
      status: 'fallback',
      reason: 'empty_viewport',
      warning:
        'The browser view has not been shown, so it has no size; clicked the element directly.',
    });
    expect(Date.now() - started).toBe(0);
    expect(send).toHaveBeenCalledTimes(1);
    jest.useRealTimers();
  });

  it('refuses a sampled disabled target immediately when the viewport is empty', async () => {
    const send = jest.fn(
      (): Promise<object> =>
        Promise.resolve(
          sample({ viewport: { width: 0, height: 0 }, enabled: false }),
        ),
    );
    await expect(
      checkActionability({
        send,
        objectId: 'object',
        backendNodeId: 4,
        action: 'click',
      }),
    ).resolves.toEqual({ status: 'not_executed', code: 'target_disabled' });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it.each(['press', 'fill'] as const)(
    '%s ignores an empty viewport',
    async (action) => {
      const send = jest.fn(
        (): Promise<object> =>
          Promise.resolve(
            sample({ viewport: { width: 0, height: 0 }, visible: false }),
          ),
      );
      await expect(
        checkActionability({
          send,
          objectId: 'object',
          backendNodeId: 4,
          action,
        }),
      ).resolves.toEqual({ status: 'ready' });
      expect(send).toHaveBeenCalledTimes(1);
    },
  );

  it('still waits five seconds for a laid-out view with no stable point', async () => {
    jest.useFakeTimers();
    const send = jest.fn(
      (): Promise<object> =>
        Promise.resolve(
          sample({
            visible: false,
            rect: { x: 10, y: 20, width: 0, height: 0 },
          }),
        ),
    );
    let settled = false;
    const result = checkActionability({
      send,
      objectId: 'object',
      backendNodeId: 4,
      action: 'click',
    });
    void result.then(() => {
      settled = true;
    });
    await jest.advanceTimersByTimeAsync(4_999);
    expect(settled).toBe(false);
    await jest.advanceTimersByTimeAsync(1);
    await expect(result).resolves.toMatchObject({
      status: 'fallback',
      reason: 'no_point',
    });
    jest.useRealTimers();
  });

  it('never focuses before the dispatch boundary and returns a click point', async () => {
    const send = jest.fn(
      (method: string): Promise<object> =>
        Promise.resolve(method === 'Runtime.callFunctionOn' ? sample() : {}),
    );
    const result = await checkActionability({
      send,
      objectId: 'object',
      backendNodeId: 4,
      action: 'click',
      timeoutMs: 500,
    });
    expect(result).toEqual({ status: 'ready', point: { x: 30, y: 35 } });
    expect(send.mock.calls.every(([method]) => method !== 'DOM.focus')).toBe(
      true,
    );
  });

  it('checks focus attachment and enabled state without scrolling or focusing', async () => {
    jest.useFakeTimers();
    const send = jest.fn(
      (): Promise<object> =>
        Promise.resolve(sample({ visible: false, enabled: true })),
    );
    const pending = checkActionability({
      send,
      objectId: 'object',
      backendNodeId: 4,
      action: 'focus',
    });
    await jest.advanceTimersByTimeAsync(5_000);
    const result = await pending;
    expect(result).toEqual({ status: 'ready' });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls.map(([method]) => method)).not.toContain(
      'DOM.scrollIntoViewIfNeeded',
    );
    expect(send.mock.calls.map(([method]) => method)).not.toContain(
      'DOM.focus',
    );
  });

  it('uses the border top-left plus requested offsets and hit-tests that point', async () => {
    jest.useFakeTimers();
    const send = jest.fn(
      (method: string, params: Record<string, unknown>): Promise<object> => {
        if (method === 'DOM.getBoxModel')
          return Promise.resolve({
            model: { border: [40, 50, 140, 50, 140, 110, 40, 110] },
          });
        if (
          method === 'Runtime.callFunctionOn' &&
          String(params.functionDeclaration).includes('function(x, y)')
        ) {
          expect(params.arguments).toEqual([{ value: 45 }, { value: 57 }]);
          return Promise.resolve({
            result: { value: { receivesEvents: true } },
          });
        }
        if (method !== 'Runtime.callFunctionOn') return Promise.resolve({});
        return Promise.resolve(sample());
      },
    );
    const positionOptions = { position: { x: 5, y: 7 } };
    const pending = checkActionability({
      send,
      objectId: 'object',
      backendNodeId: 4,
      action: 'click',
      ...positionOptions,
    });
    await jest.advanceTimersByTimeAsync(200);
    await expect(pending).resolves.toEqual({
      status: 'ready',
      point: { x: 45, y: 57 },
    });
    expect(send).toHaveBeenCalledWith(
      'DOM.getBoxModel',
      { backendNodeId: 4 },
      undefined,
    );
    expect(
      send.mock.calls.findIndex(
        ([method]) => method === 'DOM.scrollIntoViewIfNeeded',
      ),
    ).toBeLessThan(
      send.mock.calls.findIndex(([method]) => method === 'DOM.getBoxModel'),
    );
    jest.useRealTimers();
  });

  it('rejects an out-of-viewport position without clamping or a direct fallback', async () => {
    jest.useFakeTimers();
    const send = jest.fn((method: string): Promise<object> => {
      if (method === 'DOM.getBoxModel')
        return Promise.resolve({
          model: { border: [190, 150, 210, 150, 210, 170, 190, 170] },
        });
      return Promise.resolve(sample());
    });
    const positionOptions = { position: { x: 20, y: 10 } };
    const pending = checkActionability({
      send,
      objectId: 'object',
      backendNodeId: 4,
      action: 'click',
      ...positionOptions,
    });
    await jest.advanceTimersByTimeAsync(200);
    await expect(pending).resolves.toEqual({
      status: 'not_executed',
      code: 'target_not_visible',
    });
    expect(
      send.mock.calls.some(([, params]) =>
        String(params.functionDeclaration).includes('function(x, y)'),
      ),
    ).toBe(false);
    jest.useRealTimers();
  });

  // Real input on a native picker can open a modal OS menu, so position never
  // overrides the direct click there.
  it('clicks a positioned native picker directly and says position was not applied', async () => {
    const send = jest.fn(
      (): Promise<object> =>
        Promise.resolve({
          result: { value: { attached: true, nativePicker: true } },
        }),
    );
    await expect(
      checkActionability({
        send,
        objectId: 'object',
        backendNodeId: 4,
        action: 'click',
        position: { x: 5, y: 5 },
      }),
    ).resolves.toEqual({
      status: 'fallback',
      reason: 'native_picker',
      warning:
        'Clicked directly because this control opens a native picker; position was not applied.',
    });
    const sampled = send.mock.calls[0]?.[1];
    const target = {
      isConnected: true,
      ownerDocument: { defaultView: {} },
      matches: (query: string): boolean => query.startsWith('select'),
      closest: (): null => null,
    };
    const value: unknown = runInNewContext(
      `(${String(sampled?.functionDeclaration)}).call(target, "click")`,
      { target },
    );
    expect(value).toEqual({ attached: true, nativePicker: true });
  });

  it.each(['empty viewport'] as const)(
    'does not bypass positioned geometry for a %s without a sample rect',
    async () => {
      jest.useFakeTimers();
      const geometry = {
        viewport: { width: 0, height: 0 },
        visible: false,
        rect: { x: 0, y: 0, width: 0, height: 0 },
      };
      const send = jest.fn(
        (): Promise<object> => Promise.resolve(sample(geometry)),
      );
      const positionOptions = { position: { x: 5, y: 5 } };
      const pending = checkActionability({
        send,
        objectId: 'object',
        backendNodeId: 4,
        action: 'click',
        timeoutMs: 0,
        ...positionOptions,
      });
      await jest.advanceTimersByTimeAsync(100);
      await expect(pending).resolves.toEqual({
        status: 'not_executed',
        code: 'target_not_visible',
      });
    },
  );

  it.each(['sample', 'chosen point'])(
    'rejects a parent-only hit in the %s predicate',
    async (predicate) => {
      jest.useFakeTimers();
      const parent = {
        tagName: 'DIV',
        className: 'parent',
        contains: (): boolean => true,
        parentElement: null,
      };
      const target = {
        isConnected: true,
        parentElement: parent,
        labels: [],
        matches: (): boolean => false,
        closest: (): null => null,
        contains: (): boolean => false,
        getBoundingClientRect: (): object => ({
          x: 10,
          y: 20,
          left: 10,
          top: 20,
          width: 40,
          height: 30,
        }),
        ownerDocument: {
          defaultView: {
            innerWidth: 200,
            innerHeight: 200,
            getComputedStyle: (): object => ({
              display: 'block',
              visibility: 'visible',
            }),
          },
          elementFromPoint: (): object => parent,
        },
      };
      const send = jest.fn(
        (method: string, params: Record<string, unknown>): Promise<object> => {
          if (method === 'DOM.getContentQuads' && predicate === 'chosen point')
            return Promise.resolve({
              quads: [[80, 80, 120, 80, 120, 120, 80, 120]],
            });
          if (method !== 'Runtime.callFunctionOn') return Promise.resolve({});
          if (
            String(params.functionDeclaration).includes('const el = this') &&
            predicate === 'chosen point'
          )
            return Promise.resolve(sample());
          const value: unknown = runInNewContext(
            `(${String(params.functionDeclaration)}).call(target, 100, 100)`,
            { target },
          );
          return Promise.resolve({ result: { value } });
        },
      );
      const pending = checkActionability({
        send,
        objectId: 'object',
        backendNodeId: 4,
        action: 'click',
      });
      await jest.advanceTimersByTimeAsync(200);
      await expect(pending).resolves.toMatchObject({
        status: 'fallback',
        reason: 'covered',
        warning: 'Covered by div.parent; clicked the element directly.',
      });
      jest.useRealTimers();
    },
  );

  it.each(['target', 'descendant', 'associated label', 'wrapping label'])(
    'retains the %s hit match',
    async (match) => {
      jest.useFakeTimers();
      const label = {
        tagName: 'LABEL',
        contains: (): boolean => true,
        parentElement: null,
      };
      const descendant = { contains: (): boolean => false };
      const target = {
        isConnected: true,
        parentElement: match === 'wrapping label' ? label : null,
        labels: match === 'associated label' ? [label] : [],
        matches: (): boolean => false,
        closest: (): null => null,
        contains: (hit: unknown): boolean => hit === descendant,
        getBoundingClientRect: (): object => ({
          x: 10,
          y: 20,
          left: 10,
          top: 20,
          width: 40,
          height: 30,
        }),
        ownerDocument: {
          defaultView: {
            innerWidth: 200,
            innerHeight: 200,
            getComputedStyle: (): object => ({
              display: 'block',
              visibility: 'visible',
            }),
          },
          elementFromPoint: (): object =>
            match === 'target'
              ? target
              : match === 'descendant'
                ? descendant
                : label,
        },
      };
      const send = (
        method: string,
        params: Record<string, unknown>,
      ): Promise<object> => {
        if (method !== 'Runtime.callFunctionOn') return Promise.resolve({});
        const value: unknown = runInNewContext(
          `(${String(params.functionDeclaration)}).call(target, "click")`,
          { target },
        );
        return Promise.resolve({ result: { value } });
      };
      const pending = checkActionability({
        send,
        objectId: 'object',
        backendNodeId: 4,
        action: 'click',
      });
      await jest.advanceTimersByTimeAsync(200);
      await expect(pending).resolves.toMatchObject({ status: 'ready' });
      jest.useRealTimers();
    },
  );

  it('hit-tests the clipped visible center rather than the clamped full-rect center', async () => {
    jest.useFakeTimers();
    const send = jest.fn(
      (method: string, params: Record<string, unknown>): Promise<object> => {
        if (
          method === 'Runtime.callFunctionOn' &&
          String(params.functionDeclaration).includes('function(x, y)')
        ) {
          expect(params.arguments).toEqual([{ value: 50 }, { value: 40 }]);
          return Promise.resolve({
            result: { value: { receivesEvents: false, cover: 'div.overlay' } },
          });
        }
        return Promise.resolve(
          sample({
            rect: { x: -100, y: 20, width: 200, height: 40 },
            viewport: { width: 200, height: 200 },
          }),
        );
      },
    );
    const pending = checkActionability({
      send,
      objectId: 'object',
      backendNodeId: 4,
      action: 'click',
    });
    await jest.advanceTimersByTimeAsync(200);
    await expect(pending).resolves.toMatchObject({
      status: 'fallback',
      reason: 'covered',
      warning: 'Covered by div.overlay; clicked the element directly.',
    });
    expect(
      send.mock.calls.some(([, params]) =>
        String(params.functionDeclaration).includes('function(x, y)'),
      ),
    ).toBe(true);
    jest.useRealTimers();
  });

  it('uses the largest visible CDP quad and hit-tests its chosen point', async () => {
    const send = jest.fn(
      (method: string, params: Record<string, unknown>): Promise<object> => {
        if (method === 'DOM.getContentQuads')
          return Promise.resolve({
            quads: [
              [1, 1, 4, 1, 4, 4, 1, 4],
              [50, 50, 90, 50, 90, 90, 50, 90],
            ],
          });
        if (
          method === 'Runtime.callFunctionOn' &&
          String(params.functionDeclaration).includes('function(x, y)')
        )
          return Promise.resolve({
            result: { value: { receivesEvents: true } },
          });
        return Promise.resolve(sample());
      },
    );
    const result = await checkActionability({
      send,
      objectId: 'object',
      backendNodeId: 4,
      action: 'click',
    });
    expect(result).toEqual({ status: 'ready', point: { x: 70, y: 70 } });
    expect(send).toHaveBeenCalledWith(
      'DOM.getContentQuads',
      { backendNodeId: 4 },
      undefined,
    );
  });

  it('falls back through box model when content quads are unavailable', async () => {
    const send = jest.fn(
      (method: string, params: Record<string, unknown>): Promise<object> => {
        if (method === 'DOM.getContentQuads')
          return Promise.reject(new Error('unsupported'));
        if (method === 'DOM.getBoxModel')
          return Promise.resolve({
            model: { content: [60, 60, 100, 60, 100, 100, 60, 100] },
          });
        if (
          method === 'Runtime.callFunctionOn' &&
          String(params.functionDeclaration).includes('function(x, y)')
        )
          return Promise.resolve({
            result: { value: { receivesEvents: true } },
          });
        return Promise.resolve(sample());
      },
    );
    await expect(
      checkActionability({
        send,
        objectId: 'object',
        backendNodeId: 4,
        action: 'click',
      }),
    ).resolves.toEqual({ status: 'ready', point: { x: 80, y: 80 } });
    expect(send).toHaveBeenCalledWith(
      'DOM.getBoxModel',
      { backendNodeId: 4 },
      undefined,
    );
  });

  it('does not require visibility for fill and rejects readonly', async () => {
    const send = jest.fn(
      (): Promise<object> =>
        Promise.resolve(sample({ visible: false, editable: false })),
    );
    await expect(
      checkActionability({
        send,
        objectId: 'object',
        backendNodeId: 4,
        action: 'fill',
      }),
    ).resolves.toEqual({ status: 'not_executed', code: 'not_editable' });
  });

  it('allows a hidden input to fill without scrolling or focusing', async () => {
    const send = jest.fn(
      (): Promise<object> =>
        Promise.resolve(sample({ visible: false, editable: true })),
    );
    await expect(
      checkActionability({
        send,
        objectId: 'object',
        backendNodeId: 4,
        action: 'fill',
      }),
    ).resolves.toEqual({ status: 'ready' });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('refuses a disabled target without any input or focus', async () => {
    const send = jest.fn(
      (): Promise<object> => Promise.resolve(sample({ enabled: false })),
    );
    await expect(
      checkActionability({
        send,
        objectId: 'object',
        backendNodeId: 4,
        action: 'fill',
        timeoutMs: 0,
      }),
    ).resolves.toEqual({ status: 'not_executed', code: 'target_disabled' });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('offers covered click as synthetic fallback with safe cover metadata', async () => {
    const send = jest.fn(
      (): Promise<object> =>
        Promise.resolve(
          sample({ receivesEvents: false, cover: 'div.cookie-banner' }),
        ),
    );
    const result = await checkActionability({
      send,
      objectId: 'object',
      backendNodeId: 4,
      action: 'click',
      timeoutMs: 300,
    });
    expect(result).toEqual({
      status: 'fallback',
      reason: 'covered',
      warning: 'Covered by div.cookie-banner; clicked the element directly.',
    });
  });

  it('refuses covered targets when direct fallback is unavailable', async () => {
    const send = jest.fn(
      (): Promise<object> =>
        Promise.resolve(
          sample({ receivesEvents: false, cover: 'div.overlay' }),
        ),
    );
    await expect(
      checkActionability({
        send,
        objectId: 'object',
        backendNodeId: 4,
        action: 'click',
        canUseDirectFallback: false,
      }),
    ).resolves.toEqual({ status: 'not_executed', code: 'target_obscured' });
  });

  it('checks only attachment and enabled for targeted press even when hidden or inert', async () => {
    const send = jest.fn(
      (): Promise<object> =>
        Promise.resolve(sample({ visible: false, focusable: false })),
    );
    await expect(
      checkActionability({
        send,
        objectId: 'object',
        backendNodeId: 4,
        action: 'press',
      }),
    ).resolves.toEqual({ status: 'ready' });
  });
});

describe('checkActionability for elements in frames', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  function frameSend(
    sessionId: string,
    handlers: Record<string, (params: Record<string, unknown>) => object>,
    hits: Array<{ x: unknown; y: unknown }>,
  ): jest.Mock<Promise<object>, [string, Record<string, unknown>, string?]> {
    return jest.fn(
      (
        method: string,
        params: Record<string, unknown>,
        session?: string,
      ): Promise<object> => {
        if (session !== sessionId)
          return Promise.reject(new Error(`Sent to ${String(session)}`));
        if (
          method === 'Runtime.callFunctionOn' &&
          String(params.functionDeclaration).includes('function(x, y)')
        ) {
          const args: unknown[] = Array.isArray(params.arguments)
            ? params.arguments
            : [];
          const valueOf = (entry: unknown): unknown =>
            typeof entry === 'object' && entry !== null
              ? Reflect.get(entry, 'value')
              : undefined;
          hits.push({ x: valueOf(args[0]), y: valueOf(args[1]) });
          return Promise.resolve({
            result: { value: { receivesEvents: true } },
          });
        }
        const handler = handlers[method];
        if (handler) return Promise.resolve(handler(params));
        if (method === 'Runtime.callFunctionOn')
          return Promise.resolve(sample());
        return Promise.resolve({});
      },
    );
  }

  it('hit-tests in the document and dispatches at the session point of a same-process frame', async () => {
    const hits: Array<{ x: unknown; y: unknown }> = [];
    const send = frameSend(
      'root-session',
      {
        // Session coordinates: the frame content starts at (100, 200).
        'DOM.getContentQuads': () => ({
          quads: [[110, 220, 150, 220, 150, 250, 110, 250]],
        }),
      },
      hits,
    );
    const result = await checkActionability({
      send,
      sessionId: 'root-session',
      objectId: 'object',
      backendNodeId: 4,
      action: 'click',
      frameMapping: () =>
        Promise.resolve({ originX: 100, originY: 200, scaleX: 1, scaleY: 1 }),
    });
    expect(result).toEqual({ status: 'ready', point: { x: 130, y: 235 } });
    // The element's own document sees (30, 35), its rectangle's center.
    expect(hits).toEqual([]);
    expect(
      send.mock.calls.every(([, , session]) => session === 'root-session'),
    ).toBe(true);
  });

  it('maps through a scaled owner, both ways', async () => {
    const hits: Array<{ x: unknown; y: unknown }> = [];
    const send = frameSend(
      'root-session',
      {
        'DOM.getContentQuads': () => ({
          // The visible part: document (60..100, 60..100) at scale 0.5.
          quads: [[130, 230, 150, 230, 150, 250, 130, 250]],
        }),
      },
      hits,
    );
    const result = await checkActionability({
      send,
      sessionId: 'root-session',
      objectId: 'object',
      backendNodeId: 4,
      action: 'click',
      frameMapping: () =>
        Promise.resolve({
          originX: 100,
          originY: 200,
          scaleX: 0.5,
          scaleY: 0.5,
        }),
    });
    expect(result).toEqual({ status: 'ready', point: { x: 140, y: 240 } });
    expect(hits).toEqual([{ x: 80, y: 80 }]);
  });

  it('places a requested position in the element document, then maps it', async () => {
    jest.useFakeTimers();
    const hits: Array<{ x: unknown; y: unknown }> = [];
    const send = frameSend(
      'root-session',
      {
        'DOM.getBoxModel': () => ({
          model: { border: [140, 250, 240, 250, 240, 310, 140, 310] },
        }),
      },
      hits,
    );
    const pending = checkActionability({
      send,
      sessionId: 'root-session',
      objectId: 'object',
      backendNodeId: 4,
      action: 'click',
      position: { x: 5, y: 7 },
      frameMapping: () =>
        Promise.resolve({ originX: 100, originY: 200, scaleX: 1, scaleY: 1 }),
    });
    await jest.advanceTimersByTimeAsync(200);
    await expect(pending).resolves.toEqual({
      status: 'ready',
      point: { x: 145, y: 257 },
    });
    expect(hits).toEqual([{ x: 45, y: 57 }]);
  });

  it('falls back as covered when a document above the frame covers the point (D9)', async () => {
    const hits: Array<{ x: unknown; y: unknown }> = [];
    const send = frameSend('oopif-1', {}, hits);
    const outer = jest.fn(() =>
      Promise.resolve({ receivesEvents: false, cover: 'div.parent-overlay' }),
    );
    await expect(
      checkActionability({
        send,
        sessionId: 'oopif-1',
        objectId: 'object',
        backendNodeId: 4,
        action: 'click',
        outerHitTest: outer,
      }),
    ).resolves.toEqual({
      status: 'fallback',
      reason: 'covered',
      warning: 'Covered by div.parent-overlay; clicked the element directly.',
    });
    expect(outer).toHaveBeenCalledWith({ x: 30, y: 35 });
    await expect(
      checkActionability({
        send,
        sessionId: 'oopif-1',
        objectId: 'object',
        backendNodeId: 4,
        action: 'click',
        canUseDirectFallback: false,
        outerHitTest: outer,
      }),
    ).resolves.toEqual({ status: 'not_executed', code: 'target_obscured' });
  });

  it('refuses a frame whose mapping cannot be read, before any input', async () => {
    const hits: Array<{ x: unknown; y: unknown }> = [];
    const send = frameSend('root-session', {}, hits);
    await expect(
      checkActionability({
        send,
        sessionId: 'root-session',
        objectId: 'object',
        backendNodeId: 4,
        action: 'click',
        frameMapping: () => Promise.resolve(undefined),
      }),
    ).resolves.toEqual({ status: 'not_executed', code: 'frame_unavailable' });
  });
});
