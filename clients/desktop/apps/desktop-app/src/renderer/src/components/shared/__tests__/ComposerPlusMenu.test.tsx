/**
 * @jest-environment jsdom
 */
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

import { act, createRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { PluginsIcon } from '@canopy/ui-shared/icons/AppIcons';
import { useNavigationStore } from '@/stores/navigationStore';

interface LinearMockState {
  available: boolean;
  tokenPresent: boolean;
  tokenLoaded: boolean;
  status: { authenticated: boolean } | null;
}
let linearMock: LinearMockState = {
  available: false,
  tokenPresent: false,
  tokenLoaded: true,
  status: null,
};
let linearAvailabilityReads = 0;
jest.mock('@/hooks/useLinearStatus', () => ({
  useLinearStatus: (): { authenticated: boolean } | null => linearMock.status,
  useLinearAvailability: (): LinearMockState => {
    linearAvailabilityReads += 1;
    return linearMock;
  },
}));

const plugin = {
  name: 'linear',
  displayName: 'Linear',
  description: 'Manage issues',
  marketplaceId: 'test-marketplace',
  providerSupport: { claude: 'native', codex: 'native' },
  logoUrl: 'https://example.com/linear.png',
};
const codexOnlyPlugin = {
  name: 'figma',
  displayName: 'Figma',
  description: 'Codex-only Figma workflows',
  marketplaceId: 'test-marketplace',
  providerSupport: { claude: 'none', codex: 'native' },
};
const uninstalledPlugin = {
  name: 'remote-tool',
  displayName: 'Remote tool',
  description: 'Hosted externally, not installed yet',
  marketplaceId: 'test-marketplace',
  providerSupport: { claude: 'native', codex: 'native' },
  externalSource: { url: 'https://example.com/remote-tool.git' },
  details: null,
  facets: {},
};
jest.mock('@/hooks/useMarketplaceList', () => ({
  useMarketplaceList: (): object => ({
    cache: {
      marketplaces: [
        {
          id: 'test-marketplace',
          plugins: [plugin, codexOnlyPlugin, uninstalledPlugin],
        },
      ],
    },
  }),
}));
jest.mock('@/lib/remote-image', () => ({
  useSafeRemoteImageUrl: (): string => 'data:image/png;base64,aA==',
}));

import { POSTHOG_REPLAY_BLOCK_CLASS } from '@canopy/desktop-instrumentation/posthog-replay-privacy';
import { ComposerPlusMenu } from '../ComposerPlusMenu';

describe('ComposerPlusMenu additional actions', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    linearAvailabilityReads = 0;
    linearMock = {
      available: false,
      tokenPresent: false,
      tokenLoaded: true,
      status: null,
    };
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        loadLinearToken: jest.fn(() => Promise.resolve('')),
      },
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  it('has file and command actions without attachment or Linear callbacks', async () => {
    const onSelectFile = jest.fn();
    linearMock = {
      available: true,
      tokenPresent: true,
      tokenLoaded: true,
      status: { authenticated: true },
    };

    await act(async () => {
      root.render(
        <ComposerPlusMenu
          dataTestIdPrefix="config-composer"
          searchFiles={() => [
            {
              repoId: 'repo',
              repoName: 'Repo',
              relativePath: 'README.md',
              filename: 'README.md',
              absolutePath: '/repo/README.md',
            },
          ]}
          onSelectFile={onSelectFile}
          commands={[{ name: 'project-skill', description: 'Project skill' }]}
          includeCommandsInAddMenu
        />,
      );
      await Promise.resolve();
    });
    act(() =>
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="config-composer-plus-button"]',
        )
        ?.click(),
    );
    expect(linearAvailabilityReads).toBe(0);
    expect(
      document.querySelector('[data-testid="config-composer-plus-attachment"]'),
    ).toBeNull();
    expect(
      document.querySelector('[data-testid="config-composer-plus-linear"]'),
    ).toBeNull();
    expect(document.body.textContent).toContain('project-skill');
  });

  afterEach(() => {
    act(() => root.unmount());
    useNavigationStore.getState().closeSettings();
    delete document.body.dataset.rendererSurface;
    container.remove();
    document.body.replaceChildren();
  });

  it('blocks the menu rows from session replay while keeping group headings', async () => {
    await act(async () => {
      root.render(
        <ComposerPlusMenu
          dataTestIdPrefix="config-composer"
          commands={[{ name: 'project-skill', description: 'Project skill' }]}
          includeCommandsInAddMenu
        />,
      );
      await Promise.resolve();
    });
    act(() =>
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="config-composer-plus-button"]',
        )
        ?.click(),
    );
    const rows = Array.from(document.querySelectorAll('[data-action-row]'));
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.closest(`.${POSTHOG_REPLAY_BLOCK_CLASS}`)).not.toBeNull();
    }
    for (const group of Array.from(
      document.querySelectorAll('[role="group"]'),
    )) {
      expect(group.closest(`.${POSTHOG_REPLAY_BLOCK_CLASS}`)).toBeNull();
    }
  });

  it('separates contextual settings and shows their values and picker chevrons', async () => {
    await act(async () => {
      root.render(
        <ComposerPlusMenu
          onPickAttachment={() => undefined}
          onPickLinear={() => undefined}
          dataTestIdPrefix="test"
          additionalItems={[
            {
              id: 'model',
              label: 'Model',
              value: 'Opus 5',
              group: 'settings',
              opensMenu: true,
              icon: <span />,
              onSelect: jest.fn(),
              dataTestId: 'model',
            },
            {
              id: 'schedule',
              label: 'Schedule message',
              icon: <span />,
              onSelect: jest.fn(),
              dataTestId: 'schedule',
            },
          ]}
        />,
      );
      await Promise.resolve();
    });
    act(() =>
      container
        .querySelector<HTMLButtonElement>('[data-testid="test-plus-button"]')
        ?.click(),
    );
    const settings = document.querySelector(
      '[data-testid="test-plus-settings"]',
    );
    expect(
      settings?.querySelector('[data-testid="model"] [data-menu-value]')
        ?.textContent,
    ).toBe('Opus 5');
    expect(
      settings
        ?.querySelector('[data-testid="model"]')
        ?.getAttribute('aria-haspopup'),
    ).toBe('menu');
    expect(settings?.querySelector('[data-menu-chevron]')).not.toBeNull();
    expect(settings?.querySelector('[data-testid="schedule"]')).toBeNull();
    expect(
      document.querySelector(
        '[data-testid="test-plus-add"] [data-testid="schedule"]',
      ),
    ).not.toBeNull();
  });

  it('renders custom actions under the central plus trigger and closes after selection', async () => {
    const onOpenPlugins = jest.fn();

    await act(async () => {
      root.render(
        <ComposerPlusMenu
          onPickAttachment={() => undefined}
          onPickLinear={() => undefined}
          dataTestIdPrefix="test-composer"
          capsuleTrigger
          additionalItems={[
            {
              id: 'plugins',
              label: 'Plugins',
              icon: <PluginsIcon width={16} height={16} />,
              onSelect: onOpenPlugins,
              selected: true,
              ariaChecked: true,
              dataTestId: 'test-composer-plugins',
            },
          ]}
        />,
      );
      await Promise.resolve();
    });

    const trigger = container.querySelector<HTMLButtonElement>(
      '[data-testid="test-composer-plus-button"]',
    );
    expect(trigger?.getAttribute('aria-label')).toBe('More actions');
    expect(trigger?.className).toContain('h-8');
    expect(trigger?.className).toContain('rounded-full');
    // One capsule recipe in every composer: a flat subtle fill with an inset
    // hairline rim, stepping up to muted on hover, with no lift or shadow.
    const triggerClasses = trigger?.className.split(/\s+/) ?? [];
    expect(triggerClasses).toContain('bg-subtle');
    expect(triggerClasses).toContain('enabled:hover:bg-muted');
    expect(triggerClasses).toContain('ring-inset');
    expect(triggerClasses).not.toContain('shadow-sm');
    expect(triggerClasses).not.toContain('bg-tertiary');
    const plusIcon = trigger?.querySelector('[data-app-icon="true"]');
    expect(plusIcon).not.toBeNull();
    expect(plusIcon?.getAttribute('width')).toBe('14px');
    expect(plusIcon?.getAttribute('height')).toBe('14px');
    expect(plusIcon?.getAttribute('data-glyph')).toBe('plus');

    act(() => trigger?.click());
    expect(
      document.querySelector('[data-testid="test-composer-plus-menu"]'),
    ).not.toBeNull();
    expect(document.body.textContent).toContain('Files and folders');
    expect(document.body.textContent).toContain('Plugins');
    expect(
      document
        .querySelector('[data-testid="test-composer-plus-menu"]')
        ?.getAttribute('data-positioned'),
    ).toBe('true');
    expect(
      document.querySelector('[data-testid="test-composer-plus-menu"] input'),
    ).toBeNull();
    document
      .querySelectorAll<SVGElement>(
        '[data-testid="test-composer-plus-menu"] [data-app-icon="true"]',
      )
      .forEach((icon) => {
        expect(icon.parentElement?.className).toContain('[&>svg]:!h-4');
        expect(icon.parentElement?.className).toContain('[&>svg]:!w-4');
      });

    const plugins = document.querySelector<HTMLButtonElement>(
      '[data-testid="test-composer-plugins"]',
    );
    expect(plugins?.className).toContain('bg-subtle');
    expect(plugins?.tagName).toBe('BUTTON');
    expect(plugins?.getAttribute('aria-pressed')).toBe('true');
    act(() => plugins?.click());

    expect(onOpenPlugins).toHaveBeenCalledTimes(1);
    expect(
      document.querySelector('[data-testid="test-composer-plus-menu"]'),
    ).toBeNull();
  });

  it('uses the warning treatment when a collapsed action is active', async () => {
    await act(async () => {
      root.render(
        <ComposerPlusMenu
          onPickAttachment={() => undefined}
          onPickLinear={() => undefined}
          dataTestIdPrefix="test-composer"
          capsuleTrigger
          active
          activeLabel="Plan mode active"
        />,
      );
      await Promise.resolve();
    });

    const trigger = container.querySelector<HTMLButtonElement>(
      '[data-testid="test-composer-plus-button"]',
    );
    expect(trigger?.getAttribute('data-active')).toBe('true');
    expect(trigger?.getAttribute('aria-label')).toBe(
      'More actions, Plan mode active',
    );
    expect(trigger?.className).toContain('bg-warning-subtle');
    expect(trigger?.className).toContain('fg-warning');
    expect(trigger?.className.split(/\s+/)).not.toContain('bg-subtle');
  });

  // CAN-2709: connecting Linear is an account-level integration, so it lives
  // in Account settings. The composer keeps only the per-message action of
  // attaching a ticket, and only once a connection exists.
  it('omits the Linear row entirely when Linear is not connected', async () => {
    await act(async () => {
      root.render(
        <ComposerPlusMenu
          onPickAttachment={() => undefined}
          onPickLinear={() => undefined}
          dataTestIdPrefix="test-composer"
        />,
      );
      await Promise.resolve();
    });

    act(() => {
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="test-composer-plus-button"]',
        )
        ?.click();
    });

    const menu = document.querySelector(
      '[data-testid="test-composer-plus-menu"]',
    );
    expect(menu).not.toBeNull();
    expect(
      document.querySelector('[data-testid="test-composer-plus-linear"]'),
    ).toBeNull();
    expect(menu?.textContent).not.toContain('Linear');
    expect(menu?.textContent).toContain('Files and folders');
    expect(useNavigationStore.getState().settingsOpen).toBe(false);
  });

  it('keeps the Linear ticket picker once a connection exists', async () => {
    linearMock = {
      available: true,
      tokenPresent: true,
      tokenLoaded: true,
      status: { authenticated: true },
    };
    const onPickLinear = jest.fn();

    await act(async () => {
      root.render(
        <ComposerPlusMenu
          onPickAttachment={() => undefined}
          onPickLinear={onPickLinear}
          dataTestIdPrefix="test-composer"
        />,
      );
      await Promise.resolve();
    });

    act(() => {
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="test-composer-plus-button"]',
        )
        ?.click();
    });

    const linearRow = document.querySelector<HTMLButtonElement>(
      '[data-testid="test-composer-plus-linear"]',
    );
    expect(linearRow?.textContent).toContain('Linear');
    expect(linearRow?.textContent).not.toContain('Connect');

    act(() => linearRow?.click());
    expect(onPickLinear).toHaveBeenCalledTimes(1);
  });

  // CAN-2706: the `+` said nothing on hover, so its contents could only be
  // discovered by clicking. The copy names the menu's purpose rather than
  // listing what is in it, because the contents are under review (CAN-2710).
  it('describes the menu on hover through the shared tooltip', async () => {
    await act(async () => {
      root.render(
        <ComposerPlusMenu
          onPickAttachment={() => undefined}
          onPickLinear={() => undefined}
          dataTestIdPrefix="test-composer"
          capsuleTrigger
        />,
      );
      await Promise.resolve();
    });

    const trigger = container.querySelector<HTMLButtonElement>(
      '[data-testid="test-composer-plus-button"]',
    );
    if (!trigger) throw new Error('plus trigger not rendered');

    // React synthesizes `onMouseEnter` from a bubbling native `mouseover`;
    // jsdom does not synthesize `mouseenter`.
    act(() => {
      trigger.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    });

    const tooltip = document.querySelector('[role="tooltip"]');
    expect(tooltip?.textContent).toBe('More actions');
    expect(trigger.getAttribute('aria-describedby')).toBe(tooltip?.id);

    // The tooltip must stand down while the menu it describes is open.
    act(() => trigger.click());
    expect(document.querySelector('[role="tooltip"]')).toBeNull();
  });

  // CAN-2709 regression guard: `available` needs a SUCCESSFUL round-trip to
  // Linear, and `useLinearStatus` caches a failed validation for the rest of
  // the session. Keying the row's presence on it would let one offline moment
  // hide Linear until restart — and with the connect entry point gone, nothing
  // would point at it. Presence follows the stored token instead.
  it('keeps a stored connection visible, disabled, when validation has failed', async () => {
    linearMock = {
      available: false,
      tokenPresent: true,
      tokenLoaded: true,
      status: { authenticated: false },
    };

    await act(async () => {
      root.render(
        <ComposerPlusMenu
          onPickAttachment={() => undefined}
          onPickLinear={() => undefined}
          dataTestIdPrefix="test-composer"
        />,
      );
      await Promise.resolve();
    });

    act(() => {
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="test-composer-plus-button"]',
        )
        ?.click();
    });

    const linearRow = document.querySelector<HTMLButtonElement>(
      '[data-testid="test-composer-plus-linear"]',
    );
    expect(linearRow).not.toBeNull();
    expect(linearRow?.disabled).toBe(true);
    expect(linearRow?.textContent).toContain('Linear');
    expect(linearRow?.textContent).not.toContain('Connect');

    act(() => {
      linearRow?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    });
    expect(document.body.textContent).toContain('Check your Linear API key');
  });

  it('explains itself while a stored connection is still being validated', async () => {
    linearMock = {
      available: false,
      tokenPresent: true,
      tokenLoaded: true,
      status: null,
    };

    await act(async () => {
      root.render(
        <ComposerPlusMenu
          onPickAttachment={() => undefined}
          onPickLinear={() => undefined}
          dataTestIdPrefix="test-composer"
        />,
      );
      await Promise.resolve();
    });

    act(() => {
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="test-composer-plus-button"]',
        )
        ?.click();
    });

    const linearRow = document.querySelector<HTMLButtonElement>(
      '[data-testid="test-composer-plus-linear"]',
    );
    expect(linearRow?.disabled).toBe(true);

    act(() => {
      linearRow?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    });
    expect(document.body.textContent).toContain(
      'Checking your Linear connection',
    );
  });

  // The App Advisor window has no Account tab in its own settings modal, so
  // "Settings → Account" is not a reachable instruction there. The removed
  // `Connect Linear` row used to carry this surface check; the disabled
  // ticket-picker row inherits it.
  it('points App Advisor at the main window instead of a tab it does not have', async () => {
    document.body.dataset.rendererSurface = 'app-advisor';
    linearMock = {
      available: false,
      tokenPresent: true,
      tokenLoaded: true,
      status: { authenticated: false },
    };

    await act(async () => {
      root.render(
        <ComposerPlusMenu
          onPickAttachment={() => undefined}
          onPickLinear={() => undefined}
          dataTestIdPrefix="test-composer"
        />,
      );
      await Promise.resolve();
    });

    act(() => {
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="test-composer-plus-button"]',
        )
        ?.click();
    });

    const linearRow = document.querySelector<HTMLButtonElement>(
      '[data-testid="test-composer-plus-linear"]',
    );
    act(() => {
      linearRow?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    });

    expect(document.body.textContent).toContain(
      'Update it in Account settings in the main window.',
    );
    expect(document.body.textContent).not.toContain('Settings → Account');
  });
  it('includes discovered and available members in the Home Add menu', async () => {
    const onSelectCommand = jest.fn();
    await act(async () => {
      root.render(
        <ComposerPlusMenu
          onPickAttachment={jest.fn()}
          onPickLinear={jest.fn()}
          onSelectCommand={onSelectCommand}
          dataTestIdPrefix="home"
          includeCommandsInAddMenu
          commands={[
            { name: 'project-review', description: 'Review this project' },
            { name: 'enabled-review', description: 'Enabled skill' },
            {
              name: 'available-review',
              description: 'Enable this skill',
              section: 'available',
            },
            {
              name: 'model',
              description: 'Choose model',
              composerAction: 'model',
            },
          ]}
        />,
      );
      await Promise.resolve();
    });
    act(() =>
      container
        .querySelector<HTMLButtonElement>('[data-testid="home-plus-button"]')
        ?.click(),
    );
    for (const name of [
      'project-review',
      'enabled-review',
      'available-review',
    ]) {
      expect(
        document.querySelector(`[data-testid="home-capability-${name}"]`),
      ).not.toBeNull();
    }
    expect(
      document.querySelector('[data-testid="home-capability-model"]'),
    ).toBeNull();
    act(() =>
      document
        .querySelector<HTMLButtonElement>(
          '[data-testid="home-capability-available-review"]',
        )
        ?.click(),
    );
    expect(onSelectCommand).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'available-review' }),
    );
  });

  it('keeps capability members out of an editor-triggered @ menu', async () => {
    await act(async () => {
      root.render(
        <ComposerPlusMenu
          controller={{
            open: true,
            variant: 'add',
            origin: 'editor',
            query: 'review',
            activeId: null,
            setActiveId: jest.fn(),
            anchorRef: createRef(),
            editorRef: createRef(),
            menuRef: createRef(),
            setQuery: jest.fn(),
            onOpenChange: jest.fn(),
            consumeTrigger: jest.fn(),
            beginSelection: jest.fn(),
            handleKeyDown: () => false,
            prepareAction: jest.fn(),
            insertCommandText: jest.fn(),
            insertFile: jest.fn(),
          }}
          onPickAttachment={jest.fn()}
          onPickLinear={jest.fn()}
          dataTestIdPrefix="mention"
          includeCommandsInAddMenu
          commands={[
            { name: 'project-review', description: 'Review this project' },
          ]}
        />,
      );
      await Promise.resolve();
    });

    expect(
      document.querySelector(
        '[data-testid="mention-capability-project-review"]',
      ),
    ).toBeNull();
  });

  for (const variant of ['add', 'commands'] as const) {
    it(`shows only the ${variant} catalog`, async () => {
      const setQuery = jest.fn();
      const onOpenChange = jest.fn();
      await act(async () => {
        root.render(
          <ComposerPlusMenu
            controller={{
              open: true,
              variant,
              origin: variant === 'add' ? 'toolbar' : 'editor',
              query: '',
              activeId: null,
              setActiveId: jest.fn(),
              anchorRef: createRef(),
              editorRef: createRef(),
              menuRef: createRef(),
              setQuery,
              onOpenChange,
              consumeTrigger: jest.fn(),
              beginSelection: jest.fn(),
              handleKeyDown: () => false,
              prepareAction: jest.fn(),
              insertCommandText: jest.fn(),
              insertFile: jest.fn(),
            }}
            onPickAttachment={jest.fn()}
            onPickLinear={jest.fn()}
            dataTestIdPrefix="variant"
            searchFiles={() => [
              {
                filename: 'README.md',
                relativePath: 'README.md',
                absolutePath: '/repo/README.md',
                repoId: 'repo',
                repoName: 'repo',
              },
            ]}
            onSelectPlugin={jest.fn()}
            commands={[
              {
                name: 'model',
                composerAction: 'model',
                description: 'Choose model',
              },
              {
                name: 'attach',
                composerAction: 'attach',
                description: 'Attach a file',
              },
              {
                name: 'plugins',
                composerAction: 'plugins',
                description: 'Choose plugins',
              },
              {
                name: 'help',
                composerAction: 'help',
                description: 'Browse commands',
              },
              { name: 'model', description: 'Provider model command' },
              { name: 'review', description: 'Review changes' },
              {
                name: 'linear',
                browseNamespace: 'linear',
                description: 'Browse plugin',
              },
            ]}
          />,
        );
        await Promise.resolve();
      });
      const has = (id: string): boolean =>
        !!document.querySelector(`[data-testid="variant-${id}"]`);
      expect(has('plus-attachment')).toBe(variant === 'add');
      if (variant === 'add') {
        // Tab completes suggestion rows only, never a picker action.
        const attachment = document.querySelector(
          '[data-testid="variant-plus-attachment"]',
        );
        expect(attachment?.getAttribute('aria-haspopup')).toBe('dialog');
        expect(attachment?.hasAttribute('data-completion-row')).toBe(false);
        for (const id of ['file-result', 'plugin-test-marketplace-linear'])
          expect(
            document
              .querySelector(`[data-testid="variant-${id}"]`)
              ?.hasAttribute('data-completion-row'),
          ).toBe(true);
      }
      expect(has('file-result')).toBe(variant === 'add');
      expect(has('plugin-test-marketplace-linear')).toBe(variant === 'add');
      expect(
        document.querySelectorAll('[data-testid="variant-capability-model"]'),
      ).toHaveLength(variant === 'commands' ? 1 : 0);
      expect(has('capability-review')).toBe(variant === 'commands');
      if (variant === 'commands') {
        expect(
          document
            .querySelector('[data-testid="variant-capability-review"]')
            ?.hasAttribute('data-completion-row'),
        ).toBe(true);
        for (const name of ['attach', 'plugins', 'model'])
          expect(
            document
              .querySelector(`[data-testid="variant-capability-${name}"]`)
              ?.hasAttribute('data-completion-row'),
          ).toBe(false);
      }
      if (variant === 'commands') {
        act(() =>
          document
            .querySelector<HTMLButtonElement>(
              '[data-testid="variant-capability-help"]',
            )
            ?.click(),
        );
        expect(setQuery).toHaveBeenCalledWith('');
        expect(onOpenChange).not.toHaveBeenCalled();
      }
    });
  }

  it('selects the whole plugin without inserting a command or opening a submenu', async () => {
    const onSelectPlugin = jest.fn();
    const onSelectCommand = jest.fn();
    await act(async () => {
      root.render(
        <ComposerPlusMenu
          onPickAttachment={jest.fn()}
          onPickLinear={jest.fn()}
          dataTestIdPrefix="test-composer"
          onSelectPlugin={onSelectPlugin}
          onSelectCommand={onSelectCommand}
        />,
      );
      await Promise.resolve();
    });
    act(() =>
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="test-composer-plus-button"]',
        )
        ?.click(),
    );
    const row = document.querySelector<HTMLButtonElement>(
      '[data-testid="test-composer-plugin-test-marketplace-linear"]',
    );
    expect(row?.textContent).toContain('Linear');
    expect(row?.querySelector('img')?.getAttribute('src')).toBe(
      'data:image/png;base64,aA==',
    );
    act(() => row?.click());
    expect(onSelectPlugin).toHaveBeenCalledWith(
      { marketplaceId: 'test-marketplace', pluginName: 'linear' },
      { label: 'Linear', enabled: false },
    );
    expect(onSelectCommand).not.toHaveBeenCalled();
    expect(
      document.querySelector('[data-testid="test-composer-plus-menu"]'),
    ).toBeNull();
  });
  it('lists only plugins that are installed in the app', async () => {
    await act(async () => {
      root.render(
        <ComposerPlusMenu
          onPickAttachment={jest.fn()}
          onPickLinear={jest.fn()}
          dataTestIdPrefix="installed"
          onSelectPlugin={jest.fn()}
        />,
      );
      await Promise.resolve();
    });
    act(() =>
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="installed-plus-button"]',
        )
        ?.click(),
    );
    expect(
      document.querySelector(
        '[data-testid="installed-plugin-test-marketplace-linear"]',
      ),
    ).not.toBeNull();
    // External plugins that still need installing cannot be enabled for a
    // chat from here, so they are not offered.
    expect(
      document.querySelector(
        '[data-testid="installed-plugin-test-marketplace-remote-tool"]',
      ),
    ).toBeNull();
  });
  it('hides plugin rows the selected provider cannot use instead of disabling them', async () => {
    for (const [scope, expectCodexOnlyRow] of [
      ['claude', false],
      ['ollama', false],
      ['codex', true],
      ['mixed', true],
    ] as const) {
      await act(async () => {
        root.render(
          <ComposerPlusMenu
            onPickAttachment={jest.fn()}
            onPickLinear={jest.fn()}
            dataTestIdPrefix="scoped"
            onSelectPlugin={jest.fn()}
            providerScope={scope}
          />,
        );
        await Promise.resolve();
      });
      act(() =>
        container
          .querySelector<HTMLButtonElement>(
            '[data-testid="scoped-plus-button"]',
          )
          ?.click(),
      );
      const menu = document.querySelector('[data-testid="scoped-plus-menu"]');
      expect(menu).not.toBeNull();
      expect(
        document.querySelector(
          '[data-testid="scoped-plugin-test-marketplace-linear"]',
        ),
      ).not.toBeNull();
      const codexOnlyRow = document.querySelector<HTMLButtonElement>(
        '[data-testid="scoped-plugin-test-marketplace-figma"]',
      );
      if (expectCodexOnlyRow) {
        expect(codexOnlyRow).not.toBeNull();
        expect(codexOnlyRow?.hasAttribute('disabled')).toBe(false);
      } else {
        expect(codexOnlyRow).toBeNull();
      }
      expect(menu?.textContent).not.toContain('Only available for');
      act(() =>
        container
          .querySelector<HTMLButtonElement>(
            '[data-testid="scoped-plus-button"]',
          )
          ?.click(),
      );
      await act(async () => {
        root.unmount();
        root = createRoot(container);
        await Promise.resolve();
      });
    }
  });
  it('mentions an enabled plugin again without re-enabling it and falls back when its logo fails', async () => {
    const onSelectPlugin = jest.fn();
    await act(async () => {
      root.render(
        <ComposerPlusMenu
          onPickAttachment={jest.fn()}
          onPickLinear={jest.fn()}
          dataTestIdPrefix="enabled"
          onSelectPlugin={onSelectPlugin}
          pluginSelections={{
            collectionIds: [],
            skillRefs: [],
            pluginRefs: [
              { marketplaceId: 'test-marketplace', pluginName: 'linear' },
            ],
          }}
        />,
      );
      await Promise.resolve();
    });
    act(() =>
      container
        .querySelector<HTMLButtonElement>('[data-testid="enabled-plus-button"]')
        ?.click(),
    );
    const row = document.querySelector<HTMLButtonElement>(
      '[data-testid="enabled-plugin-test-marketplace-linear"]',
    );
    expect(row?.getAttribute('aria-pressed')).toBe('true');
    expect(row?.textContent).toContain('Enabled');
    act(() => {
      row?.querySelector('img')?.dispatchEvent(new Event('error'));
    });
    expect(row?.querySelector('img')).toBeNull();
    expect(row?.querySelector('svg')).not.toBeNull();
    act(() => row?.click());
    expect(onSelectPlugin).toHaveBeenCalledWith(
      { marketplaceId: 'test-marketplace', pluginName: 'linear' },
      { label: 'Linear', enabled: true },
    );
  });
  it('uses the host Plan toggle state and icon for slash commands', async () => {
    const toggle = jest.fn();
    const select = jest.fn();
    await act(async () => {
      root.render(
        <ComposerPlusMenu
          onPickAttachment={jest.fn()}
          onPickLinear={jest.fn()}
          dataTestIdPrefix="plan"
          onSelectCommand={select}
          commands={[
            {
              name: 'plan',
              composerAction: 'plan',
              description: 'Toggle plan mode',
            },
          ]}
          additionalItems={[
            {
              id: 'plan-mode',
              label: 'Plan mode',
              description: 'Turn plan mode off',
              value: 'On',
              ariaChecked: true,
              icon: <span data-testid="host-plan-icon" />,
              onSelect: toggle,
            },
          ]}
          controller={{
            open: true,
            variant: 'commands',
            origin: 'editor',
            query: '',
            activeId: null,
            setActiveId: jest.fn(),
            editorRef: createRef(),
            menuRef: createRef(),
            setQuery: jest.fn(),
            onOpenChange: jest.fn(),
            consumeTrigger: jest.fn(),
            beginSelection: jest.fn(),
            handleKeyDown: () => false,
            prepareAction: jest.fn(),
            insertCommandText: jest.fn(),
            insertFile: jest.fn(),
          }}
        />,
      );
      await Promise.resolve();
    });
    const row = document.querySelector<HTMLButtonElement>(
      '[data-testid="plan-capability-plan"]',
    );
    expect(row?.getAttribute('aria-pressed')).toBe('true');
    expect(row?.textContent).toContain('Turn plan mode off');
    expect(row?.querySelector('[data-testid="host-plan-icon"]')).not.toBeNull();
    act(() => row?.click());
    expect(toggle).toHaveBeenCalledTimes(1);
    expect(select).not.toHaveBeenCalled();
  });
});
