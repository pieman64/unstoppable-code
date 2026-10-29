import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isCostUnattachedFile, readScopeFiles } from '../persistence';
import { aggregateRecords } from '../read-model';
import type { CostTurnRecord } from '../types';

function record(): CostTurnRecord {
  return {
    entryId: 'turn-1',
    day: '2026-10-15',
    startedAt: '2026-10-15T10:00:00.000Z',
    status: 'success',
    source: 'chat',
    chatId: 'chat-1',
    provider: 'claude',
    billingBasis: 'subscription',
    tokens: {
      input: 10,
      output: 2,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      reasoningOutputTokens: 0,
    },
    costUsd: 1,
    costStatus: 'reported',
  };
}

function item(totalTokens: unknown): Record<string, unknown> {
  return {
    id: 'task-1',
    kind: 'claude_task',
    label: 'Claude task',
    billingBasis: 'subscription',
    tokens: {
      input: 0,
      output: 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      reasoningOutputTokens: 0,
    },
    totalTokens,
    usd: 0.5,
    costStatus: 'estimated',
    inclusion: 'included',
  };
}

describe('persisted total-only subagent usage', () => {
  it.each([-1, '100', null])(
    'rejects invalid totalTokens %p in records',
    (totalTokens) => {
      expect(
        isCostUnattachedFile({
          version: 1,
          records: {
            'turn-1': { ...record(), subagents: [item(totalTokens)] },
          },
        }),
      ).toBe(false);
    },
  );

  it('rejects invalid totalTokens in sealed attributed items', () => {
    const sealed = aggregateRecords([record()]);
    expect(
      isCostUnattachedFile({
        version: 1,
        records: {},
        sealedUnattached: {
          ...sealed,
          bySource: {
            ...sealed.bySource,
            subagents: { usd: 0.5, items: [item(-1)] },
          },
        },
      }),
    ).toBe(false);
  });

  it('preserves optional totalTokens and the unknown split through a file read', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'cost-total-only-'));
    try {
      await writeFile(
        join(directory, 'unattached.json'),
        JSON.stringify({
          version: 1,
          records: { 'turn-1': { ...record(), subagents: [item(1200)] } },
        }),
      );
      const result = await readScopeFiles(directory);
      expect(result.corrupt).toBe(false);
      expect(
        result.unattached.value?.records['turn-1']?.subagents?.[0],
      ).toEqual(item(1200));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
