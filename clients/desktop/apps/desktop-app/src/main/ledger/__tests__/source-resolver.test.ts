jest.mock('../../lib/chat-tabs-reader', () => ({
  readChatTabsFile: jest.fn(),
}));
jest.mock('../../lib/chat-archives', () => ({
  readChatArchivesFile: jest.fn(),
}));
jest.mock('../../lib/worktree-summary-persistence', () => ({
  readWorktreeSummaryFile: jest.fn(),
}));
jest.mock('../../lib/paths', () => ({
  getDataDir: (): string => '/data',
}));
jest.mock(
  '@canopy/desktop-shared/node/pipelines/executor/execution-state',
  () => ({ loadExecutionState: jest.fn() }),
);
jest.mock('../view-scope', () => ({
  ledgerViewScopeForContainer: (container: {
    workspaceId: string;
    worktreeId: string;
  }): { projectId: string; worktreeId: string } => ({
    projectId: container.workspaceId,
    worktreeId: container.worktreeId,
  }),
}));

import {
  toLedgerEntrySearchItem,
  type LedgerActorRef,
  type LedgerAuthorDetails,
  type LedgerEntry,
  type LedgerOrigin,
} from '@canopy/protocol/canopy-core';
import type { LedgerViewScope } from '@canopy/protocol/ledger-view';
import type {
  ArchivedChatsFile,
  ChatTabsFile,
  PersistedChatTab,
  WorktreeSummaryFile,
} from '@canopy/desktop-shared/types';
import type { ExecutionState } from '@canopy/desktop-shared/types/pipeline';
import { loadExecutionState } from '@canopy/desktop-shared/node/pipelines/executor/execution-state';
import { readChatArchivesFile } from '../../lib/chat-archives';
import { readChatTabsFile } from '../../lib/chat-tabs-reader';
import { readWorktreeSummaryFile } from '../../lib/worktree-summary-persistence';
import {
  DESKTOP_LEDGER_SOURCE_HOST,
  resolveDesktopLedgerSourceAvailability,
  resolveLedgerViewSource,
  type LedgerSourceHost,
} from '../source-resolver';
import type { LedgerBoundScope } from '../scope-bindings';

const LEDGER_ID = '00000000-0000-4000-8000-000000000001';
const ACTOR_ID = '00000000-0000-4000-8000-000000000002';
const ENTRY_ID = '00000000-0000-4000-8000-000000000003';
const CREATED_AT = '2026-09-30T09:00:00.000Z';
const ACTOR: LedgerActorRef = {
  actorId: ACTOR_ID,
  kind: 'chat',
  authorityId: 'authority-1',
};
const DETAILS: LedgerAuthorDetails = {
  harness: 'claude',
  model: 'claude-sonnet',
  thinkingEffort: null,
  mode: null,
  pipelineExecutionId: null,
  settingsRevision: null,
  unavailableReason: null,
};
const SCOPE: LedgerViewScope = { projectId: 'workspace-1', worktreeId: 'wt-1' };
const SNAPSHOT = {
  title: 'Adds login',
  description: 'The login form landed.',
  highlights: ['Form'],
  generatedAt: '2026-09-30T10:00:00.000Z',
};

const mockedReadChatTabsFile = jest.mocked(readChatTabsFile);
const mockedReadChatArchivesFile = jest.mocked(readChatArchivesFile);
const mockedReadWorktreeSummaryFile = jest.mocked(readWorktreeSummaryFile);
const mockedLoadExecutionState = jest.mocked(loadExecutionState);

function host(overrides: Partial<LedgerSourceHost> = {}): LedgerSourceHost {
  return {
    chatPresence: (): ReturnType<LedgerSourceHost['chatPresence']> =>
      Promise.resolve('live'),
    keptExecution: (): ReturnType<LedgerSourceHost['keptExecution']> =>
      Promise.resolve({ projectId: 'workspace-1', worktreeId: 'wt-run' }),
    summarySnapshot: (): ReturnType<LedgerSourceHost['summarySnapshot']> =>
      Promise.resolve(SNAPSHOT),
    ...overrides,
  };
}

const PIPELINE_ORIGIN: LedgerOrigin = {
  kind: 'pipeline_agent',
  ledgerId: LEDGER_ID,
  executionId: 'execution-1',
  physicalJobId: 'build__1',
  logicalJobId: 'build',
  stepId: 'agent',
  attempt: 2,
  iteration: 0,
  agentSessionId: 'session-1',
};

describe('resolveLedgerViewSource', () => {
  it('gives an entry the user added nothing to open', async () => {
    await expect(
      resolveLedgerViewSource(
        SCOPE,
        { kind: 'user', ledgerId: LEDGER_ID, userActorId: ACTOR_ID },
        host(),
      ),
    ).resolves.toEqual({ availability: 'available', target: null });
  });

  it.each([
    ['live', { availability: 'available', archived: false }],
    ['archived', { availability: 'archived', archived: true }],
  ] as const)('opens a %s chat in the scope', async (presence, expected) => {
    const source = await resolveLedgerViewSource(
      SCOPE,
      { kind: 'chat', ledgerId: LEDGER_ID, chatId: 'chat-1' },
      host({ chatPresence: () => Promise.resolve(presence) }),
    );
    expect(source).toEqual({
      availability: expected.availability,
      target: {
        kind: 'chat',
        projectId: 'workspace-1',
        worktreeId: 'wt-1',
        chatId: 'chat-1',
        archived: expected.archived,
      },
    });
  });

  it('reports a deleted chat without a target', async () => {
    await expect(
      resolveLedgerViewSource(
        SCOPE,
        { kind: 'chat', ledgerId: LEDGER_ID, chatId: 'chat-gone' },
        host({ chatPresence: () => Promise.resolve('missing') }),
      ),
    ).resolves.toEqual({ availability: 'deleted', target: null });
  });

  it("opens a delegate's root chat, naming the delegate", async () => {
    const source = await resolveLedgerViewSource(
      SCOPE,
      {
        kind: 'managed_delegation',
        ledgerId: LEDGER_ID,
        delegationId: 'delegation-1',
        parentActorId: ACTOR_ID,
        root: { kind: 'chat', chatId: 'chat-root' },
        runGeneration: 1,
      },
      host(),
    );
    expect(source.target).toEqual({
      kind: 'chat',
      projectId: 'workspace-1',
      worktreeId: 'wt-1',
      chatId: 'chat-root',
      archived: false,
      delegationId: 'delegation-1',
    });
  });

  it("opens a pipeline delegate's run without an attempt", async () => {
    const source = await resolveLedgerViewSource(
      SCOPE,
      {
        kind: 'managed_delegation',
        ledgerId: LEDGER_ID,
        delegationId: 'delegation-1',
        parentActorId: ACTOR_ID,
        root: { kind: 'pipeline_agent', executionId: 'execution-root' },
        runGeneration: 1,
      },
      host(),
    );
    expect(source.target).toEqual({
      kind: 'pipeline',
      projectId: 'workspace-1',
      worktreeId: 'wt-run',
      executionId: 'execution-root',
    });
  });

  it('opens a pipeline agent at its job, step and attempt, where the run was kept', async () => {
    await expect(
      resolveLedgerViewSource(SCOPE, PIPELINE_ORIGIN, host()),
    ).resolves.toEqual({
      availability: 'available',
      target: {
        kind: 'pipeline',
        projectId: 'workspace-1',
        worktreeId: 'wt-run',
        executionId: 'execution-1',
        jobId: 'build__1',
        stepId: 'agent',
        attempt: 2,
      },
    });
  });

  it('reports a pruned run as expired', async () => {
    await expect(
      resolveLedgerViewSource(
        SCOPE,
        PIPELINE_ORIGIN,
        host({ keptExecution: () => Promise.resolve(null) }),
      ),
    ).resolves.toEqual({ availability: 'expired', target: null });
  });

  it('shows the Summary snapshot the entry recorded, or reports it expired', async () => {
    const origin: LedgerOrigin = {
      kind: 'summary',
      ledgerId: LEDGER_ID,
      snapshotId: 'snapshot-1',
      generationId: 'generation-1',
      helperActorId: ACTOR_ID,
    };
    await expect(
      resolveLedgerViewSource(SCOPE, origin, host()),
    ).resolves.toEqual({
      availability: 'available',
      target: { kind: 'summary', snapshot: SNAPSHOT },
    });
    await expect(
      resolveLedgerViewSource(
        SCOPE,
        origin,
        host({ summarySnapshot: () => Promise.resolve(null) }),
      ),
    ).resolves.toEqual({ availability: 'expired', target: null });
  });
});

describe('resolveDesktopLedgerSourceAvailability', () => {
  const boundScope: LedgerBoundScope = {
    ledgerId: LEDGER_ID,
    authorityId: 'authority-1',
    container: {
      kind: 'code_worktree',
      workspaceId: 'workspace-1',
      worktreeId: 'wt-1',
    },
    containerCreatedAt: '2026-09-01T00:00:00.000Z',
    accountId: 'account-1',
  };
  const chatEntry: LedgerEntry = {
    schemaVersion: 1,
    entryId: ENTRY_ID,
    scope: {
      ledgerId: LEDGER_ID,
      authorityId: 'authority-1',
      container: boundScope.container,
    },
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    revision: 1,
    author: ACTOR,
    authorDetails: DETAILS,
    owner: ACTOR,
    type: 'TASK',
    title: 'Plan the work',
    content: 'Write the plan.',
    highlights: [],
    referenceFiles: [],
    status: 'TODO',
    origin: { kind: 'chat', ledgerId: LEDGER_ID, chatId: 'chat-1' },
    attribution: {
      kind: 'self_reported',
      effectiveActor: ACTOR,
      recordedBy: ACTOR,
      executorDetails: DETAILS,
    },
  };

  const chatItem = toLedgerEntrySearchItem(chatEntry, 'available');
  const CHAT_ORIGIN: LedgerOrigin = {
    kind: 'chat',
    ledgerId: LEDGER_ID,
    chatId: 'chat-1',
  };
  const DELEGATE_ORIGIN: LedgerOrigin = {
    kind: 'managed_delegation',
    ledgerId: LEDGER_ID,
    delegationId: 'delegation-1',
    parentActorId: ACTOR_ID,
    root: { kind: 'chat', chatId: 'chat-root' },
    runGeneration: 1,
  };

  function searchItemRequest(
    origin: LedgerOrigin,
    page: object = {},
  ): Parameters<typeof resolveDesktopLedgerSourceAvailability>[0] {
    return {
      scope: boundScope,
      subject: { kind: 'search_item', item: chatItem, origin },
      stored: 'available',
      page,
    };
  }

  it("says from list data whether a search item's chat is live, archived or gone", async () => {
    const outcomes = [
      ['live', 'available'],
      ['archived', 'archived'],
      ['missing', 'deleted'],
    ] as const;
    for (const [presence, availability] of outcomes) {
      const chatPresence = jest.fn(
        (): ReturnType<LedgerSourceHost['chatPresence']> =>
          Promise.resolve(presence),
      );
      await expect(
        resolveDesktopLedgerSourceAvailability(
          searchItemRequest(CHAT_ORIGIN),
          host({ chatPresence }),
        ),
      ).resolves.toBe(availability);
      expect(chatPresence).toHaveBeenCalledWith(SCOPE, 'chat-1');
    }
  });

  it("resolves a delegate's search item by the chat that started it", async () => {
    const chatPresence = jest.fn(
      (): ReturnType<LedgerSourceHost['chatPresence']> =>
        Promise.resolve('archived'),
    );
    await expect(
      resolveDesktopLedgerSourceAvailability(
        searchItemRequest(DELEGATE_ORIGIN),
        host({ chatPresence }),
      ),
    ).resolves.toBe('archived');
    expect(chatPresence).toHaveBeenCalledWith(SCOPE, 'chat-root');
  });

  it('keeps the stored value for a search item whose source is not a chat, reading nothing', async () => {
    const reads = {
      chatPresence: jest.fn(
        (): ReturnType<LedgerSourceHost['chatPresence']> =>
          Promise.resolve('missing'),
      ),
      keptExecution: jest.fn(
        (): ReturnType<LedgerSourceHost['keptExecution']> =>
          Promise.resolve(null),
      ),
      summarySnapshot: jest.fn(
        (): ReturnType<LedgerSourceHost['summarySnapshot']> =>
          Promise.resolve(null),
      ),
    };
    const origins: LedgerOrigin[] = [
      PIPELINE_ORIGIN,
      {
        ...DELEGATE_ORIGIN,
        root: { kind: 'pipeline_agent', executionId: 'execution-1' },
      },
      {
        kind: 'summary',
        ledgerId: LEDGER_ID,
        snapshotId: 'snapshot-1',
        generationId: 'generation-1',
        helperActorId: ACTOR_ID,
      },
      { kind: 'user', ledgerId: LEDGER_ID, userActorId: ACTOR_ID },
    ];
    for (const origin of origins) {
      await expect(
        resolveDesktopLedgerSourceAvailability(
          searchItemRequest(origin),
          host(reads),
        ),
      ).resolves.toBe('available');
    }
    expect(reads.chatPresence).not.toHaveBeenCalled();
    expect(reads.keptExecution).not.toHaveBeenCalled();
    expect(reads.summarySnapshot).not.toHaveBeenCalled();
  });

  it('keeps the stored value for a search item when its chats cannot be read', async () => {
    await expect(
      resolveDesktopLedgerSourceAvailability(
        searchItemRequest(CHAT_ORIGIN),
        host({ chatPresence: () => Promise.reject(new Error('unreadable')) }),
      ),
    ).resolves.toBe('available');
  });

  it('uses one page host for every search item of a page, and a new one for the next page', async () => {
    const forPage = jest.fn((): LedgerSourceHost => host());
    const paged = host({ forPage });
    const page = {};
    await resolveDesktopLedgerSourceAvailability(
      searchItemRequest(CHAT_ORIGIN, page),
      paged,
    );
    await resolveDesktopLedgerSourceAvailability(
      searchItemRequest(DELEGATE_ORIGIN, page),
      paged,
    );
    expect(forPage).toHaveBeenCalledTimes(1);
    await resolveDesktopLedgerSourceAvailability(
      searchItemRequest(CHAT_ORIGIN, {}),
      paged,
    );
    expect(forPage).toHaveBeenCalledTimes(2);
  });

  it('resolves an entry in its scope, and keeps the stored value when that fails', async () => {
    await expect(
      resolveDesktopLedgerSourceAvailability(
        {
          scope: boundScope,
          subject: { kind: 'entry', entry: chatEntry },
          stored: 'available',
          page: {},
        },
        host({ chatPresence: () => Promise.resolve('archived') }),
      ),
    ).resolves.toBe('archived');
    await expect(
      resolveDesktopLedgerSourceAvailability(
        {
          scope: boundScope,
          subject: { kind: 'entry', entry: chatEntry },
          stored: 'available',
          page: {},
        },
        host({ chatPresence: () => Promise.reject(new Error('unreadable')) }),
      ),
    ).resolves.toBe('available');
  });
});

function chatTab(id: string, kind: 'chat' | 'file'): PersistedChatTab {
  return { id, title: id, messages: [], createdAt: CREATED_AT, kind };
}

describe('DESKTOP_LEDGER_SOURCE_HOST', () => {
  beforeEach(() => {
    jest.resetAllMocks();
  });

  it('finds live chats among chat tabs, archived ones among archives, never file tabs', async () => {
    const tabs: ChatTabsFile = {
      version: 1,
      activeTabId: 'chat-live',
      tabs: [chatTab('chat-live', 'chat'), chatTab('file-tab', 'file')],
    };
    const archives: ArchivedChatsFile = {
      version: 1,
      archived: [
        {
          tab: chatTab('chat-archived', 'chat'),
          archivedAt: CREATED_AT,
          turnCount: 1,
        },
      ],
    };
    mockedReadChatTabsFile.mockResolvedValue(tabs);
    mockedReadChatArchivesFile.mockResolvedValue(archives);

    await expect(
      DESKTOP_LEDGER_SOURCE_HOST.chatPresence(SCOPE, 'chat-live'),
    ).resolves.toBe('live');
    await expect(
      DESKTOP_LEDGER_SOURCE_HOST.chatPresence(SCOPE, 'chat-archived'),
    ).resolves.toBe('archived');
    await expect(
      DESKTOP_LEDGER_SOURCE_HOST.chatPresence(SCOPE, 'file-tab'),
    ).resolves.toBe('missing');
    expect(mockedReadChatTabsFile).toHaveBeenCalledWith('workspace-1', 'wt-1');
  });

  it('reads a scope once for a page: its tabs, and its archives only for a chat that is not live', async () => {
    const tabs: ChatTabsFile = {
      version: 1,
      activeTabId: 'chat-live',
      tabs: [chatTab('chat-live', 'chat'), chatTab('chat-other', 'chat')],
    };
    const archives: ArchivedChatsFile = {
      version: 1,
      archived: [
        {
          tab: chatTab('chat-archived', 'chat'),
          archivedAt: CREATED_AT,
          turnCount: 1,
        },
      ],
    };
    mockedReadChatTabsFile.mockResolvedValue(tabs);
    mockedReadChatArchivesFile.mockResolvedValue(archives);

    const page = DESKTOP_LEDGER_SOURCE_HOST.forPage?.();
    if (page === undefined)
      throw new Error('The desktop host has no page host');
    await expect(page.chatPresence(SCOPE, 'chat-live')).resolves.toBe('live');
    await expect(page.chatPresence(SCOPE, 'chat-other')).resolves.toBe('live');
    expect(mockedReadChatTabsFile).toHaveBeenCalledTimes(1);
    expect(mockedReadChatArchivesFile).not.toHaveBeenCalled();

    await expect(page.chatPresence(SCOPE, 'chat-archived')).resolves.toBe(
      'archived',
    );
    await expect(page.chatPresence(SCOPE, 'chat-gone')).resolves.toBe(
      'missing',
    );
    expect(mockedReadChatTabsFile).toHaveBeenCalledTimes(1);
    expect(mockedReadChatArchivesFile).toHaveBeenCalledTimes(1);

    // Another scope has its own chats.
    await page.chatPresence(
      { projectId: 'workspace-2', worktreeId: 'wt-2' },
      'chat-live',
    );
    expect(mockedReadChatTabsFile).toHaveBeenCalledTimes(2);
    expect(mockedReadChatTabsFile).toHaveBeenLastCalledWith(
      'workspace-2',
      'wt-2',
    );
  });

  it('reads a kept run where it ran, and never uses an unsafe ID as a path', async () => {
    const state: ExecutionState = {
      version: 10,
      id: 'execution-1',
      pipeline_id: 'pipeline',
      pipeline_snapshot: { name: 'Pipeline', scope: ['directory'], jobs: {} },
      status: 'success',
      jobs: {},
      job_definitions: {},
      job_groups: {},
      started_at: CREATED_AT,
      cwd: '/tmp/repo',
      env: {},
      inputs: {},
      pending_pauses: [],
      status_reasons: [],
      project_id: 'workspace-1',
      worktree_id: 'wt-run',
    };
    mockedLoadExecutionState.mockResolvedValue(state);

    await expect(
      DESKTOP_LEDGER_SOURCE_HOST.keptExecution('execution-1'),
    ).resolves.toEqual({ projectId: 'workspace-1', worktreeId: 'wt-run' });
    expect(mockedLoadExecutionState).toHaveBeenCalledWith(
      'execution-1',
      '/data/pipeline-executions',
    );
    await expect(
      DESKTOP_LEDGER_SOURCE_HOST.keptExecution('../outside'),
    ).resolves.toBeNull();
    expect(mockedLoadExecutionState).toHaveBeenCalledTimes(1);
  });

  it('reads the recorded snapshot from the scope summary history', async () => {
    const summary = {
      ...SNAPSHOT,
      highlights: [...SNAPSHOT.highlights],
      turnCountAtGeneration: 1,
      lastFullRefreshAt: SNAPSHOT.generatedAt,
      lastFullRefreshTurnCount: 1,
    };
    const file: WorktreeSummaryFile = {
      version: 2,
      summary: { ...summary, title: 'Latest' },
      history: [{ snapshotId: 'snapshot-1', summary }],
    };
    mockedReadWorktreeSummaryFile.mockResolvedValue(file);

    await expect(
      DESKTOP_LEDGER_SOURCE_HOST.summarySnapshot(SCOPE, 'snapshot-1'),
    ).resolves.toEqual(SNAPSHOT);
    await expect(
      DESKTOP_LEDGER_SOURCE_HOST.summarySnapshot(SCOPE, 'snapshot-other'),
    ).resolves.toBeNull();
  });
});
