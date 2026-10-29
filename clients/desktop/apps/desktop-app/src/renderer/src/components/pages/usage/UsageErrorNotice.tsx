/* eslint-disable react-refresh/only-export-components -- desktop adapter and
   compatibility exports for the shared usage notice and retry contract. */
import type { JSX } from 'react';
import type { ProviderUsageErrorInfo } from '@canopy/desktop-shared/types';
import {
  classifyUsageFetchErrorMessage,
  usageFetchErrorHeadline,
} from '@canopy/desktop-shared/lib/usage-fetch-error';
import {
  UsageErrorNotice as SharedUsageErrorNotice,
  type UsageErrorNoticeProps as SharedUsageErrorNoticeProps,
} from '@canopy/ui-shared/components';
import { formatUsageLimitTimeLabel } from '@/lib/usage-limit-time-label';

export {
  parseUsageRetryAt,
  useUsageRetryWait,
} from '@canopy/ui-shared/components';

/**
 * Resolve the structured error info for a usage surface, falling back to
 * string classification for legacy summaries that only carry the raw
 * `error` message. In the fallback the raw text becomes the collapsed
 * diagnostics detail, never the headline.
 */
export function resolveUsageErrorInfo(
  errorInfo: ProviderUsageErrorInfo | undefined,
  error: string | undefined,
): ProviderUsageErrorInfo | null {
  if (errorInfo) {
    return errorInfo;
  }
  if (error) {
    return { kind: classifyUsageFetchErrorMessage(error), detail: error };
  }
  return null;
}

type UsageErrorNoticeProps = Omit<
  SharedUsageErrorNoticeProps,
  'defaultHeadline' | 'formatRetryTimeLabel'
>;

/** Adapts the desktop error contract to the shared, browser-safe notice. */
export function UsageErrorNotice(props: UsageErrorNoticeProps): JSX.Element {
  return (
    <SharedUsageErrorNotice
      {...props}
      defaultHeadline={usageFetchErrorHeadline(props.info.kind, props.label)}
      formatRetryTimeLabel={formatUsageLimitTimeLabel}
    />
  );
}
