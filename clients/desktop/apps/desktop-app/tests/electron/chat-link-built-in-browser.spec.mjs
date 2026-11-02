// A web link in an agent's reply follows "Open links in the built-in
// browser" even after an iframe in the window (an agent visual, an HTML
// preview) has loaded. Main used to treat any load start, including a
// sub-frame's, as a renderer reload, and from then on sent every chat link to
// the system browser.
import http from 'node:http';
import { expect, test } from '@playwright/test';
import { closeCanopy } from './launchCanopy.mjs';
import { CanopyAppDriver } from './canopyApp.mjs';
import { SEEDED_CHAT_TAB_ID, seedPanelWorktree } from './panelHarness.mjs';
import { seedWorktreeChat } from './seeders/index.mjs';

const PAGE_TITLE = 'Coordinator fixture';

async function startLocalPage() {
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html' });
    response.end(
      `<!doctype html><html><head><title>${PAGE_TITLE}</title></head><body><h1>Coordinator</h1></body></html>`,
    );
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}/coordinator.html`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

async function startExternalOpenCapture() {
  const opened = [];
  const server = http.createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => {
      body += chunk;
    });
    request.on('end', () => {
      try {
        opened.push(JSON.parse(body).url);
      } catch {
        // Ignore malformed payloads; the assertion reports the gap.
      }
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end('{}');
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}/__capture/external-open`,
    opened,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

test('a chat link opens in the built-in browser after an iframe loads', async () => {
  test.setTimeout(150_000);
  const page = await startLocalPage();
  const externalOpen = await startExternalOpenCapture();
  const launched = await seedPanelWorktree({
    env: { CANOPY_E2E_EXTERNAL_OPEN_CAPTURE_URL: externalOpen.url },
    onBeforeLaunch: ({ userDataDir, workspaceIds }) => {
      seedWorktreeChat({
        userDataDir,
        workspaceId: workspaceIds[0],
        worktreeId: 'demo-main',
        providerType: 'claude',
        tabs: [
          {
            id: SEEDED_CHAT_TAB_ID,
            title: 'Chat',
            blocks: [
              {
                type: 'text',
                text: `The coordinator page is ready: [coordinator](${page.url})`,
              },
            ],
          },
        ],
      });
    },
  });

  try {
    const { window } = launched;
    const app = new CanopyAppDriver(window);
    await app.openSettings();
    await app.openSettingsSection('browser');
    await expect(
      window.getByTestId('settings-browser-open-app-links-in-built-in-browser'),
    ).toHaveAttribute('aria-checked', 'true');
    await app.closeSettings();

    const chatLink = window
      .locator('[data-testid="panel-content-chat"]:visible')
      .locator(`a[href="${page.url}"]`);
    await expect(chatLink).toBeVisible({ timeout: 30_000 });

    // Any iframe loading in the main window, such as an agent visual.
    await window.evaluate(
      () =>
        new Promise((resolve) => {
          const frame = document.createElement('iframe');
          frame.dataset.testid = 'chat-link-subframe-fixture';
          frame.setAttribute('sandbox', '');
          frame.style.cssText =
            'position:fixed;width:1px;height:1px;opacity:0;pointer-events:none';
          frame.addEventListener('load', () => resolve(undefined), {
            once: true,
          });
          frame.srcdoc = '<p>visual</p>';
          document.body.append(frame);
        }),
    );

    const panesBefore = await window
      .locator('[data-testid^="browser-pane-"]')
      .count();
    await chatLink.click();

    await expect
      .poll(() => window.locator('[data-testid^="browser-pane-"]').count(), {
        timeout: 30_000,
      })
      .toBeGreaterThan(panesBefore);
    await expect(window.getByTestId('browser-pane-loading')).toHaveCount(0, {
      timeout: 30_000,
    });
    await expect
      .poll(() =>
        launched.electronApp
          .windows()
          .some((candidate) => candidate.url() === page.url),
      )
      .toBe(true);
    expect(externalOpen.opened).toEqual([]);
  } finally {
    await closeCanopy(launched.electronApp, launched.userDataDir);
    await page.close();
    await externalOpen.close();
  }
});
