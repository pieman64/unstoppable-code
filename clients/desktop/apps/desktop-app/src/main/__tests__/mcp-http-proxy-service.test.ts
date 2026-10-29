import { BOT_ACTION_TYPES } from '@canopy/agent-actions';
import type * as CanopyCoreModule from '../canopy-tools/core';
import { PROJECT_READ_ACTION_TYPES } from '@canopy/desktop-shared/lib/project-reads';
import {
  botActionSchema,
  type BotAction,
} from '@canopy/desktop-shared/lib/bot-discovery';
import type { AppAdvisorActionResponse } from '@canopy/desktop-shared/types';
import type { ProjectDiscoveryCaller } from '../project-discovery';
import { coworkDispatchActionJsonSchema } from '../canopy-tools/definitions';
import type * as InjectedToolCore from '../canopy-tools/core';
import {
  recordPresentationTurn,
  clearPresentationTurn,
} from '../canopy-tools/presentation-state';
import type * as CloudClientModule from '../canopy-cloud/client';
jest.mock('../canopy-cloud/client', (): object => ({
  ...jest.requireActual<typeof CloudClientModule>('../canopy-cloud/client'),
  resolveCanopyCloudCredentialContext: jest.fn(),
}));
import {
  CanopyCloudClientError,
  resolveCanopyCloudCredentialContext,
} from '../canopy-cloud/client';
import { isAccountMcpReauthRequired } from '../mcp/account-route-status';
import { chatVisualsEligible } from '../lib/chat-visuals-feature-flag';
/* eslint-disable @typescript-eslint/explicit-function-return-type */
import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';

type ExecuteCanopyInjectedToolCall = [string, unknown, unknown, unknown?];
const mockExecuteCanopyInjectedTool = jest.fn<
  unknown,
  ExecuteCanopyInjectedToolCall
>();
type BotServiceResponse = Omit<AppAdvisorActionResponse, 'requestId'>;
const mockIsBotAccessAllowed = jest.fn<
  Promise<boolean>,
  [ProjectDiscoveryCaller]
>();
const mockDispatchBotAction = jest.fn<
  Promise<BotServiceResponse>,
  [BotAction, ProjectDiscoveryCaller]
>();
jest.mock('../project-discovery/bots', (): object => ({
  isBotAccessAllowed: mockIsBotAccessAllowed,
  dispatchBotAction: mockDispatchBotAction,
}));
jest.mock('node:fs/promises', () => ({
  readFile: jest.fn(),
}));

jest.mock('../canopy-tools/core', () => ({
  executeCanopyInjectedTool: mockExecuteCanopyInjectedTool,
}));

const mockGetValidMcpAccessToken = jest.fn();
const mockHandleMcpOAuthCallback = jest.fn<
  Promise<{ success: boolean; message: string }>,
  [URL]
>(() => Promise.resolve({ success: true, message: 'ok' }));
jest.mock('../mcp/oauth-client', () => ({
  getValidMcpAccessToken: mockGetValidMcpAccessToken,
  handleMcpOAuthCallback: mockHandleMcpOAuthCallback,
}));

const mockInvalidateMcpOAuthAccessToken = jest.fn<
  Promise<void>,
  [string, string, string, string]
>(() => Promise.resolve());

type RecordMcpOAuthTokenErrorArgs = [
  string,
  string,
  string,
  { upstreamUrl?: string }?,
];
const mockRecordMcpOAuthTokenError = jest.fn<
  Promise<void>,
  RecordMcpOAuthTokenErrorArgs
>(() => Promise.resolve());
jest.mock('../mcp/oauth-token-store', () => ({
  recordMcpOAuthTokenError: mockRecordMcpOAuthTokenError,
  invalidateMcpOAuthAccessToken: mockInvalidateMcpOAuthAccessToken,
}));

jest.mock('../lib/paths', () => ({
  getMcpServerFilePath: jest.fn((serverId: string) => `/mock/${serverId}.json`),
}));

jest.mock('../lib/resolve-worktree', () => ({
  resolveWorktreeCwd: jest.fn(() => '/mock/worktree'),
}));

const mockUpsertPendingQuestion = jest.fn().mockResolvedValue(undefined);
const mockConsumePendingQuestion = jest.fn().mockResolvedValue(undefined);
const mockGetChatState = jest.fn(() =>
  Promise.resolve({
    recoveryError: null,
    tabsFile: {
      tabs: [
        {
          id: 'chat-1',
          approvalMode: 'ask',
          sessionApprovalRules: [],
        },
      ],
    },
  }),
);
jest.mock('../services/chat-state-service', () => ({
  getChatStateService: () => ({
    upsertPendingQuestion: mockUpsertPendingQuestion,
    consumePendingQuestion: mockConsumePendingQuestion,
    getState: mockGetChatState,
  }),
}));

const mockApprovalCheck = jest.fn(() => Promise.resolve({ decision: 'allow' }));
const mockApprovalDispose = jest.fn();
const mockCreateApprovalSession = jest.fn(() => ({
  check: mockApprovalCheck,
  dispose: mockApprovalDispose,
}));
jest.mock('../approvals/approval-service', () => ({
  createApprovalSession: mockCreateApprovalSession,
}));

type MockRegisteredIpcHandler = (event: unknown, ...args: unknown[]) => unknown;
const mockRegisteredIpcHandlers = new Map<string, MockRegisteredIpcHandler>();
jest.mock('../ipc/register', () => ({
  registerIpcHandler: (channel: string, handler: MockRegisteredIpcHandler) => {
    mockRegisteredIpcHandlers.set(channel, handler);
  },
}));

const mockIsEnabled = jest.fn();
jest.mock('../feature-flags', (): unknown => ({
  getFeatureFlagService: () => ({
    isEnabled: mockIsEnabled,
  }),
}));

import { readFile } from 'node:fs/promises';
import {
  MCP_PROXY_HEALTH_SERVICE,
  McpHttpProxyService,
} from '../mcp/http-proxy-service';
import {
  CANOPY_INJECTED_TOOL_REGISTRY,
  CANOPY_INJECTED_TOOL_SURFACE_ALLOWLISTS,
} from '@canopy/desktop-shared/lib/canopy-injected-tools';
import { resolveClaudeWorkerMemoryToolExposure } from '../integration/claude-worker-tool-exposure';
import type { AuthDependencyFailure } from '@canopy/protocol/auth-recovery';
import {
  claimPendingAuthFailures,
  recordPendingMcpAuthFailure,
} from '../mcp/pending-auth-failures';
import { pairPendingAuthFailures } from '../lib/auth-failure-event';
import { registerWorkspaceTypes } from '../lib/workspace-registry';
import type { BrowserWindow } from 'electron';
import {
  APP_ADVISOR_PROJECT_ID,
  IPC_CHANNELS,
  PIPELINE_EDITOR_PROJECT_ID,
  PIPELINE_EDITOR_WORKTREE_ID,
} from '@canopy/desktop-shared/types';
import { createAppAdvisorToolRuntime } from '../app-advisor/runtime';
import { registerAppAdvisorHandlers } from '../ipc/app-advisor';
import { createPipelineEditorToolRuntime } from '../pipeline-editor/runtime';
import { rejectAllForSession } from '../mcp/pending-requests';
import { registerPipelineEditorHandlers } from '../ipc/pipeline-editor';
import { deferredToolsReloadCoordinator } from '../deferred-tools/reload-coordinator';

const readFileMock = jest.mocked(readFile);
const globalOverrides = globalThis as Record<string, unknown>;

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (typeof address === 'string' || address === null) {
        reject(new Error('Expected TCP server address.'));
        return;
      }
      resolve(address.port);
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

async function getFreePort(): Promise<number> {
  const server = createServer();
  const port = await listen(server);
  await close(server);
  return port;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function waitForMockCall<TArgs extends unknown[]>(
  mock: jest.Mock<unknown, TArgs>,
  predicate: (args: TArgs) => boolean,
  timeoutMs = 1_000,
): Promise<TArgs | undefined> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const call = mock.mock.calls.find(predicate);
    if (call) {
      return call;
    }
    await wait(10);
  }
  return mock.mock.calls.find(predicate);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getListedToolNames(payload: unknown): string[] {
  if (!isRecord(payload) || !isRecord(payload.result)) {
    return [];
  }
  const tools = payload.result.tools;
  if (!Array.isArray(tools)) {
    return [];
  }
  return tools.flatMap((tool) =>
    isRecord(tool) && typeof tool.name === 'string' ? [tool.name] : [],
  );
}

function getToolResultText(payload: unknown): string {
  if (!isRecord(payload) || !isRecord(payload.result)) return '';
  const content = payload.result.content;
  if (!Array.isArray(content)) return '';
  const textItem: unknown = content.find(
    (item) => isRecord(item) && typeof item.text === 'string',
  );
  return isRecord(textItem) && typeof textItem.text === 'string'
    ? textItem.text
    : '';
}

function isProgressNotificationMessage(value: unknown): value is {
  method?: string;
  params?: {
    progressToken?: string;
    progress?: number;
    message?: string;
  };
} {
  if (!isRecord(value)) {
    return false;
  }
  if (value.method !== undefined && typeof value.method !== 'string') {
    return false;
  }
  if (value.params === undefined) {
    return true;
  }
  if (!isRecord(value.params)) {
    return false;
  }
  return (
    (value.params.progressToken === undefined ||
      typeof value.params.progressToken === 'string') &&
    (value.params.progress === undefined ||
      typeof value.params.progress === 'number') &&
    (value.params.message === undefined ||
      typeof value.params.message === 'string')
  );
}

function rawRequest(options: {
  port: number;
  path: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}): Promise<{ statusCode: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port: options.port,
        path: options.path,
        method: options.method ?? 'GET',
        headers: options.headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => {
          chunks.push(chunk);
        });
        res.on('end', () => {
          resolve({
            statusCode: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString('utf8'),
          });
        });
      },
    );
    req.on('error', reject);
    if (options.body) {
      req.write(options.body);
    }
    req.end();
  });
}

describe('McpHttpProxyService', () => {
  let service: McpHttpProxyService;
  const upstreamRequests: IncomingMessage[] = [];

  beforeEach(() => {
    jest.clearAllMocks();
    mockIsEnabled.mockImplementation(
      (key: string) => key !== 'canopy-desktop-chat-visuals',
    );
    delete globalOverrides.__CANOPY_DEV_MCP_PROXY_PORT__;
    service = new McpHttpProxyService();
    upstreamRequests.length = 0;
    readFileMock.mockResolvedValue(
      JSON.stringify({
        version: 1,
        server: {
          definition: {
            id: 'server-1',
            name: 'Server',
            description: '',
            type: 'http',
            url: 'http://127.0.0.1/mcp',
            oauth: {
              clientId: 'client',
              authorizationUrl: 'https://auth.test/authorize',
              tokenUrl: 'https://auth.test/token',
              scopes: [],
              usePkce: true,
            },
            createdAt: '2026-04-29T00:00:00.000Z',
            updatedAt: '2026-04-29T00:00:00.000Z',
          },
          configs: [
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
          ],
        },
      }),
    );
    mockExecuteCanopyInjectedTool.mockResolvedValue({ text: 'ok' });
    mockHandleMcpOAuthCallback.mockResolvedValue({
      success: true,
      message: 'ok',
    });
  });

  it('intersects the visual flag with provider, mode, and surface', () => {
    mockIsEnabled.mockReturnValue(true);
    expect(
      chatVisualsEligible({ providerType: 'claude', surface: 'native-sdk' }),
    ).toBe(true);
    expect(
      chatVisualsEligible({
        providerType: 'cursor',
        surface: 'cursor-acp-standalone',
      }),
    ).toBe(true);
    expect(
      chatVisualsEligible({ providerType: 'codex', surface: 'codex-cowork' }),
    ).toBe(true);
    expect(
      chatVisualsEligible({ providerType: 'copilot', surface: 'cursor-acp' }),
    ).toBe(false);
    expect(
      chatVisualsEligible({ providerType: 'ollama', surface: 'native-sdk' }),
    ).toBe(false);
    expect(
      chatVisualsEligible({
        providerType: 'claude',
        surface: 'claude-code-terminal',
      }),
    ).toBe(false);
    expect(
      chatVisualsEligible({
        providerType: 'claude',
        surface: 'native-sdk',
        assistantMode: 'app-advisor',
      }),
    ).toBe(false);
    mockIsEnabled.mockReturnValue(false);
    expect(
      chatVisualsEligible({ providerType: 'claude', surface: 'native-sdk' }),
    ).toBe(false);
  });

  afterEach(async () => {
    delete globalOverrides.__CANOPY_DEV_MCP_PROXY_PORT__;
    await service.shutdown();
  });

  it('probes port availability without starting the proxy', async () => {
    const occupied = createServer();
    const occupiedPort = await listen(occupied);
    try {
      await expect(service.assertPortAvailable(occupiedPort)).rejects.toThrow();
      expect(service.isRunning()).toBe(false);
    } finally {
      await close(occupied);
    }

    const freePort = await getFreePort();
    await expect(
      service.assertPortAvailable(freePort),
    ).resolves.toBeUndefined();
    expect(service.isRunning()).toBe(false);
  });

  it('binds to localhost, rejects unknown routes, and enforces methods', async () => {
    const upstream = createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{}');
    });
    const upstreamPort = await listen(upstream);
    const proxyPort = await getFreePort();
    await service.ensureStarted(proxyPort);
    const routeId = await service.registerRoute({
      sessionId: 'session-1',
      serverId: 'server-1',
      configId: 'config-1',
      displayName: 'Server',
      upstreamUrl: `http://127.0.0.1:${String(upstreamPort)}/mcp`,
      headers: {},
      oauthEnabled: false,
    });

    await expect(
      fetch(`http://localhost:${String(proxyPort)}/health`),
    ).resolves.toHaveProperty('status', 200);
    await expect(
      fetch(`http://127.0.0.1:${String(proxyPort)}/mcp/missing`),
    ).resolves.toHaveProperty('status', 404);
    await expect(
      fetch(`http://127.0.0.1:${String(proxyPort)}/mcp/${routeId}`, {
        method: 'PUT',
      }),
    ).resolves.toHaveProperty('status', 405);

    await close(upstream);
  });

  it('consults the session tool-call gate before forwarding a proxied tools/call', async () => {
    const upstreamBodies: string[] = [];
    const upstream = createServer((req, res) => {
      let body = '';
      req.setEncoding('utf8');
      req.on('data', (chunk: string) => {
        body += chunk;
      });
      req.on('end', () => {
        upstreamBodies.push(body);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"jsonrpc":"2.0","id":1,"result":{"content":[]}}');
      });
    });
    const upstreamPort = await listen(upstream);
    const proxyPort = await getFreePort();
    await service.ensureStarted(proxyPort);
    const routeId = await service.registerRoute({
      sessionId: 'session-gate',
      serverId: 'server-1',
      configId: 'config-1',
      displayName: 'Server',
      upstreamUrl: `http://127.0.0.1:${String(upstreamPort)}/mcp`,
      headers: {},
      oauthEnabled: false,
    });
    const gate = jest.fn((): Promise<boolean> => Promise.resolve(false));
    service.setSessionToolCallGate('session-gate', gate);
    const proxyUrl = service.getProxyUrl(routeId);
    const post = (payload: unknown): Promise<Response> =>
      fetch(proxyUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
    const toolCall = {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'create_issue', arguments: { title: 'x' } },
    };
    // Denied: answered here, never forwarded.
    const denied = await post(toolCall);
    expect(denied.status).toBe(200);
    const deniedBody: unknown = await denied.json();
    expect(gate).toHaveBeenCalledWith({
      proxyUrl,
      tool: 'create_issue',
      args: { title: 'x' },
      requestId: '1',
    });
    expect(
      isRecord(deniedBody) &&
        isRecord(deniedBody.result) &&
        deniedBody.result.isError === true,
    ).toBe(true);
    expect(JSON.stringify(deniedBody)).toContain('create_issue was denied.');
    expect(upstreamBodies).toEqual([]);
    // Other methods are forwarded without consulting the gate.
    await post({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    expect(gate).toHaveBeenCalledTimes(1);
    expect(upstreamBodies).toHaveLength(1);
    // Allowed: forwarded byte for byte.
    gate.mockResolvedValue(true);
    const allowed = await post(toolCall);
    expect(allowed.status).toBe(200);
    expect(upstreamBodies).toHaveLength(2);
    expect(JSON.parse(upstreamBodies[1] ?? '')).toEqual(toolCall);
    // A batch that includes a tool call is refused rather than forwarded.
    const batch = await post([
      toolCall,
      { jsonrpc: '2.0', id: 3, method: 'tools/list' },
    ]);
    expect(batch.status).toBe(200);
    expect(JSON.stringify(await batch.json())).toContain('error');
    expect(upstreamBodies).toHaveLength(2);
    // Ending the session drops the gate; a later route for the same session
    // is forwarded like any ungated route.
    service.unregisterRoutesForSession('session-gate');
    await close(upstream);
  });

  it('fails closed for a delegated route before its gate is installed', async () => {
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
    try {
      await service.ensureStarted(await getFreePort());
      const registration = {
        sessionId: 'delegated-before-gate',
        serverId: 'selected',
        configId: 'default',
        displayName: 'Selected',
        upstreamUrl: `http://127.0.0.1:${String(upstreamPort)}/mcp`,
        headers: {},
        oauthEnabled: false,
        requireToolCallGate: true,
      };
      const routeId = await service.registerRoute(registration);
      const response = await fetch(service.getProxyUrl(routeId), {
        method: 'POST',
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'review_evidence', arguments: {} },
        }),
      });
      expect(response.status).toBe(200);
      expect(JSON.stringify(await response.json())).toContain('unavailable');
      expect(upstreamBodies).toEqual([]);
    } finally {
      await close(upstream);
    }
  });

  it('refuses a delegated tool call approved after its session is released', async () => {
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
    try {
      await service.ensureStarted(await getFreePort());
      const registration = {
        sessionId: 'delegated-late-approval',
        serverId: 'selected',
        configId: 'default',
        displayName: 'Selected',
        upstreamUrl: `http://127.0.0.1:${String(upstreamPort)}/mcp`,
        headers: {},
        oauthEnabled: false,
        requireToolCallGate: true,
      };
      const routeId = await service.registerRoute(registration);
      let releaseApproval: ((allowed: boolean) => void) | undefined;
      let gateStarted: (() => void) | undefined;
      const started = new Promise<void>((resolve) => {
        gateStarted = resolve;
      });
      service.setSessionToolCallGate(
        registration.sessionId,
        () =>
          new Promise<boolean>((resolve) => {
            releaseApproval = resolve;
            gateStarted?.();
          }),
      );
      const response = fetch(service.getProxyUrl(routeId), {
        method: 'POST',
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/call',
          params: { name: 'review_evidence', arguments: {} },
        }),
      });
      await started;
      service.unregisterRoutesForSession(registration.sessionId);
      releaseApproval?.(true);
      const result = await response;
      expect(result.status).toBe(200);
      expect(JSON.stringify(await result.json())).toContain('unavailable');
      expect(upstreamBodies).toEqual([]);
    } finally {
      await close(upstream);
    }
  });

  it('rejects non-local hosts and browser origins at the request entrypoint', async () => {
    const proxyPort = await getFreePort();
    await service.ensureStarted(proxyPort);

    await expect(
      fetch(`http://127.0.0.1:${String(proxyPort)}/health`, {
        headers: { Origin: 'https://evil.test' },
      }),
    ).resolves.toHaveProperty('status', 403);

    const response = await rawRequest({
      port: proxyPort,
      path: '/health',
      headers: { Host: `evil.test:${String(proxyPort)}` },
    });
    expect(response.statusCode).toBe(421);
  });

  it('renders the branded success page for an MCP OAuth callback', async () => {
    const proxyPort = await getFreePort();
    await service.ensureStarted(proxyPort);

    const response = await fetch(
      `http://127.0.0.1:${String(proxyPort)}/oauth/callback?code=abc&state=xyz`,
    );
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe(
      'text/html; charset=utf-8',
    );
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    expect(response.headers.get('content-security-policy')).toContain(
      "default-src 'none'",
    );
    expect(html).toContain('<h1>Connected</h1>');
    // Success tone, and the resolver's message lands in the detail line.
    expect(html).toContain('background:var(--bg-accent-subtle)');
    expect(html).not.toContain('background:var(--bg-destructive-subtle)');
    expect(html).toContain('<p class="detail">ok</p>');
    // The callback URL carries a code, so it must be scrubbed from history.
    expect(html).toContain("history.replaceState({}, '', location.pathname)");
    expect(html).not.toContain('code=abc');
  });

  it('returns 400 and the error tone when an MCP OAuth callback fails', async () => {
    mockHandleMcpOAuthCallback.mockResolvedValue({
      success: false,
      message: 'State did not match.',
    });
    const proxyPort = await getFreePort();
    await service.ensureStarted(proxyPort);

    const response = await fetch(
      `http://127.0.0.1:${String(proxyPort)}/oauth/callback?code=abc&state=xyz`,
    );
    const html = await response.text();

    expect(response.status).toBe(400);
    expect(html).toContain('Couldn&#39;t connect');
    expect(html).toContain('<p class="detail">State did not match.</p>');
    expect(html).toContain('background:var(--bg-destructive-subtle)');
    expect(html).not.toContain('background:var(--bg-accent-subtle)');
  });

  it('self-identifies on the health endpoint', async () => {
    const proxyPort = await getFreePort();
    await service.ensureStarted(proxyPort);

    const response = await fetch(
      `http://127.0.0.1:${String(proxyPort)}/health`,
    );
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      service: MCP_PROXY_HEALTH_SERVICE,
      version: 1,
      port: proxyPort,
      status: 'running',
      routeCount: 0,
    });
  });

  it('serializes concurrent startup attempts on the same port', async () => {
    const proxyPort = await getFreePort();

    await expect(
      Promise.all([
        service.ensureStarted(proxyPort),
        service.ensureStarted(proxyPort),
      ]),
    ).resolves.toEqual([undefined, undefined]);
    expect(service.getState()).toMatchObject({
      port: proxyPort,
      status: 'running',
    });
    await expect(
      fetch(`http://127.0.0.1:${String(proxyPort)}/health`),
    ).resolves.toHaveProperty('status', 200);
  });

  it('uses the dev MCP proxy port override instead of the preference port', async () => {
    const overridePort = await getFreePort();
    const preferencePort = overridePort === 65535 ? 65534 : overridePort + 1;
    globalOverrides.__CANOPY_DEV_MCP_PROXY_PORT__ = overridePort;

    await service.ensureStarted(preferencePort);

    expect(service.getPort()).toBe(overridePort);
    expect(service.getState()).toMatchObject({
      port: overridePort,
      portLocked: true,
      status: 'running',
    });
    await expect(
      fetch(`http://127.0.0.1:${String(overridePort)}/health`),
    ).resolves.toHaveProperty('status', 200);
  });

  it('reports a specific error when another Canopy proxy owns the port', async () => {
    const otherProxy = createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          ok: true,
          service: MCP_PROXY_HEALTH_SERVICE,
          version: 1,
          port: null,
          status: 'running',
          routeCount: 0,
        }),
      );
    });
    const otherPort = await listen(otherProxy);

    try {
      await expect(service.assertPortAvailable(otherPort)).rejects.toThrow(
        'already in use by another Canopy MCP proxy',
      );
      await service.refreshPreferredPortStatus(otherPort);
      const state = service.getState();
      expect(state.port).toBe(otherPort);
      expect(state.status).toBe('error');
      expect(state.error).toContain(
        'already in use by another Canopy MCP proxy',
      );
    } finally {
      await close(otherProxy);
    }
  });

  it('forwards allowed methods and safe MCP headers without client auth headers', async () => {
    const methods: string[] = [];
    const upstream = createServer((req, res) => {
      upstreamRequests.push(req);
      methods.push(req.method ?? '');
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-cache',
        'Mcp-Session-Id': 'upstream-session',
        'Mcp-Protocol-Version': '2024-11-05',
        'Last-Event-Id': 'upstream-event',
        'WWW-Authenticate': 'Bearer realm="mcp"',
      });
      res.end(JSON.stringify({ ok: true }));
    });
    const upstreamPort = await listen(upstream);
    const proxyPort = await getFreePort();
    await service.ensureStarted(proxyPort);
    const routeId = await service.registerRoute({
      sessionId: 'session-1',
      serverId: 'server-1',
      configId: 'config-1',
      displayName: 'Server',
      upstreamUrl: `http://127.0.0.1:${String(upstreamPort)}/mcp`,
      headers: { 'X-Static': 'yes' },
      oauthEnabled: false,
    });
    const proxyUrl = service.getProxyUrl(routeId);
    const responses: Response[] = [];

    for (const method of ['GET', 'POST', 'DELETE']) {
      const response = await fetch(proxyUrl, {
        method,
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'Mcp-Session-Id': 'mcp-session',
          'Mcp-Protocol-Version': '2024-11-05',
          'Last-Event-Id': 'event-1',
          Cookie: 'secret',
          Authorization: 'Bearer client-token',
        },
        body: method === 'GET' ? undefined : '{}',
      });
      responses.push(response);
    }

    expect(methods).toEqual(['GET', 'POST', 'DELETE']);
    expect(responses[1]?.headers.get('mcp-session-id')).toBe(
      'upstream-session',
    );
    expect(responses[1]?.headers.get('mcp-protocol-version')).toBe(
      '2024-11-05',
    );
    expect(responses[1]?.headers.get('last-event-id')).toBe('upstream-event');
    expect(responses[1]?.headers.get('www-authenticate')).toBe(
      'Bearer realm="mcp"',
    );
    const headers = upstreamRequests[1].headers;
    expect(headers['mcp-session-id']).toBe('mcp-session');
    expect(headers['mcp-protocol-version']).toBe('2024-11-05');
    expect(headers['last-event-id']).toBe('event-1');
    expect(headers['x-static']).toBe('yes');
    expect(headers.cookie).toBeUndefined();
    expect(headers.authorization).toBeUndefined();

    await close(upstream);
  });

  it('dispatches the legacy MCP proxy alias through the same route handler', async () => {
    const upstream = createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
    const upstreamPort = await listen(upstream);
    const proxyPort = await getFreePort();
    await service.ensureStarted(proxyPort);
    const routeId = await service.registerRoute({
      sessionId: 'session-1',
      serverId: 'server-1',
      configId: 'config-1',
      displayName: 'Server',
      upstreamUrl: `http://127.0.0.1:${String(upstreamPort)}/mcp`,
      headers: {},
      oauthEnabled: false,
    });

    const response = await fetch(
      `http://127.0.0.1:${String(proxyPort)}/mcp/${routeId}`,
      { method: 'POST', body: '{}' },
    );

    expect(response.status).toBe(200);
    await close(upstream);
  });

  it('waits for the native Copilot receipt instead of acknowledging an HTTP write', async () => {
    const delivered = jest
      .spyOn(
        deferredToolsReloadCoordinator,
        'markToolResultDeliveredAndWaitForResume',
      )
      .mockResolvedValue(false);
    const nativeToolResultDelivery = jest.fn();
    const route = {
      sessionKey: 'copilot-native-receipt',
      projectId: 'project-1',
      worktreeId: 'wt-1',
      chatId: 'chat-1',
      sdkSessionId: 'native-session',
      providerType: 'copilot' as const,
      authToken: 'receipt-token',
      createdAt: Date.now(),
      hookHandler: jest.fn(),
      nativeToolResultDelivery,
    };
    try {
      await service.ensureStarted(await getFreePort());
      await service.registerCanopyWorktreeSessionRoute(route);
      mockExecuteCanopyInjectedTool.mockResolvedValue({
        text: 'receipt-result',
      });
      const response = await fetch(
        service.getCanopyWorktreeMcpUrl(route.sessionKey),
        {
          method: 'POST',
          headers: {
            Authorization: 'Bearer receipt-token',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 'rpc-1',
            method: 'tools/call',
            params: {
              name: 'GetScriptOutput',
              arguments: { scriptId: 'fixture' },
            },
          }),
        },
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        result: { content: [{ type: 'text', text: 'receipt-result' }] },
      });
      const anyToolId: unknown = expect.any(String);
      expect(nativeToolResultDelivery).toHaveBeenCalledWith(
        expect.objectContaining({
          requestId: 'rpc-1',
          toolUseId: anyToolId,
          result: { content: [{ type: 'text', text: 'receipt-result' }] },
        }),
      );
      expect(delivered).not.toHaveBeenCalled();
    } finally {
      delivered.mockRestore();
    }
  });

  it.each([false, true])(
    'answers a failed native delivery without cancelling an unrelated reload (%s)',
    async (unrelated) => {
      const scope = {
        projectId: 'project-1',
        worktreeId: 'wt-1',
        chatId: 'chat-1',
      };
      const route = {
        sessionKey: 'copilot-failed-delivery',
        ...scope,
        sdkSessionId: 'native-session',
        providerType: 'copilot' as const,
        authToken: 'receipt-token',
        createdAt: Date.now(),
        hookHandler: jest.fn(),
        nativeToolResultDelivery: ({
          toolUseId,
        }: {
          toolUseId: string;
        }): void => {
          const intent = deferredToolsReloadCoordinator.createIntent({
            scope,
            toolCallId: unrelated ? 'other-tool' : toolUseId,
            providerType: 'copilot',
            additions: { skillRefs: [], pluginRefs: [], mcpServerRefs: [] },
            enabledResources: [],
          });
          expect(intent.accepted).toBe(true);
          throw new Error('Native receipt unavailable');
        },
      };
      try {
        await service.ensureStarted(await getFreePort());
        await service.registerCanopyWorktreeSessionRoute(route);
        mockExecuteCanopyInjectedTool.mockResolvedValue({
          text: 'receipt-result',
        });
        const response = await fetch(
          service.getCanopyWorktreeMcpUrl(route.sessionKey),
          {
            method: 'POST',
            signal: AbortSignal.timeout(1500),
            headers: {
              Authorization: 'Bearer receipt-token',
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              jsonrpc: '2.0',
              id: 'rpc-failed',
              method: 'tools/call',
              params: {
                name: 'GetScriptOutput',
                arguments: { scriptId: 'fixture' },
              },
            }),
          },
        );
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({
          id: 'rpc-failed',
          error: { code: -32603 },
        });
        expect(deferredToolsReloadCoordinator.hasActiveReload(scope)).toBe(
          unrelated,
        );
      } finally {
        deferredToolsReloadCoordinator.resetForTests();
      }
    },
  );

  it('requires auth and exposes terminal-safe Canopy tools on worktree MCP routes', async () => {
    const proxyPort = await getFreePort();
    await service.ensureStarted(proxyPort);
    await service.registerCanopyWorktreeSessionRoute({
      sessionKey: 'session-key',
      projectId: 'project-1',
      worktreeId: 'wt-1',
      chatId: 'chat-1',
      cwd: '/mock/worktree/repo-a',
      sdkSessionId: 'sdk-1',
      authToken: 'secret-token',
      createdAt: Date.now(),
      hookHandler: jest.fn(),
    });
    const url = service.getCanopyWorktreeMcpUrl('session-key');

    await expect(
      fetch(url, { method: 'POST', body: '{}' }),
    ).resolves.toHaveProperty('status', 401);
    const missingResponse = await fetch(
      `http://127.0.0.1:${String(proxyPort)}/canopy/mcp/worktree-session/missing`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 'missing-session',
          method: 'tools/list',
        }),
      },
    );
    expect(missingResponse.status).toBe(404);
    await expect(missingResponse.json()).resolves.toMatchObject({
      jsonrpc: '2.0',
      id: 'missing-session',
      error: {
        code: -32004,
        message: 'Canopy worktree session not found',
      },
    });

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer secret-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(response.status).toBe(200);
    const payload = (await response.json()) as unknown;
    expect(payload).toMatchObject({
      result: {
        tools: [
          expect.objectContaining({ name: 'WatchCommand' }),
          expect.objectContaining({ name: 'ScheduleWakeup' }),
          expect.objectContaining({ name: 'GetScriptOutput' }),
          expect.objectContaining({ name: 'GetGitPreferences' }),
          expect.objectContaining({ name: 'SaveMemory' }),
          expect.objectContaining({ name: 'SearchMemory' }),
          expect.objectContaining({ name: 'ReadMemory' }),
          expect.objectContaining({ name: 'ReadPipelineYaml' }),
          expect.objectContaining({ name: 'ShowFiles' }),
          expect.objectContaining({ name: 'ShowCapabilities' }),
          expect.objectContaining({ name: 'GetFileComments' }),
          expect.objectContaining({ name: 'RespondToFileComment' }),
          expect.objectContaining({ name: 'SearchActions' }),
          expect.objectContaining({ name: 'DispatchAction' }),
          expect.objectContaining({ name: 'SearchWatchers' }),
          expect.objectContaining({ name: 'SetupWatchers' }),
          expect.objectContaining({ name: 'WatchGitHubItems' }),
          expect.objectContaining({ name: 'GetGitHubPullRequestStatus' }),
          expect.objectContaining({ name: 'DeleteWatchers' }),
          expect.objectContaining({ name: 'SetAutoArchive' }),
          expect.objectContaining({ name: 'SetBaseBranch' }),
          expect.objectContaining({ name: 'GetCodeGraphContext' }),
          expect.objectContaining({ name: 'BuildOrUpdateCodeGraph' }),
          expect.objectContaining({ name: 'QueryCodeGraph' }),
          expect.objectContaining({ name: 'SearchCodeGraph' }),
          expect.objectContaining({ name: 'ExplainCodeSymbol' }),
          expect.objectContaining({ name: 'GetImpactRadius' }),
          expect.objectContaining({ name: 'DetectChangedSymbols' }),
          expect.objectContaining({ name: 'CompareChangeImpact' }),
          expect.objectContaining({ name: 'GetReviewContext' }),
          expect.objectContaining({ name: 'SearchDeferredTools' }),
          expect.objectContaining({ name: 'LoadDeferredTools' }),
        ],
      },
    });
    if (
      !isRecord(payload) ||
      !isRecord(payload.result) ||
      !Array.isArray(payload.result.tools)
    ) {
      throw new Error('Expected listed tools');
    }
    const searchWatchers: unknown = payload.result.tools.find(
      (tool: unknown) => isRecord(tool) && tool.name === 'SearchWatchers',
    );
    expect(searchWatchers).toMatchObject({
      inputSchema: {
        properties: {
          activePageSize: {
            type: 'integer',
            minimum: 1,
            maximum: 200,
            default: 50,
          },
          activeCursor: { type: 'string', minLength: 1, maxLength: 200 },
          activeQuery: { type: 'string', maxLength: 500 },
          targetProjectId: { type: 'string', minLength: 1 },
          targetBotId: { type: 'string', minLength: 1 },
          targetTaskId: { type: 'string', minLength: 1 },
          targetChatId: { type: 'string', minLength: 1 },
          limit: { minimum: 1, maximum: 50 },
        },
      },
    });
    expect(JSON.stringify(payload)).not.toContain('AskUserQuestion');
    expect(JSON.stringify(payload)).not.toContain('StartForkedAgent');
    expect(JSON.stringify(payload)).not.toContain('StartBranchedAgent');
  });

  it.each([
    ['native-sdk', 'project-1', 'worktree-1', 'worktree'],
    ['native-sdk-standalone', 'cowork-1', 'entry-1', 'directory'],
  ] as const)(
    'rechecks bot discovery access through Claude HTTP tools on %s sessions',
    async (toolSurface, projectId, worktreeId, executionScope) => {
      registerWorkspaceTypes(new Map([['cowork-1', 'cowork']]));
      try {
        mockIsBotAccessAllowed
          .mockResolvedValueOnce(true)
          .mockResolvedValueOnce(false)
          .mockResolvedValueOnce(true);
        mockDispatchBotAction.mockResolvedValue({
          ok: true,
          result: { items: [], returned: 0 },
        });
        const executeCanopyInjectedToolDirect = jest.requireActual<
          typeof CanopyCoreModule
        >('../canopy-tools/core').executeCanopyInjectedTool;
        mockExecuteCanopyInjectedTool.mockImplementation((...args) =>
          executeCanopyInjectedToolDirect(...args),
        );
        await service.ensureStarted(await getFreePort());
        await service.registerCanopyWorktreeSessionRoute({
          sessionKey: `bot-discovery-${toolSurface}`,
          projectId,
          worktreeId,
          chatId: 'origin-chat',
          toolSurface,
          cwd: '/mock/session',
          sdkSessionId: `sdk-${toolSurface}`,
          authToken: 'test-token',
          createdAt: Date.now(),
          hookHandler: jest.fn(),
        });
        const url = service.getCanopyWorktreeMcpUrl(
          `bot-discovery-${toolSurface}`,
        );
        const request = async (
          method: string,
          params?: unknown,
        ): Promise<unknown> => {
          const id = `bot-route-${String(mockExecuteCanopyInjectedTool.mock.calls.length)}-${method}`;
          const response = await fetch(url, {
            method: 'POST',
            headers: {
              Authorization: 'Bearer test-token',
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
          });
          expect(response.status).toBe(200);
          return response.json();
        };

        const listing = await request('tools/list');
        expect(getListedToolNames(listing)).toEqual(
          expect.arrayContaining(['SearchActions', 'DispatchAction']),
        );
        expect(JSON.stringify(listing)).toContain('bots.list');

        const searchArgs = { query: 'bots', limit: 50 };
        const enabledSearch = await request('tools/call', {
          name: 'SearchActions',
          arguments: searchArgs,
        });
        const disabledSearch = await request('tools/call', {
          name: 'SearchActions',
          arguments: searchArgs,
        });
        const reenabledSearch = await request('tools/call', {
          name: 'SearchActions',
          arguments: searchArgs,
        });
        const enabledCatalog: unknown = JSON.parse(
          getToolResultText(enabledSearch),
        );
        const disabledCatalog: unknown = JSON.parse(
          getToolResultText(disabledSearch),
        );
        const reenabledCatalog: unknown = JSON.parse(
          getToolResultText(reenabledSearch),
        );
        expect(enabledCatalog).toHaveProperty(
          'categories',
          expect.arrayContaining(['bots']),
        );
        expect(enabledCatalog).toHaveProperty(
          'totalMatches',
          BOT_ACTION_TYPES.length,
        );
        expect(disabledCatalog).toHaveProperty(
          'categories',
          expect.not.arrayContaining(['bots']),
        );
        expect(disabledCatalog).toHaveProperty('totalMatches', 0);
        expect(reenabledCatalog).toHaveProperty(
          'categories',
          expect.arrayContaining(['bots']),
        );
        expect(reenabledCatalog).toHaveProperty(
          'totalMatches',
          BOT_ACTION_TYPES.length,
        );

        const caller: ProjectDiscoveryCaller = {
          kind: 'project_agent',
          projectId,
          worktreeId,
          chatId: 'origin-chat',
        };
        expect(mockIsBotAccessAllowed).toHaveBeenCalledTimes(3);
        expect(mockIsBotAccessAllowed).toHaveBeenNthCalledWith(1, caller);
        expect(mockIsBotAccessAllowed).toHaveBeenNthCalledWith(2, caller);
        expect(mockIsBotAccessAllowed).toHaveBeenNthCalledWith(3, caller);

        const searchCalls = mockExecuteCanopyInjectedTool.mock.calls.filter(
          ([key]) => key === 'search_actions',
        );
        expect(searchCalls).toHaveLength(3);
        for (const searchCall of searchCalls) {
          expect(searchCall[1]).toEqual(searchArgs);
          expect(searchCall[2]).toMatchObject({
            worktreeActionRuntime: {
              projectId,
              worktreeId,
              chatId: 'origin-chat',
              ...(executionScope === 'directory'
                ? { executionScope: 'directory' }
                : {}),
            },
          });
        }

        const action = { type: 'bots.list' };
        const dispatch = await request('tools/call', {
          name: 'DispatchAction',
          arguments: { action },
        });
        // The engine echoes the tool use id.
        const anyRequestId: unknown = expect.any(String);
        expect(JSON.parse(getToolResultText(dispatch))).toMatchObject({
          ok: true,
          result: { items: [], returned: 0 },
          requestId: anyRequestId,
        });
        const dispatchCall = mockExecuteCanopyInjectedTool.mock.calls.find(
          ([key]) => key === 'dispatch_action',
        );
        expect(dispatchCall?.[1]).toEqual({ action });
        expect(mockDispatchBotAction).toHaveBeenCalledWith(
          botActionSchema.parse(action),
          caller,
        );
        expect(dispatchCall?.[2]).toMatchObject({
          worktreeActionRuntime: {
            projectId,
            worktreeId,
            chatId: 'origin-chat',
            ...(executionScope === 'directory'
              ? { executionScope: 'directory' }
              : {}),
          },
        });
        expect(mockIsBotAccessAllowed).toHaveBeenCalledTimes(3);
        mockDispatchBotAction.mockResolvedValueOnce({
          ok: false,
          error: {
            code: 'advisor_access_disabled',
            message: 'Access disabled.',
          },
        });
        const deniedDispatch = await request('tools/call', {
          name: 'DispatchAction',
          arguments: { action },
        });
        expect(JSON.parse(getToolResultText(deniedDispatch))).toMatchObject({
          ok: false,
          error: { code: 'advisor_access_disabled' },
        });
        expect(deniedDispatch).toMatchObject({ result: { isError: true } });
        expect(mockDispatchBotAction).toHaveBeenCalledTimes(2);
        expect(mockDispatchBotAction).toHaveBeenNthCalledWith(
          2,
          botActionSchema.parse(action),
          caller,
        );
        expect(mockIsBotAccessAllowed).toHaveBeenCalledTimes(3);
      } finally {
        registerWorkspaceTypes(new Map());
      }
    },
  );

  it('keeps the code-review comment tools and treats the retired plan comment tools as unknown', async () => {
    const proxyPort = await getFreePort();
    await service.ensureStarted(proxyPort);
    const respondToReviewComment = jest
      .fn()
      .mockResolvedValue({ ok: true, resolved: false });
    const getReviewCommentThread = jest
      .fn()
      .mockResolvedValue({ ok: true, text: 'No open comment threads.' });
    await service.registerCanopyWorktreeSessionRoute({
      sessionKey: 'review-session',
      projectId: 'project-1',
      worktreeId: 'wt-1',
      chatId: 'chat-1',
      cwd: '/mock/worktree/repo-a',
      sdkSessionId: 'sdk-1',
      authToken: 'secret-token',
      createdAt: Date.now(),
      hookHandler: jest.fn(),
      isCodeReview: true,
      respondToReviewComment,
      getReviewCommentThread,
    });
    await service.registerCanopyWorktreeSessionRoute({
      sessionKey: 'worktree-session',
      projectId: 'project-1',
      worktreeId: 'wt-1',
      chatId: 'chat-2',
      cwd: '/mock/worktree/repo-a',
      sdkSessionId: 'sdk-2',
      authToken: 'secret-token',
      createdAt: Date.now(),
      hookHandler: jest.fn(),
    });
    const post = (sessionKey: string, body: unknown): Promise<Response> =>
      fetch(service.getCanopyWorktreeMcpUrl(sessionKey), {
        method: 'POST',
        headers: {
          Authorization: 'Bearer secret-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });

    const reviewTools = getListedToolNames(
      await (
        await post('review-session', {
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/list',
        })
      ).json(),
    );
    expect(reviewTools).toEqual(
      expect.arrayContaining(['RespondToComment', 'GetReviewComments']),
    );
    expect(reviewTools).not.toContain('GetPlanComments');

    const reply = await post('review-session', {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: {
        name: 'RespondToComment',
        arguments: { threadId: 'thread-1', body: 'Fixed.' },
      },
    });
    await expect(reply.json()).resolves.toMatchObject({
      result: { content: [{ text: 'Reply posted to thread thread-1.' }] },
    });
    expect(respondToReviewComment).toHaveBeenCalledWith({
      threadId: 'thread-1',
      body: 'Fixed.',
      resolve: false,
    });

    const worktreeTools = getListedToolNames(
      await (
        await post('worktree-session', {
          jsonrpc: '2.0',
          id: 3,
          method: 'tools/list',
        })
      ).json(),
    );
    expect(worktreeTools).not.toContain('GetPlanComments');
    expect(worktreeTools).not.toContain('RespondToComment');
    const retired = await post('worktree-session', {
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'GetPlanComments', arguments: {} },
    });
    const retiredPayload: unknown = await retired.json();
    expect(retiredPayload).toMatchObject({ error: { code: -32602 } });
    expect(JSON.stringify(retiredPayload)).toMatch(/Unknown .+ MCP tool/);
  });

  it.each(['native-sdk', 'copilot-sdk', 'opencode-acp'] as const)(
    'keeps Code Graph tool advertisement immutable for %s',
    async (toolSurface) => {
      const proxyPort = await getFreePort();
      await service.ensureStarted(proxyPort);
      const registerWorkspaceRoute = async (
        sessionKey: string,
        projectId: string,
        codeGraphToolsAdvertised: boolean,
      ): Promise<void> => {
        await service.registerCanopyWorktreeSessionRoute({
          sessionKey,
          projectId,
          worktreeId: `worktree-${projectId}`,
          chatId: `chat-${projectId}`,
          cwd: `/mock/${projectId}`,
          sdkSessionId: `sdk-${projectId}`,
          authToken: 'secret-token',
          createdAt: Date.now(),
          hookHandler: jest.fn(),
          codeGraphToolsAdvertised,
          toolSurface,
        });
      };
      const listToolNames = async (sessionKey: string): Promise<string[]> => {
        const response = await fetch(
          service.getCanopyWorktreeMcpUrl(sessionKey),
          {
            method: 'POST',
            headers: {
              Authorization: 'Bearer secret-token',
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              jsonrpc: '2.0',
              id: sessionKey,
              method: 'tools/list',
            }),
          },
        );
        const payload: unknown = await response.json();
        if (!isRecord(payload) || !isRecord(payload.result)) {
          return [];
        }
        const tools = payload.result.tools;
        if (!Array.isArray(tools)) {
          return [];
        }
        return tools.flatMap((tool) =>
          isRecord(tool) && typeof tool.name === 'string' ? [tool.name] : [],
        );
      };

      await registerWorkspaceRoute('enabled-route', 'enabled-workspace', true);
      await registerWorkspaceRoute(
        'disabled-route',
        'disabled-workspace',
        false,
      );

      const enabledBefore = await listToolNames('enabled-route');
      const disabledBefore = await listToolNames('disabled-route');
      expect(enabledBefore).toContain('GetCodeGraphContext');
      if (toolSurface === 'opencode-acp') {
        expect(enabledBefore).toContain('StartForkedAgent');
        expect(enabledBefore).toContain('StartBranchedAgent');
        expect(enabledBefore).toContain('LoadDeferredTools');
      }
      expect(disabledBefore).not.toContain('GetCodeGraphContext');

      // A later live preference/flag change cannot rewrite either route's
      // session-scoped advertisement snapshot.
      mockIsEnabled.mockReturnValue(false);
      expect(await listToolNames('enabled-route')).toEqual(enabledBefore);
      expect(await listToolNames('disabled-route')).toEqual(disabledBefore);
    },
  );

  it('exposes worker memory tools alongside the worker report tool', async () => {
    const proxyPort = await getFreePort();
    await service.ensureStarted(proxyPort);
    let captured: unknown;
    await service.registerCanopyWorktreeSessionRoute({
      sessionKey: 'worker-session',
      projectId: 'project-1',
      worktreeId: 'wt-1',
      chatId: 'worker-1',
      toolSurface: 'claude-worker',
      workerMemoryToolExposure: 'read-write',
      cwd: '/mock/worktree/repo-a',
      sdkSessionId: 'sdk-1',
      authToken: 'secret-token',
      createdAt: Date.now(),
      hookHandler: jest.fn(),
      reportStructuredResultSchema: {
        type: 'object',
        properties: { title: { type: 'string' } },
        required: ['title'],
      },
      onReportStructuredResult: (payload) => {
        if (
          typeof payload === 'object' &&
          payload !== null &&
          Reflect.get(payload, 'title') === 'ok'
        ) {
          captured = payload;
          return { ok: true };
        }
        return { ok: false, error: 'title is required' };
      },
    });
    const url = service.getCanopyWorktreeMcpUrl('worker-session');

    const listResponse = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer secret-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(listResponse.status).toBe(200);
    const listPayload = (await listResponse.json()) as {
      result?: {
        tools?: Array<{ name?: string; inputSchema?: Record<string, unknown> }>;
      };
    };
    expect(listPayload.result?.tools).toHaveLength(4);
    expect(listPayload.result?.tools?.[0]?.name).toBe('ReportStructuredResult');
    expect(listPayload.result?.tools?.[0]?.inputSchema?.required).toEqual([
      'title',
    ]);
    expect(listPayload.result?.tools?.map((tool) => tool.name)).toEqual(
      expect.arrayContaining(['SaveMemory', 'SearchMemory', 'ReadMemory']),
    );

    const invalidResponse = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer secret-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'ReportStructuredResult',
          arguments: { title: 42 },
        },
      }),
    });
    expect(invalidResponse.status).toBe(200);
    const invalidPayload = (await invalidResponse.json()) as {
      result?: { isError?: boolean; content?: Array<{ text?: string }> };
    };
    expect(invalidPayload.result?.isError).toBe(true);
    expect(invalidPayload.result?.content?.[0]?.text).toContain(
      'call ReportStructuredResult again',
    );

    const validResponse = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer secret-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: {
          name: 'ReportStructuredResult',
          arguments: { title: 'ok' },
        },
      }),
    });
    expect(validResponse.status).toBe(200);
    await expect(validResponse.json()).resolves.toMatchObject({
      result: {
        content: [
          expect.objectContaining({
            text: 'Structured result recorded. Stop now.',
          }),
        ],
      },
    });
    expect(captured).toEqual({ title: 'ok' });
  });

  it('advertises only Cowork placements to Copilot standalone chats', async () => {
    await service.ensureStarted(await getFreePort());
    await service.registerCanopyWorktreeSessionRoute({
      sessionKey: 'copilot-cowork-schema',
      projectId: 'cowork-1',
      worktreeId: 'entry-1',
      chatId: 'chat-1',
      toolSurface: 'copilot-sdk-standalone',
      cwd: '/mock/cowork',
      authToken: 'secret-token',
      createdAt: Date.now(),
      hookHandler: jest.fn(),
    });
    const response = await fetch(
      service.getCanopyWorktreeMcpUrl('copilot-cowork-schema'),
      {
        method: 'POST',
        headers: {
          Authorization: 'Bearer secret-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      },
    );
    const payload: unknown = await response.json();
    const tools =
      isRecord(payload) &&
      isRecord(payload.result) &&
      Array.isArray(payload.result.tools)
        ? payload.result.tools.filter(isRecord)
        : [];
    const dispatch = tools.find((tool) => tool.name === 'DispatchAction');
    expect(dispatch).toBeDefined();
    expect(JSON.stringify(dispatch?.inputSchema)).not.toContain(
      '"new_worktree"',
    );
  });

  it('exposes and dispatches worker memory tools without a report schema', async () => {
    let executedKey: unknown;
    let executedArgs: unknown;
    let executedRuntime: unknown;
    let executedOptions: unknown;
    mockExecuteCanopyInjectedTool.mockImplementationOnce(
      (
        canonicalKey: unknown,
        args: unknown,
        runtime: unknown,
        options: unknown,
      ): Promise<{ text: string }> => {
        executedKey = canonicalKey;
        executedArgs = args;
        executedRuntime = runtime;
        executedOptions = options;
        return Promise.resolve({ text: 'ok' });
      },
    );
    const proxyPort = await getFreePort();
    await service.ensureStarted(proxyPort);
    await service.registerCanopyWorktreeSessionRoute({
      sessionKey: 'worker-memory-session',
      projectId: 'project-1',
      worktreeId: 'wt-1',
      chatId: 'worker-1',
      toolSurface: 'claude-worker',
      workerMemoryToolExposure: 'read-write',
      cwd: '/mock/worktree/repo-a',
      sdkSessionId: 'sdk-1',
      authToken: 'secret-token',
      createdAt: Date.now(),
      hookHandler: jest.fn(),
    });
    const url = service.getCanopyWorktreeMcpUrl('worker-memory-session');

    const listResponse = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer secret-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(listResponse.status).toBe(200);
    expect(getListedToolNames(await listResponse.json())).toEqual([
      'SaveMemory',
      'SearchMemory',
      'ReadMemory',
    ]);

    const callResponse = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer secret-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 'worker-memory-call',
        method: 'tools/call',
        params: {
          name: 'SaveMemory',
          arguments: { text: 'Remember this.', scope: 'workspace' },
        },
      }),
    });

    expect(callResponse.status).toBe(200);
    await expect(callResponse.json()).resolves.toMatchObject({
      result: { content: [{ text: 'ok' }] },
    });
    expect(executedKey).toBe('save_memory');
    expect(executedArgs).toEqual({
      text: 'Remember this.',
      scope: 'workspace',
    });
    expect(executedOptions).toEqual({ toolUseId: 'worker-memory-call' });
    expect(isRecord(executedRuntime)).toBe(true);
    if (!isRecord(executedRuntime)) {
      throw new Error('Expected a worker Canopy tool runtime.');
    }
    expect(typeof executedRuntime.saveLocalMemory).toBe('function');
    expect(typeof executedRuntime.searchLocalMemory).toBe('function');
  });

  it('derives worker memory-tool exposure from the worker launch permission', () => {
    // No permission means the fully-permissive worker default.
    expect(resolveClaudeWorkerMemoryToolExposure(undefined)).toBe('read-write');
    // dangerous_all: unrestricted built-ins under bypass.
    expect(
      resolveClaudeWorkerMemoryToolExposure({
        permissionMode: 'bypassPermissions',
      }),
    ).toBe('read-write');
    // read_only: restricted built-in list enforces read-only by construction.
    expect(
      resolveClaudeWorkerMemoryToolExposure({
        permissionMode: 'bypassPermissions',
        tools: ['Read', 'Glob', 'Grep', 'NotebookRead'],
      }),
    ).toBe('read-only');
    // plan: read-only by mode even with an unrestricted tool list.
    expect(
      resolveClaudeWorkerMemoryToolExposure({ permissionMode: 'plan' }),
    ).toBe('read-only');
    // none / report-only helpers: no built-ins at all.
    expect(
      resolveClaudeWorkerMemoryToolExposure({
        permissionMode: 'bypassPermissions',
        tools: [],
      }),
    ).toBe('none');
  });

  it('gates worker memory tools by the route memory-tool exposure', async () => {
    const proxyPort = await getFreePort();
    await service.ensureStarted(proxyPort);
    const registerWorkerRoute = async (
      sessionKey: string,
      workerMemoryToolExposure?: 'read-write' | 'read-only' | 'none',
    ): Promise<void> => {
      await service.registerCanopyWorktreeSessionRoute({
        sessionKey,
        projectId: 'project-1',
        worktreeId: 'wt-1',
        chatId: sessionKey,
        toolSurface: 'claude-worker',
        ...(workerMemoryToolExposure ? { workerMemoryToolExposure } : {}),
        cwd: '/mock/worktree/repo-a',
        sdkSessionId: `sdk-${sessionKey}`,
        authToken: 'secret-token',
        createdAt: Date.now(),
        hookHandler: jest.fn(),
      });
    };
    const postJsonRpc = async (
      sessionKey: string,
      body: Record<string, unknown>,
    ): Promise<unknown> => {
      const response = await fetch(
        service.getCanopyWorktreeMcpUrl(sessionKey),
        {
          method: 'POST',
          headers: {
            Authorization: 'Bearer secret-token',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ jsonrpc: '2.0', ...body }),
        },
      );
      expect(response.status).toBe(200);
      return response.json();
    };
    const callTool = (sessionKey: string, name: string): Promise<unknown> =>
      postJsonRpc(sessionKey, {
        id: `${sessionKey}-${name}`,
        method: 'tools/call',
        params: { name, arguments: {} },
      });
    const listTools = async (sessionKey: string): Promise<string[]> =>
      getListedToolNames(
        await postJsonRpc(sessionKey, { id: 1, method: 'tools/list' }),
      );

    await registerWorkerRoute('worker-read-only', 'read-only');
    await registerWorkerRoute('worker-none', 'none');
    await registerWorkerRoute('worker-unspecified');

    // Read-only workers may search and read memory but never save it.
    expect(await listTools('worker-read-only')).toEqual([
      'SearchMemory',
      'ReadMemory',
    ]);
    await expect(
      callTool('worker-read-only', 'SaveMemory'),
    ).resolves.toMatchObject({
      error: { code: -32602 },
    });
    mockExecuteCanopyInjectedTool.mockResolvedValueOnce({ text: 'found' });
    await expect(
      callTool('worker-read-only', 'SearchMemory'),
    ).resolves.toMatchObject({
      result: { content: [{ text: 'found' }] },
    });
    mockExecuteCanopyInjectedTool.mockResolvedValueOnce({ text: 'content' });
    await expect(
      callTool('worker-read-only', 'ReadMemory'),
    ).resolves.toMatchObject({
      result: { content: [{ text: 'content' }] },
    });

    // Report-only / none workers get neither memory tool.
    expect(await listTools('worker-none')).toEqual([]);
    for (const name of ['SaveMemory', 'SearchMemory', 'ReadMemory']) {
      await expect(callTool('worker-none', name)).resolves.toMatchObject({
        error: { code: -32602 },
      });
    }

    // A worker route without an exposure fails closed.
    expect(await listTools('worker-unspecified')).toEqual([]);
    await expect(
      callTool('worker-unspecified', 'SaveMemory'),
    ).resolves.toMatchObject({
      error: { code: -32602 },
    });
  });

  it('does not acknowledge OpenCode reload delivery merely because HTTP wrote the result', async () => {
    await service.ensureStarted(await getFreePort());
    await service.registerCanopyWorktreeSessionRoute({
      sessionKey: 'opencode-delivery',
      projectId: 'project-1',
      worktreeId: 'wt-1',
      chatId: 'chat-1',
      toolSurface: 'opencode-acp',
      providerType: 'opencode',
      cwd: '/mock/workspace',
      authToken: 'secret-token',
      createdAt: Date.now(),
      hookHandler: jest.fn(),
    });
    const delivered = jest
      .spyOn(
        deferredToolsReloadCoordinator,
        'markToolResultDeliveredAndWaitForResume',
      )
      .mockResolvedValue(false);
    try {
      const response = await fetch(
        service.getCanopyWorktreeMcpUrl('opencode-delivery'),
        {
          method: 'POST',
          headers: {
            Authorization: 'Bearer secret-token',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 42,
            method: 'tools/call',
            params: { name: 'LoadDeferredTools', arguments: { items: [] } },
          }),
        },
      );
      await response.json();
      expect(delivered).not.toHaveBeenCalled();
    } finally {
      delivered.mockRestore();
    }
  });

  it('lists the cursor-acp surface without forks, graph, or deferred tools', async () => {
    await service.ensureStarted(await getFreePort());
    await service.registerCanopyWorktreeSessionRoute({
      sessionKey: 'cursor-session',
      projectId: 'project-1',
      worktreeId: 'wt-1',
      chatId: 'chat-1',
      toolSurface: 'cursor-acp',
      providerType: 'cursor',
      cwd: '/mock/workspace',
      authToken: 'secret-token',
      createdAt: Date.now(),
      hookHandler: jest.fn(),
    });
    const list = async (url: string): Promise<string[]> => {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer secret-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 'list',
          method: 'tools/list',
        }),
      });
      return getListedToolNames(await response.json());
    };
    const names = await list(service.getCanopyWorktreeMcpUrl('cursor-session'));
    expect(names).toEqual(
      expect.arrayContaining([
        'GetGitPreferences',
        'SaveMemory',
        'DispatchAction',
        'SetBaseBranch',
        'ScheduleWakeup',
      ]),
    );
    expect(names).not.toEqual(expect.arrayContaining(['GetCodeGraphContext']));
    expect(names).not.toEqual(expect.arrayContaining(['StartForkedAgent']));
    expect(names).not.toEqual(expect.arrayContaining(['StartBranchedAgent']));
    expect(names).not.toEqual(expect.arrayContaining(['LoadDeferredTools']));
    expect(names).not.toEqual(expect.arrayContaining(['AskUserQuestion']));
    expect(
      await list(service.getCanopyWorktreeUiMcpUrl('cursor-session')),
    ).toEqual(['AskUserQuestion']);
  });

  it.each([
    ['claude', 'native-sdk', true],
    ['cursor', 'cursor-acp', true],
    ['copilot', 'cursor-acp', false],
  ] as const)(
    'advertises ShowVisual only to eligible %s routes',
    async (providerType, toolSurface, eligible) => {
      mockIsEnabled.mockReturnValue(true);
      await service.ensureStarted(await getFreePort());
      await service.registerCanopyWorktreeSessionRoute({
        sessionKey: `visual-${providerType}`,
        projectId: 'project-1',
        worktreeId: 'wt-1',
        chatId: 'chat-1',
        providerType,
        toolSurface,
        cwd: '/mock/workspace',
        authToken: 'secret-token',
        createdAt: Date.now(),
        hookHandler: jest.fn(),
      });
      const response = await fetch(
        service.getCanopyWorktreeMcpUrl(`visual-${providerType}`),
        {
          method: 'POST',
          headers: {
            Authorization: 'Bearer secret-token',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
        },
      );
      expect(
        getListedToolNames(await response.json()).includes('ShowVisual'),
      ).toBe(eligible);
      const previewResponse = await fetch(
        service.getCanopyWorktreeMcpUrl(`visual-${providerType}`),
        {
          method: 'POST',
          headers: {
            Authorization: 'Bearer secret-token',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
        },
      );
      expect(
        getListedToolNames(await previewResponse.json()).includes(
          'PreviewVisual',
        ),
      ).toBe(eligible);
    },
  );

  it('hides and refuses ShowVisual when the flag is off', async () => {
    await service.ensureStarted(await getFreePort());
    await service.registerCanopyWorktreeSessionRoute({
      sessionKey: 'visual-flag-off',
      projectId: 'project-1',
      worktreeId: 'wt-1',
      chatId: 'chat-1',
      providerType: 'claude',
      toolSurface: 'native-sdk',
      cwd: '/mock/workspace',
      authToken: 'secret-token',
      createdAt: Date.now(),
      hookHandler: jest.fn(),
    });
    const url = service.getCanopyWorktreeMcpUrl('visual-flag-off');
    const post = async (body: object): Promise<unknown> => {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer secret-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, ...body }),
      });
      return response.json();
    };
    expect(
      getListedToolNames(await post({ method: 'tools/list' })).includes(
        'ShowVisual',
      ),
    ).toBe(false);
    expect(
      getListedToolNames(await post({ method: 'tools/list' })),
    ).not.toContain('PreviewVisual');
    expect(
      await post({
        method: 'tools/call',
        params: {
          name: 'ShowVisual',
          arguments: { html: '<html></html>', title: 'Test', height: 400 },
        },
      }),
    ).toMatchObject({ result: { isError: true } });
    expect(mockExecuteCanopyInjectedTool).not.toHaveBeenCalled();
    expect(
      await post({
        method: 'tools/call',
        params: { name: 'PreviewVisual', arguments: { html: '<html></html>' } },
      }),
    ).toMatchObject({ result: { isError: true } });
    expect(mockExecuteCanopyInjectedTool).not.toHaveBeenCalled();
  });

  it('lists the Cowork Cursor surface and refuses worktree-only tools on it', async () => {
    await service.ensureStarted(await getFreePort());
    await service.registerCanopyWorktreeSessionRoute({
      sessionKey: 'cursor-cowork-session',
      projectId: 'cowork-1',
      worktreeId: 'entry-1',
      chatId: 'chat-1',
      toolSurface: 'cursor-acp-standalone',
      providerType: 'cursor',
      cwd: '/mock/cowork',
      authToken: 'secret-token',
      createdAt: Date.now(),
      hookHandler: jest.fn(),
    });
    const postJsonRpc = async (body: object): Promise<unknown> => {
      const response = await fetch(
        service.getCanopyWorktreeMcpUrl('cursor-cowork-session'),
        {
          method: 'POST',
          headers: {
            Authorization: 'Bearer secret-token',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ jsonrpc: '2.0', ...body }),
        },
      );
      return response.json();
    };
    const names = getListedToolNames(
      await postJsonRpc({ id: 'list', method: 'tools/list' }),
    );
    // ShowVisual is listed only while its default-off flag is on.
    expect(new Set(names)).toEqual(
      new Set(
        CANOPY_INJECTED_TOOL_SURFACE_ALLOWLISTS['cursor-acp-standalone']
          .filter((key) => key !== 'show_visual' && key !== 'preview_visual')
          .map((key) => CANOPY_INJECTED_TOOL_REGISTRY[key].displayName),
      ),
    );
    expect(names).not.toContain('SetBaseBranch');
    expect(names).not.toContain('LoadDeferredTools');
    await expect(
      postJsonRpc({
        id: 'call',
        method: 'tools/call',
        params: { name: 'SetBaseBranch', arguments: {} },
      }),
    ).resolves.toMatchObject({ error: { code: -32602 } });
  });

  it.each([
    'native-sdk',
    'native-sdk-standalone',
    'claude-code-terminal',
    'cursor-acp',
    'cursor-acp-standalone',
  ] as const)(
    'dispatches the advertised ScheduleWakeup name on %s routes',
    async (toolSurface) => {
      await service.ensureStarted(await getFreePort());
      await service.registerCanopyWorktreeSessionRoute({
        sessionKey: 'wakeup-session',
        projectId: 'project-1',
        worktreeId: 'wt-1',
        chatId: 'chat-1',
        toolSurface,
        cwd: '/mock/workspace',
        authToken: 'secret-token',
        createdAt: Date.now(),
        hookHandler: jest.fn(),
      });
      const url = service.getCanopyWorktreeMcpUrl('wakeup-session');
      const request = async (method: string, params?: unknown) => {
        const response = await fetch(url, {
          method: 'POST',
          headers: {
            Authorization: 'Bearer secret-token',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ jsonrpc: '2.0', id: method, method, params }),
        });
        const payload: unknown = await response.json();
        return payload;
      };
      const names = getListedToolNames(await request('tools/list'));
      expect(names).toContain('ScheduleWakeup');
      const args = { delaySeconds: 60, followUpInstruction: 'Say hello.' };
      expect(
        await request('tools/call', {
          name: names.find((name) => name === 'ScheduleWakeup'),
          arguments: args,
        }),
      ).toMatchObject({ result: { content: [{ type: 'text', text: 'ok' }] } });
      expect(mockExecuteCanopyInjectedTool).toHaveBeenCalledWith(
        'schedule_wakeup',
        args,
        expect.objectContaining({
          worktreeWatcherRuntime: {
            projectId: 'project-1',
            worktreeId: 'wt-1',
            chatId: 'chat-1',
          },
        }),
        expect.anything(),
      );
      const call = mockExecuteCanopyInjectedTool.mock.calls.find(
        ([key]) => key === 'schedule_wakeup',
      );
      const context = call?.[3];
      expect(isRecord(context) && typeof context.toolUseId === 'string').toBe(
        true,
      );
    },
  );

  it.each([
    'native-sdk-standalone',
    'cursor-acp-standalone',
    'opencode-acp-standalone',
  ] as const)(
    'lists and dispatches WatchGitHubItems for the Cowork chat on %s routes',
    async (toolSurface) => {
      registerWorkspaceTypes(new Map([['cowork-1', 'cowork']]));
      try {
        await service.ensureStarted(await getFreePort());
        await service.registerCanopyWorktreeSessionRoute({
          sessionKey: 'cowork-github-session',
          projectId: 'cowork-1',
          worktreeId: 'entry-1',
          chatId: 'chat-a',
          toolSurface,
          cwd: '/mock/cowork',
          authToken: 'secret-token',
          createdAt: Date.now(),
          hookHandler: jest.fn(),
        });
        const url = service.getCanopyWorktreeMcpUrl('cowork-github-session');
        const request = async (method: string, params?: unknown) => {
          const response = await fetch(url, {
            method: 'POST',
            headers: {
              Authorization: 'Bearer secret-token',
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              jsonrpc: '2.0',
              id: method,
              method,
              params,
            }),
          });
          const payload: unknown = await response.json();
          return payload;
        };
        expect(getListedToolNames(await request('tools/list'))).toContain(
          'WatchGitHubItems',
        );
        const listing = await request('tools/list');
        if (
          !isRecord(listing) ||
          !isRecord(listing.result) ||
          !Array.isArray(listing.result.tools)
        )
          throw new Error('Expected the Cowork tool catalog');
        const actionTool: unknown = listing.result.tools.find(
          (tool: unknown) => isRecord(tool) && tool.name === 'DispatchAction',
        );
        expect(
          isRecord(actionTool) ? actionTool.inputSchema : undefined,
        ).toEqual(coworkDispatchActionJsonSchema);
        const args = {
          items: [{ kind: 'pull_request', repository: 'acme/api', number: 7 }],
        };
        expect(
          await request('tools/call', {
            name: 'WatchGitHubItems',
            arguments: args,
          }),
        ).toMatchObject({
          result: { content: [{ type: 'text', text: 'ok' }] },
        });
        const call = mockExecuteCanopyInjectedTool.mock.calls.find(
          ([key]) => key === 'watch_github_items',
        );
        expect(call?.[1]).toEqual(args);
        const runtime = call?.[2];
        expect(isRecord(runtime) && runtime.worktreeWatcherRuntime).toEqual({
          projectId: 'cowork-1',
          worktreeId: 'entry-1',
          chatId: 'chat-a',
        });
        expect(
          isRecord(runtime) && runtime.worktreeActionRuntime,
        ).toMatchObject({ cwd: '/mock/cowork', executionScope: 'directory' });
      } finally {
        registerWorkspaceTypes(new Map());
      }
    },
  );

  it.each([
    ['native-sdk', 'project-1'],
    ['claude-code-terminal', 'project-1'],
    ['cursor-acp', 'project-1'],
    ['copilot-sdk', 'project-1'],
    ['native-sdk-standalone', 'cowork-1'],
    ['cursor-acp-standalone', 'cowork-1'],
  ] as const)(
    'lists and dispatches GetGitHubPullRequestStatus on %s routes',
    async (toolSurface, projectId) => {
      registerWorkspaceTypes(new Map([['cowork-1', 'cowork']]));
      try {
        await service.ensureStarted(await getFreePort());
        const sessionKey = `pr-status-${toolSurface}`;
        await service.registerCanopyWorktreeSessionRoute({
          sessionKey,
          projectId,
          worktreeId: 'wt-1',
          chatId: 'chat-a',
          toolSurface,
          cwd: '/mock/worktree',
          authToken: 'secret-token',
          createdAt: Date.now(),
          hookHandler: jest.fn(),
        });
        const url = service.getCanopyWorktreeMcpUrl(sessionKey);
        const request = async (method: string, params?: unknown) => {
          const response = await fetch(url, {
            method: 'POST',
            headers: {
              Authorization: 'Bearer secret-token',
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              jsonrpc: '2.0',
              id: method,
              method,
              params,
            }),
          });
          const payload: unknown = await response.json();
          return payload;
        };
        expect(getListedToolNames(await request('tools/list'))).toContain(
          'GetGitHubPullRequestStatus',
        );
        const args = { pullRequest: 'acme/api#7' };
        expect(
          await request('tools/call', {
            name: 'GetGitHubPullRequestStatus',
            arguments: args,
          }),
        ).toMatchObject({
          result: { content: [{ type: 'text', text: 'ok' }] },
        });
        const call = mockExecuteCanopyInjectedTool.mock.calls.find(
          ([key]) => key === 'get_github_pull_request_status',
        );
        expect(call?.[1]).toEqual(args);
      } finally {
        registerWorkspaceTypes(new Map());
      }
    },
  );

  it.each([
    'native-sdk',
    'native-sdk-standalone',
    'claude-code-terminal',
  ] as const)(
    'does not install a duplicate WatchCommand approval gate on %s routes',
    async (toolSurface) => {
      await service.ensureStarted(await getFreePort());
      const sessionKey = `watch-command-${toolSurface}`;
      await service.registerCanopyWorktreeSessionRoute({
        sessionKey,
        projectId: 'project-1',
        worktreeId: 'wt-1',
        chatId: 'chat-1',
        toolSurface,
        cwd: '/mock/workspace',
        authToken: 'secret-token',
        createdAt: Date.now(),
        hookHandler: jest.fn(),
      });
      const response = await fetch(
        service.getCanopyWorktreeMcpUrl(sessionKey),
        {
          method: 'POST',
          headers: {
            Authorization: 'Bearer secret-token',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: sessionKey,
            method: 'tools/call',
            params: {
              name: 'WatchCommand',
              arguments: {
                command: 'echo ready',
                intervalSeconds: 5,
                maxAttempts: 1,
              },
            },
          }),
        },
      );
      expect(response.status).toBe(200);
      const call = mockExecuteCanopyInjectedTool.mock.calls.find(
        ([key]) => key === 'watch_command',
      );
      const runtime = call?.[2];
      expect(
        isRecord(runtime) &&
          typeof runtime.authorizeWatchCommand === 'undefined',
      ).toBe(true);
      expect(mockCreateApprovalSession).not.toHaveBeenCalled();
    },
  );

  it('confines a delegate route to its host-provided tools and transports the request ID', async () => {
    await service.ensureStarted(await getFreePort());
    const sessionKey = 'cursor-child';
    const invoke = jest.fn(() => Promise.resolve({ text: 'owned result' }));
    await service.registerCanopyWorktreeSessionRoute({
      sessionKey,
      projectId: 'project-1',
      worktreeId: 'wt-1',
      chatId: 'chat-1',
      toolSurface: 'cursor-acp',
      providerType: 'cursor',
      cwd: '/mock/workspace',
      authToken: 'child-token',
      createdAt: Date.now(),
      hookHandler: jest.fn(),
      managedDelegation: {
        exclusive: true,
        tools: [
          {
            name: 'GetDelegateOutput',
            description: 'Read child output',
            inputSchema: { type: 'object' },
          },
        ],
        invoke,
      },
    });
    const request = async (
      method: string,
      params?: unknown,
    ): Promise<unknown> => {
      const response = await fetch(
        service.getCanopyWorktreeMcpUrl(sessionKey),
        {
          method: 'POST',
          headers: {
            Authorization: 'Bearer child-token',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 'owned-call',
            method,
            params,
          }),
        },
      );
      return response.json();
    };
    expect(getListedToolNames(await request('tools/list'))).toEqual([
      'GetDelegateOutput',
    ]);
    await request('tools/call', {
      name: 'GetDelegateOutput',
      arguments: { delegationId: 'child' },
    });
    expect(invoke).toHaveBeenCalledWith(
      'GetDelegateOutput',
      { delegationId: 'child' },
      { requestId: 'owned-call' },
    );
    const denied = await request('tools/call', {
      name: 'DispatchAction',
      arguments: { action: { type: 'pipeline.run' } },
    });
    expect(JSON.stringify(denied)).toContain('not available');
    expect(mockExecuteCanopyInjectedTool).not.toHaveBeenCalled();
  });

  it('consults a route-provided tool-call gate before executing on cursor-acp routes', async () => {
    await service.ensureStarted(await getFreePort());
    const sessionKey = 'tool-gate-cursor-acp';
    const authorizeToolCall = jest.fn(
      (): Promise<boolean> => Promise.resolve(false),
    );
    await service.registerCanopyWorktreeSessionRoute({
      sessionKey,
      projectId: 'project-1',
      worktreeId: 'wt-1',
      chatId: 'chat-1',
      toolSurface: 'cursor-acp',
      providerType: 'cursor',
      cwd: '/mock/workspace',
      authToken: 'secret-token',
      createdAt: Date.now(),
      hookHandler: jest.fn(),
      authorizeToolCall,
    });
    const args = { command: 'echo ready', intervalSeconds: 5, maxAttempts: 1 };
    const call = async (): Promise<unknown> => {
      const response = await fetch(
        service.getCanopyWorktreeMcpUrl(sessionKey),
        {
          method: 'POST',
          headers: {
            Authorization: 'Bearer secret-token',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: sessionKey,
            method: 'tools/call',
            params: { name: 'WatchCommand', arguments: args },
          }),
        },
      );
      expect(response.status).toBe(200);
      return response.json();
    };
    const denied = await call();
    // The MCP request id travels along as the only correlation id the call has.
    expect(authorizeToolCall).toHaveBeenCalledWith('watch_command', args, {
      requestId: sessionKey,
    });
    expect(
      isRecord(denied) && isRecord(denied.result) && denied.result.isError,
    ).toBe(true);
    expect(JSON.stringify(denied)).toContain('WatchCommand was denied.');
    expect(mockExecuteCanopyInjectedTool).not.toHaveBeenCalled();
    authorizeToolCall.mockResolvedValue(true);
    await call();
    expect(mockExecuteCanopyInjectedTool).toHaveBeenCalledWith(
      'watch_command',
      args,
      expect.anything(),
      expect.anything(),
    );
  });

  it('refuses unqualified Cursor fork calls across transport retry ids', async () => {
    await service.ensureStarted(await getFreePort());
    const sessionKey = 'cursor-fork-unavailable';
    await service.registerCanopyWorktreeSessionRoute({
      sessionKey,
      projectId: 'project-1',
      worktreeId: 'wt-1',
      chatId: 'chat-1',
      sdkSessionId: 'cursor-fork-session',
      toolSurface: 'cursor-acp',
      providerType: 'cursor',
      cwd: '/mock/workspace',
      authToken: 'secret-token',
      createdAt: Date.now(),
      hookHandler: jest.fn(),
      authorizeToolCall: () => Promise.resolve(true),
      turnSignal: new AbortController().signal,
    });
    for (const id of [1, 2]) {
      const response = await fetch(
        service.getCanopyWorktreeMcpUrl(sessionKey),
        {
          method: 'POST',
          headers: {
            Authorization: 'Bearer secret-token',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id,
            method: 'tools/call',
            params: {
              name: 'StartForkedAgent',
              arguments: { followUpInstruction: 'Continue independently' },
            },
          }),
        },
      );
      const result: unknown = await response.json();
      expect(result).toMatchObject({ error: { code: -32602 } });
    }
    expect(mockExecuteCanopyInjectedTool).not.toHaveBeenCalled();
  });

  it('carries owning-turn cancellation through the production Cursor MCP action runtime', async () => {
    await service.ensureStarted(await getFreePort());
    const stop = new AbortController();
    const sessionKey = 'cursor-fork-stop';
    await service.registerCanopyWorktreeSessionRoute({
      sessionKey,
      projectId: 'project-1',
      worktreeId: 'wt-1',
      chatId: 'chat-1',
      sdkSessionId: 'cursor-fork-session',
      toolSurface: 'cursor-acp',
      providerType: 'cursor',
      cwd: '/mock/workspace',
      authToken: 'secret-token',
      createdAt: Date.now(),
      hookHandler: jest.fn(),
      authorizeToolCall: () => Promise.resolve(true),
      turnSignal: stop.signal,
    });
    let accepted = false;
    mockExecuteCanopyInjectedTool.mockImplementationOnce(
      async (_key, _args, runtime) => {
        const scope = isRecord(runtime)
          ? runtime.worktreeActionRuntime
          : undefined;
        if (!isRecord(scope) || !(scope.signal instanceof AbortSignal))
          throw new Error('Missing owning turn signal');
        await Promise.resolve();
        stop.abort(new Error('Parent stopped'));
        if (scope.signal.aborted)
          return { text: 'Parent stopped', isError: true };
        accepted = true;
        return { text: 'Child accepted' };
      },
    );
    const response = await fetch(service.getCanopyWorktreeMcpUrl(sessionKey), {
      method: 'POST',
      headers: {
        Authorization: 'Bearer secret-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 'fork-stop',
        method: 'tools/call',
        params: {
          name: 'WatchCommand',
          arguments: { command: 'npm test' },
        },
      }),
    });
    const result: unknown = await response.json();
    expect(JSON.stringify(result)).toContain('Parent stopped');
    expect(accepted).toBe(false);
  });

  it.each(['native-sdk', 'claude-code-terminal'] as const)(
    'defers automation ShowFiles through the real %s HTTP route',
    async (toolSurface) => {
      await service.ensureStarted(await getFreePort());
      await service.registerCanopyWorktreeSessionRoute({
        sessionKey: 'scheduled-files',
        projectId: 'project-1',
        worktreeId: 'wt-1',
        chatId: 'chat-1',
        toolSurface,
        cwd: '/mock/worktree',
        sdkSessionId: 'sdk-1',
        authToken: 'secret-token',
        createdAt: Date.now(),
        hookHandler: jest.fn(),
      });
      mockExecuteCanopyInjectedTool.mockImplementation(
        jest.requireActual<typeof InjectedToolCore>('../canopy-tools/core')
          .executeCanopyInjectedTool,
      );
      recordPresentationTurn(
        'project-1/wt-1/chat-1',
        'scheduled',
        'automation',
      );
      try {
        const response = await fetch(
          service.getCanopyWorktreeMcpUrl('scheduled-files'),
          {
            method: 'POST',
            headers: {
              Authorization: 'Bearer secret-token',
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              jsonrpc: '2.0',
              id: 'scheduled-files',
              method: 'tools/call',
              params: {
                name: 'ShowFiles',
                arguments: {
                  files: [{ path: 'state.json' }, { path: 'index.html' }],
                },
              },
            }),
          },
        );
        expect(response.status).toBe(200);
        const payload: unknown = await response.json();
        if (
          !isRecord(payload) ||
          !isRecord(payload.result) ||
          !Array.isArray(payload.result.content)
        )
          throw new Error('Missing MCP result');
        expect(payload.result.isError).not.toBe(true);
        const receipt: unknown = payload.result.content[0];
        if (!isRecord(receipt) || typeof receipt.text !== 'string')
          throw new Error('Missing ShowFiles receipt');
        expect(JSON.parse(receipt.text)).toMatchObject({
          presentation: 'deferred',
          reason: 'automation_turn',
          opened: 0,
          activated: false,
          deferred: 2,
        });
      } finally {
        clearPresentationTurn('project-1/wt-1/chat-1');
      }
    },
  );

  it('exposes the full native Canopy tool surface on native worktree MCP routes', async () => {
    const proxyPort = await getFreePort();
    await service.ensureStarted(proxyPort);
    await service.registerCanopyWorktreeSessionRoute({
      sessionKey: 'native-session',
      projectId: 'project-1',
      worktreeId: 'wt-1',
      chatId: 'chat-1',
      toolSurface: 'native-sdk',
      cwd: '/mock/worktree/repo-a',
      sdkSessionId: 'sdk-1',
      authToken: 'secret-token',
      createdAt: Date.now(),
      hookHandler: jest.fn(),
    });
    const url = service.getCanopyWorktreeMcpUrl('native-session');

    const listResponse = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer secret-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(listResponse.status).toBe(200);
    // AskUserQuestion has moved to the /ui path; the main native-sdk path no longer lists it.
    const listPayload = (await listResponse.json()) as {
      result?: { tools?: Array<{ name?: string }> };
    };
    const toolNames = listPayload.result?.tools?.map((t) => t.name) ?? [];
    expect(toolNames).not.toContain('AskUserQuestion');
    expect(toolNames).toEqual(
      expect.arrayContaining([
        'GetScriptOutput',
        'GetGitPreferences',
        'SaveMemory',
        'SearchMemory',
        'ReadMemory',
        'ReadPipelineYaml',
        'ShowFiles',
        'ShowCapabilities',
        'GetFileComments',
        'RespondToFileComment',
        'SearchActions',
        'DispatchAction',
        'SearchWatchers',
        'SetupWatchers',
        'WatchGitHubItems',
        'GetGitHubPullRequestStatus',
        'DeleteWatchers',
        'SetAutoArchive',
        'SetBaseBranch',
        'GetCodeGraphContext',
        'BuildOrUpdateCodeGraph',
        'QueryCodeGraph',
        'SearchCodeGraph',
        'ExplainCodeSymbol',
        'GetImpactRadius',
        'DetectChangedSymbols',
        'CompareChangeImpact',
        'GetReviewContext',
        'SearchDeferredTools',
        'LoadDeferredTools',
      ]),
    );
    expect(toolNames).toHaveLength(34);
    expect(toolNames).toEqual(
      expect.arrayContaining(['WatchCommand', 'ScheduleWakeup']),
    );

    const callResponse = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer secret-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 'script-call',
        method: 'tools/call',
        params: {
          name: 'GetScriptOutput',
          arguments: { scriptId: 'launch' },
        },
      }),
    });

    expect(callResponse.status).toBe(200);
    const executeCalls = mockExecuteCanopyInjectedTool.mock.calls;
    const executeCall = executeCalls[executeCalls.length - 1];
    expect(executeCall?.[0]).toBe('get_script_output');
    expect(executeCall?.[1]).toEqual({ scriptId: 'launch' });
    for (const [name, key] of [
      ['StartForkedAgent', 'start_forked_agent'],
      ['StartBranchedAgent', 'start_branched_agent'],
    ]) {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer secret-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: name,
          method: 'tools/call',
          params: {
            name,
            arguments: { followUpInstruction: 'Split off this task' },
          },
        }),
      });
      expect(response.status).toBe(200);
      await response.json();
      expect(mockExecuteCanopyInjectedTool).toHaveBeenLastCalledWith(
        key,
        { followUpInstruction: 'Split off this task' },
        expect.anything(),
        expect.anything(),
      );
      const splitAgentCall = executeCalls[executeCalls.length - 1];
      const splitAgentRuntime = splitAgentCall?.[2];
      expect(isRecord(splitAgentRuntime)).toBe(true);
      if (!isRecord(splitAgentRuntime)) {
        throw new Error('Expected an injected-tool runtime.');
      }
      expect(splitAgentRuntime.worktreeActionRuntime).toMatchObject({
        projectId: 'project-1',
        worktreeId: 'wt-1',
        chatId: 'chat-1',
      });
    }
  });

  it('omits the nine code-graph tools when the route was created without that capability', async () => {
    const proxyPort = await getFreePort();
    await service.ensureStarted(proxyPort);
    await service.registerCanopyWorktreeSessionRoute({
      sessionKey: 'native-session-off',
      projectId: 'project-1',
      worktreeId: 'wt-1',
      chatId: 'chat-1',
      toolSurface: 'native-sdk',
      cwd: '/mock/worktree/repo-a',
      sdkSessionId: 'sdk-1',
      authToken: 'secret-token',
      createdAt: Date.now(),
      hookHandler: jest.fn(),
      codeGraphToolsAdvertised: false,
    });
    const url = service.getCanopyWorktreeMcpUrl('native-session-off');

    const listResponse = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer secret-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(listResponse.status).toBe(200);
    const listPayload = (await listResponse.json()) as {
      result?: { tools?: Array<{ name?: string }> };
    };
    const toolNames = listPayload.result?.tools?.map((t) => t.name) ?? [];

    for (const name of [
      'GetCodeGraphContext',
      'BuildOrUpdateCodeGraph',
      'QueryCodeGraph',
      'SearchCodeGraph',
      'ExplainCodeSymbol',
      'GetImpactRadius',
      'DetectChangedSymbols',
      'CompareChangeImpact',
      'GetReviewContext',
    ]) {
      expect(toolNames).not.toContain(name);
    }
    // The other injected tools are unaffected.
    expect(toolNames).toEqual(
      expect.arrayContaining([
        'GetScriptOutput',
        'GetGitPreferences',
        'SaveMemory',
        'SearchMemory',
        'ReadMemory',
        'ReadPipelineYaml',
        'ShowFiles',
        'ShowCapabilities',
        'GetFileComments',
        'RespondToFileComment',
        'SearchActions',
        'DispatchAction',
        'SearchWatchers',
        'SetupWatchers',
        'WatchGitHubItems',
        'GetGitHubPullRequestStatus',
        'DeleteWatchers',
        'SetAutoArchive',
        'SetBaseBranch',
        'SearchDeferredTools',
        'LoadDeferredTools',
      ]),
    );
    expect(toolNames).toHaveLength(25);

    const callResponse = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer secret-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 'hidden-code-graph-call',
        method: 'tools/call',
        params: {
          name: 'QueryCodeGraph',
          arguments: { mode: 'callers', target: 'src/foo.ts::Bar' },
        },
      }),
    });
    expect(callResponse.status).toBe(200);
    await expect(callResponse.json()).resolves.toMatchObject({
      id: 'hidden-code-graph-call',
      result: {
        content: [
          {
            type: 'text',
            text: 'Code graph tools are not available for this project.',
          },
        ],
        isError: true,
      },
    });
    expect(mockExecuteCanopyInjectedTool).not.toHaveBeenCalled();
  });

  it('serves AskUserQuestion only on the /ui path for native-sdk routes', async () => {
    const proxyPort = await getFreePort();
    await service.ensureStarted(proxyPort);
    await service.registerCanopyWorktreeSessionRoute({
      sessionKey: 'native-ui-session',
      projectId: 'project-1',
      worktreeId: 'wt-1',
      chatId: 'chat-1',
      toolSurface: 'native-sdk',
      cwd: '/mock/worktree/repo-a',
      sdkSessionId: 'sdk-ui-1',
      authToken: 'ui-token',
      createdAt: Date.now(),
      hookHandler: jest.fn(),
    });
    const baseUrl = service.getCanopyWorktreeMcpUrl('native-ui-session');
    const uiUrl = service.getCanopyWorktreeUiMcpUrl('native-ui-session');

    // base path does NOT include AskUserQuestion
    const baseListResponse = await fetch(baseUrl, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ui-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(baseListResponse.status).toBe(200);
    const baseListPayload = (await baseListResponse.json()) as {
      result?: { tools?: Array<{ name?: string }> };
    };
    expect(baseListPayload.result?.tools?.map((t) => t.name)).not.toContain(
      'AskUserQuestion',
    );

    // /ui path returns ONLY AskUserQuestion
    const uiListResponse = await fetch(uiUrl, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ui-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
    });
    expect(uiListResponse.status).toBe(200);
    const uiListPayload = (await uiListResponse.json()) as {
      result?: { tools?: Array<{ name?: string }> };
    };
    const uiToolNames = uiListPayload.result?.tools?.map((t) => t.name) ?? [];
    expect(uiToolNames).toEqual(['AskUserQuestion']);

    // calling the advertised AskUserQuestion tool on /ui path dispatches through executeCanopyInjectedTool
    const callResponse = await fetch(uiUrl, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ui-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 'ask-ui-call',
        method: 'tools/call',
        params: {
          name: 'AskUserQuestion',
          arguments: {
            questions: [{ question: 'Continue?', options: ['Yes', 'No'] }],
          },
        },
      }),
    });
    expect(callResponse.status).toBe(200);
    const executeCalls = mockExecuteCanopyInjectedTool.mock.calls;
    const executeCall = executeCalls[executeCalls.length - 1];
    expect(executeCall?.[0]).toBe('ask_user_question');
    expect(executeCall?.[1]).toEqual({
      questions: [{ question: 'Continue?', options: ['Yes', 'No'] }],
    });
    const executeRuntime = executeCall?.[2];
    expect(isRecord(executeRuntime)).toBe(true);
    if (!isRecord(executeRuntime)) {
      throw new Error('Expected an injected-tool runtime.');
    }
    expect(executeRuntime.requestUserAnswers).toEqual(expect.any(Function));
    // The JSON-RPC id belongs to the MCP transport, not Claude's transcript
    // tool_use block. Claude questions deliberately omit a projected id so
    // the renderer/browser uses the first-unanswered matching heuristic, while
    // the streaming transport still supplies its cancellation signal.
    const executeContext = executeCall?.[3];
    expect(isRecord(executeContext)).toBe(true);
    if (!isRecord(executeContext)) {
      throw new Error('Expected an injected-tool context.');
    }
    expect(executeContext.signal).toBeInstanceOf(AbortSignal);
    expect(executeContext.toolUseId).toBeUndefined();
  });

  it('reports the _ui server identity on initialize for the /ui path', async () => {
    const proxyPort = await getFreePort();
    await service.ensureStarted(proxyPort);
    await service.registerCanopyWorktreeSessionRoute({
      sessionKey: 'native-init-session',
      projectId: 'project-1',
      worktreeId: 'wt-1',
      chatId: 'chat-1',
      toolSurface: 'native-sdk',
      cwd: '/mock/worktree/repo-a',
      sdkSessionId: 'sdk-init-1',
      authToken: 'init-token',
      createdAt: Date.now(),
      hookHandler: jest.fn(),
    });
    const baseUrl = service.getCanopyWorktreeMcpUrl('native-init-session');
    const uiUrl = service.getCanopyWorktreeUiMcpUrl('native-init-session');
    const initialize = {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
    };
    const headers = {
      Authorization: 'Bearer init-token',
      'Content-Type': 'application/json',
    };

    const baseResponse = await fetch(baseUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(initialize),
    });
    const basePayload = (await baseResponse.json()) as {
      result?: { serverInfo?: { name?: string } };
    };
    expect(basePayload.result?.serverInfo?.name).toBe('canopy');

    const uiResponse = await fetch(uiUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(initialize),
    });
    const uiPayload = (await uiResponse.json()) as {
      result?: { serverInfo?: { name?: string } };
    };
    expect(uiPayload.result?.serverInfo?.name).toBe('canopy_ui');
  });

  it('streams the /ui tools/call as SSE even without an event-stream Accept header', async () => {
    const proxyPort = await getFreePort();
    await service.ensureStarted(proxyPort);
    await service.registerCanopyWorktreeSessionRoute({
      sessionKey: 'native-sse-session',
      projectId: 'project-1',
      worktreeId: 'wt-1',
      chatId: 'chat-1',
      toolSurface: 'native-sdk',
      cwd: '/mock/worktree/repo-a',
      sdkSessionId: 'sdk-sse-1',
      authToken: 'sse-token',
      createdAt: Date.now(),
      hookHandler: jest.fn(),
    });
    const uiUrl = service.getCanopyWorktreeUiMcpUrl('native-sse-session');

    const response = await fetch(uiUrl, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer sse-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 'sse-call',
        method: 'tools/call',
        params: {
          name: 'AskUserQuestion',
          arguments: {
            questions: [{ question: 'Continue?', options: ['Yes', 'No'] }],
          },
        },
      }),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    const body = await response.text();
    const dataLine = body.split('\n').find((line) => line.startsWith('data: '));
    expect(dataLine).toBeDefined();
    const message = JSON.parse((dataLine ?? '').slice('data: '.length)) as {
      id?: string;
      result?: { content?: Array<{ text?: string }> };
    };
    expect(message.id).toBe('sse-call');
    expect(message.result?.content?.[0]?.text).toBe('ok');
  });

  it('emits MCP progress notifications on /ui SSE tool calls when a progress token is provided', async () => {
    const realSetInterval = global.setInterval;
    const realClearInterval = global.clearInterval;
    const intervalHandles: NodeJS.Timeout[] = [];
    const setIntervalMock: (
      callback: (...args: unknown[]) => void,
      delay?: number,
      ...args: unknown[]
    ) => NodeJS.Timeout = (callback, delay, ...args) => {
      const effectiveDelay = delay === 240_000 ? 1 : delay;
      const handle = realSetInterval(callback, effectiveDelay, ...args);
      intervalHandles.push(handle);
      return handle;
    };
    const setIntervalSpy = jest
      .spyOn(global, 'setInterval')
      .mockImplementation(setIntervalMock);
    let response: IncomingMessage | undefined;
    let finishTool: ((result: { text: string }) => void) | undefined;

    try {
      const proxyPort = await getFreePort();
      await service.ensureStarted(proxyPort);
      await service.registerCanopyWorktreeSessionRoute({
        sessionKey: 'native-sse-progress-session',
        projectId: 'project-1',
        worktreeId: 'wt-1',
        chatId: 'chat-1',
        toolSurface: 'native-sdk',
        cwd: '/mock/worktree/repo-a',
        sdkSessionId: 'sdk-sse-progress-1',
        authToken: 'sse-progress-token',
        createdAt: Date.now(),
        hookHandler: jest.fn(),
      });
      mockExecuteCanopyInjectedTool.mockReturnValueOnce(
        new Promise<{ text: string }>((resolve) => {
          finishTool = resolve;
        }),
      );

      const uiUrl = new URL(
        service.getCanopyWorktreeUiMcpUrl('native-sse-progress-session'),
      );
      response = await new Promise<IncomingMessage>((resolve, reject) => {
        const req = httpRequest(
          {
            host: uiUrl.hostname,
            port: Number(uiUrl.port),
            path: uiUrl.pathname,
            method: 'POST',
            headers: {
              Authorization: 'Bearer sse-progress-token',
              'Content-Type': 'application/json',
            },
          },
          resolve,
        );
        req.on('error', reject);
        req.end(
          JSON.stringify({
            jsonrpc: '2.0',
            id: 'sse-progress-call',
            method: 'tools/call',
            params: {
              name: 'AskUserQuestion',
              _meta: { progressToken: 'ask-progress-token' },
              arguments: {
                questions: [{ question: 'Continue?', options: ['Yes', 'No'] }],
              },
            },
          }),
        );
      });

      const chunks: string[] = [];
      response.setEncoding('utf8');
      response.on('data', (chunk: string) => {
        chunks.push(chunk);
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toContain('text/event-stream');
      expect(setIntervalSpy).toHaveBeenCalledWith(
        expect.any(Function),
        240_000,
      );
      await wait(25);

      const body = chunks.join('');
      expect(body).toContain(': keepalive\n\n');
      const progressLine = body
        .split('\n')
        .find((line) => line.startsWith('data: '));
      expect(progressLine).toBeDefined();
      const progressMessage: unknown = JSON.parse(
        (progressLine ?? '').slice('data: '.length),
      );
      expect(isProgressNotificationMessage(progressMessage)).toBe(true);
      if (!isProgressNotificationMessage(progressMessage)) {
        throw new Error('Expected progress notification message.');
      }
      expect(progressMessage).toEqual({
        jsonrpc: '2.0',
        method: 'notifications/progress',
        params: {
          progressToken: 'ask-progress-token',
          progress: 1,
          message: 'Waiting for user response',
        },
      });

      const ended = new Promise<void>((resolve) => {
        response?.once('end', resolve);
      });
      finishTool?.({ text: 'ok' });
      await ended;
    } finally {
      response?.destroy();
      setIntervalSpy.mockRestore();
      for (const handle of intervalHandles) {
        realClearInterval(handle);
      }
    }
  });

  it('expires a pending ask-user card when a /ui SSE client disconnects', async () => {
    const proxyPort = await getFreePort();
    await service.ensureStarted(proxyPort);
    const send = jest.fn<void, [string, unknown]>();
    service.setWindowAccessor(
      () =>
        ({
          isDestroyed: jest.fn(() => false),
          webContents: {
            isDestroyed: jest.fn(() => false),
            isCrashed: jest.fn(() => false),
            mainFrame: {
              isDestroyed: jest.fn(() => false),
              detached: false,
            },
            send,
          },
        }) as never,
    );
    await service.registerCanopyWorktreeSessionRoute({
      sessionKey: 'native-sse-close-session',
      projectId: 'project-1',
      worktreeId: 'wt-1',
      chatId: 'chat-1',
      toolSurface: 'native-sdk',
      cwd: '/mock/worktree/repo-a',
      sdkSessionId: 'sdk-sse-close-1',
      authToken: 'sse-close-token',
      createdAt: Date.now(),
      hookHandler: jest.fn(),
    });
    mockExecuteCanopyInjectedTool.mockImplementationOnce(
      (
        _key,
        _args,
        runtime: {
          requestUserAnswers: (
            questions: Array<{ question: string; options: string[] }>,
          ) => Promise<unknown>;
        },
      ) =>
        runtime.requestUserAnswers([
          { question: 'Continue?', options: ['Yes', 'No'] },
        ]),
    );

    const uiUrl = new URL(
      service.getCanopyWorktreeUiMcpUrl('native-sse-close-session'),
    );
    const response = await new Promise<IncomingMessage>((resolve, reject) => {
      const req = httpRequest(
        {
          host: uiUrl.hostname,
          port: Number(uiUrl.port),
          path: uiUrl.pathname,
          method: 'POST',
          headers: {
            Authorization: 'Bearer sse-close-token',
            'Content-Type': 'application/json',
          },
        },
        resolve,
      );
      req.on('error', reject);
      req.end(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 'sse-close-call',
          method: 'tools/call',
          params: {
            name: 'AskUserQuestion',
            arguments: {
              questions: [{ question: 'Continue?', options: ['Yes', 'No'] }],
            },
          },
        }),
      );
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/event-stream');
    response.destroy();

    const expireCall = await waitForMockCall(
      send,
      ([channel]) => channel === 'mcp:expire-user',
    );
    expect(expireCall).toBeDefined();
    const expirePayload = expireCall?.[1];
    expect(isRecord(expirePayload)).toBe(true);
    if (!isRecord(expirePayload)) {
      throw new Error('Expected expire payload');
    }
    expect(typeof expirePayload.requestId).toBe('string');
  });

  it.each(['Stop', 'disconnect'])(
    'expires a pending Cursor Pipeline Assistant question on %s',
    async (reason) => {
      await service.ensureStarted(await getFreePort());
      const stop = new AbortController();
      const send = jest.fn<void, [string, unknown]>();
      const getWindow = (): BrowserWindow =>
        ({
          isDestroyed: () => false,
          webContents: {
            isDestroyed: () => false,
            isCrashed: () => false,
            mainFrame: { isDestroyed: () => false, detached: false },
            send,
          },
        }) as unknown as BrowserWindow;
      const runtime = createPipelineEditorToolRuntime(
        { getMainWindow: getWindow },
        {
          projectId: 'project-1',
          worktreeId: 'wt-1',
          chatId: 'chat-1',
          providerType: 'cursor',
        },
      );
      await service.registerCanopyWorktreeSessionRoute({
        sessionKey: 'cursor-pipeline-question',
        projectId: 'project-1',
        worktreeId: 'wt-1',
        chatId: 'chat-1',
        assistantMode: 'pipeline-editor',
        providerType: 'cursor',
        authToken: 'pipeline-question-token',
        createdAt: Date.now(),
        hookHandler: jest.fn(),
        authorizeToolCall: () => Promise.resolve(true),
        turnSignal: stop.signal,
        pipelineEditorRuntime: runtime,
      });
      mockExecuteCanopyInjectedTool.mockImplementationOnce(
        (_key, _args, _runtime, context) =>
          runtime
            .requestUserAnswers(
              [{ question: 'Continue?', options: ['Yes', 'No'] }],
              {
                signal:
                  isRecord(context) && context.signal instanceof AbortSignal
                    ? context.signal
                    : undefined,
              },
            )
            .then(
              () => ({ text: 'answered' }),
              () => ({ text: 'cancelled', isError: true }),
            ),
      );
      const url = new URL(
        service.getCanopyWorktreeUiMcpUrl('cursor-pipeline-question'),
      );
      let response: IncomingMessage | undefined;
      try {
        response = await new Promise<IncomingMessage>((resolve, reject) => {
          const request = httpRequest(
            {
              host: url.hostname,
              port: Number(url.port),
              path: url.pathname,
              method: 'POST',
              headers: {
                Authorization: 'Bearer pipeline-question-token',
                'Content-Type': 'application/json',
              },
            },
            resolve,
          );
          request.on('error', reject);
          request.end(
            JSON.stringify({
              jsonrpc: '2.0',
              id: 1,
              method: 'tools/call',
              params: {
                name: 'AskUserQuestion',
                arguments: {
                  questions: [
                    { question: 'Continue?', options: ['Yes', 'No'] },
                  ],
                },
              },
            }),
          );
        });
        expect(
          await waitForMockCall(
            send,
            ([channel]) => channel === 'mcp:ask-user',
          ),
        ).toBeDefined();
        if (reason === 'Stop') stop.abort(new Error('Parent stopped'));
        else response.destroy();
        expect(
          await waitForMockCall(
            send,
            ([channel]) => channel === 'mcp:expire-user',
          ),
        ).toBeDefined();
        expect(mockConsumePendingQuestion).toHaveBeenCalled();
      } finally {
        rejectAllForSession('project-1/wt-1/chat-1');
        response?.destroy();
      }
    },
  );

  it('aborts a pending base-branch request when its SSE client disconnects', async () => {
    const proxyPort = await getFreePort();
    await service.ensureStarted(proxyPort);
    await service.registerCanopyWorktreeSessionRoute({
      sessionKey: 'native-base-branch-close-session',
      projectId: 'project-1',
      worktreeId: 'wt-1',
      chatId: 'chat-1',
      toolSurface: 'native-sdk',
      cwd: '/mock/worktree/repo-a',
      sdkSessionId: 'sdk-base-branch-close-1',
      authToken: 'base-branch-close-token',
      createdAt: Date.now(),
      hookHandler: jest.fn(),
    });
    let receivedSignal: AbortSignal | undefined;
    mockExecuteCanopyInjectedTool.mockImplementationOnce(
      (_key, _args, _runtime, context?: { signal?: AbortSignal }) => {
        receivedSignal = context?.signal;
        return new Promise((resolve) => {
          context?.signal?.addEventListener(
            'abort',
            () => resolve({ text: 'cancelled' }),
            { once: true },
          );
        });
      },
    );

    const mcpUrl = new URL(
      service.getCanopyWorktreeMcpUrl('native-base-branch-close-session'),
    );
    let clientRequest: ReturnType<typeof httpRequest> | undefined;
    let response: IncomingMessage | undefined;
    try {
      const responsePromise = new Promise<IncomingMessage>(
        (resolve, reject) => {
          const req = httpRequest(
            {
              host: mcpUrl.hostname,
              port: Number(mcpUrl.port),
              path: mcpUrl.pathname,
              method: 'POST',
              headers: {
                Authorization: 'Bearer base-branch-close-token',
                'Content-Type': 'application/json',
              },
            },
            resolve,
          );
          clientRequest = req;
          req.on('error', reject);
          req.end(
            JSON.stringify({
              jsonrpc: '2.0',
              id: 'base-branch-close-call',
              method: 'tools/call',
              params: {
                name: 'SetBaseBranch',
                arguments: { baseBranch: 'release/next' },
              },
            }),
          );
        },
      );
      void responsePromise.catch(() => undefined);

      const toolCall = await waitForMockCall(
        mockExecuteCanopyInjectedTool,
        ([key]) => key === 'set_base_branch',
      );
      expect(toolCall).toBeDefined();
      expect(receivedSignal).toBeDefined();
      expect(receivedSignal?.aborted).toBe(false);

      response = await responsePromise;
      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toContain('text/event-stream');
      response.destroy();

      const deadline = Date.now() + 1_000;
      while (!receivedSignal?.aborted && Date.now() < deadline) {
        await wait(10);
      }
      expect(receivedSignal?.aborted).toBe(true);
    } finally {
      response?.destroy();
      clientRequest?.destroy();
    }
  });

  it('splits AskUserQuestion onto the /ui path for app-advisor routes', async () => {
    const proxyPort = await getFreePort();
    await service.ensureStarted(proxyPort);
    const appAdvisorRuntime = {
      getWindow: jest.fn(() => null),
      projectId: 'project-1',
      worktreeId: 'wt-1',
      chatId: 'chat-1',
      sessionKey: 'advisor-ui-session',
    };
    const mockExecuteAppAdvisorTool = jest
      .fn()
      .mockResolvedValue({ text: 'ok' });
    // We rely on the app-advisor branch calling executeAppAdvisorTool which is already
    // mocked at the module level via jest.mock; instead validate tools/list shape.
    await service.registerCanopyWorktreeSessionRoute({
      sessionKey: 'advisor-ui-session',
      projectId: 'project-1',
      worktreeId: 'wt-1',
      chatId: 'chat-1',
      assistantMode: 'app-advisor',
      sdkSessionId: 'sdk-advisor-1',
      authToken: 'advisor-token',
      createdAt: Date.now(),
      hookHandler: jest.fn(),
      appAdvisorRuntime,
    });
    void mockExecuteAppAdvisorTool; // referenced for clarity; actual calls go through the module mock

    const baseUrl = service.getCanopyWorktreeMcpUrl('advisor-ui-session');
    const uiUrl = service.getCanopyWorktreeUiMcpUrl('advisor-ui-session');

    // base app-advisor path does NOT include AskUserQuestion
    const baseListResponse = await fetch(baseUrl, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer advisor-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 10, method: 'tools/list' }),
    });
    expect(baseListResponse.status).toBe(200);
    const baseListPayload = (await baseListResponse.json()) as {
      result?: { tools?: Array<{ name?: string }> };
    };
    const baseToolNames =
      baseListPayload.result?.tools?.map((t) => t.name) ?? [];
    expect(baseToolNames).not.toContain('AskUserQuestion');
    expect(baseToolNames).toContain('ShowFiles');
    expect(baseToolNames).toContain('SetAutoArchive');
    expect(baseToolNames).toContain('GetGitHubPullRequestStatus');
    expect(baseToolNames.length).toBeGreaterThan(0);

    // /ui app-advisor path returns ONLY AskUserQuestion
    const uiListResponse = await fetch(uiUrl, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer advisor-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 11, method: 'tools/list' }),
    });
    expect(uiListResponse.status).toBe(200);
    const uiListPayload = (await uiListResponse.json()) as {
      result?: { tools?: Array<{ name?: string }> };
    };
    const uiToolNames = uiListPayload.result?.tools?.map((t) => t.name) ?? [];
    expect(uiToolNames).toEqual(['AskUserQuestion']);
  });

  it('lists StartForkedAgent only for App Advisor routes whose runtime can fork', async () => {
    const proxyPort = await getFreePort();
    await service.ensureStarted(proxyPort);
    const listTools = async (sessionKey: string): Promise<string[]> => {
      const response = await fetch(
        service.getCanopyWorktreeMcpUrl(sessionKey),
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${sessionKey}-token`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
        },
      );
      const payload = (await response.json()) as {
        result?: { tools?: Array<{ name?: string }> };
      };
      return (payload.result?.tools ?? []).flatMap((tool) =>
        tool.name ? [tool.name] : [],
      );
    };
    for (const [sessionKey, canFork] of [
      ['advisor-native-fork', true],
      ['advisor-terminal-fork', false],
    ] as const) {
      await service.registerCanopyWorktreeSessionRoute({
        sessionKey,
        projectId: 'project-1',
        worktreeId: 'wt-1',
        chatId: 'chat-1',
        assistantMode: 'app-advisor',
        providerType: 'claude',
        sdkSessionId: `sdk-${sessionKey}`,
        authToken: `${sessionKey}-token`,
        createdAt: Date.now(),
        hookHandler: jest.fn(),
        appAdvisorRuntime: {
          getWindow: jest.fn(() => null),
          projectId: 'project-1',
          worktreeId: 'wt-1',
          chatId: 'chat-1',
          sessionKey,
          ...(canFork ? { startForkedAgent: jest.fn() } : {}),
        },
      });
    }

    expect(await listTools('advisor-native-fork')).toContain(
      'StartForkedAgent',
    );
    const terminalTools = await listTools('advisor-terminal-fork');
    expect(terminalTools).toContain('ShowFiles');
    expect(terminalTools).not.toContain('StartForkedAgent');
  });

  it('dispatches AskUserQuestion tools/call on the app-advisor /ui route to executeAppAdvisorTool', async () => {
    const proxyPort = await getFreePort();
    await service.ensureStarted(proxyPort);
    const appAdvisorRuntime = {
      getWindow: jest.fn(() => null),
      projectId: 'project-1',
      worktreeId: 'wt-1',
      chatId: 'chat-1',
      sessionKey: 'advisor-call-session',
    };
    await service.registerCanopyWorktreeSessionRoute({
      sessionKey: 'advisor-call-session',
      projectId: 'project-1',
      worktreeId: 'wt-1',
      chatId: 'chat-1',
      assistantMode: 'app-advisor',
      sdkSessionId: 'sdk-advisor-call-1',
      authToken: 'advisor-call-token',
      createdAt: Date.now(),
      hookHandler: jest.fn(),
      appAdvisorRuntime,
    });
    const uiUrl = service.getCanopyWorktreeUiMcpUrl('advisor-call-session');

    const callResponse = await fetch(uiUrl, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer advisor-call-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 'advisor-ask-call',
        method: 'tools/call',
        params: {
          name: 'AskUserQuestion',
          arguments: {
            questions: [{ question: 'Proceed?', options: ['Yes', 'No'] }],
          },
        },
      }),
    });

    expect(callResponse.status).toBe(200);
    expect(callResponse.headers.get('content-type')).toContain(
      'text/event-stream',
    );
    const body = await callResponse.text();
    const dataLine = body.split('\n').find((line) => line.startsWith('data: '));
    expect(dataLine).toBeDefined();
    const message: unknown = JSON.parse(
      (dataLine ?? '').slice('data: '.length),
    );
    expect(message).toMatchObject({
      jsonrpc: '2.0',
      id: 'advisor-ask-call',
      result: {
        content: [{ type: 'text', text: 'ok' }],
      },
    });
    const executeCalls = mockExecuteCanopyInjectedTool.mock.calls;
    const executeCall = executeCalls[executeCalls.length - 1];
    expect(executeCall?.[0]).toBe('ask_user_question');
    expect(executeCall?.[1]).toEqual({
      questions: [{ question: 'Proceed?', options: ['Yes', 'No'] }],
    });
    expect(executeCall?.[2]).toBe(appAdvisorRuntime);
    const executeContext = executeCall?.[3];
    expect(isRecord(executeContext)).toBe(true);
    if (!isRecord(executeContext)) {
      throw new Error('Expected an App Advisor tool context.');
    }
    // Without a Claude tool use ID the route nonce namespaces the JSON-RPC id.
    expect(executeContext.toolUseId).toEqual(
      expect.stringMatching(/^[0-9a-f-]{36}:advisor-ask-call$/),
    );
    expect(executeContext.signal).toBeInstanceOf(AbortSignal);
  });

  it.each(['cursor', 'copilot'] as const)(
    'omits the deferred-tool loaders from a %s App Advisor route that disallows them',
    async (providerType) => {
      await service.ensureStarted(await getFreePort());
      const list = async (sessionKey: string): Promise<string[]> => {
        const response = await fetch(
          service.getCanopyWorktreeMcpUrl(sessionKey),
          {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${sessionKey}-token`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              jsonrpc: '2.0',
              id: 1,
              method: 'tools/list',
            }),
          },
        );
        return getListedToolNames(await response.json());
      };
      await service.registerCanopyWorktreeSessionRoute({
        sessionKey: 'advisor-cursor-list',
        projectId: 'project-1',
        worktreeId: 'wt-1',
        chatId: 'chat-1',
        assistantMode: 'app-advisor',
        providerType,
        deferredToolsAllowed: false,
        sdkSessionId: 'sdk-advisor-cursor-list',
        authToken: 'advisor-cursor-list-token',
        createdAt: Date.now(),
        hookHandler: jest.fn(),
        appAdvisorRuntime: { watchCommand: jest.fn() },
      });
      const cursorTools = await list('advisor-cursor-list');
      expect(cursorTools).toContain('SearchActions');
      expect(cursorTools).not.toContain('SearchDeferredTools');
      expect(cursorTools).not.toContain('LoadDeferredTools');
      // Claude App Advisor routes keep advertising the loaders; the runtime
      // answers a disallowed call with guidance instead.
      await service.registerCanopyWorktreeSessionRoute({
        sessionKey: 'advisor-claude-list',
        projectId: 'project-1',
        worktreeId: 'wt-1',
        chatId: 'chat-1',
        assistantMode: 'app-advisor',
        providerType: 'claude',
        deferredToolsAllowed: false,
        sdkSessionId: 'sdk-advisor-claude-list',
        authToken: 'advisor-claude-list-token',
        createdAt: Date.now(),
        hookHandler: jest.fn(),
        appAdvisorRuntime: { watchCommand: jest.fn() },
      });
      expect(await list('advisor-claude-list')).toContain('LoadDeferredTools');
    },
  );

  it.each(['copilot-sdk', 'copilot-sdk-standalone'] as const)(
    'honors Copilot deferred opt-out in the %s advertised tool table',
    async (toolSurface) => {
      await service.ensureStarted(await getFreePort());
      for (const allowed of [false, true]) {
        const sessionKey = `copilot-policy-${toolSurface}-${allowed}`;
        await service.registerCanopyWorktreeSessionRoute({
          sessionKey,
          projectId: 'project-1',
          worktreeId: 'wt-1',
          chatId: 'chat-1',
          providerType: 'copilot',
          toolSurface,
          deferredToolsAllowed: allowed,
          sdkSessionId: sessionKey,
          authToken: 'copilot-policy-token',
          createdAt: Date.now(),
          hookHandler: jest.fn(),
        });
        const response = await fetch(
          service.getCanopyWorktreeMcpUrl(sessionKey),
          {
            method: 'POST',
            headers: {
              Authorization: 'Bearer copilot-policy-token',
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              jsonrpc: '2.0',
              id: 1,
              method: 'tools/list',
            }),
          },
        );
        const names = getListedToolNames(await response.json());
        expect(names).toContain('SearchActions');
        expect(names.includes('SearchDeferredTools')).toBe(allowed);
        expect(names.includes('LoadDeferredTools')).toBe(allowed);
      }
    },
  );

  it('answers a throwing App Advisor gate with a JSON-RPC error instead of dropping the request', async () => {
    await service.ensureStarted(await getFreePort());
    await service.registerCanopyWorktreeSessionRoute({
      sessionKey: 'advisor-gate-throws',
      projectId: 'project-1',
      worktreeId: 'wt-1',
      chatId: 'chat-1',
      assistantMode: 'app-advisor',
      sdkSessionId: 'sdk-advisor-gate-throws',
      authToken: 'advisor-gate-throws-token',
      createdAt: Date.now(),
      hookHandler: jest.fn(),
      appAdvisorRuntime: { watchCommand: jest.fn() },
      authorizeToolCall: (): Promise<boolean> =>
        Promise.reject(new Error('approval session disposed')),
    });
    const response = await fetch(
      service.getCanopyWorktreeMcpUrl('advisor-gate-throws'),
      {
        method: 'POST',
        headers: {
          Authorization: 'Bearer advisor-gate-throws-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 'gate-throws',
          method: 'tools/call',
          params: {
            name: 'DispatchAction',
            arguments: { action: { type: 'navigation.open_settings' } },
          },
        }),
      },
    );
    const body = await response.text();
    const dataLine = body.split('\n').find((line) => line.startsWith('data: '));
    expect(
      JSON.parse(dataLine ? dataLine.slice('data: '.length) : body),
    ).toMatchObject({
      id: 'gate-throws',
      error: { code: -32603, message: 'approval session disposed' },
    });
  });

  it('refuses an App Advisor tool when the route gate denies it, before executing', async () => {
    await service.ensureStarted(await getFreePort());
    const authorizeToolCall = jest.fn(
      (key: string): Promise<boolean> =>
        Promise.resolve(key !== 'dispatch_action'),
    );
    await service.registerCanopyWorktreeSessionRoute({
      sessionKey: 'advisor-gated',
      projectId: 'project-1',
      worktreeId: 'wt-1',
      chatId: 'chat-1',
      assistantMode: 'app-advisor',
      sdkSessionId: 'sdk-advisor-gated',
      authToken: 'advisor-gated-token',
      createdAt: Date.now(),
      hookHandler: jest.fn(),
      appAdvisorRuntime: { watchCommand: jest.fn() },
      authorizeToolCall,
    });
    const url = service.getCanopyWorktreeMcpUrl('advisor-gated');
    const call = async (
      name: string,
      id: string,
      args: Record<string, unknown>,
    ): Promise<unknown> => {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer advisor-gated-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id,
          method: 'tools/call',
          params: { name, arguments: args },
        }),
      });
      const body = await response.text();
      const dataLine = body
        .split('\n')
        .find((line) => line.startsWith('data: '));
      return JSON.parse(dataLine ? dataLine.slice('data: '.length) : body);
    };
    mockExecuteCanopyInjectedTool.mockClear();
    expect(
      await call('DispatchAction', 'gated-deny', {
        action: { type: 'navigation.open_settings' },
      }),
    ).toMatchObject({
      id: 'gated-deny',
      result: {
        isError: true,
        content: [{ type: 'text', text: 'DispatchAction was denied.' }],
      },
    });
    expect(authorizeToolCall).toHaveBeenCalledWith(
      'dispatch_action',
      { action: { type: 'navigation.open_settings' } },
      { requestId: 'gated-deny' },
    );
    expect(
      mockExecuteCanopyInjectedTool.mock.calls.some(
        ([key]) => key === 'dispatch_action',
      ),
    ).toBe(false);
    // A tool the gate allows runs through the shared executor as before.
    mockExecuteCanopyInjectedTool.mockResolvedValueOnce({ text: 'deferred' });
    expect(
      await call('SearchDeferredTools', 'gated-allow', { queries: [] }),
    ).toMatchObject({
      id: 'gated-allow',
      result: { content: [{ type: 'text', text: 'deferred' }] },
    });
    expect(
      mockExecuteCanopyInjectedTool.mock.calls.some(
        ([key]) => key === 'search_deferred_tools',
      ),
    ).toBe(true);
  });

  it('namespaces reused App Advisor WatchCommand request ids by session', async () => {
    await service.ensureStarted(await getFreePort());
    const calls: string[] = [];
    for (const sessionKey of ['advisor-watch-a', 'advisor-watch-b']) {
      const watchCommand = jest.fn(
        (_input: unknown, context?: { toolUseId?: string }) => {
          calls.push(context?.toolUseId ?? '');
          return Promise.resolve({ id: `${sessionKey}-watcher` });
        },
      );
      await service.registerCanopyWorktreeSessionRoute({
        sessionKey,
        projectId: 'project-1',
        worktreeId: 'wt-1',
        chatId: 'chat-1',
        assistantMode: 'app-advisor',
        authToken: `${sessionKey}-token`,
        createdAt: Date.now(),
        hookHandler: jest.fn(),
        appAdvisorRuntime: { watchCommand },
      });
      const response = await fetch(
        service.getCanopyWorktreeMcpUrl(sessionKey),
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${sessionKey}-token`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/call',
            params: {
              name: 'WatchCommand',
              arguments: {
                command: 'printf ready',
                intervalSeconds: 5,
                maxAttempts: 1,
              },
            },
          }),
        },
      );
      expect(response.status).toBe(200);
    }

    expect(calls).toHaveLength(2);
    expect(calls[0]).not.toBe(calls[1]);
    expect(calls.every((id) => id !== '1')).toBe(true);
  });

  it('aborts a nested app-advisor base-branch action when its SSE client disconnects', async () => {
    const proxyPort = await getFreePort();
    await service.ensureStarted(proxyPort);
    let receivedSignal: AbortSignal | undefined;
    let receivedRequestId: string | undefined;
    let finishDispatch:
      | ((response: { requestId: string; ok: boolean }) => void)
      | undefined;
    const dispatchRendererAction = jest.fn(
      (
        _action: unknown,
        _expectedUiRevision?: number,
        requestId?: string,
        signal?: AbortSignal,
      ) => {
        receivedRequestId = requestId;
        receivedSignal = signal;
        return new Promise<{ requestId: string; ok: boolean }>((resolve) => {
          finishDispatch = resolve;
          signal?.addEventListener(
            'abort',
            () => resolve({ requestId: 'advisor-base-close-call', ok: false }),
            { once: true },
          );
        });
      },
    );
    const appAdvisorRuntime = {
      getWindow: jest.fn(() => null),
      projectId: 'project-1',
      worktreeId: 'wt-1',
      chatId: 'chat-1',
      sessionKey: 'advisor-base-close-session',
      dispatchRendererAction,
    };
    await service.registerCanopyWorktreeSessionRoute({
      sessionKey: 'advisor-base-close-session',
      projectId: 'project-1',
      worktreeId: 'wt-1',
      chatId: 'chat-1',
      assistantMode: 'app-advisor',
      sdkSessionId: 'sdk-advisor-base-close-1',
      authToken: 'advisor-base-close-token',
      createdAt: Date.now(),
      hookHandler: jest.fn(),
      appAdvisorRuntime,
    });
    const mcpUrl = new URL(
      service.getCanopyWorktreeMcpUrl('advisor-base-close-session'),
    );
    let clientRequest: ReturnType<typeof httpRequest> | undefined;
    let response: IncomingMessage | undefined;
    try {
      const responsePromise = new Promise<IncomingMessage>(
        (resolve, reject) => {
          const req = httpRequest(
            {
              host: mcpUrl.hostname,
              port: Number(mcpUrl.port),
              path: mcpUrl.pathname,
              method: 'POST',
              headers: {
                Authorization: 'Bearer advisor-base-close-token',
                'Content-Type': 'application/json',
              },
            },
            resolve,
          );
          clientRequest = req;
          req.on('error', reject);
          req.end(
            JSON.stringify({
              jsonrpc: '2.0',
              id: 'advisor-base-close-call',
              method: 'tools/call',
              params: {
                name: 'DispatchAction',
                arguments: {
                  action: {
                    type: 'worktree.set_base_branch',
                    projectId: 'project-1',
                    worktreeId: 'wt-1',
                    baseBranch: 'release/next',
                  },
                },
              },
            }),
          );
        },
      );
      void responsePromise.catch(() => undefined);

      const dispatchCall = await waitForMockCall(
        dispatchRendererAction,
        () => true,
      );
      expect(dispatchCall).toBeDefined();
      expect(receivedRequestId).toBeUndefined();
      expect(receivedSignal).toBeDefined();
      expect(receivedSignal?.aborted).toBe(false);

      response = await responsePromise;
      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toContain('text/event-stream');
      response.destroy();

      const deadline = Date.now() + 1_000;
      while (!receivedSignal?.aborted && Date.now() < deadline) {
        await wait(10);
      }
      expect(receivedSignal?.aborted).toBe(true);
    } finally {
      finishDispatch?.({ requestId: 'advisor-base-close-call', ok: false });
      response?.destroy();
      clientRequest?.destroy();
    }
  });

  it('rejects app-advisor tools/call requests on the wrong MCP surface', async () => {
    const proxyPort = await getFreePort();
    await service.ensureStarted(proxyPort);
    await service.registerCanopyWorktreeSessionRoute({
      sessionKey: 'advisor-gated-session',
      projectId: 'project-1',
      worktreeId: 'wt-1',
      chatId: 'chat-1',
      assistantMode: 'app-advisor',
      sdkSessionId: 'sdk-advisor-gated-1',
      authToken: 'advisor-gated-token',
      createdAt: Date.now(),
      hookHandler: jest.fn(),
      appAdvisorRuntime: {
        getWindow: jest.fn(() => null),
        projectId: 'project-1',
        worktreeId: 'wt-1',
        chatId: 'chat-1',
        sessionKey: 'advisor-gated-session',
      },
    });
    const baseUrl = service.getCanopyWorktreeMcpUrl('advisor-gated-session');
    const uiUrl = service.getCanopyWorktreeUiMcpUrl('advisor-gated-session');

    const askOnBaseResponse = await fetch(baseUrl, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer advisor-gated-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 'advisor-ask-on-base',
        method: 'tools/call',
        params: {
          name: 'AskUserQuestion',
          arguments: {
            questions: [{ question: 'Proceed?', options: ['Yes', 'No'] }],
          },
        },
      }),
    });

    expect(askOnBaseResponse.status).toBe(200);
    await expect(askOnBaseResponse.json()).resolves.toMatchObject({
      jsonrpc: '2.0',
      id: 'advisor-ask-on-base',
      error: {
        code: -32602,
        message: 'Unknown App Advisor MCP tool',
      },
    });

    const scriptOnUiResponse = await fetch(uiUrl, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer advisor-gated-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 'advisor-script-on-ui',
        method: 'tools/call',
        params: {
          name: 'GetScriptOutput',
          arguments: { scriptId: 'launch' },
        },
      }),
    });

    expect(scriptOnUiResponse.status).toBe(200);
    expect(scriptOnUiResponse.headers.get('content-type')).toContain(
      'text/event-stream',
    );
    const body = await scriptOnUiResponse.text();
    const dataLine = body.split('\n').find((line) => line.startsWith('data: '));
    expect(dataLine).toBeDefined();
    const message: unknown = JSON.parse(
      (dataLine ?? '').slice('data: '.length),
    );
    expect(message).toMatchObject({
      jsonrpc: '2.0',
      id: 'advisor-script-on-ui',
      error: {
        code: -32602,
        message: 'Unknown App Advisor MCP tool',
      },
    });
  });

  it('preserves canonical raw-envelope validation through Claude HTTP MCP', async () => {
    const setupCanonical = jest
      .fn()
      .mockResolvedValue({ ok: true, results: [] });
    jest.doMock('../app-advisor/watchers', () => ({
      getAppAdvisorWatcherService: () => ({
        setupCanonicalChatWatchers: setupCanonical,
      }),
    }));
    try {
      const direct = jest.requireActual<typeof CanopyCoreModule>(
        '../canopy-tools/core',
      ).executeCanopyInjectedTool;
      mockExecuteCanopyInjectedTool.mockImplementation((...args) =>
        direct(...args),
      );
      await service.ensureStarted(await getFreePort());
      await service.registerCanopyWorktreeSessionRoute({
        sessionKey: 'canonical-watchers',
        projectId: 'root-project',
        worktreeId: 'root-task',
        chatId: 'root-chat',
        toolSurface: 'native-sdk',
        cwd: '/mock/session',
        sdkSessionId: 'sdk-watchers',
        authToken: 'test-token',
        createdAt: Date.now(),
        hookHandler: jest.fn(),
      });
      const canonical = {
        trigger: 'project_task_chat_completion',
        target: { projectId: 'p', taskId: 't', chatId: 'c' },
        armForNextCompletion: true,
      };
      const request = async (args: unknown): Promise<unknown> => {
        const response = await fetch(
          service.getCanopyWorktreeMcpUrl('canonical-watchers'),
          {
            method: 'POST',
            signal: AbortSignal.timeout(5000),
            headers: {
              Authorization: 'Bearer test-token',
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              jsonrpc: '2.0',
              id: 'canonical-call',
              method: 'tools/call',
              params: { name: 'SetupWatchers', arguments: args },
            }),
          },
        );
        expect(response.status).toBe(200);
        return response.json();
      };
      const success = await request({ watchers: [canonical] });
      expect(success).not.toMatchObject({ result: { isError: true } });
      expect(JSON.parse(getToolResultText(success))).toEqual({
        ok: true,
        results: [],
        watchers: [],
      });
      expect(setupCanonical).toHaveBeenCalledWith({
        createdByToolUseId: 'canonical-call',
        destination: {
          projectId: 'root-project',
          worktreeId: 'root-task',
          chatId: 'root-chat',
        },
        recipient: { kind: 'root' },
        watchers: [canonical],
      });
      setupCanonical.mockClear();
      for (const args of [
        { watchers: [canonical], destination: { chatId: 'forged' } },
        {
          watchers: [
            { target: { executionId: 'e' } },
            {
              ...canonical,
              target: { ...canonical.target, kind: 'project_task_chat' },
            },
          ],
        },
        { watchers: [{ ...canonical, owner: 'forged' }] },
      ]) {
        const refused = await request(args);
        expect(refused).toMatchObject({ result: { isError: true } });
        expect(getToolResultText(refused)).toContain(
          'Invalid arguments for SetupWatchers.',
        );
      }
      expect(setupCanonical).not.toHaveBeenCalled();
    } finally {
      jest.dontMock('../app-advisor/watchers');
    }
  });

  it('dispatches terminal worktree MCP tools through canonical Canopy runtimes', async () => {
    const proxyPort = await getFreePort();
    await service.ensureStarted(proxyPort);
    const getWindow = jest.fn(() => null);
    service.setWindowAccessor(getWindow);
    await service.registerCanopyWorktreeSessionRoute({
      sessionKey: 'session-key',
      projectId: 'project-1',
      worktreeId: 'wt-1',
      chatId: 'chat-1',
      cwd: '/mock/worktree/repo-a',
      sdkSessionId: 'sdk-1',
      authToken: 'secret-token',
      createdAt: Date.now(),
      hookHandler: jest.fn(),
    });

    const response = await fetch(
      service.getCanopyWorktreeMcpUrl('session-key'),
      {
        method: 'POST',
        headers: {
          Authorization: 'Bearer secret-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 'tool-call',
          method: 'tools/call',
          params: {
            name: 'mcp__canopy__SetupWatchers',
            arguments: {
              watchers: [
                {
                  target: { executionId: 'execution-1' },
                },
              ],
            },
          },
        }),
      },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      jsonrpc: '2.0',
      id: 'tool-call',
      result: {
        content: [{ type: 'text', text: 'ok' }],
      },
    });
    expect(mockExecuteCanopyInjectedTool).toHaveBeenCalledWith(
      'setup_watchers',
      {
        watchers: [
          {
            target: { executionId: 'execution-1' },
          },
        ],
      },
      expect.objectContaining({
        worktreeWatcherRuntime: {
          projectId: 'project-1',
          worktreeId: 'wt-1',
          chatId: 'chat-1',
        },
      }),
      { toolUseId: 'tool-call' },
    );

    const watchGitHubResponse = await fetch(
      service.getCanopyWorktreeMcpUrl('session-key'),
      {
        method: 'POST',
        headers: {
          Authorization: 'Bearer secret-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 'watch-github-call',
          method: 'tools/call',
          params: {
            name: 'mcp__canopy__WatchGitHubItems',
            arguments: {
              items: [{ repository: 'acme/api', runId: '1' }],
            },
          },
        }),
      },
    );

    expect(watchGitHubResponse.status).toBe(200);
    expect(mockExecuteCanopyInjectedTool).toHaveBeenLastCalledWith(
      'watch_github_items',
      { items: [{ repository: 'acme/api', runId: '1' }] },
      expect.objectContaining({
        worktreeActionRuntime: {
          projectId: 'project-1',
          worktreeId: 'wt-1',
          chatId: 'chat-1',
          cwd: '/mock/worktree/repo-a',
          getWindow,
        },
        worktreeWatcherRuntime: {
          projectId: 'project-1',
          worktreeId: 'wt-1',
          chatId: 'chat-1',
        },
      }),
      { toolUseId: 'watch-github-call' },
    );

    const deleteResponse = await fetch(
      service.getCanopyWorktreeMcpUrl('session-key'),
      {
        method: 'POST',
        headers: {
          Authorization: 'Bearer secret-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 'delete-call',
          method: 'tools/call',
          params: {
            name: 'mcp__canopy__DeleteWatchers',
            arguments: { watcherIds: ['watcher-1'] },
          },
        }),
      },
    );

    expect(deleteResponse.status).toBe(200);
    expect(mockExecuteCanopyInjectedTool).toHaveBeenLastCalledWith(
      'delete_watchers',
      { watcherIds: ['watcher-1'] },
      expect.objectContaining({
        worktreeWatcherRuntime: {
          projectId: 'project-1',
          worktreeId: 'wt-1',
          chatId: 'chat-1',
        },
      }),
      { toolUseId: 'delete-call' },
    );

    const dispatchResponse = await fetch(
      service.getCanopyWorktreeMcpUrl('session-key'),
      {
        method: 'POST',
        headers: {
          Authorization: 'Bearer secret-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 'dispatch-call',
          method: 'tools/call',
          params: {
            name: 'DispatchAction',
            arguments: {
              action: { type: 'pipeline.run', pipelineId: 'pipeline-1' },
            },
          },
        }),
      },
    );

    expect(dispatchResponse.status).toBe(200);
    expect(mockExecuteCanopyInjectedTool).toHaveBeenLastCalledWith(
      'dispatch_action',
      {
        action: { type: 'pipeline.run', pipelineId: 'pipeline-1' },
      },
      expect.any(Object),
      { toolUseId: 'dispatch-call' },
    );
    const calls = mockExecuteCanopyInjectedTool.mock.calls as unknown as Array<
      [
        unknown,
        unknown,
        {
          worktreeActionRuntime?: {
            projectId: string;
            worktreeId: string;
            cwd: string;
            getWindow: unknown;
          };
        },
        unknown,
      ]
    >;
    const dispatchCall = calls[calls.length - 1];
    expect(dispatchCall[2].worktreeActionRuntime).toMatchObject({
      projectId: 'project-1',
      worktreeId: 'wt-1',
      cwd: '/mock/worktree/repo-a',
    });
    expect(dispatchCall[2].worktreeActionRuntime?.getWindow).toBe(getWindow);

    const codeGraphResponse = await fetch(
      service.getCanopyWorktreeMcpUrl('session-key'),
      {
        method: 'POST',
        headers: {
          Authorization: 'Bearer secret-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 'code-graph-call',
          method: 'tools/call',
          params: {
            name: 'QueryCodeGraph',
            arguments: { mode: 'callers', target: 'src/foo.ts::Bar' },
          },
        }),
      },
    );

    expect(codeGraphResponse.status).toBe(200);
    expect(mockExecuteCanopyInjectedTool).toHaveBeenLastCalledWith(
      'query_code_graph',
      { mode: 'callers', target: 'src/foo.ts::Bar' },
      expect.any(Object),
      { toolUseId: 'code-graph-call' },
    );
    const codeGraphCalls = mockExecuteCanopyInjectedTool.mock
      .calls as unknown as Array<
      [
        unknown,
        unknown,
        {
          codeGraphRuntime?: {
            projectId: string;
            worktreeId: string;
          };
        },
        unknown,
      ]
    >;
    const codeGraphCall = codeGraphCalls[codeGraphCalls.length - 1];
    expect(codeGraphCall[2].codeGraphRuntime).toEqual({
      projectId: 'project-1',
      worktreeId: 'wt-1',
    });

    const detectChangedSymbolsResponse = await fetch(
      service.getCanopyWorktreeMcpUrl('session-key'),
      {
        method: 'POST',
        headers: {
          Authorization: 'Bearer secret-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 'detect-changed-symbols-call',
          method: 'tools/call',
          params: {
            name: 'DetectChangedSymbols',
            arguments: { baseRef: 'main' },
          },
        }),
      },
    );

    expect(detectChangedSymbolsResponse.status).toBe(200);
    expect(mockExecuteCanopyInjectedTool).toHaveBeenLastCalledWith(
      'detect_changed_symbols',
      { baseRef: 'main' },
      expect.any(Object),
      { toolUseId: 'detect-changed-symbols-call' },
    );
    const detectChangedSymbolsCalls = mockExecuteCanopyInjectedTool.mock
      .calls as unknown as Array<
      [
        unknown,
        unknown,
        {
          codeGraphRuntime?: {
            projectId: string;
            worktreeId: string;
          };
        },
        unknown,
      ]
    >;
    const detectChangedSymbolsCall =
      detectChangedSymbolsCalls[detectChangedSymbolsCalls.length - 1];
    expect(detectChangedSymbolsCall[2].codeGraphRuntime).toEqual({
      projectId: 'project-1',
      worktreeId: 'wt-1',
    });
  });

  it('gives SetAutoArchive the chat identity so it can report a deferral for live delegates', async () => {
    const proxyPort = await getFreePort();
    await service.ensureStarted(proxyPort);
    const onSetAutoArchive = jest.fn();
    await service.registerCanopyWorktreeSessionRoute({
      sessionKey: 'session-key',
      projectId: 'project-1',
      worktreeId: 'wt-1',
      chatId: 'chat-1',
      cwd: '/mock/worktree/repo-a',
      sdkSessionId: 'sdk-1',
      authToken: 'secret-token',
      createdAt: Date.now(),
      hookHandler: jest.fn(),
      onSetAutoArchive,
    });

    const response = await fetch(
      service.getCanopyWorktreeMcpUrl('session-key'),
      {
        method: 'POST',
        headers: {
          Authorization: 'Bearer secret-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 'auto-archive-call',
          method: 'tools/call',
          params: {
            name: 'mcp__canopy__SetAutoArchive',
            arguments: { enabled: true },
          },
        }),
      },
    );

    expect(response.status).toBe(200);
    expect(mockExecuteCanopyInjectedTool).toHaveBeenLastCalledWith(
      'set_auto_archive',
      { enabled: true },
      expect.objectContaining({
        setAutoArchiveForCurrentChat: onSetAutoArchive,
        worktreeWatcherRuntime: {
          projectId: 'project-1',
          worktreeId: 'wt-1',
          chatId: 'chat-1',
        },
      }),
      { toolUseId: 'auto-archive-call' },
    );
  });

  it('returns JSON-RPC errors for worktree MCP tool failures', async () => {
    const proxyPort = await getFreePort();
    await service.ensureStarted(proxyPort);
    await service.registerCanopyWorktreeSessionRoute({
      sessionKey: 'session-key',
      projectId: 'project-1',
      worktreeId: 'wt-1',
      chatId: 'chat-1',
      sdkSessionId: 'sdk-1',
      authToken: 'secret-token',
      createdAt: Date.now(),
      hookHandler: jest.fn(),
    });
    mockExecuteCanopyInjectedTool.mockRejectedValueOnce(new Error('boom'));

    const response = await fetch(
      service.getCanopyWorktreeMcpUrl('session-key'),
      {
        method: 'POST',
        headers: {
          Authorization: 'Bearer secret-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 'tool-call',
          method: 'tools/call',
          params: {
            name: 'GetScriptOutput',
            arguments: { scriptId: 'launch' },
          },
        }),
      },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      jsonrpc: '2.0',
      id: 'tool-call',
      error: {
        code: -32603,
        message: 'boom',
      },
    });
  });

  it('treats malformed percent-encoded route segments as missing routes', async () => {
    const proxyPort = await getFreePort();
    await service.ensureStarted(proxyPort);

    const response = await rawRequest({
      port: proxyPort,
      path: '/canopy/mcp/worktree-session/%',
      method: 'POST',
      headers: {
        Host: `127.0.0.1:${String(proxyPort)}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 'bad-path',
        method: 'tools/list',
      }),
    });

    expect(response.statusCode).toBe(404);
    expect(JSON.parse(response.body)).toMatchObject({
      jsonrpc: '2.0',
      id: 'bad-path',
      error: {
        code: -32004,
        message: 'Canopy worktree session not found',
      },
    });
  });

  it('rejects oversized worktree MCP request bodies before parsing', async () => {
    await service.ensureStarted(await getFreePort());
    await service.registerCanopyWorktreeSessionRoute({
      sessionKey: 'large-session',
      projectId: 'project-1',
      worktreeId: 'wt-1',
      chatId: 'chat-1',
      sdkSessionId: 'sdk-1',
      authToken: 'secret-token',
      createdAt: Date.now(),
      hookHandler: jest.fn(),
    });

    const response = await fetch(
      service.getCanopyWorktreeMcpUrl('large-session'),
      {
        method: 'POST',
        headers: {
          Authorization: 'Bearer secret-token',
          'Content-Type': 'application/json',
        },
        body: 'x'.repeat(2 * 1024 * 1024 + 1),
      },
    );

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toMatchObject({
      jsonrpc: '2.0',
      id: null,
      error: {
        code: -32013,
        message: 'Payload too large',
      },
    });
  });

  it('authenticates Claude terminal hook callbacks', async () => {
    const hookOutput = {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
      },
    };
    const hookHandler = jest.fn().mockResolvedValue(hookOutput);
    await service.ensureStarted(await getFreePort());
    await service.registerCanopyWorktreeSessionRoute({
      sessionKey: 'hook-session',
      projectId: 'project-1',
      worktreeId: 'wt-1',
      chatId: 'chat-1',
      sdkSessionId: 'sdk-1',
      authToken: 'hook-token',
      createdAt: Date.now(),
      hookHandler,
    });

    const response = await fetch(
      service.getClaudeTerminalHookUrl('hook-session'),
      {
        method: 'POST',
        headers: {
          'X-Canopy-Integration-Token': 'hook-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          hookEventName: 'PreToolUse',
          hookPayload: { tool_name: 'Bash', tool_input: { command: 'pwd' } },
        }),
      },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(hookOutput);
    expect(hookHandler).toHaveBeenCalledWith({
      hookEventName: 'PreToolUse',
      hookPayload: { tool_name: 'Bash', tool_input: { command: 'pwd' } },
    });
  });

  it('rejects non-HTTP upstream routes before registering', async () => {
    await expect(
      service.registerRoute({
        sessionId: 'session-1',
        serverId: 'server-1',
        configId: 'config-1',
        displayName: 'Server',
        upstreamUrl: 'file:///tmp/server',
        headers: {},
        oauthEnabled: false,
      }),
    ).rejects.toThrow('HTTP and HTTPS');
  });

  it.each([
    {
      rejection: undefined,
      apiKey: '',
      baseUrl: 'http://127.0.0.1:1',
      status: 401,
      error: 'mcp_reauth_required',
    },
    {
      rejection: undefined,
      apiKey: 'csk_test',
      baseUrl: 'https://changed.example.test',
      status: 502,
      error: 'account_route_unavailable',
    },
    {
      rejection: new CanopyCloudClientError('missing-api-key', 'Sign in'),
      apiKey: '',
      baseUrl: '',
      status: 401,
      error: 'mcp_reauth_required',
    },
    {
      rejection: new CanopyCloudClientError(
        'cloud-not-configured',
        'Configure cloud',
      ),
      apiKey: '',
      baseUrl: '',
      status: 502,
      error: 'account_route_unavailable',
    },
  ])(
    'answers account credential changes with $status',
    async ({ apiKey, baseUrl, status, error, rejection }): Promise<void> => {
      await service.ensureStarted(await getFreePort());
      const routeId = await service.registerRoute({
        sessionId: null,
        serverId: 'account-server',
        configId: 'default',
        displayName: 'Account',
        upstreamUrl: 'http://127.0.0.1:1/api/v1/mcp-proxy/web-route',
        headers: {},
        oauthEnabled: false,
        authSupplier: 'canopy-cloud',
      });
      jest
        .mocked(resolveCanopyCloudCredentialContext)
        .mockResolvedValue({ baseUrl, apiKey });
      if (rejection)
        jest
          .mocked(resolveCanopyCloudCredentialContext)
          .mockRejectedValue(rejection);
      const response = await fetch(service.getProxyUrl(routeId), {
        method: 'POST',
        body: '{}',
        signal: AbortSignal.timeout(1000),
      });
      expect(response.status).toBe(status);
      expect(await response.json()).toEqual({ error });
      expect(service.getRouteStatus(routeId)).toEqual({
        reauthRequired: status === 401,
      });
      expect(isAccountMcpReauthRequired('account-server', 'default')).toBe(
        status === 401,
      );
      expect(mockGetValidMcpAccessToken).not.toHaveBeenCalled();
    },
  );

  it.each(['mcp_reauth_required', 'unauthorized', 'non-json'])(
    'supplies the cloud key and forwards %s unchanged without local OAuth',
    async (error): Promise<void> => {
      const body =
        error === 'non-json'
          ? 'Unauthorized'
          : JSON.stringify({ error, detail: 'Reconnect from cloud' });
      const upstream = createServer((req, res): void => {
        upstreamRequests.push(req);
        res.writeHead(401, {
          'Content-Type': 'application/json',
          'WWW-Authenticate': 'Bearer realm="cloud"',
        });
        res.end(body);
      });
      const upstreamPort = await listen(upstream);
      jest.mocked(resolveCanopyCloudCredentialContext).mockResolvedValue({
        baseUrl: `http://127.0.0.1:${upstreamPort}`,
        apiKey: 'csk_desktop',
      });
      try {
        await service.ensureStarted(await getFreePort());
        const routeId = await service.registerRoute({
          sessionId: 'account-session',
          serverId: 'account-server',
          configId: 'default',
          displayName: 'Account',
          upstreamUrl: `http://127.0.0.1:${upstreamPort}/api/v1/mcp-proxy/web-route`,
          headers: { authorization: 'stale' },
          oauthEnabled: true,
          authSupplier: 'canopy-cloud',
        });
        const response = await fetch(service.getProxyUrl(routeId), {
          method: 'POST',
          body: '{}',
          headers: { Authorization: 'Bearer harness' },
        });
        expect(response.status).toBe(401);
        expect(await response.text()).toBe(body);
        expect(upstreamRequests[0]?.headers.authorization).toBe(
          'Bearer csk_desktop',
        );
        expect(mockGetValidMcpAccessToken).not.toHaveBeenCalled();
        expect(mockInvalidateMcpOAuthAccessToken).not.toHaveBeenCalled();
        expect(service.getRouteStatus(routeId)).toEqual({
          reauthRequired: error === 'mcp_reauth_required',
        });
        expect(isAccountMcpReauthRequired('account-server', 'default')).toBe(
          error === 'mcp_reauth_required',
        );
        service.unregisterRoute(routeId);
        expect(isAccountMcpReauthRequired('account-server', 'default')).toBe(
          false,
        );
      } finally {
        await close(upstream);
      }
    },
  );

  it('injects OAuth authorization or returns auth-required JSON-RPC error', async () => {
    const upstream = createServer((req, res) => {
      upstreamRequests.push(req);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{}');
    });
    const upstreamPort = await listen(upstream);
    const proxyPort = await getFreePort();
    await service.ensureStarted(proxyPort);
    const routeId = await service.registerRoute({
      sessionId: null,
      serverId: 'server-1',
      configId: 'config-1',
      displayName: 'Server',
      upstreamUrl: `http://127.0.0.1:${String(upstreamPort)}/mcp`,
      headers: {},
      oauthEnabled: true,
    });

    mockGetValidMcpAccessToken.mockResolvedValueOnce('stored-token');
    await fetch(service.getProxyUrl(routeId), { method: 'POST', body: '{}' });
    expect(upstreamRequests[0].headers.authorization).toBe(
      'Bearer stored-token',
    );

    mockGetValidMcpAccessToken.mockResolvedValueOnce(null);
    const response = await fetch(service.getProxyUrl(routeId), {
      method: 'POST',
      body: '{}',
    });
    await expect(response.json()).resolves.toMatchObject({
      error: { code: -32001 },
      id: null,
    });

    await close(upstream);
  });

  it('reports unavailable renewal as a temporary service failure rather than sign-in required', async () => {
    const upstream = createServer((_req, res) => res.writeHead(200).end('{}'));
    const upstreamPort = await listen(upstream);
    await service.ensureStarted(await getFreePort());
    const routeId = await service.registerRoute({
      sessionId: null,
      serverId: 'server-1',
      configId: 'config-1',
      displayName: 'Server',
      upstreamUrl: `http://127.0.0.1:${String(upstreamPort)}/mcp`,
      headers: {},
      oauthEnabled: true,
    });
    try {
      mockGetValidMcpAccessToken.mockRejectedValueOnce(
        new Error('temporary refresh outage'),
      );
      const response = await fetch(service.getProxyUrl(routeId), {
        method: 'POST',
        body: '{}',
      });
      await response.text();
      expect(response.status).toBe(503);
      expect(mockRecordMcpOAuthTokenError).not.toHaveBeenCalled();
    } finally {
      await close(upstream);
    }
  });

  it.each([401, 403])(
    'preserves account renewal after an upstream HTTP %s',
    async (status) => {
      const upstream = createServer((req, res) => {
        upstreamRequests.push(req);
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end('{}');
      });
      const upstreamPort = await listen(upstream);
      const proxyPort = await getFreePort();
      await service.ensureStarted(proxyPort);
      const upstreamUrl = `http://127.0.0.1:${String(upstreamPort)}/mcp`;
      const routeId = await service.registerRoute({
        sessionId: null,
        serverId: 'server-1',
        configId: 'config-1',
        displayName: 'Server',
        upstreamUrl,
        headers: {},
        oauthEnabled: true,
      });

      mockGetValidMcpAccessToken.mockResolvedValueOnce('stored-token');
      const response = await fetch(service.getProxyUrl(routeId), {
        method: 'POST',
        body: '{}',
      });
      await response.text();
      await Promise.resolve();

      expect(upstreamRequests[0].headers.authorization).toBe(
        'Bearer stored-token',
      );
      expect(mockRecordMcpOAuthTokenError).not.toHaveBeenCalled();
      if (status === 401) {
        expect(mockInvalidateMcpOAuthAccessToken).toHaveBeenCalledWith(
          'server-1',
          'config-1',
          'stored-token',
          upstreamUrl,
        );
      } else {
        expect(mockInvalidateMcpOAuthAccessToken).not.toHaveBeenCalled();
      }

      await close(upstream);
    },
  );

  it('forwards plugin proxy traffic without a token when OAuth is optional', async () => {
    const upstream = createServer((req, res) => {
      upstreamRequests.push(req);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{}');
    });
    const upstreamPort = await listen(upstream);
    const proxyPort = await getFreePort();
    await service.ensureStarted(proxyPort);
    const routeId = await service.registerRoute({
      sessionId: 'session-1',
      serverId: 'plugin-server',
      configId: 'plugin-config',
      displayName: 'Plugin Server',
      upstreamUrl: `http://127.0.0.1:${String(upstreamPort)}/mcp`,
      headers: {},
      oauthEnabled: true,
      oauthRequired: false,
      oauthDefinition: {
        id: 'plugin-server',
        name: 'Plugin Server',
        description: '',
        type: 'http',
        url: `http://127.0.0.1:${String(upstreamPort)}/mcp`,
        oauth: {},
        createdAt: '2026-04-29T00:00:00.000Z',
        updatedAt: '2026-04-29T00:00:00.000Z',
      },
      oauthConfig: {
        id: 'plugin-config',
        name: 'Plugin',
        description: '',
        enabled: true,
        envVars: {},
        extraArgs: [],
        extraHeaders: {},
        createdAt: '2026-04-29T00:00:00.000Z',
        updatedAt: '2026-04-29T00:00:00.000Z',
      },
    });

    mockGetValidMcpAccessToken.mockResolvedValueOnce(null);
    const unauthenticatedResponse = await fetch(service.getProxyUrl(routeId), {
      method: 'POST',
      body: '{}',
    });
    expect(unauthenticatedResponse.status).toBe(200);
    expect(upstreamRequests[0].headers.authorization).toBeUndefined();

    mockGetValidMcpAccessToken.mockResolvedValueOnce('stored-token');
    await fetch(service.getProxyUrl(routeId), { method: 'POST', body: '{}' });
    expect(upstreamRequests[1].headers.authorization).toBe(
      'Bearer stored-token',
    );

    await close(upstream);
  });

  it('unregisters session routes without removing null-session routes', async () => {
    await service.ensureStarted(await getFreePort());
    const sessionRoute = await service.registerRoute({
      sessionId: 'session-1',
      serverId: 'server-1',
      configId: 'config-1',
      displayName: 'Server',
      upstreamUrl: 'http://127.0.0.1:1/mcp',
      headers: {},
      oauthEnabled: false,
    });
    const nullRoute = await service.registerRoute({
      sessionId: null,
      serverId: 'server-1',
      configId: 'config-1',
      displayName: 'Server',
      upstreamUrl: 'http://127.0.0.1:1/mcp',
      headers: {},
      oauthEnabled: false,
    });

    service.unregisterRoutesForSession('session-1');
    await expect(
      fetch(service.getProxyUrl(sessionRoute)),
    ).resolves.toHaveProperty('status', 404);
    await expect(
      fetch(service.getProxyUrl(nullRoute)),
    ).resolves.not.toHaveProperty('status', 404);

    service.unregisterRoute(nullRoute);
    await expect(fetch(service.getProxyUrl(nullRoute))).resolves.toHaveProperty(
      'status',
      404,
    );
  });

  it('drops a published-but-unclaimed auth failure when its session tears down', async () => {
    await service.ensureStarted(await getFreePort());
    await service.registerRoute({
      sessionId: 'session-1',
      serverId: 'server-1',
      configId: 'config-1',
      displayName: 'Server',
      upstreamUrl: 'http://127.0.0.1:1/mcp',
      headers: {},
      oauthEnabled: false,
    });
    recordPendingMcpAuthFailure('session-1', {
      dependencyClass: 'mcp',
      dependencyId: 'server-1:config-1',
      displayName: 'Server',
      failureClass: 'expired',
      recovery: {
        kind: 'mcp_oauth',
        serverId: 'server-1',
        configId: 'config-1',
      },
    });

    service.unregisterRoutesForSession('session-1');

    expect(claimPendingAuthFailures('session-1')).toEqual([]);
  });

  it('drops the tool-name correlation cache when its session tears down (CAN-1814 fix-round-1)', async () => {
    await service.ensureStarted(await getFreePort());
    await service.registerRoute({
      sessionId: 'session-1',
      serverId: 'server-1',
      configId: 'config-1',
      displayName: 'Server',
      upstreamUrl: 'http://127.0.0.1:1/mcp',
      headers: {},
      oauthEnabled: false,
    });

    // Observe a tool_use so 'tu-1' resolves to an MCP tool name for
    // 'session-1' in auth-failure-event.ts's correlation cache.
    pairPendingAuthFailures(
      {
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'tu-1',
              name: 'mcp__prod__query',
              input: {},
            },
          ],
        },
      },
      'session-1',
    );

    service.unregisterRoutesForSession('session-1');

    // A failure recorded AFTER teardown, paired against the SAME
    // tool_use_id, must not pair: the correlation cache was cleared by
    // teardown, so 'tu-1' now resolves to no name and the pairing fails
    // closed instead of trusting a stale entry from the torn-down session.
    recordPendingMcpAuthFailure('session-1', {
      dependencyClass: 'mcp',
      dependencyId: 'server-1:config-1',
      displayName: 'Server',
      failureClass: 'expired',
      recovery: {
        kind: 'mcp_oauth',
        serverId: 'server-1',
        configId: 'config-1',
      },
    });
    const paired = pairPendingAuthFailures(
      {
        type: 'user',
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tu-1',
              is_error: true,
              content: 'HTTP 401',
            },
          ],
        },
      },
      'session-1',
    );

    expect(paired).toEqual([]);
    expect(claimPendingAuthFailures('session-1')).toHaveLength(1);
  });

  it('only drops chat-session-keyed auth failures when teardown runs under that key (Codex ownership split)', async () => {
    // The proxy publishes under the ROUTE's sessionId, but
    // `worktree-chat-turn.ts` pairs under the CHAT SESSION KEY for every
    // provider. Claude registers routes under that same key so one teardown
    // covers both; Codex registers under `codex-session:<key>:<uuid>`, which is
    // why `codex-session.ts` `disposeSession` calls this a second time with the
    // chat session key (CAN-1814).
    await service.ensureStarted(await getFreePort());
    const chatSessionKey = 'project/worktree/chat';
    const codexRouteOwnerId = `codex-session:${chatSessionKey}:11111111-2222-3333-4444-555555555555`;
    const failure: AuthDependencyFailure = {
      dependencyClass: 'mcp',
      dependencyId: 'server-1:config-1',
      displayName: 'Server',
      failureClass: 'expired',
      recovery: {
        kind: 'mcp_oauth',
        serverId: 'server-1',
        configId: 'config-1',
      },
    };
    await service.registerRoute({
      sessionId: codexRouteOwnerId,
      serverId: 'server-1',
      configId: 'config-1',
      displayName: 'Server',
      upstreamUrl: 'http://127.0.0.1:1/mcp',
      headers: {},
      oauthEnabled: false,
    });

    recordPendingMcpAuthFailure(chatSessionKey, failure);
    service.unregisterRoutesForSession(codexRouteOwnerId);
    expect(claimPendingAuthFailures(chatSessionKey)).toHaveLength(1);

    recordPendingMcpAuthFailure(chatSessionKey, failure);
    service.unregisterRoutesForSession(chatSessionKey);
    expect(claimPendingAuthFailures(chatSessionKey)).toEqual([]);
  });

  it('does not expose caller supplied route keys as proxy bearer routes', async () => {
    await service.ensureStarted(await getFreePort());
    const firstRoute = await service.registerRoute({
      sessionId: 'session-1',
      routeKey: 'codex-stable-route',
      serverId: 'server-1',
      configId: 'config-1',
      displayName: 'Server',
      upstreamUrl: 'http://127.0.0.1:1/mcp',
      headers: {},
      oauthEnabled: false,
    });
    const secondRoute = await service.registerRoute({
      sessionId: null,
      routeKey: 'codex-stable-route',
      serverId: 'server-1',
      configId: 'config-1',
      displayName: 'Server',
      upstreamUrl: 'http://127.0.0.1:1/mcp',
      headers: {},
      oauthEnabled: false,
    });

    expect(firstRoute).not.toBe('codex-stable-route');
    expect(secondRoute).not.toBe('codex-stable-route');
    expect(secondRoute).not.toBe(firstRoute);
    expect(
      service.getCodexCapabilityAuthorityIds({
        github: {
          type: 'http',
          url: service.getProxyUrl(firstRoute),
        },
      }),
    ).toEqual(['github:codex-stable-route']);

    service.unregisterRoutesForSession('session-1');
    await expect(
      fetch(service.getProxyUrl(firstRoute)),
    ).resolves.toHaveProperty('status', 404);
    await expect(
      fetch(service.getProxyUrl(secondRoute)),
    ).resolves.not.toHaveProperty('status', 404);
  });

  it('keeps capability digests stable across proxy recreation but changes them with upstream configuration', async () => {
    await service.ensureStarted(await getFreePort());
    const route = {
      sessionId: 'copilot-snapshot',
      serverId: 'selected',
      configId: 'config',
      displayName: 'Selected',
      upstreamUrl: 'https://example.test/mcp',
      headers: { Authorization: 'Bearer private-token' },
      oauthEnabled: false,
    };
    const first = await service.registerRoute(route);
    const second = await service.registerRoute({
      ...route,
      sessionId: 'recreated',
    });
    const changed = await service.registerRoute({
      ...route,
      upstreamUrl: 'https://different.test/mcp',
    });
    const snapshot = (id: string): Record<string, string> =>
      service.getMcpCapabilityDigests({
        selected: {
          type: 'http',
          url: service.getProxyUrl(id),
          tools: ['read'],
        },
      });
    expect(snapshot(first)).toEqual(snapshot(second));
    expect(snapshot(first)).not.toEqual(snapshot(changed));
    expect(JSON.stringify(snapshot(first))).not.toContain('private-token');
    expect(snapshot(first).selected).toMatch(/^[a-f0-9]{64}$/);
  });

  it('excludes credential-bearing values from capability digests', async () => {
    await service.ensureStarted(await getFreePort());
    const makeRoute = (secret: string) =>
      service.registerRoute({
        sessionId: 'secret-snapshot',
        serverId: 'server',
        configId: 'config',
        displayName: 'Test',
        upstreamUrl: `https://user:${secret}@example.test/${secret}?token=${secret}`,
        headers: { Authorization: `Bearer ${secret}`, 'X-Api-Key': secret },
        oauthEnabled: true,
        oauthConfig: {
          id: 'config',
          name: 'Test',
          description: '',
          enabled: true,
          authToken: secret,
          envVars: { API_KEY: secret },
          extraArgs: [secret],
          extraHeaders: { Authorization: secret },
          createdAt: '',
          updatedAt: '',
        },
      });
    const first = await makeRoute('secret-one');
    const second = await makeRoute('secret-two');
    const proxySnapshot = (id: string) =>
      service.getMcpCapabilityDigests({
        selected: {
          type: 'http',
          url: service.getProxyUrl(id),
          tools: ['read'],
        },
      });
    expect(proxySnapshot(first)).toEqual(proxySnapshot(second));
    const directSnapshot = (secret: string) =>
      service.getMcpCapabilityDigests({
        selected: {
          type: 'stdio',
          command: 'node',
          args: ['server.mjs', '--token', secret],
          env: { API_KEY: secret, CUSTOM_VALUE: secret },
          headers: { Authorization: secret },
          authToken: secret,
          tools: ['read'],
        },
      });
    expect(directSnapshot('secret-one')).toEqual(directSnapshot('secret-two'));
    const remoteSnapshot = (secret: string) =>
      service.getMcpCapabilityDigests({
        selected: {
          type: 'http',
          url: `https://user:${secret}@example.test/${secret}?key=${secret}`,
          headers: { Authorization: secret },
          tools: ['read'],
        },
      });
    expect(remoteSnapshot('secret-one')).toEqual(remoteSnapshot('secret-two'));
    expect(
      service.getMcpCapabilityDigests({
        selected: { type: 'stdio', command: 'node', tools: ['write'] },
      }),
    ).not.toEqual(
      service.getMcpCapabilityDigests({
        selected: { type: 'stdio', command: 'node', tools: ['read'] },
      }),
    );
  });

  it('snapshots the exact App Advisor main and UI tool schemas served to Copilot', async () => {
    await service.ensureStarted(await getFreePort());
    const sessionKey = 'copilot-advisor-snapshot';
    await service.registerCanopyWorktreeSessionRoute({
      sessionKey,
      projectId: 'project',
      worktreeId: 'worktree',
      chatId: 'chat',
      sdkSessionId: 'sdk',
      authToken: 'token',
      createdAt: 1,
      hookHandler: jest.fn(),
      assistantMode: 'app-advisor',
      providerType: 'copilot',
      toolSurface: 'copilot-sdk',
      deferredToolsAllowed: false,
      codeGraphToolsAdvertised: false,
      appAdvisorRuntime: {
        getWindow: () => null,
        projectId: 'project',
        worktreeId: 'worktree',
        chatId: 'chat',
        sessionKey,
      },
    });
    const list = async (url: string) => {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      });
      expect(response.status).toBe(200);
      const payload: unknown = await response.json();
      if (!payload || typeof payload !== 'object' || !('result' in payload))
        throw new Error('Expected a tools/list response');
      const result = payload.result;
      if (!result || typeof result !== 'object' || !('tools' in result))
        throw new Error('Expected MCP tool definitions');
      return result.tools;
    };
    expect(service.getCanopyCapabilityDefinitions(sessionKey)).toEqual({
      main: await list(service.getCanopyWorktreeMcpUrl(sessionKey)),
      ui: await list(service.getCanopyWorktreeUiMcpUrl(sessionKey)),
    });
  });

  it('maps exact session-owned routes', async () => {
    await service.ensureStarted(await getFreePort());
    await service.registerRoute({
      sessionId: 'session-1',
      routeKey: 'linear-oauth-route',
      serverId: 'linear-server',
      configId: 'linear-config',
      displayName: 'Linear',
      upstreamUrl: 'http://127.0.0.1:1/mcp',
      headers: {},
      oauthEnabled: true,
    });
    await service.registerRoute({
      sessionId: 'session-1',
      routeKey: 'plain-route',
      serverId: 'plain-server',
      configId: 'plain-config',
      displayName: 'Plain MCP',
      upstreamUrl: 'http://127.0.0.1:2/mcp',
      headers: {},
      oauthEnabled: false,
    });

    expect(
      service.getSessionMcpRoute('session-1', 'linear-server', 'linear-config'),
    ).toEqual({ displayName: 'Linear' });
    expect(
      service.getSessionMcpRoute(
        'another-session',
        'linear-server',
        'linear-config',
      ),
    ).toBeUndefined();
    expect(
      service.getSessionMcpRoute(
        'session-1',
        'linear-server',
        'another-config',
      ),
    ).toBeUndefined();
  });

  it('updates ports without waiting for active streaming responses to end', async () => {
    const streamResponses: ServerResponse[] = [];
    const upstream = createServer((_req, res) => {
      streamResponses.push(res);
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
      });
      res.write('data: open\n\n');
    });
    const upstreamPort = await listen(upstream);
    const firstProxyPort = await getFreePort();
    const secondProxyPort = await getFreePort();
    await service.ensureStarted(firstProxyPort);
    const routeId = await service.registerRoute({
      sessionId: 'session-1',
      serverId: 'server-1',
      configId: 'config-1',
      displayName: 'Server',
      upstreamUrl: `http://127.0.0.1:${String(upstreamPort)}/mcp`,
      headers: {},
      oauthEnabled: false,
    });

    const response = await fetch(service.getProxyUrl(routeId), {
      method: 'GET',
    });
    expect(response.status).toBe(200);

    const updateResult = await Promise.race([
      service.updatePort(secondProxyPort).then((): 'updated' => 'updated'),
      wait(750).then((): 'timeout' => 'timeout'),
    ]);

    expect(updateResult).toBe('updated');
    await expect(
      fetch(`http://127.0.0.1:${String(secondProxyPort)}/health`),
    ).resolves.toHaveProperty('status', 200);

    for (const streamResponse of streamResponses) {
      if (!streamResponse.destroyed) {
        streamResponse.end();
      }
    }
    await close(upstream);
  });

  it('keeps the current listener alive when a requested port is occupied', async () => {
    const firstProxyPort = await getFreePort();
    await service.ensureStarted(firstProxyPort);

    const occupied = createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('occupied');
    });
    const occupiedPort = await listen(occupied);

    try {
      await expect(service.updatePort(occupiedPort)).rejects.toThrow(
        'already in use',
      );
      expect(service.getState()).toMatchObject({
        port: firstProxyPort,
        status: 'running',
      });
      await expect(
        fetch(`http://127.0.0.1:${String(firstProxyPort)}/health`),
      ).resolves.toHaveProperty('status', 200);
    } finally {
      await close(occupied);
    }
  });

  it('fully stops listening and clears runtime state on shutdown', async () => {
    const proxyPort = await getFreePort();
    await service.ensureStarted(proxyPort);
    const routeId = await service.registerRoute({
      sessionId: 'session-1',
      serverId: 'server-1',
      configId: 'config-1',
      displayName: 'Server',
      upstreamUrl: 'http://127.0.0.1:1/mcp',
      headers: {},
      oauthEnabled: false,
    });

    await service.shutdown();

    expect(service.isRunning()).toBe(false);
    expect(() => service.getProxyUrl(routeId)).toThrow(
      'MCP proxy is not started.',
    );
    await expect(
      fetch(`http://127.0.0.1:${String(proxyPort)}/health`),
    ).rejects.toThrow();
  });

  it('keeps the current port when routes are still registered', async () => {
    const firstProxyPort = await getFreePort();
    const secondProxyPort = await getFreePort();
    await service.ensureStarted(firstProxyPort);
    const routeId = await service.registerRoute({
      sessionId: 'session-1',
      serverId: 'server-1',
      configId: 'config-1',
      displayName: 'Server',
      upstreamUrl: 'http://127.0.0.1:1/mcp',
      headers: {},
      oauthEnabled: false,
    });

    await service.ensureStarted(secondProxyPort);

    expect(service.getProxyUrl(routeId)).toBe(
      `http://127.0.0.1:${String(firstProxyPort)}/canopy/mcp/proxy/${routeId}`,
    );
    await expect(
      fetch(`http://127.0.0.1:${String(firstProxyPort)}/health`),
    ).resolves.toHaveProperty('status', 200);
  });
});

describe('McpHttpProxyService Ledger tools', () => {
  const LEDGER_TOOL_NAMES = [
    'AddFeedEntry',
    'SearchFeedEntries',
    'UpdateFeedEntry',
  ];
  const ledgerTools = { execute: jest.fn() };
  let service: McpHttpProxyService;

  async function registerRoute(
    sessionKey: string,
    toolSurface:
      | 'native-sdk'
      | 'native-sdk-standalone'
      | 'claude-code-terminal'
      | 'cursor-acp'
      | 'claude-worker',
    withLedgerTools: boolean,
  ): Promise<string> {
    await service.registerCanopyWorktreeSessionRoute({
      sessionKey,
      projectId: 'project-1',
      worktreeId: 'wt-1',
      chatId: 'chat-1',
      toolSurface,
      cwd: '/mock/worktree',
      sdkSessionId: 'sdk-1',
      authToken: 'secret-token',
      createdAt: Date.now(),
      hookHandler: jest.fn(),
      ...(toolSurface === 'claude-worker'
        ? { workerMemoryToolExposure: 'read-write' as const }
        : {}),
      ...(withLedgerTools ? { ledgerTools } : {}),
    });
    return service.getCanopyWorktreeMcpUrl(sessionKey);
  }

  async function rpc(url: string, body: object): Promise<unknown> {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer secret-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ jsonrpc: '2.0', ...body }),
    });
    const payload: unknown = await response.json();
    return payload;
  }

  function ledgerCalls(): ExecuteCanopyInjectedToolCall[] {
    return mockExecuteCanopyInjectedTool.mock.calls.filter(
      ([key]) =>
        key.endsWith('_ledger_entry') || key.endsWith('_ledger_entries'),
    );
  }

  beforeEach(async () => {
    jest.clearAllMocks();
    mockIsEnabled.mockReturnValue(true);
    service = new McpHttpProxyService();
    mockExecuteCanopyInjectedTool.mockResolvedValue({ text: 'ok' });
    await service.ensureStarted(await getFreePort());
  });

  afterEach(async () => {
    await service.shutdown();
  });

  it.each([
    'native-sdk',
    'native-sdk-standalone',
    'claude-code-terminal',
    'cursor-acp',
  ] as const)(
    'advertises the Ledger tools on %s only to a session that passed the gate',
    async (toolSurface) => {
      const exposed = await registerRoute(
        `exposed-${toolSurface}`,
        toolSurface,
        true,
      );
      const hidden = await registerRoute(
        `hidden-${toolSurface}`,
        toolSurface,
        false,
      );

      const exposedList = await rpc(exposed, { id: 1, method: 'tools/list' });
      const hiddenNames = getListedToolNames(
        await rpc(hidden, { id: 2, method: 'tools/list' }),
      );

      expect(getListedToolNames(exposedList)).toEqual(
        expect.arrayContaining(LEDGER_TOOL_NAMES),
      );
      for (const name of LEDGER_TOOL_NAMES) {
        expect(hiddenNames).not.toContain(name);
      }
      const tools =
        isRecord(exposedList) &&
        isRecord(exposedList.result) &&
        Array.isArray(exposedList.result.tools)
          ? exposedList.result.tools.filter(isRecord)
          : [];
      const add = tools.find((tool) => tool.name === 'AddFeedEntry');
      expect(add?.description).toEqual(
        expect.stringContaining('Allowed in Plan mode as bookkeeping'),
      );
      expect(add?.inputSchema).toMatchObject({
        type: 'object',
        required: ['type', 'title', 'content'],
        additionalProperties: false,
      });
    },
  );

  it.each(['native-sdk', 'native-sdk-standalone'] as const)(
    'retains project discovery targets through Claude HTTP MCP %s',
    async (surface) => {
      const url = await registerRoute(
        `project-discovery-${surface}`,
        surface,
        false,
      );
      for (const action of [
        { type: 'projects.list' },
        { type: 'projects.list_tasks', projectId: 'cross-project' },
        {
          type: 'projects.list_task_chats',
          projectId: 'cross-project',
          taskId: 'cross-task',
        },
        ...PROJECT_READ_ACTION_TYPES.map((type) => ({
          type,
          projectId: 'cross-project',
          taskId: 'cross-task',
          chatId: 'cross-chat',
          ...(type === 'projects.read_history'
            ? {
                pageSize: 7,
                order: 'asc',
                roles: ['assistant'],
                query: 'visible',
                cursor: 'opaque',
              }
            : {}),
        })),
      ]) {
        await rpc(url, {
          id: action.type,
          method: 'tools/call',
          params: { name: 'DispatchAction', arguments: { action } },
        });
        expect(mockExecuteCanopyInjectedTool).toHaveBeenLastCalledWith(
          'dispatch_action',
          { action },
          expect.any(Object),
          { toolUseId: action.type },
        );
      }
    },
  );

  it('advertises and runs the Ledger tools on a pipeline agent worker route', async () => {
    // Phase 08: a pipeline agent's session carries Ledger tools on the shared
    // worker transport; only its route lists and runs them.
    const url = await registerRoute('pipeline-worker', 'claude-worker', true);

    const names = getListedToolNames(
      await rpc(url, { id: 1, method: 'tools/list' }),
    );
    await rpc(url, {
      id: 2,
      method: 'tools/call',
      params: {
        name: 'SearchFeedEntries',
        arguments: {},
        _meta: { 'claudecode/toolUseId': 'toolu_pipeline' },
      },
    });

    expect(names).toEqual(expect.arrayContaining(LEDGER_TOOL_NAMES));
    const [call] = ledgerCalls();
    expect(call?.[0]).toBe('search_ledger_entries');
    expect(isRecord(call?.[2]) && call[2].ledgerRuntime).toBe(ledgerTools);
    expect(call?.[3]).toMatchObject({ invocationId: 'claude:toolu_pipeline' });
  });

  it('never advertises or runs the Ledger tools on a helper worker route', async () => {
    // T17: background helpers on the shared worker transport get no Ledger
    // tools; their route has no runtime, so the tools do not exist there.
    const url = await registerRoute('helper-worker', 'claude-worker', false);

    const names = getListedToolNames(
      await rpc(url, { id: 1, method: 'tools/list' }),
    );
    const call = await rpc(url, {
      id: 2,
      method: 'tools/call',
      params: { name: 'AddFeedEntry', arguments: {} },
    });

    for (const name of LEDGER_TOOL_NAMES) {
      expect(names).not.toContain(name);
    }
    expect(call).toMatchObject({ error: { code: -32602 } });
    expect(ledgerCalls()).toEqual([]);
  });

  describe('on managed Claude Code terminal and Cursor routes', () => {
    interface ScopedRoute {
      readonly url: string;
      readonly token: string;
      readonly runtime: { execute: jest.Mock };
    }

    async function registerScopedRoute(options: {
      readonly sessionKey: string;
      readonly worktreeId: string;
      readonly toolSurface: 'claude-code-terminal' | 'cursor-acp';
      readonly withLedgerTools: boolean;
    }): Promise<ScopedRoute> {
      const token = `token-${options.sessionKey}`;
      const runtime = { execute: jest.fn() };
      await service.registerCanopyWorktreeSessionRoute({
        sessionKey: options.sessionKey,
        projectId: 'project-1',
        worktreeId: options.worktreeId,
        chatId: `chat-${options.sessionKey}`,
        toolSurface: options.toolSurface,
        cwd: '/mock/worktree',
        sdkSessionId: `sdk-${options.sessionKey}`,
        authToken: token,
        createdAt: Date.now(),
        hookHandler: jest.fn(),
        ...(options.withLedgerTools ? { ledgerTools: runtime } : {}),
      });
      return {
        url: service.getCanopyWorktreeMcpUrl(options.sessionKey),
        token,
        runtime,
      };
    }

    async function rpcAs(
      url: string,
      token: string,
      body: object,
    ): Promise<{ status: number; payload: unknown }> {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ jsonrpc: '2.0', ...body }),
      });
      const text = await response.text();
      const payload: unknown = text.length > 0 ? JSON.parse(text) : null;
      return { status: response.status, payload };
    }

    function ledgerRuntimeOf(runtime: unknown): unknown {
      return isRecord(runtime) ? runtime.ledgerRuntime : undefined;
    }

    it.each(['claude-code-terminal', 'cursor-acp'] as const)(
      'routes Add, Search and Update on %s to the session own Ledger runtime',
      async (toolSurface) => {
        const route = await registerScopedRoute({
          sessionKey: `own-${toolSurface}`,
          worktreeId: 'wt-own',
          toolSurface,
          withLedgerTools: true,
        });
        const calls = [
          ['AddFeedEntry', 'add_ledger_entry'],
          ['SearchFeedEntries', 'search_ledger_entries'],
          ['UpdateFeedEntry', 'update_ledger_entry'],
        ] as const;

        let id = 0;
        for (const [name] of calls) {
          id += 1;
          const { status } = await rpcAs(route.url, route.token, {
            id,
            method: 'tools/call',
            params: { name, arguments: { title: name } },
          });
          expect(status).toBe(200);
        }

        expect(ledgerCalls().map(([key]) => key)).toEqual(
          calls.map(([, key]) => key),
        );
        for (const [, args, runtime] of ledgerCalls()) {
          expect(ledgerRuntimeOf(runtime)).toBe(route.runtime);
          expect(isRecord(args) && args.title).toEqual(expect.any(String));
        }
      },
    );

    it.each(['claude-code-terminal', 'cursor-acp'] as const)(
      '%s retains project discovery arguments on its HTTP root route',
      async (toolSurface) => {
        const route = await registerScopedRoute({
          sessionKey: `projects-${toolSurface}`,
          worktreeId: 'origin-task',
          toolSurface,
          withLedgerTools: false,
        });
        for (const action of [
          { type: 'projects.list' },
          { type: 'projects.list_tasks', projectId: 'target-project' },
          {
            type: 'projects.list_task_chats',
            projectId: 'target-project',
            taskId: 'target-task',
          },
          ...PROJECT_READ_ACTION_TYPES.map((type) => ({
            type,
            projectId: 'cross-project',
            taskId: 'cross-task',
            chatId: 'cross-chat',
            ...(type === 'projects.read_history'
              ? {
                  pageSize: 7,
                  order: 'asc',
                  roles: ['assistant'],
                  query: 'visible',
                  cursor: 'opaque',
                }
              : {}),
          })),
        ]) {
          const response = await rpcAs(route.url, route.token, {
            id: action.type,
            method: 'tools/call',
            params: { name: 'DispatchAction', arguments: { action } },
          });
          expect(response.status).toBe(200);
          const lastCall = mockExecuteCanopyInjectedTool.mock.calls.at(-1);
          expect(lastCall?.[0]).toBe('dispatch_action');
          expect(lastCall?.[1]).toEqual({ action });
          expect(lastCall?.[2]).toMatchObject({
            worktreeActionRuntime: {
              projectId: 'project-1',
              worktreeId: 'origin-task',
            },
          });
        }
      },
    );

    it.each(['claude-code-terminal', 'cursor-acp'] as const)(
      'lists no Ledger tools on %s without a runtime and answers a call with no_ledger_scope',
      async (toolSurface) => {
        const route = await registerScopedRoute({
          sessionKey: `hidden-${toolSurface}`,
          worktreeId: 'wt-hidden',
          toolSurface,
          withLedgerTools: false,
        });

        const list = await rpcAs(route.url, route.token, {
          id: 1,
          method: 'tools/list',
        });
        const call = await rpcAs(route.url, route.token, {
          id: 2,
          method: 'tools/call',
          params: { name: 'SearchFeedEntries', arguments: {} },
        });

        const names = getListedToolNames(list.payload);
        expect(names.length).toBeGreaterThan(0);
        for (const name of LEDGER_TOOL_NAMES) {
          expect(names).not.toContain(name);
        }
        expect(call.payload).toMatchObject({
          result: { isError: true, content: [{ type: 'text' }] },
        });
        const text = JSON.stringify(call.payload);
        expect(text).toContain('FEED_UNAVAILABLE');
        expect(text).toContain('no_ledger_scope');
        expect(ledgerCalls()).toEqual([]);
      },
    );

    it('binds each call to the route session scope, never to another worktree session or the tool arguments', async () => {
      const terminal = await registerScopedRoute({
        sessionKey: 'terminal-a',
        worktreeId: 'wt-a',
        toolSurface: 'claude-code-terminal',
        withLedgerTools: true,
      });
      const cursor = await registerScopedRoute({
        sessionKey: 'cursor-b',
        worktreeId: 'wt-b',
        toolSurface: 'cursor-acp',
        withLedgerTools: true,
      });

      // Worktree B's session names worktree A in its arguments: the call
      // still runs with B's own runtime, since scope comes from the route.
      await rpcAs(cursor.url, cursor.token, {
        id: 1,
        method: 'tools/call',
        params: {
          name: 'AddFeedEntry',
          arguments: {
            type: 'TASK',
            title: 'Spoof',
            content: 'x',
            projectId: 'project-1',
            worktreeId: 'wt-a',
          },
        },
      });
      // B's credentials cannot open worktree A's route.
      const crossed = await rpcAs(terminal.url, cursor.token, {
        id: 2,
        method: 'tools/call',
        params: { name: 'SearchFeedEntries', arguments: {} },
      });
      await rpcAs(terminal.url, terminal.token, {
        id: 3,
        method: 'tools/call',
        params: { name: 'SearchFeedEntries', arguments: {} },
      });

      expect(crossed.status).toBe(401);
      const runtimes = ledgerCalls().map(([key, , runtime]) => [
        key,
        ledgerRuntimeOf(runtime),
      ]);
      expect(runtimes).toEqual([
        ['add_ledger_entry', cursor.runtime],
        ['search_ledger_entries', terminal.runtime],
      ]);
    });

    it('keys a terminal call by its Claude tool use ID and a Cursor call by the per-route fallback', async () => {
      const terminal = await registerScopedRoute({
        sessionKey: 'terminal-identity',
        worktreeId: 'wt-a',
        toolSurface: 'claude-code-terminal',
        withLedgerTools: true,
      });
      const cursor = await registerScopedRoute({
        sessionKey: 'cursor-identity',
        worktreeId: 'wt-b',
        toolSurface: 'cursor-acp',
        withLedgerTools: true,
      });

      await rpcAs(terminal.url, terminal.token, {
        id: 1,
        method: 'tools/call',
        params: {
          name: 'SearchFeedEntries',
          arguments: {},
          _meta: { 'claudecode/toolUseId': 'toolu_terminal' },
        },
      });
      // The pinned Cursor CLI calls tools with only a name and arguments.
      await rpcAs(cursor.url, cursor.token, {
        id: 1,
        method: 'tools/call',
        params: { name: 'SearchFeedEntries', arguments: {} },
      });

      const ids = ledgerCalls().map(([, , , context]) =>
        isRecord(context) ? context.invocationId : undefined,
      );
      expect(ids).toEqual([
        'claude:toolu_terminal',
        expect.stringMatching(/^mcp:.+:1$/),
      ]);
    });
  });

  it('refuses a Ledger call from a session without Ledger tools', async () => {
    const url = await registerRoute('no-ledger', 'native-sdk', false);

    const payload = await rpc(url, {
      id: 7,
      method: 'tools/call',
      params: { name: 'AddFeedEntry', arguments: {} },
    });

    expect(payload).toMatchObject({
      result: { isError: true, content: [{ type: 'text' }] },
    });
    expect(JSON.stringify(payload)).toContain('FEED_UNAVAILABLE');
    expect(ledgerCalls()).toEqual([]);
  });

  it('runs a Ledger call with the session runtime and the Claude tool use ID', async () => {
    const url = await registerRoute('claude-ledger', 'native-sdk', true);
    const args = { type: 'TASK', title: 'Plan', content: 'Plan the work.' };

    await rpc(url, {
      id: 8,
      method: 'tools/call',
      params: {
        name: 'AddFeedEntry',
        arguments: args,
        _meta: { 'claudecode/toolUseId': 'toolu_01ABC' },
      },
    });

    const [call] = ledgerCalls();
    const [key, callArgs, runtime, context] = call ?? [];
    expect(key).toBe('add_ledger_entry');
    expect(callArgs).toEqual(args);
    expect(isRecord(runtime) && runtime.ledgerRuntime).toBe(ledgerTools);
    expect(isRecord(context) && context.invocationId).toBe(
      'claude:toolu_01ABC',
    );
  });

  it('falls back to a per-route invocation ID when the CLI sends no tool use ID', async () => {
    const first = await registerRoute(
      'fallback-a',
      'native-sdk-standalone',
      true,
    );
    const second = await registerRoute(
      'fallback-b',
      'native-sdk-standalone',
      true,
    );
    const call = (url: string, id: number): Promise<unknown> =>
      rpc(url, {
        id,
        method: 'tools/call',
        params: { name: 'SearchFeedEntries', arguments: {} },
      });

    await call(first, 1);
    await call(first, 2);
    await call(second, 1);

    const ids = ledgerCalls().map(([, , , context]) =>
      isRecord(context) ? context.invocationId : undefined,
    );
    expect(ids).toHaveLength(3);
    for (const id of ids) {
      expect(id).toEqual(expect.stringMatching(/^mcp:/));
    }
    expect(new Set(ids).size).toBe(3);
  });
});

describe('McpHttpProxyService assistant dispatch request ids (CAN-3976)', () => {
  let service: McpHttpProxyService;

  interface FakeRenderer {
    window: BrowserWindow;
    requests: Record<string, unknown>[];
  }

  // Stands in for the renderer bridge: records each delivered request and
  // answers it through the registered response IPC handler, echoing the
  // request's identity the way the real bridges do.
  function createFakeRenderer(
    requestChannel: string,
    responseChannel: string,
    answer: (request: Record<string, unknown>) => Record<string, unknown>,
  ): FakeRenderer {
    const requests: Record<string, unknown>[] = [];
    const webContents = {
      isDestroyed: () => false,
      isCrashed: () => false,
      mainFrame: { isDestroyed: () => false, detached: false },
      send: (channel: string, request: unknown) => {
        if (channel !== requestChannel || !isRecord(request)) return;
        requests.push(request);
        setImmediate(() => {
          void mockRegisteredIpcHandlers.get(responseChannel)?.(
            undefined,
            answer(request),
          );
        });
      },
    };
    return {
      window: {
        isDestroyed: () => false,
        webContents,
      } as unknown as BrowserWindow,
      requests,
    };
  }

  function createAdvisorRenderer(): FakeRenderer {
    return createFakeRenderer(
      IPC_CHANNELS.appAdvisorToolRequest,
      IPC_CHANNELS.appAdvisorToolResponse,
      (request) => {
        const action = isRecord(request.action) ? request.action : {};
        return {
          requestId: request.requestId,
          ...(typeof request.originChatTabId === 'string'
            ? { originChatId: request.originChatTabId }
            : {}),
          ok: true,
          result: {
            executedAction: String(action.type),
            executedFor: String(request.originChatTabId),
          },
        };
      },
    );
  }

  function createPipelineEditorRenderer(): FakeRenderer {
    return createFakeRenderer(
      IPC_CHANNELS.pipelineEditorToolRequest,
      IPC_CHANNELS.pipelineEditorToolResponse,
      (request) => ({
        requestId: request.requestId,
        ...(typeof request.originChatId === 'string'
          ? { originChatId: request.originChatId }
          : {}),
        ok: true,
        pipelineYaml: String(request.yaml),
      }),
    );
  }

  async function registerAdvisorRoute(
    chatId: string,
    renderer: FakeRenderer,
  ): Promise<string> {
    const sessionKey = `advisor-${chatId}`;
    await service.registerCanopyWorktreeSessionRoute({
      sessionKey,
      projectId: APP_ADVISOR_PROJECT_ID,
      worktreeId: 'advisor-entry',
      chatId,
      assistantMode: 'app-advisor',
      authToken: `${sessionKey}-token`,
      createdAt: Date.now(),
      hookHandler: jest.fn(),
      appAdvisorRuntime: createAppAdvisorToolRuntime(
        {
          getMainWindow: () => renderer.window,
          getAppAdvisorWindow: () => renderer.window,
          openAppAdvisorWindow: () =>
            Promise.resolve({ open: true, focused: true }),
          ensureAppAdvisorWindow: () =>
            Promise.resolve({ open: true, focused: true }),
        },
        {
          projectId: APP_ADVISOR_PROJECT_ID,
          worktreeId: 'advisor-entry',
          chatId,
        },
      ),
    });
    return sessionKey;
  }

  async function registerPipelineEditorRoute(
    chatId: string,
    renderer: FakeRenderer,
    cursorGate?: () => Promise<boolean>,
  ): Promise<string> {
    const sessionKey = `pipeline-editor-${chatId}`;
    await service.registerCanopyWorktreeSessionRoute({
      sessionKey,
      projectId: PIPELINE_EDITOR_PROJECT_ID,
      worktreeId: PIPELINE_EDITOR_WORKTREE_ID,
      chatId,
      assistantMode: 'pipeline-editor',
      ...(cursorGate
        ? { providerType: 'cursor', authorizeToolCall: cursorGate }
        : {}),
      authToken: `${sessionKey}-token`,
      createdAt: Date.now(),
      hookHandler: jest.fn(),
      pipelineEditorRuntime: createPipelineEditorToolRuntime(
        { getMainWindow: () => renderer.window },
        {
          projectId: PIPELINE_EDITOR_PROJECT_ID,
          worktreeId: PIPELINE_EDITOR_WORKTREE_ID,
          chatId,
          providerType: 'claude',
        },
      ),
    });
    return sessionKey;
  }

  async function callTool(
    sessionKey: string,
    id: number,
    name: string,
    args: Record<string, unknown>,
    toolUseId?: string,
  ): Promise<unknown> {
    const response = await fetch(service.getCanopyWorktreeMcpUrl(sessionKey), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${sessionKey}-token`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id,
        method: 'tools/call',
        params: {
          name,
          arguments: args,
          ...(toolUseId
            ? { _meta: { 'claudecode/toolUseId': toolUseId } }
            : {}),
        },
      }),
    });
    expect(response.status).toBe(200);
    const body = await response.text();
    const dataLine = body.split('\n').find((line) => line.startsWith('data: '));
    const message: unknown = JSON.parse(
      dataLine ? dataLine.slice('data: '.length) : body,
    );
    if (
      !isRecord(message) ||
      !isRecord(message.result) ||
      !Array.isArray(message.result.content)
    ) {
      throw new Error(`Unexpected tool response: ${body}`);
    }
    const content: unknown = message.result.content[0];
    if (!isRecord(content) || typeof content.text !== 'string') {
      throw new Error(`Unexpected tool content: ${body}`);
    }
    if (message.result.isError === true) return message.result;
    const parsed: unknown = JSON.parse(content.text);
    return parsed;
  }

  beforeEach(async () => {
    jest.clearAllMocks();
    mockIsEnabled.mockReturnValue(true);
    delete globalOverrides.__CANOPY_DEV_MCP_PROXY_PORT__;
    registerAppAdvisorHandlers({
      getMainWindow: () => null,
      getAppAdvisorWindow: () => null,
      openAppAdvisorWindow: () =>
        Promise.resolve({ open: true, focused: true }),
      ensureAppAdvisorWindow: () =>
        Promise.resolve({ open: true, focused: true }),
      closeAppAdvisorWindow: () =>
        Promise.resolve({ open: false, focused: false }),
      toggleAppAdvisorWindow: () =>
        Promise.resolve({ open: true, focused: true }),
      getAppAdvisorWindowState: () => ({ open: true, focused: true }),
      markAppAdvisorWindowRendererReady: () => ({ open: true, focused: true }),
      setAppAdvisorFloatingSize: () => ({ open: true, focused: true }),
    });
    registerPipelineEditorHandlers();
    service = new McpHttpProxyService();
    await service.ensureStarted(await getFreePort());
  });

  afterEach(async () => {
    await service.shutdown();
  });

  it('runs a second chat dispatch that reuses another chat JSON-RPC id', async () => {
    const renderer = createAdvisorRenderer();
    const firstChat = await registerAdvisorRoute('advisor-chat-a', renderer);
    const secondChat = await registerAdvisorRoute('advisor-chat-b', renderer);

    const first = await callTool(firstChat, 1, 'DispatchAction', {
      action: { type: 'navigation.open_settings' },
    });
    // A new MCP connection counts from 1 again.
    const second = await callTool(secondChat, 1, 'DispatchAction', {
      action: { type: 'navigation.go_to_page', page: 'automations' },
    });

    expect(renderer.requests.map((request) => request.action)).toEqual([
      { type: 'navigation.open_settings' },
      { type: 'navigation.go_to_page', page: 'automations' },
    ]);
    expect(first).toMatchObject({
      ok: true,
      result: {
        executedAction: 'navigation.open_settings',
        executedFor: 'advisor-chat-a',
      },
    });
    expect(second).toMatchObject({
      ok: true,
      result: {
        executedAction: 'navigation.go_to_page',
        executedFor: 'advisor-chat-b',
      },
    });
  });

  it('never uses the bare JSON-RPC id as the dispatch request id', async () => {
    const renderer = createAdvisorRenderer();
    const chat = await registerAdvisorRoute('advisor-chat-fallback', renderer);

    await callTool(chat, 1, 'DispatchAction', {
      action: { type: 'navigation.open_settings' },
    });
    await callTool(chat, 2, 'DispatchAction', {
      action: { type: 'navigation.open_settings' },
    });

    const requestIds = renderer.requests.map((request) => request.requestId);
    expect(requestIds).toHaveLength(2);
    expect(requestIds).not.toContain('1');
    expect(requestIds).not.toContain('2');
    expect(new Set(requestIds).size).toBe(2);
  });

  it('replays one response when the CLI resends the same tool use id', async () => {
    const renderer = createAdvisorRenderer();
    const chat = await registerAdvisorRoute('advisor-chat-retry', renderer);

    const first = await callTool(
      chat,
      4,
      'DispatchAction',
      { action: { type: 'navigation.open_settings' } },
      'toolu_advisor_retry',
    );
    // After MCP session recovery the CLI resends the call under a new
    // JSON-RPC id but the same tool use id.
    const resent = await callTool(
      chat,
      1,
      'DispatchAction',
      { action: { type: 'navigation.open_settings' } },
      'toolu_advisor_retry',
    );

    expect(renderer.requests).toHaveLength(1);
    expect(renderer.requests[0]?.requestId).toBe('toolu_advisor_retry');
    expect(resent).toEqual(first);
  });

  it('denies Cursor Pipeline Assistant execution before forwarding when ACP omitted permission', async () => {
    const renderer = createPipelineEditorRenderer();
    const gate = jest.fn(() => Promise.resolve(false));
    const session = await registerPipelineEditorRoute(
      'cursor-denied',
      renderer,
      gate,
    );
    const result = await callTool(session, 1, 'SetPipelineYaml', {
      yaml: 'name: unsafe',
    });
    expect(result).toMatchObject({ isError: true });
    expect(gate).toHaveBeenCalled();
    expect(renderer.requests).toHaveLength(0);
  });

  it('runs a second Pipeline Editor chat call that reuses another chat JSON-RPC id', async () => {
    const renderer = createPipelineEditorRenderer();
    const firstChat = await registerPipelineEditorRoute('editor-a', renderer);
    const secondChat = await registerPipelineEditorRoute('editor-b', renderer);

    const first = await callTool(firstChat, 1, 'SetPipelineYaml', {
      yaml: 'name: first',
    });
    const second = await callTool(secondChat, 1, 'SetPipelineYaml', {
      yaml: 'name: second',
    });

    expect(renderer.requests.map((request) => request.yaml)).toEqual([
      'name: first',
      'name: second',
    ]);
    expect(renderer.requests.map((request) => request.requestId)).not.toContain(
      '1',
    );
    expect(first).toMatchObject({ ok: true, pipelineYaml: 'name: first' });
    expect(second).toMatchObject({ ok: true, pipelineYaml: 'name: second' });
  });

  describe('deferred-tools reload delivery', () => {
    type AssistantKind = 'App Advisor' | 'Pipeline Editor';

    interface AssistantChat {
      sessionKey: string;
      scope: { projectId: string; worktreeId: string; chatId: string };
      renderer: FakeRenderer;
      call: (id: number, toolUseId?: string) => Promise<unknown>;
    }

    async function openAssistantChat(
      kind: AssistantKind,
      chatId: string,
    ): Promise<AssistantChat> {
      if (kind === 'App Advisor') {
        const renderer = createAdvisorRenderer();
        const sessionKey = await registerAdvisorRoute(chatId, renderer);
        return {
          sessionKey,
          scope: {
            projectId: APP_ADVISOR_PROJECT_ID,
            worktreeId: 'advisor-entry',
            chatId,
          },
          renderer,
          call: (id, toolUseId) =>
            callTool(
              sessionKey,
              id,
              'DispatchAction',
              { action: { type: 'navigation.open_settings' } },
              toolUseId,
            ),
        };
      }
      const renderer = createPipelineEditorRenderer();
      const sessionKey = await registerPipelineEditorRoute(chatId, renderer);
      return {
        sessionKey,
        scope: {
          projectId: PIPELINE_EDITOR_PROJECT_ID,
          worktreeId: PIPELINE_EDITOR_WORKTREE_ID,
          chatId,
        },
        renderer,
        call: (id, toolUseId) =>
          callTool(
            sessionKey,
            id,
            'SetPipelineYaml',
            { yaml: `name: ${chatId}` },
            toolUseId,
          ),
      };
    }

    let deliverySpy: { mockRestore: () => void } | undefined;

    // Delivery is marked after the response is written, so wait for it.
    function recordDeliveries(): {
      deliveries: { chatId: string; toolCallId: string }[];
      waitFor: (count: number) => Promise<void>;
    } {
      const deliveries: { chatId: string; toolCallId: string }[] = [];
      const waiters: (() => void)[] = [];
      deliverySpy = jest
        .spyOn(
          deferredToolsReloadCoordinator,
          'markToolResultDeliveredAndWaitForResume',
        )
        .mockImplementation((scope, toolCallId) => {
          deliveries.push({ chatId: scope.chatId, toolCallId });
          for (const waiter of waiters.splice(0)) waiter();
          return Promise.resolve(false);
        });
      const waitFor = async (count: number): Promise<void> => {
        while (deliveries.length < count) {
          await new Promise<void>((resolve) => waiters.push(resolve));
        }
      };
      return { deliveries, waitFor };
    }

    afterEach(() => {
      deliverySpy?.mockRestore();
      deliverySpy = undefined;
      deferredToolsReloadCoordinator.resetForTests();
    });

    it.each<AssistantKind>(['App Advisor', 'Pipeline Editor'])(
      'marks a %s reload delivered under the Claude tool use id it registered',
      async (kind) => {
        const chat = await openAssistantChat(kind, `${kind}-reload`);
        const intent = deferredToolsReloadCoordinator.createIntent({
          scope: chat.scope,
          toolCallId: 'toolu_deferred_reload',
          providerType: 'claude',
          additions: { skillRefs: [], pluginRefs: [], mcpServerRefs: [] },
          enabledResources: [],
        });
        expect(intent.accepted).toBe(true);
        const delivered = new Promise<string>((resolve) => {
          const unsubscribe = deferredToolsReloadCoordinator.subscribe(
            (event) => {
              unsubscribe();
              resolve(event.toolCallId);
            },
          );
        });

        await chat.call(7, 'toolu_deferred_reload');

        await expect(delivered).resolves.toBe('toolu_deferred_reload');
      },
    );

    it.each<AssistantKind>(['App Advisor', 'Pipeline Editor'])(
      'marks %s delivery under the chat-scoped id each chat registered for a shared JSON-RPC id',
      async (kind) => {
        const { deliveries, waitFor } = recordDeliveries();
        const first = await openAssistantChat(kind, `${kind}-first`);
        const second = await openAssistantChat(kind, `${kind}-second`);

        await first.call(1);
        await waitFor(1);
        await second.call(1);
        await waitFor(2);

        const registered = [first, second].map((chat) => ({
          chatId: chat.scope.chatId,
          toolCallId: chat.renderer.requests[0]?.requestId,
        }));
        expect(deliveries).toEqual(registered);
        expect(deliveries.map((delivery) => delivery.toolCallId)).not.toContain(
          '1',
        );
        expect(new Set(deliveries.map((d) => d.toolCallId)).size).toBe(2);
      },
    );

    it.each<AssistantKind>(['App Advisor', 'Pipeline Editor'])(
      'marks a resent %s call delivered under its tool use id, not its new JSON-RPC id',
      async (kind) => {
        const { deliveries, waitFor } = recordDeliveries();
        const chat = await openAssistantChat(kind, `${kind}-resend`);

        await chat.call(4, 'toolu_resent');
        await waitFor(1);
        await chat.call(1, 'toolu_resent');
        await waitFor(2);

        expect(deliveries.map((delivery) => delivery.toolCallId)).toEqual([
          'toolu_resent',
          'toolu_resent',
        ]);
      },
    );
  });
});
