import { performance } from 'node:perf_hooks';
import {
  takeChatStorageActivity,
  CHAT_STORAGE_ACTIVITY_SCOPE_LIMIT,
  type ChatStorageActivity,
  type ChatStorageActivityWindow,
} from '@canopy/desktop-shared/node/chat-storage-activity';
import { getObservabilityService } from '../observability';
import type {
  AppDiagnosticRecord,
  SessionDiagnosticRecord,
} from '../observability/service';

/**
 * About once a minute, records what canonical chat storage did: one
 * `chat_storage_diagnostic` session event (`activity_summary`) per active scope
 * in `diagnostics/session-events/`, and one `chat_storage_activity_summary`
 * aggregate, with no identifiers, in `diagnostics/app-events/`. A minute
 * without chat-storage work records nothing.
 */

export const CHAT_STORAGE_ACTIVITY_INTERVAL_MS = 60_000;
/** Provisional threshold: calibrate against measured runs, not a storage throttle. */
export const PROVISIONAL_CHAT_TRANSCRIPT_WRITE_RATE_BYTES_PER_SECOND =
  1024 * 1024;
const REQUIRED_RATE_SAMPLES = 3;
// Repeating timers fire on whole milliseconds, so the monotonic clock can
// measure a full window a fraction of a millisecond short.
const MIN_RATE_WINDOW_MS = CHAT_STORAGE_ACTIVITY_INTERVAL_MS * 0.9;
const REQUIRED_RATE_OBSERVED_MS = REQUIRED_RATE_SAMPLES * MIN_RATE_WINDOW_MS;
// A heavily delayed sampler cannot establish continuity across the missing time.
const MAX_RATE_WINDOW_MS = CHAT_STORAGE_ACTIVITY_INTERVAL_MS * 1.5;

interface WriteRateEpisode {
  sampleCount: number;
  observedMs: number;
  warned: boolean;
}

export interface ChatStorageActivityDiagnosticsOptions {
  intervalMs?: number;
  take?: () => ChatStorageActivityWindow | undefined;
  now?: () => number;
  timestamp?: () => string;
  recordSession?: (record: SessionDiagnosticRecord) => void;
  recordApp?: (record: AppDiagnosticRecord) => void;
}

interface ActivityFields {
  chatStorageWindowMs: number;
  chatStorageCommitCount: number;
  chatStorageMutationCount: number;
  chatStorageBytesWritten: number;
  chatStorageFileSyncCount: number;
  chatStorageDirectorySyncCount: number;
  chatStorageCommitMsTotal: number;
  chatStorageCommitMsMax: number;
  chatStorageQueueWaitMsMax: number;
}

function activityFields(
  activity: ChatStorageActivity,
  windowMs: number,
): ActivityFields {
  return {
    chatStorageWindowMs: windowMs,
    chatStorageCommitCount: activity.commits,
    chatStorageMutationCount: activity.mutations,
    chatStorageBytesWritten: activity.bytesWritten,
    chatStorageFileSyncCount: activity.fileSyncs,
    chatStorageDirectorySyncCount: activity.directorySyncs,
    chatStorageCommitMsTotal: activity.commitMsTotal,
    chatStorageCommitMsMax: activity.commitMsMax,
    chatStorageQueueWaitMsMax: activity.queueWaitMsMax,
  };
}

function attempt(record: () => void): void {
  try {
    record();
  } catch {
    // Diagnostics must never disturb chat storage or the sampling timer.
  }
}

/** Starts the summaries; the returned stop can flush the partial window. */
export function startChatStorageActivityDiagnostics(
  options: ChatStorageActivityDiagnosticsOptions = {},
): (stopOptions?: { flush?: boolean }) => void {
  const intervalMs = options.intervalMs ?? CHAT_STORAGE_ACTIVITY_INTERVAL_MS;
  const take = options.take ?? takeChatStorageActivity;
  const now = options.now ?? ((): number => performance.now());
  const timestamp =
    options.timestamp ?? ((): string => new Date().toISOString());
  const recordSession =
    options.recordSession ??
    ((record: SessionDiagnosticRecord): void =>
      getObservabilityService().recordSessionDiagnostic(record));
  const recordApp =
    options.recordApp ??
    ((record: AppDiagnosticRecord): void =>
      getObservabilityService().recordAppDiagnostic(record));

  let windowStartedAt = now();
  const episodes = new Map<string, WriteRateEpisode>();
  const emit = (fullWindow: boolean): void => {
    let window: ChatStorageActivityWindow | undefined;
    try {
      window = take();
    } catch {
      window = undefined;
    }
    const endedAt = now();
    const elapsedMs = endedAt - windowStartedAt;
    const windowMs = Math.max(0, Math.round(elapsedMs));
    windowStartedAt = endedAt;
    const rateWindow =
      fullWindow &&
      Number.isFinite(elapsedMs) &&
      elapsedMs >= MIN_RATE_WINDOW_MS &&
      elapsedMs <= MAX_RATE_WINDOW_MS;
    if (!rateWindow || window === undefined) episodes.clear();
    if (window === undefined) return;
    const at = timestamp();
    if (rateWindow) {
      // Admission is bounded even for an injected/oversized window. Missing or
      // evicted scopes lose their episode; they cannot bridge a quiet window.
      const admitted = window.scopes.slice(
        0,
        CHAT_STORAGE_ACTIVITY_SCOPE_LIMIT,
      );
      const keys = new Set(admitted.map((scope) => scope.scopeKey));
      for (const key of Array.from(episodes.keys()))
        if (!keys.has(key)) episodes.delete(key);
      for (const scope of admitted) {
        const rate = (scope.activity.transcriptBytesWritten * 1000) / elapsedMs;
        if (
          !(rate > PROVISIONAL_CHAT_TRANSCRIPT_WRITE_RATE_BYTES_PER_SECOND) ||
          !Number.isFinite(rate)
        ) {
          episodes.delete(scope.scopeKey);
          continue;
        }
        const episode = episodes.get(scope.scopeKey) ?? {
          sampleCount: 0,
          observedMs: 0,
          warned: false,
        };
        // Counters need only reach the arming boundary; retained values are bounded.
        episode.sampleCount = Math.min(
          REQUIRED_RATE_SAMPLES,
          episode.sampleCount + 1,
        );
        episode.observedMs = Math.min(
          REQUIRED_RATE_OBSERVED_MS + MAX_RATE_WINDOW_MS,
          episode.observedMs + elapsedMs,
        );
        episodes.set(scope.scopeKey, episode);
        if (
          !episode.warned &&
          episode.sampleCount >= REQUIRED_RATE_SAMPLES &&
          episode.observedMs >= REQUIRED_RATE_OBSERVED_MS
        ) {
          episode.warned = true;
          attempt(() =>
            recordApp({
              version: 1,
              timestamp: at,
              kind: 'resource_pressure_warning',
              reason: 'chat_transcript_write_rate',
              chatTranscriptWriteScopeDigest: scope.scopeKey,
              chatTranscriptWriteRateBytesPerSecond: rate,
              chatTranscriptWriteRateThresholdBytesPerSecond:
                PROVISIONAL_CHAT_TRANSCRIPT_WRITE_RATE_BYTES_PER_SECOND,
              chatTranscriptWriteRateObservedMs: episode.observedMs,
              chatTranscriptWriteRateSampleCount: episode.sampleCount,
            }),
          );
        }
      }
    }
    for (const scope of window.scopes) {
      const identity = scope.identity;
      // An unregistered scope still counts in the aggregate below.
      if (identity === undefined) continue;
      attempt(() =>
        recordSession({
          version: 1,
          timestamp: at,
          kind: 'chat_storage_diagnostic',
          sessionKey: `${identity.projectId}/${identity.worktreeId}/`,
          projectId: identity.projectId,
          worktreeId: identity.worktreeId,
          chatId: '',
          providerType: 'unknown',
          chatStorageKind: 'activity_summary',
          chatStorageAuthority: 'v2',
          ...activityFields(scope.activity, windowMs),
        }),
      );
    }
    attempt(() =>
      recordApp({
        version: 1,
        timestamp: at,
        kind: 'chat_storage_activity_summary',
        chatStorageScopeCount: window.scopes.length,
        ...activityFields(window.total, windowMs),
      }),
    );
  };

  const timer = setInterval(() => emit(true), intervalMs);
  timer.unref?.();
  let stopped = false;
  return (stopOptions?: { flush?: boolean }): void => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    if (stopOptions?.flush === true) emit(false);
    episodes.clear();
  };
}
