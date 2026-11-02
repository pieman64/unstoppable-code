const mockReadFile = jest.fn<Promise<string>, [string, string?]>();
const mockAppendFile = jest.fn<Promise<void>, [string, string]>();
const mockMkdir = jest.fn<Promise<void>, [string, { recursive?: boolean }?]>();
const mockStat = jest.fn<Promise<{ size: number }>, [string]>();
const mockWriteFile = jest.fn<Promise<void>, [string, string]>();
const mockReadPreferencesFile = jest.fn();
const mockCheckClaudeAuthStatusObserved = jest.fn();
const mockPeekProviderAccountIdentity = jest.fn(() => null);
const mockPeekProviderBillingAccountKind = jest.fn(() => 'api_key');
const mockWarmProviderAccountIdentity = jest.fn();
const mockCodexRequest = jest.fn<Promise<unknown>, [string, unknown?]>(() =>
  Promise.resolve({ account: null }),
);
const mockCodexOnAccountUpdated = jest.fn(() => (): void => undefined);
const mockCodexOnRateLimitsUpdated = jest.fn(() => (): void => undefined);

jest.mock('node:fs/promises', () => ({
  get appendFile(): typeof mockAppendFile {
    return mockAppendFile;
  },
  get mkdir(): typeof mockMkdir {
    return mockMkdir;
  },
  get readFile(): typeof mockReadFile {
    return mockReadFile;
  },
  readdir: jest.fn(),
  rename: jest.fn(),
  rm: jest.fn(),
  unlink: jest.fn(),
  get stat(): typeof mockStat {
    return mockStat;
  },
  get writeFile(): typeof mockWriteFile {
    return mockWriteFile;
  },
}));

jest.mock('../../lib/paths', () => ({
  getAgentObservabilityAppEventsDayFilePath: (day: string): string =>
    `/app-events/${day}.jsonl`,
  getAgentObservabilityAppEventsDir: (): string => '/app-events',
  getAgentObservabilityAuditDayFilePath: (day: string): string =>
    `/audit/${day}.jsonl`,
  getAgentObservabilityAuditDir: (): string => '/audit',
  getAgentObservabilitySessionEventsDayFilePath: (day: string): string =>
    `/session-events/${day}.jsonl`,
  getAgentObservabilitySessionEventsDir: (): string => '/session-events',
  getAgentObservabilitySnapshotPath: (): string => '/audit/snapshot.json',
  getAgentObservabilityTranscriptDayDir: (day: string): string =>
    `/transcripts/${day}`,
  getAgentObservabilityTranscriptFilePath: (request: { id: string }): string =>
    `/transcripts/${request.id}.jsonl`,
  getAgentObservabilityTranscriptIndexDayFilePath: (day: string): string =>
    `/transcript-index/${day}.jsonl`,
  getAgentObservabilityTranscriptIndexDir: (): string => '/transcript-index',
  getAgentObservabilityTranscriptsDir: (): string => '/transcripts',
  getAgentObservabilityUsageEventsDayFilePath: (day: string): string =>
    `/usage/${day}.jsonl`,
  getAgentObservabilityUsageEventsDir: (): string => '/usage',
}));

jest.mock('../../lib/preferences-store', () => ({
  get readPreferencesFile(): typeof mockReadPreferencesFile {
    return mockReadPreferencesFile;
  },
}));

jest.mock('../../lib/atomic-file', () => ({
  writeFileAtomically: jest.fn(() => Promise.resolve()),
}));

jest.mock('../../auth/provider-auth-state', () => ({
  get checkClaudeAuthStatusObserved(): typeof mockCheckClaudeAuthStatusObserved {
    return mockCheckClaudeAuthStatusObserved;
  },
  get peekProviderAccountIdentity(): typeof mockPeekProviderAccountIdentity {
    return mockPeekProviderAccountIdentity;
  },
  get peekProviderBillingAccountKind(): typeof mockPeekProviderBillingAccountKind {
    return mockPeekProviderBillingAccountKind;
  },
  get warmProviderAccountIdentity(): typeof mockWarmProviderAccountIdentity {
    return mockWarmProviderAccountIdentity;
  },
}));

jest.mock('../../feature-flags', () => ({
  getFeatureFlagService: (): {
    onSnapshotChanged: () => () => void;
  } => ({ onSnapshotChanged: (): (() => void) => (): void => undefined }),
}));
jest.mock('../../cursor/feature-flag', () => ({
  isCursorHarnessEnabled: (): boolean => false,
}));
jest.mock('../../cursor/account-usage', () => ({
  readCursorAccountUsage: jest.fn(),
}));
jest.mock('../../copilot/feature-flag', () => ({
  isCopilotHarnessEnabled: (): boolean => false,
}));
jest.mock('../../copilot/account-usage', () => ({
  readCopilotUsageSummary: jest.fn(),
}));
jest.mock('../../copilot/usage-events', () => ({
  onCopilotUsageChanged: (): (() => void) => (): void => undefined,
}));
jest.mock('../../codex/runtime-service', () => ({
  getCodexRuntimeService: (): {
    admin: () => {
      request: typeof mockCodexRequest;
      onAccountUpdated: typeof mockCodexOnAccountUpdated;
      onRateLimitsUpdated: typeof mockCodexOnRateLimitsUpdated;
    };
  } => ({
    admin: () => ({
      get request(): typeof mockCodexRequest {
        return mockCodexRequest;
      },
      get onAccountUpdated(): typeof mockCodexOnAccountUpdated {
        return mockCodexOnAccountUpdated;
      },
      get onRateLimitsUpdated(): typeof mockCodexOnRateLimitsUpdated {
        return mockCodexOnRateLimitsUpdated;
      },
    }),
  }),
}));
jest.mock('../../memory/local/citation-tracking', () => ({
  isLocalMemoryCitationTrackingEnabled: (): Promise<boolean> =>
    Promise.resolve(false),
  trackCompletedTurnLocalMemoryCitations: (): Promise<void> =>
    Promise.resolve(),
}));
jest.mock('../../openai-pricing/pricing-client', () => ({
  getOpenAiPricingForCostingSync: (): {
    loadedFrom: 'none';
    stale: boolean;
  } => ({ loadedFrom: 'none', stale: true }),
  prewarmOpenAiPricingCache: (): void => undefined,
}));

import type { AgentAuditEntry } from '@canopy/desktop-shared/types';
import {
  readdir as readdirModuleMock,
  rename as renameModuleMock,
  rm as rmModuleMock,
  unlink as unlinkModuleMock,
} from 'node:fs/promises';
import type { StepResult } from '@canopy/desktop-shared/types/pipeline';
import {
  ObservabilityService,
  type PipelineExecutionStateSyncInput,
} from '../service';

const mockReaddir = jest.mocked(readdirModuleMock);
const mockRename = jest.mocked(renameModuleMock);
const mockRm = jest.mocked(rmModuleMock);
const mockUnlink = jest.mocked(unlinkModuleMock);

const STARTED_AT = '2026-10-13T03:48:55.778Z';
const PERSISTED_STARTED_AT = '2026-10-13T03:48:55.824Z';
const ZERO_TOOL_COUNTS: AgentAuditEntry['toolCounts'] = {
  thinking: 0,
  bash: 0,
  read: 0,
  readLines: 0,
  writeEdit: 0,
  plan: 0,
  fileEdit: 0,
  fileAdd: 0,
  fileDelete: 0,
  search: 0,
  grep: 0,
  web: 0,
  agent: 0,
  workflow: 0,
  tasks: 0,
  taskStop: 0,
  skills: 0,
  monitor: 0,
  claude: 0,
  scheduleWakeup: 0,
  askUser: 0,
  scriptOutput: 0,
  watcher: 0,
  canopy: 0,
  graph: 0,
  appAdvisor: 0,
  pipelineEditor: 0,
  mcp: 0,
  other: 0,
};
const ITERATION_TWO_STARTED_AT = '2026-10-13T03:49:10.000Z';

function pipelineState(
  id: string,
  jobs: PipelineExecutionStateSyncInput['jobs'],
): PipelineExecutionStateSyncInput {
  return {
    id,
    pipeline_id: 'pipeline-1',
    pipeline_snapshot: { name: 'Pipeline' },
    project_id: 'proj',
    worktree_id: 'wt',
    jobs,
  };
}

function agentStep(
  provider: 'claude' | 'codex',
  startedAt: string,
  status: StepResult['status'] = 'running',
  completedAt?: string,
): StepResult {
  return {
    status,
    outputs: {},
    dynamic_env: {},
    started_at: startedAt,
    ...(completedAt === undefined ? {} : { completed_at: completedAt }),
    log_format_hint: 'agent',
    agent_provider: provider,
    agent_model: provider === 'codex' ? 'gpt-5.3-codex' : 'claude-sonnet-4-6',
  };
}

function codexStream(
  threadId: string,
  turnId: string,
  inputTokens: number,
  outputTokens: number,
): string {
  return `${[
    { type: 'thread.started', thread_id: threadId },
    { type: 'turn.started', thread_id: threadId, turn_id: turnId },
    {
      type: 'thread.token_usage.updated',
      thread_id: threadId,
      turn_id: turnId,
      usage: {
        input_tokens: inputTokens,
        cached_input_tokens: 4,
        output_tokens: outputTokens,
        reasoning_output_tokens: 2,
        cumulative_input_tokens: inputTokens,
        cumulative_cached_input_tokens: 4,
        cumulative_output_tokens: outputTokens,
        cumulative_reasoning_output_tokens: 2,
      },
    },
  ]
    .map((event) => JSON.stringify(event))
    .join('\n')}\n`;
}

function persistedPipelineEntry(): AgentAuditEntry {
  return {
    id: `pipeline:exec-1/job1/step1/0:${STARTED_AT}`,
    eventType: 'pipeline_agent_turn',
    status: 'success',
    provider: 'codex',
    label: 'Pipeline',
    startedAt: STARTED_AT,
    completedAt: PERSISTED_STARTED_AT,
    durationMs: 46,
    tokens: {
      input: 18,
      output: 9,
      cacheReadInputTokens: 2,
      cacheCreationInputTokens: 0,
    },
    messageCount: 2,
    assistantMessageCount: 1,
    toolUseCount: 0,
    subAgentCount: 0,
    hasTranscript: true,
    toolCounts: ZERO_TOOL_COUNTS,
    projectId: 'proj',
    worktreeId: 'wt',
    pipelineId: 'pipeline-1',
    pipelineName: 'Pipeline',
    pipelineExecutionId: 'exec-1',
    jobId: 'job1',
    stepId: 'step1',
    attempt: 0,
  };
}

function completedPipelineState(): Parameters<
  ObservabilityService['syncPipelineExecutionState']
>[0] {
  return {
    id: 'exec-1',
    pipeline_id: 'pipeline-1',
    pipeline_snapshot: { name: 'Pipeline' },
    project_id: 'proj',
    worktree_id: 'wt',
    jobs: {
      job1: {
        status: 'success',
        outputs: {},
        steps: {
          step1: {
            status: 'success',
            outputs: {},
            dynamic_env: {},
            started_at: PERSISTED_STARTED_AT,
            completed_at: PERSISTED_STARTED_AT,
            log_format_hint: 'agent',
            agent_provider: 'codex',
            agent_model: 'gpt-5.3-codex',
          },
        },
      },
    },
  };
}

describe('pipeline output ingestion', () => {
  let services: ObservabilityService[];
  let persistedSnapshot = '';

  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(new Date('2026-10-13T04:00:00.000Z'));
    services = [];
    persistedSnapshot = '';
    mockReadPreferencesFile.mockResolvedValue({ auditRetentionDays: 30 });
    mockReadFile.mockImplementation(
      (path): Promise<string> =>
        Promise.resolve(
          path === '/audit/snapshot.json' ? persistedSnapshot : '',
        ),
    );
    mockReaddir.mockResolvedValue([]);
    mockAppendFile.mockResolvedValue(undefined);
    mockMkdir.mockResolvedValue(undefined);
    mockRename.mockResolvedValue(undefined);
    mockRm.mockResolvedValue(undefined);
    mockUnlink.mockResolvedValue(undefined);
    mockStat.mockResolvedValue({ size: 0 });
    mockWriteFile.mockResolvedValue(undefined);
    mockCheckClaudeAuthStatusObserved.mockResolvedValue({
      authenticated: false,
    });
    mockCodexRequest.mockResolvedValue({ account: null });
  });

  afterEach(async () => {
    await Promise.all(services.map((service) => service.dispose()));
    jest.useRealTimers();
  });

  it('reuses a persisted pipeline audit entry when a terminal snapshot replays after service restart', async () => {
    const previousEntry = persistedPipelineEntry();
    persistedSnapshot = JSON.stringify({
      version: 1,
      recentEntries: [previousEntry],
      usage: {},
    });

    const service = new ObservabilityService();
    services.push(service);
    await service.start();

    service.syncPipelineExecutionState(completedPipelineState());

    const matchingEntries = service
      .loadSnapshot()
      .recentEntries.filter(
        (entry) =>
          entry.pipelineExecutionId === 'exec-1' &&
          entry.jobId === 'job1' &&
          entry.stepId === 'step1' &&
          entry.attempt === 0,
      );

    expect(matchingEntries).toHaveLength(1);
    expect(matchingEntries[0]).toMatchObject({
      id: previousEntry.id,
      startedAt: STARTED_AT,
      completedAt: PERSISTED_STARTED_AT,
      status: 'success',
      hasTranscript: true,
      tokens: previousEntry.tokens,
    });
  });

  it('keeps the explicit step provider when a row recorded as Claude replays after restart', async () => {
    // Earlier versions recorded agent-hinted Copilot steps as Claude, and
    // shutdown stamped the interrupted row with the Claude account.
    const previousEntry = persistedPipelineEntry();
    persistedSnapshot = JSON.stringify({
      version: 1,
      recentEntries: [
        {
          ...previousEntry,
          status: 'interrupted',
          error: 'Application shutdown',
          provider: 'claude',
          providerAccountKey: 'claude:native@example.com',
          providerAccountEmail: 'native@example.com',
          providerPlanType: 'max',
        },
      ],
      usage: {},
    });

    const service = new ObservabilityService();
    services.push(service);
    await service.start();
    mockPeekProviderAccountIdentity.mockClear();

    service.syncPipelineExecutionState(
      pipelineState('exec-1', {
        job1: {
          status: 'running',
          outputs: {},
          steps: {
            step1: {
              ...agentStep('claude', PERSISTED_STARTED_AT),
              agent_provider: 'copilot',
              agent_harness: 'copilot',
              agent_model: 'copilot:fixture-model',
            },
          },
        },
      }),
    );

    const matchingEntries = service
      .loadSnapshot()
      .recentEntries.filter((entry) => entry.stepId === 'step1');
    expect(matchingEntries).toHaveLength(1);
    expect(matchingEntries[0]).toMatchObject({
      id: previousEntry.id,
      status: 'running',
      provider: 'copilot',
    });
    expect(matchingEntries[0]).not.toHaveProperty('providerAccountKey');
    expect(matchingEntries[0]).not.toHaveProperty('providerAccountEmail');
    expect(matchingEntries[0]).not.toHaveProperty('providerPlanType');
    expect(mockPeekProviderAccountIdentity).not.toHaveBeenCalled();
  });

  it('re-prices a resumed Codex step and keeps its recorded subagents', async () => {
    persistedSnapshot = JSON.stringify({
      version: 1,
      recentEntries: [
        {
          ...persistedPipelineEntry(),
          totalCostUsd: 0.5,
          observedCost: {
            status: 'priced',
            reason: 'priced',
            currency: 'usd',
            totalUsd: 0.5,
          },
          subagents: [
            {
              id: 'child-a',
              kind: 'codex_agent',
              tokens: {
                input: 10,
                output: 5,
                cacheReadInputTokens: 0,
                cacheCreationInputTokens: 0,
              },
              inclusion: 'additional',
            },
          ],
        },
      ],
      usage: {},
    });
    const service = new ObservabilityService();
    services.push(service);
    await service.start();

    service.syncPipelineExecutionState(
      pipelineState('exec-1', {
        job1: {
          status: 'running',
          outputs: {},
          steps: { step1: agentStep('codex', PERSISTED_STARTED_AT) },
        },
      }),
    );
    service.observePipelineOutput({
      executionId: 'exec-1',
      jobId: 'job1',
      stepId: 'step1',
      attempt: 0,
      data: `${codexStream('thread-resumed', 'turn-2', 30, 10)}${JSON.stringify(
        {
          type: 'thread.subagent_token_usage.updated',
          thread_id: 'child-a',
          turn_id: 'child-turn-2',
          total: { input_tokens: 15, output_tokens: 7 },
          last: { input_tokens: 5, output_tokens: 2 },
        },
      )}\n`,
    });
    service.syncPipelineExecutionState(completedPipelineState());

    const entry = service
      .loadSnapshot()
      .recentEntries.find(
        (candidate) => candidate.pipelineExecutionId === 'exec-1',
      );
    // The recorded $0.50 estimate predates the new usage; the step is priced
    // again from its accumulated tokens (no price list in this test).
    expect(entry?.observedCost?.totalUsd).toBeUndefined();
    const [child] = entry?.subagents ?? [];
    expect(entry?.subagents).toHaveLength(1);
    expect(child?.id).toBe('child-a');
    expect(child?.tokens).toMatchObject({ input: 15, output: 7 });
  });

  it('counts output chunks that arrive without a matching open audit entry', () => {
    const service = new ObservabilityService();
    services.push(service);
    const data = '{"type":"thread.token_usage.updated"}\n';

    service.observePipelineOutput({
      executionId: 'exec-untracked',
      jobId: 'job1',
      stepId: 'step1',
      attempt: 0,
      data,
    });

    expect(service.getPipelineOutputDiagnostics()).toMatchObject({
      droppedOutputChunks: 1,
      droppedOutputBytes: Buffer.byteLength(data),
    });
  });

  it('ingests Codex lifecycle and usage events separately from a Claude result across matrix variants', async () => {
    const service = new ObservabilityService();
    services.push(service);
    const codexJobId = '__matrix__review__0';
    const claudeJobId = '__matrix__review__1';
    service.syncPipelineExecutionState(
      pipelineState('exec-matrix', {
        [codexJobId]: {
          status: 'running',
          outputs: {},
          steps: { step1: agentStep('codex', STARTED_AT) },
        },
        [claudeJobId]: {
          status: 'running',
          outputs: {},
          steps: { step1: agentStep('claude', STARTED_AT) },
        },
      }),
    );

    service.observePipelineOutput({
      executionId: 'exec-matrix',
      jobId: codexJobId,
      stepId: 'step1',
      attempt: 0,
      data: codexStream('thread-matrix-0', 'turn-matrix-0', 80, 40),
    });
    service.observePipelineOutput({
      executionId: 'exec-matrix',
      jobId: claudeJobId,
      stepId: 'step1',
      attempt: 0,
      data: `${[
        JSON.stringify({
          type: 'system',
          subtype: 'init',
          session_id: 'claude-session-matrix-1',
        }),
        JSON.stringify({
          type: 'result',
          subtype: 'success',
          is_error: false,
          result: 'Claude step finished',
          session_id: 'claude-session-matrix-1',
          duration_ms: 25,
          total_cost_usd: 0.125,
          usage: {
            input_tokens: 17,
            output_tokens: 6,
            cache_read_input_tokens: 4,
            cache_creation_input_tokens: 2,
          },
        }),
      ].join('\n')}\n`,
    });

    await service.flush();

    const entries = service
      .loadSnapshot()
      .recentEntries.filter(
        (entry) => entry.pipelineExecutionId === 'exec-matrix',
      );
    const codexEntry = entries.find((entry) => entry.jobId === codexJobId);
    const claudeEntry = entries.find((entry) => entry.jobId === claudeJobId);

    expect(entries).toHaveLength(2);
    expect(codexEntry).toMatchObject({
      provider: 'codex',
      sdkSessionId: 'thread-matrix-0',
      tokens: {
        input: 80,
        output: 40,
        cacheReadInputTokens: 4,
        reasoningOutputTokens: 2,
      },
    });
    expect(claudeEntry).toMatchObject({
      provider: 'claude',
      sdkSessionId: 'claude-session-matrix-1',
      tokens: {
        input: 17,
        output: 6,
        cacheReadInputTokens: 4,
        cacheCreationInputTokens: 2,
      },
    });
  });

  it('prices each agent-loop iteration from zero because each is a fresh query', async () => {
    const service = new ObservabilityService();
    services.push(service);
    service.syncPipelineExecutionState(
      pipelineState('exec-agent-loop', {
        job1: {
          status: 'running',
          outputs: {},
          steps: { step1: agentStep('claude', STARTED_AT) },
        },
      }),
    );
    const iterationResult = (
      iteration: number,
      sessionId: string,
      totalCostUsd: number,
    ): string =>
      JSON.stringify({
        type: 'agent_loop_event',
        iteration,
        event: {
          type: 'result',
          subtype: 'success',
          is_error: false,
          result: `iteration ${String(iteration)}`,
          session_id: sessionId,
          total_cost_usd: totalCostUsd,
          usage: { input_tokens: 10, output_tokens: 5 },
        },
      });

    service.observePipelineOutput({
      executionId: 'exec-agent-loop',
      jobId: 'job1',
      stepId: 'step1',
      attempt: 0,
      data: `${iterationResult(1, 'loop-session-1', 1)}\n${iterationResult(2, 'loop-session-2', 1.2)}\n`,
    });
    await service.flush();

    const entry = service
      .loadSnapshot()
      .recentEntries.find(
        (candidate) => candidate.pipelineExecutionId === 'exec-agent-loop',
      );
    expect(entry?.totalCostUsd).toBeCloseTo(2.2, 6);
    expect(entry?.costDerivation).toBe('exact');
  });

  it('keeps output and usage isolated between iterations of the same pipeline step', async () => {
    const service = new ObservabilityService();
    services.push(service);
    service.syncPipelineExecutionState(
      pipelineState('exec-iteration', {
        job1: {
          status: 'running',
          outputs: {},
          steps: { step1: agentStep('codex', STARTED_AT) },
        },
      }),
    );
    service.observePipelineOutput({
      executionId: 'exec-iteration',
      jobId: 'job1',
      stepId: 'step1',
      attempt: 0,
      data: codexStream('thread-iteration-1', 'turn-iteration-1', 30, 10),
    });

    service.syncPipelineExecutionState(
      pipelineState('exec-iteration', {
        job1: {
          status: 'running',
          outputs: {},
          retry_count: 0,
          iteration_count: 2,
          iteration_history: [
            {
              iteration: 1,
              status: 'success',
              steps: {
                step1: agentStep(
                  'codex',
                  STARTED_AT,
                  'success',
                  PERSISTED_STARTED_AT,
                ),
              },
            },
          ],
          steps: {
            step1: agentStep('codex', ITERATION_TWO_STARTED_AT),
          },
        },
      }),
    );
    service.observePipelineOutput({
      executionId: 'exec-iteration',
      jobId: 'job1',
      stepId: 'step1',
      attempt: 0,
      iteration: 2,
      data: codexStream('thread-iteration-2', 'turn-iteration-2', 55, 22),
    });

    await service.flush();

    const entries = service
      .loadSnapshot()
      .recentEntries.filter(
        (entry) => entry.pipelineExecutionId === 'exec-iteration',
      );
    const firstIteration = entries.find((entry) => !entry.id.includes('/i2:'));
    const secondIteration = entries.find((entry) => entry.id.includes('/i2:'));

    expect(entries).toHaveLength(2);
    expect(firstIteration?.id).toContain('/job1/step1/0:');
    expect(secondIteration?.id).toContain('/job1/step1/0/i2:');
    expect(firstIteration).toMatchObject({
      status: 'success',
      tokens: { input: 30, output: 10 },
    });
    expect(secondIteration).toMatchObject({
      status: 'running',
      sdkSessionId: 'thread-iteration-2',
      tokens: { input: 55, output: 22 },
    });
  });
});
