/** Local watcher state. Commands and output are private to the owning scope. */
export type LocalWatcherTarget =
  | { kind: 'scheduled_wakeup'; delaySeconds: number; scheduledFor: string }
  | {
      kind: 'command_watch';
      command: string;
      cwd: string;
      intervalSeconds: number;
      maxAttempts: number;
    };

export type WatcherCommandOutput = {
  byteSize: number;
  lineCount: number;
  complete: boolean;
} & (
  | { kind: 'inline'; text: string }
  | { kind: 'file'; path: string; scriptId?: string }
);

export interface LocalWatcherEvent {
  type: 'local_watcher_resolved';
  outcome: 'success' | 'failure';
  reason: string;
  attempts: number;
  completedAt: string;
  exitCode?: number | null;
  signal?: string | null;
  output?: WatcherCommandOutput;
}

export interface LocalWatcherRuntimeState {
  kind: 'local_watcher';
  attempts: number;
  nextAttemptAt: string;
  /**
   * Durable transaction marker. Scope deletion keeps the watcher row inert
   * until commit; startup clears an interrupted marker before scheduling.
   */
  cancellationPending?: {
    previousStatus: 'active' | 'firing';
    scope?: { projectId: string; worktreeId: string; createdAt?: string };
  };
  /** Persisted before spawning; a restart never refunds this attempt. */
  running?: boolean;
  pendingDelivery?: {
    eventId: string;
    attempts: number;
    event: LocalWatcherEvent;
  };
}

export const LOCAL_WATCHER_LIMITS = {
  minWakeupSeconds: 60,
  maxWakeupSeconds: 3600,
  minIntervalSeconds: 5,
  maxIntervalSeconds: 3600,
  maxAttempts: 100,
  commandBytes: 16 * 1024,
  timeoutMs: 60_000,
  inlineBytes: 64 * 1024,
  maxBytes: 64 * 1024 * 1024,
  concurrency: 4,
} as const;
