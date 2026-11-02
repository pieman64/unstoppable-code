/**
 * The Claude parity scenario (CAN-4051): one recorded root chat, written once
 * and rendered in the two forms each host records it in.
 *
 * - `claudeDesktopEvents`: the Claude Agent SDK stream (and canopy prompt
 *   events) the desktop chat store applies and persists.
 * - `claudeCloudRecording`: the Agentic Core durable event log, message rows
 *   and task rows the web reads live (SSE frames) and on reload.
 *
 * Both are derived from `CLAUDE_PARITY_SCENARIO` through one timeline, so a
 * change to the scenario changes both forms together.
 */
import type { BackgroundTask } from '@canopy/protocol/background-tasks';
import {
  PARITY_T0,
  isoAt,
  type DesktopRecordedEvent,
  type CoreRecordedEvent,
  type CoreMessageRow,
  type CloudRecording,
} from './recording';

interface ClaudeTextStep {
  readonly kind: 'text';
  readonly text: string;
}

interface ClaudeToolStep {
  readonly kind: 'tool';
  readonly toolUseId: string;
  readonly name: string;
  readonly input: Readonly<Record<string, unknown>>;
  readonly output: string;
  readonly isError?: boolean;
}

type ClaudeOutcome =
  | { readonly status: 'completed'; readonly result: string }
  | { readonly status: 'failed'; readonly error: string };

interface ClaudeAgentStep {
  readonly kind: 'agent';
  readonly toolUseId: string;
  /** Core's task id. */
  readonly taskId: string;
  /** Claude's own agent id (its background task id). */
  readonly agentId: string;
  readonly subagentType: string;
  readonly description: string;
  readonly prompt: string;
  readonly background?: true;
  readonly steps: readonly ClaudeStep[];
  readonly outcome: ClaudeOutcome;
}

interface ClaudeShellStep {
  readonly kind: 'shell';
  readonly toolUseId: string;
  readonly taskId: string;
  readonly shellId: string;
  readonly command: string;
  readonly description: string;
  readonly outputLines: readonly string[];
  readonly summary: string;
}

type ClaudeStep =
  | ClaudeTextStep
  | ClaudeToolStep
  | ClaudeAgentStep
  | ClaudeShellStep;

interface ClaudeTurn {
  readonly turnId: string;
  readonly userMessageId: string;
  readonly userText: string;
  readonly steps: readonly ClaudeStep[];
}

/** The model every agent runs on, and the label each host's catalog gives it. */
export const CLAUDE_PARITY_MODEL = {
  id: 'claude-sonnet-4-5',
  label: 'Claude Sonnet 4.5',
} as const;
const MODEL = CLAUDE_PARITY_MODEL;

/**
 * A parent splits work across two foreground subagents, one of which spawns a
 * nested subagent and one of which fails. A follow-up message then starts a
 * background shell and a background subagent.
 */
export const CLAUDE_PARITY_SCENARIO: readonly ClaudeTurn[] = [
  {
    turnId: 'turn-claude-1',
    userMessageId: 'user-claude-1',
    userText: 'Map the API routes and fix the failing date test.',
    steps: [
      { kind: 'text', text: "I'll split this across two subagents." },
      {
        kind: 'agent',
        toolUseId: 'toolu_01ExploreRoutes',
        taskId: 'a51a0e2c-1d6f-4b0e-9a51-000000000001',
        agentId: 'a1c0ffee01',
        subagentType: 'Explore',
        description: 'Map the API routes',
        prompt: 'List every route in src/routes.ts and the handler it calls.',
        steps: [
          { kind: 'text', text: 'Reading the route table.' },
          {
            kind: 'tool',
            toolUseId: 'toolu_01ReadRoutes',
            name: 'Read',
            input: { file_path: 'src/routes.ts' },
            output:
              "export const routes = [\n  ['/health', health],\n  ['/users', requireAuth(users)],\n];",
          },
          {
            kind: 'agent',
            toolUseId: 'toolu_01CheckAuth',
            taskId: 'a51a0e2c-1d6f-4b0e-9a51-000000000002',
            agentId: 'a1c0ffee02',
            subagentType: 'general-purpose',
            description: 'Check the auth middleware',
            prompt: 'Report which routes in src/routes.ts skip requireAuth.',
            steps: [
              {
                kind: 'tool',
                toolUseId: 'toolu_01GrepAuth',
                name: 'Grep',
                input: { pattern: 'requireAuth', path: 'src' },
                output: "src/routes.ts:3:  ['/users', requireAuth(users)],",
              },
              { kind: 'text', text: 'Only /health skips requireAuth.' },
            ],
            outcome: {
              status: 'completed',
              result: 'Only /health skips requireAuth.',
            },
          },
          {
            kind: 'text',
            text: 'Mapped 2 routes; only /health skips requireAuth.',
          },
        ],
        outcome: {
          status: 'completed',
          result: 'Mapped 2 routes; only /health skips requireAuth.',
        },
      },
      {
        kind: 'agent',
        toolUseId: 'toolu_01FixDateTest',
        taskId: 'a51a0e2c-1d6f-4b0e-9a51-000000000003',
        agentId: 'a1c0ffee03',
        subagentType: 'general-purpose',
        description: 'Fix the failing date test',
        prompt: 'Make test/date.test.ts pass without changing its assertion.',
        steps: [
          {
            kind: 'tool',
            toolUseId: 'toolu_01RunDateTest',
            name: 'Bash',
            input: {
              command: 'npm test -- test/date.test.ts',
              description: 'Run the date test',
            },
            output:
              'FAIL test/date.test.ts\n  expected 2026-10-16, received 2026-10-15',
            isError: true,
          },
          {
            kind: 'text',
            text: 'The fixture uses the host time zone, so the assertion cannot pass as written.',
          },
        ],
        outcome: {
          status: 'failed',
          error: 'Could not make test/date.test.ts pass without changing it.',
        },
      },
      {
        kind: 'text',
        text: 'The routes are mapped. The date test still fails.',
      },
    ],
  },
  {
    turnId: 'turn-claude-2',
    userMessageId: 'user-claude-2',
    userText:
      'Run the full suite in the background and watch the dev server logs.',
    steps: [
      { kind: 'text', text: 'Starting both in the background.' },
      {
        kind: 'shell',
        toolUseId: 'toolu_01FullSuite',
        taskId: 'a51a0e2c-1d6f-4b0e-9a51-000000000004',
        shellId: 'bash_7f3a',
        command: 'npm test',
        description: 'Run the full test suite',
        outputLines: ['PASS test/routes.test.ts', 'Tests: 41 passed, 41 total'],
        summary: 'Background command "Run the full test suite" completed',
      },
      {
        kind: 'agent',
        toolUseId: 'toolu_01WatchLogs',
        taskId: 'a51a0e2c-1d6f-4b0e-9a51-000000000005',
        agentId: 'a1c0ffee05',
        subagentType: 'general-purpose',
        description: 'Watch the dev server logs',
        prompt: 'Tail the dev server log and report the first request.',
        background: true,
        steps: [
          {
            kind: 'tool',
            toolUseId: 'toolu_01TailLog',
            name: 'Bash',
            input: {
              command: 'tail -n 20 logs/dev.log',
              description: 'Read the dev log',
            },
            output: 'GET /health 200 3ms',
          },
          { kind: 'text', text: 'The first request was GET /health.' },
        ],
        outcome: {
          status: 'completed',
          result: 'The first request was GET /health.',
        },
      },
      { kind: 'text', text: 'Both are running.' },
    ],
  },
];

// ---------------------------------------------------------------------------
// Timeline: the scenario as one ordered list of facts with times.
// ---------------------------------------------------------------------------

type Scope = ClaudeAgentStep | null;

type TimelineEvent =
  | { readonly type: 'user'; readonly turn: ClaudeTurn }
  | { readonly type: 'turn-start'; readonly turn: ClaudeTurn }
  | { readonly type: 'turn-end'; readonly turn: ClaudeTurn }
  | {
      readonly type: 'text';
      readonly scope: Scope;
      readonly text: string;
      readonly segment: number;
    }
  | {
      readonly type: 'tool-call';
      readonly scope: Scope;
      readonly step: ClaudeToolStep;
    }
  | {
      readonly type: 'tool-result';
      readonly scope: Scope;
      readonly step: ClaudeToolStep;
    }
  | {
      readonly type: 'spawn';
      readonly scope: Scope;
      readonly agent: ClaudeAgentStep;
    }
  | {
      readonly type: 'agent-start';
      readonly scope: Scope;
      readonly agent: ClaudeAgentStep;
    }
  | {
      readonly type: 'agent-launched';
      readonly scope: Scope;
      readonly agent: ClaudeAgentStep;
    }
  | {
      readonly type: 'agent-settle';
      readonly scope: Scope;
      readonly agent: ClaudeAgentStep;
    }
  | {
      readonly type: 'shell-spawn';
      readonly scope: Scope;
      readonly shell: ClaudeShellStep;
    }
  | {
      readonly type: 'shell-launched';
      readonly scope: Scope;
      readonly shell: ClaudeShellStep;
    }
  | {
      readonly type: 'shell-output';
      readonly shell: ClaudeShellStep;
    }
  | {
      readonly type: 'shell-settle';
      readonly scope: Scope;
      readonly shell: ClaudeShellStep;
    };

interface TimedEvent {
  readonly at: number;
  readonly event: TimelineEvent;
}

function claudeTimeline(): readonly TimedEvent[] {
  const events: TimedEvent[] = [];
  let tick = 0;
  const push = (event: TimelineEvent): void => {
    tick += 1;
    events.push({ at: PARITY_T0 + tick * 1000, event });
  };
  const runSteps = (scope: Scope, steps: readonly ClaudeStep[]): void => {
    let segment = 0;
    for (const step of steps) {
      if (step.kind === 'text') {
        push({ type: 'text', scope, text: step.text, segment });
        segment += 1;
      } else if (step.kind === 'tool') {
        push({ type: 'tool-call', scope, step });
        push({ type: 'tool-result', scope, step });
      } else if (step.kind === 'agent') {
        push({ type: 'spawn', scope, agent: step });
        push({ type: 'agent-start', scope, agent: step });
        if (step.background)
          push({ type: 'agent-launched', scope, agent: step });
        runSteps(step, step.steps);
        push({ type: 'agent-settle', scope, agent: step });
      } else {
        push({ type: 'shell-spawn', scope, shell: step });
        push({ type: 'shell-launched', scope, shell: step });
        push({ type: 'shell-output', shell: step });
        push({ type: 'shell-settle', scope, shell: step });
      }
    }
  };
  for (const turn of CLAUDE_PARITY_SCENARIO) {
    push({ type: 'user', turn });
    push({ type: 'turn-start', turn });
    runSteps(null, turn.steps);
    push({ type: 'turn-end', turn });
  }
  return events;
}

// ---------------------------------------------------------------------------
// Desktop form: the Claude Agent SDK stream.
// ---------------------------------------------------------------------------

function agentInput(agent: ClaudeAgentStep): Record<string, unknown> {
  return {
    subagent_type: agent.subagentType,
    description: agent.description,
    prompt: agent.prompt,
    ...(agent.background ? { run_in_background: true } : {}),
  };
}

function shellInput(shell: ClaudeShellStep): Record<string, unknown> {
  return {
    command: shell.command,
    description: shell.description,
    run_in_background: true,
  };
}

function agentLaunchReceipt(agent: ClaudeAgentStep): string {
  return `Async agent launched successfully.\nagentId: ${agent.agentId} (internal ID - do not mention to user. Use SendMessage with to: '${agent.agentId}' to continue this agent.)\nThe agent is working in the background. You will be notified automatically when it completes.`;
}

function shellLaunchReceipt(shell: ClaudeShellStep): string {
  return `Command running in background with ID: ${shell.shellId}. Output is being written to: ${shellOutputFile(shell)}`;
}

function shellOutputFile(shell: ClaudeShellStep): string {
  return `/tmp/claude-parity/tasks/${shell.shellId}.output`;
}

function agentOutcomeText(agent: ClaudeAgentStep): string {
  return agent.outcome.status === 'completed'
    ? agent.outcome.result
    : agent.outcome.error;
}

/** The Claude SDK and canopy events desktop records, in order. */
export function claudeDesktopEvents(): readonly DesktopRecordedEvent[] {
  const recorded: DesktopRecordedEvent[] = [];
  let sequence = 0;
  const parent = (scope: Scope): Record<string, unknown> =>
    scope === null ? {} : { parent_tool_use_id: scope.toolUseId };
  const assistant = (
    at: number,
    scope: Scope,
    content: readonly Record<string, unknown>[],
  ): void => {
    sequence += 1;
    recorded.push({
      at,
      data: {
        type: 'assistant',
        uuid: `claude-uuid-${sequence}`,
        ...parent(scope),
        message: {
          id: `msg_parity_${sequence}`,
          type: 'message',
          role: 'assistant',
          model: MODEL.id,
          content,
          usage: {
            input_tokens: 1200,
            output_tokens: 80,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
          },
        },
      },
    });
  };
  const toolResult = (
    at: number,
    scope: Scope,
    toolUseId: string,
    content: string,
    isError: boolean,
  ): void => {
    sequence += 1;
    recorded.push({
      at,
      data: {
        type: 'user',
        uuid: `claude-uuid-${sequence}`,
        ...parent(scope),
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: toolUseId,
              content,
              ...(isError ? { is_error: true } : {}),
            },
          ],
        },
      },
    });
  };
  for (const { at, event } of claudeTimeline()) {
    switch (event.type) {
      case 'user':
        recorded.push({
          at,
          data: {
            type: 'canopy_user_prompt',
            original_text: event.turn.userText,
            user_message_id: event.turn.userMessageId,
          },
        });
        break;
      case 'turn-start':
        break;
      case 'turn-end':
        recorded.push({
          at,
          data: {
            type: 'result',
            subtype: 'success',
            is_error: false,
            result: '',
            session_id: 'claude-parity-session',
          },
        });
        break;
      case 'text':
        assistant(at, event.scope, [{ type: 'text', text: event.text }]);
        break;
      case 'tool-call':
        assistant(at, event.scope, [
          {
            type: 'tool_use',
            id: event.step.toolUseId,
            name: event.step.name,
            input: event.step.input,
          },
        ]);
        break;
      case 'tool-result':
        toolResult(
          at,
          event.scope,
          event.step.toolUseId,
          event.step.output,
          event.step.isError === true,
        );
        break;
      case 'spawn':
        assistant(at, event.scope, [
          {
            type: 'tool_use',
            id: event.agent.toolUseId,
            name: 'Agent',
            input: agentInput(event.agent),
          },
        ]);
        break;
      case 'agent-start':
        recorded.push({
          at,
          data: {
            type: 'system',
            subtype: 'task_started',
            task_id: event.agent.agentId,
            tool_use_id: event.agent.toolUseId,
            description: event.agent.description,
            is_backgrounded: event.agent.background === true,
          },
        });
        break;
      case 'agent-launched':
        toolResult(
          at,
          event.scope,
          event.agent.toolUseId,
          agentLaunchReceipt(event.agent),
          false,
        );
        break;
      case 'agent-settle':
        if (event.agent.background) {
          recorded.push({
            at,
            data: {
              type: 'system',
              subtype: 'task_notification',
              task_id: event.agent.agentId,
              tool_use_id: event.agent.toolUseId,
              status: event.agent.outcome.status,
              summary: agentOutcomeText(event.agent),
            },
          });
        } else {
          toolResult(
            at,
            event.scope,
            event.agent.toolUseId,
            agentOutcomeText(event.agent),
            event.agent.outcome.status === 'failed',
          );
        }
        break;
      case 'shell-spawn':
        assistant(at, event.scope, [
          {
            type: 'tool_use',
            id: event.shell.toolUseId,
            name: 'Bash',
            input: shellInput(event.shell),
          },
        ]);
        break;
      case 'shell-launched':
        recorded.push({
          at,
          data: {
            type: 'system',
            subtype: 'task_started',
            task_id: event.shell.shellId,
            tool_use_id: event.shell.toolUseId,
            description: event.shell.description,
            task_type: 'local_bash',
            is_backgrounded: true,
          },
        });
        toolResult(
          at,
          event.scope,
          event.shell.toolUseId,
          shellLaunchReceipt(event.shell),
          false,
        );
        break;
      case 'shell-output':
        recorded.push({
          at,
          output: {
            taskId: event.shell.shellId,
            outputFile: shellOutputFile(event.shell),
            lines: event.shell.outputLines,
          },
        });
        break;
      case 'shell-settle':
        recorded.push({
          at,
          data: {
            type: 'system',
            subtype: 'task_notification',
            task_id: event.shell.shellId,
            tool_use_id: event.shell.toolUseId,
            status: 'completed',
            summary: event.shell.summary,
            output_file: shellOutputFile(event.shell),
          },
        });
        break;
    }
  }
  return recorded;
}

// ---------------------------------------------------------------------------
// Cloud form: Agentic Core's durable events, message rows and task rows.
// ---------------------------------------------------------------------------

function turnSourceKey(turn: ClaudeTurn): string {
  return `turn:${turn.turnId}`;
}

interface TaskTimes {
  readonly turn: ClaudeTurn;
  readonly createdAt: number;
  readonly completedAt?: number;
  readonly status: 'pending' | 'running' | 'completed' | 'failed';
  readonly version: number;
}

type ClaudeTaskSubject =
  | { readonly kind: 'agent'; readonly agent: ClaudeAgentStep }
  | { readonly kind: 'shell'; readonly shell: ClaudeShellStep };

function taskRow(
  subject: ClaudeTaskSubject,
  parentTaskId: string | null,
  times: TaskTimes,
): Record<string, unknown> {
  const terminal = times.status === 'completed' || times.status === 'failed';
  const base = {
    parentTaskId,
    spawnTurnId: times.turn.turnId,
    harness: 'CLAUDE_CODE',
    status: times.status,
    approvalPending: false,
    stopReason: null,
    usage: null,
    costUsd: null,
    createdAt: isoAt(times.createdAt),
    startedAt: isoAt(times.createdAt),
    updatedAt: isoAt(times.completedAt ?? times.createdAt),
    completedAt:
      terminal && times.completedAt !== undefined
        ? isoAt(times.completedAt)
        : null,
    stateVersion: String(times.version),
  };
  if (subject.kind === 'shell') {
    const { shell } = subject;
    return {
      ...base,
      taskId: shell.taskId,
      spawnToolCallId: shell.toolUseId,
      kind: 'background_shell',
      native: { toolUseId: shell.toolUseId, shellId: shell.shellId },
      title: shell.command,
      description: shell.description,
      prompt: null,
      subagentType: null,
      model: null,
      thinkingEffort: null,
      background: true,
      summary: terminal ? shell.summary : null,
      outputTail: terminal ? `${shell.outputLines.join('\n')}\n` : null,
      error: null,
    };
  }
  const { agent } = subject;
  const failed = agent.outcome.status === 'failed';
  return {
    ...base,
    taskId: agent.taskId,
    spawnToolCallId: agent.toolUseId,
    kind: 'subagent',
    native: {
      toolUseId: agent.toolUseId,
      agentId: agent.agentId,
      taskId: agent.agentId,
    },
    title: agent.description,
    description: agent.description,
    prompt: agent.prompt,
    subagentType: agent.subagentType,
    model: MODEL,
    thinkingEffort: null,
    background: agent.background === true,
    summary:
      terminal && agent.outcome.status === 'completed'
        ? agent.outcome.result
        : null,
    outputTail: null,
    error:
      terminal && failed
        ? { code: 'CLAUDE_TASK_FAILED', message: agentOutcomeText(agent) }
        : null,
  };
}

interface MessageBuilder {
  readonly row: Omit<CoreMessageRow, 'content' | 'contentBlocks'>;
  readonly blocks: (
    | { readonly type: 'text'; readonly text: string }
    | {
        readonly type: 'tool_call';
        readonly toolCallId: string;
        readonly toolName: string;
      }
  )[];
}

/** Agentic Core's record of the same scenario. */
export function claudeCloudRecording(): CloudRecording {
  const events: CoreRecordedEvent[] = [];
  const messages: CoreMessageRow[] = [];
  const tasks = new Map<string, Record<string, unknown>>();
  const versions = new Map<string, number>();
  const taskOf = new Map<ClaudeAgentStep, string>();
  const parentTaskOf = (scope: Scope): string | null =>
    scope === null ? null : (taskOf.get(scope) ?? null);
  const builders = new Map<string, MessageBuilder>();
  let turn: ClaudeTurn | undefined;
  let seq = 0;
  const sourceKeyOf = (scope: Scope): string => {
    if (turn === undefined) throw new Error('No active turn');
    return scope === null
      ? turnSourceKey(turn)
      : `${turnSourceKey(turn)}:task:${scope.taskId}`;
  };
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
  const builderFor = (at: number, scope: Scope): MessageBuilder => {
    const sourceKey = sourceKeyOf(scope);
    const existing = builders.get(sourceKey);
    if (existing) return existing;
    if (turn === undefined) throw new Error('No active turn');
    const builder: MessageBuilder = {
      row: {
        id: `core-msg-${sourceKey}`,
        turnId: turn.turnId,
        role: 'ASSISTANT',
        sourceKey,
        createdAt: isoAt(at),
        ...(scope === null ? {} : { taskId: scope.taskId }),
      },
      blocks: [],
    };
    builders.set(sourceKey, builder);
    return builder;
  };
  const scopedPayload = (scope: Scope): Record<string, unknown> =>
    scope === null
      ? { sourceKey: sourceKeyOf(scope) }
      : { taskId: scope.taskId, sourceKey: sourceKeyOf(scope) };
  const upsert = (
    at: number,
    subject: ClaudeTaskSubject,
    scope: Scope,
    status: TaskTimes['status'],
  ): void => {
    if (turn === undefined) throw new Error('No active turn');
    const id =
      subject.kind === 'agent' ? subject.agent.taskId : subject.shell.taskId;
    const version = (versions.get(id) ?? 0) + 1;
    versions.set(id, version);
    const previous = tasks.get(id);
    const createdAt =
      typeof previous?.createdAt === 'string'
        ? Date.parse(previous.createdAt)
        : at;
    const row = taskRow(subject, parentTaskOf(scope), {
      turn,
      createdAt,
      ...(status === 'completed' || status === 'failed'
        ? { completedAt: at }
        : {}),
      status,
      version,
    });
    tasks.set(id, row);
    emit(at, 'task.upsert', { task: row, sourceKey: sourceKeyOf(scope) });
  };
  const toolCall = (
    at: number,
    scope: Scope,
    toolCallId: string,
    toolName: string,
    args: Readonly<Record<string, unknown>>,
  ): void => {
    builderFor(at, scope).blocks.push({
      type: 'tool_call',
      toolCallId,
      toolName,
    });
    emit(
      at,
      'tool.call',
      { ...scopedPayload(scope), toolCallId, toolName, args },
      scope?.taskId,
    );
  };
  const toolResult = (
    at: number,
    scope: Scope,
    toolCallId: string,
    toolName: string,
    output: string,
    isError: boolean,
  ): void => {
    emit(
      at,
      'tool.result',
      {
        ...scopedPayload(scope),
        toolCallId,
        toolName,
        result: isError ? { isError: true, errorText: output } : output,
      },
      scope?.taskId,
    );
  };
  const finishMessage = (at: number, sourceKey: string): void => {
    const builder = builders.get(sourceKey);
    if (builder === undefined) return;
    builders.delete(sourceKey);
    const text = builder.blocks
      .flatMap((block) => (block.type === 'text' ? [block.text] : []))
      .join('\n\n');
    messages.push({
      ...builder.row,
      content: text,
      contentBlocks: builder.blocks,
    });
    const taskId = builder.row.taskId;
    // A task message (REG-3095) carries its blocks and stored row id.
    emit(
      at,
      'message.finish',
      taskId === undefined
        ? {
            sourceKey,
            ...(text.length > 0 ? { finalMessage: { content: text } } : {}),
          }
        : {
            taskId,
            sourceKey,
            turnSourceKey: sourceKey.slice(0, sourceKey.indexOf(':task:')),
            finalMessage: { content: text, contentBlocks: builder.blocks },
            messageId: builder.row.id,
          },
      taskId,
    );
  };
  /** Core posts each task's message when the root turn's stream closes. */
  const finishTaskMessages = (at: number): void => {
    for (const [sourceKey, builder] of Array.from(builders.entries()))
      if (builder.row.taskId !== undefined) finishMessage(at, sourceKey);
  };

  for (const { at, event } of claudeTimeline()) {
    switch (event.type) {
      case 'user':
        turn = event.turn;
        messages.push({
          id: `core-msg-${event.turn.userMessageId}`,
          turnId: event.turn.turnId,
          role: 'USER',
          content: event.turn.userText,
          createdAt: isoAt(at),
        });
        break;
      case 'turn-start':
        emit(at, 'message.start', {
          turnId: event.turn.turnId,
          sourceKey: turnSourceKey(event.turn),
          role: 'assistant',
        });
        builderFor(at, null);
        break;
      case 'turn-end':
        finishTaskMessages(at);
        finishMessage(at, turnSourceKey(event.turn));
        break;
      case 'text': {
        builderFor(at, event.scope).blocks.push({
          type: 'text',
          text: event.text,
        });
        emit(
          at,
          'message.delta',
          { ...scopedPayload(event.scope), textDelta: event.text },
          event.scope?.taskId,
        );
        break;
      }
      case 'tool-call':
        toolCall(
          at,
          event.scope,
          event.step.toolUseId,
          event.step.name,
          event.step.input,
        );
        break;
      case 'tool-result':
        toolResult(
          at,
          event.scope,
          event.step.toolUseId,
          event.step.name,
          event.step.output,
          event.step.isError === true,
        );
        break;
      case 'spawn':
        taskOf.set(event.agent, event.agent.taskId);
        toolCall(
          at,
          event.scope,
          event.agent.toolUseId,
          'Agent',
          agentInput(event.agent),
        );
        upsert(
          at,
          { kind: 'agent', agent: event.agent },
          event.scope,
          'pending',
        );
        break;
      case 'agent-start':
        upsert(
          at,
          { kind: 'agent', agent: event.agent },
          event.scope,
          'running',
        );
        break;
      case 'agent-launched':
        toolResult(
          at,
          event.scope,
          event.agent.toolUseId,
          'Agent',
          agentLaunchReceipt(event.agent),
          false,
        );
        break;
      case 'agent-settle':
        upsert(
          at,
          { kind: 'agent', agent: event.agent },
          event.scope,
          event.agent.outcome.status,
        );
        if (event.agent.outcome.status === 'failed')
          emit(
            at,
            'harness.event',
            {
              kind: 'task_error',
              taskId: event.agent.taskId,
              sourceKey: sourceKeyOf(event.agent),
              errorCode: 'CLAUDE_TASK_FAILED',
              errorMessage: event.agent.outcome.error,
            },
            event.agent.taskId,
          );
        if (!event.agent.background)
          toolResult(
            at,
            event.scope,
            event.agent.toolUseId,
            'Agent',
            agentOutcomeText(event.agent),
            event.agent.outcome.status === 'failed',
          );
        break;
      case 'shell-spawn':
        toolCall(
          at,
          event.scope,
          event.shell.toolUseId,
          'Bash',
          shellInput(event.shell),
        );
        upsert(
          at,
          { kind: 'shell', shell: event.shell },
          event.scope,
          'running',
        );
        break;
      case 'shell-launched':
        toolResult(
          at,
          event.scope,
          event.shell.toolUseId,
          'Bash',
          shellLaunchReceipt(event.shell),
          false,
        );
        break;
      case 'shell-output':
        break;
      case 'shell-settle':
        upsert(
          at,
          { kind: 'shell', shell: event.shell },
          event.scope,
          'completed',
        );
        break;
    }
  }
  return { events, messages, tasks: Array.from(tasks.values()) };
}

/**
 * The background task list cloud should build from Core's task rows once
 * live background tasks land (CAN-4050): each background task in launch
 * order, keyed by its Core task id, with the same fields desktop shows.
 */
export function claudeExpectedCloudBackgroundTasks(): readonly BackgroundTask[] {
  const tasks: BackgroundTask[] = [];
  const started = new Map<string, number>();
  for (const { at, event } of claudeTimeline()) {
    if (event.type === 'shell-spawn') started.set(event.shell.taskId, at);
    if (event.type === 'spawn' && event.agent.background)
      started.set(event.agent.taskId, at);
    if (event.type === 'shell-settle') {
      const { shell } = event;
      tasks.push({
        id: shell.taskId,
        kind: 'bash',
        status: 'completed',
        title: shell.description,
        ownerToolUseId: shell.toolUseId,
        parentTaskId: null,
        startedAt: started.get(shell.taskId) ?? null,
        settledAt: at,
        updatedAt: at,
        lastDescription: shell.description,
        summary: shell.summary,
        outputLines: shell.outputLines,
        canStop: false,
      });
    }
    if (event.type === 'agent-settle' && event.agent.background) {
      const { agent } = event;
      tasks.push({
        id: agent.taskId,
        kind: 'agent',
        status: agent.outcome.status,
        title: agent.description,
        ownerToolUseId: agent.toolUseId,
        parentTaskId: null,
        startedAt: started.get(agent.taskId) ?? null,
        settledAt: at,
        updatedAt: at,
        lastDescription: agent.description,
        summary: agentOutcomeText(agent),
        outputLines: [],
        canStop: false,
      });
    }
  }
  return tasks;
}
