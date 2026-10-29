import { constants } from 'node:fs';
import {
  cp,
  copyFile,
  link,
  lstat,
  mkdtemp,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  rmdir,
  rm,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import {
  basename,
  dirname,
  extname,
  join,
  posix,
  relative,
  resolve,
  sep,
  win32,
} from 'node:path';
import type {
  FileContentRequest,
  FileIndexRequest,
  FileIndexResponse,
  FileTreeDirectoryRequest,
  FileTreeDirectoryResponse,
  FileTreeMutationRequest,
  FileTreeMutationResponse,
  FileTreeRoot,
  FileTreeRootsRequest,
  FileTreeRootsResponse,
  PortalDirectoryListing,
  PortalFileReadPayload,
  PortalFileLinkResolvePayload,
  PortalFileLinkResolution,
  PortalFilePreview,
  PortalFileRoot,
  PortalFileSavePayload,
  PortalFileSnapshotPayload,
  SaveFileContentRequest,
  SaveFileContentResponse,
} from '@canopy/desktop-shared/types';
import { SHARED_CONTAINER_VIEWER_PROJECT_ID } from '@canopy/desktop-shared/types';
import { fileURLToPath } from 'node:url';
import {
  getFileBrowserRoots,
  type FileBrowserRoot,
} from '../lib/file-browser-roots';
import {
  buildFileExplorerGlobMatcher,
  buildFileGlobMatcher,
} from '../lib/file-glob-matcher';
import {
  buildFileIndexResult,
  listDirectory as listFilesystemDirectory,
  type FileSystemReadBoundary,
} from '../lib/file-system-listing';
import { readPreferencesFile } from '../lib/preferences-store';
import { resolveWorktreeTargetIds } from '../lib/resolve-worktree';
import { validateId, validateOptionalRepoId } from '../lib/validation';
import { normalizeFileTreeRelativePath as normalizeRelativePath } from './file-tree-relative-path';
import { assertWritableScope } from '../lib/read-only-scope';
import { PortalServiceError } from './portal-service-error';
import { assertNotSplitLocked } from './split-lock-service';
import {
  readSharedContainerViewerFile,
  resolveSharedContainerViewerFileForRead,
} from '../shared-containers/read/viewer-root';
import { getSharedContainerReader } from '../shared-containers/read/reader';

const MAX_PREVIEW_BYTES = 256 * 1024;
const MAX_SAVE_BYTES = 5 * 1024 * 1024;

function readBoundaryForRoot(
  root: FileBrowserRoot,
): FileSystemReadBoundary | undefined {
  if (!root.readBoundaryRoot) return undefined;
  const store = getSharedContainerReader().store;
  const revisionRoot = root.readBoundaryRoot;
  return {
    assertDirectory: (_listingRoot, target) =>
      store.assertRealDirectoryForRead(revisionRoot, target),
    readDirectory: (_listingRoot, target) =>
      store.readDirectoryForRead(revisionRoot, target),
    lstatEntry: (_listingRoot, target) =>
      store.lstatEntryForRead(revisionRoot, target),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function getErrorCode(error: unknown): string | undefined {
  return isRecord(error) && typeof error.code === 'string'
    ? error.code
    : undefined;
}

function isFileTreeMutationOperation(
  operation: unknown,
): operation is FileTreeMutationRequest['operation'] {
  return (
    operation === 'create-file' ||
    operation === 'create-directory' ||
    operation === 'copy' ||
    operation === 'move' ||
    operation === 'delete'
  );
}

function isPathInsideRoot(pathValue: string, rootPath: string): boolean {
  return pathValue === rootPath || pathValue.startsWith(`${rootPath}${sep}`);
}

function decodedTranscriptFilePath(
  href: string,
): { absolute: boolean; path: string } | null {
  const trimmed = href.trim();
  if (
    trimmed.length === 0 ||
    trimmed.length > 4096 ||
    trimmed.split('').some((character) => character.charCodeAt(0) < 32)
  ) {
    return null;
  }

  let decoded: string;
  if (/^file:/i.test(trimmed)) {
    try {
      const url = new URL(trimmed);
      if (
        url.protocol !== 'file:' ||
        (url.hostname && url.hostname !== 'localhost')
      ) {
        return null;
      }
      decoded = fileURLToPath(url);
    } catch {
      return null;
    }
  } else {
    const encodedPath = trimmed.split('#', 1)[0]?.split('?', 1)[0] ?? '';
    if (
      /^[a-z][a-z\d+.-]*:/i.test(encodedPath) &&
      !/^[a-z]:[\\/]/i.test(encodedPath)
    ) {
      return null;
    }
    if (/^[\\/]{2}/.test(encodedPath)) return null;
    try {
      decoded = decodeURIComponent(encodedPath);
    } catch {
      return null;
    }
  }

  if (decoded.length === 0 || decoded.includes('\0')) return null;
  const absolute = posix.isAbsolute(decoded) || win32.isAbsolute(decoded);
  if (!absolute) {
    try {
      decoded = normalizeRelativePath(decoded);
    } catch {
      return null;
    }
    if (!decoded) return null;
  }
  return { absolute, path: decoded };
}

/** Resolve an agent transcript link without exposing an unbounded file path. */
export async function resolvePortalFileLink(
  request: PortalFileLinkResolvePayload,
): Promise<PortalFileLinkResolution | null> {
  validateId(request.projectId, 'projectId');
  validateId(request.worktreeId, 'worktreeId');
  const link = decodedTranscriptFilePath(request.href);
  if (link === null) return null;
  const { roots } = await getFileBrowserRoots(
    request.projectId,
    request.worktreeId,
  );
  const matches: PortalFileLinkResolution[] = [];

  if (request.projectId === SHARED_CONTAINER_VIEWER_PROJECT_ID) {
    for (const root of roots) {
      if (link.absolute && !isPathInsideRoot(link.path, root.absolutePath)) {
        continue;
      }
      const candidatePath = link.absolute
        ? link.path
        : join(root.absolutePath, ...link.path.split('/'));
      try {
        const resolved = await resolveSharedContainerViewerFileForRead(
          request.worktreeId,
          candidatePath,
        );
        const info = await getSharedContainerReader().store.lstatEntryForRead(
          resolved.root.revisionRoot,
          resolved.target,
        );
        if (!info.isFile() || info.isSymbolicLink()) continue;
        matches.push({
          fileRootLocalId: resolved.root.repoId,
          relativePath: resolved.relativePath,
        });
      } catch {
        // Continue looking for one unambiguous declared replica path.
      }
    }
    return matches.length === 1 ? matches[0] : null;
  }

  for (const root of roots) {
    try {
      const rootReal = await realpath(root.absolutePath);
      const candidatePath = link.absolute
        ? link.path
        : join(root.absolutePath, ...link.path.split('/'));
      const targetReal = await resolveExistingFileInsideRoot(
        candidatePath,
        rootReal,
      );
      if (!(await stat(targetReal)).isFile()) continue;
      const relativePath = relative(rootReal, targetReal).split(sep).join('/');
      if (!relativePath || relativePath.startsWith('../')) continue;
      matches.push({
        fileRootLocalId: root.repoId,
        relativePath,
      });
    } catch {
      // A missing, unreadable, directory, or out-of-root candidate is not a
      // workspace file link. Other roots can still provide a unique match.
    }
  }

  return matches.length === 1 ? matches[0] : null;
}

async function resolveRoot(
  workspaceLocalId: string,
  worktreeLocalId: string,
  fileRootLocalId?: string,
  repoId?: string,
): Promise<FileBrowserRoot> {
  validateId(workspaceLocalId, 'workspaceLocalId');
  validateId(worktreeLocalId, 'worktreeLocalId');
  validateOptionalRepoId(fileRootLocalId, 'fileRootLocalId');
  validateOptionalRepoId(repoId, 'repoId');
  const { roots, rootMap } = await getFileBrowserRoots(
    workspaceLocalId,
    worktreeLocalId,
  );
  const rootHint = fileRootLocalId ?? repoId;
  if (!rootHint && roots.length !== 1) {
    throw new PortalServiceError(
      'invalid_target',
      'File root is ambiguous; provide fileRootLocalId or repoId.',
    );
  }
  const root = rootHint ? rootMap.get(rootHint) : roots[0];
  if (!root) {
    throw new PortalServiceError(
      'not_found',
      `Unknown file root: ${rootHint ?? 'default'}`,
    );
  }
  return root;
}

function languageForPath(pathValue: string): string | undefined {
  const extension = extname(pathValue).slice(1).toLowerCase();
  return extension || undefined;
}

function versionFromStat(stats: Awaited<ReturnType<typeof stat>>): string {
  return `${Number(stats.size)}:${Math.round(Number(stats.mtimeMs))}`;
}

export async function resolvePortalFileTarget(
  request: PortalFileReadPayload,
): Promise<{
  root: FileBrowserRoot;
  rootReal: string;
  relativePath: string;
  joinedAbsolutePath: string;
}> {
  const root = await resolveRoot(
    request.projectId,
    request.worktreeId,
    request.fileRootLocalId,
    request.repoId,
  );
  const relativePath = normalizeRelativePath(request.relativePath);
  const rootReal = await realpath(root.absolutePath);
  const joinedAbsolutePath = relativePath
    ? join(root.absolutePath, ...relativePath.split('/'))
    : root.absolutePath;
  return { root, rootReal, relativePath, joinedAbsolutePath };
}

export async function resolvePortalChatAssetFileTarget(input: {
  projectId: string;
  worktreeId: string;
  path: string;
}): Promise<FileBrowserRoot | null> {
  validateId(input.projectId, 'projectId');
  validateId(input.worktreeId, 'worktreeId');
  const { roots } = await getFileBrowserRoots(
    input.projectId,
    input.worktreeId,
  );
  const candidates = roots.filter(
    (root) =>
      isPathInsideRoot(input.path, root.absolutePath) &&
      !root.excludedDescendantRoots.some((excluded) =>
        isPathInsideRoot(input.path, excluded),
      ),
  );
  candidates.sort(
    (left, right) => right.absolutePath.length - left.absolutePath.length,
  );
  return candidates[0] ?? null;
}

async function resolveExistingFileInsideRoot(
  targetPath: string,
  rootReal: string,
): Promise<string> {
  const targetReal = await realpath(targetPath);
  if (!isPathInsideRoot(targetReal, rootReal)) {
    throw new PortalServiceError(
      'invalid_target',
      'File is outside the selected worktree root.',
    );
  }
  return targetReal;
}

async function resolveCreatableFileInsideRoot(
  targetPath: string,
  rootReal: string,
): Promise<string> {
  let cursor = targetPath;
  for (;;) {
    try {
      const ancestorReal = await realpath(cursor);
      if (!isPathInsideRoot(ancestorReal, rootReal)) {
        throw new PortalServiceError(
          'invalid_target',
          'File is outside the selected worktree root.',
        );
      }
      return targetPath;
    } catch (error) {
      if (error instanceof PortalServiceError) {
        throw error;
      }
      if (getErrorCode(error) !== 'ENOENT') {
        throw error;
      }
      const parent = dirname(cursor);
      if (parent === cursor) {
        throw error;
      }
      cursor = parent;
    }
  }
}

function rejectUnsupportedText(pathValue: string, content?: string): void {
  const extension = extname(pathValue).toLowerCase();
  const knownBinaryExtensions = new Set([
    '.exe',
    '.dll',
    '.so',
    '.dylib',
    '.a',
    '.o',
    '.lib',
    '.obj',
    '.class',
    '.jar',
    '.war',
    '.pyc',
    '.pyo',
    '.wasm',
    '.zip',
    '.tar',
    '.gz',
    '.tgz',
    '.bz2',
    '.xz',
    '.7z',
    '.rar',
    '.iso',
    '.dmg',
    '.pkg',
    '.deb',
    '.rpm',
    '.pdf',
    '.doc',
    '.docx',
    '.xls',
    '.xlsx',
    '.ppt',
    '.pptx',
    '.odt',
    '.ods',
    '.odp',
    '.rtf',
    '.ico',
    '.icns',
    '.ttf',
    '.otf',
    '.woff',
    '.woff2',
    '.eot',
    '.mp3',
    '.mp4',
    '.m4a',
    '.m4v',
    '.mov',
    '.avi',
    '.mkv',
    '.webm',
    '.wav',
    '.flac',
    '.ogg',
    '.opus',
    '.aac',
    '.wma',
    '.psd',
    '.ai',
    '.sketch',
    '.fig',
    '.blend',
    '.fbx',
    '.stl',
    '.db',
    '.sqlite',
    '.sqlite3',
    '.mdb',
    '.bin',
    '.dat',
    '.pack',
    '.idx',
  ]);
  if (knownBinaryExtensions.has(extension)) {
    throw new PortalServiceError(
      'invalid_target',
      'Binary files cannot be read or saved.',
    );
  }
  if (content?.includes('\0')) {
    throw new PortalServiceError(
      'invalid_payload',
      'File content cannot contain null bytes.',
    );
  }
}

export async function listFileRoots(
  request: FileTreeRootsRequest,
): Promise<PortalFileRoot[]> {
  validateId(request.projectId, 'projectId');
  validateId(request.worktreeId, 'worktreeId');
  const { roots } = await getFileBrowserRoots(
    request.projectId,
    request.worktreeId,
  );
  return roots.map((root) => ({
    workspaceLocalId: request.projectId,
    worktreeLocalId: request.worktreeId,
    fileRootLocalId: root.repoId,
    label: root.repoName,
    absolutePath: root.absolutePath,
  }));
}

function toPublicRoot(root: FileBrowserRoot): FileTreeRoot {
  return {
    repoId: root.repoId,
    repoName: root.repoName,
    absolutePath: root.absolutePath,
    rootKind: root.rootKind,
  };
}

export async function listFileTreeRoots(
  request: FileTreeRootsRequest,
): Promise<FileTreeRootsResponse> {
  validateId(request.projectId, 'projectId');
  validateId(request.worktreeId, 'worktreeId');
  const { roots } = await getFileBrowserRoots(
    request.projectId,
    request.worktreeId,
  );
  return { roots: roots.map(toPublicRoot) };
}

interface FileIndexBuildSlot {
  running: Promise<FileIndexResponse>;
  next: Promise<FileIndexResponse> | null;
}

/**
 * Index walks in progress, by request. A worktree walk can take seconds and
 * Home, the explorer, and mentions often ask for the same index together. A
 * request made while a walk runs joins the one walk queued behind it, so a
 * burst costs at most two walks and every caller still gets a walk that
 * started after its request (a file created just before it is included).
 */
const fileIndexBuilds = new Map<string, FileIndexBuildSlot>();

function startFileIndexBuild(
  key: string,
  build: () => Promise<FileIndexResponse>,
): Promise<FileIndexResponse> {
  const slot: FileIndexBuildSlot = { running: build(), next: null };
  fileIndexBuilds.set(key, slot);
  const settle = (): void => {
    if (fileIndexBuilds.get(key) === slot) fileIndexBuilds.delete(key);
  };
  void slot.running.then(settle, settle);
  return slot.running;
}

function buildFileIndexFresh(
  key: string,
  build: () => Promise<FileIndexResponse>,
): Promise<FileIndexResponse> {
  const slot = fileIndexBuilds.get(key);
  if (!slot) return startFileIndexBuild(key, build);
  slot.next ??= slot.running.then(
    () => startFileIndexBuild(key, build),
    () => startFileIndexBuild(key, build),
  );
  return slot.next;
}

export async function buildFileIndexes(
  request: FileIndexRequest,
  options?: {
    /**
     * When set, index only the root whose repoId matches — used by the Home
     * surface to scope a multi-repo worktree index to the composer's
     * selected working directory. Unknown ids yield an empty index.
     */
    repoId?: string;
  },
): Promise<FileIndexResponse> {
  validateId(request.projectId, 'projectId');
  validateId(request.worktreeId, 'worktreeId');
  validateOptionalRepoId(options?.repoId, 'repoId');
  const key = [
    request.projectId,
    request.worktreeId,
    request.purpose ?? '',
    options?.repoId ?? '',
  ].join('\0');
  return buildFileIndexFresh(key, () => walkFileIndexes(request, options));
}

async function walkFileIndexes(
  request: FileIndexRequest,
  options?: { repoId?: string },
): Promise<FileIndexResponse> {
  const [{ roots: allRoots }, preferences] = await Promise.all([
    getFileBrowserRoots(request.projectId, request.worktreeId),
    readPreferencesFile(),
  ]);
  const roots = options?.repoId
    ? allRoots.filter((root) => root.repoId === options.repoId)
    : allRoots;
  const globMatcher =
    request.purpose === 'file-explorer'
      ? buildFileExplorerGlobMatcher()
      : buildFileGlobMatcher(preferences.fileIndexing);
  const maxEntriesPerRoot =
    request.purpose === 'file-explorer'
      ? Math.max(1, Math.floor(25_000 / Math.max(1, roots.length)))
      : Number.POSITIVE_INFINITY;
  return {
    repos: await Promise.all(
      roots.map(async (root) => {
        const readBoundary = readBoundaryForRoot(root);
        const index = await buildFileIndexResult(
          root.absolutePath,
          {
            gitAware: root.gitAware,
            globMatcher,
            excludedDescendantRoots: root.excludedDescendantRoots,
            ...(readBoundary ? { readBoundary } : {}),
          },
          maxEntriesPerRoot,
        );
        return {
          repoId: root.repoId,
          repoName: root.repoName,
          absolutePath: root.absolutePath,
          rootKind: root.rootKind,
          files: index.files,
          truncated: index.truncated,
        };
      }),
    ),
  };
}

export async function listDirectory(
  request: FileTreeDirectoryRequest,
): Promise<PortalDirectoryListing> {
  const root = await resolveRoot(
    request.projectId,
    request.worktreeId,
    request.repoId,
  );
  const relativeDir = normalizeRelativePath(request.relativeDir);
  const preferences = await readPreferencesFile();
  const globMatcher = buildFileGlobMatcher(preferences.fileIndexing);
  const readBoundary = readBoundaryForRoot(root);
  const entries = await listFilesystemDirectory(
    root.absolutePath,
    relativeDir,
    {
      gitAware: root.gitAware,
      globMatcher,
      excludedDescendantRoots: root.excludedDescendantRoots,
      ...(readBoundary ? { readBoundary } : {}),
    },
  );
  return {
    workspaceLocalId: request.projectId,
    worktreeLocalId: request.worktreeId,
    fileRootLocalId: root.repoId,
    path: relativeDir,
    entries: entries
      .map((entry): PortalDirectoryListing['entries'][number] => ({
        name: entry.name,
        path: entry.relativePath,
        type: entry.kind === 'directory' ? 'directory' : 'file',
      }))
      .sort((left, right) =>
        left.type === right.type
          ? left.name.localeCompare(right.name)
          : left.type === 'directory'
            ? -1
            : 1,
      ),
  };
}

export async function listFileTreeDirectory(
  request: FileTreeDirectoryRequest,
): Promise<FileTreeDirectoryResponse> {
  validateId(request.projectId, 'projectId');
  validateId(request.worktreeId, 'worktreeId');
  validateOptionalRepoId(request.repoId, 'repoId');
  const root = await resolveRoot(
    request.projectId,
    request.worktreeId,
    request.repoId,
  );
  const relativeDir = normalizeRelativePath(request.relativeDir);
  const preferences = await readPreferencesFile();
  const globMatcher = buildFileGlobMatcher(preferences.fileIndexing);
  const readBoundary = readBoundaryForRoot(root);
  return {
    entries: await listFilesystemDirectory(root, relativeDir, {
      gitAware: root.gitAware,
      globMatcher,
      ...(readBoundary ? { readBoundary } : {}),
    }),
  };
}

function requireMutableRelativePath(value: string, label: string): string {
  const normalized = normalizeRelativePath(value);
  if (!normalized) {
    throw new PortalServiceError(
      'invalid_target',
      `${label} cannot be a file-tree root.`,
    );
  }
  return normalized;
}

async function pathExists(pathValue: string): Promise<boolean> {
  try {
    await lstat(pathValue);
    return true;
  } catch (error) {
    if (getErrorCode(error) === 'ENOENT') return false;
    throw error;
  }
}

function isNestedPath(sourcePath: string, targetPath: string): boolean {
  const normalizeCase = (value: string): string =>
    process.platform === 'win32' ? value.toLowerCase() : value;
  const relativePath = relative(
    normalizeCase(sourcePath),
    normalizeCase(targetPath),
  );
  return (
    relativePath !== '' &&
    relativePath !== '..' &&
    !relativePath.startsWith(`..${sep}`) &&
    !win32.isAbsolute(relativePath) &&
    !posix.isAbsolute(relativePath)
  );
}

async function isCaseOnlyRename(
  sourcePath: string,
  targetPath: string,
): Promise<boolean> {
  if (
    sourcePath === targetPath ||
    sourcePath.toLowerCase() !== targetPath.toLowerCase()
  ) {
    return false;
  }
  const [sourceStats, targetStats] = await Promise.all([
    lstat(sourcePath),
    lstat(targetPath),
  ]);
  const targetHasDistinctDirectoryEntry = (
    await readdir(dirname(targetPath))
  ).includes(basename(targetPath));
  return (
    !sourceStats.isSymbolicLink() &&
    !targetStats.isSymbolicLink() &&
    !targetHasDistinctDirectoryEntry &&
    sourceStats.dev === targetStats.dev &&
    sourceStats.ino === targetStats.ino
  );
}

async function assertTreeHasNoSymlinks(pathValue: string): Promise<void> {
  const stats = await lstat(pathValue);
  if (stats.isSymbolicLink()) {
    throw new PortalServiceError(
      'invalid_target',
      'Cross-root transfers cannot contain symlinks.',
    );
  }
  if (!stats.isDirectory()) return;
  for (const entry of await readdir(pathValue)) {
    await assertTreeHasNoSymlinks(join(pathValue, entry));
  }
}

function incrementalCopyPath(
  relativePath: string,
  copyNumber: number,
  isDirectory: boolean,
): string {
  const directory = posix.dirname(relativePath);
  const filename = posix.basename(relativePath);
  const extension = isDirectory ? '' : posix.extname(filename);
  const stem = extension ? filename.slice(0, -extension.length) : filename;
  const suffix = copyNumber === 1 ? ' copy' : ` copy ${copyNumber}`;
  const nextName = `${stem}${suffix}${extension}`;
  return directory === '.' ? nextName : posix.join(directory, nextName);
}

async function resolveAvailableCopyTarget(
  root: FileBrowserRoot,
  requestedRelativePath: string,
  isDirectory: boolean,
): Promise<{ relativePath: string; absolutePath: string }> {
  let relativePath = requestedRelativePath;
  let copyNumber = 0;
  for (;;) {
    const absolutePath = join(root.absolutePath, ...relativePath.split('/'));
    if (!(await pathExists(absolutePath))) {
      return { relativePath, absolutePath };
    }
    copyNumber += 1;
    relativePath = incrementalCopyPath(
      requestedRelativePath,
      copyNumber,
      isDirectory,
    );
  }
}

function throwMoveConflict(targetRelativePath: string): never {
  throw new PortalServiceError(
    'invalid_target',
    `A file or folder already exists at ${targetRelativePath}.`,
  );
}

async function copyForTransfer(
  sourcePath: string,
  targetPath: string,
): Promise<void> {
  await cp(sourcePath, targetPath, {
    recursive: true,
    errorOnExist: true,
    force: false,
    preserveTimestamps: true,
    verbatimSymlinks: true,
  });
}

/**
 * Performs one explorer mutation after resolving both endpoints against the
 * live workspace roots. Every path remains relative over IPC; realpath checks
 * reject traversal and symlink escapes before the filesystem is touched.
 */
export async function mutateFileTree(
  request: FileTreeMutationRequest,
  options?: {
    trashItem?: (absolutePath: string) => Promise<void>;
    beforeMove?: () => Promise<void>;
    copyEntry?: (sourcePath: string, targetPath: string) => Promise<void>;
    renameEntry?: typeof rename;
    linkEntry?: (sourcePath: string, targetPath: string) => Promise<void>;
    publishRenameEntry?: typeof rename;
    publishLinkEntry?: (
      sourcePath: string,
      targetPath: string,
    ) => Promise<void>;
    unlinkEntry?: (pathValue: string) => Promise<void>;
    removeEntry?: (
      pathValue: string,
      options: { recursive: true; force: false },
    ) => Promise<void>;
  },
): Promise<FileTreeMutationResponse> {
  if (!isFileTreeMutationOperation(request?.operation)) {
    throw new PortalServiceError(
      'invalid_payload',
      'Unsupported file-tree mutation operation.',
    );
  }
  validateId(request.projectId, 'projectId');
  validateId(request.worktreeId, 'worktreeId');
  assertWritableScope(request.projectId);
  const splitLockTarget = resolveWorktreeTargetIds(
    request.projectId,
    request.worktreeId,
  );
  if (!splitLockTarget) {
    throw new PortalServiceError(
      'invalid_target',
      'Managed file-tree target could not be resolved.',
    );
  }
  assertNotSplitLocked(
    splitLockTarget.projectId,
    splitLockTarget.worktreeId,
    'updating files',
  );

  if (
    request.operation === 'create-file' ||
    request.operation === 'create-directory'
  ) {
    const root = await resolveRoot(
      request.projectId,
      request.worktreeId,
      request.target.repoId,
    );
    const relativePath = requireMutableRelativePath(
      request.target.relativePath,
      'Create target',
    );
    const rootReal = await realpath(root.absolutePath);
    const targetPath = join(root.absolutePath, ...relativePath.split('/'));
    await resolveCreatableFileInsideRoot(targetPath, rootReal);
    if (request.operation === 'create-directory') {
      await mkdir(dirname(targetPath), { recursive: true });
      await mkdir(targetPath, { recursive: false });
    } else {
      await mkdir(dirname(targetPath), { recursive: true });
      await writeFile(targetPath, '', { flag: 'wx' });
    }
    return {
      operation: request.operation,
      target: { repoId: root.repoId, relativePath },
    };
  }

  if (request.operation === 'delete') {
    const root = await resolveRoot(
      request.projectId,
      request.worktreeId,
      request.target.repoId,
    );
    const relativePath = requireMutableRelativePath(
      request.target.relativePath,
      'Delete target',
    );
    const rootReal = await realpath(root.absolutePath);
    const targetPath = join(root.absolutePath, ...relativePath.split('/'));
    await resolveExistingFileInsideRoot(targetPath, rootReal);
    if (request.useTrash && options?.trashItem) {
      await options.trashItem(targetPath);
    } else {
      await rm(targetPath, { recursive: true, force: false });
    }
    return {
      operation: request.operation,
      target: { repoId: root.repoId, relativePath },
    };
  }

  if (!('source' in request)) {
    throw new PortalServiceError(
      'invalid_payload',
      'Mutation source is missing.',
    );
  }
  const [sourceRoot, targetRoot] = await Promise.all([
    resolveRoot(request.projectId, request.worktreeId, request.source.repoId),
    resolveRoot(request.projectId, request.worktreeId, request.target.repoId),
  ]);
  const sourceRelativePath = requireMutableRelativePath(
    request.source.relativePath,
    'Source',
  );
  let targetRelativePath = requireMutableRelativePath(
    request.target.relativePath,
    'Target',
  );
  const [sourceRootReal, targetRootReal] = await Promise.all([
    realpath(sourceRoot.absolutePath),
    realpath(targetRoot.absolutePath),
  ]);
  const sourcePath = join(
    sourceRoot.absolutePath,
    ...sourceRelativePath.split('/'),
  );
  await resolveExistingFileInsideRoot(sourcePath, sourceRootReal);
  const sourceStats = await lstat(sourcePath);
  let targetPath = join(
    targetRoot.absolutePath,
    ...targetRelativePath.split('/'),
  );
  if (request.operation === 'copy' && request.conflict === 'increment') {
    const available = await resolveAvailableCopyTarget(
      targetRoot,
      targetRelativePath,
      sourceStats.isDirectory(),
    );
    targetRelativePath = available.relativePath;
    targetPath = available.absolutePath;
  }
  await resolveCreatableFileInsideRoot(targetPath, targetRootReal);
  if (
    sourceRoot.repoId === targetRoot.repoId &&
    isNestedPath(sourcePath, targetPath)
  ) {
    throw new PortalServiceError(
      'invalid_target',
      'A folder cannot be moved or copied into itself.',
    );
  }
  if (sourceRoot.repoId !== targetRoot.repoId) {
    await assertTreeHasNoSymlinks(sourcePath);
  }
  let caseOnlyRename = false;
  if (await pathExists(targetPath)) {
    caseOnlyRename =
      request.operation === 'move' &&
      (await isCaseOnlyRename(sourcePath, targetPath));
    if (!caseOnlyRename) {
      throw new PortalServiceError(
        'invalid_target',
        `A file or folder already exists at ${targetRelativePath}.`,
      );
    }
  }
  if (request.operation === 'move') {
    await options?.beforeMove?.();
  }
  await Promise.all([
    resolveExistingFileInsideRoot(sourcePath, sourceRootReal),
    resolveCreatableFileInsideRoot(targetPath, targetRootReal),
  ]);
  await mkdir(dirname(targetPath), { recursive: true });
  const [validatedSourcePath] = await Promise.all([
    resolveExistingFileInsideRoot(sourcePath, sourceRootReal),
    resolveCreatableFileInsideRoot(targetPath, targetRootReal),
  ]);

  const copyEntry = options?.copyEntry ?? copyForTransfer;
  const publishRenameEntry = options?.publishRenameEntry ?? rename;
  const publishLinkEntry = options?.publishLinkEntry ?? link;
  const publishStagedEntry = async (stagingPath: string): Promise<void> => {
    if (!sourceStats.isDirectory()) {
      try {
        await publishLinkEntry(stagingPath, targetPath);
      } catch (error) {
        const code = getErrorCode(error);
        if (
          code !== 'EPERM' &&
          code !== 'ENOTSUP' &&
          code !== 'EOPNOTSUPP' &&
          code !== 'ENOSYS'
        ) {
          throw error;
        }
        await copyFile(stagingPath, targetPath, constants.COPYFILE_EXCL);
      }
      await unlink(stagingPath);
      return;
    }

    if (process.platform === 'win32') {
      await publishRenameEntry(stagingPath, targetPath);
      return;
    }

    try {
      await mkdir(targetPath, { recursive: false });
    } catch (error) {
      if (getErrorCode(error) === 'EEXIST') {
        throwMoveConflict(targetRelativePath);
      }
      throw error;
    }
    try {
      await publishRenameEntry(stagingPath, targetPath);
    } catch (error) {
      try {
        await rmdir(targetPath);
      } catch {
        // Only remove our empty reservation; concurrent content is preserved.
      }
      throw error;
    }
  };
  const copyIntoStaging = async (): Promise<void> => {
    const stagingDirectory = await mkdtemp(
      join(dirname(targetPath), '.canopy-copy-'),
    );
    const stagingPath = join(stagingDirectory, basename(targetPath));
    try {
      await copyEntry(validatedSourcePath, stagingPath);
      await publishStagedEntry(stagingPath);
    } catch (error) {
      try {
        await rm(stagingDirectory, { recursive: true, force: true });
      } catch {
        // Preserve the original copy/publish failure when cleanup cannot finish.
      }
      const code = getErrorCode(error);
      if (
        code === 'EEXIST' ||
        code === 'ENOTEMPTY' ||
        code === 'ERR_FS_CP_EEXIST'
      ) {
        throwMoveConflict(targetRelativePath);
      }
      throw error;
    }
    try {
      await rm(stagingDirectory, { recursive: true, force: true });
    } catch {
      // The copy is already published; an empty staging cleanup is best-effort.
    }
  };

  if (request.operation === 'copy') {
    await copyIntoStaging();
  } else if (request.operation === 'move') {
    const renameEntry = options?.renameEntry ?? rename;
    const linkEntry = options?.linkEntry ?? link;
    const unlinkEntry = options?.unlinkEntry ?? unlink;
    const removeEntry = options?.removeEntry ?? rm;
    const copyAcrossDevices = async (): Promise<void> => {
      await copyIntoStaging();
      await removeEntry(sourcePath, { recursive: true, force: false });
    };
    if (caseOnlyRename) {
      await renameEntry(sourcePath, targetPath);
    } else if (sourceStats.isDirectory()) {
      if (process.platform === 'win32') {
        try {
          await renameEntry(sourcePath, targetPath);
        } catch (error) {
          const code = getErrorCode(error);
          if (code === 'EXDEV') {
            await copyAcrossDevices();
          } else if (
            code === 'EEXIST' ||
            code === 'ENOTEMPTY' ||
            ((code === 'EPERM' || code === 'EACCES') &&
              (await pathExists(targetPath)))
          ) {
            throwMoveConflict(targetRelativePath);
          } else {
            throw error;
          }
        }
      } else {
        try {
          await mkdir(targetPath, { recursive: false });
        } catch (error) {
          if (getErrorCode(error) === 'EEXIST') {
            throwMoveConflict(targetRelativePath);
          }
          throw error;
        }
        try {
          await renameEntry(sourcePath, targetPath);
        } catch (error) {
          try {
            await rmdir(targetPath);
          } catch {
            // Only remove our still-empty reservation. A changed target is kept.
          }
          const moveCode = getErrorCode(error);
          if (moveCode === 'EEXIST' || moveCode === 'ENOTEMPTY') {
            throwMoveConflict(targetRelativePath);
          }
          if (moveCode !== 'EXDEV') throw error;
          await copyAcrossDevices();
        }
      }
    } else {
      let linked = false;
      try {
        await linkEntry(sourcePath, targetPath);
        linked = true;
      } catch (error) {
        const code = getErrorCode(error);
        if (code === 'EEXIST' || code === 'ERR_FS_CP_EEXIST') {
          throwMoveConflict(targetRelativePath);
        }
        if (
          code !== 'EXDEV' &&
          code !== 'EPERM' &&
          code !== 'ENOTSUP' &&
          code !== 'EOPNOTSUPP' &&
          code !== 'ENOSYS'
        ) {
          throw error;
        }
        await copyAcrossDevices();
      }
      if (linked) {
        try {
          await unlinkEntry(sourcePath);
        } catch (error) {
          try {
            await unlinkEntry(targetPath);
          } catch {
            // Preserve the source-cleanup error if rollback also fails.
          }
          throw error;
        }
      }
    }
  } else {
    throw new PortalServiceError(
      'invalid_payload',
      'Unsupported file-tree mutation operation.',
    );
  }

  return {
    operation: request.operation,
    source: { repoId: sourceRoot.repoId, relativePath: sourceRelativePath },
    target: { repoId: targetRoot.repoId, relativePath: targetRelativePath },
  };
}

export async function readPortalFilePreview(
  request: PortalFileReadPayload,
): Promise<PortalFilePreview> {
  if (request.projectId === SHARED_CONTAINER_VIEWER_PROJECT_ID) {
    const root = await resolveRoot(
      request.projectId,
      request.worktreeId,
      request.fileRootLocalId,
      request.repoId,
    );
    const relativePath = normalizeRelativePath(request.relativePath);
    rejectUnsupportedText(relativePath);
    const opened = await readSharedContainerViewerFile(
      request.worktreeId,
      join(root.absolutePath, ...relativePath.split('/')),
    );
    const slice = opened.bytes.subarray(0, MAX_PREVIEW_BYTES);
    if (slice.includes(0)) {
      throw new PortalServiceError(
        'invalid_target',
        'Binary files cannot be read.',
      );
    }
    return {
      workspaceLocalId: request.projectId,
      worktreeLocalId: request.worktreeId,
      fileRootLocalId: root.repoId,
      path: relativePath,
      content: slice.toString('utf8'),
      language: languageForPath(relativePath),
      size: opened.sizeBytes,
      version: `${opened.sizeBytes}:${Math.round(opened.modifiedAtMs)}`,
      truncated: opened.sizeBytes > MAX_PREVIEW_BYTES,
      modifiedAt: new Date(opened.modifiedAtMs).toISOString(),
    };
  }
  const { root, rootReal, relativePath, joinedAbsolutePath } =
    await resolvePortalFileTarget(request);
  rejectUnsupportedText(relativePath);

  const targetReal = await resolveExistingFileInsideRoot(
    joinedAbsolutePath,
    rootReal,
  );
  const stats = await stat(targetReal);
  if (!stats.isFile()) {
    throw new PortalServiceError('invalid_target', 'Path is not a file.');
  }

  // Match the save path's O_NOFOLLOW: refuse to follow a final-component
  // symlink swapped in after the realpath containment check (TOCTOU). The
  // realpath check already rejects symlinks resolving outside the root;
  // O_NOFOLLOW closes the narrow race on the resolved final component.
  const readFlags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);
  const fh = await open(targetReal, readFlags);
  try {
    const maxBytes = Math.min(stats.size, MAX_PREVIEW_BYTES);
    const buffer = Buffer.alloc(maxBytes);
    const { bytesRead } = await fh.read(buffer, 0, maxBytes, 0);
    const slice = buffer.subarray(0, bytesRead);
    if (slice.includes(0)) {
      throw new PortalServiceError(
        'invalid_target',
        'Binary files cannot be read.',
      );
    }
    return {
      workspaceLocalId: request.projectId,
      worktreeLocalId: request.worktreeId,
      fileRootLocalId: root.repoId,
      path: relativePath,
      content: slice.toString('utf8'),
      language: languageForPath(relativePath),
      size: stats.size,
      version: versionFromStat(stats),
      truncated: stats.size > MAX_PREVIEW_BYTES,
      modifiedAt: stats.mtime.toISOString(),
    };
  } finally {
    await fh.close();
  }
}

export async function savePortalFile(
  request: PortalFileSavePayload,
): Promise<PortalFilePreview> {
  assertWritableScope(request.projectId);
  if (Buffer.byteLength(request.content, 'utf8') > MAX_SAVE_BYTES) {
    throw new PortalServiceError(
      'invalid_payload',
      'File content exceeds the 5 MB save limit.',
    );
  }

  const { root, rootReal, relativePath, joinedAbsolutePath } =
    await resolvePortalFileTarget(request);
  if (!relativePath) {
    throw new PortalServiceError('invalid_target', 'Path is not a file.');
  }
  rejectUnsupportedText(relativePath, request.content);

  let writePath: string;
  let existingStats: Awaited<ReturnType<typeof stat>> | null = null;
  try {
    writePath = await resolveExistingFileInsideRoot(
      joinedAbsolutePath,
      rootReal,
    );
    existingStats = await stat(writePath);
    if (!existingStats.isFile()) {
      throw new PortalServiceError('invalid_target', 'Path is not a file.');
    }
  } catch (error) {
    if (error instanceof PortalServiceError) {
      throw error;
    }
    if (getErrorCode(error) !== 'ENOENT') {
      throw error;
    }
    writePath = await resolveCreatableFileInsideRoot(
      joinedAbsolutePath,
      rootReal,
    );
  }

  if (
    existingStats &&
    typeof request.expectedModifiedAtMs === 'number' &&
    Math.abs(existingStats.mtimeMs - request.expectedModifiedAtMs) > 1
  ) {
    throw new PortalServiceError(
      'execution_failed',
      'File changed on disk since it was loaded.',
    );
  }

  if (existingStats) {
    const flags =
      constants.O_WRONLY | constants.O_TRUNC | (constants.O_NOFOLLOW ?? 0);
    // The post-write realpath check below is the authoritative fail-closed
    // guard for parent-directory swaps between validation and open.
    const fh = await open(writePath, flags);
    try {
      await fh.writeFile(request.content, 'utf8');
    } finally {
      await fh.close();
    }
  } else {
    const flags =
      constants.O_CREAT |
      constants.O_EXCL |
      constants.O_WRONLY |
      (constants.O_NOFOLLOW ?? 0);
    const fh = await open(writePath, flags, 0o666);
    try {
      await fh.writeFile(request.content, 'utf8');
    } finally {
      await fh.close();
    }
  }

  const savedPath = await realpath(writePath);
  if (!isPathInsideRoot(savedPath, rootReal)) {
    throw new PortalServiceError(
      'invalid_target',
      'Saved file escaped the selected worktree root.',
    );
  }
  const updated = await stat(savedPath);
  return {
    workspaceLocalId: request.projectId,
    worktreeLocalId: request.worktreeId,
    fileRootLocalId: root.repoId,
    path: relativePath,
    content: request.content,
    language: languageForPath(relativePath),
    size: updated.size,
    version: versionFromStat(updated),
    truncated: false,
    modifiedAt: updated.mtime.toISOString(),
  };
}

export async function readFilePreview(
  request: FileContentRequest,
): Promise<PortalFilePreview> {
  const stats = await stat(request.absolutePath);
  if (!stats.isFile()) {
    throw new PortalServiceError('invalid_target', 'Path is not a file.');
  }
  const fh = await open(request.absolutePath, 'r');
  try {
    const maxBytes = Math.min(stats.size, MAX_PREVIEW_BYTES);
    const buffer = Buffer.alloc(maxBytes);
    const { bytesRead } = await fh.read(buffer, 0, maxBytes, 0);
    const slice = buffer.subarray(0, bytesRead);
    if (slice.includes(0)) {
      throw new PortalServiceError(
        'invalid_target',
        'Binary files cannot be read.',
      );
    }
    return {
      workspaceLocalId: '',
      worktreeLocalId: '',
      path: request.absolutePath,
      content: slice.toString('utf8'),
      language: languageForPath(request.absolutePath),
      size: stats.size,
      version: versionFromStat(stats),
      truncated: stats.size > MAX_PREVIEW_BYTES,
      modifiedAt: stats.mtime.toISOString(),
    };
  } finally {
    await fh.close();
  }
}

export async function saveFile(
  request: SaveFileContentRequest,
): Promise<SaveFileContentResponse> {
  const { withWorkspaceTargetRuntimeStartReservation } =
    await import('../lib/workspace-target-exclusion');
  return withWorkspaceTargetRuntimeStartReservation(
    request.projectId,
    request.worktreeId,
    async () => {
      validateId(request.projectId, 'projectId');
      validateId(request.worktreeId, 'worktreeId');
      assertWritableScope(request.projectId);
      if (Buffer.byteLength(request.content, 'utf8') > MAX_SAVE_BYTES) {
        throw new PortalServiceError(
          'invalid_payload',
          'File content is too large.',
        );
      }
      if (request.content.includes('\0')) {
        throw new PortalServiceError(
          'invalid_payload',
          'Cannot save binary content.',
        );
      }

      const { roots } = await getFileBrowserRoots(
        request.projectId,
        request.worktreeId,
      );
      const absolutePath = resolve(request.absolutePath);
      const root = roots.find((candidate) =>
        isPathInsideRoot(absolutePath, resolve(candidate.absolutePath)),
      );
      if (!root) {
        throw new PortalServiceError(
          'invalid_target',
          'File is outside the selected worktree roots.',
        );
      }

      const rootReal = await realpath(root.absolutePath);
      const targetReal = await realpath(absolutePath);
      if (!isPathInsideRoot(targetReal, rootReal)) {
        throw new PortalServiceError(
          'invalid_target',
          'File is outside the selected worktree roots.',
        );
      }

      const current = await stat(targetReal);
      if (!current.isFile()) {
        throw new PortalServiceError('invalid_target', 'Path is not a file.');
      }
      if (
        typeof request.expectedModifiedAtMs === 'number' &&
        Math.abs(current.mtimeMs - request.expectedModifiedAtMs) > 1
      ) {
        throw new PortalServiceError(
          'execution_failed',
          'File changed on disk since it was loaded.',
        );
      }
      const { touchWorkspaceTarget } =
        await import('../lib/workspace-activity');
      await touchWorkspaceTarget(request.projectId, request.worktreeId);
      const flags =
        constants.O_WRONLY | constants.O_TRUNC | (constants.O_NOFOLLOW ?? 0);
      const fh = await open(targetReal, flags);
      try {
        await fh.writeFile(request.content, 'utf8');
      } finally {
        await fh.close();
      }
      const updatedPath = await realpath(targetReal);
      if (!isPathInsideRoot(updatedPath, rootReal)) {
        throw new PortalServiceError(
          'invalid_target',
          'Saved file escaped the selected worktree root.',
        );
      }
      const updated = await stat(updatedPath);
      return {
        filename: basename(updatedPath),
        sizeBytes: updated.size,
        modifiedAtMs: updated.mtimeMs,
      };
    },
  );
}

export function toFileSnapshotPayload(
  listingOrPreview: PortalDirectoryListing | PortalFilePreview,
  rootScope?: { fileRootLocalId: string },
): PortalFileSnapshotPayload {
  // Transport plan Phase T1.2: snapshots MUST carry `fileRootLocalId`,
  // `workspaceLocalId`, `worktreeLocalId`, and a relative `filePath`.
  // The wire keys two repos with the same relative filename apart via
  // the composite cache key `${fileRootLocalId}:${filePath}`.
  const fileRootLocalId =
    rootScope?.fileRootLocalId ?? listingOrPreview.fileRootLocalId ?? '';
  if ('entries' in listingOrPreview) {
    return {
      fileRootLocalId,
      workspaceLocalId: listingOrPreview.workspaceLocalId,
      worktreeLocalId: listingOrPreview.worktreeLocalId,
      filePath: listingOrPreview.path,
      tree: listingOrPreview.entries.map(
        (entry: PortalDirectoryListing['entries'][number]) => ({
          name: entry.name,
          isDir: entry.type === 'directory',
        }),
      ),
    };
  }
  return {
    fileRootLocalId,
    workspaceLocalId: listingOrPreview.workspaceLocalId,
    worktreeLocalId: listingOrPreview.worktreeLocalId,
    filePath: listingOrPreview.path,
    contents: listingOrPreview.content,
    truncated: listingOrPreview.truncated,
    modifiedAtMs: listingOrPreview.modifiedAt
      ? new Date(listingOrPreview.modifiedAt).getTime()
      : undefined,
  };
}
