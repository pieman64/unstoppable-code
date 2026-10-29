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
        identity: { projectId: 'w1', worktreeId: 'wt-1' },
        activity: ACTIVITY,
      },
      {
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
