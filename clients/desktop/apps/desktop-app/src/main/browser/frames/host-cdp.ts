import {
  decodeLayoutScroll,
  isCDPRecord,
  readCDPInteger,
  readCDPString,
} from './cdp-decode';

/** The CDP sender the host is given; sessions are flat (`''` is the root). */
export type HostSend = (
  method: string,
  params: Record<string, unknown>,
  sessionId?: string,
) => Promise<unknown>;

/** Rejects when `operation` takes longer than `timeoutMs`. */
export function bounded<T>(
  operation: Promise<T>,
  timeoutMs: number,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('Page model bridge timed out.')),
      timeoutMs,
    );
    operation.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

/** A by-value `Runtime.*` result, or undefined after an exception. */
export function remoteValue(response: unknown): unknown {
  return isCDPRecord(response) &&
    response.exceptionDetails === undefined &&
    isCDPRecord(response.result)
    ? response.result.value
    : undefined;
}

/** The object id of a `Runtime.*` result, or undefined after an exception. */
export function remoteObjectId(response: unknown): string | undefined {
  return isCDPRecord(response) &&
    response.exceptionDetails === undefined &&
    isCDPRecord(response.result)
    ? readCDPString(response.result.objectId)
    : undefined;
}

/**
 * Resolves a backend node to a remote object in one execution context (the
 * frame's main world when `executionContextId` is undefined).
 */
export async function resolveNodeObject(
  send: HostSend,
  sessionId: string,
  backendNodeId: number,
  objectGroup: string,
  executionContextId?: number,
): Promise<string | undefined> {
  const response = await send(
    'DOM.resolveNode',
    {
      backendNodeId,
      objectGroup,
      ...(executionContextId === undefined ? {} : { executionContextId }),
    },
    sessionId,
  );
  return isCDPRecord(response) && isCDPRecord(response.object)
    ? readCDPString(response.object.objectId)
    : undefined;
}

/** Releases an object group in every session it was used in; best effort. */
export function releaseObjectGroup(
  send: HostSend,
  objectGroup: string,
  sessions: Iterable<string>,
): void {
  for (const sessionId of Array.from(sessions)) {
    void send('Runtime.releaseObjectGroup', { objectGroup }, sessionId).catch(
      () => undefined,
    );
  }
}

/**
 * The host's isolated world, for reads and writes page script must not be
 * able to change (styles, target state, fill). Created per frame on demand.
 */
export const HOST_WORLD_NAME = 'CanopyPageModelHost';

/**
 * The deepest node at a viewport point of a session's top document, through
 * its same-process frames and shadow roots. `DOM.getNodeForLocation` takes
 * that document's coordinates, scroll included (verified live: on a page
 * scrolled by 60 the viewport point hits another node), and only integers;
 * the scroll is read fresh from the same session. Undefined when nothing is
 * there or the session cannot report its scroll.
 */
export async function nodeAtViewportPoint(
  send: HostSend,
  sessionId: string,
  point: { x: number; y: number },
): Promise<{ backendNodeId: number; frameId?: string } | undefined> {
  const scroll = decodeLayoutScroll(
    await send('Page.getLayoutMetrics', {}, sessionId).catch(() => undefined),
  );
  if (!scroll) return undefined;
  const hit = await send(
    'DOM.getNodeForLocation',
    {
      x: Math.round(point.x + scroll.x),
      y: Math.round(point.y + scroll.y),
      includeUserAgentShadowDOM: false,
      ignorePointerEventsNone: false,
    },
    sessionId,
  ).catch(() => undefined);
  if (!isCDPRecord(hit)) return undefined;
  const backendNodeId = readCDPInteger(hit.backendNodeId);
  if (backendNodeId === undefined) return undefined;
  const frameId = readCDPString(hit.frameId);
  return frameId === undefined ? { backendNodeId } : { backendNodeId, frameId };
}
