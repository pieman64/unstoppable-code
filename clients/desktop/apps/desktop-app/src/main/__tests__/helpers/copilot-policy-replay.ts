import { join, resolve } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { initCopilotModels } from '@canopy/desktop-shared/types';
import {
  createInitialState,
  normalizePipeline,
  resumePipeline,
  retryPipelineExecution,
  retryMatrixJobExecution,
  rerunPipelineExecution,
  saveExecutionState,
} from '@canopy/desktop-shared/node/pipelines/executor';
import type {
  ExecutionRuntime,
  ExecutionState,
  ResolvePipelineTargetResult,
} from '@canopy/desktop-shared/node/pipelines/executor/types';
import {
  runCopilotPipelinePrompt,
  type CopilotPromptHost,
} from '@canopy/desktop-shared/node/pipelines/copilot-prompt-runner';
import { refreshAllJobGroups } from '@canopy/desktop-shared/node/pipelines/executor/job-scheduler';
import type {
  CopilotTurnRequest,
  CopilotTurnResult,
} from '@canopy/desktop-shared/node/copilot/turn-driver';
import { createCopilotCapabilitySnapshot } from '@canopy/desktop-shared/node/copilot/capability-snapshot';

const turn = jest.fn<Promise<CopilotTurnResult>, [CopilotTurnRequest]>();

export function policyRuntime(
  root: string,
  workspaceId = 'destination',
  worktreeId = 'new',
): ExecutionRuntime {
  const host: CopilotPromptHost = {
    authorize: jest.fn(),
    open: jest.fn(() =>
      Promise.resolve({
        generation: 1,
        runTurn: turn,
        listModels: () => Promise.resolve([]),
        getQuota: () => Promise.reject(new Error('Unexpected quota request')),
        close: () => Promise.resolve(),
        account: { host: 'https://github.com', login: 'fixture' },
      }),
    ),
  };
  return {
    executionsDir: join(root, 'executions'),
    tempRootDir: join(root, 'tmp'),
    bundledActionsDir: resolve('packages/desktop-shared/resources/actions'),
    getProjectActionsDir: (path: string) => path,
    getProjectPipelinesDir: (path: string) => path,
    isModelBlockedByOrgPolicy: () => Promise.resolve(false),
    isOrgModelPolicyActive: () => Promise.resolve(false),
    resolvePipelineTarget: (request): Promise<ResolvePipelineTargetResult> => {
      const target = request.parent.target;
      if (
        target?.scope !== 'worktree' ||
        target.workspace_id !== workspaceId ||
        target.worktree_id !== worktreeId
      ) {
        return Promise.reject(
          new Error('Fixture target is not the relocated destination'),
        );
      }
      return Promise.resolve({
        scope: 'worktree',
        cwd: target.path,
        target,
        projectId: workspaceId,
        worktreeId,
      });
    },
    copilotPromptRunner: {
      runCopilotPrompt: (request) => runCopilotPipelinePrompt(request, host),
    },
  };
}

export function policyExecution(
  runtime: ExecutionRuntime,
  checkout: string,
  matrix = false,
): ExecutionState {
  const cwd = join(checkout, 'desktop');
  const state = createInitialState(
    normalizePipeline({
      name: 'Relocated Copilot',
      scope: 'worktree',
      on: 'dispatch',
      jobs: {
        review: {
          ...(matrix ? { strategy: { matrix: { value: ['one'] } } } : {}),
          steps: [
            {
              id: 'prompt',
              uses: 'builtin/agent-prompt',
              with: { model: 'copilot:test', prompt: 'Review' },
            },
          ],
        },
      },
    }),
    {
      runtime,
      cwd,
      pipelineId: 'policy',
      projectId: 'source',
      worktreeId: 'old',
      scope: 'worktree',
      executionCheckoutRoot: checkout,
      repoPath: checkout,
      pipelineFileDir: join(checkout, 'pipelines'),
      target: {
        scope: 'worktree',
        workspace_id: 'source',
        worktree_id: 'old',
        path: cwd,
        created: false,
      },
    },
    matrix ? 'matrix-execution' : 'execution',
  );
  state.status = 'failure';
  for (const job of Object.values(state.jobs)) {
    job.status = 'failure';
    job.conclusion = 'failure';
    job.outcome = 'failure';
    job.steps.prompt = {
      status: 'failure',
      outputs: {},
      dynamic_env: {},
      error: 'synthetic failure before opening a session',
    };
  }
  refreshAllJobGroups(state);
  return state;
}

export async function seedDestinationPolicy(checkout: string): Promise<void> {
  await mkdir(join(checkout, 'desktop'), { recursive: true });
  await mkdir(join(checkout, 'pipelines'), { recursive: true });
  await writeFile(
    join(checkout, 'pipelines', 'relocated-child.yaml'),
    'name: Relocated child\non: dispatch\njobs:\n  check:\n    steps:\n      - run: echo checked\n',
  );
  await writeFile(join(checkout, 'CLAUDE.md'), 'DESTINATION ROOT');
  await writeFile(join(checkout, 'desktop', 'AGENTS.md'), 'DESTINATION SCOPED');
}

export async function replayPolicy(
  state: ExecutionState,
  runtime: ExecutionRuntime,
  mode: 'resume' | 'retry' | 'matrix' | 'rerun',
  expectedFailure?: string,
): Promise<ExecutionState> {
  initCopilotModels([
    {
      id: 'copilot:test',
      rawModelId: 'test',
      label: 'Test',
      supportsVision: false,
      supportedThinkingLevels: [],
    },
  ]);
  turn.mockReset();
  turn.mockImplementation(async (options) => {
    await options.onToolsReady?.(
      createCopilotCapabilitySnapshot({ tools: [] }),
      [],
    );
    await options.onSession?.('fresh-session');
    return {
      sessionId: 'fresh-session',
      text: 'done',
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
    };
  });
  try {
    const replayState = structuredClone(state);
    if (mode === 'resume') {
      replayState.status = 'pending';
      for (const job of Object.values(replayState.jobs)) {
        job.status = 'pending';
        delete job.conclusion;
        delete job.outcome;
        job.steps.prompt = { status: 'pending', outputs: {}, dynamic_env: {} };
      }
      refreshAllJobGroups(replayState);
    }
    await saveExecutionState(replayState, runtime.executionsDir);
    const options = { runtime, cwd: runtime.tempRootDir };
    const handle =
      mode === 'resume'
        ? await resumePipeline(state.id, options)
        : mode === 'retry'
          ? await retryPipelineExecution(state.id, options)
          : mode === 'matrix'
            ? await retryMatrixJobExecution(
                { executionId: state.id, jobId: 'review', mode: 'failed' },
                options,
              )
            : await rerunPipelineExecution(state.id, options);
    const completed = await handle.waitForCompletion();
    if (expectedFailure) {
      expect(completed.status).toBe('failure');
      expect(
        Object.values(completed.jobs)
          .map((job) => job.steps.prompt?.error)
          .join(' '),
      ).toContain(expectedFailure);
      expect(turn).not.toHaveBeenCalled();
      return completed;
    }
    for (const job of Object.values(completed.jobs))
      expect(job.steps.prompt?.error).toBeUndefined();
    expect(completed.status).toBe('success');
    expect(completed.execution_checkout_root).toBe(
      state.execution_checkout_root,
    );
    expect(completed.repo_path).toBe(state.repo_path);
    expect(turn).toHaveBeenCalledTimes(1);
    const outbound = turn.mock.calls[0][0];
    expect(outbound.workingDirectory).toBe(state.cwd);
    expect(outbound.sessionId).toBeUndefined();
    expect(outbound.systemPrompt).toContain('### CLAUDE.md\nDESTINATION ROOT');
    expect(outbound.systemPrompt).toContain(
      '### desktop/AGENTS.md\nDESTINATION SCOPED',
    );
    expect(outbound.systemPrompt).not.toContain('ANCESTOR');
    return completed;
  } finally {
    initCopilotModels([]);
  }
}
