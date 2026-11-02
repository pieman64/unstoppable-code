// Golden scenarios: one per producer family, plus the lifecycle cases
// extraction must preserve (pause accounting, shutdown, restart replay and
// duplicate finalization). Each drives only the host-neutral ingest.
import {
  GOLDEN_CODEX_MODEL,
  GOLDEN_START_TIME,
  type GoldenScenario,
  type GoldenScenarioContext,
} from './harness';
import {
  CLAUDE_MODEL,
  COPILOT_MODEL,
  PROJECT,
  WORKTREE,
  agentStep,
  chatEvent,
  chatKey,
  chatStart,
  claudeAssistant,
  claudeInit,
  claudeResult,
  claudeToolResult,
  codexChatEvent,
  codexTurnEvents,
  delegationEvent,
  helperEntry,
  job,
  jsonl,
  pipelineState,
  planEvent,
  proxyResponse,
  runEvent,
  shellStep,
} from './fixtures';

/** Sets the clock to `offsetMs` after the golden start and returns it. */
function at(context: GoldenScenarioContext, offsetMs: number): string {
  const iso = new Date(Date.parse(GOLDEN_START_TIME) + offsetMs).toISOString();
  context.host.setClock(iso);
  return iso;
}

function isoAt(offsetMs: number): string {
  return new Date(Date.parse(GOLDEN_START_TIME) + offsetMs).toISOString();
}

const SECOND = 1_000;
const MINUTE = 60 * SECOND;

const chatClaude: GoldenScenario = {
  name: 'chat turns: Claude',
  run: async (context) => {
    const chatId = 'chat-claude';
    at(context, 0);
    context.ingest.startChatTurn(
      chatStart(chatId, 'claude', { userMessageId: 'message-1' }),
    );
    chatEvent(context, chatId, claudeInit('session-claude'));
    at(context, 2 * SECOND);
    chatEvent(
      context,
      chatId,
      claudeAssistant([
        { type: 'thinking', thinking: 'Considering the layout' },
        { type: 'text', text: 'Looking at the files.' },
        {
          type: 'tool_use',
          id: 'tool-bash',
          name: 'Bash',
          input: { command: 'ls' },
        },
        {
          type: 'tool_use',
          id: 'tool-read',
          name: 'Read',
          input: { file_path: 'a.ts' },
        },
      ]),
    );
    chatEvent(context, chatId, claudeToolResult('tool-bash'));
    at(context, 4 * SECOND);
    context.ingest.recordUsageMetricEvent(
      planEvent('plan_created', 'plan-created-1', chatId, isoAt(4 * SECOND)),
    );
    chatEvent(
      context,
      chatId,
      claudeResult({
        sessionId: 'session-claude',
        input: 1_200,
        output: 300,
        cacheRead: 5_000,
        cacheWrite: 800,
        runningCostUsd: 0.12,
        contextWindow: 200_000,
      }),
    );
    at(context, 5 * SECOND);
    context.ingest.completeChatTurn(PROJECT, WORKTREE, chatId, 'success');
    await context.settle();

    // The second turn's SDK totals are running totals for the session.
    at(context, MINUTE);
    context.ingest.startChatTurn(
      chatStart(chatId, 'claude', {
        userMessageId: 'message-2',
        sdkSessionId: 'session-claude',
      }),
    );
    at(context, MINUTE + 3 * SECOND);
    chatEvent(
      context,
      chatId,
      claudeAssistant([{ type: 'text', text: 'Done.' }]),
    );
    context.ingest.recordUsageMetricEvent(
      planEvent(
        'plan_approved',
        'plan-approved-1',
        chatId,
        isoAt(MINUTE + 3 * SECOND),
      ),
    );
    chatEvent(
      context,
      chatId,
      claudeResult({
        sessionId: 'session-claude',
        input: 400,
        output: 120,
        cacheRead: 6_000,
        cacheWrite: 100,
        runningCostUsd: 0.2,
        runningModelUsage: {
          [CLAUDE_MODEL]: {
            inputTokens: 1_600,
            outputTokens: 420,
            cacheReadInputTokens: 11_000,
            cacheCreationInputTokens: 900,
            costUSD: 0.2,
          },
        },
      }),
    );
    at(context, MINUTE + 6 * SECOND);
    context.ingest.completeChatTurn(PROJECT, WORKTREE, chatId, 'success');

    // App Advisor and standalone turns use their own event types and links.
    at(context, 2 * MINUTE);
    context.ingest.startChatTurn(
      chatStart('chat-advisor', 'claude', {
        assistantMode: 'app-advisor',
        initiationSource: 'app_advisor',
      }),
    );
    at(context, 2 * MINUTE + 2 * SECOND);
    context.ingest.completeChatTurn(
      PROJECT,
      WORKTREE,
      'chat-advisor',
      'success',
    );
    at(context, 3 * MINUTE);
    context.ingest.startChatTurn(
      chatStart('chat-standalone', 'claude', { isStandalone: true }),
    );
    at(context, 3 * MINUTE + 2 * SECOND);
    context.ingest.completeChatTurn(
      PROJECT,
      WORKTREE,
      'chat-standalone',
      'failure',
      'Provider error',
    );
  },
};

const chatCodex: GoldenScenario = {
  name: 'chat turns: Codex',
  run: async (context) => {
    const chatId = 'chat-codex';
    at(context, 0);
    context.ingest.startChatTurn(chatStart(chatId, 'codex'));
    at(context, 5 * SECOND);
    for (const event of codexTurnEvents({
      threadId: 'thread-codex',
      turnId: 'turn-1',
      input: 2_000,
      cachedInput: 500,
      output: 400,
      reasoning: 50,
    })) {
      chatEvent(context, chatId, codexChatEvent(event));
    }
    at(context, 9 * SECOND);
    context.ingest.completeChatTurn(PROJECT, WORKTREE, chatId, 'success');
    await context.settle();

    // A second turn on the same thread advances by the cumulative delta.
    at(context, MINUTE);
    context.ingest.startChatTurn(
      chatStart(chatId, 'codex', { sdkSessionId: 'thread-codex' }),
    );
    for (const event of codexTurnEvents({
      threadId: 'thread-codex',
      turnId: 'turn-2',
      input: 1_000,
      cachedInput: 800,
      output: 200,
      reasoning: 10,
      previous: { input: 2_000, cachedInput: 500, output: 400 },
    })) {
      chatEvent(context, chatId, codexChatEvent(event));
    }
    at(context, MINUTE + 4 * SECOND);
    context.ingest.completeChatTurn(
      PROJECT,
      WORKTREE,
      chatId,
      'cancelled',
      'Stopped by user',
    );
  },
};

const chatAccountProxy: GoldenScenario = {
  name: 'chat turns: account proxy',
  run: async (context) => {
    const chatId = 'chat-proxy';
    const sessionId = `${PROJECT}/${WORKTREE}/${chatId}`;
    at(context, 0);
    context.ingest.startChatTurn(
      chatStart(chatId, 'claude', { accountProxyRouted: true }),
    );
    at(context, 2 * SECOND);
    context.host.recordAccountProxyResponse(
      proxyResponse(sessionId, 'a1b2c3d4', 'req-1'),
    );
    context.host.recordAccountProxyResponse(
      proxyResponse(sessionId, 'a1b2c3d4', 'req-2'),
    );
    context.host.recordAccountProxyResponse(
      proxyResponse(sessionId, 'e5f6a7b8', 'req-3'),
    );
    chatEvent(
      context,
      chatId,
      claudeResult({
        sessionId: 'session-proxy',
        input: 600,
        output: 90,
        cacheRead: 0,
        cacheWrite: 0,
        runningCostUsd: 0.04,
      }),
    );
    at(context, 3 * SECOND);
    context.ingest.completeChatTurn(PROJECT, WORKTREE, chatId, 'success');
    // A response after the turn ends is held, then dropped by the next turn.
    context.host.recordAccountProxyResponse(
      proxyResponse(sessionId, 'e5f6a7b8', 'req-4'),
    );
    await context.settle();
    at(context, MINUTE);
    context.ingest.startChatTurn(
      chatStart(chatId, 'claude', { accountProxyRouted: true }),
    );
    context.host.recordAccountProxyResponse(
      proxyResponse(sessionId, 'a1b2c3d4', 'req-5'),
    );
    at(context, MINUTE + 2 * SECOND);
    context.ingest.completeChatTurn(PROJECT, WORKTREE, chatId, 'success');
  },
};

const helperTasks: GoldenScenario = {
  name: 'observed helper tasks',
  run: async (context) => {
    const prKey = `pr-generation:${PROJECT}/${WORKTREE}:1`;
    context.ingest.startObservedTask(
      prKey,
      helperEntry({
        taskKey: prKey,
        eventType: 'pr_generation',
        provider: 'claude',
        model: CLAUDE_MODEL,
        label: 'PR generation',
        startedAt: at(context, 0),
        chatId: 'chat-claude',
      }),
    );
    at(context, 4 * SECOND);
    context.ingest.finalizeObservedTask(prKey, 'success', undefined, {
      inputTokens: 900,
      outputTokens: 200,
      cacheReadInputTokens: 100,
      totalCostUsd: 0.03,
      messageCount: 1,
      assistantMessageCount: 1,
    });

    const summaryKey = `chat-summary:${PROJECT}/${WORKTREE}/chat-codex`;
    context.ingest.startObservedTask(
      summaryKey,
      helperEntry({
        taskKey: summaryKey,
        eventType: 'chat_summary',
        provider: 'codex',
        model: GOLDEN_CODEX_MODEL,
        label: 'Chat summary',
        startedAt: at(context, 10 * SECOND),
        chatId: 'chat-codex',
      }),
    );
    at(context, 12 * SECOND);
    context.ingest.finalizeObservedTask(
      summaryKey,
      'failure',
      'Helper timed out',
      { inputTokens: 300, outputTokens: 0 },
    );

    // A successful helper that never called a model.
    const branchKey = `branch-naming:${PROJECT}/${WORKTREE}`;
    context.ingest.startObservedTask(
      branchKey,
      helperEntry({
        taskKey: branchKey,
        eventType: 'branch_naming',
        provider: 'claude',
        model: CLAUDE_MODEL,
        label: 'Branch naming',
        startedAt: at(context, 20 * SECOND),
      }),
    );
    at(context, 21 * SECOND);
    context.ingest.finalizeObservedTask(branchKey, 'success');

    const commitKey = `commit-message:${PROJECT}/${WORKTREE}`;
    context.ingest.startObservedTask(
      commitKey,
      helperEntry({
        taskKey: commitKey,
        eventType: 'commit_message_generation',
        provider: 'claude',
        model: CLAUDE_MODEL,
        label: 'Commit message',
        startedAt: at(context, 30 * SECOND),
        aiCreditsRouted: true,
      }),
    );
    at(context, 33 * SECOND);
    context.ingest.finalizeObservedTask(commitKey, 'success', undefined, {
      inputTokens: 500,
      outputTokens: 60,
      totalCostUsd: 0.01,
    });
    await context.settle();
  },
};

const managedDelegation: GoldenScenario = {
  name: 'managed delegations',
  run: (context) => {
    const chatId = 'chat-parent';
    at(context, 0);
    context.ingest.startChatTurn(
      chatStart(chatId, 'claude', { userMessageId: 'parent-turn-1' }),
    );
    const createdAt = Date.parse(at(context, SECOND));
    chatEvent(
      context,
      chatId,
      delegationEvent({
        delegationId: 'delegation-1',
        parentTurnId: 'parent-turn-1',
        status: 'running',
        sequence: 1,
        createdAt,
        usage: {
          inputTokens: 1_000,
          outputTokens: 100,
          cachedInputTokens: 200,
        },
        itemTimes: [createdAt + SECOND],
      }),
    );
    at(context, 20 * SECOND);
    chatEvent(
      context,
      chatId,
      delegationEvent({
        delegationId: 'delegation-1',
        parentTurnId: 'parent-turn-1',
        status: 'completed',
        sequence: 2,
        createdAt,
        usage: {
          inputTokens: 3_000,
          outputTokens: 400,
          cachedInputTokens: 900,
        },
        itemTimes: [createdAt + SECOND, createdAt + 15 * SECOND],
      }),
    );
    chatEvent(
      context,
      chatId,
      claudeResult({
        sessionId: 'session-parent',
        input: 700,
        output: 150,
        cacheRead: 0,
        cacheWrite: 0,
        runningCostUsd: 0.05,
      }),
    );
    at(context, 25 * SECOND);
    context.ingest.completeChatTurn(PROJECT, WORKTREE, chatId, 'success');
    return Promise.resolve();
  },
};

const ROOT_RUN = 'exec-root';
const CHILD_RUN = 'exec-child';

function rootRunState(
  phase: 'running' | 'done',
): ReturnType<typeof pipelineState> {
  const done = phase === 'done';
  const terminal = (
    status: 'success' | 'failure',
    completedAt: string,
    error?: string,
  ): Partial<Parameters<typeof agentStep>[0]> =>
    done
      ? { status, completedAt, ...(error === undefined ? {} : { error }) }
      : {};
  return pipelineState({
    id: ROOT_RUN,
    status: done ? 'failure' : 'running',
    startedAt: isoAt(0),
    ...(done ? { completedAt: isoAt(5 * MINUTE), pausedMs: 2 * MINUTE } : {}),
    jobs: {
      build: job(done ? 'success' : 'running', {
        'claude-step': agentStep({
          provider: 'claude',
          model: CLAUDE_MODEL,
          startedAt: isoAt(SECOND),
          outputs: done ? { session_id: 'session-pipeline-claude' } : {},
          ...terminal('success', isoAt(40 * SECOND)),
        }),
        'codex-step': agentStep({
          provider: 'codex',
          harness: 'codex',
          model: GOLDEN_CODEX_MODEL,
          startedAt: isoAt(2 * SECOND),
          ...terminal('success', isoAt(50 * SECOND)),
        }),
        'lint-shell': shellStep(
          done ? 'success' : 'running',
          isoAt(3 * SECOND),
        ),
      }),
      proxy: job(done ? 'success' : 'running', {
        'proxy-step': agentStep({
          provider: 'claude',
          model: CLAUDE_MODEL,
          startedAt: isoAt(4 * SECOND),
          outputs: {
            canopy_account_proxy_routed: 'true',
            canopy_account_proxy_session: 'proxy-route-1',
          },
          ...terminal('success', isoAt(60 * SECOND)),
        }),
      }),
      copilot: job(done ? 'failure' : 'running', {
        'copilot-step': agentStep({
          provider: 'copilot',
          harness: 'copilot',
          model: COPILOT_MODEL,
          startedAt: isoAt(5 * SECOND),
          ...terminal('failure', isoAt(70 * SECOND), 'Copilot step failed'),
        }),
      }),
    },
  });
}

function childRunState(
  phase: 'running' | 'done',
): ReturnType<typeof pipelineState> {
  const done = phase === 'done';
  return pipelineState({
    id: CHILD_RUN,
    parentExecutionId: ROOT_RUN,
    status: done ? 'success' : 'running',
    startedAt: isoAt(80 * SECOND),
    ...(done ? { completedAt: isoAt(2 * MINUTE) } : {}),
    jobs: {
      nested: job(done ? 'success' : 'running', {
        'nested-step': agentStep({
          provider: 'claude',
          model: CLAUDE_MODEL,
          startedAt: isoAt(81 * SECOND),
          ...(done
            ? { status: 'success', completedAt: isoAt(110 * SECOND) }
            : {}),
        }),
      }),
    },
  });
}

const pipelineSteps: GoldenScenario = {
  name: 'pipeline steps: Claude, Codex, account proxy and Copilot',
  run: async (context) => {
    at(context, 0);
    const running = rootRunState('running');
    context.host.recordPipelineRunEvent(
      runEvent('execution.started', running, isoAt(0)),
    );
    at(context, 6 * SECOND);
    context.ingest.syncPipelineExecutionState(running);

    at(context, 20 * SECOND);
    context.pipelineOutput({
      executionId: ROOT_RUN,
      jobId: 'build',
      stepId: 'claude-step',
      attempt: 0,
      data: jsonl([
        claudeInit('session-pipeline-claude'),
        claudeAssistant([
          { type: 'text', text: 'Editing.' },
          {
            type: 'tool_use',
            id: 'tool-edit',
            name: 'Edit',
            input: { file_path: 'a.ts' },
          },
        ]),
        claudeResult({
          sessionId: 'session-pipeline-claude',
          input: 2_000,
          output: 500,
          cacheRead: 10_000,
          cacheWrite: 1_000,
          runningCostUsd: 0.3,
        }),
      ]),
    });
    context.pipelineOutput({
      executionId: ROOT_RUN,
      jobId: 'build',
      stepId: 'codex-step',
      attempt: 0,
      data: jsonl(
        codexTurnEvents({
          threadId: 'thread-pipeline',
          turnId: 'turn-pipeline',
          input: 3_000,
          cachedInput: 1_000,
          output: 600,
          reasoning: 80,
        }),
      ),
    });
    context.host.recordAccountProxyResponse(
      proxyResponse('proxy-route-1', 'c0ffee01', 'req-p1'),
    );
    context.host.recordAccountProxyResponse(
      proxyResponse('proxy-route-1', 'c0ffee01', 'req-p2'),
    );
    context.host.recordAccountProxyResponse(
      proxyResponse('proxy-route-1', 'dead0002', 'req-p3'),
    );
    context.pipelineOutput({
      executionId: ROOT_RUN,
      jobId: 'proxy',
      stepId: 'proxy-step',
      attempt: 0,
      data: jsonl([
        claudeResult({
          sessionId: 'session-pipeline-proxy',
          input: 800,
          output: 100,
          cacheRead: 0,
          cacheWrite: 0,
          runningCostUsd: 0.06,
        }),
      ]),
    });
    context.pipelineOutput({
      executionId: ROOT_RUN,
      jobId: 'copilot',
      stepId: 'copilot-step',
      attempt: 0,
      data: jsonl([
        { type: 'system', subtype: 'init', session_id: 'copilot-session' },
        claudeAssistant([{ type: 'text', text: 'Copilot reply' }]),
        {
          type: 'result',
          subtype: 'error',
          is_error: true,
          result: 'Copilot step failed',
          usage: { input_tokens: 450, output_tokens: 70 },
        },
      ]),
    });
    // Output for a step that is not open is counted and dropped.
    context.pipelineOutput({
      executionId: ROOT_RUN,
      jobId: 'build',
      stepId: 'missing-step',
      attempt: 0,
      data: jsonl([{ type: 'assistant', message: { content: [] } }]),
    });

    at(context, 80 * SECOND);
    context.ingest.syncPipelineExecutionState(childRunState('running'));
    context.pipelineOutput({
      executionId: CHILD_RUN,
      jobId: 'nested',
      stepId: 'nested-step',
      attempt: 0,
      data: jsonl([
        claudeResult({
          sessionId: 'session-pipeline-nested',
          input: 300,
          output: 40,
          cacheRead: 0,
          cacheWrite: 0,
          runningCostUsd: 0.02,
        }),
      ]),
    });
    at(context, 2 * MINUTE);
    context.ingest.syncPipelineExecutionState(childRunState('done'));
    context.host.recordPipelineRunEvent(
      runEvent('execution.completed', childRunState('done'), isoAt(2 * MINUTE)),
    );

    at(context, 5 * MINUTE);
    const done = rootRunState('done');
    context.ingest.syncPipelineExecutionState(done);
    context.host.recordPipelineRunEvent(
      runEvent('execution.failed', done, isoAt(5 * MINUTE)),
    );
    await context.settle();
  },
};

const pauses: GoldenScenario = {
  name: 'turn duration net of pauses',
  run: async (context) => {
    // A closed pause, a repeated pause, a stray resume, and a pause still
    // open when the turn completes.
    at(context, 0);
    context.ingest.startChatTurn(chatStart('chat-paused', 'claude'));
    context.ingest.resumeChatTurn(PROJECT, WORKTREE, 'chat-paused');
    at(context, 10 * SECOND);
    context.ingest.pauseChatTurn(PROJECT, WORKTREE, 'chat-paused');
    at(context, 20 * SECOND);
    context.ingest.pauseChatTurn(PROJECT, WORKTREE, 'chat-paused');
    at(context, 40 * SECOND);
    context.ingest.resumeChatTurn(PROJECT, WORKTREE, 'chat-paused');
    at(context, 45 * SECOND);
    context.ingest.pauseChatTurn(PROJECT, WORKTREE, 'chat-paused');
    at(context, 52 * SECOND);
    context.ingest.completeChatTurn(
      PROJECT,
      WORKTREE,
      'chat-paused',
      'success',
    );

    // A provider-reported duration has the pause subtracted too.
    at(context, MINUTE);
    context.ingest.startChatTurn(chatStart('chat-provider-duration', 'claude'));
    at(context, MINUTE + 5 * SECOND);
    context.ingest.pauseChatTurn(PROJECT, WORKTREE, 'chat-provider-duration');
    at(context, MINUTE + 17 * SECOND);
    context.ingest.resumeChatTurn(PROJECT, WORKTREE, 'chat-provider-duration');
    at(context, MINUTE + 20 * SECOND);
    chatEvent(
      context,
      'chat-provider-duration',
      claudeResult({
        sessionId: 'session-provider-duration',
        input: 100,
        output: 10,
        cacheRead: 0,
        cacheWrite: 0,
        runningCostUsd: 0.001,
        durationMs: 20 * SECOND,
      }),
    );
    context.ingest.completeChatTurn(
      PROJECT,
      WORKTREE,
      'chat-provider-duration',
      'success',
    );

    // A pause longer than the provider duration clamps at zero.
    at(context, 2 * MINUTE);
    context.ingest.startChatTurn(chatStart('chat-clamped', 'claude'));
    context.ingest.pauseChatTurn(PROJECT, WORKTREE, 'chat-clamped');
    at(context, 2 * MINUTE + 30 * SECOND);
    context.ingest.resumeChatTurn(PROJECT, WORKTREE, 'chat-clamped');
    chatEvent(
      context,
      'chat-clamped',
      claudeResult({
        sessionId: 'session-clamped',
        input: 50,
        output: 5,
        cacheRead: 0,
        cacheWrite: 0,
        runningCostUsd: 0.0005,
        durationMs: 10 * SECOND,
      }),
    );
    context.ingest.completeChatTurn(
      PROJECT,
      WORKTREE,
      'chat-clamped',
      'success',
    );

    // An implausible provider duration records a session diagnostic that
    // names the paused time it subtracted.
    at(context, 3 * MINUTE);
    context.ingest.startChatTurn(chatStart('chat-implausible', 'claude'));
    context.ingest.pauseChatTurn(PROJECT, WORKTREE, 'chat-implausible');
    at(context, 3 * MINUTE + 15 * SECOND);
    context.ingest.resumeChatTurn(PROJECT, WORKTREE, 'chat-implausible');
    chatEvent(
      context,
      'chat-implausible',
      claudeResult({
        sessionId: 'session-implausible',
        input: 10,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        runningCostUsd: 0.0001,
        durationMs: 8 * 24 * 60 * MINUTE,
      }),
    );
    context.ingest.completeChatTurn(
      PROJECT,
      WORKTREE,
      'chat-implausible',
      'success',
    );

    // A pipeline run's usage event carries working time, not wall clock.
    const run = pipelineState({
      id: 'exec-paused',
      status: 'success',
      startedAt: isoAt(4 * MINUTE),
      completedAt: isoAt(14 * MINUTE),
      pausedMs: 7 * MINUTE,
      jobs: {
        build: job('success', {
          'build-shell': shellStep('success', isoAt(4 * MINUTE)),
        }),
      },
    });
    at(context, 4 * MINUTE);
    context.host.recordPipelineRunEvent(
      runEvent('execution.started', run, isoAt(4 * MINUTE)),
    );
    at(context, 14 * MINUTE);
    context.host.recordPipelineRunEvent(
      runEvent('execution.completed', run, isoAt(14 * MINUTE)),
    );
    await context.settle();
  },
};

const shutdown: GoldenScenario = {
  name: 'interrupted-on-shutdown finalization',
  run: async (context) => {
    at(context, 0);
    context.ingest.startChatTurn(chatStart('chat-open-claude', 'claude'));
    chatEvent(
      context,
      'chat-open-claude',
      claudeAssistant([
        {
          type: 'tool_use',
          id: 'tool-grep',
          name: 'Grep',
          input: { pattern: 'x' },
        },
      ]),
    );
    context.ingest.startChatTurn(chatStart('chat-open-codex', 'codex'));
    for (const event of codexTurnEvents({
      threadId: 'thread-open',
      turnId: 'turn-open',
      input: 1_500,
      cachedInput: 0,
      output: 100,
      reasoning: 0,
    }).slice(0, -1)) {
      chatEvent(context, 'chat-open-codex', codexChatEvent(event));
    }
    context.ingest.startChatTurn(chatStart('chat-open-paused', 'claude'));
    at(context, 10 * SECOND);
    context.ingest.pauseChatTurn(PROJECT, WORKTREE, 'chat-open-paused');

    const helperKey = `worktree-summary:${PROJECT}/${WORKTREE}`;
    context.ingest.startObservedTask(
      helperKey,
      helperEntry({
        taskKey: helperKey,
        eventType: 'worktree_summary',
        provider: 'claude',
        model: CLAUDE_MODEL,
        label: 'Worktree summary',
        startedAt: isoAt(10 * SECOND),
      }),
    );

    const run = pipelineState({
      id: 'exec-shutdown',
      status: 'running',
      startedAt: isoAt(12 * SECOND),
      jobs: {
        build: job('running', {
          'agent-step': agentStep({
            provider: 'claude',
            model: CLAUDE_MODEL,
            startedAt: isoAt(12 * SECOND),
          }),
        }),
      },
    });
    context.ingest.syncPipelineExecutionState(run);
    context.pipelineOutput({
      executionId: 'exec-shutdown',
      jobId: 'build',
      stepId: 'agent-step',
      attempt: 0,
      data: jsonl([claudeAssistant([{ type: 'text', text: 'Partial work' }])]),
    });
    at(context, 30 * SECOND);
    await context.shutdownAndRestart();
  },
};

function replayRun(
  phase: 'crash' | 'restart',
): ReturnType<typeof pipelineState> {
  const restarted = phase === 'restart';
  return pipelineState({
    id: 'exec-replay',
    status: 'running',
    startedAt: isoAt(0),
    jobs: {
      build: job('running', {
        'resumed-step': agentStep({
          provider: 'claude',
          model: CLAUDE_MODEL,
          startedAt: isoAt(SECOND),
          ...(restarted
            ? { status: 'success', completedAt: isoAt(3 * MINUTE) }
            : {}),
        }),
        'finished-step': agentStep({
          provider: 'codex',
          harness: 'codex',
          model: GOLDEN_CODEX_MODEL,
          startedAt: isoAt(2 * SECOND),
          status: 'success',
          completedAt: isoAt(30 * SECOND),
        }),
        'still-running-step': agentStep({
          provider: 'claude',
          model: CLAUDE_MODEL,
          startedAt: isoAt(3 * SECOND),
        }),
      }),
    },
  });
}

const replay: GoldenScenario = {
  name: 'replay after restart',
  run: async (context) => {
    at(context, 0);
    context.ingest.startChatTurn(chatStart('chat-crashed', 'claude'));
    chatEvent(
      context,
      'chat-crashed',
      claudeAssistant([{ type: 'text', text: 'Working' }]),
    );
    at(context, 5 * SECOND);
    context.ingest.syncPipelineExecutionState(replayRun('crash'));
    context.pipelineOutput({
      executionId: 'exec-replay',
      jobId: 'build',
      stepId: 'resumed-step',
      attempt: 0,
      data: jsonl([claudeAssistant([{ type: 'text', text: 'Before crash' }])]),
    });
    context.pipelineOutput({
      executionId: 'exec-replay',
      jobId: 'build',
      stepId: 'finished-step',
      attempt: 0,
      data: jsonl(
        codexTurnEvents({
          threadId: 'thread-replay',
          turnId: 'turn-replay',
          input: 900,
          cachedInput: 0,
          output: 90,
          reasoning: 0,
        }),
      ),
    });
    at(context, 40 * SECOND);
    // The app dies without shutting down.
    await context.crashAndRestart();

    // The runner replays its persisted states into the new process.
    at(context, 2 * MINUTE);
    context.ingest.syncPipelineExecutionState(replayRun('crash'));
    // No open entry survives the crash, so completing the turn is a no-op.
    context.ingest.completeChatTurn(
      PROJECT,
      WORKTREE,
      'chat-crashed',
      'success',
    );
    context.pipelineOutput({
      executionId: 'exec-replay',
      jobId: 'build',
      stepId: 'resumed-step',
      attempt: 0,
      data: jsonl([
        claudeResult({
          sessionId: 'session-replay',
          input: 1_000,
          output: 200,
          cacheRead: 0,
          cacheWrite: 0,
          runningCostUsd: 0.07,
        }),
      ]),
    });
    at(context, 3 * MINUTE);
    context.ingest.syncPipelineExecutionState(replayRun('restart'));
    context.ingest.syncPipelineExecutionState(replayRun('restart'));
    at(context, 4 * MINUTE);
    await context.shutdownAndRestart();

    // After a clean shutdown the replayed terminal states add no rows.
    at(context, 5 * MINUTE);
    const finished = replayRun('restart');
    const build = finished.jobs['build'];
    if (build) {
      build.steps['still-running-step'] = agentStep({
        provider: 'claude',
        model: CLAUDE_MODEL,
        startedAt: isoAt(3 * SECOND),
        status: 'success',
        completedAt: isoAt(5 * MINUTE),
      });
    }
    context.ingest.syncPipelineExecutionState(finished);
    await context.settle();
  },
};

const duplicates: GoldenScenario = {
  name: 'duplicate finalization',
  run: async (context) => {
    const chatId = 'chat-duplicate';
    at(context, 0);
    context.ingest.startChatTurn(chatStart(chatId, 'claude'));
    chatEvent(
      context,
      chatId,
      claudeResult({
        sessionId: 'session-duplicate',
        input: 100,
        output: 20,
        cacheRead: 0,
        cacheWrite: 0,
        runningCostUsd: 0.01,
      }),
    );
    at(context, 2 * SECOND);
    context.ingest.completeChatTurn(PROJECT, WORKTREE, chatId, 'success');
    at(context, 3 * SECOND);
    context.ingest.completeChatTurn(
      PROJECT,
      WORKTREE,
      chatId,
      'failure',
      'Late',
    );
    context.ingest.interruptMatchingEntries(chatKey(chatId));

    // A new turn supersedes one that never completed.
    at(context, MINUTE);
    context.ingest.startChatTurn(
      chatStart(chatId, 'claude', { userMessageId: 'superseded' }),
    );
    at(context, MINUTE + 2 * SECOND);
    context.ingest.startChatTurn(
      chatStart(chatId, 'claude', { userMessageId: 'replacement' }),
    );
    at(context, MINUTE + 4 * SECOND);
    context.ingest.completeChatTurn(PROJECT, WORKTREE, chatId, 'success');

    const helperKey = `pr-generation:${PROJECT}/${WORKTREE}:dup`;
    const helper = (startedAt: string): ReturnType<typeof helperEntry> =>
      helperEntry({
        taskKey: `${helperKey}:${startedAt}`,
        eventType: 'pr_generation',
        provider: 'claude',
        model: CLAUDE_MODEL,
        label: 'PR generation',
        startedAt,
      });
    context.ingest.startObservedTask(
      helperKey,
      helper(at(context, 2 * MINUTE)),
    );
    at(context, 2 * MINUTE + SECOND);
    context.ingest.startObservedTask(
      helperKey,
      helper(at(context, 2 * MINUTE + SECOND)),
    );
    at(context, 2 * MINUTE + 3 * SECOND);
    context.ingest.finalizeObservedTask(helperKey, 'success', undefined, {
      inputTokens: 200,
      outputTokens: 30,
      totalCostUsd: 0.005,
    });
    context.ingest.finalizeObservedTask(helperKey, 'failure', 'Late failure', {
      inputTokens: 999,
    });

    const plan = planEvent(
      'plan_created',
      'plan-dup',
      chatId,
      isoAt(3 * MINUTE),
    );
    at(context, 3 * MINUTE);
    context.ingest.recordUsageMetricEvent(plan);
    context.ingest.recordUsageMetricEvent(plan);

    const terminal = pipelineState({
      id: 'exec-duplicate',
      status: 'success',
      startedAt: isoAt(4 * MINUTE),
      completedAt: isoAt(6 * MINUTE),
      jobs: {
        build: job('success', {
          'agent-step': agentStep({
            provider: 'claude',
            model: CLAUDE_MODEL,
            startedAt: isoAt(4 * MINUTE),
            status: 'success',
            completedAt: isoAt(5 * MINUTE),
          }),
        }),
      },
    });
    at(context, 5 * MINUTE);
    context.ingest.syncPipelineExecutionState(terminal);
    context.ingest.syncPipelineExecutionState(terminal);
    const failed = pipelineState({
      id: 'exec-duplicate',
      status: 'failure',
      startedAt: isoAt(4 * MINUTE),
      completedAt: isoAt(6 * MINUTE),
      jobs: {
        build: job('failure', {
          'agent-step': agentStep({
            provider: 'claude',
            model: CLAUDE_MODEL,
            startedAt: isoAt(4 * MINUTE),
            status: 'failure',
            completedAt: isoAt(6 * MINUTE),
            error: 'Rewritten',
          }),
        }),
      },
    });
    at(context, 6 * MINUTE);
    context.ingest.syncPipelineExecutionState(failed);
    context.host.recordPipelineRunEvent(
      runEvent('execution.completed', terminal, isoAt(6 * MINUTE)),
    );
    context.host.recordPipelineRunEvent(
      runEvent('execution.completed', terminal, isoAt(6 * MINUTE)),
    );
    await context.settle();
  },
};

export const GOLDEN_SCENARIOS: readonly GoldenScenario[] = [
  chatClaude,
  chatCodex,
  chatAccountProxy,
  helperTasks,
  managedDelegation,
  pipelineSteps,
  pauses,
  shutdown,
  replay,
  duplicates,
];

/** The scenario whose pipeline output exercises every chunking mode. */
export const CHUNKING_SCENARIO = pipelineSteps;
