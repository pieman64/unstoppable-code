import { readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { startExternalOpenCapture } from './fixtures/external-open-capture.mjs';
import { expect, test } from '@playwright/test';
import { launchCanopy, closeCanopy } from './launchCanopy.mjs';
import { CanopyAppDriver, expandDefaultActivityRail } from './canopyApp.mjs';
import { collectLeaves, getLayout } from './panelHarness.mjs';
import {
  seedAutoOpenProject,
  openAutoOpenSettings,
  PROJECT_ID,
  WORKTREE_ID,
  BACKGROUND_WORKTREE_ID,
  PATTERN,
} from './dev-server-auto-open-fixture.mjs';
import {
  injectScriptRunEvent,
  injectScriptOutputEvent,
  seedScriptRun,
} from './seeders/index.mjs';

function readConfig(configPath) {
  try {
    return JSON.parse(readFileSync(configPath, 'utf8'));
  } catch {
    return null;
  }
}

test('legacy pattern shows its browser destination and manual open', async () => {
  const fixture = seedAutoOpenProject();
  const { electronApp } = await launchCanopy({
    userDataDir: fixture.userDataDir,
  });
  try {
    const window = await electronApp.firstWindow();
    const { dialog, editor } = await openAutoOpenSettings(window);
    await expect(editor.getByRole('button', { name: /^In / })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await dialog.getByRole('button', { name: 'Close', exact: true }).click();
    await injectScriptRunEvent(electronApp, {
      projectId: PROJECT_ID,
      worktreeId: WORKTREE_ID,
      script: { devServerPattern: PATTERN },
      outputLines: ['http://localhost:3179/'],
    });
    await expect(window.getByTestId('panel-content-browser')).toHaveCount(0);
    await window
      .getByRole('button', {
        name: 'Open dev server http://localhost:3179/',
        exact: true,
      })
      .first()
      .click();
    await expect(window.getByTestId('panel-content-browser')).toBeVisible();
    await expect(window.getByTestId('browser-url-input')).toHaveValue(
      'http://localhost:3179/',
    );
  } finally {
    await closeCanopy(electronApp, fixture.userDataDir);
    rmSync(fixture.fixtureDir, { recursive: true, force: true });
  }
});

// Opening a dev server from the Scripts panel focuses the Activity group
// first. The Browser tab must still land where a pipeline run opened from the
// Activity list does (the most recently used chat group), never beside the
// Scripts panel that was clicked.
test('Open from the Scripts panel places the browser like a pipeline run', async () => {
  const fixture = seedAutoOpenProject();
  const { electronApp } = await launchCanopy({
    userDataDir: fixture.userDataDir,
  });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_ID);
    await expandDefaultActivityRail(window);
    await injectScriptRunEvent(electronApp, {
      projectId: PROJECT_ID,
      worktreeId: WORKTREE_ID,
      // The configured Launch script's key, so the run (and its Open
      // button) renders in that script's Scripts panel row.
      script: { scriptKey: 'project:launch', devServerPattern: PATTERN },
      outputLines: ['http://localhost:3194/'],
    });
    const activity = window.getByTestId('panel-content-activity-section');
    await activity
      .getByRole('button', {
        name: 'Open dev server http://localhost:3194/',
        exact: true,
      })
      .first()
      .click();
    await expect(window.getByTestId('panel-content-browser')).toBeVisible();
    const leaves = collectLeaves((await getLayout(window))?.root);
    const browserLeaf = leaves.find((leaf) =>
      leaf.panels.some((panel) => panel.kind === 'browser'),
    );
    expect(
      browserLeaf?.panels.some((panel) => panel.kind === 'activity-section'),
    ).toBe(false);
    expect(browserLeaf?.panels.some((panel) => panel.kind === 'chat')).toBe(
      true,
    );
  } finally {
    await closeCanopy(electronApp, fixture.userDataDir);
    rmSync(fixture.fixtureDir, { recursive: true, force: true });
  }
});

test('auto-open toggle saves to canopy.json and reloads in project settings', async () => {
  const fixture = seedAutoOpenProject();
  const { electronApp } = await launchCanopy({
    userDataDir: fixture.userDataDir,
  });
  try {
    const window = await electronApp.firstWindow();
    let settings = await openAutoOpenSettings(window);
    const toggle = settings.editor.getByTestId('dev-server-pattern-auto-open');
    await expect(toggle).toHaveAttribute('aria-checked', 'false');
    await toggle.click();
    await settings.editor
      .getByRole('button', { name: 'External', exact: true })
      .click();
    await settings.dialog
      .getByRole('button', { name: 'Add to worktree', exact: true })
      .click();
    await expect(settings.dialog).not.toBeVisible();
    await expect
      .poll(
        () => readConfig(fixture.configPath)?.scripts?.launch?.devServerPattern,
      )
      .toEqual({ pattern: PATTERN, openTarget: 'external', autoOpen: true });
    settings = await openAutoOpenSettings(window);
    await expect(
      settings.editor.getByTestId('dev-server-pattern-auto-open'),
    ).toHaveAttribute('aria-checked', 'true');
    await settings.editor.getByTestId('dev-server-pattern-auto-open').click();
    await settings.dialog
      .getByRole('button', { name: 'Add to worktree', exact: true })
      .click();
    await expect
      .poll(
        () => readConfig(fixture.configPath)?.scripts?.launch?.devServerPattern,
      )
      .toEqual({ pattern: PATTERN, openTarget: 'external' });
    settings = await openAutoOpenSettings(window);
    await settings.dialog
      .getByRole('button', { name: 'Local override', exact: true })
      .click();
    const localEditor = settings.dialog
      .getByText('Launch script', { exact: true })
      .locator('xpath=../..');
    await localEditor.locator('textarea').fill('npm run local-dev');
    await localEditor
      .getByRole('button', { name: 'Add pattern', exact: true })
      .click();
    await localEditor.getByLabel('Pattern', { exact: true }).fill(PATTERN);
    await localEditor.getByTestId('dev-server-pattern-auto-open').click();
    await settings.dialog
      .getByRole('button', { name: 'Save local', exact: true })
      .click();
    const localConfigPath = path.join(
      fixture.userDataDir,
      'workspaces',
      PROJECT_ID,
      'workspace.json',
    );
    await expect
      .poll(
        () => readConfig(localConfigPath)?.scripts?.launch?.devServerPattern,
      )
      .toEqual({ pattern: PATTERN, autoOpen: true });
  } finally {
    await closeCanopy(electronApp, fixture.userDataDir);
    rmSync(fixture.fixtureDir, { recursive: true, force: true });
  }
});

test('live auto-open follows each destination once and ignores restored output', async () => {
  const fixture = seedAutoOpenProject();
  const externalCapture = await startExternalOpenCapture();
  const inApp = { pattern: PATTERN, autoOpen: true };
  seedScriptRun({
    userDataDir: fixture.userDataDir,
    workspaceId: PROJECT_ID,
    worktreeId: WORKTREE_ID,
    status: 'success',
    script: { scriptKey: 'project:old', devServerPattern: inApp },
    outputLines: ['http://localhost:3190/'],
  });
  const { electronApp } = await launchCanopy({
    userDataDir: fixture.userDataDir,
    env: externalCapture.env,
  });
  try {
    const window = await electronApp.firstWindow();
    const { dialog } = await openAutoOpenSettings(window);
    await dialog.getByRole('button', { name: 'Close', exact: true }).click();
    const restored = await window.evaluate(
      ({ projectId, worktreeId }) =>
        window.api.loadWorktreeScriptRuns({
          projectId,
          worktreeId,
          maxLines: 10,
        }),
      { projectId: PROJECT_ID, worktreeId: WORKTREE_ID },
    );
    expect(
      restored.find((run) => run.script.scriptKey === 'project:old'),
    ).toMatchObject({
      script: { devServerPattern: inApp },
      outputLines: ['http://localhost:3190/'],
    });
    await expect(window.getByTestId('panel-content-browser')).toHaveCount(0);
    const script = { scriptKey: 'project:live', devServerPattern: inApp };
    await injectScriptRunEvent(electronApp, {
      projectId: PROJECT_ID,
      worktreeId: WORKTREE_ID,
      script,
      outputLines: ['http://localhost:3191/'],
    });
    await expect(window.getByTestId('panel-content-browser')).toBeVisible();
    await expect(window.getByTestId('browser-url-input')).toHaveValue(
      'http://localhost:3191/',
    );
    await injectScriptOutputEvent(electronApp, {
      projectId: PROJECT_ID,
      worktreeId: WORKTREE_ID,
      script,
      outputLines: ['http://localhost:3191/'],
    });
    await expect(window.getByTestId('panel-content-browser')).toHaveCount(1);
    const external = {
      scriptKey: 'project:external',
      devServerPattern: {
        pattern: PATTERN,
        autoOpen: true,
        openTarget: 'external',
      },
    };
    await injectScriptRunEvent(electronApp, {
      projectId: PROJECT_ID,
      worktreeId: WORKTREE_ID,
      script: external,
      outputLines: ['http://localhost:3192/'],
    });
    await expect
      .poll(() => externalCapture.opened)
      .toEqual(['http://localhost:3192/']);
    await injectScriptOutputEvent(electronApp, {
      projectId: PROJECT_ID,
      worktreeId: WORKTREE_ID,
      script: external,
      outputLines: ['http://localhost:3192/'],
    });
    await expect(window.getByTestId('browser-url-input')).toHaveValue(
      'http://localhost:3191/',
    );
    expect(externalCapture.opened).toEqual(['http://localhost:3192/']);
  } finally {
    await closeCanopy(electronApp, fixture.userDataDir);
    await externalCapture.close();
    rmSync(fixture.fixtureDir, { recursive: true, force: true });
  }
});

test('auto-opens for an unvisited background worktree without changing selection', async () => {
  const fixture = seedAutoOpenProject();
  const { electronApp } = await launchCanopy({
    userDataDir: fixture.userDataDir,
  });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_ID);
    await injectScriptRunEvent(electronApp, {
      projectId: PROJECT_ID,
      worktreeId: BACKGROUND_WORKTREE_ID,
      script: {
        scriptKey: 'project:background',
        devServerPattern: { pattern: PATTERN, autoOpen: true },
      },
      outputLines: ['http://localhost:3193/'],
    });
    await expect(window.getByTestId('panel-content-browser')).toHaveCount(0);
    await window.waitForTimeout(11_000);
    await expect(window.getByTestId('panel-content-browser')).toHaveCount(0);
    await expect(
      window.locator('[data-sidebar-selected-item]').filter({
        has: window.locator(
          `[data-testid="worktree-row"][data-worktree-id="${WORKTREE_ID}"]`,
        ),
      }),
    ).toHaveCount(1);
    await app.selectWorktree(BACKGROUND_WORKTREE_ID);
    await window.getByRole('tab', { name: /localhost:3193/ }).click();
    await expect(window.getByTestId('panel-content-browser')).toBeVisible();
    await expect(window.getByTestId('browser-url-input')).toHaveValue(
      'http://localhost:3193/',
    );
  } finally {
    await closeCanopy(electronApp, fixture.userDataDir);
    rmSync(fixture.fixtureDir, { recursive: true, force: true });
  }
});
