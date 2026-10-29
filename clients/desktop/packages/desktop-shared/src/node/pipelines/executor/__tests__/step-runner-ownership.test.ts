import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type {
  ExecutionState,
  Pipeline,
  PipelineAgentAuthor,
  PipelineAgentChatAddress,
  PipelineExecutionInitiator,
  PipelinePreferenceLocator,
  PipelineRunTarget,
  ResolvedPipelineExecutionTarget,
} from '@canopy/desktop-shared/types/pipeline';
import { listExecutionSummaries, loadExecutionState } from '../execution-state';
import {
  executePipeline,
  rerunPipelineExecution,
  resumePipeline,
  retryPipelineExecution,
} from '../pipeline-executor';
import type { ResolvedChildPipeline } from '../child-pipeline-resolver';
import type {
  ExecutionRuntime,
  PipelineOwnershipPort,
  ResolvePipelineTargetResult,
} from '../types';

const PARENT_CHAT: PipelineAgentChatAddress = {
  projectId: 'workspace-1',
  worktreeId: 'worktree-1',
  chatId: 'chat-parent',
};
const AUTHOR_CHAT: PipelineAgentChatAddress = {
  projectId: 'workspace-2',
  worktreeId: 'worktree-2',
  chatId: 'chat-author',
};
const AGENT_INITIATOR: PipelineExecutionInitiator = {
  kind: 'agent',
  chat: PARENT_CHAT,
};

interface OwnershipCalls {
  authorized: {
    executionContext: string | undefined;
    target: ResolvedPipelineExecutionTarget;
  }[];
  authorLookups: PipelinePreferenceLocator[];
}

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

function installOwnership(
  runtime: ExecutionRuntime,
  options: {
    refuse?: string;
    author?: PipelineAgentAuthor;
  } = {},
): OwnershipCalls {
  const calls: OwnershipCalls = { authorized: [], authorLookups: [] };
  const port: PipelineOwnershipPort = {
    authorizeTarget: (args): Promise<void> => {
      calls.authorized.push(args);
      return options.refuse
        ? Promise.reject(new Error(options.refuse))
        : Promise.resolve();
    },
    readAgentAuthor: (locator): PipelineAgentAuthor | undefined => {
      calls.authorLookups.push(locator);
      return options.author;
    },
  };
  runtime.pipelineOwnership = port;
  return calls;
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

const CHILD: Pipeline = {
  name: 'Child',
  on: 'dispatch',
  scope: ['worktree', 'directory', 'global'],
  jobs: { build: { steps: [{ id: 'hello', run: 'echo child' }] } },
};

function parentPipeline(
  childStep: { target?: PipelineRunTarget; with: Record<string, string> },
  options: { fail?: boolean } = {},
): Pipeline {
  return {
    name: 'Parent',
    on: 'dispatch',
    jobs: {
      build: {
        steps: [
          {
            id: 'child',
            uses: 'builtin/run-pipeline',
            ...(childStep.target ? { target: childStep.target } : {}),
            with: childStep.with,
          },
          ...(options.fail ? [{ id: 'fail', run: 'exit 1' }] : []),
        ],
      },
    },
  };
}

const OTHER_WORKTREE: PipelineRunTarget = {
  scope: 'worktree',
  workspace_id: 'workspace-other',
  worktree: { id: 'worktree-other' },
};

async function childState(
  runtime: ExecutionRuntime,
  parent: ExecutionState,
): Promise<ExecutionState | null> {
  const childId = parent.jobs.build.steps.child.child_execution_id;
  if (childId === undefined) throw new Error('Expected a child execution');
  return loadExecutionState(childId, runtime.executionsDir);
}

describe('run-pipeline ownership and run identity', () => {
  let tempDir: string;
  let runtime: ExecutionRuntime;

  beforeEach(() => {
    tempDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'pipeline-ownership-')),
    );
    runtime = createRuntime(tempDir);
    writeRunPipelineAction(runtime);
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('checks an explicit worktree target and fails the step with the port message', async () => {
    const calls = installOwnership(runtime, {
      refuse: "Project `workspace-other` isn't available to this pipeline",
    });

    const state = await (
      await executePipeline(
        parentPipeline({
          target: OTHER_WORKTREE,
          with: { pipeline_yaml: JSON.stringify(CHILD) },
        }),
        {
          cwd: tempDir,
          runtime,
          pipelineId: 'parent',
          executionContext: 'personal',
        },
      )
    ).waitForCompletion();

    expect(state.status).toBe('failure');
    expect(calls.authorized).toEqual([
      {
        executionContext: 'personal',
        target: {
          scope: 'worktree',
          workspace_id: 'workspace-other',
          worktree_id: 'worktree-other',
        },
      },
    ]);
    expect(state.jobs.build.steps.child.child_execution_id).toBeUndefined();
    expect(JSON.stringify(state.jobs.build.steps.child)).toContain(
      "isn't available to this pipeline",
    );
  });

  it('checks a requested worktree before resolving it, so a missing one looks the same', async () => {
    const calls = installOwnership(runtime, {
      refuse: "Project `workspace-other` isn't available to this pipeline",
    });
    const resolved: unknown[] = [];
    runtime.resolvePipelineTarget = (
      request,
    ): Promise<ResolvePipelineTargetResult> => {
      resolved.push(request.requested);
      return Promise.reject(new Error('Worktree worktree-other not found'));
    };

    const state = await (
      await executePipeline(
        parentPipeline({
          target: OTHER_WORKTREE,
          with: { pipeline_yaml: JSON.stringify(CHILD) },
        }),
        {
          cwd: tempDir,
          runtime,
          pipelineId: 'parent',
          executionContext: 'personal',
        },
      )
    ).waitForCompletion();

    expect(state.status).toBe('failure');
    expect(resolved).toEqual([]);
    expect(calls.authorized).toHaveLength(1);
    const step = JSON.stringify(state.jobs.build.steps.child);
    expect(step).toContain("isn't available to this pipeline");
    expect(step).not.toContain('not found');
  });

  it('does not check an inherited target', async () => {
    const calls = installOwnership(runtime);

    const state = await (
      await executePipeline(
        parentPipeline({
          target: { scope: 'inherit' },
          with: { pipeline_yaml: JSON.stringify(CHILD) },
        }),
        { cwd: tempDir, runtime, pipelineId: 'parent' },
      )
    ).waitForCompletion();

    expect(state.status).toBe('success');
    expect(calls.authorized).toEqual([]);
  });

  it('runs an explicit target unchecked without a port', async () => {
    const state = await (
      await executePipeline(
        parentPipeline({
          target: OTHER_WORKTREE,
          with: { pipeline_yaml: JSON.stringify(CHILD) },
        }),
        { cwd: tempDir, runtime, pipelineId: 'parent' },
      )
    ).waitForCompletion();

    expect(state.status).toBe('success');
  });

  it('passes the initiator and agent origin to a child', async () => {
    const calls = installOwnership(runtime, {
      author: { chat: AUTHOR_CHAT, recordedAt: '2026-10-19T00:00:00.000Z' },
    });

    const state = await (
      await executePipeline(
        parentPipeline({ with: { pipeline_yaml: JSON.stringify(CHILD) } }),
        {
          cwd: tempDir,
          runtime,
          pipelineId: 'parent',
          initiator: AGENT_INITIATOR,
          agentOrigin: PARENT_CHAT,
        },
      )
    ).waitForCompletion();

    expect(state.initiator).toEqual(AGENT_INITIATOR);
    expect(state.agent_origin).toEqual(PARENT_CHAT);
    const child = await childState(runtime, state);
    expect(child?.initiator).toEqual(AGENT_INITIATOR);
    expect(child?.agent_origin).toEqual(PARENT_CHAT);
    expect(calls.authorLookups).toEqual([]);
  });

  it("takes a stored user child's agent author when the parent has no origin", async () => {
    const calls = installOwnership(runtime, {
      author: { chat: AUTHOR_CHAT, recordedAt: '2026-10-19T00:00:00.000Z' },
    });
    // Scope validation resolves refs without the host; give it a file.
    fs.writeFileSync(
      path.join(tempDir, 'agent-written.yaml'),
      JSON.stringify(CHILD),
    );
    runtime.resolvePipelineResource = (
      reference,
    ): Promise<ResolvedChildPipeline | undefined> =>
      Promise.resolve({
        pipeline: CHILD,
        pipelineId: reference,
        preferenceLocator: { type: 'stored', source: 'user', value: reference },
      });

    const state = await (
      await executePipeline(
        parentPipeline({ with: { pipeline: 'agent-written' } }),
        {
          cwd: tempDir,
          runtime,
          pipelineId: 'parent',
          initiator: { kind: 'user' },
        },
      )
    ).waitForCompletion();

    expect(state.status).toBe('success');
    expect(state.agent_origin).toBeUndefined();
    const child = await childState(runtime, state);
    expect(child?.initiator).toEqual({ kind: 'user' });
    expect(child?.agent_origin).toEqual(AUTHOR_CHAT);
    expect(calls.authorLookups).toEqual([
      { type: 'stored', source: 'user', value: 'agent-written' },
    ]);
  });

  it('keeps the source identity on retry and rerun, and surfaces the owner in summaries', async () => {
    const failed = await (
      await executePipeline(
        {
          name: 'Identity',
          on: 'dispatch',
          jobs: { build: { steps: [{ id: 'fail', run: 'exit 1' }] } },
        },
        {
          cwd: tempDir,
          runtime,
          pipelineId: 'identity',
          executionContext: 'personal',
          initiator: AGENT_INITIATOR,
          agentOrigin: PARENT_CHAT,
        },
      )
    ).waitForCompletion();

    const reloaded = await loadExecutionState(failed.id, runtime.executionsDir);
    expect(reloaded?.initiator).toEqual(AGENT_INITIATOR);
    expect(reloaded?.agent_origin).toEqual(PARENT_CHAT);

    const retried = await (
      await retryPipelineExecution(failed.id, { cwd: tempDir, runtime })
    ).waitForCompletion();
    expect(retried.initiator).toEqual(AGENT_INITIATOR);
    expect(retried.agent_origin).toEqual(PARENT_CHAT);

    const rerun = await (
      await rerunPipelineExecution(failed.id, { cwd: tempDir, runtime })
    ).waitForCompletion();
    expect(rerun.id).not.toBe(failed.id);
    expect(rerun.initiator).toEqual(AGENT_INITIATOR);
    expect(rerun.agent_origin).toEqual(PARENT_CHAT);

    const summaries = await listExecutionSummaries(runtime.executionsDir);
    expect(
      summaries.find((summary) => summary.id === failed.id)?.execution_context,
    ).toBe('personal');
  });

  it('keeps the source identity on resume', async () => {
    const handle = await executePipeline(
      {
        name: 'Identity pause',
        on: 'dispatch',
        jobs: { build: { steps: [{ id: 'wait', run: 'sleep 30' }] } },
      },
      {
        cwd: tempDir,
        runtime,
        pipelineId: 'identity-pause',
        initiator: AGENT_INITIATOR,
        agentOrigin: PARENT_CHAT,
      },
    );
    if (!handle.pauseForShutdown) throw new Error('Expected shutdown pause');
    const paused = await handle.pauseForShutdown();
    expect(paused.status).toBe('paused');

    const resumed = await resumePipeline(paused.id, { cwd: tempDir, runtime });
    const state = resumed.getState();
    await resumed.cancel();

    expect(state.initiator).toEqual(AGENT_INITIATOR);
    expect(state.agent_origin).toEqual(PARENT_CHAT);
  });

  it('drops a malformed persisted identity on load', async () => {
    const state = await (
      await executePipeline(CHILD, {
        cwd: tempDir,
        runtime,
        pipelineId: 'malformed',
        scope: 'directory',
      })
    ).waitForCompletion();
    const statePath = path.join(runtime.executionsDir, `${state.id}.json`);
    const raw: unknown = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    fs.writeFileSync(
      statePath,
      JSON.stringify({
        ...(typeof raw === 'object' && raw !== null ? raw : {}),
        initiator: { kind: 'agent', chat: { projectId: 'p' } },
        agent_origin: { projectId: 'p', worktreeId: '', chatId: 'c' },
      }),
    );

    const reloaded = await loadExecutionState(state.id, runtime.executionsDir);
    expect(reloaded?.initiator).toBeUndefined();
    expect(reloaded?.agent_origin).toBeUndefined();
  });
});
