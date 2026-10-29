import type { JSX } from 'react';
import { POSTHOG_REPLAY_BLOCK_CLASS } from '@canopy/desktop-instrumentation/posthog-replay-privacy';
import type { AccountProxyErrorCode } from '@canopy/desktop-shared/types/account-proxy';
import { accountProxyErrorMessage } from './accountProxyCopy';

/** Stands in for the host while the message is split around it. */
const HOST_SLOT = '\u0000host\u0000';

/**
 * An account proxy error, with the server host, when the message names it,
 * kept out of session replay like everywhere else the host appears.
 */
export function AccountProxyErrorMessage({
  code,
  host,
  version,
}: {
  readonly code: AccountProxyErrorCode;
  readonly host?: string | null;
  readonly version?: string;
}): JSX.Element {
  if (!host) return <>{accountProxyErrorMessage(code, { version })}</>;
  const parts = accountProxyErrorMessage(code, {
    host: HOST_SLOT,
    version,
  }).split(HOST_SLOT);
  return (
    <>
      {parts.map((part, index) => (
        <span key={index}>
          {index > 0 ? (
            <span className={POSTHOG_REPLAY_BLOCK_CLASS}>{host}</span>
          ) : null}
          {part}
        </span>
      ))}
    </>
  );
}
