import { useEffect, useState } from 'react';
import type { LinearStatus } from '@canopy/desktop-shared/types';
import {
  LINEAR_CONNECTION_CHANGED_EVENT,
  subscribeToConnectionChange,
} from '@/lib/integrationConnectionEvents';

let cache: LinearStatus | null = null;
let cachedToken: string | null = null;
let pending: Promise<LinearStatus> | null = null;
let pendingToken: string | null = null;

function fetchAndCache(token: string): Promise<LinearStatus> {
  const p = window.api
    .validateLinearToken(token)
    .then((s: LinearStatus) => {
      if (pending === p && pendingToken === token) {
        cache = s;
        cachedToken = token;
        pending = null;
        pendingToken = null;
      }
      return s;
    })
    .catch((): LinearStatus => {
      const fallback: LinearStatus = {
        authenticated: false,
        displayName: null,
        error: 'Failed to validate token.',
      };
      if (pending === p && pendingToken === token) {
        cache = fallback;
        cachedToken = token;
        pending = null;
        pendingToken = null;
      }
      return fallback;
    });
  pending = p;
  pendingToken = token;
  return p;
}

export function invalidateLinearStatusCache(): void {
  cache = null;
  cachedToken = null;
  pending = null;
  pendingToken = null;
}

export function useLinearStatus(token: string): LinearStatus | null {
  const [status, setStatus] = useState<LinearStatus | null>(
    cachedToken === token ? cache : null,
  );

  useEffect(() => {
    let cancelled = false;
    const safeSetStatus = (value: LinearStatus | null): void => {
      if (!cancelled) {
        setStatus(value);
      }
    };

    if (!token) {
      safeSetStatus(null);
      return (): void => {
        cancelled = true;
      };
    }
    if (cache && cachedToken === token) {
      safeSetStatus(cache);
      return (): void => {
        cancelled = true;
      };
    }
    safeSetStatus(null);

    if (!pending || pendingToken !== token) {
      fetchAndCache(token).then(safeSetStatus, () => {});
    } else {
      void pending.then(safeSetStatus, () => {});
    }
    return (): void => {
      cancelled = true;
    };
  }, [token]);

  return status;
}

/**
 * Whether Linear is usable right now — the one place any Linear-gated surface
 * should ask, instead of re-implementing the "load the persisted token, then
 * validate it" dance locally.
 *
 * The persisted key is re-read on `LINEAR_CONNECTION_CHANGED_EVENT` as well as
 * at mount. Without that, long-lived surfaces (the Home branch picker and the
 * composer `+` menu both sit inside page trees that stay mounted while the
 * Settings overlay is open) keep serving their mount-time snapshot and go on
 * telling the user to connect a key they already connected.
 */
export function useLinearAvailability(): {
  status: LinearStatus | null;
  available: boolean;
  /**
   * False until the persisted-token read resolves. `status === null` alone
   * cannot distinguish "still loading" from "no token saved" — with no token
   * the status stays null forever — so status-chip surfaces (the CAN-788
   * checklist provider rows) need this to avoid presenting either a
   * permanent "Checking" or a premature "Not connected".
   */
  tokenLoaded: boolean;
  /** A non-empty persisted token exists (it may still fail validation). */
  tokenPresent: boolean;
} {
  const [tokenState, setTokenState] = useState<{
    loaded: boolean;
    token: string;
  }>({ loaded: false, token: '' });

  useEffect(() => {
    let cancelled = false;
    let reloadSequence = 0;
    const reload = (): void => {
      const sequence = ++reloadSequence;
      window.api
        .loadLinearToken()
        .then((next) => {
          if (!cancelled && sequence === reloadSequence) {
            setTokenState({
              loaded: true,
              token: typeof next === 'string' ? next : '',
            });
          }
        })
        .catch(() => {
          // Leave the token empty so Linear stays disabled. IPC can fail on
          // decryption/safeStorage errors, and an unhandled rejection here
          // would surface as a renderer error. The read still counts as
          // resolved so consumers stop reporting a loading state.
          if (!cancelled && sequence === reloadSequence) {
            setTokenState({ loaded: true, token: '' });
          }
        });
    };
    reload();
    const unsubscribe = subscribeToConnectionChange(
      LINEAR_CONNECTION_CHANGED_EVENT,
      reload,
    );
    return (): void => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  const status = useLinearStatus(tokenState.token);
  return {
    status,
    available: status?.authenticated === true,
    tokenLoaded: tokenState.loaded,
    tokenPresent: tokenState.token.length > 0,
  };
}
