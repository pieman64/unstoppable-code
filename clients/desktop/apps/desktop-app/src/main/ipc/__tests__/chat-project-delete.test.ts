// G1 (CAN-4978): the real `chat-project:delete` IPC handler, driven headlessly
// through its Electron registration, against the real canonical deletion,
// commit-log worker and files. Browser profiles, App Advisor watchers, chat
// search, the Ledger, observability and Portal sync stay substituted, as in
// the W6c2 suites; telemetry is the observed sink.
import type * as DesktopTelemetry from '../../lib/desktop-telemetry';
import type * as TsxWorkerThreads from '../../ledger/__tests__/fixtures/tsx-worker-threads';
import type * as FsPromises from 'node:fs/promises';
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
    interruptMatchingEntries: jest.fn(),
  })),
}));
jest.mock('../../portal/portal-structural-sync', () => ({
  schedulePortalStructuralSync: jest.fn(),
}));
jest.mock('../../portal/portal-event-bus', () => ({
  notifyPortalStructureChanged: jest.fn(),
}));
jest.mock('../../lib/desktop-telemetry', () => ({
  ...jest.requireActual<typeof DesktopTelemetry>('../../lib/desktop-telemetry'),
  recordWorkspaceCrudTelemetry: jest.fn(),
  recordStandaloneProjectCrudTelemetry: jest.fn(),
}));

import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { BrowserWindow, ipcMain, type IpcMainInvokeEvent } from 'electron';
import {
  DEFAULT_COWORK_WORKSPACE_ID,
  IPC_CHANNELS,
  orgDefaultCoworkWorkspaceId,
  STANDALONE_CHAT_PROJECT_ID,
} from '@canopy/desktop-shared/types';
import { settleDetachedWork } from '@canopy/desktop-shared/node/lib/detached-work';
import { createW5BoundaryFixture } from '../../lib/__tests__/fixtures/w5-boundary-fixture';
import { shutdownW5BoundaryHost } from '../../lib/__tests__/fixtures/w5-boundary-host';
import { createLiveBackgroundTaskOwner } from './background-work-removal-test-helpers';
import { W5CommitLogHost } from '../../w5-commit-log/commit-log-host';
import {
  createW5CommitLogFileStore,
  __setDesktopW5FileStoreForTests,
} from '../../lib/w5-commit-log-file-store';
import { nodeW5FileStore } from '../../lib/w5-file-store';
import {
  __resetSidebarItemsStateForTests,
  readAllSidebarItems,
} from '../../lib/sidebar-items';
import { getWorkspaceExternalPath } from '../../lib/workspace-registry';
import { resetChatStateServiceForTests } from '../../services/chat-state-service';
import { readDestructiveRecovery } from '../../lib/w5-destructive-recovery';
import {
  activateWorkEntryWorkspace,
  createWorkEntry,
} from '../../lib/cowork-work-entries';
import {
  coworkMigrationMapTestExports,
  writeCoworkMigrationMap,
} from '../../lib/cowork-migration-map';
import { getWorkspaceDir } from '../../lib/paths';
import * as atomicFile from '../../lib/atomic-file';
import { getAppAdvisorWatcherService } from '../../app-advisor/watchers';
import { getFingerprintStore } from '../../skill-suggestions/fingerprint-store';
import { setDelegationActivity } from '../../agents/delegation/activity';
import * as sessionManager from '../../agents/session-manager';
import {
  recordStandaloneProjectCrudTelemetry,
  recordWorkspaceCrudTelemetry,
} from '../../lib/desktop-telemetry';
import { registerChatProjectHandlers } from '../chat-projects';
import { createWorkspaceLifecycleTestDispatcher } from '../../__tests__/fixtures/workspace-lifecycle-dispatcher';
import { TEST_IPC_CALLER } from '../../__tests__/fixtures/workspace-metadata-dispatcher';

jest.setTimeout(60_000);

const fsPromises = jest.requireActual<typeof FsPromises>('node:fs/promises');

const DELEGATES_REFUSAL = 'Delegates are still running here. Stop them first.';
const BACKGROUND_REFUSAL =
  'Background agents or workflows are still running here. Stop them first.';

let dir: string;
let root: string;
let repo: string;
let host: W5CommitLogHost;
let originalDataDir: string | undefined;
let deleteChatProject: (request: unknown) => Promise<unknown>;

const indexFileSchema = z.object({
  version: z.number(),
  workspaces: z.array(z.object({ id: z.string() }).passthrough()),
});
function indexIds(): string[] {
  return indexFileSchema
    .parse(JSON.parse(readFileSync(join(root, 'index.json'), 'utf8')))
    .workspaces.map((entry) => entry.id);
}
/** Every canonical file the refusals must leave byte-identical. */
function canonicalImages(): string[] {
  return [
    'index.json',
    'a/workspace.json',
    'a/worktrees.json',
    'b/workspace.json',
    'c/workspace.json',
  ].map((file) => readFileSync(join(root, file), 'utf8'));
}

/** Adds Cowork project `c` beside code projects `a` and `b`. */
function addCowork(id: string, config: Record<string, unknown> = {}): void {
  const index = indexFileSchema.parse(
    JSON.parse(readFileSync(join(root, 'index.json'), 'utf8')),
  );
  writeFileSync(
    join(root, 'index.json'),
    JSON.stringify({
      version: 1,
      workspaces: [
        ...index.workspaces,
        {
          id,
          name: `Cowork ${id}`,
          type: 'cowork',
          color: '#7C3AED',
          collapsed: false,
          order: index.workspaces.length,
        },
      ],
    }),
  );
  mkdirSync(join(root, id), { recursive: true });
  writeFileSync(
    join(root, id, 'workspace.json'),
    JSON.stringify({ version: 1, type: 'cowork', repos: [], ...config }),
  );
  // As creation does: an earlier case's deletion of this id leaves it
  // refused for Work Entry writes in this module instance.
  activateWorkEntryWorkspace(id);
  __resetSidebarItemsStateForTests();
}

/** The production handler, captured from its Electron registration only. */
function captureDeleteHandler(): (request: unknown) => Promise<unknown> {
  const handlers = new Map<string, Parameters<typeof ipcMain.handle>[1]>();
  const handleSpy = jest
    .spyOn(ipcMain, 'handle')
    .mockImplementation((channel, handler) => {
      handlers.set(channel, handler);
    });
  try {
    registerChatProjectHandlers({
      // Chat project delete projects core.workspace.delete (W7b-2a).
      dispatcher: createWorkspaceLifecycleTestDispatcher(),
      resolveCaller: () => TEST_IPC_CALLER,
    });
  } finally {
    handleSpy.mockRestore();
  }
  const handler = handlers.get(IPC_CHANNELS.chatProjectDelete);
  if (!handler) throw new Error('chat-project:delete was not registered');
  const event = {
    sender: new BrowserWindow().webContents,
  } as IpcMainInvokeEvent;
  return async (request) => (await handler(event, request)) as unknown;
}

function setProviderTasks(
  owners: ReturnType<typeof createLiveBackgroundTaskOwner>[],
): void {
  jest
    .spyOn(sessionManager, 'listLiveBackgroundTaskOwners')
    .mockReturnValue(owners);
  jest
    .spyOn(sessionManager, 'getLiveBackgroundTasksForChat')
    .mockImplementation(
      (projectId, worktreeId, chatId) =>
        owners.find(
          (owner) =>
            owner.projectId === projectId &&
            owner.worktreeId === worktreeId &&
            owner.chatId === chatId,
        )?.liveTasks,
    );
}

beforeEach(() => {
  resetChatStateServiceForTests();
  ({ dir, root, repo } = createW5BoundaryFixture(
    (createdAt) => [{ id: 'one', branchName: 'old', createdAt }],
    ['b'],
  ));
  originalDataDir = process.env.CANOPY_DATA_DIR;
  process.env.CANOPY_DATA_DIR = join(dir, 'data');
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
  addCowork('c');
  host = new W5CommitLogHost({
    dbPath: join(dir, 'w5', 'commit-log.sqlite'),
    root,
    workerEntry: join(__dirname, '../../w5-commit-log/commit-log-worker.ts'),
  });
  __setDesktopW5FileStoreForTests(createW5CommitLogFileStore(() => host));
  deleteChatProject = captureDeleteHandler();
  jest.clearAllMocks();
});

afterEach(async () => {
  await settleDetachedWork();
  coworkMigrationMapTestExports.resetCache();
  __setDesktopW5FileStoreForTests(nodeW5FileStore);
  await shutdownW5BoundaryHost(host, join(dir, 'w5', 'commit-log.sqlite'));
  if (originalDataDir === undefined) delete process.env.CANOPY_DATA_DIR;
  else process.env.CANOPY_DATA_DIR = originalDataDir;
  rmSync(dir, { recursive: true, force: true });
  jest.restoreAllMocks();
});

describe('chat-project:delete (headless, canonical deletion)', () => {
  it('deletes a Cowork project, its sessions and directory, and records both telemetry events', async () => {
    const { entry } = await createWorkEntry('c', { title: 'Entry' });
    // Non-blocking provider work in both scopes does not refuse the deletion.
    setProviderTasks([
      createLiveBackgroundTaskOwner('c', entry.id, 'chat-a', 'local_bash'),
      createLiveBackgroundTaskOwner(
        STANDALONE_CHAT_PROJECT_ID,
        'c',
        'chat-b',
        'local_bash',
      ),
    ]);
    const destroy = jest.spyOn(sessionManager, 'destroyWorktreeSessions');
    const kept = ['a/workspace.json', 'b/workspace.json'].map((file) =>
      readFileSync(join(root, file), 'utf8'),
    );

    await expect(
      deleteChatProject({ projectId: 'c', chatDisposition: 'move' }),
    ).resolves.toBeUndefined();

    expect(destroy.mock.calls).toEqual([
      ['c', entry.id],
      ['c', 'home'],
      [STANDALONE_CHAT_PROJECT_ID, 'c'],
    ]);
    expect(indexIds()).toEqual(['a', 'b']);
    expect(existsSync(getWorkspaceDir('c'))).toBe(false);
    expect(
      ['a/workspace.json', 'b/workspace.json'].map((file) =>
        readFileSync(join(root, file), 'utf8'),
      ),
    ).toEqual(kept);
    expect(existsSync(join(root, 'a', 'worktrees', 'one'))).toBe(true);
    expect((await readDestructiveRecovery('c'))?.state).toBe('completed');
    const workspaceCrud = jest.mocked(recordWorkspaceCrudTelemetry);
    const standaloneCrud = jest.mocked(recordStandaloneProjectCrudTelemetry);
    expect(workspaceCrud.mock.calls).toEqual([
      [{ action: 'delete', workspaceId: 'c', source: 'chat_project_delete' }],
    ]);
    expect(standaloneCrud.mock.calls).toEqual([
      [{ action: 'delete', projectId: 'c', chatDisposition: 'move' }],
    ]);
    expect(workspaceCrud.mock.invocationCallOrder[0]).toBeLessThan(
      standaloneCrud.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it('completes without cleanup required when only the skill suggestion purge fails (CAN-4962)', async () => {
    const purge = jest
      .spyOn(getFingerprintStore(), 'purgeWorkspace')
      .mockRejectedValueOnce(new Error('EIO'));

    await expect(
      deleteChatProject({ projectId: 'c', chatDisposition: 'move' }),
    ).resolves.toBeUndefined();

    expect(purge).toHaveBeenCalledTimes(1);
    expect(indexIds()).toEqual(['a', 'b']);
    const record = await readDestructiveRecovery('c');
    expect(record?.state).toBe('completed');
    expect(record?.cleanupRequired).toBeUndefined();
  });

  it('resolves a legacy chat-project id to its Cowork project id', async () => {
    await writeCoworkMigrationMap({ 'legacy-c': 'c' });

    await deleteChatProject({
      projectId: 'legacy-c',
      chatDisposition: 'delete',
    });

    expect(indexIds()).toEqual(['a', 'b']);
    expect(existsSync(getWorkspaceDir('c'))).toBe(false);
    expect(
      jest.mocked(recordStandaloneProjectCrudTelemetry),
    ).toHaveBeenCalledWith({
      action: 'delete',
      projectId: 'c',
      chatDisposition: 'delete',
    });
  });

  it('detaches an external Cowork project without touching its folder', async () => {
    const folder = join(dir, 'attached-folder');
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, 'notes.md'), 'user data');
    addCowork('e', { externalPath: folder });
    await readAllSidebarItems();
    expect(getWorkspaceExternalPath('e')).toBe(folder);

    await deleteChatProject({ projectId: 'e', chatDisposition: 'delete' });

    expect(indexIds()).toEqual(['a', 'b', 'c']);
    expect(existsSync(getWorkspaceDir('e'))).toBe(false);
    expect(readFileSync(join(folder, 'notes.md'), 'utf8')).toBe('user data');
    // The whole-sidebar write used to refresh the registry; the canonical
    // post-commit sidebar read now does.
    expect(getWorkspaceExternalPath('e')).toBe(null);
    expect(
      jest.mocked(recordStandaloneProjectCrudTelemetry).mock.calls,
    ).toEqual([
      [{ action: 'delete', projectId: 'e', chatDisposition: 'delete' }],
    ]);
  });

  it('serializes concurrent deletes: the second is refused as not found', async () => {
    const results = await Promise.allSettled([
      deleteChatProject({ projectId: 'c', chatDisposition: 'delete' }),
      deleteChatProject({ projectId: 'c', chatDisposition: 'delete' }),
    ]);

    expect(results[0]).toEqual({ status: 'fulfilled', value: undefined });
    expect(results[1]).toMatchObject({
      status: 'rejected',
      reason: { reason: 'not-cowork', message: 'Chat project not found' },
    });
    expect(indexIds()).toEqual(['a', 'b']);
    expect((await readDestructiveRecovery('c'))?.state).toBe('completed');
    expect(jest.mocked(recordWorkspaceCrudTelemetry)).toHaveBeenCalledTimes(1);
    expect(
      jest.mocked(recordStandaloneProjectCrudTelemetry),
    ).toHaveBeenCalledTimes(1);
  });

  describe('refuses before any effect, with no telemetry', () => {
    async function expectRefusedWithoutEffects(
      request: unknown,
      refusal: string | Record<string, unknown>,
    ): Promise<void> {
      const destroy = jest.spyOn(sessionManager, 'destroyWorktreeSessions');
      const before = canonicalImages();

      const deletion = deleteChatProject(request);
      if (typeof refusal === 'string')
        await expect(deletion).rejects.toThrow(refusal);
      else await expect(deletion).rejects.toMatchObject(refusal);

      expect(destroy).not.toHaveBeenCalled();
      expect(canonicalImages()).toEqual(before);
      expect(existsSync(join(root, 'a', 'worktrees', 'one'))).toBe(true);
      for (const id of ['a', 'c'])
        expect(await readDestructiveRecovery(id)).toBe(null);
      expect(jest.mocked(recordWorkspaceCrudTelemetry)).not.toHaveBeenCalled();
      expect(
        jest.mocked(recordStandaloneProjectCrudTelemetry),
      ).not.toHaveBeenCalled();
    }

    // P1(a): the pre-G1 route tore down sessions before this refusal.
    it.each([
      ['a code project', 'a'],
      ['an unindexed id', 'zz'],
    ])('%s as "Chat project not found"', async (_label, projectId) => {
      await expectRefusedWithoutEffects(
        { projectId, chatDisposition: 'delete' },
        {
          name: 'WorkspaceDeletionRefusedError',
          reason: 'not-cowork',
          message: 'Chat project not found',
        },
      );
    });

    it.each([
      ['the Personal', DEFAULT_COWORK_WORKSPACE_ID],
      [
        'an organization',
        orgDefaultCoworkWorkspaceId('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
      ],
    ])('%s default Chats project', async (_label, projectId) => {
      await expectRefusedWithoutEffects(
        { projectId, chatDisposition: 'delete' },
        {
          name: 'WorkspaceDeletionRefusedError',
          reason: 'protected',
          message: 'The Chats project cannot be deleted',
        },
      );
    });

    // CAN-4975: the unreadable `externalPath` leaves no overlap to check.
    it('a Cowork project whose configuration is unreadable', async () => {
      writeFileSync(join(root, 'c', 'workspace.json'), '{truncated');
      __resetSidebarItemsStateForTests();

      await expectRefusedWithoutEffects(
        { projectId: 'c', chatDisposition: 'delete' },
        {
          name: 'WorkspaceDeletionRefusedError',
          reason: 'configuration-unavailable',
        },
      );
      expect(indexIds()).toEqual(['a', 'b', 'c']);
    });

    it('an invalid chatDisposition', async () => {
      await expectRefusedWithoutEffects(
        { projectId: 'c', chatDisposition: 'bogus' },
        'Invalid chatDisposition',
      );
    });

    it('an invalid project id', async () => {
      await expectRefusedWithoutEffects(
        { projectId: '../c', chatDisposition: 'delete' },
        { name: 'IdentifierValidationError' },
      );
    });

    it.each([
      ['a Work Entry chat', 'c/entry-1/chat-a'],
      ['a sentinel-keyed chat', `${STANDALONE_CHAT_PROJECT_ID}/c/chat-a`],
    ])('while %s has live delegates', async (_label, sessionKey) => {
      setDelegationActivity('g1-delegates', sessionKey, 1);
      try {
        await expectRefusedWithoutEffects(
          { projectId: 'c', chatDisposition: 'delete' },
          { code: 'conflict', message: DELEGATES_REFUSAL },
        );
      } finally {
        setDelegationActivity('g1-delegates', sessionKey, 0);
      }
      // The refusal is not sticky: the same request succeeds afterwards.
      await deleteChatProject({ projectId: 'c', chatDisposition: 'delete' });
      expect(indexIds()).toEqual(['a', 'b']);
    });

    it.each([
      ['local_agent', 'c', 'entry-1'],
      ['local_workflow', 'c', 'entry-1'],
      ['local_agent', STANDALONE_CHAT_PROJECT_ID, 'c'],
      ['local_workflow', STANDALONE_CHAT_PROJECT_ID, 'c'],
    ] as const)(
      'while a %s runs in the %s/%s scope',
      async (taskType, projectId, worktreeId) => {
        setProviderTasks([
          createLiveBackgroundTaskOwner(
            projectId,
            worktreeId,
            'chat-provider',
            taskType,
          ),
        ]);
        await expectRefusedWithoutEffects(
          { projectId: 'c', chatDisposition: 'delete' },
          { code: 'conflict', message: BACKGROUND_REFUSAL },
        );
      },
    );

    it('with sentinel delegate copy ahead of workspace-scope provider work', async () => {
      setProviderTasks([
        createLiveBackgroundTaskOwner('c', 'entry-1', 'chat-p', 'local_agent'),
      ]);
      const sessionKey = `${STANDALONE_CHAT_PROJECT_ID}/c/chat-delegate`;
      setDelegationActivity('g1-precedence', sessionKey, 1);
      try {
        await expectRefusedWithoutEffects(
          { projectId: 'c', chatDisposition: 'delete' },
          { code: 'conflict', message: DELEGATES_REFUSAL },
        );
      } finally {
        setDelegationActivity('g1-precedence', sessionKey, 0);
      }
    });
  });

  it('propagates a failure after the session teardown without the adapter telemetry', async () => {
    addCowork('o', { externalPath: getWorkspaceDir('o') });
    const destroy = jest.spyOn(sessionManager, 'destroyWorktreeSessions');

    await expect(
      deleteChatProject({ projectId: 'o', chatDisposition: 'delete' }),
    ).rejects.toThrow(
      'Refusing to delete cowork project: its metadata directory and external folder overlap.',
    );

    expect(destroy).toHaveBeenCalledTimes(2);
    expect(indexIds()).toContain('o');
    expect(existsSync(join(root, 'o', 'workspace.json'))).toBe(true);
    expect((await readDestructiveRecovery('o'))?.state).toBe(
      'recovery-required',
    );
    expect(jest.mocked(recordWorkspaceCrudTelemetry)).not.toHaveBeenCalled();
    expect(
      jest.mocked(recordStandaloneProjectCrudTelemetry),
    ).not.toHaveBeenCalled();
  });

  // workspace_crud marks the durable removal, recorded inside the canonical
  // deletion before the watcher commit; the adapter event marks a resolved
  // request.
  it('propagates a watcher commit failure after removal with only the workspace event', async () => {
    const error = new Error('watcher commit failed');
    const watcherService = jest.mocked(getAppAdvisorWatcherService);
    const defaultWatcherService = watcherService.getMockImplementation();
    const watcher = watcherService();
    const cancel = jest.spyOn(watcher, 'cancelLocalWorkspace');
    const release = jest.spyOn(watcher, 'releaseLocalWorkspaceFence');
    jest
      .spyOn(watcher, 'commitLocalWorkspaceCancellation')
      .mockRejectedValue(error);
    watcherService.mockReturnValue(watcher);
    try {
      await expect(
        deleteChatProject({ projectId: 'c', chatDisposition: 'move' }),
      ).rejects.toBe(error);
    } finally {
      watcherService.mockImplementation(defaultWatcherService);
    }

    expect(indexIds()).toEqual(['a', 'b']);
    expect(existsSync(getWorkspaceDir('c'))).toBe(false);
    expect(cancel).toHaveBeenCalledWith('c');
    expect(release).not.toHaveBeenCalled();
    expect((await readDestructiveRecovery('c'))?.state).toBe(
      'recovery-required',
    );
    expect(jest.mocked(recordWorkspaceCrudTelemetry).mock.calls).toEqual([
      [{ action: 'delete', workspaceId: 'c', source: 'chat_project_delete' }],
    ]);
    expect(
      jest.mocked(recordStandaloneProjectCrudTelemetry),
    ).not.toHaveBeenCalled();

    // A retry is refused by the unresolved journal without either event.
    await expect(
      deleteChatProject({ projectId: 'c', chatDisposition: 'move' }),
    ).rejects.toMatchObject({ reason: 'recovery-required' });
    expect(jest.mocked(recordWorkspaceCrudTelemetry)).toHaveBeenCalledTimes(1);
    expect(
      jest.mocked(recordStandaloneProjectCrudTelemetry),
    ).not.toHaveBeenCalled();
  });

  it('propagates a directory removal failure after the index commit without either event', async () => {
    const error = new Error('directory removal failed');
    const removeFile = fsPromises.rm;
    jest.spyOn(fsPromises, 'rm').mockImplementation(async (path, options) => {
      if (String(path) === getWorkspaceDir('c')) throw error;
      await removeFile(path, options);
    });
    const watcherService = jest.mocked(getAppAdvisorWatcherService);
    const defaultWatcherService = watcherService.getMockImplementation();
    const watcher = watcherService();
    const release = jest.spyOn(watcher, 'releaseLocalWorkspaceFence');
    const commit = jest.spyOn(watcher, 'commitLocalWorkspaceCancellation');
    watcherService.mockReturnValue(watcher);
    try {
      await expect(
        deleteChatProject({ projectId: 'c', chatDisposition: 'move' }),
      ).rejects.toBe(error);
    } finally {
      watcherService.mockImplementation(defaultWatcherService);
    }

    expect(indexIds()).toEqual(['a', 'b']);
    expect(existsSync(join(root, 'c', 'workspace.json'))).toBe(true);
    // The failure is inside the deletion, so the fence is released.
    expect(release.mock.calls).toEqual([['c']]);
    expect(commit).not.toHaveBeenCalled();
    expect((await readDestructiveRecovery('c'))?.state).toBe(
      'recovery-required',
    );
    expect(jest.mocked(recordWorkspaceCrudTelemetry)).not.toHaveBeenCalled();
    expect(
      jest.mocked(recordStandaloneProjectCrudTelemetry),
    ).not.toHaveBeenCalled();

    // A retry is refused by the unresolved journal, still without either event.
    jest.mocked(fsPromises.rm).mockRestore();
    await expect(
      deleteChatProject({ projectId: 'c', chatDisposition: 'move' }),
    ).rejects.toMatchObject({ reason: 'recovery-required' });
    expect(existsSync(join(root, 'c', 'workspace.json'))).toBe(true);
    expect(jest.mocked(recordWorkspaceCrudTelemetry)).not.toHaveBeenCalled();
    expect(
      jest.mocked(recordStandaloneProjectCrudTelemetry),
    ).not.toHaveBeenCalled();
  });

  // After installation is the durable write's directory sync failing.
  it.each([
    {
      when: 'before the record is written',
      installs: false,
      journal: 'active',
      retry: { reason: 'recovery-required' },
    },
    {
      when: 'after the record is installed',
      installs: true,
      journal: 'completed',
      retry: { reason: 'not-cowork', message: 'Chat project not found' },
    },
  ])(
    'propagates a lifecycle completion save failure $when with only the workspace event',
    async ({ installs, journal, retry }) => {
      const error = new Error('completion save failed');
      const watcherService = jest.mocked(getAppAdvisorWatcherService);
      const defaultWatcherService = watcherService.getMockImplementation();
      const watcher = watcherService();
      const commit = jest.spyOn(watcher, 'commitLocalWorkspaceCancellation');
      watcherService.mockReturnValue(watcher);
      const write = atomicFile.writeFileAtomically;
      let commitsBeforeFailure: number | undefined;
      jest
        .spyOn(atomicFile, 'writeFileAtomically')
        .mockImplementation(async (file, contents, options) => {
          const completesDeletionOfC =
            commitsBeforeFailure === undefined &&
            file.includes('destructive-lifecycles') &&
            typeof contents === 'string' &&
            contents.includes('"operation":"workspace-delete"') &&
            contents.includes('"workspaceId":"c"') &&
            contents.includes('"state":"completed"');
          if (!completesDeletionOfC || installs)
            await write(file, contents, options);
          if (!completesDeletionOfC) return;
          commitsBeforeFailure = commit.mock.calls.length;
          throw error;
        });
      try {
        await expect(
          deleteChatProject({ projectId: 'c', chatDisposition: 'move' }),
        ).rejects.toBe(error);
      } finally {
        watcherService.mockImplementation(defaultWatcherService);
      }

      expect(commitsBeforeFailure).toBe(1);
      expect(commit).toHaveBeenCalledWith('c');
      expect(indexIds()).toEqual(['a', 'b']);
      expect(existsSync(getWorkspaceDir('c'))).toBe(false);
      const record = await readDestructiveRecovery('c');
      expect(record?.state).toBe(journal);
      expect(record?.steps).toContainEqual({
        phase: 'workspace-directory-removal',
        state: 'done',
      });
      expect(record?.steps.filter((step) => step.state === 'pending')).toEqual(
        [],
      );
      expect(jest.mocked(recordWorkspaceCrudTelemetry).mock.calls).toEqual([
        [{ action: 'delete', workspaceId: 'c', source: 'chat_project_delete' }],
      ]);
      expect(
        jest.mocked(recordStandaloneProjectCrudTelemetry),
      ).not.toHaveBeenCalled();

      // An unfinished journal refuses a retry; a completed one leaves the
      // project not found. Neither records another event.
      jest.mocked(atomicFile.writeFileAtomically).mockRestore();
      await expect(
        deleteChatProject({ projectId: 'c', chatDisposition: 'move' }),
      ).rejects.toMatchObject(retry);
      expect(jest.mocked(recordWorkspaceCrudTelemetry)).toHaveBeenCalledTimes(
        1,
      );
      expect(
        jest.mocked(recordStandaloneProjectCrudTelemetry),
      ).not.toHaveBeenCalled();
    },
  );
});
