import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { DEFAULT_MOCK_BASE_URL, registerScenario } from './seeders/index.mjs';

const RELEASE_FLAVOR = process.env.CANOPY_RELEASE_FLAVOR ?? 'stable';

test('Codex defaults qualify Ultra fast against a catalog model and retain manual refresh', async () => {
  const scenarioKey = 'codex-default-speed-qualification';
  await registerScenario(DEFAULT_MOCK_BASE_URL, scenarioKey, {
    codexAccountModels: [
      {
        id: 'gpt-6-astra',
        model: 'gpt-6-astra',
        serviceTiers: [
          { id: 'priority', name: 'Fast' },
          { id: 'ultrafast', name: 'Ultra fast' },
        ],
      },
    ],
  });
  const { electronApp, userDataDir } = await launchCanopy({
    env: { CANOPY_MOCK_API_KEY: scenarioKey },
  });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await app.openSettings();
    await app.openSettingsSection('codex');
    const ultra = window.getByTestId('settings-codex-speed-default-ultrafast');
    await expect(ultra).toBeEnabled();
    await ultra.check();
    await expect
      .poll(() =>
        window.evaluate(
          async () =>
            (await window.api.loadPreferences()).providerModelConfigDefaults
              ?.codex?.speed,
        ),
      )
      .toBe('ultrafast');
    const refresh = window.getByTestId('settings-codex-speed-refresh');
    await expect(refresh).toHaveText('Check again');
    await refresh.click();
    await expect(refresh).toHaveText('Check again');
    await expect(ultra).toBeChecked();
    await app.closeSettings();
    await app.openSettings();
    await app.openSettingsSection('codex');
    await expect(ultra).toBeChecked();
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

/**
 * Spec 16 — settings-rendering.
 *
 * Folds the five thin settings-rendering tweaks (PRs 700/755/766/784/791) into a
 * single launch that cycles through the relevant settings sections. B0 baseline:
 * plain `launchCanopy()` with no seeding; no live agent is exercised.
 *
 * Selectors are taken verbatim from the settings components:
 *   - CodexTab.tsx / codexTabHelpers.ts
 *   - ClaudeTab.tsx
 *   - ChatTab.tsx (model-row label text)
 *   - SettingsNav.tsx (settings-nav-canopy icon)
 */
test('stable builds render the settings tweaks without targeted update selection', async () => {
  test.skip(
    RELEASE_FLAVOR !== 'stable',
    'Stable-build negative coverage runs in the default E2E lane.',
  );
  const { electronApp, userDataDir } = await launchCanopy();

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);

    await app.waitForShell();
    await app.openMainPage();
    await app.openSettings();

    // SettingsNav's General icon renders at the compact Lucide 14x14 size.
    const canopyNav = window.getByTestId('settings-nav-canopy');
    await expect(canopyNav).toBeVisible();
    const icon = canopyNav.locator('svg').first();
    await expect(icon).toBeVisible();
    const iconBox = await icon.boundingBox();
    expect(iconBox).not.toBeNull();
    expect(Math.round(iconBox.width)).toBe(14);
    expect(Math.round(iconBox.height)).toBe(14);

    await expect(
      window.getByTestId('settings-update-select-version'),
    ).toHaveCount(0);

    // --- 700: Codex default speed choices present + persist. -------------
    await app.openSettingsSection('codex');
    const fastModeToggle = window.getByTestId(
      'settings-codex-fast-mode-default',
    );
    await expect(fastModeToggle).toBeVisible();
    const fast = window.getByTestId('settings-codex-speed-default-fast');
    const regular = window.getByTestId('settings-codex-speed-default-standard');
    await fast.check();
    await expect(fast).toBeChecked();
    await regular.check();
    await expect(regular).toBeChecked();

    // 766 (Codex half): four-row multi-agent group including App Advisor.
    await expect(
      window.getByTestId('settings-codex-multi-agent-worktree-chats'),
    ).toBeVisible();
    await expect(
      window.getByTestId('settings-codex-multi-agent-standalone-chats'),
    ).toBeVisible();
    await expect(
      window.getByTestId('settings-codex-multi-agent-app-advisor'),
    ).toBeVisible();
    await expect(
      window.getByTestId('settings-codex-multi-agent-pipelines'),
    ).toBeVisible();

    // --- 755: Claude tab three interface-mode radio groups present. -------
    await app.openSettingsSection('claude');
    await expect(window.getByTestId('settings-tab-claude')).toBeVisible();
    for (const prefix of [
      'settings-claude-default-chat-mode',
      'settings-claude-default-standalone-chat-mode',
      'settings-claude-default-app-advisor-chat-mode',
    ]) {
      await expect(window.getByTestId(`${prefix}-canopy`)).toBeVisible();
      await expect(window.getByTestId(`${prefix}-claude-code`)).toBeVisible();
      await expect(window.getByTestId(`${prefix}-auto`)).toBeVisible();
    }

    // --- 766 (Chat half): relabeled model rows by visible text. -----------
    await app.openSettingsSection('chat');
    const chatTab = window.getByTestId('settings-tab-chat');
    await expect(chatTab).toBeVisible();
    for (const label of [
      'Chat title model',
      'Conversation handoff model',
      'Worktree activity summary model',
    ]) {
      await expect(chatTab.getByText(label, { exact: true })).toBeVisible();
    }
    await expect(
      chatTab.getByText('Summary generator plugins', { exact: true }),
    ).toBeVisible();

    // --- 791 (optional negative): the Codex model lists no longer offer
    // `gpt-5.3-codex`. The Chat tab renders per-provider model `<select>`s; no
    // option in any of them should expose the retired id.
    const retiredOption = chatTab.locator('option[value="gpt-5.3-codex"]');
    await expect(retiredOption).toHaveCount(0);

    await app.closeSettings();
    await app.expectMainPage();
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('internal builds select and confirm a targeted downgrade', async () => {
  test.skip(
    RELEASE_FLAVOR !== 'internal',
    'Targeted update selection requires the internal release-flavor build.',
  );
  const { electronApp, userDataDir } = await launchCanopy();

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await app.openMainPage();

    const updateApiPatched = await electronApp.evaluate(({ ipcMain }) => {
      const versions = [
        {
          tag: 'internal-124',
          version: '1.2.4-internal.124',
          releaseDate: '2026-07-02T00:00:00.000Z',
          relation: 'upgrade',
        },
        {
          tag: 'internal-122',
          version: '1.2.2-internal.122',
          releaseDate: '2026-06-30T00:00:00.000Z',
          relation: 'downgrade',
        },
      ];
      ipcMain.removeHandler('update:list-versions');
      ipcMain.handle('update:list-versions', (_event, request = {}) => {
        const query = String(request.query ?? '').toLowerCase();
        return {
          items: versions.filter(
            (item) =>
              item.tag.toLowerCase().includes(query) ||
              item.version.toLowerCase().includes(query),
          ),
          nextCursor: null,
        };
      });
      ipcMain.removeHandler('update:check-version');
      ipcMain.handle('update:check-version', (_event, request) => {
        globalThis.__canopyE2eTargetUpdateRequest = request;
      });
      return true;
    });
    expect(updateApiPatched).toBe(true);

    await app.openSettings();
    const selectVersionButton = window.getByTestId(
      'settings-update-select-version',
    );
    await expect(selectVersionButton).toBeVisible();
    await selectVersionButton.click();
    const picker = window.getByTestId('settings-update-version-picker-modal');
    await expect(picker).toBeVisible();
    const versionPickerLayer = await picker.evaluate((dialog) => {
      const overlay = dialog.parentElement;
      const settings = document.querySelector(
        '[data-testid="settings-overlay"]',
      );
      const zIndex = (element) => {
        const parsed = Number.parseInt(
          element ? getComputedStyle(element).zIndex : '',
          10,
        );
        return Number.isFinite(parsed) ? parsed : 0;
      };
      const box = dialog.getBoundingClientRect();
      const hit = document.elementFromPoint(
        box.left + box.width / 2,
        box.top + box.height / 2,
      );
      return {
        overlay: zIndex(overlay),
        settings: zIndex(settings),
        pickerOwnsHitTarget: hit !== null && dialog.contains(hit),
      };
    });
    expect(versionPickerLayer.overlay).toBeGreaterThanOrEqual(
      versionPickerLayer.settings,
    );
    expect(versionPickerLayer.pickerOwnsHitTarget).toBe(true);
    await expect(
      window.getByTestId('settings-update-version-search-input'),
    ).toBeVisible();
    await expect(
      window.getByTestId('settings-update-version-search'),
    ).toBeVisible();
    await expect(
      window.getByTestId('settings-update-version-list'),
    ).toBeVisible();
    await expect(
      window.getByTestId('settings-update-version-load-more'),
    ).toBeVisible();

    await window
      .getByTestId('settings-update-version-search-input')
      .fill('1.2.2');
    await window.getByTestId('settings-update-version-search').click();
    const downgradeOption = window.locator(
      '[data-testid="settings-update-version-option"][data-tag="internal-122"]',
    );
    await expect(downgradeOption).toBeVisible();
    await downgradeOption.click();
    await expect(
      window.getByTestId('settings-update-downgrade-modal'),
    ).toBeVisible();
    await expect(
      window.getByTestId('settings-update-downgrade-confirmation'),
    ).toContainText('1.2.2-internal.122');
    await window.getByTestId('settings-update-downgrade-cancel').click();
    await expect(
      window.getByTestId('settings-update-downgrade-modal'),
    ).toBeHidden();

    await downgradeOption.click();
    await window.getByTestId('settings-update-downgrade-proceed').click();
    await expect
      .poll(() =>
        electronApp.evaluate(
          () => globalThis.__canopyE2eTargetUpdateRequest?.tag,
        ),
      )
      .toBe('internal-122');
    await expect(picker).toBeHidden();
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('Escape closes Settings from an expanded disclosure button', async () => {
  const { electronApp, userDataDir } = await launchCanopy();
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await app.openSettings();
    await app.openSettingsSection('git');
    await window
      .getByRole('button', { name: 'Show rules', exact: true })
      .click();
    const disclosure = window.getByRole('button', {
      name: 'Hide rules',
      exact: true,
    });
    await expect(disclosure).toHaveAttribute('aria-expanded', 'true');
    await disclosure.focus();
    await disclosure.press('Escape');
    await expect(window.getByTestId('settings-overlay')).toBeHidden();
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
