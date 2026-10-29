// Headless fixture smoke only; it is not wired into CI. Run through the host
// guard: node scripts/run-guarded-dev-script.mjs --suite e2e -- node --test
// apps/desktop-app/tests/electron/browser-lab-interaction/interaction-smoke.test.mjs
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { _electron } from 'playwright';
import { ensureElectronBinaryInstalled } from '../../../../../scripts/lib/electron-binary.mjs';
import {
  BROWSER_LAB_INTERACTION_CASES,
  BROWSER_LAB_INTERACTION_LIMITS,
  listenPairedBrowserLabServers,
} from '../mock-server/routes/browser-lab.mjs';

const INTERACTION_ROOT_ENV = 'BROWSER_LAB_INTERACTION_ROOT';
const GENERIC_ABORT_ERROR = 'Failed to load resource: net::ERR_FAILED';

function parsedUrl(value) {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function isInertInvalidUrl(value) {
  const url = parsedUrl(value);
  return url !== null && url.hostname.toLowerCase().endsWith('.invalid');
}

function makeDiagnostics(caseId, pagePath) {
  return {
    label: `${caseId} ${pagePath}`,
    consoleErrors: [],
    pageErrors: [],
    invalidRequestAborts: [],
    unexpectedBlockedRequests: [],
    unexpectedRequestFailures: [],
  };
}

function assertPageDiagnostics(diagnostics) {
  const cspViolations = diagnostics.consoleErrors.filter((message) =>
    /content security policy|violates? .*policy|refused to/i.test(message),
  );
  assert.deepEqual(
    cspViolations,
    [],
    `${diagnostics.label}: unexpected Content Security Policy console errors`,
  );
  assert.deepEqual(
    diagnostics.pageErrors,
    [],
    `${diagnostics.label}: unexpected uncaught page errors`,
  );
  assert.deepEqual(
    diagnostics.unexpectedBlockedRequests,
    [],
    `${diagnostics.label}: a request outside the fixture origins was blocked`,
  );
  assert.deepEqual(
    diagnostics.unexpectedRequestFailures,
    [],
    `${diagnostics.label}: an allowed or non-.invalid request failed`,
  );

  // Chromium's resource-failure console line omits the request URL. Ignore
  // only its exact generic net::ERR_FAILED form, and only when this same page
  // explicitly routed at least that many reserved .invalid requests to abort.
  const genericAbortErrors = diagnostics.consoleErrors.filter(
    (message) => message === GENERIC_ABORT_ERROR,
  );
  assert.ok(
    genericAbortErrors.length <= diagnostics.invalidRequestAborts.length,
    `${diagnostics.label}: generic request failures were not all attributable to explicitly aborted .invalid URLs`,
  );
  const unexpectedConsoleErrors = diagnostics.consoleErrors.filter(
    (message) => message !== GENERIC_ABORT_ERROR,
  );
  assert.deepEqual(
    unexpectedConsoleErrors,
    [],
    `${diagnostics.label}: unexpected console errors`,
  );
}

async function assertAuthBoundary(primaryOrigin, authCase) {
  const protectedPage = authCase.pages.find((page) => page.requiresAuth);
  assert.ok(protectedPage, 'The auth fixture must include a protected page');

  const denied = await fetch(`${primaryOrigin}${protectedPage.path}`, {
    signal: AbortSignal.timeout(10_000),
  });
  assert.equal(
    denied.status,
    401,
    'Protected page must reject missing credentials',
  );
  assert.match(await denied.text(), /Authentication required/);

  const credentials = authCase.credentials;
  assert.ok(credentials?.username && credentials?.password);
  return `Basic ${Buffer.from(
    `${credentials.username}:${credentials.password}`,
    'utf8',
  ).toString('base64')}`;
}

async function assertUploadEcho(primaryOrigin, uploadCase) {
  const endpoint = uploadCase.endpoints?.[0];
  assert.ok(endpoint, 'The upload fixture must list its echo endpoint');
  const contents = Buffer.from('Browser Lab interaction smoke upload.\n');
  const form = new FormData();
  form.append(
    'files',
    new Blob([contents], { type: 'text/plain' }),
    'smoke.txt',
  );

  const response = await fetch(`${primaryOrigin}${endpoint}`, {
    method: 'POST',
    body: form,
    signal: AbortSignal.timeout(10_000),
  });
  assert.equal(response.status, 200, 'Multipart upload echo must succeed');
  const result = await response.json();
  assert.equal(
    result.files?.[0]?.sha256,
    createHash('sha256').update(contents).digest('hex'),
    "Upload echo must return the uploaded bytes' SHA-256",
  );
}

async function assertDownloadEndpoints(primaryOrigin, downloadsCase) {
  assert.ok(downloadsCase.endpoints?.length, 'Downloads must list endpoints');
  for (const endpoint of downloadsCase.endpoints) {
    const metadata = downloadsCase.downloads?.find(
      (download) => download.path === endpoint,
    );
    assert.ok(metadata, `Missing download metadata for ${endpoint}`);

    const response = await fetch(`${primaryOrigin}${endpoint}`, {
      signal: AbortSignal.timeout(15_000),
    });
    assert.equal(response.status, 200, `Download endpoint ${endpoint}`);
    assert.equal(
      response.headers.get('content-disposition'),
      metadata.disposition,
      `Download metadata for ${endpoint}`,
    );

    // Large and interrupted bodies are intentionally not drained: the first
    // is throttled and the second takes time to break its connection. Cancel
    // immediately after headers; all deterministic small fixture bodies are
    // consumed so the endpoint is fully exercised.
    if (metadata.variant === 'large' || metadata.variant === 'interrupted') {
      await response.body?.cancel();
    } else {
      await response.arrayBuffer();
    }
  }
}

async function assertCrossSiteFrameProcess(
  primaryOrigin,
  pairedOrigin,
  app,
  page,
) {
  const crossSiteFrame = page
    .frames()
    .find(
      (frame) =>
        frame !== page.mainFrame() && frame.url().startsWith(pairedOrigin),
    );
  assert.ok(crossSiteFrame, 'Expected a loaded iframe from the paired origin');
  await crossSiteFrame.waitForLoadState('domcontentloaded');
  assert.equal(new URL(page.mainFrame().url()).origin, primaryOrigin);
  assert.equal(new URL(crossSiteFrame.url()).origin, pairedOrigin);
  await crossSiteFrame
    .getByTestId('browser-lab-frames-cross-site-form')
    .waitFor({ state: 'attached' });

  // Electron 42 exposes WebContents.getAllWebContents() and
  // WebFrameMain.framesInSubtree/processId. Compare the actual top-level and
  // paired child-frame renderer process ids; this verifies OOPIF isolation,
  // not just that the frame has a different origin.
  const processInfo = await app.evaluate(
    ({ webContents }, { primary, paired }) => {
      if (typeof webContents?.getAllWebContents !== 'function') return null;
      const contents = webContents.getAllWebContents().find((candidate) => {
        try {
          return new URL(candidate.getURL()).origin === primary;
        } catch {
          return false;
        }
      });
      if (!contents?.mainFrame) return null;
      const mainFrame = contents.mainFrame;
      const frames = mainFrame.framesInSubtree;
      if (!Array.isArray(frames)) return null;
      const pairedFrame = frames.find((frame) => frame.url.startsWith(paired));
      if (!pairedFrame) return null;
      return {
        mainOrigin: new URL(mainFrame.url).origin,
        mainProcessId: mainFrame.processId,
        pairedProcessId: pairedFrame.processId,
      };
    },
    { primary: primaryOrigin, paired: pairedOrigin },
  );

  if (processInfo?.mainProcessId !== undefined) {
    assert.equal(processInfo.mainOrigin, primaryOrigin);
    assert.ok(Number.isInteger(processInfo.mainProcessId));
    assert.ok(Number.isInteger(processInfo.pairedProcessId));
    assert.notEqual(
      processInfo.pairedProcessId,
      processInfo.mainProcessId,
      'Cross-site iframe must use a distinct renderer process',
    );
    return;
  }

  // Fallback for an Electron build without the WebFrameMain subtree API. Some
  // Playwright Frame implementations expose processId/osProcessId; if neither
  // API exists, this assertion fails rather than silently claiming OOPIF proof.
  const mainFrame = page.mainFrame();
  const mainProcessId = mainFrame.osProcessId ?? mainFrame.processId;
  const pairedProcessId =
    crossSiteFrame.osProcessId ?? crossSiteFrame.processId;
  assert.notEqual(
    mainProcessId,
    undefined,
    'Main-frame process id is unavailable',
  );
  assert.notEqual(
    pairedProcessId,
    undefined,
    'Cross-site frame process id is unavailable',
  );
  assert.notEqual(
    pairedProcessId,
    mainProcessId,
    'Cross-site iframe must use a distinct renderer process',
  );
}

test(
  'Browser Lab interaction fixtures load safely in a hidden disposable Electron window',
  { timeout: 180_000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'browser-lab-interaction-'));
    let lab;
    let app;
    try {
      lab = await listenPairedBrowserLabServers();
      const allowedOrigins = new Set([lab.primary.origin, lab.paired.origin]);
      const authCase = BROWSER_LAB_INTERACTION_CASES.find(
        (fixture) => fixture.id === 'auth',
      );
      const uploadCase = BROWSER_LAB_INTERACTION_CASES.find(
        (fixture) => fixture.id === 'upload',
      );
      const downloadsCase = BROWSER_LAB_INTERACTION_CASES.find(
        (fixture) => fixture.id === 'downloads',
      );
      assert.ok(authCase && uploadCase && downloadsCase);

      const authorization = await assertAuthBoundary(
        lab.primary.origin,
        authCase,
      );
      await assertUploadEcho(lab.primary.origin, uploadCase);
      await assertDownloadEndpoints(lab.primary.origin, downloadsCase);

      ensureElectronBinaryInstalled();
      app = await _electron.launch({
        executablePath: process.env.ELECTRON_EXEC_PATH,
        args: [
          fileURLToPath(new URL('./interaction-shell.mjs', import.meta.url)),
        ],
        env: { ...process.env, [INTERACTION_ROOT_ENV]: root },
        timeout: 30_000,
      });
      const page = await app.firstWindow();
      page.setDefaultTimeout(15_000);
      page.setDefaultNavigationTimeout(30_000);
      assert.equal(
        await app.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows().some((window) => window.isVisible()),
        ),
        false,
        'The fixture window must stay hidden',
      );

      let activeDiagnostics;
      page.on('console', (message) => {
        if (message.type() === 'error' && activeDiagnostics) {
          activeDiagnostics.consoleErrors.push(message.text());
        }
      });
      page.on('pageerror', (error) => {
        if (activeDiagnostics) activeDiagnostics.pageErrors.push(error.message);
      });
      page.on('requestfailed', (request) => {
        if (!activeDiagnostics) return;
        // .invalid requests were classified synchronously by the route handler;
        // do not count this follow-up event as a second expected abort.
        if (!isInertInvalidUrl(request.url())) {
          activeDiagnostics.unexpectedRequestFailures.push(request.url());
        }
      });
      await page.route('**/*', async (route) => {
        const requestUrl = route.request().url();
        const request = parsedUrl(requestUrl);
        if (request && allowedOrigins.has(request.origin)) {
          await route.continue();
          return;
        }
        if (activeDiagnostics) {
          if (isInertInvalidUrl(requestUrl)) {
            activeDiagnostics.invalidRequestAborts.push(requestUrl);
          } else {
            activeDiagnostics.unexpectedBlockedRequests.push(requestUrl);
          }
        }
        await route.abort();
      });

      for (const fixture of BROWSER_LAB_INTERACTION_CASES) {
        for (const fixturePage of fixture.pages) {
          const diagnostics = makeDiagnostics(fixture.id, fixturePage.path);
          activeDiagnostics = diagnostics;
          if (fixturePage.requiresAuth) {
            await page.setExtraHTTPHeaders({ authorization });
          }

          let response;
          try {
            response = await page.goto(
              `${lab.primary.origin}${fixturePage.path}`,
              { waitUntil: 'load', timeout: 30_000 },
            );
          } finally {
            if (fixturePage.requiresAuth) {
              await page.setExtraHTTPHeaders({});
            }
          }
          assert.ok(
            response,
            `${diagnostics.label}: missing navigation response`,
          );
          assert.equal(
            response.status(),
            200,
            `${diagnostics.label}: HTTP status`,
          );
          assert.equal(
            await page.locator('body').getAttribute('data-browser-lab-kind'),
            'interaction',
            `${diagnostics.label}: page kind`,
          );
          assert.equal(
            await page.locator('body').getAttribute('data-browser-lab-case'),
            fixture.id,
            `${diagnostics.label}: case marker`,
          );

          for (const testId of fixturePage.controls) {
            const control = page.getByTestId(testId);
            await control.first().waitFor({ state: 'attached' });
            assert.ok(
              (await control.count()) >= 1,
              `${diagnostics.label}: missing control ${testId}`,
            );
          }

          if (
            fixture.id === 'editor' &&
            fixturePage.path === '/browser-lab/editor'
          ) {
            assert.equal(
              await page
                .getByTestId('browser-lab-editor-plain-status')
                .getAttribute('data-browser-lab-value'),
              'Edit this plain text region.',
            );

            // Typing over a selection replaces it, and deleting a selection
            // that spans paragraphs removes all of it.
            const modelStatus = page.getByTestId(
              'browser-lab-editor-model-status',
            );
            const selectInModel = (expression) =>
              page.evaluate((body) => {
                const editor = document.querySelector(
                  '[data-testid="browser-lab-editor-model"]',
                );
                editor.focus();
                const range = document.createRange();
                new Function('editor', 'range', body)(editor, range);
                const selection = window.getSelection();
                selection.removeAllRanges();
                selection.addRange(range);
              }, expression);
            await selectInModel(`
              const text = editor.querySelector('[data-testid="browser-lab-editor-leaf-1"]').firstChild;
              range.setStart(text, 12);
              range.setEnd(text, 17);
            `);
            await page.keyboard.type('graph');
            assert.equal(
              await modelStatus.getAttribute('data-browser-lab-model'),
              'The browser interaction graph\nkeeps leaf boundaries in view.',
            );
            await selectInModel('range.selectNodeContents(editor);');
            await page.keyboard.press('Backspace');
            assert.equal(
              await modelStatus.getAttribute('data-browser-lab-model'),
              '',
            );
          }

          if (
            fixture.id === 'controls' &&
            fixturePage.path === '/browser-lab/controls'
          ) {
            for (const testId of [
              'browser-lab-controls-checkbox-aria',
              'browser-lab-controls-switch-aria',
            ]) {
              const widget = page.getByTestId(testId);
              const box = await widget.boundingBox();
              assert.ok(
                box && box.width > 0 && box.height > 0,
                `${testId} must have a pointer target`,
              );
              await widget.click();
              assert.equal(await widget.getAttribute('aria-checked'), 'true');
            }
          }

          if (
            fixture.id === 'shadow' &&
            fixturePage.path === '/browser-lab/shadow'
          ) {
            await page.getByTestId('browser-lab-shadow-select-trigger').click();
            await page.getByTestId('browser-lab-shadow-option-blue').click();
            const selectionStatus = page.getByTestId(
              'browser-lab-shadow-selection-status',
            );
            assert.equal(
              await selectionStatus.getAttribute('data-browser-lab-selection'),
              'blue',
            );
            assert.equal(
              await selectionStatus.getAttribute('data-browser-lab-state'),
              'selected',
            );
          }

          if (
            fixture.id === 'frames' &&
            fixturePage.path === '/browser-lab/frames'
          ) {
            await assertCrossSiteFrameProcess(
              lab.primary.origin,
              lab.paired.origin,
              app,
              page,
            );
          }

          if (
            fixture.id === 'heavy' &&
            fixturePage.path === '/browser-lab/heavy'
          ) {
            const heavyStatus = page.locator(
              '[data-testid="browser-lab-heavy-status"][data-browser-lab-heavy-ready="true"]',
            );
            await heavyStatus.waitFor({ state: 'attached' });
            const elementCount = Number(
              await heavyStatus.getAttribute('data-browser-lab-element-count'),
            );
            assert.ok(
              Number.isSafeInteger(elementCount) &&
                elementCount >= BROWSER_LAB_INTERACTION_LIMITS.heavyElements,
              `Heavy page element count ${elementCount} must meet its catalog limit`,
            );
            const iframeCounts = await page.evaluate((pairedOrigin) => {
              const iframes = Array.from(document.querySelectorAll('iframe'));
              return {
                total: iframes.length,
                crossSite: iframes.filter((frame) =>
                  frame.src.startsWith(pairedOrigin),
                ).length,
              };
            }, lab.paired.origin);
            assert.equal(
              iframeCounts.total,
              BROWSER_LAB_INTERACTION_LIMITS.heavyFrames,
            );
            assert.equal(
              iframeCounts.crossSite,
              BROWSER_LAB_INTERACTION_LIMITS.heavyCrossSiteFrames,
            );
          }

          assertPageDiagnostics(diagnostics);
          activeDiagnostics = undefined;
        }
      }
    } finally {
      try {
        if (app) await app.close();
      } finally {
        try {
          if (lab) await lab.close();
        } finally {
          await rm(root, { recursive: true, force: true });
        }
      }
    }
  },
);
