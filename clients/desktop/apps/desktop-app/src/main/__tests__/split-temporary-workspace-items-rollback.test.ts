jest.mock('node:fs/promises', () => ({
  copyFile: jest.fn(),
  mkdir: jest.fn(),
  mkdtemp: jest.fn(() =>
    Promise.resolve('/data/source/source-wt/attachments-split-backup'),
  ),
  readdir: jest.fn(),
  rename: jest.fn(),
  rm: jest.fn(),
}));

jest.mock(
  '@canopy/desktop-shared/node/pipelines/executor/execution-state',
  () => ({
    listExecutionSummaries: jest.fn(),
    loadExecutionState: jest.fn(),
    saveExecutionState: jest.fn(),
  }),
);

jest.mock('../pipelines/execution-runtime', () => ({
  createElectronExecutionRuntime: jest.fn(() => ({ executionsDir: '/runs' })),
}));

const mockFlushChatState = jest.fn(() => Promise.resolve());
jest.mock('../services/chat-state-service', () => ({
  getChatStateService: jest.fn(() => ({
    flushScope: mockFlushChatState,
  })),
}));

jest.mock('../lib/chat-tabs-reader', () => ({
  readChatTabsFile: jest.fn(),
  readChatTabsFileForIndex: jest.fn(),
}));

jest.mock('../lib/chat-tabs', () => ({
  writeChatTabsFile: jest.fn(),
}));

jest.mock('../lib/chat-archives', () => ({
  readChatArchivesFile: jest.fn(),
  readChatArchivesFileForIndex: jest.fn(),
  removeChatArchive: jest.fn(),
  writeChatArchivesFile: jest.fn(),
}));

jest.mock('../pipelines/worktree-cleanup', () => ({
  deleteExecutionArtifacts: jest.fn(),
}));

jest.mock('../lib/plan-persistence', () => ({
  deleteTrackedPlan: jest.fn(),
  deleteTrackedPlansForWorktree: jest.fn(),
  installRestoredTrackedPlans: jest.fn(),
  listTrackedPlans: jest.fn(),
  readTrackedPlansFileForIndex: jest.fn(),
}));

jest.mock('../lib/paths', () => ({
  getChatTabsFilePath: jest.fn(
    (workspaceId: string, worktreeId: string) =>
      `/data/${workspaceId}/${worktreeId}/chats.json`,
  ),
  getWorkspaceWorktreeRepoDir: jest.fn(),
  getWorktreeAttachmentsDir: jest.fn(
    (workspaceId: string, worktreeId: string) =>
      `/data/${workspaceId}/${worktreeId}/attachments`,
  ),
}));

import type {
  ArchivedChatsFile,
  ChatTabsFile,
  PersistedChatTab,
  TrackedPlanData,
} from '@canopy/desktop-shared/types';
import { WORKSPACE_ROOT_REPO_ID } from '@canopy/desktop-shared/types';
import type {
  ExecutionState,
  ExecutionSummary,
} from '@canopy/desktop-shared/node/pipelines/executor/types';
import {
  listExecutionSummaries,
  loadExecutionState,
  saveExecutionState,
} from '@canopy/desktop-shared/node/pipelines/executor/execution-state';
import {
  readChatTabsFile,
  readChatTabsFileForIndex,
} from '../lib/chat-tabs-reader';
import { writeChatTabsFile } from '../lib/chat-tabs';
import {
  readChatArchivesFile,
  readChatArchivesFileForIndex,
  removeChatArchive,
  writeChatArchivesFile,
} from '../lib/chat-archives';
import {
  deleteTrackedPlan,
  installRestoredTrackedPlans,
  listTrackedPlans,
  readTrackedPlansFileForIndex,
} from '../lib/plan-persistence';
import {
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  rename,
  rm,
} from 'node:fs/promises';
import {
  deleteSplitPipelineExecutions,
  hasSplitWorktreeStoredItems,
  migrateSplitChatsAndPlans,
  migrateSplitPipelineExecutions,
  SplitExecutionMigrationRollbackError,
  SplitItemsMigrationRollbackError,
  undoSplitChatsAndPlansMigration,
  undoSplitChatsAndPlansTargetMigration,
} from '../lib/split-temporary-workspace-items';
import { deleteExecutionArtifacts } from '../pipelines/worktree-cleanup';

function tab(id: string): PersistedChatTab {
  return {
    id,
    title: id,
    messages: [],
    createdAt: '2026-08-03T00:00:00.000Z',
  };
}

function plan(id: string): TrackedPlanData {
  return {
    id,
    projectId: 'source',
    worktreeId: 'source-wt',
    source: 'claude',
    title: id,
    content: '',
    reviewStatus: 'pending',
    createdAt: '2026-08-03T00:00:00.000Z',
    updatedAt: '2026-08-03T00:00:00.000Z',
    latestRevisionNumber: 1,
    revisions: [],
    linkedExecutionIds: [],
  };
}

function executionState(id: string, cwd: string): ExecutionState {
  return {
    version: 7,
    id,
    pipeline_id: 'pipeline',
    pipeline_snapshot: {
      name: 'Pipeline',
      scope: ['worktree'],
      jobs: {},
    },
    status: 'success',
    status_reasons: [],
    jobs: {},
    started_at: '2026-08-03T00:00:00.000Z',
    cwd,
    env: {},
    inputs: {},
    project_id: 'source',
    worktree_id: 'source-wt',
  };
}

describe('undoSplitChatsAndPlansMigration', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.mocked(readChatTabsFile).mockReset();
    jest.mocked(readChatTabsFileForIndex).mockReset();
    jest.mocked(readChatTabsFile).mockResolvedValue({
      version: 1,
      tabs: [],
      activeTabId: '',
    });
    jest.mocked(removeChatArchive).mockResolvedValue(null);
    jest.mocked(deleteTrackedPlan).mockResolvedValue();
    jest.mocked(writeChatTabsFile).mockResolvedValue();
    jest.mocked(writeChatArchivesFile).mockResolvedValue();
    jest.mocked(installRestoredTrackedPlans).mockResolvedValue();
    jest.mocked(deleteExecutionArtifacts).mockResolvedValue();
    jest.mocked(copyFile).mockResolvedValue();
    jest.mocked(mkdir).mockResolvedValue(undefined);
    jest
      .mocked(mkdtemp)
      .mockResolvedValue('/data/source/source-wt/attachments-split-backup');
    jest.mocked(rename).mockResolvedValue();
    jest.mocked(rm).mockResolvedValue();
    jest
      .mocked(readChatTabsFileForIndex)
      .mockImplementation((workspaceId, worktreeId) =>
        readChatTabsFile(workspaceId, worktreeId),
      );
    jest
      .mocked(readChatArchivesFileForIndex)
      .mockImplementation((workspaceId, worktreeId) =>
        readChatArchivesFile(workspaceId, worktreeId),
      );
    jest
      .mocked(readTrackedPlansFileForIndex)
      .mockImplementation(async (workspaceId, worktreeId) => ({
        version: 1,
        plans: await listTrackedPlans(workspaceId, worktreeId),
      }));
  });

  it('removes hard-delete records from the reversible source rewrite', async () => {
    const deletedTab = tab('deleted-chat');
    const rootTab = tab('root-chat');
    const deletedArchive = {
      tab: tab('deleted-archive'),
      archivedAt: '2026-08-03T00:00:00.000Z',
      turnCount: 1,
    };
    const rootArchive = {
      tab: tab('root-archive'),
      archivedAt: '2026-08-03T00:00:00.000Z',
      turnCount: 1,
    };
    const deletedPlan = { ...plan('deleted-plan'), sourceRepoId: 'repo' };
    const rootPlan = plan('root-plan');
    jest.mocked(readChatTabsFile).mockResolvedValue({
      version: 1,
      tabs: [deletedTab, rootTab],
      activeTabId: deletedTab.id,
    });
    jest.mocked(readChatArchivesFile).mockResolvedValue({
      version: 1,
      archived: [deletedArchive, rootArchive],
    });
    jest.mocked(listTrackedPlans).mockResolvedValue([deletedPlan, rootPlan]);

    await migrateSplitChatsAndPlans({
      workspaceId: 'source',
      worktreeId: 'source-wt',
      analysis: {
        perRepo: new Map([
          [
            'repo',
            {
              chatTabs: [deletedTab],
              fileTabs: [],
              archivedChats: [deletedArchive],
              executions: [],
              plans: [deletedPlan],
            },
          ],
        ]),
        root: {
          chatTabs: [rootTab],
          fileTabs: [],
          archivedChats: [rootArchive],
          executions: [],
          plans: [rootPlan],
          attachmentNames: [],
        },
      },
      targets: [],
      hardDeleteRepoIds: new Set(['repo']),
    });

    expect(writeChatTabsFile).toHaveBeenCalledWith(
      'source',
      'source-wt',
      expect.objectContaining({ tabs: [rootTab], activeTabId: rootTab.id }),
      { changedTabIds: [], removedTabIds: [deletedTab.id] },
    );
    expect(removeChatArchive).toHaveBeenCalledWith(
      'source',
      'source-wt',
      deletedArchive.tab.id,
    );
    expect(installRestoredTrackedPlans).toHaveBeenCalledWith(
      'source',
      'source-wt',
      [rootPlan],
    );
  });

  it('moves pending questions with their migrated chats', async () => {
    const movedTab = tab('moved-chat');
    const remainingTab = tab('remaining-chat');
    const movedQuestion = {
      requestId: 'moved-question',
      chatId: movedTab.id,
      questions: [],
    };
    const remainingQuestion = {
      requestId: 'remaining-question',
      chatId: remainingTab.id,
      questions: [],
    };
    jest.mocked(readChatTabsFile).mockResolvedValue({
      version: 1,
      tabs: [movedTab, remainingTab],
      activeTabId: movedTab.id,
      pendingQuestions: [movedQuestion, remainingQuestion],
    });
    jest.mocked(readChatArchivesFile).mockResolvedValue({
      version: 1,
      archived: [],
    });
    jest.mocked(listTrackedPlans).mockResolvedValue([]);

    const undo = await migrateSplitChatsAndPlans({
      workspaceId: 'source',
      worktreeId: 'source-wt',
      analysis: {
        perRepo: new Map([
          [
            'repo',
            {
              chatTabs: [movedTab],
              fileTabs: [],
              archivedChats: [],
              executions: [],
              plans: [],
              attachmentNames: [],
            },
          ],
        ]),
        root: {
          chatTabs: [remainingTab],
          fileTabs: [],
          archivedChats: [],
          executions: [],
          plans: [],
          attachmentNames: [],
        },
      },
      targets: [
        {
          repoId: 'repo',
          destinationWorkspaceId: 'destination',
          destinationWorktreeId: 'destination-wt',
          oldCheckoutPath: '/old/repo',
          newCheckoutPath: '/new/repo',
        },
      ],
    });

    expect(writeChatTabsFile).toHaveBeenCalledWith(
      'destination',
      'destination-wt',
      expect.objectContaining({ pendingQuestions: [movedQuestion] }),
      {
        changedTabIds: [movedTab.id],
        removedTabIds: [],
        authoritative: true,
      },
    );
    expect(writeChatTabsFile).toHaveBeenCalledWith(
      'source',
      'source-wt',
      expect.objectContaining({ pendingQuestions: [remainingQuestion] }),
      { changedTabIds: [], removedTabIds: [movedTab.id] },
    );
    expect(undo.writtenChatFiles[0]).toEqual(
      expect.objectContaining({
        migratedTabs: [movedTab],
        migratedPendingQuestions: [movedQuestion],
      }),
    );
  });

  it('maps file-backed migrated plans to the destination root repo', async () => {
    const importedPlan = {
      ...plan('imported-plan'),
      source: 'imported' as const,
      sourceRepoId: 'repo',
      sourceFilePath: 'plans/imported.md',
    };
    const agentPlan = plan('agent-plan');
    jest.mocked(readChatTabsFile).mockResolvedValue({
      version: 1,
      tabs: [],
    });
    jest.mocked(readChatArchivesFile).mockResolvedValue({
      version: 1,
      archived: [],
    });
    jest.mocked(listTrackedPlans).mockResolvedValue([importedPlan, agentPlan]);

    await migrateSplitChatsAndPlans({
      workspaceId: 'source',
      worktreeId: 'source-wt',
      analysis: {
        perRepo: new Map([
          [
            'repo',
            {
              chatTabs: [],
              fileTabs: [],
              archivedChats: [],
              executions: [],
              plans: [importedPlan, agentPlan],
              attachmentNames: [],
            },
          ],
        ]),
        root: {
          chatTabs: [],
          fileTabs: [],
          archivedChats: [],
          executions: [],
          plans: [],
          attachmentNames: [],
        },
      },
      targets: [
        {
          repoId: 'repo',
          destinationWorkspaceId: 'destination',
          destinationWorktreeId: 'destination-wt',
          oldCheckoutPath: '/data/source/source-wt/repos/repo',
          newCheckoutPath: '/data/destination/destination-wt',
        },
      ],
    });

    expect(installRestoredTrackedPlans).toHaveBeenCalledWith(
      'destination',
      'destination-wt',
      [
        expect.objectContaining({
          id: 'imported-plan',
          sourceRepoId: WORKSPACE_ROOT_REPO_ID,
        }),
        expect.objectContaining({
          id: 'agent-plan',
          sourceRepoId: undefined,
        }),
      ],
    );
  });

  it('copies repo chat attachments and rewrites every persisted reference', async () => {
    const attachmentPath = '/data/source/source-wt/attachments/context.md';
    const repoTab: PersistedChatTab = {
      ...tab('repo-chat'),
      selectedRepoId: 'repo',
      pendingRevertAttachmentPath: attachmentPath,
      messages: [
        {
          id: 'message',
          role: 'user',
          timestamp: 1,
          attachmentPaths: [attachmentPath],
          attachmentPromptContexts: [
            { attachmentPath, promptKind: 'linear-ticket' },
          ],
          blocks: [
            {
              type: 'revert_info',
              timestamp: 1,
              revertedFromMessageId: 'before',
              revertedFromTimestamp: 0,
              files: [],
              totalInsertions: 0,
              totalDeletions: 0,
              attachmentPath,
            },
          ],
        },
      ],
    };
    jest.mocked(readChatTabsFile).mockResolvedValue({
      version: 1,
      tabs: [repoTab],
      activeTabId: repoTab.id,
    });
    jest.mocked(readChatArchivesFile).mockResolvedValue({
      version: 1,
      archived: [],
    });
    jest.mocked(listTrackedPlans).mockResolvedValue([]);

    await migrateSplitChatsAndPlans({
      workspaceId: 'source',
      worktreeId: 'source-wt',
      analysis: {
        perRepo: new Map([
          [
            'repo',
            {
              chatTabs: [repoTab],
              fileTabs: [],
              archivedChats: [],
              executions: [],
              plans: [],
              attachmentNames: ['context.md'],
            },
          ],
        ]),
        root: {
          chatTabs: [],
          fileTabs: [],
          archivedChats: [],
          executions: [],
          plans: [],
          attachmentNames: [],
        },
      },
      targets: [
        {
          repoId: 'repo',
          destinationWorkspaceId: 'destination',
          destinationWorktreeId: 'destination-wt',
          oldCheckoutPath: '/data/source/source-wt/repos/repo',
          newCheckoutPath: '/data/destination/destination-wt',
        },
      ],
    });

    const destinationPath =
      '/data/destination/destination-wt/attachments/context.md';
    expect(copyFile).toHaveBeenCalledWith(attachmentPath, destinationPath);
    expect(writeChatTabsFile).toHaveBeenCalledWith(
      'destination',
      'destination-wt',
      expect.objectContaining({
        tabs: [
          expect.objectContaining({
            pendingRevertAttachmentPath: destinationPath,
            messages: [
              expect.objectContaining({
                attachmentPaths: [destinationPath],
                attachmentPromptContexts: [
                  expect.objectContaining({ attachmentPath: destinationPath }),
                ],
                blocks: [
                  expect.objectContaining({ attachmentPath: destinationPath }),
                ],
              }),
            ],
          }),
        ],
      }),
      {
        changedTabIds: [repoTab.id],
        removedTabIds: [],
        authoritative: true,
      },
    );
    expect(rename).toHaveBeenCalledWith(
      attachmentPath,
      '/data/source/source-wt/attachments-split-backup/context.md',
    );
  });

  it('surfaces rollback failure so destination cleanup can be skipped', async () => {
    const deletedTab = tab('deleted-chat');
    jest.mocked(readChatTabsFile).mockResolvedValue({
      version: 1,
      tabs: [deletedTab],
      activeTabId: deletedTab.id,
    });
    jest.mocked(readChatArchivesFile).mockResolvedValue({
      version: 1,
      archived: [],
    });
    jest.mocked(listTrackedPlans).mockResolvedValue([]);
    jest
      .mocked(writeChatTabsFile)
      .mockRejectedValueOnce(new Error('source rewrite failed'))
      .mockRejectedValueOnce(new Error('source restore failed'));

    await expect(
      migrateSplitChatsAndPlans({
        workspaceId: 'source',
        worktreeId: 'source-wt',
        analysis: {
          perRepo: new Map([
            [
              'repo',
              {
                chatTabs: [deletedTab],
                fileTabs: [],
                archivedChats: [],
                executions: [],
                plans: [],
              },
            ],
          ]),
          root: {
            chatTabs: [],
            fileTabs: [],
            archivedChats: [],
            executions: [],
            plans: [],
            attachmentNames: [],
          },
        },
        targets: [],
        hardDeleteRepoIds: new Set(['repo']),
      }),
    ).rejects.toBeInstanceOf(SplitItemsMigrationRollbackError);
  });

  it('aborts before writing when a destructive snapshot read fails', async () => {
    const readFailure = Object.assign(new Error('chat read failed'), {
      code: 'EIO',
    });
    jest.mocked(readChatTabsFileForIndex).mockRejectedValue(readFailure);
    jest.mocked(readChatArchivesFileForIndex).mockResolvedValue({
      version: 1,
      archived: [],
    });
    jest.mocked(readTrackedPlansFileForIndex).mockResolvedValue({
      version: 1,
      plans: [],
    });

    await expect(
      migrateSplitChatsAndPlans({
        workspaceId: 'source',
        worktreeId: 'source-wt',
        analysis: {
          perRepo: new Map(),
          root: {
            chatTabs: [],
            fileTabs: [],
            archivedChats: [],
            executions: [],
            plans: [],
            attachmentNames: [],
          },
        },
        targets: [],
      }),
    ).rejects.toThrow('chat read failed');

    expect(writeChatTabsFile).not.toHaveBeenCalled();
    expect(writeChatArchivesFile).not.toHaveBeenCalled();
    expect(installRestoredTrackedPlans).not.toHaveBeenCalled();
  });

  it('preserves destination records created after migration', async () => {
    const sourceChats: ChatTabsFile = {
      version: 1,
      tabs: [tab('migrated-chat')],
      activeTabId: 'migrated-chat',
    };
    const sourceArchives: ArchivedChatsFile = {
      version: 1,
      archived: [],
    };
    jest.mocked(readChatTabsFile).mockResolvedValue({
      version: 1,
      tabs: [tab('migrated-chat'), tab('new-chat')],
      activeTabId: 'migrated-chat',
    });

    await undoSplitChatsAndPlansMigration({
      workspaceId: 'source',
      worktreeId: 'source-wt',
      sourceChatsFile: sourceChats,
      sourceArchivesFile: sourceArchives,
      sourcePlans: [plan('migrated-plan')],
      writtenChatFiles: [
        {
          workspaceId: 'destination',
          worktreeId: 'destination-wt',
          migratedIds: ['migrated-chat'],
        },
      ],
      writtenArchiveFiles: [
        {
          workspaceId: 'destination',
          worktreeId: 'destination-wt',
          migratedIds: ['migrated-archive'],
        },
      ],
      writtenPlanFiles: [
        {
          workspaceId: 'destination',
          worktreeId: 'destination-wt',
          migratedIds: ['migrated-plan'],
        },
      ],
    });

    expect(writeChatTabsFile).toHaveBeenCalledWith(
      'destination',
      'destination-wt',
      expect.objectContaining({
        tabs: [expect.objectContaining({ id: 'new-chat' })],
        activeTabId: 'new-chat',
      }),
    );
    expect(removeChatArchive).toHaveBeenCalledWith(
      'destination',
      'destination-wt',
      'migrated-archive',
    );
    expect(deleteTrackedPlan).toHaveBeenCalledWith(
      'destination',
      'destination-wt',
      'migrated-plan',
    );
    expect(writeChatArchivesFile).toHaveBeenCalledWith(
      'source',
      'source-wt',
      sourceArchives,
      { authoritative: true },
    );
    expect(installRestoredTrackedPlans).toHaveBeenCalledWith(
      'source',
      'source-wt',
      expect.arrayContaining([
        expect.objectContaining({ id: 'migrated-plan' }),
      ]),
    );
  });

  it('reads canonical destination tabs when rollback immediately follows a deferred compatibility write', async () => {
    const migratedTab = tab('migrated-chat');
    const concurrentTab = tab('new-chat');
    jest.mocked(readChatTabsFile).mockResolvedValue({
      version: 1,
      tabs: [migratedTab, concurrentTab],
      activeTabId: migratedTab.id,
    });
    jest.mocked(readChatTabsFileForIndex).mockResolvedValue({
      version: 1,
      tabs: [],
      activeTabId: '',
    });

    await undoSplitChatsAndPlansMigration({
      workspaceId: 'source',
      worktreeId: 'source-wt',
      sourceChatsFile: {
        version: 1,
        tabs: [migratedTab],
        activeTabId: migratedTab.id,
      },
      sourceArchivesFile: { version: 1, archived: [] },
      sourcePlans: [],
      writtenChatFiles: [
        {
          workspaceId: 'destination',
          worktreeId: 'destination-wt',
          migratedIds: [migratedTab.id],
          migratedTabs: [migratedTab],
          migratedPendingQuestions: [],
        },
      ],
      writtenArchiveFiles: [],
      writtenPlanFiles: [],
    });

    expect(writeChatTabsFile).toHaveBeenLastCalledWith(
      'destination',
      'destination-wt',
      expect.objectContaining({
        tabs: [concurrentTab],
        activeTabId: concurrentTab.id,
      }),
    );
  });

  it('preserves edited migrated chats and their destination artifacts', async () => {
    const migratedTab = tab('migrated-chat');
    const editedTab = { ...migratedTab, title: 'edited after migration' };
    const destinationAttachment = '/data/destination/destination-wt/attachment';
    jest.mocked(readChatTabsFile).mockResolvedValue({
      version: 1,
      tabs: [editedTab],
      activeTabId: editedTab.id,
    });

    await undoSplitChatsAndPlansMigration({
      workspaceId: 'source',
      worktreeId: 'source-wt',
      sourceChatsFile: {
        version: 1,
        tabs: [migratedTab],
        activeTabId: migratedTab.id,
      },
      sourceArchivesFile: { version: 1, archived: [] },
      sourcePlans: [],
      writtenChatFiles: [
        {
          workspaceId: 'destination',
          worktreeId: 'destination-wt',
          migratedIds: [migratedTab.id],
          migratedTabs: [migratedTab],
          migratedPendingQuestions: [],
        },
      ],
      writtenArchiveFiles: [
        {
          workspaceId: 'destination',
          worktreeId: 'destination-wt',
          migratedIds: ['migrated-archive'],
        },
      ],
      writtenPlanFiles: [
        {
          workspaceId: 'destination',
          worktreeId: 'destination-wt',
          migratedIds: ['migrated-plan'],
        },
      ],
      writtenAttachmentFiles: [
        {
          workspaceId: 'destination',
          worktreeId: 'destination-wt',
          sourcePath: '/data/source/source-wt/attachment',
          destinationPath: destinationAttachment,
        },
      ],
    });

    expect(writeChatTabsFile).toHaveBeenCalledWith(
      'destination',
      'destination-wt',
      expect.objectContaining({ tabs: [editedTab] }),
    );
    expect(removeChatArchive).not.toHaveBeenCalled();
    expect(deleteTrackedPlan).not.toHaveBeenCalled();
    expect(rm).not.toHaveBeenCalledWith(destinationAttachment, { force: true });
  });

  it('restores only the failed archive target to the source', async () => {
    const emptyArchives: ArchivedChatsFile = { version: 1, archived: [] };
    jest
      .mocked(readChatTabsFile)
      .mockResolvedValueOnce({
        version: 1,
        tabs: [tab('root-chat')],
        activeTabId: 'root-chat',
      })
      .mockResolvedValueOnce({
        version: 1,
        tabs: [tab('target-chat'), tab('new-destination-chat')],
        activeTabId: 'target-chat',
      });
    jest.mocked(readChatArchivesFileForIndex).mockResolvedValue(emptyArchives);

    await undoSplitChatsAndPlansTargetMigration(
      {
        workspaceId: 'source',
        worktreeId: 'source-wt',
        sourceChatsFile: {
          version: 1,
          tabs: [tab('target-chat'), tab('other-repo-chat'), tab('root-chat')],
          activeTabId: 'target-chat',
        },
        sourceArchivesFile: emptyArchives,
        sourcePlans: [],
        writtenChatFiles: [
          {
            workspaceId: 'destination',
            worktreeId: 'destination-wt',
            migratedIds: ['target-chat'],
          },
        ],
        writtenArchiveFiles: [],
        writtenPlanFiles: [],
      },
      {
        repoId: 'target-repo',
        destinationWorkspaceId: 'destination',
        destinationWorktreeId: 'destination-wt',
        oldCheckoutPath: '/old/target',
        newCheckoutPath: '/new/target',
      },
    );

    expect(writeChatTabsFile).toHaveBeenNthCalledWith(
      1,
      'source',
      'source-wt',
      expect.objectContaining({
        tabs: [
          expect.objectContaining({ id: 'root-chat' }),
          expect.objectContaining({ id: 'target-chat' }),
        ],
      }),
      {
        changedTabIds: ['target-chat'],
        removedTabIds: [],
        authoritative: true,
      },
    );
    expect(writeChatTabsFile).toHaveBeenNthCalledWith(
      2,
      'destination',
      'destination-wt',
      expect.objectContaining({
        tabs: [expect.objectContaining({ id: 'new-destination-chat' })],
      }),
    );
    const restoredSource = jest.mocked(writeChatTabsFile).mock.calls[0]?.[2];
    expect(
      restoredSource?.tabs.some((entry) => entry.id === 'other-repo-chat'),
    ).toBe(false);
  });

  it('restores a failed target archive authoritatively', async () => {
    const restoredArchive = {
      tab: tab('target-archive'),
      archivedAt: '2026-08-03T00:00:00.000Z',
    };
    jest.mocked(readChatTabsFileForIndex).mockResolvedValue({
      version: 1,
      tabs: [tab('root-chat')],
      activeTabId: 'root-chat',
    });
    jest.mocked(readChatArchivesFileForIndex).mockResolvedValue({
      version: 1,
      archived: [],
    });

    await undoSplitChatsAndPlansTargetMigration(
      {
        workspaceId: 'source',
        worktreeId: 'source-wt',
        sourceChatsFile: {
          version: 1,
          tabs: [tab('root-chat')],
          activeTabId: 'root-chat',
        },
        sourceArchivesFile: { version: 1, archived: [restoredArchive] },
        sourcePlans: [],
        writtenChatFiles: [],
        writtenArchiveFiles: [
          {
            workspaceId: 'destination',
            worktreeId: 'destination-wt',
            migratedIds: ['target-archive'],
          },
        ],
        writtenPlanFiles: [],
      },
      {
        repoId: 'target-repo',
        destinationWorkspaceId: 'destination',
        destinationWorktreeId: 'destination-wt',
        oldCheckoutPath: '/old/target',
        newCheckoutPath: '/new/target',
      },
    );

    expect(writeChatArchivesFile).toHaveBeenCalledWith(
      'source',
      'source-wt',
      { version: 1, archived: [restoredArchive] },
      { authoritative: true },
    );
  });

  it('restores pending questions for only the failed target', async () => {
    const targetTab = tab('target-chat');
    const targetQuestion = {
      requestId: 'target-question',
      chatId: targetTab.id,
      questions: [],
    };
    const rootQuestion = {
      requestId: 'root-question',
      chatId: 'root-chat',
      questions: [],
    };
    jest
      .mocked(readChatTabsFile)
      .mockResolvedValueOnce({
        version: 1,
        tabs: [tab('root-chat')],
        activeTabId: 'root-chat',
        pendingQuestions: [rootQuestion],
      })
      .mockResolvedValueOnce({
        version: 1,
        tabs: [targetTab],
        activeTabId: targetTab.id,
        pendingQuestions: [targetQuestion],
      });
    jest.mocked(readChatArchivesFileForIndex).mockResolvedValue({
      version: 1,
      archived: [],
    });

    await undoSplitChatsAndPlansTargetMigration(
      {
        workspaceId: 'source',
        worktreeId: 'source-wt',
        sourceChatsFile: {
          version: 1,
          tabs: [targetTab, tab('root-chat')],
          activeTabId: targetTab.id,
          pendingQuestions: [targetQuestion, rootQuestion],
        },
        sourceArchivesFile: { version: 1, archived: [] },
        sourcePlans: [],
        writtenChatFiles: [
          {
            workspaceId: 'destination',
            worktreeId: 'destination-wt',
            migratedIds: [targetTab.id],
            migratedTabs: [targetTab],
            migratedPendingQuestions: [targetQuestion],
          },
        ],
        writtenArchiveFiles: [],
        writtenPlanFiles: [],
      },
      {
        repoId: 'target-repo',
        destinationWorkspaceId: 'destination',
        destinationWorktreeId: 'destination-wt',
        oldCheckoutPath: '/old/target',
        newCheckoutPath: '/new/target',
      },
    );

    expect(writeChatTabsFile).toHaveBeenNthCalledWith(
      1,
      'source',
      'source-wt',
      expect.objectContaining({
        pendingQuestions: [rootQuestion, targetQuestion],
      }),
      {
        authoritative: true,
        changedTabIds: [targetTab.id],
        removedTabIds: [],
      },
    );
    expect(writeChatTabsFile).toHaveBeenNthCalledWith(
      2,
      'destination',
      'destination-wt',
      expect.objectContaining({ pendingQuestions: [] }),
    );
  });

  it('retains destination copies when source-store restoration fails', async () => {
    jest
      .mocked(readChatTabsFile)
      .mockRejectedValue(new Error('chat read failed'));
    jest
      .mocked(readChatArchivesFileForIndex)
      .mockRejectedValue(new Error('archive read failed'));

    await expect(
      undoSplitChatsAndPlansTargetMigration(
        {
          workspaceId: 'source',
          worktreeId: 'source-wt',
          sourceChatsFile: {
            version: 1,
            tabs: [tab('target-chat')],
            activeTabId: 'target-chat',
          },
          sourceArchivesFile: { version: 1, archived: [] },
          sourcePlans: [plan('target-plan')],
          writtenChatFiles: [
            {
              workspaceId: 'destination',
              worktreeId: 'destination-wt',
              migratedIds: ['target-chat'],
            },
          ],
          writtenArchiveFiles: [],
          writtenPlanFiles: [],
        },
        {
          repoId: 'target-repo',
          destinationWorkspaceId: 'destination',
          destinationWorktreeId: 'destination-wt',
          oldCheckoutPath: '/old/target',
          newCheckoutPath: '/new/target',
        },
      ),
    ).rejects.toThrow('chat read failed');
    expect(removeChatArchive).not.toHaveBeenCalled();
    expect(deleteTrackedPlan).not.toHaveBeenCalled();
  });

  it('retains archived destination copies when the strict source read fails', async () => {
    const archived = {
      tab: tab('target-archive'),
      archivedAt: '2026-08-03T00:00:00.000Z',
      turnCount: 1,
    };
    jest
      .mocked(readChatArchivesFileForIndex)
      .mockRejectedValue(new Error('archive parse failed'));

    await expect(
      undoSplitChatsAndPlansTargetMigration(
        {
          workspaceId: 'source',
          worktreeId: 'source-wt',
          sourceChatsFile: { version: 1, tabs: [], activeTabId: '' },
          sourceArchivesFile: { version: 1, archived: [archived] },
          sourcePlans: [],
          writtenChatFiles: [],
          writtenArchiveFiles: [
            {
              workspaceId: 'destination',
              worktreeId: 'destination-wt',
              migratedIds: [archived.tab.id],
            },
          ],
          writtenPlanFiles: [],
        },
        {
          repoId: 'target-repo',
          destinationWorkspaceId: 'destination',
          destinationWorktreeId: 'destination-wt',
          oldCheckoutPath: '/old/target',
          newCheckoutPath: '/new/target',
        },
      ),
    ).rejects.toThrow('archive parse failed');

    expect(removeChatArchive).not.toHaveBeenCalled();
  });

  it('retains plan copies when the strict source plan read fails', async () => {
    jest
      .mocked(readTrackedPlansFileForIndex)
      .mockRejectedValue(new Error('plan parse failed'));

    await expect(
      undoSplitChatsAndPlansTargetMigration(
        {
          workspaceId: 'source',
          worktreeId: 'source-wt',
          sourceChatsFile: { version: 1, tabs: [], activeTabId: '' },
          sourceArchivesFile: { version: 1, archived: [] },
          sourcePlans: [plan('target-plan')],
          writtenChatFiles: [],
          writtenArchiveFiles: [],
          writtenPlanFiles: [
            {
              workspaceId: 'destination',
              worktreeId: 'destination-wt',
              migratedIds: ['target-plan'],
            },
          ],
        },
        {
          repoId: 'target-repo',
          destinationWorkspaceId: 'destination',
          destinationWorktreeId: 'destination-wt',
          oldCheckoutPath: '/old/target',
          newCheckoutPath: '/new/target',
        },
      ),
    ).rejects.toThrow('plan parse failed');

    expect(deleteTrackedPlan).not.toHaveBeenCalled();
  });

  it('does not inspect or delete destinations when full source restore fails', async () => {
    jest
      .mocked(writeChatTabsFile)
      .mockRejectedValueOnce(new Error('source write failed'));

    await expect(
      undoSplitChatsAndPlansMigration({
        workspaceId: 'source',
        worktreeId: 'source-wt',
        sourceChatsFile: {
          version: 1,
          tabs: [tab('migrated-chat')],
          activeTabId: 'migrated-chat',
        },
        sourceArchivesFile: { version: 1, archived: [] },
        sourcePlans: [],
        writtenChatFiles: [
          {
            workspaceId: 'destination',
            worktreeId: 'destination-wt',
            migratedIds: ['migrated-chat'],
          },
        ],
        writtenArchiveFiles: [],
        writtenPlanFiles: [],
      }),
    ).rejects.toThrow('source write failed');

    expect(readChatTabsFileForIndex).not.toHaveBeenCalled();
  });

  it('propagates strict destination read failures without deleting records', async () => {
    jest
      .mocked(readChatTabsFile)
      .mockRejectedValue(new Error('destination parse failed'));

    await expect(
      undoSplitChatsAndPlansMigration({
        workspaceId: 'source',
        worktreeId: 'source-wt',
        sourceChatsFile: {
          version: 1,
          tabs: [tab('migrated-chat')],
          activeTabId: 'migrated-chat',
        },
        sourceArchivesFile: { version: 1, archived: [] },
        sourcePlans: [],
        writtenChatFiles: [
          {
            workspaceId: 'destination',
            worktreeId: 'destination-wt',
            migratedIds: ['migrated-chat'],
          },
        ],
        writtenArchiveFiles: [
          {
            workspaceId: 'destination',
            worktreeId: 'destination-wt',
            migratedIds: ['migrated-archive'],
          },
        ],
        writtenPlanFiles: [],
      }),
    ).rejects.toThrow('destination parse failed');

    expect(removeChatArchive).not.toHaveBeenCalled();
  });
});

describe('deleteSplitPipelineExecutions', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.mocked(deleteExecutionArtifacts).mockResolvedValue();
  });

  it('deletes only the requested pipeline execution artifacts', async () => {
    const first = executionState('execution-1', '/old/repo');
    const second = executionState('execution-2', '/old/repo');
    const summary = (state: ExecutionState): ExecutionSummary => ({
      id: state.id,
      pipeline_id: state.pipeline_id,
      pipeline_name: 'Pipeline',
      status: state.status,
      status_reasons: [],
      started_at: state.started_at,
      cwd: state.cwd,
      project_id: state.project_id,
      worktree_id: state.worktree_id,
    });

    await deleteSplitPipelineExecutions([summary(first), summary(second)]);

    expect(deleteExecutionArtifacts).toHaveBeenCalledTimes(2);
    expect(deleteExecutionArtifacts).toHaveBeenCalledWith(first.id, '/runs');
    expect(deleteExecutionArtifacts).toHaveBeenCalledWith(second.id, '/runs');
  });
});

describe('hasSplitWorktreeStoredItems', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockFlushChatState.mockResolvedValue();
    jest.mocked(readChatTabsFileForIndex).mockResolvedValue({
      version: 1,
      tabs: [],
      activeTabId: '',
    });
    jest.mocked(readChatArchivesFileForIndex).mockResolvedValue({
      version: 1,
      archived: [],
    });
    jest.mocked(readTrackedPlansFileForIndex).mockResolvedValue({
      version: 1,
      plans: [],
    });
    jest.mocked(listExecutionSummaries).mockResolvedValue([]);
    jest.mocked(readdir).mockResolvedValue([]);
  });

  it('returns false for an empty destination worktree', async () => {
    await expect(
      hasSplitWorktreeStoredItems('destination', 'destination-wt'),
    ).resolves.toBe(false);
    expect(mockFlushChatState).toHaveBeenCalledWith(
      'destination',
      'destination-wt',
    );
    expect(mockFlushChatState.mock.invocationCallOrder[0]).toBeLessThan(
      jest.mocked(readChatTabsFileForIndex).mock.invocationCallOrder[0],
    );
  });

  it('detects a chat created after the split fast phase', async () => {
    jest.mocked(readChatTabsFileForIndex).mockResolvedValue({
      version: 1,
      tabs: [tab('new-chat')],
      activeTabId: 'new-chat',
    });

    await expect(
      hasSplitWorktreeStoredItems('destination', 'destination-wt'),
    ).resolves.toBe(true);
  });

  it('detects a pending question retained for recovery', async () => {
    jest.mocked(readChatTabsFileForIndex).mockResolvedValue({
      version: 1,
      tabs: [],
      activeTabId: '',
      pendingQuestions: [
        {
          requestId: 'retained-question',
          chatId: 'migrated-chat',
          questions: [],
        },
      ],
    });

    await expect(
      hasSplitWorktreeStoredItems('destination', 'destination-wt'),
    ).resolves.toBe(true);
  });

  it('propagates unreadable persisted stores instead of reporting empty', async () => {
    jest
      .mocked(readChatTabsFileForIndex)
      .mockRejectedValue(
        Object.assign(new Error('chat read failed'), { code: 'EIO' }),
      );

    await expect(
      hasSplitWorktreeStoredItems('destination', 'destination-wt'),
    ).rejects.toThrow('chat read failed');
  });

  it('propagates execution-store discovery failures', async () => {
    jest
      .mocked(listExecutionSummaries)
      .mockRejectedValue(
        Object.assign(new Error('execution read failed'), { code: 'EIO' }),
      );

    await expect(
      hasSplitWorktreeStoredItems('destination', 'destination-wt'),
    ).rejects.toThrow('execution read failed');
  });

  it('treats missing attachment directories as empty', async () => {
    jest
      .mocked(readdir)
      .mockRejectedValue(
        Object.assign(new Error('missing'), { code: 'ENOENT' }),
      );

    await expect(
      hasSplitWorktreeStoredItems('destination', 'destination-wt'),
    ).resolves.toBe(false);
  });

  it('propagates attachment discovery failures', async () => {
    jest
      .mocked(readdir)
      .mockRejectedValue(
        Object.assign(new Error('attachment read failed'), { code: 'EIO' }),
      );

    await expect(
      hasSplitWorktreeStoredItems('destination', 'destination-wt'),
    ).rejects.toThrow('attachment read failed');
  });
});

describe('migrateSplitPipelineExecutions', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('restores every captured execution when a later save fails', async () => {
    const first = executionState('execution-1', '/old/repo/one');
    const second = executionState('execution-2', '/old/repo/two');
    const summaries: ExecutionSummary[] = [
      {
        id: first.id,
        pipeline_id: 'pipeline',
        pipeline_name: 'Pipeline',
        status: 'success',
        status_reasons: [],
        started_at: '2026-08-03T00:00:00.000Z',
        cwd: first.cwd,
        project_id: 'source',
        worktree_id: 'source-wt',
      },
      {
        id: second.id,
        pipeline_id: 'pipeline',
        pipeline_name: 'Pipeline',
        status: 'success',
        status_reasons: [],
        started_at: '2026-08-03T00:00:00.000Z',
        cwd: second.cwd,
        project_id: 'source',
        worktree_id: 'source-wt',
      },
    ];
    jest.mocked(listExecutionSummaries).mockResolvedValue(summaries);
    jest
      .mocked(loadExecutionState)
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(second);
    jest
      .mocked(saveExecutionState)
      .mockResolvedValueOnce()
      .mockRejectedValueOnce(new Error('disk full'))
      .mockResolvedValue();

    await expect(
      migrateSplitPipelineExecutions({
        workspaceId: 'source',
        worktreeId: 'source-wt',
        targets: [
          {
            repoId: 'repo',
            destinationWorkspaceId: 'destination',
            destinationWorktreeId: 'destination-wt',
            oldCheckoutPath: '/old/repo',
            newCheckoutPath: '/new/repo',
          },
        ],
      }),
    ).rejects.toThrow('disk full');

    expect(saveExecutionState).toHaveBeenNthCalledWith(3, first, '/runs');
    expect(saveExecutionState).toHaveBeenNthCalledWith(4, second, '/runs');
  });

  it('surfaces execution snapshot restoration failures', async () => {
    const state = executionState('execution-1', '/old/repo');
    const summaries: ExecutionSummary[] = [
      {
        id: state.id,
        pipeline_id: 'pipeline',
        pipeline_name: 'Pipeline',
        status: 'success',
        status_reasons: [],
        started_at: '2026-08-03T00:00:00.000Z',
        cwd: state.cwd,
        project_id: 'source',
        worktree_id: 'source-wt',
      },
    ];
    jest.mocked(listExecutionSummaries).mockResolvedValue(summaries);
    jest.mocked(loadExecutionState).mockResolvedValue(state);
    jest
      .mocked(saveExecutionState)
      .mockRejectedValueOnce(new Error('migration write failed'))
      .mockRejectedValueOnce(new Error('snapshot restore failed'));

    await expect(
      migrateSplitPipelineExecutions({
        workspaceId: 'source',
        worktreeId: 'source-wt',
        targets: [
          {
            repoId: 'repo',
            destinationWorkspaceId: 'destination',
            destinationWorktreeId: 'destination-wt',
            oldCheckoutPath: '/old/repo',
            newCheckoutPath: '/new/repo',
          },
        ],
      }),
    ).rejects.toBeInstanceOf(SplitExecutionMigrationRollbackError);

    expect(saveExecutionState).toHaveBeenNthCalledWith(2, state, '/runs');
  });

  it('rewrites every checkout and worktree locator while retaining snapshots', async () => {
    const state: ExecutionState = {
      ...executionState('execution-1', '/old/repo/subdir'),
      repo_path: '/old/repo',
      pipeline_file_dir: '/old/repo/.canopy/pipelines',
      target: {
        scope: 'worktree',
        workspace_id: 'source',
        worktree_id: 'source-wt',
        path: '/old/repo/subdir',
        created: false,
      },
    };
    const summaries: ExecutionSummary[] = [
      {
        id: state.id,
        pipeline_id: 'pipeline',
        pipeline_name: 'Pipeline',
        status: 'success',
        status_reasons: [],
        started_at: '2026-08-03T00:00:00.000Z',
        cwd: state.cwd,
        project_id: 'source',
        worktree_id: 'source-wt',
      },
    ];
    jest.mocked(listExecutionSummaries).mockResolvedValue(summaries);
    jest.mocked(loadExecutionState).mockResolvedValue(state);
    jest.mocked(saveExecutionState).mockResolvedValue();

    const snapshots = await migrateSplitPipelineExecutions({
      workspaceId: 'source',
      worktreeId: 'source-wt',
      targets: [
        {
          repoId: 'repo',
          destinationWorkspaceId: 'destination',
          destinationWorktreeId: 'destination-wt',
          oldCheckoutPath: '/old/repo',
          newCheckoutPath: '/new/repo',
        },
      ],
    });

    expect(snapshots.get(state.id)).toBe(state);
    expect(saveExecutionState).toHaveBeenCalledWith(
      expect.objectContaining({
        project_id: 'destination',
        worktree_id: 'destination-wt',
        cwd: '/new/repo/subdir',
        repo_path: '/new/repo',
        pipeline_file_dir: '/new/repo/.canopy/pipelines',
        target: {
          scope: 'worktree',
          workspace_id: 'destination',
          worktree_id: 'destination-wt',
          path: '/new/repo/subdir',
          created: false,
        },
      }),
      '/runs',
    );
  });
});
