import {
  LEDGER_SYNC_LIMITS,
  LedgerActorRegisteredPayloadSchema,
  LedgerEntryRevisionPayloadSchema,
  LedgerMirrorEntrySchema,
  LedgerMirrorSearchRequestSchema,
  LedgerMirrorSearchResponseSchema,
  LedgerScopeLifecyclePayloadSchema,
  LedgerScopeRegisterRequestSchema,
  LedgerScopeRegisteredPayloadSchema,
  LedgerSyncErrorResponseSchema,
  LedgerSyncPushRequestSchema,
  isLedgerCanonicalValue,
  toLedgerCanonicalJson,
  type LedgerScopeRegisterRequest,
  type LedgerSyncEvent,
} from '../index';

const LEDGER_ID = '00000000-0000-4000-8000-0000000000f1';
const ACCOUNT_ID = '00000000-0000-4000-8000-0000000000c1';
const ACTOR_ID = '00000000-0000-4000-8000-0000000000a1';
const ENTRY_ID = '00000000-0000-4000-8000-000000000101';
const NONCE = '00000000-0000-4000-8000-0000000000d1';
const USER = { actorId: ACTOR_ID, kind: 'user', authorityId: 'authority-1' };
const DETAILS = {
  harness: null,
  model: null,
  thinkingEffort: null,
  mode: null,
  pipelineExecutionId: null,
  settingsRevision: null,
  unavailableReason: 'not_applicable',
};
const SCOPE = {
  ledgerId: LEDGER_ID,
  authorityId: 'authority-1',
  container: {
    kind: 'code_worktree',
    workspaceId: 'workspace-1',
    worktreeId: 'worktree-1',
  },
};
const ATTRIBUTION = {
  kind: 'user',
  effectiveActor: USER,
  recordedBy: USER,
  executorDetails: DETAILS,
};
const ORIGIN = { kind: 'user', ledgerId: LEDGER_ID, userActorId: ACTOR_ID };
const ENTRY = {
  schemaVersion: 1,
  entryId: ENTRY_ID,
  scope: SCOPE,
  createdAt: '2026-10-01T10:00:00.000Z',
  updatedAt: '2026-10-01T10:00:00.000Z',
  revision: 1,
  author: USER,
  authorDetails: DETAILS,
  owner: USER,
  type: 'TASK',
  title: 'Write the release notes',
  content: 'Cover the Ledger panel.',
  highlights: [],
  referenceFiles: [],
  status: 'TODO',
  origin: ORIGIN,
  attribution: ATTRIBUTION,
};
const MUTATION = {
  mutationId: '00000000-0000-4000-8000-000000000201',
  entryId: ENTRY_ID,
  kind: 'create',
  revision: 1,
  previousRevision: null,
  occurredAt: '2026-10-01T10:00:00.000Z',
  status: { from: null, to: 'TODO' },
  owner: { from: null, to: USER },
  attribution: ATTRIBUTION,
  invocationOrigin: ORIGIN,
};

const REGISTRATION: LedgerScopeRegisterRequest = {
  schemaVersion: 1,
  ledgerId: LEDGER_ID,
  accountId: ACCOUNT_ID,
  scopeKind: 'code_worktree',
  session: { deviceId: 'device-1', installationGeneration: 3, nonce: NONCE },
  audience: { kind: 'private' },
};

function event(sequence: number): LedgerSyncEvent {
  return {
    eventId: `00000000-0000-4000-8000-${String(sequence).padStart(12, '0')}`,
    scopeSequence: String(sequence),
    kind: 'scope_archived',
    entryId: null,
    entryRevision: null,
    occurredAt: '2026-10-01T10:00:00.000Z',
    payloadHash: 'a'.repeat(64),
    payload: {},
  };
}

describe('Ledger sync registration', () => {
  it('accepts a private or an organization audience, and a held writer epoch', () => {
    expect(
      LedgerScopeRegisterRequestSchema.safeParse(REGISTRATION).success,
    ).toBe(true);
    expect(
      LedgerScopeRegisterRequestSchema.safeParse({
        ...REGISTRATION,
        writerEpoch: '12',
        audience: { kind: 'organization', trackedWorkspaceId: LEDGER_ID },
      }).success,
    ).toBe(true);
    // The installation's own ceiling, which fits the mirror's column.
    expect(
      LedgerScopeRegisterRequestSchema.safeParse({
        ...REGISTRATION,
        session: {
          ...REGISTRATION.session,
          installationGeneration: LEDGER_SYNC_LIMITS.installationGenerationMax,
        },
      }).success,
    ).toBe(true);
    expect(LEDGER_SYNC_LIMITS.installationGenerationMax).toBe(2_147_483_647);
  });

  it('refuses unknown fields, a submitted organization and malformed sessions', () => {
    for (const request of [
      { ...REGISTRATION, organizationId: LEDGER_ID },
      {
        ...REGISTRATION,
        audience: { kind: 'organization', organizationId: LEDGER_ID },
      },
      { ...REGISTRATION, schemaVersion: 2 },
      { ...REGISTRATION, writerEpoch: '0' },
      { ...REGISTRATION, scopeKind: 'plan_explore' },
      {
        ...REGISTRATION,
        session: { ...REGISTRATION.session, nonce: 'not-a-uuid' },
      },
      {
        ...REGISTRATION,
        session: {
          ...REGISTRATION.session,
          deviceId: 'd'.repeat(LEDGER_SYNC_LIMITS.deviceIdMaxLength + 1),
        },
      },
      {
        ...REGISTRATION,
        session: { ...REGISTRATION.session, installationGeneration: -1 },
      },
      {
        ...REGISTRATION,
        session: {
          ...REGISTRATION.session,
          installationGeneration: 2_147_483_648,
        },
      },
      {
        ...REGISTRATION,
        session: { ...REGISTRATION.session, deviceId: 'device-\u0000' },
      },
      {
        ...REGISTRATION,
        session: { ...REGISTRATION.session, deviceId: 'device\n1' },
      },
    ]) {
      expect(LedgerScopeRegisterRequestSchema.safeParse(request).success).toBe(
        false,
      );
    }
  });
});

describe('Ledger sync push', () => {
  const push = {
    schemaVersion: 1,
    ledgerId: LEDGER_ID,
    accountId: ACCOUNT_ID,
    writerEpoch: '1',
    acknowledgedSequence: '0',
  };

  it('accepts one to a hundred events, and no more', () => {
    const batch = (count: number): unknown => ({
      ...push,
      events: Array.from({ length: count }, (_value, index) =>
        event(index + 1),
      ),
    });

    expect(LedgerSyncPushRequestSchema.safeParse(batch(1)).success).toBe(true);
    expect(
      LedgerSyncPushRequestSchema.safeParse(
        batch(LEDGER_SYNC_LIMITS.pushEventsMax),
      ).success,
    ).toBe(true);
    expect(LedgerSyncPushRequestSchema.safeParse(batch(0)).success).toBe(false);
    expect(
      LedgerSyncPushRequestSchema.safeParse(
        batch(LEDGER_SYNC_LIMITS.pushEventsMax + 1),
      ).success,
    ).toBe(false);
  });

  it('refuses a malformed envelope', () => {
    for (const broken of [
      { ...event(1), payloadHash: 'A'.repeat(64) },
      { ...event(1), scopeSequence: '01' },
      { ...event(1), kind: 'scope_retired' },
      { ...event(1), entryRevision: 0 },
      { ...event(1), writerEpoch: '1' },
    ]) {
      expect(
        LedgerSyncPushRequestSchema.safeParse({ ...push, events: [broken] })
          .success,
      ).toBe(false);
    }
  });

  it("parses each kind's payload strictly", () => {
    expect(
      LedgerScopeRegisteredPayloadSchema.safeParse({
        scope: SCOPE,
        containerCreatedAt: '2026-09-30T08:00:00.000Z',
        accountId: ACCOUNT_ID,
      }).success,
    ).toBe(true);
    expect(
      LedgerActorRegisteredPayloadSchema.safeParse({
        actor: USER,
        originKey: 'user:local',
        displayName: 'You',
      }).success,
    ).toBe(true);
    expect(
      LedgerEntryRevisionPayloadSchema.safeParse({
        entry: ENTRY,
        mutation: MUTATION,
        publication: { sourceTruncated: false },
      }).success,
    ).toBe(true);
    expect(
      LedgerScopeLifecyclePayloadSchema.safeParse({
        scope: SCOPE,
        containerCreatedAt: '2026-09-30T08:00:00.000Z',
      }).success,
    ).toBe(true);

    expect(
      LedgerActorRegisteredPayloadSchema.safeParse({
        actor: USER,
        originKey: 'user:local',
        displayName: 'You',
        transcript: 'never mirrored',
      }).success,
    ).toBe(false);
    expect(
      LedgerEntryRevisionPayloadSchema.safeParse({
        entry: { ...ENTRY, title: 't'.repeat(101) },
        mutation: MUTATION,
      }).success,
    ).toBe(false);
  });
});

describe('Ledger mirror search', () => {
  it('takes the local filters plus whose entries, one device and archived scopes', () => {
    expect(
      LedgerMirrorSearchRequestSchema.safeParse({
        audience: 'teammates',
        includeArchived: true,
        query: 'parser',
        types: ['TASK'],
        statuses: ['TODO', 'BLOCKED'],
        owner: 'self',
        createdAfter: '2026-10-01T00:00:00Z',
        sort: 'updated_desc',
        limit: 100,
      }).success,
    ).toBe(true);
    expect(
      LedgerMirrorSearchRequestSchema.safeParse({ deviceId: 'device-1' })
        .success,
    ).toBe(true);
  });

  it('refuses empty filters, an oversized page and local-only fields', () => {
    for (const request of [
      { types: [] },
      { limit: 101 },
      { audience: 'everyone' },
      { includeAssignableOwners: true },
      { deviceId: '' },
      { deviceId: 'device-\u0000' },
    ]) {
      expect(LedgerMirrorSearchRequestSchema.safeParse(request).success).toBe(
        false,
      );
    }
  });
});

describe('Ledger mirror entries', () => {
  it('carry where they were written, and no sync state of their own', () => {
    const item = {
      entryId: ENTRY.entryId,
      revision: 1,
      type: 'TASK',
      title: ENTRY.title,
      content: ENTRY.content,
      highlights: [],
      referenceFiles: [],
      status: 'TODO',
      owner: USER,
      author: USER,
      attributionKind: 'user',
      createdAt: ENTRY.createdAt,
      updatedAt: ENTRY.updatedAt,
      sourceAvailability: 'not_on_this_device',
      ledgerId: LEDGER_ID,
      scopeKind: 'code_worktree',
      scopeArchived: false,
      source: { kind: 'mine', deviceId: 'device-1', deviceLabel: 'Studio' },
    };

    expect(LedgerMirrorEntrySchema.safeParse(item).success).toBe(true);
    // A mirrored row is mirrored by definition.
    expect(
      LedgerMirrorEntrySchema.safeParse({ ...item, syncState: 'mirrored' })
        .success,
    ).toBe(false);
    // Only the device that owns an entry names what its source opens as.
    expect(
      LedgerMirrorEntrySchema.safeParse({ ...item, sourceKind: 'chat' })
        .success,
    ).toBe(false);
  });
});

describe('Ledger mirror search results', () => {
  it('carry entries, labels and an opaque cursor, and no snapshot counter', () => {
    const page = {
      entries: [],
      actors: [],
      nextCursor: 'b3BhcXVl',
      hasMore: true,
    };

    expect(LedgerMirrorSearchResponseSchema.safeParse(page).success).toBe(true);
    expect(
      LedgerMirrorSearchResponseSchema.safeParse({ ...page, watermark: '42' })
        .success,
    ).toBe(false);
  });
});

describe('Ledger sync errors', () => {
  it('carries a code, a retry directive and, for a gap, the expected sequence', () => {
    expect(
      LedgerSyncErrorResponseSchema.safeParse({
        error: {
          code: 'ledger_sequence_gap',
          message:
            'The batch does not continue from the acknowledged sequence.',
          retry: 'never',
          expectedSequence: '5',
        },
      }).success,
    ).toBe(true);
    expect(
      LedgerSyncErrorResponseSchema.safeParse({
        error: { code: 'ledger_unknown', message: 'x', retry: 'later' },
      }).success,
    ).toBe(false);
  });
});

describe('Ledger canonical JSON', () => {
  it('sorts keys at every depth and omits undefined members', () => {
    expect(
      toLedgerCanonicalJson({
        b: [{ z: 1, a: null }, 'x'],
        a: { d: true, c: undefined, b: 2.5 },
      }),
    ).toBe('{"a":{"b":2.5,"d":true},"b":[{"a":null,"z":1},"x"]}');
  });

  it('serializes equal data the same way whatever the key order', () => {
    expect(toLedgerCanonicalJson({ entry: ENTRY, mutation: MUTATION })).toBe(
      toLedgerCanonicalJson({ mutation: MUTATION, entry: ENTRY }),
    );
  });

  it('recognizes parsed JSON, and nothing else', () => {
    const parsed: unknown = JSON.parse(
      JSON.stringify({ entry: ENTRY, list: [1, 'two', null, false] }),
    );
    expect(isLedgerCanonicalValue(parsed)).toBe(true);
    for (const value of [
      undefined,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      (): void => undefined,
      [1, undefined],
      { nested: { at: Symbol('x') } },
      10n,
    ]) {
      expect(isLedgerCanonicalValue(value)).toBe(false);
    }
  });
});
