import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import {
  clearScenario,
  DEFAULT_MOCK_BASE_URL,
  ORG_CONTEXT_A,
  ORG_CONTEXT_ENV,
  ORG_CONTEXT_WORKSPACE,
  registerScenario,
  seedOrgContextScoping,
  seedWorktreeChat,
} from './seeders/index.mjs';
import { selectWorkspaceContext } from './workspaceContextMenu.mjs';

// The harness model picker's states that explain an empty or incomplete list:
// the hosted-model download (loading, failed + Retry), an organization that
// left nothing to pick, and a chat on a model that no longer exists.

const WORKSPACE_ID = 'demo-ts-pnpm-vite';
const WORKTREE_ID = 'demo-main';
const WORKTREE_BRANCH = 'demo-main';
const CHAT_ID = 'model-picker-empty-states-chat';
const MODEL_REGISTRY_UPDATED_CHANNEL = 'model-registry:updated';
const RETRY_CHANNEL = 'ai-gateway-model-catalog:retry';
const CLOUD_ACCOUNT_CHANGED_EVENT = 'canopy:cloud-account-changed';
// A UUID: per-org gateway resolution ignores any other organization id.
const ORG_ID = ORG_CONTEXT_A;
const ORG_NAME = 'Empty Picker E2E';
const MOCK_CLOUD_ORIGIN =
  process.env.CANOPY_E2E_CLOUD_BASE_URL ?? DEFAULT_MOCK_BASE_URL;

/**
 * A downloaded hosted-model list. The organization gateway filters every
 * entry out, which is what tells the picker the list is empty, not loading.
 */
function seedHostedCatalog(userDataDir) {
  const cacheDir = path.join(userDataDir, '.cache', 'model-catalog');
  mkdirSync(cacheDir, { recursive: true });
  writeFileSync(
    path.join(cacheDir, 'ai-gateway-v1.json'),
    `${JSON.stringify({
      cacheVersion: 8,
      serverOrigin: MOCK_CLOUD_ORIGIN,
      brandApiNamespace: 'desktop-app',
      fetchedAt: new Date().toISOString(),
      catalog: {
        version: 8,
        models: [
          {
            id: 'e2e-hosted-model',
            gatewayId: 'qa/e2e-hosted-model',
            label: 'Hosted model',
            family: 'openai',
            familyLabel: 'OpenAI',
            recommendedHarness: 'codex',
            contextWindow: 128_000,
            supportsPromptCaching: false,
            requiresLocalHarnessSupport: false,
            showMoreOnly: false,
            supportedThinkingLevels: [],
            toolSchemaProfile: 'standard',
          },
        ],
      },
    })}\n`,
    'utf8',
  );
}

function seedTree(userDataDir, model = 'sonnet') {
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    providerType: 'claude',
    tabs: [{ id: CHAT_ID, title: 'Model picker states', model }],
  });
}

function seedOrganizationTree(userDataDir) {
  seedOrgContextScoping(userDataDir, {
    organizationWorktreeIds: [WORKTREE_ID],
  });
  seedWorktreeChat({
    userDataDir,
    workspaceId: ORG_CONTEXT_WORKSPACE,
    worktreeId: WORKTREE_ID,
    providerType: 'claude',
    tabs: [{ id: CHAT_ID, title: 'Model picker states', model: 'sonnet' }],
  });
}

/** A registry with one Claude model, so a policy can block all of it. */
function narrowSnapshot(extra = {}) {
  return {
    claude: [
      {
        id: 'sonnet',
        label: 'Sonnet',
        family: 'sonnet',
        familyLabel: 'Sonnet',
        vendor: 'anthropic',
        sortOrder: 30,
      },
    ],
    codex: [],
    ollama: [],
    agents: [],
    aliases: {},
    ...extra,
  };
}

async function sendRegistry(electronApp, snapshot) {
  await electronApp.evaluate(
    ({ BrowserWindow }, { channel, payload }) => {
      const window = BrowserWindow.getAllWindows()[0];
      if (!window) throw new Error('No BrowserWindow for the registry update');
      window.webContents.send(channel, payload);
    },
    { channel: MODEL_REGISTRY_UPDATED_CHANNEL, payload: snapshot },
  );
}

async function openPicker(window, app) {
  await app.openMainPage();
  await app.selectWorktree(WORKTREE_BRANCH);
  const picker = window
    .locator('[data-testid="chat-model-picker"]:visible')
    .first();
  await expect(picker).toBeVisible();
  return picker;
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

function organizationScenario(policy) {
  return {
    cloud: {
      organizations: [
        {
          id: ORG_ID,
          name: ORG_NAME,
          createdAt: '2026-09-29T00:00:00.000Z',
          updatedAt: '2026-09-29T00:00:00.000Z',
        },
      ],
      enforcedSettings: [
        {
          organizationId: ORG_ID,
          organizationName: ORG_NAME,
          policies: [policy],
        },
      ],
    },
  };
}

test('remembers the last model browser tab after reopening and reloading', async () => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-model-picker-sticky-'),
  );
  seedTree(userDataDir);
  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    const picker = await openPicker(window, app);
    await picker.click();
    await window.getByTestId('chat-model-harness-tab-favorites').click();
    await window.keyboard.press('Escape');
    await picker.click();
    await expect(
      window.getByTestId('chat-model-harness-tab-favorites'),
    ).toHaveAttribute('aria-checked', 'true');
    await window.reload();
    await app.waitForShell({ timeout: 30_000 });
    await (await openPicker(window, app)).click();
    await expect(
      window.getByTestId('chat-model-harness-tab-favorites'),
    ).toHaveAttribute('aria-checked', 'true');
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('shows the hosted-model download and retries a failed one', async () => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-model-picker-gateway-status-'),
  );
  seedTree(userDataDir);
  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    // Count Retry presses in main instead of reaching the network.
    await electronApp.evaluate(({ ipcMain }, channel) => {
      globalThis.__pickerRetryCount = 0;
      ipcMain.removeHandler(channel);
      ipcMain.handle(channel, () => {
        globalThis.__pickerRetryCount += 1;
      });
    }, RETRY_CHANNEL);
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    const picker = await openPicker(window, app);

    await sendRegistry(
      electronApp,
      narrowSnapshot({ aiGatewayCatalogStatus: 'loading' }),
    );
    await picker.click();
    await window.getByTestId('chat-model-harness-tab-all').click();
    await expect(
      window.getByTestId('chat-model-gateway-catalog-loading'),
    ).toBeVisible();
    // Each placeholder row is an icon and a label drawn as shared skeleton
    // blocks: skullet bars on the muted token, pulsing.
    expect(
      await window
        .getByTestId('chat-model-gateway-catalog-loading')
        .evaluate((node) => {
          const probe = document.createElement('span');
          probe.style.backgroundColor = 'var(--bg-muted)';
          node.append(probe);
          const token = getComputedStyle(probe).backgroundColor;
          probe.remove();
          const bars = [...node.querySelectorAll('[skullet-bar]')];
          return {
            bars: bars.length,
            tokenFill: bars.every(
              (bar) => getComputedStyle(bar).backgroundColor === token,
            ),
            pulsing: bars.every((bar) => bar.getAnimations().length > 0),
          };
        }),
    ).toEqual({ bars: 6, tokenFill: true, pulsing: true });

    await sendRegistry(
      electronApp,
      narrowSnapshot({ aiGatewayCatalogStatus: 'failed' }),
    );
    const failed = window.getByTestId('chat-model-gateway-catalog-failed');
    await expect(failed).toContainText('Couldn’t load');
    await window.getByTestId('chat-model-gateway-catalog-retry').click();
    await expect
      .poll(() => electronApp.evaluate(() => globalThis.__pickerRetryCount))
      .toBe(1);

    await sendRegistry(
      electronApp,
      narrowSnapshot({ aiGatewayCatalogStatus: 'ready' }),
    );
    await expect(failed).toHaveCount(0);
    await expect(window.getByTestId('chat-model-option-sonnet')).toBeVisible();
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('says the organization turned every model off', async () => {
  const apiKey = 'csk_model_picker_all_blocked_e2e';
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-model-picker-all-blocked-'),
  );
  seedOrganizationTree(userDataDir);
  await registerScenario(
    DEFAULT_MOCK_BASE_URL,
    apiKey,
    organizationScenario({
      kind: 'model-policy',
      blockedModelIds: ['sonnet'],
      reviewedModelIds: ['sonnet'],
    }),
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
    await selectWorkspaceContext(window, ORG_CONTEXT_A);
    const picker = await openPicker(window, app);
    await sendRegistry(electronApp, narrowSnapshot());

    await picker.click();
    const empty = window.getByTestId('chat-model-catalog-empty');
    await expect(empty).toContainText(`${ORG_NAME} turned off all models`);
    await expect(empty).toContainText('Ask your admin to turn one on');
  } finally {
    await closeCanopy(electronApp, userDataDir);
    await clearScenario(DEFAULT_MOCK_BASE_URL, apiKey);
  }
});

test('says the organization added no models to its gateway', async () => {
  const apiKey = 'csk_model_picker_empty_gateway_e2e';
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-model-picker-empty-gateway-'),
  );
  seedOrganizationTree(userDataDir);
  seedHostedCatalog(userDataDir);
  await registerScenario(
    DEFAULT_MOCK_BASE_URL,
    apiKey,
    organizationScenario({
      kind: 'model-gateway',
      baseUrl: 'https://gateway.empty.test',
      enforced: true,
      promptCachePassthrough: true,
      models: [],
    }),
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
    await selectWorkspaceContext(window, ORG_CONTEXT_A);
    const picker = await openPicker(window, app);

    await picker.click();
    const empty = window.getByTestId('chat-model-catalog-empty');
    await expect(empty).toContainText(
      `${ORG_NAME} hasn't added any models yet`,
    );
    await expect(empty).toContainText('Ask your admin to add one');
  } finally {
    await closeCanopy(electronApp, userDataDir);
    await clearScenario(DEFAULT_MOCK_BASE_URL, apiKey);
  }
});

test('names a chat on a removed model plainly', async () => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-model-picker-retired-'),
  );
  seedTree(userDataDir, 'claude-retired-4-0');
  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    const picker = await openPicker(window, app);
    await expect(picker).toContainText('Model no longer available');
    await expect(picker).not.toContainText('claude-retired-4-0');
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
