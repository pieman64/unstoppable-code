// The first window must not wait on a project's git remote. A source-backed
// multi-repo project resolves its repo scripts from a default-branch checkout,
// which asks the remote for its HEAD (`git ls-remote`, up to 30s per call).
// Startup used to project the whole sidebar in a migration that runs before
// the main window, so on hosts where that call blocks (the self-hosted macOS
// pool), no window appeared and every spec seeding a github.com remote failed
// with "Timed out identifying the application window".
//
// Here the remote is a local server that answers 401, so git asks a
// credential helper, and the only helper blocks for longer than window
// identification waits. Offline and deterministic.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';

const DEMO_APP_ID = 'multi-repo-fullstack';

test.skip(
  process.platform === 'win32',
  'The blocking credential helper is a POSIX shell command.',
);

test('opens the main window while a project remote waits on credentials', async () => {
  test.setTimeout(180_000);
  const remote = http.createServer((_request, response) => {
    response.writeHead(401, { 'WWW-Authenticate': 'Basic realm="canopy-e2e"' });
    response.end();
  });
  await new Promise((resolve) => remote.listen(0, '127.0.0.1', resolve));
  const remoteAddress = remote.address();
  if (remoteAddress === null || typeof remoteAddress === 'string') {
    throw new Error('The credential-gated remote has no TCP port.');
  }
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-startup-remote-'),
  );
  let launched = null;
  try {
    const seed = seedDemoWorkspaces({ userDataDir, apps: [DEMO_APP_ID] });
    const workspace = seed.workspaces.find(
      (candidate) => candidate.id === `demo-${DEMO_APP_ID}`,
    );
    expect(workspace, 'seeded multi-repo project').toBeTruthy();
    execFileSync(
      'git',
      [
        '-C',
        workspace.worktreePath,
        'remote',
        'add',
        'origin',
        `http://127.0.0.1:${remoteAddress.port}/${DEMO_APP_ID}.git`,
      ],
      { stdio: ['ignore', 'ignore', 'pipe'] },
    );

    launched = await launchCanopy({
      userDataDir,
      env: {
        // Replace every configured helper (an empty value resets the list)
        // with one that never answers within the window-identification wait.
        GIT_CONFIG_COUNT: '2',
        GIT_CONFIG_KEY_0: 'credential.helper',
        GIT_CONFIG_VALUE_0: '',
        GIT_CONFIG_KEY_1: 'credential.helper',
        GIT_CONFIG_VALUE_1: '!sleep 60 #',
      },
    });
    const window = await launched.electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    // The sidebar's project read resolves repo scripts from a default-branch
    // checkout. Creating that checkout waits on the remote, so the read must
    // not: the project row appears while the credential helper still blocks.
    await expect(
      window.locator(`[data-sidebar-workspace-id="${workspace.id}"]`),
    ).toBeVisible({ timeout: 10_000 });
  } finally {
    if (launched !== null) {
      await closeCanopy(launched.electronApp, launched.userDataDir);
    }
    await new Promise((resolve) => remote.close(resolve));
    rmSync(userDataDir, { recursive: true, force: true });
  }
});
