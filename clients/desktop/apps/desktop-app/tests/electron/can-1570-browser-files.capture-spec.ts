// @capture-keep: paired before/after evidence for the CAN-1570 browser Files panel
// @capture-reference: docs/planning/2026-10-06-can-1570-browser-interactions/phases/phase-07-downloads.md
// CAN-1570 phase 07a — capture the in-app browser bar and inspector around the
// Downloads Files panel change.
//
// Run each stage in light mode, then add `--dark-mode` for dark mode:
//   CAN_1570_FILES_STAGE=before pnpm run test:electron:captures:built can-1570-browser-files.capture-spec.ts
//   CAN_1570_FILES_STAGE=after pnpm run test:electron:captures:built can-1570-browser-files.capture-spec.ts
// Phase 07b captures a finished download's row on the 07a build
// (`copy-before`) and on the 07b build, with a copy saved from it
// (`copy-after`).
//
// Determinism: the standard panel harness seeds a disposable demo worktree; the
// Browser Lab downloads case is served from paired loopback listeners. No live
// agents or external services are involved. The stage defaults to `before` so
// the unchanged phase 06 build never touches the future Files test IDs.

import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type ElectronApplication } from '@playwright/test';
import type { Dialog } from 'electron';
import { closeCanopy } from './launchCanopy.mjs';
import { listenPairedBrowserLabServers } from './mock-server/routes/browser-lab.mjs';
import { seedPanelWorktree, seedVisibleBrowserPanel } from './panelHarness.mjs';

const STAGES = ['before', 'after', 'copy-before', 'copy-after'] as const;
const STAGE =
  STAGES.find((stage) => stage === process.env.CAN_1570_FILES_STAGE) ??
  'before';
const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../..',
);
const captureDir = path.join(repoRoot, '.playwright', 'can-1570');

const OWNER = { projectId: 'demo-ts-pnpm-vite', worktreeId: 'demo-main' };

test('captures the in-app browser bar and inspector for Downloads', async () => {
  test.setTimeout(120_000);
  mkdirSync(captureDir, { recursive: true });

  const lab = await listenPairedBrowserLabServers();
  try {
    const launched = await seedPanelWorktree();
    const { electronApp, userDataDir, window } = launched;
    try {
      const url = `${lab.primary.origin}/browser-lab/downloads#can-1570-downloads`;
      const { browser } = await seedVisibleBrowserPanel(window, {
        ...OWNER,
        url,
      });
      const pane = window.getByTestId(`browser-pane-${browser.id}`);
      await expect(pane).toBeVisible();
      await expect(pane).toHaveAttribute('data-browser-state', 'live', {
        timeout: 30_000,
      });
      await waitForBrowserLabTestId(
        electronApp,
        url,
        'browser-lab-downloads-main',
      );

      await pane.getByTestId('browser-more').click();
      await window.getByTestId('browser-more-details').click();
      const inspector = pane.getByRole('tablist', {
        name: 'Browser details',
      });
      await expect(inspector).toBeVisible();
      await expect(
        inspector.getByRole('tab', { name: 'Console' }),
      ).toHaveAttribute('aria-selected', 'true');
      await window.waitForTimeout(250);

      if (STAGE === 'copy-before' || STAGE === 'copy-after') {
        await pane.getByTestId('browser-inspector-tab-files').click();
        await expect(pane.getByTestId('browser-files-panel')).toBeVisible();
        await clickBrowserLabTestId(
          electronApp,
          url,
          'browser-lab-downloads-attachment',
        );
        await expect(window.getByTestId('browser-download-toast')).toBeVisible({
          timeout: 30_000,
        });
        const row = pane
          .locator('[data-testid^="browser-transfer-row-"]')
          .first();
        await expect(row).toContainText('Downloaded');
        await window.waitForTimeout(250);
        const before = STAGE === 'copy-before';
        await pane.screenshot({
          path: path.join(
            captureDir,
            `browser-files-row-desktop-${before ? 'before' : 'after'}.png`,
          ),
          animations: 'disabled',
        });
        if (!before) {
          const chosen = path.join(userDataDir, 'chosen', 'report-copy.txt');
          mkdirSync(path.dirname(chosen), { recursive: true });
          await electronApp.evaluate(
            ({ dialog }: { dialog: Dialog }, target: string) => {
              dialog.showSaveDialog = (): ReturnType<
                Dialog['showSaveDialog']
              > => Promise.resolve({ canceled: false, filePath: target });
            },
            chosen,
          );
          await pane
            .locator('[data-testid^="browser-transfer-save-copy-"]')
            .first()
            .click();
          await expect(
            pane
              .locator('[data-testid^="browser-transfer-row-"]')
              .filter({ hasText: 'report-copy.txt' }),
          ).toContainText('Copied', { timeout: 30_000 });
          expect(readFileSync(chosen, 'utf8')).toBe(
            'Browser Lab attachment report\n',
          );
          await window.waitForTimeout(250);
          await pane.screenshot({
            path: path.join(captureDir, 'browser-files-copy-desktop-after.png'),
            animations: 'disabled',
          });
        }
      } else if (STAGE === 'before') {
        await pane.getByTestId('browser-bar').screenshot({
          path: path.join(captureDir, `browser-bar-desktop-${STAGE}.png`),
          animations: 'disabled',
        });
        await pane.screenshot({
          path: path.join(captureDir, `browser-files-desktop-${STAGE}.png`),
          animations: 'disabled',
        });
      } else {
        await expect(pane.getByTestId('browser-files-button')).toBeVisible();
        const filesTab = pane.getByTestId('browser-inspector-tab-files');
        await expect(filesTab).toBeVisible();
        await filesTab.click();

        const filesPanel = pane.getByTestId('browser-files-panel');
        await expect(filesPanel).toBeVisible();
        await expect(pane.getByTestId('browser-files-empty')).toBeVisible();
        await window.waitForTimeout(250);
        await pane.getByTestId('browser-bar').screenshot({
          path: path.join(captureDir, `browser-bar-desktop-${STAGE}.png`),
          animations: 'disabled',
        });
        await pane.screenshot({
          path: path.join(captureDir, `browser-files-desktop-${STAGE}.png`),
          animations: 'disabled',
        });

        await clickBrowserLabTestId(
          electronApp,
          url,
          'browser-lab-downloads-attachment',
        );
        const transferRow = pane
          .locator('[data-testid^="browser-transfer-row-"]')
          .first();
        await expect(transferRow).toBeVisible({ timeout: 30_000 });
        await expect(transferRow).toContainText('browser-lab-report.txt');
        // The completion toast is the event-level signal that the row has
        // reached its completed state, rather than merely being in progress.
        await expect(window.getByTestId('browser-download-toast')).toBeVisible({
          timeout: 30_000,
        });
        await window.waitForTimeout(250);
        await pane.screenshot({
          path: path.join(
            captureDir,
            `browser-files-complete-desktop-${STAGE}.png`,
          ),
          animations: 'disabled',
        });
      }
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  } finally {
    await lab.close();
  }
});

async function evaluateBrowserLab(
  electronApp: ElectronApplication,
  url: string,
  expression: string,
): Promise<unknown> {
  return electronApp.evaluate(
    async ({ webContents }, input) => {
      const browserView = webContents
        .getAllWebContents()
        .find((contents) => contents.getURL() === input.url);
      if (!browserView) return null;
      return browserView.executeJavaScript(input.expression);
    },
    { url, expression },
  );
}

async function waitForBrowserLabTestId(
  electronApp: ElectronApplication,
  url: string,
  testId: string,
): Promise<void> {
  const selector = `[data-testid="${testId}"]`;
  await expect
    .poll(
      async () =>
        (await evaluateBrowserLab(
          electronApp,
          url,
          `Boolean(document.querySelector(${JSON.stringify(selector)}))`,
        )) === true,
      { timeout: 30_000 },
    )
    .toBe(true);
}

async function clickBrowserLabTestId(
  electronApp: ElectronApplication,
  url: string,
  testId: string,
): Promise<void> {
  const selector = `[data-testid="${testId}"]`;
  const clicked = await evaluateBrowserLab(
    electronApp,
    url,
    `(() => {
      const target = document.querySelector(${JSON.stringify(selector)});
      if (!(target instanceof HTMLElement)) return false;
      target.click();
      return true;
    })()`,
  );
  expect(clicked).toBe(true);
}
