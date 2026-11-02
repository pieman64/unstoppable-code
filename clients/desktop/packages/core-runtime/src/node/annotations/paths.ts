import { createHash } from 'node:crypto';
import * as nodePath from 'node:path';
import {
  ANNOTATION_ERROR_CODES,
  AnnotationFileRefSchema,
  isHostAbsolutePath,
  type AnnotationCommentThread,
  type AnnotationEntityPath,
  type AnnotationFileRef,
  type AnnotationScope,
  type CanonicalFileAnnotationDocument,
  type FileAnnotation,
  type StoredAnnotationCommentThread,
  type StoredFileAnnotation,
} from '@canopy/protocol/canopy-core';
import { CanopyOperationError } from '../../runtime/errors';
import type { StoredFileAnnotationDocument } from './document';
import type { StoredFileAnnotationThreadEntry } from './engine';

/*
 * Host-side projection between host file paths and the portable file
 * references of `core.annotation.*`. A file inside one of the scope's roots
 * becomes its root ID and root-relative path; any other host path becomes an
 * opaque handle that only this process resolves, for files outside every
 * root. A projection is exact: resolving it returns the original string.
 */

/** A file root of the scope with its trusted host path. */
export interface AnnotationFileRoot {
  id: string;
  absolutePath: string;
}

type PathModule = Pick<
  typeof nodePath,
  'isAbsolute' | 'join' | 'normalize' | 'relative' | 'sep'
>;

interface HostHandle {
  scopeKey: string;
  hostPath: string;
}

// Handles stay valid for the life of the process that issued them.
const hostHandles = new Map<string, HostHandle>();

function scopeKey(scope: AnnotationScope): string {
  return JSON.stringify([scope.projectId, scope.worktreeId]);
}

function hostHandle(key: string, hostPath: string): string {
  const digest = createHash('sha256')
    .update(`${key}\0${hostPath}`)
    .digest('hex');
  return `h-${digest.slice(0, 32)}`;
}

function fileNotInScope(): CanopyOperationError {
  return new CanopyOperationError({
    kind: 'not_found',
    code: ANNOTATION_ERROR_CODES.NOT_FOUND,
    message: 'The annotated file is not available in this scope.',
    details: { reason: 'NOT_FOUND' },
    retry: { kind: 'never' },
  });
}

export interface AnnotationPathProjection {
  /** The portable identity of a document's (normalized) host path. */
  fileRef(hostPath: string): AnnotationFileRef;
  /** A path recorded in an entity; text that is no host path stays as is. */
  entityPath(recorded: string): AnnotationEntityPath;
  /** The host path of a reference this scope issued or contains. */
  resolveFile(ref: AnnotationFileRef): string;
  resolveEntityPath(value: AnnotationEntityPath): string;
}

export function createAnnotationPathProjection(
  scope: AnnotationScope,
  roots: readonly AnnotationFileRoot[],
  paths: PathModule = nodePath,
): AnnotationPathProjection {
  const key = scopeKey(scope);
  const usable = roots
    .filter(
      (root) =>
        root.id.length > 0 &&
        root.id.length <= 512 &&
        paths.isAbsolute(root.absolutePath),
    )
    // The most specific root wins, as for nested repositories.
    .sort(
      (left, right) => right.absolutePath.length - left.absolutePath.length,
    );
  const byId = new Map<string, AnnotationFileRoot>();
  for (const root of [...usable].reverse()) byId.set(root.id, root);

  const resolveRootPath = (rootId: string, path: string): string | null => {
    const root = byId.get(rootId);
    if (!root) return null;
    const resolved = paths.join(root.absolutePath, ...path.split('/'));
    const relative = paths.relative(root.absolutePath, resolved);
    if (
      relative === '' ||
      relative === '..' ||
      relative.startsWith(`..${paths.sep}`) ||
      paths.isAbsolute(relative)
    ) {
      return null;
    }
    return resolved;
  };

  const rootRef = (hostPath: string): AnnotationFileRef | null => {
    if (!paths.isAbsolute(hostPath)) return null;
    for (const root of usable) {
      const relative = paths.relative(root.absolutePath, hostPath);
      if (
        relative === '' ||
        relative === '..' ||
        relative.startsWith(`..${paths.sep}`) ||
        paths.isAbsolute(relative)
      ) {
        continue;
      }
      const candidate = AnnotationFileRefSchema.safeParse({
        kind: 'root',
        rootId: root.id,
        path: relative.split(paths.sep).join('/'),
      });
      if (
        candidate.success &&
        candidate.data.kind === 'root' &&
        resolveRootPath(candidate.data.rootId, candidate.data.path) === hostPath
      ) {
        return candidate.data;
      }
    }
    return null;
  };

  const fileRef = (hostPath: string): AnnotationFileRef => {
    const ref = rootRef(hostPath);
    if (ref) return ref;
    const handle = hostHandle(key, hostPath);
    hostHandles.set(handle, { scopeKey: key, hostPath });
    return { kind: 'host', handle };
  };

  const resolveFile = (ref: AnnotationFileRef): string => {
    if (ref.kind === 'root') {
      const resolved = resolveRootPath(ref.rootId, ref.path);
      if (resolved === null) throw fileNotInScope();
      return resolved;
    }
    const entry = hostHandles.get(ref.handle);
    if (!entry || entry.scopeKey !== key) throw fileNotInScope();
    return entry.hostPath;
  };

  return {
    fileRef,
    entityPath: (recorded) =>
      isHostAbsolutePath(recorded) ? fileRef(recorded) : recorded,
    resolveFile,
    resolveEntityPath: (value) =>
      typeof value === 'string' ? value : resolveFile(value),
  };
}

/** Projects every host path an annotation records. */
export function toPortableAnnotation(
  annotation: StoredFileAnnotation,
  projection: AnnotationPathProjection,
): FileAnnotation {
  return {
    ...annotation,
    filePath: projection.entityPath(annotation.filePath),
  };
}

export function toPortableThread(
  thread: StoredAnnotationCommentThread,
  projection: AnnotationPathProjection,
): AnnotationCommentThread {
  const { filePath, ...anchor } = thread.anchor;
  return {
    ...thread,
    anchor:
      typeof filePath === 'string'
        ? { ...anchor, filePath: projection.entityPath(filePath) }
        : thread.anchor,
  };
}

export function toStoredAnnotation(
  annotation: FileAnnotation,
  projection: AnnotationPathProjection,
): StoredFileAnnotation {
  return {
    ...annotation,
    filePath: projection.resolveEntityPath(annotation.filePath),
  };
}

export function toStoredThread(
  thread: AnnotationCommentThread,
  projection: AnnotationPathProjection,
): StoredAnnotationCommentThread {
  const { filePath, ...anchor } = thread.anchor;
  return {
    ...thread,
    anchor:
      filePath === undefined
        ? anchor
        : { ...anchor, filePath: projection.resolveEntityPath(filePath) },
  };
}

export function toPortableDocument(
  document: StoredFileAnnotationDocument,
  projection: AnnotationPathProjection,
): CanonicalFileAnnotationDocument {
  return {
    file: projection.fileRef(document.filePath),
    revision: document.revision,
    annotations: document.annotations.map((annotation) =>
      toPortableAnnotation(annotation, projection),
    ),
    commentThreads: document.commentThreads.map((thread) =>
      toPortableThread(thread, projection),
    ),
  };
}

export function toPortableThreadEntry(
  entry: StoredFileAnnotationThreadEntry,
  projection: AnnotationPathProjection,
): {
  file: AnnotationFileRef;
  revision: number;
  thread: AnnotationCommentThread;
} {
  return {
    file: projection.fileRef(entry.filePath),
    revision: entry.revision,
    thread: toPortableThread(entry.thread, projection),
  };
}
