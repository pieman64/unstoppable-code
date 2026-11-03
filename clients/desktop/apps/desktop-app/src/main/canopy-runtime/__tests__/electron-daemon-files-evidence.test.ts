import { recordIpcInvoke } from '@canopy/desktop-shared/node/work-counters';
import type * as FilesAccess from '../electron-daemon-files-access';
import {
  disposeElectronDaemonFiles,
  getDesktopDaemonFilesRoute,
  snapshotDesktopFilesEvidence,
} from '../electron-daemon-files-access';
import { getElectronDaemonConnections } from '../electron-daemon-access';
import { FakeSender, localCaller } from './daemon-files-route-harness';

jest.mock('../../services/labs-experiments-runtime', () => ({
  getLabsExperimentsService: jest.fn().mockReturnValue({
    getSnapshot: jest.fn().mockReturnValue({ ready: false, experiments: [] }),
    onSnapshotChanged: jest.fn(() => jest.fn()),
  }),
}));
jest.mock('../electron-daemon-access', () => ({
  getElectronDaemonCallerLifetime: jest.fn(() => ({ renewAll: jest.fn() })),
  getElectronDaemonConnections: jest.fn(),
  getElectronDaemonFilesContext: jest.fn(),
  disposeElectronDaemonConnections: jest.fn(),
  setElectronDaemonFilesConsumerEnabled: jest.fn(),
}));

it('publishes only a read-only view of the real lazy production singleton and counters', async () => {
  const descriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    '__CANOPY_FILES_MAIN_EVIDENCE__',
  );
  expect(descriptor).toMatchObject({ configurable: false, writable: false });
  expect(Object.isFrozen(descriptor?.value)).toBe(true);
  expect(descriptor?.value).toEqual({ snapshot: snapshotDesktopFilesEvidence });
  expect(snapshotDesktopFilesEvidence().route).toBeNull();
  expect(getElectronDaemonConnections).not.toHaveBeenCalled();
  const route = getDesktopDaemonFilesRoute();
  expect(getDesktopDaemonFilesRoute()).toBe(route);
  const baseline = route.observe().cursor;
  const before = snapshotDesktopFilesEvidence().counters.invocations.roots;
  recordIpcInvoke('file-tree:roots');
  const sender = new FakeSender(876);
  const result = { roots: [], catalogRevision: 'private-payload' };
  await route.roots(
    { scope: { workspaceId: 'single', worktreeId: 'task' } },
    {
      requestId: 'test',
      caller: localCaller(sender),
      metadata: {},
      signal: new AbortController().signal,
    },
    { sender },
    {
      direct: () => Promise.resolve(result),
      capture: jest.fn(),
    },
  );
  const evidence = snapshotDesktopFilesEvidence(baseline);
  expect(evidence.route).toEqual(route.observe(baseline));
  expect(evidence.route?.entries.map((entry) => entry.phase)).toEqual([
    'started',
    'success',
  ]);
  expect(evidence.route?.entries).toEqual([
    expect.objectContaining({
      operation: 'roots',
      backend: 'direct',
      senderId: 876,
      request: 1,
      sequence: 1,
    }),
    expect.objectContaining({
      operation: 'roots',
      backend: 'direct',
      senderId: 876,
      request: 1,
      sequence: 2,
    }),
  ]);
  expect(evidence.counters.invocations.roots).toBe(before + 1);
  expect(JSON.stringify(evidence)).not.toContain('private-payload');
  expect(getElectronDaemonConnections).not.toHaveBeenCalled();
  await disposeElectronDaemonFiles();
  expect(snapshotDesktopFilesEvidence().route?.disposed).toBe(true);
});

it('keeps the first observer when the module is evaluated again', () => {
  const key = '__CANOPY_FILES_MAIN_EVIDENCE__';
  const published = Object.getOwnPropertyDescriptor(globalThis, key);
  const first = getDesktopDaemonFilesRoute().observe().cursor;
  jest.isolateModules(() => {
    const reloaded = jest.requireActual<typeof FilesAccess>(
      '../electron-daemon-files-access',
    );
    const current = Object.getOwnPropertyDescriptor(globalThis, key);
    expect(current).toEqual(published);
    expect(current?.value).toBe(published?.value);
    const cursor = reloaded.getDesktopDaemonFilesRoute().observe().cursor;
    expect(cursor.observerId).not.toBe(first.observerId);
    expect(snapshotDesktopFilesEvidence(first).route?.complete).toBe(true);
    expect(reloaded.snapshotDesktopFilesEvidence(cursor).route?.complete).toBe(
      true,
    );
    expect(snapshotDesktopFilesEvidence(cursor).route?.complete).toBe(false);
    expect(reloaded.snapshotDesktopFilesEvidence(first).route?.complete).toBe(
      false,
    );
  });
});
