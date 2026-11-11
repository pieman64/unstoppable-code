import { randomUUID } from 'node:crypto';
import { hostOperatingSystem } from '@canopy/core-platform/host-platform';
import { execFile } from 'node:child_process';
import {
  constants,
  lstatSync,
  type Stats,
  mkdirSync,
  openSync,
  closeSync,
  fstatSync,
  linkSync,
  realpathSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
} from 'node:fs';
import { chmod, open, rm, type FileHandle } from 'node:fs/promises';
import { basename, join, relative, isAbsolute, resolve } from 'node:path';
import { z } from 'zod';
import type {
  BrowserCopyTransfer,
  BrowserDownloadSource,
  BrowserDownloadTransfer,
  BrowserEvent,
  BrowserListTransfersRequest,
  BrowserListTransfersResult,
  BrowserTransfer,
  BrowserTransferError,
  BrowserTransferErrorCode,
  BrowserTransferStatus,
  BrowserUploadTransfer,
} from '@canopy/execution-engine/types/browser';
import { getEnhancedEnv } from '@canopy/execution-engine/pipelines/config-paths';
import { getBrowserTaskFilesDir, getWorktreeDataDir } from '../../lib/paths';
import { sanitizeDownloadName, uniqueDownloadName } from './download-name';
import {
  CopyError,
  copyIntoDestination,
  copyTempName,
  isCopyTempName,
  type CopyDestination,
} from './workspace-copy';
import {
  stageUploadFile,
  stagedFileMatches,
  UploadError,
  type UploadSource,
  type UploadSourceResult,
} from './uploads';

export interface BrowserTaskFilesScope {
  projectId: string;
  worktreeId: string;
}
export interface BrowserRuntimeKey {
  browserId: string;
  runtimeGeneration: number;
  taskIncarnationId: string;
}
export type BrowserFilesSessionEvent =
  | {
      kind: 'browser_download_started';
      origin: string;
      fileName: string;
      source: BrowserDownloadSource;
      totalBytes: number | null;
    }
  | {
      kind: 'browser_download_finished';
      origin: string;
      fileName: string;
      source: BrowserDownloadSource;
      status: BrowserTransferStatus;
      receivedBytes: number;
      errorCode?: BrowserTransferErrorCode;
    }
  | {
      kind: 'browser_upload_requested';
      origin: string;
      topOrigin: string;
      files: Array<{
        name: string;
        sizeBytes: number;
        source: UploadSource['kind'];
      }>;
    }
  | {
      kind: 'browser_upload_decided';
      origin: string;
      topOrigin: string;
      decision: 'allow' | 'deny';
      files: Array<{ name: string; sizeBytes: number; sha256?: string }>;
    }
  | {
      kind: 'browser_upload_attached';
      origin: string;
      topOrigin: string;
      files: Array<{ name: string; sizeBytes: number; sha256?: string }>;
    };
export interface BrowserTaskFilesDeps {
  emit(event: BrowserEvent): void;
  recordEvent?(
    scope: BrowserTaskFilesScope,
    event: BrowserFilesSessionEvent,
  ): void;
  now?(): number;
  platform?: NodeJS.Platform;
  taskDir?(scope: BrowserTaskFilesScope): string;
  /** Fault injection before the normal atomic writer, never a replacement writer. */
  beforeCatalogWrite?(
    scope: BrowserTaskFilesScope,
    snapshot: string,
  ): void | Promise<void>;
}
interface StoredDownload extends BrowserDownloadTransfer {
  runtimeGeneration: number;
  taskIncarnationId: string;
}
interface TaskState {
  scope: BrowserTaskFilesScope;
  /** Copies of finished downloads, beside the downloads so no download rule sees them. */
  copies: Map<string, StoredCopy>;
  /** Agent uploads, whose staged copies live under `uploads/<id>/`. */
  uploads: Map<string, StoredUpload>;
  root: string;
  rootReal: string;
  folder: string;
  downloads: string;
  folderIdentity: { dev: number; ino: number };
  downloadsIdentity: { dev: number; ino: number };
  records: Map<string, StoredDownload>;
  /**
   * Downloads of this session whose partial file may still be on disk. Once
   * it is removed, or moved to its final name, nothing touches that path again.
   */
  partials: Set<string>;
  /**
   * The identity of each partial file as the store last saw it, so its own
   * cleanup removes only that file. Chromium may replace its file while it
   * downloads, so this follows progress rather than the first sighting.
   */
  partialIdentities: Map<string, { dev: number; ino: number }>;
  names: Set<string>;
  tail: Promise<void>;
  bound: boolean;
  error?: Error;
  writeQueued?: boolean;
}
const recordSchema = z.object({
  kind: z.literal('download'),
  id: z.string().min(1),
  browserId: z.string().min(1),
  source: z.enum(['user', 'agent', 'print', 'pdf_document']),
  actionId: z.string().optional(),
  origin: z.string(),
  fileName: z.string().min(1),
  mimeType: z.string().optional(),
  receivedBytes: z.number().int().nonnegative().safe(),
  totalBytes: z.number().int().nonnegative().safe().nullable(),
  status: z.enum([
    'in_progress',
    'paused',
    'complete',
    'cancelled',
    'interrupted',
    'failed',
  ]),
  canResume: z.boolean().optional(),
  error: z
    .object({
      code: z.enum([
        'disk_full',
        'download_failed',
        'download_rate_limited',
        'not_found',
        'not_cancellable',
        'not_resumable',
      ]),
      message: z.string(),
    })
    .optional(),
  startedAt: z.number().finite(),
  endedAt: z.number().finite().optional(),
  runtimeGeneration: z.number().int().nonnegative().default(0),
  taskIncarnationId: z.string().default(''),
});
const COPY_MESSAGES: Record<StoredCopyErrorCode, string> = {
  disk_full: 'Not enough disk space.',
  not_found: "Couldn't find this file. It may have been moved or deleted.",
  approval_denied: 'The copy was not approved.',
  destination_exists: 'A file with that name already exists.',
  file_not_eligible: "That location can't be written to safely.",
  invalid_path: 'Use a path to a file inside the workspace.',
  copy_failed: 'The copy failed.',
};
const copyErrorCodes = [
  'disk_full',
  'not_found',
  'approval_denied',
  'destination_exists',
  'file_not_eligible',
  'invalid_path',
  'copy_failed',
] as const;
type StoredCopyErrorCode = (typeof copyErrorCodes)[number];
function copyErrorCode(code: BrowserTransferErrorCode): StoredCopyErrorCode {
  return (
    copyErrorCodes.find((candidate) => candidate === code) ?? 'copy_failed'
  );
}
const copySchema = z.object({
  kind: z.literal('copy'),
  id: z.string().min(1),
  browserId: z.string().min(1),
  sourceId: z.string().min(1),
  source: z.enum(['user', 'agent']),
  actionId: z.string().optional(),
  destinationName: z.string().min(1).max(4096),
  copiedBytes: z.number().int().nonnegative().safe(),
  totalBytes: z.number().int().nonnegative().safe(),
  status: z.enum(['in_progress', 'complete', 'cancelled', 'failed']),
  error: z
    .object({ code: z.enum(copyErrorCodes), message: z.string() })
    .optional(),
  startedAt: z.number().finite(),
  endedAt: z.number().finite().optional(),
  /** Host-only: the copy's temp file while it runs, so recovery can remove it. */
  tempPath: z.string().optional(),
});
type StoredCopy = z.infer<typeof copySchema>;
const copyTransferSchema = copySchema.omit({ tempPath: true });
function copyDto(record: StoredCopy): BrowserCopyTransfer {
  return copyTransferSchema.parse(record);
}
const uploadErrorCodes = [
  'approval_denied',
  'disk_full',
  'file_changed',
  'file_not_eligible',
  'not_found',
  'origin_changed',
  'upload_failed',
] as const;
type StoredUploadErrorCode = (typeof uploadErrorCodes)[number];
function uploadErrorCode(
  code: BrowserTransferErrorCode,
): StoredUploadErrorCode {
  return (
    uploadErrorCodes.find((candidate) => candidate === code) ?? 'upload_failed'
  );
}
const UPLOAD_FAILED = "The upload couldn't be staged.";
/** A staged file's name: one path component the page can see. */
const uploadNameSchema = z
  .string()
  .min(1)
  .max(1024)
  .refine(
    (name) => name !== '.' && name !== '..' && !/[\\/\0]/.test(name),
    'Not a file name',
  );
const uploadSchema = z.object({
  kind: z.literal('upload'),
  id: z.string().uuid(),
  browserId: z.string().min(1),
  actionId: z.string().optional(),
  frameOrigin: z.string(),
  topOrigin: z.string(),
  files: z
    .array(
      z.object({
        name: uploadNameSchema,
        displayPath: z.string().min(1).max(4096),
        sizeBytes: z.number().int().nonnegative().safe(),
        sha256: z
          .string()
          .regex(/^[0-9a-f]{64}$/)
          .optional(),
      }),
    )
    .min(1)
    .max(50),
  stagedBytes: z.number().int().nonnegative().safe(),
  totalBytes: z.number().int().nonnegative().safe(),
  status: z.enum([
    'staging',
    'awaiting_approval',
    'attached',
    'cancelled',
    'denied',
    'failed',
  ]),
  error: z
    .object({ code: z.enum(uploadErrorCodes), message: z.string() })
    .optional(),
  startedAt: z.number().finite(),
  endedAt: z.number().finite().optional(),
});
type StoredUpload = z.infer<typeof uploadSchema>;
/** An upload's origins and files for a session event: names, sizes, and hashes, never paths. */
function uploadEvent(record: StoredUpload): {
  origin: string;
  topOrigin: string;
  files: Array<{ name: string; sizeBytes: number; sha256?: string }>;
} {
  return {
    origin: record.frameOrigin,
    topOrigin: record.topOrigin,
    files: record.files.map((file) => ({
      name: file.name,
      sizeBytes: file.sizeBytes,
      ...(file.sha256 ? { sha256: file.sha256 } : {}),
    })),
  };
}
function uploadDto(record: StoredUpload): BrowserUploadTransfer {
  return uploadSchema.parse(record);
}
function uploadEnded(record: StoredUpload): boolean {
  return record.status !== 'staging' && record.status !== 'awaiting_approval';
}
function key(scope: BrowserTaskFilesScope): string {
  return JSON.stringify([scope.projectId, scope.worktreeId]);
}
function runtimeKey(runtime: BrowserRuntimeKey): string {
  return JSON.stringify([
    runtime.browserId,
    runtime.runtimeGeneration,
    runtime.taskIncarnationId,
  ]);
}
function originOnly(input: string): string {
  try {
    const url = new URL(input);
    if (url.protocol === 'blob:' || url.protocol === 'data:')
      return url.protocol;
    return url.origin === 'null'
      ? url.protocol
      : `${url.origin}${url.pathname}`;
  } catch {
    return '';
  }
}
function final(record: BrowserDownloadTransfer): boolean {
  return (
    record.status === 'complete' ||
    record.status === 'cancelled' ||
    record.status === 'failed' ||
    (record.status === 'interrupted' && !record.canResume)
  );
}
const transferSchema = recordSchema.omit({
  runtimeGeneration: true,
  taskIncarnationId: true,
});
function dto(record: StoredDownload): BrowserDownloadTransfer {
  return transferSchema.parse(record);
}
function transferDto(
  record: StoredDownload | StoredCopy | StoredUpload,
): BrowserTransfer {
  if (record.kind === 'upload') return uploadDto(record);
  return record.kind === 'copy' ? copyDto(record) : dto(record);
}
function errorFor(error: unknown): BrowserTransferError {
  return {
    code:
      error &&
      typeof error === 'object' &&
      'code' in error &&
      error.code === 'ENOSPC'
        ? 'disk_full'
        : 'download_failed',
    message: 'The download could not be saved.',
  };
}
function absent(error: unknown): boolean {
  return (
    !!error &&
    typeof error === 'object' &&
    'code' in error &&
    error.code === 'ENOENT'
  );
}
function inside(root: string, path: string): boolean {
  const child = relative(root, path);
  return (
    child !== '' &&
    child !== '..' &&
    !child.startsWith(`..${hostOperatingSystem() === 'win32' ? '\\' : '/'}`) &&
    !isAbsolute(child)
  );
}
function safeDirectory(path: string): void {
  try {
    mkdirSync(path, { mode: 0o700 });
  } catch (error) {
    if (
      !(
        error &&
        typeof error === 'object' &&
        'code' in error &&
        error.code === 'EEXIST'
      )
    )
      throw error;
  }
  if (!lstatSync(path).isDirectory() || lstatSync(path).isSymbolicLink())
    throw new Error('Unsafe download directory');
}
/** Staged copies and their folders are read-only; removal makes the folders writable first. */
async function removeStagedFolder(folder: string): Promise<void> {
  for (const entry of exists(folder) ? readdirSync(folder) : [])
    await chmod(join(folder, entry), 0o700).catch(() => undefined);
  await rm(folder, { recursive: true, force: true });
}
function removeFile(path: string): void {
  try {
    unlinkSync(path);
  } catch (error) {
    if (!absent(error)) throw error;
  }
}
function exists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (absent(error)) return false;
    throw error;
  }
}
/** Error codes of a filesystem that cannot make a hard link. */
const NO_HARD_LINKS = new Set(['ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EPERM']);
interface FileIdentity {
  dev: number;
  ino: number;
}
/**
 * Moves a file to a name that is free, never over another file, and returns
 * the placed file's identity, or undefined when the name is taken. `rename`
 * replaces whatever has the name; a hard link fails if anything does.
 */
async function placeWithoutReplacing(
  from: string,
  to: string,
  identity: FileIdentity,
): Promise<FileIdentity | undefined> {
  try {
    linkSync(from, to);
  } catch (error) {
    const code =
      error && typeof error === 'object' && 'code' in error
        ? String(error.code)
        : '';
    if (code === 'EEXIST') return undefined;
    if (!NO_HARD_LINKS.has(code)) throw error;
    return copyExclusively(from, to);
  }
  unlinkSync(from);
  return identity;
}
/**
 * Without hard links: copies into a file created exclusively, so nothing that
 * appears at the name meanwhile is replaced, then removes the source. The
 * copy is asynchronous: a large download must not hold up the main thread.
 */
async function copyExclusively(
  from: string,
  to: string,
): Promise<FileIdentity | undefined> {
  let target: FileHandle;
  try {
    target = await open(
      to,
      constants.O_CREAT |
        constants.O_EXCL |
        constants.O_WRONLY |
        constants.O_NOFOLLOW,
      0o600,
    );
  } catch (error) {
    if (
      error &&
      typeof error === 'object' &&
      'code' in error &&
      error.code === 'EEXIST'
    )
      return undefined;
    throw error;
  }
  const created = await target.stat();
  const identity = { dev: created.dev, ino: created.ino };
  try {
    const source = await open(from, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const size = (await source.stat()).size;
      const buffer = Buffer.alloc(1024 * 1024);
      let copied = 0;
      for (;;) {
        const { bytesRead } = await source.read(buffer, 0, buffer.length, null);
        if (bytesRead === 0) break;
        // A write may take less than it is given; the rest is written next.
        for (let written = 0; written < bytesRead; ) {
          const { bytesWritten } = await target.write(
            buffer,
            written,
            bytesRead - written,
          );
          if (bytesWritten <= 0) throw new Error('Download copy stopped');
          written += bytesWritten;
        }
        copied += bytesRead;
      }
      await target.sync();
      if (copied !== size || (await target.stat()).size !== size)
        throw new Error('Download copy incomplete');
    } finally {
      await source.close();
    }
  } catch (error) {
    await target.close();
    removeIfSame(to, identity);
    throw error;
  }
  await target.close();
  unlinkSync(from);
  return identity;
}
/** Removes `path` only while it is still the file with this identity. */
function removeIfSame(
  path: string,
  identity: { dev: number; ino: number },
): void {
  let stat;
  try {
    stat = lstatSync(path);
  } catch (error) {
    if (absent(error)) return;
    throw error;
  }
  if (stat.dev === identity.dev && stat.ino === identity.ino && stat.isFile())
    unlinkSync(path);
}
/** Removes a copy's temp file that a quit or crash left, if it still is one. */
function removeCopyTemp(copy: StoredCopy): void {
  const path = copy.tempPath;
  if (!path || !isCopyTempName(basename(path))) return;
  try {
    const stat = lstatSync(path);
    if (stat.isFile() && !stat.isSymbolicLink()) unlinkSync(path);
  } catch {
    /* Already gone. */
  }
}
/** How often the blocked-downloads notice is announced for one browser. */
const BLOCKED_NOTICE_INTERVAL_MS = 1000;

/** Main-owned task catalog. All durable mutations share the task's single queue. */
export class BrowserTaskFiles {
  private readonly tasks = new Map<string, TaskState>();
  private readonly fenced = new Set<string>();
  private readonly closing = new Set<string>();
  private readonly attributions = new Map<string, string>();
  private readonly windows = new Map<string, number[]>();
  private readonly blocked = new Map<string, number>();
  private readonly blockedNotices = new Map<
    string,
    { at: number; timer?: ReturnType<typeof setTimeout> }
  >();
  private readonly emittedAt = new Map<string, number>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly watchers = new Set<() => void>();
  private readonly failureListeners = new Set<(id: string) => void>();
  private readonly running = new Map<
    string,
    { controller: AbortController; done: Promise<void> }
  >();
  /** Uploads being attached to a page: past cancelling. */
  private readonly attaching = new Set<string>();
  /** Uploads whose end is being applied, so only one end applies. */
  private readonly ending = new Set<string>();
  constructor(private readonly deps: BrowserTaskFilesDeps) {}
  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }
  private task(scope: BrowserTaskFilesScope, bounded = true): TaskState {
    const existing = this.tasks.get(key(scope));
    if (existing) {
      this.check(existing);
      return existing;
    }
    const state = this.openTask(scope);
    // Admission may precede bind. Load the committed catalog before any writer can replace it.
    this.loadCatalog(state, bounded);
    this.tasks.set(key(scope), state);
    return state;
  }
  /** Creates the task's folders and checks they are inside its data folder. */
  private openTask(scope: BrowserTaskFilesScope): TaskState {
    const root = resolve(
      this.deps.taskDir?.(scope) ??
        getWorktreeDataDir(scope.projectId, scope.worktreeId),
    );
    mkdirSync(root, { recursive: true, mode: 0o700 });
    const rootReal = realpathSync(root);
    const folder = this.deps.taskDir
      ? join(root, 'browser-files')
      : getBrowserTaskFilesDir(scope.projectId, scope.worktreeId);
    safeDirectory(folder);
    const downloads = join(folder, 'downloads');
    safeDirectory(downloads);
    if (
      !inside(rootReal, realpathSync(folder)) ||
      !inside(rootReal, realpathSync(downloads))
    )
      throw new Error('Download directory escaped task');
    return {
      scope: { ...scope },
      copies: new Map(),
      uploads: new Map(),
      root,
      rootReal,
      folder,
      downloads,
      folderIdentity: lstatSync(folder),
      downloadsIdentity: lstatSync(downloads),
      records: new Map(),
      partials: new Set(),
      partialIdentities: new Map(),
      names: new Set(),
      tail: Promise.resolve(),
      bound: false,
    };
  }
  /** Reads `files.json` into the state. A missing or unreadable catalog leaves it empty. */
  private loadCatalog(state: TaskState, bounded: boolean): void {
    const catalog = join(state.folder, 'files.json');
    try {
      const fd = openSync(catalog, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const stat = fstatSync(fd);
        if (!stat.isFile() || (bounded && stat.size > 16 * 1024 * 1024))
          throw new Error('Invalid task files catalog');
        const fs = readFileSync(fd, 'utf8');
        const parsed: unknown = JSON.parse(fs);
        if (
          parsed &&
          typeof parsed === 'object' &&
          'version' in parsed &&
          parsed.version === 1 &&
          'records' in parsed &&
          Array.isArray(parsed.records)
        ) {
          for (const entry of parsed.records) {
            const candidate: unknown = entry;
            if (
              candidate &&
              typeof candidate === 'object' &&
              'kind' in candidate &&
              candidate.kind === 'upload'
            ) {
              const upload = uploadSchema.safeParse(candidate);
              if (
                upload.success &&
                !state.uploads.has(upload.data.id) &&
                !state.copies.has(upload.data.id) &&
                !state.records.has(upload.data.id)
              )
                state.uploads.set(upload.data.id, upload.data);
              continue;
            }
            if (
              candidate &&
              typeof candidate === 'object' &&
              'kind' in candidate &&
              candidate.kind === 'copy'
            ) {
              const copy = copySchema.safeParse(candidate);
              if (
                copy.success &&
                !state.copies.has(copy.data.id) &&
                !state.records.has(copy.data.id)
              ) {
                if (copy.data.error)
                  copy.data.error.message = COPY_MESSAGES[copy.data.error.code];
                state.copies.set(copy.data.id, copy.data);
              }
              continue;
            }
            const result = recordSchema.safeParse(candidate);
            if (!result.success) continue;
            const record = result.data;
            if (sanitizeDownloadName(record.fileName) !== record.fileName)
              continue;
            record.origin = originOnly(record.origin);
            if (record.error)
              record.error.message = 'The download could not be saved.';
            if (state.records.has(record.id)) continue;
            state.records.set(record.id, record);
            state.names.add(record.fileName.toLocaleLowerCase());
            state.names.add(`${record.fileName}.download`.toLocaleLowerCase());
          }
        }
      } finally {
        closeSync(fd);
      }
    } catch (error) {
      if (!absent(error) && !(error instanceof SyntaxError)) throw error;
    }
  }
  /**
   * Picks a free name for a download and reserves it with its partial file's
   * name. A name is taken when it or its partial name is reserved or on disk,
   * so no download is ever staged at another one's final name.
   */
  private reserveName(state: TaskState, suggestedName: string): string {
    const fileName = uniqueDownloadName(
      suggestedName,
      state.names,
      (candidate): boolean =>
        state.names.has(`${candidate}.download`.toLocaleLowerCase()) ||
        exists(join(state.downloads, candidate)) ||
        exists(join(state.downloads, `${candidate}.download`)),
    );
    state.names.add(fileName.toLocaleLowerCase());
    state.names.add(`${fileName}.download`.toLocaleLowerCase());
    return fileName;
  }
  /** Records the identity of a download's partial file as progress arrives. */
  private notePartial(state: TaskState, record: StoredDownload): void {
    if (!state.partials.has(record.id)) return;
    try {
      this.check(state);
      const stat = lstatSync(
        join(state.downloads, `${record.fileName}.download`),
      );
      if (stat.isFile() && !stat.isSymbolicLink())
        state.partialIdentities.set(record.id, {
          dev: stat.dev,
          ino: stat.ino,
        });
    } catch {
      /* Not written yet, or the parent changed: nothing to record. */
    }
  }
  /** Removes the download's own partial file once, never a file that replaced it. */
  private removeOwnPartial(state: TaskState, record: StoredDownload): void {
    if (!state.partials.has(record.id)) return;
    const path = join(state.downloads, `${record.fileName}.download`);
    const identity = state.partialIdentities.get(record.id);
    if (identity) removeIfSame(path, identity);
    else removeFile(path);
    state.partials.delete(record.id);
    state.partialIdentities.delete(record.id);
  }
  /** Removes a download's own partial file, at most once. A changed parent is never cleaned through. */
  private removePartial(state: TaskState, record: StoredDownload): void {
    try {
      this.check(state);
      this.removeOwnPartial(state, record);
    } catch {
      /* Left for the next drain, while the parent is checked again. */
    }
  }
  private check(state: TaskState): void {
    if (realpathSync(state.root) !== state.rootReal)
      throw new Error('Task directory changed');
    for (const [path, identity] of [
      [state.folder, state.folderIdentity],
      [state.downloads, state.downloadsIdentity],
    ] as const) {
      const stat = lstatSync(path);
      if (
        !stat.isDirectory() ||
        stat.isSymbolicLink() ||
        stat.dev !== identity.dev ||
        stat.ino !== identity.ino ||
        !inside(state.rootReal, realpathSync(path))
      )
        throw new Error('Download directory changed');
    }
  }
  private find(
    id: string,
  ): { state: TaskState; record: StoredDownload } | undefined {
    for (const state of Array.from(this.tasks.values())) {
      const record = state.records.get(id);
      if (record) return { state, record };
    }
    return undefined;
  }
  private enqueue(
    state: TaskState,
    action: () => Promise<void>,
  ): Promise<void> {
    const operation = state.tail
      .then(action)
      .catch(async (error: unknown): Promise<void> => {
        const mapped = errorFor(error);
        const failed: string[] = [];
        for (const record of Array.from(state.records.values())) {
          if (final(record)) continue;
          this.removePartial(state, record);
          this.finish(state, record, 'failed', mapped);
          failed.push(record.id);
        }
        // Their native downloads are still running into a removed file.
        for (const id of failed)
          for (const listener of Array.from(this.failureListeners))
            listener(id);
        try {
          await this.write(state);
        } catch (failure) {
          state.error =
            failure instanceof Error
              ? failure
              : new Error('Task files catalog unavailable');
        }
      });
    state.tail = operation;
    return operation;
  }
  /** `pending` is written in place of its record, which changes only once the write succeeds. */
  private async write(
    state: TaskState,
    pending?: StoredDownload | StoredCopy | StoredUpload,
  ): Promise<void> {
    const snapshot = JSON.stringify({
      version: 1,
      records: [
        ...Array.from(
          state.records.values(),
          (record): StoredDownload =>
            pending?.kind === 'download' && record.id === pending.id
              ? pending
              : record,
        ),
        ...Array.from(
          state.copies.values(),
          (copy): StoredCopy =>
            pending?.kind === 'copy' && copy.id === pending.id ? pending : copy,
        ),
        ...Array.from(
          state.uploads.values(),
          (upload): StoredUpload =>
            pending?.kind === 'upload' && upload.id === pending.id
              ? pending
              : upload,
        ),
      ],
    });
    await this.deps.beforeCatalogWrite?.(state.scope, snapshot);
    this.check(state);
    const path = join(state.folder, `.files-${randomUUID()}.tmp`);
    try {
      const handle = await open(
        path,
        constants.O_CREAT |
          constants.O_EXCL |
          constants.O_WRONLY |
          constants.O_NOFOLLOW,
        0o600,
      );
      try {
        await handle.writeFile(snapshot, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
      this.check(state);
      renameSync(path, join(state.folder, 'files.json'));
      if ((this.deps.platform ?? hostOperatingSystem()) !== 'win32') {
        const directory = await open(
          state.folder,
          constants.O_RDONLY | constants.O_NOFOLLOW,
        );
        try {
          await directory.sync();
        } catch (error) {
          if (
            !(
              error &&
              typeof error === 'object' &&
              'code' in error &&
              ['EINVAL', 'ENOTSUP', 'EBADF', 'EISDIR', 'EPERM'].includes(
                String(error.code),
              )
            )
          )
            throw error;
        } finally {
          await directory.close();
        }
      }
      state.error = undefined;
    } finally {
      try {
        this.check(state);
        removeFile(path);
      } catch {
        /* A detached directory is not a cleanup destination. */
      }
    }
  }
  private scheduleWrite(state: TaskState): void {
    if (state.writeQueued) return;
    state.writeQueued = true;
    void this.enqueue(state, async (): Promise<void> => {
      state.writeQueued = false;
      await this.write(state);
    });
  }

  async bind(scope: BrowserTaskFilesScope): Promise<void> {
    if (this.fenced.has(key(scope))) return;
    const state = this.task(scope, false);
    if (state.bound) {
      await state.tail;
      return;
    }
    state.bound = true;
    await this.enqueue(state, async (): Promise<void> => {
      this.check(state);
      const recovered: StoredDownload[] = [];
      for (const record of Array.from(state.records.values())) {
        // Never recover a newly admitted live item when bind races admission.
        if (this.emittedAt.has(record.id)) continue;
        if (
          record.status === 'in_progress' ||
          record.status === 'paused' ||
          (record.status === 'interrupted' && record.canResume)
        ) {
          this.finish(state, record, 'interrupted');
          recovered.push(record);
        }
      }
      // Only the partial files of the downloads recovered now are removed: a
      // download that ended earlier already removed its own. Anything else in
      // the folder, a renamed download or a file the user put there, stays.
      const finished = new Set(
        Array.from(state.records.values())
          .filter((record): boolean => record.status === 'complete')
          .map((record): string => record.fileName.toLocaleLowerCase()),
      );
      for (const record of recovered) {
        const name = `${record.fileName}.download`;
        if (finished.has(name.toLocaleLowerCase())) continue;
        const path = join(state.downloads, name);
        if (exists(path) && !lstatSync(path).isDirectory()) removeFile(path);
      }
      for (const name of readdirSync(state.folder))
        if (name.startsWith('.files-') && name.endsWith('.tmp'))
          removeFile(join(state.folder, name));
      // A copy cannot resume: one a quit or crash interrupted has failed.
      for (const copy of Array.from(state.copies.values())) {
        if (copy.status !== 'in_progress' || this.running.has(copy.id))
          continue;
        removeCopyTemp(copy);
        this.settleCopy(copy, 'failed', {
          code: 'copy_failed',
          message: 'The copy was interrupted.',
        });
      }
      // No page survives a restart, so no staged upload is still needed.
      for (const upload of Array.from(state.uploads.values())) {
        if (this.running.has(upload.id) || uploadEnded(upload)) continue;
        upload.status = 'failed';
        upload.endedAt = this.now();
        upload.error = {
          code: 'upload_failed',
          message: 'The upload was interrupted.',
        };
        this.publish(upload, true);
      }
      await this.removeStagedUploads(state);
      await this.write(state);
    });
  }
  admitDownload(input: {
    scope: BrowserTaskFilesScope;
    runtime: BrowserRuntimeKey;
    downloadId: string;
    suggestedName: string;
    url: string;
    mimeType?: string;
    totalBytes: number | null;
    source: BrowserDownloadSource;
    /** The agent action that asked for it, when no action window is open. */
    actionId?: string;
  }):
    | { ok: true; stagingPath: string; record: BrowserDownloadTransfer }
    | { ok: false; reason: 'rate_limited' | 'fenced' | 'unavailable' } {
    if (this.fenced.has(key(input.scope)))
      return { ok: false, reason: 'fenced' };
    const time = this.now();
    const window = (this.windows.get(input.runtime.browserId) ?? []).filter(
      (started): boolean => started > time - 60000,
    );
    this.windows.set(input.runtime.browserId, window);
    let active = 0;
    for (const state of Array.from(this.tasks.values()))
      for (const record of Array.from(state.records.values()))
        if (record.browserId === input.runtime.browserId && !final(record))
          active++;
    if (active >= 3 || window.length >= 20) {
      const count = Math.min(
        (this.blocked.get(input.runtime.browserId) ?? 0) + 1,
        Number.MAX_SAFE_INTEGER,
      );
      this.blocked.set(input.runtime.browserId, count);
      this.announceBlocked(input.runtime.browserId);
      return { ok: false, reason: 'rate_limited' };
    }
    try {
      const state = this.task(input.scope);
      if (state.error) return { ok: false, reason: 'unavailable' };
      if (this.find(input.downloadId))
        return { ok: false, reason: 'unavailable' };
      const fileName = this.reserveName(state, input.suggestedName);
      const stagingPath = join(state.downloads, `${fileName}.download`);
      this.check(state);
      if (
        !inside(
          state.rootReal,
          join(realpathSync(state.downloads), `${fileName}.download`),
        )
      )
        throw new Error('Invalid staging path');
      try {
        lstatSync(stagingPath);
        throw new Error('Staging path occupied');
      } catch (error) {
        if (!absent(error)) throw error;
      }
      const actionId = input.actionId ?? this.attributionFor(input.runtime);
      const record: StoredDownload = {
        kind: 'download',
        id: input.downloadId,
        browserId: input.runtime.browserId,
        source: input.source,
        ...(actionId ? { actionId } : {}),
        origin: originOnly(input.url),
        fileName,
        ...(input.mimeType ? { mimeType: input.mimeType } : {}),
        receivedBytes: 0,
        totalBytes:
          input.totalBytes !== null &&
          Number.isSafeInteger(input.totalBytes) &&
          input.totalBytes >= 0
            ? input.totalBytes
            : null,
        status: 'in_progress',
        startedAt: time,
        runtimeGeneration: input.runtime.runtimeGeneration,
        taskIncarnationId: input.runtime.taskIncarnationId,
      };
      state.records.set(record.id, record);
      state.partials.add(record.id);
      window.push(time);
      this.publish(record, true);
      this.deps.recordEvent?.(state.scope, {
        kind: 'browser_download_started',
        origin: record.origin,
        fileName,
        source: record.source,
        totalBytes: record.totalBytes,
      });
      this.scheduleWrite(state);
      return { ok: true, stagingPath, record: dto(record) };
    } catch {
      return { ok: false, reason: 'unavailable' };
    }
  }
  updateDownload(
    id: string,
    patch: {
      receivedBytes?: number;
      totalBytes?: number | null;
      status?: 'in_progress' | 'paused' | 'interrupted';
      canResume?: boolean;
    },
  ): void {
    const found = this.find(id);
    if (!found || final(found.record) || this.closing.has(id)) return;
    const { state, record } = found;
    // Only progress names the file Chromium is writing. The report that comes
    // with a download's end never claims whatever file has the name then.
    if (patch.status === 'in_progress') this.notePartial(state, record);
    if (
      patch.receivedBytes !== undefined &&
      Number.isSafeInteger(patch.receivedBytes) &&
      patch.receivedBytes >= record.receivedBytes
    )
      record.receivedBytes = patch.receivedBytes;
    if (
      patch.totalBytes === null ||
      (patch.totalBytes !== undefined &&
        Number.isSafeInteger(patch.totalBytes) &&
        patch.totalBytes >= 0)
    )
      record.totalBytes = patch.totalBytes;
    if (
      (patch.status === 'interrupted' ||
        (!patch.status && record.status === 'interrupted')) &&
      patch.canResume === false
    ) {
      void this.discardDownload(id, 'interrupted', {
        code: 'download_failed',
        message: 'The download was interrupted.',
      });
      return;
    }
    if (patch.status) record.status = patch.status;
    if (patch.canResume !== undefined) record.canResume = patch.canResume;
    this.publish(record);
    this.scheduleWrite(state);
  }
  private finish(
    state: TaskState,
    record: StoredDownload,
    status: 'complete' | 'cancelled' | 'failed' | 'interrupted',
    error?: BrowserTransferError,
    endedAt = this.now(),
  ): void {
    record.status = status;
    record.canResume = false;
    record.endedAt = endedAt;
    if (error) record.error = error;
    this.publish(record, true);
    this.deps.recordEvent?.(state.scope, {
      kind: 'browser_download_finished',
      origin: record.origin,
      fileName: record.fileName,
      source: record.source,
      status,
      receivedBytes: record.receivedBytes,
      ...(error ? { errorCode: error.code } : {}),
    });
  }
  completeDownload(id: string): Promise<void> {
    const found = this.find(id);
    if (!found || final(found.record) || this.closing.has(id))
      return found?.state.tail ?? Promise.resolve();
    const { state, record } = found;
    this.closing.add(id);
    return this.enqueue(state, async (): Promise<void> => {
      if (final(record)) return;
      const staging = join(state.downloads, `${record.fileName}.download`);
      let path = join(state.downloads, record.fileName);
      // The finished file is the staging file's inode under another name.
      let placed: { dev: number; ino: number } | undefined;
      try {
        this.check(state);
        const stat = lstatSync(staging);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)
          throw new Error('Unsafe partial download');
        // A file that replaced the partial one is not the download Chromium
        // finished: its size is not the bytes Chromium reports it received.
        if (record.receivedBytes > 0 && stat.size !== record.receivedBytes)
          throw new Error('Partial download replaced');
        // Nor is a file other than the one the last progress report named.
        const last = state.partialIdentities.get(record.id);
        if (last && (last.dev !== stat.dev || last.ino !== stat.ino))
          throw new Error('Partial download replaced');
        // Something may have taken the name since admission: a file the user
        // put there, or a symlink. The download then takes the next free name.
        let fileName = record.fileName;
        const own = { dev: stat.dev, ino: stat.ino };
        let moved = await placeWithoutReplacing(staging, path, own);
        for (let attempt = 0; !moved; attempt++) {
          if (attempt === 100) throw new Error('No free download name');
          fileName = this.reserveName(state, record.fileName);
          path = join(state.downloads, fileName);
          moved = await placeWithoutReplacing(staging, path, own);
        }
        placed = moved;
        state.partials.delete(record.id);
        state.partialIdentities.delete(record.id);
        record.fileName = fileName;
        await this.mark(state, path, placed);
        this.check(state);
        // Nothing reads the download as complete until that is on disk.
        const endedAt = this.now();
        await this.write(state, {
          ...record,
          status: 'complete',
          canResume: false,
          endedAt,
        });
        this.finish(state, record, 'complete', undefined, endedAt);
      } catch (error) {
        if (placed)
          try {
            this.check(state);
            removeIfSame(path, placed);
          } catch {
            /* A swapped parent is never used for cleanup. */
          }
        else this.removePartial(state, record);
        this.finish(state, record, 'failed', errorFor(error));
        await this.write(state);
      }
    });
  }
  discardDownload(
    id: string,
    status: 'cancelled' | 'failed' | 'interrupted',
    error?: BrowserTransferError,
  ): Promise<void> {
    const found = this.find(id);
    if (!found || final(found.record) || this.closing.has(id))
      return found?.state.tail ?? Promise.resolve();
    const { state, record } = found;
    this.closing.add(id);
    return this.enqueue(state, async (): Promise<void> => {
      if (final(record)) return;
      this.check(state);
      this.removeOwnPartial(state, record);
      this.finish(state, record, status, error);
      await this.write(state);
    });
  }
  private async mark(
    state: TaskState,
    path: string,
    identity: { dev: number; ino: number },
  ): Promise<void> {
    this.check(state);
    const stat = lstatSync(path);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.nlink !== 1 ||
      stat.dev !== identity.dev ||
      stat.ino !== identity.ino
    )
      throw new Error('Unsafe completed download');
    await this.applyMarking(path);
    const after = lstatSync(path);
    if (
      after.dev !== stat.dev ||
      after.ino !== stat.ino ||
      after.isSymbolicLink()
    )
      throw new Error('Completed download changed');
  }
  /** The host's download marking: quarantine on macOS, Mark-of-the-Web on Windows. */
  private async applyMarking(path: string): Promise<void> {
    const platform = this.deps.platform ?? hostOperatingSystem();
    if (platform === 'darwin') {
      await new Promise<void>((resolvePromise, reject): void => {
        execFile(
          '/usr/bin/xattr',
          [
            '-s',
            '-w',
            'com.apple.quarantine',
            `0081;${Math.floor(this.now() / 1000).toString(16)};Browser;`,
            path,
          ],
          {
            timeout: 10000,
            env: getEnhancedEnv({
              includeCanopySecrets: false,
              environment: false,
            }),
          },
          (error): void => {
            if (error)
              reject(
                error instanceof Error
                  ? error
                  : new Error('Download marking failed'),
              );
            else resolvePromise();
          },
        );
      });
    } else if (platform === 'win32') {
      const stream = await open(
        `${path}:Zone.Identifier`,
        constants.O_CREAT |
          constants.O_WRONLY |
          constants.O_TRUNC |
          constants.O_NOFOLLOW,
        0o600,
      );
      try {
        await stream.writeFile('[ZoneTransfer]\r\nZoneId=3\r\n');
        await stream.sync();
      } finally {
        await stream.close();
      }
    }
  }
  private publish(
    record: StoredDownload | StoredCopy | StoredUpload,
    force = false,
  ): void {
    for (const watch of Array.from(this.watchers)) watch();
    const previous = this.emittedAt.get(record.id);
    const time = this.now();
    if (!force && previous !== undefined && time - previous < 250) {
      if (!this.timers.has(record.id)) {
        const timer = setTimeout(
          (): void => {
            this.timers.delete(record.id);
            this.publish(record, true);
          },
          250 - (time - previous),
        );
        timer.unref?.();
        this.timers.set(record.id, timer);
      }
      return;
    }
    clearTimeout(this.timers.get(record.id));
    this.timers.delete(record.id);
    this.emittedAt.set(record.id, time);
    this.deps.emit({
      type: 'transfer',
      browserId: record.browserId,
      transfer: transferDto(record),
    });
  }
  setAttribution(
    runtime: BrowserRuntimeKey,
    actionId: string | undefined,
  ): void {
    if (actionId === undefined) this.attributions.delete(runtimeKey(runtime));
    else this.attributions.set(runtimeKey(runtime), actionId);
  }
  attributionFor(runtime: BrowserRuntimeKey): string | undefined {
    return this.attributions.get(runtimeKey(runtime));
  }
  forAction(
    runtime: BrowserRuntimeKey,
    actionId: string,
  ): BrowserDownloadTransfer[] {
    return Array.from(this.tasks.values()).flatMap(
      (state): BrowserDownloadTransfer[] =>
        Array.from(state.records.values())
          .filter(
            (record): boolean =>
              record.browserId === runtime.browserId &&
              record.runtimeGeneration === runtime.runtimeGeneration &&
              record.taskIncarnationId === runtime.taskIncarnationId &&
              record.actionId === actionId,
          )
          .map(dto),
    );
  }
  list(
    scope: BrowserTaskFilesScope,
    browserId: string,
    request: BrowserListTransfersRequest,
  ): BrowserListTransfersResult {
    const state = this.tasks.get(key(scope));
    const records = [
      ...Array.from(state?.records.values() ?? []),
      ...Array.from(state?.copies.values() ?? []),
      ...Array.from(state?.uploads.values() ?? []),
    ]
      .filter(
        (record): boolean =>
          record.browserId === browserId &&
          (!request.kind || record.kind === request.kind) &&
          (!request.status || record.status === request.status),
      )
      .sort((a, b): number => b.startedAt - a.startedAt);
    const offset =
      Number.isSafeInteger(request.offset) && request.offset !== undefined
        ? Math.max(0, request.offset)
        : 0;
    const limit =
      Number.isSafeInteger(request.limit) && request.limit !== undefined
        ? Math.max(1, Math.min(100, request.limit))
        : 25;
    return {
      transfers: records.slice(offset, offset + limit).map(transferDto),
      total: records.length,
      offset,
      limit,
    };
  }
  get(scope: BrowserTaskFilesScope, id: string): BrowserTransfer | undefined {
    const state = this.tasks.get(key(scope));
    const record =
      state?.records.get(id) ?? state?.copies.get(id) ?? state?.uploads.get(id);
    return record ? transferDto(record) : undefined;
  }
  /**
   * Copies a finished download of this browser to a prepared destination. The
   * copy runs as its own transfer, with progress and cancel; it never counts
   * toward the download guard.
   */
  startCopy(
    scope: BrowserTaskFilesScope,
    input: {
      browserId: string;
      downloadId: string;
      source: 'user' | 'agent';
      actionId?: string;
      destinationName: string;
      destination: CopyDestination;
      overwrite: boolean;
    },
  ):
    | { ok: true; transfer: BrowserCopyTransfer }
    | { ok: false; error: BrowserTransferError } {
    const notFound = {
      ok: false as const,
      error: {
        code: 'not_found' as const,
        message: 'This browser has no download with that id.',
      },
    };
    if (this.fenced.has(key(scope))) return notFound;
    let state: TaskState;
    try {
      state = this.task(scope);
    } catch {
      return {
        ok: false,
        error: { code: 'copy_failed', message: COPY_MESSAGES.copy_failed },
      };
    }
    if (state.error)
      return {
        ok: false,
        error: { code: 'copy_failed', message: COPY_MESSAGES.copy_failed },
      };
    const download = state.records.get(input.downloadId);
    if (!download || download.browserId !== input.browserId) return notFound;
    if (download.status !== 'complete')
      return {
        ok: false,
        error: {
          code: 'file_not_eligible',
          message: 'Only a finished download can be copied.',
        },
      };
    const file = this.downloadFile(state, download);
    if (!file)
      return {
        ok: false,
        error: { code: 'file_not_eligible', message: COPY_MESSAGES.not_found },
      };
    const { path: source, stat: sourceStat } = file;
    const tempName = copyTempName();
    const copy: StoredCopy = {
      kind: 'copy',
      id: randomUUID(),
      browserId: input.browserId,
      sourceId: download.id,
      source: input.source,
      ...(input.actionId ? { actionId: input.actionId } : {}),
      destinationName: input.destinationName,
      copiedBytes: 0,
      totalBytes: sourceStat.size,
      status: 'in_progress',
      startedAt: this.now(),
      tempPath: join(
        input.destination.base,
        ...input.destination.missing,
        tempName,
      ),
    };
    state.copies.set(copy.id, copy);
    const controller = new AbortController();
    const done = this.runCopy(state, copy, {
      controller,
      source,
      sourceIdentity: { dev: sourceStat.dev, ino: sourceStat.ino },
      destination: input.destination,
      overwrite: input.overwrite,
      tempName,
    });
    this.running.set(copy.id, { controller, done });
    this.publish(copy, true);
    return { ok: true, transfer: copyDto(copy) };
  }
  private async runCopy(
    state: TaskState,
    copy: StoredCopy,
    run: {
      controller: AbortController;
      source: string;
      sourceIdentity: { dev: number; ino: number };
      destination: CopyDestination;
      overwrite: boolean;
      tempName: string;
    },
  ): Promise<void> {
    const { signal } = run.controller;
    let outcome: {
      status: 'complete' | 'cancelled' | 'failed';
      error?: BrowserTransferError;
    };
    try {
      // The temp file's path is in the catalog before the file exists, so a
      // crash cannot leave a temp file that recovery does not know about.
      await this.enqueue(state, (): Promise<void> => this.write(state));
      if (state.error)
        throw new CopyError('copy_failed', COPY_MESSAGES.copy_failed);
      const { bytes } = await copyIntoDestination({
        source: run.source,
        sourceIdentity: run.sourceIdentity,
        destination: run.destination,
        overwrite: run.overwrite,
        tempName: run.tempName,
        signal,
        onProgress: (copied): void => {
          copy.copiedBytes = copied;
          this.publish(copy);
        },
        // A copy leaves the task's folder, so it keeps the download's marking.
        mark: (path): Promise<void> => this.applyMarking(path),
      });
      copy.copiedBytes = bytes;
      outcome = { status: 'complete' };
    } catch (error) {
      outcome = signal.aborted
        ? { status: 'cancelled' }
        : {
            status: 'failed',
            error:
              error instanceof CopyError
                ? { code: copyErrorCode(error.code), message: error.message }
                : { code: 'copy_failed', message: COPY_MESSAGES.copy_failed },
          };
    }
    const finished: StoredCopy = {
      ...copy,
      status: outcome.status,
      endedAt: this.now(),
    };
    delete finished.tempPath;
    if (outcome.error)
      finished.error = {
        code: copyErrorCode(outcome.error.code),
        message: outcome.error.message,
      };
    // Readers see the copy as running until its end is on disk. The shared
    // record changes inside the queued write, so no later write can undo it,
    // and `enqueue` absorbs a failed write, so success is noted there too.
    const settle = (): void => {
      Object.assign(copy, finished);
      delete copy.tempPath;
    };
    let recorded = false;
    await this.enqueue(state, async (): Promise<void> => {
      await this.write(state, finished);
      settle();
      recorded = true;
    });
    if (!recorded) settle();
    if (!recorded && copy.status === 'complete') {
      // The file is saved, but its record is not: the next start reads the
      // copy as interrupted and fails it, so report that now.
      copy.status = 'failed';
      copy.error = {
        code: 'copy_failed',
        message: 'The copy was saved, but it could not be recorded.',
      };
    }
    this.running.delete(copy.id);
    this.publish(copy, true);
  }
  /** A finished download's own file in the task folder, or undefined when it is not safe to read. */
  private downloadFile(
    state: TaskState,
    download: StoredDownload,
  ): { path: string; real: string; stat: Stats } | undefined {
    try {
      this.check(state);
      const path = join(state.downloads, download.fileName);
      const stat = lstatSync(path);
      const real = realpathSync(path);
      if (
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        stat.nlink !== 1 ||
        !inside(state.rootReal, real)
      )
        return undefined;
      return { path, real, stat };
    } catch {
      return undefined;
    }
  }
  /** A finished download of this browser, as a file to upload. */
  downloadUploadSource(
    scope: BrowserTaskFilesScope,
    browserId: string,
    downloadId: string,
  ): UploadSourceResult | { ok: false; error: BrowserTransferError } {
    const state = this.tasks.get(key(scope));
    const download = state?.records.get(downloadId);
    if (!state || !download || download.browserId !== browserId)
      return {
        ok: false,
        error: {
          code: 'not_found',
          message: 'This browser has no download with that id.',
        },
      };
    const file =
      download.status === 'complete'
        ? this.downloadFile(state, download)
        : undefined;
    if (!file)
      return {
        ok: false,
        error: {
          code: 'file_not_eligible',
          message: 'Only a finished download can be uploaded.',
        },
      };
    return {
      ok: true,
      source: {
        kind: 'download',
        name: download.fileName,
        displayPath: `${download.fileName} (downloaded)`,
        // Staging refuses a link anywhere in the path, so it opens the real one.
        path: file.real,
        identity: { dev: file.stat.dev, ino: file.stat.ino },
        sizeBytes: file.stat.size,
      },
    };
  }
  private uploadFolder(state: TaskState, id: string): string {
    return join(state.folder, 'uploads', id);
  }
  /** Removes an upload's staged copies, once nothing needs them. */
  private async removeStagedUpload(
    state: TaskState,
    id: string,
  ): Promise<void> {
    try {
      this.check(state);
      await removeStagedFolder(this.uploadFolder(state, id));
    } catch {
      /* Left for the task's next start, which removes every staged copy. */
    }
  }
  /** Removes every staged upload folder but those still staging. */
  private async removeStagedUploads(state: TaskState): Promise<void> {
    const uploads = join(state.folder, 'uploads');
    for (const id of exists(uploads) ? readdirSync(uploads) : [])
      if (!this.running.has(id)) await this.removeStagedUpload(state, id);
  }
  /**
   * Stages files for an upload as private, read-only copies whose bytes are
   * hashed. The upload waits for approval once staging ends; nothing is
   * attached here.
   */
  startUpload(
    scope: BrowserTaskFilesScope,
    input: {
      browserId: string;
      actionId?: string;
      frameOrigin: string;
      topOrigin: string;
      sources: UploadSource[];
    },
  ):
    | { ok: true; transfer: BrowserUploadTransfer }
    | { ok: false; error: BrowserTransferError } {
    const unavailable = {
      ok: false as const,
      error: { code: 'upload_failed' as const, message: UPLOAD_FAILED },
    };
    if (this.fenced.has(key(scope))) return unavailable;
    let state: TaskState;
    try {
      state = this.task(scope);
    } catch {
      return unavailable;
    }
    if (state.error) return unavailable;
    const upload: StoredUpload = {
      kind: 'upload',
      id: randomUUID(),
      browserId: input.browserId,
      ...(input.actionId ? { actionId: input.actionId } : {}),
      frameOrigin: input.frameOrigin,
      topOrigin: input.topOrigin,
      files: input.sources.map((source) => ({
        name: source.name,
        displayPath: source.displayPath,
        sizeBytes: source.sizeBytes,
      })),
      stagedBytes: 0,
      totalBytes: input.sources.reduce(
        (total, source) => total + source.sizeBytes,
        0,
      ),
      status: 'staging',
      startedAt: this.now(),
    };
    if (!uploadSchema.safeParse(upload).success) return unavailable;
    state.uploads.set(upload.id, upload);
    const controller = new AbortController();
    const done = this.runStaging(state, upload, input.sources, controller);
    this.running.set(upload.id, { controller, done });
    this.publish(upload, true);
    this.deps.recordEvent?.(state.scope, {
      kind: 'browser_upload_requested',
      origin: upload.frameOrigin,
      topOrigin: upload.topOrigin,
      files: input.sources.map((source) => ({
        name: source.name,
        sizeBytes: source.sizeBytes,
        source: source.kind,
      })),
    });
    return { ok: true, transfer: uploadDto(upload) };
  }
  private async runStaging(
    state: TaskState,
    upload: StoredUpload,
    sources: UploadSource[],
    controller: AbortController,
  ): Promise<void> {
    const { signal } = controller;
    const finished: StoredUpload = { ...upload, files: [...upload.files] };
    try {
      // The upload is in the catalog before its folder exists, so recovery knows it.
      await this.enqueue(state, (): Promise<void> => this.write(state));
      if (state.error) throw new UploadError('upload_failed', UPLOAD_FAILED);
      this.check(state);
      safeDirectory(join(state.folder, 'uploads'));
      const folder = this.uploadFolder(state, upload.id);
      safeDirectory(folder);
      let stagedBytes = 0;
      for (let index = 0; index < sources.length; index++) {
        const source = sources[index];
        if (!source) continue;
        const fileFolder = join(folder, String(index));
        safeDirectory(fileFolder);
        const staged = await stageUploadFile({
          source,
          destination: join(fileFolder, source.name),
          signal,
          onProgress: (bytes): void => {
            upload.stagedBytes = stagedBytes + bytes;
            this.publish(upload);
          },
        });
        await chmod(fileFolder, 0o500);
        stagedBytes += staged.sizeBytes;
        finished.files[index] = {
          ...upload.files[index],
          name: source.name,
          displayPath: source.displayPath,
          sizeBytes: staged.sizeBytes,
          sha256: staged.sha256,
        };
      }
      finished.stagedBytes = stagedBytes;
      finished.totalBytes = stagedBytes;
      finished.status = 'awaiting_approval';
    } catch (error) {
      finished.status = signal.aborted ? 'cancelled' : 'failed';
      finished.endedAt = this.now();
      if (!signal.aborted)
        finished.error =
          error instanceof UploadError
            ? { code: uploadErrorCode(error.code), message: error.message }
            : {
                code:
                  error &&
                  typeof error === 'object' &&
                  'code' in error &&
                  error.code === 'ENOSPC'
                    ? 'disk_full'
                    : 'upload_failed',
                message:
                  error &&
                  typeof error === 'object' &&
                  'code' in error &&
                  error.code === 'ENOSPC'
                    ? 'Not enough disk space.'
                    : UPLOAD_FAILED,
              };
    }
    // Readers see the upload staging until its end is on disk.
    let recorded = false;
    await this.enqueue(state, async (): Promise<void> => {
      await this.write(state, finished);
      Object.assign(upload, finished);
      recorded = true;
    });
    if (!recorded) {
      Object.assign(upload, finished);
      if (upload.status === 'awaiting_approval') {
        upload.status = 'failed';
        upload.endedAt = this.now();
        upload.error = { code: 'upload_failed', message: UPLOAD_FAILED };
      }
    }
    // A cancel that arrived while that end was being recorded still wins.
    // Nothing has read it yet: readers wait until staging stops running.
    if (upload.status === 'awaiting_approval' && signal.aborted) {
      upload.status = 'cancelled';
      upload.endedAt = this.now();
      await this.enqueue(state, (): Promise<void> => this.write(state));
    }
    if (upload.status !== 'awaiting_approval')
      await this.removeStagedUpload(state, upload.id);
    this.running.delete(upload.id);
    this.publish(upload, true);
  }
  /** The staged copies' paths, in file order, while the upload has them. */
  stagedUploadPaths(
    scope: BrowserTaskFilesScope,
    id: string,
  ): string[] | undefined {
    const state = this.tasks.get(key(scope));
    const upload = state?.uploads.get(id);
    if (!state || !upload || upload.status === 'staging') return undefined;
    const folder = this.uploadFolder(state, id);
    return upload.files.map((file, index) =>
      join(folder, String(index), file.name),
    );
  }
  /** Whether every staged copy still holds the bytes that were hashed. */
  async stagedUploadMatches(
    scope: BrowserTaskFilesScope,
    id: string,
  ): Promise<boolean> {
    const state = this.tasks.get(key(scope));
    const upload = state?.uploads.get(id);
    const paths = this.stagedUploadPaths(scope, id);
    if (!state || !upload || !paths) return false;
    try {
      this.check(state);
    } catch {
      return false;
    }
    for (let index = 0; index < upload.files.length; index++) {
      const file = upload.files[index];
      const path = paths[index];
      if (
        !file ||
        !path ||
        file.sha256 === undefined ||
        !(await stagedFileMatches(path, {
          sha256: file.sha256,
          sizeBytes: file.sizeBytes,
        }))
      )
        return false;
    }
    return true;
  }
  /**
   * Ends an upload that waits for approval. One that already ended stays as
   * it ended. Every end but `attached` removes the staged copies.
   */
  async endUpload(
    scope: BrowserTaskFilesScope,
    id: string,
    outcome: {
      status: 'attached' | 'denied' | 'failed' | 'cancelled';
      error?: BrowserTransferError;
    },
  ): Promise<BrowserUploadTransfer | undefined> {
    const state = this.tasks.get(key(scope));
    const upload = state?.uploads.get(id);
    if (!state || !upload) return undefined;
    if (
      upload.status !== 'awaiting_approval' ||
      this.running.has(id) ||
      this.ending.has(id) ||
      (this.attaching.has(id) && outcome.status === 'cancelled')
    )
      return uploadDto(upload);
    this.ending.add(id);
    const finished: StoredUpload = {
      ...upload,
      status: outcome.status,
      endedAt: this.now(),
      ...(outcome.error
        ? {
            error: {
              code: uploadErrorCode(outcome.error.code),
              message: outcome.error.message,
            },
          }
        : {}),
    };
    try {
      // Nothing reads the upload as ended before its copies are gone. An
      // attach has happened whether or not its record is saved.
      if (finished.status !== 'attached')
        await this.removeStagedUpload(state, id);
      Object.assign(upload, finished);
      await this.enqueue(state, (): Promise<void> => this.write(state));
    } finally {
      this.ending.delete(id);
      this.attaching.delete(id);
    }
    this.publish(upload, true);
    if (finished.status === 'denied' || finished.status === 'attached')
      this.deps.recordEvent?.(
        state.scope,
        finished.status === 'denied'
          ? {
              ...uploadEvent(upload),
              kind: 'browser_upload_decided',
              decision: 'deny',
            }
          : { ...uploadEvent(upload), kind: 'browser_upload_attached' },
      );
    return uploadDto(upload);
  }
  /**
   * Claims an upload that waits for approval for attaching, so it can no
   * longer be cancelled. False when it is not waiting.
   */
  beginAttach(scope: BrowserTaskFilesScope, id: string): boolean {
    const upload = this.tasks.get(key(scope))?.uploads.get(id);
    if (
      !upload ||
      upload.status !== 'awaiting_approval' ||
      this.running.has(id) ||
      this.ending.has(id)
    )
      return false;
    this.attaching.add(id);
    this.deps.recordEvent?.(scope, {
      ...uploadEvent(upload),
      kind: 'browser_upload_decided',
      decision: 'allow',
    });
    return true;
  }
  /** Cancels an upload while it stages or waits for approval. False once it ended. */
  cancelUpload(scope: BrowserTaskFilesScope, id: string): boolean {
    const upload = this.tasks.get(key(scope))?.uploads.get(id);
    if (!upload) return false;
    const running = this.running.get(id);
    if (running) {
      running.controller.abort();
      return true;
    }
    if (
      upload.status !== 'awaiting_approval' ||
      this.attaching.has(id) ||
      this.ending.has(id)
    )
      return false;
    void this.endUpload(scope, id, { status: 'cancelled' });
    return true;
  }
  /** Removes the staged copies of a browser that closed: its pages can no longer read them. */
  async releaseUploads(
    scope: BrowserTaskFilesScope,
    browserId: string,
  ): Promise<void> {
    const state = this.tasks.get(key(scope));
    if (!state) return;
    for (const upload of Array.from(state.uploads.values())) {
      if (upload.browserId !== browserId) continue;
      const running = this.running.get(upload.id);
      if (running) {
        running.controller.abort();
        await running.done;
      } else if (upload.status === 'awaiting_approval')
        await this.endUpload(scope, upload.id, {
          status: 'cancelled',
        });
      await this.removeStagedUpload(state, upload.id);
    }
  }
  /** Ends a copy that is not running, as recovery does. */
  private settleCopy(
    copy: StoredCopy,
    status: 'cancelled' | 'failed',
    error?: BrowserTransferError,
  ): void {
    copy.status = status;
    copy.endedAt = this.now();
    delete copy.tempPath;
    if (error)
      copy.error = { code: copyErrorCode(error.code), message: error.message };
    this.publish(copy, true);
  }
  /** Stops a running copy of this task. False when it is not running. */
  cancelCopy(scope: BrowserTaskFilesScope, id: string): boolean {
    const running = this.running.get(id);
    if (!running || !this.tasks.get(key(scope))?.copies.has(id)) return false;
    running.controller.abort();
    return true;
  }
  /**
   * Resolves with the transfer once it has ended, or undefined if there is
   * none or on abort. With `staged`, an upload resolves once staging ends.
   */
  waitForTransfer(
    scope: BrowserTaskFilesScope,
    id: string,
    options: { signal: AbortSignal; staged?: boolean },
  ): Promise<BrowserTransfer | undefined> {
    if (options.signal.aborted) return Promise.resolve(undefined);
    return new Promise((resolvePromise): void => {
      const settle = (transfer: BrowserTransfer | undefined): void => {
        this.watchers.delete(check);
        options.signal.removeEventListener('abort', abort);
        resolvePromise(transfer);
      };
      const abort = (): void => settle(undefined);
      const check = (): void => {
        const state = this.tasks.get(key(scope));
        const upload = state?.uploads.get(id);
        if (upload) {
          if (
            !this.running.has(id) &&
            (uploadEnded(upload) ||
              (options.staged === true && upload.status !== 'staging'))
          )
            settle(uploadDto(upload));
          return;
        }
        const copy = state?.copies.get(id);
        if (copy) {
          if (copy.status !== 'in_progress' && !this.running.has(id))
            settle(copyDto(copy));
          return;
        }
        const download = state?.records.get(id);
        if (!download) settle(undefined);
        else if (final(download)) settle(dto(download));
      };
      this.watchers.add(check);
      options.signal.addEventListener('abort', abort, { once: true });
      check();
    });
  }
  waitForDownload(
    scope: BrowserTaskFilesScope,
    browserId: string,
    options: {
      downloadId?: string;
      since: number;
      signal: AbortSignal;
      onProgress?: (download: BrowserDownloadTransfer) => void;
    },
  ): Promise<BrowserDownloadTransfer | undefined> {
    if (options.signal.aborted) return Promise.resolve(undefined);
    const present = new Set(this.tasks.get(key(scope))?.records.keys() ?? []);
    return new Promise((resolvePromise): void => {
      let selected = options.downloadId;
      const settle = (record: BrowserDownloadTransfer | undefined): void => {
        this.watchers.delete(check);
        options.signal.removeEventListener('abort', abort);
        resolvePromise(record);
      };
      const abort = (): void => settle(undefined);
      const check = (): void => {
        const state = this.tasks.get(key(scope));
        if (!selected)
          selected = Array.from(state?.records.values() ?? [])
            .filter(
              (record): boolean =>
                record.browserId === browserId &&
                (record.startedAt > options.since ||
                  (record.startedAt === options.since &&
                    !present.has(record.id))),
            )
            .sort((a, b): number => a.startedAt - b.startedAt)[0]?.id;
        const record = selected ? state?.records.get(selected) : undefined;
        if (!record || record.browserId !== browserId) return;
        const transfer = dto(record);
        options.onProgress?.(transfer);
        if (final(record)) settle(transfer);
      };
      this.watchers.add(check);
      options.signal.addEventListener('abort', abort, { once: true });
      check();
    });
  }
  /** Called with each download the store fails while its native download may still run. */
  onDownloadFailed(listener: (id: string) => void): () => void {
    this.failureListeners.add(listener);
    return (): void => {
      this.failureListeners.delete(listener);
    };
  }
  allowMore(browserId: string): void {
    this.windows.delete(browserId);
    this.blocked.delete(browserId);
    clearTimeout(this.blockedNotices.get(browserId)?.timer);
    this.blockedNotices.delete(browserId);
  }
  /**
   * Announces a block at most once a second for each browser, and once more
   * after a burst, so a dismissed notice comes back with the next block and
   * a hostile loop cannot flood the window.
   */
  private announceBlocked(browserId: string): void {
    const emit = (): void => {
      this.blockedNotices.set(browserId, { at: this.now() });
      this.deps.emit({
        type: 'download-blocked',
        browserId,
        blockedCount: this.blocked.get(browserId) ?? 1,
      });
    };
    const notice = this.blockedNotices.get(browserId);
    const time = this.now();
    if (!notice || time - notice.at >= BLOCKED_NOTICE_INTERVAL_MS) {
      clearTimeout(notice?.timer);
      emit();
      return;
    }
    if (notice.timer) return;
    notice.timer = setTimeout(
      emit,
      BLOCKED_NOTICE_INTERVAL_MS - (time - notice.at),
    );
    notice.timer.unref?.();
  }
  resolveLocalPath(
    scope: BrowserTaskFilesScope,
    id: string,
  ): Promise<string | undefined> {
    const state = this.tasks.get(key(scope));
    const record = state?.records.get(id);
    if (!state || record?.status !== 'complete')
      return Promise.resolve(undefined);
    try {
      this.check(state);
      const path = join(state.downloads, record.fileName);
      const stat = lstatSync(path);
      if (
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        stat.nlink !== 1 ||
        !inside(state.rootReal, realpathSync(path))
      )
        return Promise.resolve(undefined);
      return Promise.resolve(path);
    } catch {
      return Promise.resolve(undefined);
    }
  }
  fence(scope: BrowserTaskFilesScope): void {
    this.fenced.add(key(scope));
  }
  async drain(): Promise<void> {
    for (;;) {
      const tails = Array.from(
        this.tasks.values(),
        (state): Promise<void> => state.tail,
      );
      await Promise.all(tails);
      if (
        Array.from(this.tasks.values()).every(
          (state, index): boolean => state.tail === tails[index],
        )
      )
        break;
    }
    // Only partials a failed cleanup left behind; each is removed once.
    for (const state of Array.from(this.tasks.values()))
      for (const record of Array.from(state.records.values()))
        if (final(record) && record.status !== 'complete')
          this.removePartial(state, record);
  }
  async removeTask(scope: BrowserTaskFilesScope): Promise<void> {
    this.fence(scope);
    // Copies write outside the task folder, and staging writes into it: stop
    // them before it goes.
    const copies = [
      ...Array.from(this.tasks.get(key(scope))?.copies.keys() ?? []),
      ...Array.from(this.tasks.get(key(scope))?.uploads.keys() ?? []),
    ]
      .map((id) => this.running.get(id))
      .filter((run) => run !== undefined);
    for (const run of copies) run.controller.abort();
    await Promise.all(copies.map((run) => run.done));
    await this.drain();
    let state = this.tasks.get(key(scope));
    if (!state) {
      const root =
        this.deps.taskDir?.(scope) ??
        getWorktreeDataDir(scope.projectId, scope.worktreeId);
      try {
        lstatSync(join(root, 'browser-files'));
      } catch (error) {
        if (absent(error)) return;
        throw error;
      }
      state = this.task(scope, false);
    }
    if (state) {
      this.check(state);
      // Copies a quit or crash interrupted left temp files outside this folder.
      for (const copy of Array.from(state.copies.values()))
        if (copy.status === 'in_progress' && !this.running.has(copy.id))
          removeCopyTemp(copy);
      for (const record of [
        ...Array.from(state.records.values()),
        ...Array.from(state.copies.values()),
        ...Array.from(state.uploads.values()),
      ]) {
        clearTimeout(this.timers.get(record.id));
        this.timers.delete(record.id);
      }
      await this.removeStagedUploads(state);
      await rm(state.folder, { recursive: true, force: true });
      this.tasks.delete(key(scope));
    }
  }
}
