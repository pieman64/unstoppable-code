// Watcher authorization for chats with selected capabilities.
//
// Regression: with organization projects enabled, a chat with a local custom
// skill and a built-in plugin selected ran a stored pipeline through
// DispatchAction `pipeline.run` with an inline watcher. The watcher reported
// `created`, the run finished, and delivery was denied with "Resource
// ownership could not be verified", so the chat waited forever. Two defects
// combined: agent-dispatched runs recorded no stored-pipeline locator, and
// arming authorized less than delivery did.
//
// Both flows run a live Claude turn against the mock LLM, so every tool call
// executes through the real in-app MCP proxy and watcher service:
//   1. pipeline.run with an inline watcher is delivered back into the chat,
//      and the mock answers the watcher turn.
//   2. A watcher whose destination selects a skill that is no longer installed
//      is rejected when it is armed, so the agent learns immediately instead of
//      waiting for a delivery that can never happen.
//   3. ScheduleWakeup from a chat in an organization-owned workspace is armed
//      with that organization's binding. It used to be authorized as Personal
//      and refused with a context mismatch whatever context was selected.

import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import {
  cleanupDemoWorkspaces,
  seedDemoWorkspaces,
} from './demoWorkspaces.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { withBundledBinaryOverridesScrubbed } from './seeders/bundledBinaryOverrides.mjs';
import {
  connectMockCloudAccount,
  DEFAULT_MOCK_BASE_URL,
  markWorkspaceOrganizationOwned,
  ORG_CONTEXT_A,
  ORG_CONTEXT_ENV,
  ORG_CONTEXT_ORGANIZATIONS,
  registerScenario,
  seedStoredPipeline,
  seedWorkspaceApprovals,
  seedWorktreeChat,
} from './seeders/index.mjs';
import { selectWorkspaceContext } from './workspaceContextMenu.mjs';

const WORKSPACE_ID = 'demo-ts-pnpm-vite';
const WORKTREE_ID = 'demo-main';
const CHAT_ID = 'watcher-capabilities';
const INSTALLED_SKILL = 'e2e-watcher-skill';
const PIPELINE_ID = 'watcher-capability-check';

function seedCustomSkill(userDataDir, name) {
  const source = path.join(userDataDir, 'skills', 'custom:app');
  mkdirSync(path.join(source, name), { recursive: true });
  writeFileSync(
    path.join(source, 'source.json'),
    JSON.stringify({ type: 'custom', sourceId: 'custom:app', url: '' }),
  );
  writeFileSync(
    path.join(source, name, 'SKILL.md'),
    `---\nname: ${name}\ndescription: Watcher authorization fixture\n---\nFollow the task.\n`,
  );
}

function seedCapabilityChat(userDataDir, skillName) {
  seedWorkspaceApprovals({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    defaultMode: 'full-access',
  });
  seedCustomSkill(userDataDir, INSTALLED_SKILL);
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    providerType: 'claude',
    activeTabId: CHAT_ID,
    tabs: [
      {
        id: CHAT_ID,
        title: 'Watcher capabilities',
        ...(skillName
          ? {
              pluginSelections: {
                collectionIds: [],
                skillRefs: [{ sourceId: 'custom:app', skillName }],
                pluginRefs: [
                  {
                    marketplaceId: 'builtin/app',
                    pluginName: 'builtin-security',
                  },
                ],
              },
            }
          : {}),
      },
    ],
  });
}

function readWatchers(userDataDir) {
  try {
    const file = JSON.parse(
      readFileSync(path.join(userDataDir, 'app-advisor-watchers.json'), 'utf8'),
    );
    return file.watchers.filter(
      (watcher) => watcher.destination?.chatId === CHAT_ID,
    );
  } catch {
    return [];
  }
}

/** Read a tool result from the canonical transcript, once the turn is committed. */
function readToolResult(userDataDir, toolName) {
  let raw;
  try {
    raw = readFileSync(
      path.join(
        userDataDir,
        'workspaces',
        WORKSPACE_ID,
        'chat-storage-v2',
        WORKTREE_ID,
        'transcripts',
        `${CHAT_ID}.jsonl`,
      ),
      'utf8',
    );
  } catch {
    return undefined;
  }
  const blocks = raw
    .trim()
    .split('\n')
    .flatMap((line) => JSON.parse(line).blocks ?? []);
  const call = blocks.find(
    (block) =>
      block.type === 'tool_use' && String(block.toolName).includes(toolName),
  );
  return blocks.find(
    (block) =>
      block.type === 'tool_result' && block.toolUseId === call?.toolUseId,
  );
}

async function attachDiagnostics(testInfo, userDataDir) {
  const storage = path.join(
    'workspaces',
    WORKSPACE_ID,
    'chat-storage-v2',
    WORKTREE_ID,
    'transcripts',
  );
  let transcripts = [];
  try {
    transcripts = readdirSync(path.join(userDataDir, storage))
      .filter((file) => file.endsWith('.jsonl'))
      .map((file) => path.join(storage, file));
  } catch {
    /* A turn that never started leaves no transcript. */
  }
  for (const relative of [
    'app-advisor-watchers.json',
    'logs/main.log',
    ...transcripts,
  ]) {
    try {
      await testInfo.attach(relative.replaceAll('/', '-'), {
        body: readFileSync(path.join(userDataDir, relative)),
        contentType: 'text/plain',
      });
    } catch {
      /* Missing diagnostics do not replace the assertion. */
    }
  }
}

async function sendMessage(window, text) {
  const panel = window.getByTestId('panel-content-chat');
  await expect(panel).toBeVisible();
  const composer = panel.getByRole('textbox').last();
  await composer.click();
  await composer.fill(text);
  await composer.press('Enter');
  await expect(panel.getByText(text).first()).toBeVisible({ timeout: 30_000 });
  return panel;
}

test('an inline pipeline watcher is delivered to a chat with a custom skill and built-in plugin', async ({}, testInfo) => {
  test.setTimeout(240_000);
  const marker = 'Canopy-CWATCHERCAPDELIVER';
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-watcher-capability-delivery-'),
  );
  const demo = seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedCapabilityChat(userDataDir, INSTALLED_SKILL);
  seedStoredPipeline({
    userDataDir,
    id: PIPELINE_ID,
    name: 'Watcher capability check',
    yaml: `name: Watcher capability check
on: dispatch
plugin_collections:
  - id: security
    name: Security
    defaults:
      - type: plugin
        marketplace:
          type: builtin
          id: app
        plugin_name: builtin-security
        required: true
jobs:
  check:
    steps:
      - run: echo checked
`,
  });
  await registerScenario(DEFAULT_MOCK_BASE_URL, marker, {
    llm: {
      steps: [
        {
          toolCalls: [
            {
              name: 'mcp__canopy__DispatchAction',
              input: {
                action: {
                  type: 'pipeline.run',
                  pipelineId: PIPELINE_ID,
                  watchers: [{ followUpInstruction: `[${marker}] Report it.` }],
                },
              },
            },
          ],
          stopReason: 'tool_use',
        },
        { text: 'Pipeline started with a watcher', stopReason: 'end_turn' },
        { text: 'Watcher delivered and reviewed', stopReason: 'end_turn' },
      ],
    },
  });
  let electronApp;
  try {
    ({ electronApp } = await withBundledBinaryOverridesScrubbed(() =>
      launchCanopy({ userDataDir, env: ORG_CONTEXT_ENV }),
    ));
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_ID);
    const panel = await sendMessage(
      window,
      `[${marker}] Run the check and tell me when it finishes.`,
    );
    await expect(
      panel.getByText('Pipeline started with a watcher').first(),
    ).toBeVisible({ timeout: 90_000 });
    await expect
      .poll(() => readWatchers(userDataDir).map((watcher) => watcher.trigger))
      .toContain('worktree_pipeline_completion');
    await expect(panel.getByTestId('watcher-fired-title')).toHaveCount(1, {
      timeout: 60_000,
    });
    await expect(
      panel.getByText('Watcher delivered and reviewed').first(),
    ).toBeVisible({ timeout: 90_000 });
    const [watcher] = readWatchers(userDataDir);
    expect(watcher).toMatchObject({ status: 'fired' });
    expect(watcher.deliveryError).toBeUndefined();
    await expect(
      window.getByText(/Couldn't confirm where something this uses came from/),
    ).toHaveCount(0);
  } catch (error) {
    await attachDiagnostics(testInfo, userDataDir);
    throw error;
  } finally {
    if (electronApp) await closeCanopy(electronApp, userDataDir);
    cleanupDemoWorkspaces(demo);
  }
});

test('a watcher that could never be delivered is rejected when the agent arms it', async ({}, testInfo) => {
  test.setTimeout(180_000);
  const marker = 'Canopy-CWATCHERCAPARM';
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-watcher-capability-arm-'),
  );
  const demo = seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedCapabilityChat(userDataDir, 'e2e-removed-skill');
  await registerScenario(DEFAULT_MOCK_BASE_URL, marker, {
    llm: {
      steps: [
        {
          toolCalls: [
            {
              name: 'mcp__canopy__ScheduleWakeup',
              input: { delaySeconds: 600 },
            },
          ],
          stopReason: 'tool_use',
        },
        { text: 'The wakeup could not be armed', stopReason: 'end_turn' },
      ],
    },
  });
  let electronApp;
  try {
    ({ electronApp } = await withBundledBinaryOverridesScrubbed(() =>
      launchCanopy({ userDataDir, env: ORG_CONTEXT_ENV }),
    ));
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_ID);
    const panel = await sendMessage(
      window,
      `[${marker}] Check back in ten minutes.`,
    );
    await expect(
      panel.getByText('The wakeup could not be armed').first(),
    ).toBeVisible({ timeout: 90_000 });
    // Turn blocks are committed when the turn settles, after the reply streams.
    await expect
      .poll(() => readToolResult(userDataDir, 'ScheduleWakeup') ?? null, {
        timeout: 30_000,
      })
      .not.toBeNull();
    const result = readToolResult(userDataDir, 'ScheduleWakeup');
    expect(result).toMatchObject({ isError: true });
    expect(JSON.stringify(result.output)).toContain(
      'Something this needs is missing',
    );
    expect(readWatchers(userDataDir)).toEqual([]);
  } catch (error) {
    await attachDiagnostics(testInfo, userDataDir);
    throw error;
  } finally {
    if (electronApp) await closeCanopy(electronApp, userDataDir);
    cleanupDemoWorkspaces(demo);
  }
});

test('ScheduleWakeup in an organization-owned workspace is armed with its organization binding', async ({}, testInfo) => {
  test.setTimeout(180_000);
  const marker = 'Canopy-CWATCHERORGWAKEUP';
  const apiKey = 'csk_watcher_org_wakeup';
  await registerScenario(DEFAULT_MOCK_BASE_URL, apiKey, {
    cloud: { organizations: ORG_CONTEXT_ORGANIZATIONS },
  });
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-watcher-org-wakeup-'),
  );
  const demo = seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  markWorkspaceOrganizationOwned(userDataDir, WORKSPACE_ID, ORG_CONTEXT_A);
  seedCapabilityChat(userDataDir, undefined);
  await registerScenario(DEFAULT_MOCK_BASE_URL, marker, {
    llm: {
      steps: [
        {
          toolCalls: [
            {
              name: 'mcp__canopy__ScheduleWakeup',
              input: { delaySeconds: 600 },
            },
          ],
          stopReason: 'tool_use',
        },
        { text: 'The wakeup is armed', stopReason: 'end_turn' },
      ],
    },
  });
  let electronApp;
  try {
    ({ electronApp } = await withBundledBinaryOverridesScrubbed(() =>
      launchCanopy({ userDataDir, env: ORG_CONTEXT_ENV }),
    ));
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await connectMockCloudAccount(window, apiKey);
    await selectWorkspaceContext(window, ORG_CONTEXT_A);
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_ID);
    const panel = await sendMessage(
      window,
      `[${marker}] Check back in ten minutes.`,
    );
    await expect(panel.getByText('The wakeup is armed').first()).toBeVisible({
      timeout: 90_000,
    });
    await expect
      .poll(() => readToolResult(userDataDir, 'ScheduleWakeup') ?? null, {
        timeout: 30_000,
      })
      .not.toBeNull();
    const result = readToolResult(userDataDir, 'ScheduleWakeup');
    expect(JSON.stringify(result.output)).not.toContain(
      'different Personal or organization context',
    );
    expect(result.isError).not.toBe(true);
    expect(readWatchers(userDataDir)).toEqual([
      expect.objectContaining({
        trigger: 'scheduled_wakeup',
        status: 'active',
        executionContext: `org:${ORG_CONTEXT_A}`,
      }),
    ]);
  } catch (error) {
    await attachDiagnostics(testInfo, userDataDir);
    throw error;
  } finally {
    if (electronApp) await closeCanopy(electronApp, userDataDir);
    cleanupDemoWorkspaces(demo);
  }
});
