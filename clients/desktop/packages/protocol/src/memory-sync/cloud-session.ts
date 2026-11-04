import { z } from 'zod';
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

const CLOUD_SESSION_FILE_PATTERN =
  /^(?:user|project)\/(?:MEMORY\.md|topics\/[A-Za-z0-9][A-Za-z0-9._-]*\.md)$/;

export const MemoryCloudSessionPayloadSchema = z.strictObject({
  schemaVersion: z.literal(1),
  renderedAt: MemoryTimestampSchema,
  renderedBlock: z
    .string()
    .refine(
      (value: string): boolean =>
        new TextEncoder().encode(value).length <= MEMORY_RECALL_BLOCK_MAX_BYTES,
      'The recall block exceeds its budget',
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
    .array(
      z.strictObject({
        path: z.string().regex(CLOUD_SESSION_FILE_PATTERN),
        sha256: MemorySha256Schema,
        size: z.int().min(0),
      }),
    )
    .max(1_002),
});
export type MemoryCloudSessionPayload = z.output<
  typeof MemoryCloudSessionPayloadSchema
>;
