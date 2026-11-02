// CAN-4266: local agents are managed in Marketplace › Agents, beside the
// agents shared with the viewer, now that the Agents page is retired. Seeded
// and offline: shared agents come from the mock cloud.
//
//   npm run test:electron:built -- marketplace-agents.spec.mjs --reporter=line
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { selectModelOption } from './model-selection-fixture.mjs';
import {
  clearScenario,
  connectMockCloudAccount,
  DEFAULT_MOCK_BASE_URL,
  registerShareMembership,
  SHARE_MEMBERSHIP_ORGANIZATION,
  seedAgentModels,
} from './seeders/index.mjs';

const PALETTE_SHORTCUT = process.platform === 'darwin' ? 'Meta+K' : 'Control+K';
const NOW = '2026-10-01T00:00:00.000Z';

const SEEDED_AGENT_ID = 'agent_model_code_reviewer';
const UNAVAILABLE_AGENT_ID = 'agent_model_legacy_reviewer';
/** The organization share the seeded local agent was published as. */
const SHARED_COPY_ID = 'cccccccc-4266-4000-8000-000000000001';
/** An agent shared with the viewer that has no local copy yet. */
const SHARED_ONLY_ID = 'cccccccc-4266-4000-8000-000000000002';
const SHARED_ONLY_MODEL_ID = 'agent_model_issue_triage';

function localEntry(agentId) {
  return `customize-row-agent:local:${agentId}`;
}

function sharedEntry(shareId) {
  return `plugins-entry-agent:shared:${shareId}`;
}

function emptyPluginSelections() {
  return {
    collectionIds: [],
    skillRefs: [],
    pluginRefs: [],
    mcpServerRefs: [],
  };
}

function localAgent({ id, name, baseModel = 'sonnet', ...rest }) {
  return {
    id,
    name,
    baseModel,
    instructions: `${name} instructions.`,
    pluginSelections: emptyPluginSelections(),
    createdAt: NOW,
    updatedAt: NOW,
    ...rest,
  };
}

/** An organization-shared agent, as the shared list endpoint returns it. */
function sharedAgent({ id, modelId, name, instructions }) {
  return {
    id,
    name,
    modelId,
    baseModel: 'sonnet',
    instructionsPreview: instructions,
    contentHash: `${id}-hash`,
    shareScope: 'organization',
    owner: {
      type: 'organization',
      id: SHARE_MEMBERSHIP_ORGANIZATION.id,
      name: SHARE_MEMBERSHIP_ORGANIZATION.name,
    },
    createdAt: NOW,
    updatedAt: NOW,
    createdBy: { id: 'teammate', name: 'Teammate' },
    canUpdate: false,
    canDelete: false,
    publicShare: null,
    agent: {
      version: 1,
      id: modelId,
      name,
      baseModel: 'sonnet',
      instructions,
      plugins: [],
    },
  };
}

async function openPalette(window) {
  await window.keyboard.press(PALETTE_SHORTCUT);
  await expect(window.getByTestId('command-palette')).toBeVisible();
  return window.getByTestId('command-palette-input');
}

/** Pushes a flag snapshot with custom agents switched on or off, live. */
async function broadcastCustomAgentsFlag(electronApp, window, enabled) {
  const snapshot = await window.evaluate(() =>
    window.api.featureFlags.getSnapshot(),
  );
  await electronApp.evaluate(
    ({ BrowserWindow }, update) => {
      for (const host of BrowserWindow.getAllWindows()) {
        host.webContents.send('feature-flags:snapshot-changed', update);
      }
    },
    {
      ...snapshot,
      values: { ...snapshot.values, 'canopy-shared-custom-agents': enabled },
    },
  );
}

test('manages local agents from Marketplace › Agents', async ({}, testInfo) => {
  test.setTimeout(150_000);
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'canopy-mkt-agents-'));
  seedAgentModels(userDataDir, [
    localAgent({ id: SEEDED_AGENT_ID, name: 'Code Reviewer' }),
    // A base model no provider offers any more: kept, but unavailable.
    localAgent({
      id: UNAVAILABLE_AGENT_ID,
      name: 'Legacy Reviewer',
      baseModel: 'retired-model-can-4266',
    }),
  ]);
  const { electronApp } = await launchCanopy({ userDataDir });

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });

    // The retired page left no sidebar row and no palette command.
    await expect(window.getByTestId('sidebar-nav-agents')).toHaveCount(0);
    let input = await openPalette(window);
    await input.fill('Go to Agents');
    await expect(
      window.getByRole('option', { name: 'Go to Agents' }),
    ).toHaveCount(0);

    // Cold navigation: the palette's agent item opens the editor over the
    // agent's Marketplace detail before the Marketplace has ever mounted.
    await input.fill('Code Reviewer');
    await window
      .locator('[data-palette-section="agents"]')
      .getByRole('option')
      .click();
    await expect(window.getByTestId('page-plugins')).toBeVisible();
    await expect(
      window.getByTestId('local-agent-marketplace-detail'),
    ).toBeVisible();
    await expect(window.getByTestId('agent-model-modal')).toBeVisible();
    await expect(window.getByTestId('agent-model-id')).toHaveValue(
      SEEDED_AGENT_ID,
    );
    await window
      .getByTestId('agent-model-modal')
      .getByRole('button', { name: 'Cancel', exact: true })
      .click();
    await expect(window.getByTestId('agent-model-modal')).toHaveCount(0);
    // The deep link selected the Agents tab underneath the detail.
    await app.closeMarketplaceEntryDetail();
    await app.expectMarketplaceAgents();

    // Both local agents are listed; availability shows on each detail.
    await expect(window.getByTestId(localEntry(SEEDED_AGENT_ID))).toContainText(
      'Code Reviewer',
    );
    await expect(
      window.getByTestId(localEntry(UNAVAILABLE_AGENT_ID)),
    ).toContainText('Legacy Reviewer');
    let detail = await app.openLocalAgentDetail(UNAVAILABLE_AGENT_ID);
    await expect(
      detail.getByTestId('local-agent-detail-availability'),
    ).toHaveText('Unavailable');
    await app.closeMarketplaceEntryDetail();
    detail = await app.openLocalAgentDetail(SEEDED_AGENT_ID);
    await expect(
      detail.getByTestId('local-agent-detail-availability'),
    ).toHaveText('Installed');
    await app.closeMarketplaceEntryDetail();

    // Create from the Add custom menu.
    await window.getByTestId('plugins-add-custom-menu').click();
    await window.getByTestId('plugins-add-custom-agent').click();
    await expect(window.getByTestId('agent-model-modal')).toBeVisible();
    await window.getByTestId('agent-model-name').fill('Bug Finder');
    await expect(window.getByTestId('agent-model-id')).toHaveValue(
      'bug_finder',
    );
    await window
      .getByTestId('agent-model-base-model')
      .getByTestId('chat-model-picker')
      .click();
    await selectModelOption(window, 'sonnet');
    await window
      .getByTestId('agent-model-instructions')
      .fill('Find risky edge cases.');
    await window.getByTestId('agent-model-submit').click();
    await expect(window.getByTestId('agent-model-modal')).toHaveCount(0);
    // Saving opens the new agent's detail; its card is on the list behind it.
    await app.expectCreatedLocalAgentDetail('agent_model_bug_finder');
    await app.closeMarketplaceEntryDetail();
    const createdCard = window.getByTestId(
      localEntry('agent_model_bug_finder'),
    );
    await expect(createdCard).toContainText('Bug Finder');

    // Edit from the detail.
    detail = await app.openLocalAgentDetail(SEEDED_AGENT_ID);
    await window.getByTestId('local-agent-detail-edit').click();
    await expect(window.getByTestId('agent-model-modal')).toBeVisible();
    await expect(window.getByTestId('agent-model-id')).toHaveValue(
      SEEDED_AGENT_ID,
    );
    await window.getByTestId('agent-model-name').fill('Code Reviewer Updated');
    await window.getByTestId('agent-model-submit').click();
    await expect(window.getByTestId('agent-model-modal')).toHaveCount(0);
    await expect(detail).toContainText('Code Reviewer Updated');

    // Share opens the agent share dialog; signed out, it offers sign-in.
    await window.getByTestId('plugins-entry-detail-share').click();
    const shareModal = window.getByTestId('share-agent-modal');
    await expect(shareModal).toBeVisible();
    await expect(
      window.getByRole('button', { name: 'Open account settings' }),
    ).toBeVisible();
    await shareModal
      .getByRole('button', { name: 'Close', exact: true })
      .click();
    await expect(shareModal).toBeHidden();
    await app.closeMarketplaceEntryDetail();
    await expect(window.getByTestId(localEntry(SEEDED_AGENT_ID))).toContainText(
      'Code Reviewer Updated',
    );

    // Delete from the detail: the confirmation names the agent's id, and the
    // detail closes once the agent is gone.
    detail = await app.openLocalAgentDetail('agent_model_bug_finder');
    await window.getByTestId('local-agent-detail-delete').click();
    await expect(
      window.getByRole('heading', { name: 'Delete agent', exact: true }),
    ).toBeVisible();
    await window.getByRole('button', { name: 'Delete agent' }).click();
    await expect(window.getByTestId('plugins-entry-detail-page')).toHaveCount(
      0,
    );
    await app.expectMarketplaceAgents();
    await expect(createdCard).toHaveCount(0);
    await expect(window.getByTestId(localEntry(SEEDED_AGENT_ID))).toBeVisible();

    await window.screenshot({
      path: testInfo.outputPath('marketplace-agents-local-flows.png'),
      fullPage: true,
    });
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('lists shared agents beside local ones and folds a shared copy into its local row', async () => {
  test.setTimeout(180_000);
  const apiKey = 'csk_can4266_marketplace_agents';
  await registerShareMembership(apiKey, {
    scenario: {
      cloud: {
        sharedAgents: [
          sharedAgent({
            id: SHARED_COPY_ID,
            modelId: SEEDED_AGENT_ID,
            name: 'Code Reviewer',
            instructions: 'Code Reviewer instructions.',
          }),
          sharedAgent({
            id: SHARED_ONLY_ID,
            modelId: SHARED_ONLY_MODEL_ID,
            name: 'Issue Triage',
            instructions: 'Label and route new issues.',
          }),
        ],
      },
    },
  });
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-mkt-agents-shared-'),
  );
  seedAgentModels(userDataDir, [
    // The seeded agent was published as SHARED_COPY_ID.
    localAgent({
      id: SEEDED_AGENT_ID,
      name: 'Code Reviewer',
      remoteId: SHARED_COPY_ID,
    }),
  ]);
  const { electronApp } = await launchCanopy({ userDataDir });

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await connectMockCloudAccount(window, apiKey);

    await app.openMarketplaceAgents();
    const localCard = window.getByTestId(localEntry(SEEDED_AGENT_ID));
    const sharedOnlyCard = window.getByTestId(sharedEntry(SHARED_ONLY_ID));
    await expect(localCard).toBeVisible();
    await expect(sharedOnlyCard).toBeVisible({ timeout: 30_000 });
    // The share of the local agent is listed once, as the local row.
    await expect(window.getByTestId(sharedEntry(SHARED_COPY_ID))).toHaveCount(
      0,
    );
    // Local rows come first.
    const order = await window
      .locator(
        '[data-testid^="customize-row-agent:local:"], [data-testid^="plugins-entry-agent:shared:"]',
      )
      .evaluateAll((nodes) =>
        nodes.map((node) => node.getAttribute('data-testid')),
      );
    expect(order).toEqual([
      localEntry(SEEDED_AGENT_ID),
      sharedEntry(SHARED_ONLY_ID),
    ]);

    // A query narrows both lists; the folded share stays folded.
    const search = window.getByTestId('plugins-search');
    await search.fill('Code Reviewer');
    await expect(localCard).toBeVisible();
    await expect(sharedOnlyCard).toHaveCount(0);
    await expect(window.getByTestId(sharedEntry(SHARED_COPY_ID))).toHaveCount(
      0,
    );
    await search.fill('Issue Triage');
    await expect(sharedOnlyCard).toBeVisible();
    await expect(localCard).toHaveCount(0);
    await search.fill('');
    await expect(localCard).toBeVisible();

    // A shared agent's Add opens the install review, which lands on the
    // installed agent's local detail.
    await sharedOnlyCard.click();
    const sharedDetail = window.getByTestId('shared-agent-marketplace-detail');
    await expect(sharedDetail).toBeVisible();
    await window.getByTestId('shared-agent-detail-add').click();
    const review = window.getByTestId('deep-link-share-landing');
    await expect(review).toBeVisible();
    await expect(review).toContainText('Issue Triage');
    const install = review.getByTestId('deep-link-share-install');
    await expect(install).toBeEnabled();
    await install.click();
    await expect(review).toHaveCount(0, { timeout: 60_000 });
    await expect(
      window.getByTestId('toast-card').filter({ hasText: 'Agent installed.' }),
    ).toBeVisible();
    const installedDetail = window.getByTestId(
      'local-agent-marketplace-detail',
    );
    await expect(installedDetail).toBeVisible();
    await expect(installedDetail).toContainText(SHARED_ONLY_MODEL_ID);

    // Installed, the shared row folds into the new local row.
    await app.closeMarketplaceEntryDetail();
    await app.expectMarketplaceAgents();
    await expect(
      window.getByTestId(localEntry(SHARED_ONLY_MODEL_ID)),
    ).toBeVisible();
    await expect(sharedOnlyCard).toHaveCount(0);
  } finally {
    await closeCanopy(electronApp, userDataDir);
    await clearScenario(DEFAULT_MOCK_BASE_URL, apiKey);
  }
});

test('the custom agents flag hides every Marketplace agent surface, live', async () => {
  test.setTimeout(150_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-mkt-agents-flag-'),
  );
  const { electronApp } = await launchCanopy({ userDataDir });

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });

    // With no agents yet, the empty Agents tab offers the editor.
    await app.openMarketplaceAgents();
    const emptyCreate = window.getByTestId('plugins-agents-empty-create');
    await expect(emptyCreate).toBeVisible();
    await emptyCreate.click();
    await expect(window.getByTestId('agent-model-modal')).toBeVisible();
    await window.getByTestId('agent-model-name').fill('Flag Probe');
    await window
      .getByTestId('agent-model-base-model')
      .getByTestId('chat-model-picker')
      .click();
    await selectModelOption(window, 'sonnet');
    await window.getByTestId('agent-model-instructions').fill('Probe.');
    await window.getByTestId('agent-model-submit').click();
    // Saving opens the new agent's detail.
    await app.expectCreatedLocalAgentDetail('agent_model_flag_probe');
    const probeCard = window.getByTestId(localEntry('agent_model_flag_probe'));

    // Switching agents off closes the open agent detail and removes the tab,
    // the Add custom item and the palette's agent items.
    await broadcastCustomAgentsFlag(electronApp, window, false);
    await expect(window.getByTestId('plugins-type-tab-agent')).toHaveCount(0);
    await expect(
      window.getByTestId('local-agent-marketplace-detail'),
    ).toHaveCount(0);
    await expect(window.getByTestId('page-plugins')).toBeVisible();
    await expect(window.getByTestId('plugins-type-tabs')).toBeVisible();
    await window.getByTestId('plugins-add-custom-menu').click();
    await expect(
      window.getByTestId('plugins-add-custom-collection'),
    ).toBeVisible();
    await expect(window.getByTestId('plugins-add-custom-agent')).toHaveCount(0);
    await window.getByTestId('plugins-add-custom-menu').click();
    await expect(
      window.getByTestId('plugins-add-custom-collection'),
    ).toHaveCount(0);
    await expect(probeCard).toHaveCount(0);
    let input = await openPalette(window);
    await input.fill('Flag Probe');
    await expect(window.locator('[data-palette-section="agents"]')).toHaveCount(
      0,
    );
    await window.keyboard.press('Escape');
    await expect(window.getByTestId('command-palette')).toBeHidden();

    // Switching them back on restores the tab without replaying the detail.
    await broadcastCustomAgentsFlag(electronApp, window, true);
    await expect(window.getByTestId('plugins-type-tab-agent')).toBeVisible();
    await expect(
      window.getByTestId('local-agent-marketplace-detail'),
    ).toHaveCount(0);
    await window.getByTestId('plugins-type-tab-agent').click();
    await app.expectMarketplaceAgents();
    await expect(probeCard).toBeVisible();
    input = await openPalette(window);
    await input.fill('Flag Probe');
    await expect(
      window.locator('[data-palette-section="agents"]').getByRole('option'),
    ).toBeVisible();
    await window.keyboard.press('Escape');
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('a launch with custom agents off offers no Marketplace agent surface', async () => {
  test.setTimeout(120_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-mkt-agents-off-'),
  );
  seedAgentModels(userDataDir, [
    localAgent({ id: SEEDED_AGENT_ID, name: 'Code Reviewer' }),
  ]);
  const { electronApp } = await launchCanopy({
    userDataDir,
    env: {
      CANOPY_E2E_CLIENT_FEATURE_FLAGS: JSON.stringify({
        'canopy-shared-custom-agents': false,
      }),
    },
  });

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });

    await app.openPluginsPage();
    await expect(window.getByTestId('plugins-type-tabs')).toBeVisible();
    await expect(window.getByTestId('plugins-type-tab-agent')).toHaveCount(0);
    await window.getByTestId('plugins-search').fill('Code Reviewer');
    await expect(window.getByTestId(localEntry(SEEDED_AGENT_ID))).toHaveCount(
      0,
    );
    await window.getByTestId('plugins-add-custom-menu').click();
    await expect(
      window.getByTestId('plugins-add-custom-collection'),
    ).toBeVisible();
    await expect(window.getByTestId('plugins-add-custom-agent')).toHaveCount(0);
    await window.getByTestId('plugins-add-custom-menu').click();
    await expect(
      window.getByTestId('plugins-add-custom-collection'),
    ).toHaveCount(0);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('lists shared agents past the first page, and search still finds one', async () => {
  test.setTimeout(120_000);
  const key = 'csk_can4266_agents_pagination';
  const agents = Array.from({ length: 30 }, (_, index) =>
    sharedAgent({
      id: `cccccccc-4266-4000-8000-${String(index + 100).padStart(12, '0')}`,
      modelId: `agent_model_reviewer_${index}`,
      name: `Pagination Reviewer ${String(index).padStart(2, '0')}`,
      instructions: `Review group ${index}.`,
    }),
  );
  await registerShareMembership(key, {
    scenario: { cloud: { sharedAgents: agents } },
  });
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-mkt-agents-pagination-'),
  );
  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await connectMockCloudAccount(window, key);
    await app.openMarketplaceAgents();
    // The second page lists too, so local copies cannot fold the first page
    // away and hide agents that are only on a later one.
    await expect(
      window.locator('[data-testid^="plugins-entry-agent:shared:"]'),
    ).toHaveCount(30);
    const omitted = agents[29];
    await expect(window.getByTestId(sharedEntry(omitted.id))).toBeVisible();
    await window.getByTestId('plugins-search').fill(omitted.name);
    const row = window.getByTestId(sharedEntry(omitted.id));
    await expect(row).toBeVisible();
    await row.click();
    await expect(
      window.getByTestId('shared-agent-marketplace-detail'),
    ).toBeVisible();
    // The item header names it (CAN-4266).
    await expect(
      window.getByTestId('plugins-entry-detail-header-title'),
    ).toHaveText(omitted.name);
    await window.getByTestId('shared-agent-detail-add').click();
    const review = window.getByTestId('deep-link-share-landing');
    await expect(review).toContainText(omitted.name);
    await review.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(review).toHaveCount(0);
    await expect(
      window.getByTestId('shared-agent-marketplace-detail'),
    ).toBeVisible();
  } finally {
    await closeCanopy(electronApp, userDataDir);
    await clearScenario(DEFAULT_MOCK_BASE_URL, key);
  }
});
