import {
  LEDGER_SCOPE_KINDS,
  LEDGER_SYNC_GLOBAL_SCHEMA_VERSION,
  LEDGER_SYNC_SCHEMA_VERSION,
  LedgerScopeAudienceSchema,
  LedgerScopeRegisterRequestSchema,
  LedgerSyncPushRequestSchema,
  parseLedgerMirrorReadVersion,
} from '../index';

const LEDGER_ID = '00000000-0000-4000-8000-0000000000f1';
const ACCOUNT_ID = '00000000-0000-4000-8000-0000000000c1';
const NONCE = '00000000-0000-4000-8000-0000000000d1';
const ORG_ID = '0b4f8a52-7c1d-4e8a-9f3b-2d6c1e5a7b90';
const WORKSPACE_ID = '00000000-0000-4000-8000-0000000000e1';
const SESSION = {
  deviceId: 'device-1',
  installationGeneration: 1,
  nonce: NONCE,
};

const GLOBAL_REGISTER = {
  schemaVersion: LEDGER_SYNC_GLOBAL_SCHEMA_VERSION,
  ledgerId: LEDGER_ID,
  accountId: ACCOUNT_ID,
  scopeKind: 'global',
  globalOwner: { kind: 'organization', organizationId: ORG_ID },
  session: SESSION,
  audience: { kind: 'organization_global', organizationId: ORG_ID },
};

describe('global Ledger sync contract', () => {
  it('adds the global scope kind', () => {
    expect(LEDGER_SCOPE_KINDS).toContain('global');
  });

  it('accepts a version-2 global registration, private or organization', () => {
    expect(
      LedgerScopeRegisterRequestSchema.safeParse(GLOBAL_REGISTER).success,
    ).toBe(true);
    expect(
      LedgerScopeRegisterRequestSchema.safeParse({
        ...GLOBAL_REGISTER,
        globalOwner: { kind: 'personal' },
        audience: { kind: 'private' },
      }).success,
    ).toBe(true);
  });

  it('requires globalOwner on a global registration', () => {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { globalOwner: _omitted, ...withoutOwner } = GLOBAL_REGISTER;
    expect(
      LedgerScopeRegisterRequestSchema.safeParse(withoutOwner).success,
    ).toBe(false);
  });

  it('forbids globalOwner and global audiences on a task registration', () => {
    const task = {
      schemaVersion: LEDGER_SYNC_SCHEMA_VERSION,
      ledgerId: LEDGER_ID,
      accountId: ACCOUNT_ID,
      scopeKind: 'code_worktree',
      session: SESSION,
      audience: { kind: 'organization', trackedWorkspaceId: WORKSPACE_ID },
    };
    expect(LedgerScopeRegisterRequestSchema.safeParse(task).success).toBe(true);
    expect(
      LedgerScopeRegisterRequestSchema.safeParse({
        ...task,
        globalOwner: { kind: 'personal' },
      }).success,
    ).toBe(false);
    expect(
      LedgerScopeRegisterRequestSchema.safeParse({
        ...task,
        audience: GLOBAL_REGISTER.audience,
      }).success,
    ).toBe(false);
  });

  it('rejects a version that does not match the scope kind', () => {
    expect(
      LedgerScopeRegisterRequestSchema.safeParse({
        ...GLOBAL_REGISTER,
        schemaVersion: LEDGER_SYNC_SCHEMA_VERSION,
      }).success,
    ).toBe(false);
    expect(
      LedgerScopeRegisterRequestSchema.safeParse({
        ...GLOBAL_REGISTER,
        scopeKind: 'code_worktree',
      }).success,
    ).toBe(false);
    expect(
      LedgerScopeRegisterRequestSchema.safeParse({
        ...GLOBAL_REGISTER,
        audience: { kind: 'organization', trackedWorkspaceId: WORKSPACE_ID },
      }).success,
    ).toBe(false);
  });

  it('accepts push requests at either version and nothing else', () => {
    const push = {
      ledgerId: LEDGER_ID,
      accountId: ACCOUNT_ID,
      writerEpoch: '1',
      acknowledgedSequence: '0',
      events: [
        {
          eventId: NONCE,
          scopeSequence: '1',
          kind: 'scope_registered',
          entryId: null,
          entryRevision: null,
          occurredAt: '2026-10-01T10:00:00.000Z',
          payloadHash: 'a'.repeat(64),
          payload: {},
        },
      ],
    };
    expect(
      LedgerSyncPushRequestSchema.safeParse({ ...push, schemaVersion: 1 })
        .success,
    ).toBe(true);
    expect(
      LedgerSyncPushRequestSchema.safeParse({ ...push, schemaVersion: 2 })
        .success,
    ).toBe(true);
    expect(
      LedgerSyncPushRequestSchema.safeParse({ ...push, schemaVersion: 3 })
        .success,
    ).toBe(false);
  });

  it('applies an organization_global audience with a lease', () => {
    expect(
      LedgerScopeAudienceSchema.safeParse({
        kind: 'organization_global',
        organizationId: ORG_ID,
        expiresAt: '2026-10-04T10:00:00.000Z',
      }).success,
    ).toBe(true);
  });

  it('negotiates the read version from the header', () => {
    expect(parseLedgerMirrorReadVersion(null)).toBe(1);
    expect(parseLedgerMirrorReadVersion('1')).toBe(1);
    expect(parseLedgerMirrorReadVersion(' 2 ')).toBe(2);
    expect(parseLedgerMirrorReadVersion('3')).toBe(1);
  });
});
