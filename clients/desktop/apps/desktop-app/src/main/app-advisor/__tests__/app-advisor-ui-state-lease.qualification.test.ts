import {
  InterfaceToolRegistry,
  type InterfaceToolCall,
} from '@canopy/core-runtime/node/client';
import {
  interfaceToolDescriptor,
  type InterfaceToolName,
} from '@canopy/protocol/canopy-core';
import { APP_ADVISOR_TOOL_REGISTRY } from '@canopy/desktop-shared/lib/app-advisor-tools';
import type { AppAdvisorUiStateEnvelope } from '@canopy/desktop-shared/types';
import {
  getLatestAppAdvisorUiState,
  requestCurrentAppAdvisorUiStateThroughLease,
  setRendererToolSurfaceRouter,
  type AppAdvisorRendererToolSurfaces,
  type RemoteAppAdvisorWindowHost,
} from '../../ipc/app-advisor';
import { setSessionInterfaceToolRegistry } from '../../agents/interface-tool-binding';
import { buildCodexSessionDynamicToolSpecs } from '../../codex/session-dynamic-tools';
import { getCanopyRouteTools } from '../../mcp/canopy-route-tools';
import type { CanopyWorktreeSessionRoute } from '../../mcp/canopy-tool-router';
import { APP_ADVISOR_SYSTEM_PROMPT } from '../system-prompt';
import { createAppAdvisorToolRuntime } from '../runtime';
import { CanopyToolRouter } from '../../mcp/canopy-tool-router';
import { createWindowInterfaceToolRequests } from '../../mcp/interface-tool-requests';

const scope = { workspaceId: 'app-advisor', worktreeId: 'w', chatId: 'c' };
const uiState: AppAdvisorUiStateEnvelope = {
  version: 1,
  revision: 7,
  capturedAt: '2026-11-06T00:00:00.000Z',
  digest: 'd7',
  snapshot: {
    activePage: 'main',
    archivedContainers: { count: 0, viewerOpen: false },
    overlays: {
      commandPaletteOpen: false,
      fileSearchPaletteOpen: false,
      prPickerOpen: false,
      canopyPortalOpen: false,
      appAdvisorOpen: true,
    },
  },
};

function surfaces(): AppAdvisorRendererToolSurfaces & {
  mainWindow: jest.Mock;
} {
  const mainWindow = jest.fn((): null => null);
  return {
    mainWindow,
    getMainWindow: mainWindow,
    getAppAdvisorWindow: jest.fn((): null => null),
    openAppAdvisorWindow: jest.fn(() =>
      Promise.resolve({ open: false, focused: false }),
    ),
    ensureAppAdvisorWindow: jest.fn(() =>
      Promise.resolve({ open: false, focused: false }),
    ),
  };
}

interface Lease {
  registry: InterfaceToolRegistry;
  delivered: InterfaceToolCall[];
}

function mainWindowLease(): Lease {
  const registry = new InterfaceToolRegistry();
  const delivered: InterfaceToolCall[] = [];
  registry.openLease(
    { leaseId: 'main-1', surface: 'main', interfaceKind: 'desktop' },
    {
      deliver: (call) => {
        delivered.push(call);
        return true;
      },
      cancel: () => undefined,
    },
  );
  registry.register('main-1', {
    tools: [interfaceToolDescriptor('ui.get_current_ui_state')],
    _meta: { idempotencyKey: 'main-tools' },
  });
  setSessionInterfaceToolRegistry(registry);
  return { registry, delivered };
}

const read = (
  bound: boolean,
  fallback = surfaces(),
): Promise<AppAdvisorUiStateEnvelope> =>
  requestCurrentAppAdvisorUiStateThroughLease({
    scope,
    originChatTabId: 'c',
    bound,
    remoteFallbackSurfaces: fallback,
  });

const advisorRoute = (
  interfaceTools: readonly InterfaceToolName[],
): CanopyWorktreeSessionRoute => ({
  sessionKey: 'k',
  projectId: 'app-advisor',
  worktreeId: 'w',
  chatId: 'c',
  sdkSessionId: 's',
  authToken: 't',
  createdAt: 0,
  hookHandler: () => undefined,
  assistantMode: 'app-advisor',
  providerType: 'claude',
  interfaceTools,
});

const names = (tools: readonly { name: string }[]): string[] =>
  tools.map((tool) => tool.name);

async function deliveredCall(lease: Lease): Promise<InterfaceToolCall> {
  for (let attempt = 0; attempt < 10 && lease.delivered.length === 0; attempt++)
    await Promise.resolve();
  const call = lease.delivered[0];
  if (!call) throw new Error('no call delivered');
  return call;
}

function expectFallback(state: AppAdvisorUiStateEnvelope): void {
  expect(state).toMatchObject({
    version: 1,
    revision: 0,
    snapshot: { activePage: 'main' },
  });
}

afterEach(() => {
  setSessionInterfaceToolRegistry(null);
  setRendererToolSurfaceRouter(null);
});

describe("App Advisor's GetCurrentUiState through the main window lease (CAN-4131)", () => {
  it('an unbound session gets the fallback state without a call', async () => {
    const lease = mainWindowLease();
    const fallback = surfaces();
    expectFallback(await read(false, fallback));
    expect(lease.delivered).toHaveLength(0);
    expect(fallback.mainWindow).not.toHaveBeenCalled();
  });

  it('GetCurrentUiState reaches the main window only through its lease and refreshes the cache', async () => {
    const lease = mainWindowLease();
    const fallback = surfaces();
    const pending = read(true, fallback);
    const call = await deliveredCall(lease);
    expect(lease.delivered).toHaveLength(1);
    expect(call.toolName).toBe('ui.get_current_ui_state');
    expect(call.input).toEqual({ originChatTabId: 'c' });
    expect(
      lease.registry.reply('main-1', call.callId, {
        requestId: call.callId,
        ok: true,
        uiState,
      }),
    ).toBe('settled');
    await expect(pending).resolves.toEqual(uiState);
    expect(getLatestAppAdvisorUiState()).toEqual(uiState);
    expect(fallback.mainWindow).not.toHaveBeenCalled();
  });

  it("a remote-driven chat keeps today's path", async () => {
    const lease = mainWindowLease();
    const remote = surfaces();
    const closed = { open: false, focused: false };
    const host: RemoteAppAdvisorWindowHost = {
      ...remote,
      routeKey: 'controller',
      focusMainWindow: () => Promise.resolve(),
      closeAppAdvisorWindow: () => Promise.resolve(closed),
      toggleAppAdvisorWindow: () => Promise.resolve(closed),
      getAppAdvisorWindowState: () => closed,
      markAppAdvisorWindowRendererReady: () => closed,
      reportAppAdvisorWindowUiState: () => undefined,
    };
    setRendererToolSurfaceRouter(() => host);
    expectFallback(await read(true));
    expect(remote.mainWindow).toHaveBeenCalled();
    expect(lease.delivered).toHaveLength(0);
  });

  it('a route that bound the tool reads UI state through the lease without a provider session', async () => {
    const lease = mainWindowLease();
    const router = new CanopyToolRouter({
      interfaceRequests: createWindowInterfaceToolRequests(() => null),
    });
    const call = (
      interfaceTools: readonly InterfaceToolName[],
      id: number,
    ): Promise<Record<string, unknown>> =>
      router.callTool(
        {
          ...advisorRoute(interfaceTools),
          appAdvisorRuntime: createAppAdvisorToolRuntime(surfaces(), {
            projectId: 'app-advisor',
            worktreeId: 'w',
            chatId: 'c',
          }),
        },
        {
          id,
          params: {
            name: APP_ADVISOR_TOOL_REGISTRY.get_current_ui_state.displayName,
            arguments: {},
          },
          uiServer: false,
        },
      );

    const bound = call(['ui.get_current_ui_state'], 1);
    const delivered = await deliveredCall(lease);
    lease.registry.reply('main-1', delivered.callId, {
      requestId: delivered.callId,
      ok: true,
      uiState,
    });
    expect(JSON.stringify(await bound)).toContain(uiState.digest);

    const unbound = await call([], 2);
    expect(lease.delivered).toHaveLength(1);
    expect(JSON.stringify(unbound)).not.toContain(uiState.digest);
  });

  it('with no lease GetCurrentUiState is absent and the other App Advisor tools remain', () => {
    const tool = APP_ADVISOR_TOOL_REGISTRY.get_current_ui_state;
    const bound: readonly InterfaceToolName[] = ['ui.get_current_ui_state'];
    const withLease = names(getCanopyRouteTools(advisorRoute(bound), false));
    expect(withLease).toContain(tool.displayName);
    expect(names(getCanopyRouteTools(advisorRoute([]), false))).toEqual(
      withLease.filter((name) => name !== tool.displayName),
    );
    const codex = (interfaceTools: readonly InterfaceToolName[]): string[] =>
      names(
        buildCodexSessionDynamicToolSpecs({
          assistantMode: 'app-advisor',
          workspaceMode: 'worktree',
          isCodeReview: false,
          includeCodeGraph: false,
          includeChatVisuals: false,
          interfaceTools,
          toolSchemaProfile: 'standard',
        }),
      );
    const withUiState = codex(bound);
    expect(withUiState).toContain(tool.codexToolName);
    expect(codex([])).toEqual(
      withUiState.filter((name) => name !== tool.codexToolName),
    );
  });

  it('the system prompt never assumes GetCurrentUiState', () => {
    const lines = APP_ADVISOR_SYSTEM_PROMPT.split('\n').filter((line) =>
      line.includes('GetCurrentUiState'),
    );
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) expect(line).toContain('in your tools');
  });
});
