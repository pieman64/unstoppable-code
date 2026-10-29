import { runSessionReuseFlow } from './seeders/sessionReuseFlow.mjs';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import {
  registerScenario,
  DEFAULT_MOCK_BASE_URL,
} from './seeders/registerScenario.mjs';
import {
  chooseChatInterfaceMode,
  openChatInterfaceModeMenu,
} from './chatInterfaceMode.mjs';

// Doc 2 Spec 11 (PRs 795 / 821, Doc 14) — close the App-Advisor terminal-mode +
// voice gap.
//
// The App Advisor renders in a SECOND BrowserWindow. `CanopyAppDriver.
// openAppAdvisorWindow(electronApp)` clicks `sidebar-nav-app-advisor`, waits
// for the new window, asserts `app-advisor-dialog`, and returns that window's
// page.
//
// SURFACE REALITY (read from the components, NOT guessed):
//
//   - The App Advisor offers the chat's interface modes ONLY when the active
//     App-Advisor tab is Claude-backed (`providerIsClaude`): its composer's
//     + menu lists them under View (`chat-interface-mode-option-*`), and the
//     terminal surface floats `ChatInterfaceModeToggle`
//     (`chat-interface-mode-toggle{,-canopy,-claude-code}`) to switch back. The
//     default App-Advisor model is `DEFAULT_APP_ADVISOR_MODEL` which aliases
//     `DEFAULT_CODEX_MODEL` (a Codex model) — so out of the box the toggle is
//     ABSENT. To exercise it we seed `appAdvisorModel: 'opus[1m]'` (a Claude
//     model) into `preferences.json` so the fresh App-Advisor tab is
//     Claude-backed and the toggle appears.
//
//   - In `canopy` interface mode the dialog mounts the Canopy-native composer
//     (`ChatContent` → `ChatInput`). In `claude-code` (terminal) interface mode
//     the dialog mounts `ClaudeCodeTerminalExperience` INSTEAD of the composer
//     (`AppAdvisorDialog.tsx`, the `providerIsClaude && interfaceMode ===
//     'claude-code'` branch). Switching interface modes is pure renderer/store
//     state — it does NOT require a live PTY to mount. We stop at the toggle's
//     `aria-pressed` swap and (in terminal mode) at the
//     `claude-code-experience-*` status surface, which is the deterministic
//     signal that the composer was replaced.
//
//   - Voice button (`shared/VoiceInputButton.tsx`, testid
//     `voice-input-button`): rendered by `ChatInput` only when
//     `voiceSupported && voiceEnabledPref`. Deterministic supported and
//     unsupported cases use the existing E2E-only voice access seam. A third
//     smoke case keeps the runtime capability guard and verifies whatever the
//     real host reports. Terminal mode replaces the composer entirely, so the
//     voice button unmounts there.
//
//   - Default App-Advisor interface mode is a Settings → Claude-tab preference.
//     `ClaudeTab.tsx` renders the radio group with testid prefix
//     `settings-claude-default-app-advisor-chat-mode` (options `-canopy` /
//     `-claude-code`). The settings nav section is `claude`.

const CLAUDE_APP_ADVISOR_MODEL = 'opus[1m]';

/**
 * Seed `preferences.json` (`{ version, preferences }` shape, matching
 * `preferences-store.ts`) so onboarding is suppressed AND the App Advisor uses
 * a Claude model (making the interface-mode toggle reachable). Optionally set
 * the default App-Advisor interface mode.
 *
 * @param {string} userDataDir
 * @param {{ defaultAppAdvisorInterfaceMode?: 'canopy' | 'claude-code' }} [extra]
 */
function seedPreferences(userDataDir, extra = {}) {
  const preferencesPath = path.join(userDataDir, 'preferences.json');
  mkdirSync(userDataDir, { recursive: true });
  const preferences = {
    onboardingCompleted: ['v1'],
    appAdvisorModel: CLAUDE_APP_ADVISOR_MODEL,
    ...(extra.defaultAppAdvisorInterfaceMode
      ? { defaultAppAdvisorInterfaceMode: extra.defaultAppAdvisorInterfaceMode }
      : {}),
  };
  writeFileSync(
    preferencesPath,
    `${JSON.stringify({ version: 1, preferences }, null, 2)}\n`,
    'utf8',
  );
}

function makeUserDataDir() {
  return mkdtempSync(path.join(os.tmpdir(), 'canopy-app-advisor-mode-'));
}

/**
 * Locator for the `ClaudeCodeTerminalExperience` status container (one of
 * `claude-code-experience-{unsupported,launch-error,exited,starting,ready}`).
 * Matching the container testids only — NOT the `-action` Restart button —
 * keeps the locator single-match so `toBeVisible()` does not trip strict mode.
 * The exact status (starting / ready / launch-error / exited) depends on
 * whether the bundled Claude binary launches in the harness; any of them proves
 * the Canopy composer was replaced by the terminal experience.
 */
function terminalExperienceSurface(page) {
  return page.getByTestId(
    /^claude-code-experience-(unsupported|launch-error|exited|starting|ready)$/,
  );
}

test.describe('app advisor mode (795/821)', () => {
  test('795: interface-mode toggle swaps between canopy and terminal mode', async () => {
    const userDataDir = makeUserDataDir();
    seedPreferences(userDataDir);

    const { electronApp } = await launchCanopy({ userDataDir });

    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell({ timeout: 30_000 });

      const advisor = await app.openAppAdvisorWindow(electronApp);

      // The modes are offered because the App-Advisor tab is Claude-backed
      // (seeded `appAdvisorModel`): the composer's + menu lists them under
      // View, and no toggle floats over the Canopy surface.
      await expect(
        advisor.getByTestId('chat-interface-mode-toggle'),
      ).toHaveCount(0);
      await openChatInterfaceModeMenu(advisor, advisor);
      const canopyRow = advisor.getByTestId(
        'chat-interface-mode-option-canopy',
      );
      const claudeCodeRow = advisor.getByTestId(
        'chat-interface-mode-option-claude-code',
      );

      // Fresh tab defaults to canopy-native mode (the seeded default interface
      // mode is `canopy`): Canopy checked, Claude Code not. The modes are one
      // single-select choice, so each row is a radio.
      await expect(canopyRow).toHaveAttribute('role', 'radio');
      await expect(canopyRow).toHaveAttribute('aria-checked', 'true');
      await expect(claudeCodeRow).toHaveAttribute('aria-checked', 'false');
      // The Canopy-native composer is mounted in canopy mode.
      await expect(
        advisor.getByTestId('app-advisor-workspace-surface'),
      ).toBeVisible();

      // Pick Claude Code → interface mode swaps to terminal: the dialog mounts
      // `ClaudeCodeTerminalExperience` in place of the composer, and its
      // floating toggle shows Claude Code pressed. One of the
      // `claude-code-experience-*` status surfaces proves the composer was
      // replaced, without requiring a live PTY to fully launch.
      await claudeCodeRow.click();
      const floatingClaudeCode = advisor.getByTestId(
        'chat-interface-mode-toggle-claude-code',
      );
      const floatingCanopy = advisor.getByTestId(
        'chat-interface-mode-toggle-canopy',
      );
      await expect(floatingClaudeCode).toHaveAttribute('aria-pressed', 'true');
      await expect(floatingCanopy).toHaveAttribute('aria-pressed', 'false');
      await expect(terminalExperienceSurface(advisor)).toBeVisible();
      // A switch requested while the terminal is still starting is dropped,
      // so wait for it to settle (ready, or a launch error on hosts without
      // a working terminal) before switching back.
      await expect(
        advisor.getByTestId('claude-code-experience-starting'),
      ).toHaveCount(0, { timeout: 30_000 });

      // The floating toggle switches back to canopy-native mode: the terminal
      // experience unmounts and the + menu shows Canopy checked again.
      await floatingCanopy.click();
      await expect(terminalExperienceSurface(advisor)).toHaveCount(0);
      await openChatInterfaceModeMenu(advisor, advisor);
      await expect(canopyRow).toHaveAttribute('aria-checked', 'true');
      await expect(claudeCodeRow).toHaveAttribute('aria-checked', 'false');
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test('821: supported voice capability mounts in canopy mode and leaves with the composer', async () => {
    const userDataDir = makeUserDataDir();
    seedPreferences(userDataDir);

    const { electronApp } = await launchCanopy({
      userDataDir,
      env: { CANOPY_E2E_VOICE_ACCESS_FLOW: 'grant-after-request' },
    });

    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell({ timeout: 30_000 });

      const advisor = await app.openAppAdvisorWindow(electronApp);

      await expect
        .poll(() => advisor.evaluate(() => window.api.voice?.isSupported()))
        .toEqual({ supported: true });
      const voiceButton = advisor.getByTestId('voice-input-button');
      await expect(voiceButton).toBeVisible();
      await expect(voiceButton).toBeEnabled();

      await chooseChatInterfaceMode(advisor, advisor, 'claude-code');
      await expect(
        advisor.getByTestId('chat-interface-mode-toggle-claude-code'),
      ).toHaveAttribute('aria-pressed', 'true');
      await expect(terminalExperienceSurface(advisor)).toBeVisible();
      await expect(advisor.getByTestId('voice-input-button')).toHaveCount(0);
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test('821: unsupported voice capability keeps the affordance absent', async () => {
    const userDataDir = makeUserDataDir();
    seedPreferences(userDataDir);
    const { electronApp } = await launchCanopy({
      userDataDir,
      env: { CANOPY_E2E_VOICE_ACCESS_FLOW: 'unsupported' },
    });

    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell({ timeout: 30_000 });
      const advisor = await app.openAppAdvisorWindow(electronApp);

      await expect
        .poll(() => advisor.evaluate(() => window.api.voice?.isSupported()))
        .toEqual({
          supported: false,
          reason: 'Voice dictation is unavailable in this test scenario.',
        });
      await expect(advisor.getByTestId('voice-input-button')).toHaveCount(0);
      await chooseChatInterfaceMode(advisor, advisor, 'claude-code');
      await expect(terminalExperienceSurface(advisor)).toBeVisible();
      await expect(advisor.getByTestId('voice-input-button')).toHaveCount(0);
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test('821: real-host voice capability matches the rendered affordance', async () => {
    const userDataDir = makeUserDataDir();
    seedPreferences(userDataDir);
    const { electronApp } = await launchCanopy({ userDataDir });

    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell({ timeout: 30_000 });
      const advisor = await app.openAppAdvisorWindow(electronApp);
      const capability = await advisor.evaluate(() =>
        window.api.voice?.isSupported(),
      );

      expect(typeof capability?.supported).toBe('boolean');
      if (capability.supported) {
        await expect(advisor.getByTestId('voice-input-button')).toBeVisible();
      } else {
        await expect(advisor.getByTestId('voice-input-button')).toHaveCount(0);
      }
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test('795: default App-Advisor interface-mode preference persists across relaunch', async () => {
    // Settings → Claude tab → flip the default App-Advisor interface-mode radio
    // to Terminal, then relaunch reusing the same userDataDir and assert the
    // preference persisted (radio stays checked) AND the App Advisor opens in
    // the persisted terminal mode.
    const userDataDir = makeUserDataDir();
    // Seed only the Claude model (default interface mode stays the app default
    // `canopy`), so the radio flip below is a real change.
    seedPreferences(userDataDir);

    const firstLaunch = await launchCanopy({ userDataDir });
    try {
      const window = await firstLaunch.electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell({ timeout: 30_000 });

      // Open Settings → Claude tab.
      await app.openSettings();
      await app.openSettingsSection('claude');
      await expect(window.getByTestId('settings-tab-claude')).toBeVisible();

      const canopyRadio = window.getByTestId(
        'settings-claude-default-app-advisor-chat-mode-canopy',
      );
      const terminalRadio = window.getByTestId(
        'settings-claude-default-app-advisor-chat-mode-claude-code',
      );
      // Default is canopy.
      await expect(canopyRadio).toBeChecked();
      await expect(terminalRadio).not.toBeChecked();

      // Flip to Terminal. The save is fire-and-forget via `savePreferences`; we
      // wait for the checked state to settle, then confirm persistence after
      // relaunch (the authoritative signal).
      await terminalRadio.check();
      await expect(terminalRadio).toBeChecked();
    } finally {
      // Keep the user data dir so the relaunch sees the persisted preference.
      await closeCanopy(firstLaunch.electronApp, userDataDir, {
        keepUserData: true,
      });
    }

    // Relaunch reusing the same userDataDir.
    const secondLaunch = await launchCanopy({ userDataDir });
    try {
      const window = await secondLaunch.electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell({ timeout: 30_000 });

      // The radio persisted to Terminal.
      await app.openSettings();
      await app.openSettingsSection('claude');
      await expect(
        window.getByTestId(
          'settings-claude-default-app-advisor-chat-mode-claude-code',
        ),
      ).toBeChecked();
      await app.closeSettings();

      // And a freshly-opened App Advisor honors the persisted default: the
      // Claude-code toggle is pressed and the terminal experience mounts.
      const advisor = await app.openAppAdvisorWindow(secondLaunch.electronApp);
      const claudeCodeButton = advisor.getByTestId(
        'chat-interface-mode-toggle-claude-code',
      );
      await expect(claudeCodeButton).toBeVisible();
      await expect(claudeCodeButton).toHaveAttribute('aria-pressed', 'true');
      await expect(
        advisor.getByTestId('chat-interface-mode-toggle-canopy'),
      ).toHaveAttribute('aria-pressed', 'false');
      await expect(terminalExperienceSurface(advisor)).toBeVisible();
    } finally {
      await closeCanopy(secondLaunch.electronApp, userDataDir);
    }
  });
});

for (const providerType of ['claude', 'codex']) {
  test(`CAN-2835 advisor ${providerType} preserves consecutive responses and restart`, async () => {
    test.setTimeout(240_000);
    await runSessionReuseFlow({ surface: 'advisor', providerType });
  });
}

test('App Advisor StartForkedAgent keeps the Work Entry and independent Advisor chat', async () => {
  test.setTimeout(180_000);
  const userDataDir = makeUserDataDir();
  seedPreferences(userDataDir);
  const marker = 'Canopy-CADVISORFORK';
  const childMarker = 'Canopy-CADVISORFORKCHILD';
  const instruction = `[${childMarker}] [Canopy-Mock-Request:advisor-fork-child] Investigate independently`;
  const sourceReply = 'Advisor source continued after its fork';
  const childReply = 'Advisor fork continued independently';
  await registerScenario(DEFAULT_MOCK_BASE_URL, marker, {
    llm: {
      steps: [
        {
          toolCalls: [
            {
              name: 'mcp__canopy_app_advisor__StartForkedAgent',
              input: { followUpInstruction: instruction },
            },
          ],
          stopReason: 'tool_use',
        },
        { text: sourceReply, stopReason: 'end_turn' },
      ],
      // A true fork resumes the source conversation, so the child's request
      // still carries the source marker; its hidden request tag picks the
      // child's reply.
      stepsByRequestTag: {
        'advisor-fork-child': { text: childReply, stopReason: 'end_turn' },
      },
    },
  });
  await registerScenario(DEFAULT_MOCK_BASE_URL, childMarker, {
    llm: { steps: [{ text: childReply, stopReason: 'end_turn' }] },
  });
  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    const advisor = await app.openAppAdvisorWindow(electronApp);
    const entryRow = advisor
      .locator(
        '[data-testid^="app-advisor-nav-entry-"][data-standalone-chat-id]',
      )
      .first();
    await expect(entryRow).toBeVisible();
    const entryId = (await entryRow.getAttribute('data-testid')).replace(
      'app-advisor-nav-entry-',
      '',
    );
    const scope = { projectId: 'app-advisor', worktreeId: entryId };
    const sourceState = await advisor.evaluate(
      (target) => window.api.chat.getState(target),
      scope,
    );
    const sourceChatId = sourceState.tabsFile.activeTabId;
    const panel = advisor.getByTestId('app-advisor-workspace-surface');
    await panel
      .getByRole('textbox')
      .first()
      .fill(`[${marker}] Fork this Advisor chat and continue here`);
    await panel.getByRole('button', { name: 'Send message' }).click();
    await expect
      .poll(
        async () => {
          const page = await advisor.evaluate(
            (request) => window.api.chat.getTranscriptPage(request),
            { ...scope, chatId: sourceChatId },
          );
          return page.messages.some((message) =>
            message.blocks.some(
              (block) => block.type === 'text' && block.text === sourceReply,
            ),
          );
        },
        { timeout: 90_000 },
      )
      .toBe(true);
    const sourcePage = await advisor.evaluate(
      (request) => window.api.chat.getTranscriptPage(request),
      { ...scope, chatId: sourceChatId },
    );
    const blocks = sourcePage.messages.flatMap((message) => message.blocks);
    const call = blocks.find(
      (block) =>
        block.type === 'tool_use' &&
        block.toolName?.endsWith('StartForkedAgent'),
    );
    const result = blocks.find(
      (block) =>
        block.type === 'tool_result' && block.toolUseId === call?.toolUseId,
    );
    expect(result, JSON.stringify(sourcePage.messages, null, 2)).toBeTruthy();
    expect(result.isError, result.output).not.toBe(true);
    const receipt = JSON.parse(result.output);
    expect(receipt).toMatchObject({
      ok: true,
      worktreeId: entryId,
      delivery: 'submitted',
      independent: true,
    });
    expect(receipt.chatId).not.toBe(sourceChatId);
    await expect
      .poll(
        async () => {
          const page = await advisor.evaluate(
            (request) => window.api.chat.getTranscriptPage(request),
            { ...scope, chatId: receipt.chatId },
          );
          return page.messages.some((message) =>
            message.blocks.some(
              (block) => block.type === 'text' && block.text === childReply,
            ),
          );
        },
        { timeout: 90_000 },
      )
      .toBe(true);
    const finalState = await advisor.evaluate(
      (target) => window.api.chat.getState(target),
      scope,
    );
    expect(finalState.tabsFile.tabs).toHaveLength(2);
    expect(
      finalState.tabsFile.tabs.find((tab) => tab.id === sourceChatId),
    ).toBeTruthy();
    expect(
      finalState.tabsFile.tabs.find((tab) => tab.id === receipt.chatId),
    ).toMatchObject({
      model: CLAUDE_APP_ADVISOR_MODEL,
      forkedFrom: {
        projectId: 'app-advisor',
        worktreeId: entryId,
        chatId: sourceChatId,
      },
    });
    // A true fork resumes the source Claude session: the child keeps the
    // conversation instead of starting fresh behind a notice.
    const childTab = finalState.tabsFile.tabs.find(
      (tab) => tab.id === receipt.chatId,
    );
    expect(childTab?.forkedFrom?.modelContext).not.toBe('fresh');
    expect(childTab?.sdkSessionId).toBeTruthy();
    expect(childTab?.sdkSessionId).not.toBe(
      sourceState.tabsFile.tabs[0]?.sdkSessionId,
    );
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('App Advisor DispatchAction creates a new entry with exactly one started chat', async () => {
  test.setTimeout(180_000);
  const userDataDir = makeUserDataDir();
  seedPreferences(userDataDir);
  const marker = 'Canopy-CADVISORCREATEENTRY';
  const childMarker = 'Canopy-CADVISORCREATEENTRYCHILD';
  const startText = `[${childMarker}] [Canopy-Mock-Request:advisor-entry-child] Start a fresh task`;
  const sourceReply = 'Created the requested Advisor entry';
  const childReply = 'The new Advisor entry started its task';
  await registerScenario(DEFAULT_MOCK_BASE_URL, marker, {
    llm: {
      steps: [
        {
          toolCalls: [
            {
              name: 'mcp__canopy_app_advisor__DispatchAction',
              input: {
                action: {
                  type: 'advisor-chat.create_entry',
                  title: 'Fresh Advisor task',
                  text: startText,
                },
              },
            },
          ],
          stopReason: 'tool_use',
        },
        { text: sourceReply, stopReason: 'end_turn' },
      ],
    },
  });
  await registerScenario(DEFAULT_MOCK_BASE_URL, childMarker, {
    llm: { steps: [{ text: childReply, stopReason: 'end_turn' }] },
  });
  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    const advisor = await app.openAppAdvisorWindow(electronApp);
    const rows = advisor.locator(
      '[data-testid^="app-advisor-nav-entry-"][data-standalone-chat-id]',
    );
    await expect(rows).toHaveCount(1);
    const originalEntryId = (
      await rows.first().getAttribute('data-testid')
    ).replace('app-advisor-nav-entry-', '');
    const originalScope = {
      projectId: 'app-advisor',
      worktreeId: originalEntryId,
    };
    const initialState = await advisor.evaluate(
      (target) => window.api.chat.getState(target),
      originalScope,
    );
    const originalChatId = initialState.tabsFile.activeTabId;
    const panel = advisor.getByTestId('app-advisor-workspace-surface');
    await panel
      .getByRole('textbox')
      .first()
      .fill(`[${marker}] Start this as a new Advisor Work Entry`);
    await panel.getByRole('button', { name: 'Send message' }).click();
    await expect(rows).toHaveCount(2, { timeout: 90_000 });
    await expect
      .poll(
        async () => {
          const page = await advisor.evaluate(
            (request) => window.api.chat.getTranscriptPage(request),
            { ...originalScope, chatId: originalChatId },
          );
          return page.messages.some((message) =>
            message.blocks.some(
              (block) => block.type === 'text' && block.text === sourceReply,
            ),
          );
        },
        { timeout: 90_000 },
      )
      .toBe(true);
    const sourcePage = await advisor.evaluate(
      (request) => window.api.chat.getTranscriptPage(request),
      { ...originalScope, chatId: originalChatId },
    );
    const resultBlock = sourcePage.messages
      .flatMap((message) => message.blocks)
      .find((block) => block.type === 'tool_result');
    expect(resultBlock?.isError, resultBlock?.output).not.toBe(true);
    const result = JSON.parse(resultBlock.output);
    expect(result.ok).toBe(true);
    const { workEntryId, chatId } = result.result;
    expect(workEntryId).toBeTruthy();
    expect(chatId).toBeTruthy();
    expect(workEntryId).not.toBe(originalEntryId);
    const newScope = { projectId: 'app-advisor', worktreeId: workEntryId };
    await expect
      .poll(
        async () => {
          const page = await advisor.evaluate(
            (request) => window.api.chat.getTranscriptPage(request),
            { ...newScope, chatId },
          );
          return page.messages.some((message) =>
            message.blocks.some(
              (block) => block.type === 'text' && block.text === childReply,
            ),
          );
        },
        { timeout: 90_000 },
      )
      .toBe(true);
    const newState = await advisor.evaluate(
      (target) => window.api.chat.getState(target),
      newScope,
    );
    expect(newState.tabsFile.tabs).toHaveLength(1);
    expect(newState.tabsFile.activeTabId).toBe(chatId);
    const oldState = await advisor.evaluate(
      (target) => window.api.chat.getState(target),
      originalScope,
    );
    expect(
      oldState.tabsFile.tabs.find((tab) => tab.id === originalChatId),
    ).toBeTruthy();
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('App Advisor DispatchAction starts a second chat inside the current entry', async () => {
  test.setTimeout(180_000);
  const userDataDir = makeUserDataDir();
  seedPreferences(userDataDir);
  const entryId = 'entry-existing';
  const sourceChatId = 'chat-existing';
  const createdAt = '2026-05-01T12:00:00.000Z';
  const advisorDir = path.join(userDataDir, 'app-workspaces', 'app-advisor');
  mkdirSync(path.join(advisorDir, 'chats'), { recursive: true });
  writeFileSync(
    path.join(advisorDir, 'work-entries.json'),
    JSON.stringify({
      version: 1,
      entries: [{ id: entryId, createdAt }],
    }),
  );
  writeFileSync(
    path.join(advisorDir, 'chats', `${entryId}.json`),
    JSON.stringify({
      version: 1,
      activeTabId: sourceChatId,
      tabs: [
        {
          id: sourceChatId,
          title: 'Existing Advisor chat',
          createdAt,
          providerType: 'claude',
          model: CLAUDE_APP_ADVISOR_MODEL,
          messages: [
            {
              id: 'source-user-1',
              role: 'user',
              blocks: [{ type: 'text', text: 'Existing Advisor context' }],
              timestamp: Date.parse(createdAt),
            },
          ],
        },
      ],
    }),
  );
  const marker = 'Canopy-CADVISORCREATECHAT';
  const childMarker = 'Canopy-CADVISORCREATECHATCHILD';
  const startText = `[${childMarker}] [Canopy-Mock-Request:advisor-chat-child] Start alongside this chat`;
  const sourceReply = 'Started another Advisor chat in this entry';
  const childReply = 'The new chat started in the same entry';
  await registerScenario(DEFAULT_MOCK_BASE_URL, marker, {
    llm: {
      steps: [
        {
          toolCalls: [
            {
              name: 'mcp__canopy_app_advisor__DispatchAction',
              input: {
                action: {
                  type: 'advisor-chat.create_chat',
                  workEntryId: entryId,
                  text: startText,
                },
              },
            },
          ],
          stopReason: 'tool_use',
        },
        { text: sourceReply, stopReason: 'end_turn' },
      ],
    },
  });
  await registerScenario(DEFAULT_MOCK_BASE_URL, childMarker, {
    llm: { steps: [{ text: childReply, stopReason: 'end_turn' }] },
  });
  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    const advisor = await app.openAppAdvisorWindow(electronApp);
    const rows = advisor.locator(
      '[data-testid^="app-advisor-nav-entry-"][data-standalone-chat-id]',
    );
    await expect(rows).toHaveCount(1);
    const visibleEntryId = (
      await rows.first().getAttribute('data-testid')
    ).replace('app-advisor-nav-entry-', '');
    expect(visibleEntryId).toBe(entryId);
    const scope = { projectId: 'app-advisor', worktreeId: entryId };
    const initialState = await advisor.evaluate(
      (target) => window.api.chat.getState(target),
      scope,
    );
    expect(initialState.tabsFile.activeTabId).toBe(sourceChatId);
    const panel = advisor.getByTestId('app-advisor-workspace-surface');
    await panel
      .getByRole('textbox')
      .first()
      .fill(`[${marker}] Start a second Advisor chat in this Work Entry`);
    await panel.getByRole('button', { name: 'Send message' }).click();
    await expect
      .poll(
        async () => {
          const page = await advisor.evaluate(
            (request) => window.api.chat.getTranscriptPage(request),
            { ...scope, chatId: sourceChatId },
          );
          return page.messages.some((message) =>
            message.blocks.some(
              (block) => block.type === 'text' && block.text === sourceReply,
            ),
          );
        },
        { timeout: 90_000 },
      )
      .toBe(true);
    const sourcePage = await advisor.evaluate(
      (request) => window.api.chat.getTranscriptPage(request),
      { ...scope, chatId: sourceChatId },
    );
    const resultBlock = sourcePage.messages
      .flatMap((message) => message.blocks)
      .find((block) => block.type === 'tool_result');
    expect(resultBlock?.isError, resultBlock?.output).not.toBe(true);
    const result = JSON.parse(resultBlock.output);
    expect(result).toMatchObject({
      ok: true,
      result: { workEntryId: entryId },
    });
    const childChatId = result.result.chatId;
    expect(childChatId).toBeTruthy();
    expect(childChatId).not.toBe(sourceChatId);
    const finalState = await advisor.evaluate(
      (target) => window.api.chat.getState(target),
      scope,
    );
    expect(finalState.tabsFile.tabs).toHaveLength(2);
    expect(
      finalState.tabsFile.tabs.find((tab) => tab.id === childChatId),
    ).toBeTruthy();
    // The new chat starts in the background; the user stays on the source.
    expect(finalState.tabsFile.activeTabId).toBe(sourceChatId);
    await expect
      .poll(
        async () => {
          const page = await advisor.evaluate(
            (request) => window.api.chat.getTranscriptPage(request),
            { ...scope, chatId: childChatId },
          );
          return page.messages.some((message) =>
            message.blocks.some(
              (block) => block.type === 'text' && block.text === childReply,
            ),
          );
        },
        { timeout: 90_000 },
      )
      .toBe(true);
    await expect(rows).toHaveCount(1);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
