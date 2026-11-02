import { z } from 'zod';

import { isHostAbsolutePath } from '../workspace/host-paths';

/*
 * File annotations and comment threads (CAN-4104). The entity shapes mirror
 * the desktop store's v1 state file. Stored entities keep fields this version
 * does not know (`looseObject`), as the store always has; operation params and
 * results are otherwise closed.
 *
 * No host path crosses this contract. The trusted host projects a file inside
 * one of the scope's file roots to its root ID and root-relative path, and any
 * other file to an opaque handle that only that host resolves.
 */

const id = z.string().min(1).max(512);
const revision = z.number().int().min(0);
const positiveLine = z.number().int().min(1);

/**
 * Scope IDs name the host's storage directories, so they are slugs: no path
 * separators, dots or percent-encoding can reach a path or alias another scope.
 */
const scopeId = id.regex(/^[a-z0-9][a-z0-9-]*$/);

export const AnnotationScopeSchema = z.strictObject({
  projectId: scopeId,
  worktreeId: scopeId,
});

function isRootRelativePath(value: string): boolean {
  return (
    !isHostAbsolutePath(value) &&
    value
      .split('/')
      .every((segment) => segment !== '' && segment !== '.' && segment !== '..')
  );
}

export const ANNOTATION_FILE_HANDLE_PATTERN = /^h-[0-9a-f]{32}$/;

export const AnnotationFileRefSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('root'),
    rootId: id,
    /** POSIX path below the root, without `.` or `..` segments. */
    path: z
      .string()
      .min(1)
      .max(4_096)
      .refine(isRootRelativePath, 'Expected a root-relative path.'),
  }),
  z.strictObject({
    kind: z.literal('host'),
    /** Opaque; only the host that issued it resolves it. */
    handle: z.string().regex(ANNOTATION_FILE_HANDLE_PATTERN),
  }),
]);

/** A path recorded inside an entity: a file reference, or text that is no host path. */
export const AnnotationEntityPathSchema = z.union([
  AnnotationFileRefSchema,
  z
    .string()
    .refine((value) => !isHostAbsolutePath(value), 'Unexpected host path.'),
]);

export const AnnotationDiffIdentitySchema = z.looseObject({
  source: z.enum(['uncommitted', 'committed', 'combined', 'turn']),
  snapshotId: z.string().min(1),
  previousPath: z.string().optional(),
  startTree: z.string().optional(),
  endTree: z.string().optional(),
});

/**
 * `unanchored` anchors carry no lines; otherwise an end line needs a start
 * line, and a range never runs backwards.
 */
function hasValidThreadLines(anchor: {
  lineStart?: number;
  lineEnd?: number;
  unanchored?: boolean;
}): boolean {
  const { lineStart, lineEnd, unanchored } = anchor;
  if (unanchored === true)
    return lineStart === undefined && lineEnd === undefined;
  if (lineStart === undefined) return lineEnd === undefined;
  return (
    Number.isInteger(lineStart) &&
    lineStart >= 1 &&
    (lineEnd === undefined ||
      (Number.isInteger(lineEnd) && lineEnd >= lineStart))
  );
}

/** The anchor fields shared by stored entities and their portable form. */
const anchorShape = {
  source: z.enum(['code', 'diagram']),
  view: z.enum(['file', 'diff']).optional(),
  diff: AnnotationDiffIdentitySchema.optional(),
  diagramFingerprint: z.string().optional(),
  quote: z.string(),
  repoId: z.string().optional(),
  side: z.enum(['old', 'new']).optional(),
  lineStart: z.number().optional(),
  lineEnd: z.number().optional(),
  diagramKind: z.enum(['logicDiff', 'dataModelDiff']).optional(),
  nodeId: z.string().optional(),
  annotationId: z.string().optional(),
  unanchored: z.boolean().optional(),
};

function hasDiffIdentity(anchor: { view?: string; diff?: unknown }): boolean {
  return anchor.view !== 'diff' || anchor.diff !== undefined;
}

const DIFF_IDENTITY_MESSAGE = 'A diff anchor needs its comparison identity.';
const THREAD_LINES_MESSAGE = 'The anchor line range is invalid.';

export const AnnotationCommentSchema = z.looseObject({
  id: z.string(),
  author: z.enum(['user', 'agent']),
  body: z.string(),
  createdAt: z.string(),
  /** Renderer draft flag; a staged comment has not been sent to a chat. */
  staged: z.boolean().optional(),
});

const threadShape = {
  id: z.string(),
  status: z.enum(['open', 'resolved']),
  createdAt: z.string(),
  anchorState: z.enum(['matched', 'outdated']),
  comments: z.array(AnnotationCommentSchema),
};

const annotationShape = {
  id: z.string(),
  repoId: z.string(),
  side: z.enum(['old', 'new']),
  lineStart: positiveLine,
  lineEnd: positiveLine,
  kind: z.enum(['explanation', 'caution', 'context']),
  title: z.string(),
  body: z.string(),
};

function hasValidAnnotationLines(annotation: {
  lineStart: number;
  lineEnd: number;
}): boolean {
  return annotation.lineEnd >= annotation.lineStart;
}

const ANNOTATION_LINES_MESSAGE = 'The annotation line range is invalid.';

/* Entities as the host store keeps them, with host file paths. */

export const StoredAnnotationThreadAnchorSchema = z
  .looseObject({ ...anchorShape, filePath: z.string().optional() })
  .refine(hasDiffIdentity, DIFF_IDENTITY_MESSAGE)
  .refine(hasValidThreadLines, THREAD_LINES_MESSAGE);

export const StoredAnnotationCommentThreadSchema = z.looseObject({
  ...threadShape,
  anchor: StoredAnnotationThreadAnchorSchema,
});

export const StoredFileAnnotationSchema = z
  .looseObject({ ...annotationShape, filePath: z.string() })
  .refine(hasValidAnnotationLines, ANNOTATION_LINES_MESSAGE);

/* Entities on the wire, with every recorded path projected. */

export const AnnotationThreadAnchorSchema = z
  .looseObject({
    ...anchorShape,
    filePath: AnnotationEntityPathSchema.optional(),
  })
  .refine(hasDiffIdentity, DIFF_IDENTITY_MESSAGE)
  .refine(hasValidThreadLines, THREAD_LINES_MESSAGE);

export const AnnotationCommentThreadSchema = z.looseObject({
  ...threadShape,
  anchor: AnnotationThreadAnchorSchema,
});

export const FileAnnotationSchema = z
  .looseObject({ ...annotationShape, filePath: AnnotationEntityPathSchema })
  .refine(hasValidAnnotationLines, ANNOTATION_LINES_MESSAGE);

/** A file's document as a caller submits it; the store owns the revision. */
export const FileAnnotationDocumentInputSchema = z.strictObject({
  file: AnnotationFileRefSchema,
  annotations: z.array(FileAnnotationSchema),
  commentThreads: z.array(AnnotationCommentThreadSchema),
});

export const FileAnnotationDocumentSchema = z.strictObject({
  file: AnnotationFileRefSchema,
  /** Per-document revision: 0 before the first write, then +1 per write. */
  revision,
  annotations: z.array(FileAnnotationSchema),
  commentThreads: z.array(AnnotationCommentThreadSchema),
});

export const AnnotationDocumentGetParamsSchema = z.strictObject({
  scope: AnnotationScopeSchema,
  file: AnnotationFileRefSchema,
});

export const AnnotationDocumentResultSchema = z.strictObject({
  document: FileAnnotationDocumentSchema,
});

export const AnnotationDocumentSaveParamsSchema = z.strictObject({
  scope: AnnotationScopeSchema,
  document: FileAnnotationDocumentInputSchema,
  /** Thread ids the caller's edit started from; others are concurrent. */
  baseCommentThreadIds: z.array(z.string()),
  expectedRevision: revision.optional(),
});

export const AnnotationDocumentAppendParamsSchema = z.strictObject({
  scope: AnnotationScopeSchema,
  file: AnnotationFileRefSchema,
  annotations: z.array(FileAnnotationSchema),
  commentThreads: z.array(AnnotationCommentThreadSchema),
  expectedRevision: revision.optional(),
});

export const AnnotationDocumentDismissParamsSchema = z.strictObject({
  scope: AnnotationScopeSchema,
  file: AnnotationFileRefSchema,
  annotationId: id,
  expectedRevision: revision.optional(),
});

export const AnnotationThreadGetParamsSchema = z.strictObject({
  scope: AnnotationScopeSchema,
  threadId: id,
});

export const AnnotationThreadEntrySchema = z.strictObject({
  file: AnnotationFileRefSchema,
  revision,
  thread: AnnotationCommentThreadSchema,
});

export const AnnotationThreadGetResultSchema = AnnotationThreadEntrySchema;

export const AnnotationThreadListParamsSchema = z.strictObject({
  scope: AnnotationScopeSchema,
});

export const AnnotationThreadListResultSchema = z.strictObject({
  threads: z.array(AnnotationThreadEntrySchema),
});

export const AnnotationThreadReplyParamsSchema = z.strictObject({
  scope: AnnotationScopeSchema,
  threadId: id,
  body: z.string(),
  resolve: z.boolean(),
  expectedRevision: revision.optional(),
});

export const AnnotationThreadReplyResultSchema = z.strictObject({
  document: FileAnnotationDocumentSchema,
  resolved: z.boolean(),
});

export type AnnotationScope = z.output<typeof AnnotationScopeSchema>;
export type AnnotationFileRef = z.output<typeof AnnotationFileRefSchema>;
export type AnnotationEntityPath = z.output<typeof AnnotationEntityPathSchema>;
export type StoredFileAnnotation = z.output<typeof StoredFileAnnotationSchema>;
export type StoredAnnotationCommentThread = z.output<
  typeof StoredAnnotationCommentThreadSchema
>;
export type FileAnnotation = z.output<typeof FileAnnotationSchema>;
export type AnnotationComment = z.output<typeof AnnotationCommentSchema>;
export type AnnotationCommentThread = z.output<
  typeof AnnotationCommentThreadSchema
>;
export type FileAnnotationDocumentInput = z.output<
  typeof FileAnnotationDocumentInputSchema
>;
export type CanonicalFileAnnotationDocument = z.output<
  typeof FileAnnotationDocumentSchema
>;
export type AnnotationDocumentGetParams = z.output<
  typeof AnnotationDocumentGetParamsSchema
>;
export type AnnotationDocumentResult = z.output<
  typeof AnnotationDocumentResultSchema
>;
export type AnnotationDocumentSaveParams = z.output<
  typeof AnnotationDocumentSaveParamsSchema
>;
export type AnnotationDocumentAppendParams = z.output<
  typeof AnnotationDocumentAppendParamsSchema
>;
export type AnnotationDocumentDismissParams = z.output<
  typeof AnnotationDocumentDismissParamsSchema
>;
export type AnnotationThreadGetParams = z.output<
  typeof AnnotationThreadGetParamsSchema
>;
export type AnnotationThreadEntry = z.output<
  typeof AnnotationThreadEntrySchema
>;
export type AnnotationThreadListParams = z.output<
  typeof AnnotationThreadListParamsSchema
>;
export type AnnotationThreadListResult = z.output<
  typeof AnnotationThreadListResultSchema
>;
export type AnnotationThreadReplyParams = z.output<
  typeof AnnotationThreadReplyParamsSchema
>;
export type AnnotationThreadReplyResult = z.output<
  typeof AnnotationThreadReplyResultSchema
>;
