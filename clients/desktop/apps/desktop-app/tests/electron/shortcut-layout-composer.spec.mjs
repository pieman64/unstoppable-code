// ECW-7984 follow-up — the second wave of hotkeys from Brady's review comment.
//
// SCOPE. `shortcut-context-new-tab.spec.mjs` already pins the original ⌘T /
// browser-chrome half. This file covers what that one does not:
//
//   1. ⌘/Ctrl+B toggles the left navigation sidebar, and keeps working while
//      a text field has focus (it runs before the editable-target guard, the
//      VS Code convention).
//   2. ⌘/Ctrl+← / → drive APP navigation history when the browser does NOT
//      own focus, mirroring the titlebar back/forward arrows.
//   3. Bare ⌥W opens the Home workspace picker with its search input focused,
//      so ↑/↓ walk the list.
//   4. Bare ⌥M opens the model picker, and ⌥T cycles the effort level.
//   5. The settings Shortcuts tab renders chords as discrete key caps rather
//      than one run-on string (the ⇧/⌘ glyph-sizing fix).
//
// PLATFORM NOTE on the ⌥ chords. On a real macOS keyboard Option+<letter>
// composes a character (⌥W → `∑`), so these chords are matched on physical
// `event.code` rather than `event.key` — see `isAltCodeShortcutEvent`.
// Playwright's `press('Alt+w')` synthesizes `code: 'KeyW'` with `altKey`,
// which is exactly the shape the handler keys off, so the same press
// exercises the real matcher on every platform.
//
// NOT COVERED (deliberately): ⌘⌥B "hide the right side panel" is not bound —
// the right-hand panel is a panel-grid GROUP and the legacy
// `activityStore.panelExpanded` flag it would otherwise target has no JSX
// consumer. See the note in `useGlobalShortcuts.ts`.

import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { seedPanelWorktree } from './panelHarness.mjs';

test.describe('layout + composer hotkeys (ECW-7984 follow-up)', () => {
  test.setTimeout(180_000);

  let sharedLayoutHarness;

  const resetSharedLayoutHarness = async () => {
    const { app, window } = sharedLayoutHarness;
    await window.keyboard.press('Escape');
    await app.openMainPage();
    await app.selectWorktree('demo-main');
    const sidebar = window.getByTestId('app-sidebar');
    if ((await sidebar.getAttribute('aria-hidden')) === 'true') {
      await window.keyboard.press('ControlOrMeta+b');
    }
    await expect(sidebar).toHaveAttribute('aria-hidden', 'false');
    const composer = window
      .locator('[data-testid="panel-content-chat"]:visible')
      .locator('[contenteditable="true"]')
      .first();
    if (await composer.isVisible().catch(() => false)) {
      await composer.fill('');
    }
  };

  const getSharedLayoutHarness = async () => {
    if (!sharedLayoutHarness) {
      sharedLayoutHarness = await seedPanelWorktree();
    }
    await resetSharedLayoutHarness();
    return sharedLayoutHarness;
  };

  const releaseSharedLayoutHarness = async () => {
    await resetSharedLayoutHarness();
  };

  const closeSharedLayoutHarness = async () => {
    if (!sharedLayoutHarness) {
      return;
    }
    const harness = sharedLayoutHarness;
    sharedLayoutHarness = undefined;
    await closeCanopy(harness.electronApp, harness.userDataDir);
  };

  test.afterAll(async () => {
    await closeSharedLayoutHarness();
  });

  test('Cmd/Ctrl+B toggles the sidebar, including while typing', async () => {
    const { window } = await getSharedLayoutHarness();

    try {
      const sidebar = window.getByTestId('app-sidebar');
      await expect(sidebar).toBeVisible();

      // The aside animates between `width: 0` and its real width and carries
      // `aria-hidden`, so the attribute is the stable signal (a width poll
      // would race the transition).
      await expect(sidebar).toHaveAttribute('aria-hidden', 'false');

      await window.keyboard.press('ControlOrMeta+b');
      await expect(sidebar).toHaveAttribute('aria-hidden', 'true');
      await expect
        .poll(async () => (await sidebar.boundingBox())?.width ?? -1, {
          timeout: 10_000,
        })
        .toBe(0);

      await window.keyboard.press('ControlOrMeta+b');
      await expect(sidebar).toHaveAttribute('aria-hidden', 'false');
      await expect
        .poll(async () => (await sidebar.boundingBox())?.width ?? 0, {
          timeout: 10_000,
        })
        .toBeGreaterThan(0);

      // Focus the chat composer and repeat: the chord runs BEFORE the
      // editable-target guard, so it must still fire from inside a text
      // field and must not type a "b" into the composer.
      const composer = window
        .locator('[data-testid="panel-content-chat"]:visible')
        .locator('[contenteditable="true"]')
        .first();
      await composer.click();
      await expect(composer).toBeFocused();

      await window.keyboard.press('ControlOrMeta+b');
      await expect(sidebar).toHaveAttribute('aria-hidden', 'true');
      await expect(composer).not.toContainText('b');

      await window.keyboard.press('ControlOrMeta+b');
      await expect(sidebar).toHaveAttribute('aria-hidden', 'false');
    } finally {
      await releaseSharedLayoutHarness();
    }
  });

  test('Cmd/Ctrl+Arrow drives app navigation history outside the browser', async () => {
    const { window } = await getSharedLayoutHarness();

    try {
      // Build real app history: Audit → Usage.
      await window.keyboard.press('ControlOrMeta+6');
      await expect(window.getByTestId('page-audit')).toBeVisible();
      await window.keyboard.press('ControlOrMeta+7');
      await expect(window.getByTestId('page-usage')).toBeVisible();

      // Back — no browser surface owns focus, so this is APP history.
      await window.keyboard.press('ControlOrMeta+ArrowLeft');
      await expect(window.getByTestId('page-audit')).toBeVisible();

      // Forward returns to Usage.
      await window.keyboard.press('ControlOrMeta+ArrowRight');
      await expect(window.getByTestId('page-usage')).toBeVisible();

      // Forward again with nothing ahead is a safe no-op, not a crash or a
      // stray navigation.
      await window.keyboard.press('ControlOrMeta+ArrowRight');
      await window.waitForTimeout(300);
      await expect(window.getByTestId('page-usage')).toBeVisible();
    } finally {
      await releaseSharedLayoutHarness();
    }
  });

  test('Option+W opens the Home project picker focused for arrow keys', async () => {
    const { window } = await getSharedLayoutHarness();

    try {
      // ⌘N is the documented route to the new-task Home surface (ECW-7984).
      await window.keyboard.press('ControlOrMeta+n');
      const homePage = window.getByTestId('page-home');
      await expect(homePage).toBeVisible();
      await expect(homePage.getByTestId('home-workspace-select')).toBeVisible();

      // Closed to start — the mount-time openSignal must not auto-open it.
      await expect(window.getByTestId('home-workspace-popover')).toHaveCount(0);

      await window.keyboard.press('Alt+w');

      const popover = window.getByTestId('home-workspace-popover');
      await expect(popover).toBeVisible();
      // "focused so you can up/down thru the list": opening focuses the
      // search input, which owns the ArrowUp/ArrowDown traversal.
      await expect(window.getByTestId('home-workspace-search')).toBeFocused();
      await window.keyboard.press('ArrowDown');
      await expect(popover).toBeVisible();

      await window.keyboard.press('Escape');
      await expect(popover).toHaveCount(0);
    } finally {
      await releaseSharedLayoutHarness();
    }
  });

  test('Option+M opens the model picker and Option+T cycles effort', async () => {
    const { window } = await getSharedLayoutHarness();

    try {
      await window.keyboard.press('ControlOrMeta+n');
      const homePage = window.getByTestId('page-home');
      await expect(homePage).toBeVisible();

      const modelPicker = homePage.getByTestId('chat-model-picker');
      await expect(modelPicker).toBeVisible();
      await expect(window.getByTestId('chat-model-menu')).toHaveCount(0);

      await window.keyboard.press('Alt+m');
      await expect(window.getByTestId('chat-model-menu')).toBeVisible();
      await window.keyboard.press('Escape');
      await expect(window.getByTestId('chat-model-menu')).toHaveCount(0);

      // ⌥T cycles the effort level. The effort trigger's aria-label carries
      // the current level, so a change there is the observable effect.
      const effortButton = homePage.getByTestId('home-thinking-level-button');
      await expect(effortButton).toBeVisible();
      const before = await effortButton.getAttribute('aria-label');

      await window.keyboard.press('Alt+t');
      await expect
        .poll(() => effortButton.getAttribute('aria-label'), {
          timeout: 10_000,
        })
        .not.toBe(before);
    } finally {
      await releaseSharedLayoutHarness();
    }
  });

  test('Option+W returns focus to the composer on commit and the trigger on dismiss', async () => {
    const { window } = await getSharedLayoutHarness();

    try {
      await window.keyboard.press('ControlOrMeta+n');
      const homePage = window.getByTestId('page-home');
      await expect(homePage).toBeVisible();

      const composer = homePage.getByTestId('home-composer-editor');
      await expect(composer).toBeVisible();

      // ⌥W then Enter (commit) — the caret must come back to the prompt so
      // typing continues where the user left off rather than going nowhere.
      await window.keyboard.press('Alt+w');
      await expect(window.getByTestId('home-workspace-search')).toBeFocused();
      await window.keyboard.press('Enter');
      await expect(window.getByTestId('home-workspace-popover')).toHaveCount(0);
      await expect(composer).toBeFocused();

      // ⌥W then Escape (dismiss) — the shared workspace combobox follows the
      // standard dismissal contract and restores focus to its trigger.
      await window.keyboard.press('Alt+w');
      await expect(window.getByTestId('home-workspace-search')).toBeFocused();
      await window.keyboard.press('Escape');
      await expect(window.getByTestId('home-workspace-popover')).toHaveCount(0);
      await expect(window.getByTestId('home-workspace-select')).toBeFocused();

      // ⌥M then Escape — the model picker rides FloatingMenu, which focuses
      // the composer hand-off after the trigger focus settles.
      await window.keyboard.press('Alt+m');
      await expect(window.getByTestId('chat-model-menu')).toBeVisible();
      await window.keyboard.press('Escape');
      await expect(window.getByTestId('chat-model-menu')).toHaveCount(0);
      await expect(composer).toBeFocused();

      // The caret is live, not just the focus ring: typing lands in the prompt.
      await window.keyboard.type('hello');
      await expect(composer).toContainText('hello');
    } finally {
      await releaseSharedLayoutHarness();
    }
  });

  test('Home shortcuts target only the visible composer when no worktree is selected', async () => {
    // This case owns a separately seeded app. Close the reusable harness first
    // so two Electron instances cannot compete for renderer shortcut routing.
    await closeSharedLayoutHarness();

    const { electronApp, userDataDir } = await launchCanopy({
      seedDemoWorkspaces: true,
      demoWorkspaceApps: ['ts-pnpm-vite'],
    });

    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell({ timeout: 30_000 });

      // No worktree has been selected, so MainPage's embedded Home surface
      // remains mounted when the standalone Home page opens.
      await window.getByTestId('sidebar-create-task').click();
      const homePage = window.getByTestId('page-home');
      await expect(homePage).toBeVisible();
      await expect(window.getByTestId('home-surface')).toHaveCount(2);

      const effortButton = homePage.getByTestId('home-thinking-level-button');
      await expect(effortButton).toHaveAttribute(
        'aria-label',
        'Effort, current level High',
      );

      await window.keyboard.press('Alt+t');
      await expect(effortButton).toHaveAttribute(
        'aria-label',
        'Effort, current level Extra High',
      );

      // This case validates routing when two Home surfaces are mounted. The
      // dedicated Option+W tests above retain Playwright's native key press;
      // dispatch the exact renderer event here so a busy CI host cannot lose
      // the second synthesized Option chord before Chromium receives it.
      const workspaceShortcutClaimed = await window.evaluate(() => {
        const event = new KeyboardEvent('keydown', {
          key: '∑',
          code: 'KeyW',
          altKey: true,
          bubbles: true,
          cancelable: true,
        });
        window.dispatchEvent(event);
        return event.defaultPrevented;
      });
      expect(workspaceShortcutClaimed).toBe(true);
      await expect(window.getByTestId('home-workspace-popover')).toHaveCount(1);
      await expect(window.getByTestId('home-workspace-popover')).toBeVisible();
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test('the settings Shortcuts tab renders chords as discrete key caps', async () => {
    const { window } = await getSharedLayoutHarness();

    try {
      await window.keyboard.press('ControlOrMeta+Shift+k');
      const tab = window.getByTestId('settings-tab-shortcuts');
      await expect(tab).toBeVisible();

      // The glyph fix renders each key in its own <kbd> instead of one
      // run-on `font-mono` string, which is what let ⇧/⌘ render hairline-thin.
      const chords = tab.getByTestId('shortcut-keys');
      await expect(chords.first()).toBeVisible();

      // The command-palette row is ⌘K / Ctrl K — two caps either way.
      const paletteRow = tab.getByTestId('shortcut-row-open-command-palette');
      await expect(paletteRow).toContainText('Open command palette');
      await expect(paletteRow.getByTestId('shortcut-keys')).toBeVisible();
      await expect(paletteRow.locator('kbd')).toHaveCount(2);

      // The new Layout section documents ⌘B.
      await expect(tab.getByText('Toggle sidebar')).toBeVisible();
      // ...and the Composer section documents the ⌥ chords.
      await expect(tab.getByText('Open project picker')).toBeVisible();
      await expect(tab.getByText('Open model picker')).toBeVisible();
      await expect(tab.getByText('Cycle effort level')).toBeVisible();
    } finally {
      await releaseSharedLayoutHarness();
    }
  });
});
