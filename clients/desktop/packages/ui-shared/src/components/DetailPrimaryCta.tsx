import type { JSX } from 'react';
import { ChatIcon } from '../icons/AppIcons';
import { ExecutionActionButton } from './ExecutionActionButton';

/** Resolved by `resolveDetailPrimaryCta` in `@canopy/protocol/try-it`. */
export type DetailPrimaryCtaState = 'try' | 'install' | 'pending';

export const DETAIL_PRIMARY_CTA_TEST_ID = 'detail-primary-cta';

export interface DetailPrimaryCtaProps {
  state: DetailPrimaryCtaState;
  /** Display name appended to the accessible label after the visible text. */
  subjectName?: string;
  onTry: () => void;
  /** The host's existing Add/connect flow. */
  onInstall: () => void;
  /** An activation is in flight; activation stays disabled until it settles. */
  busy?: boolean;
  disabled?: boolean;
  /** Busy copy for Install, typically the host's existing in-progress label. */
  installBusyLabel?: string;
  /** Visible Install label, for hosts whose flow is named Add or Connect. */
  installLabel?: string;
}

export const DETAIL_PRIMARY_CTA_TRY_LABEL = 'Try it';
export const DETAIL_PRIMARY_CTA_TRY_BUSY_LABEL = 'Opening chat…';
const TRY_LABEL = DETAIL_PRIMARY_CTA_TRY_LABEL;
const TRY_BUSY_LABEL = DETAIL_PRIMARY_CTA_TRY_BUSY_LABEL;

/**
 * The single accent action in a capability detail header, beside Share.
 * Pure display: the host resolves `state`, owns the launch, and reports
 * errors and navigation.
 */
export function DetailPrimaryCta({
  state,
  subjectName,
  onTry,
  onInstall,
  busy = false,
  disabled = false,
  installBusyLabel,
  installLabel = 'Install',
}: DetailPrimaryCtaProps): JSX.Element {
  const installing = state === 'install';
  const label = busy
    ? installing
      ? (installBusyLabel ?? installLabel)
      : TRY_BUSY_LABEL
    : installing
      ? installLabel
      : TRY_LABEL;
  const subject = subjectName?.trim();
  return (
    <ExecutionActionButton
      label={label}
      ariaLabel={
        subject ? `${label} ${installing ? subject : `with ${subject}`}` : label
      }
      icon={installing ? undefined : <ChatIcon aria-hidden="true" />}
      variant="primary"
      placement="detail"
      disabled={disabled || busy || state === 'pending'}
      onClick={installing ? onInstall : onTry}
      dataTestId={DETAIL_PRIMARY_CTA_TEST_ID}
      dataState={busy ? 'busy' : state}
      stopKeyDownPropagation={false}
    />
  );
}
