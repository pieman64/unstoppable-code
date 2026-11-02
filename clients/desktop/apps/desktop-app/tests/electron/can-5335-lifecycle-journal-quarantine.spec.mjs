// CAN-5335: an unreadable destructive lifecycle journal entry refuses every
// project's deletion. The refusal opens the shared review, which moves exactly
// that entry to quarantine; the refused removal then succeeds.
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';

const TARGET_ID = 'demo-ts-pnpm-vite';
const WORKTREE_ID = 'demo-main';
const REVIEW = 'lifecycle-journal-quarantine';
const BROKEN = '{"version":1,"operation":';

function worktreeRow(window) {
  return window.locator(
    `[data-testid="worktree-row"][data-project-id="${TARGET_ID}"][data-worktree-id="${WORKTREE_ID}"]`,
  );
}

async function deleteThroughSidebar(window) {
  const row = worktreeRow(window);
  await row.hover();
  await row.getByTestId('worktree-actions-menu-button').click();
  await window.getByTestId('worktree-actions-menu-delete').click();
  const dialog = window.getByRole('dialog', { name: /^Delete worktree/ });
  // A clean Delete can skip confirmation with a cached diff.
  const asked = await dialog.waitFor({ state: 'visible', timeout: 3_000 }).then(
    () => true,
    () => false,
  );
  if (asked)
    await dialog.getByTestId('worktree-removal-preserve-branch').click();
}

function persistedWorktreeIds(worktreesPath) {
  return JSON.parse(readFileSync(worktreesPath, 'utf8')).worktrees.map(
    (row) => row.id,
  );
}

function slotName(workspaceId) {
  return `${createHash('sha256')
    .update(JSON.stringify([workspaceId, null]))
    .digest('hex')}.json`;
}

test('a refused worktree delete reviews, quarantines and then deletes', async () => {
  test.setTimeout(180_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-journal-quarantine-'),
  );
  const { workspaces } = seedDemoWorkspaces({
    userDataDir,
    apps: ['ts-pnpm-vite', 'ts-npm-next'],
  });
  const target = workspaces.find((item) => item.id === TARGET_ID);
  const other = workspaces.find((item) => item.id !== target?.id);
  if (!target || !other) throw new Error('Missing demo workspaces');
  const journalDir = path.join(userDataDir, 'w5', 'destructive-lifecycles');
  const quarantineDir = path.join(userDataDir, 'w5', 'quarantined-lifecycles');
  const worktreesPath = path.join(
    userDataDir,
    'workspaces',
    TARGET_ID,
    'worktrees.json',
  );
  // The hashed slot of the other listed project: the review names it.
  const name = slotName(other.id);
  let electronApp;
  try {
    ({ electronApp } = await launchCanopy({ userDataDir }));
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    await expect(worktreeRow(window)).toBeVisible();

    mkdirSync(journalDir, { recursive: true });
    writeFileSync(path.join(journalDir, name), BROKEN, { mode: 0o600 });

    await deleteThroughSidebar(window);
    const review = window.getByTestId(REVIEW);
    await expect(review).toBeVisible({ timeout: 45_000 });
    await expect(review).toContainText('Move unreadable record to quarantine?');
    await expect(review).toContainText('Its owner can’t be determined.');
    await expect(review).toContainText(
      'Moving it lets deleting, archiving and background cleanup resume for all projects.',
    );
    await expect(window.getByTestId(`${REVIEW}-name`)).toHaveText(name);
    await expect(window.getByTestId(`${REVIEW}-location`)).toHaveText(
      journalDir,
    );
    await expect(window.getByTestId(`${REVIEW}-match`)).toContainText(
      other.name,
    );
    // The refused delete left the worktree in place.
    await expect(worktreeRow(window)).toBeVisible();
    expect(existsSync(path.join(journalDir, name))).toBe(true);

    await window.getByTestId(`${REVIEW}-confirm`).click();
    await expect(review).toContainText('Record moved to quarantine');
    const movedName = await window
      .getByTestId(`${REVIEW}-moved-name`)
      .textContent();
    expect(readdirSync(quarantineDir)).toEqual([movedName]);
    expect(readFileSync(path.join(quarantineDir, movedName), 'utf8')).toBe(
      BROKEN,
    );
    expect(existsSync(path.join(journalDir, name))).toBe(false);
    await window.getByTestId(`${REVIEW}-confirm`).click();
    await expect(review).toHaveCount(0);

    // Nothing else stays fenced: the same delete now succeeds. The sidebar
    // drops the row before the archive commits and restores it on a refusal,
    // so success is the committed worktree list, not the row's absence.
    expect(persistedWorktreeIds(worktreesPath)).toContain(WORKTREE_ID);
    await deleteThroughSidebar(window);
    await expect
      .poll(() => persistedWorktreeIds(worktreesPath), { timeout: 45_000 })
      .not.toContain(WORKTREE_ID);
    await expect(worktreeRow(window)).toHaveCount(0);
    await expect(review).toHaveCount(0);
    expect(readdirSync(quarantineDir)).toEqual([movedName]);
  } finally {
    if (electronApp) await closeCanopy(electronApp, userDataDir);
    rmSync(userDataDir, { recursive: true, force: true });
  }
});
