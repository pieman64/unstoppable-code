import { open, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { type Stats } from 'node:fs';
import { DOCUMENT_PREVIEW_MAX_BYTES } from '@canopy/protocol/document-preview';
import { basename, extname, join, relative, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { shell } from 'electron';
import { IPC_CHANNELS } from '@canopy/desktop-shared/types';
import { SHARED_CONTAINER_VIEWER_PROJECT_ID } from '@canopy/desktop-shared/types';
import type {
  FileDocumentBytesRequest,
  FileDocumentBytesResponse,
  FileContentRequest,
  FileContentResponse,
  FileReferenceResolveRequest,
  FileReferenceResolveResponse,
  FilePreviewRequest,
  FilePreviewResponse,
  OpenExternalFileRequest,
  SaveFileContentRequest,
  SaveFileContentResponse,
  ShowInFinderRequest,
} from '@canopy/desktop-shared/types';
import { getCodexRuntimeService } from '../codex/runtime-service';
import { getFileBrowserRoots } from '../lib/file-browser-roots';
import {
  getAuthorizedFileRoots,
  openAuthorizedRegularFile,
} from '../lib/authorized-file-open';
import { assertExternalFileOpenAllowed } from '../lib/external-file-open';
import { hasGitPathSegment } from '../lib/file-glob-matcher';
import { openExternalGuarded } from '../lib/open-external';
import { isPathInside } from '../lib/path-safety';
import {
  getWorktreeAttachmentsDir,
  getWorkspaceWorktreeAttachmentsDir,
  getWorkspaceWorktreeRepoDir,
} from '../lib/paths';
import { resolveWorktreeCwd } from '../lib/resolve-worktree';
import { validateAbsolutePath, validateId } from '../lib/validation';
import {
  assertPathOutsideSharedContainerReplicas,
  assertWritableScope,
} from '../lib/read-only-scope';
import { readWorkspaceConfig } from '../lib/workspace-persistence';
import { getWorkspaceType } from '../lib/workspace-registry';
import { registerIpcHandler } from './register';
import {
  readSharedContainerViewerFile,
  resolveSharedContainerViewerFileForRead,
} from '../shared-containers/read/viewer-root';
import { getSharedContainerReader } from '../shared-containers/read/reader';

type FileContentKind = FilePreviewResponse['kind'];

const IMAGE_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.svg',
  '.bmp',
]);

const MARKDOWN_EXTENSIONS = new Set(['.md', '.mdx']);

const HTML_EXTENSIONS = new Set(['.html', '.htm']);

const KNOWN_BINARY_EXTENSIONS = new Set([
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

const IMAGE_MIME_MAP: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp',
};

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_PREVIEW_TEXT_BYTES = 2048;
const MAX_FULL_TEXT_BYTES = 5 * 1024 * 1024;
const MAX_EDIT_TEXT_BYTES = MAX_FULL_TEXT_BYTES;

function classifyExtension(absolutePath: string): FileContentKind {
  const extension = extname(absolutePath).toLowerCase();
  if (IMAGE_EXTENSIONS.has(extension)) {
    return 'image';
  }
  if (MARKDOWN_EXTENSIONS.has(extension)) {
    return 'markdown';
  }
  if (HTML_EXTENSIONS.has(extension)) {
    return 'html';
  }
  if (KNOWN_BINARY_EXTENSIONS.has(extension)) {
    return 'unsupported';
  }
  // Unknown extensions default to text; a null-byte sniff later rejects
  // misnamed binary files before they render in the viewer.
  return 'text';
}

async function readTextSlice(
  absolutePath: string,
  maxBytes: number,
): Promise<string> {
  const fh = await open(absolutePath, 'r');
  try {
    return await readTextSliceFromHandle(fh, maxBytes);
  } finally {
    await fh.close();
  }
}

async function readTextSliceFromHandle(
  fileHandle: FileHandle,
  maxBytes: number,
): Promise<string> {
  const buffer = Buffer.alloc(maxBytes);
  const { bytesRead } = await fileHandle.read(buffer, 0, maxBytes, 0);
  const slice = buffer.subarray(0, bytesRead);
  if (slice.includes(0)) {
    return '';
  }
  return slice.toString('utf8');
}

function buildUnsupportedResponse(
  filename: string,
  sizeBytes: number,
  modifiedAtMs: number,
): FilePreviewResponse {
  return {
    kind: 'unsupported',
    content: '',
    filename,
    sizeBytes,
    truncated: false,
    modifiedAtMs,
  };
}

function buildMissingResponse(filename: string): FileContentResponse {
  return {
    kind: 'missing',
    content: '',
    filename,
    sizeBytes: 0,
    truncated: false,
    modifiedAtMs: 0,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function getErrorCode(error: unknown): string | undefined {
  if (!isRecord(error)) {
    return undefined;
  }
  const code = error.code;
  return typeof code === 'string' ? code : undefined;
}

function isPathInsideRoot(resolvedPath: string, rootPath: string): boolean {
  return (
    resolvedPath === rootPath || resolvedPath.startsWith(`${rootPath}${sep}`)
  );
}

function isWindowsNetworkOrDevicePath(pathValue: string): boolean {
  const windowsPath = pathValue.replace(/\//g, '\\');
  return (
    windowsPath.startsWith('\\\\') ||
    windowsPath.startsWith('\\??\\') ||
    windowsPath.toUpperCase().startsWith('\\GLOBALROOT\\')
  );
}

async function resolveAllowedShowInFinderPath(
  request: ShowInFinderRequest,
): Promise<string> {
  validateAbsolutePath(request.absolutePath, 'absolutePath');
  if (isWindowsNetworkOrDevicePath(request.absolutePath)) {
    throw new Error(
      'Invalid absolutePath: network and device paths are not allowed',
    );
  }

  const { projectId, worktreeId } = request;
  const hasProjectId = projectId !== undefined;
  const hasWorktreeId = worktreeId !== undefined;
  if (hasProjectId !== hasWorktreeId) {
    throw new Error(
      'Invalid file-manager scope: projectId and worktreeId must be provided together',
    );
  }
  if (!hasProjectId || !hasWorktreeId) {
    return request.absolutePath;
  }

  validateId(projectId, 'projectId');
  validateId(worktreeId, 'worktreeId');
  const resolvedTarget = await realpath(request.absolutePath);
  const { roots } = await getFileBrowserRoots(projectId, worktreeId);
  for (const root of roots) {
    try {
      const resolvedRoot = await realpath(root.absolutePath);
      if (isPathInside(resolvedRoot, resolvedTarget)) {
        return resolvedTarget;
      }
    } catch {
      // An unavailable optional root cannot authorize the requested target.
    }
  }

  throw new Error(
    'Invalid absolutePath: target must be inside the active worktree',
  );
}

function createFileUrlFromAbsolutePath(pathValue: string): URL {
  return pathToFileURL(pathValue, {
    windows:
      /^[a-zA-Z]:[\\/]/.test(pathValue) ||
      pathValue.startsWith('\\\\') ||
      pathValue.startsWith('//'),
  });
}

export function fileUrlToAbsolutePath(url: URL): string {
  const pathname = decodeURIComponent(url.pathname);
  if (/^\/[a-zA-Z]:($|\/)/.test(pathname)) {
    return pathname.slice(1);
  }
  return url.host ? `//${url.host}${pathname}` : pathname;
}

function resolveMarkdownHref(
  baseFilePath: string,
  href: string,
  roots: Awaited<ReturnType<typeof getFileBrowserRoots>>['roots'],
): string | null {
  if (href.length === 0 || href.startsWith('#') || href.startsWith('//')) {
    return null;
  }

  try {
    const normalizedHref = href.replace(/\\/g, '/');
    const [firstSegment, ...remainingSegments] = normalizedHref.split('/');
    if (
      firstSegment &&
      remainingSegments.length > 0 &&
      !firstSegment.includes(':') &&
      !normalizedHref.startsWith('/')
    ) {
      const matchingRoot = roots.find(
        (root) =>
          root.repoName === firstSegment || root.repoId === firstSegment,
      );
      if (matchingRoot) {
        const lastIndex = remainingSegments.length - 1;
        const targetSegments = remainingSegments.map((segment, index) =>
          decodeURIComponent(
            index === lastIndex ? segment.replace(/[?#].*$/, '') : segment,
          ),
        );
        return join(matchingRoot.absolutePath, ...targetSegments);
      }
    }

    const baseUrl = createFileUrlFromAbsolutePath(baseFilePath);
    const resolvedUrl = new URL(href, baseUrl);
    if (resolvedUrl.protocol !== 'file:') {
      return null;
    }
    return fileUrlToAbsolutePath(resolvedUrl);
  } catch {
    return null;
  }
}

async function resolveAllowedFileReference(
  request: FileReferenceResolveRequest,
): Promise<FileReferenceResolveResponse> {
  const { roots } = await getFileBrowserRoots(
    request.projectId,
    request.worktreeId,
  );
  const resolvedPath = resolveMarkdownHref(
    request.baseFilePath,
    request.href,
    roots,
  );
  if (!resolvedPath || hasGitPathSegment(resolvedPath)) {
    return null;
  }

  if (request.projectId === SHARED_CONTAINER_VIEWER_PROJECT_ID) {
    try {
      const resolved = await resolveSharedContainerViewerFileForRead(
        request.worktreeId,
        resolvedPath,
      );
      const info = await getSharedContainerReader().store.lstatEntryForRead(
        resolved.root.revisionRoot,
        resolved.target,
      );
      if (info.isSymbolicLink() || (!info.isFile() && !info.isDirectory())) {
        return null;
      }
      return {
        absolutePath: resolved.target,
        filename: basename(resolved.target),
        kind: info.isDirectory() ? 'directory' : 'file',
      };
    } catch {
      return null;
    }
  }

  let resolvedFilePath: string;
  try {
    resolvedFilePath = await realpath(resolvedPath);
  } catch {
    return null;
  }
  if (hasGitPathSegment(resolvedFilePath)) {
    return null;
  }

  let targetStat: Awaited<ReturnType<typeof stat>>;
  try {
    targetStat = await stat(resolvedFilePath);
  } catch {
    return null;
  }
  const kind = targetStat.isDirectory()
    ? 'directory'
    : targetStat.isFile()
      ? 'file'
      : null;
  if (kind === null) return null;

  for (const root of roots) {
    let resolvedRootPath: string;
    try {
      resolvedRootPath = await realpath(root.absolutePath);
    } catch {
      continue;
    }
    if (
      !hasGitPathSegment(resolvedRootPath) &&
      isPathInsideRoot(resolvedFilePath, resolvedRootPath)
    ) {
      return {
        // Authorization uses real paths, but the file panel addresses files
        // relative to its advertised root (which may itself be a symlink).
        absolutePath: join(
          root.absolutePath,
          relative(resolvedRootPath, resolvedFilePath),
        ),
        filename: basename(resolvedFilePath),
        kind,
      };
    }
  }

  return null;
}

async function openWorkspaceDocumentFile(
  request: FileDocumentBytesRequest,
): Promise<{
  absolutePath: string;
  fileHandle: FileHandle;
  fileStat: Stats;
}> {
  validateAbsolutePath(request.absolutePath, 'absolutePath');
  const target = request.workspaceTarget;
  if (!target)
    throw new Error('A project target is required for a scoped file read');
  validateId(target.projectId, 'projectId');
  validateId(target.worktreeId, 'worktreeId');
  const roots = await getAuthorizedFileRoots(target);
  return openAuthorizedRegularFile(request.absolutePath, roots);
}

async function openWorkspaceReadFile(request: FileContentRequest): Promise<{
  absolutePath: string;
  fileHandle: FileHandle;
  fileStat: Stats;
}> {
  const target = request.workspaceTarget;
  if (!target) {
    throw new Error('A project target is required for a scoped file read');
  }

  validateId(target.projectId, 'projectId');
  validateId(target.worktreeId, 'worktreeId');
  const { roots } = await getFileBrowserRoots(
    target.projectId,
    target.worktreeId,
  );
  const fileHandle = await open(request.absolutePath, 'r');
  try {
    const [fileStat, resolvedFilePath] = await Promise.all([
      fileHandle.stat(),
      realpath(request.absolutePath),
    ]);

    let contained = false;
    for (const root of roots) {
      let resolvedRootPath: string;
      try {
        resolvedRootPath = await realpath(root.absolutePath);
      } catch {
        continue;
      }
      if (isPathInsideRoot(resolvedFilePath, resolvedRootPath)) {
        contained = true;
        break;
      }
    }
    if (!contained) {
      throw new Error('Cannot read file outside the target project roots');
    }

    const currentPathStat = await stat(resolvedFilePath);
    if (
      fileStat.dev !== currentPathStat.dev ||
      fileStat.ino !== currentPathStat.ino
    ) {
      throw new Error('Cannot read a file that changed while being validated');
    }

    return { absolutePath: resolvedFilePath, fileHandle, fileStat };
  } catch (error) {
    await fileHandle.close();
    throw error;
  }
}

async function openCodexGeneratedImage(absolutePath: string): Promise<{
  absolutePath: string;
  fileHandle: FileHandle;
  fileStat: Stats;
}> {
  if (isWindowsNetworkOrDevicePath(absolutePath)) {
    throw new Error(
      'Invalid absolutePath: network and device paths are not allowed',
    );
  }

  const { codexHome } = await getCodexRuntimeService().getCanonicalState();
  const generatedImageRoot = join(codexHome, 'generated_images');
  const [resolvedFilePath, resolvedRootPath] = await Promise.all([
    realpath(absolutePath),
    realpath(generatedImageRoot),
  ]);
  if (!isPathInsideRoot(resolvedFilePath, resolvedRootPath)) {
    throw new Error('Cannot read image outside the Codex generated-image root');
  }

  const fileHandle = await open(resolvedFilePath, 'r');
  try {
    const [fileStat, currentPathStat] = await Promise.all([
      fileHandle.stat(),
      stat(resolvedFilePath),
    ]);
    if (!fileStat.isFile()) {
      throw new Error('Cannot read a generated-image path that is not a file');
    }
    if (
      fileStat.dev !== currentPathStat.dev ||
      fileStat.ino !== currentPathStat.ino
    ) {
      throw new Error('Cannot read a file that changed while being validated');
    }
    return { absolutePath: resolvedFilePath, fileHandle, fileStat };
  } catch (error) {
    await fileHandle.close();
    throw error;
  }
}

async function buildAllowedSaveRoots(
  projectId: string,
  worktreeId: string,
): Promise<string[]> {
  const workspaceType = getWorkspaceType(projectId);
  if (workspaceType === 'multi-repo') {
    const config = await readWorkspaceConfig(projectId);
    const roots: string[] = [
      resolveWorktreeCwd(projectId, worktreeId),
      ...config.repos.map((repo) =>
        getWorkspaceWorktreeRepoDir(projectId, worktreeId, repo.id),
      ),
    ];
    roots.push(getWorkspaceWorktreeAttachmentsDir(projectId, worktreeId));
    return roots;
  }

  return [
    resolveWorktreeCwd(projectId, worktreeId),
    getWorktreeAttachmentsDir(projectId, worktreeId),
  ];
}

async function ensureFileIsWithinAllowedRoots(
  absolutePath: string,
  allowedRoots: string[],
): Promise<string> {
  let resolvedFilePath: string;
  try {
    resolvedFilePath = await realpath(absolutePath);
  } catch (error) {
    if (getErrorCode(error) === 'ENOENT') {
      throw new Error(`Cannot save non-existent file: ${absolutePath}`);
    }
    throw error instanceof Error ? error : new Error(String(error));
  }

  for (const rootPath of allowedRoots) {
    let resolvedRootPath: string;
    try {
      resolvedRootPath = await realpath(rootPath);
    } catch {
      continue;
    }

    if (isPathInsideRoot(resolvedFilePath, resolvedRootPath)) {
      return resolvedFilePath;
    }
  }

  throw new Error(`Cannot save file outside allowed worktree roots`);
}

async function readImageContent(
  absolutePath: string,
  filename: string,
  sizeBytes: number,
  modifiedAtMs: number,
  fileHandle?: FileHandle,
): Promise<FilePreviewResponse> {
  const extension = extname(absolutePath).toLowerCase();
  if (sizeBytes > MAX_IMAGE_BYTES) {
    return buildUnsupportedResponse(filename, sizeBytes, modifiedAtMs);
  }
  const data = fileHandle
    ? await fileHandle.readFile()
    : await readFile(absolutePath);
  const mime = IMAGE_MIME_MAP[extension] ?? 'application/octet-stream';
  const dataUrl = `data:${mime};base64,${data.toString('base64')}`;
  return {
    kind: 'image',
    content: dataUrl,
    filename,
    sizeBytes,
    truncated: false,
    modifiedAtMs,
  };
}

async function readTextContent(
  absolutePath: string,
  filename: string,
  sizeBytes: number,
  modifiedAtMs: number,
  kind: 'text' | 'markdown' | 'html',
  maxBytes: number,
  fileHandle?: FileHandle,
): Promise<FilePreviewResponse> {
  const text = fileHandle
    ? await readTextSliceFromHandle(fileHandle, maxBytes)
    : await readTextSlice(absolutePath, maxBytes);
  if (text === '' && sizeBytes > 0) {
    return buildUnsupportedResponse(filename, sizeBytes, modifiedAtMs);
  }
  return {
    kind,
    content: text,
    filename,
    sizeBytes,
    truncated: sizeBytes > maxBytes,
    modifiedAtMs,
  };
}

async function readViewerFileContent(
  request: FileContentRequest,
): Promise<FileContentResponse> {
  const opened = await readSharedContainerViewerFile(
    request.workspaceTarget?.worktreeId ?? '',
    request.absolutePath,
  );
  const kind = classifyExtension(request.absolutePath);
  if (kind === 'unsupported') {
    return buildUnsupportedResponse(
      opened.filename,
      opened.sizeBytes,
      opened.modifiedAtMs,
    );
  }
  if (kind === 'image') {
    if (opened.sizeBytes > MAX_IMAGE_BYTES) {
      return buildUnsupportedResponse(
        opened.filename,
        opened.sizeBytes,
        opened.modifiedAtMs,
      );
    }
    const mime =
      IMAGE_MIME_MAP[extname(request.absolutePath).toLowerCase()] ??
      'application/octet-stream';
    return {
      kind: 'image',
      content: `data:${mime};base64,${opened.bytes.toString('base64')}`,
      filename: opened.filename,
      sizeBytes: opened.sizeBytes,
      truncated: false,
      modifiedAtMs: opened.modifiedAtMs,
    };
  }
  const slice = opened.bytes.subarray(0, MAX_FULL_TEXT_BYTES);
  if (slice.includes(0)) {
    return buildUnsupportedResponse(
      opened.filename,
      opened.sizeBytes,
      opened.modifiedAtMs,
    );
  }
  return {
    kind,
    content: slice.toString('utf8'),
    filename: opened.filename,
    sizeBytes: opened.sizeBytes,
    truncated: opened.sizeBytes > MAX_FULL_TEXT_BYTES,
    modifiedAtMs: opened.modifiedAtMs,
  };
}

export function registerFilePreviewHandlers(): void {
  registerIpcHandler(
    IPC_CHANNELS.fileReferenceResolve,
    async (
      _event,
      request: FileReferenceResolveRequest,
    ): Promise<FileReferenceResolveResponse> => {
      validateId(request.projectId, 'projectId');
      validateId(request.worktreeId, 'worktreeId');
      return resolveAllowedFileReference(request);
    },
  );

  registerIpcHandler(
    IPC_CHANNELS.fileShowInFinder,
    async (_event, request: ShowInFinderRequest): Promise<void> => {
      if (request.projectId) assertWritableScope(request.projectId);
      await assertPathOutsideSharedContainerReplicas(request.absolutePath);
      const allowedPath = await resolveAllowedShowInFinderPath(request);
      shell.showItemInFolder(allowedPath);
    },
  );

  registerIpcHandler(
    IPC_CHANNELS.fileOpenExternal,
    async (_event, request: OpenExternalFileRequest): Promise<void> => {
      await assertExternalFileOpenAllowed(request);
      const fileUrl = createFileUrlFromAbsolutePath(request.absolutePath);
      await openExternalGuarded(fileUrl.toString());
    },
  );

  registerIpcHandler(
    IPC_CHANNELS.fileReadPreview,
    async (
      _event,
      request: FilePreviewRequest,
    ): Promise<FilePreviewResponse> => {
      validateAbsolutePath(request.absolutePath, 'absolutePath');

      const fileStat = await stat(request.absolutePath);
      const sizeBytes = fileStat.size;
      const modifiedAtMs = fileStat.mtimeMs;
      const filename = basename(request.absolutePath);
      const kind = classifyExtension(request.absolutePath);

      if (kind === 'unsupported') {
        return buildUnsupportedResponse(filename, sizeBytes, modifiedAtMs);
      }

      if (kind === 'image') {
        return readImageContent(
          request.absolutePath,
          filename,
          sizeBytes,
          modifiedAtMs,
        );
      }

      return readTextContent(
        request.absolutePath,
        filename,
        sizeBytes,
        modifiedAtMs,
        kind,
        MAX_PREVIEW_TEXT_BYTES,
      );
    },
  );

  registerIpcHandler(
    IPC_CHANNELS.fileReadDocumentBytes,
    async (
      _event,
      request: FileDocumentBytesRequest,
    ): Promise<FileDocumentBytesResponse> => {
      if (
        request.workspaceTarget?.projectId ===
        SHARED_CONTAINER_VIEWER_PROJECT_ID
      ) {
        try {
          const opened = await readSharedContainerViewerFile(
            request.workspaceTarget.worktreeId,
            request.absolutePath,
          );
          if (opened.sizeBytes > DOCUMENT_PREVIEW_MAX_BYTES) {
            return {
              status: 'too-large',
              maxBytes: DOCUMENT_PREVIEW_MAX_BYTES,
              sizeBytes: opened.sizeBytes,
            };
          }
          return {
            status: 'ready',
            bytes: Uint8Array.from(opened.bytes),
            filename: opened.filename,
            sizeBytes: opened.sizeBytes,
            modifiedAtMs: opened.modifiedAtMs,
          };
        } catch (error) {
          if (getErrorCode(error) === 'ENOENT') return { status: 'missing' };
          throw error;
        }
      }
      let fileHandle: FileHandle | undefined;
      try {
        const opened = await openWorkspaceDocumentFile(request);
        fileHandle = opened.fileHandle;
        const { absolutePath, fileStat } = opened;
        if (fileStat.size > DOCUMENT_PREVIEW_MAX_BYTES) {
          return {
            status: 'too-large',
            maxBytes: DOCUMENT_PREVIEW_MAX_BYTES,
            sizeBytes: fileStat.size,
          };
        }
        const chunks: Uint8Array[] = [];
        let sizeBytes = 0;
        while (sizeBytes <= DOCUMENT_PREVIEW_MAX_BYTES) {
          const buffer = Buffer.allocUnsafe(
            Math.min(64 * 1024, DOCUMENT_PREVIEW_MAX_BYTES + 1 - sizeBytes),
          );
          const { bytesRead } = await fileHandle.read(
            buffer,
            0,
            buffer.byteLength,
            sizeBytes,
          );
          if (bytesRead === 0) break;
          sizeBytes += bytesRead;
          if (sizeBytes > DOCUMENT_PREVIEW_MAX_BYTES) {
            // This is the observed lower bound, not the stale stat size.
            return {
              status: 'too-large',
              maxBytes: DOCUMENT_PREVIEW_MAX_BYTES,
              sizeBytes,
            };
          }
          // Trim short reads so retained capacity is bounded by bytes read,
          // even when a growing file repeatedly yields tiny chunks.
          chunks.push(
            bytesRead === buffer.byteLength
              ? buffer
              : new Uint8Array(buffer.subarray(0, bytesRead)),
          );
        }
        // Exact backing-store size; never expose unused pooled Buffer bytes.
        const bytes = new Uint8Array(sizeBytes);
        let offset = 0;
        for (const chunk of chunks) {
          bytes.set(chunk, offset);
          offset += chunk.byteLength;
        }
        return {
          status: 'ready',
          bytes,
          filename: basename(absolutePath),
          sizeBytes,
          modifiedAtMs: fileStat.mtimeMs,
        };
      } catch (error) {
        if (getErrorCode(error) === 'ENOENT') return { status: 'missing' };
        throw error;
      } finally {
        await fileHandle?.close();
      }
    },
  );

  registerIpcHandler(
    IPC_CHANNELS.fileReadContent,
    async (
      _event,
      request: FileContentRequest,
    ): Promise<FileContentResponse> => {
      validateAbsolutePath(request.absolutePath, 'absolutePath');
      if (
        request.workspaceTarget?.projectId ===
        SHARED_CONTAINER_VIEWER_PROJECT_ID
      ) {
        try {
          return await readViewerFileContent(request);
        } catch (error) {
          if (getErrorCode(error) === 'ENOENT') {
            return buildMissingResponse(basename(request.absolutePath));
          }
          throw error;
        }
      }
      let absolutePath = request.absolutePath;
      let fileHandle: FileHandle | undefined;
      let fileStat: Stats;
      try {
        if (request.allowedRoot === 'codex-generated-images') {
          const opened = await openCodexGeneratedImage(request.absolutePath);
          absolutePath = opened.absolutePath;
          fileHandle = opened.fileHandle;
          fileStat = opened.fileStat;
        } else if (request.workspaceTarget) {
          const opened = await openWorkspaceReadFile(request);
          absolutePath = opened.absolutePath;
          fileHandle = opened.fileHandle;
          fileStat = opened.fileStat;
        } else {
          fileStat = await stat(absolutePath);
        }
      } catch (error) {
        if (getErrorCode(error) === 'ENOENT') {
          return buildMissingResponse(basename(absolutePath));
        }
        throw error;
      }

      try {
        const filename = basename(absolutePath);
        const sizeBytes = fileStat.size;
        const modifiedAtMs = fileStat.mtimeMs;
        const kind = classifyExtension(absolutePath);

        if (kind === 'unsupported') {
          return buildUnsupportedResponse(filename, sizeBytes, modifiedAtMs);
        }

        if (kind === 'image') {
          return await readImageContent(
            absolutePath,
            filename,
            sizeBytes,
            modifiedAtMs,
            fileHandle,
          );
        }

        return await readTextContent(
          absolutePath,
          filename,
          sizeBytes,
          modifiedAtMs,
          kind,
          MAX_FULL_TEXT_BYTES,
          fileHandle,
        );
      } catch (error) {
        if (getErrorCode(error) === 'ENOENT') {
          return buildMissingResponse(basename(absolutePath));
        }
        throw error;
      } finally {
        await fileHandle?.close();
      }
    },
  );

  registerIpcHandler(
    IPC_CHANNELS.fileSaveContent,
    async (
      _event,
      request: SaveFileContentRequest,
    ): Promise<SaveFileContentResponse> => {
      const { withWorkspaceTargetRuntimeStartReservation } =
        await import('../lib/workspace-target-exclusion');
      return withWorkspaceTargetRuntimeStartReservation(
        request.projectId,
        request.worktreeId,
        async () => {
          validateId(request.projectId, 'projectId');
          validateId(request.worktreeId, 'worktreeId');
          assertWritableScope(request.projectId);
          validateAbsolutePath(request.absolutePath, 'absolutePath');

          const kind = classifyExtension(request.absolutePath);
          if (kind === 'image' || kind === 'unsupported') {
            throw new Error('Only text-based files can be edited');
          }

          if (
            Buffer.byteLength(request.content, 'utf8') > MAX_EDIT_TEXT_BYTES
          ) {
            throw new Error('File content exceeds the 5 MB save limit');
          }

          if (request.content.includes('\0')) {
            throw new Error('File content cannot contain null bytes');
          }

          const allowedRoots = await buildAllowedSaveRoots(
            request.projectId,
            request.worktreeId,
          );
          const resolvedSavePath = await ensureFileIsWithinAllowedRoots(
            request.absolutePath,
            allowedRoots,
          );

          const currentStat = await stat(resolvedSavePath);
          if (
            typeof request.expectedModifiedAtMs === 'number' &&
            Math.abs(currentStat.mtimeMs - request.expectedModifiedAtMs) > 1
          ) {
            throw new Error('File changed on disk since it was loaded.');
          }

          const { touchWorkspaceTarget } =
            await import('../lib/workspace-activity');
          await touchWorkspaceTarget(request.projectId, request.worktreeId);
          await writeFile(resolvedSavePath, request.content, 'utf8');
          const savedStat = await stat(resolvedSavePath);
          return {
            filename: basename(request.absolutePath),
            sizeBytes: savedStat.size,
            modifiedAtMs: savedStat.mtimeMs,
          };
        },
      );
    },
  );
}
