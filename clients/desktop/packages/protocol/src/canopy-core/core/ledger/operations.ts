import { z } from 'zod';

import { CanopyRequestMetadataSchema } from '../../common';
import { defineCanopyInstruction, defineCanopyQuery } from '../../definitions';
import {
  CanopyErrorPayloadSchema,
  CanopyKeyedRetryDirectiveSchema,
  CanopyQueryRetryDirectiveSchema,
} from '../../errors';
import { LEDGER_LIMITS } from './limits';
import {
  LedgerActorLabelSchema,
  LedgerActorRefSchema,
  LedgerAddEntryParamsObjectSchema,
  LedgerCommandReceiptSchema,
  LedgerContentSchema,
  LedgerCursorSchema,
  LedgerEntrySchema,
  LedgerEntrySearchItemSchema,
  LedgerErrorCodeSchema,
  LedgerErrorDetailsSchema,
  LedgerHighlightSchema,
  LedgerMutationSchema,
  LedgerOpaqueIdSchema,
  LedgerOwnerCandidatePageSchema,
  LedgerRollupScopeSchema,
  LedgerSearchEntriesParamsSchema,
  LedgerSequenceSchema,
  LedgerSourceAvailabilitySchema,
  LedgerStatusSchema,
  LedgerSyncStateSchema,
  LedgerTitleSchema,
  LedgerUpdateEntryParamsObjectSchema,
  LedgerUuidSchema,
  ledgerCoreUpdateHasMutation,
  limitLedgerRequest,
} from './schemas';

export const LEDGER_GRANTS = {
  read: 'core.ledger.read',
  write: 'core.ledger.write',
  publishSummary: 'core.ledger.publishSummary',
} as const;

export const LEDGER_WRITER_REFRESH_RESOURCE = 'core.ledger';

export const LedgerQueryErrorSchema = CanopyErrorPayloadSchema.extend({
  code: LedgerErrorCodeSchema.optional(),
  details: LedgerErrorDetailsSchema.optional(),
  retry: CanopyQueryRetryDirectiveSchema,
});

export const LedgerCommandErrorSchema = CanopyErrorPayloadSchema.extend({
  code: LedgerErrorCodeSchema.optional(),
  details: LedgerErrorDetailsSchema.optional(),
  retry: CanopyKeyedRetryDirectiveSchema,
});

export const LedgerEntriesSearchParamsSchema = LedgerSearchEntriesParamsSchema;
export type LedgerEntriesSearchParams = z.output<
  typeof LedgerEntriesSearchParamsSchema
>;

/** How a scope's own sync stands, beyond each entry's state. */
export const LedgerScopeSyncSchema = z.strictObject({
  /** A change of who may read the scope has not reached the mirror yet. */
  audienceChangePending: z.boolean(),
});
export type LedgerScopeSync = z.output<typeof LedgerScopeSyncSchema>;

export const LedgerEntriesSearchResultSchema = z.strictObject({
  entries: z
    .array(LedgerEntrySearchItemSchema)
    .max(LEDGER_LIMITS.searchPageMax),
  nextCursor: LedgerCursorSchema.nullable(),
  hasMore: z.boolean(),
  watermark: LedgerSequenceSchema,
  owners: LedgerOwnerCandidatePageSchema.optional(),
  /** Labels for the authors and owners of the returned entries. */
  actors: z
    .array(LedgerActorLabelSchema)
    .max(LEDGER_LIMITS.actorLabelsMax)
    .optional(),
  /** Reported by the device that owns the scope. */
  scopeSync: LedgerScopeSyncSchema.optional(),
});
export type LedgerEntriesSearchResult = z.output<
  typeof LedgerEntriesSearchResultSchema
>;

export const LedgerEntryGetParamsSchema = limitLedgerRequest(
  z.strictObject({
    entryId: LedgerUuidSchema,
    includeHistory: z.boolean().optional(),
    historyLimit: z.int().min(1).max(LEDGER_LIMITS.historyPageMax).optional(),
    historyCursor: LedgerCursorSchema.optional(),
  }),
);
export type LedgerEntryGetParams = z.output<typeof LedgerEntryGetParamsSchema>;

export const LedgerEntryGetResultSchema = z.strictObject({
  entry: LedgerEntrySchema,
  sourceAvailability: LedgerSourceAvailabilitySchema,
  /** Local-only state; the canonical entry and mirror never carry it. */
  titlePending: z.literal(true).optional(),
  history: z
    .strictObject({
      mutations: z
        .array(LedgerMutationSchema)
        .max(LEDGER_LIMITS.historyPageMax),
      nextCursor: LedgerCursorSchema.nullable(),
    })
    .nullable(),
  /** Labels for every actor the entry and the returned history name. */
  actors: z
    .array(LedgerActorLabelSchema)
    .max(LEDGER_LIMITS.actorLabelsMax)
    .optional(),
  /** Whether the entry's current revision has reached the mirror. */
  syncState: LedgerSyncStateSchema.optional(),
});
export type LedgerEntryGetResult = z.output<typeof LedgerEntryGetResultSchema>;

export const LedgerOwnersListParamsSchema = limitLedgerRequest(
  z
    .strictObject({
      limit: z.int().min(1).max(LEDGER_LIMITS.ownersPageMax).optional(),
      cursor: LedgerCursorSchema.optional(),
      delegationId: z.string().min(1).max(128).optional(),
    })
    .refine(
      (params) =>
        params.delegationId === undefined || params.cursor === undefined,
      {
        message: 'An exact delegation filter cannot be combined with a cursor',
        path: ['cursor'],
      },
    ),
);
export type LedgerOwnersListParams = z.output<
  typeof LedgerOwnersListParamsSchema
>;

export const LedgerOwnersListResultSchema = LedgerOwnerCandidatePageSchema;
export type LedgerOwnersListResult = z.output<
  typeof LedgerOwnersListResultSchema
>;

export const LedgerChangesListParamsSchema = limitLedgerRequest(
  z.strictObject({
    afterSequence: LedgerSequenceSchema,
    limit: z.int().min(1).max(LEDGER_LIMITS.changesPageMax).optional(),
  }),
);
export type LedgerChangesListParams = z.output<
  typeof LedgerChangesListParamsSchema
>;

export const LedgerChangesListResultSchema = z.strictObject({
  changes: z
    .array(
      z.strictObject({
        sequence: LedgerSequenceSchema,
        entryId: LedgerUuidSchema,
        revision: z.int().min(1),
      }),
    )
    .max(LEDGER_LIMITS.changesPageMax),
  nextSequence: LedgerSequenceSchema,
  hasMore: z.boolean(),
});
export type LedgerChangesListResult = z.output<
  typeof LedgerChangesListResultSchema
>;

export const LedgerRollupsListParamsSchema = limitLedgerRequest(
  z.strictObject({
    ledgerIds: z
      .array(LedgerUuidSchema)
      .min(1)
      .max(LEDGER_LIMITS.rollupsLedgerIdsMax),
    cursor: LedgerCursorSchema.optional(),
  }),
);
export type LedgerRollupsListParams = z.output<
  typeof LedgerRollupsListParamsSchema
>;

export const LedgerRollupsListResultSchema = z
  .strictObject({
    scopes: z.array(LedgerRollupScopeSchema),
    nextCursor: LedgerCursorSchema.optional(),
  })
  .superRefine((result, context): void => {
    const itemCount = result.scopes.reduce(
      (count, scope): number => count + scope.items.length,
      0,
    );
    if (itemCount > LEDGER_LIMITS.rollupsPageMax) {
      context.addIssue({
        code: 'custom',
        message: `Rollup pages may contain at most ${LEDGER_LIMITS.rollupsPageMax} items`,
        path: ['scopes'],
      });
    }
  });
export type LedgerRollupsListResult = z.output<
  typeof LedgerRollupsListResultSchema
>;

/**
 * A managed delegation's work in the caller's ledger: every entry it or one of
 * its own delegates (at any depth) authored or owns, or owned until its
 * session ended and the sweep handed it back. The Ledger expands the
 * delegation's descendants and maps them to its actors.
 */
export const LedgerWorkSummaryGetParamsSchema = limitLedgerRequest(
  z.strictObject({
    delegationId: z.string().min(1).max(128),
  }),
);
export type LedgerWorkSummaryGetParams = z.output<
  typeof LedgerWorkSummaryGetParamsSchema
>;

export const LedgerWorkSummaryOpenEntrySchema = z.strictObject({
  entryId: LedgerUuidSchema,
  status: LedgerStatusSchema,
  owner: LedgerActorRefSchema,
});
export type LedgerWorkSummaryOpenEntry = z.output<
  typeof LedgerWorkSummaryOpenEntrySchema
>;

export const LedgerWorkSummaryGetResultSchema = z.strictObject({
  /** Entries by status; a status with none is left out. */
  counts: z.partialRecord(LedgerStatusSchema, z.int().min(1)),
  /** Open entries, most recently updated first; titles stay out. */
  open: z
    .array(LedgerWorkSummaryOpenEntrySchema)
    .max(LEDGER_LIMITS.workSummaryOpenEntriesMax),
  /** Every open entry, including those `open` leaves out. */
  openTotal: z.int().min(0),
});
export type LedgerWorkSummaryGetResult = z.output<
  typeof LedgerWorkSummaryGetResultSchema
>;

/**
 * Keyed instructions carry their idempotency key in `_meta`, as the operation
 * catalog's wire request does. Callers also pass it as request metadata, which
 * the dispatcher requires.
 */
export const LedgerKeyedRequestMetadataSchema =
  CanopyRequestMetadataSchema.required({ idempotencyKey: true });

export const LedgerEntryAddParamsSchema = limitLedgerRequest(
  LedgerAddEntryParamsObjectSchema.extend({
    _meta: LedgerKeyedRequestMetadataSchema,
  }),
);
export type LedgerEntryAddParams = z.output<typeof LedgerEntryAddParamsSchema>;

export const LedgerEntryAddResultSchema = LedgerCommandReceiptSchema;
export type LedgerEntryAddResult = z.output<typeof LedgerEntryAddResultSchema>;

export const LedgerEntryUpdateParamsSchema = limitLedgerRequest(
  LedgerUpdateEntryParamsObjectSchema.extend({
    _meta: LedgerKeyedRequestMetadataSchema,
  }).refine(
    ledgerCoreUpdateHasMutation,
    'At least one of status, owner or parentEntryId is required',
  ),
);
export type LedgerEntryUpdateParams = z.output<
  typeof LedgerEntryUpdateParamsSchema
>;

export const LedgerEntryUpdateResultSchema = LedgerCommandReceiptSchema;
export type LedgerEntryUpdateResult = z.output<
  typeof LedgerEntryUpdateResultSchema
>;

const LedgerSummaryPublishObjectSchema = z.strictObject({
  snapshotId: LedgerOpaqueIdSchema,
  generationId: LedgerOpaqueIdSchema,
  title: LedgerTitleSchema,
  content: LedgerContentSchema,
  highlights: z
    .array(LedgerHighlightSchema)
    .max(LEDGER_LIMITS.highlightsMax)
    .optional(),
  sourceTruncated: z.boolean(),
  summaryArtifactId: LedgerOpaqueIdSchema.optional(),
  observedTaskId: LedgerOpaqueIdSchema.optional(),
});

/** A Summary publication as the store records it, without request metadata. */
export const LedgerPublishSummaryParamsSchema = limitLedgerRequest(
  LedgerSummaryPublishObjectSchema,
);
export type LedgerPublishSummaryParams = z.output<
  typeof LedgerPublishSummaryParamsSchema
>;

export const LedgerSummaryPublishParamsSchema = limitLedgerRequest(
  LedgerSummaryPublishObjectSchema.extend({
    _meta: LedgerKeyedRequestMetadataSchema,
  }),
);
export type LedgerSummaryPublishParams = z.output<
  typeof LedgerSummaryPublishParamsSchema
>;

export const LedgerSummaryPublishResultSchema = LedgerCommandReceiptSchema;
export type LedgerSummaryPublishResult = z.output<
  typeof LedgerSummaryPublishResultSchema
>;

export const LEDGER_QUERY_DEFINITIONS = {
  'core.ledger.entries.search': defineCanopyQuery({
    plane: 'core',
    domain: 'ledger',
    version: 1,
    placement: 'core-only',
    params: LedgerEntriesSearchParamsSchema,
    result: LedgerEntriesSearchResultSchema,
    error: LedgerQueryErrorSchema,
    idempotency: 'inherent',
    requiredGrants: [LEDGER_GRANTS.read],
  }),
  'core.ledger.entry.get': defineCanopyQuery({
    plane: 'core',
    domain: 'ledger',
    version: 1,
    placement: 'core-only',
    params: LedgerEntryGetParamsSchema,
    result: LedgerEntryGetResultSchema,
    error: LedgerQueryErrorSchema,
    idempotency: 'inherent',
    requiredGrants: [LEDGER_GRANTS.read],
  }),
  'core.ledger.owners.list': defineCanopyQuery({
    plane: 'core',
    domain: 'ledger',
    version: 1,
    placement: 'core-only',
    params: LedgerOwnersListParamsSchema,
    result: LedgerOwnersListResultSchema,
    error: LedgerQueryErrorSchema,
    idempotency: 'inherent',
    requiredGrants: [LEDGER_GRANTS.read],
  }),
  'core.ledger.changes.list': defineCanopyQuery({
    plane: 'core',
    domain: 'ledger',
    version: 1,
    placement: 'core-only',
    params: LedgerChangesListParamsSchema,
    result: LedgerChangesListResultSchema,
    error: LedgerQueryErrorSchema,
    idempotency: 'inherent',
    requiredGrants: [LEDGER_GRANTS.read],
  }),
  'core.ledger.rollups.list': defineCanopyQuery({
    plane: 'core',
    domain: 'ledger',
    version: 1,
    placement: 'core-only',
    params: LedgerRollupsListParamsSchema,
    result: LedgerRollupsListResultSchema,
    error: LedgerQueryErrorSchema,
    idempotency: 'inherent',
    requiredGrants: [LEDGER_GRANTS.read],
  }),
  'core.ledger.workSummary.get': defineCanopyQuery({
    plane: 'core',
    domain: 'ledger',
    version: 1,
    placement: 'core-only',
    params: LedgerWorkSummaryGetParamsSchema,
    result: LedgerWorkSummaryGetResultSchema,
    error: LedgerQueryErrorSchema,
    idempotency: 'inherent',
    requiredGrants: [LEDGER_GRANTS.read],
  }),
};

export const LEDGER_INSTRUCTION_DEFINITIONS = {
  'core.ledger.entry.add': defineCanopyInstruction({
    plane: 'core',
    domain: 'ledger',
    version: 1,
    placement: 'core-only',
    params: LedgerEntryAddParamsSchema,
    result: LedgerEntryAddResultSchema,
    error: LedgerCommandErrorSchema,
    idempotency: 'keyed',
    requiredGrants: [LEDGER_GRANTS.write],
  }),
  'core.ledger.entry.update': defineCanopyInstruction({
    plane: 'core',
    domain: 'ledger',
    version: 1,
    placement: 'core-only',
    params: LedgerEntryUpdateParamsSchema,
    result: LedgerEntryUpdateResultSchema,
    error: LedgerCommandErrorSchema,
    idempotency: 'keyed',
    requiredGrants: [LEDGER_GRANTS.write],
  }),
  'core.ledger.summary.publish': defineCanopyInstruction({
    plane: 'core',
    domain: 'ledger',
    version: 1,
    placement: 'core-only',
    params: LedgerSummaryPublishParamsSchema,
    result: LedgerSummaryPublishResultSchema,
    error: LedgerCommandErrorSchema,
    idempotency: 'keyed',
    requiredGrants: [LEDGER_GRANTS.publishSummary],
  }),
};
