import { z } from 'zod';

/** Portable, account-bound operations. Keep the operation id across retries. */
export const UpgradePersonalOrganizationRequestSchema = z
  .object({
    organizationId: z.uuid(),
    name: z.string().trim().min(1).max(256),
    operationId: z.uuid(),
  })
  .strict();
export type UpgradePersonalOrganizationRequest = z.infer<
  typeof UpgradePersonalOrganizationRequestSchema
>;
export const UpgradePersonalOrganizationResultSchema = z.object({
  organizationId: z.uuid(),
  name: z.string(),
  personalOrganizationId: z.uuid(),
  operationId: z.uuid(),
  alreadyUpgraded: z.boolean(),
  warnings: z.array(z.literal('policy-refresh-pending')),
});
export type UpgradePersonalOrganizationResult = z.infer<
  typeof UpgradePersonalOrganizationResultSchema
>;

export const SendOrganizationInviteRequestSchema = z
  .object({
    email: z.email().max(256),
    role: z.enum(['ADMIN', 'MEMBER']).optional(),
    organizationTeamId: z.uuid().optional(),
  })
  .strict();
export type SendOrganizationInviteRequest = z.infer<
  typeof SendOrganizationInviteRequestSchema
>;
export const OrganizationInviteResultSchema = z.object({
  status: z.enum([
    'sent',
    'resent',
    'deferred-for-payment',
    'email-suppressed',
  ]),
  inviteId: z.uuid(),
});
export type OrganizationInviteResult = z.infer<
  typeof OrganizationInviteResultSchema
>;
/** Read-only reconciliation after a lost invite response; never sends email. */
export const OrganizationInviteStatusSchema = z.union([
  OrganizationInviteResultSchema,
  z.object({ status: z.literal('pending'), inviteId: z.uuid() }),
  z.object({ status: z.literal('not-found') }),
]);
export type OrganizationInviteStatus = z.infer<
  typeof OrganizationInviteStatusSchema
>;

export const ShareMemberProjectRequestSchema = z
  .object({
    projectId: z.uuid(),
    authorizationVersion: z.number().int().positive(),
  })
  .strict();
export type ShareMemberProjectRequest = z.infer<
  typeof ShareMemberProjectRequestSchema
>;
export const ShareMemberProjectResultSchema = z.object({
  projectId: z.uuid(),
  visibility: z.literal('organization'),
  authorizationVersion: z.number().int().positive(),
});
export type ShareMemberProjectResult = z.infer<
  typeof ShareMemberProjectResultSchema
>;

export const OrganizationOperationErrorSchema = z.object({
  error: z.string(),
  code: z.enum([
    'invalid_request',
    'not_found',
    'forbidden',
    'creation_disabled',
    'operation_conflict',
    'conflict',
    'provisioning_failed',
    'rate_limited',
    'invite_refused',
    'no_saved_card',
    'subscription_complimentary',
    'repository_project_exists',
    'share_confirmation_required',
    'failed',
    'offline',
    'account_changed',
  ]),
});
export type OrganizationOperationError = z.infer<
  typeof OrganizationOperationErrorSchema
>;
/** IPC cannot preserve thrown Error properties across Electron's boundary. */
export const OrganizationOperationRefusalSchema =
  OrganizationOperationErrorSchema.extend({
    status: z.number().int().min(400).max(599).optional(),
  });
export type OrganizationOperationRefusal = z.infer<
  typeof OrganizationOperationRefusalSchema
>;

const WorkspaceId = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/);
export const PersonalProjectSchema = z.object({
  workspaceId: WorkspaceId,
  name: z.string(),
  kind: z.enum(['single-repo', 'multi-repo']),
});
export type PersonalProject = z.infer<typeof PersonalProjectSchema>;
export const PersonalProjectListSchema = z.object({
  projects: z.array(PersonalProjectSchema),
});
export const PersonalProjectConversionRequestSchema = z
  .object({
    operationId: z.uuid(),
    organizationId: z.uuid(),
    workspaceIds: z.array(WorkspaceId).max(1000),
    /** Portal executes one selected project per command; omitted on desktop. */
    workspaceId: WorkspaceId.optional(),
    /** Durable Portal enqueue identity; retries of a lost reply reuse it. */
    submissionId: z.uuid().optional(),
    retryWorkspaceIds: z.array(WorkspaceId).max(1000).optional(),
  })
  .strict();
export type PersonalProjectConversionRequest = z.infer<
  typeof PersonalProjectConversionRequestSchema
>;
export const PersonalProjectOutcomeSchema = z.object({
  workspaceId: WorkspaceId,
  /** Captured before creation so an unknown result replays the same payload. */
  name: z.string().optional(),
  kind: z.enum(['single-repo', 'multi-repo']).optional(),
  stage: z.enum([
    'queued',
    'member-created',
    'converted',
    'shared',
    'complete',
  ]),
  outcome: z.enum([
    'pending',
    'moved',
    'converted-private',
    'not-personal',
    'workspace-not-found',
    'limit-reached',
    'repositories-not-in-team',
    'offline',
    'account-changed',
    'failed',
  ]),
  projectId: z.uuid().optional(),
  /** Persisted before creation; distinguishes unknown writes from batches waiting on them. */
  creationStarted: z.boolean().optional(),
  reason: z.string().optional(),
  refreshWarning: z.boolean().optional(),
});
export type PersonalProjectOutcome = z.infer<
  typeof PersonalProjectOutcomeSchema
>;
export const PersonalProjectOperationSchema = z
  .object({
    operationId: z.uuid(),
    accountId: z.string().min(1),
    organizationId: z.uuid(),
    desktopSessionId: z.string().min(1).optional(),
    selection: z.array(WorkspaceId).max(1000),
    projects: z.array(PersonalProjectOutcomeSchema),
    updatedAt: z.string().datetime(),
  })
  .refine((operation) => {
    const selected = new Set(operation.selection);
    return (
      selected.size === operation.selection.length &&
      operation.projects.length === selected.size &&
      new Set(operation.projects.map((project) => project.workspaceId)).size ===
        selected.size &&
      operation.projects.every(
        (project) =>
          selected.has(project.workspaceId) &&
          (project.stage === 'queued' || project.projectId !== undefined) &&
          (project.outcome !== 'moved' ||
            project.stage === 'shared' ||
            project.stage === 'complete'),
      )
    );
  }, 'Operation stages must belong to the authorized selection');
export type PersonalProjectOperation = z.infer<
  typeof PersonalProjectOperationSchema
>;
export const PersonalProjectStatusRequestSchema = z
  .object({ operationId: z.uuid() })
  .strict();
export const PersonalOrganizationPromotionOutcomeSchema = z.object({
  promotion: UpgradePersonalOrganizationResultSchema,
  contextSwitched: z.boolean(),
  warnings: z.array(
    z.enum([
      'account-refresh-failed',
      'context-switch-failed',
      'account-changed',
      'local-suppression-failed',
    ]),
  ),
});
export type PersonalOrganizationPromotionOutcome = z.infer<
  typeof PersonalOrganizationPromotionOutcomeSchema
>;
