import {
  seedActivityChat,
  seedCompletedMetadataChat,
  openActivityChat,
  injectActivityEvents,
  injectLateActivityMetadata,
  assertActivityCards,
  assertLateActivityMetadata,
  assertActivityFollowup,
} from './codexSubagentActivity.mjs';
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import {
  initializeIsolatedCodexState,
  seedWorktreeChat,
  registerScenario,
  getScenarioActivity,
  DEFAULT_MOCK_BASE_URL,
} from './seeders/index.mjs';
import { composerIdleAction } from './composerIdleAction.mjs';

// ---------------------------------------------------------------------------
// CODEX MULTI-AGENT — Doc 5 §5 "C-multiagent"; Doc 13 WP-LIVE-MULTIAGENT / Doc 14.
//
// WHAT "MULTI-AGENT" IS IN CANOPY
//   "Multi-agent" is a Codex *chat/app-server* capability, NOT the
//   `builtin/parallel-agents` pipeline action. Four `settings-codex-multi-agent-*`
//   toggles in the Codex settings tab (`settings/CodexTab.tsx` →
//   `CodexMultiAgentSettings`, descriptors in `settings/codexTabHelpers.ts`)
//   persist these `PreferencesData` booleans:
//     codexMultiAgentWorktreeChatsEnabled   (settings-codex-multi-agent-worktree-chats)
//     codexMultiAgentStandaloneChatsEnabled (settings-codex-multi-agent-standalone-chats)
//     codexMultiAgentAppAdvisorEnabled      (settings-codex-multi-agent-app-advisor)
//     codexMultiAgentPipelinesEnabled       (settings-codex-multi-agent-pipelines)
//   At turn time the worktree-chats flag is read into `codexMultiAgentEnabled`
//   and forwarded through `codex-session.ts` to `CodexAppServerClient`, where
//   `buildThreadConfig` (`apps/desktop-app/src/main/codex/app-server-client.ts`,
//   line ~126) emits both `features.multi_agent` generations on `thread/start`,
//   telling the bundled `codex` app-server it MAY spawn subagents.
//
// HOW SUB-AGENT ACTIVITY WOULD RENDER (the seam)
//   When the app-server actually spawns a subagent it emits a non-root
//   `thread.started` carrying `agent_nickname`/`agent_role` plus a
//   `collab_agent_tool_call` item with `tool === 'spawnAgent'`. The client folds
//   those into a `codex_agent` display block (subagent routing in
//   `app-server-client.ts`, lines ~507/1064/2019/2028). `ChatBlockRenderer.tsx`'s
//   `case 'codex_agent'` (line ~342) renders an `AgentBlock` → shared
//   `AgentBlockCard` (`packages/ui-shared/src/components/chat/AgentBlockCard.tsx`)
//   whose header reads "Agent · <displayName>" (`Agent &middot; {subagentType}`,
//   line ~140). That "Agent ·" chrome is the only sub-agent UI signal.
//
// LIVE EXECUTION COVERAGE
//   The earlier Codex/mock Responses blocker was removed in 2026-08. The
//   release-like `mixed-provider-agent-concurrency` performance scenario now
//   drives real Claude `Agent` and namespaced Codex `spawn_agent` tool calls
//   through the staged provider binaries. It holds root and child streams open,
//   validates provider-balanced overlap, checks Claude background-task events and
//   UI, and fails if Codex child events are missing or cross-routed between chat
//   tabs. The mock's Responses cursor advances on completed scripted tool calls,
//   rather than synthetic assistant bootstrap items, so the real app-server loop
//   remains deterministic.
//
// WHAT THIS SPEC ASSERTS (deterministic, reachable, GREEN)
//   The reachable signal for multi-agent in the UI is the config surface that
//   gates it. This spec asserts the full multi-agent toggle round-trip — the
//   same `PreferencesData` flags `buildThreadConfig` reads at turn time:
//     1. All four `settings-codex-multi-agent-*` toggles render in the Codex tab.
//     2. The worktree-chats toggle boots checked from seeded preferences
//        (proving the persisted flag drives the control), the other three off.
//     3. Flipping each toggle updates its checkbox (real `toggleMultiAgent` →
//        `savePreferences` round-trip).
//     4. After relaunch against the same data dir, the flipped states persisted
//        to disk: worktree-chats OFF, the other three ON.
//   Live multi-agent behavior belongs to the performance scenario described
//   above. This spec also verifies that disabling native delegation preserves
//   persisted Claude and Codex child history across application relaunch.
// ---------------------------------------------------------------------------

const MULTI_AGENT_TOGGLE_TESTIDS = [
  'settings-codex-multi-agent-worktree-chats',
  'settings-codex-multi-agent-standalone-chats',
  'settings-codex-multi-agent-app-advisor',
  'settings-codex-multi-agent-pipelines',
];

// Hand-write `preferences.json`: complete onboarding, default the worktree +
// chat provider to Codex (the provider these toggles gate), and pre-enable
// worktree-chat multi-agent so the control boots checked from disk — proving the
// persisted `codexMultiAgentWorktreeChatsEnabled` flag (the exact flag
// `buildThreadConfig` reads at turn time) drives the rendered toggle.
// `launchCanopy`'s `seedOnboardingCompleted` is a no-op when the file already
// exists, so we own the whole file here.
function seedPreferences(userDataDir, nativeWorktreeDelegation = true) {
  const preferencesPath = path.join(userDataDir, 'preferences.json');
  mkdirSync(userDataDir, { recursive: true });
  writeFileSync(
    preferencesPath,
    JSON.stringify(
      {
        version: 1,
        preferences: {
          onboardingCompleted: ['v1'],
          defaultWorktreeProvider: 'codex',
          defaultChatProvider: 'codex',
          codexMultiAgentWorktreeChatsEnabled: nativeWorktreeDelegation,
          codexMultiAgentStandaloneChatsEnabled: false,
          codexMultiAgentAppAdvisorEnabled: false,
          codexMultiAgentPipelinesEnabled: false,
        },
      },
      null,
      2,
    ),
    'utf8',
  );
}

test.describe('codex multi-agent', () => {
  test('Claude and Codex child history stays readable with Codex spawning disabled', async () => {
    test.setTimeout(180_000);
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-agent-history-'),
    );
    seedPreferences(userDataDir, false);
    seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
    const timestamp = Date.parse('2026-09-07T12:00:00.000Z');
    seedWorktreeChat({
      userDataDir,
      workspaceId: 'demo-ts-pnpm-vite',
      worktreeId: 'demo-main',
      tabs: [
        {
          id: 'claude-native-history',
          title: 'Claude native history',
          providerType: 'claude',
          blocks: [
            {
              type: 'tool_use',
              toolUseId: 'native-claude-call',
              toolName: 'Agent',
              input: JSON.stringify({
                subagent_type: 'general-purpose',
                description: 'Retained Claude child',
                prompt: 'Inspect the retained Claude history.',
                run_in_background: false,
              }),
            },
            {
              type: 'tool_result',
              toolUseId: 'native-claude-call',
              toolName: 'Agent',
              output: 'Retained Claude result',
              isError: false,
            },
          ],
        },
        {
          id: 'codex-native-history',
          title: 'Codex native history',
          providerType: 'codex',
          messages: [
            {
              id: 'codex-root-message',
              role: 'assistant',
              timestamp,
              blocks: [
                {
                  type: 'codex_agent_call',
                  agentBlockId: 'codex-agent-native-call',
                  callId: 'native-codex-call',
                  tool: 'spawnAgent',
                  status: 'completed',
                  senderThreadId: 'root-thread',
                  receiverThreadIds: ['child-thread'],
                  prompt: 'Retained Codex task',
                  agentsStates: {
                    'child-thread': {
                      status: 'completed',
                      message: 'Retained Codex result',
                    },
                  },
                  receiverAgents: {
                    'child-thread': {
                      nickname: 'Retained reviewer',
                      role: 'reviewer',
                    },
                  },
                },
              ],
            },
            {
              id: 'codex-child-message',
              role: 'assistant',
              timestamp: timestamp + 1,
              parentBlockId: 'codex-agent-native-call',
              codexThreadId: 'child-thread',
              blocks: [{ type: 'text', text: 'Retained Codex nested output' }],
            },
          ],
        },
      ],
    });

    for (const stage of ['initial', 'relaunch']) {
      const { electronApp } = await launchCanopy({ userDataDir });
      try {
        const window = await electronApp.firstWindow();
        const app = new CanopyAppDriver(window);
        await app.waitForShell();
        await app.openMainPage();
        await app.selectWorktree('demo-main');
        for (const provider of ['claude', 'codex']) {
          const chatId = `${provider}-native-history`;
          await window.getByTestId(`panel-tab-panel-chat-${chatId}`).click();
          const panel = window.locator(
            `[data-testid="panel-content-chat"][data-panel-id="panel-chat-${chatId}"]`,
          );
          const header = panel.getByRole('button', {
            name:
              provider === 'claude'
                ? /Agent.*Retained Claude child/
                : /Agent.*Retained reviewer/,
          });
          await header.click();
          if (provider === 'claude') {
            await panel
              .getByRole('button', { name: 'Show result', exact: true })
              .click();
            await expect(
              panel.getByText('Retained Claude result', { exact: true }),
            ).toBeVisible();
          } else {
            await expect(
              panel.getByText('Retained Codex nested output', { exact: true }),
            ).toBeVisible();
          }
        }
        await app.openSettings();
        await app.openSettingsSection('codex');
        for (const testId of MULTI_AGENT_TOGGLE_TESTIDS) {
          await expect(window.getByTestId(testId)).not.toBeChecked();
        }
      } finally {
        await closeCanopy(electronApp, userDataDir, {
          keepUserData: stage === 'initial',
        });
      }
    }
  });

  test('failed concurrency-limit saves restore the persisted value', async () => {
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-multi-agent-save-failure-'),
    );
    seedPreferences(userDataDir);
    const originalMode = statSync(userDataDir).mode & 0o777;
    const { electronApp } = await launchCanopy({ userDataDir });

    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell({ timeout: 30_000 });
      await window.evaluate(async () => {
        await window.api.savePreferences({
          codexMaxConcurrentSubagents: 3,
        });
      });
      await app.openSettings();
      await app.openSettingsSection('codex');

      const limit = window.getByTestId(
        'settings-codex-max-concurrent-subagents',
      );
      await expect(limit).toHaveValue('3');

      chmodSync(userDataDir, 0o500);
      await limit.fill('7');
      await limit.press('Tab');

      await expect(
        window.getByTestId('settings-codex-save-error'),
      ).toContainText('Could not save Codex settings.');
      await expect(limit).toHaveValue('3');
      await expect
        .poll(
          async () =>
            (await window.evaluate(() => window.api.loadPreferences()))
              .codexMaxConcurrentSubagents,
        )
        .toBe(3);
      await expect(limit).toHaveClass(/\bring-inset\b/);
      await expect(limit).toHaveClass(/\bring-line-secondary\b/);
    } finally {
      chmodSync(userDataDir, originalMode);
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test('multi-agent toggles render, flip, and persist across relaunch', async ({}, testInfo) => {
    test.setTimeout(120_000);

    const userDataDir =
      process.env.CANOPY_MA_DEBUG_DIR ??
      mkdtempSync(path.join(os.tmpdir(), 'canopy-multi-agent-'));

    seedPreferences(userDataDir);

    let { electronApp } = await launchCanopy({ userDataDir });

    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);

      await app.waitForShell({ timeout: 30_000 });

      // ── Deterministic config surface: the four multi-agent toggles ──────────
      await app.openSettings();
      await app.openSettingsSection('codex');

      // The worktree-chats toggle was pre-enabled via preferences, so it boots
      // checked; the other three default off. This proves the persisted
      // `codexMultiAgentWorktreeChatsEnabled` flag drives the rendered control.
      const worktreeToggle = window.getByTestId(
        'settings-codex-multi-agent-worktree-chats',
      );
      await expect(worktreeToggle).toBeVisible({ timeout: 30_000 });
      await expect(worktreeToggle).toBeChecked();

      for (const testId of MULTI_AGENT_TOGGLE_TESTIDS) {
        await expect(window.getByTestId(testId)).toBeVisible();
      }
      await expect(
        window.getByTestId('settings-codex-multi-agent-standalone-chats'),
      ).not.toBeChecked();
      await expect(
        window.getByTestId('settings-codex-multi-agent-app-advisor'),
      ).not.toBeChecked();
      await expect(
        window.getByTestId('settings-codex-multi-agent-pipelines'),
      ).not.toBeChecked();

      // Flip every toggle to its opposite state and assert the checkbox state
      // updates (real `toggleMultiAgent` → `savePreferences` round-trip). After
      // this: worktree-chats OFF, the other three ON.
      for (const testId of MULTI_AGENT_TOGGLE_TESTIDS) {
        const toggle = window.getByTestId(testId);
        const wasChecked = await toggle.isChecked();
        if (wasChecked) {
          await toggle.uncheck();
          await expect(toggle).not.toBeChecked();
        } else {
          await toggle.check();
          await expect(toggle).toBeChecked();
        }
        const field = {
          'settings-codex-multi-agent-worktree-chats':
            'codexMultiAgentWorktreeChatsEnabled',
          'settings-codex-multi-agent-standalone-chats':
            'codexMultiAgentStandaloneChatsEnabled',
          'settings-codex-multi-agent-app-advisor':
            'codexMultiAgentAppAdvisorEnabled',
          'settings-codex-multi-agent-pipelines':
            'codexMultiAgentPipelinesEnabled',
        }[testId];
        await expect
          .poll(
            async () =>
              (await window.evaluate(() => window.api.loadPreferences()))[
                field
              ],
          )
          .toBe(!wasChecked);
      }

      await window.screenshot({
        path: testInfo.outputPath('multi-agent-toggles.png'),
      });
      await app.closeSettings();
    } finally {
      // Keep the data dir so the relaunch below can read the persisted flags.
      await closeCanopy(electronApp, userDataDir, { keepUserData: true });
    }

    // ── Persistence across relaunch ─────────────────────────────────────────
    // Reopen against the same userDataDir and assert the flipped toggle states
    // persisted to disk: worktree-chats OFF, the other three ON. This is the
    // load-bearing proof that the save round-trip reached preferences.json.
    ({ electronApp } = await launchCanopy({ userDataDir }));
    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);

      await app.waitForShell({ timeout: 30_000 });
      await app.openSettings();
      await app.openSettingsSection('codex');

      await expect(
        window.getByTestId('settings-codex-multi-agent-worktree-chats'),
      ).toBeVisible({ timeout: 30_000 });

      await expect(
        window.getByTestId('settings-codex-multi-agent-worktree-chats'),
      ).not.toBeChecked();
      await expect(
        window.getByTestId('settings-codex-multi-agent-standalone-chats'),
      ).toBeChecked();
      await expect(
        window.getByTestId('settings-codex-multi-agent-app-advisor'),
      ).toBeChecked();
      await expect(
        window.getByTestId('settings-codex-multi-agent-pipelines'),
      ).toBeChecked();

      await app.closeSettings();
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });
});

test('completed agent card refreshes after metadata-only activity', async () => {
  test.setTimeout(90_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-agent-metadata-cache-'),
  );
  seedCompletedMetadataChat(userDataDir);
  const launched = await launchCanopy({ userDataDir });
  try {
    const { panel } = await openActivityChat(launched.electronApp);
    await panel.getByRole('button', { name: 'Agent steps: 1 agents' }).click();
    const research = panel.getByRole('button', { name: /Agent · Tesla/ });
    await expect(research).toContainText('Readme Review');
    await injectLateActivityMetadata(launched.electronApp);
    await assertLateActivityMetadata(panel);
  } finally {
    await closeCanopy(launched.electronApp, userDataDir);
  }
});

// The provider's newer activity events must use the same card/grouping UX.
for (const legacy of [true, false]) {
  test(`${legacy ? 'collab' : 'activity-only'} agents nest reports and survive relaunch`, async () => {
    test.setTimeout(120_000);
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-agent-activity-'),
    );
    seedActivityChat(userDataDir);
    let launched = await launchCanopy({ userDataDir });
    try {
      let { panel } = await openActivityChat(launched.electronApp);
      await injectActivityEvents(launched.electronApp, legacy);
      await assertActivityCards(panel, !legacy);
      await assertActivityFollowup(launched.electronApp, panel);
      await closeCanopy(launched.electronApp, userDataDir, {
        keepUserData: true,
      });
      launched = await launchCanopy({ userDataDir });
      ({ panel } = await openActivityChat(launched.electronApp));
      await assertActivityCards(panel, !legacy);
    } finally {
      await closeCanopy(launched.electronApp, userDataDir);
    }
  });
}

// Uses the real bundled app-server; only inference is mocked. No scripted
// spawn is needed: the provider-facing request is the authority for available
// tools, rather than the config arguments our client intended to send.
test('changing multi-agent settings updates the same resumed Codex chat', async () => {
  test.setTimeout(240_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-agent-policy-'),
  );
  seedPreferences(userDataDir);
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedWorktreeChat({
    userDataDir,
    workspaceId: 'demo-ts-pnpm-vite',
    worktreeId: 'demo-main',
    providerType: 'codex',
    activeTabId: 'agent-policy',
    tabs: [
      {
        id: 'agent-policy',
        title: 'Agent policy',
        providerType: 'codex',
        model: 'gpt-6-sol',
        pluginSelections: {
          marketplacePluginIds: [],
          skillRefs: [],
          pluginRefs: [],
          mcpServerRefs: [],
          collectionIds: [],
        },
        messages: [],
      },
      {
        id: 'policy-keeper',
        title: 'Connection keeper',
        providerType: 'codex',
        model: 'gpt-6-sol',
        pluginSelections: {
          marketplacePluginIds: [],
          skillRefs: [],
          pluginRefs: [],
          mcpServerRefs: [],
          collectionIds: [],
        },
        messages: [],
      },
    ],
  });
  const marker = 'Canopy-CAGENTPOLICY';
  const scenario = {
    llm: {
      steps: [{ text: 'Policy turn completed.', stopReason: 'end_turn' }],
      requestTextObservers: [
        { key: 'spawn-tool', text: '"name":"spawn_agent"', scope: 'tools' },
        {
          key: 'limit-two',
          text: 'There are 3 available concurrency slots',
          lastMessageContaining: 'available concurrency slots',
        },
        {
          key: 'limit-default',
          text: 'There are 4 available concurrency slots',
          lastMessageContaining: 'available concurrency slots',
        },
      ],
    },
  };
  await registerScenario(DEFAULT_MOCK_BASE_URL, marker, scenario);
  initializeIsolatedCodexState(userDataDir);
  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    await app.selectWorktree('demo-main');
    const panel = window.getByTestId('panel-content-chat');
    async function sendTurn(label) {
      await registerScenario(DEFAULT_MOCK_BASE_URL, marker, scenario);
      const previous = await panel
        .getByText('Policy turn completed.', { exact: true })
        .count();
      await window
        .getByRole('textbox')
        .first()
        .fill(`[${marker}] ${label}. Reply briefly without using tools.`);
      await window.getByRole('button', { name: 'Send message' }).click();
      await expect(
        panel.getByText('Policy turn completed.', { exact: true }),
      ).toHaveCount(previous + 1, { timeout: 90_000 });
      await expect(composerIdleAction(window)).toBeVisible();
      return (await getScenarioActivity(DEFAULT_MOCK_BASE_URL, marker))
        .activity;
    }
    // Keep a second subscribed chat alive so recreation cannot rely on killing
    // the shared app-server process to apply the new policy.
    await window.getByTestId('panel-tab-panel-chat-policy-keeper').click();
    await sendTurn('Connection keeper turn');
    await window.getByTestId('panel-tab-panel-chat-agent-policy').click();
    expect(
      (await sendTurn('Enabled turn'))['llmObserved:spawn-tool'],
    ).toBeGreaterThan(0);
    await app.openSettings();
    await app.openSettingsSection('codex');
    await window
      .getByTestId('settings-codex-multi-agent-worktree-chats')
      .uncheck();
    await expect
      .poll(
        async () =>
          (await window.evaluate(() => window.api.loadPreferences()))
            .codexMultiAgentWorktreeChatsEnabled,
      )
      .toBe(false);
    await app.closeSettings();
    const disabled = await sendTurn('Disabled turn');
    expect(disabled.llmRequests).toBeGreaterThan(0);
    expect(disabled['llmObserved:spawn-tool'] ?? 0).toBe(0);
    await app.openSettings();
    await app.openSettingsSection('codex');
    await window
      .getByTestId('settings-codex-multi-agent-worktree-chats')
      .check();
    await expect
      .poll(
        async () =>
          (await window.evaluate(() => window.api.loadPreferences()))
            .codexMultiAgentWorktreeChatsEnabled,
      )
      .toBe(true);
    await app.closeSettings();
    expect(
      (await sendTurn('Re-enabled turn'))['llmObserved:spawn-tool'],
    ).toBeGreaterThan(0);
    for (const value of ['2', '']) {
      await app.openSettings();
      await app.openSettingsSection('codex');
      const limit = window.getByTestId(
        'settings-codex-max-concurrent-subagents',
      );
      await limit.fill(value);
      await limit.press('Enter');
      await expect
        .poll(
          async () =>
            (await window.evaluate(() => window.api.loadPreferences()))
              .codexMaxConcurrentSubagents,
        )
        .toBe(value ? 2 : null);
      await app.closeSettings();
      const activity = await sendTurn(
        value ? 'Limited turn' : 'Default limit turn',
      );
      expect(
        activity[value ? 'llmObserved:limit-two' : 'llmObserved:limit-default'],
      ).toBeGreaterThan(0);
      expect(
        activity[
          value ? 'llmObserved:limit-default' : 'llmObserved:limit-two'
        ] ?? 0,
      ).toBe(0);
    }
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('new Codex settings default chat and pipeline scopes off and persist a subagent limit', async () => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-agent-defaults-'),
  );
  let { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await app.openSettings();
    await app.openSettingsSection('codex');
    for (const id of MULTI_AGENT_TOGGLE_TESTIDS) {
      await expect(window.getByTestId(id)).toBeVisible();
      if (id === 'settings-codex-multi-agent-app-advisor') {
        await expect(window.getByTestId(id)).toBeChecked();
      } else {
        await expect(window.getByTestId(id)).not.toBeChecked();
      }
    }
    const limit = window.getByTestId('settings-codex-max-concurrent-subagents');
    await expect(limit).toHaveValue('');
    await limit.fill('0');
    await limit.press('Tab');
    await expect(limit).toHaveAttribute('aria-invalid', 'true');
    expect(
      (await window.evaluate(() => window.api.loadPreferences()))
        .codexMaxConcurrentSubagents,
    ).toBeNull();
    await limit.fill('2');
    await limit.press('Enter');
    await expect
      .poll(
        async () =>
          (await window.evaluate(() => window.api.loadPreferences()))
            .codexMaxConcurrentSubagents,
      )
      .toBe(2);
    await app.closeSettings();
  } finally {
    await closeCanopy(electronApp, userDataDir, { keepUserData: true });
  }
  ({ electronApp } = await launchCanopy({ userDataDir }));
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await app.openSettings();
    await app.openSettingsSection('codex');
    const limit = window.getByTestId('settings-codex-max-concurrent-subagents');
    await expect(limit).toHaveValue('2');
    await limit.fill('');
    await limit.press('Enter');
    await expect
      .poll(
        async () =>
          (await window.evaluate(() => window.api.loadPreferences()))
            .codexMaxConcurrentSubagents,
      )
      .toBeNull();
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
