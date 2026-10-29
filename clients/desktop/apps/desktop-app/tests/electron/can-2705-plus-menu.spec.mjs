// CAN-2705 — the "+" menu on the New Task screen.
//
// Three reported defects, all reachable from the same control:
//
//   CAN-2706  the "+" said nothing on hover, and the attachment open panel
//             opened detached from the app rather than over it.
//   CAN-2707  "Open" on an attached file did nothing at all.
//   CAN-2708  the commands selector ran off the page at narrow widths,
//             rendered under the sidebar, and truncated descriptions with no
//             way to read the rest.
//
// The native open panel half of CAN-2706 is main-process behavior with no DOM
// to assert on; it is covered by the parented-dialog unit tests in
// `src/main/__tests__/{worktree-attachments,workspace-items}.test.ts`.
//
// Determinism: seeded demo workspace, no live agents, no network. The
// attachment is staged through a synthetic clipboard paste — the real user
// path for the New Task screen that does not require driving a native file
// picker — and "Open" is captured by a local HTTP receiver via
// `CANOPY_E2E_EXTERNAL_OPEN_CAPTURE_URL` instead of launching a host app.

import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { seedPluginsCache } from './seeders/seedPluginsCache.mjs';
import {
  seedCoworkWorkspace,
  seedWorkspaceApprovals,
  seedWorktreeChat,
} from './seeders/index.mjs';
import { withBundledBinaryOverridesScrubbed } from './seeders/bundledBinaryOverrides.mjs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { setUiScale } from './uiScale.mjs';

const DEMO_APP_ID = 'ts-pnpm-vite';

/** Local receiver standing in for the host's default application. */
async function startExternalOpenCapture() {
  const opened = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      try {
        opened.push(JSON.parse(body).url);
      } catch {
        // Ignore malformed payloads; the assertion below reports the gap.
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{}');
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}/__capture/external-open`,
    opened,
    close: () =>
      new Promise((resolve) => {
        server.close(resolve);
      }),
  };
}

async function openNewTaskScreen(window) {
  const app = new CanopyAppDriver(window);
  await app.waitForShell({ timeout: 30_000 });
  await window.getByTestId('sidebar-create-task').click();
  const homePage = window.getByTestId('page-home');
  await expect(homePage).toBeVisible();
  return homePage;
}

test('the "+" names what it opens on hover', async () => {
  const { electronApp, userDataDir } = await launchCanopy({
    seedDemoWorkspaces: true,
    demoWorkspaceApps: [DEMO_APP_ID],
  });

  try {
    const window = await electronApp.firstWindow();
    const homePage = await openNewTaskScreen(window);

    const plusButton = homePage.getByTestId('home-composer-plus-button');
    await expect(plusButton).toBeVisible();
    await expect(plusButton).toHaveAttribute('aria-label', 'More actions');

    await plusButton.hover();
    // The tooltip says what the menu is for and teaches its @ shortcut; the
    // accessible name above stays "More actions".
    const plusTooltip = window.getByRole('tooltip');
    await expect(plusTooltip).toContainText('Add files and more');
    await expect(plusTooltip.locator('kbd')).toHaveText('@');

    // The tooltip stands down once the menu it describes is open, so it never
    // covers the rows.
    await plusButton.click();
    await expect(window.getByTestId('home-composer-plus-menu')).toBeVisible();
    await expect(window.getByRole('tooltip')).toHaveCount(0);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('the commands selector stays on screen and readable at the narrowest supported width', async () => {
  // The narrowest content column a user can reach: the sidebar dragged to its
  // 480px maximum (it is not clamped against the window) in the narrowest
  // window. With the interface scale a uniform zoom, no scale makes text
  // larger relative to the layout any more, so this column is what
  // guarantees real text overflow below.
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'canopy-can2705-'));
  writeFileSync(
    path.join(userDataDir, 'preferences.json'),
    JSON.stringify({ version: 1, preferences: { sidebarWidth: 480 } }),
    'utf8',
  );
  seedDemoWorkspaces({ userDataDir, apps: [DEMO_APP_ID] });
  const { electronApp } = await launchCanopy({ userDataDir });

  try {
    const window = await electronApp.firstWindow();
    const homePage = await openNewTaskScreen(window);

    // The narrowest supported window at the largest scale the Display slider
    // offers. The interface scale is a uniform zoom and the window minimum
    // zooms with it (800 x 500 logical px at 100%, 1200 x 750 at 150%), so
    // this is an 800 x 700 CSS px viewport (`setUiScale` waits for the zoom).
    await window.setViewportSize({ width: 1200, height: 1050 });
    await setUiScale(window, 150);
    await homePage.getByTestId('home-composer-editor').fill('/');

    const popup = window.getByTestId('home-composer-plus-menu');
    await expect(popup).toBeVisible();

    const geometry = await popup.evaluate((element) => {
      const box = element.getBoundingClientRect();
      // Probe the popup's own midpoint: whatever paints there is what the
      // user can actually click.
      const midpoint = document.elementFromPoint(
        box.left + box.width / 2,
        box.top + box.height / 2,
      );
      return {
        left: box.left,
        top: box.top,
        right: box.right,
        bottom: box.bottom,
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
        hitIsInsidePopup: element.contains(midpoint),
      };
    });

    expect(geometry.left).toBeGreaterThanOrEqual(0);
    expect(geometry.top).toBeGreaterThanOrEqual(0);
    expect(geometry.right).toBeLessThanOrEqual(geometry.viewportWidth);
    expect(geometry.bottom).toBeLessThanOrEqual(geometry.viewportHeight);
    // Wherever it overlaps the sidebar, it must win the stacking contest.
    expect(geometry.hitIsInsidePopup).toBe(true);

    // Real command descriptions stay beside their labels and truncate.
    const descriptions = popup.locator('[data-action-description]');
    await expect.poll(() => descriptions.count()).toBeGreaterThan(0);
    const measured = await descriptions.evaluateAll((nodes) =>
      nodes.map((node) => {
        const style = getComputedStyle(node);
        const label = node.previousElementSibling;
        return {
          whiteSpace: style.whiteSpace,
          textOverflow: style.textOverflow,
          height: node.getBoundingClientRect().height,
          lineHeight: Number.parseFloat(style.lineHeight),
          labelTop: label.getBoundingClientRect().top,
          top: node.getBoundingClientRect().top,
          scrollWidth: node.scrollWidth,
          clientWidth: node.clientWidth,
        };
      }),
    );
    for (const row of measured) {
      expect(row.whiteSpace).toBe('nowrap');
      expect(row.textOverflow).toBe('ellipsis');
      expect(row.height).toBeLessThanOrEqual(row.lineHeight + 0.5);
      expect(Math.abs(row.top - row.labelTop)).toBeLessThanOrEqual(1);
    }
    expect(measured.some((row) => row.scrollWidth > row.clientWidth)).toBe(
      true,
    );
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('Open on a New Task attachment hands the file to the system default application', async () => {
  const capture = await startExternalOpenCapture();
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'canopy-can2705-'));
  seedDemoWorkspaces({ userDataDir, apps: [DEMO_APP_ID] });

  const { electronApp } = await launchCanopy({
    userDataDir,
    env: { CANOPY_E2E_EXTERNAL_OPEN_CAPTURE_URL: capture.url },
  });

  try {
    const window = await electronApp.firstWindow();
    const homePage = await openNewTaskScreen(window);

    // Stage an attachment the way a user does without a native picker: paste
    // an image into the composer.
    const editor = homePage.getByTestId('home-composer-editor');
    await expect(editor).toBeVisible();
    await editor.click();
    await editor.evaluate((node) => {
      // 1x1 transparent PNG.
      const bytes = Uint8Array.from(
        atob(
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk' +
            'YPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
        ),
        (character) => character.charCodeAt(0),
      );
      const file = new File([bytes], 'pasted.png', { type: 'image/png' });
      const transfer = new DataTransfer();
      transfer.items.add(file);
      node.dispatchEvent(
        new ClipboardEvent('paste', {
          clipboardData: transfer,
          bubbles: true,
          cancelable: true,
        }),
      );
    });

    const pill = homePage.getByTestId('attachment-pill').first();
    await expect(pill).toBeVisible({ timeout: 20_000 });

    await pill.hover();
    const openButton = window.getByRole('button', {
      name: 'Open',
      exact: true,
    });
    await expect(openButton).toBeVisible();
    await openButton.click();

    // CAN-2707: this used to route through `openFileTab`, which no-ops with
    // no selected worktree — the New Task screen's normal state — so the
    // button was clickable and inert.
    await expect
      .poll(() => capture.opened, { timeout: 15_000 })
      .toEqual([expect.stringMatching(/^file:\/\/.*\.png$/)]);
  } finally {
    await closeCanopy(electronApp, userDataDir);
    await capture.close();
  }
});

for (const surface of ['home', 'chat']) {
  test(`the ${surface} plus menu searches actions directly and preserves the draft`, async () => {
    const { electronApp, userDataDir } = await launchCanopy({
      seedDemoWorkspaces: true,
      demoWorkspaceApps: [DEMO_APP_ID],
    });
    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell();
      let editor;
      let prefix;
      if (surface === 'home') {
        const home = await openNewTaskScreen(window);
        editor = home.getByTestId('home-composer-editor');
        prefix = 'home-composer';
      } else {
        await app.openMainPage();
        await app.selectWorktree('demo-main');
        editor = window
          .getByTestId('panel-content-chat')
          .getByRole('textbox')
          .first();
        prefix = 'chat-input';
      }
      await editor.fill('Keep this draft.');
      const trigger = (
        surface === 'home'
          ? window.getByTestId('page-home')
          : window.getByTestId('panel-content-chat')
      ).getByTestId(`${prefix}-plus-button`);
      await trigger.click();
      const menu = window.getByTestId(`${prefix}-plus-menu`);
      await expect(menu.getByRole('textbox')).toHaveCount(0);
      await expect(
        menu.getByRole('button', { name: /^(Refresh|Loading…)$/ }),
      ).toHaveCount(0);
      await expect(editor).toBeFocused();
      await editor.pressSequentially('plugins');
      await expect(
        menu.getByRole('button', { name: /Plugins/ }).first(),
      ).toBeVisible();
      await editor.press('Escape');
      await expect(menu).toHaveCount(0);
      await expect(editor).toBeFocused();
      await expect(editor).toHaveText('Keep this draft.plugins');
      await editor.press('ControlOrMeta+A');
      await editor.press('Backspace');
      await editor.fill('Keep this draft.');
      for (let index = 0; index < 12; index++) await editor.press('ArrowLeft');
      await trigger.click();
      await menu
        .getByRole('button', { name: /Plugins/ })
        .first()
        .click();
      const picker = window
        .getByRole('dialog')
        .filter({ has: window.getByPlaceholder('Search by name…') });
      await expect(picker).toBeVisible();
      await expect(editor).toHaveText('Keep this draft.');
      await window.keyboard.press('Escape');
      await expect(picker).toBeHidden();
      await editor.fill('Keep this draft.');
      await trigger.click();
      await editor.pressSequentially('plugins');
      const pluginsRow = menu.getByRole('button', { name: /Plugins/ }).first();
      await expect(editor).toHaveAttribute(
        'aria-activedescendant',
        await pluginsRow.getAttribute('id'),
      );
      await editor.press('Enter');
      await expect(
        window
          .getByRole('dialog')
          .filter({ has: window.getByPlaceholder('Search by name…') }),
      ).toBeVisible();
      await expect(editor).toHaveText('Keep this draft.');
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });
}

for (const surface of ['home', 'chat']) {
  test(`the ${surface} composer itself filters the shared menu`, async () => {
    const { electronApp, userDataDir } = await launchCanopy({
      seedDemoWorkspaces: true,
      demoWorkspaceApps: [DEMO_APP_ID],
    });
    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell();
      const root =
        surface === 'home'
          ? await openNewTaskScreen(window)
          : window.getByTestId('panel-content-chat');
      if (surface === 'chat') {
        await app.openMainPage();
        await app.selectWorktree('demo-main');
      }
      const editor =
        surface === 'home'
          ? root.getByTestId('home-composer-editor')
          : root.getByRole('textbox').first();
      const prefix = surface === 'home' ? 'home-composer' : 'chat-input';
      const menu = window.getByTestId(`${prefix}-plus-menu`);
      for (const trigger of ['/', '@', '+']) {
        await editor.click();
        await editor.press('ControlOrMeta+A');
        await editor.press('Backspace');
        await editor.fill('Keep this draft. ');
        if (trigger === '+')
          await root.getByTestId(`${prefix}-plus-button`).click();
        else await editor.press(trigger);
        await expect(menu).toBeVisible();
        await expect(menu.getByRole('textbox')).toHaveCount(0);
        await expect(
          menu.locator('[data-action-row]:not(:disabled)').first(),
        ).toHaveClass(/(?:^| )bg-subtle(?: |$)/);
        await expect(menu.locator('.fg-secondary')).toHaveCount(0);
        const firstRow = menu
          .locator('[data-action-row]:not(:disabled)')
          .nth(0);
        const hoveredRow = menu
          .locator('[data-action-row]:not(:disabled)')
          .nth(1);
        await expect(editor).toHaveAttribute(
          'aria-activedescendant',
          await firstRow.getAttribute('id'),
        );
        await expect(firstRow).not.toHaveCSS(
          'background-color',
          'rgba(0, 0, 0, 0)',
        );
        await hoveredRow.hover();
        const hoverColor = await hoveredRow.evaluate(
          (element) => getComputedStyle(element).backgroundColor,
        );
        await editor.press('ArrowDown');
        await expect(firstRow).toHaveCSS('background-color', hoverColor);
        await expect(hoveredRow).toHaveCSS(
          'background-color',
          'rgba(0, 0, 0, 0)',
        );
        await editor.press('ArrowDown');
        await editor.press('ArrowDown');
        await expect(hoveredRow).toHaveCSS(
          'background-color',
          'rgba(0, 0, 0, 0)',
        );
        const hoverBox = await hoveredRow.boundingBox();
        await window.mouse.move(
          hoverBox.x + hoverBox.width / 2 + 2,
          hoverBox.y + hoverBox.height / 2,
        );
        await expect(hoveredRow).toHaveCSS('background-color', hoverColor);
        await expect(editor).not.toHaveAttribute('aria-activedescendant', /.+/);

        await expect(menu.getByTestId(`${prefix}-plus-attachment`)).toHaveCount(
          trigger === '/' ? 0 : 1,
        );
        await expect(menu).toHaveAttribute(
          'data-menu-variant',
          trigger === '/' ? 'commands' : 'add',
        );

        await expect(menu).toHaveCSS('animation-name', 'none');
        await expect(menu).toHaveCSS('animation-duration', '0s');
        const sections = menu.getByRole('group');
        await expect.poll(() => sections.count()).toBeGreaterThan(0);
        if ((await sections.count()) > 1)
          await expect(sections.first()).toHaveCSS('margin-bottom', '6px');
        await expect(sections.last()).toHaveCSS('margin-bottom', '0px');

        expect(
          await menu
            .locator('[data-action-row]')
            .first()
            .evaluate((element) => {
              const style = getComputedStyle(element);
              return [style.fontSize, style.lineHeight];
            }),
        ).toEqual(['13px', '18px']);

        const card =
          surface === 'home'
            ? root.getByTestId('home-composer')
            : root.locator('[data-chat-composer-root] > .rounded-2xl');
        await expect
          .poll(
            async () =>
              (await menu.locator('[data-action-row]').first().boundingBox())
                .height,
          )
          .toBeLessThanOrEqual(32);
        // The shared menu keeps its 20px corners independently of the
        // chat composer's 24px capsule introduced in #4318.
        await expect(menu).toHaveCSS('border-radius', '20px');
        await expect
          .poll(async () => (await menu.boundingBox()).height)
          .toBeLessThanOrEqual(280);
        await expect(menu.locator('[data-action-row]').first()).toHaveCSS(
          'border-radius',
          '16px',
        );
        const scrollViewport = menu.getByTestId(`${prefix}-menu-scroll`);
        await expect
          .poll(async () => {
            const viewportBox = await scrollViewport.boundingBox();
            const menuBox = await menu.boundingBox();
            return Math.abs(
              viewportBox.y + viewportBox.height - menuBox.y - menuBox.height,
            );
          })
          .toBeLessThanOrEqual(1);
        const finalRow = menu
          .locator('[data-action-row]:not(:disabled)')
          .last();
        // Discovery may replace the final row while the menu is opening.
        await expect(async () => {
          await finalRow.scrollIntoViewIfNeeded();
          await expect(finalRow).toBeInViewport();
        }).toPass();
        await menu
          .locator('[data-action-row]')
          .first()
          .scrollIntoViewIfNeeded();
        for (const width of [1400, 800]) {
          await window.setViewportSize({ width, height: 900 });
          await expect
            .poll(async () => {
              const menuBox = await menu.boundingBox();
              const cardBox = await card.boundingBox();
              return Math.max(
                Math.abs(menuBox.x - cardBox.x),
                Math.abs(menuBox.width - cardBox.width),
              );
            })
            .toBeLessThanOrEqual(1);
          if (surface === 'home') {
            await expect
              .poll(async () => {
                const menuBox = await menu.boundingBox();
                const cardBox = await card.boundingBox();
                return menuBox.y - (cardBox.y + cardBox.height);
              })
              .toBeGreaterThanOrEqual(4);
          }
          await expect
            .poll(async () => {
              const menuBox = await menu.boundingBox();
              const editorBox = await card.boundingBox();
              return (
                menuBox.y + menuBox.height <= editorBox.y ||
                menuBox.y >= editorBox.y + editorBox.height
              );
            })
            .toBe(true);
        }
        await expect(editor).toBeFocused();
        if (trigger === '/') {
          await editor.pressSequentially('model');
          await expect(menu.getByTestId(`${prefix}-file-result`)).toHaveCount(
            0,
          );
          await expect(
            menu.getByTestId(`${prefix}-capability-model`),
          ).toBeVisible();
          await editor.press('Escape');
          await expect(editor).toContainText('Keep this draft. /model');
          continue;
        }
        await editor.pressSequentially('package.json');
        await expect(
          menu.getByTestId(`${prefix}-file-result`).first(),
        ).toBeVisible();
        const fileId = await menu
          .getByTestId(`${prefix}-file-result`)
          .first()
          .getAttribute('id');
        // Inventory can finish loading while the user navigates; include
        // newly arrived rows instead of freezing the initial result count.
        for (
          let index = 0;
          index <=
          (await menu.locator('[data-action-row]:not(:disabled)').count());
          index++
        ) {
          await editor.press('ArrowDown');
          if ((await editor.getAttribute('aria-activedescendant')) === fileId)
            break;
        }
        await expect(editor).toHaveAttribute('aria-activedescendant', fileId);
        await expect(
          menu.getByTestId(`${prefix}-file-result`).first(),
        ).toHaveClass(/(?:^| )bg-subtle(?: |$)/);
        await expect(editor).toBeFocused();
        await editor.press('Enter');
        await expect(menu).toHaveCount(0);
        await expect(editor).toContainText('Keep this draft. ');
        await expect(editor).toContainText('package.json');
        await expect(editor.locator('[contenteditable="false"]')).toHaveCount(
          1,
        );
      }
      // At 800px the chat composer wraps the long no-match token, and ArrowUp
      // then moves the caret within it, which reopens the menu. Restore the
      // wide viewport so ArrowUp only dismisses.
      await window.setViewportSize({ width: 1400, height: 900 });
      await editor.pressSequentially(' @' + 'z'.repeat(40));
      await expect(menu).toBeVisible();
      await expect(menu.locator('[data-action-row]')).toHaveCount(0);
      await editor.press('ArrowUp');
      await expect(menu).toHaveCount(0);
      await expect(editor).toBeFocused();
      await expect(editor).toContainText('@' + 'z'.repeat(40));
      await root.getByTestId(`${prefix}-plus-button`).click();
      await expect(editor).toBeFocused();
      await editor.press('Tab');
      await expect(menu).toHaveCount(0);
      await expect(editor).not.toBeFocused();
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });
}

test('composer menu scrollbar settings do not reserve content width', async () => {
  const { electronApp, userDataDir } = await launchCanopy({
    seedDemoWorkspaces: true,
    demoWorkspaceApps: [DEMO_APP_ID],
  });
  try {
    const window = await electronApp.firstWindow();
    await window.setViewportSize({ width: 1400, height: 700 });
    const home = await openNewTaskScreen(window);
    await window.evaluate(() => {
      document.documentElement.dataset.scrollbarBehavior = 'always';
    });
    await home.getByTestId('home-composer-plus-button').click();
    const menu = window.getByTestId('home-composer-plus-menu');
    await expect(menu).toBeVisible();
    const geometry = () =>
      menu.evaluate((element) => {
        const row = element.querySelector('[data-action-row]');
        let viewport = row.parentElement;
        while (
          viewport &&
          !['auto', 'scroll'].includes(getComputedStyle(viewport).overflowY)
        )
          viewport = viewport.parentElement;
        if (!viewport) throw new Error('Scrollable menu viewport missing');
        const r = row.getBoundingClientRect();
        const v = viewport.getBoundingClientRect();
        return {
          gutter: viewport.offsetWidth - viewport.clientWidth,
          width: row.offsetWidth,
          left: r.left - v.left,
          right: v.right - r.right,
          overflow: viewport.scrollHeight > viewport.clientHeight,
        };
      });
    await expect.poll(async () => (await geometry()).overflow).toBe(true);
    await expect.poll(async () => (await geometry()).gutter).toBe(0);
    const before = await geometry();
    expect(Math.abs(before.left - before.right)).toBeLessThanOrEqual(1);
    const rail = menu.locator('[data-overlay-scrollbar]');
    await expect(rail).toHaveCSS('opacity', '1');
    const thumb = menu.locator('[data-overlay-scrollbar-thumb]');
    const scrollArea = menu.getByTestId('home-composer-menu-scroll');
    await expect(scrollArea).toHaveCSS(
      'mask-image',
      /(?:black|rgb\(0, 0, 0\)) 0px.*8px.*(?:transparent|rgba\(0, 0, 0, 0\))/,
    );
    await expect
      .poll(async () => {
        const t = await thumb.boundingBox();
        const m = await menu.boundingBox();
        return Math.abs(t.y - m.y - 20);
      })
      .toBeLessThanOrEqual(1);
    await scrollArea.evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });
    await expect
      .poll(async () => {
        const t = await thumb.boundingBox();
        const m = await menu.boundingBox();
        return Math.abs(m.y + m.height - t.y - t.height - 20);
      })
      .toBeLessThanOrEqual(1);
    await expect(scrollArea).toHaveCSS(
      'mask-image',
      /(?:transparent|rgba\(0, 0, 0, 0\)).*(?:black|rgb\(0, 0, 0\)) 8px.*100%.*(?:black|rgb\(0, 0, 0\))/,
    );
    await scrollArea.evaluate((el) => {
      el.scrollTop = 30;
    });
    await expect(scrollArea).toHaveCSS(
      'mask-image',
      /(?:transparent|rgba\(0, 0, 0, 0\)).*(?:black|rgb\(0, 0, 0\)) 8px.*8px.*(?:transparent|rgba\(0, 0, 0, 0\))/,
    );
    await scrollArea.evaluate((el) => {
      el.scrollTop = 0;
    });
    await window.evaluate(() => {
      document.documentElement.dataset.scrollbarBehavior = 'scroll';
    });
    await expect(rail).toHaveCSS('opacity', '0');
    expect((await geometry()).width).toBe(before.width);
    const viewport = menu.getByTestId('home-composer-menu-scroll');
    await viewport.hover();
    await window.mouse.wheel(0, 120);
    await expect
      .poll(() => viewport.evaluate((element) => element.scrollTop))
      .toBeGreaterThan(0);
    await expect(rail).toHaveCSS('opacity', '1');
    await expect(rail).toHaveCSS('opacity', '0');
    expect((await geometry()).width).toBe(before.width);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

for (const workspaceKind of ['code', 'cowork']) {
  test(`plus and mention select whole plugins in ${workspaceKind} and insert a plugin mention pill`, async () => {
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'composer-whole-plugin-'),
    );
    seedDemoWorkspaces({
      userDataDir,
      apps: [DEMO_APP_ID],
      checkRuntimes: false,
    });
    seedPluginsCache({ userDataDir });
    const { electronApp } = await launchCanopy({ userDataDir });
    try {
      const window = await electronApp.firstWindow();
      const home = await openNewTaskScreen(window);
      if (workspaceKind === 'cowork')
        await home.getByTestId('home-workspace-clear').click();
      const editor = home.getByTestId('home-composer-editor');
      await editor.fill('Use the available tools');
      await home.getByTestId('home-composer-plus-button').click();
      const plugin = window.getByTestId(
        'home-composer-plugin-demo/market-delta-tool',
      );
      await expect(plugin).toBeVisible();
      await plugin.click();
      await expect(window.getByTestId('home-composer-plus-menu')).toBeHidden();
      // Picking a whole plugin enables it AND drops an inline mention pill,
      // exactly like picking a file — no member invocation text.
      const homePills = editor.locator(
        '[data-testid="file-reference-pill"][data-mention-kind="plugin"]',
      );
      await expect(homePills).toHaveCount(1);
      await expect(homePills.first()).toHaveText('@delta-tool');
      await expect(editor).not.toContainText('/delta-tool');
      await editor.click();
      await editor.press('End');
      await editor.pressSequentially(' @delta');
      await expect(plugin).toBeVisible();
      await expect(plugin).toHaveAttribute('aria-pressed', 'true');
      await editor.press('Enter');
      await expect(window.getByTestId('home-composer-plus-menu')).toBeHidden();
      // An already-enabled plugin still becomes a mention; the typed `@delta`
      // trigger text is consumed by the pill.
      await expect(homePills).toHaveCount(2);
      await expect(editor).toHaveText(
        /^Use the available tools\s+@delta-tool\s+@delta-tool\s*$/,
      );
      await home.getByTestId('home-composer-plus-button').click();
      await expect(plugin).toHaveAttribute('aria-pressed', 'true');
      await editor.press('Escape');
      const app = new CanopyAppDriver(window);
      await app.openMainPage();
      await app.selectWorktree('demo-main');
      const chatEditor = window
        .getByTestId('panel-content-chat')
        .getByRole('textbox')
        .first();
      await chatEditor.fill('Keep my draft');
      await window.getByTestId('chat-input-plus-button').click();
      const chatPlugin = window.getByTestId(
        'chat-input-plugin-demo/market-delta-tool',
      );
      await expect(chatPlugin).toBeVisible();
      await chatPlugin.click();
      await expect(window.getByTestId('chat-input-plus-menu')).toBeHidden();
      const chatPills = chatEditor.locator(
        '[data-testid="file-reference-pill"][data-mention-kind="plugin"]',
      );
      await expect(chatPills).toHaveCount(1);
      await expect(chatPills.first()).toHaveText('@delta-tool');
      await expect(chatEditor).toContainText('Keep my draft');
      await window.getByTestId('chat-input-plus-button').click();
      await expect(chatPlugin).toHaveAttribute('aria-pressed', 'true');
      await expect(chatPlugin).toContainText('Enabled');
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });
}

test('a cowork chat composer enables a mentioned plugin like a code chat', async () => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'composer-plugin-mention-cowork-'),
  );
  const workspaceId = 'cowork-plugin-mention';
  const workEntryId = 'plugin-mention-entry';
  seedCoworkWorkspace({
    userDataDir,
    workspaceId,
    name: 'Cowork plugin mention',
    collapsed: false,
    chatId: workEntryId,
    chatTitle: 'Plugin mention entry',
  });
  // The seeded cowork chat runs on Codex, and the menu only lists plugins the
  // selected provider can load, so seed one that Codex supports.
  seedPluginsCache({
    userDataDir,
    additionalPlugins: [
      {
        name: 'cowork-tool',
        description: 'Works on Claude and Codex',
        providerSupport: { claude: 'native', codex: 'native' },
      },
    ],
  });
  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    const toggle = window.getByTestId(
      `sidebar-cowork-project-${workspaceId}-toggle`,
    );
    if ((await toggle.getAttribute('aria-expanded')) !== 'true') {
      await toggle.click();
    }
    await window.getByTestId(`sidebar-work-entry-${workEntryId}`).click();
    await expect(window.getByTestId('panel-content-chat')).toBeVisible({
      timeout: 30_000,
    });
    const editor = window
      .getByTestId('panel-content-chat')
      .getByRole('textbox')
      .first();
    await editor.fill('Use ');
    await window.getByTestId('chat-input-plus-button').click();
    const pluginRow = window.getByTestId(
      'chat-input-plugin-demo/market-cowork-tool',
    );
    await expect(pluginRow).toBeVisible();
    await expect(pluginRow).toHaveAttribute('aria-pressed', 'false');
    await pluginRow.click();
    await expect(
      editor.locator(
        '[data-testid="file-reference-pill"][data-mention-kind="plugin"]',
      ),
    ).toHaveCount(1);
    // Cowork chats have no watcher destination, but they do carry plugin
    // selections: the pick must enable the plugin here too.
    await window.getByTestId('chat-input-plus-button').click();
    await expect(pluginRow).toHaveAttribute('aria-pressed', 'true');
    await expect(pluginRow).toContainText('Enabled');
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('sending a message re-enables a mentioned plugin that was removed from the chat', async () => {
  test.setTimeout(180_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'composer-plugin-mention-reenable-'),
  );
  seedDemoWorkspaces({
    userDataDir,
    apps: [DEMO_APP_ID],
    checkRuntimes: false,
  });
  seedPluginsCache({ userDataDir });
  seedWorkspaceApprovals({
    userDataDir,
    workspaceId: 'demo-ts-pnpm-vite',
    defaultMode: 'full-access',
  });
  seedWorktreeChat({
    userDataDir,
    workspaceId: 'demo-ts-pnpm-vite',
    worktreeId: 'demo-main',
    providerType: 'claude',
    tabs: [{ id: 'mention-tab', title: 'Mention' }],
    activeTabId: 'mention-tab',
  });
  // No scenario: the submitted text now starts with the `Mentioned plugins:`
  // preamble, so a leading `[marker]` cannot be matched by the mock provider.
  // The default mock reply is enough — the assertion is on enablement.
  const marker = 'plugin-mention-reenable';
  const { electronApp } = await withBundledBinaryOverridesScrubbed(() =>
    launchCanopy({ userDataDir }),
  );
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    await app.selectWorktree('demo-main');
    const editor = window
      .getByTestId('panel-content-chat')
      .getByRole('textbox')
      .first();
    const pluginRow = window.getByTestId(
      'chat-input-plugin-demo/market-delta-tool',
    );

    // 1. Mentioning the plugin drops the pill and enables it.
    await editor.fill(`[${marker}] use `);
    await editor.press('End');
    await editor.pressSequentially('@delta');
    await expect(pluginRow).toBeVisible();
    await editor.press('Enter');
    await expect(
      editor.locator(
        '[data-testid="file-reference-pill"][data-mention-kind="plugin"]',
      ),
    ).toHaveCount(1);
    await window.getByTestId('chat-input-plus-button').click();
    await expect(pluginRow).toHaveAttribute('aria-pressed', 'true');

    // 2. The user removes the plugin again from the Plugins picker, but
    //    leaves the pill in the draft.
    await window.getByTestId('chat-plugins-button').click();
    const dialog = window
      .locator('[role="dialog"]')
      .filter({ hasText: 'Plugins' });
    await expect(dialog).toBeVisible();
    await dialog.getByPlaceholder('Search by name…').fill('delta-tool');
    const checkbox = dialog.getByRole('checkbox', {
      name: 'Select delta-tool',
    });
    await expect(checkbox).toBeChecked();
    await checkbox.click();
    await expect(checkbox).not.toBeChecked();
    await dialog.getByRole('button', { name: 'Save' }).click();
    await expect(dialog).toHaveCount(0);
    await window.getByTestId('chat-input-plus-button').click();
    await expect(pluginRow).toHaveAttribute('aria-pressed', 'false');
    await editor.press('Escape');
    await expect(window.getByTestId('chat-input-plus-menu')).toBeHidden();

    // 3. Sending re-enables the mentioned plugin before the turn starts.
    await editor.click();
    await editor.press('End');
    await editor.press('Enter');
    await expect(window.getByTestId('chat-message-list-content')).toContainText(
      'Completed in',
      { timeout: 60_000 },
    );
    await window.getByTestId('chat-input-plus-button').click();
    await expect(pluginRow).toHaveAttribute('aria-pressed', 'true');
    await expect(pluginRow).toContainText('Enabled');
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('projectless Plan menu action reflects its toggle state and uses the map icon', async () => {
  const { electronApp, userDataDir } = await launchCanopy({
    seedDemoWorkspaces: true,
    demoWorkspaceApps: [DEMO_APP_ID],
  });
  try {
    const window = await electronApp.firstWindow();
    const home = await openNewTaskScreen(window);
    await home.getByTestId('home-workspace-clear').click();
    const plus = home.getByTestId('home-composer-plus-button');
    const menu = window.getByTestId('home-composer-plus-menu');
    await plus.click();
    const plan = menu.getByRole('button', { name: /^Plan / });
    await expect(plan).toHaveAttribute('aria-pressed', 'false');
    const tile = home.getByTestId('home-plan-mode-inline-button');
    await expect(tile).toHaveCount(0);
    await plan.click();
    await expect(menu).toBeHidden();
    // Plan shows its tile beside +; + itself only lights for Pipeline.
    await expect(tile).toBeVisible();
    await expect(tile).toHaveAttribute('aria-pressed', 'true');
    await expect(plus).not.toHaveAttribute('data-active', 'true');
    await plus.click();
    await expect(plan).toHaveAttribute('aria-pressed', 'true');
    await expect(plan).toContainText('Turn plan mode off');
    await expect(plan.locator('svg')).toHaveCount(1);
    await plan.click();
    await expect(tile).toHaveCount(0);
    await expect(plus).not.toHaveAttribute('data-active', 'true');
    await plus.click();
    await expect(plan).toHaveAttribute('aria-pressed', 'false');
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
