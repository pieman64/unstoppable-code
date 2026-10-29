import {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  AGENT_AUDIT_EVENT_TYPES,
  type AgentAuditBillingBasis,
  type AgentAuditEntry,
  type AgentAuditEventType,
} from '@canopy/desktop-shared/types/observability';
import type { OpenAiPricingResponseV1 } from '@canopy/protocol/openai-pricing';
import { runCostHistoryRepair } from '../cost-history-repair';
import type { OpenAiPricingCacheState } from '../../openai-pricing/pricing-client';

const MODEL = 'claude-opus-4-1';
const CODEX_MODEL = 'gpt-test-model';
const REPAIR_DATE = '2026-10-14';
const PRIVATE_TRANSCRIPT_TEXT = 'private prompt that must never be copied';

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

const TEST_PRICING_PAYLOAD: OpenAiPricingResponseV1 = {
  version: 1,
  currency: 'usd',
  tokenUnit: 'per_1m_tokens',
  source: {
    pricingUrl: 'https://example.invalid/api-pricing',
    codexPricingUrl: 'https://example.invalid/codex-pricing',
    codexSpeedUrl: 'https://example.invalid/codex-speed',
    fetchedAt: '2026-10-14T00:00:00.000Z',
    generatedBy: 'cost-history-repair-test',
  },
  cache: { maxAgeSeconds: 3600, staleWhileRevalidateSeconds: 86400 },
  basis: {
    tokenPricing: 'openai_api_standard',
    fastModePricing: 'codex_credit_adjusted_standard_equivalent',
    notes: ['test fixture'],
  },
  serviceTierAliases: { default: 'standard', priority: 'fast' },
  models: {
    [CODEX_MODEL]: {
      model: CODEX_MODEL,
      standard: { input: 10, cachedInput: 1, cacheWriteInput: 20, output: 40 },
    },
  },
  unpricedModels: {},
  billableTools: {},
};

const TEST_PRICING: OpenAiPricingCacheState = {
  payload: TEST_PRICING_PAYLOAD,
  fetchedAt: TEST_PRICING_PAYLOAD.source.fetchedAt,
  loadedFrom: 'memory',
  stale: false,
};

interface RepairFixture {
  root: string;
  auditDir: string;
  transcriptIndexDir: string;
  markerPath: string;
  auditEntriesPath(day: string): string;
  append: (this: void, entry: AgentAuditEntry) => Promise<void>;
  appended: AgentAuditEntry[];
}

interface RepairOverrides {
  append?: (entry: AgentAuditEntry) => void | Promise<void>;
  codexPricing?: () => OpenAiPricingCacheState;
  isCancelled?: () => boolean;
  yieldEvery?: number;
  commit?: () => Promise<void>;
  transcriptPathFor?: (entry: AgentAuditEntry) => string | undefined;
}

let temporaryDirectories: string[];

beforeEach(() => {
  temporaryDirectories = [];
});

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function createFixture(): Promise<RepairFixture> {
  const root = await mkdtemp(
    join(process.env.TMPDIR ?? '/tmp', 'cost-history-repair-'),
  );
  temporaryDirectories.push(root);
  const auditDir = join(root, 'audit');
  const transcriptIndexDir = join(root, 'transcript-index');
  await Promise.all([
    mkdir(auditDir, { recursive: true }),
    mkdir(transcriptIndexDir, { recursive: true }),
  ]);

  const appended: AgentAuditEntry[] = [];
  const auditEntriesPath = (day: string): string =>
    join(auditDir, `${day}.jsonl`);
  const append = async (entry: AgentAuditEntry): Promise<void> => {
    const path = auditEntriesPath(entry.startedAt.slice(0, 10));
    await appendFile(path, `${JSON.stringify(entry)}\n`, 'utf8');
    appended.push(entry);
  };

  return {
    root,
    auditDir,
    transcriptIndexDir,
    markerPath: join(root, 'cost-history-repair-v1.json'),
    auditEntriesPath,
    append,
    appended,
  };
}

function auditEntry(
  id: string,
  startedAt: string,
  overrides: Partial<AgentAuditEntry> = {},
): AgentAuditEntry {
  return {
    id,
    eventType: 'worktree_chat',
    status: 'success',
    provider: 'claude',
    label: `test entry ${id}`,
    startedAt,
    tokens: {
      input: 100,
      output: 20,
      cacheReadInputTokens: 40,
      cacheCreationInputTokens: 10,
    },
    messageCount: 1,
    assistantMessageCount: 1,
    toolUseCount: 0,
    subAgentCount: 0,
    toolCounts: ZERO_TOOL_COUNTS,
    hasTranscript: true,
    ...overrides,
  };
}

interface CumulativeModelUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  webSearchRequests: number;
  costUSD: number;
}

function claudeResultLine(
  sessionId: string,
  totalCostUsd: number,
  usage: CumulativeModelUsage,
): string {
  return claudeResultFrame(sessionId, totalCostUsd, { [MODEL]: usage }, usage);
}

function claudeResultFrame(
  sessionId: string,
  totalCostUsd: number,
  modelUsage: Readonly<Record<string, CumulativeModelUsage>>,
  usage: CumulativeModelUsage,
  extraFields: Readonly<Record<string, unknown>> = {},
): string {
  return JSON.stringify({
    type: 'result',
    session_id: sessionId,
    total_cost_usd: totalCostUsd,
    modelUsage: Object.fromEntries(
      Object.entries(modelUsage).map(([model, totals]) => [
        model,
        { ...totals, costBasis: 'list' },
      ]),
    ),
    usage: {
      input_tokens: usage.inputTokens,
      output_tokens: usage.outputTokens,
      cache_read_input_tokens: usage.cacheReadInputTokens,
      cache_creation_input_tokens: usage.cacheCreationInputTokens,
    },
    ...extraFields,
  });
}

function cumulativeUsage(
  costUSD: number,
  multiplier: number,
): CumulativeModelUsage {
  return {
    inputTokens: multiplier * 100,
    outputTokens: multiplier * 20,
    cacheReadInputTokens: multiplier * 40,
    cacheCreationInputTokens: multiplier * 10,
    webSearchRequests: multiplier,
    costUSD,
  };
}

function transcriptIndexRecord(
  entry: AgentAuditEntry,
  transcriptPath: string,
): {
  version: 1;
  projectId: string;
  worktreeId: string;
  entryId: string;
  eventType: AgentAuditEventType;
  startedAt: string;
  transcriptPath: string;
} {
  return {
    version: 1,
    projectId: 'fixture-project',
    worktreeId: 'fixture-worktree',
    entryId: entry.id,
    eventType: entry.eventType,
    startedAt: entry.startedAt,
    transcriptPath,
  };
}

async function writeAuditLines(
  fixture: RepairFixture,
  day: string,
  lines: readonly string[],
): Promise<void> {
  await writeFile(
    fixture.auditEntriesPath(day),
    `${lines.join('\n')}\n`,
    'utf8',
  );
}

async function writeAuditEntries(
  fixture: RepairFixture,
  entries: readonly AgentAuditEntry[],
): Promise<void> {
  const entriesByDay = new Map<string, AgentAuditEntry[]>();
  for (const entry of entries) {
    const day = entry.startedAt.slice(0, 10);
    const dayEntries = entriesByDay.get(day) ?? [];
    dayEntries.push(entry);
    entriesByDay.set(day, dayEntries);
  }
  await Promise.all(
    Array.from(entriesByDay.entries()).map(([day, dayEntries]) =>
      writeAuditLines(
        fixture,
        day,
        dayEntries.map((entry) => JSON.stringify(entry)),
      ),
    ),
  );
}

async function writeTranscript(
  fixture: RepairFixture,
  entry: AgentAuditEntry,
  lines: readonly string[],
): Promise<string> {
  const transcriptPath = join(fixture.root, 'transcripts', `${entry.id}.jsonl`);
  await mkdir(dirname(transcriptPath), { recursive: true });
  await writeFile(transcriptPath, `${lines.join('\n')}\n`, 'utf8');
  // Production never indexes global chats; the repair derives their path.
  if (
    entry.eventType === 'standalone_chat' ||
    entry.eventType === 'app_advisor'
  )
    return transcriptPath;
  const day = entry.startedAt.slice(0, 10);
  const indexPath = join(fixture.transcriptIndexDir, `${day}.jsonl`);
  await appendFile(
    indexPath,
    `${JSON.stringify(transcriptIndexRecord(entry, transcriptPath))}\n`,
    'utf8',
  );
  return transcriptPath;
}

function runRepair(
  fixture: RepairFixture,
  overrides: RepairOverrides = {},
): ReturnType<typeof runCostHistoryRepair> {
  return runCostHistoryRepair({
    auditDir: fixture.auditDir,
    transcriptIndexDir: fixture.transcriptIndexDir,
    markerPath: fixture.markerPath,
    codexPricing:
      overrides.codexPricing ?? ((): OpenAiPricingCacheState => TEST_PRICING),
    append: overrides.append ?? fixture.append,
    transcriptPathFor:
      overrides.transcriptPathFor ??
      ((entry): string | undefined =>
        entry.hasTranscript === true
          ? join(fixture.root, 'transcripts', `${entry.id}.jsonl`)
          : undefined),
    ...(overrides.commit === undefined ? {} : { commit: overrides.commit }),
    ...(overrides.isCancelled === undefined
      ? {}
      : { isCancelled: overrides.isCancelled }),
    ...(overrides.yieldEvery === undefined
      ? {}
      : { yieldEvery: overrides.yieldEvery }),
  });
}

async function readJsonLines(path: string): Promise<unknown[]> {
  const content = await readFile(path, 'utf8');
  const values: unknown[] = [];
  for (const line of content.split('\n')) {
    if (line.length === 0) continue;
    values.push(JSON.parse(line));
  }
  return values;
}

describe('runCostHistoryRepair', () => {
  it('repairs cumulative Claude totals across indexed chat, pipeline-step and advisor entries', async () => {
    const fixture = await createFixture();
    const entries = [
      auditEntry('chat-1', `${REPAIR_DATE}T23:58:00.000Z`, {
        totalCostUsd: 1.12,
        eventType: 'worktree_chat',
      }),
      auditEntry('step-2', '2026-10-15T00:02:00.000Z', {
        totalCostUsd: 11.28,
        eventType: 'pipeline_agent_turn',
      }),
      auditEntry('advisor-3', '2026-10-15T00:03:00.000Z', {
        totalCostUsd: 22.24,
        eventType: 'pipeline_advisor',
      }),
    ];
    await writeAuditEntries(fixture, entries);
    const modelUsage: CumulativeModelUsage[] = [
      {
        inputTokens: 100,
        outputTokens: 20,
        cacheReadInputTokens: 40,
        cacheCreationInputTokens: 10,
        webSearchRequests: 1,
        costUSD: 1.12,
      },
      {
        inputTokens: 1100,
        outputTokens: 220,
        cacheReadInputTokens: 440,
        cacheCreationInputTokens: 110,
        webSearchRequests: 3,
        costUSD: 11.28,
      },
      {
        inputTokens: 2100,
        outputTokens: 420,
        cacheReadInputTokens: 840,
        cacheCreationInputTokens: 210,
        webSearchRequests: 4,
        costUSD: 22.24,
      },
    ];
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index];
      const usage = modelUsage[index];
      if (entry === undefined || usage === undefined) continue;
      await writeTranscript(fixture, entry, [
        JSON.stringify({
          type: 'assistant',
          message: {
            content: [{ type: 'text', text: PRIVATE_TRANSCRIPT_TEXT }],
          },
        }),
        claudeResultLine('shared-session', usage.costUSD, usage),
      ]);
    }

    const result = await runRepair(fixture);

    expect(result).toEqual({
      claudeRepaired: 2,
      claudeSkippedNoTranscript: 0,
      codexDelegationsPriced: 0,
      skipped: false,
    });
    expect(fixture.appended.map((entry) => entry.id)).toEqual([
      'step-2',
      'advisor-3',
    ]);
    expect(fixture.appended[0]).toMatchObject({
      id: 'step-2',
      totalCostUsd: 10.16,
      sdkCumulativeCostUsd: 11.28,
      costDerivation: 'exact',
      costRepair: { version: 1, previousTotalCostUsd: 11.28 },
      modelUsage: [
        {
          model: MODEL,
          inputTokens: 1000,
          outputTokens: 200,
          cacheReadInputTokens: 400,
          cacheCreationInputTokens: 100,
          webSearchRequests: 2,
          costUsd: 10.16,
          costBasis: 'list',
        },
      ],
    });
    expect(fixture.appended[1]).toMatchObject({
      id: 'advisor-3',
      totalCostUsd: 10.96,
      sdkCumulativeCostUsd: 22.24,
      costRepair: { version: 1, previousTotalCostUsd: 22.24 },
    });

    const firstDay = await readJsonLines(fixture.auditEntriesPath(REPAIR_DATE));
    const firstDayEntry = firstDay[0];
    expect(firstDayEntry).toEqual(entries[0]);
    const auditText = [
      await readFile(fixture.auditEntriesPath(REPAIR_DATE), 'utf8'),
      await readFile(fixture.auditEntriesPath('2026-10-15'), 'utf8'),
    ].join('\n');
    expect(auditText).not.toContain(PRIVATE_TRANSCRIPT_TEXT);
    expect(await readFile(fixture.markerPath, 'utf8')).toMatch(
      /"version"\s*:\s*1/,
    );

    const skippedRun = await runRepair(fixture);
    expect(skippedRun).toEqual({
      claudeRepaired: 0,
      claudeSkippedNoTranscript: 0,
      codexDelegationsPriced: 0,
      skipped: true,
    });
    expect(fixture.appended).toHaveLength(2);

    await rm(fixture.markerPath, { force: true });
    const replayedRun = await runRepair(fixture);
    expect(replayedRun).toEqual({
      claudeRepaired: 0,
      claudeSkippedNoTranscript: 0,
      codexDelegationsPriced: 0,
      skipped: false,
    });
    expect(fixture.appended).toHaveLength(2);
  });

  it('repairs every eligible Claude event type', async () => {
    const fixture = await createFixture();
    const eligibleTypes: readonly AgentAuditEventType[] = [
      'worktree_chat',
      'standalone_chat',
      'app_advisor',
      'worktree_plan_chat',
      'pipeline_agent_turn',
      'pipeline_advisor',
    ];
    const entries: AgentAuditEntry[] = [];
    const sessionIds: string[] = [];
    for (let index = 0; index < eligibleTypes.length; index += 1) {
      const eventType = eligibleTypes[index];
      if (eventType === undefined) continue;
      const id = `eligible-${eventType}`;
      const startedAt = new Date(
        Date.parse(`${REPAIR_DATE}T18:00:00.000Z`) + index * 60_000,
      ).toISOString();
      const baseline = auditEntry(`${id}-baseline`, startedAt, {
        totalCostUsd: 1.12,
        eventType: 'worktree_chat',
      });
      const candidate = auditEntry(
        id,
        new Date(Date.parse(startedAt) + 30_000).toISOString(),
        { totalCostUsd: 11.28, eventType },
      );
      entries.push(baseline, candidate);
      sessionIds.push(`${id}-session`, `${id}-session`);
    }
    await writeAuditEntries(fixture, entries);
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index];
      const sessionId = sessionIds[index];
      if (entry === undefined || sessionId === undefined) continue;
      const usage =
        index % 2 === 0 ? cumulativeUsage(1.12, 1) : cumulativeUsage(11.28, 11);
      await writeTranscript(fixture, entry, [
        claudeResultLine(sessionId, usage.costUSD, usage),
      ]);
    }

    const result = await runRepair(fixture);

    expect(result).toEqual({
      claudeRepaired: eligibleTypes.length,
      claudeSkippedNoTranscript: 0,
      codexDelegationsPriced: 0,
      skipped: false,
    });
    expect(fixture.appended.map((entry) => entry.eventType)).toEqual(
      eligibleTypes,
    );
    expect(fixture.appended.map((entry) => entry.totalCostUsd)).toEqual(
      Array.from({ length: eligibleTypes.length }, () => 10.16),
    );
  });

  it('skips every Claude event type outside the eligible set', async () => {
    const fixture = await createFixture();
    const eligibleTypes = new Set<AgentAuditEventType>([
      'worktree_chat',
      'standalone_chat',
      'app_advisor',
      'worktree_plan_chat',
      'pipeline_agent_turn',
      'pipeline_advisor',
    ]);
    const excludedEntries = AGENT_AUDIT_EVENT_TYPES.filter(
      (eventType) => !eligibleTypes.has(eventType),
    ).map((eventType) =>
      auditEntry(`excluded-${eventType}`, `${REPAIR_DATE}T18:30:00.000Z`, {
        eventType,
        totalCostUsd: 12.28,
        hasTranscript: false,
      }),
    );
    await writeAuditEntries(fixture, excludedEntries);

    const result = await runRepair(fixture);

    expect(result).toEqual({
      claudeRepaired: 0,
      claudeSkippedNoTranscript: 0,
      codexDelegationsPriced: 0,
      skipped: false,
    });
    expect(fixture.appended).toEqual([]);
  });

  it('repairs all eligible billing bases and skips org_gateway/local for Claude and Codex', async () => {
    const fixture = await createFixture();
    const eligibleBases: readonly (AgentAuditBillingBasis | undefined)[] = [
      undefined,
      'unknown',
      'subscription',
      'ai_credits',
      'account_proxy',
      'api_key',
    ];
    const entries: AgentAuditEntry[] = [];
    const transcripts: Array<{
      entry: AgentAuditEntry;
      sessionId: string;
      usage: CumulativeModelUsage;
    }> = [];
    for (let index = 0; index < eligibleBases.length; index += 1) {
      const billingBasis = eligibleBases[index];
      const id = `eligible-billing-${index}`;
      const sessionId = `${id}-session`;
      const baselineOverrides: Partial<AgentAuditEntry> = {
        totalCostUsd: 1.12,
      };
      const candidateOverrides: Partial<AgentAuditEntry> = {
        totalCostUsd: 11.28,
      };
      if (billingBasis !== undefined) {
        baselineOverrides.billingBasis = billingBasis;
        candidateOverrides.billingBasis = billingBasis;
      }
      const baseline = auditEntry(
        `${id}-baseline`,
        `${REPAIR_DATE}T19:00:00.000Z`,
        baselineOverrides,
      );
      const candidate = auditEntry(
        `${id}-candidate`,
        `${REPAIR_DATE}T19:01:00.000Z`,
        candidateOverrides,
      );
      entries.push(baseline, candidate);
      transcripts.push(
        { entry: baseline, sessionId, usage: cumulativeUsage(1.12, 1) },
        { entry: candidate, sessionId, usage: cumulativeUsage(11.28, 11) },
      );
    }
    for (const billingBasis of ['org_gateway', 'local'] as const) {
      const id = `excluded-billing-${billingBasis}`;
      const sessionId = `${id}-session`;
      const baseline = auditEntry(
        `${id}-baseline`,
        `${REPAIR_DATE}T20:00:00.000Z`,
        {
          totalCostUsd: 1.12,
          billingBasis,
        },
      );
      const candidate = auditEntry(
        `${id}-candidate`,
        `${REPAIR_DATE}T20:01:00.000Z`,
        {
          totalCostUsd: 11.28,
          billingBasis,
        },
      );
      entries.push(baseline, candidate);
      transcripts.push(
        { entry: baseline, sessionId, usage: cumulativeUsage(1.12, 1) },
        { entry: candidate, sessionId, usage: cumulativeUsage(11.28, 11) },
      );
      entries.push(
        auditEntry(`${id}-codex`, `${REPAIR_DATE}T20:02:00.000Z`, {
          eventType: 'managed_delegation',
          provider: 'codex',
          model: CODEX_MODEL,
          billingBasis,
          hasTranscript: false,
        }),
      );
    }
    await writeAuditEntries(fixture, entries);
    for (const transcript of transcripts) {
      await writeTranscript(fixture, transcript.entry, [
        claudeResultLine(
          transcript.sessionId,
          transcript.usage.costUSD,
          transcript.usage,
        ),
      ]);
    }

    const result = await runRepair(fixture);

    expect(result).toEqual({
      claudeRepaired: eligibleBases.length,
      claudeSkippedNoTranscript: 0,
      codexDelegationsPriced: 0,
      skipped: false,
    });
    expect(fixture.appended.map((entry) => entry.id)).toEqual(
      eligibleBases.map(
        (_billingBasis, index) => `eligible-billing-${index}-candidate`,
      ),
    );
  });

  it('leaves already-correct Claude totals within the five-mill tolerance unchanged', async () => {
    const fixture = await createFixture();
    const baseline = auditEntry(
      'tolerance-baseline',
      `${REPAIR_DATE}T21:00:00.000Z`,
      {
        totalCostUsd: 1.12,
      },
    );
    const candidate = auditEntry(
      'tolerance-candidate',
      `${REPAIR_DATE}T21:01:00.000Z`,
      {
        totalCostUsd: 10.164,
      },
    );
    await writeAuditEntries(fixture, [baseline, candidate]);
    await writeTranscript(fixture, baseline, [
      claudeResultLine('tolerance-session', 1.12, cumulativeUsage(1.12, 1)),
    ]);
    await writeTranscript(fixture, candidate, [
      claudeResultLine('tolerance-session', 11.28, cumulativeUsage(11.28, 11)),
    ]);

    const result = await runRepair(fixture);

    expect(result).toEqual({
      claudeRepaired: 0,
      claudeSkippedNoTranscript: 0,
      codexDelegationsPriced: 0,
      skipped: false,
    });
    expect(fixture.appended).toEqual([]);
    expect(await readJsonLines(fixture.auditEntriesPath(REPAIR_DATE))).toEqual([
      baseline,
      candidate,
    ]);
  });

  it('replays a repaired middle audit line as the cumulative baseline on retry', async () => {
    const fixture = await createFixture();
    const first = auditEntry('chat-1', `${REPAIR_DATE}T23:59:00.000Z`, {
      totalCostUsd: 1.12,
      eventType: 'worktree_chat',
    });
    const repairedMiddle = auditEntry('step-2', '2026-10-15T00:01:00.000Z', {
      totalCostUsd: 10.16,
      sdkCumulativeCostUsd: 11.28,
      costDerivation: 'exact',
      costRepair: { version: 2, previousTotalCostUsd: 11.28 },
      modelUsage: [
        {
          model: MODEL,
          inputTokens: 1000,
          outputTokens: 200,
          cacheReadInputTokens: 400,
          cacheCreationInputTokens: 100,
          webSearchRequests: 2,
          costUsd: 10.16,
          costBasis: 'list',
        },
      ],
      eventType: 'pipeline_agent_turn',
    });
    const third = auditEntry('advisor-3', '2026-10-15T00:02:00.000Z', {
      totalCostUsd: 22.24,
      eventType: 'pipeline_advisor',
    });
    await writeAuditEntries(fixture, [first, repairedMiddle, third]);
    const results = [
      {
        inputTokens: 100,
        outputTokens: 20,
        cacheReadInputTokens: 40,
        cacheCreationInputTokens: 10,
        webSearchRequests: 1,
        costUSD: 1.12,
      },
      {
        inputTokens: 1100,
        outputTokens: 220,
        cacheReadInputTokens: 440,
        cacheCreationInputTokens: 110,
        webSearchRequests: 3,
        costUSD: 11.28,
      },
      {
        inputTokens: 2100,
        outputTokens: 420,
        cacheReadInputTokens: 840,
        cacheCreationInputTokens: 210,
        webSearchRequests: 4,
        costUSD: 22.24,
      },
    ];
    const replayEntries = [first, repairedMiddle, third];
    for (let index = 0; index < replayEntries.length; index += 1) {
      const entry = replayEntries[index];
      const usage = results[index];
      if (entry === undefined || usage === undefined) continue;
      await writeTranscript(fixture, entry, [
        claudeResultLine('shared-session', usage.costUSD, usage),
      ]);
    }

    const result = await runRepair(fixture);

    expect(result).toEqual({
      claudeRepaired: 1,
      claudeSkippedNoTranscript: 0,
      codexDelegationsPriced: 0,
      skipped: false,
    });
    expect(fixture.appended).toHaveLength(1);
    expect(fixture.appended[0]).toMatchObject({
      id: 'advisor-3',
      totalCostUsd: 10.96,
      sdkCumulativeCostUsd: 22.24,
    });
    expect(fixture.appended[0]?.totalCostUsd).not.toBe(21.12);
  });

  it('uses a conversation reset as a zero cost baseline', async () => {
    const fixture = await createFixture();
    const beforeReset = auditEntry(
      'before-reset',
      `${REPAIR_DATE}T10:00:00.000Z`,
      {
        totalCostUsd: 10,
      },
    );
    const afterReset = auditEntry(
      'after-reset',
      `${REPAIR_DATE}T10:01:00.000Z`,
      {
        totalCostUsd: 13,
        eventType: 'pipeline_agent_turn',
      },
    );
    await writeAuditEntries(fixture, [beforeReset, afterReset]);
    await writeTranscript(fixture, beforeReset, [
      claudeResultLine('same-session', 10, {
        inputTokens: 1000,
        outputTokens: 100,
        cacheReadInputTokens: 200,
        cacheCreationInputTokens: 50,
        webSearchRequests: 1,
        costUSD: 10,
      }),
    ]);
    await writeTranscript(fixture, afterReset, [
      JSON.stringify({
        type: 'conversation_reset',
        new_conversation_id: 'fresh-session',
        session_id: 'same-session',
      }),
      claudeResultLine('same-session', 3, {
        inputTokens: 300,
        outputTokens: 30,
        cacheReadInputTokens: 60,
        cacheCreationInputTokens: 15,
        webSearchRequests: 0,
        costUSD: 3,
      }),
    ]);

    const result = await runRepair(fixture);

    expect(result.claudeRepaired).toBe(1);
    expect(fixture.appended[0]).toMatchObject({
      id: 'after-reset',
      totalCostUsd: 3,
      sdkCumulativeCostUsd: 3,
    });
  });

  it('seeds the first result in a new session after a reset without repairing it', async () => {
    const fixture = await createFixture();
    const beforeReset = auditEntry(
      'before-session-reset',
      `${REPAIR_DATE}T10:30:00.000Z`,
      { totalCostUsd: 10 },
    );
    const firstNewSessionResult = auditEntry(
      'first-new-session-result',
      `${REPAIR_DATE}T10:31:00.000Z`,
      { totalCostUsd: 13, eventType: 'pipeline_agent_turn' },
    );
    await writeAuditEntries(fixture, [beforeReset, firstNewSessionResult]);
    await writeTranscript(fixture, beforeReset, [
      claudeResultLine('old-session', 10, cumulativeUsage(10, 10)),
    ]);
    await writeTranscript(fixture, firstNewSessionResult, [
      JSON.stringify({
        type: 'conversation_reset',
        new_conversation_id: 'new-session',
        session_id: 'old-session',
      }),
      claudeResultLine('new-session', 3, cumulativeUsage(3, 3)),
    ]);

    const result = await runRepair(fixture);

    expect(result).toEqual({
      claudeRepaired: 0,
      claudeSkippedNoTranscript: 0,
      codexDelegationsPriced: 0,
      skipped: false,
    });
    expect(fixture.appended).toEqual([]);
    expect(await readJsonLines(fixture.auditEntriesPath(REPAIR_DATE))).toEqual([
      beforeReset,
      firstNewSessionResult,
    ]);
  });

  it('sums multiple result-frame deltas and merges per-model deltas across a reset', async () => {
    const fixture = await createFixture();
    const baseline = auditEntry(
      'multi-result-baseline',
      `${REPAIR_DATE}T10:00:00.000Z`,
      { totalCostUsd: 1.12 },
    );
    const candidate = auditEntry(
      'multi-result-turn',
      `${REPAIR_DATE}T10:01:00.000Z`,
      { totalCostUsd: 20, eventType: 'standalone_chat' },
    );
    await writeAuditEntries(fixture, [baseline, candidate]);
    await writeTranscript(fixture, baseline, [
      claudeResultLine('old-session', 1.12, cumulativeUsage(1.12, 1)),
    ]);
    await writeTranscript(fixture, candidate, [
      '{malformed transcript frame',
      claudeResultFrame(
        'old-session',
        2.24,
        { [MODEL]: cumulativeUsage(2.24, 2) },
        cumulativeUsage(2.24, 2),
      ),
      JSON.stringify({
        type: 'conversation_reset',
        new_conversation_id: 'new-session',
        session_id: 'old-session',
      }),
      claudeResultFrame(
        'new-session',
        3.5,
        { 'claude-haiku-4-5': cumulativeUsage(3.5, 5) },
        cumulativeUsage(3.5, 5),
      ),
      claudeResultFrame(
        'new-session',
        4.5,
        {
          'claude-haiku-4-5': cumulativeUsage(4.25, 6),
          'claude-sonnet-4-5': cumulativeUsage(0.25, 1),
        },
        cumulativeUsage(4.5, 5),
      ),
    ]);

    const result = await runRepair(fixture);

    expect(result.claudeRepaired).toBe(1);
    expect(fixture.appended[0]).toMatchObject({
      id: 'multi-result-turn',
      totalCostUsd: 5.62,
      costDerivation: 'exact',
    });
    expect(fixture.appended[0]?.modelUsage).toMatchObject([
      {
        model: MODEL,
        inputTokens: 100,
        outputTokens: 20,
        cacheReadInputTokens: 40,
        cacheCreationInputTokens: 10,
        webSearchRequests: 1,
        costUsd: 1.12,
        costBasis: 'list',
      },
      {
        model: 'claude-haiku-4-5',
        inputTokens: 600,
        outputTokens: 120,
        cacheReadInputTokens: 240,
        cacheCreationInputTokens: 60,
        webSearchRequests: 6,
        costUsd: 4.25,
        costBasis: 'list',
      },
      {
        model: 'claude-sonnet-4-5',
        inputTokens: 100,
        outputTokens: 20,
        cacheReadInputTokens: 40,
        cacheCreationInputTokens: 10,
        webSearchRequests: 1,
        costUsd: 0.25,
        costBasis: 'list',
      },
    ]);
  });

  it('counts Claude audit entries without a transcript and leaves them untouched', async () => {
    const fixture = await createFixture();
    const missingTranscript = auditEntry(
      'missing-transcript',
      `${REPAIR_DATE}T12:00:00.000Z`,
      { totalCostUsd: 123.45, hasTranscript: false },
    );
    await writeAuditEntries(fixture, [missingTranscript]);

    const result = await runRepair(fixture);

    expect(result).toEqual({
      claudeRepaired: 0,
      claudeSkippedNoTranscript: 1,
      codexDelegationsPriced: 0,
      skipped: false,
    });
    expect(fixture.appended).toEqual([]);
    expect(await readJsonLines(fixture.auditEntriesPath(REPAIR_DATE))).toEqual([
      missingTranscript,
    ]);
  });

  it('counts a missing transcript file referenced by the transcript index', async () => {
    const fixture = await createFixture();
    const entry = auditEntry(
      'missing-indexed-file',
      `${REPAIR_DATE}T12:30:00.000Z`,
      {
        totalCostUsd: 123.45,
        hasTranscript: true,
      },
    );
    await writeAuditEntries(fixture, [entry]);
    await writeFile(
      join(fixture.transcriptIndexDir, `${REPAIR_DATE}.jsonl`),
      `${JSON.stringify(
        transcriptIndexRecord(
          entry,
          join(fixture.root, 'transcripts', 'missing-file.jsonl'),
        ),
      )}\n`,
      'utf8',
    );

    const result = await runRepair(fixture);

    expect(result).toEqual({
      claudeRepaired: 0,
      claudeSkippedNoTranscript: 1,
      codexDelegationsPriced: 0,
      skipped: false,
    });
    expect(fixture.appended).toEqual([]);
    expect(await readJsonLines(fixture.auditEntriesPath(REPAIR_DATE))).toEqual([
      entry,
    ]);
  });

  it('prices Codex managed delegations from supplied pricing and the default tier', async () => {
    const fixture = await createFixture();
    const codexDelegation = auditEntry(
      'codex-delegation',
      `${REPAIR_DATE}T13:00:00.000Z`,
      {
        eventType: 'managed_delegation',
        provider: 'codex',
        model: CODEX_MODEL,
        hasTranscript: false,
        tokens: {
          input: 1000,
          output: 200,
          cacheReadInputTokens: 400,
          cacheCreationInputTokens: 100,
        },
      },
    );
    await writeAuditEntries(fixture, [codexDelegation]);

    const result = await runRepair(fixture, {
      codexPricing: () => TEST_PRICING,
    });

    expect(result).toEqual({
      claudeRepaired: 0,
      claudeSkippedNoTranscript: 0,
      codexDelegationsPriced: 1,
      skipped: false,
    });
    expect(fixture.appended[0]).toMatchObject({
      id: 'codex-delegation',
      totalCostUsd: 0.0154,
      observedCost: {
        status: 'priced',
        totalUsd: 0.0154,
        tokenUsd: 0.0154,
        canonicalServiceTier: 'standard',
        pricingBasis: 'openai_api_standard',
      },
      costRepair: { version: 1 },
    });
  });

  it('does not reprice Codex delegations that already have a cost field', async () => {
    const fixture = await createFixture();
    const hasTotalCost = auditEntry(
      'codex-has-total-cost',
      `${REPAIR_DATE}T13:15:00.000Z`,
      {
        eventType: 'managed_delegation',
        provider: 'codex',
        model: CODEX_MODEL,
        totalCostUsd: 0.25,
        hasTranscript: false,
      },
    );
    const hasObservedCost = auditEntry(
      'codex-has-observed-cost',
      `${REPAIR_DATE}T13:16:00.000Z`,
      {
        eventType: 'managed_delegation',
        provider: 'codex',
        model: CODEX_MODEL,
        observedCost: {
          status: 'unpriced',
          reason: 'pricing_unavailable',
          currency: 'usd',
          components: [],
        },
        hasTranscript: false,
      },
    );
    await writeAuditEntries(fixture, [hasTotalCost, hasObservedCost]);

    const result = await runRepair(fixture);

    expect(result).toEqual({
      claudeRepaired: 0,
      claudeSkippedNoTranscript: 0,
      codexDelegationsPriced: 0,
      skipped: false,
    });
    expect(fixture.appended).toEqual([]);
  });

  it('does not append zero-token Codex delegations', async () => {
    const fixture = await createFixture();
    const zeroTokenDelegation = auditEntry(
      'codex-zero-token-delegation',
      `${REPAIR_DATE}T13:20:00.000Z`,
      {
        eventType: 'managed_delegation',
        provider: 'codex',
        model: CODEX_MODEL,
        hasTranscript: false,
        tokens: {
          input: 0,
          output: 0,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
        },
      },
    );
    await writeAuditEntries(fixture, [zeroTokenDelegation]);

    const result = await runRepair(fixture);

    expect(result).toEqual({
      claudeRepaired: 0,
      claudeSkippedNoTranscript: 0,
      codexDelegationsPriced: 0,
      skipped: false,
    });
    expect(fixture.appended).toEqual([]);
  });

  it('does not count an already repaired Claude entry without a transcript as missing', async () => {
    const fixture = await createFixture();
    const repairedWithoutTranscript = auditEntry(
      'repaired-without-transcript',
      `${REPAIR_DATE}T13:25:00.000Z`,
      {
        totalCostUsd: 1.12,
        costRepair: { version: 1, previousTotalCostUsd: 1.12 },
        hasTranscript: false,
      },
    );
    await writeAuditEntries(fixture, [repairedWithoutTranscript]);

    const result = await runRepair(fixture);

    expect(result).toEqual({
      claudeRepaired: 0,
      claudeSkippedNoTranscript: 0,
      codexDelegationsPriced: 0,
      skipped: false,
    });
    expect(fixture.appended).toEqual([]);
  });

  it('reruns when the marker is invalid and skips when a higher marker version exists', async () => {
    const fixture = await createFixture();
    const baseline = auditEntry(
      'invalid-marker-baseline',
      `${REPAIR_DATE}T13:30:00.000Z`,
      {
        totalCostUsd: 1.12,
      },
    );
    const candidate = auditEntry(
      'invalid-marker-candidate',
      `${REPAIR_DATE}T13:31:00.000Z`,
      {
        totalCostUsd: 12.28,
      },
    );
    await writeAuditEntries(fixture, [baseline, candidate]);
    await writeTranscript(fixture, baseline, [
      claudeResultLine(
        'invalid-marker-session',
        1.12,
        cumulativeUsage(1.12, 1),
      ),
    ]);
    await writeTranscript(fixture, candidate, [
      claudeResultLine(
        'invalid-marker-session',
        11.28,
        cumulativeUsage(11.28, 11),
      ),
    ]);
    await writeFile(fixture.markerPath, '{invalid marker', 'utf8');

    const repaired = await runRepair(fixture);

    expect(repaired).toMatchObject({
      claudeRepaired: 1,
      skipped: false,
    });
    expect(await readFile(fixture.markerPath, 'utf8')).toMatch(
      /"version"\s*:\s*1/,
    );

    await writeFile(fixture.markerPath, JSON.stringify({ version: 2 }), 'utf8');
    const higherVersion = await runRepair(fixture);

    expect(higherVersion).toEqual({
      claudeRepaired: 0,
      claudeSkippedNoTranscript: 0,
      codexDelegationsPriced: 0,
      skipped: true,
    });
    expect(fixture.appended).toHaveLength(1);
  });

  it('uses the last existing audit line for a duplicate entry id', async () => {
    const fixture = await createFixture();
    const first = auditEntry('chat-1', `${REPAIR_DATE}T14:00:00.000Z`, {
      totalCostUsd: 1.12,
    });
    const earlierDuplicate = auditEntry(
      'step-2',
      `${REPAIR_DATE}T14:01:00.000Z`,
      {
        totalCostUsd: 12.28,
        label: 'earlier duplicate line',
        eventType: 'pipeline_agent_turn',
      },
    );
    const lastDuplicate = auditEntry('step-2', `${REPAIR_DATE}T14:01:00.000Z`, {
      totalCostUsd: 11.28,
      label: 'last duplicate line',
      eventType: 'pipeline_agent_turn',
    });
    await writeAuditLines(fixture, REPAIR_DATE, [
      JSON.stringify(first),
      JSON.stringify(earlierDuplicate),
      JSON.stringify(lastDuplicate),
    ]);
    await writeTranscript(fixture, first, [
      claudeResultLine('duplicate-session', 1.12, {
        inputTokens: 100,
        outputTokens: 20,
        cacheReadInputTokens: 40,
        cacheCreationInputTokens: 10,
        webSearchRequests: 1,
        costUSD: 1.12,
      }),
    ]);
    await writeTranscript(fixture, lastDuplicate, [
      claudeResultLine('duplicate-session', 11.28, {
        inputTokens: 1100,
        outputTokens: 220,
        cacheReadInputTokens: 440,
        cacheCreationInputTokens: 110,
        webSearchRequests: 3,
        costUSD: 11.28,
      }),
    ]);

    await runRepair(fixture);

    expect(fixture.appended).toHaveLength(1);
    expect(fixture.appended[0]).toMatchObject({
      id: 'step-2',
      label: 'last duplicate line',
      totalCostUsd: 10.16,
      costRepair: { version: 1, previousTotalCostUsd: 11.28 },
    });
  });

  it('skips malformed and oversized audit lines without blocking valid repairs', async () => {
    const fixture = await createFixture();
    const tooLargeToProcess = auditEntry(
      'oversized-no-transcript',
      `${REPAIR_DATE}T15:00:00.000Z`,
      {
        totalCostUsd: 5,
        hasTranscript: false,
        label: 'x'.repeat(9 * 1024 * 1024),
      },
    );
    const baseline = auditEntry(
      'audit-baseline',
      `${REPAIR_DATE}T14:59:00.000Z`,
      {
        totalCostUsd: 1.12,
      },
    );
    const repairable = auditEntry(
      'repairable',
      `${REPAIR_DATE}T15:01:00.000Z`,
      {
        totalCostUsd: 12.28,
      },
    );
    await writeAuditLines(fixture, REPAIR_DATE, [
      '{invalid JSON',
      JSON.stringify(baseline),
      JSON.stringify(tooLargeToProcess),
      JSON.stringify(repairable),
    ]);
    await writeTranscript(fixture, baseline, [
      claudeResultLine('repairable-session', 1.12, cumulativeUsage(1.12, 1)),
    ]);
    await writeTranscript(fixture, repairable, [
      claudeResultLine('repairable-session', 11.28, cumulativeUsage(11.28, 11)),
    ]);

    const result = await runRepair(fixture);

    expect(result).toEqual({
      claudeRepaired: 1,
      claudeSkippedNoTranscript: 0,
      codexDelegationsPriced: 0,
      skipped: false,
    });
    expect(fixture.appended[0]).toMatchObject({
      id: 'repairable',
      totalCostUsd: 10.16,
    });
  });

  it('ignores malformed and oversized transcript-index lines', async () => {
    const fixture = await createFixture();
    const baseline = auditEntry(
      'index-baseline',
      `${REPAIR_DATE}T15:30:00.000Z`,
      {
        totalCostUsd: 1.12,
      },
    );
    const candidate = auditEntry(
      'index-candidate',
      `${REPAIR_DATE}T15:31:00.000Z`,
      {
        totalCostUsd: 12.28,
      },
    );
    await writeAuditEntries(fixture, [baseline, candidate]);
    const baselinePath = await writeTranscript(fixture, baseline, [
      claudeResultLine('index-session', 1.12, cumulativeUsage(1.12, 1)),
    ]);
    const candidatePath = await writeTranscript(fixture, candidate, [
      claudeResultLine('index-session', 11.28, cumulativeUsage(11.28, 11)),
    ]);
    const oversizedIndexRecord = {
      ...transcriptIndexRecord(candidate, candidatePath),
      padding: 'x'.repeat(9 * 1024 * 1024),
    };
    await writeFile(
      join(fixture.transcriptIndexDir, `${REPAIR_DATE}.jsonl`),
      [
        JSON.stringify(transcriptIndexRecord(baseline, baselinePath)),
        '{malformed index record',
        JSON.stringify(oversizedIndexRecord),
      ].join('\n') + '\n',
      'utf8',
    );

    const result = await runRepair(fixture, {
      transcriptPathFor: () => undefined,
    });

    expect(result).toEqual({
      claudeRepaired: 0,
      claudeSkippedNoTranscript: 1,
      codexDelegationsPriced: 0,
      skipped: false,
    });
    expect(fixture.appended).toEqual([]);
  });

  it('ignores oversized transcript frames while preserving the indexed audit entry', async () => {
    const fixture = await createFixture();
    const baseline = auditEntry(
      'transcript-baseline',
      `${REPAIR_DATE}T15:45:00.000Z`,
      {
        totalCostUsd: 1.12,
      },
    );
    const candidate = auditEntry(
      'transcript-candidate',
      `${REPAIR_DATE}T15:46:00.000Z`,
      {
        totalCostUsd: 12.28,
      },
    );
    await writeAuditEntries(fixture, [baseline, candidate]);
    await writeTranscript(fixture, baseline, [
      claudeResultLine('transcript-session', 1.12, cumulativeUsage(1.12, 1)),
    ]);
    const candidatePath = await writeTranscript(fixture, candidate, [
      claudeResultLine('transcript-session', 11.28, cumulativeUsage(11.28, 11)),
    ]);
    await writeFile(
      candidatePath,
      `${claudeResultFrame(
        'transcript-session',
        11.28,
        { [MODEL]: cumulativeUsage(11.28, 11) },
        cumulativeUsage(11.28, 11),
        { padding: 'x'.repeat(9 * 1024 * 1024) },
      )}\n`,
      'utf8',
    );

    const result = await runRepair(fixture);

    expect(result).toEqual({
      claudeRepaired: 0,
      claudeSkippedNoTranscript: 1,
      codexDelegationsPriced: 0,
      skipped: false,
    });
    expect(fixture.appended).toEqual([]);
  });

  it('does not write the marker when cancelled', async () => {
    const fixture = await createFixture();
    const baseline = auditEntry(
      'cancelled-baseline',
      `${REPAIR_DATE}T16:00:00.000Z`,
      { totalCostUsd: 1.12 },
    );
    const entry = auditEntry(
      'cancelled-entry',
      `${REPAIR_DATE}T16:01:00.000Z`,
      {
        totalCostUsd: 11.28,
      },
    );
    await writeAuditEntries(fixture, [baseline, entry]);
    await writeTranscript(fixture, baseline, [
      claudeResultLine('cancelled-session', 1.12, {
        inputTokens: 100,
        outputTokens: 20,
        cacheReadInputTokens: 40,
        cacheCreationInputTokens: 10,
        webSearchRequests: 1,
        costUSD: 1.12,
      }),
    ]);
    await writeTranscript(fixture, entry, [
      claudeResultLine('cancelled-session', 11.28, {
        inputTokens: 1100,
        outputTokens: 220,
        cacheReadInputTokens: 440,
        cacheCreationInputTokens: 110,
        webSearchRequests: 3,
        costUSD: 11.28,
      }),
    ]);

    const result = await runRepair(fixture, {
      isCancelled: () => fixture.appended.length > 0,
    });

    expect(result).toMatchObject({
      claudeRepaired: 1,
      claudeSkippedNoTranscript: 0,
      codexDelegationsPriced: 0,
      skipped: false,
    });
    await expect(readFile(fixture.markerPath, 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('yields for macrotask cancellation before appending when yieldEvery is one', async () => {
    const fixture = await createFixture();
    const baseline = auditEntry(
      'yield-baseline',
      `${REPAIR_DATE}T16:30:00.000Z`,
      { totalCostUsd: 1.12 },
    );
    const candidate = auditEntry(
      'yield-candidate',
      `${REPAIR_DATE}T16:31:00.000Z`,
      { totalCostUsd: 12.28 },
    );
    await writeAuditEntries(fixture, [baseline, candidate]);
    await writeTranscript(fixture, baseline, [
      claudeResultLine('yield-session', 1.12, cumulativeUsage(1.12, 1)),
    ]);
    await writeTranscript(fixture, candidate, [
      claudeResultLine('yield-session', 11.28, cumulativeUsage(11.28, 11)),
    ]);

    let cancellationRequested = false;
    let cancellationScheduled = false;
    const result = await runRepair(fixture, {
      yieldEvery: 1,
      isCancelled: () => {
        if (!cancellationScheduled) {
          cancellationScheduled = true;
          setImmediate(() => {
            cancellationRequested = true;
          });
        }
        return cancellationRequested;
      },
    });

    expect(result.skipped).toBe(false);
    expect(fixture.appended).toEqual([]);
    await expect(readFile(fixture.markerPath, 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('does not write the marker when an audit append fails', async () => {
    const fixture = await createFixture();
    const baseline = auditEntry(
      'append-failure-baseline',
      `${REPAIR_DATE}T17:00:00.000Z`,
      { totalCostUsd: 1.12 },
    );
    const entry = auditEntry('append-failure', `${REPAIR_DATE}T17:01:00.000Z`, {
      totalCostUsd: 12.28,
    });
    await writeAuditEntries(fixture, [baseline, entry]);
    await writeTranscript(fixture, baseline, [
      claudeResultLine('append-session', 1.12, {
        inputTokens: 100,
        outputTokens: 20,
        cacheReadInputTokens: 40,
        cacheCreationInputTokens: 10,
        webSearchRequests: 1,
        costUSD: 1.12,
      }),
    ]);
    await writeTranscript(fixture, entry, [
      claudeResultLine('append-session', 11.28, {
        inputTokens: 1100,
        outputTokens: 220,
        cacheReadInputTokens: 440,
        cacheCreationInputTokens: 110,
        webSearchRequests: 3,
        costUSD: 11.28,
      }),
    ]);
    const appendFailure = new Error('audit append failed');

    await expect(
      runRepair(fixture, {
        append: () => Promise.reject(appendFailure),
      }),
    ).rejects.toBe(appendFailure);
    await expect(readFile(fixture.markerPath, 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  async function writeInflatedPair(
    fixture: RepairFixture,
    prefix: string,
    overrides: Partial<AgentAuditEntry> = {},
  ): Promise<void> {
    const baseline = auditEntry(
      `${prefix}-baseline`,
      `${REPAIR_DATE}T16:00:00.000Z`,
      { totalCostUsd: 1.12 },
    );
    const entry = auditEntry(prefix, `${REPAIR_DATE}T16:01:00.000Z`, {
      totalCostUsd: 11.28,
      ...overrides,
    });
    await writeAuditEntries(fixture, [baseline, entry]);
    await writeTranscript(fixture, baseline, [
      claudeResultLine(`${prefix}-session`, 1.12, cumulativeUsage(1.12, 1)),
    ]);
    await writeTranscript(fixture, entry, [
      claudeResultLine(`${prefix}-session`, 11.28, cumulativeUsage(11.28, 11)),
    ]);
  }

  it('does not repair a Claude entry that is still running', async () => {
    const fixture = await createFixture();
    await writeInflatedPair(fixture, 'running', { status: 'running' });

    const result = await runRepair(fixture);

    expect(result.claudeRepaired).toBe(0);
    expect(fixture.appended).toEqual([]);
  });

  it('writes the marker only after the corrections are committed', async () => {
    const fixture = await createFixture();
    await writeInflatedPair(fixture, 'commit');
    const commitFailure = new Error('audit write failed');

    await expect(
      runRepair(fixture, { commit: () => Promise.reject(commitFailure) }),
    ).rejects.toBe(commitFailure);
    await expect(readFile(fixture.markerPath, 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });

    const fresh = await createFixture();
    await writeInflatedPair(fresh, 'commit');
    const appendedBeforeCommit: number[] = [];
    await runRepair(fresh, {
      commit: (): Promise<void> => {
        appendedBeforeCommit.push(fresh.appended.length);
        return Promise.resolve();
      },
    });
    expect(appendedBeforeCommit).toEqual([1]);
    await expect(readFile(fresh.markerPath, 'utf8')).resolves.toContain(
      '"version":1',
    );
  });

  it('reseeds after a turn whose transcript is missing instead of spanning the gap', async () => {
    const fixture = await createFixture();
    const at = (minute: number): string =>
      `${REPAIR_DATE}T14:0${String(minute)}:00.000Z`;
    const first = auditEntry('gap-1', at(0), {
      totalCostUsd: 1,
      sdkSessionId: 'gap-session',
    });
    const missing = auditEntry('gap-2', at(1), {
      totalCostUsd: 2,
      sdkSessionId: 'gap-session',
    });
    const third = auditEntry('gap-3', at(2), {
      totalCostUsd: 3,
      sdkSessionId: 'gap-session',
    });
    const fourth = auditEntry('gap-4', at(3), {
      totalCostUsd: 4,
      sdkSessionId: 'gap-session',
    });
    await writeAuditEntries(fixture, [first, missing, third, fourth]);
    await writeTranscript(fixture, first, [
      claudeResultLine('gap-session', 1, cumulativeUsage(1, 1)),
    ]);
    await writeTranscript(fixture, third, [
      claudeResultLine('gap-session', 3, cumulativeUsage(3, 3)),
    ]);
    await writeTranscript(fixture, fourth, [
      claudeResultLine('gap-session', 4, cumulativeUsage(4, 4)),
    ]);

    const result = await runRepair(fixture);

    expect(result.claudeSkippedNoTranscript).toBe(1);
    // The turn after the gap only re-seeds; the next one is exact again.
    expect(
      fixture.appended.map((entry) => [entry.id, entry.totalCostUsd]),
    ).toEqual([['gap-4', 1]]);
  });

  it('treats a truncated transcript as a gap rather than a complete baseline', async () => {
    const fixture = await createFixture();
    const at = (minute: number): string =>
      `${REPAIR_DATE}T13:0${String(minute)}:00.000Z`;
    const entries = [1, 2, 3, 4].map((turn) =>
      auditEntry(`truncated-${String(turn)}`, at(turn), {
        totalCostUsd: turn * 2,
        sdkSessionId: 'truncated-session',
      }),
    );
    await writeAuditEntries(fixture, entries);
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index];
      if (entry === undefined) continue;
      const turn = index + 1;
      await writeTranscript(fixture, entry, [
        claudeResultLine(
          'truncated-session',
          turn * 2,
          cumulativeUsage(turn * 2, turn * 2),
        ),
        ...(turn === 2
          ? [
              JSON.stringify({
                type: 'canopy_transcript_truncated',
                max_bytes: 1024,
              }),
            ]
          : []),
      ]);
    }

    const result = await runRepair(fixture);

    expect(result.claudeSkippedNoTranscript).toBe(1);
    // Turn 3 only re-seeds after the partial transcript; turn 4 is exact.
    expect(
      fixture.appended.map((entry) => [entry.id, entry.totalCostUsd]),
    ).toEqual([['truncated-4', 2]]);
  });
});
