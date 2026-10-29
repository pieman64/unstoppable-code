import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, normalize } from 'node:path';
import {
  isReviewAnnotation,
  isReviewCommentThread,
  type FileAnnotationDocument,
  type FileAnnotationsAppendRequest,
  type FileAnnotationsSaveRequest,
  type FileAnnotationsState,
  type ReviewComment,
  type ReviewCommentThread,
} from '@canopy/desktop-shared/types';
import { getFileAnnotationsStateFilePath } from './paths';
import { isErrnoException } from './type-guards';

const writeLocks = new Map<string, Promise<void>>();

async function withFileLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = writeLocks.get(key) ?? Promise.resolve();
  let release = (): void => undefined;
  const next = new Promise<void>((resolve) => {
    release = resolve;
  });
  writeLocks.set(key, next);
  await previous;
  try {
    return await fn();
  } finally {
    release();
    if (writeLocks.get(key) === next) {
      writeLocks.delete(key);
    }
  }
}

function emptyDocument(filePath: string): FileAnnotationDocument {
  return { filePath: normalize(filePath), annotations: [], commentThreads: [] };
}

function isPositiveLine(value: number | undefined): value is number {
  return (
    value !== undefined &&
    Number.isInteger(value) &&
    Number.isFinite(value) &&
    value >= 1
  );
}

function hasValidAnnotationRange(
  annotation: FileAnnotationDocument['annotations'][number],
): boolean {
  return (
    isPositiveLine(annotation.lineStart) &&
    isPositiveLine(annotation.lineEnd) &&
    annotation.lineEnd >= annotation.lineStart
  );
}

function hasValidThreadRange(
  thread: FileAnnotationDocument['commentThreads'][number],
): boolean {
  const { lineStart, lineEnd, unanchored } = thread.anchor;
  if (unanchored === true) {
    return lineStart === undefined && lineEnd === undefined;
  }
  if (lineStart === undefined) {
    return lineEnd === undefined;
  }
  return (
    isPositiveLine(lineStart) &&
    (lineEnd === undefined || (isPositiveLine(lineEnd) && lineEnd >= lineStart))
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeDocument(value: unknown): FileAnnotationDocument | null {
  if (!isRecord(value)) {
    return null;
  }
  if (typeof value.filePath !== 'string') {
    return null;
  }
  return {
    filePath: normalize(value.filePath),
    annotations: Array.isArray(value.annotations)
      ? value.annotations
          .filter(isReviewAnnotation)
          .filter(hasValidAnnotationRange)
      : [],
    commentThreads: Array.isArray(value.commentThreads)
      ? value.commentThreads
          .filter(isReviewCommentThread)
          .filter(hasValidThreadRange)
      : [],
  };
}

function normalizeState(value: unknown): FileAnnotationsState {
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.files)) {
    throw new Error('Invalid file annotations state');
  }
  return {
    version: 1,
    files: value.files
      .map(normalizeDocument)
      .filter((entry): entry is FileAnnotationDocument => entry !== null),
  };
}

async function readState(
  projectId: string,
  worktreeId: string,
): Promise<FileAnnotationsState> {
  let raw: string;
  try {
    raw = await readFile(
      getFileAnnotationsStateFilePath(projectId, worktreeId),
      'utf8',
    );
  } catch (error) {
    if (isErrnoException(error) && error.code === 'ENOENT') {
      return { version: 1, files: [] };
    }
    throw error;
  }
  try {
    return normalizeState(JSON.parse(raw));
  } catch {
    return { version: 1, files: [] };
  }
}

async function writeState(
  projectId: string,
  worktreeId: string,
  state: FileAnnotationsState,
): Promise<void> {
  const filePath = getFileAnnotationsStateFilePath(projectId, worktreeId);
  await mkdir(dirname(filePath), { recursive: true });
  const tempPath = join(
    dirname(filePath),
    `.file-annotations-${randomUUID()}.tmp`,
  );
  try {
    await writeFile(tempPath, JSON.stringify(state, null, 2), 'utf8');
    await rename(tempPath, filePath);
  } catch (error) {
    await unlink(tempPath).catch(() => undefined);
    throw error;
  }
}

function findDocument(
  state: FileAnnotationsState,
  filePath: string,
): FileAnnotationDocument | undefined {
  const target = normalize(filePath);
  return state.files.find((entry) => entry.filePath === target);
}

function replaceDocument(
  state: FileAnnotationsState,
  document: FileAnnotationDocument,
): FileAnnotationsState {
  const existingIndex = state.files.findIndex(
    (entry) => entry.filePath === document.filePath,
  );
  if (existingIndex < 0) {
    return { ...state, files: [...state.files, document] };
  }
  const files = [...state.files];
  files[existingIndex] = document;
  return { ...state, files };
}

function mergeThreads(
  stored: ReviewCommentThread[],
  incoming: ReviewCommentThread[],
  baseCommentThreadIds: string[],
): ReviewCommentThread[] {
  const storedById = new Map(stored.map((thread) => [thread.id, thread]));
  const incomingIds = new Set(incoming.map((thread) => thread.id));
  const baseIds = new Set(baseCommentThreadIds);
  const mergedIncoming = incoming.map((thread) => {
    const existing = storedById.get(thread.id);
    if (!existing) return thread;
    const incomingCommentIds = new Set(
      thread.comments.map((comment) => comment.id),
    );
    const preservedAgentComments = existing.comments.filter(
      (comment) =>
        comment.author === 'agent' && !incomingCommentIds.has(comment.id),
    );
    return {
      ...thread,
      status:
        existing.status === 'resolved' &&
        thread.status === 'open' &&
        preservedAgentComments.length > 0
          ? existing.status
          : thread.status,
      comments: [...thread.comments, ...preservedAgentComments],
    };
  });
  const concurrentThreads = stored.filter(
    (thread) => !incomingIds.has(thread.id) && !baseIds.has(thread.id),
  );
  return [...mergedIncoming, ...concurrentThreads];
}

export async function readFileAnnotationDocument(
  projectId: string,
  worktreeId: string,
  filePath: string,
): Promise<FileAnnotationDocument> {
  const state = await readState(projectId, worktreeId);
  return findDocument(state, filePath) ?? emptyDocument(filePath);
}

export async function saveFileAnnotationDocument(
  request: FileAnnotationsSaveRequest,
): Promise<FileAnnotationDocument> {
  const statePath = getFileAnnotationsStateFilePath(
    request.projectId,
    request.worktreeId,
  );
  return withFileLock(statePath, async () => {
    const state = await readState(request.projectId, request.worktreeId);
    const incoming = normalizeDocument(request.document);
    if (!incoming) {
      throw new Error('Invalid file annotation document.');
    }
    const stored = findDocument(state, incoming.filePath);
    const annotationById = new Map(
      (stored?.annotations ?? []).map((annotation) => [
        annotation.id,
        annotation,
      ]),
    );
    for (const annotation of incoming.annotations) {
      annotationById.set(annotation.id, annotation);
    }
    const document: FileAnnotationDocument = {
      ...incoming,
      annotations: Array.from(annotationById.values()),
      commentThreads: mergeThreads(
        stored?.commentThreads ?? [],
        incoming.commentThreads,
        request.baseCommentThreadIds,
      ),
    };
    await writeState(
      request.projectId,
      request.worktreeId,
      replaceDocument(state, document),
    );
    return document;
  });
}

export async function appendFileAnnotations(
  request: FileAnnotationsAppendRequest,
): Promise<FileAnnotationDocument> {
  const statePath = getFileAnnotationsStateFilePath(
    request.projectId,
    request.worktreeId,
  );
  return withFileLock(statePath, async () => {
    const state = await readState(request.projectId, request.worktreeId);
    const incoming = normalizeDocument({
      filePath: request.filePath,
      annotations: request.annotations,
      commentThreads: request.commentThreads,
    });
    if (!incoming) {
      throw new Error('Invalid file annotation append request.');
    }
    const stored =
      findDocument(state, incoming.filePath) ??
      emptyDocument(incoming.filePath);
    const annotationIds = new Set(
      stored.annotations.map((annotation) => annotation.id),
    );
    const threadIds = new Set(stored.commentThreads.map((thread) => thread.id));
    const document: FileAnnotationDocument = {
      ...stored,
      annotations: [
        ...stored.annotations,
        ...incoming.annotations.filter(
          (annotation) => !annotationIds.has(annotation.id),
        ),
      ],
      commentThreads: [
        ...stored.commentThreads,
        ...incoming.commentThreads.filter(
          (thread) => !threadIds.has(thread.id),
        ),
      ],
    };
    await writeState(
      request.projectId,
      request.worktreeId,
      replaceDocument(state, document),
    );
    return document;
  });
}

export async function dismissFileAnnotation(request: {
  projectId: string;
  worktreeId: string;
  filePath: string;
  annotationId: string;
}): Promise<FileAnnotationDocument> {
  const statePath = getFileAnnotationsStateFilePath(
    request.projectId,
    request.worktreeId,
  );
  return withFileLock(statePath, async () => {
    const state = await readState(request.projectId, request.worktreeId);
    const stored =
      findDocument(state, request.filePath) ?? emptyDocument(request.filePath);
    const document: FileAnnotationDocument = {
      ...stored,
      annotations: stored.annotations.filter(
        (annotation) => annotation.id !== request.annotationId,
      ),
      // Clearing an agent highlight must not discard its discussion. Detach
      // any existing thread from the removed annotation so it becomes a
      // regular line-anchored file comment.
      commentThreads: stored.commentThreads.map((thread) =>
        thread.anchor.annotationId === request.annotationId
          ? {
              ...thread,
              anchor: { ...thread.anchor, annotationId: undefined },
            }
          : thread,
      ),
    };
    await writeState(
      request.projectId,
      request.worktreeId,
      replaceDocument(state, document),
    );
    return document;
  });
}

export interface RespondToFileCommentResult {
  ok: boolean;
  resolved: boolean;
  document?: FileAnnotationDocument;
  error?: string;
}

function hasSubmittedUserComment(thread: ReviewCommentThread): boolean {
  return thread.comments.some(
    (comment) => comment.author === 'user' && comment.staged !== true,
  );
}

export async function respondToFileComment(request: {
  projectId: string;
  worktreeId: string;
  threadId: string;
  body: string;
  resolve: boolean;
}): Promise<RespondToFileCommentResult> {
  const statePath = getFileAnnotationsStateFilePath(
    request.projectId,
    request.worktreeId,
  );
  return withFileLock(statePath, async () => {
    const state = await readState(request.projectId, request.worktreeId);
    const document = state.files.find((entry) =>
      entry.commentThreads.some(
        (thread) =>
          thread.id === request.threadId && hasSubmittedUserComment(thread),
      ),
    );
    if (!document) {
      return {
        ok: false,
        resolved: false,
        error: 'File comment thread not found.',
      };
    }
    const reply: ReviewComment = {
      id: randomUUID(),
      author: 'agent',
      body: request.body,
      createdAt: new Date().toISOString(),
      staged: false,
    };
    const nextDocument: FileAnnotationDocument = {
      ...document,
      commentThreads: document.commentThreads.map((thread) =>
        thread.id === request.threadId
          ? {
              ...thread,
              status: request.resolve ? 'resolved' : thread.status,
              comments: [...thread.comments, reply],
            }
          : thread,
      ),
    };
    await writeState(
      request.projectId,
      request.worktreeId,
      replaceDocument(state, nextDocument),
    );
    return {
      ok: true,
      resolved: request.resolve,
      document: nextDocument,
    };
  });
}

export type ReadFileCommentThreadsResult =
  | { ok: false; error: string }
  | {
      ok: true;
      mode: 'single';
      filePath: string;
      thread: ReviewCommentThread;
    }
  | {
      ok: true;
      mode: 'all';
      threads: Array<{ filePath: string; thread: ReviewCommentThread }>;
    };

export async function readFileCommentThreads(request: {
  projectId: string;
  worktreeId: string;
  threadId?: string;
}): Promise<ReadFileCommentThreadsResult> {
  const state = await readState(request.projectId, request.worktreeId);
  const canExposeToAgent = (thread: ReviewCommentThread): boolean =>
    thread.anchor.annotationId === undefined || hasSubmittedUserComment(thread);
  if (request.threadId !== undefined) {
    for (const document of state.files) {
      const thread = document.commentThreads.find(
        (entry) => entry.id === request.threadId && canExposeToAgent(entry),
      );
      if (thread) {
        return {
          ok: true,
          mode: 'single',
          filePath: document.filePath,
          thread,
        };
      }
    }
    return { ok: false, error: 'File comment thread not found.' };
  }
  return {
    ok: true,
    mode: 'all',
    threads: state.files.flatMap((document) =>
      document.commentThreads
        .filter(
          (thread) => thread.status === 'open' && canExposeToAgent(thread),
        )
        .map((thread) => ({ filePath: document.filePath, thread })),
    ),
  };
}
