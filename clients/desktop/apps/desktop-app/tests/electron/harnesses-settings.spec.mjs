import {
  selectModelOnHarness,
  selectModelOption,
} from './model-selection-fixture.mjs';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import {
  connectMockCloudAccount,
  registerScenario,
  clearScenario,
  DEFAULT_MOCK_BASE_URL,
} from './seeders/index.mjs';
import { launchOllamaDiscoveryFixture } from './fixtures/ollama-discovery.mjs';
import {
  closeEffortPanel,
  openEffortSlider,
  stepEffortAway,
} from './effortPanel.mjs';

/**
 * Settings → Harnesses (`HarnessesTab`): the two-column Claude/Codex board
 * that assigns configurable models to a harness.
 *
 * Managed (claude-managed/codex-managed) rows come from the bundled
 * package.json model catalog, so the shell, both columns, and managed locks
 * are asserted unconditionally. Configurable rows only exist when the AI
 * Gateway catalog (or a live Ollama install) contributes models. To make
 * those deterministic, this spec seeds the on-disk AI Gateway model catalog
 * cache (`<userDataDir>/.cache/model-catalog/ai-gateway-v1.json`) that the
 * main process hydrates at startup. The cache is only honored when its
 * `serverOrigin` matches the build-time cloud base URL — `pnpm run build:e2e`
 * defaults that to the shared mock server origin (see scripts/build-e2e.mjs).
 * If the local E2E build was produced with a different CANOPY_CLOUD_BASE_URL
 * the cache is ignored, so every configurable-row interaction is gated on the
 * seeded rows actually being present and skips with a message otherwise.
 */

// Build-time default cloud origin for E2E builds (scripts/build-e2e.mjs).
const MOCK_CLOUD_ORIGIN = 'http://127.0.0.1:4011';
// BRAND.web.apiNamespace for the default `canopy` brand.
const BRAND_API_NAMESPACE = 'desktop-app';
const MODEL_POLICY_CLOUD_API_KEY = 'csk_model_policy_e2e';

const GATEWAY_ALPHA = {
  id: 'e2e-harness-alpha',
  gatewayId: 'anthropic/e2e-harness-alpha',
  label: 'E2E Harness Alpha',
  family: 'anthropic',
  familyLabel: 'Anthropic',
  recommendedHarness: 'claude',
  contextWindow: 128_000,
  supportsPromptCaching: false,
  requiresLocalHarnessSupport: false,
  showMoreOnly: false,
  supportedThinkingLevels: ['low', 'medium', 'high'],
  toolSchemaProfile: 'standard',
};

const GATEWAY_BRAVO = {
  id: 'e2e-harness-bravo',
  gatewayId: 'openai/e2e-harness-bravo',
  label: 'E2E Harness Bravo',
  family: 'openai',
  familyLabel: 'OpenAI',
  recommendedHarness: 'codex',
  contextWindow: 200_000,
  supportsPromptCaching: false,
  requiresLocalHarnessSupport: false,
  showMoreOnly: false,
  supportedThinkingLevels: ['low', 'medium', 'high'],
  toolSchemaProfile: 'standard',
};

/**
 * Writes a fresh AI Gateway model catalog cache file. `fetchedAt: now` keeps
 * it inside the 15-minute TTL, so hydrate() applies it and start() skips the
 * network refresh entirely for the duration of the test.
 */
function seedAiGatewayModelCatalogCache(userDataDir) {
  const cacheDir = path.join(userDataDir, '.cache', 'model-catalog');
  mkdirSync(cacheDir, { recursive: true });
  writeFileSync(
    path.join(cacheDir, 'ai-gateway-v1.json'),
    `${JSON.stringify({
      cacheVersion: 8,
      serverOrigin: MOCK_CLOUD_ORIGIN,
      brandApiNamespace: BRAND_API_NAMESPACE,
      fetchedAt: new Date().toISOString(),
      catalog: { version: 8, models: [GATEWAY_ALPHA, GATEWAY_BRAVO] },
    })}\n`,
    'utf8',
  );
}

// The held first send's setup status from `TurnWorkHeader`.
const SETUP_STATUS =
  '[data-testid="turn-starting-status"][data-turn-header="setup"]';

function writeSlowGitShim(userDataDir) {
  const shimPath = path.join(userDataDir, 'git-slow-harness-shim.sh');
  writeFileSync(
    shimPath,
    '#!/bin/sh\ncase "$*" in *"worktree add"*) sleep 8;; esac\nexec /usr/bin/git "$@"\n',
  );
  chmodSync(shimPath, 0o755);
  return shimPath;
}

async function openHarnessesSettings(window, app) {
  await app.waitForShell({ timeout: 30_000 });
  await app.openSettings();
  await app.openSettingsSection('harnesses');
  await expect(window.getByTestId('harness-loading')).toHaveCount(0, {
    timeout: 30_000,
  });
  await expect(window.getByTestId('harness-column-claude')).toBeVisible();
  await expect(window.getByTestId('harness-column-codex')).toBeVisible();
}

function configurableRows(window) {
  return window.locator('[data-harness-row-kind="configurable"]');
}

// A Cursor turn runs at the effort the composer shows, so the fixture reports
// the advertised variant with that reasoning value (`off` is Cursor's `none`).
async function cursorReasoningShownOn(surface) {
  const level = await surface
    .getByTestId('home-thinking-level-button')
    .getAttribute('data-thinking-level');
  return level === 'off' ? 'none' : level;
}

test('Harnesses settings removes an organization-blocked model', async () => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-harnesses-policy-'),
  );
  seedAiGatewayModelCatalogCache(userDataDir);
  const { electronApp } = await launchCanopy({ userDataDir });

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await openHarnessesSettings(window, app);
    const tab = window.getByTestId('settings-tab-harnesses');
    await expect(tab).toContainText('GPT 5.6 Sol');

    await connectMockCloudAccount(window, MODEL_POLICY_CLOUD_API_KEY);

    await expect(tab).not.toContainText('GPT 5.6 Sol');
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

/**
 * Pointer-drags a harness row into the target column, asserting the drag
 * overlay and the target column's drop highlight mid-gesture. The pauses
 * between pointer events give dnd-kit's PointerSensor time to process the
 * activation distance and collision detection (see
 * customize-sidebar.spec.mjs for the same pattern).
 */
async function dragRowToColumn(window, rowLocator, targetColumn) {
  const rowBox = await rowLocator.boundingBox();
  const targetBox = await targetColumn.boundingBox();
  if (!rowBox || !targetBox) {
    throw new Error('Missing bounding box for harness drag');
  }
  const sourceX = rowBox.x + rowBox.width / 2;
  const sourceY = rowBox.y + rowBox.height / 2;
  const targetX = targetBox.x + targetBox.width / 2;
  const targetY = targetBox.y + Math.min(targetBox.height / 2, 200);

  await window.mouse.move(sourceX, sourceY);
  await window.mouse.down();
  await window.waitForTimeout(100);
  // Exceed the 6px activation distance before heading for the target.
  await window.mouse.move(sourceX + 12, sourceY, { steps: 4 });
  await window.waitForTimeout(100);
  await window.mouse.move(targetX, targetY, { steps: 20 });
  await window.waitForTimeout(150);
  await expect(window.getByTestId('harness-drag-overlay')).toBeVisible();
  await expect(targetColumn).toHaveAttribute('data-drop-highlight', 'true');
  await window.mouse.up();
}

test('Harnesses settings shows both columns, managed locks, and a horizontal scroller at narrow widths', async ({}, testInfo) => {
  test.setTimeout(120_000);

  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-harnesses-settings-'),
  );
  seedAiGatewayModelCatalogCache(userDataDir);
  const { electronApp } = await launchCanopy({ userDataDir });

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await openHarnessesSettings(window, app);

    const tab = window.getByTestId('settings-tab-harnesses');
    await expect(
      tab.getByRole('heading', { name: 'Default harness' }),
    ).toBeVisible();
    await expect(tab).toContainText(
      'Choose the default harness for each model.',
    );
    await expect(tab).toContainText('Only supported harnesses are available.');

    const claudeColumn = window.getByTestId('harness-column-claude');
    const codexColumn = window.getByTestId('harness-column-codex');

    // Managed locks: each native column carries at least one managed row in
    // its managed group. That group renders no visible heading — it can only
    // ever appear in its own native column, so the heading would just repeat
    // the column title — but keeps its accessible name. Managed rows expose no
    // actions menu (no button at all) and are not draggable (dnd-kit marks
    // draggables with aria-roledescription).
    for (const [harness, label] of [
      ['claude', 'Claude'],
      ['codex', 'Codex'],
    ]) {
      const managedGroup = window.getByTestId(
        `harness-group-${harness}-managed-${harness}`,
      );
      await expect(managedGroup).toBeVisible();
      await expect(managedGroup).toHaveAttribute('aria-label', label);
      await expect(
        window.getByTestId(`harness-group-label-${harness}-managed-${harness}`),
      ).toHaveCount(0);
    }

    // Managed rows lead their column: the first row in each column is managed.
    for (const column of [claudeColumn, codexColumn]) {
      await expect(
        column.locator('[data-harness-row-kind]').first(),
      ).toHaveAttribute('data-harness-row-kind', 'managed');
    }

    for (const column of [claudeColumn, codexColumn]) {
      const managedRows = column.locator('[data-harness-row-kind="managed"]');
      await expect(managedRows.first()).toBeVisible();
      const managedCount = await managedRows.count();
      for (let i = 0; i < managedCount; i += 1) {
        const row = managedRows.nth(i);
        await expect(row.locator('button')).toHaveCount(0);
        await expect(row).not.toHaveAttribute(
          'aria-roledescription',
          'draggable',
        );
      }
    }

    // Configurable rows (seeded AI Gateway catalog) are draggable and expose
    // the row actions menu. Only asserted when the seeded cache was honored.
    if ((await configurableRows(window).count()) > 0) {
      const alphaRow = window.getByTestId(`harness-row-${GATEWAY_ALPHA.id}`);
      await expect(alphaRow).toHaveAttribute(
        'aria-roledescription',
        'draggable',
      );
      await expect(
        window.getByTestId(`harness-row-menu-${GATEWAY_ALPHA.id}`),
      ).toHaveCount(1);
    }

    // The drop-highlight ring paints outside each column's border box, so the
    // scroll container must leave room for it on every edge. Without that
    // inset the ring is clipped at the scroller's top/left (start-edge
    // overflow is unreachable) and at its right (a box-shadow never extends
    // the scrollable width). Geometry is highlight-independent: the ring adds
    // no layout, so unhighlighted columns measure the same room.
    const ringRoom = await window.evaluate(() => {
      const scroller = document.querySelector(
        '[data-testid="harness-columns-scroller"]',
      );
      if (!scroller) return null;
      scroller.scrollLeft = 0;
      const clip = scroller.getBoundingClientRect();
      const roomFor = (testId) => {
        const column = document.querySelector(`[data-testid="${testId}"]`);
        if (!column) return null;
        const box = column.getBoundingClientRect();
        return {
          top: box.top - clip.top,
          left: box.left - clip.left,
          right: clip.right - box.right,
        };
      };
      return {
        overflows: scroller.scrollWidth > scroller.clientWidth + 1,
        claude: roomFor('harness-column-claude'),
        codex: roomFor('harness-column-codex'),
      };
    });
    expect(ringRoom).not.toBeNull();
    expect(ringRoom.claude).not.toBeNull();
    expect(ringRoom.codex).not.toBeNull();
    expect(ringRoom.claude.top).toBeGreaterThanOrEqual(1);
    expect(ringRoom.codex.top).toBeGreaterThanOrEqual(1);
    expect(ringRoom.claude.left).toBeGreaterThanOrEqual(1);
    // Horizontally scrolled content legitimately extends past the right clip
    // edge; the trailing inset is only measurable when it all fits.
    if (!ringRoom.overflows) {
      expect(ringRoom.codex.right).toBeGreaterThanOrEqual(1);
    }

    await window.screenshot({
      path: testInfo.outputPath('harnesses-settings-wide.png'),
    });

    // Narrow widths keep the columns side by side inside a horizontal
    // scroller instead of stacking them.
    await window.setViewportSize({ width: 700, height: 800 });
    await window.evaluate(() => {
      window.dispatchEvent(new Event('resize'));
    });

    await expect(claudeColumn).toBeVisible();
    const claudeBox = await claudeColumn.boundingBox();
    const codexBox = await codexColumn.boundingBox();
    expect(claudeBox).not.toBeNull();
    expect(codexBox).not.toBeNull();
    // Same y-band (side by side), Codex strictly to the right of Claude.
    expect(Math.abs(codexBox.y - claudeBox.y)).toBeLessThanOrEqual(8);
    expect(codexBox.x).toBeGreaterThanOrEqual(
      claudeBox.x + claudeBox.width - 1,
    );

    const scroller = window.getByTestId('harness-columns-scroller');
    const scrollState = await scroller.evaluate((element) => ({
      overflowX: getComputedStyle(element).overflowX,
      gridMinWidth: element.firstElementChild
        ? getComputedStyle(element.firstElementChild).minWidth
        : null,
      scrollWidth: element.scrollWidth,
      clientWidth: element.clientWidth,
    }));
    expect(scrollState.overflowX).toBe('auto');
    expect(scrollState.gridMinWidth).toBe('560px');
    if (scrollState.scrollWidth > scrollState.clientWidth) {
      const scrolledLeft = await scroller.evaluate((element) => {
        element.scrollLeft = element.scrollWidth;
        return element.scrollLeft;
      });
      expect(scrolledLeft).toBeGreaterThan(0);
    }

    await window.screenshot({
      path: testInfo.outputPath('harnesses-settings-narrow.png'),
    });
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('configurable models move via menu, drag, and keyboard, and persist across relaunch', async ({}, testInfo) => {
  test.setTimeout(240_000);

  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-harnesses-persist-'),
  );
  seedAiGatewayModelCatalogCache(userDataDir);

  let activeApp = await launchCanopy({ userDataDir });

  try {
    let window = await activeApp.electronApp.firstWindow();
    let app = new CanopyAppDriver(window);
    await openHarnessesSettings(window, app);

    const seededRowCount = await window
      .getByTestId(`harness-row-${GATEWAY_ALPHA.id}`)
      .count();
    test.skip(
      seededRowCount === 0,
      'No configurable (AI Gateway/Ollama) models in this environment — the seeded catalog cache was not honored (E2E build cloud origin differs?). Skipping move/drag/reset/persistence coverage.',
    );

    let claudeColumn = window.getByTestId('harness-column-claude');
    let codexColumn = window.getByTestId('harness-column-codex');
    const alphaId = GATEWAY_ALPHA.id;
    const bravoId = GATEWAY_BRAVO.id;

    // Both seeded rows start in their recommended columns.
    await expect(
      claudeColumn.getByTestId(`harness-row-${alphaId}`),
    ).toBeVisible();
    await expect(
      codexColumn.getByTestId(`harness-row-${bravoId}`),
    ).toBeVisible();

    // --- Menu move: Claude → Codex. No reset entry while at the default. ---
    const alphaRow = window.getByTestId(`harness-row-${alphaId}`);
    await alphaRow.hover();
    await window.getByTestId(`harness-row-menu-${alphaId}`).click();
    const moveItem = window.getByTestId('harness-menu-move');
    await expect(moveItem).toHaveText('Move to Codex');
    await expect(window.getByTestId('harness-menu-reset')).toHaveCount(0);
    await moveItem.click();
    await expect(
      codexColumn.getByTestId(`harness-row-${alphaId}`),
    ).toBeVisible();
    await expect(
      claudeColumn.getByTestId(`harness-row-${alphaId}`),
    ).toHaveCount(0);
    await expect(window.getByTestId('harness-save-error')).toHaveCount(0);

    await window.screenshot({
      path: testInfo.outputPath('harnesses-menu-move.png'),
    });

    // --- Reset appears once the row is off its recommendation. ---
    await alphaRow.hover();
    await window.getByTestId(`harness-row-menu-${alphaId}`).click();
    await expect(window.getByTestId('harness-menu-move')).toHaveText(
      'Move to Claude',
    );
    const resetItem = window.getByTestId('harness-menu-reset');
    await expect(resetItem).toHaveText('Reset to recommended');
    await resetItem.click();
    await expect(
      claudeColumn.getByTestId(`harness-row-${alphaId}`),
    ).toBeVisible();
    await expect(codexColumn.getByTestId(`harness-row-${alphaId}`)).toHaveCount(
      0,
    );

    // --- Pointer drag: Claude → Codex with drop highlight + overlay. ---
    await dragRowToColumn(
      window,
      claudeColumn.getByTestId(`harness-row-${alphaId}`),
      codexColumn,
    );
    await expect(
      codexColumn.getByTestId(`harness-row-${alphaId}`),
    ).toBeVisible();
    await expect(
      claudeColumn.getByTestId(`harness-row-${alphaId}`),
    ).toHaveCount(0);
    await expect(window.getByTestId('harness-drag-overlay')).toHaveCount(0);
    await expect(codexColumn).not.toHaveAttribute(
      'data-drop-highlight',
      'true',
    );

    // --- Keyboard move: lift with Enter, arrow to the other column, drop. ---
    const bravoRow = codexColumn.getByTestId(`harness-row-${bravoId}`);
    await bravoRow.focus();
    await window.keyboard.press('Enter');
    await expect(window.getByTestId('harness-drag-overlay')).toBeVisible();
    await window.keyboard.press('ArrowLeft');
    await expect(claudeColumn).toHaveAttribute('data-drop-highlight', 'true');
    await window.keyboard.press('Enter');
    await expect(
      claudeColumn.getByTestId(`harness-row-${bravoId}`),
    ).toBeVisible();
    await expect(codexColumn.getByTestId(`harness-row-${bravoId}`)).toHaveCount(
      0,
    );
    await expect(window.getByTestId('harness-save-error')).toHaveCount(0);

    await window.screenshot({
      path: testInfo.outputPath('harnesses-after-moves.png'),
    });

    // --- Persistence: relaunch on the same user data dir. ---
    await closeCanopy(activeApp.electronApp, userDataDir, {
      keepUserData: true,
    });
    activeApp = await launchCanopy({ userDataDir });
    window = await activeApp.electronApp.firstWindow();
    app = new CanopyAppDriver(window);
    await openHarnessesSettings(window, app);

    claudeColumn = window.getByTestId('harness-column-claude');
    codexColumn = window.getByTestId('harness-column-codex');
    await expect(
      codexColumn.getByTestId(`harness-row-${alphaId}`),
    ).toBeVisible();
    await expect(
      claudeColumn.getByTestId(`harness-row-${alphaId}`),
    ).toHaveCount(0);
    await expect(
      claudeColumn.getByTestId(`harness-row-${bravoId}`),
    ).toBeVisible();
    await expect(codexColumn.getByTestId(`harness-row-${bravoId}`)).toHaveCount(
      0,
    );

    await window.screenshot({
      path: testInfo.outputPath('harnesses-after-relaunch.png'),
    });
  } finally {
    await closeCanopy(activeApp.electronApp, userDataDir);
  }
});

test('a Home-created chat captures the configured gateway harness while its worktree sets up', async () => {
  test.setTimeout(120_000);

  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-harness-home-send-'),
  );
  seedAiGatewayModelCatalogCache(userDataDir);
  seedDemoWorkspaces({
    userDataDir,
    apps: ['ts-pnpm-vite'],
    createWorktrees: false,
  });
  const { electronApp } = await launchCanopy({
    userDataDir,
    env: { CANOPY_GIT_EXECUTABLE: writeSlowGitShim(userDataDir) },
  });

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await openHarnessesSettings(window, app);

    const bravoRow = window.getByTestId(`harness-row-${GATEWAY_BRAVO.id}`);
    test.skip(
      (await bravoRow.count()) === 0,
      'The seeded AI Gateway catalog was not honored by this E2E build.',
    );

    // Reproduce the reported assignment: this model recommends Codex, but the
    // user explicitly configures it to run on Claude.
    await bravoRow.hover();
    await window.getByTestId(`harness-row-menu-${GATEWAY_BRAVO.id}`).click();
    await expect(window.getByTestId('harness-menu-move')).toHaveText(
      'Move to Claude',
    );
    await window.getByTestId('harness-menu-move').click();
    await expect(
      window
        .getByTestId('harness-column-claude')
        .getByTestId(`harness-row-${GATEWAY_BRAVO.id}`),
    ).toBeVisible();

    await app.closeSettings();
    await connectMockCloudAccount(window, 'csk_harness_home_send_e2e');
    await window.getByTestId('sidebar-create-task').click();
    const home = window.getByTestId('page-home');
    await expect(home).toBeVisible();
    await home.getByTestId('chat-model-picker').click();
    await selectModelOption(window, `${GATEWAY_BRAVO.id}`);
    await expect(home.getByTestId('chat-model-picker')).toContainText(
      GATEWAY_BRAVO.label,
    );

    const prompt = 'Keep this gateway model on its configured Claude harness.';
    await home.getByTestId('home-composer-editor').fill(prompt);
    await home.getByTestId('home-send-button').click();

    // Main holds the first send for the new worktree's Git setup: it shows as
    // sent, under the turn's setup status (CAN-5483).
    const panel = window.getByTestId('panel-content-chat');
    await expect(panel).toBeVisible({ timeout: 15_000 });
    await expect(panel.getByText(prompt).first()).toBeVisible({
      timeout: 15_000,
    });
    await expect(panel.locator(SETUP_STATUS)).toBeVisible({ timeout: 15_000 });
    await expect(
      panel.getByRole('list', { name: 'Queued messages' }),
    ).toHaveCount(0);
    await expect(
      panel.getByTestId('chat-model-picker-provider-icon'),
    ).toHaveAttribute('data-provider', 'claude');
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('an API model is one row under each of its three harnesses in a fresh chat', async () => {
  test.setTimeout(120_000);
  const { launchCursorSelectionFixture } =
    await import('./fixtures/cursor-selection.mjs');
  const f = await launchCursorSelectionFixture({ gatewayModel: true });
  try {
    await f.connection(true);
    await connectMockCloudAccount(f.window, 'csk_chat_harness_e2e');
    await f.driver.openSettings();
    await f.driver.openSettingsSection('harnesses');
    const settings = f.window.getByTestId('settings-tab-harnesses');
    const row = settings.getByTestId('harness-row-e2e-kimi');
    await expect(row).toContainText('Kimi K3');
    await expect(
      settings.getByTestId('harness-row-cursor:kimi-k3%5B%5D'),
    ).toHaveCount(0);
    await row.getByRole('button', { name: /actions/i }).click();
    await f.window
      .getByRole('menuitem', { name: 'Move to Cursor', exact: true })
      .click();
    await expect(
      settings
        .getByTestId('harness-column-cursor')
        .getByTestId('harness-row-e2e-kimi'),
    ).toBeVisible();
    await f.driver.closeSettings();
    await f.window.getByTestId('sidebar-create-task').click();
    const home = f.window.getByTestId('page-home');
    await home.getByTestId('home-branch-picker-button').click();
    await f.window.getByTestId('home-branch-picker-worktree-demo-main').click();
    const picker = home.getByTestId('chat-model-picker');
    const harness = home.getByTestId('chat-model-picker-provider-icon');
    await picker.click();
    await selectModelOption(f.window, 'e2e-kimi');
    await expect(picker).toContainText('Kimi K3');
    // The harness is chosen inside the picker; no control sits beside it.
    await expect(home.getByTestId('chat-harness-picker')).toHaveCount(0);
    await expect(home.getByTestId('chat-execution-harness-picker')).toHaveCount(
      0,
    );
    await expect(harness).toHaveAttribute('data-provider', 'cursor');
    await picker.click();
    await selectModelOnHarness(f.window, 'e2e-kimi', 'claude');
    await expect(harness).toHaveAttribute('data-provider', 'claude');
    await picker.click();
    await selectModelOnHarness(f.window, 'e2e-kimi', 'codex');
    await expect(harness).toHaveAttribute('data-provider', 'codex');
    await picker.click();
    await f.window.getByTestId('chat-model-harness-tab-cursor').click();
    // Cursor's copy is the same row, never a second Cursor-only one.
    await expect(
      f.window.locator(
        '[data-testid="chat-model-option-cursor:kimi-k3%5B%5D"]:visible',
      ),
    ).toHaveCount(0);
    await selectModelOnHarness(f.window, 'e2e-kimi', 'cursor');
    await expect(picker).toContainText('Kimi K3');
    await expect(harness).toHaveAttribute('data-provider', 'cursor');
    await home
      .getByTestId('home-composer-editor')
      .fill('CURSOR_CHAT_E2E_MODEL: gateway harness');
    await home.getByTestId('home-send-button').click();
    await expect(
      f.window.getByText('Cursor model: kimi-k3[]; restored: false', {
        exact: true,
      }),
    ).toBeVisible();
    const tabs = await f.window.evaluate(
      (target) => window.api.chat.loadTabs(target),
      f.target,
    );
    expect(
      tabs.tabs.find((tab) => tab.model === 'cursor:kimi-k3%5B%5D'),
    ).toMatchObject({ providerType: 'cursor' });
  } finally {
    await f.close();
  }
});

test('a reloaded renderer keeps the discovered Cursor list while refresh is pending', async () => {
  test.setTimeout(120_000);
  const { launchCursorSelectionFixture } =
    await import('./fixtures/cursor-selection.mjs');
  const f = await launchCursorSelectionFixture({ sharedModel: true });
  try {
    await f.connection(true);
    // Connection setup warmed main's model registry. A new renderer must use
    // that snapshot before another potentially slow ACP discovery completes.
    await f.electronApp.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('cursor-connection:models');
      ipcMain.handle('cursor-connection:models', () => new Promise(() => {}));
    });
    await f.window.reload();
    await f.driver.waitForShell();
    await f.window.getByTestId('sidebar-create-task').click();
    const home = f.window.getByTestId('page-home');
    await home.getByTestId('home-branch-picker-button').click();
    await f.window.getByTestId('home-branch-picker-worktree-demo-main').click();
    await home.getByTestId('chat-model-picker').click();
    const group = f.window.getByRole('group', { name: 'Cursor', exact: true });
    // Third-party models retain their maker's section; Default is Cursor's own.
    await expect(group.getByRole('menuitemradio')).toHaveCount(1);
    await expect(
      f.window
        .getByRole('group', { name: 'Google', exact: true })
        .getByTestId(
          'chat-model-option-cursor:' + encodeURIComponent('gemini-3.1-pro[]'),
        ),
    ).toContainText('Gemini 3.1 Pro');
  } finally {
    await f.close();
  }
});

test('Default harness offers Cursor only for supported models and a fresh composer can override it', async () => {
  test.setTimeout(120_000);
  const { launchCursorSelectionFixture } =
    await import('./fixtures/cursor-selection.mjs');
  const f = await launchCursorSelectionFixture({ sharedModel: true });
  const nativeId = 'gpt-6-astra';
  const cursorId =
    'cursor:' + encodeURIComponent('gpt-6-astra[reasoning=medium]');
  try {
    await f.connection(true);
    await f.driver.openSettings();
    await f.driver.openSettingsSection('harnesses');
    const settings = f.window.getByTestId('settings-tab-harnesses');
    await expect(
      settings.getByRole('heading', { name: 'Default harness', exact: true }),
    ).toBeVisible();
    const row = settings.getByTestId(`harness-row-${nativeId}`);
    await expect(row).toHaveAttribute('data-harness-row-kind', 'configurable');
    await row.getByRole('button', { name: /actions/i }).click();
    await f.window
      .getByRole('menuitem', { name: 'Move to Cursor', exact: true })
      .click();
    await expect(
      settings
        .getByTestId('harness-column-cursor')
        .getByTestId(`harness-row-${nativeId}`),
    ).toBeVisible();
    await expect(settings.getByTestId('harness-row-sonnet')).toHaveAttribute(
      'data-harness-row-kind',
      'managed',
    );
    await f.driver.closeSettings();
    await f.window.getByTestId('sidebar-create-task').click();
    const home = f.window.getByTestId('page-home');
    await home.getByTestId('home-branch-picker-button').click();
    await f.window.getByTestId('home-branch-picker-worktree-demo-main').click();
    const picker = home.getByTestId('chat-model-picker');
    const harness = home.getByTestId('chat-model-picker-provider-icon');
    await picker.click();
    await selectModelOption(f.window, `${nativeId}`);
    // All runs a native model on its own harness, whatever its saved default.
    await expect(harness).toHaveAttribute('data-provider', 'codex');
    await expect(home.getByTestId('chat-harness-picker')).toHaveCount(0);
    // Every row in a harness tab shows that tab's harness, its own models
    // included. The icon doubles as the row's menu trigger when it has one.
    const rowHarness = () =>
      f.window
        .locator(
          `[data-testid="chat-model-harness-icon-${nativeId}"]:visible, [data-testid="chat-model-harness-control-${nativeId}"]:visible`,
        )
        .first();
    await picker.click();
    await f.window.getByTestId('chat-model-harness-tab-codex').click();
    await expect(rowHarness()).toHaveAttribute('data-harness', 'codex');
    // Its own tab runs the model natively, even with Cursor as its default.
    await selectModelOnHarness(f.window, nativeId, 'codex');
    await expect(harness).toHaveAttribute('data-provider', 'codex');
    await picker.click();
    await f.window.getByTestId('chat-model-harness-tab-cursor').click();
    await expect(
      f.window.locator(`[data-testid="chat-model-option-${nativeId}"]:visible`),
    ).toBeVisible();
    await expect(rowHarness()).toHaveAttribute('data-harness', 'cursor');
    await expect(
      f.window.locator(`[data-testid="chat-model-option-${cursorId}"]:visible`),
    ).toHaveCount(0);
    // All keeps the model on its own harness; its favorite switches harness.
    await f.window.getByTestId('chat-model-harness-tab-all').click();
    await expect(
      f.window.locator(
        `[data-testid="chat-model-harness-control-${nativeId}"]:visible`,
      ),
    ).toHaveCount(0);
    await f.window.getByTestId('chat-model-harness-tab-favorites').click();
    await f.window
      .locator(`[data-testid="chat-model-harness-control-${nativeId}"]:visible`)
      .click();
    await f.window
      .getByTestId(`chat-model-settings-harness-cursor-${nativeId}`)
      .click();
    await f.window
      .locator(`[data-testid="chat-model-option-${nativeId}"]:visible`)
      .click();
    await expect(harness).toHaveAttribute('data-provider', 'cursor');
    // The Cursor turn runs at the effort the composer shows, so the fixture
    // reports the advertised variant with that reasoning value.
    const reasoning = await cursorReasoningShownOn(home);
    await home
      .getByTestId('home-composer-editor')
      .fill('CURSOR_CHAT_E2E_MODEL: default harness');
    await home.getByTestId('home-send-button').click();
    await expect(
      f.window.getByText(
        `Cursor model: gpt-6-astra[reasoning=${reasoning}]; restored: false`,
        { exact: true },
      ),
    ).toBeVisible();
    const tabs = await f.window.evaluate(
      (target) => window.api.chat.loadTabs(target),
      f.target,
    );
    expect(tabs.tabs.find((tab) => tab.model === cursorId)).toMatchObject({
      providerType: 'cursor',
    });
  } finally {
    await f.close();
  }
});

for (const scenario of [
  'ready',
  'slow discovery',
  'rollout disabled',
  'preference disabled',
  'reconnect',
]) {
  test(`Saved Cursor default on restart: ${scenario}`, async () => {
    test.setTimeout(120_000);
    const { launchCursorSelectionFixture } =
      await import('./fixtures/cursor-selection.mjs');
    const f = await launchCursorSelectionFixture({ sharedModel: true });
    const barrier = path.join(
      os.tmpdir(),
      `cursor-discovery-${process.pid}-${Date.now()}`,
    );
    try {
      await f.connection(true);
      await f.driver.openSettings();
      await f.driver.openSettingsSection('harnesses');
      const row = f.window.getByTestId('harness-row-gpt-6-astra');
      await expect(row).toHaveAttribute(
        'data-harness-row-kind',
        'configurable',
      );
      await row.getByRole('button', { name: /actions/i }).click();
      await f.window
        .getByRole('menuitem', { name: 'Move to Cursor', exact: true })
        .click();
      await expect(
        f.window
          .getByTestId('harness-column-cursor')
          .getByTestId('harness-row-gpt-6-astra'),
      ).toBeVisible();
      await f.driver.closeSettings();
      await f.window.evaluate(async () => {
        const prefs = await window.api.loadPreferences();
        await window.api.savePreferences({
          defaultWorktreeProvider: 'codex',
          defaultWorktreeModelByProvider: {
            ...prefs.defaultWorktreeModelByProvider,
            codex: { model: 'gpt-6-astra', thinkingLevel: 'medium' },
          },
        });
      });
      if (scenario === 'slow discovery') {
        let shellReady = false;
        const restarting = f
          .restart({ CANOPY_E2E_CURSOR_DISCOVERY_BARRIER: barrier })
          .then(() => {
            shellReady = true;
          });
        try {
          await expect
            .poll(() => existsSync(`${barrier}.started`), { timeout: 20_000 })
            .toBe(true);
          // Discovery cannot complete until this test releases it. The desktop
          // shell must remain usable while the vendor process is stuck.
          await expect.poll(() => shellReady, { timeout: 15_000 }).toBe(true);
        } finally {
          writeFileSync(barrier, 'release');
          await restarting;
        }
      } else {
        await f.restart();
      }
      if (scenario === 'reconnect') {
        await f.connection(false);
        await f.connection(true);
      }
      if (scenario === 'preference disabled') {
        await f.window.evaluate(() =>
          window.api.savePreferences({ cursorEnabled: false }),
        );
      }
      if (scenario === 'rollout disabled') {
        await f.electronApp.evaluate(() => {
          const values = JSON.parse(
            process.env.CANOPY_E2E_CLIENT_FEATURE_FLAGS,
          );
          values['canopy-desktop-cursor-harness'] = false;
          process.env.CANOPY_E2E_CLIENT_FEATURE_FLAGS = JSON.stringify(values);
        });
        await f.window.evaluate(() => window.api.featureFlags.refreshContext());
      }
      await f.window.getByTestId('sidebar-create-task').click();
      const home = f.window.getByTestId('page-home');
      await home.getByTestId('home-branch-picker-button').click();
      await f.window
        .getByTestId('home-branch-picker-worktree-demo-main')
        .click();
      // The normal Code default is Astra. Neither picker nor settings discovers models after restart.
      await expect(home.getByTestId('chat-model-picker')).toContainText(
        'GPT 6 Astra',
      );
      await expect(
        home.getByTestId('chat-model-picker-provider-icon'),
      ).toHaveAttribute(
        'data-provider',
        scenario.endsWith('disabled') ? 'codex' : 'cursor',
      );
      if (scenario.endsWith('disabled')) return;
      const reasoning = await cursorReasoningShownOn(home);
      await home
        .getByTestId('home-composer-editor')
        .fill('CURSOR_CHAT_E2E_MODEL: restored default harness');
      await home.getByTestId('home-send-button').click();
      await expect(
        f.window.getByText(
          `Cursor model: gpt-6-astra[reasoning=${reasoning}]; restored: false`,
          { exact: true },
        ),
      ).toBeVisible();
    } finally {
      await f.close();
      rmSync(barrier, { force: true });
      rmSync(`${barrier}.started`, { force: true });
    }
  });
}

async function advisorRequest(electronApp, request) {
  return electronApp.evaluate(async ({ BrowserWindow, ipcMain }, payload) => {
    const mainWindow = BrowserWindow.getAllWindows().find(
      (window) => !window.webContents.getURL().includes('surface=app-advisor'),
    );
    if (!mainWindow) throw new Error('Missing main window');
    ipcMain.removeHandler('app-advisor:tool-response');
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('Advisor response timed out')),
        5000,
      );
      ipcMain.handle('app-advisor:tool-response', (_event, response) => {
        if (response.requestId !== payload.requestId) return;
        clearTimeout(timer);
        resolve(response);
      });
      mainWindow.webContents.send('app-advisor:tool-request', payload);
    });
  }, request);
}

test('App Advisor selects a supported harness on the visible fresh composer', async () => {
  test.setTimeout(120_000);
  const { launchCursorSelectionFixture } =
    await import('./fixtures/cursor-selection.mjs');
  const f = await launchCursorSelectionFixture({ sharedModel: true });
  try {
    await f.connection(true);
    await f.window.getByTestId('sidebar-create-task').click();
    const home = f.window.getByTestId('page-home');
    await home.getByTestId('home-branch-picker-button').click();
    await f.window.getByTestId('home-branch-picker-worktree-demo-main').click();
    const harness = home.getByTestId('chat-model-picker-provider-icon');
    await home.getByTestId('chat-model-picker').click();
    await selectModelOption(f.window, 'gpt-6-astra');
    await expect(harness).toHaveAttribute('data-provider', 'codex');
    // The harness lives inside the picker, so the action has no chip to use.
    await expect(home.getByTestId('chat-harness-picker')).toHaveCount(0);
    const state = await advisorRequest(f.electronApp, {
      kind: 'get_current_ui_state',
      requestId: 'harness-state',
    });
    expect(state.uiState.snapshot.chatHarnessPickers).toHaveLength(1);
    const picker = state.uiState.snapshot.chatHarnessPickers.find(
      (row) => row.model === 'gpt-6-astra',
    );
    expect(picker.availableHarnesses).toEqual(['codex', 'cursor']);
    const dispatched = await advisorRequest(f.electronApp, {
      kind: 'dispatch_action',
      requestId: 'select-harness',
      source: 'assistant',
      action: {
        type: 'chat.set_harness',
        pickerId: picker.pickerId,
        harness: 'cursor',
      },
    });
    expect(dispatched).toMatchObject({ ok: true });
    await expect(harness).toHaveAttribute('data-provider', 'cursor');
    const reasoning = await cursorReasoningShownOn(home);
    await home
      .getByTestId('home-composer-editor')
      .fill('CURSOR_CHAT_E2E_MODEL: advisor harness');
    await home.getByTestId('home-send-button').click();
    await expect(
      f.window.getByText(
        `Cursor model: gpt-6-astra[reasoning=${reasoning}]; restored: false`,
        { exact: true },
      ),
    ).toBeVisible();
    const after = await advisorRequest(f.electronApp, {
      kind: 'get_current_ui_state',
      requestId: 'started-harness-state',
    });
    expect(after.uiState.snapshot.chatHarnessPickers ?? []).not.toContainEqual(
      expect.objectContaining({ pickerId: picker.pickerId }),
    );
  } finally {
    await f.close();
  }
});

test('Home selects a gateway harness for one chat without changing the default', async () => {
  test.setTimeout(120_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-chat-harness-'),
  );
  seedAiGatewayModelCatalogCache(userDataDir);
  seedDemoWorkspaces({
    userDataDir,
    apps: ['ts-pnpm-vite'],
    createWorktrees: false,
  });
  const { electronApp } = await launchCanopy({
    userDataDir,
    env: { CANOPY_GIT_EXECUTABLE: writeSlowGitShim(userDataDir) },
  });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await connectMockCloudAccount(window, 'csk_chat_harness_e2e');
    await window.getByTestId('sidebar-create-task').click();
    const home = window.getByTestId('page-home');
    await home.getByTestId('chat-model-picker').click();
    await selectModelOption(window, `${GATEWAY_BRAVO.id}`);
    await expect(home.getByTestId('chat-model-picker')).toContainText(
      GATEWAY_BRAVO.label,
    );
    await home.getByTestId('chat-model-picker').click();
    await selectModelOnHarness(window, GATEWAY_BRAVO.id, 'claude');
    await expect(
      home.getByTestId('chat-model-picker-provider-icon'),
    ).toHaveAttribute('data-provider', 'claude');
    await home
      .getByTestId('home-composer-editor')
      .fill('Use Claude for this task.');
    await home.getByTestId('home-send-button').click();
    const panel = window.getByTestId('panel-content-chat');
    await expect(panel).toBeVisible({ timeout: 15_000 });
    await expect(
      panel.getByText('Use Claude for this task.').first(),
    ).toBeVisible({ timeout: 15_000 });
    await expect(panel.locator(SETUP_STATUS)).toBeVisible({ timeout: 15_000 });
    await expect(
      panel.getByRole('list', { name: 'Queued messages' }),
    ).toHaveCount(0);
    await expect(
      panel.getByTestId('chat-model-picker-provider-icon'),
    ).toHaveAttribute('data-provider', 'claude');
    const chatStorageDir = path.join(
      userDataDir,
      'workspaces',
      'demo-ts-pnpm-vite',
      'chat-storage-v2',
    );
    let selectedTab;
    let selectedWorktreeId;
    await expect
      .poll(
        () => {
          if (!existsSync(chatStorageDir)) return undefined;
          for (const worktreeId of readdirSync(chatStorageDir)) {
            const liveIndexPath = path.join(
              chatStorageDir,
              worktreeId,
              'live-index.json',
            );
            if (!existsSync(liveIndexPath)) continue;
            const tabs = JSON.parse(readFileSync(liveIndexPath, 'utf8')).tabs;
            const match = tabs.find((tab) => tab.model === GATEWAY_BRAVO.id);
            if (match) {
              selectedTab = match;
              selectedWorktreeId = worktreeId;
              return {
                executionHarness: match.executionHarness,
                executionHarnessExplicitlyChosen:
                  match.executionHarnessExplicitlyChosen,
              };
            }
          }
        },
        { timeout: 15_000 },
      )
      .toEqual({
        executionHarness: 'claude',
        executionHarnessExplicitlyChosen: true,
      });
    expect(selectedTab.providerType).toBe('claude');
    // The sent prompt is optimistic. Wait for main to accept the first
    // message before testing the conversation lock through another IPC call.
    await expect
      .poll(
        () =>
          window.evaluate(
            async ({ chatId, worktreeId }) => {
              const state = await window.api.chat.getState({
                projectId: 'demo-ts-pnpm-vite',
                worktreeId,
              });
              const tab = state.tabsFile.tabs.find(
                (entry) => entry.id === chatId,
              );
              return {
                tabPresent: tab !== undefined,
                executionHarness: tab?.executionHarness,
                accepted:
                  (tab?.messages.length ?? 0) > 0 ||
                  (state.runtimeByChatId[chatId]?.queuedMessageIds.length ??
                    0) > 0,
              };
            },
            { chatId: selectedTab.id, worktreeId: selectedWorktreeId },
          ),
        { timeout: 15_000 },
      )
      .toEqual({
        tabPresent: true,
        accepted: true,
        executionHarness: 'claude',
      });
    const rejected = await window.evaluate(
      async ({ chatId, worktreeId, model }) => {
        try {
          return await window.api.chat.changeModel({
            projectId: 'demo-ts-pnpm-vite',
            worktreeId,
            chatId,
            model,
            executionHarness: 'codex',
          });
        } catch {
          return false;
        }
      },
      {
        chatId: selectedTab.id,
        worktreeId: selectedWorktreeId,
        model: GATEWAY_BRAVO.id,
      },
    );
    expect(rejected).toBe(false);

    await app.openSettings();
    await app.openSettingsSection('harnesses');
    await expect(
      window
        .getByTestId('harness-column-codex')
        .getByTestId(`harness-row-${GATEWAY_BRAVO.id}`),
    ).toBeVisible();
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('Home preserves thinking when selecting another harness for an existing worktree', async () => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'home-harness-thinking-'),
  );
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedAiGatewayModelCatalogCache(userDataDir);
  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await connectMockCloudAccount(window, 'csk_chat_harness_e2e');
    await window.getByTestId('sidebar-create-task').click();
    const home = window.getByTestId('page-home');
    await home.getByTestId('home-branch-picker-button').click();
    await window.getByTestId('home-branch-picker-worktree-demo-main').click();
    await home.getByTestId('chat-model-picker').click();
    await selectModelOption(window, `${GATEWAY_BRAVO.id}`);
    await home.getByTestId('chat-model-picker').click();
    await selectModelOnHarness(window, GATEWAY_BRAVO.id, 'claude');
    const thinking = home.getByTestId('home-thinking-level-button');
    await stepEffortAway(
      await openEffortSlider(window, thinking, 'home-thinking-level-button'),
    );
    await closeEffortPanel(window);
    await expect(thinking).not.toHaveAttribute('data-thinking-level', 'high');
    const displayedThinking = await thinking.getAttribute(
      'data-thinking-level',
    );
    await home.getByTestId('home-send-button').click();
    const panel = window.getByTestId('panel-content-chat');
    await expect(panel.getByTestId('chat-model-picker')).toContainText(
      GATEWAY_BRAVO.label,
    );
    await expect(
      panel.getByTestId('chat-model-picker-provider-icon'),
    ).toHaveAttribute('data-provider', 'claude');
    await expect(
      panel.getByTestId('chat-input-thinking-level-button'),
    ).toHaveAttribute('data-thinking-level', displayedThinking);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('a local Ollama model picks its Claude or Codex harness inside the model picker', async () => {
  const { cursorRuntimeFixture } =
    await import('./fixtures/cursor-runtime.mjs');
  const { expectCursorConnected } = await import('./fixtures/cursor-tile.mjs');
  const managed = await cursorRuntimeFixture();
  const { electronApp, userDataDir } = await launchOllamaDiscoveryFixture(
    'codex',
    { env: managed.env },
  );
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await app.openSettings();
    await app.openSettingsSection('experiments');
    await window.getByTestId('cursor-connect').click();
    await expectCursorConnected(window);
    await app.closeSettings();
    await app.openMainPage();
    await app.selectWorktree('demo-main');
    const panel = window.getByTestId('panel-content-chat');
    await expect(panel.getByTestId('chat-model-picker')).toContainText(
      'qwen3-coder',
    );
    await expect(
      panel.getByTestId('chat-execution-harness-picker'),
    ).toHaveCount(0);
    await panel.getByTestId('chat-model-picker').click();
    // Cursor never runs a local model, so its tab does not list one.
    await window.getByTestId('chat-model-harness-tab-cursor').click();
    await expect(
      window.locator(
        '[data-testid="chat-model-option-ollama-qwen3-coder"]:visible',
      ),
    ).toHaveCount(0);
    await window.getByTestId('chat-model-harness-tab-codex').click();
    await expect(
      window.locator(
        '[data-testid="chat-model-option-ollama-qwen3-coder"]:visible',
      ),
    ).toBeVisible();
    await selectModelOnHarness(window, 'ollama-qwen3-coder', 'claude');
    await expect
      .poll(async () => {
        const result = await window.evaluate(() =>
          window.api.chat.loadTabs({
            projectId: 'demo-ts-pnpm-vite',
            worktreeId: 'demo-main',
          }),
        );
        return result.tabs.find((tab) => tab.id === 'ollama-discovery')
          ?.executionHarness;
      })
      .toBe('claude');
  } finally {
    await closeCanopy(electronApp, userDataDir);
    await managed.close();
  }
});

test('started Ollama chat preserves its explicit Claude harness in the model picker', async () => {
  const { electronApp, userDataDir } = await launchOllamaDiscoveryFixture(
    'claude',
    { started: true, seed: seedAiGatewayModelCatalogCache },
  );
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await connectMockCloudAccount(window, 'csk_chat_harness_e2e');
    await app.openMainPage();
    await app.selectWorktree('demo-main');
    const panel = window.getByTestId('panel-content-chat');
    await expect(
      panel.getByText('Started Ollama conversation', { exact: true }),
    ).toBeVisible();
    await panel.getByTestId('chat-model-picker').click();
    // All lists every harness's models; other tabs keep hidden copies.
    await window.getByTestId('chat-model-harness-tab-all').click();
    const localModel = window.locator(
      '[data-testid="chat-model-option-ollama-qwen3-coder"]:visible',
    );
    await expect(localModel).toBeVisible();
    await expect(
      window.locator(
        `[data-testid="chat-model-option-${GATEWAY_ALPHA.id}"]:visible`,
      ),
    ).not.toHaveAttribute('aria-disabled', 'true');
    await selectModelOption(window, `${GATEWAY_ALPHA.id}`);
    await expect(panel.getByTestId('chat-model-picker')).toContainText(
      GATEWAY_ALPHA.label,
    );
    await expect(window.getByRole('dialog')).toHaveCount(0);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('an empty worktree chat keeps its own harness across app relaunch', async () => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-empty-chat-harness-'),
  );
  seedAiGatewayModelCatalogCache(userDataDir);
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  let { electronApp } = await launchCanopy({ userDataDir });
  try {
    let window = await electronApp.firstWindow();
    let app = new CanopyAppDriver(window);
    await app.waitForShell();
    await connectMockCloudAccount(window, 'csk_chat_harness_e2e');
    await app.selectWorktree('demo-main');
    let panel = window.getByTestId('panel-content-chat');
    await panel.getByTestId('chat-model-picker').click();
    await selectModelOption(window, `${GATEWAY_BRAVO.id}`);
    await expect(panel.getByTestId('chat-model-picker')).toContainText(
      GATEWAY_BRAVO.label,
    );
    let harness = panel.getByTestId('chat-model-picker-provider-icon');
    await panel.getByTestId('chat-model-picker').click();
    await selectModelOnHarness(window, GATEWAY_BRAVO.id, 'claude');
    await expect(harness).toHaveAttribute('data-provider', 'claude');
    const canonicalChange = await window.evaluate(async (model) => {
      const scope = { projectId: 'demo-ts-pnpm-vite', worktreeId: 'demo-main' };
      const state = await window.api.chat.getState(scope);
      return window.api.chat.command({
        ...scope,
        schemaVersion: 1,
        commandId: 'e2e-draft-harness',
        expectedRevision: state.revision,
        command: {
          type: 'chat.set_model',
          tabId: state.tabsFile.activeTabId,
          model,
          providerType: 'claude',
          executionHarness: 'claude',
        },
      });
    }, GATEWAY_BRAVO.id);
    expect(canonicalChange.outcome).toBe('applied');
    await closeCanopy(electronApp, userDataDir, { keepUserData: true });
    ({ electronApp } = await launchCanopy({ userDataDir }));
    window = await electronApp.firstWindow();
    app = new CanopyAppDriver(window);
    await app.waitForShell();
    await app.selectWorktree('demo-main');
    panel = window.getByTestId('panel-content-chat');
    harness = panel.getByTestId('chat-model-picker-provider-icon');
    await expect(harness).toHaveAttribute('data-provider', 'claude');
    await panel.getByTestId('chat-model-picker').click();
    await selectModelOption(window, `${GATEWAY_ALPHA.id}`);
    await expect(harness).toHaveAttribute('data-provider', 'claude');
    await panel.getByTestId('chat-model-picker').click();
    await selectModelOption(window, `${GATEWAY_BRAVO.id}`);
    await expect(harness).toHaveAttribute('data-provider', 'codex');
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test("a fresh chat's model picker discovers Cursor for an API model after restart without a saved Cursor default", async () => {
  test.setTimeout(180_000);
  const { launchCursorSelectionFixture } =
    await import('./fixtures/cursor-selection.mjs');
  const f = await launchCursorSelectionFixture({ gatewayModel: true });
  try {
    await f.connection(true);
    await connectMockCloudAccount(f.window, 'csk_chat_harness_restart_e2e');
    await f.window.evaluate(async () => {
      const prefs = await window.api.loadPreferences();
      await window.api.savePreferences({
        defaultWorktreeProvider: 'codex',
        lastChatBillingFramework: 'ai-credits',
        defaultWorktreeModelByProvider: {
          ...prefs.defaultWorktreeModelByProvider,
          aiCredits: { model: 'e2e-kimi', thinkingLevel: 'medium' },
        },
      });
    });
    await registerScenario(DEFAULT_MOCK_BASE_URL, 'cursor-cold-credits', {
      authUsage: { scenario: 'unauthenticated' },
    });
    await f.restart({ CANOPY_MOCK_API_KEY: 'cursor-cold-credits' });
    expect(
      (await f.window.evaluate(() => window.api.getModelRegistry())).cursor ??
        [],
    ).toHaveLength(0);
    await f.window.getByTestId('sidebar-create-task').click();
    const home = f.window.getByTestId('page-home');
    await home.getByTestId('home-branch-picker-button').click();
    await f.window.getByTestId('home-branch-picker-worktree-demo-main').click();
    await expect(home.getByTestId('chat-model-picker')).toContainText(
      'Kimi K3',
    );
    await home.getByTestId('chat-model-picker').click();
    // Opening the picker discovers Cursor, which then lists the model.
    await f.window.getByTestId('chat-model-harness-tab-cursor').click();
    await expect(
      f.window.locator('[data-testid="chat-model-option-e2e-kimi"]:visible'),
    ).toBeVisible({ timeout: 30_000 });
    await selectModelOnHarness(f.window, 'e2e-kimi', 'cursor');
    await expect(
      home.getByTestId('chat-model-picker-provider-icon'),
    ).toHaveAttribute('data-provider', 'cursor');
  } finally {
    await clearScenario(DEFAULT_MOCK_BASE_URL, 'cursor-cold-credits');
    await f.close();
  }
});

test('a cold API draft discovers Cursor after credits become unavailable', async () => {
  test.setTimeout(180_000);
  const { launchCursorSelectionFixture } =
    await import('./fixtures/cursor-selection.mjs');
  const fixture = await launchCursorSelectionFixture({ gatewayModel: true });
  const key = 'csk_cursor_cold_gateway_e2e';
  try {
    await fixture.connection(true);
    await connectMockCloudAccount(fixture.window, key);
    await fixture.openChat();
    let panel = fixture.window.getByTestId('panel-content-chat');
    await panel.getByTestId('chat-model-picker').click();
    await selectModelOption(fixture.window, 'e2e-kimi');
    await expect(panel.getByTestId('chat-model-picker')).toContainText(
      'Kimi K3',
    );
    await expect.poll(async () => (await fixture.tab()).model).toBe('e2e-kimi');
    await registerScenario(DEFAULT_MOCK_BASE_URL, key, {
      authUsage: { scenario: 'unauthenticated' },
      cloud: { aiCreditsBalance: { credits: 0, eligible: false } },
    });
    await fixture.restart({ CANOPY_MOCK_API_KEY: key });
    const credits = await fixture.window.evaluate(() =>
      window.api.loadNativeAiCreditsAvailability(),
    );
    expect(credits.personalEligible).toBe(false);
    expect(credits.orgSpendable).toBe(false);
    expect(credits.inconclusive).not.toBe(true);
    expect(
      (await fixture.window.evaluate(() => window.api.getModelRegistry()))
        .cursor ?? [],
    ).toHaveLength(0);
    await fixture.openChat();
    panel = fixture.window.getByTestId('panel-content-chat');
    await expect(panel.getByTestId('chat-model-picker')).toContainText(
      'Kimi K3',
    );
    await expect(
      panel.getByTestId('chat-input-no-billing-source-banner'),
    ).toBeVisible();
    await panel.getByTestId('chat-model-picker').click();
    // Without credits the hosted route is closed, but Cursor's copy runs on
    // the Cursor subscription, so its row stays pickable.
    await fixture.window.getByTestId('chat-model-harness-tab-cursor').click();
    const cursorRow = fixture.window.locator(
      '[data-testid="chat-model-option-e2e-kimi"]:visible',
    );
    await expect(cursorRow).toBeVisible({ timeout: 30_000 });
    await expect(cursorRow).not.toHaveAttribute('aria-disabled', 'true');
    await selectModelOnHarness(fixture.window, 'e2e-kimi', 'cursor');
    await expect(
      panel.getByTestId('chat-model-picker-provider-icon'),
    ).toHaveAttribute('data-provider', 'cursor');
    await expect
      .poll(async () => (await fixture.tab()).model)
      .toBe('cursor:kimi-k3%5B%5D');
  } finally {
    await clearScenario(DEFAULT_MOCK_BASE_URL, key);
    await fixture.close();
  }
});

for (const [discoveryResult, message] of [
  ['rejected', 'Could not load Cursor models. Reopen this menu to try again.'],
  ['empty', 'Reconnect Cursor in Settings to load models.'],
  // Cursor answered but does not offer the model: nothing to explain, the
  // Cursor tab simply does not list it.
  ['unmatched', undefined],
]) {
  test(`the cold model picker explains ${discoveryResult} Cursor discovery`, async () => {
    test.setTimeout(180_000);
    const { launchCursorSelectionFixture } =
      await import('./fixtures/cursor-selection.mjs');
    const fixture = await launchCursorSelectionFixture({ gatewayModel: true });
    const key = `csk_cursor_discovery_${discoveryResult}_e2e`;
    try {
      await fixture.connection(true);
      await connectMockCloudAccount(fixture.window, key);
      await fixture.openChat();
      await fixture.window
        .getByTestId('panel-content-chat')
        .getByTestId('chat-model-picker')
        .click();
      await selectModelOption(fixture.window, 'e2e-kimi');
      await expect
        .poll(async () => (await fixture.tab()).model)
        .toBe('e2e-kimi');
      await registerScenario(DEFAULT_MOCK_BASE_URL, key, {
        authUsage: { scenario: 'unauthenticated' },
        cloud: { aiCreditsBalance: { credits: 0, eligible: false } },
      });
      await fixture.restart({ CANOPY_MOCK_API_KEY: key });
      await fixture.setDiscoveryResult(discoveryResult);
      expect(
        (await fixture.window.evaluate(() => window.api.getModelRegistry()))
          .cursor ?? [],
      ).toHaveLength(0);
      await fixture.openChat();
      const panel = fixture.window.getByTestId('panel-content-chat');
      await expect(
        panel.getByTestId('chat-input-no-billing-source-banner'),
      ).toBeVisible();
      const row = fixture.window.locator(
        '[data-testid="chat-model-option-e2e-kimi"]:visible',
      );
      await panel.getByTestId('chat-model-picker').click();
      // Signed out of Claude and Codex with no credits, their tabs ask to
      // sign in instead of offering the hosted route.
      for (const harness of ['claude', 'codex']) {
        await fixture.window
          .getByTestId(`chat-model-harness-tab-${harness}`)
          .click();
        await expect(
          fixture.window.locator(
            '[data-testid="chat-model-connect-harness"]:visible',
          ),
        ).toBeVisible();
        // Cursor's status shows only in Cursor's own section or tab.
        await expect(
          fixture.window.locator(
            '[data-testid="cursor-models-status"]:visible',
          ),
        ).toHaveCount(0);
      }
      await fixture.window.getByTestId('chat-model-harness-tab-cursor').click();
      const status = fixture.window.locator(
        '[data-testid="cursor-models-status"]:visible',
      );
      if (message) {
        await expect(status).toHaveText(message);
      } else {
        await expect(status).toHaveCount(0);
      }
      await expect(row).toHaveCount(0);
      if (discoveryResult === 'rejected') {
        await fixture.window.keyboard.press('Escape');
        await fixture.setDiscoveryResult('normal');
        await panel.getByTestId('chat-model-picker').click();
        await fixture.window
          .getByTestId('chat-model-harness-tab-cursor')
          .click();
        await expect(row).toBeVisible({ timeout: 30_000 });
        await selectModelOnHarness(fixture.window, 'e2e-kimi', 'cursor');
        await expect
          .poll(async () => (await fixture.tab()).model)
          .toBe('cursor:kimi-k3%5B%5D');
      }
    } finally {
      await clearScenario(DEFAULT_MOCK_BASE_URL, key);
      await fixture.close();
    }
  });
}

test('Default harness blocks Cursor destinations under enforced organization gateway policy', async () => {
  test.setTimeout(180_000);
  const { launchCursorSelectionFixture } =
    await import('./fixtures/cursor-selection.mjs');
  const f = await launchCursorSelectionFixture({
    gatewayModel: true,
    sharedModel: true,
  });
  const key = 'csk_harness_gateway_enforced_e2e';
  try {
    await f.connection(true);
    await f.electronApp.evaluate(() => {
      const values = JSON.parse(process.env.CANOPY_E2E_CLIENT_FEATURE_FLAGS);
      values['canopy-desktop-cursor-harness-released'] = true;
      process.env.CANOPY_E2E_CLIENT_FEATURE_FLAGS = JSON.stringify(values);
    });
    await f.window.evaluate(() => window.api.featureFlags.refreshContext());
    await registerScenario(DEFAULT_MOCK_BASE_URL, key, {
      cloud: {
        enforcedSettings: [
          {
            organizationId: '44444444-4444-4444-8444-444444444444',
            organizationName: 'Harness E2E',
            policies: [
              {
                kind: 'model-gateway',
                baseUrl: 'https://gateway.example.test',
                enforced: true,
                models: [],
                promptCachePassthrough: false,
              },
            ],
          },
        ],
      },
    });
    await connectMockCloudAccount(f.window, key);
    await f.driver.openSettings();
    await f.driver.openSettingsSection('harnesses');
    const settings = f.window.getByTestId('settings-tab-harnesses');
    await expect(settings.getByTestId('harness-row-e2e-kimi')).toBeVisible();
    await expect(settings.getByTestId('harness-column-cursor')).toHaveCount(0);
    await settings
      .getByTestId('harness-row-e2e-kimi')
      .getByRole('button', { name: /actions/i })
      .click();
    await expect(
      f.window.getByRole('menuitem', { name: 'Move to Cursor', exact: true }),
    ).toHaveCount(0);
    const results = await f.window.evaluate(async () => {
      const results = [];
      for (const modelId of ['e2e-kimi', 'gpt-6-astra']) {
        try {
          await window.api.harnessAssignments.set({
            modelId,
            harness: 'cursor',
          });
          results.push('saved');
        } catch (error) {
          results.push(String(error));
        }
      }
      return results;
    });
    for (const result of results) expect(result).toContain('organization');
  } finally {
    await clearScenario(DEFAULT_MOCK_BASE_URL, key);
    await f.close();
  }
});

test('released Cursor can be discovered and connected from Default harness settings', async () => {
  const launched = await launchCanopy({
    env: {
      CANOPY_E2E_CLIENT_FEATURE_FLAGS: JSON.stringify({
        'canopy-desktop-cursor-harness': true,
        'canopy-desktop-cursor-harness-released': true,
      }),
    },
  });
  try {
    const window = await launched.electronApp.firstWindow();
    const driver = new CanopyAppDriver(window);
    await driver.waitForShell();
    await driver.openSettings();
    await driver.openSettingsSection('harnesses');
    await expect(window.getByTestId('harness-column-cursor')).toBeVisible();
    await window.getByTestId('harness-connect-cursor').click();
    await expect(window.getByTestId('settings-tab-account')).toBeVisible();
    await expect(window.getByTestId('cursor-connect')).toBeVisible();
  } finally {
    await closeCanopy(launched.electronApp, launched.userDataDir);
  }
});
