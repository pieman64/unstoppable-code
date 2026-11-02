import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import {
  closeFixture,
  createFixture,
  seedPreferences,
  conversationRequests,
} from './codexPipelineRuntime.mjs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { readChatStorageTabs } from './readChatStorage.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import {
  clearScenario,
  DEFAULT_MOCK_BASE_URL,
  initializeIsolatedCodexState,
  registerScenario,
  seedWorkspaceApprovals,
  seedUsageLimitedChats,
  seedWorktreeChat,
} from './seeders/index.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';

const PROJECT_ID = 'demo-ts-pnpm-vite';
const WORKTREE_ID = 'demo-main';
const CHAT_ID = 'interrupted-codex-timers';
const MARKER = 'Canopy-CINTERRUPTED-TIMERS';

// Run a real bundled Codex against local scripted Responses. The chat remains
// unopened until AFTER the failed turn, app restart, and resume confirmation.
export async function withResumedCodexTimers(verify) {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-resume-timers-'),
  );
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedWorkspaceApprovals({
    userDataDir,
    workspaceId: PROJECT_ID,
    defaultMode: 'full-access',
  });
  seedWorktreeChat({
    userDataDir,
    workspaceId: PROJECT_ID,
    worktreeId: WORKTREE_ID,
    providerType: 'codex',
    tabs: [
      { id: CHAT_ID, title: 'Interrupted timer recovery', model: 'gpt-5.5' },
    ],
  });
  const workspaceRoot = path.join(userDataDir, 'workspaces', PROJECT_ID);
  const readTab = () =>
    readChatStorageTabs(workspaceRoot, WORKTREE_ID).tabs.find(
      (tab) => tab.id === CHAT_ID,
    );
  let electronApp;
  try {
    initializeIsolatedCodexState(userDataDir);
    await registerScenario(DEFAULT_MOCK_BASE_URL, MARKER, {
      llm: {
        openAiStepCursor: 'completed-scenario-tool-calls',
        steps: [
          {
            text: 'Checking the launch output before continuing the investigation.',
            toolCalls: [
              {
                name: 'mcp__canopy__GetScriptOutput',
                input: { scriptId: 'launch' },
              },
            ],
            stopReason: 'tool_use',
          },
          { error: 'usage_limit' },
        ],
      },
    });
    ({ electronApp } = await launchCanopy({ userDataDir }));
    let window = await electronApp.firstWindow();
    let app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await window.evaluate((request) => window.api.chat.sendMessage(request), {
      projectId: PROJECT_ID,
      worktreeId: WORKTREE_ID,
      chatId: CHAT_ID,
      userMessageId: 'failed-user',
      providerType: 'codex',
      model: 'gpt-5.5',
      text: `[${MARKER}] Inspect the launch output and continue investigating.`,
    });
    await expect
      .poll(() => JSON.stringify(readTab().messages), { timeout: 60_000 })
      .toContain('Error:');
    await closeCanopy(electronApp, userDataDir, { keepUserData: true });
    electronApp = undefined;
    const failedTab = readTab();
    // The HTTP mock's 429 becomes a generic Codex retry-limit error rather
    // than the hosted account's structured usageLimitExceeded notification.
    // Seed only its recovery registry entry; all transcript/timer state above
    // was written by the real failed provider turn with no chat renderer open.
    seedUsageLimitedChats({
      userDataDir,
      entries: [
        {
          projectId: PROJECT_ID,
          worktreeId: WORKTREE_ID,
          chatId: CHAT_ID,
          provider: 'codex',
          detectedAt: Date.now(),
          workspaceName: 'TypeScript pnpm Vite',
          chatTitle: 'Interrupted timer recovery',
        },
      ],
    });

    await registerScenario(DEFAULT_MOCK_BASE_URL, MARKER, {
      llm: {
        steps: [
          {
            text: 'Continuing the investigation after the interrupted turn. The resumed provider is actively working on the remaining checks.',
            streamMs: 60_000,
            chunkChars: 1,
            stopReason: 'end_turn',
          },
        ],
      },
    });
    ({ electronApp } = await launchCanopy({ userDataDir }));
    window = await electronApp.firstWindow();
    app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openUsagePage();
    // The Usage page's one interrupted-sessions notice opens the same review
    // as Home's Continue row, for every interrupted session in context.
    await window.getByTestId('usage-interrupted-sessions-resume').click();
    const modal = window.getByTestId('usage-limit-resume-modal');
    await expect(modal).toBeVisible();
    await expect(
      window.getByTestId(`usage-limit-resume-chat-${CHAT_ID}`),
    ).toBeChecked();
    await window.getByTestId('usage-limit-resume-confirm').click();
    await expect(modal).toBeHidden({ timeout: 30_000 });
    // One confirmed chat opens directly, without the queue, while it streams.
    await expect(window.getByTestId('resume-queue-modal')).toBeHidden();
    const panel = window.getByTestId('panel-content-chat');
    await expect(panel).toHaveAttribute(
      'data-panel-id',
      `panel-chat-${CHAT_ID}`,
    );
    const marker = panel.getByTestId('auto-resume-marker');
    await expect(marker).toHaveCount(1);
    await expect(marker).toContainText('Sent automatically: Continue');
    await expect(marker).toHaveAttribute(
      'data-auto-resume-reason',
      'usage_limit',
    );
    // Settled turns use the existing collapsed agent-steps presentation.
    // The shared marker replaces the old nudge bubble and generic banner.
    // A turn with no step chips is named a bare "Agent steps" (CAN-4810).
    const collapsedSteps = panel
      .getByRole('button', { name: /^Agent steps(?::|$)/, expanded: false })
      .first();
    if (await collapsedSteps.count()) await collapsedSteps.click();
    await expect(
      panel.getByText('Chat initiated by automation', { exact: false }),
    ).toHaveCount(0);
    await expect(panel.getByTestId('chat-stop-generation')).toBeVisible({
      timeout: 30_000,
    });
    await verify({ window, panel, failedTab, readTab });
  } finally {
    if (electronApp) await closeCanopy(electronApp, userDataDir);
    await clearScenario(DEFAULT_MOCK_BASE_URL, MARKER);
  }
}

// Six persisted interrupted chats, a native-shaped rejection, and the real
// account-change UI, all in one app process. No live provider credentials.
export async function withAccountChangedCodexResumes(verify) {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-bulk-resume-'),
  );
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedPreferences(userDataDir);
  seedWorkspaceApprovals({
    userDataDir,
    workspaceId: PROJECT_ID,
    defaultMode: 'full-access',
  });
  const chatIds = Array.from(
    { length: 6 },
    (_, index) => `bulk-resume-${index + 1}`,
  );
  seedWorktreeChat({
    userDataDir,
    workspaceId: PROJECT_ID,
    worktreeId: WORKTREE_ID,
    providerType: 'codex',
    tabs: chatIds.map((id, index) => ({
      id,
      title: `Interrupted task ${index + 1}`,
      model: 'gpt-6-sol',
    })),
  });
  const workspaceRoot = path.join(userDataDir, 'workspaces', PROJECT_ID);
  seedUsageLimitedChats({
    userDataDir,
    entries: chatIds.map((chatId) => ({
      projectId: PROJECT_ID,
      worktreeId: WORKTREE_ID,
      chatId,
      provider: 'codex',
      resumeReason: 'app_shutdown',
      detectedAt: Date.now(),
      workspaceName: 'TypeScript pnpm Vite',
      chatTitle: chatId,
    })),
  });
  const fixture = createFixture('usage-limit-resume');
  const accountPath = path.join(fixture.runtimeDir, 'account.txt');
  writeFileSync(accountPath, 'old-account@example.test\n');
  const { CANOPY_E2E_CODEX_REPLY: _reply, ...env } = fixture.env;
  let electronApp;
  try {
    ({ electronApp } = await launchCanopy({
      userDataDir,
      env: {
        ...env,
        CANOPY_E2E_CODEX_ACCOUNT_PATH: accountPath,
        CANOPY_E2E_CODEX_LOGIN_ACCOUNT: 'new-account@example.test',
        CANOPY_E2E_CODEX_LOGIN_RESULT_PATH: path.join(
          fixture.runtimeDir,
          'login-result',
        ),
      },
    }));
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await window.getByTestId('sidebar-create-task').click();
    await expect(window.getByTestId('page-home')).toBeVisible();
    await window.getByTestId('home-interrupted-sessions-resume').click();
    const modal = window.getByTestId('usage-limit-resume-modal');
    await expect(modal).toBeVisible();
    for (const chatId of chatIds)
      await expect(
        window.getByTestId(`usage-limit-resume-chat-${chatId}`),
      ).toBeChecked();
    await window.getByTestId('usage-limit-resume-confirm').click();
    await expect(modal).toBeHidden({ timeout: 30_000 });
    // An active batch keeps its pacing and controls in the footer; the
    // header ✕ is the only close control.
    const queue = window.getByTestId('resume-queue-modal');
    const footer = queue.getByTestId('resume-queue-footer');
    await expect(footer).toContainText('Saved automatically');
    await expect(
      footer.getByRole('button', { name: 'Close', exact: true }),
    ).toHaveCount(0);
    await expect(
      footer.getByRole('button', { name: 'Stop remaining', exact: true }),
    ).toBeVisible();
    await expect(
      queue.getByRole('button', { name: 'Open chat', exact: true }),
    ).toHaveCount(chatIds.length);
    await window
      .getByRole('dialog', { name: 'Resume queue' })
      .getByRole('button', { name: 'Close', exact: true })
      .click();
    const readTabs = () => readChatStorageTabs(workspaceRoot, WORKTREE_ID).tabs;
    // Six handoffs now include ten-second gaps, plus provider startup and persistence.
    // A Codex usage limit is banner-only (CAN-4564), so wait for the persisted
    // banner rather than a transcript row.
    await expect
      .poll(
        () =>
          readTabs().filter(
            (tab) => tab.llmProviderUsageLimitBanner?.provider === 'codex',
          ).length,
        { timeout: 90_000 },
      )
      .toBe(6);
    expect(
      readTabs().some((tab) =>
        tab.messages.some((message) =>
          message.blocks.some(
            (block) =>
              block.type === 'text' && block.text.includes('chatgpt.com'),
          ),
        ),
      ),
    ).toBe(false);
    // The resumed turns immediately hit the same usage limit. Their fresh
    // registry entries must survive the cleanup from this resume attempt so
    // the user can act on them again from Home.
    await expect
      .poll(() => {
        const registry = JSON.parse(
          readFileSync(
            path.join(userDataDir, 'usage-limited-chats.json'),
            'utf8',
          ),
        );
        return registry.entries.length;
      })
      .toBe(6);
    await window.getByTestId('sidebar-create-task').click();
    await expect(window.getByTestId('page-home')).toBeVisible();
    await expect(
      window.getByTestId('home-interrupted-sessions-resume'),
    ).toBeVisible();
    // The protocol boundary proves the first batch ran and rejected, independently
    // of the UI or the canonical timer projection being tested.
    expect(
      conversationRequests(fixture.logPath).filter(
        (request) => request.method === 'turn/start',
      ),
    ).toHaveLength(6);
    await app.openSettings();
    await app.openSettingsSection('account');
    await window.getByTestId('auth-panel-codex-connect').click();
    const login = window.getByTestId('auth-login-modal');
    await expect(login).toContainText(/Finish signing in|work will pause/);
    if (await login.getByTestId('auth-login-submit').isVisible())
      await login.getByTestId('auth-login-submit').click();
    await expect(login).toContainText('Finish signing in');
    writeFileSync(path.join(fixture.runtimeDir, 'login-result'), 'success');
    await expect
      .poll(() => readFileSync(accountPath, 'utf8').trim())
      .toBe('new-account@example.test');
    await expect(window.getByTestId('auth-login-modal')).toBeHidden({
      timeout: 30_000,
    });
    // Account-change may offer the same modal automatically. Dismiss that offer
    // so both resume attempts exercise the user's Home entry point.
    if (await modal.isVisible()) await window.keyboard.press('Escape');
    await app.closeSettings();
    await window.getByTestId('sidebar-create-task').click();
    await expect(window.getByTestId('page-home')).toBeVisible();
    await window.getByTestId('home-interrupted-sessions-resume').click();
    await expect(modal).toBeVisible();
    for (const chatId of chatIds)
      await expect(
        window.getByTestId(`usage-limit-resume-chat-${chatId}`),
      ).toBeChecked();
    await window.getByTestId('usage-limit-resume-confirm').click();
    await expect(modal).toBeHidden({ timeout: 30_000 });
    await window
      .getByRole('dialog', { name: 'Resume queue' })
      .getByRole('button', { name: 'Close', exact: true })
      .click();
    // The picker now returns after durable enqueue. Wait for the gradual queue
    // handoff before verifying the replies and timers of all six sessions.
    await expect(window.getByTestId('resume-queue-sidebar')).toContainText(
      'Resume queue finished',
      { timeout: 90_000 },
    );
    // Worktree conversations live on the main workspace surface, not Chats.
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_ID);
    await verify({
      window,
      app,
      chatIds,
      readTabs,
      fixture,
      electronApp,
      panel: window.locator('[data-testid="panel-content-chat"]:visible'),
      userDataDir,
    });
  } catch (error) {
    // Retain the handoff state before fixture cleanup, so a paced-resume failure
    // can be distinguished from provider startup or transcript projection failures.
    const info = test.info();
    for (const [name, file] of [
      ['resume-queue', path.join(userDataDir, 'resume-queue.json')],
      ['resume-main-log', path.join(userDataDir, 'logs', 'main.log')],
      ['resume-provider-protocol', fixture.logPath],
    ]) {
      if (existsSync(file))
        await info.attach(name, {
          body: readFileSync(file),
          contentType: 'text/plain',
        });
    }
    throw error;
  } finally {
    if (electronApp)
      await closeFixture(electronApp, userDataDir, fixture.runtimeDir);
  }
}
