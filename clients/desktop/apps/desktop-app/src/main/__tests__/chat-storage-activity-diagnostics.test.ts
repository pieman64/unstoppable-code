import { sanitizeAppDiagnosticRecord } from '../observability/app-diagnostic-privacy';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import type { ChatStorageActivityWindow } from '@canopy/desktop-shared/node/chat-storage-activity';
import type {
  AppDiagnosticRecord,
  SessionDiagnosticRecord,
} from '../observability/service';
import { startChatStorageActivityDiagnostics } from '../lib/chat-storage-activity-diagnostics';

const ACTIVITY = {
  commits: 2,
  mutations: 5,
  bytesWritten: 184,
  transcriptBytesWritten: 64,
  fileSyncs: 1,
  directorySyncs: 2,
  commitMsTotal: 60.4,
  commitMsMax: 42.4,
  queueWaitMsMax: 9.6,
};

function activeWindow(): ChatStorageActivityWindow {
  return {
    scopes: [
      {
        scopeKey: 'a'.repeat(16),
        identity: { projectId: 'w1', worktreeId: 'wt-1' },
        activity: ACTIVITY,
      },
      {
        scopeKey: 'b'.repeat(16),
        identity: undefined,
        activity: { ...ACTIVITY, commits: 1, bytesWritten: 16 },
      },
    ],
    total: { ...ACTIVITY, commits: 3, bytesWritten: 200 },
  };
}

describe('chat-storage activity diagnostics', () => {
  let sessions: SessionDiagnosticRecord[];
  let apps: AppDiagnosticRecord[];
  let windows: Array<ChatStorageActivityWindow | undefined>;
  let nowMs: number;

  beforeEach(() => {
    jest.useFakeTimers();
    sessions = [];
    apps = [];
    windows = [];
    nowMs = 0;
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  function start(): (options?: { flush?: boolean }) => void {
    return startChatStorageActivityDiagnostics({
      intervalMs: 60_000,
      take: () => windows.shift(),
      now: () => nowMs,
      timestamp: () => '2026-09-29T12:00:00.000Z',
      recordSession: (record) => sessions.push(record),
      recordApp: (record) => apps.push(record),
    });
  }

  /** Moves the injected clock with the fake timers, one second at a time. */
  function advance(ms: number): void {
    for (let elapsed = 0; elapsed < ms; elapsed += 1_000) {
      nowMs += 1_000;
      jest.advanceTimersByTime(1_000);
    }
  }

  function rateWindow(
    keys = ['a'.repeat(16)],
    rate = 1_048_577,
    ms = 60_000,
  ): ChatStorageActivityWindow {
    const activity = {
      ...ACTIVITY,
      transcriptBytesWritten: (rate * ms) / 1000,
      bytesWritten: (rate * ms) / 1000,
    };
    return {
      scopes: keys.map((scopeKey) => ({
        scopeKey,
        identity: undefined,
        activity,
      })),
      total: activity,
    };
  }

  function warnings(): AppDiagnosticRecord[] {
    return apps.filter((record) => record.kind === 'resource_pressure_warning');
  }

  it('warns once per sustained episode and independently per opaque scope', () => {
    const stop = start();
    windows.push(rateWindow(['a'.repeat(16), 'b'.repeat(16)]));
    advance(60_000);
    windows.push(rateWindow(['a'.repeat(16), 'b'.repeat(16)]));
    advance(60_000);
    expect(warnings()).toEqual([]);
    windows.push(
      rateWindow(['a'.repeat(16), 'b'.repeat(16)]),
      rateWindow(['a'.repeat(16), 'b'.repeat(16)]),
    );
    advance(120_000);
    expect(warnings()).toHaveLength(2);
    expect(sanitizeAppDiagnosticRecord(warnings()[0])).toMatchObject({
      reason: 'chat_transcript_write_rate',
      chatTranscriptWriteScopeDigest: 'a'.repeat(16),
      chatTranscriptWriteRateBytesPerSecond: 1_048_577,
      chatTranscriptWriteRateThresholdBytesPerSecond: 1_048_576,
      chatTranscriptWriteRateObservedMs: 180_000,
      chatTranscriptWriteRateSampleCount: 3,
    });
    stop();
  });

  it('keeps an episode across ticks that land a fraction of a millisecond early', () => {
    const stop = start();
    // Repeating timers fire on whole milliseconds, so the monotonic clock can
    // measure a 60 s window as 59,999.5 ms.
    for (let tick = 0; tick < 3; tick += 1) {
      windows.push(rateWindow(['a'.repeat(16)], 1_048_577, 59_999.5));
      nowMs += 59_999.5;
      jest.advanceTimersByTime(60_000);
    }
    expect(warnings()).toHaveLength(1);
    stop();
  });

  it.each(['equal', 'burst', 'quiet', 'missing', 'other-storage'])(
    'does not warn for %s windows',
    (mode) => {
      const stop = start();
      if (mode === 'equal')
        windows.push(
          ...Array.from({ length: 4 }, () => rateWindow(undefined, 1_048_576)),
        );
      else if (mode === 'other-storage') {
        const window = rateWindow();
        window.scopes[0].activity = {
          ...window.scopes[0].activity,
          transcriptBytesWritten: 0,
        };
        windows.push(window, window, window, window);
      } else
        windows.push(
          rateWindow(),
          mode === 'missing' ? undefined : rateWindow(undefined, 0),
          rateWindow(),
          rateWindow(),
        );
      advance(240_000);
      expect(warnings()).toEqual([]);
      stop();
    },
  );

  it('normalizes a delayed tick by actual elapsed time and resets a long gap', () => {
    const stop = start();
    windows.push(rateWindow(), rateWindow());
    advance(120_000);
    windows.push(rateWindow(undefined, 1_048_577, 75_000));
    nowMs += 15_000;
    advance(60_000);
    expect(warnings()[0]?.chatTranscriptWriteRateObservedMs).toBe(195_000);
    windows.push(rateWindow(undefined, 1_048_577, 180_000));
    nowMs += 120_000;
    advance(60_000);
    windows.push(rateWindow(), rateWindow());
    advance(120_000);
    expect(warnings()).toHaveLength(1);
    windows.push(rateWindow());
    advance(60_000);
    expect(warnings()).toHaveLength(2);
    stop();
  });

  it('cannot arm a warning on a partial stop flush or after restart', () => {
    const stop = start();
    windows.push(rateWindow(), rateWindow());
    advance(120_000);
    windows.push(rateWindow());
    advance(30_000);
    stop({ flush: true });
    expect(warnings()).toEqual([]);
    const restarted = start();
    windows.push(rateWindow());
    advance(60_000);
    expect(warnings()).toEqual([]);
    restarted();
  });

  it('bounds scope episodes and forgets evicted or absent scopes', () => {
    const stop = start();
    const keys = Array.from({ length: 300 }, (_, i) =>
      i.toString(16).padStart(16, '0'),
    );
    windows.push(rateWindow(keys), rateWindow(keys), rateWindow(keys));
    advance(180_000);
    expect(warnings()).toHaveLength(256);
    windows.push(
      undefined,
      rateWindow(keys.slice(0, 1)),
      rateWindow(keys.slice(0, 1)),
    );
    advance(180_000);
    expect(warnings()).toHaveLength(256);
    windows.push(rateWindow(keys.slice(0, 1)));
    advance(60_000);
    expect(warnings()).toHaveLength(257);
    stop();
  });

  it('contains a warning sink failure without retrying the episode', () => {
    const sink = jest.fn((record: AppDiagnosticRecord) => {
      void record;
      throw new Error('sink');
    });
    const stop = startChatStorageActivityDiagnostics({
      take: () => windows.shift(),
      now: () => nowMs,
      recordApp: sink,
      recordSession: () => undefined,
    });
    windows.push(rateWindow(), rateWindow(), rateWindow(), rateWindow());
    expect(() => advance(240_000)).not.toThrow();
    expect(
      sink.mock.calls.filter(
        ([record]) => record.kind === 'resource_pressure_warning',
      ),
    ).toHaveLength(1);
    stop();
  });

  it('records nothing while chat storage is idle', () => {
    const stop = start();
    advance(180_000);

    expect(sessions).toEqual([]);
    expect(apps).toEqual([]);
    stop();
  });

  it('records one summary per active scope and one aggregate without identifiers', () => {
    const stop = start();
    windows.push(undefined, activeWindow());
    advance(120_000);

    expect(sessions).toEqual([
      {
        version: 1,
        timestamp: '2026-09-29T12:00:00.000Z',
        kind: 'chat_storage_diagnostic',
        sessionKey: 'w1/wt-1/',
        projectId: 'w1',
        worktreeId: 'wt-1',
        chatId: '',
        providerType: 'unknown',
        chatStorageKind: 'activity_summary',
        chatStorageAuthority: 'v2',
        chatStorageWindowMs: 60_000,
        chatStorageCommitCount: 2,
        chatStorageMutationCount: 5,
        chatStorageBytesWritten: 184,
        chatStorageFileSyncCount: 1,
        chatStorageDirectorySyncCount: 2,
        chatStorageCommitMsTotal: 60.4,
        chatStorageCommitMsMax: 42.4,
        chatStorageQueueWaitMsMax: 9.6,
      },
    ]);
    expect(apps).toEqual([
      {
        version: 1,
        timestamp: '2026-09-29T12:00:00.000Z',
        kind: 'chat_storage_activity_summary',
        chatStorageWindowMs: 60_000,
        chatStorageScopeCount: 2,
        chatStorageCommitCount: 3,
        chatStorageMutationCount: 5,
        chatStorageBytesWritten: 200,
        chatStorageFileSyncCount: 1,
        chatStorageDirectorySyncCount: 2,
        chatStorageCommitMsTotal: 60.4,
        chatStorageCommitMsMax: 42.4,
        chatStorageQueueWaitMsMax: 9.6,
      },
    ]);
    const serialized = JSON.stringify(apps);
    expect(serialized).not.toContain('wt-1');
    expect(serialized).not.toContain('w1');
    stop();
  });

  it('flushes the partial window on a flushing stop and then stops sampling', () => {
    const stop = start();
    advance(15_000);
    windows.push(activeWindow());
    stop({ flush: true });

    expect(apps).toHaveLength(1);
    expect(apps[0]?.chatStorageWindowMs).toBe(15_000);
    windows.push(activeWindow());
    advance(120_000);
    expect(apps).toHaveLength(1);
  });

  it('keeps sampling when a recorder throws', () => {
    const stop = startChatStorageActivityDiagnostics({
      intervalMs: 60_000,
      take: () => windows.shift(),
      now: () => nowMs,
      recordSession: () => {
        throw new Error('observability unavailable');
      },
      recordApp: (record) => apps.push(record),
    });
    windows.push(activeWindow(), activeWindow());

    expect(() => advance(120_000)).not.toThrow();
    expect(apps).toHaveLength(2);
    stop();
  });

  it('flushes the last summary on quit only after chat state has drained', () => {
    // Commits made while chat state drains belong in the final summary, and
    // it must be recorded before observability is disposed.
    const source = readFileSync(
      path.resolve(__dirname, '..', 'index.ts'),
      'utf8',
    );
    const cleanup = source.slice(
      source.indexOf('async function cleanupRuntimeResources('),
    );
    const flush = cleanup.indexOf(
      'stopChatStorageActivityDiagnostics?.({ flush: true });',
    );
    // The drain runs inside this call, which resolves only after it settles.
    const drain = cleanup.indexOf('await drainChatStateBeforeRuntimeShutdown(');
    const dispose = cleanup.indexOf('getObservabilityService().dispose()');

    expect(drain).toBeGreaterThan(0);
    expect(cleanup.slice(drain, flush)).toContain(
      'getChatStateService().drain()',
    );
    expect(flush).toBeGreaterThan(drain);
    expect(dispose).toBeGreaterThan(flush);
  });
});
