/** @jest-environment jsdom */
import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { PluginDetails } from '@canopy/protocol/plugins';
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

  it('retains the nested desktop heading and allows a public-page h1', () => {
    renderHost();
    expect(container.querySelector('h2#plugin-detail-title')).not.toBeNull();
    expect(container.querySelector('h1')).toBeNull();
    renderHost({ titleAs: 'h1', onInstall: undefined });
    expect(container.querySelector('h1#plugin-detail-title')).not.toBeNull();
    expect(container.querySelector('h2#plugin-detail-title')).toBeNull();
  });

  it('keeps connection content and drops install controls for a read-only host', () => {
    renderHost({
      onInstall: undefined,
      needsInstall: true,
      plugin: { ...plugin, builtIn: true },
      connectionContent: <div data-testid="connection-content" />,
    });
    expect(
      container.querySelector('[data-testid="connection-content"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-testid="built-in-install-panel"]'),
    ).toBeNull();
    expect(container.textContent).not.toContain('Install Plugin');
    // Components stay listed: nothing here is waiting on an install.
    expect(container.textContent).toContain('Review');
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
    expect(shareButton?.className).toContain('rounded-md');
    expect(shareButton?.className).not.toContain('rounded-full');
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
