/**
 * CAN-3533: curated automations in the Marketplace.
 *
 * The curated catalog is browsed as metadata only, previewed on demand, and
 * added through the same install wizard as a team share. The copy is installed
 * enabled with curated provenance, the Marketplace then lists only that
 * local copy, and a catalog change is offered on it as an update that is
 * applied in place.
 *
 * Deterministic: a per-test loopback catalog server stands in for the cloud,
 * and the automations are App Advisor prompts, so no project, agent, or
 * network is involved.
 */
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver, discardWorkflowEditIfOpen } from './canopyApp.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { startCuratedAutomationsCloud } from './fixtures/curatedAutomationsCloud.mjs';

const KEY = 'curated-automation-0';
const NAME = 'Daily curated review';
const CURATED_ENTRY = `plugins-entry-automation:curated:${KEY}`;

async function listActivities(window) {
  const snapshot = await window.evaluate(() => window.api.automations.list());
  return snapshot.activities;
}

async function openAutomationsTab(window) {
  await window.getByRole('tab', { name: 'Workflows', exact: true }).click();
  await expect(
    window.getByRole('tab', { name: 'Workflows', exact: true }),
  ).toHaveAttribute('aria-selected', 'true');
}

test('a curated automation is browsed, added enabled, listed once, and updated in place', async () => {
  test.setTimeout(180_000);
  const cloud = await startCuratedAutomationsCloud({
    reviewName: NAME,
    targetRequirement: { contexts: ['app_advisor'] },
  });
  const userDataDir = mkdtempSync(join(tmpdir(), 'curated-automation-e2e-'));
  const { electronApp } = await launchCanopy({
    userDataDir,
    env: { CANOPY_E2E_CLOUD_BASE_URL: cloud.baseUrl },
  });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await window.evaluate(async () =>
      window.api.saveCanopyCloudApiKey({
        apiKey: 'csk_curated_automations_e2e',
      }),
    );

    // The sidebar row is named after the page it opens.
    await expect(window.getByTestId('sidebar-nav-plugins')).toContainText(
      'Customize',
    );
    await app.openPluginsPage();
    await openAutomationsTab(window);

    // Browse: one page of metadata, and no document fetched yet.
    const section = window.getByTestId('plugins-section-workflows');
    const curatedRows = section.locator(
      '[data-testid^="plugins-entry-automation:curated:"]',
    );
    await expect(curatedRows).toHaveCount(25);
    await expect(window.getByTestId(CURATED_ENTRY)).toContainText(
      'Daily Curated Review',
    );
    expect(cloud.counts.details).toBe(0);
    const cache = readFileSync(
      join(userDataDir, 'curated-automations', 'catalog.json'),
      'utf8',
    );
    expect(cache).toContain(KEY);
    // The saved catalog is summaries only: no automation document, so no
    // action and no prompt.
    expect(cache).not.toContain('"automation"');
    expect(cache).not.toContain('"prompt"');

    // The next page loads from the one control under the list.
    const more = window.getByTestId('automation-catalog-load-more');
    await expect(more).toHaveText('Show more automations');
    await more.click();
    await expect(curatedRows).toHaveCount(30);
    await expect(more).toHaveCount(0);
    expect(cloud.counts.details).toBe(0);

    // Preview: opening the card loads the document and starts nothing.
    await window.getByTestId(CURATED_ENTRY).click();
    const detail = window.getByTestId('curated-automation-marketplace-detail');
    await expect(detail).toBeVisible();
    // Page actions live in the detail's action bar at the top right.
    const actionBar = window.getByTestId('detail-action-bar');
    await expect(
      window.getByTestId('plugins-entry-detail-breadcrumbs'),
    ).toContainText('CustomizeWorkflowsDaily Curated Review');
    await expect(
      detail.getByTestId('automation-definition-summary'),
    ).toContainText('Review open work');
    await expect(actionBar.getByTestId('automation-source-install')).toHaveText(
      'Add',
    );
    await expect(
      window.getByTestId('install-shared-automation-modal'),
    ).toHaveCount(0);
    expect(cloud.counts.details).toBe(1);

    // Add: one click installs an enabled copy with curated provenance.
    await actionBar.getByTestId('automation-source-install').click();
    const modal = window.getByTestId('install-shared-automation-modal');
    await expect(modal).toBeVisible();
    await expect(modal.getByTestId('share-install-type-label')).toHaveText(
      'Automation',
    );
    await expect(modal.getByTestId('install-automation-submit')).toHaveText(
      'Install and enable',
    );
    await expect(modal.getByTestId('install-automation-note')).toHaveCount(0);
    await modal.getByTestId('install-automation-submit').click();
    await expect(modal).toHaveCount(0);

    await expect
      .poll(async () => (await listActivities(window))[0]?.enabled ?? null)
      .toBe(true);
    const [installed] = await listActivities(window);
    expect(await listActivities(window)).toHaveLength(1);
    expect(installed).toMatchObject({
      name: NAME,
      enabled: true,
      action: { type: 'app_advisor_prompt', prompt: 'Review open work' },
      installedFrom: { remoteId: KEY, sourceKind: 'curated' },
      targetRequirement: { contexts: ['app_advisor'] },
    });
    const installedHash = installed.installedFrom.contentHash;

    // CAN-3710: the install lands on the new copy in Workflows › Library.
    await expect(app.workflowsLibraryAutomationRow(installed.id)).toBeVisible();
    await expect(window.getByText('Automation installed.')).toBeVisible();

    // Customize remembers where it was left: the curated detail. Its root
    // crumb returns to the Workflows list.
    await window.getByTestId('sidebar-nav-plugins').click();
    await expect(detail).toBeVisible();
    await app.closeMarketplaceEntryDetail();
    await app.expectPluginsPage();

    // One canonical Installed copy; its catalog alias stays out of Browse.
    await openAutomationsTab(window);
    const installedSection = window.getByTestId('customize-section-installed');
    const localEntry = installedSection.getByTestId(
      `customize-row-automation:local:${installed.id}`,
    );
    await expect(localEntry).toBeVisible();
    await expect(window.getByTestId(CURATED_ENTRY)).toHaveCount(0);
    await expect(
      installedSection.getByTestId(
        `customize-row-update-marker-automation:local:${installed.id}`,
      ),
    ).toHaveCount(0);
    await expect(
      window.locator('[data-testid^="customize-row-automation"]'),
    ).toHaveCount(1);

    // The catalog republishes the entry. The saved catalog is replaced the
    // way its time-to-live would replace it, and the page is reopened.
    cloud.state.changed = true;
    await window.evaluate(() =>
      window.api.automations.listCurated({ limit: 25, forceRefresh: true }),
    );
    await app.openAutomationsPage();
    await app.openPluginsPage();
    await openAutomationsTab(window);
    const updateAction = installedSection.getByTestId(
      `customize-update-automation:local:${installed.id}`,
    );
    await expect(updateAction).toBeVisible();
    await expect(updateAction).toHaveText('');
    await expect(updateAction).toHaveAccessibleName(/^Update /);
    await expect(
      installedSection.getByTestId(
        `customize-row-update-marker-automation:local:${installed.id}`,
      ),
    ).toHaveCount(0);
    await expect(window.getByTestId(CURATED_ENTRY)).toHaveCount(0);

    // Update: the wizard opens in update mode and rewrites the same copy.
    await localEntry.click();
    const local = window.getByTestId('automation-catalog-detail');
    await expect(local.getByTestId('automation-catalog-origin')).toHaveText(
      'Added from Customize',
    );
    await expect(
      local.getByTestId('automation-catalog-update-available'),
    ).toBeVisible();
    await actionBar.getByTestId('automation-catalog-update').click();
    await expect(modal).toBeVisible();
    await expect(modal).toContainText('Apply update');
    await modal.getByTestId('install-automation-submit').click();
    await expect(modal).toHaveCount(0);

    await expect
      .poll(
        async () => (await listActivities(window))[0]?.action?.prompt ?? null,
      )
      .toBe('Review changed open work');
    const activities = await listActivities(window);
    expect(activities).toHaveLength(1);
    expect(activities[0]).toMatchObject({
      id: installed.id,
      // The schedule is unchanged, so the update keeps the copy on.
      enabled: true,
      installedFrom: { remoteId: KEY, sourceKind: 'curated' },
      targetRequirement: { contexts: ['app_advisor'] },
    });
    expect(activities[0].installedFrom.contentHash).not.toBe(installedHash);
    await expect(
      actionBar.getByTestId('automation-catalog-update'),
    ).toHaveCount(0);

    // Open in Workflows lands on the copy in the Workflows edit shell.
    await actionBar.getByTestId('automation-catalog-open').click();
    const shell = window.getByTestId('workflow-edit-shell');
    await expect(shell).toHaveAttribute('data-kind', 'automation');
    await expect(window.getByTestId('automations-form-name')).toHaveValue(NAME);
    await expect(shell).toHaveAttribute('data-dirty', 'false');
  } finally {
    await discardWorkflowEditIfOpen(electronApp);
    await closeCanopy(electronApp, userDataDir);
    await cloud.close();
  }
});

test('the curated automation catalog says when it could not load, and retries', async () => {
  test.setTimeout(120_000);
  const cloud = await startCuratedAutomationsCloud({ reviewName: NAME });
  cloud.state.offline = true;
  const userDataDir = mkdtempSync(join(tmpdir(), 'curated-automation-e2e-'));
  const { electronApp } = await launchCanopy({
    userDataDir,
    env: { CANOPY_E2E_CLOUD_BASE_URL: cloud.baseUrl },
  });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await window.evaluate(async () =>
      window.api.saveCanopyCloudApiKey({
        apiKey: 'csk_curated_automations_offline_e2e',
      }),
    );
    await app.openPluginsPage();
    await openAutomationsTab(window);

    const notice = window.getByTestId('plugins-curated-automations-error');
    await expect(notice).toContainText("Couldn't load curated automations.");
    await expect(window.getByTestId(CURATED_ENTRY)).toHaveCount(0);

    cloud.state.offline = false;
    await notice
      .getByRole('button', { name: 'Try again', exact: true })
      .click();
    await expect(window.getByTestId(CURATED_ENTRY)).toBeVisible();
    await expect(notice).toHaveCount(0);
  } finally {
    await closeCanopy(electronApp, userDataDir);
    await cloud.close();
  }
});
