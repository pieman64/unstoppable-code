import { expect, test } from '@playwright/test';
import {
  CUSTOM_ROW_TEST_ID,
  DEVICE_ROW_TEST_ID,
  LONG_CUSTOM_NAME,
  MCP_TABLE_MOUNTS,
  launchMcpServersLayout,
  setWindowContentSize,
} from './fixtures/mcpServersLayout.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { CanopyAppDriver } from './canopyApp.mjs';
import { setUiScale } from './uiScale.mjs';

// CAN-4258: the MCP servers table (`McpServersTab.tsx`) clipped its trailing
// Actions column at laptop widths, showing "Make available in c", because the
// table outgrew its `overflow-hidden` wrapper. Its mount, Settings → MCP
// servers → Account connections, must keep every action complete and
// reachable by pointer and keyboard input, either in place or by scrolling
// the table region, without widening the page. (CAN-4267 removed the former
// Plugins → Your plugins → MCP mount with the legacy management view.)
//
// `fixtures/mcpServersLayout.mjs` seeds the widest action combinations the
// table renders. The spec never clicks Health Check or Test Connection.

// The laptop configurations from the ticket, the narrowest window the app
// allows at 150% (its 800×500 minimum, scaled), and a wide window at the
// default scale.
const CONFIGURATIONS = [
  { width: 1280, height: 800, scale: 125 },
  { width: 1280, height: 800, scale: 150 },
  { width: 1200, height: 750, scale: 150 },
  { width: 1680, height: 1050, scale: 100 },
];

// The rows with the widest actions, and every action they must show.
const EXPECTED_ACTIONS = [
  {
    rowTestId: CUSTOM_ROW_TEST_ID,
    actions: [
      'mcp-account-disconnect',
      'mcp-device-copy',
      'mcp-account-details-button',
      'mcp-account-edit-button',
    ],
  },
  {
    rowTestId: DEVICE_ROW_TEST_ID,
    actions: ['mcp-account-connect', 'mcp-server-edit-button'],
    label: 'Make available in cloud',
  },
  {
    rowTestId: 'mcp-server-row-github',
    config: false,
    actions: [
      'mcp-account-connect',
      'mcp-device-copy',
      'mcp-account-details-button',
    ],
    label: 'Connect',
  },
  {
    rowTestId: 'mcp-server-row-github',
    config: true,
    actions: [
      'mcp-account-connect',
      'mcp-account-disconnect',
      'mcp-account-details-button',
    ],
    label: 'Reconnect',
  },
];

function expectedRow(panel, expected) {
  const row = panel.getByTestId(expected.rowTestId);
  if (expected.config === undefined) return row;
  const config = panel.page().getByTestId('mcp-account-config');
  return expected.config
    ? row.filter({ has: config })
    : row.filter({ hasNot: config });
}

/** Geometry of the table region, its panel, and the page, in CSS pixels. */
function readRegion(table) {
  return table.evaluate((tableElement) => {
    const region = tableElement.parentElement;
    const panel = region.closest('[data-mcp-layout-panel]');
    const scroller = document.scrollingElement;
    const style = getComputedStyle(region);
    const regionRect = region.getBoundingClientRect();
    const panelRect = panel.getBoundingClientRect();
    return {
      viewport: { width: window.innerWidth, height: window.innerHeight },
      clientWidth: region.clientWidth,
      scrollWidth: region.scrollWidth,
      scrollLeft: region.scrollLeft,
      overflowX: style.overflowX,
      maskImage: style.maskImage || style.webkitMaskImage,
      tabIndex: region.getAttribute('tabindex'),
      ariaLabel: region.getAttribute('aria-label'),
      region: { left: regionRect.left, right: regionRect.right },
      panel: { left: panelRect.left, right: panelRect.right },
      page: {
        clientWidth: scroller.clientWidth,
        scrollWidth: scroller.scrollWidth,
      },
    };
  });
}

/**
 * Whether the whole control is visible inside the table region and the
 * window, and its label fits on one line inside it.
 */
function readControl(control) {
  return control.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const region = element.closest('table').parentElement;
    const regionRect = region.getBoundingClientRect();
    const tolerance = 1;
    const style = getComputedStyle(element);
    return {
      text: element.textContent.trim(),
      inRegion:
        rect.left >= regionRect.left - tolerance &&
        rect.right <= regionRect.right + tolerance,
      inViewport:
        rect.left >= -tolerance &&
        rect.top >= -tolerance &&
        rect.right <= window.innerWidth + tolerance &&
        rect.bottom <= window.innerHeight + tolerance,
      labelFits:
        element.scrollWidth <= element.clientWidth + tolerance &&
        element.scrollHeight <= element.clientHeight + tolerance,
      outline: `${style.outlineStyle} ${style.outlineWidth}`,
    };
  });
}

/** Scrolls the row vertically into view without touching horizontal scroll. */
async function bringRowIntoView(row) {
  await row
    .locator('td')
    .first()
    .evaluate((cell) => {
      const region = cell.closest('table').parentElement;
      const left = region.scrollLeft;
      cell.scrollIntoView({ block: 'center', inline: 'nearest' });
      region.scrollLeft = left;
    });
}

/**
 * Resolves on the third animation frame, by which point the compositor has
 * committed and activated any scroll made before the call.
 */
function waitForCompositorFrames(window) {
  return window.evaluate(
    () =>
      new Promise((resolve) => {
        let remaining = 3;
        const next = () =>
          (remaining -= 1) === 0 ? resolve() : requestAnimationFrame(next);
        requestAnimationFrame(next);
      }),
  );
}

/** Scrolls the table region to its trailing edge with horizontal wheel input. */
async function wheelToTrailingEdge(electronApp, window, table) {
  // The compositor hit-tests native wheel input against its active frame,
  // which under load can still predate bringRowIntoView's scroll. The wheel
  // then targets what was at this point before that scroll, not the region.
  await waitForCompositorFrames(window);
  // A point inside the region's visible part, in CSS pixels, checked by hit
  // test. Electron's page zoom (the interface scale) is applied outside the
  // page, so window input takes CSS pixels times the zoom. The wheel goes
  // through Electron's own input routing, like a trackpad swipe.
  const target = await table.evaluate((tableElement) => {
    const region = tableElement.parentElement;
    const rect = region.getBoundingClientRect();
    const top = Math.max(rect.top, 0);
    const bottom = Math.min(rect.bottom, window.innerHeight);
    const x = rect.left + rect.width / 2;
    const y = top + (bottom - top) / 2;
    const hit = document.elementFromPoint(x, y);
    const zoom = Number(
      getComputedStyle(document.documentElement).getPropertyValue('--ui-zoom'),
    );
    return { x, y, zoom: zoom || 1, inside: region.contains(hit) };
  });
  expect(target.inside, JSON.stringify(target)).toBe(true);
  const { scrollWidth } = await readRegion(table);
  const browserWindow = await electronApp.browserWindow(window);
  await browserWindow.evaluate(
    (win, { x, y, delta }) => {
      win.webContents.sendInputEvent({ type: 'mouseMove', x, y });
      win.webContents.sendInputEvent({
        type: 'mouseWheel',
        x,
        y,
        deltaX: -delta,
        deltaY: 0,
        canScroll: true,
      });
    },
    {
      x: Math.round(target.x * target.zoom),
      y: Math.round(target.y * target.zoom),
      delta: scrollWidth,
    },
  );
  await expect
    .poll(
      async () => {
        const current = await readRegion(table);
        return (
          current.scrollLeft + current.clientWidth >= current.scrollWidth - 1
        );
      },
      { message: JSON.stringify(target) },
    )
    .toBe(true);
}

async function resetHorizontalScroll(table) {
  await table.evaluate((tableElement) => {
    tableElement.parentElement.scrollLeft = 0;
  });
}

async function expectTableUsable(electronApp, window, panel, configuration) {
  const table = panel.locator('table').first();
  for (const row of EXPECTED_ACTIONS)
    await expect(expectedRow(panel, row)).toBeVisible();
  await resetHorizontalScroll(table);
  const region = await readRegion(table);
  const context = JSON.stringify({ configuration, region });

  // The table never widens the page or escapes its panel.
  expect(region.page.scrollWidth, context).toBeLessThanOrEqual(
    region.page.clientWidth + 1,
  );
  expect(region.region.right, context).toBeLessThanOrEqual(
    region.panel.right + 1,
  );
  expect(region.region.left, context).toBeGreaterThanOrEqual(
    region.panel.left - 1,
  );

  const overflows = region.scrollWidth > region.clientWidth + 1;
  if (overflows) {
    // Residual overflow scrolls within the table region, announces itself
    // with an edge fade, and is a named keyboard stop.
    expect(['auto', 'scroll'], context).toContain(region.overflowX);
    expect(region.maskImage, context).not.toBe('none');
    expect(region.tabIndex, context).toBe('0');
    expect(region.ariaLabel, context).toBeTruthy();
  } else {
    // A table that fits adds no focus stop.
    expect(region.tabIndex, context).toBeNull();
  }

  for (const expected of EXPECTED_ACTIONS) {
    const row = expectedRow(panel, expected);
    await bringRowIntoView(row);
    // Keep the user's horizontal position while moving between rows. Reset
    // once per configuration, then swipe once, rather than programmatically
    // rewinding an in-flight native wheel gesture between every row.
    if (overflows && (await readRegion(table)).scrollLeft <= 1) {
      await wheelToTrailingEdge(electronApp, window, table);
      expect((await readRegion(table)).scrollLeft, context).toBeGreaterThan(0);
    }
    for (const testId of expected.actions) {
      const control = row.getByTestId(testId);
      await expect(control).toHaveCount(1);
      const state = await readControl(control);
      const detail = JSON.stringify({ configuration, testId, state, region });
      expect(state.inRegion, detail).toBe(true);
      expect(state.inViewport, detail).toBe(true);
      expect(state.labelFits, detail).toBe(true);
    }
    if (expected.label)
      await expect(row.getByTestId(expected.actions[0])).toHaveText(
        expected.label,
      );
  }

  // Names truncate before metadata disappears: the long name keeps useful
  // space, and the tier badge and configuration label stay visible.
  await resetHorizontalScroll(table);
  const customRow = panel.getByTestId(CUSTOM_ROW_TEST_ID);
  await bringRowIntoView(customRow);
  const nameWidth = await customRow
    .getByText(LONG_CUSTOM_NAME, { exact: true })
    .evaluate((element) => element.getBoundingClientRect().width);
  expect(nameWidth, context).toBeGreaterThanOrEqual(96);
  const tierBadge = customRow.getByTestId('mcp-tier-badge');
  await expect(tierBadge).toBeVisible();
  const tierState = await readControl(tierBadge);
  expect(tierState.inRegion, JSON.stringify(tierState)).toBe(true);
  expect(tierState.labelFits, JSON.stringify(tierState)).toBe(true);
  const workRow = panel.getByTestId(`mcp-server-row-github`).filter({
    has: window.getByTestId('mcp-account-config'),
  });
  await bringRowIntoView(workRow);
  const configLabel = workRow.getByTestId('mcp-account-config');
  await expect(configLabel).toBeVisible();
  await expect(configLabel).toHaveText('Work');
  const configState = await readControl(configLabel);
  expect(configState.inRegion, context).toBe(true);
  expect(configState.labelFits, context).toBe(true);
  // The middle cells retain their full content even when the table itself
  // needs horizontal scrolling. Check their own clipping rather than just
  // their presence in the DOM.
  for (const expected of EXPECTED_ACTIONS) {
    const row = expectedRow(panel, expected);
    for (const column of [1, 2, 3]) {
      const cell = row.locator('td').nth(column);
      await expect(cell).not.toBeEmpty();
      const state = await readControl(cell);
      expect(state.labelFits, JSON.stringify({ column, state })).toBe(true);
    }
  }

  if (overflows) {
    // Keyboard: the region takes focus with a visible ring and scrolls with
    // the arrow keys; tabbing onward reaches the trailing actions.
    await resetHorizontalScroll(table);
    const regionLocator = table.locator('xpath=..');
    await regionLocator.focus();
    await window.keyboard.press('Shift+Tab');
    await window.keyboard.press('Tab');
    await expect(regionLocator).toBeFocused();
    const regionOutline = await regionLocator.evaluate(
      (element) => getComputedStyle(element).outlineStyle,
    );
    expect(regionOutline, context).not.toBe('none');
    await window.keyboard.press('ArrowRight');
    await expect
      .poll(async () => (await readRegion(table)).scrollLeft)
      .toBeGreaterThan(0);

    await resetHorizontalScroll(table);
    const target = customRow.getByTestId('mcp-account-edit-button');
    await regionLocator.focus();
    let reached = false;
    for (let step = 0; step < 40 && !reached; step += 1) {
      await window.keyboard.press('Tab');
      reached = await target.evaluate(
        (element) => document.activeElement === element,
      );
    }
    expect(reached, context).toBe(true);
    const focused = await readControl(target);
    expect(focused.inRegion, JSON.stringify(focused)).toBe(true);
    expect(focused.outline, JSON.stringify(focused)).not.toMatch(/^none/);
  }
  await resetHorizontalScroll(table);
  return region;
}

for (const mount of MCP_TABLE_MOUNTS) {
  test(`MCP servers empty state has no scroll region: ${mount.name}`, async () => {
    const { electronApp, userDataDir } = await launchCanopy({
      viewportSize: null,
      env: {
        CANOPY_E2E_CLIENT_FEATURE_FLAGS: JSON.stringify({
          'canopy-shared-mcp-account-connections': true,
        }),
      },
    });
    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell();
      await setUiScale(window, 150);
      await setWindowContentSize(electronApp, window, CONFIGURATIONS[1]);
      await app.openSettings();
      await app.openSettingsSection('mcp');
      const panel = window.getByTestId(mount.panelTestId);
      await expect(panel.getByText('No MCP servers registered')).toBeVisible();
      await expect(panel.locator('table')).toHaveCount(0);
      await expect(panel.getByTestId('mcp-servers-table')).toHaveCount(0);
      expect(
        await window.evaluate(
          () =>
            document.scrollingElement.scrollWidth <=
            document.scrollingElement.clientWidth + 1,
        ),
      ).toBe(true);
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test(`MCP servers long list keeps vertical and horizontal scrolling independent: ${mount.name}`, async () => {
    test.setTimeout(180_000);
    const { cloud, userDataDir, electronApp, window, panel, extraServerIds } =
      await launchMcpServersLayout(mount, {}, { extraServerCount: 24 });
    try {
      await setUiScale(window, 150);
      await setWindowContentSize(electronApp, window, CONFIGURATIONS[1]);
      await panel.evaluate((element) =>
        element.setAttribute('data-mcp-layout-panel', ''),
      );
      const table = panel.locator('table').first();
      await expect(table.locator('tbody tr')).toHaveCount(28);
      await resetHorizontalScroll(table);
      const region = await readRegion(table);
      expect(region.scrollWidth).toBeGreaterThan(region.clientWidth + 1);
      const lastRow = panel.getByTestId(
        `mcp-server-row-${extraServerIds.at(-1)}`,
      );
      await bringRowIntoView(lastRow);
      const scrollAncestors = await table.evaluate((element) => {
        const result = [];
        for (
          let parent = element.parentElement;
          parent;
          parent = parent.parentElement
        )
          if (parent.scrollHeight > parent.clientHeight + 1)
            result.push({
              scrollTop: parent.scrollTop,
              overflowY: getComputedStyle(parent).overflowY,
            });
        return result;
      });
      expect(
        scrollAncestors.some(
          ({ scrollTop, overflowY }) =>
            scrollTop > 0 && ['auto', 'scroll'].includes(overflowY),
        ),
        JSON.stringify(scrollAncestors),
      ).toBe(true);
      expect((await readRegion(table)).scrollLeft).toBe(0);
      await wheelToTrailingEdge(electronApp, window, table);
      const edit = lastRow.getByTestId('mcp-server-edit-button');
      const state = await readControl(edit);
      expect(state.inViewport, JSON.stringify(state)).toBe(true);
      expect(state.inRegion, JSON.stringify(state)).toBe(true);
      await edit.click();
      const dialog = window.getByRole('dialog', { name: 'Edit MCP server' });
      await expect(dialog).toBeVisible();
      await expect(dialog.getByPlaceholder('My MCP server')).toHaveValue(
        'Vertical scrolling fixture 24',
      );
      await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
      await bringRowIntoView(panel.getByTestId(CUSTOM_ROW_TEST_ID));
      expect((await readRegion(table)).scrollLeft).toBeGreaterThan(0);
      const disconnect = panel
        .getByTestId(CUSTOM_ROW_TEST_ID)
        .getByTestId('mcp-account-disconnect');
      expect((await readControl(disconnect)).inViewport).toBe(true);
    } finally {
      await closeCanopy(electronApp, userDataDir);
      await cloud.close();
    }
  });

  test(`MCP servers table keeps every action reachable: ${mount.name}`, async ({}, testInfo) => {
    test.setTimeout(240_000);
    const { cloud, userDataDir, electronApp, window, panel } =
      await launchMcpServersLayout(mount);
    try {
      // Marks the mount for in-page geometry reads.
      await panel.evaluate((element) =>
        element.setAttribute('data-mcp-layout-panel', ''),
      );

      const measurements = [];
      for (const configuration of CONFIGURATIONS) {
        await setUiScale(window, configuration.scale);
        const windowSize = await setWindowContentSize(
          electronApp,
          window,
          configuration,
        );
        // The scale is a page zoom, so the CSS viewport is the window size
        // divided by it; record both so the two are not applied twice.
        await expect
          .poll(() => window.evaluate(() => window.innerWidth), {
            message: JSON.stringify({ configuration, windowSize }),
          })
          .toBe(Math.round(configuration.width / (configuration.scale / 100)));
        measurements.push({
          configuration,
          windowSize,
          region: await expectTableUsable(
            electronApp,
            window,
            panel,
            configuration,
          ),
        });
      }
      await testInfo.attach('measurements', {
        body: JSON.stringify(measurements, null, 2),
        contentType: 'application/json',
      });
      // The narrowest window overflows, so the scroll, fade, and keyboard
      // checks above ran; the wide window fits without a focus stop.
      const overflowed = measurements.map(
        ({ region }) => region.scrollWidth > region.clientWidth + 1,
      );
      expect(overflowed[2], JSON.stringify(measurements)).toBe(true);
      expect(overflowed[3], JSON.stringify(measurements)).toBe(false);

      // Full names stay available through the existing details path.
      await setUiScale(window, 150);
      await setWindowContentSize(electronApp, window, CONFIGURATIONS[1]);
      const customRow = panel.getByTestId(CUSTOM_ROW_TEST_ID);
      await bringRowIntoView(customRow);
      await customRow.getByText(LONG_CUSTOM_NAME, { exact: true }).click();
      const details = window.getByTestId('mcp-account-details');
      await expect(details).toBeVisible();
      const detailsDialog = window.getByRole('dialog').filter({ has: details });
      await expect(detailsDialog).toContainText(LONG_CUSTOM_NAME);
      // Its own Close: Escape would also leave Settings.
      await detailsDialog.getByRole('button', { name: 'Close' }).click();
      await expect(details).toHaveCount(0);

      // An action click opens its own target, not the row's details.
      await panel
        .locator('table')
        .first()
        .evaluate((tableElement) => {
          tableElement.parentElement.scrollLeft =
            tableElement.parentElement.scrollWidth;
        });
      await customRow.getByTestId('mcp-device-copy').click();
      await expect(
        window.getByRole('dialog', { name: 'Edit MCP server' }),
      ).toBeVisible();
      await expect(details).toHaveCount(0);
    } finally {
      await closeCanopy(electronApp, userDataDir);
      await cloud.close();
    }
  });
}
