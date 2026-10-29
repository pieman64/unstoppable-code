import { dispatchAmountScroll, scrollEffect } from '../scroll';
import type { ScrollState } from '../../frames/scroll-state';

function state(y = 0, maxY = 1000): ScrollState {
  return {
    x: 0,
    y,
    maxX: 500,
    maxY,
    width: 200,
    height: 100,
    scrollWidth: 700,
    scrollHeight: maxY + 100,
    scriptX: true,
    scriptY: true,
    point: { x: 50, y: 50 },
  };
}
interface ScrollHarness {
  calls: Array<{ method: string; params: Record<string, unknown>; at: number }>;
  send: jest.Mock<Promise<object>, [string, Record<string, unknown>]>;
  script: jest.Mock<Promise<void>, [number, number, () => void]>;
  read: () => Promise<ScrollState>;
  isVisible: () => boolean;
  wheelPoint: () => Promise<{ x: number; y: number } | undefined>;
  lane: Pick<
    Parameters<typeof dispatchAmountScroll>[0]['lane'],
    'signal' | 'beginDispatch' | 'trackCommand'
  >;
  fence: jest.Mock;
}
function harness(
  options: {
    wheel?: boolean;
    owner?: boolean;
    visible?: boolean;
    maxY?: number;
  } = {},
): ScrollHarness {
  let current = state(0, options.maxY);
  const calls: Array<{
    method: string;
    params: Record<string, unknown>;
    at: number;
  }> = [];
  let dispatched = false;
  const send = jest.fn(
    async (method: string, params: Record<string, unknown>) => {
      await Promise.resolve();

      calls.push({ method, params, at: Date.now() });
      if (method === 'Input.dispatchMouseEvent' && options.wheel)
        current = {
          ...current,
          y: Math.min(current.maxY, current.y + Number(params.deltaY)),
        };
      return {};
    },
  );
  const script = jest.fn(
    async (dx: number, dy: number, beforeWrite: () => void) => {
      await Promise.resolve();

      beforeWrite();
      expect(dispatched).toBe(true);
      current = {
        ...current,
        x: Math.min(current.maxX, Math.max(0, current.x + dx)),
        y: Math.min(current.maxY, Math.max(0, current.y + dy)),
      };
    },
  );
  return {
    calls,
    script,
    send,
    read: async (): Promise<ScrollState> => {
      await Promise.resolve();
      return current;
    },
    isVisible: (): boolean => options.visible !== false,
    wheelPoint: async (): Promise<{ x: number; y: number } | undefined> => {
      await Promise.resolve();
      return options.owner === false ? undefined : { x: 50, y: 50 };
    },
    lane: {
      signal: new AbortController().signal,
      beginDispatch: (): void => {
        dispatched = true;
      },
      trackCommand: <T>(p: Promise<T>): Promise<T> => p,
    },
    fence: jest.fn(),
  };
}

describe('amount scroll', () => {
  afterEach(() => jest.useRealTimers());
  it('splits pages into page-sized signed wheels, at least 150 ms apart', async () => {
    jest.useFakeTimers();
    const h = harness({ wheel: true });
    const result = dispatchAmountScroll({
      ...h,
      direction: 'down',
      pages: 2.5,
      pageSize: 100,
    });
    await jest.advanceTimersByTimeAsync(2000);
    await expect(result).resolves.toMatchObject({
      inputMode: 'trusted',
      deltas: [
        { dx: 0, dy: 100 },
        { dx: 0, dy: 100 },
        { dx: 0, dy: 50 },
      ],
    });
    expect(h.calls.map((c) => c.params.deltaY)).toEqual([100, 100, 50]);
    expect(h.calls[1].at - h.calls[0].at).toBeGreaterThanOrEqual(150);
  });
  it('stops at the edge and never sends gesture or a redundant script delta', async () => {
    jest.useFakeTimers();
    const h = harness({ wheel: true, maxY: 100 });
    const result = dispatchAmountScroll({
      ...h,
      direction: 'down',
      pages: 10,
      pageSize: 100,
    });
    await jest.advanceTimersByTimeAsync(2000);
    await result;
    expect(h.calls).toHaveLength(1);
    expect(h.script).not.toHaveBeenCalled();
  });
  it('observes the wheel for 100 ms quiet then uses one instant script fallback', async () => {
    jest.useFakeTimers();
    const h = harness();
    const result = dispatchAmountScroll({
      ...h,
      direction: 'down',
      pixels: 60,
      pageSize: 100,
    });
    await jest.advanceTimersByTimeAsync(2000);
    await expect(result).resolves.toMatchObject({
      inputMode: 'direct',
      warnings: [
        'The page did not scroll for the wheel; scrolled with script.',
      ],
    });
    expect(h.script).toHaveBeenCalledWith(0, 60, expect.any(Function));
    expect(h.calls.map((c) => c.method)).toEqual(['Input.dispatchMouseEvent']);
  });
  it.each([{ visible: false }, { owner: false }])(
    'uses script without wheel for %p',
    async (opts) => {
      jest.useFakeTimers();
      const h = harness(opts);
      const result = dispatchAmountScroll({
        ...h,
        direction: 'left',
        pixels: 30,
        pageSize: 100,
      });
      await jest.advanceTimersByTimeAsync(2000);
      await result;
      // At the left edge: a no-op counts as delivered and sends no mutation.
      expect(h.calls).toHaveLength(0);
    },
  );
  it('reports minimum and maximum edges and point-in-time content growth', () => {
    expect(
      scrollEffect(state(0), state(1000, 1200), 'page', 'y'),
    ).toMatchObject({
      axis: 'y',
      moved: true,
      atStart: false,
      atEnd: false,
      contentGrew: true,
    });
  });
});

describe('scroll routing and direction signs', () => {
  afterEach(() => jest.useRealTimers());
  it.each([
    { direction: 'down', dx: 0, dy: 25 },
    { direction: 'up', dx: 0, dy: -25 },
    { direction: 'right', dx: 25, dy: 0 },
    { direction: 'left', dx: -25, dy: 0 },
  ] as const)(
    'pins wheel signs for $direction',
    async ({ direction, dx, dy }) => {
      jest.useFakeTimers();
      let current = { ...state(400), x: 100 };
      const send = jest.fn(
        async (_method: string, params: Record<string, unknown>) => {
          await Promise.resolve();

          current = {
            ...current,
            x: current.x + Number(params.deltaX),
            y: current.y + Number(params.deltaY),
          };
          return {};
        },
      );
      const result = dispatchAmountScroll({
        direction,
        pixels: 25,
        pageSize: 100,
        send,
        lane: {
          signal: new AbortController().signal,
          beginDispatch: (): void => {},
          trackCommand: <T>(p: Promise<T>): Promise<T> => p,
        },
        fence: () => {},
        read: async (): Promise<ScrollState> => {
          await Promise.resolve();
          return current;
        },
        isVisible: (): boolean => true,
        wheelPoint: async (): Promise<{ x: number; y: number } | undefined> => {
          await Promise.resolve();
          return { x: 50, y: 50 };
        },
        script: jest.fn(),
      });
      await jest.advanceTimersByTimeAsync(600);
      await result;
      expect(send).toHaveBeenCalledWith(
        'Input.dispatchMouseEvent',
        expect.objectContaining({ deltaX: dx, deltaY: dy }),
        undefined,
      );
    },
  );
  it.each([
    {
      visible: false,
      warning: 'The browser view is hidden; scrolled with script.',
    },
    {
      owner: false,
      warning:
        'Scrolled with script: the pointer would have scrolled another element.',
    },
  ])(
    'does not wheel another owner or a hidden pane: %p',
    async ({ visible, owner, warning }) => {
      jest.useFakeTimers();
      const h = harness({ visible, owner });
      const result = dispatchAmountScroll({
        ...h,
        direction: 'down',
        pixels: 40,
        pageSize: 100,
      });
      await jest.advanceTimersByTimeAsync(600);
      await expect(result).resolves.toMatchObject({
        inputMode: 'direct',
        warnings: [warning],
      });
      expect(h.calls).toHaveLength(0);
      expect(h.script).toHaveBeenCalledWith(0, 40, expect.any(Function));
    },
  );
});

it('does not cross the dispatch boundary while preparing a host-world script object', async () => {
  const { ActionLane } = await import('../action-lane');
  const abort = new AbortController();
  const lane = new ActionLane({
    runtimeKey: {},
    generation: 1,
    isCurrent: (): boolean => true,
  });
  const mutation = jest.fn();
  const result = await lane.run(
    (context) =>
      dispatchAmountScroll({
        send: jest.fn(),
        lane: context,
        direction: 'down',
        pixels: 20,
        pageSize: 100,
        fence: () => {},
        read: async (): Promise<ScrollState> => {
          await Promise.resolve();
          return state();
        },
        isVisible: (): boolean => false,
        wheelPoint: async (): Promise<{ x: number; y: number } | undefined> => {
          await Promise.resolve();
          return undefined;
        },
        script: async (_dx, _dy, beforeWrite) => {
          await Promise.resolve();
          abort.abort();
          beforeWrite();
          mutation();
        },
      }),
    { signal: abort.signal },
  );
  expect(result.status).toBe('not_executed');
  expect(mutation).not.toHaveBeenCalled();
});
