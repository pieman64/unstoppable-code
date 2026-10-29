// Generic small utilities shared across the chat store modules.
import type { WorktreeSelection } from '@canopy/desktop-shared/types';

export function worktreeKey(sel: WorktreeSelection): string {
  return `${sel.projectId}/${sel.worktreeId}`;
}

export function splitWorktreeKey(key: string): {
  projectId: string;
  worktreeId: string;
} {
  const separatorIndex = key.indexOf('/');
  if (separatorIndex < 0) {
    throw new Error(`Invalid worktree key: ${key}`);
  }

  const projectId = key.slice(0, separatorIndex);
  const worktreeId = key.slice(separatorIndex + 1);
  if (!projectId || !worktreeId) {
    throw new Error(`Invalid worktree key: ${key}`);
  }

  return { projectId, worktreeId };
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export async function mapWithConcurrency<T, Result>(
  items: T[],
  concurrency: number,
  mapper: (item: T) => Promise<Result>,
): Promise<Result[]> {
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error('concurrency must be at least 1');
  }

  const results = new Array<Result>(items.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex;
      const item = items[currentIndex];
      nextIndex += 1;
      results[currentIndex] = await mapper(item);
    }
  }

  const workerCount = Math.min(concurrency, items.length);
  const workers: Promise<void>[] = [];
  for (let index = 0; index < workerCount; index += 1) {
    workers.push(worker());
  }

  await Promise.all(workers);
  return results;
}

export function parseWorktreeChatKey(key: string): WorktreeSelection | null {
  const separatorIndex = key.indexOf('/');
  if (separatorIndex < 0) {
    return null;
  }

  const projectId = key.slice(0, separatorIndex);
  const worktreeId = key.slice(separatorIndex + 1);
  if (!projectId || !worktreeId) {
    return null;
  }

  return { projectId, worktreeId };
}
