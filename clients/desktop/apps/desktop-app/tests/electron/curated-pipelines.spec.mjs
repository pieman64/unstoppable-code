import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { seedStoredPipeline } from './seeders/seedStoredPipeline.mjs';
import { startCuratedPipelinesCloud } from './fixtures/curatedPipelinesCloud.mjs';
import { toggleHomePipelineMode } from './homeComposerMenu.mjs';

test('Library lists owned pipelines only, and Marketplace adds an editable copy of a template', async () => {
  const cloud = await startCuratedPipelinesCloud();
  const userDataDir = mkdtempSync(join(tmpdir(), 'curated-pipeline-e2e-'));
  seedStoredPipeline({
    userDataDir,
    id: 'existing-local',
    name: 'Existing local pipeline',
    yaml: 'name: Existing local pipeline\non: dispatch\njobs:\n  check:\n    steps:\n      - run: echo unchanged\n',
  });
  const { electronApp } = await launchCanopy({
    userDataDir,
    env: { CANOPY_E2E_CLOUD_BASE_URL: cloud.baseUrl },
  });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await window.evaluate(async () =>
      window.api.saveCanopyCloudApiKey({ apiKey: 'csk_curated_pipelines_e2e' }),
    );
    // Workflows > Library lists what the user owns or was shared; templates
    // stay in Marketplace.
    await app.openPipelinesPage();
    const table = window.getByTestId('workflows-library-table');
    await expect(
      app.workflowsLibraryRowByName('Existing local pipeline'),
    ).toBeVisible();
    await expect(
      app.workflowsLibraryRowByName('Shared Dispatch Pipeline'),
    ).toBeVisible();
    await expect(
      table.locator('[data-row-key^="pipeline:curated:"]'),
    ).toHaveCount(0);
    await expect(window.getByTestId('pipeline-templates-section')).toHaveCount(
      0,
    );
    expect(cloud.counts.details).toBe(0);

    await app.openPluginsPage();
    await window.getByRole('tab', { name: 'Workflows', exact: true }).click();
    await window
      .getByTestId('plugins-results-scroll')
      .getByTestId('plugins-entry-pipeline:curated:curated-review-0')
      .click();
    await expect(window.getByTestId('curated-pipeline-yaml')).toContainText(
      'echo reviewed',
    );
    await window.getByTestId('curated-pipeline-add').click();
    // The confirmation offers to open the new editable copy.
    await expect(
      window
        .getByRole('status')
        .filter({ hasText: 'Added to your workflows.' }),
    ).toBeVisible();
    await expect(
      window.getByTestId('curated-pipeline-open-imported'),
    ).toBeVisible();
    const cache = readFileSync(
      join(userDataDir, 'curated-pipelines', 'catalog.json'),
      'utf8',
    );
    expect(cache).not.toContain('rawPipeline');
    const index = JSON.parse(
      readFileSync(join(userDataDir, 'pipelines', 'index.json'), 'utf8'),
    );
    expect(index.pipelines).toHaveLength(2);
    const imported = index.pipelines.find((row) => row.id !== 'existing-local');
    expect(
      readFileSync(
        join(userDataDir, 'pipelines', 'existing-local.yaml'),
        'utf8',
      ),
    ).toContain('echo unchanged');
    cloud.state.offline = true;
    await window.getByRole('button', { name: 'Open workflow' }).click();
    await expect(
      window.getByRole('button', { name: 'Save', exact: true }),
    ).toBeVisible();
    const local = await window.evaluate(
      (id) => window.pipelines.get(id),
      imported.id,
    );
    expect(local.data.info).toMatchObject({ source: 'user', readonly: false });
    expect(local.data.content.jobs.review.steps[0].run).toContain(
      'echo reviewed',
    );
  } finally {
    await closeCanopy(electronApp, userDataDir);
    await cloud.close();
  }
});

test('Marketplace blends shared and curated pipelines in one filtered inventory with lazy preview', async () => {
  const cloud = await startCuratedPipelinesCloud();
  const userDataDir = mkdtempSync(join(tmpdir(), 'curated-marketplace-e2e-'));
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
        apiKey: 'csk_curated_marketplace_e2e',
      }),
    );
    await app.openPluginsPage();
    await window.getByRole('tab', { name: 'Workflows', exact: true }).click();
    // The filters head the Workflows Browse list, not the tab row.
    await expect(
      window
        .getByTestId('customize-section-browse')
        .getByTestId('plugins-pipeline-filters'),
    ).toBeVisible();
    const resultList = window.getByTestId('plugins-results-scroll');
    const curatedEntry = resultList.getByTestId(
      'plugins-entry-pipeline:curated:curated-review-0',
    );
    await expect(curatedEntry).toBeVisible();
    await expect(
      resultList.getByText('Shared Dispatch Pipeline', { exact: true }),
    ).toBeVisible();
    await expect(window.getByTestId('curated-pipeline-rows')).toHaveCount(0);
    expect(cloud.counts.details).toBe(0);
    await window.getByTestId('plugins-pipeline-filter-source').click();
    await window.getByTestId('plugins-pipeline-filter-source-curated').click();
    await expect(
      window.getByTestId('plugins-pipeline-filter-source'),
    ).toHaveText('Curated');
    await expect(
      resultList.getByText('Shared Dispatch Pipeline', { exact: true }),
    ).toHaveCount(0);
    await expect(
      curatedEntry.getByTestId(
        'plugins-pipeline-source-pipeline:curated:curated-review-0',
      ),
    ).toHaveCount(0);
    await window.getByTestId('plugins-search').fill('Curated review workflow');
    await expect(
      window.getByTestId('plugins-section-workflows'),
    ).toHaveAttribute('data-row-count', '1');
    // While searching, an empty list names the search, not the filters.
    await window.getByTestId('plugins-pipeline-filter-scope').click();
    await window.getByTestId('plugins-pipeline-filter-scope-worktree').click();
    await expect(window.getByTestId('customize-section-browse')).toContainText(
      'Nothing matches your search.',
    );
    // Without a search, a filter that empties the list keeps the list and its
    // filters on screen, so it can be changed back.
    await window.getByTestId('plugins-search').fill('');
    await expect(window.getByTestId('customize-section-browse')).toContainText(
      'No workflows match these filters.',
    );
    await window.getByTestId('plugins-pipeline-filter-scope').click();
    await window.getByTestId('plugins-pipeline-filter-scope-all').click();
    await window.getByTestId('plugins-search').fill('Curated review workflow');
    await expect(
      window.getByTestId('plugins-section-workflows'),
    ).toHaveAttribute('data-row-count', '1');
    await expect(curatedEntry).toBeVisible();
    await curatedEntry.click();
    await expect(window.getByTestId('curated-pipeline-add')).toBeVisible();
    await expect(
      window.getByTestId('plugins-curated-pipeline-breadcrumbs'),
    ).toContainText('CustomizeWorkflowsCurated review workflow');
    await window
      .getByTestId('plugins-curated-pipeline-breadcrumb-type')
      .click();
    await expect(
      window.getByTestId('curated-pipeline-preview-dialog'),
    ).toHaveCount(0);
    await expect(
      window.getByRole('tab', { name: 'Workflows', exact: true }),
    ).toHaveAttribute('aria-selected', 'true');
    await expect(window.getByTestId('plugins-search')).toHaveValue('');
    expect(cloud.counts.details).toBe(1);
  } finally {
    await closeCanopy(electronApp, userDataDir);
    await cloud.close();
  }
});

test('Marketplace refreshes pipelines from one compact control on the Workflows tab only', async () => {
  const cloud = await startCuratedPipelinesCloud();
  const userDataDir = mkdtempSync(join(tmpdir(), 'curated-refresh-e2e-'));
  const { electronApp } = await launchCanopy({
    userDataDir,
    env: { CANOPY_E2E_CLOUD_BASE_URL: cloud.baseUrl },
  });
  let releaseLists = () => undefined;
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await window.evaluate(async () =>
      window.api.saveCanopyCloudApiKey({
        apiKey: 'csk_curated_refresh_e2e',
      }),
    );
    await app.openPluginsPage();

    // Every other tab stays current without a manual refresh.
    for (const name of ['All', 'Plugins', 'MCP servers', 'Skills']) {
      await window.getByRole('tab', { name, exact: true }).click();
      await expect(window.getByTestId('plugins-pipelines-refresh')).toHaveCount(
        0,
      );
    }
    await window.getByRole('tab', { name: 'Collections', exact: true }).click();
    await expect(window.getByTestId('plugins-pipelines-refresh')).toHaveCount(
      0,
    );

    await window.getByRole('tab', { name: 'Workflows', exact: true }).click();
    const resultList = window.getByTestId('plugins-results-scroll');
    await expect(
      resultList.getByTestId('plugins-entry-pipeline:curated:curated-review-0'),
    ).toBeVisible();

    // One icon-only control on the Browse heading, beside the filters.
    const refresh = window
      .getByTestId('customize-section-browse')
      .getByTestId('plugins-pipelines-refresh');
    await expect(refresh).toBeVisible();
    await expect(refresh).toBeEnabled();
    await expect(refresh).toHaveAccessibleName('Refresh workflows');
    await expect(refresh).toHaveText('');
    await refresh.hover();
    await expect(
      window.getByRole('tooltip').filter({ hasText: 'Refresh workflows' }),
    ).toBeVisible();

    const listsBefore = cloud.counts.lists;
    cloud.state.listGate = new Promise((resolve) => {
      releaseLists = resolve;
    });
    await refresh.click();
    // The forced refresh reaches the catalog rather than the saved copy.
    await expect.poll(() => cloud.counts.lists).toBe(listsBefore + 1);
    await expect(refresh).toBeDisabled();
    await expect(refresh).toHaveAccessibleName(
      'Refresh workflows (in progress)',
    );
    // A second click while it runs starts nothing.
    await refresh.click({ force: true });

    cloud.state.listGate = null;
    releaseLists();
    await expect(refresh).toBeEnabled();
    await expect(refresh).toHaveAccessibleName('Refresh workflows');
    expect(cloud.counts.lists).toBe(listsBefore + 1);
    await expect(
      resultList.getByTestId('plugins-entry-pipeline:curated:curated-review-0'),
    ).toBeVisible();
  } finally {
    releaseLists();
    await closeCanopy(electronApp, userDataDir);
    await cloud.close();
  }
});

/** Opens Customize > Workflows and returns a curated template's entry. */
async function openTemplateEntry(app, key) {
  await app.openPluginsPage();
  await app.window.getByRole('tab', { name: 'Workflows', exact: true }).click();
  const entry = app.window
    .getByTestId('plugins-results-scroll')
    .getByTestId(`plugins-entry-pipeline:curated:${key}`);
  await expect(entry).toBeVisible();
  return entry;
}

/**
 * Enables or disables a template through its Marketplace preview's visible
 * control, then closes the preview. The preference keeps the stable
 * `curated:<key>` identity.
 */
async function setTemplateEnabledFromPreview(app, key, enabled) {
  const { window } = app;
  await (await openTemplateEntry(app, key)).click();
  const dialog = window.getByTestId('curated-pipeline-preview-dialog');
  const toggle = dialog.getByTestId('curated-pipeline-toggle-enabled');
  await expect(toggle).toHaveText(
    enabled ? 'Enable workflow' : 'Disable workflow',
  );
  await toggle.click();
  await expect(toggle).toHaveText(
    enabled ? 'Disable workflow' : 'Enable workflow',
  );
  await expect(
    dialog.getByTestId('curated-pipeline-availability'),
  ).toContainText(enabled ? 'Enabled' : 'Disabled');
  await window.getByTestId('plugins-curated-pipeline-breadcrumb-type').click();
  await expect(dialog).toHaveCount(0);
}

test('undownloaded templates retain dispatch and disabled-preference behavior', async () => {
  const cloud = await startCuratedPipelinesCloud();
  const userDataDir = mkdtempSync(join(tmpdir(), 'managed-curated-e2e-'));
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  const { electronApp } = await launchCanopy({
    userDataDir,
    env: { CANOPY_E2E_CLOUD_BASE_URL: cloud.baseUrl },
  });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await window.evaluate(() =>
      window.api.saveCanopyCloudApiKey({ apiKey: 'csk_managed_curated_e2e' }),
    );
    await openTemplateEntry(app, 'curated-review-0');
    // A preference recorded earlier (for example by an older build or the
    // agent app action) hides the template before any definition downloads.
    await window.evaluate(() =>
      window.api.setPipelineDisabledPreference({
        id: 'curated:curated-review-0',
        disabled: true,
      }),
    );
    const disabledIds = () =>
      JSON.parse(readFileSync(join(userDataDir, 'preferences.json'), 'utf8'))
        .preferences.disabledPipelineIds;
    expect(disabledIds()).toContain('curated:curated-review-0');
    expect(cloud.counts.details).toBe(0);
    await app.openMainPage();
    await app.selectWorktree('demo-main');
    await window.getByTestId('pipeline-dispatch-open').click();
    await expect(
      window.getByTestId('pipeline-trigger-modal-body'),
    ).toBeVisible();
    await expect(
      window.getByRole('button', { name: /Curated review workflow/ }),
    ).toHaveCount(0);
    await window.getByTestId('pipeline-trigger-modal-cancel').click();
    // New catalog content must retain the same hidden preference identity.
    cloud.state.changed = true;
    await window.reload();
    await app.waitForShell();
    // The preview still reports the template disabled under the same
    // identity, so it can be re-enabled from the visible control.
    await setTemplateEnabledFromPreview(app, 'curated-review-0', true);
    expect(disabledIds()).not.toContain('curated:curated-review-0');
    // Previewing loads the reviewed definition; launch revalidates it.
    expect(cloud.counts.details).toBeGreaterThan(0);
    await app.openMainPage();
    await app.selectWorktree('demo-main');
    await window.getByTestId('pipeline-dispatch-open').click();
    const modal = window.getByTestId('pipeline-trigger-modal-body');
    const row = modal.getByRole('button', { name: /Curated review workflow/ });
    await expect(row).toBeVisible();
    await row.click();
    await expect(
      window.getByTestId('pipeline-trigger-modal-run'),
    ).toBeEnabled();
    await window.getByTestId('pipeline-trigger-modal-run').click();
    const card = window
      .locator('[data-testid^="pipeline-run-card-"]')
      .filter({ hasText: 'Curated review workflow' })
      .first();
    await expect(card).toBeVisible();
    await expect(card).toContainText('success', { timeout: 30_000 });
    await setTemplateEnabledFromPreview(app, 'curated-review-0', false);
    await app.openMainPage();
    await app.selectWorktree('demo-main');
    await window.getByTestId('pipeline-dispatch-open').click();
    await expect(modal).toBeVisible();
    await expect(row).toHaveCount(0);
  } finally {
    await closeCanopy(electronApp, userDataDir);
    await cloud.close();
  }
});

test('task-ready launch lists undownloaded curated pipelines from Home', async () => {
  const cloud = await startCuratedPipelinesCloud({ triggerType: 'task_ready' });
  const userDataDir = mkdtempSync(join(tmpdir(), 'curated-task-ready-e2e-'));
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  const { electronApp } = await launchCanopy({
    userDataDir,
    env: { CANOPY_E2E_CLOUD_BASE_URL: cloud.baseUrl },
  });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await window.evaluate(() =>
      window.api.saveCanopyCloudApiKey({ apiKey: 'csk_curated_task_ready' }),
    );
    await window.getByTestId('sidebar-create-task').click();
    const home = window.getByTestId('page-home');
    await expect(home.getByTestId('home-surface')).toHaveAttribute(
      'data-workspace-selected',
      'true',
    );
    await toggleHomePipelineMode(window, home);
    await home
      .getByTestId('home-composer-editor')
      .fill('Review this workflow.');
    await home.getByTestId('home-send-button').click();
    const modal = window.getByTestId('pipeline-trigger-modal-body');
    await expect(
      window.getByRole('heading', { name: 'Run task workflow' }),
    ).toBeVisible();
    await expect(
      modal.getByRole('button', { name: /Curated review workflow/ }),
    ).toBeVisible();
    expect(cloud.counts.details).toBe(0);
    await modal
      .getByRole('button', { name: /Curated review workflow/ })
      .click();
    await expect(
      window.getByTestId('pipeline-trigger-modal-run'),
    ).toBeEnabled();
    expect(cloud.counts.details).toBe(1);
  } finally {
    await closeCanopy(electronApp, userDataDir);
    await cloud.close();
  }
});
