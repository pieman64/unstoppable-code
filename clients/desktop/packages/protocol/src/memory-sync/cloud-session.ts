import { z } from 'zod';
import { MEMORY_SYNC_LIMITS } from './constants';
import { MemoryChangeCursorSchema } from './cursor';
import {
  MemoryProjectIdSchema,
  MemoryRevisionSchema,
  MemoryScopeIdSchema,
  MemorySha256Schema,
  MemoryTimestampSchema,
} from './identifiers';
import { MemoryScopeKindSchema } from './records';

export const MEMORY_CLOUD_SESSION_FILE_TREE_ROOT = '.canopy/memory';

export const MEMORY_RECALL_BLOCK_MAX_BYTES = 16 * 1024;

/**
 * Limits the Cloud and Agentic Core share for a session's memory files: one
 * file per document (`commitChangesMax` covers both scopes), each within the
 * document limit, and a bounded total.
 */
export const MEMORY_CLOUD_SESSION_LIMITS = {
  filesMax: MEMORY_SYNC_LIMITS.commitChangesMax,
  fileMaxBytes: MEMORY_SYNC_LIMITS.documentMaxBytes,
  totalMaxBytes: 128 * 1024 * 1024,
} as const;

const RECALL_BLOCK_PREFIX = '<local_memory>\n';
const RECALL_BLOCK_SUFFIX = '\n</local_memory>';

const CLOUD_SESSION_FILE_PATTERN =
  /^(?:user|project)\/(?:MEMORY\.md|topics\/[A-Za-z0-9][A-Za-z0-9._-]*\.md)$/;

function isRecallBlock(value: string): boolean {
  return (
    new TextEncoder().encode(value).length <= MEMORY_RECALL_BLOCK_MAX_BYTES &&
    (value === '' ||
      (value.startsWith(RECALL_BLOCK_PREFIX) &&
        value.endsWith(RECALL_BLOCK_SUFFIX)))
  );
}

const MemoryCloudSessionFileSchema = z.strictObject({
  path: z.string().regex(CLOUD_SESSION_FILE_PATTERN),
  sha256: MemorySha256Schema,
  size: z.int().min(0).max(MEMORY_CLOUD_SESSION_LIMITS.fileMaxBytes),
});
export type MemoryCloudSessionFile = z.output<
  typeof MemoryCloudSessionFileSchema
>;

/**
 * The memory handed to an Agentic Core session (contract section 24.1): the
 * `<local_memory>` block, rendered by the shared recall renderer, and the
 * scopes' documents as a content-addressed file list materialized under
 * `.canopy/memory/` through the capability bundle's file trees.
 */
export const MemoryCloudSessionPayloadSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    renderedAt: MemoryTimestampSchema,
    renderedBlock: z
      .string()
      .refine(
        isRecallBlock,
        'The recall block exceeds its budget or is not framed as <local_memory>',
      ),
    scopes: z
      .array(
        z.strictObject({
          scopeId: MemoryScopeIdSchema,
          kind: MemoryScopeKindSchema,
          projectId: MemoryProjectIdSchema.nullable(),
          revision: MemoryRevisionSchema,
          cursor: MemoryChangeCursorSchema,
        }),
      )
      .max(2),
    files: z
      .array(MemoryCloudSessionFileSchema)
      .max(MEMORY_CLOUD_SESSION_LIMITS.filesMax),
  })
  .superRefine((payload, context): void => {
    const paths = payload.files.map((file) => file.path.toLowerCase());
    if (new Set(paths).size !== paths.length) {
      context.addIssue({ code: 'custom', message: 'Each file appears once' });
    }
    const total = payload.files.reduce((sum, file) => sum + file.size, 0);
    if (total > MEMORY_CLOUD_SESSION_LIMITS.totalMaxBytes) {
      context.addIssue({
        code: 'custom',
        message: 'The memory files exceed their total size limit',
      });
    }
    const kinds = payload.scopes.map((scope) => scope.kind);
    if (new Set(kinds).size !== kinds.length) {
      context.addIssue({
        code: 'custom',
        message: 'A session carries at most one scope of each kind',
      });
    }
  });
export type MemoryCloudSessionPayload = z.output<
  typeof MemoryCloudSessionPayloadSchema
>;
