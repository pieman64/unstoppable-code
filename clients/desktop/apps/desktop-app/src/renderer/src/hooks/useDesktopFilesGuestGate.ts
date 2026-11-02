import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ATTACHMENT_SIGN_IN_COPY } from '@canopy/ui-app/guest-files';
import { useTryItAccount } from './useCanopyCloudConnected';
import { useCloudConnectGateStore } from '@/stores/cloudConnectGateStore';

export interface DesktopFilesGuestGate {
  readonly status: 'loading' | 'guest' | 'signed-in';
  readonly accountId: string | null;
  readonly scope: string | undefined;
  readonly onSignIn: () => void;
  readonly interceptAttachment: () => boolean;
  /** Keeps an old picker/import canceled through sign-out and sign-in or a scope switch. */
  readonly captureAccess: () => () => boolean;
}

/** Host authentication stays in the existing singleton gate; files are never retained. */
export function useDesktopFilesGuestGate(
  scope?: string,
): DesktopFilesGuestGate {
  const account = useTryItAccount();
  const [settledAccount, setSettledAccount] = useState(account);
  if (
    account.status !== 'loading' &&
    (account.status !== settledAccount.status ||
      account.accountId !== settledAccount.accountId)
  ) {
    setSettledAccount(account);
  }
  // Routine account refreshes briefly report loading. Keep the confirmed
  // identity so they neither cancel a picker nor ask a signed-in user to sign in.
  const { status, accountId } =
    account.status === 'loading' ? settledAccount : account;
  const activation = useRef({ status, accountId, scope });
  useLayoutEffect(() => {
    const current = { status, accountId, scope };
    activation.current = current;
    return (): void => {
      // Invalidate on unmount as well as account/scope changes.
      if (activation.current === current)
        activation.current = { ...current, status: 'loading' };
    };
  }, [status, accountId, scope]);
  const onSignIn = useCallback((): void => {
    useCloudConnectGateStore.getState().requestConnect(
      {
        title: ATTACHMENT_SIGN_IN_COPY.title,
        description: ATTACHMENT_SIGN_IN_COPY.body,
        subtitle: null,
      },
      (): void => undefined,
    );
  }, []);
  const interceptAttachment = useCallback((): boolean => {
    if (activation.current.status === 'signed-in') return false;
    if (activation.current.status === 'guest') onSignIn();
    return true;
  }, [onSignIn]);
  const captureAccess = useCallback((): (() => boolean) => {
    const current = activation.current;
    return (): boolean =>
      current.status === 'signed-in' && activation.current === current;
  }, []);
  return useMemo(
    () => ({
      status,
      accountId,
      scope,
      onSignIn,
      interceptAttachment,
      captureAccess,
    }),
    [status, accountId, scope, onSignIn, interceptAttachment, captureAccess],
  );
}
