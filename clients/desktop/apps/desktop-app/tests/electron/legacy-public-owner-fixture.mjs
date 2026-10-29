import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import {
  registerShareMembership,
  SHARE_MEMBERSHIP_TEAM,
  seedAgentModels,
} from './seeders/index.mjs';

export async function openLegacyPublicOwnerShare() {
  const agentId = 'agent_model_public_reviewer';
  await registerShareMembership('csk_agent_public_share_e2e');
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'legacy-public-owner-'),
  );
  seedAgentModels(userDataDir, [
    {
      id: agentId,
      name: 'Public Reviewer',
      baseModel: 'sonnet',
      instructions: 'Review shared changes carefully.',
      pluginSelections: {
        collectionIds: [],
        skillRefs: [],
        pluginRefs: [],
        mcpServerRefs: [],
      },
      createdAt: '2026-08-31T00:00:00.000Z',
      updatedAt: '2026-08-31T00:00:00.000Z',
    },
  ]);
  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30000 });
    await window.evaluate(() =>
      window.api.saveCanopyCloudApiKey({
        apiKey: 'csk_agent_public_share_e2e',
      }),
    );
    await window.evaluate(() =>
      window.dispatchEvent(new Event('canopy:cloud-account-changed')),
    );
    await app.openMarketplaceAgents();
    await app.openLocalAgentShare(agentId);
    const modal = window.getByTestId('share-agent-modal');
    await modal.getByTestId('share-agent-scope-public').click();
    await modal.getByTestId('share-agent-submit').click();
    await expect(modal).toHaveCount(0);
    const detail = await window.evaluate(() =>
      window.agents.getShared('7c3f9e42-2f19-4bc4-a43f-95e780f2e68f'),
    );
    await electronApp.evaluate(
      ({ ipcMain }, { detail, team }) => {
        globalThis.__legacyPublicOwnerRequests = [];
        const legacy = {
          ...detail,
          shareScope: 'team',
          owner: {
            type: 'team',
            id: team.id,
            name: team.name,
            organization: {
              id: team.organization.id,
              name: 'Example organization',
            },
          },
        };
        ipcMain.removeHandler('agents:shared:get');
        ipcMain.handle('agents:shared:get', () => legacy);
        ipcMain.removeHandler('agents:shared:update');
        ipcMain.handle('agents:shared:update', (_event, request) => {
          globalThis.__legacyPublicOwnerRequests.push(request);
          // The share channel returns a ShareOperationResult envelope.
          return {
            ok: true,
            value: { ...detail, shareScope: request.shareScope },
          };
        });
      },
      { detail, team: SHARE_MEMBERSHIP_TEAM },
    );
    await app.openLocalAgentShare(agentId);
    await expect(modal.getByTestId('share-agent-submit')).toHaveText('Update');
    await expect(modal.getByTestId('share-agent-scope-public')).toHaveAttribute(
      'aria-checked',
      'true',
    );
    return { electronApp, window, modal, userDataDir };
  } catch (error) {
    await closeCanopy(electronApp, userDataDir);
    throw error;
  }
}
