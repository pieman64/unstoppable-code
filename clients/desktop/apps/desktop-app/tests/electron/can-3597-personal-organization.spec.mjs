import { startExternalOpenCapture } from './fixtures/external-open-capture.mjs';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { selectWorkspaceContext } from './workspaceContextMenu.mjs';
import {
  getScenarioActivity,
  clearScenario,
  connectMockCloudAccount,
  DEFAULT_MOCK_BASE_URL,
  registerScenario,
  seedOrgContextScoping,
  seedAgentModels,
  ORG_CONTEXT_A,
  ORG_CONTEXT_B,
  ORG_CONTEXT_ENV,
  ORG_CONTEXT_ORGANIZATIONS,
} from './seeders/index.mjs';

const agent = {
  id: 'aaaaaaaa-2962-5000-8000-000000000002',
  name: 'Organization A release',
  modelId: 'agent_model_org_release',
  contentHash: 'a'.repeat(64),
  publicShare: null,
  createdBy: { id: 'user', name: 'User' },
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:00.000Z',
  canUpdate: false,
  canDelete: false,
  shareScope: 'organization',
  owner: { type: 'organization', id: ORG_CONTEXT_A, name: 'Acme' },
  baseModel: 'sonnet',
  instructionsPreview: 'Organization-only release',
  agent: {
    version: 1,
    id: 'agent_model_org_release',
    name: 'Organization A release',
    baseModel: 'sonnet',
    instructions: 'Organization-only release',
    plugins: [],
  },
};

test('Personal-org agent appears in the Personal marketplace and is absent from a team', async () => {
  test.setTimeout(120_000);
  const key = 'csk_can3597_personal';
  await registerScenario(DEFAULT_MOCK_BASE_URL, key, {
    cloud: {
      organizations: [ORG_CONTEXT_ORGANIZATIONS[1]],
      personalOrganizationId: ORG_CONTEXT_A,
      sharedAgents: [
        {
          ...agent,
          name: 'Personal release agent',
          owner: { type: 'organization', id: ORG_CONTEXT_A, name: 'Personal' },
        },
      ],
    },
  });
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'canopy-can3597-'));
  seedOrgContextScoping(userDataDir);
  const external = await startExternalOpenCapture();
  const { electronApp } = await launchCanopy({
    userDataDir,
    env: { ...ORG_CONTEXT_ENV, ...external.env },
  });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await connectMockCloudAccount(window, key, {
      expectedAccount: { personalOrganizationId: ORG_CONTEXT_A },
    });
    const hostedRoute = () =>
      window.evaluate(
        () => window.__canopyNavigationTestApi?.settingsHostedRoute() ?? null,
      );
    const feedMints = async (organizationId) =>
      (await getScenarioActivity(DEFAULT_MOCK_BASE_URL, key)).activity[
        `authLinkMint:/organization/${organizationId}`
      ] ?? 0;
    // Timeline and Statistics are organization actions on the context
    // switcher at the top of the sidebar (CAN-4054, CAN-4445).
    await window.getByTestId('sidebar-context-row').click();
    await expect(
      window.getByTestId('account-personal-activity-row'),
    ).toHaveText('Timeline');
    await expect(
      window.getByTestId('account-context-statistics-row'),
    ).toBeVisible();
    await expect(window.getByTestId('account-organization-row')).toHaveCount(0);
    await window.getByTestId('account-personal-activity-row').click();
    // CAN-4445: with hosted settings the Timeline opens inside Settings, so
    // nothing is minted or opened externally.
    await expect(window.getByTestId('settings-overlay')).toBeVisible();
    await expect.poll(hostedRoute).toEqual({
      scope: 'organization',
      organizationId: ORG_CONTEXT_A,
      page: 'feed',
    });
    expect(await feedMints(ORG_CONTEXT_A)).toBe(0);
    expect(external.opened).toHaveLength(0);
    await app.closeSettings();
    await selectWorkspaceContext(window, 'personal');
    await app.openPluginsPage();
    await expect(
      window.getByText('Personal release agent', { exact: true }).first(),
    ).toBeVisible();
    await window.getByTestId(`plugins-entry-agent:shared:${agent.id}`).click();
    await expect(window.getByTestId('shared-agent-detail-audience')).toHaveText(
      'Personal',
    );
    await window.getByTestId('plugins-entry-detail-breadcrumb-root').click();
    await selectWorkspaceContext(window, ORG_CONTEXT_B);
    await expect(
      window.getByText('Personal release agent', { exact: true }),
    ).toHaveCount(0);
    // CAN-3977: in an organization context Timeline opens that
    // organization's Timeline, not the personal one, inside Settings (CAN-4445).
    await window.getByTestId('sidebar-context-row').click();
    await window.getByTestId('account-personal-activity-row').click();
    await expect(window.getByTestId('sidebar-context-menu')).toHaveCount(0);
    await expect(window.getByTestId('settings-overlay')).toBeVisible();
    await expect.poll(hostedRoute).toEqual({
      scope: 'organization',
      organizationId: ORG_CONTEXT_B,
      page: 'feed',
    });
    expect(await feedMints(ORG_CONTEXT_B)).toBe(0);
    expect(external.opened).toHaveLength(0);
    await app.closeSettings();
    await selectWorkspaceContext(window, 'personal');
    await expect(
      window.getByText('Personal release agent', { exact: true }).first(),
    ).toBeVisible();
  } finally {
    await closeCanopy(electronApp, userDataDir);
    await clearScenario(DEFAULT_MOCK_BASE_URL, key);
    await external.close();
  }
});

test('solo account retains the Personal audience when updating an existing agent share', async () => {
  test.setTimeout(120_000);
  const key = 'csk_can3597_personal_update';
  await registerScenario(DEFAULT_MOCK_BASE_URL, key, {
    cloud: {
      organizations: [],
      teams: [],
      personalOrganizationId: ORG_CONTEXT_A,
      sharedAgents: [
        {
          ...agent,
          canUpdate: true,
          createdBy: { id: 'account-e2e', name: 'Portal E2E' },
        },
      ],
    },
  });
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-personal-update-'),
  );
  seedAgentModels(userDataDir, [
    {
      ...agent.agent,
      remoteId: agent.id,
      remoteAccountId: 'account-e2e',
      pluginSelections: {
        collectionIds: [],
        skillRefs: [],
        pluginRefs: [],
        mcpServerRefs: [],
      },
      createdAt: agent.createdAt,
      updatedAt: agent.updatedAt,
    },
  ]);
  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await connectMockCloudAccount(window, key);
    await app.openMarketplaceAgents();
    await app.openLocalAgentShare(agent.modelId);
    const modal = window.getByTestId('share-agent-modal');
    await expect(modal.getByTestId('share-agent-submit')).toHaveText('Update');
    await expect(
      modal.getByTestId('share-agent-scope-organization'),
    ).toHaveAttribute('aria-checked', 'true');
    await expect(
      modal.getByTestId(
        'share-agent-organization-picker-option-' + ORG_CONTEXT_A,
      ),
    ).toContainText('Personal');
    await expect(
      modal.getByTestId('share-agent-organization-hint'),
    ).toHaveCount(0);
    await expect(modal.getByTestId('share-agent-submit')).toBeEnabled();
  } finally {
    await closeCanopy(electronApp, userDataDir);
    await clearScenario(DEFAULT_MOCK_BASE_URL, key);
  }
});
