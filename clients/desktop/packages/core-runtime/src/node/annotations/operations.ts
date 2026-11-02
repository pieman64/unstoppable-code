import {
  ANNOTATION_ERROR_CODES,
  type AnnotationDocumentAppendParams,
  type AnnotationDocumentDismissParams,
  type AnnotationDocumentGetParams,
  type AnnotationDocumentResult,
  type AnnotationDocumentSaveParams,
  type AnnotationScope,
  type AnnotationThreadEntry,
  type AnnotationThreadGetParams,
  type AnnotationThreadListParams,
  type AnnotationThreadListResult,
  type AnnotationThreadReplyParams,
  type AnnotationThreadReplyResult,
} from '@canopy/protocol/canopy-core';
import { CanopyOperationError } from '../../runtime/errors';
import type { FileAnnotationEngine } from './engine';
import {
  createAnnotationPathProjection,
  toPortableDocument,
  toPortableThreadEntry,
  toStoredAnnotation,
  toStoredThread,
  type AnnotationFileRoot,
  type AnnotationPathProjection,
} from './paths';

/*
 * The `core.annotation.*` operations over the engine. Params arrive validated
 * by the dispatcher; file references resolve to host paths only inside this
 * module, and results leave it projected again.
 */

export interface AnnotationOperationsHost {
  readonly engine: FileAnnotationEngine;
  /** The scope's file roots with their host paths, from trusted host records. */
  roots(
    this: void,
    scope: AnnotationScope,
  ): Promise<readonly AnnotationFileRoot[]>;
  /**
   * Whether the host lets this scope's annotations change. Checked by every
   * write, whichever binding (IPC projection, renderer relay, agent tool)
   * dispatched it.
   */
  isWritable(this: void, scope: AnnotationScope): boolean;
}

function readOnlyScopeError(): CanopyOperationError {
  return new CanopyOperationError({
    kind: 'permission_denied',
    code: ANNOTATION_ERROR_CODES.READ_ONLY_SCOPE,
    message: 'This scope is read-only.',
    details: { reason: 'READ_ONLY_SCOPE' },
    retry: { kind: 'never' },
  });
}

export interface AnnotationOperations {
  getDocument(
    params: AnnotationDocumentGetParams,
  ): Promise<AnnotationDocumentResult>;
  saveDocument(
    params: AnnotationDocumentSaveParams,
  ): Promise<AnnotationDocumentResult>;
  appendAnnotations(
    params: AnnotationDocumentAppendParams,
  ): Promise<AnnotationDocumentResult>;
  dismissAnnotation(
    params: AnnotationDocumentDismissParams,
  ): Promise<AnnotationDocumentResult>;
  getThread(params: AnnotationThreadGetParams): Promise<AnnotationThreadEntry>;
  listThreads(
    params: AnnotationThreadListParams,
  ): Promise<AnnotationThreadListResult>;
  replyToThread(
    params: AnnotationThreadReplyParams,
  ): Promise<AnnotationThreadReplyResult>;
}

export function createAnnotationOperations(
  host: AnnotationOperationsHost,
): AnnotationOperations {
  const projectionFor = async (
    scope: AnnotationScope,
  ): Promise<AnnotationPathProjection> =>
    createAnnotationPathProjection(scope, await host.roots(scope));
  const { engine } = host;
  /** The projection for a write, once the host allows the scope to change. */
  const writableProjectionFor = (
    scope: AnnotationScope,
  ): Promise<AnnotationPathProjection> => {
    if (!host.isWritable(scope)) return Promise.reject(readOnlyScopeError());
    return projectionFor(scope);
  };

  return {
    async getDocument(params): Promise<AnnotationDocumentResult> {
      const projection = await projectionFor(params.scope);
      const document = await engine.readDocument(
        params.scope,
        projection.resolveFile(params.file),
      );
      return { document: toPortableDocument(document, projection) };
    },

    async saveDocument(params): Promise<AnnotationDocumentResult> {
      const projection = await writableProjectionFor(params.scope);
      const document = await engine.saveDocument({
        scope: params.scope,
        document: {
          filePath: projection.resolveFile(params.document.file),
          annotations: params.document.annotations.map((annotation) =>
            toStoredAnnotation(annotation, projection),
          ),
          commentThreads: params.document.commentThreads.map((thread) =>
            toStoredThread(thread, projection),
          ),
        },
        baseCommentThreadIds: params.baseCommentThreadIds,
        expectedRevision: params.expectedRevision,
      });
      return { document: toPortableDocument(document, projection) };
    },

    async appendAnnotations(params): Promise<AnnotationDocumentResult> {
      const projection = await writableProjectionFor(params.scope);
      const document = await engine.appendAnnotations({
        scope: params.scope,
        filePath: projection.resolveFile(params.file),
        annotations: params.annotations.map((annotation) =>
          toStoredAnnotation(annotation, projection),
        ),
        commentThreads: params.commentThreads.map((thread) =>
          toStoredThread(thread, projection),
        ),
        expectedRevision: params.expectedRevision,
      });
      return { document: toPortableDocument(document, projection) };
    },

    async dismissAnnotation(params): Promise<AnnotationDocumentResult> {
      const projection = await writableProjectionFor(params.scope);
      const document = await engine.dismissAnnotation({
        scope: params.scope,
        filePath: projection.resolveFile(params.file),
        annotationId: params.annotationId,
        expectedRevision: params.expectedRevision,
      });
      return { document: toPortableDocument(document, projection) };
    },

    async getThread(params): Promise<AnnotationThreadEntry> {
      const [projection, entry] = await Promise.all([
        projectionFor(params.scope),
        engine.readThread(params.scope, params.threadId),
      ]);
      return toPortableThreadEntry(entry, projection);
    },

    async listThreads(params): Promise<AnnotationThreadListResult> {
      const [projection, entries] = await Promise.all([
        projectionFor(params.scope),
        engine.listOpenThreads(params.scope),
      ]);
      return {
        threads: entries.map((entry) =>
          toPortableThreadEntry(entry, projection),
        ),
      };
    },

    async replyToThread(params): Promise<AnnotationThreadReplyResult> {
      const projection = await writableProjectionFor(params.scope);
      const { document, resolved } = await engine.replyToThread({
        scope: params.scope,
        threadId: params.threadId,
        body: params.body,
        resolve: params.resolve,
        expectedRevision: params.expectedRevision,
      });
      return { document: toPortableDocument(document, projection), resolved };
    },
  };
}
