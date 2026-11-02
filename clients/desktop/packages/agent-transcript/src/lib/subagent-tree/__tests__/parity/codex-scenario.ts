/**
 * The Codex parity scenarios (CAN-4051), written once and rendered in the two
 * forms each host records them in.
 *
 * - `codexDesktopEvents`: the provider-neutral Codex events desktop's
 *   app-server client forwards to the chat store (`{ type: 'codex', event }`),
 *   including the `thread.started` it emits after `thread/read` fills a
 *   subagent's nickname, role and model.
 * - `codexCloudRecording`: the Agentic Core durable event log, message rows
 *   and task rows, in the runner's collaboration-call shape (REG-3075).
 *
 * `CODEX_V2_SCENARIO` is a multi-agent v2 session: each spawn and settle is a
 * `subAgentActivity` item. `CODEX_V1_SCENARIO` is a multi-agent v1 session
 * whose one `collabAgentToolCall` spawn starts two receivers.
 */
import {
  PARITY_T0,
  isoAt,
  type CloudRecording,
  type CoreMessageRow,
  type CoreRecordedEvent,
  type DesktopRecordedEvent,
} from './recording';

interface CodexMessageStep {
  readonly kind: 'message';
  readonly itemId: string;
  readonly text: string;
}

interface CodexCommandStep {
  readonly kind: 'command';
  readonly itemId: string;
  readonly command: string;
  readonly output: string;
  readonly exitCode: number;
}

type CodexChildStep = CodexMessageStep | CodexCommandStep;

interface CodexAgent {
  readonly threadId: string;
  readonly taskId: string;
  readonly turnId: string;
  readonly agentPath: string;
  readonly nickname: string;
  readonly role: string;
  readonly model: string;
  readonly reasoningEffort: string;
  readonly steps: readonly CodexChildStep[];
  readonly outcome:
    | { readonly status: 'completed' }
    | { readonly status: 'failed'; readonly error: string };
}

interface CodexSpawn {
  readonly callId: string;
  /** v1 only: the collaboration call's prompt. v2 activity carries none. */
  readonly prompt?: string;
  readonly agents: readonly CodexAgent[];
}

interface CodexWait {
  readonly callId: string;
  readonly agents: readonly CodexAgent[];
}

type CodexRootStep =
  | { readonly kind: 'message'; readonly itemId: string; readonly text: string }
  | { readonly kind: 'spawn'; readonly spawn: CodexSpawn }
  | { readonly kind: 'run'; readonly agent: CodexAgent }
  | { readonly kind: 'wait'; readonly wait: CodexWait };

export interface CodexScenario {
  readonly name: string;
  readonly version: 'v1' | 'v2';
  readonly rootThreadId: string;
  /** Codex's root turn and Agentic Core's turn. */
  readonly codexTurnId: string;
  readonly coreTurnId: string;
  readonly userMessageId: string;
  readonly userText: string;
  readonly steps: readonly CodexRootStep[];
}

const V2_ROOT = '019b4051-0000-7000-8000-000000000001';
const V2_LINT: CodexAgent = {
  threadId: '019b4051-0000-7000-8000-00000000000a',
  taskId: 'c0de4051-0000-4000-8000-00000000000a',
  turnId: 'turn-lint-1',
  agentPath: '/root/lint_check',
  nickname: 'Galileo',
  role: 'reviewer',
  model: 'gpt-6-sol',
  reasoningEffort: 'high',
  steps: [
    {
      kind: 'command',
      itemId: 'item_1',
      command: 'npm run lint',
      output: '0 problems',
      exitCode: 0,
    },
    { kind: 'message', itemId: 'item_2', text: 'Lint is clean.' },
  ],
  outcome: { status: 'completed' },
};
const V2_TESTS: CodexAgent = {
  threadId: '019b4051-0000-7000-8000-00000000000b',
  taskId: 'c0de4051-0000-4000-8000-00000000000b',
  turnId: 'turn-tests-1',
  agentPath: '/root/test_run',
  nickname: 'Hypatia',
  role: 'worker',
  model: 'gpt-6-sol',
  reasoningEffort: 'medium',
  steps: [
    {
      kind: 'command',
      itemId: 'item_1',
      command: 'npm test',
      output: '1 failing: test/date.test.ts',
      exitCode: 1,
    },
    { kind: 'message', itemId: 'item_2', text: 'The date test fails.' },
  ],
  outcome: { status: 'failed', error: 'Test run failed: 1 failing test.' },
};

/**
 * Multi-agent v2: the root spawns two agents, `thread/read` fills their
 * metadata, both run a command with the same item id, one fails, and the
 * root waits for both.
 */
export const CODEX_V2_SCENARIO: CodexScenario = {
  name: 'codex-v2',
  version: 'v2',
  rootThreadId: V2_ROOT,
  codexTurnId: 'turn-root-1',
  coreTurnId: 'turn-codex-v2-1',
  userMessageId: 'user-codex-v2-1',
  userText: 'Run lint and the tests in parallel.',
  steps: [
    {
      kind: 'message',
      itemId: 'msg-root-1',
      text: 'Splitting lint and tests across two agents.',
    },
    { kind: 'spawn', spawn: { callId: 'call_spawn_lint', agents: [V2_LINT] } },
    {
      kind: 'spawn',
      spawn: { callId: 'call_spawn_tests', agents: [V2_TESTS] },
    },
    { kind: 'run', agent: V2_LINT },
    { kind: 'run', agent: V2_TESTS },
    {
      kind: 'wait',
      wait: { callId: 'subagent-completed-turn-lint-1', agents: [V2_LINT] },
    },
    {
      kind: 'wait',
      wait: { callId: 'subagent-completed-turn-tests-1', agents: [V2_TESTS] },
    },
    {
      kind: 'message',
      itemId: 'msg-root-2',
      text: 'Lint is clean; the date test fails.',
    },
  ],
};

const V1_ROOT = '019b4051-0000-7000-8000-000000000101';
const V1_DOCS: CodexAgent = {
  threadId: '019b4051-0000-7000-8000-00000000010a',
  taskId: 'c0de4051-0000-4000-8000-00000000010a',
  turnId: 'turn-docs-1',
  agentPath: '/root/docs_check',
  nickname: 'Euclid',
  role: 'reviewer',
  model: 'gpt-6-sol',
  reasoningEffort: 'high',
  steps: [
    {
      kind: 'command',
      itemId: 'item_1',
      command: 'npm run docs:check',
      output: 'All links resolve.',
      exitCode: 0,
    },
    { kind: 'message', itemId: 'item_2', text: 'The docs build.' },
  ],
  outcome: { status: 'completed' },
};
const V1_TYPES: CodexAgent = {
  threadId: '019b4051-0000-7000-8000-00000000010b',
  taskId: 'c0de4051-0000-4000-8000-00000000010b',
  turnId: 'turn-types-1',
  agentPath: '/root/type_check',
  nickname: 'Noether',
  role: 'reviewer',
  model: 'gpt-6-sol',
  reasoningEffort: 'high',
  steps: [
    {
      kind: 'command',
      itemId: 'item_1',
      command: 'npm run typecheck',
      output: 'src/date.ts(4,7): error TS2322',
      exitCode: 2,
    },
  ],
  outcome: { status: 'failed', error: 'Type check failed with 1 error.' },
};

/**
 * Multi-agent v1: one `spawnAgent` call starts two receivers, both run a
 * command with the item id `item_1`, one fails, and one `wait` covers both.
 */
export const CODEX_V1_SCENARIO: CodexScenario = {
  name: 'codex-v1',
  version: 'v1',
  rootThreadId: V1_ROOT,
  codexTurnId: 'turn-root-1',
  coreTurnId: 'turn-codex-v1-1',
  userMessageId: 'user-codex-v1-1',
  userText: 'Check the docs and the types.',
  steps: [
    {
      kind: 'spawn',
      spawn: {
        callId: 'spawn_pair',
        prompt: 'Check one area each and report what fails.',
        agents: [V1_DOCS, V1_TYPES],
      },
    },
    { kind: 'run', agent: V1_DOCS },
    { kind: 'run', agent: V1_TYPES },
    {
      kind: 'wait',
      wait: { callId: 'wait_pair', agents: [V1_DOCS, V1_TYPES] },
    },
    {
      kind: 'message',
      itemId: 'msg-root-1',
      text: 'The docs build; the type check fails.',
    },
  ],
};

// ---------------------------------------------------------------------------
// Timeline
// ---------------------------------------------------------------------------

type TimelineEvent =
  | { readonly type: 'root-start' }
  | { readonly type: 'root-end' }
  | {
      readonly type: 'root-message';
      readonly itemId: string;
      readonly text: string;
    }
  | { readonly type: 'spawn-start'; readonly spawn: CodexSpawn }
  | { readonly type: 'spawn-done'; readonly spawn: CodexSpawn }
  | { readonly type: 'metadata'; readonly agent: CodexAgent }
  | { readonly type: 'child-start'; readonly agent: CodexAgent }
  | {
      readonly type: 'child-command-start';
      readonly agent: CodexAgent;
      readonly step: CodexCommandStep;
    }
  | {
      readonly type: 'child-command-done';
      readonly agent: CodexAgent;
      readonly step: CodexCommandStep;
    }
  | {
      readonly type: 'child-message';
      readonly agent: CodexAgent;
      readonly step: CodexMessageStep;
    }
  | { readonly type: 'child-end'; readonly agent: CodexAgent }
  | { readonly type: 'wait'; readonly wait: CodexWait };

interface TimedEvent {
  readonly at: number;
  readonly event: TimelineEvent;
}

function codexTimeline(scenario: CodexScenario): readonly TimedEvent[] {
  const events: TimedEvent[] = [];
  let tick = 0;
  const push = (event: TimelineEvent): void => {
    tick += 1;
    events.push({ at: PARITY_T0 + tick * 1000, event });
  };
  push({ type: 'root-start' });
  for (const step of scenario.steps) {
    if (step.kind === 'message') {
      push({ type: 'root-message', itemId: step.itemId, text: step.text });
    } else if (step.kind === 'spawn') {
      if (scenario.version === 'v1')
        push({ type: 'spawn-start', spawn: step.spawn });
      push({ type: 'spawn-done', spawn: step.spawn });
      for (const agent of step.spawn.agents) push({ type: 'metadata', agent });
    } else if (step.kind === 'run') {
      push({ type: 'child-start', agent: step.agent });
      for (const child of step.agent.steps) {
        if (child.kind === 'command') {
          push({ type: 'child-command-start', agent: step.agent, step: child });
          push({ type: 'child-command-done', agent: step.agent, step: child });
        } else {
          push({ type: 'child-message', agent: step.agent, step: child });
        }
      }
      push({ type: 'child-end', agent: step.agent });
    } else {
      push({ type: 'wait', wait: step.wait });
    }
  }
  push({ type: 'root-end' });
  return events;
}

function agentState(
  agent: CodexAgent,
  settled: boolean,
): { readonly status: string; readonly message: string | null } {
  if (!settled) return { status: 'running', message: null };
  return agent.outcome.status === 'failed'
    ? { status: 'errored', message: agent.outcome.error }
    : { status: 'completed', message: lastMessage(agent) };
}

function lastMessage(agent: CodexAgent): string | null {
  const messages = agent.steps.flatMap((step) =>
    step.kind === 'message' ? [step.text] : [],
  );
  return messages.at(-1) ?? null;
}

// ---------------------------------------------------------------------------
// Desktop form
// ---------------------------------------------------------------------------

/** The Codex events desktop's chat store receives, in order. */
export function codexDesktopEvents(
  scenario: CodexScenario,
): readonly DesktopRecordedEvent[] {
  const recorded: DesktopRecordedEvent[] = [];
  const codex = (at: number, event: Record<string, unknown>): void => {
    recorded.push({ at, data: { type: 'codex', event } });
  };
  const root = scenario.rootThreadId;
  const rootItem = (
    type: string,
    item: Record<string, unknown>,
  ): Record<string, unknown> => ({
    type,
    thread_id: root,
    turn_id: scenario.codexTurnId,
    item,
  });
  const collab = (
    callId: string,
    tool: string,
    status: string,
    agents: readonly CodexAgent[],
    settled: boolean,
    prompt: string,
  ): Record<string, unknown> => ({
    id: callId,
    type: 'collab_agent_tool_call',
    tool,
    status,
    sender_thread_id: root,
    receiver_thread_ids: agents.map((agent) => agent.threadId),
    prompt,
    agents_states: Object.fromEntries(
      agents.map((agent) => [agent.threadId, agentState(agent, settled)]),
    ),
  });
  for (const { at, event } of codexTimeline(scenario)) {
    switch (event.type) {
      case 'root-start':
        recorded.push({
          at,
          data: {
            type: 'canopy_user_prompt',
            original_text: scenario.userText,
            user_message_id: scenario.userMessageId,
          },
        });
        codex(at, {
          type: 'thread.started',
          thread_id: root,
          model: 'gpt-6-sol',
          source: 'vscode',
        });
        codex(at, {
          type: 'turn.started',
          thread_id: root,
          turn_id: scenario.codexTurnId,
        });
        break;
      case 'root-end':
        codex(at, {
          type: 'turn.completed',
          thread_id: root,
          turn_id: scenario.codexTurnId,
        });
        break;
      case 'root-message':
        codex(
          at,
          rootItem('item.completed', {
            id: event.itemId,
            type: 'agent_message',
            text: event.text,
            phase: '',
          }),
        );
        break;
      case 'spawn-start':
        codex(
          at,
          rootItem('item.started', {
            ...collab(
              event.spawn.callId,
              'spawnAgent',
              'inProgress',
              [],
              false,
              event.spawn.prompt ?? '',
            ),
            model: 'gpt-6-sol',
            reasoning_effort: 'high',
          }),
        );
        break;
      case 'spawn-done':
        if (scenario.version === 'v1') {
          codex(
            at,
            rootItem('item.completed', {
              ...collab(
                event.spawn.callId,
                'spawnAgent',
                'completed',
                event.spawn.agents,
                false,
                event.spawn.prompt ?? '',
              ),
              model: 'gpt-6-sol',
              reasoning_effort: 'high',
            }),
          );
        } else {
          for (const agent of event.spawn.agents)
            codex(
              at,
              rootItem('item.completed', {
                id: event.spawn.callId,
                type: 'sub_agent_activity',
                kind: 'started',
                agent_thread_id: agent.threadId,
                agent_path: agent.agentPath,
              }),
            );
        }
        break;
      case 'metadata':
        codex(at, {
          type: 'thread.started',
          thread_id: event.agent.threadId,
          agent_nickname: event.agent.nickname,
          agent_role: event.agent.role,
          parent_thread_id: root,
          model: event.agent.model,
          reasoning_effort: event.agent.reasoningEffort,
          source: {
            subAgent: {
              thread_spawn: {
                parent_thread_id: root,
                depth: 1,
                agent_path: event.agent.agentPath,
                agent_nickname: event.agent.nickname,
                agent_role: event.agent.role,
              },
            },
          },
        });
        break;
      case 'child-start':
        codex(at, {
          type: 'turn.started',
          thread_id: event.agent.threadId,
          turn_id: event.agent.turnId,
        });
        break;
      case 'child-command-start':
      case 'child-command-done': {
        const done = event.type === 'child-command-done';
        codex(at, {
          type: done ? 'item.completed' : 'item.started',
          thread_id: event.agent.threadId,
          turn_id: event.agent.turnId,
          item: {
            id: event.step.itemId,
            type: 'command_execution',
            command: event.step.command,
            aggregated_output: done ? event.step.output : '',
            status: done
              ? event.step.exitCode === 0
                ? 'completed'
                : 'failed'
              : 'inProgress',
            exit_code: done ? event.step.exitCode : null,
          },
        });
        break;
      }
      case 'child-message':
        codex(at, {
          type: 'item.completed',
          thread_id: event.agent.threadId,
          turn_id: event.agent.turnId,
          item: {
            id: event.step.itemId,
            type: 'agent_message',
            text: event.step.text,
            phase: '',
          },
        });
        break;
      case 'child-end':
        codex(
          at,
          event.agent.outcome.status === 'failed'
            ? {
                type: 'turn.failed',
                thread_id: event.agent.threadId,
                turn_id: event.agent.turnId,
                error: { message: event.agent.outcome.error },
              }
            : {
                type: 'turn.completed',
                thread_id: event.agent.threadId,
                turn_id: event.agent.turnId,
                status: 'completed',
              },
        );
        break;
      case 'wait':
        if (scenario.version === 'v1') {
          codex(
            at,
            rootItem(
              'item.completed',
              collab(
                event.wait.callId,
                'wait',
                'completed',
                event.wait.agents,
                true,
                '',
              ),
            ),
          );
        } else {
          for (const agent of event.wait.agents)
            codex(
              at,
              rootItem('item.completed', {
                id: event.wait.callId,
                type: 'sub_agent_activity',
                kind: 'completed',
                agent_thread_id: agent.threadId,
                agent_path: agent.agentPath,
              }),
            );
        }
        break;
    }
  }
  return recorded;
}

// ---------------------------------------------------------------------------
// Cloud form
// ---------------------------------------------------------------------------

/** Agentic Core's record of a Codex scenario. */
export function codexCloudRecording(scenario: CodexScenario): CloudRecording {
  const events: CoreRecordedEvent[] = [];
  const messages: CoreMessageRow[] = [];
  const tasks = new Map<string, Record<string, unknown>>();
  const versions = new Map<string, number>();
  const spawnOf = new Map<string, CodexSpawn>();
  const settled = new Set<string>();
  const turnKey = `turn:${scenario.coreTurnId}`;
  const taskKey = (agent: CodexAgent): string =>
    `${turnKey}:task:${agent.taskId}`;
  let seq = 0;
  const emit = (
    at: number,
    type: string,
    payload: Record<string, unknown>,
    taskId?: string,
  ): void => {
    seq += 1;
    events.push({
      seq: String(seq),
      type,
      occurredAt: isoAt(at),
      ...(taskId === undefined ? {} : { taskId }),
      payload,
    });
  };
  const rootBlocks: (
    | { readonly type: 'text'; readonly text: string }
    | {
        readonly type: 'tool_call';
        readonly toolCallId: string;
        readonly toolName: string;
      }
  )[] = [];
  const childBlocks = new Map<string, typeof rootBlocks>();
  const known = new Set<string>();
  const receiverAgents = (
    agents: readonly CodexAgent[],
  ): Record<string, Record<string, string>> => {
    const receivers: Record<string, Record<string, string>> = {};
    for (const agent of agents)
      receivers[agent.threadId] = known.has(agent.threadId)
        ? {
            nickname: agent.nickname,
            role: agent.role,
            agentPath: agent.agentPath,
            model: agent.model,
            reasoningEffort: agent.reasoningEffort,
          }
        : { agentPath: agent.agentPath };
    return receivers;
  };
  const upsert = (
    at: number,
    agent: CodexAgent,
    status: 'pending' | 'running' | 'completed' | 'failed',
  ): void => {
    const spawn = spawnOf.get(agent.threadId);
    if (spawn === undefined) throw new Error('Unknown spawn');
    const version = (versions.get(agent.taskId) ?? 0) + 1;
    versions.set(agent.taskId, version);
    const previous = tasks.get(agent.taskId);
    const createdAt =
      typeof previous?.createdAt === 'string' ? previous.createdAt : isoAt(at);
    const startedAt =
      typeof previous?.startedAt === 'string'
        ? previous.startedAt
        : status === 'pending'
          ? null
          : isoAt(at);
    const terminal = status === 'completed' || status === 'failed';
    const identified = known.has(agent.threadId);
    const row: Record<string, unknown> = {
      taskId: agent.taskId,
      parentTaskId: null,
      spawnTurnId: scenario.coreTurnId,
      spawnToolCallId: spawn.callId,
      kind: 'subagent',
      harness: 'CODEX',
      native: {
        threadId: agent.threadId,
        callId: spawn.callId,
        rootThreadId: scenario.rootThreadId,
        agentPath: agent.agentPath,
      },
      title: identified ? agent.nickname : null,
      description: null,
      prompt: spawn.prompt ?? null,
      subagentType: identified ? agent.role : null,
      model: identified ? { id: agent.model } : null,
      thinkingEffort: identified ? agent.reasoningEffort : null,
      status,
      approvalPending: false,
      stopReason: null,
      background: false,
      usage: null,
      costUsd: null,
      summary: status === 'completed' ? (lastMessage(agent) ?? null) : null,
      outputTail: null,
      error:
        status === 'failed' && agent.outcome.status === 'failed'
          ? { code: 'codex_turn_failed', message: agent.outcome.error }
          : null,
      createdAt,
      startedAt,
      updatedAt: isoAt(at),
      completedAt: terminal ? isoAt(at) : null,
      stateVersion: String(PARITY_T0 * 1000 + version),
    };
    tasks.set(agent.taskId, row);
    emit(at, 'task.upsert', { task: row, sourceKey: turnKey });
  };
  const collabArgs = (
    agents: readonly CodexAgent[],
    prompt: string | null,
  ): Record<string, unknown> => ({
    senderThreadId: scenario.rootThreadId,
    receiverThreadIds: agents.map((agent) => agent.threadId),
    receiverTaskIds: agents.map((agent) => agent.taskId),
    receiverAgents: receiverAgents(agents),
    prompt,
    model: null,
    reasoningEffort: null,
  });
  const collabCall = (
    at: number,
    callId: string,
    toolName: string,
    args: Record<string, unknown>,
  ): void => {
    rootBlocks.push({ type: 'tool_call', toolCallId: callId, toolName });
    emit(at, 'tool.call', {
      toolName,
      toolCallId: callId,
      args,
      sourceKey: turnKey,
    });
  };
  const collabResult = (
    at: number,
    callId: string,
    toolName: string,
    agents: readonly CodexAgent[],
  ): void => {
    emit(at, 'tool.result', {
      toolName,
      toolCallId: callId,
      result: {
        status: 'completed',
        senderThreadId: scenario.rootThreadId,
        receiverThreadIds: agents.map((agent) => agent.threadId),
        receiverTaskIds: agents.map((agent) => agent.taskId),
        receiverAgents: receiverAgents(agents),
        agentsStates: Object.fromEntries(
          agents.map((agent) => [
            agent.threadId,
            agentState(agent, settled.has(agent.threadId)),
          ]),
        ),
      },
      sourceKey: turnKey,
    });
  };

  for (const { at, event } of codexTimeline(scenario)) {
    switch (event.type) {
      case 'root-start':
        messages.push({
          id: `core-msg-${scenario.userMessageId}`,
          turnId: scenario.coreTurnId,
          role: 'USER',
          content: scenario.userText,
          createdAt: isoAt(at),
        });
        emit(at, 'message.start', {
          turnId: scenario.coreTurnId,
          sourceKey: turnKey,
          role: 'assistant',
        });
        break;
      case 'root-end': {
        // Core posts each task's message when the root turn's stream closes.
        for (const [taskId, blocks] of Array.from(childBlocks.entries())) {
          if (blocks.length === 0) continue;
          const agent = scenario.steps
            .flatMap((step) => (step.kind === 'run' ? [step.agent] : []))
            .find((candidate) => candidate.taskId === taskId);
          if (agent === undefined) continue;
          const content = blocks
            .flatMap((block) => (block.type === 'text' ? [block.text] : []))
            .join('\n\n');
          const messageId = `core-msg-${taskKey(agent)}`;
          messages.push({
            id: messageId,
            turnId: scenario.coreTurnId,
            taskId,
            role: 'ASSISTANT',
            sourceKey: taskKey(agent),
            content,
            contentBlocks: blocks,
            createdAt: isoAt(at),
          });
          emit(
            at,
            'message.finish',
            {
              taskId,
              sourceKey: taskKey(agent),
              turnSourceKey: turnKey,
              finalMessage: { content, contentBlocks: blocks },
              messageId,
            },
            taskId,
          );
        }
        const text = rootBlocks
          .flatMap((block) => (block.type === 'text' ? [block.text] : []))
          .join('\n\n');
        messages.push({
          id: `core-msg-${turnKey}`,
          turnId: scenario.coreTurnId,
          role: 'ASSISTANT',
          sourceKey: turnKey,
          content: text,
          contentBlocks: [...rootBlocks],
          createdAt: isoAt(PARITY_T0 + 1000),
        });
        emit(at, 'message.finish', {
          sourceKey: turnKey,
          ...(text.length > 0 ? { finalMessage: { content: text } } : {}),
        });
        break;
      }
      case 'root-message':
        rootBlocks.push({ type: 'text', text: event.text });
        emit(at, 'message.delta', {
          sourceKey: turnKey,
          textDelta: event.text,
        });
        break;
      case 'spawn-start':
        for (const agent of event.spawn.agents)
          spawnOf.set(agent.threadId, event.spawn);
        collabCall(at, event.spawn.callId, 'spawnAgent', {
          ...collabArgs([], event.spawn.prompt ?? null),
          model: 'gpt-6-sol',
          reasoningEffort: 'high',
        });
        break;
      case 'spawn-done':
        for (const agent of event.spawn.agents) {
          spawnOf.set(agent.threadId, event.spawn);
          upsert(at, agent, 'pending');
        }
        if (scenario.version === 'v2')
          collabCall(
            at,
            event.spawn.callId,
            'spawnAgent',
            collabArgs(event.spawn.agents, null),
          );
        collabResult(at, event.spawn.callId, 'spawnAgent', event.spawn.agents);
        break;
      case 'metadata':
        known.add(event.agent.threadId);
        upsert(at, event.agent, 'pending');
        break;
      case 'child-start':
        upsert(at, event.agent, 'running');
        childBlocks.set(event.agent.taskId, []);
        break;
      case 'child-command-start':
        childBlocks.get(event.agent.taskId)?.push({
          type: 'tool_call',
          toolCallId: event.step.itemId,
          toolName: 'bash',
        });
        emit(
          at,
          'tool.call',
          {
            taskId: event.agent.taskId,
            sourceKey: taskKey(event.agent),
            toolName: 'bash',
            toolCallId: event.step.itemId,
            args: { command: event.step.command },
          },
          event.agent.taskId,
        );
        break;
      case 'child-command-done':
        emit(
          at,
          'tool.result',
          {
            taskId: event.agent.taskId,
            sourceKey: taskKey(event.agent),
            toolName: 'bash',
            toolCallId: event.step.itemId,
            result: {
              exitCode: event.step.exitCode,
              output: event.step.output,
              status: event.step.exitCode === 0 ? 'completed' : 'failed',
            },
          },
          event.agent.taskId,
        );
        break;
      case 'child-message':
        childBlocks
          .get(event.agent.taskId)
          ?.push({ type: 'text', text: event.step.text });
        emit(
          at,
          'message.delta',
          {
            taskId: event.agent.taskId,
            sourceKey: taskKey(event.agent),
            textDelta: event.step.text,
          },
          event.agent.taskId,
        );
        break;
      case 'child-end': {
        settled.add(event.agent.threadId);
        upsert(at, event.agent, event.agent.outcome.status);
        if (event.agent.outcome.status === 'failed')
          emit(
            at,
            'harness.event',
            {
              kind: 'task_error',
              taskId: event.agent.taskId,
              sourceKey: taskKey(event.agent),
              errorCode: 'codex_turn_failed',
              errorMessage: event.agent.outcome.error,
            },
            event.agent.taskId,
          );
        break;
      }
      case 'wait':
        collabCall(
          at,
          event.wait.callId,
          'wait',
          collabArgs(event.wait.agents, null),
        );
        collabResult(at, event.wait.callId, 'wait', event.wait.agents);
        break;
    }
  }
  return { events, messages, tasks: Array.from(tasks.values()) };
}
