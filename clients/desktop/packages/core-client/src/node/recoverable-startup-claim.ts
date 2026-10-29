import type {
  CanopyStartupClaimAcquisition,
  CanopyStartupClaimPort,
} from './launcher-ports';

/** Only the transport operations needed by the trusted cleanup adapter. */
export interface CanopyRetainedStartupClaimPort {
  tryAcquire(
    signal: AbortSignal,
    options: {
      readonly recoverDeparted: true;
      readonly recoverOwnHandle?: object;
    },
  ): Promise<CanopyStartupClaimAcquisition>;
  release(
    handle: object,
    options: { readonly preserveEndpointBind: true },
  ): ReturnType<CanopyStartupClaimPort['release']>;
}

/** Eligibility is armed only by the launcher's confirmed-cleanup release path. */
export function createRecoverableCanopyStartupClaim(
  port: () => Promise<CanopyRetainedStartupClaimPort>,
): CanopyStartupClaimPort {
  let latest: object | undefined;
  let eligible: object | undefined;
  return {
    async tryAcquire(
      signal,
    ): Promise<Awaited<ReturnType<CanopyStartupClaimPort['tryAcquire']>>> {
      const claims = await port();
      const result = await claims.tryAcquire(signal, {
        recoverDeparted: true,
        ...(eligible && { recoverOwnHandle: eligible }),
      });
      if (result.kind === 'acquired') {
        // Return late capabilities for cleanup without making them retry-eligible.
        latest = signal.aborted ? undefined : result.handle;
        eligible = undefined;
      }
      return result;
    },
    async release(
      handle,
      signal,
    ): Promise<Awaited<ReturnType<CanopyStartupClaimPort['release']>>> {
      const result = await (
        await port()
      ).release(handle, { preserveEndpointBind: true });
      if (handle === latest && !signal?.aborted)
        eligible = result === 'not_owner' ? handle : undefined;
      return result;
    },
  };
}
