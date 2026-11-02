import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { BRAND } from '@canopy/brand/current';
import type { AgentModelDefinition } from '@canopy/desktop-shared/types/agent-models';
import type {
  ExecutionState,
  ExecutionSummary,
} from '@canopy/desktop-shared/types/pipeline';
import type {
  AutomationRunHistoryRequest,
  AutomationRunHistoryResponse,
  ChatTabPluginSelections,
  HookRunSnapshot,
  HookSourceInfoRequest,
  HookSourceInfoResponse,
  PersistedChatBlock,
  PersistedChatMessage,
  PersistedChatTab,
  ScheduledActivity,
  ScheduledActivityRun,
} from '@canopy/desktop-shared/types';
import type { TranscriptDescriptor } from '@canopy/agent-transcript/transcript-storage';
import {
  collectSharedContainerCapabilityUsage,
  readSharedContainerAgentModel,
  readSharedContainerUserPipeline,
  type CollectSharedContainerCapabilityUsageInput,
  type SharedContainerCapabilityReference,
  type SharedContainerCapabilityUsageDependencies,
} from '../shared-containers/publish/capability-usage';
import {
  getWorktreeShareCapabilityUsageCachePath,
  getWorktreeSharePublicationStatePath,
} from '../lib/paths';

const mockGetAgentModel = jest.fn<
  Promise<AgentModelDefinition | null>,
  [string, string | undefined]
>();
jest.mock('../agents/agent-model-store', () => ({
  getAgentModel: (
    id: string,
    projectId?: string,
  ): Promise<AgentModelDefinition | null> => mockGetAgentModel(id, projectId),
}));

jest.mock('../lib/main-process-logging', () => ({
  logMainProcessWarn: jest.fn(),
  logMainProcessError: jest.fn(),
  logMainProcessInfo: jest.fn(),
}));

const PROJECT = 'project-1';
const WORKTREE = 'worktree-1';

function descriptor(
  revision: number,
  digest: string,
  overrides: Partial<TranscriptDescriptor> = {},
): TranscriptDescriptor {
  return {
    format: 'complete-message-jsonl-v1',
    committedMessageCount: 3,
    committedByteLength: 300,
    transcriptRevision: revision,
    hasActiveSidecar: false,
    committedDigest: digest,
    ...overrides,
  };
}

function tab(
  id: string,
  overrides: Partial<PersistedChatTab> = {},
): PersistedChatTab {
  return {
    id,
    title: id,
    messages: [],
    createdAt: '2026-10-01T00:00:00.000Z',
    transcript: descriptor(1, `digest-${id}`),
    ...overrides,
  };
}

let messageCounter = 0;
function message(
  role: PersistedChatMessage['role'],
  blocks: PersistedChatBlock[],
  overrides: Partial<PersistedChatMessage> = {},
): PersistedChatMessage {
  messageCounter += 1;
  return {
    id: `m-${String(messageCounter)}`,
    role,
    blocks,
    timestamp: messageCounter,
    ...overrides,
  };
}

function userText(text: string): PersistedChatMessage {
  return message('user', [{ type: 'text', text }]);
}

function toolUse(toolName: string, input: unknown): PersistedChatMessage {
  return message('assistant', [
    {
      type: 'tool_use',
      toolUseId: `tool-${String(messageCounter)}`,
      toolName,
      input: JSON.stringify(input),
    },
  ]);
}

function delegationCard(
  agentBlockId: string,
  overrides: Record<string, unknown> = {},
  messageOverrides: Partial<PersistedChatMessage> = {},
): PersistedChatMessage {
  const block = {
    type: 'delegated_agent_call',
    agentBlockId,
    delegationId: `delegation-${agentBlockId}`,
    status: 'completed',
    outputTruncated: false,
    runGeneration: 1,
    sequence: 1,
    parentHarnessId: 'claude',
    parentTurnId: 'turn',
    parentToolCallId: 'call',
    createdAt: 1,
    selectedModelId: 'claude-sonnet',
    runtimeModelId: 'claude-sonnet',
    targetHarnessId: 'claude',
    description: 'child',
    prompt: 'child',
    executionMode: 'foreground',
    ...overrides,
  } as unknown as PersistedChatBlock;
  return message('assistant', [block], messageOverrides);
}

function agent(id: string, contentHash = `hash-${id}`): AgentModelDefinition {
  return {
    id,
    name: id,
    baseModel: 'claude-sonnet',
    instructions: 'Be helpful.',
    pluginSelections: { collectionIds: [], skillRefs: [], pluginRefs: [] },
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    contentHash,
  };
}

function activity(
  id: string,
  action: ScheduledActivity['action'],
  updatedAt = '2026-10-01T00:00:00.000Z',
): ScheduledActivity {
  return {
    version: 1,
    id,
    name: id,
    enabled: true,
    schedule: { kind: 'cron', expression: '0 * * * *', timezone: 'local' },
    action,
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt,
    failureCount: 0,
  };
}

function run(
  activityId: string,
  target: ScheduledActivityRun['target'],
): ScheduledActivityRun {
  return {
    id: `run-${activityId}`,
    activityId,
    activityName: activityId,
    scheduledFor: '2026-10-01T00:00:00.000Z',
    manual: false,
    status: 'success',
    startedAt: '2026-10-01T00:00:00.000Z',
    target,
  };
}

function summary(
  id: string,
  pipelineId: string,
  overrides: Partial<ExecutionSummary> = {},
): ExecutionSummary {
  return {
    id,
    pipeline_id: pipelineId,
    pipeline_name: pipelineId,
    status: 'success',
    status_reasons: [],
    started_at: `2026-10-0${id.slice(-1)}T00:00:00.000Z`,
    cwd: '/tmp',
    project_id: PROJECT,
    worktree_id: WORKTREE,
    ...overrides,
  };
}

function executionState(
  id: string,
  pipelineId: string,
  overrides: Record<string, unknown> = {},
): ExecutionState {
  return {
    version: 10,
    id,
    pipeline_id: pipelineId,
    pipeline_snapshot: { name: pipelineId, jobs: { build: { steps: [] } } },
    status: 'success',
    jobs: {},
    job_definitions: {},
    job_groups: {},
    started_at: '2026-10-01T00:00:00.000Z',
    ...overrides,
  } as unknown as ExecutionState;
}

function hookRun(
  hook: Partial<HookRunSnapshot['hook']> & { hookKey: string },
): HookRunSnapshot {
  return {
    projectId: PROJECT,
    worktreeId: WORKTREE,
    hook: {
      triggerName: 'pr:create',
      label: 'PR created',
      actions: [],
      target: 'project',
      ...hook,
    },
    status: 'success',
    outputLines: [],
    exitCode: 0,
    timedOut: false,
    durationMs: 1,
    startedAt: '2026-10-01T00:00:00.000Z',
  };
}

interface Fixture {
  tabs: PersistedChatTab[];
  transcripts: Map<string, PersistedChatMessage[]>;
  selections: Map<string, ChatTabPluginSelections | undefined>;
  agents: Map<string, AgentModelDefinition>;
  summaries: ExecutionSummary[];
  states: Map<string, ExecutionState>;
  userPipelines: Map<string, string>;
  pipelineFiles: Map<string, string>;
  activities: ScheduledActivity[];
  runs: Map<string, ScheduledActivityRun[]>;
  hookRuns: HookRunSnapshot[];
  hookSources: Map<string, HookSourceInfoResponse>;
  builtinSkills: string[];
  transcriptReads: string[];
  hookSourceRequests: HookSourceInfoRequest[];
  cachePath: string;
}

let dataDir = '';
let fixture: Fixture;

function newFixture(): Fixture {
  return {
    tabs: [],
    transcripts: new Map(),
    selections: new Map(),
    agents: new Map(),
    summaries: [],
    states: new Map(),
    userPipelines: new Map(),
    pipelineFiles: new Map(),
    activities: [],
    runs: new Map(),
    hookRuns: [],
    hookSources: new Map(),
    builtinSkills: [],
    transcriptReads: [],
    hookSourceRequests: [],
    cachePath: getWorktreeShareCapabilityUsageCachePath(PROJECT, WORKTREE),
  };
}

function deps(
  f: Fixture = fixture,
  overrides: Partial<SharedContainerCapabilityUsageDependencies> = {},
): SharedContainerCapabilityUsageDependencies {
  return {
    readChatTabs: () =>
      Promise.resolve({
        version: 1,
        tabs: f.tabs,
        activeTabId: f.tabs[0]?.id ?? '',
      }),
    consumeTranscript: <T>(
      _scope: { projectId: string; worktreeId: string },
      chatId: string,
      consume: (messages: AsyncIterable<PersistedChatMessage>) => Promise<T>,
    ): Promise<T> => {
      f.transcriptReads.push(chatId);
      const rows = f.transcripts.get(chatId) ?? [];
      return consume(
        (async function* (): AsyncGenerator<PersistedChatMessage> {
          for (const row of rows) yield await Promise.resolve(row);
        })(),
      );
    },
    resolveBackgroundSelections: (local, target) =>
      Promise.resolve(
        f.selections.has(target.chatId)
          ? f.selections.get(target.chatId)
          : local,
      ),
    getAgentModel: (agentId) => Promise.resolve(f.agents.get(agentId) ?? null),
    listExecutionSummaries: () => Promise.resolve(f.summaries),
    loadExecutionState: (executionId) =>
      Promise.resolve(f.states.get(executionId) ?? null),
    readUserPipeline: (pipelineId) =>
      Promise.resolve(f.userPipelines.get(pipelineId) ?? null),
    readPipelineFile: (filePath) =>
      Promise.resolve(f.pipelineFiles.get(filePath) ?? null),
    listAutomations: () => Promise.resolve(f.activities),
    listAutomationRuns: (
      request: AutomationRunHistoryRequest,
    ): Promise<AutomationRunHistoryResponse> => {
      const runs = f.runs.get(request.activityId) ?? [];
      return Promise.resolve({
        runs,
        nextCursor: null,
        totalCount: runs.length,
      });
    },
    loadHookRuns: () => Promise.resolve(f.hookRuns),
    getHookSourceInfo: (request): Promise<HookSourceInfoResponse> => {
      f.hookSourceRequests.push(request);
      const info = f.hookSources.get(request.triggerName);
      return info
        ? Promise.resolve(info)
        : Promise.reject(new Error('no hook'));
    },
    listBuiltinSkillNames: () => Promise.resolve(f.builtinSkills),
    resolveCoworkProjectId: (projectId) => projectId,
    ...overrides,
  };
}

function input(
  overrides: Partial<CollectSharedContainerCapabilityUsageInput> = {},
): CollectSharedContainerCapabilityUsageInput {
  return {
    projectId: PROJECT,
    worktreeId: WORKTREE,
    containerType: 'CODE_WORKTREE',
    includedChatIds: fixture.tabs.map((entry) => entry.id),
    ...overrides,
  };
}

function find(
  references: readonly SharedContainerCapabilityReference[],
  kind: SharedContainerCapabilityReference['kind'],
): SharedContainerCapabilityReference[] {
  return references.filter((reference) => reference.kind === kind);
}

const originalDataDir = process.env.CANOPY_DATA_DIR;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'shared-container-usage-'));
  process.env.CANOPY_DATA_DIR = dataDir;
  fixture = newFixture();
  messageCounter = 0;
});

afterEach(async () => {
  if (originalDataDir === undefined) delete process.env.CANOPY_DATA_DIR;
  else process.env.CANOPY_DATA_DIR = originalDataDir;
  await rm(dataDir, { recursive: true, force: true });
});

describe('collectSharedContainerCapabilityUsage sources', () => {
  it('recognizes leading invocations, Skill calls, subagents and MCP tools in transcripts', async () => {
    fixture.tabs = [tab('chat-a')];
    fixture.transcripts.set('chat-a', [
      userText('/Review please look at this'),
      userText('$deploy now'),
      toolUse('Skill', { skill: 'frontend:design' }),
      toolUse('Task', { subagent_type: 'reviewer-kit:security' }),
      toolUse('Task', { subagent_type: 'general-purpose' }),
      toolUse('mcp__claude_ai_Slack__send_message', { text: 'hi' }),
      toolUse('Bash', { command: 'ls' }),
    ]);

    const usage = await collectSharedContainerCapabilityUsage(input(), deps());

    const invocations = find(usage.references, 'invocation').map((reference) =>
      reference.kind === 'invocation'
        ? [reference.provider, reference.token, reference.via.join(',')]
        : [],
    );
    expect(invocations).toEqual(
      expect.arrayContaining([
        ['claude', 'review', 'leading'],
        ['codex', 'deploy', 'leading'],
        ['claude', 'frontend:design', 'skill_tool'],
        ['claude', 'reviewer-kit:security', 'subagent'],
      ]),
    );
    expect(invocations).toHaveLength(4);
    expect(find(usage.references, 'mcp_server')).toEqual([
      expect.objectContaining({
        identity: { kind: 'tool_namespace', namespace: 'claude_ai_Slack' },
        provenance: ['transcript'],
        priority: 'observed',
      }),
    ]);
    expect(usage.sourceVersion).toMatch(/^scu:v1:[0-9a-f]{64}$/);
  });

  it('reads MCP activations from tab metadata and transcript blocks, identity only', async () => {
    const activation = {
      version: 1,
      ownerId: 'owner',
      activationId: 'activation',
      attemptId: 'attempt',
      originatingMessageId: 'origin',
      providerSessionId: 'session',
      provider: 'claude',
      trigger: 'load',
      requiredTargets: [
        { kind: 'standalone', serverId: 'linear', configId: 'cfg-1' },
      ],
      desiredGeneration: 1,
      phase: 'completed',
      retryEligible: false,
      cancelled: false,
      admission: 'accepted',
    };
    const historical = {
      ...activation,
      activationId: 'activation-2',
      requiredTargets: [
        {
          kind: 'plugin',
          marketplaceId: 'market',
          pluginName: 'kit',
          serverName: 'kit-mcp',
        },
      ],
    };
    fixture.tabs = [
      tab('chat-a', {
        mcpActivation: activation as PersistedChatTab['mcpActivation'],
      }),
    ];
    fixture.transcripts.set('chat-a', [
      message('system', [{ type: 'mcp_activation', record: historical }]),
    ]);

    const usage = await collectSharedContainerCapabilityUsage(input(), deps());

    const servers = find(usage.references, 'mcp_server');
    expect(servers).toHaveLength(2);
    for (const server of servers)
      expect(server.provenance).toEqual(['mcp_activation']);
    expect(JSON.stringify(usage)).not.toContain('session');
  });

  it('uses Codex and Cursor effective selections as lower-priority fallback', async () => {
    fixture.tabs = [
      tab('codex-chat', { providerType: 'codex' }),
      tab('cursor-chat', { providerType: 'cursor' }),
      tab('claude-chat', { providerType: 'claude' }),
    ];
    fixture.selections.set('codex-chat', {
      collectionIds: [],
      skillRefs: [
        { sourceId: 'custom:app', skillName: 'triage' },
        { sourceId: 'builtin:app', skillName: 'canopy-pipeline-writing' },
      ],
      pluginRefs: [{ marketplaceId: 'market', pluginName: 'kit' }],
    });
    fixture.selections.set('cursor-chat', {
      collectionIds: [],
      skillRefs: [{ sourceId: 'custom:app', skillName: 'ignored-for-cursor' }],
      pluginRefs: [],
      mcpServerRefs: [{ serverId: 'linear', configId: 'cfg' }],
    });
    fixture.selections.set('claude-chat', {
      collectionIds: [],
      skillRefs: [{ sourceId: 'custom:app', skillName: 'claude-only' }],
      pluginRefs: [],
    });
    fixture.transcripts.set('codex-chat', [userText('$kit-skill go')]);

    const usage = await collectSharedContainerCapabilityUsage(input(), deps());

    expect(find(usage.references, 'skill')).toEqual([
      expect.objectContaining({
        sourceId: 'custom:app',
        skillName: 'triage',
        provenance: ['selection_fallback'],
        priority: 'fallback',
      }),
    ]);
    expect(find(usage.references, 'plugin')).toEqual([
      expect.objectContaining({ pluginName: 'kit', priority: 'fallback' }),
    ]);
    expect(find(usage.references, 'mcp_server')).toEqual([
      expect.objectContaining({
        identity: { kind: 'standalone', serverId: 'linear', configId: 'cfg' },
        priority: 'fallback',
      }),
    ]);
    expect(usage.diagnostics.excludedBuiltin).toBe(1);
  });

  it('lets observed usage outrank the same reference seen as fallback', async () => {
    const identity = {
      kind: 'standalone',
      serverId: 'linear',
      configId: 'cfg',
    };
    fixture.tabs = [
      tab('cursor-chat', {
        providerType: 'cursor',
        mcpActivation: {
          version: 1,
          ownerId: 'owner',
          activationId: 'activation',
          attemptId: 'attempt',
          originatingMessageId: 'origin',
          providerSessionId: 'session',
          provider: 'claude',
          trigger: 'load',
          requiredTargets: [identity],
          desiredGeneration: 1,
          phase: 'completed',
          retryEligible: false,
          cancelled: false,
          admission: 'accepted',
        } as PersistedChatTab['mcpActivation'],
      }),
    ];
    fixture.selections.set('cursor-chat', {
      collectionIds: [],
      skillRefs: [],
      pluginRefs: [],
      mcpServerRefs: [{ serverId: 'linear', configId: 'cfg' }],
    });

    const usage = await collectSharedContainerCapabilityUsage(input(), deps());

    expect(find(usage.references, 'mcp_server')).toEqual([
      expect.objectContaining({
        provenance: ['mcp_activation', 'selection_fallback'],
        priority: 'observed',
      }),
    ]);
  });

  it('finds Canopy Agents from chat routes and delegation cards', async () => {
    fixture.tabs = [
      tab('chat-a', { model: 'agent_model_reviewer@claude-sonnet' }),
      tab('chat-b', { model: 'agent_model_writer' }),
    ];
    fixture.transcripts.set('chat-a', [
      delegationCard('card-1', {
        selectedModelId: 'agent_model_helper@gpt-6',
      }),
    ]);
    fixture.agents.set('agent_model_reviewer', agent('agent_model_reviewer'));
    fixture.agents.set('agent_model_writer', agent('agent_model_writer'));
    fixture.agents.set('agent_model_helper', agent('agent_model_helper'));

    const usage = await collectSharedContainerCapabilityUsage(input(), deps());

    expect(
      find(usage.references, 'agent').map((reference) =>
        reference.kind === 'agent'
          ? [reference.agentId, reference.provenance.join(',')]
          : [],
      ),
    ).toEqual([
      ['agent_model_helper', 'transcript'],
      ['agent_model_reviewer', 'agent_route'],
      ['agent_model_writer', 'agent_route'],
    ]);
  });

  it('reports a deleted Agent only in diagnostics', async () => {
    fixture.tabs = [tab('chat-a', { model: 'agent_model_gone@claude' })];

    const usage = await collectSharedContainerCapabilityUsage(input(), deps());

    expect(find(usage.references, 'agent')).toEqual([]);
    expect(usage.diagnostics.agentsUnavailable).toBe(1);
  });

  it('reads pipeline runs for this worktree only and uses historical snapshots when the source is gone', async () => {
    fixture.summaries = [
      summary('exec-1', 'present'),
      summary('exec-2', 'deleted'),
      summary('exec-3', 'other-worktree', { worktree_id: 'other' }),
      summary('exec-4', 'child', { parent_execution_id: 'exec-1' }),
      summary('exec-5', 'bundled'),
      summary('exec-6', 'present'),
    ];
    fixture.states.set(
      'exec-6',
      executionState('exec-6', 'present', {
        pipeline_preference_locator: {
          type: 'stored',
          source: 'user',
          value: 'present',
        },
      }),
    );
    fixture.states.set(
      'exec-2',
      executionState('exec-2', 'deleted', {
        pipeline_preference_locator: {
          type: 'stored',
          source: 'user',
          value: 'deleted',
        },
      }),
    );
    fixture.states.set(
      'exec-5',
      executionState('exec-5', 'bundled', {
        pipeline_preference_locator: {
          type: 'stored',
          source: 'bundled',
          value: 'bundled',
        },
      }),
    );
    fixture.userPipelines.set('present', 'name: present\n');
    const loadExecutionState = jest.fn((executionId: string) =>
      Promise.resolve(fixture.states.get(executionId) ?? null),
    );

    const usage = await collectSharedContainerCapabilityUsage(
      input(),
      deps(fixture, { loadExecutionState }),
    );

    expect(loadExecutionState.mock.calls.map(([id]) => id).sort()).toEqual([
      'exec-2',
      'exec-5',
      'exec-6',
    ]);
    const pipelines = find(usage.references, 'pipeline');
    expect(pipelines).toHaveLength(2);
    const present = pipelines.find(
      (reference) =>
        reference.kind === 'pipeline' && reference.pipelineId === 'present',
    );
    expect(present).toMatchObject({
      sourceKind: 'user',
      provenance: ['pipeline_execution'],
    });
    expect(present).not.toHaveProperty('historical');
    const deleted = pipelines.find(
      (reference) =>
        reference.kind === 'pipeline' && reference.pipelineId === 'deleted',
    );
    expect(deleted).toMatchObject({
      sourceKind: 'user',
      historical: true,
      historicalSnapshot: {
        format: 'normalized_pipeline_yaml',
        executionId: 'exec-2',
      },
    });
    expect(
      deleted?.kind === 'pipeline' ? deleted.historicalSnapshot?.yaml : '',
    ).toContain('name: deleted');
    expect(usage.diagnostics).toMatchObject({
      pipelineChildExecutionsSkipped: 1,
      pipelinesHistorical: 1,
      excludedBuiltin: 1,
    });
  });

  it('includes automations targeting the worktree and retargeted ones that ran into it', async () => {
    fixture.tabs = [tab('chat-a')];
    fixture.activities = [
      activity('current', {
        type: 'worktree_session_prompt',
        workspaceId: PROJECT,
        worktreeId: WORKTREE,
        chatId: 'chat-a',
        prompt: 'daily',
      }),
      activity('retargeted', {
        type: 'worktree_session_prompt',
        workspaceId: PROJECT,
        worktreeId: 'elsewhere',
        chatId: 'chat-z',
        prompt: 'weekly',
      }),
      activity('unrelated', {
        type: 'worktree_session_prompt',
        workspaceId: PROJECT,
        worktreeId: 'elsewhere',
        chatId: 'chat-z',
        prompt: 'never here',
      }),
      activity('resume', {
        type: 'worktree_session_prompt',
        workspaceId: PROJECT,
        worktreeId: WORKTREE,
        chatId: 'chat-a',
        prompt: 'continue',
        purpose: 'usage_limit_resume',
      }),
    ];
    fixture.runs.set('retargeted', [
      run('retargeted', { workspaceId: PROJECT, worktreeId: WORKTREE }),
    ]);
    fixture.runs.set('unrelated', [
      run('unrelated', { workspaceId: PROJECT, worktreeId: 'elsewhere' }),
    ]);

    const usage = await collectSharedContainerCapabilityUsage(input(), deps());

    expect(
      find(usage.references, 'automation').map((reference) =>
        reference.kind === 'automation' ? reference.automationId : '',
      ),
    ).toEqual(['current', 'retargeted']);
    expect(usage.diagnostics.automationSystemSkipped).toBe(1);
  });

  it('includes pipeline automations whose task or base is the worktree', async () => {
    fixture.activities = [
      activity('task', {
        type: 'worktree_pipeline',
        target: { kind: 'task', taskId: WORKTREE },
        workspaceId: PROJECT,
        pipelineId: 'pipeline-a',
      }),
      activity('base', {
        type: 'worktree_pipeline',
        workspaceId: PROJECT,
        baseWorktreeId: WORKTREE,
        pipelineId: 'pipeline-a',
      }),
      activity('global', {
        type: 'worktree_pipeline',
        target: { kind: 'global' },
        workspaceId: PROJECT,
        baseWorktreeId: WORKTREE,
        pipelineId: 'pipeline-a',
      }),
    ];

    const usage = await collectSharedContainerCapabilityUsage(input(), deps());

    expect(
      find(usage.references, 'automation').map((reference) =>
        reference.kind === 'automation' ? reference.automationId : '',
      ),
    ).toEqual(['base', 'task']);
  });

  it('includes workspace-owned hooks that fired and excludes canopy.json hooks', async () => {
    fixture.hookRuns = [
      hookRun({ hookKey: 'project:pr:create', triggerName: 'pr:create' }),
      hookRun({
        hookKey: 'project:worktree:setup',
        triggerName: 'worktree:setup',
      }),
    ];
    fixture.hookSources.set('pr:create', {
      triggerName: 'pr:create',
      triggerDisplayName: 'PR created',
      effectiveActions: [{ type: 'command', command: 'echo hi' }],
      layers: [
        {
          sourceKey: 'local-override',
          sourceLabel: 'Local',
          actions: [{ type: 'command', command: 'echo hi' }],
          status: 'active',
        },
      ],
    } as unknown as HookSourceInfoResponse);
    fixture.hookSources.set('worktree:setup', {
      triggerName: 'worktree:setup',
      triggerDisplayName: 'Setup',
      effectiveActions: [{ type: 'command', command: 'pnpm i' }],
      layers: [
        {
          sourceKey: 'repo-canopy',
          sourceLabel: 'canopy.json',
          actions: [{ type: 'command', command: 'pnpm i' }],
          status: 'active',
        },
      ],
    } as unknown as HookSourceInfoResponse);

    const usage = await collectSharedContainerCapabilityUsage(input(), deps());

    expect(find(usage.references, 'hook')).toEqual([
      expect.objectContaining({
        hookKey: 'project:pr:create',
        scope: 'project',
        triggerName: 'pr:create',
        provenance: ['hook_run'],
      }),
    ]);
    expect(usage.diagnostics.excludedCarriedHooks).toBe(1);
  });

  it('never reads hooks for Cowork containers', async () => {
    fixture.hookRuns = [hookRun({ hookKey: 'project:pr:create' })];
    const loadHookRuns = jest.fn(() => Promise.resolve(fixture.hookRuns));

    const usage = await collectSharedContainerCapabilityUsage(
      input({ containerType: 'COWORK_WORK_ENTRY' }),
      deps(fixture, { loadHookRuns }),
    );

    expect(loadHookRuns).not.toHaveBeenCalled();
    expect(find(usage.references, 'hook')).toEqual([]);
  });
});

describe('collectSharedContainerCapabilityUsage scope and exclusions', () => {
  it('reads only included chats', async () => {
    fixture.tabs = [tab('included'), tab('excluded')];
    fixture.transcripts.set('included', [userText('/kept')]);
    fixture.transcripts.set('excluded', [userText('/private-thing')]);

    const usage = await collectSharedContainerCapabilityUsage(
      input({ includedChatIds: ['included', 'included', 'missing'] }),
      deps(),
    );

    expect(fixture.transcriptReads).toEqual(['included']);
    expect(JSON.stringify(usage.references)).not.toContain('private-thing');
    expect(usage.diagnostics).toMatchObject({
      chatsRequested: 2,
      duplicateChatIds: 1,
      chatsMissing: 1,
    });
  });

  it('guards delegation cycles and duplicate visits', async () => {
    fixture.tabs = [tab('chat-a')];
    const repeated = userText('/repeat');
    fixture.transcripts.set('chat-a', [
      delegationCard('card-a', { selectedModelId: 'agent_model_one@x' }),
      delegationCard(
        'card-b',
        { selectedModelId: 'agent_model_two@x' },
        { parentBlockId: 'card-a' },
      ),
      // card-a reappears as its own grandchild.
      delegationCard(
        'card-a',
        { selectedModelId: 'agent_model_three@x' },
        { parentBlockId: 'card-b' },
      ),
      // card-c claims to be its own parent.
      delegationCard(
        'card-c',
        { selectedModelId: 'agent_model_four@x' },
        { parentBlockId: 'card-c' },
      ),
      message('assistant', [{ type: 'text', text: 'child of cycle' }], {
        parentBlockId: 'card-c',
      }),
      repeated,
      repeated,
    ]);
    for (const id of [
      'agent_model_one',
      'agent_model_two',
      'agent_model_three',
      'agent_model_four',
    ])
      fixture.agents.set(id, agent(id));

    const usage = await collectSharedContainerCapabilityUsage(input(), deps());

    expect(
      find(usage.references, 'agent').map((reference) =>
        reference.kind === 'agent' ? reference.agentId : '',
      ),
    ).toEqual(['agent_model_one', 'agent_model_two']);
    expect(usage.diagnostics.delegationCyclesSkipped).toBe(2);
    expect(usage.diagnostics.duplicateVisitsSkipped).toBe(1);
    expect(find(usage.references, 'invocation')).toHaveLength(1);
  });

  it('excludes built-in skills and the Canopy MCP namespace', async () => {
    fixture.builtinSkills = ['canopy-pipeline-writing'];
    fixture.tabs = [tab('chat-a')];
    fixture.transcripts.set('chat-a', [
      toolUse('Skill', { skill: 'canopy-pipeline-writing' }),
      toolUse(`mcp__${BRAND.tools.namespace}__SearchActions`, {}),
      toolUse(`mcp__${BRAND.tools.namespace}_ui__AskUserQuestion`, {}),
      toolUse('mcp__canopy_app_advisor__ShowFiles', {}),
      toolUse('mcp__github__create_issue', {}),
    ]);

    const usage = await collectSharedContainerCapabilityUsage(input(), deps());

    expect(find(usage.references, 'invocation')).toEqual([]);
    expect(find(usage.references, 'mcp_server')).toEqual([
      expect.objectContaining({
        identity: { kind: 'tool_namespace', namespace: 'github' },
      }),
    ]);
    expect(usage.diagnostics.excludedBuiltin).toBe(1);
    expect(usage.diagnostics.excludedCanopyMcp).toBe(3);
  });

  it('excludes repo-local skills and pipelines only when the snapshot carries the file', async () => {
    const repoPath = join(dataDir, 'checkout');
    fixture.tabs = [tab('chat-a')];
    fixture.transcripts.set('chat-a', [
      userText('/carried'),
      userText('/withheld'),
      userText('/tools:lint'),
      userText('$codex-local'),
    ]);
    fixture.summaries = [
      summary('exec-1', 'repo-carried'),
      summary('exec-2', 'repo-withheld'),
    ];
    fixture.states.set(
      'exec-1',
      executionState('exec-1', 'repo-carried', {
        pipeline_preference_locator: {
          type: 'file',
          value: join(repoPath, '.canopy', 'pipelines', 'carried.yaml'),
        },
      }),
    );
    const withheldPipeline = join(
      repoPath,
      '.canopy',
      'pipelines',
      'withheld.yaml',
    );
    fixture.states.set(
      'exec-2',
      executionState('exec-2', 'repo-withheld', {
        pipeline_preference_locator: { type: 'file', value: withheldPipeline },
      }),
    );
    fixture.pipelineFiles.set(withheldPipeline, 'name: withheld\n');

    const usage = await collectSharedContainerCapabilityUsage(
      input({
        snapshotPaths: {
          repositories: [
            {
              repoId: 'repo',
              repoPath,
              paths: [
                '.claude/skills/carried/SKILL.md',
                '.claude/commands/tools/lint.md',
                '.agents/skills/codex-local/SKILL.md',
                '.canopy/pipelines/carried.yaml',
                'src/index.ts',
              ],
            },
          ],
        },
      }),
      deps(),
    );

    expect(
      find(usage.references, 'invocation').map((reference) =>
        reference.kind === 'invocation' ? reference.token : '',
      ),
    ).toEqual(['withheld']);
    expect(find(usage.references, 'pipeline')).toEqual([
      expect.objectContaining({
        pipelineId: 'repo-withheld',
        sourceKind: 'file',
        filePath: withheldPipeline,
      }),
    ]);
    expect(usage.diagnostics.excludedRepoLocal).toBe(4);
  });

  it('does not exclude repo-local files for Cowork, which has no snapshot', async () => {
    fixture.tabs = [tab('chat-a')];
    fixture.transcripts.set('chat-a', [userText('/carried')]);

    const usage = await collectSharedContainerCapabilityUsage(
      input({
        containerType: 'COWORK_WORK_ENTRY',
        snapshotPaths: {
          repositories: [
            {
              repoId: 'repo',
              repoPath: '/repo',
              paths: ['.claude/skills/carried/SKILL.md'],
            },
          ],
        },
      }),
      deps(),
    );

    expect(find(usage.references, 'invocation')).toHaveLength(1);
  });
});

describe('collectSharedContainerCapabilityUsage cache', () => {
  async function readCacheFile(): Promise<{
    chats: Record<string, unknown>;
  }> {
    const parsed: unknown = JSON.parse(
      await readFile(fixture.cachePath, 'utf8'),
    );
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      !('chats' in parsed) ||
      typeof parsed.chats !== 'object' ||
      parsed.chats === null
    )
      throw new Error('bad cache');
    return { chats: { ...parsed.chats } };
  }

  it('reuses cached transcript usage while the transcript is unchanged', async () => {
    fixture.tabs = [tab('chat-a')];
    fixture.transcripts.set('chat-a', [userText('/review')]);

    const first = await collectSharedContainerCapabilityUsage(input(), deps());
    const second = await collectSharedContainerCapabilityUsage(input(), deps());

    expect(fixture.transcriptReads).toEqual(['chat-a']);
    expect(second.diagnostics.chatsFromCache).toBe(1);
    expect(second.sourceVersion).toBe(first.sourceVersion);
    expect(second.references).toEqual(first.references);
    expect(Object.keys((await readCacheFile()).chats)).toEqual(['chat-a']);
    expect(fixture.cachePath.startsWith(dataDir)).toBe(true);
  });

  it('misses on a same-length transcript edit', async () => {
    fixture.tabs = [tab('chat-a')];
    fixture.transcripts.set('chat-a', [userText('/aaaa')]);
    const first = await collectSharedContainerCapabilityUsage(input(), deps());

    fixture.transcripts.set('chat-a', [userText('/bbbb')]);
    fixture.tabs = [
      tab('chat-a', {
        transcript: descriptor(2, 'digest-edited', {
          committedByteLength: 300,
        }),
      }),
    ];
    const second = await collectSharedContainerCapabilityUsage(input(), deps());

    expect(fixture.transcriptReads).toEqual(['chat-a', 'chat-a']);
    expect(second.sourceVersion).not.toBe(first.sourceVersion);
    expect(
      find(second.references, 'invocation').map((reference) =>
        reference.kind === 'invocation' ? reference.token : '',
      ),
    ).toEqual(['bbbb']);
  });

  it('misses when only the committed digest changes', async () => {
    fixture.tabs = [tab('chat-a')];
    fixture.transcripts.set('chat-a', [userText('/aaaa')]);
    await collectSharedContainerCapabilityUsage(input(), deps());

    fixture.transcripts.set('chat-a', [userText('/bbbb')]);
    fixture.tabs = [tab('chat-a', { transcript: descriptor(1, 'other') })];
    await collectSharedContainerCapabilityUsage(input(), deps());

    expect(fixture.transcriptReads).toEqual(['chat-a', 'chat-a']);
  });

  it('rereads a chat whose delegation child is still running', async () => {
    fixture.tabs = [tab('chat-a')];
    const child = (skill: string): PersistedChatMessage[] => [
      delegationCard('card-1', { status: 'running' }),
      message(
        'assistant',
        [
          {
            type: 'tool_use',
            toolUseId: 'card-1:item',
            toolName: 'Skill',
            input: JSON.stringify({ skill }),
          },
        ],
        { id: 'card-1:item', parentBlockId: 'card-1' },
      ),
    ];
    fixture.transcripts.set('chat-a', child('first-skill'));
    await collectSharedContainerCapabilityUsage(input(), deps());

    // The delegate log advanced; the parent transcript did not.
    fixture.transcripts.set('chat-a', child('second-skill'));
    const second = await collectSharedContainerCapabilityUsage(input(), deps());

    expect(fixture.transcriptReads).toEqual(['chat-a', 'chat-a']);
    expect(
      find(second.references, 'invocation').map((reference) =>
        reference.kind === 'invocation' ? reference.token : '',
      ),
    ).toEqual(['second-skill']);
    expect(Object.keys((await readCacheFile()).chats)).toEqual([]);
  });

  it('misses when a settled delegation card is updated', async () => {
    fixture.tabs = [tab('chat-a')];
    fixture.transcripts.set('chat-a', [
      delegationCard('card-1', { sequence: 1 }),
    ]);
    await collectSharedContainerCapabilityUsage(input(), deps());
    fixture.transcripts.set('chat-a', [
      delegationCard('card-1', {
        sequence: 2,
        runGeneration: 2,
        selectedModelId: 'agent_model_late@x',
      }),
    ]);
    fixture.agents.set('agent_model_late', agent('agent_model_late'));
    // Committing the card's new projection advances the parent's revision.
    fixture.tabs = [tab('chat-a', { transcript: descriptor(2, 'digest-2') })];

    const second = await collectSharedContainerCapabilityUsage(input(), deps());

    expect(fixture.transcriptReads).toEqual(['chat-a', 'chat-a']);
    expect(find(second.references, 'agent')).toHaveLength(1);
  });

  it('changes sourceVersion when selections or definitions change without a new message', async () => {
    fixture.tabs = [
      tab('codex-chat', { providerType: 'codex', model: 'agent_model_a@x' }),
    ];
    fixture.agents.set('agent_model_a', agent('agent_model_a', 'v1'));
    fixture.selections.set('codex-chat', {
      collectionIds: [],
      skillRefs: [{ sourceId: 'custom:app', skillName: 'one' }],
      pluginRefs: [],
    });
    const first = await collectSharedContainerCapabilityUsage(input(), deps());

    fixture.selections.set('codex-chat', {
      collectionIds: [],
      skillRefs: [{ sourceId: 'custom:app', skillName: 'two' }],
      pluginRefs: [],
    });
    const second = await collectSharedContainerCapabilityUsage(input(), deps());

    fixture.agents.set('agent_model_a', agent('agent_model_a', 'v2'));
    const third = await collectSharedContainerCapabilityUsage(input(), deps());

    expect(fixture.transcriptReads).toEqual(['codex-chat']);
    expect(second.sourceVersion).not.toBe(first.sourceVersion);
    expect(third.sourceVersion).not.toBe(second.sourceVersion);
  });

  it('drops a chat removed from the included set', async () => {
    fixture.tabs = [tab('chat-a'), tab('chat-b')];
    fixture.transcripts.set('chat-a', [userText('/kept')]);
    fixture.transcripts.set('chat-b', [userText('/dropped')]);
    await collectSharedContainerCapabilityUsage(input(), deps());

    const usage = await collectSharedContainerCapabilityUsage(
      input({ includedChatIds: ['chat-a'] }),
      deps(),
    );

    expect(
      find(usage.references, 'invocation').map((reference) =>
        reference.kind === 'invocation' ? reference.token : '',
      ),
    ).toEqual(['kept']);
    expect(Object.keys((await readCacheFile()).chats)).toEqual(['chat-a']);
  });

  it('discards a corrupt cache and recomputes', async () => {
    fixture.tabs = [tab('chat-a')];
    fixture.transcripts.set('chat-a', [userText('/review')]);
    await mkdir(dirname(fixture.cachePath), { recursive: true });
    await writeFile(
      fixture.cachePath,
      '{"version":1,"parserVersion":1,"chats":{"chat-a":',
      'utf8',
    );

    const usage = await collectSharedContainerCapabilityUsage(input(), deps());

    expect(usage.diagnostics.cacheDiscarded).toBe(1);
    expect(find(usage.references, 'invocation')).toHaveLength(1);
    expect(Object.keys((await readCacheFile()).chats)).toEqual(['chat-a']);
  });

  it('discards a structurally invalid cache entry', async () => {
    fixture.tabs = [tab('chat-a')];
    fixture.transcripts.set('chat-a', [userText('/review')]);
    await mkdir(dirname(fixture.cachePath), { recursive: true });
    await writeFile(
      fixture.cachePath,
      JSON.stringify({
        version: 1,
        parserVersion: 1,
        chats: { 'chat-a': { identity: 'x', usage: { references: 'nope' } } },
      }),
      'utf8',
    );

    const usage = await collectSharedContainerCapabilityUsage(input(), deps());

    expect(usage.diagnostics.cacheDiscarded).toBe(1);
    expect(fixture.transcriptReads).toEqual(['chat-a']);
  });

  it('honors an abort signal and writes no cache', async () => {
    fixture.tabs = [tab('chat-a')];
    fixture.transcripts.set('chat-a', [userText('/review')]);
    const controller = new AbortController();
    const listAutomations = jest.fn(() => Promise.resolve(fixture.activities));

    const pending = collectSharedContainerCapabilityUsage(
      input({ signal: controller.signal }),
      deps(fixture, {
        consumeTranscript: () => {
          controller.abort(new Error('cancelled'));
          return Promise.reject(new Error('aborted mid-read'));
        },
        listAutomations,
      }),
    );

    await expect(pending).rejects.toThrow('aborted mid-read');
    expect(listAutomations).not.toHaveBeenCalled();
    await expect(readFile(fixture.cachePath, 'utf8')).rejects.toThrow();
  });

  it('rejects immediately when already aborted', async () => {
    const controller = new AbortController();
    controller.abort(new Error('stop'));
    const readChatTabs = jest.fn();

    await expect(
      collectSharedContainerCapabilityUsage(
        input({ signal: controller.signal }),
        deps(fixture, { readChatTabs }),
      ),
    ).rejects.toThrow('stop');
    expect(readChatTabs).not.toHaveBeenCalled();
  });
});

describe('capability usage cache location', () => {
  it('lives beside the share publication state in app data, never a checkout', () => {
    const cachePath = getWorktreeShareCapabilityUsageCachePath(
      PROJECT,
      WORKTREE,
    );
    expect(dirname(cachePath)).toBe(
      dirname(getWorktreeSharePublicationStatePath(PROJECT, WORKTREE)),
    );
    expect(cachePath.startsWith(dataDir)).toBe(true);
  });
});

describe('collectSharedContainerCapabilityUsage unreadable sources', () => {
  function enoent(): NodeJS.ErrnoException {
    return Object.assign(new Error('gone'), { code: 'ENOENT' });
  }

  function userPipelineRun(pipelineId: string): void {
    fixture.summaries = [summary('exec-1', pipelineId)];
    fixture.states.set(
      'exec-1',
      executionState('exec-1', pipelineId, {
        pipeline_preference_locator: {
          type: 'stored',
          source: 'user',
          value: pipelineId,
        },
      }),
    );
  }

  it('is complete when every source was read or is genuinely absent', async () => {
    fixture.tabs = [tab('chat-a')];
    fixture.transcripts.set('chat-a', [userText('/review')]);
    userPipelineRun('deleted');

    const usage = await collectSharedContainerCapabilityUsage(input(), deps());

    expect(usage.incomplete).toBe(false);
    expect(
      find(usage.references, 'pipeline').map((reference) =>
        reference.kind === 'pipeline' ? reference.historical : undefined,
      ),
    ).toEqual([true]);
  });

  it('marks an unreadable transcript incomplete instead of treating it as unused', async () => {
    fixture.tabs = [tab('chat-a'), tab('chat-b')];
    fixture.transcripts.set('chat-b', [userText('/review')]);

    const usage = await collectSharedContainerCapabilityUsage(
      input(),
      deps(fixture, {
        consumeTranscript: <T>(
          scope: { projectId: string; worktreeId: string },
          chatId: string,
          consume: (
            messages: AsyncIterable<PersistedChatMessage>,
          ) => Promise<T>,
        ): Promise<T> =>
          chatId === 'chat-a'
            ? Promise.reject(new Error('EIO: transient read failure'))
            : deps().consumeTranscript(scope, chatId, consume),
      }),
    );

    expect(usage.incomplete).toBe(true);
    expect(usage.diagnostics.chatsUnreadable).toBe(1);
  });

  it('treats a transcript that no longer exists as absent', async () => {
    fixture.tabs = [tab('chat-a')];

    const usage = await collectSharedContainerCapabilityUsage(
      input(),
      deps(fixture, { consumeTranscript: () => Promise.reject(enoent()) }),
    );

    expect(usage.incomplete).toBe(false);
    expect(usage.diagnostics.chatsMissing).toBe(1);
    expect(usage.diagnostics.chatsUnreadable).toBe(0);
  });

  it('does not treat a user pipeline read error as a deletion', async () => {
    userPipelineRun('present');

    const usage = await collectSharedContainerCapabilityUsage(
      input(),
      deps(fixture, {
        readUserPipeline: () => Promise.reject(new Error('EACCES')),
      }),
    );

    expect(find(usage.references, 'pipeline')).toEqual([]);
    expect(usage.diagnostics.pipelinesHistorical).toBe(0);
    expect(usage.incomplete).toBe(true);
  });

  it('does not treat a pipeline file read error as a deletion', async () => {
    fixture.summaries = [summary('exec-1', 'file-pipeline')];
    fixture.states.set(
      'exec-1',
      executionState('exec-1', 'file-pipeline', {
        pipeline_preference_locator: {
          type: 'file',
          value: '/elsewhere/pipeline.yaml',
        },
      }),
    );

    const usage = await collectSharedContainerCapabilityUsage(
      input(),
      deps(fixture, {
        readPipelineFile: () => Promise.reject(new Error('EIO')),
      }),
    );

    expect(find(usage.references, 'pipeline')).toEqual([]);
    expect(usage.incomplete).toBe(true);
  });

  it.each([
    [
      'an Agent',
      (): Partial<SharedContainerCapabilityUsageDependencies> => {
        fixture.tabs = [
          tab('chat-a', { model: 'agent_model_reviewer@claude' }),
        ];
        return { getAgentModel: () => Promise.reject(new Error('EIO')) };
      },
    ],
    [
      'an execution state',
      (): Partial<SharedContainerCapabilityUsageDependencies> => {
        userPipelineRun('present');
        return { loadExecutionState: () => Promise.reject(new Error('EIO')) };
      },
    ],
    [
      "an automation's run history",
      (): Partial<SharedContainerCapabilityUsageDependencies> => {
        fixture.activities = [
          activity('retargeted', {
            type: 'worktree_session_prompt',
            workspaceId: PROJECT,
            worktreeId: 'elsewhere',
            chatId: 'chat-z',
            prompt: 'weekly',
          }),
        ];
        return { listAutomationRuns: () => Promise.reject(new Error('EIO')) };
      },
    ],
  ])('marks %s read error incomplete', async (_label, arrange) => {
    const overrides = arrange();

    const usage = await collectSharedContainerCapabilityUsage(
      input(),
      deps(fixture, overrides),
    );

    expect(usage.incomplete).toBe(true);
  });

  it('treats an Agent or execution state that is gone as absent', async () => {
    fixture.tabs = [tab('chat-a', { model: 'agent_model_gone@claude' })];
    fixture.summaries = [summary('exec-1', 'vanished')];

    const usage = await collectSharedContainerCapabilityUsage(input(), deps());

    expect(usage.incomplete).toBe(false);
    expect(usage.diagnostics.agentsUnavailable).toBe(1);
  });

  it('does not let hooks, which never travel, make usage incomplete', async () => {
    fixture.hookRuns = [hookRun({ hookKey: 'project:pr:create' })];

    const usage = await collectSharedContainerCapabilityUsage(input(), deps());

    expect(usage.diagnostics.hooksUnavailable).toBe(1);
    expect(usage.incomplete).toBe(false);
  });

  it('still propagates cancellation from a failing read', async () => {
    fixture.tabs = [tab('chat-a')];
    const controller = new AbortController();

    await expect(
      collectSharedContainerCapabilityUsage(
        input({ signal: controller.signal }),
        deps(fixture, {
          consumeTranscript: () => {
            controller.abort(new Error('stop'));
            return Promise.reject(new Error('aborted read'));
          },
        }),
      ),
    ).rejects.toThrow();
  });
});

describe('capability usage default readers', () => {
  const PIPELINE = [
    'name: Stored',
    'on: dispatch',
    'jobs:',
    '  build:',
    '    steps: []',
    '',
  ].join('\n');

  async function writeUserPipeline(
    filename: string,
    content: string | null,
  ): Promise<void> {
    const dir = join(dataDir, 'pipelines');
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, 'index.json'),
      JSON.stringify({
        pipelines: [
          {
            id: 'stored',
            name: 'Stored',
            filename,
            createdAt: '2026-10-01T00:00:00.000Z',
            updatedAt: '2026-10-01T00:00:00.000Z',
          },
        ],
      }),
    );
    if (content === null) await mkdir(join(dir, filename));
    else await writeFile(join(dir, filename), content);
  }

  it('reads a stored user pipeline and reports a deleted one as absent', async () => {
    await expect(readSharedContainerUserPipeline('stored')).resolves.toBeNull();
    await writeUserPipeline('stored.yaml', PIPELINE);
    await expect(
      readSharedContainerUserPipeline('stored'),
    ).resolves.toMatchObject({ rawContent: PIPELINE });
    await expect(readSharedContainerUserPipeline('other')).resolves.toBeNull();
    await rm(join(dataDir, 'pipelines', 'stored.yaml'));
    await expect(readSharedContainerUserPipeline('stored')).resolves.toBeNull();
  });

  it('rejects a user pipeline that exists but cannot be read or parsed', async () => {
    await writeUserPipeline('stored.yaml', null);
    await expect(readSharedContainerUserPipeline('stored')).rejects.toThrow();
    await rm(join(dataDir, 'pipelines'), { recursive: true, force: true });
    await writeUserPipeline('stored.yaml', 'jobs: [unclosed\n');
    await expect(readSharedContainerUserPipeline('stored')).rejects.toThrow();
  });

  it('rejects an unreadable pipeline index', async () => {
    await mkdir(join(dataDir, 'pipelines', 'index.json'), { recursive: true });
    await expect(readSharedContainerUserPipeline('stored')).rejects.toThrow();
  });

  it('reports a missing or unavailable Agent as absent and rejects other failures', async () => {
    mockGetAgentModel.mockResolvedValueOnce(null);
    await expect(
      readSharedContainerAgentModel('agent_model_missing', PROJECT),
    ).resolves.toBeNull();
    mockGetAgentModel.mockRejectedValueOnce(
      new Error('Agent unavailable (access-removed)'),
    );
    await expect(
      readSharedContainerAgentModel('agent_model_removed', PROJECT),
    ).resolves.toBeNull();
    mockGetAgentModel.mockRejectedValueOnce(new Error('EIO: read failed'));
    await expect(
      readSharedContainerAgentModel('agent_model_reviewer', PROJECT),
    ).rejects.toThrow('EIO');
    mockGetAgentModel.mockResolvedValueOnce(agent('agent_model_reviewer'));
    await expect(
      readSharedContainerAgentModel('agent_model_reviewer', PROJECT),
    ).resolves.toMatchObject({ id: 'agent_model_reviewer' });
  });
});
