import { randomUUID } from 'node:crypto';
import { normalize } from 'node:path';
import {
  ANNOTATION_DOCUMENT_RESOURCE,
  ANNOTATION_ERROR_CODES,
  type AnnotationScope,
  type StoredAnnotationCommentThread,
} from '@canopy/protocol/canopy-core';
import { CanopyOperationError } from '../../runtime/errors';
import {
  emptyFileAnnotationDocument,
  normalizeFileAnnotationDocument,
  parseFileAnnotationsState,
  serializeFileAnnotationsState,
  validAnnotationCommentThreads,
  validFileAnnotations,
  type FileAnnotationsStateV1,
  type StoredFileAnnotationDocument,
} from './document';
import {
  readAnnotationStateText,
  withAnnotationStateLock,
  writeAnnotationStateText,
} from './state-file';

/*
 * The file-annotations engine: reads, merges and writes one worktree's v1
 * state file in host-path space. Every write runs under the state file's lock
 * and advances the written document's revision; a supplied expected revision
 * is a compare-and-swap precondition checked under that lock.
 */

export interface FileAnnotationEngineOptions {
  /** The scope's state file, resolved by the host's canonical path helper. */
  statePath(this: void, scope: AnnotationScope): string;
  now?(this: void): Date;
  randomId?(this: void): string;
}

export interface StoredFileAnnotationThreadEntry {
  filePath: string;
  revision: number;
  thread: StoredAnnotationCommentThread;
}

export interface FileAnnotationSaveInput {
  scope: AnnotationScope;
  document: unknown;
  baseCommentThreadIds: readonly string[];
  expectedRevision?: number;
}

export interface FileAnnotationAppendInput {
  scope: AnnotationScope;
  filePath: unknown;
  annotations: unknown;
  commentThreads: unknown;
  expectedRevision?: number;
}

export interface FileAnnotationDismissInput {
  scope: AnnotationScope;
  filePath: string;
  annotationId: string;
  expectedRevision?: number;
}

export interface FileAnnotationReplyInput {
  scope: AnnotationScope;
  threadId: string;
  body: string;
  resolve: boolean;
  expectedRevision?: number;
}

export interface FileAnnotationEngine {
  readDocument(
    scope: AnnotationScope,
    filePath: string,
  ): Promise<StoredFileAnnotationDocument>;
  saveDocument(
    input: FileAnnotationSaveInput,
  ): Promise<StoredFileAnnotationDocument>;
  appendAnnotations(
    input: FileAnnotationAppendInput,
  ): Promise<StoredFileAnnotationDocument>;
  dismissAnnotation(
    input: FileAnnotationDismissInput,
  ): Promise<StoredFileAnnotationDocument>;
  replyToThread(
    input: FileAnnotationReplyInput,
  ): Promise<{ document: StoredFileAnnotationDocument; resolved: boolean }>;
  /** A thread the agent may read: a plain comment, or one with feedback. */
  readThread(
    scope: AnnotationScope,
    threadId: string,
  ): Promise<StoredFileAnnotationThreadEntry>;
  /** Every open thread the agent may read, in state order. */
  listOpenThreads(
    scope: AnnotationScope,
  ): Promise<StoredFileAnnotationThreadEntry[]>;
}

export const FILE_COMMENT_THREAD_NOT_FOUND = 'File comment thread not found.';

export function fileAnnotationNotFoundError(): CanopyOperationError {
  return new CanopyOperationError({
    kind: 'not_found',
    code: ANNOTATION_ERROR_CODES.NOT_FOUND,
    message: FILE_COMMENT_THREAD_NOT_FOUND,
    details: { reason: 'NOT_FOUND' },
    retry: { kind: 'never' },
  });
}

function revisionConflictError(currentRevision: number): CanopyOperationError {
  return new CanopyOperationError({
    kind: 'conflict',
    code: ANNOTATION_ERROR_CODES.REVISION_CONFLICT,
    message: 'The file annotations changed. Refresh them and try again.',
    details: { reason: 'REVISION_CONFLICT', currentRevision },
    retry: { kind: 'after_refresh', resource: ANNOTATION_DOCUMENT_RESOURCE },
  });
}

function assertExpectedRevision(
  stored: StoredFileAnnotationDocument | undefined,
  expectedRevision: number | undefined,
): void {
  const current = stored?.revision ?? 0;
  if (expectedRevision !== undefined && expectedRevision !== current) {
    throw revisionConflictError(current);
  }
}

function findDocument(
  state: FileAnnotationsStateV1,
  filePath: string,
): StoredFileAnnotationDocument | undefined {
  const target = normalize(filePath);
  return state.files.find((entry) => entry.filePath === target);
}

function replaceDocument(
  state: FileAnnotationsStateV1,
  document: StoredFileAnnotationDocument,
): FileAnnotationsStateV1 {
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

/**
 * Applies a renderer save over the stored threads. Agent comments the save
 * does not carry are kept (and keep a resolution they caused), and threads
 * that were not in the caller's base are concurrent additions it never saw.
 */
function mergeThreads(
  stored: readonly StoredAnnotationCommentThread[],
  incoming: readonly StoredAnnotationCommentThread[],
  baseCommentThreadIds: readonly string[],
): StoredAnnotationCommentThread[] {
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

function hasSubmittedUserComment(
  thread: StoredAnnotationCommentThread,
): boolean {
  return thread.comments.some(
    (comment) => comment.author === 'user' && comment.staged !== true,
  );
}

function canExposeToAgent(thread: StoredAnnotationCommentThread): boolean {
  return (
    thread.anchor.annotationId === undefined || hasSubmittedUserComment(thread)
  );
}

export function createFileAnnotationEngine(
  options: FileAnnotationEngineOptions,
): FileAnnotationEngine {
  const now = options.now ?? ((): Date => new Date());
  const randomId = options.randomId ?? ((): string => randomUUID());

  const readState = async (
    scope: AnnotationScope,
  ): Promise<FileAnnotationsStateV1> =>
    parseFileAnnotationsState(
      await readAnnotationStateText(options.statePath(scope)),
    );

  /** Runs one read-modify-write under the state file's lock. */
  const mutate = <Result>(
    scope: AnnotationScope,
    change: (state: FileAnnotationsStateV1) => {
      document: StoredFileAnnotationDocument;
      result: Result;
    },
  ): Promise<Result> => {
    const statePath = options.statePath(scope);
    return withAnnotationStateLock(statePath, async () => {
      const state = parseFileAnnotationsState(
        await readAnnotationStateText(statePath),
      );
      const { document, result } = change(state);
      await writeAnnotationStateText(
        statePath,
        serializeFileAnnotationsState(replaceDocument(state, document)),
      );
      return result;
    });
  };

  return {
    async readDocument(scope, filePath): Promise<StoredFileAnnotationDocument> {
      const state = await readState(scope);
      return (
        findDocument(state, filePath) ?? emptyFileAnnotationDocument(filePath)
      );
    },

    saveDocument(input): Promise<StoredFileAnnotationDocument> {
      return mutate(input.scope, (state) => {
        const incoming = normalizeFileAnnotationDocument(input.document);
        if (!incoming) {
          throw new Error('Invalid file annotation document.');
        }
        const stored = findDocument(state, incoming.filePath);
        // A save without an expected revision (only pre-CAN-4104 remote
        // controllers send one) merges as before and can still undo another
        // caller's change. Revisit at the next REMOTE_PROTOCOL_VERSION bump or
        // a minimum-controller-version gate.
        assertExpectedRevision(stored, input.expectedRevision);
        const annotationById = new Map(
          (stored?.annotations ?? []).map((annotation) => [
            annotation.id,
            annotation,
          ]),
        );
        for (const annotation of incoming.annotations) {
          annotationById.set(annotation.id, annotation);
        }
        const document: StoredFileAnnotationDocument = {
          filePath: incoming.filePath,
          revision: (stored?.revision ?? 0) + 1,
          annotations: Array.from(annotationById.values()),
          commentThreads: mergeThreads(
            stored?.commentThreads ?? [],
            incoming.commentThreads,
            input.baseCommentThreadIds,
          ),
        };
        return { document, result: document };
      });
    },

    appendAnnotations(input): Promise<StoredFileAnnotationDocument> {
      return mutate(input.scope, (state) => {
        if (typeof input.filePath !== 'string') {
          throw new Error('Invalid file annotation append request.');
        }
        const filePath = normalize(input.filePath);
        const stored =
          findDocument(state, filePath) ??
          emptyFileAnnotationDocument(filePath);
        assertExpectedRevision(stored, input.expectedRevision);
        const annotationIds = new Set(
          stored.annotations.map((annotation) => annotation.id),
        );
        const threadIds = new Set(
          stored.commentThreads.map((thread) => thread.id),
        );
        const document: StoredFileAnnotationDocument = {
          ...stored,
          revision: stored.revision + 1,
          annotations: [
            ...stored.annotations,
            ...validFileAnnotations(input.annotations).filter(
              (annotation) => !annotationIds.has(annotation.id),
            ),
          ],
          commentThreads: [
            ...stored.commentThreads,
            ...validAnnotationCommentThreads(input.commentThreads).filter(
              (thread) => !threadIds.has(thread.id),
            ),
          ],
        };
        return { document, result: document };
      });
    },

    dismissAnnotation(input): Promise<StoredFileAnnotationDocument> {
      return mutate(input.scope, (state) => {
        const stored =
          findDocument(state, input.filePath) ??
          emptyFileAnnotationDocument(input.filePath);
        assertExpectedRevision(stored, input.expectedRevision);
        const document: StoredFileAnnotationDocument = {
          ...stored,
          revision: stored.revision + 1,
          annotations: stored.annotations.filter(
            (annotation) => annotation.id !== input.annotationId,
          ),
          // Clearing an agent highlight must not discard its discussion.
          // Detach any existing thread from the removed annotation so it
          // becomes a regular line-anchored file comment.
          commentThreads: stored.commentThreads.map((thread) =>
            thread.anchor.annotationId === input.annotationId
              ? {
                  ...thread,
                  anchor: { ...thread.anchor, annotationId: undefined },
                }
              : thread,
          ),
        };
        return { document, result: document };
      });
    },

    replyToThread(
      input,
    ): Promise<{ document: StoredFileAnnotationDocument; resolved: boolean }> {
      return mutate(input.scope, (state) => {
        const stored = state.files.find((entry) =>
          entry.commentThreads.some(
            (thread) =>
              thread.id === input.threadId && hasSubmittedUserComment(thread),
          ),
        );
        if (!stored) throw fileAnnotationNotFoundError();
        assertExpectedRevision(stored, input.expectedRevision);
        const reply = {
          id: randomId(),
          author: 'agent' as const,
          body: input.body,
          createdAt: now().toISOString(),
          staged: false,
        };
        const document: StoredFileAnnotationDocument = {
          ...stored,
          revision: stored.revision + 1,
          commentThreads: stored.commentThreads.map((thread) =>
            thread.id === input.threadId
              ? {
                  ...thread,
                  status: input.resolve ? 'resolved' : thread.status,
                  comments: [...thread.comments, reply],
                }
              : thread,
          ),
        };
        return { document, result: { document, resolved: input.resolve } };
      });
    },

    async readThread(
      scope,
      threadId,
    ): Promise<StoredFileAnnotationThreadEntry> {
      const state = await readState(scope);
      for (const document of state.files) {
        const thread = document.commentThreads.find(
          (entry) => entry.id === threadId && canExposeToAgent(entry),
        );
        if (thread) {
          return {
            filePath: document.filePath,
            revision: document.revision,
            thread,
          };
        }
      }
      throw fileAnnotationNotFoundError();
    },

    async listOpenThreads(scope): Promise<StoredFileAnnotationThreadEntry[]> {
      const state = await readState(scope);
      return state.files.flatMap((document) =>
        document.commentThreads
          .filter(
            (thread) => thread.status === 'open' && canExposeToAgent(thread),
          )
          .map((thread) => ({
            filePath: document.filePath,
            revision: document.revision,
            thread,
          })),
      );
    },
  };
}
