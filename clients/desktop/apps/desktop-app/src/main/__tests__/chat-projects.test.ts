import type * as WorkspaceManifestModule from '../lib/workspace-manifest-repository';
import type {
  WorkspaceManifestRead,
  WorkspaceManifestRepository,
} from '../lib/workspace-manifest-repository';
import type {
  WorkspaceIndexRepository,
  WorkspaceIndexSnapshot,
  WorkspaceIndexChange,
} from '../lib/workspace-index-repository';
// Native profile transactions are exercised with real registries in browser-profile-service.test.ts.
jest.mock('../browser/browser-profile-lifecycle', () => ({
  prepareTaskBrowserRetirement: jest.fn(() =>
    Promise.resolve('profile-retirement'),
  ),
  commitTaskBrowserRetirement: jest.fn(() => Promise.resolve(false)),
  abortTaskBrowserRetirement: jest.fn(() => Promise.resolve()),
  settleFailedTaskBrowserRetirement: jest.fn(() => Promise.resolve()),
  prepareWorkspaceBrowserRetirement: jest.fn(() => Promise.resolve([])),
  retireRemovedBrowserTask: jest.fn(() => Promise.resolve()),
}));
jest.mock('node:fs/promises');
jest.mock('../lib/paths', () => ({
  getAppAdvisorWatchersFilePath: jest.fn(
    () => '/mock/app-advisor-watchers.json',
  ),
  getWorkspaceDir: jest.fn(
    (workspaceId: string) => `/mock/workspaces/${workspaceId}`,
  ),
  getWorkspaceConfigPath: jest.fn(
    (workspaceId: string) => `/mock/workspaces/${workspaceId}/workspace.json`,
  ),
  getCoworkWorkspaceRootDir: jest.fn(
    (workspaceId: string) => `/mock/workspaces/${workspaceId}/home`,
  ),
  getWorkspaceWorkEntriesFilePath: jest.fn(
    (workspaceId: string) =>
      `/mock/workspaces/${workspaceId}/work-entries.json`,
  ),
  // The locks of a Cowork settings decision (W7b-1c).
  getWorkspaceIndexFilePath: jest.fn(() => '/mock/workspaces/index.json'),
  getWorkspaceWorktreesFilePath: jest.fn(
    (workspaceId: string) => `/mock/workspaces/${workspaceId}/worktrees.json`,
  ),
}));
jest.mock('../ipc/register', () => ({
  registerIpcHandler: jest.fn(),
}));
jest.mock('../agents/session-manager', () => ({
  destroyWorktreeSessions: jest.fn().mockResolvedValue(undefined),
  getLiveBackgroundTasksForChat: jest.fn(),
  listLiveBackgroundTaskOwners: jest.fn(),
}));
jest.mock('../lib/chat-project-utils', () => ({
  ensureCoworkHomeScaffold: jest.fn().mockResolvedValue(undefined),
  syncChatProjectAgentsMd: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../lib/worktree-data-cleanup', () => ({
  cleanupPersistedWorktreeData: jest.fn().mockResolvedValue([]),
}));
jest.mock('../lib/fs-utils', () => ({
  isMissingFileError:
    jest.requireActual<typeof FsUtils>('../lib/fs-utils').isMissingFileError,
  pathExists: jest.fn().mockResolvedValue(false),
}));
jest.mock('../lib/cowork-migration-map', () => ({
  resolveCoworkWorkspaceId: jest.fn((id: string) => id),
}));
jest.mock('../lib/validation', () => ({
  validateId: jest.fn(),
  // Cowork settings saves classify their refusals with it (W7b-1c).
  IdentifierValidationError:
    jest.requireActual<typeof ValidationModule>('../lib/validation')
      .IdentifierValidationError,
}));
jest.mock('../lib/desktop-telemetry', () => ({
  recordStandaloneProjectCrudTelemetry: jest.fn(),
}));
jest.mock('../lib/workspace-deletion', () => ({
  deleteWorkspace: jest.fn(),
}));
// The real service schedules a timed flush. Left unmocked, it fired later in
// a reused Jest worker, against the mocked `../lib/paths`, and crashed the
// worker — a failure that never shows when this file runs alone.
const mockRecordAppDiagnostic = jest.fn();
const mockInstallDesktopWorkspaceTemplateCapabilityPackages = jest.fn();
jest.mock('../observability', () => ({
  getObservabilityService: (): { recordAppDiagnostic: jest.Mock } => ({
    recordAppDiagnostic: mockRecordAppDiagnostic,
  }),
}));
jest.mock('../plugins/workspace-template-import', () => ({
  resolveDesktopWorkspaceTemplate: jest.fn().mockResolvedValue({
    selections: {
      collectionIds: [],
      skillRefs: [],
      pluginRefs: [],
      mcpServerRefs: [],
    },
    unresolvedRefs: ['plugin:github:acme/tools:missing'],
  }),
  installDesktopWorkspaceTemplateCapabilityPackages: (
    ...args: unknown[]
  ): unknown => mockInstallDesktopWorkspaceTemplateCapabilityPackages(...args),
}));
jest.mock('../plugins/workspace-template-authoring', () => ({
  buildDesktopWorkspaceTemplateDocument: jest.fn(),
}));
jest.mock('../canopy-cloud/workspace-template-client', () => ({
  createWorkspaceTemplateShare: jest.fn(),
  getWorkspaceTemplateShareSnapshot: jest.fn(),
  listWorkspaceTemplateShares: jest.fn(),
  republishWorkspaceTemplateShare: jest.fn(),
  revokeWorkspaceTemplateShare: jest.fn(),
}));
jest.mock('../canopy-cloud/share-handoff-events', () => ({
  reportShareHandoffEvent: jest.fn().mockResolvedValue(undefined),
}));
const mockResolveBlueprintsForSeeding = jest.fn();
const mockCreateOrgCowork = jest.fn();
jest.mock('../lib/org-cowork-create-deps', () => ({
  getOrgCoworkCreator: (): { create: typeof mockCreateOrgCowork } => ({
    create: mockCreateOrgCowork,
  }),
}));
jest.mock('../blueprints/blueprint-catalog', () => ({
  listBlueprints: jest.fn().mockResolvedValue({
    blueprints: [],
    available: true,
  }),
  refreshBlueprints: jest.fn().mockResolvedValue([]),
  resolveBlueprintsForSeeding: (...args: unknown[]): Promise<unknown> =>
    Promise.resolve(mockResolveBlueprintsForSeeding(...args) as unknown),
}));

let mockSidebarItems: SidebarItem[] = [];
const mockConfigs = new Map<string, WorkspaceConfigFile>();
const mockPublishedWithoutConfig = new Set<string>();
function mockCoworkConfig(id: string): WorkspaceConfigFile | undefined {
  const saved = mockConfigs.get(id);
  if (saved || mockPublishedWithoutConfig.has(id)) return saved;
  const item = mockSidebarItems.find((item) => item.id === id);
  return item ? { ...item, version: 1, repos: [] } : undefined;
}
function mockApplyCoworkConfig(
  id: string,
  config: WorkspaceConfigFile,
): Promise<void> {
  mockConfigs.set(id, config);
  mockSidebarItems = mockSidebarItems.map((item) =>
    item.id === id ? { ...item, ...config, type: 'cowork' } : item,
  );
  return Promise.resolve();
}
const mockPersistCoworkConfig = jest.fn(mockApplyCoworkConfig);
const mockIndexCommit = jest.fn((entries: WorkspaceIndexEntry[]) => {
  for (const entry of entries)
    if (
      !mockSidebarItems.some((item) => item.id === entry.id) &&
      !mockConfigs.has(entry.id)
    )
      mockPublishedWithoutConfig.add(entry.id);
  mockSidebarItems = entries.map((entry) => ({
    ...mockCoworkConfig(entry.id),
    ...entry,
    type: 'cowork',
  }));
});
jest.mock('../lib/workspace-persistence', () => ({
  WorkspaceConfigUnreadableError: jest.requireActual<
    typeof WorkspaceManifestModule
  >('../lib/workspace-manifest-repository').WorkspaceConfigUnreadableError,
  getWorkspaceManifestRepository: (): Pick<
    WorkspaceManifestRepository,
    'read'
  > => ({
    read: (id: string): Promise<WorkspaceManifestRead> => {
      const document = mockCoworkConfig(id);
      return Promise.resolve(
        document
          ? {
              authority: 'ok',
              document: { ...document },
              raw: JSON.stringify(document),
            }
          : { authority: 'absent' },
      );
    },
  }),
  updateWorkspaceConfig: async <T>(
    id: string,
    update: (
      config: WorkspaceConfigFile,
      read: { authority: 'ok' | 'absent'; ownerMalformed: boolean },
    ) => T | Promise<T>,
    options?: { shouldWrite?: (result: T) => boolean },
  ): Promise<T> => {
    const existing = mockCoworkConfig(id);
    const config: WorkspaceConfigFile = existing
      ? structuredClone(existing)
      : { version: 1, type: 'multi-repo', repos: [] };
    const result = await update(config, {
      authority: existing ? 'ok' : 'absent',
      ownerMalformed: false,
    });
    if (!options?.shouldWrite || options.shouldWrite(result))
      await mockPersistCoworkConfig(id, config);
    return result;
  },
}));
jest.mock('../lib/sidebar-items', () => ({
  getWorkspaceIndexRepository: (): Pick<
    WorkspaceIndexRepository,
    'update'
  > => ({
    update: async <T>(
      change: (
        snapshot: WorkspaceIndexSnapshot,
      ) => WorkspaceIndexChange<T> | Promise<WorkspaceIndexChange<T>>,
    ): Promise<T> => {
      const entries = mockSidebarItems.map((item) => ({
        id: item.id,
        name: item.name,
        type: item.type,
        color: item.color,
        collapsed: item.collapsed,
        order: item.order,
      }));
      const result = await change({ entries, authority: 'ok' });
      if (result.entries) mockIndexCommit(result.entries);
      return result.result;
    },
  }),
  readAllSidebarItems: jest.fn(() =>
    Promise.resolve({
      version: 1,
      items: mockSidebarItems,
    }),
  ),
  readAllSidebarItemsSnapshot: jest.fn(() =>
    Promise.resolve({
      file: { version: 1, items: mockSidebarItems },
      authority: 'ok',
      indexAuthority: 'ok',
    }),
  ),
  readWorkspaceIndexEntry: jest.fn((workspaceId: string) =>
    Promise.resolve(
      mockSidebarItems.find((item) => item.id === workspaceId) ?? null,
    ),
  ),
  writeAllSidebarItems: jest.fn((items: SidebarItem[]) => {
    mockSidebarItems = items;
    return Promise.resolve({ version: 1, items });
  }),
}));

import { lstat, readFile, rm, stat, writeFile } from 'node:fs/promises';
import type * as FsUtils from '../lib/fs-utils';
import type * as ValidationModule from '../lib/validation';
import type {
  ChatProjectData,
  CoworkSidebarItem,
  SidebarItem,
  WorkspaceConfigFile,
  WorkspaceIndexEntry,
} from '@canopy/desktop-shared/types';
import {
  DEFAULT_COWORK_WORKSPACE_ID,
  IPC_CHANNELS,
} from '@canopy/desktop-shared/types';
import { MAX_ARCHIVE_RETENTION_DAYS } from '@canopy/desktop-shared/lib/archive-retention';
import {
  ensureCoworkHomeScaffold,
  syncChatProjectAgentsMd,
} from '../lib/chat-project-utils';
import { cleanupPersistedWorktreeData } from '../lib/worktree-data-cleanup';
import { resolveCoworkWorkspaceId } from '../lib/cowork-migration-map';
import {
  readAllSidebarItems,
  writeAllSidebarItems,
} from '../lib/sidebar-items';
import { registerIpcHandler } from '../ipc/register';
import { registerChatProjectHandlers } from '../ipc/chat-projects';
import { createWorkspaceLifecycleTestDispatcher } from './fixtures/workspace-lifecycle-dispatcher';
import { TEST_IPC_CALLER } from './fixtures/workspace-metadata-dispatcher';
import { deleteWorkspace } from '../lib/workspace-deletion';
import { recordStandaloneProjectCrudTelemetry } from '../lib/desktop-telemetry';
import { validateId } from '../lib/validation';
import {
  createWorkspaceTemplateShare,
  getWorkspaceTemplateShareSnapshot,
  listWorkspaceTemplateShares,
  republishWorkspaceTemplateShare,
  revokeWorkspaceTemplateShare,
} from '../canopy-cloud/workspace-template-client';
import { reportShareHandoffEvent } from '../canopy-cloud/share-handoff-events';
import { buildDesktopWorkspaceTemplateDocument } from '../plugins/workspace-template-authoring';
import { resolveDesktopWorkspaceTemplate } from '../plugins/workspace-template-import';
import { noteCloudWriteSent } from '../canopy-cloud/cloud-write-tracking';

const mockedReadFile = jest.mocked(readFile);
const mockedWriteFile = jest.mocked(writeFile);
const mockedRm = jest.mocked(rm);
const mockedEnsureCoworkHomeScaffold = jest.mocked(ensureCoworkHomeScaffold);
const mockedSyncChatProjectAgentsMd = jest.mocked(syncChatProjectAgentsMd);
const mockedCleanupPersistedWorktreeData = jest.mocked(
  cleanupPersistedWorktreeData,
);
const mockedResolveDesktopWorkspaceTemplate = jest.mocked(
  resolveDesktopWorkspaceTemplate,
);
const mockedResolveCoworkWorkspaceId = jest.mocked(resolveCoworkWorkspaceId);
const mockedDeleteWorkspace = jest.mocked(deleteWorkspace);
const mockedRecordStandaloneProjectCrudTelemetry = jest.mocked(
  recordStandaloneProjectCrudTelemetry,
);
const mockedValidateId = jest.mocked(validateId);
const mockedRegisterIpcHandler = jest.mocked(registerIpcHandler);
const mockedReadAllSidebarItems = jest.mocked(readAllSidebarItems);
const mockedWriteAllSidebarItems = jest.mocked(writeAllSidebarItems);
const mockedCreateWorkspaceTemplateShare = jest.mocked(
  createWorkspaceTemplateShare,
);
const mockedGetWorkspaceTemplateShareSnapshot = jest.mocked(
  getWorkspaceTemplateShareSnapshot,
);
const mockedListWorkspaceTemplateShares = jest.mocked(
  listWorkspaceTemplateShares,
);
const mockedRepublishWorkspaceTemplateShare = jest.mocked(
  republishWorkspaceTemplateShare,
);
const mockedRevokeWorkspaceTemplateShare = jest.mocked(
  revokeWorkspaceTemplateShare,
);
const mockedBuildDesktopWorkspaceTemplateDocument = jest.mocked(
  buildDesktopWorkspaceTemplateDocument,
);
const mockedReportShareHandoffEvent = jest.mocked(reportShareHandoffEvent);

type HandlerFn = (...args: unknown[]) => Promise<unknown>;

function getHandler(channel: string): HandlerFn {
  const call = mockedRegisterIpcHandler.mock.calls.find(
    ([registeredChannel]) => registeredChannel === channel,
  );

  if (!call) {
    throw new Error(`No handler registered for ${channel}`);
  }

  return call[1] as HandlerFn;
}

function coworkItem(overrides: Partial<CoworkSidebarItem>): CoworkSidebarItem {
  return {
    id: 'alpha',
    name: 'Alpha',
    type: 'cowork',
    color: '#7C3AED',
    collapsed: false,
    order: 0,
    cowork: {
      createdAt: '2025-02-01T00:00:00.000Z',
      archiveRetentionDays: null,
    },
    ...overrides,
  };
}

describe('chat project IPC handlers (cowork-workspace-backed)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSidebarItems = [];
    mockConfigs.clear();
    mockPublishedWithoutConfig.clear();
    mockPersistCoworkConfig.mockImplementation(mockApplyCoworkConfig);
    mockedWriteAllSidebarItems.mockImplementation((items) => {
      mockSidebarItems = items;
      return Promise.resolve({ version: 1, items });
    });
    mockedReadFile.mockRejectedValue(
      Object.assign(new Error('ENOENT'), { code: 'ENOENT' }),
    );
    // Creation admission lstat-checks candidate ids; none exist in this fixture.
    jest
      .mocked(lstat)
      .mockRejectedValue(
        Object.assign(new Error('ENOENT'), { code: 'ENOENT' }),
      );
    // The watcher store stats its file before reading it.
    jest
      .mocked(stat)
      .mockRejectedValue(
        Object.assign(new Error('ENOENT'), { code: 'ENOENT' }),
      );
    mockedWriteFile.mockResolvedValue(undefined);
    mockedRm.mockResolvedValue(undefined);
    mockedEnsureCoworkHomeScaffold.mockResolvedValue(undefined);
    mockedSyncChatProjectAgentsMd.mockResolvedValue(undefined);
    mockedCleanupPersistedWorktreeData.mockResolvedValue([]);
    mockInstallDesktopWorkspaceTemplateCapabilityPackages.mockResolvedValue({
      skillRefs: [],
      mcpServerRefs: [],
      unmetRequirements: [],
    });
    mockResolveBlueprintsForSeeding.mockResolvedValue({
      status: 'unavailable',
    });
    mockedListWorkspaceTemplateShares.mockResolvedValue({ shares: [] });
    registerChatProjectHandlers({
      // Chat project delete projects core.workspace.delete (W7b-2a).
      dispatcher: createWorkspaceLifecycleTestDispatcher(),
      resolveCaller: () => TEST_IPC_CALLER,
    });
  });

  it('forwards shared template authorship to the backend reader', async () => {
    jest.mocked(listWorkspaceTemplateShares).mockResolvedValue({ shares: [] });
    const request = { createdBy: 'me', query: 'biology' };
    await getHandler(IPC_CHANNELS.chatProjectSharedTemplatesList)({}, request);
    expect(listWorkspaceTemplateShares).toHaveBeenCalledWith(request);
  });

  describe('chatProjectList', () => {
    it('returns cowork projects mapped to ChatProjectData', async () => {
      mockSidebarItems = [
        coworkItem({
          id: DEFAULT_COWORK_WORKSPACE_ID,
          name: 'Personal',
          color: '#0EA5E9',
          order: 0,
          cowork: {
            createdAt: '2025-01-01T00:00:00.000Z',
            archiveRetentionDays: null,
          },
        }),
        coworkItem({
          id: 'alpha',
          name: 'Alpha',
          color: '#22C55E',
          order: 1,
          cowork: {
            createdAt: '2025-02-01T00:00:00.000Z',
            description: 'Alpha project',
            defaultModel: 'claude',
            archiveRetentionDays: 30,
          },
        }),
      ];

      const result = await getHandler(IPC_CHANNELS.chatProjectList)(undefined);

      expect(result).toEqual({
        projects: [
          {
            id: DEFAULT_COWORK_WORKSPACE_ID,
            name: 'Personal',
            createdAt: '2025-01-01T00:00:00.000Z',
            color: '#0EA5E9',
            archiveRetentionDays: null,
            autoArchiveDays: null,
            alwaysShow: true,
          },
          {
            id: 'alpha',
            name: 'Alpha',
            createdAt: '2025-02-01T00:00:00.000Z',
            color: '#22C55E',
            description: 'Alpha project',
            defaultModel: 'claude',
            archiveRetentionDays: 30,
            autoArchiveDays: null,
            alwaysShow: true,
          },
        ],
      });
    });

    it('creates the default cowork project on first list when absent', async () => {
      mockSidebarItems = [];

      const result = await getHandler(IPC_CHANNELS.chatProjectList)(undefined);

      expect(result).toEqual({
        projects: [
          expect.objectContaining({
            id: DEFAULT_COWORK_WORKSPACE_ID,
            name: 'Chats',
          }),
        ],
      });
      expect(mockedEnsureCoworkHomeScaffold).toHaveBeenCalledWith(
        DEFAULT_COWORK_WORKSPACE_ID,
      );
      expect(mockIndexCommit).toHaveBeenCalledWith([
        expect.objectContaining({
          id: DEFAULT_COWORK_WORKSPACE_ID,
          type: 'cowork',
        }),
      ]);
    });

    it('does not recreate the default project when it already exists', async () => {
      mockSidebarItems = [coworkItem({ id: DEFAULT_COWORK_WORKSPACE_ID })];

      await getHandler(IPC_CHANNELS.chatProjectList)(undefined);

      expect(mockedWriteAllSidebarItems).not.toHaveBeenCalled();
      expect(mockedEnsureCoworkHomeScaffold).not.toHaveBeenCalled();
    });
  });

  describe('chatProjectCreate', () => {
    it('appends a cowork index entry and scaffolds its managed home', async () => {
      mockSidebarItems = [coworkItem({ id: DEFAULT_COWORK_WORKSPACE_ID })];

      const result = await getHandler(IPC_CHANNELS.chatProjectCreate)(
        undefined,
        { name: 'My New Project' },
      );

      expect(result).toMatchObject({
        project: { id: 'my-new-project', name: 'My New Project' },
      });
      expect(mockedEnsureCoworkHomeScaffold).toHaveBeenCalledWith(
        'my-new-project',
      );
      expect(mockedReadAllSidebarItems).toHaveBeenCalled();
      expect(mockSidebarItems).toEqual([
        expect.objectContaining({ id: DEFAULT_COWORK_WORKSPACE_ID }),
        expect.objectContaining({
          id: 'my-new-project',
          type: 'cowork',
          name: 'My New Project',
        }),
      ]);
    });

    it('de-duplicates the allocated project id against existing ids', async () => {
      mockSidebarItems = [coworkItem({ id: 'my-new-project' })];

      const result = await getHandler(IPC_CHANNELS.chatProjectCreate)(
        undefined,
        { name: 'My New Project' },
      );

      expect(result).toMatchObject({
        project: { id: 'my-new-project-2' },
      });
    });

    it('rejects an empty project name', async () => {
      await expect(
        getHandler(IPC_CHANNELS.chatProjectCreate)(undefined, { name: '  ' }),
      ).rejects.toThrow('Project name is required');
      expect(mockedWriteAllSidebarItems).not.toHaveBeenCalled();
    });
  });

  describe('chatProjectCreateOrgCowork', () => {
    it('validates and forwards the organization Cowork request', async () => {
      const request = {
        organizationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        name: 'Team notes',
      };
      mockCreateOrgCowork.mockResolvedValue({
        ok: true,
        organizationProjectId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        localWorkspaceId: 'cowork-project-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        attachedGitRepository: false,
      });

      await getHandler(IPC_CHANNELS.chatProjectCreateOrgCowork)(
        undefined,
        request,
      );

      expect(mockCreateOrgCowork).toHaveBeenCalledWith(request);
    });

    it('rejects malformed requests before the coordinator', async () => {
      await expect(
        getHandler(IPC_CHANNELS.chatProjectCreateOrgCowork)(undefined, {
          organizationId: 'not-an-id',
          name: 'Team notes',
        }),
      ).rejects.toThrow('Invalid organization Cowork project request');
      expect(mockCreateOrgCowork).not.toHaveBeenCalled();
    });
  });

  describe('chatProjectCreateFromTemplate', () => {
    const sourceTemplate = {
      externalId: '4f4f51c1-a72b-4e12-9320-a038b90189f0',
      contentHash: 'c'.repeat(64),
    };

    it('re-fetches and hash-verifies a shared seed in main before creating', async () => {
      mockedGetWorkspaceTemplateShareSnapshot.mockResolvedValueOnce({
        entity: 'workspace',
        externalId: sourceTemplate.externalId,
        contentHash: sourceTemplate.contentHash,
        template: {
          version: 2,
          name: 'Verified shared template',
          description: 'Pinned by the server.',
          instructions: '# Verified instructions',
          plugins: [],
          customSkills: [],
          starterPrompts: [],
        },
        authorUsername: null,
        updatedAt: '2026-10-01T00:00:00.000Z',
      });

      const result = await getHandler(
        IPC_CHANNELS.chatProjectCreateFromTemplate,
      )(undefined, {
        seed: 'shared',
        sourceTemplate,
        name: 'My shared project',
      });

      expect(mockedGetWorkspaceTemplateShareSnapshot).toHaveBeenCalledWith(
        sourceTemplate.externalId,
        sourceTemplate.contentHash,
      );
      expect(mockedWriteFile).toHaveBeenCalledWith(
        expect.stringContaining('/CLAUDE.md'),
        '# Verified instructions',
        'utf8',
      );
      expect(result).toMatchObject({
        project: { name: 'My shared project' },
      });
    });

    it('writes the template instructions and syncs AGENTS.md alongside them', async () => {
      mockSidebarItems = [];

      const result = (await getHandler(
        IPC_CHANNELS.chatProjectCreateFromTemplate,
      )(undefined, {
        template: {
          version: 1,
          name: 'Course workspace',
          description: 'Week 1 setup',
          instructions: '# Course instructions',
          plugins: [],
          customSkills: [],
        },
        sourceTemplate,
      })) as { project: ChatProjectData };

      expect(result).toMatchObject({
        project: { id: 'course-workspace', name: 'Course workspace' },
        unresolvedRefs: ['plugin:github:acme/tools:missing'],
      });
      expect(mockedWriteFile).toHaveBeenCalledWith(
        '/mock/workspaces/course-workspace/home/CLAUDE.md',
        '# Course instructions',
        'utf8',
      );
      // The interactive save path pairs every CLAUDE.md write with this sync;
      // an installed template must not be the one path that skips it, or its
      // instructions never reach a Codex session in the new workspace.
      expect(mockedSyncChatProjectAgentsMd).toHaveBeenCalledWith(
        'course-workspace',
      );
      expect(result.project).toMatchObject({
        installedFromTemplateExternalId: sourceTemplate.externalId,
        installedFromTemplateContentHash: sourceTemplate.contentHash,
      });
    });

    it('retries a failed package install against the persisted template project', async () => {
      const digest = `pp:v1:${'A'.repeat(43)}`;
      const request = {
        template: {
          version: 1 as const,
          name: 'Packaged workspace',
          description: 'Includes a local helper.',
          instructions: '# Packaged instructions',
          plugins: [],
          customSkills: [],
        },
        sourceTemplate: {
          ...sourceTemplate,
          package: {
            version: 1 as const,
            digest,
            resources: [],
            environmentRequirements: [],
            totalFiles: 0,
            totalBytes: 0,
          },
        },
      };
      mockInstallDesktopWorkspaceTemplateCapabilityPackages
        .mockRejectedValueOnce(new Error('package download failed'))
        .mockResolvedValueOnce({
          skillRefs: [{ sourceId: 'custom:app', skillName: 'helper' }],
          mcpServerRefs: [],
          unmetRequirements: [],
        });

      await expect(
        getHandler(IPC_CHANNELS.chatProjectCreateFromTemplate)(
          undefined,
          request,
        ),
      ).rejects.toThrow('package download failed');
      expect(mockSidebarItems).toHaveLength(1);
      expect(mockSidebarItems[0]).toMatchObject({
        installedFromTemplateExternalId: sourceTemplate.externalId,
      });
      const failedInstallItem = mockSidebarItems[0];
      if (!failedInstallItem || failedInstallItem.type !== 'cowork') {
        throw new Error(
          'Expected the failed installation to remain a cowork project.',
        );
      }
      expect(
        failedInstallItem.installedFromTemplateContentHash,
      ).toBeUndefined();

      const retried = (await getHandler(
        IPC_CHANNELS.chatProjectCreateFromTemplate,
      )(undefined, request)) as { project: ChatProjectData };

      expect(retried.project.id).toBe('packaged-workspace');
      expect(mockSidebarItems).toHaveLength(1);
      expect(
        mockInstallDesktopWorkspaceTemplateCapabilityPackages,
      ).toHaveBeenCalledTimes(2);
      expect(retried.project.defaultPluginSelections?.skillRefs).toContainEqual(
        { sourceId: 'custom:app', skillName: 'helper' },
      );
      expect(retried.project.installedFromTemplateContentHash).toBe(
        sourceTemplate.contentHash,
      );
    });

    // A curated seed previously always succeeded, including offline. Resolving
    // refs does network and filesystem work, so a prep failure must degrade to a
    // warning rather than failing the create outright.
    it('still creates the project when ref preparation throws', async () => {
      mockSidebarItems = [];
      mockedResolveDesktopWorkspaceTemplate.mockRejectedValueOnce(
        new Error('marketplace unreachable'),
      );

      const request = {
        template: {
          version: 2 as const,
          name: 'Launch planning',
          description: '',
          instructions: '',
          starterPrompts: [],
          plugins: [
            {
              type: 'plugin' as const,
              marketplace: { type: 'github' as const, repo: 'acme/tools' },
              plugin_name: 'missing',
            },
          ],
          customSkills: [],
        },
        sourceTemplate,
        curated: true,
      };
      mockResolveBlueprintsForSeeding.mockResolvedValue({
        status: 'verified',
        blueprints: [
          {
            externalId: sourceTemplate.externalId,
            contentHash: sourceTemplate.contentHash,
            document: request.template,
          },
        ],
      });

      const result = (await getHandler(
        IPC_CHANNELS.chatProjectCreateFromTemplate,
      )(undefined, request)) as {
        project: ChatProjectData;
        unresolvedRefs: string[];
      };

      expect(result.project).toBeDefined();
      expect(result.unresolvedRefs.length).toBeGreaterThan(0);
    });

    // `resolveDesktopWorkspaceTemplate` resolves `customSkills` as well as
    // `plugins`, so a skills-only Blueprint whose prep throws must still report
    // its refs as unresolved. Counting only plugins produced an empty list, and
    // the renderer's `length > 0` guard then showed NO warning for a project
    // that received none of the Blueprint's capabilities.
    it('reports unresolved refs when a skills-only Blueprint fails to prepare', async () => {
      mockSidebarItems = [];
      mockedResolveDesktopWorkspaceTemplate.mockRejectedValueOnce(
        new Error('disk full'),
      );

      const request = {
        template: {
          version: 2 as const,
          name: 'Launch planning',
          description: '',
          instructions: '',
          starterPrompts: [],
          plugins: [],
          customSkills: [
            {
              clientKey: 'campaign-brief-helper',
              name: 'campaign-brief-helper',
              rawSkill: '# Campaign brief helper',
            },
          ],
        },
        sourceTemplate,
        curated: true,
      };
      mockResolveBlueprintsForSeeding.mockResolvedValue({
        status: 'verified',
        blueprints: [
          {
            externalId: sourceTemplate.externalId,
            contentHash: sourceTemplate.contentHash,
            document: request.template,
          },
        ],
      });

      const result = (await getHandler(
        IPC_CHANNELS.chatProjectCreateFromTemplate,
      )(undefined, request)) as {
        project: ChatProjectData;
        unresolvedRefs: string[];
      };

      expect(result.project).toBeDefined();
      expect(result.unresolvedRefs).toEqual(['skill:campaign-brief-helper']);
      // The degrade is deliberate, so the cause has to leave a trace.
      expect(mockRecordAppDiagnostic).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: 'blueprint_template_prep_failed',
          error: 'disk full',
        }),
      );
    });

    it('creates curated Blueprints repeatedly with resolved plugin defaults and unresolved refs', async () => {
      mockSidebarItems = [];
      const resolvedSelections = {
        collectionIds: [],
        skillRefs: [
          { sourceId: 'custom:app', skillName: 'campaign-brief-helper' },
        ],
        pluginRefs: [],
        mcpServerRefs: [],
      };
      mockedResolveDesktopWorkspaceTemplate
        .mockResolvedValueOnce({
          selections: resolvedSelections,
          unresolvedRefs: ['plugin:github:acme/tools:missing'],
        })
        .mockResolvedValueOnce({
          selections: resolvedSelections,
          unresolvedRefs: ['plugin:github:acme/tools:missing'],
        });
      const request = {
        template: {
          version: 2 as const,
          name: 'Marketing',
          description: 'Campaign workspace',
          instructions: '# Brand voice',
          plugins: [],
          customSkills: [],
          starterPrompts: [
            { id: 'marketing-brief', text: 'Draft a campaign brief.' },
          ],
        },
        sourceTemplate,
        curated: true,
        name: 'Launch planning',
      };
      mockResolveBlueprintsForSeeding.mockResolvedValue({
        status: 'verified',
        blueprints: [
          {
            externalId: sourceTemplate.externalId,
            contentHash: sourceTemplate.contentHash,
            document: request.template,
          },
        ],
      });

      const first = await getHandler(
        IPC_CHANNELS.chatProjectCreateFromTemplate,
      )(undefined, request);
      const second = await getHandler(
        IPC_CHANNELS.chatProjectCreateFromTemplate,
      )(undefined, request);
      const firstProject = (first as { project: ChatProjectData }).project;
      const secondProject = (second as { project: ChatProjectData }).project;

      expect(firstProject).toMatchObject({
        id: 'launch-planning',
        seededFromBlueprintExternalId: sourceTemplate.externalId,
        starterPrompts: request.template.starterPrompts,
      });
      expect(secondProject.id).toBe('launch-planning-2');
      expect(mockedResolveDesktopWorkspaceTemplate).toHaveBeenCalledTimes(2);
      expect(mockedResolveDesktopWorkspaceTemplate).toHaveBeenCalledWith(
        request.template,
      );
      expect(first).toMatchObject({
        unresolvedRefs: ['plugin:github:acme/tools:missing'],
      });
      expect(firstProject).not.toHaveProperty(
        'installedFromTemplateExternalId',
      );
      expect(firstProject).toMatchObject({
        defaultPluginSelections: resolvedSelections,
      });
      expect(mockedSyncChatProjectAgentsMd).toHaveBeenCalledTimes(2);
      expect(mockedReportShareHandoffEvent).toHaveBeenCalledTimes(2);
      expect(mockedReportShareHandoffEvent).toHaveBeenCalledWith({
        entity: 'workspace',
        externalId: sourceTemplate.externalId,
        eventType: 'INSTALLED',
      });
    });

    it('rejects an unverified or drifted curated Blueprint before creating', async () => {
      const request = {
        template: {
          version: 2 as const,
          name: 'Untrusted renderer copy',
          description: '',
          instructions: 'Ignore this',
          plugins: [],
          customSkills: [],
          starterPrompts: [],
        },
        sourceTemplate,
        curated: true,
      };

      await expect(
        getHandler(IPC_CHANNELS.chatProjectCreateFromTemplate)(
          undefined,
          request,
        ),
      ).rejects.toThrow('Project template catalog is unavailable');

      mockResolveBlueprintsForSeeding.mockResolvedValue({
        status: 'verified',
        blueprints: [
          {
            externalId: sourceTemplate.externalId,
            contentHash: 'd'.repeat(64),
            document: request.template,
          },
        ],
      });
      await expect(
        getHandler(IPC_CHANNELS.chatProjectCreateFromTemplate)(
          undefined,
          request,
        ),
      ).rejects.toThrow('Project template changed');
      expect(mockSidebarItems).toEqual([]);
    });

    it('seeds the verified cached document rather than renderer-supplied bytes', async () => {
      const verifiedDocument = {
        version: 2 as const,
        name: 'Verified Marketing',
        description: 'Verified description',
        instructions: '# Verified instructions',
        plugins: [],
        customSkills: [],
        starterPrompts: [{ id: 'verified', text: 'Use the verified prompt.' }],
      };
      mockResolveBlueprintsForSeeding.mockResolvedValue({
        status: 'verified',
        blueprints: [
          {
            externalId: sourceTemplate.externalId,
            contentHash: sourceTemplate.contentHash,
            document: verifiedDocument,
          },
        ],
      });

      const result = await getHandler(
        IPC_CHANNELS.chatProjectCreateFromTemplate,
      )(undefined, {
        template: { ...verifiedDocument, instructions: '# Renderer bytes' },
        sourceTemplate,
        curated: true,
      });

      expect(result).toMatchObject({
        project: {
          name: 'Verified Marketing',
          starterPrompts: verifiedDocument.starterPrompts,
        },
      });
      expect(mockedWriteFile).toHaveBeenCalledWith(
        '/mock/workspaces/verified-marketing/home/CLAUDE.md',
        verifiedDocument.instructions,
        'utf8',
      );
    });

    it('returns an existing completed installation without overwriting customizations', async () => {
      mockSidebarItems = [
        coworkItem({
          id: 'custom-course',
          name: 'My customized course',
          installedFromTemplateExternalId: sourceTemplate.externalId,
          installedFromTemplateContentHash: 'a'.repeat(64),
        }),
      ];

      const result = (await getHandler(
        IPC_CHANNELS.chatProjectCreateFromTemplate,
      )(undefined, {
        template: {
          version: 1,
          name: 'Course workspace',
          description: 'Remote replacement',
          instructions: '# Remote replacement',
          plugins: [],
          customSkills: [],
        },
        sourceTemplate,
      })) as { project: ChatProjectData };

      expect(result.project).toMatchObject({
        id: 'custom-course',
        name: 'My customized course',
      });
      expect(mockedResolveDesktopWorkspaceTemplate).not.toHaveBeenCalled();
      expect(mockedWriteFile).not.toHaveBeenCalled();
      expect(mockSidebarItems).toHaveLength(1);
    });

    it('repairs a partial installation in place and stamps completion last', async () => {
      mockSidebarItems = [
        coworkItem({
          id: 'course-workspace',
          name: 'Course workspace',
          installedFromTemplateExternalId: sourceTemplate.externalId,
        }),
      ];

      const result = (await getHandler(
        IPC_CHANNELS.chatProjectCreateFromTemplate,
      )(undefined, {
        template: {
          version: 1,
          name: 'Course workspace',
          description: 'Week 1 setup',
          instructions: '# Course instructions',
          plugins: [],
          customSkills: [],
        },
        sourceTemplate,
      })) as { project: ChatProjectData };

      expect(result.project).toMatchObject({
        id: 'course-workspace',
        installedFromTemplateExternalId: sourceTemplate.externalId,
        installedFromTemplateContentHash: sourceTemplate.contentHash,
      });
      expect(
        mockSidebarItems.filter((item) => item.type === 'cowork'),
      ).toHaveLength(1);
      expect(mockedWriteFile).toHaveBeenCalledWith(
        '/mock/workspaces/course-workspace/home/CLAUDE.md',
        '# Course instructions',
        'utf8',
      );
      expect(mockedSyncChatProjectAgentsMd).toHaveBeenCalledWith(
        'course-workspace',
      );
    });

    it('serializes concurrent installs of the same source template', async () => {
      mockSidebarItems = [];
      let releaseResolution!: () => void;
      let markResolutionStarted!: () => void;
      const resolutionGate = new Promise<void>((resolve) => {
        releaseResolution = resolve;
      });
      const resolutionStarted = new Promise<void>((resolve) => {
        markResolutionStarted = resolve;
      });
      mockedResolveDesktopWorkspaceTemplate.mockImplementation(async () => {
        markResolutionStarted();
        await resolutionGate;
        return {
          selections: {
            collectionIds: [],
            skillRefs: [],
            pluginRefs: [],
            mcpServerRefs: [],
          },
          unresolvedRefs: [],
        };
      });
      const handler = getHandler(IPC_CHANNELS.chatProjectCreateFromTemplate);
      const request = {
        template: {
          version: 1,
          name: 'Course workspace',
          description: 'Week 1 setup',
          instructions: '# Course instructions',
          plugins: [],
          customSkills: [],
        },
        sourceTemplate,
      };

      const first = handler(undefined, request);
      const second = handler(undefined, request);
      await resolutionStarted;
      expect(mockedResolveDesktopWorkspaceTemplate).toHaveBeenCalledTimes(1);
      releaseResolution();

      const [firstResult, secondResult] = await Promise.all([first, second]);
      expect(mockedResolveDesktopWorkspaceTemplate).toHaveBeenCalledTimes(1);
      expect(firstResult).toEqual(secondResult);
      expect(
        mockSidebarItems.filter((item) => item.type === 'cowork'),
      ).toHaveLength(1);
    });

    it('serializes concurrent installs of different source templates', async () => {
      mockSidebarItems = [];
      let releaseResolution!: () => void;
      let markResolutionStarted!: () => void;
      const resolutionGate = new Promise<void>((resolve) => {
        releaseResolution = resolve;
      });
      const resolutionStarted = new Promise<void>((resolve) => {
        markResolutionStarted = resolve;
      });
      mockedResolveDesktopWorkspaceTemplate.mockImplementation(async () => {
        markResolutionStarted();
        await resolutionGate;
        return {
          selections: {
            collectionIds: [],
            skillRefs: [],
            pluginRefs: [],
            mcpServerRefs: [],
          },
          unresolvedRefs: [],
        };
      });
      const handler = getHandler(IPC_CHANNELS.chatProjectCreateFromTemplate);
      const first = handler(undefined, {
        template: {
          version: 1,
          name: 'First course',
          description: '',
          instructions: '',
          plugins: [],
          customSkills: [],
        },
        sourceTemplate,
      });
      const second = handler(undefined, {
        template: {
          version: 1,
          name: 'Second course',
          description: '',
          instructions: '',
          plugins: [],
          customSkills: [],
        },
        sourceTemplate: {
          externalId: '66f19166-9d35-4a1d-a941-0d9ed15f2e6e',
          contentHash: 'f'.repeat(64),
        },
      });

      await resolutionStarted;
      await Promise.resolve();
      expect(mockedResolveDesktopWorkspaceTemplate).toHaveBeenCalledTimes(1);
      releaseResolution();

      await Promise.all([first, second]);
      expect(
        mockSidebarItems
          .filter((item) => item.type === 'cowork')
          .map((item) => item.id),
      ).toEqual(['first-course', 'second-course']);
    });

    it('serializes publication behind an in-flight template install', async () => {
      const publishedExternalId = '2f0c9a1e-4b3d-4f6a-8c2e-1d5b7a9e0c4f';
      mockSidebarItems = [coworkItem({ id: 'alpha' })];
      let releaseScaffold!: () => void;
      let markScaffoldStarted!: () => void;
      const scaffoldGate = new Promise<void>((resolve) => {
        releaseScaffold = resolve;
      });
      const scaffoldStarted = new Promise<void>((resolve) => {
        markScaffoldStarted = resolve;
      });
      mockedEnsureCoworkHomeScaffold.mockImplementation(async () => {
        markScaffoldStarted();
        await scaffoldGate;
      });
      mockedCreateWorkspaceTemplateShare.mockResolvedValue({
        externalId: publishedExternalId,
        sharePath: `/portal/plugins/project-templates/${publishedExternalId}`,
        pinnedContentHash: 'a'.repeat(64),
      });

      const install = getHandler(IPC_CHANNELS.chatProjectCreateFromTemplate)(
        undefined,
        {
          template: {
            version: 1,
            name: 'Course workspace',
            description: 'Week 1 setup',
            instructions: '# Course instructions',
            plugins: [],
            customSkills: [],
          },
          sourceTemplate,
        },
      );
      await scaffoldStarted;
      const publish = getHandler(IPC_CHANNELS.chatProjectTemplateSharePublish)(
        undefined,
        {
          projectId: 'alpha',
          document: {
            version: 1,
            name: 'Alpha',
            description: '',
            instructions: '',
            plugins: [],
            customSkills: [],
          },
        },
      );
      await Promise.resolve();
      await Promise.resolve();
      const publicationStartedBeforeInstallCompleted =
        mockedCreateWorkspaceTemplateShare.mock.calls.length > 0;
      releaseScaffold();
      await Promise.all([install, publish]);

      expect(publicationStartedBeforeInstallCompleted).toBe(false);
      expect(mockSidebarItems).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: 'alpha',
            sharedTemplateExternalId: publishedExternalId,
            sharedTemplateContentHash: 'a'.repeat(64),
          }),
          expect.objectContaining({ id: 'course-workspace' }),
        ]),
      );
    });

    it('serializes ordinary project creation behind an in-flight template install', async () => {
      mockSidebarItems = [coworkItem({ id: 'alpha' })];
      let releaseScaffold!: () => void;
      let markScaffoldStarted!: () => void;
      const scaffoldGate = new Promise<void>((resolve) => {
        releaseScaffold = resolve;
      });
      const scaffoldStarted = new Promise<void>((resolve) => {
        markScaffoldStarted = resolve;
      });
      mockedEnsureCoworkHomeScaffold.mockImplementation(async (workspaceId) => {
        if (workspaceId === 'course-workspace') {
          markScaffoldStarted();
          await scaffoldGate;
        }
      });

      const install = getHandler(IPC_CHANNELS.chatProjectCreateFromTemplate)(
        undefined,
        {
          template: {
            version: 1,
            name: 'Course workspace',
            description: 'Week 1 setup',
            instructions: '# Course instructions',
            plugins: [],
            customSkills: [],
          },
          sourceTemplate,
        },
      );
      await scaffoldStarted;
      const create = getHandler(IPC_CHANNELS.chatProjectCreate)(undefined, {
        name: 'Ordinary project',
      });
      await Promise.resolve();
      await Promise.resolve();
      const ordinaryCreateStartedBeforeInstallCompleted =
        mockedEnsureCoworkHomeScaffold.mock.calls.some(
          ([workspaceId]) => workspaceId === 'ordinary-project',
        );
      releaseScaffold();
      await Promise.all([install, create]);

      expect(ordinaryCreateStartedBeforeInstallCompleted).toBe(false);
      expect(
        mockSidebarItems
          .filter((item) => item.type === 'cowork')
          .map((item) => item.id),
      ).toEqual(['alpha', 'course-workspace', 'ordinary-project']);
    });

    it('rejects a malformed template document before creating anything', async () => {
      mockSidebarItems = [];

      await expect(
        getHandler(IPC_CHANNELS.chatProjectCreateFromTemplate)(undefined, {
          template: { version: 3, name: 'Nope' },
          sourceTemplate,
        }),
      ).rejects.toThrow('Unsupported workspace template version');
      expect(mockedWriteAllSidebarItems).not.toHaveBeenCalled();
    });
  });

  describe('chatProjectTemplatePackageReadiness', () => {
    it('returns an aggregate package review before a Blueprint install', async () => {
      await expect(
        getHandler(IPC_CHANNELS.chatProjectTemplatePackageReadiness)(
          undefined,
          {
            packages: [
              {
                version: 1,
                digest: `pp:v1:${'A'.repeat(43)}`,
                resources: [],
                environmentRequirements: [],
                totalFiles: 0,
                totalBytes: 0,
              },
            ],
          },
        ),
      ).resolves.toEqual({
        status: 'ready',
        distributionMode: 'package',
        requirements: [],
      });
    });

    it('rejects an oversized per-skill package review', async () => {
      await expect(
        getHandler(IPC_CHANNELS.chatProjectTemplatePackageReadiness)(
          undefined,
          { packages: Array.from({ length: 27 }, () => ({})) },
        ),
      ).rejects.toThrow('Invalid project template capability package review');
    });
  });

  describe('workspace template authoring', () => {
    const template = {
      version: 2 as const,
      name: 'Alpha',
      description: 'Course setup',
      instructions: 'Tutor patiently.',
      plugins: [],
      customSkills: [],
      starterPrompts: [],
    };
    const externalId = '2f0c9a1e-4b3d-4f6a-8c2e-1d5b7a9e0c4f';

    it('builds the portable document from the current workspace draft', async () => {
      mockSidebarItems = [coworkItem({ id: 'alpha' })];
      mockedReadFile.mockResolvedValue('Tutor patiently.');
      mockedBuildDesktopWorkspaceTemplateDocument.mockResolvedValue({
        document: template,
        omitted: { mcpServers: false, unresolvedRefs: [] },
      });

      await expect(
        getHandler(IPC_CHANNELS.chatProjectTemplateBuild)(undefined, {
          projectId: 'alpha',
          draft: {
            name: 'Draft Alpha',
            description: 'Draft course setup',
            color: '#22C55E',
            instructions: 'Draft instructions.',
            defaultPluginSelections: {
              collectionIds: [],
              skillRefs: [{ sourceId: 'custom', skillName: 'study-helper' }],
              pluginRefs: [],
              mcpServerRefs: [],
            },
          },
        }),
      ).resolves.toEqual({
        document: template,
        omitted: { mcpServers: false, unresolvedRefs: [] },
      });
      expect(mockedBuildDesktopWorkspaceTemplateDocument).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'alpha',
          name: 'Draft Alpha',
          description: 'Draft course setup',
          color: '#22C55E',
          defaultPluginSelections: {
            collectionIds: [],
            skillRefs: [{ sourceId: 'custom', skillName: 'study-helper' }],
            pluginRefs: [],
            mcpServerRefs: [],
          },
        }),
        'Draft instructions.',
      );
      expect(mockedReadFile).not.toHaveBeenCalled();
    });

    it('publishes once, persists the server identity, and republishes in place', async () => {
      mockSidebarItems = [coworkItem({ id: 'alpha' })];
      mockedCreateWorkspaceTemplateShare.mockResolvedValue({
        externalId,
        sharePath: `/portal/plugins/project-templates/${externalId}`,
        pinnedContentHash: 'a'.repeat(64),
      });
      mockedRepublishWorkspaceTemplateShare.mockResolvedValue({
        pinnedContentHash: 'b'.repeat(64),
      });

      await expect(
        getHandler(IPC_CHANNELS.chatProjectTemplateSharePublish)(undefined, {
          projectId: 'alpha',
          document: template,
        }),
      ).resolves.toEqual({
        ok: true,
        value: {
          externalId,
          sharePath: `/portal/plugins/project-templates/${externalId}`,
          pinnedContentHash: 'a'.repeat(64),
          upToDate: true,
        },
      });
      expect(mockSidebarItems[0]).toEqual(
        expect.objectContaining({
          sharedTemplateExternalId: externalId,
          sharedTemplateContentHash: 'a'.repeat(64),
        }),
      );

      await getHandler(IPC_CHANNELS.chatProjectTemplateSharePublish)(
        undefined,
        { projectId: 'alpha', document: template },
      );
      expect(mockedCreateWorkspaceTemplateShare).toHaveBeenCalledTimes(1);
      expect(mockedRepublishWorkspaceTemplateShare).toHaveBeenCalledWith(
        externalId,
        template,
      );
      expect(mockSidebarItems[0]).toEqual(
        expect.objectContaining({
          sharedTemplateExternalId: externalId,
          sharedTemplateContentHash: 'b'.repeat(64),
        }),
      );
    });

    it('reports a missing project as not shared, before publication', async () => {
      await expect(
        getHandler(IPC_CHANNELS.chatProjectTemplateSharePublish)(undefined, {
          projectId: 'missing-project',
          document: template,
        }),
      ).resolves.toMatchObject({
        ok: false,
        failure: { stage: 'access', commitState: 'not-committed' },
      });
      expect(mockedCreateWorkspaceTemplateShare).not.toHaveBeenCalled();
    });

    it('serializes concurrent first-time publishes for one workspace', async () => {
      mockSidebarItems = [coworkItem({ id: 'alpha' })];
      let releaseCreate!: () => void;
      let markCreateStarted!: () => void;
      const createGate = new Promise<void>((resolve) => {
        releaseCreate = resolve;
      });
      const createStarted = new Promise<void>((resolve) => {
        markCreateStarted = resolve;
      });
      mockedCreateWorkspaceTemplateShare.mockImplementation(async () => {
        markCreateStarted();
        await createGate;
        return {
          externalId,
          sharePath: `/portal/plugins/project-templates/${externalId}`,
          pinnedContentHash: 'a'.repeat(64),
        };
      });
      mockedRepublishWorkspaceTemplateShare.mockResolvedValue({
        pinnedContentHash: 'a'.repeat(64),
      });
      const handler = getHandler(IPC_CHANNELS.chatProjectTemplateSharePublish);

      const first = handler(undefined, {
        projectId: 'alpha',
        document: template,
      });
      const second = handler(undefined, {
        projectId: 'alpha',
        document: template,
      });
      await createStarted;
      expect(mockedCreateWorkspaceTemplateShare).toHaveBeenCalledTimes(1);
      releaseCreate();

      await expect(Promise.all([first, second])).resolves.toHaveLength(2);
      expect(mockedCreateWorkspaceTemplateShare).toHaveBeenCalledTimes(1);
      expect(mockedRepublishWorkspaceTemplateShare).toHaveBeenCalledWith(
        externalId,
        template,
      );
    });

    it('serializes concurrent first-time publishes across projects', async () => {
      mockSidebarItems = [
        coworkItem({ id: 'alpha' }),
        coworkItem({ id: 'beta' }),
      ];
      let releaseFirstCreate!: () => void;
      let markFirstCreateStarted!: () => void;
      const firstCreateGate = new Promise<void>((resolve) => {
        releaseFirstCreate = resolve;
      });
      const firstCreateStarted = new Promise<void>((resolve) => {
        markFirstCreateStarted = resolve;
      });
      mockedCreateWorkspaceTemplateShare.mockImplementation(
        async (document) => {
          if (document.name === 'Alpha') {
            markFirstCreateStarted();
            await firstCreateGate;
          }
          const createdExternalId =
            document.name === 'Alpha'
              ? externalId
              : '66f19166-9d35-4a1d-a941-0d9ed15f2e6e';
          return {
            externalId: createdExternalId,
            sharePath: `/portal/plugins/project-templates/${createdExternalId}`,
            pinnedContentHash:
              document.name === 'Alpha' ? 'a'.repeat(64) : 'b'.repeat(64),
          };
        },
      );
      const handler = getHandler(IPC_CHANNELS.chatProjectTemplateSharePublish);
      const first = handler(undefined, {
        projectId: 'alpha',
        document: template,
      });
      const second = handler(undefined, {
        projectId: 'beta',
        document: { ...template, name: 'Beta' },
      });

      await firstCreateStarted;
      await Promise.resolve();
      expect(mockedCreateWorkspaceTemplateShare).toHaveBeenCalledTimes(1);
      releaseFirstCreate();
      await Promise.all([first, second]);

      expect(
        mockSidebarItems.filter(
          (item) => item.id === 'alpha' || item.id === 'beta',
        ),
      ).toEqual([
        expect.objectContaining({
          id: 'alpha',
          sharedTemplateExternalId: externalId,
          sharedTemplateContentHash: 'a'.repeat(64),
        }),
        expect.objectContaining({
          id: 'beta',
          sharedTemplateExternalId: '66f19166-9d35-4a1d-a941-0d9ed15f2e6e',
          sharedTemplateContentHash: 'b'.repeat(64),
        }),
      ]);
    });

    it('serializes revoke after an in-flight publish', async () => {
      mockSidebarItems = [
        coworkItem({
          id: 'alpha',
          sharedTemplateExternalId: externalId,
          sharedTemplateContentHash: 'a'.repeat(64),
        }),
      ];
      let releaseRepublish!: () => void;
      let markRepublishStarted!: () => void;
      const republishGate = new Promise<void>((resolve) => {
        releaseRepublish = resolve;
      });
      const republishStarted = new Promise<void>((resolve) => {
        markRepublishStarted = resolve;
      });
      mockedRepublishWorkspaceTemplateShare.mockImplementation(async () => {
        markRepublishStarted();
        await republishGate;
        return { pinnedContentHash: 'b'.repeat(64) };
      });
      mockedRevokeWorkspaceTemplateShare.mockResolvedValue(undefined);
      const publishHandler = getHandler(
        IPC_CHANNELS.chatProjectTemplateSharePublish,
      );
      const revokeHandler = getHandler(
        IPC_CHANNELS.chatProjectTemplateShareRevoke,
      );

      const publish = publishHandler(undefined, {
        projectId: 'alpha',
        document: template,
      });
      await republishStarted;
      const revoke = revokeHandler(undefined, { projectId: 'alpha' });
      await Promise.resolve();
      expect(mockedRevokeWorkspaceTemplateShare).not.toHaveBeenCalled();
      releaseRepublish();
      await Promise.all([publish, revoke]);

      expect(mockSidebarItems[0]).toEqual(
        expect.objectContaining({
          sharedTemplateExternalId: undefined,
          sharedTemplateContentHash: undefined,
        }),
      );
    });

    it('reuses a durable publication key after an ambiguous first publish', async () => {
      mockSidebarItems = [
        coworkItem({ id: DEFAULT_COWORK_WORKSPACE_ID }),
        coworkItem({ id: 'alpha' }),
      ];
      let writeCount = 0;
      mockPersistCoworkConfig.mockImplementation((id, config) => {
        writeCount += 1;
        if (writeCount === 2)
          return Promise.reject(new Error('local metadata write failed'));
        return mockApplyCoworkConfig(id, config);
      });
      mockedCreateWorkspaceTemplateShare.mockImplementation(() => {
        // The real client marks the publish request as a sent write.
        noteCloudWriteSent();
        return Promise.resolve({
          externalId,
          sharePath: `/portal/plugins/project-templates/${externalId}`,
          pinnedContentHash: 'a'.repeat(64),
        });
      });
      const handler = getHandler(IPC_CHANNELS.chatProjectTemplateSharePublish);

      // A local failure after the publish request leaves publication
      // uncertain; the envelope reports it without the local error text.
      const genericMessage: unknown = expect.not.stringContaining('metadata');
      const failure: unknown = expect.objectContaining({
        kind: 'unknown',
        stage: 'publish',
        commitState: 'unknown',
        message: genericMessage,
      });
      await expect(
        handler(undefined, { projectId: 'alpha', document: template }),
      ).resolves.toEqual({ ok: false, failure });
      const publicationKey = (
        mockSidebarItems.find((item) => item.id === 'alpha') as
          | (CoworkSidebarItem & {
              sharedTemplatePublicationKey?: string;
            })
          | undefined
      )?.sharedTemplatePublicationKey;
      expect(publicationKey).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      );

      await expect(
        handler(undefined, { projectId: 'alpha', document: template }),
      ).resolves.toMatchObject({
        ok: true,
        value: { externalId, upToDate: true },
      });
      expect(mockedCreateWorkspaceTemplateShare).toHaveBeenNthCalledWith(
        1,
        template,
        publicationKey,
      );
      expect(mockedCreateWorkspaceTemplateShare).toHaveBeenNthCalledWith(
        2,
        template,
        publicationKey,
      );
    });

    it('recovers stale share ownership after switching accounts', async () => {
      const publicationKey = 'a3c7b87a-a05a-4787-a9a4-38c930d80aef';
      const replacementExternalId = '66f19166-9d35-4a1d-a941-0d9ed15f2e6e';
      mockSidebarItems = [
        coworkItem({
          id: 'alpha',
          sharedTemplatePublicationKey: publicationKey,
          sharedTemplateExternalId: externalId,
          sharedTemplateContentHash: 'a'.repeat(64),
        }),
      ];
      mockedRepublishWorkspaceTemplateShare.mockRejectedValue(
        Object.assign(new Error('not found'), { status: 404 }),
      );
      mockedCreateWorkspaceTemplateShare.mockResolvedValue({
        externalId: replacementExternalId,
        sharePath: `/portal/plugins/project-templates/${replacementExternalId}`,
        pinnedContentHash: 'b'.repeat(64),
      });

      await expect(
        getHandler(IPC_CHANNELS.chatProjectTemplateSharePublish)(undefined, {
          projectId: 'alpha',
          document: template,
        }),
      ).resolves.toMatchObject({
        ok: true,
        value: {
          externalId: replacementExternalId,
          pinnedContentHash: 'b'.repeat(64),
          upToDate: true,
        },
      });
      expect(mockedRepublishWorkspaceTemplateShare).toHaveBeenCalledWith(
        externalId,
        template,
      );
      expect(mockedCreateWorkspaceTemplateShare).toHaveBeenCalledWith(
        template,
        publicationKey,
      );
      expect(mockSidebarItems[0]).toEqual(
        expect.objectContaining({
          sharedTemplatePublicationKey: publicationKey,
          sharedTemplateExternalId: replacementExternalId,
          sharedTemplateContentHash: 'b'.repeat(64),
        }),
      );
    });

    it('checks freshness against the server document without hashing locally', async () => {
      mockSidebarItems = [
        coworkItem({
          id: 'alpha',
          sharedTemplateExternalId: externalId,
          sharedTemplateContentHash: 'a'.repeat(64),
        }),
      ];
      mockedGetWorkspaceTemplateShareSnapshot.mockResolvedValue({
        entity: 'workspace',
        externalId,
        template,
        contentHash: 'a'.repeat(64),
        authorUsername: null,
        updatedAt: '2026-09-09T12:00:00.000Z',
      });

      await expect(
        getHandler(IPC_CHANNELS.chatProjectTemplateShareGet)(undefined, {
          projectId: 'alpha',
          document: template,
        }),
      ).resolves.toEqual({
        externalId,
        sharePath: `/portal/plugins/project-templates/${externalId}`,
        pinnedContentHash: 'a'.repeat(64),
        upToDate: true,
      });
    });

    it('clears stale local identity when the remote share is missing', async () => {
      mockSidebarItems = [
        coworkItem({
          id: 'alpha',
          sharedTemplatePublicationKey: 'a3c7b87a-a05a-4787-a9a4-38c930d80aef',
          sharedTemplateExternalId: externalId,
          sharedTemplateContentHash: 'a'.repeat(64),
        }),
      ];
      mockedGetWorkspaceTemplateShareSnapshot.mockRejectedValue(
        Object.assign(new Error('not found'), { status: 404 }),
      );

      await expect(
        getHandler(IPC_CHANNELS.chatProjectTemplateShareGet)(undefined, {
          projectId: 'alpha',
          document: template,
        }),
      ).resolves.toBeNull();
      expect(mockSidebarItems[0]).toEqual(
        expect.objectContaining({
          sharedTemplatePublicationKey: undefined,
          sharedTemplateExternalId: undefined,
          sharedTemplateContentHash: undefined,
        }),
      );
    });

    it('revokes the existing share and clears the persisted identity', async () => {
      mockSidebarItems = [
        coworkItem({
          id: 'alpha',
          sharedTemplatePublicationKey: 'a3c7b87a-a05a-4787-a9a4-38c930d80aef',
          sharedTemplateExternalId: externalId,
          sharedTemplateContentHash: 'a'.repeat(64),
        }),
      ];
      mockedRevokeWorkspaceTemplateShare.mockResolvedValue(undefined);

      await getHandler(IPC_CHANNELS.chatProjectTemplateShareRevoke)(undefined, {
        projectId: 'alpha',
      });

      expect(mockedRevokeWorkspaceTemplateShare).toHaveBeenCalledWith(
        externalId,
      );
      expect(mockSidebarItems[0]).toEqual(
        expect.objectContaining({
          sharedTemplatePublicationKey: undefined,
          sharedTemplateExternalId: undefined,
          sharedTemplateContentHash: undefined,
        }),
      );
    });

    it('clears stale local identity when remote revoke returns 404', async () => {
      mockSidebarItems = [
        coworkItem({
          id: 'alpha',
          sharedTemplatePublicationKey: 'a3c7b87a-a05a-4787-a9a4-38c930d80aef',
          sharedTemplateExternalId: externalId,
          sharedTemplateContentHash: 'a'.repeat(64),
        }),
      ];
      mockedRevokeWorkspaceTemplateShare.mockRejectedValue(
        Object.assign(new Error('not found'), { status: 404 }),
      );

      await expect(
        getHandler(IPC_CHANNELS.chatProjectTemplateShareRevoke)(undefined, {
          projectId: 'alpha',
        }),
      ).resolves.toBeUndefined();
      expect(mockSidebarItems[0]).toEqual(
        expect.objectContaining({
          sharedTemplatePublicationKey: undefined,
          sharedTemplateExternalId: undefined,
          sharedTemplateContentHash: undefined,
        }),
      );
    });
  });

  describe('chatProjectUpdate', () => {
    it('writes the cowork settings block and mirrors index fields', async () => {
      mockSidebarItems = [
        coworkItem({
          id: 'alpha',
          cowork: {
            createdAt: '2025-02-01T00:00:00.000Z',
            archiveRetentionDays: null,
          },
        }),
      ];

      await getHandler(IPC_CHANNELS.chatProjectUpdate)(undefined, {
        projectId: 'alpha',
        name: 'Alpha Renamed',
        color: '#EF4444',
        description: 'An updated description',
        defaultModel: 'claude-opus',
        archiveRetentionDays: 14,
      });

      expect(mockSidebarItems).toMatchObject([
        {
          id: 'alpha',
          name: 'Alpha Renamed',
          color: '#EF4444',
          cowork: {
            createdAt: '2025-02-01T00:00:00.000Z',
            description: 'An updated description',
            defaultModel: 'claude-opus',
            archiveRetentionDays: 14,
          },
        },
      ]);
    });

    it('throws when the project does not exist', async () => {
      mockSidebarItems = [];

      await expect(
        getHandler(IPC_CHANNELS.chatProjectUpdate)(undefined, {
          projectId: 'missing',
        }),
      ).rejects.toThrow('Chat project not found');
    });

    it('rejects deletion retention above the supported maximum', async () => {
      mockSidebarItems = [coworkItem({ id: 'alpha' })];

      await expect(
        getHandler(IPC_CHANNELS.chatProjectUpdate)(undefined, {
          projectId: 'alpha',
          archiveRetentionDays: MAX_ARCHIVE_RETENTION_DAYS + 1,
        }),
      ).rejects.toThrow(
        `Archive retention must be null or an integer from 0 to ${MAX_ARCHIVE_RETENTION_DAYS}`,
      );
    });

    it('resolves a legacy chat-project id to its cowork project id before updating', async () => {
      mockSidebarItems = [coworkItem({ id: 'alpha' })];
      mockedResolveCoworkWorkspaceId.mockImplementation((id: string) =>
        id === 'legacy-alpha' ? 'alpha' : id,
      );

      await getHandler(IPC_CHANNELS.chatProjectUpdate)(undefined, {
        projectId: 'legacy-alpha',
        name: 'Alpha Renamed',
      });

      expect(mockedResolveCoworkWorkspaceId).toHaveBeenCalledWith(
        'legacy-alpha',
      );
      expect(mockSidebarItems).toMatchObject([
        { id: 'alpha', name: 'Alpha Renamed' },
      ]);
    });
  });

  // The handler is an adapter over the canonical deletion. Admission, session
  // teardown, refusal copy and removal run for real in
  // `ipc/__tests__/chat-project-delete.test.ts`.
  describe('chatProjectDelete', () => {
    it('routes the deletion to the canonical Cowork deletion, then records the adapter telemetry', async () => {
      await getHandler(IPC_CHANNELS.chatProjectDelete)(undefined, {
        projectId: 'alpha',
        chatDisposition: 'move',
      });

      expect(mockedDeleteWorkspace.mock.calls).toEqual([
        [
          {
            workspaceId: 'alpha',
            source: 'chat_project_delete',
            coworkProject: true,
          },
        ],
      ]);
      expect(mockedRecordStandaloneProjectCrudTelemetry.mock.calls).toEqual([
        [{ action: 'delete', projectId: 'alpha', chatDisposition: 'move' }],
      ]);
      expect(mockedDeleteWorkspace.mock.invocationCallOrder[0]).toBeLessThan(
        mockedRecordStandaloneProjectCrudTelemetry.mock
          .invocationCallOrder[0] ?? 0,
      );
    });

    it('propagates a canonical refusal unchanged and records no telemetry', async () => {
      const refusal = Object.assign(
        new Error('Delegates are still running here. Stop them first.'),
        { code: 'conflict' },
      );
      mockedDeleteWorkspace.mockRejectedValueOnce(refusal);

      await expect(
        getHandler(IPC_CHANNELS.chatProjectDelete)(undefined, {
          projectId: 'alpha',
          chatDisposition: 'delete',
        }),
      ).rejects.toBe(refusal);
      expect(mockedRecordStandaloneProjectCrudTelemetry).not.toHaveBeenCalled();
    });

    it('rejects an invalid chatDisposition', async () => {
      mockSidebarItems = [coworkItem({ id: 'alpha' })];

      await expect(
        getHandler(IPC_CHANNELS.chatProjectDelete)(undefined, {
          projectId: 'alpha',
          chatDisposition: 'bogus',
        }),
      ).rejects.toThrow('Invalid chatDisposition');
      expect(mockedDeleteWorkspace).not.toHaveBeenCalled();
      expect(mockedRecordStandaloneProjectCrudTelemetry).not.toHaveBeenCalled();
    });

    it('validates the project id before resolving or deleting it', async () => {
      mockedValidateId.mockImplementationOnce(() => {
        throw new Error('Invalid projectId');
      });

      await expect(
        getHandler(IPC_CHANNELS.chatProjectDelete)(undefined, {
          projectId: '../alpha',
          chatDisposition: 'delete',
        }),
      ).rejects.toThrow('Invalid projectId');
      expect(mockedValidateId).toHaveBeenCalledWith('../alpha', 'projectId');
      expect(mockedResolveCoworkWorkspaceId).not.toHaveBeenCalled();
      expect(mockedDeleteWorkspace).not.toHaveBeenCalled();
    });

    it('resolves a legacy chat-project id to its cowork project id before deleting', async () => {
      mockedResolveCoworkWorkspaceId.mockImplementation((id: string) =>
        id === 'legacy-alpha' ? 'alpha' : id,
      );

      await getHandler(IPC_CHANNELS.chatProjectDelete)(undefined, {
        projectId: 'legacy-alpha',
        chatDisposition: 'delete',
      });

      expect(mockedResolveCoworkWorkspaceId).toHaveBeenCalledWith(
        'legacy-alpha',
      );
      expect(mockedDeleteWorkspace).toHaveBeenCalledWith(
        expect.objectContaining({ workspaceId: 'alpha' }),
      );
      expect(mockedRecordStandaloneProjectCrudTelemetry).toHaveBeenCalledWith({
        action: 'delete',
        projectId: 'alpha',
        chatDisposition: 'delete',
      });
    });
  });

  describe('chatProjectLoadClaudeMd / chatProjectSaveClaudeMd', () => {
    it('loads CLAUDE.md from the project home directory', async () => {
      mockSidebarItems = [coworkItem({ id: 'alpha' })];
      mockedReadFile.mockImplementation((filePath) => {
        if (filePath === '/mock/workspaces/alpha/home/CLAUDE.md') {
          return Promise.resolve('# Alpha instructions');
        }
        return Promise.reject(
          Object.assign(new Error('ENOENT'), { code: 'ENOENT' }),
        );
      });

      const result = await getHandler(IPC_CHANNELS.chatProjectLoadClaudeMd)(
        undefined,
        { projectId: 'alpha' },
      );

      expect(result).toBe('# Alpha instructions');
    });

    it('returns empty string when CLAUDE.md does not exist', async () => {
      mockSidebarItems = [coworkItem({ id: 'alpha' })];

      const result = await getHandler(IPC_CHANNELS.chatProjectLoadClaudeMd)(
        undefined,
        { projectId: 'alpha' },
      );

      expect(result).toBe('');
    });

    it('rethrows non-ENOENT read errors', async () => {
      mockSidebarItems = [coworkItem({ id: 'alpha' })];
      mockedReadFile.mockRejectedValue(
        Object.assign(new Error('EACCES'), { code: 'EACCES' }),
      );

      await expect(
        getHandler(IPC_CHANNELS.chatProjectLoadClaudeMd)(undefined, {
          projectId: 'alpha',
        }),
      ).rejects.toThrow('EACCES');
    });

    it('saves CLAUDE.md into the project home directory and syncs AGENTS.md', async () => {
      mockSidebarItems = [coworkItem({ id: 'alpha' })];

      await getHandler(IPC_CHANNELS.chatProjectSaveClaudeMd)(undefined, {
        projectId: 'alpha',
        content: '# Updated instructions',
      });

      expect(mockedWriteFile).toHaveBeenCalledWith(
        '/mock/workspaces/alpha/home/CLAUDE.md',
        '# Updated instructions',
        'utf8',
      );
      expect(mockedSyncChatProjectAgentsMd).toHaveBeenCalledWith('alpha');
    });

    it('rejects unknown projects for load/save', async () => {
      mockSidebarItems = [];

      await expect(
        getHandler(IPC_CHANNELS.chatProjectLoadClaudeMd)(undefined, {
          projectId: 'missing',
        }),
      ).rejects.toThrow('Chat project not found');

      await expect(
        getHandler(IPC_CHANNELS.chatProjectSaveClaudeMd)(undefined, {
          projectId: 'missing',
          content: 'x',
        }),
      ).rejects.toThrow('Chat project not found');

      expect(mockedWriteFile).not.toHaveBeenCalled();
    });
  });
});
