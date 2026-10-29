import { resolve } from 'node:path';

const edits = new Map<string, number>();
const writes = new Map<string, Promise<unknown>>();

export function memoryEditRevision(scopeDir: string): number {
  return edits.get(resolve(scopeDir)) ?? 0;
}

export function recordMemoryEdit(scopeDir: string): void {
  const key = resolve(scopeDir);
  edits.set(key, memoryEditRevision(key) + 1);
}

export async function withMemoryWriteLock<T>(
  scopeDir: string,
  write: () => Promise<T>,
): Promise<T> {
  const key = resolve(scopeDir);
  const previous = writes.get(key) ?? Promise.resolve();
  const operation = previous.catch(() => undefined).then(write);
  writes.set(key, operation);
  try {
    return await operation;
  } finally {
    if (writes.get(key) === operation) writes.delete(key);
  }
}
