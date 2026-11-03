import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';

const WORKSPACE_ID = 'demo-ts-pnpm-vite';
const WORKTREE_ID = 'demo-main';
const PENDING_COPY = 'Code Graph details are being prepared. Try again.';
const REMOVE_PROJECTION =
  "DELETE FROM graph_metadata WHERE key = 'summary_projection_v1'";

function graphDbPath(userDataDir) {
  return path.join(
    userDataDir,
    'workspaces',
    WORKSPACE_ID,
    'worktree-data',
    WORKTREE_ID,
    'code-graph',
    'graph.db',
  );
}

async function openGraph(window) {
  const row = window.locator(
    `[data-testid="worktree-row"][data-branch="${WORKTREE_ID}"]`,
  );
  await row.hover();
  await row.getByTestId('worktree-actions-menu-button').click();
  await window.getByTestId('worktree-actions-menu-info').click();
  const dialog = window.getByRole('dialog', { name: 'Branch info' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('tab', { name: 'Code Graph' }).click();
  return dialog;
}

/** Seeds a new data root, or relaunches against an existing one. */
async function launchGraphFixture(existingUserDataDir, launchOptions = {}) {
  const userDataDir =
    existingUserDataDir ??
    mkdtempSync(path.join(os.tmpdir(), 'canopy-graph-summary-readiness-'));
  if (existingUserDataDir === undefined) {
    seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  }
  const launched = await launchCanopy({ userDataDir, ...launchOptions });
  try {
    const window = await launched.electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_ID);
    return { ...launched, window, userDataDir };
  } catch (error) {
    await closeCanopy(launched.electronApp, userDataDir);
    throw error;
  }
}

async function generateGraph(dialog) {
  const build = dialog.getByTestId('code-graph-summary-build');
  await expect(build).toBeEnabled();
  await build.click();
  await expect(dialog.getByTestId('code-graph-summary-details')).toBeVisible({
    timeout: 120_000,
  });
  await expect(build).toBeEnabled({ timeout: 120_000 });
  await expect(dialog.getByTestId('code-graph-metric-files')).not.toContainText(
    /^0\s*Files$/,
  );
}

/**
 * Shrinks the real main window to the minimum its BrowserWindow enforces
 * (800 x 500 at 100% interface scale), then waits for the renderer viewport to
 * follow. Returns the original size so the caller can restore it.
 */
async function resizeToMinimumWindow(electronApp, window) {
  const host = await electronApp.browserWindow(window);
  const sizes = await host.evaluate((win) => {
    const original = win.getSize();
    const [width, height] = win.getMinimumSize();
    win.setSize(width, height);
    return { original, minimum: [width, height] };
  });
  expect(sizes.minimum[0]).toBeGreaterThan(0);
  await expect
    .poll(async () => {
      const native = await host.evaluate((win) => ({
        size: win.getSize(),
        content: win.getContentSize(),
        zoom: win.webContents.getZoomFactor(),
      }));
      const cssWidth = await window.evaluate(() => innerWidth);
      return (
        native.size[0] === sizes.minimum[0] &&
        Math.abs(cssWidth - native.content[0] / native.zoom) <= 1
      );
    })
    .toBe(true);
  return {
    ...sizes,
    restore: () =>
      host.evaluate(
        (win, [width, height]) => win.setSize(width, height),
        sizes.original,
      ),
  };
}

/**
 * Measures what is actually drawn inside the dialog: every visible text run
 * against the dialog, its clipping ancestors, its metric card and its control;
 * every control against the dialog; and every term against its value. Text a
 * container deliberately truncates with an ellipsis is reported separately.
 */
function readDialogLayout(dialog) {
  return dialog.evaluate((root) => {
    const tolerance = 1;
    const problems = [];
    const truncated = [];
    const box = (rect) => ({
      left: Math.round(rect.left),
      top: Math.round(rect.top),
      right: Math.round(rect.right),
      bottom: Math.round(rect.bottom),
    });
    const name = (node) =>
      node.getAttribute('data-testid') ??
      node.getAttribute('aria-label') ??
      node.tagName.toLowerCase();
    const frame = root.getBoundingClientRect();
    const escapesX = (inner, outer) =>
      inner.left < outer.left - tolerance ||
      inner.right > outer.right + tolerance;
    const escapesFrame = (rect) =>
      escapesX(rect, frame) ||
      rect.top < frame.top - tolerance ||
      rect.bottom > frame.bottom + tolerance;
    if (
      frame.left < -tolerance ||
      frame.top < -tolerance ||
      frame.right > innerWidth + tolerance ||
      frame.bottom > innerHeight + tolerance
    ) {
      problems.push(
        `dialog ${JSON.stringify(box(frame))} exceeds ${innerWidth}x${innerHeight}`,
      );
    }
    const visuallyHidden = (node) => {
      for (let current = node; current; current = current.parentElement) {
        const style = getComputedStyle(current);
        const rect = current.getBoundingClientRect();
        if (
          style.visibility === 'hidden' ||
          style.clip !== 'auto' ||
          style.clipPath !== 'none' ||
          (style.overflow === 'hidden' && rect.width <= 1 && rect.height <= 1)
        ) {
          return true;
        }
        if (current === root) return false;
      }
      return false;
    };
    let textRuns = 0;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let text = walker.nextNode(); text; text = walker.nextNode()) {
      const parent = text.parentElement;
      const snippet = text.textContent?.trim().slice(0, 32) ?? '';
      if (!parent || snippet.length === 0 || visuallyHidden(parent)) continue;
      const range = document.createRange();
      range.selectNodeContents(text);
      const rects = [...range.getClientRects()].filter(
        (rect) => rect.width > 0 && rect.height > 0,
      );
      if (rects.length === 0) continue;
      textRuns += 1;
      const parentStyle = getComputedStyle(parent);
      if (
        parentStyle.textOverflow === 'ellipsis' &&
        parent.scrollWidth > parent.clientWidth
      ) {
        truncated.push(snippet);
        continue;
      }
      const containers = [];
      for (
        let node = parent;
        node && node !== root;
        node = node.parentElement
      ) {
        if (
          getComputedStyle(node).overflowX !== 'visible' ||
          node.matches(
            '[data-testid^="code-graph-metric-"], button, [role="tab"]',
          )
        ) {
          containers.push(node);
        }
      }
      for (const rect of rects) {
        if (escapesFrame(rect)) {
          problems.push(
            `"${snippet}" ${JSON.stringify(box(rect))} escapes dialog`,
          );
        }
        for (const container of containers) {
          if (escapesX(rect, container.getBoundingClientRect())) {
            problems.push(`"${snippet}" escapes ${name(container)}`);
          }
        }
      }
    }
    const controls = [
      ...root.querySelectorAll(
        'button, [role="tab"], a[href], input, select, textarea',
      ),
    ].filter((control) => control.getClientRects().length > 0);
    for (const control of controls) {
      const rect = control.getBoundingClientRect();
      if (escapesFrame(rect)) {
        problems.push(
          `${name(control)} ${JSON.stringify(box(rect))} escapes dialog`,
        );
      }
    }
    // Fact rows (a label and value pair) and Settings rows (a label and the
    // value on the trailing edge, as the health totals render).
    const pairs = [
      ...[...root.querySelectorAll('dl > div')].map((row) => ({
        termElement: row.querySelector('dt'),
        valueElement: row.querySelector('dd'),
      })),
      ...[...root.querySelectorAll('[data-settings-row-label]')].map(
        (label) => {
          const line = label.closest('.min-h-10');
          return {
            termElement: label,
            valueElement:
              line && !line.lastElementChild?.contains(label)
                ? line.lastElementChild
                : null,
          };
        },
      ),
    ];
    for (const { termElement, valueElement } of pairs) {
      const term = termElement?.getBoundingClientRect();
      const value = valueElement?.getBoundingClientRect();
      if (
        term &&
        value &&
        term.right > value.left + tolerance &&
        term.left < value.right - tolerance &&
        term.bottom > value.top + tolerance &&
        term.top < value.bottom - tolerance
      ) {
        problems.push(`"${termElement?.textContent}" overlaps value`);
      }
    }
    return {
      viewport: { width: innerWidth, height: innerHeight },
      dialog: box(frame),
      textRuns,
      controls: controls.length,
      metricCards: root.querySelectorAll('[data-testid^="code-graph-metric-"]')
        .length,
      truncated,
      problems,
    };
  });
}

/** Computed focus indicator of `locator`, and whether ancestors clip it. */
function readFocusIndicator(locator) {
  return locator.evaluate((element) => {
    const style = getComputedStyle(element);
    const alphaOf = (color) => {
      if (color === 'transparent') return 0;
      const slash = color.match(/\/\s*([\d.]+)(%?)\s*\)$/);
      if (slash) return parseFloat(slash[1]) / (slash[2] ? 100 : 1);
      const rgba = color.match(/^rgba\(([^)]+)\)$/);
      if (rgba) return parseFloat(rgba[1].split(',')[3] ?? '1');
      return 1;
    };
    const outlineWidth = parseFloat(style.outlineWidth) || 0;
    const reach =
      outlineWidth + Math.max(0, parseFloat(style.outlineOffset) || 0);
    const rect = element.getBoundingClientRect();
    const ring = {
      left: rect.left - reach,
      top: rect.top - reach,
      right: rect.right + reach,
      bottom: rect.bottom + reach,
    };
    let clippedBy = null;
    const dialog = element.closest('[role="dialog"]');
    for (
      let node = element.parentElement;
      node && !clippedBy;
      node = node.parentElement
    ) {
      const clips = getComputedStyle(node).overflow !== 'visible';
      if (clips || node === dialog) {
        const outer = node.getBoundingClientRect();
        if (
          ring.left < outer.left - 1 ||
          ring.top < outer.top - 1 ||
          ring.right > outer.right + 1 ||
          ring.bottom > outer.bottom + 1
        ) {
          clippedBy =
            node.getAttribute('data-testid') ??
            node.getAttribute('role') ??
            node.tagName.toLowerCase();
        }
      }
      if (node === dialog) break;
    }
    return {
      focused: element === document.activeElement,
      focusVisible: element.matches(':focus-visible'),
      outlineStyle: style.outlineStyle,
      outlineWidth,
      outlineColor: style.outlineColor,
      outlineAlpha: alphaOf(style.outlineColor),
      boxShadow: style.boxShadow,
      clippedBy,
    };
  });
}

/** True when focus adds a visible outline or shadow the resting state lacks. */
function focusIndicatorAppears(resting, focused) {
  const outlineShown =
    focused.outlineStyle !== 'none' &&
    focused.outlineWidth >= 1 &&
    focused.outlineAlpha > 0;
  const outlineNew =
    resting.outlineStyle === 'none' ||
    resting.outlineWidth === 0 ||
    resting.outlineAlpha === 0 ||
    resting.outlineColor !== focused.outlineColor ||
    resting.outlineWidth !== focused.outlineWidth;
  const shadowNew =
    focused.boxShadow !== 'none' && focused.boxShadow !== resting.boxShadow;
  return (outlineShown && outlineNew) || shadowNew;
}

/** Presses Tab until `target` has focus, recording each stop. */
async function tabTo(window, dialog, target) {
  const stops = [];
  for (let step = 0; step < 20; step += 1) {
    await window.keyboard.press('Tab');
    stops.push(
      await dialog.evaluate((root) => {
        const active = document.activeElement;
        return {
          inside: root.contains(active),
          name:
            active?.getAttribute('data-testid') ??
            active?.textContent?.trim().slice(0, 40) ??
            active?.tagName ??
            null,
        };
      }),
    );
    if (await target.evaluate((element) => element === document.activeElement))
      return stops;
  }
  throw new Error(`Tab never reached the target: ${JSON.stringify(stops)}`);
}

function describeActiveElement(window) {
  return window.evaluate(() => {
    const active = document.activeElement;
    if (!active || active === document.body) return 'body';
    const dialog = active.closest('[role="dialog"]');
    const name =
      active.getAttribute('data-testid') ??
      active.getAttribute('aria-label') ??
      active.tagName.toLowerCase();
    return dialog ? `inside-dialog:${name}` : `outside-dialog:${name}`;
  });
}

/**
 * Records the build button's spinner animation the moment it is inserted, so
 * a build that finishes quickly is still observed without a production hook.
 */
function watchBuildMotion(window) {
  return window.evaluate(() => {
    const samples = [];
    globalThis.__codeGraphBuildMotion = samples;
    const observer = new MutationObserver(() => {
      const button = document.querySelector(
        '[data-testid="code-graph-summary-build"]',
      );
      const spinner = button?.querySelector('[aria-label="Loading"]');
      if (!button || !spinner) return;
      observer.disconnect();
      samples.push({
        label: button.textContent?.trim() ?? '',
        animations: [spinner, ...spinner.querySelectorAll('*')].map((node) => {
          const style = getComputedStyle(node);
          return {
            name: style.animationName,
            duration: style.animationDuration,
            iterations: style.animationIterationCount,
          };
        }),
      });
    });
    observer.observe(document.body, { childList: true, subtree: true });
  });
}

function readBuildMotion(window) {
  return window.evaluate(() => globalThis.__codeGraphBuildMotion ?? []);
}

/** No animation, or one reduced motion clamps to a single 0.01ms run. */
function runsWithoutMotion({ name, duration, iterations }) {
  if (name.split(',').every((value) => value.trim() === 'none')) return true;
  const seconds = duration.split(',').map((value) => {
    const trimmed = value.trim();
    return trimmed.endsWith('ms')
      ? parseFloat(trimmed) / 1000
      : parseFloat(trimmed);
  });
  const counts = iterations.split(',').map((value) => value.trim());
  return (
    seconds.every((value) => value <= 0.001) &&
    counts.every((count) => count !== 'infinite' && parseFloat(count) <= 1)
  );
}

test('Branch Info generates a graph and retains its committed metrics when reopened', async () => {
  test.setTimeout(180_000);
  const fixture = await launchGraphFixture();
  try {
    const dialog = await openGraph(fixture.window);
    await generateGraph(dialog);
    const measuredFiles = await dialog
      .getByTestId('code-graph-metric-files')
      .textContent();
    expect(measuredFiles).toMatch(/\d+Files/);
    await dialog.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    const reopened = await openGraph(fixture.window);
    await expect(reopened.getByTestId('code-graph-metric-files')).toHaveText(
      measuredFiles,
    );
    await expect(reopened.getByTestId('code-graph-summary-error')).toHaveCount(
      0,
    );
  } finally {
    await closeCanopy(fixture.electronApp, fixture.userDataDir);
  }
});

test('Branch Info reports legacy summary preparation without displaying unmeasured metrics', async () => {
  test.setTimeout(240_000);
  let fixture = await launchGraphFixture();
  const { userDataDir } = fixture;
  let writer;
  try {
    const dialog = await openGraph(fixture.window);
    await generateGraph(dialog);
    const measuredFiles = await dialog
      .getByTestId('code-graph-metric-files')
      .textContent();
    await dialog.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(dialog).toHaveCount(0);

    // This changes only the generated test graph. Hold its writer lease after
    // removing the projection so a backfill cannot race the pending assertion.
    // Readers can still observe the prior committed metadata through WAL.
    writer = new DatabaseSync(graphDbPath(userDataDir));
    writer.exec(REMOVE_PROJECTION);
    writer.exec('BEGIN IMMEDIATE');

    const reopened = await openGraph(fixture.window);
    await expect(
      reopened.getByRole('status').filter({ hasText: PENDING_COPY }),
    ).toContainText(PENDING_COPY);
    await expect(reopened.getByRole('alert')).toHaveCount(0);
    await expect(reopened.getByTestId('code-graph-metric-files')).toHaveCount(
      0,
    );
    await expect(
      reopened.getByTestId('code-graph-summary-retry'),
    ).toBeEnabled();
    writer.exec('ROLLBACK');
    writer.close();
    writer = undefined;

    // Recovery. The repair that this read requested may have met the held
    // lease and entered its in-memory cooldown, so restart rather than race
    // it. The projection is removed again while the app is closed; nothing
    // repairs it until a read requests that, so the first read is pending.
    await closeCanopy(fixture.electronApp, userDataDir, { keepUserData: true });
    fixture = null;
    const offlineWriter = new DatabaseSync(graphDbPath(userDataDir));
    try {
      offlineWriter.exec(REMOVE_PROJECTION);
    } finally {
      offlineWriter.close();
    }
    fixture = await launchGraphFixture(userDataDir);
    const recovering = await openGraph(fixture.window);
    await expect(
      recovering.getByText(PENDING_COPY),
      'a restart keeps the projection absent until a read requests repair',
    ).toBeVisible({ timeout: 30_000 });
    await expect(recovering.getByTestId('code-graph-metric-files')).toHaveCount(
      0,
    );
    const retry = recovering.getByTestId('code-graph-summary-retry');
    let retries = 0;
    await expect(async () => {
      if ((await retry.isVisible()) && (await retry.isEnabled())) {
        await retry.click();
        retries += 1;
      }
      await expect(
        recovering.getByTestId('code-graph-metric-files'),
      ).toHaveText(measuredFiles, { timeout: 2_000 });
    }).toPass({ timeout: 60_000, intervals: [1_000, 2_000, 5_000] });
    expect(retries).toBeGreaterThan(0);
    await expect(recovering.getByText(PENDING_COPY)).toHaveCount(0);
  } finally {
    if (writer) {
      writer.exec('ROLLBACK');
      writer.close();
    }
    if (fixture) {
      await closeCanopy(fixture.electronApp, userDataDir);
    } else {
      rmSync(userDataDir, { recursive: true, force: true });
    }
  }
});

test('Branch Info offers generation and recovers after a first build that never committed', async () => {
  test.setTimeout(240_000);
  const fixture = await launchGraphFixture();
  try {
    const dialog = await openGraph(fixture.window);
    await generateGraph(dialog);
    await dialog.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(dialog).toHaveCount(0);

    // Opening a graph commits its schema version; only a build commits the
    // rest. Leave the generated test graph as an interrupted first build would.
    const writer = new DatabaseSync(graphDbPath(fixture.userDataDir));
    try {
      writer.exec("DELETE FROM graph_metadata WHERE key <> 'schema_version'");
    } finally {
      writer.close();
    }

    const reopened = await openGraph(fixture.window);
    await expect(
      reopened.getByTestId('code-graph-summary-missing'),
    ).toBeVisible();
    await expect(reopened.getByText(PENDING_COPY)).toHaveCount(0);
    await expect(reopened.getByRole('alert')).toHaveCount(0);
    await expect(reopened.getByTestId('code-graph-summary-build')).toHaveText(
      'Generate Code Graph',
    );
    await generateGraph(reopened);
    await expect(
      reopened.getByTestId('code-graph-summary-missing'),
    ).toHaveCount(0);
  } finally {
    await closeCanopy(fixture.electronApp, fixture.userDataDir);
  }
});

test('Branch Info shows the not-enabled callout, not a pending notice, for an unmeasured graph after Code Graph is turned off', async () => {
  test.setTimeout(240_000);
  const fixture = await launchGraphFixture();
  try {
    const dialog = await openGraph(fixture.window);
    await generateGraph(dialog);
    await dialog.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(dialog).toHaveCount(0);

    const app = new CanopyAppDriver(fixture.window);
    await app.openSettings();
    await app.openSettingsSection('code-graph');
    const disabled = fixture.window.getByTestId('code-graph-mode-disabled');
    await disabled.click();
    await expect(disabled).toHaveAttribute('aria-pressed', 'true');
    await app.closeSettings();

    // A graph built before the summary projection existed has none. No repair
    // runs for a disabled project, so the projection stays absent.
    const writer = new DatabaseSync(graphDbPath(fixture.userDataDir));
    try {
      writer.exec(REMOVE_PROJECTION);
    } finally {
      writer.close();
    }

    const reopened = await openGraph(fixture.window);
    await expect(
      reopened.getByTestId('code-graph-summary-disabled-callout'),
    ).toContainText('Code Graph is not enabled for this project.');
    await expect(
      reopened.getByTestId('code-graph-summary-open-settings'),
    ).toBeEnabled();
    await expect(reopened.getByText(PENDING_COPY)).toHaveCount(0);
    await expect(reopened.getByTestId('code-graph-summary-retry')).toHaveCount(
      0,
    );
    await expect(reopened.getByTestId('code-graph-metric-files')).toHaveCount(
      0,
    );
    await expect(reopened.getByRole('alert')).toHaveCount(0);
  } finally {
    await closeCanopy(fixture.electronApp, fixture.userDataDir);
  }
});

test('Branch Info keeps generation available through read and build failures and recovers when the retained graph becomes readable', async () => {
  test.setTimeout(240_000);
  const fixture = await launchGraphFixture();
  try {
    const original = await openGraph(fixture.window);
    await generateGraph(original);
    const measuredFiles = await original
      .getByTestId('code-graph-metric-files')
      .textContent();
    await original.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(original).toHaveCount(0);

    // Make the retained metadata temporarily unavailable in this isolated
    // fixture. Both reads and the existing writer fail until the metadata
    // returns; the UI must keep both recovery actions available throughout.
    const incompatible = new DatabaseSync(graphDbPath(fixture.userDataDir));
    try {
      incompatible.exec(
        'ALTER TABLE graph_metadata RENAME TO unavailable_graph_metadata',
      );
      expect(
        incompatible
          .prepare(
            "SELECT name FROM sqlite_master WHERE name = 'graph_metadata'",
          )
          .all(),
      ).toEqual([]);
    } finally {
      incompatible.close();
    }

    const recovering = await openGraph(fixture.window);
    const failure = recovering.getByRole('alert');
    await expect(failure).toContainText('Code Graph');
    await expect(recovering.getByTestId('code-graph-metric-files')).toHaveCount(
      0,
    );
    const retry = recovering.getByTestId('code-graph-summary-retry');
    await expect(retry).toBeEnabled();
    await retry.click();
    await expect(retry).toBeEnabled();
    await expect(failure).toBeVisible();
    await expect(recovering.getByTestId('code-graph-metric-files')).toHaveCount(
      0,
    );

    // A persistent read error must retain the user's generation escape hatch.
    const update = recovering.getByRole('button', {
      name: 'Update Code Graph',
      exact: true,
    });
    await expect(update).toBeEnabled();
    await update.click();
    await expect(
      recovering.getByRole('alert').filter({
        hasText: 'The Code Graph build failed.',
      }),
    ).toBeVisible();
    await expect(update).toBeEnabled();
    await expect(retry).toBeEnabled();

    // Restore the actual retained schema before asking its cached writer to
    // rebuild. A read-error action does not promise to recreate corrupt tables.
    const repaired = new DatabaseSync(graphDbPath(fixture.userDataDir));
    try {
      repaired.exec(
        'ALTER TABLE unavailable_graph_metadata RENAME TO graph_metadata',
      );
    } finally {
      repaired.close();
    }
    await update.click();
    await expect(recovering.getByTestId('code-graph-metric-files')).toHaveText(
      measuredFiles,
      { timeout: 120_000 },
    );
    await expect(failure).toHaveCount(0);
    await expect(update).toBeEnabled({ timeout: 120_000 });
    await recovering
      .getByRole('button', { name: 'Close', exact: true })
      .click();
    const reopened = await openGraph(fixture.window);
    await expect(reopened.getByTestId('code-graph-metric-files')).toHaveText(
      measuredFiles,
    );
    await expect(reopened.getByRole('alert')).toHaveCount(0);
  } finally {
    await closeCanopy(fixture.electronApp, fixture.userDataDir);
  }
});

test('Branch Info stays usable at the minimum window size with keyboard focus and reduced motion', async () => {
  test.setTimeout(240_000);
  const fixture = await launchGraphFixture(undefined, { viewportSize: null });
  try {
    await fixture.window.emulateMedia({ reducedMotion: 'reduce' });
    expect(
      await fixture.window.evaluate(
        () => matchMedia('(prefers-reduced-motion: reduce)').matches,
      ),
      'reduced-motion emulation precondition',
    ).toBe(true);
    const dialog = await openGraph(fixture.window);
    const build = dialog.getByTestId('code-graph-summary-build');
    await expect(build).toBeEnabled();
    test.info().annotations.push({
      type: 'focus-after-tab-click',
      description: await describeActiveElement(fixture.window),
    });

    const sizing = await resizeToMinimumWindow(
      fixture.electronApp,
      fixture.window,
    );
    const missing = await readDialogLayout(dialog);
    test.info().annotations.push({
      type: 'minimum-window',
      description: JSON.stringify({ native: sizing.minimum, ...missing }),
    });
    expect(missing.problems).toEqual([]);
    expect(missing.textRuns).toBeGreaterThanOrEqual(5);

    // Keyboard order from the Code Graph tab to its action, within the dialog.
    const resting = await readFocusIndicator(build);
    expect(resting.focused).toBe(false);
    await dialog.getByRole('tab', { name: 'Code Graph' }).focus();
    const stops = await tabTo(fixture.window, dialog, build);
    expect(stops.filter((stop) => !stop.inside)).toEqual([]);
    const focused = await readFocusIndicator(build);
    expect(focused.focusVisible).toBe(true);
    expect(
      focusIndicatorAppears(resting, focused),
      JSON.stringify({ resting, focused }),
    ).toBe(true);
    expect(focused.clippedBy).toBeNull();

    await watchBuildMotion(fixture.window);
    await fixture.window.keyboard.press('Enter');
    await expect(dialog.getByTestId('code-graph-summary-details')).toBeVisible({
      timeout: 120_000,
    });
    await expect(build).toBeEnabled({ timeout: 120_000 });
    await expect(
      dialog.getByTestId('code-graph-metric-files'),
    ).not.toContainText(/^0\s*Files$/);
    const [motion] = await readBuildMotion(fixture.window);
    expect(
      motion,
      'the build spinner was observed while it rendered',
    ).toBeDefined();
    expect(motion.label).toMatch(/Generating Code Graph/);
    expect(motion.animations.length).toBeGreaterThan(0);
    expect(
      motion.animations.filter((entry) => !runsWithoutMotion(entry)),
    ).toEqual([]);

    const readable = await readDialogLayout(dialog);
    test.info().annotations.push({
      type: 'minimum-window-readable',
      description: JSON.stringify(readable),
    });
    expect(readable.metricCards).toBe(4);
    expect(readable.textRuns).toBeGreaterThanOrEqual(15);
    expect(readable.problems).toEqual([]);
    const measuredFiles = await dialog
      .getByTestId('code-graph-metric-files')
      .textContent();

    // The build disables the focused action while it runs. Where focus lands
    // is recorded, not asserted: the dialog frame has no focus management at
    // HEAD either. Escape is handled on the dialog, so it is sent from inside.
    const afterBuild = await describeActiveElement(fixture.window);
    test.info().annotations.push({
      type: 'focus-after-build',
      description: afterBuild,
    });
    if (!afterBuild.startsWith('inside-dialog')) await build.focus();
    await fixture.window.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    test.info().annotations.push({
      type: 'focus-after-escape',
      description: await describeActiveElement(fixture.window),
    });

    await sizing.restore();
    const reopened = await openGraph(fixture.window);
    await expect(reopened.getByTestId('code-graph-metric-files')).toHaveText(
      measuredFiles,
    );
  } finally {
    await closeCanopy(fixture.electronApp, fixture.userDataDir);
  }
});
