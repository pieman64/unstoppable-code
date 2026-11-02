// CAN-3048 — Cmd/Ctrl+F opens one floating find bar whose mode follows the
// focused surface (chat, browser chrome, or previewed file).
//
// SCOPE. Covers the renderer routing end to end in the real app:
//
//   1. Composer focus → chat mode with the exact placeholder and a real
//      transcript count; Escape closes and returns focus to the composer;
//      a repeated chord keeps the bar open with the input focused.
//   2. The mode toggles switch from chat to a browser tab in another group
//      and back without losing the query; browser mode shows a real
//      `found-in-page` count from a loopback page, and Enter moves the active
//      match. The file toggle is absent while no file panel is open.
//   3. Browser chrome focus → browser mode with the exact placeholder and the
//      query the tab was last searched with; the chat shown in the other
//      group is offered as a toggle without clicking into it first.
//   4. Two Browser panels side by side: the chord in each targets that panel,
//      the bar shows one numbered browser toggle per panel (its page title as
//      the tooltip), and picking one moves the search (query kept). Switching
//      worktree closes the bar; back in the first worktree the chord reopens
//      it with the remembered query.
//   5. Two chats stacked in one column: the toggles number them top to
//      bottom even when the top chat registered with the bar last.
//
// File mode (placeholder, highlights, navigation, repeat chord, Escape) is
// covered by `html-file-preview.spec.mjs`. The native-page half (the chord
// pressed while the `WebContentsView` page owns focus) cannot be driven by
// Playwright, as in `shortcut-context-new-tab.spec.mjs`; it is covered by
// `browser-shortcuts.test.ts`, `browser-service.test.ts`, and
// `browserEventSubscription.test.ts`.

import { createServer } from 'node:http';
import { expect, test } from '@playwright/test';
import { closeCanopy } from './launchCanopy.mjs';
import {
  DEFAULT_GROUP_IDS,
  SEEDED_CHAT_TAB_ID,
  chatPanelLocator,
  movePanelViaApi,
  seedPanelWorktree,
  splitViaApi,
} from './panelHarness.mjs';
import { seedWorktreeChat } from './seeders/index.mjs';

const NEEDLE = 'zephyr';

test.describe('focused-surface find bar (CAN-3048)', () => {
  test.setTimeout(180_000);

  test('Cmd/Ctrl+F searches the focused chat or browser tab and switches modes', async () => {
    const server = createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(
        `<!doctype html><title>find page</title>` +
          `<p>${NEEDLE} one</p><p>${NEEDLE} two</p><p>${NEEDLE} three</p>`,
      );
    });
    await new Promise((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve(undefined));
    });
    const { port } = server.address();

    const { electronApp, userDataDir, window } = await seedPanelWorktree({
      // Re-seed the harness chat tab with one known transcript line.
      onBeforeLaunch: ({ userDataDir: dir, workspaceIds }) => {
        seedWorktreeChat({
          userDataDir: dir,
          workspaceId: workspaceIds[0],
          worktreeId: 'demo-main',
          providerType: 'claude',
          tabs: [
            {
              id: SEEDED_CHAT_TAB_ID,
              title: 'Chat',
              blocks: [{ type: 'text', text: `The ${NEEDLE} line.` }],
            },
          ],
        });
      },
    });

    try {
      const bar = window.getByTestId('surface-find-bar');
      const input = bar.getByRole('textbox');
      const composer = window.locator('[data-chat-textarea]:visible').first();

      // A Browser panel in the other group, on a page with three matches.
      await window.getByTestId('panel-add-tab-group-terminal').click();
      await expect(window.getByTestId('panel-add-menu')).toBeVisible();
      await window.getByTestId('panel-add-menu-item-browser').click();
      await expect(window.getByTestId('browser-panel-surface')).toBeVisible();
      const urlInput = window.getByTestId('browser-url-input');
      await urlInput.fill(`http://127.0.0.1:${port}/find`);
      await urlInput.press('Enter');
      await expect(
        window.locator('[data-testid^="panel-tab-panel-browser-"]').first(),
      ).toContainText('find page', { timeout: 20_000 });

      // --- Chat mode from the composer --------------------------------------
      await expect(
        window
          .locator('[data-testid="panel-content-chat"]:visible')
          .getByText(`The ${NEEDLE} line.`),
      ).toBeVisible({ timeout: 20_000 });
      await composer.click();
      await window.keyboard.press('ControlOrMeta+f');
      await expect(bar).toBeVisible();
      await expect(bar).toHaveAttribute('data-find-mode', 'chat');
      await expect(input).toHaveAttribute(
        'placeholder',
        'Search the chat history.',
      );
      await expect(input).toBeFocused();
      // The file toggle only exists while a searchable file is open.
      await expect(window.getByTestId('surface-find-mode-file')).toHaveCount(0);
      await input.fill(NEEDLE);
      await expect(bar).toContainText('1 of 1');

      // A repeated chord keeps the bar and its query, with the input focused.
      await window.keyboard.press('ControlOrMeta+f');
      await expect(input).toBeFocused();
      await expect(input).toHaveValue(NEEDLE);

      // --- Mode switching keeps the query -----------------------------------
      await window.getByTestId('surface-find-mode-browser').click();
      await expect(bar).toHaveAttribute('data-find-mode', 'browser');
      await expect(input).toHaveValue(NEEDLE);
      await expect(bar).toContainText('1 of 3', { timeout: 20_000 });
      await input.press('Enter');
      await expect(bar).toContainText('2 of 3', { timeout: 20_000 });

      await window.getByTestId('surface-find-mode-chat').click();
      await expect(bar).toHaveAttribute('data-find-mode', 'chat');
      await expect(input).toHaveValue(NEEDLE);
      await expect(bar).toContainText('1 of 1');

      // Escape closes and returns focus to where the chord was pressed.
      await input.press('Escape');
      await expect(bar).toHaveCount(0);
      await expect(composer).toBeFocused();

      // --- Browser mode from the browser chrome -----------------------------
      await window.getByTestId('browser-refresh').focus();
      await window.keyboard.press('ControlOrMeta+f');
      await expect(bar).toBeVisible();
      await expect(bar).toHaveAttribute('data-find-mode', 'browser');
      await expect(input).toHaveAttribute(
        'placeholder',
        'Search the browser tab.',
      );
      await expect(input).toBeFocused();
      // The browser tab remembers the query it was searched with earlier,
      // when the mode toggles moved the bar through it.
      await expect(input).toHaveValue(NEEDLE);
      await expect(bar).toContainText('1 of 3', { timeout: 20_000 });
      // The chat in the other (inactive) group is shown, so its toggle is
      // offered without first clicking into the chat.
      await window.getByTestId('surface-find-mode-chat').click();
      await expect(bar).toHaveAttribute('data-find-mode', 'chat');
      await expect(bar).toContainText('1 of 1');

      await input.press('Escape');
      await expect(bar).toHaveCount(0);
    } finally {
      await closeCanopy(electronApp, userDataDir);
      server.close();
    }
  });
  test('numbered toggles pick between two browser panels, and a worktree switch remembers the query', async () => {
    const pages = {
      '/a': { title: 'find page A', count: 3 },
      '/b': { title: 'find page B', count: 2 },
    };
    const server = createServer((req, res) => {
      const page = pages[req.url] ?? pages['/a'];
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(
        `<!doctype html><title>${page.title}</title>` +
          Array.from(
            { length: page.count },
            (_, index) => `<p>${NEEDLE} ${index + 1}</p>`,
          ).join(''),
      );
    });
    await new Promise((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve(undefined));
    });
    const { port } = server.address();

    const { electronApp, userDataDir, window } = await seedPanelWorktree({
      // A second workspace gives the sidebar a second worktree to switch to.
      apps: ['ts-pnpm-vite', 'ts-yarn-cli'],
      onBeforeLaunch: ({ userDataDir: dir, workspaceIds }) => {
        seedWorktreeChat({
          userDataDir: dir,
          workspaceId: workspaceIds[0],
          worktreeId: 'demo-main',
          providerType: 'claude',
          tabs: [
            {
              id: SEEDED_CHAT_TAB_ID,
              title: 'Chat',
              blocks: [{ type: 'text', text: `The ${NEEDLE} line.` }],
            },
          ],
        });
      },
    });

    try {
      const bar = window.getByTestId('surface-find-bar');
      const input = bar.getByRole('textbox');
      const composer = window.locator('[data-chat-textarea]:visible').first();
      const surfaces = window.locator('[data-browser-surface]');

      // Browser A in the terminal group, browser B in a new group to its right.
      const openBrowserIn = async (groupId, path, title) => {
        await window.getByTestId(`panel-add-tab-${groupId}`).click();
        await expect(window.getByTestId('panel-add-menu')).toBeVisible();
        await window.getByTestId('panel-add-menu-item-browser').click();
        const urlInput = window
          .locator('[data-testid="browser-url-input"]:visible')
          .last();
        await urlInput.fill(`http://127.0.0.1:${port}${path}`);
        await urlInput.press('Enter');
        await expect(
          window.locator('[data-testid^="panel-tab-panel-browser-"]').filter({
            hasText: title,
          }),
        ).toBeVisible({ timeout: 20_000 });
      };
      await openBrowserIn(DEFAULT_GROUP_IDS.terminal, '/a', 'find page A');
      const rightGroup = await splitViaApi(
        window,
        DEFAULT_GROUP_IDS.terminal,
        'right',
      );
      await openBrowserIn(rightGroup, '/b', 'find page B');
      await expect(surfaces).toHaveCount(2);

      // --- The chord targets the browser under focus ------------------------
      await surfaces.nth(0).getByTestId('browser-refresh').focus();
      await window.keyboard.press('ControlOrMeta+f');
      await expect(bar).toHaveAttribute('data-find-mode', 'browser');
      await input.fill(NEEDLE);
      await expect(bar).toContainText('1 of 3', { timeout: 20_000 });

      await surfaces.nth(1).getByTestId('browser-refresh').focus();
      await window.keyboard.press('ControlOrMeta+f');
      await expect(input).toHaveValue(NEEDLE);
      await expect(bar).toContainText('1 of 2', { timeout: 20_000 });

      // --- One numbered browser toggle per panel ----------------------------
      await expect(window.getByTestId('surface-find-mode-browser')).toHaveCount(
        0,
      );
      const toggles = window.locator(
        '[data-testid^="surface-find-scope-browser-"]',
      );
      await expect(toggles).toHaveText(['1', '2']);
      await expect(toggles.nth(0)).toHaveAttribute(
        'aria-label',
        'Search browser tab 1: find page A',
      );
      await expect(toggles.nth(1)).toHaveAttribute(
        'aria-label',
        'Search browser tab 2: find page B',
      );
      await expect(toggles.nth(1)).toHaveAttribute('aria-pressed', 'true');
      await toggles.nth(0).click();
      await expect(toggles.nth(0)).toHaveAttribute('aria-pressed', 'true');
      await expect(input).toHaveValue(NEEDLE);
      await expect(bar).toContainText('1 of 3', { timeout: 20_000 });
      await input.press('Escape');
      await expect(bar).toHaveCount(0);

      // --- A worktree switch closes the bar and remembers the query ---------
      await composer.click();
      await window.keyboard.press('ControlOrMeta+f');
      await expect(bar).toHaveAttribute('data-find-mode', 'chat');
      await input.fill(NEEDLE);
      await expect(bar).toContainText('1 of 1');

      // Both demo workspaces expose a `demo-main` row; the second workspace's
      // row is the other worktree. Click the canonical rows directly, as the
      // browser-chrome flow does, since the driver resolves by branch name.
      const rows = window.getByTestId('worktree-row');
      await expect(rows).toHaveCount(2);
      await rows.nth(1).evaluate((element) => element.click());
      await expect(window.getByTestId('panel-grid-root')).toBeVisible();
      await expect(bar).toHaveCount(0);

      await rows.nth(0).evaluate((element) => element.click());
      await expect(
        window
          .locator('[data-testid="panel-content-chat"]:visible')
          .getByText(`The ${NEEDLE} line.`),
      ).toBeVisible({ timeout: 20_000 });
      await window.locator('[data-chat-textarea]:visible').first().click();
      await window.keyboard.press('ControlOrMeta+f');
      await expect(bar).toHaveAttribute('data-find-mode', 'chat');
      await expect(input).toHaveValue(NEEDLE);
      await expect(bar).toContainText('1 of 1');
      await input.press('Escape');
    } finally {
      await closeCanopy(electronApp, userDataDir);
      server.close();
    }
  });

  test('numbered toggles follow the on-screen order, not the order panels were shown', async () => {
    const SECOND_CHAT_ID = 'find-second-chat';
    const { electronApp, userDataDir, window } = await seedPanelWorktree({
      onBeforeLaunch: ({ userDataDir: dir, workspaceIds }) => {
        seedWorktreeChat({
          userDataDir: dir,
          workspaceId: workspaceIds[0],
          worktreeId: 'demo-main',
          providerType: 'claude',
          tabs: [
            {
              id: SEEDED_CHAT_TAB_ID,
              title: 'Top chat',
              blocks: [{ type: 'text', text: `The top ${NEEDLE} line.` }],
            },
            {
              id: SECOND_CHAT_ID,
              title: 'Bottom chat',
              blocks: [{ type: 'text', text: `The bottom ${NEEDLE} line.` }],
            },
          ],
        });
      },
    });

    try {
      const bar = window.getByTestId('surface-find-bar');
      const input = bar.getByRole('textbox');
      const topChat = chatPanelLocator(window, SEEDED_CHAT_TAB_ID);
      const bottomChat = chatPanelLocator(window, SECOND_CHAT_ID);

      // Show the second chat first, then move it into a group below: the top
      // chat comes back on screen, and registers with the bar, last.
      await window
        .getByTestId(`panel-tab-panel-chat-${SECOND_CHAT_ID}`)
        .click();
      await expect(
        bottomChat.getByText(`The bottom ${NEEDLE} line.`),
      ).toBeVisible({
        timeout: 20_000,
      });
      const lowerGroup = await splitViaApi(
        window,
        DEFAULT_GROUP_IDS.chat,
        'down',
      );
      await movePanelViaApi(
        window,
        `panel-chat-${SECOND_CHAT_ID}`,
        lowerGroup,
        'center',
      );
      await expect(topChat.getByText(`The top ${NEEDLE} line.`)).toBeVisible({
        timeout: 20_000,
      });
      await expect(
        bottomChat.getByText(`The bottom ${NEEDLE} line.`),
      ).toBeVisible();
      const [topBox, bottomBox] = await Promise.all([
        topChat.boundingBox(),
        bottomChat.boundingBox(),
      ]);
      expect(topBox && bottomBox && topBox.y < bottomBox.y).toBe(true);

      await topChat.locator('[data-chat-textarea]').first().click();
      await window.keyboard.press('ControlOrMeta+f');
      await expect(bar).toHaveAttribute('data-find-mode', 'chat');
      const toggles = window.locator(
        '[data-testid^="surface-find-scope-chat-"]',
      );
      await expect(toggles).toHaveText(['1', '2']);
      // Chat titles stay out of attributes (session replay records them);
      // the toggles take their names from masked labels.
      await expect(toggles.nth(0)).toHaveAccessibleName(/: Top chat$/);
      await expect(toggles.nth(1)).toHaveAccessibleName(/: Bottom chat$/);
      await expect(toggles.nth(0)).not.toHaveAttribute('aria-label');
      await expect(toggles.nth(0)).toHaveAttribute('aria-pressed', 'true');
      await input.press('Escape');
      await expect(bar).toHaveCount(0);
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });
});
