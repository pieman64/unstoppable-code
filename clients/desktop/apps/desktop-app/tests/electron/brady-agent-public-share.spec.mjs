import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import {
  registerShareMembership,
  SHARE_MEMBERSHIP_TEAM,
  seedAgentModels,
} from './seeders/index.mjs';

const AGENT_ID = 'agent_model_public_reviewer';
const AGENT_SHARE_ID = '7c3f9e42-2f19-4bc4-a43f-95e780f2e68f';
const PUBLIC_SHARE_ID = '81fb19b2-522b-43b4-b7f8-edbcc274dcdd';

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
    createdAt: '2026-08-31T00:00:00.000Z',
    updatedAt: '2026-08-31T00:00:00.000Z',
  },
];

function emitOpenUrl(electronApp, url) {
  return electronApp.evaluate(({ app }, targetUrl) => {
    app.emit('open-url', { preventDefault: () => {} }, targetUrl);
  }, url);
}

async function getAdvisorUiState(electronApp) {
  const request = {
    kind: 'get_current_ui_state',
    requestId: `agent-public-share-ui-state-${Date.now()}`,
  };
  return electronApp.evaluate(
    async ({ BrowserWindow, ipcMain }, rendererRequest) => {
      const mainWindow = BrowserWindow.getAllWindows().find(
        (candidate) =>
          !candidate.webContents.getURL().includes('surface=app-advisor'),
      );
      if (!mainWindow) throw new Error('Main window not found');
      ipcMain.removeHandler('app-advisor:tool-response');
      return new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error('Timed out waiting for App Advisor UI state')),
          5_000,
        );
        ipcMain.handle('app-advisor:tool-response', (_event, response) => {
          if (response?.requestId !== rendererRequest.requestId) return;
          clearTimeout(timer);
          resolve(response);
        });
        mainWindow.webContents.send(
          'app-advisor:tool-request',
          rendererRequest,
        );
      });
    },
    request,
  );
}

test('publishes, installs, uninstalls, and manages a public Agent link', async () => {
  // Narrowing the public share moves it to a team, so the account needs one.
  await registerShareMembership('csk_agent_public_share_e2e');
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'agent-public-share-'),
  );
  seedAgentModels(userDataDir, SEEDED_AGENTS);
  const { electronApp } = await launchCanopy({ userDataDir });

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    const account = await window.evaluate(() =>
      window.api.saveCanopyCloudApiKey({
        apiKey: 'csk_agent_public_share_e2e',
      }),
    );
    expect(account.status).toMatchObject({ authenticated: true });
    const connectedAccount = await window.evaluate(() =>
      window.api.loadCanopyCloudAccount(),
    );
    await window.evaluate(() => {
      window.dispatchEvent(new Event('canopy:cloud-account-changed'));
    });

    await app.openMarketplaceAgents();
    const row = window.getByTestId(`customize-row-agent:local:${AGENT_ID}`);
    await expect(row).toBeVisible();
    await app.openLocalAgentShare(AGENT_ID);

    const shareModal = window.getByTestId('share-agent-modal');
    await shareModal.getByTestId('share-agent-scope-public').click();
    await shareModal.getByTestId('share-agent-submit').click();
    await expect(shareModal).toHaveCount(0);
    const publicToast = window
      .getByTestId('toast-card')
      .filter({ hasText: 'Agent is now public' });
    await publicToast.getByTestId('toast-copy-link').click();
    await expect(
      publicToast.getByText('Copied', { exact: true }),
    ).toBeVisible();
    await expect
      .poll(() => electronApp.evaluate(({ clipboard }) => clipboard.readText()))
      .toMatch(new RegExp(`/portal/plugins/agents/${PUBLIC_SHARE_ID}$`));

    const existingDetail = await window.evaluate(
      (agentId) => window.agents.getShared(agentId),
      AGENT_SHARE_ID,
    );
    await electronApp.evaluate(({ ipcMain }, detail) => {
      globalThis.__resolveAgentShareLookup = undefined;
      ipcMain.removeHandler('agents:shared:get');
      ipcMain.handle(
        'agents:shared:get',
        () =>
          new Promise((resolve) => {
            globalThis.__resolveAgentShareLookup = () => resolve(detail);
          }),
      );
    }, existingDetail);

    await app.openLocalAgentShare(AGENT_ID);
    await expect(shareModal.getByTestId('share-agent-preflight')).toBeVisible();
    await expect(shareModal.getByTestId('share-agent-submit')).toHaveCount(0);
    await electronApp.evaluate(() => {
      globalThis.__resolveAgentShareLookup?.();
    });
    await expect(
      shareModal.getByTestId('share-agent-scope-public'),
    ).toHaveAttribute('aria-checked', 'true');
    await expect(shareModal.getByTestId('share-agent-submit')).toHaveText(
      'Update',
    );
    const advisorState = await getAdvisorUiState(electronApp);
    expect(advisorState.uiState.snapshot.agents.publicShareModal).toMatchObject(
      {
        open: true,
        localAgentId: AGENT_ID,
        sharedAgentId: AGENT_SHARE_ID,
        state: 'published',
        busy: false,
        copied: false,
        canUpdate: true,
      },
    );
    await electronApp.evaluate(({ ipcMain }, detail) => {
      globalThis.__agentSharedDetail = detail;
      ipcMain.removeHandler('agents:shared:get');
      ipcMain.handle('agents:shared:get', () => globalThis.__agentSharedDetail);
    }, existingDetail);
    await electronApp.evaluate(
      ({ ipcMain }, states) => {
        globalThis.__agentShareAccount = states.disconnected;
        ipcMain.removeHandler('settings:load-canopy-cloud-account');
        ipcMain.handle(
          'settings:load-canopy-cloud-account',
          () => globalThis.__agentShareAccount,
        );
      },
      {
        disconnected: {
          read: 'ok',
          hasApiKey: false,
          authMode: null,
          credentialSource: null,
          capabilities: [],
          storageAvailable: true,
        },
      },
    );
    await window.evaluate(() => {
      window.dispatchEvent(new Event('canopy:cloud-account-changed'));
    });
    await expect
      .poll(async () => {
        const state = await getAdvisorUiState(electronApp);
        return state.uiState.snapshot.agents.publicShareModal?.state;
      })
      .toBe('unavailable');
    await electronApp.evaluate((_electron, connectedAccount) => {
      globalThis.__agentShareAccount = connectedAccount;
    }, connectedAccount);
    await window.evaluate(() => {
      window.dispatchEvent(new Event('canopy:cloud-account-changed'));
    });
    await expect(shareModal.getByTestId('share-agent-submit')).toHaveText(
      'Update',
    );

    await electronApp.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('agents:shared:get');
      ipcMain.handle('agents:shared:get', () => {
        throw new Error('HTTP 404: Agent not found');
      });
    });
    await electronApp.evaluate((_electron, accountState) => {
      globalThis.__agentShareAccount = {
        ...accountState,
        account: { ...accountState.account, id: 'different-account' },
      };
    }, connectedAccount);
    await window.evaluate(() => {
      window.dispatchEvent(new Event('canopy:cloud-account-changed'));
    });
    await expect(
      shareModal.getByTestId('share-agent-unavailable'),
    ).toContainText('existing agent share could not be loaded');
    await expect(shareModal.getByTestId('share-agent-submit')).toHaveCount(0);

    await electronApp.evaluate(
      ({ ipcMain }, state) => {
        globalThis.__agentShareAccount = state.account;
        globalThis.__agentSharedDetail = state.detail;
        ipcMain.removeHandler('agents:shared:get');
        ipcMain.handle(
          'agents:shared:get',
          () => globalThis.__agentSharedDetail,
        );
      },
      { account: connectedAccount, detail: existingDetail },
    );
    await window.evaluate(() => {
      window.dispatchEvent(new Event('canopy:cloud-account-changed'));
    });
    await expect(shareModal.getByTestId('share-agent-submit')).toHaveText(
      'Update',
    );

    await electronApp.evaluate(({ ipcMain }, detail) => {
      globalThis.__agentAudienceTransitionOrder = [];
      globalThis.__agentAudienceTransitionRequest = null;
      ipcMain.removeHandler('agents:shared:update');
      ipcMain.handle('agents:shared:update', (_event, request) => {
        globalThis.__agentAudienceTransitionOrder.push('update');
        globalThis.__agentAudienceTransitionRequest = request;
        // The share channel reports a refusal as a ShareOperationResult
        // failure instead of rejecting.
        return {
          ok: false,
          failure: {
            version: 1,
            kind: 'unknown',
            stage: 'publish',
            message: 'Audience update failed',
            commitState: 'not-committed',
            retryable: false,
            httpStatus: 400,
          },
        };
      });
      ipcMain.removeHandler('agents:public-share:revoke');
      ipcMain.handle('agents:public-share:revoke', () => {
        globalThis.__agentAudienceTransitionOrder.push('revoke');
      });
      ipcMain.removeHandler('agents:public-share:publish');
      ipcMain.handle('agents:public-share:publish', () => {
        globalThis.__agentAudienceTransitionOrder.push('restore');
        return detail.publicShare;
      });
    }, existingDetail);
    await shareModal.getByTestId('share-agent-scope-team').click();
    await shareModal
      .getByTestId(`share-agent-team-picker-option-${SHARE_MEMBERSHIP_TEAM.id}`)
      .click();
    await shareModal.getByTestId('share-agent-submit').click();
    await expect(shareModal.getByTestId('share-agent-error')).toContainText(
      'Audience update failed',
    );
    expect(
      await electronApp.evaluate(
        () => globalThis.__agentAudienceTransitionOrder,
      ),
    ).toEqual(['update']);
    expect(
      await electronApp.evaluate(
        () => globalThis.__agentAudienceTransitionRequest.revokePublicShare,
      ),
    ).toEqual({
      externalId: existingDetail.publicShare.externalId,
      updatedAt: existingDetail.publicShare.updatedAt,
    });

    await electronApp.evaluate(({ ipcMain }, detail) => {
      globalThis.__agentSharedDetail = detail;
      globalThis.__agentAudienceTransitionOrder = [];
      globalThis.__agentAudienceTransitionRequest = null;
      ipcMain.removeHandler('agents:shared:update');
      ipcMain.handle('agents:shared:update', (_event, request) => {
        globalThis.__agentAudienceTransitionOrder.push('update');
        globalThis.__agentAudienceTransitionRequest = request;
        return {
          ok: true,
          value: {
            ...detail,
            shareScope: 'team',
            owner: {
              type: 'team',
              id: request.teamId,
              name: 'Platform',
              organization: { id: 'org-e2e', name: 'Acme Robotics' },
            },
            publicShare: null,
          },
        };
      });
    }, existingDetail);
    await shareModal.getByTestId('share-agent-scope-team').click();
    await shareModal
      .getByTestId(`share-agent-team-picker-option-${SHARE_MEMBERSHIP_TEAM.id}`)
      .click();
    await shareModal.getByTestId('share-agent-submit').click();
    await expect(shareModal).toHaveCount(0);
    await expect(
      window.getByTestId('toast-card').filter({ hasText: 'Agent updated' }),
    ).toBeVisible();
    expect(
      await electronApp.evaluate(
        () => globalThis.__agentAudienceTransitionOrder,
      ),
    ).toEqual(['update']);
    await app.deleteMarketplaceAgent(AGENT_ID);
    await window.getByRole('button', { name: 'Delete agent' }).click();
    await expect(row).toBeHidden();

    await emitOpenUrl(electronApp, `canopy://share/agents/${PUBLIC_SHARE_ID}`);
    const landing = window.getByTestId('deep-link-share-landing');
    await expect(landing).toContainText('Public Reviewer');
    // Agent links wait for the one Install click (CAN-3710); the review
    // closes and lands on the agent in Agents › Local.
    await landing.getByTestId('deep-link-share-install').click();
    await expect(landing).toHaveCount(0);
    await expect(
      window.getByTestId('local-agent-marketplace-detail'),
    ).toContainText(AGENT_ID);

    // Reopening the link shows it installed; Uninstall asks first, then the
    // review offers Install again.
    await emitOpenUrl(electronApp, `canopy://share/agents/${PUBLIC_SHARE_ID}`);
    await expect(landing.getByTestId('deep-link-share-open')).toHaveText(
      'Open agent',
    );
    await landing.getByTestId('deep-link-share-kebab').click();
    await window.getByTestId('deep-link-share-uninstall').click();
    await window.getByTestId('deep-link-share-uninstall-confirm').click();
    await expect(landing.getByTestId('deep-link-share-install')).toBeVisible();

    await landing.getByTestId('deep-link-share-install').click();
    await expect(landing).toHaveCount(0);
    await expect(
      window.getByTestId('local-agent-marketplace-detail'),
    ).toContainText(AGENT_ID);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
