import type { ResourceMonitorSnapshot } from '@canopy/desktop-shared/types';
import { isResourceMonitorSnapshot } from '../resource-monitor-validation';

function makeSnapshot(): ResourceMonitorSnapshot {
  return {
    version: 1,
    sampledAt: '2026-05-12T00:00:00.000Z',
    appPid: 1234,
    cpuPercent: 5,
    memoryRssBytes: 1024,
    processCount: 1,
    pressure: {
      level: 'ok',
      reasons: [],
      warningMemoryBytes: 1024,
      criticalMemoryBytes: 2048,
    },
    groups: [],
    guards: {
      chatTurns: {
        activeTurns: 0,
        pendingMessages: 0,
        maxConcurrentTurns: null,
        blocked: false,
      },
      pipelines: {
        activeExecutions: 0,
        maxConcurrentExecutions: null,
        blocked: false,
      },
      codexPools: {
        activeConnections: 0,
        liveProcesses: 0,
        activeTurns: 0,
      },
    },
  };
}

describe('resource monitor preload validation', () => {
  it('accepts snapshots with disabled concurrency caps', () => {
    expect(isResourceMonitorSnapshot(makeSnapshot())).toBe(true);
  });

  it('rejects snapshots with invalid pipeline cap values', () => {
    const snapshot = makeSnapshot();
    Object.assign(snapshot.guards.pipelines, {
      maxConcurrentExecutions: 'disabled',
    });

    expect(isResourceMonitorSnapshot(snapshot)).toBe(false);
  });

  it('accepts browser resource metadata', () => {
    const snapshot = makeSnapshot();
    snapshot.groups = [
      {
        id: 'browser',
        label: 'Browser',
        cpuPercent: 1,
        memoryRssBytes: 1024,
        processCount: 1,
        items: [
          {
            id: 'browser:browser-1',
            kind: 'in-app-browser',
            groupId: 'browser',
            label: 'Local app',
            pid: 333,
            cpuPercent: 1,
            memoryRssBytes: 1024,
            processCount: 1,
            status: 'running',
            metadata: {
              type: 'browser',
              browser: {
                projectId: 'project-1',
                worktreeId: 'worktree-1',
                browserId: 'browser-1',
                title: 'Local app',
                displayUrl: 'localhost:3000',
                visible: true,
                status: 'ready',
              },
            },
          },
        ],
      },
    ];

    expect(isResourceMonitorSnapshot(snapshot)).toBe(true);
  });

  it('accepts script resource metadata', () => {
    const snapshot = makeSnapshot();
    snapshot.groups = [
      {
        id: 'scripts',
        label: 'Script',
        cpuPercent: 1,
        memoryRssBytes: 1024,
        processCount: 1,
        items: [
          {
            id: 'script:project-1:worktree-1:project:dev:333',
            kind: 'script',
            groupId: 'scripts',
            label: 'Dev',
            pid: 333,
            processGroupId: 333,
            cpuPercent: 1,
            memoryRssBytes: 1024,
            processCount: 1,
            status: 'running',
            metadata: {
              type: 'script',
              script: {
                projectId: 'project-1',
                worktreeId: 'worktree-1',
                scriptKey: 'project:dev',
                scriptName: 'dev',
                scriptLabel: 'Dev',
                target: 'project',
                invocation: 'manual-run',
              },
            },
          },
        ],
      },
    ];

    expect(isResourceMonitorSnapshot(snapshot)).toBe(true);
  });
});
