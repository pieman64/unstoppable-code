import { randomUUID } from 'node:crypto';
import { hostWorldContext, type ActionTargetDeps } from './action-targets';
import { isCDPRecord, readCDPArray } from './cdp-decode';
import type { NodeIdentity } from './frame-registry';
import { remoteObjectId, remoteValue } from './host-cdp';

/** Trusted input a frame target's document received while recording. */
export type RecordedInput =
  | {
      type: 'pointerdown';
      button: number;
      clientX: number;
      clientY: number;
      at: number;
    }
  | { type: 'keydown'; key: string; at: number };

/**
 * The input the action dispatched, in the target document's coordinates,
 * and when it sent it (`Date.now()` of the main process, the recorder's
 * `at` is the renderer's: both read the same system clock, as the
 * preload's attribution of main-frame input does).
 */
export type ExpectedInput = { at: number } & (
  | {
      type: 'pointerdown';
      button: number;
      point: { x: number; y: number };
    }
  | { type: 'keydown'; key: string }
);

export interface InputRecorder {
  /** Undefined when the recorder cannot be read (its document is gone). */
  read(): Promise<RecordedInput[] | undefined>;
  /** Stops recording and releases it; idempotent. */
  dispose(): Promise<void>;
}

/**
 * Host world, `this` is the frame's global: records trusted pointer and key
 * input in the capture phase, as the preload does for the main frame, in a
 * world page script cannot reach. Keeps the last 16.
 */
const RECORDER_FUNCTION = `function() {
  const log = [];
  const note = (event) => {
    if (!event.isTrusted) return;
    if (event.type === 'pointerdown')
      log.push({ type: 'pointerdown', button: event.button, clientX: event.clientX, clientY: event.clientY, at: Date.now() });
    else log.push({ type: 'keydown', key: String(event.key), at: Date.now() });
    if (log.length > 16) log.shift();
  };
  this.addEventListener('pointerdown', note, true);
  this.addEventListener('keydown', note, true);
  return {
    read: () => log.slice(),
    stop: () => {
      this.removeEventListener('pointerdown', note, true);
      this.removeEventListener('keydown', note, true);
    },
  };
}`;

const READ_FUNCTION = 'function() { return this.read(); }';
const STOP_FUNCTION = 'function() { this.stop(); }';

/** Pixels a recorded point may differ from the dispatched one (rounding). */
const POINT_TOLERANCE = 2;

function decodeRecorded(value: unknown): RecordedInput | undefined {
  if (!isCDPRecord(value) || typeof value.at !== 'number') return undefined;
  if (
    value.type === 'pointerdown' &&
    typeof value.button === 'number' &&
    typeof value.clientX === 'number' &&
    typeof value.clientY === 'number'
  )
    return {
      type: 'pointerdown',
      button: value.button,
      clientX: value.clientX,
      clientY: value.clientY,
      at: value.at,
    };
  if (value.type === 'keydown' && typeof value.key === 'string')
    return { type: 'keydown', key: value.key, at: value.at };
  return undefined;
}

/** Whether recorded input is the dispatched input. */
export function inputMatches(
  recorded: RecordedInput,
  expected: ExpectedInput,
): boolean {
  // Input recorded before the press was sent is someone else's (review R2
  // finding 3), however well it matches.
  if (recorded.at < expected.at) return false;
  if (recorded.type === 'keydown')
    return expected.type === 'keydown' && recorded.key === expected.key;
  return (
    expected.type === 'pointerdown' &&
    recorded.button === expected.button &&
    Math.abs(recorded.clientX - expected.point.x) <= POINT_TOLERANCE &&
    Math.abs(recorded.clientY - expected.point.y) <= POINT_TOLERANCE
  );
}

/**
 * Starts recording trusted input in the target's document, in its host
 * world in its own session. Undefined when the frame is gone, shows
 * another document than the target's (checked before the world is made,
 * after, and after the recorder is installed, which it then removes), or
 * the world cannot be made; the caller then cannot confirm delivery.
 */
export async function armInputRecorder(
  deps: ActionTargetDeps,
  identity: NodeIdentity,
): Promise<InputRecorder | undefined> {
  const shown = (): boolean => {
    const frame = deps.registry.getFrame(identity.frameId);
    return (
      frame !== undefined &&
      frame.sessionId === identity.sessionId &&
      frame.loaderId === identity.loaderId
    );
  };
  if (!shown()) return undefined;
  const contextId = await hostWorldContext(
    deps,
    identity.frameId,
    identity.sessionId,
  ).catch(() => undefined);
  if (contextId === undefined || !shown()) return undefined;
  const group = `canopy-input-recorder-${randomUUID()}`;
  const release = (): Promise<unknown> =>
    deps
      .send(
        'Runtime.releaseObjectGroup',
        { objectGroup: group },
        identity.sessionId,
      )
      .catch(() => undefined);
  const handle = remoteObjectId(
    await deps
      .send(
        'Runtime.callFunctionOn',
        {
          functionDeclaration: RECORDER_FUNCTION,
          executionContextId: contextId,
          objectGroup: group,
          returnByValue: false,
        },
        identity.sessionId,
      )
      .catch(() => undefined),
  );
  if (!handle) {
    await release();
    return undefined;
  }
  if (!shown()) {
    await deps
      .send(
        'Runtime.callFunctionOn',
        { objectId: handle, functionDeclaration: STOP_FUNCTION },
        identity.sessionId,
      )
      .catch(() => undefined);
    await release();
    return undefined;
  }
  let disposed = false;
  return {
    read: async (): Promise<RecordedInput[] | undefined> => {
      if (disposed) return undefined;
      const response = await deps
        .send(
          'Runtime.callFunctionOn',
          {
            objectId: handle,
            functionDeclaration: READ_FUNCTION,
            returnByValue: true,
          },
          identity.sessionId,
        )
        .catch(() => undefined);
      const entries = readCDPArray(remoteValue(response));
      if (!entries) return undefined;
      const recorded: RecordedInput[] = [];
      for (const entry of entries) {
        const decoded = decodeRecorded(entry);
        if (decoded) recorded.push(decoded);
      }
      return recorded;
    },
    dispose: async (): Promise<void> => {
      if (disposed) return;
      disposed = true;
      await deps
        .send(
          'Runtime.callFunctionOn',
          { objectId: handle, functionDeclaration: STOP_FUNCTION },
          identity.sessionId,
        )
        .catch(() => undefined);
      await release();
    },
  };
}
