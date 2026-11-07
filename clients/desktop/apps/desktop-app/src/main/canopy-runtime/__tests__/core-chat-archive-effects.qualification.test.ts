import type {
  ArchivedChatSummary,
  ChatCommandRequest,
  ChatCommandResult,
  ChatGetStateRequest,
  ChatStateCommandPort,
  ChatStateSnapshot,
  PersistedChatTab,
} from '@canopy/desktop-shared/types';
import {
  CoreChatArchiveParamsSchema,
  CoreChatDeleteParamsSchema,
} from '@canopy/protocol/canopy-core';
import { setChatStateCommandPort } from '../../ipc/chat-state';
import { notifyLedgerSessionEnded } from '../../ledger/session-end-sweep-ports';
import { recordChatArchived } from '../../lib/chat-archive-bookkeeping';
import type { CoreChatArchiveEffects } from '../core-chat-archive-effects';
import { createDesktopRuntime } from '../desktop-runtime';

jest.mock('../../ledger/session-end-sweep-ports');
const mockSearch = { worktreeChatArchived: jest.fn() };
jest.mock('../../chat-search/service', () => ({
  getChatSearchService: (): typeof mockSearch => mockSearch,
}));

const projectId = 'project';
const worktreeId = 'worktree';
const caller = {
  principalId: 'local-desktop-user',
  clientInstanceId: 'test',
  authorityId: 'local-desktop',
  interfaceKind: 'desktop' as const,
  grants: ['core.chat.write' as const],
};

function archiveEntry(chatId: string): ArchivedChatSummary {
  return {
    chatId,
    title: chatId,
    turnCount: 1,
    archivedAt: '2026-11-05T10:00:00.000Z',
    createdAt: '2026-11-05T09:00:00.000Z',
    restorable: true,
    unread: false,
  };
}

function liveTab(id: string): PersistedChatTab {
  return { id, title: id, createdAt: '2026-11-05T09:00:00.000Z', messages: [] };
}

function snapshotWith(
  tabs: PersistedChatTab[],
  archives: ArchivedChatSummary[],
): ChatStateSnapshot {
  return {
    schemaVersion: 1,
    projectId,
    worktreeId,
    revision: 8,
    tabsFile: { version: 1, tabs, activeTabId: tabs[0]?.id ?? '' },
    archives,
    runtimeByChatId: {},
    queue: [],
  };
}

// chat:archive-tab and chat:restore-archive call the same bookkeeping functions.
describe('archive bookkeeping behind core commands (CAN-4113)', () => {
  let outcome: ChatCommandResult['outcome'];
  let archivedAt: string | undefined;
  let snapshot: ChatStateSnapshot;
  let getState: jest.Mock<Promise<ChatStateSnapshot>, [ChatGetStateRequest]>;
  let effects: {
    archived: jest.Mock<
      ReturnType<CoreChatArchiveEffects['archived']>,
      Parameters<CoreChatArchiveEffects['archived']>
    >;
    restored: jest.Mock<
      ReturnType<CoreChatArchiveEffects['restored']>,
      Parameters<CoreChatArchiveEffects['restored']>
    >;
  };
  let runtime: ReturnType<typeof createDesktopRuntime>;

  beforeEach(() => {
    outcome = 'applied';
    archivedAt = undefined;
    snapshot = snapshotWith([], []);
    getState = jest.fn<Promise<ChatStateSnapshot>, [ChatGetStateRequest]>(() =>
      Promise.resolve(snapshot),
    );
    const port: ChatStateCommandPort = {
      command: jest.fn(
        (request: ChatCommandRequest): Promise<ChatCommandResult> =>
          Promise.resolve({
            commandId: request.commandId,
            revision: 8,
            outcome,
            entityId: 'c1',
            ...(archivedAt === undefined ? {} : { archivedAt }),
          }),
      ),
      getState,
      getTranscriptPage: jest.fn(),
      readVisual: jest.fn(),
      readToolOutput: jest.fn(),
      searchTranscript: jest.fn(),
      subscribe: jest.fn(() => () => undefined),
    };
    effects = {
      archived: jest.fn<
        ReturnType<CoreChatArchiveEffects['archived']>,
        Parameters<CoreChatArchiveEffects['archived']>
      >(() => Promise.resolve()),
      restored: jest.fn<
        ReturnType<CoreChatArchiveEffects['restored']>,
        Parameters<CoreChatArchiveEffects['restored']>
      >(() => Promise.resolve()),
    };
    setChatStateCommandPort(port);
    runtime = createDesktopRuntime({
      chatCommandPort: port,
      chatArchiveEffects: effects,
    });
  });

  afterEach(async () => {
    await runtime.shutdown();
    setChatStateCommandPort(null);
  });

  function dispatch(
    name: 'core.chat.archive' | 'core.chat.delete',
    commandId: string,
    action: Record<string, unknown>,
  ): Promise<unknown> {
    const params = {
      projectId,
      worktreeId,
      commandId,
      action,
      _meta: { idempotencyKey: commandId },
    };
    const options = { caller, metadata: params._meta };
    return name === 'core.chat.archive'
      ? runtime.instruction(
          name,
          CoreChatArchiveParamsSchema.parse(params),
          options,
        )
      : runtime.instruction(
          name,
          CoreChatDeleteParamsSchema.parse(params),
          options,
        );
  }

  it('runs archive bookkeeping after a core archive', async () => {
    snapshot = snapshotWith([], [archiveEntry('c1')]);
    await dispatch('core.chat.archive', 'archive-1', {
      type: 'chat.archive_tab',
      tabId: 'c1',
    });
    expect(effects.archived).toHaveBeenCalledTimes(1);
    expect(effects.archived).toHaveBeenCalledWith(
      { projectId, worktreeId, chatId: 'c1' },
      { archivedAt: '2026-11-05T10:00:00.000Z', keepSession: false },
    );
  });

  it('passes a kept session through and runs nothing after a refusal', async () => {
    snapshot = snapshotWith([], [archiveEntry('c1')]);
    await dispatch('core.chat.archive', 'archive-kept', {
      type: 'chat.archive_tab',
      tabId: 'c1',
      keepSession: true,
    });
    expect(effects.archived).toHaveBeenCalledWith(
      { projectId, worktreeId, chatId: 'c1' },
      { archivedAt: '2026-11-05T10:00:00.000Z', keepSession: true },
    );
    effects.archived.mockClear();
    getState.mockClear();
    outcome = 'rejected';
    await dispatch('core.chat.archive', 'archive-refused', {
      type: 'chat.archive_tab',
      tabId: 'c1',
    });
    expect(effects.archived).not.toHaveBeenCalled();
    expect(getState).not.toHaveBeenCalled();
  });

  it('runs bookkeeping for close-to-archive and skips discards', async () => {
    snapshot = snapshotWith([], [archiveEntry('c1'), archiveEntry('c2')]);
    await dispatch('core.chat.delete', 'close-many', {
      type: 'chat.close_tabs',
      targets: [
        { tabId: 'c1', mode: 'archive' },
        { tabId: 'c2', mode: 'discard' },
      ],
    });
    expect(effects.archived).toHaveBeenCalledTimes(1);
    expect(effects.archived).toHaveBeenCalledWith(
      { projectId, worktreeId, chatId: 'c1' },
      { archivedAt: '2026-11-05T10:00:00.000Z', keepSession: false },
    );
  });

  it('heals a replayed archive', async () => {
    snapshot = snapshotWith([], [archiveEntry('c1')]);
    outcome = 'already_applied';
    await dispatch('core.chat.archive', 'archive-replay', {
      type: 'chat.archive_tab',
      tabId: 'c1',
    });
    expect(effects.archived).toHaveBeenCalledTimes(1);
  });

  it('keeps a newer archive session when an older archive replays', async () => {
    snapshot = snapshotWith([], [archiveEntry('c1')]);
    await dispatch('core.chat.archive', 'archive-a', {
      type: 'chat.archive_tab',
      tabId: 'c1',
    });
    snapshot = snapshotWith([liveTab('c1')], []);
    await dispatch('core.chat.archive', 'restore-a', {
      type: 'chat.restore_archive',
      archiveEntryId: 'c1',
    });
    const newer = {
      ...archiveEntry('c1'),
      archivedAt: '2026-11-05T11:00:00.000Z',
    };
    snapshot = snapshotWith([], [newer]);
    await dispatch('core.chat.archive', 'archive-b', {
      type: 'chat.archive_tab',
      tabId: 'c1',
      keepSession: true,
    });
    effects.archived.mockClear();
    outcome = 'already_applied';
    await dispatch('core.chat.archive', 'archive-a', {
      type: 'chat.archive_tab',
      tabId: 'c1',
    });
    expect(effects.archived).toHaveBeenCalledTimes(1);
    expect(effects.archived).toHaveBeenCalledWith(
      { projectId, worktreeId, chatId: 'c1' },
      { archivedAt: newer.archivedAt, keepSession: true },
    );
  });

  it("leaves a newer archive alone when a restore and re-archive commit before the older archive's bookkeeping (CAN-5848)", async () => {
    const older = archiveEntry('c1');
    const newer = { ...older, archivedAt: '2026-11-05T11:00:00.000Z' };
    let olderReadStarted = (): void => undefined;
    const olderReading = new Promise<void>((resolve) => {
      olderReadStarted = resolve;
    });
    let releaseOlderRead = (): void => undefined;
    getState.mockImplementationOnce(
      () =>
        new Promise<ChatStateSnapshot>((resolve) => {
          releaseOlderRead = (): void => resolve(snapshot);
          olderReadStarted();
        }),
    );
    archivedAt = older.archivedAt;
    snapshot = snapshotWith([], [older]);
    const archiveA = dispatch('core.chat.archive', 'archive-a', {
      type: 'chat.archive_tab',
      tabId: 'c1',
    });
    await olderReading;

    archivedAt = undefined;
    snapshot = snapshotWith([liveTab('c1')], []);
    await dispatch('core.chat.archive', 'restore-a', {
      type: 'chat.restore_archive',
      archiveEntryId: 'c1',
    });
    archivedAt = newer.archivedAt;
    snapshot = snapshotWith([], [newer]);
    await dispatch('core.chat.archive', 'archive-b', {
      type: 'chat.archive_tab',
      tabId: 'c1',
      keepSession: true,
    });
    releaseOlderRead();
    await archiveA;

    expect(effects.archived).toHaveBeenCalledTimes(1);
    expect(effects.archived).toHaveBeenCalledWith(
      { projectId, worktreeId, chatId: 'c1' },
      { archivedAt: newer.archivedAt, keepSession: true },
    );
  });

  it('never fails the command when bookkeeping fails', async () => {
    snapshot = snapshotWith([], [archiveEntry('c1')]);
    effects.archived.mockRejectedValue(new Error('bookkeeping down'));
    await expect(
      dispatch('core.chat.archive', 'archive-failing', {
        type: 'chat.archive_tab',
        tabId: 'c1',
      }),
    ).resolves.toEqual({
      commandId: 'archive-failing',
      revision: 8,
      outcome: 'applied',
      entityId: 'c1',
    });
  });

  it('runs restore bookkeeping with the live tab', async () => {
    const tab = liveTab('c1');
    snapshot = snapshotWith([tab], []);
    await dispatch('core.chat.archive', 'restore-1', {
      type: 'chat.restore_archive',
      archiveEntryId: 'c1',
    });
    expect(effects.restored).toHaveBeenCalledWith(
      { projectId, worktreeId },
      tab,
    );
  });

  it('keys the Ledger handback by the archive time', async () => {
    const target = { projectId: 'p', worktreeId: 'w', chatId: 'c1' };
    const notify = jest.mocked(notifyLedgerSessionEnded);
    const search = mockSearch;
    notify.mockResolvedValue('recorded');
    await recordChatArchived(target, 't1');
    expect(notify).toHaveBeenCalledWith({
      target: { projectId: 'p', worktreeId: 'w' },
      actor: { kind: 'chat', originKey: 'c1' },
      recipient: { kind: 'user' },
      reason: 'chat_archived',
      transitionKey: 'chat-archive:p:w:c1:t1',
      transitionAt: 't1',
    });
    expect(search.worktreeChatArchived).toHaveBeenCalledWith('p', 'w', 'c1');

    search.worktreeChatArchived.mockClear();
    notify.mockRejectedValue(new Error('ledger down'));
    await expect(recordChatArchived(target, 't1')).resolves.toBeUndefined();
    expect(search.worktreeChatArchived).toHaveBeenCalledWith('p', 'w', 'c1');
  });
});
