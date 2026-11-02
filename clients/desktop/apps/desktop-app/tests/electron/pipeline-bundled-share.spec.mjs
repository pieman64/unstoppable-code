import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';

const SCOPED_PIPELINE_ID = '33333333-3333-4333-8333-333333333333';

function emitOpenUrl(electronApp, url) {
  return electronApp.evaluate(({ app }, targetUrl) => {
    app.emit('open-url', { preventDefault: () => {} }, targetUrl);
  }, url);
}

// Bundled pipelines are read-only, but sharing publishes the current pipeline
// as a snapshot copy under the sharer's account.
//
// Testids exercised:
//   - `workflows-library-filter`                 -> Library Filter button (Source facet)
//   - `workflows-library-row` (bundled-code-review-codex) -> opens read-only
//   - `pipeline-share`                           -> editor Share button
//   - `cloud-sync-modal`                         -> disconnected sign-in gate
//   - `share-pipeline-modal`                     -> Share Pipeline dialog
//   - `share-pipeline-scope`                     -> connected scope radiogroup
//   - `share-pipeline-dependencies`              -> packaged dependency review
//   - `share-pipeline-dependency-problems`       -> grouped publisher problem list
//   - `share-pipeline-dependencies-summary`      -> collapsed "Included files" summary
//   - `share-pipeline-submit`                    -> packaged Share action
//   - `share-pipeline-success` / `-link`         -> success notice with the link
//   - `share-pipeline-copy-link` / `-done`       -> footer Copy link and Done
test('bundled pipeline editor offers snapshot sharing', async () => {
  const { electronApp, userDataDir } = await launchCanopy({
    // Portal share links are gated by the portal flag, which is off under
    // E2E unless pinned.
    env: {
      CANOPY_E2E_CLIENT_FEATURE_FLAGS: JSON.stringify({
        'canopy-portal-enabled': true,
      }),
    },
  });

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);

    await app.waitForShell();
    await app.openPipelinesPage();

    await app.chooseWorkflowsLibraryFilter('source', 'built-in');
    const bundledRow = app.workflowsLibraryPipelineRow(
      'bundled-code-review-codex',
      'bundled',
    );
    await expect(bundledRow).toBeVisible();
    await app.openWorkflowsLibraryRow(bundledRow);

    await expect(window.getByText(/read-only/i).first()).toBeVisible();
    await expect(window.getByTestId('pipeline-read-detail')).toBeVisible();
    await expect(window.getByTestId('pipeline-mode-details')).toBeVisible();
    await expect(window.getByTestId('pipeline-mode-visual')).toHaveCount(0);
    await expect(window.getByTestId('pipeline-mode-raw')).toHaveCount(0);
    await expect(window.getByTestId('pipeline-read-detail-meta')).toBeVisible();
    await expect(
      window.getByTestId('pipeline-read-detail-job').first(),
    ).toBeVisible();
    await expect(
      window.getByTestId('pipeline-read-detail-step').first(),
    ).toBeVisible();
    const yamlToggle = window.getByTestId('pipeline-read-detail-yaml-toggle');
    await yamlToggle.click();
    await expect(window.getByTestId('pipeline-read-detail-yaml')).toBeVisible();
    await yamlToggle.click();
    await window.getByTestId('pipeline-mode-flow').click();
    await expect(window.getByTestId('pipeline-read-flow')).toBeVisible();
    await expect(window.getByTestId('pipeline-read-detail')).toHaveCount(0);
    await window.getByTestId('pipeline-mode-details').click();
    await expect(window.getByTestId('pipeline-read-detail')).toBeVisible();
    const shareButton = window.getByTestId('pipeline-share');
    await expect(shareButton).toBeVisible();
    await expect(shareButton).toBeEnabled();
    await shareButton.click();

    const cloudSyncModal = window.getByTestId('cloud-sync-modal');
    await expect(cloudSyncModal).toBeVisible();
    await expect(window.getByTestId('share-pipeline-modal')).toHaveCount(0);
    await cloudSyncModal.getByRole('button', { name: 'Close' }).click();
    await expect(cloudSyncModal).toHaveCount(0);

    const saveResult = await window.evaluate(
      async (apiKey) => window.api.saveCanopyCloudApiKey({ apiKey }),
      'csk_brady_scoped_links_e2e',
    );
    expect(
      saveResult.status,
      saveResult.status.error ?? 'Pipeline sharing account did not connect',
    ).toMatchObject({ authenticated: true });
    await window.evaluate(() => {
      window.dispatchEvent(new Event('canopy:cloud-account-changed'));
    });

    // Sharing only publishes packaged shares, so every dependency must
    // resolve. The pipeline's `$builtin-security:security-diff-scan` comes
    // from the opt-in built-in security plugin; installing it is how a user
    // clears that "Needs attention" blocker. Analysis runs once per modal
    // open, so wait for the skill to be resolvable before opening Share.
    const install = await window.evaluate(async () =>
      window.plugins.installBuiltInPlugin({
        marketplaceId: 'builtin/app',
        pluginName: 'builtin-security',
        providers: ['codex'],
      }),
    );
    expect(install.success, install.error).toBe(true);
    await expect
      .poll(
        async () =>
          window.evaluate(async () => {
            const result = await window.invocableInventory.list({
              providerType: 'codex',
            });
            return (result.data?.entries ?? []).some(
              (entry) =>
                entry.invocationKey === '$builtin-security:security-diff-scan',
            );
          }),
        { timeout: 30_000 },
      )
      .toBe(true);

    await shareButton.click();
    const shareModal = window.getByTestId('share-pipeline-modal');
    await expect(shareModal).toBeVisible();
    await expect(window.getByTestId('share-pipeline-scope')).toBeVisible();
    const dependencyReview = window.getByTestId('share-pipeline-dependencies');
    await expect(dependencyReview).toBeVisible();
    await expect(dependencyReview).not.toContainText(
      'Checking included files',
      {
        timeout: 15_000,
      },
    );
    await expect(
      shareModal.getByTestId('share-pipeline-dependencies-summary'),
    ).toContainText('Included files');
    await expect(
      window.getByTestId('share-pipeline-definition-only'),
    ).toHaveCount(0);
    await expect(
      shareModal.getByRole('button', { name: 'Cancel' }),
    ).toHaveCount(0);
    await shareModal.getByRole('radio', { name: 'Organization' }).click();
    const organizationPicker = shareModal.getByTestId(
      'share-pipeline-organization-picker',
    );
    await organizationPicker
      .getByRole('button', { name: 'Acme Release' })
      .click();
    const submit = shareModal.getByTestId('share-pipeline-submit');
    await expect(submit).toBeEnabled();
    await submit.click();

    // The dialog stays open on its success notice with the scoped link and
    // Copy link; no share toast is raised.
    const scopedLink = new RegExp(
      `/portal/plugins/pipelines/shared/${SCOPED_PIPELINE_ID}$`,
    );
    await expect(
      shareModal.getByTestId('share-pipeline-success'),
    ).toContainText('Workflow shared with Acme Release');
    await expect(shareModal.getByTestId('share-pipeline-link')).toHaveText(
      scopedLink,
    );
    await expect(
      window
        .getByTestId('toast-card')
        .filter({ hasText: 'Workflow shared with Acme Release' }),
    ).toHaveCount(0);
    const copyLink = shareModal.getByTestId('share-pipeline-copy-link');
    await copyLink.click();
    await expect(copyLink).toContainText('Copied');
    await expect
      .poll(() => electronApp.evaluate(({ clipboard }) => clipboard.readText()))
      .toMatch(scopedLink);
    await shareModal.getByTestId('share-pipeline-done').click();
    await expect(shareModal).toHaveCount(0);

    await emitOpenUrl(
      electronApp,
      `canopy://share/pipelines/${SCOPED_PIPELINE_ID}?audience=ORGANIZATION`,
    );
    const landing = window.getByTestId('deep-link-share-landing');
    await expect(landing).toBeVisible();
    await expect(landing).toContainText('Scoped Release Pipeline');
    await expect(landing.getByTestId('deep-link-share-install')).toBeVisible();
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('pipeline editor Account Settings uses the tracked Settings screen', async () => {
  const { electronApp, userDataDir } = await launchCanopy();

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await app.openPipelinesPage();
    await app.chooseWorkflowsLibraryFilter('source', 'built-in');
    await app.openWorkflowsLibraryRow(
      app.workflowsLibraryPipelineRow('bundled-code-review-codex', 'bundled'),
    );

    const saveResult = await window.evaluate(
      async (apiKey) => window.api.saveCanopyCloudApiKey({ apiKey }),
      'csk_brady_scoped_links_e2e',
    );
    expect(saveResult.status.authenticated).toBe(true);
    await window.evaluate(() => {
      window.dispatchEvent(new Event('canopy:cloud-account-changed'));
    });

    await window.getByTestId('pipeline-share').click();
    const shareModal = window.getByTestId('share-pipeline-modal');
    await expect(shareModal).toBeVisible();
    await window.evaluate(async () => {
      await window.api.disconnectCanopyCloudAccount();
      window.dispatchEvent(new Event('canopy:cloud-account-changed'));
    });
    await shareModal
      .getByTestId('share-pipeline-open-account-settings')
      .click();

    await expect(
      window.locator('[data-testid="settings-overlay"][data-open="true"]'),
    ).toBeVisible();
    await expect(window.getByTestId('app-main-shell')).toHaveAttribute(
      'aria-hidden',
      'true',
    );
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
