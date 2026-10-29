import type { ZodType } from 'zod';

import { CanopyKeyedRetryDirectiveSchema } from '../../../errors';
import {
  countCodePoints,
  isPortableRelativePath,
  isSameLedgerPipelinePause,
  isWithinLedgerRequestLimit,
  LEDGER_ERROR_CODES,
  LEDGER_SOURCE_KINDS,
  LEDGER_SYNC_STATES,
  LedgerAddEntryParamsSchema,
  LedgerActorRefSchema,
  LedgerAddEntryToolInputSchema,
  LedgerContentSchema,
  LedgerDisplayNameSchema,
  LedgerEntrySchema,
  LedgerEntrySearchItemSchema,
  LedgerErrorCodeSchema,
  LedgerFilePathSchema,
  LedgerHighlightSchema,
  LedgerOpaqueIdSchema,
  LedgerSearchEntriesParamsSchema,
  LedgerSearchQuerySchema,
  LedgerTitleSchema,
  LedgerUpdateEntryParamsSchema,
  normalizeLedgerFileRefs,
  ledgerSourceKindOfOrigin,
  toLedgerEntrySearchItem,
  type LedgerActorRef,
  type LedgerAddEntryParams,
  type LedgerEntry,
  type LedgerFileRef,
} from '../index';

const TEXT_LIMIT_CASES: readonly {
  name: string;
  schema: ZodType<string>;
  atLimit: string;
  overLimit: string;
}[] = [
  {
    name: 'title',
    schema: LedgerTitleSchema,
    atLimit: 't'.repeat(100),
    overLimit: 't'.repeat(101),
  },
  {
    name: 'content',
    schema: LedgerContentSchema,
    atLimit: 'c'.repeat(1_000),
    overLimit: 'c'.repeat(1_001),
  },
  {
    name: 'highlight',
    schema: LedgerHighlightSchema,
    atLimit: 'h'.repeat(100),
    overLimit: 'h'.repeat(101),
  },
];

const VALID_ADD_PARAMS = {
  type: 'TASK',
  title: 'A task',
  content: 'Task description',
} satisfies LedgerAddEntryParams;

const VALID_ACTOR: LedgerActorRef = {
  actorId: '22222222-2222-4222-8222-222222222222',
  kind: 'user',
  authorityId: 'authority-1',
};

const OTHER_ACTOR: LedgerActorRef = {
  actorId: '33333333-3333-4333-8333-333333333333',
  kind: 'user',
  authorityId: 'authority-1',
};

const VALID_FILE_REF: LedgerFileRef = {
  rootId: 'root-1',
  path: 'src/app.ts',
};

const VALID_ENTRY = {
  schemaVersion: 1,
  entryId: '11111111-1111-4111-8111-111111111111',
  scope: {
    ledgerId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    authorityId: 'authority-1',
    container: {
      kind: 'code_worktree',
      workspaceId: 'workspace-1',
      worktreeId: 'worktree-1',
    },
  },
  createdAt: '2026-09-26T12:00:00.000Z',
  updatedAt: '2026-09-26T12:00:00.000Z',
  revision: 1,
  author: VALID_ACTOR,
  authorDetails: {
    harness: null,
    model: null,
    thinkingEffort: null,
    mode: null,
    pipelineExecutionId: null,
    settingsRevision: null,
    unavailableReason: null,
  },
  owner: VALID_ACTOR,
  type: 'TASK',
  title: 'A task',
  content: 'Task description',
  highlights: [],
  referenceFiles: [VALID_FILE_REF],
  status: 'TODO',
  origin: {
    kind: 'chat',
    ledgerId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    chatId: 'chat-1',
  },
  attribution: {
    kind: 'self_reported',
    effectiveActor: VALID_ACTOR,
    recordedBy: VALID_ACTOR,
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
} satisfies LedgerEntry;

describe('Agent Ledger strict v1 contracts', () => {
  describe('text limits', () => {
    it.each(TEXT_LIMIT_CASES)(
      '$name accepts its code-point limit and rejects one beyond it',
      ({
        schema,
        atLimit,
        overLimit,
      }: (typeof TEXT_LIMIT_CASES)[number]): void => {
        expect(schema.safeParse(atLimit).success).toBe(true);
        expect(schema.safeParse(overLimit).success).toBe(false);
      },
    );

    it('counts Unicode code points rather than UTF-16 units', (): void => {
      expect(LedgerTitleSchema.safeParse('😀'.repeat(100)).success).toBe(true);
      expect(LedgerTitleSchema.safeParse('😀'.repeat(101)).success).toBe(false);
      expect(countCodePoints('e\u0301')).toBe(2);
      expect(LedgerTitleSchema.safeParse('e\u0301'.repeat(51)).success).toBe(
        false,
      );
    });

    it('enforces highlight and reference array limits', (): void => {
      const fiveHighlights = Array.from(
        { length: 5 },
        (_value: unknown, index: number): string => `Highlight ${index}`,
      );
      const sixHighlights = [...fiveHighlights, 'Highlight 5'];
      const twentyFiveReferences = Array.from(
        { length: 25 },
        (_value: unknown, index: number): LedgerFileRef => ({
          rootId: `root-${index}`,
          path: `src/${index}.ts`,
        }),
      );
      const twentySixReferences = [
        ...twentyFiveReferences,
        { rootId: 'root-25', path: 'src/25.ts' },
      ];

      expect(
        LedgerAddEntryParamsSchema.safeParse({
          ...VALID_ADD_PARAMS,
          highlights: fiveHighlights,
        }).success,
      ).toBe(true);
      expect(
        LedgerAddEntryParamsSchema.safeParse({
          ...VALID_ADD_PARAMS,
          highlights: sixHighlights,
        }).success,
      ).toBe(false);
      expect(
        LedgerAddEntryParamsSchema.safeParse({
          ...VALID_ADD_PARAMS,
          referenceFiles: twentyFiveReferences,
        }).success,
      ).toBe(true);
      expect(
        LedgerAddEntryParamsSchema.safeParse({
          ...VALID_ADD_PARAMS,
          referenceFiles: twentySixReferences,
        }).success,
      ).toBe(false);
    });

    it('trims display text and rejects empty text and controls', (): void => {
      expect(LedgerTitleSchema.parse('  Task title  ')).toBe('Task title');
      expect(LedgerTitleSchema.safeParse('   ').success).toBe(false);
      expect(LedgerTitleSchema.safeParse('Task\nTitle').success).toBe(false);
      expect(LedgerTitleSchema.safeParse('Task\tTitle').success).toBe(false);
      expect(LedgerHighlightSchema.safeParse('Task\nTitle').success).toBe(
        false,
      );
      expect(LedgerHighlightSchema.safeParse('Task\tTitle').success).toBe(
        false,
      );
      expect(LedgerContentSchema.safeParse('first\nsecond').success).toBe(true);
      expect(LedgerContentSchema.safeParse('first\tsecond').success).toBe(true);
      expect(LedgerContentSchema.safeParse('before\u0000after').success).toBe(
        false,
      );
      for (const schema of [
        LedgerTitleSchema,
        LedgerContentSchema,
        LedgerHighlightSchema,
        LedgerDisplayNameSchema,
        LedgerSearchQuerySchema,
        LedgerFilePathSchema,
      ]) {
        expect(schema.safeParse('before\u0000after').success).toBe(false);
      }
    });
  });

  describe('file paths', () => {
    it.each([
      '/absolute/path',
      'C:/x',
      '\\\\server\\share',
      'src\\app.ts',
      'src/../app.ts',
      './app.ts',
      'src//app.ts',
      'src/',
      'src/\u0000app.ts',
    ])('rejects a non-portable path: %s', (path: string): void => {
      expect(isPortableRelativePath(path)).toBe(false);
      expect(LedgerFilePathSchema.safeParse(path).success).toBe(false);
    });

    it('accepts normalized relative POSIX paths', (): void => {
      expect(isPortableRelativePath('src/app.ts')).toBe(true);
      expect(LedgerFilePathSchema.parse('src/app.ts')).toBe('src/app.ts');
    });
  });

  describe('strict operation inputs', () => {
    it('rejects unknown keys and host-populated Add overrides', (): void => {
      expect(
        LedgerAddEntryParamsSchema.safeParse({
          ...VALID_ADD_PARAMS,
          extra: true,
        }).success,
      ).toBe(false);
      expect(
        LedgerAddEntryParamsSchema.safeParse({
          ...VALID_ADD_PARAMS,
          type: 'SUMMARY',
        }).success,
      ).toBe(false);

      const addOverrides: readonly { field: string; input: unknown }[] = [
        {
          field: 'author',
          input: { ...VALID_ADD_PARAMS, author: VALID_ACTOR },
        },
        {
          field: 'createdAt',
          input: { ...VALID_ADD_PARAMS, createdAt: '2026-09-26T12:00:00Z' },
        },
        {
          field: 'scope',
          input: {
            ...VALID_ADD_PARAMS,
            scope: {
              ledgerId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
              authorityId: 'authority-1',
              container: {
                kind: 'code_worktree',
                workspaceId: 'workspace-1',
                worktreeId: 'worktree-1',
              },
            },
          },
        },
        {
          field: 'attribution',
          input: {
            ...VALID_ADD_PARAMS,
            attribution: {
              kind: 'self_reported',
              effectiveActor: VALID_ACTOR,
              recordedBy: VALID_ACTOR,
              executorDetails: VALID_ENTRY.attribution.executorDetails,
            },
          },
        },
      ];

      for (const attempt of addOverrides) {
        expect(
          LedgerAddEntryParamsSchema.safeParse(attempt.input).success,
        ).toBe(false);
      }
    });

    it('keeps tool Add titles required while the person form may omit one', (): void => {
      const withoutTitle = {
        type: 'TASK',
        content: 'Task description',
      };
      expect(LedgerAddEntryParamsSchema.safeParse(withoutTitle).success).toBe(
        true,
      );
      expect(
        LedgerAddEntryToolInputSchema.safeParse(withoutTitle).success,
      ).toBe(false);
      expect(
        LedgerAddEntryToolInputSchema.safeParse({
          ...withoutTitle,
          title: 'A task',
        }).success,
      ).toBe(true);
    });

    it('rejects unknown keys and content fields on Update', (): void => {
      const validUpdate = {
        entryId: VALID_ENTRY.entryId,
        expectedRevision: 1,
        status: 'IN_PROGRESS',
      };
      expect(
        LedgerUpdateEntryParamsSchema.safeParse({
          ...validUpdate,
          extra: true,
        }).success,
      ).toBe(false);
      expect(
        LedgerUpdateEntryParamsSchema.safeParse({
          ...validUpdate,
          title: 'not editable here',
        }).success,
      ).toBe(false);
      expect(
        LedgerUpdateEntryParamsSchema.safeParse({
          ...validUpdate,
          content: 'not editable here',
        }).success,
      ).toBe(false);
      expect(
        LedgerUpdateEntryParamsSchema.safeParse({
          entryId: VALID_ENTRY.entryId,
          expectedRevision: 1,
        }).success,
      ).toBe(false);
    });

    it('rejects unknown Search keys and empty filter arrays', (): void => {
      expect(
        LedgerSearchEntriesParamsSchema.safeParse({ extra: true }).success,
      ).toBe(false);

      const emptyFilters: readonly string[] = [
        'entryIds',
        'types',
        'statuses',
        'attribution',
      ];
      for (const filter of emptyFilters) {
        expect(
          LedgerSearchEntriesParamsSchema.safeParse({ [filter]: [] }).success,
        ).toBe(false);
      }
    });
  });

  describe('entity constraints', () => {
    it('accepts a valid full entry fixture', (): void => {
      expect(LedgerActorRefSchema.safeParse(VALID_ACTOR).success).toBe(true);
      expect(LedgerEntrySchema.safeParse(VALID_ENTRY).success).toBe(true);
    });

    it('keeps pending-title state out of the canonical entry', (): void => {
      expect(
        LedgerEntrySchema.safeParse({ ...VALID_ENTRY, titlePending: true })
          .success,
      ).toBe(false);
    });

    it('rejects duplicate refs and author/attribution mismatches', (): void => {
      expect(
        LedgerEntrySchema.safeParse({
          ...VALID_ENTRY,
          referenceFiles: [VALID_FILE_REF, VALID_FILE_REF],
        }).success,
      ).toBe(false);
      expect(
        LedgerEntrySchema.safeParse({
          ...VALID_ENTRY,
          author: OTHER_ACTOR,
        }).success,
      ).toBe(false);
    });

    it('requires SUMMARY entries to have INFO status', (): void => {
      const summaryWithWrongStatus: LedgerEntry = {
        ...VALID_ENTRY,
        type: 'SUMMARY',
        status: 'TODO',
      };
      expect(LedgerEntrySchema.safeParse(summaryWithWrongStatus).success).toBe(
        false,
      );
    });
  });

  it('deduplicates file refs in first-seen order', (): void => {
    const refs: readonly LedgerFileRef[] = [
      VALID_FILE_REF,
      { ...VALID_FILE_REF },
      { ...VALID_FILE_REF, startLine: 2 },
    ];
    expect(normalizeLedgerFileRefs(refs)).toEqual([
      VALID_FILE_REF,
      { ...VALID_FILE_REF, startLine: 2 },
    ]);
  });

  it('enforces the inclusive UTF-8 request byte limit', (): void => {
    const atLimit = 'x'.repeat(131_070);
    const overLimit = 'x'.repeat(131_071);
    expect(isWithinLedgerRequestLimit(atLimit)).toBe(true);
    expect(isWithinLedgerRequestLimit(overLimit)).toBe(false);
    expect(isWithinLedgerRequestLimit(undefined)).toBe(false);
  });

  it('bounds opaque IDs in code points', (): void => {
    expect(LedgerOpaqueIdSchema.safeParse('😀'.repeat(512)).success).toBe(true);
    expect(LedgerOpaqueIdSchema.safeParse('😀'.repeat(513)).success).toBe(
      false,
    );
  });

  it('rejects an Add whose fields are valid but whose request is too large', (): void => {
    const largeReference: LedgerFileRef = {
      rootId: '😀'.repeat(512),
      path: '😀'.repeat(1_024),
    };
    const references = Array.from(
      { length: 25 },
      (_value: unknown, index: number): LedgerFileRef => ({
        ...largeReference,
        startLine: index + 1,
      }),
    );
    expect(
      LedgerAddEntryParamsSchema.safeParse({
        ...VALID_ADD_PARAMS,
        referenceFiles: [largeReference],
      }).success,
    ).toBe(true);
    expect(isWithinLedgerRequestLimit({ referenceFiles: references })).toBe(
      false,
    );
    expect(
      LedgerAddEntryParamsSchema.safeParse({
        ...VALID_ADD_PARAMS,
        referenceFiles: references,
      }).success,
    ).toBe(false);
  });

  it('rejects an oversized request before parsing its fields', (): void => {
    const result = LedgerAddEntryParamsSchema.safeParse({
      ...VALID_ADD_PARAMS,
      title: 't'.repeat(200_000),
      highlights: Array.from({ length: 10_000 }, (): string => 'h'),
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue): string => issue.message)).toEqual([
      'Request must be at most 131072 bytes',
    ]);
  });

  it('requires the author to match every effective actor field', (): void => {
    const mismatchedAuthors: LedgerActorRef[] = [
      { ...VALID_ACTOR, kind: 'chat' },
      { ...VALID_ACTOR, authorityId: 'authority-2' },
    ];
    for (const author of mismatchedAuthors) {
      expect(
        LedgerEntrySchema.safeParse({ ...VALID_ENTRY, author }).success,
      ).toBe(false);
    }
  });

  it('projects search items without provenance detail', (): void => {
    const item = toLedgerEntrySearchItem(VALID_ENTRY, 'available');
    expect(LedgerEntrySearchItemSchema.parse(item)).toEqual(item);
    expect(item).toMatchObject({
      entryId: VALID_ENTRY.entryId,
      revision: 1,
      attributionKind: 'self_reported',
      sourceAvailability: 'available',
    });
    expect(item).not.toHaveProperty('origin');
    expect(item).not.toHaveProperty('attribution');
    expect(item).not.toHaveProperty('authorDetails');
    expect(
      LedgerEntrySearchItemSchema.safeParse({ ...item, titlePending: true })
        .success,
    ).toBe(true);
    expect(
      LedgerEntrySearchItemSchema.safeParse({
        ...item,
        origin: VALID_ENTRY.origin,
      }).success,
    ).toBe(false);
  });

  it('names what an origin opens as, and carries it on a search item only when a host reports it', (): void => {
    const ledgerId = VALID_ENTRY.scope.ledgerId;
    const actorId = VALID_ENTRY.author.actorId;
    const delegation = {
      kind: 'managed_delegation',
      ledgerId,
      delegationId: 'delegation-1',
      parentActorId: actorId,
      runGeneration: 1,
    } as const;
    expect(
      ledgerSourceKindOfOrigin({ kind: 'chat', ledgerId, chatId: 'chat-1' }),
    ).toBe('chat');
    // A delegate's source is its root's: the chat or the run that started it.
    expect(
      ledgerSourceKindOfOrigin({
        ...delegation,
        root: { kind: 'chat', chatId: 'chat-1' },
      }),
    ).toBe('chat');
    expect(
      ledgerSourceKindOfOrigin({
        ...delegation,
        root: { kind: 'pipeline_agent', executionId: 'execution-1' },
      }),
    ).toBe('pipeline');
    expect(
      ledgerSourceKindOfOrigin({
        kind: 'pipeline_agent',
        ledgerId,
        executionId: 'execution-1',
        physicalJobId: 'build__1',
        logicalJobId: 'build',
        stepId: 'agent',
        attempt: 1,
        iteration: 0,
        agentSessionId: 'session-1',
      }),
    ).toBe('pipeline');
    expect(
      ledgerSourceKindOfOrigin({
        kind: 'summary',
        ledgerId,
        snapshotId: 'snapshot-1',
        generationId: 'generation-1',
        helperActorId: actorId,
      }),
    ).toBe('summary');
    expect(
      ledgerSourceKindOfOrigin({
        kind: 'user',
        ledgerId,
        userActorId: actorId,
      }),
    ).toBeUndefined();

    // The projection itself reports none: the mirror builds rows from it.
    const plain = toLedgerEntrySearchItem(VALID_ENTRY, 'available');
    expect(plain).not.toHaveProperty('sourceKind');
    for (const sourceKind of LEDGER_SOURCE_KINDS) {
      const item = { ...plain, sourceKind };
      expect(LedgerEntrySearchItemSchema.parse(item)).toEqual(item);
    }
    expect(
      LedgerEntrySearchItemSchema.safeParse({ ...plain, sourceKind: 'run' })
        .success,
    ).toBe(false);
  });

  it('carries a sync state only when the reader reports one', (): void => {
    const plain = toLedgerEntrySearchItem(VALID_ENTRY, 'available');
    expect(plain).not.toHaveProperty('syncState');

    for (const syncState of LEDGER_SYNC_STATES) {
      const item = toLedgerEntrySearchItem(VALID_ENTRY, 'available', syncState);
      expect(item.syncState).toBe(syncState);
      expect(LedgerEntrySearchItemSchema.parse(item)).toEqual(item);
    }
    expect(
      LedgerEntrySearchItemSchema.safeParse({ ...plain, syncState: 'uploaded' })
        .success,
    ).toBe(false);
  });

  it('tells the pauses of one pipeline agent apart', (): void => {
    const pause = {
      executionId: 'execution-1',
      jobId: 'review',
      stepId: 'agent',
      attempt: 1,
      checkpointId: 'checkpoint-1',
      pausedAt: '2026-10-01T10:00:00.000Z',
    };

    // The pause time is not part of which pause it is.
    expect(isSameLedgerPipelinePause(pause, { ...pause, pausedAt: null })).toBe(
      true,
    );
    expect(isSameLedgerPipelinePause(undefined, undefined)).toBe(true);
    for (const other of [
      { ...pause, checkpointId: 'checkpoint-2' },
      { ...pause, attempt: 2 },
      { ...pause, stepId: 'summary' },
      { ...pause, jobId: 'build' },
      { ...pause, executionId: 'execution-2' },
      undefined,
    ]) {
      expect(isSameLedgerPipelinePause(pause, other)).toBe(false);
    }
  });

  it('uses plane-qualified codes and keyed retry directives', (): void => {
    for (const code of Object.values(LEDGER_ERROR_CODES)) {
      expect(/^(core|worker)(\.[a-z][A-Za-z0-9]*){2,}$/.test(code)).toBe(true);
      expect(LedgerErrorCodeSchema.safeParse(code).success).toBe(true);
    }
    expect([...LedgerErrorCodeSchema.options].sort()).toEqual(
      Object.values(LEDGER_ERROR_CODES).sort(),
    );

    expect(
      CanopyKeyedRetryDirectiveSchema.safeParse({ kind: 'same_request' })
        .success,
    ).toBe(false);
    expect(
      CanopyKeyedRetryDirectiveSchema.safeParse({
        kind: 'same_idempotency_key',
      }).success,
    ).toBe(true);
  });
});
