import type { getCodexGatewayProxyService } from '../../agents/codex-gateway-proxy-service';
import type { ModelGatewayRequirement } from '@canopy/desktop-shared/lib/org-model-gateway';
import type {
  GatewayModelEntry,
  WorkOwner,
} from '@canopy/protocol/llm-gateway';
import type * as GatewayModelAvailability from '@canopy/desktop-shared/lib/gateway-model-availability';
import type { AccountProxyRouteTarget } from '../service';
import type { AccountProxyQuotaWait } from '../quota-wait';

type RouteOptions = Parameters<
  ReturnType<typeof getCodexGatewayProxyService>['registerRoute']
>[0];

let target: AccountProxyRouteTarget | null = null;
let gatewayRequirement: ModelGatewayRequirement = { kind: 'unrestricted' };
let storedClientKey: string | null = 'canopy-device-key';
let serving = true;
const registered: RouteOptions[] = [];
const recorded: Array<{
  sessionId: string;
  connectionId: string;
  traceHeader: string | null;
  label: string | null;
  movesChat?: boolean;
}> = [];

const rejected: string[] = [];
const mockWaitForCapacity = jest.fn<
  Promise<void>,
  Parameters<AccountProxyQuotaWait>
>(() => Promise.resolve());
jest.mock('../quota-wait', () => ({
  waitForAccountProxyCapacity: (
    ...args: Parameters<AccountProxyQuotaWait>
  ): Promise<void> => mockWaitForCapacity(...args),
}));
const mockServing = new AbortController();
jest.mock('../service', () => ({
  accountProxyServingSignal: (): AbortSignal => mockServing.signal,
  getAccountProxyRouteTarget: jest.fn(() => Promise.resolve(target)),
  isAccountProxyConnectionServing: jest.fn(() => serving),
  reportAccountProxyClientKeyRejected: (fingerprint: string): void => {
    rejected.push(fingerprint);
  },
  findAccountProxyAccount: (authIndex: string): unknown =>
    authIndex === 'a1f3c2d4a1f3c2d4' ? { label: 'sam@example.com' } : null,
}));
jest.mock('../../lib/model-gateway-state', () => ({
  getModelGatewayRequirementForOwner: jest.fn(() =>
    Promise.resolve(gatewayRequirement),
  ),
}));
const GATEWAY_ONLY_MODEL = 'org-gateway-only-model';
const GATEWAY_ONLY_ENTRY: GatewayModelEntry = {
  modelId: GATEWAY_ONLY_MODEL,
  gatewayId: 'anthropic/claude-sonnet-4-5',
  family: 'claude',
  recommendedHarness: 'claude',
  gatewayOnly: true,
  contextWindow: 200_000,
  supportsPromptCaching: true,
  supportedThinkingLevels: [],
  toolSchemaProfile: 'standard',
};
jest.mock('@canopy/desktop-shared/lib/gateway-model-availability', () => {
  const actual = jest.requireActual<typeof GatewayModelAvailability>(
    '@canopy/desktop-shared/lib/gateway-model-availability',
  );
  return {
    ...actual,
    resolveGatewayModelEntry: (
      model: string | undefined,
    ): ReturnType<typeof actual.resolveGatewayModelEntry> =>
      model === GATEWAY_ONLY_MODEL
        ? GATEWAY_ONLY_ENTRY
        : actual.resolveGatewayModelEntry(model),
  };
});
jest.mock('../../lib/account-proxy-credential-store', () => ({
  loadAccountProxyCredentials: jest.fn(() =>
    Promise.resolve({ managementKey: 'mk-test', clientKey: storedClientKey }),
  ),
}));
jest.mock('../feature-flag', () => ({
  isAccountProxyFlagEnabled: (): boolean => true,
}));
jest.mock('../attribution', () => ({
  recordAccountProxyResponse: jest.fn(
    (options: {
      sessionId: string;
      connectionId: string;
      traceHeader: string | null;
      lookupAccount: (authIndex: string) => { label: string } | null;
      movesChat?: boolean;
    }) => {
      recorded.push({
        sessionId: options.sessionId,
        connectionId: options.connectionId,
        traceHeader: options.traceHeader,
        label: options.lookupAccount('a1f3c2d4a1f3c2d4')?.label ?? null,
        movesChat: options.movesChat,
      });
    },
  ),
}));
jest.mock('../../agents/codex-gateway-proxy-service', () => ({
  getCodexGatewayProxyService: (): {
    registerRoute: (
      options: RouteOptions,
    ) => Promise<{ routeId: string; baseUrl: string }>;
  } => ({
    registerRoute: (options): Promise<{ routeId: string; baseUrl: string }> => {
      registered.push(options);
      return Promise.resolve({
        routeId: 'route-1',
        baseUrl: 'http://127.0.0.1:4100/codex-gateway/route-1',
      });
    },
  }),
}));

import { accountProxyClientKeyFingerprint } from '../client-key';
import { getAccountProxyRouteTarget } from '../service';
import { getModelGatewayRequirementForOwner } from '../../lib/model-gateway-state';
import {
  previewAccountProxySessionRoute,
  resolveAccountProxySessionRoute,
} from '../routing';

const CONNECTION = {
  id: 'connection-1',
  kind: 'server',
  url: 'https://proxy.example.com',
} as const;

function readyTarget(
  overrides: Partial<AccountProxyRouteTarget> = {},
): AccountProxyRouteTarget {
  return {
    connection: CONNECTION,
    clientKey: 'canopy-device-key',
    keepChatOnOneAccount: true,
    readyAccounts: 2,
    noUsableAccounts: null,
    ...overrides,
  };
}

function lastRoute(): RouteOptions {
  const route = registered.at(-1);
  if (!route) throw new Error('No route was registered.');
  return route;
}

describe('resolveAccountProxySessionRoute', () => {
  beforeEach(() => {
    mockWaitForCapacity.mockClear();
    target = readyTarget();
    gatewayRequirement = { kind: 'unrestricted' };
    storedClientKey = 'canopy-device-key';
    serving = true;
    registered.length = 0;
    recorded.length = 0;
    rejected.length = 0;
  });

  it('rejects a preview when the required proxy connection was replaced', async () => {
    await expect(
      previewAccountProxySessionRoute({
        harness: 'claude',
        model: 'opus',
        requiredConnectionId: 'removed-connection',
        resolveWorkOwner: () => Promise.resolve(undefined),
      }),
    ).resolves.toBe(false);
    expect(registered).toHaveLength(0);
  });

  it('rejects a replaced pinned connection before waiting on its exhausted pool', async () => {
    target = readyTarget({ readyAccounts: 0 });
    await expect(
      resolveAccountProxySessionRoute({
        harness: 'codex',
        model: 'gpt-5.5',
        sessionId: 'pipeline-continuation',
        requiredConnectionId: 'removed-connection',
        resolveWorkOwner: () => Promise.resolve(undefined),
      }),
    ).rejects.toThrow('connection for this continuation is unavailable');
    expect(mockWaitForCapacity).not.toHaveBeenCalled();
    expect(registered).toHaveLength(0);
  });

  it('uses the usual billing when the proxy cannot be checked', async () => {
    // A helper or session must not fail because the proxy settings could not
    // be read; it falls back as it does for an unreachable server.
    jest
      .mocked(getAccountProxyRouteTarget)
      .mockRejectedValueOnce(new Error('preferences unreadable'));
    await expect(
      resolveAccountProxySessionRoute({
        harness: 'claude',
        model: 'claude-sonnet-4-5',
        sessionId: 'ephemeral:helper:1',
        resolveWorkOwner: () => Promise.resolve(undefined),
      }),
    ).resolves.toBeNull();
  });

  it('points a Claude session at a loopback route to the proxy', async () => {
    const route = await resolveAccountProxySessionRoute({
      harness: 'claude',
      model: 'claude-sonnet-4-5',
      sessionId: 'canopy:my-repo:feature-branch:chat-1',
      resolveWorkOwner: () => Promise.resolve(undefined),
    });
    expect(route?.env).toEqual({
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:4100/codex-gateway/route-1',
      ANTHROPIC_AUTH_TOKEN: 'canopy-loopback-broker',
      ANTHROPIC_API_KEY: '',
      // Either flag makes Claude Code skip the base URL for a cloud provider.
      CLAUDE_CODE_USE_BEDROCK: '',
      CLAUDE_CODE_USE_VERTEX: '',
    });
    // Who serves it: the connection, not the per-resolution loopback route.
    expect(route?.accountKey).toBe('account-proxy:connection-1');
    const options = lastRoute();
    expect(options.upstreamUrl).toBe('https://proxy.example.com');
    expect(options.allowedPaths).toEqual([
      '/v1/messages',
      '/v1/messages/count_tokens',
    ]);
    // Canopy's own attribution headers never reach a third-party server.
    expect(options.forwardCanopyHeaders).toBe(false);
    expect(options.forwardHeaders).toEqual(
      expect.arrayContaining(['anthropic-beta']),
    );
    // Only Canopy's ids go out, so the harness's own headers cannot outrank
    // them where the proxy reads headers (see routing.ts).
    expect(options.forwardHeaders).not.toContain('x-claude-code-session-id');
    expect(options.forwardHeaders).not.toContain('x-claude-code-agent-id');
  });

  it('cancels its requests when the proxy stops serving', async () => {
    await resolveAccountProxySessionRoute({
      harness: 'codex',
      model: 'gpt-5.5',
      sessionId: 'canopy:my-repo:feature-branch:chat-1',
      resolveWorkOwner: () => Promise.resolve(undefined),
    });
    expect(lastRoute().upstreamSignal?.()).toBe(mockServing.signal);
  });

  it('sends a stable session id that does not reveal the session key', async () => {
    const sessionId = 'canopy:my-repo:feature-branch:chat-1';
    await resolveAccountProxySessionRoute({
      harness: 'claude',
      model: 'claude-sonnet-4-5',
      sessionId,
      parentSessionId: 'canopy:my-repo:feature-branch:parent',
      resolveWorkOwner: () => Promise.resolve(undefined),
    });
    const first = lastRoute().extraHeaders;
    await resolveAccountProxySessionRoute({
      harness: 'claude',
      model: 'claude-sonnet-4-5',
      sessionId,
      resolveWorkOwner: () => Promise.resolve(undefined),
    });
    const second = lastRoute().extraHeaders;
    expect(Object.keys(first ?? {}).sort()).toEqual([
      'x-parent-session-id',
      'x-session-id',
    ]);
    expect(first?.['x-session-id']).toMatch(/^canopy-[a-f0-9]{32}$/);
    expect(first?.['x-parent-session-id']).toMatch(/^canopy-[a-f0-9]{32}$/);
    expect(JSON.stringify(first)).not.toContain('my-repo');
    expect(second).toEqual({ 'x-session-id': first?.['x-session-id'] });
  });

  it('sends no session ids when the chat may move between accounts', async () => {
    target = readyTarget({ keepChatOnOneAccount: false });
    await resolveAccountProxySessionRoute({
      harness: 'claude',
      model: 'claude-sonnet-4-5',
      sessionId: 'chat-1',
      resolveWorkOwner: () => Promise.resolve(undefined),
    });
    expect(lastRoute().extraHeaders).toEqual({});
    expect(lastRoute().forwardHeaders).not.toContain(
      'x-claude-code-session-id',
    );
  });

  it('gives a Codex session its own provider block and keeps the model', async () => {
    const route = await resolveAccountProxySessionRoute({
      harness: 'codex',
      model: 'gpt-5.1-codex',
      sessionId: 'chat-1',
      resolveWorkOwner: () => Promise.resolve(undefined),
    });
    expect(route?.env).toEqual({});
    expect(route?.codexConfig).toEqual({
      model_provider: 'canopy_account_proxy',
      model_providers: {
        canopy_account_proxy: {
          name: 'Account proxy',
          base_url: 'http://127.0.0.1:4100/codex-gateway/route-1',
          wire_api: 'responses',
          requires_openai_auth: false,
        },
      },
    });
    expect(lastRoute().upstreamUrl).toBe('https://proxy.example.com/v1');
    expect(lastRoute().allowedPaths).toEqual(['/responses']);
    expect(lastRoute().forwardHeaders).not.toContain('session_id');
    expect(lastRoute().forwardHeaders).not.toContain('thread-id');
    expect(lastRoute().forwardHeaders).not.toContain('x-codex-turn-metadata');
  });

  it('sends the device key upstream, read again for every request', async () => {
    await resolveAccountProxySessionRoute({
      harness: 'claude',
      model: 'claude-sonnet-4-5',
      sessionId: 'chat-1',
      resolveWorkOwner: () => Promise.resolve(undefined),
    });
    const { resolveToken } = lastRoute();
    // The broker gets a fingerprint to report refusals by, never the key.
    await expect(resolveToken()).resolves.toEqual({
      token: 'canopy-device-key',
      credentialVersion: accountProxyClientKeyFingerprint('canopy-device-key'),
    });
    storedClientKey = null;
    await expect(resolveToken()).resolves.toBe('canopy-open-server');
  });

  it('reports a refused client key so the next session replaces it', async () => {
    await resolveAccountProxySessionRoute({
      harness: 'claude',
      model: 'claude-sonnet-4-5',
      sessionId: 'chat-1',
      resolveWorkOwner: () => Promise.resolve(undefined),
    });
    const { onCredentialRejected } = lastRoute();
    await onCredentialRejected?.(401, 'fingerprint-1');
    expect(rejected).toEqual(['fingerprint-1']);
  });

  it('records the account named by each response', async () => {
    await resolveAccountProxySessionRoute({
      harness: 'claude',
      model: 'claude-sonnet-4-5',
      sessionId: 'chat-1',
      resolveWorkOwner: () => Promise.resolve(undefined),
    });
    const { onUpstreamResponse } = lastRoute();
    if (!onUpstreamResponse) throw new Error('No hook.');
    onUpstreamResponse({
      status: 200,
      path: '/v1/messages',
      headers: new Headers({
        'x-cpa-trace-id': '20261012204400-a1f3c2d4a1f3c2d4-0001',
      }),
    });
    // The account is named from the last account list read.
    expect(recorded).toEqual([
      {
        sessionId: 'chat-1',
        connectionId: 'connection-1',
        traceHeader: '20261012204400-a1f3c2d4a1f3c2d4-0001',
        label: 'sam@example.com',
        movesChat: true,
      },
    ]);
  });

  it.each([
    ['claude', 200, '/v1/messages', true],
    ['claude', 200, '/v1/messages/count_tokens', false],
    ['claude', 429, '/v1/messages', false],
    ['claude', 500, '/v1/messages', false],
    ['codex', 200, '/responses', true],
    ['codex', 429, '/responses', false],
  ] as const)(
    'lets only a successful turn move a %s chat (%i %s)',
    async (harness, status, path, movesChat) => {
      await resolveAccountProxySessionRoute({
        harness,
        model: harness === 'claude' ? 'claude-sonnet-4-5' : 'gpt-5.5',
        sessionId: 'chat-1',
        resolveWorkOwner: () => Promise.resolve(undefined),
      });
      const { onUpstreamResponse } = lastRoute();
      if (!onUpstreamResponse) throw new Error('No hook.');
      onUpstreamResponse({
        status,
        path,
        headers: new Headers({
          'x-cpa-trace-id': '20261012204400-a1f3c2d4a1f3c2d4-0001',
        }),
      });
      expect(recorded).toEqual([expect.objectContaining({ movesChat })]);
    },
  );

  it('sends a stopped proxy on this device no key, so nothing is forwarded', async () => {
    target = readyTarget({
      connection: {
        id: 'local-1',
        kind: 'local',
        url: 'http://127.0.0.1:21455',
      },
    });
    await resolveAccountProxySessionRoute({
      harness: 'claude',
      model: 'claude-sonnet-4-5',
      sessionId: 'chat-1',
      resolveWorkOwner: () => Promise.resolve(undefined),
    });
    const route = lastRoute();
    await expect(route.resolveToken()).resolves.not.toBeNull();
    serving = false;
    await expect(route.resolveToken()).resolves.toBeNull();
  });

  it('keeps local Ollama models on this device', async () => {
    await expect(
      resolveAccountProxySessionRoute({
        harness: 'claude',
        model: 'ollama-llama3',
        sessionId: 'chat-1',
        resolveWorkOwner: () => Promise.resolve(undefined),
      }),
    ).resolves.toBeNull();
    await expect(
      previewAccountProxySessionRoute({
        harness: 'claude',
        model: 'ollama-llama3',
        resolveWorkOwner: () => Promise.resolve(undefined),
      }),
    ).resolves.toBe(false);
    expect(registered).toHaveLength(0);
  });

  it('keeps proxy billing while all accounts cool down and waits before registering the route', async () => {
    target = readyTarget({ readyAccounts: 0 });
    await expect(
      previewAccountProxySessionRoute({
        harness: 'claude',
        model: 'claude-sonnet-4-5',
        resolveWorkOwner: () => Promise.resolve(undefined),
      }),
    ).resolves.toBe(true);
    mockWaitForCapacity.mockImplementationOnce(() => {
      target = readyTarget();
      return Promise.resolve();
    });
    await expect(
      resolveAccountProxySessionRoute({
        harness: 'claude',
        model: 'claude-sonnet-4-5',
        sessionId: 'chat',
        resolveWorkOwner: () => Promise.resolve(undefined),
      }),
    ).resolves.toMatchObject({ accountKey: 'account-proxy:connection-1' });
    expect(mockWaitForCapacity).toHaveBeenCalled();
  });

  it.each(['claude', 'codex'] as const)(
    'fails a %s session at once when the proxy has no account that can serve it',
    async (harness) => {
      const message = `The account proxy has no ${harness === 'claude' ? 'Claude' : 'Codex'} accounts.`;
      target = readyTarget({ readyAccounts: 0, noUsableAccounts: message });
      await expect(
        resolveAccountProxySessionRoute({
          harness,
          model: harness === 'claude' ? 'claude-sonnet-4-5' : 'gpt-5.5',
          sessionId: 'chat',
          resolveWorkOwner: () => Promise.resolve(undefined),
        }),
      ).rejects.toThrow(message);
      expect(mockWaitForCapacity).not.toHaveBeenCalled();
      expect(registered).toHaveLength(0);
    },
  );

  it('returns quota errors to pipeline agent steps for durable checkpoint recovery', async () => {
    await resolveAccountProxySessionRoute({
      harness: 'codex',
      model: 'gpt-5.6-sol',
      sessionId: 'pipeline-agent',
      checkpointQuota: true,
      resolveWorkOwner: () => Promise.resolve(undefined),
    });
    expect(lastRoute().waitForQuotaRecovery).toBeUndefined();
  });

  it('refuses a changed proxy connection on checkpoint continuation', async () => {
    await expect(
      resolveAccountProxySessionRoute({
        harness: 'codex',
        model: 'gpt-5.6-sol',
        sessionId: 'pipeline-agent',
        requiredConnectionId: 'another-connection',
        resolveWorkOwner: () => Promise.resolve(undefined),
      }),
    ).rejects.toThrow('unavailable');
    expect(registered).toHaveLength(0);
  });

  it('previews a route without registering one', async () => {
    await expect(
      previewAccountProxySessionRoute({
        harness: 'claude',
        model: 'claude-sonnet-4-5',
        resolveWorkOwner: () => Promise.resolve(undefined),
      }),
    ).resolves.toBe(true);
    expect(registered).toHaveLength(0);
  });

  it.each([
    [
      'nothing is connected or routing is off',
      (): void => void (target = null),
    ],
    [
      'an organization requires its gateway',
      (): void =>
        void (gatewayRequirement = {
          kind: 'enforced',
          organizationIds: ['org-1'],
        }),
    ],
    [
      "the organization's gateway is unavailable",
      (): void =>
        void (gatewayRequirement = {
          kind: 'blocked',
          reason: 'organization-unavailable',
        }),
    ],
    [
      'the account that sets gateway rules cannot be read',
      (): void =>
        void (gatewayRequirement = {
          kind: 'blocked',
          reason: 'account-unavailable',
        }),
    ],
  ])('leaves the session on its usual billing when %s', async (_, arrange) => {
    arrange();
    await expect(
      resolveAccountProxySessionRoute({
        harness: 'claude',
        model: 'claude-sonnet-4-5',
        sessionId: 'chat-1',
        resolveWorkOwner: () => Promise.resolve(undefined),
      }),
    ).resolves.toBeNull();
    await expect(
      previewAccountProxySessionRoute({
        harness: 'claude',
        model: 'claude-sonnet-4-5',
        resolveWorkOwner: () => Promise.resolve(undefined),
      }),
    ).resolves.toBe(false);
    expect(registered).toHaveLength(0);
  });

  it('keeps a model only the gateway serves on the gateway', async () => {
    await expect(
      resolveAccountProxySessionRoute({
        harness: 'claude',
        model: GATEWAY_ONLY_MODEL,
        sessionId: 'chat-1',
        resolveWorkOwner: () => Promise.resolve(undefined),
      }),
    ).resolves.toBeNull();
    await expect(
      previewAccountProxySessionRoute({
        harness: 'claude',
        model: GATEWAY_ONLY_MODEL,
        resolveWorkOwner: () => Promise.resolve(undefined),
      }),
    ).resolves.toBe(false);
    expect(registered).toHaveLength(0);
  });

  it("checks the gateway rules for the work's own owner", async () => {
    const owner: WorkOwner = { kind: 'personal' };
    await expect(
      resolveAccountProxySessionRoute({
        harness: 'claude',
        model: 'claude-sonnet-4-5',
        sessionId: 'chat-1',
        resolveWorkOwner: () => Promise.resolve(owner),
      }),
    ).resolves.not.toBeNull();
    expect(
      jest.mocked(getModelGatewayRequirementForOwner),
    ).toHaveBeenLastCalledWith(owner, expect.any(String));
  });
});
