import {
  createAnnotationPathProjection,
  toPortableAnnotation,
  toPortableThread,
  toStoredAnnotation,
  toStoredThread,
  validAnnotationCommentThreads,
  validFileAnnotations,
  type AnnotationPathProjection,
} from '@canopy/core-runtime/node/annotations';
import {
  ANNOTATION_GRANTS,
  type AnnotationFileRef,
  type AnnotationScope,
  type CanonicalFileAnnotationDocument,
  type CanopyCallerDescriptor,
  type FileAnnotation,
  type AnnotationCommentThread,
} from '@canopy/protocol/canopy-core';
import type { FileAnnotationDocument } from '@canopy/desktop-shared/types';
import { readAnnotationFileRoots } from './core-annotation-adapter';

/*
 * The trusted host side of `core.annotation.*` for desktop callers that speak
 * host file paths: the `file-annotations:*` IPC handlers and the agent comment
 * tools. Host paths are projected to portable file references before a call
 * reaches the dispatcher, and back to host paths for these callers.
 */

export function annotationCaller(
  caller: CanopyCallerDescriptor,
  access: 'read' | 'write',
): CanopyCallerDescriptor {
  return { ...caller, grants: [ANNOTATION_GRANTS[access]] };
}

export async function createHostAnnotationProjection(
  scope: AnnotationScope,
): Promise<AnnotationPathProjection> {
  return createAnnotationPathProjection(
    scope,
    await readAnnotationFileRoots(scope),
  );
}

/** The valid entries of submitted collections, with their paths projected. */
export function portableAnnotations(
  value: unknown,
  projection: AnnotationPathProjection,
): FileAnnotation[] {
  return validFileAnnotations(value).map((annotation) =>
    toPortableAnnotation(annotation, projection),
  );
}

export function portableCommentThreads(
  value: unknown,
  projection: AnnotationPathProjection,
): AnnotationCommentThread[] {
  return validAnnotationCommentThreads(value).map((thread) =>
    toPortableThread(thread, projection),
  );
}

export function hostFilePath(
  file: AnnotationFileRef,
  projection: AnnotationPathProjection,
): string {
  return projection.resolveFile(file);
}

export function toHostFileAnnotationDocument(
  document: CanonicalFileAnnotationDocument,
  projection: AnnotationPathProjection,
): FileAnnotationDocument {
  return {
    filePath: projection.resolveFile(document.file),
    revision: document.revision,
    annotations: document.annotations.map((annotation) =>
      toStoredAnnotation(annotation, projection),
    ),
    commentThreads: document.commentThreads.map((thread) =>
      toStoredThread(thread, projection),
    ),
  };
}
