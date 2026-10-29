import type { SecureStorageFailure } from '@canopy/desktop-shared/types/secure-storage';
import type { GitHubTokenProviderResult } from '@github/copilot-sdk';
import type { CopilotAccount } from '@canopy/desktop-shared/types';
import {
  DeviceFlowRefreshRejectedError,
  type DeviceFlowGrant,
} from '@canopy/desktop-shared/node/copilot/device-flow';
import type { CopilotRuntimeAuth } from '@canopy/desktop-shared/node/copilot/runtime-auth';
import { sameCopilotAccount } from '@canopy/desktop-shared/node/copilot/auth';
import type {
  CopilotCredential,
  CopilotCredentialRead,
} from './credential-store';

export class CopilotSignInExpiredError extends Error {
  constructor() {
    super('Copilot sign-in expired. Reconnect Copilot in Settings.');
    this.name = 'CopilotSignInExpiredError';
  }
}

export class CopilotSignInChangedError extends Error {
  constructor() {
    super(
      'Copilot sign-in changed. Reconnect the account you want to use in Settings.',
    );
    this.name = 'CopilotSignInChangedError';
  }
}

export class CopilotCredentialUnreadableError extends Error {
  constructor(readonly secureStorageFailure?: SecureStorageFailure) {
    super("Couldn't read the Copilot sign-in on this device.");
    this.name = 'CopilotCredentialUnreadableError';
  }
}

export interface CopilotCredentialBrokerDeps {
  /** The account the user confirmed in Settings; absent means never connected. */
  pin: CopilotAccount | undefined;
  read(): Promise<CopilotCredentialRead>;
  save(credential: CopilotCredential): Promise<void>;
  clear(): Promise<void>;
  refresh(refreshToken: string, signal: AbortSignal): Promise<DeviceFlowGrant>;
  now?: () => number;
}

/** Matches the SDK's own preflight: refresh when an hour or less remains. */
export const REFRESH_THRESHOLD_MS = 60 * 60 * 1000;
const PROVIDER_TIMEOUT_MS = 30_000;
const REFRESH_TIMEOUT_MS = 30_000;

/**
 * Resolves with the promise unless the signal aborts first. The promise is
 * always observed, so a refresh that outlives its cancelled caller cannot
 * surface as an unhandled rejection.
 */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      const reason: unknown = signal.reason;
      reject(reason instanceof Error ? reason : new Error(String(reason)));
    };
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
    promise.then(resolve, reject).finally(() => {
      signal.removeEventListener('abort', onAbort);
    });
  });
}

function normalizeHost(host: string): string {
  return host
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/[/?#].*$/, '');
}

const NETWORK_REFRESH_FAILURE =
  "Couldn't refresh the Copilot sign-in. Check your connection and try again.";

export function createCopilotCredentialBroker(
  deps: CopilotCredentialBrokerDeps,
): CopilotRuntimeAuth {
  const now = deps.now ?? Date.now;
  let refreshing: Promise<CopilotCredential> | undefined;
  // GitHub retires a refresh token the moment it rotates. A caller that read
  // the grant before that rotation must be handed the rotated grant instead of
  // presenting the retired token, which would sign the user out. The rotation
  // is remembered before it is written so a failed write cannot lose it.
  let lastRotation:
    | { from: string; to: CopilotCredential; saved: boolean }
    | undefined;

  const load = async (): Promise<CopilotCredential> => {
    const read = await deps.read();
    if (read.status === 'absent') {
      lastRotation = undefined;
      throw new CopilotSignInExpiredError();
    }
    if (read.status === 'unreadable')
      throw new CopilotCredentialUnreadableError(read.secureStorageFailure);
    const { credential } = read;
    if (
      lastRotation &&
      credential.refreshToken !== lastRotation.from &&
      credential.refreshToken !== lastRotation.to.refreshToken
    )
      lastRotation = undefined;
    if (
      !sameCopilotAccount(
        { host: credential.host, login: credential.login },
        deps.pin,
      )
    ) {
      lastRotation = undefined;
      throw new CopilotSignInChangedError();
    }
    return credential;
  };

  /** True while the store still holds the grant this refresh started from. */
  const stillStored = async (current: CopilotCredential): Promise<boolean> => {
    const read = await deps.read();
    if (read.status === 'unreadable')
      throw new CopilotCredentialUnreadableError(read.secureStorageFailure);
    return (
      read.status === 'present' &&
      read.credential.refreshToken === current.refreshToken
    );
  };

  const persist = async (rotation: {
    to: CopilotCredential;
    saved: boolean;
  }): Promise<void> => {
    try {
      await deps.save(rotation.to);
      rotation.saved = true;
    } catch {
      // The grant stays usable from memory; the write is retried on the next
      // call. Losing it would sign the user out for a disk hiccup.
    }
  };

  const refresh = async (
    current: CopilotCredential,
  ): Promise<CopilotCredential> => {
    if (refreshing) return refreshing;
    if (lastRotation?.from === current.refreshToken) {
      if (!lastRotation.saved) await persist(lastRotation);
      return lastRotation.to;
    }
    // GitHub rotates the refresh token on every call; a second concurrent
    // refresh would present a token GitHub has already retired. The request
    // runs on its own deadline so a cancelled caller cannot strand a rotation
    // GitHub has already applied.
    refreshing ??= (async (): Promise<CopilotCredential> => {
      try {
        let grant: DeviceFlowGrant;
        try {
          grant = await deps.refresh(
            current.refreshToken,
            AbortSignal.timeout(REFRESH_TIMEOUT_MS),
          );
        } catch (error) {
          if (error instanceof DeviceFlowRefreshRejectedError) {
            // Disconnect or Change account may have replaced the grant while
            // this refresh was in flight; only the grant we started from is
            // ours to clear.
            if (!(await stillStored(current)))
              throw new CopilotSignInChangedError();
            await deps.clear();
            throw new CopilotSignInExpiredError();
          }
          if (Date.parse(current.accessTokenExpiresAt) > now()) return current;
          throw new Error(NETWORK_REFRESH_FAILURE);
        }
        const rotation = {
          from: current.refreshToken,
          to: { ...current, ...grant },
          saved: false,
        };
        // GitHub has already retired the old grant. Retain this rotation
        // before awaiting storage; unreadability is not an account change.
        lastRotation = rotation;
        if (!(await stillStored(current))) {
          if (lastRotation === rotation) lastRotation = undefined;
          throw new CopilotSignInChangedError();
        }
        await persist(rotation);
        return rotation.to;
      } finally {
        refreshing = undefined;
      }
    })();
    return refreshing;
  };

  const current = async (signal: AbortSignal): Promise<CopilotCredential> => {
    signal.throwIfAborted();
    const credential = await load();
    signal.throwIfAborted();
    const remaining = Date.parse(credential.accessTokenExpiresAt) - now();
    if (remaining > REFRESH_THRESHOLD_MS) return credential;
    return untilAborted(refresh(credential), signal);
  };

  return {
    async token(signal: AbortSignal): Promise<string> {
      return (await current(signal)).accessToken;
    },
    // The SDK's own preflight asks for a refresh when its token nears expiry;
    // the threshold below answers that without forcing a second rotation when
    // another session already rotated the shared grant.
    tokenProvider: async ({ host }): Promise<GitHubTokenProviderResult> => {
      const credential = await current(
        AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
      );
      if (normalizeHost(host) !== normalizeHost(credential.host))
        throw new Error(
          'Copilot asked for a GitHub token for a different host than the connected account. Reconnect Copilot in Settings.',
        );
      const remaining = Date.parse(credential.accessTokenExpiresAt) - now();
      // The SDK rejects a token at or under its own one-hour preflight
      // threshold, so a refresh that failed on the network must surface as
      // that failure here rather than as an opaque SDK validation error.
      if (remaining <= REFRESH_THRESHOLD_MS)
        throw new Error(NETWORK_REFRESH_FAILURE);
      return {
        kind: 'token',
        accessToken: credential.accessToken,
        expiresIn: Math.floor(remaining / 1000),
      };
    },
  };
}
