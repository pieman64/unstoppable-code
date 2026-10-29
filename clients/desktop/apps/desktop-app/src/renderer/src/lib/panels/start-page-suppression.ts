import type { CreateFromOptions } from '@/lib/createFromSource';

const suppressed = new Set<string>();

export function withStartPageSuppressed(
  options?: CreateFromOptions,
): CreateFromOptions & { suppressStartPage: true } {
  return { ...options, suppressStartPage: true };
}

export function markStartPageSuppressed(worktreeKey: string): void {
  suppressed.add(worktreeKey);
}

export function consumeStartPageSuppressed(worktreeKey: string): boolean {
  if (!suppressed.has(worktreeKey)) return false;
  suppressed.delete(worktreeKey);
  return true;
}
