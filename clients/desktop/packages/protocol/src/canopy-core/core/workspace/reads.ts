import { z } from 'zod';
import { hasHostAbsolutePath } from './host-paths';
import { CanopyWorkspaceScopeSchema } from '../../common';
import {
  CanopyErrorPayloadSchema,
  CanopyQueryRetryDirectiveSchema,
  CanopyJsonValueSchema,
} from '../../errors';

const id = z.string().min(1).max(512);
const timestamp = z.iso.datetime({ offset: true });

export const CoreWorkspaceSchema = z
  .object({
    workspaceId: id,
    name: z.string().min(1),
    kind: z.enum(['git', 'cowork']),
    revision: z.number().int().nonnegative().optional(),
    createdAt: timestamp.optional(),
    updatedAt: timestamp.optional(),
    repositorySources: z.array(
      z
        .object({
          repoId: id,
          remoteUrl: z.string().min(1).max(4096),
          defaultBranch: id.optional(),
        })
        .catchall(CanopyJsonValueSchema),
    ),
    settings: z.object({}).catchall(CanopyJsonValueSchema),
  })
  .catchall(CanopyJsonValueSchema)
  .refine(
    (value) =>
      !Object.entries(value).some(
        ([key, field]) =>
          key !== 'workspaceId' && key !== 'name' && hasHostAbsolutePath(field),
      ),
    'Canonical results cannot contain host paths',
  );
export type CoreWorkspace = z.output<typeof CoreWorkspaceSchema>;

export const CoreWorkspaceListParamsSchema = z.strictObject({
  scope: CanopyWorkspaceScopeSchema.optional(),
  pageSize: z.number().int().min(1).max(500).default(100).optional(),
  cursor: z.string().min(1).max(2048).optional(),
});
export const CoreWorkspaceGetParamsSchema = z.strictObject({
  scope: CanopyWorkspaceScopeSchema.optional(),
  workspaceId: id,
});
export const CoreWorkspaceListResultSchema = z
  .object({
    items: z.array(CoreWorkspaceSchema).max(500),
    nextCursor: z.string().max(2048).nullable(),
  })
  .catchall(CanopyJsonValueSchema);
export const CoreWorkspaceGetResultSchema = CoreWorkspaceSchema;
export const CoreWorkspaceErrorSchema = CanopyErrorPayloadSchema.extend({
  code: z
    .enum([
      'core.workspace.invalidState',
      'core.workspace.revisionConflict',
      'core.workspace.notFound',
    ])
    .optional(),
  retry: CanopyQueryRetryDirectiveSchema,
});
