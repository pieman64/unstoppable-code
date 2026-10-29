import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import {
  seedWelcomeChecklist,
  setOnboardingRoleFromAssistant,
} from './seeders/seedWelcomeChecklist.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { toggleHomePlanMode } from './homeComposerMenu.mjs';

async function launchTools({
  advanced = false,
  authUrl,
  pendingEntry,
  pendingEntries = [],
  salesTools = false,
  pluginNames,
} = {}) {
  const userDataDir = seedWelcomeChecklist({
    pendingEntry: pendingEntry ?? (advanced ? undefined : 'github'),
    pendingEntries,
  });
  if (pendingEntry === 'agent-connections' || pendingEntry === 'plan-mode')
    seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  const launch = await launchCanopy({ userDataDir });
  await launch.electronApp.evaluate(
    ({ ipcMain }, { advanced, authUrl, salesTools, pluginNames }) => {
      const names = pluginNames ?? [
        'gmail',
        'google-calendar',
        'slack',
        'notion',
        'google-drive',
        'datadog',
        'bigquery',
        'snowflake',
        'vercel',
        ...(salesTools ? ['hubspot', 'klaviyo', 'ahrefs', 'salesforce'] : []),
      ];
      const plugins = names.map((name) => ({
        name,
        displayName: {
          gmail: 'Gmail',
          'google-calendar': 'Google Calendar',
          slack: 'Slack',
          notion: 'Notion',
          'google-drive': 'Google Drive',
          datadog: 'Datadog',
          bigquery: 'BigQuery',
          snowflake: 'Snowflake',
          vercel: 'Vercel',
          hubspot: 'HubSpot',
          klaviyo: 'Klaviyo',
          ahrefs: 'Ahrefs',
          salesforce: 'Salesforce',
        }[name],
        marketplaceId: 'openai-curated',
        sourcePath: name,
        providerSupport: { claude: 'none', codex: 'native' },
        facets: {},
      }));
      const replace = (channel, handler) => {
        ipcMain.removeHandler(channel);
        ipcMain.handle(channel, handler);
      };
      replace('plugins:loadCacheOnly', () => ({
        success: true,
        data: {
          version: 2,
          lastRefreshed: new Date().toISOString(),
          marketplaces: [
            {
              id: 'openai-curated',
              name: 'Bundled',
              plugins,
              pluginCount: plugins.length,
              providerStatus: {},
              validProviders: ['codex'],
            },
          ],
        },
      }));
      replace('mcp-servers:list-detected', () => ({
        servers: [],
        warnings: [],
      }));
      replace('mcp-servers:list-provider-connectors', () => [
        {
          provider: 'codex',
          connectors: plugins.map((plugin) => ({
            name: plugin.displayName,
            displayName: plugin.displayName,
            connected: advanced,
            status: advanced ? 'connected' : 'not_connected',
          })),
        },
      ]);
      replace('mcp-servers:list-curated', () => ({
        servers: ['Slack', 'Vercel'].map((name) => ({
          key: name.toLowerCase(),
          name,
          shortDescription: `Work with ${name}`,
          url: `https://example.invalid/${name.toLowerCase()}/mcp`,
          transport: 'http',
          categories: ['productivity'],
          popular: true,
          sortOrder: 0,
          updatedAt: '2026-09-01T00:00:00.000Z',
          providerConnector: { providers: ['codex'] },
        })),
      }));
      if (authUrl) {
        const notAuthenticated = {
          authenticated: false,
          accountLabel: null,
          detail: null,
          error: null,
        };
        replace('settings:claude-auth-status', () => notAuthenticated);
        replace('settings:codex-auth-status', () => notAuthenticated);
        replace('auth-terminal:start', (event, request) => {
          const sessionId = `onboarding-auth-${request.provider}`;
          setTimeout(() => {
            event.sender.send('auth-terminal:output', {
              sessionId,
              data: `Opening browser to sign in.\r\nIf the browser didn't open, visit: ${authUrl}\r\nPaste code here if prompted: `,
            });
          }, 0);
          return { sessionId };
        });
        replace('auth-terminal:write', () => undefined);
        replace('auth-terminal:resize', () => undefined);
        replace('auth-terminal:stop', () => undefined);
      }
    },
    { advanced, authUrl, salesTools, pluginNames },
  );
  const window = await launch.electronApp.firstWindow();
  await window.reload();
  const app = new CanopyAppDriver(window);
  await app.waitForShell();
  await window.getByTestId('sidebar-create-task').click();
  return { ...launch, window, app };
}

test('provider OAuth opens in a Browser panel to the right of the new-task chat', async () => {
  const authUrl =
    'https://claude.com/cai/oauth/authorize?response_type=code&client_id=onboarding-e2e';
  const launch = await launchTools({
    authUrl,
    pendingEntry: 'agent-connections',
  });
  try {
    const { window, app } = launch;
    await app.selectWorktree('demo-main', {
      expandDefaultActivityRail: false,
    });
    await expect(
      window.getByTestId('chat-onboarding-checklist-host'),
    ).toBeVisible();
    await window
      .getByTestId('home-onboarding-suggestion-connect-claude')
      .click();
    await expect(
      window.getByRole('dialog', { name: 'Sign in to Claude' }),
    ).toBeVisible();

    const browser = window.getByTestId('browser-panel-surface');
    await expect(browser).toBeVisible({ timeout: 20_000 });
    const browserUrl = window.getByTestId('browser-url-input');
    await expect(browserUrl).toHaveValue(/^https:\/\/claude\.(?:com|ai)\//);
    expect(decodeURIComponent(await browserUrl.inputValue())).toContain(
      '/oauth/authorize?response_type=code&client_id=onboarding-e2e',
    );
    const [chatBox, browserBox] = await Promise.all([
      window
        .locator('[data-testid="panel-content-chat"]:visible')
        .boundingBox(),
      browser.boundingBox(),
    ]);
    expect(chatBox).not.toBeNull();
    expect(browserBox).not.toBeNull();
    expect(browserBox.x).toBeGreaterThan(chatBox.x);

    await window
      .getByRole('dialog', { name: 'Sign in to Claude' })
      .getByRole('button', { name: 'Close' })
      .click();
    await expect(browser).toBeVisible();
  } finally {
    await closeCanopy(launch.electronApp, launch.userDataDir);
  }
});

test('Sales and Marketing show catalog-backed Salesforce after general tools', async () => {
  const launch = await launchTools({ salesTools: true });
  try {
    const { window } = launch;
    for (const role of ['sales', 'marketing']) {
      await setOnboardingRoleFromAssistant(launch.electronApp, role);
      const panel = window.getByTestId('home-onboarding-tool-recommendations');
      const salesforce = panel.getByTestId(
        'home-onboarding-tool-plugin:openai-curated/salesforce',
      );
      await expect(salesforce).toBeVisible();
      await expect(salesforce).toHaveCount(1);
      await expect(
        panel.getByTestId('home-onboarding-tool-github'),
      ).toHaveCount(0);
      await expect(
        panel.getByTestId('home-onboarding-tool-linear'),
      ).toHaveCount(0);
      const labels = await panel
        .getByRole('button')
        .evaluateAll((buttons) =>
          buttons.map((button) => button.getAttribute('aria-label')),
        );
      expect(labels.indexOf('Connect Salesforce')).toBeGreaterThan(
        labels.indexOf('Connect Slack'),
      );
      expect(labels).toEqual(
        expect.arrayContaining([
          'Connect HubSpot',
          'Connect Klaviyo',
          'Connect Ahrefs',
        ]),
      );
    }
  } finally {
    await closeCanopy(launch.electronApp, launch.userDataDir);
  }
});

test('tool tiles own their hover, Skip shares the heading, and the sidebar opens the marketplace', async () => {
  const launch = await launchTools();
  try {
    const { window, app } = launch;
    const panel = window.getByTestId('home-onboarding-tool-recommendations');
    await expect(panel).toBeVisible();
    for (const name of [
      'gmail',
      'google-calendar',
      'slack',
      'notion',
      'datadog',
    ])
      await expect(
        window.getByTestId(`home-onboarding-tool-plugin:universal:${name}`),
      ).toBeVisible();
    for (const name of ['bigquery', 'snowflake', 'vercel'])
      await expect(
        window.getByTestId(
          `home-onboarding-tool-plugin:openai-curated/${name}`,
        ),
      ).toBeVisible();
    const heading = window.getByRole('heading', {
      name: 'Connect your tools',
      exact: true,
    });
    const skip = window.getByTestId(
      'home-onboarding-suggestion-dismiss-github',
    );
    const [headingBox, skipBox] = await Promise.all([
      heading.boundingBox(),
      skip.boundingBox(),
    ]);
    expect(
      Math.abs(
        headingBox.y + headingBox.height / 2 - skipBox.y - skipBox.height / 2,
      ),
    ).toBeLessThan(2);
    // The heading's only way forward is the arrow, never a labeled Next.
    const card = window.getByTestId('home-onboarding-suggestion-github');
    await expect(card.locator('button', { hasText: 'Next' })).toHaveCount(0);
    await expect(skip).toHaveAttribute('data-checklist-dismiss', 'true');
    const tile = window.getByTestId(
      'home-onboarding-tool-plugin:universal:slack',
    );
    const color = (element) => getComputedStyle(element).backgroundColor;
    const tileBefore = await tile.evaluate(color);
    const panelBefore = await panel.evaluate(color);
    await tile.hover();
    await expect.poll(() => tile.evaluate(color)).not.toBe(tileBefore);
    expect(await panel.evaluate(color)).toBe(panelBefore);
    // The sidebar card is absent on Home; Pipelines keeps the CTA's
    // navigation to the marketplace observable.
    await app.openPipelinesPage();
    await expect(window.getByTestId('sidebar-onboarding-progress')).toHaveCount(
      0,
    );
    const sidebarTitle = window.getByTestId(
      'sidebar-onboarding-suggestion-title',
    );
    expect((await sidebarTitle.innerText()).length).toBeLessThanOrEqual(25);
    expect(
      await sidebarTitle.evaluate(
        (element) => element.scrollWidth <= element.clientWidth,
      ),
    ).toBe(true);
    await expect(sidebarTitle).not.toHaveCSS('text-overflow', 'ellipsis');
    await window.getByTestId('sidebar-onboarding-suggestion-cta').click();
    await expect(window.getByTestId('page-plugins')).toBeVisible();
  } finally {
    await closeCanopy(launch.electronApp, launch.userDataDir);
  }
});

test('See all follows the tool tiles and opens the marketplace without skipping', async () => {
  const launch = await launchTools();
  try {
    const { window } = launch;
    const panel = window.getByTestId('home-onboarding-tool-recommendations');
    const seeAll = panel.getByRole('button', { name: 'See all', exact: true });
    await expect(seeAll).toBeVisible();
    await expect(panel.locator(':scope > :last-child')).toHaveText('See all');
    await expect(seeAll).toHaveCSS('font-size', '13px');
    const originalBackground = await seeAll.evaluate(
      (element) => getComputedStyle(element).backgroundColor,
    );
    const originalColor = await seeAll.evaluate(
      (element) => getComputedStyle(element).color,
    );
    await seeAll.hover();
    await expect
      .poll(() => seeAll.evaluate((element) => getComputedStyle(element).color))
      .not.toBe(originalColor);
    expect(
      await seeAll.evaluate(
        (element) => getComputedStyle(element).backgroundColor,
      ),
    ).toBe(originalBackground);
    await seeAll.focus();
    await window.keyboard.press('Enter');
    await expect(window.getByTestId('page-plugins')).toBeVisible();
    await window.getByTestId('sidebar-create-task').click();
    await expect(panel).toBeVisible();
    await expect(seeAll).toBeVisible();
  } finally {
    await closeCanopy(launch.electronApp, launch.userDataDir);
  }
});

test('connected tool examples return to Connect your tools without advancing it', async () => {
  const launch = await launchTools({ advanced: true, pendingEntry: 'github' });
  try {
    const { window, app } = launch;
    await window
      .getByTestId('home-onboarding-tool-plugin:universal:google-calendar')
      .click();
    await expect(
      window.getByRole('heading', {
        name: 'Try the Google Calendar plugin',
        exact: true,
      }),
    ).toBeVisible();
    const back = window.getByTestId('home-onboarding-tool-prompts-back');
    await expect(back).toHaveAccessibleName('Back to suggested tools');
    const [backBox, logoBox] = await Promise.all([
      back.boundingBox(),
      window
        .getByTestId('home-onboarding-tool-prompts')
        .locator('button > span')
        .first()
        .boundingBox(),
    ]);
    expect(
      Math.abs(backBox.x + backBox.width / 2 - logoBox.x - logoBox.width / 2),
    ).toBeLessThan(1);
    await window
      .getByTestId('home-onboarding-tool-prompts')
      .locator('button')
      .first()
      .click();
    const editor = window
      .getByTestId('page-home')
      .getByTestId('home-composer-editor');
    await expect(editor).not.toBeEmpty();
    await expect(
      window.getByTestId('home-onboarding-tool-recommendations'),
    ).toBeVisible();
    await expect.poll(() => app.currentHomeChecklistEntry()).toBe('github');
    await editor.press('Enter');
    await expect(window.getByTestId('page-chat')).toBeVisible();
    await window.getByTestId('sidebar-create-task').click();
    await expect.poll(() => app.currentHomeChecklistEntry()).toBe('github');
    await expect(
      window.getByTestId('home-onboarding-tool-recommendations'),
    ).toBeVisible();
    // Connected tools relabel the forward arrow Next instead of adding a
    // labeled Next button beside the arrows.
    const card = window.getByTestId('home-onboarding-suggestion-github');
    const next = card.getByTestId('home-onboarding-tools-next');
    await expect(next).toHaveAttribute('aria-label', 'Next');
    await expect(next).not.toHaveClass(/bg-accent/);
    await expect(next.locator('svg')).toHaveCount(1);
    await expect(card.locator('button', { hasText: 'Next' })).toHaveCount(0);
  } finally {
    await closeCanopy(launch.electronApp, launch.userDataDir);
  }
});

test('all recommended tools connected advances both checklist surfaces', async () => {
  const launch = await launchTools({
    advanced: true,
    pendingEntry: 'github',
    pendingEntries: ['agent-connections'],
    salesTools: true,
  });
  try {
    const { window, app } = launch;
    await setOnboardingRoleFromAssistant(launch.electronApp, 'sales');
    await expect(
      window.getByTestId('home-onboarding-suggestion-github'),
    ).toHaveCount(0);
    await expect(
      window.getByTestId('home-onboarding-suggestion-agent-connections'),
    ).toBeVisible();
    // The sidebar card shows off Home.
    await app.openPluginsPage();
    await expect(
      window.getByTestId('sidebar-onboarding-checklist'),
    ).toHaveAttribute('data-entry-id', 'agent-connections');
  } finally {
    await closeCanopy(launch.electronApp, launch.userDataDir);
  }
});

test('nontechnical project example stays concise and injects the full planning request', async () => {
  const launch = await launchTools({ pendingEntry: 'plan-mode' });
  try {
    const { window, app } = launch;
    await setOnboardingRoleFromAssistant(launch.electronApp, 'student');
    const row = window.getByTestId('home-onboarding-suggestion-cta-prompt');
    await expect(row).toBeVisible();
    expect((await row.innerText()).length).toBeLessThanOrEqual(25);
    expect(
      await row.evaluate(
        (element) => element.scrollWidth <= element.clientWidth,
      ),
    ).toBe(true);
    await row.click();
    await expect(
      window.getByTestId('page-home').getByTestId('home-composer-editor'),
    ).toHaveText(
      'Help me plan a project I am working on. Ask me about the goal and constraints, then propose milestones, dependencies, and a practical first step.',
    );
    await expect(app.homeChecklistRow('plan-mode')).toBeVisible();
  } finally {
    await closeCanopy(launch.electronApp, launch.userDataDir);
  }
});

test('focus shortcut follows the earlier steps and the automation entry is absent', async () => {
  const launch = await launchCanopy({
    userDataDir: seedWelcomeChecklist({
      pendingEntries: ['focus-shortcut'],
    }),
  });
  try {
    const window = await launch.electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await window.getByTestId('sidebar-create-task').click();
    await expect
      .poll(() => app.currentHomeChecklistEntry())
      .toBe('focus-shortcut');
    await expect(
      window.getByTestId('home-onboarding-suggestion-automation'),
    ).toHaveCount(0);
    const focus = window.getByTestId(
      'home-onboarding-suggestion-focus-shortcut',
    );
    await expect(focus.getByRole('heading')).toHaveText(
      /^Global hotkey for the (?:Canopy|Unstoppable) app$/,
    );
    await expect(
      window.getByTestId(
        'home-onboarding-suggestion-cta-enable-focus-shortcut',
      ),
    ).toHaveText(
      /^Bring (?:Canopy|Unstoppable) to the front while using any other app$/,
    );
    await window
      .getByTestId('home-onboarding-suggestion-dismiss-focus-shortcut')
      .click();
    await expect(focus).toHaveCount(0);
    // The skip survives a reload.
    await window.reload();
    await app.waitForShell();
    await window.getByTestId('sidebar-create-task').click();
    await expect(
      window.getByTestId('home-composer-editor').locator('visible=true'),
    ).toBeVisible();
    await expect(
      window.getByTestId('home-onboarding-suggestion-automation'),
    ).toHaveCount(0);
    await expect(focus).toHaveCount(0);
    // The skip is saved, not just hidden by a checklist that hasn't loaded.
    await expect
      .poll(async () => {
        const prefs = await window.evaluate(() => window.api.loadPreferences());
        const entries = prefs.homeOnboardingSuggestions?.entries ?? {};
        return Boolean(entries['focus-shortcut']?.dismissedAt);
      })
      .toBe(true);
  } finally {
    await closeCanopy(launch.electronApp, launch.userDataDir);
  }
});

test('reset hides until new checklist progress, including after reopening Settings', async () => {
  const launch = await launchTools();
  try {
    const { window, app } = launch;
    await app.openSettings();
    await app.openSettingsSection('canopy');
    const reset = window.getByTestId('settings-canopy-restore-checklist');
    await expect(reset).toHaveText('Reset');
    // Reset is an ordinary Settings action, with the same geometry and
    // neutral outlined surface as the adjacent import action, not a pill.
    const reference = window.getByTestId(
      'settings-canopy-import-projects-open',
    );
    const appearance = (button) =>
      button.evaluate((element) => {
        const style = getComputedStyle(element);
        return Object.fromEntries(
          [
            'height',
            'borderRadius',
            'borderTopColor',
            'borderTopWidth',
            'backgroundColor',
            'color',
            'boxShadow',
            'fontSize',
            'fontWeight',
            'paddingTop',
            'paddingRight',
            'paddingBottom',
            'paddingLeft',
          ].map((property) => [property, style[property]]),
        );
      });
    await window.mouse.move(0, 0);
    expect(await appearance(reset)).toEqual(await appearance(reference));
    const settle = (button) =>
      button.evaluate(async (element) => {
        await Promise.all(
          element
            .getAnimations()
            .map((animation) => animation.finished.catch(() => undefined)),
        );
      });
    await reference.hover();
    await settle(reference);
    const hovered = await appearance(reference);
    await reset.hover();
    await settle(reset);
    expect(await appearance(reset)).toEqual(hovered);
    await reset.focus();
    await window.keyboard.press('Tab');
    await window.keyboard.press('Shift+Tab');
    expect(
      await reset.evaluate((element) => element.matches(':focus-visible')),
    ).toBe(true);
    await reset.click();
    await expect(reset).toHaveCount(0);
    await app.closeSettings();
    await app.openSettings();
    await app.openSettingsSection('canopy');
    await expect(reset).toHaveCount(0);
    await app.closeSettings();
    await app.advanceHomeChecklist();
    await app.openSettings();
    await app.openSettingsSection('canopy');
    await expect(reset).toBeVisible();
  } finally {
    await closeCanopy(launch.electronApp, launch.userDataDir);
  }
});

test('advanced examples have no checklist chrome and cover three connected tools', async () => {
  const launch = await launchTools({ advanced: true });
  try {
    const { window } = launch;
    const panel = window.getByTestId('home-onboarding-advanced-prompts');
    await expect(panel).toBeVisible();
    await expect(panel.locator(':scope > li')).toHaveCount(3);
    await expect(
      window.getByTestId('home-onboarding-checklist-progress'),
    ).toHaveCount(0);
    await expect(
      window.getByTestId('home-onboarding-suggestions').locator('h2'),
    ).toHaveCount(0);
    const firstIds = await panel
      .locator(':scope > li')
      .evaluateAll((rows) => rows.map((row) => row.dataset.testid));
    const toolForRow = (id) => id.replace(/:\d+$/, '');
    expect(new Set(firstIds.map(toolForRow)).size).toBe(3);
    await expect(panel.locator('[data-checklist-dismiss]')).toHaveCount(0);
    await expect(panel.locator('[data-checklist-navigation]')).toHaveCount(0);
    await expect(window.getByTestId('suggested-prompt-chips')).toHaveCount(0);
  } finally {
    await closeCanopy(launch.electronApp, launch.userDataDir);
  }
});

test('the plan teaching outline is portaled outside the composer and clears on selection', async () => {
  const launch = await launchTools({ pendingEntry: 'plan-mode' });
  try {
    const { window, app } = launch;
    // The sidebar card is absent on Home; its CTA returns there to teach.
    await app.openPluginsPage();
    await window.getByTestId('sidebar-onboarding-suggestion-cta').click();
    const outline = window.getByTestId('home-plan-mode-highlight');
    const home = window.getByTestId('page-home');
    // The outline teaches the + button, where Plan mode lives.
    const toggle = home.getByTestId('home-composer-plus-button');
    await expect(outline).toBeVisible();
    expect(
      await outline.evaluate(
        (element) => element.parentElement === document.body,
      ),
    ).toBe(true);
    const [outlineBox, toggleBox] = await Promise.all([
      outline.boundingBox(),
      toggle.boundingBox(),
    ]);
    expect(outlineBox.y).toBeLessThan(toggleBox.y);
    expect(outlineBox.y + outlineBox.height).toBeGreaterThan(
      toggleBox.y + toggleBox.height,
    );
    await toggleHomePlanMode(window, home);
    await expect(outline).toHaveCount(0);
    // Plan shows its tile beside +; + itself only lights for Pipeline.
    await expect(
      home.getByTestId('home-plan-mode-inline-button'),
    ).toHaveAttribute('aria-pressed', 'true');
    await expect(toggle).not.toHaveAttribute('data-active', 'true');
    // Choosing the mode is not completing the lesson: only a sent plan is.
    await expect(app.homeChecklistRow('plan-mode')).toBeVisible();
  } finally {
    await closeCanopy(launch.electronApp, launch.userDataDir);
  }
});

test('unconnected Slack and Vercel tiles open their matching setup modal without a detail-page detour', async () => {
  const launch = await launchTools();
  try {
    const { window } = launch;
    for (const [name, key] of [
      ['Slack', 'plugin:universal:slack'],
      ['Vercel', 'plugin:openai-curated/vercel'],
    ]) {
      await window.getByTestId(`home-onboarding-tool-${key}`).click();
      const dialog = window.getByRole('dialog', {
        name: `Connect ${name}`,
        exact: true,
      });
      await expect(dialog).toBeVisible();
      await expect(window.getByTestId('page-home')).toBeVisible();
      await dialog.getByRole('button', { name: 'Close', exact: true }).click();
      await expect(dialog).toHaveCount(0);
    }
  } finally {
    await closeCanopy(launch.electronApp, launch.userDataDir);
  }
});

for (const surface of ['Home', 'Settings']) {
  test(`provider OAuth from ${surface} opens the system browser when no chat panel owns it`, async () => {
    const authUrl =
      'https://claude.com/cai/oauth/authorize?response_type=code&client_id=fallback-e2e';
    const launch = await launchTools({
      authUrl,
      pendingEntry: 'agent-connections',
    });
    try {
      await launch.electronApp.evaluate(({ ipcMain }) => {
        globalThis.__providerExternalUrls = [];
        ipcMain.removeHandler('browser:open-external');
        ipcMain.handle('browser:open-external', (_event, request) => {
          globalThis.__providerExternalUrls.push(request.url);
        });
      });
      if (surface === 'Settings') {
        await launch.app.openSettings();
        await launch.app.openSettingsSection('account');
        await launch.window.getByTestId('auth-panel-claude-connect').click();
      } else {
        await launch.window
          .getByTestId('home-onboarding-suggestion-connect-claude')
          .click();
      }
      await expect(
        launch.window.getByTestId('auth-login-terminal'),
      ).toBeVisible();
      await expect
        .poll(() =>
          launch.electronApp.evaluate(() => globalThis.__providerExternalUrls),
        )
        .toEqual([authUrl]);
    } finally {
      await closeCanopy(launch.electronApp, launch.userDataDir);
    }
  });
}

test('the chat checklist hands plan mode to Home and completes after sending', async () => {
  const launch = await launchTools({ pendingEntry: 'plan-mode' });
  try {
    const { window, app } = launch;
    await app.selectWorktree('demo-main', { expandDefaultActivityRail: false });
    await expect(
      window.getByTestId('chat-onboarding-checklist-host'),
    ).toBeVisible();
    await window
      .getByTestId('home-onboarding-suggestion-cta-create-plan')
      .click();
    const home = window.getByTestId('page-home');
    await expect(home).toBeVisible();
    await toggleHomePlanMode(window, home);
    // Plan shows its tile beside +; + itself only lights for Pipeline.
    await expect(
      home.getByTestId('home-plan-mode-inline-button'),
    ).toHaveAttribute('aria-pressed', 'true');
    await expect(
      home.getByTestId('home-composer-plus-button'),
    ).not.toHaveAttribute('data-active', 'true');
    const editor = window.locator('[data-slate-editor="true"]:visible').first();
    await editor.fill('Plan a searchable activity history.');
    await home.getByTestId('home-branch-picker-button').click();
    await window.getByTestId('home-branch-picker-worktree-demo-main').click();
    await editor.press('Enter');
    await expect
      .poll(
        async () =>
          (await window.evaluate(() => window.api.loadPreferences()))
            .homeOnboardingSuggestions.entries['plan-mode']?.completedAt,
      )
      .toBeTruthy();
  } finally {
    await closeCanopy(launch.electronApp, launch.userDataDir);
  }
});

test('monochrome suggestion logos retain their contrasting background', async () => {
  const launch = await launchTools({
    advanced: true,
    pluginNames: ['notion', 'slack', 'vercel'],
  });
  try {
    const panel = launch.window.getByTestId('home-onboarding-advanced-prompts');
    await expect(panel).toBeVisible();
    const notion = panel.locator('li').filter({ hasText: 'Notion' });
    await expect(notion).toHaveCount(1);
    const logo = notion.getByTestId('home-onboarding-suggestion-plugin-logo');
    await expect(logo).toBeVisible();
    const svg = await logo.evaluate((img) =>
      atob(img.getAttribute('src').split(',')[1]),
    );
    expect(svg).toMatch(/<rect\b[^>]*\bwidth="24"[^>]*\bheight="24"/);
  } finally {
    await closeCanopy(launch.electronApp, launch.userDataDir);
  }
});
