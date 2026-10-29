import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { launchCanopyWithLabsPagesOffered } from './helpers/labsPages.mjs';
import { closeCanopy } from './launchCanopy.mjs';
import { readMainWindowZoomFactor } from './uiScale.mjs';

async function chooseInterfaceScale(window, scale) {
  await window.getByTestId('settings-ui-scale-select').click();
  await window.getByTestId(`settings-ui-scale-option-${scale}`).click();
}

/**
 * Doc 3 gap G3 — Display theme / color-mode / UI-scale / workspace layout
 * apply + persist.
 *
 * The Display settings tab mutates CSS-variable-driven theming directly on
 * <html>: `data-theme="<name>"`, the `dark` class, and `data-ui-scale="<N>"`
 * (see `settings/DisplayTab.tsx` + `lib/theme.ts`). The UI scale itself is a
 * uniform Electron zoom owned by the main process (`main/lib/ui-zoom.ts`):
 * saving `uiScale` sets `webContents.setZoomFactor(uiScale / 100)` on every
 * app window, and the renderer republishes the live zoom as `--ui-zoom` plus
 * a one-device-pixel `--border-hairline`. This spec drives those controls,
 * asserts the DOM mutations and the zoom, then relaunches reusing the same
 * userDataDir to confirm the persisted preferences reapply on startup.
 */

/**
 * A segmented picker raises its chosen segment on one surface that slides
 * between segments: it carries the shadow ring and settles under the segment.
 */
async function expectRaisedUnder(segment) {
  const surface = segment.locator(
    'xpath=ancestor::*[@role="group"][1]/span[@aria-hidden="true"]',
  );
  expect(
    await surface.evaluate((element) => getComputedStyle(element).boxShadow),
  ).not.toBe('none');
  await expect
    .poll(async () => {
      const [under, target] = await Promise.all([
        surface.boundingBox(),
        segment.boundingBox(),
      ]);
      return (
        Math.abs(under.x - target.x) + Math.abs(under.width - target.width)
      );
    })
    .toBeLessThan(1);
}

function readHtmlState(window) {
  return window.evaluate(() => {
    const html = document.documentElement;
    return {
      theme: html.getAttribute('data-theme'),
      uiScale: html.getAttribute('data-ui-scale'),
      scrollbarBehavior: html.getAttribute('data-scrollbar-behavior'),
      dark: html.classList.contains('dark'),
    };
  });
}

/**
 * The main window's minimum size and the work area of its display. The
 * minimum is `800 x 500 x zoom`, capped to that work area.
 */
function readMainWindowMinimum(electronApp) {
  return electronApp.evaluate(({ BrowserWindow, screen }) => {
    const [mainWindow] = BrowserWindow.getAllWindows();
    if (!mainWindow) return null;
    const { workArea } = screen.getDisplayMatching(mainWindow.getBounds());
    return {
      size: mainWindow.getMinimumSize(),
      workArea: { width: workArea.width, height: workArea.height },
    };
  });
}

function expectedMinimum(workArea, zoom) {
  return [
    Math.min(Math.ceil(800 * zoom), workArea.width),
    Math.min(Math.ceil(500 * zoom), workArea.height),
  ];
}

/**
 * The native scale factor of the display hosting the main window. The hidden
 * E2E window can re-associate with a Retina display mid-run (its reported
 * devicePixelRatio jumps 1 → 2 on the first compositor frame), so on-screen
 * growth is asserted relative to this rather than to a fixed constant.
 */
function readNativeScaleFactor(electronApp) {
  return electronApp.evaluate(({ BrowserWindow, screen }) => {
    const [mainWindow] = BrowserWindow.getAllWindows();
    if (!mainWindow) return null;
    return screen.getDisplayMatching(mainWindow.getBounds()).scaleFactor;
  });
}

/**
 * On-screen geometry of the UI-scale dropdown (a fixed 28px-tall control) and
 * the surrounding hairline metrics, all expressed in DEVICE pixels via the
 * renderer's live `devicePixelRatio`, which includes the page zoom.
 */
function readScaleMetrics(window) {
  return window.evaluate(() => {
    const dpr = window.devicePixelRatio;
    const slider = document.querySelector(
      '[data-testid="settings-ui-scale-select"]',
    );
    const sliderBox = slider?.getBoundingClientRect();
    // The first row of a settings group carries the hairline that splits it
    // from the next row.
    const divider = document.querySelector(
      '[data-testid="settings-tab-display"] .divide-y > :first-child',
    );
    const rootStyle = getComputedStyle(document.documentElement);
    return {
      devicePixelRatio: dpr,
      innerWidth: window.innerWidth,
      controlDeviceHeight: sliderBox ? sliderBox.height * dpr : null,
      controlCssHeight: sliderBox ? sliderBox.height : null,
      hairlineCss: Number.parseFloat(
        rootStyle.getPropertyValue('--border-hairline'),
      ),
      dividerBorderCss: divider
        ? Number.parseFloat(getComputedStyle(divider).borderBottomWidth)
        : null,
      uiZoom: rootStyle.getPropertyValue('--ui-zoom').trim(),
    };
  });
}

/**
 * Geometry of the expanded sidebar's titlebar row: the corner spacer, the
 * status area beside it, and the panel that holds both, all in CSS px.
 */
function readSidebarTitlebarGeometry(window) {
  return window.evaluate(() => {
    const widthOf = (element) =>
      element ? element.getBoundingClientRect().width : null;
    const row = document.querySelector('[data-testid="sidebar-titlebar"]');
    const status = document.querySelector(
      '[data-testid="sidebar-titlebar-resource-monitor"]',
    );
    return {
      panelWidth: widthOf(
        document.querySelector('[data-testid="sidebar-panel"]'),
      ),
      cornerWidth: widthOf(row?.firstElementChild),
      statusWidth: widthOf(status),
    };
  });
}

/**
 * Vertical centres, in PHYSICAL (logical/DIP) px from the window top, of
 * everything that shares the titlebar row's centre line with the macOS
 * traffic lights. The lights are fixed-size OS chrome the page zoom cannot
 * move: inside the 67.65–164.29% band they stay at `{x:16, y:16}` (centre 23)
 * and the renderer's controls follow them; outside it the row's centre gives
 * way and main moves the lights onto it (`macWindowButtonPosition`).
 *
 * Measured from `getBoundingClientRect()` (CSS px) times the live `--ui-zoom`
 * so the numbers are directly comparable with the native buttons, which
 * Playwright cannot see — they are NSWindow chrome outside the web contents.
 */
function readTitlebarRowCenters(window) {
  return window.evaluate(() => {
    const zoom =
      Number.parseFloat(
        getComputedStyle(document.documentElement).getPropertyValue(
          '--ui-zoom',
        ),
      ) || 1;
    const centerOf = (selector) => {
      const element = document.querySelector(selector);
      if (!element) return null;
      const rect = element.getBoundingClientRect();
      return (rect.top + rect.height / 2) * zoom;
    };
    const heightOf = (selector) => {
      const element = document.querySelector(selector);
      return element ? element.getBoundingClientRect().height : null;
    };
    return {
      zoom,
      toggle: centerOf('[data-testid="sidebar-toggle"]'),
      back: centerOf('[data-testid="nav-history-back"]'),
      forward: centerOf('[data-testid="nav-history-forward"]'),
      resource: centerOf('[data-testid="sidebar-resource-diagnostics-pill"]'),
      // Outer heights stay in CSS px: the rows must keep zooming with the
      // rest of the UI so content below the titlebar never moves.
      cornerHeight: heightOf('[data-testid="app-titlebar-corner"]'),
      sidebarTitlebarHeight: heightOf('[data-testid="sidebar-titlebar"]'),
      toggleHeight: heightOf('[data-testid="sidebar-toggle"]'),
    };
  });
}

/**
 * Centre, in window points, of the main window's live macOS traffic lights:
 * `getWindowButtonPosition()` is the top-left of the 14pt button frame.
 */
function readTrafficLightsCenter(electronApp) {
  return electronApp.evaluate(({ BrowserWindow }) => {
    const [mainWindow] = BrowserWindow.getAllWindows();
    const position = mainWindow?.getWindowButtonPosition?.();
    return position ? position.y + 14 / 2 : null;
  });
}

/**
 * Asserts every titlebar-row control sits on the live traffic lights' centre
 * line and that both rows kept their 40 CSS px outer height.
 */
async function expectTitlebarRowOnTrafficLights(window, electronApp, label) {
  const centers = await readTitlebarRowCenters(window);
  const lights = await readTrafficLightsCenter(electronApp);
  const measured = { label, lights, ...centers };
  expect(lights, `traffic lights ${label}`).not.toBeNull();
  expect(centers.toggle, `toggle centre ${label}`).not.toBeNull();
  for (const key of ['toggle', 'back', 'forward', 'resource']) {
    if (centers[key] === null) continue;
    // Lights sit on whole points, so allow the half point of rounding.
    expect(
      Math.abs(centers[key] - lights),
      `${key} centre ${label}: ${JSON.stringify(measured)}`,
    ).toBeLessThanOrEqual(0.5);
  }
  expect(centers.cornerHeight, `corner height ${label}`).toBeCloseTo(40, 1);
  expect(
    centers.sidebarTitlebarHeight,
    `sidebar titlebar height ${label}`,
  ).toBeCloseTo(40, 1);
  return measured;
}

/** Computed left padding (CSS px) of the persistent macOS titlebar corner. */
function readTitlebarCornerPadding(window) {
  return window.evaluate(() => {
    const corner = document.querySelector(
      '[data-testid="app-titlebar-corner"]',
    );
    return corner
      ? Number.parseFloat(getComputedStyle(corner).paddingLeft)
      : null;
  });
}

function git(cwd, ...args) {
  execFileSync('git', args, { cwd, stdio: 'pipe' });
}

function seedLargeDiff(userDataDir) {
  const seed = seedDemoWorkspaces({
    userDataDir,
    apps: ['ts-pnpm-vite'],
    checkRuntimes: false,
  });
  const { repoPath, worktreePath } = seed.workspaces[0] ?? {};
  if (!repoPath || !worktreePath) {
    throw new Error('Missing seeded repo/worktree for Display settings');
  }

  const deletedFile = 'DISPLAY_DIFF_DELETED.txt';
  const addedFile = 'DISPLAY_DIFF_ADDED.txt';
  const lines = (count, prefix) =>
    Array.from({ length: count }, (_, index) => `${prefix} ${index + 1}`).join(
      '\n',
    );
  writeFileSync(
    path.join(repoPath, deletedFile),
    `${lines(12_345, 'deleted line')}\n`,
    'utf8',
  );
  git(repoPath, 'add', deletedFile);
  git(
    repoPath,
    '-c',
    'user.name=Canopy Test',
    '-c',
    'user.email=canopy@example.test',
    'commit',
    '-m',
    'Display diff-stats baseline',
  );
  git(worktreePath, 'merge', '--ff-only', 'main');
  rmSync(path.join(worktreePath, deletedFile), { force: true });
  writeFileSync(
    path.join(worktreePath, addedFile),
    lines(1_234, 'added line'),
    'utf8',
  );
}

test('Interface scale dropdown scrolls, applies zoom, resets and keeps its saved choice', async () => {
  const launched = await launchCanopyWithLabsPagesOffered();
  try {
    const window = await launched.electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await app.openSettings();
    await app.openSettingsSection('display');
    const scale = window.getByTestId('settings-ui-scale-select');
    const section = window
      .getByTestId('settings-tab-display')
      .locator('section')
      .filter({
        has: window.getByRole('heading', { name: 'Appearance', exact: true }),
      });
    const rowHeights = await section
      .locator('[data-settings-row-label]')
      .evaluateAll((labels) =>
        labels.map(
          (label) =>
            label.parentElement.parentElement.getBoundingClientRect().height,
        ),
      );
    expect(
      Math.max(...rowHeights) - Math.min(...rowHeights),
    ).toBeLessThanOrEqual(1);
    await scale.click();
    const menu = window.getByRole('listbox', { name: 'Interface scale' });
    await expect(menu.getByRole('option')).toHaveCount(31);
    // A trackpad wheel must move the menu, not get trapped in a nested list.
    const viewport = menu.locator(
      '[data-floating-menu-scroll-viewport="true"]',
    );
    await expect(viewport).toHaveCount(1);
    const beforeWheel = await viewport.evaluate((element) => element.scrollTop);
    const menuBox = await menu.boundingBox();
    await window.mouse.move(
      menuBox.x + menuBox.width / 2,
      menuBox.y + menuBox.height / 2,
    );
    await window.mouse.wheel(0, 240);
    await expect
      .poll(() => viewport.evaluate((element) => element.scrollTop))
      .toBeGreaterThan(beforeWheel);
    await expect(menu).toBeVisible();
    await expect(scale).toContainText('100%');

    await window.keyboard.press('End');
    await expect(
      window.getByTestId('settings-ui-scale-option-200'),
    ).toBeFocused();
    const bounds = await menu.boundingBox();
    expect(bounds.height).toBeLessThanOrEqual(208);
    const thumb = await menu
      .locator('[data-overlay-scrollbar-thumb]')
      .boundingBox();
    expect(
      bounds.y + bounds.height - (thumb.y + thumb.height),
    ).toBeGreaterThanOrEqual(7);
    expect(
      bounds.x + bounds.width - (thumb.x + thumb.width),
    ).toBeGreaterThanOrEqual(5);
    await window.keyboard.press('Home');
    await expect(
      window.getByTestId('settings-ui-scale-option-50'),
    ).toBeFocused();
    const firstThumb = await menu
      .locator('[data-overlay-scrollbar-thumb]')
      .boundingBox();
    expect(firstThumb.y - bounds.y).toBeGreaterThanOrEqual(7);
    await window.keyboard.press('Escape');
    await expect(scale).toBeFocused();
    await chooseInterfaceScale(window, 125);
    await expect
      .poll(() => readMainWindowZoomFactor(launched.electronApp))
      .toBe(1.25);
    await expect(scale).toContainText('125%');
    await window.getByTestId('settings-ui-scale-reset').click();
    await expect
      .poll(() => readMainWindowZoomFactor(launched.electronApp))
      .toBe(1);
    await chooseInterfaceScale(window, 95);
    await expect
      .poll(
        async () =>
          (await window.evaluate(() => window.api.loadPreferences())).uiScale,
      )
      .toBe(95);
    await app.closeSettings();
    await app.openSettings();
    await app.openSettingsSection('display');
    await expect(scale).toContainText('95%');
    await window.getByTestId('settings-ui-scale-reset').click();
  } finally {
    await closeCanopy(launched.electronApp, launched.userDataDir);
  }
});

test('Appearance controls align, keep the theme dot inset evenly and use text-only Sidebar options', async () => {
  const launched = await launchCanopyWithLabsPagesOffered();
  try {
    const page = await launched.electronApp.firstWindow();
    const app = new CanopyAppDriver(page);
    await app.waitForShell();
    await app.openSettings();
    await app.openSettingsSection('display');
    const ids = [
      'settings-color-mode-select',
      'settings-theme-select',
      'sidebar-style-picker',
      'settings-ui-scale-select',
      'settings-scrollbar-behavior',
    ];
    const boxes = await Promise.all(
      ids.map((id) => page.getByTestId(id).boundingBox()),
    );
    for (const box of boxes) {
      expect(box.width).toBeCloseTo(boxes[0].width, 1);
      expect(box.x + box.width).toBeCloseTo(boxes[0].x + boxes[0].width, 1);
    }
    const trigger = page.getByTestId('settings-theme-select');
    const dot = trigger.locator('[data-testid^="theme-color-dot-"]');
    const [frame, marker] = await Promise.all([
      trigger.boundingBox(),
      dot.boundingBox(),
    ]);
    const themeLabel = await trigger.locator('span').last().boundingBox();
    expect(themeLabel.x - marker.x - marker.width).toBeCloseTo(10, 1);
    for (const control of [
      page.getByRole('group', { name: 'Project layout', exact: true }),
      page.getByRole('group', { name: 'Worktree diff stats', exact: true }),
    ]) {
      const box = await control.boundingBox();
      expect(box.width).toBeCloseTo(208, 1);
    }
    for (const label of ['Linear chat enrichment', 'GitHub chat enrichment']) {
      await expect(page.getByRole('combobox', { name: label })).toHaveCSS(
        'width',
        '144px',
      );
    }
    expect(boxes[0].width).toBeCloseTo(144, 1);
    expect(marker.width).toBeCloseTo(6, 1);
    expect(marker.height).toBeCloseTo(6, 1);
    const inset = marker.x - frame.x;
    expect(marker.y - frame.y).toBeCloseTo(inset, 1);
    expect(frame.y + frame.height - marker.y - marker.height).toBeCloseTo(
      inset,
      1,
    );
    await page.getByTestId('sidebar-style-picker').click();
    const menu = page.getByRole('listbox', { name: 'Sidebar style' });
    await expect(menu.getByRole('option')).toHaveCount(2);
    await expect(
      menu.locator('[data-testid^="sidebar-style-preview-"]'),
    ).toHaveCount(0);
    await expect(menu.locator('[data-overlay-scroll-area]')).toHaveCount(1);
    await page.keyboard.press('Escape');
  } finally {
    await closeCanopy(launched.electronApp, launched.userDataDir);
  }
});

test('Appearance dropdowns support keyboard selection and persist theme and color mode', async () => {
  const launched = await launchCanopyWithLabsPagesOffered();
  try {
    const window = await launched.electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await app.openSettings();
    await app.openSettingsSection('display');
    const theme = window.getByTestId('settings-theme-select');
    await theme.click();
    await expect(
      window.getByRole('listbox', { name: 'Theme' }).getByRole('option'),
    ).toHaveCount(8);
    await window.getByTestId('theme-swatch-ocean').click();
    await expect(window.locator('html')).toHaveAttribute('data-theme', 'ocean');
    await expect(theme).toBeFocused();
    await theme.press('ArrowDown');
    await expect(window.getByRole('listbox', { name: 'Theme' })).toBeVisible();
    await window.keyboard.press('Escape');
    await expect(theme).toBeFocused();
    const mode = window.getByTestId('settings-color-mode-select');
    await mode.click();
    await window.getByTestId('color-mode-dark').click();
    await expect(window.locator('html')).toHaveClass(/dark/);
    await expect
      .poll(async () => {
        const preferences = await window.evaluate(() =>
          window.api.loadPreferences(),
        );
        return { theme: preferences.theme, colorMode: preferences.colorMode };
      })
      .toEqual({ theme: 'ocean', colorMode: 'dark' });
    await app.closeSettings();
    await app.openSettings();
    await app.openSettingsSection('display');
    await expect(theme).toContainText('Ocean');
    await expect(mode).toContainText('Dark');
  } finally {
    await closeCanopy(launched.electronApp, launched.userDataDir);
  }
});

test('Display theme/color-mode/UI-scale and diff stats apply and persist across relaunch', async ({}, testInfo) => {
  test.setTimeout(240_000);
  // First launch: change theme, color mode, and UI scale.
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-electron-display-theme-'),
  );
  seedLargeDiff(userDataDir);
  const first = await launchCanopyWithLabsPagesOffered({ userDataDir });

  let appliedScale;

  try {
    const window = await first.electronApp.firstWindow();
    const app = new CanopyAppDriver(window);

    await app.waitForShell();
    await app.openMainPage();
    const worktreeRow = window
      .locator('[data-testid="worktree-row"][data-branch="demo-main"]')
      .first();
    const diffStatsBadge = worktreeRow.getByTestId('diff-stats-badge');
    await expect(diffStatsBadge).toHaveText('+1k-12k', { timeout: 60_000 });
    await app.openSettings();
    await app.openSettingsSection('display');
    await app.expectSettingsSection('display');

    const displayRowLabels = await window
      .getByTestId('settings-tab-display')
      .locator('[data-settings-row-label]')
      .allTextContents();
    expect(displayRowLabels.indexOf('Sidebar style')).toBeGreaterThanOrEqual(0);
    expect(displayRowLabels.indexOf('Sidebar style')).toBeLessThan(
      displayRowLabels.indexOf('Project layout'),
    );
    expect(displayRowLabels.indexOf('Scrollbars')).toBeLessThan(
      displayRowLabels.indexOf('Worktree diff stats'),
    );
    expect(displayRowLabels.slice(-4)).toEqual([
      'Worktree diff stats',
      'Linear',
      'GitHub',
      'How it works',
    ]);
    // Every settings page shares one 640px content column: the title,
    // section headings, and grouped boxes all span it.
    const contentWidths = await window
      .getByTestId('settings-tab-display')
      .evaluate((page) => ({
        header:
          page.querySelector('header')?.getBoundingClientRect().width ?? 0,
        group:
          page.querySelector('.divide-y')?.getBoundingClientRect().width ?? 0,
      }));
    expect(contentWidths.header).toBeCloseTo(640, 0);
    expect(contentWidths.group).toBeCloseTo(640, 0);
    // Standard inset Settings clips its own scroll region; the page title
    // starts below the inset header without the retired flat-layout mask.
    const scrollGeometry = await window
      .getByTestId('settings-content')
      .evaluate((content) => {
        const scroller = content.querySelector('.overflow-auto');
        const style = scroller ? getComputedStyle(scroller) : null;
        return {
          scrollerOffset: scroller
            ? scroller.getBoundingClientRect().top -
              content.getBoundingClientRect().top
            : -1,
          titleOffset:
            (content.querySelector('h1')?.getBoundingClientRect().top ?? -1) -
            content.getBoundingClientRect().top,
          mask: style?.maskImage || style?.webkitMaskImage || '',
        };
      });
    expect(scrollGeometry.scrollerOffset).toBe(0);
    expect(scrollGeometry.titleOffset).toBeCloseTo(56, 0);
    expect(scrollGeometry.mask).toBe('none');
    // The group's inset hairline splits the diff stats row from Scrollbars.
    const diffStatsSeparator = await window
      .getByTestId('worktree-diff-stats-section')
      .evaluate((element) => {
        const above = element.previousElementSibling;
        if (!(above instanceof HTMLElement)) {
          return { width: 0, style: 'none', color: 'rgba(0, 0, 0, 0)' };
        }
        const style = getComputedStyle(above);
        return {
          width: Number.parseFloat(style.borderBottomWidth),
          style: style.borderBottomStyle,
          color: style.borderBottomColor,
        };
      });
    expect(diffStatsSeparator.width).toBeGreaterThan(0);
    expect(diffStatsSeparator.style).toBe('solid');
    expect(diffStatsSeparator.color).not.toBe('rgba(0, 0, 0, 0)');
    const completeDiffStats = window.getByTestId(
      'worktree-diff-stats-style-complete',
    );
    const shortDiffStats = window.getByTestId(
      'worktree-diff-stats-style-short',
    );
    await expect(completeDiffStats).toHaveAttribute('aria-pressed', 'false');
    await completeDiffStats.click();
    await expect(completeDiffStats).toHaveAttribute('aria-pressed', 'true');
    // The chosen segment sits on the one raised surface, which slides under
    // it; the segments themselves rest flat on the track.
    await expectRaisedUnder(completeDiffStats);
    expect(
      await shortDiffStats.evaluate(
        (element) => getComputedStyle(element).boxShadow,
      ),
    ).toBe('none');
    await expect(diffStatsBadge).toHaveText('+1234-12345');

    await app.closeSettings();
    await app.openSettings();
    await app.openSettingsSection('display');
    await expect(completeDiffStats).toHaveAttribute('aria-pressed', 'true');
    const selectedLayout = window.getByTestId(
      'workspace-layout-default-advanced',
    );
    await expect(selectedLayout).toHaveAttribute('aria-pressed', 'true');
    await expectRaisedUnder(selectedLayout);
    const selectedLayoutBorder = await selectedLayout.evaluate((element) => {
      const lineBaseProbe = document.createElement('div');
      lineBaseProbe.style.color = 'var(--line-base)';
      document.body.append(lineBaseProbe);
      const lineBaseColor = getComputedStyle(lineBaseProbe).color;
      lineBaseProbe.remove();
      return {
        actual: getComputedStyle(element).borderTopColor,
        expected: lineBaseColor,
      };
    });
    expect(selectedLayoutBorder.actual).toBe(selectedLayoutBorder.expected);

    // Baseline: default theme leaves no data-theme attribute.
    const baseline = await readHtmlState(window);
    expect(baseline.theme).toBeNull();
    expect(baseline.scrollbarBehavior).toBe('system');

    const scrollbarSelect = window.getByTestId('settings-scrollbar-behavior');
    await scrollbarSelect.selectOption('hover');
    await expect
      .poll(() =>
        readHtmlState(window).then((state) => state.scrollbarBehavior),
      )
      .toBe('hover');

    const nativeScroller = window.locator(
      '[data-testid="settings-content"] > .overflow-auto',
    );
    await expect(nativeScroller).toBeVisible();
    await window.mouse.move(0, 0);
    await expect
      .poll(() =>
        nativeScroller.evaluate(
          (element) =>
            getComputedStyle(element, '::-webkit-scrollbar-thumb')
              .backgroundColor,
        ),
      )
      .toBe('rgba(0, 0, 0, 0)');
    await nativeScroller.hover();
    await expect
      .poll(() =>
        nativeScroller.evaluate(
          (element) =>
            getComputedStyle(element, '::-webkit-scrollbar-thumb')
              .backgroundColor,
        ),
      )
      .not.toBe('rgba(0, 0, 0, 0)');

    await scrollbarSelect.selectOption('scroll');
    await nativeScroller.evaluate((element) => {
      element.dispatchEvent(new Event('scroll'));
    });
    await expect(nativeScroller).toHaveAttribute(
      'data-native-scrollbar-scrolling',
      'true',
    );

    await scrollbarSelect.selectOption('hover');

    // Theme dropdown: choose Cobalt and persist its underlying theme value.
    await window.getByTestId('settings-theme-select').click();
    await window.getByTestId('theme-swatch-unstoppable').click();
    await expect
      .poll(() => readHtmlState(window).then((s) => s.theme))
      .toBe('unstoppable');

    // Color mode dropdown: choose dark.
    await window.getByTestId('settings-color-mode-select').click();
    await window.getByTestId('color-mode-dark').click();
    await expect
      .poll(() => readHtmlState(window).then((s) => s.dark))
      .toBe(true);

    // Scale choices preserve uniform Electron zoom and one-device-pixel hairlines.
    const scaleControl = window.getByTestId('settings-ui-scale-select');
    await expect(scaleControl).toBeVisible();

    const before = await readHtmlState(window);
    expect(before.uiScale).toBe('100');
    expect(await readMainWindowZoomFactor(first.electronApp)).toBe(1);
    const minimumBefore = await readMainWindowMinimum(first.electronApp);
    expect(minimumBefore.size).toEqual(
      expectedMinimum(minimumBefore.workArea, 1),
    );
    const nativeScaleBefore = await readNativeScaleFactor(first.electronApp);
    const metricsBefore = await readScaleMetrics(window);
    expect(metricsBefore.controlCssHeight).toBe(28);

    const targetScale = 150;
    await chooseInterfaceScale(window, targetScale);

    await expect
      .poll(() => readHtmlState(window).then((s) => s.uiScale))
      .toBe(String(targetScale));
    // (a) The preference drives the main window's Electron zoom factor.
    await expect
      .poll(() => readMainWindowZoomFactor(first.electronApp))
      .toBe(1.5);
    // The window did not resize, so the CSS viewport shrinks by the zoom:
    // that is the layout-level proof the whole page is zoomed, independent of
    // which display the hidden window is currently associated with.
    await expect
      .poll(() => readScaleMetrics(window).then((m) => m.innerWidth))
      .toBeCloseTo(metricsBefore.innerWidth / 1.5, 0);

    appliedScale = targetScale;

    const nativeScaleAfter = await readNativeScaleFactor(first.electronApp);
    const nativeScaleRatio = nativeScaleAfter / nativeScaleBefore;
    const metricsAfter = await readScaleMetrics(window);
    // The renderer's devicePixelRatio includes the page zoom.
    expect(metricsAfter.devicePixelRatio).toBeCloseTo(
      metricsBefore.devicePixelRatio * 1.5 * nativeScaleRatio,
      3,
    );
    // (b) A fixed 28px control keeps its CSS size but grows 1.5x on screen.
    expect(metricsAfter.controlCssHeight).toBe(28);
    expect(metricsAfter.controlDeviceHeight).toBeCloseTo(
      metricsBefore.controlDeviceHeight * 1.5 * nativeScaleRatio,
      3,
    );
    // (c) The hairline is one device pixel at the new zoom: the root token
    // and a rendered default border both multiply out to 1.0 device px.
    expect(
      metricsAfter.hairlineCss * metricsAfter.devicePixelRatio,
    ).toBeCloseTo(1, 2);
    expect(
      metricsAfter.dividerBorderCss * metricsAfter.devicePixelRatio,
    ).toBeCloseTo(1, 2);
    // The renderer publishes the live zoom for CSS that must stay in
    // physical units (the macOS traffic-light reservation).
    expect(metricsAfter.uiZoom).toBe('1.5');
    // (d) The window minimum zooms with the UI, so the renderer's CSS-px
    // layout floors (sidebar, 320px panel floor) still fit at the narrowest
    // window: 800 x 500 at 100% is 1200 x 750 at 150%, capped to the display.
    const minimumAfter = await readMainWindowMinimum(first.electronApp);
    expect(minimumAfter.size).toEqual(
      expectedMinimum(minimumAfter.workArea, 1.5),
    );

    const applied = await readHtmlState(window);
    expect(applied.theme).toBe('unstoppable');
    expect(applied.dark).toBe(true);
    expect(applied.uiScale).toBe(String(targetScale));
    expect(applied.scrollbarBehavior).toBe('hover');

    await window.screenshot({
      path: testInfo.outputPath('display-theme-applied.png'),
    });

    await app.closeSettings();

    if (process.platform === 'darwin') {
      // The traffic lights sit at a fixed physical position, so the 72px
      // reservation in front of the sidebar toggle is divided by the zoom
      // (72 / 1.5 = 48) while the 16px gap after it scales like the rest of
      // the UI: 48 + 16 = 64 CSS px.
      await expect
        .poll(() => readTitlebarCornerPadding(window))
        .toBeCloseTo(64, 1);

      // ...and the row's VERTICAL geometry is governed by the same rule: the
      // lights cannot zoom, so the controls that share their row hold the
      // lights' fixed 23px centre line instead of riding the zoom to 34.5.
      const rowCenters = [
        await expectTitlebarRowOnTrafficLights(
          window,
          first.electronApp,
          '150%',
        ),
      ];

      // Below 100% the same physical reserve costs MORE CSS px (72 / 0.75 =
      // 96), so the expanded sidebar's floor grows by that extra: its
      // titlebar row keeps the one-button status budget instead of
      // collapsing it to 12px under the corner overlay.
      await app.openSettings();
      await app.openSettingsSection('display');
      await chooseInterfaceScale(window, 75);
      await expect
        .poll(() => readMainWindowZoomFactor(first.electronApp))
        .toBe(0.75);
      await app.closeSettings();

      // The compensation works in both directions: below 100% the controls
      // sit LOWER in their own row than its midpoint, because 23 physical px
      // is further down a row that shrank.
      rowCenters.push(
        await expectTitlebarRowOnTrafficLights(
          window,
          first.electronApp,
          '75%',
        ),
      );

      const resizeHandle = window.getByTestId('sidebar-resize-handle');
      const resizeHandleBox = await resizeHandle.boundingBox();
      expect(resizeHandleBox).not.toBeNull();
      await window.mouse.move(
        resizeHandleBox.x + resizeHandleBox.width / 2,
        resizeHandleBox.y + resizeHandleBox.height / 2,
      );
      await window.mouse.down();
      await window.mouse.move(
        0,
        resizeHandleBox.y + resizeHandleBox.height / 2,
      );
      await window.mouse.up();

      // 220 + (96 - 72) of floor and 72 / 0.75 + 112 of corner, which leaves
      // the status area its one-button budget. `sidebar-layout.test.ts` pins
      // that budget at exactly 36px in pure geometry; on screen the panel's
      // hairline border and sub-pixel rounding shave ~1.3px off it, so this
      // asserts what the user sees — room for the 28px control. Before the
      // floor compensated for the physical reserve this area was ~11px and
      // the control spilled leftward under the corner overlay.
      await expect
        .poll(() =>
          readSidebarTitlebarGeometry(window).then((g) => g.panelWidth),
        )
        .toBeGreaterThanOrEqual(243.5);
      const sidebarGeometry = await readSidebarTitlebarGeometry(window);
      expect(sidebarGeometry.cornerWidth).toBeCloseTo(208, 0);
      expect(sidebarGeometry.statusWidth).toBeGreaterThanOrEqual(28);

      // 200% and 50% sit outside the band where the row can reach the
      // lights' 23pt centre without clipping its controls, so there the
      // lights move onto the row instead (they used to stay put, 5pt above
      // the controls at 200%). 125% is the closest the uncompensated row ever
      // came, and it still sat 5.75px below the lights. 100% is the control:
      // there the row needs no compensation at all, so it also proves the fix
      // is a no-op at 100%.
      for (const scale of [200, 50, 125, 100]) {
        await app.openSettings();
        await app.openSettingsSection('display');
        await chooseInterfaceScale(window, scale);
        await expect
          .poll(() => readMainWindowZoomFactor(first.electronApp))
          .toBe(scale / 100);
        await app.closeSettings();
        rowCenters.push(
          await expectTitlebarRowOnTrafficLights(
            window,
            first.electronApp,
            `${scale}%`,
          ),
        );
      }
      await testInfo.attach('titlebar-row-centers', {
        body: JSON.stringify(rowCenters, null, 2),
        contentType: 'application/json',
      });

      // Restore the scale the relaunch assertions below expect.
      await app.openSettings();
      await app.openSettingsSection('display');
      await chooseInterfaceScale(window, targetScale);
      await expect
        .poll(() => readMainWindowZoomFactor(first.electronApp))
        .toBe(1.5);
      await app.closeSettings();
    }
    const rowLabel = worktreeRow.locator('p[title]').first();
    const rowLabelBox = await rowLabel.boundingBox();
    expect(rowLabelBox).not.toBeNull();
    await window.mouse.move(
      rowLabelBox.x + rowLabelBox.width / 2,
      rowLabelBox.y + rowLabelBox.height / 2,
    );
    await window.mouse.down();
    await window.mouse.move(
      rowLabelBox.x + rowLabelBox.width / 2 + 12,
      rowLabelBox.y + rowLabelBox.height / 2,
      { steps: 4 },
    );
    const dragOverlay = window.getByTestId('sidebar-item-group-drag-overlay');
    await expect(dragOverlay).toBeVisible();
    await expect(dragOverlay.getByTestId('diff-stats-badge')).toHaveText(
      '+1234-12345',
    );
    await window.keyboard.press('Escape');
    await window.mouse.up();
    await expect(dragOverlay).toHaveCount(0);
  } finally {
    // Keep the seeded preferences so the relaunch can read them.
    await closeCanopy(first.electronApp, userDataDir, { keepUserData: true });
  }

  // Second launch: reuse the same userDataDir and assert the persisted
  // theme/color-mode/scale reapply on startup.
  const second = await launchCanopyWithLabsPagesOffered({ userDataDir });

  try {
    const window = await second.electronApp.firstWindow();
    const app = new CanopyAppDriver(window);

    await app.waitForShell();

    await expect
      .poll(() => readHtmlState(window).then((s) => s.theme))
      .toBe('unstoppable');
    await expect
      .poll(() => readHtmlState(window).then((s) => s.dark))
      .toBe(true);
    await expect
      .poll(() => readHtmlState(window).then((s) => s.uiScale))
      .toBe(String(appliedScale));
    // The persisted scale is applied as the window's zoom factor on startup,
    // not only re-derived by the renderer after hydration.
    await expect
      .poll(() => readMainWindowZoomFactor(second.electronApp))
      .toBe(appliedScale / 100);
    // The window is constructed with the scaled minimum, not only rescaled
    // by a later save.
    const relaunchMinimum = await readMainWindowMinimum(second.electronApp);
    expect(relaunchMinimum.size).toEqual(
      expectedMinimum(relaunchMinimum.workArea, appliedScale / 100),
    );
    await expect
      .poll(() =>
        readHtmlState(window).then((state) => state.scrollbarBehavior),
      )
      .toBe('hover');

    await app.openMainPage();
    await app.openSettings();
    await app.openSettingsSection('display');
    await app.expectSettingsSection('display');
    await expect(
      window.getByTestId('worktree-diff-stats-style-complete'),
    ).toHaveAttribute('aria-pressed', 'true');

    await window.screenshot({
      path: testInfo.outputPath('display-theme-persisted.png'),
    });
  } finally {
    await closeCanopy(second.electronApp, userDataDir);
  }
});

for (const compact of [false, true]) {
  test(`Sidebar style moves to Appearance, preserves saved ${compact ? 'Compact' : 'Advanced'} and survives restart`, async () => {
    test.setTimeout(120_000);
    const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'sidebar-style-'));
    const { seedEarlyAccess } = await import('./seeders/seedEarlyAccess.mjs');
    const { readFileSync } = await import('node:fs');
    const { filePath } = seedEarlyAccess({ userDataDir });
    const choices = JSON.parse(readFileSync(filePath, 'utf8'));
    choices.accounts.local.sidebar = compact;
    writeFileSync(filePath, JSON.stringify(choices), 'utf8');
    const originalSnapshot = async (window) =>
      window.evaluate(() => window.api.experiments.getSnapshot());
    let launched = await launchCanopyWithLabsPagesOffered({ userDataDir });
    try {
      let window = await launched.electronApp.firstWindow();
      let app = new CanopyAppDriver(window);
      await app.waitForShell({ timeout: 30_000 });
      const before = await originalSnapshot(window);
      await app.openSettings();
      await app.openSettingsSection('display');
      const picker = window.getByTestId('sidebar-style-picker');
      await expect(picker).toContainText(compact ? 'Compact' : 'Advanced');
      await picker.click();
      const advanced = window.getByTestId('sidebar-style-advanced');
      const compactOption = window.getByTestId('sidebar-style-compact');
      await expect(advanced).toHaveAttribute('aria-selected', String(!compact));
      await expect(compactOption).toHaveAttribute(
        'aria-selected',
        String(compact),
      );
      await expect(
        advanced.getByTestId('sidebar-style-preview-advanced'),
      ).toHaveCount(0);
      await expect(
        compactOption.getByTestId('sidebar-style-preview-compact'),
      ).toHaveCount(0);
      if (compact) {
        await compactOption.focus();
        await window.keyboard.press('Home');
        await expect(advanced).toBeFocused();
        await window.keyboard.press('Enter');
      } else {
        await compactOption.click();
      }
      await expect(picker).toContainText(compact ? 'Advanced' : 'Compact');
      await expect
        .poll(
          async () =>
            (await originalSnapshot(window)).experiments.find(
              (e) => e.id === 'sidebar',
            )?.enabled,
        )
        .toBe(!compact);
      const after = await originalSnapshot(window);
      expect(
        after.experiments
          .filter((e) => e.id !== 'sidebar')
          .map((e) => [e.id, e.enabled]),
      ).toEqual(
        before.experiments
          .filter((e) => e.id !== 'sidebar')
          .map((e) => [e.id, e.enabled]),
      );
      await app.openSettingsSection('experiments');
      await expect(
        window.getByTestId('labs-experiment-toggle-sidebar'),
      ).toHaveCount(0);
      await closeCanopy(launched.electronApp, userDataDir, {
        keepUserData: true,
      });
      launched = await launchCanopyWithLabsPagesOffered({ userDataDir });
      window = await launched.electronApp.firstWindow();
      app = new CanopyAppDriver(window);
      await app.waitForShell({ timeout: 30_000 });
      await app.openSettings();
      await app.openSettingsSection('display');
      await expect(window.getByTestId('sidebar-style-picker')).toContainText(
        compact ? 'Advanced' : 'Compact',
      );
    } finally {
      await closeCanopy(launched.electronApp, userDataDir);
    }
  });
}
