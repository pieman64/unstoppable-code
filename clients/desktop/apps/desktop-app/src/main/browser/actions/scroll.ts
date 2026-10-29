import type {
  BrowserScrollDirection,
  BrowserScrollEffect,
} from '@canopy/desktop-shared/types/browser';
import type { ScrollState } from '../frames/scroll-state';
import type { ActionLaneContext } from './action-lane';
import type { BrowserCdpSend } from './actionability';

export async function pauseScroll(
  ms: number,
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const abort = (): void => {
      clearTimeout(timer);
      reject(
        signal.reason instanceof Error
          ? signal.reason
          : new Error('Browser scroll was cancelled.'),
      );
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolve();
    }, ms);
    signal.addEventListener('abort', abort, { once: true });
  });
}

/** A bounded point-in-time observation, not proof lazy content has finished. */
export async function waitForScrollStability(
  read: () => Promise<ScrollState>,
  signal: AbortSignal,
  maximumMs = 1000,
): Promise<ScrollState> {
  let previous = await read();
  const deadline = Date.now() + maximumMs;
  let quietAt = Date.now();
  while (Date.now() < deadline && Date.now() - quietAt < 100) {
    await pauseScroll(Math.min(50, deadline - Date.now()), signal);
    const current = await read();
    if (current.x !== previous.x || current.y !== previous.y)
      quietAt = Date.now();
    previous = current;
  }
  return previous;
}

export function scrollEffect(
  before: ScrollState,
  after: ScrollState,
  container: 'page' | 'element',
  axis: 'x' | 'y',
): BrowserScrollEffect {
  const offset = axis === 'x' ? after.x : after.y;
  const maximum = axis === 'x' ? after.maxX : after.maxY;
  return {
    container,
    axis,
    x: after.x,
    y: after.y,
    maxX: after.maxX,
    maxY: after.maxY,
    atStart: offset <= 1,
    atEnd: offset >= maximum - 1,
    moved: axis === 'x' ? before.x !== after.x : before.y !== after.y,
    contentGrew:
      axis === 'x'
        ? after.scrollWidth > before.scrollWidth
        : after.scrollHeight > before.scrollHeight,
  };
}

export interface AmountScrollResult {
  inputMode: 'trusted' | 'direct';
  warnings: string[];
  deltas: Array<{ dx: number; dy: number }>;
  point?: { x: number; y: number };
  operations?: Array<{
    kind: 'wheel' | 'script';
    dx: number;
    dy: number;
    point?: { x: number; y: number };
  }>;
}

export async function dispatchAmountScroll(options: {
  send: BrowserCdpSend;
  sessionId?: string;
  lane: Pick<ActionLaneContext, 'beginDispatch' | 'trackCommand' | 'signal'>;
  fence: () => void;
  direction: BrowserScrollDirection;
  pages?: number;
  pixels?: number;
  pageSize: number;
  read: () => Promise<ScrollState>;
  /** Resolve first, call beforeWrite just before mutation, and track the mutating CDP send. */
  script: (dx: number, dy: number, beforeWrite: () => void) => Promise<void>;
  isVisible: () => boolean;
  /** Only returns a point when D9 and the wheel-owner check pass. */
  wheelPoint: () => Promise<{ x: number; y: number } | undefined>;
  recordingPoint?: (point: {
    x: number;
    y: number;
  }) => Promise<{ x: number; y: number } | undefined>;
}): Promise<AmountScrollResult> {
  const result: AmountScrollResult = {
    inputMode: 'trusted',
    warnings: [],
    deltas: [],
    operations: [],
  };
  const axis =
    options.direction === 'left' || options.direction === 'right' ? 'x' : 'y';
  const sign =
    options.direction === 'up' || options.direction === 'left' ? -1 : 1;
  const size =
    options.pageSize > 0 && Number.isFinite(options.pageSize)
      ? options.pageSize
      : 1000;
  let remaining = options.pixels ?? (options.pages ?? 1) * size;
  const warning = (message: string): void => {
    if (!result.warnings.includes(message)) result.warnings.push(message);
  };
  let previousStepAt: number | undefined;
  while (remaining > 0) {
    options.lane.signal.throwIfAborted();
    if (previousStepAt !== undefined && Date.now() - previousStepAt < 150)
      await pauseScroll(
        150 - (Date.now() - previousStepAt),
        options.lane.signal,
      );
    const before = await options.read();
    const position = axis === 'x' ? before.x : before.y;
    const max = axis === 'x' ? before.maxX : before.maxY;
    if (sign > 0 ? position >= max - 1 : position <= 1) {
      // The state confirms a no-op at the edge. Still a completed lane action.
      options.fence();
      options.lane.beginDispatch();
      break;
    }
    const distance = Math.min(
      remaining,
      options.pixels === undefined ? size : remaining,
    );
    const dx = axis === 'x' ? sign * distance : 0;
    const dy = axis === 'y' ? sign * distance : 0;
    let point: { x: number; y: number } | undefined;
    if (options.isVisible()) point = await options.wheelPoint();
    // Presentation can change while the wheel routing reads run.
    const visible = options.isVisible();
    options.fence();
    options.lane.signal.throwIfAborted();
    previousStepAt = Date.now();
    const beforeWrite = (): void => {
      options.lane.signal.throwIfAborted();
      options.fence();
      options.lane.beginDispatch();
    };
    if (!visible || !point) {
      result.inputMode = 'direct';
      warning(
        !visible
          ? 'The browser view is hidden; scrolled with script.'
          : 'Scrolled with script: the pointer would have scrolled another element.',
      );
      await options.script(dx, dy, beforeWrite);
      result.operations?.push({ kind: 'script', dx, dy });
    } else {
      result.point = point;
      const recordedPoint = options.recordingPoint
        ? await options.recordingPoint(point)
        : point;
      beforeWrite();
      await options.lane.trackCommand(
        options.send(
          'Input.dispatchMouseEvent',
          {
            type: 'mouseWheel',
            x: point.x,
            y: point.y,
            button: 'none',
            buttons: 0,
            deltaX: dx,
            deltaY: dy,
          },
          options.sessionId,
        ),
      );
      result.operations?.push({ kind: 'wheel', dx, dy, point: recordedPoint });
      const after = await waitForScrollStability(
        options.read,
        options.lane.signal,
        500,
      );
      const offset = axis === 'x' ? after.x : after.y;
      const maximum = axis === 'x' ? after.maxX : after.maxY;
      if (
        offset === position &&
        !(sign > 0 ? offset >= maximum - 1 : offset <= 1)
      ) {
        result.inputMode = 'direct';
        warning('The page did not scroll for the wheel; scrolled with script.');
        options.fence();
        options.lane.signal.throwIfAborted();
        const rest = sign * Math.max(0, distance - sign * (offset - position));
        await options.script(
          axis === 'x' ? rest : 0,
          axis === 'y' ? rest : 0,
          beforeWrite,
        );
        result.operations?.push({
          kind: 'script',
          dx: axis === 'x' ? rest : 0,
          dy: axis === 'y' ? rest : 0,
        });
      }
    }
    result.deltas.push({ dx, dy });
    remaining -= distance;
  }
  return result;
}
