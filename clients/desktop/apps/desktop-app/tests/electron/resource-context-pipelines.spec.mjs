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

const pipeline = {
  id: 'aaaaaaaa-2962-4000-8000-000000000002',
  name: 'Organization A release',
  description: 'Organization-only release',
  icon: '',
  triggerTypes: ['dispatch'],
  scopes: ['directory'],
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:00.000Z',
  canUpdate: false,
  canDelete: false,
  shareScope: 'organization',
  owner: { type: 'organization', id: ORG_CONTEXT_A, name: 'Acme' },
  rawPipeline:
    'name: Organization A release\non: dispatch\njobs:\n  release:\n    steps:\n      - run: echo release\n',
};

test('shared pipeline follows only its owning organization context', async () => {
  test.setTimeout(120_000);
  const key = 'csk_can2962_pipelines';
  await registerScenario(DEFAULT_MOCK_BASE_URL, key, {
    cloud: {
      organizations: ORG_CONTEXT_ORGANIZATIONS,
      sharedPipelines: [pipeline],
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
    await app.openPipelinesPage();
    const row = app.workflowsLibraryPipelineRow(
      'aaaaaaaa-2962-4000-8000-000000000002',
      'shared',
    );
    await expect(row).toBeVisible();
    for (const context of ['personal', ORG_CONTEXT_B]) {
      await selectWorkspaceContext(window, context);
      await app.openPipelinesPage();
      await expect(row).toHaveCount(0);
      const result = await window.evaluate(async () =>
        window.pipelines.getShared({
          remoteId: 'aaaaaaaa-2962-4000-8000-000000000002',
        }),
      );
      expect(result.success).toBe(false);
      await electronApp.evaluate(({ app }) => {
        app.emit(
          'open-url',
          { preventDefault: () => {} },
          'canopy://share/pipelines/aaaaaaaa-2962-4000-8000-000000000002?audience=ORGANIZATION',
        );
      });
      const landing = window.getByTestId('deep-link-share-landing');
      await expect(landing).toContainText("This share isn't available");
      await expect(landing).not.toContainText('Organization A release');
      await window.keyboard.press('Escape');
    }
  } finally {
    await closeCanopy(electronApp, userDataDir);
    await clearScenario(DEFAULT_MOCK_BASE_URL, key);
  }
});
