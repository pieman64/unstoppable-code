// W6g (CAN-5498) temp-root parity: every D9 record scenario writes the same
// bytes, returns the same outcomes, commits the same labels and revisions,
// and runs its hooks in the same order through the in-process commit-log
// store and through the daemon record port. Both run real commit-log workers.
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type * as CoreStorage from '@canopy/core-runtime/storage';
import type * as TsxWorkerThreads from '../../ledger/__tests__/fixtures/tsx-worker-threads';
jest.mock('node:worker_threads', () =>
  jest
    .requireActual<
      typeof TsxWorkerThreads
    >('../../ledger/__tests__/fixtures/tsx-worker-threads')
    .createTsxWorkerThreads(),
);
jest.mock('@canopy/core-runtime/storage', () => {
  const actual = jest.requireActual<typeof CoreStorage>(
    '@canopy/core-runtime/storage',
  );
  const rows: CoreStorage.StorageOwnershipRow[] = [...actual.STORAGE_OWNERSHIP];
  return {
    ...actual,
    STORAGE_OWNERSHIP: rows,
    setDaemonOwnedForTest: (namespaceIds: readonly string[]): void => {
      actual.STORAGE_OWNERSHIP.forEach((row, index) => {
        rows[index] = namespaceIds.includes(row.id)
          ? { ...row, transitionOwner: 'daemon', currentWriters: [] }
          : row;
      });
    },
  };
});
const { setDaemonOwnedForTest } = jest.requireMock<{
  setDaemonOwnedForTest: (namespaceIds: readonly string[]) => void;
}>('@canopy/core-runtime/storage');
const mockHooks: string[] = [];
jest.mock('../../observability', () => ({
  getObservabilityService: jest.fn(() => ({
    recordAppDiagnostic: jest.fn(),
  })),
}));
jest.mock('../../portal/portal-structural-sync', () => ({
  schedulePortalStructuralSync: jest.fn(() => mockHooks.push('structural')),
}));
jest.mock('../../portal/portal-event-bus', () => ({
  notifyPortalStructureChanged: jest.fn(() => mockHooks.push('structure')),
}));

import { settleDetachedWork } from '@canopy/desktop-shared/node/lib/detached-work';
import type { W5CommitRequest } from '@canopy/desktop-shared/node/w5-commit-log';
import { startW5DaemonRecordHarness } from '@canopy/desktop-shared/node/w5-routed-writes/__tests__/fixtures/w5-daemon-record-harness';
import {
  NOW,
  SCENARIOS,
  WORKSPACE_ID,
  type Scenario,
} from './fixtures/worktree-record-scenarios';
import { W5CommitLogHost } from '../../w5-commit-log/commit-log-host';
import { getWorkspaceWorktreesFilePath } from '../paths';
import {
  __setDesktopW5FileStoreForTests,
  createW5CommitLogFileStore,
  readW5Revisions,
} from '../w5-commit-log-file-store';
import {
  createW5DaemonRecordStore,
  installW5DaemonRecordStoreForTests,
  w5RecordPortTransport,
} from '../w5-daemon-record-store';
import { nodeW5FileStore } from '../w5-file-store';
import { clearWorktreesSelfWriteTracking } from '../workspace-persistence';
import { registerWorkspaceTypes } from '../workspace-registry';

jest.setTimeout(120_000);

const W5_NAMESPACES = [
  'workspace_index',
  'workspace_manifest',
  'worktree_list',
];
const ROW_IDS = ['a', 'b', 'c', 'd', 'merged', 'missing'];

interface Run {
  outcome: unknown;
  bytes: string | null;
  commits: Pick<W5CommitRequest, 'operation' | 'advance'>[];
  revisions: number[];
  hooks: string[];
}

const dirs: string[] = [];
function seeded(scenario: Scenario): { dir: string; root: string } {
  const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'w6g-parity-')));
  dirs.push(dir);
  const root = path.join(dir, 'workspaces');
  mkdirSync(path.join(root, WORKSPACE_ID), { recursive: true });
  if (scenario.seed !== null)
    writeFileSync(
      path.join(root, WORKSPACE_ID, 'worktrees.json'),
      JSON.stringify({ version: 1, worktrees: scenario.seed }, null, 2),
    );
  return { dir, root };
}

async function run(
  scenario: Scenario,
  side: 'in-process' | 'daemon',
): Promise<Run> {
  const { dir, root } = seeded(scenario);
  process.env.CANOPY_DATA_DIR = dir;
  clearWorktreesSelfWriteTracking(WORKSPACE_ID);
  const host = new W5CommitLogHost({
    dbPath: path.join(dir, 'w5', 'commit-log.sqlite'),
    root,
    workerEntry: path.join(
      __dirname,
      '../../w5-commit-log/commit-log-worker.ts',
    ),
  });
  const commits: Run['commits'] = [];
  const commit = host.commit.bind(host);
  jest.spyOn(host, 'commit').mockImplementation((request) => {
    commits.push({ operation: request.operation, advance: request.advance });
    return commit(request);
  });
  let restore = (): void => undefined;
  const harness =
    side === 'daemon' ? await startW5DaemonRecordHarness({ host }) : undefined;
  try {
    if (harness) {
      setDaemonOwnedForTest(W5_NAMESPACES);
      restore = installW5DaemonRecordStoreForTests(
        createW5DaemonRecordStore({
          root,
          transport: w5RecordPortTransport(await harness.connect()),
        }),
      );
    } else {
      setDaemonOwnedForTest([]);
      __setDesktopW5FileStoreForTests(createW5CommitLogFileStore(() => host));
    }
    mockHooks.length = 0;
    const outcome = await scenario.run();
    await settleDetachedWork();
    const hooks = [...mockHooks];
    const revisions = (
      await readW5Revisions([
        { kind: 'worktrees', workspaceId: WORKSPACE_ID },
        ...ROW_IDS.map((worktreeId) => ({
          kind: 'worktree' as const,
          workspaceId: WORKSPACE_ID,
          worktreeId,
        })),
      ])
    ).map((entry) => entry.revision);
    let bytes: string | null = null;
    try {
      bytes = readFileSync(getWorkspaceWorktreesFilePath(WORKSPACE_ID), 'utf8');
    } catch {
      bytes = null;
    }
    return { outcome, bytes, commits, revisions, hooks };
  } finally {
    restore();
    setDaemonOwnedForTest([]);
    __setDesktopW5FileStoreForTests(nodeW5FileStore);
    await harness?.close();
    await host.shutdown();
  }
}

let originalDataDir: string | undefined;
beforeEach(() => {
  // Only the clock is fixed; file system and worker timers stay real.
  jest.useFakeTimers({
    now: NOW,
    doNotFake: [
      'hrtime',
      'nextTick',
      'performance',
      'queueMicrotask',
      'requestAnimationFrame',
      'cancelAnimationFrame',
      'requestIdleCallback',
      'cancelIdleCallback',
      'setImmediate',
      'clearImmediate',
      'setInterval',
      'clearInterval',
      'setTimeout',
      'clearTimeout',
    ],
  });
  registerWorkspaceTypes(new Map([[WORKSPACE_ID, 'single-repo']]));
  originalDataDir = process.env.CANOPY_DATA_DIR;
});
afterEach(() => {
  jest.useRealTimers();
  registerWorkspaceTypes(new Map());
  if (originalDataDir === undefined) delete process.env.CANOPY_DATA_DIR;
  else process.env.CANOPY_DATA_DIR = originalDataDir;
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

it.each(SCENARIOS.map((scenario) => [scenario.name, scenario]))(
  '%s: the daemon record port matches the in-process store',
  async (_name, scenario) => {
    const inProcess = await run(scenario, 'in-process');
    const daemon = await run(scenario, 'daemon');
    expect(daemon).toEqual(inProcess);
    committed += daemon.commits.length;
  },
);

// Not vacuous: the scenarios commit through both workers.
let committed = 0;
afterAll(() => expect(committed).toBeGreaterThan(SCENARIOS.length));
