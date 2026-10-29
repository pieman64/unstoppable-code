import { readdirSync, readFileSync, type Dirent } from 'node:fs';
import { join, relative, resolve } from 'node:path';

/**
 * Repo-wide sweep guarding the thinking-level vocabulary's single home,
 * `packages/protocol/src/thinking`. It lives HERE, next to the other Node-only
 * repo sweeps (`brand-audit`, `no-billing-source-copy`), because
 * `packages/protocol` must stay free of Node filesystem/path/process imports
 * — the very package the sweep protects may not host the sweep.
 */
const REPO_ROOT = resolve(__dirname, '../../../..');
const CANONICAL_DIR = join(
  REPO_ROOT,
  'packages',
  'protocol',
  'src',
  'thinking',
);
const ALLOWLIST = new Set<string>();
const THINKING_PAIR =
  /\[[^\]]*?(?:'xhigh'[\s\S]{0,80}?'max'|'max'[\s\S]{0,80}?'xhigh')[^\]]*?\]/;

function isSkipped(path: string): boolean {
  return (
    path.includes('/node_modules/') ||
    path.includes('/__tests__/') ||
    path.includes('/generated/') ||
    path.startsWith(CANONICAL_DIR)
  );
}

function sourceFiles(path: string): string[] {
  if (isSkipped(path)) return [];
  const entries: Dirent[] = readdirSync(path, { withFileTypes: true });
  return entries.flatMap((entry) => {
    const child = join(path, entry.name);
    if (isSkipped(child)) return [];
    if (entry.isDirectory()) return sourceFiles(child);
    return /\.[cm]?[jt]sx?$/.test(entry.name) ? [child] : [];
  });
}

function sourceRoots(): string[] {
  const packageRoot = join(REPO_ROOT, 'packages');
  const packageSources = readdirSync(packageRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(packageRoot, entry.name, 'src'))
    .filter((path) => {
      try {
        return readdirSync(path).length >= 0;
      } catch {
        return false;
      }
    });
  return [
    ...packageSources,
    join(REPO_ROOT, 'apps', 'desktop-app', 'src'),
  ];
}

describe('thinking vocabulary ownership', () => {
  it('has no thinking-level array literals outside protocol/thinking', () => {
    const duplicates = sourceRoots()
      .flatMap(sourceFiles)
      .filter((path) => !ALLOWLIST.has(relative(REPO_ROOT, path)))
      .filter((path) => THINKING_PAIR.test(readFileSync(path, 'utf8')))
      .map((path) => relative(REPO_ROOT, path))
      .sort();

    expect(duplicates).toEqual([]);
  });
});
