// REG-2916 — desktop file-tab PDF preview acceptance coverage.
//
// These tests deliberately keep success, failure/recovery, and lifecycle in
// separate Electron launches. A failure in the first unsupported state must
// not prevent the other contracts from being exercised.
import { createServer } from 'node:http';
import {
  mkdirSync,
  mkdtempSync,
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
  DEFAULT_GROUP_IDS,
  movePanelViaApi,
  splitViaApi,
} from './panelHarness.mjs';
import { seedWorktreeChat } from './seeders/seedWorktreeChat.mjs';
import {
  buildReg2901PartiallyDamagedPdfFixture,
  buildReg2901PdfFixture,
} from './portal/fixtures/reg-2901-pdf-fixture.mjs';

const WORKSPACE_ID = 'demo-ts-pnpm-vite';
const WORKTREE_ID = 'demo-main';
const PDF_BYTES = buildReg2901PdfFixture();
const PARTIAL_PDF_BYTES = buildReg2901PartiallyDamagedPdfFixture();
const ONE_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+X8WcWQAAAABJRU5ErkJggg==',
  'base64',
);

function seedPdfFiles(worktreePath) {
  const paths = {
    brief: path.join(worktreePath, 'brief.pdf'),
    briefTwo: path.join(worktreePath, 'brief-two.pdf'),
    corrupt: path.join(worktreePath, 'corrupt.pdf'),
    partial: path.join(worktreePath, 'partial.pdf'),
    huge: path.join(worktreePath, 'huge.pdf'),
    text: path.join(worktreePath, 'pdf-neighbor.txt'),
    image: path.join(worktreePath, 'pdf-neighbor.png'),
    setup: path.join(worktreePath, 'setup-created.pdf'),
  };
  writeFileSync(paths.brief, PDF_BYTES);
  writeFileSync(paths.briefTwo, PDF_BYTES);
  writeFileSync(paths.corrupt, Buffer.from('not a valid pdf'));
  writeFileSync(paths.partial, PARTIAL_PDF_BYTES);
  writeFileSync(paths.huge, Buffer.alloc(25 * 1024 * 1024 + 1));
  writeFileSync(paths.text, 'PDF lifecycle text neighbor\n', 'utf8');
  writeFileSync(paths.image, ONE_PIXEL_PNG);
  return paths;
}

function fileTab(id, title, filePath) {
  return {
    id,
    title,
    kind: 'file',
    filePath,
    fileViewMode: 'raw',
    description: filePath,
    messages: [],
  };
}

function activeFilePanel(window) {
  return window.locator('[data-testid="panel-content-file-diff"]:visible');
}

async function openFromPanelTree(window, name) {
  const panel = activeFilePanel(window);
  const toggle = panel.getByTestId('file-tab-tree-toggle');
  if (!(await panel.getByTestId('file-tab-tree').isVisible())) {
    await toggle.click();
  }
  const tree = panel.getByTestId('file-tab-tree');
  const row = tree.locator(
    `[data-testid="files-tree-row"][data-path="${name}"]`,
  );
  await expect(row).toBeVisible({ timeout: 20_000 });
  await row.click();
  await expect(
    activeFilePanel(window).getByTestId('file-breadcrumb-segment-file'),
  ).toHaveText(name);
  return activeFilePanel(window);
}

async function startExternalOpenCapture() {
  const opened = [];
  const server = createServer((request, response) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => {
      body += chunk;
    });
    request.on('end', () => {
      try {
        opened.push(JSON.parse(body).url);
      } catch {
        opened.push('malformed external-open request');
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{}');
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('capture server did not bind');
  return {
    opened,
    url: `http://127.0.0.1:${String(address.port)}/external-open`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

async function openSeededWorkspace(window) {
  const app = new CanopyAppDriver(window);
  await app.waitForShell({ timeout: 30_000 });
  await app.openMainPage();
  await app.selectWorktree(WORKTREE_ID);
}

async function instrumentFileReads(electronApp) {
  await electronApp.evaluate(({ ipcMain }) => {
    globalThis.__reg2916FileReads = { preview: [], content: [], document: [] };
    const channels = {
      'file:read-preview': 'preview',
      'file:read-content': 'content',
      'file:read-document-bytes': 'document',
    };
    for (const [channel, bucket] of Object.entries(channels)) {
      const original = ipcMain._invokeHandlers?.get(channel);
      if (typeof original !== 'function') continue;
      ipcMain.removeHandler(channel);
      ipcMain.handle(channel, (event, request) => {
        globalThis.__reg2916FileReads[bucket].push(request);
        return original(event, request);
      });
    }
  });
}

function getInstrumentedFileReads(electronApp) {
  return electronApp.evaluate(() => globalThis.__reg2916FileReads);
}

async function findPdfWorkerIndex(window, workers, expectedModuleUrl) {
  for (let index = 0; index < workers.length; index += 1) {
    const workerUrl = workers[index].url();
    if (workerUrl === expectedModuleUrl) return index;
    if (!workerUrl.startsWith('blob:')) continue;
    const wrapperSource = await window.evaluate(async (url) => {
      const response = await fetch(url);
      return response.text();
    }, workerUrl);
    if (wrapperSource.includes(expectedModuleUrl)) return index;
  }
  return -1;
}

async function expectRenderedPdf(panel) {
  const preview = panel.getByTestId('pdf-preview');
  await expect(preview).toBeVisible({ timeout: 60_000 });
  await expect(preview.getByTestId('pdf-preview-page')).toHaveCount(2);
  await expect(preview.getByTestId('pdf-preview-page-canvas')).toHaveCount(2);
  for (const canvas of await preview
    .getByTestId('pdf-preview-page-canvas')
    .all()) {
    await expect
      .poll(() => canvas.evaluate((node) => node.width * node.height))
      .toBeGreaterThan(0);
  }
  return preview;
}

test('renders a selectable, searchable and responsive two-page PDF in a desktop file tab', async () => {
  test.setTimeout(180_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-reg-2916-success-'),
  );
  const seed = seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  const worktreePath = seed.workspaces[0]?.worktreePath;
  expect(worktreePath, 'seeded worktree path').toBeTruthy();
  const files = seedPdfFiles(worktreePath);
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    activeTabId: 'brief',
    tabs: [fileTab('brief', 'brief.pdf', files.brief)],
  });
  const external = await startExternalOpenCapture();
  const { electronApp } = await launchCanopy({
    userDataDir,
    env: { CANOPY_E2E_EXTERNAL_OPEN_CAPTURE_URL: external.url },
  });
  try {
    const window = await electronApp.firstWindow();
    const navigations = [];
    const remotePdfRequests = [];
    window.on('framenavigated', (frame) => {
      if (frame === window.mainFrame()) navigations.push(frame.url());
    });
    await window.route(/^https?:\/\//, async (route) => {
      const url = new URL(route.request().url());
      if (!['127.0.0.1', 'localhost'].includes(url.hostname)) {
        if (/pdf|cmaps|standard_fonts|wasm/i.test(url.href))
          remotePdfRequests.push(url.href);
        await route.abort();
        return;
      }
      await route.continue();
    });
    await window.evaluate(() => {
      window.__reg2901PdfScriptExecuted = false;
    });
    await openSeededWorkspace(window);
    const panel = activeFilePanel(window);
    await expect(panel.getByTestId('file-breadcrumb-segment-file')).toHaveText(
      'brief.pdf',
    );
    const preview = await expectRenderedPdf(panel);

    const firstPage = preview.getByTestId('pdf-preview-page').first();
    const widthBeforeZoom = await firstPage.evaluate(
      (node) => node.getBoundingClientRect().width,
    );
    await preview.getByRole('button', { name: 'Zoom in' }).click();
    await expect
      .poll(() =>
        firstPage.evaluate((node) => node.getBoundingClientRect().width),
      )
      .toBeGreaterThan(widthBeforeZoom);

    await preview.getByRole('button', { name: 'Fit PDF to width' }).click();
    const fittedWidth = await firstPage.evaluate(
      (node) => node.getBoundingClientRect().width,
    );
    await window.setViewportSize({ width: 1100, height: 900 });
    await expect
      .poll(() =>
        firstPage.evaluate((node) => node.getBoundingClientRect().width),
      )
      .toBeLessThan(fittedWidth);

    const secondPage = preview.getByTestId('pdf-preview-page').nth(1);
    await secondPage.scrollIntoViewIfNeeded();
    await expect(preview.getByLabel('Current PDF page')).toHaveText('2 / 2');
    const rotatedLayer = preview.locator('[data-main-rotation="90"]');
    await expect(rotatedLayer).toHaveCount(1);
    await expect
      .poll(() =>
        rotatedLayer.evaluate((node) => getComputedStyle(node).transform),
      )
      .not.toBe('none');

    const glyph = preview
      .locator('span')
      .filter({ hasText: 'REG-2901 selectable text on page one' })
      .last();
    const selected = await glyph.evaluate((node) => {
      const range = document.createRange();
      range.selectNodeContents(node);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      return selection?.toString() ?? '';
    });
    expect(selected).toContain('REG-2901 selectable text');

    await preview.getByTestId('pdf-search-input').fill('searchable text');
    await preview.getByRole('button', { name: 'Search PDF text' }).click();
    await expect(preview.getByTestId('pdf-search-count')).toHaveText('1 / 2');
    const highlights = rotatedLayer.locator('mark[data-pdf-search-highlight]');
    await expect(highlights).toHaveCount(2);
    await expect(highlights.first()).toHaveAttribute(
      'data-pdf-search-highlight',
      'active',
    );
    await preview
      .getByRole('button', { name: 'Next PDF search match' })
      .click();
    await expect(preview.getByTestId('pdf-search-count')).toHaveText('2 / 2');
    await expect(highlights.nth(1)).toHaveAttribute(
      'data-pdf-search-highlight',
      'active',
    );

    expect(remotePdfRequests).toEqual([]);
    expect(external.opened).toEqual([]);
    expect(navigations).toEqual([]);
    expect(await window.evaluate(() => window.__reg2901PdfScriptExecuted)).toBe(
      false,
    );
  } finally {
    await closeCanopy(electronApp, userDataDir);
    await external.close();
  }
});

test('keeps corrupt and oversized failures actionable and recovers without hiding a partially damaged first page', async () => {
  test.setTimeout(180_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-reg-2916-failure-'),
  );
  const seed = seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  const worktreePath = seed.workspaces[0]?.worktreePath;
  expect(worktreePath, 'seeded worktree path').toBeTruthy();
  const files = seedPdfFiles(worktreePath);
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    activeTabId: 'seed-chat',
    tabs: [{ id: 'seed-chat', title: 'Chat' }],
  });
  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    await openSeededWorkspace(window);
    await window.getByTestId('panel-add-panel-group-chat').click();
    await window.getByTestId('panel-add-menu-item-new-file').click();

    let panel = await openFromPanelTree(window, 'corrupt.pdf');
    let error = panel.getByTestId('file-viewer-document-error');
    await expect(error).toHaveAttribute('data-error-kind', 'corrupt');
    await expect(
      error.getByTestId('file-viewer-open-unsupported'),
    ).toBeVisible();
    await expect(panel.getByTestId('file-tab-tree-toggle')).toBeVisible();

    panel = await openFromPanelTree(window, 'huge.pdf');
    error = panel.getByTestId('file-viewer-document-error');
    await expect(error).toHaveAttribute('data-error-kind', 'too-large');
    await expect(
      error.getByTestId('file-viewer-open-unsupported'),
    ).toBeVisible();
    await expect(panel.getByTestId('file-breadcrumb-segment-file')).toHaveText(
      'huge.pdf',
    );

    panel = await openFromPanelTree(window, 'brief.pdf');
    await expectRenderedPdf(panel);

    panel = await openFromPanelTree(window, 'partial.pdf');
    const preview = panel.getByTestId('pdf-preview');
    await expect(preview).toContainText(
      'REG-2901 selectable text on page one',
      { timeout: 60_000 },
    );
    await expect(preview.getByTestId('pdf-preview-page-error')).toHaveText(
      'Page 2 could not be previewed.',
    );
    await expect(panel.getByTestId('file-viewer-document-error')).toHaveCount(
      0,
    );
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('reloads PDFs across file types, isolates simultaneous tabs, and discovers a setup-created binary without a stuck load', async () => {
  test.setTimeout(180_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-reg-2916-lifecycle-'),
  );
  const seed = seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  const worktreePath = seed.workspaces[0]?.worktreePath;
  expect(worktreePath, 'seeded worktree path').toBeTruthy();
  const files = seedPdfFiles(worktreePath);
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    activeTabId: 'brief-a',
    tabs: [
      fileTab('brief-a', 'brief.pdf', files.brief),
      fileTab('text', 'pdf-neighbor.txt', files.text),
      fileTab('image', 'pdf-neighbor.png', files.image),
      fileTab('brief-b', 'brief-two.pdf', files.briefTwo),
    ],
  });
  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const workers = [];
    const workerResponses = [];
    const workerModuleRequests = [];
    const consoleErrors = [];
    const remotePdfRequests = [];
    const expectedWorkerModuleUrl = new URL(
      'pdf-worker/pdf.worker.min.mjs',
      await window.evaluate(() => document.baseURI),
    ).href;
    const cdp = await window.context().newCDPSession(window);
    await cdp.send('Network.enable');
    cdp.on('Network.requestWillBeSent', ({ request }) => {
      if (/pdf\.worker|pdf-worker/i.test(request.url)) {
        workerModuleRequests.push(request.url);
      }
    });
    window.on('worker', (worker) => workers.push(worker));
    window.on('response', (response) => {
      if (/pdf\.worker|pdf-worker/i.test(response.url())) {
        workerResponses.push({
          url: response.url(),
          status: response.status(),
        });
      }
    });
    window.on('console', (message) => {
      if (
        /Setting up fake worker|pdf.*(?:worker|cmaps|font|wasm).*(?:error|failed)/i.test(
          message.text(),
        )
      ) {
        consoleErrors.push(message.text());
      }
    });
    await window.route(/^https?:\/\//, async (route) => {
      const url = new URL(route.request().url());
      if (!['127.0.0.1', 'localhost'].includes(url.hostname)) {
        if (/pdf|cmaps|standard_fonts|wasm/i.test(url.href)) {
          remotePdfRequests.push(url.href);
        }
        await route.abort();
        return;
      }
      await route.continue();
    });
    await instrumentFileReads(electronApp);
    await openSeededWorkspace(window);
    await expectRenderedPdf(activeFilePanel(window));

    await window.getByTestId('panel-tab-panel-file-text').click();
    await expect(activeFilePanel(window)).toContainText(
      'PDF lifecycle text neighbor',
    );
    await window.getByTestId('panel-tab-panel-file-image').click();
    await expect(
      activeFilePanel(window).getByTestId('file-viewer-image-header'),
    ).toBeVisible();
    await window.getByTestId('panel-tab-panel-file-brief-a').click();
    await expectRenderedPdf(activeFilePanel(window));

    const splitGroupId = await splitViaApi(
      window,
      DEFAULT_GROUP_IDS.chat,
      'right',
    );
    await movePanelViaApi(window, 'panel-file-brief-b', splitGroupId, 'center');
    const firstPdfPanel = window.locator(
      '[data-testid="panel-content-file-diff"][data-panel-id="panel-file-brief-a"]',
    );
    const secondPdfPanel = window.locator(
      '[data-testid="panel-content-file-diff"][data-panel-id="panel-file-brief-b"]',
    );
    await expectRenderedPdf(firstPdfPanel);
    await expectRenderedPdf(secondPdfPanel);
    // Electron exposes the imported module URL directly; other Chromium
    // versions expose its blob wrapper. Match either to this host's exact URL.
    const liveWorkers = window
      .workers()
      .filter((worker) => workers.includes(worker));
    const pdfWorkerIndex = await findPdfWorkerIndex(
      window,
      [...liveWorkers].reverse(),
      expectedWorkerModuleUrl,
    );
    expect(pdfWorkerIndex).toBeGreaterThanOrEqual(0);
    const pdfWorker = [...liveWorkers].reverse()[pdfWorkerIndex];
    await window.getByTestId('panel-tab-panel-file-brief-a').hover();
    await window.getByTestId('panel-tab-close-panel-file-brief-a').click();
    await expect(
      window.getByTestId('panel-tab-panel-file-brief-a'),
    ).toHaveCount(0);
    await expectRenderedPdf(secondPdfPanel);
    await expect
      .poll(() => pdfWorker.evaluate(() => typeof globalThis))
      .toBe('object');

    await window.getByTestId('panel-tab-panel-file-brief-b').hover();
    await window.getByTestId('panel-tab-close-panel-file-brief-b').click();
    const reopenedPanel = await openFromPanelTree(window, 'brief-two.pdf');
    await expectRenderedPdf(reopenedPanel);

    // Playwright omits file-worker response events on this Electron version.
    // The live Worker identity and CDP module request prove real local loading.
    expect(workerModuleRequests).toContain(expectedWorkerModuleUrl);
    expect(
      workerResponses.every(
        ({ url }) =>
          url.startsWith('file:') ||
          new URL(url).hostname === '127.0.0.1' ||
          new URL(url).hostname === 'localhost',
      ),
    ).toBe(true);
    const reads = await getInstrumentedFileReads(electronApp);
    const pdfDocumentReads = reads.document.filter((request) =>
      request.absolutePath?.endsWith('.pdf'),
    );
    expect(pdfDocumentReads.length).toBeGreaterThanOrEqual(5);
    expect(
      [...reads.preview, ...reads.content].filter((request) =>
        request.absolutePath?.endsWith('.pdf'),
      ),
    ).toEqual([]);
    expect(remotePdfRequests).toEqual([]);
    expect(consoleErrors).toEqual([]);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('renders a missing PDF created by the real automatic branch setup without reactivating its file tab', async () => {
  test.setTimeout(300_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-reg-2916-setup-created-'),
  );
  const seed = seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  const worktreePath = seed.workspaces[0]?.worktreePath;
  expect(worktreePath, 'seeded worktree path').toBeTruthy();
  const setupPdfPath = path.join(worktreePath, 'setup-created.pdf');
  const workspaceConfigPath = path.join(
    userDataDir,
    'workspaces',
    WORKSPACE_ID,
    'workspace.json',
  );
  const workspaceConfig = JSON.parse(readFileSync(workspaceConfigPath, 'utf8'));
  workspaceConfig.scripts.setup = `node -e "setTimeout(()=>require('fs').writeFileSync('setup-created.pdf',Buffer.from('${PDF_BYTES.toString('base64')}','base64')),5000)"`;
  writeFileSync(
    workspaceConfigPath,
    `${JSON.stringify(workspaceConfig, null, 2)}\n`,
  );
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    activeTabId: 'setup-pdf',
    tabs: [fileTab('setup-pdf', 'setup-created.pdf', setupPdfPath)],
  });

  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    await instrumentFileReads(electronApp);
    await openSeededWorkspace(window);
    const rows = window.getByTestId('worktree-row');
    const rowCountBefore = await rows.count();
    const sourceRow = window.locator(
      `[data-testid="worktree-row"][data-worktree-id="${WORKTREE_ID}"]`,
    );
    await sourceRow.hover();
    await sourceRow.getByTestId('worktree-actions-menu-button').click();
    await window.getByTestId('worktree-actions-menu-create-branch').click();

    await expect
      .poll(() => rows.count(), { timeout: 120_000 })
      .toBe(rowCountBefore + 1);
    const destinationRow = window
      .locator(
        `[data-testid="worktree-row"]:not([data-worktree-id="${WORKTREE_ID}"])`,
      )
      .last();
    await expect(destinationRow).toHaveClass(/bg-muted/, { timeout: 120_000 });
    const destinationFileTab = window
      .locator('[data-testid^="panel-tab-panel-file-"]')
      .first();
    await expect(destinationFileTab).toBeVisible({ timeout: 30_000 });
    await destinationFileTab.click();
    const destinationPanel = activeFilePanel(window);
    await expect(destinationPanel.getByTestId('pdf-preview')).toHaveCount(0);
    await expect(
      destinationPanel.getByTestId('file-viewer-missing'),
    ).toHaveCount(0);
    await expectRenderedPdf(destinationPanel);

    const reads = await getInstrumentedFileReads(electronApp);
    expect(
      reads.document.filter((request) =>
        request.absolutePath?.endsWith('setup-created.pdf'),
      ).length,
    ).toBeGreaterThanOrEqual(1);
    expect(
      [...reads.preview, ...reads.content].filter((request) =>
        request.absolutePath?.endsWith('setup-created.pdf'),
      ),
    ).toEqual([]);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('rejects a PDF when its parent becomes an outside symlink during validation', async () => {
  test.skip(
    process.platform === 'win32',
    'Directory symlink fixture requires POSIX',
  );
  test.setTimeout(180_000);
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'canopy-pdf-race-'));
  const outsideDir = mkdtempSync(path.join(os.tmpdir(), 'canopy-pdf-outside-'));
  const seed = seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  const worktreePath = seed.workspaces[0]?.worktreePath;
  expect(worktreePath).toBeTruthy();
  const parentDir = path.join(worktreePath, 'documents');
  mkdirSync(parentDir);
  const pdfPath = path.join(parentDir, 'brief.pdf');
  writeFileSync(pdfPath, PDF_BYTES);
  writeFileSync(path.join(outsideDir, 'brief.pdf'), PDF_BYTES);
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    activeTabId: 'seed-chat',
    tabs: [
      { id: 'seed-chat', title: 'Chat' },
      fileTab('race-pdf', 'brief.pdf', pdfPath),
    ],
  });
  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    await openSeededWorkspace(window);
    // Swap after realpath containment but before lstat/open. Both original
    // metadata checks then see the same outside inode on the broken reader.
    await electronApp.evaluate(
      async ({ ipcMain }, paths) => {
        const fs = process.getBuiltinModule('fs/promises');
        const mutableFs = fs;
        const original = mutableFs.lstat;
        globalThis.__pdfRaceSwapped = false;
        globalThis.__pdfRaceResults = [];
        let readingDocument = false;
        let resolvedDocument = false;
        const originalRealpath = mutableFs.realpath;
        mutableFs.realpath = async function (file, ...args) {
          const result = await originalRealpath(file, ...args);
          if (
            readingDocument &&
            String(file).endsWith('/documents/brief.pdf')
          ) {
            resolvedDocument = true;
          }
          return result;
        };
        const channel = 'file:read-document-bytes';
        const originalHandler = ipcMain._invokeHandlers.get(channel);
        ipcMain.removeHandler(channel);
        ipcMain.handle(channel, async (event, request) => {
          readingDocument = true;
          try {
            const result = await originalHandler(event, request);
            globalThis.__pdfRaceResults.push(result.status);
            return result;
          } catch (error) {
            globalThis.__pdfRaceResults.push(error.message);
            throw error;
          } finally {
            readingDocument = false;
          }
        });
        mutableFs.lstat = async function (file, ...args) {
          if (
            readingDocument &&
            resolvedDocument &&
            String(file).endsWith('/documents/brief.pdf') &&
            !globalThis.__pdfRaceSwapped
          ) {
            globalThis.__pdfRaceSwapped = true;
            mutableFs.lstat = original;
            await fs.rename(paths.parentDir, paths.parentDir + '-saved');
            await fs.symlink(paths.outsideDir, paths.parentDir, 'dir');
          }
          return original(file, ...args);
        };
      },
      { parentDir, outsideDir },
    );
    await window.getByTestId('panel-tab-panel-file-race-pdf').click();
    await expect
      .poll(() => electronApp.evaluate(() => globalThis.__pdfRaceSwapped))
      .toBe(true);
    const panel = activeFilePanel(window);
    await expect(
      panel.getByTestId('file-viewer-document-error'),
    ).toHaveAttribute('data-error-kind', 'fetch-failed');
    await expect(panel.getByTestId('pdf-preview')).toHaveCount(0);
    expect(
      await electronApp.evaluate(() => globalThis.__pdfRaceResults),
    ).not.toContain('ready');
  } finally {
    await closeCanopy(electronApp, userDataDir);
    rmSync(outsideDir, { recursive: true, force: true });
  }
});
