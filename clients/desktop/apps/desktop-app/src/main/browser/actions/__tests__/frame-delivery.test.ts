import type { RecordedInput } from '../../frames/input-recorder';
import type { DocumentMapping } from '../actionability';
import {
  documentPoint,
  FrameDelivery,
  isPressEvent,
  mouseButtonNumber,
} from '../frame-delivery';

function recorder(entries: RecordedInput[] | undefined): {
  read: jest.Mock<Promise<RecordedInput[] | undefined>, []>;
  dispose: jest.Mock<Promise<void>, []>;
} {
  return {
    read: jest.fn(() => Promise.resolve(entries)),
    dispose: jest.fn(() => Promise.resolve()),
  };
}

function delivery(
  entries: RecordedInput[] | undefined,
  options: { open?: () => boolean; mapping?: { originX: number } } = {},
): { frame: FrameDelivery; matches: jest.Mock; read: jest.Mock } {
  const source = recorder(entries);
  const matches = jest.fn();
  const frame = new FrameDelivery({
    recorder: source,
    track: <T>(command: Promise<T>): Promise<T> => command,
    open: options.open ?? ((): boolean => true),
    onMatch: matches,
    mapping: (): DocumentMapping | undefined =>
      options.mapping
        ? {
            originX: options.mapping.originX,
            originY: 0,
            scaleX: 1,
            scaleY: 1,
          }
        : undefined,
  });
  return { frame, matches, read: source.read };
}

describe('delivery confirmation for a target in a child frame', () => {
  it("matches a press in the target document's coordinates", async () => {
    const { frame, matches } = delivery(
      [{ type: 'pointerdown', button: 0, clientX: 30, clientY: 20, at: 1 }],
      { mapping: { originX: 100 } },
    );
    frame.expect({
      type: 'mousePressed',
      button: 'left',
      x: 130,
      y: 20,
      timestamp: 1,
    });
    await frame.confirm();
    expect(matches).toHaveBeenCalledTimes(1);
    await frame.confirm();
    expect(matches).toHaveBeenCalledTimes(1);
  });

  it('does not match another button, another point, or input before expectations', async () => {
    const entries: RecordedInput[] = [
      { type: 'pointerdown', button: 2, clientX: 30, clientY: 20, at: 1 },
      { type: 'pointerdown', button: 0, clientX: 90, clientY: 20, at: 1 },
    ];
    const { frame, matches } = delivery(entries);
    await frame.confirm();
    frame.expect({
      type: 'mousePressed',
      button: 'left',
      x: 30,
      y: 20,
      timestamp: 1,
    });
    await frame.confirm();
    expect(matches).not.toHaveBeenCalled();
  });

  it('matches keys by key, and ignores events that are not presses', async () => {
    const { frame, matches } = delivery([
      { type: 'keydown', key: 'Enter', at: 1 },
    ]);
    frame.expect({ type: 'keyUp', key: 'Enter', timestamp: 1 });
    await frame.confirm();
    expect(matches).not.toHaveBeenCalled();
    frame.expect({ type: 'keyDown', key: 'Enter', timestamp: 1 });
    await frame.confirm();
    expect(matches).toHaveBeenCalledTimes(1);
  });

  it.each([
    [
      { type: 'keydown', key: 'Enter', at: 100 },
      { type: 'keyDown', key: 'Enter', timestamp: 200 },
    ],
    [
      { type: 'pointerdown', button: 0, clientX: 30, clientY: 30, at: 100 },
      { type: 'mousePressed', button: 'left', x: 30, y: 30, timestamp: 200 },
    ],
  ] as const)(
    'must not confirm delivery using trusted input recorded before dispatch (review R2 finding 3, %j)',
    async (recorded, dispatched) => {
      const { frame, matches } = delivery([{ ...recorded }]);
      // The recorder was armed; a person pressed first; then the action did.
      frame.expect({ ...dispatched });
      await frame.confirm();
      expect(matches).not.toHaveBeenCalled();
    },
  );

  it('confirms only input recorded at or after the press that expects it', async () => {
    const { frame, matches } = delivery([
      { type: 'keydown', key: 'a', at: 100 },
      { type: 'keydown', key: 'a', at: 250 },
    ]);
    frame.expect({ type: 'keyDown', key: 'a', timestamp: 250 });
    await frame.confirm();
    expect(matches).toHaveBeenCalledTimes(1);
  });

  it('counts no match once closed, and none without a readable recorder', async () => {
    const closed = delivery([{ type: 'keydown', key: 'a', at: 1 }], {
      open: () => false,
    });
    closed.frame.expect({ type: 'keyDown', key: 'a', timestamp: 1 });
    await closed.frame.confirm();
    expect(closed.matches).not.toHaveBeenCalled();
    const unreadable = delivery(undefined);
    unreadable.frame.expect({ type: 'keyDown', key: 'a', timestamp: 1 });
    await unreadable.frame.confirm();
    expect(unreadable.matches).not.toHaveBeenCalled();
  });

  it('polls until a match, and stops when closed or aborted', async () => {
    jest.useFakeTimers();
    try {
      let entries: RecordedInput[] = [];
      const source = recorder([]);
      source.read.mockImplementation(() => Promise.resolve(entries));
      const matches = jest.fn();
      let open = true;
      const frame = new FrameDelivery({
        recorder: source,
        track: <T>(command: Promise<T>): Promise<T> => command,
        open: (): boolean => open,
        onMatch: matches,
        mapping: (): undefined => undefined,
      });
      frame.expect({ type: 'keyDown', key: 'a', timestamp: 1 });
      const polled = frame.poll(new AbortController().signal);
      await jest.advanceTimersByTimeAsync(120);
      expect(matches).not.toHaveBeenCalled();
      entries = [{ type: 'keydown', key: 'a', at: 2 }];
      await jest.advanceTimersByTimeAsync(60);
      await polled;
      expect(matches).toHaveBeenCalledTimes(1);
      const reads = source.read.mock.calls.length;
      open = false;
      await frame.poll(new AbortController().signal);
      const aborted = new AbortController();
      aborted.abort();
      open = true;
      await frame.poll(aborted.signal);
      expect(source.read.mock.calls.length).toBe(reads);
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('input helpers', () => {
  it('names presses, buttons and document points', () => {
    expect(
      isPressEvent('Input.dispatchMouseEvent', { type: 'mousePressed' }),
    ).toBe(true);
    expect(
      isPressEvent('Input.dispatchMouseEvent', { type: 'mouseMoved' }),
    ).toBe(false);
    expect(isPressEvent('Input.dispatchKeyEvent', { type: 'rawKeyDown' })).toBe(
      true,
    );
    expect(isPressEvent('Input.dispatchKeyEvent', { type: 'keyUp' })).toBe(
      false,
    );
    expect(mouseButtonNumber('right')).toBe(2);
    expect(mouseButtonNumber('middle')).toBe(1);
    expect(mouseButtonNumber('left')).toBe(0);
    expect(
      documentPoint(
        { originX: 100, originY: 50, scaleX: 2, scaleY: 2 },
        { x: 120, y: 70 },
      ),
    ).toEqual({ x: 10, y: 10 });
    expect(documentPoint(undefined, { x: 1, y: 2 })).toEqual({ x: 1, y: 2 });
  });
});
