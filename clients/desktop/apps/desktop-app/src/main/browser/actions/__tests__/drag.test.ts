import { dispatchDrag } from '../drag';
import { ActionLane } from '../action-lane';

describe('drag dispatch', () => {
  afterEach(() => jest.useRealTimers());
  it('interpolates held moves and dispatches intercepted HTML5 data before release and disable', async () => {
    jest.useFakeTimers();
    const calls: Array<{ method: string; params: Record<string, unknown> }> =
      [];
    let listener: ((data: unknown) => void) | undefined;
    const send = jest.fn(
      async (
        method: string,
        params: Record<string, unknown>,
      ): Promise<unknown> => {
        await Promise.resolve();

        calls.push({ method, params });
        if (
          method === 'Input.dispatchMouseEvent' &&
          params.type === 'mouseMoved' &&
          params.buttons === 1
        )
          listener?.({ items: [], dragOperationsMask: 1 });
        return {};
      },
    );
    const lane = new ActionLane({
      runtimeKey: {},
      generation: 1,
      isCurrent: (): boolean => true,
    });
    const run = lane.run(async (context) => {
      await Promise.resolve();
      return dispatchDrag({
        send,
        cleanupSend: send,
        lane: context,
        from: { x: 10, y: 20 },
        to: { x: 30, y: 40 },
        steps: 2,
        modifiers: ['Shift'],
        subscribe: (cb) => {
          listener = cb;
          return (): void => {
            listener = undefined;
          };
        },
      });
    });
    await jest.advanceTimersByTimeAsync(500);
    await expect(run).resolves.toMatchObject({ status: 'executed' });
    expect(calls.map((c) => c.params.type ?? c.method)).toEqual([
      'Input.setInterceptDrags',
      'mouseMoved',
      'mousePressed',
      'mouseMoved',
      'mouseMoved',
      'dragEnter',
      'dragOver',
      'drop',
      'mouseReleased',
      'Input.setInterceptDrags',
    ]);
    // Blink starts a drag only from a move that names the held button.
    expect(calls[1].params).toMatchObject({ button: 'none', buttons: 0 });
    expect(calls[3].params).toMatchObject({
      x: 20,
      y: 30,
      button: 'left',
      buttons: 1,
      modifiers: 8,
    });
    expect(calls[6].params).toMatchObject({
      modifiers: 8,
      data: { items: [], dragOperationsMask: 1 },
    });
    // The keys are still held at the release: mouseup and pointerup see them.
    expect(calls[8].params).toMatchObject({
      type: 'mouseReleased',
      button: 'left',
      buttons: 0,
      modifiers: 8,
    });
    expect(listener).toBeUndefined();
  });
  it('cancels intercepted data, releases buttons/modifiers, disables and unsubscribes on abort', async () => {
    const calls: string[] = [];
    const abort = new AbortController();
    let listener: ((data: unknown) => void) | undefined;
    const send = async (
      method: string,
      params: Record<string, unknown>,
    ): Promise<unknown> => {
      await Promise.resolve();

      calls.push(typeof params.type === 'string' ? params.type : method);
      if (params.type === 'mousePressed') {
        listener?.({ items: [], dragOperationsMask: 1 });
        abort.abort();
      }
      return {};
    };
    const lane = new ActionLane({
      runtimeKey: {},
      generation: 1,
      isCurrent: (): boolean => true,
    });
    const run = await lane.run(
      async (context) => {
        await Promise.resolve();
        return dispatchDrag({
          send,
          cleanupSend: send,
          lane: context,
          from: { x: 0, y: 0 },
          to: { x: 10, y: 10 },
          subscribe: (cb) => {
            listener = cb;
            return (): void => {
              listener = undefined;
            };
          },
        });
      },
      { signal: abort.signal },
    );
    expect(run.status).toBe('outcome_unknown');
    await lane.run(() => undefined);
    expect(calls.slice(-3)).toEqual([
      'dragCancel',
      'mouseReleased',
      'Input.setInterceptDrags',
    ]);
    expect(listener).toBeUndefined();
  });
});

it('waits for a late enable before disabling interception on cancellation', async () => {
  let finish: (() => void) | undefined;
  const enable = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const calls: string[] = [];
  const abort = new AbortController();
  const send = async (
    method: string,
    params: Record<string, unknown>,
  ): Promise<unknown> => {
    calls.push(method + ':' + String(params.enabled));
    if (method === 'Input.setInterceptDrags' && params.enabled === true) {
      abort.abort();
      await enable;
    }
    return {};
  };
  const lane = new ActionLane({
    runtimeKey: {},
    generation: 1,
    isCurrent: (): boolean => true,
  });
  const run = await lane.run(
    (context) =>
      dispatchDrag({
        send,
        cleanupSend: send,
        lane: context,
        from: { x: 0, y: 0 },
        to: { x: 10, y: 10 },
        subscribe: (): (() => void) => (): void => {},
      }),
    { signal: abort.signal },
  );
  expect(run.status).toBe('outcome_unknown');
  expect(calls).toEqual(['Input.setInterceptDrags:true']);
  finish?.();
  await lane.run(() => undefined);
  expect(calls).toEqual([
    'Input.setInterceptDrags:true',
    'Input.setInterceptDrags:false',
  ]);
});

it.each(['dragEnter', 'dragOver', 'drop'])(
  'cancels and cleans up when %s is interrupted',
  async (interrupted) => {
    const abort = new AbortController();
    let listener: ((data: unknown) => void) | undefined;
    const calls: string[] = [];
    const send = async (
      _method: string,
      params: Record<string, unknown>,
    ): Promise<unknown> => {
      await Promise.resolve();

      calls.push(String(params.type ?? params.enabled));
      if (params.type === 'mousePressed')
        listener?.({
          items: [{ mimeType: 'text/plain', data: 'card' }],
          dragOperationsMask: 1,
        });
      if (params.type === interrupted) {
        abort.abort();
        throw new Error('Interrupted');
      }
      return {};
    };
    const lane = new ActionLane({
      runtimeKey: {},
      generation: 1,
      isCurrent: (): boolean => true,
    });
    const result = await lane.run(
      (context) =>
        dispatchDrag({
          send,
          cleanupSend: send,
          lane: context,
          from: { x: 0, y: 0 },
          to: { x: 10, y: 10 },
          steps: 1,
          subscribe: (cb) => {
            listener = cb;
            return (): void => {
              listener = undefined;
            };
          },
        }),
      { signal: abort.signal },
    );
    expect(result.status).toBe('outcome_unknown');
    await lane.run(() => undefined);
    expect(calls.slice(-3)).toEqual(['dragCancel', 'mouseReleased', 'false']);
    expect(listener).toBeUndefined();
  },
);

it('cancels a refused file-backed drag without forwarding its files', async () => {
  let listener: ((data: unknown) => void) | undefined;
  const calls: Array<{ type: string; data?: unknown }> = [];
  const send = async (
    method: string,
    params: Record<string, unknown>,
  ): Promise<unknown> => {
    await Promise.resolve();
    calls.push({
      type:
        typeof params.type === 'string'
          ? params.type
          : `${method}:${String(params.enabled)}`,
      ...(params.data === undefined ? {} : { data: params.data }),
    });
    if (params.type === 'mousePressed')
      listener?.({
        items: [],
        files: ['/Users/someone/secret.txt'],
        dragOperationsMask: 1,
      });
    return {};
  };
  const lane = new ActionLane({
    runtimeKey: {},
    generation: 1,
    isCurrent: (): boolean => true,
  });
  const result = await lane.run((context) =>
    dispatchDrag({
      send,
      cleanupSend: send,
      lane: context,
      from: { x: 0, y: 0 },
      to: { x: 10, y: 10 },
      steps: 1,
      subscribe: (cb) => {
        listener = cb;
        return (): void => {
          listener = undefined;
        };
      },
    }),
  );
  expect(result.status).toBe('outcome_unknown');
  await lane.run(() => undefined);
  expect(calls.slice(-3).map((call) => call.type)).toEqual([
    'dragCancel',
    'mouseReleased',
    'Input.setInterceptDrags:false',
  ]);
  expect(calls.find((call) => call.type === 'dragCancel')?.data).toEqual({
    items: [],
    dragOperationsMask: 1,
  });
  expect(JSON.stringify(calls)).not.toContain('secret.txt');
  expect(listener).toBeUndefined();
});

it.each([
  ['the release', 'mouseReleased', ['mouseReleased', 'dragCancel', 'false']],
  [
    'turning interception off',
    'false',
    ['mouseReleased', 'false', 'dragCancel'],
  ],
])(
  'cancels a drag whose interception arrives during cleanup, while %s is pending',
  async (_step, pending, tail) => {
    // Chromium reports an intercepted drag some time after the move that
    // started it, so it can land after the action was cancelled.
    const abort = new AbortController();
    let listener: ((data: unknown) => void) | undefined;
    const calls: string[] = [];
    const send = async (
      _method: string,
      params: Record<string, unknown>,
    ): Promise<unknown> => {
      await Promise.resolve();
      const label = String(params.type ?? params.enabled);
      calls.push(label);
      if (params.type === 'mouseMoved' && params.buttons === 1) abort.abort();
      if (label === pending)
        listener?.({
          items: [{ mimeType: 'text/plain', data: 'card' }],
          dragOperationsMask: 1,
        });
      return {};
    };
    const lane = new ActionLane({
      runtimeKey: {},
      generation: 1,
      isCurrent: (): boolean => true,
    });
    const result = await lane.run(
      (context) =>
        dispatchDrag({
          send,
          cleanupSend: send,
          lane: context,
          from: { x: 0, y: 0 },
          to: { x: 10, y: 10 },
          steps: 3,
          subscribe: (cb) => {
            listener = cb;
            return (): void => {
              listener = undefined;
            };
          },
        }),
      { signal: abort.signal },
    );
    expect(result.status).toBe('outcome_unknown');
    await lane.run(() => undefined);
    expect(calls.slice(-3)).toEqual(tail);
    expect(calls.filter((call) => call === 'dragCancel')).toHaveLength(1);
    expect(listener).toBeUndefined();
  },
);

it('reports a drag the page started too late to deliver, and cancels it', async () => {
  jest.useFakeTimers();
  let listener: ((data: unknown) => void) | undefined;
  const calls: string[] = [];
  const send = async (
    _method: string,
    params: Record<string, unknown>,
  ): Promise<unknown> => {
    await Promise.resolve();
    calls.push(String(params.type ?? params.enabled));
    // The interception lands after the 300 ms wait, during the release.
    if (params.type === 'mouseReleased')
      listener?.({
        items: [{ mimeType: 'text/plain', data: 'card' }],
        dragOperationsMask: 1,
      });
    return {};
  };
  const lane = new ActionLane({
    runtimeKey: {},
    generation: 1,
    isCurrent: (): boolean => true,
  });
  const run = lane.run((context) =>
    dispatchDrag({
      send,
      cleanupSend: send,
      lane: context,
      from: { x: 0, y: 0 },
      to: { x: 10, y: 10 },
      steps: 1,
      subscribe: (cb) => {
        listener = cb;
        return (): void => {
          listener = undefined;
        };
      },
    }),
  );
  await jest.advanceTimersByTimeAsync(500);
  await expect(run).resolves.toMatchObject({
    status: 'executed',
    value: { undelivered: true },
  });
  jest.useRealTimers();
  expect(calls).not.toContain('drop');
  expect(calls.slice(-3)).toEqual(['mouseReleased', 'dragCancel', 'false']);
  expect(listener).toBeUndefined();
});

it.each([
  ['the press', 1, { x: 10, y: 20 }, 1],
  ['a held move', 3, { x: 310, y: 320 }, 2],
])(
  'releases a drag cancelled during %s where the pointer was last sent',
  async (_step, steps, releasedAt, moves) => {
    const abort = new AbortController();
    const calls: Array<{ type: string; x: unknown; y: unknown }> = [];
    const send = async (
      _method: string,
      params: Record<string, unknown>,
    ): Promise<unknown> => {
      await Promise.resolve();
      calls.push({
        type: String(params.type ?? params.enabled),
        x: params.x,
        y: params.y,
      });
      // The command that is pending when the action is cancelled still
      // reaches the page; the next move on the path is never sent.
      if (
        steps === 1
          ? params.type === 'mousePressed'
          : params.type === 'mouseMoved' && params.buttons === 1
      )
        abort.abort();
      return {};
    };
    const lane = new ActionLane({
      runtimeKey: {},
      generation: 1,
      isCurrent: (): boolean => true,
    });
    const result = await lane.run(
      (context) =>
        dispatchDrag({
          send,
          cleanupSend: send,
          lane: context,
          from: { x: 10, y: 20 },
          to: { x: 910, y: 920 },
          steps,
          subscribe: (): (() => void) => (): void => {},
        }),
      { signal: abort.signal },
    );
    expect(result.status).toBe('outcome_unknown');
    await lane.run(() => undefined);
    expect(calls.filter((call) => call.type === 'mouseMoved')).toHaveLength(
      moves,
    );
    expect(calls.filter((call) => call.type === 'mouseReleased')).toEqual([
      { type: 'mouseReleased', ...releasedAt },
    ]);
  },
);

it('releases at the press point when the first held move is refused before it is sent', async () => {
  const calls: Array<{ type: string; x: unknown; y: unknown }> = [];
  const record = (params: Record<string, unknown>): Promise<unknown> => {
    calls.push({
      type: String(params.type ?? params.enabled),
      x: params.x,
      y: params.y,
    });
    return Promise.resolve({});
  };
  // The service's sender refuses input synchronously once the document
  // has changed; cleanup's sender is not fenced.
  const send = (
    _method: string,
    params: Record<string, unknown>,
  ): Promise<unknown> => {
    if (params.type === 'mouseMoved' && params.buttons === 1)
      throw new Error('The document changed.');
    return record(params);
  };
  const lane = new ActionLane({
    runtimeKey: {},
    generation: 1,
    isCurrent: (): boolean => true,
  });
  const result = await lane.run((context) =>
    dispatchDrag({
      send,
      cleanupSend: (_method, params) => record(params),
      lane: context,
      from: { x: 10, y: 20 },
      to: { x: 910, y: 920 },
      steps: 1,
      subscribe: (): (() => void) => (): void => {},
    }),
  );
  expect(result.status).toBe('outcome_unknown');
  await lane.run(() => undefined);
  expect(calls.filter((call) => call.type === 'mouseReleased')).toEqual([
    { type: 'mouseReleased', x: 10, y: 20 },
  ]);
});
