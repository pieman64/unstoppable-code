import { lstat, readdir, realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { getCoworkManagedDirCandidates } from '@canopy/desktop-shared/node/lib/cowork-managed-dir';
import { MAX_SHARED_CONTAINER_ARTIFACT_BYTES } from '@canopy/protocol/shared-containers';
import type { SharedContainerFileScope } from '@canopy/desktop-shared/types';
import type { SharedContainerType } from '@canopy/protocol/shared-containers';
import { fileScopeIsAllowlist } from '@canopy/desktop-shared/lib/shared-container-scope-mode';
import { resolveCoworkWorkspaceId } from '../../lib/cowork-migration-map';
import { getCoworkWorkspaceRootDir } from '../../lib/paths';
import { readChatTabsFileForIndex } from '../../lib/chat-tabs-reader';
import { createOutputPathDomain } from './artifacts';
import { isCredentialShapedSharedContainerPath } from './path-withholding';

export const MAX_COWORK_CANDIDATE_FILES = 1_000;

export const COWORK_FILE_NOISE_DIRECTORY_NAMES = new Set([
  '__pycache__',
  'build',
  'coverage',
  'dist',
  'node_modules',
  'out',
  'target',
]);

const COWORK_RECIPIENT_RESERVED_ROOTS = [
  'attachments',
  'chats',
  'notes',
  'prompts',
] as const;

function isCoworkNoiseDirectoryName(name: string): boolean {
  return (
    name.startsWith('.') ||
    COWORK_FILE_NOISE_DIRECTORY_NAMES.has(name.toLowerCase())
  );
}

function isInsideCoworkNoiseDirectory(path: string): boolean {
  return path.split('/').slice(0, -1).some(isCoworkNoiseDirectoryName);
}

export interface CoworkCandidateFiles {
  paths: string[];
  sizeBytesByPath?: Record<string, number>;
  /** Raw filesystem spelling for an NFC-normalized candidate path. */
  sourcePathByPath?: Record<string, string>;
  withheldFileCount: number;
}

export function selectCoworkCandidatePaths(
  candidates: readonly string[],
  scope: SharedContainerFileScope,
  limit: number,
  sizeBytesByPath: Readonly<Record<string, number>> = {},
  byteLimit = Number.POSITIVE_INFINITY,
): string[] {
  return selectSharedContainerCandidatePaths(
    'COWORK_WORK_ENTRY',
    candidates,
    scope,
    limit,
    sizeBytesByPath,
    byteLimit,
  );
}

export function selectSharedContainerCandidatePaths(
  containerType: SharedContainerType,
  candidates: readonly string[],
  scope: SharedContainerFileScope,
  limit: number,
  sizeBytesByPath: Readonly<Record<string, number>> = {},
  byteLimit = Number.POSITIVE_INFINITY,
): string[] {
  const legacyAllowlist = fileScopeIsAllowlist(containerType, scope);
  const includedPaths = new Set(scope.includedPaths);
  const excludedPaths = new Set(scope.excludedPaths ?? []);
  const selected: string[] = [];
  let selectedBytes = 0;
  for (const path of candidates) {
    if (legacyAllowlist ? !includedPaths.has(path) : excludedPaths.has(path)) {
      continue;
    }
    if (legacyAllowlist) {
      selected.push(path);
      continue;
    }
    if (selected.length >= Math.max(0, limit)) break;
    const sizeBytes = Math.max(0, sizeBytesByPath[path] ?? 0);
    if (selectedBytes + sizeBytes > Math.max(0, byteLimit)) continue;
    selected.push(path);
    selectedBytes += sizeBytes;
  }
  return selected;
}

function collectReferencedStrings(value: unknown, output: Set<string>): void {
  if (typeof value === 'string') {
    output.add(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectReferencedStrings(item, output);
    return;
  }
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) {
      collectReferencedStrings(item, output);
    }
  }
}

function isUsableReferencedPath(value: string): boolean {
  if (value.includes('\0')) return false;
  const segments = value.split(/[\\/]/);
  const pathSegments = segments[0] === '' ? segments.slice(1) : segments;
  return (
    pathSegments.length > 0 &&
    pathSegments.every(
      (segment) => segment.length > 0 && Buffer.byteLength(segment) <= 255,
    )
  );
}

export async function listCoworkCandidateFiles(
  projectId: string,
  worktreeId: string,
  requiredPaths: readonly string[] = [],
): Promise<CoworkCandidateFiles> {
  const workspaceId = resolveCoworkWorkspaceId(projectId);
  const requestedRoot = resolve(getCoworkWorkspaceRootDir(workspaceId));
  let root: string;
  try {
    root = await realpath(requestedRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { paths: [], withheldFileCount: 0 };
    }
    throw error;
  }
  const managedDirs = getCoworkManagedDirCandidates(root);
  const canonicalManagedDirs = await Promise.all(
    managedDirs.map(async (managedDir) => {
      try {
        return await realpath(managedDir);
      } catch {
        return managedDir;
      }
    }),
  );
  const references = new Set<string>();
  try {
    const metadata = await readChatTabsFileForIndex(projectId, worktreeId);
    const { getChatStateService } =
      await import('../../services/chat-state-service');
    for (const tab of metadata.tabs) {
      if (tab.kind === 'file') continue;
      await getChatStateService().consumeTranscript(
        { projectId, worktreeId },
        tab.id,
        false,
        async (rows) => {
          for await (const message of rows)
            collectReferencedStrings(message, references);
        },
        { inlineDelegationChildren: true },
      );
    }
  } catch {
    // A missing/corrupt chat file contributes no reference signal. Recent
    // workspace files remain available as candidates.
  }
  const referencedRelative = new Set<string>();
  for (const value of Array.from(references)) {
    if (!isUsableReferencedPath(value)) continue;
    const requestedRelative = isAbsolute(value)
      ? relative(requestedRoot, value)
      : value;
    const absolutePath =
      requestedRelative !== '..' &&
      !requestedRelative.startsWith(`..${sep}`) &&
      !isAbsolute(requestedRelative)
        ? resolve(root, requestedRelative)
        : resolve(value);
    if (!absolutePath.startsWith(`${root}${sep}`)) continue;
    referencedRelative.add(
      relative(root, absolutePath).split(sep).join('/').normalize('NFC'),
    );
  }
  const requiredRelative = new Set<string>();
  for (const value of requiredPaths) {
    if (!isUsableReferencedPath(value)) continue;
    const absolutePath = resolve(root, value);
    if (!absolutePath.startsWith(`${root}${sep}`)) continue;
    requiredRelative.add(
      relative(root, absolutePath).split(sep).join('/').normalize('NFC'),
    );
  }

  const outputPathDomain = createOutputPathDomain();
  for (const reservedRoot of COWORK_RECIPIENT_RESERVED_ROOTS) {
    outputPathDomain.reserve(reservedRoot);
  }
  const discovered: Array<{
    path: string;
    sourcePath: string;
    mtimeMs: number;
    sizeBytes: number;
  }> = [];
  const discoveredPaths = new Set<string>();
  const requiredCandidates = new Map<
    string,
    { path: string; sourcePath: string; mtimeMs: number; sizeBytes: number }
  >();
  const handledCanonicalPaths = new Set<string>();
  let withheldFileCount = 0;
  const compareCandidates = (
    left: { path: string; mtimeMs: number },
    right: { path: string; mtimeMs: number },
  ): number =>
    Number(referencedRelative.has(right.path)) -
      Number(referencedRelative.has(left.path)) ||
    right.mtimeMs - left.mtimeMs ||
    left.path.localeCompare(right.path);
  const retainCandidate = (candidate: {
    path: string;
    sourcePath: string;
    mtimeMs: number;
    sizeBytes: number;
  }): void => {
    if (discoveredPaths.has(candidate.path)) return;
    let lower = 0;
    let upper = discovered.length;
    while (lower < upper) {
      const middle = Math.floor((lower + upper) / 2);
      if (compareCandidates(candidate, discovered[middle]) < 0) upper = middle;
      else lower = middle + 1;
    }
    if (lower >= MAX_COWORK_CANDIDATE_FILES) return;
    discovered.splice(lower, 0, candidate);
    discoveredPaths.add(candidate.path);
    if (discovered.length > MAX_COWORK_CANDIDATE_FILES) {
      const removed = discovered.pop();
      if (removed) discoveredPaths.delete(removed.path);
    }
  };
  const inspectCandidate = async (
    absolutePath: string,
    sourcePath: string,
  ): Promise<void> => {
    try {
      const info = await stat(absolutePath);
      if (!info.isFile()) return;
      const canonicalPath = await realpath(absolutePath);
      if (handledCanonicalPaths.has(canonicalPath)) return;
      handledCanonicalPaths.add(canonicalPath);
      const path = sourcePath.normalize('NFC');
      if (
        !canonicalPath.startsWith(`${root}${sep}`) ||
        canonicalManagedDirs.some(
          (managedDir) =>
            canonicalPath === managedDir ||
            canonicalPath.startsWith(`${managedDir}${sep}`),
        )
      ) {
        withheldFileCount += 1;
      } else if (info.nlink > 1) {
        withheldFileCount += 1;
      } else if (isCredentialShapedSharedContainerPath(path)) {
        withheldFileCount += 1;
      } else if (info.size > MAX_SHARED_CONTAINER_ARTIFACT_BYTES) {
        withheldFileCount += 1;
      } else {
        try {
          outputPathDomain.reserve(path);
          const candidate = {
            path,
            sourcePath,
            mtimeMs: info.mtimeMs,
            sizeBytes: info.size,
          };
          if (requiredRelative.has(path))
            requiredCandidates.set(path, candidate);
          else retainCandidate(candidate);
        } catch {
          withheldFileCount += 1;
        }
      }
    } catch {
      // Candidate ranking is best-effort. A single unreadable or unstable
      // entry must not discard the rest of the workspace preview.
    }
  };

  for (const path of Array.from(requiredRelative)) {
    if (isInsideCoworkNoiseDirectory(path)) continue;
    await inspectCandidate(resolve(root, ...path.split('/')), path);
  }

  for (const path of Array.from(referencedRelative)) {
    if (isInsideCoworkNoiseDirectory(path)) continue;
    const absolutePath = resolve(root, ...path.split('/'));
    if (
      managedDirs.some(
        (managedDir) =>
          absolutePath === managedDir ||
          absolutePath.startsWith(`${managedDir}${sep}`),
      )
    ) {
      continue;
    }
    try {
      const info = await lstat(absolutePath);
      if (info.isFile() && !info.isSymbolicLink()) {
        await inspectCandidate(absolutePath, path);
      }
    } catch {
      // A transcript string is merely a ranking hint, not a required file.
    }
  }

  const visit = async (directory: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      withheldFileCount += 1;
      return;
    }
    for (const entry of entries) {
      const absolutePath = resolve(directory, entry.name);
      if (!absolutePath.startsWith(`${root}${sep}`)) continue;
      if (
        managedDirs.some(
          (managedDir) =>
            absolutePath === managedDir ||
            absolutePath.startsWith(`${managedDir}${sep}`),
        )
      ) {
        continue;
      }
      const path = relative(root, absolutePath).split(sep).join('/');
      if (entry.isDirectory()) {
        if (isCoworkNoiseDirectoryName(entry.name)) {
          withheldFileCount += 1;
          continue;
        }
        await visit(absolutePath);
      } else if (entry.isFile()) {
        await inspectCandidate(absolutePath, path);
      } else if (entry.isSymbolicLink()) {
        withheldFileCount += 1;
      }
    }
  };
  await visit(root);

  const retained = [...Array.from(requiredCandidates.values()), ...discovered];
  return {
    paths: retained.map((entry) => entry.path),
    sizeBytesByPath: Object.fromEntries(
      retained.map((entry) => [entry.path, entry.sizeBytes]),
    ),
    sourcePathByPath: Object.fromEntries(
      retained.map((entry) => [entry.path, entry.sourcePath]),
    ),
    withheldFileCount,
  };
}
