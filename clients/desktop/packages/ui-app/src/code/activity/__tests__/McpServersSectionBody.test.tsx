/** @jest-environment jsdom */
import { act, type JSX } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { MCP_ROW_ACTION_CLASS_NAME } from '@canopy/ui-shared/lib';
import {
  ActivityItemDensityContext,
  buttonClassName,
} from '@canopy/ui-shared/components';
import {
  McpServersSectionBody,
  type McpServersSectionItem,
} from '../McpServersSectionBody';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

function makeServer(
  overrides: Partial<McpServersSectionItem> = {},
): McpServersSectionItem {
  return {
    key: 'server-key',
    source: 'standalone',
    displayName: 'GitHub',
    enabled: true,
    configName: 'Default',
    authStatus: 'not_connected',
    authStatusLabel: 'Needs auth',
    canConnect: true,
    ...overrides,
  };
}

describe('McpServersSectionBody', () => {
  it('lets a host relabel a row action it already has, and never adds one', () => {
    const markup = renderToStaticMarkup(
      <McpServersSectionBody
        servers={[
          makeServer({ key: 'open', connectActionLabel: 'Enable' }),
          makeServer({
            key: 'done',
            authStatus: 'connected',
            authStatusLabel: 'Connected',
            canConnect: true,
            connectActionLabel: 'Enable',
          }),
          makeServer({ key: 'plain' }),
        ]}
        warnings={[]}
        loading={false}
        error={null}
        connectingKey={null}
        showProxyToggle={false}
        brandAppName=""
        proxyLogo={null}
        onConnect={jest.fn()}
      />,
    );
    const host = document.createElement('div');
    host.innerHTML = markup;
    const labels = Array.from(
      host.querySelectorAll('[data-testid="mcp-servers-card-connect"]'),
      (button) => button.textContent,
    );
    expect(labels).toEqual(['Enable', 'Sign in']);
  });

  it('keeps a waiting sign-in on its row with a Waiting… pill, Reopen, and a cancel control', () => {
    const onConnect = jest.fn();
    const onCancelSignIn = jest.fn();
    const waiting = makeServer({
      connectDisabled: true,
      signInUrl: 'https://auth.example/authorize',
    });
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() =>
      root.render(
        <McpServersSectionBody
          servers={[waiting]}
          warnings={[]}
          loading={false}
          error={null}
          connectingKey={null}
          showProxyToggle={false}
          brandAppName=""
          proxyLogo={null}
          onConnect={onConnect}
          onCancelSignIn={onCancelSignIn}
        />,
      ),
    );
    const byTestId = <T extends HTMLElement = HTMLElement>(
      testId: string,
    ): T | null => container.querySelector<T>(`[data-testid="${testId}"]`);
    const pill = byTestId('mcp-servers-card-badge');
    expect(pill?.textContent).toBe('Waiting for sign-in');
    expect(pill?.getAttribute('role')).toBe('status');
    expect(byTestId('mcp-servers-card-connect')).toBeNull();
    const reopen = byTestId<HTMLAnchorElement>(
      'mcp-servers-card-sign-in-reopen',
    );
    expect(reopen?.textContent).toBe('Reopen');
    expect(reopen?.getAttribute('aria-label')).toBe('Reopen GitHub sign-in');
    expect(reopen?.href).toBe('https://auth.example/authorize');
    expect(reopen?.target).toBe('_blank');
    expect(reopen?.rel).toBe('noopener noreferrer');
    // Reopen has the row actions' size and shape, beside its cancel.
    expect(reopen?.className).toContain(MCP_ROW_ACTION_CLASS_NAME);
    const cancel = byTestId('mcp-servers-card-sign-in-cancel');
    expect(cancel?.getAttribute('aria-label')).toBe('Cancel GitHub sign-in');
    expect(reopen?.parentElement?.contains(cancel ?? null)).toBe(true);
    act(() => cancel?.click());
    expect(onCancelSignIn).toHaveBeenCalledWith(waiting);
    expect(onConnect).not.toHaveBeenCalled();
    act(() => root.unmount());
    container.remove();
  });

  it('uses warning ink and no extra top margin for a warning-only body', () => {
    const html = renderToStaticMarkup(
      <McpServersSectionBody
        servers={[]}
        warnings={['Unavailable plugin']}
        proxyLogo={null}
        loading={false}
        error={null}
        connectingKey={null}
        brandAppName="Test App"
      />,
    );
    expect(html).toContain('fg-warning');
    expect(html).not.toContain('mt-2');
  });
  it('renders loading, error, and an exactly empty body', () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const commonProps = {
      warnings: [],
      connectingKey: null,
      brandAppName: 'Test App',
      proxyLogo: <span>logo</span>,
      onConnect: jest.fn(),
      onOpenDetails: jest.fn(),
    };

    act(() => {
      root.render(
        <McpServersSectionBody
          {...commonProps}
          servers={[]}
          loading
          error={null}
        />,
      );
    });
    expect(
      container.querySelector('[data-testid="mcp-servers-card-loading"]'),
    ).not.toBeNull();

    act(() => {
      root.render(
        <McpServersSectionBody
          {...commonProps}
          servers={[]}
          loading={false}
          error="Inventory failed"
        />,
      );
    });
    expect(
      container.querySelector('[data-testid="mcp-servers-card-error"]')
        ?.textContent,
    ).toBe('Inventory failed');

    act(() => {
      root.render(
        <McpServersSectionBody
          {...commonProps}
          servers={[]}
          loading={false}
          error={null}
        />,
      );
    });
    expect(container.childElementCount).toBe(0);

    act(() => root.unmount());
    container.remove();
  });

  it('renders all badge states, secondary lines, errors, and warnings', () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const servers: readonly McpServersSectionItem[] = [
      makeServer({
        key: 'connected',
        authStatus: 'connected',
        authStatusLabel: 'Connected',
      }),
      makeServer({
        key: 'needs-auth',
        source: 'collection',
        collectionId: 'core',
      }),
      makeServer({
        key: 'expired',
        source: 'bundle',
        bundleId: 'legacy',
        authStatus: 'expired',
        authStatusLabel: 'Expired',
      }),
      makeServer({
        key: 'error',
        source: 'plugin',
        pluginName: 'Linear',
        authStatus: 'error',
        authStatusLabel: 'Error',
        lastError: 'Token refresh failed',
      }),
      makeServer({
        key: 'no-auth',
        authStatus: 'not_configured',
        authStatusLabel: 'No auth',
      }),
      makeServer({
        key: 'unsupported',
        authStatus: 'unsupported',
        authStatusLabel: 'Unsupported',
      }),
    ];

    act(() => {
      root.render(
        <McpServersSectionBody
          servers={servers}
          warnings={['Missing server']}
          loading={false}
          error={null}
          connectingKey={null}
          brandAppName="Test App"
          proxyLogo={<span>logo</span>}
          onConnect={jest.fn()}
          onOpenDetails={jest.fn()}
        />,
      );
    });

    expect(
      container.querySelectorAll('[data-testid="mcp-servers-card-badge"]'),
    ).toHaveLength(6);
    expect(container.textContent).toContain('Standalone · Default');
    // Enabled state is intentionally NOT rendered as row text: the shared
    // body is also the desktop card, where enabled is conveyed by the
    // interactive toggle, not copy.
    expect(container.textContent).not.toContain('· Enabled');
    expect(container.textContent).toContain('Collection · core');
    expect(container.textContent).toContain('Collection · legacy');
    expect(container.textContent).toContain('Plugin · Linear');
    expect(container.textContent).toContain('Token refresh failed');
    expect(
      container.querySelector('[data-testid="mcp-servers-card-warnings"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-testid="mcp-servers-card-warnings"]')
        ?.className,
    ).toContain('mt-2');

    const list = container.querySelector(
      '[data-testid="mcp-servers-card-list"]',
    );
    const rows = container.querySelectorAll(
      '[data-testid="mcp-servers-card-row"]',
    );
    expect(list?.className).toContain('divide-y');
    expect(list?.className).toContain('overflow-hidden');
    expect(rows[0]?.className).not.toContain('rounded-md');
    expect(rows[0]?.className).not.toContain('border-border');

    act(() => root.unmount());
    container.remove();
  });

  it('renders view-only rows and a truthful empty state without actions', () => {
    const populated = renderToStaticMarkup(
      <McpServersSectionBody
        servers={[makeServer({ enabled: false })]}
        warnings={[]}
        loading={false}
        error={null}
        connectingKey={null}
        showProxyToggle={false}
        brandAppName=""
        proxyLogo={null}
        emptyLabel="No MCP servers."
      />,
    );
    expect(populated).toContain('GitHub');
    // Enabled state is not row copy — desktop conveys it via its toggle,
    // and the shared body must not add desktop-visible text.
    expect(populated).not.toContain('Disabled');
    expect(populated).not.toContain('<button');

    const empty = renderToStaticMarkup(
      <McpServersSectionBody
        servers={[]}
        warnings={[]}
        loading={false}
        error={null}
        connectingKey={null}
        showProxyToggle={false}
        brandAppName=""
        proxyLogo={null}
        emptyLabel="No MCP servers."
      />,
    );
    expect(empty).toContain('No MCP servers.');
  });

  it('wires details, connect, and proxy actions with updating states', () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const server = makeServer({
      canToggleCanopyProxy: true,
      canopyProxyEnabled: false,
    });
    const onConnect = jest.fn();
    const onSetCanopyProxyEnabled = jest.fn();
    const onOpenDetails = jest.fn();

    act(() => {
      root.render(
        <McpServersSectionBody
          servers={[server]}
          warnings={[]}
          loading={false}
          error={null}
          connectingKey="server-key"
          proxyUpdatingKey="server-key"
          brandAppName="Test App"
          proxyLogo={<span>logo</span>}
          onConnect={onConnect}
          onSetCanopyProxyEnabled={onSetCanopyProxyEnabled}
          onOpenDetails={onOpenDetails}
        />,
      );
    });

    const name = container.querySelector<HTMLButtonElement>(
      '[data-testid="mcp-servers-card-name"]',
    );
    const connect = container.querySelector<HTMLButtonElement>(
      '[data-testid="mcp-servers-card-connect"]',
    );
    const toggle = container.querySelector<HTMLButtonElement>(
      '[data-testid="mcp-servers-card-proxy-toggle"]',
    );
    expect(connect?.textContent).toBe('Opening sign-in…');
    expect(connect?.disabled).toBe(true);
    expect(toggle?.disabled).toBe(true);
    expect(toggle?.getAttribute('aria-pressed')).toBe('false');
    expect(toggle?.getAttribute('aria-label')).toContain('Test App proxy');

    act(() => name?.click());
    expect(onOpenDetails).toHaveBeenCalledWith(server);

    act(() => {
      root.render(
        <McpServersSectionBody
          servers={[server]}
          warnings={[]}
          loading={false}
          error={null}
          connectingKey={null}
          brandAppName="Test App"
          proxyLogo={<span>logo</span>}
          onConnect={onConnect}
          onSetCanopyProxyEnabled={onSetCanopyProxyEnabled}
          onOpenDetails={onOpenDetails}
        />,
      );
    });
    act(() => {
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="mcp-servers-card-connect"]',
        )
        ?.click();
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="mcp-servers-card-proxy-toggle"]',
        )
        ?.click();
    });
    expect(onConnect).toHaveBeenCalledWith(server);
    expect(onSetCanopyProxyEnabled).toHaveBeenCalledWith(server, true);

    act(() => root.unmount());
    container.remove();
  });
  it('offers Disconnect with a pending state and renders the host row extra', () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const server = makeServer({
      source: 'account',
      configName: 'Default',
      authStatus: 'connected',
      authStatusLabel: 'Connected',
      canConnect: false,
      canDisconnect: true,
    });
    const onDisconnect = jest.fn();
    const render = (disconnectingKey: string | null): void => {
      act(() => {
        root.render(
          <McpServersSectionBody
            servers={[server]}
            warnings={[]}
            loading={false}
            error={null}
            connectingKey={null}
            disconnectingKey={disconnectingKey}
            showProxyToggle={false}
            brandAppName=""
            proxyLogo={null}
            onConnect={jest.fn()}
            onDisconnect={onDisconnect}
            renderRowExtra={(row): JSX.Element => (
              <span data-testid="row-extra">{row.key}</span>
            )}
          />,
        );
      });
    };

    render(null);
    expect(
      container.querySelector('[data-testid="mcp-servers-card-connect"]'),
    ).toBeNull();
    expect(container.textContent).toContain('Account connection · Default');
    expect(
      container.querySelector('[data-testid="row-extra"]')?.textContent,
    ).toBe('server-key');
    const disconnect = container.querySelector<HTMLButtonElement>(
      '[data-testid="mcp-servers-card-disconnect"]',
    );
    expect(disconnect?.textContent).toBe('Disconnect');
    expect(disconnect?.disabled).toBe(false);
    // The shared secondary Button: `border-*` colors are inert under the
    // unlayered base border rule (CAN-2734), so it outlines with a ring.
    expect(disconnect?.className).toContain(
      buttonClassName({ variant: 'secondary', size: 'compact' }).trim(),
    );
    expect(disconnect?.className).not.toMatch(/(^|\s)border(\s|$)/);
    act(() => disconnect?.click());
    expect(onDisconnect).toHaveBeenCalledWith(server);

    render('server-key');
    const pending = container.querySelector<HTMLButtonElement>(
      '[data-testid="mcp-servers-card-disconnect"]',
    );
    expect(pending?.textContent).toBe('Disconnecting…');
    expect(pending?.disabled).toBe(true);

    act(() => root.unmount());
    container.remove();
  });

  it('marks every row whose own attempt is in flight as connecting', () => {
    const html = renderToStaticMarkup(
      <McpServersSectionBody
        servers={[
          makeServer({ key: 'one', connecting: true, connectDisabled: true }),
          makeServer({ key: 'two', connecting: true, connectDisabled: true }),
          makeServer({ key: 'three' }),
        ]}
        warnings={[]}
        loading={false}
        error={null}
        connectingKey={null}
        showProxyToggle={false}
        brandAppName=""
        proxyLogo={null}
        onConnect={jest.fn()}
      />,
    );
    const buttons = html.match(
      /<button[^>]*mcp-servers-card-connect[^>]*>[^<]*/g,
    );
    expect(buttons).toHaveLength(3);
    expect(buttons?.[0]).toContain('disabled=""');
    expect(buttons?.[0]).toMatch(/>Opening sign-in…$/);
    expect(buttons?.[1]).toContain('disabled=""');
    expect(buttons?.[1]).toMatch(/>Opening sign-in…$/);
    expect(buttons?.[2]).not.toContain('disabled=""');
    expect(buttons?.[2]).toMatch(/>Sign in$/);
    // `connectingKey` still marks a single row for one-at-a-time hosts.
    const keyed = renderToStaticMarkup(
      <McpServersSectionBody
        servers={[makeServer({ key: 'one' })]}
        warnings={[]}
        loading={false}
        error={null}
        connectingKey="one"
        showProxyToggle={false}
        brandAppName=""
        proxyLogo={null}
        onConnect={jest.fn()}
      />,
    );
    expect(keyed).toContain('Opening sign-in…');
  });

  it('disables Reconnect on a row while its disconnect is pending', () => {
    const reauth = makeServer({
      source: 'account',
      authStatus: 'expired',
      authStatusLabel: 'Reconnect required',
      canConnect: true,
      canDisconnect: true,
    });
    const render = (disconnectingKey: string | null): string =>
      renderToStaticMarkup(
        <McpServersSectionBody
          servers={[reauth]}
          warnings={[]}
          loading={false}
          error={null}
          connectingKey={null}
          disconnectingKey={disconnectingKey}
          showProxyToggle={false}
          brandAppName=""
          proxyLogo={null}
          onConnect={jest.fn()}
          onDisconnect={jest.fn()}
        />,
      );
    const connectButton = (html: string): string =>
      html.match(/<button[^>]*mcp-servers-card-connect[^>]*>[^<]*/)?.[0] ?? '';
    const pending = connectButton(render('server-key'));
    expect(pending).toMatch(/>Sign in$/);
    expect(pending).toContain('disabled=""');
    const settled = connectButton(render(null));
    expect(settled).toMatch(/>Sign in$/);
    expect(settled).not.toContain('disabled=""');
  });

  it('hides Disconnect without a host handler and keeps a disabled Sign in visible', () => {
    const withoutHandler = renderToStaticMarkup(
      <McpServersSectionBody
        servers={[makeServer({ canConnect: false, canDisconnect: true })]}
        warnings={[]}
        loading={false}
        error={null}
        connectingKey={null}
        showProxyToggle={false}
        brandAppName=""
        proxyLogo={null}
        onConnect={jest.fn()}
      />,
    );
    expect(withoutHandler).not.toContain('mcp-servers-card-disconnect');

    const withoutFlag = renderToStaticMarkup(
      <McpServersSectionBody
        servers={[makeServer({ canConnect: false })]}
        warnings={[]}
        loading={false}
        error={null}
        connectingKey={null}
        showProxyToggle={false}
        brandAppName=""
        proxyLogo={null}
        onDisconnect={jest.fn()}
      />,
    );
    expect(withoutFlag).not.toContain('mcp-servers-card-disconnect');

    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const onConnect = jest.fn();
    act(() => {
      root.render(
        <McpServersSectionBody
          servers={[makeServer({ connectDisabled: true })]}
          warnings={[]}
          loading={false}
          error={null}
          connectingKey={null}
          showProxyToggle={false}
          brandAppName=""
          proxyLogo={null}
          onConnect={onConnect}
        />,
      );
    });
    const connect = container.querySelector<HTMLButtonElement>(
      '[data-testid="mcp-servers-card-connect"]',
    );
    expect(connect?.textContent).toBe('Sign in');
    expect(connect?.disabled).toBe(true);
    act(() => connect?.click());
    expect(onConnect).not.toHaveBeenCalled();
    act(() => root.unmount());
    container.remove();
  });

  it('draws plain rows in compact density, with status only when it needs the user', () => {
    const html = renderToStaticMarkup(
      <ActivityItemDensityContext.Provider value="compact">
        <McpServersSectionBody
          servers={[
            makeServer({
              key: 'fine',
              displayName: 'Linear',
              authStatus: 'unsupported',
              authStatusLabel: 'Agent provider',
              canConnect: false,
            }),
            makeServer({ key: 'needs', displayName: 'Slack' }),
          ]}
          warnings={[]}
          loading={false}
          error={null}
          connectingKey={null}
          showProxyToggle={false}
          brandAppName=""
          proxyLogo={null}
        />
      </ActivityItemDensityContext.Provider>,
    );
    const host = document.createElement('div');
    host.innerHTML = html;
    const list = host.querySelector('[data-testid="mcp-servers-card-list"]');
    expect(list?.className).not.toContain('border');
    const rows = host.querySelectorAll('[data-testid="mcp-servers-card-row"]');
    expect(rows).toHaveLength(2);
    expect(rows[0]?.className).toContain('min-h-7');
    // No pill for a routine state, and no repeated source line.
    expect(rows[0]?.textContent).toBe('Linear');
    const badge = rows[1]?.querySelector(
      '[data-testid="mcp-servers-card-badge"]',
    );
    expect(badge?.textContent).toBe('Sign-in needed');
    expect(badge?.className).toContain('fg-warning');
    expect(badge?.className).not.toContain('rounded-full');
  });
  it('renders native detail/settings links and keeps the surrounding row and badge passive', () => {
    const host = document.createElement('div');
    host.innerHTML = renderToStaticMarkup(
      <McpServersSectionBody
        servers={[makeServer()]}
        warnings={[]}
        loading={false}
        error={null}
        connectingKey={null}
        brandAppName=""
        proxyLogo={null}
        getRowNavigation={() => ({ kind: 'link', href: '/plugin/exact' })}
        getRowSettings={() => ({
          kind: 'link',
          href: '/settings/exact?config=work',
        })}
        onConnect={jest.fn()}
      />,
    );
    const name = host.querySelector<HTMLAnchorElement>(
      '[data-testid="mcp-servers-card-name"]',
    );
    expect(name?.tagName).toBe('A');
    expect(name?.getAttribute('href')).toBe('/plugin/exact');
    expect(name?.target).toBe('_blank');
    expect(name?.rel).toBe('noopener');
    expect(name?.getAttribute('aria-label')).toContain('opens in a new tab');
    const settings = host.querySelector<HTMLAnchorElement>(
      '[data-testid="mcp-servers-card-settings"]',
    );
    expect(settings?.getAttribute('href')).toBe('/settings/exact?config=work');
    const row = host.querySelector('[data-testid="mcp-servers-card-row"]');
    const badge = host.querySelector('[data-testid="mcp-servers-card-badge"]');
    expect(row?.getAttribute('role')).toBeNull();
    expect(row?.getAttribute('tabindex')).toBeNull();
    expect(badge?.getAttribute('tabindex')).toBeNull();
    expect(badge?.closest('button,a')).toBeNull();
    expect(
      host
        .querySelector('[data-testid="mcp-servers-card-connect"]')
        ?.getAttribute('aria-label'),
    ).toBe('Sign in to GitHub');
  });
});
