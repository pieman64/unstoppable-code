// REG-2944: desktop file-tab DOCX/XLSX/PPTX semantic preview acceptance coverage.
//
// Success, failure/recovery, lifecycle, and responsiveness run in separate
// Electron launches so one broken contract cannot mask the others. Fixtures are
// the deterministic hand-built OOXML zips shared with the web REG-2902 spec.
import {
  mkdtempSync,
  readFileSync,
  realpathSync,
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
import * as ooxml from '../../../../packages/ui-rich/test/ooxml-fixtures.js';
import { buildPptxBudgetFixture } from '../../../../packages/ui-rich/test/pptx-budget-fixtures.js';

const {
  REG2902_DOCX_BULLET,
  REG2902_DOCX_HEADING,
  REG2902_DOCX_LINK_TEXT,
  REG2902_DOCX_TABLE_CELL,
  buildReg2902DocxFixture,
  buildReg2902XlsxFixture,
  buildStoredZip,
} = ooxml;

const WORKSPACE_ID = 'demo-ts-pnpm-vite';
const WORKTREE_ID = 'demo-main';
const S_NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const R_NS =
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const DOCX_BYTES = Buffer.from(buildReg2902DocxFixture());
const XLSX_BYTES = Buffer.from(buildReg2902XlsxFixture());
const XLSX_6000_BYTES = Buffer.from(
  buildReg2902XlsxFixture({ largeRows: 6_000 }),
);
const XLSX_HEAVY_BYTES = Buffer.from(
  buildReg2902XlsxFixture({
    largeRows: 5_000,
    cellTextChars: 900,
    targetBytes: 10 * 1024 * 1024,
  }),
);

/** Two-sheet workbook whose second sheet declares no cells at all. */
function buildEmptySheetWorkbook() {
  const sheet = (body) =>
    `<?xml version="1.0"?><worksheet xmlns="${S_NS}">${body}</worksheet>`;
  return Buffer.from(
    buildStoredZip([
      {
        name: '[Content_Types].xml',
        data: `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`,
      },
      {
        name: '_rels/.rels',
        data: `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${R_NS}/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
      },
      {
        name: 'xl/workbook.xml',
        data: `<workbook xmlns="${S_NS}" xmlns:r="${R_NS}"><sheets><sheet name="Filled" sheetId="1" r:id="rId1"/><sheet name="Blank" sheetId="2" r:id="rId2"/></sheets></workbook>`,
      },
      {
        name: 'xl/_rels/workbook.xml.rels',
        data: `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${R_NS}/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="${R_NS}/worksheet" Target="worksheets/sheet2.xml"/></Relationships>`,
      },
      {
        name: 'xl/worksheets/sheet1.xml',
        data: sheet(
          '<dimension ref="A1:A1"/><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>only</t></is></c></row></sheetData>',
        ),
      },
      { name: 'xl/worksheets/sheet2.xml', data: sheet('<sheetData/>') },
    ]),
  );
}

function seedOfficeFiles(worktreePath) {
  const paths = {
    docx: path.join(worktreePath, 'brief.docx'),
    docxTwo: path.join(worktreePath, 'brief-two.docx'),
    xlsx: path.join(worktreePath, 'q3.xlsx'),
    xlsx6000: path.join(worktreePath, 'rows-6000.xlsx'),
    empty: path.join(worktreePath, 'empty-sheet.xlsx'),
    heavy: path.join(worktreePath, 'heavy.xlsx'),
    corrupt: path.join(worktreePath, 'corrupt.docx'),
    macro: path.join(worktreePath, 'macro.docm'),
    huge: path.join(worktreePath, 'huge.xlsx'),
    text: path.join(worktreePath, 'office-neighbor.txt'),
  };
  writeFileSync(paths.docx, DOCX_BYTES);
  writeFileSync(
    paths.docxTwo,
    Buffer.from(
      ooxml.buildReg2902DenseDocxFixture({ paragraphs: 2, tableRows: 1 }),
    ),
  );
  writeFileSync(paths.xlsx, XLSX_BYTES);
  writeFileSync(paths.xlsx6000, XLSX_6000_BYTES);
  writeFileSync(paths.empty, buildEmptySheetWorkbook());
  writeFileSync(paths.heavy, XLSX_HEAVY_BYTES);
  writeFileSync(paths.corrupt, Buffer.from('not a zip archive'));
  writeFileSync(paths.macro, DOCX_BYTES);
  writeFileSync(paths.huge, Buffer.alloc(25 * 1024 * 1024 + 1));
  writeFileSync(paths.text, 'Office lifecycle text neighbor\n', 'utf8');
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
  if (!(await panel.getByTestId('file-tab-tree').isVisible())) {
    await panel.getByTestId('file-tab-tree-toggle').click();
  }
  const row = panel
    .getByTestId('file-tab-tree')
    .locator(`[data-testid="files-tree-row"][data-path="${name}"]`);
  await expect(row).toBeVisible({ timeout: 20_000 });
  await row.click();
  await expect(
    activeFilePanel(window).getByTestId('file-breadcrumb-segment-file'),
  ).toHaveText(name);
  return activeFilePanel(window);
}

async function openSeededWorkspace(window) {
  const app = new CanopyAppDriver(window);
  await app.waitForShell({ timeout: 30_000 });
  await app.openMainPage();
  await app.selectWorktree(WORKTREE_ID);
}

async function instrumentFileReads(electronApp) {
  await electronApp.evaluate(({ ipcMain }) => {
    globalThis.__reg2944FileReads = { preview: [], content: [], document: [] };
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
        globalThis.__reg2944FileReads[bucket].push(request);
        return original(event, request);
      });
    }
  });
}

function getInstrumentedFileReads(electronApp) {
  return electronApp.evaluate(() => globalThis.__reg2944FileReads);
}

/** Attach before worker selection so short-lived module workers remain observable. */
async function observeOfficeWorkerTargets(electronApp, window) {
  const browserWindow = await electronApp.browserWindow(window);
  await browserWindow.evaluate(async ({ webContents }) => {
    const debuggerSession = webContents.debugger;
    globalThis.__reg2944WorkerTargets = {
      targets: [],
      requests: [],
      scripts: [],
      errors: [],
    };
    debuggerSession.attach('1.3');
    debuggerSession.on('message', (_event, method, params, sessionId) => {
      const observed = globalThis.__reg2944WorkerTargets;
      if (method === 'Target.attachedToTarget') {
        if (params.targetInfo.type === 'worker')
          observed.targets.push(params.targetInfo.url);
        const workerSessionId = params.sessionId;
        void (async () => {
          try {
            if (params.targetInfo.type === 'worker') {
              await debuggerSession.sendCommand(
                'Network.enable',
                {},
                workerSessionId,
              );
              await debuggerSession.sendCommand(
                'Debugger.enable',
                {},
                workerSessionId,
              );
            }
          } catch (error) {
            observed.errors.push(String(error));
          } finally {
            await debuggerSession
              .sendCommand(
                'Runtime.runIfWaitingForDebugger',
                {},
                workerSessionId,
              )
              .catch((error) => {
                observed.errors.push(String(error));
              });
          }
        })();
      }
      if (
        method === 'Network.requestWillBeSent' &&
        /office-parse\.worker/i.test(params.request.url)
      ) {
        observed.requests.push({ url: params.request.url, sessionId });
      }
      if (
        method === 'Debugger.scriptParsed' &&
        /office-parse\.worker/i.test(params.url)
      ) {
        observed.scripts.push({ url: params.url, sessionId });
      }
    });
    await debuggerSession.sendCommand('Target.setAutoAttach', {
      autoAttach: true,
      waitForDebuggerOnStart: true,
      flatten: true,
    });
  });
}

/** Gate real-worker responses until explicitly released, and track each live worker. */
async function installDelayedWorker(window, gateResponses = true) {
  await window.evaluate((shouldGate) => {
    const NativeWorker = window.Worker;
    const tracked = { started: 0, terminated: 0, pending: 0, responses: [] };
    const deliveries = new Map();
    window.__reg2944Workers = tracked;
    window.__reg2944ReleaseWorkers = () => {
      for (const deliver of [...deliveries.values()]) deliver();
    };
    window.Worker = class GatedWorker extends NativeWorker {
      constructor(...args) {
        super(...args);
        this.office = false;
        this.finished = false;
        this.replaying = false;
        this.addEventListener(
          'message',
          (event) => {
            if (!this.office || this.replaying) return;
            tracked.responses.push({
              ok: event.data.ok,
              error: event.data.error,
              kind: event.data.result?.kind,
              htmlChars: event.data.result?.html?.length,
            });
            if (!shouldGate) return;
            event.stopImmediatePropagation();
            tracked.pending += 1;
            deliveries.set(this, () => {
              deliveries.delete(this);
              tracked.pending -= 1;
              if (this.finished) return;
              this.replaying = true;
              this.dispatchEvent(
                new MessageEvent('message', { data: event.data }),
              );
              this.replaying = false;
            });
          },
          { capture: true },
        );
      }
      postMessage(message, ...options) {
        if (
          !this.office &&
          (message?.kind === 'docx' || message?.kind === 'xlsx') &&
          message.bytes instanceof ArrayBuffer
        ) {
          this.office = true;
          tracked.started += 1;
        }
        super.postMessage(message, ...options);
      }
      terminate() {
        if (this.office && !this.finished) {
          this.finished = true;
          tracked.terminated += 1;
          if (deliveries.delete(this)) tracked.pending -= 1;
        }
        super.terminate();
      }
    };
  }, gateResponses);
}

async function expectRenderedDocx(panel) {
  const preview = panel.getByTestId('docx-preview');
  await expect(preview).toBeVisible({ timeout: 60_000 });
  await expect(preview.getByTestId('docx-preview-frame')).toBeVisible({
    timeout: 60_000,
  });
  await expect(preview.getByTestId('docx-preview-loading')).toHaveCount(0);
  return preview;
}

async function expectRenderedXlsx(panel) {
  const preview = panel.getByTestId('xlsx-preview');
  await expect(preview).toBeVisible({ timeout: 60_000 });
  await expect(preview.getByTestId('xlsx-grid')).toBeVisible({
    timeout: 60_000,
  });
  return preview;
}

test('renders DOCX and XLSX previews inline with inert content, keyboard sheet tabs, merges, truncation, and the platform open action', async () => {
  test.setTimeout(240_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-reg-2944-success-'),
  );
  const seed = seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  const worktreePath = seed.workspaces[0]?.worktreePath;
  expect(worktreePath, 'seeded worktree path').toBeTruthy();
  const files = seedOfficeFiles(worktreePath);
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    activeTabId: 'docx',
    tabs: [fileTab('docx', 'brief.docx', files.docx)],
  });
  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const remoteRequests = [];
    const navigations = [];
    window.on('framenavigated', (frame) => {
      if (frame === window.mainFrame()) navigations.push(frame.url());
    });
    await window.route(/^https?:\/\//, async (route) => {
      const url = new URL(route.request().url());
      if (!['127.0.0.1', 'localhost'].includes(url.hostname)) {
        remoteRequests.push(url.href);
        await route.abort();
        return;
      }
      await route.continue();
    });
    await openSeededWorkspace(window);

    // DOCX: structure survives, hostile content is inert.
    let panel = activeFilePanel(window);
    const docx = await expectRenderedDocx(panel);
    await expect(docx.getByTestId('office-preview-banner')).toHaveText(
      /^Semantic preview: formatting may differ; open (in Finder|in File Explorer|in Files|the original file) for the exact document\.$/,
    );
    await expect(docx.getByTestId('docx-preview-frame')).toHaveAttribute(
      'sandbox',
      '',
    );
    const frame = docx.frameLocator('[data-testid="docx-preview-frame"]');
    await expect(frame.locator('h1')).toHaveText(REG2902_DOCX_HEADING);
    await expect(frame.locator('ul li').first()).toHaveText(
      REG2902_DOCX_BULLET,
    );
    await expect(frame.locator('td').first()).toHaveText(
      REG2902_DOCX_TABLE_CELL,
    );
    await expect(frame.locator('strong, b').first()).toBeVisible();
    await expect(frame.locator('script')).toHaveCount(0);
    const link = frame.locator('a', { hasText: REG2902_DOCX_LINK_TEXT });
    await expect(link).toHaveCount(1);
    expect(await link.getAttribute('href')).toBeNull();
    await link.click();
    await expect(frame.locator('img').first()).toBeVisible();
    await expect(frame.locator('img').first()).toHaveAttribute(
      'src',
      /^data:image\/(png|jpeg|gif|webp);base64,/,
    );
    expect(
      await window.evaluate(() => window.__reg2902Injected),
    ).toBeUndefined();
    await electronApp.evaluate(({ shell }) => {
      globalThis.__reg2944Reveals = [];
      shell.showItemInFolder = (filePath) => {
        globalThis.__reg2944Reveals.push(filePath);
      };
    });
    const openOriginal = panel.getByTestId('file-viewer-open-original');
    await expect(openOriginal).toHaveText(
      /^Open in (Finder|File Explorer|Files|file manager)$/,
    );
    expect(
      await openOriginal.evaluate((node) => getComputedStyle(node).boxShadow),
    ).not.toBe('none');
    await openOriginal.click();
    await expect
      .poll(() => electronApp.evaluate(() => globalThis.__reg2944Reveals))
      .toEqual([realpathSync(files.docx)]);
    await expect(panel.getByTestId('file-viewer-document-error')).toHaveCount(
      0,
    );

    // XLSX: tabs, values, saved formula values, merges, keyboard navigation.
    panel = await openFromPanelTree(window, 'q3.xlsx');
    const xlsx = await expectRenderedXlsx(panel);
    const tabs = xlsx.getByTestId('xlsx-sheet-tab');
    await expect(tabs).toHaveCount(2);
    await expect(tabs.nth(0)).toHaveText('Summary');
    await expect(xlsx.locator('[data-cell="A1"]')).toHaveText('Region');
    await expect(xlsx.locator('[data-cell="B4"]')).toHaveText('30');
    await expect(xlsx.getByTestId('xlsx-formula-note')).toHaveText(
      'Cells show the values saved in the file; formulas are not recalculated.',
    );
    await expect(xlsx.locator('[data-cell="A5"]')).toHaveAttribute(
      'aria-colspan',
      '2',
    );
    await tabs.nth(0).focus();
    await tabs.nth(0).press('ArrowRight');
    await expect(tabs.nth(1)).toHaveAttribute('aria-selected', 'true');
    await expect(tabs.nth(1)).toBeFocused();
    await expect(xlsx.getByTestId('xlsx-truncation-banner')).toHaveText(
      'Showing the first 5,000 of 5,020 rows. Open the workbook in its native app to see everything.',
    );
    await tabs.nth(1).press('Home');
    await expect(tabs.nth(0)).toHaveAttribute('aria-selected', 'true');
    await tabs.nth(0).press('End');
    await expect(tabs.nth(1)).toHaveAttribute('aria-selected', 'true');

    // 6,000-row workbook shows the first 5,000 rows.
    panel = await openFromPanelTree(window, 'rows-6000.xlsx');
    const big = await expectRenderedXlsx(panel);
    await big.getByTestId('xlsx-sheet-tab').nth(1).click();
    await expect(big.getByTestId('xlsx-truncation-banner')).toContainText(
      'Showing the first 5,000 of 6,000 rows.',
    );
    await expect(big.getByTestId('xlsx-grid')).toHaveAttribute(
      'data-row-count',
      '5000',
    );

    // The frozen edge is opaque, and the rows travelling under it stay
    // hidden. Asserted as PAINT, not as a class name: the fill was written as
    // `bg-surface-secondary`, a role no stylesheet declares, so Tailwind
    // emitted no rule and rows read straight through the column letters and
    // the row numbers until #3791 removed the dead class.
    const frozen = await big.evaluate((preview) => {
      const scroller = preview.querySelector('[data-testid="xlsx-grid"]');
      scroller.scrollTop = 600;
      scroller.scrollLeft = 200;
      const solid = (el) => {
        const painted = getComputedStyle(el).backgroundColor;
        return {
          painted,
          transparent: painted === 'transparent' || /,\s*0\s*\)$/.test(painted),
        };
      };
      const probe = document.createElement('div');
      probe.style.backgroundColor = 'var(--bg-secondary)';
      document.body.append(probe);
      const secondary = getComputedStyle(probe).backgroundColor;
      probe.remove();
      return {
        secondary,
        header: solid(preview.querySelector('[role="row"][aria-rowindex="1"]')),
        gutter: solid(preview.querySelector('[role="rowheader"]')),
        // Painting order, not just the fill: the gutter is a sticky sibling
        // the data cells follow in tree order, so at `z-index: auto` they
        // would paint over it and the fill would buy nothing.
        gutterZ: getComputedStyle(preview.querySelector('[role="rowheader"]'))
          .zIndex,
        headerZ: getComputedStyle(
          preview.querySelector('[role="row"][aria-rowindex="1"]'),
        ).zIndex,
      };
    });
    expect(frozen.header.transparent).toBe(false);
    expect(frozen.gutter.transparent).toBe(false);
    expect(frozen.header.painted).toBe(frozen.secondary);
    expect(frozen.gutter.painted).toBe(frozen.secondary);
    expect(Number(frozen.gutterZ)).toBeGreaterThan(1);
    expect(Number(frozen.headerZ)).toBeGreaterThan(Number(frozen.gutterZ));

    // Empty selected sheet is named, not treated as a failure.
    panel = await openFromPanelTree(window, 'empty-sheet.xlsx');
    const emptyWorkbook = panel.getByTestId('xlsx-preview');
    await expect(emptyWorkbook).toBeVisible({ timeout: 60_000 });
    await emptyWorkbook.getByTestId('xlsx-sheet-tab').nth(1).click();
    await expect(emptyWorkbook.getByTestId('xlsx-empty')).toHaveText(
      'Blank is empty.',
    );

    expect(remoteRequests).toEqual([]);
    expect(navigations).toEqual([]);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('keeps corrupt, macro-enabled, and oversized Office files actionable and recovers without a stuck spinner', async () => {
  test.setTimeout(180_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-reg-2944-failure-'),
  );
  const seed = seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  const worktreePath = seed.workspaces[0]?.worktreePath;
  expect(worktreePath).toBeTruthy();
  seedOfficeFiles(worktreePath);
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
    await electronApp.evaluate(({ shell }) => {
      globalThis.__reg2944Reveals = [];
      shell.showItemInFolder = (filePath) => {
        globalThis.__reg2944Reveals.push(filePath);
      };
    });
    await window.getByTestId('panel-add-panel-group-chat').click();
    await window.getByTestId('panel-add-menu-item-new-file').click();

    let panel = await openFromPanelTree(window, 'corrupt.docx');
    let error = panel.getByTestId('file-viewer-document-error');
    await expect(error).toHaveAttribute('data-error-kind', 'parse-failed', {
      timeout: 60_000,
    });
    await expect(error).toContainText(
      'corrupt.docx could not be converted for preview. Open it in its native app to view the full document.',
    );
    await expect(error.getByTestId('file-viewer-open-unsupported')).toHaveText(
      /^Open in /,
    );
    await error.getByTestId('file-viewer-open-unsupported').click();
    await expect
      .poll(() => electronApp.evaluate(() => globalThis.__reg2944Reveals))
      .toEqual([realpathSync(path.join(worktreePath, 'corrupt.docx'))]);
    await expect(panel.getByTestId('docx-preview-loading')).toHaveCount(0);

    panel = await openFromPanelTree(window, 'macro.docm');
    await expect(panel.getByTestId('file-viewer-unsupported')).toBeVisible();
    await expect(
      panel.getByTestId('file-viewer-open-unsupported'),
    ).toBeVisible();

    panel = await openFromPanelTree(window, 'huge.xlsx');
    error = panel.getByTestId('file-viewer-document-error');
    await expect(error).toHaveAttribute('data-error-kind', 'too-large');
    await expect(
      error.getByTestId('file-viewer-open-unsupported'),
    ).toBeVisible();

    panel = await openFromPanelTree(window, 'brief.docx');
    await expectRenderedDocx(panel);
    panel = await openFromPanelTree(window, 'q3.xlsx');
    await expectRenderedXlsx(panel);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('switches, isolates, closes, and reactivates Office tabs while terminating pending workers', async () => {
  test.setTimeout(240_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-reg-2944-lifecycle-'),
  );
  const seed = seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  const worktreePath = seed.workspaces[0]?.worktreePath;
  expect(worktreePath).toBeTruthy();
  const files = seedOfficeFiles(worktreePath);
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    activeTabId: 'docx-a',
    tabs: [
      fileTab('docx-a', 'brief.docx', files.docx),
      fileTab('text', 'office-neighbor.txt', files.text),
      fileTab('xlsx-a', 'q3.xlsx', files.xlsx),
      fileTab('docx-b', 'brief-two.docx', files.docxTwo),
    ],
  });
  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const workerUrls = [];
    const workerModuleRequests = [];
    await observeOfficeWorkerTargets(electronApp, window);
    const cdp = await window.context().newCDPSession(window);
    await cdp.send('Network.enable');
    cdp.on('Network.requestWillBeSent', ({ request }) => {
      if (/office-parse\.worker/i.test(request.url))
        workerModuleRequests.push(request.url);
    });
    window.on('worker', (worker) => workerUrls.push(worker.url()));
    await instrumentFileReads(electronApp);
    await openSeededWorkspace(window);
    await expectRenderedDocx(activeFilePanel(window));

    await window.getByTestId('panel-tab-panel-file-text').click();
    await expect(activeFilePanel(window)).toContainText(
      'Office lifecycle text neighbor',
    );
    await window.getByTestId('panel-tab-panel-file-xlsx-a').click();
    await expectRenderedXlsx(activeFilePanel(window));
    await window.getByTestId('panel-tab-panel-file-docx-a').click();
    await expectRenderedDocx(activeFilePanel(window));
    let reads = await getInstrumentedFileReads(electronApp);
    expect(
      reads.document.filter((r) => r.absolutePath === files.docx).length,
    ).toBeGreaterThanOrEqual(2);

    // Independent simultaneous previews in split groups.
    const splitGroupId = await splitViaApi(
      window,
      DEFAULT_GROUP_IDS.chat,
      'right',
    );
    await movePanelViaApi(window, 'panel-file-docx-b', splitGroupId, 'center');
    const left = window.locator(
      '[data-testid="panel-content-file-diff"][data-panel-id="panel-file-docx-a"]',
    );
    const right = window.locator(
      '[data-testid="panel-content-file-diff"][data-panel-id="panel-file-docx-b"]',
    );
    await expectRenderedDocx(left);
    await expectRenderedDocx(right);
    await expect(
      left.frameLocator('[data-testid="docx-preview-frame"]').locator('h1'),
    ).toHaveText(REG2902_DOCX_HEADING);
    await expect(
      right.frameLocator('[data-testid="docx-preview-frame"]').locator('body'),
    ).toContainText(ooxml.REG2902_DOCX_DENSE_LAST_TEXT);

    // Closing a tab whose parse is still pending terminates its worker and leaves no stale UI.
    await installDelayedWorker(window);
    await window.getByTestId('panel-tab-panel-file-xlsx-a').click();
    const pendingPanel = window.locator(
      '[data-testid="panel-content-file-diff"][data-panel-id="panel-file-xlsx-a"]',
    );
    await expect(
      pendingPanel.getByTestId('xlsx-preview-loading'),
    ).toBeVisible();
    await expect
      .poll(() => window.evaluate(() => window.__reg2944Workers.pending))
      .toBe(1);
    await window.getByTestId('panel-tab-panel-file-xlsx-a').hover();
    await window.getByTestId('panel-tab-close-panel-file-xlsx-a').click();
    await expect(window.getByTestId('panel-tab-panel-file-xlsx-a')).toHaveCount(
      0,
    );
    await expect
      .poll(() =>
        window.evaluate(
          () =>
            window.__reg2944Workers.started -
            window.__reg2944Workers.terminated,
        ),
      )
      .toBe(0);
    const counters = await window.evaluate(() => window.__reg2944Workers);
    expect(counters.terminated).toBeGreaterThanOrEqual(counters.started);
    await expect(window.getByTestId('xlsx-preview')).toHaveCount(0);
    await expect(window.getByTestId('file-viewer-document-error')).toHaveCount(
      0,
    );

    // Reopen from the tree after closing: fresh read, fresh render.
    // Close the other split tab so the generic single-visible-panel tree helper
    // cannot match both panels. With two panels, always scope by data-panel-id.
    await window.getByTestId('panel-tab-panel-file-docx-b').hover();
    await window.getByTestId('panel-tab-close-panel-file-docx-b').click();
    await window.getByTestId('panel-tab-panel-file-text').click();
    const reopened = await openFromPanelTree(window, 'q3.xlsx');
    await expect
      .poll(() => window.evaluate(() => window.__reg2944Workers.pending))
      .toBe(1);
    await window.evaluate(() => window.__reg2944ReleaseWorkers());
    await expectRenderedXlsx(reopened);

    // Worker assets are local; Office files never hit the text-read channels.
    const workerTargets = await electronApp.evaluate(
      () => globalThis.__reg2944WorkerTargets,
    );
    workerModuleRequests.push(
      ...workerTargets.requests.map((request) => request.url),
    );
    await test.info().attach('office-worker-target-observation', {
      body: JSON.stringify(workerTargets, null, 2),
      contentType: 'application/json',
    });
    expect(workerUrls.length).toBeGreaterThan(0);
    expect(
      workerUrls.every(
        (url) =>
          url.startsWith('file:') ||
          url.startsWith('blob:') ||
          /^https?:\/\/(127\.0\.0\.1|localhost)/.test(url),
      ),
      JSON.stringify(workerUrls),
    ).toBe(true);
    await test.info().attach('office-worker-urls', {
      body: JSON.stringify({ workerUrls, workerModuleRequests }, null, 2),
      contentType: 'application/json',
    });
    expect(workerModuleRequests.length).toBeGreaterThan(0);
    expect(
      workerModuleRequests.every(
        (url) =>
          url.startsWith('file:') ||
          /^https?:\/\/(127\.0\.0\.1|localhost)/.test(url),
      ),
    ).toBe(true);
    reads = await getInstrumentedFileReads(electronApp);
    expect(
      [...reads.preview, ...reads.content].filter((r) =>
        /\.(docx|xlsx)$/.test(r.absolutePath ?? ''),
      ),
    ).toEqual([]);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('keeps the renderer main thread responsive while a 10 MiB workbook parses and mounts', async () => {
  test.setTimeout(300_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-reg-2944-responsive-'),
  );
  const seed = seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  const worktreePath = seed.workspaces[0]?.worktreePath;
  expect(worktreePath).toBeTruthy();
  seedOfficeFiles(worktreePath);
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
    await window.evaluate(() => {
      window.__reg2944Heartbeat = {
        lastSampleAt: performance.now(),
        maxGapMs: 0,
        samples: 0,
        stopped: false,
      };
      const tick = () => {
        const heartbeat = window.__reg2944Heartbeat;
        if (heartbeat.stopped) return;
        const now = performance.now();
        heartbeat.maxGapMs = Math.max(
          heartbeat.maxGapMs,
          now - heartbeat.lastSampleAt,
        );
        heartbeat.lastSampleAt = now;
        heartbeat.samples += 1;
        setTimeout(tick, 16);
      };
      tick();
    });
    const panel = await openFromPanelTree(window, 'heavy.xlsx');
    await expectRenderedXlsx(panel);
    await panel
      .getByTestId('xlsx-sheet-tab')
      .filter({ hasText: /^Data$/ })
      .click();
    const grid = panel.getByTestId('xlsx-grid');
    await expect(grid).toHaveAttribute('data-row-count', '5000');
    await grid.evaluate((node) => {
      node.scrollTop = 2_500 * 28;
    });
    await expect(panel.locator('[data-cell="A2501"]')).toBeVisible();
    const heartbeat = await window.evaluate(() => {
      window.__reg2944Heartbeat.stopped = true;
      return window.__reg2944Heartbeat;
    });
    expect(heartbeat.samples).toBeGreaterThan(0);
    // Diagnostic only: production performance is gated by matched runbook runs,
    // not a single wall-clock assertion in this functional suite.
    test.info().annotations.push({
      type: 'reg-2944-max-main-thread-gap-ms',
      description: String(Math.round(heartbeat.maxGapMs)),
    });
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('keeps unsupported Office navigation responsive beside an existing text tab', async () => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-reg-2944-baseline-'),
  );
  const seed = seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  const worktreePath = seed.workspaces[0]?.worktreePath;
  expect(worktreePath).toBeTruthy();
  const files = seedOfficeFiles(worktreePath);
  const fallbackPath = files.macro;
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    activeTabId: 'fallback',
    tabs: [
      fileTab('fallback', path.basename(fallbackPath), fallbackPath),
      fileTab('text', 'office-neighbor.txt', files.text),
    ],
  });
  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    await openSeededWorkspace(window);
    await expect(
      activeFilePanel(window).getByTestId('file-viewer-unsupported'),
    ).toBeVisible();
    await expect(
      activeFilePanel(window).getByTestId('file-viewer-open-unsupported'),
    ).toBeVisible();
    await window.getByTestId('panel-tab-panel-file-text').click();
    await expect(activeFilePanel(window)).toContainText(
      'Office lifecycle text neighbor',
    );
    await window.getByTestId('panel-tab-panel-file-fallback').click();
    await expect(
      activeFilePanel(window).getByTestId('file-viewer-unsupported'),
    ).toBeVisible();
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('renders a missing DOCX created by the real automatic branch setup without reactivating its file tab', async () => {
  test.setTimeout(300_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-reg-2944-setup-created-'),
  );
  const seed = seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  const worktreePath = seed.workspaces[0]?.worktreePath;
  expect(worktreePath, 'seeded worktree path').toBeTruthy();
  const setupDocxPath = path.join(worktreePath, 'setup-created.docx');
  const workspaceConfigPath = path.join(
    userDataDir,
    'workspaces',
    WORKSPACE_ID,
    'workspace.json',
  );
  const workspaceConfig = JSON.parse(readFileSync(workspaceConfigPath, 'utf8'));
  workspaceConfig.scripts.setup = `node -e "setTimeout(()=>require('fs').writeFileSync('setup-created.docx',Buffer.from('${DOCX_BYTES.toString('base64')}','base64')),5000)"`;
  writeFileSync(
    workspaceConfigPath,
    `${JSON.stringify(workspaceConfig, null, 2)}\n`,
  );
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    activeTabId: 'setup-docx',
    tabs: [fileTab('setup-docx', 'setup-created.docx', setupDocxPath)],
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
    await expect(destinationPanel.getByTestId('docx-preview')).toHaveCount(0);
    await expect(
      destinationPanel.getByTestId('file-viewer-missing'),
    ).toHaveCount(0);
    await expectRenderedDocx(destinationPanel);

    const reads = await getInstrumentedFileReads(electronApp);
    expect(
      reads.document.filter((request) =>
        request.absolutePath?.endsWith('setup-created.docx'),
      ).length,
    ).toBeGreaterThanOrEqual(1);
    expect(
      [...reads.preview, ...reads.content].filter((request) =>
        request.absolutePath?.endsWith('setup-created.docx'),
      ),
    ).toEqual([]);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('rejects supported-extension archives and dense DOCX budgets, then recovers from worker bootstrap failure', async () => {
  test.setTimeout(240_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-reg-2944-admission-'),
  );
  const seed = seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  const worktreePath = seed.workspaces[0]?.worktreePath;
  expect(worktreePath).toBeTruthy();
  const files = seedOfficeFiles(worktreePath);
  writeFileSync(
    path.join(worktreePath, 'budget.docx'),
    Buffer.from(ooxml.buildReg2902ElementBudgetDocxFixture()),
  );
  writeFileSync(
    path.join(worktreePath, 'budget.xlsx'),
    Buffer.from(
      buildReg2902XlsxFixture({ largeRows: 5000, cellTextChars: 1800 }),
    ),
  );
  const macroPayload = Buffer.from(
    buildStoredZip([
      { name: '[Content_Types].xml', data: '<Types/>' },
      { name: 'xl/vbaProject.bin', data: 'macro' },
    ]),
  );
  writeFileSync(path.join(worktreePath, 'macro-disguised.docx'), macroPayload);
  writeFileSync(path.join(worktreePath, 'macro-disguised.xlsx'), macroPayload);
  const rejected = Buffer.from(
    buildStoredZip([{ name: 'EncryptedPackage', data: 'encrypted' }]),
  );
  for (const name of [
    'encrypted.docx',
    'encrypted.xlsx',
    'legacy.doc',
    'legacy.xls',
    'macro.xlsm',
  ]) {
    writeFileSync(path.join(worktreePath, name), rejected);
  }
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    activeTabId: 'text',
    tabs: [fileTab('text', 'office-neighbor.txt', files.text)],
  });
  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    await openSeededWorkspace(window);
    for (const name of [
      'budget.docx',
      'budget.xlsx',
      'encrypted.docx',
      'encrypted.xlsx',
      'macro-disguised.docx',
      'macro-disguised.xlsx',
    ]) {
      const panel = await openFromPanelTree(window, name);
      await expect(
        panel.getByTestId('file-viewer-document-error'),
      ).toHaveAttribute('data-error-kind', 'parse-failed', { timeout: 60_000 });
      await expect(
        panel.getByTestId('file-viewer-open-unsupported'),
      ).toBeVisible();
    }
    for (const name of ['legacy.doc', 'legacy.xls', 'macro.xlsm']) {
      const panel = await openFromPanelTree(window, name);
      await expect(panel.getByTestId('file-viewer-unsupported')).toBeVisible();
    }
    await window.evaluate(() => {
      window.__reg2944NativeWorker = window.Worker;
      window.Worker = class FailedWorker {
        constructor() {
          throw new Error('REG-2944 controlled worker bootstrap failure');
        }
      };
    });
    let panel = await openFromPanelTree(window, 'brief.docx');
    await expect(
      panel.getByTestId('file-viewer-document-error'),
    ).toHaveAttribute('data-error-kind', 'parse-failed', { timeout: 60_000 });
    await window.evaluate(() => {
      window.Worker = window.__reg2944NativeWorker;
    });
    panel = await openFromPanelTree(window, 'q3.xlsx');
    await expectRenderedXlsx(panel);
    panel = await openFromPanelTree(window, 'brief.docx');
    await expectRenderedDocx(panel);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('previews dense DOCX within established budgets and releases workers on repeated navigation', async () => {
  test.setTimeout(240_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-reg-2944-dense-'),
  );
  const seed = seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  const worktreePath = seed.workspaces[0]?.worktreePath;
  expect(worktreePath).toBeTruthy();
  const files = seedOfficeFiles(worktreePath);
  writeFileSync(
    path.join(worktreePath, 'dense.docx'),
    Buffer.from(ooxml.buildReg2902DenseDocxFixture()),
  );
  writeFileSync(
    path.join(worktreePath, 'bounded.docx'),
    Buffer.from(
      ooxml.buildReg2902DenseDocxFixture({ paragraphs: 100, tableRows: 20 }),
    ),
  );
  const imageBytes = Buffer.alloc(4 * 1024 * 1024);
  Buffer.from(ooxml.ONE_PIXEL_PNG_BASE64, 'base64').copy(imageBytes);
  writeFileSync(
    path.join(worktreePath, 'image-budget.docx'),
    Buffer.from(buildReg2902DocxFixture({ imageBytes })),
  );
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    activeTabId: 'text',
    tabs: [fileTab('text', 'office-neighbor.txt', files.text)],
  });
  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    await openSeededWorkspace(window);
    await installDelayedWorker(window, false);
    await window.evaluate(() => {
      window.__reg2944LongTasks = [];
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries())
          window.__reg2944LongTasks.push(entry.duration);
      });
      observer.observe({ type: 'longtask', buffered: true });
      window.__reg2944LongTaskObserver = observer;
    });
    const metrics = [];
    for (let iteration = 0; iteration < 3; iteration += 1) {
      const startedAt = Date.now();
      const panel = await openFromPanelTree(window, 'dense.docx');
      await expectRenderedDocx(panel);
      await expect(
        panel
          .frameLocator('[data-testid="docx-preview-frame"]')
          .locator('body'),
      ).toContainText(ooxml.REG2902_DOCX_DENSE_LAST_TEXT);
      expect(
        await window.evaluate(() => window.__reg2944Workers.responses.at(-1)),
      ).toMatchObject({ ok: true });
      metrics.push({
        iteration,
        elapsedMs: Date.now() - startedAt,
        longTasksMs: await window.evaluate(() =>
          window.__reg2944LongTasks.splice(0),
        ),
        processes: await electronApp.evaluate(({ app }) => app.getAppMetrics()),
      });
      const bounded = await openFromPanelTree(window, 'bounded.docx');
      await expectRenderedDocx(bounded);
      await expect(
        bounded
          .frameLocator('[data-testid="docx-preview-frame"]')
          .locator('body'),
      ).toContainText(ooxml.REG2902_DOCX_DENSE_LAST_TEXT);
      await openFromPanelTree(window, 'office-neighbor.txt');
      await expect(activeFilePanel(window)).toContainText(
        'Office lifecycle text neighbor',
      );
    }
    const imagePanel = await openFromPanelTree(window, 'image-budget.docx');
    await expectRenderedDocx(imagePanel);
    const image = imagePanel
      .frameLocator('[data-testid="docx-preview-frame"]')
      .locator('img');
    await expect(image).toBeVisible();
    expect(
      await image.evaluate((node) => node.getAttribute('src').length),
    ).toBeGreaterThan(5 * 1024 * 1024);
    await openFromPanelTree(window, 'office-neighbor.txt');
    await expect
      .poll(() =>
        window.evaluate(
          () =>
            window.__reg2944Workers.started -
            window.__reg2944Workers.terminated,
        ),
      )
      .toBe(0);
    await window.evaluate(() => window.__reg2944LongTaskObserver.disconnect());
    await test.info().attach('dense-docx-diagnostic-metrics', {
      body: JSON.stringify(metrics, null, 2),
      contentType: 'application/json',
    });
  } catch (error) {
    const page = await electronApp.firstWindow();
    await test.info().attach('office-worker-failure-diagnostics', {
      body: JSON.stringify(
        await page.evaluate(() => window.__reg2944Workers),
        null,
        2,
      ),
      contentType: 'application/json',
    });
    throw error;
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('renders a missing XLSX created by the real automatic branch setup without reactivating its file tab', async () => {
  test.setTimeout(300_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-reg-2944-setup-created-'),
  );
  const seed = seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  const worktreePath = seed.workspaces[0]?.worktreePath;
  expect(worktreePath, 'seeded worktree path').toBeTruthy();
  const setupXlsxPath = path.join(worktreePath, 'setup-created.xlsx');
  const workspaceConfigPath = path.join(
    userDataDir,
    'workspaces',
    WORKSPACE_ID,
    'workspace.json',
  );
  const workspaceConfig = JSON.parse(readFileSync(workspaceConfigPath, 'utf8'));
  workspaceConfig.scripts.setup = `node -e "setTimeout(()=>require('fs').writeFileSync('setup-created.xlsx',Buffer.from('${Buffer.from(buildReg2902XlsxFixture({ largeRows: 2 })).toString('base64')}','base64')),5000)"`;
  writeFileSync(
    workspaceConfigPath,
    `${JSON.stringify(workspaceConfig, null, 2)}\n`,
  );
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    activeTabId: 'setup-xlsx',
    tabs: [fileTab('setup-xlsx', 'setup-created.xlsx', setupXlsxPath)],
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
    await expect(destinationPanel.getByTestId('xlsx-preview')).toHaveCount(0);
    await expect(
      destinationPanel.getByTestId('file-viewer-missing'),
    ).toHaveCount(0);
    await expectRenderedXlsx(destinationPanel);

    const reads = await getInstrumentedFileReads(electronApp);
    expect(
      reads.document.filter((request) =>
        request.absolutePath?.endsWith('setup-created.xlsx'),
      ).length,
    ).toBeGreaterThanOrEqual(1);
    expect(
      [...reads.preview, ...reads.content].filter((request) =>
        request.absolutePath?.endsWith('setup-created.xlsx'),
      ),
    ).toEqual([]);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('drops a gated stale DOCX response after replacement and reloads fresh bytes on reactivation', async () => {
  test.setTimeout(180_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-reg-2944-stale-'),
  );
  const seed = seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  const worktreePath = seed.workspaces[0]?.worktreePath;
  expect(worktreePath).toBeTruthy();
  const files = seedOfficeFiles(worktreePath);
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    activeTabId: 'text',
    tabs: [
      fileTab('text', 'office-neighbor.txt', files.text),
      fileTab('docx', 'brief.docx', files.docx),
    ],
  });
  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    await openSeededWorkspace(window);
    await installDelayedWorker(window);
    await window.getByTestId('panel-tab-panel-file-docx').click();
    await expect
      .poll(() => window.evaluate(() => window.__reg2944Workers.pending))
      .toBe(1);
    writeFileSync(
      files.docx,
      Buffer.from(
        ooxml.buildReg2902DenseDocxFixture({ paragraphs: 2, tableRows: 1 }),
      ),
    );
    await window.getByTestId('panel-tab-panel-file-text').click();
    await window.evaluate(() => window.__reg2944ReleaseWorkers());
    await expect(activeFilePanel(window)).toContainText(
      'Office lifecycle text neighbor',
    );
    await expect(
      activeFilePanel(window).getByTestId('docx-preview'),
    ).toHaveCount(0);
    await expect
      .poll(() =>
        window.evaluate(
          () =>
            window.__reg2944Workers.started -
            window.__reg2944Workers.terminated,
        ),
      )
      .toBe(0);
    await window.getByTestId('panel-tab-panel-file-docx').click();
    await expect
      .poll(() => window.evaluate(() => window.__reg2944Workers.pending))
      .toBe(1);
    await window.evaluate(() => window.__reg2944ReleaseWorkers());
    const panel = activeFilePanel(window);
    await expectRenderedDocx(panel);
    const body = panel
      .frameLocator('[data-testid="docx-preview-frame"]')
      .locator('body');
    await expect(body).toContainText(ooxml.REG2902_DOCX_DENSE_LAST_TEXT);
    await expect(body).not.toContainText(REG2902_DOCX_HEADING);
    await expect
      .poll(() =>
        window.evaluate(
          () =>
            window.__reg2944Workers.started -
            window.__reg2944Workers.terminated,
        ),
      )
      .toBe(0);
  } catch (error) {
    const page = await electronApp.firstWindow();
    await test.info().attach('office-worker-failure-diagnostics', {
      body: JSON.stringify(
        await page.evaluate(() => window.__reg2944Workers),
        null,
        2,
      ),
      contentType: 'application/json',
    });
    throw error;
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('recovers from nested PPTX content limits and reopens a valid deck', async () => {
  test.setTimeout(180_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-pptx-budget-'),
  );
  const seed = seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  const worktreePath = seed.workspaces[0]?.worktreePath;
  expect(worktreePath, 'seeded worktree path').toBeTruthy();
  const deckPath = path.join(worktreePath, 'large.pptx');
  writeFileSync(
    deckPath,
    Buffer.from(buildPptxBudgetFixture({ paragraphs: 6_000 })),
  );
  writeFileSync(
    path.join(worktreePath, 'valid.pptx'),
    Buffer.from(ooxml.buildPptxFixture()),
  );
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    activeTabId: 'pptx',
    tabs: [fileTab('pptx', 'large.pptx', deckPath)],
  });
  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    await openSeededWorkspace(window);
    const panel = activeFilePanel(window);
    const error = panel.getByTestId('file-viewer-document-error');
    await expect(error).toHaveAttribute('data-error-kind', 'parse-failed', {
      timeout: 60_000,
    });
    await expect(panel.getByTestId('pptx-slide')).toHaveCount(0);
    await expect(
      error.getByTestId('file-viewer-open-unsupported'),
    ).toBeVisible();
    const valid = await openFromPanelTree(window, 'valid.pptx');
    await expect(valid.getByTestId('pptx-slide')).toHaveCount(2, {
      timeout: 60_000,
    });
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('renders PPTX slides inline with inherited styling, images, notes, and recovery for unreadable decks', async () => {
  test.setTimeout(180_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-pptx-preview-'),
  );
  const seed = seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  const worktreePath = seed.workspaces[0]?.worktreePath;
  expect(worktreePath, 'seeded worktree path').toBeTruthy();
  const deckPath = path.join(worktreePath, 'deck.pptx');
  writeFileSync(deckPath, Buffer.from(ooxml.buildPptxFixture()));
  writeFileSync(
    path.join(worktreePath, 'corrupt.pptx'),
    Buffer.from('not a zip archive'),
  );
  writeFileSync(
    path.join(worktreePath, 'macro.pptm'),
    Buffer.from(ooxml.buildPptxFixture()),
  );
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    activeTabId: 'pptx',
    tabs: [fileTab('pptx', 'deck.pptx', deckPath)],
  });
  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    await openSeededWorkspace(window);

    let panel = activeFilePanel(window);
    const preview = panel.getByTestId('pptx-preview');
    await expect(preview).toBeVisible({ timeout: 60_000 });
    await expect(preview.getByTestId('pptx-preview-loading')).toHaveCount(0, {
      timeout: 60_000,
    });
    await expect(preview.getByTestId('office-preview-banner')).toHaveText(
      /^Semantic preview: formatting may differ; open (in Finder|in File Explorer|in Files|the original file) for the exact document\.$/,
    );
    const slides = preview.getByTestId('pptx-slide');
    await expect(slides).toHaveCount(2);
    const first = slides.nth(0);
    await expect(first).toHaveAttribute('aria-label', 'Slide 1 of 2');
    await expect(first).toContainText(ooxml.PPTX_TITLE);
    await expect(first).toContainText(ooxml.PPTX_BULLETS[1]);
    await expect(first.getByTestId('pptx-slide-notes')).toContainText(
      ooxml.PPTX_NOTES,
    );
    const image = first.getByTestId('pptx-image');
    await expect(image).toBeVisible();
    await expect(image).toHaveAttribute('alt', 'Ticket trend');
    await expect(image).toHaveAttribute('src', /^data:image\/png;base64,/);

    // Text scales with the slide: a 44pt title on a 960pt-wide slide.
    const scale = await first.evaluate((slide) => {
      const canvas = slide.querySelector('[data-testid="pptx-slide-canvas"]');
      const title = [
        ...slide.querySelectorAll('[data-testid="pptx-shape"] span'),
      ].find((span) => span.textContent === 'Quarterly support review');
      return {
        canvasWidth: canvas.getBoundingClientRect().width,
        titleSize: Number.parseFloat(getComputedStyle(title).fontSize),
        titleWeight: getComputedStyle(title).fontWeight,
        masterFill: [
          ...slide.querySelectorAll('[data-testid="pptx-shape"]'),
        ].map((shape) => getComputedStyle(shape).backgroundColor),
      };
    });
    expect(scale.canvasWidth).toBeGreaterThan(0);
    expect(scale.titleSize / scale.canvasWidth).toBeCloseTo(44 / 960, 3);
    expect(scale.titleWeight).toBe('700');
    expect(scale.masterFill).toContain('rgb(37, 99, 235)');

    const second = slides.nth(1);
    await second.scrollIntoViewIfNeeded();
    await expect(second.getByTestId('pptx-slide-hidden')).toHaveText('Hidden');
    await expect(second.getByTestId('pptx-table')).toContainText(
      ooxml.PPTX_TABLE_CELL,
    );
    await expect(second.getByTestId('pptx-unsupported')).toHaveText(
      'Chart not shown in preview',
    );
    await expect(second).toContainText(ooxml.PPTX_GROUP_TEXT);
    await expect(panel.getByTestId('file-viewer-open-original')).toHaveText(
      /^Open in (Finder|File Explorer|Files|file manager)$/,
    );

    await electronApp.evaluate(({ shell }) => {
      globalThis.__pptxReveals = [];
      shell.showItemInFolder = (filePath) => {
        globalThis.__pptxReveals.push(filePath);
      };
    });
    panel = await openFromPanelTree(window, 'corrupt.pptx');
    const error = panel.getByTestId('file-viewer-document-error');
    await expect(error).toHaveAttribute('data-error-kind', 'parse-failed', {
      timeout: 60_000,
    });
    await error.getByTestId('file-viewer-open-unsupported').click();
    await expect
      .poll(() => electronApp.evaluate(() => globalThis.__pptxReveals))
      .toEqual([realpathSync(path.join(worktreePath, 'corrupt.pptx'))]);

    panel = await openFromPanelTree(window, 'macro.pptm');
    await expect(panel.getByTestId('file-viewer-unsupported')).toBeVisible();

    panel = await openFromPanelTree(window, 'deck.pptx');
    await expect(panel.getByTestId('pptx-slide')).toHaveCount(2, {
      timeout: 60_000,
    });
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
