jest.mock('../installed-items/installed-item-events', () => ({
  notifyInstalledItemsChanged: jest.fn(),
}));
import { notifyInstalledItemsChanged } from '../installed-items/installed-item-events';
import { subscribeDesktopInventoryChanges } from '../services/desktop-inventory-sync-signals';
import { CanopyCloudClientError } from '../canopy-cloud/client';
import type * as AccountConnectionsModule from '../canopy-cloud/mcp-connections';
import type * as ServerRefRewriteModule from '../mcp/server-ref-rewrite';
jest.mock('../canopy-cloud/mcp-connections', (): object => {
  const actual = jest.requireActual<typeof AccountConnectionsModule>(
    '../canopy-cloud/mcp-connections',
  );
  return Object.defineProperties(
    {},
    {
      ...Object.getOwnPropertyDescriptors(actual),
      __esModule: { value: true, enumerable: true },
      listAccountMcpConnections: { value: jest.fn(), enumerable: true },
      findAccountMcpConnection: { value: jest.fn(), enumerable: true },
      invalidateAccountMcpConnections: { value: jest.fn(), enumerable: true },
    },
  );
});
import {
  invalidateAccountMcpConnections,
  listAccountMcpConnections,
  findAccountMcpConnection,
} from '../canopy-cloud/mcp-connections';
import { getMcpHttpAuthDefault } from '@canopy/desktop-shared/lib/mcp-http-auth';
import { stableStringify } from '@canopy/desktop-shared/lib/stable-hash';
import {
  AccountMcpConnectionError,
  isMcpServersIndexFile,
} from '@canopy/desktop-shared/types/mcp-servers';
/* eslint-disable @typescript-eslint/no-non-null-assertion */
import type * as NodeCrypto from 'node:crypto';
import type * as NodeChildProcess from 'node:child_process';
import { PassThrough } from 'node:stream';
import type { CuratedMcpServerListResponse } from '@canopy/protocol/mcp-catalog';
import type { PreferencesData } from '@canopy/desktop-shared/types';
import type {
  McpServerData,
  McpServerFile,
  McpServerIndexEntry,
  McpServersIndexFile,
  McpProxyState,
  McpServerConfigData,
  McpServerDefinitionData,
  McpServerTestConnectionResult,
} from '@canopy/desktop-shared/types/mcp-servers';
import { MCP_SERVER_CHANNELS } from '@canopy/desktop-shared/constants/mcp-server-channels';

const mockPinnedHttpFetch = jest.fn(
  (
    url: URL,
    _addresses: unknown,
    headers: Record<string, string>,
    body: string,
    signal: AbortSignal,
  ): Promise<Response> =>
    global.fetch(url.pathname === '/' ? url.origin : url.toString(), {
      method: 'POST',
      headers,
      body,
      signal,
      redirect: 'manual',
    }),
);

jest.mock('node:dns/promises', () => ({
  lookup: jest.fn(() => Promise.resolve([{ address: '8.8.8.8', family: 4 }])),
}));
jest.mock('../mcp/pinned-http-fetch', () => ({
  get fetchPinnedHttpResponse(): typeof mockPinnedHttpFetch {
    return mockPinnedHttpFetch;
  },
}));

jest.mock('node:fs/promises');
jest.mock('node:crypto', () => ({
  ...jest.requireActual<typeof NodeCrypto>('node:crypto'),
  randomUUID: jest.fn(() => 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'),
}));
jest.mock('../lib/paths', () => ({
  getMcpServersIndexFilePath: jest.fn(() => '/mock/mcp-servers/index.json'),
  getMcpServerToolsCacheFilePath: (): string =>
    '/mock/mcp-servers/tools-cache.json',
  getMcpServerFilePath: jest.fn(
    (id: string) => `/mock/mcp-servers/server-${id}.json`,
  ),
}));
jest.mock('../ipc/register', () => ({
  registerIpcHandler: jest.fn(),
}));
const mockSendToAllWindows = jest.fn();
jest.mock('../lib/open-external', () => ({
  openExternalGuarded: jest.fn(),
}));

jest.mock('../lib/window-send', () => ({
  get sendToAllWindows(): typeof mockSendToAllWindows {
    return mockSendToAllWindows;
  },
}));
jest.mock('../lib/preferences-store', () => ({
  readPreferencesFile: jest.fn(() => Promise.resolve({ mcpProxyPort: 37645 })),
  writePreferencesFile: jest.fn((prefs: unknown) => Promise.resolve(prefs)),
}));
const mockProxyEnsureStarted = jest.fn(() => Promise.resolve());
const mockProxyRegisterRoute = jest.fn(() => Promise.resolve('route-id'));
const mockProxyUnregisterRoute = jest.fn();
const mockProxyGetProxyUrl = jest.fn(
  () => 'http://127.0.0.1:37645/mcp/route-id',
);
const mockProxyGetPort = jest.fn(() => 37645);
const mockProxySetBroadcastHandlers = jest.fn<
  void,
  [{ status: (state: McpProxyState) => void }]
>();
const mockProxySetWindowAccessor = jest.fn();
const mockProxySetPreferredPort = jest.fn();
const mockProxyRefreshPreferredPortStatus = jest.fn(() => Promise.resolve());
const mockProxyAssertPortAvailable = jest.fn(() => Promise.resolve());
const mockProxyGetState = jest.fn(() => ({
  port: 37645,
  status: 'stopped' as const,
}));
const mockProxyIsRunning = jest.fn(() => false);
const mockProxyUpdatePort = jest.fn(() => Promise.resolve());
const mockRefreshCodexSessionsAfterMcpOAuth = jest.fn(() => Promise.resolve());
jest.mock('../mcp/http-proxy-service', () => ({
  getMcpHttpProxyService: jest.fn(() => ({
    get ensureStarted(): typeof mockProxyEnsureStarted {
      return mockProxyEnsureStarted;
    },
    get registerRoute(): typeof mockProxyRegisterRoute {
      return mockProxyRegisterRoute;
    },
    get unregisterRoute(): typeof mockProxyUnregisterRoute {
      return mockProxyUnregisterRoute;
    },
    get getPort(): typeof mockProxyGetPort {
      return mockProxyGetPort;
    },
    get getProxyUrl(): typeof mockProxyGetProxyUrl {
      return mockProxyGetProxyUrl;
    },
    get setBroadcastHandlers(): typeof mockProxySetBroadcastHandlers {
      return mockProxySetBroadcastHandlers;
    },
    get setWindowAccessor(): typeof mockProxySetWindowAccessor {
      return mockProxySetWindowAccessor;
    },
    get setPreferredPort(): typeof mockProxySetPreferredPort {
      return mockProxySetPreferredPort;
    },
    get refreshPreferredPortStatus(): typeof mockProxyRefreshPreferredPortStatus {
      return mockProxyRefreshPreferredPortStatus;
    },
    get assertPortAvailable(): typeof mockProxyAssertPortAvailable {
      return mockProxyAssertPortAvailable;
    },
    get getState(): typeof mockProxyGetState {
      return mockProxyGetState;
    },
    get isRunning(): typeof mockProxyIsRunning {
      return mockProxyIsRunning;
    },
    get updatePort(): typeof mockProxyUpdatePort {
      return mockProxyUpdatePort;
    },
  })),
}));
type McpOAuthSettledListener = (event: {
  success: boolean;
  serverId?: string;
  configId?: string;
}) => void;
const mockSetMcpOAuthSettledListener = jest.fn<
  void,
  [McpOAuthSettledListener | null]
>();
jest.mock('../mcp/oauth-client', () => ({
  startMcpOAuthFlow: jest.fn(() => Promise.resolve({ status: 'started' })),
  getValidMcpAccessToken: jest.fn(() => Promise.resolve(null)),
  setMcpOAuthSettledListener: (
    listener: McpOAuthSettledListener | null,
  ): void => mockSetMcpOAuthSettledListener(listener),
}));
jest.mock('../agents/session-manager', () => ({
  get refreshCodexSessionsAfterMcpOAuth(): typeof mockRefreshCodexSessionsAfterMcpOAuth {
    return mockRefreshCodexSessionsAfterMcpOAuth;
  },
}));
const mockResumeChatsAfterMcpOAuthSuccess = jest.fn<
  Promise<string[]>,
  [Record<string, unknown>]
>(() => Promise.resolve([]));
jest.mock('../lib/auth-failure-resume', () => ({
  resumeChatsAfterMcpOAuthSuccess: (
    input: Record<string, unknown>,
  ): Promise<string[]> => mockResumeChatsAfterMcpOAuthSuccess(input),
}));
jest.mock('../mcp/oauth-token-store', () => ({
  migratePluginMcpOAuthToken: jest.fn(() => Promise.resolve()),
  setMcpOAuthTokensChangedListener: jest.fn(),
  clearMcpOAuthToken: jest.fn(() => Promise.resolve()),
  getMcpOAuthTokenRevision: jest.fn(() => Promise.resolve('missing')),
}));
const mockListCuratedMcpServers = jest.fn<
  Promise<CuratedMcpServerListResponse>,
  [now?: Date]
>(() => Promise.resolve({ version: 1, servers: [] }));
jest.mock('../mcp/curated-catalog', () => ({
  get listCuratedMcpServers(): typeof mockListCuratedMcpServers {
    return mockListCuratedMcpServers;
  },
  refreshCuratedMcpServers: jest.fn(() =>
    Promise.resolve({ version: 1, servers: [] }),
  ),
}));
jest.mock('../mcp/remote-image-cache', () => ({
  resolveRemoteImageDataUrl: jest.fn(() => Promise.resolve(null)),
}));
const mockRewriteMcpServerRefs = jest.fn<
  ReturnType<typeof ServerRefRewriteModule.rewriteMcpServerRefs>,
  Parameters<typeof ServerRefRewriteModule.rewriteMcpServerRefs>
>(() => Promise.resolve({ globalDefaults: true, workspaces: 1, chats: 2 }));
jest.mock('../mcp/server-ref-rewrite', () => ({
  get rewriteMcpServerRefs(): typeof mockRewriteMcpServerRefs {
    return mockRewriteMcpServerRefs;
  },
}));
jest.mock('../plugins/mcp-inventory', () => ({
  listDetectedMcpServersForSelections: jest.fn(() =>
    Promise.resolve({ servers: [], warnings: [] }),
  ),
}));
const mockSpawn = jest.fn();
jest.mock('child_process', () => ({
  ...jest.requireActual<typeof NodeChildProcess>('node:child_process'),
  spawn: (...args: unknown[]): unknown => mockSpawn(...args),
  execFile: jest.fn(),
}));

import { mkdir, readFile, readdir, writeFile, unlink } from 'node:fs/promises';
import { ChildProcess } from 'child_process';
import { openExternalGuarded } from '../lib/open-external';
import { registerIpcHandler } from '../ipc/register';
import {
  readPreferencesFile,
  writePreferencesFile,
} from '../lib/preferences-store';
import { getFeatureFlagService } from '../feature-flags/service';
import { clearMcpOAuthToken } from '../mcp/oauth-token-store';
import {
  registerMcpServerHandlers,
  testMcpServerConnection,
  saveMcpServer,
  rewriteMcpServerRefsOutcome,
  setInstalledMcpConfigEnabled,
  deleteMcpServer,
  isCommandSafe,
  areArgsSafe,
  toIndexEntry,
} from '../ipc/mcp-servers';
import { getValidMcpAccessToken, startMcpOAuthFlow } from '../mcp/oauth-client';
import {
  clearMcpServerHealthCache,
  getMcpServerHealth,
} from '../mcp/connection-status';

import * as accountConnections from '../canopy-cloud/mcp-connections';
import * as toolDiscovery from '../mcp/tool-discovery';

function partialPreferences(
  preferences: Partial<PreferencesData>,
): PreferencesData {
  // A partial fixture: these tests rely on unset preferences staying undefined.
  return preferences as PreferencesData;
}

const mockedReadFile = jest.mocked(readFile);
const mockedWriteFile = jest.mocked(writeFile);
const mockedMkdir = jest.mocked(mkdir);
const mockedUnlink = jest.mocked(unlink);
const mockedRegisterIpcHandler = jest.mocked(registerIpcHandler);
const mockedStartMcpOAuthFlow = jest.mocked(startMcpOAuthFlow);
const mockedGetValidMcpAccessToken = jest.mocked(getValidMcpAccessToken);
const mockedWritePreferencesFile = jest.mocked(writePreferencesFile);

type HandlerFn<Result = unknown> = (...args: unknown[]) => Promise<Result>;

interface MockChildProcess {
  child: ChildProcess;
  stdout: PassThrough;
  stderr: PassThrough;
  stdin: PassThrough;
  stdinWrite: jest.Mock<boolean, [string]>;
  kill: jest.Mock<boolean, [NodeJS.Signals?]>;
}

function getHandler(
  channel: 'mcp-servers:test-connection',
): HandlerFn<McpServerTestConnectionResult>;
function getHandler(channel: string): HandlerFn;
function getHandler(channel: string): HandlerFn {
  const call = mockedRegisterIpcHandler.mock.calls.find(
    ([ch]) => ch === channel,
  );
  if (!call) {
    throw new Error(`Handler for channel '${channel}' not registered`);
  }
  return call[1] as HandlerFn;
}

function makeDefinition(
  overrides: Partial<McpServerDefinitionData> = {},
): McpServerDefinitionData {
  return {
    id: 'aaaa-bbbb-1111',
    name: 'Test Server',
    description: 'A test MCP server',
    type: 'command',
    command: 'npx',
    args: ['-y', '@test/mcp-server'],
    createdAt: '2025-01-01T00:00:00Z',
    updatedAt: '2025-01-01T00:00:00Z',
    ...overrides,
  };
}

function makeConfig(
  overrides: Partial<McpServerConfigData> = {},
): McpServerConfigData {
  return {
    id: 'c0f1-0001',
    name: 'Default',
    description: 'Default configuration',
    enabled: true,
    envVars: {},
    extraArgs: [],
    extraHeaders: {},
    createdAt: '2025-01-01T00:00:00Z',
    updatedAt: '2025-01-01T00:00:00Z',
    ...overrides,
  };
}

function makeServer(
  overrides: {
    definition?: Partial<McpServerDefinitionData>;
    configs?: McpServerConfigData[];
  } = {},
): McpServerData {
  return {
    definition: makeDefinition(overrides.definition),
    configs: overrides.configs ?? [makeConfig()],
  };
}

function makeIndexFileJson(
  servers: McpServerIndexEntry[],
  version: number = 1,
): string {
  return JSON.stringify({ version, servers });
}

function makeServerFileJson(
  server: McpServerData,
  version: number = 1,
): string {
  return JSON.stringify({ version, server });
}

function missingFile(): Promise<never> {
  return Promise.reject(
    Object.assign(new Error('missing'), { code: 'ENOENT' }),
  );
}

/** Index reads return `index`; server reads return a listed server or ENOENT. */
function mockMcpFiles(
  index: string | undefined,
  servers: McpServerData[] = [],
): void {
  mockedReadFile.mockImplementation((path): Promise<string> => {
    if (typeof path !== 'string') return missingFile();
    if (path.endsWith('index.json'))
      return index === undefined ? missingFile() : Promise.resolve(index);
    const server = servers.find((candidate) =>
      path.endsWith(`server-${candidate.definition.id}.json`),
    );
    return server ? Promise.resolve(makeServerFileJson(server)) : missingFile();
  });
}

/** In-memory MCP directory: reads see earlier writes; absent paths are ENOENT. */
function useMcpDisk(initial: Record<string, string> = {}): Map<string, string> {
  const files = new Map(Object.entries(initial));
  mockedReadFile.mockImplementation((path): Promise<string> => {
    const text = typeof path === 'string' ? files.get(path) : undefined;
    return text === undefined ? missingFile() : Promise.resolve(text);
  });
  mockedWriteFile.mockImplementation((path, data): Promise<void> => {
    if (typeof path !== 'string' || typeof data !== 'string')
      throw new Error('Expected a JSON text write');
    files.set(path, data);
    return Promise.resolve();
  });
  return files;
}

const MOCK_INDEX_PATH = '/mock/mcp-servers/index.json';
const mockServerPath = (id: string): string =>
  `/mock/mcp-servers/server-${id}.json`;

function toMcpFrame(message: Record<string, unknown>): string {
  const payload = JSON.stringify(message);
  return `Content-Length: ${String(Buffer.byteLength(payload, 'utf8'))}\r\n\r\n${payload}`;
}

function createMockChildProcess(): MockChildProcess {
  const child = new ChildProcess();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const stdin = new PassThrough();
  const stdinWrite = jest.fn<boolean, [string]>(() => true);
  const kill = jest.fn<boolean, [NodeJS.Signals?]>(() => true);
  Object.defineProperty(stdin, 'write', {
    configurable: true,
    value: stdinWrite,
  });
  child.stdout = stdout;
  child.stderr = stderr;
  child.stdin = stdin;
  Object.defineProperty(child, 'stdio', {
    configurable: true,
    value: [stdin, stdout, stderr, null, null],
  });
  Object.defineProperty(child, 'kill', {
    configurable: true,
    value: kill,
  });
  return { child, stdout, stderr, stdin, stdinWrite, kill };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockProxyEnsureStarted.mockResolvedValue(undefined);
  mockProxyRegisterRoute.mockResolvedValue('route-id');
  mockProxyGetProxyUrl.mockReturnValue('http://127.0.0.1:37645/mcp/route-id');
  mockProxyGetPort.mockReturnValue(37645);
  mockProxyRefreshPreferredPortStatus.mockResolvedValue(undefined);
  mockProxyAssertPortAvailable.mockResolvedValue(undefined);
  mockProxyIsRunning.mockReturnValue(false);
  mockProxyUpdatePort.mockResolvedValue(undefined);
  mockedStartMcpOAuthFlow.mockResolvedValue({ status: 'started' });
  jest.mocked(readdir).mockResolvedValue([]);
  clearMcpServerHealthCache();
  registerMcpServerHandlers(() => null);
});

describe('device config write coordination', () => {
  it('holds the server lease until every initiated token clear settles, without blocking another server', async () => {
    const first = makeServer({
      configs: [makeConfig({ id: 'cfg-a' }), makeConfig({ id: 'cfg-b' })],
    });
    const other = makeServer({ definition: { id: 'bbb-222' } });
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let index = makeIndexFileJson([toIndexEntry(first)]);
    mockedReadFile.mockImplementation((path) =>
      path === MOCK_INDEX_PATH
        ? Promise.resolve(index)
        : path === mockServerPath(first.definition.id)
          ? Promise.resolve(makeServerFileJson(first))
          : missingFile(),
    );
    mockedWriteFile.mockImplementation((path, data) => {
      if (typeof path === 'string' && path.endsWith('index.json')) {
        if (typeof data !== 'string')
          throw new Error('Expected index JSON text');
        index = data;
      }
      return Promise.resolve();
    });
    jest
      .mocked(clearMcpOAuthToken)
      .mockRejectedValueOnce(new Error('cleanup failed'))
      .mockImplementationOnce(async () => {
        entered.resolve();
        await release.promise;
      });
    const deletion = deleteMcpServer(first.definition.id);
    const failure = expect(deletion).rejects.toThrow('cleanup failed');
    await entered.promise;
    const enabling = setInstalledMcpConfigEnabled(
      first.definition.id,
      'cfg-a',
      false,
    );
    try {
      await saveMcpServer(other);
      expect(
        mockedWriteFile.mock.calls.some(
          ([path]) =>
            typeof path === 'string' &&
            path.endsWith(`server-${first.definition.id}.json`),
        ),
      ).toBe(false);
      expect(mockedUnlink).not.toHaveBeenCalled();
    } finally {
      release.resolve();
    }
    await Promise.all([failure, enabling]);
    expect(mockedUnlink).not.toHaveBeenCalled();
  });

  it('does not reject an applied save when installed-item notification throws', async () => {
    mockMcpFiles(makeIndexFileJson([]));
    mockedWriteFile.mockResolvedValue(undefined);
    jest.mocked(notifyInstalledItemsChanged).mockImplementationOnce(() => {
      throw new Error('listener failed');
    });
    await expect(saveMcpServer(makeServer())).resolves.toMatchObject({
      version: 1,
    });
    expect(mockedWriteFile).toHaveBeenCalledTimes(2);
  });

  it('leases an allocated id before catalog loading and treats its next save as an update', async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<CuratedMcpServerListResponse>();
    mockListCuratedMcpServers.mockImplementationOnce(async () => {
      entered.resolve();
      return release.promise;
    });
    useMcpDisk({ [MOCK_INDEX_PATH]: makeIndexFileJson([]) });
    const server = makeServer({
      definition: {
        id: '',
        type: 'http',
        url: 'https://example.test',
        curated: { key: 'example' },
      },
    });
    const creating = saveMcpServer(server);
    await entered.promise;
    const updating = saveMcpServer({
      ...server,
      definition: {
        ...server.definition,
        id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      },
    });
    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(mockedWriteFile).not.toHaveBeenCalled();
    } finally {
      release.resolve({ version: 1, servers: [] });
    }
    const [created, updated] = await Promise.all([creating, updating]);
    expect(created.server.definition.httpAuthHandler).toBe('canopy');
    expect(updated.server.definition.httpAuthHandler).toBeUndefined();
  });

  it('does not hold the disk queue while catalog inputs are pending', async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<CuratedMcpServerListResponse>();
    mockListCuratedMcpServers.mockImplementationOnce(async () => {
      entered.resolve();
      return release.promise;
    });
    mockMcpFiles(makeIndexFileJson([]));
    mockedWriteFile.mockResolvedValue(undefined);
    const waiting = saveMcpServer(
      makeServer({
        definition: {
          id: 'aaa-111',
          type: 'http',
          url: 'https://example.test',
          curated: { key: 'example' },
        },
      }),
    );
    await entered.promise;
    try {
      await saveMcpServer(makeServer({ definition: { id: 'bbb-222' } }));
    } finally {
      release.resolve({ version: 1, servers: [] });
    }
    await waiting;
  });

  it.each(['save', 'delete', 'backfill'] as const)(
    'preserves another server during an overlapping %s',
    async (operation): Promise<void> => {
      const first = makeServer({ definition: { id: 'aaa-111' } });
      const second = makeServer({
        definition: {
          id: 'bbb-222',
          type: 'http',
          url: 'https://example.test/mcp',
        },
      });
      const secondEntry = toIndexEntry(second);
      delete secondEntry.urlHost;
      delete secondEntry.urlScheme;
      let index = makeIndexFileJson([secondEntry]);
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      mockedReadFile.mockImplementation((path) =>
        path === MOCK_INDEX_PATH
          ? Promise.resolve(index)
          : path === mockServerPath(second.definition.id)
            ? Promise.resolve(makeServerFileJson(second))
            : missingFile(),
      );
      mockedWriteFile.mockImplementation(async (path, data) => {
        if (typeof path === 'string' && path.endsWith('server-aaa-111.json')) {
          entered.resolve();
          await release.promise;
        }
        if (typeof path === 'string' && path.endsWith('index.json')) {
          if (typeof data !== 'string')
            throw new Error('Expected index JSON text');
          index = data;
        }
      });
      mockedUnlink.mockResolvedValue(undefined);
      const saving = saveMcpServer(first);
      await entered.promise;
      const overlapping =
        operation === 'save'
          ? saveMcpServer({
              ...second,
              definition: { ...second.definition, name: 'Updated' },
            })
          : operation === 'delete'
            ? deleteMcpServer(second.definition.id)
            : getHandler(MCP_SERVER_CHANNELS.LOAD_INDEX)();
      try {
        await new Promise<void>((resolve) => setImmediate(resolve));
      } finally {
        release.resolve();
      }
      await Promise.all([saving, overlapping]);
      const stored: unknown = JSON.parse(index);
      expect(isMcpServersIndexFile(stored)).toBe(true);
      if (!isMcpServersIndexFile(stored)) throw new Error('Invalid test index');
      expect(
        stored.servers.find((entry) => entry.id === first.definition.id),
      ).toBeDefined();
      const other = stored.servers.find(
        (entry) => entry.id === second.definition.id,
      );
      if (operation === 'delete') expect(other).toBeUndefined();
      else if (operation === 'save') expect(other?.name).toBe('Updated');
      else expect(other?.urlHost).toBe('example.test');
    },
  );
});

// CAN-5513 (CAN-4486 A2): mutations read strict state; display keeps its fallback.
describe('strict device config mutations', () => {
  const server = makeServer({ definition: { id: 'aaa-111' } });
  const damagedIndex = makeIndexFileJson([
    toIndexEntry(server),
    toIndexEntry(server),
  ]);

  it.each([
    ['damaged', '{bad'],
    ['unsupported', makeIndexFileJson([], 2)],
    ['duplicate-id', damagedIndex],
  ])('refuses to replace a %s index on save', async (_case, index) => {
    const files = useMcpDisk({ [MOCK_INDEX_PATH]: index });
    await expect(saveMcpServer(server)).rejects.toThrow('The MCP server list');
    expect(mockedWriteFile).not.toHaveBeenCalled();
    expect(files.get(MOCK_INDEX_PATH)).toBe(index);
  });

  it('keeps unknown server and index fields through a renderer save', async () => {
    const files = useMcpDisk({
      [MOCK_INDEX_PATH]: JSON.stringify({
        version: 1,
        servers: [{ ...toIndexEntry(server), rowNote: 'keep' }],
      }),
      [mockServerPath('aaa-111')]: JSON.stringify({
        version: 1,
        envelopeNote: 'keep',
        server: { ...server, serverNote: 'keep' },
      }),
    });
    await saveMcpServer({
      ...server,
      definition: { ...server.definition, name: 'Renamed' },
    });
    expect(files.get(mockServerPath('aaa-111'))).toContain('"envelopeNote"');
    expect(files.get(mockServerPath('aaa-111'))).toContain('"serverNote"');
    expect(files.get(MOCK_INDEX_PATH)).toContain('"rowNote"');
    expect(files.get(MOCK_INDEX_PATH)).toContain('"Renamed"');
  });

  it('skips the write when the config already has the requested state', async () => {
    useMcpDisk({
      [MOCK_INDEX_PATH]: makeIndexFileJson([toIndexEntry(server)]),
      [mockServerPath('aaa-111')]: makeServerFileJson(server),
    });
    await expect(
      setInstalledMcpConfigEnabled('aaa-111', 'c0f1-0001', true),
    ).resolves.toMatchObject({ server: { configs: [{ enabled: true }] } });
    expect(mockedWriteFile).not.toHaveBeenCalled();
  });

  it('applies an enable queued behind an in-flight disable', async () => {
    const files = useMcpDisk({
      [MOCK_INDEX_PATH]: makeIndexFileJson([toIndexEntry(server)]),
      [mockServerPath('aaa-111')]: makeServerFileJson(server),
    });
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const write = mockedWriteFile.getMockImplementation();
    mockedWriteFile.mockImplementationOnce(async (...args) => {
      entered.resolve();
      await release.promise;
      await write?.(...args);
    });
    const disabling = setInstalledMcpConfigEnabled(
      'aaa-111',
      'c0f1-0001',
      false,
    );
    await entered.promise;
    // The file still says enabled; only the queued setter sees the disable.
    const enabling = setInstalledMcpConfigEnabled('aaa-111', 'c0f1-0001', true);
    release.resolve();
    await Promise.all([disabling, enabling]);
    const stored: unknown = JSON.parse(
      files.get(mockServerPath('aaa-111')) ?? '',
    );
    expect(stored).toMatchObject({
      server: { configs: [{ id: 'c0f1-0001', enabled: true }] },
    });
    expect(mockedWriteFile).toHaveBeenCalledTimes(4);
  });

  it.each([
    ['damaged server file', '{bad', 'McpConfigStateError'],
    ['missing server file', undefined, 'McpConfigNotFoundError'],
  ])('refuses enable for a %s', async (_case, contents, name) => {
    useMcpDisk({
      [MOCK_INDEX_PATH]: makeIndexFileJson([toIndexEntry(server)]),
      ...(contents === undefined
        ? {}
        : { [mockServerPath('aaa-111')]: contents }),
    });
    await expect(
      setInstalledMcpConfigEnabled('aaa-111', 'c0f1-0001', false),
    ).rejects.toMatchObject({ name });
    expect(mockedWriteFile).not.toHaveBeenCalled();
  });

  it('displays a refused index without backfilling it', async () => {
    const http = makeServer({
      definition: { id: 'aaa-111', type: 'http', url: 'https://x.test/mcp' },
    });
    const legacy = toIndexEntry(http);
    delete legacy.urlHost;
    delete legacy.urlScheme;
    const index = makeIndexFileJson([legacy, legacy]);
    const files = useMcpDisk({
      [MOCK_INDEX_PATH]: index,
      [mockServerPath('aaa-111')]: makeServerFileJson(http),
    });
    await expect(
      getHandler(MCP_SERVER_CHANNELS.LOAD_INDEX)(),
    ).resolves.toMatchObject({ servers: [legacy, legacy] });
    expect(mockedWriteFile).not.toHaveBeenCalled();
    expect(files.get(MOCK_INDEX_PATH)).toBe(index);
  });
});

// ---------------------------------------------------------------------------
// Security validation — isCommandSafe
// ---------------------------------------------------------------------------

describe('isCommandSafe', () => {
  it('rejects commands with forward-slash paths', () => {
    expect(isCommandSafe('/usr/bin/node')).toBe(false);
  });

  it('rejects commands with backslash paths', () => {
    expect(isCommandSafe('C:\\Program Files\\node.exe')).toBe(false);
  });

  it('rejects node.exe (not in allowlist)', () => {
    expect(isCommandSafe('node.exe')).toBe(false);
  });

  it('rejects arbitrary commands not in allowlist', () => {
    expect(isCommandSafe('curl')).toBe(false);
    expect(isCommandSafe('bash')).toBe(false);
    expect(isCommandSafe('sh')).toBe(false);
    expect(isCommandSafe('rm')).toBe(false);
  });

  it('rejects undefined command', () => {
    expect(isCommandSafe(undefined)).toBe(false);
  });

  it('rejects empty string command', () => {
    expect(isCommandSafe('')).toBe(false);
  });

  it('accepts npx', () => {
    expect(isCommandSafe('npx')).toBe(true);
  });

  it('accepts npm', () => {
    expect(isCommandSafe('npm')).toBe(true);
  });

  it('accepts node', () => {
    expect(isCommandSafe('node')).toBe(true);
  });

  it('accepts python', () => {
    expect(isCommandSafe('python')).toBe(true);
  });

  it('accepts python3', () => {
    expect(isCommandSafe('python3')).toBe(true);
  });

  it('accepts uv', () => {
    expect(isCommandSafe('uv')).toBe(true);
  });

  it('accepts uvx', () => {
    expect(isCommandSafe('uvx')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Security validation — areArgsSafe
// ---------------------------------------------------------------------------

describe('areArgsSafe', () => {
  it('rejects --eval flag', () => {
    expect(areArgsSafe(['--eval', 'process.exit()'])).toBe(false);
  });

  it('rejects -e flag', () => {
    expect(areArgsSafe(['-e', 'process.exit()'])).toBe(false);
  });

  it('rejects -c flag', () => {
    expect(areArgsSafe(['-c', 'import os; os.system("rm -rf /")'])).toBe(false);
  });

  it('rejects --exec flag', () => {
    expect(areArgsSafe(['--exec', 'malicious'])).toBe(false);
  });

  it('rejects --import flag', () => {
    expect(areArgsSafe(['--import', 'malicious'])).toBe(false);
  });

  it('rejects -p flag', () => {
    expect(areArgsSafe(['-p', 'process.env'])).toBe(false);
  });

  it('rejects --print flag', () => {
    expect(areArgsSafe(['--print', 'process.env'])).toBe(false);
  });

  it('rejects --input-type=module flag', () => {
    expect(areArgsSafe(['--input-type=module'])).toBe(false);
  });

  it('rejects --experimental-loader flag', () => {
    expect(areArgsSafe(['--experimental-loader', './loader.js'])).toBe(false);
  });

  it('rejects --require flag', () => {
    expect(areArgsSafe(['--require', './inject.js'])).toBe(false);
  });

  it('rejects -r flag', () => {
    expect(areArgsSafe(['-r', './inject.js'])).toBe(false);
  });

  it('rejects ampersand shell metacharacter', () => {
    expect(areArgsSafe(['safe-arg', 'arg&malicious'])).toBe(false);
  });

  it('rejects pipe shell metacharacter', () => {
    expect(areArgsSafe(['arg|malicious'])).toBe(false);
  });

  it('rejects redirect shell metacharacter >', () => {
    expect(areArgsSafe(['>output.txt'])).toBe(false);
  });

  it('rejects redirect shell metacharacter <', () => {
    expect(areArgsSafe(['<input.txt'])).toBe(false);
  });

  it('rejects semicolon shell metacharacter', () => {
    expect(areArgsSafe(['arg;rm -rf /'])).toBe(false);
  });

  it('rejects dollar sign shell metacharacter', () => {
    expect(areArgsSafe(['$HOME'])).toBe(false);
  });

  it('rejects backtick shell metacharacter', () => {
    expect(areArgsSafe(['`whoami`'])).toBe(false);
  });

  it('rejects newline in args', () => {
    expect(areArgsSafe(['arg\nmalicious'])).toBe(false);
  });

  it('rejects carriage return in args', () => {
    expect(areArgsSafe(['arg\rmalicious'])).toBe(false);
  });

  it('accepts normal args', () => {
    expect(areArgsSafe(['-y', '@modelcontextprotocol/server-everything'])).toBe(
      true,
    );
  });

  it('accepts undefined args', () => {
    expect(areArgsSafe(undefined)).toBe(true);
  });

  it('accepts empty args array', () => {
    expect(areArgsSafe([])).toBe(true);
  });

  it('accepts args with hyphens and slashes in package names', () => {
    expect(areArgsSafe(['-y', '@scope/my-mcp-server', '--port', '3000'])).toBe(
      true,
    );
  });
});

// ---------------------------------------------------------------------------
// toIndexEntry helper
// ---------------------------------------------------------------------------

describe('toIndexEntry', () => {
  it('derives account scope and auth handler from the definition', (): void => {
    expect(
      toIndexEntry(
        makeServer({
          definition: { type: 'http', httpAuthHandler: 'account' },
        }),
      ),
    ).toMatchObject({ scope: 'account', authHandler: 'account' });
  });

  it('converts McpServerData to McpServerIndexEntry', () => {
    const server = makeServer({
      definition: {
        id: 'abc-123',
        name: 'My Server',
        description: 'Desc',
        type: 'command',
        updatedAt: '2025-06-01T00:00:00Z',
      },
      configs: [
        makeConfig({ id: 'c1', name: 'Prod', enabled: true }),
        makeConfig({ id: 'c2', name: 'Dev', enabled: false }),
      ],
    });

    const entry = toIndexEntry(server);

    expect(entry).toEqual({
      id: 'abc-123',
      name: 'My Server',
      description: 'Desc',
      type: 'command',
      configs: [
        { id: 'c1', name: 'Prod', enabled: true },
        { id: 'c2', name: 'Dev', enabled: false },
      ],
      updatedAt: '2025-06-01T00:00:00Z',
    });
  });

  it('returns empty configs array when server has no configs', () => {
    const server = makeServer({ configs: [] });

    const entry = toIndexEntry(server);

    expect(entry.configs).toEqual([]);
  });

  it('carries curated logo and key metadata into the index', () => {
    const entry = toIndexEntry(
      makeServer({
        definition: {
          type: 'http',
          command: undefined,
          url: 'https://mcp.example.test',
          curated: {
            key: 'github',
            logoUrl: 'https://cdn.example.test/github.png',
          },
        },
      }),
    );

    expect(entry).toMatchObject({
      curatedKey: 'github',
      logoUrl: 'https://cdn.example.test/github.png',
    });
  });

  it('indexes only the hostname of an HTTP server URL', () => {
    const entry = (
      type: 'http' | 'command',
      url: string | undefined,
    ): ReturnType<typeof toIndexEntry> =>
      toIndexEntry(makeServer({ definition: { type, url } }));
    expect(
      entry('http', 'https://user:pass@mcp.example.test:8443/v1?token=secret')
        .urlHost,
    ).toBe('mcp.example.test');
    expect(entry('http', 'not a url')).not.toHaveProperty('urlHost');
    expect(entry('http', undefined)).not.toHaveProperty('urlHost');
    expect(entry('command', 'https://mcp.example.test')).not.toHaveProperty(
      'urlHost',
    );
  });

  it('indexes the URL scheme so plain HTTP rows are not offered to the cloud', () => {
    const entry = (
      type: 'http' | 'command',
      url: string | undefined,
    ): ReturnType<typeof toIndexEntry> =>
      toIndexEntry(makeServer({ definition: { type, url } }));
    expect(entry('http', 'https://mcp.example.test/v1').urlScheme).toBe(
      'https',
    );
    expect(entry('http', 'http://mcp.example.test/v1').urlScheme).toBe('http');
    expect(entry('http', 'not a url')).not.toHaveProperty('urlScheme');
    expect(entry('http', undefined)).not.toHaveProperty('urlScheme');
    expect(entry('command', 'https://mcp.example.test')).not.toHaveProperty(
      'urlScheme',
    );
  });

  it('includes only id, name, enabled in config summaries', () => {
    const server = makeServer({
      configs: [
        makeConfig({
          id: 'c1',
          name: 'Full Config',
          enabled: true,
          envVars: { FOO: 'bar' },
          extraArgs: ['--verbose'],
          extraHeaders: { 'X-Custom': 'value' },
          authToken: 'secret',
        }),
      ],
    });

    const entry = toIndexEntry(server);

    expect(entry.configs[0]).toEqual({
      id: 'c1',
      name: 'Full Config',
      enabled: true,
    });
    expect(entry.configs[0]).not.toHaveProperty('envVars');
    expect(entry.configs[0]).not.toHaveProperty('extraArgs');
    expect(entry.configs[0]).not.toHaveProperty('authToken');
  });
});

// ---------------------------------------------------------------------------
// Handler registration
// ---------------------------------------------------------------------------

describe('registerMcpServerHandlers', () => {
  it('lists non-secret account connection choices through IPC', async (): Promise<void> => {
    const connection = {
      id: 'a1111111-1111-4111-8111-111111111111',
      serverKey: 'custom:1',
      configId: 'default',
      displayName: 'Work tools',
      kind: 'CUSTOM' as const,
      status: 'CONNECTED' as const,
      // The move to this device warns about stored headers from these.
      authMode: 'BEARER' as const,
      upstreamHost: 'mcp.example.test',
      hasExtraHeaders: true,
    };
    jest
      .mocked(listAccountMcpConnections)
      .mockResolvedValue([
        { ...connection, routeId: 'private-route', enabledTools: null },
      ]);
    await expect(
      getHandler(MCP_SERVER_CHANNELS.LIST_ACCOUNT_CONNECTIONS)(),
    ).resolves.toEqual([connection]);
    expect(invalidateAccountMcpConnections).toHaveBeenCalledTimes(1);
    expect(
      jest.mocked(invalidateAccountMcpConnections).mock.invocationCallOrder[0],
    ).toBeLessThan(
      jest.mocked(listAccountMcpConnections).mock.invocationCallOrder[0] ?? 0,
    );
  });

  // CAN-1814 PR 6: a recoverable MCP auth failure stops the turn, so the
  // successful reconnect is the only place that knows it is safe to re-drive
  // it. Wired here rather than in the renderer card so the resume still
  // happens when the user navigates away during the browser leg.
  it('resumes turns stopped by this server once its OAuth login settles', () => {
    const calls = mockSetMcpOAuthSettledListener.mock.calls;
    const listener = calls[calls.length - 1]?.[0];
    expect(listener).toBeDefined();
    listener?.({ success: true, serverId: 'srv-1', configId: 'cfg-1' });

    expect(mockResumeChatsAfterMcpOAuthSuccess).toHaveBeenCalledWith(
      expect.objectContaining({ serverId: 'srv-1', configId: 'cfg-1' }),
    );
  });

  it('does not resume when the OAuth login failed', () => {
    const calls = mockSetMcpOAuthSettledListener.mock.calls;
    const listener = calls[calls.length - 1]?.[0];
    listener?.({ success: false, serverId: 'srv-1', configId: 'cfg-1' });

    expect(mockResumeChatsAfterMcpOAuthSuccess).not.toHaveBeenCalled();
  });

  it('registers all six handlers', () => {
    expect(mockedRegisterIpcHandler).toHaveBeenCalledWith(
      'mcp-servers:load-index',
      expect.any(Function),
    );
    expect(mockedRegisterIpcHandler).toHaveBeenCalledWith(
      'mcp-servers:load-server',
      expect.any(Function),
    );
    expect(mockedRegisterIpcHandler).toHaveBeenCalledWith(
      'mcp-servers:save-server',
      expect.any(Function),
    );
    expect(mockedRegisterIpcHandler).toHaveBeenCalledWith(
      'mcp-servers:delete-server',
      expect.any(Function),
    );
    expect(mockedRegisterIpcHandler).toHaveBeenCalledWith(
      'mcp-servers:check-health',
      expect.any(Function),
    );
    expect(mockedRegisterIpcHandler).toHaveBeenCalledWith(
      'mcp-servers:test-connection',
      expect.any(Function),
    );
  });

  it('checks the preferred proxy port when handlers register', async () => {
    await Promise.resolve();

    expect(mockProxyRefreshPreferredPortStatus).toHaveBeenCalledWith(37645);
  });

  it('broadcasts proxy status to every renderer window', () => {
    const handlers = mockProxySetBroadcastHandlers.mock.calls[0]?.[0];
    const state: McpProxyState = { port: 37645, status: 'running' };

    handlers?.status(state);

    expect(mockSendToAllWindows).toHaveBeenCalledWith(
      MCP_SERVER_CHANNELS.PROXY_STATUS,
      state,
    );
  });

  it('applies a free proxy port before persisting it', async () => {
    const handler = getHandler('mcp-servers:apply-proxy-port');
    const result = await handler({}, 37646);

    expect(mockProxyAssertPortAvailable).toHaveBeenCalledWith(37646);
    expect(mockedWritePreferencesFile).toHaveBeenCalledWith({
      mcpProxyPort: 37646,
    });
    expect(mockProxySetPreferredPort).toHaveBeenCalledWith(37646);
    expect(result).toEqual({ port: 37645, status: 'stopped' });
  });

  it('rejects an occupied proxy port without persisting it', async () => {
    mockProxyAssertPortAvailable.mockRejectedValueOnce(
      new Error('MCP proxy port 37646 is already in use. Choose another port.'),
    );
    const handler = getHandler('mcp-servers:apply-proxy-port');

    await expect(handler({}, 37646)).rejects.toThrow(
      'MCP proxy port 37646 is already in use. Choose another port.',
    );

    expect(mockedWritePreferencesFile).not.toHaveBeenCalledWith({
      mcpProxyPort: 37645,
    });
    expect(mockedWritePreferencesFile).not.toHaveBeenCalledWith({
      mcpProxyPort: 37646,
    });
    expect(mockProxySetPreferredPort).toHaveBeenCalledWith(37645);
  });

  it('rolls back the persisted proxy port when rebinding fails after save', async () => {
    mockProxyIsRunning.mockReturnValue(true);
    mockProxyUpdatePort.mockRejectedValueOnce(new Error('bind failed'));
    const handler = getHandler('mcp-servers:apply-proxy-port');

    await expect(handler({}, 37646)).rejects.toThrow('bind failed');

    expect(mockedWritePreferencesFile).toHaveBeenCalledWith({
      mcpProxyPort: 37646,
    });
    expect(mockedWritePreferencesFile).toHaveBeenCalledWith({
      mcpProxyPort: 37645,
    });
  });
});

// ---------------------------------------------------------------------------
// CRUD — load index handler
// ---------------------------------------------------------------------------

describe('load index handler', () => {
  it.each([
    new CanopyCloudClientError('network-error', 'Offline'),
    new CanopyCloudClientError('http-error', 'Unauthorized', 401),
    new CanopyCloudClientError('http-error', 'Unavailable', 503),
    new AccountMcpConnectionError('account-changed'),
  ])(
    'loads local servers despite account failure %j',
    async (error): Promise<void> => {
      const enabled = jest
        .spyOn(getFeatureFlagService(), 'isEnabled')
        .mockReturnValue(true);
      const entry: McpServerIndexEntry = {
        id: 'abc-123',
        name: 'Local',
        description: '',
        type: 'command',
        configs: [],
        updatedAt: '',
      };
      mockedReadFile.mockResolvedValue(makeIndexFileJson([entry]));
      jest.mocked(listAccountMcpConnections).mockRejectedValueOnce(error);
      try {
        await expect(
          getHandler(MCP_SERVER_CHANNELS.LOAD_INDEX)(),
        ).resolves.toMatchObject({
          servers: [entry],
          accountConnectionsAvailable: false,
        });
      } finally {
        enabled.mockRestore();
      }
    },
  );

  it('returns empty servers when file does not exist', async () => {
    mockedReadFile.mockRejectedValue(new Error('ENOENT'));

    const handler = getHandler('mcp-servers:load-index');
    const result = (await handler()) as McpServersIndexFile;

    expect(result).toEqual({ version: 1, servers: [] });
  });

  it('returns empty servers when JSON is invalid', async () => {
    mockedReadFile.mockResolvedValue('not valid json');

    const handler = getHandler('mcp-servers:load-index');
    const result = (await handler()) as McpServersIndexFile;

    expect(result).toEqual({ version: 1, servers: [] });
  });

  it('returns empty servers when version is not 1', async () => {
    mockedReadFile.mockResolvedValue(makeIndexFileJson([], 2));

    const handler = getHandler('mcp-servers:load-index');
    const result = (await handler()) as McpServersIndexFile;

    expect(result).toEqual({ version: 1, servers: [] });
  });

  it('returns empty servers when servers field is not an array', async () => {
    mockedReadFile.mockResolvedValue(
      JSON.stringify({ version: 1, servers: 'not-array' }),
    );

    const handler = getHandler('mcp-servers:load-index');
    const result = (await handler()) as McpServersIndexFile;

    expect(result).toEqual({ version: 1, servers: [] });
  });

  it('returns parsed servers for valid file', async () => {
    const entry: McpServerIndexEntry = {
      id: 'abc-123',
      name: 'Server',
      description: 'Desc',
      type: 'command',
      configs: [{ id: 'c1', name: 'Default', enabled: true }],
      updatedAt: '2025-01-01T00:00:00Z',
    };
    mockedReadFile.mockResolvedValue(makeIndexFileJson([entry]));

    const handler = getHandler('mcp-servers:load-index');
    const result = (await handler()) as McpServersIndexFile;

    expect(result.version).toBe(1);
    expect(result.servers).toHaveLength(1);
    expect(result.servers[0].id).toBe('abc-123');
  });

  // Index entries saved before urlHost/urlScheme existed carry neither, so a
  // custom HTTPS row could never be promoted to an account connection.
  it('backfills urlHost and urlScheme for legacy HTTP rows once', async (): Promise<void> => {
    const legacyHttp: McpServerIndexEntry = {
      id: 'legacy-http',
      name: 'Legacy HTTP',
      description: '',
      type: 'http',
      configs: [{ id: 'c1', name: 'Default', enabled: true }],
      updatedAt: '2025-01-01T00:00:00Z',
    };
    const command: McpServerIndexEntry = {
      id: 'legacy-cmd',
      name: 'Legacy command',
      description: '',
      type: 'command',
      configs: [],
      updatedAt: '2025-01-01T00:00:00Z',
    };
    const httpServer = makeServer({
      definition: {
        id: 'legacy-http',
        type: 'http',
        command: undefined,
        args: undefined,
        url: 'https://mcp.example.test/v1/sse?token=secret',
      },
    });
    let storedIndex = makeIndexFileJson([legacyHttp, command]);
    const serverReads: string[] = [];
    mockedReadFile.mockImplementation((path): Promise<string> => {
      if (typeof path === 'string' && path.endsWith('index.json')) {
        return Promise.resolve(storedIndex);
      }
      if (typeof path !== 'string') {
        return Promise.reject(new Error('Expected a string path'));
      }
      serverReads.push(path);
      return path.endsWith('server-legacy-http.json')
        ? Promise.resolve(makeServerFileJson(httpServer))
        : Promise.reject(new Error('ENOENT'));
    });
    mockedWriteFile.mockImplementation((path, data): Promise<void> => {
      if (typeof path === 'string' && path.endsWith('index.json')) {
        if (typeof data !== 'string') {
          throw new Error('Expected index JSON text');
        }
        storedIndex = data;
      }
      return Promise.resolve();
    });

    const result = (await getHandler(
      MCP_SERVER_CHANNELS.LOAD_INDEX,
    )()) as McpServersIndexFile;

    expect(result.servers).toEqual([
      { ...legacyHttp, urlHost: 'mcp.example.test', urlScheme: 'https' },
      command,
    ]);
    expect(serverReads).toEqual(['/mock/mcp-servers/server-legacy-http.json']);
    const indexWrites = mockedWriteFile.mock.calls.filter(
      ([path]) => typeof path === 'string' && path.endsWith('index.json'),
    );
    expect(indexWrites).toHaveLength(1);
    const persisted: unknown = JSON.parse(storedIndex);
    expect(isMcpServersIndexFile(persisted)).toBe(true);
    expect(persisted).toEqual({
      version: 1,
      servers: [
        { ...legacyHttp, urlHost: 'mcp.example.test', urlScheme: 'https' },
        command,
      ],
    });
    expect(storedIndex).not.toContain('secret');

    // The persisted index is complete: the next load neither re-reads
    // definitions nor rewrites the index.
    serverReads.length = 0;
    mockedWriteFile.mockClear();
    await getHandler(MCP_SERVER_CHANNELS.LOAD_INDEX)();
    expect(serverReads).toEqual([]);
    expect(mockedWriteFile).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// CRUD — load single server handler
// ---------------------------------------------------------------------------

describe('load server handler', () => {
  it('rejects invalid server id', async () => {
    const handler = getHandler('mcp-servers:load-server');

    await expect(handler({}, 'INVALID_ID!')).rejects.toThrow(
      'Invalid MCP server id',
    );
  });

  it('rejects empty server id', async () => {
    const handler = getHandler('mcp-servers:load-server');

    await expect(handler({}, '')).rejects.toThrow('Invalid MCP server id');
  });

  it('reads and returns a valid server file', async () => {
    const server = makeServer();
    mockedReadFile.mockResolvedValue(makeServerFileJson(server));

    const handler = getHandler('mcp-servers:load-server');
    const result = (await handler({}, 'aaaa-bbbb-1111')) as McpServerFile;

    expect(result.version).toBe(1);
    expect(result.server.definition.name).toBe('Test Server');
  });

  it('normalizes persisted curated metadata and HTTP auth handling', async () => {
    const server = makeServer();
    const persistedServer = {
      ...server,
      definition: {
        ...server.definition,
        type: 'http',
        command: undefined,
        url: 'https://mcp.example.test',
        httpAuthHandler: 'provider',
        curated: {
          key: ' github ',
          logoUrl: ' https://cdn.example.test/github.png ',
          docsUrl: '   ',
          unexpected: 'discarded',
        },
      },
    };
    mockedReadFile.mockResolvedValue(
      JSON.stringify({ version: 1, server: persistedServer }),
    );

    const result = await getHandler('mcp-servers:load-server')(
      {},
      'aaaa-bbbb-1111',
    );

    expect(result).toMatchObject({
      server: {
        definition: {
          httpAuthHandler: 'provider',
          curated: {
            key: 'github',
            logoUrl: 'https://cdn.example.test/github.png',
          },
        },
      },
    });
  });

  it('rejects malformed persisted curated metadata', async () => {
    const server = makeServer();
    const persistedServer = {
      ...server,
      definition: {
        ...server.definition,
        type: 'http',
        command: undefined,
        url: 'https://mcp.example.test',
        curated: { key: 'github', logoUrl: 42 },
      },
    };
    mockedReadFile.mockResolvedValue(
      JSON.stringify({ version: 1, server: persistedServer }),
    );

    await expect(
      getHandler('mcp-servers:load-server')({}, 'aaaa-bbbb-1111'),
    ).rejects.toThrow('Curated MCP server logoUrl must be a string.');
  });

  it('rejects malformed persisted HTTP auth handling', async () => {
    const server = makeServer();
    const persistedServer = {
      ...server,
      definition: {
        ...server.definition,
        type: 'http',
        command: undefined,
        url: 'https://mcp.example.test',
        httpAuthHandler: 'invalid',
      },
    };
    mockedReadFile.mockResolvedValue(
      JSON.stringify({ version: 1, server: persistedServer }),
    );

    await expect(
      getHandler('mcp-servers:load-server')({}, 'aaaa-bbbb-1111'),
    ).rejects.toThrow(
      'HTTP auth handler must be "canopy", "provider", or "account".',
    );
  });

  it('throws when server file has wrong version', async () => {
    const server = makeServer();
    mockedReadFile.mockResolvedValue(makeServerFileJson(server, 2));

    const handler = getHandler('mcp-servers:load-server');

    await expect(handler({}, 'aaaa-bbbb-1111')).rejects.toThrow(
      'Invalid MCP server file',
    );
  });
});

// ---------------------------------------------------------------------------
// CRUD — save server handler
// ---------------------------------------------------------------------------

describe('save server handler', () => {
  it('persists the account binding while inheriting the global account handler', async (): Promise<void> => {
    jest.mocked(readPreferencesFile).mockResolvedValueOnce(
      partialPreferences({
        mcpProxyPort: 37645,
        mcpHttpAuthDefaultHandler: 'account',
      }),
    );
    const server = makeServer({
      definition: {
        type: 'http',
        command: undefined,
        url: 'https://custom.example.test',
      },
    });
    mockMcpFiles(makeIndexFileJson([]));
    await getHandler('mcp-servers:save-server')(
      {},
      {
        ...server,
        accountConnectionId: 'a1111111-1111-4111-8111-111111111111',
      },
    );
    const written = mockedWriteFile.mock.calls.find(
      ([path]): boolean =>
        typeof path === 'string' && path.endsWith('index.json'),
    );
    expect(written?.[1]).toContain(
      '"accountConnectionId": "a1111111-1111-4111-8111-111111111111"',
    );
    expect(written?.[1]).toContain('"authHandler": "account"');
    expect(written?.[1]).toContain('"scope": "account"');
  });

  it.each([false, true])(
    'preserves index-only account routing unless explicitly cleared (%s)',
    async (clear): Promise<void> => {
      const server = makeServer({
        definition: {
          type: 'http',
          command: undefined,
          url: 'https://custom.example.test',
        },
      });
      const routing = {
        scope: 'account' as const,
        authHandler: 'account' as const,
        accountConnectionId: 'a1111111-1111-4111-8111-111111111111',
      };
      mockMcpFiles(
        makeIndexFileJson([{ ...toIndexEntry(server), ...routing }]),
        [server],
      );
      await getHandler('mcp-servers:save-server')(
        {},
        {
          ...server,
          configs: server.configs.map(
            (config): McpServerConfigData => ({
              ...config,
              enabled: false,
            }),
          ),
          ...(clear ? { accountRouting: 'clear' } : {}),
        },
      );
      const written = mockedWriteFile.mock.calls.find(
        ([path]): boolean =>
          typeof path === 'string' && path.endsWith('index.json'),
      );
      if (typeof written?.[1] !== 'string') throw new Error('Missing index');
      const index: unknown = JSON.parse(written[1]);
      if (!isMcpServersIndexFile(index)) throw new Error('Invalid saved index');
      const entry = index.servers[0];
      expect(entry?.configs[0]?.enabled).toBe(false);
      if (clear) {
        for (const key of Object.keys(routing)) {
          expect(entry).not.toHaveProperty(key);
        }
      } else {
        expect(entry).toMatchObject(routing);
      }
    },
  );

  it('saves an explicit account binding and preserves it on updates', async (): Promise<void> => {
    const accountConnectionId = 'a1111111-1111-4111-8111-111111111111';
    const server = makeServer({
      definition: {
        type: 'http',
        command: undefined,
        url: 'https://custom.example.test',
        httpAuthHandler: 'account',
      },
    });
    const handler = getHandler('mcp-servers:save-server');
    mockMcpFiles(makeIndexFileJson([]));
    await handler({}, { ...server, accountConnectionId });
    const indexWrite = mockedWriteFile.mock.calls.find(
      ([path]): boolean =>
        typeof path === 'string' && path.endsWith('index.json'),
    );
    expect(indexWrite).toBeDefined();
    expect(indexWrite?.[1]).toContain(
      `"accountConnectionId": "${accountConnectionId}"`,
    );
    expect(indexWrite?.[1]).toContain('"scope": "account"');
    mockedWriteFile.mockClear();
    mockMcpFiles(
      makeIndexFileJson([
        {
          ...toIndexEntry(server),
          scope: 'account',
          authHandler: 'account',
          accountConnectionId,
        },
      ]),
      [server],
    );
    await handler({}, server);
    const updated = mockedWriteFile.mock.calls.find(
      ([path]): boolean =>
        typeof path === 'string' && path.endsWith('index.json'),
    );
    expect(updated?.[1]).toContain(
      `"accountConnectionId": "${accountConnectionId}"`,
    );
  });

  it('clears account and catalog metadata when saved with the default handler', async (): Promise<void> => {
    const server = makeServer({
      definition: {
        type: 'http',
        command: undefined,
        url: 'https://custom.example.test',
        httpAuthHandler: 'account',
        curated: {
          key: 'custom',
          logoUrl: 'https://custom.example.test/logo.png',
          requiresProviderAuth: false,
        },
      },
    });
    const files = useMcpDisk({ [MOCK_INDEX_PATH]: makeIndexFileJson([]) });
    const storedIndex = (): string => files.get(MOCK_INDEX_PATH) ?? '';
    try {
      const handler = getHandler('mcp-servers:save-server');
      await handler(
        {},
        {
          ...server,
          accountConnectionId: 'a1111111-1111-4111-8111-111111111111',
        },
      );
      expect(storedIndex()).toContain('"scope": "account"');
      const defaultServer = makeServer({
        definition: {
          ...server.definition,
          httpAuthHandler: undefined,
          curated: undefined,
        },
      });
      await handler({}, { ...defaultServer, accountRouting: 'clear' });
      const index: unknown = JSON.parse(storedIndex());
      if (!isMcpServersIndexFile(index)) throw new Error('Invalid saved index');
      const entry = index.servers[0];
      expect(entry).toBeDefined();
      for (const key of [
        'scope',
        'authHandler',
        'accountConnectionId',
        'logoUrl',
        'curatedKey',
      ]) {
        expect(entry).not.toHaveProperty(key);
      }
      expect(
        getMcpHttpAuthDefault(defaultServer.definition, entry, 'canopy'),
      ).toBe('canopy');
    } finally {
      mockedWriteFile.mockReset();
    }
  });

  it.each(['not-a-uuid', '', 42])(
    'rejects invalid account connection id %s before writing',
    async (accountConnectionId): Promise<void> => {
      const handler = getHandler('mcp-servers:save-server');
      mockMcpFiles(makeIndexFileJson([]));
      await expect(
        handler(
          {},
          {
            ...makeServer({
              definition: {
                type: 'http',
                command: undefined,
                url: 'https://custom.example.test',
                httpAuthHandler: 'account',
              },
            }),
            accountConnectionId,
          },
        ),
      ).rejects.toThrow('Account connection id must be a UUID');
      expect(mockedWriteFile).not.toHaveBeenCalled();
    },
  );

  beforeEach(() => {
    mockedMkdir.mockResolvedValue(undefined);
    mockedWriteFile.mockResolvedValue(undefined);
    mockMcpFiles(makeIndexFileJson([]));
  });

  it('saves a server and updates the index', async () => {
    const server = makeServer({
      definition: { id: 'aaa-bbb-111' },
    });

    const handler = getHandler('mcp-servers:save-server');
    const result = (await handler({}, server)) as McpServerFile;

    expect(result.version).toBe(1);
    expect(result.server.definition.id).toBe('aaa-bbb-111');

    // Should have written both server file and index
    expect(mockedWriteFile).toHaveBeenCalledTimes(2);
  });

  it('rejects server with invalid id characters', async () => {
    const server = makeServer({
      definition: { id: 'INVALID!' },
    });

    const handler = getHandler('mcp-servers:save-server');

    await expect(handler({}, server)).rejects.toThrow('Invalid MCP server id');
  });

  it('rejects server with empty name', async () => {
    const server = makeServer({
      definition: { name: '' },
    });

    const handler = getHandler('mcp-servers:save-server');

    await expect(handler({}, server)).rejects.toThrow(
      'Server name is required',
    );
  });

  it('rejects server with whitespace-only name', async () => {
    const server = makeServer({
      definition: { name: '   ' },
    });

    const handler = getHandler('mcp-servers:save-server');

    await expect(handler({}, server)).rejects.toThrow(
      'Server name is required',
    );
  });

  it('rejects server without type', async () => {
    const server = makeServer({
      definition: { type: '' as McpServerDefinitionData['type'] },
    });

    const handler = getHandler('mcp-servers:save-server');

    await expect(handler({}, server)).rejects.toThrow(
      'Server type is required',
    );
  });

  it('rejects config missing id', async () => {
    const server = makeServer({
      configs: [makeConfig({ id: '' })],
    });

    const handler = getHandler('mcp-servers:save-server');

    await expect(handler({}, server)).rejects.toThrow(
      'Each config must have an id and name',
    );
  });

  it('rejects config missing name', async () => {
    const server = makeServer({
      configs: [makeConfig({ name: '' })],
    });

    const handler = getHandler('mcp-servers:save-server');

    await expect(handler({}, server)).rejects.toThrow(
      'Each config must have an id and name',
    );
  });

  it('rejects unsafe command definitions before persisting', async () => {
    const server = makeServer({
      definition: { command: 'bash' },
    });

    const handler = getHandler('mcp-servers:save-server');

    await expect(handler({}, server)).rejects.toThrow(
      "Invalid command 'bash' - not in allowlist",
    );
    expect(mockedWriteFile).not.toHaveBeenCalled();
  });

  it('rejects unsafe config args before persisting', async () => {
    const server = makeServer({
      configs: [makeConfig({ extraArgs: ['--eval', 'process.exit()'] })],
    });

    const handler = getHandler('mcp-servers:save-server');

    await expect(handler({}, server)).rejects.toThrow(
      "Config 'Default' args contain dangerous flags or shell metacharacters",
    );
    expect(mockedWriteFile).not.toHaveBeenCalled();
  });

  it('accepts OAuth definitions without manual client metadata', async () => {
    const server = makeServer({
      definition: {
        type: 'http',
        command: undefined,
        url: 'https://mcp.example.com/mcp',
        oauth: {},
      },
    });

    const handler = getHandler('mcp-servers:save-server');
    const result = (await handler({}, server)) as McpServerFile;

    expect(result.server.definition.oauth).toEqual({});
    expect(mockedWriteFile).toHaveBeenCalled();
  });

  it('normalizes curated metadata and defaults curated auth handling to Canopy', async () => {
    const server = makeServer({
      definition: {
        type: 'http',
        command: undefined,
        url: 'https://mcp.example.com/mcp',
        curated: {
          key: ' github ',
          logoUrl: ' https://cdn.example.com/github.png ',
        },
      },
    });

    const result = await getHandler('mcp-servers:save-server')({}, server);

    expect(result).toMatchObject({
      server: {
        definition: {
          httpAuthHandler: 'canopy',
          curated: {
            key: 'github',
            logoUrl: 'https://cdn.example.com/github.png',
          },
        },
      },
    });
  });

  it('preserves the global auth default when updating a curated server', async () => {
    const server = makeServer({
      definition: {
        type: 'http',
        command: undefined,
        url: 'https://mcp.example.com/mcp',
        curated: { key: 'github' },
        httpAuthHandler: undefined,
      },
    });
    mockMcpFiles(makeIndexFileJson([toIndexEntry(server)]), [server]);

    const result = await getHandler('mcp-servers:save-server')({}, server);

    expect(result).toMatchObject({
      server: { definition: { httpAuthHandler: undefined } },
    });
  });

  it('enforces provider-managed auth required by curated metadata', async () => {
    const server = makeServer({
      definition: {
        type: 'http',
        command: undefined,
        url: 'https://mcp.example.com/mcp',
        curated: { key: 'private-oauth', requiresProviderAuth: true },
        httpAuthHandler: 'canopy',
      },
    });

    await expect(
      getHandler('mcp-servers:save-server')({}, server),
    ).rejects.toThrow(
      'This curated MCP server requires provider-managed OAuth.',
    );
    expect(mockedWriteFile).not.toHaveBeenCalled();
  });

  it('rehydrates provider-managed auth requirements from the catalog', async () => {
    mockListCuratedMcpServers.mockResolvedValueOnce({
      version: 1,
      servers: [
        {
          key: 'private-oauth',
          name: 'Private OAuth',
          shortDescription: 'Requires a confidential client',
          url: 'https://mcp.example.com/mcp',
          transport: 'http',
          requiredConfigFields: [{ kind: 'oauth-client-secret' }],
          categories: [],
          popular: false,
          sortOrder: 0,
          updatedAt: '2026-07-22T00:00:00.000Z',
        },
      ],
    });
    const server = makeServer({
      definition: {
        type: 'http',
        command: undefined,
        url: 'https://mcp.example.com/mcp',
        curated: { key: 'private-oauth' },
        httpAuthHandler: 'canopy',
      },
    });

    await expect(
      getHandler('mcp-servers:save-server')({}, server),
    ).rejects.toThrow(
      'This curated MCP server requires provider-managed OAuth.',
    );
    expect(mockedWriteFile).not.toHaveBeenCalled();
  });

  it('rejects standalone OAuth client secrets before persisting', async () => {
    const server = makeServer({
      definition: {
        type: 'http',
        command: undefined,
        url: 'https://mcp.example.com/mcp',
        oauth: {
          clientSecret: 'top-secret',
        },
      },
    });

    const handler = getHandler('mcp-servers:save-server');

    await expect(handler({}, server)).rejects.toThrow(
      'Standalone MCP OAuth client secrets are not supported because they would be stored unencrypted.',
    );
    expect(mockedWriteFile).not.toHaveBeenCalled();
  });

  it('rejects OAuth definitions on command servers before persisting', async () => {
    const server = makeServer({
      definition: {
        oauth: {
          clientId: 'client-id',
          authorizationUrl: 'https://auth.example.com/authorize',
          tokenUrl: 'https://auth.example.com/token',
          scopes: [],
          usePkce: true,
        },
      },
    });

    const handler = getHandler('mcp-servers:save-server');

    await expect(handler({}, server)).rejects.toThrow(
      'OAuth is only supported for HTTP MCP servers.',
    );
    expect(mockedWriteFile).not.toHaveBeenCalled();
  });

  it('starts standalone OAuth with the actual bound proxy port', async () => {
    mockProxyGetPort.mockReturnValue(37777);
    mockedReadFile.mockResolvedValue(
      makeServerFileJson(
        makeServer({
          definition: {
            type: 'http',
            command: undefined,
            url: 'https://mcp.example.com/mcp',
            oauth: {},
          },
        }),
      ),
    );

    const handler = getHandler('mcp-servers:start-oauth-login');
    await handler(
      {},
      {
        serverId: 'aaaa-bbbb-1111',
        configId: 'c0f1-0001',
        browser: 'embedded',
      },
    );

    expect(mockProxyEnsureStarted).toHaveBeenCalledWith(37645);
    expect(mockedStartMcpOAuthFlow).toHaveBeenCalledWith(
      expect.objectContaining({ proxyPort: 37777, browser: 'embedded' }),
    );
  });

  it('queues matching Codex MCP refreshes when OAuth is already connected', async () => {
    mockedStartMcpOAuthFlow.mockResolvedValueOnce({ status: 'completed' });
    mockedReadFile.mockResolvedValue(
      makeServerFileJson(
        makeServer({
          definition: {
            type: 'http',
            command: undefined,
            url: 'https://mcp.example.com/mcp',
            oauth: {},
          },
        }),
      ),
    );

    const handler = getHandler('mcp-servers:start-oauth-login');
    await handler({}, { serverId: 'aaaa-bbbb-1111', configId: 'c0f1-0001' });

    expect(mockRefreshCodexSessionsAfterMcpOAuth).toHaveBeenCalledWith({
      serverId: 'aaaa-bbbb-1111',
      configId: 'c0f1-0001',
    });
  });

  it('generates a UUID when definition id is empty', async () => {
    const server = makeServer({
      definition: { id: '' },
    });

    const handler = getHandler('mcp-servers:save-server');
    const result = (await handler({}, server)) as McpServerFile;

    expect(result.server.definition.id).toBe(
      'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    );
  });

  it('creates directories before writing', async () => {
    const server = makeServer({
      definition: { id: 'aaa-bbb-111' },
    });

    const handler = getHandler('mcp-servers:save-server');
    await handler({}, server);

    expect(mockedMkdir).toHaveBeenCalledWith(expect.any(String), {
      recursive: true,
    });
  });

  it('updates existing entry in index instead of duplicating', async () => {
    const existingEntry: McpServerIndexEntry = {
      id: 'aaa-bbb-111',
      name: 'Old Name',
      description: 'Old Desc',
      type: 'command',
      configs: [],
      updatedAt: '2025-01-01T00:00:00Z',
    };
    mockMcpFiles(makeIndexFileJson([existingEntry]));

    const server = makeServer({
      definition: { id: 'aaa-bbb-111', name: 'New Name' },
    });

    const handler = getHandler('mcp-servers:save-server');
    await handler({}, server);

    // Find the writeFile call for the index
    const indexWriteCall = mockedWriteFile.mock.calls.find(([path]) =>
      (path as string).includes('index.json'),
    );
    expect(indexWriteCall).toBeDefined();
    const written = JSON.parse(
      indexWriteCall![1] as string,
    ) as McpServersIndexFile;
    expect(written.servers).toHaveLength(1);
    expect(written.servers[0].name).toBe('New Name');
  });
});

// ---------------------------------------------------------------------------
// CRUD — delete server handler
// ---------------------------------------------------------------------------

describe('delete server handler', () => {
  beforeEach(() => {
    mockedMkdir.mockResolvedValue(undefined);
    mockedWriteFile.mockResolvedValue(undefined);
    mockedUnlink.mockResolvedValue(undefined);
  });

  it('rejects invalid server id', async () => {
    const handler = getHandler('mcp-servers:delete-server');

    await expect(handler({}, 'INVALID!')).rejects.toThrow(
      'Invalid MCP server id',
    );
  });
  it('preserves the index when deleting the server file fails', async () => {
    mockedReadFile.mockResolvedValue(makeIndexFileJson([]));
    mockedUnlink.mockRejectedValueOnce(
      Object.assign(new Error('access denied'), { code: 'EACCES' }),
    );
    await expect(
      getHandler('mcp-servers:delete-server')({}, 'aaa-bbb-111'),
    ).rejects.toThrow('access denied');
    expect(mockedWriteFile).not.toHaveBeenCalled();
  });

  it('removes server from index after deletion', async () => {
    const entry: McpServerIndexEntry = {
      id: 'aaa-bbb-111',
      name: 'Server',
      description: 'Desc',
      type: 'command',
      configs: [],
      updatedAt: '2025-01-01T00:00:00Z',
    };
    mockedReadFile.mockResolvedValue(makeIndexFileJson([entry]));

    const handler = getHandler('mcp-servers:delete-server');
    await handler({}, 'aaa-bbb-111');

    expect(mockedUnlink).toHaveBeenCalledWith(
      '/mock/mcp-servers/server-aaa-bbb-111.json',
    );

    const indexWriteCall = mockedWriteFile.mock.calls.find(([path]) =>
      (path as string).includes('index.json'),
    );
    expect(indexWriteCall).toBeDefined();
    const written = JSON.parse(
      indexWriteCall![1] as string,
    ) as McpServersIndexFile;
    expect(written.servers).toHaveLength(0);
  });

  it('does not throw when server file does not exist', async () => {
    mockedUnlink.mockRejectedValue(
      Object.assign(new Error('ENOENT'), { code: 'ENOENT' }),
    );
    mockedReadFile.mockResolvedValue(makeIndexFileJson([]));

    const handler = getHandler('mcp-servers:delete-server');

    await expect(handler({}, 'aaa-bbb-111')).resolves.not.toThrow();
  });

  it('retains the index and reports failure when the server file cannot be removed', async () => {
    mockedUnlink.mockRejectedValue(
      Object.assign(new Error('Permission denied'), { code: 'EACCES' }),
    );
    mockedReadFile.mockResolvedValue(makeIndexFileJson([]));
    await expect(
      getHandler('mcp-servers:delete-server')({}, 'aaa-bbb-111'),
    ).rejects.toThrow('Permission denied');
    expect(mockedWriteFile).not.toHaveBeenCalled();
  });

  it("clears the deleted server's own sign-ins", async () => {
    const server = makeServer({
      definition: { id: 'aaa-bbb-111', type: 'http', url: 'https://x.test' },
      configs: [makeConfig({ id: 'cfg-a' }), makeConfig({ id: 'cfg-b' })],
    });
    mockedReadFile.mockImplementation(
      (path): Promise<string> =>
        Promise.resolve(
          typeof path === 'string' && path.includes('index.json')
            ? makeIndexFileJson([])
            : makeServerFileJson(server),
        ),
    );
    await getHandler('mcp-servers:delete-server')({}, 'aaa-bbb-111');
    expect(clearMcpOAuthToken).toHaveBeenCalledWith('aaa-bbb-111', 'cfg-a');
    expect(clearMcpOAuthToken).toHaveBeenCalledWith('aaa-bbb-111', 'cfg-b');
  });
});

describe('get tools handler validation', () => {
  it.each(['binding', 'route', 'policy'] as const)(
    'invalidates GET_TOOLS after changing the account %s',
    async (change): Promise<void> => {
      const server = makeServer({
        definition: {
          type: 'http',
          command: undefined,
          url: 'https://custom.example.test',
          httpAuthHandler: 'account',
        },
      });
      const config = server.configs[0];
      if (!config) throw new Error('Missing fixture config');
      let connection: AccountConnectionsModule.AccountMcpConnection = {
        id: 'account-a',
        serverKey: 'custom',
        configId: config.id,
        displayName: 'Account',
        kind: 'CUSTOM',
        status: 'CONNECTED',
        routeId: 'route-a',
        enabledTools: null,
      };
      jest
        .mocked(findAccountMcpConnection)
        .mockImplementation(
          (): Promise<AccountConnectionsModule.AccountMcpConnection> =>
            Promise.resolve(connection),
        );
      let cache = '{}';
      mockedReadFile.mockImplementation(
        (path): Promise<string> =>
          Promise.resolve(
            typeof path === 'string' && path.endsWith('index.json')
              ? makeIndexFileJson([
                  {
                    ...toIndexEntry(server),
                    accountConnectionId: connection.id,
                  },
                ])
              : typeof path === 'string' && path.endsWith('tools-cache.json')
                ? cache
                : makeServerFileJson(server),
          ),
      );
      const { mcpToolsSourceFingerprint } =
        await import('../mcp/tool-discovery');
      cache = JSON.stringify({
        version: 1,
        entries: {
          [`${server.definition.id}:${config.id}`]: {
            tools: ['old-tool'],
            discoveredAt: new Date().toISOString(),
            sourceFingerprint: await mcpToolsSourceFingerprint(
              server.definition,
              config,
            ),
          },
        },
      });
      const handler = getHandler('mcp-servers:get-tools');
      await expect(
        handler({}, server.definition.id, config.id),
      ).resolves.toMatchObject({ tools: ['old-tool'] });
      connection = {
        ...connection,
        ...(change === 'binding'
          ? { id: 'account-b' }
          : change === 'route'
            ? { routeId: 'route-b' }
            : { enabledTools: ['read'] }),
      };
      await expect(
        handler({}, server.definition.id, config.id),
      ).resolves.toBeNull();
    },
  );

  it('accepts canonical lowercase IDs containing non-hex characters', async () => {
    mockedReadFile.mockRejectedValueOnce(new Error('validated read reached'));

    const handler = getHandler('mcp-servers:get-tools');

    await expect(handler({}, 'server-g1', 'config-z1')).rejects.toThrow(
      'validated read reached',
    );
  });

  it('rejects malformed IDs that the old hex-only regex accepted', async () => {
    const handler = getHandler('mcp-servers:get-tools');

    await expect(handler({}, '--')).rejects.toThrow('Invalid MCP server id');
  });
});

describe('test connection handler', () => {
  it('returns a failed connection test when the subprocess stdin closes', async () => {
    const proc = createMockChildProcess();
    mockSpawn.mockReturnValue(proc.child);
    mockedReadFile.mockResolvedValue(makeServerFileJson(makeServer()));
    const result = getHandler('mcp-servers:test-connection')(
      {},
      'aaaa-bbbb-1111',
      'c0f1-0001',
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    try {
      expect(() =>
        proc.stdin.emit(
          'error',
          Object.assign(new Error('write EOF'), { code: 'EOF' }),
        ),
      ).not.toThrow();
      await expect(result).resolves.toMatchObject({
        success: false,
        error: 'write EOF',
      });
      expect(proc.kill).toHaveBeenCalled();
    } finally {
      proc.child.emit('close', 1);
      await result;
    }
  });

  it('uses framed MCP stdio messages and merges the selected config', async () => {
    const proc = createMockChildProcess();
    mockSpawn.mockReturnValue(proc.child);
    mockedReadFile.mockResolvedValue(
      makeServerFileJson(
        makeServer({
          configs: [
            makeConfig({
              id: 'c0f2-0002',
              name: 'Prod',
              envVars: { API_TOKEN: 'secret' },
              extraArgs: ['--port', '3000'],
            }),
          ],
        }),
      ),
    );

    const inventoryChanged = jest.fn();
    const unsubscribe = subscribeDesktopInventoryChanges(inventoryChanged);
    const handler = getHandler('mcp-servers:test-connection');
    const resultPromise = handler({}, 'aaaa-bbbb-1111', 'c0f2-0002');
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(mockSpawn).toHaveBeenCalledWith(
      'npx',
      ['-y', '@test/mcp-server', '--port', '3000'],
      expect.objectContaining({
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        env: expect.objectContaining({ API_TOKEN: 'secret' }),
      }),
    );

    const initMessage = String(proc.stdinWrite.mock.calls[0]?.[0] ?? '');
    expect(initMessage).toContain('Content-Length: ');
    expect(initMessage).toContain('"method":"initialize"');

    proc.stdout.emit(
      'data',
      Buffer.from(
        toMcpFrame({
          jsonrpc: '2.0',
          id: 1,
          result: { serverInfo: { name: 'Test Server', version: '1.0.0' } },
        }),
        'utf8',
      ),
    );

    const result = await resultPromise;
    expect(result).toMatchObject({
      serverId: 'aaaa-bbbb-1111',
      configId: 'c0f2-0002',
      success: true,
    });
    unsubscribe();
    expect(inventoryChanged).toHaveBeenCalledWith(['mcp_servers']);
    expect(proc.kill).toHaveBeenCalled();
  });

  it('keeps endpoint health reachable when HTTP tools/list fails', async () => {
    mockedReadFile.mockResolvedValue(
      makeServerFileJson(
        makeServer({
          definition: {
            type: 'http',
            command: undefined,
            url: 'https://mcp.example.test',
            httpAuthHandler: 'provider',
          },
        }),
      ),
    );
    const fetchMock: jest.MockedFunction<typeof fetch> = jest.fn();
    fetchMock
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            result: { protocolVersion: '2025-06-18' },
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(new Response(null, { status: 202 }))
      .mockResolvedValueOnce(new Response('', { status: 500 }));
    global.fetch = fetchMock;

    const result = await getHandler('mcp-servers:test-connection')(
      {},
      'aaaa-bbbb-1111',
      'c0f1-0001',
    );

    expect(result).toMatchObject({
      success: false,
      message: 'MCP tools/list failed',
      endpointReachable: true,
    });
    expect(getMcpServerHealth('aaaa-bbbb-1111')).toMatchObject({
      status: 'healthy',
    });
  });

  it.each([
    {
      name: 'RPC error',
      response: new Response(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 2,
          error: { message: 'No tools' },
        }),
      ),
      message: 'MCP error',
    },
    {
      name: 'invalid response',
      response: new Response(JSON.stringify({ jsonrpc: '2.0', id: 2 })),
      message: 'Invalid MCP tools response — missing result or error field',
    },
  ])(
    'keeps endpoint health reachable after a tools-phase $name',
    async ({ response, message }) => {
      mockedReadFile.mockResolvedValue(
        makeServerFileJson(
          makeServer({
            definition: {
              type: 'http',
              command: undefined,
              url: 'https://mcp.example.test',
              httpAuthHandler: 'provider',
            },
          }),
        ),
      );
      const fetchMock: jest.MockedFunction<typeof fetch> = jest.fn();
      fetchMock
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              jsonrpc: '2.0',
              id: 1,
              result: { protocolVersion: '2025-06-18' },
            }),
          ),
        )
        .mockResolvedValueOnce(new Response(null, { status: 202 }))
        .mockResolvedValueOnce(response);
      global.fetch = fetchMock;

      const result = await getHandler('mcp-servers:test-connection')(
        {},
        'aaaa-bbbb-1111',
        'c0f1-0001',
      );

      expect(result).toMatchObject({
        success: false,
        message,
        endpointReachable: true,
      });
      expect(getMcpServerHealth('aaaa-bbbb-1111')).toMatchObject({
        status: 'healthy',
      });
    },
  );

  it('keeps endpoint health reachable after a tools-phase timeout', async () => {
    mockedReadFile.mockResolvedValue(
      makeServerFileJson(
        makeServer({
          definition: {
            type: 'http',
            command: undefined,
            url: 'https://mcp.example.test',
            httpAuthHandler: 'provider',
          },
        }),
      ),
    );
    const fetchMock: jest.MockedFunction<typeof fetch> = jest.fn();
    fetchMock
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            result: { protocolVersion: '2025-06-18' },
          }),
        ),
      )
      .mockResolvedValueOnce(new Response(null, { status: 202 }))
      .mockRejectedValueOnce(new Error('request timeout'));
    global.fetch = fetchMock;

    const result = await getHandler('mcp-servers:test-connection')(
      {},
      'aaaa-bbbb-1111',
      'c0f1-0001',
    );

    expect(result).toMatchObject({
      success: false,
      message: 'Connection timed out',
      endpointReachable: true,
    });
    expect(getMcpServerHealth('aaaa-bbbb-1111')).toMatchObject({
      status: 'healthy',
    });
  });

  it.each([false, true])(
    'tests a discovery-only OAuth server with its stored token (inspect=%s)',
    async (inspect) => {
      mockedReadFile.mockResolvedValue(
        makeServerFileJson(
          makeServer({
            definition: {
              type: 'http',
              command: undefined,
              url: 'https://mcp.example.test',
              oauth: undefined,
              httpAuthHandler: 'canopy',
            },
          }),
        ),
      );
      mockedGetValidMcpAccessToken.mockResolvedValueOnce('token-123');
      const fetchMock = jest
        .fn()
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              jsonrpc: '2.0',
              id: 1,
              result: { protocolVersion: '2025-06-18' },
            }),
            { status: 200 },
          ),
        )
        .mockResolvedValueOnce(new Response(null, { status: 202 }))
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              jsonrpc: '2.0',
              id: 2,
              result: { tools: [{ name: 'search' }] },
            }),
            { status: 200 },
          ),
        );
      global.fetch = fetchMock;

      const inspectProbe = jest.fn();
      const result = inspect
        ? await testMcpServerConnection(
            'aaaa-bbbb-1111',
            'c0f1-0001',
            inspectProbe,
          )
        : await getHandler('mcp-servers:test-connection')(
            {},
            'aaaa-bbbb-1111',
            'c0f1-0001',
          );
      if (inspect) {
        const expectedHeaders: unknown = expect.objectContaining({
          Authorization: 'Bearer token-123',
        });
        expect(inspectProbe).toHaveBeenCalledWith(
          expect.objectContaining({
            headers: expectedHeaders,
          }),
        );
        expect(JSON.stringify(result)).not.toContain('token-123');
      }

      expect(result).toMatchObject({ success: true, tools: ['search'] });
      expect(fetchMock).toHaveBeenCalledWith(
        'https://mcp.example.test',
        expect.objectContaining({
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
          headers: expect.objectContaining({
            Authorization: 'Bearer token-123',
          }),
        }),
      );
    },
  );
});

describe('handler-aware HTTP probes', () => {
  it.each(['mcp-servers:check-health', 'mcp-servers:test-connection'])(
    '%s never probes an account server directly when it has no config',
    async (channel): Promise<void> => {
      mockedReadFile.mockResolvedValue(
        makeServerFileJson(
          makeServer({
            definition: {
              type: 'http',
              command: undefined,
              url: 'https://mcp.example.test',
              httpAuthHandler: 'account',
            },
            configs: [],
          }),
        ),
      );
      const fetchMock: jest.MockedFunction<typeof fetch> = jest.fn();
      fetchMock.mockResolvedValue(new Response('', { status: 401 }));
      global.fetch = fetchMock;
      await expect(getHandler(channel)({}, 'aaaa-bbbb-1111')).rejects.toThrow(
        'Account MCP connection requires a config.',
      );
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it('probes provider-managed OAuth servers directly, including 401 reachability', async () => {
    mockedReadFile.mockResolvedValue(
      makeServerFileJson(
        makeServer({
          definition: {
            type: 'http',
            command: undefined,
            url: 'https://mcp.example.test',
            oauth: { usePkce: true },
            httpAuthHandler: 'provider',
          },
        }),
      ),
    );
    const fetchMock: jest.MockedFunction<typeof fetch> = jest.fn();
    fetchMock.mockResolvedValue(
      new Response('', { status: 401, statusText: 'Unauthorized' }),
    );
    global.fetch = fetchMock;

    const result = await getHandler('mcp-servers:check-health')(
      {},
      'aaaa-bbbb-1111',
      'c0f1-0001',
    );

    expect(result).toMatchObject({ status: 'needs_auth', statusCode: 401 });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://mcp.example.test',
      expect.any(Object),
    );
    expect(mockProxyRegisterRoute).not.toHaveBeenCalled();
  });

  it('probes Canopy-managed OAuth servers directly with the stored token', async () => {
    mockedReadFile.mockResolvedValue(
      makeServerFileJson(
        makeServer({
          definition: {
            type: 'http',
            command: undefined,
            url: 'https://mcp.example.test',
            oauth: { usePkce: true },
            httpAuthHandler: 'canopy',
          },
        }),
      ),
    );
    mockedGetValidMcpAccessToken.mockResolvedValueOnce('token-123');
    const fetchMock: jest.MockedFunction<typeof fetch> = jest.fn();
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ result: {} }), { status: 200 }),
    );
    global.fetch = fetchMock;

    const result = await getHandler('mcp-servers:check-health')(
      {},
      'aaaa-bbbb-1111',
      'c0f1-0001',
    );

    expect(result).toMatchObject({ status: 'healthy' });
    expect(mockProxyRegisterRoute).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledWith(
      'https://mcp.example.test',
      expect.objectContaining({
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        headers: expect.objectContaining({
          Accept: 'application/json, text/event-stream',
          Authorization: 'Bearer token-123',
        }),
      }),
    );
  });

  it('health-checks a discovery-only OAuth server with its stored token', async () => {
    mockedReadFile.mockResolvedValue(
      makeServerFileJson(
        makeServer({
          definition: {
            type: 'http',
            command: undefined,
            url: 'https://mcp.example.test',
            oauth: undefined,
            httpAuthHandler: 'canopy',
          },
        }),
      ),
    );
    mockedGetValidMcpAccessToken.mockResolvedValueOnce('token-123');
    const fetchMock = jest
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ result: {} }), { status: 200 }),
      );
    global.fetch = fetchMock;

    const result = await getHandler('mcp-servers:check-health')(
      {},
      'aaaa-bbbb-1111',
      'c0f1-0001',
    );

    expect(result).toMatchObject({ status: 'healthy' });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://mcp.example.test',
      expect.objectContaining({
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        headers: expect.objectContaining({
          Authorization: 'Bearer token-123',
        }),
      }),
    );
  });

  it('reports needs_auth when a Canopy-managed server has no stored token', async () => {
    mockedReadFile.mockResolvedValue(
      makeServerFileJson(
        makeServer({
          definition: {
            type: 'http',
            command: undefined,
            url: 'https://mcp.example.test',
            oauth: { usePkce: true },
            httpAuthHandler: 'canopy',
          },
        }),
      ),
    );
    mockedGetValidMcpAccessToken.mockResolvedValueOnce(null);
    const fetchMock: jest.MockedFunction<typeof fetch> = jest.fn();
    fetchMock.mockResolvedValue(
      new Response('', { status: 401, statusText: 'Unauthorized' }),
    );
    global.fetch = fetchMock;

    const result = await getHandler('mcp-servers:check-health')(
      {},
      'aaaa-bbbb-1111',
      'c0f1-0001',
    );

    expect(result).toMatchObject({ status: 'needs_auth', statusCode: 401 });
    expect(mockProxyRegisterRoute).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledWith(
      'https://mcp.example.test',
      expect.objectContaining({
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        headers: expect.not.objectContaining({
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
          Authorization: expect.anything(),
        }),
      }),
    );
  });
});

describe('mcp-servers:open-provider-connector-settings', () => {
  const mockedOpenExternal = jest.mocked(openExternalGuarded);

  beforeEach(() => {
    mockedOpenExternal.mockClear();
  });

  it('opens a per-app install URL', async () => {
    const handler = getHandler('mcp-servers:open-provider-connector-settings');
    await handler(
      {},
      {
        provider: 'codex',
        installUrl: 'https://chatgpt.com/apps/gmail/connector_abc',
      },
    );
    expect(mockedOpenExternal).toHaveBeenCalledWith(
      'https://chatgpt.com/apps/gmail/connector_abc',
    );
  });

  it('falls back to the provider directory when no install URL is given', async () => {
    // Per provider: one shared fallback sent every Codex connect to Claude.
    const handler = getHandler('mcp-servers:open-provider-connector-settings');
    await handler({}, { provider: 'codex' });
    expect(mockedOpenExternal).toHaveBeenCalledWith(
      expect.stringContaining('chatgpt.com'),
    );
  });

  it('refuses a non-https install URL', async () => {
    // `installUrl` arrives over IPC and originates in Codex's on-disk cache,
    // which Canopy neither writes nor validates, and `openExternalGuarded`
    // performs no scheme check of its own.
    const handler = getHandler('mcp-servers:open-provider-connector-settings');
    await handler(
      {},
      {
        provider: 'codex',
        installUrl: 'file:///etc/passwd',
      },
    );
    expect(mockedOpenExternal).not.toHaveBeenCalled();
  });

  it('refuses an unparseable install URL', async () => {
    const handler = getHandler('mcp-servers:open-provider-connector-settings');
    await handler({}, { provider: 'claude', installUrl: 'not a url' });
    expect(mockedOpenExternal).not.toHaveBeenCalled();
  });

  it('refuses an unknown provider instead of throwing on the fallback', async () => {
    // An unexpected provider makes the manage-URL lookup `undefined`, which
    // would throw inside the handler rather than simply doing nothing.
    const handler = getHandler('mcp-servers:open-provider-connector-settings');
    await expect(handler({}, { provider: 'gemini' })).resolves.toBeUndefined();
    expect(mockedOpenExternal).not.toHaveBeenCalled();
  });
});

describe('account connection IPC validation', (): void => {
  beforeEach((): void => {
    jest.spyOn(getFeatureFlagService(), 'isEnabled').mockReturnValue(true);
  });
  afterEach((): void => {
    jest.restoreAllMocks();
  });
  it.each([
    {},
    { serverKey: 'github', customUrl: 'https://mcp.test', configId: 'default' },
    { serverKey: 'github', configId: '../escape' },
    { customUrl: 'bad', configId: 'default' },
    {
      serverKey: 'github',
      endpointUrl: 'http://unsafe.test',
      configId: 'default',
    },
    {
      customUrl: 'https://mcp.test',
      endpointUrl: 'https://other.test',
      configId: 'default',
    },
    { serverKey: 'github', configId: 'default', bearerToken: 123 },
    {
      serverKey: 'github',
      configId: 'default',
      oauthClient: { clientSecret: 'secret' },
    },
    {
      serverKey: 'github',
      configId: 'default',
      oauthClient: { clientId: ' ' },
    },
    {
      serverKey: 'github',
      configId: 'default',
      oauthClient: { clientId: 'client', clientSecret: 1 },
    },
    {
      serverKey: 'github',
      configId: 'default',
      oauthClient: { clientId: 'client' },
      bearerToken: 'token',
    },
    { serverKey: 'github', configId: 'default', displayName: 'GitHub' },
    { customUrl: 'https://mcp.test', configId: 'default', displayName: ' ' },
    {
      customUrl: 'https://mcp.test',
      configId: 'default',
      displayName: 'x'.repeat(121),
    },
    { serverKey: 'github', configId: 'default', headers: { 'X-Team': 'a' } },
    {
      customUrl: 'https://mcp.test',
      configId: 'default',
      headers: { Authorization: 'Bearer x' },
    },
    {
      customUrl: 'https://mcp.test',
      configId: 'default',
      headers: { 'X-Team': 'a\r\nX-Injected: b' },
    },
    { customUrl: 'https://mcp.test', configId: 'default', headers: ['X-A'] },
    {
      customUrl: 'https://mcp.test',
      configId: 'default',
      headers: Object.fromEntries(
        Array.from({ length: 17 }, (_, index) => [`x-h${index}`, 'v']),
      ),
    },
  ])(
    'rejects invalid starts before cloud requests: %j',
    async (request): Promise<void> => {
      await expect(
        getHandler(MCP_SERVER_CHANNELS.START_ACCOUNT)({}, request),
      ).rejects.toThrow();
    },
  );
  it.each([undefined, 'embedded'] as const)(
    'accepts start browser %p and omits it for external/older hosts',
    async (browser) => {
      const start = jest
        .spyOn(accountConnections, 'startAccountMcpConnection')
        .mockResolvedValue({ authorizationUrl: 'https://auth.example.test' });
      const request = {
        serverKey: 'github',
        configId: 'default',
        ...(browser ? { browser } : {}),
      };
      await getHandler(MCP_SERVER_CHANNELS.START_ACCOUNT)({}, request);
      expect(start).toHaveBeenCalledWith(request);
    },
  );
  it.each(['external', 'popup', null, true])(
    'rejects invalid browser %p',
    async (browser) => {
      const start = jest.spyOn(accountConnections, 'startAccountMcpConnection');
      await expect(
        getHandler(MCP_SERVER_CHANNELS.START_ACCOUNT)(
          {},
          { serverKey: 'github', configId: 'default', browser },
        ),
      ).rejects.toThrow();
      expect(start).not.toHaveBeenCalled();
    },
  );
  it('forwards the curated key and selected endpoint to the cloud client', async (): Promise<void> => {
    const start = jest
      .spyOn(accountConnections, 'startAccountMcpConnection')
      .mockResolvedValue({ authorizationUrl: 'https://auth.example.test' });
    const request = {
      serverKey: 'github',
      endpointUrl: 'https://eu.example.test/mcp',
      oauthClient: { clientId: 'own-client', clientSecret: 'own-secret' },
      configId: 'default',
      expectedAccountId: 'acct-1',
    };
    await getHandler(MCP_SERVER_CHANNELS.START_ACCOUNT)({}, request);
    expect(start).toHaveBeenCalledWith(request);
  });
  it('forwards a trimmed custom display name with the custom URL', async (): Promise<void> => {
    const start = jest
      .spyOn(accountConnections, 'startAccountMcpConnection')
      .mockResolvedValue({ authorizationUrl: 'https://auth.example.test' });
    await getHandler(MCP_SERVER_CHANNELS.START_ACCOUNT)(
      {},
      {
        customUrl: 'https://mcp.example.test/mcp',
        displayName: '  Internal tools ',
        bearerToken: 'device-token',
        configId: 'default',
        expectedAccountId: 'acct-1',
      },
    );
    expect(start).toHaveBeenCalledWith({
      customUrl: 'https://mcp.example.test/mcp',
      displayName: 'Internal tools',
      bearerToken: 'device-token',
      configId: 'default',
      expectedAccountId: 'acct-1',
    });
  });
  it('returns the header the cloud refused with the failure', async (): Promise<void> => {
    jest
      .spyOn(accountConnections, 'startAccountMcpConnection')
      .mockRejectedValue(
        new AccountMcpConnectionError('invalid-headers', 'X-Team'),
      );
    await expect(
      getHandler(MCP_SERVER_CHANNELS.START_ACCOUNT)(
        {},
        {
          customUrl: 'https://mcp.example.test/mcp',
          headers: { 'X-Team': 'core' },
          configId: 'default',
        },
      ),
    ).resolves.toEqual({
      error: { code: 'invalid-headers', header: 'X-Team' },
    });
  });
  it('returns what the OAuth app needs and the cloud refusal code with the failure', async (): Promise<void> => {
    const clientSetup = {
      redirectUri:
        'https://app.example.test/api/mcp-connections/callback/issuer-key',
      issuer: 'https://accounts.example.test',
      clientSecretRequired: false,
      clientSecretAccepted: false,
    };
    jest
      .spyOn(accountConnections, 'startAccountMcpConnection')
      .mockRejectedValueOnce(
        new AccountMcpConnectionError('oauth-client-required', undefined, {
          clientSetup,
        }),
      )
      .mockRejectedValueOnce(
        new AccountMcpConnectionError('connect-refused', undefined, {
          serverCode: 'untrusted_authorization_server',
        }),
      );
    const request = { serverKey: 'spotify', configId: 'default' };
    await expect(
      getHandler(MCP_SERVER_CHANNELS.START_ACCOUNT)({}, request),
    ).resolves.toEqual({
      error: { code: 'oauth-client-required', clientSetup },
    });
    await expect(
      getHandler(MCP_SERVER_CHANNELS.START_ACCOUNT)({}, request),
    ).resolves.toEqual({
      error: {
        code: 'connect-refused',
        serverCode: 'untrusted_authorization_server',
      },
    });
  });
  it('returns whether a device signs in with a refused account sign-in', async (): Promise<void> => {
    jest
      .spyOn(accountConnections, 'startAccountMcpConnection')
      .mockRejectedValueOnce(
        new AccountMcpConnectionError('connect-refused', undefined, {
          serverCode: 'sign_in_unavailable',
          desktopSignIn: true,
        }),
      )
      .mockRejectedValueOnce(
        new AccountMcpConnectionError('connect-refused', undefined, {
          serverCode: 'sign_in_unavailable',
          desktopSignIn: false,
        }),
      );
    const request = { serverKey: 'dropbox', configId: 'default' };
    for (const desktopSignIn of [true, false])
      await expect(
        getHandler(MCP_SERVER_CHANNELS.START_ACCOUNT)({}, request),
      ).resolves.toEqual({
        error: {
          code: 'connect-refused',
          serverCode: 'sign_in_unavailable',
          desktopSignIn,
        },
      });
  });
  it('forwards validated custom headers to the cloud client', async (): Promise<void> => {
    const start = jest
      .spyOn(accountConnections, 'startAccountMcpConnection')
      .mockResolvedValue({ authorizationUrl: 'https://auth.example.test' });
    await getHandler(MCP_SERVER_CHANNELS.START_ACCOUNT)(
      {},
      {
        customUrl: 'https://mcp.example.test/mcp',
        headers: { 'X-Api-Key': 'upstream-key', 'X-Team': 'core' },
        configId: 'default',
      },
    );
    expect(start).toHaveBeenCalledWith({
      customUrl: 'https://mcp.example.test/mcp',
      headers: { 'X-Api-Key': 'upstream-key', 'X-Team': 'core' },
      configId: 'default',
    });
    start.mockClear();
    await getHandler(MCP_SERVER_CHANNELS.START_ACCOUNT)(
      {},
      {
        customUrl: 'https://mcp.example.test/mcp',
        headers: {},
        configId: 'default',
      },
    );
    expect(start).toHaveBeenCalledWith({
      customUrl: 'https://mcp.example.test/mcp',
      configId: 'default',
    });
  });
  it('forwards a validated edit and returns cloud refusals as failures', async (): Promise<void> => {
    const id = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    const edited: accountConnections.AccountMcpConnection = {
      id,
      serverKey: 'custom:one',
      configId: 'default',
      displayName: 'Team tools',
      status: 'REAUTH_REQUIRED',
      kind: 'CUSTOM',
      routeId: 'route',
      enabledTools: null,
    };
    const update = jest
      .spyOn(accountConnections, 'updateAccountMcpConnection')
      .mockResolvedValueOnce(edited)
      .mockRejectedValueOnce(
        new AccountMcpConnectionError('invalid-headers', 'X-Team'),
      );
    await expect(
      getHandler(MCP_SERVER_CHANNELS.UPDATE_ACCOUNT)({}, id, {
        displayName: '  Team tools ',
        customUrl: 'https://mcp2.example.test/mcp',
        headers: {},
        bearerToken: null,
        expectedAccountId: 'acct-1',
      }),
    ).resolves.toEqual(edited);
    expect(update).toHaveBeenCalledWith(id, {
      displayName: 'Team tools',
      customUrl: 'https://mcp2.example.test/mcp',
      headers: {},
      bearerToken: null,
      expectedAccountId: 'acct-1',
    });
    await expect(
      getHandler(MCP_SERVER_CHANNELS.UPDATE_ACCOUNT)({}, id, {
        headers: { 'X-Team': 'core' },
      }),
    ).resolves.toEqual({
      error: { code: 'invalid-headers', header: 'X-Team' },
    });
  });
  it('accepts an enabled-only false edit and forwards it to the authorized account operation', async (): Promise<void> => {
    const id = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    const update = jest
      .spyOn(accountConnections, 'updateAccountMcpConnection')
      .mockRejectedValueOnce(new AccountMcpConnectionError('edit-unavailable'));
    await getHandler(MCP_SERVER_CHANNELS.UPDATE_ACCOUNT)({}, id, {
      enabled: false,
    });
    expect(update).toHaveBeenCalledWith(id, { enabled: false });
  });
  it.each([
    {},
    { displayName: ' ' },
    { customUrl: 'http://mcp.example.test/mcp' },
    { headers: { Authorization: 'Bearer x' } },
    { bearerToken: '' },
    { routeId: 'other' },
  ])('rejects an invalid edit before the cloud: %j', async (request) => {
    const update = jest.spyOn(accountConnections, 'updateAccountMcpConnection');
    await expect(
      getHandler(MCP_SERVER_CHANNELS.UPDATE_ACCOUNT)(
        {},
        'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
        request,
      ),
    ).rejects.toThrow();
    expect(update).not.toHaveBeenCalled();
  });
  it('removes a cloud connection', async (): Promise<void> => {
    const remove = jest
      .spyOn(accountConnections, 'removeAccountMcpConnection')
      .mockResolvedValue({ removed: true });
    await expect(
      getHandler(MCP_SERVER_CHANNELS.REMOVE_ACCOUNT)(
        {},
        'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
      ),
    ).resolves.toEqual({ removed: true });
    expect(remove).toHaveBeenCalledWith('aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee');
  });
  it('rewrites server refs through the shared helper', async (): Promise<void> => {
    const request = {
      from: [
        { serverId: 'custom:one', configId: 'default' },
        { serverId: 'account:aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' },
      ],
      to: { serverId: 'aaa-bbb-111', configId: 'cfg-a' },
    };
    await expect(
      getHandler(MCP_SERVER_CHANNELS.REWRITE_REFS)({}, request),
    ).resolves.toEqual({ globalDefaults: true, workspaces: 1, chats: 2 });
    expect(mockRewriteMcpServerRefs).toHaveBeenCalledWith(request);
    await expect(
      getHandler(MCP_SERVER_CHANNELS.REWRITE_REFS)(
        {},
        {
          from: [{ serverId: '../escape' }],
          to: { serverId: 'a', configId: 'b' },
        },
      ),
    ).rejects.toThrow();
    await expect(
      getHandler(MCP_SERVER_CHANNELS.REWRITE_REFS)(
        {},
        {
          from: [],
          to: { serverId: 'a', configId: 'b' },
        },
      ),
    ).rejects.toThrow();
  });
  it.each([
    ['an uppercase server id', { from: [{ serverId: 'Docs' }] }],
    ['a dotted server id', { from: [{ serverId: 'docs.v2' }] }],
    ['an empty custom ref', { from: [{ serverId: 'custom:' }] }],
    ['an uppercase custom ref', { from: [{ serverId: 'custom:ABC' }] }],
    ['a nested custom ref', { from: [{ serverId: 'custom:custom:abc' }] }],
    [
      'an uppercase legacy account ref',
      { from: [{ serverId: 'account:ABC' }] },
    ],
    ['an unknown ref prefix', { from: [{ serverId: 'device:abc' }] }],
    [
      'an underscored config id',
      { from: [{ serverId: 'docs', configId: 'work_1' }] },
    ],
    ['an underscored target id', { to: { serverId: 'a_b', configId: 'b' } }],
    ['a dotted target config id', { to: { serverId: 'a', configId: 'b.c' } }],
  ])(
    'rejects %s before rewriting any ref',
    async (_label, patch): Promise<void> => {
      await expect(
        getHandler(MCP_SERVER_CHANNELS.REWRITE_REFS)(
          {},
          {
            from: [{ serverId: 'custom:one', configId: 'default' }],
            to: { serverId: 'aaa-bbb-111', configId: 'cfg-a' },
            ...patch,
          },
        ),
      ).rejects.toThrow('Invalid');
      expect(mockRewriteMcpServerRefs).not.toHaveBeenCalled();
    },
  );
  it('rethrows the original local rewrite failure without invoking the writer twice', async () => {
    const error = new Error('original rewrite failure');
    mockRewriteMcpServerRefs.mockRejectedValueOnce(error);
    await expect(
      getHandler(MCP_SERVER_CHANNELS.REWRITE_REFS)(
        {},
        {
          from: [{ serverId: 'aaa' }],
          to: { serverId: 'bbb', configId: 'cfg' },
        },
      ),
    ).rejects.toBe(error);
    expect(mockRewriteMcpServerRefs).toHaveBeenCalledTimes(1);
    expect(error).not.toHaveProperty('details');
  });

  it('keeps a successful legacy result even when internal result validation fails', async () => {
    const value = { globalDefaults: false, workspaces: 0, chats: -1 };
    mockRewriteMcpServerRefs.mockResolvedValueOnce(value);
    await expect(
      getHandler(MCP_SERVER_CHANNELS.REWRITE_REFS)(
        {},
        {
          from: [{ serverId: 'aaa' }],
          to: { serverId: 'bbb', configId: 'cfg' },
        },
      ),
    ).resolves.toBe(value);
    expect(mockRewriteMcpServerRefs).toHaveBeenCalledTimes(1);
  });

  it('does not misclassify an unexpected parser failure as invalid input', async () => {
    const error = new Error('unexpected getter');
    const input = {
      get from(): never {
        throw error;
      },
    };
    expect(await rewriteMcpServerRefsOutcome(input)).toMatchObject({
      ok: false,
      legacyError: error,
      error: { kind: 'internal' },
    });
    expect(mockRewriteMcpServerRefs).not.toHaveBeenCalled();
  });

  it.each([
    [{ from: [], to: { serverId: 'a', configId: 'b' } }, 'invalidRef'],
    [
      {
        from: [{ serverId: 'aaa' }],
        to: { serverId: 'bbb', configId: 'b' },
        retire: { serverId: 'ccc', fingerprint: 'x' },
      },
      'retireNotRewritten',
    ],
  ])('represents invalid input without effects', async (request, code) => {
    expect(await rewriteMcpServerRefsOutcome(request)).toMatchObject({
      ok: false,
      error: {
        kind: 'invalid_argument',
        code: `core.catalog.mcpServer.${code}`,
        details: { phase: 'validation', effects: 'none' },
        retry: { kind: 'never' },
      },
    });
    expect(mockRewriteMcpServerRefs).not.toHaveBeenCalled();
  });

  describe('retiring the device server the refs moved off (REG-3052)', () => {
    const deviceId = 'aaa-bbb-111';
    const request = {
      from: [{ serverId: deviceId, configId: 'cfg-a' }],
      to: { serverId: 'linear', configId: 'default' },
    };
    let onDisk: McpServerData;

    beforeEach((): void => {
      onDisk = makeServer({
        definition: {
          id: deviceId,
          type: 'http',
          url: 'https://x.test',
          httpAuthHandler: 'canopy',
        },
        configs: [makeConfig({ id: 'cfg-a' })],
      });
      mockedMkdir.mockResolvedValue(undefined);
      mockedWriteFile.mockResolvedValue(undefined);
      mockedUnlink.mockResolvedValue(undefined);
      mockedReadFile.mockImplementation(
        (path): Promise<string> =>
          path === MOCK_INDEX_PATH
            ? Promise.resolve(makeIndexFileJson([]))
            : path === mockServerPath(deviceId)
              ? Promise.resolve(makeServerFileJson(onDisk))
              : missingFile(),
      );
    });

    async function fingerprint(): Promise<string> {
      const file = (await getHandler(MCP_SERVER_CHANNELS.LOAD_SERVER)(
        {},
        deviceId,
      )) as McpServerFile;
      return stableStringify(file.server);
    }

    it('moves the refs, then removes the unchanged server', async (): Promise<void> => {
      const expected = await fingerprint();
      await expect(
        getHandler(MCP_SERVER_CHANNELS.REWRITE_REFS)(
          {},
          { ...request, retire: { serverId: deviceId, fingerprint: expected } },
        ),
      ).resolves.toEqual({
        globalDefaults: true,
        workspaces: 1,
        chats: 2,
        retired: 'removed',
      });
      expect(mockRewriteMcpServerRefs).toHaveBeenCalledWith(request);
      expect(mockedUnlink).toHaveBeenCalledWith(
        `/mock/mcp-servers/server-${deviceId}.json`,
      );
      expect(mockRewriteMcpServerRefs.mock.invocationCallOrder[0]).toBeLessThan(
        mockedUnlink.mock.invocationCallOrder[0],
      );
    });

    it('preserves rewritten counters when the second retirement guard declines removal', async () => {
      const expected = await fingerprint();
      mockRewriteMcpServerRefs.mockImplementationOnce(() => {
        onDisk = {
          ...onDisk,
          configs: [...onDisk.configs, makeConfig({ id: 'cfg-b' })],
        };
        return Promise.resolve({
          globalDefaults: true,
          workspaces: 1,
          chats: 2,
        });
      });
      expect(
        await rewriteMcpServerRefsOutcome({
          ...request,
          retire: { serverId: deviceId, fingerprint: expected },
        }),
      ).toEqual({
        ok: true,
        value: {
          globalDefaults: true,
          workspaces: 1,
          chats: 2,
          retired: 'changed',
        },
      });
      expect(mockedUnlink).not.toHaveBeenCalled();
    });

    it('keeps the existing successful deletion outcome when unlink reports ENOENT', async () => {
      const expected = await fingerprint();
      mockedUnlink.mockRejectedValueOnce(
        Object.assign(new Error('already absent'), { code: 'ENOENT' }),
      );
      expect(
        await rewriteMcpServerRefsOutcome({
          ...request,
          retire: { serverId: deviceId, fingerprint: expected },
        }),
      ).toMatchObject({
        ok: true,
        value: { retired: 'removed' },
      });
    });

    it('keeps same-target retirement: zero rewrite counters still allow deletion', async () => {
      const expected = await fingerprint();
      mockRewriteMcpServerRefs.mockResolvedValueOnce({
        globalDefaults: false,
        workspaces: 0,
        chats: 0,
      });
      const sameTarget = {
        from: request.from,
        to: request.from[0],
        retire: { serverId: deviceId, fingerprint: expected },
      };
      await expect(rewriteMcpServerRefsOutcome(sameTarget)).resolves.toEqual({
        ok: true,
        value: {
          globalDefaults: false,
          workspaces: 0,
          chats: 0,
          retired: 'removed',
        },
      });
      expect(mockRewriteMcpServerRefs).toHaveBeenCalledTimes(1);
      expect(mockedUnlink).toHaveBeenCalledTimes(1);
    });

    it('keeps deletion-read fallback and classifies an unexpected malformed index as internal', async () => {
      const expected = await fingerprint();
      let serverReads = 0;
      mockedReadFile.mockImplementation((path): Promise<string> => {
        if (path === `/mock/mcp-servers/server-${deviceId}.json`) {
          serverReads += 1;
          return serverReads === 3
            ? Promise.reject(
                Object.assign(new Error('unreadable server'), { code: 'EIO' }),
              )
            : Promise.resolve(makeServerFileJson(onDisk));
        }
        return Promise.resolve(
          JSON.stringify({ version: 1, servers: [{ id: deviceId }] }),
        );
      });
      const outcome = await rewriteMcpServerRefsOutcome({
        ...request,
        retire: { serverId: deviceId, fingerprint: expected },
      });
      expect(outcome).toMatchObject({
        ok: false,
        error: {
          kind: 'internal',
          details: { phase: 'retirementRead', effects: 'unknown' },
        },
      });
      expect(mockRewriteMcpServerRefs).toHaveBeenCalledTimes(1);
      expect(clearMcpOAuthToken).not.toHaveBeenCalled();
      expect(mockedUnlink).not.toHaveBeenCalled();
    });

    it.each(['tokenClear', 'serverUnlink', 'indexUpdate'])(
      'classifies %s failure without replaying the rewrite',
      async (phase) => {
        const expected = await fingerprint();
        const error = Object.assign(new Error('private disk path'), {
          code: 'EIO',
        });
        if (phase === 'tokenClear')
          jest.mocked(clearMcpOAuthToken).mockRejectedValueOnce(error);
        if (phase === 'serverUnlink') mockedUnlink.mockRejectedValueOnce(error);
        if (phase === 'indexUpdate')
          mockedWriteFile.mockRejectedValueOnce(error);
        const outcome = await rewriteMcpServerRefsOutcome({
          ...request,
          retire: { serverId: deviceId, fingerprint: expected },
        });
        expect(outcome).toMatchObject({
          ok: false,
          legacyError: error,
          error: {
            kind: 'unavailable',
            code: 'core.catalog.mcpServer.retirementFailed',
            details: { phase, effects: 'unknown' },
            retry: { kind: 'never' },
          },
        });
        expect(JSON.stringify(outcome.ok ? null : outcome.error)).not.toContain(
          'private disk path',
        );
        expect(mockRewriteMcpServerRefs).toHaveBeenCalledTimes(1);
        expect(mockedUnlink).toHaveBeenCalledTimes(
          phase === 'tokenClear' ? 0 : 1,
        );
      },
    );

    it('classifies an unlink failure queued behind another server save', async () => {
      const expected = await fingerprint();
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      mockedWriteFile.mockImplementation(async (path) => {
        if (typeof path === 'string' && path.endsWith('server-bbb-222.json')) {
          entered.resolve();
          await release.promise;
        }
      });
      mockedUnlink.mockRejectedValueOnce(
        Object.assign(new Error('disk'), { code: 'EIO' }),
      );
      const otherSave = saveMcpServer(
        makeServer({ definition: { id: 'bbb-222' } }),
      );
      await entered.promise;
      const outcome = rewriteMcpServerRefsOutcome({
        ...request,
        retire: { serverId: deviceId, fingerprint: expected },
      });
      try {
        for (
          let i = 0;
          i < 20 && !jest.mocked(clearMcpOAuthToken).mock.calls.length;
          i += 1
        )
          await new Promise<void>((resolve) => setImmediate(resolve));
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(clearMcpOAuthToken).toHaveBeenCalled();
        expect(mockedUnlink).not.toHaveBeenCalled();
      } finally {
        release.resolve();
      }
      await otherSave;
      expect(await outcome).toMatchObject({
        ok: false,
        error: {
          code: 'core.catalog.mcpServer.retirementFailed',
          details: { phase: 'serverUnlink' },
        },
      });
    });

    // CAN-4486 A1: the lease stays held until every initiated clear settles.
    it('returns a rejected token clear only after another initiated clear settles', async () => {
      onDisk.configs.push(makeConfig({ id: 'cfg-b' }));
      const expected = await fingerprint();
      const started = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      jest
        .mocked(clearMcpOAuthToken)
        .mockRejectedValueOnce(
          Object.assign(new Error('disk'), { code: 'EIO' }),
        )
        .mockImplementationOnce(async () => {
          started.resolve();
          await release.promise;
        });
      let returned = false;
      const outcome = rewriteMcpServerRefsOutcome({
        ...request,
        retire: { serverId: deviceId, fingerprint: expected },
      }).finally(() => {
        returned = true;
      });
      try {
        await started.promise;
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(returned).toBe(false);
      } finally {
        release.resolve();
      }
      expect(await outcome).toMatchObject({
        ok: false,
        error: { details: { phase: 'tokenClear', effects: 'unknown' } },
      });
      expect(mockedUnlink).not.toHaveBeenCalled();
    });

    it('moves nothing and keeps the server when its file changed', async (): Promise<void> => {
      const expected = await fingerprint();
      onDisk = {
        ...onDisk,
        configs: [...onDisk.configs, makeConfig({ id: 'cfg-b' })],
      };
      await expect(
        getHandler(MCP_SERVER_CHANNELS.REWRITE_REFS)(
          {},
          { ...request, retire: { serverId: deviceId, fingerprint: expected } },
        ),
      ).resolves.toEqual({
        globalDefaults: false,
        workspaces: 0,
        chats: 0,
        retired: 'changed',
      });
      expect(mockRewriteMcpServerRefs).not.toHaveBeenCalled();
      expect(mockedUnlink).not.toHaveBeenCalled();
    });

    it('holds a save to that server until the move finishes', async (): Promise<void> => {
      const expected = await fingerprint();
      let finishRewrite: (() => void) | undefined;
      mockRewriteMcpServerRefs.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishRewrite = (): void =>
              resolve({ globalDefaults: false, workspaces: 1, chats: 0 });
          }),
      );
      const move = getHandler(MCP_SERVER_CHANNELS.REWRITE_REFS)(
        {},
        { ...request, retire: { serverId: deviceId, fingerprint: expected } },
      );
      for (let i = 0; i < 50 && !finishRewrite; i += 1)
        await new Promise((resolve) => setImmediate(resolve));
      expect(finishRewrite).toBeDefined();
      const save = getHandler(MCP_SERVER_CHANNELS.SAVE_SERVER)(
        {},
        {
          definition: onDisk.definition,
          configs: [...onDisk.configs, makeConfig({ id: 'cfg-b' })],
        },
      );
      await Promise.resolve();
      const serverWrites = (): number =>
        mockedWriteFile.mock.calls.filter(
          ([path]) =>
            typeof path === 'string' && path.includes(`server-${deviceId}`),
        ).length;
      expect(serverWrites()).toBe(0);
      finishRewrite?.();
      await move;
      await save;
      expect(mockedUnlink.mock.invocationCallOrder[0]).toBeLessThan(
        mockedWriteFile.mock.invocationCallOrder[
          mockedWriteFile.mock.calls.findIndex(
            ([path]) =>
              typeof path === 'string' && path.includes(`server-${deviceId}`),
          )
        ],
      );
    });

    it('holds a direct save, as the Portal makes, until the move finishes', async (): Promise<void> => {
      const expected = await fingerprint();
      let finishRewrite: (() => void) | undefined;
      mockRewriteMcpServerRefs.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishRewrite = (): void =>
              resolve({ globalDefaults: false, workspaces: 1, chats: 0 });
          }),
      );
      const move = getHandler(MCP_SERVER_CHANNELS.REWRITE_REFS)(
        {},
        { ...request, retire: { serverId: deviceId, fingerprint: expected } },
      );
      for (let i = 0; i < 50 && !finishRewrite; i += 1)
        await new Promise((resolve) => setImmediate(resolve));
      expect(finishRewrite).toBeDefined();
      const save = saveMcpServer({
        definition: onDisk.definition,
        configs: [...onDisk.configs, makeConfig({ id: 'cfg-b' })],
      });
      await Promise.resolve();
      const serverWrites = (): number =>
        mockedWriteFile.mock.calls.filter(
          ([path]) =>
            typeof path === 'string' && path.includes(`server-${deviceId}`),
        ).length;
      expect(serverWrites()).toBe(0);
      finishRewrite?.();
      await move;
      await save;
      expect(mockedUnlink).toHaveBeenCalledTimes(1);
      expect(serverWrites()).toBe(1);
      expect(mockedUnlink.mock.invocationCallOrder[0]).toBeLessThan(
        mockedWriteFile.mock.invocationCallOrder[
          mockedWriteFile.mock.calls.findIndex(
            ([path]) =>
              typeof path === 'string' && path.includes(`server-${deviceId}`),
          )
        ],
      );
    });

    it('keeps a server whose sign-in handler is not the app own one', async (): Promise<void> => {
      onDisk = {
        ...onDisk,
        definition: { ...onDisk.definition, httpAuthHandler: undefined },
      };
      jest.mocked(readPreferencesFile).mockResolvedValue(
        partialPreferences({
          mcpProxyPort: 37645,
          mcpHttpAuthDefaultHandler: 'provider',
        }),
      );
      try {
        const expected = await fingerprint();
        await expect(
          getHandler(MCP_SERVER_CHANNELS.REWRITE_REFS)(
            {},
            {
              ...request,
              retire: { serverId: deviceId, fingerprint: expected },
            },
          ),
        ).resolves.toMatchObject({ retired: 'changed' });
        expect(mockRewriteMcpServerRefs).not.toHaveBeenCalled();
        expect(mockedUnlink).not.toHaveBeenCalled();
      } finally {
        jest
          .mocked(readPreferencesFile)
          .mockResolvedValue(partialPreferences({ mcpProxyPort: 37645 }));
      }
    });

    it('rejects retiring a server the refs are not moving off', async (): Promise<void> => {
      await expect(
        getHandler(MCP_SERVER_CHANNELS.REWRITE_REFS)(
          {},
          { ...request, retire: { serverId: 'ccc-ddd-222', fingerprint: 'x' } },
        ),
      ).rejects.toThrow('one of the rewritten refs');
      expect(mockRewriteMcpServerRefs).not.toHaveBeenCalled();
    });
  });
  it.each([
    MCP_SERVER_CHANNELS.GET_ACCOUNT,
    MCP_SERVER_CHANNELS.UPDATE_ACCOUNT,
    MCP_SERVER_CHANNELS.REMOVE_ACCOUNT,
    MCP_SERVER_CHANNELS.DISCONNECT_ACCOUNT,
    MCP_SERVER_CHANNELS.SET_ACCOUNT_TOOLS,
    MCP_SERVER_CHANNELS.LIST_ACCOUNT_UPSTREAM_TOOLS,
    MCP_SERVER_CHANNELS.AWAIT_ACCOUNT,
  ])('validates the id on %s', async (channel): Promise<void> => {
    await expect(getHandler(channel)({}, '../invalid', null)).rejects.toThrow();
  });
  it('validates tools and bounded wait options', async (): Promise<void> => {
    const id = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    await expect(
      getHandler(MCP_SERVER_CHANNELS.SET_ACCOUNT_TOOLS)({}, id, [42]),
    ).rejects.toThrow();
    await expect(
      getHandler(MCP_SERVER_CHANNELS.AWAIT_ACCOUNT)({}, id, { timeoutMs: -1 }),
    ).rejects.toThrow();
  });
  it('enforces the main-process feature gate', async (): Promise<void> => {
    jest.spyOn(getFeatureFlagService(), 'isEnabled').mockReturnValue(false);
    await expect(
      getHandler(MCP_SERVER_CHANNELS.LIST_ACCOUNT_UPSTREAM_TOOLS)(
        {},
        'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
      ),
    ).rejects.toThrow('unavailable');
    await expect(
      getHandler(MCP_SERVER_CHANNELS.START_ACCOUNT)(
        {},
        { serverKey: 'github', configId: 'default' },
      ),
    ).rejects.toThrow('unavailable');
  });
});

describe('account tool discovery', (): void => {
  afterEach((): void => {
    jest.restoreAllMocks();
  });
  it.each([
    [false, 'legacy connection id'],
    [true, 'legacy connection id'],
    [false, 'server key'],
  ] as const)(
    'uses and disposes a temporary cloud route (failure: %s, %s)',
    async (fail, shape): Promise<void> => {
      jest.spyOn(getFeatureFlagService(), 'isEnabled').mockReturnValue(true);
      const id = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
      const connection: accountConnections.AccountMcpConnection = {
        id,
        serverKey: 'github',
        configId: 'work.config',
        displayName: 'GitHub',
        status: 'CONNECTED',
        kind: 'CURATED',
        routeId: 'web-route',
        enabledTools: null,
      };
      jest
        .spyOn(accountConnections, 'getAccountMcpConnection')
        .mockResolvedValue(connection);
      jest
        .spyOn(accountConnections, 'listAccountMcpConnections')
        .mockResolvedValue([connection]);
      const resolve = jest
        .spyOn(accountConnections, 'resolveAccountMcpProxyTarget')
        .mockResolvedValue({
          connection,
          upstreamUrl: 'https://cloud.example.test/api/v1/mcp-proxy/web-route',
        });
      const discover = jest.spyOn(toolDiscovery, 'discoverHttpTools');
      if (fail) discover.mockRejectedValue(new Error('Discovery failed'));
      else discover.mockResolvedValue(['search_issues']);
      mockedReadFile.mockClear();
      if (shape === 'server key')
        mockedReadFile.mockRejectedValueOnce(
          Object.assign(new Error('missing'), { code: 'ENOENT' }),
        );
      const result =
        shape === 'server key'
          ? getHandler(MCP_SERVER_CHANNELS.GET_TOOLS)(
              {},
              'github',
              'work.config',
            )
          : getHandler(MCP_SERVER_CHANNELS.GET_TOOLS)({}, `account:${id}`);
      const discoveredAt: unknown = expect.any(String);
      if (fail) await expect(result).rejects.toThrow('Discovery failed');
      else
        await expect(result).resolves.toEqual({
          tools: ['search_issues'],
          discoveredAt,
        });
      expect(resolve).toHaveBeenCalledWith(
        expect.objectContaining({
          accountConnectionId: id,
          configId: 'work.config',
        }),
      );
      expect(mockProxyRegisterRoute).toHaveBeenCalledWith(
        expect.objectContaining({
          authSupplier: 'canopy-cloud',
          upstreamUrl: 'https://cloud.example.test/api/v1/mcp-proxy/web-route',
        }),
      );
      expect(discover).toHaveBeenCalledWith(
        expect.objectContaining({ url: 'http://127.0.0.1:37645/mcp/route-id' }),
      );
      expect(mockProxyUnregisterRoute).toHaveBeenCalledWith('route-id');
      if (shape === 'server key')
        expect(mockProxyRegisterRoute).toHaveBeenCalledWith(
          expect.objectContaining({ serverId: 'github' }),
        );
      else expect(mockedReadFile).not.toHaveBeenCalled();
    },
  );
});

it.each(['connection-timeout', 'account-changed'] as const)(
  'serializes the %s code for Electron',
  async (code): Promise<void> => {
    jest.spyOn(getFeatureFlagService(), 'isEnabled').mockReturnValue(true);
    jest
      .spyOn(accountConnections, 'awaitAccountMcpConnection')
      .mockRejectedValueOnce(new AccountMcpConnectionError(code));
    try {
      await expect(
        getHandler(MCP_SERVER_CHANNELS.AWAIT_ACCOUNT)(
          {},
          'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
        ),
      ).resolves.toEqual({ error: { code } });
    } finally {
      jest.restoreAllMocks();
    }
  },
);
