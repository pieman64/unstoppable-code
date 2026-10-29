// @capture-keep: reusable proof that the native hit-test fix preserves layout
// @capture-reference: apps/desktop-app/tests/electron/pipeline-chat-drawer.spec.mjs
/**
 * PR #3418 — Pipeline Assistant controls inside the macOS drag region.
 *
 * The production change only affects native hit testing, so the paired images
 * are expected to remain visually identical. They verify that the surrounding
 * Pipeline Assistant layout is unchanged in both color modes; the durable
 * `pipeline-chat-drawer.spec.mjs` separately verifies the computed
 * `-webkit-app-region` behavior that screenshots cannot expose.
 *
 * Run each stage against its corresponding E2E build:
 *
 *   PIPELINE_ASSISTANT_DRAG_STAGE=before pnpm run test:electron:captures:built pipeline-assistant-drag-region.capture-spec.ts --reporter=line
 *   PIPELINE_ASSISTANT_DRAG_STAGE=before pnpm run test:electron:captures:built pipeline-assistant-drag-region.capture-spec.ts --reporter=line --dark-mode
 *   # apply the change, then rebuild with `pnpm run build:e2e`
 *   PIPELINE_ASSISTANT_DRAG_STAGE=after pnpm run test:electron:captures:built pipeline-assistant-drag-region.capture-spec.ts --reporter=line
 *   PIPELINE_ASSISTANT_DRAG_STAGE=after pnpm run test:electron:captures:built pipeline-assistant-drag-region.capture-spec.ts --reporter=line --dark-mode
 *
 * Deterministic: the stored pipeline and isolated user-data directory are
 * seeded locally before launch. No live agents or network access are used.
 * Artifacts land in `.playwright/pipeline-assistant-drag-region/` (gitignored).
 */
import { mkdirSync, mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedStoredPipeline } from './seeders/seedStoredPipeline.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';

const STAGE =
  process.env.PIPELINE_ASSISTANT_DRAG_STAGE === 'before' ? 'before' : 'after';
const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../..',
);
const captureDir = path.join(
  repoRoot,
  '.playwright',
  'pipeline-assistant-drag-region',
);

test('captures the Pipeline Assistant expanded and collapsed', async () => {
  test.setTimeout(120_000);
  mkdirSync(captureDir, { recursive: true });
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-pipeline-assistant-drag-capture-'),
  );
  seedStoredPipeline({
    userDataDir,
    id: 'pipeline-assistant-drag-capture',
    name: 'Pipeline Assistant Capture',
    yaml: [
      'name: Pipeline Assistant Capture',
      'on: dispatch',
      'jobs:',
      '  review:',
      '    steps:',
      '      - run: echo review',
      '',
    ].join('\n'),
  });
  const { electronApp } = await launchCanopy({ userDataDir });

  try {
    const window = await electronApp.firstWindow();
    await window.setViewportSize({ width: 1400, height: 900 });
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openPipelinesPage();

    const surface = window.getByTestId('page-pipelines-root');
    const drawer = window.getByTestId('pipeline-chat-drawer');
    const collapse = window.getByTestId('pipeline-chat-collapse');
    await expect(surface).toBeVisible();
    await expect(drawer).toBeVisible();
    await expect(collapse).toBeVisible();

    await surface.screenshot({
      path: path.join(captureDir, `assistant-expanded-${STAGE}.png`),
      animations: 'disabled',
    });

    await collapse.click();
    await expect(drawer).toHaveCount(0);
    await expect(window.getByTestId('pipeline-chat-toggle')).toBeVisible();
    await surface.screenshot({
      path: path.join(captureDir, `assistant-collapsed-${STAGE}.png`),
      animations: 'disabled',
    });
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
