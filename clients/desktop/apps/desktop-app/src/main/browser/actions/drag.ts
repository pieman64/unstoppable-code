import type { BrowserKeyModifier } from '@canopy/execution-engine/types/browser';
import { isCDPRecord } from '../frames/cdp-decode';
import type { BrowserCdpSend } from './actionability';
import type { ActionLaneContext } from './action-lane';
import type { InputAttribution } from './input-dispatch';
import { pauseScroll } from './scroll';

interface Point {
  x: number;
  y: number;
}

/** A refused drag still has to be cancelled, without its files. */
class RefusedDragError extends Error {
  public constructor(public readonly dragOperationsMask: number) {
    super('File-backed browser drags are not supported.');
  }
}

/** Decode only the portable CDP drag payload, never event envelopes or handles. */
function dragData(value: unknown): Record<string, unknown> | undefined {
  if (
    !isCDPRecord(value) ||
    !Array.isArray(value.items) ||
    typeof value.dragOperationsMask !== 'number' ||
    !Number.isInteger(value.dragOperationsMask)
  )
    return undefined;
  const items: Array<Record<string, unknown>> = [];
  for (const item of value.items) {
    if (
      !isCDPRecord(item) ||
      typeof item.mimeType !== 'string' ||
      typeof item.data !== 'string'
    )
      return undefined;
    items.push({
      mimeType: item.mimeType,
      data: item.data,
      ...(typeof item.title === 'string' ? { title: item.title } : {}),
      ...(typeof item.baseURL === 'string' ? { baseURL: item.baseURL } : {}),
    });
  }
  // Do not accept filesystem-backed drags in browser agent actions.
  if (Array.isArray(value.files) && value.files.length > 0)
    throw new RefusedDragError(value.dragOperationsMask);
  return { items, dragOperationsMask: value.dragOperationsMask };
}

export interface DragResult {
  /**
   * The page started a drag only after the pointer was released, too late
   * to deliver. It was cancelled, so the page saw no drop.
   */
  undelivered: boolean;
}

export async function dispatchDrag(options: {
  send: BrowserCdpSend;
  cleanupSend: BrowserCdpSend;
  sessionId?: string;
  lane: ActionLaneContext;
  from: Point;
  to: Point;
  steps?: number;
  modifiers?: BrowserKeyModifier[];
  beforeInput?: (event: InputAttribution) => void;
  subscribe: (listener: (data: unknown) => void) => () => void;
}): Promise<DragResult> {
  let modifiers = 0;
  for (const modifier of options.modifiers ?? [])
    modifiers |=
      modifier === 'Alt'
        ? 1
        : modifier === 'Control'
          ? 2
          : modifier === 'Meta'
            ? 4
            : 8;
  let data: Record<string, unknown> | undefined;
  let interceptionError: Error | undefined;
  // Chromium holds an intercepted drag until a drop or cancel ends it.
  let cancelData: Record<string, unknown> | undefined;
  let dropped = false;
  let held = false;
  let last = options.from;
  let enabling: Promise<unknown> | undefined;
  let cleanup: Promise<void> | undefined;
  let cancelled = false;
  const unsubscribe = options.subscribe((value) => {
    try {
      data ??= dragData(value);
      cancelData ??= data;
    } catch (error) {
      if (error instanceof RefusedDragError)
        cancelData ??= {
          items: [],
          dragOperationsMask: error.dragOperationsMask,
        };
      interceptionError =
        error instanceof Error ? error : new Error(String(error));
    }
  });
  const clean = (): Promise<void> => {
    cleanup ??= (async (): Promise<void> => {
      // An enable acknowledged after cancellation must precede disable.
      await enabling?.catch(() => undefined);
      // Chromium reports an intercepted drag some time after the move that
      // started it. The listener stays on until the end, and every wait
      // below is followed by another look, so a report that lands during
      // cleanup is still cancelled.
      const cancelIntercepted = async (): Promise<void> => {
        if (!cancelData || dropped || cancelled) return;
        cancelled = true;
        await options
          .cleanupSend(
            'Input.dispatchDragEvent',
            { type: 'dragCancel', ...last, data: cancelData, modifiers: 0 },
            options.sessionId,
          )
          .catch(() => undefined);
      };
      try {
        await cancelIntercepted();
        if (held) {
          held = false;
          await options
            .cleanupSend(
              'Input.dispatchMouseEvent',
              {
                type: 'mouseReleased',
                ...last,
                button: 'left',
                buttons: 0,
                modifiers: 0,
                clickCount: 1,
              },
              options.sessionId,
            )
            .catch(() => undefined);
        }
        await cancelIntercepted();
        if (enabling)
          await options
            .cleanupSend(
              'Input.setInterceptDrags',
              { enabled: false },
              options.sessionId,
            )
            .catch(() => undefined);
        await cancelIntercepted();
      } finally {
        unsubscribe();
      }
    })();
    return cleanup;
  };
  options.lane.registerCleanup(clean);
  const mouse = (
    type: 'mouseMoved' | 'mousePressed' | 'mouseReleased',
    point: Point,
  ): Promise<unknown> => {
    options.lane.signal.throwIfAborted();
    // Blink starts a drag only from a move that names the held button.
    const button = type === 'mouseMoved' && !held ? 'none' : 'left';
    options.beforeInput?.({
      type,
      button,
      ...point,
      timestamp: Date.now(),
    });
    const sent = options.send(
      'Input.dispatchMouseEvent',
      {
        type,
        ...point,
        button,
        buttons:
          type === 'mousePressed' || (type === 'mouseMoved' && held) ? 1 : 0,
        // Held through the release, as a click's are; cleanup clears them.
        modifiers,
        clickCount: type === 'mouseMoved' ? 0 : 1,
      },
      options.sessionId,
    );
    // Cleanup releases and cancels here. A point is the pointer's only once
    // its event is past the fences and sent, so a move refused on the way
    // never moves the release to a place the pointer did not go.
    last = point;
    if (type === 'mousePressed') held = true;
    return options.lane.trackCommand(sent);
  };
  try {
    options.lane.signal.throwIfAborted();
    // Interception is an action-scoped input-mode mutation, so it is fenced.
    options.lane.beginDispatch();
    enabling = options.send(
      'Input.setInterceptDrags',
      { enabled: true },
      options.sessionId,
    );
    await options.lane.trackCommand(enabling);
    options.lane.signal.throwIfAborted();
    await mouse('mouseMoved', options.from);
    await mouse('mousePressed', options.from);
    const steps = options.steps ?? 10;
    for (let index = 1; index <= steps; index++)
      await mouse('mouseMoved', {
        x: options.from.x + ((options.to.x - options.from.x) * index) / steps,
        y: options.from.y + ((options.to.y - options.from.y) * index) / steps,
      });
    const deadline = Date.now() + 300;
    while (!data && !interceptionError && Date.now() < deadline)
      await pauseScroll(
        Math.min(25, deadline - Date.now()),
        options.lane.signal,
      );
    options.lane.signal.throwIfAborted();
    if (interceptionError) throw interceptionError;
    if (data) {
      for (const type of ['dragEnter', 'dragOver', 'drop']) {
        options.lane.signal.throwIfAborted();
        await options.lane.trackCommand(
          options.send(
            'Input.dispatchDragEvent',
            { type, ...options.to, data, modifiers },
            options.sessionId,
          ),
        );
        if (type === 'drop') dropped = true;
      }
    }
    await mouse('mouseReleased', options.to);
    held = false;
  } finally {
    await options.lane.trackCommand(clean());
  }
  return { undelivered: cancelled };
}
