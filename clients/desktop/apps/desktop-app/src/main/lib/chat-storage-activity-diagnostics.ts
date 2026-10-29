import { performance } from 'node:perf_hooks';
import {
  takeChatStorageActivity,
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
  const emit = (): void => {
    let window: ChatStorageActivityWindow | undefined;
    try {
      window = take();
    } catch {
      window = undefined;
    }
    const endedAt = now();
    const windowMs = Math.max(0, Math.round(endedAt - windowStartedAt));
    windowStartedAt = endedAt;
    if (window === undefined) return;
    const at = timestamp();
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

  const timer = setInterval(emit, intervalMs);
  timer.unref?.();
  let stopped = false;
  return (stopOptions?: { flush?: boolean }): void => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    if (stopOptions?.flush === true) emit();
  };
}
