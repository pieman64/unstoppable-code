import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  McpServerAuthStatus,
  StartMcpOAuthLoginResponse,
} from '@canopy/execution-engine/types/mcp-servers';

/** Cadence of the post-login usability probe. */
export const MCP_AUTH_RECOVERY_POLL_INTERVAL_MS = 2_000;

/**
 * Hard cap on the whole verify phase. A browser login the user abandons must
 * end in a retryable `failed`, never in a spinner that runs forever.
 */
export const MCP_AUTH_RECOVERY_POLL_TIMEOUT_MS = 120_000;

/** The server this hook reconnects, as carried by `recovery.kind === 'mcp_oauth'`. */
export interface McpAuthRecoveryTarget {
  serverId: string;
  configId: string;
}

/**
 * `idle → starting → (awaiting-browser | verifying) → connected | failed`.
 *
 * `awaiting-browser` and `verifying` differ only in whether a browser leg is
 * outstanding: `startOAuthLogin` returning `started` means main opened an
 * authorization URL and the user has work to do, while `completed` means the
 * token was already good and only the usability probe remains. Both poll,
 * because the probe is the ONLY signal that the browser leg finished — there
 * is no completion event to wait on from the renderer.
 */
export type McpAuthRecoveryStatus =
  | 'idle'
  | 'starting'
  | 'awaiting-browser'
  | 'verifying'
  | 'connected'
  | 'failed';

export interface McpAuthRecoveryState {
  status: McpAuthRecoveryStatus;
  /** Authorization URL to click/copy while `awaiting-browser`. */
  authorizationUrl: string | null;
  /** Message from a failed `startOAuthLogin`. Null when the poll simply capped. */
  error: string | null;
  /** True when `failed` was reached by exhausting the poll cap. */
  timedOut: boolean;
}

export interface UseMcpAuthRecoveryResult extends McpAuthRecoveryState {
  /** Begin (or retry) the reconnect. No-op without a target. */
  start: () => void;
  /** Return to `idle`, cancelling any in-flight poll. */
  reset: () => void;
}

const IDLE_STATE: McpAuthRecoveryState = {
  status: 'idle',
  authorizationUrl: null,
  error: null,
  timedOut: false,
};

/**
 * The ONLY auth state that ends the poll successfully.
 *
 * Deliberately an allowlist, not a denylist (CAN-1814 review). `McpServerAuthStatus`
 * has six members and a denylist of the three obviously-bad ones silently
 * promoted `unsupported` and `not_configured` to success. Because the first
 * poll tick fires immediately on entering `awaiting-browser` — before the user
 * has touched the browser — a config reporting either would have rendered the
 * green "is reconnected" card at once, for a server that was never connected.
 *
 * The pessimistic direction is already bounded: an allowlist that never matches
 * ends at {@link MCP_AUTH_RECOVERY_POLL_TIMEOUT_MS} with a retryable `failed`,
 * which is an honest outcome. A false success is not recoverable in the same
 * way — the user re-sends the turn and it fails again.
 */
function isUsableAuthStatus(status: McpServerAuthStatus): boolean {
  return status === 'connected';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * One probe of a SINGLE server: the same `checkHealth` → `listStatus` pair
 * `useMcpServerStatuses` drives, minus its sweep. Connection status is derived
 * in main and not persisted, so `checkHealth` is what refreshes the cache and
 * `listStatus` is what reads the derived, handler-aware result.
 *
 * Deliberately total: any transport failure reads as "not usable yet" so a
 * transient error extends the poll instead of ending it.
 */
export async function probeMcpServerUsable(
  target: McpAuthRecoveryTarget,
): Promise<boolean> {
  try {
    await window.mcpServers.checkHealth(target.serverId, target.configId);
  } catch {
    // Best-effort probe; main still records the failure in its status cache.
  }
  try {
    const entries = await window.mcpServers.listStatus();
    const entry = entries.find((item) => item.serverId === target.serverId);
    if (!entry) {
      return false;
    }
    const config = entry.configs.find(
      (item) => item.configId === target.configId,
    );
    if (!config) {
      // No per-config auth axis for this config (e.g. a server whose configs
      // changed under us): fall back to the server-level verdict.
      return entry.connectionStatus === 'connected';
    }
    return isUsableAuthStatus(config.authStatus);
  } catch {
    return false;
  }
}

/**
 * Drives the inline MCP reconnect behind `AuthRecoveryCard`, reusing the
 * existing OAuth entry point (`mcp-servers:start-oauth-login`, the same call
 * the MCP server editor's Connect button makes) rather than introducing a second
 * login flow (CAN-1814).
 */
export function useMcpAuthRecovery(
  target: McpAuthRecoveryTarget | null,
): UseMcpAuthRecoveryResult {
  const [state, setState] = useState<McpAuthRecoveryState>(IDLE_STATE);
  // Monotonic run id: incremented by every start/reset/unmount so a late
  // resolution from a superseded attempt can never write state.
  const runIdRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const targetRef = useRef<McpAuthRecoveryTarget | null>(target);
  targetRef.current = target;

  const clearTimer = useCallback((): void => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  useEffect((): (() => void) => {
    return (): void => {
      runIdRef.current += 1;
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, []);

  const reset = useCallback((): void => {
    runIdRef.current += 1;
    clearTimer();
    setState(IDLE_STATE);
  }, [clearTimer]);

  // A poll in flight belongs to the target `start` captured, but the card
  // renders its copy from the CURRENT failure prop — so a target swap mid-poll
  // would resolve server A's `connected` into "**B** is reconnected"
  // (CAN-1814 review). Keyed on the ID STRINGS, never on the target object:
  // callers build it inline from `recovery`, so it is a fresh object on every
  // render and an object-keyed effect would reset forever.
  useEffect((): void => {
    reset();
  }, [reset, target?.serverId, target?.configId]);

  // Observe cached credentials on mount, return to the app, and auth changes.
  // Passive recovery must never open OAuth or contact a remote server.
  useEffect(() => {
    const current = targetRef.current;
    if (!current) return;
    let cancelled = false;
    let version = 0;
    let expiryTimer: ReturnType<typeof setTimeout> | undefined;
    const refresh = async (): Promise<void> => {
      const readVersion = ++version;
      const runId = runIdRef.current;
      try {
        const entries = await window.mcpServers.listStatus();
        if (cancelled || readVersion !== version || runId !== runIdRef.current)
          return;
        const config = entries
          .find((entry) => entry.serverId === current.serverId)
          ?.configs.find((entry) => entry.configId === current.configId);
        const expiresAt = config?.expiresAt
          ? Date.parse(config.expiresAt)
          : NaN;
        const connected =
          config?.authStatus === 'connected' &&
          (!Number.isFinite(expiresAt) || expiresAt > Date.now());
        clearTimeout(expiryTimer);
        if (connected && Number.isFinite(expiresAt)) {
          expiryTimer = setTimeout(
            () => {
              void refresh();
            },
            Math.min(2_147_483_647, Math.max(1, expiresAt - Date.now())),
          );
        }
        setState((previous) => {
          // The explicit login owns its health verification until it settles.
          if (
            ['starting', 'awaiting-browser', 'verifying'].includes(
              previous.status,
            )
          )
            return previous;
          if (connected) return { ...IDLE_STATE, status: 'connected' };
          return previous.status === 'connected' ? IDLE_STATE : previous;
        });
      } catch {
        // An unavailable cache is not evidence of a disconnected account.
      }
    };
    const onRefresh = (): void => {
      void refresh();
    };
    onRefresh();
    const unsubscribe = window.mcpServers?.onAuthChanged?.(onRefresh);
    window.addEventListener('focus', onRefresh);
    return (): void => {
      cancelled = true;
      clearTimeout(expiryTimer);
      unsubscribe?.();
      window.removeEventListener('focus', onRefresh);
    };
  }, [target?.serverId, target?.configId]);

  const start = useCallback((): void => {
    const current = targetRef.current;
    if (!current) {
      return;
    }
    runIdRef.current += 1;
    const runId = runIdRef.current;
    clearTimer();
    setState({
      status: 'starting',
      authorizationUrl: null,
      error: null,
      timedOut: false,
    });

    const isCurrent = (): boolean => runIdRef.current === runId;

    const pollUntilUsable = (deadline: number): void => {
      const tick = async (): Promise<void> => {
        if (!isCurrent()) return;
        const usable = await probeMcpServerUsable(current);
        if (!isCurrent()) return;
        if (usable) {
          setState({
            status: 'connected',
            authorizationUrl: null,
            error: null,
            timedOut: false,
          });
          return;
        }
        if (Date.now() >= deadline) {
          setState((previous) => ({
            status: 'failed',
            authorizationUrl: previous.authorizationUrl,
            error: null,
            timedOut: true,
          }));
          return;
        }
        timerRef.current = setTimeout((): void => {
          timerRef.current = null;
          void tick();
        }, MCP_AUTH_RECOVERY_POLL_INTERVAL_MS);
      };
      void tick();
    };

    void (async (): Promise<void> => {
      let response: StartMcpOAuthLoginResponse;
      try {
        response = await window.mcpServers.startOAuthLogin({
          serverId: current.serverId,
          configId: current.configId,
        });
      } catch (error) {
        if (!isCurrent()) return;
        setState({
          status: 'failed',
          authorizationUrl: null,
          error: errorMessage(error),
          timedOut: false,
        });
        return;
      }
      if (!isCurrent()) return;
      const started = response.status === 'started';
      setState({
        status: started ? 'awaiting-browser' : 'verifying',
        authorizationUrl: started ? (response.authorizationUrl ?? null) : null,
        error: null,
        timedOut: false,
      });
      pollUntilUsable(Date.now() + MCP_AUTH_RECOVERY_POLL_TIMEOUT_MS);
    })();
  }, [clearTimer]);

  return { ...state, start, reset };
}
