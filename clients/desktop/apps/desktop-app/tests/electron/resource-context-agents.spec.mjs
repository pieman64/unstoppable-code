import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { selectWorkspaceContext } from './workspaceContextMenu.mjs';
import {
  clearScenario,
  connectMockCloudAccount,
  DEFAULT_MOCK_BASE_URL,
  registerScenario,
  seedOrgContextScoping,
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

async function setContextFromAnotherSurface(window, context) {
  await window.evaluate(async (next) => {
    const current = await window.api.workspaceContext.get();
    await window.api.workspaceContext.set({
      context: next,
      expectedRevision: current.revision,
    });
  }, context);
}

test('shared agent follows only its owning organization context', async () => {
  test.setTimeout(120_000);
  const key = 'csk_can2962_agents';
  await registerScenario(DEFAULT_MOCK_BASE_URL, key, {
    cloud: {
      organizations: ORG_CONTEXT_ORGANIZATIONS,
      sharedAgents: [agent],
    },
  });
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'canopy-can2962-'));
  seedOrgContextScoping(userDataDir);
  const { electronApp } = await launchCanopy({
    userDataDir,
    env: ORG_CONTEXT_ENV,
  });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await connectMockCloudAccount(window, key);
    await selectWorkspaceContext(window, ORG_CONTEXT_A);
    await app.openMarketplaceAgents();
    const row = window.getByTestId(`plugins-entry-agent:shared:${agent.id}`);
    await expect(row).toBeVisible();
    await window
      .getByTestId(`plugins-entry-add-agent:shared:${agent.id}`)
      .click();
    // CAN-3710: Install opens the shared install review.
    const review = window.getByTestId('deep-link-share-landing');
    const install = review.getByTestId('deep-link-share-install');
    await expect(review).toBeVisible();
    await expect(install).toBeEnabled();
    // The review outlives a context switch made elsewhere, but main refuses
    // to install the organization's agent outside its context.
    await setContextFromAnotherSurface(window, { kind: 'personal' });
    await install.click();
    await expect(review.getByTestId('share-install-blocker')).toBeVisible();
    await expect(review).toBeVisible();
    expect(
      await window.evaluate(async () =>
        (await window.api.getModelRegistry()).agents.some(
          (entry) => entry.id === 'agent_model_org_release',
        ),
      ),
    ).toBe(false);
    await window.keyboard.press('Escape');
    await expect(review).toHaveCount(0);
    await setContextFromAnotherSurface(window, {
      kind: 'organization',
      organizationId: ORG_CONTEXT_A,
    });
    await expect(row).toBeVisible();
    await window
      .getByTestId(`plugins-entry-add-agent:shared:${agent.id}`)
      .click();
    await install.click();
    await expect(review).toHaveCount(0, { timeout: 60_000 });
    await expect(
      window.getByTestId('local-agent-marketplace-detail'),
    ).toContainText('agent_model_org_release');
    await app.openMarketplaceAgents();
    const installed = window.getByTestId(
      'customize-row-agent:local:agent_model_org_release',
    );
    await expect(installed).toBeVisible();
    expect(
      await window.evaluate(async () =>
        (await window.api.getModelRegistry()).agents.some(
          (entry) => entry.id === 'agent_model_org_release',
        ),
      ),
    ).toBe(true);
    for (const context of ['personal', ORG_CONTEXT_B]) {
      await app.openMainPage();
      await selectWorkspaceContext(window, context);
      await app.openMarketplaceAgents();
      await expect(installed).toHaveCount(0);
      expect(
        await window.evaluate(async () =>
          (await window.api.getModelRegistry()).agents.some(
            (entry) => entry.id === 'agent_model_org_release',
          ),
        ),
      ).toBe(false);
      await app.openMarketplaceAgents();
      await expect(window.getByTestId('plugins-search')).toBeVisible();
      await expect(
        window.getByRole('heading', { name: 'No agents yet', exact: true }),
      ).toBeVisible();
      await expect(row).toHaveCount(0);
      const denied = await window.evaluate(async () => {
        try {
          await window.agents.getShared('aaaaaaaa-2962-5000-8000-000000000002');
          return false;
        } catch {
          return true;
        }
      });
      expect(denied).toBe(true);
      expect(
        await window.evaluate(async () => {
          try {
            await window.agents.get('agent_model_org_release');
            return false;
          } catch {
            return true;
          }
        }),
      ).toBe(true);
    }
  } finally {
    await closeCanopy(electronApp, userDataDir);
    await clearScenario(DEFAULT_MOCK_BASE_URL, key);
  }
});
