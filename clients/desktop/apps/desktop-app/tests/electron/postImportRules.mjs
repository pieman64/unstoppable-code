import { expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  externalProjectCandidateIdFor,
  seedExternalProjectImportFixture,
} from './seeders/seedExternalProjectImportFixture.mjs';

/**
 * Fixed recency, committed rules, exactly two selected successful imports.
 * With `sideQuestRules`, both projects have rules, so the import's offer
 * names two projects (CAN-4980).
 */
export function seedPostImportRulesFixture(
  userDataDir,
  sideQuestName = 'side-quest',
  { sideQuestRules = false } = {},
) {
  return seedExternalProjectImportFixture({
    userDataDir,
    extraGitProjects: [
      {
        name: sideQuestName,
        lastActivityAt: '2026-10-20T12:00:00.000Z',
        ...(sideQuestRules
          ? { rules: 'Use the side quest conventions.\n' }
          : {}),
      },
      {
        name: 'payments-service',
        lastActivityAt: '2026-10-19T12:00:00.000Z',
        rules: 'Use the payments service conventions.\n',
      },
    ],
  });
}

export function importedWorkspace(userDataDir, name) {
  const index = JSON.parse(
    readFileSync(path.join(userDataDir, 'workspaces', 'index.json'), 'utf8'),
  );
  const workspace = index.workspaces.find((entry) => entry.name === name);
  if (!workspace) throw new Error(`Imported workspace missing: ${name}`);
  return workspace;
}

export async function importFirstRunRuleProjects(window, fixture) {
  const page = window.getByTestId('first-run-import-page');
  await expect(page).toBeVisible({ timeout: 30_000 });
  const older = page.getByTestId('first-run-import-older');
  if (await older.isVisible()) await older.click();
  const all = page
    .getByTestId('first-run-import-select-all')
    .getByRole('checkbox');
  await all.uncheck();
  for (const project of fixture.extraProjects) {
    await page
      .getByTestId(
        `first-run-import-row-${externalProjectCandidateIdFor(project.dir)}`,
      )
      .getByRole('checkbox')
      .check();
  }
  const submit = page.getByTestId('first-run-import-submit');
  await expect(submit).toHaveText('Import 2 projects');
  await submit.click();
  await expect(page).toHaveCount(0, { timeout: 120_000 });
  const home = window.getByTestId('page-home');
  await expect(home.getByTestId('home-composer-editor')).toBeVisible();
  await expect(home.getByTestId('home-workspace-select')).toContainText(
    'side-quest',
  );
  return home;
}

export async function openFirstRunRulesOffer(window) {
  const offer = window
    .getByTestId('toast-card')
    .filter({ hasText: 'Cursor rules found' })
    .filter({ hasText: 'payments-service' });
  await expect(offer).toBeVisible({ timeout: 30_000 });
  await offer.getByTestId('toast-action').click();
  await expect(window.getByTestId('repo-rules-review-step')).toContainText(
    'payments-service',
  );
}

export async function applyImportRules(window) {
  await expect(window.getByTestId('repo-rules-review-step')).toBeVisible();
  await window.getByTestId('repo-rules-apply').click();
  await expect(window.getByTestId('repo-rules-modal')).toHaveCount(0);
}
