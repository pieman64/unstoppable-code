jest.mock('../../ipc/app-advisor', () => ({
  ...jest.requireActual<object>('../../ipc/app-advisor'),
  routeRendererToolRequest: jest.fn(() => null),
  requestAppAdvisorRendererTool: jest.fn(),
}));
jest.mock('../presentation-state', () => ({
  capturePresentationTurn: (): { source: 'user' } => ({ source: 'user' }),
  showFilesPresentationPolicy: (): { presentation: 'foreground' } => ({
    presentation: 'foreground',
  }),
}));
jest.mock('../../browser/browser-handoffs', () => ({
  browserHandoffs: { snapshot: (): object => ({}) },
}));
jest.mock('../../lib/resolve-worktree', () => ({
  resolveWorktreeCwd: (): string => '/worktree',
}));

import {
  InterfaceToolRegistry,
  type InterfaceToolCall,
} from '@canopy/core-runtime/node/client';
import {
  interfaceToolDescriptor,
  type InterfaceToolName,
} from '@canopy/protocol/canopy-core';
import { CANOPY_INJECTED_TOOL_REGISTRY } from '@canopy/desktop-shared/lib/canopy-injected-tools';
import type {
  AppAdvisorRendererToolResponse,
  ShowFilesRendererResult,
} from '@canopy/desktop-shared/types';
import {
  requestAppAdvisorRendererTool,
  routeRendererToolRequest,
  surfaceUnavailableResponse,
  type AppAdvisorRendererToolSurfaces,
  type RemoteAppAdvisorWindowHost,
} from '../../ipc/app-advisor';
import { setSessionInterfaceToolRegistry } from '../../agents/interface-tool-binding';
import { buildCodexSessionDynamicToolSpecs } from '../../codex/session-dynamic-tools';
import { getCanopyRouteTools } from '../../mcp/canopy-route-tools';
import type { CanopyWorktreeSessionRoute } from '../../mcp/canopy-tool-router';
import { executeCanopyInjectedTool } from '../core';
import { requestShowFilesThroughLease } from '../show-files-runtime';

const routeRequest = jest.mocked(routeRendererToolRequest);
const windowRequest = jest.mocked(requestAppAdvisorRendererTool);

const input = {
  files: [{ path: 'README.md' }],
  target: { projectId: 'p', worktreeId: 'w' },
  origin: { projectId: 'p', worktreeId: 'w', chatTabId: 'c' },
};
const rendererResult = {
  opened: 1,
  failed: 0,
  activated: true,
  files: [{ path: 'README.md', ok: true, opened: true }],
};

function surfaces(): AppAdvisorRendererToolSurfaces & {
  touched: jest.Mock;
} {
  const touched = jest.fn((): null => null);
  return {
    touched,
    getMainWindow: touched,
    getAppAdvisorWindow: touched,
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
    tools: [interfaceToolDescriptor('ui.show_files')],
    _meta: { idempotencyKey: 'main-tools' },
  });
  setSessionInterfaceToolRegistry(registry);
  return { registry, delivered };
}

const route = (
  overrides: Partial<CanopyWorktreeSessionRoute>,
): CanopyWorktreeSessionRoute => ({
  sessionKey: 'k',
  projectId: 'p',
  worktreeId: 'w',
  chatId: 'c',
  sdkSessionId: 's',
  authToken: 't',
  createdAt: 0,
  hookHandler: () => undefined,
  toolSurface: 'native-sdk',
  providerType: 'claude',
  ...overrides,
});

const names = (tools: readonly { name: string }[]): string[] =>
  tools.map((tool) => tool.name);

async function delivered(lease: Lease): Promise<InterfaceToolCall> {
  for (let attempt = 0; attempt < 10 && lease.delivered.length === 0; attempt++)
    await Promise.resolve();
  const call = lease.delivered[0];
  if (!call) throw new Error('no call delivered');
  return call;
}

afterEach(() => {
  setSessionInterfaceToolRegistry(null);
  routeRequest.mockReset();
  routeRequest.mockReturnValue(null);
  windowRequest.mockReset();
});

describe('ShowFiles through the main window lease (CAN-4131)', () => {
  it('ShowFiles reaches the main window only through its lease', async () => {
    const lease = mainWindowLease();
    const pending = requestShowFilesThroughLease(input, surfaces());
    const call = await delivered(lease);
    expect(lease.delivered).toHaveLength(1);
    expect(call.toolName).toBe('ui.show_files');
    expect(call.input).toMatchObject({
      payload: { files: [{ path: 'README.md' }], origin: input.origin },
    });
    expect(
      lease.registry.reply('main-1', call.callId, {
        requestId: call.callId,
        ok: true,
        result: rendererResult,
      }),
    ).toBe('settled');
    await expect(pending).resolves.toMatchObject<
      Partial<ShowFilesRendererResult>
    >({ opened: 1, failed: 0, presentation: 'foreground' });
    expect(windowRequest).not.toHaveBeenCalled();
  });

  it('the lease path never touches a window accessor', async () => {
    const lease = mainWindowLease();
    const fallback = surfaces();
    const pending = requestShowFilesThroughLease(input, fallback);
    const call = await delivered(lease);
    lease.registry.reply('main-1', call.callId, {
      requestId: call.callId,
      ok: true,
      result: rendererResult,
    });
    await pending;
    expect(fallback.touched).not.toHaveBeenCalled();
    expect(fallback.openAppAdvisorWindow).not.toHaveBeenCalled();
    expect(fallback.ensureAppAdvisorWindow).not.toHaveBeenCalled();
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
    routeRequest.mockReturnValue(host);
    windowRequest.mockImplementation((request) =>
      Promise.resolve<AppAdvisorRendererToolResponse>({
        requestId: request.requestId,
        ok: true,
        result: rendererResult,
      }),
    );
    await expect(
      requestShowFilesThroughLease(input, surfaces()),
    ).resolves.toMatchObject({ opened: 1 });
    expect(windowRequest).toHaveBeenCalledTimes(1);
    expect(lease.delivered).toHaveLength(0);
  });

  it("lease loss returns today's surface_unavailable failure", async () => {
    const lease = mainWindowLease();
    const pending = requestShowFilesThroughLease(input, surfaces());
    const call = await delivered(lease);
    lease.registry.endLease('main-1');
    const expected = surfaceUnavailableResponse({
      kind: 'show_files',
      requestId: call.callId,
      payload: { files: [], target: input.target, origin: input.origin },
    }).error?.message;
    await expect(pending).rejects.toThrow(expected);
  });

  it('with no lease every core tool is still advertised and ShowFiles is absent', () => {
    const showFiles = CANOPY_INJECTED_TOOL_REGISTRY.show_files;
    const bound: readonly InterfaceToolName[] = ['ui.show_files'];
    const withLease = names(
      getCanopyRouteTools(route({ interfaceTools: bound }), false),
    );
    expect(withLease).toContain(showFiles.displayName);
    expect(
      names(getCanopyRouteTools(route({ interfaceTools: [] }), false)),
    ).toEqual(withLease.filter((name) => name !== showFiles.displayName));
    for (const workspaceMode of ['worktree', 'cowork'] as const) {
      const codex = (interfaceTools: readonly InterfaceToolName[]): string[] =>
        names(
          buildCodexSessionDynamicToolSpecs({
            workspaceMode,
            isCodeReview: false,
            includeCodeGraph: true,
            includeChatVisuals: true,
            interfaceTools,
            toolSchemaProfile: 'standard',
          }),
        );
      const withShowFiles = codex(bound);
      expect(withShowFiles).toContain(showFiles.codexToolName);
      expect(codex([])).toEqual(
        withShowFiles.filter((name) => name !== showFiles.codexToolName),
      );
    }
  });

  it('an App Advisor route lists ShowFiles only while a lease serves it', () => {
    expect(
      names(
        getCanopyRouteTools(
          route({ assistantMode: 'app-advisor', interfaceTools: [] }),
          false,
        ),
      ),
    ).not.toContain(CANOPY_INJECTED_TOOL_REGISTRY.show_files.displayName);
    expect(
      names(
        getCanopyRouteTools(
          route({
            assistantMode: 'app-advisor',
            interfaceTools: ['ui.app_advisor.show_files'],
          }),
          false,
        ),
      ),
    ).toContain(CANOPY_INJECTED_TOOL_REGISTRY.show_files.displayName);
  });

  it('an unbound session never reaches the registry', async () => {
    const lease = mainWindowLease();
    const invoke = jest.spyOn(lease.registry, 'invoke');
    await expect(
      executeCanopyInjectedTool(
        'show_files',
        { files: [{ path: 'README.md' }] },
        {
          requestUserAnswers: () => Promise.reject(new Error('unused')),
          loadScriptOutput: () => Promise.reject(new Error('unused')),
        },
      ),
    ).resolves.toEqual({
      text: 'ShowFiles is unavailable in this chat.',
      isError: true,
    });
    expect(invoke).not.toHaveBeenCalled();
  });
});
