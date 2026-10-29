/**
 * @jest-environment jsdom
 */
import { act, createElement } from 'react';
import type { ReactElement } from 'react';
import type * as ReactModule from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  DEFAULT_MCP_PROXY_PORT,
  type PreferencesData,
} from '@canopy/desktop-shared/types';
import type { McpProxyState } from '@canopy/desktop-shared/types/mcp-servers';
import { makeTestPreferences } from '@/test-utils/preferences';
import { McpTab } from '../McpTab';
import {
  MCP_HTTP_AUTH_CANOPY_DESCRIPTION,
  MCP_HTTP_AUTH_CANOPY_LABEL,
  MCP_HTTP_AUTH_HEADING,
  MCP_HTTP_AUTH_HELPER,
  mcpHttpAuthHelper,
  MCP_HTTP_AUTH_PROVIDER_DESCRIPTION,
  MCP_HTTP_AUTH_PROVIDER_LABEL,
  parseMcpProxyPort,
} from '../mcp-tab-helpers';

jest.mock('../../shared', () => {
  const React = jest.requireActual<typeof ReactModule>('react');
  return {
    LoadingPlaceholder: ({ label }: { label?: string }): ReactElement =>
      React.createElement(
        'div',
        { 'data-testid': 'loading-placeholder' },
        label ?? 'Loading',
      ),
  };
});

interface MockWindowApi {
  loadPreferences: jest.Mock<Promise<PreferencesData>, []>;
  savePreferences: jest.Mock<
    Promise<PreferencesData>,
    [Partial<PreferencesData>]
  >;
}

interface MockMcpServersApi {
  getProxyState: jest.Mock<Promise<McpProxyState>, []>;
  onProxyStatus: jest.Mock<() => void, [(state: McpProxyState) => void]>;
  applyProxyPort: jest.Mock<Promise<McpProxyState>, [number]>;
}

function installMockWindowApis(
  proxyState: McpProxyState,
  preferences: PreferencesData = makeTestPreferences({
    mcpProxyPort: DEFAULT_MCP_PROXY_PORT,
  }),
): { api: MockWindowApi; mcpServers: MockMcpServersApi } {
  const api: MockWindowApi = {
    loadPreferences: jest
      .fn<Promise<PreferencesData>, []>()
      .mockResolvedValue(preferences),
    savePreferences: jest
      .fn<Promise<PreferencesData>, [Partial<PreferencesData>]>()
      .mockResolvedValue(preferences),
  };
  const mcpServers: MockMcpServersApi = {
    getProxyState: jest
      .fn<Promise<McpProxyState>, []>()
      .mockResolvedValue(proxyState),
    onProxyStatus: jest.fn<() => void, [(state: McpProxyState) => void]>(
      () => (): void => {},
    ),
    applyProxyPort: jest
      .fn<Promise<McpProxyState>, [number]>()
      .mockImplementation((port: number) =>
        Promise.resolve({ ...proxyState, port }),
      ),
  };

  Object.defineProperty(window, 'api', {
    configurable: true,
    value: api,
  });
  Object.defineProperty(window, 'mcpServers', {
    configurable: true,
    value: mcpServers,
  });
  return { api, mcpServers };
}

function getInput(container: HTMLElement, testId: string): HTMLInputElement {
  const element = container.querySelector(`[data-testid="${testId}"]`);
  if (!(element instanceof HTMLInputElement)) {
    throw new Error(`Expected ${testId} to be an input`);
  }
  return element;
}

describe('McpTab proxy port UI', () => {
  let originalApiDescriptor: PropertyDescriptor | undefined;
  let originalMcpServersDescriptor: PropertyDescriptor | undefined;
  let originalActEnvironmentDescriptor: PropertyDescriptor | undefined;

  beforeEach(() => {
    originalApiDescriptor = Object.getOwnPropertyDescriptor(window, 'api');
    originalMcpServersDescriptor = Object.getOwnPropertyDescriptor(
      window,
      'mcpServers',
    );
    originalActEnvironmentDescriptor = Object.getOwnPropertyDescriptor(
      globalThis,
      'IS_REACT_ACT_ENVIRONMENT',
    );
    Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
      configurable: true,
      value: true,
    });
  });

  afterEach(() => {
    if (originalApiDescriptor) {
      Object.defineProperty(window, 'api', originalApiDescriptor);
    } else {
      Reflect.deleteProperty(window, 'api');
    }
    if (originalMcpServersDescriptor) {
      Object.defineProperty(window, 'mcpServers', originalMcpServersDescriptor);
    } else {
      Reflect.deleteProperty(window, 'mcpServers');
    }
    if (originalActEnvironmentDescriptor) {
      Object.defineProperty(
        globalThis,
        'IS_REACT_ACT_ENVIRONMENT',
        originalActEnvironmentDescriptor,
      );
    } else {
      Reflect.deleteProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
    }
  });

  it('disables and syncs the proxy port input when setup locks the port', async () => {
    installMockWindowApis({
      port: 37661,
      status: 'running',
      portLocked: true,
    });
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root: Root = createRoot(container);

    try {
      await act(async (): Promise<void> => {
        root.render(createElement(McpTab));
        await Promise.resolve();
      });

      const input = getInput(container, 'settings-mcp-port-input');
      expect(input.disabled).toBe(true);
      expect(input.value).toBe('37661');
      expect(
        container.querySelector('[data-testid="settings-mcp-port-locked"]')
          ?.textContent,
      ).toContain('locked by app setup');
      expect(
        container.querySelector('[data-testid="settings-mcp-reset"]'),
      ).toBeNull();
    } finally {
      act((): void => {
        root.unmount();
      });
      container.remove();
    }
  });

  it('chooses the HTTP auth handler from a native radio group and saves it on apply', async () => {
    const { api } = installMockWindowApis({
      port: DEFAULT_MCP_PROXY_PORT,
      status: 'running',
      portLocked: false,
    });
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root: Root = createRoot(container);

    try {
      await act(async (): Promise<void> => {
        root.render(createElement(McpTab));
        await Promise.resolve();
      });

      const canopy = getInput(container, 'settings-mcp-auth-canopy');
      const provider = getInput(container, 'settings-mcp-auth-provider');
      expect(canopy.type).toBe('radio');
      expect(provider.type).toBe('radio');
      expect(provider.name).toBe(canopy.name);
      expect(canopy.checked).toBe(true);
      expect(provider.checked).toBe(false);
      expect(
        container.querySelector('[data-testid="settings-mcp-auth-account"]'),
      ).toBeNull();
      const description = container.querySelector(
        '[data-testid="settings-mcp-auth-description"]',
      );
      expect(description?.textContent).toBe(MCP_HTTP_AUTH_CANOPY_DESCRIPTION);

      await act(async (): Promise<void> => {
        provider.click();
        await Promise.resolve();
      });
      expect(provider.checked).toBe(true);
      expect(canopy.checked).toBe(false);
      expect(description?.textContent).toBe(MCP_HTTP_AUTH_PROVIDER_DESCRIPTION);

      const apply = container.querySelector(
        '[data-testid="settings-mcp-save"]',
      );
      if (!(apply instanceof HTMLButtonElement)) {
        throw new Error('Expected the MCP apply button.');
      }
      await act(async (): Promise<void> => {
        apply.click();
        await Promise.resolve();
      });
      expect(api.savePreferences).toHaveBeenCalledWith({
        mcpHttpAuthDefaultHandler: 'provider',
      });
    } finally {
      act((): void => {
        root.unmount();
      });
      container.remove();
    }
  });

  it('resets a customized proxy port to the default and applies it', async () => {
    const customPort = 38942;
    const { api, mcpServers } = installMockWindowApis(
      {
        port: customPort,
        status: 'stopped',
        portLocked: false,
      },
      makeTestPreferences({ mcpProxyPort: customPort }),
    );
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root: Root = createRoot(container);

    try {
      await act(async (): Promise<void> => {
        root.render(createElement(McpTab));
        await Promise.resolve();
      });

      const reset = container.querySelector(
        '[data-testid="settings-mcp-reset"]',
      );
      expect(reset).toBeInstanceOf(HTMLButtonElement);
      if (!(reset instanceof HTMLButtonElement)) {
        throw new Error('Expected the MCP port reset button.');
      }

      await act(async (): Promise<void> => {
        reset.click();
        await Promise.resolve();
      });

      expect(getInput(container, 'settings-mcp-port-input').value).toBe(
        String(DEFAULT_MCP_PROXY_PORT),
      );
      expect(mcpServers.applyProxyPort).toHaveBeenCalledWith(
        DEFAULT_MCP_PROXY_PORT,
      );
      expect(api.savePreferences).toHaveBeenCalledWith({
        mcpHttpAuthDefaultHandler: 'canopy',
      });
      expect(
        container.querySelector('[data-testid="settings-mcp-reset"]'),
      ).toBeNull();
    } finally {
      act((): void => {
        root.unmount();
      });
      container.remove();
    }
  });
});

describe('parseMcpProxyPort', () => {
  it('accepts valid ports inside the 1..65535 range', () => {
    expect(parseMcpProxyPort('37645')).toBe(37645);
    expect(parseMcpProxyPort('1')).toBe(1);
    expect(parseMcpProxyPort('65535')).toBe(65535);
  });

  it('strips surrounding whitespace before parsing', () => {
    expect(parseMcpProxyPort('  8080 ')).toBe(8080);
  });

  it('rejects ports outside the valid range', () => {
    expect(parseMcpProxyPort('0')).toBeNull();
    expect(parseMcpProxyPort('65536')).toBeNull();
    expect(parseMcpProxyPort('-1')).toBeNull();
  });

  it('rejects non-numeric strings', () => {
    expect(parseMcpProxyPort('')).toBeNull();
    expect(parseMcpProxyPort('not-a-port')).toBeNull();
    expect(parseMcpProxyPort('80a')).toBeNull();
    expect(parseMcpProxyPort('1.5')).toBeNull();
  });
});

describe('HTTP MCP auth section copy', () => {
  it('exposes a heading describing the HTTP MCP auth choice', () => {
    expect(MCP_HTTP_AUTH_HEADING).toBe('HTTP MCP server auth');
  });

  it('explains that activity-card toggles can override the default', () => {
    expect(MCP_HTTP_AUTH_HELPER).toContain(
      'MCP servers activity card can override',
    );
  });

  it('names the activity card by its displayed title', () => {
    expect(mcpHttpAuthHelper('MCP servers')).toBe(MCP_HTTP_AUTH_HELPER);
    expect(mcpHttpAuthHelper('MCP servers')).toContain(
      'MCP servers activity card can override',
    );
  });

  it('uses Canopy proxy / Agent provider as the pill labels', () => {
    expect(MCP_HTTP_AUTH_CANOPY_LABEL).toBe('Canopy proxy');
    expect(MCP_HTTP_AUTH_PROVIDER_LABEL).toBe('Agent provider');
  });

  it('describes the Canopy proxy mode in user-facing terms', () => {
    expect(MCP_HTTP_AUTH_CANOPY_DESCRIPTION).toContain('127.0.0.1 proxy');
    expect(MCP_HTTP_AUTH_CANOPY_DESCRIPTION).toContain('Claude and Codex');
  });

  it('warns that agent-provider mode requires per-agent authentication', () => {
    expect(MCP_HTTP_AUTH_PROVIDER_DESCRIPTION).toContain(
      'authenticate with Claude and Codex separately',
    );
  });
});
