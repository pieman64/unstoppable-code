import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  initClaudeModels,
  initCodexModels,
} from '@canopy/desktop-shared/types';
import type { Pipeline } from '@canopy/desktop-shared/types/pipeline';
import { executePipeline, resumePipeline } from '../pipeline-executor';
import type {
  AgentPromptWorkerResult,
  CodexPromptRunnerResult,
  ExecutionRuntime,
  PipelineLedgerAttempt,
  PipelineLedgerAttemptOutcome,
  PipelineLedgerAttemptRequest,
  ResolvePipelineTargetResult,
} from '../types';

const MODEL = 'claude-pipeline-ledger-executor-test';
const CODEX_MODEL = 'gpt-pipeline-ledger-executor-test';

function createRuntime(rootDir: string): ExecutionRuntime {
  return {
    isModelBlockedByOrgPolicy: (): Promise<boolean> => Promise.resolve(false),
    isOrgModelPolicyActive: (): Promise<boolean> => Promise.resolve(false),
    executionsDir: path.join(rootDir, 'executions'),
    tempRootDir: path.join(rootDir, 'tmp'),
    bundledActionsDir: path.join(rootDir, 'actions'),
    getProjectActionsDir: (repoPath: string): string =>
      path.join(repoPath, '.canopy', 'actions'),
    getProjectPipelinesDir: (repoPath: string): string =>
      path.join(repoPath, '.canopy', 'pipelines'),
    resolvePipelineTarget: (request): Promise<ResolvePipelineTargetResult> => {
      if (request.requested.scope !== 'worktree') {
        throw new Error('Unexpected non-worktree target');
      }
      const worktreeId =
        'id' in request.requested.worktree
          ? request.requested.worktree.id
          : 'new-worktree';
      return Promise.resolve({
        cwd: rootDir,
        scope: 'worktree',
        target: {
          scope: 'worktree',
          workspace_id: request.requested.workspace_id,
          worktree_id: worktreeId,
          path: rootDir,
          created: false,
        },
        projectId: request.requested.workspace_id,
        worktreeId,
        repoPath: rootDir,
      });
    },
  };
}

function writeAgentPromptAction(runtime: ExecutionRuntime): void {
  const actionDir = path.join(runtime.bundledActionsDir, 'agent-prompt');
  fs.mkdirSync(actionDir, { recursive: true });
  fs.writeFileSync(
    path.join(actionDir, 'action.yml'),
    [
      'name: Agent Prompt',
      'log_format_hint: agent',
      'inputs:',
      '  model: {}',
      '  prompt: {}',
      '  permission_preset: { default: none }',
      'outputs: {}',
      'runs:',
      '  using: node',
      '  main: index.js',
    ].join('\n'),
    'utf8',
  );
  fs.writeFileSync(path.join(actionDir, 'index.js'), '', 'utf8');
}

function writeRunPipelineAction(runtime: ExecutionRuntime): void {
  const actionDir = path.join(runtime.bundledActionsDir, 'run-pipeline');
  fs.mkdirSync(actionDir, { recursive: true });
  fs.copyFileSync(
    path.resolve(
      __dirname,
      '../../../../../resources/actions/run-pipeline/action.yml',
    ),
    path.join(actionDir, 'action.yml'),
  );
}

interface FakePort {
  readonly requests: PipelineLedgerAttemptRequest[];
  /** The agent session of each opened attempt, as the host minted it. */
  readonly sessions: string[];
  readonly outcomes: PipelineLedgerAttemptOutcome[];
  /** Every `noteResuming` call, in order. */
  readonly resumed: { executionId: string; checkpointIds: string[] }[];
  /** `open` and `resume` calls, in order. */
  readonly events: string[];
}

function installPort(runtime: ExecutionRuntime): FakePort {
  const port: FakePort = {
    requests: [],
    sessions: [],
    outcomes: [],
    resumed: [],
    events: [],
  };
  runtime.pipelineLedger = {
    openAttempt: (request): Promise<PipelineLedgerAttempt> => {
      port.requests.push(request);
      port.events.push(`open:${request.executionId}`);
      // Like the desktop host: keep a resumed run's session, else mint one.
      const agentSessionId = request.resumedAgentSessionId ?? randomUUID();
      port.sessions.push(agentSessionId);
      return Promise.resolve({
        attemptKey: `attempt-${String(port.requests.length)}`,
        agentSessionId,
        instructions: 'LEDGER',
        openSubprocessTools: () =>
          Promise.reject(new Error('workers serve their own route')),
        close: (outcome): void => {
          port.outcomes.push(outcome);
        },
      });
    },
    noteResuming: (executionId, checkpointIds): Promise<void> => {
      port.resumed.push({ executionId, checkpointIds: [...checkpointIds] });
      port.events.push(`resume:${executionId}`);
      return Promise.resolve();
    },
  };
  return port;
}

const success: AgentPromptWorkerResult = {
  status: 'success',
  workerId: 'worker',
  sessionId: 'claude-session',
  rawText: 'done',
  transcript: '',
};

/** The agent step's first run pauses on a usage limit; the next succeeds. */
function pauseOnceThenSucceed(runtime: ExecutionRuntime): void {
  let calls = 0;
  runtime.agentPromptWorker = {
    runAgentPrompt: (): Promise<AgentPromptWorkerResult> => {
      calls += 1;
      return Promise.resolve(
        calls === 1
          ? {
              status: 'failure',
              workerId: 'worker',
              transcript: '',
              failure: {
                version: 1,
                provider: 'claude',
                had_agent_activity: false,
                classification: {
                  kind: 'provider_usage_limit',
                  code: 'rate_limit',
                  provider: 'claude',
                  account_scope: 'native',
                  diagnostic_message: 'usage exhausted',
                },
                message: 'usage exhausted',
              },
            }
          : success,
      );
    },
  };
}

/**
 * The Codex step's first run pauses on a usage limit; the next succeeds. A
 * nested pipeline runs Codex steps through the same runner as its parent.
 */
function codexPauseOnceThenSucceed(runtime: ExecutionRuntime): void {
  let calls = 0;
  runtime.codexPromptRunner = {
    runCodexPrompt: (): Promise<CodexPromptRunnerResult> => {
      calls += 1;
      return Promise.resolve(
        calls === 1
          ? {
              status: 'failure',
              transcript: '',
              failure: {
                version: 1,
                provider: 'codex',
                session_id: 'codex-thread',
                had_agent_activity: false,
                classification: {
                  kind: 'provider_usage_limit',
                  code: 'rate_limit',
                  provider: 'codex',
                  account_scope: 'native',
                  diagnostic_message: 'usage exhausted',
                },
                message: 'usage exhausted',
              },
            }
          : {
              status: 'success',
              sessionId: 'codex-thread',
              rawText: 'done',
              transcript: '',
              usage: {},
            },
      );
    },
  };
}

function agentPipeline(maxRetries: number, model = MODEL): Pipeline {
  return {
    name: 'Ledger identity',
    on: 'dispatch',
    jobs: {
      build: {
        max_retries: maxRetries,
        steps: [
          {
            id: 'agent',
            uses: 'builtin/agent-prompt',
            with: {
              model,
              prompt: 'work',
              permission_preset: 'read_only',
            },
          },
        ],
      },
    },
  };
}

describe('pipeline agent Ledger identity through the executor', () => {
  let tempDir: string;
  let runtime: ExecutionRuntime;

  beforeAll(() => {
    initClaudeModels([{ id: MODEL, label: 'Claude executor ledger test' }]);
    initCodexModels([{ id: CODEX_MODEL, label: 'Codex executor ledger test' }]);
  });

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-executor-'));
    runtime = createRuntime(tempDir);
    writeAgentPromptAction(runtime);
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('gives a retried attempt a new agent linked to its predecessor', async () => {
    const port = installPort(runtime);
    let calls = 0;
    runtime.agentPromptWorker = {
      runAgentPrompt: (): Promise<AgentPromptWorkerResult> => {
        calls += 1;
        return Promise.resolve(
          calls === 1
            ? {
                status: 'failure',
                workerId: 'worker',
                transcript: '',
                failure: {
                  version: 1,
                  provider: 'claude',
                  had_agent_activity: true,
                  message: 'The agent failed.',
                },
              }
            : success,
        );
      },
    };

    const handle = await executePipeline(agentPipeline(1), {
      cwd: tempDir,
      runtime,
      pipelineId: 'ledger-identity',
      projectId: 'workspace-1',
      worktreeId: 'worktree-1',
      agentTerminalMode: true,
    });
    const state = await handle.waitForCompletion();

    expect(state.status).toBe('success');
    expect(port.requests.map((request) => request.attempt)).toEqual([1, 2]);
    const [first, second] = port.requests;
    const [firstSession, secondSession] = port.sessions;
    expect(first).not.toHaveProperty('predecessorAgentSessionId');
    expect(second).not.toHaveProperty('resumedAgentSessionId');
    expect(secondSession).not.toBe(firstSession);
    expect(second.predecessorAgentSessionId).toBe(firstSession);
    expect(state.jobs.build.steps.agent.ledger_agent_session_id).toBe(
      secondSession,
    );
    expect(
      state.jobs.build.retry_history?.[0].steps.agent.ledger_agent_session_id,
    ).toBe(firstSession);
    expect(port.outcomes).toEqual([{ kind: 'settled' }, { kind: 'settled' }]);
  });

  it('keeps the agent when its paused checkpoint resumes', async () => {
    const port = installPort(runtime);
    pauseOnceThenSucceed(runtime);

    const handle = await executePipeline(agentPipeline(0), {
      cwd: tempDir,
      runtime,
      pipelineId: 'ledger-identity',
      projectId: 'workspace-1',
      worktreeId: 'worktree-1',
      agentTerminalMode: true,
    });
    const paused = await handle.waitForCompletion();
    expect(paused.status).toBe('paused');
    const checkpoint = paused.jobs.build.steps.agent.agent_recovery;
    expect(checkpoint?.strategy).toBe('restart_step');
    const [firstSession] = port.sessions;
    expect(paused.jobs.build.steps.agent.ledger_agent_session_id).toBe(
      firstSession,
    );
    expect(port.outcomes).toEqual([
      {
        kind: 'paused',
        checkpointId: checkpoint?.reason_id,
        pausedAt: checkpoint?.paused_at,
      },
    ]);

    const resumed = await resumePipeline(paused.id, {
      cwd: tempDir,
      runtime,
      agentTerminalMode: true,
    });
    const state = await resumed.waitForCompletion();

    expect(state.status).toBe('success');
    expect(port.requests).toHaveLength(2);
    expect(port.requests[1]).toMatchObject({
      resumedAgentSessionId: firstSession,
      checkpointId: checkpoint?.reason_id,
      attempt: 1,
    });
    expect(port.requests[1]).not.toHaveProperty('predecessorAgentSessionId');
    expect(state.jobs.build.steps.agent.ledger_agent_session_id).toBe(
      firstSession,
    );
    // The saved resume retires the paused agent before it runs again.
    expect(port.resumed).toEqual([
      { executionId: paused.id, checkpointIds: [checkpoint?.reason_id] },
    ]);
    expect(port.events).toEqual([
      `open:${paused.id}`,
      `resume:${paused.id}`,
      `open:${paused.id}`,
    ]);
  });

  it('retires a paused agent when a running execution resumes it', async () => {
    const port = installPort(runtime);
    pauseOnceThenSucceed(runtime);
    const pipeline = agentPipeline(0);
    pipeline.jobs.peer = { steps: [{ id: 'peer', run: 'sleep 1' }] };
    let reasonId: string | undefined;
    let notePause: () => void = (): void => undefined;
    const agentPaused = new Promise<void>((resolve) => {
      notePause = resolve;
    });

    const handle = await executePipeline(pipeline, {
      cwd: tempDir,
      runtime,
      pipelineId: 'ledger-live',
      projectId: 'workspace-1',
      worktreeId: 'worktree-1',
      agentTerminalMode: true,
      onEvent: (event): void => {
        const [reason] = event.state.status_reasons;
        if (
          reasonId === undefined &&
          event.state.status === 'running' &&
          reason !== undefined
        ) {
          reasonId = reason.id;
          notePause();
        }
      },
    });
    await agentPaused;
    if (reasonId === undefined || !handle.resumePaused) {
      throw new Error('Expected a live paused agent');
    }
    const [agentPause] = port.outcomes;
    expect(agentPause).toMatchObject({
      kind: 'paused',
      checkpointId: reasonId,
    });

    await handle.resumePaused([reasonId]);
    const state = await handle.waitForCompletion();

    expect(state.status).toBe('success');
    expect(port.resumed).toEqual([
      { executionId: handle.id, checkpointIds: [reasonId] },
    ]);
    expect(port.events).toEqual([
      `open:${handle.id}`,
      `resume:${handle.id}`,
      `open:${handle.id}`,
    ]);
    expect(port.requests[1]).toMatchObject({
      resumedAgentSessionId: port.sessions[0],
      checkpointId: reasonId,
    });
  });

  it('keeps a paused agent assignable when its resume is rejected', async () => {
    const port = installPort(runtime);
    pauseOnceThenSucceed(runtime);
    const handle = await executePipeline(agentPipeline(0), {
      cwd: tempDir,
      runtime,
      pipelineId: 'ledger-identity',
      projectId: 'workspace-1',
      worktreeId: 'worktree-1',
      agentTerminalMode: true,
    });
    const paused = await handle.waitForCompletion();
    expect(paused.status).toBe('paused');

    await expect(
      resumePipeline(paused.id, {
        cwd: tempDir,
        runtime,
        agentTerminalMode: true,
        statusReasonIds: [randomUUID()],
      }),
    ).rejects.toThrow('is stale or does not belong to execution');

    expect(port.resumed).toEqual([]);
    expect(port.requests).toHaveLength(1);
  });

  it('retires a nested pipeline agent when its own checkpoint resumes', async () => {
    const port = installPort(runtime);
    codexPauseOnceThenSucceed(runtime);
    writeRunPipelineAction(runtime);
    const child = agentPipeline(0, CODEX_MODEL);
    const parent: Pipeline = {
      name: 'Ledger nested parent',
      on: 'dispatch',
      jobs: {
        build: {
          steps: [
            {
              id: 'child',
              uses: 'builtin/run-pipeline',
              with: { pipeline_yaml: JSON.stringify(child) },
            },
          ],
        },
      },
    };

    const handle = await executePipeline(parent, {
      cwd: tempDir,
      runtime,
      pipelineId: 'ledger-nested',
      projectId: 'workspace-1',
      worktreeId: 'worktree-1',
      agentTerminalMode: true,
    });
    const paused = await handle.waitForCompletion();
    expect(paused.status).toBe('paused');
    const childId = paused.jobs.build.steps.child.child_execution_id;
    if (childId === undefined) throw new Error('Expected a nested execution');
    const [wrapper] = paused.status_reasons;
    const [agentPause] = port.outcomes;
    if (wrapper === undefined || agentPause?.kind !== 'paused') {
      throw new Error('Expected the nested agent to pause');
    }
    expect(port.requests[0].executionId).toBe(childId);
    expect(wrapper.source).toMatchObject({
      child_execution_id: childId,
      child_reason_id: agentPause.checkpointId,
    });

    const resumed = await resumePipeline(paused.id, {
      cwd: tempDir,
      runtime,
      agentTerminalMode: true,
    });
    const state = await resumed.waitForCompletion();

    expect(state.status).toBe('success');
    // The parent consumes its wrapper reason; the nested pipeline consumes
    // the agent's checkpoint when its own resume is saved, before the agent
    // runs again under the same session.
    expect(port.resumed).toEqual([
      { executionId: paused.id, checkpointIds: [wrapper.id] },
      { executionId: childId, checkpointIds: [agentPause.checkpointId] },
    ]);
    expect(port.events.slice(-2)).toEqual([
      `resume:${childId}`,
      `open:${childId}`,
    ]);
    expect(port.requests[1]).toMatchObject({
      executionId: childId,
      resumedAgentSessionId: port.sessions[0],
      checkpointId: agentPause.checkpointId,
    });
  });
});
