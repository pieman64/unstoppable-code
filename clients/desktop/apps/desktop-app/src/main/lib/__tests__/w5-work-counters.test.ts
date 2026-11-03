import { join } from 'node:path';
import type { W5CommitLogHostPort } from '@canopy/core-runtime/node/w5/commit-log-file-store';
import type { W5RecordPortTransport } from '@canopy/core-runtime/node/w5/record-port';
import {
  resetWorkCounters,
  snapshotWorkCounters,
} from '@canopy/desktop-shared/node/work-counters';
import {
  countingW5HostPort,
  countingW5RecordPortTransport,
  w5PortFailureKeys,
  w5RecordFileClass,
} from '../w5-work-counters';

const commit = jest.fn(() =>
  Promise.resolve({ status: 'applied', commitId: 'c1', revisions: {} }),
);

function fakeHost(): W5CommitLogHostPort {
  const unused = (): Promise<never> => Promise.reject(new Error('unused'));
  return {
    root: '/data/workspaces',
    recoveryReport: unused,
    commit,
    lookupReceipt: unused,
    reserve: unused,
    updateReservationDiagnostics: unused,
    releaseReservation: unused,
    markReservationRecoveryRequired: unused,
    revision: jest.fn(() => Promise.resolve(3)),
    capture: jest.fn(() =>
      Promise.resolve({
        files: [{ kind: 'index', state: 'absent' }],
        discovery: 'complete',
        log: {
          retainedCommits: 9,
          revisions: {},
          files: [],
          chains: [
            {
              file: { kind: 'index' },
              decisions: 5,
              startsAbsent: true,
              discontinuities: 0,
            },
            {
              file: { kind: 'manifest', workspaceId: 'a' },
              decisions: 2,
              startsAbsent: true,
              discontinuities: 0,
            },
          ],
        },
      }),
    ),
  } as unknown as W5CommitLogHostPort;
}

beforeEach(() => {
  resetWorkCounters();
  commit.mockClear();
});

describe('W5 work counters', () => {
  it('classifies store paths by record file name', () => {
    expect(w5RecordFileClass(join('/r', 'index.json'))).toBe('index');
    expect(w5RecordFileClass(join('/r', 'index.json.bak'))).toBe('index');
    expect(w5RecordFileClass(join('/r', 'a', 'workspace.json'))).toBe(
      'manifest',
    );
    expect(w5RecordFileClass(join('/r', 'a', 'worktrees.json'))).toBe(
      'worktrees',
    );
    expect(w5RecordFileClass(join('/r', 'a', 'sidebar.json'))).toBe('other');
  });

  it('counts one view per host that keeps the host final-decision queue', async () => {
    const host = fakeHost();
    const view = countingW5HostPort(host);
    expect(countingW5HostPort(host)).toBe(view);
    expect(view.commitQueueKey).toBe(host);
    expect(view.root).toBe('/data/workspaces');

    await view.capture({
      files: [{ kind: 'index' }],
      discoverWorkspaces: true,
    });
    await view.revision({ kind: 'workspaces' });
    await view.commit({
      operation: 'w5.worktree_list.write',
      advance: [],
      files: [],
      outcome: null,
    });

    expect(commit).toHaveBeenCalledTimes(1);
    const w5 = snapshotWorkCounters().w5;
    expect(w5).toMatchObject({
      'host.capture': 1,
      'host.capture.files': 1,
      // Every retained decision the capture's chain evidence aggregated.
      'host.capture.chainDecisions': 7,
      'host.capture.retainedCommits': 9,
      'host.revision': 1,
      'host.commit.w5.worktree_list.write': 1,
    });
    expect(w5['host.commit.us']).toEqual(expect.any(Number));
    expect(w5['host.capture.us']).toEqual(expect.any(Number));
  });

  it('keeps a shared queue key the host already names', () => {
    const key = {};
    const host = { ...fakeHost(), commitQueueKey: key };
    expect(countingW5HostPort(host).commitQueueKey).toBe(key);
  });

  it('names a typed refusal by kind, code and reason, and anything else as untyped', () => {
    expect(
      w5PortFailureKeys('commit', {
        payload: {
          kind: 'permission_denied',
          code: 'core.workspaceRecords.writeRefused',
          message: 'refused',
          details: { namespaceId: 'worktree_list', reason: 'unlisted_writer' },
          retry: { kind: 'never' },
        },
      }),
    ).toEqual([
      'port.commit.failed.permission_denied',
      'port.commit.refused.writeRefused.unlisted_writer',
    ]);
    expect(w5PortFailureKeys('capture', new Error('closed'))).toEqual([
      'port.capture.failed.untyped',
    ]);
  });

  it('counts each transport call and failure, and rethrows the failure', async () => {
    const failure = new Error('lost');
    const transport = countingW5RecordPortTransport({
      recovery: () =>
        Promise.resolve({
          applied: [],
          recoveryRequired: [],
          recoveryRequiredDetails: [],
          interruptedReservations: 0,
          recoveryRequiredReservations: [],
        }),
      commit: () => Promise.reject(failure),
    } as unknown as W5RecordPortTransport);

    await transport.recovery();
    await expect(
      transport.commit({
        operation: 'w5.worktree_list.write',
        advance: [],
        files: [],
        outcome: null,
      }),
    ).rejects.toBe(failure);

    const w5 = snapshotWorkCounters().w5;
    expect(w5).toMatchObject({
      'port.recovery': 1,
      'port.commit': 1,
      'port.commit.failed.untyped': 1,
    });
    expect(w5['port.recovery.us']).toBeGreaterThanOrEqual(0);
    expect(w5['port.commit.us']).toBeGreaterThanOrEqual(0);
  });
});
