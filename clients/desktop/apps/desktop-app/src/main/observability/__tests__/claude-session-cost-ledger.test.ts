import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  ClaudeSessionCostLedger,
  readClaudeMainLoopUsage,
  readClaudeRunningTotals,
  type ClaudeModelUsageTotals,
  type ClaudeResultInput,
  type ClaudeRunningTotals,
} from '../claude-session-cost-ledger';

function modelTotals(
  costUsd: number,
  inputTokens = 100,
): ClaudeModelUsageTotals {
  return {
    inputTokens,
    outputTokens: 20,
    cacheReadInputTokens: 10,
    cacheCreationInputTokens: 5,
    webSearchRequests: 1,
    costUsd,
    costBasis: 'list',
  };
}

function totals(
  totalCostUsd: number,
  models: Readonly<Record<string, ClaudeModelUsageTotals>> = {
    'claude-opus-4-1': modelTotals(totalCostUsd),
  },
): ClaudeRunningTotals {
  return { totalCostUsd, modelUsage: models };
}

function input(
  sessionId: string,
  totalCostUsd: number,
  models?: Readonly<Record<string, ClaudeModelUsageTotals>>,
): ClaudeResultInput {
  return {
    sessionId,
    totals: totals(totalCostUsd, models),
    mainLoopUsage: {
      inputTokens: 10,
      outputTokens: 2,
      cacheReadInputTokens: 3,
      cacheCreationInputTokens: 1,
    },
    mainModel: 'claude-opus-4-1',
  };
}

describe('ClaudeSessionCostLedger', () => {
  let directories: string[];
  let ledgers: ClaudeSessionCostLedger[];

  beforeEach(() => {
    directories = [];
    ledgers = [];
  });

  afterEach(async () => {
    await Promise.all(ledgers.map((ledger) => ledger.flush()));
    await Promise.all(
      directories.map((directory) =>
        rm(directory, { recursive: true, force: true }),
      ),
    );
  });

  async function createLedger(
    options: { maxSessions?: number; now?: () => number } = {},
  ): Promise<{ ledger: ClaudeSessionCostLedger; filePath: string }> {
    const directory = await mkdtemp(
      join(process.env.TMPDIR ?? '/tmp', 'claude-session-cost-ledger-'),
    );
    directories.push(directory);
    const filePath = join(directory, 'costs.json');
    const ledger = new ClaudeSessionCostLedger({
      filePath,
      persistDelayMs: 60_000,
      ...options,
    });
    ledgers.push(ledger);
    return { ledger, filePath };
  }

  it('returns a delta for each result in one query', async () => {
    const { ledger } = await createLedger();
    ledger.beginQuery('query');

    const costs = [2, 5, 8].map(
      (costUsd) =>
        ledger.recordResult('query', input('session', costUsd)).costUsd,
    );

    expect(costs).toEqual([2, 3, 3]);
  });

  it('continues a session after query teardown', async () => {
    const { ledger } = await createLedger();
    ledger.beginQuery('first');
    ledger.recordResult('first', input('session', 41.99));
    ledger.endQuery('first');
    ledger.beginQuery('second', { sessionId: 'session', fork: false });

    expect(
      ledger.recordResult('second', input('session', 46.75)),
    ).toMatchObject({
      costUsd: 4.76,
      derivation: 'exact',
      cumulativeCostUsd: 46.75,
    });
  });

  it('keeps stored sessions when a result arrives before the load finishes', async () => {
    const { ledger, filePath } = await createLedger();
    ledger.beginQuery('first');
    ledger.recordResult('first', input('stored', 10));
    await ledger.flush();

    const early = new ClaudeSessionCostLedger({ filePath, persistDelayMs: 0 });
    ledgers.push(early);
    early.beginQuery('fresh');
    early.recordResult('fresh', input('new', 2));
    await early.flush();

    const stored = await readFile(filePath, 'utf8');
    expect(stored).toContain('"stored":');
    expect(stored).toContain('"new":');
    early.beginQuery('resumed', { sessionId: 'stored', fork: false });
    expect(early.recordResult('resumed', input('stored', 12))).toMatchObject({
      costUsd: 2,
      derivation: 'exact',
    });
  });

  it('restores session totals after a ledger restart', async () => {
    const { ledger, filePath } = await createLedger();
    ledger.beginQuery('first');
    ledger.recordResult('first', input('session', 41.99));
    await ledger.flush();

    const resumed = new ClaudeSessionCostLedger({
      filePath,
      persistDelayMs: 60_000,
    });
    ledgers.push(resumed);
    await resumed.load();
    resumed.beginQuery('second', { sessionId: 'session', fork: false });

    expect(
      resumed.recordResult('second', input('session', 46.75)),
    ).toMatchObject({
      costUsd: 4.76,
      derivation: 'exact',
    });
  });

  it('uses a parent session baseline for a fork with a new child id', async () => {
    const { ledger } = await createLedger();
    ledger.beginQuery('parent');
    ledger.recordResult('parent', input('parent-session', 10));
    ledger.beginQuery('fork', { sessionId: 'parent-session', fork: true });

    expect(
      ledger.recordResult('fork', input('child-session', 12)),
    ).toMatchObject({
      costUsd: 2,
      derivation: 'exact',
    });
  });

  it('keeps the fork baseline from fork start when the parent advances', async () => {
    const { ledger } = await createLedger();
    ledger.beginQuery('parent');
    ledger.recordResult('parent', input('parent-session', 10));
    ledger.beginQuery('fork', { sessionId: 'parent-session', fork: true });
    ledger.recordResult('parent', input('parent-session', 13));

    expect(
      ledger.recordResult('fork', input('child-session', 12)),
    ).toMatchObject({
      costUsd: 2,
      derivation: 'exact',
    });
  });

  it.each([
    ['resumed', false],
    ['forked', true],
  ])('resets a %s query to zero after /clear', async (_name, fork) => {
    const { ledger } = await createLedger();
    ledger.beginQuery('parent');
    ledger.recordResult('parent', input('parent-session', 15));
    ledger.beginQuery('continued', { sessionId: 'parent-session', fork });
    ledger.noteConversationReset('continued');

    expect(
      ledger.recordResult('continued', input('new-session', 19.5)),
    ).toMatchObject({ costUsd: 19.5, derivation: 'exact' });
  });

  it('uses the prior session row after an unexpected id change', async () => {
    const { ledger } = await createLedger();
    ledger.beginQuery('query');
    ledger.recordResult('query', input('first-session', 10));

    expect(
      ledger.recordResult('query', input('unexpected-session', 13)),
    ).toMatchObject({ costUsd: 3, derivation: 'exact' });
  });

  it('ignores a zeroed result without changing the session baseline', async () => {
    const { ledger } = await createLedger();
    ledger.beginQuery('query');
    ledger.recordResult('query', input('session', 10));

    expect(
      ledger.recordResult('query', {
        sessionId: 'session',
        totals: totals(0, { 'claude-opus-4-1': modelTotals(0, 0) }),
        mainLoopUsage: {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
        },
      }),
    ).toMatchObject({ costUsd: 0, modelUsage: [], derivation: 'exact' });

    expect(ledger.recordResult('query', input('session', 12))).toMatchObject({
      costUsd: 2,
      derivation: 'exact',
    });
  });

  it('estimates when a resumed session has no baseline and caps the result', async () => {
    const { ledger } = await createLedger();
    ledger.beginQuery('resume', { sessionId: 'missing', fork: false });

    const result = ledger.recordResult('resume', {
      ...input('missing', 0.01),
      mainLoopUsage: {
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
        cacheReadInputTokens: 1_000_000,
        cacheCreationInputTokens: 1_000_000,
      },
    });

    expect(result.derivation).toBe('estimated_unknown_baseline');
    expect(result.costUsd).toBeGreaterThanOrEqual(0);
    expect(result.costUsd).toBeLessThanOrEqual(0.01);
  });

  it('estimates when a session total moves backwards', async () => {
    const { ledger } = await createLedger();
    ledger.beginQuery('query');
    ledger.recordResult('query', input('session', 10));

    const result = ledger.recordResult('query', input('session', 4));

    expect(result.derivation).toBe('estimated_unknown_baseline');
    expect(result.costUsd).toBeGreaterThanOrEqual(0);
    expect(result.costUsd).toBeLessThanOrEqual(4);
  });

  it('returns per-model deltas for multiple models', async () => {
    const { ledger } = await createLedger();
    ledger.beginQuery('query');
    ledger.recordResult(
      'query',
      input('session', 4, {
        opus: modelTotals(3, 200),
        haiku: modelTotals(1, 50),
      }),
    );

    const result = ledger.recordResult(
      'query',
      input('session', 7, {
        opus: modelTotals(5, 300),
        haiku: modelTotals(2, 80),
      }),
    );

    expect(result.costUsd).toBe(3);
    expect(result.modelUsage).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          model: 'opus',
          inputTokens: 100,
          costUsd: 2,
        }),
        expect.objectContaining({
          model: 'haiku',
          inputTokens: 30,
          costUsd: 1,
        }),
      ]),
    );
  });

  it('evicts older sessions and loads a corrupt file as empty', async () => {
    let now = 0;
    const { ledger, filePath } = await createLedger({
      maxSessions: 2,
      now: () => ++now,
    });
    ledger.beginQuery('query');
    ledger.recordResult('query', input('old', 1));
    ledger.recordResult('query', input('middle', 1));
    ledger.recordResult('query', input('new', 1));
    await ledger.flush();

    const saved = JSON.parse(await readFile(filePath, 'utf8')) as {
      sessions: Record<string, unknown>;
    };
    expect(Object.keys(saved.sessions).sort()).toEqual(['middle', 'new']);

    const corruptPath = join(directories[0] ?? '', 'corrupt.json');
    await writeFile(corruptPath, '{not json');
    const corruptLedger = new ClaudeSessionCostLedger({
      filePath: corruptPath,
      persistDelayMs: 60_000,
    });
    ledgers.push(corruptLedger);
    await expect(corruptLedger.load()).resolves.toBeUndefined();
    corruptLedger.beginQuery('resume', { sessionId: 'new', fork: false });
    expect(
      corruptLedger.recordResult('resume', input('new', 2)).derivation,
    ).toBe('estimated_unknown_baseline');
  });
});

describe('Claude SDK usage readers', () => {
  it('reads finite running totals, model usage and the cost basis', () => {
    expect(
      readClaudeRunningTotals({
        total_cost_usd: 0.25,
        modelUsage: {
          'claude-sonnet-4-5': {
            inputTokens: 100,
            outputTokens: 10,
            cacheReadInputTokens: 20,
            cacheCreationInputTokens: 5,
            webSearchRequests: 1,
            costUSD: 0.25,
            costBasis: 'managed',
          },
        },
      }),
    ).toEqual({
      totalCostUsd: 0.25,
      modelUsage: {
        'claude-sonnet-4-5': {
          inputTokens: 100,
          outputTokens: 10,
          cacheReadInputTokens: 20,
          cacheCreationInputTokens: 5,
          webSearchRequests: 1,
          costUsd: 0.25,
          costBasis: 'managed',
        },
      },
    });
    expect(
      readClaudeRunningTotals({ total_cost_usd: Number.NaN }),
    ).toBeUndefined();
  });

  it('defaults missing main-loop token fields to zero', () => {
    expect(readClaudeMainLoopUsage({ usage: { input_tokens: 3 } })).toEqual({
      inputTokens: 3,
      outputTokens: 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
    });
  });
});
