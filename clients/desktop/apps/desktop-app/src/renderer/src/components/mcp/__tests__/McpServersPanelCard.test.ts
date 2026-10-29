import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { DetectedMcpServerInfo } from '@canopy/desktop-shared/types/mcp-servers';
import {
  getMcpProxyToggleActiveTitle,
  getMcpProxyToggleInactiveTitle,
  McpServersPanelCard,
} from '../McpServersPanelCard';
import {
  mcpAuthStatusLabel,
  mcpPanelCardSubtitle,
  mcpRowSecondaryText,
} from '../mcp-card-helpers';

function makeServer(
  overrides: Partial<DetectedMcpServerInfo> = {},
): DetectedMcpServerInfo {
  return {
    key: 'k',
    source: 'standalone',
    serverName: 'github',
    displayName: 'GitHub',
    type: 'http',
    enabled: true,
    authStatus: 'not_connected',
    authStatusLabel: 'Needs auth',
    canConnect: true,
    ...overrides,
  };
}

describe('McpServersPanelCard', () => {
  it('renders inventory-provided auth labels', () => {
    const html = renderToStaticMarkup(
      createElement(McpServersPanelCard, {
        servers: [
          makeServer({
            authStatus: 'not_configured',
            authStatusLabel: 'Configured by plugin',
            canConnect: false,
          }),
        ],
        warnings: [],
        loading: false,
        error: null,
        connectingKey: null,
        onConnect: (): void => undefined,
        onRefresh: (): void => undefined,
      }),
    );

    expect(html).toContain('Configured by plugin');
    expect(html).not.toContain('No auth');
  });

  it('renders the active Canopy toggle for HTTP rows that opt in', () => {
    const html = renderToStaticMarkup(
      createElement(McpServersPanelCard, {
        servers: [
          makeServer({
            canToggleCanopyProxy: true,
            canopyProxyEnabled: true,
            canConnect: true,
            authStatus: 'connected',
            authStatusLabel: 'Connected',
          }),
        ],
        warnings: [],
        loading: false,
        error: null,
        connectingKey: null,
        proxyUpdatingKey: null,
        onConnect: (): void => undefined,
        onRefresh: (): void => undefined,
        onSetCanopyProxyEnabled: (): void => undefined,
      }),
    );

    expect(html).toContain('data-testid="mcp-servers-card-proxy-toggle"');
    expect(html).toContain(getMcpProxyToggleActiveTitle());
    expect(html).toContain('aria-pressed="true"');
    // Active styling — primary border + tinted background.
    expect(html).toContain('border-line-accent');
    expect(html).toContain('bg-accent-subtle');
    // A stale canConnect hint must not ask a connected account to reconnect.
    expect(html).not.toContain('data-testid="mcp-servers-card-connect"');
  });

  it('renders the inactive Canopy toggle for HTTP rows using provider auth', () => {
    const html = renderToStaticMarkup(
      createElement(McpServersPanelCard, {
        servers: [
          makeServer({
            canToggleCanopyProxy: true,
            canopyProxyEnabled: false,
            canConnect: false,
          }),
        ],
        warnings: [],
        loading: false,
        error: null,
        connectingKey: null,
        proxyUpdatingKey: null,
        onConnect: (): void => undefined,
        onRefresh: (): void => undefined,
        onSetCanopyProxyEnabled: (): void => undefined,
      }),
    );

    expect(html).toContain('data-testid="mcp-servers-card-proxy-toggle"');
    expect(html).toContain(getMcpProxyToggleInactiveTitle());
    expect(html).toContain('aria-pressed="false"');
    // Inactive styling — bordered with muted text and no primary fill.
    expect(html).not.toContain('border-border');
    expect(html).not.toContain('data-testid="mcp-servers-card-connect"');
  });

  it('omits the toggle for command rows that cannot be proxied', () => {
    const html = renderToStaticMarkup(
      createElement(McpServersPanelCard, {
        servers: [
          makeServer({
            type: 'command',
            canToggleCanopyProxy: false,
            canConnect: false,
            authStatus: 'unsupported',
            authStatusLabel: 'Unsupported',
          }),
        ],
        warnings: [],
        loading: false,
        error: null,
        connectingKey: null,
        proxyUpdatingKey: null,
        onConnect: (): void => undefined,
        onRefresh: (): void => undefined,
        onSetCanopyProxyEnabled: (): void => undefined,
      }),
    );

    expect(html).not.toContain('data-testid="mcp-servers-card-proxy-toggle"');
  });

  it('does not render the Connect button when the server cannot connect', () => {
    const html = renderToStaticMarkup(
      createElement(McpServersPanelCard, {
        servers: [
          makeServer({
            canConnect: false,
            authStatus: 'not_configured',
            authStatusLabel: 'Configured by plugin',
          }),
        ],
        warnings: [],
        loading: false,
        error: null,
        connectingKey: null,
        onConnect: (): void => undefined,
        onRefresh: (): void => undefined,
      }),
    );

    expect(html).not.toContain('data-testid="mcp-servers-card-connect"');
  });

  it('disables the toggle while a proxy update is in flight for the server', () => {
    const html = renderToStaticMarkup(
      createElement(McpServersPanelCard, {
        servers: [
          makeServer({
            canToggleCanopyProxy: true,
            canopyProxyEnabled: false,
            canConnect: false,
          }),
        ],
        warnings: [],
        loading: false,
        error: null,
        connectingKey: null,
        proxyUpdatingKey: 'k',
        onConnect: (): void => undefined,
        onRefresh: (): void => undefined,
        onSetCanopyProxyEnabled: (): void => undefined,
      }),
    );

    expect(html).toContain('data-testid="mcp-servers-card-proxy-toggle"');
    expect(html).toContain('disabled');
  });

  it('omits the toggle when showProxyToggle is false', () => {
    const html = renderToStaticMarkup(
      createElement(McpServersPanelCard, {
        servers: [
          makeServer({
            canToggleCanopyProxy: true,
            canopyProxyEnabled: true,
          }),
        ],
        warnings: [],
        loading: false,
        error: null,
        connectingKey: null,
        proxyUpdatingKey: null,
        showProxyToggle: false,
        onConnect: (): void => undefined,
        onRefresh: (): void => undefined,
        onSetCanopyProxyEnabled: (): void => undefined,
      }),
    );

    expect(html).not.toContain('data-testid="mcp-servers-card-proxy-toggle"');
  });
});

describe('mcpPanelCardSubtitle', () => {
  it('shows "Checking servers" while loading', () => {
    expect(mcpPanelCardSubtitle({ loading: true, serverCount: 0 })).toBe(
      'Checking servers',
    );
    expect(mcpPanelCardSubtitle({ loading: true, serverCount: 5 })).toBe(
      'Checking servers',
    );
  });

  it('shows "No servers" when empty and not loading', () => {
    expect(mcpPanelCardSubtitle({ loading: false, serverCount: 0 })).toBe(
      'No servers',
    );
  });

  it('pluralizes the server count correctly', () => {
    expect(mcpPanelCardSubtitle({ loading: false, serverCount: 1 })).toBe(
      '1 server',
    );
    expect(mcpPanelCardSubtitle({ loading: false, serverCount: 2 })).toBe(
      '2 servers',
    );
  });
});

describe('mcpAuthStatusLabel', () => {
  it('maps every auth status to its visible label', () => {
    expect(mcpAuthStatusLabel('connected')).toBe('Connected');
    expect(mcpAuthStatusLabel('not_connected')).toBe('Needs auth');
    expect(mcpAuthStatusLabel('expired')).toBe('Expired');
    expect(mcpAuthStatusLabel('error')).toBe('Error');
    expect(mcpAuthStatusLabel('not_configured')).toBe('No auth');
    expect(mcpAuthStatusLabel('unsupported')).toBe('Unsupported');
  });
});

describe('mcpRowSecondaryText', () => {
  it('formats standalone rows with the config name', () => {
    expect(
      mcpRowSecondaryText(
        makeServer({ source: 'standalone', configName: 'Default' }),
      ),
    ).toBe('Standalone · Default');
  });

  it('formats collection rows with the collection id', () => {
    expect(
      mcpRowSecondaryText(
        makeServer({ source: 'collection', collectionId: 'core' }),
      ),
    ).toBe('Collection · core');
  });

  it('formats legacy bundle rows as Collections', () => {
    expect(
      mcpRowSecondaryText(makeServer({ source: 'bundle', bundleId: 'core' })),
    ).toBe('Collection · core');
  });

  it('formats plugin rows with the plugin name', () => {
    expect(
      mcpRowSecondaryText(
        makeServer({ source: 'plugin', pluginName: 'Linear' }),
      ),
    ).toBe('Plugin · Linear');
  });
});
