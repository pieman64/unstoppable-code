import { z } from 'zod';
import { CanopyRequestMetadataSchema } from '../../common';
import {
  defineCanopyInstruction,
  defineCanopyInstructionRegistry,
} from '../../definitions';
import {
  CanopyErrorPayloadSchema,
  CanopyJsonValueSchema,
  CanopyKeyedRetryDirectiveSchema,
  CanopyQueryRetryDirectiveSchema,
} from '../../errors';
import { OperationStatusSchema } from '../operation/schemas';
import { CoreWorkspaceSchema } from './reads';

const id = z.string().min(1).max(512);
const timestamp = z.iso.datetime({ offset: true });
const revision = z.number().int().nonnegative();
const keyedMeta = CanopyRequestMetadataSchema.extend({ idempotencyKey: id });

export const CoreWorkspaceUpdateParamsSchema = z.strictObject({
  workspaceId: id,
  expectedRevision: revision,
  patch: z
    .strictObject({
      name: z.string().min(1).max(256).regex(/\S/).optional(),
      color: z
        .string()
        .regex(/^#[0-9A-Fa-f]{6}$/)
        .optional(),
      pinned: z.boolean().optional(),
      collapsed: z.boolean().optional(),
      itemSortMode: z.enum(['manual', 'last-updated']).optional(),
      activitySectionOrder: z
        .array(
          z.enum([
            'plugins',
            'summary',
            'changed-files',
            'pull-request',
            'background-processes',
            'plans',
            'pipeline-runs',
            'cost',
            'scripts',
            'hooks',
            'terminals',
            'todo',
            'mcp-servers',
            'notes',
            'prompts',
            'attachments',
            'memory',
          ]),
        )
        .max(17)
        .meta({ uniqueItems: true })
        .optional(),
      alwaysShow: z.boolean().optional(),
      startPage: z
        .union([
          z.strictObject({
            kind: z.literal('file'),
            repoId: z
              .string()
              .regex(/^[A-Za-z0-9_-]+$/)
              .optional(),
            path: z.string().min(1).max(4096).regex(/\S/),
          }),
          z.strictObject({
            kind: z.literal('url'),
            // The catalog's unescaped pattern, enforced by the protocol check.
            url: z
              .url({ protocol: /^https?$/ })
              .max(4096)
              .meta({ pattern: '^https?://' }),
          }),
          z.strictObject({ kind: z.literal('inherit') }),
          z.null(),
        ])
        .optional(),
    })
    .refine((patch) => Object.keys(patch).length > 0, 'Patch is empty.')
    .meta({ minProperties: 1 }),
  _meta: keyedMeta,
});
export type CoreWorkspaceUpdateParams = z.output<
  typeof CoreWorkspaceUpdateParamsSchema
>;

// The `core.workspace.get` projection, typed workspace fields included
// (CAN-5373), with the update's bounded name and stamps always present.
export const CoreWorkspaceUpdateResultSchema = CoreWorkspaceSchema.safeExtend({
  name: z.string().min(1).max(256),
  revision,
  createdAt: timestamp,
  updatedAt: timestamp,
});
export type CoreWorkspaceUpdateResult = z.output<
  typeof CoreWorkspaceUpdateResultSchema
>;

const workspaceError = CanopyErrorPayloadSchema.extend({
  code: z
    .enum([
      'core.workspace.invalidState',
      'core.workspace.revisionConflict',
      'core.workspace.notFound',
    ])
    .optional(),
});

const workspaceKind = z.enum(['single_repo', 'multi_repo', 'cowork']);
const repositoryWorkspaceKind = z.enum(['single_repo', 'multi_repo']);
const nullableText = (max: number): z.ZodNullable<z.ZodString> =>
  z.string().max(max).nullable();

export const CoreWorkspaceCreateParamsSchema = z.strictObject({
  name: z.string().min(1).max(512),
  source: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('empty'), workspaceKind }),
    z.strictObject({
      kind: z.literal('local_repository'),
      rootGrantId: id,
      workspaceKind: repositoryWorkspaceKind,
    }),
    z.strictObject({
      kind: z.literal('remote_repositories'),
      repositories: z
        .array(
          z.strictObject({
            remoteUrl: z.string().min(1).max(4096),
            defaultBranch: nullableText(512),
          }),
        )
        .min(1),
      workspaceKind: repositoryWorkspaceKind,
    }),
    z.strictObject({
      kind: z.literal('integration_resources'),
      integrationId: id,
      resourceIds: z.array(id).min(1),
      workspaceKind: repositoryWorkspaceKind,
    }),
  ]),
  temporary: z.boolean(),
  _meta: keyedMeta,
});
export type CoreWorkspaceCreateParams = z.output<
  typeof CoreWorkspaceCreateParamsSchema
>;

export const CoreWorkspaceCreateResultSchema = z.strictObject({
  workspace: z.strictObject({
    workspaceId: id,
    name: z.string().min(1).max(512),
    kind: workspaceKind,
    temporary: z.boolean(),
    repositories: z.array(
      z.strictObject({
        repoId: id,
        name: z.string().min(1).max(512),
        remoteUrl: nullableText(4096),
        branch: nullableText(512),
        headSha: z
          .string()
          .regex(/^[a-fA-F0-9]{7,64}$/)
          .nullable(),
      }),
    ),
    settingsRevision: revision,
    revision,
    createdAt: timestamp,
    updatedAt: timestamp,
  }),
  operation: z
    .strictObject({
      operationId: id,
      state: z.enum([
        'queued',
        'running',
        'waiting',
        'succeeded',
        'failed',
        'cancelled',
      ]),
    })
    .nullable(),
});
export type CoreWorkspaceCreateResult = z.output<
  typeof CoreWorkspaceCreateResultSchema
>;

export const CoreWorkspaceDeleteParamsSchema = z.strictObject({
  workspaceId: id,
  expectedRevision: revision,
  deleteRemoteBranches: z.boolean().optional(),
  _meta: keyedMeta,
});
export type CoreWorkspaceDeleteParams = z.output<
  typeof CoreWorkspaceDeleteParamsSchema
>;

// The catalog's operation reference for accepted durable work, open for
// additive fields. Its kind pattern is looser than OperationKindSchema's.
const operationReference = z
  .object({
    operationId: id,
    kind: z.string().regex(/^(core|worker)(\.[a-z][A-Za-z0-9]*){2,}$/),
    status: OperationStatusSchema,
    authorityId: nullableText(512).optional(),
    executionTargetId: nullableText(512).optional(),
    runtimeDelegationId: nullableText(512).optional(),
    parentOperationId: nullableText(512).optional(),
  })
  .catchall(CanopyJsonValueSchema);

export const CoreWorkspaceDeleteResultSchema = operationReference;
export type CoreWorkspaceDeleteResult = z.output<
  typeof CoreWorkspaceDeleteResultSchema
>;

const branch = z.string().min(1).max(512).regex(/\S/);
const branchName = z
  .string()
  .min(1)
  .max(512)
  .regex(/^\s*[^\s-]/);
const exclusiveWorktreeSources = [
  ['branch', 'existingBranch'],
  ['branch', 'suggestedBranch'],
  ['existingBranch', 'suggestedBranch'],
  ['baseWorktreeId', 'baseBranch'],
  ['baseWorktreeId', 'existingBranch'],
] as const;

export const CoreWorktreeCreateParamsSchema = z
  .strictObject({
    workspaceId: id,
    branch: branchName.optional(),
    existingBranch: branchName.optional(),
    suggestedBranch: branchName.optional(),
    baseBranch: branch.optional(),
    baseWorktreeId: id.optional(),
    includedRepositoryIds: z
      .array(id)
      .max(256)
      .refine((ids) => new Set(ids).size === ids.length, 'Duplicate id')
      .meta({ uniqueItems: true })
      .optional(),
    sidebarItemGroupId: z
      .string()
      .max(512)
      .regex(/^grp-[a-z0-9][a-z0-9-]*$/)
      .optional(),
    baseHeadSha: z.string().nullable().optional(),
    targetId: z.string().nullable().optional(),
    _meta: keyedMeta,
  })
  .superRefine((params, context) => {
    for (const [first, second] of exclusiveWorktreeSources)
      if (params[first] !== undefined && params[second] !== undefined)
        context.addIssue({
          code: 'custom',
          path: [second],
          message: `${first} and ${second} are mutually exclusive.`,
        });
  })
  .meta({
    allOf: [
      {
        not: {
          anyOf: exclusiveWorktreeSources
            .slice(0, 3)
            .map((pair) => ({ required: [...pair] })),
        },
      },
      {
        not: {
          anyOf: exclusiveWorktreeSources
            .slice(3)
            .map((pair) => ({ required: [...pair] })),
        },
      },
    ],
  });
export type CoreWorktreeCreateParams = z.output<
  typeof CoreWorktreeCreateParamsSchema
>;

export const CoreWorktreeCreateResultSchema = operationReference.extend({
  worktreeId: id.optional(),
  branchName: z.string().min(1).max(512).optional(),
  setupPhase: z.enum(['git-pending', 'git-ready']).optional(),
});
export type CoreWorktreeCreateResult = z.output<
  typeof CoreWorktreeCreateResultSchema
>;

export const CoreWorktreeDeleteParamsSchema = z.strictObject({
  worktreeId: id,
  expectedRevision: revision,
  force: z.boolean().optional(),
  _meta: keyedMeta,
});
export type CoreWorktreeDeleteParams = z.output<
  typeof CoreWorktreeDeleteParamsSchema
>;

export const CoreWorktreeDeleteResultSchema = operationReference;
export type CoreWorktreeDeleteResult = z.output<
  typeof CoreWorktreeDeleteResultSchema
>;

export const CoreWorktreeUpdateParamsSchema = z.strictObject({
  worktreeId: id,
  expectedRevision: revision,
  patch: z
    .strictObject({
      label: z.string().max(256).nullable().optional(),
      hidden: z.boolean().optional(),
      pinned: z.boolean().optional(),
      // The catalog lists null inside the enum as well as beside it.
      branchGroupingOverride: z
        .enum(['group', 'ungroup'])
        .meta({ enum: ['group', 'ungroup', null] })
        .nullable()
        .optional(),
      trackedBaseBranch: branch.nullable().optional(),
      trackedRepoBaseBranches: z
        .record(
          // The catalog's propertyNames carries a pattern and no type.
          z
            .string()
            .regex(/^[A-Za-z0-9_-]{1,512}$/)
            .meta({ type: undefined }),
          branch.nullable(),
        )
        .optional(),
      targetId: z.string().nullable().optional(),
    })
    .refine((patch) => Object.keys(patch).length > 0, 'Patch is empty.')
    .meta({ minProperties: 1 }),
  _meta: keyedMeta,
});
export type CoreWorktreeUpdateParams = z.output<
  typeof CoreWorktreeUpdateParamsSchema
>;

export const CoreWorktreeArchiveParamsSchema = z.strictObject({
  worktreeId: id,
  expectedRevision: revision,
  archived: z.boolean(),
});
export type CoreWorktreeArchiveParams = z.output<
  typeof CoreWorktreeArchiveParamsSchema
>;

export const CoreWorktreeCommandResultSchema = z
  .object({
    worktreeId: id,
    workspaceId: id,
    name: z.string().min(1).max(256),
    state: z.enum(['creating', 'ready', 'archived', 'deleting', 'error']),
    revision,
    baseBranch: id,
    branch: id,
    targetId: z.string().nullable().optional(),
    createdAt: timestamp,
    updatedAt: timestamp,
  })
  .catchall(CanopyJsonValueSchema);
export type CoreWorktreeCommandResult = z.output<
  typeof CoreWorktreeCommandResultSchema
>;

const worktreeError = CanopyErrorPayloadSchema.extend({
  code: z
    .enum([
      'core.worktree.invalidState',
      'core.worktree.revisionConflict',
      'core.worktree.notFound',
    ])
    .optional(),
});

// Served by the web core only (CAN-4158). Kept out of CORE_INSTRUCTION_DEFINITIONS,
// as the transport definitions are, because the daemon dispatcher requires a
// handler for every definition it is given and has none for these yet.
export const CORE_WORKSPACE_COMMAND_INSTRUCTION_DEFINITIONS =
  defineCanopyInstructionRegistry('core', {
    'core.workspace.create': defineCanopyInstruction({
      plane: 'core',
      domain: 'workspace',
      version: 1,
      placement: 'core-only',
      idempotency: 'keyed',
      requiredGrants: ['core.workspace.write'],
      params: CoreWorkspaceCreateParamsSchema,
      result: CoreWorkspaceCreateResultSchema,
      error: workspaceError.extend({ retry: CanopyKeyedRetryDirectiveSchema }),
    }),
    'core.workspace.delete': defineCanopyInstruction({
      plane: 'core',
      domain: 'workspace',
      version: 1,
      placement: 'core-only',
      idempotency: 'keyed',
      requiredGrants: ['core.workspace.write'],
      params: CoreWorkspaceDeleteParamsSchema,
      result: CoreWorkspaceDeleteResultSchema,
      error: workspaceError.extend({ retry: CanopyKeyedRetryDirectiveSchema }),
    }),
    'core.worktree.create': defineCanopyInstruction({
      plane: 'core',
      domain: 'worktree',
      version: 1,
      placement: 'core-only',
      idempotency: 'keyed',
      requiredGrants: ['core.worktree.write'],
      params: CoreWorktreeCreateParamsSchema,
      result: CoreWorktreeCreateResultSchema,
      error: worktreeError.extend({ retry: CanopyKeyedRetryDirectiveSchema }),
    }),
    'core.worktree.delete': defineCanopyInstruction({
      plane: 'core',
      domain: 'worktree',
      version: 1,
      placement: 'core-only',
      idempotency: 'keyed',
      requiredGrants: ['core.worktree.write'],
      params: CoreWorktreeDeleteParamsSchema,
      result: CoreWorktreeDeleteResultSchema,
      error: worktreeError.extend({ retry: CanopyKeyedRetryDirectiveSchema }),
    }),
    'core.workspace.update': defineCanopyInstruction({
      plane: 'core',
      domain: 'workspace',
      version: 1,
      placement: 'core-only',
      idempotency: 'keyed',
      requiredGrants: ['core.workspace.write'],
      params: CoreWorkspaceUpdateParamsSchema,
      result: CoreWorkspaceUpdateResultSchema,
      error: workspaceError.extend({ retry: CanopyKeyedRetryDirectiveSchema }),
    }),
    'core.worktree.update': defineCanopyInstruction({
      plane: 'core',
      domain: 'worktree',
      version: 1,
      placement: 'core-only',
      idempotency: 'keyed',
      requiredGrants: ['core.worktree.write'],
      params: CoreWorktreeUpdateParamsSchema,
      result: CoreWorktreeCommandResultSchema,
      error: worktreeError.extend({ retry: CanopyKeyedRetryDirectiveSchema }),
    }),
    'core.worktree.archive': defineCanopyInstruction({
      plane: 'core',
      domain: 'worktree',
      version: 1,
      placement: 'core-only',
      idempotency: 'inherent',
      requiredGrants: ['core.worktree.write'],
      params: CoreWorktreeArchiveParamsSchema,
      result: CoreWorktreeCommandResultSchema,
      error: worktreeError.extend({ retry: CanopyQueryRetryDirectiveSchema }),
    }),
  });
