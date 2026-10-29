import { selectModelOption } from './model-selection-fixture.mjs';
import { mkdtempSync } from 'node:fs';
import { createServer } from 'node:http';
import { once } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import {
  clearScenario,
  connectMockCloudAccount,
  DEFAULT_MOCK_BASE_URL,
  getScenarioActivity,
  ORG_CONTEXT_A,
  ORG_CONTEXT_B,
  ORG_CONTEXT_ENV,
  ORG_CONTEXT_ORGANIZATIONS,
  ORG_CONTEXT_WORKSPACE,
  PERSONAL_CONTEXT_WORKSPACE,
  registerScenario,
  seedAgentModels,
  seedOrgContextScoping,
  seedWorktreeChat,
} from './seeders/index.mjs';
import { injectSecureStorageReadFault } from './secureStorageFixture.mjs';
import { selectWorkspaceContext } from './workspaceContextMenu.mjs';
import { writeUnauthenticatedGhFixture } from './ghAuthFixture.mjs';

const WORKSPACE_ID = ORG_CONTEXT_WORKSPACE;
const WORKTREE_ID = 'demo-main';
const WORKTREE_BRANCH = 'demo-main';
const CHAT_ID = 'byo-gateway-chat';
const CLOUD_ACCOUNT_CHANGED_EVENT = 'canopy:cloud-account-changed';
const ORG_ID = ORG_CONTEXT_A;
const ORG_NAME = 'Acme Gateway E2E';
const ORG_MODEL = 'acme-sonnet';
const ORG_CODEX_MODEL = 'acme-qwen3-coder';
const ORG_AGENT_MODEL = 'agent_model_acme_gateway_reviewer';
const CLAUDE_MARKER = 'Canopy-CBYOGCLAUDE';
const CODEX_MARKER = 'Canopy-CBYOGCODEX';
const CLAUDE_REPLY = 'Organization gateway Claude route completed.';
const CODEX_REPLY = 'Organization gateway Codex route completed over HTTP.';

function modelGatewayPolicy(enforced) {
  return {
    kind: 'model-gateway',
    baseUrl: 'https://gateway.acme.test',
    enforced,
    promptCachePassthrough: true,
    models: [
      {
        id: ORG_MODEL,
        gatewayId: 'vertex/claude-sonnet',
        label: 'Sonnet',
        harness: 'claude',
        contextWindow: 200_000,
        supportedThinkingLevels: [],
        toolSchemaProfile: 'standard',
      },
      {
        id: ORG_CODEX_MODEL,
        gatewayId: 'fireworks/qwen3-coder',
        label: 'Qwen3 Coder',
        harness: 'codex',
        contextWindow: 256_000,
        supportedThinkingLevels: ['medium', 'high'],
        toolSchemaProfile: 'flat',
      },
    ],
  };
}

function cloudScenario(enforcedSettings) {
  return {
    cloud: {
      organizations: [
        {
          id: ORG_ID,
          name: ORG_NAME,
          createdAt: '2026-09-08T00:00:00.000Z',
          updatedAt: '2026-09-08T00:00:00.000Z',
        },
      ],
      enforcedSettings,
    },
  };
}

function seedTree(userDataDir) {
  seedOrgContextScoping(userDataDir, {
    organizationWorktreeIds: [WORKTREE_ID],
  });
  seedAgentModels(userDataDir, [
    {
      id: ORG_AGENT_MODEL,
      name: 'Acme Gateway Reviewer',
      baseModel: ORG_MODEL,
      instructions: 'Review through the organization gateway.',
      pluginSelections: {
        collectionIds: [],
        skillRefs: [],
        pluginRefs: [],
        mcpServerRefs: [],
      },
      createdAt: '2026-09-08T00:00:00.000Z',
      updatedAt: '2026-09-08T00:00:00.000Z',
    },
  ]);
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    providerType: 'claude',
    tabs: [{ id: CHAT_ID, title: 'BYO Gateway', model: 'sonnet' }],
  });
}

async function connect(window, apiKey) {
  const saved = await window.evaluate(
    async (key) => window.api.saveCanopyCloudApiKey({ apiKey: key }),
    apiKey,
  );
  expect(saved.status.authenticated).toBe(true);
  await window.evaluate((eventName) => {
    window.dispatchEvent(new Event(eventName));
  }, CLOUD_ACCOUNT_CHANGED_EVENT);
}

async function openSeededWorkspace(window, app) {
  await app.openMainPage();
  await selectWorkspaceContext(window, ORG_ID);
  await app.selectWorktree(WORKTREE_BRANCH);
  return window.locator('[data-testid="chat-model-picker"]:visible').first();
}

test.describe('Bring Your Own Gateway', () => {
  test('CAN-3220 gateway read Retry refreshes the still-mounted composer', async () => {
    test.setTimeout(120_000);
    const apiKey = 'csk_byog_read_retry_e2e';
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-byog-read-retry-'),
    );
    seedTree(userDataDir);
    await registerScenario(
      DEFAULT_MOCK_BASE_URL,
      apiKey,
      cloudScenario([
        {
          organizationId: ORG_ID,
          organizationName: ORG_NAME,
          policies: [modelGatewayPolicy(true)],
        },
      ]),
    );
    let electronApp;
    let restore;
    try {
      ({ electronApp } = await launchCanopy({
        userDataDir,
        env: {
          ...ORG_CONTEXT_ENV,
          GH_EXECUTABLE: writeUnauthenticatedGhFixture(userDataDir),
          CANOPY_E2E_CLOUD_BASE_URL: DEFAULT_MOCK_BASE_URL,
        },
      }));
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell();
      await connect(window, apiKey);
      const result = await window.evaluate(
        async ({ organizationId, baseUrl }) =>
          window.api.saveModelGatewayCredential({
            organizationId,
            baseUrl,
            apiKey: 'sk_read_retry_e2e',
          }),
        { organizationId: ORG_ID, baseUrl: modelGatewayPolicy(true).baseUrl },
      );
      expect(result.valid).toBe(true);
      await openSeededWorkspace(window, app);
      const banner = window.getByTestId('chat-input-model-gateway-key-banner');
      await expect(banner).toHaveCount(0);
      restore = await injectSecureStorageReadFault(
        electronApp,
        'sk_read_retry_e2e',
      );
      // Re-read through the existing subscription after transient native availability loss during the fixture decryption. This setup event precedes Retry; recovery must emit its own.
      await window.evaluate(() => {
        window.dispatchEvent(
          new Event('canopy:model-gateway-credential-changed'),
        );
      });
      await expect(banner).toBeVisible();
      await banner
        .getByTestId('chat-input-model-gateway-key-banner-action')
        .click();
      const section = window.getByTestId('settings-model-gateway-credential');
      await expect(section.getByTestId('secure-storage-notice')).toBeVisible();
      await restore();
      await section.getByTestId('secure-storage-retry').click();
      await expect(
        section.getByTestId('settings-model-gateway-key-input'),
      ).toHaveValue('sk_read_retry_e2e');
      await expect(section.getByTestId('secure-storage-notice')).toHaveCount(0);
      await app.closeSettings();
      // Settings overlays the mounted composer: no reload or worktree reselection.
      await expect(banner).toHaveCount(0);
    } finally {
      try {
        await restore?.();
        if (electronApp) await closeCanopy(electronApp, userDataDir);
      } finally {
        await clearScenario(DEFAULT_MOCK_BASE_URL, apiKey);
      }
    }
  });

  for (const mutation of ['clear', 'reject']) {
    test(`CAN-3220 gateway ${mutation} refreshes the still-mounted composer`, async () => {
      test.setTimeout(150_000);
      // Only the rejected key's real HTTP discovery gets a 401. Other mock
      // requests retain the suite server; no preload or IPC writer is replaced.
      const gateway = createServer((request, response) => {
        if (
          request.url === '/v1/models' &&
          request.headers.authorization === 'Bearer sk_rejected_e2e'
        ) {
          response.writeHead(401, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ error: 'Rejected fixture key' }));
          return;
        }
        response.writeHead(307, {
          location: `${DEFAULT_MOCK_BASE_URL}${request.url}`,
        });
        response.end();
      });
      gateway.listen(0, '127.0.0.1');
      await once(gateway, 'listening');
      const address = gateway.address();
      if (!address || typeof address === 'string')
        throw new Error('Gateway fixture failed to listen');
      const apiKey = `csk_byog_${mutation}_review_e2e`;
      const userDataDir = mkdtempSync(
        path.join(os.tmpdir(), `canopy-byog-${mutation}-`),
      );
      seedTree(userDataDir);
      await registerScenario(
        DEFAULT_MOCK_BASE_URL,
        apiKey,
        cloudScenario([
          {
            organizationId: ORG_ID,
            organizationName: ORG_NAME,
            policies: [modelGatewayPolicy(true)],
          },
        ]),
      );
      let electronApp;
      try {
        ({ electronApp } = await launchCanopy({
          userDataDir,
          env: {
            ...ORG_CONTEXT_ENV,
            CANOPY_E2E_CLOUD_BASE_URL: DEFAULT_MOCK_BASE_URL,
            CANOPY_MOCK_LLM_BASE_URL: `http://127.0.0.1:${address.port}`,
          },
        }));
        const window = await electronApp.firstWindow();
        const app = new CanopyAppDriver(window);
        await app.waitForShell();
        await connect(window, apiKey);
        await openSeededWorkspace(window, app);
        const banner = window.getByTestId(
          'chat-input-model-gateway-key-banner',
        );
        await expect(banner).toBeVisible();
        await banner
          .getByTestId('chat-input-model-gateway-key-banner-action')
          .click();
        const input = window.getByTestId('settings-model-gateway-key-input');
        await expect(input).toBeEnabled();
        await input.fill('sk_working_e2e');
        await expect(
          window.getByTestId('settings-model-gateway-credential'),
        ).toContainText('Your gateway key works.');
        await app.closeSettings();
        await expect(banner).toHaveCount(0);
        await app.openSettings();
        await app.openSettingsSection('account');
        await expect(input).toHaveValue('sk_working_e2e');
        const nextKey = mutation === 'clear' ? '' : 'sk_rejected_e2e';
        await input.fill(nextKey);
        await expect
          .poll(async () =>
            window.evaluate(async (orgId) => {
              const record = await window.api.loadModelGatewayCredential(orgId);
              return { key: record.apiKey, rejected: !!record.lastError };
            }, ORG_ID),
          )
          .toEqual({ key: nextKey, rejected: mutation === 'reject' });
        await app.closeSettings();
        // No worktree reselection or composer remount may repair the stale read.
        await expect(banner).toHaveAttribute(
          'data-gateway-key-state',
          mutation === 'clear' ? 'missing' : 'rejected',
        );
      } finally {
        try {
          if (electronApp) await closeCanopy(electronApp, userDataDir);
        } finally {
          await clearScenario(DEFAULT_MOCK_BASE_URL, apiKey);
          gateway.closeAllConnections();
          await new Promise((resolve, reject) =>
            gateway.close((error) => (error ? reject(error) : resolve())),
          );
        }
      }
    });
  }

  test('enforced policy shows org models, blocks alternate routes, and surfaces key setup', async () => {
    test.setTimeout(240_000);
    const apiKey = 'csk_byog_enforced_e2e';
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-byog-enforced-'),
    );
    seedTree(userDataDir);
    await registerScenario(
      DEFAULT_MOCK_BASE_URL,
      apiKey,
      cloudScenario([
        {
          organizationId: ORG_ID,
          organizationName: ORG_NAME,
          policies: [modelGatewayPolicy(true)],
        },
      ]),
    );
    await registerScenario(DEFAULT_MOCK_BASE_URL, CLAUDE_MARKER, {
      llm: { steps: [{ text: CLAUDE_REPLY, stopReason: 'end_turn' }] },
    });
    await registerScenario(DEFAULT_MOCK_BASE_URL, CODEX_MARKER, {
      llm: {
        steps: [
          { text: CODEX_REPLY, stopReason: 'end_turn' },
          {
            error: {
              status: 401,
              message: 'The organization gateway rejected this key.',
            },
          },
        ],
      },
    });
    const { electronApp } = await launchCanopy({
      userDataDir,
      env: {
        ...ORG_CONTEXT_ENV,
        CANOPY_E2E_CLOUD_BASE_URL: DEFAULT_MOCK_BASE_URL,
      },
    });

    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell({ timeout: 30_000 });
      await connect(window, apiKey);
      await selectWorkspaceContext(window, ORG_ID);

      // Home is a composer too. A member of an enforcing org who has not added
      // a key hits it here FIRST, before ever opening a worktree, so the same
      // banner has to reach the "New task" surface.
      await window.getByTestId('sidebar-create-task').click();
      const homePage = window.getByTestId('page-home');
      await expect(homePage).toBeVisible();
      await expect(
        homePage.getByTestId('chat-input-model-gateway-key-banner'),
      ).toBeVisible({ timeout: 15_000 });

      const picker = await openSeededWorkspace(window, app);

      await expect(
        window.getByTestId('chat-input-model-gateway-key-banner'),
      ).toBeVisible({ timeout: 15_000 });
      await picker.click();
      await expect(
        window.getByTestId(`chat-model-option-${ORG_MODEL}`),
      ).toBeVisible();
      // The seeded chat was stamped on `sonnet` before enforcement, so its own
      // row stays visible and explains itself rather than vanishing and
      // leaving the picker with no current selection.
      await expect(
        window.getByTestId('chat-model-option-sonnet'),
      ).toHaveAttribute('aria-disabled', 'true');
      // Every OTHER non-org row is gone, local models included: a wall of
      // permanently dead rows buried the handful the org actually permits.
      await expect(window.getByTestId('chat-model-option-opus')).toHaveCount(0);
      await expect(
        window.getByTestId('chat-billing-org-gateway-note'),
      ).toBeVisible();
      await expect(window.getByTestId('chat-billing-framework')).toHaveCount(0);
      await expect(
        window.getByTestId(`chat-model-group-label-org-gateway:${ORG_ID}`),
      ).toContainText(ORG_NAME);
      await window.keyboard.press('Escape');

      await window
        .getByTestId('chat-input-model-gateway-key-banner-action')
        .click();
      await expect(
        window.getByTestId('settings-model-gateway-credential'),
      ).toBeVisible();
      await expect(
        window.getByTestId('settings-model-gateway-key-input'),
      ).toBeEnabled();
      await window
        .getByTestId('settings-model-gateway-key-input')
        .fill('sk_org_gateway_e2e');
      await expect
        .poll(
          async () =>
            window.evaluate(async (organizationId) => {
              const saved =
                await window.api.loadModelGatewayCredential(organizationId);
              return saved.apiKey;
            }, ORG_ID),
          { timeout: 15_000 },
        )
        .toBe('sk_org_gateway_e2e');

      await app.closeSettings();
      await app.openMainPage();
      await app.selectWorktree(WORKTREE_BRANCH);
      const selectAndSend = async (
        modelId,
        marker,
        reply,
        { startsNewChat = false } = {},
      ) => {
        const panel = window.getByTestId('panel-content-chat');
        const modelPicker = panel
          .locator('[data-testid="chat-model-picker"]:visible')
          .first();
        await modelPicker.click();
        await selectModelOption(window, `${modelId}`);
        const startNewChat = window.getByRole('button', {
          name: 'Start new chat',
        });
        if (startsNewChat) {
          await expect(startNewChat).toBeVisible();
          await startNewChat.click();
          await expect(startNewChat).toBeHidden();
          await expect(
            panel.locator('[data-testid="chat-model-picker"]:visible').first(),
          ).toContainText('Qwen3 Coder');
        }
        const message = `[${marker}] Route this turn through the org gateway.`;
        const composer = panel.getByRole('textbox').first();
        await composer.fill(message);
        await expect(composer).toHaveText(message);
        await panel.getByRole('button', { name: 'Send message' }).click();
        await expect(panel.getByText(reply).first()).toBeVisible({
          timeout: 90_000,
        });
        // Assistant text can paint before the terminal event has durably
        // settled the turn. A cross-harness model switch fingerprints the
        // transcript while it prepares the new-chat summary, so starting that
        // switch from the transient painted state races the final message
        // merge and correctly trips the stale-summary guard under CI load.
        await expect(
          panel
            .locator('[data-chat-turn-group]')
            .filter({ hasText: reply })
            .locator('[data-testid="turn-timer"][data-state="completed"]'),
        ).toHaveCount(1, { timeout: 90_000 });
        const { activity } = await getScenarioActivity(
          DEFAULT_MOCK_BASE_URL,
          marker,
        );
        expect(activity.llmRequests ?? 0).toBeGreaterThan(0);
        expect(activity['llmProxy:anthropic'] ?? 0).toBe(0);
        expect(activity['llmProxy:openai'] ?? 0).toBe(0);
      };

      await selectAndSend(ORG_MODEL, CLAUDE_MARKER, CLAUDE_REPLY);
      await selectAndSend(ORG_CODEX_MODEL, CODEX_MARKER, CODEX_REPLY, {
        startsNewChat: true,
      });

      const panel = window.getByTestId('panel-content-chat');
      const composer = panel.getByRole('textbox').first();
      await composer.fill(
        `[${CODEX_MARKER}] The organization has revoked this key.`,
      );
      await panel.getByRole('button', { name: 'Send message' }).click();
      await expect(
        window.getByTestId('chat-input-model-gateway-key-banner'),
      ).toHaveAttribute('data-gateway-key-state', 'rejected', {
        timeout: 30_000,
      });
      await expect(
        window.getByTestId('chat-input-model-gateway-key-banner'),
      ).toContainText("didn't accept your gateway key");
    } finally {
      await closeCanopy(electronApp, userDataDir);
      await clearScenario(DEFAULT_MOCK_BASE_URL, apiKey);
      await clearScenario(DEFAULT_MOCK_BASE_URL, CLAUDE_MARKER);
      await clearScenario(DEFAULT_MOCK_BASE_URL, CODEX_MARKER);
    }
  });

  test('additive duplicate stays distinguishable and disappears cleanly when disabled', async () => {
    const apiKey = 'csk_byog_additive_e2e';
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-byog-additive-'),
    );
    seedTree(userDataDir);
    const settings = [
      {
        organizationId: ORG_ID,
        organizationName: ORG_NAME,
        policies: [modelGatewayPolicy(false)],
      },
    ];
    await registerScenario(
      DEFAULT_MOCK_BASE_URL,
      apiKey,
      cloudScenario(settings),
    );
    const { electronApp } = await launchCanopy({
      userDataDir,
      env: {
        ...ORG_CONTEXT_ENV,
        CANOPY_E2E_CLOUD_BASE_URL: DEFAULT_MOCK_BASE_URL,
      },
    });

    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell({ timeout: 30_000 });
      await connect(window, apiKey);
      const picker = await openSeededWorkspace(window, app);

      await picker.click();
      await expect(
        window.getByTestId(`chat-model-option-${ORG_MODEL}`),
      ).toBeVisible();
      await expect(
        window.getByTestId('chat-model-option-sonnet'),
      ).toBeEnabled();
      await expect(
        window.getByTestId(`chat-model-option-${ORG_AGENT_MODEL}`),
      ).toBeVisible();
      await selectModelOption(window, `${ORG_AGENT_MODEL}`);
      await expect(picker).toContainText('Acme Gateway Reviewer');
      await expect(
        window.getByTestId('chat-input-model-gateway-key-banner'),
      ).toBeVisible();

      await picker.click();
      await selectModelOption(window, `${ORG_MODEL}`);
      await expect(picker).toContainText(`${ORG_NAME} · Sonnet`);
      await expect(
        window.getByTestId('chat-input-model-gateway-key-banner'),
      ).toBeVisible();
      await expect(
        window.getByTestId('chat-input-model-gateway-key-banner-action'),
      ).toHaveText('Add your gateway key');

      await registerScenario(DEFAULT_MOCK_BASE_URL, apiKey, cloudScenario([]));
      await connect(window, apiKey);
      await expect(picker).not.toContainText(`${ORG_NAME} · Sonnet`, {
        timeout: 15_000,
      });
      await picker.click();
      await expect(
        window.getByTestId(`chat-model-option-${ORG_MODEL}`),
      ).toHaveCount(0);
    } finally {
      await closeCanopy(electronApp, userDataDir);
      await clearScenario(DEFAULT_MOCK_BASE_URL, apiKey);
    }
  });

  test('applies each org gateway only to that org’s work across context switches', async () => {
    // CAN-3464: Acme enforces its gateway, Empty organization adds one. Acme's
    // work sees only Acme's rows and banner; Personal work sees no org rows at
    // all; and Settings lists every org's key row, the selected org first.
    test.setTimeout(240_000);
    const apiKey = 'csk_byog_two_org_e2e';
    const orgWorktree = 'acme-gateway-owner';
    const personalWorktree = 'personal-gateway-owner';
    const acmeModel = 'acme-owner-sonnet';
    const betaModel = 'beta-owner-qwen';
    const [acme, beta] = ORG_CONTEXT_ORGANIZATIONS;
    const gatewayPolicy = (enforced, id, label, host) => ({
      kind: 'model-gateway',
      baseUrl: `https://${host}`,
      enforced,
      promptCachePassthrough: true,
      models: [
        {
          id,
          gatewayId: `vertex/${id}`,
          label,
          harness: 'claude',
          contextWindow: 200_000,
          supportedThinkingLevels: [],
          toolSchemaProfile: 'standard',
        },
      ],
    });
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-byog-two-org-'),
    );
    seedOrgContextScoping(userDataDir, {
      personalWorktreeIds: [personalWorktree],
      organizationWorktreeIds: [orgWorktree],
      organizationB: true,
    });
    for (const [workspaceId, worktreeId] of [
      [ORG_CONTEXT_WORKSPACE, orgWorktree],
      [PERSONAL_CONTEXT_WORKSPACE, personalWorktree],
    ]) {
      seedWorktreeChat({
        userDataDir,
        workspaceId,
        worktreeId,
        providerType: 'claude',
        tabs: [{ id: `${worktreeId}-chat`, title: 'Chat', model: 'sonnet' }],
      });
    }
    await registerScenario(DEFAULT_MOCK_BASE_URL, apiKey, {
      cloud: {
        organizations: ORG_CONTEXT_ORGANIZATIONS,
        enforcedSettings: [
          {
            organizationId: ORG_CONTEXT_A,
            organizationName: acme.name,
            policies: [
              gatewayPolicy(true, acmeModel, 'Acme Sonnet', 'gw.acme.test'),
            ],
          },
          {
            organizationId: ORG_CONTEXT_B,
            organizationName: beta.name,
            policies: [
              gatewayPolicy(false, betaModel, 'Beta Qwen', 'gw.beta.test'),
            ],
          },
        ],
      },
    });
    const { electronApp } = await launchCanopy({
      userDataDir,
      env: {
        ...ORG_CONTEXT_ENV,
        CANOPY_E2E_CLOUD_BASE_URL: DEFAULT_MOCK_BASE_URL,
      },
    });

    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell({ timeout: 30_000 });
      await connectMockCloudAccount(window, apiKey);
      await window.evaluate((eventName) => {
        window.dispatchEvent(new Event(eventName));
      }, CLOUD_ACCOUNT_CHANGED_EVENT);
      await app.openMainPage();

      // Acme's work: Acme's gateway only, and the banner names Acme.
      await selectWorkspaceContext(window, ORG_CONTEXT_A);
      await app.selectWorktree(orgWorktree);
      const banner = window.getByTestId('chat-input-model-gateway-key-banner');
      await expect(banner).toBeVisible({ timeout: 15_000 });
      await expect(banner).toContainText(acme.name);
      const panel = window.getByTestId('panel-content-chat');
      await panel
        .locator('[data-testid="chat-model-picker"]:visible')
        .first()
        .click();
      await expect(
        window.getByTestId(`chat-model-option-${acmeModel}`),
      ).toBeVisible();
      await expect(
        window.getByTestId(`chat-model-option-${betaModel}`),
      ).toHaveCount(0);
      await expect(
        window.getByTestId('chat-billing-org-gateway-note'),
      ).toContainText(acme.name);
      await window.keyboard.press('Escape');

      // Settings: every org's key row, Acme (the selected org) first.
      await window
        .getByTestId('chat-input-model-gateway-key-banner-action')
        .click();
      const cards = window.getByTestId('settings-model-gateway-credential');
      await expect(cards).toHaveCount(2);
      await expect(cards.first()).toHaveAttribute(
        'data-organization-id',
        ORG_CONTEXT_A,
      );
      await app.closeSettings();

      // Personal work: no org gateway rows, no org banner.
      await app.openMainPage();
      await selectWorkspaceContext(window, 'personal');
      await app.selectWorktree(personalWorktree);
      await expect(banner).toHaveCount(0);
      await panel
        .locator('[data-testid="chat-model-picker"]:visible')
        .first()
        .click();
      await expect(
        window.getByTestId('chat-model-option-sonnet'),
      ).toBeVisible();
      await expect(
        window.getByTestId(`chat-model-option-${acmeModel}`),
      ).toHaveCount(0);
      await expect(
        window.getByTestId(`chat-model-option-${betaModel}`),
      ).toHaveCount(0);
      await expect(
        window.getByTestId('chat-billing-org-gateway-note'),
      ).toHaveCount(0);
      await window.keyboard.press('Escape');
    } finally {
      await closeCanopy(electronApp, userDataDir);
      await clearScenario(DEFAULT_MOCK_BASE_URL, apiKey);
    }
  });
});
