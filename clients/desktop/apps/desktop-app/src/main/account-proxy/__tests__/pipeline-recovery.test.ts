import { randomUUID } from 'node:crypto';
import { ResumeQueueStorage } from '../../services/resume-queue-storage';
import type {
  ResumeQueueSnapshot,
  ResumeQueueEntry,
  UsageLimitedChatEntry,
  ResumeQueueItem,
} from '@canopy/desktop-shared/types';
import type { AccountProxyPipelineInterruption } from '../quota-recovery';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizePipeline } from '@canopy/desktop-shared/pipelines/normalize-pipeline';
import {
  createInitialState,
  saveExecutionState,
  loadExecutionState,
  prepareExecutionResume,
} from '@canopy/desktop-shared/node/pipelines/executor';
import type {
  ExecutionState,
  ExecutionRuntime,
} from '@canopy/desktop-shared/node/pipelines/executor';
import {
  canResumeAccountProxyPipelineEntry,
  projectAccountProxyPipelineInterruptions,
  readAccountProxyPipelineInterruptions,
} from '../pipeline-recovery';
import { AccountProxyQuotaRecovery } from '../quota-recovery';
import { ResumeQueueService } from '../../services/resume-queue-service';
import type { AccountProxyStatus } from '@canopy/desktop-shared/types/account-proxy';
function state(dir: string): ExecutionState {
  const runtime: ExecutionRuntime = {
    executionsDir: dir,
    tempRootDir: dir,
    bundledActionsDir: dir,
    getProjectActionsDir: (cwd): string => cwd,
    getProjectPipelinesDir: (cwd): string => cwd,
  };
  const pipeline = normalizePipeline({
    name: 'Automation',
    on: 'dispatch',
    jobs: {
      job: {
        steps: [
          { id: 'completed', run: 'echo done' },
          {
            id: 'agent',
            uses: 'builtin/agent-prompt',
            with: { prompt: 'Continue work' },
          },
        ],
      },
    },
  });
  const result = createInitialState(
    pipeline,
    { runtime, cwd: dir, env: {}, pipelineId: 'pipeline' },
    '123e4567-e89b-42d3-a456-426614174000',
  );
  const reasonId = '123e4567-e89b-42d3-a456-426614174001';
  result.status = 'paused';
  result.jobs.job.status = 'paused';
  result.jobs.job.steps.completed = {
    status: 'success',
    outputs: { value: 'preserved' },
    dynamic_env: {},
  };
  result.jobs.job.steps.agent = {
    status: 'paused',
    outputs: {},
    dynamic_env: {},
    agent_recovery: {
      version: 2,
      reason_id: reasonId,
      action: 'agent-prompt',
      provider: 'codex',
      harness: 'codex',
      step_id: 'agent',
      session_id: 'original-thread',
      had_agent_activity: true,
      strategy: 'continue_session',
      recovery_count: 0,
      paused_at: new Date(1000).toISOString(),
      failure_message: 'Quota reached',
      account_proxy_connection_id: 'proxy',
    },
  };
  result.status_reasons = [
    {
      id: reasonId,
      kind: 'provider_usage_limit',
      code: 'usage_limit_exceeded',
      provider: 'codex',
      account_scope: 'native',
      account_proxy_connection_id: 'proxy',
      detected_at: new Date(1000).toISOString(),
      source: { job_id: 'job', step_id: 'agent', attempt: 0, iteration: 1 },
    },
  ];
  return result;
}
it('recovers a pipeline after restart while preserving completed steps and the provider session', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'proxy-pipeline-'));
  try {
    const original = state(dir);
    await saveExecutionState(original, dir);
    const restored = await loadExecutionState(original.id, dir);
    if (!restored) throw new Error('Expected execution');
    expect(restored.status_reasons[0].account_proxy_connection_id).toBe(
      'proxy',
    );
    expect(
      restored.jobs.job.steps.agent.agent_recovery?.account_proxy_connection_id,
    ).toBe('proxy');
    const status: AccountProxyStatus = {
      available: true,
      connection: { id: 'proxy', kind: 'server', url: 'https://proxy.test' },
      state: 'connected',
      error: null,
      version: '8',
      accounts: [
        {
          authIndex: 'new-account',
          provider: 'codex',
          label: 'new',
          source: 'sign-in',
          fileName: 'new.json',
          planType: null,
          status: 'active',
          statusMessage: null,
          availableAt: null,
          limits: [],
        },
      ],
      routing: null,
      routeClaude: true,
      routeCodex: true,
      keepChatOnOneAccount: true,
      refreshedAt: 2000,
    };
    const queue = new ResumeQueueService({
      now: (): number => 2000,
      load: (): Promise<ResumeQueueSnapshot | null> => Promise.resolve(null),
      save: (): Promise<void> => Promise.resolve(),
      changed: (): void => undefined,
      reconcile: (): Promise<{ status: 'waiting' }> =>
        Promise.resolve({ status: 'waiting' }),
      dispatch: (entry): Promise<'resumed'> => {
        if (entry.target.kind !== 'pipeline')
          throw new Error('Expected pipeline');
        const prepared = prepareExecutionResume(restored, {
          statusReasonIds: entry.target.statusReasonIds,
        });
        expect(prepared.jobs.job.steps.completed).toEqual(
          original.jobs.job.steps.completed,
        );
        expect(prepared.jobs.job.steps.agent.agent_recovery).toMatchObject({
          session_id: 'original-thread',
          strategy: 'continue_session',
        });
        return Promise.resolve('resumed');
      },
    });
    const recovery = new AccountProxyQuotaRecovery({
      now: (): number => 2000,
      readInterrupted: (): Promise<UsageLimitedChatEntry[]> =>
        Promise.resolve([]),
      readPipelines: (): Promise<AccountProxyPipelineInterruption[]> =>
        readAccountProxyPipelineInterruptions(dir),
      readStatus: (): Promise<AccountProxyStatus> => Promise.resolve(status),
      resolveItems: (): Promise<ResumeQueueItem[]> => Promise.resolve([]),
    });
    await recovery.collect(queue);
    expect(queue.snapshot().entries).toHaveLength(1);
    await queue.tick();
    expect(queue.snapshot().entries[0].status).toBe('resumed');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
it('resolves automatic pipeline labels from the host project lookup', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'proxy-pipeline-label-'));
  try {
    const original = state(dir);
    original.project_id = 'internal-project-id';
    original.worktree_id = 'worktree';
    await saveExecutionState(original, dir);
    const resolveName = jest.fn(
      (): Promise<string | undefined> =>
        Promise.resolve('Project display name'),
    );
    const entries = await readAccountProxyPipelineInterruptions(
      dir,
      resolveName,
    );
    expect(resolveName).toHaveBeenCalledWith('internal-project-id', 'worktree');
    expect(entries[0]?.item.workspaceName).toBe('Project display name');
    resolveName.mockResolvedValue(undefined);
    expect(
      (await readAccountProxyPipelineInterruptions(dir, resolveName))[0]?.item
        .workspaceName,
    ).toBe('Local pipelines');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it('labels local pipeline recovery with the existing local group name', () => {
  expect(
    projectAccountProxyPipelineInterruptions(state('/tmp/executions'))[0]?.item
      .workspaceName,
  ).toBe('Local pipelines');
});

it('does not automatically resume hidden, cancelled, native, suppressed, or unsafe pipeline work', () => {
  const original = state('/tmp/executions');
  expect(projectAccountProxyPipelineInterruptions(original)).toHaveLength(1);
  for (const candidate of [
    { ...original, hidden: true },
    { ...original, status: 'cancelled' as const },
    { ...original, parent_execution_id: 'root' },
  ]) {
    expect(projectAccountProxyPipelineInterruptions(candidate)).toHaveLength(0);
  }
  original.status_reasons[0].auto_resume_suppressed = true;
  expect(projectAccountProxyPipelineInterruptions(original)).toHaveLength(0);
  delete original.status_reasons[0].auto_resume_suppressed;
  delete original.jobs.job.steps.agent.agent_recovery;
  expect(projectAccountProxyPipelineInterruptions(original)).toHaveLength(0);
});

it('keeps a ready harness in a mixed pipeline independent of another exhausted harness', () => {
  const original = state('/tmp/executions');
  original.jobs.claude = structuredClone(original.jobs.job);
  const checkpoint = original.jobs.claude.steps.agent.agent_recovery;
  if (!checkpoint) throw new Error('Expected checkpoint');
  checkpoint.provider = 'claude';
  checkpoint.harness = 'claude';
  const id = '123e4567-e89b-42d3-a456-426614174009';
  checkpoint.reason_id = id;
  checkpoint.session_id = 'claude-session';
  original.status_reasons.push({
    ...original.status_reasons[0],
    id,
    provider: 'claude',
    source: { ...original.status_reasons[0].source, job_id: 'claude' },
  });
  const projected = projectAccountProxyPipelineInterruptions(original);
  expect(projected.map((entry) => entry.item.providers)).toEqual([
    ['codex'],
    ['claude'],
  ]);
  const ready = projected.find((entry) =>
    entry.item.providers?.includes('claude'),
  );
  if (!ready) throw new Error('Expected ready harness');
  const status: AccountProxyStatus = {
    available: true,
    connection: { id: 'proxy', kind: 'server', url: 'https://proxy.test' },
    state: 'connected',
    error: null,
    version: '8',
    routing: null,
    routeClaude: true,
    routeCodex: true,
    keepChatOnOneAccount: true,
    refreshedAt: 2000,
    accounts: [
      {
        authIndex: 'added',
        provider: 'claude',
        label: 'Added account',
        source: 'sign-in',
        fileName: 'added.json',
        planType: null,
        status: 'active',
        statusMessage: null,
        availableAt: null,
        limits: [],
      },
    ],
  };
  const entry: ResumeQueueEntry = {
    ...ready.item,
    id: 'queue',
    status: 'waiting',
    createdAt: 2000,
  };
  expect(
    canResumeAccountProxyPipelineEntry(entry, original, status, 2000),
  ).toBe(true);
  expect(entry.target).toMatchObject({ statusReasonIds: [id] });
});

it('persists hundreds of paused steps with a bounded stable interruption identity', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'proxy-pipeline-many-'));
  try {
    const original = state(dir);
    const template = original.status_reasons[0];
    original.status_reasons = Array.from({ length: 271 }, (_, index) => {
      const id = randomUUID();
      const stepId = `agent-${index}`;
      const step = structuredClone(original.jobs.job.steps.agent);
      if (!step.agent_recovery) throw new Error('Expected checkpoint');
      step.agent_recovery.reason_id = id;
      step.agent_recovery.step_id = stepId;
      original.jobs.job.steps[stepId] = step;
      return {
        ...template,
        id,
        source: { ...template.source, step_id: stepId },
      };
    });
    const projected = projectAccountProxyPipelineInterruptions(original)[0];
    if (!projected) throw new Error('Expected interruption');
    const storage = new ResumeQueueStorage(join(dir, 'resume-queue.json'));
    const queue = new ResumeQueueService({
      now: (): number => 2000,
      load: (): Promise<ResumeQueueSnapshot | null> => storage.load(),
      save: (snapshot): Promise<void> => storage.save(snapshot),
      changed: (): void => undefined,
      reconcile: (): Promise<{ status: 'waiting' }> =>
        Promise.resolve({ status: 'waiting' }),
      dispatch: (): Promise<'resumed'> => Promise.resolve('resumed'),
    });
    await expect(
      queue.enqueue([
        projected.item,
        {
          target: {
            kind: 'chat',
            projectId: 'project',
            worktreeId: 'worktree',
            chatId: 'unrelated',
          },
          interruptionId: 'unrelated-limit',
          title: 'Other work',
          workspaceName: 'Workspace',
        },
      ]),
    ).resolves.toMatchObject({ paused: false });
    expect(projected.item.interruptionId.length).toBeLessThanOrEqual(100);
    original.status_reasons.reverse();
    expect(
      projectAccountProxyPipelineInterruptions(original)[0]?.item
        .interruptionId,
    ).toBe(projected.item.interruptionId);
    const restored = await storage.load();
    expect(restored?.entries).toHaveLength(2);
    expect(restored?.entries[0].target).toMatchObject({
      statusReasonIds: original.status_reasons
        .map((reason) => reason.id)
        .sort(),
    });
    await queue.tick();
    expect(queue.snapshot().entries[0].status).toBe('resumed');
    expect(queue.snapshot().paused).toBe(false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
