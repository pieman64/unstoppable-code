import type { MobileActivationResponse } from '@canopy/protocol/mobile-promo';
import type { MobileActivationLoadOptions } from '@canopy/desktop-shared/types';
import { CanopyCloudClientError, requestCanopyCloudJson } from './client';

const MOBILE_ACTIVATION_CACHE_TTL_MS = 60_000;

/**
 * Floor for `forceRefresh`, which is otherwise a total cache bypass.
 *
 * The renderer forces a refresh on every `focus` and `visibilitychange`, and
 * for a signed-in account that has *not* activated — the majority, and the one
 * this probe exists to serve — nothing ever short-circuits those. Without a
 * floor that is one authenticated, database-backed round trip per alt-tab for
 * the life of the process.
 *
 * A floor shorter than {@link MOBILE_ACTIVATION_CACHE_TTL_MS} still satisfies
 * what `forceRefresh` is actually for: the user installs on their phone and
 * alt-tabs back, which is a human-scale gap, not a sub-30-second one.
 */
const MOBILE_ACTIVATION_FORCED_REFRESH_FLOOR_MS = 30_000;

export type MobileActivationProbe =
  | { resolved: true; hasMobileActivation: boolean }
  | { resolved: false };

let cachedProbe:
  | {
      value: Extract<MobileActivationProbe, { resolved: true }>;
      cachedAt: number;
      expiresAt: number;
    }
  | undefined;
let inFlightProbe: Promise<MobileActivationProbe> | undefined;
/** When the last probe failed, so the failure path honors the same floor. */
let lastFailureAt: number | undefined;
let cacheGeneration = 0;

/**
 * Probe the connected account's mobile activation state. Definitive answers
 * are cached briefly; transient failures never replace the last definitive
 * answer held by callers.
 */
export async function probeMobileActivation(
  options: MobileActivationLoadOptions = {},
): Promise<MobileActivationProbe> {
  const now = Date.now();
  if (cachedProbe) {
    // `forceRefresh` shortens the cache rather than discarding it. See
    // MOBILE_ACTIVATION_FORCED_REFRESH_FLOOR_MS: an unbounded bypass turns the
    // renderer's per-focus refresh into one request per alt-tab, forever.
    const freshUntil = options.forceRefresh
      ? cachedProbe.cachedAt + MOBILE_ACTIVATION_FORCED_REFRESH_FLOOR_MS
      : cachedProbe.expiresAt;
    if (freshUntil > now) {
      return cachedProbe.value;
    }
  }

  // The floor above only bounds the *success* path, because a transient failure
  // deliberately caches nothing (so it can never overwrite a definitive
  // answer). Against a persistently failing endpoint — offline, 5xx, a revoked
  // key answering 401 — that left the renderer's focus/visibilitychange
  // handlers issuing one authenticated request per foreground event for the
  // life of the process. Remembering only *when* the last attempt failed keeps
  // the fail-soft contract intact (still `{ resolved: false }`, callers still
  // keep last-known-good) while giving the failure path the same floor.
  if (
    lastFailureAt !== undefined &&
    lastFailureAt + MOBILE_ACTIVATION_FORCED_REFRESH_FLOOR_MS > now
  ) {
    return { resolved: false };
  }

  // The Overview card and bottom cue mount independently and receive the same
  // focus event. Coalesce their probes so a foreground refresh is one network
  // request, even though it deliberately bypasses the minute-long cache.
  if (inFlightProbe) {
    return inFlightProbe;
  }

  const generation = cacheGeneration;
  const request: Promise<MobileActivationProbe> =
    (async (): Promise<MobileActivationProbe> => {
      try {
        const response = await requestCanopyCloudJson<MobileActivationResponse>(
          '/api/v1/mobile-activation',
        );
        const value = {
          resolved: true,
          hasMobileActivation: response.hasMobileActivation,
        } as const;
        if (generation === cacheGeneration) {
          const cachedAt = Date.now();
          cachedProbe = {
            value,
            cachedAt,
            expiresAt: cachedAt + MOBILE_ACTIVATION_CACHE_TTL_MS,
          };
          lastFailureAt = undefined;
        }
        return value;
      } catch (error) {
        if (error instanceof CanopyCloudClientError && error.status === 404) {
          const value = {
            resolved: true,
            hasMobileActivation: false,
          } as const;
          if (generation === cacheGeneration) {
            const cachedAt = Date.now();
            cachedProbe = {
              value,
              cachedAt,
              expiresAt: cachedAt + MOBILE_ACTIVATION_CACHE_TTL_MS,
            };
            lastFailureAt = undefined;
          }
          return value;
        }
        if (generation === cacheGeneration) {
          lastFailureAt = Date.now();
        }
        return { resolved: false };
      }
    })().finally(() => {
      if (inFlightProbe === request) {
        inFlightProbe = undefined;
      }
    });
  inFlightProbe = request;
  return request;
}

/** Clear the short-lived answer after the connected cloud account changes. */
export function invalidateMobileActivationCache(): void {
  cachedProbe = undefined;
  inFlightProbe = undefined;
  lastFailureAt = undefined;
  cacheGeneration += 1;
}
