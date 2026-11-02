jest.mock('node:fs/promises', () => ({
  mkdir: jest.fn(() => Promise.resolve()),
  readFile: jest.fn(),
  rm: jest.fn(() => Promise.resolve()),
}));
jest.mock('../lib/atomic-file', () => ({
  writeFileAtomically: jest.fn(),
}));
jest.mock('../lib/paths', () => ({
  getMcpOAuthTokenStorePath: jest.fn(() => '/mock/mcp-oauth-tokens.json'),
  getInternalLegacySharedMcpOAuthTokenStorePath: jest.fn(() => null),
  getLegacyMcpOAuthTokenStorePath: jest.fn(
    () => '/mock/userData/mcp-oauth-tokens.json',
  ),
}));

interface SafeStorageMock {
  encryptionAvailable: boolean;
  isEncryptionAvailable: jest.Mock<boolean, []>;
  encryptString: jest.Mock<Buffer, [string]>;
  decryptString: jest.Mock<string, [Buffer]>;
}

const safeStorageMock: SafeStorageMock = {
  encryptionAvailable: true,
  isEncryptionAvailable: jest.fn(
    (): boolean => safeStorageMock.encryptionAvailable,
  ),
  encryptString: jest.fn(
    (text: string): Buffer => Buffer.from(`encrypted:${text}`),
  ),
  decryptString: jest.fn((encrypted: Buffer): string =>
    encrypted.toString('utf8').replace(/^encrypted:/, ''),
  ),
};

jest.mock('electron', () => ({
  app: { isReady: (): boolean => true },
  safeStorage: {
    isEncryptionAvailable: (): boolean =>
      safeStorageMock.isEncryptionAvailable(),
    getSelectedStorageBackend: (): string => 'gnome_libsecret',
    encryptString: (text: string): Buffer =>
      safeStorageMock.encryptString(text),
    decryptString: (data: Buffer): string =>
      safeStorageMock.decryptString(data),
  },
}));

import { readFile, rm } from 'node:fs/promises';
import { writeFileAtomically } from '../lib/atomic-file';
import { getInternalLegacySharedMcpOAuthTokenStorePath } from '../lib/paths';
import {
  clearMcpOAuthToken,
  getMcpOAuthAuthStatus,
  getMcpOAuthAuthStatusForDefinition,
  getMcpOAuthToken,
  getMcpOAuthTokenRevision,
  recordMcpOAuthTokenError,
  saveMcpOAuthToken,
  saveMcpOAuthTokenIfCurrent,
  invalidateMcpOAuthAccessToken,
  migratePluginMcpOAuthToken,
  setMcpOAuthTokensChangedListener,
} from '../mcp/oauth-token-store';

const readFileMock = jest.mocked(readFile);
const rmMock = jest.mocked(rm);
const writeFileMock = jest.mocked(writeFileAtomically);
const internalLegacyPathMock = jest.mocked(
  getInternalLegacySharedMcpOAuthTokenStorePath,
);

const migrationDefinition = {
  id: 'canonical-server',
  name: 'Plugin',
  description: '',
  type: 'http' as const,
  url: 'https://vendor.test/mcp',
  oauth: { clientId: 'vendor-client' },
  createdAt: '',
  updatedAt: '',
};
const migrationConfig = {
  id: 'canonical-config',
  name: 'Plugin',
  description: '',
  enabled: true,
  envVars: {},
  extraArgs: [],
  extraHeaders: {},
  createdAt: '',
  updatedAt: '',
};
const migrationSource = {
  serverId: 'legacy-server',
  configId: 'legacy-config',
  allowDiscoveredClient: false,
};

it.each([
  'matching',
  'wrong-endpoint',
  'wrong-client',
  'unbound-client',
] as const)(
  'migrates only endpoint/client-bound legacy credentials: %s',
  async (binding) => {
    await saveMcpOAuthToken({
      ...migrationSource,
      accessToken: 'saved-access',
      refreshToken: 'saved-refresh',
      tokenType: 'Bearer',
      updatedAt: '2026-09-23T00:00:00.000Z',
      upstreamUrl:
        binding === 'wrong-endpoint'
          ? 'https://other.test/mcp'
          : migrationDefinition.url,
      clientId:
        binding === 'wrong-client'
          ? 'other-client'
          : binding === 'unbound-client'
            ? undefined
            : 'vendor-client',
    });
    await migratePluginMcpOAuthToken(migrationDefinition, migrationConfig, [
      migrationSource,
    ]);
    const destination = await getMcpOAuthToken(
      migrationDefinition.id,
      migrationConfig.id,
    );
    const legacy = await getMcpOAuthToken(
      migrationSource.serverId,
      migrationSource.configId,
    );
    if (binding === 'matching') {
      expect(destination).toMatchObject({
        accessToken: 'saved-access',
        refreshToken: 'saved-refresh',
      });
      expect(legacy).toBeNull();
      await clearMcpOAuthToken(migrationDefinition.id, migrationConfig.id);
      await migratePluginMcpOAuthToken(migrationDefinition, migrationConfig, [
        migrationSource,
      ]);
      expect(
        await getMcpOAuthToken(migrationDefinition.id, migrationConfig.id),
      ).toBeNull();
    } else {
      expect(destination).toBeNull();
      expect(legacy?.accessToken).toBe('saved-access');
    }
  },
);

it('preserves a newer destination and serializes legacy migration with disconnect', async () => {
  const token = {
    accessToken: 'old',
    refreshToken: 'refresh',
    tokenType: 'Bearer',
    updatedAt: '2026-09-23T00:00:00.000Z',
    upstreamUrl: migrationDefinition.url,
    clientId: 'vendor-client',
  };
  await saveMcpOAuthToken({ ...token, ...migrationSource });
  await saveMcpOAuthToken({
    ...token,
    serverId: migrationDefinition.id,
    configId: migrationConfig.id,
    accessToken: 'new',
  });
  await migratePluginMcpOAuthToken(migrationDefinition, migrationConfig, [
    migrationSource,
  ]);
  expect(
    (await getMcpOAuthToken(migrationDefinition.id, migrationConfig.id))
      ?.accessToken,
  ).toBe('new');
  expect(
    await getMcpOAuthToken(migrationSource.serverId, migrationSource.configId),
  ).toBeNull();
  await saveMcpOAuthToken({ ...token, ...migrationSource });
  await clearMcpOAuthToken(migrationDefinition.id, migrationConfig.id);
  await Promise.all([
    clearMcpOAuthToken(migrationSource.serverId, migrationSource.configId),
    migratePluginMcpOAuthToken(migrationDefinition, migrationConfig, [
      migrationSource,
    ]),
  ]);
  expect(
    await getMcpOAuthToken(migrationDefinition.id, migrationConfig.id),
  ).toBeNull();
});

it('does not guess a dynamically registered client across legacy provider slots', async () => {
  await saveMcpOAuthToken({
    ...migrationSource,
    accessToken: 'access',
    clientId: 'registered-client',
    upstreamUrl: migrationDefinition.url,
    tokenType: 'Bearer',
    updatedAt: '2026-09-23T00:00:00.000Z',
  });
  const dynamicDefinition = {
    ...migrationDefinition,
    oauth: { usePkce: true },
  };
  await migratePluginMcpOAuthToken(dynamicDefinition, migrationConfig, [
    migrationSource,
  ]);
  expect(
    await getMcpOAuthToken(dynamicDefinition.id, migrationConfig.id),
  ).toBeNull();
  await migratePluginMcpOAuthToken(dynamicDefinition, migrationConfig, [
    { ...migrationSource, allowDiscoveredClient: true },
  ]);
  expect(
    (await getMcpOAuthToken(dynamicDefinition.id, migrationConfig.id))
      ?.clientId,
  ).toBe('registered-client');
});

it('leaves credential migration optional when secure storage is unavailable', async () => {
  safeStorageMock.encryptionAvailable = false;
  await expect(
    migratePluginMcpOAuthToken(migrationDefinition, migrationConfig, [
      migrationSource,
    ]),
  ).resolves.toBeUndefined();
  expect(writeFileMock).not.toHaveBeenCalled();
});

let storedPayload: string | null = null;

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  setMcpOAuthTokensChangedListener(null);
  safeStorageMock.encryptionAvailable = true;
  safeStorageMock.encryptString.mockImplementation(
    (text: string): Buffer => Buffer.from(`encrypted:${text}`),
  );
  safeStorageMock.decryptString.mockImplementation(
    (encrypted: Buffer): string =>
      encrypted.toString('utf8').replace(/^encrypted:/, ''),
  );
  internalLegacyPathMock.mockReturnValue(null);
  storedPayload = null;
  readFileMock.mockImplementation(() => {
    if (storedPayload === null) {
      return Promise.reject(
        Object.assign(new Error('ENOENT'), { code: 'ENOENT' }),
      );
    }
    return Promise.resolve(storedPayload);
  });
  writeFileMock.mockImplementation(
    (_path: unknown, content: unknown): Promise<void> => {
      if (typeof content === 'string') {
        storedPayload = content;
      } else if (content instanceof Uint8Array) {
        storedPayload = Buffer.from(content).toString('utf8');
      } else {
        storedPayload = JSON.stringify(content);
      }
      return Promise.resolve();
    },
  );
  rmMock.mockResolvedValue(undefined);
});

it('migrates a legacy MCP file only when every encrypted record is readable', async () => {
  internalLegacyPathMock.mockReturnValue('/mock/stable/mcp-oauth-tokens.json');
  safeStorageMock.encryptString.mockImplementation(
    (text: string): Buffer => Buffer.from(`internal:${text}`),
  );
  const legacy = JSON.stringify({
    version: 1,
    records: {
      'server-1:config-1': {
        serverId: 'server-1',
        configId: 'config-1',
        encryptedAccessTokenBase64:
          Buffer.from('encrypted:access').toString('base64'),
        encryptedRefreshTokenBase64:
          Buffer.from('encrypted:refresh').toString('base64'),
        tokenType: 'Bearer',
        updatedAt: '2026-04-29T00:00:00.000Z',
      },
    },
  });
  readFileMock
    .mockRejectedValueOnce(
      Object.assign(new Error('missing'), { code: 'ENOENT' }),
    )
    .mockResolvedValueOnce(legacy);

  await expect(getMcpOAuthToken('server-1', 'config-1')).resolves.toMatchObject(
    {
      accessToken: 'access',
      refreshToken: 'refresh',
    },
  );
  expect(writeFileMock).toHaveBeenCalledWith(
    '/mock/mcp-oauth-tokens.json',
    expect.any(String),
    { encoding: 'utf8', mode: 0o600, overwrite: false },
  );
  expect(storedPayload).toContain(
    Buffer.from('internal:access').toString('base64'),
  );
  expect(storedPayload).not.toContain(
    Buffer.from('encrypted:access').toString('base64'),
  );
});

it('skips the entire foreign legacy MCP file when one record cannot decrypt', async () => {
  internalLegacyPathMock.mockReturnValue('/mock/stable/mcp-oauth-tokens.json');
  const legacy = JSON.stringify({
    version: 1,
    records: {
      'server-1:config-1': {
        serverId: 'server-1',
        configId: 'config-1',
        encryptedAccessTokenBase64:
          Buffer.from('encrypted:ok').toString('base64'),
        tokenType: 'Bearer',
        updatedAt: '2026-04-29T00:00:00.000Z',
      },
      'server-2:config-2': {
        serverId: 'server-2',
        configId: 'config-2',
        encryptedAccessTokenBase64: Buffer.from('foreign').toString('base64'),
        tokenType: 'Bearer',
        updatedAt: '2026-04-29T00:00:00.000Z',
      },
    },
  });
  readFileMock
    .mockRejectedValueOnce(
      Object.assign(new Error('missing'), { code: 'ENOENT' }),
    )
    .mockResolvedValueOnce(legacy);
  safeStorageMock.decryptString.mockImplementation((encrypted) => {
    const value = encrypted.toString('utf8');
    if (value === 'foreign') throw new Error('wrong identity');
    return value.replace(/^encrypted:/, '');
  });

  await expect(getMcpOAuthToken('server-1', 'config-1')).resolves.toBeNull();
  expect(writeFileMock).not.toHaveBeenCalled();
});

it('saves and loads encrypted OAuth tokens', async () => {
  await saveMcpOAuthToken({
    serverId: 'server-1',
    configId: 'config-1',
    accessToken: 'access-token',
    refreshToken: 'refresh-token',
    upstreamUrl: 'https://mcp.example.com/mcp',
    tokenUrl: 'https://auth.example.com/token',
    tokenUrlRequiresPublicAddress: true,
    tokenType: 'Bearer',
    scope: 'read write',
    expiresAt: '2099-01-01T00:00:00.000Z',
    updatedAt: '2026-04-29T00:00:00.000Z',
  });

  expect(storedPayload).toContain(
    Buffer.from('encrypted:access-token').toString('base64'),
  );
  expect(storedPayload).not.toContain('access-token"');
  expect(rmMock).toHaveBeenCalledWith('/mock/userData/mcp-oauth-tokens.json', {
    force: true,
  });

  await expect(getMcpOAuthToken('server-1', 'config-1')).resolves.toMatchObject(
    {
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      upstreamUrl: 'https://mcp.example.com/mcp',
      tokenUrl: 'https://auth.example.com/token',
      tokenUrlRequiresPublicAddress: true,
      tokenType: 'Bearer',
      scope: 'read write',
    },
  );
});

it('exposes a non-secret revision that changes with stored OAuth state', async () => {
  await expect(getMcpOAuthTokenRevision('server-1', 'config-1')).resolves.toBe(
    'missing',
  );

  await saveMcpOAuthToken({
    serverId: 'server-1',
    configId: 'config-1',
    accessToken: 'access-token',
    tokenType: 'Bearer',
    updatedAt: '2026-04-29T00:00:00.000Z',
  });
  await expect(getMcpOAuthTokenRevision('server-1', 'config-1')).resolves.toBe(
    '2026-04-29T00:00:00.000Z',
  );

  await clearMcpOAuthToken('server-1', 'config-1');
  await expect(getMcpOAuthTokenRevision('server-1', 'config-1')).resolves.toBe(
    'missing',
  );
});

it('reports expired token status', async () => {
  await saveMcpOAuthToken({
    serverId: 'server-1',
    configId: 'config-1',
    accessToken: 'access-token',
    tokenType: 'Bearer',
    expiresAt: '2000-01-01T00:00:00.000Z',
    updatedAt: '2026-04-29T00:00:00.000Z',
  });

  await expect(getMcpOAuthAuthStatus('server-1', 'config-1')).resolves.toEqual({
    status: 'expired',
    hasStoredToken: true,
  });
});

// CAN-1814 review. `expired` alone is not a dead end: `getValidMcpAccessToken`
// refreshes an expired access token whenever a refresh credential is stored, so
// the send preflight needs that fact to avoid refusing turns that would have
// worked. Reported off the record this read already decrypted — no extra I/O.
it('reports an expired token as refreshable when a refresh credential is stored', async () => {
  await saveMcpOAuthToken({
    serverId: 'server-1',
    configId: 'config-1',
    accessToken: 'access-token',
    refreshToken: 'refresh-token',
    tokenType: 'Bearer',
    expiresAt: '2000-01-01T00:00:00.000Z',
    updatedAt: '2026-04-29T00:00:00.000Z',
  });

  await expect(getMcpOAuthAuthStatus('server-1', 'config-1')).resolves.toEqual({
    status: 'expired',
    hasStoredToken: true,
    canRefresh: true,
  });
});

it('clears stale upstream bindings from definition-aware auth status checks', async () => {
  await saveMcpOAuthToken({
    serverId: 'server-1',
    configId: 'config-1',
    accessToken: 'access-token',
    upstreamUrl: 'https://old.example.com/mcp',
    tokenType: 'Bearer',
    updatedAt: '2026-04-29T00:00:00.000Z',
  });

  await expect(
    getMcpOAuthAuthStatusForDefinition(
      {
        id: 'server-1',
        name: 'OAuth Server',
        description: '',
        type: 'http',
        url: 'https://new.example.com/mcp',
        createdAt: '2026-04-29T00:00:00.000Z',
        updatedAt: '2026-04-29T00:00:00.000Z',
      },
      {
        id: 'config-1',
        name: 'Default',
        description: '',
        enabled: true,
        envVars: {},
        extraArgs: [],
        extraHeaders: {},
        createdAt: '2026-04-29T00:00:00.000Z',
        updatedAt: '2026-04-29T00:00:00.000Z',
      },
    ),
  ).resolves.toEqual({ status: 'not_connected' });

  await expect(getMcpOAuthToken('server-1', 'config-1')).resolves.toBeNull();
});

it('retains undecryptable stored tokens and reports storage failure', async () => {
  storedPayload = JSON.stringify({
    version: 1,
    records: {
      'server-1:config-1': {
        serverId: 'server-1',
        configId: 'config-1',
        encryptedAccessTokenBase64:
          Buffer.from('corrupt-token').toString('base64'),
        upstreamUrl: 'https://mcp.example.com/mcp',
        tokenType: 'Bearer',
        updatedAt: '2026-04-29T00:00:00.000Z',
      },
    },
  });
  safeStorageMock.decryptString.mockImplementationOnce((): string => {
    throw new Error(
      'Error while decrypting the ciphertext provided to safeStorage.decryptString.',
    );
  });

  await expect(
    getMcpOAuthAuthStatusForDefinition(
      {
        id: 'server-1',
        name: 'OAuth Server',
        description: '',
        type: 'http',
        url: 'https://mcp.example.com/mcp',
        createdAt: '2026-04-29T00:00:00.000Z',
        updatedAt: '2026-04-29T00:00:00.000Z',
      },
      {
        id: 'config-1',
        name: 'Default',
        description: '',
        enabled: true,
        envVars: {},
        extraArgs: [],
        extraHeaders: {},
        createdAt: '2026-04-29T00:00:00.000Z',
        updatedAt: '2026-04-29T00:00:00.000Z',
      },
    ),
  ).resolves.toMatchObject({
    status: 'error',
    secureStorageFailure: { code: 'SECURE_STORAGE_DECRYPT_FAILED' },
  });

  expect(
    Object.keys(
      (
        JSON.parse(storedPayload ?? '{}') as {
          records?: Record<string, unknown>;
        }
      ).records ?? {},
    ),
  ).toEqual(['server-1:config-1']);
  expect(writeFileMock).not.toHaveBeenCalled();
});

it('rejects undecryptable reads without attempting cleanup', async () => {
  storedPayload = JSON.stringify({
    version: 1,
    records: {
      'server-1:config-1': {
        serverId: 'server-1',
        configId: 'config-1',
        encryptedAccessTokenBase64:
          Buffer.from('corrupt-token').toString('base64'),
        upstreamUrl: 'https://mcp.example.com/mcp',
        tokenType: 'Bearer',
        updatedAt: '2026-04-29T00:00:00.000Z',
      },
    },
  });
  safeStorageMock.decryptString.mockImplementationOnce((): string => {
    throw new Error(
      'Error while decrypting the ciphertext provided to safeStorage.decryptString.',
    );
  });
  const before = storedPayload;

  await expect(getMcpOAuthToken('server-1', 'config-1')).rejects.toThrow();
  expect(storedPayload).toBe(before);
  expect(writeFileMock).not.toHaveBeenCalled();
});

it('preserves newer tokens saved while a decrypt fails', async () => {
  storedPayload = JSON.stringify({
    version: 1,
    records: {
      'server-1:config-1': {
        serverId: 'server-1',
        configId: 'config-1',
        encryptedAccessTokenBase64:
          Buffer.from('corrupt-token').toString('base64'),
        upstreamUrl: 'https://mcp.example.com/mcp',
        tokenType: 'Bearer',
        updatedAt: '2026-04-29T00:00:00.000Z',
      },
    },
  });
  const replacementSaves: Array<Promise<void>> = [];
  safeStorageMock.decryptString.mockImplementationOnce((): string => {
    replacementSaves.push(
      saveMcpOAuthToken({
        serverId: 'server-1',
        configId: 'config-1',
        accessToken: 'replacement-token',
        upstreamUrl: 'https://mcp.example.com/mcp',
        tokenType: 'Bearer',
        updatedAt: '2026-04-29T00:00:01.000Z',
      }),
    );
    throw new Error(
      'Error while decrypting the ciphertext provided to safeStorage.decryptString.',
    );
  });

  await expect(getMcpOAuthToken('server-1', 'config-1')).rejects.toThrow();
  await Promise.all(replacementSaves);
  await expect(getMcpOAuthToken('server-1', 'config-1')).resolves.toMatchObject(
    {
      accessToken: 'replacement-token',
      tokenType: 'Bearer',
    },
  );
});

it('records first-time OAuth errors for auth status polling', async () => {
  await recordMcpOAuthTokenError(
    'server-1',
    'config-1',
    'access_denied: rejected',
  );

  const authStatus = await getMcpOAuthAuthStatus('server-1', 'config-1');
  expect(authStatus).toMatchObject({
    status: 'error',
    lastError: 'access_denied: rejected',
    hasStoredToken: true,
  });
  expect(typeof authStatus.authErrorRevision).toBe('string');
  await expect(getMcpOAuthToken('server-1', 'config-1')).resolves.toMatchObject(
    {
      accessToken: '',
      tokenType: 'Bearer',
      lastError: 'access_denied: rejected',
    },
  );
});

it('preserves first-time OAuth errors for definition-aware auth status polling', async () => {
  await recordMcpOAuthTokenError(
    'server-1',
    'config-1',
    'access_denied: rejected',
    {
      upstreamUrl: 'https://mcp.example.com/mcp',
    },
  );

  const authStatus = await getMcpOAuthAuthStatusForDefinition(
    {
      id: 'server-1',
      name: 'OAuth Server',
      description: '',
      type: 'http',
      url: 'https://mcp.example.com/mcp',
      createdAt: '2026-04-29T00:00:00.000Z',
      updatedAt: '2026-04-29T00:00:00.000Z',
    },
    {
      id: 'config-1',
      name: 'Default',
      description: '',
      enabled: true,
      envVars: {},
      extraArgs: [],
      extraHeaders: {},
      createdAt: '2026-04-29T00:00:00.000Z',
      updatedAt: '2026-04-29T00:00:00.000Z',
    },
  );
  expect(authStatus).toMatchObject({
    status: 'error',
    lastError: 'access_denied: rejected',
    hasStoredToken: true,
  });
  expect(typeof authStatus.authErrorRevision).toBe('string');
});

it('updates existing OAuth records with the last error', async () => {
  await saveMcpOAuthToken({
    serverId: 'server-1',
    configId: 'config-1',
    accessToken: 'access-token',
    tokenType: 'Bearer',
    updatedAt: '2026-04-29T00:00:00.000Z',
  });

  await recordMcpOAuthTokenError('server-1', 'config-1', 'refresh failed');

  const authStatus = await getMcpOAuthAuthStatus('server-1', 'config-1');
  expect(authStatus).toMatchObject({
    status: 'error',
    lastError: 'refresh failed',
    hasStoredToken: true,
  });
  expect(typeof authStatus.authErrorRevision).toBe('string');
});

it('clears stored tokens', async () => {
  await saveMcpOAuthToken({
    serverId: 'server-1',
    configId: 'config-1',
    accessToken: 'access-token',
    tokenType: 'Bearer',
    updatedAt: '2026-04-29T00:00:00.000Z',
  });

  await clearMcpOAuthToken('server-1', 'config-1');

  await expect(getMcpOAuthToken('server-1', 'config-1')).resolves.toBeNull();
});

it('serializes concurrent token mutations so records are not lost', async () => {
  storedPayload = JSON.stringify({ version: 1, records: {} });
  let delayedReadsRemaining = 2;
  readFileMock.mockImplementation((): Promise<string> => {
    if (storedPayload === null) {
      return Promise.reject(new Error('ENOENT'));
    }
    const snapshot = storedPayload;
    if (delayedReadsRemaining > 0) {
      delayedReadsRemaining -= 1;
      return new Promise((resolve) => {
        setTimeout(() => resolve(snapshot), 10);
      });
    }
    return Promise.resolve(snapshot);
  });
  writeFileMock.mockImplementation(
    (_path: unknown, content: unknown): Promise<void> => {
      const serialized =
        typeof content === 'string'
          ? content
          : content instanceof Uint8Array
            ? Buffer.from(content).toString('utf8')
            : JSON.stringify(content);
      return new Promise((resolve) => {
        setTimeout(() => {
          storedPayload = serialized;
          resolve();
        }, 5);
      });
    },
  );

  await Promise.all([
    saveMcpOAuthToken({
      serverId: 'server-1',
      configId: 'config-1',
      accessToken: 'access-token-1',
      tokenType: 'Bearer',
      updatedAt: '2026-04-29T00:00:00.000Z',
    }),
    saveMcpOAuthToken({
      serverId: 'server-2',
      configId: 'config-2',
      accessToken: 'access-token-2',
      tokenType: 'Bearer',
      updatedAt: '2026-04-29T00:00:00.000Z',
    }),
  ]);

  await wait(5);

  if (storedPayload === null) {
    throw new Error('Expected stored token payload.');
  }
  const parsed = JSON.parse(storedPayload) as {
    version: number;
    records: Record<string, unknown>;
  };
  expect(Object.keys(parsed.records).sort()).toEqual([
    'server-1:config-1',
    'server-2:config-2',
  ]);
});

it('surfaces secure storage unavailable without persisting tokens', async () => {
  safeStorageMock.encryptionAvailable = false;

  await expect(
    saveMcpOAuthToken({
      serverId: 'server-1',
      configId: 'config-1',
      accessToken: 'access-token',
      tokenType: 'Bearer',
      updatedAt: '2026-04-29T00:00:00.000Z',
    }),
  ).rejects.toThrow('Secure storage unavailable');
  expect(writeFileMock).not.toHaveBeenCalled();
  await expect(
    getMcpOAuthAuthStatus('server-1', 'config-1'),
  ).resolves.toMatchObject({
    status: 'error',
    lastError: 'Secure storage unavailable',
    secureStorageFailure: { code: 'SECURE_STORAGE_READ_UNAVAILABLE' },
  });
});

it('does not rebind a newer connection when an old upstream reports an error', async () => {
  await saveMcpOAuthToken({
    serverId: 'server-1',
    configId: 'config-1',
    accessToken: 'new-account-token',
    upstreamUrl: 'https://new.example.test/mcp',
    tokenType: 'Bearer',
    updatedAt: '2026-09-05T00:00:00.000Z',
  });
  await recordMcpOAuthTokenError('server-1', 'config-1', 'old request failed', {
    upstreamUrl: 'https://old.example.test/mcp',
  });
  await expect(getMcpOAuthToken('server-1', 'config-1')).resolves.toMatchObject(
    {
      accessToken: 'new-account-token',
      upstreamUrl: 'https://new.example.test/mcp',
    },
  );
  await expect(getMcpOAuthAuthStatus('server-1', 'config-1')).resolves.toEqual({
    status: 'connected',
    hasStoredToken: true,
  });
});

it('does not advertise renewal without a usable client and token endpoint', async () => {
  await saveMcpOAuthToken({
    serverId: 'server-1',
    configId: 'config-1',
    accessToken: 'old-token',
    refreshToken: 'refresh',
    upstreamUrl: 'https://example.test/mcp',
    tokenType: 'Bearer',
    expiresAt: '2000-01-01T00:00:00.000Z',
    updatedAt: '2026-09-05T00:00:00.000Z',
  });
  await expect(
    getMcpOAuthAuthStatusForDefinition(
      {
        id: 'server-1',
        name: 'Server',
        description: '',
        type: 'http',
        url: 'https://example.test/mcp',
        createdAt: '',
        updatedAt: '',
      },
      {
        id: 'config-1',
        name: 'Default',
        description: '',
        enabled: true,
        envVars: {},
        extraArgs: [],
        extraHeaders: {},
        createdAt: '',
        updatedAt: '',
      },
    ),
  ).resolves.toEqual({
    status: 'expired',
    expiresAt: '2000-01-01T00:00:00.000Z',
    hasStoredToken: true,
  });
});

it('does not resurrect disconnected credentials when a refresh completes late', async () => {
  await saveMcpOAuthToken({
    serverId: 'server',
    configId: 'config',
    accessToken: 'old',
    refreshToken: 'refresh',
    tokenType: 'Bearer',
    updatedAt: 'before',
  });
  const expected = await getMcpOAuthToken('server', 'config');
  if (!expected) throw new Error('Missing fixture token');
  await clearMcpOAuthToken('server', 'config');
  await expect(
    saveMcpOAuthTokenIfCurrent(
      { ...expected, accessToken: 'new', updatedAt: 'after' },
      expected,
    ),
  ).resolves.toBe(false);
  await expect(getMcpOAuthToken('server', 'config')).resolves.toBeNull();
});

it('does not overwrite a newer login with a late refresh or rejected request', async () => {
  await saveMcpOAuthToken({
    serverId: 'server',
    configId: 'config',
    accessToken: 'old',
    refreshToken: 'refresh',
    upstreamUrl: 'https://example.test/mcp',
    tokenType: 'Bearer',
    updatedAt: 'before',
  });
  const expected = await getMcpOAuthToken('server', 'config');
  if (!expected) throw new Error('Missing fixture token');
  await saveMcpOAuthToken({
    ...expected,
    accessToken: 'new-login',
    updatedAt: 'login',
  });
  await expect(
    saveMcpOAuthTokenIfCurrent(
      { ...expected, accessToken: 'late-refresh' },
      expected,
    ),
  ).resolves.toBe(false);
  await invalidateMcpOAuthAccessToken(
    'server',
    'config',
    'old',
    'https://example.test/mcp',
  );
  await recordMcpOAuthTokenError('server', 'config', 'invalid grant', {
    accessToken: 'old',
    upstreamUrl: 'https://example.test/mcp',
  });
  await expect(getMcpOAuthToken('server', 'config')).resolves.toMatchObject({
    accessToken: 'new-login',
    updatedAt: 'login',
  });
  await expect(getMcpOAuthAuthStatus('server', 'config')).resolves.toEqual({
    status: 'connected',
    hasStoredToken: true,
  });
});

it('persists a rotated refresh result after same-grant access-token invalidation', async () => {
  await saveMcpOAuthToken({
    serverId: 'server',
    configId: 'config',
    accessToken: 'old',
    refreshToken: 'single-use-refresh',
    upstreamUrl: 'https://example.test/mcp',
    tokenType: 'Bearer',
    updatedAt: 'before',
  });
  const expected = await getMcpOAuthToken('server', 'config');
  if (!expected) throw new Error('Missing fixture token');

  await invalidateMcpOAuthAccessToken(
    'server',
    'config',
    'old',
    'https://example.test/mcp',
  );

  await expect(
    saveMcpOAuthTokenIfCurrent(
      {
        ...expected,
        accessToken: 'new',
        refreshToken: 'rotated-refresh',
        expiresAt: '2026-09-06T20:00:00.000Z',
        updatedAt: 'after',
      },
      expected,
    ),
  ).resolves.toBe(true);
  await expect(getMcpOAuthToken('server', 'config')).resolves.toMatchObject({
    accessToken: 'new',
    refreshToken: 'rotated-refresh',
    updatedAt: 'after',
  });
});

it('expires only the rejected access token and preserves the renewal grant', async () => {
  await saveMcpOAuthToken({
    serverId: 'server',
    configId: 'config',
    accessToken: 'old',
    refreshToken: 'refresh',
    upstreamUrl: 'https://example.test/mcp',
    tokenType: 'Bearer',
    updatedAt: 'before',
  });
  await invalidateMcpOAuthAccessToken(
    'server',
    'config',
    'old',
    'https://example.test/mcp',
  );
  await expect(getMcpOAuthAuthStatus('server', 'config')).resolves.toEqual({
    status: 'expired',
    canRefresh: true,
    hasStoredToken: true,
  });
  await expect(getMcpOAuthToken('server', 'config')).resolves.toMatchObject({
    refreshToken: 'refresh',
  });
});

it('canonicalizes the upstream URL before invalidating an access token', async () => {
  await saveMcpOAuthToken({
    serverId: 'server',
    configId: 'config',
    accessToken: 'old',
    refreshToken: 'refresh',
    upstreamUrl: 'https://example.test/',
    tokenType: 'Bearer',
    updatedAt: 'before',
  });

  await invalidateMcpOAuthAccessToken(
    'server',
    'config',
    'old',
    'https://example.test',
  );

  await expect(getMcpOAuthAuthStatus('server', 'config')).resolves.toEqual({
    status: 'expired',
    canRefresh: true,
    hasStoredToken: true,
  });
});

it('publishes changed server ids after durable writes and skips stale refresh notifications', async () => {
  const changed = jest.fn();
  setMcpOAuthTokensChangedListener(changed);
  await saveMcpOAuthToken({
    serverId: 'server',
    configId: 'config',
    accessToken: 'old',
    tokenType: 'Bearer',
    updatedAt: 'before',
  });
  expect(changed).toHaveBeenLastCalledWith(['server']);
  const expected = await getMcpOAuthToken('server', 'config');
  if (!expected) throw new Error('Missing fixture token');
  await saveMcpOAuthTokenIfCurrent(
    { ...expected, accessToken: 'new' },
    expected,
  );
  expect(changed).toHaveBeenCalledTimes(2);
  await saveMcpOAuthTokenIfCurrent(
    { ...expected, accessToken: 'late' },
    expected,
  );
  expect(changed).toHaveBeenCalledTimes(2);
  await clearMcpOAuthToken('server', 'config');
  expect(changed).toHaveBeenCalledTimes(3);
  setMcpOAuthTokensChangedListener(null);
});

it('checks cancellation at the credential and error persistence boundary', async () => {
  const record = {
    serverId: 'server',
    configId: 'config',
    accessToken: 'canceled',
    tokenType: 'Bearer',
    updatedAt: 'after',
  };
  await expect(
    saveMcpOAuthTokenIfCurrent(record, undefined, () => false),
  ).resolves.toBe(false);
  await recordMcpOAuthTokenError(
    'server',
    'config',
    'canceled error',
    undefined,
    () => false,
  );
  await expect(getMcpOAuthToken('server', 'config')).resolves.toBeNull();
});

it.each(['token', 'replacement', 'error'] as const)(
  'rolls back a canceled %s write before exposing it to readers or listeners',
  async (kind) => {
    const previous = {
      serverId: 'server',
      configId: 'config',
      accessToken: 'previous-account',
      tokenType: 'Bearer',
      updatedAt: 'before',
    };
    if (kind !== 'token') await saveMcpOAuthToken(previous);
    let current = true;
    let writeStarted = (): void => undefined;
    let releaseWrite = (): void => undefined;
    const started = new Promise<void>((resolve) => {
      writeStarted = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    writeFileMock.mockImplementationOnce(async (_path, content) => {
      storedPayload = String(content);
      writeStarted();
      await gate;
    });
    const changed = jest.fn();
    setMcpOAuthTokensChangedListener(changed);
    const save =
      kind === 'error'
        ? recordMcpOAuthTokenError(
            'server',
            'config',
            'abandoned error',
            undefined,
            () => current,
          )
        : saveMcpOAuthTokenIfCurrent(
            {
              ...previous,
              accessToken: 'abandoned-account',
              updatedAt: 'after',
            },
            undefined,
            () => current,
          );
    await started;
    current = false;
    let readSettled = false;
    let revisionSettled = false;
    const read = getMcpOAuthToken('server', 'config').then((token) => {
      readSettled = true;
      return token;
    });
    const revision = getMcpOAuthTokenRevision('server', 'config').then(
      (value) => {
        revisionSettled = true;
        return value;
      },
    );
    await wait(0);
    const exposedDuringWrite = readSettled || revisionSettled;
    releaseWrite();
    const result = await save;
    const token = await read;
    const storedRevision = await revision;
    expect(exposedDuringWrite).toBe(false);
    if (kind !== 'error') expect(result).toBe(false);
    expect(token).toEqual(kind === 'token' ? null : previous);
    expect(storedRevision).toBe(kind === 'token' ? 'missing' : 'before');
    expect(changed).not.toHaveBeenCalled();
    await expect(getMcpOAuthToken('server', 'config')).resolves.toEqual(
      kind === 'token' ? null : previous,
    );
  },
);

it('keeps a newer queued account when an earlier write is canceled', async () => {
  let current = true;
  let writeStarted = (): void => undefined;
  let releaseWrite = (): void => undefined;
  const started = new Promise<void>((resolve) => {
    writeStarted = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    releaseWrite = resolve;
  });
  writeFileMock.mockImplementationOnce(async (_path, content) => {
    storedPayload = String(content);
    writeStarted();
    await gate;
  });
  const record = {
    serverId: 'server',
    configId: 'config',
    accessToken: 'abandoned',
    tokenType: 'Bearer',
    updatedAt: 'before',
  };
  const abandoned = saveMcpOAuthTokenIfCurrent(
    record,
    undefined,
    () => current,
  );
  await started;
  current = false;
  const replacement = saveMcpOAuthToken({
    ...record,
    accessToken: 'new-account',
    updatedAt: 'after',
  });
  releaseWrite();
  const [saved] = await Promise.all([abandoned, replacement]);
  expect(saved).toBe(false);
  await expect(getMcpOAuthToken('server', 'config')).resolves.toMatchObject({
    accessToken: 'new-account',
  });
});

it('retains both fields and unrelated records without notifying after refresh-token encryption fails', async () => {
  const record = {
    serverId: 'one',
    configId: 'config',
    accessToken: 'old-access',
    refreshToken: 'old-refresh',
    tokenType: 'Bearer',
    updatedAt: 'before',
  };
  await saveMcpOAuthToken(record);
  await saveMcpOAuthToken({ ...record, serverId: 'other' });
  const before = storedPayload;
  const changed = jest.fn();
  setMcpOAuthTokensChangedListener(changed);
  writeFileMock.mockClear();
  safeStorageMock.encryptString
    .mockImplementationOnce((text) => Buffer.from(text))
    .mockImplementationOnce(() => {
      throw new Error('native diagnostic');
    });
  await expect(
    saveMcpOAuthToken({
      ...record,
      accessToken: 'new-access',
      refreshToken: 'new-refresh',
    }),
  ).rejects.toMatchObject({ code: 'SECURE_STORAGE_ENCRYPT_FAILED' });
  expect(storedPayload).toBe(before);
  expect(writeFileMock).not.toHaveBeenCalled();
  expect(changed).not.toHaveBeenCalled();
});

it.each(['{invalid', JSON.stringify({ version: 99, records: {} })])(
  'rejects mutations of an unreadable MCP file: %s',
  async (raw) => {
    storedPayload = raw;
    await expect(
      recordMcpOAuthTokenError('one', 'config', 'rejected'),
    ).rejects.toThrow();
    expect(storedPayload).toBe(raw);
    expect(writeFileMock).not.toHaveBeenCalled();
  },
);

it('does not treat local legacy read errors as absence', async () => {
  readFileMock
    .mockRejectedValueOnce(
      Object.assign(new Error('missing'), { code: 'ENOENT' }),
    )
    .mockRejectedValueOnce(
      Object.assign(new Error('cannot read'), { code: 'EACCES' }),
    );
  await expect(
    recordMcpOAuthTokenError('one', 'config', 'rejected'),
  ).rejects.toThrow('cannot read');
  expect(writeFileMock).not.toHaveBeenCalled();
});

it('redacts JSON parser input snippets from auth status errors', async () => {
  storedPayload =
    '{"encryptedAccessTokenBase64":"sensitive-ciphertext" bad-json';
  const result = await getMcpOAuthAuthStatus('one', 'config');
  expect(result).toEqual({
    status: 'error',
    lastError: 'Invalid MCP OAuth token store',
  });
  expect(JSON.stringify(result)).not.toContain('sensitive-ciphertext');
  expect(writeFileMock).not.toHaveBeenCalled();
});

it('retains source aliases and the existing unreadable migration destination', async () => {
  const token = {
    accessToken: 'readable-alias',
    refreshToken: 'readable-refresh',
    tokenType: 'Bearer',
    updatedAt: '2026-09-23T00:00:00.000Z',
    upstreamUrl: migrationDefinition.url,
    clientId: 'vendor-client',
  };
  await saveMcpOAuthToken({ ...token, ...migrationSource });
  await saveMcpOAuthToken({
    ...token,
    serverId: migrationDefinition.id,
    configId: migrationConfig.id,
    accessToken: 'unreadable-destination',
  });
  const before = storedPayload;
  const changed = jest.fn();
  setMcpOAuthTokensChangedListener(changed);
  writeFileMock.mockClear();
  safeStorageMock.decryptString.mockImplementation((encrypted): string => {
    const text = encrypted.toString().replace(/^encrypted:/, '');
    if (text === 'unreadable-destination') throw new Error('native diagnostic');
    return text;
  });
  await expect(
    migratePluginMcpOAuthToken(migrationDefinition, migrationConfig, [
      migrationSource,
    ]),
  ).resolves.toBeUndefined();
  expect(storedPayload).toBe(before);
  expect(writeFileMock).not.toHaveBeenCalled();
  expect(changed).not.toHaveBeenCalled();
  await expect(
    getMcpOAuthToken(migrationDefinition.id, migrationConfig.id),
  ).rejects.toMatchObject({ code: 'SECURE_STORAGE_DECRYPT_FAILED' });
  await expect(
    getMcpOAuthToken(migrationSource.serverId, migrationSource.configId),
  ).resolves.toMatchObject({ accessToken: 'readable-alias' });
});
