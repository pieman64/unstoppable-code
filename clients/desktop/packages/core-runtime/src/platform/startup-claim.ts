import type { PlatformStartupClaim } from './platform-services';

export type DaemonStartupClaimAcquisition =
  | {
      readonly kind: 'acquired';
      readonly handle: object;
      /** Present only when the acquisition replaced a proven-departed owner's claim. */
      readonly recovered?: { readonly endpointBound: boolean };
    }
  | { readonly kind: 'held' | 'ambiguous' };

/** Trusted host composition port; handles are capabilities, never operation DTOs or argv. */
export interface DaemonStartupClaimPort {
  tryAcquire(
    signal?: AbortSignal,
    options?: { readonly recoverDeparted?: boolean },
  ): Promise<DaemonStartupClaimAcquisition>;
  /** Retains the launcher token while transferring current process ownership. */
  adopt(
    handle: object,
    signal?: AbortSignal,
  ): Promise<DaemonStartupClaimAcquisition>;
  identity(handle: object): Promise<PlatformStartupClaim | null>;
  /** Launcher release after handoff requires confirmed child exit. */
  release(handle: object): Promise<'released' | 'not_owner' | 'ambiguous'>;
  /**
   * Records that the holder is about to bind at a path it verified empty.
   * Without it, a socket left by a crash before publication is never recovered.
   */
  markEndpointBind?(handle: object): Promise<boolean>;
}
