// CAN-5532 (B6): the daemon-backed W5 store arm of a desktop performance
// launch, over a real commit-log worker and real files, without daemon-owned
// storage rows.
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type * as TsxWorkerThreads from '../../ledger/__tests__/fixtures/tsx-worker-threads';
jest.mock('node:worker_threads', () =>
  jest
    .requireActual<
      typeof TsxWorkerThreads
    >('../../ledger/__tests__/fixtures/tsx-worker-threads')
    .createTsxWorkerThreads(),
);
jest.mock('../../lib/e2e-gate', () => ({ isE2eBuild: jest.fn(() => true) }));
jest.mock('../../lib/w5-flip-gate', () => ({
  isW5DaemonFlipCompiled: jest.fn(() => false),
}));
jest.mock('../../observability', () => ({
  getObservabilityService: jest.fn(() => ({
    purgeWorktreeData: jest.fn(() => Promise.resolve()),
    recordAppDiagnostic: jest.fn(),
    recordUsageMetricEvent: jest.fn(),
  })),
}));
jest.mock('../../portal/portal-structural-sync', () => ({
  schedulePortalStructuralSync: jest.fn(),
}));
jest.mock('../../portal/portal-event-bus', () => ({
  notifyPortalStructureChanged: jest.fn(),
}));

import { StorageWriteRefusedError } from '@canopy/core-runtime/storage';
import { settleDetachedWork } from '@canopy/desktop-shared/node/lib/detached-work';
import {
  resetWorkCounters,
  snapshotWorkCounters,
} from '@canopy/desktop-shared/node/work-counters';
import { isE2eBuild } from '../../lib/e2e-gate';
import { isW5DaemonFlipCompiled } from '../../lib/w5-flip-gate';
import { createW5BoundaryFixture } from '../../lib/__tests__/fixtures/w5-boundary-fixture';
import { __setDesktopW5FileStoreForTests } from '../../lib/w5-commit-log-file-store';
import { nodeW5FileStore } from '../../lib/w5-file-store';
import { __resetSidebarItemsStateForTests } from '../../lib/sidebar-items';
import {
  readWorkspaceWorktrees,
  setWorktreeRegistryReconciler,
  updateWorkspaceWorktrees,
} from '../../lib/workspace-persistence';
import { W5CommitLogHost } from '../../w5-commit-log/commit-log-host';
import {
  installW5StoreArm,
  startW5StoreArm,
  w5StoreArmAuthorityOptions,
  type W5StoreArmHandle,
} from '../w5-daemon-record-store-arm';

jest.setTimeout(60_000);

const WORKER = join(__dirname, '../../w5-commit-log/commit-log-worker.ts');
const e2eBuild = jest.mocked(isE2eBuild);

let dir: string;
let root: string;
let host: W5CommitLogHost;
let handle: W5StoreArmHandle | null;
let originalDataDir: string | undefined;

const listPath = (): string => join(root, 'a', 'worktrees.json');

beforeAll(() => {
  setWorktreeRegistryReconciler((_workspaceId, _current, next) =>
    Promise.resolve({ rows: next }),
  );
});
beforeEach(() => {
  ({ dir, root } = createW5BoundaryFixture((createdAt) => [
    { id: 'one', branchName: 'first', createdAt },
  ]));
  originalDataDir = process.env.CANOPY_DATA_DIR;
  process.env.CANOPY_DATA_DIR = join(dir, 'data');
  __resetSidebarItemsStateForTests();
  host = new W5CommitLogHost({
    dbPath: join(dir, 'w5', 'commit-log.sqlite'),
    root,
    workerEntry: WORKER,
  });
  handle = null;
  e2eBuild.mockReturnValue(true);
  jest.mocked(isW5DaemonFlipCompiled).mockReturnValue(false);
  globalThis.__CANOPY_E2E_STARTUP_MARKS__ = undefined;
  resetWorkCounters();
});
afterEach(async () => {
  handle?.restore();
  await settleDetachedWork();
  await handle?.shutdown();
  __setDesktopW5FileStoreForTests(nodeW5FileStore);
  await host.shutdown();
  if (originalDataDir === undefined) delete process.env.CANOPY_DATA_DIR;
  else process.env.CANOPY_DATA_DIR = originalDataDir;
  rmSync(dir, { recursive: true, force: true });
});

describe('the W5 store performance arm', () => {
  it.each(['in-process', 'daemon-record-port'])(
    'refuses direct installation of the %s arm on a flip build without opening a host',
    async (arm) => {
      jest.mocked(isW5DaemonFlipCompiled).mockReturnValue(true);
      const getHost = jest.fn(() => host);
      await expect(installW5StoreArm(arm, getHost)).rejects.toThrow(
        'cannot run on a W5 flip build',
      );
      const started = await startW5StoreArm(arm);
      expect('refusal' in started ? started.refusal : undefined).toContain(
        'cannot run on a W5 flip build',
      );
      expect(getHost).not.toHaveBeenCalled();
      expect(snapshotWorkCounters().w5).toEqual({});
      expect(globalThis.__CANOPY_E2E_STARTUP_MARKS__).toBeUndefined();
    },
  );

  it('refuses to install outside E2E builds', async () => {
    e2eBuild.mockReturnValue(false);
    await expect(
      installW5StoreArm('daemon-record-port', () => host),
    ).rejects.toThrow('only in E2E builds');
    expect(snapshotWorkCounters().w5).toEqual({});
  });

  it('refuses an unknown arm and installs nothing for the in-process arm', async () => {
    await expect(installW5StoreArm('daemon', () => host)).rejects.toThrow(
      'Unknown W5 store arm "daemon"',
    );
    await expect(installW5StoreArm('in-process', () => host)).resolves.toBe(
      null,
    );
    expect(globalThis.__CANOPY_E2E_STARTUP_MARKS__).toBeUndefined();
  });

  it('turns a failed start into the message main exits with', async () => {
    const started = await startW5StoreArm('daemon');
    expect('refusal' in started ? started.refusal : undefined).toContain(
      'The W5 store arm did not start: Unknown W5 store arm "daemon"',
    );
    await expect(startW5StoreArm('in-process')).resolves.toEqual({
      handle: null,
    });
  });

  it('builds the authority over the given host only', () => {
    expect(w5StoreArmAuthorityOptions(host)).toEqual({ host });
  });

  it('serves reads through the record port, refuses writes as a counted typed failure and never falls back', async () => {
    handle = await installW5StoreArm('daemon-record-port', () => host);
    expect(handle?.arm).toBe('daemon-record-port');
    expect(globalThis.__CANOPY_E2E_STARTUP_MARKS__?.w5StoreReady).toEqual(
      expect.any(Number),
    );
    const before = readFileSync(listPath(), 'utf8');

    await expect(readWorkspaceWorktrees('a')).resolves.toEqual([
      expect.objectContaining({ id: 'one', branchName: 'first' }),
    ]);
    const served = snapshotWorkCounters().w5;
    expect(served['read.worktrees.store']).toBeGreaterThan(0);
    expect(served['read.backend.capture']).toBeGreaterThan(0);
    expect(served['read.backend.direct']).toBeUndefined();
    expect(served['port.capture']).toBeGreaterThan(0);
    expect(served['host.capture']).toBe(served['port.capture']);
    expect(globalThis.__CANOPY_E2E_STARTUP_MARKS__?.w5FirstReadServed).toEqual(
      expect.any(Number),
    );

    const refusal = updateWorkspaceWorktrees('a', (rows) =>
      rows.map((row) => ({ ...row, branchName: 'renamed' })),
    );
    await expect(refusal).rejects.toBeInstanceOf(StorageWriteRefusedError);
    await expect(refusal).rejects.toMatchObject({
      namespaceId: 'worktree_list',
      reason: 'unlisted_writer',
    });
    const refused = snapshotWorkCounters().w5;
    expect(refused['replace.worktrees']).toBe(1);
    expect(refused['port.commit']).toBe(1);
    expect(refused['port.commit.failed.permission_denied']).toBe(1);
    expect(refused['port.commit.refused.writeRefused.unlisted_writer']).toBe(1);
    // The authority refused before its host decided anything.
    expect(refused['host.commit.w5.worktree_list.write']).toBeUndefined();
    expect(readFileSync(listPath(), 'utf8')).toBe(before);

    const installed = handle;
    handle = null;
    await installed?.shutdown();
    // The store stays installed: a read after quit fails instead of reaching
    // the in-process store.
    resetWorkCounters();
    // The refused commit dropped the store's recovery, so this read recovers
    // again over the closed port, and reads nothing.
    await expect(readWorkspaceWorktrees('a')).resolves.toEqual([]);
    const closed = snapshotWorkCounters().w5;
    installed?.restore();
    expect(closed['read.backend.direct']).toBeUndefined();
    expect(
      Object.keys(closed).filter((key) => /^port\.\w+\.failed\./.test(key)),
    ).not.toEqual([]);
  });
});
