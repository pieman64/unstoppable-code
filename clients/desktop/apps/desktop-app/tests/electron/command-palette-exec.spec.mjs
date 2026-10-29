import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';

const PALETTE_SHORTCUT = process.platform === 'darwin' ? 'Meta+K' : 'Control+K';

/**
 * Doc 3 gap G2 — command-palette command EXECUTION (not just opening).
 *
 * Exercises the renderer command-palette flow defined by:
 *   - command-palette/CommandPalette.tsx (palette shell + role="option" items)
 *   - command-palette/paletteCommands.ts  (navigate-* command dispatch)
 *   - command-palette/paletteAvailability.ts (worktree availability gating)
 *
 * B0 baseline: no seeding. No worktree is ever selected, which is exactly the
 * state that drives the availability-gating assertions below.
 */

/**
 * Opens the command palette via the global shortcut and asserts both testids
 * surfaced by CommandPalette.tsx are visible.
 */
async function openPalette(window) {
  await window.keyboard.press(PALETTE_SHORTCUT);
  await expect(window.getByTestId('command-palette')).toBeVisible();
  await expect(window.getByTestId('command-palette-input')).toBeVisible();
}

/**
 * Types a query into the palette input. The input is auto-focused on open,
 * but fill() targets it explicitly so the test does not depend on focus order.
 */
async function typeQuery(window, query) {
  await window.getByTestId('command-palette-input').fill(query);
}

let sharedPaletteHarness;

async function resetSharedPaletteHarness() {
  const { app, window } = sharedPaletteHarness;
  if ((await window.getByTestId('command-palette').count()) > 0) {
    await window.keyboard.press('Escape');
    await expect(window.getByTestId('command-palette')).toBeHidden();
  }
  await app.openMainPage();
}

async function getSharedPaletteHarness() {
  if (!sharedPaletteHarness) {
    const launched = await launchCanopy();
    const window = await launched.electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    sharedPaletteHarness = { ...launched, window, app };
  }
  await resetSharedPaletteHarness();
  return sharedPaletteHarness;
}

test.afterAll(async () => {
  if (sharedPaletteHarness) {
    await closeCanopy(
      sharedPaletteHarness.electronApp,
      sharedPaletteHarness.userDataDir,
    );
  }
});

test('runs navigate commands from the palette and changes the page', async ({}, testInfo) => {
  const { app, window } = await getSharedPaletteHarness();

  try {
    // Start from a known page so each navigation is an observable change.

    // navigate-audit -> page 'audit' (Enter on the selected option).
    await openPalette(window);
    await typeQuery(window, 'Audit trail');
    const auditOption = window.getByRole('option', {
      name: 'Open Audit trail',
    });
    await expect(auditOption).toBeVisible();
    await window.keyboard.press('Enter');
    // navigate commands return closePalette: true, so the palette dismisses.
    await expect(window.getByTestId('command-palette')).toBeHidden();
    await app.expectAuditPage();

    // navigate-usage -> page 'usage' (click the option directly).
    await openPalette(window);
    await typeQuery(window, 'Usage');
    const usageOption = window.getByRole('option', { name: 'Open Usage' });
    await expect(usageOption).toBeVisible();
    await usageOption.click();
    await expect(window.getByTestId('command-palette')).toBeHidden();
    await app.expectUsagePage();

    // navigate-statistics -> page 'statistics' (Enter on the selected option).
    await openPalette(window);
    await typeQuery(window, 'Statistics');
    const statsOption = window.getByRole('option', {
      name: 'Open Statistics',
    });
    await expect(statsOption).toBeVisible();
    await window.keyboard.press('Enter');
    await expect(window.getByTestId('command-palette')).toBeHidden();
    // Assert page-statistics directly. The shared expectStatisticsPage() helper
    // uses a non-exact 'Statistics' heading match that collides with the
    // "Today's statistics" subheading, so assert the page testid + exact title.
    await expect(window.getByTestId('page-statistics')).toBeVisible();
    await expect(
      window.getByRole('heading', { name: 'Statistics', exact: true }),
    ).toBeVisible();

    await window.screenshot({
      path: testInfo.outputPath('command-palette-navigate.png'),
    });
  } finally {
    await resetSharedPaletteHarness();
  }
});

test('executes the live query selection when Enter immediately follows fill', async () => {
  const { app, window } = await getSharedPaletteHarness();

  try {
    await openPalette(window);

    // Do not wait for an option assertion between the query update and Enter.
    // A deferred filter used to leave the palette rendering/selecting its old
    // first command here, so this sequence opened App Advisor instead of Usage.
    await typeQuery(window, 'Usage');
    await window.keyboard.press('Enter');

    await expect(window.getByTestId('command-palette')).toBeHidden();
    await app.expectUsagePage();
  } finally {
    await resetSharedPaletteHarness();
  }
});

test('gates worktree-only commands when no worktree is selected', async ({}, testInfo) => {
  const { window } = await getSharedPaletteHarness();

  try {
    // No worktree is selected in this B0 baseline. paletteAvailability.ts
    // filters out every command with requiresWorktree / requiresActiveChatTab,
    // so worktree-only commands must not render as options at all, while
    // always-available navigation commands stay present.
    await openPalette(window);

    // Every query below uses the commands-only '>' prefix
    // (paletteRanking.ts COMMANDS_ONLY_PREFIX): this spec asserts COMMAND
    // availability gating, and the unprefixed unified index also fuzzy-matches
    // non-command items. Plugin descriptions are indexed as subtitle fields
    // and can fuzzy-match command queries after marketplace ingest, causing a
    // Plugins row to suppress the "No results found" empty state. Commands-only
    // scoping keeps the gating assertions deterministic across description
    // changes.

    // Always-available command remains selectable.
    await typeQuery(window, '>Open Audit trail');
    await expect(
      window.getByRole('option', { name: 'Open Audit trail' }),
    ).toBeVisible();

    // requiresWorktree command — gated out entirely.
    // `>` limits results to commands so unrelated plugin matches stay out.
    await typeQuery(window, '>New tab');
    await expect(window.getByRole('option', { name: 'New tab' })).toHaveCount(
      0,
    );
    await expect(
      window.getByTestId('command-palette').getByText('No results found'),
    ).toBeVisible();

    // requiresWorktree command — gated out entirely.
    await typeQuery(window, '>Open Worktree Scripts');
    await expect(
      window.getByRole('option', { name: 'Open Worktree Scripts' }),
    ).toHaveCount(0);
    await expect(
      window.getByTestId('command-palette').getByText('No results found'),
    ).toBeVisible();

    // requiresWorktree + requiresActiveChatTab command — gated out entirely.
    await typeQuery(window, '>Close tab');
    await expect(window.getByRole('option', { name: 'Close tab' })).toHaveCount(
      0,
    );
    await expect(
      window.getByTestId('command-palette').getByText('No results found'),
    ).toBeVisible();

    await window.screenshot({
      path: testInfo.outputPath('command-palette-gated.png'),
    });

    // Esc dismisses the palette (CommandPalette.tsx handleKeyDown).
    await window.keyboard.press('Escape');
    await expect(window.getByTestId('command-palette')).toBeHidden();
  } finally {
    await resetSharedPaletteHarness();
  }
});
