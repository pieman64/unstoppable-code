import { createServer, type Server } from 'node:http';
import type * as CloudClientModule from '../canopy-cloud/client';
import type * as ProxyServiceModule from '../mcp/http-proxy-service';
import { emptyCursorCapabilityProjection } from '@canopy/desktop-shared/lib/cursor-capabilities';
import { resolveCanopyCloudCredentialContext } from '../canopy-cloud/client';
import { getValidMcpAccessToken } from '../mcp/oauth-client';
import type { McpHttpProxyService } from '../mcp/http-proxy-service';
import { materializeSelectedCapabilityRoot } from '@canopy/desktop-shared/node/cursor/capability-root';
import type { OpenCodePromptRunnerRequest } from '@canopy/desktop-shared/node/pipelines/executor/types';
import type { ApprovalSessionHandle } from '../approvals/approval-service';
import type { McpProxiedToolCallGate } from '../mcp/http-proxy-service';
import {
  resolvePlugins,
  type McpHttpProxyServiceForResolver,
  type ResolvedMcpServerBinding,
} from '../plugins/plugin-resolver';
import { snapshotOpenCodeMcpTools } from '../opencode/capability-snapshot';
import { validateOpenCodeMcpSchema } from '../opencode/schema-validation';
import { prepareOpenCodePipelineCapabilities } from '../pipelines/opencode-pipeline-capabilities';

jest.mock('@canopy/desktop-shared/node/cursor/capability-root', () => ({
  materializeSelectedCapabilityRoot: jest.fn(),
}));
jest.mock('../plugins/plugin-resolver', () => ({ resolvePlugins: jest.fn() }));
jest.mock('../opencode/capability-snapshot', () => ({
  snapshotOpenCodeMcpTools: jest.fn(),
}));
jest.mock('../opencode/schema-validation', () => ({
  validateOpenCodeMcpSchema: jest.fn(),
}));
jest.mock('../canopy-cloud/client', () => ({
  ...jest.requireActual<typeof CloudClientModule>('../canopy-cloud/client'),
  resolveCanopyCloudCredentialContext: jest.fn(),
}));
jest.mock('../mcp/oauth-client', () => ({
  getValidMcpAccessToken: jest.fn(),
}));
let mockLiveProxy: McpHttpProxyService | undefined;
const mockSetGate = jest.fn<void, [string, McpProxiedToolCallGate]>();
const mockUnregister = jest.fn<void, [string]>();
const mockRegisterRoute = jest.fn<
  ReturnType<McpHttpProxyServiceForResolver['registerRoute']>,
  Parameters<McpHttpProxyServiceForResolver['registerRoute']>
>();
const mockGetProxyUrl = jest.fn((id: string) => `http://localhost/${id}`);
const mockUnregisterRoute = jest.fn();
const mockEnsureStarted = jest.fn();
jest.mock('../mcp/http-proxy-service', () => ({
  getMcpHttpProxyService: ():
    | McpHttpProxyService
    | {
        setSessionToolCallGate: typeof mockSetGate;
        unregisterRoutesForSession: typeof mockUnregister;
        registerRoute: typeof mockRegisterRoute;
        getProxyUrl: typeof mockGetProxyUrl;
        unregisterRoute: typeof mockUnregisterRoute;
        ensureStarted: typeof mockEnsureStarted;
      } =>
    mockLiveProxy ?? {
      setSessionToolCallGate: mockSetGate,
      unregisterRoutesForSession: mockUnregister,
      registerRoute: mockRegisterRoute,
      getProxyUrl: mockGetProxyUrl,
      unregisterRoute: mockUnregisterRoute,
      ensureStarted: mockEnsureStarted,
    },
}));

const check = jest.fn<
  ReturnType<ApprovalSessionHandle['check']>,
  Parameters<ApprovalSessionHandle['check']>
>();
const approval: ApprovalSessionHandle = {
  check,
  dispose: jest.fn(),
  reevaluatePendingApprovals: jest.fn<
    ReturnType<ApprovalSessionHandle['reevaluatePendingApprovals']>,
    Parameters<ApprovalSessionHandle['reevaluatePendingApprovals']>
  >(() => Promise.resolve()),
  setMode: jest.fn(),
};
const request: OpenCodePromptRunnerRequest = {
  cwd: '/workspace',
  projectId: 'project',
  executionId: 'execution',
  jobId: 'job',
  stepId: 'step',
  attempt: 1,
  executionsDir: '/executions',
  model: 'opencode:fixture%2Fmodel',
  prompt: 'do it',
  environment: {},
  permissionPreset: 'dangerous_all',
  totalTimeoutMs: 1000,
  pluginSelections: {
    collectionIds: ['selected'],
    pluginRefs: [],
    skillRefs: [],
  },
};
const toolCall = {
  proxyUrl: 'http://localhost/selected',
  tool: 'files.read',
  args: { file: 'README.md' },
};
const nativeCall = {
  sessionId: 'session',
  toolCallId: 'call',
  toolName: 'selected_files_read',
  toolArgs: toolCall.args,
};
const resolution = (): Awaited<ReturnType<typeof resolvePlugins>> => ({
  sdkPlugins: [],
  skillPluginDir: null,
  selectedCapabilityRoots: [],
  codexMcpServers: {},
  mcpServers: { selected: { type: 'http', url: toolCall.proxyUrl } },
  mcpServerBindings: {},
  warnings: [],
  cursorNotices: [],
  cursorCapabilities: emptyCursorCapabilityProjection(),
});

// Load the real proxy during suite setup. A cold TypeScript transform inside
// the first async test can exhaust its deadline and overlap the next test.
const { McpHttpProxyService: ProxyService } = jest.requireActual<
  typeof ProxyServiceModule
>('../mcp/http-proxy-service');

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string')
        reject(new Error('No listening port'));
      else resolve(address.port);
    });
  });
}
function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}

test.each(['account', 'oauth'] as const)(
  'cancellation during %s credential loading never forwards a pipeline call',
  async (auth) => {
    const upstreamBodies: string[] = [];
    const upstream = createServer((req, res) => {
      let body = '';
      req.setEncoding('utf8');
      req.on('data', (chunk: string) => {
        body += chunk;
      });
      req.on('end', () => {
        upstreamBodies.push(body);
        res.end('{}');
      });
    });
    const upstreamPort = await listen(upstream);
    const baseUrl = `http://127.0.0.1:${upstreamPort}`;
    const service = new ProxyService();
    const reservation = createServer();
    const proxyPort = await listen(reservation);
    await close(reservation);
    const controller = new AbortController();
    let releaseCredentials: (() => void) | undefined;
    let credentialsStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      credentialsStarted = resolve;
    });
    jest.mocked(resolveCanopyCloudCredentialContext).mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseCredentials = (): void =>
            resolve({ baseUrl, apiKey: 'synthetic-key' });
          credentialsStarted?.();
        }),
    );
    jest.mocked(getValidMcpAccessToken).mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseCredentials = (): void => resolve('synthetic-oauth-token');
          credentialsStarted?.();
        }),
    );
    let proxyUrl = '';
    try {
      await service.ensureStarted(proxyPort);
      mockLiveProxy = service;
      jest
        .mocked(resolvePlugins)
        .mockImplementation(
          async (_selection, _project, _execution, sessionId, options) => {
            const proxy = options?.mcpHttpProxyService;
            if (!proxy) throw new Error('Missing resolver proxy');
            const id = await proxy.registerRoute({
              sessionId,
              serverId: 'account',
              configId: 'default',
              displayName: 'Account',
              upstreamUrl: `${baseUrl}/api/v1/mcp-proxy/test`,
              headers: {},
              oauthEnabled: auth === 'oauth',
              authSupplier: auth === 'account' ? 'canopy-cloud' : 'oauth',
              oauthDefinition: {
                id: 'account',
                name: 'Account',
                description: '',
                type: 'http',
                url: baseUrl,
                oauth: {},
                createdAt: '2026-10-12T00:00:00.000Z',
                updatedAt: '2026-10-12T00:00:00.000Z',
              },
              oauthConfig: {
                id: 'default',
                name: 'Default',
                description: '',
                enabled: true,
                envVars: {},
                extraArgs: [],
                extraHeaders: {},
                createdAt: '2026-10-12T00:00:00.000Z',
                updatedAt: '2026-10-12T00:00:00.000Z',
              },
            });
            proxyUrl = proxy.getProxyUrl(id);
            return {
              ...resolution(),
              mcpServers: { selected: { type: 'http', url: proxyUrl } },
            };
          },
        );
      const capabilities = await prepare(controller.signal);
      const pending = fetch(proxyUrl, {
        method: 'POST',
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: toolCall.tool, arguments: toolCall.args },
        }),
        signal: AbortSignal.timeout(3000),
      });
      await Promise.race([
        started,
        pending.then(async (response) => {
          throw new Error(
            `Request finished before credentials: ${response.status} ${await response.clone().text()}`,
          );
        }),
      ]);
      expect(check).toHaveBeenCalledTimes(auth === 'account' ? 1 : 0);
      controller.abort();
      releaseCredentials?.();
      const response = await pending;
      const body: unknown = await response.json();
      expect(upstreamBodies).toEqual([]);
      expect(JSON.stringify(body)).toContain('unavailable');
      await capabilities.dispose();
    } finally {
      releaseCredentials?.();
      controller.abort();
      mockLiveProxy = undefined;
      await service.shutdown();
      await close(upstream);
    }
  },
);
beforeEach(() => {
  jest.resetAllMocks();
  mockLiveProxy = undefined;
  mockRegisterRoute.mockImplementation(() =>
    Promise.resolve(`route-${mockRegisterRoute.mock.calls.length}`),
  );
  mockGetProxyUrl.mockImplementation((id) => `http://localhost/${id}`);
  check.mockResolvedValue({ decision: 'allow' });
  jest.mocked(resolvePlugins).mockResolvedValue(resolution());
  jest.mocked(materializeSelectedCapabilityRoot).mockResolvedValue({
    fingerprint: 'fixture-fingerprint',
    skillIds: [],
    commandIds: [],
    warnings: [],
  });
  jest.mocked(snapshotOpenCodeMcpTools).mockResolvedValue([
    {
      name: 'selected',
      identity: 'fixture',
      tools: [
        {
          name: toolCall.tool,
          inputSchema: {
            type: 'object',
            required: ['file'],
            properties: { file: { type: 'string' } },
          },
        },
      ],
    },
  ]);
  jest.mocked(validateOpenCodeMcpSchema).mockResolvedValue(true);
});
function gate(): McpProxiedToolCallGate {
  const entry = mockSetGate.mock.calls.at(-1);
  if (!entry) throw new Error('Missing proxy gate');
  return entry[1];
}
function prepare(
  signal = new AbortController().signal,
  currentApproval = (): ApprovalSessionHandle => approval,
  permissionPreset = request.permissionPreset,
): ReturnType<typeof prepareOpenCodePipelineCapabilities> {
  return prepareOpenCodePipelineCapabilities(
    { ...request, permissionPreset },
    '/profile',
    signal,
    currentApproval,
  );
}
test.each(['allow', 'deny'] as const)(
  'native and HTTP MCP checks honor shared policy %s',
  async (decision) => {
    check.mockResolvedValue({ decision });
    const capabilities = await prepare();
    expect(await capabilities.authorizeMcpTool?.(nativeCall)).toEqual({
      decision,
    });
    expect(await gate()(toolCall)).toBe(decision === 'allow');
    expect(check).toHaveBeenCalledTimes(2);
    expect(check).toHaveBeenCalledWith(
      { kind: 'mcp', server: 'selected', tool: 'files.read' },
      expect.anything(),
    );
    expect(validateOpenCodeMcpSchema).toHaveBeenCalledWith(
      expect.objectContaining({ required: ['file'] }),
      toolCall.args,
      expect.any(AbortSignal),
    );
    await capabilities.dispose();
    expect(await gate()(toolCall)).toBe(false);
    expect(mockUnregister).toHaveBeenCalledWith(mockSetGate.mock.calls[0][0]);
  },
);
test.each(['none', 'read_only', 'plan'] as const)(
  '%s never executes selected MCP calls',
  async (preset) => {
    const capabilities = await prepare(undefined, undefined, preset);
    expect(await capabilities.authorizeMcpTool?.(nativeCall)).toEqual({
      decision: 'deny',
    });
    expect(await gate()(toolCall)).toBe(false);
    expect(check).not.toHaveBeenCalled();
    await capabilities.dispose();
  },
);
test('unlisted routes, aliases and malformed arguments never reach shared policy', async () => {
  const capabilities = await prepare();
  expect(
    await gate()({ ...toolCall, proxyUrl: 'http://localhost/unselected' }),
  ).toBe(false);
  expect(await gate()({ ...toolCall, tool: 'files_read' })).toBe(false);
  expect(
    await capabilities.authorizeMcpTool?.({
      ...nativeCall,
      toolName: 'unselected_read',
    }),
  ).toEqual({ decision: 'deny' });
  jest.mocked(validateOpenCodeMcpSchema).mockResolvedValue(false);
  expect(await gate()({ ...toolCall, args: { file: 1 } })).toBe(false);
  expect(check).not.toHaveBeenCalled();
  await capabilities.dispose();
});
test('ambiguous native keys cannot choose an MCP identity', async () => {
  jest.mocked(snapshotOpenCodeMcpTools).mockResolvedValue([
    {
      name: 'selected',
      identity: 'fixture',
      tools: [
        { name: 'files.read', inputSchema: { type: 'object' } },
        { name: 'files_read', inputSchema: { type: 'object' } },
      ],
    },
  ]);
  const capabilities = await prepare();
  expect(await capabilities.authorizeMcpTool?.(nativeCall)).toEqual({
    decision: 'deny',
  });
  expect(await gate()(toolCall)).toBe(false);
  expect(check).not.toHaveBeenCalled();
  await capabilities.dispose();
});
test.each(['cancel', 'replace'] as const)(
  'a pending policy grant is withdrawn on %s',
  async (action) => {
    const controller = new AbortController();
    let current = approval;
    const capabilities = await prepare(controller.signal, () => current);
    check.mockImplementation(() => {
      if (action === 'cancel') controller.abort();
      else current = { ...approval };
      return Promise.resolve({ decision: 'allow' });
    });
    expect(await gate()(toolCall)).toBe(false);
    await capabilities.dispose();
  },
);
test('discovery cannot execute tools and failure revokes every registered route', async () => {
  jest.mocked(snapshotOpenCodeMcpTools).mockImplementation(async () => {
    expect(await gate()(toolCall)).toBe(false);
    throw new Error('discovery failed');
  });
  await expect(prepare()).rejects.toThrow('discovery failed');
  expect(mockUnregister).toHaveBeenCalledTimes(1);
});
test('resolution finishing after cancellation revokes late routes', async () => {
  const controller = new AbortController();
  jest.mocked(resolvePlugins).mockImplementation(() => {
    controller.abort();
    return Promise.resolve(resolution());
  });
  await expect(prepare(controller.signal)).rejects.toThrow();
  expect(mockUnregister).toHaveBeenCalledTimes(2);
  expect(snapshotOpenCodeMcpTools).not.toHaveBeenCalled();
});

function resolvePluginRoute(
  upstreamUrl = 'https://plugin.example/mcp',
  binding?: ResolvedMcpServerBinding,
  headers: Record<string, string> = {},
): void {
  jest
    .mocked(resolvePlugins)
    .mockImplementation(
      async (_selection, _project, _execution, sessionId, options) => {
        const proxy = options?.mcpHttpProxyService;
        if (!proxy) throw new Error('Missing resolver proxy');
        const id = await proxy.registerRoute({
          sessionId,
          serverId: 'plugin-server',
          configId: 'default',
          displayName: 'Plugin',
          upstreamUrl,
          headers,
          oauthEnabled: false,
        });
        const mcpServerBindings: Record<string, ResolvedMcpServerBinding> = {};
        if (binding) mcpServerBindings.selected = binding;
        return {
          ...resolution(),
          mcpServerBindings,
          mcpServers: {
            selected: { type: 'http', url: proxy.getProxyUrl(id) },
          },
        };
      },
    );
}

test('plugin routes require a live gate from the start of resolution', async () => {
  resolvePluginRoute();
  const capabilities = await prepare();
  expect(mockSetGate.mock.invocationCallOrder[0]).toBeLessThan(
    mockRegisterRoute.mock.invocationCallOrder[0],
  );
  expect(mockRegisterRoute).toHaveBeenCalledWith(
    expect.objectContaining({ requireToolCallGate: true }),
  );
  await capabilities.dispose();
});

test('unchanged plugin routes resume with the same identity despite fresh proxy URLs', async () => {
  resolvePluginRoute();
  const first = await prepare();
  const firstIdentity = jest
    .mocked(snapshotOpenCodeMcpTools)
    .mock.calls.at(-1)?.[1];
  await first.dispose();
  const second = await prepare();
  const secondIdentity = jest
    .mocked(snapshotOpenCodeMcpTools)
    .mock.calls.at(-1)?.[1];
  expect(second.mcpServers).not.toEqual(first.mcpServers);
  expect(secondIdentity).toEqual(firstIdentity);
  await second.dispose();
  resolvePluginRoute('https://plugin.example/different');
  const changed = await prepare();
  expect(
    jest.mocked(snapshotOpenCodeMcpTools).mock.calls.at(-1)?.[1],
  ).not.toEqual(firstIdentity);
  await changed.dispose();
});

test.each([
  { kind: 'device', change: 'url' },
  { kind: 'device', change: 'header' },
  { kind: 'account', change: 'url' },
  { kind: 'account', change: 'header' },
] as const)(
  'bound $kind routes reject a changed $change while unchanged routes retain identity',
  async ({ kind, change }) => {
    const binding: ResolvedMcpServerBinding = {
      binding:
        kind === 'device'
          ? { kind, serverId: 'bound-server', configId: 'default' }
          : {
              kind,
              accountConnectionId: 'account',
              serverKey: 'bound-server',
              configId: 'default',
            },
      displayName: 'Bound server',
      sources: [
        { kind: 'standalone', serverId: 'bound-server', configId: 'default' },
      ],
    };
    const capture = async (
      upstream = 'https://plugin.example/mcp',
      headers = { Authorization: 'Bearer synthetic-original' },
    ): Promise<unknown> => {
      resolvePluginRoute(upstream, binding, headers);
      const capabilities = await prepare();
      try {
        return jest.mocked(snapshotOpenCodeMcpTools).mock.calls.at(-1)?.[1];
      } finally {
        await capabilities.dispose();
      }
    };
    const original = await capture();
    expect(await capture()).toEqual(original);
    const changed =
      change === 'url'
        ? await capture('https://other.example/mcp')
        : await capture(undefined, {
            Authorization: 'Bearer synthetic-changed',
          });
    expect(changed).not.toEqual(original);
  },
);
