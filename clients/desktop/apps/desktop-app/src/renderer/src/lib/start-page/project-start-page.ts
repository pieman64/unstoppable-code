import type { FileTreeRoot } from '@canopy/desktop-shared/types';
import { WORKSPACE_ROOT_REPO_ID } from '@canopy/desktop-shared/types';
import type { ProjectStartPage } from '@canopy/protocol/start-page';
import { joinRoot, pathInsideRoot } from '@/lib/show-files';

export type StartPageProjectType = 'cowork' | 'single-repo' | 'multi-repo';

const HTML_EXTENSION = /\.html?$/i;

function toPosix(path: string): string {
  return path.replace(/\\/g, '/');
}

function basename(path: string): string {
  const segments = toPosix(path).split('/').filter(Boolean);
  return segments[segments.length - 1] ?? path;
}

/** Short user-facing label: the file name, or the URL without its scheme. */
export function startPageLabel(startPage: ProjectStartPage): string {
  if (startPage.kind === 'file') return basename(startPage.path);
  try {
    const url = new URL(startPage.url);
    const path = url.pathname === '/' ? '' : url.pathname;
    return `${url.host}${path}${url.search}`;
  } catch {
    return startPage.url;
  }
}

export function isHtmlStartPagePath(path: string): boolean {
  return HTML_EXTENSION.test(path);
}

function normalizedRepoId(startPage: ProjectStartPage): string | undefined {
  return startPage.kind === 'file' ? startPage.repoId : undefined;
}

export function startPagesEqual(
  a: ProjectStartPage | null | undefined,
  b: ProjectStartPage | null | undefined,
): boolean {
  if (!a || !b) return (a ?? null) === (b ?? null);
  if (a.kind === 'url' || b.kind === 'url') {
    return a.kind === 'url' && b.kind === 'url' && a.url === b.url;
  }
  return (
    toPosix(a.path) === toPosix(b.path) &&
    normalizedRepoId(a) === normalizedRepoId(b)
  );
}

/**
 * Pick the file root a stored start page is relative to. Single-repo and
 * cowork values omit `repoId`, so the first root is theirs; multi-repo values
 * without one fall back to the workspace root.
 */
function rootForStartPage(
  startPage: Extract<ProjectStartPage, { kind: 'file' }>,
  roots: readonly FileTreeRoot[],
): FileTreeRoot | null {
  if (startPage.repoId !== undefined) {
    return roots.find((root) => root.repoId === startPage.repoId) ?? null;
  }
  if (roots.length <= 1) return roots[0] ?? null;
  return (
    roots.find((root) => root.repoId === WORKSPACE_ROOT_REPO_ID) ??
    roots[0] ??
    null
  );
}

/** Absolute path of a file start page inside the worktree, or null. */
export function resolveStartPageAbsolutePath(
  startPage: ProjectStartPage,
  roots: readonly FileTreeRoot[],
): string | null {
  if (startPage.kind !== 'file') return null;
  const root = rootForStartPage(startPage, roots);
  if (!root) return null;
  const joined = joinRoot(root.absolutePath, startPage.path);
  return joined && pathInsideRoot(joined, root.absolutePath) ? joined : null;
}

/**
 * Convert an absolute path under one of the worktree's file roots into a
 * portable start page. Single-repo and cowork projects omit `repoId`.
 */
export function startPageFromAbsolutePath(
  absolutePath: string,
  roots: readonly FileTreeRoot[],
  projectType: StartPageProjectType,
): ProjectStartPage | null {
  let best: FileTreeRoot | null = null;
  for (const root of roots) {
    if (!pathInsideRoot(absolutePath, root.absolutePath)) continue;
    if (!best || root.absolutePath.length > best.absolutePath.length) {
      best = root;
    }
  }
  if (!best) return null;
  const rootPath = toPosix(best.absolutePath).replace(/\/+$/, '');
  const relative = toPosix(absolutePath).slice(rootPath.length + 1);
  if (!relative) return null;
  return projectType === 'multi-repo'
    ? { kind: 'file', repoId: best.repoId, path: relative }
    : { kind: 'file', path: relative };
}

/** Absolute path for a `file:` URL, or null for any other scheme. */
export function fileUrlToAbsolutePath(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'file:') return null;
  const pathname = decodeURIComponent(parsed.pathname);
  // `file:///C:/x` parses to `/C:/x` on Windows paths.
  return /^\/[a-z]:\//i.test(pathname) ? pathname.slice(1) : pathname;
}

/** Convert a browser tab URL into a supported portable start page. */
export function startPageFromBrowserUrl(
  url: string,
  roots: readonly FileTreeRoot[],
  projectType: StartPageProjectType,
): ProjectStartPage | null {
  const absolutePath = fileUrlToAbsolutePath(url);
  if (absolutePath) {
    return startPageFromAbsolutePath(absolutePath, roots, projectType);
  }
  return isHttpStartPageUrl(url) ? { kind: 'url', url } : null;
}

export function isHttpStartPageUrl(value: string): boolean {
  try {
    const url = new URL(value.trim());
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}
