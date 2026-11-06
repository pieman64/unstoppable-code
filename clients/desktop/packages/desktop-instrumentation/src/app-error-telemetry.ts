import {
  AppErrorSchema,
  AppErrorSurfaceSchema,
  type AppErrorRecord,
} from '@canopy/protocol/app-errors';
import { sanitizeInstrumentationContext } from './privacy';
import type { DesktopInstrumentationContext } from './types';

export const APP_ERROR_POSTHOG_EVENT = 'app:operation_fail';

function metadata(record: AppErrorRecord): DesktopInstrumentationContext {
  const error = AppErrorSchema.parse(record.error);
  if (
    error.kind === 'input' ||
    record.disposition !== (error.kind === 'defect' ? 'recorded' : 'counted')
  )
    throw new TypeError('Only recorded or counted failures have telemetry');
  if (
    !Number.isSafeInteger(record.occurrenceCount) ||
    record.occurrenceCount < 1 ||
    typeof record.isRepeatSummary !== 'boolean' ||
    typeof record.retryFixed !== 'boolean'
  )
    throw new TypeError('Invalid error record counts or flags');
  if (
    !/^[a-zA-Z0-9][a-zA-Z0-9._+-]{0,127}$/.test(record.appVersion) ||
    record.appVersion !== record.appVersion.trim()
  )
    throw new TypeError('Invalid app version');
  const surface =
    record.surface === undefined
      ? undefined
      : AppErrorSurfaceSchema.parse(record.surface);
  return {
    error_kind: error.kind,
    error_code: error.code,
    error_reference_id: error.referenceId,
    ...(surface === undefined ? {} : { error_surface: surface }),
    ...(error.recovery === undefined ? {} : { recovery_kind: error.recovery }),
    error_repeat_count: record.occurrenceCount,
    is_repeat_summary: record.isRepeatSummary,
    is_retry_fixed: record.retryFixed,
    app_version: record.appVersion,
  };
}

export function buildAppErrorPostHogProperties(
  record: AppErrorRecord,
): DesktopInstrumentationContext {
  return sanitizeInstrumentationContext(metadata(record)) ?? {};
}
