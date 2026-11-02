const mockReadFile = jest.fn<Promise<string>, [string, string?]>();
const mockAppendFile = jest.fn<Promise<void>, [string, string]>();
const mockMkdir = jest.fn<Promise<void>, [string, { recursive?: boolean }?]>();
const mockStat = jest.fn<Promise<{ size: number }>, [string]>();
const mockWriteFile = jest.fn<Promise<void>, [string, string]>();
const mockReadPreferencesFile = jest.fn();
const mockCheckClaudeAuthStatusObserved = jest.fn();
const mockWarmProviderAccountIdentity = jest.fn();

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

jest.mock('../../auth/provider-auth-state', () => ({
  get checkClaudeAuthStatusObserved(): typeof mockCheckClaudeAuthStatusObserved {
    return mockCheckClaudeAuthStatusObserved;
  },
  peekProviderAccountIdentity: (): null => null,
  peekProviderBillingAccountKind: (): 'api_key' => 'api_key',
  get warmProviderAccountIdentity(): typeof mockWarmProviderAccountIdentity {
    return mockWarmProviderAccountIdentity;
  },
}));

jest.mock('../../feature-flags', () => ({
  getFeatureFlagService: (): { onSnapshotChanged: () => () => void } => ({
    onSnapshotChanged: (): (() => void) => (): void => undefined,
  }),
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

import type { AgentAuditEntry } from '@canopy/desktop-shared/types/observability';
import {
  readdir as readdirModuleMock,
  rename as renameModuleMock,
  rm as rmModuleMock,
} from 'node:fs/promises';
import { ClaudeTaskUsageTracker } from '../capture-fields';
import { ObservabilityService } from '../service';
import { setExperimentalFeaturesEnabled } from '../../lib/experimental-features';

const mockReaddir = jest.mocked(readdirModuleMock);
const mockRename = jest.mocked(renameModuleMock);
const mockRm = jest.mocked(rmModuleMock);

function createEntry(id = 'entry-1'): AgentAuditEntry {
  return {
    id,
    eventType: 'worktree_chat',
    status: 'running',
    provider: 'claude',
    label: 'Chat',
    startedAt: '2026-10-08T12:00:00.000Z',
    tokens: {
      input: 0,
      output: 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
    },
    messageCount: 0,
    assistantMessageCount: 0,
    toolUseCount: 0,
    subAgentCount: 0,
    toolCounts: {},
    hasTranscript: false,
  } as unknown as AgentAuditEntry;
}

function taskStarted(
  toolUseId: string,
  options: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    type: 'system',
    subtype: 'task_started',
    task_type: 'local_agent',
    task_id: `task-${toolUseId}`,
    tool_use_id: toolUseId,
    ...options,
  };
}

function taskProgress(
  toolUseId: string,
  totalTokens: number,
  options: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    type: 'system',
    subtype: 'task_progress',
    task_id: `task-${toolUseId}`,
    tool_use_id: toolUseId,
    usage: { total_tokens: totalTokens },
    ...options,
  };
}

const NOW = Date.parse('2026-10-08T12:00:00.000Z');

function startServiceChat(
  service: ObservabilityService,
  chatId = 'chat',
): void {
  service.startChatTurn({
    projectId: 'proj',
    worktreeId: 'wt',
    chatId,
    provider: 'claude',
    originalUserText: 'Private prompt must not be captured',
    submittedText: 'Private prompt must not be captured',
    userMessageId: 'msg-1',
    planMode: false,
    isStandalone: false,
  });
}

function recentServiceEntry(
  service: ObservabilityService,
  chatId = 'chat',
): AgentAuditEntry {
  const entry = service
    .loadSnapshot()
    .recentEntries.find((candidate) => candidate.chatId === chatId);
  if (!entry) throw new Error(`Expected audit entry for ${chatId}`);
  return entry;
}

describe('ClaudeTaskUsageTracker', () => {
  let tracker: ClaudeTaskUsageTracker;

  beforeEach(() => {
    tracker = new ClaudeTaskUsageTracker();
  });

  it('registers each local-agent task once with a zero-token included row', () => {
    const entry = createEntry();
    const started = taskStarted('tool-use-1', {
      subagent_type: 'Explore',
      description: 'private task description',
      prompt: 'private task prompt',
    });

    expect(tracker.observe(entry, started)).toBe(true);
    expect(tracker.observe(entry, started)).toBe(false);
    expect(entry.subAgentCount).toBe(1);
    expect(entry.subagents).toEqual([
      {
        id: 'tool-use-1',
        kind: 'claude_task',
        label: 'Explore',
        tokens: {
          input: 0,
          output: 0,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
          reasoningOutputTokens: 0,
        },
        totalTokens: 0,
        inclusion: 'included',
      },
    ]);
    expect(JSON.stringify(entry.subagents)).not.toContain('private task');
  });

  it('adds only increases in running total_tokens and stores only a safe type label', () => {
    const entry = createEntry();
    tracker.observe(entry, taskStarted('tool-use-1'));

    expect(
      tracker.observe(
        entry,
        taskProgress('tool-use-1', 10, { subagent_type: 'Explore' }),
      ),
    ).toBe(true);
    expect(tracker.observe(entry, taskProgress('tool-use-1', 27))).toBe(true);
    expect(tracker.observe(entry, taskProgress('tool-use-1', 27))).toBe(false);
    expect(
      tracker.observe(entry, {
        type: 'system',
        subtype: 'task_notification',
        task_id: 'task-tool-use-1',
        tool_use_id: 'tool-use-1',
        usage: { total_tokens: 35 },
        subagent_type: 'Plan\n',
        prompt: 'do not store this',
        description: 'do not store this either',
      }),
    ).toBe(true);

    expect(entry.subagents).toEqual([
      {
        id: 'tool-use-1',
        kind: 'claude_task',
        label: 'Plan',
        totalTokens: 35,
        tokens: {
          input: 0,
          output: 0,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
          reasoningOutputTokens: 0,
        },
        inclusion: 'included',
      },
    ]);
    expect(JSON.stringify(entry.subagents)).not.toContain('do not store');
  });

  it('reports the first completion without new usage as a change, once', () => {
    const tracker = new ClaudeTaskUsageTracker();
    const entry = createEntry();
    tracker.observe(entry, taskStarted('tool-use-1'));
    tracker.observe(entry, taskProgress('tool-use-1', 40));
    const completion = {
      type: 'system',
      subtype: 'task_notification',
      task_id: 'task-tool-use-1',
      tool_use_id: 'tool-use-1',
      status: 'completed',
    };

    expect(tracker.observe(entry, completion)).toBe(true);
    expect(tracker.observe(entry, completion)).toBe(false);
    expect(entry.subagents?.[0]?.totalTokens).toBe(40);
  });

  it('resolves progress and notification events by task_id when tool_use_id is absent', () => {
    const entry = createEntry();
    tracker.observe(
      entry,
      taskStarted('tool-use-1', { task_id: 'provider-task-1' }),
    );

    expect(
      tracker.observe(entry, {
        type: 'system',
        subtype: 'task_progress',
        task_id: 'provider-task-1',
        usage: { total_tokens: 8 },
      }),
    ).toBe(true);
    expect(
      tracker.observe(entry, {
        type: 'system',
        subtype: 'task_notification',
        task_id: 'provider-task-1',
        usage: { total_tokens: 21 },
      }),
    ).toBe(true);

    expect(entry.subagents?.[0]).toMatchObject({
      id: 'tool-use-1',
      totalTokens: 21,
    });
  });

  it('queues bounded task state without an entry and applies it at the next entry start', () => {
    tracker.observe(
      undefined,
      taskStarted('tool-use-1', {
        subagent_type: 'Explore',
        description: 'private description',
        prompt: 'private prompt',
      }),
    );
    tracker.observe(
      undefined,
      taskProgress('tool-use-1', 12, {
        description: 'private progress description',
      }),
    );
    tracker.observe(undefined, taskProgress('tool-use-1', 30));

    const entry = createEntry();
    expect(tracker.applyPending(entry)).toBe(true);
    expect(tracker.applyPending(entry)).toBe(false);
    expect(entry.subAgentCount).toBe(1);
    expect(entry.subagents?.[0]).toMatchObject({
      id: 'tool-use-1',
      kind: 'claude_task',
      label: 'Explore',
      totalTokens: 30,
      inclusion: 'included',
    });
    expect(JSON.stringify(entry.subagents)).not.toContain('private');
  });

  it('charges only the increase after a task crosses an entry boundary', () => {
    const firstEntry = createEntry('entry-1');
    tracker.observe(firstEntry, taskStarted('tool-use-1'));
    tracker.observe(firstEntry, taskProgress('tool-use-1', 100));

    const nextEntry = createEntry('entry-2');
    expect(tracker.applyPending(nextEntry)).toBe(false);
    tracker.observe(nextEntry, taskProgress('tool-use-1', 135));

    expect(firstEntry.subagents?.[0]?.totalTokens).toBe(100);
    expect(nextEntry.subagents?.[0]?.totalTokens).toBe(35);
    expect(nextEntry.subAgentCount).toBe(0);
  });

  it('bounds entry rows while continuing to track tasks beyond 64 task starts', () => {
    const entry = createEntry();

    for (let index = 0; index < 70; index += 1) {
      tracker.observe(entry, taskStarted(`tool-use-${index}`));
    }

    expect(entry.subAgentCount).toBe(70);
    expect(entry.subagents).toHaveLength(64);

    const nextEntry = createEntry('entry-2');
    tracker.observe(nextEntry, taskProgress('tool-use-69', 7));
    expect(nextEntry.subagents?.[0]).toMatchObject({
      id: 'tool-use-69',
      totalTokens: 7,
    });
  });

  it('ignores malformed and non-local-agent task starts', () => {
    const entry = createEntry();

    expect(
      tracker.observe(
        entry,
        taskStarted('tool-use-1', { task_type: 'remote_agent' }),
      ),
    ).toBe(false);
    expect(
      tracker.observe(entry, {
        type: 'system',
        subtype: 'task_started',
        task_type: 'local_agent',
        task_id: 'task-without-tool-use',
      }),
    ).toBe(false);
    expect(entry.subAgentCount).toBe(0);
    expect(entry.subagents).toBeUndefined();
  });
});

describe('Claude task usage through ObservabilityService', () => {
  let services: ObservabilityService[];

  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(NOW);
    setExperimentalFeaturesEnabled(false);
    services = [];
    mockReadPreferencesFile.mockResolvedValue({ auditRetentionDays: 30 });
    mockReadFile.mockResolvedValue('');
    mockReaddir.mockResolvedValue([]);
    mockAppendFile.mockResolvedValue(undefined);
    mockMkdir.mockResolvedValue(undefined);
    mockRename.mockResolvedValue(undefined);
    mockRm.mockResolvedValue(undefined);
    mockStat.mockResolvedValue({ size: 0 });
    mockWriteFile.mockResolvedValue(undefined);
  });

  afterEach(async () => {
    await Promise.all(services.map((service) => service.dispose()));
    setExperimentalFeaturesEnabled(false);
    jest.useRealTimers();
  });

  function createService(): ObservabilityService {
    const service = new ObservabilityService();
    services.push(service);
    return service;
  }

  it('counts Claude task tools only from task_started, not twice from tool use', () => {
    const service = createService();
    startServiceChat(service);
    service.observeChatEvent('proj', 'wt', 'chat', {
      type: 'assistant',
      message: {
        id: 'root-message',
        model: 'claude-sonnet-4-5',
        content: [
          { type: 'tool_use', id: 'tool-use-1', name: 'Task', input: {} },
          { type: 'tool_use', id: 'tool-use-2', name: 'Task', input: {} },
        ],
        usage: { input_tokens: 5, output_tokens: 2 },
      },
    });
    service.observeChatEvent('proj', 'wt', 'chat', taskStarted('tool-use-1'));
    service.observeChatEvent(
      'proj',
      'wt',
      'chat',
      taskProgress('tool-use-1', 11),
    );
    service.observeChatEvent('proj', 'wt', 'chat', taskStarted('tool-use-2'));
    service.observeChatEvent(
      'proj',
      'wt',
      'chat',
      taskProgress('tool-use-2', 17),
    );

    expect(recentServiceEntry(service)).toMatchObject({
      toolUseCount: 2,
      subAgentCount: 2,
      subagents: [
        { id: 'tool-use-1', kind: 'claude_task', totalTokens: 11 },
        { id: 'tool-use-2', kind: 'claude_task', totalTokens: 17 },
      ],
    });
  });

  it('does not infer a subagent from parent_tool_use_id assistant usage alone', () => {
    const service = createService();
    startServiceChat(service);

    service.observeChatEvent('proj', 'wt', 'chat', {
      type: 'assistant',
      parent_tool_use_id: 'tool-use-1',
      message: {
        id: 'child-message',
        model: 'claude-haiku-4-5',
        content: [],
        usage: { input_tokens: 500, output_tokens: 200 },
      },
    });

    expect(recentServiceEntry(service)).toMatchObject({ subAgentCount: 0 });
    expect(recentServiceEntry(service)).not.toHaveProperty('subagents');
  });

  it('queues a completed task notification off-turn and applies only its delta to the next entry', () => {
    const service = createService();
    startServiceChat(service);
    service.observeChatEvent('proj', 'wt', 'chat', taskStarted('tool-use-1'));
    service.observeChatEvent(
      'proj',
      'wt',
      'chat',
      taskProgress('tool-use-1', 12),
    );
    service.completeChatTurn('proj', 'wt', 'chat', 'success');

    const completedEntry = recentServiceEntry(service);
    expect(completedEntry.subagents?.[0]?.totalTokens).toBe(12);
    service.observeChatEvent('proj', 'wt', 'chat', {
      type: 'system',
      subtype: 'task_notification',
      task_id: 'task-tool-use-1',
      status: 'completed',
      usage: { total_tokens: 30 },
    });

    expect(recentServiceEntry(service).id).toBe(completedEntry.id);
    expect(recentServiceEntry(service).subagents?.[0]?.totalTokens).toBe(12);

    startServiceChat(service);

    const nextEntry = recentServiceEntry(service);
    expect(nextEntry.id).not.toBe(completedEntry.id);
    expect(nextEntry).toMatchObject({
      subAgentCount: 0,
      subagents: [
        {
          id: 'tool-use-1',
          kind: 'claude_task',
          totalTokens: 18,
          inclusion: 'included',
        },
      ],
    });
    const oldEntry = service
      .loadSnapshot()
      .recentEntries.find((entry) => entry.id === completedEntry.id);
    expect(oldEntry?.subagents?.[0]?.totalTokens).toBe(12);
  });

  it('retains task events before the first chat after beginClaudeQuery establishes provider context', () => {
    const service = createService();
    const key = 'chat:proj/wt/chat';
    service.beginClaudeQuery(key);
    service.observeChatEvent(
      'proj',
      'wt',
      'chat',
      taskStarted('tool-use-1', { subagent_type: 'Explore' }),
    );
    service.observeChatEvent(
      'proj',
      'wt',
      'chat',
      taskProgress('tool-use-1', 24),
    );

    startServiceChat(service);

    expect(recentServiceEntry(service)).toMatchObject({
      subAgentCount: 1,
      subagents: [
        {
          id: 'tool-use-1',
          label: 'Explore',
          totalTokens: 24,
          inclusion: 'included',
        },
      ],
    });
    service.endClaudeQuery(key);
  });
});
