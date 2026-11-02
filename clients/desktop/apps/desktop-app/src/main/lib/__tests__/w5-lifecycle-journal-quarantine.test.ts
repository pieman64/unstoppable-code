import type * as CostLifecycle from '../../cost-index/lifecycle';
import type * as MainProcessLogging from '../main-process-logging';
import type * as TsxWorkerThreads from '../../ledger/__tests__/fixtures/tsx-worker-threads';
import type {
  ArchiveIoOperationRequest,
  ArchiveIoResultMap,
  ArchiveIoOperationType,
} from '../../archive/archive-io-protocol';
import type * as ArchiveEngine from '../../archive/archive-io-engine';
import type * as FsPromises from 'node:fs/promises';
import type * as Os from 'node:os';
import type { rename as Rename } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  LIFECYCLE_JOURNAL_DIRECTORY_UNREADABLE_REFUSAL,
  LIFECYCLE_JOURNAL_UNREADABLE_REFUSAL,
  lifecycleJournalRefusalKind,
} from '@canopy/protocol/portal/lifecycle-journal';
import * as hostPlatform from '@canopy/core-platform/host-platform';
import { W5CommitRefusedError } from '@canopy/desktop-shared/node/w5-commit-log/errors';
import { settleDetachedWork } from '@canopy/desktop-shared/node/lib/detached-work';
import { createW5BoundaryFixture } from './fixtures/w5-boundary-fixture';
import { shutdownW5BoundaryHost } from './fixtures/w5-boundary-host';

// Pass-through, so a test can act inside the window of the first rename or
// link into the quarantine, or of the first folder created inside it.
let mockInstallHook:
  | ((
      from: string,
      to: string,
      install: typeof Rename,
      operation: 'rename' | 'link',
    ) => Promise<void>)
  | undefined;
let mockClaimFolderHook: ((path: string) => void) | undefined;
// Runs once just before the next unlink or rename of a journal entry name.
let mockJournalNameRemovalHook: ((path: string) => void) | undefined;
// Pass-through for the next rename or link into the journal folder.
let mockJournalInstallHook:
  | ((from: string, to: string, install: typeof Rename) => Promise<void>)
  | undefined;
// Fails the next open of this path (a directory sync) with EIO.
let mockFailOpenPath: string | undefined;
// Fails the next lstat of this path with EIO.
let mockFailLstatPath: string | undefined;
jest.mock('node:fs/promises', () => {
  const actual = jest.requireActual<typeof FsPromises>('node:fs/promises');
  const intoQuarantine = (to: string): boolean =>
    /[\\/]quarantined-lifecycles[\\/]/.test(to);
  const intoJournal = (to: string): boolean =>
    /[\\/]destructive-lifecycles[\\/]/.test(to);
  const beforeJournalNameRemoval = (path: unknown): void => {
    const hook =
      typeof path === 'string' && /[\\/]destructive-lifecycles[\\/]/.test(path)
        ? mockJournalNameRemovalHook
        : undefined;
    if (hook && typeof path === 'string') {
      mockJournalNameRemovalHook = undefined;
      hook(path);
    }
  };
  const install =
    (operation: 'rename' | 'link') =>
    (from: string, to: string): Promise<void> => {
      if (operation === 'rename') beforeJournalNameRemoval(from);
      const hook = intoQuarantine(to) ? mockInstallHook : undefined;
      if (hook) {
        mockInstallHook = undefined;
        return hook(from, to, actual[operation], operation);
      }
      const journalHook = intoJournal(to) ? mockJournalInstallHook : undefined;
      if (journalHook) {
        mockJournalInstallHook = undefined;
        return journalHook(from, to, actual[operation]);
      }
      return actual[operation](from, to);
    };
  return {
    ...actual,
    rename: install('rename'),
    link: install('link'),
    unlink: (path: Parameters<typeof actual.unlink>[0]): Promise<void> => {
      beforeJournalNameRemoval(path);
      return actual.unlink(path);
    },
    open: (
      ...args: Parameters<typeof actual.open>
    ): ReturnType<typeof actual.open> => {
      if (mockFailOpenPath === undefined || args[0] !== mockFailOpenPath)
        return actual.open(...args);
      mockFailOpenPath = undefined;
      return Promise.reject(
        Object.assign(new Error('Input/output error'), { code: 'EIO' }),
      );
    },
    lstat: (
      ...args: Parameters<typeof actual.lstat>
    ): ReturnType<typeof actual.lstat> => {
      if (mockFailLstatPath === undefined || args[0] !== mockFailLstatPath)
        return actual.lstat(...args);
      mockFailLstatPath = undefined;
      return Promise.reject(
        Object.assign(new Error('Input/output error'), { code: 'EIO' }),
      );
    },
    mkdir: (
      ...args: Parameters<typeof actual.mkdir>
    ): ReturnType<typeof actual.mkdir> => {
      const [path] = args;
      const hook =
        typeof path === 'string' && intoQuarantine(path)
          ? mockClaimFolderHook
          : undefined;
      if (hook && typeof path === 'string') {
        mockClaimFolderHook = undefined;
        hook(path);
      }
      return actual.mkdir(...args);
    },
  };
});
jest.mock('../post-archive-sync', () => ({
  queueTrackedGitHubWorktreeSync: jest.fn(),
}));
jest.mock('../auto-archive-teardown', () => ({
  runAutoArchiveTeardown: jest.fn(() => Promise.resolve()),
}));
jest.mock('../../browser/browser-profile-lifecycle', () => ({
  prepareTaskBrowserRetirement: jest.fn(() => Promise.resolve('retirement')),
  settleFailedTaskBrowserRetirement: jest.fn(() => Promise.resolve()),
  retireRemovedBrowserTask: jest.fn(() => Promise.resolve()),
  prepareWorkspaceBrowserRetirement: jest.fn(() => Promise.resolve([])),
  commitTaskBrowserRetirement: jest.fn(() => Promise.resolve(false)),
  abortTaskBrowserRetirement: jest.fn(() => Promise.resolve()),
}));
jest.mock('../../app-advisor/watchers', () => ({
  getAppAdvisorWatcherService: jest.fn(() => ({
    cancelLocalScope: jest.fn(() => Promise.resolve()),
    commitLocalScopeCancellation: jest.fn(() => Promise.resolve()),
    releaseLocalScopeFence: jest.fn(() => Promise.resolve()),
    cancelLocalWorkspace: jest.fn(() => Promise.resolve()),
    commitLocalWorkspaceCancellation: jest.fn(() => Promise.resolve()),
    releaseLocalWorkspaceFence: jest.fn(() => Promise.resolve()),
  })),
}));
jest.mock('../../chat-search/service', () => ({
  getChatSearchService: jest.fn(() => ({
    deleteWorkspaceDocs: jest.fn(() => Promise.resolve()),
    deleteWorktreeDocs: jest.fn(() => Promise.resolve()),
    worktreeContainerArchived: jest.fn(() => Promise.resolve()),
  })),
}));
jest.mock('../../ledger/lifecycle', () => ({
  captureLedgerWorkspaceIncarnations: jest.fn(() => Promise.resolve(null)),
  notifyLedgerWorkspaceDeleted: jest.fn(),
  notifyLedgerContainerArchived: jest.fn(),
}));
jest.mock('node:worker_threads', () =>
  jest
    .requireActual<
      typeof TsxWorkerThreads
    >('../../ledger/__tests__/fixtures/tsx-worker-threads')
    .createTsxWorkerThreads(),
);
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
jest.mock('../desktop-telemetry', () => ({
  recordWorkspaceCrudTelemetry: jest.fn(),
  recordWorktreeCrudTelemetry: jest.fn(),
}));
jest.mock('../../archive/archive-io-runner', () => ({
  // Replace Electron utility-process transport with the real filesystem engine.
  runArchiveIoRequest: (
    request: ArchiveIoOperationRequest,
  ): Promise<ArchiveIoResultMap[ArchiveIoOperationType]> =>
    jest
      .requireActual<typeof ArchiveEngine>('../../archive/archive-io-engine')
      .executeArchiveIoRequest(request, new AbortController().signal, {
        progress: () => {},
        child: { started: () => {}, exited: () => {} },
      }),
}));
jest.mock('../../cost-index/lifecycle', () => ({
  ...jest.requireActual<typeof CostLifecycle>('../../cost-index/lifecycle'),
  prepareEntryCostArchive: jest.fn(() => Promise.resolve()),
  finishEntryCostArchive: jest.fn(() => Promise.resolve()),
}));
jest.mock('../main-process-logging', () => ({
  ...jest.requireActual<typeof MainProcessLogging>('../main-process-logging'),
  logMainProcessWarn: jest.fn(),
}));

import { W5CommitLogHost } from '../../w5-commit-log/commit-log-host';
import {
  createW5CommitLogFileStore,
  __setDesktopW5FileStoreForTests,
} from '../w5-commit-log-file-store';
import { nodeW5FileStore } from '../w5-file-store';
import { __resetSidebarItemsStateForTests } from '../sidebar-items';
import { setBeforeProjectPluginDefaultsChangeHandler } from '../workspace-persistence';
import { archiveWorktree, deleteWorktree } from '../worktree-archive';
import { deleteWorkspace } from '../workspace-deletion';
import { getAppAdvisorWatcherService } from '../../app-advisor/watchers';
import { resetChatStateServiceForTests } from '../../services/chat-state-service';
import { waitForScheduledArchivedContainerDiskUsage } from '../archived-container-disk-usage';
import {
  assertNoDestructiveRecovery,
  hasUnresolvedDestructiveRecovery,
  readDestructiveRecovery,
} from '../w5-destructive-recovery';
import {
  inspectLifecycleJournal,
  lifecycleJournalLocationLabel,
  portableLifecycleJournalLocationLabel,
  quarantineLifecycleJournalEntry,
} from '../w5-lifecycle-journal-quarantine';
import { diagnoseW5State } from '../w5-maintenance-diagnosis';
import {
  getW5DestructiveLifecycleDir,
  getW5QuarantinedLifecycleDir,
  getWorkspaceDir,
} from '../paths';

jest.setTimeout(60_000);

const posixIt =
  process.platform === 'win32' || process.getuid?.() === 0 ? it.skip : it;

let dir: string;
let root: string;
let repo: string;
let host: W5CommitLogHost;
let originalDataDir: string | undefined;
const originalWatcherFactory = jest
  .mocked(getAppAdvisorWatcherService)
  .getMockImplementation();

beforeEach(() => {
  resetChatStateServiceForTests();
  if (!originalWatcherFactory)
    throw new Error('Watcher fixture factory missing');
  jest
    .mocked(getAppAdvisorWatcherService)
    .mockImplementation(originalWatcherFactory);
  ({ dir, root, repo } = createW5BoundaryFixture(
    (createdAt) => [
      { id: 'one', branchName: 'old', createdAt },
      { id: 'two', branchName: 'second', createdAt },
    ],
    ['b'],
  ));
  originalDataDir = process.env.CANOPY_DATA_DIR;
  process.env.CANOPY_DATA_DIR = join(dir, 'data');
  __resetSidebarItemsStateForTests();
  host = new W5CommitLogHost({
    dbPath: join(dir, 'w5', 'commit-log.sqlite'),
    root,
    workerEntry: join(__dirname, '../../w5-commit-log/commit-log-worker.ts'),
  });
  __setDesktopW5FileStoreForTests(createW5CommitLogFileStore(() => host));
  execFileSync('git', [
    '-C',
    repo,
    'worktree',
    'add',
    '-q',
    '-b',
    'old',
    join(root, 'a', 'worktrees', 'one'),
  ]);
  mkdirSync(journals(), { recursive: true });
  jest.clearAllMocks();
});
afterEach(async () => {
  mockInstallHook = undefined;
  mockClaimFolderHook = undefined;
  mockJournalNameRemovalHook = undefined;
  mockJournalInstallHook = undefined;
  mockFailOpenPath = undefined;
  mockFailLstatPath = undefined;
  for (const path of [journals(), getW5QuarantinedLifecycleDir()])
    if (existsSync(path)) chmodSync(path, 0o700);
  await waitForScheduledArchivedContainerDiskUsage();
  await settleDetachedWork();
  setBeforeProjectPluginDefaultsChangeHandler(undefined);
  __setDesktopW5FileStoreForTests(nodeW5FileStore);
  await shutdownW5BoundaryHost(host, join(dir, 'w5', 'commit-log.sqlite'));
  if (originalDataDir === undefined) delete process.env.CANOPY_DATA_DIR;
  else process.env.CANOPY_DATA_DIR = originalDataDir;
  rmSync(dir, { recursive: true, force: true });
  jest.restoreAllMocks();
});

function journals(): string {
  return getW5DestructiveLifecycleDir();
}
function slot(workspaceId: string, worktreeId?: string): string {
  return `${createHash('sha256')
    .update(JSON.stringify([workspaceId, worktreeId ?? null]))
    .digest('hex')}.json`;
}
function quarantined(): string[] {
  const path = getW5QuarantinedLifecycleDir();
  return existsSync(path) ? readdirSync(path) : [];
}
async function refusal(work: Promise<unknown>): Promise<W5CommitRefusedError> {
  const error = await work.then(
    () => {
      throw new Error('Expected a refusal');
    },
    (caught: unknown) => caught,
  );
  if (!(error instanceof W5CommitRefusedError)) throw error;
  return error;
}
function deleteB(): Promise<unknown> {
  return deleteWorkspace({ workspaceId: 'b', source: 'portal' });
}
function deleteOne(): Promise<unknown> {
  return deleteWorktree({
    workspaceId: 'a',
    worktreeId: 'one',
    source: 'single_repo',
  });
}
const archiveTwo = {
  workspaceId: 'a',
  worktreeId: 'two',
  source: 'single_repo' as const,
  deleteWithoutRetentionIfMissing: true,
};

it('refuses an unrelated deletion distinguishably for malformed JSON at a hashed slot, names its worktree, and quarantines it', async () => {
  const name = slot('a', 'one');
  writeFileSync(join(journals(), name), '{"version":1,', { mode: 0o600 });
  const identity = lstatSync(join(journals(), name));

  const error = await refusal(deleteB());
  expect(error.reason).toBe('recovery-required');
  expect(error.message).toBe(LIFECYCLE_JOURNAL_UNREADABLE_REFUSAL);
  expect(lifecycleJournalRefusalKind(error)).toBe('unreadable-entry');
  expect(error.details).toEqual({
    phase: 'lifecycle-journal',
    check: 'unreadable-entry',
    entryName: name,
    entryIdentity: `${identity.dev}:${identity.ino}:${identity.birthtimeMs}`,
  });
  await expect(readDestructiveRecovery('a', 'one')).rejects.toMatchObject({
    message: LIFECYCLE_JOURNAL_UNREADABLE_REFUSAL,
  });
  expect(existsSync(getWorkspaceDir('b'))).toBe(true);

  // The desktop's local labels show the home folder as `~`, never the
  // account path; the Portal's default is relative to the data folder.
  jest
    .spyOn(jest.requireActual<typeof Os>('node:os'), 'homedir')
    .mockReturnValue(dir);
  const local = await inspectLifecycleJournal(lifecycleJournalLocationLabel);
  if (local.status !== 'unreadable-entries')
    throw new Error(`Unexpected ${local.status}`);
  expect(local.locationLabel).toBe('~/data/w5/destructive-lifecycles');
  expect(local.quarantineLocationLabel).toBe(
    '~/data/w5/quarantined-lifecycles',
  );
  expect(JSON.stringify(local)).not.toContain(dir);
  const inspection = await inspectLifecycleJournal();
  expect(inspection).toEqual({
    ...local,
    locationLabel: '<data>/w5/destructive-lifecycles',
    quarantineLocationLabel: '<data>/w5/quarantined-lifecycles',
  });
  if (inspection.status !== 'unreadable-entries')
    throw new Error(`Unexpected ${inspection.status}`);
  const [entry] = inspection.entries;
  expect(inspection.entries).toHaveLength(1);
  expect(entry).toMatchObject({
    name,
    kind: 'file',
    identityVerified: true,
    match: {
      kind: 'worktree',
      workspaceId: 'a',
      worktreeId: 'one',
      projectName: 'Original',
      worktreeName: 'old',
    },
  });
  // The birth-order probes are removed; nothing else is written there.
  expect(readdirSync(journals())).toEqual([name]);
  if (!entry) throw new Error('Missing entry');

  const result = await quarantineLifecycleJournalEntry({
    name,
    identity: entry.identity,
  });
  expect(existsSync(join(journals(), name))).toBe(false);
  expect(quarantined()).toEqual([result.quarantinedName]);
  expect(result.quarantinedName.endsWith(`-${name}`)).toBe(true);
  const moved = join(getW5QuarantinedLifecycleDir(), result.quarantinedName);
  expect(readFileSync(moved, 'utf8')).toBe('{"version":1,');
  expect(lstatSync(moved).ino).toBe(identity.ino);

  await expect(inspectLifecycleJournal()).resolves.toMatchObject({
    status: 'clear',
  });
  // Nothing extra stays fenced (Q-II A): the unrelated deletion now succeeds.
  await expect(hasUnresolvedDestructiveRecovery('b')).resolves.toBe(false);
  await expect(deleteB()).resolves.toBeDefined();
  expect(existsSync(getWorkspaceDir('b'))).toBe(false);
  expect(quarantined()).toEqual([result.quarantinedName]);
});

it('refuses and quarantines malformed JSON at a UUID name without naming a project', async () => {
  const name = `${randomUUID()}.json`;
  writeFileSync(join(journals(), name), 'not json');
  const error = await refusal(archiveWorktree(archiveTwo));
  expect(error.message).toBe(LIFECYCLE_JOURNAL_UNREADABLE_REFUSAL);
  expect(error.details).toMatchObject({ entryName: name });

  const inspection = await inspectLifecycleJournal();
  if (inspection.status !== 'unreadable-entries')
    throw new Error(`Unexpected ${inspection.status}`);
  const [entry] = inspection.entries;
  if (!entry) throw new Error('Missing entry');
  expect(entry.match).toBeUndefined();
  expect(entry.kind).toBe('file');

  await quarantineLifecycleJournalEntry({ name, identity: entry.identity });
  await expect(archiveWorktree(archiveTwo)).resolves.toMatchObject({
    success: true,
  });
});

// CAN-5377: the pre-effect refusal releases the key, so quarantine is the repair.
it.each([
  [
    'project deletion',
    (): Promise<unknown> =>
      deleteWorkspace({
        workspaceId: 'b',
        source: 'portal',
        idempotencyKey: 'quarantine-retry',
      }),
    (): string => getWorkspaceDir('b'),
  ],
  [
    'worktree removal',
    (): Promise<unknown> =>
      deleteWorktree({
        workspaceId: 'a',
        worktreeId: 'one',
        source: 'portal',
        idempotencyKey: 'quarantine-retry',
      }),
    (): string => join(root, 'a', 'worktrees', 'one'),
  ],
])(
  'a keyed %s refused for an unreadable entry succeeds under the same key after quarantine',
  async (_label, run, target) => {
    const name = `${randomUUID()}.json`;
    writeFileSync(join(journals(), name), 'not json');
    const identity = lstatSync(join(journals(), name));

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const error = await refusal(run());
      expect(lifecycleJournalRefusalKind(error)).toBe('unreadable-entry');
      expect(error.details).toEqual({
        phase: 'lifecycle-journal',
        check: 'unreadable-entry',
        entryName: name,
        entryIdentity: `${identity.dev}:${identity.ino}:${identity.birthtimeMs}`,
      });
    }
    expect(existsSync(target())).toBe(true);

    const inspection = await inspectLifecycleJournal();
    if (inspection.status !== 'unreadable-entries')
      throw new Error(`Unexpected ${inspection.status}`);
    const [entry] = inspection.entries;
    if (!entry) throw new Error('Missing entry');
    await quarantineLifecycleJournalEntry({ name, identity: entry.identity });

    await expect(run()).resolves.toBeDefined();
    expect(existsSync(target())).toBe(false);
  },
);

it('a schema-invalid hashed slot also refuses as unreadable and names its project', async () => {
  const name = slot('b');
  writeFileSync(join(journals(), name), JSON.stringify({ version: 2 }));
  const error = await refusal(archiveWorktree(archiveTwo));
  expect(error.details).toMatchObject({ entryName: name });
  const inspection = await inspectLifecycleJournal();
  expect(inspection).toMatchObject({
    status: 'unreadable-entries',
    entries: [
      {
        name,
        match: { kind: 'project', workspaceId: 'b', projectName: 'b' },
      },
    ],
  });
});

it('quarantines a directory at a recognized name with its contents unchanged', async () => {
  const name = slot('b');
  mkdirSync(join(journals(), name));
  writeFileSync(join(journals(), name, 'inner.txt'), 'keep me');
  const error = await refusal(deleteB());
  expect(error.details).toMatchObject({
    check: 'unreadable-entry',
    entryName: name,
  });

  const inspection = await inspectLifecycleJournal();
  if (inspection.status !== 'unreadable-entries')
    throw new Error(`Unexpected ${inspection.status}`);
  const [entry] = inspection.entries;
  if (!entry) throw new Error('Missing entry');
  expect(entry).toMatchObject({
    kind: 'directory',
    match: { kind: 'project', workspaceId: 'b' },
  });

  const result = await quarantineLifecycleJournalEntry({
    name,
    identity: entry.identity,
  });
  const moved = join(getW5QuarantinedLifecycleDir(), result.quarantinedName);
  expect(readFileSync(join(moved, 'inner.txt'), 'utf8')).toBe('keep me');
  await expect(deleteB()).resolves.toBeDefined();
});

posixIt(
  'a directory without write permission is left in place with a manual-move refusal',
  async () => {
    const name = slot('b');
    const path = join(journals(), name);
    mkdirSync(path);
    chmodSync(path, 0o000);
    try {
      const inspection = await inspectLifecycleJournal();
      if (inspection.status !== 'unreadable-entries')
        throw new Error(`Unexpected ${inspection.status}`);
      const [entry] = inspection.entries;
      if (!entry) throw new Error('Missing entry');
      expect(entry.kind).toBe('directory');
      // Moving a directory to another folder rewrites its `..` entry.
      await expect(
        quarantineLifecycleJournalEntry({ name, identity: entry.identity }),
      ).rejects.toMatchObject({
        reason: 'failed',
        message:
          "Couldn't move this folder because its permissions don't allow it. It's still where it was. Move it manually.",
      });
      expect(lstatSync(path).isDirectory()).toBe(true);
      expect(lstatSync(path).mode & 0o777).toBe(0);
      expect(quarantined()).toEqual([]);
    } finally {
      chmodSync(path, 0o700);
    }
  },
);

posixIt(
  'moves a dangling link at a recognized name, never its target',
  async () => {
    const name = slot('b');
    const target = join(dir, 'elsewhere.json');
    symlinkSync(target, join(journals(), name));
    await expect(refusal(archiveWorktree(archiveTwo))).resolves.toMatchObject({
      message: LIFECYCLE_JOURNAL_UNREADABLE_REFUSAL,
    });
    const inspection = await inspectLifecycleJournal();
    if (inspection.status !== 'unreadable-entries')
      throw new Error(`Unexpected ${inspection.status}`);
    const [entry] = inspection.entries;
    if (!entry) throw new Error('Missing entry');
    expect(entry.kind).toBe('other');
    const result = await quarantineLifecycleJournalEntry({
      name,
      identity: entry.identity,
    });
    const moved = join(getW5QuarantinedLifecycleDir(), result.quarantinedName);
    expect(lstatSync(moved).isSymbolicLink()).toBe(true);
    expect(readlinkSync(moved)).toBe(target);
    expect(existsSync(target)).toBe(false);
    await expect(deleteB()).resolves.toBeDefined();
  },
);

posixIt('quarantines a mode 000 file with its bytes unchanged', async () => {
  const name = slot('a', 'one');
  const bytes = JSON.stringify({ unreadable: true });
  writeFileSync(join(journals(), name), bytes);
  chmodSync(join(journals(), name), 0o000);
  const error = await refusal(deleteB());
  expect(error.details).toMatchObject({ entryName: name });

  const inspection = await inspectLifecycleJournal();
  if (inspection.status !== 'unreadable-entries')
    throw new Error(`Unexpected ${inspection.status}`);
  const [entry] = inspection.entries;
  if (!entry) throw new Error('Missing entry');

  const result = await quarantineLifecycleJournalEntry({
    name,
    identity: entry.identity,
  });
  const moved = join(getW5QuarantinedLifecycleDir(), result.quarantinedName);
  expect(lstatSync(moved).mode & 0o777).toBe(0);
  chmodSync(moved, 0o600);
  expect(readFileSync(moved, 'utf8')).toBe(bytes);
  await expect(deleteB()).resolves.toBeDefined();
});

it('refuses to move an entry replaced after confirmation and leaves the replacement in place', async () => {
  const name = slot('a', 'one');
  const path = join(journals(), name);
  writeFileSync(path, '{broken');
  const inspection = await inspectLifecycleJournal();
  if (inspection.status !== 'unreadable-entries')
    throw new Error(`Unexpected ${inspection.status}`);
  const [entry] = inspection.entries;
  if (!entry) throw new Error('Missing entry');

  rmSync(path);
  writeFileSync(path, '{also broken');
  await expect(
    quarantineLifecycleJournalEntry({ name, identity: entry.identity }),
  ).rejects.toMatchObject({ reason: 'changed' });
  expect(readFileSync(path, 'utf8')).toBe('{also broken');
  expect(quarantined()).toEqual([]);
  await expect(refusal(deleteB())).resolves.toMatchObject({
    message: LIFECYCLE_JOURNAL_UNREADABLE_REFUSAL,
  });
});

it('refuses to move a file rewritten in place after confirmation', async () => {
  const name = slot('a', 'one');
  const path = join(journals(), name);
  writeFileSync(path, '{broken');
  const { ino } = lstatSync(path);
  const inspection = await inspectLifecycleJournal();
  if (inspection.status !== 'unreadable-entries')
    throw new Error(`Unexpected ${inspection.status}`);
  const [entry] = inspection.entries;
  if (!entry) throw new Error('Missing entry');

  // Same inode and birth time, different (still unreadable) bytes.
  writeFileSync(path, '{broken, and longer');
  expect(lstatSync(path).ino).toBe(ino);
  await expect(
    quarantineLifecycleJournalEntry({ name, identity: entry.identity }),
  ).rejects.toMatchObject({ reason: 'changed' });
  expect(readFileSync(path, 'utf8')).toBe('{broken, and longer');
  expect(quarantined()).toEqual([]);
});

it('puts back an entry replaced inside the rename window', async () => {
  const name = slot('a', 'one');
  const path = join(journals(), name);
  writeFileSync(path, '{broken');
  const inspection = await inspectLifecycleJournal();
  if (inspection.status !== 'unreadable-entries')
    throw new Error(`Unexpected ${inspection.status}`);
  const [entry] = inspection.entries;
  if (!entry) throw new Error('Missing entry');

  mockInstallHook = async (from, to, install): Promise<void> => {
    // Lands after the last pre-install check, before the atomic install.
    rmSync(path);
    writeFileSync(path, '{replacement');
    await install(from, to);
  };
  await expect(
    quarantineLifecycleJournalEntry({ name, identity: entry.identity }),
  ).rejects.toMatchObject({ reason: 'changed' });
  expect(mockInstallHook).toBeUndefined();
  expect(readFileSync(path, 'utf8')).toBe('{replacement');
  expect(quarantined()).toEqual([]);
});

it.each(['file', 'directory'] as const)(
  'a %s replaced inside the install window stays fenced for a concurrent scan',
  async (kind) => {
    const name = slot('a', 'one');
    const path = join(journals(), name);
    const create = (marker: string): void => {
      if (kind === 'file') writeFileSync(path, `{${marker}`);
      else {
        mkdirSync(path);
        writeFileSync(join(path, 'marker'), marker);
      }
    };
    create('original');
    const inspection = await inspectLifecycleJournal();
    if (inspection.status !== 'unreadable-entries')
      throw new Error(`Unexpected ${inspection.status}`);
    const [entry] = inspection.entries;
    if (!entry) throw new Error('Missing entry');

    let scan: Promise<unknown> | undefined;
    mockInstallHook = async (from, to, install): Promise<void> => {
      rmSync(path, { recursive: true });
      create('replacement');
      await install(from, to);
      // Admission scans while the replacement may be out of the journal folder.
      scan = assertNoDestructiveRecovery('b').then(
        () => 'admitted',
        (error: unknown) => error,
      );
      await new Promise((resolve) => setTimeout(resolve, 50));
    };
    await expect(
      quarantineLifecycleJournalEntry({ name, identity: entry.identity }),
    ).rejects.toMatchObject({ reason: 'changed' });
    await expect(scan).resolves.toMatchObject({
      message: LIFECYCLE_JOURNAL_UNREADABLE_REFUSAL,
      details: { entryName: name },
    });
    expect(
      kind === 'file'
        ? readFileSync(path, 'utf8')
        : readFileSync(join(path, 'marker'), 'utf8'),
    ).toMatch(/replacement$/);
    expect(quarantined()).toEqual([]);
  },
);

it.each(['file', 'directory'] as const)(
  'inspection waits for a %s move that rolls back, and never reports clear',
  async (kind) => {
    const name = slot('a', 'one');
    const path = join(journals(), name);
    const create = (marker: string): void => {
      if (kind === 'file') writeFileSync(path, `{${marker}`);
      else {
        mkdirSync(path);
        writeFileSync(join(path, 'marker'), marker);
      }
    };
    create('original');
    const reviewed = await inspectLifecycleJournal();
    if (reviewed.status !== 'unreadable-entries')
      throw new Error(`Unexpected ${reviewed.status}`);
    const [entry] = reviewed.entries;
    if (!entry) throw new Error('Missing entry');

    let inspection: Promise<unknown> | undefined;
    // Inspects while the journal name is out of the journal folder. An
    // unlocked inspection finishes here; a waiting one lets the move go on.
    const inspectAfter = async (
      from: string,
      to: string,
      install: typeof Rename,
    ): Promise<void> => {
      await install(from, to);
      inspection = inspectLifecycleJournal();
      await Promise.race([
        inspection,
        new Promise((resolve) => setTimeout(resolve, 200)),
      ]);
    };
    mockInstallHook =
      kind === 'directory'
        ? async (from, to, install): Promise<void> => {
            // Replaced inside the rename window: moved, then put back.
            rmSync(path, { recursive: true });
            create('replacement');
            await inspectAfter(from, to, install);
          }
        : async (from, to, install): Promise<void> => {
            await install(from, to);
            // Replaced as its journal name is moved aside, then linked back.
            mockJournalNameRemovalHook = (journalName): void => {
              rmSync(journalName);
              writeFileSync(journalName, '{replacement');
            };
            mockInstallHook = inspectAfter;
          };
    await expect(
      quarantineLifecycleJournalEntry({ name, identity: entry.identity }),
    ).rejects.toMatchObject({ reason: 'changed' });
    expect(mockInstallHook).toBeUndefined();
    await expect(inspection).resolves.toMatchObject({
      status: 'unreadable-entries',
      entries: [{ name, kind }],
    });
  },
);

it('never replaces a record that takes the quarantine name before the install', async () => {
  const name = slot('a', 'one');
  const path = join(journals(), name);
  writeFileSync(path, '{broken');
  const { ino } = lstatSync(path);
  const inspection = await inspectLifecycleJournal();
  if (inspection.status !== 'unreadable-entries')
    throw new Error(`Unexpected ${inspection.status}`);
  const [entry] = inspection.entries;
  if (!entry) throw new Error('Missing entry');

  let taken: string | undefined;
  mockInstallHook = async (from, to, install): Promise<void> => {
    taken = to;
    writeFileSync(to, 'an earlier quarantined record', { flag: 'wx' });
    await install(from, to);
  };
  const result = await quarantineLifecycleJournalEntry({
    name,
    identity: entry.identity,
  });
  if (!taken) throw new Error('The install hook did not run');
  expect(readFileSync(taken, 'utf8')).toBe('an earlier quarantined record');
  const moved = join(getW5QuarantinedLifecycleDir(), result.quarantinedName);
  expect(moved).not.toBe(taken);
  expect(readFileSync(moved, 'utf8')).toBe('{broken');
  expect(lstatSync(moved).ino).toBe(ino);
  expect(lstatSync(moved).nlink).toBe(1);
  expect(existsSync(path)).toBe(false);
  expect(quarantined().sort()).toEqual(
    [result.quarantinedName, taken.split(/[\\/]/).pop()].sort(),
  );
});

it('keeps a file that takes the journal name after the last re-check', async () => {
  const name = slot('a', 'one');
  const path = join(journals(), name);
  writeFileSync(path, '{broken');
  const inspection = await inspectLifecycleJournal();
  if (inspection.status !== 'unreadable-entries')
    throw new Error(`Unexpected ${inspection.status}`);
  const [entry] = inspection.entries;
  if (!entry) throw new Error('Missing entry');

  mockInstallHook = async (from, to, install): Promise<void> => {
    await install(from, to);
    mockJournalNameRemovalHook = (journalName): void => {
      // Lands after every re-check, as the journal name is removed.
      rmSync(journalName);
      writeFileSync(journalName, '{replacement');
    };
  };
  await expect(
    quarantineLifecycleJournalEntry({ name, identity: entry.identity }),
  ).rejects.toMatchObject({ reason: 'changed' });
  expect(mockJournalNameRemovalHook).toBeUndefined();
  expect(readFileSync(path, 'utf8')).toBe('{replacement');
  // The confirmed bytes survive in the quarantine under a single name.
  const moved = quarantined();
  expect(moved).toHaveLength(1);
  const [kept] = moved;
  if (!kept) throw new Error('Missing quarantined entry');
  expect(readFileSync(join(getW5QuarantinedLifecycleDir(), kept), 'utf8')).toBe(
    '{broken',
  );
  await expect(assertNoDestructiveRecovery('b')).rejects.toMatchObject({
    message: LIFECYCLE_JOURNAL_UNREADABLE_REFUSAL,
    details: { entryName: name },
  });
});

const PUT_BACK_UNCONFIRMED =
  'This record changed during the move, and the newer record may not be back in place. Check the quarantine folder before you continue.';
function refuseNextJournalInstall(): void {
  mockJournalInstallHook = (): Promise<void> =>
    Promise.reject(
      Object.assign(new Error('Permission denied'), { code: 'EACCES' }),
    );
}

it.each(['file', 'directory'] as const)(
  'reports a %s that takes the journal name as unconfirmed when it cannot go back, and keeps both records',
  async (kind) => {
    const name = slot('a', 'one');
    const path = join(journals(), name);
    writeFileSync(path, '{broken');
    const inspection = await inspectLifecycleJournal();
    if (inspection.status !== 'unreadable-entries')
      throw new Error(`Unexpected ${inspection.status}`);
    const [entry] = inspection.entries;
    if (!entry) throw new Error('Missing entry');

    mockInstallHook = async (from, to, install): Promise<void> => {
      await install(from, to);
      mockJournalNameRemovalHook = (journalName): void => {
        rmSync(journalName);
        if (kind === 'file') writeFileSync(journalName, '{replacement');
        else {
          mkdirSync(journalName);
          writeFileSync(join(journalName, 'marker'), 'replacement');
        }
        refuseNextJournalInstall();
      };
    };
    await expect(
      quarantineLifecycleJournalEntry({ name, identity: entry.identity }),
    ).rejects.toMatchObject({
      reason: 'unconfirmed',
      message: PUT_BACK_UNCONFIRMED,
    });
    expect(mockJournalInstallHook).toBeUndefined();
    expect(existsSync(path)).toBe(false);
    // Neither record is deleted: both stay in the quarantine.
    const contents = quarantined()
      .map((moved) => join(getW5QuarantinedLifecycleDir(), moved))
      .map((moved) =>
        lstatSync(moved).isDirectory()
          ? readFileSync(join(moved, 'marker'), 'utf8')
          : readFileSync(moved, 'utf8'),
      )
      .sort();
    expect(contents).toEqual(
      ['{broken', kind === 'file' ? '{replacement' : 'replacement'].sort(),
    );
  },
);

posixIt(
  'reports a put-back whose journal folder sync fails as unconfirmed',
  async () => {
    const name = slot('a', 'one');
    const path = join(journals(), name);
    writeFileSync(path, '{broken');
    const inspection = await inspectLifecycleJournal();
    if (inspection.status !== 'unreadable-entries')
      throw new Error(`Unexpected ${inspection.status}`);
    const [entry] = inspection.entries;
    if (!entry) throw new Error('Missing entry');

    mockInstallHook = async (from, to, install): Promise<void> => {
      await install(from, to);
      mockJournalNameRemovalHook = (journalName): void => {
        rmSync(journalName);
        writeFileSync(journalName, '{replacement');
        mockJournalInstallHook = async (
          putFrom,
          putTo,
          putBack,
        ): Promise<void> => {
          await putBack(putFrom, putTo);
          mockFailOpenPath = journals();
        };
      };
    };
    await expect(
      quarantineLifecycleJournalEntry({ name, identity: entry.identity }),
    ).rejects.toMatchObject({
      reason: 'unconfirmed',
      message: PUT_BACK_UNCONFIRMED,
    });
    expect(mockFailOpenPath).toBeUndefined();
    // Back in place, but not confirmed durable.
    expect(readFileSync(path, 'utf8')).toBe('{replacement');
    const [kept, ...rest] = quarantined();
    expect(rest).toEqual([]);
    if (!kept) throw new Error('Missing quarantined entry');
    expect(
      readFileSync(join(getW5QuarantinedLifecycleDir(), kept), 'utf8'),
    ).toBe('{broken');
  },
);

it.each(['refused', 'blocked by a newer entry'] as const)(
  'reports a directory replaced inside the rename window as unconfirmed when its put-back is %s',
  async (failure) => {
    const name = slot('a', 'one');
    const path = join(journals(), name);
    mkdirSync(path);
    writeFileSync(join(path, 'marker'), 'original');
    const inspection = await inspectLifecycleJournal();
    if (inspection.status !== 'unreadable-entries')
      throw new Error(`Unexpected ${inspection.status}`);
    const [entry] = inspection.entries;
    if (!entry) throw new Error('Missing entry');

    mockInstallHook = async (from, to, install): Promise<void> => {
      rmSync(path, { recursive: true });
      mkdirSync(path);
      writeFileSync(join(path, 'marker'), 'replacement');
      await install(from, to);
      if (failure === 'refused') refuseNextJournalInstall();
      else writeFileSync(path, '{newer');
    };
    await expect(
      quarantineLifecycleJournalEntry({ name, identity: entry.identity }),
    ).rejects.toMatchObject({
      reason: 'unconfirmed',
      message: PUT_BACK_UNCONFIRMED,
    });
    expect(mockInstallHook).toBeUndefined();
    if (failure === 'refused') {
      expect(mockJournalInstallHook).toBeUndefined();
      expect(existsSync(path)).toBe(false);
    } else expect(readFileSync(path, 'utf8')).toBe('{newer');
    // The replacement is kept in the quarantine, never deleted.
    const [kept, ...rest] = quarantined();
    expect(rest).toEqual([]);
    if (!kept) throw new Error('Missing quarantined entry');
    expect(
      readFileSync(
        join(getW5QuarantinedLifecycleDir(), kept, 'marker'),
        'utf8',
      ),
    ).toBe('replacement');
  },
);

it('reports a directory replaced inside the rename window as unconfirmed when its slot cannot be checked', async () => {
  const name = slot('a', 'one');
  const path = join(journals(), name);
  mkdirSync(path);
  writeFileSync(join(path, 'marker'), 'original');
  const inspection = await inspectLifecycleJournal();
  if (inspection.status !== 'unreadable-entries')
    throw new Error(`Unexpected ${inspection.status}`);
  const [entry] = inspection.entries;
  if (!entry) throw new Error('Missing entry');

  mockInstallHook = async (from, to, install): Promise<void> => {
    rmSync(path, { recursive: true });
    mkdirSync(path);
    writeFileSync(join(path, 'marker'), 'replacement');
    await install(from, to);
    mockFailLstatPath = path;
  };
  await expect(
    quarantineLifecycleJournalEntry({ name, identity: entry.identity }),
  ).rejects.toMatchObject({
    reason: 'unconfirmed',
    message: PUT_BACK_UNCONFIRMED,
  });
  expect(mockFailLstatPath).toBeUndefined();
  expect(existsSync(path)).toBe(false);
  const [kept, ...rest] = quarantined();
  expect(rest).toEqual([]);
  if (!kept) throw new Error('Missing quarantined entry');
  expect(
    readFileSync(join(getW5QuarantinedLifecycleDir(), kept, 'marker'), 'utf8'),
  ).toBe('replacement');
});

it('leaves no quarantine name for a file put back after its identity check failed', async () => {
  const name = slot('a', 'one');
  const path = join(journals(), name);
  writeFileSync(path, '{broken');
  const original = lstatSync(path);
  const inspection = await inspectLifecycleJournal();
  if (inspection.status !== 'unreadable-entries')
    throw new Error(`Unexpected ${inspection.status}`);
  const [entry] = inspection.entries;
  if (!entry) throw new Error('Missing entry');

  mockInstallHook = async (from, to, install): Promise<void> => {
    await install(from, to);
    // The quarantine link can't be examined right after the journal name moves.
    mockJournalNameRemovalHook = (): void => {
      mockFailLstatPath = to;
    };
  };
  await expect(
    quarantineLifecycleJournalEntry({ name, identity: entry.identity }),
  ).rejects.toMatchObject({ reason: 'changed' });
  expect(mockFailLstatPath).toBeUndefined();
  const restored = lstatSync(path);
  expect([restored.dev, restored.ino]).toEqual([original.dev, original.ino]);
  expect(readFileSync(path, 'utf8')).toBe('{broken');
  // Only its journal name is left, so it isn't also reported as quarantined.
  expect(quarantined()).toEqual([]);
});

it('claims a fresh folder name for a directory when the first is taken', async () => {
  const name = slot('b');
  const path = join(journals(), name);
  mkdirSync(path);
  writeFileSync(join(path, 'inner.txt'), 'keep me');
  const inspection = await inspectLifecycleJournal();
  if (inspection.status !== 'unreadable-entries')
    throw new Error(`Unexpected ${inspection.status}`);
  const [entry] = inspection.entries;
  if (!entry) throw new Error('Missing entry');

  let taken: string | undefined;
  mockClaimFolderHook = (claim): void => {
    taken = claim;
    mkdirSync(claim);
    writeFileSync(join(claim, 'earlier.txt'), 'an earlier record');
  };
  const result = await quarantineLifecycleJournalEntry({
    name,
    identity: entry.identity,
  });
  if (!taken) throw new Error('The claim hook did not run');
  expect(readdirSync(taken)).toEqual(['earlier.txt']);
  const moved = join(getW5QuarantinedLifecycleDir(), result.quarantinedName);
  expect(moved).not.toBe(taken);
  expect(readFileSync(join(moved, 'inner.txt'), 'utf8')).toBe('keep me');
  expect(existsSync(path)).toBe(false);
});

it('moves a file by rename where the volume refuses a hard link', async () => {
  const name = slot('a', 'one');
  const path = join(journals(), name);
  writeFileSync(path, '{broken');
  const { ino } = lstatSync(path);
  const inspection = await inspectLifecycleJournal();
  if (inspection.status !== 'unreadable-entries')
    throw new Error(`Unexpected ${inspection.status}`);
  const [entry] = inspection.entries;
  if (!entry) throw new Error('Missing entry');

  mockInstallHook = (from, to, install, operation): Promise<void> =>
    operation === 'link'
      ? Promise.reject(
          Object.assign(new Error('Operation not permitted'), {
            code: 'EPERM',
          }),
        )
      : install(from, to);
  const result = await quarantineLifecycleJournalEntry({
    name,
    identity: entry.identity,
  });
  const moved = join(getW5QuarantinedLifecycleDir(), result.quarantinedName);
  expect(lstatSync(moved).ino).toBe(ino);
  expect(readFileSync(moved, 'utf8')).toBe('{broken');
  expect(quarantined()).toEqual([result.quarantinedName]);
  expect(existsSync(path)).toBe(false);
});

it('refuses an entry that became readable, a missing entry and an unverifiable identity', async () => {
  const name = slot('b');
  const path = join(journals(), name);
  writeFileSync(path, '{broken');
  const inspection = await inspectLifecycleJournal();
  if (inspection.status !== 'unreadable-entries')
    throw new Error(`Unexpected ${inspection.status}`);
  const [entry] = inspection.entries;
  if (!entry) throw new Error('Missing entry');

  await expect(
    quarantineLifecycleJournalEntry({
      name,
      identity: `unverifiable:${entry.identity}`,
    }),
  ).rejects.toMatchObject({ reason: 'unverifiable' });

  // Same inode, now a valid journal: it is attributable again, not moved.
  writeFileSync(
    path,
    JSON.stringify({
      version: 1,
      operationId: randomUUID(),
      operation: 'workspace-delete',
      workspaceId: 'b',
      directoryIdentity: null,
      state: 'completed',
      steps: [],
    }),
  );
  await expect(
    quarantineLifecycleJournalEntry({ name, identity: entry.identity }),
  ).rejects.toMatchObject({ reason: 'readable' });
  expect(existsSync(path)).toBe(true);

  rmSync(path);
  await expect(
    quarantineLifecycleJournalEntry({ name, identity: entry.identity }),
  ).rejects.toMatchObject({ reason: 'missing' });
  await expect(
    quarantineLifecycleJournalEntry({
      name: '../escape.json',
      identity: entry.identity,
    }),
  ).rejects.toThrow('Invalid operation record request.');
  expect(quarantined()).toEqual([]);
});

posixIt(
  'an interrupted move leaves the original in place for a later retry',
  async () => {
    const name = slot('a', 'one');
    const path = join(journals(), name);
    writeFileSync(path, '{broken');
    const { ino } = lstatSync(path);
    const inspection = await inspectLifecycleJournal();
    if (inspection.status !== 'unreadable-entries')
      throw new Error(`Unexpected ${inspection.status}`);
    const [entry] = inspection.entries;
    if (!entry) throw new Error('Missing entry');

    mkdirSync(getW5QuarantinedLifecycleDir(), { mode: 0o500 });
    await expect(
      quarantineLifecycleJournalEntry({ name, identity: entry.identity }),
    ).rejects.toMatchObject({
      reason: 'failed',
      message: "Couldn't move the record. It's still where it was. Try again.",
    });
    expect(readFileSync(path, 'utf8')).toBe('{broken');
    expect(lstatSync(path).ino).toBe(ino);
    await expect(refusal(deleteB())).resolves.toMatchObject({
      message: LIFECYCLE_JOURNAL_UNREADABLE_REFUSAL,
    });

    chmodSync(getW5QuarantinedLifecycleDir(), 0o700);
    await quarantineLifecycleJournalEntry({ name, identity: entry.identity });
    expect(existsSync(path)).toBe(false);
    await expect(deleteB()).resolves.toBeDefined();
  },
);

it('a file at the quarantine location fails the move and keeps the original', async () => {
  const name = slot('b');
  const path = join(journals(), name);
  writeFileSync(path, '{broken');
  writeFileSync(getW5QuarantinedLifecycleDir(), 'not a folder');
  const inspection = await inspectLifecycleJournal();
  if (inspection.status !== 'unreadable-entries')
    throw new Error(`Unexpected ${inspection.status}`);
  const [entry] = inspection.entries;
  if (!entry) throw new Error('Missing entry');
  await expect(
    quarantineLifecycleJournalEntry({ name, identity: entry.identity }),
  ).rejects.toBeDefined();
  expect(readFileSync(path, 'utf8')).toBe('{broken');
  expect(readFileSync(getW5QuarantinedLifecycleDir(), 'utf8')).toBe(
    'not a folder',
  );
});

posixIt(
  'an unlistable journal directory is refused and reported, never quarantined',
  async () => {
    writeFileSync(join(journals(), slot('a', 'one')), '{broken');
    chmodSync(journals(), 0o000);
    const error = await refusal(deleteB());
    expect(error.message).toBe(LIFECYCLE_JOURNAL_DIRECTORY_UNREADABLE_REFUSAL);
    expect(error.details).toEqual({
      phase: 'lifecycle-journal',
      check: 'journal-directory-unreadable',
    });
    expect(lifecycleJournalRefusalKind(error)).toBe('directory-unreadable');
    // Worktree removal reads its own slot first; that read must report the same.
    for (const work of [
      (): Promise<unknown> => archiveWorktree(archiveTwo),
      deleteOne,
    ]) {
      const worktreeError = await refusal(work());
      expect(worktreeError.message).toBe(
        LIFECYCLE_JOURNAL_DIRECTORY_UNREADABLE_REFUSAL,
      );
      expect(lifecycleJournalRefusalKind(worktreeError)).toBe(
        'directory-unreadable',
      );
    }
    await expect(inspectLifecycleJournal()).resolves.toEqual({
      status: 'directory-unreadable',
      locationLabel: '<data>/w5/destructive-lifecycles',
    });
    chmodSync(journals(), 0o700);
    expect(existsSync(getWorkspaceDir('b'))).toBe(true);
    expect(existsSync(join(root, 'a', 'worktrees', 'one'))).toBe(true);
  },
);

posixIt(
  'a listable but unsearchable journal directory refuses and reviews as unlistable',
  async () => {
    writeFileSync(join(journals(), slot('a', 'one')), '{broken');
    // Names can be listed, but no entry can be opened or examined.
    chmodSync(journals(), 0o600);
    for (const work of [
      deleteB,
      (): Promise<unknown> => archiveWorktree(archiveTwo),
    ])
      await expect(refusal(work())).resolves.toMatchObject({
        message: LIFECYCLE_JOURNAL_DIRECTORY_UNREADABLE_REFUSAL,
      });
    await expect(inspectLifecycleJournal()).resolves.toEqual({
      status: 'directory-unreadable',
      locationLabel: '<data>/w5/destructive-lifecycles',
    });
    chmodSync(journals(), 0o700);
    expect(existsSync(getWorkspaceDir('b'))).toBe(true);
  },
);

it('a journal path that is a file is refused as an unlistable directory', async () => {
  rmSync(journals(), { recursive: true });
  writeFileSync(journals(), 'not a folder');
  for (const work of [
    deleteB,
    (): Promise<unknown> => archiveWorktree(archiveTwo),
    deleteOne,
  ])
    await expect(refusal(work())).resolves.toMatchObject({
      message: LIFECYCLE_JOURNAL_DIRECTORY_UNREADABLE_REFUSAL,
    });
  await expect(inspectLifecycleJournal()).resolves.toMatchObject({
    status: 'directory-unreadable',
  });
});

it('diagnosis reports a quarantined entry as quarantined, not an unknown artifact', async () => {
  const name = slot('a', 'one');
  writeFileSync(join(journals(), name), '{broken');
  const inspection = await inspectLifecycleJournal();
  if (inspection.status !== 'unreadable-entries')
    throw new Error(`Unexpected ${inspection.status}`);
  const [entry] = inspection.entries;
  if (!entry) throw new Error('Missing entry');
  const { quarantinedName } = await quarantineLifecycleJournalEntry({
    name,
    identity: entry.identity,
  });
  const diagnosis = await diagnoseW5State(join(dir, 'data'));
  expect(diagnosis.files).toContainEqual({
    path: `w5/quarantined-lifecycles/${quarantinedName}`,
    reason: 'quarantined-journal',
  });
  expect(
    diagnosis.files.filter((issue) =>
      issue.path.startsWith('w5/quarantined-lifecycles'),
    ),
  ).toEqual([
    {
      path: `w5/quarantined-lifecycles/${quarantinedName}`,
      reason: 'quarantined-journal',
    },
  ]);
});

it('projects only paths inside the home folder to a display label', () => {
  expect(
    lifecycleJournalLocationLabel('/Users/me/data/w5', '/Users/me', 'darwin'),
  ).toBe('~/data/w5');
  expect(
    lifecycleJournalLocationLabel('/Users/me/data/w5', '/Users/me/', 'linux'),
  ).toBe('~/data/w5');
  expect(
    lifecycleJournalLocationLabel('/Users/melody/w5', '/Users/me', 'darwin'),
  ).toBe('/Users/melody/w5');
  expect(lifecycleJournalLocationLabel('/srv/w5', '', 'linux')).toBe('/srv/w5');
  expect(
    lifecycleJournalLocationLabel(
      'c:\\users\\me\\AppData\\w5',
      'C:\\Users\\Me',
      'win32',
    ),
  ).toBe('%USERPROFILE%\\AppData\\w5');
});

it('keeps Portal labels path-free for a data folder outside the home folder', async () => {
  jest
    .spyOn(jest.requireActual<typeof Os>('node:os'), 'homedir')
    .mockReturnValue(join(dir, 'elsewhere'));
  const name = slot('a', 'one');
  writeFileSync(join(journals(), name), '{broken');
  const inspection = await inspectLifecycleJournal();
  if (inspection.status !== 'unreadable-entries')
    throw new Error(`Unexpected ${inspection.status}`);
  expect(inspection.locationLabel).toBe('<data>/w5/destructive-lifecycles');
  expect(inspection.quarantineLocationLabel).toBe(
    '<data>/w5/quarantined-lifecycles',
  );
  expect(JSON.stringify(inspection)).not.toContain(dir);
  const [entry] = inspection.entries;
  if (!entry) throw new Error('Missing entry');
  const result = await quarantineLifecycleJournalEntry({
    name,
    identity: entry.identity,
  });
  expect(result.quarantineLocationLabel).toBe(
    '<data>/w5/quarantined-lifecycles',
  );
  expect(JSON.stringify(result)).not.toContain(dir);
  // The desktop's own host adapter may still show its local location.
  await expect(
    inspectLifecycleJournal(lifecycleJournalLocationLabel),
  ).resolves.toEqual({ status: 'clear', locationLabel: journals() });
});

it('projects a portable label relative to the data folder only', () => {
  expect(
    portableLifecycleJournalLocationLabel('/srv/data/w5/x', '/srv/data'),
  ).toBe('<data>/w5/x');
  expect(portableLifecycleJournalLocationLabel('/srv/data', '/srv/data')).toBe(
    '<data>',
  );
  expect(
    portableLifecycleJournalLocationLabel('/srv/other/w5', '/srv/data'),
  ).toBe('<data>/…/w5');
  expect(
    portableLifecycleJournalLocationLabel('/srv/data/..w5', '/srv/data'),
  ).toBe('<data>/..w5');
});

it('labels by the core-platform host OS when no platform is passed', () => {
  const host = jest.spyOn(hostPlatform, 'hostOperatingSystem');
  try {
    host.mockReturnValue('win32');
    expect(
      lifecycleJournalLocationLabel('C:\\Users\\Me\\w5', 'C:\\Users\\Me'),
    ).toBe('%USERPROFILE%\\w5');
    host.mockReturnValue(null);
    expect(lifecycleJournalLocationLabel('/home/me/w5', '/home/me')).toBe(
      '~/w5',
    );
  } finally {
    host.mockRestore();
  }
});
