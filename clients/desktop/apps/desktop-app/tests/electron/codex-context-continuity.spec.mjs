import { selectModelOption } from './model-selection-fixture.mjs';
import { readChatStorageIndexes } from './readChatStorage.mjs';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import {
  DEFAULT_MOCK_BASE_URL,
  seedCoworkWorkspace,
  seedMcpServers,
  seedWorkspaceApprovals,
  seedWorktreeChat,
} from './seeders/index.mjs';
import { startSessionExportCloudMock } from './sessionExportCloudMock.mjs';
import { withoutChatSummaryTraffic } from './fixtures/codex-chat-summary-traffic.mjs';
import {
  closeModelPicker,
  openModelBillingMenu,
} from './modelPickerBilling.mjs';

const WORKSPACE_ID = 'demo-ts-pnpm-vite';
const WORKTREE_ID = 'demo-main';
const SKILL_NAME = 'codex-continuity-skill';
const PRIOR_CONTEXT = 'Prior Codex context: amber-orbit-731';
const IMPORTED_ROLLOUT_CONTEXT =
  'Imported native Codex rollout context: cobalt-meteor-904';
const USER_PROMPT = 'Continue while preserving the earlier context.';
const GATEWAY_ROLLOUT_CONTEXT =
  'Gateway-routed Codex rollout context: violet-comet-518';
// The exact provider-private reasoning item observed in the poisoned rollout
// (`rollout-2026-08-20T23-21-20-01a02256-…jsonl`). OpenAI rejects it because
// `reasoning.content` must be empty for anything it did not encrypt itself.
const DEEPSEEK_REASONING_TEXT =
  'The user is asking me to say "hi" in 3 languages…';
const DEEPSEEK_REASONING_ITEM = {
  type: 'reasoning',
  id: 'rs_1787282486656_ycxmhlm1f1a',
  summary: [],
  content: [{ type: 'reasoning_text', text: DEEPSEEK_REASONING_TEXT }],
  encrypted_content: null,
  internal_chat_message_metadata_passthrough: {
    turn_id: '01a02256-6132-75e0-822a-827ee0e3a505',
  },
};
const OPENAI_ENCRYPTED_REASONING_BLOB = 'gAAAAABo3e2e-encrypted-reasoning-blob';
const OPENAI_ENCRYPTED_REASONING_ITEM = {
  type: 'reasoning',
  id: 'rs_0a3be0000000000000000000',
  summary: [],
  content: [],
  encrypted_content: OPENAI_ENCRYPTED_REASONING_BLOB,
};
const FIXTURE_REPLY = 'Codex continuity reply from the app-server fixture';
const MOCK_CLOUD_ORIGIN = (
  process.env.CANOPY_E2E_CLOUD_BASE_URL ?? DEFAULT_MOCK_BASE_URL
).replace(/\/+$/, '');
const BRAND_API_NAMESPACE = 'desktop-app';
const ROUTE_FAMILY_CLOUD_API_KEY = 'csk_codex_route_family_e2e';
const CLOUD_ACCOUNT_CHANGED_EVENT = 'canopy:cloud-account-changed';
const DEEPSEEK_GATEWAY_MODEL = {
  id: 'deepseek-v4-pro',
  gatewayId: 'deepseek/deepseek-v4-pro',
  label: 'DeepSeek V4 Pro',
  family: 'deepseek',
  familyLabel: 'DeepSeek',
  recommendedHarness: 'codex',
  contextWindow: 128_000,
  supportsPromptCaching: false,
  requiresLocalHarnessSupport: false,
  showMoreOnly: false,
  supportedThinkingLevels: ['low', 'medium', 'high', 'xhigh'],
  toolSchemaProfile: 'standard',
};
const SOL_GATEWAY_MODEL = {
  id: 'e2e-gpt-5.6-sol',
  gatewayId: 'openai/gpt-5.6-sol',
  label: 'GPT 5.6 Sol',
  family: 'openai',
  familyLabel: 'OpenAI',
  recommendedHarness: 'codex',
  contextWindow: 200_000,
  supportsPromptCaching: false,
  requiresLocalHarnessSupport: false,
  showMoreOnly: false,
  supportedThinkingLevels: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
  toolSchemaProfile: 'standard',
};
const FIXTURE_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'fake-codex-app-server.mjs',
);

function seedPreferences(userDataDir) {
  mkdirSync(userDataDir, { recursive: true });
  writeFileSync(
    path.join(userDataDir, 'preferences.json'),
    `${JSON.stringify(
      {
        version: 1,
        preferences: {
          onboardingCompleted: ['v1'],
          defaultWorktreeProvider: 'codex',
          defaultChatProvider: 'codex',
          defaultChatInterfaceMode: 'canopy',
          mcpProxyPort: 43000 + (Date.now() % 10000),
          defaultWorktreeModelByProvider: {
            codex: { model: 'gpt-6-sol', thinkingLevel: 'high' },
          },
          defaultChatModelByProvider: {
            codex: { model: 'gpt-6-sol', thinkingLevel: 'high' },
          },
        },
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
}

function seedGatewayModelCatalog(userDataDir, additionalModels = []) {
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
          DEEPSEEK_GATEWAY_MODEL,
          SOL_GATEWAY_MODEL,
          ...additionalModels,
        ],
      },
    })}\n`,
    'utf8',
  );
}

function seedCustomSkill(userDataDir) {
  const skillDir = path.join(userDataDir, 'skills', 'custom:app', SKILL_NAME);
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(
    path.join(skillDir, 'SKILL.md'),
    [
      '---',
      'description: Codex context-continuity UI automation fixture',
      '---',
      '',
      'Use this fixture only for deterministic UI automation.',
      '',
    ].join('\n'),
    'utf8',
  );
}

function seedDeferredMcpServer(userDataDir) {
  const fixtureDir = path.join(userDataDir, 'mcp-fixtures');
  const scriptPath = path.join(fixtureDir, 'deferred-server.cjs');
  mkdirSync(fixtureDir, { recursive: true });
  writeFileSync(
    scriptPath,
    "process.stdin.resume(); process.on('SIGTERM', () => process.exit(0));\n",
    'utf8',
  );
  const now = '2026-07-20T00:00:00.000Z';
  seedMcpServers({
    userDataDir,
    servers: [
      {
        definition: {
          id: 'continuity-deferred',
          name: 'Deferred Reload Fixture',
          description: 'Codex deferred continuity UI automation fixture.',
          type: 'command',
          command: process.execPath,
          args: [scriptPath],
          createdAt: now,
          updatedAt: now,
        },
        configs: [
          {
            id: 'default',
            name: 'Default',
            enabled: true,
            envVars: {},
            extraArgs: [],
            extraHeaders: {},
            createdAt: now,
            updatedAt: now,
          },
        ],
      },
    ],
  });
}

function createFixtureRuntime(options = {}) {
  const runtimeDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-fake-codex-runtime-'),
  );
  const canonicalHome = path.join(runtimeDir, 'canonical-home');
  const statePath = path.join(runtimeDir, 'state.json');
  const logPath = path.join(runtimeDir, 'protocol.jsonl');
  mkdirSync(canonicalHome, { recursive: true });
  writeFileSync(
    statePath,
    `${JSON.stringify(
      options.state ?? { nextThread: 1, nextTurn: 1, threads: {} },
      null,
      2,
    )}\n`,
    'utf8',
  );
  return {
    canonicalHome,
    logPath,
    runtimeDir,
    statePath,
    env: {
      CODEX_EXECUTABLE: FIXTURE_PATH,
      CANOPY_E2E_CODEX_LOG_PATH: logPath,
      CANOPY_E2E_CODEX_STATE_PATH: statePath,
      CANOPY_E2E_CODEX_CANONICAL_HOME: canonicalHome,
      CANOPY_E2E_CODEX_REPLY: FIXTURE_REPLY,
      ...(options.env ?? {}),
    },
  };
}

function priorMessages() {
  const startedAt = Date.parse('2026-07-20T12:00:00.000Z');
  return [
    {
      id: 'prior-user',
      role: 'user',
      blocks: [{ type: 'text', text: 'Remember the earlier context.' }],
      timestamp: startedAt,
    },
    {
      id: 'prior-assistant',
      role: 'assistant',
      blocks: [{ type: 'text', text: PRIOR_CONTEXT }],
      timestamp: startedAt + 1_000,
    },
    {
      id: 'prior-timer',
      role: 'system',
      blocks: [
        {
          type: 'turn_timer',
          startedAt,
          completedAt: startedAt + 2_000,
        },
      ],
      timestamp: startedAt + 2_000,
    },
  ];
}

// The conversation's protocol only. A chat's first message also schedules a
// chat-summary helper thread on the same fake app-server; its thread/start and
// turn/start are not part of the continuity being asserted.
function readProtocol(logPath) {
  if (!existsSync(logPath)) return [];
  return withoutChatSummaryTraffic(
    readFileSync(logPath, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line)),
  );
}

function clientRequests(logPath) {
  return readProtocol(logPath)
    .filter((entry) => entry.direction === 'client')
    .map((entry) => entry.message);
}

/**
 * Turn starts for chat threads only. Background helpers (chat summaries, for
 * example) run their own turns on ephemeral threads in the same app-server.
 */
function chatTurnStarts(logPath) {
  const ephemeralRequests = new Set();
  const ephemeralThreads = new Set();
  const turns = [];
  for (const entry of readProtocol(logPath)) {
    const message = entry.message ?? {};
    const key = `${entry.pid}:${String(message.id)}`;
    if (entry.direction === 'client') {
      if (message.method === 'thread/start' && message.params?.ephemeral) {
        ephemeralRequests.add(key);
      } else if (message.method === 'turn/start') {
        turns.push(message);
      }
    } else if (entry.direction === 'server' && ephemeralRequests.has(key)) {
      const threadId = message.result?.thread?.id;
      if (threadId) ephemeralThreads.add(threadId);
    }
  }
  return turns.filter((turn) => !ephemeralThreads.has(turn.params?.threadId));
}

function readPersistedTabs(
  userDataDir,
  worktreeId = WORKTREE_ID,
  workspaceId = WORKSPACE_ID,
) {
  return readChatStorageIndexes(
    path.join(userDataDir, 'workspaces', workspaceId),
    worktreeId,
  ).live;
}

function assistantMessageItem(text) {
  return {
    type: 'message',
    role: 'assistant',
    content: [{ type: 'output_text', text }],
  };
}

function writeRolloutForThread(fixture, threadId, payloads) {
  const rolloutDir = path.join(
    fixture.canonicalHome,
    'sessions',
    '2026',
    '08',
    '20',
  );
  mkdirSync(rolloutDir, { recursive: true });
  writeFileSync(
    path.join(rolloutDir, `rollout-${threadId}.jsonl`),
    `${payloads
      .map((payload) => JSON.stringify({ type: 'response_item', payload }))
      .join('\n')}\n`,
    'utf8',
  );
}

function writeCapabilityLease(userDataDir, threadId, lease) {
  const leasePath = capabilityLeasePath(userDataDir, threadId);
  mkdirSync(path.dirname(leasePath), { recursive: true });
  const now = new Date().toISOString();
  writeFileSync(
    leasePath,
    `${JSON.stringify(
      {
        version: 1,
        threadId,
        snapshotId: 'seeded-snapshot',
        rootContentIds: [],
        kind: 'persisted-chat',
        createdAt: now,
        updatedAt: now,
        ...lease,
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
}

function capabilityLeasePath(userDataDir, threadId) {
  return path.join(
    userDataDir,
    'codex-capabilities',
    'v1',
    'leases',
    `${createHash('sha256').update(threadId).digest('hex')}.json`,
  );
}

function readCapabilityLease(userDataDir, threadId) {
  const leasePath = capabilityLeasePath(userDataDir, threadId);
  if (!existsSync(leasePath)) return null;
  return JSON.parse(readFileSync(leasePath, 'utf8'));
}

function injectedItemsFor(requests) {
  return requests
    .filter((request) => request.method === 'thread/inject_items')
    .flatMap((request) => request.params?.items ?? []);
}

function expectNoForeignReasoning(items) {
  const serialized = JSON.stringify(items);
  expect(serialized).not.toContain(DEEPSEEK_REASONING_TEXT);
  expect(serialized).not.toContain(OPENAI_ENCRYPTED_REASONING_BLOB);
  expect(
    items.filter(
      (item) =>
        item?.type === 'reasoning' &&
        (item.content?.length > 0 ||
          (item.encrypted_content !== undefined &&
            item.encrypted_content !== null)),
    ),
    serialized,
  ).toEqual([]);
}

async function closeFixtureApp(electronApp, userDataDir, runtimeDir) {
  await closeCanopy(electronApp, userDataDir, { keepUserData: true });
  if (process.env.CANOPY_E2E_KEEP_CODEX_CONTINUITY_FIXTURES === 'true') {
    process.stderr.write(
      `[codex-continuity] kept userData=${userDataDir} runtime=${runtimeDir}\n`,
    );
    return;
  }
  // Capability discovery can finish one final atomic cache write just after
  // Electron's close promise settles. Give that already-scheduled write a
  // bounded window, then clean both isolated test roots best-effort.
  await new Promise((resolve) => setTimeout(resolve, 500));
  for (const target of [userDataDir, `${userDataDir}-secure`, runtimeDir]) {
    try {
      rmSync(target, {
        recursive: true,
        force: true,
        maxRetries: 20,
        retryDelay: 100,
      });
    } catch {
      // The OS temp directory remains isolated if a platform scanner still
      // has a transient handle; cleanup must not hide the UI assertion result.
    }
  }
}

async function openChat(electronApp) {
  const window = await electronApp.firstWindow();
  const app = new CanopyAppDriver(window);
  await app.waitForShell({ timeout: 30_000 });
  await app.openMainPage();
  await app.selectWorktree(WORKTREE_ID);
  await expect(
    window.locator('[data-testid="panel-content-chat"]:visible'),
  ).toBeVisible();
  return window;
}

async function sendAndExpectReply(window, prompt = USER_PROMPT) {
  const composer = window.getByRole('textbox').first();
  await expect(composer).toBeVisible();
  await composer.fill(prompt);
  await window.getByRole('button', { name: 'Send message' }).click();
  await expect(window.getByText(prompt, { exact: true }).last()).toBeVisible({
    timeout: 30_000,
  });
  await expect(
    window.getByText(FIXTURE_REPLY, { exact: true }).last(),
  ).toBeVisible({ timeout: 60_000 });
}

function expectInjectedPriorContext(requests, expectedContext = PRIOR_CONTEXT) {
  // Background helpers start ephemeral threads and run their own turns.
  const startIndex = requests.findIndex(
    (request) =>
      request.method === 'thread/start' && request.params?.ephemeral !== true,
  );
  const injectIndex = requests.findIndex(
    (request) => request.method === 'thread/inject_items',
  );
  const injectedThreadId = requests[injectIndex]?.params?.threadId;
  const turnIndex = requests.findIndex(
    (request) =>
      request.method === 'turn/start' &&
      request.params?.threadId === injectedThreadId,
  );
  expect(startIndex).toBeGreaterThanOrEqual(0);
  expect(injectIndex).toBeGreaterThan(startIndex);
  expect(turnIndex).toBeGreaterThan(injectIndex);
  expect(JSON.stringify(requests[injectIndex].params?.items ?? [])).toContain(
    expectedContext,
  );
}

test.describe('Codex context continuity without synthetic homes', () => {
  test('a same-family proxy route replacement rebuilds on the pooled worker', async () => {
    test.setTimeout(180_000);
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-codex-same-family-route-'),
    );
    const alternateModel = {
      ...DEEPSEEK_GATEWAY_MODEL,
      id: 'e2e-deepseek-alternate',
      gatewayId: 'deepseek/e2e-alternate',
      label: 'DeepSeek route replacement fixture',
    };
    seedPreferences(userDataDir);
    seedGatewayModelCatalog(userDataDir, [alternateModel]);
    seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
    seedWorktreeChat({
      userDataDir,
      workspaceId: WORKSPACE_ID,
      worktreeId: WORKTREE_ID,
      providerType: 'codex',
      activeTabId: 'route-replacement',
      tabs: ['route-replacement', 'pool-keeper'].map((id) => ({
        id,
        title: id,
        providerType: 'codex',
        model: DEEPSEEK_GATEWAY_MODEL.id,
        messages: [],
      })),
    });
    const fixture = createFixtureRuntime({
      env: { CANOPY_E2E_CODEX_RETAIN_PROVIDER_CONFIG: 'true' },
    });
    const { electronApp } = await launchCanopy({
      userDataDir,
      env: fixture.env,
    });
    try {
      const window = await openChat(electronApp);
      const saved = await window.evaluate(
        async (apiKey) => window.api.saveCanopyCloudApiKey({ apiKey }),
        ROUTE_FAMILY_CLOUD_API_KEY,
      );
      expect(saved.status.authenticated).toBe(true);
      await window.evaluate((name) => {
        window.dispatchEvent(new Event(name));
      }, CLOUD_ACCOUNT_CHANGED_EVENT);
      const routePanel = window.locator(
        '[data-panel-id="panel-chat-route-replacement"]',
      );
      await sendAndExpectReply(routePanel, PRIOR_CONTEXT);
      const sourceId = chatTurnStarts(fixture.logPath)[0].params.threadId;
      const originalLease = readCapabilityLease(userDataDir, sourceId);
      expect(originalLease?.reasoningRouteFamily).toBe('gateway:deepseek');
      writeRolloutForThread(fixture, sourceId, [
        {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: PRIOR_CONTEXT }],
        },
        assistantMessageItem(FIXTURE_REPLY),
      ]);

      // A second real chat owns the pooled process while the first session is
      // recreated. A worker restart would otherwise hide retained configuration.
      await window.getByTestId('panel-tab-panel-chat-pool-keeper').click();
      await sendAndExpectReply(
        window.locator('[data-panel-id="panel-chat-pool-keeper"]'),
        'Keep this Codex worker owned.',
      );
      await window
        .getByTestId('panel-tab-panel-chat-route-replacement')
        .click();
      const picker = window
        .locator('[data-testid="chat-model-picker"]:visible')
        .first();
      await picker.click();
      await selectModelOption(window, alternateModel.id);
      await expect(picker).toContainText(alternateModel.label);
      const prompt = 'Continue on the replacement route without restarting.';
      await window.getByRole('textbox').first().fill(prompt);
      await window.getByRole('button', { name: 'Send message' }).click();
      await expect(
        routePanel.getByText(FIXTURE_REPLY, { exact: true }),
      ).toHaveCount(2, { timeout: 30_000 });

      const requests = clientRequests(fixture.logPath);
      const rebuiltTurn = chatTurnStarts(fixture.logPath).at(-1);
      // The behavioral red assertion: unchanged production resumes sourceId.
      expect(rebuiltTurn.params.threadId).not.toBe(sourceId);
      const rebuiltId = rebuiltTurn.params.threadId;
      expect(
        requests.some(
          (request) =>
            request.method === 'thread/resume' &&
            request.params?.threadId === sourceId,
        ),
      ).toBe(false);
      expect(
        requests.some(
          (request) =>
            request.method === 'thread/unsubscribe' &&
            request.params?.threadId === sourceId,
        ),
      ).toBe(true);
      const injected = requests.find(
        (request) =>
          request.method === 'thread/inject_items' &&
          request.params?.threadId === rebuiltId,
      );
      expect(JSON.stringify(injected?.params.items)).toContain(PRIOR_CONTEXT);
      expect(
        JSON.stringify([
          ...(injected?.params.items ?? []),
          ...(rebuiltTurn.params.input ?? []),
        ]).split(prompt).length - 1,
      ).toBe(1);
      await expect(window.getByText(prompt, { exact: true })).toHaveCount(1);
      await expect(
        window.getByText(PRIOR_CONTEXT, { exact: true }),
      ).toBeVisible();
      await expect
        .poll(
          () =>
            readPersistedTabs(userDataDir).tabs.find(
              (tab) => tab.id === 'route-replacement',
            )?.sdkSessionId,
        )
        .toBe(rebuiltId);

      const rebuiltLease = readCapabilityLease(userDataDir, rebuiltId);
      expect(rebuiltLease?.snapshotId).toBe(originalLease.snapshotId);
      expect(rebuiltLease?.reasoningRouteFamily).toBe(
        originalLease.reasoningRouteFamily,
      );
      const protocol = readProtocol(fixture.logPath);
      const starts = protocol.filter(
        (entry) =>
          entry.direction === 'client' &&
          entry.message?.method === 'thread/start' &&
          [sourceId, rebuiltId].includes(
            // Request IDs are scoped to the app-server process.
            protocol.find(
              (response) =>
                response.pid === entry.pid &&
                response.direction === 'server' &&
                response.message?.id === entry.message.id,
            )?.message.result?.thread?.id,
          ),
      );
      expect(starts).toHaveLength(2);
      expect(starts[0].pid).toBe(starts[1].pid);
      const configs = starts.map((entry) => entry.message.params.config);
      expect(configs[0].model_provider).toBe(configs[1].model_provider);
      const providerKey = `model_providers.${configs[0].model_provider}`;
      expect(configs[0][providerKey].base_url).not.toBe(
        configs[1][providerKey].base_url,
      );
      expect(chatTurnStarts(fixture.logPath)).toHaveLength(3);
    } finally {
      try {
        await test.info().attach('same-family-route-protocol', {
          body: JSON.stringify(readProtocol(fixture.logPath), null, 2),
          contentType: 'application/json',
        });
      } finally {
        await closeFixtureApp(electronApp, userDataDir, fixture.runtimeDir);
      }
    }
  });

  for (const persistent of [false, true]) {
    test(`a stale proxy route ${persistent ? 'settles after one retry' : 'rebuilds once with a changed thread ID and preserved context'}`, async () => {
      test.setTimeout(120_000);
      const userDataDir = mkdtempSync(
        path.join(os.tmpdir(), 'canopy-codex-stale-route-'),
      );
      seedPreferences(userDataDir);
      const seed = seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
      const workspace = seed.workspaces.find(
        (entry) => entry.id === WORKSPACE_ID,
      );
      if (!workspace) throw new Error('Missing seeded workspace');
      const sourceThreadId = 'stale-proxy-thread';
      seedWorktreeChat({
        userDataDir,
        workspaceId: WORKSPACE_ID,
        worktreeId: WORKTREE_ID,
        providerType: 'codex',
        activeTabId: 'stale-route-chat',
        tabs: [
          {
            id: 'stale-route-chat',
            title: 'Stale route recovery',
            providerType: 'codex',
            sdkSessionId: sourceThreadId,
            hasStartedSession: true,
            messages: priorMessages(),
          },
        ],
      });
      const fixture = createFixtureRuntime({
        env: {
          CANOPY_E2E_CODEX_MODE: persistent
            ? 'stale-proxy-route-persistent'
            : 'stale-proxy-route-once',
        },
        state: {
          nextThread: 1,
          nextTurn: 1,
          threads: {
            [sourceThreadId]: {
              id: sourceThreadId,
              cwd: workspace.worktreePath,
              items: [],
              selectedCapabilityRoots: [],
              dynamicTools: [],
              config: {},
            },
          },
        },
      });
      writeRolloutForThread(fixture, sourceThreadId, [
        assistantMessageItem(PRIOR_CONTEXT),
      ]);
      const { electronApp } = await launchCanopy({
        userDataDir,
        env: fixture.env,
      });
      try {
        const window = await openChat(electronApp);
        const prompt = 'Continue after the stale proxy route.';
        await window.getByRole('textbox').first().fill(prompt);
        await window.getByRole('button', { name: 'Send message' }).click();
        // This is the red assertion on unchanged production: only one actual
        // turn is submitted. The fixture does not implement recovery.
        await expect
          .poll(() => chatTurnStarts(fixture.logPath).length, {
            timeout: 30_000,
          })
          .toBe(2);
        const turns = chatTurnStarts(fixture.logPath);
        const rebuiltThreadId = turns[1].params.threadId;
        expect(turns[0].params.threadId).toBe(sourceThreadId);
        expect(rebuiltThreadId).not.toBe(sourceThreadId);
        if (persistent) {
          await expect
            .poll(
              () =>
                readProtocol(fixture.logPath).filter(
                  (entry) =>
                    entry.direction === 'server' &&
                    entry.message?.method === 'turn/completed' &&
                    entry.message.params?.turn?.status === 'failed',
                ).length,
              { timeout: 30_000 },
            )
            .toBe(2);
          await expect(
            window
              .getByText(/AI Credits proxy route is no longer available/)
              .last(),
          ).toBeVisible();
          await expect(
            window.getByText(FIXTURE_REPLY, { exact: true }),
          ).toHaveCount(0);
          await expect(window.getByTestId('chat-stop-generation')).toHaveCount(
            0,
          );
        } else {
          await expect(
            window.getByText(FIXTURE_REPLY, { exact: true }),
          ).toBeVisible({ timeout: 30_000 });
        }
        await expect(window.getByText(prompt, { exact: true })).toHaveCount(1);
        await expect(
          window.getByText(PRIOR_CONTEXT, { exact: true }),
        ).toBeVisible();
        const requests = clientRequests(fixture.logPath);
        const injected = requests.find(
          (entry) =>
            entry.method === 'thread/inject_items' &&
            entry.params?.threadId === rebuiltThreadId,
        );
        expect(JSON.stringify(injected?.params.items)).toContain(PRIOR_CONTEXT);
        // The failed turn wrote the pending input to its rollout. The rebuilt
        // thread receives one copy across injection and the retry's own input.
        const rebuiltInputs = [
          ...(injected?.params.items ?? []),
          ...(turns[1].params.input ?? []),
        ];
        expect(JSON.stringify(rebuiltInputs).split(prompt).length - 1).toBe(1);
        await expect
          .poll(
            () =>
              readPersistedTabs(userDataDir).tabs.find(
                (tab) => tab.id === 'stale-route-chat',
              )?.sdkSessionId,
          )
          .toBe(rebuiltThreadId);
        expect(chatTurnStarts(fixture.logPath)).toHaveLength(2);
      } finally {
        try {
          const testInfo = test.info();
          await testInfo.attach('stale-route-protocol', {
            body: JSON.stringify(readProtocol(fixture.logPath), null, 2),
            contentType: 'application/json',
          });
        } finally {
          await closeFixtureApp(electronApp, userDataDir, fixture.runtimeDir);
        }
      }
    });
  }

  test('a cross-provider continuation sends only its handoff summary to Codex', async () => {
    test.setTimeout(120_000);
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-codex-summary-only-continuation-'),
    );
    seedPreferences(userDataDir);
    seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
    seedWorktreeChat({
      userDataDir,
      workspaceId: WORKSPACE_ID,
      worktreeId: WORKTREE_ID,
      providerType: 'codex',
      activeTabId: 'continued-chat',
      tabs: [
        {
          id: 'continued-chat',
          title: 'Continued from Claude',
          providerType: 'codex',
          model: 'gpt-6-sol',
          messages: priorMessages(),
          forkedFrom: {
            projectId: WORKSPACE_ID,
            worktreeId: WORKTREE_ID,
            chatId: 'claude-source',
            atMessageId: 'prior-timer',
            continuedFromProvider: 'claude',
          },
          pendingSystemInstructions: [
            {
              id: 'handoff-summary',
              text: '[SESSION HANDOFF]\n\nSummary: the archive spec now passes.',
            },
          ],
        },
      ],
    });
    const fixture = createFixtureRuntime();
    const { electronApp } = await launchCanopy({
      userDataDir,
      env: fixture.env,
    });

    try {
      const window = await openChat(electronApp);
      await sendAndExpectReply(window, 'Continue from the handoff summary.');

      await expect
        .poll(
          () =>
            clientRequests(fixture.logPath).filter(
              (request) => request.method === 'turn/start',
            ).length,
          { timeout: 30_000 },
        )
        .toBe(1);
      const requests = clientRequests(fixture.logPath);
      expect(JSON.stringify(injectedItemsFor(requests))).not.toContain(
        PRIOR_CONTEXT,
      );
      expect(JSON.stringify(requests)).toContain(
        'Summary: the archive spec now passes.',
      );
    } finally {
      await closeFixtureApp(electronApp, userDataDir, fixture.runtimeDir);
    }
  });

  for (const origin of ['manual', 'watcher']) {
    test(`an incompatible process profile hands an idle chat's thread to the new worker before submitting its follow-up once (${origin})`, async () => {
      test.setTimeout(180_000);
      const userDataDir = mkdtempSync(
        path.join(os.tmpdir(), 'canopy-codex-writer-handoff-'),
      );
      seedPreferences(userDataDir);
      seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
      seedWorktreeChat({
        userDataDir,
        workspaceId: WORKSPACE_ID,
        worktreeId: WORKTREE_ID,
        providerType: 'codex',
        activeTabId: 'writer-chat',
        tabs: [
          {
            id: 'writer-chat',
            title: 'Writer handoff',
            providerType: 'codex',
            model: 'gpt-6-sol',
            messages: [],
          },
        ],
      });
      const fixture = createFixtureRuntime({
        env: { CANOPY_E2E_CODEX_RETAIN_WRITER: 'true' },
      });
      const { electronApp } = await launchCanopy({
        userDataDir,
        env: fixture.env,
        ...(process.env.WRITER_RELEASE_BUILD === 'true'
          ? { buildKind: 'production' }
          : {}),
      });
      const metrics = [];
      try {
        const window = await openChat(electronApp);
        await sendAndExpectReply(window, 'Remember the original conversation.');
        let sourceId;
        await expect(() => {
          sourceId = readPersistedTabs(userDataDir).tabs.find(
            (tab) => tab.id === 'writer-chat',
          )?.sdkSessionId;
          expect(sourceId).toMatch(/^e2e-thread-/);
        }).toPass({ timeout: 15_000 });
        writeRolloutForThread(fixture, sourceId, [
          assistantMessageItem(PRIOR_CONTEXT),
        ]);
        writeFileSync(fixture.logPath, '', 'utf8');

        // Change the process environment through Settings, then select another
        // native model to recreate the logical session with the same capabilities.
        const app = new CanopyAppDriver(window);
        await app.openEnvironmentsSettings();
        await window
          .getByTestId('environments-list-row-default-overall')
          .click();
        await window.getByTestId('environment-editor-add-row').click();
        await window
          .locator('input[data-testid^="environment-editor-key-"]')
          .last()
          .fill('CANOPY_TEST_PROFILE');
        await window
          .locator('[data-testid^="environment-editor-value-"]')
          .last()
          .fill('replacement');
        await window.getByTestId('environments-save').click();
        await expect(window.getByTestId('environments-save-status')).toHaveText(
          'Saved.',
        );
        await app.closeSettings();
        await app.openMainPage();
        await app.selectWorktree(WORKTREE_ID);
        const picker = window
          .locator('[data-testid="chat-model-picker"]:visible')
          .first();
        await picker.click();
        await selectModelOption(window, 'gpt-5.6-sol');
        await window.getByTestId('chat-input-plus-button').click();
        await window.getByTestId('chat-input-plan-mode-button').click();
        await expect(
          window.getByTestId('chat-input-plan-mode-inline-button'),
        ).toHaveAttribute('aria-pressed', 'true');
        const composer = window.getByRole('textbox').first();
        await composer.fill(origin === 'manual' ? USER_PROMPT : '');
        metrics.push({
          phase: 'before-follow-up',
          processes: await electronApp.evaluate(({ app }) =>
            app.getAppMetrics(),
          ),
        });
        if (origin === 'manual') {
          await window.getByRole('button', { name: 'Send message' }).click();
        } else {
          await electronApp.evaluate(({ BrowserWindow }, text) => {
            const command = {
              type: 'send_watcher_message',
              projectId: 'demo-ts-pnpm-vite',
              worktreeId: 'demo-main',
              chatId: 'writer-chat',
              watcherId: 'writer-handoff',
              deliveryId: 'writer-handoff-delivery',
              text,
              watcherFired: { kind: 'Pipeline completion (Handoff)' },
            };
            const win = BrowserWindow.getAllWindows()[0];
            win.webContents.send('chat:window-command', command);
            win.webContents.send('chat:window-command', command);
          }, USER_PROMPT);
        }
        const draftStart = performance.now();
        await composer.fill('Draft while restarting');
        await window.evaluate(
          () =>
            new Promise((resolve) =>
              requestAnimationFrame(() => requestAnimationFrame(resolve)),
            ),
        );
        metrics.push({
          phase: 'draft-during-follow-up',
          elapsedMs: performance.now() - draftStart,
          processes: await electronApp.evaluate(({ app }) =>
            app.getAppMetrics(),
          ),
        });
        await expect(
          window.getByText(FIXTURE_REPLY, { exact: true }),
        ).toHaveCount(2, { timeout: 45_000 });
        await expect(composer).toHaveText('Draft while restarting');
        if (origin === 'watcher') {
          await expect(window.getByTestId('watcher-fired-title')).toHaveText(
            'Pipeline completion (Handoff) watcher has fired',
          );
        }
        const entries = readProtocol(fixture.logPath);
        const requests = clientRequests(fixture.logPath);
        const followUps = requests.filter(
          (request) =>
            request.method === 'turn/start' &&
            JSON.stringify(request.params?.input).includes(USER_PROMPT),
        );
        expect(followUps).toHaveLength(1);
        expect(followUps[0].params.model).toBe('gpt-5.6-sol');
        // The replaced profile's worker still held the idle thread's writer.
        // It had no live work, so it was stopped and the same thread resumed
        // on the new worker instead of being rebuilt as a new thread.
        expect(followUps[0].params.threadId).toBe(sourceId);
        const resumes = entries.filter(
          (entry) =>
            entry.direction === 'client' &&
            entry.message?.method === 'thread/resume' &&
            entry.message.params?.threadId === sourceId,
        );
        expect(resumes.length).toBeGreaterThan(0);
        const resumedPid = resumes.at(-1)?.pid;
        const followUpEntry = entries.find(
          (entry) =>
            entry.direction === 'client' &&
            entry.message?.method === 'turn/start' &&
            JSON.stringify(entry.message.params?.input).includes(USER_PROMPT),
        );
        expect(followUpEntry?.pid).toBe(resumedPid);
        expect(
          requests.some(
            (request) =>
              request.method === 'thread/inject_items' &&
              JSON.stringify(request.params?.items ?? []).includes(
                PRIOR_CONTEXT,
              ),
          ),
        ).toBe(false);
        // Rendering the reply can precede snapshot replacement. The primary
        // may briefly be absent while it is rotated to the backup, so retry
        // the disk read and assertion together until persistence completes.
        await expect(() => {
          expect(
            readPersistedTabs(userDataDir).tabs.find(
              (tab) => tab.id === 'writer-chat',
            )?.sdkSessionId,
          ).toBe(followUps[0].params.threadId);
        }).toPass({ timeout: 15_000 });
      } finally {
        const metricsPath = test
          .info()
          .outputPath('writer-handoff-metrics.json');
        writeFileSync(metricsPath, JSON.stringify(metrics, null, 2));
        await test.info().attach('writer-handoff-metrics', {
          path: metricsPath,
          contentType: 'application/json',
        });
        await test.info().attach('writer-handoff-protocol', {
          path: fixture.logPath,
          contentType: 'application/x-ndjson',
        });
        await closeFixtureApp(electronApp, userDataDir, fixture.runtimeDir);
      }
    });
  }

  test('changing an existing chat skill starts, injects, and continues with prior context', async () => {
    test.setTimeout(120_000);
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-codex-capability-change-'),
    );
    seedPreferences(userDataDir);
    seedCustomSkill(userDataDir);
    seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
    seedWorktreeChat({
      userDataDir,
      workspaceId: WORKSPACE_ID,
      worktreeId: WORKTREE_ID,
      providerType: 'codex',
      activeTabId: 'capability-chat',
      tabs: [
        {
          id: 'capability-chat',
          title: 'Capability change',
          providerType: 'codex',
          sdkSessionId: 'legacy-capability-thread',
          hasStartedSession: true,
          messages: priorMessages(),
        },
      ],
    });
    const fixture = createFixtureRuntime();
    const { electronApp } = await launchCanopy({
      userDataDir,
      env: fixture.env,
    });

    try {
      const window = await openChat(electronApp);
      await expect(
        window.getByText(PRIOR_CONTEXT, { exact: true }),
      ).toBeVisible();

      await window.getByTestId('chat-input-plus-button').click();
      await window.getByTestId('chat-plugins-button').click();
      const dialog = window
        .locator('[role="dialog"]')
        .filter({ hasText: 'Plugins' });
      await expect(dialog).toBeVisible();
      await dialog.getByPlaceholder('Search by name…').fill(SKILL_NAME);
      await dialog
        .getByRole('combobox', { name: 'Kind filter' })
        .selectOption('skill');
      const skill = dialog.getByRole('checkbox', {
        name: `Select ${SKILL_NAME}`,
      });
      await expect(skill).toBeVisible({ timeout: 30_000 });
      await skill.check();
      await dialog.getByRole('button', { name: 'Save' }).click();
      await expect(dialog).toHaveCount(0);

      await sendAndExpectReply(window);
      await expect(
        window.getByText(PRIOR_CONTEXT, { exact: true }),
      ).toBeVisible();

      await expect
        .poll(() => clientRequests(fixture.logPath), { timeout: 30_000 })
        .toEqual(
          expect.arrayContaining([
            expect.objectContaining({ method: 'thread/inject_items' }),
          ]),
        );
      const requests = clientRequests(fixture.logPath);
      expectInjectedPriorContext(requests);
      expect(
        requests.some(
          (request) =>
            request.method === 'thread/resume' &&
            request.params?.threadId === 'legacy-capability-thread',
        ),
      ).toBe(false);

      await expect
        .poll(() => {
          const file = readPersistedTabs(userDataDir);
          return file.tabs.find((tab) => tab.id === 'capability-chat')
            ?.sdkSessionId;
        })
        .toMatch(/^e2e-thread-/);
    } finally {
      await closeFixtureApp(electronApp, userDataDir, fixture.runtimeDir);
    }
  });

  test('the plugin picker saves without forcing a failing Codex capability injection', async () => {
    test.setTimeout(120_000);
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-codex-capability-rollback-'),
    );
    seedPreferences(userDataDir);
    seedCustomSkill(userDataDir);
    seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
    seedWorktreeChat({
      userDataDir,
      workspaceId: WORKSPACE_ID,
      worktreeId: WORKTREE_ID,
      providerType: 'codex',
      activeTabId: 'rollback-chat',
      tabs: [
        {
          id: 'rollback-chat',
          title: 'Capability rollback',
          providerType: 'codex',
          sdkSessionId: 'legacy-rollback-thread',
          hasStartedSession: true,
          messages: priorMessages(),
        },
      ],
    });
    const fixture = createFixtureRuntime({
      env: { CANOPY_E2E_CODEX_FAIL_INJECT: 'true' },
    });
    const { electronApp } = await launchCanopy({
      userDataDir,
      env: fixture.env,
    });

    try {
      const window = await openChat(electronApp);
      await window.getByTestId('chat-input-plus-button').click();
      await window.getByTestId('chat-plugins-button').click();
      const dialog = window
        .locator('[role="dialog"]')
        .filter({ hasText: 'Plugins' });
      await dialog.getByPlaceholder('Search by name…').fill(SKILL_NAME);
      await dialog
        .getByRole('combobox', { name: 'Kind filter' })
        .selectOption('skill');
      await dialog
        .getByRole('checkbox', { name: `Select ${SKILL_NAME}` })
        .check();
      await dialog.getByRole('button', { name: 'Save' }).click();

      await expect(dialog).toHaveCount(0);
      await expect
        .poll(() => {
          const persisted = readPersistedTabs(userDataDir);
          const tab = persisted.tabs.find(
            (entry) => entry.id === 'rollback-chat',
          );
          return {
            sdkSessionId: tab?.sdkSessionId,
            skillRefs: tab?.pluginSelections?.skillRefs ?? [],
          };
        })
        .toEqual({
          sdkSessionId: 'legacy-rollback-thread',
          skillRefs: [{ sourceId: 'custom:app', skillName: SKILL_NAME }],
        });
      expect(
        clientRequests(fixture.logPath).some(
          (request) => request.method === 'thread/start',
        ),
      ).toBe(false);
    } finally {
      await closeFixtureApp(electronApp, userDataDir, fixture.runtimeDir);
    }
  });

  test('a cowork MCP picker save persists without initializing the Codex thread', async () => {
    test.setTimeout(120_000);
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-codex-cowork-mcp-picker-'),
    );
    const workspaceId = 'cowork-mcp-picker';
    const workEntryId = 'mcp-picker-entry';
    const chatId = workEntryId;
    seedPreferences(userDataDir);
    seedDeferredMcpServer(userDataDir);
    seedCoworkWorkspace({
      userDataDir,
      workspaceId,
      name: 'Cowork MCP Picker',
      collapsed: false,
      chatId,
      chatTitle: 'MCP picker entry',
    });
    const workspaceDir = path.join(userDataDir, 'workspaces', workspaceId);
    const coworkTabsPath = path.join(workspaceDir, 'chats', 'home.json');
    const coworkTabs = JSON.parse(readFileSync(coworkTabsPath, 'utf8'));
    coworkTabs.tabs[0] = {
      ...coworkTabs.tabs[0],
      sdkSessionId: 'legacy-cowork-picker-thread',
      hasStartedSession: true,
      messages: priorMessages(),
    };
    writeFileSync(
      coworkTabsPath,
      `${JSON.stringify(coworkTabs, null, 2)}\n`,
      'utf8',
    );
    const fixture = createFixtureRuntime({
      env: { CANOPY_E2E_CODEX_FAIL_INJECT: 'true' },
    });
    const { electronApp } = await launchCanopy({
      userDataDir,
      env: fixture.env,
    });

    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell({ timeout: 30_000 });
      const toggle = window.getByTestId(
        `sidebar-cowork-project-${workspaceId}-toggle`,
      );
      if ((await toggle.getAttribute('aria-expanded')) !== 'true') {
        await toggle.click();
      }
      await window.getByTestId(`sidebar-work-entry-${workEntryId}`).click();
      await expect(window.getByTestId('panel-content-chat')).toBeVisible({
        timeout: 30_000,
      });

      await window.getByTestId('chat-input-plus-button').click();
      await window.getByTestId('chat-plugins-button').click();
      const dialog = window
        .locator('[role="dialog"]')
        .filter({ hasText: 'Plugins' });
      await dialog
        .getByPlaceholder('Search by name…')
        .fill('Deferred Reload Fixture');
      await dialog
        .getByRole('combobox', { name: 'Kind filter' })
        .selectOption('mcp');
      await dialog
        .getByRole('checkbox', { name: 'Select Deferred Reload Fixture' })
        .check();
      await dialog.getByRole('button', { name: 'Save' }).click();

      await expect(dialog).toHaveCount(0);
      await expect
        .poll(() => {
          const persisted = readPersistedTabs(
            userDataDir,
            workEntryId,
            workspaceId,
          );
          const tab = persisted.tabs.find((entry) => entry.id === chatId);
          return {
            sdkSessionId: tab?.sdkSessionId,
            mcpServerRefs: tab?.pluginSelections?.mcpServerRefs ?? [],
          };
        })
        .toEqual({
          sdkSessionId: 'legacy-cowork-picker-thread',
          mcpServerRefs: [
            { serverId: 'continuity-deferred', configId: 'default' },
          ],
        });
      expect(
        clientRequests(fixture.logPath).some(
          (request) => request.method === 'thread/start',
        ),
      ).toBe(false);
    } finally {
      await closeFixtureApp(electronApp, userDataDir, fixture.runtimeDir);
    }
  });

  for (const missingThreadError of [
    'thread not found: 019f8b17-16cf-7671-9f73-4cfe05d355c9',
    'no rollout found for thread id 019f8b17-16cf-7671-9f73-4cfe05d355c9',
  ]) {
    test(`a stale Codex thread falls back with ${missingThreadError}`, async () => {
      test.setTimeout(120_000);
      const userDataDir = mkdtempSync(
        path.join(os.tmpdir(), 'canopy-codex-stale-thread-'),
      );
      seedPreferences(userDataDir);
      seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
      seedWorktreeChat({
        userDataDir,
        workspaceId: WORKSPACE_ID,
        worktreeId: WORKTREE_ID,
        providerType: 'codex',
        activeTabId: 'stale-chat',
        tabs: [
          {
            id: 'stale-chat',
            title: 'Stale thread',
            providerType: 'codex',
            sdkSessionId: '019f8b17-16cf-7671-9f73-4cfe05d355c9',
            hasStartedSession: true,
            messages: priorMessages(),
          },
        ],
      });
      const fixture = createFixtureRuntime({
        env: { CANOPY_E2E_CODEX_MISSING_THREAD_ERROR: missingThreadError },
      });
      const { electronApp } = await launchCanopy({
        userDataDir,
        env: fixture.env,
      });

      try {
        const window = await openChat(electronApp);
        await sendAndExpectReply(window);
        await expect(
          window.getByText(PRIOR_CONTEXT, { exact: true }),
        ).toBeVisible();

        await expect
          .poll(() => clientRequests(fixture.logPath), { timeout: 30_000 })
          .toEqual(
            expect.arrayContaining([
              expect.objectContaining({ method: 'thread/inject_items' }),
            ]),
          );
        const requests = clientRequests(fixture.logPath);
        expect(requests[0]?.method).toBe('initialize');
        expect(
          requests.some(
            (request) =>
              request.method === 'thread/resume' &&
              request.params?.threadId ===
                '019f8b17-16cf-7671-9f73-4cfe05d355c9',
          ),
        ).toBe(true);
        expectInjectedPriorContext(requests);
      } finally {
        await closeFixtureApp(electronApp, userDataDir, fixture.runtimeDir);
      }
    });
  }

  function seedClosingThreadChat(userDataDir, threadId) {
    seedPreferences(userDataDir);
    const seed = seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
    const workspace = seed.workspaces.find(
      (candidate) => candidate.id === WORKSPACE_ID,
    );
    if (!workspace) throw new Error('Missing seeded project');
    seedWorktreeChat({
      userDataDir,
      workspaceId: WORKSPACE_ID,
      worktreeId: WORKTREE_ID,
      providerType: 'codex',
      activeTabId: 'closing-chat',
      tabs: [
        {
          id: 'closing-chat',
          title: 'Closing thread',
          providerType: 'codex',
          model: 'gpt-6-sol',
          sdkSessionId: threadId,
          hasStartedSession: true,
          messages: priorMessages(),
        },
      ],
    });
    return {
      nextThread: 1,
      nextTurn: 1,
      threads: {
        [threadId]: {
          id: threadId,
          cwd: workspace.worktreePath,
          items: [],
          selectedCapabilityRoots: [],
          dynamicTools: [],
          config: {},
        },
      },
    };
  }

  test('a follow-up sent while the app-server is still closing the thread resumes it without an error', async () => {
    test.setTimeout(120_000);
    const threadId = 'closing-thread-brief';
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-codex-closing-thread-'),
    );
    const fixture = createFixtureRuntime({
      state: seedClosingThreadChat(userDataDir, threadId),
      // Rejected twice: one retry after a backoff, one after `thread/closed`.
      env: { CANOPY_E2E_CODEX_CLOSING_RESUMES: '2' },
    });
    const { electronApp } = await launchCanopy({
      userDataDir,
      env: fixture.env,
    });

    try {
      const window = await openChat(electronApp);
      await sendAndExpectReply(window);

      const panel = window.getByTestId('panel-content-chat');
      await expect(panel).not.toContainText('is closing');
      await expect(
        panel.getByTestId('chat-input-transient-retry-banner'),
      ).toBeHidden();
      await expect(window.getByText(USER_PROMPT, { exact: true })).toHaveCount(
        1,
      );

      const requests = clientRequests(fixture.logPath);
      expect(
        requests.filter(
          (request) =>
            request.method === 'thread/resume' &&
            request.params?.threadId === threadId,
        ),
      ).toHaveLength(3);
      // The rejection must never rebuild the thread from history.
      expect(requests.map((request) => request.method)).not.toContain(
        'thread/start',
      );
      expect(requests.map((request) => request.method)).not.toContain(
        'thread/inject_items',
      );
      expect(
        requests.filter((request) => request.method === 'turn/start'),
      ).toHaveLength(1);
    } finally {
      await closeFixtureApp(electronApp, userDataDir, fixture.runtimeDir);
    }
  });

  test('a thread that stays closing past the retry budget shows the retry countdown and then recovers', async () => {
    test.setTimeout(180_000);
    const threadId = 'closing-thread-long';
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-codex-closing-thread-long-'),
    );
    const state = seedClosingThreadChat(userDataDir, threadId);
    const holdDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-codex-closing-hold-'),
    );
    const holdPath = path.join(holdDir, 'closing');
    writeFileSync(holdPath, '', 'utf8');
    const fixture = createFixtureRuntime({
      state,
      env: { CANOPY_E2E_CODEX_CLOSING_HOLD_PATH: holdPath },
    });
    const { electronApp } = await launchCanopy({
      userDataDir,
      env: fixture.env,
    });

    try {
      const window = await openChat(electronApp);
      const panel = window.getByTestId('panel-content-chat');
      const composer = window.getByRole('textbox').first();
      await composer.fill(USER_PROMPT);
      await window.getByRole('button', { name: 'Send message' }).click();

      // The in-client retries give up after their bounded budget; the chat
      // then schedules its own retry instead of leaving a terminal error.
      const banner = panel.getByTestId('chat-input-transient-retry-banner');
      await expect(banner).toContainText('attempt 1 of 5', {
        timeout: 60_000,
      });
      await expect(banner).toContainText(/Retrying in 0:[0-3]\d/);
      await expect(panel).toContainText('is closing');
      expect(
        clientRequests(fixture.logPath).filter(
          (request) => request.method === 'turn/start',
        ),
      ).toHaveLength(0);

      rmSync(holdPath, { force: true });
      await expect(
        window.getByText(FIXTURE_REPLY, { exact: true }).last(),
      ).toBeVisible({ timeout: 60_000 });
      await expect(banner).toBeHidden();

      const requests = clientRequests(fixture.logPath);
      expect(requests.map((request) => request.method)).not.toContain(
        'thread/start',
      );
      const turnStarts = requests.filter(
        (request) => request.method === 'turn/start',
      );
      expect(turnStarts).toHaveLength(1);
      // Nothing ran before the failure, so the retry resends the request.
      expect(JSON.stringify(turnStarts[0].params.input)).toContain(USER_PROMPT);
    } finally {
      await closeFixtureApp(electronApp, userDataDir, fixture.runtimeDir);
      rmSync(holdDir, { recursive: true, force: true });
    }
  });

  for (const scenario of [
    'normal',
    'unicode-resume',
    'immediate-continue',
    'failed-fork',
    'cancelled-fork',
  ]) {
    test(`Fork Chat preserves context (${scenario})`, async () => {
      test.setTimeout(180_000);
      const userDataDir = mkdtempSync(
        path.join(os.tmpdir(), 'canopy-codex-native-fork-'),
      );
      seedPreferences(userDataDir);
      seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
      seedWorktreeChat({
        userDataDir,
        workspaceId: WORKSPACE_ID,
        worktreeId: WORKTREE_ID,
        providerType: 'codex',
        activeTabId: 'source-chat',
        tabs: [
          {
            id: 'source-chat',
            title: 'Fork source',
            providerType: 'codex',
            messages: [],
          },
        ],
      });
      const fixture = createFixtureRuntime({
        env: {
          ...(scenario === 'unicode-resume'
            ? { CANOPY_E2E_CODEX_UNICODE_RESUME: 'true' }
            : {}),
          ...(['immediate-continue', 'cancelled-fork'].includes(scenario)
            ? { CANOPY_E2E_CODEX_FORK_DELAY_MS: '5000' }
            : {}),
          ...(scenario === 'failed-fork'
            ? { CANOPY_E2E_CODEX_FORK_FAIL: 'true' }
            : {}),
        },
      });
      const { electronApp } = await launchCanopy({
        userDataDir,
        env: fixture.env,
      });

      try {
        const window = await openChat(electronApp);
        const sourcePrompt =
          'Remember: our diagram review code word is marigold.';
        await sendAndExpectReply(window, sourcePrompt);
        let sourceThreadId;
        await expect
          .poll(() => {
            const file = readPersistedTabs(userDataDir);
            sourceThreadId = file.tabs.find(
              (tab) => tab.id === 'source-chat',
            )?.sdkSessionId;
            return sourceThreadId ?? null;
          })
          .toMatch(/^e2e-thread-/);

        await window.getByRole('button', { name: 'Fork Chat' }).click();

        if (scenario === 'cancelled-fork') {
          // Observe the pending fork before sending so the fixture's delayed
          // response cannot expire while we wait for the request to start.
          await expect
            .poll(() => clientRequests(fixture.logPath), { timeout: 30_000 })
            .toEqual(
              expect.arrayContaining([
                expect.objectContaining({ method: 'thread/fork' }),
              ]),
            );
          const composer = window.getByRole('textbox').first();
          await composer.fill('Continue only in the native fork.');
          await window.getByRole('button', { name: 'Send message' }).click();
          await expect(
            window.getByText('Continue only in the native fork.', {
              exact: true,
            }),
          ).toBeVisible();
        } else if (['immediate-continue', 'failed-fork'].includes(scenario)) {
          await sendAndExpectReply(window, 'Continue only in the native fork.');
        }

        await expect
          .poll(() => clientRequests(fixture.logPath), { timeout: 30_000 })
          .toEqual(
            expect.arrayContaining([
              expect.objectContaining({ method: 'thread/fork' }),
            ]),
          );
        if (scenario === 'cancelled-fork') {
          await window.getByTestId('chat-stop-generation').click();
          const forkRequest = clientRequests(fixture.logPath).find(
            (request) => request.method === 'thread/fork',
          );
          await expect
            .poll(
              () =>
                readFileSync(fixture.logPath, 'utf8')
                  .split('\n')
                  .filter(Boolean)
                  .map((line) => JSON.parse(line))
                  .some(
                    (event) =>
                      event.direction === 'server' &&
                      event.message?.id === forkRequest.id &&
                      event.message?.result?.thread,
                  ),
              { timeout: 15000 },
            )
            .toBe(true);
          // Give the resolved provider task a chance to dispatch erroneously.
          // 300ms only exposed a Stop lost before session creation on slow CI
          // runners; this window reproduces it deterministically.
          await window.waitForTimeout(2000);
          expect(chatTurnStarts(fixture.logPath)).toHaveLength(1);
          await sendAndExpectReply(
            window,
            'Continue after the cancelled request.',
          );
        }
        let forkedTab;
        await expect
          .poll(
            async () => {
              const snapshot = await window.evaluate(
                async ({ projectId, worktreeId }) =>
                  window.api.chat.getState({ projectId, worktreeId }),
                { projectId: WORKSPACE_ID, worktreeId: WORKTREE_ID },
              );
              forkedTab = snapshot.tabsFile.tabs.find(
                (tab) => tab.id !== 'source-chat',
              );
              return forkedTab?.sdkSessionId ?? null;
            },
            { timeout: 30_000 },
          )
          .toMatch(/^e2e-thread-/);
        expect(forkedTab.sdkSessionId).not.toBe(sourceThreadId);
        await expect(
          window.getByText(sourcePrompt, { exact: true }).last(),
        ).toBeVisible();
        await expect(
          window.getByText(FIXTURE_REPLY, { exact: true }).last(),
        ).toBeVisible();

        if (
          !['immediate-continue', 'failed-fork', 'cancelled-fork'].includes(
            scenario,
          )
        ) {
          await sendAndExpectReply(window, 'Continue only in the native fork.');
        }
        await expect
          .poll(() => chatTurnStarts(fixture.logPath).length, {
            timeout: 30_000,
          })
          .toBe(2);
        if (scenario !== 'failed-fork' && scenario !== 'cancelled-fork')
          await expect
            .poll(
              () =>
                clientRequests(fixture.logPath).some(
                  (request) =>
                    request.method === 'thread/resume' &&
                    request.params?.threadId === forkedTab.sdkSessionId,
                ),
              { timeout: 30_000 },
            )
            .toBe(true);
        const state = JSON.parse(readFileSync(fixture.statePath, 'utf8'));
        expect(
          JSON.stringify(state.threads[forkedTab.sdkSessionId].items),
        ).toContain(sourcePrompt);
        if (scenario === 'failed-fork') {
          const requests = clientRequests(fixture.logPath);
          const injectIndex = requests.findIndex(
            (request) =>
              request.method === 'thread/inject_items' &&
              request.params?.threadId === forkedTab.sdkSessionId,
          );
          const turnIndex = requests.findIndex(
            (request) =>
              request.method === 'turn/start' &&
              request.params?.threadId === forkedTab.sdkSessionId,
          );
          expect(injectIndex).toBeGreaterThanOrEqual(0);
          expect(injectIndex).toBeLessThan(turnIndex);
        }
      } finally {
        await closeFixtureApp(electronApp, userDataDir, fixture.runtimeDir);
      }
    });
  }

  test('an imported Codex transcript is injected before its first continued turn', async () => {
    test.setTimeout(120_000);
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-codex-import-continuity-'),
    );
    seedPreferences(userDataDir);
    const seed = seedDemoWorkspaces({
      userDataDir,
      apps: ['ts-pnpm-vite'],
    });
    const workspace = seed.workspaces.find(
      (candidate) => candidate.id === WORKSPACE_ID,
    );
    if (!workspace) throw new Error('Missing seeded project');
    const remotePath = path.join(userDataDir, 'import-remote.git');
    const remoteUrl = pathToFileURL(remotePath).href;
    execFileSync('git', ['init', '--bare', remotePath], { stdio: 'ignore' });
    execFileSync('git', ['remote', 'add', 'origin', remoteUrl], {
      cwd: workspace.repoPath,
      stdio: 'ignore',
    });
    execFileSync('git', ['push', '--all', 'origin'], {
      cwd: workspace.repoPath,
      stdio: 'ignore',
    });
    execFileSync('git', ['push', '--set-upstream', 'origin', WORKTREE_ID], {
      cwd: workspace.worktreePath,
      stdio: 'ignore',
    });
    seedWorktreeChat({
      userDataDir,
      workspaceId: WORKSPACE_ID,
      worktreeId: WORKTREE_ID,
      providerType: 'codex',
      activeTabId: 'import-source',
      tabs: [
        {
          id: 'import-source',
          title: 'Imported Codex source',
          providerType: 'codex',
          sdkSessionId: 'foreign-codex-thread',
          hasStartedSession: true,
          messages: priorMessages(),
        },
      ],
    });
    const fixture = createFixtureRuntime();
    const rolloutDir = path.join(
      fixture.canonicalHome,
      'sessions',
      '2026',
      '07',
      '20',
    );
    mkdirSync(rolloutDir, { recursive: true });
    writeFileSync(
      path.join(rolloutDir, 'rollout-foreign-codex-thread.jsonl'),
      `${JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: IMPORTED_ROLLOUT_CONTEXT }],
        },
      })}\n`,
      'utf8',
    );
    const cloud = await startSessionExportCloudMock();
    const { electronApp } = await launchCanopy({
      userDataDir,
      env: {
        ...fixture.env,
        CANOPY_E2E_CLOUD_BASE_URL: cloud.baseUrl,
      },
    });

    try {
      const window = await openChat(electronApp);
      await window.evaluate(
        async (apiKey) => window.api.saveCanopyCloudApiKey({ apiKey }),
        'csk_codex_import_continuity',
      );
      const exported = await window.evaluate(async () =>
        window.api.chat.exportSession({
          projectId: 'demo-ts-pnpm-vite',
          worktreeId: 'demo-main',
          chatId: 'import-source',
        }),
      );
      await window.evaluate(async (exportId) => {
        await window.api.chat.inspectSessionImport({
          exportId,
          workspaceId: 'demo-ts-pnpm-vite',
        });
      }, exported.exportId);
      const imported = await window.evaluate(
        async (exportId) =>
          window.api.chat.importSession({
            exportId,
            workspaceId: 'demo-ts-pnpm-vite',
          }),
        exported.exportId,
      );

      expect(imported.chatId).not.toBe('import-source');
      await expect
        .poll(
          () => {
            const file = readPersistedTabs(userDataDir, imported.worktreeId);
            const tab = file.tabs.find(
              (candidate) => candidate.id === imported.chatId,
            );
            return {
              activeTabId: file.activeTabId,
              seedId: tab?.codexReconstructionSeedId ?? null,
              sdkSessionId: tab?.sdkSessionId ?? null,
            };
          },
          { timeout: 30_000 },
        )
        .toMatchObject({
          activeTabId: imported.chatId,
          seedId: expect.any(String),
          sdkSessionId: null,
        });
      const app = new CanopyAppDriver(window);
      await app.selectWorktree(imported.worktreeId);
      await expect(
        window.getByText(PRIOR_CONTEXT, { exact: true }).last(),
      ).toBeVisible({ timeout: 30_000 });

      await sendAndExpectReply(window, 'Continue the imported Codex chat.');
      await expect
        .poll(() => clientRequests(fixture.logPath), { timeout: 30_000 })
        .toEqual(
          expect.arrayContaining([
            expect.objectContaining({ method: 'thread/inject_items' }),
          ]),
        );
      expectInjectedPriorContext(
        clientRequests(fixture.logPath),
        IMPORTED_ROLLOUT_CONTEXT,
      );
      expect(JSON.stringify(clientRequests(fixture.logPath))).toContain(
        IMPORTED_ROLLOUT_CONTEXT,
      );
    } finally {
      await closeFixtureApp(electronApp, userDataDir, fixture.runtimeDir);
      await cloud.close();
    }
  });

  test('deferred-tool enablement materializes and continues the same visible Codex turn', async () => {
    test.setTimeout(120_000);
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-codex-deferred-continuity-'),
    );
    seedPreferences(userDataDir);
    seedDeferredMcpServer(userDataDir);
    seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
    seedWorkspaceApprovals({
      userDataDir,
      workspaceId: WORKSPACE_ID,
      defaultMode: 'full-access',
    });
    seedWorktreeChat({
      userDataDir,
      workspaceId: WORKSPACE_ID,
      worktreeId: WORKTREE_ID,
      providerType: 'codex',
      activeTabId: 'deferred-chat',
      tabs: [
        {
          id: 'deferred-chat',
          title: 'Deferred Codex continuity',
          providerType: 'codex',
          messages: priorMessages(),
        },
      ],
    });
    const fixture = createFixtureRuntime({
      env: { CANOPY_E2E_CODEX_MODE: 'deferred' },
    });
    const { electronApp } = await launchCanopy({
      userDataDir,
      env: fixture.env,
    });

    try {
      const window = await openChat(electronApp);
      const prompt =
        'Find and enable the Deferred Reload Fixture, then continue.';
      await sendAndExpectReply(window, prompt);

      await expect(window.getByText(prompt, { exact: true })).toHaveCount(1);
      await expect(
        window.getByText(FIXTURE_REPLY, { exact: true }).last(),
      ).toBeVisible();
      await expect
        .poll(
          () => {
            const file = readPersistedTabs(userDataDir);
            return (
              file.tabs.find((tab) => tab.id === 'deferred-chat')
                ?.pluginSelections?.mcpServerRefs ?? []
            );
          },
          { timeout: 30_000 },
        )
        .toEqual([{ serverId: 'continuity-deferred', configId: 'default' }]);

      const requests = clientRequests(fixture.logPath);
      expect(
        requests.some((request) => request.method === 'turn/interrupt'),
      ).toBe(true);
      expect(
        requests.filter((request) => request.method === 'thread/start').length,
        JSON.stringify(requests, null, 2),
      ).toBeGreaterThanOrEqual(2);
      expect(
        requests.some((request) => request.method === 'thread/inject_items'),
      ).toBe(true);
      const toolResults = readProtocol(fixture.logPath).filter(
        (entry) => entry.direction === 'client-tool-result',
      );
      expect(JSON.stringify(toolResults)).toContain('request-search-');
      expect(JSON.stringify(toolResults)).toContain('request-load-');
    } finally {
      try {
        await test.info().attach('deferred-continuity-protocol', {
          body: JSON.stringify(readProtocol(fixture.logPath), null, 2),
          contentType: 'application/json',
        });
        await test.info().attach('deferred-continuity-chat-index', {
          body: JSON.stringify(readPersistedTabs(userDataDir), null, 2),
          contentType: 'application/json',
        });
      } catch (error) {
        process.stderr.write(
          `[deferred-continuity] diagnostics: ${String(error)}\n`,
        );
      } finally {
        await closeFixtureApp(electronApp, userDataDir, fixture.runtimeDir);
      }
    }
  });

  test('an exactly correlated MCP elicitation is accepted and the Codex turn completes', async () => {
    test.setTimeout(120_000);
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-codex-mcp-elicitation-'),
    );
    seedPreferences(userDataDir);
    seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
    seedWorkspaceApprovals({
      userDataDir,
      workspaceId: WORKSPACE_ID,
      defaultMode: 'full-access',
    });
    seedWorktreeChat({
      userDataDir,
      workspaceId: WORKSPACE_ID,
      worktreeId: WORKTREE_ID,
      providerType: 'codex',
      activeTabId: 'mcp-elicitation-chat',
      tabs: [
        {
          id: 'mcp-elicitation-chat',
          title: 'MCP elicitation',
          providerType: 'codex',
          messages: [],
        },
      ],
    });
    const fixture = createFixtureRuntime({
      env: { CANOPY_E2E_CODEX_MODE: 'mcp-elicitation' },
    });
    const { electronApp } = await launchCanopy({
      userDataDir,
      env: fixture.env,
    });

    try {
      const window = await openChat(electronApp);
      await sendAndExpectReply(
        window,
        'Exercise the correlated MCP elicitation path.',
      );

      await expect
        .poll(
          () =>
            readProtocol(fixture.logPath).find(
              (entry) =>
                entry.direction === 'client-mcp-elicitation-result' &&
                entry.message?.result?.action === 'accept',
            ) ?? null,
          { timeout: 30_000 },
        )
        .toMatchObject({
          message: {
            result: {
              action: 'accept',
              content: null,
            },
          },
        });

      // End-to-end render proof: the fixture's real `mcpToolCall`
      // start/completion sequence travels through
      // `projectCodexThreadItem()`, the normalized chat events, the shared
      // reducer, persistence, and finally the shared `chat-tool-call` card —
      // no second projection path is involved.
      // Completed intermediate tool calls use the existing collapsed
      // "Agent steps" presentation, so reveal the call before asserting its
      // card contents.
      const agentSteps = window.getByRole('button', {
        name: /^Agent steps: .*mcp/,
      });
      await expect(agentSteps).toBeVisible({ timeout: 30_000 });
      await agentSteps.click();
      await expect(agentSteps).toHaveAttribute('aria-expanded', 'true');

      const mcpCard = window.locator(
        '[data-testid="chat-tool-call"][data-tool-name="mcp__fixture-server__fixture_mutation"]',
      );
      await expect(mcpCard).toBeVisible({ timeout: 30_000 });
      await expect(mcpCard).toHaveAttribute('data-tool-status', 'success', {
        timeout: 30_000,
      });
      await expect(mcpCard).toContainText('Fixture Server');
      await expect(mcpCard).toContainText('Fixture Mutation');

      await mcpCard.getByRole('button').click();
      await expect(mcpCard.getByRole('button')).toHaveAttribute(
        'aria-expanded',
        'true',
      );
      await expect(mcpCard).toContainText('accept-me');
      await expect(mcpCard).toContainText('Result');
      await expect(mcpCard).toContainText('fixture mutation accepted');
    } finally {
      await closeFixtureApp(electronApp, userDataDir, fixture.runtimeDir);
    }
  });

  test('a Codex thread recorded under a gateway route rebuilds with sanitized history instead of resuming', async () => {
    test.setTimeout(180_000);
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-codex-route-family-'),
    );
    seedPreferences(userDataDir);
    seedGatewayModelCatalog(userDataDir);
    seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
    seedWorktreeChat({
      userDataDir,
      workspaceId: WORKSPACE_ID,
      worktreeId: WORKTREE_ID,
      providerType: 'codex',
      activeTabId: 'route-family-chat',
      tabs: [
        {
          id: 'route-family-chat',
          title: 'Route family switch',
          providerType: 'codex',
          model: DEEPSEEK_GATEWAY_MODEL.id,
          messages: [],
        },
      ],
    });
    const fixture = createFixtureRuntime({
      env: { CANOPY_E2E_CODEX_STRICT_REASONING: 'true' },
    });
    const { electronApp } = await launchCanopy({
      userDataDir,
      env: fixture.env,
    });

    try {
      const window = await openChat(electronApp);
      const saveResult = await window.evaluate(
        async (apiKey) => window.api.saveCanopyCloudApiKey({ apiKey }),
        ROUTE_FAMILY_CLOUD_API_KEY,
      );
      expect(saveResult.status.authenticated).toBe(true);
      await window.evaluate((eventName) => {
        window.dispatchEvent(new Event(eventName));
      }, CLOUD_ACCOUNT_CHANGED_EVENT);

      // 1. Establish the thread through the gateway-selected model. The fresh
      // catalog cache gives both renderer and main process the same DeepSeek
      // route; the fixture records a provider-private reasoning item just as a
      // real gateway response would.
      const picker = window
        .locator('[data-testid="chat-model-picker"]:visible')
        .first();
      await expect(picker).toContainText(DEEPSEEK_GATEWAY_MODEL.label);
      await sendAndExpectReply(
        window,
        'Start this chat on the gateway-routed model.',
      );
      let gatewayThreadId;
      await expect
        .poll(
          () => {
            const file = readPersistedTabs(userDataDir);
            gatewayThreadId = file.tabs.find(
              (tab) => tab.id === 'route-family-chat',
            )?.sdkSessionId;
            return gatewayThreadId ?? null;
          },
          { timeout: 30_000 },
        )
        .toMatch(/^e2e-thread-/);
      const originalLease = readCapabilityLease(userDataDir, gatewayThreadId);
      expect(
        originalLease,
        'expected a persisted Codex capability lease',
      ).not.toBeNull();
      expect(originalLease.reasoningRouteFamily).toBe('gateway:deepseek');

      // 2. Give that real gateway-created thread the exact provider-private
      // rollout payloads from the report. This is the persisted source the
      // reconstruction path must sanitize.
      writeRolloutForThread(fixture, gatewayThreadId, [
        assistantMessageItem(GATEWAY_ROLLOUT_CONTEXT),
        DEEPSEEK_REASONING_ITEM,
        OPENAI_ENCRYPTED_REASONING_ITEM,
      ]);
      writeFileSync(fixture.logPath, '', 'utf8');

      // 3. Exercise the user-facing seam: switch to native Sol through the
      // actual ModelPicker, then send. The next client is therefore created
      // from the renderer's persisted model choice and the main process's real
      // routing decision rather than a hand-edited lease.
      await picker.click();
      await selectModelOption(window, 'gpt-5.6-sol');
      await expect(picker).toContainText('GPT 5.6 Sol');
      // Sol is available through both routes. Selecting it while the prior
      // gateway-only model owns the picker keeps AI Credits selected, so make
      // the reported gateway -> native transition explicit through the same
      // user-facing picker before sending.
      const solBilling = await openModelBillingMenu(window, 'gpt-5.6-sol');
      await expect(solBilling.credits).toHaveAttribute('aria-checked', 'true');
      await solBilling.subscription.click();
      await expect(solBilling.subscription).toHaveAttribute(
        'aria-checked',
        'true',
      );
      await closeModelPicker(window);
      const secondPrompt = 'Continue now that the model is native again.';
      const composer = window.getByRole('textbox').first();
      await expect(composer).toBeVisible();
      await composer.fill(secondPrompt);
      await window.getByRole('button', { name: 'Send message' }).click();
      await expect(
        window.getByText(secondPrompt, { exact: true }).last(),
      ).toBeVisible({ timeout: 30_000 });
      await expect(
        window.getByText(FIXTURE_REPLY, { exact: true }),
      ).toHaveCount(2, { timeout: 60_000 });

      await expect
        .poll(() => clientRequests(fixture.logPath), { timeout: 30_000 })
        .toEqual(
          expect.arrayContaining([
            expect.objectContaining({ method: 'thread/inject_items' }),
          ]),
        );
      const requests = clientRequests(fixture.logPath);
      expect(
        requests.some(
          (request) =>
            request.method === 'thread/resume' &&
            request.params?.threadId === gatewayThreadId,
        ),
        JSON.stringify(requests.map((request) => request.method)),
      ).toBe(false);
      const injected = injectedItemsFor(requests);
      expect(JSON.stringify(injected)).toContain(GATEWAY_ROLLOUT_CONTEXT);
      expectNoForeignReasoning(injected);

      let rebuiltThreadId;
      await expect
        .poll(
          () => {
            const file = readPersistedTabs(userDataDir);
            rebuiltThreadId = file.tabs.find(
              (tab) => tab.id === 'route-family-chat',
            )?.sdkSessionId;
            // The chat keeps its old thread id until the rebuilt thread is
            // persisted, so wait for the swap rather than any thread id.
            return rebuiltThreadId && rebuiltThreadId !== gatewayThreadId
              ? rebuiltThreadId
              : null;
          },
          { timeout: 30_000 },
        )
        .toMatch(/^e2e-thread-/);
      // Guard against a false positive: had the capability snapshot drifted
      // between launches, the rebuild would prove nothing about route family.
      const rebuiltLease = readCapabilityLease(userDataDir, rebuiltThreadId);
      expect(rebuiltLease?.snapshotId).toBe(originalLease.snapshotId);
      expect(rebuiltLease?.reasoningRouteFamily).toBe('native');
    } finally {
      await closeFixtureApp(electronApp, userDataDir, fixture.runtimeDir);
    }
  });

  // The mirror of the test above, and the flow from the second report: a chat
  // that starts on a subscription-billed model and is then switched to a
  // gateway-only one. The routing decision is resolved once per session, so the
  // live session kept its native app-server and sent the raw `deepseek-v4-pro`
  // to it — which the real provider answers with "The 'deepseek-v4-pro' model is
  // not supported when using Codex with a ChatGPT account." Restarting the app
  // cleared it only because that rebuilt the session under the new model.
  test('a native Codex chat switched to a gateway-only model routes the next turn through AI Credits', async () => {
    test.setTimeout(180_000);
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-codex-native-to-gateway-'),
    );
    seedPreferences(userDataDir);
    seedGatewayModelCatalog(userDataDir);
    seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
    seedWorktreeChat({
      userDataDir,
      workspaceId: WORKSPACE_ID,
      worktreeId: WORKTREE_ID,
      providerType: 'codex',
      activeTabId: 'native-to-gateway-chat',
      tabs: [
        {
          id: 'native-to-gateway-chat',
          title: 'Native to gateway switch',
          providerType: 'codex',
          model: 'gpt-5.6-sol',
          messages: [],
        },
      ],
    });
    const fixture = createFixtureRuntime({
      env: { CANOPY_E2E_CODEX_STRICT_REASONING: 'true' },
    });
    const { electronApp } = await launchCanopy({
      userDataDir,
      env: fixture.env,
    });

    try {
      const window = await openChat(electronApp);
      const saveResult = await window.evaluate(
        async (apiKey) => window.api.saveCanopyCloudApiKey({ apiKey }),
        ROUTE_FAMILY_CLOUD_API_KEY,
      );
      expect(saveResult.status.authenticated).toBe(true);
      await window.evaluate((eventName) => {
        window.dispatchEvent(new Event(eventName));
      }, CLOUD_ACCOUNT_CHANGED_EVENT);

      // 1. Establish the chat natively. Sol is billable both ways, so assert the
      // starting framework rather than assuming it: the whole point of the test
      // is that turn one is a subscription turn.
      const picker = window
        .locator('[data-testid="chat-model-picker"]:visible')
        .first();
      await expect(picker).toContainText('GPT 5.6 Sol');
      const solBilling = await openModelBillingMenu(window, 'gpt-5.6-sol');
      await expect(solBilling.subscription).toHaveAttribute(
        'aria-checked',
        'true',
      );
      await closeModelPicker(window);
      await sendAndExpectReply(
        window,
        'Start this chat on the subscription-billed model.',
      );
      let nativeThreadId;
      await expect
        .poll(
          () => {
            const file = readPersistedTabs(userDataDir);
            nativeThreadId = file.tabs.find(
              (tab) => tab.id === 'native-to-gateway-chat',
            )?.sdkSessionId;
            return nativeThreadId ?? null;
          },
          { timeout: 30_000 },
        )
        .toMatch(/^e2e-thread-/);
      const originalLease = readCapabilityLease(userDataDir, nativeThreadId);
      expect(
        originalLease,
        'expected a persisted Codex capability lease',
      ).not.toBeNull();
      expect(originalLease.reasoningRouteFamily).toBe('native');

      // 2. Give the native thread OpenAI-private reasoning, so the rebuild also
      // has to prove it does not replay it through DeepSeek.
      writeRolloutForThread(fixture, nativeThreadId, [
        assistantMessageItem(PRIOR_CONTEXT),
        OPENAI_ENCRYPTED_REASONING_ITEM,
      ]);
      writeFileSync(fixture.logPath, '', 'utf8');

      // 3. Switch to the gateway-only model through the real picker. It has no
      // native route, so the billing control locks itself to AI Credits — the
      // renderer already knows the next turn cannot be a subscription turn.
      await picker.click();
      await selectModelOption(window, `${DEEPSEEK_GATEWAY_MODEL.id}`);
      await expect(picker).toContainText(DEEPSEEK_GATEWAY_MODEL.label);
      // Its row reads AI credits and offers no billing choice.
      await picker.click();
      await window.getByTestId('chat-model-harness-tab-all').click();
      await expect(
        window.locator(
          `[data-testid="chat-model-row-credits-${DEEPSEEK_GATEWAY_MODEL.id}"]:visible`,
        ),
      ).toHaveText('AI credits');
      // No row menu for it holds billing, whichever button opens it.
      await expect(
        window.locator(
          `[data-testid="chat-model-harness-control-${DEEPSEEK_GATEWAY_MODEL.id}"][data-billing-menu="true"], [data-testid="chat-model-billing-${DEEPSEEK_GATEWAY_MODEL.id}"]`,
        ),
      ).toHaveCount(0);
      await closeModelPicker(window);

      const secondPrompt = 'Continue now that the model is gateway-only.';
      const composer = window.getByRole('textbox').first();
      await expect(composer).toBeVisible();
      await composer.fill(secondPrompt);
      await window.getByRole('button', { name: 'Send message' }).click();
      await expect(
        window.getByText(secondPrompt, { exact: true }).last(),
      ).toBeVisible({ timeout: 30_000 });
      await expect(
        window.getByText(FIXTURE_REPLY, { exact: true }),
      ).toHaveCount(2, { timeout: 60_000 });

      await expect
        .poll(() => clientRequests(fixture.logPath), { timeout: 30_000 })
        .toEqual(
          expect.arrayContaining([
            expect.objectContaining({ method: 'thread/inject_items' }),
          ]),
        );
      const requests = clientRequests(fixture.logPath);
      const turnModels = requests
        .filter((request) => request.method === 'turn/start')
        .map((request) => request.params?.model);

      // The exact wire shape the provider rejected: the raw catalog id on a
      // session still authenticated for the ChatGPT subscription.
      expect(turnModels, JSON.stringify(turnModels)).not.toContain(
        DEEPSEEK_GATEWAY_MODEL.id,
      );
      expect(turnModels, JSON.stringify(turnModels)).toContain(
        DEEPSEEK_GATEWAY_MODEL.gatewayId,
      );

      // The native thread must not be resumed under the gateway route.
      expect(
        requests.some(
          (request) =>
            request.method === 'thread/resume' &&
            request.params?.threadId === nativeThreadId,
        ),
        JSON.stringify(requests.map((request) => request.method)),
      ).toBe(false);
      const injected = injectedItemsFor(requests);
      expect(JSON.stringify(injected)).toContain(PRIOR_CONTEXT);
      expectNoForeignReasoning(injected);

      let rebuiltThreadId;
      await expect
        .poll(
          () => {
            const file = readPersistedTabs(userDataDir);
            rebuiltThreadId = file.tabs.find(
              (tab) => tab.id === 'native-to-gateway-chat',
            )?.sdkSessionId;
            return rebuiltThreadId && rebuiltThreadId !== nativeThreadId
              ? rebuiltThreadId
              : null;
          },
          { timeout: 30_000 },
        )
        .toMatch(/^e2e-thread-/);
      // Same false-positive guard as the mirror test: an unchanged capability
      // snapshot means the rebuild can only be attributed to the route change.
      const rebuiltLease = readCapabilityLease(userDataDir, rebuiltThreadId);
      expect(rebuiltLease?.snapshotId).toBe(originalLease.snapshotId);
      expect(rebuiltLease?.reasoningRouteFamily).toBe('gateway:deepseek');
    } finally {
      await closeFixtureApp(electronApp, userDataDir, fixture.runtimeDir);
    }
  });

  test('an idle gateway-routed chat defers tool materialization without losing route provenance', async () => {
    // The live AI-Credits routing signal comes from a registered session, so it
    // is simply absent for an idle chat — restart the app, then edit tool
    // selections before sending anything. This walks exactly that flow through
    // the real Plugins dialog: no message is ever sent, so no session exists and
    // the picker must persist the desired snapshot without eagerly rebuilding
    // the provider thread.
    //
    // The existing gateway lease remains the route-provenance source for the
    // next real turn. Replacing it during the picker save would either perform
    // provider work in the picker UX or risk stamping the replacement `native`.
    test.setTimeout(180_000);
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-codex-idle-route-family-'),
    );
    seedPreferences(userDataDir);
    seedCustomSkill(userDataDir);
    seedGatewayModelCatalog(userDataDir);
    seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
    const idleThreadId = 'idle-gateway-thread';
    seedWorktreeChat({
      userDataDir,
      workspaceId: WORKSPACE_ID,
      worktreeId: WORKTREE_ID,
      providerType: 'codex',
      activeTabId: 'idle-gateway-chat',
      tabs: [
        {
          id: 'idle-gateway-chat',
          title: 'Idle gateway chat',
          providerType: 'codex',
          model: DEEPSEEK_GATEWAY_MODEL.id,
          sdkSessionId: idleThreadId,
          hasStartedSession: true,
          messages: priorMessages(),
        },
      ],
    });
    // The persisted provenance a previous, now-gone session left behind.
    writeCapabilityLease(userDataDir, idleThreadId, {
      reasoningRouteFamily: 'gateway:deepseek',
    });
    const fixture = createFixtureRuntime();
    writeRolloutForThread(fixture, idleThreadId, [
      assistantMessageItem(GATEWAY_ROLLOUT_CONTEXT),
      DEEPSEEK_REASONING_ITEM,
    ]);
    const { electronApp } = await launchCanopy({
      userDataDir,
      env: fixture.env,
    });

    try {
      const window = await openChat(electronApp);
      const saveResult = await window.evaluate(
        async (apiKey) => window.api.saveCanopyCloudApiKey({ apiKey }),
        ROUTE_FAMILY_CLOUD_API_KEY,
      );
      expect(saveResult.status.authenticated).toBe(true);
      await window.evaluate((eventName) => {
        window.dispatchEvent(new Event(eventName));
      }, CLOUD_ACCOUNT_CHANGED_EVENT);
      const picker = window
        .locator('[data-testid="chat-model-picker"]:visible')
        .first();
      await expect(picker).toContainText(DEEPSEEK_GATEWAY_MODEL.label);

      // Edit tool selections on the idle chat — the whole flow, no send.
      await window.getByTestId('chat-input-plus-button').click();
      await window.getByTestId('chat-plugins-button').click();
      const dialog = window
        .locator('[role="dialog"]')
        .filter({ hasText: 'Plugins' });
      await expect(dialog).toBeVisible();
      await dialog.getByPlaceholder('Search by name…').fill(SKILL_NAME);
      await dialog
        .getByRole('combobox', { name: 'Kind filter' })
        .selectOption('skill');
      const skill = dialog.getByRole('checkbox', {
        name: `Select ${SKILL_NAME}`,
      });
      await expect(skill).toBeVisible({ timeout: 30_000 });
      await skill.check();
      await dialog.getByRole('button', { name: 'Save' }).click();
      await expect(dialog).toHaveCount(0);

      await expect
        .poll(
          () => {
            const file = readPersistedTabs(userDataDir);
            const tab = file.tabs.find(
              (entry) => entry.id === 'idle-gateway-chat',
            );
            return {
              sdkSessionId: tab?.sdkSessionId,
              skillRefs: tab?.pluginSelections?.skillRefs ?? [],
            };
          },
          { timeout: 30_000 },
        )
        .toEqual({
          sdkSessionId: idleThreadId,
          skillRefs: [{ sourceId: 'custom:app', skillName: SKILL_NAME }],
        });

      // No provider thread is created from the picker. The source lease—and
      // therefore its gateway provenance—remains intact for the next turn.
      const persistedLease = readCapabilityLease(userDataDir, idleThreadId);
      expect(
        persistedLease?.reasoningRouteFamily,
        JSON.stringify(persistedLease),
      ).toBe('gateway:deepseek');
      expect(
        clientRequests(fixture.logPath).some(
          (request) => request.method === 'thread/start',
        ),
      ).toBe(false);
    } finally {
      await closeFixtureApp(electronApp, userDataDir, fixture.runtimeDir);
    }
  });

  test('a poisoned Codex thread self-heals on its next turn instead of failing forever', async () => {
    test.setTimeout(120_000);
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-codex-poisoned-reasoning-'),
    );
    seedPreferences(userDataDir);
    const seed = seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
    const workspace = seed.workspaces.find(
      (candidate) => candidate.id === WORKSPACE_ID,
    );
    if (!workspace) throw new Error('Missing seeded project');
    const poisonedThreadId = 'poisoned-gateway-thread';
    seedWorktreeChat({
      userDataDir,
      workspaceId: WORKSPACE_ID,
      worktreeId: WORKTREE_ID,
      providerType: 'codex',
      activeTabId: 'poisoned-chat',
      tabs: [
        {
          id: 'poisoned-chat',
          title: 'Poisoned gateway thread',
          providerType: 'codex',
          sdkSessionId: poisonedThreadId,
          hasStartedSession: true,
          messages: priorMessages(),
        },
      ],
    });
    const fixture = createFixtureRuntime({
      env: { CANOPY_E2E_CODEX_STRICT_REASONING: 'true' },
      state: {
        nextThread: 1,
        nextTurn: 1,
        threads: {
          [poisonedThreadId]: {
            id: poisonedThreadId,
            cwd: workspace.worktreePath,
            items: [DEEPSEEK_REASONING_ITEM],
            selectedCapabilityRoots: [],
            dynamicTools: [],
            config: {},
          },
        },
      },
    });
    writeRolloutForThread(fixture, poisonedThreadId, [
      assistantMessageItem(GATEWAY_ROLLOUT_CONTEXT),
      DEEPSEEK_REASONING_ITEM,
    ]);
    const { electronApp } = await launchCanopy({
      userDataDir,
      env: fixture.env,
    });

    try {
      const window = await openChat(electronApp);
      const prompt = 'Say hi again now that the model is native.';
      await sendAndExpectReply(window, prompt);

      // The rejected turn is retried transparently: the user sees one prompt,
      // one reply, and no error.
      await expect(window.getByText(prompt, { exact: true })).toHaveCount(1);
      await expect(
        window.getByText(PRIOR_CONTEXT, { exact: true }),
      ).toBeVisible();

      const failedTurns = readProtocol(fixture.logPath).filter(
        (entry) =>
          entry.direction === 'server' &&
          entry.message?.method === 'turn/completed' &&
          entry.message?.params?.turn?.status === 'failed',
      );
      expect(failedTurns).toHaveLength(1);
      expect(JSON.stringify(failedTurns[0])).toContain(
        'array_above_max_length',
      );

      const requests = clientRequests(fixture.logPath);
      expect(
        requests.some(
          (request) =>
            request.method === 'thread/resume' &&
            request.params?.threadId === poisonedThreadId,
        ),
      ).toBe(true);
      expect(
        requests.some((request) => request.method === 'thread/start'),
        JSON.stringify(requests.map((request) => request.method)),
      ).toBe(true);
      const injected = injectedItemsFor(requests);
      expect(JSON.stringify(injected)).toContain(GATEWAY_ROLLOUT_CONTEXT);
      expectNoForeignReasoning(injected);

      // The rejected turn's input is persisted before the failure (the fake
      // mirrors real Codex here), and the retry re-sends the same message. The
      // rebuilt thread must therefore see the prompt exactly once across the
      // injected history and the retried turn/start — never twice.
      const promptPattern = new RegExp(
        prompt.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
        'g',
      );
      // Count only what the REBUILT thread receives: everything from the
      // replacement thread/start onward. The original, rejected turn/start
      // legitimately carried the prompt too, so counting from the beginning
      // would always see two.
      const rebuildIndex = requests.findIndex(
        (request) => request.method === 'thread/start',
      );
      expect(rebuildIndex).toBeGreaterThanOrEqual(0);
      const promptOccurrences = requests
        .slice(rebuildIndex)
        .filter(
          (request) =>
            request.method === 'thread/inject_items' ||
            request.method === 'turn/start',
        )
        .reduce(
          (total, request) =>
            total +
            (
              JSON.stringify(
                request.params?.items ?? request.params?.input ?? [],
              ).match(promptPattern) ?? []
            ).length,
          0,
        );
      expect(promptOccurrences).toBe(1);

      await expect
        .poll(
          () =>
            readPersistedTabs(userDataDir).tabs.find(
              (tab) => tab.id === 'poisoned-chat',
            )?.sdkSessionId ?? null,
          { timeout: 30_000 },
        )
        .toMatch(/^e2e-thread-/);
    } finally {
      await closeFixtureApp(electronApp, userDataDir, fixture.runtimeDir);
    }
  });
});
