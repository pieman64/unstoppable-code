import { z } from 'zod';
import { hasHostAbsolutePath } from '../workspace/host-paths';
import { CanopyWorkspaceScopeSchema } from '../../common';
import {
  CanopyErrorPayloadSchema,
  CanopyQueryRetryDirectiveSchema,
  CanopyJsonValueSchema,
} from '../../errors';

const id = z.string().min(1).max(512);
const timestamp = z.iso.datetime({ offset: true });

export const CoreWorktreeSchema = z
  .object({
    worktreeId: id,
    workspaceId: id,
    name: z.string().min(1),
    state: z.enum(['creating', 'ready', 'archived', 'deleting', 'error']),
    revision: z.number().int().nonnegative().optional(),
    baseBranch: id.nullable(),
    branch: id,
    targetId: z.string().nullable().optional(),
    createdAt: z.string(),
    updatedAt: timestamp.optional(),
  })
  .catchall(CanopyJsonValueSchema)
  .refine(
    (value) =>
      !Object.entries(value).some(
        ([key, field]) => key !== 'name' && hasHostAbsolutePath(field),
      ),
    'Canonical results cannot contain host paths',
  );
export type CoreWorktree = z.output<typeof CoreWorktreeSchema>;

export const CoreWorktreeListParamsSchema = z.strictObject({
  scope: CanopyWorkspaceScopeSchema.optional(),
  pageSize: z.number().int().min(1).max(500).default(100).optional(),
  cursor: z.string().min(1).max(2048).optional(),
});
export const CoreWorktreeGetParamsSchema = z.strictObject({
  scope: CanopyWorkspaceScopeSchema.optional(),
  worktreeId: id,
});
export const CoreWorktreeListResultSchema = z
  .object({
    items: z.array(CoreWorktreeSchema).max(500),
    nextCursor: z.string().max(2048).nullable(),
  })
  .catchall(CanopyJsonValueSchema);
export const CoreWorktreeGetResultSchema = CoreWorktreeSchema;
export const CoreWorktreeErrorSchema = CanopyErrorPayloadSchema.extend({
  code: z
    .enum([
      'core.worktree.invalidState',
      'core.worktree.revisionConflict',
      'core.worktree.notFound',
    ])
    .optional(),
  retry: CanopyQueryRetryDirectiveSchema,
});
