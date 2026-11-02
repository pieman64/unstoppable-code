/* eslint-disable @typescript-eslint/explicit-function-return-type, @typescript-eslint/require-await */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  ChatCommand,
  ChatCommandEnvelope,
} from '@canopy/desktop-shared/types';
import {
  initModelAliases,
  initModelHarnessAssignments,
  initOllamaModels,
} from '@canopy/desktop-shared/types';
import type { ActivityLiveBgTask } from '@canopy/desktop-shared/types/activity-panel';
import { ChatStateV2Repository } from '../chat-state-v2-repository';
import { ChatStateService } from '../chat-state-service';
import * as sessionManager from '../../agents/session-manager';
import { setDelegationActivity } from '../../agents/delegation/activity';
import type { ChatStateServiceOptions } from '../chat-state-service';

const SCOPE = { projectId: 'workspace-close', worktreeId: 'worktree-close' };
const CHAT_ID = 'chat-close';
const SESSION_KEY = `${SCOPE.projectId}/${SCOPE.worktreeId}/${CHAT_ID}`;
const BACKGROUND_REFUSAL =
  'Background agents or workflows are still running in this chat. Stop them first.';
const ACTIVE_WORK_REFUSAL =
  'The chat cannot be closed while it has active, queued, or pending plan work';

function envelope<T extends ChatCommand>(
  commandId: string,
  command: T,
): ChatCommandEnvelope<T> {
  return { schemaVersion: 1, commandId, ...SCOPE, command };
}

function backgroundTask(taskType?: string): ActivityLiveBgTask {
  return {
    taskId: `${taskType ?? 'legacy-task'}-1`,
    ...(taskType === undefined ? {} : { taskType }),
    status: 'running',
  };
}

describe('ChatStateService close blocking', () => {
  let tempDir: string;
  let repository: ChatStateV2Repository;
  let target: ChatStateService;
  let tasksForChat: jest.SpyInstance;

  beforeEach(() => {
    initModelAliases({});
    initOllamaModels([]);
    initModelHarnessAssignments({ revision: 0, assignments: [] });
    tempDir = mkdtempSync(join(tmpdir(), 'canopy-chat-close-blocking-'));
    const storagePaths = {
      tabs: join(tempDir, 'chats.json'),
      archives: join(tempDir, 'archives.json'),
      journal: join(tempDir, 'journal.jsonl'),
    };
    repository = new ChatStateV2Repository({
      resolvePaths: () => storagePaths,
    });
    tasksForChat = jest
      .spyOn(sessionManager, 'getLiveBackgroundTasksForChat')
      .mockReturnValue(undefined);
    target = createService();
  });

  afterEach(async () => {
    setDelegationActivity('close-blocking-test', SESSION_KEY, 0);
    tasksForChat.mockRestore();
    await repository.drainAll();
    rmSync(tempDir, { recursive: true, force: true });
  });

  function createService(
    overrides: Partial<ChatStateServiceOptions> = {},
  ): ChatStateService {
    return new ChatStateService({
      repository,
      now: () => 1_786_104_000_000,
      createId: () => 'close-blocking-event',
      dispatch: async () => undefined,
      onInputPickup: async () => undefined,
      authorizeSend: async () => undefined,
      cleanupSession: async () => undefined,
      recordDiagnostic: () => undefined,
      ...overrides,
    });
  }

  async function createChat(chatId = CHAT_ID): Promise<void> {
    await expect(
      target.command(
        envelope(`create-${chatId}`, {
          type: 'chat.create_tab',
          tabId: chatId,
          title: 'Close blocking',
          providerType: 'claude',
          model: 'claude-opus-4-6',
        }),
      ),
    ).resolves.toMatchObject({ outcome: 'applied' });
  }

  async function closeChat(kind: 'single' | 'bulk', commandId: string) {
    const command: ChatCommand =
      kind === 'single'
        ? { type: 'chat.close_tab', tabId: CHAT_ID, mode: 'archive' }
        : {
            type: 'chat.close_tabs',
            targets: [{ tabId: CHAT_ID, mode: 'archive' }],
          };
    return target.command(envelope(commandId, command));
  }

  it.each([
    ['single', 'local_agent'],
    ['single', 'local_workflow'],
    ['bulk', 'local_agent'],
    ['bulk', 'local_workflow'],
  ] as const)(
    'blocks %s close when a %s task is live using the production default',
    async (kind, taskType) => {
      await createChat();
      tasksForChat.mockReturnValue([backgroundTask(taskType)]);

      await expect(
        closeChat(kind, `close-${kind}-${taskType}`),
      ).resolves.toMatchObject({
        outcome: 'rejected',
        reason: BACKGROUND_REFUSAL,
      });
      expect((await target.getState(SCOPE)).tabsFile.tabs).toHaveLength(1);
    },
  );

  it('checks provider liveness inside the single-close transaction', async () => {
    await createChat();
    const transactWith = repository.transactWith.bind(repository);
    jest
      .spyOn(repository, 'transactWith')
      .mockImplementation(async (scope, build, options) => {
        // Simulate background work starting after the command began but before
        // the transaction's synchronous state builder runs.
        tasksForChat.mockReturnValue([backgroundTask('local_agent')]);
        return transactWith(scope, build, options);
      });

    await expect(
      closeChat('single', 'close-racing-background'),
    ).resolves.toMatchObject({
      outcome: 'rejected',
      reason: BACKGROUND_REFUSAL,
    });
    expect((await target.getState(SCOPE)).tabsFile.tabs).toHaveLength(1);
  });

  it('keeps bulk close all-or-nothing when a later target has blocking work', async () => {
    const secondChatId = 'chat-second';
    await createChat();
    await createChat(secondChatId);
    tasksForChat.mockImplementation((_projectId, _worktreeId, chatId) =>
      chatId === secondChatId ? [backgroundTask('local_workflow')] : undefined,
    );

    await expect(
      target.command(
        envelope('close-bulk-with-blocked-target', {
          type: 'chat.close_tabs',
          targets: [
            { tabId: CHAT_ID, mode: 'archive' },
            { tabId: secondChatId, mode: 'archive' },
          ],
        }),
      ),
    ).resolves.toMatchObject({
      outcome: 'rejected',
      reason: BACKGROUND_REFUSAL,
      entityId: secondChatId,
    });
    expect(
      (await target.getState(SCOPE)).tabsFile.tabs.map((tab) => tab.id),
    ).toEqual([CHAT_ID, secondChatId]);
  });

  it.each([
    ['single', 'local_bash'],
    ['single', 'mcp_task'],
    ['single', undefined],
    ['bulk', 'local_bash'],
    ['bulk', 'mcp_task'],
    ['bulk', undefined],
  ] as const)(
    'allows %s close when only a nonblocking task with type %s is live',
    async (kind, taskType) => {
      await createChat();
      tasksForChat.mockReturnValue([backgroundTask(taskType)]);

      await expect(
        closeChat(kind, `close-shell-${kind}`),
      ).resolves.toMatchObject({
        outcome: 'applied',
      });
      expect((await target.getState(SCOPE)).tabsFile.tabs).toHaveLength(0);
    },
  );

  it.each(['single', 'bulk'] as const)(
    'loads the default close checker under fake timers for %s close',
    async (kind) => {
      await createChat();
      tasksForChat.mockReturnValue([backgroundTask('local_agent')]);
      jest.useFakeTimers();

      try {
        await expect(
          closeChat(kind, `close-fake-timers-${kind}`),
        ).resolves.toMatchObject({
          outcome: 'rejected',
          reason: BACKGROUND_REFUSAL,
        });
      } finally {
        jest.useRealTimers();
      }
    },
  );

  it.each(['single', 'bulk'] as const)(
    'uses the background refusal when %s close sees provider and foreground work',
    async (kind) => {
      await createChat();
      await target.command(
        envelope('start-foreground-work', {
          type: 'chat.send_message',
          chatId: CHAT_ID,
          userMessageId: 'foreground-turn',
          text: 'Keep working',
        }),
      );
      tasksForChat.mockReturnValue([backgroundTask('local_agent')]);

      await expect(
        closeChat(kind, `close-provider-and-foreground-${kind}`),
      ).resolves.toMatchObject({
        outcome: 'rejected',
        reason: BACKGROUND_REFUSAL,
      });
      expect((await target.getState(SCOPE)).tabsFile.tabs).toHaveLength(1);
    },
  );

  it.each(['single', 'bulk'] as const)(
    'keeps delegate rejection priority and the existing generic reason for %s close',
    async (kind) => {
      await createChat();
      tasksForChat.mockReturnValue([backgroundTask('local_agent')]);
      setDelegationActivity('close-blocking-test', SESSION_KEY, 1);

      await expect(
        closeChat(kind, `close-delegate-${kind}`),
      ).resolves.toMatchObject({
        outcome: 'rejected',
        reason: ACTIVE_WORK_REFUSAL,
      });
      expect((await target.getState(SCOPE)).tabsFile.tabs).toHaveLength(1);
    },
  );

  it.each(['single', 'bulk'] as const)(
    'honors an injected close-block reason for %s close',
    async (kind) => {
      await createChat();
      const closeBlockReason = jest.fn(() => 'background' as const);
      target = createService({ chatCloseBlockReason: closeBlockReason });

      await expect(
        closeChat(kind, `close-injected-${kind}`),
      ).resolves.toMatchObject({
        outcome: 'rejected',
        reason: BACKGROUND_REFUSAL,
      });
      expect(closeBlockReason).toHaveBeenCalledWith(
        SCOPE.projectId,
        SCOPE.worktreeId,
        CHAT_ID,
      );
      expect((await target.getState(SCOPE)).tabsFile.tabs).toHaveLength(1);
    },
  );
});
