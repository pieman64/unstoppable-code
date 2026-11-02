import { z } from 'zod';

import { LEDGER_LIMITS } from './limits';
import {
  containsDisallowedControlCharacters,
  countCodePoints,
  isPortableRelativePath,
  isWithinLedgerRequestLimit,
  normalizeLedgerFileRefs,
} from './text';

export const LEDGER_ENTRY_TYPES = [
  'TASK',
  'ACTION',
  'DECISION',
  'OBSERVATION',
  'SUMMARY',
] as const;

export const LedgerEntryTypeSchema = z.enum(LEDGER_ENTRY_TYPES);
export type LedgerEntryType = z.output<typeof LedgerEntryTypeSchema>;

export const LEDGER_PUBLIC_ENTRY_TYPES = [
  'TASK',
  'ACTION',
  'DECISION',
  'OBSERVATION',
] as const;

export const LedgerPublicEntryTypeSchema = z.enum(LEDGER_PUBLIC_ENTRY_TYPES);
export type LedgerPublicEntryType = z.output<
  typeof LedgerPublicEntryTypeSchema
>;

export const LEDGER_STATUSES = [
  'TODO',
  'IN_PROGRESS',
  'COMPLETED',
  'FAILED',
  'BLOCKED',
  'NEEDS_REVIEW',
  'INFO',
] as const;

export const LedgerStatusSchema = z.enum(LEDGER_STATUSES);
export type LedgerStatus = z.output<typeof LedgerStatusSchema>;

export const LEDGER_TERMINAL_STATUSES = [
  'COMPLETED',
  'FAILED',
  'INFO',
] as const;

export function isLedgerTerminalStatus(status: LedgerStatus): boolean {
  return LEDGER_TERMINAL_STATUSES.some(
    (terminalStatus: (typeof LEDGER_TERMINAL_STATUSES)[number]): boolean =>
      terminalStatus === status,
  );
}

/** Creation status when the caller does not choose one. */
export const LEDGER_DEFAULT_STATUS_BY_TYPE: {
  readonly [Type in LedgerEntryType]: LedgerStatus;
} = {
  TASK: 'TODO',
  ACTION: 'IN_PROGRESS',
  DECISION: 'INFO',
  OBSERVATION: 'INFO',
  SUMMARY: 'INFO',
};

export const LEDGER_ACTOR_KINDS = [
  'user',
  'chat',
  'pipeline_agent',
  'managed_delegation',
  'background',
  'ledger_sidecar',
] as const;

export const LedgerActorKindSchema = z.enum(LEDGER_ACTOR_KINDS);
export type LedgerActorKind = z.output<typeof LedgerActorKindSchema>;

export const LEDGER_ATTRIBUTION_KINDS = [
  'self_reported',
  'user',
  'system',
  'sidecar',
] as const;

export const LedgerAttributionKindSchema = z.enum(LEDGER_ATTRIBUTION_KINDS);
export type LedgerAttributionKind = z.output<
  typeof LedgerAttributionKindSchema
>;

export const LEDGER_SYNC_STATES = [
  'pending',
  'mirrored',
  'local_only',
  'policy_restricted',
  'repair_needed',
] as const;

export const LedgerSyncStateSchema = z.enum(LEDGER_SYNC_STATES);
export type LedgerSyncState = z.output<typeof LedgerSyncStateSchema>;

export const LEDGER_SOURCE_AVAILABILITIES = [
  'available',
  'archived',
  'not_on_this_device',
  'access_denied',
  'deleted',
  'expired',
  'anchor_missing',
] as const;

export const LedgerSourceAvailabilitySchema = z.enum(
  LEDGER_SOURCE_AVAILABILITIES,
);
export type LedgerSourceAvailability = z.output<
  typeof LedgerSourceAvailabilitySchema
>;

/**
 * What opening an entry's source shows: the chat that recorded it, a pipeline
 * run, or the Summary snapshot it recorded. A managed delegate's source is
 * its root's: the chat or the run that started it.
 */
export const LEDGER_SOURCE_KINDS = ['chat', 'pipeline', 'summary'] as const;

export const LedgerSourceKindSchema = z.enum(LEDGER_SOURCE_KINDS);
export type LedgerSourceKind = z.output<typeof LedgerSourceKindSchema>;

export const LEDGER_SEARCH_SORTS = ['created_desc', 'updated_desc'] as const;

export const LedgerSearchSortSchema = z.enum(LEDGER_SEARCH_SORTS);
export type LedgerSearchSort = z.output<typeof LedgerSearchSortSchema>;

export const LEDGER_ERROR_REASONS = [
  'INVALID_INPUT',
  'NOT_FOUND',
  'FORBIDDEN',
  'TERMINAL_ENTRY',
  'REVISION_CONFLICT',
  'OWNER_UNAVAILABLE',
  'SCOPE_RETIRED',
  'IDEMPOTENCY_KEY_REUSED',
  'CURSOR_EXPIRED',
  'UNSUPPORTED_SCHEMA',
  'STORAGE_UNAVAILABLE',
  'RATE_LIMITED',
  'WRITER_UNAVAILABLE',
] as const;

export const LedgerErrorReasonSchema = z.enum(LEDGER_ERROR_REASONS);
export type LedgerErrorReason = z.output<typeof LedgerErrorReasonSchema>;

export const LEDGER_ERROR_CODES = {
  INVALID_INPUT: 'core.ledger.invalidInput',
  NOT_FOUND: 'core.ledger.notFound',
  FORBIDDEN: 'core.ledger.forbidden',
  TERMINAL_ENTRY: 'core.ledger.terminalEntry',
  REVISION_CONFLICT: 'core.ledger.revisionConflict',
  OWNER_UNAVAILABLE: 'core.ledger.ownerUnavailable',
  SCOPE_RETIRED: 'core.ledger.scopeRetired',
  IDEMPOTENCY_KEY_REUSED: 'core.ledger.idempotencyKeyReused',
  CURSOR_EXPIRED: 'core.ledger.cursorExpired',
  UNSUPPORTED_SCHEMA: 'core.ledger.unsupportedSchema',
  STORAGE_UNAVAILABLE: 'core.ledger.storageUnavailable',
  RATE_LIMITED: 'core.ledger.rateLimited',
  WRITER_UNAVAILABLE: 'core.ledger.writerUnavailable',
} as const satisfies { readonly [Reason in LedgerErrorReason]: string };

const LEDGER_ERROR_CODE_VALUES = [
  'core.ledger.invalidInput',
  'core.ledger.notFound',
  'core.ledger.forbidden',
  'core.ledger.terminalEntry',
  'core.ledger.revisionConflict',
  'core.ledger.ownerUnavailable',
  'core.ledger.scopeRetired',
  'core.ledger.idempotencyKeyReused',
  'core.ledger.cursorExpired',
  'core.ledger.unsupportedSchema',
  'core.ledger.storageUnavailable',
  'core.ledger.rateLimited',
  'core.ledger.writerUnavailable',
] as const;

export const LedgerErrorCodeSchema = z.enum(LEDGER_ERROR_CODE_VALUES);
export type LedgerErrorCode = z.output<typeof LedgerErrorCodeSchema>;

export const LedgerUuidSchema = z.uuid();
export const LedgerOpaqueIdSchema = z
  .string()
  .min(1)
  .refine(
    (value: string): boolean =>
      countCodePoints(value) <= LEDGER_LIMITS.opaqueIdMaxCodePoints,
    `Must be at most ${LEDGER_LIMITS.opaqueIdMaxCodePoints} code points`,
  )
  .meta({ maxLength: LEDGER_LIMITS.opaqueIdMaxCodePoints });
export const LedgerSequenceSchema = z.string().regex(/^(0|[1-9][0-9]{0,19})$/);
export const LedgerTimestampSchema = z.iso.datetime();
export const LedgerTimeFilterSchema = z.iso.datetime({ offset: true });
export const LedgerCursorSchema = z
  .string()
  .min(1)
  .max(LEDGER_LIMITS.cursorMaxLength);
export const LedgerEligibilityTokenSchema = z
  .string()
  .min(1)
  .max(LEDGER_LIMITS.eligibilityTokenMaxLength);
export const LedgerRequestKeySchema = z
  .string()
  .min(1)
  .max(LEDGER_LIMITS.requestKeyMaxLength);

function ledgerTextSchema(
  maxCodePoints: number,
  allowLineBreaks: boolean,
): z.ZodType<string> {
  return z
    .string()
    .trim()
    .min(1)
    .refine(
      (value: string): boolean => countCodePoints(value) <= maxCodePoints,
      `Must be at most ${maxCodePoints} code points`,
    )
    .refine(
      (value: string): boolean =>
        !containsDisallowedControlCharacters(value, { allowLineBreaks }),
      'Control characters are not allowed',
    )
    .meta({ maxLength: maxCodePoints });
}

export const LedgerTitleSchema = ledgerTextSchema(
  LEDGER_LIMITS.titleMaxCodePoints,
  false,
);
export const LedgerContentSchema = ledgerTextSchema(
  LEDGER_LIMITS.contentMaxCodePoints,
  true,
);
export const LedgerHighlightSchema = ledgerTextSchema(
  LEDGER_LIMITS.highlightMaxCodePoints,
  false,
);
export const LedgerDisplayNameSchema = ledgerTextSchema(
  LEDGER_LIMITS.displayNameMaxCodePoints,
  false,
);
export const LedgerSearchQuerySchema = ledgerTextSchema(
  LEDGER_LIMITS.searchQueryMaxCodePoints,
  false,
);

export const LedgerSettingValueSchema = z
  .string()
  .min(1)
  .refine(
    (value: string): boolean =>
      countCodePoints(value) <= LEDGER_LIMITS.settingMaxCodePoints,
    `Must be at most ${LEDGER_LIMITS.settingMaxCodePoints} code points`,
  )
  .meta({ maxLength: LEDGER_LIMITS.settingMaxCodePoints });

export const LedgerFilePathSchema = z
  .string()
  .min(1)
  .refine(
    (value: string): boolean =>
      countCodePoints(value) <= LEDGER_LIMITS.pathMaxCodePoints,
    `Must be at most ${LEDGER_LIMITS.pathMaxCodePoints} code points`,
  )
  .refine(isPortableRelativePath, 'Expected a normalized relative POSIX path')
  .meta({ maxLength: LEDGER_LIMITS.pathMaxCodePoints });

/**
 * Organization ids in a global owner are lowercase canonical UUIDs. Mixed-case
 * input is rejected here so one organization never yields two owner keys;
 * {@link parseLedgerGlobalOwner} normalizes a persisted execution context
 * before it reaches this schema.
 */
export const LedgerOrganizationIdSchema = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);

/** Who owns a global (workflow) Ledger: the account itself or an organization. */
export const LedgerGlobalOwnerSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('personal') }),
  z.strictObject({
    kind: z.literal('organization'),
    organizationId: LedgerOrganizationIdSchema,
  }),
]);
export type LedgerGlobalOwner = z.output<typeof LedgerGlobalOwnerSchema>;

/**
 * The container of entries written by pipeline agents that have no task: one
 * per owner, account and local writer. It has no workspace and no lifecycle.
 */
export const LedgerGlobalContainerSchema = z.strictObject({
  kind: z.literal('global'),
  owner: LedgerGlobalOwnerSchema,
});
export type LedgerGlobalContainer = z.output<
  typeof LedgerGlobalContainerSchema
>;

const LEDGER_PERSONAL_OWNER_KEY = 'personal';
const LEDGER_ORGANIZATION_OWNER_PREFIX = 'org:';

/** `personal` or `org:<lowercase uuid>`, for storage, sync policy and view keys. */
export function ledgerGlobalOwnerKey(owner: LedgerGlobalOwner): string {
  return owner.kind === 'personal'
    ? LEDGER_PERSONAL_OWNER_KEY
    : `${LEDGER_ORGANIZATION_OWNER_PREFIX}${owner.organizationId.toLowerCase()}`;
}

export function isSameLedgerGlobalOwner(
  left: LedgerGlobalOwner,
  right: LedgerGlobalOwner,
): boolean {
  return ledgerGlobalOwnerKey(left) === ledgerGlobalOwnerKey(right);
}

export type LedgerGlobalOwnerParseResult =
  | { readonly ok: true; readonly owner: LedgerGlobalOwner }
  | { readonly ok: false; readonly reason: 'malformed_owner' };

/**
 * The single parser from a run's persisted `execution_context` (`personal` /
 * `org:<uuid>`) to a global owner. Absent means Personal (runs persisted before
 * ownership existed); anything malformed fails closed.
 */
export function parseLedgerGlobalOwner(
  executionContext: string | null | undefined,
): LedgerGlobalOwnerParseResult {
  if (executionContext === null || executionContext === undefined) {
    return { ok: true, owner: { kind: 'personal' } };
  }
  if (executionContext === LEDGER_PERSONAL_OWNER_KEY) {
    return { ok: true, owner: { kind: 'personal' } };
  }
  if (executionContext.startsWith(LEDGER_ORGANIZATION_OWNER_PREFIX)) {
    const organizationId = LedgerOrganizationIdSchema.safeParse(
      executionContext
        .slice(LEDGER_ORGANIZATION_OWNER_PREFIX.length)
        .trim()
        .toLowerCase(),
    );
    if (organizationId.success) {
      return {
        ok: true,
        owner: { kind: 'organization', organizationId: organizationId.data },
      };
    }
  }
  return { ok: false, reason: 'malformed_owner' };
}

export const LedgerContainerSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('code_worktree'),
    workspaceId: LedgerOpaqueIdSchema,
    worktreeId: LedgerOpaqueIdSchema,
  }),
  z.strictObject({
    kind: z.literal('cowork_entry'),
    workspaceId: LedgerOpaqueIdSchema,
    entryId: LedgerOpaqueIdSchema,
  }),
  z.strictObject({
    kind: z.literal('advisor_entry'),
    appWorkspaceId: z.literal('app-advisor'),
    entryId: LedgerOpaqueIdSchema,
  }),
  LedgerGlobalContainerSchema,
]);
export type LedgerContainer = z.output<typeof LedgerContainerSchema>;

export function isLedgerGlobalContainer(
  container: LedgerContainer,
): container is LedgerGlobalContainer {
  return container.kind === 'global';
}

export const LedgerScopeRefSchema = z.strictObject({
  ledgerId: LedgerUuidSchema,
  authorityId: LedgerOpaqueIdSchema,
  container: LedgerContainerSchema,
});
export type LedgerScopeRef = z.output<typeof LedgerScopeRefSchema>;

export const LedgerActorRefSchema = z.strictObject({
  actorId: LedgerUuidSchema,
  kind: LedgerActorKindSchema,
  authorityId: LedgerOpaqueIdSchema,
});
export type LedgerActorRef = z.output<typeof LedgerActorRefSchema>;

/**
 * The display snapshot an actor was registered with, for showing who wrote or
 * owns an entry. The user's own actor is labeled as the host names it.
 */
export const LedgerActorLabelSchema = z.strictObject({
  actorId: LedgerUuidSchema,
  kind: LedgerActorKindSchema,
  displayName: LedgerDisplayNameSchema,
});
export type LedgerActorLabel = z.output<typeof LedgerActorLabelSchema>;

export const LedgerAuthorDetailsSchema = z.strictObject({
  harness: LedgerSettingValueSchema.nullable(),
  model: LedgerSettingValueSchema.nullable(),
  thinkingEffort: LedgerSettingValueSchema.nullable(),
  mode: LedgerSettingValueSchema.nullable(),
  pipelineExecutionId: LedgerOpaqueIdSchema.nullable(),
  settingsRevision: LedgerSettingValueSchema.nullable(),
  unavailableReason: z.enum(['not_applicable', 'not_recorded']).nullable(),
});
export type LedgerAuthorDetails = z.output<typeof LedgerAuthorDetailsSchema>;

export const LedgerFileRefSchema = z.strictObject({
  rootId: LedgerOpaqueIdSchema,
  path: LedgerFilePathSchema,
  startLine: z.int().min(1).optional(),
});
export type LedgerFileRef = z.output<typeof LedgerFileRefSchema>;

export const LedgerOriginSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('chat'),
    ledgerId: LedgerUuidSchema,
    chatId: LedgerOpaqueIdSchema,
    messageId: LedgerOpaqueIdSchema.optional(),
    turnId: LedgerOpaqueIdSchema.optional(),
    toolCallId: LedgerOpaqueIdSchema.optional(),
  }),
  z.strictObject({
    kind: z.literal('pipeline_agent'),
    ledgerId: LedgerUuidSchema,
    executionId: LedgerOpaqueIdSchema,
    physicalJobId: LedgerOpaqueIdSchema,
    logicalJobId: LedgerOpaqueIdSchema,
    stepId: LedgerOpaqueIdSchema,
    attempt: z.int().min(1),
    iteration: z.int().min(0),
    agentSessionId: LedgerOpaqueIdSchema,
    /** The agent session of the attempt this retried attempt replaces. */
    predecessorAgentSessionId: LedgerOpaqueIdSchema.optional(),
    checkpointId: LedgerOpaqueIdSchema.optional(),
    transcriptEventId: LedgerOpaqueIdSchema.optional(),
  }),
  z.strictObject({
    kind: z.literal('managed_delegation'),
    ledgerId: LedgerUuidSchema,
    delegationId: LedgerOpaqueIdSchema,
    parentActorId: LedgerUuidSchema,
    root: z.discriminatedUnion('kind', [
      z.strictObject({
        kind: z.literal('chat'),
        chatId: LedgerOpaqueIdSchema,
      }),
      z.strictObject({
        kind: z.literal('pipeline_agent'),
        executionId: LedgerOpaqueIdSchema,
      }),
    ]),
    runGeneration: z.int().min(1),
    eventId: LedgerOpaqueIdSchema.optional(),
    resultIndex: z.int().min(1).optional(),
  }),
  z.strictObject({
    kind: z.literal('summary'),
    ledgerId: LedgerUuidSchema,
    snapshotId: LedgerOpaqueIdSchema,
    generationId: LedgerOpaqueIdSchema,
    helperActorId: LedgerUuidSchema,
    observedTaskId: LedgerOpaqueIdSchema.optional(),
    summaryArtifactId: LedgerOpaqueIdSchema.optional(),
  }),
  z.strictObject({
    kind: z.literal('user'),
    ledgerId: LedgerUuidSchema,
    userActorId: LedgerUuidSchema,
  }),
]);
export type LedgerOrigin = z.output<typeof LedgerOriginSchema>;

/**
 * The kind of source an origin opens, or undefined for an entry a person
 * added, which has none.
 */
export function ledgerSourceKindOfOrigin(
  origin: LedgerOrigin,
): LedgerSourceKind | undefined {
  switch (origin.kind) {
    case 'chat':
      return 'chat';
    case 'managed_delegation':
      return origin.root.kind === 'chat' ? 'chat' : 'pipeline';
    case 'pipeline_agent':
      return 'pipeline';
    case 'summary':
      return 'summary';
    case 'user':
      return undefined;
  }
}

export const LedgerAttributionSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('self_reported'),
    effectiveActor: LedgerActorRefSchema,
    recordedBy: LedgerActorRefSchema,
    executorDetails: LedgerAuthorDetailsSchema,
  }),
  z.strictObject({
    kind: z.literal('user'),
    effectiveActor: LedgerActorRefSchema,
    recordedBy: LedgerActorRefSchema,
    executorDetails: LedgerAuthorDetailsSchema,
  }),
  z.strictObject({
    kind: z.literal('system'),
    effectiveActor: LedgerActorRefSchema,
    recordedBy: LedgerActorRefSchema,
    executorDetails: LedgerAuthorDetailsSchema,
  }),
  z.strictObject({
    kind: z.literal('sidecar'),
    effectiveActor: LedgerActorRefSchema,
    recordedBy: LedgerActorRefSchema,
    executorDetails: LedgerAuthorDetailsSchema,
    sidecarSessionId: LedgerOpaqueIdSchema,
    primaryActorId: LedgerUuidSchema,
    batchId: LedgerOpaqueIdSchema,
    evidenceEventIds: z
      .array(LedgerOpaqueIdSchema)
      .max(LEDGER_LIMITS.evidenceEventIdsMax),
  }),
]);
export type LedgerAttribution = z.output<typeof LedgerAttributionSchema>;

const LedgerEntryObjectSchema = z.strictObject({
  schemaVersion: z.literal(1),
  entryId: LedgerUuidSchema,
  scope: LedgerScopeRefSchema,
  createdAt: LedgerTimestampSchema,
  updatedAt: LedgerTimestampSchema,
  revision: z.int().min(1),
  author: LedgerActorRefSchema,
  authorDetails: LedgerAuthorDetailsSchema,
  owner: LedgerActorRefSchema,
  type: LedgerEntryTypeSchema,
  title: LedgerTitleSchema,
  content: LedgerContentSchema,
  highlights: z.array(LedgerHighlightSchema).max(LEDGER_LIMITS.highlightsMax),
  referenceFiles: z
    .array(LedgerFileRefSchema)
    .max(LEDGER_LIMITS.referenceFilesMax),
  status: LedgerStatusSchema,
  origin: LedgerOriginSchema,
  attribution: LedgerAttributionSchema,
  supersedesEntryId: LedgerUuidSchema.optional(),
});

export const LedgerEntrySchema = LedgerEntryObjectSchema.superRefine(
  (entry, context): void => {
    if (
      normalizeLedgerFileRefs(entry.referenceFiles).length !==
      entry.referenceFiles.length
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Reference files must be unique',
        path: ['referenceFiles'],
      });
    }

    const effectiveActor = entry.attribution.effectiveActor;
    if (
      entry.author.actorId !== effectiveActor.actorId ||
      entry.author.kind !== effectiveActor.kind ||
      entry.author.authorityId !== effectiveActor.authorityId
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Author must match the effective attribution actor',
        path: ['author'],
      });
    }

    if (entry.type === 'SUMMARY' && entry.status !== 'INFO') {
      context.addIssue({
        code: 'custom',
        message: 'Summary entries must have INFO status',
        path: ['status'],
      });
    }
  },
);
export type LedgerEntry = z.output<typeof LedgerEntrySchema>;

export const LedgerMutationSchema = z.strictObject({
  mutationId: LedgerUuidSchema,
  entryId: LedgerUuidSchema,
  kind: z.enum(['create', 'update']),
  revision: z.int().min(1),
  previousRevision: z.int().min(1).nullable(),
  occurredAt: LedgerTimestampSchema,
  status: z
    .strictObject({
      from: LedgerStatusSchema.nullable(),
      to: LedgerStatusSchema,
    })
    .optional(),
  owner: z
    .strictObject({
      from: LedgerActorRefSchema.nullable(),
      to: LedgerActorRefSchema,
    })
    .optional(),
  attribution: LedgerAttributionSchema,
  invocationOrigin: LedgerOriginSchema,
});
export type LedgerMutation = z.output<typeof LedgerMutationSchema>;

export const LedgerCommandReceiptSchema = z.strictObject({
  entry: LedgerEntrySchema,
  changed: z.boolean(),
  mutationId: LedgerUuidSchema.nullable(),
  localSequence: LedgerSequenceSchema,
  syncState: LedgerSyncStateSchema,
});
export type LedgerCommandReceipt = z.output<typeof LedgerCommandReceiptSchema>;

export const LedgerOwnerTargetSchema = z.union([
  z.literal('self'),
  z.strictObject({
    actorId: LedgerUuidSchema,
    eligibilityToken: LedgerEligibilityTokenSchema,
  }),
]);
export type LedgerOwnerTarget = z.output<typeof LedgerOwnerTargetSchema>;

export const LedgerActorFilterSchema = z.union([
  z.literal('self'),
  z.strictObject({ actorId: LedgerUuidSchema }),
]);
export type LedgerActorFilter = z.output<typeof LedgerActorFilterSchema>;

/**
 * Exactly which pause a paused pipeline agent candidate is: its execution,
 * physical job, step, attempt and the recovery checkpoint it resumes from.
 */
export const LedgerOwnerPipelineAgentSchema = z.strictObject({
  executionId: LedgerOpaqueIdSchema,
  jobId: LedgerOpaqueIdSchema,
  stepId: LedgerOpaqueIdSchema,
  attempt: z.int().min(1),
  checkpointId: LedgerOpaqueIdSchema,
  /** When the agent paused; null when unknown. */
  pausedAt: LedgerTimestampSchema.nullable(),
});
export type LedgerOwnerPipelineAgent = z.output<
  typeof LedgerOwnerPipelineAgentSchema
>;

/**
 * Whether two locators name the same pause of a pipeline agent. An agent keeps
 * its actor across pauses, so the actor alone does not tell pauses apart.
 * Two absent locators are the same; one absent is not.
 */
export function isSameLedgerPipelinePause(
  left: LedgerOwnerPipelineAgent | undefined,
  right: LedgerOwnerPipelineAgent | undefined,
): boolean {
  if (left === undefined || right === undefined) return left === right;
  return (
    left.executionId === right.executionId &&
    left.jobId === right.jobId &&
    left.stepId === right.stepId &&
    left.attempt === right.attempt &&
    left.checkpointId === right.checkpointId
  );
}

export const LedgerOwnerCandidateSchema = z.strictObject({
  actor: LedgerActorRefSchema,
  displayName: LedgerDisplayNameSchema,
  eligibilityToken: LedgerEligibilityTokenSchema,
  isSelf: z.boolean(),
  /** Present for a paused pipeline agent, so pickers can tell pauses apart. */
  pipelineAgent: LedgerOwnerPipelineAgentSchema.optional(),
});
export type LedgerOwnerCandidate = z.output<typeof LedgerOwnerCandidateSchema>;

export const LedgerOwnerCandidatePageSchema = z.strictObject({
  candidates: z
    .array(LedgerOwnerCandidateSchema)
    .max(LEDGER_LIMITS.ownersPageMax),
  nextCursor: LedgerCursorSchema.nullable(),
});
export type LedgerOwnerCandidatePage = z.output<
  typeof LedgerOwnerCandidatePageSchema
>;

export const LedgerErrorDetailsSchema = z.strictObject({
  reason: LedgerErrorReasonSchema,
  field: z.string().min(1).max(256).optional(),
  limit: z.int().min(0).optional(),
  currentEntry: LedgerEntrySchema.optional(),
});
export type LedgerErrorDetails = z.output<typeof LedgerErrorDetailsSchema>;

/**
 * Rejects a request whose UTF-8 JSON exceeds the Ledger request limit before
 * any field is parsed. Each field is bounded, but together they can exceed the
 * limit, and parsing an oversized payload first would waste the work the limit
 * exists to prevent. Every Ledger params and tool-input schema applies it.
 */
export function limitLedgerRequest<Schema extends z.ZodType>(
  schema: Schema,
): z.ZodPipe<z.ZodTransform<unknown, unknown>, Schema> {
  return z.preprocess((value: unknown, context): unknown => {
    if (!isWithinLedgerRequestLimit(value)) {
      context.addIssue({
        code: 'custom',
        message: `Request must be at most ${LEDGER_LIMITS.requestMaxBytes} bytes`,
        input: value,
      });
    }
    return value;
  }, schema);
}

export const LedgerEntrySearchItemSchema = z.strictObject({
  entryId: LedgerUuidSchema,
  revision: z.int().min(1),
  type: LedgerEntryTypeSchema,
  title: LedgerTitleSchema,
  content: LedgerContentSchema,
  highlights: z.array(LedgerHighlightSchema).max(LEDGER_LIMITS.highlightsMax),
  referenceFiles: z
    .array(LedgerFileRefSchema)
    .max(LEDGER_LIMITS.referenceFilesMax),
  status: LedgerStatusSchema,
  owner: LedgerActorRefSchema,
  author: LedgerActorRefSchema,
  attributionKind: LedgerAttributionKindSchema,
  createdAt: LedgerTimestampSchema,
  updatedAt: LedgerTimestampSchema,
  supersedesEntryId: LedgerUuidSchema.optional(),
  sourceAvailability: LedgerSourceAvailabilitySchema,
  /**
   * What the entry's source opens as, so a list can name its source action
   * without reading the entry. The device that owns the entry reports it; a
   * row read from the mirror, or an entry a person added, carries none.
   */
  sourceKind: LedgerSourceKindSchema.optional(),
  /**
   * Whether the shown revision has reached the mirror. The device that owns
   * the entry reports it; a row read from the mirror carries none.
   */
  syncState: LedgerSyncStateSchema.optional(),
  /**
   * Present while the device that owns the entry still writes its title. The
   * title shown is the start of the content until then, and the entry waits
   * to sync. A row read from the mirror never carries it.
   */
  titlePending: z.literal(true).optional(),
});
export type LedgerEntrySearchItem = z.output<
  typeof LedgerEntrySearchItemSchema
>;

/** Projects an entry for search results, omitting provenance detail. */
export function toLedgerEntrySearchItem(
  entry: LedgerEntry,
  sourceAvailability: LedgerSourceAvailability,
  syncState?: LedgerSyncState,
  titlePending?: boolean,
): LedgerEntrySearchItem {
  return {
    entryId: entry.entryId,
    revision: entry.revision,
    type: entry.type,
    title: entry.title,
    content: entry.content,
    highlights: entry.highlights,
    referenceFiles: entry.referenceFiles,
    status: entry.status,
    owner: entry.owner,
    author: entry.author,
    attributionKind: entry.attribution.kind,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    ...(entry.supersedesEntryId === undefined
      ? {}
      : { supersedesEntryId: entry.supersedesEntryId }),
    sourceAvailability,
    ...(syncState === undefined ? {} : { syncState }),
    ...(titlePending === true ? { titlePending: true } : {}),
  };
}

export const LedgerAddEntryParamsObjectSchema = z.strictObject({
  type: LedgerPublicEntryTypeSchema,
  /**
   * Optional for the person's form: without one, the Ledger records the start
   * of the content as the title and writes a better one in the background.
   * The Ledger tools always require one (`LedgerAddEntryToolInputSchema`).
   */
  title: LedgerTitleSchema.optional(),
  content: LedgerContentSchema,
  highlights: z
    .array(LedgerHighlightSchema)
    .max(LEDGER_LIMITS.highlightsMax)
    .optional(),
  referenceFiles: z
    .array(LedgerFileRefSchema)
    .max(LEDGER_LIMITS.referenceFilesMax)
    .optional(),
  status: LedgerStatusSchema.optional(),
  owner: LedgerOwnerTargetSchema.optional(),
  supersedesEntryId: LedgerUuidSchema.optional(),
});

export const LedgerAddEntryParamsSchema = limitLedgerRequest(
  LedgerAddEntryParamsObjectSchema,
);
export type LedgerAddEntryParams = z.output<typeof LedgerAddEntryParamsSchema>;

export const LedgerAddEntryToolInputSchema = limitLedgerRequest(
  LedgerAddEntryParamsObjectSchema.extend({
    title: LedgerTitleSchema,
    requestKey: LedgerRequestKeySchema.optional(),
  }),
);
export type LedgerAddEntryToolInput = z.output<
  typeof LedgerAddEntryToolInputSchema
>;

export const LedgerUpdateEntryParamsObjectSchema = z.strictObject({
  entryId: LedgerUuidSchema,
  expectedRevision: z.int().min(1),
  status: LedgerStatusSchema.optional(),
  owner: LedgerOwnerTargetSchema.optional(),
});

export const LedgerUpdateEntryParamsSchema = limitLedgerRequest(
  LedgerUpdateEntryParamsObjectSchema.refine(
    (value): boolean => value.status !== undefined || value.owner !== undefined,
    'At least one of status or owner is required',
  ),
);
export type LedgerUpdateEntryParams = z.output<
  typeof LedgerUpdateEntryParamsSchema
>;

export const LedgerUpdateEntryToolInputSchema = limitLedgerRequest(
  LedgerUpdateEntryParamsObjectSchema.extend({
    requestKey: LedgerRequestKeySchema.optional(),
  }).refine(
    (value): boolean => value.status !== undefined || value.owner !== undefined,
    'At least one of status or owner is required',
  ),
);
export type LedgerUpdateEntryToolInput = z.output<
  typeof LedgerUpdateEntryToolInputSchema
>;

export const LedgerSearchEntriesParamsSchema = limitLedgerRequest(
  z.strictObject({
    query: LedgerSearchQuerySchema.optional(),
    entryIds: z
      .array(LedgerUuidSchema)
      .min(1)
      .max(LEDGER_LIMITS.searchEntryIdsMax)
      .optional(),
    owner: LedgerActorFilterSchema.optional(),
    author: LedgerActorFilterSchema.optional(),
    types: z
      .array(LedgerEntryTypeSchema)
      .min(1)
      .max(LEDGER_ENTRY_TYPES.length)
      .optional(),
    statuses: z
      .array(LedgerStatusSchema)
      .min(1)
      .max(LEDGER_STATUSES.length)
      .optional(),
    attribution: z
      .array(LedgerAttributionKindSchema)
      .min(1)
      .max(LEDGER_ATTRIBUTION_KINDS.length)
      .optional(),
    createdAfter: LedgerTimeFilterSchema.optional(),
    createdBefore: LedgerTimeFilterSchema.optional(),
    updatedAfter: LedgerTimeFilterSchema.optional(),
    updatedBefore: LedgerTimeFilterSchema.optional(),
    sort: LedgerSearchSortSchema.optional(),
    limit: z.int().min(1).max(LEDGER_LIMITS.searchPageMax).optional(),
    cursor: LedgerCursorSchema.optional(),
    includeAssignableOwners: z.boolean().optional(),
    ownersCursor: LedgerCursorSchema.optional(),
  }),
);
export type LedgerSearchEntriesParams = z.output<
  typeof LedgerSearchEntriesParamsSchema
>;

export const LedgerSearchEntriesToolInputSchema =
  LedgerSearchEntriesParamsSchema;
export type LedgerSearchEntriesToolInput = z.output<
  typeof LedgerSearchEntriesToolInputSchema
>;
