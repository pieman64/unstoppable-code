import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  ChatInputDeliveryRow,
  ChatSendMessageRequest,
  ChatQueueUpdatedEvent,
  ChatRuntimeState,
  PersistedChatMessage,
  PersistedChatTab,
} from '@canopy/desktop-shared/types';
import {
  initialChatTurnState,
  reduceChatTurn,
} from '@canopy/agent-transcript/turn';
import type {
  ChatTurnLifecycleEvent,
  TurnEnded,
  TurnStarted,
} from '@canopy/protocol/canopy-core';
import type { QueuedMessageWaitingReason } from '@canopy/protocol/portal';
import {
  SHIPPED_PHASES,
  type InvariantContext,
  type InvariantId,
  type InvariantViolation,
  type PipelineChatTarget,
  type PipelineEffect,
  type PipelineTraceEvent,
  type ProviderTraceEvent,
  type RevisionTraceEvent,
  type CheckpointTraceEvent,
  type QueueTraceEvent,
  type TurnLifecycleTraceEvent,
} from './contracts';
import { INVARIANT_STAGING } from './invariant-staging';
import {
  checkDormantInvariants,
  checkInvariants,
  formatViolations,
  invariantActivation,
} from './invariants';
import { DORMANT_INVARIANT_FIXTURES } from './fixtures/dormant-invariants';

const target = {
  projectId: 'project-1',
  worktreeId: 'worktree-1',
  chatId: 'chat-1',
} satisfies PipelineChatTarget;
const otherTarget = {
  ...target,
  chatId: 'chat-2',
} satisfies PipelineChatTarget;

// Synthetic traces model the partial subclaims; the dormant fixtures and the
// scenario runs check the full turn-state claims.
const context: InvariantContext = {
  secrets: ['internal-watcher-payload'],
  deliveryBoundMs: 500,
  gateBoundMs: 500,
  absoluteTiming: false,
  fullTurnStateClaims: false,
};

function stamp(
  seq: number,
  logicalAt = seq,
): Pick<PipelineTraceEvent, 'seq' | 'at' | 'logicalAt'> {
  return { seq, at: seq, logicalAt };
}

function message(
  id: string,
  role: PersistedChatMessage['role'],
  blocks: PersistedChatMessage['blocks'],
  extra: Pick<
    PersistedChatMessage,
    'parentToolUseId' | 'parentBlockId' | 'userMessageSource' | 'watcherFired'
  > = {},
): PersistedChatMessage {
  return { id, role, blocks, timestamp: 1, ...extra };
}

function textMessage(
  id: string,
  role: PersistedChatMessage['role'],
  text: string,
): PersistedChatMessage {
  return message(id, role, [{ type: 'text', text }]);
}

function timerMessage(completedAt: number | null): PersistedChatMessage {
  return message('assistant-timer', 'assistant', [
    { type: 'turn_timer', completedAt },
  ]);
}

function toolUse(toolUseId: string, toolName = 'Agent'): PersistedChatMessage {
  return message('assistant-tool', 'assistant', [
    { type: 'tool_use', toolUseId, toolName, input: '{}' },
  ]);
}

function agentCardMessage(
  status: string,
  childStatus: string,
  secondBlockText?: string,
  changedAgentPath = false,
  completeOtherChild = false,
): PersistedChatMessage {
  const card: PersistedChatMessage['blocks'][number] = {
    type: 'codex_agent_call',
    agentBlockId: 'codex-agent-call',
    callId: 'call',
    tool: 'spawnAgent',
    status,
    senderThreadId: 'root-thread',
    receiverThreadIds: ['child-thread', 'other-child-thread'],
    prompt: 'Keep this prompt unchanged.',
    agentsStates: {
      'child-thread': { status: childStatus },
      'other-child-thread': {
        status: completeOtherChild ? 'completed' : 'running',
      },
    },
    receiverAgents: {
      'child-thread': {
        agentPath: changedAgentPath ? '/new/path' : '/original/path',
      },
    },
  };
  return message('codex-agent-call', 'assistant', [
    card,
    ...(secondBlockText === undefined
      ? []
      : [{ type: 'text' as const, text: secondBlockText }]),
  ]);
}

function agentCardAmendmentTrace(
  before: PersistedChatMessage,
  afterRows: readonly PersistedChatMessage[],
  childTerminals: readonly ProviderTraceEvent[],
  includePatch = true,
): PipelineTraceEvent[] {
  const sibling = textMessage('agent-card-sibling', 'assistant', 'same');
  return [
    revision(1, [before, sibling]),
    transcript(2, 100, 'before'),
    ...childTerminals,
    ...(includePatch
      ? [effect(4, { name: 'transcript-rewrite', reason: 'patch' })]
      : []),
    revision(5, afterRows),
    transcript(6, 150, 'after', {
      committedBytes: 100,
      sha256: 'before',
      prefixSha256: 'changed',
    }),
  ];
}

function runtime(
  status: ChatRuntimeState['status'],
  extra: Partial<ChatRuntimeState> = {},
): ChatRuntimeState {
  return { status, queuedMessageIds: [], ...extra };
}

function revision(
  seq: number,
  rows: readonly PersistedChatMessage[] | undefined,
  options: {
    runtime?: ChatRuntimeState;
    inputDelivery?: PersistedChatTab['inputDelivery'];
    logicalAt?: number;
    source?: RevisionTraceEvent['source'];
  } = {},
): RevisionTraceEvent {
  return {
    ...stamp(seq, options.logicalAt),
    kind: 'revision',
    projectId: target.projectId,
    worktreeId: target.worktreeId,
    revision: seq,
    baseRevision: seq - 1,
    source: options.source ?? 'provider',
    chats: {
      [target.chatId]: {
        runtime: options.runtime,
        rows,
        inputDelivery: options.inputDelivery,
      },
    },
  };
}

function provider(
  seq: number,
  direction: ProviderTraceEvent['direction'],
  type: string,
  options: {
    provider?: ProviderTraceEvent['provider'];
    turnKey?: string;
    ids?: ProviderTraceEvent['ids'];
    text?: string;
    commandCompletion?: ProviderTraceEvent['commandCompletion'];
    agentTerminal?: ProviderTraceEvent['agentTerminal'];
    logicalAt?: number;
  } = {},
): ProviderTraceEvent {
  return {
    ...stamp(seq, options.logicalAt),
    kind: 'provider',
    provider: options.provider ?? 'claude',
    target,
    direction,
    type,
    ...(options.turnKey !== undefined ? { turnKey: options.turnKey } : {}),
    ...(options.ids !== undefined ? { ids: options.ids } : {}),
    ...(options.text !== undefined ? { text: options.text } : {}),
    ...(options.commandCompletion
      ? { commandCompletion: options.commandCompletion }
      : {}),
    ...(options.agentTerminal ? { agentTerminal: options.agentTerminal } : {}),
  };
}

/** A lifecycle trace event for a turn start or end, the only kinds built here. */
type TurnTraceEvent = TurnLifecycleTraceEvent & {
  event: TurnStarted | TurnEnded;
};

function lifecycleTrace(
  scope: PipelineChatTarget,
  traceSequence: number,
  eventSequence: number,
  ended: boolean,
): TurnTraceEvent {
  const base = {
    version: 1 as const,
    provider: 'claude' as const,
    projectId: scope.projectId,
    worktreeId: scope.worktreeId,
    chatId: scope.chatId,
    processEpoch: 'replay-invariant-epoch',
    sequence: eventSequence,
    eventId: `${scope.chatId}-${eventSequence}`,
    observedAtMs: eventSequence * 10,
    turnId: `turn-${scope.chatId}`,
    origin: 'user' as const,
    binding: 'bound' as const,
    submissionIds: [`submission-${scope.chatId}`],
    userMessageIds: [`message-${scope.chatId}`],
    providerUserMessageUuids: [],
  };
  const event = ended
    ? {
        ...base,
        type: 'TurnEnded' as const,
        endedAtMs: eventSequence * 10,
        outcome: 'completed' as const,
        source: 'result' as const,
      }
    : {
        ...base,
        type: 'TurnStarted' as const,
        phase: 'start' as const,
        startedAtMs: eventSequence * 10,
      };
  return {
    ...stamp(traceSequence),
    kind: 'turn-lifecycle',
    target: scope,
    event,
  };
}

function effect(
  seq: number,
  value: PipelineEffect,
  logicalAt?: number,
): PipelineTraceEvent {
  return {
    ...stamp(seq, logicalAt),
    kind: 'effect',
    target,
    effect: value,
  };
}

function turnDiff(seq: number, scope = target): PipelineTraceEvent {
  return {
    ...stamp(seq),
    kind: 'effect',
    effect: {
      name: 'terminal-effect',
      effect: 'turn-diff',
      identity: `${scope.projectId}/${scope.worktreeId}/${scope.chatId}`,
    },
  };
}

/** A turn-diff capture naming the turn it ends, as production records it. */
function namedTurnDiff(
  seq: number,
  userMessageId: string,
  wakeTurnId?: string,
): PipelineTraceEvent {
  return {
    ...stamp(seq),
    kind: 'effect',
    effect: {
      name: 'terminal-effect',
      effect: 'turn-diff',
      identity: `${target.projectId}/${target.worktreeId}/${target.chatId}`,
      turn: {
        userMessageId,
        ...(wakeTurnId === undefined ? {} : { wakeTurnId }),
      },
    },
  };
}

function checkpoint(
  seq: number,
  label: string,
  extra: Omit<
    CheckpointTraceEvent,
    'seq' | 'at' | 'logicalAt' | 'kind' | 'label' | 'target'
  > & {
    logicalAt?: number;
    target?: PipelineChatTarget;
  } = {},
): CheckpointTraceEvent {
  return {
    ...stamp(seq, extra.logicalAt),
    kind: 'checkpoint',
    label,
    target: extra.target ?? target,
    ...(extra.liveness !== undefined ? { liveness: extra.liveness } : {}),
    ...(extra.sessionTurnActive !== undefined
      ? { sessionTurnActive: extra.sessionTurnActive }
      : {}),
    ...(extra.queueTurnActive !== undefined
      ? { queueTurnActive: extra.queueTurnActive }
      : {}),
    ...(extra.admissionBlocked !== undefined
      ? { admissionBlocked: extra.admissionBlocked }
      : {}),
    ...(extra.userInitiated !== undefined
      ? { userInitiated: extra.userInitiated }
      : {}),
  };
}

function queuedRow(
  id: string,
  text: string,
  options: {
    watcherFired?: NonNullable<
      ChatQueueUpdatedEvent['queue'][number]['watcherFired']
    >;
    waitingReason?: QueuedMessageWaitingReason;
  } = {},
): ChatQueueUpdatedEvent['queue'][number] {
  return {
    id,
    text,
    origin: 'desktop',
    enqueuedAtMs: 0,
    ...(options.watcherFired !== undefined
      ? { watcherFired: options.watcherFired }
      : {}),
    ...(options.waitingReason !== undefined
      ? { waitingReason: options.waitingReason }
      : {}),
  };
}

function queueEvent(
  seq: number,
  queue: ChatQueueUpdatedEvent['queue'],
  turnActive: boolean,
  logicalAt?: number,
): QueueTraceEvent {
  return {
    ...stamp(seq, logicalAt),
    kind: 'queue',
    event: { ...target, queue },
    turnActive,
  };
}

function transcript(
  seq: number,
  committedBytes: number,
  sha256: string,
  previous?: {
    committedBytes: number;
    sha256: string;
    prefixSha256: string;
  },
): PipelineTraceEvent {
  return {
    ...stamp(seq),
    kind: 'transcript',
    target,
    committedBytes,
    sha256,
    ...(previous !== undefined ? { previous } : {}),
  };
}

type InputLedger = NonNullable<PersistedChatTab['inputDelivery']>;
type InputRow = ChatInputDeliveryRow<ChatSendMessageRequest>;

function inputRow(
  state: InputRow['state'],
  extra: Partial<InputRow> = {},
  includeCurrentAttempt = true,
): InputRow {
  const row: InputRow = {
    id: 'delivery-1',
    revision: 1,
    createdAt: 1,
    state,
    text: 'follow-up',
    payload: {
      ...target,
      userMessageId: 'generated-user-1',
      text: 'follow-up',
      watcherFired: { kind: 'build' },
    },
    settingsKey: 'settings-v1',
    attempts: [
      {
        id: 'attempt-1',
        generation: 'generation-1',
        provider: 'claude',
        createdAt: 1,
        admittedAt: 2,
      },
    ],
    currentAttemptId: 'attempt-1',
    ...extra,
  };
  if (!includeCurrentAttempt) delete row.currentAttemptId;
  return row;
}

function inputLedger(...rows: InputRow[]): InputLedger {
  return { version: 1, epoch: 1, rows };
}

interface InvariantCase {
  id: InvariantId;
  passing: readonly PipelineTraceEvent[];
  failing: readonly PipelineTraceEvent[];
  failingSeqs: readonly number[];
}

const invariantCases: readonly InvariantCase[] = [
  {
    id: 1,
    passing: [revision(1, [timerMessage(50)]), revision(2, [timerMessage(50)])],
    failing: [revision(1, [timerMessage(50)]), revision(2, [timerMessage(60)])],
    failingSeqs: [1, 2],
  },
  {
    id: 5,
    passing: [
      effect(1, { name: 'native-task-live', taskId: 'task-1' }),
      effect(2, { name: 'wake-lock-acquire', holder: target.chatId }),
      effect(3, { name: 'native-task-ended', taskId: 'task-1' }),
      effect(4, { name: 'wake-lock-release', holder: target.chatId }),
    ],
    failing: [
      effect(1, { name: 'native-task-live', taskId: 'task-1' }),
      effect(2, { name: 'wake-lock-acquire', holder: target.chatId }),
      effect(3, { name: 'wake-lock-release', holder: target.chatId }),
    ],
    failingSeqs: [1, 3],
  },
  {
    id: 8,
    // A turn's capture may land before or after its end.
    passing: [
      turnEvent(1, 'turn-a', false),
      turnDiff(2),
      turnEvent(3, 'turn-a', 'result'),
      turnEvent(4, 'turn-b', false),
      turnEvent(5, 'turn-b', 'result'),
      turnDiff(6),
    ],
    failing: [
      turnEvent(1, 'turn-a', false),
      turnDiff(2),
      turnEvent(3, 'turn-a', 'result'),
      turnEvent(4, 'turn-b', false),
      turnEvent(5, 'turn-b', 'result'),
    ],
    failingSeqs: [4, 5],
  },
  {
    id: 9,
    passing: [
      revision(1, [
        toolUse('parent-call'),
        message(
          'child-agent',
          'assistant',
          [
            {
              type: 'tool_use',
              toolUseId: 'child-call',
              toolName: 'Read',
              input: '{}',
            },
          ],
          { parentToolUseId: 'parent-call' },
        ),
      ]),
      effect(2, {
        name: 'native-task-live',
        taskId: 'task-1',
        toolUseId: 'parent-call',
      }),
      provider(3, 'to-canopy', 'sdk:result'),
      revision(4, [
        toolUse('parent-call'),
        message(
          'child-agent',
          'assistant',
          [
            {
              type: 'tool_use',
              toolUseId: 'child-call',
              toolName: 'Read',
              input: '{}',
            },
            { type: 'text', text: 'child remains live' },
          ],
          { parentToolUseId: 'parent-call' },
        ),
      ]),
    ],
    failing: [
      revision(1, [
        toolUse('parent-call'),
        message(
          'child-agent',
          'assistant',
          [
            {
              type: 'tool_use',
              toolUseId: 'child-call',
              toolName: 'Read',
              input: '{}',
            },
          ],
          { parentToolUseId: 'parent-call' },
        ),
      ]),
      effect(2, {
        name: 'native-task-live',
        taskId: 'task-1',
        toolUseId: 'parent-call',
      }),
      provider(3, 'to-canopy', 'sdk:result'),
      revision(4, [
        toolUse('parent-call'),
        message(
          'child-agent',
          'assistant',
          [
            {
              type: 'tool_use',
              toolUseId: 'child-call',
              toolName: 'Read',
              input: '{}',
            },
          ],
          { parentToolUseId: 'parent-call' },
        ),
      ]),
      revision(5, [
        message(
          'child-result',
          'assistant',
          [
            {
              type: 'tool_result',
              toolUseId: 'child-call',
              toolName: 'Read',
              output: 'done',
              isError: false,
            },
          ],
          { parentToolUseId: 'parent-call' },
        ),
      ]),
    ],
    failingSeqs: [3, 4, 5],
  },
  {
    id: 11,
    passing: [
      revision(1, [textMessage('prompt-1', 'user', 'hello provider')], {
        source: 'renderer-command',
      }),
      provider(2, 'to-provider', 'prompt', { text: 'hello provider' }),
    ],
    failing: [
      provider(1, 'to-provider', 'prompt', { text: 'hello provider' }),
      revision(2, [textMessage('prompt-1', 'user', 'hello provider')], {
        source: 'renderer-command',
      }),
    ],
    failingSeqs: [2],
  },
  {
    id: 12,
    passing: [
      effect(1, { name: 'native-task-live', taskId: 'task-1' }),
      checkpoint(2, 'settings-changed', { userInitiated: false }),
      effect(3, { name: 'native-task-ended', taskId: 'task-1' }),
      effect(4, { name: 'session-destroyed', sessionKey: 'session-1' }),
    ],
    failing: [
      effect(1, { name: 'native-task-live', taskId: 'task-1' }),
      checkpoint(2, 'settings-changed', { userInitiated: false }),
      effect(3, { name: 'session-destroyed', sessionKey: 'session-1' }),
      effect(4, { name: 'native-task-ended', taskId: 'task-1' }),
    ],
    failingSeqs: [1, 3],
  },
  {
    id: 13,
    passing: [
      queueEvent(
        1,
        [
          queuedRow('delivery-1', 'watcher follow-up', {
            watcherFired: { kind: 'build' },
            waitingReason: 'steer_unavailable',
          }),
        ],
        true,
      ),
    ],
    failing: [
      queueEvent(
        1,
        [
          queuedRow('delivery-1', 'watcher follow-up', {
            watcherFired: { kind: 'build' },
          }),
        ],
        true,
      ),
    ],
    failingSeqs: [1],
  },
  {
    id: 14,
    passing: [provider(1, 'to-provider', 'prompt', { text: 'public prompt' })],
    failing: [
      provider(1, 'to-provider', 'prompt', {
        text: 'internal-watcher-payload',
      }),
    ],
    failingSeqs: [1],
  },
  {
    id: 15,
    passing: [
      checkpoint(1, 'drained', {
        logicalAt: 0,
        liveness: { foreground: false, background: false },
        queueTurnActive: true,
      }),
      checkpoint(2, 'gate-released', {
        logicalAt: 100,
        liveness: { foreground: false, background: false },
        queueTurnActive: false,
      }),
    ],
    failing: [
      checkpoint(1, 'drained', {
        logicalAt: 0,
        liveness: { foreground: false, background: false },
        queueTurnActive: true,
      }),
      checkpoint(2, 'deadline', {
        logicalAt: 501,
        liveness: { foreground: false, background: false },
        queueTurnActive: true,
      }),
    ],
    failingSeqs: [1, 2],
  },
  {
    id: 16,
    passing: [
      effect(1, { name: 'commits-held' }),
      provider(2, 'to-provider', 'steer', { text: 'continue' }),
      effect(3, {
        name: 'steer-settled',
        text: 'continue',
        outcome: 'accepted',
      }),
      effect(4, { name: 'commits-released' }),
    ],
    failing: [
      effect(1, { name: 'commits-held' }),
      provider(2, 'to-provider', 'steer', { text: 'continue' }),
      effect(3, { name: 'commits-released' }),
      effect(4, {
        name: 'steer-settled',
        text: 'continue',
        outcome: 'accepted',
      }),
    ],
    failingSeqs: [1, 2, 3, 4],
  },
  {
    id: 17,
    passing: [
      transcript(1, 100, 'a'.repeat(64)),
      revision(2, [textMessage('assistant-1', 'assistant', 'first stream')]),
      revision(3, [
        textMessage('assistant-1', 'assistant', 'continued stream'),
      ]),
      transcript(4, 100, 'a'.repeat(64), {
        committedBytes: 100,
        sha256: 'a'.repeat(64),
        prefixSha256: 'a'.repeat(64),
      }),
    ],
    failing: [
      transcript(1, 100, 'a'.repeat(64)),
      revision(2, [
        textMessage('assistant-1', 'assistant', 'continued stream'),
      ]),
      transcript(3, 120, 'b'.repeat(64), {
        committedBytes: 100,
        sha256: 'a'.repeat(64),
        prefixSha256: 'b'.repeat(64),
      }),
    ],
    failingSeqs: [1, 3],
  },
  {
    id: 18,
    passing: [
      provider(1, 'to-canopy', 'request:dynamicToolCall', {
        provider: 'codex',
        turnKey: 'turn-1',
        ids: { callId: 'call-1' },
      }),
      effect(2, {
        name: 'tool-side-effect',
        callId: 'call-1',
        effect: 'read-file',
      }),
      provider(3, 'to-canopy', 'notification:serverRequest/resolved', {
        provider: 'codex',
        turnKey: 'turn-1',
        ids: { callId: 'call-1' },
      }),
    ],
    failing: [
      provider(1, 'to-canopy', 'request:dynamicToolCall', {
        provider: 'codex',
        turnKey: 'turn-1',
        ids: { callId: 'call-1' },
      }),
      provider(2, 'to-canopy', 'notification:serverRequest/resolved', {
        provider: 'codex',
        turnKey: 'turn-1',
        ids: { callId: 'call-1' },
      }),
      effect(3, {
        name: 'tool-side-effect',
        callId: 'call-1',
        effect: 'read-file',
      }),
    ],
    failingSeqs: [2, 3],
  },
  {
    id: 19,
    passing: [
      provider(1, 'to-canopy', 'sdk:assistant', { turnKey: 'turn-1' }),
      checkpoint(2, 'turn-active', { sessionTurnActive: true }),
      provider(3, 'to-canopy', 'sdk:result', { turnKey: 'turn-1' }),
    ],
    failing: [
      provider(1, 'to-canopy', 'sdk:assistant', { turnKey: 'turn-1' }),
      checkpoint(2, 'turn-active', { sessionTurnActive: false }),
      provider(3, 'to-canopy', 'sdk:result', { turnKey: 'turn-1' }),
    ],
    failingSeqs: [1, 2],
  },
  {
    id: 20,
    passing: [
      effect(1, {
        name: 'watcher-registered',
        callId: 'call-1',
        naturalKey: 'project/worktree/chat/name',
        watcherId: 'watcher-1',
        created: true,
      }),
      effect(2, {
        name: 'watcher-registered',
        callId: 'call-2',
        naturalKey: 'project/worktree/chat/name',
        watcherId: 'watcher-1',
        created: false,
      }),
    ],
    failing: [
      effect(1, {
        name: 'watcher-registered',
        callId: 'call-1',
        naturalKey: 'project/worktree/chat/name',
        watcherId: 'watcher-1',
        created: true,
      }),
      effect(2, {
        name: 'watcher-registered',
        callId: 'call-2',
        naturalKey: 'project/worktree/chat/name',
        watcherId: 'watcher-2',
        created: true,
      }),
    ],
    failingSeqs: [1, 2],
  },
  {
    id: 21,
    passing: [
      revision(1, undefined, {
        inputDelivery: inputLedger(inputRow('pending')),
      }),
    ],
    failing: [
      revision(1, undefined, {
        inputDelivery: inputLedger(inputRow('pending')),
      }),
      revision(2, undefined, {
        inputDelivery: inputLedger(
          inputRow('uncertain', {
            revision: 2,
            attempts: [
              {
                id: 'attempt-1',
                generation: 'generation-1',
                provider: 'claude',
                createdAt: 1,
                admittedAt: 2,
                uncertainAt: 501,
              },
            ],
          }),
        ),
      }),
    ],
    failingSeqs: [1, 2],
  },
];

function expectPositiveActivation(
  id: InvariantId,
  trace: readonly PipelineTraceEvent[],
): void {
  expect(invariantActivation(trace)[id]).toBeGreaterThan(0);
}

function expectOneViolation(
  id: InvariantId,
  passing: readonly PipelineTraceEvent[],
  failing: readonly PipelineTraceEvent[],
  failingSeqs: readonly number[],
  checkContext: InvariantContext = context,
): void {
  expectPositiveActivation(id, passing);
  expect(checkInvariants(passing, checkContext)).toEqual([]);

  expectPositiveActivation(id, failing);
  const violations = checkInvariants(failing, checkContext);
  expect(violations).toHaveLength(1);
  const violation = violations[0];
  expect(violation?.id).toBe(id);
  expect(violation?.seqs).toEqual(failingSeqs);

  const formatted = formatViolations(violations, failing);
  expect(formatted).toContain(`Invariant ${id}:`);
  for (const seq of failingSeqs) expect(formatted).toContain(`seq=${seq}`);
}

function phaseRowsFromPlan(): Array<{ phase: string; status: string }> {
  const readme = readFileSync(
    join(
      __dirname,
      '../../../../../../docs/planning/2026-10-08-turn-state-remediation/README.md',
    ),
    'utf8',
  );
  return readme.split('\n').flatMap((line) => {
    if (!/^\|\s*\d/.test(line)) return [];
    const columns = line.split('|').map((column) => column.trim());
    const phase = columns[1];
    const status = columns[3];
    return phase && status ? [{ phase, status }] : [];
  });
}

function shippedPhasesFromPlan(): string[] {
  return phaseRowsFromPlan()
    .filter((row) => row.status === 'shipped')
    .map((row) => row.phase);
}

describe('pipeline invariant staging', () => {
  it('checks invariant 7 by replaying the same reducer stream once and twice', () => {
    const producer = {
      version: 1 as const,
      provider: 'claude' as const,
      projectId: target.projectId,
      worktreeId: target.worktreeId,
      chatId: target.chatId,
      processEpoch: 'epoch-1',
      providerSessionId: 'session-1',
    };
    const stream: ChatTurnLifecycleEvent[] = [
      {
        ...producer,
        sequence: 1,
        eventId: 'turn-started-1',
        observedAtMs: 10,
        type: 'TurnStarted',
        phase: 'start',
        turnId: 'turn-1',
        origin: 'user',
        binding: 'bound',
        submissionIds: ['submission-1'],
        userMessageIds: ['user-message-1'],
        providerUserMessageUuids: [],
        startedAtMs: 10,
      },
      {
        ...producer,
        sequence: 2,
        eventId: 'turn-ended-1',
        observedAtMs: 20,
        type: 'TurnEnded',
        turnId: 'turn-1',
        origin: 'user',
        binding: 'bound',
        submissionIds: ['submission-1'],
        userMessageIds: ['user-message-1'],
        providerUserMessageUuids: [],
        endedAtMs: 20,
        outcome: 'completed',
        source: 'result',
      },
    ];

    let state = initialChatTurnState();
    const firstPassEffects = stream.flatMap((event) => {
      const reduced = reduceChatTurn(state, event);
      state = reduced.state;
      return reduced.effects;
    });
    const settled = state;
    const replayEffects = stream.flatMap((event) => {
      const reduced = reduceChatTurn(state, event);
      expect(reduced.state).toBe(state);
      state = reduced.state;
      return reduced.effects;
    });

    expect(INVARIANT_STAGING[7].status).toBe('enabled');
    expect(firstPassEffects.map((effect) => effect.type)).toEqual([
      'timer.open',
      'timer.close',
      'turn.ended',
      'chat.idle',
    ]);
    expect(replayEffects).toEqual([]);
    expect(state).toBe(settled);
  });

  it('pins the agreed enabled, partial, deferred and external claims', () => {
    const idsWithStatus = (status: string): number[] =>
      Object.entries(INVARIANT_STAGING)
        .filter(([, entry]) => entry.status === status)
        .map(([id]) => Number(id));
    expect(idsWithStatus('enabled')).toEqual([
      1, 2, 3, 4, 5, 6, 7, 9, 12, 13, 15, 17, 18, 19, 20, 21,
    ]);
    expect(idsWithStatus('partial')).toEqual([8, 11, 14, 16]);
    expect(idsWithStatus('deferred')).toEqual([]);
    expect(idsWithStatus('external')).toEqual([10]);
    // Phase 43 ships with nothing left to enable them: the rest of each
    // staged claim runs in Electron and web flows or opt-in real-time runs.
    expect(
      Object.entries(INVARIANT_STAGING)
        .filter(([, entry]) => entry.coveredBy)
        .map(([id]) => Number(id)),
    ).toEqual([8, 10, 11, 14, 16]);
  });

  it('enables replay idempotence in phase 34 and reducer-window equality with its paired run in 43h', () => {
    expect(INVARIANT_STAGING[7]).toMatchObject({
      status: 'enabled',
      introducedBy: ['34'],
      reason: '',
      subclaims: [],
    });
    expect(INVARIANT_STAGING[6]).toMatchObject({
      status: 'enabled',
      introducedBy: ['16', '43h'],
      reason: '',
      subclaims: [],
    });
  });

  it('includes staging reasons in diagnostics even without violations', () => {
    const formatted = formatViolations([], []);
    for (const status of ['enabled', 'partial', 'deferred', 'external'])
      expect(formatted).toContain(`${status}:`);
    for (const entry of Object.values(INVARIANT_STAGING))
      if (entry.reason) expect(formatted).toContain(entry.reason);
  });

  it('contains exactly the audited invariant ids 1–21', () => {
    expect(
      Object.keys(INVARIANT_STAGING)
        .map(Number)
        .sort((a, b) => a - b),
    ).toEqual(Array.from({ length: 21 }, (_, index) => index + 1));
  });

  it('only attributes staging to shipped phases and future real enablement phases', () => {
    const shipped = new Set(SHIPPED_PHASES);
    const phaseRows = phaseRowsFromPlan();
    const realPhases = new Set(phaseRows.map((row) => row.phase));
    const planned = new Set(
      phaseRows
        .filter((row) => row.status === 'planned')
        .map((row) => row.phase),
    );

    for (const [idText, entry] of Object.entries(INVARIANT_STAGING)) {
      const id = Number(idText);
      for (const phase of entry.introducedBy)
        if (id === 7 && phase === '34' && !shipped.has(phase)) {
          expect(realPhases.has(phase)).toBe(true);
          expect(planned.has(phase)).toBe(true);
        } else expect(shipped.has(phase)).toBe(true);
      if (entry.status === 'enabled') continue;
      expect(entry.reason.trim()).not.toBe('');
      if (entry.coveredBy) {
        // Staged for good (43i): the named specs check the rest of the claim.
        expect(entry.coveredBy.length).toBeGreaterThan(0);
        for (const spec of entry.coveredBy)
          expect(existsSync(join(__dirname, '../../../../../../', spec))).toBe(
            true,
          );
        expect(entry.enableAfter).toBeUndefined();
        continue;
      }
      expect(entry.enableAfter).toBeDefined();
      expect(realPhases.has(entry.enableAfter ?? '')).toBe(true);
      expect(planned.has(entry.enableAfter ?? '')).toBe(true);
      expect(shipped.has(entry.enableAfter ?? '')).toBe(false);
    }
  });

  it('keeps the shipped-phase contract equal to the README phase table', () => {
    expect(SHIPPED_PHASES).toEqual(shippedPhasesFromPlan());
  });
});

describe('dormant full-claim invariant audit', () => {
  it('bounds a blocked canonical admission while host liveness is idle', () => {
    const idleHost = { foreground: false, background: false };
    const blocked = (
      seq: number,
      logicalAt: number,
      admissionBlocked: boolean,
    ): CheckpointTraceEvent =>
      checkpoint(seq, seq === 1 ? 'drained' : 'deadline', {
        logicalAt,
        liveness: idleHost,
        queueTurnActive: false,
        admissionBlocked,
      });
    expect(
      checkDormantInvariants(
        [blocked(1, 0, true), blocked(2, 501, true)],
        context,
      ).violations,
    ).toContainEqual(expect.objectContaining({ id: 15, seqs: [1, 2] }));
    expect(
      checkDormantInvariants(
        [blocked(1, 0, true), blocked(2, 100, false)],
        context,
      ).violations.filter((violation) => violation.id === 15),
    ).toEqual([]);
  });

  it('enforces the enabled full turn-state claims', () => {
    const fixture = DORMANT_INVARIANT_FIXTURES.find(({ id }) => id === 3);
    if (!fixture) throw new Error('Missing invariant 3 fixture');
    expect(
      checkInvariants(fixture.failing, {
        ...context,
        fullTurnStateClaims: true,
      }).map((violation) => violation.id),
    ).toContain(3);
  });

  it.each(DORMANT_INVARIANT_FIXTURES)(
    'evaluates invariant $id on a non-vacuous passing trace and catches its synthetic failure',
    (fixture) => {
      const passing = checkDormantInvariants(
        fixture.passing,
        context,
        fixture.passingOptions,
      );
      expect(passing.activation[fixture.id] ?? 0).toBeGreaterThan(0);
      expect(
        passing.violations.filter((violation) => violation.id === fixture.id),
      ).toEqual([]);

      const failing = checkDormantInvariants(
        fixture.failing,
        context,
        fixture.failingOptions,
      );
      const violations = failing.violations.filter(
        (violation) => violation.id === fixture.id,
      );
      expect(failing.activation[fixture.id] ?? 0).toBeGreaterThan(0);
      expect(violations.length).toBeGreaterThan(0);
      expect(
        Array.from(
          new Set(violations.flatMap((violation) => violation.seqs)),
        ).sort((left, right) => left - right),
      ).toEqual([...fixture.failingSeqs].sort((left, right) => left - right));
    },
  );

  it('compares persisted decisions and every captured timer row in paired traces', () => {
    const fixture = DORMANT_INVARIANT_FIXTURES.find(({ id }) => id === 6);
    if (!fixture || fixture.id !== 6)
      throw new Error('Missing invariant 6 fixture');

    const fullTranscriptTrace = fixture.passingOptions?.fullTranscriptTrace;
    if (!fullTranscriptTrace)
      throw new Error('Invariant 6 fixture must pair a full transcript trace');
    expect(fullTranscriptTrace).not.toEqual(fixture.passing);
    expect(
      fullTranscriptTrace.some(
        (event) =>
          event.kind === 'revision' &&
          Object.values(event.chats).some((view) =>
            view.rows?.some((row) => row.id === 'older-row'),
          ),
      ),
    ).toBe(true);
    expect(
      checkDormantInvariants(
        fixture.passing,
        context,
        fixture.passingOptions,
      ).violations.filter((violation) => violation.id === 6),
    ).toEqual([]);
    expect(
      checkDormantInvariants(fixture.passing, context).activation[6] ?? 0,
    ).toBe(0);

    const placementResult = checkDormantInvariants(
      fixture.failing,
      context,
      fixture.failingOptions,
    );
    expect(
      placementResult.violations.find((violation) => violation.id === 6)
        ?.message,
    ).toMatch(/placed .* timer differently/);

    const changedDecision = fullTranscriptTrace.map((event) => {
      if (event.kind !== 'revision' || event.revision !== 2) return event;
      const chatId = Object.keys(event.chats)[0];
      const chat = chatId ? event.chats[chatId] : undefined;
      if (!chat?.runtime || !chatId) return event;
      return {
        ...event,
        chats: {
          ...event.chats,
          [chatId]: {
            ...chat,
            runtime: { ...chat.runtime, status: 'idle' as const },
          },
        },
      };
    });
    const decisionResult = checkDormantInvariants(fixture.passing, context, {
      fullTranscriptTrace: changedDecision,
    });
    expect(
      decisionResult.violations.find((violation) => violation.id === 6)
        ?.message,
    ).toMatch(/different persisted turn decisions/);

    const mutateRows = (
      trace: readonly PipelineTraceEvent[],
      mutate: (
        rows: readonly PersistedChatMessage[],
      ) => readonly PersistedChatMessage[],
    ): readonly PipelineTraceEvent[] =>
      trace.map((event) => {
        if (event.kind !== 'revision') return event;
        return {
          ...event,
          chats: Object.fromEntries(
            Object.entries(event.chats).map(([chatId, view]) => [
              chatId,
              view.rows === undefined
                ? view
                : { ...view, rows: mutate(view.rows) },
            ]),
          ),
        };
      });
    const reverseTimerAnchorOrder = (
      rows: readonly PersistedChatMessage[],
    ): readonly PersistedChatMessage[] => [
      ...rows.filter(
        (row) =>
          !row.blocks.some((block) => block.type === 'turn_timer') &&
          row.id !== 'retained-anchor',
      ),
      ...rows.filter((row) =>
        row.blocks.some((block) => block.type === 'turn_timer'),
      ),
      ...rows.filter((row) => row.id === 'retained-anchor'),
    ];
    const movedTimer = checkDormantInvariants(fixture.passing, context, {
      fullTranscriptTrace: mutateRows(
        fullTranscriptTrace,
        reverseTimerAnchorOrder,
      ),
    });
    expect(movedTimer.violations.some((violation) => violation.id === 6)).toBe(
      true,
    );

    const renamedTimer = checkDormantInvariants(fixture.passing, context, {
      fullTranscriptTrace: mutateRows(fullTranscriptTrace, (rows) =>
        rows.map((row) =>
          row.blocks.some((block) => block.type === 'turn_timer')
            ? { ...row, id: `${row.id}-renamed` }
            : row,
        ),
      ),
    });
    expect(
      renamedTimer.violations.some((violation) => violation.id === 6),
    ).toBe(true);

    const changedTimerFields = checkDormantInvariants(
      fixture.passing,
      context,
      {
        fullTranscriptTrace: mutateRows(fullTranscriptTrace, (rows) =>
          rows.map((row) => ({
            ...row,
            blocks: row.blocks.map((block) =>
              block.type === 'turn_timer'
                ? { ...block, startedAt: (block.startedAt ?? 0) + 1 }
                : block,
            ),
          })),
        ),
      },
    );
    expect(
      changedTimerFields.violations.some((violation) => violation.id === 6),
    ).toBe(true);
  });

  it('does not change ordinary checker results or activation', () => {
    const failure = DORMANT_INVARIANT_FIXTURES.find(({ id }) => id === 1);
    if (!failure) throw new Error('Missing invariant 1 fixture');
    const ordinaryViolations = checkInvariants(failure.failing, context);
    const ordinaryActivation = invariantActivation(failure.failing);

    checkDormantInvariants(failure.failing, context);

    expect(checkInvariants(failure.failing, context)).toEqual(
      ordinaryViolations,
    );
    expect(invariantActivation(failure.failing)).toEqual(ordinaryActivation);
  });

  it('bounds a continuously armed queue gate without requiring a drained label', () => {
    const trace: readonly PipelineTraceEvent[] = [
      checkpoint(1, 'reserved-before-drain', {
        logicalAt: 0,
        liveness: { foreground: false, background: false },
        queueTurnActive: true,
      }),
      queueEvent(2, [queuedRow('queued-user', 'queued prompt')], true),
      checkpoint(3, 'still-reserved', {
        logicalAt: 501,
        queueTurnActive: true,
      }),
    ];
    const result = checkDormantInvariants(trace, context);
    expect(result.activation[15] ?? 0).toBeGreaterThan(0);
    expect(result.violations).toContainEqual(
      expect.objectContaining({ id: 15, seqs: [1, 3] }),
    );
  });

  it('requires a held wake lock while managed work is only queued', () => {
    const queuedOnly = runtime('idle', {
      turn: {
        phase: 'background',
        decisionPending: false,
        catchingUp: false,
        endedTurnIds: [],
        background: { native: [], managed: { live: 0, queued: 1 } },
      },
    });
    const unheld = checkDormantInvariants(
      [revision(1, [], { runtime: queuedOnly })],
      context,
    );
    expect(unheld.violations).toContainEqual(
      expect.objectContaining({ id: 5, seqs: [1] }),
    );

    const held = checkDormantInvariants(
      [
        effect(1, { name: 'wake-lock-acquire', holder: target.chatId }),
        revision(2, [], { runtime: queuedOnly }),
      ],
      context,
    );
    expect(held.activation[5] ?? 0).toBeGreaterThan(0);
    expect(held.violations.filter((violation) => violation.id === 5)).toEqual(
      [],
    );
  });

  it('does not attribute an interleaved legitimate root update to an ignored child frame', () => {
    const trace: readonly PipelineTraceEvent[] = [
      revision(1, [], { runtime: runtime('idle') }),
      provider(2, 'to-canopy', 'sdk:assistant', {
        turnKey: 'child-turn',
        ids: { toolUseId: 'child-call' },
      }),
      provider(3, 'to-canopy', 'sdk:assistant', {
        turnKey: 'root-turn',
      }),
      revision(4, [textMessage('root-update', 'assistant', 'root update')], {
        runtime: runtime('idle'),
      }),
    ];
    const result = checkDormantInvariants(trace, context);
    expect(result.activation[4] ?? 0).toBeGreaterThan(0);
    expect(result.violations.filter((violation) => violation.id === 4)).toEqual(
      [],
    );
  });

  it('ignores child tool-result transcript progress when root decisions are unchanged', () => {
    const trace: readonly PipelineTraceEvent[] = [
      revision(1, [toolUse('child-call')], { runtime: runtime('idle') }),
      provider(2, 'to-canopy', 'sdk:assistant', {
        turnKey: 'child-turn',
        ids: { toolUseId: 'child-call' },
      }),
      revision(
        3,
        [
          toolUse('child-call'),
          message('child-result', 'assistant', [
            {
              type: 'tool_result',
              toolUseId: 'child-call',
              toolName: 'Read',
              output: 'completed child work',
              isError: false,
            },
          ]),
        ],
        { runtime: runtime('idle') },
      ),
    ];
    const result = checkDormantInvariants(trace, context);
    expect(result.activation[4] ?? 0).toBeGreaterThan(0);
    expect(result.violations.filter((violation) => violation.id === 4)).toEqual(
      [],
    );
  });

  it.each([
    {
      name: 'runtime status',
      trace: [
        revision(10, [], { runtime: runtime('idle') }),
        provider(11, 'to-canopy', 'sdk:assistant', {
          turnKey: 'child-turn',
          ids: { toolUseId: 'child-call' },
        }),
        revision(12, [], { runtime: runtime('streaming') }),
      ] as const,
      seqs: [10, 11, 12],
    },
    {
      name: 'sampled queue gate',
      trace: [
        revision(20, [], { runtime: runtime('idle') }),
        checkpoint(21, 'before-ignored-frame', { queueTurnActive: false }),
        provider(22, 'to-canopy', 'sdk:assistant', {
          turnKey: 'child-turn',
          ids: { toolUseId: 'child-call' },
        }),
        checkpoint(23, 'after-ignored-frame', { queueTurnActive: true }),
        revision(24, [], { runtime: runtime('idle') }),
      ] as const,
      seqs: [20, 21, 22, 23, 24],
    },
    {
      name: 'timer row fields',
      trace: [
        revision(30, [timerMessage(null)], { runtime: runtime('idle') }),
        provider(31, 'to-canopy', 'sdk:assistant', {
          turnKey: 'child-turn',
          ids: { toolUseId: 'child-call' },
        }),
        revision(
          32,
          [
            {
              ...timerMessage(null),
              blocks: [{ type: 'turn_timer', startedAt: 1, completedAt: 40 }],
            },
          ],
          { runtime: runtime('idle') },
        ),
      ] as const,
      seqs: [30, 31, 32],
    },
  ])(
    'reports an isolated invariant 4 violation for $name with source seqs',
    ({ trace, seqs }) => {
      const result = checkDormantInvariants(trace, context);
      expect(
        result.violations.filter((violation) => violation.id === 4),
      ).toEqual([expect.objectContaining({ id: 4, seqs })]);
    },
  );

  it('leaves changes with an ambiguous buffered transcript commit unclassified', () => {
    const trace: readonly PipelineTraceEvent[] = [
      revision(40, [], { runtime: runtime('idle') }),
      provider(41, 'to-canopy', 'sdk:assistant', {
        turnKey: 'child-turn',
        ids: { toolUseId: 'child-call' },
      }),
      transcript(42, 200, 'buffered-commit'),
      revision(43, [], { runtime: runtime('streaming') }),
    ];
    const result = checkDormantInvariants(trace, context);
    expect(result.activation[4] ?? 0).toBeGreaterThan(0);
    expect(result.violations.filter((violation) => violation.id === 4)).toEqual(
      [],
    );
  });

  it('tracks Codex root turn notifications through the session-active checkpoint', () => {
    const claudeFixture = DORMANT_INVARIANT_FIXTURES.find(
      (fixture) => fixture.id === 19,
    );
    if (!claudeFixture) throw new Error('Missing invariant 19 fixture');
    const providerTurnKey = 'codex-provider-turn';
    const trace = (sessionTurnActive: boolean): readonly PipelineTraceEvent[] =>
      claudeFixture.passing.map((event) => {
        if (event.kind === 'turn-lifecycle')
          return {
            ...event,
            event: { ...event.event, provider: 'codex' },
          };
        if (event.kind === 'provider')
          return {
            ...event,
            provider: 'codex',
            turnKey: providerTurnKey,
            type:
              event.type === 'sdk:result'
                ? 'notification:turn/completed'
                : 'notification:turn/started',
          };
        if (event.kind === 'checkpoint' && event.label === 'autonomous-active')
          return { ...event, sessionTurnActive };
        return event;
      });
    const passing = checkDormantInvariants(trace(true), context);
    expect(passing.activation[19] ?? 0).toBeGreaterThan(0);
    expect(
      passing.violations.filter((violation) => violation.id === 19),
    ).toEqual([]);

    const failing = checkDormantInvariants(trace(false), context);
    expect(
      failing.violations.find((violation) => violation.id === 19)?.message,
    ).toMatch(/Provider root turn did not retain session turn activity/);
  });
});

describe.each(invariantCases)(
  'pipeline invariant $id',
  ({ id, passing, failing, failingSeqs }) => {
    it('activates on a minimal passing trace and reports one formatted violation', () => {
      expectOneViolation(id, passing, failing, failingSeqs);
    });
  },
);

function turnEvent(
  traceSequence: number,
  turnId: string,
  ended: false | 'result' | 'abort-fallback',
): TurnTraceEvent {
  const event = lifecycleTrace(
    target,
    traceSequence,
    traceSequence,
    ended !== false,
  );
  if (event.event.type !== 'TurnEnded' || ended === false)
    return { ...event, event: { ...event.event, turnId } };
  return {
    ...event,
    event: {
      ...event.event,
      turnId,
      source: ended,
      outcome: ended === 'result' ? 'completed' : 'cancelled',
    },
  };
}

function completionReported(
  seq: number,
  turnStamp: string,
): PipelineTraceEvent {
  return {
    ...stamp(seq),
    kind: 'effect',
    target,
    effect: { name: 'chat-completion-reported', stamp: turnStamp },
  };
}

describe('pipeline invariant 8 exactly once (turn-state phase 43d)', () => {
  it('needs one turn diff for each turn its provider ended', () => {
    const missed: readonly PipelineTraceEvent[] = [
      turnEvent(1, 'turn-a', false),
      turnEvent(2, 'turn-a', 'result'),
      turnDiff(3),
      turnEvent(4, 'turn-b', false),
      turnEvent(5, 'turn-b', 'result'),
    ];
    expect(checkInvariants(missed, context)).toEqual([
      expect.objectContaining({ id: 8 }),
    ]);
    // Since 43e, Stop captures the turn its abort fallback ends, too.
    const aborted: readonly PipelineTraceEvent[] = [
      turnEvent(1, 'turn-a', false),
      turnEvent(2, 'turn-a', 'result'),
      turnDiff(3),
      turnEvent(4, 'turn-b', false),
      turnEvent(5, 'turn-b', 'abort-fallback'),
    ];
    expect(checkInvariants(aborted, context)).toEqual([
      expect.objectContaining({ id: 8 }),
    ]);
    expect(checkInvariants([...aborted, turnDiff(6)], context)).toEqual([]);
  });

  it('rejects a second turn diff for one ended turn', () => {
    // The turn's end separates the two captures, but it ended one turn.
    const twice: readonly PipelineTraceEvent[] = [
      turnEvent(1, 'turn-a', false),
      turnDiff(2),
      turnEvent(3, 'turn-a', 'result'),
      turnDiff(4),
    ];
    expect(checkInvariants(twice, context)).toEqual([
      expect.objectContaining({ id: 8, seqs: [4] }),
    ]);
    // A later turn needs its own capture, so the extra one can't stand in.
    expect(
      checkInvariants(
        [
          ...twice,
          turnEvent(5, 'turn-b', false),
          turnEvent(6, 'turn-b', 'result'),
        ],
        context,
      ),
    ).toEqual([
      expect.objectContaining({ id: 8, seqs: [4] }),
      expect.objectContaining({ id: 8, seqs: [5, 6] }),
    ]);
    // A capture after the next turn starts is that turn's.
    expect(
      checkInvariants(
        [
          turnEvent(1, 'turn-a', false),
          turnDiff(2),
          turnEvent(3, 'turn-a', 'result'),
          turnEvent(4, 'turn-b', false),
          turnDiff(5),
          turnEvent(6, 'turn-b', 'result'),
        ],
        context,
      ),
    ).toEqual([]);
  });

  it('gives a named turn diff to the turn it names, so turns can overlap', () => {
    const turn = (
      seq: number,
      turnId: string,
      ended: false | 'result',
      userMessageIds: string[],
    ): PipelineTraceEvent => {
      const event = turnEvent(seq, turnId, ended);
      return { ...event, event: { ...event.event, userMessageIds } };
    };
    // Turn A's capture lands after turn B starts, then repeats; B never
    // captures, yet an unnamed count would see one capture per turn.
    const overlapping: readonly PipelineTraceEvent[] = [
      turn(1, 'turn-a', false, ['message-a']),
      turn(2, 'turn-a', 'result', ['message-a']),
      turn(3, 'turn-b', false, ['message-b']),
      namedTurnDiff(4, 'message-a'),
      turn(5, 'turn-b', 'result', ['message-b']),
      namedTurnDiff(6, 'message-a'),
    ];
    expect(checkInvariants(overlapping, context)).toEqual([
      expect.objectContaining({ id: 8, seqs: [6] }),
      expect.objectContaining({ id: 8, seqs: [3, 5] }),
    ]);
    expect(
      checkInvariants(
        [...overlapping.slice(0, 5), namedTurnDiff(6, 'message-b')],
        context,
      ),
    ).toEqual([]);
    // A wake revives its prompt's turn but binds no user message itself; its
    // capture names its own turn, or only the prompt it revived.
    const woken = (
      capture: PipelineTraceEvent,
    ): readonly PipelineTraceEvent[] => [
      turn(1, 'turn-a', false, ['message-a']),
      namedTurnDiff(2, 'message-a'),
      turn(3, 'turn-a', 'result', ['message-a']),
      turn(4, 'wake-a', false, []),
      turn(5, 'wake-a', 'result', []),
      capture,
    ];
    expect(
      checkInvariants(woken(namedTurnDiff(6, 'message-a', 'wake-a')), context),
    ).toEqual([]);
    expect(
      checkInvariants(woken(namedTurnDiff(6, 'message-a')), context),
    ).toEqual([]);
  });

  it('needs turn diffs from a chat that took a baseline even when it captured none', () => {
    const baseline: PipelineTraceEvent = {
      ...stamp(1),
      kind: 'effect',
      effect: {
        name: 'turn-diff-baseline',
        identity: `${target.projectId}/${target.worktreeId}/${target.chatId}`,
      },
    };
    const lost: readonly PipelineTraceEvent[] = [
      baseline,
      turnEvent(2, 'turn-a', false),
      turnEvent(3, 'turn-a', 'result'),
    ];
    expect(checkInvariants(lost, context)).toEqual([
      expect.objectContaining({ id: 8 }),
    ]);
    // With neither a baseline nor a capture, the chat doesn't capture (Cowork).
    expect(checkInvariants(lost.slice(1), context)).toEqual([]);
  });

  it('counts a replayed turn-end receipt as one ended turn', () => {
    const ended = turnEvent(2, 'turn-a', 'result');
    const replayed: readonly PipelineTraceEvent[] = [
      turnEvent(1, 'turn-a', false),
      ended,
      turnDiff(3),
      // The same receipt, delivered again.
      { ...ended, ...stamp(4) },
    ];
    expect(checkInvariants(replayed, context)).toEqual([]);
    // The replay ends no further turn, so a second capture is a duplicate.
    expect(checkInvariants([...replayed, turnDiff(5)], context)).toEqual([
      expect.objectContaining({ id: 8, seqs: [3, 5] }),
      expect.objectContaining({ id: 8, seqs: [5] }),
    ]);
  });

  it('keeps a completion reported once across a replayed turn-end receipt', () => {
    const ended = turnEvent(2, 'turn-a', 'result');
    const replayed: readonly PipelineTraceEvent[] = [
      turnEvent(1, 'turn-a', false),
      ended,
      turnDiff(3),
      completionReported(4, 'message-a'),
      // The same receipt, delivered again, ends no further turn.
      { ...ended, ...stamp(5) },
      completionReported(6, 'message-a'),
    ];
    expect(checkInvariants(replayed, context)).toEqual([
      expect.objectContaining({ id: 8, seqs: [4, 6] }),
    ]);
  });

  it('reports a chat completion only while no turn runs', () => {
    const busy: readonly PipelineTraceEvent[] = [
      turnEvent(1, 'turn-a', false),
      completionReported(2, 'message-a'),
      turnEvent(3, 'turn-a', 'result'),
    ];
    expect(checkInvariants(busy, context)).toEqual([
      expect.objectContaining({ id: 8, seqs: [2] }),
    ]);
  });

  it('reports each turn completion once until the chat ends another turn', () => {
    const twice: readonly PipelineTraceEvent[] = [
      turnEvent(1, 'turn-a', false),
      turnEvent(2, 'turn-a', 'result'),
      completionReported(3, 'message-a'),
      completionReported(4, 'message-a'),
    ];
    expect(checkInvariants(twice, context)).toEqual([
      expect.objectContaining({ id: 8, seqs: [3, 4] }),
    ]);
    const healthy: readonly PipelineTraceEvent[] = [
      turnEvent(1, 'turn-a', false),
      turnEvent(2, 'turn-a', 'result'),
      completionReported(3, 'message-a'),
      // An earlier turn held while the chat was busy reports at the same idle.
      completionReported(4, 'message-held'),
      turnEvent(5, 'turn-b', false),
      turnEvent(6, 'turn-b', 'result'),
      completionReported(7, 'message-a'),
    ];
    expect(checkInvariants(healthy, context)).toEqual([]);
  });

  it('counts a completion the watcher modal deferred and replayed once', () => {
    const deferred: PipelineTraceEvent = {
      ...stamp(4),
      kind: 'effect',
      target,
      effect: { name: 'chat-completion-deferred', stamp: 'message-a' },
    };
    const replayed: readonly PipelineTraceEvent[] = [
      turnEvent(1, 'turn-a', false),
      turnEvent(2, 'turn-a', 'result'),
      completionReported(3, 'message-a'),
      deferred,
      completionReported(5, 'message-a'),
    ];
    expect(checkInvariants(replayed, context)).toEqual([]);
  });
});

describe('pipeline invariant acceptance edges', () => {
  it('keys the code-review end effect by worktree and the turn diff by chat', () => {
    const codeReview = (seq: number): PipelineTraceEvent => ({
      ...stamp(seq),
      kind: 'effect',
      effect: {
        name: 'terminal-effect',
        effect: 'code-review',
        identity: target.worktreeId,
      },
    });
    expect(
      checkInvariants(
        [codeReview(1), lifecycleTrace(otherTarget, 2, 1, true), codeReview(3)],
        context,
      ),
    ).toEqual([]);
    expect(
      checkInvariants(
        [turnDiff(1), lifecycleTrace(otherTarget, 2, 1, true), turnDiff(3)],
        context,
      ),
    ).toEqual([
      expect.objectContaining({ id: 8, seqs: [1, 3] }),
      // The other chat's end ends none of this chat's turns, either.
      {
        id: 8,
        message:
          'project-1/worktree-1/chat-1 captured 2 turn diffs with no started turn awaiting one.',
        seqs: [1, 3],
      },
    ]);
  });

  it('activates invariant 7 independently for each recorded chat stream', () => {
    const trace: readonly PipelineTraceEvent[] = [
      lifecycleTrace(target, 1, 1, false),
      lifecycleTrace(target, 2, 2, true),
      lifecycleTrace(otherTarget, 3, 1, false),
      lifecycleTrace(otherTarget, 4, 2, true),
    ];

    expect(invariantActivation(trace)[7]).toBe(4);
    expect(checkInvariants(trace, context)).toEqual([]);
  });

  it('keeps settled timers across unselected and off-page revisions', () => {
    const trace: readonly PipelineTraceEvent[] = [
      revision(1, [timerMessage(50)]),
      revision(2, undefined),
      revision(3, []),
      revision(4, [timerMessage(50)]),
    ];
    expectPositiveActivation(1, trace);
    expect(checkInvariants(trace, context)).toEqual([]);
  });

  it('correlates a targetless wake-lock release to the chat holder', () => {
    const live = effect(1, { name: 'native-task-live', taskId: 'task-1' });
    const released: PipelineTraceEvent = {
      ...stamp(2),
      kind: 'effect',
      effect: {
        name: 'wake-lock-release',
        holder: `chat:${target.projectId}/${target.worktreeId}/${target.chatId}`,
      },
    };
    expect(checkInvariants([live, released], context)).toEqual([
      expect.objectContaining({ id: 5, seqs: [1, 2] }),
    ]);
  });

  it('recognizes Codex ordinary prompt handoff', () => {
    const trace: readonly PipelineTraceEvent[] = [
      revision(1, [textMessage('codex-prompt', 'user', 'hello Codex')]),
      provider(2, 'to-provider', 'client:turn/start', {
        provider: 'codex',
        text: 'hello Codex',
      }),
    ];
    expectPositiveActivation(11, trace);
    expect(checkInvariants(trace, context)).toEqual([]);
  });

  it('rejects an unapproved rewrite reason even if the byte prefix is intact', () => {
    const trace: readonly PipelineTraceEvent[] = [
      transcript(1, 100, 'original'),
      effect(2, { name: 'transcript-rewrite', reason: 'removal' }),
      transcript(3, 100, 'original', {
        committedBytes: 100,
        sha256: 'original',
        prefixSha256: 'original',
      }),
    ];
    expect(checkInvariants(trace, context)).toEqual([
      expect.objectContaining({ id: 17, seqs: [1, 2, 3] }),
    ]);
  });

  // The always-on journal records a turn start's committed rows plus its
  // active tail as a mixed_active rewrite (develop integration, D13).
  it('accepts a mixed_active rewrite that keeps the committed prefix', () => {
    const trace: readonly PipelineTraceEvent[] = [
      transcript(1, 100, 'original'),
      effect(2, { name: 'transcript-rewrite', reason: 'mixed_active' }),
      transcript(3, 140, 'extended', {
        committedBytes: 100,
        sha256: 'original',
        prefixSha256: 'original',
      }),
    ];
    expect(checkInvariants(trace, context)).toEqual([]);
  });

  it('rejects a mixed_active rewrite that changes committed bytes', () => {
    const trace: readonly PipelineTraceEvent[] = [
      transcript(1, 100, 'original'),
      effect(2, { name: 'transcript-rewrite', reason: 'mixed_active' }),
      transcript(3, 140, 'extended', {
        committedBytes: 100,
        sha256: 'original',
        prefixSha256: 'rewritten',
      }),
    ];
    expect(checkInvariants(trace, context)).toEqual([
      expect.objectContaining({ id: 17, seqs: [1, 2, 3] }),
    ]);
  });

  it('accepts fresh uncertainty after admission only with new evidence', () => {
    const admitted = revision(1, undefined, {
      inputDelivery: inputLedger(inputRow('pending')),
    });
    // restoreInputLedger: the session ended before the provider picked it up.
    const uncertainAgain = (seq: number): PipelineTraceEvent =>
      revision(seq, undefined, {
        inputDelivery: inputLedger(
          inputRow('uncertain', {
            revision: 3,
            reason: 'The provider session ended before delivery was confirmed.',
          }),
        ),
      });
    const unconfirmedWithdrawal = revision(2, undefined, {
      inputDelivery: inputLedger(inputRow('cancelling', { revision: 2 })),
    });
    for (const evidence of [
      effect(2, { name: 'session-destroyed', sessionKey: 'session-1' }),
      checkpoint(2, 'user-stop', { userInitiated: true }),
      unconfirmedWithdrawal,
    ])
      expect(
        checkInvariants([admitted, evidence, uncertainAgain(3)], context),
      ).toEqual([]);
    expect(checkInvariants([admitted, uncertainAgain(3)], context)).toEqual([
      expect.objectContaining({ id: 21, seqs: [1, 3] }),
    ]);
  });

  it('links production Codex tool-use ids to the provider call', () => {
    const request = (
      seq: number,
      turnKey: string,
      callId: string,
    ): ProviderTraceEvent =>
      provider(seq, 'to-canopy', 'request:dynamicToolCall', {
        provider: 'codex',
        turnKey,
        ids: { callId },
      });
    const resolved = (seq: number): ProviderTraceEvent =>
      provider(seq, 'to-canopy', 'notification:serverRequest/resolved', {
        provider: 'codex',
        turnKey: 'turn-1',
        ids: { callId: 'call-1' },
      });
    // Production records the side effect under `codex-${callId}`.
    const sideEffect = (seq: number, callId: string): PipelineTraceEvent =>
      effect(seq, { name: 'tool-side-effect', callId, effect: 'read-file' });
    expectOneViolation(
      18,
      [
        request(1, 'turn-1', 'call-1'),
        sideEffect(2, 'codex-call-1'),
        resolved(3),
      ],
      [
        request(1, 'turn-1', 'call-1'),
        resolved(2),
        sideEffect(3, 'codex-call-1'),
      ],
      [2, 3],
    );
    const laterTurn: readonly PipelineTraceEvent[] = [
      request(1, 'turn-1', 'call-1'),
      provider(2, 'to-canopy', 'notification:turn/completed', {
        provider: 'codex',
        turnKey: 'turn-1',
      }),
      request(3, 'turn-2', 'call-2'),
      sideEffect(4, 'codex-call-2'),
    ];
    expect(checkInvariants(laterTurn, context)).toEqual([]);
  });

  it('cancels an in-flight handler at the Codex turn completion', () => {
    const trace: readonly PipelineTraceEvent[] = [
      provider(1, 'to-canopy', 'request:dynamicToolCall', {
        provider: 'codex',
        turnKey: 'turn-1',
        ids: { callId: 'running-handler' },
      }),
      provider(2, 'to-canopy', 'notification:turn/completed', {
        provider: 'codex',
        turnKey: 'turn-1',
      }),
      effect(3, {
        name: 'tool-side-effect',
        callId: 'running-handler',
        effect: 'write-after-cancel',
      }),
    ];
    expect(checkInvariants(trace, context)).toEqual([
      expect.objectContaining({ id: 18, seqs: [2, 3] }),
    ]);
  });

  it('does not reopen a completed Claude turn on a late frame', () => {
    const trace: readonly PipelineTraceEvent[] = [
      provider(1, 'to-canopy', 'sdk:assistant', { turnKey: 'turn-1' }),
      checkpoint(2, 'active', { sessionTurnActive: true }),
      provider(3, 'to-canopy', 'sdk:result', { turnKey: 'turn-1' }),
      provider(4, 'to-canopy', 'sdk:assistant', { turnKey: 'turn-1' }),
      checkpoint(5, 'idle', { sessionTurnActive: false }),
    ];
    expectPositiveActivation(19, trace);
    expect(checkInvariants(trace, context)).toEqual([]);
  });

  it('requires a stable watcher id even when a retry did not create a watcher', () => {
    const trace: readonly PipelineTraceEvent[] = [
      effect(1, {
        name: 'watcher-registered',
        callId: 'first-transport',
        naturalKey: 'same-watcher',
        watcherId: 'watcher-a',
        created: true,
      }),
      effect(2, {
        name: 'watcher-registered',
        callId: 'retry-transport',
        naturalKey: 'same-watcher',
        watcherId: 'watcher-b',
        created: false,
      }),
    ];
    expect(checkInvariants(trace, context)).toEqual([
      expect.objectContaining({ id: 20, seqs: [1, 2] }),
    ]);
  });

  it('requires id12 restart consent after live work begins and for the same chat', () => {
    const passing: readonly PipelineTraceEvent[] = [
      effect(1, { name: 'native-task-live', taskId: 'task-1' }),
      checkpoint(2, 'settings-changed', { userInitiated: true }),
      effect(3, { name: 'session-destroyed', sessionKey: 'session-1' }),
    ];
    const consentTooEarly: readonly PipelineTraceEvent[] = [
      checkpoint(1, 'settings-changed', { userInitiated: true }),
      effect(2, { name: 'native-task-live', taskId: 'task-1' }),
      effect(3, { name: 'session-destroyed', sessionKey: 'session-1' }),
    ];
    const otherChatConsent: readonly PipelineTraceEvent[] = [
      effect(1, { name: 'native-task-live', taskId: 'task-1' }),
      checkpoint(2, 'settings-changed', {
        target: otherTarget,
        userInitiated: true,
      }),
      effect(3, { name: 'session-destroyed', sessionKey: 'session-1' }),
    ];
    expectOneViolation(12, passing, consentTooEarly, [2, 3]);
    expectOneViolation(12, passing, otherChatConsent, [1, 3]);
  });

  it('enforces prompt handoff p95 only when absolute timing is opted in', () => {
    const passing: readonly PipelineTraceEvent[] = [
      revision(1, [textMessage('prompt-1', 'user', 'hello provider')], {
        source: 'renderer-command',
      }),
      provider(2, 'to-provider', 'prompt', { text: 'hello provider' }),
    ];
    const slow: readonly PipelineTraceEvent[] = [
      revision(1, [textMessage('prompt-1', 'user', 'hello provider')], {
        source: 'renderer-command',
      }),
      provider(2001, 'to-provider', 'prompt', { text: 'hello provider' }),
    ];
    expect(checkInvariants(slow, context)).toEqual([]);
    expectOneViolation(11, passing, slow, [1, 2001], {
      ...context,
      absoluteTiming: true,
      fullTurnStateClaims: false,
    });
  });

  it('enforces Claude steer settlement timing only when absolute timing is opted in', () => {
    const passing: readonly PipelineTraceEvent[] = [
      effect(1, { name: 'commits-held' }),
      provider(2, 'to-provider', 'steer', { text: 'continue' }),
      effect(3, {
        name: 'steer-settled',
        text: 'continue',
        outcome: 'accepted',
      }),
      effect(4, { name: 'commits-released' }),
    ];
    const slow: readonly PipelineTraceEvent[] = [
      effect(1, { name: 'commits-held' }),
      provider(2, 'to-provider', 'steer', { text: 'continue' }),
      effect(1002, {
        name: 'steer-settled',
        text: 'continue',
        outcome: 'accepted',
      }),
      effect(1003, { name: 'commits-released' }),
    ];
    expect(checkInvariants(slow, context)).toEqual([]);
    expectOneViolation(16, passing, slow, [2, 1002], {
      ...context,
      absoluteTiming: true,
      fullTurnStateClaims: false,
    });
  });

  it('times Claude steer settlement from the provider acknowledgement', () => {
    const ids = { messageUuid: 'steer-1' };
    const lateAcknowledgement = (settledAt: number): PipelineTraceEvent[] => [
      provider(2, 'to-provider', 'steer', { text: 'continue', ids }),
      provider(1500, 'to-canopy', 'sdk:command_lifecycle', { ids }),
      effect(settledAt, {
        name: 'steer-settled',
        text: 'continue',
        outcome: 'accepted',
      }),
    ];
    expectOneViolation(
      16,
      lateAcknowledgement(1600),
      lateAcknowledgement(2500),
      [1500, 2500],
      { ...context, absoluteTiming: true },
    );
  });

  it('allows a progress revision to update active rows without changing committed bytes', () => {
    const trace: readonly PipelineTraceEvent[] = [
      transcript(1, 100, 'a'.repeat(64)),
      revision(2, [textMessage('assistant-1', 'assistant', 'progress 1')]),
      revision(3, [textMessage('assistant-1', 'assistant', 'progress 2')]),
      transcript(4, 100, 'a'.repeat(64), {
        committedBytes: 100,
        sha256: 'a'.repeat(64),
        prefixSha256: 'a'.repeat(64),
      }),
    ];
    expectPositiveActivation(17, trace);
    expect(checkInvariants(trace, context)).toEqual([]);
  });

  it('allows the explicitly classified prompt_relocation transcript rewrite', () => {
    const trace: readonly PipelineTraceEvent[] = [
      transcript(1, 100, 'a'.repeat(64)),
      effect(2, { name: 'transcript-rewrite', reason: 'prompt_relocation' }),
      transcript(3, 120, 'b'.repeat(64), {
        committedBytes: 100,
        sha256: 'a'.repeat(64),
        prefixSha256: 'b'.repeat(64),
      }),
    ];
    expectPositiveActivation(17, trace);
    expect(checkInvariants(trace, context)).toEqual([]);
  });

  it.each([
    'completion',
    'replacement',
    'progress',
    'wrong-call',
    'changed-text',
    'second-row',
    'dropped-block',
    'wrong-output',
    'missing-effect',
    'wrong-thread',
    'moved-row',
  ] as const)(
    'checks native command result amendment evidence: %s',
    (variant) => {
      const call: PersistedChatMessage = {
        ...message('codex-command', 'assistant', [
          { type: 'text', text: 'immutable command context' },
          {
            type: 'tool_use',
            toolUseId: 'codex-command',
            toolName: 'Bash',
            input: '{}',
          },
          ...(variant === 'replacement'
            ? [
                {
                  type: 'tool_result' as const,
                  toolUseId: 'codex-command',
                  toolName: 'Bash',
                  output: 'old aggregate',
                  isError: false,
                },
              ]
            : []),
        ]),
        codexThreadId: 'thread',
        codexTurnId: 'turn',
      };
      const sibling = textMessage('sibling', 'assistant', 'unchanged sibling');
      const amended: PersistedChatMessage = {
        ...call,
        blocks: [
          ...call.blocks
            .filter(
              (block) =>
                block.type !== 'tool_result' &&
                !(variant === 'dropped-block' && block.type === 'text'),
            )
            .map((block) =>
              variant === 'changed-text' && block.type === 'text'
                ? { ...block, text: 'rewritten context' }
                : block,
            ),
          {
            type: 'tool_result',
            toolUseId: 'codex-command',
            toolName: 'Bash',
            output:
              variant === 'wrong-output'
                ? 'not native aggregate'
                : 'exact aggregate',
            isError: false,
          },
        ],
      };
      const afterRows = [
        amended,
        variant === 'second-row' ? { ...sibling, timestamp: 2 } : sibling,
      ];
      if (variant === 'moved-row') afterRows.reverse();
      // Synthetic trace: only the original native command result may change.
      const trace: PipelineTraceEvent[] = [
        revision(1, [call, sibling]),
        transcript(2, 100, 'before'),
        provider(
          3,
          'to-canopy',
          variant === 'progress'
            ? 'notification:item/commandExecution/outputDelta'
            : 'notification:item/completed',
          {
            provider: 'codex',
            ids: { toolUseId: 'command' },
            commandCompletion: {
              itemId: variant === 'wrong-call' ? 'different' : 'command',
              threadId: variant === 'wrong-thread' ? 'other' : 'thread',
              turnId: 'turn',
              aggregateOutput: 'exact aggregate',
            },
          },
        ),
        ...(variant === 'missing-effect'
          ? []
          : [effect(4, { name: 'transcript-rewrite', reason: 'patch' })]),
        revision(5, afterRows),
        transcript(6, 150, 'after', {
          committedBytes: 100,
          sha256: 'before',
          prefixSha256: 'changed',
        }),
      ];
      expect(
        checkInvariants(trace, context).filter((failure) => failure.id === 17),
      ).toHaveLength(
        variant === 'completion' || variant === 'replacement' ? 0 : 1,
      );
    },
    5_000,
  );

  it.each(['child-turn', 'root-activity'] as const)(
    'allows a Codex agent card completion with its %s terminal in the transcript window',
    (terminalKind) => {
      const before = agentCardMessage('inProgress', 'running');
      const after = agentCardMessage('completed', 'completed');
      const sibling = textMessage('agent-card-sibling', 'assistant', 'same');
      const terminal =
        terminalKind === 'child-turn'
          ? provider(3, 'to-canopy', 'notification:turn/completed', {
              provider: 'codex',
              agentTerminal: { threadId: 'child-thread', status: 'completed' },
            })
          : provider(3, 'to-canopy', 'notification:item/completed', {
              provider: 'codex',
              agentTerminal: { threadId: 'child-thread', status: 'completed' },
            });
      const trace = agentCardAmendmentTrace(
        before,
        [after, sibling],
        [terminal],
      );

      expect(
        checkInvariants(trace, context).filter((failure) => failure.id === 17),
      ).toHaveLength(0);
    },
    5_000,
  );

  it.each([
    [
      'records the child settle',
      { 'child-thread': { startedAt: 10 } },
      { 'child-thread': { startedAt: 10, settledAt: 20 } },
      0,
    ],
    [
      'records an untimed child settle',
      undefined,
      { 'child-thread': { settledAt: 20 } },
      0,
    ],
    [
      'adds a child start',
      undefined,
      { 'child-thread': { startedAt: 10, settledAt: 20 } },
      1,
    ],
    [
      'moves the child start',
      { 'child-thread': { startedAt: 10 } },
      { 'child-thread': { startedAt: 11, settledAt: 20 } },
      1,
    ],
    [
      'moves a recorded settle',
      { 'child-thread': { startedAt: 10, settledAt: 15 } },
      { 'child-thread': { startedAt: 10, settledAt: 20 } },
      1,
    ],
    [
      'settles another child',
      { 'child-thread': { startedAt: 10 } },
      {
        'child-thread': { startedAt: 10, settledAt: 20 },
        'other-child-thread': { settledAt: 20 },
      },
      1,
    ],
  ] as const)(
    'checks a Codex agent card completion that %s',
    (_variant, priorTimes, nextTimes, violations) => {
      const withTimes = (
        row: PersistedChatMessage,
        receiverTimes:
          | Record<string, { startedAt?: number; settledAt?: number }>
          | undefined,
      ): PersistedChatMessage => ({
        ...row,
        blocks: row.blocks.map((block) =>
          block.type === 'codex_agent_call' && receiverTimes
            ? { ...block, receiverTimes }
            : block,
        ),
      });
      const before = withTimes(
        agentCardMessage('inProgress', 'running'),
        priorTimes,
      );
      const after = withTimes(
        agentCardMessage('completed', 'completed'),
        nextTimes,
      );
      const sibling = textMessage('agent-card-sibling', 'assistant', 'same');
      const terminal = provider(3, 'to-canopy', 'notification:turn/completed', {
        provider: 'codex',
        agentTerminal: { threadId: 'child-thread', status: 'completed' },
      });
      const trace = agentCardAmendmentTrace(
        before,
        [after, sibling],
        [terminal],
      );

      expect(
        checkInvariants(trace, context).filter((failure) => failure.id === 17),
      ).toHaveLength(violations);
    },
    5_000,
  );

  it.each([
    'changed-agent-path',
    'second-block',
    'second-row',
    'no-child-terminal',
    'different-child',
    'status-regression',
    'missing-effect',
  ] as const)(
    'rejects invalid Codex agent card completion amendment: %s',
    (variant) => {
      const before = agentCardMessage(
        variant === 'status-regression' ? 'completed' : 'inProgress',
        'running',
        variant === 'second-block' ? 'before' : undefined,
      );
      const after = agentCardMessage(
        variant === 'status-regression' ? 'inProgress' : 'completed',
        variant === 'different-child' ? 'running' : 'completed',
        variant === 'second-block' ? 'after' : undefined,
        variant === 'changed-agent-path',
        variant === 'different-child',
      );
      const sibling = textMessage('agent-card-sibling', 'assistant', 'same');
      const terminal = provider(3, 'to-canopy', 'notification:turn/completed', {
        provider: 'codex',
        agentTerminal: { threadId: 'child-thread', status: 'completed' },
      });
      const afterRows = [
        after,
        variant === 'second-row' ? { ...sibling, timestamp: 2 } : sibling,
      ];
      const trace = agentCardAmendmentTrace(
        before,
        afterRows,
        variant === 'no-child-terminal' ? [] : [terminal],
        variant !== 'missing-effect',
      );

      expect(
        checkInvariants(trace, context).filter((failure) => failure.id === 17),
      ).toHaveLength(1);
    },
    5_000,
  );

  it('rejects secret-bearing queue rows but allows their own generated provider delivery', () => {
    const generatedDelivery: readonly PipelineTraceEvent[] = [
      queueEvent(
        1,
        [
          queuedRow('delivery-1', 'visible watcher message', {
            watcherFired: { kind: 'build' },
          }),
        ],
        false,
      ),
      provider(2, 'to-provider', 'prompt', {
        text: 'visible watcher message internal-watcher-payload',
      }),
    ];
    const leakedQueue: readonly PipelineTraceEvent[] = [
      queueEvent(
        1,
        [queuedRow('delivery-1', 'internal-watcher-payload')],
        false,
      ),
    ];
    expectOneViolation(14, generatedDelivery, leakedQueue, [1]);
  });

  it('delivers a generated queued message within its eligible deadline', () => {
    const queued = queueEvent(
      1,
      [
        queuedRow('delivery-1', 'watcher follow-up', {
          watcherFired: { kind: 'build' },
          waitingReason: 'steer_unavailable',
        }),
      ],
      true,
      0,
    );
    const passing: readonly PipelineTraceEvent[] = [
      queued,
      provider(2, 'to-canopy', 'sdk:result', {
        turnKey: 'turn-1',
        logicalAt: 10,
      }),
      checkpoint(3, 'delivery-eligible', { logicalAt: 20 }),
      provider(4, 'to-provider', 'prompt', {
        text: 'watcher follow-up',
        logicalAt: 100,
      }),
    ];
    const failing: readonly PipelineTraceEvent[] = [
      queued,
      provider(2, 'to-canopy', 'sdk:result', {
        turnKey: 'turn-1',
        logicalAt: 10,
      }),
      checkpoint(3, 'delivery-eligible', { logicalAt: 20 }),
      checkpoint(4, 'deadline', { logicalAt: 521 }),
    ];
    expectOneViolation(13, passing, failing, [1, 3, 4]);
  });

  it('releases an unneeded queue gate before its logical deadline', () => {
    const passing: readonly PipelineTraceEvent[] = [
      checkpoint(1, 'drained', {
        logicalAt: 0,
        liveness: { foreground: false, background: false },
        queueTurnActive: true,
      }),
      checkpoint(2, 'gate-released', {
        logicalAt: 100,
        liveness: { foreground: false, background: false },
        queueTurnActive: false,
      }),
    ];
    const failing: readonly PipelineTraceEvent[] = [
      checkpoint(1, 'drained', {
        logicalAt: 0,
        liveness: { foreground: false, background: false },
        queueTurnActive: true,
      }),
      checkpoint(2, 'deadline', {
        logicalAt: 501,
        liveness: { foreground: false, background: false },
        queueTurnActive: true,
      }),
    ];
    expectOneViolation(15, passing, failing, [1, 2]);
  });

  it('accepts a self-started Claude turn with session activity and rejects borrowing the latest queued id', () => {
    const selfStarted: readonly PipelineTraceEvent[] = [
      provider(1, 'to-canopy', 'sdk:assistant', { turnKey: 'turn-1' }),
      checkpoint(2, 'turn-active', { sessionTurnActive: true }),
      provider(3, 'to-canopy', 'sdk:result', { turnKey: 'turn-1' }),
    ];
    const borrowedQueuedId: readonly PipelineTraceEvent[] = [
      queueEvent(1, [queuedRow('older-row', 'older text')], true),
      queueEvent(2, [queuedRow('queued-user', 'latest queued text')], true),
      provider(3, 'to-canopy', 'sdk:assistant', { turnKey: 'turn-1' }),
      revision(4, undefined, {
        runtime: runtime('streaming', {
          activeTurn: { userMessageId: 'queued-user', startedAt: 3 },
        }),
      }),
    ];
    expect(checkInvariants(selfStarted, context)).toEqual([]);
    expectOneViolation(19, selfStarted, borrowedQueuedId, [2, 4]);
  });

  it('keeps a late acknowledgement settled rather than returning to uncertain', () => {
    const uncertain = inputRow('uncertain', {
      attempts: [
        {
          id: 'attempt-1',
          generation: 'generation-1',
          provider: 'claude',
          createdAt: 1,
          admittedAt: 2,
          uncertainAt: 10,
        },
      ],
    });
    const pending = inputRow('pending', {
      revision: 2,
      attempts: [
        {
          id: 'attempt-1',
          generation: 'generation-1',
          provider: 'claude',
          createdAt: 1,
          admittedAt: 2,
        },
      ],
    });
    const settledAgain = inputRow('pending', {
      revision: 3,
      attempts: [
        {
          id: 'attempt-1',
          generation: 'generation-1',
          provider: 'claude',
          createdAt: 1,
          admittedAt: 2,
        },
      ],
    });
    const passing: readonly PipelineTraceEvent[] = [
      revision(1, undefined, { inputDelivery: inputLedger(uncertain) }),
      revision(2, undefined, { inputDelivery: inputLedger(pending) }),
      revision(3, undefined, { inputDelivery: inputLedger(settledAgain) }),
    ];
    const failing: readonly PipelineTraceEvent[] = [
      revision(1, undefined, { inputDelivery: inputLedger(uncertain) }),
      revision(2, undefined, { inputDelivery: inputLedger(pending) }),
      revision(3, undefined, {
        inputDelivery: inputLedger(
          inputRow('uncertain', {
            revision: 3,
            attempts: [
              {
                id: 'attempt-1',
                generation: 'generation-1',
                provider: 'claude',
                createdAt: 1,
                admittedAt: 2,
                uncertainAt: 30,
              },
            ],
          }),
        ),
      }),
    ];
    expectOneViolation(21, passing, failing, [2, 3]);
  });

  it('sends a refused generated row as one ordinary prompt only', () => {
    const owed = inputRow('cancelled', {
      notDelivered: { attemptId: 'attempt-1', at: 4 },
      ordinaryContinuation: { attemptId: 'attempt-1', epoch: 1 },
      ordinaryOnly: true,
      attempts: [
        {
          id: 'attempt-1',
          generation: 'generation-1',
          provider: 'claude',
          createdAt: 1,
          admittedAt: 2,
          withdrawnAt: 3,
        },
      ],
    });
    const ledgerRevision = revision(1, undefined, {
      inputDelivery: inputLedger(owed),
    });
    const onePrompt: readonly PipelineTraceEvent[] = [
      ledgerRevision,
      provider(2, 'to-provider', 'prompt', { text: 'follow-up' }),
    ];
    const duplicated: readonly PipelineTraceEvent[] = [
      ledgerRevision,
      provider(2, 'to-provider', 'prompt', { text: 'follow-up' }),
      provider(3, 'to-provider', 'prompt', { text: 'follow-up' }),
    ];
    expectOneViolation(21, onePrompt, duplicated, [1, 2, 3]);
  });

  it('allows a newer uncertain generation without reopening the settled attempt', () => {
    const original = inputRow('pending');
    const retried = inputRow('uncertain', {
      revision: 2,
      currentAttemptId: 'attempt-2',
      attempts: [
        {
          id: 'attempt-1',
          generation: 'generation-1',
          provider: 'claude',
          createdAt: 1,
          admittedAt: 2,
        },
        {
          id: 'attempt-2',
          generation: 'generation-2',
          provider: 'claude',
          createdAt: 3,
          uncertainAt: 4,
        },
      ],
    });
    const trace: readonly PipelineTraceEvent[] = [
      revision(1, undefined, { inputDelivery: inputLedger(original) }),
      revision(2, undefined, { inputDelivery: inputLedger(retried) }),
    ];
    expectPositiveActivation(21, trace);
    expect(checkInvariants(trace, context)).toEqual([]);
  });

  it('does not owe an ordinary fallback without a current generated attempt', () => {
    const generatedWithoutAttempt = inputRow(
      'cancelled',
      { attempts: [] },
      false,
    );
    const trace: readonly PipelineTraceEvent[] = [
      revision(1, undefined, {
        inputDelivery: inputLedger(generatedWithoutAttempt),
      }),
    ];
    expectPositiveActivation(21, trace);
    expect(checkInvariants(trace, context)).toEqual([]);
  });

  it('does not execute deferred invariant ids', () => {
    const trace: readonly PipelineTraceEvent[] = [
      revision(1, [timerMessage(1)]),
      revision(2, [timerMessage(2)]),
      provider(3, 'to-canopy', 'sdk:result', { turnKey: 'turn-1' }),
    ];
    const deferredIds: readonly InvariantId[] = [2, 3, 4, 6, 7, 8, 10];
    const violations: readonly InvariantViolation[] = checkInvariants(
      trace,
      context,
    );
    for (const id of deferredIds)
      expect(invariantActivation(trace)[id] ?? 0).toBe(0);
    for (const id of deferredIds)
      expect(violations.some((violation) => violation.id === id)).toBe(false);
  });
});
