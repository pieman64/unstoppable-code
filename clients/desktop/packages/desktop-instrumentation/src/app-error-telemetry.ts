import {
  AppErrorSchema,
  AppErrorSurfaceSchema,
  type AppErrorRecord,
} from '@canopy/protocol/app-errors';
import {
  sanitizeDatadogInstrumentationContext,
  sanitizeInstrumentationContext,
} from './privacy';
import type { DesktopInstrumentationContext } from './types';

export const APP_ERROR_POSTHOG_EVENT = 'app:operation_fail';

/** Host adapters supply SDK accessors, never caller context or identity URLs. */
export interface AppErrorTelemetrySessions {
  datadog?: { getSessionId(): unknown };
  posthog?: {
    getSessionId(): unknown;
    isRecording(): unknown;
    getReplayUrl(): unknown;
  };
}

function read(getter: () => unknown): unknown {
  try {
    return getter();
  } catch {
    return undefined;
  }
}

function sessionId(value: unknown): string | undefined {
  return typeof value === 'string' &&
    value.length === 36 &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      value,
    )
    ? value
    : undefined;
}

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

/** Error records alone permit validated cross-provider session links. */
export function buildAppErrorPostHogProperties(
  record: AppErrorRecord,
  sessions: AppErrorTelemetrySessions = {},
): DesktopInstrumentationContext {
  const properties = sanitizeInstrumentationContext(metadata(record)) ?? {};
  const id = sessionId(read(() => sessions.datadog?.getSessionId()));
  return {
    ...properties,
    ...(id === undefined ? {} : { datadog_session_id: id }),
  };
}

export function buildAppErrorDatadogContext(
  record: AppErrorRecord,
  sessions: AppErrorTelemetrySessions = {},
): DesktopInstrumentationContext {
  const context = sanitizeDatadogInstrumentationContext(metadata(record)) ?? {};
  const id = sessionId(read(() => sessions.posthog?.getSessionId()));
  if (!id) return context;
  const result: DesktopInstrumentationContext = {
    ...context,
    posthog_session_id: id,
  };
  if (read(() => sessions.posthog?.isRecording()) !== true) return result;
  const replay = read(() => sessions.posthog?.getReplayUrl());
  if (typeof replay !== 'string' || replay.length > 2048) return result;
  try {
    const url = new URL(replay);
    // SDK links may point at a configured/self-hosted PostHog origin, and name
    // the project by its public token. Accept only a credential-free HTTPS
    // replay path for this exact SDK session.
    if (
      url.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      new RegExp(`^/project/[a-z0-9_-]+/replay/${id}/?$`, 'i').test(
        url.pathname,
      )
    ) {
      result.posthog_replay_url = url.href;
    }
  } catch {
    // Missing or malformed SDK identities do not interrupt error capture.
  }
  return result;
}

export function buildAppErrorDatadogError(record: AppErrorRecord): Error {
  metadata(record);
  const external = record.error.kind === 'external';
  const error = new Error(
    external ? record.error.code : record.error.detail.message,
  );
  error.name = external
    ? 'AppExternalFailure'
    : (record.error.detail.name ?? 'Error');
  // Never attribute this builder's stack to the original failure.
  error.stack = external ? '' : (record.error.detail.stack ?? '');
  return error;
}
