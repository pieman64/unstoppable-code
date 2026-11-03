import { W5_UNREACHABLE_READ_MESSAGE } from '@canopy/core-runtime/node/w5/file-store';
jest.mock('../../canopy-cloud/model-library-access', () => ({
  probeEntitlementsWithModelLibrary: jest.fn(),
}));
jest.mock('../adapters/watchers-adapter', () => ({
  listPortalWatchersForSnapshot: jest.fn(() => Promise.resolve([])),
}));
import { listPortalWatchersForSnapshot } from '../adapters/watchers-adapter';
import { probeEntitlementsWithModelLibrary } from '../../canopy-cloud/model-library-access';
import { resolveAiCreditsScopeOwner } from '../../agents/work-owner';
jest.mock('../../services/sidebar-item-groups-service', () => ({
  projectSidebarItemGroups: jest.fn(() => Promise.resolve([])),
}));
import { projectSidebarItemGroups } from '../../services/sidebar-item-groups-service';
import type * as SidebarItemsModule from '../../lib/sidebar-items';
import type { SidebarItemsFile } from '@canopy/desktop-shared/types';
jest.mock('../../services/portal-pr-delta', () => ({
  getCachedPortalPrState: jest.fn(),
}));
import { getCachedPortalPrState } from '../../services/portal-pr-delta';
jest.mock('../../services/workspace-portal-service', () => ({
  listWorkspacePortalEntities: jest.fn(),
}));
jest.mock('../../agents/work-owner', () => ({
  resolveAiCreditsScopeOwner: jest.fn(() =>
    Promise.resolve({ kind: 'personal' }),
  ),
}));

jest.mock('../../lib/worktree-summary-scheduler', () => ({
  isWorktreeSummaryGenerating: jest.fn(() => false),
}));
jest.mock('../../services/terminal-service', () => ({
  listTerminalPortalEntities: jest.fn(),
}));
jest.mock('../../services/plans-service', () => ({
  listPlans: jest.fn(),
  planToPortalEntity: jest.fn(),
}));
jest.mock('../../services/files-service', () => ({
  listFileRoots: jest.fn(),
}));
jest.mock('../../services/diff-service', () => ({
  listChangedFileSets: jest.fn(),
}));
jest.mock('../../services/pr-service', () => ({
  refreshPullRequestState: jest.fn(),
}));
jest.mock('../../services/chat-service', () => ({
  getWorktreeChatTranscriptSeed: jest.fn(),
  getAppAdvisorChatTranscriptSeed: jest.fn(),
  listAppAdvisorChatSummaries: jest.fn(),
  listWorktreeChatSummaries: jest.fn(),
  listWorktreeTodoEntities: jest.fn(),
}));
jest.mock('../../lib/cowork-work-entries', () => ({
  listWorkEntries: jest.fn(),
  resolveWorkEntryForChat: jest.fn(),
}));
jest.mock('../../ipc/app-advisor', () => ({
  getLatestAppAdvisorWindowUiState: jest.fn(),
}));
jest.mock('../portal-performance-diagnostics', () => ({
  elapsedMilliseconds: jest.fn(() => 0),
  recordPortalSnapshotTiming: jest.fn(),
}));
import type * as StandaloneChatService from '../../services/standalone-chat-service';

jest.mock('../../services/standalone-chat-service', () => {
  const actual = jest.requireActual<typeof StandaloneChatService>(
    '../../services/standalone-chat-service',
  );
  return {
    ...actual,
    getStandaloneChatTranscriptSeed: jest.fn(),
    listStandaloneChats: jest.fn(),
    withStandalonePendingQuestions: jest.fn(),
  };
});
jest.mock('../../services/scripts-service', () => ({
  listScripts: jest.fn(),
  listScriptRuns: jest.fn(),
  scriptToPortalEntity: jest.fn(),
}));
jest.mock('../../services/hooks-service', () => ({
  hookToPortalEntity: jest.fn(),
  listHookRuns: jest.fn(),
  listHooks: jest.fn(),
}));
jest.mock('../../services/pipelines-service', () => ({
  listPipelineRuns: jest.fn(),
  listPipelines: jest.fn(),
  pipelineToPortalEntity: jest.fn(),
}));
jest.mock('../../lib/worktree-summary-persistence', () => ({
  readWorktreeSummary: jest.fn(),
}));
jest.mock('../portal-state-store', () => ({
  readPortalStateStore: jest.fn(),
}));
jest.mock('../model-catalog-projection', () => ({
  buildProjectedModelCatalog: jest.fn(),
}));
jest.mock('../../auth/provider-auth-state', () => ({
  peekPortalProviderAvailability: jest.fn(),
  peekProviderNativeAuthAvailability: jest.fn(),
}));
jest.mock('../../lib/sidebar-items', () => ({
  readAllSidebarItems: jest.fn(),
}));
jest.mock('../portal-workspace-reads', () => ({
  readPortalSidebarItems: (): Promise<SidebarItemsFile> =>
    jest
      .requireMock<typeof SidebarItemsModule>('../../lib/sidebar-items')
      .readAllSidebarItems(),
}));
jest.mock('../adapters/mcp-adapter', () => ({
  listPortalMcpServerEntitiesForWorktree: jest.fn(),
}));
jest.mock('../adapters/bg-processes-adapter', () => ({
  listPortalBackgroundProcessEntitiesForWorktree: jest.fn(),
}));
const mockGetUsageOverview = jest.fn();
const mockRefreshProviderUsage = jest.fn();
jest.mock('../../observability', (): unknown => ({
  getObservabilityService: () => ({
    getUsageOverview: mockGetUsageOverview,
    refreshProviderUsage: mockRefreshProviderUsage,
  }),
}));

import { listWorkspacePortalEntities } from '../../services/workspace-portal-service';
import { listTerminalPortalEntities } from '../../services/terminal-service';
import { listPlans } from '../../services/plans-service';
import { listFileRoots } from '../../services/files-service';
import { listChangedFileSets } from '../../services/diff-service';
import { refreshPullRequestState } from '../../services/pr-service';
import {
  getAppAdvisorChatTranscriptSeed,
  getWorktreeChatTranscriptSeed,
  listAppAdvisorChatSummaries,
  listWorktreeChatSummaries,
  listWorktreeTodoEntities,
} from '../../services/chat-service';
import {
  listWorkEntries,
  resolveWorkEntryForChat,
} from '../../lib/cowork-work-entries';
import { getLatestAppAdvisorWindowUiState } from '../../ipc/app-advisor';
import {
  getStandaloneChatTranscriptSeed,
  listStandaloneChats,
  projectStandaloneChatSnapshot,
  withStandalonePendingQuestions,
} from '../../services/standalone-chat-service';
import {
  listScriptRuns,
  listScripts,
  scriptToPortalEntity,
} from '../../services/scripts-service';
import { listHookRuns, listHooks } from '../../services/hooks-service';
import {
  listPipelineRuns,
  listPipelines,
  pipelineToPortalEntity,
} from '../../services/pipelines-service';
import { readAllSidebarItems } from '../../lib/sidebar-items';
import { readWorktreeSummary } from '../../lib/worktree-summary-persistence';
import { isWorktreeSummaryGenerating } from '../../lib/worktree-summary-scheduler';
import type {
  AgentUsageOverview,
  CoworkWorkEntryMeta,
  PortalEntityEnvelope,
  PortalEventEnvelope,
  PortalPipelineSummary,
  PortalScriptSummary,
} from '@canopy/desktop-shared/types';
import { APP_ADVISOR_PROJECT_ID } from '@canopy/desktop-shared/types';
import type {
  PortalChangedFile,
  PortalChangedFilesPayload,
} from '@canopy/protocol/portal';
import { PORTAL_EVENT_BATCH_MAX_BYTES } from '@canopy/protocol/portal';
import { buildPortalSnapshot } from '../portal-snapshot-builders';
import {
  portalEventMaxRoutedByteLength,
  splitOversizedPortalSnapshotEvent,
} from '../portal-outbox';
import { readPortalStateStore } from '../portal-state-store';
import { buildProjectedModelCatalog } from '../model-catalog-projection';
import {
  peekPortalProviderAvailability,
  peekProviderNativeAuthAvailability,
} from '../../auth/provider-auth-state';
import { listPortalMcpServerEntitiesForWorktree } from '../adapters/mcp-adapter';
import { listPortalBackgroundProcessEntitiesForWorktree } from '../adapters/bg-processes-adapter';

const mockedListWorkspacePortalEntities = jest.mocked(
  listWorkspacePortalEntities,
);
const mockedListPortalBackgroundProcessEntitiesForWorktree = jest.mocked(
  listPortalBackgroundProcessEntitiesForWorktree,
);
const mockedListStandaloneChats = jest.mocked(listStandaloneChats);
const mockedWithStandalonePendingQuestions = jest.mocked(
  withStandalonePendingQuestions,
);
const mockedGetStandaloneChatTranscriptSeed = jest.mocked(
  getStandaloneChatTranscriptSeed,
);
const mockedListTerminalPortalEntities = jest.mocked(
  listTerminalPortalEntities,
);
const mockedListPlans = jest.mocked(listPlans);
const mockedListFileRoots = jest.mocked(listFileRoots);
const mockedListChangedFileSets = jest.mocked(listChangedFileSets);
const mockedRefreshPullRequestState = jest.mocked(refreshPullRequestState);
const mockedListWorktreeChatSummaries = jest.mocked(listWorktreeChatSummaries);
const mockedListAppAdvisorChatSummaries = jest.mocked(
  listAppAdvisorChatSummaries,
);
const mockedGetAppAdvisorChatTranscriptSeed = jest.mocked(
  getAppAdvisorChatTranscriptSeed,
);
const mockedListWorkEntries = jest.mocked(listWorkEntries);
const mockedResolveWorkEntryForChat = jest.mocked(resolveWorkEntryForChat);
const mockedGetLatestAppAdvisorWindowUiState = jest.mocked(
  getLatestAppAdvisorWindowUiState,
);
const mockedListWorktreeTodoEntities = jest.mocked(listWorktreeTodoEntities);
const mockedGetWorktreeChatTranscriptSeed = jest.mocked(
  getWorktreeChatTranscriptSeed,
);
const mockedListScripts = jest.mocked(listScripts);
const mockedListScriptRuns = jest.mocked(listScriptRuns);
const mockedListHooks = jest.mocked(listHooks);
const mockedListHookRuns = jest.mocked(listHookRuns);
const mockedListPipelines = jest.mocked(listPipelines);
const mockedListPipelineRuns = jest.mocked(listPipelineRuns);
const mockedScriptToPortalEntity = jest.mocked(scriptToPortalEntity);
const mockedPipelineToPortalEntity = jest.mocked(pipelineToPortalEntity);
const mockedReadAllSidebarItems = jest.mocked(readAllSidebarItems);
const mockedReadWorktreeSummary = jest.mocked(readWorktreeSummary);
const mockedIsWorktreeSummaryGenerating = jest.mocked(
  isWorktreeSummaryGenerating,
);
const mockedReadPortalStateStore = jest.mocked(readPortalStateStore);
const mockedBuildProjectedModelCatalog = jest.mocked(
  buildProjectedModelCatalog,
);
const mockedPeekProviderNativeAuthAvailability = jest.mocked(
  peekProviderNativeAuthAvailability,
);
const mockedPeekPortalProviderAvailability = jest.mocked(
  peekPortalProviderAvailability,
);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function oversizedWorktreeSiblingEntities(): PortalEntityEnvelope[] {
  return [
    {
      entityType: 'workspace',
      localId: 'workspace-sibling-1',
      payload: { details: 'a'.repeat(600_000) },
    },
    {
      entityType: 'workspace',
      localId: 'workspace-sibling-2',
      payload: { details: 'b'.repeat(600_000) },
    },
  ];
}

const mockedListPortalMcpServerEntitiesForWorktree = jest.mocked(
  listPortalMcpServerEntitiesForWorktree,
);

function appAdvisorEntries(...ids: string[]): CoworkWorkEntryMeta[] {
  return ids.map((id) => ({
    id,
    title: `Entry ${id}`,
    createdAt: '2026-08-01T00:00:00.000Z',
    chatCount: 1,
  }));
}

describe('Portal snapshot builders standalone chat routing', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.mocked(projectSidebarItemGroups).mockResolvedValue([]);
    jest.mocked(getCachedPortalPrState).mockReturnValue(undefined);
    mockedListWorkspacePortalEntities.mockResolvedValue([]);
    mockedListTerminalPortalEntities.mockReturnValue([]);
    mockedListPlans.mockResolvedValue([]);
    mockedListFileRoots.mockResolvedValue([]);
    mockedListChangedFileSets.mockResolvedValue({
      workspaceLocalId: 'workspace-1',
      worktreeLocalId: 'snake',
      uncommitted: [],
      committed: [],
    });
    mockedRefreshPullRequestState.mockRejectedValue(new Error('no pr'));
    mockedListWorktreeChatSummaries.mockResolvedValue([]);
    mockedListAppAdvisorChatSummaries.mockResolvedValue([]);
    mockedListWorkEntries.mockResolvedValue([]);
    mockedResolveWorkEntryForChat.mockResolvedValue({
      entryId: 'entry-1',
      archivedInEntryId: null,
    });
    mockedGetLatestAppAdvisorWindowUiState.mockReturnValue({
      activeWorkEntryId: null,
      activeChatId: null,
      navCollapsed: false,
      settingsModalOpen: false,
      archivedOverviewOpen: false,
      archivedOverviewWorkspaceId: null,
      emptyTrashConfirmationOpen: false,
      emptyTrashRunning: false,
      lastArchivedOverviewRequestId: null,
      lastArchivedOverviewConfirmationOpened: null,
    });
    mockedGetAppAdvisorChatTranscriptSeed.mockResolvedValue({
      messages: [],
      truncated: false,
    });
    mockedListWorktreeTodoEntities.mockResolvedValue([]);
    mockedGetWorktreeChatTranscriptSeed.mockResolvedValue({
      messages: [],
      truncated: false,
    });
    mockedGetStandaloneChatTranscriptSeed.mockResolvedValue({
      messages: [],
      truncated: false,
    });
    mockedListStandaloneChats.mockResolvedValue([]);
    mockedWithStandalonePendingQuestions.mockImplementation((chat) =>
      Promise.resolve(chat),
    );
    mockedListScripts.mockResolvedValue([]);
    mockedListScriptRuns.mockResolvedValue([]);
    mockedListHooks.mockResolvedValue([]);
    mockedListHookRuns.mockResolvedValue([]);
    mockedListPipelines.mockResolvedValue([]);
    mockedListPipelineRuns.mockResolvedValue([]);
    mockedReadAllSidebarItems.mockResolvedValue({ version: 1, items: [] });
    mockedReadWorktreeSummary.mockResolvedValue(null);
    mockedIsWorktreeSummaryGenerating.mockReturnValue(false);
    mockedReadPortalStateStore.mockResolvedValue({
      version: 1,
      clientDeviceId: 'device-1',
    });
    mockedBuildProjectedModelCatalog.mockReturnValue([
      {
        id: 'claude-sonnet',
        label: 'Sonnet',
        provider: 'claude',
        kind: 'model',
        available: true,
      },
    ]);
    mockedPeekProviderNativeAuthAvailability.mockReturnValue({ claude: true });
    mockedPeekPortalProviderAvailability.mockReturnValue({ claude: true });
    mockedListPortalMcpServerEntitiesForWorktree.mockResolvedValue([]);
    mockedListPortalBackgroundProcessEntitiesForWorktree.mockReturnValue([]);
  });

  it('caps an oversized changed-files entity to the actual routed outbox budget', async () => {
    const changedFiles: PortalChangedFile[] = Array.from(
      { length: 14_000 },
      (_, index) => ({
        filePath: `generated/component-library/src/widgets/file-${String(index).padStart(5, '0')}.tsx`,
        status: 'added',
        staged: true,
        insertions: 0,
        deletions: 0,
        repoId: 'repo-a',
      }),
    );
    const fullPayload: PortalChangedFilesPayload = {
      workspaceLocalId: 'workspace-1',
      worktreeLocalId: 'snake',
      uncommitted: changedFiles,
      committed: [],
    };
    mockedListChangedFileSets.mockResolvedValue(fullPayload);

    const built = await buildPortalSnapshot(
      {
        scope: 'diff',
        target: {
          workspaceLocalId: 'workspace-1',
          worktreeLocalId: 'snake',
        },
      },
      { commandId: 'cmd-1' },
    );
    const event: PortalEventEnvelope = {
      type: 'portal.state.snapshot',
      commandId: 'cmd-1',
      eventId: '00000000-0000-4000-8000-000000000000',
      clientEventId: '00000000-0000-4000-8000-000000000000',
      occurredAt: built.snapshot.generatedAt,
      payload: built.snapshot,
    };
    const changedFilesEntity = built.snapshot.entities.find(
      (entity) => entity.entityType === 'changed_files',
    );

    const changedFilesPayload = recordOf(changedFilesEntity?.payload);
    const page = recordOf(changedFilesPayload?.page);
    const uncommittedPage = recordOf(page?.uncommitted);
    const committedPage = recordOf(page?.committed);
    expect(changedFilesPayload?.notices).toEqual([{ kind: 'truncated' }]);
    expect(uncommittedPage?.total).toBe(changedFiles.length);
    expect(typeof uncommittedPage?.nextCursor).toBe('string');
    expect(committedPage?.total).toBe(0);
    const routedBatchBudget = PORTAL_EVENT_BATCH_MAX_BYTES - 4096;
    expect(portalEventMaxRoutedByteLength(event)).toBeLessThanOrEqual(
      routedBatchBudget,
    );
    expect(
      splitOversizedPortalSnapshotEvent(event, routedBatchBudget),
    ).toMatchObject({ events: [event], droppedEntityCount: 0 });
  });

  it('keeps small worktree changed-files complete when sibling entities exceed 1 MiB', async () => {
    const changedFiles: PortalChangedFile[] = [
      { filePath: 'src/app.ts', status: 'modified', repoId: 'repo-a' },
      { filePath: 'src/index.ts', status: 'added', repoId: 'repo-a' },
      { filePath: 'README.md', status: 'deleted', repoId: 'repo-a' },
    ];
    const fullPayload: PortalChangedFilesPayload = {
      workspaceLocalId: 'workspace-1',
      worktreeLocalId: 'snake',
      uncommitted: changedFiles,
      committed: [],
    };
    mockedListWorkspacePortalEntities.mockResolvedValue(
      oversizedWorktreeSiblingEntities(),
    );
    mockedListChangedFileSets.mockResolvedValue(fullPayload);

    const built = await buildPortalSnapshot({
      scope: 'worktree',
      target: {
        workspaceLocalId: 'workspace-1',
        worktreeLocalId: 'snake',
      },
    });
    const event: PortalEventEnvelope = {
      type: 'portal.state.snapshot',
      eventId: '00000000-0000-4000-8000-000000000000',
      clientEventId: '00000000-0000-4000-8000-000000000000',
      occurredAt: built.snapshot.generatedAt,
      payload: built.snapshot,
    };
    const changedFilesEntity = built.snapshot.entities.find(
      (entity) => entity.entityType === 'changed_files',
    );
    const changedFilesPayload = recordOf(changedFilesEntity?.payload);

    expect(portalEventMaxRoutedByteLength(event)).toBeGreaterThan(1_048_576);
    expect(changedFilesPayload?.uncommitted).toEqual(changedFiles);
    expect(changedFilesPayload?.committed).toEqual([]);
    expect(changedFilesPayload).not.toHaveProperty('notices');
    expect(changedFilesPayload).not.toHaveProperty('page');
  });

  it('caps worktree changed-files against a head frame containing only that entity', async () => {
    const changedFiles: PortalChangedFile[] = Array.from(
      { length: 14_000 },
      (_, index) => ({
        filePath: `generated/component-library/src/widgets/file-${String(index).padStart(5, '0')}.tsx`,
        status: 'added',
        staged: true,
        insertions: 0,
        deletions: 0,
        repoId: 'repo-a',
      }),
    );
    mockedListWorkspacePortalEntities.mockResolvedValue(
      oversizedWorktreeSiblingEntities(),
    );
    mockedListChangedFileSets.mockResolvedValue({
      workspaceLocalId: 'workspace-1',
      worktreeLocalId: 'snake',
      uncommitted: changedFiles,
      committed: [],
    });

    const built = await buildPortalSnapshot({
      scope: 'worktree',
      target: {
        workspaceLocalId: 'workspace-1',
        worktreeLocalId: 'snake',
      },
    });
    const event: PortalEventEnvelope = {
      type: 'portal.state.snapshot',
      eventId: '00000000-0000-4000-8000-000000000000',
      clientEventId: '00000000-0000-4000-8000-000000000000',
      occurredAt: built.snapshot.generatedAt,
      payload: built.snapshot,
    };
    const changedFilesEntity = built.snapshot.entities.find(
      (entity) => entity.entityType === 'changed_files',
    );
    if (!changedFilesEntity) throw new Error('Missing changed-files entity');

    const changedFilesPayload = recordOf(changedFilesEntity.payload);
    const page = recordOf(changedFilesPayload?.page);
    const uncommittedPage = recordOf(page?.uncommitted);
    expect(changedFilesPayload?.notices).toEqual([{ kind: 'truncated' }]);
    expect(uncommittedPage?.total).toBe(changedFiles.length);
    expect(typeof uncommittedPage?.nextCursor).toBe('string');
    expect(changedFilesPayload?.uncommitted).not.toHaveLength(
      changedFiles.length,
    );

    const routedBatchBudget = PORTAL_EVENT_BATCH_MAX_BYTES - 4096;
    const headFramedEvent: PortalEventEnvelope = {
      ...event,
      payload: {
        ...built.snapshot,
        entities: [changedFilesEntity],
      },
    };
    expect(portalEventMaxRoutedByteLength(headFramedEvent)).toBeLessThanOrEqual(
      routedBatchBudget,
    );
  });

  it('keeps the Phase 05 short-path changed-files fixture complete', async () => {
    const changedFiles: PortalChangedFile[] = Array.from(
      { length: 10_200 },
      (_, index) => ({
        filePath: `src/generated/foo/file-${String(index).padStart(5, '0')}.tsx`,
        status: 'added',
        repoId: 'repo-a',
      }),
    );
    const fullPayload: PortalChangedFilesPayload = {
      workspaceLocalId: 'workspace-1',
      worktreeLocalId: 'snake',
      uncommitted: changedFiles,
      committed: [],
    };
    mockedListChangedFileSets.mockResolvedValue(fullPayload);
    const fullPayloadBytes = Buffer.byteLength(
      JSON.stringify(fullPayload),
      'utf8',
    );
    expect(fullPayloadBytes).toBeGreaterThan(800_000);
    expect(fullPayloadBytes).toBeLessThan(900_000);

    const built = await buildPortalSnapshot({
      scope: 'diff',
      target: {
        workspaceLocalId: 'workspace-1',
        worktreeLocalId: 'snake',
      },
    });
    const changedFilesEntity = built.snapshot.entities.find(
      (entity) => entity.entityType === 'changed_files',
    );

    expect(changedFilesEntity?.payload).toMatchObject({
      uncommitted: changedFiles,
      committed: [],
    });
    expect(JSON.stringify(changedFilesEntity?.payload)).toBe(
      JSON.stringify(fullPayload),
    );
    expect(changedFilesEntity?.payload).not.toHaveProperty('notices');
    expect(changedFilesEntity?.payload).not.toHaveProperty('page');
  });

  it('filters strict overview Cowork chats by visible parent, archive and valid scope identities', async () => {
    mockedListWorkspacePortalEntities.mockImplementation((_target, options) => {
      options?.onWorkspace?.({
        localId: 'cowork',
        name: 'Chats',
        type: 'cowork',
      });
      options?.onWorkspace?.({
        localId: 'hidden',
        name: 'Hidden',
        type: 'cowork',
        hidden: true,
      });
      options?.onWorkspace?.({
        localId: 'bad/id',
        name: 'Invalid',
        type: 'cowork',
      });
      return Promise.resolve([]);
    });
    const chat = {
      chatId: 'good',
      projectId: 'cowork',
      projectLocalId: 'cowork',
      title: 'Chat',
      hasUnread: true,
    };
    mockedListStandaloneChats.mockResolvedValue([
      chat,
      { ...chat, chatId: 'archived', archived: true },
      { ...chat, chatId: 'bad/id' },
      { ...chat, chatId: 'bad-entry', workEntryId: '../entry' },
      { ...chat, chatId: 'orphan', projectLocalId: 'missing' },
      { ...chat, chatId: 'hidden-chat', projectLocalId: 'hidden' },
      { ...chat, chatId: 'invalid-parent', projectLocalId: 'bad/id' },
    ]);
    const { snapshot } = await buildPortalSnapshot({
      scope: 'overview',
      includeChatSummaries: true,
    });
    expect(mockedListStandaloneChats).toHaveBeenCalledWith({
      strict: true,
      projectIds: ['cowork'],
    });
    expect(
      snapshot.entities
        .filter((entity) => entity.entityType === 'standalone_chat')
        .map((entity) => entity.localId),
    ).toEqual(['good']);
  });

  it('uses prepared PR state for activity but honors forced refresh', async () => {
    jest.mocked(getCachedPortalPrState).mockReturnValue({
      workspaceLocalId: 'workspace-1',
      worktreeLocalId: 'snake',
      number: 42,
    });
    const target = {
      workspaceLocalId: 'workspace-1',
      worktreeLocalId: 'snake',
    };
    const cached = await buildPortalSnapshot({ scope: 'worktree', target });
    expect(
      cached.snapshot.entities.find(
        (entity) => entity.entityType === 'pr_status',
      )?.payload,
    ).toMatchObject({ number: 42 });
    expect(mockedRefreshPullRequestState).not.toHaveBeenCalled();
    await buildPortalSnapshot({ scope: 'worktree', target, refresh: true });
    expect(mockedRefreshPullRequestState).toHaveBeenCalledTimes(1);
  });

  it('builds independent activity sections with a bound of two', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    mockedListPlans.mockImplementationOnce(async () => {
      await gate;
      return [];
    });
    mockedListScripts.mockImplementationOnce(async () => {
      await gate;
      return [];
    });
    const build = buildPortalSnapshot({
      scope: 'worktree',
      target: { workspaceLocalId: 'workspace-1', worktreeLocalId: 'snake' },
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    try {
      expect(mockedListPlans).toHaveBeenCalledTimes(1);
      expect(mockedListScripts).toHaveBeenCalledTimes(1);
      expect(mockedListHooks).not.toHaveBeenCalled();
    } finally {
      release();
      await build;
    }
    expect(mockedListHooks).toHaveBeenCalledTimes(1);
  });

  it('projects fresh desktop contextual access for the requested chat and correlates the refresh', async () => {
    const owner = {
      kind: 'organization' as const,
      organizationId: '11111111-1111-4111-8111-111111111111',
    };
    jest.mocked(resolveAiCreditsScopeOwner).mockResolvedValueOnce(owner);
    jest.mocked(probeEntitlementsWithModelLibrary).mockResolvedValue({
      accountKey: 'account:user-7',
      modelLibrary: { status: 'reported', access: 'unlocked' },
      workModelLibrary: { status: 'reported', access: 'needs_purchase' },
      probe: {
        resolved: true,
        canDisableSharing: false,
        canRemoteControl: false,
        source: 'none',
        plan: null,
        trial: null,
        billingManageableOrg: null,
        displayPlan: null,
        billingPresentation: null,
        freeAccess: false,
        modelLibrary: { status: 'reported', access: 'unlocked' },
        workModelLibrary: { status: 'reported', access: 'needs_purchase' },
      },
    });
    mockedListWorktreeChatSummaries.mockResolvedValue([
      {
        localId: 'selected',
        chatId: 'selected',
        scope: 'worktree',
        title: 'Chat',
        availableModels: [
          {
            id: 'opus[1m]',
            label: 'Opus',
            provider: 'claude',
            kind: 'model',
            available: true,
            extraChargeOnly: true,
          },
        ],
      },
    ]);
    const built = await buildPortalSnapshot(
      {
        scope: 'chat',
        selectedChatOnly: true,
        target: {
          workspaceLocalId: 'workspace-1',
          worktreeLocalId: 'snake',
          chatLocalId: 'selected',
        },
      },
      { commandId: 'refresh-1' },
    );
    expect(probeEntitlementsWithModelLibrary).toHaveBeenCalledWith(owner);
    const entity = built.snapshot.entities.find(
      (candidate) =>
        candidate.entityType === 'chat_summary' &&
        candidate.localId === 'selected',
    );
    expect(entity?.payload).toMatchObject({
      modelLibraryContext: {
        accountKey: 'account:user-7',
        owner,
        access: 'needs_purchase',
        authoritative: true,
        requestId: 'refresh-1',
      },
      availableModels: [{ id: 'opus[1m]', libraryEligibility: 'locked' }],
    });
  });

  it('hydrates only the active foreground chat without reading activity', async () => {
    mockedListWorktreeChatSummaries.mockResolvedValue([
      { localId: 'first', chatId: 'first', scope: 'worktree', title: 'First' },
      {
        localId: 'active',
        chatId: 'active',
        scope: 'worktree',
        title: 'Active',
        active: true,
      },
    ]);
    const request = {
      scope: 'chat' as const,
      selectedChatOnly: true,
      target: { workspaceLocalId: 'workspace-1', worktreeLocalId: 'snake' },
    };
    const built = await buildPortalSnapshot(request);
    expect(mockedGetWorktreeChatTranscriptSeed).toHaveBeenCalledWith({
      workspaceId: 'workspace-1',
      worktreeId: 'snake',
      chatId: 'active',
    });
    expect(built.snapshot.target).toEqual({
      ...request.target,
      chatLocalId: 'active',
    });
    expect(listPortalWatchersForSnapshot).toHaveBeenCalledWith(
      { ...request, target: built.snapshot.target },
      expect.any(Array),
    );
    expect(
      built.snapshot.entities.filter(
        (entity) => entity.entityType === 'chat_summary',
      ),
    ).toHaveLength(2);
    expect(mockedListWorkspacePortalEntities).not.toHaveBeenCalled();
    expect(mockedListPortalMcpServerEntitiesForWorktree).not.toHaveBeenCalled();
    expect(mockedReadWorktreeSummary).not.toHaveBeenCalled();
    expect(mockedListScripts).not.toHaveBeenCalled();
    expect(mockedListPipelines).not.toHaveBeenCalled();
  });

  it('keeps an explicit foreground selection ahead of the active tab', async () => {
    mockedListWorktreeChatSummaries.mockResolvedValue([
      {
        localId: 'active',
        chatId: 'active',
        scope: 'worktree',
        title: 'Active',
        active: true,
      },
    ]);
    await buildPortalSnapshot({
      scope: 'chat',
      selectedChatOnly: true,
      target: {
        workspaceLocalId: 'workspace-1',
        worktreeLocalId: 'snake',
        chatLocalId: 'selected',
      },
    });
    expect(mockedGetWorktreeChatTranscriptSeed).toHaveBeenCalledWith({
      workspaceId: 'workspace-1',
      worktreeId: 'snake',
      chatId: 'selected',
    });
  });

  it('starts a known transcript while summary resolution is still pending', async () => {
    let releaseSummaries!: () => void;
    mockedListWorktreeChatSummaries.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseSummaries = (): void => resolve([]);
        }),
    );
    const pending = buildPortalSnapshot({
      scope: 'chat',
      selectedChatOnly: true,
      target: {
        workspaceLocalId: 'workspace-1',
        worktreeLocalId: 'snake',
        chatLocalId: 'selected',
      },
    });
    // The state-store await precedes both independent reads.
    await Promise.resolve();
    await Promise.resolve();
    expect(mockedGetWorktreeChatTranscriptSeed).toHaveBeenCalledWith({
      workspaceId: 'workspace-1',
      worktreeId: 'snake',
      chatId: 'selected',
    });
    releaseSummaries();
    await pending;
  });

  it('does not read every transcript for an empty foreground worktree', async () => {
    const built = await buildPortalSnapshot({
      scope: 'chat',
      selectedChatOnly: true,
      target: { workspaceLocalId: 'workspace-1', worktreeLocalId: 'snake' },
    });
    expect(mockedGetWorktreeChatTranscriptSeed).not.toHaveBeenCalled();
    expect(built.snapshot.selectedChatOnly).toBe(true);
    expect(built.snapshot.chatMessages).toBeUndefined();
  });

  it('rejects foreground summary and transcript failures without publishing an empty replacement', async () => {
    const request = {
      scope: 'chat' as const,
      selectedChatOnly: true,
      target: {
        workspaceLocalId: 'workspace-1',
        worktreeLocalId: 'snake',
        chatLocalId: 'selected',
      },
    };
    mockedListWorktreeChatSummaries.mockRejectedValueOnce(
      new Error('tabs unavailable'),
    );
    await expect(buildPortalSnapshot(request)).rejects.toThrow(
      'tabs unavailable',
    );
    mockedGetWorktreeChatTranscriptSeed.mockRejectedValueOnce(
      new Error('transcript unavailable'),
    );
    await expect(buildPortalSnapshot(request)).rejects.toThrow(
      'transcript unavailable',
    );
  });

  it('includes the MCP inventory projection in worktree snapshots', async () => {
    mockedListPortalMcpServerEntitiesForWorktree.mockResolvedValue([
      {
        entityType: 'mcp_server',
        localId: 'plugin:market:plugin:server',
        parentLocalId: 'workspace-1:snake',
        payload: { marker: 'mcp' },
      },
    ]);

    const result = await buildPortalSnapshot({
      scope: 'worktree',
      target: {
        workspaceLocalId: 'workspace-1',
        worktreeLocalId: 'snake',
      },
    });

    expect(mockedListPortalMcpServerEntitiesForWorktree).toHaveBeenCalledWith({
      workspaceLocalId: 'workspace-1',
      worktreeLocalId: 'snake',
    });
    expect(result.snapshot.entities).toContainEqual(
      expect.objectContaining({
        entityType: 'mcp_server',
        localId: 'plugin:market:plugin:server',
      }),
    );
  });

  it('includes background-process projections in worktree snapshots', async () => {
    mockedListPortalBackgroundProcessEntitiesForWorktree.mockReturnValue([
      {
        entityType: 'background_process',
        localId: 'tool-1',
        parentLocalId: 'workspace-1:snake',
        payload: { marker: 'background-process' },
      },
    ]);

    const result = await buildPortalSnapshot({
      scope: 'worktree',
      target: {
        workspaceLocalId: 'workspace-1',
        worktreeLocalId: 'snake',
      },
    });

    expect(
      result.snapshot.entities.find(
        (entity) => entity.entityType === 'background_process',
      ),
    ).toMatchObject({ localId: 'tool-1' });
    expect(
      mockedListPortalBackgroundProcessEntitiesForWorktree,
    ).toHaveBeenCalledWith({
      workspaceLocalId: 'workspace-1',
      worktreeLocalId: 'snake',
    });
  });

  it('aggregates worktree actions across projects without a target', async () => {
    mockedReadAllSidebarItems.mockResolvedValue({
      version: 1,
      items: [
        {
          type: 'single-repo',
          id: 'workspace-1',
          name: 'One',
          repoPath: '/one',
          color: '#111',
          collapsed: false,
          order: 0,
          worktrees: [
            { id: 'tree-1', branchName: 'one', createdAt: '2026-01-01' },
          ],
        },
        {
          type: 'single-repo',
          id: 'workspace-2',
          name: 'Two',
          repoPath: '/two',
          color: '#222',
          collapsed: false,
          order: 1,
          worktrees: [
            { id: 'tree-2', branchName: 'two', createdAt: '2026-01-01' },
          ],
        },
      ],
    });
    const scriptFixture = (worktreeLocalId: string): PortalScriptSummary => ({
      workspaceLocalId:
        worktreeLocalId === 'tree-1' ? 'workspace-1' : 'workspace-2',
      worktreeLocalId,
      scriptId: 'launch',
      scriptKey: 'launch',
      scriptName: 'launch',
      name: 'Launch',
      target: 'project',
    });
    const pipelineFixture = (
      worktreeLocalId: string,
    ): PortalPipelineSummary => ({
      workspaceLocalId:
        worktreeLocalId === 'tree-1' ? 'workspace-1' : 'workspace-2',
      worktreeLocalId,
      pipelineId: 'deploy',
      name: 'Deploy',
    });
    mockedListScripts.mockImplementation((input) =>
      Promise.resolve([scriptFixture(input?.worktreeLocalId ?? 'unknown')]),
    );
    mockedListPipelines.mockImplementation((input) =>
      Promise.resolve([pipelineFixture(input?.worktreeId ?? 'unknown')]),
    );
    // Mirror the real mappers' projection so parentLocalId assertions below
    // exercise the same worktree keying the production entities carry.
    mockedScriptToPortalEntity.mockImplementation((script) => ({
      entityType: 'script_descriptor',
      localId: `${script.worktreeLocalId}:${script.scriptId}`,
      parentLocalId: `${script.workspaceLocalId}:${script.worktreeLocalId}`,
      payload: script,
    }));
    mockedPipelineToPortalEntity.mockImplementation((pipeline) => ({
      entityType: 'pipeline',
      localId: `${pipeline.worktreeLocalId}:${pipeline.pipelineId}`,
      parentLocalId: `${pipeline.workspaceLocalId}:${pipeline.worktreeLocalId}`,
      payload: pipeline,
    }));

    const built = await buildPortalSnapshot({ scope: 'worktree_actions' });

    expect(built.snapshot.scope).toBe('worktree_actions');
    expect(built.snapshot).not.toHaveProperty('target');
    expect(built.snapshot.entities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          entityType: 'script_descriptor',
          parentLocalId: 'workspace-1:tree-1',
        }),
        expect.objectContaining({
          entityType: 'pipeline',
          parentLocalId: 'workspace-1:tree-1',
        }),
        expect.objectContaining({
          entityType: 'script_descriptor',
          parentLocalId: 'workspace-2:tree-2',
        }),
        expect.objectContaining({
          entityType: 'pipeline',
          parentLocalId: 'workspace-2:tree-2',
        }),
      ]),
    );
  });

  it.each(['worktree_actions', 'worktree_chat_summaries'] as const)(
    'preserves an authoritative empty %s snapshot',
    async (scope) => {
      const built = await buildPortalSnapshot({ scope });
      expect(built.snapshot.entities).toHaveLength(1);
      expect(built.snapshot.entities[0]?.entityType).toBe('activity_summary');
    },
  );

  it.each([
    { scope: 'worktree_actions' },
    { scope: 'worktree_chat_summaries' },
    { scope: 'overview', includeChatSummaries: true },
  ] as const)(
    'rejects a stale $scope inventory instead of replacing authoritative cached sections',
    async (request) => {
      mockedReadAllSidebarItems.mockResolvedValue({
        version: 1,
        stale: true,
        items: [],
      });
      await expect(buildPortalSnapshot(request)).rejects.toThrow(
        W5_UNREACHABLE_READ_MESSAGE,
      );
    },
  );

  it('rejects instead of emitting an empty snapshot when the sidebar read fails', async () => {
    // An untargeted worktree_actions snapshot authoritatively replaces every
    // cached script/pipeline row, so a swallowed read failure would wipe the
    // session cache; the command must fail instead.
    mockedReadAllSidebarItems.mockRejectedValue(new Error('disk error'));
    await expect(
      buildPortalSnapshot({ scope: 'worktree_actions' }),
    ).rejects.toThrow('disk error');
  });

  it('aggregates chat summaries across projects for worktree_chat_summaries', async () => {
    // CAN-1990: batched, untargeted hydration for the sidebar chat search.
    mockedReadAllSidebarItems.mockResolvedValue({
      version: 1,
      items: [
        {
          type: 'single-repo',
          id: 'workspace-1',
          name: 'One',
          repoPath: '/one',
          color: '#111',
          collapsed: false,
          order: 0,
          worktrees: [
            { id: 'tree-1', branchName: 'one', createdAt: '2026-01-01' },
          ],
        },
        {
          type: 'multi-repo',
          id: 'workspace-2',
          name: 'Two',
          repos: [],
          color: '#222',
          collapsed: true,
          order: 1,
          worktrees: [
            { id: 'tree-2', branchName: 'two', createdAt: '2026-01-01' },
          ],
        },
      ],
    });
    mockedListWorktreeChatSummaries.mockImplementation((input) =>
      Promise.resolve([
        {
          localId: `chat-${input.worktreeId}`,
          chatId: `chat-${input.worktreeId}`,
          scope: 'worktree',
          workspaceLocalId: input.workspaceId,
          worktreeLocalId: input.worktreeId,
          title: `Chat in ${input.worktreeId}`,
        },
      ]),
    );

    const built = await buildPortalSnapshot({
      scope: 'worktree_chat_summaries',
    });

    expect(built.snapshot.scope).toBe('worktree_chat_summaries');
    expect(built.snapshot).not.toHaveProperty('target');
    expect(built.snapshot.entities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          entityType: 'chat_summary',
          localId: 'chat-tree-1',
          parentLocalId: 'workspace-1:tree-1',
        }),
        expect.objectContaining({
          entityType: 'chat_summary',
          localId: 'chat-tree-2',
          parentLocalId: 'workspace-2:tree-2',
        }),
      ]),
    );
  });

  it('projects canonical Advisor groups on the untargeted scope and omits them when the projection is unavailable', async () => {
    const groups = [
      {
        id: 'grp-review',
        name: 'Review',
        color: 'neutral' as const,
        collapsed: false,
        memberIds: ['entry-1'],
      },
    ];
    jest.mocked(projectSidebarItemGroups).mockResolvedValueOnce(groups);
    const built = await buildPortalSnapshot({ scope: 'app_advisor' });
    expect(built.snapshot.entities).toContainEqual({
      entityType: 'app_advisor_item_groups',
      localId: 'app-advisor',
      payload: { groups },
    });
    expect(projectSidebarItemGroups).toHaveBeenLastCalledWith({
      appAdvisor: true,
    });
    jest.mocked(projectSidebarItemGroups).mockResolvedValueOnce(undefined);
    const unavailable = await buildPortalSnapshot({ scope: 'app_advisor' });
    expect(
      unavailable.snapshot.entities.some(
        (entity) => entity.entityType === 'app_advisor_item_groups',
      ),
    ).toBe(false);
  });

  it('aggregates app_advisor_chat entities for the app_advisor scope and strips the target', async () => {
    mockedListWorkEntries.mockResolvedValue(
      appAdvisorEntries('entry-1', 'entry-2'),
    );
    mockedListAppAdvisorChatSummaries.mockImplementation((entryId) =>
      Promise.resolve([
        {
          localId: `chat-${entryId}`,
          chatId: `chat-${entryId}`,
          title: `Chat in ${entryId}`,
          pendingQuestions: [],
        },
      ]),
    );

    const built = await buildPortalSnapshot({
      scope: 'app_advisor',
      // A stray target must be stripped: app_advisor is an untargeted scope.
      target: { workspaceLocalId: 'app-advisor' },
    });

    expect(built.snapshot.scope).toBe('app_advisor');
    expect(built.snapshot).not.toHaveProperty('target');
    expect(built.snapshot.entities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          entityType: 'app_advisor_chat',
          localId: 'chat-entry-1',
        }),
        expect.objectContaining({
          entityType: 'app_advisor_chat',
          localId: 'chat-entry-2',
        }),
      ]),
    );
    // Routing-free entities: no parentLocalId is stamped.
    expect(
      built.snapshot.entities
        .filter((entity) => entity.entityType === 'app_advisor_chat')
        .every((entity) => entity.parentLocalId === undefined),
    ).toBe(true);
  });

  it('projects the desktop-current App Advisor Work Entry first', async () => {
    mockedListWorkEntries.mockResolvedValue(
      appAdvisorEntries('stale-entry', 'current-entry'),
    );
    mockedGetLatestAppAdvisorWindowUiState.mockReturnValue({
      activeWorkEntryId: 'current-entry',
      activeChatId: 'current-entry-chat',
      navCollapsed: false,
      settingsModalOpen: false,
      archivedOverviewOpen: false,
      archivedOverviewWorkspaceId: null,
      emptyTrashConfirmationOpen: false,
      emptyTrashRunning: false,
      lastArchivedOverviewRequestId: null,
      lastArchivedOverviewConfirmationOpened: null,
    });
    mockedListAppAdvisorChatSummaries.mockImplementation((entryId) =>
      Promise.resolve([
        {
          localId: `${entryId}-chat`,
          chatId: `${entryId}-chat`,
          title: `Chat in ${entryId}`,
          active: true,
          pendingQuestions: [],
        },
      ]),
    );

    const built = await buildPortalSnapshot({ scope: 'app_advisor' });

    expect(
      built.snapshot.entities
        .filter((entity) => entity.entityType === 'app_advisor_chat')
        .map((entity) => entity.localId),
    ).toEqual(['current-entry-chat', 'stale-entry-chat']);
    expect(
      built.snapshot.entities
        .filter((entity) => entity.entityType === 'app_advisor_chat')
        .map((entity) => entity.payload),
    ).toEqual([
      expect.objectContaining({ desktopCurrent: true }),
      expect.objectContaining({ desktopCurrent: false }),
    ]);
  });

  it('seeds the persisted App Advisor transcripts on the app_advisor snapshot (CAN-2562)', async () => {
    mockedListWorkEntries.mockResolvedValue(appAdvisorEntries('entry-1'));
    mockedListAppAdvisorChatSummaries.mockResolvedValue([
      {
        localId: 'chat-entry-1',
        chatId: 'chat-entry-1',
        title: 'Chat',
        pendingQuestions: [],
      },
    ]);
    mockedGetAppAdvisorChatTranscriptSeed.mockResolvedValue({
      messages: [
        {
          messageId: 'm1',
          chatId: 'chat-entry-1',
          role: 'user',
          status: 'complete',
          text: 'hello',
          createdAtMs: 1000,
        },
      ],
      truncated: true,
    });

    const built = await buildPortalSnapshot({ scope: 'app_advisor' });

    // Server-side chat rows are per portal session, so the snapshot is the
    // only history source for a freshly paired browser.
    expect(built.snapshot.chatMessages).toEqual([
      expect.objectContaining({ messageId: 'm1', chatId: 'chat-entry-1' }),
    ]);
    expect(built.snapshot.chatMessagesTruncated).toBe(true);
  });

  it('hydrates only the preferred App Advisor chat and preserves its target', async () => {
    mockedListWorkEntries.mockResolvedValue(appAdvisorEntries('entry-1'));
    mockedListAppAdvisorChatSummaries.mockResolvedValue([
      {
        localId: 'chat-entry-1',
        chatId: 'chat-entry-1',
        title: 'Selected',
        pendingQuestions: [],
      },
      {
        localId: 'chat-sibling',
        chatId: 'chat-sibling',
        title: 'Sibling',
        pendingQuestions: [],
      },
    ]);
    mockedGetAppAdvisorChatTranscriptSeed.mockResolvedValue({
      messages: [],
      truncated: true,
    });

    const built = await buildPortalSnapshot({
      scope: 'app_advisor',
      target: { chatLocalId: 'chat-entry-1' },
    });

    expect(mockedListWorkEntries).toHaveBeenCalledWith(APP_ADVISOR_PROJECT_ID);
    expect(mockedListAppAdvisorChatSummaries).toHaveBeenCalledTimes(1);
    expect(mockedListAppAdvisorChatSummaries).toHaveBeenCalledWith('entry-1', {
      entry: appAdvisorEntries('entry-1')[0],
      order: 0,
    });
    expect(mockedGetAppAdvisorChatTranscriptSeed).toHaveBeenCalledWith({
      chatId: 'chat-entry-1',
      entryId: 'entry-1',
    });
    expect(built.snapshot.target).toEqual({ chatLocalId: 'chat-entry-1' });
    expect(
      built.snapshot.entities
        .filter((entity) => entity.entityType === 'app_advisor_chat')
        .map((entity) => entity.localId),
    ).toEqual(['chat-entry-1']);
    expect(built.snapshot.chatMessagesTruncated).toBe(true);
  });

  it('rejects app_advisor when the seed read fails (partial snapshots must not prune)', async () => {
    mockedListWorkEntries.mockResolvedValue(appAdvisorEntries('entry-1'));
    mockedGetAppAdvisorChatTranscriptSeed.mockRejectedValue(
      new Error('tabs unreadable'),
    );
    await expect(buildPortalSnapshot({ scope: 'app_advisor' })).rejects.toThrow(
      'tabs unreadable',
    );
  });

  it('rejects an unresolved targeted app_advisor snapshot instead of pruning the chat', async () => {
    mockedResolveWorkEntryForChat.mockResolvedValue({
      entryId: null,
      archivedInEntryId: null,
    });

    await expect(
      buildPortalSnapshot({
        scope: 'app_advisor',
        target: { chatLocalId: 'chat-not-yet-persisted' },
      }),
    ).rejects.toThrow(
      'Orchestrator chat is not resolvable: chat-not-yet-persisted',
    );
    expect(mockedListAppAdvisorChatSummaries).not.toHaveBeenCalled();
    expect(mockedGetAppAdvisorChatTranscriptSeed).not.toHaveBeenCalled();
  });

  it('rejects app_advisor when the work-entry registry read fails', async () => {
    // Untargeted authoritative replacement: degrading to an empty snapshot
    // would wipe every cached app_advisor_chat row session-wide.
    mockedListWorkEntries.mockRejectedValue(new Error('registry error'));
    await expect(buildPortalSnapshot({ scope: 'app_advisor' })).rejects.toThrow(
      'registry error',
    );
  });

  it('rejects app_advisor when a single entry read fails', async () => {
    // The server deletes every cached app_advisor_chat row before upserting
    // an untargeted app_advisor snapshot, so degrading one flaky tab read to
    // an empty list would wipe that entry's chats from the browser cache.
    mockedListWorkEntries.mockResolvedValue(
      appAdvisorEntries('entry-1', 'entry-2'),
    );
    mockedListAppAdvisorChatSummaries.mockImplementation((entryId) =>
      entryId === 'entry-1'
        ? Promise.reject(new Error('corrupt tabs file'))
        : Promise.resolve([
            {
              localId: 'chat-entry-2',
              chatId: 'chat-entry-2',
              title: 'Chat in entry-2',
              pendingQuestions: [],
            },
          ]),
    );

    await expect(buildPortalSnapshot({ scope: 'app_advisor' })).rejects.toThrow(
      'corrupt tabs file',
    );
  });

  it('emits an empty app_advisor snapshot for an empty work-entry registry', async () => {
    mockedListWorkEntries.mockResolvedValue([]);

    const built = await buildPortalSnapshot({ scope: 'app_advisor' });

    // Nothing should be cached: an authoritative empty snapshot is correct.
    expect(
      built.snapshot.entities.filter(
        (entity) => entity.entityType === 'app_advisor_chat',
      ),
    ).toEqual([]);
  });

  it('rejects worktree_chat_summaries when the sidebar read fails', async () => {
    // Untargeted authoritative replacement: degrading to an empty snapshot
    // would wipe every cached worktree chat_summary row session-wide.
    mockedReadAllSidebarItems.mockRejectedValue(new Error('disk error'));
    await expect(
      buildPortalSnapshot({ scope: 'worktree_chat_summaries' }),
    ).rejects.toThrow('disk error');
  });

  it('keeps legacy batch failures tolerant and rejects incomplete Activity inventories', async () => {
    mockedReadAllSidebarItems.mockResolvedValue({
      version: 1,
      items: [
        {
          type: 'single-repo',
          id: 'workspace-1',
          name: 'One',
          repoPath: '/one',
          color: '#111',
          collapsed: false,
          order: 0,
          worktrees: [
            { id: 'tree-1', branchName: 'one', createdAt: '2026-01-01' },
            { id: 'tree-2', branchName: 'two', createdAt: '2026-01-01' },
          ],
        },
      ],
    });
    mockedListWorktreeChatSummaries.mockImplementation((input) =>
      input.worktreeId === 'tree-1'
        ? Promise.reject(new Error('corrupt tabs file'))
        : Promise.resolve([
            {
              localId: 'chat-tree-2',
              chatId: 'chat-tree-2',
              scope: 'worktree',
              workspaceLocalId: input.workspaceId,
              worktreeLocalId: input.worktreeId,
              title: 'Surviving chat',
            },
          ]),
    );

    const built = await buildPortalSnapshot({
      scope: 'worktree_chat_summaries',
    });

    const summaries = built.snapshot.entities.filter(
      (entity) => entity.entityType === 'chat_summary',
    );
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toMatchObject({ localId: 'chat-tree-2' });
    mockedListWorkspacePortalEntities.mockImplementation((_target, options) => {
      options?.onWorkspace?.({
        localId: 'workspace-1',
        name: 'One',
        type: 'single-repo',
      });
      options?.onWorktree?.({
        localId: 'tree-1',
        workspaceLocalId: 'workspace-1',
        branch: 'main',
      });
      options?.onWorktree?.({
        localId: 'tree-2',
        workspaceLocalId: 'workspace-1',
        branch: 'main',
      });
      return Promise.resolve([]);
    });
    await expect(
      buildPortalSnapshot({
        scope: 'worktree_chat_summaries',
        includeChatSummaries: true,
      }),
    ).rejects.toThrow('corrupt tabs file');
    mockedListWorktreeChatSummaries.mockClear();
    mockedListWorkspacePortalEntities.mockImplementation((_target, options) => {
      options?.onWorkspace?.({
        localId: 'workspace-1',
        name: 'One',
        type: 'single-repo',
      });
      options?.onWorktree?.({
        localId: 'tree-1',
        workspaceLocalId: 'workspace-1',
        branch: 'main',
        hidden: true,
      });
      options?.onWorktree?.({
        localId: 'tree-2',
        workspaceLocalId: 'workspace-1',
        branch: 'main',
      });
      return Promise.resolve([]);
    });
    const complete = await buildPortalSnapshot({
      scope: 'worktree_chat_summaries',
      includeChatSummaries: true,
    });
    expect(
      complete.snapshot.entities.filter(
        (entity) => entity.entityType === 'chat_summary',
      ),
    ).toHaveLength(1);
    expect(mockedListWorktreeChatSummaries).toHaveBeenCalledTimes(1);
    expect(mockedListWorktreeChatSummaries).toHaveBeenCalledWith({
      workspaceId: 'workspace-1',
      worktreeId: 'tree-2',
    });
  });

  it('includes persisted viewMode in the snapshot and activity summary', async () => {
    mockedReadPortalStateStore.mockResolvedValue({
      version: 1,
      clientDeviceId: 'device-1',
      viewMode: 'standalone-chats',
    });

    const built = await buildPortalSnapshot({ scope: 'overview' });

    expect(built.snapshot.viewMode).toBe('standalone-chats');
    expect(
      built.snapshot.entities.find(
        (entity) => entity.entityType === 'activity_summary',
      )?.payload,
    ).toMatchObject({ viewMode: 'standalone-chats' });
  });

  it('keeps shared state out of targeted snapshots that can finish out of order', async () => {
    mockedReadPortalStateStore.mockResolvedValue({
      version: 1,
      clientDeviceId: 'device-1',
      viewMode: 'standalone-chats',
    });

    const older = await buildPortalSnapshot({
      scope: 'scripts',
      target: { workspaceLocalId: 'workspace', worktreeLocalId: 'one' },
    });
    const newer = await buildPortalSnapshot({
      scope: 'scripts',
      target: { workspaceLocalId: 'workspace', worktreeLocalId: 'two' },
    });
    const global = await buildPortalSnapshot({ scope: 'overview' });
    let currentViewMode = global.snapshot.viewMode;
    let currentSummary = global.snapshot.entities.find(
      (entity) => entity.entityType === 'activity_summary',
    );

    // Independent lanes may upload the newer snapshot first. Neither lane
    // may replace the global row or view mode when the older one arrives.
    for (const built of [newer, older]) {
      currentViewMode = built.snapshot.viewMode ?? currentViewMode;
      currentSummary =
        built.snapshot.entities.find(
          (entity) => entity.entityType === 'activity_summary',
        ) ?? currentSummary;
    }
    expect(currentViewMode).toBe('standalone-chats');
    expect(currentSummary?.payload).toMatchObject({
      scope: 'overview',
      viewMode: 'standalone-chats',
    });
  });

  it('includes the standalone project local id on standalone chat entities', async () => {
    const chat: Awaited<ReturnType<typeof listStandaloneChats>>[number] = {
      projectLocalId: 'research',
      projectId: 'research',
      chatId: 'chat-1',
      title: 'Research chat',
      lastMessageAt: '2026-05-08T00:00:00.000Z',
      hasActiveChat: true,
      hasUnread: true,
    };
    mockedListStandaloneChats.mockResolvedValue([chat]);

    const built = await buildPortalSnapshot({ scope: 'overview' });

    const standaloneEntity = built.snapshot.entities.find(
      (entity) => entity.entityType === 'standalone_chat',
    );
    expect(standaloneEntity).toMatchObject({
      entityType: 'standalone_chat',
      localId: 'chat-1',
      parentLocalId: 'research',
    });
    expect(standaloneEntity?.payload).toMatchObject({
      ...projectStandaloneChatSnapshot(chat),
      projectId: 'research',
      chatId: 'chat-1',
    });
  });

  it('uses projectLocalId when hydrating a standalone chat transcript', async () => {
    mockedListStandaloneChats.mockResolvedValue([
      {
        projectLocalId: 'default',
        projectId: 'default',
        chatId: 'shared-chat',
        title: 'Default shared chat',
      },
      {
        projectLocalId: 'research',
        projectId: 'research',
        chatId: 'shared-chat',
        title: 'Research shared chat',
      },
    ]);

    const built = await buildPortalSnapshot({
      scope: 'standalone_chat',
      target: {
        projectLocalId: 'research',
        standaloneChatLocalId: 'shared-chat',
      },
    });

    const standaloneEntities = built.snapshot.entities.filter(
      (entity) => entity.entityType === 'standalone_chat',
    );
    expect(standaloneEntities).toHaveLength(1);
    expect(standaloneEntities[0]?.payload).toMatchObject({
      projectLocalId: 'research',
      chatId: 'shared-chat',
    });
    expect(mockedGetStandaloneChatTranscriptSeed).toHaveBeenCalledWith({
      chatId: 'shared-chat',
      projectLocalId: 'research',
    });
  });

  it('adds questions only to a snapshot that targets one standalone chat', async () => {
    const chat = {
      projectLocalId: 'research',
      projectId: 'research',
      chatId: 'chat-1',
      title: 'Cowork chat',
      workEntryId: 'entry-1',
    };
    const pendingQuestions = [
      {
        requestId: 'req-1',
        questions: [{ question: 'Ship it?', options: ['Yes', 'No'] }],
        answered: false,
      },
    ];
    mockedListStandaloneChats.mockResolvedValue([chat]);
    mockedWithStandalonePendingQuestions.mockImplementation((value) =>
      Promise.resolve({ ...value, pendingQuestions }),
    );

    const overview = await buildPortalSnapshot({ scope: 'overview' });
    expect(mockedWithStandalonePendingQuestions).not.toHaveBeenCalled();
    expect(
      overview.snapshot.entities.find(
        (entity) => entity.entityType === 'standalone_chat',
      )?.payload,
    ).not.toHaveProperty('pendingQuestions');

    const targeted = await buildPortalSnapshot({
      scope: 'standalone_chat',
      target: { projectLocalId: 'research', standaloneChatLocalId: 'chat-1' },
    });
    expect(mockedWithStandalonePendingQuestions).toHaveBeenCalledTimes(1);
    expect(
      targeted.snapshot.entities.find(
        (entity) => entity.entityType === 'standalone_chat',
      )?.payload,
    ).toMatchObject({ chatId: 'chat-1', pendingQuestions });
  });

  it('returns worktree chat summaries without bundling every chat transcript so the web portal lazy-loads transcripts per tab', async () => {
    mockedListWorkspacePortalEntities.mockResolvedValue([
      {
        entityType: 'worktree',
        localId: 'snake',
        parentLocalId: 'workspace-1',
        payload: {
          workspaceLocalId: 'workspace-1',
          worktreeLocalId: 'snake',
          branch: 'feature/portal',
        },
      },
    ]);
    mockedListWorktreeChatSummaries.mockResolvedValue([
      {
        localId: 'older-chat',
        chatId: 'older-chat',
        scope: 'worktree',
        workspaceLocalId: 'workspace-1',
        worktreeLocalId: 'snake',
        title: 'Older chat',
        lastMessageAt: '2026-05-07T00:00:00.000Z',
      },
      {
        localId: 'latest-chat',
        chatId: 'latest-chat',
        scope: 'worktree',
        workspaceLocalId: 'workspace-1',
        worktreeLocalId: 'snake',
        title: 'Latest chat',
        lastMessageAt: '2026-05-08T00:00:00.000Z',
      },
    ]);
    mockedGetWorktreeChatTranscriptSeed.mockResolvedValue({
      messages: [
        {
          messageId: 'message-1',
          chatId: 'older-chat',
          role: 'user',
          status: 'complete',
          text: 'older transcript',
          createdAtMs: 1,
        },
        {
          messageId: 'message-2',
          chatId: 'latest-chat',
          role: 'assistant',
          status: 'complete',
          text: 'latest transcript',
          createdAtMs: 2,
        },
      ],
      truncated: false,
    });

    const built = await buildPortalSnapshot({
      scope: 'worktree',
      target: {
        workspaceLocalId: 'workspace-1',
        worktreeLocalId: 'snake',
      },
    });

    // Lazy-load plan: the worktree scope must NOT pre-load any chat
    // transcript when the caller did not request a specific chat. The
    // web portal fetches each tab's transcript on demand via the `chat`
    // scope keyed by `chatLocalId`.
    expect(mockedGetWorktreeChatTranscriptSeed).not.toHaveBeenCalled();
    expect(built.snapshot.chatMessages).toBeUndefined();
    expect(
      built.snapshot.entities
        .filter((entity) => entity.entityType === 'chat_summary')
        .map((entity) => entity.localId),
    ).toEqual(['older-chat', 'latest-chat']);
    expect(
      built.snapshot.entities.find((entity) => entity.entityType === 'worktree')
        ?.payload,
    ).toMatchObject({
      availableModels: [
        {
          id: 'claude-sonnet',
          label: 'Sonnet',
          provider: 'claude',
          kind: 'model',
          available: true,
        },
      ],
      providerAvailability: { claude: true },
    });
  });

  it('logs and degrades to an empty chat-tab list when the worktree chat-summary projection throws', async () => {
    mockedListWorkspacePortalEntities.mockResolvedValue([
      {
        entityType: 'worktree',
        localId: 'snake',
        parentLocalId: 'workspace-1',
        payload: {
          workspaceLocalId: 'workspace-1',
          worktreeLocalId: 'snake',
          branch: 'feature/portal',
        },
      },
    ]);
    // e.g. validateId rejecting a workspace/worktree id, or a corrupt tabs
    // file — previously swallowed to `[]`, making a hard failure look
    // identical to "genuinely no chats".
    mockedListWorktreeChatSummaries.mockRejectedValue(
      new Error(
        'Invalid worktreeId: must be lowercase alphanumeric with hyphens',
      ),
    );
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    const built = await buildPortalSnapshot({
      scope: 'worktree',
      target: {
        workspaceLocalId: 'workspace-1',
        worktreeLocalId: 'snake',
      },
    });

    // Still degrades gracefully — the snapshot resolves with no chat tabs.
    expect(
      built.snapshot.entities.filter(
        (entity) => entity.entityType === 'chat_summary',
      ),
    ).toEqual([]);
    // ...but the failure is now visible for triage rather than silent.
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('worktree chat summaries'),
      expect.objectContaining({ worktreeLocalId: 'snake' }),
    );

    warnSpy.mockRestore();
  });

  it('projects all TODO rows for worktree scope and only the target row for chat scope', async () => {
    mockedListWorktreeTodoEntities.mockResolvedValue([
      {
        localId: 'chat-a',
        workspaceLocalId: 'workspace-1',
        worktreeLocalId: 'snake',
        chatId: 'chat-a',
        items: [],
      },
      {
        localId: 'chat-b',
        workspaceLocalId: 'workspace-1',
        worktreeLocalId: 'snake',
        chatId: 'chat-b',
        items: [{ id: 'todo:1', content: 'Ship it', status: 'in_progress' }],
      },
    ]);

    const worktree = await buildPortalSnapshot({
      scope: 'worktree',
      target: {
        workspaceLocalId: 'workspace-1',
        worktreeLocalId: 'snake',
      },
    });
    const chat = await buildPortalSnapshot({
      scope: 'chat',
      target: {
        workspaceLocalId: 'workspace-1',
        worktreeLocalId: 'snake',
        chatLocalId: 'chat-b',
      },
    });

    expect(
      worktree.snapshot.entities
        .filter((entity) => entity.entityType === 'chat_todo')
        .map((entity) => ({
          localId: entity.localId,
          parentLocalId: entity.parentLocalId,
        })),
    ).toEqual([
      { localId: 'chat-a', parentLocalId: 'workspace-1:snake' },
      { localId: 'chat-b', parentLocalId: 'workspace-1:snake' },
    ]);
    expect(
      chat.snapshot.entities
        .filter((entity) => entity.entityType === 'chat_todo')
        .map((entity) => entity.localId),
    ).toEqual(['chat-b']);
  });

  it('keeps sibling snapshot entities when TODO transcript projection fails', async () => {
    mockedListWorkspacePortalEntities.mockResolvedValue([
      {
        entityType: 'worktree',
        localId: 'snake',
        parentLocalId: 'workspace-1',
        payload: { name: 'Snake' },
      },
    ]);
    mockedListWorktreeTodoEntities.mockRejectedValue(
      new Error('corrupt transcript'),
    );

    const built = await buildPortalSnapshot({
      scope: 'worktree',
      target: {
        workspaceLocalId: 'workspace-1',
        worktreeLocalId: 'snake',
      },
    });

    expect(
      built.snapshot.entities.find(
        (entity) => entity.entityType === 'worktree',
      ),
    ).toBeDefined();
    expect(
      built.snapshot.entities.filter(
        (entity) => entity.entityType === 'chat_todo',
      ),
    ).toEqual([]);
  });

  it('emits file roots in a worktree-scoped snapshot', async () => {
    mockedListFileRoots.mockResolvedValue([
      {
        workspaceLocalId: 'workspace-1',
        worktreeLocalId: 'snake',
        fileRootLocalId: 'repo-1',
        label: 'Repository',
        absolutePath: '/tmp/repository',
      },
    ]);

    const built = await buildPortalSnapshot({
      scope: 'worktree',
      target: {
        workspaceLocalId: 'workspace-1',
        worktreeLocalId: 'snake',
      },
    });

    expect(mockedListFileRoots).toHaveBeenCalledWith({
      projectId: 'workspace-1',
      worktreeId: 'snake',
    });
    expect(
      built.snapshot.entities.find(
        (entity) => entity.entityType === 'file_root',
      ),
    ).toEqual({
      entityType: 'file_root',
      localId: 'repo-1',
      parentLocalId: 'workspace-1:snake',
      payload: {
        workspaceLocalId: 'workspace-1',
        worktreeLocalId: 'snake',
        fileRootLocalId: 'repo-1',
        label: 'Repository',
        absolutePath: '/tmp/repository',
      },
    });
  });

  it('still bundles a single chat transcript when the worktree request targets a specific chatLocalId', async () => {
    mockedListWorkspacePortalEntities.mockResolvedValue([
      {
        entityType: 'worktree',
        localId: 'snake',
        parentLocalId: 'workspace-1',
        payload: {
          workspaceLocalId: 'workspace-1',
          worktreeLocalId: 'snake',
          branch: 'feature/portal',
        },
      },
    ]);
    mockedListWorktreeChatSummaries.mockResolvedValue([
      {
        localId: 'older-chat',
        chatId: 'older-chat',
        scope: 'worktree',
        workspaceLocalId: 'workspace-1',
        worktreeLocalId: 'snake',
        title: 'Older chat',
      },
    ]);
    mockedGetWorktreeChatTranscriptSeed.mockResolvedValue({
      messages: [
        {
          messageId: 'message-1',
          chatId: 'older-chat',
          role: 'user',
          status: 'complete',
          text: 'older transcript',
          createdAtMs: 1,
        },
      ],
      truncated: true,
    });

    const built = await buildPortalSnapshot({
      scope: 'worktree',
      target: {
        workspaceLocalId: 'workspace-1',
        worktreeLocalId: 'snake',
        chatLocalId: 'older-chat',
      },
    });

    expect(mockedGetWorktreeChatTranscriptSeed).toHaveBeenCalledWith({
      workspaceId: 'workspace-1',
      worktreeId: 'snake',
      chatId: 'older-chat',
    });
    expect(
      built.snapshot.chatMessages?.map((message) => message.chatId),
    ).toEqual(['older-chat']);
    expect(built.snapshot.chatMessagesTruncated).toBe(true);
  });

  it('emits a worktree_summary entity when a persisted summary exists', async () => {
    mockedIsWorktreeSummaryGenerating.mockReturnValue(true);
    mockedReadWorktreeSummary.mockResolvedValue({
      title: 'Snake summary',
      description: 'Worked on portal extraction.',
      highlights: ['Built protocol fields'],
      repos: [{ name: 'desktop', description: 'Emits live deltas' }],
      generatedAt: '2026-05-09T00:00:00.000Z',
      turnCountAtGeneration: 3,
      lastFullRefreshAt: '2026-05-09T00:00:00.000Z',
      lastFullRefreshTurnCount: 3,
    });

    const built = await buildPortalSnapshot({
      scope: 'worktree',
      target: {
        workspaceLocalId: 'workspace-1',
        worktreeLocalId: 'snake',
      },
    });

    const summary = built.snapshot.entities.find(
      (entity) => entity.entityType === 'worktree_summary',
    );
    expect(summary).toMatchObject({
      entityType: 'worktree_summary',
      localId: 'snake',
      parentLocalId: 'workspace-1:snake',
      payload: {
        workspaceLocalId: 'workspace-1',
        worktreeLocalId: 'snake',
        title: 'Snake summary',
        description: 'Worked on portal extraction.',
        highlights: ['Built protocol fields'],
        repos: [{ name: 'desktop', description: 'Emits live deltas' }],
        generatedAt: '2026-05-09T00:00:00.000Z',
        lastFullRefreshAt: '2026-05-09T00:00:00.000Z',
        generating: true,
      },
    });
    expect(mockedIsWorktreeSummaryGenerating).toHaveBeenCalledWith(
      'workspace-1',
      'snake',
    );
  });

  it('omits the worktree_summary entity when no persisted summary exists', async () => {
    mockedReadWorktreeSummary.mockResolvedValue(null);

    const built = await buildPortalSnapshot({
      scope: 'worktree',
      target: {
        workspaceLocalId: 'workspace-1',
        worktreeLocalId: 'snake',
      },
    });

    expect(
      built.snapshot.entities.find(
        (entity) => entity.entityType === 'worktree_summary',
      ),
    ).toBeUndefined();
  });

  it('keeps chat summary hydration when an optional feature reader fails', async () => {
    mockedListWorktreeChatSummaries.mockResolvedValue([
      {
        localId: 'chat-1',
        chatId: 'chat-1',
        scope: 'worktree',
        workspaceLocalId: 'workspace-1',
        worktreeLocalId: 'snake',
        title: 'Chat',
      },
    ]);
    mockedGetWorktreeChatTranscriptSeed.mockResolvedValue({
      messages: [
        {
          messageId: 'message-1',
          chatId: 'chat-1',
          role: 'user',
          status: 'complete',
          text: 'still synced',
          createdAtMs: 1,
        },
      ],
      truncated: false,
    });
    mockedListScripts.mockRejectedValue(new Error('script config failed'));
    mockedListHooks.mockRejectedValue(new Error('hook config failed'));
    mockedListPipelines.mockRejectedValue(new Error('pipeline config failed'));

    const built = await buildPortalSnapshot({
      scope: 'worktree',
      target: {
        workspaceLocalId: 'workspace-1',
        worktreeLocalId: 'snake',
      },
    });

    // Lazy-load plan: a feature-reader failure cannot break chat-summary
    // hydration — the panel needs summaries to render the tab bar — but
    // transcripts remain off the wire for the worktree scope.
    expect(
      built.snapshot.entities
        .filter((entity) => entity.entityType === 'chat_summary')
        .map((entity) => entity.localId),
    ).toEqual(['chat-1']);
    expect(built.snapshot.chatMessages).toBeUndefined();
  });

  describe('provider usage projection (CAN-3635)', () => {
    const usageOverview: AgentUsageOverview = {
      updatedAt: '2026-10-04T17:05:00.000Z',
      providers: [
        {
          provider: 'claude',
          authState: 'authenticated',
          hasRemainingLimits: true,
          lastUpdatedAt: '2026-10-04T17:00:00.000Z',
          accountEmail: 'claude-user@example.com',
          accountLabel: 'claude-user@example.com',
          subscriptionLabel: 'Claude Max 20x',
          authMethod: 'claude.ai',
          rateLimits: [
            {
              limitId: 'session',
              limitName: '5-hour window',
              planType: 'default_claude_max_20x',
              primary: {
                usedPercent: 42,
                resetsAt: '2026-10-04T20:00:00.000Z',
                windowDurationMins: 300,
              },
            },
            {
              limitId: 'weekly_all',
              limitName: '7-day window',
              primary: {
                usedPercent: 0,
                resetsAt: '2026-10-09T00:00:00.000Z',
                windowDurationMins: 10_080,
              },
            },
            {
              limitId: 'extra_usage',
              limitName: 'Extra usage',
              primary: { usedPercent: 25 },
              credits: { usedUsd: 12.5, totalUsd: 50, remainingUsd: 37.5 },
            },
          ],
        },
        {
          provider: 'codex',
          authState: 'authenticated',
          hasRemainingLimits: true,
          lastUpdatedAt: '2026-10-04T17:01:00.000Z',
          accountEmail: 'codex-user@example.com',
          accountLabel: 'codex-user@example.com',
          subscriptionLabel: 'ChatGPT Pro',
          rateLimits: [
            {
              limitId: 'codex',
              limitName: 'Codex',
              planType: 'pro',
              primary: {
                usedPercent: 23,
                resetsAt: '2026-10-04T20:00:00.000Z',
                windowDurationMins: 300,
              },
              secondary: {
                usedPercent: 61,
                resetsAt: '2026-10-09T00:00:00.000Z',
                windowDurationMins: 10_080,
              },
              credits: { remainingUsd: 120 },
            },
          ],
        },
        {
          provider: 'cursor',
          authState: 'authenticated',
          hasRemainingLimits: true,
          accountEmail: 'cursor-sentinel@example.com',
        },
      ],
      accountSnapshots: [
        {
          provider: 'claude',
          accountKey: 'claude:retained-sentinel@example.com:max',
          accountEmail: 'retained-sentinel@example.com',
          capturedAt: '2026-10-01T00:00:00.000Z',
        },
      ],
    };

    beforeEach(() => {
      mockGetUsageOverview.mockReturnValue(usageOverview);
    });

    it('includes the cached Claude and Codex usage singleton in the overview snapshot', async () => {
      const built = await buildPortalSnapshot({ scope: 'overview' });

      const providerUsage = built.snapshot.entities.filter(
        (entity) => entity.entityType === 'provider_usage',
      );
      expect(providerUsage).toEqual([
        {
          entityType: 'provider_usage',
          localId: 'overview',
          payload: {
            updatedAt: '2026-10-04T17:05:00.000Z',
            providers: [
              {
                provider: 'claude',
                authState: 'authenticated',
                accountEmail: 'claude-user@example.com',
                planLabel: 'Claude Max 20x',
                lastUpdatedAt: '2026-10-04T17:00:00.000Z',
                windows: [
                  {
                    id: 'session-primary',
                    label: '5-hour window',
                    usedPercent: 42,
                    resetsAt: '2026-10-04T20:00:00.000Z',
                    windowDurationMs: 5 * 60 * 60 * 1000,
                  },
                  {
                    id: 'weekly_all-primary',
                    label: '7-day window',
                    usedPercent: 0,
                    resetsAt: '2026-10-09T00:00:00.000Z',
                    windowDurationMs: 7 * 24 * 60 * 60 * 1000,
                  },
                  {
                    id: 'extra_usage-primary',
                    label: 'Extra usage',
                    usedPercent: 25,
                    credits: {
                      unit: 'usd',
                      spent: 12.5,
                      remaining: 37.5,
                      total: 50,
                    },
                  },
                ],
              },
              {
                provider: 'codex',
                authState: 'authenticated',
                accountEmail: 'codex-user@example.com',
                planLabel: 'ChatGPT Pro',
                lastUpdatedAt: '2026-10-04T17:01:00.000Z',
                windows: [
                  {
                    id: 'codex-primary',
                    label: '5-hour window',
                    usedPercent: 23,
                    resetsAt: '2026-10-04T20:00:00.000Z',
                    windowDurationMs: 5 * 60 * 60 * 1000,
                    credits: { unit: 'credits', remaining: 120 },
                  },
                  {
                    id: 'codex-secondary',
                    label: '7-day window',
                    usedPercent: 61,
                    resetsAt: '2026-10-09T00:00:00.000Z',
                    windowDurationMs: 7 * 24 * 60 * 60 * 1000,
                  },
                ],
              },
            ],
          },
        },
      ]);
      const wire = JSON.stringify(providerUsage);
      expect(wire).not.toContain('cursor');
      expect(wire).not.toContain('retained-sentinel');
      expect(wire).not.toContain('default_claude_max_20x');
      expect(mockRefreshProviderUsage).not.toHaveBeenCalled();
    });

    it('keeps provider usage out of targeted snapshots', async () => {
      for (const request of [
        { scope: 'workspace' as const, target: { workspaceLocalId: 'ws' } },
        {
          scope: 'worktree' as const,
          target: { workspaceLocalId: 'ws', worktreeLocalId: 'tree' },
        },
        { scope: 'standalone_chat' as const },
      ]) {
        const built = await buildPortalSnapshot(request);
        expect(
          built.snapshot.entities.some(
            (entity) => entity.entityType === 'provider_usage',
          ),
        ).toBe(false);
      }
      expect(mockGetUsageOverview).not.toHaveBeenCalled();
    });
  });
});
