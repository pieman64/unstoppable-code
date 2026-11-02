import type { JSX } from 'react';
import { WarningIcon, CloseIcon, TimeslotIcon } from '../icons/AppIcons';
import { HAIRLINE_INSET_RING_CLASS } from '../lib/row-chips';
import { Notice, type NoticeProps } from './Notice';

export interface UsageLimitNoticeProps extends Omit<
  NoticeProps,
  'title' | 'intent'
> {
  readonly provider: 'claude' | 'codex';
  readonly 'data-testid'?: string;
  /** Preserve the compact warning presentation where it is already in use. */
  readonly appearance?: 'standard' | 'compact';
  /**
   * A credits purchase is open in the browser (CAN-5160). The step replaces
   * the limit the user already acted on, in the neutral checkout treatment
   * every purchase path shares; only a failed check is a warning again. The
   * same element stays mounted, so the host's purchase controls keep their
   * state. Standard appearance only.
   */
  readonly purchaseStep?: { readonly title: string; readonly failed: boolean };
}

/**
 * Shared provider-limit presentation. Hosts supply their available recovery
 * actions and detail; billing, scheduling and dismissal state stay with them.
 * The compact appearance retains its existing geometry during consolidation.
 */
export function UsageLimitNotice({
  provider,
  appearance = 'standard',
  children,
  detail,
  actions,
  onDismiss,
  dismissLabel = 'Dismiss usage limit banner',
  dismissTestId,
  className = '',
  purchaseStep,
  ...props
}: UsageLimitNoticeProps): JSX.Element {
  const title = `${provider === 'codex' ? 'Codex' : 'Claude'} usage limit reached`;
  if (appearance === 'standard') {
    const waiting = purchaseStep !== undefined && !purchaseStep.failed;
    return (
      <Notice
        {...props}
        intent={waiting ? 'neutral' : 'attention'}
        {...(waiting
          ? { icon: <TimeslotIcon size={16} aria-hidden="true" /> }
          : {})}
        title={purchaseStep?.title ?? title}
        detail={detail}
        actions={actions}
        onDismiss={onDismiss}
        dismissLabel={dismissLabel}
        dismissTestId={dismissTestId}
        className={className}
      >
        {children}
      </Notice>
    );
  }
  return (
    <div
      role="status"
      aria-live="polite"
      data-testid={props['data-testid']}
      className={`mb-1.5 flex items-start gap-2 rounded-lg bg-warning-subtle px-3 py-2 text-xs fg-warning ${HAIRLINE_INSET_RING_CLASS} ring-line-attention/40 ${className}`}
    >
      <WarningIcon
        aria-hidden="true"
        width="14"
        height="14"
        className="mt-0.5 shrink-0"
      />
      <span className="flex-1 leading-relaxed">
        {title}. {children}
        {detail !== undefined ? <span className="block">{detail}</span> : null}
      </span>
      {actions}
      {onDismiss ? (
        <button
          type="button"
          onClick={onDismiss}
          aria-label={dismissLabel}
          data-testid={dismissTestId}
          className="focus-ring shrink-0 rounded-md p-1 transition-colors hover:bg-warning-subtle"
        >
          <CloseIcon aria-hidden="true" width="14" height="14" />
        </button>
      ) : null}
    </div>
  );
}
