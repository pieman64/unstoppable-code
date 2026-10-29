import { z } from 'zod';

import { CanopyWorkspaceScopeSchema } from '../common';
import {
  CanopyErrorPayloadSchema,
  CanopyQueryRetryDirectiveSchema,
  CanopyJsonValueSchema,
  isBoundedCanopyJsonValue,
} from '../errors';

const BOUNDED_FILE_ROOT_ID_SCHEMA = z.string().min(1).max(512);
const CATALOG_REVISION_SCHEMA = z.string().min(1).max(128);

function stripLocalPathFields<Value extends Record<string, unknown>>(
  value: Value,
): Value {
  delete value.hostPath;
  delete value.absolutePath;
  return value;
}

export const WorkerFilesystemRootsListParamsSchema = z.strictObject({
  scope: CanopyWorkspaceScopeSchema,
  catalogRevision: CATALOG_REVISION_SCHEMA.optional(),
});

export type WorkerFilesystemRootsListParams = z.output<
  typeof WorkerFilesystemRootsListParamsSchema
>;

export const WorkerFilesystemRootSchema = z
  .object({
    fileRootId: BOUNDED_FILE_ROOT_ID_SCHEMA,
    name: z.string(),
    kind: z.enum(['git-repo', 'workspace-root', 'attachments', 'standalone']),
  })
  .catchall(CanopyJsonValueSchema)
  .refine(isBoundedCanopyJsonValue, 'Expected bounded JSON-safe data')
  .transform(stripLocalPathFields);

export const WorkerFilesystemRootsListResultSchema = z
  .object({
    roots: z.array(WorkerFilesystemRootSchema),
    catalogRevision: CATALOG_REVISION_SCHEMA.optional(),
  })
  .catchall(CanopyJsonValueSchema);

export type WorkerFilesystemRootsListResult = z.output<
  typeof WorkerFilesystemRootsListResultSchema
>;

export const WorkerFilesystemDirectoryListParamsSchema = z.strictObject({
  scope: CanopyWorkspaceScopeSchema,
  fileRootId: BOUNDED_FILE_ROOT_ID_SCHEMA,
  relativePath: z.string(),
  catalogRevision: CATALOG_REVISION_SCHEMA.optional(),
});

export type WorkerFilesystemDirectoryListParams = z.output<
  typeof WorkerFilesystemDirectoryListParamsSchema
>;

export const WorkerFilesystemDirectoryEntrySchema = z
  .object({
    name: z.string(),
    relativePath: z.string(),
    kind: z.enum(['file', 'directory']),
    isIgnored: z.boolean(),
    isIndexExcluded: z.boolean(),
    isSymlink: z.boolean(),
    hasChildren: z.boolean(),
  })
  .catchall(CanopyJsonValueSchema)
  .refine(isBoundedCanopyJsonValue, 'Expected bounded JSON-safe data')
  .transform(stripLocalPathFields);

export const WorkerFilesystemDirectoryListResultSchema = z
  .object({
    entries: z.array(WorkerFilesystemDirectoryEntrySchema),
    catalogRevision: CATALOG_REVISION_SCHEMA.optional(),
  })
  .catchall(CanopyJsonValueSchema);

export type WorkerFilesystemDirectoryListResult = z.output<
  typeof WorkerFilesystemDirectoryListResultSchema
>;

export const WorkerFilesystemRootsListErrorSchema =
  CanopyErrorPayloadSchema.extend({
    code: z
      .enum([
        'worker.filesystem.roots.invalidState',
        'worker.filesystem.roots.revisionConflict',
        'worker.filesystem.roots.notFound',
      ])
      .optional(),
    retry: CanopyQueryRetryDirectiveSchema,
  });

export const WorkerFilesystemDirectoryListErrorSchema =
  CanopyErrorPayloadSchema.extend({
    code: z
      .enum([
        'worker.filesystem.directory.invalidState',
        'worker.filesystem.directory.revisionConflict',
        'worker.filesystem.directory.notFound',
      ])
      .optional(),
    retry: CanopyQueryRetryDirectiveSchema,
  });
