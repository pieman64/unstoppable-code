/**
 * @jest-environment jsdom
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { GraphIcon } from '@canopy/ui-shared/icons/AppIcons';
import { brandText } from '@/lib/brand';
import {
  getVisibleNavItems,
  SettingsNav,
  type SettingsSection,
} from '../SettingsNav';

const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(
  window,
  'platform',
);

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(window, 'platform', {
    configurable: true,
    value: platform,
  });
}

function restorePlatform(): void {
  if (originalPlatformDescriptor) {
    Object.defineProperty(window, 'platform', originalPlatformDescriptor);
  } else {
    Reflect.deleteProperty(window, 'platform');
  }
}

describe('getVisibleNavItems', () => {
  afterEach(() => {
    restorePlatform();
  });

  it('includes Dictation on macOS', () => {
    const keys = getVisibleNavItems('darwin').map((item) => item.key);
    expect(keys).toContain('dictation');
  });

  it('omits Dictation on Windows', () => {
    const keys = getVisibleNavItems('win32').map((item) => item.key);
    expect(keys).not.toContain('dictation');
  });

  it('omits Dictation on Linux', () => {
    const keys = getVisibleNavItems('linux').map((item) => item.key);
    expect(keys).not.toContain('dictation');
  });

  it('keeps every other section regardless of platform', () => {
    const requiredKeys: SettingsSection[] = [
      'canopy',
      'account',
      'privacy',
      'git',
      'chat',
      'instructions',
      'memory',
      'harnesses',
      'plugins',
      'app-advisor',
      'codex',
      'claude',
      'ollama',
      'mcp',
      'approvals',
      'display',
      'notifications',
      'shortcuts',
      'files',
      'browser',
      'terminal',
      'environment',
      'plan-detection',
      'applications',
      'performance',
      'code-graph',
      'experiments',
      'legal',
    ];
    for (const platform of ['darwin', 'win32', 'linux'] as const) {
      const keys = new Set(
        getVisibleNavItems(platform).map((item) => item.key),
      );
      for (const required of requiredKeys) {
        expect(keys.has(required)).toBe(true);
      }
    }
  });

  it('omits Claude when no Claude settings sections are available', () => {
    const keys = getVisibleNavItems('win32', false).map((item) => item.key);
    expect(keys).not.toContain('claude');
    expect(keys).toContain('codex');
    expect(keys).toContain('mcp');
  });

  it('includes Experiments regardless of feature flags', () => {
    const keys = getVisibleNavItems('darwin', true, false).map(
      (item) => item.key,
    );
    expect(keys).toContain('experiments');
  });

  it('omits Code Graph when the code graph feature is disabled', () => {
    for (const platform of ['darwin', 'win32', 'linux'] as const) {
      const keys = getVisibleNavItems(platform, true, false).map(
        (item) => item.key,
      );
      expect(keys).not.toContain('code-graph');
    }
  });

  it('omits Remote access unless it is available in this window', () => {
    expect(getVisibleNavItems('darwin').map((item) => item.key)).not.toContain(
      'remote-access',
    );
    const keys = getVisibleNavItems('darwin', true, true, false, true).map(
      (item) => item.key,
    );
    expect(
      keys.slice(keys.indexOf('privacy'), keys.indexOf('privacy') + 2),
    ).toEqual(['privacy', 'remote-access']);
  });

  it('lists Multi-account proxy directly under Accounts once available', () => {
    expect(getVisibleNavItems('darwin').map((item) => item.key)).not.toContain(
      'account-proxy',
    );
    const items = getVisibleNavItems('darwin', true, true, true);
    const keys = items.map((item) => item.key);
    expect(
      keys.slice(keys.indexOf('account'), keys.indexOf('account') + 2),
    ).toEqual(['account', 'account-proxy']);
    expect(items.find((item) => item.key === 'account-proxy')?.label).toBe(
      'Multi-account proxy',
    );
  });

  it('includes Privacy', () => {
    const keys = getVisibleNavItems('darwin').map((item) => item.key);
    expect(keys).toContain('privacy');
  });

  it('omits the legacy canopy-server section', () => {
    for (const platform of ['darwin', 'win32', 'linux'] as const) {
      const keys = new Set(
        getVisibleNavItems(platform).map((item) => item.key),
      );
      expect(keys.has('canopy-server' as never)).toBe(false);
    }
  });

  it('returns settings pages in the requested order on macOS', () => {
    expect(getVisibleNavItems('darwin').map((item) => item.key)).toEqual([
      'canopy',
      'account',
      'privacy',
      'display',
      'notifications',
      'chat',
      'instructions',
      'memory',
      'harnesses',
      'approvals',
      'app-advisor',
      'codex',
      'claude',
      'ollama',
      'git',
      'plugins',
      'mcp',
      'files',
      'browser',
      'terminal',
      'environment',
      'applications',
      'shortcuts',
      'dictation',
      'plan-detection',
      'performance',
      'code-graph',
      'experiments',
      'legal',
    ]);
  });

  it('preserves settings page order when Dictation is unavailable', () => {
    expect(getVisibleNavItems('win32').map((item) => item.key)).toEqual([
      'canopy',
      'account',
      'privacy',
      'display',
      'notifications',
      'chat',
      'instructions',
      'memory',
      'harnesses',
      'approvals',
      'app-advisor',
      'codex',
      'claude',
      'ollama',
      'git',
      'plugins',
      'mcp',
      'files',
      'browser',
      'terminal',
      'environment',
      'applications',
      'shortcuts',
      'plan-detection',
      'performance',
      'code-graph',
      'experiments',
      'legal',
    ]);
  });

  it('preserves settings page order when Claude is unavailable', () => {
    expect(getVisibleNavItems('win32', false).map((item) => item.key)).toEqual([
      'canopy',
      'account',
      'privacy',
      'display',
      'notifications',
      'chat',
      'instructions',
      'memory',
      'harnesses',
      'approvals',
      'app-advisor',
      'codex',
      'ollama',
      'git',
      'plugins',
      'mcp',
      'files',
      'browser',
      'terminal',
      'environment',
      'applications',
      'shortcuts',
      'plan-detection',
      'performance',
      'code-graph',
      'experiments',
      'legal',
    ]);
  });
});

describe('SettingsNav', () => {
  afterEach(() => {
    restorePlatform();
  });

  it('renders the Dictation entry on macOS', () => {
    setPlatform('darwin');
    const html = renderToStaticMarkup(
      <SettingsNav
        activeSection="canopy"
        onNavigate={() => undefined}
        onClose={() => undefined}
      />,
    );
    expect(html).toContain('data-testid="settings-nav-dictation"');
  });

  it('hides the Dictation entry on Windows', () => {
    setPlatform('win32');
    const html = renderToStaticMarkup(
      <SettingsNav
        activeSection="canopy"
        onNavigate={() => undefined}
        onClose={() => undefined}
      />,
    );
    expect(html).not.toContain('data-testid="settings-nav-dictation"');
  });

  it('renders the Privacy entry', () => {
    const html = renderToStaticMarkup(
      <SettingsNav
        activeSection="canopy"
        onNavigate={() => undefined}
        onClose={() => undefined}
      />,
    );
    expect(html).toContain('data-testid="settings-nav-privacy"');
  });

  it('exposes a dedicated App Advisor entry', () => {
    const html = renderToStaticMarkup(
      <SettingsNav
        activeSection="canopy"
        onNavigate={() => undefined}
        onClose={() => undefined}
      />,
    );
    expect(html).toContain('data-testid="settings-nav-app-advisor"');
    expect(html).toContain('Orchestrator');
  });

  it('places Accounts immediately after General', () => {
    const html = renderToStaticMarkup(
      <SettingsNav
        activeSection="canopy"
        onNavigate={() => undefined}
        onClose={() => undefined}
      />,
    );
    const generalIndex = html.indexOf('data-testid="settings-nav-canopy"');
    const accountIndex = html.indexOf('data-testid="settings-nav-account"');
    expect(generalIndex).toBeGreaterThan(-1);
    expect(accountIndex).toBeGreaterThan(generalIndex);
    expect(html).toContain('General');
    expect(html).toContain('Accounts');

    const slice = html.slice(generalIndex + 1, accountIndex);
    expect(slice).not.toContain('data-testid="settings-nav-');
  });

  it('uses a 14px app icon for General', () => {
    const html = renderToStaticMarkup(
      <SettingsNav
        activeSection="canopy"
        onNavigate={() => undefined}
        onClose={() => undefined}
      />,
    );
    const generalIndex = html.indexOf('data-testid="settings-nav-canopy"');
    const accountIndex = html.indexOf('data-testid="settings-nav-account"');
    expect(generalIndex).toBeGreaterThan(-1);
    expect(accountIndex).toBeGreaterThan(generalIndex);

    const generalItemHtml = html.slice(generalIndex, accountIndex);
    expect(generalItemHtml).toContain('data-app-icon="true"');
    expect(generalItemHtml).toContain('width:14px');
    expect(generalItemHtml).toContain('height:14px');
  });

  it('uses secondary foreground for Back', () => {
    const html = renderToStaticMarkup(
      <SettingsNav
        activeSection="canopy"
        onNavigate={() => undefined}
        onClose={() => undefined}
      />,
    );

    expect(html).toMatch(/data-testid="settings-nav-back"[^>]*fg-secondary/);
  });

  it('keeps Back outside the scrolling settings list', () => {
    const html = renderToStaticMarkup(
      <SettingsNav
        activeSection="canopy"
        onNavigate={() => undefined}
        onClose={() => undefined}
      />,
    );
    const backIndex = html.indexOf('data-testid="settings-nav-back"');
    const scrollingListIndex = html.indexOf(
      'data-testid="settings-nav-scroll-container"',
    );

    expect(backIndex).toBeGreaterThan(-1);
    expect(scrollingListIndex).toBeGreaterThan(backIndex);
  });

  it('uses compact app glyphs and preserves provider mark sizes in settings navigation', () => {
    setPlatform('darwin');
    const html = renderToStaticMarkup(
      <SettingsNav
        activeSection="canopy"
        onNavigate={() => undefined}
        onClose={() => undefined}
      />,
    );
    const visibleKeys = getVisibleNavItems('darwin', true).map(
      (item) => item.key,
    );
    expect(
      html.slice(
        html.indexOf('data-testid="settings-nav-back"'),
        html.indexOf('data-testid="settings-nav-canopy"'),
      ),
    ).toContain('data-app-icon="true"');

    for (const key of visibleKeys) {
      const start = html.indexOf(`data-testid="settings-nav-${key}"`);
      const nextKey = visibleKeys[visibleKeys.indexOf(key) + 1];
      const end = nextKey
        ? html.indexOf(`data-testid="settings-nav-${nextKey}"`)
        : html.length;
      const itemHtml = html.slice(start, end);
      expect(itemHtml).toContain('data-app-icon="true"');
      const host = document.createElement('div');
      host.innerHTML = `<button ${itemHtml}`;
      const icon = host.querySelector('svg');
      expect(icon).not.toBeNull();
      const size =
        icon?.getAttribute('data-icon-family') === 'lucide' ? '14px' : '16px';
      expect(icon?.getAttribute('width')).toBe(size);
      expect(icon?.getAttribute('height')).toBe(size);
    }
  });

  it('places the Claude entry immediately after Codex', () => {
    const html = renderToStaticMarkup(
      <SettingsNav
        activeSection="canopy"
        onNavigate={() => undefined}
        onClose={() => undefined}
      />,
    );
    const codexIndex = html.indexOf('data-testid="settings-nav-codex"');
    const claudeIndex = html.indexOf('data-testid="settings-nav-claude"');
    expect(codexIndex).toBeGreaterThan(-1);
    expect(claudeIndex).toBeGreaterThan(codexIndex);

    const slice = html.slice(codexIndex + 1, claudeIndex);
    expect(slice).not.toContain('data-testid="settings-nav-');
  });

  it('places Models before App Advisor and Plugins', () => {
    const html = renderToStaticMarkup(
      <SettingsNav
        activeSection="canopy"
        onNavigate={() => undefined}
        onClose={() => undefined}
      />,
    );
    const chatIndex = html.indexOf('data-testid="settings-nav-chat"');
    const pluginsIndex = html.indexOf('data-testid="settings-nav-plugins"');
    const advisorIndex = html.indexOf('data-testid="settings-nav-app-advisor"');
    expect(chatIndex).toBeGreaterThan(-1);
    expect(advisorIndex).toBeGreaterThan(chatIndex);
    expect(pluginsIndex).toBeGreaterThan(advisorIndex);
    expect(html).toContain('Models');
    expect(html).not.toContain('>Chat</');
  });

  it('places Instructions immediately after Models in Agents', () => {
    const html = renderToStaticMarkup(
      <SettingsNav
        activeSection="canopy"
        onNavigate={() => undefined}
        onClose={() => undefined}
      />,
    );
    const modelsIndex = html.indexOf('data-testid="settings-nav-chat"');
    const instructionsIndex = html.indexOf(
      'data-testid="settings-nav-instructions"',
    );
    expect(modelsIndex).toBeGreaterThan(-1);
    expect(instructionsIndex).toBeGreaterThan(modelsIndex);
    expect(html.slice(modelsIndex + 1, instructionsIndex)).not.toContain(
      'data-testid="settings-nav-',
    );
    expect(html).toContain('Instructions');
  });

  it('renders five labeled groups with the prescribed spacing and type', () => {
    const html = renderToStaticMarkup(
      <SettingsNav
        activeSection="canopy"
        onNavigate={() => undefined}
        onClose={() => undefined}
      />,
    );
    const groupIds = [
      'settings-nav-group-personal',
      'settings-nav-group-agents',
      'settings-nav-group-integrations',
      'settings-nav-group-workflow',
      'settings-nav-group-advanced',
    ];

    for (const [index, groupId] of groupIds.entries()) {
      const groupIndex = html.indexOf(`data-testid="${groupId}"`);
      expect(groupIndex).toBeGreaterThan(-1);
      if (index > 0) {
        expect(groupIndex).toBeGreaterThan(
          html.indexOf(`data-testid="${groupIds[index - 1]}"`),
        );
      }
    }
    expect(html).toContain(
      'class="mt-3" data-testid="settings-nav-group-personal"',
    );
    expect(html).toContain('px-2 text-xs font-normal fg-tertiary"');
    expect(html).toContain('class="mt-1 flex flex-col gap-px"');
    expect(html).not.toContain('tracking-');
  });

  it('renders Remote access in Personal when it is available', () => {
    const html = renderToStaticMarkup(
      <SettingsNav
        activeSection="remote-access"
        onNavigate={() => undefined}
        onClose={() => undefined}
        remoteAccessEnabled
      />,
    );
    const personal = html.indexOf('data-testid="settings-nav-group-personal"');
    const agents = html.indexOf('data-testid="settings-nav-group-agents"');
    const entry = html.indexOf('data-testid="settings-nav-remote-access"');
    expect(entry).toBeGreaterThan(personal);
    expect(entry).toBeLessThan(agents);
    expect(html).toContain('Remote access');
  });

  it('hides Remote access when it is unavailable', () => {
    const html = renderToStaticMarkup(
      <SettingsNav
        activeSection="canopy"
        onNavigate={() => undefined}
        onClose={() => undefined}
      />,
    );
    expect(html).not.toContain('settings-nav-remote-access');
  });

  it('places Code Graph in Advanced with the code graph tool icon', () => {
    const html = renderToStaticMarkup(
      <SettingsNav
        activeSection="code-graph"
        onNavigate={() => undefined}
        onClose={() => undefined}
      />,
    );
    const advancedIndex = html.indexOf(
      'data-testid="settings-nav-group-advanced"',
    );
    const codeGraphIndex = html.indexOf(
      'data-testid="settings-nav-code-graph"',
    );
    expect(advancedIndex).toBeGreaterThan(-1);
    expect(codeGraphIndex).toBeGreaterThan(advancedIndex);
    expect(
      html.slice(
        codeGraphIndex,
        html.indexOf('data-testid="settings-nav-experiments"'),
      ),
    ).toContain(renderToStaticMarkup(<GraphIcon width={16} height={16} />));
    expect(html).toContain('Code Graph');
  });

  it('hides the Code Graph entry when the code graph feature is disabled', () => {
    const html = renderToStaticMarkup(
      <SettingsNav
        activeSection="canopy"
        onNavigate={() => undefined}
        onClose={() => undefined}
        codeGraphEnabled={false}
      />,
    );
    expect(html).not.toContain('data-testid="settings-nav-code-graph"');
    expect(html).toContain('data-testid="settings-nav-experiments"');
  });

  it('highlights the App Advisor entry when it is the active section', () => {
    const inactive = renderToStaticMarkup(
      <SettingsNav
        activeSection="canopy"
        onNavigate={() => undefined}
        onClose={() => undefined}
      />,
    );
    const active = renderToStaticMarkup(
      <SettingsNav
        activeSection="app-advisor"
        onNavigate={() => undefined}
        onClose={() => undefined}
      />,
    );
    expect(inactive).not.toMatch(
      /data-testid="settings-nav-app-advisor"[^>]*bg-muted/,
    );
    expect(active).toMatch(
      /data-testid="settings-nav-app-advisor"[^>]*bg-muted/,
    );
  });

  it('uses the main sidebar styling and supplied width', () => {
    setPlatform('darwin');
    const html = renderToStaticMarkup(
      <SettingsNav
        activeSection="canopy"
        onNavigate={() => undefined}
        onClose={() => undefined}
        width={372}
        onResize={() => undefined}
      />,
    );

    expect(html).toContain('class="settings-sidebar-content');
    // The shell is shared with web (`@canopy/ui-app/sidebar`); desktop keeps
    // its exact surface, content-layer, and drag-strip classes.
    expect(html).toContain(
      'class="app-sidebar-material sidebar-resizable-surface sidebar-instant-interactions relative h-full shrink-0 select-none font-normal"',
    );
    expect(html).toContain(
      'class="settings-sidebar-content absolute inset-0 flex flex-col"><div class="electron-drag h-10 shrink-0"></div>',
    );
    expect(html).toContain('app-sidebar-material');
    expect(html).toContain('select-none');
    expect(html).toContain('data-testid="settings-sidebar"');
    expect(html).toContain('data-sidebar-nav-row=""');
    expect(html).toContain('electron-no-drag shrink-0 px-2 pt-2');
    expect(html).toContain(
      'scrollbar-hide h-full overflow-y-auto settings-nav-scroll-mask electron-no-drag pb-2',
    );
    expect(html).toContain('class="px-2" data-sidebar-scroll-content=""');
    expect(html).toContain('data-sidebar-scrollbar=""');
    expect(html).toMatch(
      /class="[^"]*opacity-0[^"]*" data-sidebar-scrollbar=""/,
    );
    expect(html).not.toContain('settings-nav-scroll-fade');
    expect(html).toContain('style="width:372px"');
    expect(html).toContain('data-testid="settings-sidebar-resize-handle"');
    expect(html).toContain('sidebar-resizable-surface');
    expect(html).toContain('sidebar-resize-handle');
    expect(html).not.toContain('w-[0.5px]');
    expect(html).not.toContain('bg-accent');
    expect(html).not.toContain('sidebar-resizable-divider');
    expect(html).not.toContain('border-border');
    expect(html).not.toContain('font-medium');
  });

  it('places Legal as the final entry', () => {
    const html = renderToStaticMarkup(
      <SettingsNav
        activeSection="canopy"
        onNavigate={() => undefined}
        onClose={() => undefined}
      />,
    );
    const performanceIndex = html.indexOf(
      'data-testid="settings-nav-performance"',
    );
    const legalIndex = html.indexOf('data-testid="settings-nav-legal"');
    expect(performanceIndex).toBeGreaterThan(-1);
    expect(legalIndex).toBeGreaterThan(performanceIndex);
    expect(html).toContain('Legal');

    const afterLegal = html.slice(legalIndex + 1);
    expect(afterLegal).not.toContain('data-testid="settings-nav-');
  });
});

describe('SettingsNav Ollama platform-support gate', () => {
  function setOllamaSupported(supported: boolean): void {
    (globalThis as Record<string, unknown>).__CANOPY_OLLAMA_ENABLED__ =
      supported;
  }

  afterEach(() => {
    restorePlatform();
    // Restore the supported default the rest of the suite assumes.
    setOllamaSupported(true);
  });

  it('includes the Ollama nav item on macOS when supported', () => {
    setOllamaSupported(true);
    const keys = getVisibleNavItems('darwin').map((item) => item.key);
    expect(keys).toContain('ollama');
  });

  it('includes the Ollama nav item on Windows when supported', () => {
    // Windows is now a supported Ollama platform; the shared predicate keeps
    // the nav entry visible there.
    setOllamaSupported(true);
    const keys = getVisibleNavItems('win32').map((item) => item.key);
    expect(keys).toContain('ollama');
  });

  it('omits the Ollama nav item on every platform when unsupported', () => {
    setOllamaSupported(false);
    for (const platform of ['darwin', 'win32', 'linux'] as const) {
      const keys = getVisibleNavItems(platform).map((item) => item.key);
      expect(keys).not.toContain('ollama');
    }
  });

  it('renders the Ollama settings entry on Windows when supported', () => {
    setOllamaSupported(true);
    setPlatform('win32');
    const html = renderToStaticMarkup(
      <SettingsNav
        activeSection="canopy"
        onNavigate={() => undefined}
        onClose={() => undefined}
      />,
    );
    expect(html).toContain('data-testid="settings-nav-ollama"');
  });

  it('hides the Ollama settings entry from the rendered nav when unsupported', () => {
    setOllamaSupported(false);
    setPlatform('win32');
    const html = renderToStaticMarkup(
      <SettingsNav
        activeSection="canopy"
        onNavigate={() => undefined}
        onClose={() => undefined}
      />,
    );
    expect(html).not.toContain('data-testid="settings-nav-ollama"');
  });
});

describe('SettingsNav labels', () => {
  beforeEach(() => {
    setPlatform('darwin');
  });

  afterEach(() => {
    restorePlatform();
  });

  function renderNav(): HTMLDivElement {
    const container = document.createElement('div');
    container.innerHTML = renderToStaticMarkup(
      <SettingsNav
        activeSection="display"
        onNavigate={jest.fn<void, [SettingsSection]>()}
        onClose={jest.fn<void, []>()}
      />,
    );
    return container;
  }

  it('renders every nav item label from static copy', () => {
    const container = renderNav();
    const items = getVisibleNavItems('darwin', true);
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) {
      const row = container.querySelector(
        `[data-testid="settings-nav-${item.key}"]`,
      );
      expect(row?.textContent).toBe(item.label);
    }
    expect(
      container.querySelector('[data-testid="settings-nav-display"]')
        ?.textContent,
    ).toBe('Display');
  });

  it('labels each group heading', () => {
    const container = renderNav();
    const groups = [
      ['personal', 'Personal'],
      ['agents', 'Agents'],
      ['integrations', 'Integrations'],
      ['workflow', 'Workflow'],
      ['advanced', 'Advanced'],
    ] as const;
    for (const [id, label] of groups) {
      // The shared page nav gives each heading an instance-unique id, so the
      // heading is reached through the group it labels.
      const headingId = container
        .querySelector(`[data-testid="settings-nav-group-${id}"]`)
        ?.getAttribute('aria-labelledby');
      const heading = headingId
        ? container.querySelector(`[id="${headingId}"]`)
        : null;
      expect(heading?.textContent).toBe(label);
    }
  });
});

describe('SettingsNav hosted layout', () => {
  beforeEach(() => {
    setPlatform('darwin');
  });

  afterEach(() => {
    restorePlatform();
  });

  const HOSTED = { hostedLayout: true } as const;

  function renderHostedNav(
    renderHostedRail: Parameters<typeof SettingsNav>[0]['renderHostedRail'] = ({
      appGroup,
      trailingGroups,
    }) => (
      <>
        {appGroup}
        <div data-testid="hosted-account-slot" />
        <div data-testid="hosted-organizations-slot" />
        {trailingGroups}
      </>
    ),
    extra: Partial<Parameters<typeof SettingsNav>[0]> = {},
  ): HTMLDivElement {
    const container = document.createElement('div');
    container.innerHTML = renderToStaticMarkup(
      <SettingsNav
        activeSection="account"
        onNavigate={jest.fn()}
        onClose={jest.fn()}
        renderHostedRail={renderHostedRail}
        {...extra}
      />,
    );
    return container;
  }

  function headingOf(container: HTMLElement, id: string): string | null {
    const headingId = container
      .querySelector(`[data-testid="settings-nav-group-${id}"]`)
      ?.getAttribute('aria-labelledby');
    return headingId
      ? (container.querySelector(`[id="${headingId}"]`)?.textContent ?? null)
      : null;
  }

  it('orders the hosted groups App, Agents, Tools, Workflow, Advanced', () => {
    const container = renderHostedNav();
    const groups = Array.from(
      container.querySelectorAll<HTMLElement>(
        '[data-testid^="settings-nav-group-"], [data-testid$="-slot"]',
      ),
    ).map((element) => element.dataset.testid);
    expect(groups).toEqual([
      'settings-nav-group-personal',
      'hosted-account-slot',
      'hosted-organizations-slot',
      'settings-nav-group-agents',
      'settings-nav-group-integrations',
      'settings-nav-group-workflow',
      'settings-nav-group-advanced',
    ]);
    expect(
      ['personal', 'agents', 'integrations', 'workflow', 'advanced'].map((id) =>
        headingOf(container, id),
      ),
    ).toEqual([brandText.appName, 'Agents', 'Tools', 'Workflow', 'Advanced']);
  });

  it('puts General, Privacy, Remote access and Display in the app group', () => {
    const container = renderHostedNav(undefined, { remoteAccessEnabled: true });
    const rows = Array.from(
      container.querySelectorAll<HTMLElement>(
        '[data-testid="settings-nav-group-personal"] [data-sidebar-nav-row]',
      ),
    ).map((row) => row.dataset.testid);
    expect(rows).toEqual([
      'settings-nav-canopy',
      'settings-nav-privacy',
      'settings-nav-remote-access',
      'settings-nav-display',
    ]);
  });

  it('omits the local Notifications row', () => {
    const container = renderHostedNav();
    expect(
      container.querySelector('[data-testid="settings-nav-notifications"]'),
    ).toBeNull();
    expect(
      getVisibleNavItems('darwin', true, true, true, true, HOSTED).map(
        (item) => item.key,
      ),
    ).not.toContain('notifications');
  });

  it('labels the account row Providers and leads Agents with it', () => {
    const container = renderHostedNav();
    const agentRows = Array.from(
      container.querySelectorAll<HTMLElement>(
        '[data-testid="settings-nav-group-agents"] [data-sidebar-nav-row]',
      ),
    ).map((row) => row.dataset.testid);
    expect(agentRows[0]).toBe('settings-nav-account');
    expect(
      container.querySelector('[data-testid="settings-nav-account"]')
        ?.textContent,
    ).toBe('Providers');
    expect(
      getVisibleNavItems('darwin', true, true, false, false, HOSTED).find(
        (item) => item.key === 'account',
      )?.label,
    ).toBe('Providers');
  });

  it('lists Multi-account proxy after Providers only once available', () => {
    expect(
      getVisibleNavItems('darwin', true, true, false, false, HOSTED).map(
        (item) => item.key,
      ),
    ).not.toContain('account-proxy');
    expect(
      getVisibleNavItems('darwin', true, true, true, false, HOSTED)
        .map((item) => item.key)
        .slice(0, 6),
    ).toEqual([
      'canopy',
      'privacy',
      'display',
      'account',
      'account-proxy',
      'chat',
    ]);
  });

  it('keeps every legacy section except Notifications', () => {
    for (const platform of ['darwin', 'win32', 'linux'] as const) {
      const legacy = getVisibleNavItems(platform, true, true, true, true).map(
        (item) => item.key,
      );
      const hosted = getVisibleNavItems(
        platform,
        true,
        true,
        true,
        true,
        HOSTED,
      ).map((item) => item.key);
      expect(new Set(hosted)).toEqual(
        new Set(legacy.filter((key) => key !== 'notifications')),
      );
      expect(hosted).toHaveLength(legacy.length - 1);
    }
  });

  it('keeps the legacy labels without the hosted layout', () => {
    expect(
      getVisibleNavItems('darwin').find((item) => item.key === 'account')
        ?.label,
    ).toBe('Accounts');
  });

  it('selects no local row while a hosted page shows', () => {
    const container = renderHostedNav(undefined, { localSelected: false });
    expect(container.innerHTML).not.toMatch(
      /data-testid="settings-nav-account"[^>]*bg-muted/,
    );
  });

  it('renders the legacy rail unchanged without renderHostedRail', () => {
    const legacy = renderToStaticMarkup(
      <SettingsNav
        activeSection="canopy"
        onNavigate={() => undefined}
        onClose={() => undefined}
      />,
    );
    expect(legacy).toContain('data-testid="settings-nav-notifications"');
    expect(legacy).toContain('>Accounts<');
    expect(legacy).not.toContain('Providers');
  });
});
