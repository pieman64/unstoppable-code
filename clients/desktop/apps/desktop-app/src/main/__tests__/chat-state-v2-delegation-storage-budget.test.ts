import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import type { PersistedChatMessage } from '@canopy/agent-transcript';
import type { AgentDelegationTranscript } from '@canopy/protocol/delegation';
import type { ChatTurnLifecycleEvent } from '@canopy/protocol/canopy-core';
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
  type WorkCountersSnapshot,
} from '@canopy/desktop-shared/node/work-counters';
import { ChatStorageV2 } from '../lib/chat-storage-v2';
import {
  ChatQueueService,
  getChatQueueService,
} from '../services/chat-queue-service';
import type * as ChatQueueServiceModule from '../services/chat-queue-service';
import {
  ChatStateService,
  resetChatStateServiceForTests,
} from '../services/chat-state-service';
import { ChatTurnStateHandoff } from '../services/chat-turn-state-handoff';
import { getChatTurnOwnership } from '../services/chat-turn-ownership';
import { ChatStateV2Repository } from '../services/chat-state-v2-repository';

jest.mock('../observability', () => ({
  getObservabilityService: (): { observeSteeringInput: jest.Mock } => ({
    observeSteeringInput: jest.fn(),
  }),
}));
jest.mock('../services/chat-queue-service', () => {
  const actual = jest.requireActual<typeof ChatQueueServiceModule>(
    '../services/chat-queue-service',
  );
  return { ...actual, getChatQueueService: jest.fn() };
});
jest.mock('../integration/claude-terminal-session-service', () => ({
  getClaudeTerminalSessionService: (): { getState: () => undefined } => ({
    getState: (): undefined => undefined,
  }),
}));
jest.mock('../lib/usage-limited-chats-registry', () => ({
  recordInterruptedChats: jest.fn(() => Promise.resolve()),
}));
jest.mock('../lib/model-policy-state', () => ({
  isModelBlockedByStoredPolicy: jest.fn(() => Promise.resolve(false)),
}));
jest.mock('../agents/claude-turn-lifecycle', () => ({
  requestBackgroundSnapshot: (): void => undefined,
}));

// Real fsync'd storage, but no provider, Electron, timers or host data writers.
jest.setTimeout(120_000);
const SCOPE = { projectId: 'workspace-1', worktreeId: 'worktree-1' };
const CHAT_ID = 'chat-1';
const PARENT_TURN_ID = 'delegating-user';
const TOOL_ROW_ID = 'delegate-tool-row';
const TOOL_CALL_ID = 'delegate-call';
const REPLY_ID = 'parent-final-reply';
const NOW = 1_786_104_000_000;
const RUNS = 6;
const K = 8;
const CHILD_BYTES = 2048;

/** The parent turn's canonical start and end, as the Claude adapter reports them. */
function parentLifecycle(
  sequence: number,
  type: 'TurnStarted' | 'TurnEnded',
): ChatTurnLifecycleEvent {
  const shared = {
    version: 1 as const,
    provider: 'claude' as const,
    ...SCOPE,
    chatId: CHAT_ID,
    sequence,
    eventId: `parent-${type}-${sequence}`,
    turnId: 'parent-turn',
    origin: 'user' as const,
    binding: 'bound' as const,
    submissionIds: [],
    userMessageIds: [PARENT_TURN_ID],
    providerUserMessageUuids: [],
  };
  return type === 'TurnStarted'
    ? { ...shared, observedAtMs: NOW, type, phase: 'start', startedAtMs: NOW }
    : {
        ...shared,
        observedAtMs: NOW,
        type,
        endedAtMs: NOW,
        outcome: 'completed',
        source: 'result',
      };
}

async function flushTurnState(service: ChatStateService): Promise<void> {
  const handoff: unknown = Reflect.get(service, 'turnHandoff');
  if (!(handoff instanceof ChatTurnStateHandoff))
    throw new Error('Chat state service did not create its turn handoff');
  await handoff.flushAll();
}

function envelope<T extends ChatCommand>(
  commandId: string,
  command: T,
): ChatCommandEnvelope<T> {
  return { schemaVersion: 1, commandId, ...SCOPE, command };
}

function delegationSnapshot(
  run: number,
  progress: number,
  completed = false,
): AgentDelegationTranscript {
  const delegationId = `run-${run}`;
  return {
    delegationId,
    runGeneration: 1,
    sequence: progress + 1 + (completed ? 1 : 0),
    parentHarnessId: 'claude',
    parentTurnId: PARENT_TURN_ID,
    parentToolCallId: TOOL_CALL_ID,
    createdAt: NOW + run,
    task: {
      description: `Independent review ${run}`,
      prompt: 'Read the deterministic fixture',
      executionMode: 'background',
    },
    snapshot: {
      delegationId,
      status: completed ? 'completed' : 'running',
      outputTruncated: false,
      nativeSessionId: `child-native-${run}`,
      routeSnapshot: {
        selectedModelId: 'claude-opus-4-6',
        runtimeModelId: 'claude-opus-4-6',
        harnessId: 'claude',
        runtimeKind: 'local',
        runnerRegistrationId: 'claude-local',
        runtimeVersion: '1',
        adapterVersion: '1',
        modelSource: 'catalog',
        providerType: 'claude',
        assignmentRevision: 'test-assignment',
        billingAuthority: 'local',
        aiCreditsRouted: false,
        capabilities: [],
        supportedThinkingLevels: [],
        capabilitySnapshotHash: 'test-capabilities',
        capabilityGeneration: 1,
        policyRevision: 'test-policy',
      },
    },
    transcript: Array.from({ length: progress + 1 }, (_, item) => ({
      id: `text-${item}`,
      type: 'text',
      text: `Run ${run}, item ${item}: `.padEnd(CHILD_BYTES, 'x'),
      sequence: item + 1,
      occurredAt: NOW + 100 + item,
    })),
  };
}

function storageWork(
  before: WorkCountersSnapshot,
  after: WorkCountersSnapshot,
): {
  W: number;
  commits: number;
  transcriptBytes: number;
  perClass: Record<string, number>;
} {
  const perClass: Record<string, number> = {};
  for (const key of Object.keys({
    ...before.chatStorage,
    ...after.chatStorage,
  })) {
    if (/^written\.[^.]+\.bytes$/.test(key)) {
      perClass[key] =
        (after.chatStorage[key] ?? 0) - (before.chatStorage[key] ?? 0);
    }
  }
  return {
    W: Object.values(perClass).reduce((sum, bytes) => sum + bytes, 0),
    commits:
      (after.chatStorage.commits ?? 0) - (before.chatStorage.commits ?? 0),
    transcriptBytes: perClass['written.transcript.bytes'] ?? 0,
    perClass,
  };
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function committedRows(bytes: Buffer): Record<string, unknown>[] {
  return bytes
    .toString('utf8')
    .trimEnd()
    .split('\n')
    .map((line) => {
      const row: unknown = JSON.parse(line);
      if (!isRecord(row) || typeof row.id !== 'string') {
        throw new Error('Expected a committed message JSONL row');
      }
      return row;
    });
}

// Inline (unlogged) child transcripts under an active parent turn. The settled
// parent case asserted the anchored active-sidecar routing that the develop
// integration (D4) dropped: production runs use the chat delegate log.
describe('delegation live-window storage-byte budget', () => {
  it('active parent', async () => {
    initModelAliases({});
    initOllamaModels([]);
    initModelHarnessAssignments({ revision: 0, assignments: [] });
    jest.mocked(getChatQueueService).mockReturnValue(new ChatQueueService());
    resetWorkCounters();
    const directory = mkdtempSync(join(tmpdir(), 'canopy-delegation-budget-'));
    const paths = {
      tabs: join(directory, 'chats.json'),
      archives: join(directory, 'archives.json'),
      journal: join(directory, 'journal.jsonl'),
    };
    let repositoryId = 0;
    const repository = new ChatStateV2Repository({
      resolvePaths: (): typeof paths => paths,
      now: (): number => NOW,
      createId: (): string => `repository-event-${++repositoryId}`,
    });
    let eventId = 0;
    const target = new ChatStateService({
      repository,
      now: (): number => NOW,
      createId: (): string => `event-${++eventId}`,
      dispatch: (): Promise<void> => Promise.resolve(),
      onInputPickup: (): Promise<void> => Promise.resolve(),
      authorizeSend: (): Promise<void> => Promise.resolve(),
      cleanupSession: (): Promise<void> => Promise.resolve(),
      recordDiagnostic: jest.fn(),
    });
    getChatTurnOwnership().resetScopesForTests();
    resetChatStateServiceForTests(target);
    const applied: boolean[] = [];
    const ingest = async (
      delegation: AgentDelegationTranscript,
    ): Promise<void> => {
      applied.push(
        await target.ingestProviderEvent({
          ...SCOPE,
          chatId: CHAT_ID,
          turnUserMessageId: PARENT_TURN_ID,
          mutationId: `${delegation.delegationId}-${delegation.sequence}`,
          data: { type: 'canopy_delegation', delegation },
        }),
      );
    };
    const completeParent = async (): Promise<void> => {
      applied.push(
        await target.ingestProviderEvent({
          ...SCOPE,
          chatId: CHAT_ID,
          turnUserMessageId: PARENT_TURN_ID,
          mutationId: 'parent-reply',
          data: {
            type: 'assistant',
            message: {
              id: REPLY_ID,
              role: 'assistant',
              content: [
                {
                  type: 'text',
                  text: 'Parent finished; reviews run independently.',
                },
              ],
            },
          },
        }),
      );
      // The adapter seals the turn when it receives the result, so the end
      // rides the result's own transaction.
      target.observeTurnLifecycle(parentLifecycle(2, 'TurnEnded'));
      applied.push(
        await target.ingestProviderEvent({
          ...SCOPE,
          chatId: CHAT_ID,
          turnUserMessageId: PARENT_TURN_ID,
          mutationId: 'parent-complete',
          data: { type: 'result', is_error: false, result: 'Parent done' },
        }),
      );
    };
    try {
      const created = await target.command(
        envelope('create-1', {
          type: 'chat.create_tab',
          tabId: CHAT_ID,
          title: 'Delegation storage budget',
          providerType: 'claude',
          model: 'claude-opus-4-6',
        }),
      );
      // 64 ordinary turns, ~1.6 MB, in one repository transaction: seed fsync
      // cost is constant rather than one commit per historical turn.
      const history: PersistedChatMessage[] = Array.from(
        { length: 64 },
        (_, turn) => [
          {
            id: `seed-user-${turn}`,
            role: 'user' as const,
            timestamp: NOW - 1000 + turn * 2,
            blocks: [
              { type: 'text' as const, text: `Ordinary question ${turn}` },
            ],
          },
          {
            id: `seed-assistant-${turn}`,
            role: 'assistant' as const,
            timestamp: NOW - 999 + turn * 2,
            blocks: [
              {
                type: 'text' as const,
                text: `Ordinary answer ${turn}: `.padEnd(24 * 1024, 's'),
              },
            ],
          },
        ],
      ).flat();
      await repository.transact(
        SCOPE,
        history.map((message) => ({
          type: 'message.upserted',
          chatId: CHAT_ID,
          message,
        })),
        { source: 'provider' },
      );
      const started = await target.command(
        envelope('send-delegation', {
          type: 'chat.send_message',
          chatId: CHAT_ID,
          userMessageId: PARENT_TURN_ID,
          text: 'Start six independent reviews',
        }),
      );
      // Canonical root turns: the parent runs from its lifecycle start.
      target.observeTurnLifecycle(parentLifecycle(1, 'TurnStarted'));
      await flushTurnState(target);
      applied.push(
        await target.ingestProviderEvent({
          ...SCOPE,
          chatId: CHAT_ID,
          turnUserMessageId: PARENT_TURN_ID,
          mutationId: 'delegate-tool',
          data: {
            type: 'assistant',
            message: {
              id: TOOL_ROW_ID,
              role: 'assistant',
              content: [
                {
                  type: 'tool_use',
                  id: TOOL_CALL_ID,
                  name: 'start_agents',
                  input: { count: RUNS },
                },
              ],
            },
          },
        }),
      );
      for (let run = 0; run < RUNS; run += 1)
        await ingest(delegationSnapshot(run, 0));
      const transcriptPath = join(
        ChatStorageV2.fromLegacyPaths(paths).directory,
        'transcripts',
        `${CHAT_ID}.jsonl`,
      );
      const beforeBytes = readFileSync(transcriptPath);
      const beforeHash = sha256(beforeBytes);
      const before = snapshotWorkCounters();
      const windowStart = performance.now();
      let E = 0;
      // Full cumulative snapshots, not patches. Round-robin exposes the cost
      // of rewriting all six resident runs on every single progress update.
      for (let progress = 1; progress <= K; progress += 1) {
        for (let run = 0; run < RUNS; run += 1) {
          const delegation = delegationSnapshot(run, progress);
          E += Buffer.byteLength(JSON.stringify(delegation), 'utf8');
          await ingest(delegation);
        }
      }
      const after = snapshotWorkCounters();
      const windowMs = performance.now() - windowStart;
      const afterBytes = readFileSync(transcriptPath);
      const afterHash = sha256(afterBytes);
      const { W, commits, transcriptBytes, perClass } = storageWork(
        before,
        after,
      );
      const ceiling = 16 * E + 65_536 * commits;

      // Materialization is deliberately outside the live-window budget.
      const materializationBefore = snapshotWorkCounters();
      for (let run = 0; run < RUNS; run += 1)
        await ingest(delegationSnapshot(run, K, true));
      const delegateSettlementTranscriptBytes = storageWork(
        materializationBefore,
        snapshotWorkCounters(),
      ).transcriptBytes;
      await completeParent();
      const materializationWork = storageWork(
        materializationBefore,
        snapshotWorkCounters(),
      );
      const finalBytes = readFileSync(transcriptPath);
      const appended = finalBytes
        .subarray(0, afterBytes.length)
        .equals(afterBytes);
      const materialization = {
        ...materializationWork,
        delegateSettlementTranscriptBytes,
        beforeBytes: afterBytes.length,
        afterBytes: finalBytes.length,
        grew: finalBytes.length > afterBytes.length,
        writeShape: appended ? 'append' : 'replacement',
        oldBytesArePrefix: appended,
      };
      // Log before ANY assertion, including fixture and materialization checks.
      // eslint-disable-next-line no-console
      console.log(
        JSON.stringify({
          E,
          W,
          ratio: W / E,
          commits,
          ceiling,
          perClass,
          windowMs,
          materialization,
        }),
      );
      expect(W).toBeLessThanOrEqual(ceiling);
      expect(afterBytes.length).toBe(beforeBytes.length);
      expect(afterHash).toBe(beforeHash);
      expect(transcriptBytes).toBe(0);

      expect(created.outcome).toBe('applied');
      expect(started.outcome).toBe('applied');
      expect(applied).toHaveLength(1 + RUNS + RUNS * K + RUNS + 2);
      expect(applied.every(Boolean)).toBe(true);
      expect(commits).toBe(RUNS * K);
      expect(beforeBytes.length).toBeGreaterThan(1_000_000);
      expect(beforeBytes.length).toBeLessThan(2_000_000);
      expect(materialization.W).toBeGreaterThan(0);
      expect(materialization.transcriptBytes).toBeGreaterThan(0);
      expect(materialization.grew).toBe(true);
      expect(materialization.writeShape).toBe('append');
      expect(materialization.commits).toBe(RUNS + 2);
      expect(delegateSettlementTranscriptBytes).toBe(0);
      // The whole parent's finished tail is written exactly once, not once
      // per finished delegate followed by a second parent-tail append.
      expect(materialization.transcriptBytes).toBe(
        finalBytes.length - afterBytes.length,
      );
      expect(materialization.perClass['written.appendStaging.bytes']).toBe(
        materialization.transcriptBytes,
      );

      const rows = committedRows(finalBytes);
      const ids = rows.map((row) => row.id);
      const toolIndex = ids.indexOf(TOOL_ROW_ID);
      const replyIndex = ids.indexOf(REPLY_ID);
      expect(toolIndex).toBeGreaterThanOrEqual(0);
      expect(replyIndex).toBeGreaterThan(toolIndex);
      for (let run = 0; run < RUNS; run += 1) {
        const cardId = `delegated-agent-run-${run}`;
        const cardIndex = ids.indexOf(cardId);
        expect(ids.filter((id) => id === cardId)).toHaveLength(1);
        expect(cardIndex).toBeGreaterThan(toolIndex);
        expect(rows[cardIndex]).toMatchObject({
          blocks: [{ type: 'delegated_agent_call', status: 'completed' }],
        });
        for (let item = 0; item <= K; item += 1) {
          const childId = `${cardId}:text-${item}`;
          expect(ids.filter((id) => id === childId)).toHaveLength(1);
          expect(ids[cardIndex + 1 + item]).toBe(childId);
          expect(rows[cardIndex + 1 + item]).toMatchObject({
            parentBlockId: cardId,
            delegationSequence: item + 1,
            blocks: [
              {
                type: 'text',
                text: `Run ${run}, item ${item}: `.padEnd(CHILD_BYTES, 'x'),
              },
            ],
          });
        }
        expect(cardIndex + 1 + K).toBeLessThan(replyIndex);
      }
    } finally {
      resetChatStateServiceForTests();
      await repository.drainAll();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
