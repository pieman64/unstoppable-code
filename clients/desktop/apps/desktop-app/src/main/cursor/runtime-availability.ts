import type { CursorConnectionStatus } from '@canopy/desktop-shared/types';

/**
 * Last observed managed-runtime availability. Stays `undefined` until the
 * first refresh so Portal projections omit the key ("unknown") instead of
 * asserting a state this process has never checked.
 */
let lastAvailability: boolean | undefined;

/**
 * Monotonic call counter. Status IPC background refresh, Connect/Disconnect,
 * and Portal sends can all trigger overlapping calls; a slower EARLIER call
 * finishing after a newer one must not clobber the cache with its stale
 * answer. Only the generation that was current when a call's result resolves
 * — i.e. no newer call has started in the meantime — is allowed to write
 * `lastAvailability`. The generation MUST be captured before the probe's
 * first `await`, not after it resolves: minting a generation post-hoc (from
 * an answer some other call already has in hand) always "wins" trivially,
 * even when that answer is older than the cache's current value — this bit
 * the first version of the status-IPC seed path, which called
 * `cursorConnectionStatus()` itself and only grabbed a generation afterward
 * to cache the result, letting a slow-but-earlier status call clobber a
 * fast-but-later Disconnect refresh.
 */
let currentGeneration = 0;

/** Single source of truth for what "available" means, so the cached value and the returned value can't drift. */
function isAvailableStatus(status: CursorConnectionStatus): boolean {
  return status.supported && status.enabled && status.installed;
}

/**
 * Canonical probe: captures a generation, runs the one Cursor status check,
 * and — only if no newer call has started meanwhile — caches the derived
 * availability. Returns the full status (not just the derived boolean) so
 * callers that need the raw fields (the status IPC handler) don't have to
 * run a second, redundant probe just to get them; `isCursorRuntimeAvailable()`
 * below is the boolean-only, fail-closed wrapper most callers want.
 *
 * Deferred on purpose, matching `ipc/cursor-connection.ts` and
 * `models/model-registry.ts`: this module is reached from
 * `auth/provider-auth-state` by most of the main process, and a static import
 * would load the whole Cursor runtime graph with it, whether or not Cursor is
 * ever used. That graph resolves its pinned metadata at module load: from the
 * `__CANOPY_CURSOR_CLI__` constant the electron-vite, CLI and jest builds
 * inject, or, under direct source execution through tsx, by reading the root
 * package manifest synchronously. Both work; neither belongs on the load
 * path of every module that only asks whether Cursor is available.
 */
async function refreshCursorRuntimeStatus(): Promise<CursorConnectionStatus> {
  const generation = ++currentGeneration;
  try {
    const { cursorConnectionStatus } = await import('./runtime-status');
    const status = await cursorConnectionStatus();
    if (generation === currentGeneration) {
      lastAvailability = isAvailableStatus(status);
    }
    return status;
  } catch (error) {
    // The cache write here IS fail-closed (a probe failure always caches
    // `false` when it wins the generation race) even though the error itself
    // propagates — `isCursorRuntimeAvailable()` is the layer that turns a
    // thrown error into a fail-closed `false` return; this function's own
    // throw lets `probeCursorRuntimeStatus()` surface failures (including
    // `assertCursorHarnessEnabled()` rejections) exactly as the status IPC
    // handler did before this shared path existed.
    if (generation === currentGeneration) {
      lastAvailability = false;
    }
    throw error;
  }
}

/**
 * Shared preflight for every surface that dispatches to Cursor: the canonical
 * chat model-change IPC, the Portal chat adapter's send and set-model paths,
 * and the Portal provider-availability projection. New Cursor selections
 * require the managed runtime to be supported, enabled, and installed. The
 * renderer hides the option in that state, but a stale picker, a direct IPC
 * caller, or a remote Portal command must not durably persist a model the next
 * send would refuse. A status failure fails closed.
 */
export async function isCursorRuntimeAvailable(): Promise<boolean> {
  try {
    return isAvailableStatus(await refreshCursorRuntimeStatus());
  } catch {
    return false;
  }
}

/** Last observed availability; `undefined` until the first refresh. Never probes. */
export function peekCursorRuntimeAvailability(): boolean | undefined {
  return lastAvailability;
}

/** Re-evaluate and cache availability; returns the fresh value. */
export function refreshCursorRuntimeAvailability(): Promise<boolean> {
  return isCursorRuntimeAvailable();
}

/**
 * Canonical probe for callers that need the full `CursorConnectionStatus`
 * (the status IPC handler), not just the derived boolean — a single probe
 * that also caches availability via the same generation guard as
 * `isCursorRuntimeAvailable()`, so a status IPC call and a concurrent
 * Connect/Disconnect refresh cannot race each other into a stale cached
 * answer — the cache write on failure IS fail-closed. Propagates the probe
 * failure itself exactly as the status IPC handler did before this shared
 * path existed: `assertCursorHarnessEnabled()` failures are meant to reject
 * the call, not resolve it to a fail-closed value the way
 * `isCursorRuntimeAvailable()` does for its callers.
 */
export function probeCursorRuntimeStatus(): Promise<CursorConnectionStatus> {
  return refreshCursorRuntimeStatus();
}
