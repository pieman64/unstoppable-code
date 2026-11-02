jest.mock('node:fs/promises', () => ({
  readFile: jest.fn(),
}));

jest.mock('@canopy/desktop-instrumentation', () => ({
  createDesktopInstrumentationOperationKey: jest.fn(
    (seed: string) => `operation:${seed}`,
  ),
}));

jest.mock('@canopy/desktop-instrumentation/electron/main', () => ({
  startDesktopOperation: jest.fn(),
  succeedDesktopOperation: jest.fn(),
}));

jest.mock('../lib/paths', () => ({
  getChatProjectsFilePath: jest.fn(() => '/projects.json'),
}));

jest.mock('../lib/sidebar-items', () => ({
  readAllSidebarItems: jest.fn(),
}));

jest.mock('../lib/standalone-history-index', () => ({
  loadHistoryIndex: jest.fn(),
}));

jest.mock('../lib/cowork-work-entries', () => ({
  listWorkEntryIds: jest.fn(),
  readWorkEntryChatCatalog: jest.fn(),
}));

jest.mock('../lib/chat-tabs-reader', () => ({
  readChatTabsFile: jest.fn(),
}));

jest.mock('../lib/chat-archives', () => ({
  readChatArchivesFile: jest.fn(),
}));

jest.mock('../lib/standalone-workspace-files', () => ({
  listAttachments: jest.fn(),
  listNotes: jest.fn(),
  listPrompts: jest.fn(),
}));

import { readFile } from 'node:fs/promises';
import {
  startDesktopOperation,
  succeedDesktopOperation,
} from '@canopy/desktop-instrumentation/electron/main';
import { readAllSidebarItems } from '../lib/sidebar-items';
import { loadHistoryIndex } from '../lib/standalone-history-index';
import {
  listWorkEntryIds,
  readWorkEntryChatCatalog,
} from '../lib/cowork-work-entries';
import { readChatTabsFile } from '../lib/chat-tabs-reader';
import { readChatArchivesFile } from '../lib/chat-archives';
import {
  listAttachments,
  listNotes,
  listPrompts,
} from '../lib/standalone-workspace-files';
import {
  recordActivationCampaignTelemetry,
  recordStandaloneFeatureTelemetry,
  recordWorkspaceCrudTelemetry,
} from '../lib/desktop-telemetry';

const mockedReadFile = jest.mocked(readFile);
const mockedReadAllSidebarItems = jest.mocked(readAllSidebarItems);
const mockedLoadHistoryIndex = jest.mocked(loadHistoryIndex);
const mockedListWorkEntryIds = jest.mocked(listWorkEntryIds);
const mockedReadWorkEntryChatCatalog = jest.mocked(readWorkEntryChatCatalog);
const mockedReadChatTabsFile = jest.mocked(readChatTabsFile);
const mockedReadChatArchivesFile = jest.mocked(readChatArchivesFile);
const mockedListNotes = jest.mocked(listNotes);
const mockedListPrompts = jest.mocked(listPrompts);
const mockedListAttachments = jest.mocked(listAttachments);
const mockedStartDesktopOperation = jest.mocked(startDesktopOperation);
const mockedSucceedDesktopOperation = jest.mocked(succeedDesktopOperation);

async function flushTelemetry(): Promise<void> {
  for (let index = 0; index < 10; index += 1) {
    await Promise.resolve();
  }
}

describe('desktop telemetry helpers', () => {
  let setImmediateSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(Date, 'now').mockReturnValue(1_000);
    setImmediateSpy = jest
      .spyOn(globalThis, 'setImmediate')
      .mockImplementation((callback: () => void) => {
        callback();
        return undefined as unknown as NodeJS.Immediate;
      });

    mockedReadAllSidebarItems.mockResolvedValue({
      version: 1,
      items: [
        {
          id: 'workspace-1',
          name: 'Workspace',
          path: '/workspace',
          type: 'single-repo',
          worktrees: [{ id: 'worktree-1' }],
        },
        {
          id: 'cowork-1',
          name: 'Cowork',
          type: 'cowork',
        },
      ],
    } as never);

    mockedReadFile.mockResolvedValue(
      JSON.stringify({
        version: 1,
        projects: [{ id: 'project-1', name: 'Project' }],
      }),
    );
    mockedListWorkEntryIds.mockResolvedValue(['entry-1']);
    mockedReadWorkEntryChatCatalog.mockResolvedValue({
      liveChatIds: ['chat-1'],
      archives: [
        { chatId: 'entry-archive', archivedAt: new Date(2).toISOString() },
      ],
    });
    mockedReadChatTabsFile.mockResolvedValue({
      version: 1,
      tabs: [
        {
          id: 'chat-1',
          title: 'Live chat',
          createdAt: new Date(0).toISOString(),
          kind: 'chat',
          messages: [],
        },
      ],
      activeTabId: 'chat-1',
    });
    mockedLoadHistoryIndex.mockResolvedValue([
      {
        chatId: 'legacy-archive',
        title: 'Legacy archive',
        createdAt: new Date(0).toISOString(),
        archivedAt: new Date(1).toISOString(),
        messageCount: 1,
        hasConversationSnapshot: true,
        legacySummaryOnly: false,
      },
    ]);
    mockedReadChatArchivesFile.mockResolvedValue({
      version: 1,
      archived: [
        {
          tab: {
            id: 'entry-archive',
            title: 'Entry archive',
            createdAt: new Date(0).toISOString(),
            kind: 'chat',
            messages: [],
          },
          archivedAt: new Date(2).toISOString(),
          turnCount: 0,
        },
      ],
    });
    mockedListNotes.mockResolvedValue([
      {
        id: 'note-1',
        title: 'Note 1',
        createdAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
      },
    ]);
    mockedListPrompts.mockResolvedValue([
      {
        id: 'prompt-1',
        title: 'Prompt 1',
        createdAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
      },
    ]);
    mockedListAttachments.mockResolvedValue([
      {
        id: 'attachment-1',
        filename: 'attachment-1.txt',
        absolutePath: '/workspace/attachment-1.txt',
        createdAt: new Date(0).toISOString(),
      },
    ]);
  });

  afterEach(() => {
    setImmediateSpy.mockRestore();
    jest.restoreAllMocks();
  });

  it('emits project CRUD context and reuses cached sidebar totals', async () => {
    recordWorkspaceCrudTelemetry({
      action: 'create',
      workspaceId: 'workspace-1',
      source: 'manual',
    });
    await flushTelemetry();
    recordWorkspaceCrudTelemetry({
      action: 'update',
      workspaceId: 'cowork-1',
      source: 'manual',
    });
    await flushTelemetry();

    expect(mockedReadAllSidebarItems).toHaveBeenCalledTimes(1);
    expect(mockedStartDesktopOperation.mock.calls[0]?.[0]).toBe(
      'canopy.workspace_crud',
    );
    expect(mockedStartDesktopOperation.mock.calls[0]?.[1]).toMatchObject({
      context: {
        action: 'create',
        source: 'manual',
        workspace_total: 2,
        single_repo_workspace_total: 1,
        worktree_total: 1,
        workspace_worktree_total: 1,
        workspace_type: 'single-repo',
      },
    });
    expect(mockedStartDesktopOperation.mock.calls[1]?.[1]).toMatchObject({
      context: {
        action: 'update',
        source: 'manual',
        workspace_total: 2,
        workspace_worktree_total: 0,
        workspace_repo_total: 0,
        workspace_type: 'cowork',
      },
    });
    expect(mockedSucceedDesktopOperation).toHaveBeenCalledTimes(2);
  });

  it('leaves the pre-existing campaign event shape unchanged without an item id', async () => {
    recordActivationCampaignTelemetry({
      campaignId: 'activation-marketplace',
      outcome: 'suppressed',
      reason: 'quiet-hours',
    });
    await flushTelemetry();

    const [name, options] = mockedStartDesktopOperation.mock.calls[0] ?? [];
    expect(name).toBe('canopy.activation_campaign');
    // No `item_id` segment and no `item_id` attribute: existing dashboards
    // keyed on `campaignId:outcome` are unaffected.
    expect(options?.operationKey).toMatch(
      /^operation:canopy\.activation_campaign:activation-marketplace:suppressed:\d+$/,
    );
    expect(options?.context).toEqual({
      campaign_id: 'activation-marketplace',
      outcome: 'suppressed',
      reason: 'quiet-hours',
    });
  });

  it('reuses cached standalone totals across feature telemetry events', async () => {
    recordStandaloneFeatureTelemetry({
      action: 'create_chat',
      projectId: 'project-1',
      itemKind: 'chat',
    });
    await flushTelemetry();
    recordStandaloneFeatureTelemetry({
      action: 'resume_archive',
      projectId: 'project-1',
      itemKind: 'chat',
    });
    await flushTelemetry();

    expect(mockedReadFile).toHaveBeenCalledTimes(1);
    expect(mockedListWorkEntryIds).toHaveBeenCalledTimes(2);
    // Counts are catalog reads (entry + legacy home slot per project); the
    // admitting compatibility readers are never used for telemetry.
    expect(
      mockedReadWorkEntryChatCatalog.mock.calls
        .map(([projectId, entryId]) => `${projectId}/${entryId}`)
        .sort(),
    ).toEqual([
      'default/entry-1',
      'default/home',
      'project-1/entry-1',
      'project-1/home',
    ]);
    expect(mockedReadChatTabsFile).not.toHaveBeenCalled();
    expect(mockedReadChatArchivesFile).not.toHaveBeenCalled();
    expect(mockedLoadHistoryIndex).toHaveBeenCalledTimes(2);
    expect(mockedListNotes).toHaveBeenCalledTimes(2);
    expect(mockedListPrompts).toHaveBeenCalledTimes(2);
    expect(mockedListAttachments).toHaveBeenCalledTimes(2);
    expect(mockedStartDesktopOperation.mock.calls[0]?.[0]).toBe(
      'canopy.standalone_chat_project_feature',
    );
    expect(mockedStartDesktopOperation.mock.calls[0]?.[1]).toMatchObject({
      context: {
        action: 'create_chat',
        item_kind: 'chat',
        standalone_project_total: 2,
        standalone_chat_total: 2,
        standalone_archived_chat_total: 4,
        project_chat_total: 1,
        project_archived_chat_total: 2,
        project_note_total: 1,
      },
    });
  });
});
