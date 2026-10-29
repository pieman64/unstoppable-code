import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { closeCanopy, launchCanopyApp } from './launchCanopy.mjs';
import { DEFAULT_MOCK_BASE_URL } from './seeders/index.mjs';
import { chooseCloneDestination } from './helpers/add-project.mjs';
import { createControlledPortalClone } from './portal/cloneProgressFixture.mjs';

// Add project -> Remote -> GitHub: the repository picker.
//
// The picker is the list a signed-in user chooses a repository from before
// "Clone and add". This spec pins what a user can do with it today, through the
// real renderer, main process and Octokit client: only api.github.com is
// redirected (by the E2E build) to the shared credential-keyed REST mock, whose
// `/user/repos` answers with the repositories registered below. The clone URL
// of the repository to add is a local git repository, so choosing it and
// pressing "Clone and add" performs a real, offline clone and the cloned
// project's `origin` proves which repository the selection handed off.
//
// Behaviour pinned here, so a refactor of the picker's display cannot move it:
//   - the list shows every repository, with Private/Archived badges and the
//     description, and the search box filters by full name or description;
//   - an archived repository is badged but stays selectable;
//   - an empty search result and an empty account each have their own copy;
//   - rows are native buttons: they take Tab focus and select on Enter;
//   - "Clone and add" stays disabled until a repository is chosen, then clones
//     the chosen repository's clone URL into the destination.

const MOCK_BASE_URL = DEFAULT_MOCK_BASE_URL;
const TOKEN = 'ghp_e2e_repository_picker';
const EMPTY_TOKEN = 'ghp_e2e_repository_picker_empty';
const SOURCE_NAME = 'picker-source';

function createSourceRepository(root) {
  const sourceRepo = path.join(root, SOURCE_NAME);
  mkdirSync(sourceRepo, { recursive: true });
  execFileSync('/usr/bin/git', ['init', sourceRepo], { stdio: 'ignore' });
  writeFileSync(path.join(sourceRepo, 'README.md'), '# Picker source\n');
  execFileSync('/usr/bin/git', ['-C', sourceRepo, 'add', 'README.md']);
  execFileSync(
    '/usr/bin/git',
    [
      '-C',
      sourceRepo,
      '-c',
      'user.name=Canopy E2E',
      '-c',
      'user.email=e2e@canopy.test',
      'commit',
      '-m',
      'Initial commit',
    ],
    { stdio: 'ignore' },
  );
  return sourceRepo;
}

// The subset of GitHub's repository payload the desktop listing maps.
function githubRepository({
  id,
  name,
  description,
  isPrivate = false,
  archived = false,
  cloneUrl,
}) {
  return {
    id,
    name,
    full_name: `acme/${name}`,
    owner: { login: 'acme' },
    description,
    clone_url: cloneUrl ?? `https://github.com/acme/${name}.git`,
    ssh_url: `git@github.com:acme/${name}.git`,
    html_url: `https://github.com/acme/${name}`,
    private: isPrivate,
    fork: false,
    archived,
    default_branch: 'main',
    updated_at: '2026-01-01T00:00:00Z',
  };
}

async function registerRepositories(token, repos) {
  const response = await fetch(`${MOCK_BASE_URL}/__mock/state`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ key: token, scenario: { github: { repos } } }),
  });
  expect(response.ok).toBe(true);
}

async function clearScenario(token) {
  await fetch(`${MOCK_BASE_URL}/__mock/state/${encodeURIComponent(token)}`, {
    method: 'DELETE',
  }).catch(() => undefined);
}

async function openRemotePanel(window, app) {
  await app.openMainPage();
  // The add button is hover-revealed; the keyboard path avoids pointer flake.
  await window.getByTestId('sidebar-section-code-add').focus();
  await window.getByTestId('sidebar-section-code-add').press('Enter');
  await expect(
    window.getByRole('heading', { name: 'Add project' }),
  ).toBeVisible();
  await window.getByTestId('add-workspace-mode-remote').click();
  const panel = window.getByTestId('add-workspace-remote-panel');
  await expect(panel).toBeVisible();
  return panel;
}

test.describe('GitHub repository picker in Add project', () => {
  test.skip(process.platform === 'win32', 'POSIX git source repository');

  let fixtureRoot;
  let sourceRepo;
  let cloneRoot;
  let launched;

  // The token reaches the app through the environment, so the very first
  // permissions probe already sees it. Saving a token after launch would race
  // the renderer's permission cache, which is filled once at start-up.
  async function launchWithToken(token, env = {}) {
    launched = await launchCanopyApp({
      env: { ...env, GH_TOKEN: token },
      waitForShellOptions: { timeout: 30_000 },
    });
    return launched;
  }

  test.beforeEach(() => {
    fixtureRoot = mkdtempSync(path.join(os.tmpdir(), 'canopy-repo-picker-'));
    sourceRepo = createSourceRepository(fixtureRoot);
    cloneRoot = path.join(fixtureRoot, 'clones');
    mkdirSync(cloneRoot, { recursive: true });
  });

  test.afterEach(async () => {
    await Promise.all([clearScenario(TOKEN), clearScenario(EMPTY_TOKEN)]);
    if (launched) await closeCanopy(launched.electronApp, launched.userDataDir);
    launched = undefined;
    rmSync(fixtureRoot, { recursive: true, force: true });
  });

  test('searches, selects an archived repository, and clones the chosen repository', async () => {
    test.setTimeout(120_000);
    await registerRepositories(TOKEN, [
      githubRepository({
        id: 1,
        name: SOURCE_NAME,
        description: 'Source repository for the picker flow',
        isPrivate: true,
        cloneUrl: sourceRepo,
      }),
      githubRepository({
        id: 2,
        name: 'legacy-site',
        description: 'Frozen marketing site',
        archived: true,
        // Never cloned: handing off the wrong repository would fail loudly.
        cloneUrl: path.join(fixtureRoot, 'missing-legacy-site'),
      }),
      githubRepository({
        id: 3,
        name: 'docs-site',
        description: 'Public documentation',
        cloneUrl: path.join(fixtureRoot, 'missing-docs-site'),
      }),
    ]);
    const { window, app } = await launchWithToken(TOKEN);

    const panel = await openRemotePanel(window, app);
    const remote = window.getByTestId('add-workspace-mode-remote');
    const existing = window.getByTestId('add-workspace-mode-existing');
    await expect(remote).toHaveAttribute('aria-pressed', 'true');
    await existing.focus();
    await existing.press('Enter');
    await expect(existing).toHaveAttribute('aria-pressed', 'true');
    await expect(panel).not.toBeVisible();
    await remote.focus();
    await remote.press('Space');
    await expect(remote).toHaveAttribute('aria-pressed', 'true');
    await expect(panel).toBeVisible();
    const list = panel.getByTestId('add-workspace-github-repo-list');
    const search = panel.getByPlaceholder('Search your repositories');
    await expect(panel.getByText('Repository', { exact: true })).toBeVisible();
    await expect(search).toBeVisible();

    // Every repository is listed, with its badges and description.
    const rows = list.getByRole('button');
    await expect(rows).toHaveCount(3);
    const sourceRow = list.getByRole('button', {
      name: new RegExp(`acme/${SOURCE_NAME}`),
    });
    const legacyRow = list.getByRole('button', { name: /acme\/legacy-site/ });
    const docsRow = list.getByRole('button', { name: /acme\/docs-site/ });
    await expect(sourceRow).toContainText('Private');
    await expect(sourceRow).not.toContainText('Archived');
    await expect(sourceRow).toContainText('Source repository for the picker');
    await expect(legacyRow).toContainText('Archived');
    await expect(legacyRow).not.toContainText('Private');
    await expect(docsRow).not.toContainText('Private');
    await expect(docsRow).not.toContainText('Archived');

    // Nothing is chosen yet, so there is nothing to clone.
    const clone = panel.getByTestId('add-workspace-clone-submit');
    await expect(clone).toBeDisabled();

    // Search matches the full name...
    await search.fill('docs');
    await expect(rows).toHaveCount(1);
    await expect(docsRow).toBeVisible();
    // ...or the description, ignoring case...
    await search.fill('FROZEN');
    await expect(rows).toHaveCount(1);
    await expect(legacyRow).toBeVisible();
    // ...and a search with no match says so, quoting what was typed.
    await search.fill('zzz');
    await expect(rows).toHaveCount(0);
    await expect(list).toContainText('No matches for “zzz”.');
    await expect(list).not.toContainText('No repositories returned');

    // Clearing the search restores the list. An archived repository is only
    // badged: it can still be chosen.
    await search.fill('');
    await expect(rows).toHaveCount(3);
    await legacyRow.click();
    await search.focus();
    await window.mouse.move(0, 0);
    await expect(legacyRow).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
    await expect(
      legacyRow.locator('[data-picker-selected-check="true"] svg'),
    ).toBeVisible();
    await expect(legacyRow).toHaveAttribute('aria-pressed', 'true');
    await expect(
      sourceRow.locator('[data-picker-selected-check="true"]'),
    ).toHaveCount(0);
    await expect(sourceRow).toHaveAttribute('aria-pressed', 'false');
    await expect(clone).toBeEnabled();

    // Rows are native buttons: focus and Enter choose, and the choice moves.
    await sourceRow.focus();
    await expect(sourceRow).toBeFocused();
    await sourceRow.press('Enter');
    await expect(
      sourceRow.locator('[data-picker-selected-check="true"] svg'),
    ).toBeVisible();
    await expect(sourceRow).toHaveAttribute('aria-pressed', 'true');
    await expect(
      legacyRow.locator('[data-picker-selected-check="true"]'),
    ).toHaveCount(0);
    await expect(legacyRow).toHaveAttribute('aria-pressed', 'false');
    // The choice survives a search that hides it and brings it back.
    await search.fill('docs');
    await expect(rows).toHaveCount(1);
    await search.fill('');
    await expect(
      sourceRow.locator('[data-picker-selected-check="true"] svg'),
    ).toBeVisible();

    // Moving focus and the pointer away leaves only the selection check.
    await search.focus();
    await window.mouse.move(0, 0);
    await expect(sourceRow).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');

    // "Clone and add" hands the chosen repository's clone URL to the clone.
    await chooseCloneDestination(launched.electronApp, window, cloneRoot);
    await clone.click();
    await expect(
      window.getByRole('heading', { name: 'Add project' }),
    ).toHaveCount(0, { timeout: 60_000 });
    const clonedPath = path.join(cloneRoot, SOURCE_NAME);
    await expect
      .poll(() => existsSync(path.join(clonedPath, 'README.md')))
      .toBe(true);
    const origin = execFileSync(
      '/usr/bin/git',
      ['-C', clonedPath, 'remote', 'get-url', 'origin'],
      { encoding: 'utf8' },
    ).trim();
    expect(origin).toBe(sourceRepo);
    await expect(
      window
        .getByTestId('sidebar-section-code')
        .getByRole('button', { name: `Collapse ${SOURCE_NAME}` }),
    ).toBeVisible({ timeout: 30_000 });
  });

  test('CAN-4342: a GitHub-source clone failure shows safe recovery copy', async () => {
    test.setTimeout(120_000);
    const clone = createControlledPortalClone();
    try {
      await registerRepositories(TOKEN, [
        githubRepository({
          id: 1,
          name: clone.name,
          description: 'Controlled failure',
          cloneUrl: clone.remoteUrl,
        }),
      ]);
      clone.release({ fail: true });
      const { window, app } = await launchWithToken(TOKEN, clone.env);
      const panel = await openRemotePanel(window, app);
      await panel
        .getByTestId('add-workspace-github-repo-list')
        .getByRole('button')
        .click();
      await chooseCloneDestination(launched.electronApp, window, cloneRoot);
      await panel.getByTestId('add-workspace-clone-submit').click();
      const error = window.getByTestId('add-workspace-error');
      await expect(error).toHaveText(
        'Failed to clone the repository. Check the URL and access, then try again.',
      );
      await expect(error).toHaveAttribute('role', 'alert');
      await expect(error).not.toContainText('fatal:');
      await expect(error).not.toContainText(clone.remoteUrl);
    } finally {
      clone.release();
      if (launched)
        await closeCanopy(launched.electronApp, launched.userDataDir);
      launched = undefined;
      clone.dispose();
    }
  });

  test('says so when GitHub returns no repositories', async () => {
    test.setTimeout(120_000);
    await registerRepositories(EMPTY_TOKEN, []);
    const { window, app } = await launchWithToken(EMPTY_TOKEN);

    const panel = await openRemotePanel(window, app);
    const list = panel.getByTestId('add-workspace-github-repo-list');
    await expect(list).toContainText('No repositories returned from GitHub.');
    await expect(list.getByRole('button')).toHaveCount(0);
    await expect(list).not.toContainText('No matches for');
    await expect(
      panel.getByTestId('add-workspace-clone-submit'),
    ).toBeDisabled();

    // The search box stays available, and an empty account is still "no
    // repositories", not "no matches": the copy follows the total, not the
    // search.
    await panel.getByPlaceholder('Search your repositories').fill('anything');
    await expect(list).toContainText('No repositories returned from GitHub.');
    await expect(list).not.toContainText('No matches for');
  });
});
