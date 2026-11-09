import {
  CoreCoworkRequestError,
  type CoreCoworkInvoker,
  type CoreCoworkStream,
} from '@canopy/app-state/core-cowork';
import type {
  CanopyCoreRelayApi,
  CanopyCoreRelayAuthority,
} from '../../../shared/canopy-core-relay';

const AUTHORITY: CanopyCoreRelayAuthority = 'web-core';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * The cowork store's invoker over the renderer relay. Every request, stream
 * read and close names `authority: 'web-core'`, so main routes it to the web
 * core and never to the local core (CAN-4185 D4, D6).
 */
export function createRelayCoreCoworkInvoker(
  relay: CanopyCoreRelayApi,
): CoreCoworkInvoker {
  return {
    request: (method, params) =>
      relay.invoke({ kind: 'request', method, params, authority: AUTHORITY }),

    openStream: async (method, params): Promise<CoreCoworkStream> => {
      const opened = await relay.invoke({
        kind: 'openStream',
        method,
        params,
        authority: AUTHORITY,
      });
      if (!opened.ok) throw new CoreCoworkRequestError(opened.error);
      const subscriptionId =
        isRecord(opened.value) &&
        typeof opened.value.subscriptionId === 'string'
          ? opened.value.subscriptionId
          : null;
      if (subscriptionId === null)
        throw new CoreCoworkRequestError({
          kind: 'internal',
          message: 'The relay returned an invalid stream.',
          retry: { kind: 'never' },
        });
      let closed = false;
      return {
        next: async () => {
          for (;;) {
            if (closed) return { done: true };
            const read = await relay.invoke({
              kind: 'readStream',
              subscriptionId,
              authority: AUTHORITY,
            });
            if (read.ok)
              return read.value === null
                ? { done: true }
                : { done: false, value: read.value };
            // The relay keeps the pending pull past its read deadline, so a
            // quiet stream is read again rather than treated as ended.
            if (read.error.kind === 'deadline_exceeded') continue;
            return {
              done: false,
              value: { kind: 'end', outcome: 'error', error: read.error },
            };
          }
        },
        close: async () => {
          if (closed) return;
          closed = true;
          await relay.invoke({
            kind: 'closeStream',
            subscriptionId,
            authority: AUTHORITY,
          });
        },
      };
    },
  };
}
