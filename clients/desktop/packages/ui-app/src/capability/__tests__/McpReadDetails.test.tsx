/** @jest-environment jsdom */
import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { CuratedMcpServerEntry } from '@canopy/protocol/mcp-catalog';
import type { McpServerData } from '@canopy/protocol/mcp-servers';
import type { PortalMcpServerDetail } from '@canopy/protocol/portal';
import { CuratedMcpDetail } from '../CuratedMcpDetail';
import { McpServerReadDetail } from '../McpServerReadDetail';

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

const curated: CuratedMcpServerEntry = {
  key: 'linear',
  name: 'Linear',
  shortDescription: 'Issue tracking',
  longDescription: 'Read and update issues.',
  categories: ['productivity'],
  popular: true,
  sortOrder: 1,
  transport: 'http',
  url: 'https://mcp.linear.app',
  updatedAt: '2026-10-01T00:00:00.000Z',
};

describe('CuratedMcpDetail', () => {
  const baseProps = {
    entry: curated,
    installedServerId: 'server-1',
    toolNames: ['search_issues'],
    toolsLoading: false,
    toolsError: '',
  };

  it.each([
    {
      name: 'loading',
      props: { toolsLoading: true, toolNames: null, toolsError: '' },
      text: 'Loading tools',
    },
    {
      name: 'loaded',
      props: {
        toolsLoading: false,
        toolNames: ['search_issues'],
        toolsError: '',
      },
      text: 'search_issues',
    },
    {
      name: 'error',
      props: {
        toolsLoading: false,
        toolNames: null,
        toolsError: 'Unable to load tools.',
      },
      text: 'Unable to load tools.',
    },
  ])('renders the $name tools state', ({ props, text }) => {
    const { container, root } = mount(
      <CuratedMcpDetail {...baseProps} {...props} />,
    );
    expect(container.textContent).toContain(text);
    act(() => root.unmount());
  });

  it('inks the tools error with the destructive role', () => {
    const { container, root } = mount(
      <CuratedMcpDetail
        {...baseProps}
        toolNames={null}
        toolsError="Unable to load tools."
      />,
    );
    expect(
      container
        .querySelector('[data-testid="mcp-browse-tools-error"]')
        ?.classList.contains('fg-destructive'),
    ).toBe(true);
    act(() => root.unmount());
  });

  it('shows only callbacks that are available', () => {
    const onAdd = jest.fn();
    const onConfigure = jest.fn();
    const { container, root } = mount(
      <CuratedMcpDetail
        {...baseProps}
        onAdd={onAdd}
        onConfigure={onConfigure}
      />,
    );
    const configure = container.querySelector<HTMLButtonElement>(
      '[data-testid="plugin-advanced-configuration"]',
    );
    expect(configure?.textContent).toBe('Advanced configuration');
    act(() => configure?.click());
    expect(onConfigure).toHaveBeenCalledTimes(1);
    expect(
      container.querySelector('[data-testid="mcp-browse-detail-add"]'),
    ).toBeNull();

    act(() =>
      root.render(
        <CuratedMcpDetail
          {...baseProps}
          installedServerId={null}
          toolNames={null}
          onAdd={onAdd}
        />,
      ),
    );
    expect(
      container.querySelector('[data-testid="mcp-browse-detail-add"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-testid="plugin-advanced-configuration"]'),
    ).toBeNull();

    act(() =>
      root.render(
        <CuratedMcpDetail
          {...baseProps}
          onAdd={undefined}
          onConfigure={undefined}
        />,
      ),
    );
    expect(
      container.querySelector('[data-testid="mcp-browse-detail-add"]'),
    ).toBeNull();
    expect(
      container.querySelector('[data-testid="plugin-advanced-configuration"]'),
    ).toBeNull();
    act(() => root.unmount());
  });

  it('frames its own connection and tools as one route when another exists (REG-3033)', () => {
    // A provider connector folded into the card is a second route to the
    // same service. Unlabelled, its rows and this entry's connection read as
    // one confusing list; the tools belong to this entry's route only.
    const { container, root } = mount(
      <CuratedMcpDetail
        {...baseProps}
        entry={{
          ...curated,
          providerConnector: { providers: ['claude'] },
          oauthHints: { scopes: ['read'] },
        }}
        connectionContent={<p data-testid="own-connection">Connected</p>}
        routes={{
          own: {
            title: 'Example App MCP server',
            description: 'Connects through Example App.',
          },
          others: (
            <section data-testid="other-route">Provider connections</section>
          ),
        }}
      />,
    );

    const own = container.querySelector(
      '[data-testid="mcp-browse-detail-app-route"]',
    );
    expect(own?.tagName).toBe('SECTION');
    expect(own?.querySelector('h3')?.textContent).toBe(
      'Example App MCP server',
    );
    expect(own?.textContent).toContain('Connects through Example App.');
    expect(own?.querySelector('[data-testid="own-connection"]')).not.toBeNull();
    expect(
      own?.querySelector('[data-testid="mcp-browse-tools"]'),
    ).not.toBeNull();
    const other = container.querySelector('[data-testid="other-route"]');
    expect(other).not.toBeNull();
    expect(own?.contains(other)).toBe(false);
    // The other route follows this entry's whole route, tools included.
    expect(
      own && other
        ? own.compareDocumentPosition(other) & Node.DOCUMENT_POSITION_FOLLOWING
        : 0,
    ).not.toBe(0);
    act(() => root.unmount());
  });

  it.each([null, 'legacy-device-server'])(
    'hides the app route for a provider-only entry with installed id %s',
    (installedServerId) => {
      const { container, root } = mount(
        <CuratedMcpDetail
          {...baseProps}
          entry={{
            ...curated,
            providerConnector: { providers: ['claude', 'codex'] },
          }}
          installedServerId={installedServerId}
          onAdd={jest.fn()}
          onConfigure={jest.fn()}
          connectionContent={<p data-testid="own-connection">Connected</p>}
          routes={{
            own: {
              title: 'Example App MCP server',
              description: 'Connects through Example App.',
            },
            others: (
              <section data-testid="other-route">Provider connections</section>
            ),
          }}
        />,
      );
      expect(
        container.querySelector('[data-testid="mcp-browse-detail-app-route"]'),
      ).toBeNull();
      expect(
        container.querySelector('[data-testid="own-connection"]'),
      ).toBeNull();
      expect(
        container.querySelector('[data-testid="mcp-browse-tools"]'),
      ).toBeNull();
      expect(
        container.querySelector('[data-testid="mcp-browse-detail-add"]'),
      ).toBeNull();
      expect(
        container.querySelector(
          '[data-testid="plugin-advanced-configuration"]',
        ),
      ).toBeNull();
      expect(
        container.querySelector('[data-testid="other-route"]'),
      ).not.toBeNull();
      expect(container.querySelectorAll('h3')).toHaveLength(1);
      act(() => root.unmount());
    },
  );

  it('omits unsupported connection content and tools when a provider-only entry has no other route data', () => {
    const { container, root } = mount(
      <CuratedMcpDetail
        {...baseProps}
        entry={{ ...curated, providerConnector: { providers: ['claude'] } }}
        connectionContent={<p data-testid="own-connection">Connected</p>}
      />,
    );
    expect(
      container.querySelector('[data-testid="own-connection"]'),
    ).toBeNull();
    expect(
      container.querySelector('[data-testid="mcp-browse-tools"]'),
    ).toBeNull();
    expect(container.querySelector('h3')?.textContent).toBe(curated.name);
    act(() => root.unmount());
  });

  it('tells a provider-only entry how to connect when no provider routes are shown', () => {
    const providerOnly = {
      ...curated,
      name: 'Gmail',
      providerConnector: { providers: ['claude' as const, 'codex' as const] },
    };
    const { container, root } = mount(
      <CuratedMcpDetail {...baseProps} entry={providerOnly} />,
    );
    expect(
      container.querySelector(
        '[data-testid="mcp-browse-detail-provider-guidance"]',
      )?.textContent,
    ).toBe(
      'Gmail connects through your Claude or Codex account. Connect Claude or Codex first, then link Gmail there.',
    );
    act(() =>
      root.render(
        <CuratedMcpDetail
          {...baseProps}
          entry={providerOnly}
          routes={{ others: <section data-testid="other-route" /> }}
        />,
      ),
    );
    // The provider section itself is the next step, so no second notice.
    expect(
      container.querySelector(
        '[data-testid="mcp-browse-detail-provider-guidance"]',
      ),
    ).toBeNull();
    act(() => root.unmount());
  });

  it('keeps the single-route layout when no other route exists', () => {
    const { container, root } = mount(
      <CuratedMcpDetail
        {...baseProps}
        connectionContent={<p data-testid="own-connection">Connected</p>}
      />,
    );
    expect(
      container.querySelector('[data-testid="mcp-browse-detail-app-route"]'),
    ).toBeNull();
    expect(
      container.querySelector('[data-testid="own-connection"]'),
    ).not.toBeNull();
    act(() => root.unmount());
  });
});

const server: PortalMcpServerDetail = {
  id: 'server-1',
  name: 'Redacted server',
  description: 'Safe description',
  type: 'http',
  url: 'https://mcp.example.com/path',
  headerNames: ['X-Workspace'],
  httpAuthHandler: 'canopy',
  oauth: {
    hasClientId: true,
    hasClientSecret: false,
    authorizationUrl: 'https://auth.example.com/authorize',
    tokenUrl: 'https://auth.example.com/token',
    scopes: ['repo', 'read:user'],
    audience: 'mcp-api',
  },
  curated: {
    key: 'github',
    authorName: 'Acme Tools',
    authorUrl: 'https://acme.example.com',
    docsUrl: 'https://docs.example.com/mcp',
    supportUrl: 'https://support.example.com',
    privacyPolicyUrl: 'https://acme.example.com/privacy',
    requiresProviderAuth: true,
  },
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  configs: [
    {
      id: 'config-1',
      name: 'Default',
      description: 'Primary config',
      enabled: true,
      envVarNames: ['API_TOKEN'],
      extraArgCount: 2,
      extraHeaderNames: ['Authorization'],
      hasAuthToken: true,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
  ],
};

describe('McpServerReadDetail', () => {
  it('mounts installed status controls without a competing legacy switch', () => {
    const { container, root } = mount(
      <McpServerReadDetail
        server={server}
        onToggleConfig={jest.fn()}
        statusSection={<div data-testid="status-controls">Status</div>}
      />,
    );
    expect(
      container.querySelector('[data-testid="status-controls"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-testid="mcp-server-read-config-toggle"]'),
    ).toBeNull();
    act(() => root.unmount());
  });
  it('renders only the sanitized projection and config state', () => {
    const { container, root } = mount(
      <McpServerReadDetail server={server} appAuthHandlerLabel="Acme App" />,
    );
    expect(container.textContent).toContain('Redacted server');
    expect(container.textContent).toContain('https://mcp.example.com/path');
    expect(container.textContent).toContain('X-Workspace');
    expect(container.textContent).toContain('API_TOKEN');
    expect(container.textContent).toContain('token configured');
    expect(container.textContent).toContain('Updated 2026-01-01T00:00:00.000Z');
    expect(container.textContent).toContain('Client IDconfigured');
    expect(container.textContent).toContain('Client secretnot configured');
    expect(container.textContent).toContain(
      'https://auth.example.com/authorize',
    );
    expect(container.textContent).toContain('https://auth.example.com/token');
    expect(container.textContent).toContain('repo, read:user');
    expect(container.textContent).toContain('mcp-api');
    expect(container.textContent).toContain('Auth handlingAcme App');
    expect(container.textContent).toContain('Curated catalog');
    expect(container.textContent).toContain('github');
    expect(container.textContent).toContain('Acme Tools');
    expect(container.textContent).toContain('https://docs.example.com/mcp');
    expect(container.textContent).toContain('https://support.example.com');
    expect(container.textContent).toContain('https://acme.example.com/privacy');
    expect(container.textContent).toContain('Provider authRequired');
    expect(
      container.querySelector<HTMLAnchorElement>(
        'a[href="https://acme.example.com"]',
      )?.textContent,
    ).toBe('Acme Tools');
    expect(container.textContent).not.toContain('secret-value');
    act(() => root.unmount());
  });

  it('labels provider-owned and default app-owned HTTP auth', () => {
    const provider = mount(
      <McpServerReadDetail
        server={{ ...server, httpAuthHandler: 'provider' }}
      />,
    );
    expect(provider.container.textContent).toContain('Auth handlingProvider');
    act(() => provider.root.unmount());

    const app = mount(<McpServerReadDetail server={server} />);
    expect(app.container.textContent).toContain('Auth handlingApp');
    act(() => app.root.unmount());
  });

  it('delegates config toggles and configure only when supplied', () => {
    const onToggleConfig = jest.fn();
    const onConfigure = jest.fn();
    const { container, root } = mount(
      <McpServerReadDetail
        server={server}
        onToggleConfig={onToggleConfig}
        onConfigure={onConfigure}
      />,
    );
    const toggle = container.querySelector<HTMLButtonElement>(
      '[data-testid="mcp-server-read-config-toggle"]',
    );
    expect(toggle?.getAttribute('aria-label')).toBe('Disable Default');
    act(() => toggle?.click());
    expect(onToggleConfig).toHaveBeenCalledWith('config-1', false);
    act(() =>
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="mcp-server-read-configure"]',
        )
        ?.click(),
    );
    expect(onConfigure).toHaveBeenCalledTimes(1);
    act(() => root.unmount());
  });

  it('renders host-owned pending and error feedback per config', () => {
    const { container, root } = mount(
      <McpServerReadDetail
        server={server}
        onToggleConfig={jest.fn()}
        configToggleFeedback={{
          'config-1': { pending: true, message: 'Save failed.', tone: 'error' },
        }}
      />,
    );
    const toggle = container.querySelector<HTMLButtonElement>(
      '[data-testid="mcp-server-read-config-toggle"]',
    );
    expect(toggle?.disabled).toBe(true);
    expect(toggle?.textContent).toBe('Saving…');
    const message = container.querySelector(
      '[data-testid="mcp-server-read-config-feedback"]',
    );
    expect(message?.textContent).toBe('Save failed.');
    expect(message?.classList.contains('fg-destructive')).toBe(true);
    act(() => root.unmount());
  });

  it('renders muted host-owned feedback', () => {
    const { container, root } = mount(
      <McpServerReadDetail
        server={server}
        onToggleConfig={jest.fn()}
        configToggleFeedback={{
          'config-1': { message: 'Refresh to check.', tone: 'muted' },
        }}
      />,
    );
    const message = container.querySelector(
      '[data-testid="mcp-server-read-config-feedback"]',
    );
    expect(message?.classList.contains('fg-secondary')).toBe(true);
    act(() => root.unmount());
  });

  it('rejects credential-bearing raw server data at the props boundary', () => {
    const rawServer: McpServerData = {
      definition: {
        id: 'srv-1',
        name: 'Raw Server',
        description: 'Credential-bearing raw definition.',
        type: 'command',
        command: 'node',
        args: ['server.js', '--token', 'secret-value'],
        createdAt: '2026-10-01T00:00:00.000Z',
        updatedAt: '2026-10-01T00:00:00.000Z',
      },
      configs: [
        {
          id: 'cfg-1',
          name: 'default',
          description: '',
          enabled: true,
          envVars: { API_KEY: 'secret-value' },
          extraArgs: [],
          extraHeaders: {},
          createdAt: '2026-10-01T00:00:00.000Z',
          updatedAt: '2026-10-01T00:00:00.000Z',
        },
      ],
    };
    // @ts-expect-error Raw definitions/configs contain credential-bearing values and are not accepted.
    const unsafe = <McpServerReadDetail server={rawServer} />;
    expect(unsafe).toBeDefined();
  });
});
