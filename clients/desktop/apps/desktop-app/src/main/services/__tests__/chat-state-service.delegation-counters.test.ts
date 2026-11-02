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
import {
  resetWorkCounters,
  snapshotWorkCounters,
} from '@canopy/desktop-shared/node/work-counters';
import { ChatStateV2Repository as ChatStateRepository } from '../chat-state-v2-repository';
import { ChatStateService } from '../chat-state-service';

const SCOPE = { projectId: 'workspace-1', worktreeId: 'worktree-1' };

function envelope<T extends ChatCommand>(
  commandId: string,
  command: T,
): ChatCommandEnvelope<T> {
  return { schemaVersion: 1, commandId, ...SCOPE, command };
}

describe('ChatStateService delegation snapshot counters', () => {
  let tempDir: string;
  let repository: ChatStateRepository;
  let target: ChatStateService;

  beforeEach(() => {
    initModelAliases({});
    initOllamaModels([]);
    initModelHarnessAssignments({ revision: 0, assignments: [] });
    resetWorkCounters();
    tempDir = mkdtempSync(join(tmpdir(), 'canopy-delegation-counters-'));
    const storagePaths = {
      tabs: join(tempDir, 'chats.json'),
      archives: join(tempDir, 'archives.json'),
      journal: join(tempDir, 'journal.jsonl'),
    };
    repository = new ChatStateRepository({
      resolvePaths: () => storagePaths,
    });
    target = new ChatStateService({
      repository,
      now: () => 1_786_104_000_000,
      createId: () => 'event-id',
      dispatch: async () => undefined,
      onInputPickup: async () => undefined,
      authorizeSend: async () => undefined,
      cleanupSession: async () => undefined,
      recordDiagnostic: () => undefined,
    });
  });

  afterEach(async () => {
    await repository.drainAll();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('counts only applied delegation commits, not a duplicate event', async () => {
    await target.command(
      envelope('create-chat', {
        type: 'chat.create_tab',
        tabId: 'chat-1',
        title: 'Delegation counters',
        providerType: 'claude',
        model: 'claude-opus-4-6',
      }),
    );
    await target.command(
      envelope('send-parent-turn', {
        type: 'chat.send_message',
        chatId: 'chat-1',
        userMessageId: 'parent-turn',
        text: 'Review this change',
      }),
    );
    resetWorkCounters();

    const delegation = {
      delegationId: 'child-1',
      runGeneration: 1,
      sequence: 1,
      parentHarnessId: 'claude',
      parentTurnId: 'parent-turn',
      parentToolCallId: 'spawn-child',
      createdAt: 1_786_104_000_000,
      task: {
        description: 'Review',
        prompt: 'Review the change',
        executionMode: 'background',
      },
      transcript: [
        {
          id: 'child-item-1',
          sequence: 1,
          occurredAt: 1_786_104_000_000,
          type: 'text',
          text: 'The change looks good.',
        },
      ],
      snapshot: {
        delegationId: 'child-1',
        status: 'running',
        outputTruncated: false,
        partialText: 'The change looks good.',
      },
    };
    const input = {
      ...SCOPE,
      chatId: 'chat-1',
      turnUserMessageId: 'parent-turn',
      mutationId: 'delegation-snapshot-1',
      data: {
        type: 'canopy_delegation',
        delegation,
        canopy_turn_user_message_id: 'parent-turn',
      },
    };

    await expect(target.ingestProviderEventWithOutcome(input)).resolves.toBe(
      'applied',
    );
    await expect(target.ingestProviderEventWithOutcome(input)).resolves.toBe(
      'not-applied',
    );

    expect(snapshotWorkCounters().provider).toMatchObject({
      eventsIngested: 2,
      eventsApplied: 1,
      'delegationSnapshots.admitted': 1,
    });
    expect(snapshotWorkCounters().provider).not.toHaveProperty(
      'delegationSnapshots.admitted.bytes',
    );
  });
});
