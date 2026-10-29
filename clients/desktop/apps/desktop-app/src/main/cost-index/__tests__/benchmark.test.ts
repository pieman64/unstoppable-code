/* eslint-disable @typescript-eslint/require-await -- synthetic benchmark host */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CostIndexHost, CostScopeLocation } from '../types';
import { CostIndexStore } from '../store';

// Each slice blocks Electron main, which every keystroke crosses several
// times; 64 KiB is under a millisecond of indexing.
const MAX_SLICE_BYTES = 64 * 1024;
const MAX_SLICE_DURATION_MS = 500;
const DAYS_IN_BENCHMARK_WEEK = 7;
const ENTRIES_PER_DAY = 900;

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

describe('CostIndexStore bounded audit slices', () => {
  it('indexes a large audit day in yielded slices no larger than 64 KiB', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cost-index-benchmark-'));
    const auditDirectory = join(root, 'audit');
    const checkpointPath = join(root, 'index', 'checkpoint.json');
    const scope = {
      kind: 'entry',
      projectId: 'bench-project',
      worktreeId: 'bench-entry',
    } as const;
    const location: CostScopeLocation = {
      scope,
      directory: join(root, 'scope'),
      incarnation: '2026-10-01T00:00:00.000Z',
      createdAt: '2026-10-01T00:00:00.000Z',
    };
    const slices: Array<{ bytes: number; durationMs: number }> = [];
    let yieldCount = 0;
    await mkdir(auditDirectory, { recursive: true });
    const rows: string[] = [];
    for (let dayIndex = 0; dayIndex < DAYS_IN_BENCHMARK_WEEK; dayIndex += 1) {
      const day = new Date(Date.UTC(2026, 9, 1 + dayIndex))
        .toISOString()
        .slice(0, 10);
      rows.length = 0;
      for (let index = 0; index < ENTRIES_PER_DAY; index += 1) {
        rows.push(
          JSON.stringify({
            id: `bench-${day}-turn-${index}`,
            eventType: 'worktree_chat',
            status: 'success',
            provider: 'claude',
            label: 'Benchmark turn',
            startedAt: `${day}T12:00:00.000Z`,
            completedAt: `${day}T12:00:01.000Z`,
            durationMs: 1_000,
            model: 'claude-sonnet',
            totalCostUsd: 0.01,
            tokens: { input: 50, output: 10 },
            toolCounts: { read: 2, search: 1 },
            projectId: scope.projectId,
            worktreeId: scope.worktreeId,
            chatId: 'bench-chat',
          }),
        );
      }
      await writeFile(
        join(auditDirectory, `${day}.jsonl`),
        `${rows.join('\n')}\n`,
      );
    }
    const host: CostIndexHost = {
      auditDirectory: () => auditDirectory,
      checkpointPath: () => checkpointPath,
      resolveScope: async () => location,
      listRetainedScopes: async () => [],
      withRetainedLock: async (_scope, action) => action(),
      readChats: async () => [
        { chatId: 'bench-chat', label: 'Bench', state: 'open' },
      ],
      readPipelineRun: async () => null,
      retentionDays: () => 7,
      flush: async () => undefined,
      onSlice: (durationMs, bytes) => slices.push({ bytes, durationMs }),
      yield: async () => {
        yieldCount += 1;
      },
    };
    const store = new CostIndexStore(host);
    try {
      const receipt = await store.refreshInternal('startup');
      expect(receipt.ran).toBe(true);
      expect(slices.length).toBeGreaterThan(DAYS_IN_BENCHMARK_WEEK);
      expect(
        Math.max(...slices.map((slice) => slice.bytes)),
      ).toBeLessThanOrEqual(MAX_SLICE_BYTES);
      expect(slices.every((slice) => slice.durationMs >= 0)).toBe(true);
      expect(Math.max(...slices.map((slice) => slice.durationMs))).toBeLessThan(
        MAX_SLICE_DURATION_MS,
      );
      expect(yieldCount).toBe(slices.length);
    } finally {
      try {
        await store.waitForIdle();
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  }, 20_000);

  it('keeps background helper work flat as a week of summaries accumulates', async () => {
    // Helper work such as worktree summaries carries no chat id, so it lands
    // in the scope's unattached records. Each day's summaries cycle through
    // about 200 ids and repeat with new token counts, as on a real machine,
    // so the records grow by about 200 a day. A slice late in the week must
    // cost about what an early one does.
    const DAYS = 6;
    const LINES_PER_DAY = 12_000;
    const IDS_PER_DAY = 200;
    const root = await mkdtemp(join(tmpdir(), 'cost-index-helpers-'));
    const auditDirectory = join(root, 'audit');
    const scope = {
      kind: 'entry',
      projectId: 'bench-project',
      worktreeId: 'bench-entry',
    } as const;
    const location: CostScopeLocation = {
      scope,
      directory: join(root, 'scope'),
      incarnation: '2026-10-01T00:00:00.000Z',
      createdAt: '2026-10-01T00:00:00.000Z',
    };
    const slices: number[] = [];
    await mkdir(auditDirectory, { recursive: true });
    for (let dayIndex = 0; dayIndex < DAYS; dayIndex += 1) {
      const day = new Date(Date.UTC(2026, 9, 2 + dayIndex))
        .toISOString()
        .slice(0, 10);
      const rows: string[] = [];
      for (let index = 0; index < LINES_PER_DAY; index += 1) {
        rows.push(
          JSON.stringify({
            id: `bench-summary-${day}-${index % IDS_PER_DAY}`,
            eventType: 'worktree_summary',
            status: 'success',
            provider: 'claude',
            label: 'Worktree summary',
            startedAt: `${day}T12:00:00.000Z`,
            model: 'claude-haiku',
            totalCostUsd: 0.001,
            tokens: { input: 1_200 + index, output: 80 },
            toolCounts: {},
            projectId: scope.projectId,
            worktreeId: scope.worktreeId,
          }),
        );
      }
      await writeFile(
        join(auditDirectory, `${day}.jsonl`),
        `${rows.join('\n')}\n`,
      );
    }
    const host: CostIndexHost = {
      auditDirectory: () => auditDirectory,
      checkpointPath: () => join(root, 'index', 'checkpoint.json'),
      resolveScope: async () => location,
      listRetainedScopes: async () => [],
      withRetainedLock: async (_scope, action) => action(),
      readChats: async () => [],
      readPipelineRun: async () => null,
      retentionDays: () => 7,
      flush: async () => undefined,
      onSlice: (durationMs) => slices.push(durationMs),
      yield: async () => undefined,
    };
    const store = new CostIndexStore(host);
    try {
      const receipt = await store.refreshInternal('startup');
      expect(receipt.ran).toBe(true);
      // Slices run in day order: compare the first day's with the last's.
      const fifth = Math.floor(slices.length / 5);
      expect(fifth).toBeGreaterThan(5);
      const early = median(slices.slice(0, fifth));
      const late = median(slices.slice(-fifth));
      expect(late).toBeLessThan(Math.max(early, 1) * 2.5);
    } finally {
      try {
        await store.waitForIdle();
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  }, 120_000);
});
