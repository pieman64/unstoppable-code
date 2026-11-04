import type { JSX, ReactNode } from 'react';
import { CheckIcon } from '../icons/AppIcons';
import { Disclosure } from './Disclosure';
import { Notice } from './Notice';

/** Statuses that read as a working connection and carry the check. */
const SIGNED_IN_STATUSES = new Set(['Connected', 'Signed in']);

/** One account connection is reused by every supported in-app harness. */
interface PluginAccountConnectionProps {
  status: string;
  /** Marks the status as a working connection; defaults by the status text. */
  connected?: boolean;
  /** Omit when the status needs no explanation and offers no action. */
  description?: string;
  actions?: ReactNode;
  children?: ReactNode;
  availability?: ReactNode;
  /** `4` inside a titled route, so the card's heading nests under the route's. */
  headingLevel?: 3 | 4;
}

export function PluginAccountConnection({
  status,
  connected = SIGNED_IN_STATUSES.has(status),
  description,
  actions,
  children,
  availability,
  headingLevel = 3,
}: PluginAccountConnectionProps): JSX.Element {
  const HeadingTag = headingLevel === 4 ? 'h4' : 'h3';
  return (
    <div className="min-w-0 space-y-5">
      <section
        data-testid="plugin-account-connection"
        className="min-w-0 space-y-3 rounded-lg ring-[length:var(--border-hairline)] ring-line-base bg-secondary/30 px-4 py-3"
      >
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0 flex-1 space-y-1">
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <HeadingTag className="text-s font-medium fg-primary">
                Connection
              </HeadingTag>
              <p
                className="inline-flex items-center gap-1.5 text-xs fg-secondary"
                aria-live="polite"
              >
                {connected && (
                  <CheckIcon
                    size={14}
                    className="fg-success"
                    aria-hidden="true"
                  />
                )}
                {status}
              </p>
            </div>
            {description && (
              <p className="max-w-2xl text-pretty text-xs fg-secondary">
                {description}
              </p>
            )}
          </div>
          {actions && (
            <div className="flex shrink-0 flex-wrap items-center gap-2">
              {actions}
            </div>
          )}
        </div>
        {children}
      </section>
      {availability}
    </div>
  );
}

/** Keep transport diagnostics available without making them the recovery UI. */
interface PluginConnectionNoticeProps {
  error: string;
  guidance?: string;
  checkingStatus?: boolean;
}

export function PluginConnectionNotice({
  error,
  guidance,
  checkingStatus = false,
}: PluginConnectionNoticeProps): JSX.Element {
  const untrusted = error.includes('endpoints are not trusted');
  const title = checkingStatus
    ? 'Connection status unavailable'
    : untrusted
      ? 'Sign-in unavailable'
      : 'Couldn’t connect';
  const message =
    guidance ??
    (checkingStatus
      ? 'Reopen this plugin to check its connection again.'
      : untrusted
        ? 'Sign-in setup couldn’t be verified. Update the plugin or contact its publisher.'
        : 'Sign-in didn’t finish. Try connecting again.');
  return (
    <Notice
      intent="destructive"
      title={title}
      detail={
        !guidance ? (
          <Disclosure
            label="Technical details"
            dataTestId="plugin-connection-technical-details"
            className="mt-2"
          >
            <p className="whitespace-pre-wrap break-words font-mono">{error}</p>
          </Disclosure>
        ) : undefined
      }
    >
      {message}
    </Notice>
  );
}
