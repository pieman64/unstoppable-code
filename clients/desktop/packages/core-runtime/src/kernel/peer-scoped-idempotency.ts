import { createHash } from 'node:crypto';
import type { CanopyCallerDescriptor } from '@canopy/protocol/canopy-core';
import type { CanopyHandlerContext } from '../runtime/types';

type ForwardedInstruction = (
  params: unknown,
  context: CanopyHandlerContext,
) => unknown;

/**
 * The worker-side idempotency key for one interface caller's keyed request
 * (CAN-5629). The bundled worker sees every interface caller as the owning
 * core, so the core keeps their keys apart: one caller and key always give
 * the same value, two callers never share one.
 */
export function peerScopedIdempotencyKey(
  caller: Pick<CanopyCallerDescriptor, 'principalId' | 'clientInstanceId'>,
  idempotencyKey: string,
): string {
  return `peer:${createHash('sha256')
    .update(
      JSON.stringify([
        caller.principalId,
        caller.clientInstanceId,
        idempotencyKey,
      ]),
    )
    .digest('base64url')}`;
}

/** The forwarded instructions in `names` with each keyed request's key scoped to its caller. */
export function scopeForwardedIdempotency(
  instructions: Readonly<Record<string, ForwardedInstruction>>,
  names: ReadonlySet<string>,
): Readonly<Record<string, ForwardedInstruction>> {
  return Object.fromEntries(
    Object.entries(instructions).map(([name, forward]) => [
      name,
      names.has(name)
        ? (params: unknown, context: CanopyHandlerContext): unknown => {
            const key = context.metadata.idempotencyKey;
            return forward(
              params,
              key === undefined
                ? context
                : {
                    ...context,
                    metadata: {
                      ...context.metadata,
                      idempotencyKey: peerScopedIdempotencyKey(
                        context.caller,
                        key,
                      ),
                    },
                  },
            );
          }
        : forward,
    ]),
  );
}
