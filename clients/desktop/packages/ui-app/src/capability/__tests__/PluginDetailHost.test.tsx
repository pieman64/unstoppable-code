/** @jest-environment jsdom */
import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { PluginDetails } from '@canopy/protocol/plugins';
import {
  DetailPageActions,
  useContributeDetailMoreItems,
  useDetailMoreItems,
} from '@canopy/ui-shared/components';
import {
  PluginDetailHost,
  type PluginDetailHostPlugin,
} from '../PluginDetailHost';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

const details: PluginDetails = {
  skills: [
    { name: 'Review', description: 'Reviews code', path: 'skills/review' },
  ],
  agents: [],
  commands: [],
  hooks: [],
  mcpServers: [],
  lspServers: [],
  hasReadme: false,
};

const plugin: PluginDetailHostPlugin = {
  name: 'reviewer',
  marketplaceId: 'marketplace',
  providerSupport: { claude: 'native', codex: 'compat' },
  facets: {
    claude: {
      provider: 'claude',
      mode: 'native',
      name: 'reviewer',
      installLocation: '/plugins/reviewer',
      sourcePath: '',
      details,
    },
    codexCompatibility: {
      provider: 'codex',
      mode: 'compat',
      name: 'reviewer',
      installLocation: '/plugins/reviewer',
      sourcePath: '',
      details,
    },
  },
  details,
};

describe('PluginDetailHost', () => {
  let container: HTMLElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function renderHost(
    overrides: Partial<Parameters<typeof PluginDetailHost>[0]> = {},
  ): void {
    act(() => {
      root.render(
        <PluginDetailHost
          plugin={plugin}
          onBack={(): void => undefined}
          loadDetail={(): Promise<PluginDetailHostPlugin> =>
            Promise.resolve(plugin)
          }
          readComponent={() =>
            Promise.resolve({ frontmatter: {}, body: 'loaded body' })
          }
          onInstall={(): Promise<PluginDetailHostPlugin> =>
            Promise.resolve(plugin)
          }
          {...overrides}
        />,
      );
    });
  }

  it('lets the host replace the install primary in full plugin details', () => {
    renderHost({
      needsInstall: true,
      ...{
        renderPrimaryAction: (): ReactElement => (
          <button data-testid="host-primary">Try it</button>
        ),
      },
    });
    expect(
      container.querySelector('[data-testid="host-primary"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-testid="plugin-detail-install"]'),
    ).toBeNull();
  });

  describe('CAN-3653 — also available from', () => {
    const codex = {
      entryId: 'mkt:openai-curated/slack',
      label: 'Codex official',
      ref: {
        type: 'marketplace-plugin' as const,
        marketplaceId: 'openai-curated',
        pluginName: 'slack',
      },
    };
    const curated = {
      entryId: 'curated:slack',
      label: 'the curated catalog',
      ref: { type: 'curated-plugin' as const, key: 'slack' },
    };

    it('links the same app from another catalog', () => {
      const onOpenEntryId = jest.fn<void, [string]>();
      renderHost({ alternatives: [codex], onOpenEntryId });
      const line = container.querySelector(
        '[data-testid="plugin-detail-also-available"]',
      );
      expect(line?.textContent).toBe('Also available from Codex official');
      const link = container.querySelector<HTMLButtonElement>(
        '[data-testid="plugin-detail-also-available-mkt:openai-curated/slack"]',
      );
      act(() => link?.click());
      expect(onOpenEntryId).toHaveBeenCalledWith('mkt:openai-curated/slack');
    });

    it('joins several alternatives', () => {
      renderHost({ alternatives: [codex, curated], onOpenEntryId: jest.fn() });
      expect(
        container.querySelector('[data-testid="plugin-detail-also-available"]')
          ?.textContent,
      ).toBe('Also available from Codex official, the curated catalog');
    });

    it('renders nothing without alternatives', () => {
      renderHost({ alternatives: [] });
      expect(
        container.querySelector('[data-testid="plugin-detail-also-available"]'),
      ).toBeNull();
    });
  });

  it('retains the nested desktop heading and allows a public-page h1', () => {
    renderHost();
    expect(container.querySelector('h2#plugin-detail-title')).not.toBeNull();
    expect(container.querySelector('h1')).toBeNull();
    renderHost({ titleAs: 'h1', onInstall: undefined });
    expect(container.querySelector('h1#plugin-detail-title')).not.toBeNull();
    expect(container.querySelector('h2#plugin-detail-title')).toBeNull();
  });

  it('keeps harness rows and drops install controls for a read-only host', () => {
    renderHost({
      onInstall: undefined,
      needsInstall: true,
      plugin: { ...plugin, builtIn: true },
      harnessRows: [
        { id: 'claude', name: 'Claude', installation: 'Installed' },
      ],
    });
    expect(
      container.querySelector('[data-testid="plugin-harness-claude"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-testid="built-in-install-panel"]'),
    ).toBeNull();
    expect(container.textContent).not.toContain('Install Plugin');
    // Components stay listed: nothing here is waiting on an install.
    expect(container.textContent).toContain('Review');
  });

  it('forwards status, harness and shared slots and keeps a status More menu in the action bar', () => {
    renderHost({
      onInstall: undefined,
      statusContent: (
        <div data-testid="t-status">
          <DetailPageActions
            more={<button type="button" data-testid="t-more" />}
          />
        </div>
      ),
      harnessRows: [
        { id: 'claude', name: 'Claude', installation: 'Installed' },
      ],
      installContent: (
        <DetailPageActions
          primary={<button type="button" data-testid="t-primary" />}
        />
      ),
      sharedContent: <section data-testid="t-shared" />,
    });
    const bar = container.querySelector(
      '[data-testid="plugin-detail-chrome"] [data-testid="detail-action-bar"]',
    );
    expect(bar).not.toBeNull();
    for (const id of ['t-more', 't-primary']) {
      const nodes = container.querySelectorAll(`[data-testid="${id}"]`);
      expect(nodes).toHaveLength(1);
      expect(bar?.contains(nodes[0])).toBe(true);
    }
    // Neither declaration falls back to an inline bar in the body.
    expect(
      container.querySelectorAll('[data-testid="detail-action-bar"]'),
    ).toHaveLength(1);
    expect(container.querySelector('[data-testid="t-status"]')).not.toBeNull();
    expect(
      container.querySelector('[data-testid="plugin-harness-connections"]'),
    ).not.toBeNull();
    expect(container.querySelector('[data-testid="t-shared"]')).not.toBeNull();
  });

  describe('MCP server health (CAN-4842)', () => {
    const mcpPlugin: PluginDetailHostPlugin = {
      ...plugin,
      facets: undefined,
      details: {
        ...details,
        mcpServers: [
          { name: 'slack', type: 'http', url: 'https://slack.example/mcp' },
        ],
      },
    };
    const byTestId = (id: string): HTMLElement | null =>
      container.querySelector(`[data-testid="${id}"]`);

    it('renders the inline health and runs Test connection through the port', async () => {
      const run = jest.fn().mockResolvedValue({ success: true, message: 'ok' });
      const onTested = jest.fn();
      const resolve = jest.fn().mockReturnValue({
        kind: 'target',
        target: {
          targetKey: 'server-1',
          status: {
            connectionStatus: 'connected',
            reachability: 'reachable',
            lastCheckedAt: '2026-10-01T10:00:00.000Z',
            configs: [],
          },
          configs: [{ id: 'cfg', name: 'Default' }],
          testConnection: { available: true, run },
          onTested,
        },
      });
      renderHost({
        plugin: mcpPlugin,
        mcpServerHealth: { resolve, formatTimestamp: () => '2 min ago' },
      });
      expect(resolve).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'slack' }),
      );
      const row = container.querySelector('[data-mcp-member="slack"]');
      expect(
        row?.querySelector('[data-testid="mcp-health-badge"]'),
      ).not.toBeNull();
      // Each row's health group names its server.
      expect(byTestId('mcp-health-section')?.getAttribute('aria-label')).toBe(
        'Health for slack',
      );
      expect(byTestId('mcp-health-last-checked')?.textContent).toBe(
        'Last checked 2 min ago',
      );
      const test = byTestId('mcp-health-test');
      expect(test?.hasAttribute('disabled')).toBe(false);
      await act(async () => {
        test?.click();
        await Promise.resolve();
      });
      expect(run).toHaveBeenCalledWith('cfg');
      expect(onTested).toHaveBeenCalledTimes(1);
    });

    it('disables Test connection with the port reason', () => {
      renderHost({
        plugin: mcpPlugin,
        mcpServerHealth: {
          resolve: () => ({
            kind: 'target',
            target: {
              targetKey: 'server-1',
              configs: [{ id: 'cfg', name: 'Default' }],
              testConnection: { available: false, reason: 'Desktop offline.' },
            },
          }),
        },
      });
      expect(byTestId('mcp-health-test')?.hasAttribute('disabled')).toBe(true);
      expect(byTestId('mcp-health-test-reason')?.textContent).toBe(
        'Desktop offline.',
      );
    });

    it('reads Not configured yet, Loading… or the unavailable reason without a test', () => {
      renderHost({
        plugin: mcpPlugin,
        mcpServerHealth: { resolve: () => undefined },
      });
      expect(
        byTestId('plugin-detail-mcp-status-unavailable')?.textContent,
      ).toBe('Not configured yet');
      expect(byTestId('mcp-health-test')).toBeNull();
      expect(byTestId('mcp-health-badge')).toBeNull();

      renderHost({
        plugin: mcpPlugin,
        mcpServerHealth: { resolve: () => ({ kind: 'loading' }) },
      });
      expect(
        container.querySelector('[data-mcp-member="slack"]')?.textContent,
      ).toContain('Loading…');
      expect(byTestId('plugin-detail-mcp-status-unavailable')).toBeNull();

      renderHost({
        plugin: mcpPlugin,
        mcpServerHealth: {
          resolve: () => ({ kind: 'unavailable', reason: 'Not paired.' }),
        },
      });
      expect(
        byTestId('plugin-detail-mcp-status-unavailable')?.textContent,
      ).toBe('Not paired.');
      expect(byTestId('mcp-health-test')).toBeNull();
    });

    it('falls back to Not configured yet without a health port', () => {
      renderHost({ plugin: mcpPlugin });
      expect(
        byTestId('plugin-detail-mcp-status-unavailable')?.textContent,
      ).toBe('Not configured yet');
    });
  });

  it('still offers the built-in install panel when the host can install', () => {
    renderHost({ plugin: { ...plugin, builtIn: true } });
    expect(
      container.querySelector('[data-testid="built-in-install-panel"]'),
    ).not.toBeNull();
  });

  it('clears a compat toggle error when the plugin identity changes', async () => {
    const onToggleCodexCompat = jest
      .fn()
      .mockRejectedValue(new Error('toggle failed'));
    renderHost({ onToggleCodexCompat });
    await act(async () => {
      container
        .querySelector(
          '[data-testid="plugin-detail-codex-compat-disable-toggle"]',
        )
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });
    expect(container.textContent).toContain('toggle failed');

    renderHost({
      onToggleCodexCompat,
      plugin: { ...plugin, name: 'other-plugin' },
    });
    expect(container.textContent).not.toContain('toggle failed');
  });

  it('renders the share action as the labeled secondary button', () => {
    renderHost({ shareAction: { status: 'shareable', onShare: () => {} } });
    const shareButton = container.querySelector(
      '[data-testid="plugin-detail-share"]',
    );
    expect(shareButton?.getAttribute('aria-label')).toBe('Share Reviewer');
    expect(shareButton?.textContent).toBe('Share');
    expect(shareButton?.className).toContain('bg-quaternary');
    // The compact capsule, never the deprecated control rectangle.
    expect(shareButton?.className).toContain('rounded-full');
    expect(shareButton?.className).not.toContain('rounded-md');
    expect(shareButton?.className).toContain('h-7');
    expect(shareButton?.className).not.toContain('border-border');
  });

  it.each([
    ['needs install', { needsInstall: true }],
    ['curated', { plugin: { ...plugin, curated: true } }],
    [
      'external',
      { plugin: { ...plugin, externalSource: 'https://example.com/p.git' } },
    ],
  ] as const)(
    'puts one Share at the top right of the chrome, never in install actions (%s)',
    (_label, overrides) => {
      const onShare = jest.fn();
      renderHost({
        ...overrides,
        shareAction: { status: 'shareable', onShare },
      });
      const shares = container.querySelectorAll(
        '[data-testid="plugin-detail-share"]',
      );
      expect(shares).toHaveLength(1);
      const chrome = container.querySelector(
        '[data-testid="plugin-detail-chrome"]',
      );
      expect(chrome?.contains(shares[0])).toBe(true);
      expect(
        container
          .querySelector('[data-testid="built-in-install-panel"]')
          ?.contains(shares[0]) ?? false,
      ).toBe(false);
      act(() => {
        shares[0].dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });
      expect(onShare).toHaveBeenCalledTimes(1);
    },
  );

  describe('CAN-4842 — at most three header actions', () => {
    const external = {
      ...plugin,
      externalSource: 'https://example.com/plugin.git',
    };

    function chromeControls(): string[] {
      const bar = container.querySelector(
        '[data-testid="plugin-detail-chrome"] [data-testid="detail-action-bar"]',
      );
      return Array.from(bar?.querySelectorAll('button') ?? []).map(
        (button) => button.getAttribute('data-testid') ?? '',
      );
    }

    it('puts Update in the ⋯ More menu beside Share and the primary', async () => {
      const onInstall = jest.fn(
        (): Promise<PluginDetailHostPlugin> => Promise.resolve(external),
      );
      renderHost({
        plugin: external,
        onInstall,
        shareAction: { status: 'shareable', onShare: jest.fn() },
        idlePrimaryAction: <button data-testid="host-primary">Try it</button>,
      });
      expect(chromeControls()).toEqual([
        'plugin-detail-more',
        'plugin-detail-share',
        'host-primary',
      ]);
      expect(
        container.querySelector('[data-testid="plugin-detail-update"]'),
      ).toBeNull();
      act(() => {
        container
          .querySelector<HTMLButtonElement>(
            '[data-testid="plugin-detail-more"]',
          )
          ?.click();
      });
      const update = document.querySelector<HTMLElement>(
        '[data-testid="plugin-detail-menu"] [data-testid="plugin-detail-update"]',
      );
      expect(update?.textContent).toContain('Update');
      await act(async () => {
        update?.click();
        await Promise.resolve();
      });
      expect(onInstall).toHaveBeenCalledTimes(1);
    });

    it('shows an Update failure on the page, since the ⋯ menu closes on select', async () => {
      renderHost({
        plugin: external,
        onInstall: (): Promise<PluginDetailHostPlugin> =>
          Promise.reject(new Error('Could not fetch the plugin source.')),
      });
      act(() => {
        container
          .querySelector<HTMLButtonElement>(
            '[data-testid="plugin-detail-more"]',
          )
          ?.click();
      });
      await act(async () => {
        document
          .querySelector<HTMLElement>('[data-testid="plugin-detail-update"]')
          ?.click();
        await Promise.resolve();
        await Promise.resolve();
      });
      const error = container.querySelector(
        '[data-testid="plugin-detail-update-error"]',
      );
      expect(error?.getAttribute('role')).toBe('alert');
      expect(error?.textContent).toContain(
        'Could not fetch the plugin source.',
      );
    });

    it("adds Update to a body's ⋯ menu instead of drawing a second one", () => {
      function BodyMenu(): ReactElement {
        const hostItems = useDetailMoreItems();
        return (
          <span data-testid="body-more">
            {hostItems.map((item) => item.label).join(',')}
          </span>
        );
      }
      renderHost({
        plugin: external,
        statusContent: <DetailPageActions more={<BodyMenu />} />,
      });
      expect(
        container.querySelector('[data-testid="plugin-detail-more"]'),
      ).toBeNull();
      expect(
        container.querySelector('[data-testid="body-more"]')?.textContent,
      ).toBe('Update');
    });

    it('lists a row an install body offers in the same ⋯ menu', () => {
      const onReinstall = jest.fn();
      function InstallBody(): ReactElement {
        const inMenu = useContributeDetailMoreItems('reinstall', [
          {
            id: 'reinstall',
            label: 'Reinstall plugin',
            icon: null,
            testId: 'body-reinstall',
            onSelect: onReinstall,
          },
        ]);
        return <p data-testid="install-body">{inMenu ? 'in menu' : 'own'}</p>;
      }
      renderHost({ installContent: <InstallBody /> });
      expect(
        container.querySelector('[data-testid="install-body"]')?.textContent,
      ).toBe('in menu');
      act(() => {
        container
          .querySelector<HTMLButtonElement>(
            '[data-testid="plugin-detail-more"]',
          )
          ?.click();
      });
      const row = document.querySelector<HTMLElement>(
        '[data-testid="plugin-detail-menu"] [data-testid="body-reinstall"]',
      );
      expect(row?.textContent).toContain('Reinstall plugin');
      act(() => row?.click());
      expect(onReinstall).toHaveBeenCalledTimes(1);
    });

    it('draws no ⋯ when the plugin has no rarer actions', () => {
      renderHost({ shareAction: { status: 'shareable', onShare: jest.fn() } });
      expect(
        container.querySelector('[data-testid="plugin-detail-more"]'),
      ).toBeNull();
    });
  });

  it('shows a blocked Share with its reason and never invokes it', () => {
    const reason = 'This plugin has no public source to share.';
    renderHost({
      needsInstall: true,
      shareAction: { status: 'blocked', reason },
    });
    const share = container.querySelector(
      '[data-testid="plugin-detail-share"]',
    );
    expect(share?.getAttribute('aria-disabled')).toBe('true');
    expect(share?.getAttribute('aria-description')).toBe(reason);
    expect(share?.hasAttribute('disabled')).toBe(false);
  });

  it.each(['curated', 'external'])(
    'keeps exactly one parent Share when opening a %s plugin member skill',
    async (source) => {
      const onShare = jest.fn();
      renderHost({
        plugin: {
          ...plugin,
          ...(source === 'curated'
            ? { curated: true }
            : { externalSource: 'https://example.com/plugin.git' }),
        },
        shareAction: { status: 'shareable', onShare },
      });
      await act(async () => {
        container.querySelector<HTMLButtonElement>('tbody button')?.click();
        await Promise.resolve();
      });
      expect(container.textContent).toContain('loaded body');
      const shares = container.querySelectorAll(
        '[data-testid="plugin-detail-share"]',
      );
      expect(shares).toHaveLength(1);
      expect(
        container
          .querySelector('[data-testid="plugin-detail-chrome"]')
          ?.contains(shares[0]),
      ).toBe(true);
      act(() => {
        shares[0]?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });
      expect(onShare).toHaveBeenCalledTimes(1);
      act(() =>
        container
          .querySelector<HTMLButtonElement>(
            '[data-testid="plugin-detail-back"]',
          )
          ?.click(),
      );
      // Back on the overview, Share stays in the same top-right spot.
      const overviewShares = container.querySelectorAll(
        '[data-testid="plugin-detail-share"]',
      );
      expect(overviewShares).toHaveLength(1);
      expect(
        container
          .querySelector('[data-testid="plugin-detail-chrome"]')
          ?.contains(overviewShares[0]),
      ).toBe(true);
    },
  );

  it('hides optional actions when callbacks are absent', () => {
    renderHost();
    expect(
      container.querySelector(
        '[data-testid="plugin-detail-codex-compat-disable-toggle"]',
      ),
    ).toBeNull();
    expect(
      container.querySelector('[data-testid="plugin-detail-share"]'),
    ).toBeNull();
  });

  it('does not render empty section wrappers for a README-only plugin with no install actions', () => {
    renderHost({
      plugin: {
        ...plugin,
        providerSupport: { claude: 'native', codex: 'none' },
        facets: undefined,
        details: { ...details, skills: [], hasReadme: true },
      },
      readme: { body: 'README content' },
    });

    const content = container.querySelector(
      '[data-testid="plugin-detail-host"] > div',
    );
    const emptySectionWrappers = Array.from(content?.children ?? []).filter(
      (child) =>
        child.tagName === 'DIV' &&
        child.classList.contains('flex-col') &&
        child.classList.contains('gap-6') &&
        child.childElementCount === 0,
    );

    expect(container.textContent).toContain('README content');
    expect(emptySectionWrappers).toHaveLength(0);
  });

  it('renders and invokes optional actions when callbacks are present', async () => {
    const onToggleCodexCompat = jest.fn().mockResolvedValue(plugin);
    const onShare = jest.fn();
    renderHost({
      shareAction: { status: 'shareable', onShare },
      onToggleCodexCompat,
    });
    expect(
      container.querySelector(
        '[data-testid="plugin-detail-codex-compat-disable-toggle"]',
      ),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-testid="plugin-detail-share"]'),
    ).not.toBeNull();
    expect(
      container
        .querySelector('[data-testid="plugin-detail-chrome"]')
        ?.contains(
          container.querySelector('[data-testid="plugin-detail-share"]'),
        ),
    ).toBe(true);
    expect(
      container.querySelector<HTMLButtonElement>(
        '[data-testid="plugin-detail-codex-compat-disable-toggle"]',
      )?.disabled,
    ).toBe(false);
    await act(async () => {
      container
        .querySelector(
          '[data-testid="plugin-detail-codex-compat-disable-toggle"]',
        )
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });
    expect(onToggleCodexCompat).toHaveBeenCalledWith(true);
    act(() => {
      container
        .querySelector('[data-testid="plugin-detail-share"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onShare).toHaveBeenCalledTimes(1);
  });

  it('renders explicit host loading, error/retry, and truncation states', () => {
    const loadDetail = jest.fn().mockResolvedValue(plugin);
    renderHost({ loading: true, loadDetail });
    expect(
      container.querySelector('[data-testid="plugin-detail-loading"]'),
    ).not.toBeNull();
    // CAN-2694: the host title humanizes a slug-only plugin name.
    expect(container.querySelector('#plugin-detail-title')?.textContent).toBe(
      'Reviewer',
    );

    renderHost({ error: 'Detail unavailable', loadDetail });
    // CAN-2694: the host title humanizes a slug-only plugin name.
    expect(container.querySelector('#plugin-detail-title')?.textContent).toBe(
      'Reviewer',
    );
    act(() => {
      container
        .querySelector('[data-testid="plugin-detail-retry"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(loadDetail).toHaveBeenCalledTimes(1);

    renderHost({ truncated: true, loadDetail });
    expect(
      container.querySelector('[data-testid="plugin-detail-truncated"]'),
    ).not.toBeNull();
  });

  it('resolves component content through the async host callback', async () => {
    const readComponent = jest.fn().mockResolvedValue({
      frontmatter: {},
      body: 'content from host',
    });
    renderHost({ readComponent });

    await act(async () => {
      container
        .querySelector('tbody button')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(readComponent).toHaveBeenCalledWith(
      'skill',
      'skills/review/SKILL.md',
      expect.anything(),
    );
    expect(container.textContent).toContain('content from host');
  });
});
