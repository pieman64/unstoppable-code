import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { openProjectSettingsPage } from './projectSettingsDriver.mjs';

// Publishing a default-branch base used to run SQLite's full integrity scan
// twice on the Electron main thread; one scan of a 1.6 GB generation measured
// 52 seconds. The build worker now finalizes the staging database and main only
// renames it into place and swaps the manifest. This walks the Project
// Settings flow that triggers that publication and checks the installed
// generation it leaves behind.

const WORKSPACE_ID = 'demo-ts-pnpm-vite';
const WORKSPACE_NAME = 'TypeScript pnpm Vite';

function attachLocalOrigin(userDataDir, worktreePath) {
  const remotePath = path.join(userDataDir, 'origin.git');
  execFileSync('git', ['init', '--bare', remotePath], { stdio: 'ignore' });
  execFileSync('git', ['remote', 'add', 'origin', remotePath], {
    cwd: worktreePath,
  });
  execFileSync('git', ['push', '-u', 'origin', 'HEAD:main'], {
    cwd: worktreePath,
    stdio: 'ignore',
  });
  execFileSync('git', ['symbolic-ref', 'HEAD', 'refs/heads/main'], {
    cwd: remotePath,
  });
  return execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: worktreePath,
    encoding: 'utf8',
  }).trim();
}

function publishedBases(userDataDir) {
  const shadowsRoot = path.join(userDataDir, 'repo-shadows');
  if (!existsSync(shadowsRoot)) return [];
  return readdirSync(shadowsRoot).flatMap((shadow) => {
    const variantsRoot = path.join(shadowsRoot, shadow, 'code-graph');
    if (!existsSync(variantsRoot)) return [];
    return readdirSync(variantsRoot)
      .map((variant) => path.join(variantsRoot, variant))
      .filter((variantDir) => existsSync(path.join(variantDir, 'current.json')))
      .map((variantDir) => ({
        variantDir,
        ...JSON.parse(
          readFileSync(path.join(variantDir, 'current.json'), 'utf8'),
        ),
      }));
  });
}

test('Project Settings publishes a workspace code-graph base through worker finalization', async () => {
  test.setTimeout(240_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-electron-base-publication-'),
  );
  const seed = seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  const worktreePath = seed.workspaces.find(
    (workspace) => workspace.id === WORKSPACE_ID,
  )?.worktreePath;
  if (!worktreePath) {
    throw new Error(`Missing seeded worktree for ${WORKSPACE_ID}`);
  }
  const originHead = attachLocalOrigin(userDataDir, worktreePath);

  const launched = await launchCanopy({ userDataDir });
  try {
    const window = await launched.electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();

    await expect(app.workspaceHeaderLabel(WORKSPACE_NAME)).toBeVisible();
    await app.workspaceHeaderLabel(WORKSPACE_NAME).hover();
    await app.workspaceSettingsButton(WORKSPACE_NAME).click();
    const dialog = window.getByRole('dialog', { name: WORKSPACE_NAME });
    await expect(dialog).toBeVisible();
    await openProjectSettingsPage(app, 'code-graph');

    const panel = dialog.getByTestId('code-graph-summary');
    const build = dialog.getByTestId('code-graph-summary-build');
    await expect(build).toBeVisible({ timeout: 60_000 });
    await expect(build).toBeEnabled({ timeout: 180_000 });
    await build.click();

    // The summary lists repositories only for multi-repository workspaces;
    // the installed base generation is the durable result of the build.
    await expect
      .poll(() => publishedBases(userDataDir), { timeout: 180_000 })
      .toEqual([
        expect.objectContaining({
          repoId: '__workspace_root__',
          gitHead: originHead,
        }),
      ]);
    await expect(panel.getByTestId('code-graph-summary-details')).toBeVisible();
    await expect(
      panel.getByTestId('code-graph-metric-repositories'),
    ).toContainText('1');
    await expect(
      dialog.getByTestId('code-graph-summary-build-error'),
    ).toHaveCount(0);

    const [base] = publishedBases(userDataDir);
    expect(
      existsSync(
        path.join(base.variantDir, ...base.graphRelativePath.split('/')),
      ),
    ).toBe(true);
    const stagingDir = path.join(base.variantDir, 'staging');
    expect(existsSync(stagingDir) ? readdirSync(stagingDir) : []).toEqual([]);
  } finally {
    await closeCanopy(launched.electronApp, userDataDir);
  }
});
