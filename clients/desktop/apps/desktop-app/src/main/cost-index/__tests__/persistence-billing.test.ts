import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readScopeFiles, readSummaryFile } from '../persistence';
import { buildPipelineRunViews } from '../read-model';
import type { CostTurnRecord } from '../types';

/** Totals as a release before the account proxy basis wrote them. */
function totalsWithoutAccountProxy(usd: number): Record<string, unknown> {
  return {
    usd,
    bySource: {
      chat: usd,
      pipeline: 0,
      subagents: 0,
      delegations: 0,
      background: 0,
    },
    byBilling: {
      subscription: usd,
      ai_credits: 0,
      api_key: 0,
      org_gateway: 0,
      local: 0,
      unknown: 0,
    },
    tokens: {
      input: 10,
      output: 2,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      reasoningOutputTokens: 0,
    },
    notPricedCount: 0,
    hasEstimate: false,
  };
}

function pipelineStep(
  entryId: string,
  billingBasis: CostTurnRecord['billingBasis'],
  costUsd: number,
  startedAt: string,
): CostTurnRecord {
  return {
    entryId,
    day: startedAt.slice(0, 10),
    startedAt,
    completedAt: new Date(Date.parse(startedAt) + 1000).toISOString(),
    status: 'success',
    source: 'pipeline',
    provider: 'claude',
    model: 'claude-sonnet-4',
    billingBasis,
    tokens: {
      input: 100,
      output: 40,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      reasoningOutputTokens: 0,
    },
    costUsd,
    costStatus: 'reported',
    pipeline: {
      rootExecutionId: 'run-1',
      executionId: 'run-1',
      pipelineName: 'Build',
      jobId: 'job-a',
      stepId: 'test',
      attempt: 1,
    },
  };
}

/** Drops the account proxy total everywhere, as an earlier release wrote it. */
function withoutAccountProxy(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutAccountProxy);
  if (typeof value !== 'object' || value === null) return value;
  const next: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (key === 'account_proxy') continue;
    next[key] = withoutAccountProxy(child);
  }
  return next;
}

describe('cost files written before the account proxy basis', () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'cost-billing-'));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('reads them with no account proxy spend instead of as corrupt', async () => {
    await writeFile(
      join(directory, 'summary.json'),
      JSON.stringify({
        version: 1,
        projectId: 'project-1',
        scopeId: 'worktree-1',
        incarnation: 'incarnation-1',
        updatedAt: '2026-10-12T10:00:00.000Z',
        retentionDays: 30,
        revision: 3,
        totals: totalsWithoutAccountProxy(1.5),
        chats: [
          {
            chatId: 'chat-1',
            totals: totalsWithoutAccountProxy(1.5),
            turnCount: 2,
            lastActivityAt: '2026-10-12T10:00:00.000Z',
            models: ['sonnet'],
            running: false,
            hasCodexEstimate: false,
          },
        ],
        pipelineRuns: [],
        hasCodexEstimate: false,
      }),
    );

    const read = await readSummaryFile(directory);

    expect(read.corrupt).toBe(false);
    expect(read.value?.totals.byBilling.account_proxy).toBe(0);
    expect(read.value?.chats[0]?.totals.byBilling.account_proxy).toBe(0);
    expect(read.value?.totals.byBilling.subscription).toBe(1.5);
    // Nothing was moved aside as corrupt.
    expect(await readdir(directory)).toEqual(['summary.json']);
  });

  it('reads sealed pipeline runs with no account proxy spend, so new proxy spend adds to them', async () => {
    const [sealed] = buildPipelineRunViews([
      pipelineStep(
        'sealed-step',
        'subscription',
        0.5,
        '2026-10-12T09:00:00.000Z',
      ),
    ]);
    if (!sealed) throw new Error('expected a sealed run');
    await writeFile(
      join(directory, 'unattached.json'),
      JSON.stringify({
        version: 1,
        records: {},
        sealedRuns: { 'run-1': withoutAccountProxy(sealed) },
      }),
    );

    const read = await readScopeFiles(directory);
    const sealedRuns = read.unattached.value?.sealedRuns ?? {};

    expect(read.unattached.corrupt).toBe(false);
    expect(sealedRuns['run-1']?.run.totals.byBilling.account_proxy).toBe(0);
    expect(sealedRuns['run-1']?.steps[0]?.totals.byBilling.account_proxy).toBe(
      0,
    );

    const [merged] = buildPipelineRunViews(
      [
        pipelineStep(
          'proxy-step',
          'account_proxy',
          0.25,
          '2026-10-12T10:00:00.000Z',
        ),
      ],
      sealedRuns,
    );
    expect(merged?.run.totals.byBilling.account_proxy).toBe(0.25);
    expect(merged?.run.totals.byBilling.subscription).toBe(0.5);
  });
});
