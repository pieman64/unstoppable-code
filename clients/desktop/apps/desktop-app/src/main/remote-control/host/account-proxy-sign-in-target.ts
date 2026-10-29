import type { AccountProxyRemoteSignInTarget } from '../../account-proxy/remote-sign-in';
import {
  REMOTE_METHODS,
  isUnknownRemoteMethodError,
  type AccountProxySignInOpenParams,
} from '../remote-protocol';

/** The part of a host session an account proxy sign-in uses. */
export interface AccountProxySignInSession {
  openAccountProxySignIn(params: AccountProxySignInOpenParams): Promise<void>;
  endAccountProxySignIn(state: string): void;
  onClosed(listener: () => void): () => void;
}

/**
 * The controller behind a remote window, as the account proxy service sees
 * it. `session` is null when that controller's session is already gone.
 * A controller released before remote sign-in answers that it does not serve
 * the request; the user is then told how to add the account instead.
 */
export function accountProxyRemoteSignInTarget(options: {
  readonly controllerDeviceId: string;
  readonly session: AccountProxySignInSession | null;
  readonly outdatedControllerMessage: string;
}): AccountProxyRemoteSignInTarget {
  const { session } = options;
  return {
    controllerDeviceId: options.controllerDeviceId,
    open: async (page): Promise<void> => {
      if (!session) {
        throw new Error('The connection to the other computer closed.');
      }
      try {
        await session.openAccountProxySignIn(page);
      } catch (error) {
        if (
          isUnknownRemoteMethodError(
            error,
            REMOTE_METHODS.accountProxySignInOpen,
          )
        ) {
          throw new Error(options.outdatedControllerMessage);
        }
        throw error;
      }
    },
    end: (state: string): void => session?.endAccountProxySignIn(state),
    onClosed: (listener: () => void): (() => void) => {
      if (session) return session.onClosed(listener);
      listener();
      return () => undefined;
    },
  };
}
