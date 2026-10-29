// @capture-keep: canonical worked example for changed-files visual comparisons
// @capture-reference: docs/development-workflow.md
// Run with: pnpm run test:electron:captures:built can-1700-changed-files-section.capture-spec.ts
// Color modes: run each documented stage normally for light, then append `--dark-mode` for dark.
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Locator, type TestInfo } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';

// CAN-1700 — desktop Changed Files activity-section visual captures.
// Run with CAN1700_STAGE=before and =after. Paired PNGs under
// .playwright/can-1700 should be pixel-identical.

const WORKTREE_BRANCH = 'demo-main';
const STAGE = process.env.CAN1700_STAGE === 'before' ? 'before' : 'after';
const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../..',
);
const captureDir = path.join(repoRoot, '.playwright', 'can-1700');
type Scenario = 'empty' | 'uncommitted' | 'committed' | 'mixed';

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'pipe' });
}

function seedScenario(worktreePath: string, scenario: Scenario): void {
  if (scenario === 'empty') return;
  appendFileSync(
    path.join(worktreePath, 'README.md'),
    `\nCAN-1700 ${scenario} tracked change\n`,
    'utf8',
  );
  if (scenario === 'uncommitted') return;
  git(worktreePath, 'add', 'README.md');
  git(
    worktreePath,
    '-c',
    'user.name=Canopy Test',
    '-c',
    'user.email=canopy@example.test',
    'commit',
    '-m',
    `CAN-1700 ${scenario} committed change`,
  );
  if (scenario === 'committed') return;
  writeFileSync(
    path.join(worktreePath, 'CAN_1700_MIXED.txt'),
    'CAN-1700 mixed uncommitted file\n',
    'utf8',
  );
}

async function capture(
  locator: Locator,
  name: string,
  testInfo: TestInfo,
): Promise<void> {
  mkdirSync(captureDir, { recursive: true });
  const filePath = path.join(captureDir, `${name}-${STAGE}.png`);
  await locator.screenshot({ path: filePath, animations: 'disabled' });
  await testInfo.attach(`${name}-${STAGE}`, {
    path: filePath,
    contentType: 'image/png',
  });
}

async function launchScenario(scenario: Scenario) {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), `canopy-electron-can1700-${scenario}-`),
  );
  try {
    const seed = seedDemoWorkspaces({
      userDataDir,
      apps: ['ts-pnpm-vite'],
      checkRuntimes: false,
    });
    const worktreePath = seed.workspaces[0]?.worktreePath;
    if (!worktreePath) {
      throw new Error(`Missing seeded worktree for ${scenario}`);
    }
    seedScenario(worktreePath, scenario);
    const { electronApp } = await launchCanopy({ userDataDir });
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_BRANCH);
    await expect(
      window.getByTestId('panel-content-activity-section'),
    ).toBeVisible();
    const changedFilesSection = window.getByTestId('changed-files-section');
    const section =
      scenario === 'empty'
        ? window.getByTestId('panel-content-activity-section')
        : changedFilesSection;
    if (scenario === 'empty') {
      await expect(changedFilesSection).toHaveCount(0);
    } else {
      await expect(changedFilesSection).toBeVisible();
      await expect(
        section.getByTestId('activity-changed-file').first(),
      ).toBeVisible({ timeout: 20_000 });
    }
    return { electronApp, window, section, userDataDir };
  } catch (error) {
    rmSync(userDataDir, { recursive: true, force: true });
    rmSync(`${userDataDir}-secure`, { recursive: true, force: true });
    throw error;
  }
}

test.describe('CAN-1700 Changed Files swap captures', () => {
  for (const scenario of [
    'empty',
    'uncommitted',
    'committed',
    'mixed',
  ] as const) {
    test(`${scenario} body`, async ({}, testInfo) => {
      const launched = await launchScenario(scenario);
      try {
        if (scenario === 'empty') {
          await expect(
            launched.section.getByTestId('activity-changed-files-empty'),
          ).toHaveCount(0);
          await expect(
            launched.section.getByTestId('view-change-diagram-button'),
          ).toHaveCount(0);
        } else {
          await expect(
            launched.section.getByTestId('view-change-diagram-button'),
          ).toBeVisible();
        }
        if (scenario === 'uncommitted') {
          await expect(
            launched.section.getByRole('heading', { name: 'Uncommitted' }),
          ).toHaveCount(0);
        }
        if (scenario === 'committed') {
          await expect(
            launched.section.getByRole('heading', {
              name: 'Committed',
              exact: true,
            }),
          ).toBeVisible();
        }
        if (scenario === 'mixed') {
          await expect(
            launched.section.getByRole('heading', { name: 'Uncommitted' }),
          ).toBeVisible();
          await expect(
            launched.section.getByRole('heading', {
              name: 'Committed',
              exact: true,
            }),
          ).toBeVisible();
        }
        await capture(launched.section, scenario, testInfo);
      } finally {
        await closeCanopy(launched.electronApp, launched.userDataDir);
      }
    });
  }

  test('row hover, revert modal, and View diagram CTA', async ({}, testInfo) => {
    const launched = await launchScenario('uncommitted');
    try {
      const row = launched.section.getByTestId('activity-changed-file').first();
      await row.hover();
      await expect(row.getByTestId('activity-file-revert')).toBeVisible();
      await capture(launched.section, 'row-hover-revert', testInfo);

      await row.getByTestId('activity-file-revert').click();
      const modal = launched.window.getByTestId('revert-confirm-modal');
      await expect(modal).toBeVisible();
      await expect(modal.getByTestId('revert-confirm-btn')).toBeVisible();
      await capture(modal, 'revert-confirm-modal', testInfo);
      await modal.getByRole('button', { name: 'Cancel' }).click();

      // The header CTA opens the Change Diagram workspace panel; the
      // full-screen Code Review takeover was retired.
      await launched.section.getByTestId('view-change-diagram-button').click();
      await expect(
        launched.window.getByTestId('panel-content-change-diagram'),
      ).toBeVisible();
    } finally {
      await closeCanopy(launched.electronApp, launched.userDataDir);
    }
  });
});
