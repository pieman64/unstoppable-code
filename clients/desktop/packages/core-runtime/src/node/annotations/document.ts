import { normalize } from 'node:path';
import {
  StoredAnnotationCommentThreadSchema,
  StoredFileAnnotationSchema,
  type StoredAnnotationCommentThread,
  type StoredFileAnnotation,
} from '@canopy/protocol/canopy-core';

/*
 * The documents of the v1 file-annotations state file, as its host keeps
 * them: keyed by the normalized host file path. Validation keeps the original
 * objects, so fields this version does not know survive a rewrite.
 */

export interface StoredFileAnnotationDocument {
  filePath: string;
  revision: number;
  annotations: StoredFileAnnotation[];
  commentThreads: StoredAnnotationCommentThread[];
}

export interface FileAnnotationsStateV1 {
  version: 1;
  files: StoredFileAnnotationDocument[];
}

export function isStoredFileAnnotation(
  value: unknown,
): value is StoredFileAnnotation {
  return StoredFileAnnotationSchema.safeParse(value).success;
}

export function isStoredAnnotationCommentThread(
  value: unknown,
): value is StoredAnnotationCommentThread {
  return StoredAnnotationCommentThreadSchema.safeParse(value).success;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function storedRevision(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : 0;
}

export function emptyFileAnnotationDocument(
  filePath: string,
): StoredFileAnnotationDocument {
  return {
    filePath: normalize(filePath),
    revision: 0,
    annotations: [],
    commentThreads: [],
  };
}

/** Keeps the valid entries of a collection; anything else reads as empty. */
export function validFileAnnotations(value: unknown): StoredFileAnnotation[] {
  return Array.isArray(value) ? value.filter(isStoredFileAnnotation) : [];
}

export function validAnnotationCommentThreads(
  value: unknown,
): StoredAnnotationCommentThread[] {
  return Array.isArray(value)
    ? value.filter(isStoredAnnotationCommentThread)
    : [];
}

/** A stored or submitted document, or null without a string file path. */
export function normalizeFileAnnotationDocument(
  value: unknown,
): StoredFileAnnotationDocument | null {
  if (!isRecord(value) || typeof value.filePath !== 'string') return null;
  return {
    filePath: normalize(value.filePath),
    revision: storedRevision(value.revision),
    annotations: validFileAnnotations(value.annotations),
    commentThreads: validAnnotationCommentThreads(value.commentThreads),
  };
}

/** Parses state text; an unreadable or unknown-version state is empty. */
export function parseFileAnnotationsState(
  raw: string | null,
): FileAnnotationsStateV1 {
  if (raw === null) return { version: 1, files: [] };
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { version: 1, files: [] };
  }
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.files)) {
    return { version: 1, files: [] };
  }
  return {
    version: 1,
    files: value.files
      .map(normalizeFileAnnotationDocument)
      .filter((entry) => entry !== null),
  };
}

export function serializeFileAnnotationsState(
  state: FileAnnotationsStateV1,
): string {
  return JSON.stringify(state, null, 2);
}
