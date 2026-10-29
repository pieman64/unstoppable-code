import type { BrowserCdpSend } from './actionability';
import type { ActionLaneContext } from './action-lane';

/** An acknowledged move; hover deliberately has no pointer delivery recorder. */
export async function dispatchHover(options: {
  send: BrowserCdpSend;
  sessionId?: string;
  lane: ActionLaneContext;
  point: { x: number; y: number };
}): Promise<void> {
  options.lane.signal.throwIfAborted();
  options.lane.beginDispatch();
  await options.lane.trackCommand(
    options.send(
      'Input.dispatchMouseEvent',
      { type: 'mouseMoved', ...options.point, button: 'none', buttons: 0 },
      options.sessionId,
    ),
  );
}
