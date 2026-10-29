// CAN-1570 phase 07a: in-app browser downloads land as named task files.
// Every case drives the Browser Lab `downloads` or `hostile-transfers` page
// and checks the task's `browser-files/downloads/` folder on disk. Cases with
// an agent action run once per agent route (App Advisor and MCP), each in its
// own launch.
import { Buffer } from 'node:buffer';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { closeCanopy, getMainWindow, launchCanopy } from './launchCanopy.mjs';
import { listenPairedBrowserLabServers } from './mock-server/routes/browser-lab.mjs';
import {
  chatPanelLocator,
  SEEDED_CHAT_TAB_ID,
  seedPanelWorktree,
} from './panelHarness.mjs';
import { seedWorktreeChat } from './seeders/index.mjs';
import { seedArchiveActivityFixture } from './seeders/archiveActivityFixture.mjs';
import {
  armSaveDialogSpy,
  chatForRoute,
  clickInLab,
  dispatchAdvisor,
  dispatchMcp,
  downloadInLab,
  downloadInLabLater,
  expectPathFree,
  filesIn,
  inLab,
  isFinal,
  listTransfers,
  nativePrints,
  OWNER,
  openFilesPanel,
  openLab,
  pollTransfers,
  readLab,
  receiptOf,
  ROUTES,
  saveDialogCalls,
  selector,
  endApprovalSession,
  startApprovalSession,
  stubNativePrint,
  syntheticBytes,
  taskDownloadsDir,
  taskFilesDir,
  waitForOf,
  withBrowser,
  WORKTREE_ROUTE,
  ADVISOR_ENTRY_ROUTE,
} from './browser-files-harness.mjs';

const LARGE_BYTES = 8 * 1024 * 1024;
const RESUMABLE_BYTES = 1024 * 1024;
const RESUMABLE_INTERRUPT_BYTES = 256 * 1024;
const RESUMABLE_SEED = 'Browser Lab resumable download synthetic bytes';

let lab;
let origin;

test.beforeAll(async () => {
  lab = await listenPairedBrowserLabServers();
  origin = lab.primary.origin;
});

test.afterAll(async () => {
  await lab?.close();
});

/** The agent-visible part of a route response; App Advisor adds UI state beside it. */
function payloadOf(response) {
  return response.result ?? response;
}

function expectAgentPayloadPathFree(response, label, userDataDir) {
  expectPathFree(payloadOf(response), label, [userDataDir]);
}

async function waitForDownload(run, download, timeoutMs) {
  return run({ type: 'browser.wait_for', download, timeoutMs });
}

function settledFields(browser) {
  return {
    url: browser?.url,
    status: browser?.status,
    loading: browser?.loading,
    lastError: browser?.lastError,
  };
}

function readyPage(url) {
  return { url, status: 'ready', loading: false, lastError: undefined };
}

/** The tab still shows the lab page, finished loading, with no error. */
async function expectPageSettled(run, browserId, url, context = '') {
  const settled = async () => {
    const listed = await run({ type: 'browser.list' });
    expect(listed.ok, JSON.stringify(listed)).toBe(true);
    return settledFields(
      payloadOf(listed).browsers.find(
        (candidate) => candidate.id === browserId,
      ),
    );
  };
  await expect
    .poll(settled, { message: context, timeout: 10_000 })
    .toEqual(readyPage(url));
}

/** No network entry for the download's own URL is a failed request. */
async function expectNoFailedDownloadRequest(run, downloadPath) {
  const network = payloadOf(
    await run({ type: 'browser.get_network', limit: 200 }),
  );
  const failed = network.entries.filter(
    (entry) => entry.url.includes(downloadPath) && entry.failed === true,
  );
  expect(failed, JSON.stringify(network.entries)).toEqual([]);
}

function releaseHold(token) {
  return fetch(
    `${origin}/browser-lab/download/resumable-release?hold=${token}`,
  ).then((response) => {
    expect(response.status).toBe(200);
  });
}

test.describe('phase 07a: downloads as named task files', () => {
  test('downloads land in the task folder under sanitized unique names, and the save dialog never opens, through both routes', async () => {
    test.setTimeout(240_000);
    // Each link is clicked by the agent; the expected name is the safe form
    // the task folder must hold, and the body is the fixture's exact bytes.
    const cases = [
      [
        'attachment',
        'browser-lab-report.txt',
        'Browser Lab attachment report\n',
      ],
      ['blob', 'browser-lab-blob.txt', 'Browser Lab blob download\n'],
      [
        'data-url',
        'browser-lab-data-url.txt',
        'Browser Lab data URL download\n',
      ],
      ['same-name-a', 'browser-lab-duplicate.txt', 'Browser Lab duplicate A\n'],
      [
        'same-name-b',
        'browser-lab-duplicate (1).txt',
        'Browser Lab duplicate B\n',
      ],
      [
        'hostile-unix-traversal',
        '_.._etc_passwd',
        'Browser Lab synthetic Unix traversal name\n',
      ],
      [
        'hostile-windows-traversal',
        'Windowsx.txt',
        'Browser Lab synthetic Windows traversal name\n',
      ],
      [
        'hostile-reserved',
        '_CON.txt',
        'Browser Lab synthetic reserved filename\n',
      ],
      [
        'hostile-trailing-dots',
        'browser-lab-trailing.txt',
        'Browser Lab synthetic trailing dots filename\n',
      ],
      [
        'hostile-long',
        `browser-lab-long-${'a'.repeat(179)}.txt`,
        'Browser Lab synthetic long filename\n',
      ],
      ['hostile-nul', 'file.txt_.exe', 'Browser Lab synthetic NUL filename\n'],
      [
        'hostile-unicode',
        'Résumé – 東京 ✓.txt',
        'Browser Lab synthetic Unicode filename\n',
      ],
    ];
    await withBrowser(
      origin,
      'downloads',
      async ({ kind, run, browserId, electronApp, userDataDir, prepared }) => {
        const downloadsDir = taskDownloadsDir(userDataDir);
        const seen = new Map();
        for (const [variant, fileName, body] of cases) {
          const clicked = await run({
            type: 'browser.click',
            locator: selector(`browser-lab-downloads-${variant}`),
          });
          expect(clicked.ok, JSON.stringify(clicked)).toBe(true);
          expectAgentPayloadPathFree(clicked, `${variant} click`, userDataDir);
          const receipt = receiptOf(clicked);
          expect(receipt.status).toBe('executed');
          // The click's receipt names the download it started, as the agent's.
          expect(receipt.effects?.downloads, variant).toHaveLength(1);
          const [started] = receipt.effects.downloads;
          expect(started).toMatchObject({
            kind: 'download',
            browserId,
            source: 'agent',
            actionId: receipt.actionId,
            fileName,
          });
          // A small download has finished by the time the click settles.
          expect(started.status, variant).toBe('complete');
          expect(Buffer.byteLength(started.fileName, 'utf8')).toBeLessThan(201);

          const waited = await waitForDownload(
            run,
            { downloadId: started.id },
            15_000,
          );
          expect(waited.ok, JSON.stringify(waited)).toBe(true);
          expectAgentPayloadPathFree(waited, `${variant} wait`, userDataDir);
          const waitFor = waitForOf(waited, kind);
          expect(waitFor?.satisfied, JSON.stringify(waited)).toBe(true);
          expect(waitFor.observed.download).toMatchObject({
            id: started.id,
            fileName,
            status: 'complete',
            receivedBytes: Buffer.byteLength(body, 'utf8'),
          });
          expect(
            readFileSync(path.join(downloadsDir, fileName), 'utf8'),
            variant,
          ).toBe(body);
          seen.set(variant, waitFor.observed.download);
        }

        // Blob and data URL downloads name only their scheme; links keep
        // their origin and path.
        expect(seen.get('blob').origin).toBe('blob:');
        expect(seen.get('data-url').origin).toBe('data:');
        expect(seen.get('attachment').origin).toBe(
          `${origin}/browser-lab/download/attachment`,
        );

        // The folder holds exactly the named files: no staging file, and
        // nothing outside the task folder.
        const listed = await listTransfers(run, { limit: 100 });
        expectPathFree(listed, 'list_transfers', [userDataDir]);
        expect(listed.total).toBe(cases.length);
        expect(listed.transfers.map((transfer) => transfer.status)).toEqual(
          cases.map(() => 'complete'),
        );
        expect(filesIn(downloadsDir)).toEqual(
          cases.map(([, fileName]) => fileName).sort(),
        );
        expect(
          listed.transfers.map((transfer) => transfer.fileName).sort(),
        ).toEqual(filesIn(downloadsDir));

        // No native save dialog, and Electron's default folder stays empty.
        expect(await saveDialogCalls(electronApp)).toEqual([]);
        expect(filesIn(prepared)).toEqual([]);
      },
      { beforeOpen: ({ electronApp }) => armSaveDialogSpy(electronApp) },
    );
  });

  test('a link download leaves the page loaded and ready for a load-state wait, without a failed request, through both routes', async () => {
    test.setTimeout(240_000);
    await withBrowser(
      origin,
      'downloads',
      async ({ kind, run, browserId, window, url }) => {
        const clicked = await run({
          type: 'browser.click',
          locator: selector('browser-lab-downloads-attachment'),
        });
        expect(clicked.ok, JSON.stringify(clicked)).toBe(true);
        const [started] = receiptOf(clicked).effects?.downloads ?? [];
        expect(started?.fileName).toBe('browser-lab-report.txt');
        // The click's own snapshot already shows the page, not a load.
        expect(settledFields(payloadOf(clicked).browser)).toEqual(
          readyPage(url),
        );
        const waited = await waitForDownload(
          run,
          { downloadId: started.id },
          15_000,
        );
        expect(waitForOf(waited, kind)?.observed?.download?.status).toBe(
          'complete',
        );

        await expectPageSettled(run, browserId, url);
        const loaded = await run({
          type: 'browser.wait_for',
          loadState: 'load',
          timeoutMs: 5_000,
        });
        expect(loaded.ok, JSON.stringify(loaded)).toBe(true);
        expect(
          waitForOf(loaded, kind)?.satisfied,
          JSON.stringify(payloadOf(loaded)),
        ).toBe(true);
        await expectNoFailedDownloadRequest(
          run,
          '/browser-lab/download/attachment',
        );
        // More, which leads to the details, carries no unread error dot.
        const pane = window.getByTestId(`browser-pane-${browserId}`);
        await expect(pane.getByTestId('browser-more')).toBeVisible();
        await expect(pane.getByTestId('browser-more-error-dot')).toHaveCount(0);
      },
    );
  });

  test('navigate straight to an attachment saves it to the task folder and leaves the page as it was, through both routes', async () => {
    test.setTimeout(240_000);
    await withBrowser(
      origin,
      'downloads',
      async ({ run, browserId, electronApp, userDataDir, url, prepared }) => {
        const downloadUrl = `${origin}/browser-lab/download/attachment`;
        const navigated = await run({
          type: 'browser.navigate',
          url: downloadUrl,
        });
        expectAgentPayloadPathFree(navigated, 'navigate', userDataDir);
        // The navigation became a download: navigate reports the page it
        // left in place, not a failed load.
        expect(navigated.ok, JSON.stringify(navigated)).toBe(true);
        expect(settledFields(payloadOf(navigated).browser)).toEqual(
          readyPage(url),
        );
        // Navigation attributes nothing: the transfer is the user's.
        const saved = await pollTransfers(run, (transfers) =>
          transfers.find(
            (transfer) =>
              transfer.fileName === 'browser-lab-report.txt' &&
              transfer.status === 'complete',
          ),
        );
        expect(saved).toMatchObject({ source: 'user', origin: downloadUrl });
        expect(saved).not.toHaveProperty('actionId');
        expect(receiptOf(navigated)?.effects?.downloads).toBeUndefined();
        expect(
          readFileSync(
            path.join(taskDownloadsDir(userDataDir), 'browser-lab-report.txt'),
            'utf8',
          ),
        ).toBe('Browser Lab attachment report\n');
        await expectPageSettled(run, browserId, url, JSON.stringify(navigated));
        expect(await saveDialogCalls(electronApp)).toEqual([]);
        expect(filesIn(prepared)).toEqual([]);
      },
      { beforeOpen: ({ electronApp }) => armSaveDialogSpy(electronApp) },
    );
  });

  test('a download never replaces a file the user put in the task folder, through both routes', async () => {
    test.setTimeout(240_000);
    await withBrowser(origin, 'downloads', async ({ run, userDataDir }) => {
      const downloadsDir = taskDownloadsDir(userDataDir);
      // The file arrives after the task's browser opened its folder.
      writeFileSync(
        path.join(downloadsDir, 'browser-lab-report.txt'),
        'Kept by the user\n',
      );
      const clicked = await run({
        type: 'browser.click',
        locator: selector('browser-lab-downloads-attachment'),
      });
      expect(clicked.ok, JSON.stringify(clicked)).toBe(true);
      const [started] = receiptOf(clicked).effects?.downloads ?? [];
      expect(started).toMatchObject({
        fileName: 'browser-lab-report (1).txt',
        status: 'complete',
      });
      expect(
        readFileSync(path.join(downloadsDir, 'browser-lab-report.txt'), 'utf8'),
      ).toBe('Kept by the user\n');
      expect(
        readFileSync(
          path.join(downloadsDir, 'browser-lab-report (1).txt'),
          'utf8',
        ),
      ).toBe('Browser Lab attachment report\n');
      expect(filesIn(downloadsDir)).toEqual([
        'browser-lab-report (1).txt',
        'browser-lab-report.txt',
      ]);
    });
  });

  test("a page cannot name a download after another download's partial file, through both routes", async () => {
    test.setTimeout(240_000);
    await withBrowser(
      origin,
      'downloads',
      async ({ run, electronApp, userDataDir, url }) => {
        const downloadsDir = taskDownloadsDir(userDataDir);
        const named = `${origin}/browser-lab/download/named`;
        await downloadInLab(
          electronApp,
          url,
          '/browser-lab/download/named?name=collide-partial',
        );
        const first = await pollTransfers(run, (transfers) =>
          transfers.find(
            (transfer) => transfer.origin === named && isFinal(transfer),
          ),
        );
        expect(first).toMatchObject({
          fileName: 'browser-lab-collide.txt.download',
          status: 'complete',
        });
        // Its name is the partial file name of a download called
        // browser-lab-collide.txt.
        await downloadInLab(
          electronApp,
          url,
          '/browser-lab/download/named?name=collide',
        );
        const second = await pollTransfers(run, (transfers) =>
          transfers.find(
            (transfer) =>
              transfer.origin === named &&
              transfer.id !== first.id &&
              isFinal(transfer),
          ),
        );
        expect(second.status).toBe('complete');
        expect(second.fileName).not.toBe(first.fileName);
        expect(
          readFileSync(path.join(downloadsDir, first.fileName), 'utf8'),
        ).toBe('Browser Lab named download collide-partial\n');
        expect(
          readFileSync(path.join(downloadsDir, second.fileName), 'utf8'),
        ).toBe('Browser Lab named download collide\n');
        expect(filesIn(downloadsDir)).toEqual(
          [first.fileName, second.fileName].sort(),
        );
      },
    );
  });

  test('a running download keeps its row and its Cancel however many downloads finish after it', async () => {
    test.setTimeout(300_000);
    await withBrowser(
      origin,
      'downloads',
      async ({ run, electronApp, window, browserId, url, userDataDir }) => {
        await downloadInLab(
          electronApp,
          url,
          `/browser-lab/download/resumable?hold=${randomUUID()}&stall=1`,
        );
        const running = await pollTransfers(run, (transfers) =>
          transfers.find(
            (transfer) =>
              transfer.fileName === 'browser-lab-stalled.bin' &&
              transfer.status === 'in_progress',
          ),
        );
        // More than the Files panel's hundred records finish after it.
        for (let index = 1; index <= 101; index += 1) {
          if (index % 15 === 0)
            await window.evaluate(
              (id) =>
                window.api.browser.transferCommand({
                  kind: 'allow_more',
                  browserId: id,
                }),
              browserId,
            );
          await downloadInLab(
            electronApp,
            url,
            '/browser-lab/download/attachment',
          );
          // The stalled download falls off the agent's first page; only the
          // attachments on it are checked.
          await pollTransfers(run, (transfers, payload) =>
            payload.total === index + 1 &&
            transfers.every(
              (transfer) => transfer.id === running.id || isFinal(transfer),
            )
              ? true
              : undefined,
          );
        }
        const button = window
          .getByTestId(`browser-pane-${browserId}`)
          .getByTestId('browser-files-button');
        await expect(button).toHaveAttribute(
          'aria-label',
          'Show downloads, 1 in progress',
        );
        const { pane } = await openFilesPanel(window, browserId);
        await expect(
          pane.getByTestId(`browser-transfer-row-${running.id}`),
        ).toHaveAttribute('aria-label', 'browser-lab-stalled.bin, Downloading');
        await pane.getByTestId(`browser-transfer-cancel-${running.id}`).click();
        // Older than the agent's first page: ask for cancelled ones.
        await expect
          .poll(async () =>
            (await listTransfers(run, { status: 'cancelled' })).transfers.map(
              (transfer) => transfer.id,
            ),
          )
          .toContain(running.id);
        expect(
          filesIn(taskDownloadsDir(userDataDir)).filter((name) =>
            name.endsWith('.download'),
          ),
        ).toEqual([]);
      },
      { routes: ['advisor'] },
    );
  });

  test("a file that takes a cancelled download's partial name is never removed", async () => {
    test.setTimeout(240_000);
    await withBrowser(
      origin,
      'downloads',
      async ({ run, userDataDir }) => {
        const downloadsDir = taskDownloadsDir(userDataDir);
        const clicked = await run({
          type: 'browser.click',
          locator: selector('browser-lab-downloads-large'),
          timeoutMs: 2_000,
        });
        expect(clicked.ok, JSON.stringify(clicked)).toBe(true);
        const [started] = receiptOf(clicked).effects?.downloads ?? [];
        expect(started?.fileName).toBe('browser-lab-large.bin');
        const cancelled = await run({
          type: 'browser.cancel_transfer',
          transferId: started.id,
        });
        expect(payloadOf(cancelled)).toMatchObject({
          ok: true,
          transfer: { status: 'cancelled' },
        });
        expect(filesIn(downloadsDir)).toEqual([]);
        const partial = path.join(
          downloadsDir,
          'browser-lab-large.bin.download',
        );
        writeFileSync(partial, 'Kept by the user\n');
        // The next download's admission drains the store.
        const next = await run({
          type: 'browser.click',
          locator: selector('browser-lab-downloads-attachment'),
        });
        expect(receiptOf(next).effects?.downloads?.[0]?.status).toBe(
          'complete',
        );
        expect(readFileSync(partial, 'utf8')).toBe('Kept by the user\n');
      },
      { routes: ['advisor'] },
    );
  });

  test('a large download reports progress, a timed-out wait returns that progress, and cancel_transfer and the Files panel cancel without a partial file, through both routes', async () => {
    test.setTimeout(240_000);
    await withBrowser(
      origin,
      'downloads',
      async ({
        kind,
        run,
        browserId,
        electronApp,
        window,
        url,
        userDataDir,
      }) => {
        const downloadsDir = taskDownloadsDir(userDataDir);

        // The agent starts it; a short timeout keeps the click from waiting
        // for the whole download.
        const clicked = await run({
          type: 'browser.click',
          locator: selector('browser-lab-downloads-large'),
          timeoutMs: 2_000,
        });
        expect(clicked.ok, JSON.stringify(clicked)).toBe(true);
        expectAgentPayloadPathFree(clicked, 'large click', userDataDir);
        const receipt = receiptOf(clicked);
        expect(receipt.effects?.downloads).toHaveLength(1);
        const [started] = receipt.effects.downloads;
        expect(started).toMatchObject({
          source: 'agent',
          actionId: receipt.actionId,
          fileName: 'browser-lab-large.bin',
          totalBytes: LARGE_BYTES,
        });

        // Progress grows through list_transfers, with the total known.
        const first = await pollTransfers(run, (transfers) =>
          transfers.find(
            (transfer) =>
              transfer.id === started.id &&
              transfer.status === 'in_progress' &&
              transfer.receivedBytes > 0,
          ),
        );
        expect(first.totalBytes).toBe(LARGE_BYTES);
        const later = await pollTransfers(run, (transfers) =>
          transfers.find(
            (transfer) =>
              transfer.id === started.id &&
              transfer.receivedBytes > first.receivedBytes,
          ),
        );
        expect(later.receivedBytes).toBeLessThan(LARGE_BYTES);
        expect(later.status).toBe('in_progress');

        // A wait that times out is unsatisfied and reports the progress.
        const timedOut = await waitForDownload(
          run,
          { downloadId: started.id },
          300,
        );
        expect(timedOut.ok, JSON.stringify(timedOut)).toBe(true);
        expectAgentPayloadPathFree(timedOut, 'timed-out wait', userDataDir);
        expect(receiptOf(timedOut)).toMatchObject({
          kind: 'wait_for',
          status: 'executed',
        });
        const timedOutWait = waitForOf(timedOut, kind);
        expect(timedOutWait.satisfied).toBe(false);
        expect(timedOutWait.observed.download).toMatchObject({
          id: started.id,
          status: 'in_progress',
          totalBytes: LARGE_BYTES,
        });
        expect(timedOutWait.observed.download.receivedBytes).toBeGreaterThan(0);
        expect(filesIn(downloadsDir)).toEqual([
          'browser-lab-large.bin.download',
        ]);

        // The agent cancels it: the record is cancelled and no partial file
        // is left.
        const cancelled = await run({
          type: 'browser.cancel_transfer',
          transferId: started.id,
        });
        expect(cancelled.ok, JSON.stringify(cancelled)).toBe(true);
        expectAgentPayloadPathFree(cancelled, 'cancel_transfer', userDataDir);
        expect(payloadOf(cancelled)).toMatchObject({
          browserId,
          ok: true,
          transfer: { id: started.id, status: 'cancelled' },
        });
        expect(filesIn(downloadsDir)).toEqual([]);
        // A final download satisfies a named wait; its status says how.
        const settled = await waitForDownload(
          run,
          { downloadId: started.id },
          2_000,
        );
        expect(waitForOf(settled, kind)).toMatchObject({
          satisfied: true,
          observed: { download: { id: started.id, status: 'cancelled' } },
        });
        // Cancelling a finished download is idempotent.
        const again = await run({
          type: 'browser.cancel_transfer',
          transferId: started.id,
        });
        expect(payloadOf(again)).toMatchObject({
          ok: true,
          transfer: { id: started.id, status: 'cancelled' },
        });

        // A plain page click is the user's download; the Files panel
        // cancels it.
        await clickInLab(electronApp, url, 'browser-lab-downloads-large');
        const userDownload = await pollTransfers(run, (transfers) =>
          transfers.find(
            (transfer) =>
              transfer.id !== started.id &&
              transfer.status === 'in_progress' &&
              transfer.receivedBytes > 0,
          ),
        );
        expect(userDownload.source).toBe('user');
        expect(userDownload).not.toHaveProperty('actionId');
        expect(userDownload.fileName).toBe('browser-lab-large (1).bin');
        expect(filesIn(downloadsDir)).toEqual([
          'browser-lab-large (1).bin.download',
        ]);
        const { pane } = await openFilesPanel(window, browserId);
        const row = pane.getByTestId(`browser-transfer-row-${userDownload.id}`);
        await expect(row).toBeVisible();
        await pane
          .getByTestId(`browser-transfer-cancel-${userDownload.id}`)
          .click();
        await expect(row).toHaveAttribute(
          'aria-label',
          'browser-lab-large (1).bin, Cancelled',
        );
        await expect(
          pane.getByTestId(`browser-transfer-cancel-${userDownload.id}`),
        ).toHaveCount(0);
        const final = await pollTransfers(run, (transfers) =>
          transfers.find(
            (transfer) =>
              transfer.id === userDownload.id &&
              transfer.status === 'cancelled',
          ),
        );
        expect(final.receivedBytes).toBeLessThan(LARGE_BYTES);
        expect(filesIn(downloadsDir)).toEqual([]);
        const listed = await listTransfers(run);
        expectPathFree(listed, 'list_transfers', [userDataDir]);
        expect(listed.transfers.map((transfer) => transfer.status)).toEqual([
          'cancelled',
          'cancelled',
        ]);
      },
    );
  });

  test('an interrupted download keeps its partial file and resumes from the Files panel, through both routes', async () => {
    test.setTimeout(240_000);
    await withBrowser(
      origin,
      'downloads',
      async ({
        kind,
        run,
        browserId,
        electronApp,
        window,
        url,
        userDataDir,
      }) => {
        const downloadsDir = taskDownloadsDir(userDataDir);
        const hold = randomUUID();
        await downloadInLab(
          electronApp,
          url,
          `/browser-lab/download/resumable?hold=${hold}`,
        );
        // The connection drops part way, and the lab refuses automatic
        // retries, so the download waits for the user.
        const interrupted = await pollTransfers(run, (transfers) =>
          transfers.find(
            (transfer) =>
              transfer.fileName === 'browser-lab-resumable.bin' &&
              transfer.status === 'interrupted' &&
              transfer.canResume === true,
          ),
        );
        expect(interrupted).toMatchObject({
          source: 'user',
          receivedBytes: RESUMABLE_INTERRUPT_BYTES,
          totalBytes: RESUMABLE_BYTES,
        });
        expect(interrupted).not.toHaveProperty('error');
        // A resumable interruption keeps its partial file.
        expect(filesIn(downloadsDir)).toEqual([
          'browser-lab-resumable.bin.download',
        ]);
        expect(
          statSync(
            path.join(downloadsDir, 'browser-lab-resumable.bin.download'),
          ).size,
        ).toBe(RESUMABLE_INTERRUPT_BYTES);

        const { pane } = await openFilesPanel(window, browserId);
        const row = pane.getByTestId(`browser-transfer-row-${interrupted.id}`);
        await expect(row).toHaveAttribute(
          'aria-label',
          'browser-lab-resumable.bin, Interrupted',
        );
        const resume = pane.getByTestId(
          `browser-transfer-resume-${interrupted.id}`,
        );
        await expect(resume).toBeVisible();

        // A named wait is still open while the download can resume.
        const pending = waitForDownload(
          run,
          { downloadId: interrupted.id },
          15_000,
        );
        await releaseHold(hold);
        await resume.click();
        const waited = await pending;
        expect(waited.ok, JSON.stringify(waited)).toBe(true);
        expectAgentPayloadPathFree(waited, 'resumed wait', userDataDir);
        expect(waitForOf(waited, kind)).toMatchObject({
          satisfied: true,
          observed: {
            download: {
              id: interrupted.id,
              status: 'complete',
              receivedBytes: RESUMABLE_BYTES,
              totalBytes: RESUMABLE_BYTES,
            },
          },
        });
        await expect(row).toHaveAttribute(
          'aria-label',
          'browser-lab-resumable.bin, Downloaded',
        );
        await expect(resume).toHaveCount(0);
        // The resumed bytes continue the partial file where it stopped.
        expect(filesIn(downloadsDir)).toEqual(['browser-lab-resumable.bin']);
        expect(
          readFileSync(path.join(downloadsDir, 'browser-lab-resumable.bin')),
        ).toEqual(syntheticBytes(RESUMABLE_SEED, RESUMABLE_BYTES));
      },
    );
  });

  test('list_transfers filters and pages newest first, and wait_for catches the next download with a path-free origin, through both routes', async () => {
    test.setTimeout(240_000);
    await withBrowser(
      origin,
      'downloads',
      async ({ kind, run, browserId, electronApp, url, userDataDir }) => {
        // Waiting for the next download, before the page starts one. The
        // download URL carries a query and a fragment the agent must not see.
        const pending = waitForDownload(run, {}, 15_000);
        await downloadInLabLater(
          electronApp,
          url,
          '/browser-lab/download/attachment?secret=query-value#secret-fragment',
          800,
        );
        const next = await pending;
        expect(next.ok, JSON.stringify(next)).toBe(true);
        expectPathFree(payloadOf(next), 'next-download wait', [
          userDataDir,
          'query-value',
          'secret-fragment',
          'secret=',
        ]);
        const nextWait = waitForOf(next, kind);
        expect(nextWait.satisfied).toBe(true);
        expect(nextWait.observed.download).toMatchObject({
          browserId,
          source: 'user',
          origin: `${origin}/browser-lab/download/attachment`,
          fileName: 'browser-lab-report.txt',
          status: 'complete',
        });
        expect(nextWait.observed.download).not.toHaveProperty('actionId');

        // Nothing else starts: the next-download wait times out empty.
        const empty = await waitForDownload(run, {}, 300);
        expect(empty.ok, JSON.stringify(empty)).toBe(true);
        const emptyWait = waitForOf(empty, kind);
        expect(emptyWait.satisfied).toBe(false);
        expect(emptyWait.observed).toEqual({});

        // Three more complete downloads and one cancelled one.
        const agentClick = await run({
          type: 'browser.click',
          locator: selector('browser-lab-downloads-same-name-a'),
        });
        expect(agentClick.ok, JSON.stringify(agentClick)).toBe(true);
        for (const variant of ['executable', 'data-url']) {
          const previous = (await listTransfers(run)).total;
          await clickInLab(
            electronApp,
            url,
            `browser-lab-downloads-${variant}`,
          );
          await pollTransfers(run, (transfers, payload) =>
            payload.total === previous + 1 && transfers.every(isFinal)
              ? true
              : undefined,
          );
        }
        await clickInLab(electronApp, url, 'browser-lab-downloads-large');
        const large = await pollTransfers(run, (transfers) =>
          transfers.find(
            (transfer) =>
              transfer.fileName === 'browser-lab-large.bin' &&
              transfer.status === 'in_progress',
          ),
        );
        const cancelled = await run({
          type: 'browser.cancel_transfer',
          transferId: large.id,
        });
        expect(payloadOf(cancelled)).toMatchObject({
          ok: true,
          transfer: { status: 'cancelled' },
        });

        const all = await listTransfers(run, { limit: 100 });
        expectPathFree(all, 'list_transfers', [
          userDataDir,
          'query-value',
          'secret-fragment',
        ]);
        expect(all).toMatchObject({
          browserId,
          total: 5,
          offset: 0,
          limit: 100,
        });
        const startedAt = all.transfers.map((transfer) => transfer.startedAt);
        expect(startedAt).toEqual([...startedAt].sort((a, b) => b - a));
        expect(all.transfers.map((transfer) => transfer.fileName)).toEqual([
          'browser-lab-large.bin',
          'browser-lab-data-url.txt',
          'browser-lab-setup.exe',
          'browser-lab-duplicate.txt',
          'browser-lab-report.txt',
        ]);
        const ids = all.transfers.map((transfer) => transfer.id);

        const pages = [
          [{ limit: 2 }, ids.slice(0, 2), 0, 2],
          [{ offset: 2, limit: 2 }, ids.slice(2, 4), 2, 2],
          [{ offset: 4, limit: 2 }, ids.slice(4), 4, 2],
          [{ offset: 10 }, [], 10, 25],
        ];
        for (const [request, expected, offset, limit] of pages) {
          const page = await listTransfers(run, request);
          expect(page.total, JSON.stringify(request)).toBe(5);
          expect(page.offset).toBe(offset);
          expect(page.limit).toBe(limit);
          expect(page.transfers.map((transfer) => transfer.id)).toEqual(
            expected,
          );
        }

        const filters = [
          [{ status: 'complete' }, ids.slice(1)],
          [{ status: 'cancelled' }, [large.id]],
          [{ status: 'in_progress' }, []],
          [{ kind: 'download', status: 'cancelled' }, [large.id]],
        ];
        for (const [request, expected] of filters) {
          const filtered = await listTransfers(run, request);
          expect(
            filtered.transfers.map((transfer) => transfer.id),
            JSON.stringify(request),
          ).toEqual(expected);
          expect(filtered.total).toBe(expected.length);
        }
      },
    );
  });

  test('the hostile download loop is held to three at once and twenty a minute, its notice is coalesced, and Allow more downloads resets only the minute, through both routes', async () => {
    test.setTimeout(300_000);
    await withBrowser(
      origin,
      'hostile-transfers',
      async ({ run, browserId, electronApp, window, url, userDataDir }) => {
        await window.evaluate((id) => {
          window.__browserFilesBlocked = [];
          window.api.browser.onEvent((event) => {
            if (event.type === 'download-blocked' && event.browserId === id)
              window.__browserFilesBlocked.push(Date.now());
          });
        }, browserId);
        const blockedEvents = () =>
          window.evaluate(() => window.__browserFilesBlocked.length);
        let mostActive = 0;
        const snapshot = async () => {
          const listed = await listTransfers(run, { limit: 100 });
          const active = listed.transfers.filter(
            (transfer) => !isFinal(transfer),
          ).length;
          mostActive = Math.max(mostActive, active);
          return listed;
        };
        const settledTotal = async (total) => {
          let last;
          await expect
            .poll(
              async () => {
                const listed = await snapshot();
                last = listed.transfers.map(
                  (transfer) =>
                    `${transfer.fileName}:${transfer.status}:${transfer.canResume}:${transfer.receivedBytes}`,
                );
                return (
                  listed.total === total &&
                  listed.transfers.every(
                    (transfer) =>
                      transfer.status === 'complete' ||
                      transfer.status === 'cancelled' ||
                      transfer.canResume === true,
                  )
                );
              },
              { timeout: 30_000 },
            )
            .toBe(true)
            .catch((error) => {
              throw new Error(
                `Downloads did not settle at ${total}: ${JSON.stringify(last)}`,
                { cause: error },
              );
            });
        };
        const pane = window.getByTestId(`browser-pane-${browserId}`);
        const notice = pane.getByText('Downloads blocked');
        const allowMore = pane.getByTestId('browser-files-allow-more');

        // Twenty downloads, one at a time, fill the minute.
        for (let index = 1; index <= 20; index += 1) {
          await downloadInLab(
            electronApp,
            url,
            `/browser-lab/download/loop?n=${index}`,
          );
          await settledTotal(index);
        }
        expect(await blockedEvents()).toBe(0);
        await expect(notice).toHaveCount(0);

        // The page's loop asks for twenty more: every one is refused, and the
        // user sees one notice.
        await clickInLab(
          electronApp,
          url,
          'browser-lab-hostile-transfers-download-loop-button',
        );
        await expect
          .poll(() =>
            readLab(
              electronApp,
              url,
              'browser-lab-hostile-transfers-download-loop-status',
              'data-browser-lab-download-requests',
            ),
          )
          .toBe('20');
        await expect
          .poll(
            async () => {
              const network = payloadOf(
                await run({ type: 'browser.get_network', limit: 200 }),
              );
              return network.entries.filter((entry) =>
                entry.url.includes('/browser-lab/download/loop?n='),
              ).length;
            },
            { timeout: 30_000 },
          )
          .toBe(40);
        await expect(notice).toBeVisible();
        await expect(allowMore).toHaveCount(1);
        // Twenty refusals, one notice, announced at most once a second.
        await new Promise((resolve) => setTimeout(resolve, 1_500));
        const announcedAt = await window.evaluate(
          () => window.__browserFilesBlocked,
        );
        expect(announcedAt.length).toBeGreaterThanOrEqual(1);
        expect(announcedAt.length).toBeLessThan(20);
        for (let index = 1; index < announcedAt.length; index += 1)
          expect(
            announcedAt[index] - announcedAt[index - 1],
            JSON.stringify(announcedAt),
          ).toBeGreaterThanOrEqual(900);
        const afterLoop = await snapshot();
        expect(afterLoop.total).toBe(20);
        expect(filesIn(taskDownloadsDir(userDataDir))).toHaveLength(20);

        // A dismissed notice comes back with the next block.
        await pane
          .getByRole('button', { name: 'Dismiss blocked downloads notice' })
          .click();
        await expect(notice).toHaveCount(0);
        await downloadInLab(electronApp, url, '/browser-lab/download/loop?n=5');
        await expect(notice).toBeVisible();
        expect((await snapshot()).total).toBe(20);

        // Allow more downloads resets the minute: the next one is saved.
        await allowMore.click();
        await expect(notice).toHaveCount(0);
        await downloadInLab(electronApp, url, '/browser-lab/download/loop?n=1');
        await settledTotal(21);

        // Three downloads that wait for the user hold every active slot.
        const hold = randomUUID();
        for (let index = 0; index < 3; index += 1) {
          await downloadInLab(
            electronApp,
            url,
            `/browser-lab/download/resumable?hold=${hold}`,
          );
          await settledTotal(22 + index);
        }
        const held = (await snapshot()).transfers.filter(
          (transfer) => transfer.canResume === true,
        );
        expect(held).toHaveLength(3);

        // A fourth is refused, and Allow more downloads does not lift the
        // active limit.
        for (const attempt of [2, 3]) {
          const announced = await blockedEvents();
          await downloadInLab(
            electronApp,
            url,
            `/browser-lab/download/loop?n=${attempt}`,
          );
          await expect.poll(blockedEvents).toBe(announced + 1);
          await expect(notice).toBeVisible();
          expect((await snapshot()).total).toBe(24);
          await allowMore.click();
          await expect(notice).toHaveCount(0);
        }

        // Ending one of them frees a slot.
        const cancelled = await run({
          type: 'browser.cancel_transfer',
          transferId: held[0].id,
        });
        expect(payloadOf(cancelled)).toMatchObject({
          ok: true,
          transfer: { id: held[0].id, status: 'cancelled' },
        });
        await downloadInLab(electronApp, url, '/browser-lab/download/loop?n=4');
        await settledTotal(25);
        const last = (await snapshot()).transfers[0];
        expect(last).toMatchObject({
          fileName: 'browser-lab-loop-4 (1).txt',
          status: 'complete',
        });
        expect(mostActive).toBeLessThan(4);
        expect(mostActive).toBe(3);
      },
    );
  });

  test('a download in progress when the app crashes is interrupted after relaunch, without its partial files, through both routes', async () => {
    test.setTimeout(240_000);
    await expectInterruptedAfterRelaunch('crash');
  });

  test('a download in progress when the app quits is interrupted after relaunch, without its partial files, through both routes', async () => {
    test.setTimeout(240_000);
    await expectInterruptedAfterRelaunch('quit');
  });

  test('deleting the task cancels its running downloads, then removes its browser files', async () => {
    test.setTimeout(240_000);
    const { userDataDir, workspace, otherId } = seedArchiveActivityFixture();
    const owner = { projectId: workspace.id, worktreeId: otherId };
    const filesDir = taskFilesDir(userDataDir, owner);
    const downloadsDir = taskDownloadsDir(userDataDir, owner);
    const { electronApp } = await launchCanopy({ userDataDir });
    try {
      const window = await getMainWindow(electronApp);
      const app = new CanopyAppDriver(window);
      await app.waitForShell({ timeout: 30_000 });
      await app.openMainPage();
      await app.selectWorktree(otherId);
      await expect(chatPanelLocator(window)).toBeVisible();

      const url = `${origin}/browser-lab/downloads#delete-${randomUUID()}`;
      const browser = await window.evaluate(
        (request) => window.api.browser.create(request),
        { ...owner, url },
      );
      await expect
        .poll(
          () =>
            readLab(
              electronApp,
              url,
              'browser-lab-downloads-main',
              'data-testid',
            ).catch(() => null),
          { timeout: 30_000 },
        )
        .toBe('browser-lab-downloads-main');
      const list = () =>
        window.evaluate(
          (browserId) =>
            window.api.browser.listTransfers({ browserId, limit: 100 }),
          browser.id,
        );

      // One finished file, one download that waits for the user, and one
      // still streaming.
      await clickInLab(electronApp, url, 'browser-lab-downloads-attachment');
      await downloadInLab(
        electronApp,
        url,
        `/browser-lab/download/resumable?hold=${randomUUID()}`,
      );
      await downloadInLab(
        electronApp,
        url,
        `/browser-lab/download/resumable?hold=${randomUUID()}&stall=1`,
      );
      let running = [];
      await expect
        .poll(
          async () => {
            const { transfers } = await list();
            running = transfers.filter((transfer) => !isFinal(transfer));
            return transfers
              .map(
                (transfer) =>
                  `${transfer.fileName}:${transfer.status}:${transfer.receivedBytes > 0}`,
              )
              .sort();
          },
          { timeout: 30_000 },
        )
        .toEqual([
          'browser-lab-report.txt:complete:true',
          'browser-lab-resumable.bin:interrupted:true',
          'browser-lab-stalled.bin:in_progress:true',
        ]);
      expect(filesIn(downloadsDir)).toEqual([
        'browser-lab-report.txt',
        'browser-lab-resumable.bin.download',
        'browser-lab-stalled.bin.download',
      ]);
      const activeIds = async () =>
        (
          await electronApp.evaluate(() =>
            globalThis.__CANOPY_E2E_BROWSER_DOWNLOADS__(),
          )
        )
          .filter((download) => download.worktreeId === otherId)
          .map((download) => download.downloadId)
          .sort();
      expect(await activeIds()).toEqual(
        running.map((transfer) => transfer.id).sort(),
      );

      // Record, as each cancellation is announced, whether the task folder
      // still exists.
      await electronApp.evaluate(({ BrowserWindow }, folder) => {
        const { existsSync: exists } = process.getBuiltinModule('node:fs');
        globalThis.__browserFilesDeletion = [];
        for (const candidate of BrowserWindow.getAllWindows()) {
          const contents = candidate.webContents;
          const send = contents.send.bind(contents);
          contents.send = (channel, ...args) => {
            const event = args[0];
            if (channel === 'browser:event' && event?.type === 'transfer')
              globalThis.__browserFilesDeletion.push({
                id: event.transfer.id,
                status: event.transfer.status,
                folderExists: exists(folder),
              });
            return send(channel, ...args);
          };
        }
      }, filesDir);

      const row = window.locator(
        `[data-testid="worktree-row"][data-worktree-id="${otherId}"][data-project-id="${workspace.id}"]`,
      );
      await requestWorktreeDeletion(window, row);
      await expect(row).toHaveCount(0, { timeout: 60_000 });
      await expect.poll(() => existsSync(filesDir)).toBe(false);
      expect(await activeIds()).toEqual([]);
      const announced = await electronApp.evaluate(
        () => globalThis.__browserFilesDeletion,
      );
      for (const transfer of running) {
        const cancellation = announced.find(
          (event) => event.id === transfer.id && event.status === 'cancelled',
        );
        expect(cancellation, JSON.stringify(announced)).toEqual({
          id: transfer.id,
          status: 'cancelled',
          folderExists: true,
        });
      }
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });
});

/** A copy keeps the download's marking: on macOS, its quarantine attribute. */
function expectMarkedAsDownloaded(file) {
  if (process.platform !== 'darwin') return;
  expect(
    execFileSync('/usr/bin/xattr', ['-p', 'com.apple.quarantine', file], {
      encoding: 'utf8',
    }),
    file,
  ).toMatch(/^0081;/);
}

const REPORT_NAME = 'browser-lab-report.txt';
const REPORT_BODY = 'Browser Lab attachment report\n';

/** The agent downloads the lab's attachment link; it is small, so it has finished. */
async function finishedReport(run) {
  const clicked = await run({
    type: 'browser.click',
    locator: selector('browser-lab-downloads-attachment'),
  });
  expect(clicked.ok, JSON.stringify(clicked)).toBe(true);
  const [started] = receiptOf(clicked).effects.downloads;
  expect(started).toMatchObject({ fileName: REPORT_NAME, status: 'complete' });
  return started;
}

test.describe('phase 07b: Save a copy, Attach to chat, and save_download', () => {
  test('save_download asks the calling chat in Ask: Deny saves nothing, Allow saves the file, and a taken name or an escaping path is refused without asking, through the MCP routes', async () => {
    test.setTimeout(240_000);
    await withBrowser(
      origin,
      'downloads',
      async ({ kind, run, electronApp, window, userDataDir }) => {
        const report = await finishedReport(run);
        const session = await startApprovalSession(
          electronApp,
          chatForRoute(kind),
          'ask',
        );
        const relativePath = `exports/${REPORT_NAME}`;
        const target = path.join(session.workspaceRoot, 'exports', REPORT_NAME);
        const save = (extra = {}) =>
          run({
            type: 'browser.save_download',
            downloadId: report.id,
            path: relativePath,
            ...extra,
          });
        const card = chatPanelLocator(window).getByTestId('tool-approval-card');
        try {
          const denied = save();
          await expect(card).toBeVisible({ timeout: 15_000 });
          await expect(card).toContainText(
            `Save ${REPORT_NAME} to ${relativePath}?`,
          );
          await card.getByTestId('tool-approval-deny').click();
          expect(payloadOf(await denied)).toMatchObject({
            ok: false,
            error: { code: 'approval_denied' },
          });
          expect(existsSync(target), kind).toBe(false);

          const allowed = save();
          await expect(card).toBeVisible({ timeout: 15_000 });
          await card.getByTestId('tool-approval-allow').click();
          const saved = payloadOf(await allowed);
          expect(saved, JSON.stringify(saved)).toMatchObject({
            ok: true,
            transfer: {
              kind: 'copy',
              sourceId: report.id,
              source: 'agent',
              destinationName: relativePath,
              status: 'complete',
              copiedBytes: Buffer.byteLength(REPORT_BODY, 'utf8'),
            },
          });
          expectPathFree(saved, `${kind} save`, [
            userDataDir,
            session.workspaceRoot,
          ]);
          expect(readFileSync(target, 'utf8')).toBe(REPORT_BODY);
          expect(
            filesIn(path.dirname(target)).filter((name) =>
              name.endsWith('.part'),
            ),
          ).toEqual([]);

          // A name that is taken is refused before anyone is asked.
          writeFileSync(target, 'Kept by the user\n');
          expect(payloadOf(await save())).toMatchObject({
            ok: false,
            error: { code: 'destination_exists' },
          });
          await expect(card).toHaveCount(0);
          expect(readFileSync(target, 'utf8')).toBe('Kept by the user\n');
          // Replacing it asks again.
          const replacing = save({ overwrite: true });
          await expect(card).toBeVisible({ timeout: 15_000 });
          await card.getByTestId('tool-approval-allow').click();
          expect(payloadOf(await replacing)).toMatchObject({ ok: true });
          expect(readFileSync(target, 'utf8')).toBe(REPORT_BODY);

          // A path that leaves the workspace is refused without asking.
          expect(
            payloadOf(await save({ path: `../${REPORT_NAME}` })),
          ).toMatchObject({ ok: false, error: { code: 'invalid_path' } });
          await expect(card).toHaveCount(0);
          expect(
            existsSync(
              path.join(path.dirname(session.workspaceRoot), REPORT_NAME),
            ),
          ).toBe(false);

          // Each saved copy is a transfer of its own.
          const copies = await listTransfers(run, { kind: 'copy' });
          expectPathFree(copies, `${kind} copies`, [session.workspaceRoot]);
          expect(copies.transfers.map((copy) => copy.status)).toEqual([
            'complete',
            'complete',
          ]);
        } finally {
          await endApprovalSession(electronApp, session.id);
        }
      },
      { routes: ['mcp', WORKTREE_ROUTE] },
    );
  });

  test('save_download saves without a prompt in Auto and Full Access, and is denied when the chat has no approval session, through every route', async () => {
    test.setTimeout(300_000);
    await withBrowser(
      origin,
      'downloads',
      async ({ kind, run, electronApp, window, userDataDir }) => {
        const report = await finishedReport(run);
        const card = chatPanelLocator(window).getByTestId('tool-approval-card');
        // No session for the chat: there is no one to ask, so it is denied.
        expect(
          payloadOf(
            await run({
              type: 'browser.save_download',
              downloadId: report.id,
              path: `${kind}-none/${REPORT_NAME}`,
            }),
          ),
        ).toMatchObject({ ok: false, error: { code: 'approval_denied' } });
        for (const mode of ['auto', 'full-access']) {
          const session = await startApprovalSession(
            electronApp,
            chatForRoute(kind),
            mode,
          );
          try {
            const relativePath = `${kind}-${mode}/${REPORT_NAME}`;
            const saved = payloadOf(
              await run({
                type: 'browser.save_download',
                downloadId: report.id,
                path: relativePath,
              }),
            );
            expect(
              saved,
              `${kind} ${mode}: ${JSON.stringify(saved)}`,
            ).toMatchObject({
              ok: true,
              transfer: { kind: 'copy', status: 'complete' },
            });
            expectPathFree(saved, `${kind} ${mode}`, [
              userDataDir,
              session.workspaceRoot,
            ]);
            const savedFile = path.join(
              session.workspaceRoot,
              `${kind}-${mode}`,
              REPORT_NAME,
            );
            expect(readFileSync(savedFile, 'utf8')).toBe(REPORT_BODY);
            expectMarkedAsDownloaded(savedFile);
            await expect(card).toHaveCount(0);
            if (mode === 'auto') {
              const workspaceRoot = session.workspaceRoot;
              expect(existsSync(path.join(workspaceRoot, `${kind}-none`))).toBe(
                false,
              );
            }
          } finally {
            await endApprovalSession(electronApp, session.id);
          }
        }
      },
      { routes: [...ROUTES, WORKTREE_ROUTE, ADVISOR_ENTRY_ROUTE] },
    );
  });

  test('Save a copy writes where the user chooses and Attach to chat stages the file on the chat draft, from the Files panel', async () => {
    test.setTimeout(180_000);
    await withBrowser(
      origin,
      'downloads',
      async ({ run, browserId, electronApp, window, userDataDir }) => {
        const report = await finishedReport(run);
        const chosen = path.join(userDataDir, 'chosen', 'report-copy.txt');
        mkdirSync(path.dirname(chosen), { recursive: true });
        await electronApp.evaluate(({ dialog }, target) => {
          const answers = [
            { canceled: true },
            { canceled: false, filePath: target },
          ];
          const calls = [];
          globalThis.__browserFilesSaveCopyDialog = calls;
          dialog.showSaveDialog = async (...args) => {
            calls.push(args.at(-1)?.defaultPath ?? null);
            return answers.shift() ?? { canceled: true };
          };
        }, chosen);
        const { pane } = await openFilesPanel(window, browserId);
        const saveCopy = pane.getByTestId(
          `browser-transfer-save-copy-${report.id}`,
        );
        await expect(saveCopy).toHaveText('Save a copy…');
        // A dismissed dialog copies nothing and says nothing.
        await saveCopy.click();
        await expect
          .poll(() =>
            electronApp.evaluate(
              () => globalThis.__browserFilesSaveCopyDialog.length,
            ),
          )
          .toBe(1);
        await expect(pane.locator('[role="alert"]')).toHaveCount(0);
        expect((await listTransfers(run, { kind: 'copy' })).total).toBe(0);
        // A chosen path gets the copy, shown as its own row.
        await saveCopy.click();
        const copy = await pollTransfers(run, (transfers) =>
          transfers.find(
            (transfer) =>
              transfer.kind === 'copy' && transfer.status === 'complete',
          ),
        );
        expect(copy).toMatchObject({
          source: 'user',
          sourceId: report.id,
          destinationName: 'report-copy.txt',
        });
        expect(readFileSync(chosen, 'utf8')).toBe(REPORT_BODY);
        expectMarkedAsDownloaded(chosen);
        await expect(
          pane.getByTestId(`browser-transfer-row-${copy.id}`),
        ).toContainText('Copied');
        // The dialog opened in Downloads with the file's name.
        expect(
          await electronApp.evaluate(
            () => globalThis.__browserFilesSaveCopyDialog,
          ),
        ).toEqual([
          expect.stringMatching(/report\.txt$/),
          expect.stringMatching(/report\.txt$/),
        ]);

        await pane.getByTestId(`browser-transfer-attach-${report.id}`).click();
        await expect(
          chatPanelLocator(window)
            .getByTestId('attachment-pill')
            .filter({ hasText: REPORT_NAME }),
        ).toHaveCount(1, { timeout: 15_000 });
      },
      { routes: ['advisor'] },
    );
  });
});

const UPLOAD_BODY = 'Browser Lab upload body\n';

function sha256Hex(text) {
  return createHash('sha256').update(text).digest('hex');
}

/** What the lab page's upload-echo returned to a result element. */
async function echoed(electronApp, url, testId) {
  const state = await readLab(
    electronApp,
    url,
    testId,
    'data-browser-lab-state',
  );
  const text = await inLab(
    electronApp,
    url,
    `document.querySelector(${JSON.stringify(selector(testId))})?.textContent ?? ''`,
  );
  return { state, text };
}

/** The same, inside the paired cross-site frame. */
async function echoedInFrame(
  electronApp,
  url,
  testId,
  framePath = '/browser-lab/upload/frame',
) {
  return electronApp.evaluate(
    async ({ webContents }, input) => {
      const view = webContents
        .getAllWebContents()
        .find((contents) => contents.getURL() === input.url);
      const frame = view?.mainFrame.framesInSubtree.find((candidate) => {
        try {
          return new URL(candidate.url).pathname === input.framePath;
        } catch {
          return false;
        }
      });
      if (!frame) throw new Error('Upload frame missing');
      return frame.executeJavaScript(
        `(() => { const output = document.querySelector('[data-testid="${input.testId}"]'); return { state: output?.dataset.browserLabState, text: output?.textContent ?? '' }; })()`,
      );
    },
    { url, testId, framePath },
  );
}

/** Waits for the approval card, or fails with the action's response if it ends first. */
async function cardFor(card, pending) {
  let settled;
  const ended = pending.then((response) => {
    settled = response;
  });
  await Promise.race([
    card.waitFor({ state: 'visible', timeout: 15_000 }),
    ended,
  ]);
  if (settled) throw new Error(`No approval card: ${JSON.stringify(settled)}`);
}

/** Writes a workspace file and returns its workspace-relative path. */
function workspaceFile(root, relativePath, body = UPLOAD_BODY) {
  const file = path.join(root, relativePath);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, body);
  return relativePath;
}

test.describe('phase 08a: upload_files with approval', () => {
  test('upload_files asks the calling chat in Ask: ineligible files never prompt, Deny attaches nothing, and Allow sends exactly the staged bytes, through the chat routes', async () => {
    test.setTimeout(300_000);
    await withBrowser(
      origin,
      'upload',
      async ({ kind, run, electronApp, window, userDataDir, url }) => {
        const session = await startApprovalSession(
          electronApp,
          chatForRoute(kind),
          'ask',
        );
        const root = session.workspaceRoot;
        const card = chatPanelLocator(window).getByTestId('tool-approval-card');
        const upload = (
          files,
          target = 'browser-lab-upload-single-input',
          extra = {},
        ) =>
          run({
            type: 'browser.upload_files',
            locator: selector(target),
            files,
            ...extra,
          });
        try {
          const report = workspaceFile(root, 'exports/upload.txt');
          // Ineligible files are refused before anything is asked.
          const outside = path.join(path.dirname(root), 'upload-outside.txt');
          writeFileSync(outside, 'outside the workspace');
          symlinkSync(outside, path.join(root, 'outside-link.txt'));
          workspaceFile(root, 'nested/.git/config', '[core]\n');
          for (const files of [
            [{ path: '../upload-outside.txt' }],
            [{ path: outside }],
            [{ path: 'outside-link.txt' }],
            [{ path: 'nested/.git/config' }],
            [{ path: report }, { path: 'missing.txt' }],
          ]) {
            const refused = receiptOf(
              await upload(files, 'browser-lab-upload-multiple-input'),
            );
            expect(refused, JSON.stringify(files)).toMatchObject({
              status: 'not_executed',
              error: { code: 'file_not_eligible' },
            });
            await expect(card).toHaveCount(0);
          }
          // Several files for an input that takes one.
          expect(
            receiptOf(await upload([{ path: report }, { path: report }])),
          ).toMatchObject({
            status: 'not_executed',
            error: { code: 'unsupported_control' },
          });

          const denied = upload([{ path: report }]);
          await expect(card).toBeVisible({ timeout: 15_000 });
          await expect(card).toContainText(
            `Upload upload.txt to ${new URL(origin).host}?`,
          );
          await expect(card).toContainText(report);
          await expect(card).toContainText(`To ${origin}`);
          await card.getByTestId('tool-approval-deny').click();
          expect(receiptOf(await denied)).toMatchObject({
            status: 'not_executed',
            error: { code: 'approval_denied' },
          });
          expect(
            await echoed(electronApp, url, 'browser-lab-upload-single-result'),
          ).toMatchObject({ state: 'idle' });

          // The source changes after staging: the page gets the staged bytes.
          const allowed = upload([{ path: report }]);
          await expect(card).toBeVisible({ timeout: 15_000 });
          writeFileSync(path.join(root, report), 'Changed after staging\n');
          await card.getByTestId('tool-approval-allow').click();
          const attachedResponse = await allowed;
          const attached = receiptOf(attachedResponse);
          expect(attached, JSON.stringify(attachedResponse)).toMatchObject({
            status: 'executed',
            upload: {
              status: 'attached',
              files: [
                {
                  name: 'upload.txt',
                  displayPath: report,
                  sha256: sha256Hex(UPLOAD_BODY),
                },
              ],
            },
          });
          expectPathFree(payloadOf(attachedResponse), `${kind} upload`, [
            userDataDir,
            root,
          ]);
          await expect
            .poll(
              async () =>
                (
                  await echoed(
                    electronApp,
                    url,
                    'browser-lab-upload-single-result',
                  )
                ).state,
              { timeout: 15_000 },
            )
            .toBe('done');
          const received = JSON.parse(
            (await echoed(electronApp, url, 'browser-lab-upload-single-result'))
              .text,
          );
          expect(received.files).toEqual([
            {
              name: 'upload.txt',
              size: Buffer.byteLength(UPLOAD_BODY),
              sha256: sha256Hex(UPLOAD_BODY),
            },
          ]);

          // A staged copy changed before the attach: nothing is attached.
          const changing = upload(
            [{ path: report }],
            'browser-lab-upload-image-input',
          );
          await expect(card).toBeVisible({ timeout: 15_000 });
          const pending = (
            await listTransfers(run, { kind: 'upload' })
          ).transfers.find(
            (transfer) => transfer.status === 'awaiting_approval',
          );
          expect(pending).toBeTruthy();
          const staged = path.join(
            taskFilesDir(userDataDir),
            'uploads',
            pending.id,
            '0',
            'upload.txt',
          );
          chmodSync(path.dirname(staged), 0o700);
          chmodSync(staged, 0o600);
          writeFileSync(staged, 'Swapped staged bytes\n');
          await card.getByTestId('tool-approval-allow').click();
          expect(receiptOf(await changing)).toMatchObject({
            status: 'not_executed',
            error: { code: 'file_changed' },
          });
          expect(
            await echoed(electronApp, url, 'browser-lab-upload-image-result'),
          ).toMatchObject({ state: 'idle' });

          // Cancelled while the card is open: answering it attaches nothing.
          const cancelling = upload(
            [{ path: report }],
            'browser-lab-upload-multiple-input',
          );
          await expect(card).toBeVisible({ timeout: 15_000 });
          const waiting = (
            await listTransfers(run, { kind: 'upload' })
          ).transfers.find(
            (transfer) => transfer.status === 'awaiting_approval',
          );
          expect(
            payloadOf(
              await run({
                type: 'browser.cancel_transfer',
                transferId: waiting.id,
              }),
            ),
          ).toMatchObject({ ok: true });
          await card.getByTestId('tool-approval-allow').click();
          expect(receiptOf(await cancelling)).toMatchObject({
            status: 'not_executed',
            error: { code: 'cancelled' },
          });
          expect(
            await echoed(
              electronApp,
              url,
              'browser-lab-upload-multiple-result',
            ),
          ).toMatchObject({ state: 'idle' });
          const waitResponse = await run({
            type: 'browser.wait_for',
            upload: { uploadId: waiting.id },
          });
          const waited = waitForOf(waitResponse, kind);
          expect(waited, JSON.stringify(waitResponse)).toMatchObject({
            satisfied: true,
            observed: { upload: { status: 'cancelled' } },
          });

          // The Files panel lists each upload and how it ended.
          const { panel } = await openFilesPanel(
            window,
            attached.upload.browserId,
          );
          await expect(
            panel.getByTestId(`browser-transfer-row-${attached.upload.id}`),
          ).toContainText('Attached');
          await expect(
            panel.getByTestId(`browser-transfer-row-${waiting.id}`),
          ).toContainText('Cancelled');
        } finally {
          await endApprovalSession(electronApp, session.id);
        }
      },
      { routes: ['mcp', WORKTREE_ROUTE] },
    );
  });

  test('upload_files asks even in Full Access and Auto, and Allow for this chat answers the next upload to that site, through the chat routes', async () => {
    test.setTimeout(240_000);
    await withBrowser(
      origin,
      'upload',
      async ({ kind, run, electronApp, window, url }) => {
        for (const mode of ['full-access', 'auto']) {
          const session = await startApprovalSession(
            electronApp,
            chatForRoute(kind),
            mode,
          );
          const card =
            chatPanelLocator(window).getByTestId('tool-approval-card');
          try {
            const file = workspaceFile(session.workspaceRoot, `${mode}.txt`);
            const first = run({
              type: 'browser.upload_files',
              locator: selector('browser-lab-upload-single-input'),
              files: [{ path: file }],
            });
            await expect(card, mode).toBeVisible({ timeout: 15_000 });
            await card.getByLabel('More allow options').click();
            await window
              .getByRole('menuitem', { name: /Allow for this chat/ })
              .click();
            expect(receiptOf(await first)).toMatchObject({
              status: 'executed',
              upload: { status: 'attached' },
            });
            // The rule answers the next upload to this site.
            expect(
              receiptOf(
                await run({
                  type: 'browser.upload_files',
                  locator: selector('browser-lab-upload-multiple-input'),
                  files: [{ path: file }, { path: file }],
                }),
              ),
            ).toMatchObject({
              status: 'executed',
              upload: { status: 'attached' },
            });
            await expect(card).toHaveCount(0);
            await expect
              .poll(
                async () =>
                  (
                    await echoed(
                      electronApp,
                      url,
                      'browser-lab-upload-multiple-result',
                    )
                  ).state,
                { timeout: 15_000 },
              )
              .toBe('done');
          } finally {
            await endApprovalSession(electronApp, session.id);
          }
        }
      },
      { routes: ['mcp', WORKTREE_ROUTE] },
    );
  });

  test('upload_files names a cross-site frame on its card, finds a hidden input from its button, and attaches nothing once the page shows another site, through the chat routes', async () => {
    test.setTimeout(240_000);
    await withBrowser(
      origin,
      'upload',
      async ({ kind, run, electronApp, window, url }) => {
        const session = await startApprovalSession(
          electronApp,
          chatForRoute(kind),
          'ask',
        );
        const card = chatPanelLocator(window).getByTestId('tool-approval-card');
        const paired = lab.paired.origin;
        try {
          const file = workspaceFile(session.workspaceRoot, 'frame.txt');
          // The cross-site frame loads on its own; then, as an agent would,
          // the test reads the page before targeting the frame.
          await expect
            .poll(
              () =>
                echoedInFrame(
                  electronApp,
                  url,
                  'browser-lab-upload-frame-result',
                )
                  .then((result) => result.state)
                  .catch(() => null),
              { timeout: 30_000 },
            )
            .toBe('idle');
          // The frame sits below the fold; the page model includes it once
          // its iframe is in view.
          const scrolled = await run({
            type: 'browser.scroll',
            intoView: true,
            locator: selector('browser-lab-upload-cross-origin-frame'),
          });
          expect(scrolled.ok, JSON.stringify(scrolled)).toBe(true);
          const snapshot = await run({ type: 'browser.input_snapshot' });
          expect(snapshot.ok, JSON.stringify(snapshot)).toBe(true);
          const framed = run({
            type: 'browser.upload_files',
            locator: selector('browser-lab-upload-frame-input'),
            frame: selector('browser-lab-upload-cross-origin-frame'),
            files: [{ path: file }],
          });
          await cardFor(card, framed);
          await expect(card).toContainText(
            `Upload frame.txt to ${new URL(paired).host}?`,
          );
          await expect(card).toContainText(`To ${paired} on ${origin}`);
          await card.getByTestId('tool-approval-allow').click();
          expect(receiptOf(await framed)).toMatchObject({
            status: 'executed',
            upload: {
              status: 'attached',
              frameOrigin: paired,
              topOrigin: origin,
            },
          });
          await expect
            .poll(
              async () =>
                (
                  await echoedInFrame(
                    electronApp,
                    url,
                    'browser-lab-upload-frame-result',
                  )
                ).state,
              { timeout: 15_000 },
            )
            .toBe('done');

          // The button that opens a hidden input leads to that input.
          const hidden = run({
            type: 'browser.upload_files',
            locator: selector('browser-lab-upload-hidden-open'),
            files: [{ path: file }],
          });
          await expect(card).toBeVisible({ timeout: 15_000 });
          await card.getByTestId('tool-approval-allow').click();
          expect(receiptOf(await hidden)).toMatchObject({
            upload: { status: 'attached' },
          });
          await expect
            .poll(
              async () =>
                (
                  await echoed(
                    electronApp,
                    url,
                    'browser-lab-upload-hidden-result',
                  )
                ).state,
              { timeout: 15_000 },
            )
            .toBe('done');

          // The page moves to another site while the card is open.
          const moving = run({
            type: 'browser.upload_files',
            locator: selector('browser-lab-upload-single-input'),
            files: [{ path: file }],
          });
          await expect(card).toBeVisible({ timeout: 15_000 });
          const navigated = await run({
            type: 'browser.navigate',
            url: `${paired}/browser-lab/upload`,
          });
          expect(navigated.ok, JSON.stringify(navigated)).toBe(true);
          await card.getByTestId('tool-approval-allow').click();
          expect(receiptOf(await moving)).toMatchObject({
            status: 'not_executed',
            error: { code: 'origin_changed' },
          });
        } finally {
          await endApprovalSession(electronApp, session.id);
        }
      },
      { routes: ['mcp', WORKTREE_ROUTE] },
    );
  });

  test('upload_files sends a finished task download by its id, through the chat routes', async () => {
    test.setTimeout(240_000);
    await withBrowser(
      origin,
      'downloads',
      async ({ kind, run, electronApp, window }) => {
        const report = await finishedReport(run);
        const session = await startApprovalSession(
          electronApp,
          chatForRoute(kind),
          'ask',
        );
        const card = chatPanelLocator(window).getByTestId('tool-approval-card');
        try {
          const uploadUrl = `${origin}/browser-lab/upload#${kind}-${randomUUID()}`;
          const navigated = await run({
            type: 'browser.navigate',
            url: uploadUrl,
          });
          expect(navigated.ok, JSON.stringify(navigated)).toBe(true);
          await expect
            .poll(
              () =>
                readLab(
                  electronApp,
                  uploadUrl,
                  'browser-lab-upload-main',
                  'data-testid',
                ).catch(() => null),
              { timeout: 30_000 },
            )
            .toBe('browser-lab-upload-main');
          const sending = run({
            type: 'browser.upload_files',
            locator: selector('browser-lab-upload-single-input'),
            files: [{ downloadId: report.id }],
          });
          await expect(card).toBeVisible({ timeout: 15_000 });
          await expect(card).toContainText(`${REPORT_NAME} (downloaded)`);
          await card.getByTestId('tool-approval-allow').click();
          expect(receiptOf(await sending)).toMatchObject({
            upload: { status: 'attached' },
          });
          await expect
            .poll(
              async () =>
                (
                  await echoed(
                    electronApp,
                    uploadUrl,
                    'browser-lab-upload-single-result',
                  )
                ).state,
              { timeout: 15_000 },
            )
            .toBe('done');
          expect(
            JSON.parse(
              (
                await echoed(
                  electronApp,
                  uploadUrl,
                  'browser-lab-upload-single-result',
                )
              ).text,
            ).files,
          ).toEqual([
            {
              name: REPORT_NAME,
              size: Buffer.byteLength(REPORT_BODY),
              sha256: sha256Hex(REPORT_BODY),
            },
          ]);
        } finally {
          await endApprovalSession(electronApp, session.id);
        }
      },
      { routes: ['mcp', WORKTREE_ROUTE] },
    );
  });

  test('a path-scoped deny covers a link into its folder and another case of its path beside a site-wide allow, through the chat routes', async () => {
    test.setTimeout(240_000);
    await withBrowser(
      origin,
      'upload',
      async ({ kind, run, electronApp, window, url }) => {
        const session = await startApprovalSession(
          electronApp,
          chatForRoute(kind),
          'ask',
        );
        const card = chatPanelLocator(window).getByTestId('tool-approval-card');
        try {
          const root = session.workspaceRoot;
          workspaceFile(root, 'secrets/key.pem', 'secret key\n');
          mkdirSync(path.join(root, 'public'), { recursive: true });
          symlinkSync(
            path.join('..', 'secrets', 'key.pem'),
            path.join(root, 'public', 'k'),
          );
          const allowed = workspaceFile(root, 'exports/ok.txt');
          for (const [id, behavior, target] of [
            ['upload-allow-site', 'allow', { kind: 'browser-upload', origin }],
            [
              'upload-deny-secrets',
              'deny',
              { kind: 'browser-upload', origin, path: 'secrets/**' },
            ],
          ])
            await window.evaluate(
              (request) => window.api.approvals.addRule(request),
              {
                scope: 'global',
                rule: {
                  id,
                  behavior,
                  target,
                  createdAt: new Date().toISOString(),
                  origin: 'settings',
                },
              },
            );
          const upload = (file) =>
            run({
              type: 'browser.upload_files',
              locator: selector('browser-lab-upload-single-input'),
              files: [{ path: file }],
            });
          // The site-wide allow answers an ordinary file without asking.
          expect(receiptOf(await upload(allowed))).toMatchObject({
            status: 'executed',
            upload: { status: 'attached' },
          });
          // A link into the denied folder is denied by the file it leads to.
          expect(receiptOf(await upload('public/k'))).toMatchObject({
            status: 'not_executed',
            error: { code: 'approval_denied' },
            upload: {
              status: 'denied',
              files: [{ name: 'k', displayPath: 'secrets/key.pem' }],
            },
          });
          // So is another case of the path, where the filesystem has none.
          if (existsSync(path.join(root, 'SECRETS', 'key.pem')))
            expect(receiptOf(await upload('Secrets/key.pem'))).toMatchObject({
              status: 'not_executed',
              error: { code: 'approval_denied' },
            });
          await expect(card).toHaveCount(0);
          const received = JSON.parse(
            (await echoed(electronApp, url, 'browser-lab-upload-single-result'))
              .text,
          );
          expect(received.files.map((file) => file.name)).toEqual(['ok.txt']);
        } finally {
          await endApprovalSession(electronApp, session.id);
        }
      },
      { routes: ['mcp', WORKTREE_ROUTE] },
    );
  });

  test('upload_files and request_files are denied when the chat has no approval session, and uploads list by kind, through every route', async () => {
    test.setTimeout(300_000);
    await withBrowser(
      origin,
      'upload',
      async ({ kind, run, electronApp, url, window }) => {
        // A session for another chat only shows where the workspace is.
        const root = await startApprovalSession(
          electronApp,
          { ...chatForRoute(kind), chatId: `probe-${randomUUID()}` },
          'ask',
        );
        await endApprovalSession(electronApp, root.id);
        const file = workspaceFile(root.workspaceRoot, 'no-session.txt');
        expect(
          receiptOf(
            await run({
              type: 'browser.upload_files',
              locator: selector('browser-lab-upload-single-input'),
              files: [{ path: file }],
            }),
          ),
          kind,
        ).toMatchObject({
          status: 'not_executed',
          error: { code: 'approval_denied' },
        });
        await expect(
          chatPanelLocator(window).getByTestId('tool-approval-card'),
        ).toHaveCount(0);
        expect(
          await echoed(electronApp, url, 'browser-lab-upload-single-result'),
        ).toMatchObject({ state: 'idle' });
        // Asking the user for files is denied the same way, with no card.
        expect(
          receiptOf(
            await run({
              type: 'browser.request_files',
              locator: selector('browser-lab-upload-single-input'),
            }),
          ),
          kind,
        ).toMatchObject({
          status: 'not_executed',
          error: { code: 'approval_denied' },
        });
        await expect(
          chatPanelLocator(window).getByTestId('tool-approval-card'),
        ).toHaveCount(0);
        // Every route lists the denied upload by kind.
        expect(
          await listTransfers(run, { kind: 'upload' }),
          kind,
        ).toMatchObject({
          total: 1,
          transfers: [
            {
              kind: 'upload',
              status: 'denied',
              error: { code: 'approval_denied' },
              files: [{ displayPath: file }],
            },
          ],
        });
      },
      { routes: [...ROUTES, WORKTREE_ROUTE, ADVISOR_ENTRY_ROUTE] },
    );
  });
});

/** Answers the native open dialog with each list of paths in turn, recording its options. */
async function armOpenDialog(electronApp, responses) {
  await electronApp.evaluate(({ dialog }, queue) => {
    const calls = [];
    globalThis.__browserFilesOpenDialogCalls = calls;
    dialog.showOpenDialog = async (...args) => {
      calls.push(args.length > 1 ? args[1] : args[0]);
      const next = queue.shift() ?? [];
      return { canceled: next.length === 0, filePaths: next };
    };
  }, responses);
}

function openDialogCalls(electronApp) {
  return electronApp.evaluate(
    () => globalThis.__browserFilesOpenDialogCalls ?? [],
  );
}

/** Clicks as the user would: with a user gesture, outside any agent action. */
/** Removes an element from the Browser Lab page, as the page's own script would. */
async function removeInLab(electronApp, url, testId) {
  return electronApp.evaluate(
    async ({ webContents }, input) => {
      const view = webContents
        .getAllWebContents()
        .find((contents) => contents.getURL() === input.url);
      if (!view) throw new Error('Browser Lab WebContents not found');
      return view.mainFrame.executeJavaScript(
        `document.querySelector('[data-testid="${input.testId}"]')?.remove()`,
      );
    },
    { url, testId },
  );
}

async function userClickInLab(electronApp, url, testId, framePath) {
  return electronApp.evaluate(
    async ({ webContents }, input) => {
      const view = webContents
        .getAllWebContents()
        .find((contents) => contents.getURL() === input.url);
      if (!view) throw new Error('Browser Lab WebContents not found');
      const frame = input.framePath
        ? view.mainFrame.framesInSubtree.find((candidate) => {
            try {
              return new URL(candidate.url).pathname === input.framePath;
            } catch {
              return false;
            }
          })
        : view.mainFrame;
      if (!frame) throw new Error('Frame not found');
      return frame.executeJavaScript(
        `document.querySelector('[data-testid="${input.testId}"]')?.click()`,
        true,
      );
    },
    { url, testId, framePath },
  );
}

/** A file outside the workspace, as the user would pick it. */
function pickedFile(name, body) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'chooser-pick-'));
  const file = path.join(directory, name);
  writeFileSync(file, body);
  return file;
}

test.describe('phase 08b: file choosers and request_files', () => {
  test('a chooser the user opens gets the native picker and only their picks, in the page and in a cross-site frame; one opened without a gesture does nothing', async () => {
    test.setTimeout(180_000);
    await withBrowser(
      origin,
      'upload',
      async ({ run, electronApp, window, url }) => {
        const pick = pickedFile('user-pick.txt', 'picked by the user\n');
        const framePick = pickedFile('frame-pick.txt', 'picked in a frame\n');
        await armOpenDialog(electronApp, [[pick], [framePick]]);
        await userClickInLab(
          electronApp,
          url,
          'browser-lab-upload-hidden-open',
        );
        await expect
          .poll(
            async () =>
              (
                await echoed(
                  electronApp,
                  url,
                  'browser-lab-upload-hidden-result',
                )
              ).state,
            { timeout: 15_000 },
          )
          .toBe('done');
        const received = JSON.parse(
          (await echoed(electronApp, url, 'browser-lab-upload-hidden-result'))
            .text,
        );
        expect(received.files).toEqual([
          expect.objectContaining({
            name: 'user-pick.txt',
            sha256: sha256Hex('picked by the user\n'),
          }),
        ]);
        expect(await openDialogCalls(electronApp)).toEqual([
          { properties: ['openFile'] },
        ]);
        await expect(
          window.getByTestId('browser-pending-surface-file-chooser'),
        ).toHaveCount(0);

        // A chooser in a cross-site frame is intercepted on its own session.
        await expect
          .poll(
            async () =>
              (
                await echoedInFrame(
                  electronApp,
                  url,
                  'browser-lab-upload-frame-result',
                ).catch(() => ({ state: 'missing' }))
              ).state,
            { timeout: 15_000 },
          )
          .not.toBe('missing');
        await userClickInLab(
          electronApp,
          url,
          'browser-lab-upload-frame-input',
          '/browser-lab/upload/frame',
        );
        await expect
          .poll(
            async () =>
              (
                await echoedInFrame(
                  electronApp,
                  url,
                  'browser-lab-upload-frame-result',
                )
              ).state,
            { timeout: 15_000 },
          )
          .toBe('done');
        expect(
          JSON.parse(
            (
              await echoedInFrame(
                electronApp,
                url,
                'browser-lab-upload-frame-result',
              )
            ).text,
          ).files,
        ).toEqual([expect.objectContaining({ name: 'frame-pick.txt' })]);

        // Without a user gesture a page cannot open a chooser at all: the
        // hostile page tries as it loads, before anything activated it.
        const hostile = `${origin}/browser-lab/hostile-transfers`;
        expect((await run({ type: 'browser.navigate', url: hostile })).ok).toBe(
          true,
        );
        await expect
          .poll(
            () =>
              readLab(
                electronApp,
                hostile,
                'browser-lab-hostile-transfers-chooser-status',
                'data-browser-lab-chooser-attempts',
              ).catch(() => null),
            { timeout: 15_000 },
          )
          .toBe('1');
        await window.waitForTimeout(500);
        expect(await openDialogCalls(electronApp)).toHaveLength(2);
        await expect(
          window.getByTestId('browser-pending-surface-file-chooser'),
        ).toHaveCount(0);
      },
      { routes: ['mcp'] },
    );
  });

  test('a chooser an agent action opens is reported and shown, upload_files answers it by its id, and it ends when its page navigates or the user dismisses it, through the chat routes', async () => {
    test.setTimeout(300_000);
    await withBrowser(
      origin,
      'upload',
      async ({ kind, run, electronApp, window, url }) => {
        const session = await startApprovalSession(
          electronApp,
          chatForRoute(kind),
          'ask',
        );
        const card = chatPanelLocator(window).getByTestId('tool-approval-card');
        const banner = window.getByTestId(
          'browser-pending-surface-file-chooser',
        );
        const openChooser = async () => {
          const clicked = receiptOf(
            await run({
              type: 'browser.click',
              locator: selector('browser-lab-upload-hidden-open'),
            }),
          );
          expect(
            clicked,
            `${kind}: ${JSON.stringify(clicked.error)}`,
          ).toMatchObject({
            status: 'executed',
            effects: {
              fileChooser: {
                id: expect.stringMatching(/^chooser-/),
                frameOrigin: origin,
                topOrigin: origin,
                multiple: false,
              },
            },
          });
          return clicked.effects.fileChooser;
        };
        try {
          await armOpenDialog(electronApp, []);
          const file = workspaceFile(session.workspaceRoot, 'chooser.txt');
          const chooser = await openChooser();
          await expect(banner).toBeVisible({ timeout: 15_000 });
          await expect(banner).toContainText(
            `${new URL(origin).host} is asking for a file`,
          );
          const uploading = run({
            type: 'browser.upload_files',
            chooserId: chooser.id,
            files: [{ path: file }],
          });
          await cardFor(card, uploading);
          await card.getByTestId('tool-approval-allow').click();
          expect(receiptOf(await uploading)).toMatchObject({
            status: 'executed',
            upload: { status: 'attached' },
          });
          await expect(banner).toHaveCount(0);
          await expect
            .poll(
              async () =>
                (
                  await echoed(
                    electronApp,
                    url,
                    'browser-lab-upload-hidden-result',
                  )
                ).state,
              { timeout: 15_000 },
            )
            .toBe('done');
          expect(
            JSON.parse(
              (
                await echoed(
                  electronApp,
                  url,
                  'browser-lab-upload-hidden-result',
                )
              ).text,
            ).files,
          ).toEqual([
            expect.objectContaining({
              name: 'chooser.txt',
              sha256: sha256Hex(UPLOAD_BODY),
            }),
          ]);
          // An answered chooser is gone.
          expect(
            receiptOf(
              await run({
                type: 'browser.upload_files',
                chooserId: chooser.id,
                files: [{ path: file }],
              }),
            ),
          ).toMatchObject({
            status: 'not_executed',
            error: { code: 'chooser_expired' },
          });

          // A chooser ends when its page shows another document.
          const stale = await openChooser();
          await expect(banner).toBeVisible({ timeout: 15_000 });
          expect((await run({ type: 'browser.reload' })).ok).toBe(true);
          await expect(banner).toHaveCount(0, { timeout: 15_000 });
          expect(
            receiptOf(
              await run({
                type: 'browser.upload_files',
                chooserId: stale.id,
                files: [{ path: file }],
              }),
            ),
          ).toMatchObject({
            status: 'not_executed',
            error: { code: 'chooser_expired' },
          });
          await expect(card).toHaveCount(0);

          // A chooser the user dismisses while the chat is asked takes nothing.
          const dismissed = await openChooser();
          await expect(banner).toBeVisible({ timeout: 15_000 });
          const requesting = run({
            type: 'browser.request_files',
            chooserId: dismissed.id,
          });
          await cardFor(card, requesting);
          await banner.getByTestId('browser-file-chooser-dismiss').click();
          await expect(banner).toHaveCount(0, { timeout: 15_000 });
          await card.getByTestId('tool-approval-choose-files').click();
          expect(receiptOf(await requesting)).toMatchObject({
            status: 'not_executed',
            error: { code: 'chooser_expired' },
          });
          // A chooser whose input the page removes takes nothing and ends,
          // whether it goes while the chat is asked or before it is used.
          const removedWhileAsked = await openChooser();
          await expect(banner).toBeVisible({ timeout: 15_000 });
          const uploadingRemoved = run({
            type: 'browser.upload_files',
            chooserId: removedWhileAsked.id,
            files: [{ path: file }],
          });
          await cardFor(card, uploadingRemoved);
          await removeInLab(
            electronApp,
            url,
            'browser-lab-upload-hidden-input',
          );
          await card.getByTestId('tool-approval-allow').click();
          expect(receiptOf(await uploadingRemoved)).toMatchObject({
            status: 'not_executed',
            error: { code: 'chooser_expired' },
          });
          await expect(banner).toHaveCount(0, { timeout: 15_000 });
          expect((await run({ type: 'browser.reload' })).ok).toBe(true);
          await run({ type: 'browser.wait_for', loadState: 'load' });
          const removedBeforeUse = await openChooser();
          await expect(banner).toBeVisible({ timeout: 15_000 });
          await removeInLab(
            electronApp,
            url,
            'browser-lab-upload-hidden-input',
          );
          expect(
            receiptOf(
              await run({
                type: 'browser.upload_files',
                chooserId: removedBeforeUse.id,
                files: [{ path: file }],
              }),
            ),
          ).toMatchObject({
            status: 'not_executed',
            error: { code: 'chooser_expired' },
          });
          await expect(banner).toHaveCount(0, { timeout: 15_000 });
          await expect(card).toHaveCount(0);

          // Files attached to the input by locator answer its chooser too.
          expect((await run({ type: 'browser.reload' })).ok).toBe(true);
          await run({ type: 'browser.wait_for', loadState: 'load' });
          const answeredByLocator = await openChooser();
          await expect(banner).toBeVisible({ timeout: 15_000 });
          const uploadingByLocator = run({
            type: 'browser.upload_files',
            locator: selector('browser-lab-upload-hidden-input'),
            files: [{ path: file }],
          });
          await cardFor(card, uploadingByLocator);
          await card.getByTestId('tool-approval-allow').click();
          expect(receiptOf(await uploadingByLocator)).toMatchObject({
            status: 'executed',
            upload: { status: 'attached' },
          });
          await expect(banner).toHaveCount(0, { timeout: 15_000 });
          expect(
            receiptOf(
              await run({
                type: 'browser.request_files',
                chooserId: answeredByLocator.id,
              }),
            ),
          ).toMatchObject({
            status: 'not_executed',
            error: { code: 'chooser_expired' },
          });
          // The next chooser an agent opens is held, not ignored.
          await openChooser();
          await expect(banner).toBeVisible({ timeout: 15_000 });
          await banner.getByTestId('browser-file-chooser-dismiss').click();
          await expect(banner).toHaveCount(0, { timeout: 15_000 });
          // The agent's chooser never opened a native picker.
          expect(await openDialogCalls(electronApp)).toEqual([]);
        } finally {
          await endApprovalSession(electronApp, session.id);
        }
      },
      { routes: ['mcp', WORKTREE_ROUTE] },
    );
  });

  test('the user answers a chooser an agent action opened from its banner: Choose file… attaches their pick, Dismiss ends it', async () => {
    test.setTimeout(180_000);
    await withBrowser(
      origin,
      'upload',
      async ({ run, electronApp, window, url }) => {
        const banner = window.getByTestId(
          'browser-pending-surface-file-chooser',
        );
        const pick = pickedFile('banner-pick.txt', 'picked from the banner\n');
        await armOpenDialog(electronApp, [[pick]]);
        const click = () =>
          run({
            type: 'browser.click',
            locator: selector('browser-lab-upload-hidden-open'),
          });
        expect(receiptOf(await click()).effects?.fileChooser).toBeDefined();
        await expect(banner).toBeVisible({ timeout: 15_000 });
        await banner.getByTestId('browser-file-chooser-choose').click();
        await expect(banner).toHaveCount(0, { timeout: 15_000 });
        await expect
          .poll(
            async () =>
              (
                await echoed(
                  electronApp,
                  url,
                  'browser-lab-upload-hidden-result',
                )
              ).state,
            { timeout: 15_000 },
          )
          .toBe('done');
        expect(
          JSON.parse(
            (await echoed(electronApp, url, 'browser-lab-upload-hidden-result'))
              .text,
          ).files,
        ).toEqual([expect.objectContaining({ name: 'banner-pick.txt' })]);

        expect(receiptOf(await click()).effects?.fileChooser).toBeDefined();
        await expect(banner).toBeVisible({ timeout: 15_000 });
        await banner.getByTestId('browser-file-chooser-dismiss').click();
        await expect(banner).toHaveCount(0, { timeout: 15_000 });
        expect(await openDialogCalls(electronApp)).toHaveLength(1);

        // A pick through the page's own button answers the agent's chooser
        // for that input, so the agent can no longer replace it.
        const own = pickedFile('own-pick.txt', 'picked through the page\n');
        await armOpenDialog(electronApp, [[own]]);
        const answered = receiptOf(await click()).effects?.fileChooser;
        expect(answered).toBeDefined();
        await expect(banner).toBeVisible({ timeout: 15_000 });
        await userClickInLab(
          electronApp,
          url,
          'browser-lab-upload-hidden-open',
        );
        await expect(banner).toHaveCount(0, { timeout: 15_000 });
        await expect
          .poll(
            async () =>
              JSON.parse(
                (
                  await echoed(
                    electronApp,
                    url,
                    'browser-lab-upload-hidden-result',
                  )
                ).text || '{}',
              ).files?.[0]?.name,
            { timeout: 15_000 },
          )
          .toBe('own-pick.txt');
        expect(
          receiptOf(
            await run({
              type: 'browser.request_files',
              chooserId: answered.id,
            }),
          ),
        ).toMatchObject({
          status: 'not_executed',
          error: { code: 'chooser_expired' },
        });
      },
      { routes: ['mcp'] },
    );
  });

  test('request_files asks the chat with the agent’s purpose, opens the picker with the input’s rules, and reports names and sizes; Decline and a closed picker attach nothing, through the chat routes', async () => {
    test.setTimeout(300_000);
    await withBrowser(
      origin,
      'upload',
      async ({ kind, run, electronApp, window, url }) => {
        const session = await startApprovalSession(
          electronApp,
          chatForRoute(kind),
          'ask',
        );
        const card = chatPanelLocator(window).getByTestId('tool-approval-card');
        const pick = pickedFile('requested.txt', 'chosen for the agent\n');
        const request = (purpose) =>
          run({
            type: 'browser.request_files',
            locator: selector('browser-lab-upload-single-input'),
            ...(purpose ? { purpose } : {}),
          });
        try {
          await armOpenDialog(electronApp, [[pick], []]);
          const requested = request('Your report for the form');
          await cardFor(card, requested);
          await expect(card).toContainText(
            `Choose a file for ${new URL(origin).host}`,
          );
          await expect(card).toContainText('“Your report for the form”');
          await expect(card.getByTestId('tool-approval-allow')).toHaveCount(0);
          await card.getByTestId('tool-approval-choose-files').click();
          const response = await requested;
          expect(receiptOf(response), kind).toMatchObject({
            kind: 'request_files',
            status: 'executed',
            requestedFiles: [
              {
                name: 'requested.txt',
                sizeBytes: Buffer.byteLength('chosen for the agent\n'),
              },
            ],
          });
          expect(JSON.stringify(response)).not.toContain(path.dirname(pick));
          await expect
            .poll(
              async () =>
                (
                  await echoed(
                    electronApp,
                    url,
                    'browser-lab-upload-single-result',
                  )
                ).state,
              { timeout: 15_000 },
            )
            .toBe('done');
          expect(
            JSON.parse(
              (
                await echoed(
                  electronApp,
                  url,
                  'browser-lab-upload-single-result',
                )
              ).text,
            ).files,
          ).toEqual([
            expect.objectContaining({
              name: 'requested.txt',
              sha256: sha256Hex('chosen for the agent\n'),
            }),
          ]);
          expect((await openDialogCalls(electronApp))[0]).toMatchObject({
            title: `Choose a file for ${new URL(origin).host}`,
            properties: ['openFile'],
          });

          // Decline asks for nothing more.
          const declined = request();
          await cardFor(card, declined);
          await card.getByTestId('tool-approval-decline-files').click();
          expect(receiptOf(await declined)).toMatchObject({
            status: 'not_executed',
            error: { code: 'approval_denied' },
          });
          expect(await openDialogCalls(electronApp)).toHaveLength(1);

          // Closing the picker attaches nothing.
          const closed = request();
          await cardFor(card, closed);
          await card.getByTestId('tool-approval-choose-files').click();
          expect(receiptOf(await closed)).toMatchObject({
            status: 'not_executed',
            error: { code: 'cancelled' },
          });
          expect(await openDialogCalls(electronApp)).toHaveLength(2);
        } finally {
          await endApprovalSession(electronApp, session.id);
        }
      },
      { routes: ['mcp', WORKTREE_ROUTE] },
    );
  });
});

/** Upload session diagnostics the app wrote for this run. */
function uploadSessionEvents(userDataDir) {
  const directory = path.join(
    userDataDir,
    'agent-observability',
    'diagnostics',
    'session-events',
  );
  if (!existsSync(directory)) return [];
  return readdirSync(directory)
    .filter((name) => name.endsWith('.jsonl'))
    .flatMap((name) =>
      readFileSync(path.join(directory, name), 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line)),
    )
    .filter((event) => String(event.kind).startsWith('browser_upload_'));
}

test.describe('phase 08c: drop_files, chat attachments, and upload diagnostics', () => {
  test('drop_files asks the calling chat, drops exactly the staged bytes on the drop zone, and Deny drops nothing; the page’s send shows in get_network and the diagnostics carry no paths, through the chat routes', async () => {
    test.setTimeout(300_000);
    await withBrowser(
      origin,
      'upload',
      async ({ kind, run, electronApp, window, url, userDataDir }) => {
        const session = await startApprovalSession(
          electronApp,
          chatForRoute(kind),
          'ask',
        );
        const card = chatPanelLocator(window).getByTestId('tool-approval-card');
        try {
          const file = workspaceFile(session.workspaceRoot, 'drops/drop.txt');
          const drop = () =>
            run({
              type: 'browser.drop_files',
              locator: selector('browser-lab-upload-drop-zone'),
              files: [{ path: file }],
            });
          const denied = drop();
          await cardFor(card, denied);
          await expect(card).toContainText('drop.txt');
          await card.getByTestId('tool-approval-deny').click();
          expect(receiptOf(await denied), kind).toMatchObject({
            kind: 'drop_files',
            status: 'not_executed',
            error: { code: 'approval_denied' },
          });
          expect(
            (await echoed(electronApp, url, 'browser-lab-upload-drop-result'))
              .state,
          ).not.toBe('done');

          const allowed = drop();
          await cardFor(card, allowed);
          await card.getByTestId('tool-approval-allow').click();
          const allowedReceipt = receiptOf(await allowed);
          expect(
            allowedReceipt,
            `${kind}: ${JSON.stringify(allowedReceipt.upload?.error ?? allowedReceipt.error)}`,
          ).toMatchObject({
            kind: 'drop_files',
            status: 'executed',
            upload: { status: 'attached' },
          });
          await expect
            .poll(
              async () =>
                (
                  await echoed(
                    electronApp,
                    url,
                    'browser-lab-upload-drop-result',
                  )
                ).state,
              { timeout: 15_000 },
            )
            .toBe('done');
          expect(
            JSON.parse(
              (await echoed(electronApp, url, 'browser-lab-upload-drop-result'))
                .text,
            ).files,
          ).toEqual([
            expect.objectContaining({
              name: 'drop.txt',
              sha256: sha256Hex(UPLOAD_BODY),
            }),
          ]);
          // The page's own send is visible to the agent.
          const network = payloadOf(
            await run({ type: 'browser.get_network', limit: 200 }),
          );
          expect(
            network.entries.some(
              (entry) =>
                entry.method === 'POST' &&
                entry.url.includes('/browser-lab/upload-echo'),
            ),
            JSON.stringify(network.entries),
          ).toBe(true);
          // Requested, decided, and attached, by origin, name, size, and hash.
          await expect
            .poll(
              () =>
                uploadSessionEvents(userDataDir).map((event) => [
                  event.kind,
                  event.decision,
                ]),
              { timeout: 30_000 },
            )
            .toEqual([
              ['browser_upload_requested', undefined],
              ['browser_upload_decided', 'deny'],
              ['browser_upload_requested', undefined],
              ['browser_upload_decided', 'allow'],
              ['browser_upload_attached', undefined],
            ]);
          const events = uploadSessionEvents(userDataDir);
          expect(events[4]).toMatchObject({
            origin,
            files: [
              {
                name: 'drop.txt',
                sizeBytes: Buffer.byteLength(UPLOAD_BODY),
                sha256: sha256Hex(UPLOAD_BODY),
              },
            ],
          });
          const recorded = JSON.stringify(events);
          expect(recorded).not.toContain(session.workspaceRoot);
          expect(recorded).not.toContain(userDataDir);
          expect(recorded).not.toContain('drops/');
          expect(recorded).not.toContain(UPLOAD_BODY.trim());
          expect(recorded).not.toContain('?');

          // A zone another site's frame fills would hand that site the files.
          const framed = run({
            type: 'browser.drop_files',
            locator: selector('browser-lab-upload-framed-drop-zone'),
            files: [{ path: file }],
          });
          await cardFor(card, framed);
          await card.getByTestId('tool-approval-allow').click();
          expect(receiptOf(await framed), kind).toMatchObject({
            kind: 'drop_files',
            status: 'not_executed',
          });
          await new Promise((settle) => setTimeout(settle, 1_000));
          expect(
            (
              await echoedInFrame(
                electronApp,
                url,
                'browser-lab-upload-drop-frame-result',
                '/browser-lab/upload/drop-frame',
              )
            ).state,
            kind,
          ).toBe('idle');
        } finally {
          await endApprovalSession(electronApp, session.id);
        }
      },
      { routes: ['mcp', WORKTREE_ROUTE] },
    );
  });

  test('upload_files sends a file the user attached to this chat, and refuses one from another chat without asking, through the chat routes', async () => {
    test.setTimeout(300_000);
    const attachmentsFolder = (userDataDir) =>
      path.join(
        userDataDir,
        'workspaces',
        OWNER.projectId,
        'attachments',
        OWNER.worktreeId,
      );
    await withBrowser(
      origin,
      'upload',
      async ({ kind, run, electronApp, window, url }) => {
        const session = await startApprovalSession(
          electronApp,
          chatForRoute(kind),
          'ask',
        );
        const card = chatPanelLocator(window).getByTestId('tool-approval-card');
        try {
          const upload = (attachmentId) =>
            run({
              type: 'browser.upload_files',
              locator: selector('browser-lab-upload-single-input'),
              files: [{ attachmentId }],
            });
          // In the folder, but this chat never attached it.
          for (const id of ['theirs.txt', '../theirs.txt'])
            expect(receiptOf(await upload(id)), `${kind} ${id}`).toMatchObject({
              status: 'not_executed',
              error: { code: 'file_not_eligible' },
            });
          await expect(card).toHaveCount(0);

          const uploading = upload('mine.txt');
          await cardFor(card, uploading);
          await expect(card).toContainText('mine.txt');
          await card.getByTestId('tool-approval-allow').click();
          expect(receiptOf(await uploading), kind).toMatchObject({
            status: 'executed',
            upload: {
              status: 'attached',
              files: [{ name: 'mine.txt' }],
            },
          });
          // The page sends what its input holds as soon as it changes.
          await expect
            .poll(
              async () =>
                (
                  await echoed(
                    electronApp,
                    url,
                    'browser-lab-upload-single-result',
                  )
                ).state,
              { timeout: 15_000 },
            )
            .toBe('done');
          expect(
            JSON.parse(
              (
                await echoed(
                  electronApp,
                  url,
                  'browser-lab-upload-single-result',
                )
              ).text,
            ).files,
          ).toEqual([
            expect.objectContaining({
              name: 'mine.txt',
              sha256: sha256Hex('my attachment\n'),
            }),
          ]);
        } finally {
          await endApprovalSession(electronApp, session.id);
        }
      },
      {
        routes: ['mcp', WORKTREE_ROUTE],
        seed: {
          onBeforeLaunch: ({ userDataDir }) => {
            const folder = attachmentsFolder(userDataDir);
            mkdirSync(folder, { recursive: true });
            writeFileSync(path.join(folder, 'mine.txt'), 'my attachment\n');
            writeFileSync(path.join(folder, 'theirs.txt'), 'other chat\n');
            seedWorktreeChat({
              userDataDir,
              workspaceId: OWNER.projectId,
              worktreeId: OWNER.worktreeId,
              providerType: 'claude',
              tabs: [
                {
                  id: SEEDED_CHAT_TAB_ID,
                  title: 'Chat',
                  messages: [
                    {
                      id: 'attach-message',
                      role: 'user',
                      blocks: [{ type: 'text', text: 'Here is my file.' }],
                      timestamp: Date.parse('2026-10-15T12:00:00.000Z'),
                      attachmentPaths: [path.join(folder, 'mine.txt')],
                    },
                  ],
                },
              ],
            });
          },
        },
      },
    );
  });
});

test.describe('phase 09a: save_pdf and file choosers in get_dialog', () => {
  test('get_dialog reports a chooser an agent action opened, handle_dialog dismisses it and refuses to accept it, and save_pdf saves the page as a named print file, through every route', async () => {
    test.setTimeout(300_000);
    await withBrowser(
      origin,
      'upload',
      async ({ kind, run, electronApp, window, userDataDir, url }) => {
        const banner = window.getByTestId(
          'browser-pending-surface-file-chooser',
        );
        const clicked = receiptOf(
          await run({
            type: 'browser.click',
            locator: selector('browser-lab-upload-hidden-open'),
          }),
        );
        expect(clicked, `${kind}: ${JSON.stringify(clicked)}`).toMatchObject({
          status: 'executed',
          effects: { fileChooser: { id: expect.stringMatching(/^chooser-/) } },
        });
        const chooser = clicked.effects.fileChooser;
        await expect(banner).toBeVisible({ timeout: 15_000 });
        expect(
          payloadOf(await run({ type: 'browser.get_dialog' })),
        ).toMatchObject({
          dialog: null,
          fileChooser: {
            id: chooser.id,
            frameOrigin: origin,
            topOrigin: origin,
            multiple: false,
          },
        });
        const handle = (accept) =>
          run({ type: 'browser.handle_dialog', dialogId: chooser.id, accept });
        // Accepting means choosing files, which only upload_files and
        // request_files do.
        expect(await handle(true)).toMatchObject({
          ok: false,
          error: {
            code: 'invalid_target',
            details: {
              error: {
                code: 'unsupported_control',
                next: 'browser.upload_files',
              },
            },
          },
        });
        await expect(banner).toBeVisible();
        expect(payloadOf(await handle(false))).toMatchObject({
          handled: { fileChooserId: chooser.id, accept: false },
        });
        await expect(banner).toHaveCount(0, { timeout: 15_000 });
        expect(
          payloadOf(await run({ type: 'browser.get_dialog' })),
        ).toMatchObject({ dialog: null, fileChooser: null });
        expect(await handle(false)).toMatchObject({
          ok: false,
          error: { code: 'invalid_target' },
        });
        expect(
          receiptOf(
            await run({
              type: 'browser.upload_files',
              chooserId: chooser.id,
              files: [{ path: 'chooser.txt' }],
            }),
          ),
        ).toMatchObject({
          status: 'not_executed',
          error: { code: 'chooser_expired' },
        });

        const downloads = taskDownloadsDir(userDataDir);
        const named = await run({
          type: 'browser.save_pdf',
          fileName: 'Lab report',
          landscape: true,
          paperFormat: 'a4',
          displayHeaderFooter: true,
        });
        expect(
          payloadOf(named),
          `${kind}: ${JSON.stringify(named)}`,
        ).toMatchObject({
          ok: true,
          transfer: {
            kind: 'download',
            source: 'print',
            status: 'complete',
            fileName: 'Lab report.pdf',
            mimeType: 'application/pdf',
          },
        });
        expectAgentPayloadPathFree(named, kind, userDataDir);
        const namedBytes = readFileSync(path.join(downloads, 'Lab report.pdf'));
        expect(namedBytes.subarray(0, 5).toString('latin1')).toBe('%PDF-');
        expect(payloadOf(named).transfer.receivedBytes).toBe(namedBytes.length);
        // A second save of the same name takes the next free one.
        expect(
          payloadOf(
            await run({ type: 'browser.save_pdf', fileName: 'Lab report' }),
          ),
        ).toMatchObject({
          ok: true,
          transfer: { fileName: 'Lab report (1).pdf' },
        });

        const title = await inLab(electronApp, url, 'document.title');
        const titled = payloadOf(await run({ type: 'browser.save_pdf' }));
        expect(titled).toMatchObject({
          ok: true,
          transfer: { source: 'print', status: 'complete' },
        });
        expect(titled.transfer.fileName).toBe(
          `${title.trim().slice(0, 50)}.pdf`,
        );
        expect(
          readFileSync(path.join(downloads, titled.transfer.fileName))
            .subarray(0, 5)
            .toString('latin1'),
        ).toBe('%PDF-');

        // Pages past the end fail the print and save nothing.
        const before = filesIn(downloads);
        expect(
          payloadOf(
            await run({ type: 'browser.save_pdf', pageRanges: '90-99' }),
          ),
        ).toMatchObject({
          ok: false,
          error: {
            code: 'download_failed',
            message: expect.stringContaining('pageRanges'),
          },
        });
        expect(filesIn(downloads)).toEqual(before);

        const transfers = await listTransfers(run, { kind: 'download' });
        expect(
          transfers.transfers
            .filter((transfer) => transfer.source === 'print')
            .map((transfer) => transfer.status)
            .sort(),
        ).toEqual(['complete', 'complete', 'complete', 'failed']);

        // The PDF reaches the workspace through save_download.
        const session = await startApprovalSession(
          electronApp,
          chatForRoute(kind),
          'full-access',
        );
        try {
          expect(
            payloadOf(
              await run({
                type: 'browser.save_download',
                downloadId: payloadOf(named).transfer.id,
                path: `${kind}/report.pdf`,
              }),
            ),
          ).toMatchObject({
            ok: true,
            transfer: { kind: 'copy', status: 'complete' },
          });
          expect(
            readFileSync(path.join(session.workspaceRoot, kind, 'report.pdf')),
          ).toEqual(namedBytes);
        } finally {
          await endApprovalSession(electronApp, session.id);
        }
      },
      { routes: [...ROUTES, WORKTREE_ROUTE] },
    );
  });
});

test.describe('phase 09b: print interception', () => {
  test("a page's print during an agent action becomes a pending request that handle_dialog and the banner answer; outside one, the native dialog opens, through every route", async () => {
    test.setTimeout(300_000);
    await withBrowser(
      origin,
      'print',
      async ({ kind, run, electronApp, window, userDataDir, url }) => {
        await stubNativePrint(electronApp, url);
        const banner = window.getByTestId('browser-pending-surface-print');
        const host = new URL(origin).host;
        const askToPrint = async () => {
          const clicked = receiptOf(
            await run({
              type: 'browser.click',
              locator: selector('browser-lab-print-button'),
            }),
          );
          expect(clicked, `${kind}: ${JSON.stringify(clicked)}`).toMatchObject({
            status: 'executed',
            effects: {
              printRequest: {
                id: expect.stringMatching(/^print-/),
                frameOrigin: origin,
                topOrigin: origin,
              },
            },
          });
          await expect(banner).toBeVisible({ timeout: 15_000 });
          return clicked.effects.printRequest;
        };
        const handle = (dialogId, accept) =>
          run({ type: 'browser.handle_dialog', dialogId, accept });

        // An agent's print waits; nothing printed, and no print event fired.
        const first = await askToPrint();
        await expect(banner).toContainText(`${host} wants to print this page`);
        expect(
          payloadOf(await run({ type: 'browser.get_dialog' })),
        ).toMatchObject({
          dialog: null,
          fileChooser: null,
          printRequest: { id: first.id },
        });
        expect(
          await readLab(
            electronApp,
            url,
            'browser-lab-print-status',
            'data-browser-lab-events',
          ),
        ).toBe('click');
        // The page is not blocked: another action runs while it waits.
        expect((await run({ type: 'browser.input_snapshot' })).ok).toBe(true);

        // Accept saves the page as a PDF task file.
        const accepted = payloadOf(await handle(first.id, true));
        expect(accepted, `${kind}: ${JSON.stringify(accepted)}`).toMatchObject({
          handled: {
            printRequestId: first.id,
            accept: true,
            transfer: {
              kind: 'download',
              source: 'print',
              status: 'complete',
              fileName: expect.stringMatching(/\.pdf$/),
            },
          },
        });
        expectPathFree(accepted, kind, [userDataDir]);
        await expect(banner).toHaveCount(0);
        expect(
          readFileSync(
            path.join(
              taskDownloadsDir(userDataDir),
              accepted.handled.transfer.fileName,
            ),
          )
            .subarray(0, 5)
            .toString('latin1'),
        ).toBe('%PDF-');

        // Dismiss ends one; an answered or ended request is no longer pending.
        const second = await askToPrint();
        expect(payloadOf(await handle(second.id, false))).toMatchObject({
          handled: { printRequestId: second.id, accept: false },
        });
        await expect(banner).toHaveCount(0);
        expect(await handle(second.id, false)).toMatchObject({
          ok: false,
          error: { code: 'invalid_target' },
        });
        const third = await askToPrint();
        expect((await run({ type: 'browser.reload' })).ok).toBe(true);
        await expect(banner).toHaveCount(0, { timeout: 15_000 });
        expect(await handle(third.id, true)).toMatchObject({
          ok: false,
          error: { code: 'invalid_target' },
        });
        expect(
          payloadOf(await run({ type: 'browser.get_dialog' })),
        ).toMatchObject({ printRequest: null });
        await run({ type: 'browser.wait_for', loadState: 'load' });

        // The user's answers from the banner.
        const before = filesIn(taskDownloadsDir(userDataDir));
        await askToPrint();
        await banner.getByTestId('browser-print-request-save-pdf').click();
        await expect(banner).toHaveCount(0, { timeout: 15_000 });
        await expect
          .poll(() => filesIn(taskDownloadsDir(userDataDir)).length, {
            timeout: 15_000,
          })
          .toBe(before.length + 1);
        await askToPrint();
        await banner.getByTestId('browser-print-request-dismiss').click();
        await expect(banner).toHaveCount(0, { timeout: 15_000 });
        expect(await nativePrints(electronApp)).toEqual([]);
        await askToPrint();
        await banner.getByTestId('browser-print-request-print').click();
        await expect(banner).toHaveCount(0, { timeout: 15_000 });
        await expect.poll(() => nativePrints(electronApp)).toHaveLength(1);

        // Outside an agent action the app replays Blink's own print() in the
        // page's session, and no request is held.
        await userClickInLab(electronApp, url, 'browser-lab-print-button');
        await expect.poll(() => nativePrints(electronApp)).toHaveLength(2);
        expect(await nativePrints(electronApp)).toEqual([
          { sessionId: null },
          { sessionId: null },
        ]);
        await expect(banner).toHaveCount(0);
      },
      { routes: [...ROUTES, WORKTREE_ROUTE] },
    );
  });

  test('a frame sandboxed without allow-modals cannot print, as in Chromium, and one that allows modals can, through the chat routes', async () => {
    test.setTimeout(240_000);
    await withBrowser(
      origin,
      'print',
      async ({ kind, run, electronApp, window, url }) => {
        const inFrames = (expression) =>
          electronApp.evaluate(
            async ({ webContents }, input) => {
              const view = webContents
                .getAllWebContents()
                .find((contents) => contents.getURL() === input.url);
              if (!view) throw new Error('Browser Lab WebContents not found');
              const frames = view.mainFrame.framesInSubtree.filter(
                (frame) => frame.name === 'sandboxed' || frame.name === 'modal',
              );
              return Promise.all(
                frames.map(async (frame) => [
                  frame.name,
                  await frame.executeJavaScript(input.expression, true),
                ]),
              );
            },
            { url, expression },
          );
        await inLab(
          electronApp,
          url,
          `(() => { for (const [name, sandbox] of [['sandboxed', 'allow-scripts'], ['modal', 'allow-scripts allow-modals allow-same-origin']]) { const frame = document.createElement('iframe'); frame.name = name; frame.dataset.testid = 'browser-files-frame-' + name; frame.setAttribute('sandbox', sandbox); frame.srcdoc = '<button type="button" data-testid="browser-files-frame-print">Print</button>'; document.querySelector('main').prepend(frame); } })()`,
        );
        await expect
          .poll(
            async () =>
              (
                await inFrames(
                  `!!document.querySelector('[data-testid="browser-files-frame-print"]')`,
                ).catch(() => [])
              ).filter(([, ready]) => ready === true).length,
            { timeout: 15_000 },
          )
          .toBe(2);
        await inFrames(
          `document.querySelector('[data-testid="browser-files-frame-print"]').addEventListener('click', () => print()); addEventListener('beforeprint', () => { document.body.dataset.printed = 'yes'; }); true`,
        );
        await stubNativePrint(electronApp, url);
        const banner = window.getByTestId('browser-pending-surface-print');
        const clickIn = async (name) =>
          receiptOf(
            await run({
              type: 'browser.click',
              frame: selector(`browser-files-frame-${name}`),
              locator: selector('browser-files-frame-print'),
            }),
          );

        const sandboxed = await clickIn('sandboxed');
        expect(
          sandboxed,
          `${kind}: ${JSON.stringify(sandboxed)}`,
        ).toMatchObject({ status: 'executed' });
        expect(sandboxed.effects?.printRequest).toBeUndefined();
        await window.waitForTimeout(500);
        await expect(banner).toHaveCount(0);

        const allowed = await clickIn('modal');
        // CDP reports a srcdoc frame's origin as opaque (`://`), so the
        // notice names the page's site.
        expect(allowed, `${kind}: ${JSON.stringify(allowed)}`).toMatchObject({
          status: 'executed',
          effects: { printRequest: { topOrigin: origin } },
        });
        await expect(banner).toContainText(
          `${new URL(origin).host} wants to print this page`,
          { timeout: 15_000 },
        );
        await run({
          type: 'browser.handle_dialog',
          dialogId: allowed.effects.printRequest.id,
          accept: false,
        });
        await expect(banner).toHaveCount(0);

        // Outside agent actions main replays Blink's own print(), and Blink
        // ignores it in the frame sandboxed without allow-modals.
        const userClickIn = (name) =>
          electronApp.evaluate(
            async ({ webContents }, input) => {
              const view = webContents
                .getAllWebContents()
                .find((contents) => contents.getURL() === input.url);
              const frame = view?.mainFrame.framesInSubtree.find(
                (candidate) => candidate.name === input.name,
              );
              await frame?.executeJavaScript(
                `document.querySelector('[data-testid="browser-files-frame-print"]').click()`,
                true,
              );
            },
            { url, name },
          );
        await electronApp.evaluate(() => {
          globalThis.__browserFilesForwardNativePrints = true;
        });
        await userClickIn('sandboxed');
        await expect.poll(() => nativePrints(electronApp)).toHaveLength(1);
        await window.waitForTimeout(1_000);
        await electronApp.evaluate(() => {
          globalThis.__browserFilesForwardNativePrints = false;
        });
        expect(await inFrames('document.body.dataset.printed ?? null')).toEqual(
          expect.arrayContaining([['sandboxed', null]]),
        );
        await userClickIn('modal');
        await expect.poll(() => nativePrints(electronApp)).toHaveLength(2);
      },
      { routes: ['mcp', WORKTREE_ROUTE] },
    );
  });

  test('a print from a cross-site frame during an agent action is held with the frame’s origin, through the chat routes', async () => {
    test.setTimeout(240_000);
    await withBrowser(
      origin,
      'upload',
      async ({ kind, run, electronApp, window, url }) => {
        await stubNativePrint(electronApp, url);
        const paired = lab.paired.origin;
        const framePath = '/browser-lab/upload/frame';
        await expect
          .poll(
            () =>
              echoedInFrame(electronApp, url, 'browser-lab-upload-frame-result')
                .then((result) => result.state)
                .catch(() => null),
            { timeout: 30_000 },
          )
          .toBe('idle');
        await electronApp.evaluate(
          async ({ webContents }, input) => {
            const view = webContents
              .getAllWebContents()
              .find((contents) => contents.getURL() === input.url);
            const frame = view?.mainFrame.framesInSubtree.find((candidate) => {
              try {
                return new URL(candidate.url).pathname === input.framePath;
              } catch {
                return false;
              }
            });
            if (!frame) throw new Error('Upload frame missing');
            await frame.executeJavaScript(
              `(() => { const button = document.createElement('button'); button.type = 'button'; button.textContent = 'Print the frame'; button.dataset.testid = 'browser-files-frame-print'; button.addEventListener('click', () => print()); document.body.prepend(button); })()`,
            );
          },
          { url, framePath },
        );
        await stubNativePrint(electronApp, url);
        const scrolled = await run({
          type: 'browser.scroll',
          intoView: true,
          locator: selector('browser-lab-upload-cross-origin-frame'),
        });
        expect(scrolled.ok, JSON.stringify(scrolled)).toBe(true);
        expect((await run({ type: 'browser.input_snapshot' })).ok).toBe(true);
        const clicked = receiptOf(
          await run({
            type: 'browser.click',
            locator: selector('browser-files-frame-print'),
            frame: selector('browser-lab-upload-cross-origin-frame'),
          }),
        );
        expect(clicked, `${kind}: ${JSON.stringify(clicked)}`).toMatchObject({
          status: 'executed',
          effects: {
            printRequest: { frameOrigin: paired, topOrigin: origin },
          },
        });
        const banner = window.getByTestId('browser-pending-surface-print');
        await expect(banner).toContainText(
          `${new URL(paired).host} wants to print this page`,
          { timeout: 15_000 },
        );
        expect(await nativePrints(electronApp)).toEqual([]);
        expect(
          payloadOf(
            await run({
              type: 'browser.handle_dialog',
              dialogId: clicked.effects.printRequest.id,
              accept: false,
            }),
          ),
        ).toMatchObject({ handled: { accept: false } });
        await expect(banner).toHaveCount(0);
      },
      { routes: ['mcp', WORKTREE_ROUTE] },
    );
  });
});

/** Evaluates in the lab page whose URL starts with `prefix`. */
async function inLabPage(electronApp, prefix, expression) {
  return electronApp.evaluate(
    async ({ webContents }, input) => {
      const view = webContents
        .getAllWebContents()
        .find((contents) => contents.getURL().startsWith(input.prefix));
      return view ? view.executeJavaScript(input.expression) : undefined;
    },
    { prefix, expression },
  );
}

test.describe('phase 09c: HTTP sign-ins and action effects', () => {
  test('an HTTP challenge waits for the user: the notice, the credentials dialog, and cancels, and agents can only cancel it, through every route', async () => {
    test.setTimeout(300_000);
    await withBrowser(
      origin,
      'auth',
      async ({ kind, run, window, electronApp, url }) => {
        const protectedPrefix = `${origin}/browser-lab/auth/protected`;
        const banner = window.getByTestId('browser-pending-surface-auth');
        const dialog = window.getByTestId('browser-sign-in-dialog');
        const host = new URL(origin).host;
        const outputs = [];
        const record = (response) => {
          outputs.push(response);
          return response;
        };
        const challenge = async () => {
          expect(
            (await run({ type: 'browser.navigate', url })).ok,
            `${kind}: back to the entry page`,
          ).toBe(true);
          record(
            await run({
              type: 'browser.click',
              locator: selector('browser-lab-auth-protected-link'),
            }),
          );
          await expect(banner).toContainText(`${host} needs you to sign in`, {
            timeout: 15_000,
          });
          const read = record(await run({ type: 'browser.get_dialog' }));
          expect(
            payloadOf(read),
            `${kind}: ${JSON.stringify(read)}`,
          ).toMatchObject({
            dialog: null,
            auth: {
              id: expect.stringMatching(/^auth-/),
              origin,
              realm: 'Browser Lab auth',
              isProxy: false,
            },
          });
          return payloadOf(read).auth;
        };
        const deniedShown = () =>
          expect
            .poll(
              () =>
                inLabPage(
                  electronApp,
                  protectedPrefix,
                  `!!document.querySelector('[data-testid="browser-lab-auth-denied-main"]')`,
                ),
              { timeout: 15_000 },
            )
            .toBe(true);

        // An agent can only cancel: accept is refused for the user.
        const first = await challenge();
        expect(
          record(
            await run({
              type: 'browser.handle_dialog',
              dialogId: first.id,
              accept: true,
            }),
          ),
        ).toMatchObject({
          ok: false,
          error: {
            code: 'invalid_target',
            details: { error: { code: 'policy_denied' } },
          },
        });
        await expect(banner).toBeVisible();
        expect(
          payloadOf(
            record(
              await run({
                type: 'browser.handle_dialog',
                dialogId: first.id,
                accept: false,
              }),
            ),
          ),
        ).toMatchObject({
          handled: { authRequestId: first.id, accept: false },
        });
        await expect(banner).toHaveCount(0);
        await deniedShown();

        // The notice's Cancel, and the dialog's.
        await challenge();
        await banner.getByTestId('browser-auth-request-cancel').click();
        await expect(banner).toHaveCount(0);
        await deniedShown();
        await challenge();
        await banner.getByTestId('browser-auth-request-sign-in').click();
        await expect(dialog).toContainText(`Sign in to ${host}`);
        await expect(dialog).toContainText('“Browser Lab auth”');
        await window.getByTestId('browser-sign-in-cancel').click();
        await expect(dialog).toHaveCount(0);
        await expect(banner).toHaveCount(0);
        await deniedShown();

        // The user's credentials load the page.
        await challenge();
        await banner.getByTestId('browser-auth-request-sign-in').click();
        await window
          .getByTestId('browser-sign-in-username')
          .fill('browser-lab-user');
        await window
          .getByTestId('browser-sign-in-password')
          .fill('browser-lab-pass-7Q4M');
        await window.getByTestId('browser-sign-in-submit').click();
        await expect(dialog).toHaveCount(0);
        await expect(banner).toHaveCount(0);
        await expect
          .poll(
            () =>
              inLabPage(
                electronApp,
                protectedPrefix,
                `!!document.querySelector('[data-testid="browser-lab-auth-welcome"]')`,
              ),
            { timeout: 15_000 },
          )
          .toBe(true);
        expect(
          payloadOf(record(await run({ type: 'browser.get_dialog' }))),
        ).toMatchObject({ auth: null });
        record(await run({ type: 'browser.get_console' }));
        record(await run({ type: 'browser.get_network' }));
        const text = JSON.stringify(outputs);
        expect(text).not.toContain('browser-lab-pass-7Q4M');
        expect(text).not.toContain(
          Buffer.from('browser-lab-user:browser-lab-pass-7Q4M').toString(
            'base64',
          ),
        );
      },
      { routes: [...ROUTES, WORKTREE_ROUTE] },
    );
  });

  test('the next page’s sign-in reaches the user while the last page’s waits, the credentials dialog keeps focus, and stopping the load ends it, through the worktree route', async () => {
    test.setTimeout(180_000);
    await withBrowser(
      origin,
      'auth',
      async ({ kind, run, window, url }) => {
        const banner = window.getByTestId('browser-pending-surface-auth');
        const pairedOrigin = lab.paired.origin;
        expect((await run({ type: 'browser.navigate', url })).ok).toBe(true);
        await run({
          type: 'browser.click',
          locator: selector('browser-lab-auth-protected-link'),
        });
        await expect(banner).toContainText(
          `${new URL(origin).host} needs you to sign in`,
          { timeout: 15_000 },
        );
        // Another site's protected page asks for its own sign-in.
        await run({
          type: 'browser.navigate',
          url: `${pairedOrigin}/browser-lab/auth/protected`,
        });
        await expect(banner).toContainText(
          `${new URL(pairedOrigin).host} needs you to sign in`,
          { timeout: 15_000 },
        );
        const read = await run({ type: 'browser.get_dialog' });
        expect(
          payloadOf(read),
          `${kind}: ${JSON.stringify(read)}`,
        ).toMatchObject({ auth: { origin: pairedOrigin } });
        // The credentials dialog keeps Tab inside it, and pulls focus in from
        // the browser bar behind it.
        await banner.getByTestId('browser-auth-request-sign-in').click();
        const username = window.getByTestId('browser-sign-in-username');
        const submit = window.getByTestId('browser-sign-in-submit');
        await expect(username).toBeFocused();
        await submit.focus();
        await window.keyboard.press('Tab');
        await expect(username).toBeFocused();
        await window.keyboard.press('Shift+Tab');
        await expect(submit).toBeFocused();
        await window.getByTestId('browser-url-input').focus();
        await window.keyboard.press('Tab');
        await expect(username).toBeFocused();
        await window.keyboard.press('Escape');
        await expect(window.getByTestId('browser-sign-in-dialog')).toHaveCount(
          0,
        );
        await expect(banner).toBeVisible();
        await run({ type: 'browser.stop' });
        await expect(banner).toHaveCount(0);
        expect(
          payloadOf(await run({ type: 'browser.get_dialog' })),
        ).toMatchObject({ auth: null });
      },
      { routes: [WORKTREE_ROUTE] },
    );
  });

  test('a popup and denied permission requests an action causes show in its effects, through the chat routes', async () => {
    test.setTimeout(240_000);
    await withBrowser(
      origin,
      'popups-permissions',
      async ({ kind, run, url, electronApp }) => {
        const click = async (testId) =>
          receiptOf(
            await run({
              type: 'browser.click',
              locator: selector(`browser-lab-popups-permissions-${testId}`),
            }),
          );
        const geolocation = await click('geolocation-button');
        expect(
          geolocation,
          `${kind}: ${JSON.stringify(geolocation)}`,
        ).toMatchObject({
          status: 'executed',
          effects: { permissionDenied: ['geolocation'] },
        });
        const notifications = await click('notification-permission-button');
        expect(
          notifications.effects?.permissionDenied ?? [],
          `${kind}: ${JSON.stringify(notifications)}`,
        ).toContain('notifications');
        const quiet = await click('file-picker-status');
        expect(quiet.effects?.popup).toBeUndefined();
        expect(quiet.effects?.permissionDenied).toBeUndefined();
        // A popup the external opener refuses is blocked, not opened.
        await inLabPage(
          electronApp,
          `${origin}/browser-lab/popups-permissions`,
          `document.querySelector('[data-testid="browser-lab-popups-permissions-file-picker-status"]').addEventListener('click', () => window.open('mailto:lab@example.com')), true`,
        );
        const mail = await click('file-picker-status');
        expect(mail, `${kind}: ${JSON.stringify(mail)}`).toMatchObject({
          status: 'executed',
          effects: { popup: { url: 'mailto:', handled: 'blocked' } },
        });
        const opened = await click('open-now-button');
        expect(opened, `${kind}: ${JSON.stringify(opened)}`).toMatchObject({
          status: 'executed',
          effects: {
            popup: {
              url: `${origin}/browser-lab/popups-permissions/popup`,
              handled: 'opened_in_tab',
            },
          },
        });
        expect((await run({ type: 'browser.navigate', url })).ok).toBe(true);
      },
      { routes: ['mcp', WORKTREE_ROUTE] },
    );
  });
});

async function requestWorktreeDeletion(window, row) {
  await row.hover();
  await row.getByTestId('worktree-actions-menu-button').click();
  await window.getByTestId('worktree-actions-menu-delete').click();
  const dialog = window.getByRole('dialog', { name: 'Delete worktree?' });
  // A clean worktree can delete directly; otherwise confirm branch handling.
  const confirmationRequired = await dialog
    .waitFor({ state: 'visible', timeout: 5_000 })
    .then(() => true)
    .catch(() => false);
  if (confirmationRequired) {
    await dialog.getByTestId('worktree-removal-branch-choice-button').click();
    await dialog.getByTestId('worktree-removal-preserve-branch').click();
  }
}

/**
 * Starts a streaming download and one that waits for the user, ends the app
 * (`crash` kills the main process; `quit` closes it normally), relaunches on
 * the same user data, and checks the records and the folder.
 */
async function expectInterruptedAfterRelaunch(ending) {
  for (const routeKind of ROUTES) {
    let launched = await seedPanelWorktree();
    const { userDataDir } = launched;
    const downloadsDir = taskDownloadsDir(userDataDir);
    try {
      let { electronApp } = launched;
      const route = await electronApp.evaluate(() =>
        globalThis.__CANOPY_E2E_BROWSER_MCP_ROUTE__({
          kind: 'create',
          mode: 'app-advisor',
        }),
      );
      const run = (action) =>
        routeKind === 'advisor'
          ? dispatchAdvisor(electronApp, action)
          : dispatchMcp(route, action);
      const opened = await openLab(
        electronApp,
        run,
        origin,
        'downloads',
        routeKind,
        { laidOut: true },
      );
      await clickInLab(
        electronApp,
        opened.url,
        'browser-lab-downloads-attachment',
      );
      await downloadInLab(
        electronApp,
        opened.url,
        `/browser-lab/download/resumable?hold=${randomUUID()}`,
      );
      await downloadInLab(
        electronApp,
        opened.url,
        `/browser-lab/download/resumable?hold=${randomUUID()}&stall=1`,
      );
      await pollTransfers(opened.run, (transfers) =>
        transfers.length === 3 &&
        transfers.some(
          (transfer) =>
            transfer.status === 'interrupted' && transfer.canResume === true,
        ) &&
        transfers.some(
          (transfer) =>
            transfer.status === 'in_progress' &&
            transfer.receivedBytes >= RESUMABLE_INTERRUPT_BYTES,
        ) &&
        transfers.some((transfer) => transfer.status === 'complete')
          ? true
          : undefined,
      );
      expect(filesIn(downloadsDir)).toEqual([
        'browser-lab-report.txt',
        'browser-lab-resumable.bin.download',
        'browser-lab-stalled.bin.download',
      ]);
      // The user renames the finished file and adds one of their own.
      renameSync(
        path.join(downloadsDir, 'browser-lab-report.txt'),
        path.join(downloadsDir, 'browser-lab-report-renamed.txt'),
      );
      writeFileSync(path.join(downloadsDir, 'notes.txt'), 'Kept by the user\n');

      if (ending === 'crash') {
        const mainPid = await electronApp.evaluate(() => process.pid);
        process.kill(mainPid, 'SIGKILL');
      }
      await closeCanopy(electronApp, userDataDir, { keepUserData: true });

      launched = await launchCanopy({ userDataDir });
      ({ electronApp } = launched);
      const window = await getMainWindow(electronApp);
      const app = new CanopyAppDriver(window);
      await app.waitForShell({ timeout: 30_000 });
      await app.openMainPage();
      await app.selectWorktree(OWNER.worktreeId);
      const relaunchedRoute =
        routeKind === 'mcp'
          ? await electronApp.evaluate(() =>
              globalThis.__CANOPY_E2E_BROWSER_MCP_ROUTE__({
                kind: 'create',
                mode: 'app-advisor',
              }),
            )
          : undefined;
      const rerun = (action) =>
        routeKind === 'advisor'
          ? dispatchAdvisor(electronApp, action)
          : dispatchMcp(relaunchedRoute, action);
      const listedBrowsers = await rerun({ type: 'browser.list' });
      const browser = payloadOf(listedBrowsers).browsers.find(
        (candidate) => candidate.id === opened.browserId,
      );
      expect(browser, JSON.stringify(payloadOf(listedBrowsers))).toBeTruthy();
      // The relaunched tab can take a new runtime generation once more while
      // it settles, so each command reads the current one.
      const relaunchedRun = async (action) => {
        const current = payloadOf(
          await rerun({ type: 'browser.list' }),
        ).browsers.find((candidate) => candidate.id === browser.id);
        return rerun({
          browserId: browser.id,
          expectedRuntimeGeneration: current?.profile?.runtimeGeneration,
          ...action,
        });
      };
      const recovered = await pollTransfers(
        relaunchedRun,
        (transfers) =>
          transfers.length === 3 && transfers.every(isFinal)
            ? transfers
            : undefined,
        { timeout: 20_000 },
      );
      expect(
        recovered
          .map(
            (transfer) =>
              `${transfer.fileName}:${transfer.status}:${transfer.canResume ?? false}`,
          )
          .sort(),
        `${routeKind} ${ending}`,
      ).toEqual([
        'browser-lab-report.txt:complete:false',
        'browser-lab-resumable.bin:interrupted:false',
        'browser-lab-stalled.bin:interrupted:false',
      ]);
      // Recovery deletes the partial files and keeps every other file.
      await expect
        .poll(() => filesIn(downloadsDir))
        .toEqual(['browser-lab-report-renamed.txt', 'notes.txt']);
      expect(
        readFileSync(
          path.join(downloadsDir, 'browser-lab-report-renamed.txt'),
          'utf8',
        ),
      ).toBe('Browser Lab attachment report\n');
      expect(readFileSync(path.join(downloadsDir, 'notes.txt'), 'utf8')).toBe(
        'Kept by the user\n',
      );
    } finally {
      await closeCanopy(launched.electronApp, userDataDir);
    }
  }
}

test.describe('phase 10a: recording files', () => {
  test('a recording names uploaded files only, waits for a download before the click that starts it, and prints with page.pdf(), through the chat routes', async () => {
    test.setTimeout(240_000);
    await withBrowser(
      origin,
      'upload',
      async ({ kind, run, electronApp, window, userDataDir, url }) => {
        const session = await startApprovalSession(
          electronApp,
          chatForRoute(kind),
          'ask',
        );
        const card = chatPanelLocator(window).getByTestId('tool-approval-card');
        try {
          const file = workspaceFile(
            session.workspaceRoot,
            'exports/recorded.txt',
          );
          const started = await run({ type: 'browser.start_recording' });
          expect(started.ok, JSON.stringify(started)).toBe(true);
          const uploading = run({
            type: 'browser.upload_files',
            locator: selector('browser-lab-upload-single-input'),
            files: [{ path: file }],
          });
          await cardFor(card, uploading);
          await card.getByTestId('tool-approval-allow').click();
          expect(receiptOf(await uploading)).toMatchObject({
            status: 'executed',
            upload: { status: 'attached' },
          });
          // A button leads to the hidden input it opens; the files go to the
          // input, so the step is recorded on it.
          const hiddenFile = workspaceFile(
            session.workspaceRoot,
            'exports/hidden.txt',
          );
          const hidden = run({
            type: 'browser.upload_files',
            locator: selector('browser-lab-upload-hidden-open'),
            files: [{ path: hiddenFile }],
          });
          await cardFor(card, hidden);
          await card.getByTestId('tool-approval-allow').click();
          expect(receiptOf(await hidden)).toMatchObject({
            status: 'executed',
            upload: { status: 'attached' },
          });

          expect(
            (
              await run({
                type: 'browser.navigate',
                url: `${origin}/browser-lab/downloads`,
              })
            ).ok,
          ).toBe(true);
          const clicked = await run({
            type: 'browser.click',
            locator: selector('browser-lab-downloads-attachment'),
          });
          expect(clicked.ok, JSON.stringify(clicked)).toBe(true);
          await pollTransfers(run, (transfers) =>
            transfers.find(
              (transfer) =>
                transfer.fileName === 'browser-lab-report.txt' &&
                transfer.status === 'complete',
            ),
          );
          const saved = await run({ type: 'browser.save_pdf' });
          expect(saved.ok, JSON.stringify(saved)).toBe(true);

          const stopped = await run({ type: 'browser.stop_recording' });
          expect(stopped.ok, JSON.stringify(stopped)).toBe(true);
          const recording = payloadOf(stopped).recording;
          const actions = recording?.steps.map((step) => step.action) ?? [];
          for (const action of ['upload', 'download', 'print'])
            expect(actions, `${kind}: ${JSON.stringify(actions)}`).toContain(
              action,
            );
          expect(
            actions.filter((action) => action === 'download'),
          ).toHaveLength(1);
          // The page's own change on the file input is not a fill.
          expect(actions).not.toContain('fill');
          const script = recording?.playwrightScript ?? '';
          expect(script).toMatch(/\.setInputFiles\(\["recorded\.txt"\]\);/);
          const hiddenStep = recording?.steps.find((step) =>
            step.values?.includes('hidden.txt'),
          );
          expect(hiddenStep?.playwright, script).toMatch(
            /browser-lab-upload-hidden-input|no replayable locator/,
          );
          expect(script).not.toMatch(
            /browser-lab-upload-hidden-open[^\n]*setInputFiles/,
          );
          const lines = script.split('\n');
          const wait = lines.findIndex((line) =>
            line.includes("page.waitForEvent('download')"),
          );
          const click = lines.findIndex((line) =>
            line.includes('browser-lab-downloads-attachment'),
          );
          expect(wait, script).toBeGreaterThanOrEqual(0);
          expect(click, script).toBeGreaterThan(wait);
          expect(
            lines.findIndex((line) => /await download\d+Promise/.test(line)),
            script,
          ).toBeGreaterThan(click);
          expect(script).toContain('await page.pdf({');
          expect(script).not.toContain('exports/');
          expectPathFree(stopped, `${kind}: stop_recording`, [
            userDataDir,
            session.workspaceRoot,
          ]);
          expect((await run({ type: 'browser.navigate', url })).ok).toBe(true);
        } finally {
          await endApprovalSession(electronApp, session.id);
        }
      },
      { routes: ['mcp', WORKTREE_ROUTE] },
    );
  });
});
