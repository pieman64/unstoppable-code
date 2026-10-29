import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentAuditEntry } from '@canopy/desktop-shared/types';
import * as claudeCostLedger from '../claude-session-cost-ledger';

jest.mock('../../auth/provider-auth-state', () => ({
  checkClaudeAuthStatusObserved: jest.fn(),
  peekProviderAccountIdentity: jest.fn(() => null),
  peekProviderBillingAccountKind: jest.fn(() => 'api_key'),
  warmProviderAccountIdentity: jest.fn(),
}));

import { ObservabilityService } from '../service';

const getClaudeSessionCostLedgerSpy = jest.spyOn(
  claudeCostLedger,
  'getClaudeSessionCostLedger',
);

const MODEL = 'claude-sonnet-4-5';
const SESSION_ID = 'claude-session-1';
const PROJECT_ID = 'project-1';
const WORKTREE_ID = 'worktree-1';
const CHAT_ID = 'chat-1';
const CHAT_QUERY_ID = `chat:${PROJECT_ID}/${WORKTREE_ID}/${CHAT_ID}`;

const TOOL_COUNTS: AgentAuditEntry['toolCounts'] = {
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

interface ModelTotalsInput {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  webSearchRequests: number;
  costUSD: number;
  costBasis?: 'list' | 'managed' | 'unknown';
}

function modelTotals(
  input: ModelTotalsInput,
): Record<string, ModelTotalsInput> {
  return { [MODEL]: input };
}

function claudeResult(
  sessionId: string,
  totalCostUsd: number,
  modelUsage: Readonly<Record<string, ModelTotalsInput>>,
  usage: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  } = {},
): Record<string, unknown> {
  return {
    type: 'result',
    session_id: sessionId,
    total_cost_usd: totalCostUsd,
    modelUsage,
    usage: {
      input_tokens: usage.input_tokens ?? 10,
      output_tokens: usage.output_tokens ?? 2,
      cache_read_input_tokens: usage.cache_read_input_tokens ?? 3,
      cache_creation_input_tokens: usage.cache_creation_input_tokens ?? 1,
    },
  };
}

function makeObservedTaskEntry(
  id: string,
  eventType: AgentAuditEntry['eventType'],
): AgentAuditEntry {
  return {
    id,
    eventType,
    status: 'running',
    provider: 'claude',
    label: 'Claude task',
    startedAt: '2026-10-15T12:00:00.000Z',
    model: MODEL,
    tokens: {
      input: 0,
      output: 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      reasoningOutputTokens: 0,
    },
    messageCount: 0,
    assistantMessageCount: 0,
    toolUseCount: 0,
    subAgentCount: 0,
    hasTranscript: false,
    toolCounts: TOOL_COUNTS,
  };
}

function makeService(): ObservabilityService {
  const service = new ObservabilityService();
  services.push(service);
  return service;
}

function makeLedger(
  filePath: string,
): claudeCostLedger.ClaudeSessionCostLedger {
  return new claudeCostLedger.ClaudeSessionCostLedger({
    filePath,
    persistDelayMs: 60_000,
  });
}

function beginClaudeQueryIfAvailable(
  service: ObservabilityService,
  queryId: string,
  startedFrom?: { sessionId: string; fork: boolean },
): void {
  const beginClaudeQuery: unknown = Reflect.get(service, 'beginClaudeQuery');
  if (typeof beginClaudeQuery !== 'function') return;
  Reflect.apply(beginClaudeQuery, service, [queryId, startedFrom]);
}

function endClaudeQueryIfAvailable(
  service: ObservabilityService,
  queryId: string,
): void {
  const endClaudeQuery: unknown = Reflect.get(service, 'endClaudeQuery');
  if (typeof endClaudeQuery !== 'function') return;
  Reflect.apply(endClaudeQuery, service, [queryId]);
}

function observeResult(
  service: ObservabilityService,
  queryId: string,
  event: Record<string, unknown>,
): void {
  service.observeClaudeEvent(queryId, event, 'claude');
}

function startChat(
  service: ObservabilityService,
  sdkSessionId?: string,
): string {
  service.startChatTurn({
    projectId: PROJECT_ID,
    worktreeId: WORKTREE_ID,
    chatId: CHAT_ID,
    provider: 'claude',
    originalUserText: 'Test prompt',
    submittedText: 'Test prompt',
    planMode: false,
    isStandalone: false,
    model: MODEL,
    ...(sdkSessionId ? { sdkSessionId } : {}),
  });
  const entry = service
    .loadSnapshot()
    .recentEntries.find(
      (candidate) =>
        candidate.chatId === CHAT_ID && candidate.status === 'running',
    );
  if (!entry) throw new Error('Claude chat audit entry was not started.');
  return entry.id;
}

function observedTaskEntry(
  service: ObservabilityService,
  id: string,
): AgentAuditEntry | undefined {
  return service.loadSnapshot().recentEntries.find((entry) => entry.id === id);
}

const services: ObservabilityService[] = [];
let currentLedger: claudeCostLedger.ClaudeSessionCostLedger;
let ledgerFilePath = '';
let tempDirectory = '';
const disposedServices = new WeakSet<ObservabilityService>();

async function disposeService(service: ObservabilityService): Promise<void> {
  if (disposedServices.has(service)) return;
  disposedServices.add(service);
  await service.dispose();
}

async function restartLedger(): Promise<void> {
  await currentLedger.flush();
  currentLedger = makeLedger(ledgerFilePath);
  await currentLedger.load();
  getClaudeSessionCostLedgerSpy.mockReturnValue(currentLedger);
}

beforeEach(async () => {
  services.length = 0;
  tempDirectory = await mkdtemp(
    join(process.env.TMPDIR ?? tmpdir(), 'claude-result-cost-'),
  );
  ledgerFilePath = join(tempDirectory, 'claude-session-costs.json');
  currentLedger = makeLedger(ledgerFilePath);
  await currentLedger.load();
  getClaudeSessionCostLedgerSpy.mockReturnValue(currentLedger);
});

afterEach(async () => {
  await Promise.all(services.map(disposeService));
  await currentLedger.flush();
  getClaudeSessionCostLedgerSpy.mockReset();
  await rm(tempDirectory, { recursive: true, force: true });
});

describe('Claude result cost service integration', () => {
  it('keeps a resumed chat cost delta across service teardown and ledger restart', async () => {
    const firstService = makeService();
    const firstEntryId = startChat(firstService);
    beginClaudeQueryIfAvailable(firstService, CHAT_QUERY_ID);
    observeResult(
      firstService,
      CHAT_QUERY_ID,
      claudeResult(
        SESSION_ID,
        41.99,
        modelTotals({
          inputTokens: 1_000,
          outputTokens: 200,
          cacheReadInputTokens: 400,
          cacheCreationInputTokens: 50,
          webSearchRequests: 1,
          costUSD: 41.99,
          costBasis: 'list',
        }),
      ),
    );
    endClaudeQueryIfAvailable(firstService, CHAT_QUERY_ID);
    firstService.completeChatTurn(PROJECT_ID, WORKTREE_ID, CHAT_ID, 'success');
    expect(observedTaskEntry(firstService, firstEntryId)).toMatchObject({
      totalCostUsd: 41.99,
      sdkCumulativeCostUsd: 41.99,
      costDerivation: 'exact',
    });
    await disposeService(firstService);

    await restartLedger();
    const resumedService = makeService();
    const resumedEntryId = startChat(resumedService, SESSION_ID);
    beginClaudeQueryIfAvailable(resumedService, CHAT_QUERY_ID, {
      sessionId: SESSION_ID,
      fork: false,
    });
    observeResult(
      resumedService,
      CHAT_QUERY_ID,
      claudeResult(
        SESSION_ID,
        46.75,
        modelTotals({
          inputTokens: 1_100,
          outputTokens: 220,
          cacheReadInputTokens: 420,
          cacheCreationInputTokens: 60,
          webSearchRequests: 2,
          costUSD: 46.75,
          costBasis: 'list',
        }),
      ),
    );
    endClaudeQueryIfAvailable(resumedService, CHAT_QUERY_ID);
    resumedService.completeChatTurn(
      PROJECT_ID,
      WORKTREE_ID,
      CHAT_ID,
      'success',
    );

    expect(observedTaskEntry(resumedService, resumedEntryId)).toMatchObject({
      totalCostUsd: 4.76,
      sdkCumulativeCostUsd: 46.75,
      costDerivation: 'exact',
      modelUsage: [
        {
          model: MODEL,
          inputTokens: 100,
          outputTokens: 20,
          cacheReadInputTokens: 20,
          cacheCreationInputTokens: 10,
          webSearchRequests: 1,
          costUsd: 4.76,
          costBasis: 'list',
        },
      ],
    });
  });

  it.each([
    ['pipeline agent', 'pipeline_agent_turn'],
    ['pipeline advisor', 'pipeline_advisor'],
  ] as const)(
    'uses the resumed session baseline for a %s task',
    (label, eventType) => {
      const service = makeService();
      const taskKey = `${label.replaceAll(' ', '-')}:task-1`;
      const firstEntryId = `${taskKey}:first`;
      service.startObservedTask(
        taskKey,
        makeObservedTaskEntry(firstEntryId, eventType),
      );
      beginClaudeQueryIfAvailable(service, taskKey);
      observeResult(
        service,
        taskKey,
        claudeResult(
          SESSION_ID,
          12,
          modelTotals({
            inputTokens: 100,
            outputTokens: 20,
            cacheReadInputTokens: 10,
            cacheCreationInputTokens: 5,
            webSearchRequests: 0,
            costUSD: 12,
            costBasis: 'list',
          }),
        ),
      );
      endClaudeQueryIfAvailable(service, taskKey);
      service.finalizeObservedTask(taskKey, 'success');

      const resumedEntryId = `${taskKey}:resumed`;
      service.startObservedTask(
        taskKey,
        makeObservedTaskEntry(resumedEntryId, eventType),
      );
      beginClaudeQueryIfAvailable(service, taskKey, {
        sessionId: SESSION_ID,
        fork: false,
      });
      observeResult(
        service,
        taskKey,
        claudeResult(
          SESSION_ID,
          16.5,
          modelTotals({
            inputTokens: 150,
            outputTokens: 30,
            cacheReadInputTokens: 15,
            cacheCreationInputTokens: 8,
            webSearchRequests: 1,
            costUSD: 16.5,
            costBasis: 'list',
          }),
        ),
      );
      endClaudeQueryIfAvailable(service, taskKey);
      service.finalizeObservedTask(taskKey, 'success');

      expect(observedTaskEntry(service, resumedEntryId)).toMatchObject({
        totalCostUsd: 4.5,
        sdkCumulativeCostUsd: 16.5,
        costDerivation: 'exact',
        modelUsage: [
          expect.objectContaining({
            model: MODEL,
            inputTokens: 50,
            outputTokens: 10,
            cacheReadInputTokens: 5,
            cacheCreationInputTokens: 3,
            webSearchRequests: 1,
            costUsd: 4.5,
          }),
        ],
      });
    },
  );

  it('starts a fresh cost baseline when a new Claude session replaces the old one', () => {
    const service = makeService();
    const firstEntryId = startChat(service);
    beginClaudeQueryIfAvailable(service, CHAT_QUERY_ID);
    observeResult(
      service,
      CHAT_QUERY_ID,
      claudeResult(
        SESSION_ID,
        41.99,
        modelTotals({
          inputTokens: 1_000,
          outputTokens: 200,
          cacheReadInputTokens: 400,
          cacheCreationInputTokens: 50,
          webSearchRequests: 1,
          costUSD: 41.99,
          costBasis: 'list',
        }),
      ),
    );
    endClaudeQueryIfAvailable(service, CHAT_QUERY_ID);
    service.completeChatTurn(PROJECT_ID, WORKTREE_ID, CHAT_ID, 'success');

    const freshSessionId = 'claude-session-after-reset';
    const freshEntryId = startChat(service, freshSessionId);
    beginClaudeQueryIfAvailable(service, CHAT_QUERY_ID);
    observeResult(
      service,
      CHAT_QUERY_ID,
      claudeResult(
        freshSessionId,
        3.25,
        modelTotals({
          inputTokens: 100,
          outputTokens: 20,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
          webSearchRequests: 0,
          costUSD: 3.25,
          costBasis: 'list',
        }),
      ),
    );
    endClaudeQueryIfAvailable(service, CHAT_QUERY_ID);
    service.completeChatTurn(PROJECT_ID, WORKTREE_ID, CHAT_ID, 'success');

    expect(observedTaskEntry(service, firstEntryId)).toMatchObject({
      totalCostUsd: 41.99,
    });
    expect(observedTaskEntry(service, freshEntryId)).toMatchObject({
      totalCostUsd: 3.25,
      sdkCumulativeCostUsd: 3.25,
      costDerivation: 'exact',
    });
  });

  it('sums result deltas instead of replacing entry cost with helper usage totals', () => {
    const service = makeService();
    const taskKey = 'helper:multi-result';
    const entryId = `${taskKey}:entry`;
    service.startObservedTask(
      taskKey,
      makeObservedTaskEntry(entryId, 'chat_summary'),
    );
    beginClaudeQueryIfAvailable(service, taskKey);
    observeResult(
      service,
      taskKey,
      claudeResult(
        SESSION_ID,
        2,
        modelTotals({
          inputTokens: 100,
          outputTokens: 20,
          cacheReadInputTokens: 5,
          cacheCreationInputTokens: 2,
          webSearchRequests: 0,
          costUSD: 2,
          costBasis: 'list',
        }),
      ),
    );
    observeResult(
      service,
      taskKey,
      claudeResult(
        SESSION_ID,
        5,
        modelTotals({
          inputTokens: 180,
          outputTokens: 35,
          cacheReadInputTokens: 12,
          cacheCreationInputTokens: 4,
          webSearchRequests: 1,
          costUSD: 5,
          costBasis: 'list',
        }),
      ),
    );
    endClaudeQueryIfAvailable(service, taskKey);
    service.finalizeObservedTask(taskKey, 'success', undefined, {
      inputTokens: 999_999,
      outputTokens: 999_999,
      cacheReadInputTokens: 999_999,
      cacheCreationInputTokens: 999_999,
      totalCostUsd: 999_999,
    });

    expect(observedTaskEntry(service, entryId)).toMatchObject({
      totalCostUsd: 5,
      sdkCumulativeCostUsd: 5,
      costDerivation: 'exact',
    });
  });

  it('sums per-model usage deltas across results without double counting', () => {
    const service = makeService();
    const taskKey = 'helper:multiple-models';
    const entryId = `${taskKey}:entry`;
    const makeTotals = (
      opusCost: number,
      opusInput: number,
      haikuCost: number,
      haikuInput: number,
    ): Readonly<Record<string, ModelTotalsInput>> => ({
      'claude-opus-4-1': {
        inputTokens: opusInput,
        outputTokens: opusInput / 5,
        cacheReadInputTokens: opusInput / 10,
        cacheCreationInputTokens: opusInput / 20,
        webSearchRequests: 1,
        costUSD: opusCost,
        costBasis: 'managed',
      },
      'claude-haiku-4-5': {
        inputTokens: haikuInput,
        outputTokens: haikuInput / 5,
        cacheReadInputTokens: haikuInput / 10,
        cacheCreationInputTokens: haikuInput / 20,
        webSearchRequests: 0,
        costUSD: haikuCost,
        costBasis: 'list',
      },
    });

    service.startObservedTask(
      taskKey,
      makeObservedTaskEntry(entryId, 'archive_summary'),
    );
    beginClaudeQueryIfAvailable(service, taskKey);
    observeResult(
      service,
      taskKey,
      claudeResult(SESSION_ID, 3, makeTotals(2, 100, 1, 50)),
    );
    observeResult(
      service,
      taskKey,
      claudeResult(SESSION_ID, 5.5, makeTotals(4, 150, 1.5, 80)),
    );
    endClaudeQueryIfAvailable(service, taskKey);
    service.finalizeObservedTask(taskKey, 'success');

    expect(observedTaskEntry(service, entryId)).toMatchObject({
      totalCostUsd: 5.5,
      sdkCumulativeCostUsd: 5.5,
      costDerivation: 'exact',
    });
    expect(observedTaskEntry(service, entryId)?.modelUsage).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          model: 'claude-opus-4-1',
          inputTokens: 150,
          outputTokens: 30,
          cacheReadInputTokens: 15,
          cacheCreationInputTokens: 7.5,
          webSearchRequests: 1,
          costUsd: 4,
          costBasis: 'managed',
        }),
        expect.objectContaining({
          model: 'claude-haiku-4-5',
          inputTokens: 80,
          outputTokens: 16,
          cacheReadInputTokens: 8,
          cacheCreationInputTokens: 4,
          webSearchRequests: 0,
          costUsd: 1.5,
          costBasis: 'list',
        }),
      ]),
    );
  });

  it('keeps empty-session Claude results as latest direct snapshots outside the ledger', () => {
    const service = makeService();
    const taskKey = 'helper:terminal-worker';
    const entryId = `${taskKey}:entry`;
    service.startObservedTask(
      taskKey,
      makeObservedTaskEntry(entryId, 'chat_summary'),
    );
    const recordResult = jest.spyOn(currentLedger, 'recordResult');
    beginClaudeQueryIfAvailable(service, taskKey);
    observeResult(
      service,
      taskKey,
      claudeResult(
        '',
        2,
        modelTotals({
          inputTokens: 100,
          outputTokens: 20,
          cacheReadInputTokens: 5,
          cacheCreationInputTokens: 2,
          webSearchRequests: 0,
          costUSD: 2,
          costBasis: 'list',
        }),
        {
          input_tokens: 100,
          output_tokens: 20,
          cache_read_input_tokens: 5,
          cache_creation_input_tokens: 2,
        },
      ),
    );
    observeResult(
      service,
      taskKey,
      claudeResult(
        '',
        5,
        modelTotals({
          inputTokens: 180,
          outputTokens: 35,
          cacheReadInputTokens: 12,
          cacheCreationInputTokens: 4,
          webSearchRequests: 1,
          costUSD: 5,
          costBasis: 'list',
        }),
        {
          input_tokens: 180,
          output_tokens: 35,
          cache_read_input_tokens: 12,
          cache_creation_input_tokens: 4,
        },
      ),
    );
    endClaudeQueryIfAvailable(service, taskKey);
    service.finalizeObservedTask(taskKey, 'success');

    expect(recordResult).not.toHaveBeenCalled();
    expect(observedTaskEntry(service, entryId)).toMatchObject({
      totalCostUsd: 5,
      tokens: {
        input: 180,
        output: 35,
        cacheReadInputTokens: 12,
        cacheCreationInputTokens: 4,
      },
    });
    expect(observedTaskEntry(service, entryId)?.costDerivation).toBeUndefined();
  });
});
