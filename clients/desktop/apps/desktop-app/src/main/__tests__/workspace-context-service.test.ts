import type * as AccountStore from '../lib/canopy-cloud-account-store';
import type { CanopyCloudAccountEntry } from '../lib/canopy-cloud-account-store';

const mockReadFile = jest.fn<Promise<string>, [string, string]>();
const mockWriteFileAtomically = jest.fn<
  Promise<void>,
  [string, string | Uint8Array, unknown?]
>();
const mockMkdir = jest.fn<Promise<void>, [string, { recursive: boolean }]>();
const mockLoadAccount = jest.fn<Promise<CanopyCloudAccountEntry | null>, []>();
// `entry` is `unknown` on purpose: the store hands the service whatever was
// persisted, and the malformed-record test feeds it an untyped JSON object.
const mockReadAccountWithStatus = jest.fn<
  Promise<
    | { status: 'ok'; entry: unknown }
    | { status: 'unavailable' }
    | { status: 'error'; error: unknown }
  >,
  [options?: { cache?: boolean }]
>(async () => ({ status: 'ok', entry: await mockLoadAccount() }));
let accountListener: ((entry: CanopyCloudAccountEntry | null) => void) | null =
  null;

jest.mock('node:fs/promises', () => ({
  mkdir: (path: string, options: { recursive: boolean }): Promise<void> =>
    mockMkdir(path, options),
  readFile: (path: string, encoding: string): Promise<string> =>
    mockReadFile(path, encoding),
}));
jest.mock('../lib/atomic-file', () => ({
  writeFileAtomically: (
    path: string,
    data: string | Uint8Array,
    options?: unknown,
  ): Promise<void> => mockWriteFileAtomically(path, data, options),
}));
const mockDataDir = '/mock/data-dir';
const mockFilePath = `${mockDataDir}/workspace-context.json`;
jest.mock('../lib/paths', () => ({
  getWorkspaceContextFilePath: (): string => mockFilePath,
  getCanopyCloudAccountFilePath: (): string => '/mock/account.enc',
  getLegacyCanopyCloudAccountFilePath: (): string => '/mock/data-account.enc',
  getInternalLegacySharedCanopyCloudAccountFilePath: (): string =>
    '/mock/legacy-account.enc',
}));
jest.mock('../lib/canopy-cloud-account-store', () => ({
  loadCanopyCloudAccount: (): Promise<CanopyCloudAccountEntry | null> =>
    mockLoadAccount(),
  subscribeCanopyCloudAccountChanges: (
    listener: (entry: CanopyCloudAccountEntry | null) => void,
  ): (() => void) => {
    accountListener = listener;
    return (): void => {
      accountListener = null;
    };
  },
  readCanopyCloudAccountWithStatus: (options?: {
    cache?: boolean;
  }): ReturnType<typeof mockReadAccountWithStatus> =>
    mockReadAccountWithStatus(options),
}));

jest.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: (): boolean => true,
    encryptString: (value: string): Buffer => Buffer.from(value),
    decryptString: (value: Buffer): string => value.toString(),
  },
}));
jest.mock('../canopy-cloud/config', () => ({}));
jest.mock('../lib/main-process-logging', () => ({
  logMainProcessWarn: jest.fn(),
}));
jest.mock('../lib/secure-storage-migration', () => ({
  migrateSecureStorageFile: jest.fn(),
}));
import { migrateSecureStorageFile } from '../lib/secure-storage-migration';

let mockRolloutEnabled = true;
let flagListener: (() => void) | null = null;
jest.mock('../feature-flags', () => ({
  getFeatureFlagService: (): object => ({
    isEnabled: (): boolean => mockRolloutEnabled,
    onSnapshotChanged: (listener: () => void): (() => void) => {
      flagListener = listener;
      return (): void => {
        flagListener = null;
      };
    },
  }),
}));

import {
  __resetWorkspaceContextServiceForTests,
  WorkspaceContextError,
  createWorkspaceContextService,
  getWorkspaceScopingContext,
  type WorkspaceContextBroadcast,
} from '../lib/workspace-context-service';

const ORG_A = '11111111-1111-4111-8111-111111111111';
const ORG_B = '22222222-2222-4222-8222-222222222222';

function account(
  id: string,
  organizations: Array<{
    id: string;
    name: string;
    role?: 'OWNER' | 'ADMIN' | 'MEMBER';
    logoUrl?: string | null;
  }>,
): CanopyCloudAccountEntry {
  return {
    apiKey: `csk_${id}`,
    capabilities: ['organizations-v1'],
    account: { id, name: id, email: `${id}@example.test`, role: 'DEVELOPER' },
    organizations: organizations.map((organization) => ({
      ...organization,
      createdAt: '2026-09-10T00:00:00.000Z',
      updatedAt: '2026-09-10T00:00:00.000Z',
    })),
    teams: [],
    createdAt: '2026-09-10T00:00:00.000Z',
    updatedAt: '2026-09-10T00:00:00.000Z',
  };
}

function persisted(
  byAccount: Record<string, { context: string; revision: number }>,
): string {
  return JSON.stringify({ version: 1, byAccount });
}

interface PersistedShape {
  version: number;
  byAccount: Record<string, { context: string; revision: number }>;
}

function isPersistedShape(value: unknown): value is PersistedShape {
  return (
    typeof value === 'object' &&
    value !== null &&
    'version' in value &&
    'byAccount' in value &&
    typeof value.byAccount === 'object' &&
    value.byAccount !== null
  );
}

function lastWrite(): PersistedShape {
  const call =
    mockWriteFileAtomically.mock.calls[
      mockWriteFileAtomically.mock.calls.length - 1
    ];
  if (!call) throw new Error('nothing written');
  const data = call[1];
  const text = typeof data === 'string' ? data : new TextDecoder().decode(data);
  const parsed: unknown = JSON.parse(text);
  if (!isPersistedShape(parsed)) throw new Error('unexpected file shape');
  return parsed;
}

describe('WorkspaceContextService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    accountListener = null;
    mockMkdir.mockResolvedValue(undefined);
    mockWriteFileAtomically.mockResolvedValue(undefined);
    mockReadFile.mockRejectedValue(
      Object.assign(new Error('ENOENT'), { code: 'ENOENT' }),
    );
  });

  it.each(['https://example.test/logo.png', '', null, undefined])(
    'passes through only non-empty organization logo URLs: %s',
    async (logoUrl) => {
      mockLoadAccount.mockResolvedValue(
        account('user-1', [{ id: ORG_A, name: 'Acme', logoUrl }]),
      );
      const service = createWorkspaceContextService();
      await service.initialize();
      expect(service.getState().organizations).toEqual([
        {
          id: ORG_A,
          name: 'Acme',
          role: 'MEMBER',
          ...(logoUrl ? { logoUrl } : {}),
        },
      ]);
      service.dispose();
    },
  );

  it('replaces the Personal resource mapping on refresh, promotion, logout and account switch', async () => {
    mockLoadAccount.mockResolvedValue({
      ...account('user-1', []),
      personalOrganizationId: ORG_A,
    });
    const service = createWorkspaceContextService();
    await service.initialize();
    expect(service.personalOrganizationId()).toBe(ORG_A);
    expect(service.getState().organizations).toEqual([]);
    const epoch = service.accountEpoch();
    if (!accountListener) throw new Error('missing account subscription');
    accountListener(account('user-1', [{ id: ORG_A, name: 'Promoted' }]));
    await service.whenIdle();
    expect(service.personalOrganizationId()).toBeNull();
    expect(service.accountEpoch()).toBeGreaterThan(epoch);
    accountListener({
      ...account('user-2', []),
      personalOrganizationId: ORG_B,
    });
    await service.whenIdle();
    expect(service.personalOrganizationId()).toBe(ORG_B);
    accountListener(null);
    await service.whenIdle();
    expect(service.personalOrganizationId()).toBeNull();
    service.dispose();
  });
  it('broadcasts a logo that arrives after startup, and its removal', async () => {
    // An account cached before logos were kept starts without one.
    mockLoadAccount.mockResolvedValue(
      account('user-1', [{ id: ORG_A, name: 'Acme', role: 'MEMBER' }]),
    );
    const service = createWorkspaceContextService();
    await service.initialize();
    const broadcasts: WorkspaceContextBroadcast[] = [];
    service.subscribe((state) => broadcasts.push(state));
    if (!accountListener) throw new Error('service did not subscribe');
    const logoUrl = 'https://example.test/acme.png';

    accountListener(
      account('user-1', [{ id: ORG_A, name: 'Acme', role: 'MEMBER', logoUrl }]),
    );
    await service.whenIdle();
    expect(service.getState().organizations).toEqual([
      { id: ORG_A, name: 'Acme', role: 'MEMBER', logoUrl },
    ]);
    accountListener(
      account('user-1', [{ id: ORG_A, name: 'Acme', role: 'MEMBER' }]),
    );
    await service.whenIdle();
    expect(service.getState().organizations).toEqual([
      { id: ORG_A, name: 'Acme', role: 'MEMBER' },
    ]);
    expect(broadcasts.map((state) => state.reason)).toEqual([
      'organizations',
      'organizations',
    ]);
    service.dispose();
  });

  it('starts in Personal with the account organizations and no persisted state', async () => {
    mockLoadAccount.mockResolvedValue(
      account('user-1', [{ id: ORG_A, name: 'Acme', role: 'ADMIN' }]),
    );
    const service = createWorkspaceContextService();
    await service.initialize();

    expect(service.getState()).toEqual({
      context: { kind: 'personal' },
      revision: 0,
      organizations: [{ id: ORG_A, name: 'Acme', role: 'ADMIN' }],
    });
  });

  it('defaults an organization without a role to MEMBER for the client', async () => {
    mockLoadAccount.mockResolvedValue(
      account('user-1', [{ id: ORG_A, name: 'Acme' }]),
    );
    const service = createWorkspaceContextService();
    await service.initialize();

    expect(service.getState().organizations).toEqual([
      { id: ORG_A, name: 'Acme', role: 'MEMBER' },
    ]);
  });

  it('switches context, bumps the revision, persists per account, and broadcasts', async () => {
    mockLoadAccount.mockResolvedValue(
      account('user-1', [{ id: ORG_A, name: 'Acme', role: 'MEMBER' }]),
    );
    const service = createWorkspaceContextService();
    await service.initialize();
    const broadcasts: WorkspaceContextBroadcast[] = [];
    service.subscribe((state) => broadcasts.push(state));

    const next = await service.setContext({
      kind: 'organization',
      organizationId: ORG_A,
    });

    expect(next.context).toEqual({
      kind: 'organization',
      organizationId: ORG_A,
    });
    expect(next.revision).toBe(1);
    expect(mockWriteFileAtomically).toHaveBeenCalledWith(
      mockFilePath,
      expect.any(String),
      expect.anything(),
    );
    expect(lastWrite()).toEqual({
      version: 1,
      byAccount: { 'user-1': { context: `org:${ORG_A}`, revision: 1 } },
    });
    expect(broadcasts).toEqual([
      expect.objectContaining({
        context: next.context,
        revision: 1,
        reason: 'switch',
      }),
    ]);
  });

  it('restores the persisted context for the signed-in account', async () => {
    mockReadFile.mockResolvedValue(
      persisted({ 'user-1': { context: `org:${ORG_A}`, revision: 4 } }),
    );
    mockLoadAccount.mockResolvedValue(
      account('user-1', [{ id: ORG_A, name: 'Acme', role: 'MEMBER' }]),
    );
    const service = createWorkspaceContextService();
    await service.initialize();

    expect(service.getState()).toEqual({
      context: { kind: 'organization', organizationId: ORG_A },
      revision: 4,
      organizations: [{ id: ORG_A, name: 'Acme', role: 'MEMBER' }],
    });
  });

  it('falls back to Personal when the persisted organization is no longer a membership', async () => {
    mockReadFile.mockResolvedValue(
      persisted({ 'user-1': { context: `org:${ORG_B}`, revision: 2 } }),
    );
    mockLoadAccount.mockResolvedValue(
      account('user-1', [{ id: ORG_A, name: 'Acme', role: 'MEMBER' }]),
    );
    const service = createWorkspaceContextService();
    await service.initialize();

    expect(service.getState().context).toEqual({ kind: 'personal' });
  });

  it('rejects an organization the account does not belong to', async () => {
    mockLoadAccount.mockResolvedValue(
      account('user-1', [{ id: ORG_A, name: 'Acme', role: 'MEMBER' }]),
    );
    const service = createWorkspaceContextService();
    await service.initialize();

    await expect(
      service.setContext({ kind: 'organization', organizationId: ORG_B }),
    ).rejects.toMatchObject({ code: 'unknown-organization' });
    expect(service.getState().context).toEqual({ kind: 'personal' });
    expect(mockWriteFileAtomically).not.toHaveBeenCalled();
  });

  it('rejects a stale expected revision so a second window cannot silently win', async () => {
    mockLoadAccount.mockResolvedValue(
      account('user-1', [{ id: ORG_A, name: 'Acme', role: 'MEMBER' }]),
    );
    const service = createWorkspaceContextService();
    await service.initialize();
    await service.setContext({ kind: 'organization', organizationId: ORG_A });

    const error = await service
      .setContext({ kind: 'personal' }, 0)
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(WorkspaceContextError);
    expect(error).toMatchObject({ code: 'stale-revision' });
    expect(service.getState().revision).toBe(1);
  });

  it('serializes concurrent switches into monotonic revisions', async () => {
    mockLoadAccount.mockResolvedValue(
      account('user-1', [
        { id: ORG_A, name: 'Acme', role: 'MEMBER' },
        { id: ORG_B, name: 'Beta', role: 'OWNER' },
      ]),
    );
    const service = createWorkspaceContextService();
    await service.initialize();

    const [first, second, third] = await Promise.all([
      service.setContext({ kind: 'organization', organizationId: ORG_A }),
      service.setContext({ kind: 'organization', organizationId: ORG_B }),
      service.setContext({ kind: 'personal' }),
    ]);

    expect([first.revision, second.revision, third.revision]).toEqual([
      1, 2, 3,
    ]);
    expect(service.getState()).toMatchObject({
      context: { kind: 'personal' },
      revision: 3,
    });
  });

  it('does not bump the revision or persist when the context is unchanged', async () => {
    mockLoadAccount.mockResolvedValue(
      account('user-1', [{ id: ORG_A, name: 'Acme', role: 'MEMBER' }]),
    );
    const service = createWorkspaceContextService();
    await service.initialize();

    const state = await service.setContext({ kind: 'personal' });

    expect(state.revision).toBe(0);
    expect(mockWriteFileAtomically).not.toHaveBeenCalled();
  });

  it('resets to Personal and drops the previous selection on sign-out', async () => {
    mockLoadAccount.mockResolvedValue(
      account('user-1', [{ id: ORG_A, name: 'Acme', role: 'MEMBER' }]),
    );
    const service = createWorkspaceContextService();
    await service.initialize();
    await service.setContext({ kind: 'organization', organizationId: ORG_A });
    const broadcasts: WorkspaceContextBroadcast[] = [];
    service.subscribe((state) => broadcasts.push(state));

    if (!accountListener) throw new Error('service did not subscribe');
    accountListener(null);
    await service.whenIdle();

    expect(service.getState()).toEqual({
      context: { kind: 'personal' },
      revision: 0,
      organizations: [],
    });
    expect(broadcasts[broadcasts.length - 1]).toMatchObject({
      reason: 'account-change',
    });
    // The signed-out account's persisted selection survives for its next
    // sign-in; only the in-memory state is dropped.
    expect(mockWriteFileAtomically).toHaveBeenCalledTimes(1);
  });

  it('falls back to Personal with a departed reason when the selected organization disappears', async () => {
    mockLoadAccount.mockResolvedValue(
      account('user-1', [{ id: ORG_A, name: 'Acme', role: 'MEMBER' }]),
    );
    const service = createWorkspaceContextService();
    await service.initialize();
    await service.setContext({ kind: 'organization', organizationId: ORG_A });
    const broadcasts: WorkspaceContextBroadcast[] = [];
    service.subscribe((state) => broadcasts.push(state));

    if (!accountListener) throw new Error('service did not subscribe');
    accountListener(account('user-1', []));
    await service.whenIdle();

    expect(service.getState()).toMatchObject({
      context: { kind: 'personal' },
      revision: 2,
      organizations: [],
    });
    expect(broadcasts[broadcasts.length - 1]).toMatchObject({
      reason: 'departed',
    });
    expect(lastWrite().byAccount['user-1']).toEqual({
      context: 'personal',
      revision: 2,
    });
  });

  it('re-broadcasts when the same account gains or loses the organization-projects capability', async () => {
    const before = account('user-1', [
      { id: ORG_A, name: 'Acme', role: 'MEMBER' },
    ]);
    mockLoadAccount.mockResolvedValue(before);
    const service = createWorkspaceContextService();
    await service.initialize();
    await service.setContext({ kind: 'organization', organizationId: ORG_A });
    const broadcasts: WorkspaceContextBroadcast[] = [];
    service.subscribe((state) => broadcasts.push(state));
    if (!accountListener) throw new Error('service did not subscribe');
    const granted = {
      ...before,
      capabilities: [...before.capabilities, 'org-projects-v1'],
    };

    accountListener(granted);
    await service.whenIdle();
    accountListener({ ...granted, updatedAt: '2026-09-11T00:00:00.000Z' });
    await service.whenIdle();
    accountListener(before);
    await service.whenIdle();

    expect(broadcasts).toEqual([
      expect.objectContaining({
        reason: 'organizations',
        context: { kind: 'organization', organizationId: ORG_A },
      }),
      expect.objectContaining({ reason: 'organizations' }),
    ]);
  });

  it('switches accounts to that account persisted selection', async () => {
    mockReadFile.mockResolvedValue(
      persisted({
        'user-1': { context: 'personal', revision: 0 },
        'user-2': { context: `org:${ORG_B}`, revision: 7 },
      }),
    );
    mockLoadAccount.mockResolvedValue(
      account('user-1', [{ id: ORG_A, name: 'Acme', role: 'MEMBER' }]),
    );
    const service = createWorkspaceContextService();
    await service.initialize();

    if (!accountListener) throw new Error('service did not subscribe');
    accountListener(
      account('user-2', [{ id: ORG_B, name: 'Beta', role: 'OWNER' }]),
    );
    await service.whenIdle();

    expect(service.getState()).toEqual({
      context: { kind: 'organization', organizationId: ORG_B },
      revision: 7,
      organizations: [{ id: ORG_B, name: 'Beta', role: 'OWNER' }],
    });
  });

  it('ignores a corrupt state file and starts from Personal', async () => {
    mockReadFile.mockResolvedValue('{"version": 9, "byAccount": "nope"}');
    mockLoadAccount.mockResolvedValue(
      account('user-1', [{ id: ORG_A, name: 'Acme', role: 'MEMBER' }]),
    );
    const service = createWorkspaceContextService();
    await service.initialize();

    expect(service.getState()).toMatchObject({
      context: { kind: 'personal' },
      revision: 0,
    });
  });
});

describe('startup resilience', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockReadFile.mockRejectedValue(
      Object.assign(new Error('missing'), { code: 'ENOENT' }),
    );
    mockWriteFileAtomically.mockResolvedValue(undefined);
    mockMkdir.mockResolvedValue(undefined);
  });

  it('starts from Personal when the cloud account cannot be read', async () => {
    mockLoadAccount.mockRejectedValue(new Error('secure storage unavailable'));
    const service = createWorkspaceContextService();
    await expect(service.initialize()).resolves.toBeUndefined();
    expect(service.getState()).toEqual({
      context: { kind: 'personal' },
      revision: 0,
      organizations: [],
    });
  });

  it('treats an account entry without a string id as signed out', async () => {
    const entry = account('acct', [{ id: ORG_A, name: 'Acme' }]);
    // A persisted record that lost its id: rebuilt through JSON so the
    // fixture is genuinely untyped rather than cast into shape.
    const accountInfo = entry.account;
    if (!accountInfo) throw new Error('Expected account info in fixture');
    const { id: _dropped, ...accountWithoutId } = accountInfo;
    void _dropped;
    const malformed: unknown = JSON.parse(
      JSON.stringify({ ...entry, account: accountWithoutId }),
    );
    mockReadAccountWithStatus.mockResolvedValueOnce({
      status: 'ok',
      entry: malformed,
    });
    const service = createWorkspaceContextService();
    await service.initialize();
    expect(service.getState().context).toEqual({ kind: 'personal' });
    await expect(
      service.setContext({ kind: 'organization', organizationId: ORG_A }),
    ).resolves.toMatchObject({
      context: { kind: 'organization', organizationId: ORG_A },
    });
    expect(mockWriteFileAtomically).not.toHaveBeenCalled();
  });
});

describe('restore-time departure', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockWriteFileAtomically.mockResolvedValue(undefined);
    mockMkdir.mockResolvedValue(undefined);
  });

  it('persists the Personal fallback when the restored organization is gone', async () => {
    mockReadFile.mockResolvedValue(
      persisted({ acct: { context: `org:${ORG_B}`, revision: 3 } }),
    );
    mockLoadAccount.mockResolvedValue(
      account('acct', [{ id: ORG_A, name: 'Acme' }]),
    );
    const service = createWorkspaceContextService();
    await service.initialize();

    expect(service.getState()).toMatchObject({
      context: { kind: 'personal' },
      revision: 4,
    });
    expect(lastWrite().byAccount.acct).toEqual({
      context: 'personal',
      revision: 4,
    });
  });
});

describe('account fencing and degraded startup reads', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockReadAccountWithStatus.mockImplementation(async () => ({
      status: 'ok',
      entry: await mockLoadAccount(),
    }));
    mockWriteFileAtomically.mockResolvedValue(undefined);
    mockMkdir.mockResolvedValue(undefined);
  });

  it('rejects a switch minted under the previous account even when revisions coincide', async () => {
    mockReadFile.mockResolvedValue(
      persisted({
        alice: { context: 'personal', revision: 3 },
        bob: { context: 'personal', revision: 3 },
      }),
    );
    mockLoadAccount.mockResolvedValue(
      account('alice', [{ id: ORG_A, name: 'Acme' }]),
    );
    const service = createWorkspaceContextService();
    await service.initialize();
    expect(service.getState().revision).toBe(3);

    const listener = accountListener;
    if (!listener) throw new Error('no account subscription');
    listener(account('bob', [{ id: ORG_A, name: 'Acme' }]));
    await new Promise((resolve) => setImmediate(resolve));

    expect(service.getState().revision).toBeGreaterThan(3);
    await expect(
      service.setContext({ kind: 'organization', organizationId: ORG_A }, 3),
    ).rejects.toMatchObject({ code: 'stale-revision' });
  });

  it('does not adopt a sign-out when the account store is unavailable at startup', async () => {
    mockReadFile.mockResolvedValue(
      persisted({ acct: { context: `org:${ORG_A}`, revision: 2 } }),
    );
    mockReadAccountWithStatus.mockResolvedValueOnce({ status: 'unavailable' });
    const service = createWorkspaceContextService();
    await service.initialize();
    expect(service.getState()).toMatchObject({
      context: { kind: 'personal' },
      revision: 0,
    });
    expect(mockWriteFileAtomically).not.toHaveBeenCalled();

    // The store recovering later delivers the real entry through the
    // subscription and restores the persisted selection.
    const listener = accountListener;
    if (!listener) throw new Error('no account subscription');
    listener(account('acct', [{ id: ORG_A, name: 'Acme' }]));
    await new Promise((resolve) => setImmediate(resolve));
    expect(service.getState()).toMatchObject({
      context: { kind: 'organization', organizationId: ORG_A },
    });
  });
});

describe('zero-revision transitions and startup read recovery', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockReadAccountWithStatus.mockImplementation(async () => ({
      status: 'ok',
      entry: await mockLoadAccount(),
    }));
    mockReadFile.mockRejectedValue(
      Object.assign(new Error('missing'), { code: 'ENOENT' }),
    );
    mockWriteFileAtomically.mockResolvedValue(undefined);
    mockMkdir.mockResolvedValue(undefined);
  });

  it('advances the fence on an account switch even when both start at revision 0', async () => {
    mockLoadAccount.mockResolvedValue(
      account('alice', [{ id: ORG_A, name: 'Acme' }]),
    );
    const service = createWorkspaceContextService();
    await service.initialize();
    expect(service.getState().revision).toBe(0);

    const listener = accountListener;
    if (!listener) throw new Error('no account subscription');
    listener(account('bob', [{ id: ORG_A, name: 'Acme' }]));
    await new Promise((resolve) => setImmediate(resolve));

    expect(service.getState().revision).toBe(1);
    await expect(
      service.setContext({ kind: 'organization', organizationId: ORG_A }, 0),
    ).rejects.toMatchObject({ code: 'stale-revision' });
  });

  it.each(['sign-out', 'replacement', 'foreign legacy skip'] as const)(
    'discards a startup retry without overwriting the shared cache after %s',
    async (transition): Promise<void> => {
      jest.useFakeTimers();
      const accountStore = jest.requireActual<typeof AccountStore>(
        '../lib/canopy-cloud-account-store',
      );
      const migrate = jest.mocked(migrateSecureStorageFile);
      const service = createWorkspaceContextService();
      accountStore.invalidateCanopyCloudAccountCache();
      try {
        mockReadAccountWithStatus.mockResolvedValueOnce({
          status: 'unavailable',
        });
        await service.initialize();

        let resolveRead: (value: {
          status: 'current';
          value: CanopyCloudAccountEntry;
        }) => void = (): void => {};
        migrate.mockReturnValueOnce(
          new Promise((resolve): void => {
            resolveRead = resolve;
          }),
        );
        mockReadAccountWithStatus.mockImplementationOnce(
          accountStore.readCanopyCloudAccountWithStatus,
        );
        await jest.advanceTimersByTimeAsync(2_000);
        expect(migrate).toHaveBeenCalledTimes(1);

        const replacement =
          transition === 'replacement'
            ? account('bob', [{ id: ORG_A, name: 'Acme' }])
            : null;
        migrate.mockResolvedValue(
          transition === 'foreign legacy skip'
            ? {
                status: 'foreign-legacy-skipped',
                secureStorageFailure: {
                  version: 1,
                  code: 'SECURE_STORAGE_DECRYPT_FAILED',
                  operation: 'read',
                  state: 'secure',
                  backend: null,
                  retryable: false,
                },
              }
            : replacement === null
              ? { status: 'absent' }
              : { status: 'current', value: replacement },
        );
        // Confirmed absence/replacement is cached; foreign legacy ciphertext
        // remains uncached so the next ordinary read retries migration.
        const replacementRead =
          await accountStore.readCanopyCloudAccountWithStatus();
        expect(replacementRead).toMatchObject({
          status: 'ok',
          entry: replacement,
        });
        const listener = accountListener;
        if (listener === null) throw new Error('no account subscription');
        listener(replacement);
        await service.whenIdle();
        const currentState = service.getState();
        expect(
          currentState.organizations.map(
            (organization): string => organization.id,
          ),
        ).toEqual(replacement === null ? [] : [ORG_A]);

        resolveRead({ status: 'current', value: account('alice', []) });
        await jest.advanceTimersByTimeAsync(0);
        await service.whenIdle();
        expect(service.getState()).toEqual(currentState);
        expect(accountStore.peekCanopyCloudAccount()?.account?.id ?? null).toBe(
          replacement?.account?.id ?? null,
        );
        await expect(
          accountStore.readCanopyCloudAccountWithStatus(),
        ).resolves.toEqual(replacementRead);
        expect(migrate).toHaveBeenCalledTimes(
          transition === 'foreign legacy skip' ? 3 : 2,
        );
        await jest.advanceTimersByTimeAsync(120_000);
        expect(mockReadAccountWithStatus).toHaveBeenCalledTimes(2);
      } finally {
        service.dispose();
        accountStore.invalidateCanopyCloudAccountCache();
        migrate.mockReset();
        jest.useRealTimers();
      }
    },
  );

  it('re-reads an unavailable account store and adopts the entry when it recovers', async () => {
    jest.useFakeTimers();
    try {
      mockReadFile.mockResolvedValue(
        persisted({ acct: { context: `org:${ORG_A}`, revision: 2 } }),
      );
      mockReadAccountWithStatus
        .mockResolvedValueOnce({ status: 'unavailable' })
        .mockResolvedValueOnce({ status: 'unavailable' })
        .mockResolvedValueOnce({
          status: 'ok',
          entry: account('acct', [{ id: ORG_A, name: 'Acme' }]),
        });
      const service = createWorkspaceContextService();
      await service.initialize();
      expect(service.getState().context).toEqual({ kind: 'personal' });

      // First retry still unavailable, second retry answers.
      await jest.advanceTimersByTimeAsync(2_000);
      expect(service.getState().context).toEqual({ kind: 'personal' });
      await jest.advanceTimersByTimeAsync(5_000);
      await jest.advanceTimersByTimeAsync(0);
      expect(service.getState()).toMatchObject({
        context: { kind: 'organization', organizationId: ORG_A },
        revision: 2,
      });
      expect(mockReadAccountWithStatus).toHaveBeenCalledTimes(3);
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('rollout flag', () => {
  beforeEach(() => {
    __resetWorkspaceContextServiceForTests();
    jest.clearAllMocks();
    mockRolloutEnabled = true;
    flagListener = null;
  });

  it('disables main-process list scoping while the rollout is off', () => {
    mockRolloutEnabled = false;
    expect(getWorkspaceScopingContext()).toBeUndefined();

    mockRolloutEnabled = true;
    expect(getWorkspaceScopingContext()).toEqual({ kind: 'personal' });
  });

  it('reconciles a disable during initialization so re-enable broadcasts', async (): Promise<void> => {
    let release: (entry: CanopyCloudAccountEntry) => void = (): void => {};
    let started: () => void = (): void => {};
    const reading = new Promise<void>((resolve): void => {
      started = resolve;
    });
    mockLoadAccount.mockImplementationOnce(
      (): Promise<CanopyCloudAccountEntry> => {
        started();
        return new Promise((resolve): void => {
          release = resolve;
        });
      },
    );
    mockReadFile.mockResolvedValueOnce(
      persisted({ 'user-1': { context: `org:${ORG_A}`, revision: 4 } }),
    );
    const service = createWorkspaceContextService();
    const events: WorkspaceContextBroadcast[] = [];
    service.subscribe((event): void => {
      events.push(event);
    });
    try {
      const initializing = service.initialize();
      await reading;
      expect(flagListener).toBeNull();
      mockRolloutEnabled = false;
      release(account('user-1', [{ id: ORG_A, name: 'A' }]));
      await initializing;
      await service.whenIdle();
      expect(service.getState()).toMatchObject({
        context: { kind: 'personal' },
        organizations: [],
      });
      events.length = 0;
      mockRolloutEnabled = true;
      flagListener?.();
      await service.whenIdle();
      expect(events).toEqual([
        expect.objectContaining({
          context: { kind: 'organization', organizationId: ORG_A },
          organizations: [{ id: ORG_A, name: 'A', role: 'MEMBER' }],
          revision: 4,
          reason: 'organizations',
        }),
      ]);
      expect(mockWriteFileAtomically).not.toHaveBeenCalled();
    } finally {
      service.dispose();
    }
  });

  it('projects the resolved switch and serializes a flag flip while persistence is blocked', async (): Promise<void> => {
    mockLoadAccount.mockResolvedValue(
      account('user-1', [{ id: ORG_A, name: 'A' }]),
    );
    const service = createWorkspaceContextService();
    await service.initialize();
    const events: WorkspaceContextBroadcast[] = [];
    service.subscribe((event): void => {
      events.push(event);
    });
    let release: () => void = (): void => {};
    let started: () => void = (): void => {};
    const writing = new Promise<void>((resolve): void => {
      started = resolve;
    });
    mockWriteFileAtomically.mockImplementationOnce((): Promise<void> => {
      started();
      return new Promise<void>((resolve): void => {
        release = resolve;
      });
    });
    try {
      const switching = service.setContext({
        kind: 'organization',
        organizationId: ORG_A,
      });
      await writing;
      mockRolloutEnabled = false;
      flagListener?.();
      expect(events).toEqual([]);
      release();
      const result = await switching;
      await service.whenIdle();
      expect(result).toEqual(service.getState());
      expect(result).toMatchObject({
        context: { kind: 'personal' },
        organizations: [],
      });
      expect(events).toEqual([
        { ...result, reason: 'switch' },
        { ...result, reason: 'organizations' },
      ]);
      mockRolloutEnabled = true;
      flagListener?.();
      await service.whenIdle();
      expect(service.getState().context).toEqual({
        kind: 'organization',
        organizationId: ORG_A,
      });
    } finally {
      release();
      await service.whenIdle();
      service.dispose();
    }
  });

  it('projects Personal with no organizations while the flag is off, keeps the persisted selection, and re-broadcasts on a flip', async () => {
    mockRolloutEnabled = false;
    mockLoadAccount.mockResolvedValue(
      account('user-1', [{ id: ORG_A, name: 'A' }]),
    );
    mockReadFile.mockResolvedValue(
      persisted({ 'user-1': { context: `org:${ORG_A}`, revision: 4 } }),
    );
    const service = createWorkspaceContextService();
    const events: WorkspaceContextBroadcast[] = [];
    service.subscribe((state) => events.push(state));
    await service.initialize();
    expect(service.getState()).toMatchObject({
      context: { kind: 'personal' },
      organizations: [],
      revision: 4,
    });
    expect(mockWriteFileAtomically).not.toHaveBeenCalled();
    await expect(
      service.setContext({ kind: 'organization', organizationId: ORG_A }),
    ).rejects.toBeInstanceOf(WorkspaceContextError);
    expect(events).toEqual([]);
    mockRolloutEnabled = true;
    flagListener?.();
    await service.whenIdle();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      context: { kind: 'organization', organizationId: ORG_A },
      organizations: [{ id: ORG_A }],
      reason: 'organizations',
    });
    expect(service.getState().context).toEqual({
      kind: 'organization',
      organizationId: ORG_A,
    });
    mockRolloutEnabled = false;
    flagListener?.();
    await service.whenIdle();
    expect(events).toHaveLength(2);
    expect(events[1]).toMatchObject({
      context: { kind: 'personal' },
      organizations: [],
    });
    service.dispose();
    expect(flagListener).toBeNull();
  });
});
