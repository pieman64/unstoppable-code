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
} from '../../errors';
import { CoreWorkspaceScriptValueSchema } from './metadata-commands';
import {
  CoreWorkspaceCoworkUpdateParamsSchema,
  CoreWorkspaceHooksUpdateParamsSchema,
} from './guarded-commands';

/*
 * The keyed source, composition, rename and fork lifecycles (CAN-5552,
 * W7b-4): #15 `core.workspace.sourceRepo.initialize`, #16 `.type.convert`,
 * #17 `.sourceChanges.apply`, #18–20 `core.workspace.composition.combine`,
 * `.split` and `.promote`, #27 `core.worktree.branch.rename` and #29
 * `core.sharedContainer.fork`. The composition schemas conform unchanged to
 * their catalog pages; the other five are new pages traced from the desktop's
 * typed in-process requests (A5). Host paths, host-derived fields and the
 * caller's source never cross the wire. Only the desktop dispatcher serves
 * them, so, like the other W5 registries, they stay out of
 * CORE_INSTRUCTION_DEFINITIONS, whose daemon dispatcher requires a handler for
 * every definition. The web core never serves them: they run host-local
 * lifecycles.
 */

/** The workspace, worktree and repository id charset (`validateId`). */
const slug = z
  .string()
  .min(1)
  .max(512)
  .regex(/^[a-z0-9][a-z0-9-]*$/);
/** The catalog pages' opaque ids carry bounds only. */
const opaqueId = z.string().min(1).max(512);
const revision = z.number().int().nonnegative();
const keyedMeta = CanopyRequestMetadataSchema.extend({
  idempotencyKey: z.string().min(1).max(512),
});
const warning = z.string().max(2048);
/** A closed, additive success result: clients ignore unknown fields. */
const openResult = <Shape extends z.ZodRawShape>(
  shape: Shape,
): z.ZodObject<Shape, z.core.$catchall<typeof CanopyJsonValueSchema>> =>
  z.object(shape).catchall(CanopyJsonValueSchema);

// Every keyed operation's retry codes (the scripts page's vocabulary).
const WORKSPACE_KEYED = [
  'core.workspace.idempotencyKeyReused',
  'core.workspace.requestInProgress',
  'core.workspace.recoveryRequired',
  'core.workspace.outcomeExpired',
] as const;

/** #15–17's refusal codes. */
const workspaceLifecycleError = CanopyErrorPayloadSchema.extend({
  code: z
    .enum([
      'core.workspace.notFound',
      'core.workspace.configurationUnavailable',
      'core.workspace.invalidState',
      'core.workspace.revisionConflict',
      ...WORKSPACE_KEYED,
    ])
    .optional(),
  retry: CanopyKeyedRetryDirectiveSchema,
});

// --- core.workspace.sourceRepo.initialize (#15) -----------------------------

// A5: the repository folder, the caller's source and the project name are
// host-derived; `sourceRepoPath` is a host path, so the result omits it.
export const CoreWorkspaceSourceRepoInitializeParamsSchema = z.strictObject({
  workspaceId: slug,
  expectedRevision: revision.optional(),
  repoName: z.string().min(1).max(512).regex(/\S/).optional(),
  _meta: keyedMeta,
});
export type CoreWorkspaceSourceRepoInitializeParams = z.output<
  typeof CoreWorkspaceSourceRepoInitializeParamsSchema
>;

export const CORE_WORKSPACE_SOURCE_WARNING_CODES = [
  'missing-remote',
  'duplicate-source-repo',
  'duplicate-repo-binding',
  'duplicate-single-project',
  'local-hook-plugin-selections',
] as const;

export const CoreWorkspaceSourceRepoInitializeResultSchema = openResult({
  workspaceId: slug,
  /** The committed `canopy.json`, as the desktop wrote it. */
  manifest: z.record(z.string(), CanopyJsonValueSchema),
  warnings: z.array(
    z.strictObject({
      code: z.enum(CORE_WORKSPACE_SOURCE_WARNING_CODES),
      message: warning,
      repoId: z.string().max(512).optional(),
      repoName: z.string().max(512).optional(),
    }),
  ),
});
export type CoreWorkspaceSourceRepoInitializeResult = z.output<
  typeof CoreWorkspaceSourceRepoInitializeResultSchema
>;

export const CoreWorkspaceSourceRepoInitializeErrorSchema =
  workspaceLifecycleError;

// --- core.workspace.type.convert (#16) --------------------------------------

const repositoryWorkspaceKind = z.enum(['single_repo', 'multi_repo']);

export const CoreWorkspaceTypeConvertParamsSchema = z.strictObject({
  workspaceId: slug,
  expectedRevision: revision.optional(),
  targetKind: repositoryWorkspaceKind,
  /** How a single-repo project's instructions take the multi-repo guidance. */
  claudeMdMode: z.enum(['replace', 'update', 'unchanged']).optional(),
  _meta: keyedMeta,
});
export type CoreWorkspaceTypeConvertParams = z.output<
  typeof CoreWorkspaceTypeConvertParamsSchema
>;

export const CoreWorkspaceTypeConvertResultSchema = openResult({
  workspaceId: slug,
  kind: repositoryWorkspaceKind,
});
export type CoreWorkspaceTypeConvertResult = z.output<
  typeof CoreWorkspaceTypeConvertResultSchema
>;

export const CoreWorkspaceTypeConvertErrorSchema = workspaceLifecycleError;

// --- core.workspace.sourceChanges.apply (#17) -------------------------------

const scriptMap = z.record(
  z.string().min(1).max(512).meta({ type: undefined }),
  CoreWorkspaceScriptValueSchema,
);
const hookMap =
  CoreWorkspaceHooksUpdateParamsSchema.shape.change.options[0].shape.hooks.unwrap();
const startPage =
  CoreWorkspaceCoworkUpdateParamsSchema.shape.settings.shape.startPage.unwrap();

// A5: the host derives the variant (a multi-repo root or a single-repo
// checkout) from the workspace, so the wire has no kind. `clientRequestId`
// only tags the renderer's applied event, and a repository add's `repoPath`
// is a host path: neither crosses the wire.
export const CoreWorkspaceSourceChangesApplyParamsSchema = z.strictObject({
  workspaceId: slug,
  /** `workspace:{workspaceId}`, when supplied. */
  expectedRevision: revision.optional(),
  /** `worktrees:{workspaceId}`, when supplied. */
  expectedWorktreesRevision: revision.optional(),
  target: z.discriminatedUnion('mode', [
    z.strictObject({ mode: z.literal('existing'), worktreeId: slug }),
    z.strictObject({
      mode: z.literal('new'),
      existingWorktreeIds: z.array(slug).max(4096),
    }),
  ]),
  scripts: scriptMap.optional(),
  hooks: hookMap.optional(),
  /** Portable plugin refs, as `canopy.json` stores them. */
  plugins: z
    .array(z.record(z.string(), CanopyJsonValueSchema))
    .max(500)
    .optional(),
  startPage: startPage.optional(),
  /** Multi-repo only: the root instructions file. */
  claudeMd: z.string().max(1_000_000).optional(),
  repoScriptChanges: z
    .array(z.strictObject({ repoId: slug, scripts: scriptMap }))
    .optional(),
  repoHookChanges: z
    .array(z.strictObject({ repoId: slug, hooks: hookMap }))
    .optional(),
  repoAdds: z
    .array(
      z.strictObject({
        repoId: slug.optional(),
        repoName: z.string().min(1).max(512),
        remoteUrl: z.string().min(1).max(4096),
        scripts: scriptMap.optional(),
        hooks: hookMap.optional(),
      }),
    )
    .optional(),
  repoRemovals: z.array(slug).optional(),
  _meta: keyedMeta,
});
export type CoreWorkspaceSourceChangesApplyParams = z.output<
  typeof CoreWorkspaceSourceChangesApplyParamsSchema
>;

/** Foreground acceptance; the reference checkout's host path is omitted. */
export const CoreWorkspaceSourceChangesApplyResultSchema = openResult({
  workspaceId: slug,
  worktreeId: slug,
  branchName: z.string().min(1).max(512),
  createdWorktree: z.boolean(),
  /** Multi-repo only: whether this change rebound local repositories. */
  localRepoBindingsUpdated: z.boolean().optional(),
});
export type CoreWorkspaceSourceChangesApplyResult = z.output<
  typeof CoreWorkspaceSourceChangesApplyResultSchema
>;

export const CoreWorkspaceSourceChangesApplyErrorSchema =
  workspaceLifecycleError;

// --- core.workspace.composition.* (#18–20, their catalog pages) -------------

const resourceKind = z.enum([
  'workspace',
  'worktree',
  'chat',
  'turn',
  'plan',
  'pipeline_execution',
  'agent_session',
  'artifact',
  'archive',
  'review',
]);
const movedResources = z.array(
  z.strictObject({
    kind: resourceKind,
    id: opaqueId,
    revision: revision.optional(),
    digest: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
  }),
);
const operationState = z.strictObject({
  operationId: opaqueId,
  state: z.enum([
    'queued',
    'running',
    'waiting',
    'succeeded',
    'failed',
    'cancelled',
  ]),
});

export const CoreWorkspaceCompositionCombineParamsSchema = z.strictObject({
  optionId: opaqueId,
  expectedRevision: revision,
  moveChats: z.boolean(),
  _meta: keyedMeta,
});
export type CoreWorkspaceCompositionCombineParams = z.output<
  typeof CoreWorkspaceCompositionCombineParamsSchema
>;

export const CoreWorkspaceCompositionCombineResultSchema = z.strictObject({
  workspaceId: opaqueId,
  worktreeId: opaqueId,
  movedResources,
  operation: operationState,
  warnings: z.array(warning),
});
export type CoreWorkspaceCompositionCombineResult = z.output<
  typeof CoreWorkspaceCompositionCombineResultSchema
>;

export const CoreWorkspaceCompositionSplitParamsSchema = z.strictObject({
  previewId: opaqueId,
  expectedWorkspaceRevision: revision,
  approvedDestructiveItems: z.array(warning),
  _meta: keyedMeta,
});
export type CoreWorkspaceCompositionSplitParams = z.output<
  typeof CoreWorkspaceCompositionSplitParamsSchema
>;

export const CoreWorkspaceCompositionSplitResultSchema = z.strictObject({
  workspaceIds: z.array(opaqueId),
  movedResources,
  operation: operationState,
  warnings: z.array(warning),
});
export type CoreWorkspaceCompositionSplitResult = z.output<
  typeof CoreWorkspaceCompositionSplitResultSchema
>;

export const CoreWorkspaceCompositionPromoteParamsSchema = z.strictObject({
  workspaceId: opaqueId,
  expectedRevision: revision,
  name: z.string().min(1).max(512),
  _meta: keyedMeta,
});
export type CoreWorkspaceCompositionPromoteParams = z.output<
  typeof CoreWorkspaceCompositionPromoteParamsSchema
>;

// D-2: a host omits a revision it cannot report for the decided state.
export const CoreWorkspaceCompositionPromoteResultSchema = z.strictObject({
  workspaceId: opaqueId,
  revision: revision.optional(),
  operation: operationState,
});
export type CoreWorkspaceCompositionPromoteResult = z.output<
  typeof CoreWorkspaceCompositionPromoteResultSchema
>;

export const CoreWorkspaceCompositionErrorSchema =
  CanopyErrorPayloadSchema.extend({
    code: z
      .enum([
        'core.workspace.notFound',
        'core.workspace.invalidState',
        'core.workspace.revisionConflict',
        ...WORKSPACE_KEYED,
      ])
      .optional(),
    retry: CanopyKeyedRetryDirectiveSchema,
  });

// --- core.worktree.branch.rename (#27) --------------------------------------

/** The source-backed root of a multi-repo worktree (`WORKSPACE_ROOT_REPO_ID`). */
const WORKSPACE_ROOT_REPO_ID = '__workspace_root__';

export const CoreWorktreeBranchRenameParamsSchema = z.strictObject({
  workspaceId: slug,
  worktreeId: slug,
  /** A member repository, or the root; absent for a single-repo worktree. */
  repoId: z.union([slug, z.literal(WORKSPACE_ROOT_REPO_ID)]).optional(),
  /** The new name; Git's own rules decide whether it is valid. */
  branchName: z.string().min(1).max(512),
  /** `worktree:{workspaceId}/{worktreeId}`, when supplied. */
  expectedRevision: revision.optional(),
  _meta: keyedMeta,
});
export type CoreWorktreeBranchRenameParams = z.output<
  typeof CoreWorktreeBranchRenameParamsSchema
>;

export const CoreWorktreeBranchRenameResultSchema = openResult({
  workspaceId: slug,
  worktreeId: slug,
  branchName: z.string().min(1).max(512),
});
export type CoreWorktreeBranchRenameResult = z.output<
  typeof CoreWorktreeBranchRenameResultSchema
>;

export const CoreWorktreeBranchRenameErrorSchema =
  CanopyErrorPayloadSchema.extend({
    code: z
      .enum([
        'core.worktree.readOnly',
        'core.worktree.notFound',
        'core.worktree.invalidState',
        'core.worktree.revisionConflict',
        'core.worktree.idempotencyKeyReused',
        'core.worktree.requestInProgress',
        'core.worktree.recoveryRequired',
        'core.worktree.outcomeExpired',
      ])
      .optional(),
    retry: CanopyKeyedRetryDirectiveSchema,
  });

// --- core.sharedContainer.fork (#29) ----------------------------------------

/** `normalizeUuid`'s input: any UUID spelling, normalized by the host. */
const uuid = z
  .string()
  .regex(
    /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/,
  );

// A5: a new workspace's `parentDirectory` is a host path, so the host's own
// default location applies. The owner is the explicit account context the
// share was accepted in; the host refuses any other (`owner-mismatch`).
export const CoreSharedContainerForkParamsSchema = z.strictObject({
  containerId: slug,
  revisionId: slug,
  /** Ownership hint; absent for a personal container shared directly. */
  organizationId: uuid.optional(),
  sourceOwnerDisplayName: z.string().min(1).max(256).regex(/\S/),
  destination: z.discriminatedUnion('kind', [
    z.strictObject({
      kind: z.literal('existing-workspace'),
      workspaceId: slug,
    }),
    z.strictObject({
      kind: z.literal('new-workspace'),
      owner: z.discriminatedUnion('kind', [
        z.strictObject({ kind: z.literal('personal') }),
        z.strictObject({
          kind: z.literal('organization'),
          organizationId: uuid,
        }),
      ]),
    }),
  ]),
  /** The capability package digest the fork confirmation disclosed. */
  expectedPackageDigest: z
    .string()
    .regex(/^pp:v1:[A-Za-z0-9_-]{43}$/)
    .optional(),
  /** The `workspaces` collection revision, when supplied. */
  expectedRevision: revision.optional(),
  _meta: keyedMeta,
});
export type CoreSharedContainerForkParams = z.output<
  typeof CoreSharedContainerForkParamsSchema
>;

export const CoreSharedContainerForkResultSchema = openResult({
  containerType: z.enum(['CODE_WORKTREE', 'COWORK_WORK_ENTRY']),
  workspaceId: slug,
  worktreeId: slug,
  warnings: z.array(warning),
  provenance: openResult({
    sourceContainerId: z.string().min(1).max(512),
    sourceRevisionId: z.string().min(1).max(512),
    sourceRevisionCreatedAt: z.string().max(512).optional(),
    sourceOwnerDisplayName: z.string().max(512),
    organizationId: z.string().max(512).optional(),
    forkedAt: z.string().max(512),
  }),
});
export type CoreSharedContainerForkResult = z.output<
  typeof CoreSharedContainerForkResultSchema
>;

export const CoreSharedContainerForkErrorSchema =
  CanopyErrorPayloadSchema.extend({
    code: z
      .enum([
        'core.sharedContainer.invalidState',
        'core.sharedContainer.revisionConflict',
        'core.sharedContainer.idempotencyKeyReused',
        'core.sharedContainer.requestInProgress',
        'core.sharedContainer.recoveryRequired',
        'core.sharedContainer.outcomeExpired',
      ])
      .optional(),
    retry: CanopyKeyedRetryDirectiveSchema,
  });

const lifecycle = {
  plane: 'core',
  version: 1,
  placement: 'core-only',
  idempotency: 'keyed',
} as const;

export const CORE_SOURCE_COMPOSITION_INSTRUCTION_DEFINITIONS =
  defineCanopyInstructionRegistry('core', {
    'core.workspace.sourceRepo.initialize': defineCanopyInstruction({
      ...lifecycle,
      domain: 'workspace',
      requiredGrants: ['core.workspace.write'],
      params: CoreWorkspaceSourceRepoInitializeParamsSchema,
      result: CoreWorkspaceSourceRepoInitializeResultSchema,
      error: CoreWorkspaceSourceRepoInitializeErrorSchema,
    }),
    'core.workspace.type.convert': defineCanopyInstruction({
      ...lifecycle,
      domain: 'workspace',
      requiredGrants: ['core.workspace.write'],
      params: CoreWorkspaceTypeConvertParamsSchema,
      result: CoreWorkspaceTypeConvertResultSchema,
      error: CoreWorkspaceTypeConvertErrorSchema,
    }),
    'core.workspace.sourceChanges.apply': defineCanopyInstruction({
      ...lifecycle,
      domain: 'workspace',
      requiredGrants: ['core.workspace.write'],
      params: CoreWorkspaceSourceChangesApplyParamsSchema,
      result: CoreWorkspaceSourceChangesApplyResultSchema,
      error: CoreWorkspaceSourceChangesApplyErrorSchema,
    }),
    'core.workspace.composition.combine': defineCanopyInstruction({
      ...lifecycle,
      domain: 'workspace',
      requiredGrants: ['core.workspace.write'],
      params: CoreWorkspaceCompositionCombineParamsSchema,
      result: CoreWorkspaceCompositionCombineResultSchema,
      error: CoreWorkspaceCompositionErrorSchema,
    }),
    'core.workspace.composition.split': defineCanopyInstruction({
      ...lifecycle,
      domain: 'workspace',
      requiredGrants: ['core.workspace.write'],
      params: CoreWorkspaceCompositionSplitParamsSchema,
      result: CoreWorkspaceCompositionSplitResultSchema,
      error: CoreWorkspaceCompositionErrorSchema,
    }),
    'core.workspace.composition.promote': defineCanopyInstruction({
      ...lifecycle,
      domain: 'workspace',
      requiredGrants: ['core.workspace.write'],
      params: CoreWorkspaceCompositionPromoteParamsSchema,
      result: CoreWorkspaceCompositionPromoteResultSchema,
      error: CoreWorkspaceCompositionErrorSchema,
    }),
    'core.worktree.branch.rename': defineCanopyInstruction({
      ...lifecycle,
      domain: 'worktree',
      requiredGrants: ['core.worktree.write'],
      params: CoreWorktreeBranchRenameParamsSchema,
      result: CoreWorktreeBranchRenameResultSchema,
      error: CoreWorktreeBranchRenameErrorSchema,
    }),
    'core.sharedContainer.fork': defineCanopyInstruction({
      ...lifecycle,
      domain: 'sharedContainer',
      requiredGrants: ['core.workspace.write'],
      params: CoreSharedContainerForkParamsSchema,
      result: CoreSharedContainerForkResultSchema,
      error: CoreSharedContainerForkErrorSchema,
    }),
  });
