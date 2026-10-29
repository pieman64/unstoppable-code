import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import {
  connectMockCloudAccount,
  DEFAULT_MOCK_BASE_URL,
  seedWorktreeChat,
} from './seeders/index.mjs';
import { openModelBillingMenu } from './modelPickerBilling.mjs';

const WORKSPACE_ID = 'demo-ts-pnpm-vite';
const WORKTREE_ID = 'demo-main';
const WORKTREE_BRANCH = 'demo-main';
const CHAT_ID = 'gateway-model-picker-chat';
const MODEL_REGISTRY_UPDATED_CHANNEL = 'model-registry:updated';
const MODEL_POLICY_CLOUD_API_KEY = 'csk_model_policy_e2e';
const MOCK_CLOUD_ORIGIN =
  process.env.CANOPY_E2E_CLOUD_BASE_URL ?? DEFAULT_MOCK_BASE_URL;
const BRAND_API_NAMESPACE = 'desktop-app';

const gatewayConfig = {
  gatewayOnly: true,
  contextWindow: 128_000,
  supportsPromptCaching: false,
  supportedThinkingLevels: ['low', 'medium', 'high'],
  toolSchemaProfile: 'standard',
};

function seedLocalHarnessGateCatalog(userDataDir) {
  const cacheDir = path.join(userDataDir, '.cache', 'model-catalog');
  mkdirSync(cacheDir, { recursive: true });
  const model = (id, requiresLocalHarnessSupport, showMoreOnly = false) => ({
    id,
    gatewayId: `qa/${id}`,
    label: id,
    family: 'openai',
    familyLabel: 'OpenAI',
    recommendedHarness: 'codex',
    contextWindow: 128_000,
    supportsPromptCaching: false,
    requiresLocalHarnessSupport,
    showMoreOnly,
    supportedThinkingLevels: [],
    toolSchemaProfile: 'standard',
  });
  writeFileSync(
    path.join(cacheDir, 'ai-gateway-v1.json'),
    `${JSON.stringify({
      cacheVersion: 8,
      serverOrigin: MOCK_CLOUD_ORIGIN,
      brandApiNamespace: BRAND_API_NAMESPACE,
      fetchedAt: new Date().toISOString(),
      catalog: {
        version: 8,
        models: [
          model('e2e-ungated-api-model', false, true),
          model('e2e-local-harness-required', true),
        ],
      },
    })}\n`,
    'utf8',
  );
}

/**
 * The picker suppresses row hover after its list scrolls until the pointer
 * moves with real movement, which a person always does on the way to a row.
 * Automation mouse moves report zero movement, so send that one move.
 */
async function nudgePointer(locator) {
  await locator.evaluate((element) => {
    element.dispatchEvent(
      new PointerEvent('pointermove', {
        bubbles: true,
        movementX: 1,
        movementY: 1,
      }),
    );
  });
}

function seedUnknownFamilyCatalog(userDataDir) {
  const cacheDir = path.join(userDataDir, '.cache', 'model-catalog');
  mkdirSync(cacheDir, { recursive: true });
  writeFileSync(
    path.join(cacheDir, 'ai-gateway-v1.json'),
    `${JSON.stringify({
      cacheVersion: 8,
      serverOrigin: MOCK_CLOUD_ORIGIN,
      brandApiNamespace: BRAND_API_NAMESPACE,
      fetchedAt: new Date().toISOString(),
      catalog: {
        version: 8,
        models: [
          {
            id: 'e2e-mistral-large',
            gatewayId: 'mistral/mistral-large',
            label: 'Mistral Large',
            family: 'mistral',
            familyLabel: 'Mistral',
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

async function injectModelRegistry(electronApp) {
  await electronApp.evaluate(
    ({ BrowserWindow }, { channel, snapshot }) => {
      const window = BrowserWindow.getAllWindows()[0];
      if (!window) {
        throw new Error('No BrowserWindow available for model registry update');
      }
      window.webContents.send(channel, snapshot);
    },
    {
      channel: MODEL_REGISTRY_UPDATED_CHANNEL,
      snapshot: {
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
        codex: [
          {
            id: 'gpt-5.6-luna',
            label: 'GPT-5.6 Luna',
            family: 'gpt-5.6',
            familyLabel: 'GPT 5.6',
            vendor: 'openai',
            sortOrder: 70,
          },
        ],
        ollama: [],
        agents: [],
        aliases: {},
        // Gateway-only entries moved to the dedicated catalog/route fields in
        // the model-registry snapshot. Keep the injected fixture aligned with
        // the current transport contract so the picker can resolve their
        // routability and regroup them under AI Credits.
        aiGatewayModels: [
          {
            id: 'claude-zulu-gateway-only',
            label: 'Zulu Gateway',
            family: 'anthropic',
            familyLabel: 'Anthropic',
            vendor: 'anthropic',
            recommendedHarness: 'claude',
            contextWindow: gatewayConfig.contextWindow,
            supportsPromptCaching: gatewayConfig.supportsPromptCaching,
            supportedThinkingLevels: gatewayConfig.supportedThinkingLevels,
            toolSchemaProfile: gatewayConfig.toolSchemaProfile,
          },
          {
            id: 'deepseek-v4.1-flash',
            label: 'DeepSeek V4.1 Flash',
            family: 'deepseek',
            familyLabel: 'DeepSeek',
            vendor: 'deepseek',
            recommendedHarness: 'codex',
            contextWindow: gatewayConfig.contextWindow,
            supportsPromptCaching: gatewayConfig.supportsPromptCaching,
            supportedThinkingLevels: gatewayConfig.supportedThinkingLevels,
            toolSchemaProfile: gatewayConfig.toolSchemaProfile,
          },
        ],
        gatewayRoutes: [
          {
            modelId: 'claude-zulu-gateway-only',
            gatewayId: 'anthropic/zulu-gateway',
            family: 'anthropic',
            recommendedHarness: 'claude',
            gatewayOnly: true,
            contextWindow: gatewayConfig.contextWindow,
            supportsPromptCaching: gatewayConfig.supportsPromptCaching,
            supportedThinkingLevels: gatewayConfig.supportedThinkingLevels,
            toolSchemaProfile: gatewayConfig.toolSchemaProfile,
          },
          {
            modelId: 'deepseek-v4.1-flash',
            gatewayId: 'deepseek/deepseek-v4.1-flash',
            family: 'deepseek',
            recommendedHarness: 'codex',
            gatewayOnly: true,
            contextWindow: gatewayConfig.contextWindow,
            supportsPromptCaching: gatewayConfig.supportsPromptCaching,
            supportedThinkingLevels: gatewayConfig.supportedThinkingLevels,
            toolSchemaProfile: gatewayConfig.toolSchemaProfile,
          },
        ],
      },
    },
  );
}

test('shows the AI Credits explanation when hovering a row credits label', async () => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-model-picker-credits-tooltip-'),
  );
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    providerType: 'codex',
    tabs: [{ id: CHAT_ID, title: 'AI Credits tooltip', model: 'gpt-5.6-luna' }],
  });
  seedLocalHarnessGateCatalog(userDataDir);

  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_BRANCH);
    await injectModelRegistry(electronApp);

    await window
      .locator('[data-testid="chat-model-picker"]:visible')
      .first()
      .click();
    // Search brings the row up without scrolling: a scroll suppresses row
    // hover until a pointer move with real movement, which synthetic
    // automation moves do not report.
    await window.getByTestId('chat-model-search').fill('V4.1');
    const label = window
      .locator(
        '[data-testid="chat-model-credits-area-deepseek-v4.1-flash"]:visible',
      )
      .first();
    await expect(label).toBeVisible();
    await label.hover();
    await expect(
      window.getByRole('tooltip').filter({
        hasText: 'This model uses your AI credit balance.',
      }),
    ).toBeVisible();
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('groups gateway-only models by vendor and marks each extra-charge row', async () => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-model-picker-gateway-catalog-'),
  );
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    providerType: 'codex',
    tabs: [
      {
        id: CHAT_ID,
        title: 'Gateway Model Picker',
        model: 'gpt-5.6-luna',
      },
    ],
  });
  seedLocalHarnessGateCatalog(userDataDir);

  const { electronApp } = await launchCanopy({ userDataDir });

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_BRANCH);

    const picker = window
      .locator('[data-testid="chat-model-picker"]:visible')
      .first();
    await picker.click();
    await window.getByTestId('chat-model-harness-tab-codex').click();
    const astra = window.getByTestId('chat-model-option-gpt-6-astra');
    const sol = window.getByTestId('chat-model-option-gpt-6.1-sol');
    const luna = window.getByTestId('chat-model-option-gpt-6-luna');
    await expect(astra).toBeVisible();
    await expect(sol).toBeVisible();
    await expect(luna).toBeVisible();
    const [astraBox, solBox, lunaBox] = await Promise.all([
      astra.boundingBox(),
      sol.boundingBox(),
      luna.boundingBox(),
    ]);
    expect(astraBox?.y).toBeLessThan(solBox?.y ?? Number.NEGATIVE_INFINITY);
    expect(solBox?.y).toBeLessThan(lunaBox?.y ?? Number.NEGATIVE_INFINITY);
    await expect(
      window.getByTestId('chat-model-option-e2e-ungated-api-model'),
    ).toBeHidden();
    await expect(window.getByTestId('chat-model-option-gpt-6-sol')).toHaveCount(
      0,
    );
    await expect(
      window.getByTestId('chat-model-option-gpt-5.6-sol'),
    ).toHaveCount(0);
    // Older Codex models sit behind the vendor's Legacy models flyout.
    const openLegacyOpenAi = async () => {
      await window
        .locator('[data-testid="chat-model-more-openai"]:visible')
        .first()
        .click();
      await expect(
        window.getByTestId('chat-model-more-group-openai'),
      ).toBeVisible();
    };
    await openLegacyOpenAi();
    await expect(
      window.getByTestId('chat-model-option-gpt-6-sol'),
    ).toBeVisible();
    await expect(window.getByTestId('chat-model-option-gpt-5.4')).toHaveCount(
      0,
    );
    const gpt56Sol = window.getByTestId('chat-model-option-gpt-5.6-sol');
    await expect(gpt56Sol).toBeVisible();
    await gpt56Sol.click();
    await expect(picker).toContainText('GPT 5.6 Sol');

    await picker.click();
    await window.getByTestId('chat-model-harness-tab-codex').click();
    await openLegacyOpenAi();
    await expect(
      window.getByTestId('chat-model-option-gpt-5.6-sol'),
    ).toHaveAttribute('aria-checked', 'true');
    await window.getByTestId('chat-model-option-gpt-5.6-sol').click();
    await picker.click();
    await window.getByTestId('chat-model-harness-tab-codex').click();
    await openLegacyOpenAi();
    await window.getByTestId('chat-model-option-gpt-5.6-luna').click();
    await expect(picker).toContainText('GPT 5.6 Luna');

    await picker.click();
    await window.getByTestId('chat-model-harness-tab-codex').click();
    await window.getByTestId('chat-model-harness-tab-all').click();
    // The ungated model is seeded as legacy, so it sits in the flyout.
    await openLegacyOpenAi();
    await expect(
      window.getByTestId('chat-model-option-e2e-ungated-api-model'),
    ).toBeVisible();
    await expect(
      window.getByTestId('chat-model-option-e2e-local-harness-required'),
    ).toHaveCount(0);
    await window.getByTestId('chat-model-harness-tab-claude').click();
    const fable = window.getByTestId('chat-model-option-claude-fable-5-1');
    await expect(fable).toContainText('Fable 5.1');
    await expect(fable.getByLabel('AI Credits only')).toHaveCount(0);
    // The compact menu scrolls Fable into view. Let that scroll happen
    // before clearing hover suppression with the same pointer move a user
    // makes on the way back into the row.
    await fable.hover();
    await window.mouse.move(0, 0);
    await nudgePointer(fable);
    await fable.hover();
    // The harness picker's row detail is the model card, not its description.
    const tooltip = window.getByTestId(
      'chat-model-option-detail-claude-fable-5-1',
    );
    await expect(tooltip).toBeVisible();
    await expect(tooltip).toContainText('Anthropic');
    await expect(tooltip).not.toContainText('Extra charge only');
    // Fable is an extra-charge model: its card says so.
    await expect(tooltip).toContainText('Depending on your Claude plan');
    // Fable 5 is a legacy model, listed in Claude's Legacy models flyout.
    await window
      .locator('[data-testid="chat-model-more-anthropic"]:visible')
      .first()
      .click();
    await expect(window.getByText('Fable 5', { exact: true })).toBeVisible();
    await window.keyboard.press('Escape');
    await window.keyboard.press('Escape');

    await injectModelRegistry(electronApp);
    await expect(picker).toContainText('GPT-5.6 Luna');
    // The cold→warm catalog update must not reinterpret an existing/manual
    // model as a provisional default and flip it to the new gateway candidate.
    await expect(
      picker.getByTestId('chat-model-picker-provider-icon'),
    ).toHaveAttribute('data-provider', 'codex');
    await picker.click();
    await window.getByTestId('chat-model-harness-tab-codex').click();

    await expect(
      window.getByTestId('chat-model-group-label-ai-credits'),
    ).toHaveCount(0);

    // CAN-2701: sections are the vendor, so a gateway-only row files under the
    // company that made the model — not under a family heading of its own and
    // not under the harness it happens to run on. All names Anthropic "Claude".
    await window.getByTestId('chat-model-harness-tab-all').click();
    const deepSeekLabel = window.getByTestId('chat-model-group-label-deepseek');
    const anthropicLabel = window.locator(
      '[data-testid="chat-model-group-label-anthropic"]:visible',
    );
    await expect(deepSeekLabel).toHaveText('DeepSeek');
    await expect(anthropicLabel).toHaveText('Claude');
    const deepSeekGroup = window
      .locator('div[role="group"]:visible')
      .filter({ has: deepSeekLabel });
    const anthropicGroup = window
      .locator('div[role="group"]:visible')
      .filter({ has: anthropicLabel });
    await expect(deepSeekGroup).toContainText('DeepSeek V4.1 Flash');
    // One Anthropic heading over both Anthropic rows, ordered by sortOrder,
    // rather than a "Fable" heading and a "Sonnet" heading over one row each.
    // In All one Claude heading covers native and credits rows alike.
    await expect(anthropicGroup).toContainText('Zulu Gateway');
    await expect(anthropicGroup).toContainText('Sonnet');
    // The per-family heading is gone; only the vendor heading remains.
    await expect(
      window.getByTestId('chat-model-group-label-anthropic:fable'),
    ).toHaveCount(0);

    const alpha = window.getByTestId('chat-model-option-deepseek-v4.1-flash');
    const zulu = window.getByTestId(
      'chat-model-option-claude-zulu-gateway-only',
    );
    // CAN-2349 case B: these rows are RECOVERABLE, not dead ends, so they must
    // be indistinguishable from an available row — no `aria-disabled`, no
    // sr-only reason node. The explanation moved into the recovery modal, which
    // only the user who actually wants that model ever sees.
    await expect(alpha).not.toHaveAttribute('aria-disabled', 'true');
    await expect(zulu).not.toHaveAttribute('aria-disabled', 'true');
    await expect(
      alpha.getByTestId('chat-model-row-credits-deepseek-v4.1-flash'),
    ).toBeVisible();
    await expect(
      zulu.getByTestId('chat-model-row-credits-claude-zulu-gateway-only'),
    ).toBeVisible();
    await expect(
      alpha.getByTestId('chat-model-option-locked-codex'),
    ).toHaveCount(0);

    // Clicking is the entry point now: the row opens the modal instead of
    // silently swallowing the click.
    await alpha.click();
    await expect(window.getByTestId('model-recovery-modal')).toBeVisible();
    await window.getByTestId('model-recovery-cancel').click();
    await expect(window.getByTestId('model-recovery-modal')).toHaveCount(0);
    await picker.click();
    await window.getByTestId('chat-model-harness-tab-codex').click();

    // A DeepSeek model routed over the Codex harness stays under DeepSeek: the
    // heading names the vendor, never the harness.
    const openAiGroup = window.locator('div[role="group"]:visible').filter({
      has: window.getByTestId('chat-model-group-label-openai'),
    });
    await expect(openAiGroup).toContainText('GPT-5.6 Luna');
    await expect(openAiGroup).not.toContainText('DeepSeek V4.1 Flash');
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('filters an organization-blocked model from the picker', async () => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-model-picker-org-policy-'),
  );
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    providerType: 'codex',
    tabs: [
      {
        id: CHAT_ID,
        title: 'Organization Model Policy',
        model: 'gpt-5.6-terra',
      },
    ],
  });

  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_BRANCH);

    const saveResult = await window.evaluate(
      async (apiKey) => window.api.saveCanopyCloudApiKey({ apiKey }),
      MODEL_POLICY_CLOUD_API_KEY,
    );
    expect(saveResult.status.authenticated).toBe(true);

    const picker = window
      .locator('[data-testid="chat-model-picker"]:visible')
      .first();
    await expect(picker).toContainText('GPT 5.6 Terra');
    await picker.click();
    await window.getByTestId('chat-model-harness-tab-codex').click();

    await expect(
      window.getByTestId('chat-model-option-gpt-5.6-sol'),
    ).toHaveCount(0);
    await expect(
      window.getByTestId('chat-model-option-gpt-5.6-terra'),
    ).toBeVisible();
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('routes the package GPT-6 Luna model through AI Credits', async () => {
  const fixture = JSON.parse(
    readFileSync(
      new URL('./fixtures/pr3519-gateway-catalog.json', import.meta.url),
      'utf8',
    ),
  );
  // The production GPT-6 Luna row: admin-created, so it still carries
  // `requiresLocalHarnessSupport`. The package entry claims its gateway id, so
  // the row becomes an AI Credits route instead of being skipped.
  const catalog = {
    ...fixture,
    version: 8,
    models: [
      ...fixture.models,
      {
        id: 'gpt-6-luna',
        gatewayId: 'openai/gpt-6-luna',
        label: 'GPT-6 Luna',
        family: 'openai',
        familyLabel: 'OpenAI',
        description: 'Efficient Codex model for focused, high-volume tasks',
        recommendedHarness: 'codex',
        contextWindow: 1_050_000,
        supportsPromptCaching: false,
        requiresLocalHarnessSupport: true,
        showMoreOnly: false,
        supportedThinkingLevels: ['off', 'low', 'medium', 'high', 'xhigh'],
        toolSchemaProfile: 'standard',
      },
    ],
  };
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-model-picker-gpt6-luna-credits-'),
  );
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    providerType: 'codex',
    tabs: [{ id: CHAT_ID, title: 'GPT-6 Luna credits', model: 'gpt-5.6-luna' }],
  });
  const cacheDir = path.join(userDataDir, '.cache', 'model-catalog');
  mkdirSync(cacheDir, { recursive: true });
  writeFileSync(
    path.join(cacheDir, 'ai-gateway-v1.json'),
    JSON.stringify({
      cacheVersion: 8,
      serverOrigin: MOCK_CLOUD_ORIGIN,
      brandApiNamespace: BRAND_API_NAMESPACE,
      fetchedAt: new Date().toISOString(),
      catalog,
    }),
  );

  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await connectMockCloudAccount(window, 'csk_gpt6_luna_credits_e2e');
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_BRANCH);

    const snapshot = await window.evaluate(() => window.api.getModelRegistry());
    expect(
      snapshot.gatewayRoutes
        .filter((route) => route.modelId === 'gpt-6-luna')
        .map(({ gatewayId, gatewayOnly }) => ({ gatewayId, gatewayOnly })),
    ).toEqual([{ gatewayId: 'openai/gpt-6-luna', gatewayOnly: false }]);

    const { credits } = await openModelBillingMenu(window, 'gpt-6-luna');
    await expect(credits).toBeVisible();
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

for (const surface of ['chat', 'home']) {
  test(`lists the complete credits catalog in All and bills a native model to credits from its menu (${surface})`, async () => {
    const catalog = JSON.parse(
      readFileSync(
        new URL('./fixtures/pr3519-gateway-catalog.json', import.meta.url),
        'utf8',
      ),
    );
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'pr3519-catalog-audit-'),
    );
    seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
    seedWorktreeChat({
      userDataDir,
      workspaceId: 'demo-ts-pnpm-vite',
      worktreeId: 'demo-main',
      providerType: 'codex',
      tabs: [
        { id: 'catalog-audit', title: 'Catalog audit', model: 'gpt-5.6-luna' },
      ],
    });
    const cacheDir = path.join(userDataDir, '.cache', 'model-catalog');
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(
      path.join(cacheDir, 'ai-gateway-v1.json'),
      JSON.stringify({
        cacheVersion: 8,
        serverOrigin:
          process.env.CANOPY_E2E_CLOUD_BASE_URL ?? DEFAULT_MOCK_BASE_URL,
        brandApiNamespace: 'desktop-app',
        fetchedAt: new Date().toISOString(),
        catalog: { ...catalog, version: 8 },
      }),
    );
    const { electronApp } = await launchCanopy({ userDataDir });
    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell();
      await connectMockCloudAccount(window, 'csk_pr3519_catalog_e2e');
      await app.openMainPage();
      await app.selectWorktree('demo-main');
      if (surface === 'home') {
        await window.getByTestId('sidebar-create-task').click();
        const home = window.getByTestId('page-home');
        await home.getByTestId('home-workspace-select').click();
        await window
          .getByTestId('home-workspace-option-demo-ts-pnpm-vite')
          .click();
        await home.getByTestId('home-branch-picker-button').click();
        await window
          .getByTestId('home-branch-picker-worktree-demo-main')
          .click();
      }
      const snapshot = await window.evaluate(() =>
        window.api.getModelRegistry(),
      );
      const routes = snapshot.gatewayRoutes.filter(
        (route) => route.origin !== 'org-gateway',
      );
      expect(routes.map((route) => route.gatewayId).sort()).toEqual(
        catalog.models.map((model) => model.gatewayId).sort(),
      );
      await window
        .locator('[data-testid="chat-model-picker"]:visible')
        .first()
        .click();
      await window.getByTestId('chat-model-harness-tab-all').click();
      const visibleModels = await window
        .locator('[data-testid="chat-model-menu"] [data-model-id]:visible')
        .evaluateAll((rows) =>
          rows.map((row) => row.getAttribute('data-model-id')),
        );
      // All lists every current model; older ones sit behind each vendor's
      // Legacy models flyout. Together they hold the whole credits catalog.
      const legacyModels = [];
      const legacyTriggers = await window
        .locator(
          '[data-testid="chat-model-menu"] [data-testid^="chat-model-more-"]:visible',
        )
        .evaluateAll((triggers) =>
          triggers
            .map((trigger) => trigger.getAttribute('data-testid') ?? '')
            .filter((testId) => !testId.startsWith('chat-model-more-group-')),
        );
      for (const triggerTestId of legacyTriggers) {
        const vendor = triggerTestId.slice('chat-model-more-'.length);
        await window
          .locator(`[data-testid="${triggerTestId}"]:visible`)
          .first()
          .click();
        const flyout = window.getByTestId(`chat-model-more-group-${vendor}`);
        await expect(flyout).toBeVisible();
        legacyModels.push(
          ...(await flyout
            .locator('[data-model-id]')
            .evaluateAll((rows) =>
              rows.map((row) => row.getAttribute('data-model-id')),
            )),
        );
      }
      expect([...visibleModels, ...legacyModels]).toEqual(
        expect.arrayContaining(routes.map((route) => route.modelId)),
      );
      await window.keyboard.press('Escape');
      if (await window.getByTestId('chat-model-menu').isVisible()) {
        await window.keyboard.press('Escape');
      }
      await expect(window.getByTestId('chat-model-menu')).toBeHidden();
      await window
        .locator('[data-testid="chat-model-picker"]:visible')
        .first()
        .click();
      await window.getByTestId('chat-model-harness-tab-all').click();
      for (const route of routes.filter((candidate) =>
        visibleModels.includes(candidate.modelId),
      )) {
        const row = window.getByTestId(`chat-model-option-${route.modelId}`);
        await row.scrollIntoViewIfNeeded();
        await expect(row).toBeInViewport();
      }
      await window.getByTestId('chat-model-option-gpt-5.6-terra').click();
      // Credits for a native model are this chat's billing, set from the
      // model's own menu (Home sets the billing its new chat starts with).
      await window
        .locator('[data-testid="chat-model-picker"]:visible')
        .first()
        .click();
      await openModelBillingMenu(window, 'gpt-5.6-terra');
      await window
        .getByTestId('chat-model-billing-credits-gpt-5.6-terra')
        .click();
      await expect(
        window.getByTestId('chat-model-billing-credits-gpt-5.6-terra'),
      ).toHaveAttribute('aria-checked', 'true');
      await expect(
        window.getByTestId('chat-model-billing-fallback-gpt-5.6-terra'),
      ).toHaveCount(0);
      await window.keyboard.press('Escape');
      await window.keyboard.press('Escape');
      if (surface === 'home') {
        await window
          .getByTestId('page-home')
          .getByTestId('home-send-button')
          .click();
        await expect(window.getByTestId('page-home')).toHaveCount(0);
      }
      await expect
        .poll(async () => {
          const state = await window.evaluate(() =>
            window.api.chat.getState({
              projectId: 'demo-ts-pnpm-vite',
              worktreeId: 'demo-main',
            }),
          );
          const tab = state.tabsFile.tabs.find(
            (tab) =>
              tab.id ===
              (surface === 'chat'
                ? 'catalog-audit'
                : state.tabsFile.activeTabId),
          );
          return {
            model: tab?.model,
            credits: tab?.aiCreditsRouting?.active,
            subscription: tab?.subscriptionBillingOverride === true,
          };
        })
        .toEqual({
          model: 'gpt-5.6-terra',
          credits: true,
          subscription: false,
        });
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });
}

test('runs a credits model on the harness it was picked from and remembers the All choice', async () => {
  const catalog = JSON.parse(
    readFileSync(
      new URL('./fixtures/pr3519-gateway-catalog.json', import.meta.url),
      'utf8',
    ),
  );
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-model-picker-harness-choice-'),
  );
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedWorktreeChat({
    userDataDir,
    workspaceId: 'demo-ts-pnpm-vite',
    worktreeId: 'demo-main',
    providerType: 'codex',
    tabs: [
      { id: 'harness-choice', title: 'Harness choice', model: 'gpt-5.6-luna' },
    ],
  });
  const cacheDir = path.join(userDataDir, '.cache', 'model-catalog');
  mkdirSync(cacheDir, { recursive: true });
  writeFileSync(
    path.join(cacheDir, 'ai-gateway-v1.json'),
    JSON.stringify({
      cacheVersion: 8,
      serverOrigin:
        process.env.CANOPY_E2E_CLOUD_BASE_URL ?? DEFAULT_MOCK_BASE_URL,
      brandApiNamespace: 'desktop-app',
      fetchedAt: new Date().toISOString(),
      catalog: { ...catalog, version: 8 },
    }),
  );
  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await connectMockCloudAccount(window, 'csk_harness_choice_e2e');
    await app.openMainPage();
    await app.selectWorktree('demo-main');
    const picker = window
      .locator('[data-testid="chat-model-picker"]:visible')
      .first();
    const chatTab = async () => {
      const state = await window.evaluate(() =>
        window.api.chat.getState({
          projectId: 'demo-ts-pnpm-vite',
          worktreeId: 'demo-main',
        }),
      );
      const tab = state.tabsFile.tabs.find(
        (candidate) => candidate.id === 'harness-choice',
      );
      return { model: tab?.model, harness: tab?.executionHarness };
    };

    // DeepSeek defaults to Codex; picking it from the Claude tab runs it there.
    await picker.click();
    await window.getByTestId('chat-model-harness-tab-claude').click();
    const visible = (testId) =>
      window.locator(`[data-testid="${testId}"]:visible`).first();
    const deepseek = visible('chat-model-option-deepseek-v4-pro');
    await deepseek.scrollIntoViewIfNeeded();
    await expect(
      visible('chat-model-harness-icon-deepseek-v4-pro'),
    ).toHaveAttribute('data-harness', 'claude');
    await deepseek.click();
    await expect
      .poll(chatTab)
      .toEqual({ model: 'deepseek-v4-pro', harness: 'claude' });

    // That pick is this chat's; the model's remembered harness is still Codex.
    // In All, the harness menu moves the model itself to Claude.
    await picker.click();
    await window.getByTestId('chat-model-harness-tab-all').click();
    const control = visible('chat-model-harness-control-deepseek-v4-pro');
    await control.scrollIntoViewIfNeeded();
    await expect(control).toHaveAttribute('data-harness', 'codex');
    await control.click();
    await visible('chat-model-settings-harness-claude-deepseek-v4-pro').click();
    await expect
      .poll(chatTab)
      .toEqual({ model: 'deepseek-v4-pro', harness: 'claude' });
    await expect
      .poll(async () => {
        const snapshot = await window.evaluate(() =>
          window.api.harnessAssignments.load(),
        );
        const assignment = snapshot.assignments.find(
          (candidate) => candidate.modelId === 'deepseek-v4-pro',
        );
        return {
          harness: assignment?.harness,
          overridden: assignment?.overridden,
        };
      })
      .toEqual({ harness: 'claude', overridden: true });
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('shows a model family added after this build under its catalog label with the generic icon', async () => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-model-picker-unknown-family-'),
  );
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    providerType: 'codex',
    tabs: [
      {
        id: CHAT_ID,
        title: 'Unknown Family Picker',
        model: 'gpt-5.6-luna',
      },
    ],
  });
  seedUnknownFamilyCatalog(userDataDir);

  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_BRANCH);

    const picker = window
      .locator('[data-testid="chat-model-picker"]:visible')
      .first();
    await picker.click();
    await window.getByTestId('chat-model-harness-tab-all').click();

    const mistralLabel = window.getByTestId('chat-model-group-label-mistral');
    await expect(mistralLabel).toHaveText('Mistral');
    const mistralGroup = window
      .locator('div[role="group"]:visible')
      .filter({ has: mistralLabel });
    const mistralRow = window.getByTestId(
      'chat-model-option-e2e-mistral-large',
    );
    await expect(mistralRow).toBeVisible();
    await expect(mistralGroup).toContainText('Mistral Large');
    await expect(
      window.locator(
        '[data-testid="chat-model-group-icon-mistral"] svg[data-generic-provider-icon="true"]',
      ),
    ).toBeVisible();
    // A family this build already knows keeps its dedicated glyph.
    await expect(
      window.locator(
        '[data-testid="chat-model-group-icon-openai"]:visible svg',
      ),
    ).not.toHaveAttribute('data-generic-provider-icon', 'true');
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
