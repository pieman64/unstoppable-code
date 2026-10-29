import type { PluginFileContent } from './types';

const UTF8_DECODER = new TextDecoder();

/** Locale-independent code-unit ordering for plugin-relative paths. */
export function comparePluginPaths(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function normalizePluginPath(value: string): string | null {
  const slashes = value.replace(/\\/g, '/');
  if (slashes.startsWith('/')) return null;
  const segments: string[] = [];
  for (const segment of slashes.split('/')) {
    if (segment.length === 0 || segment === '.') continue;
    if (segment === '..') {
      if (segments.length === 0) return null;
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return segments.join('/');
}

export function resolvePluginPath(value: string): string | null {
  return normalizePluginPath(value);
}

export function dirnamePluginPath(value: string): string {
  const index = value.lastIndexOf('/');
  return index === -1 ? '' : value.slice(0, index);
}

export function basenamePluginPath(value: string): string {
  const index = value.lastIndexOf('/');
  return index === -1 ? value : value.slice(index + 1);
}

export function extensionPluginPath(value: string): string {
  const basename = basenamePluginPath(value);
  const index = basename.lastIndexOf('.');
  return index <= 0 ? '' : basename.slice(index).toLowerCase();
}

export function joinPluginPath(...parts: readonly string[]): string {
  return parts
    .filter((part) => part.length > 0)
    .join('/')
    .replace(/\/+/g, '/');
}

export function relativePluginPath(fromDirectory: string, to: string): string {
  const from = fromDirectory.split('/').filter(Boolean);
  const target = to.split('/').filter(Boolean);
  let shared = 0;
  while (
    shared < from.length &&
    shared < target.length &&
    from[shared] === target[shared]
  ) {
    shared += 1;
  }
  return [...from.slice(shared).map(() => '..'), ...target.slice(shared)].join(
    '/',
  );
}

export function normalizePluginFiles(
  files: ReadonlyMap<string, PluginFileContent>,
): Map<string, PluginFileContent> {
  const normalized = new Map<string, PluginFileContent>();
  for (const [filePath, content] of Array.from(files.entries())) {
    const resolved = normalizePluginPath(filePath);
    if (resolved !== null && resolved.length > 0) {
      normalized.set(resolved, content);
    }
  }
  return normalized;
}

export function readTextFile(
  files: ReadonlyMap<string, PluginFileContent>,
  filePath: string,
): string | null {
  const content = files.get(filePath);
  if (typeof content === 'string') return content;
  if (content instanceof Uint8Array) return UTF8_DECODER.decode(content);
  return null;
}

export function readJsonRecord(
  files: ReadonlyMap<string, PluginFileContent>,
  filePath: string,
): Record<string, unknown> | null {
  const content = readTextFile(files, filePath);
  if (content === null) return null;
  try {
    const parsed: unknown = JSON.parse(content);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function readString(
  value: Readonly<Record<string, unknown>>,
  key: string,
): string | undefined {
  const entry = value[key];
  return typeof entry === 'string' ? entry : undefined;
}

export function readStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const result: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string') return undefined;
    result.push(entry);
  }
  return result;
}

export function isStringRecord(
  value: unknown,
): value is Record<string, string> {
  return (
    isRecord(value) &&
    Object.values(value).every((entry) => typeof entry === 'string')
  );
}

export function directMarkdownFiles(
  files: ReadonlyMap<string, PluginFileContent>,
  pathOrDirectory: string,
): string[] {
  if (files.has(pathOrDirectory)) {
    return pathOrDirectory.endsWith('.md') ? [pathOrDirectory] : [];
  }
  const prefix = pathOrDirectory.length > 0 ? `${pathOrDirectory}/` : '';
  const results: string[] = [];
  for (const filePath of Array.from(files.keys())) {
    if (!filePath.startsWith(prefix)) continue;
    const remainder = filePath.slice(prefix.length);
    if (!remainder.includes('/') && remainder.endsWith('.md')) {
      results.push(filePath);
    }
  }
  return results.sort((left, right) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
}

export function directChildDirectories(
  files: ReadonlyMap<string, PluginFileContent>,
  directory: string,
): string[] {
  const prefix = directory.length > 0 ? `${directory}/` : '';
  const results = new Set<string>();
  for (const filePath of Array.from(files.keys())) {
    if (!filePath.startsWith(prefix)) continue;
    const remainder = filePath.slice(prefix.length);
    const slashIndex = remainder.indexOf('/');
    if (slashIndex > 0) results.add(remainder.slice(0, slashIndex));
  }
  return Array.from(results).sort((left, right) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
}

export function filesBelow(
  files: ReadonlyMap<string, PluginFileContent>,
  directory: string,
): Array<[string, PluginFileContent]> {
  const prefix = directory.length > 0 ? `${directory}/` : '';
  return Array.from(files.entries())
    .filter(([filePath]) => filePath.startsWith(prefix))
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
}
