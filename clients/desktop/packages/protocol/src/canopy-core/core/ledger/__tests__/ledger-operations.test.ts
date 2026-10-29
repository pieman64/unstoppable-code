import {
  CORE_INSTRUCTION_DEFINITIONS,
  CORE_QUERY_DEFINITIONS,
} from '../../registry';
import {
  LEDGER_INSTRUCTION_DEFINITIONS,
  LEDGER_GRANTS,
  LEDGER_QUERY_DEFINITIONS,
  LEDGER_WRITER_REFRESH_RESOURCE,
  LedgerChangesListParamsSchema,
  LedgerChangesListResultSchema,
  LedgerCommandErrorSchema,
  LedgerEntriesSearchParamsSchema,
  LedgerEntriesSearchResultSchema,
  LedgerEntryAddParamsSchema,
  LedgerEntryAddResultSchema,
  LedgerEntryGetParamsSchema,
  LedgerEntryGetResultSchema,
  LedgerEntryUpdateParamsSchema,
  LedgerEntryUpdateResultSchema,
  LedgerOwnersListParamsSchema,
  LedgerOwnersListResultSchema,
  LedgerQueryErrorSchema,
  LedgerSummaryPublishParamsSchema,
  LedgerSummaryPublishResultSchema,
} from '../operations';
import {
  LedgerEntrySchema,
  toLedgerEntrySearchItem,
  type LedgerEntry,
} from '../schemas';

const entryId = '00000000-0000-4000-8000-000000000001';
const ledgerId = '00000000-0000-4000-8000-000000000002';
const actorId = '00000000-0000-4000-8000-000000000003';
const timestamp = '2026-09-26T00:00:00.000Z';

const author = {
  actorId,
  kind: 'chat',
  authorityId: 'local-authority',
} as const;

const ledgerEntry: LedgerEntry = {
  schemaVersion: 1,
  entryId,
  scope: {
    ledgerId,
    authorityId: 'local-authority',
    container: {
      kind: 'code_worktree',
      workspaceId: 'workspace-1',
      worktreeId: 'worktree-1',
    },
  },
  createdAt: timestamp,
  updatedAt: timestamp,
  revision: 1,
  author,
  authorDetails: {
    harness: null,
    model: null,
    thinkingEffort: null,
    mode: null,
    pipelineExecutionId: null,
    settingsRevision: null,
    unavailableReason: null,
  },
  owner: author,
  type: 'TASK',
  title: 'A ledger task',
  content: 'Task details',
  highlights: [],
  referenceFiles: [],
  status: 'TODO',
  origin: {
    kind: 'chat',
    ledgerId,
    chatId: 'chat-1',
  },
  attribution: {
    kind: 'self_reported',
    effectiveActor: author,
    recordedBy: author,
    executorDetails: {
      harness: null,
      model: null,
      thinkingEffort: null,
      mode: null,
      pipelineExecutionId: null,
      settingsRevision: null,
      unavailableReason: null,
    },
  },
};

const commandReceipt = {
  entry: ledgerEntry,
  changed: false,
  mutationId: null,
  localSequence: '0',
  syncState: 'local_only',
};

describe('Agent Ledger operations', () => {
  it('registers exactly the seven ledger operations with their metadata', () => {
    const queryNames = [
      'core.ledger.entries.search',
      'core.ledger.entry.get',
      'core.ledger.owners.list',
      'core.ledger.changes.list',
    ];
    const commandNames = [
      'core.ledger.entry.add',
      'core.ledger.entry.update',
      'core.ledger.summary.publish',
    ];

    expect(Object.keys(LEDGER_QUERY_DEFINITIONS)).toEqual(queryNames);
    expect(Object.keys(LEDGER_INSTRUCTION_DEFINITIONS)).toEqual(commandNames);
    // The core registries also hold other domains' operations.
    expect(
      Object.keys(CORE_QUERY_DEFINITIONS).filter((name) =>
        name.startsWith('core.ledger.'),
      ),
    ).toEqual(queryNames);
    expect(
      Object.keys(CORE_INSTRUCTION_DEFINITIONS).filter((name) =>
        name.startsWith('core.ledger.'),
      ),
    ).toEqual(commandNames);

    for (const definition of Object.values(LEDGER_QUERY_DEFINITIONS)) {
      expect(definition).toMatchObject({
        kind: 'query',
        plane: 'core',
        domain: 'ledger',
        version: 1,
        placement: 'core-only',
        idempotency: 'inherent',
        requiredGrants: [LEDGER_GRANTS.read],
      });
    }

    expect(
      LEDGER_INSTRUCTION_DEFINITIONS['core.ledger.entry.add'],
    ).toMatchObject({
      kind: 'instruction',
      plane: 'core',
      domain: 'ledger',
      version: 1,
      placement: 'core-only',
      idempotency: 'keyed',
      requiredGrants: [LEDGER_GRANTS.write],
    });
    expect(
      LEDGER_INSTRUCTION_DEFINITIONS['core.ledger.entry.update'],
    ).toMatchObject({
      kind: 'instruction',
      plane: 'core',
      domain: 'ledger',
      version: 1,
      placement: 'core-only',
      idempotency: 'keyed',
      requiredGrants: [LEDGER_GRANTS.write],
    });
    expect(
      LEDGER_INSTRUCTION_DEFINITIONS['core.ledger.summary.publish'],
    ).toMatchObject({
      kind: 'instruction',
      plane: 'core',
      domain: 'ledger',
      version: 1,
      placement: 'core-only',
      idempotency: 'keyed',
      requiredGrants: [LEDGER_GRANTS.publishSummary],
    });
  });

  it('strictly validates minimal params for every operation', () => {
    const searchParams = {};
    expect(
      LedgerEntriesSearchParamsSchema.safeParse(searchParams).success,
    ).toBe(true);
    expect(
      LedgerEntriesSearchParamsSchema.safeParse({ unexpected: true }).success,
    ).toBe(false);

    const getParams = { entryId };
    expect(LedgerEntryGetParamsSchema.safeParse(getParams).success).toBe(true);
    expect(
      LedgerEntryGetParamsSchema.safeParse({ ...getParams, unexpected: true })
        .success,
    ).toBe(false);

    const ownersParams = {};
    expect(LedgerOwnersListParamsSchema.safeParse(ownersParams).success).toBe(
      true,
    );
    expect(
      LedgerOwnersListParamsSchema.safeParse({ unexpected: true }).success,
    ).toBe(false);

    const changesParams = { afterSequence: '0' };
    expect(LedgerChangesListParamsSchema.safeParse(changesParams).success).toBe(
      true,
    );
    expect(
      LedgerChangesListParamsSchema.safeParse({
        ...changesParams,
        unexpected: true,
      }).success,
    ).toBe(false);

    const addParams = {
      type: 'TASK',
      title: 'A task',
      content: 'Task details',
      _meta: { idempotencyKey: 'ledger-add-1' },
    };
    expect(LedgerEntryAddParamsSchema.safeParse(addParams).success).toBe(true);
    // A keyed instruction's wire params carry its idempotency key.
    expect(
      LedgerEntryAddParamsSchema.safeParse({ ...addParams, _meta: {} }).success,
    ).toBe(false);
    expect(
      LedgerEntryAddParamsSchema.safeParse({ ...addParams, unexpected: true })
        .success,
    ).toBe(false);

    const updateParams = {
      entryId,
      expectedRevision: 1,
      status: 'TODO',
      _meta: { idempotencyKey: 'ledger-update-1' },
    };
    expect(LedgerEntryUpdateParamsSchema.safeParse(updateParams).success).toBe(
      true,
    );
    expect(
      LedgerEntryUpdateParamsSchema.safeParse({
        ...updateParams,
        unexpected: true,
      }).success,
    ).toBe(false);
    expect(
      LedgerEntryUpdateParamsSchema.safeParse({
        ...updateParams,
        content: 'Not an update field',
      }).success,
    ).toBe(false);

    const summaryParams = {
      snapshotId: 'snapshot-1',
      generationId: 'generation-1',
      title: 'Summary title',
      content: 'Summary content',
      sourceTruncated: false,
      _meta: { idempotencyKey: 'summary:ledger:snapshot-1' },
    };
    expect(
      LedgerSummaryPublishParamsSchema.safeParse(summaryParams).success,
    ).toBe(true);
    expect(
      LedgerSummaryPublishParamsSchema.safeParse({
        ...summaryParams,
        unexpected: true,
      }).success,
    ).toBe(false);
    expect(
      LedgerSummaryPublishParamsSchema.safeParse({
        snapshotId: 'snapshot-1',
        generationId: 'generation-1',
        title: 'Summary title',
        content: 'Summary content',
        _meta: { idempotencyKey: 'summary:ledger:snapshot-1' },
      }).success,
    ).toBe(false);
  });

  it('restricts errors to retry directives allowed by operation kind', () => {
    expect(
      LedgerCommandErrorSchema.safeParse({
        kind: 'capability_unavailable',
        message: 'x',
        code: 'core.ledger.writerUnavailable',
        details: { reason: 'WRITER_UNAVAILABLE' },
        retry: {
          kind: 'after_refresh',
          resource: LEDGER_WRITER_REFRESH_RESOURCE,
        },
      }).success,
    ).toBe(true);
    expect(
      LedgerCommandErrorSchema.safeParse({
        kind: 'capability_unavailable',
        message: 'x',
        code: 'core.ledger.writerUnavailable',
        details: { reason: 'WRITER_UNAVAILABLE' },
        retry: { kind: 'same_request' },
      }).success,
    ).toBe(false);
    expect(
      LedgerQueryErrorSchema.safeParse({
        kind: 'unavailable',
        message: 'x',
        retry: { kind: 'same_idempotency_key' },
      }).success,
    ).toBe(false);
  });

  it('declares every instruction keyed, so each call needs an idempotency key', () => {
    for (const definition of Object.values(LEDGER_INSTRUCTION_DEFINITIONS)) {
      expect(definition).toMatchObject({
        kind: 'instruction',
        idempotency: 'keyed',
      });
    }
  });

  it('parses minimal result fixtures for every operation', () => {
    expect(
      LedgerEntriesSearchResultSchema.parse({
        entries: [
          {
            ...toLedgerEntrySearchItem(ledgerEntry, 'available'),
            titlePending: true,
          },
        ],
        nextCursor: null,
        hasMore: false,
        watermark: '0',
      }),
    ).toMatchObject({
      entries: [
        { entryId, sourceAvailability: 'available', titlePending: true },
      ],
    });

    expect(
      LedgerEntryGetResultSchema.parse({
        entry: ledgerEntry,
        sourceAvailability: 'available',
        history: null,
        titlePending: true,
      }),
    ).toMatchObject({ entry: { entryId }, history: null, titlePending: true });
    expect(
      LedgerEntryGetResultSchema.safeParse({
        entry: { ...ledgerEntry, titlePending: true },
        sourceAvailability: 'available',
        history: null,
      }).success,
    ).toBe(false);
    expect(
      LedgerEntrySchema.safeParse({ ...ledgerEntry, titlePending: true })
        .success,
    ).toBe(false);

    // A reader on the owning device also reports how far the mirror is.
    expect(
      LedgerEntriesSearchResultSchema.parse({
        entries: [toLedgerEntrySearchItem(ledgerEntry, 'available', 'pending')],
        nextCursor: null,
        hasMore: false,
        watermark: '0',
        scopeSync: { audienceChangePending: true },
      }),
    ).toMatchObject({
      entries: [{ syncState: 'pending' }],
      scopeSync: { audienceChangePending: true },
    });
    expect(
      LedgerEntryGetResultSchema.parse({
        entry: ledgerEntry,
        sourceAvailability: 'available',
        history: null,
        syncState: 'mirrored',
      }),
    ).toMatchObject({ syncState: 'mirrored' });
    for (const result of [
      {
        entries: [],
        nextCursor: null,
        hasMore: false,
        watermark: '0',
        scopeSync: { audienceChangePending: true, audience: 'organization' },
      },
      {
        entries: [],
        nextCursor: null,
        hasMore: false,
        watermark: '0',
        scopeSync: {},
      },
    ]) {
      expect(LedgerEntriesSearchResultSchema.safeParse(result).success).toBe(
        false,
      );
    }

    expect(
      LedgerOwnersListResultSchema.parse({
        candidates: [],
        nextCursor: null,
      }),
    ).toEqual({ candidates: [], nextCursor: null });

    expect(
      LedgerChangesListResultSchema.parse({
        changes: [],
        nextSequence: '0',
        hasMore: false,
      }),
    ).toEqual({ changes: [], nextSequence: '0', hasMore: false });

    expect(LedgerEntryAddResultSchema.parse(commandReceipt)).toMatchObject({
      entry: { entryId },
      syncState: 'local_only',
    });
    expect(LedgerEntryUpdateResultSchema.parse(commandReceipt)).toMatchObject({
      entry: { entryId },
      syncState: 'local_only',
    });
    expect(
      LedgerSummaryPublishResultSchema.parse(commandReceipt),
    ).toMatchObject({ entry: { entryId }, syncState: 'local_only' });
  });
});
