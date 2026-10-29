import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import {
  DEFAULT_MOCK_BASE_URL,
  getScenarioActivity,
} from './seeders/index.mjs';

const SCOPED_PIPELINE_ID = '33333333-3333-4333-8333-333333333333';

function emitOpenUrl(electronApp, url) {
  return electronApp.evaluate(({ app }, targetUrl) => {
    app.emit('open-url', { preventDefault: () => {} }, targetUrl);
  }, url);
}

// CAN-3510: a share toast's Copy link and Open are peer actions, so both must
// render as the standard toast action button: same classes, same computed
// size/font/ink/border/padding, and an icon on each.
async function expectMatchedLinkActions(scope) {
  const copy = scope.getByTestId('toast-copy-link');
  const open = scope.getByTestId('toast-open-link');
  await expect(copy).toBeVisible();
  await expect(open).toBeVisible();
  const look = (locator) =>
    locator.evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        classes: [...element.classList].sort().join(' '),
        hasIcon: element.querySelector('svg') !== null,
        height: style.height,
        fontSize: style.fontSize,
        fontWeight: style.fontWeight,
        color: style.color,
        backgroundColor: style.backgroundColor,
        borderRadius: style.borderRadius,
        boxShadow: style.boxShadow,
        paddingLeft: style.paddingLeft,
        paddingRight: style.paddingRight,
      };
    });
  const copyLook = await look(copy);
  expect(copyLook.hasIcon).toBe(true);
  expect(await look(open)).toEqual(copyLook);
}

// Bundled pipelines are read-only, but sharing publishes the current pipeline
// as a snapshot copy under the sharer's account.
//
// Testids exercised:
//   - `workflows-library-filter-source`          -> Library Source capsule filter
//   - `workflows-library-row` (bundled-code-review-codex) -> opens read-only
//   - `pipeline-share`                           -> editor Share button
//   - `cloud-sync-modal`                         -> disconnected sign-in gate
//   - `share-pipeline-modal`                     -> Share Pipeline dialog
//   - `share-pipeline-scope`                     -> connected scope radiogroup
//   - `share-pipeline-dependencies`              -> packaged dependency review
//   - `share-pipeline-dependency-problems`       -> grouped publisher problem list
//   - `share-pipeline-dependencies-summary`      -> collapsed "Included files" summary
//   - `share-pipeline-submit`                    -> packaged Share action
//   - `toast-copy-link` / `toast-open-link`      -> matched share toast actions
test('bundled pipeline editor offers snapshot sharing', async () => {
  const { electronApp, userDataDir } = await launchCanopy({
    // The auth link the share toast's Open uses is gated by the portal flag,
    // which is off under E2E unless pinned.
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

    await window.getByTestId('workflows-library-filter-source').click();
    await window
      .getByTestId('workflows-library-filter-source-option-built-in')
      .click();
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

    await expect(shareModal).toHaveCount(0);
    const shareToast = window
      .getByTestId('toast-card')
      .filter({ hasText: 'Pipeline shared with Acme Release' });
    const scopedLink = shareToast.getByTestId('toast-copy-link');
    await expect(scopedLink).toBeVisible();
    await expectMatchedLinkActions(shareToast);
    await shareToast.getByRole('button', { name: 'Expand' }).click();
    const toastDetail = window.getByRole('dialog');
    await expect(toastDetail).toBeVisible();
    await expectMatchedLinkActions(toastDetail);
    await toastDetail.getByRole('button', { name: 'Close' }).click();
    await expect(toastDetail).toHaveCount(0);
    await scopedLink.click();
    await expect(scopedLink).toHaveText('Copied');
    await expect
      .poll(() => electronApp.evaluate(({ clipboard }) => clipboard.readText()))
      .toMatch(
        new RegExp(`/portal/plugins/pipelines/shared/${SCOPED_PIPELINE_ID}$`),
      );
    // An organization share needs the account's session to view, so Open
    // signs the browser in to this desktop's account on the way there.
    await shareToast.getByTestId('toast-open-link').click();
    await expect
      .poll(
        async () =>
          (
            await getScenarioActivity(
              DEFAULT_MOCK_BASE_URL,
              'csk_brady_scoped_links_e2e',
            )
          ).activity[
            `authLinkMint:/portal/plugins/pipelines/shared/${SCOPED_PIPELINE_ID}`
          ] ?? 0,
        { timeout: 20_000 },
      )
      .toBe(1);

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
    await window.getByTestId('workflows-library-filter-source').click();
    await window
      .getByTestId('workflows-library-filter-source-option-built-in')
      .click();
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
