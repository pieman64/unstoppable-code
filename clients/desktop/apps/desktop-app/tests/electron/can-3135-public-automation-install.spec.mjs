import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import {
  registerShareMembership,
  SHARE_MEMBERSHIP_ORGANIZATION,
  seedAutomations,
  seedStoredPipeline,
  ORG_CONTEXT_ENV,
} from './seeders/index.mjs';

/**
 * CAN-3135 — a public automation link installs instead of dead-ending on a
 * Close button. CAN-3651 — the link opens straight into the install review,
 * and its one click installs and enables the copy. Covers: arriving writes
 * nothing, the review has no Cancel, the copy is created ENABLED, a second
 * arrival reads as already-installed rather than duplicating, an out-of-date
 * copy opens straight into its update review, and a republished share is
 * rejected as share-changed.
 */

const AUTOMATION_ID = 'shareable-nightly-review';
const SCOPED_AUTOMATION_ID = 'c1f5d3a2-7b6e-4c2d-9a1b-0e8f7d6c5b4a';
const PUBLIC_SHARE_ID = '9e8d7c6b-5a4f-4e3d-8c2b-1a0f9e8d7c6b';
const CONTENT_HASH = 'a1'.repeat(32);
const UPDATED_CONTENT_HASH = `b2${'a1'.repeat(31)}`;

/**
 * CAN-3651: after a share-link install the app lands on Workflows ›
 * Library (CAN-3981) with the exact copy revealed and turned on.
 */
async function expectRevealedAutomation(window, activityId, outcome) {
  await expect(window.getByTestId('page-workflows-library')).toBeVisible();
  await expect(
    window.getByTestId('workflows-tab-workflows-library'),
  ).toHaveAttribute('aria-selected', 'true');
  // The Workflows sidebar row reads as selected (`SidebarNavRow`).
  await expect(window.getByTestId('sidebar-nav-workflows')).toHaveClass(
    /\bbg-muted\b/,
  );
  const notice = window.getByTestId('automations-installed-notice');
  await expect(notice).toContainText(
    outcome === 'installed' ? 'Automation installed' : 'Automation updated',
  );
  const row = new CanopyAppDriver(window).workflowsLibraryAutomationRow(
    activityId,
  );
  await expect(row).toHaveAttribute('data-highlighted', 'true');
  await expect(row).toBeFocused();
  await expect(window.locator('[data-highlighted="true"]')).toHaveCount(1);
  if (outcome === 'installed') {
    await expect(notice).toContainText("It's on.");
    await expect(row.getByTestId('workflows-library-toggle')).toHaveAttribute(
      'aria-checked',
      'true',
    );
  }
}

const ACTIVITIES = [
  {
    version: 1,
    id: AUTOMATION_ID,
    name: 'Nightly review pipeline',
    enabled: false,
    schedule: { kind: 'cron', expression: '0 2 * * *', timezone: 'local' },
    action: {
      type: 'worktree_pipeline',
      workspaceId: 'workspace-e2e',
      pipelineId: 'can-3135-user-review',
      pipelineSource: 'user',
      pipelineName: 'CAN-3135 user review',
    },
    createdAt: '2026-08-19T12:00:00.000Z',
    updatedAt: '2026-08-19T12:00:00.000Z',
    failureCount: 0,
  },
];

function emitOpenUrl(electronApp, url) {
  return electronApp.evaluate(({ app }, targetUrl) => {
    app.emit('open-url', { preventDefault: () => {} }, targetUrl);
  }, url);
}

test('installs an automation from a public link and refuses a stale pin', async () => {
  // Re-sharing the installed copy needs an audience: this account belongs to
  // one organization and no team, so Organization is preselected.
  await registerShareMembership('csk_can3135_public_automation_install', {
    teams: [],
  });
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'can-3135-public-automation-install-'),
  );
  seedAutomations({ userDataDir, activities: ACTIVITIES });
  seedStoredPipeline({
    userDataDir,
    id: 'can-3135-user-review',
    name: 'CAN-3135 user review',
    // Valid noncanonical YAML: the packaged pipeline must install these
    // bytes verbatim, so re-serialization is detectable when the installed
    // copy is executed.
    yaml: [
      '# preserve shared-pipeline bytes',
      'pipeline:',
      '  name: CAN-3135 user review',
      '  on: dispatch',
      '  dependencies:',
      '    - id: linear-review',
      '      kind: mcp',
      '      required: true',
      '      server: { catalog_id: linear }',
      '      steps: [inspect]',
      '  jobs:',
      '    review:',
      '      steps:',
      '        - id: inspect',
      '          run: echo review',
      '',
    ].join('\n'),
  });
  const { electronApp } = await launchCanopy({ userDataDir });

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    const account = await window.evaluate(() =>
      window.api.saveCanopyCloudApiKey({
        apiKey: 'csk_can3135_public_automation_install',
      }),
    );
    expect(account.status).toMatchObject({ authenticated: true });
    await window.evaluate(() => {
      window.dispatchEvent(new Event('canopy:cloud-account-changed'));
    });

    // Publish a public link from the local automation's share dialog.
    await app.openAutomationsPage();
    await app.chooseWorkflowsLibraryRowAction(
      app.workflowsLibraryAutomationRow(AUTOMATION_ID),
      'share',
    );
    const shareModal = window.getByTestId('share-automation-modal');
    await shareModal
      .getByTestId('share-automation-scope')
      .getByRole('radio', { name: 'Public' })
      .click();
    await shareModal.getByTestId('share-automation-submit').click();
    // The dialog stays open on its success notice with the link and Copy
    // link; no share toast is raised.
    await expect(
      shareModal.getByTestId('share-automation-success'),
    ).toContainText('Automation is now public');
    await expect(shareModal.getByTestId('share-automation-link')).toBeVisible();
    await expect(
      shareModal.getByTestId('share-automation-copy-link'),
    ).toBeVisible();
    await expect(
      window
        .getByTestId('toast-card')
        .filter({ hasText: 'Automation is now public' }),
    ).toHaveCount(0);
    await shareModal.getByTestId('share-automation-done').click();
    await expect(shareModal).toHaveCount(0);

    // The same document's team-scoped web CTA uses the authenticated shared
    // automation id, not the anonymous public-share id. Exercise that complete
    // handoff before continuing through the public install flow.
    const scopedDetail = await window.evaluate(
      (automationId) => window.api.automations.getShared(automationId),
      SCOPED_AUTOMATION_ID,
    );
    await emitOpenUrl(
      electronApp,
      `canopy://share/automations/${SCOPED_AUTOMATION_ID}?audience=TEAM&intent=install&expectedAutomationContentHash=${scopedDetail.contentHash}`,
    );
    // CAN-3651: the link opens straight into the install review.
    const scopedLanding = window.getByTestId('deep-link-share-landing');
    const scopedWizard = window.getByTestId('install-shared-automation-modal');
    await expect(scopedWizard).toContainText('Nightly review pipeline');
    await expect(scopedLanding).toHaveCount(0);
    await scopedWizard
      .getByTestId('install-automation-workspace')
      .selectOption({ index: 1 });
    await scopedWizard.getByTestId('install-automation-submit').click();
    // CAN-3651: completion closes the wizard and the landing on its own and
    // reveals the exact new copy on Workflows › Library.
    await expect(scopedWizard).toHaveCount(0);
    await expect(scopedLanding).toHaveCount(0);
    const scopedInstalledId = await window.evaluate(async (remoteId) => {
      const result = await window.api.automations.list();
      const copies = result.activities.filter(
        (activity) => activity.installedFrom?.remoteId === remoteId,
      );
      return copies.length === 1 ? copies[0].id : null;
    }, SCOPED_AUTOMATION_ID);
    expect(scopedInstalledId).not.toBeNull();
    await expectRevealedAutomation(window, scopedInstalledId, 'installed');
    await emitOpenUrl(
      electronApp,
      `canopy://share/automations/${SCOPED_AUTOMATION_ID}?audience=TEAM&expectedAutomationContentHash=${scopedDetail.contentHash}`,
    );
    const installedScopedLanding = window.getByTestId(
      'deep-link-share-landing',
    );
    await expect(
      installedScopedLanding.getByTestId('deep-link-share-installed-status'),
    ).toBeVisible();
    await window.keyboard.press('Escape');
    await expect(installedScopedLanding).toHaveCount(0);

    // Arrive on the public link with an explicit install intent.
    await emitOpenUrl(
      electronApp,
      `canopy://share/automations/${PUBLIC_SHARE_ID}?intent=install&expectedAutomationContentHash=${CONTENT_HASH}`,
    );
    // The link opens the review, not a write: an install is a rebind, so
    // its one explicit click is the install.
    const wizard = window.getByTestId('install-shared-automation-modal');
    await expect(wizard).toContainText('Nightly review pipeline');
    await expect(
      wizard.getByRole('button', { name: 'Cancel', exact: true }),
    ).toHaveCount(0);
    const beforeCount = await window.evaluate(async () => {
      const result = await window.api.automations.list();
      return result.activities.length;
    });
    expect(beforeCount).toBe(2);
    // CAN-3710: the review stays light; packaged dependencies are not listed.
    await expect(
      wizard.getByTestId('install-automation-package-readiness'),
    ).toHaveCount(0);
    // Swap, not nest: the landing shell is replaced.
    await expect(window.getByTestId('deep-link-share-landing')).toHaveCount(0);

    // Exercise the public package endpoint directly as well as through the
    // wizard so a malformed fixture or an authenticated-endpoint regression
    // reports its actual IPC error instead of only leaving Submit disabled.
    const readiness = await window.evaluate(
      async ({ externalId, contentHash }) => {
        const resolved = await window.api.deepLinkResolveShare({
          entity: 'automation',
          externalId,
          expectedAutomationContentHash: contentHash,
        });
        if (!resolved.ok || resolved.snapshot.entity !== 'automation') {
          throw new Error('Public automation snapshot did not resolve.');
        }
        const packageRef = resolved.snapshot.automation.capabilityPackage;
        if (!packageRef) throw new Error('Public automation package missing.');
        return window.api.automations.getCapabilityPackageReadiness({
          remoteId: externalId,
          packageRef,
          publicShare: true,
        });
      },
      { externalId: PUBLIC_SHARE_ID, contentHash: CONTENT_HASH },
    );
    expect(readiness.status).toBe('setup_required');
    expect(readiness.requirements).toEqual([
      expect.objectContaining({
        id: 'linear-review',
        status: 'missing',
      }),
    ]);

    await wizard
      .getByTestId('install-automation-workspace')
      .selectOption({ index: 1 });
    await wizard.getByTestId('install-automation-submit').click();
    await expect(wizard).toHaveCount(0);
    await expect(window.getByTestId('deep-link-share-landing')).toHaveCount(0);

    // The created copy carries public provenance and is turned on.
    const installed = await window.evaluate(async () => {
      const result = await window.api.automations.list();
      return result.activities
        .filter((activity) => activity.installedFrom?.sourceKind === 'public')
        .map((activity) => ({
          id: activity.id,
          enabled: activity.enabled,
          sourceKind: activity.installedFrom.sourceKind,
          remoteId: activity.installedFrom.remoteId,
          bundledPipelineLocalId: activity.installedFrom.bundledPipelineLocalId,
          pipelineId: activity.action.pipelineId,
          pipelineSource: activity.action.pipelineSource,
          capabilityPackage: activity.installedFrom.capabilityPackage,
        }));
    });
    expect(installed).toHaveLength(1);
    expect(installed[0]).toMatchObject({
      enabled: true,
      sourceKind: 'public',
      remoteId: PUBLIC_SHARE_ID,
      pipelineSource: 'user',
      capabilityPackage: { version: 1 },
    });
    expect(installed[0].bundledPipelineLocalId).toBe(installed[0].pipelineId);
    await expectRevealedAutomation(window, installed[0].id, 'installed');
    const installedPipelines = await window.evaluate(() =>
      window.pipelines.list(),
    );
    expect(
      installedPipelines.data?.some(
        (pipeline) => pipeline.id === installed[0].bundledPipelineLocalId,
      ),
    ).toBe(true);
    const installedPipeline = await window.evaluate(
      (pipelineId) => window.pipelines.get({ id: pipelineId, source: 'user' }),
      installed[0].bundledPipelineLocalId,
    );
    expect(installedPipeline.data?.rawContent).toContain(
      '# preserve shared-pipeline bytes',
    );

    // Running the installed copy must use the materialized pipeline and its
    // automation-owned package; it must not fall back to a rebind prompt or
    // fetch the author's authenticated shared-pipeline endpoint.
    const run = await window.evaluate(
      (id) => window.api.automations.runNow({ id }),
      installed[0].id,
    );
    expect(run).toMatchObject({ ok: true, run: { status: 'success' } });

    // Editing the materialized pipeline invalidates the package installed for
    // its original bytes. Re-sharing must fail before uploading that stale
    // package, otherwise recipients can install a copy that fails every run.
    const editedPipeline = await window.evaluate(async (pipelineId) => {
      const current = await window.pipelines.get({
        id: pipelineId,
        source: 'user',
      });
      if (!current.success || !current.data) {
        throw new Error(
          current.error ?? 'Installed pipeline could not be read',
        );
      }
      return window.pipelines.save({
        id: pipelineId,
        name: current.data.info.name,
        description: 'Edited after installing the automation',
        icon: current.data.info.icon,
        content: {
          ...current.data.content,
          description: 'Edited after installing the automation',
        },
      });
    }, installed[0].bundledPipelineLocalId);
    expect(editedPipeline.success).toBe(true);
    await app.openAutomationsPage();
    await app.chooseWorkflowsLibraryRowAction(
      app.workflowsLibraryAutomationRow(installed[0].id),
      'share',
    );
    const installedShareModal = window.getByTestId('share-automation-modal');
    await installedShareModal
      .getByTestId(
        `share-automation-organization-picker-option-${SHARE_MEMBERSHIP_ORGANIZATION.id}`,
      )
      .click();
    // The installed package travels with the share without a consent step.
    await expect(
      installedShareModal.getByTestId('share-automation-consent'),
    ).toHaveCount(0);
    await expect(
      installedShareModal.getByTestId('share-automation-submit'),
    ).toBeEnabled();
    await installedShareModal.getByTestId('share-automation-submit').click();
    await expect(installedShareModal.getByRole('alert')).toContainText(
      'The automation changed since this capability package was installed.',
    );
    await window.keyboard.press('Escape');
    await expect(installedShareModal).toHaveCount(0);

    // A second arrival reads as already installed rather than duplicating.
    await emitOpenUrl(
      electronApp,
      `canopy://share/automations/${PUBLIC_SHARE_ID}?expectedAutomationContentHash=${CONTENT_HASH}`,
    );
    const second = window.getByTestId('deep-link-share-landing');
    await expect(
      second.getByTestId('deep-link-share-installed-status'),
    ).toBeVisible();
    await expect(second.getByTestId('deep-link-share-install')).toHaveCount(0);
    // An installed automation offers to open it (CAN-3710); dismiss the
    // review without navigating.
    await expect(second.getByTestId('deep-link-share-open')).toHaveText(
      'Open automation',
    );
    await window.keyboard.press('Escape');
    await expect(second).toHaveCount(0);

    // Publish a real automation update after changing the author's source
    // pipeline. The installed copy is now stale, but its materialized pipeline
    // contains the recipient edit above and must not be overwritten.
    const updatedAuthorPipeline = await window.evaluate(async () => {
      const current = await window.pipelines.get({
        id: 'can-3135-user-review',
        source: 'user',
      });
      if (!current.success || !current.data) {
        throw new Error(current.error ?? 'Author pipeline could not be read');
      }
      return window.pipelines.save({
        id: current.data.info.id,
        name: current.data.info.name,
        description: 'Updated by the author',
        icon: current.data.info.icon,
        content: {
          ...current.data.content,
          description: 'Updated by the author',
        },
      });
    });
    expect(updatedAuthorPipeline.success).toBe(true);
    await app.openAutomationsPage();
    await app.chooseWorkflowsLibraryRowAction(
      app.workflowsLibraryAutomationRow(AUTOMATION_ID),
      'share',
    );
    const updateShareModal = window.getByTestId('share-automation-modal');
    await expect(
      updateShareModal.getByTestId('share-automation-submit'),
    ).toBeEnabled();
    await updateShareModal.getByTestId('share-automation-submit').click();
    // The dialog stays open on its success notice with the link and Copy
    // link; no share toast is raised.
    await expect(
      updateShareModal.getByTestId('share-automation-success'),
    ).toContainText('Automation updated');
    await expect(
      updateShareModal.getByTestId('share-automation-link'),
    ).toBeVisible();
    await expect(
      updateShareModal.getByTestId('share-automation-copy-link'),
    ).toBeVisible();
    await expect(
      window
        .getByTestId('toast-card')
        .filter({ hasText: 'Automation updated' }),
    ).toHaveCount(0);
    await updateShareModal.getByTestId('share-automation-done').click();
    await expect(updateShareModal).toHaveCount(0);

    await emitOpenUrl(
      electronApp,
      `canopy://share/automations/${PUBLIC_SHARE_ID}?expectedAutomationContentHash=${UPDATED_CONTENT_HASH}`,
    );
    // An out-of-date copy opens straight into its update review.
    const updateWizard = window.getByTestId('install-shared-automation-modal');
    await expect(window.getByTestId('deep-link-share-landing')).toHaveCount(0);
    await expect(
      updateWizard.getByTestId('install-automation-submit'),
    ).toHaveText('Apply update');
    // The review's dry run of the packaged pipeline refuses the update
    // before it can be applied.
    await expect(
      updateWizard.getByTestId('install-automation-pipelines-blocked'),
    ).toContainText('local changes');
    await expect(
      updateWizard.getByTestId('install-automation-submit'),
    ).toBeDisabled();
    const preserved = await window.evaluate(
      async ({ activityId, pipelineId }) => {
        const [activities, pipeline] = await Promise.all([
          window.api.automations.list(),
          window.pipelines.get({ id: pipelineId, source: 'user' }),
        ]);
        return {
          installedContentHash: activities.activities.find(
            (activity) => activity.id === activityId,
          )?.installedFrom?.contentHash,
          pipelineDescription: pipeline.data?.content.description,
        };
      },
      {
        activityId: installed[0].id,
        pipelineId: installed[0].bundledPipelineLocalId,
      },
    );
    expect(preserved).toEqual({
      installedContentHash: CONTENT_HASH,
      pipelineDescription: 'Edited after installing the automation',
    });
    await window.keyboard.press('Escape');
    await expect(updateWizard).toHaveCount(0);
    // Dismissing the review closes the link too.
    await expect(window.getByTestId('deep-link-share-landing')).toHaveCount(0);

    // Once the local pipeline edits are deliberately restored, the same
    // shared update succeeds in place and preserves a recipient-enabled copy.
    const restored = await window.evaluate(
      ({ pipeline, activityId }) =>
        window.pipelines
          .save({
            id: pipeline.info.id,
            name: pipeline.info.name,
            description: pipeline.info.description,
            icon: pipeline.info.icon,
            content: pipeline.content,
            rawContent: pipeline.rawContent,
          })
          .then(async (saved) => ({
            saved,
            enabled: await window.api.automations.update({
              id: activityId,
              enabled: true,
            }),
          })),
      { pipeline: installedPipeline.data, activityId: installed[0].id },
    );
    expect(restored.saved.success).toBe(true);
    expect(restored.enabled.ok).toBe(true);
    await emitOpenUrl(
      electronApp,
      `canopy://share/automations/${PUBLIC_SHARE_ID}?expectedAutomationContentHash=${UPDATED_CONTENT_HASH}`,
    );
    await expect(
      updateWizard.getByTestId('install-automation-submit'),
    ).toBeEnabled();
    await updateWizard.getByTestId('install-automation-submit').click();
    await expect(updateWizard).toHaveCount(0);
    await expect(window.getByTestId('deep-link-share-landing')).toHaveCount(0);
    await expectRevealedAutomation(window, installed[0].id, 'updated');
    await expect(
      window.getByTestId('automations-installed-notice'),
    ).toContainText("It's still on.");
    const updatedCopies = await window.evaluate(
      async (remoteId) =>
        (await window.api.automations.list()).activities.filter(
          (entry) =>
            entry.installedFrom?.remoteId === remoteId &&
            entry.installedFrom?.sourceKind === 'public',
        ),
      PUBLIC_SHARE_ID,
    );
    expect(updatedCopies).toHaveLength(1);
    expect(updatedCopies[0]).toMatchObject({
      id: installed[0].id,
      enabled: true,
      installedFrom: { contentHash: UPDATED_CONTENT_HASH },
    });
    await window.getByTestId('automations-installed-notice-dismiss').click();
    await expect(window.locator('[data-highlighted="true"]')).toHaveCount(0);
    await emitOpenUrl(
      electronApp,
      `canopy://share/automations/${PUBLIC_SHARE_ID}?expectedAutomationContentHash=${UPDATED_CONTENT_HASH}`,
    );
    await expect(
      window.getByTestId('deep-link-share-installed-status'),
    ).toBeVisible();
    await expect(window.getByTestId('deep-link-share-update')).toHaveCount(0);
    await window.keyboard.press('Escape');

    // The republished share re-pins, so the original link is share-changed.
    await emitOpenUrl(
      electronApp,
      `canopy://share/automations/${PUBLIC_SHARE_ID}?expectedAutomationContentHash=${CONTENT_HASH}`,
    );
    const stale = window.getByTestId('deep-link-share-landing');
    await expect(stale).toContainText('This share changed');
    await expect(stale.getByTestId('deep-link-share-install')).toHaveCount(0);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('share completion follows a replacement of the list refresh already in flight', async () => {
  const apiKey = 'csk_can3651_inflight_refresh';
  await registerShareMembership(apiKey, { teams: [] });
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'can-3651-refresh-'));
  seedAutomations({
    userDataDir,
    activities: [
      ...ACTIVITIES.map((activity) => ({
        ...activity,
        action: {
          ...activity.action,
          pipelineId: 'shared:canopy-cloud:shared-dispatch',
          pipelineSource: 'shared',
          sharedPipeline: {
            serverId: 'canopy-cloud',
            remoteId: 'shared-dispatch',
          },
        },
        sharedPipelineReview: {
          detectedAt: '2026-09-26T12:00:00.000Z',
          remoteId: 'shared-dispatch',
        },
      })),
      ...Array.from({ length: 40 }, (_, index) => ({
        ...ACTIVITIES[0],
        id: `filler-${index}`,
        name: `A long automation name ${index.toString().padStart(2, '0')} ${'with more details '.repeat(12)}`,
        enabled: false,
      })),
    ],
  });
  const { electronApp } = await launchCanopy({
    userDataDir,
    env: ORG_CONTEXT_ENV,
  });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await window.evaluate(
      (key) => window.api.saveCanopyCloudApiKey({ apiKey: key }),
      apiKey,
    );
    await window.evaluate(() =>
      window.dispatchEvent(new Event('canopy:cloud-account-changed')),
    );
    await window.evaluate(() => {
      localStorage.setItem('canopy.automations.viewMode', 'calendar');
      localStorage.setItem(
        'canopy.automations.triggeredSort',
        JSON.stringify({ column: 'name', direction: 'asc' }),
      );
    });
    await app.openAutomationsPage();
    const detail = await window.evaluate(
      (id) => window.api.automations.getShared(id),
      SCOPED_AUTOMATION_ID,
    );
    await emitOpenUrl(
      electronApp,
      `canopy://share/automations/${SCOPED_AUTOMATION_ID}?audience=TEAM&expectedAutomationContentHash=${detail.contentHash}`,
    );
    const wizard = window.getByTestId('install-shared-automation-modal');
    await wizard
      .getByTestId('install-automation-workspace')
      .selectOption({ index: 1 });
    await expect(wizard.getByTestId('install-automation-submit')).toBeEnabled();

    // Delay the existing production list handler, preserving its real payload.
    // A broadcast initiates refresh before the reviewed install completes.
    await electronApp.evaluate(({ ipcMain, BrowserWindow }) => {
      const original = ipcMain._invokeHandlers.get('automations:list');
      if (!original) throw new Error('automations:list handler missing');
      let release;
      let gate = new Promise((resolve) => {
        release = resolve;
      });
      const mainWindow = BrowserWindow.getAllWindows()[0];
      const originalSend = mainWindow.webContents.send.bind(
        mainWindow.webContents,
      );
      let broadcasts = 0;
      mainWindow.webContents.send = (channel, ...args) => {
        if (channel === 'automations:changed') broadcasts += 1;
        return originalSend(channel, ...args);
      };
      globalThis.can3651Refresh = {
        calls: 0,
        completed: 0,
        release,
        holdReplacement: () => {
          gate = new Promise((resolve) => {
            globalThis.can3651Refresh.releaseReplacement = resolve;
          });
        },
        original,
        getBroadcasts: () => broadcasts,
      };
      ipcMain.removeHandler('automations:list');
      ipcMain.handle('automations:list', async (...args) => {
        globalThis.can3651Refresh.calls += 1;
        const requestGate = gate;
        await requestGate;
        const snapshot = await original(...args);
        globalThis.can3651Refresh.completed += 1;
        return snapshot;
      });
    });
    await window.evaluate(
      (id) =>
        window.api.automations.update({ id, name: 'Refresh in progress' }),
      AUTOMATION_ID,
    );
    await expect
      .poll(() => electronApp.evaluate(() => globalThis.can3651Refresh.calls))
      .toBeGreaterThanOrEqual(1);
    const initial = await electronApp.evaluate(() => ({
      calls: globalThis.can3651Refresh.calls,
      broadcasts: globalThis.can3651Refresh.getBroadcasts(),
    }));
    await wizard.getByTestId('install-automation-submit').click();
    await expect(wizard).toHaveCount(0);
    await expect(window.getByTestId('deep-link-share-landing')).toHaveCount(0);
    // The reveal has joined A. A later broadcast replaces it with B; A must
    // not finish the reveal before B publishes the installed activity.
    const supersededCalls = await electronApp.evaluate(() => {
      const state = globalThis.can3651Refresh;
      state.holdReplacement();
      return state.calls;
    });
    await window.evaluate(
      (id) =>
        window.api.automations.update({ id, name: 'Replacement refresh' }),
      AUTOMATION_ID,
    );
    await expect
      .poll(() => electronApp.evaluate(() => globalThis.can3651Refresh.calls))
      .toBeGreaterThan(supersededCalls);
    await electronApp.evaluate(() => globalThis.can3651Refresh.release());
    await expect
      .poll(() =>
        electronApp.evaluate(() => globalThis.can3651Refresh.completed),
      )
      .toBe(supersededCalls);
    await window.evaluate(
      () =>
        new Promise((resolve) => {
          requestAnimationFrame(() => requestAnimationFrame(resolve));
        }),
    );
    const calls = await electronApp.evaluate(({ ipcMain }) => {
      const state = globalThis.can3651Refresh;
      state.releaseReplacement();
      ipcMain.removeHandler('automations:list');
      ipcMain.handle('automations:list', state.original);
      return { calls: state.calls, broadcasts: state.getBroadcasts() };
    });
    // Existing bridge subscribers each refresh on a broadcast. Joining from
    // completion must add no list request beyond those existing subscribers.
    expect(calls.calls).toBe(
      (initial.calls * calls.broadcasts) / initial.broadcasts,
    );
    const installedId = await window.evaluate(async (remoteId) => {
      const { activities } = await window.api.automations.list();
      return activities.find(
        (entry) => entry.installedFrom?.remoteId === remoteId,
      )?.id;
    }, SCOPED_AUTOMATION_ID);
    expect(installedId).toBeTruthy();
    await expectRevealedAutomation(window, installedId, 'installed');
    expect(
      await window.evaluate(() =>
        localStorage.getItem('canopy.automations.viewMode'),
      ),
    ).toBe('calendar');
    await window.keyboard.press('Tab');
    expect(
      await window.evaluate(() =>
        document.activeElement
          ?.closest('[data-highlighted="true"]')
          ?.getAttribute('data-row-key'),
      ),
    ).toBe(`automation:${installedId}`);

    // The fresh copy has no execution context yet. Changing the selected
    // context hides its row but must retain success and name the saved target.
    await window.evaluate(async (organizationId) => {
      const current = await window.api.workspaceContext.get();
      await window.api.workspaceContext.set({
        context: { kind: 'organization', organizationId },
        expectedRevision: current.revision,
      });
    }, SHARE_MEMBERSHIP_ORGANIZATION.id);
    await expect(
      window.getByTestId('automations-installed-notice'),
    ).toContainText('Runs in Personal');
    await expect(app.workflowsLibraryAutomationRow(installedId)).toHaveCount(0);
    expect(
      await window.evaluate(() =>
        localStorage.getItem('canopy.automations.viewMode'),
      ),
    ).toBe('calendar');
    await window.evaluate(async () => {
      const current = await window.api.workspaceContext.get();
      await window.api.workspaceContext.set({
        context: { kind: 'personal' },
        expectedRevision: current.revision,
      });
    });
    await expect(
      app.workflowsLibraryAutomationRow(installedId),
    ).toHaveAttribute('data-highlighted', 'true');

    // A later status change is newer than the old snapshot still in transit.
    // Release those responses last and verify the live completion copy stays
    // off: the older snapshot still says on.
    await electronApp.evaluate(({ ipcMain }, heldCount) => {
      const original = ipcMain._invokeHandlers.get('automations:list');
      let release;
      const gate = new Promise((resolve) => {
        release = resolve;
      });
      globalThis.can3651Refresh = { calls: 0, release, original, holding: 0 };
      ipcMain.removeHandler('automations:list');
      ipcMain.handle('automations:list', async (...args) => {
        const call = ++globalThis.can3651Refresh.calls;
        const snapshot = await original(...args);
        if (call <= heldCount) {
          globalThis.can3651Refresh.holding += 1;
          await gate;
        }
        return snapshot;
      });
    }, initial.calls);
    await window.evaluate(
      (id) => window.api.automations.update({ id, name: 'Older snapshot' }),
      AUTOMATION_ID,
    );
    await expect
      .poll(() => electronApp.evaluate(() => globalThis.can3651Refresh.holding))
      .toBe(initial.calls);
    await window.evaluate(
      (id) => window.api.automations.update({ id, enabled: false }),
      installedId,
    );
    await expect
      .poll(() => electronApp.evaluate(() => globalThis.can3651Refresh.calls))
      .toBeGreaterThan(initial.calls);
    const notice = window.getByTestId('automations-installed-notice');
    await expect(notice).toContainText("It's turned off until you enable it.");
    await electronApp.evaluate(({ ipcMain }) => {
      const state = globalThis.can3651Refresh;
      state.release();
      ipcMain.removeHandler('automations:list');
      ipcMain.handle('automations:list', state.original);
    });
    await expect(app.workflowsLibraryAutomationRow(installedId)).toBeVisible();
    await expect(notice).toContainText("It's turned off until you enable it.");
    // Run on a row that needs review opens the review instead, without a row
    // click. It must end the installed copy's cue.
    await app
      .workflowsLibraryAutomationRow(AUTOMATION_ID)
      .getByTestId('workflows-library-run')
      .click();
    await expect(
      window.getByTestId('shared-pipeline-review-modal'),
    ).toBeVisible();
    await expect(notice).toHaveCount(0);
    await expect(window.locator('[data-highlighted="true"]')).toHaveCount(0);
  } finally {
    await electronApp.evaluate(() => globalThis.can3651Refresh?.release());
    await closeCanopy(electronApp, userDataDir);
  }
});
