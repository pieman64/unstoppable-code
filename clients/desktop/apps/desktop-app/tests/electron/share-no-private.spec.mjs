import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import {
  registerShareMembership,
  SHARE_MEMBERSHIP_ORGANIZATION,
  seedAgentModels,
  seedTrackedPlans,
} from './seeders/index.mjs';
import { hostedSettingsScenario } from './seeders/hostedSettingsCloud.mjs';
import { defaultHostedSettingsOrganizations } from './mock-server/routes/hosted-settings-fixtures.mjs';

/**
 * The share dialogs have no Private audience. These flows cover what replaced
 * it: an account with no organization is offered organization setup instead
 * of a share that nobody else could see, Public is never picked on the
 * author's behalf, an organization without teams falls back to Organization,
 * and an owner can remove a public link (which also takes the item out of
 * shared lists).
 */

const AGENT_ID = 'agent_model_public_reviewer';
const AGENT_SHARE_ID = '7c3f9e42-2f19-4bc4-a43f-95e780f2e68f';
const PUBLIC_SHARE_ID = '81fb19b2-522b-43b4-b7f8-edbcc274dcdd';
const WORKSPACE_ID = 'demo-ts-pnpm-vite';
const WORKTREE_ID = 'demo-main';
const PLAN_ID = 'plan-no-private';
const PLAN_TITLE = 'Plan without a private audience';
const NOW = '2026-08-31T00:00:00.000Z';

const SEEDED_AGENTS = [
  {
    id: AGENT_ID,
    name: 'Public Reviewer',
    baseModel: 'sonnet',
    instructions: 'Review shared changes carefully and call out risky edges.',
    pluginSelections: {
      collectionIds: [],
      skillRefs: [],
      pluginRefs: [],
      mcpServerRefs: [],
    },
    createdAt: NOW,
    updatedAt: NOW,
  },
];

function makeTrackedPlan() {
  const content = `# ${PLAN_TITLE}\n\n- Share with a team or organization.`;
  return {
    id: PLAN_ID,
    projectId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    source: 'claude',
    title: PLAN_TITLE,
    content,
    reviewStatus: 'pending',
    createdAt: NOW,
    updatedAt: NOW,
    latestRevisionNumber: 1,
    revisions: [
      {
        revisionNumber: 1,
        content,
        source: 'claude',
        reviewStatus: 'pending',
        createdAt: NOW,
      },
    ],
    linkedExecutionIds: [],
  };
}

/** A user-owned agent with a public link, as the list endpoint returns it. */
function publicSharedAgent() {
  return {
    id: AGENT_SHARE_ID,
    name: 'Public Reviewer',
    modelId: AGENT_ID,
    baseModel: 'sonnet',
    instructionsPreview:
      'Review shared changes carefully and call out risky edges.',
    contentHash: 'agent-shared-e2e-hash',
    shareScope: 'private',
    owner: { type: 'user', id: 'account-e2e', name: 'Portal E2E' },
    createdAt: NOW,
    updatedAt: NOW,
    createdBy: { id: 'account-e2e', name: 'Portal E2E' },
    canUpdate: true,
    canDelete: true,
    publicShare: {
      externalId: PUBLIC_SHARE_ID,
      pinnedContentHash: 'agent-public-e2e-hash',
      upToDate: true,
      sharePath: `/portal/plugins/agents/${PUBLIC_SHARE_ID}`,
      createdAt: NOW,
      updatedAt: NOW,
    },
    agent: {
      version: 1,
      id: AGENT_ID,
      name: 'Public Reviewer',
      baseModel: 'sonnet',
      instructions: 'Review shared changes carefully and call out risky edges.',
      plugins: [],
    },
  };
}

async function launchSignedIn({ apiKey, userDataDir, env }) {
  const { electronApp } = await launchCanopy({ userDataDir, env });
  const window = await electronApp.firstWindow();
  const app = new CanopyAppDriver(window);
  await app.waitForShell({ timeout: 30_000 });
  const saved = await window.evaluate(
    (key) => window.api.saveCanopyCloudApiKey({ apiKey: key }),
    apiKey,
  );
  expect(saved.status).toMatchObject({ authenticated: true });
  await window.evaluate(() => {
    window.dispatchEvent(new Event('canopy:cloud-account-changed'));
  });
  return { electronApp, window, app };
}

/** A profile with the seeded agent, demo project and plan. */
function seedSoloProfile(prefix) {
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), prefix));
  seedAgentModels(userDataDir, SEEDED_AGENTS);
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedTrackedPlans({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    plans: [makeTrackedPlan()],
  });
  return userDataDir;
}

/**
 * Plans have no Public audience, so there is nothing to pick: the dialog
 * states how plans are shared and offers organization setup instead.
 */
async function openPlanShareWithoutOrganization(window, app) {
  await app.openMainPage();
  await app.selectWorktree(WORKTREE_ID);
  await expect(window.getByTestId('activity-plans-section')).toBeVisible({
    timeout: 30_000,
  });
  await window.getByTestId(`activity-plan-${PLAN_ID}-share`).click();
  const planModal = window.getByTestId('share-plan-modal');
  const required = planModal.getByTestId('share-plan-organization-required');
  await expect(required).toBeVisible({ timeout: 30_000 });
  await expect(required).toContainText(
    'Plans are shared with a team or organization. Set one up to start sharing.',
  );
  await expect(planModal.getByTestId('share-plan-scope')).toHaveCount(0);
  await expect(planModal.getByTestId('share-plan-submit')).toHaveCount(0);
  return planModal;
}

/**
 * Record main's signed-in web hand-off at the IPC boundary so the spec never
 * launches a browser.
 */
async function captureWebHandOffs(electronApp) {
  await electronApp.evaluate(({ ipcMain }) => {
    globalThis.__organizationSetupPaths = [];
    ipcMain.removeHandler('settings:open-authenticated-portal-page');
    ipcMain.handle(
      'settings:open-authenticated-portal-page',
      (_event, portalPath) => {
        globalThis.__organizationSetupPaths.push(portalPath);
        return true;
      },
    );
  });
  return () => electronApp.evaluate(() => globalThis.__organizationSetupPaths);
}

test('an account with no organization sees only the Public disclosure, or organization setup where Public is not offered', async () => {
  test.setTimeout(180_000);
  const apiKey = 'csk_share_no_private_solo_e2e';
  await registerShareMembership(apiKey, {
    organizations: [],
    teams: [],
    // Hosted Settings answers for the same account: only its Personal
    // organization, so organization setup has a page to open in-app.
    scenario: {
      hostedSettings: hostedSettingsScenario('hosted-settings-signed-in', {
        syncCloudAccount: false,
        overrides: {
          organizations: defaultHostedSettingsOrganizations().filter(
            (org) => org.isPersonal,
          ),
        },
      }).hostedSettings,
    },
  });
  const userDataDir = seedSoloProfile('canopy-share-no-private-solo-');

  const { electronApp, window, app } = await launchSignedIn({
    apiKey,
    userDataDir,
  });
  try {
    // Agents offer Public, and it is the only scope this account can use.
    // A single usable scope is not a choice, so the selector hides: no
    // legend, no pills, no setup or upgrade hint — only the Public
    // disclosure. Public is already selected, so Share works without a click.
    await app.openMarketplaceAgents();
    await app.openLocalAgentShare(AGENT_ID);
    const agentModal = window.getByTestId('share-agent-modal');
    await expect(
      agentModal.getByTestId('share-agent-scope-description'),
    ).toBeVisible({ timeout: 30_000 });
    await expect(agentModal.getByTestId('share-agent-scope')).toHaveCount(0);
    await expect(agentModal.locator('[role="radio"]')).toHaveCount(0);
    await expect(
      agentModal.getByTestId('share-agent-organization-hint'),
    ).toHaveCount(0);
    await expect(
      agentModal.getByTestId('share-agent-set-up-organization'),
    ).toHaveCount(0);
    await expect(agentModal.getByTestId('share-agent-submit')).toBeEnabled();
    await agentModal
      .getByRole('button', { name: 'Close', exact: true })
      .click();
    await expect(agentModal).toHaveCount(0);

    // With hosted settings available (the E2E default), organization setup
    // opens inside Settings and closes the dialog (CAN-4445); nothing goes
    // through the signed-in web hand-off.
    const planModal = await openPlanShareWithoutOrganization(window, app);
    const webHandOffs = await captureWebHandOffs(electronApp);
    await planModal.getByTestId('share-plan-set-up-organization').click();
    await expect(planModal).toHaveCount(0);
    await expect(
      window.locator(
        '[data-testid="hosted-settings-content"][data-hosted-settings-page="organizations/list"]',
      ),
    ).toBeVisible({ timeout: 20_000 });
    expect(await webHandOffs()).toEqual([]);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('without hosted settings, organization setup from a plan share opens signed in on the web', async () => {
  test.setTimeout(120_000);
  const apiKey = 'csk_share_no_private_solo_web_e2e';
  await registerShareMembership(apiKey, { organizations: [], teams: [] });
  const userDataDir = seedSoloProfile('canopy-share-no-private-solo-web-');

  const { electronApp, window, app } = await launchSignedIn({
    apiKey,
    userDataDir,
    env: {
      CANOPY_E2E_CLIENT_FEATURE_FLAGS: JSON.stringify({
        'canopy-desktop-hosted-settings': false,
      }),
    },
  });
  try {
    // The button asks main to open the web organization page through the
    // signed-in bridge.
    const planModal = await openPlanShareWithoutOrganization(window, app);
    const webHandOffs = await captureWebHandOffs(electronApp);
    await planModal.getByTestId('share-plan-set-up-organization').click();
    await expect.poll(webHandOffs).toEqual(['/organization']);
    await expect(
      planModal.getByTestId('share-plan-set-up-organization-error'),
    ).toHaveCount(0);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('an organization member with no team falls back to Organization', async () => {
  test.setTimeout(120_000);
  const apiKey = 'csk_share_no_private_org_only_e2e';
  await registerShareMembership(apiKey, {
    organizations: [SHARE_MEMBERSHIP_ORGANIZATION],
    teams: [],
  });
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-share-no-private-org-'),
  );
  seedAgentModels(userDataDir, SEEDED_AGENTS);

  const { electronApp, window, app } = await launchSignedIn({
    apiKey,
    userDataDir,
  });
  try {
    await app.openMarketplaceAgents();
    await app.openLocalAgentShare(AGENT_ID);
    const modal = window.getByTestId('share-agent-modal');
    await expect(modal.getByTestId('share-agent-scope')).toBeVisible({
      timeout: 30_000,
    });
    await expect(modal.getByTestId('share-agent-scope-team')).toBeDisabled();
    await expect(
      modal.getByTestId('share-agent-scope-organization'),
    ).toBeEnabled();
    await expect(
      modal.getByTestId('share-agent-scope-organization'),
    ).toHaveAttribute('aria-checked', 'true');
    await expect(modal.getByTestId('share-agent-scope-public')).toHaveAttribute(
      'aria-checked',
      'false',
    );
    // An organization is all Team is missing, so there is nothing to set up.
    await expect(
      modal.getByTestId('share-agent-organization-hint'),
    ).toHaveCount(0);
    await expect(
      modal.getByTestId('share-agent-set-up-organization'),
    ).toHaveCount(0);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('Remove public link asks first, unpublishes, and takes the agent out of shared lists', async () => {
  test.setTimeout(180_000);
  const apiKey = 'csk_share_no_private_remove_e2e';
  await registerShareMembership(apiKey, {
    scenario: { cloud: { sharedAgents: [publicSharedAgent()] } },
  });
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-share-no-private-remove-'),
  );
  seedAgentModels(userDataDir, SEEDED_AGENTS);

  const { electronApp, window, app } = await launchSignedIn({
    apiKey,
    userDataDir,
  });
  try {
    await app.openMarketplaceAgents();

    // Public-link visibility remains a server property. Marketplace lists
    // the local agent, while public-only shares have no separate discovery row.
    await expect
      .poll(() =>
        window.evaluate(
          async (id) =>
            (await window.agents.listShared({ limit: 100 })).agents.some(
              (agent) => agent.id === id,
            ),
          AGENT_SHARE_ID,
        ),
      )
      .toBe(true);
    await expect(
      window.getByTestId(`customize-row-agent:local:${AGENT_ID}`),
    ).toBeVisible();

    // Publish from the local agent so it records its cloud share, then reopen
    // the dialog on the existing public share.
    await app.openLocalAgentShare(AGENT_ID);
    const modal = window.getByTestId('share-agent-modal');
    await modal.getByTestId('share-agent-scope-public').click();
    await modal.getByTestId('share-agent-submit').click();
    await expect(modal).toHaveCount(0);
    const publicToast = window
      .getByTestId('toast-card')
      .filter({ hasText: 'Agent is now public' });
    await publicToast.getByTestId('toast-copy-link').click();
    await expect
      .poll(() => electronApp.evaluate(({ clipboard }) => clipboard.readText()))
      .toMatch(new RegExp(`/portal/plugins/agents/${PUBLIC_SHARE_ID}$`));

    await app.openLocalAgentShare(AGENT_ID);
    await expect(modal.getByTestId('share-agent-scope-public')).toHaveAttribute(
      'aria-checked',
      'true',
      { timeout: 30_000 },
    );
    const remove = modal.getByTestId('share-agent-remove-public-link');
    await expect(remove).toBeVisible();

    // Cancel keeps the link.
    await remove.click();
    const confirm = window.getByTestId(
      'share-agent-remove-public-link-confirm',
    );
    await expect(confirm).toBeVisible();
    await expect(confirm).toContainText(
      "Anyone with the link will lose access, and it won't show up in shared lists anymore.",
    );
    await confirm.getByTestId('share-agent-remove-public-link-cancel').click();
    await expect(confirm).toHaveCount(0);
    await expect(remove).toBeVisible();

    // Confirm removes it.
    await remove.click();
    await confirm
      .getByTestId('share-agent-remove-public-link-confirm-action')
      .click();
    await expect(confirm).toHaveCount(0);
    await expect(modal).toHaveCount(0);
    await expect(
      window
        .getByTestId('toast-card')
        .filter({ hasText: 'Public link removed' }),
    ).toBeVisible();

    // Without its link the agent is private-only, so it leaves shared lists.
    await app.openMarketplaceAgents();
    await expect
      .poll(() =>
        window.evaluate(
          async (id) =>
            (await window.agents.listShared({ limit: 100 })).agents.some(
              (agent) => agent.id === id,
            ),
          AGENT_SHARE_ID,
        ),
      )
      .toBe(false);
    await expect(
      window.getByTestId(`plugins-entry-agent:shared:${AGENT_SHARE_ID}`),
    ).toHaveCount(0, { timeout: 30_000 });
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
