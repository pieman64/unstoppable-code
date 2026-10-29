jest.mock('../../canopy-cloud/mcp-connections', (): object => ({
  getCachedAccountMcpConnection: jest.fn(),
}));
import { getCachedAccountMcpConnection } from '../../canopy-cloud/mcp-connections';
import type {
  ChatTabPluginSelections,
  McpHttpAuthHandler,
} from '@canopy/desktop-shared/types';
import type {
  McpServerAuthStatus,
  McpServerFile,
} from '@canopy/desktop-shared/types/mcp-servers';

// ---------------------------------------------------------------------------
// CAN-399 / CAN-492 guards.
//
// Every module below is a way the app has previously reached the network (or a
// browser) while merely *inspecting* an integration's auth state. They are
// mocked so the tests can assert the preflight touches none of them:
//   - `mcp/oauth-probe` POSTs `initialize` upstream to infer whether OAuth is
//     required. CAN-399 is the ticket where doing that passively produced
//     repeated Linear auth prompts on window focus.
//   - `plugins/mcp-inventory` calls that probe for every selected HTTP server.
//   - `mcp/oauth-client` opens the system browser. CAN-492 is the ticket where
//     an unattended path triggered a surprise interactive login.
//   - `auth/provider-auth-state`'s `check*` helpers spawn provider CLI probes.
//   - `github-auth` / `linear-auth` resolve tokens, shelling out to `gh` when
//     no PAT is stored.
// ---------------------------------------------------------------------------
jest.mock('../../mcp/oauth-probe', () => ({
  probeMcpHttpOAuthRequirement: jest.fn(),
}));
jest.mock('../../plugins/mcp-inventory', () => ({
  listDetectedMcpServersForSelections: jest.fn(),
}));
jest.mock('../../mcp/oauth-client', () => ({
  startMcpOAuthFlow: jest.fn(),
}));
jest.mock('../../auth/provider-auth-state', () => ({
  checkClaudeAuthStatus: jest.fn(),
  checkCodexAuthStatus: jest.fn(),
  isProviderNativelyAuthenticated: jest.fn(),
  isProviderNativelyAuthenticatedForRouting: jest.fn(),
}));
jest.mock('../github-auth', () => ({
  resolveGitHubTokenWithSource: jest.fn(),
}));
jest.mock('../linear-auth', () => ({
  resolveLinearToken: jest.fn(),
}));

// `safeReadJson` is generic, so a `jest.mocked` handle on it degrades to an
// error type. Keying a plain map by path is both type-clean and closer to the
// real thing: it proves the module asks for the right file.
jest.mock('../fs-utils', () => ({
  safeReadJsonAsync: (filePath: string): Promise<unknown> =>
    Promise.resolve(mockServerFilesByPath.get(filePath) ?? null),
}));
jest.mock('../paths', () => ({
  getMcpServerFilePath: (serverId: string): string =>
    `/data/mcp-servers/server-${serverId}.json`,
}));
jest.mock('../preferences-store', () => ({
  readPreferencesFile: (): Promise<unknown> => Promise.resolve(mockPreferences),
}));
jest.mock('../../mcp/oauth-token-store', () => ({
  getMcpOAuthAuthStatus: (
    serverId: string,
    configId: string,
  ): Promise<unknown> => mockGetMcpOAuthAuthStatus(serverId, configId),
}));
jest.mock('../../plugins/global-plugin-overlay', () => ({
  resolveEffectiveChatPluginContext: jest.fn(),
}));
jest.mock('../../plugins/plugin-resolver', () => ({
  resolveEffectivePluginSelectionRefs: jest.fn(),
}));

import { probeMcpHttpOAuthRequirement } from '../../mcp/oauth-probe';
import { listDetectedMcpServersForSelections } from '../../plugins/mcp-inventory';
import { startMcpOAuthFlow } from '../../mcp/oauth-client';
import {
  checkClaudeAuthStatus,
  checkCodexAuthStatus,
  isProviderNativelyAuthenticated,
  isProviderNativelyAuthenticatedForRouting,
} from '../../auth/provider-auth-state';
import { resolveGitHubTokenWithSource } from '../github-auth';
import { resolveLinearToken } from '../linear-auth';
import { resolveEffectiveChatPluginContext } from '../../plugins/global-plugin-overlay';
import { resolveEffectivePluginSelectionRefs } from '../../plugins/plugin-resolver';
import {
  isRecoverableAuthFailureClass,
  isValidAuthDependencyFailure,
  type AuthDependencyFailure,
} from '@canopy/protocol/auth-recovery';
import {
  assertTurnAuthDependencies,
  describeTurnAuthRefusal,
  resolveTurnAuthBlockers,
  TurnAuthPreflightBlockedError,
} from '../auth-preflight';

interface McpAuthStatusResult {
  status: McpServerAuthStatus;
  lastError?: string;
  canRefresh?: boolean;
}

const mockServerFilesByPath = new Map<string, McpServerFile>();
const mockPreferences: { mcpHttpAuthDefaultHandler: McpHttpAuthHandler } = {
  mcpHttpAuthDefaultHandler: 'canopy',
};
const mockGetMcpOAuthAuthStatus = jest.fn(
  (serverId: string, configId: string): Promise<McpAuthStatusResult> => {
    void serverId;
    void configId;
    return Promise.resolve({ status: 'connected' });
  },
);

const mockedOverlay = jest.mocked(resolveEffectiveChatPluginContext);
const mockedRefs = jest.mocked(resolveEffectivePluginSelectionRefs);

const TARGET = {
  projectId: 'ws-1',
  worktreeId: 'wt-1',
  chatId: 'chat-1',
} as const;

function selections(
  mcpServerRefs: Array<{ serverId: string; configId: string }>,
): ChatTabPluginSelections {
  return {
    collectionIds: [],
    skillRefs: [],
    pluginRefs: [],
    mcpServerRefs,
  };
}

function stubServer(options: {
  serverId: string;
  configId: string;
  name?: string;
  type?: 'http' | 'command';
  oauth?: boolean;
  enabled?: boolean;
  authToken?: string;
  httpAuthHandler?: McpHttpAuthHandler;
}): void {
  const now = '2026-01-01T00:00:00.000Z';
  const file: McpServerFile = {
    version: 1,
    server: {
      definition: {
        id: options.serverId,
        name: options.name ?? 'Prod MCP server',
        description: '',
        type: options.type ?? 'http',
        url: 'https://mcp.example.com/mcp',
        ...(options.oauth === false ? {} : { oauth: {} }),
        ...(options.httpAuthHandler
          ? { httpAuthHandler: options.httpAuthHandler }
          : {}),
        createdAt: now,
        updatedAt: now,
      },
      configs: [
        {
          id: options.configId,
          name: 'default',
          description: '',
          enabled: options.enabled ?? true,
          ...(options.authToken ? { authToken: options.authToken } : {}),
          envVars: {},
          extraArgs: [],
          extraHeaders: {},
          createdAt: now,
          updatedAt: now,
        },
      ],
    },
  };
  mockServerFilesByPath.set(
    `/data/mcp-servers/server-${options.serverId}.json`,
    file,
  );
}

function stubAuthStatus(statuses: Record<string, McpAuthStatusResult>): void {
  mockGetMcpOAuthAuthStatus.mockImplementation((serverId, configId) =>
    Promise.resolve(
      statuses[`${serverId}:${configId}`] ?? { status: 'connected' },
    ),
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  mockServerFilesByPath.clear();
  mockPreferences.mcpHttpAuthDefaultHandler = 'canopy';
  stubAuthStatus({});
  mockedOverlay.mockImplementation((local) =>
    Promise.resolve({ selections: local ?? selections([]) }),
  );
  mockedRefs.mockImplementation((input) =>
    Promise.resolve({
      skillRefs: input.skillRefs,
      pluginRefs: input.pluginRefs,
      mcpServerRefs: [...(input.mcpServerRefs ?? [])],
      warnings: [],
    }),
  );
});

describe('resolveTurnAuthBlockers', () => {
  it('routes cached account reauthentication to settings without local OAuth', async (): Promise<void> => {
    stubServer({
      serverId: 'account',
      configId: 'default',
      httpAuthHandler: 'account',
      oauth: false,
    });
    jest.mocked(getCachedAccountMcpConnection).mockResolvedValue({
      id: 'a',
      serverKey: 'github',
      configId: 'default',
      displayName: 'GitHub',
      kind: 'CURATED',
      status: 'REAUTH_REQUIRED',
      routeId: 'r',
      enabledTools: null,
    });
    const result = await resolveTurnAuthBlockers({
      target: TARGET,
      providerType: 'claude',
      pluginSelections: selections([
        { serverId: 'account', configId: 'default' },
      ]),
    });
    expect(result).toEqual([
      expect.objectContaining({
        failureClass: 'reauthorization_required',
        recovery: {
          kind: 'settings_deeplink',
          target: { page: 'mcp-servers', serverId: 'account' },
        },
      }),
    ]);
    expect(mockGetMcpOAuthAuthStatus).not.toHaveBeenCalled();
    expect(getCachedAccountMcpConnection).toHaveBeenCalled();
  });

  it('admits account handlers without consulting local OAuth state', async (): Promise<void> => {
    stubServer({
      serverId: 'account',
      configId: 'default',
      httpAuthHandler: 'account',
      oauth: true,
    });
    stubAuthStatus({ 'account:default': { status: 'error' } });
    jest.mocked(getCachedAccountMcpConnection).mockResolvedValue({
      id: 'a',
      serverKey: 'github',
      configId: 'default',
      displayName: 'GitHub',
      kind: 'CURATED',
      status: 'CONNECTED',
      routeId: 'r',
      enabledTools: null,
    });
    mockedRefs.mockResolvedValue({
      skillRefs: [],
      pluginRefs: [],
      mcpServerRefs: [{ serverId: 'account', configId: 'default' }],
    });
    await expect(
      resolveTurnAuthBlockers({
        target: TARGET,
        providerType: 'claude',
        pluginSelections: selections([
          { serverId: 'account', configId: 'default' },
        ]),
      }),
    ).resolves.toEqual([]);
    expect(mockGetMcpOAuthAuthStatus).not.toHaveBeenCalled();
    expect(getCachedAccountMcpConnection).toHaveBeenCalled();
  });

  it('blocks a turn whose selected MCP server has no OAuth token on file', async () => {
    stubServer({ serverId: 'srv-1', configId: 'cfg-1' });
    stubAuthStatus({ 'srv-1:cfg-1': { status: 'not_connected' } });

    const blockers = await resolveTurnAuthBlockers({
      target: TARGET,
      pluginSelections: selections([{ serverId: 'srv-1', configId: 'cfg-1' }]),
    });

    expect(blockers).toEqual([
      {
        dependencyClass: 'mcp',
        dependencyId: 'srv-1:cfg-1',
        displayName: 'Prod MCP server',
        failureClass: 'unauthenticated',
        recovery: { kind: 'mcp_oauth', serverId: 'srv-1', configId: 'cfg-1' },
      },
    ]);
  });

  it('does not apply the OAuth blocker when the config supplies a bearer token', async () => {
    stubServer({
      serverId: 'srv-1',
      configId: 'cfg-1',
      authToken: 'configured-bearer-token',
    });
    stubAuthStatus({ 'srv-1:cfg-1': { status: 'not_connected' } });

    await expect(
      resolveTurnAuthBlockers({
        target: TARGET,
        pluginSelections: selections([
          { serverId: 'srv-1', configId: 'cfg-1' },
        ]),
      }),
    ).resolves.toEqual([]);
    expect(mockGetMcpOAuthAuthStatus).not.toHaveBeenCalled();
  });

  it('reports an UNREFRESHABLE expired token as an expired failure', async () => {
    stubServer({ serverId: 'srv-1', configId: 'cfg-1' });
    // No `canRefresh`: the stored record has no refresh credential, so
    // `getValidMcpAccessToken` returns null without even attempting a refresh.
    stubAuthStatus({ 'srv-1:cfg-1': { status: 'expired' } });

    const [blocker] = await resolveTurnAuthBlockers({
      target: TARGET,
      pluginSelections: selections([{ serverId: 'srv-1', configId: 'cfg-1' }]),
    });

    expect(blocker.failureClass).toBe('expired');
    expect(blocker.recovery).toEqual({
      kind: 'mcp_oauth',
      serverId: 'srv-1',
      configId: 'cfg-1',
    });
  });

  // CAN-1814 review (critical). `getMcpOAuthAuthStatus` derives 'expired' from
  // `expiresAt <= Date.now()` ALONE. The resolver the proxy actually uses,
  // `getValidMcpAccessToken`, treats that same record very differently: it
  // checks `isAccessTokenFresh`, then `token.refreshToken`, and performs a
  // `grant_type: 'refresh_token'` exchange that SUCCEEDS. Refusing on 'expired'
  // therefore refused a turn that would have worked.
  //
  // Short-lived access tokens plus refresh tokens are the MCP spec's
  // recommended pattern, so for any such server every chat selecting it became
  // unsendable roughly once per token lifetime — which is precisely the
  // repeated-reconnect experience CAN-399 (cited in this module's own header)
  // exists to prevent.
  it('does NOT block an expired token that can still be refreshed', async () => {
    stubServer({ serverId: 'srv-1', configId: 'cfg-1' });
    stubAuthStatus({ 'srv-1:cfg-1': { status: 'expired', canRefresh: true } });

    await expect(
      resolveTurnAuthBlockers({
        target: TARGET,
        pluginSelections: selections([
          { serverId: 'srv-1', configId: 'cfg-1' },
        ]),
      }),
    ).resolves.toEqual([]);
  });

  // The refresh that the case above falls through to may itself fail. When it
  // does, `getValidMcpAccessToken` writes `lastError` via
  // `recordMcpOAuthTokenError`, so the NEXT send sees 'error' and blocks
  // through the `reauthorization_required` branch. Falling open on a
  // refreshable token is therefore late, not permanently blind.
  it('blocks on the next send once a failed refresh has recorded lastError', async () => {
    stubServer({ serverId: 'srv-1', configId: 'cfg-1' });
    stubAuthStatus({
      'srv-1:cfg-1': {
        status: 'error',
        lastError: 'OAuth refresh failed.',
        canRefresh: true,
      },
    });

    const [blocker] = await resolveTurnAuthBlockers({
      target: TARGET,
      pluginSelections: selections([{ serverId: 'srv-1', configId: 'cfg-1' }]),
    });

    expect(blocker.failureClass).toBe('reauthorization_required');
  });

  it('carries the redacted last error as reauthorization_required', async () => {
    stubServer({ serverId: 'srv-1', configId: 'cfg-1' });
    stubAuthStatus({
      'srv-1:cfg-1': {
        status: 'error',
        lastError: 'Upstream returned HTTP 401',
      },
    });

    const [blocker] = await resolveTurnAuthBlockers({
      target: TARGET,
      pluginSelections: selections([{ serverId: 'srv-1', configId: 'cfg-1' }]),
    });

    expect(blocker.failureClass).toBe('reauthorization_required');
    expect(blocker.detail).toBe('Upstream returned HTTP 401');
  });

  it('does NOT block on an unrelated disconnected server the turn never selected', async () => {
    // `srv-other` is broken, but this chat selected `srv-1`, which is fine.
    stubServer({ serverId: 'srv-1', configId: 'cfg-1' });
    stubServer({ serverId: 'srv-other', configId: 'cfg-other' });
    stubAuthStatus({ 'srv-other:cfg-other': { status: 'not_connected' } });

    const blockers = await resolveTurnAuthBlockers({
      target: TARGET,
      pluginSelections: selections([{ serverId: 'srv-1', configId: 'cfg-1' }]),
    });

    expect(blockers).toEqual([]);
    expect(mockGetMcpOAuthAuthStatus).not.toHaveBeenCalledWith(
      'srv-other',
      'cfg-other',
    );
  });

  it('does not block a command/stdio server, which has no cached auth axis', async () => {
    stubServer({ serverId: 'srv-1', configId: 'cfg-1', type: 'command' });
    stubAuthStatus({ 'srv-1:cfg-1': { status: 'not_connected' } });

    await expect(
      resolveTurnAuthBlockers({
        target: TARGET,
        pluginSelections: selections([
          { serverId: 'srv-1', configId: 'cfg-1' },
        ]),
      }),
    ).resolves.toEqual([]);
    expect(mockGetMcpOAuthAuthStatus).not.toHaveBeenCalled();
  });

  it('does not block an HTTP server with no OAuth config (only a probe could tell)', async () => {
    stubServer({ serverId: 'srv-1', configId: 'cfg-1', oauth: false });
    stubAuthStatus({ 'srv-1:cfg-1': { status: 'not_connected' } });

    await expect(
      resolveTurnAuthBlockers({
        target: TARGET,
        pluginSelections: selections([
          { serverId: 'srv-1', configId: 'cfg-1' },
        ]),
      }),
    ).resolves.toEqual([]);
    expect(mockGetMcpOAuthAuthStatus).not.toHaveBeenCalled();
  });

  it('does not block a provider-handled server whose credential Canopy does not own', async () => {
    stubServer({
      serverId: 'srv-1',
      configId: 'cfg-1',
      httpAuthHandler: 'provider',
    });
    stubAuthStatus({ 'srv-1:cfg-1': { status: 'not_connected' } });

    await expect(
      resolveTurnAuthBlockers({
        target: TARGET,
        pluginSelections: selections([
          { serverId: 'srv-1', configId: 'cfg-1' },
        ]),
      }),
    ).resolves.toEqual([]);
    expect(mockGetMcpOAuthAuthStatus).not.toHaveBeenCalled();
  });

  it('does not block a disabled config, which the resolver skips anyway', async () => {
    stubServer({ serverId: 'srv-1', configId: 'cfg-1', enabled: false });
    stubAuthStatus({ 'srv-1:cfg-1': { status: 'not_connected' } });

    await expect(
      resolveTurnAuthBlockers({
        target: TARGET,
        pluginSelections: selections([
          { serverId: 'srv-1', configId: 'cfg-1' },
        ]),
      }),
    ).resolves.toEqual([]);
  });

  it('fails open when the server file cannot be read', async () => {
    stubAuthStatus({ 'srv-1:cfg-1': { status: 'not_connected' } });

    await expect(
      resolveTurnAuthBlockers({
        target: TARGET,
        pluginSelections: selections([
          { serverId: 'srv-1', configId: 'cfg-1' },
        ]),
      }),
    ).resolves.toEqual([]);
  });

  it('does no server or token work at all for a turn with no selections', async () => {
    await expect(resolveTurnAuthBlockers({ target: TARGET })).resolves.toEqual(
      [],
    );
    expect(mockGetMcpOAuthAuthStatus).not.toHaveBeenCalled();
  });

  it('never blocks on the provider lane, which falls back to AI Credits', async () => {
    // A signed-out provider is the credits-only user's NORMAL state
    // (`resolveAiCreditsRoutingAttempt`'s `no-native-auth` activation), so it
    // is not a cached-knowable dead end and must never refuse a send.
    await expect(
      resolveTurnAuthBlockers({
        target: TARGET,
        pluginSelections: selections([]),
        providerType: 'claude',
      }),
    ).resolves.toEqual([]);
  });

  // 'expired' appears here only in its UNREFRESHABLE form. A refreshable
  // expired token is not a blocker at all — see the test above.
  it.each([['not_connected'], ['expired'], ['error']] as const)(
    'satisfies the recoverable-class/recovery-method invariant for %s',
    async (status) => {
      stubServer({ serverId: 'srv-1', configId: 'cfg-1' });
      stubAuthStatus({ 'srv-1:cfg-1': { status } });

      const blockers = await resolveTurnAuthBlockers({
        target: TARGET,
        pluginSelections: selections([
          { serverId: 'srv-1', configId: 'cfg-1' },
        ]),
      });

      // The refusal offers an action, so the class it names must be one
      // logging in can actually fix. This is the PR 1 invariant that makes
      // 'show a reconnect button for a quota error' unrepresentable.
      expect(blockers).toHaveLength(1);
      expect(blockers.every(isValidAuthDependencyFailure)).toBe(true);
      expect(isRecoverableAuthFailureClass(blockers[0].failureClass)).toBe(
        true,
      );
    },
  );

  it('issues no network, subprocess, or browser call (CAN-399, CAN-492)', async () => {
    const fetchSpy = jest
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new Error('preflight must not reach the network'));
    stubServer({ serverId: 'srv-1', configId: 'cfg-1' });
    stubAuthStatus({ 'srv-1:cfg-1': { status: 'not_connected' } });

    const blockers = await resolveTurnAuthBlockers({
      target: TARGET,
      pluginSelections: selections([{ serverId: 'srv-1', configId: 'cfg-1' }]),
      providerType: 'claude',
    });

    expect(blockers).toHaveLength(1);
    // CAN-399: no passive MCP inventory refresh and no upstream `initialize`.
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(probeMcpHttpOAuthRequirement).not.toHaveBeenCalled();
    expect(listDetectedMcpServersForSelections).not.toHaveBeenCalled();
    expect(resolveGitHubTokenWithSource).not.toHaveBeenCalled();
    expect(resolveLinearToken).not.toHaveBeenCalled();
    expect(checkClaudeAuthStatus).not.toHaveBeenCalled();
    expect(checkCodexAuthStatus).not.toHaveBeenCalled();
    expect(isProviderNativelyAuthenticated).not.toHaveBeenCalled();
    expect(isProviderNativelyAuthenticatedForRouting).not.toHaveBeenCalled();
    // CAN-492: nothing opens a browser from a send preflight.
    expect(startMcpOAuthFlow).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});

describe('assertTurnAuthDependencies', () => {
  it('throws a blocked error naming the dependency', async () => {
    stubServer({ serverId: 'srv-1', configId: 'cfg-1' });
    stubAuthStatus({ 'srv-1:cfg-1': { status: 'not_connected' } });

    const thrown: unknown = await assertTurnAuthDependencies({
      target: TARGET,
      pluginSelections: selections([{ serverId: 'srv-1', configId: 'cfg-1' }]),
    }).then(
      () => null,
      (error: unknown) => error,
    );

    expect(thrown).toBeInstanceOf(TurnAuthPreflightBlockedError);
    if (!(thrown instanceof TurnAuthPreflightBlockedError)) return;
    expect(thrown.failures).toHaveLength(1);
    expect(thrown.failures[0].displayName).toBe('Prod MCP server');
    expect(thrown.message).toContain('Prod MCP server');
  });

  it('resolves quietly when nothing is blocked', async () => {
    await expect(
      assertTurnAuthDependencies({ target: TARGET }),
    ).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// CAN-1814 PR 7. The refusal has to reach the renderer as DATA.
//
// `ipcRenderer.invoke` rejects with a string, so a thrown blocked error loses
// `failures` at the IPC boundary and the user sees a dead-end sentence with no
// reconnect button. This translator is the seam the send IPC uses to return the
// refusal as a typed result instead, so the same `AuthDependencyFailure[]` the
// mid-turn path renders drives the refused-send card.
// ---------------------------------------------------------------------------
describe('describeTurnAuthRefusal', () => {
  const prodFailure: AuthDependencyFailure = {
    dependencyClass: 'mcp',
    dependencyId: 'srv-1:cfg-1',
    displayName: 'Prod MCP server',
    failureClass: 'expired',
    recovery: { kind: 'mcp_oauth', serverId: 'srv-1', configId: 'cfg-1' },
  };
  const stagingFailure: AuthDependencyFailure = {
    dependencyClass: 'mcp',
    dependencyId: 'srv-2:cfg-1',
    displayName: 'Staging MCP server',
    failureClass: 'unauthenticated',
    recovery: { kind: 'mcp_oauth', serverId: 'srv-2', configId: 'cfg-1' },
  };

  it('carries EVERY blocked dependency, not only the sentence', () => {
    const refusal = describeTurnAuthRefusal(
      new TurnAuthPreflightBlockedError([prodFailure, stagingFailure]),
    );

    expect(refusal?.failures).toEqual([prodFailure, stagingFailure]);
    expect(refusal?.message).toContain('Prod MCP server');
    expect(refusal?.message).toContain('Staging MCP server');
  });

  it('keeps a non-recoverable blocker readable so the card can explain it', () => {
    const scopeFailure: AuthDependencyFailure = {
      dependencyClass: 'mcp',
      dependencyId: 'srv-3:cfg-1',
      displayName: 'Scoped MCP server',
      failureClass: 'insufficient_scope',
      recovery: { kind: 'none' },
    };

    const refusal = describeTurnAuthRefusal(
      new TurnAuthPreflightBlockedError([scopeFailure]),
    );

    expect(refusal?.failures).toEqual([scopeFailure]);
  });

  it('returns null for anything else, so unrelated errors still reject', () => {
    expect(describeTurnAuthRefusal(new Error('dispatch failed'))).toBeNull();
    expect(describeTurnAuthRefusal('not an error')).toBeNull();
    expect(describeTurnAuthRefusal(undefined)).toBeNull();
  });
});
