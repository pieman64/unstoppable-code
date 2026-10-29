// @capture-keep: CAN-3597 Personal account menu and resource context
// @capture-reference: docs/planning/2026-10-05-can-3597-personal-organization/gap-audit.md
// Run before/after with CAN3597_STAGE using:
// pnpm run test:electron:captures:built can-3597-personal-organization.capture-spec.ts
// Append --dark-mode for dark; seeded mock data makes both modes deterministic.
import { mkdtempSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const stage = process.env.CAN3597_STAGE === 'before' ? 'before' : 'after';
const captureDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../.playwright/can-3597-personal-org',
);
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

test('Personal account and marketplace captures', async () => {
  test.setTimeout(120_000);
  const key = 'csk_can3597_personal_capture';
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
  const { electronApp } = await launchCanopy({
    userDataDir,
    env: ORG_CONTEXT_ENV,
  });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await connectMockCloudAccount(window, key, {
      expectedAccount: { personalOrganizationId: ORG_CONTEXT_A },
    });
    await selectWorkspaceContext(window, 'personal');
    mkdirSync(captureDir, { recursive: true });
    await window.getByTestId('sidebar-context-row').click();
    await expect(
      window.getByTestId('account-personal-activity-row'),
    ).toBeVisible();
    await window.getByTestId('sidebar-context-menu').screenshot({
      path: path.join(captureDir, `personal-menu-desktop-${stage}.png`),
      animations: 'disabled',
    });
    await window.keyboard.press('Escape');
    await app.openPluginsPage();
    await expect(window.getByTestId('plugins-type-tab-all')).toBeVisible();
    await window.getByTestId('plugins-search').fill('Personal release agent');
    if (stage === 'after')
      await expect(
        window
          .getByTestId('plugins-discovery-list')
          .getByText('Personal release agent', { exact: true })
          .first(),
      ).toBeVisible();
    else
      await expect(
        window.getByText('Personal release agent', { exact: true }),
      ).toHaveCount(0);
    await window.getByTestId('plugins-discovery-list').screenshot({
      path: path.join(captureDir, `personal-marketplace-desktop-${stage}.png`),
      animations: 'disabled',
    });
  } finally {
    await closeCanopy(electronApp, userDataDir);
    await clearScenario(DEFAULT_MOCK_BASE_URL, key);
  }
});
