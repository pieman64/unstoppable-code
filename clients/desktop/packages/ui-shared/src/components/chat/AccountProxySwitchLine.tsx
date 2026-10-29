import { memo, type JSX } from 'react';
import { GlobeIcon } from '../../icons/AppIcons';
import { REPLAY_BLOCK_CLASS } from '../../lib/replay-privacy';

export interface AccountProxySwitchLineProps {
  /** The account that now serves the chat. */
  account: string;
  /** The account that served it before, when known. */
  previousAccount?: string;
  /** The previous account was at a usage limit when the chat moved. */
  previousAtLimit?: boolean;
  dataTestId?: string;
}

function Account({ name }: { readonly name: string }): JSX.Element {
  // Labels are often emails; the title sits on the blocked element, which
  // session replay records no attributes for.
  return (
    <span className={REPLAY_BLOCK_CLASS} title={name}>
      {name}
    </span>
  );
}

/**
 * A quiet transcript line where the account proxy moved the chat to another
 * of its accounts (CAN-4021). Pure display: every host renders the same
 * persisted `account_proxy_switch` block with it.
 */
function AccountProxySwitchLineComponent({
  account,
  previousAccount,
  previousAtLimit = false,
  dataTestId = 'account-proxy-switch-line',
}: AccountProxySwitchLineProps): JSX.Element {
  return (
    <div
      data-testid={dataTestId}
      className="flex items-center gap-3 text-2xs fg-tertiary"
    >
      <span aria-hidden="true" className="h-px flex-1 bg-line-base" />
      <span className="inline-flex min-w-0 items-center gap-1.5">
        <GlobeIcon size={12} aria-hidden className="shrink-0" />
        <span className="min-w-0 truncate">
          {previousAccount !== undefined && previousAtLimit ? (
            <>
              <Account name={previousAccount} /> reached its usage limit.
              Continued on <Account name={account} />.
            </>
          ) : previousAccount !== undefined ? (
            <>
              The account proxy moved this chat from{' '}
              <Account name={previousAccount} /> to <Account name={account} />.
            </>
          ) : (
            <>
              Continued on <Account name={account} />.
            </>
          )}
        </span>
      </span>
      <span aria-hidden="true" className="h-px flex-1 bg-line-base" />
    </div>
  );
}

export const AccountProxySwitchLine = memo(AccountProxySwitchLineComponent);

/**
 * The line for a Portal `account_switch` part, read from its untyped data.
 * Renders nothing without the account it moved to.
 */
export function AccountProxySwitchPart({
  data,
}: {
  readonly data: unknown;
}): JSX.Element | null {
  if (typeof data !== 'object' || data === null) return null;
  const account: unknown = Reflect.get(data, 'account');
  if (typeof account !== 'string') return null;
  const previousAccount: unknown = Reflect.get(data, 'previousAccount');
  return (
    <AccountProxySwitchLine
      account={account}
      {...(typeof previousAccount === 'string' ? { previousAccount } : {})}
      {...(Reflect.get(data, 'previousAtLimit') === true
        ? { previousAtLimit: true }
        : {})}
    />
  );
}
