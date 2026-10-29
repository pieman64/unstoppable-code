import { isSafePortableRelativePath } from '../safe-relative-path';

export type ProjectStartPage =
  | { kind: 'file'; repoId?: string; path: string }
  | { kind: 'url'; url: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  allowedKeys: readonly string[],
): boolean {
  const allowed = new Set(allowedKeys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function isHttpUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

export function isProjectStartPage(value: unknown): value is ProjectStartPage {
  if (!isRecord(value) || typeof value.kind !== 'string') return false;
  if (value.kind === 'file') {
    return (
      hasOnlyKeys(value, ['kind', 'repoId', 'path']) &&
      (value.repoId === undefined ||
        (typeof value.repoId === 'string' &&
          /^[A-Za-z0-9_-]+$/.test(value.repoId))) &&
      isSafePortableRelativePath(value.path)
    );
  }
  return (
    value.kind === 'url' &&
    hasOnlyKeys(value, ['kind', 'url']) &&
    isHttpUrl(value.url)
  );
}
