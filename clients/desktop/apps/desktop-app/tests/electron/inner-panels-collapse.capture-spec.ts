// @capture-keep: reusable nine-panel topology comparison without benchmark work
// @capture-reference: scripts/lib/electron-capture-runner.test.mjs
// Inner sibling collapse: paired, deterministic screenshots of the user's
// nine-panel topology. Idle seeded terminals and one idle chat; no live agents.
// Build each tree with pnpm run build:e2e, then run:
// INNER_PANELS_STAGE=before pnpm run test:electron:captures:built inner-panels-collapse.capture-spec.ts --reporter=line
// INNER_PANELS_STAGE=after pnpm run test:electron:captures:built inner-panels-collapse.capture-spec.ts --reporter=line
// Run both stages again with --dark-mode. The runner owns color-mode selection.
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { seedPanelWorktree } from './panelHarness.mjs';
import { seedInnerPanelLayout } from './seeders/seedInnerPanelLayout.mjs';
import { closeCanopy } from './launchCanopy.mjs';

const STAGE = process.env.INNER_PANELS_STAGE === 'before' ? 'before' : 'after';
const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../..',
);
const captureDir = path.join(repoRoot, '.playwright', 'inner-panels');

test('inner sibling collapse evidence', async () => {
  mkdirSync(captureDir, { recursive: true });
  const userDataDir = seedInnerPanelLayout();
  const { electronApp, window } = await seedPanelWorktree({
    userDataDir,
    seedDemoWorkspaces: false,
    viewportSize: { width: 1900, height: 1050 },
  });
  try {
    const grid = window.getByTestId('panel-grid-root');
    await expect(window.getByTestId('panel-group-inner-C')).toBeVisible();
    await grid.screenshot({
      path: path.join(captureDir, `expanded-${STAGE}.png`),
      animations: 'disabled',
    });
    for (const id of ['B', 'F']) {
      const button = window.getByTestId(`panel-group-collapse-inner-${id}`);
      if (STAGE === 'after') {
        await button.click();
        await expect(
          window.getByTestId(`panel-collapsed-bar-inner-${id}`),
        ).toBeVisible();
      } else {
        await expect(button).toHaveCount(0);
      }
    }
    await window.mouse.move(0, 0);
    await expect(window.getByRole('tooltip')).toHaveCount(0);
    await grid.screenshot({
      path: path.join(captureDir, `collapsed-${STAGE}.png`),
      animations: 'disabled',
    });
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
