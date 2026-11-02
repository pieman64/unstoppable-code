import { z } from 'zod';
import { defineCanopyInstruction, defineCanopyQuery } from '../../definitions';
import {
  CanopyErrorPayloadSchema,
  CanopyQueryRetryDirectiveSchema,
} from '../../errors';
import { parseCreateSharedMultiRepoOrgProjectRequest } from '../../common';

const selection = z.strictObject({
  kind: z.enum(['workspace', 'project']),
  id: z.string().min(1).max(128),
});
export const PrepareSharedMultiRepoParamsSchema = z.strictObject({
  mode: z.enum(['combine', 'convert', 'add-repositories']),
  selections: z.array(selection).min(1).max(32),
});
export const CreateSharedMultiRepoParamsSchema =
  PrepareSharedMultiRepoParamsSchema.extend({
    request: z
      .strictObject({
        organizationId: z.uuid(),
        creationKey: z.string().min(1).max(128),
        name: z.string().min(1).max(256),
        privateMemory: z.boolean().optional(),
        sourceProjects: z
          .array(
            z.strictObject({
              projectId: z.uuid(),
              expectedRevision: z.number().int().positive(),
            }),
          )
          .min(1)
          .max(32),
      })
      .transform((value, ctx) => {
        const parsed = parseCreateSharedMultiRepoOrgProjectRequest(value);
        if (!parsed) {
          ctx.addIssue({
            code: 'custom',
            message: 'Invalid shared multi-repo request',
          });
          return z.NEVER;
        }
        return { ...parsed, sourceProjects: [...parsed.sourceProjects] };
      }),
  });
export const SharedMultiRepoCreateCommandSchema = z.union([
  CreateSharedMultiRepoParamsSchema,
  z.strictObject({ creationKey: z.string().min(1).max(128) }),
]);
export const SharedMultiRepoCreationStatusSchema = z.strictObject({
  creationKey: z.string().min(1).max(128),
  organizationId: z.uuid(),
  deviceId: z.uuid(),
  state: z.enum([
    'creating',
    'create-unconfirmed',
    'rejected',
    'created',
    'setting-up',
    'setup-failed',
    'setup-cancelled',
    'completion-pending',
    'ready',
    'retired',
    'access-blocked',
  ]),
  projectId: z.uuid().optional(),
  errorCode: z.string().max(64).optional(),
  updatedAt: z.iso.datetime(),
});
const prepared = z.strictObject({
  organizationId: z.uuid(),
  sourceProjects: z
    .array(
      z.strictObject({
        projectId: z.uuid(),
        expectedRevision: z.number().int().positive(),
      }),
    )
    .min(1)
    .max(32),
  repositories: z
    .array(
      z.strictObject({
        provider: z.literal('github'),
        host: z.string(),
        owner: z.string(),
        name: z.string(),
        providerRepoId: z.string().nullable(),
        defaultBranch: z.string().nullable(),
        verification: z.enum(['VERIFIED', 'STALE', 'UNVERIFIED']),
        description: z.string().nullable().optional(),
        visibility: z
          .enum(['PUBLIC', 'PRIVATE', 'INTERNAL'])
          .nullable()
          .optional(),
        updatedAt: z.string().nullable().optional(),
      }),
    )
    .min(1)
    .max(32),
  lockedProjectIds: z.array(z.uuid()).max(32),
  suggestedName: z.string().min(1).max(256),
  canCreate: z.boolean(),
});
const error = CanopyErrorPayloadSchema.extend({
  code: z
    .enum([
      'core.workspace.sharedMultiRepo.invalidSelection',
      'core.workspace.sharedMultiRepo.conflict',
      'core.workspace.sharedMultiRepo.accessBlocked',
    ])
    .optional(),
  retry: CanopyQueryRetryDirectiveSchema,
});
export const CORE_SHARED_MULTI_REPO_QUERIES = {
  'core.workspace.sharedMultiRepo.prepare': defineCanopyQuery({
    plane: 'core',
    domain: 'workspace',
    version: 1,
    placement: 'core-only',
    idempotency: 'inherent',
    requiredGrants: ['core.workspace.read'],
    params: PrepareSharedMultiRepoParamsSchema,
    result: prepared,
    error,
  }),
  'core.workspace.sharedMultiRepo.getCreation': defineCanopyQuery({
    plane: 'core',
    domain: 'workspace',
    version: 1,
    placement: 'core-only',
    idempotency: 'inherent',
    requiredGrants: ['core.workspace.read'],
    params: z.strictObject({ creationKey: z.string().min(1).max(128) }),
    result: SharedMultiRepoCreationStatusSchema.nullable(),
    error,
  }),
  'core.workspace.sharedMultiRepo.listCreations': defineCanopyQuery({
    plane: 'core',
    domain: 'workspace',
    version: 1,
    placement: 'core-only',
    idempotency: 'inherent',
    requiredGrants: ['core.workspace.read'],
    params: z.strictObject({
      limit: z.number().int().min(1).max(100).optional(),
    }),
    result: z.array(SharedMultiRepoCreationStatusSchema),
    error,
  }),
};
export const CORE_SHARED_MULTI_REPO_INSTRUCTIONS = {
  'core.workspace.sharedMultiRepo.create': defineCanopyInstruction({
    plane: 'core',
    domain: 'workspace',
    version: 1,
    placement: 'core-only',
    idempotency: 'inherent',
    requiredGrants: ['core.workspace.write'],
    params: SharedMultiRepoCreateCommandSchema,
    result: SharedMultiRepoCreationStatusSchema,
    error,
  }),
};
