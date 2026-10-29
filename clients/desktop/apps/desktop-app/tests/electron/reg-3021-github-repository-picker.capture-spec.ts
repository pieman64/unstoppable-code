// @capture-keep: REG-3021 desktop evidence for the shared GitHub repository picker, paired with the web capture until the C3 report ships
// @capture-reference: docs/ui-automation.md
// Run with: REG3021_STAGE=before pnpm run test:electron:captures:built reg-3021-github-repository-picker.capture-spec.ts --reporter=line
// Color modes: run each stage normally for light, then append `--dark-mode` for dark.
// PR selection review: set REG3021_CAPTURE_SLUG=reg-3021-pr-comments and run
// before/after stages to compare the accent selection with the Central checkmark.
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { closeCanopy, launchCanopyApp } from './launchCanopy.mjs';
import { DEFAULT_MOCK_BASE_URL } from './seeders/index.mjs';

// REG-3021 (Cloud Git 5/10), task B3: visual baseline for the desktop Add
// project -> Remote -> GitHub repository picker.
//
// What changed: the picker's display moves into `@canopy/ui-shared`
// (`GitHubRepositoryPicker`) behind a thin desktop wrapper, so the web Add
// project dialog can mount the same component. The consolidation commit has no
// intended visual change, so the `before` stage (the original desktop
// component) and the `after-extraction` stage (the shared component) must match
// pixel for pixel. The behavior commit that follows (accessibility, paging,
// disabled reasons) captures `after`. Stages:
//
//   before            the desktop component, before extraction
//   after-extraction  the shared component behind the desktop wrapper
//   after             the shared component with the cloud behavior changes
//
//   REG3021_STAGE=before pnpm run test:electron:captures:built reg-3021-github-repository-picker.capture-spec.ts --reporter=line
//   REG3021_STAGE=before pnpm run test:electron:captures:built reg-3021-github-repository-picker.capture-spec.ts --reporter=line --dark-mode
//   # apply the change, rebuild with `pnpm run build:e2e` (or use `test:electron:captures`), then
//   REG3021_STAGE=after-extraction pnpm run test:electron:captures:built reg-3021-github-repository-picker.capture-spec.ts --reporter=line
//   REG3021_STAGE=after-extraction pnpm run test:electron:captures:built reg-3021-github-repository-picker.capture-spec.ts --reporter=line --dark-mode
//
// The stage defaults to `after`. The durable flow coverage is
// `github-repository-picker.spec.mjs`; this spec is visual evidence only.
//
// Deterministic: no live agents and no network. The E2E build redirects
// api.github.com to the shared REST mock, which serves the fake repositories
// registered below to a token the app reads from its environment, so the first
// permissions probe already allows listing. The picker (label, search box and
// list) is screenshotted as an element with animations disabled and the caret
// hidden, after the state it captures is asserted. Output:
// `.playwright/REG-3021/github-repository-picker-desktop-<state>-<stage>-<mode>.png`
// (gitignored; the platform is part of every file name and the runner appends
// the colour mode). The `after` stage also shoots the whole dialog with an
// archived repository chosen
// (`add-project-dialog-desktop-remote-github-after-<mode>.png`), the desktop
// counterpart of the web Add project captures in the same report.

const STAGES = ['before', 'after-extraction', 'after'] as const;
type Stage = (typeof STAGES)[number];

function resolveStage(value: string | undefined): Stage {
  return STAGES.find((stage) => stage === value) ?? 'after';
}

const STAGE = resolveStage(process.env.REG3021_STAGE);
const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../..',
);
const captureDir = path.resolve(
  repoRoot,
  '.playwright',
  process.env.REG3021_CAPTURE_SLUG ?? 'REG-3021',
);
const MOCK_BASE_URL = DEFAULT_MOCK_BASE_URL;
const TOKEN = 'ghp_e2e_reg3021_picker_capture';
const EMPTY_TOKEN = 'ghp_e2e_reg3021_picker_capture_empty';

interface MockRepository {
  readonly name: string;
  readonly description: string | null;
  readonly isPrivate: boolean;
  readonly archived: boolean;
}

const REPOSITORIES: readonly MockRepository[] = [
  {
    name: 'billing-service',
    description: 'Invoices, subscriptions, and the payment webhooks.',
    isPrivate: true,
    archived: false,
  },
  {
    name: 'docs-site',
    description:
      'Public documentation, guides, and the changelog for every release of the product, rendered from the markdown sources in this repository.',
    isPrivate: false,
    archived: false,
  },
  {
    name: 'legacy-site',
    description: 'Frozen marketing site.',
    isPrivate: false,
    archived: true,
  },
  {
    name: 'vault-tools',
    description: null,
    isPrivate: true,
    archived: true,
  },
];

function githubRepository(
  repository: MockRepository,
  id: number,
): Record<string, unknown> {
  const { name } = repository;
  return {
    id,
    name,
    full_name: `acme/${name}`,
    owner: { login: 'acme' },
    description: repository.description,
    clone_url: `https://github.com/acme/${name}.git`,
    ssh_url: `git@github.com:acme/${name}.git`,
    html_url: `https://github.com/acme/${name}`,
    private: repository.isPrivate,
    fork: false,
    archived: repository.archived,
    default_branch: 'main',
    updated_at: '2026-01-01T00:00:00Z',
  };
}

async function registerRepositories(
  token: string,
  repos: readonly Record<string, unknown>[],
): Promise<void> {
  const response = await fetch(`${MOCK_BASE_URL}/__mock/state`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ key: token, scenario: { github: { repos } } }),
  });
  expect(response.ok).toBe(true);
}

async function clearScenario(token: string): Promise<void> {
  await fetch(`${MOCK_BASE_URL}/__mock/state/${encodeURIComponent(token)}`, {
    method: 'DELETE',
  }).catch(() => undefined);
}

async function openPicker(
  window: Page,
  openMainPage: () => Promise<unknown>,
): Promise<{ picker: Locator; list: Locator; search: Locator }> {
  await openMainPage();
  // The add button is hover-revealed; the keyboard path avoids pointer flake.
  await window.getByTestId('sidebar-section-code-add').focus();
  await window.getByTestId('sidebar-section-code-add').press('Enter');
  await expect(
    window.getByRole('heading', { name: 'Add project' }),
  ).toBeVisible();
  await window.getByTestId('add-workspace-mode-remote').click();
  const panel = window.getByTestId('add-workspace-remote-panel');
  const list = panel.getByTestId('add-workspace-github-repo-list');
  await expect(list).toBeVisible();
  // The picker is the label, the search box and the list: the list's parent.
  const picker = list.locator('xpath=..');
  const search = panel.getByPlaceholder('Search your repositories');
  await expect(search).toBeVisible();
  return { picker, list, search };
}

async function capture(
  window: Page,
  picker: Locator,
  state: string,
): Promise<void> {
  // Park the pointer so no row keeps its hover tint.
  await window.mouse.move(0, 0);
  await window.evaluate(() => document.fonts.ready.then(() => undefined));
  await picker.screenshot({
    path: path.join(
      captureDir,
      `github-repository-picker-desktop-${state}-${STAGE}.png`,
    ),
    animations: 'disabled',
    caret: 'hide',
  });
}

test.describe(`GitHub repository picker captures (${STAGE})`, () => {
  let fixtureRoot: string;
  let launched: Awaited<ReturnType<typeof launchCanopyApp>> | undefined;

  test.beforeEach(() => {
    fixtureRoot = mkdtempSync(path.join(os.tmpdir(), 'canopy-picker-capture-'));
    mkdirSync(captureDir, { recursive: true });
  });

  test.afterEach(async () => {
    await Promise.all([clearScenario(TOKEN), clearScenario(EMPTY_TOKEN)]);
    if (launched) await closeCanopy(launched.electronApp, launched.userDataDir);
    launched = undefined;
    rmSync(fixtureRoot, { recursive: true, force: true });
  });

  test('list, archived selection, and no match', async () => {
    test.setTimeout(120_000);
    await registerRepositories(
      TOKEN,
      REPOSITORIES.map((repository, index) =>
        githubRepository(repository, index + 1),
      ),
    );
    launched = await launchCanopyApp({
      env: { GH_TOKEN: TOKEN },
      waitForShellOptions: { timeout: 30_000 },
    });
    const { window, app } = launched;
    const { picker, list, search } = await openPicker(window, () =>
      app.openMainPage(),
    );

    // Every repository is listed; the badges say which are private/archived.
    await expect(list.getByRole('button')).toHaveCount(REPOSITORIES.length);
    await expect(list).toContainText('Private');
    await expect(list).toContainText('Archived');
    await capture(window, picker, 'list');

    // An archived repository is chosen like any other.
    const archived = list.getByRole('button', { name: /acme\/legacy-site/ });
    await archived.click();
    await expect(archived).toHaveAttribute('aria-pressed', 'true');
    await search.focus();
    await capture(window, picker, 'selected-archived');

    // The whole desktop Add project dialog around the picker, for side-by-side
    // review with the web dialog, including the shared project choice cards.
    {
      const dialog = window
        .getByRole('dialog')
        .filter({ has: window.getByRole('heading', { name: 'Add project' }) });
      await window.mouse.move(0, 0);
      await dialog.screenshot({
        path: path.join(
          captureDir,
          `add-project-dialog-desktop-remote-github-${STAGE}.png`,
        ),
        animations: 'disabled',
        caret: 'hide',
      });
    }

    // A search that matches nothing quotes what was typed.
    await search.fill('zzz');
    await expect(list).toContainText('No matches for “zzz”.');
    await capture(window, picker, 'no-match');
  });

  test('empty account', async () => {
    test.setTimeout(120_000);
    await registerRepositories(EMPTY_TOKEN, []);
    launched = await launchCanopyApp({
      env: { GH_TOKEN: EMPTY_TOKEN },
      waitForShellOptions: { timeout: 30_000 },
    });
    const { window, app } = launched;
    const { picker, list } = await openPicker(window, () => app.openMainPage());
    await expect(list).toContainText('No repositories returned from GitHub.');
    await capture(window, picker, 'empty');
  });
});
