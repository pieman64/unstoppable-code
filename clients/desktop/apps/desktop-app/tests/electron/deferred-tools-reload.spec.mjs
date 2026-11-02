import { runSessionReuseFlow } from './seeders/sessionReuseFlow.mjs';
import { existsSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { openPipelineAssistant } from './pipelineAssistant.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { withBundledBinaryOverridesScrubbed } from './seeders/bundledBinaryOverrides.mjs';
import {
  DEFAULT_MOCK_BASE_URL,
  DEFERRED_ECHO_TOOL_NAME,
  registerScenario,
  seedDeferredEchoServer,
  seedWorkspaceApprovals,
  seedWorktreeChat,
  writeJson,
} from './seeders/index.mjs';
import { composerIdleAction } from './composerIdleAction.mjs';
import {
  readChatStorageIndexes,
  readChatStorageMessages,
} from './readChatStorage.mjs';

const WORKSPACE_ID = 'demo-ts-pnpm-vite';
const WORKTREE_ID = 'demo-main';
const WORKTREE_BRANCH = 'demo-main';
const CHAT_ID = 'deferred-tools-reload-chat';

const CONVERSATION_MARKER = 'Canopy-CDEFERREDRELOAD';
const MOCK_BASE_URL =
  process.env.CANOPY_E2E_MOCK_BASE_URL?.trim() || DEFAULT_MOCK_BASE_URL;
const SEARCH_TOOL_LABEL = /Search\s*Deferred\s*Tools|SearchDeferredTools/i;
const LOAD_TOOL_LABEL = /Load\s*Deferred\s*Tools|LoadDeferredTools/i;
const ECHO_RESULT = 'called: after reload';

function readFilesText(root) {
  if (!existsSync(root)) {
    return '';
  }
  const chunks = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      chunks.push(readFilesText(entryPath));
    } else if (entry.isFile()) {
      chunks.push(readFileSync(entryPath, 'utf8'));
    }
  }
  return chunks.join('\n');
}

function findFileNamed(root, fileName) {
  if (!existsSync(root)) {
    return null;
  }
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      const found = findFileNamed(entryPath, fileName);
      if (found) return found;
    } else if (entry.isFile() && entry.name === fileName) {
      return entryPath;
    }
  }
  return null;
}

function seedAppAdvisorPreferences(userDataDir) {
  writeJson(path.join(userDataDir, 'preferences.json'), {
    version: 1,
    preferences: {
      onboardingCompleted: ['v1'],
      appAdvisorModel: 'sonnet',
      appAdvisorThinkingLevel: 'off',
      defaultAppAdvisorInterfaceMode: 'canopy',
      appAdvisorPluginSelections: {
        collectionIds: [],
        skillRefs: [],
        pluginRefs: [],
        mcpServerRefs: [],
      },
    },
  });
}

/**
 * Observe the Claude process host from main: every CLI spawned for the chat's
 * session key, its pid once started, and whether the host reported its exit.
 * Install before the chat's first send; the host forks on the first spawn.
 */
async function installChatCliObserver(electronApp, sessionRoute) {
  await electronApp.evaluate(({ utilityProcess }, route) => {
    const originalFork = utilityProcess.fork;
    const clis = new Map();
    utilityProcess.fork = function (...args) {
      const child = originalFork.apply(this, args);
      if (args[2]?.serviceName !== 'claude-process-host') return child;
      child.on('message', (message) => {
        const payload = message?.data ?? message;
        const cli = clis.get(payload?.requestId);
        if (!cli) return;
        if (payload.type === 'started') cli.pid = payload.pid;
        if (payload.type === 'exit') cli.exited = true;
      });
      const originalPostMessage = child.postMessage;
      child.postMessage = function (message, ...rest) {
        if (
          message?.type === 'spawn' &&
          (message.args ?? []).some((arg) => String(arg).includes(route))
        ) {
          clis.set(message.requestId, { pid: null, exited: false });
        }
        return originalPostMessage.call(this, message, ...rest);
      };
      return child;
    };
    globalThis.__CANOPY_CHAT_CLIS__ = clis;
  }, sessionRoute);
}

async function readChatClis(electronApp) {
  return electronApp.evaluate(() =>
    Array.from(globalThis.__CANOPY_CHAT_CLIS__?.values() ?? [], (cli) => ({
      ...cli,
    })),
  );
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test.describe('deferred tools reload live turn', () => {
  test('gives the continuation after Search/Load its own turn, headed by a tools-loaded divider', async () => {
    test.setTimeout(240_000);
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-deferred-tools-reload-'),
    );

    seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
    seedWorkspaceApprovals({
      userDataDir,
      workspaceId: WORKSPACE_ID,
      defaultMode: 'full-access',
    });
    const { logPath } = seedDeferredEchoServer(userDataDir);
    seedWorktreeChat({
      userDataDir,
      workspaceId: WORKSPACE_ID,
      worktreeId: WORKTREE_ID,
      providerType: 'claude',
      tabs: [{ id: CHAT_ID, title: 'Deferred Tools Reload' }],
      activeTabId: CHAT_ID,
    });

    await registerScenario(MOCK_BASE_URL, CONVERSATION_MARKER, {
      llm: {
        steps: [
          {
            toolCalls: [
              {
                name: 'mcp__canopy__SearchDeferredTools',
                input: {
                  queries: [
                    {
                      text: 'Deferred Reload Fixture',
                      kinds: ['mcp'],
                      limit: 5,
                    },
                    {
                      text: 'definitely missing deferred resource',
                      kinds: ['skill', 'plugin', 'mcp'],
                      limit: 5,
                    },
                  ],
                },
              },
            ],
            stopReason: 'tool_use',
          },
          {
            toolCalls: [
              {
                name: 'mcp__canopy__LoadDeferredTools',
                loadDeferredToolsFromPreviousSearch: true,
                extraItems: [{ ref: 'deferred:missing-default' }],
              },
            ],
            stopReason: 'tool_use',
          },
          {
            text: 'This post-load response should be interrupted before it completes.',
            chunkChars: 1,
            streamMs: 120_000,
            stopReason: 'end_turn',
          },
        ],
        resumeSteps: [
          {
            toolCalls: [
              {
                name: DEFERRED_ECHO_TOOL_NAME,
                input: { message: 'after reload', delayMs: 2_000 },
              },
            ],
            stopReason: 'tool_use',
          },
          {
            text: 'Deferred echo completed.',
            stopReason: 'end_turn',
          },
        ],
      },
    });

    const { electronApp } = await withBundledBinaryOverridesScrubbed(() =>
      launchCanopy({
        userDataDir,
        env: {
          CANOPY_MOCK_LLM_BASE_URL: MOCK_BASE_URL,
          CANOPY_GITHUB_API_BASE_URL: MOCK_BASE_URL,
          CANOPY_LINEAR_API_BASE_URL: `${MOCK_BASE_URL}/graphql`,
        },
      }),
    );

    try {
      // CAN-4833: the interrupted CLI must exit, leaving only the resumed one.
      await installChatCliObserver(
        electronApp,
        encodeURIComponent(`${WORKSPACE_ID}/${WORKTREE_ID}/${CHAT_ID}`),
      );
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);

      await app.waitForShell({ timeout: 30_000 });
      await app.openMainPage();
      await app.selectWorktree(WORKTREE_BRANCH);

      const panel = window.getByTestId('panel-content-chat');
      await expect(panel).toBeVisible();

      const userMessage = `[${CONVERSATION_MARKER}] Search for the deferred reload fixture, load it, then use it to echo after reload.`;
      const composer = window.getByRole('textbox').first();
      await expect(composer).toBeVisible();
      await composer.click();
      await composer.fill(userMessage);
      await window.getByRole('button', { name: 'Send message' }).click();

      await expect(panel.getByText(userMessage).first()).toBeVisible({
        timeout: 30_000,
      });
      await expect(panel.getByText(userMessage, { exact: true })).toHaveCount(
        1,
      );

      const hiddenContinuation =
        '<system_instruction>Requested items now enabled, continue the interrupted request.</system_instruction>';
      const liveTimer = panel.locator(
        '[data-testid="turn-timer"][data-state="live"]',
      );
      await expect(liveTimer).toHaveCount(1, { timeout: 90_000 });
      await expect(panel.getByText(userMessage, { exact: true })).toHaveCount(
        1,
      );
      await expect(panel.getByText('system_instruction')).toHaveCount(0);

      await expect(panel.getByText(SEARCH_TOOL_LABEL).first()).toBeVisible({
        timeout: 30_000,
      });
      const loadToolCard = panel
        .getByRole('button', { name: LOAD_TOOL_LABEL })
        .first();
      await expect(loadToolCard).toBeVisible({ timeout: 30_000 });
      await loadToolCard.click();
      await expect(liveTimer).toHaveCount(1);

      await expect
        .poll(
          () => (existsSync(logPath) ? readFileSync(logPath, 'utf8') : ''),
          { timeout: 90_000 },
        )
        .toContain(ECHO_RESULT);
      await expect(
        panel.getByText('Deferred echo completed.', { exact: true }).first(),
      ).toBeVisible({ timeout: 90_000 });
      await expect(liveTimer).toHaveCount(0, { timeout: 30_000 });
      await expect
        .poll(
          () =>
            (existsSync(logPath) ? readFileSync(logPath, 'utf8') : '')
              .trim()
              .split('\n')
              .filter(Boolean),
          { timeout: 30_000 },
        )
        .toEqual([ECHO_RESULT]);
      await expect(panel.getByText(userMessage, { exact: true })).toHaveCount(
        1,
      );
      // The reload continuation is a second execution with its own turn: the
      // prompt's turn closes at its own timer, and a divider heads the next.
      await expect(panel.locator('[data-testid="turn-timer"]')).toHaveCount(2);
      const boundary = panel.getByTestId('wake-turn-boundary');
      await expect(boundary).toHaveCount(1);
      await expect(boundary).toContainText('Continued after loading tools');
      const order = await panel.evaluate((root) =>
        Array.from(
          root.querySelectorAll(
            '[data-testid="turn-timer"], [data-testid="wake-turn-boundary"]',
          ),
        ).map((element) =>
          element.getAttribute('data-testid') === 'turn-timer'
            ? 'timer'
            : 'wake',
        ),
      );
      expect(order).toEqual(['timer', 'wake', 'timer']);
      // The reload ended the first execution; no one cancelled it.
      await expect(panel.getByText(/Cancelled/)).toHaveCount(0);
      await expect(panel.getByText('system_instruction')).toHaveCount(0);
      const timerBlocks = readChatStorageMessages(
        path.join(userDataDir, 'workspaces', WORKSPACE_ID),
        WORKTREE_ID,
        CHAT_ID,
      )
        .flatMap((message) => message.blocks ?? [])
        .filter((block) => block.type === 'turn_timer');
      expect(timerBlocks.map((block) => block.spawnedBy)).toEqual([
        undefined,
        { toolUseId: expect.any(String), toolsLoaded: true },
      ]);
      // "Show where it started" opens the prompt's turn, which holds the load
      // call: the worktree MCP route names that call by its request id, not
      // the transcript's tool_use id.
      const showStart = boundary.getByTestId(
        'wake-turn-boundary-show-spawning-turn',
      );
      await expect(showStart).toHaveAccessibleName('Show where it started');
      await showStart.hover();
      await expect(window.getByRole('tooltip')).toHaveText(
        'Show where it started',
      );
      await showStart.click();
      await expect(
        panel.getByText(userMessage, { exact: true }),
      ).toBeInViewport({ timeout: 10_000 });

      const observabilityRoot = path.join(userDataDir, 'agent-observability');
      await expect
        .poll(() => readFilesText(observabilityRoot), { timeout: 30_000 })
        .toContain('deferred_tools_reload_continuation');
      await expect
        .poll(() => readFilesText(observabilityRoot), { timeout: 30_000 })
        .toContain('<system_instruction>');
      await expect
        .poll(() => readFilesText(observabilityRoot), { timeout: 30_000 })
        .toContain(
          'Requested items now enabled, continue the interrupted request.',
        );
      await expect(panel.getByText(hiddenContinuation)).toHaveCount(0);

      // The reload ended the first CLI and the continuation runs on a second;
      // only that one is still running, and the host saw the first one exit.
      await expect
        .poll(
          async () => {
            const clis = await readChatClis(electronApp);
            return {
              spawned: clis.length,
              running: clis.filter(
                (cli) => !cli.exited && cli.pid && isProcessAlive(cli.pid),
              ).length,
              exitedButAlive: clis.filter(
                (cli) => cli.exited && cli.pid && isProcessAlive(cli.pid),
              ).length,
            };
          },
          { timeout: 30_000 },
        )
        .toEqual({ spawned: 2, running: 1, exitedButAlive: 0 });
      // The continuation turn completed; nothing recorded the chat as
      // interrupted, so no later turn can abandon it.
      const { live, archive } = readChatStorageIndexes(
        path.join(userDataDir, 'workspaces', WORKSPACE_ID),
        WORKTREE_ID,
      );
      const tab = [...live.tabs, ...(archive.tabs ?? [])].find(
        (candidate) => candidate.id === CHAT_ID,
      );
      expect(tab).toBeDefined();
      expect(tab?.interruptedTurns).toBeUndefined();
      expect(live.runtimeByChatId[CHAT_ID]?.status).toBe('completed');
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  // A fork's first send forks the source Claude session once, anchored at the
  // last kept chain entry. When that first turn loads a deferred MCP server,
  // the resumed continuation must keep the fork's own session; replaying the
  // one-shot fork options forked the source again at the anchor and silently
  // dropped the fork's first request from the model's context.
  test('keeps a forked chat first turn in its Claude session across a deferred reload', async ({}, testInfo) => {
    test.setTimeout(240_000);
    const conversationMarker = 'Canopy-CFORKDEFERREDRELOAD';
    const sourceChatId = 'deferred-reload-fork-source';
    const forkRequestText =
      'fork-first-turn request: search for the deferred reload fixture, load it, then echo after reload.';
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-fork-deferred-tools-reload-'),
    );

    seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
    seedWorkspaceApprovals({
      userDataDir,
      workspaceId: WORKSPACE_ID,
      defaultMode: 'full-access',
    });
    const { logPath } = seedDeferredEchoServer(userDataDir);
    seedWorktreeChat({
      userDataDir,
      workspaceId: WORKSPACE_ID,
      worktreeId: WORKTREE_ID,
      providerType: 'claude',
      tabs: [{ id: sourceChatId, title: 'Fork Source' }],
      activeTabId: sourceChatId,
    });

    // Steps are indexed by assistant turns already in the request, so the
    // source turn takes step 0 and the fork's first turn continues from step 1.
    await registerScenario(MOCK_BASE_URL, conversationMarker, {
      llm: {
        steps: [
          { text: 'Source turn complete.', stopReason: 'end_turn' },
          {
            toolCalls: [
              {
                name: 'mcp__canopy__SearchDeferredTools',
                input: {
                  queries: [
                    {
                      text: 'Deferred Reload Fixture',
                      kinds: ['mcp'],
                      limit: 5,
                    },
                  ],
                },
              },
            ],
            stopReason: 'tool_use',
          },
          {
            toolCalls: [
              {
                name: 'mcp__canopy__LoadDeferredTools',
                loadDeferredToolsFromPreviousSearch: true,
              },
            ],
            stopReason: 'tool_use',
          },
          {
            text: 'This fork response should be interrupted before it completes.',
            chunkChars: 1,
            streamMs: 120_000,
            stopReason: 'end_turn',
          },
        ],
        resumeSteps: [
          {
            toolCalls: [
              {
                name: DEFERRED_ECHO_TOOL_NAME,
                input: { message: 'after reload', delayMs: 2_000 },
              },
            ],
            stopReason: 'tool_use',
          },
          {
            text: 'Fork deferred echo completed.',
            stopReason: 'end_turn',
          },
        ],
      },
    });

    const { electronApp } = await withBundledBinaryOverridesScrubbed(() =>
      launchCanopy({
        userDataDir,
        env: {
          CANOPY_MOCK_LLM_BASE_URL: MOCK_BASE_URL,
          CANOPY_GITHUB_API_BASE_URL: MOCK_BASE_URL,
          CANOPY_LINEAR_API_BASE_URL: `${MOCK_BASE_URL}/graphql`,
        },
      }),
    );

    let failed = false;
    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell({ timeout: 30_000 });
      await app.openMainPage();
      await app.selectWorktree(WORKTREE_BRANCH);

      const panel = window.getByTestId('panel-content-chat');
      await expect(panel).toBeVisible();
      const readTabs = () =>
        window.evaluate(
          async ({ projectId, worktreeId }) => {
            const loaded = await window.api.chat.loadTabs({
              projectId,
              worktreeId,
            });
            return loaded.tabs.map((tab) => ({
              id: tab.id,
              sdkSessionId: tab.sdkSessionId,
              claudeForkSessionOnNextSend: tab.claudeForkSessionOnNextSend,
              resumePointRequired: tab.forkedFrom?.resumePointRequired,
            }));
          },
          { projectId: WORKSPACE_ID, worktreeId: WORKTREE_ID },
        );

      const sourceMessage = `[${conversationMarker}] Start the source conversation.`;
      const composer = panel.getByRole('textbox').first();
      await composer.click();
      await composer.fill(sourceMessage);
      await panel.getByRole('button', { name: 'Send message' }).click();
      await expect(
        panel.getByText('Source turn complete.', { exact: true }).first(),
      ).toBeVisible({ timeout: 60_000 });
      await expect(
        panel.locator('[data-testid="turn-timer"][data-state="live"]'),
      ).toHaveCount(0, { timeout: 30_000 });
      await expect
        .poll(
          async () =>
            (await readTabs()).find((tab) => tab.id === sourceChatId)
              ?.sdkSessionId,
          { timeout: 30_000 },
        )
        .toBeTruthy();
      const sourceSessionId = (await readTabs()).find(
        (tab) => tab.id === sourceChatId,
      )?.sdkSessionId;

      const forkButton = panel.getByTestId('fork-chat-button').last();
      await expect(forkButton).toBeVisible({ timeout: 30_000 });
      await forkButton.click();
      await expect(
        window.locator('[role="tab"][data-panel-kind="chat"]'),
      ).toHaveCount(2);
      // An anchored fork: its first send forks the source session once.
      await expect
        .poll(
          async () => (await readTabs()).find((tab) => tab.id !== sourceChatId),
          { timeout: 30_000 },
        )
        .toMatchObject({
          sdkSessionId: sourceSessionId,
          claudeForkSessionOnNextSend: true,
          resumePointRequired: true,
        });
      const forkChatId = (await readTabs()).find(
        (tab) => tab.id !== sourceChatId,
      )?.id;

      const forkMessage = `[${conversationMarker}] ${forkRequestText}`;
      const forkComposer = panel.getByRole('textbox').first();
      await forkComposer.click();
      await forkComposer.fill(forkMessage);
      await panel.getByRole('button', { name: 'Send message' }).click();

      await expect(
        panel.getByRole('button', { name: LOAD_TOOL_LABEL }).first(),
      ).toBeVisible({ timeout: 60_000 });
      await expect
        .poll(
          () => (existsSync(logPath) ? readFileSync(logPath, 'utf8') : ''),
          { timeout: 90_000 },
        )
        .toContain(ECHO_RESULT);
      await expect(
        panel
          .getByText('Fork deferred echo completed.', { exact: true })
          .first(),
      ).toBeVisible({ timeout: 90_000 });
      await expect(panel.getByText(forkMessage, { exact: true })).toHaveCount(
        1,
      );

      // The session the fork now resumes must still hold its first request.
      await expect
        .poll(
          async () => {
            const fork = (await readTabs()).find(
              (tab) => tab.id === forkChatId,
            );
            return {
              forked:
                typeof fork?.sdkSessionId === 'string' &&
                fork.sdkSessionId !== sourceSessionId,
              markerCleared: fork?.claudeForkSessionOnNextSend === undefined,
            };
          },
          { timeout: 30_000 },
        )
        .toEqual({ forked: true, markerCleared: true });
      const forkSessionId = (await readTabs()).find(
        (tab) => tab.id === forkChatId,
      )?.sdkSessionId;
      const claudeProjectsDir = path.join(
        userDataDir,
        'provider-state',
        'claude',
        'projects',
      );
      const forkSessionFile = findFileNamed(
        claudeProjectsDir,
        `${forkSessionId}.jsonl`,
      );
      expect(forkSessionFile).not.toBeNull();
      expect(readFileSync(forkSessionFile, 'utf8')).toContain(forkRequestText);
      const sourceSessionFile = findFileNamed(
        claudeProjectsDir,
        `${sourceSessionId}.jsonl`,
      );
      expect(sourceSessionFile).not.toBeNull();
      expect(readFileSync(sourceSessionFile, 'utf8')).not.toContain(
        forkRequestText,
      );
    } catch (error) {
      failed = true;
      await testInfo.attach('fork-deferred-reload-user-data', {
        body: Buffer.from(userDataDir),
        contentType: 'text/plain',
      });
      throw error;
    } finally {
      await closeCanopy(electronApp, userDataDir, { keepUserData: failed });
    }
  });

  for (const surface of ['App Advisor', 'Pipeline Assistant']) {
    test(`auto-resumes a ${surface} turn after loading a deferred MCP server`, async ({}, testInfo) => {
      const isPipeline = surface === 'Pipeline Assistant';
      const conversationMarker = isPipeline
        ? 'Canopy-CPIPELINEDEFERREDRELOAD'
        : 'Canopy-CAPPADVISORDEFERREDRELOAD';
      const toolNamespace = isPipeline
        ? 'canopy_pipeline_editor'
        : 'canopy_app_advisor';
      test.setTimeout(240_000);
      const userDataDir = mkdtempSync(
        path.join(os.tmpdir(), 'canopy-app-advisor-deferred-tools-reload-'),
      );

      seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
      seedAppAdvisorPreferences(userDataDir);
      seedWorkspaceApprovals({
        userDataDir,
        workspaceId: isPipeline ? 'pipeline-editor' : 'app-advisor',
        defaultMode: 'full-access',
      });
      const { logPath } = seedDeferredEchoServer(userDataDir);

      await registerScenario(MOCK_BASE_URL, conversationMarker, {
        llm: {
          steps: [
            {
              toolCalls: [
                {
                  name: `mcp__${toolNamespace}__SearchDeferredTools`,
                  input: {
                    queries: [
                      {
                        text: 'Deferred Reload Fixture',
                        kinds: ['mcp'],
                        limit: 5,
                      },
                    ],
                  },
                },
              ],
              stopReason: 'tool_use',
            },
            {
              toolCalls: [
                {
                  name: `mcp__${toolNamespace}__LoadDeferredTools`,
                  loadDeferredToolsFromPreviousSearch: true,
                },
              ],
              stopReason: 'tool_use',
            },
            {
              text: 'This App Advisor response should be interrupted before it completes.',
              chunkChars: 1,
              streamMs: 120_000,
              stopReason: 'end_turn',
            },
          ],
          resumeSteps: [
            {
              toolCalls: [
                {
                  name: DEFERRED_ECHO_TOOL_NAME,
                  input: { message: 'after reload', delayMs: 2_000 },
                },
              ],
              stopReason: 'tool_use',
            },
            {
              text: 'App Advisor deferred echo completed.',
              stopReason: 'end_turn',
            },
          ],
        },
      });

      const { electronApp } = await withBundledBinaryOverridesScrubbed(() =>
        launchCanopy({
          userDataDir,
          env: {
            CANOPY_MOCK_LLM_BASE_URL: MOCK_BASE_URL,
            CANOPY_GITHUB_API_BASE_URL: MOCK_BASE_URL,
            CANOPY_LINEAR_API_BASE_URL: `${MOCK_BASE_URL}/graphql`,
          },
        }),
      );

      let failed = false;
      try {
        const window = await electronApp.firstWindow();
        const app = new CanopyAppDriver(window);
        await app.waitForShell({ timeout: 30_000 });
        const advisor = isPipeline
          ? window
          : await app.openAppAdvisorWindow(electronApp);
        const transcript = isPipeline
          ? await openPipelineAssistant(app)
          : advisor.getByTestId('app-advisor-workspace-surface');
        await expect(transcript).toBeVisible();

        const userMessage = `[${conversationMarker}] Search for the deferred reload fixture, load it, then use it to echo after reload.`;
        const composer = transcript.getByRole('textbox').first();
        await expect(composer).toBeVisible();
        await composer.click();
        await composer.fill(userMessage);
        await expect(composer).toHaveText(userMessage);
        await transcript.getByRole('button', { name: 'Send message' }).click();

        await expect(transcript.getByText(userMessage).first()).toBeVisible({
          timeout: 30_000,
        });
        await expect(
          transcript.getByText(userMessage, { exact: true }),
        ).toHaveCount(1);
        await expect(
          transcript.getByText(SEARCH_TOOL_LABEL).first(),
        ).toBeVisible({
          timeout: 45_000,
        });
        await expect(
          transcript.getByRole('button', { name: LOAD_TOOL_LABEL }).first(),
        ).toBeVisible({ timeout: 45_000 });

        await expect
          .poll(
            () => (existsSync(logPath) ? readFileSync(logPath, 'utf8') : ''),
            { timeout: 90_000 },
          )
          .toContain(ECHO_RESULT);
        await expect(
          transcript
            .getByText('App Advisor deferred echo completed.', { exact: true })
            .first(),
        ).toBeVisible({ timeout: 90_000 });
        await expect(
          transcript.getByText(userMessage, { exact: true }),
        ).toHaveCount(1);
        await expect(transcript.getByText('system_instruction')).toHaveCount(0);
        await expect(composerIdleAction(advisor)).toBeVisible({
          timeout: 30_000,
        });
      } catch (error) {
        failed = true;
        await testInfo.attach('deferred-reload-user-data', {
          body: Buffer.from(userDataDir),
          contentType: 'text/plain',
        });
        throw error;
      } finally {
        await closeCanopy(electronApp, userDataDir, { keepUserData: failed });
      }
    });
  }
});

for (const providerType of ['claude', 'codex']) {
  test(`CAN-2835 worktree ${providerType} preserves consecutive responses and restart`, async () => {
    test.setTimeout(240_000);
    await runSessionReuseFlow({ surface: 'worktree', providerType });
  });
}
