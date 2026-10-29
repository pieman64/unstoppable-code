/** @jest-environment jsdom */
import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ProviderConnectorListResult } from '@canopy/protocol/mcp-servers';
import type { CuratedMcpServerEntry } from '@canopy/protocol/mcp-catalog';
import { ProviderConnectorDetail } from '../ProviderConnectorDetail';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

function mount(element: JSX.Element): {
  container: HTMLDivElement;
  root: Root;
} {
  const container = document.createElement('div');
  const root = createRoot(container);
  act(() => root.render(element));
  return { container, root };
}

const results: ProviderConnectorListResult[] = [
  {
    provider: 'claude',
    status: 'ok',
    connectors: [
      {
        key: 'slack',
        displayName: 'Slack',
        connected: false,
        installUrl: 'https://claude.ai/settings/connectors/slack',
      },
    ],
  },
];

const curated: CuratedMcpServerEntry[] = [];

describe('ProviderConnectorDetail', () => {
  it('routes Connect through the injected host settings callback', async () => {
    const onOpenProviderSettings = jest.fn(() => Promise.resolve());
    const { container, root } = mount(
      <ProviderConnectorDetail
        displayName="Slack"
        results={results}
        curatedMcpServers={curated}
        loading={false}
        onConnected={jest.fn()}
        appName="Example App"
        onOpenProviderSettings={onOpenProviderSettings}
      />,
    );

    expect(container.textContent).toContain('Example App');
    const connect = container.querySelector<HTMLButtonElement>(
      '[data-testid="provider-connector-detail-connect-claude"]',
    );
    expect(connect).not.toBeNull();
    await act(async () => {
      connect?.click();
      await Promise.resolve();
    });

    expect(onOpenProviderSettings).toHaveBeenCalledWith({
      provider: 'claude',
      installUrl: 'https://claude.ai/settings/connectors/slack',
    });
    act(() => root.unmount());
  });

  it('identifies the connector with its catalog mark and vendor', () => {
    // This panel was the only capability detail with no identity header, so a
    // connector that shows the Gmail mark and "Google" on its card lost both
    // on open — while the curated MCP and plugin catalog details beside it
    // render exactly this.
    const curatedMcpServers: CuratedMcpServerEntry[] = [
      {
        key: 'gmail-gmailmcp',
        name: 'Gmail',
        shortDescription: 'Read and send mail.',
        authorName: 'Google',
        authorUrl: 'https://cloud.google.com/',
        logoUrl: 'https://cdn.example.test/gmail.png',
        categories: ['communication'],
        popular: true,
        sortOrder: 0,
        transport: 'http',
        url: 'https://mcp.example.test/gmail',
        providerConnector: { providers: ['claude', 'codex'] },
        updatedAt: '2026-08-01T00:00:00.000Z',
      },
    ];

    const { container, root } = mount(
      <ProviderConnectorDetail
        displayName="Gmail"
        results={[]}
        curatedMcpServers={curatedMcpServers}
        loading={false}
        onConnected={jest.fn()}
        appName="Example App"
        onOpenProviderSettings={jest.fn(() => Promise.resolve())}
      />,
    );

    const header = container.querySelector(
      '[data-testid="provider-connector-detail-header"]',
    );
    expect(header).not.toBeNull();
    expect(header?.textContent).toContain('Gmail');
    expect(header?.textContent).toContain('Google');
    expect(
      container.querySelector('[data-testid="provider-connector-detail-logo"]'),
    ).not.toBeNull();

    act(() => root.unmount());
  });

  it('hands the catalog logo URL to the host logo adapter', () => {
    // The browser-safe default logo never fetches remote artwork, so the URL
    // only matters once a host injects an adapter that can. Without the
    // injection seam a connector lacking a bundled mark sat on a monogram
    // while its card, rendered through the host adapter, showed the logo.
    const seen: Array<{ logoUrl?: string; curatedKey?: string }> = [];
    function RecordingLogo(props: {
      logoUrl?: string;
      curatedKey?: string;
    }): JSX.Element {
      seen.push({ logoUrl: props.logoUrl, curatedKey: props.curatedKey });
      return <span data-testid="recording-logo" />;
    }
    const curatedMcpServers: CuratedMcpServerEntry[] = [
      {
        key: 'acme-mail',
        name: 'Acme Mail',
        shortDescription: 'Mail for Acme.',
        authorName: 'Acme',
        logoUrl: 'https://cdn.example.test/acme.png',
        categories: [],
        popular: false,
        sortOrder: 0,
        transport: 'http',
        url: 'https://mcp.example.test/acme',
        providerConnector: { providers: ['claude'] },
        updatedAt: '2026-08-01T00:00:00.000Z',
      },
    ];

    const { container, root } = mount(
      <ProviderConnectorDetail
        displayName="Acme Mail"
        results={[]}
        curatedMcpServers={curatedMcpServers}
        loading={false}
        onConnected={jest.fn()}
        appName="Example App"
        onOpenProviderSettings={jest.fn(() => Promise.resolve())}
        McpServerLogoComponent={RecordingLogo}
      />,
    );

    expect(
      container.querySelector('[data-testid="recording-logo"]'),
    ).not.toBeNull();
    expect(seen.at(-1)).toEqual({
      logoUrl: 'https://cdn.example.test/acme.png',
      curatedKey: 'acme-mail',
    });

    act(() => root.unmount());
  });

  it('renders as a labelled route section inside a host detail (REG-3033)', () => {
    // Folded into an integration card, the host detail already shows the
    // service's mark, name, and vendor. A second header made the page read as
    // two pages, and nothing said these rows were a different route from the
    // app's own MCP server.
    const { container, root } = mount(
      <ProviderConnectorDetail
        variant="section"
        displayName="Slack"
        results={results}
        curatedMcpServers={curated}
        loading={false}
        onConnected={jest.fn()}
        appName="Example App"
        onOpenProviderSettings={jest.fn(() => Promise.resolve())}
      />,
    );

    expect(
      container.querySelector(
        '[data-testid="provider-connector-detail-header"]',
      ),
    ).toBeNull();
    const section = container.querySelector(
      '[data-testid="provider-connector-detail"]',
    );
    expect(section?.tagName).toBe('SECTION');
    expect(section?.querySelector('h3')?.textContent).toBe(
      'Provider connections',
    );
    // Only Claude offers this connector, so the copy names only Claude.
    expect(section?.textContent).toContain(
      'Connects through your Claude account. Works in every chat on that provider, and Example App never sees these credentials.',
    );
    expect(section?.textContent).not.toContain('Codex');
    // The standalone introduction would repeat the section's description.
    expect(section?.textContent).not.toContain('Connect Slack with your');
    // The route keeps its own rows and its own Re-check.
    expect(
      section?.querySelector(
        '[data-testid="provider-connector-detail-connect-claude"]',
      ),
    ).not.toBeNull();
    expect(
      section?.querySelector(
        '[data-testid="provider-connector-detail-refresh"]',
      ),
    ).not.toBeNull();

    act(() => root.unmount());
  });

  it('names every provider the catalog lists for the connector', () => {
    const curatedMcpServers: CuratedMcpServerEntry[] = [
      {
        key: 'gmail-gmailmcp',
        name: 'Gmail',
        shortDescription: 'Read and send mail.',
        categories: [],
        popular: false,
        sortOrder: 0,
        transport: 'http',
        url: 'https://mcp.example.test/gmail',
        providerConnector: { providers: ['claude', 'codex'] },
        updatedAt: '2026-08-01T00:00:00.000Z',
      },
    ];
    for (const variant of ['page', 'section'] as const) {
      const { container, root } = mount(
        <ProviderConnectorDetail
          variant={variant}
          displayName="Gmail"
          results={[]}
          curatedMcpServers={curatedMcpServers}
          loading={false}
          onConnected={jest.fn()}
          appName="Example App"
          onOpenProviderSettings={jest.fn(() => Promise.resolve())}
        />,
      );
      expect(container.textContent).toContain('your Claude or Codex account');
      // Before any read answers, the catalog still supplies the providers, so
      // the rows say Checking rather than claiming no provider offers it.
      expect(container.textContent).not.toContain('No provider offers');
      expect(
        container.querySelector(
          '[data-testid="provider-connector-detail-pending-claude"]',
        ),
      ).not.toBeNull();
      act(() => root.unmount());
    }
  });

  it('falls back to the monogram when the catalog carries no artwork', () => {
    // A connector the catalog does not describe still gets a header; it just
    // has nothing to put in it beyond the name.
    const { container, root } = mount(
      <ProviderConnectorDetail
        displayName="Slack"
        results={results}
        curatedMcpServers={[]}
        loading={false}
        onConnected={jest.fn()}
        appName="Example App"
        onOpenProviderSettings={jest.fn(() => Promise.resolve())}
      />,
    );

    const header = container.querySelector(
      '[data-testid="provider-connector-detail-header"]',
    );
    expect(header).not.toBeNull();
    expect(header?.textContent).toContain('Slack');
    expect(
      container.querySelector(
        '[data-testid="provider-connector-detail-logo-fallback"]',
      ),
    ).not.toBeNull();

    act(() => root.unmount());
  });
});
