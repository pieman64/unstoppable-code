// Codex account cutover regression coverage.
//
// The local app-server fixture holds a real pipeline step until it is paused.
// Browser completion, cancellation, and failure all reconcile persisted account
// state and offer scoped manual resume. No live provider or network is used.
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import {
  closeFixture,
  createFixture,
  openWorkspaceAndRun,
  pipelineYaml,
  conversationRequests,
  protocolRequests,
  seedPreferences,
} from './codexPipelineRuntime.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { launchCanopy } from './launchCanopy.mjs';
import { DEFAULT_MOCK_BASE_URL, seedWorktreeChat } from './seeders/index.mjs';
import { seedStoredPipeline } from './seeders/seedStoredPipeline.mjs';

const WORKSPACE_ID = 'demo-ts-pnpm-vite';
const WORKTREE_ID = 'demo-main';
const PIPELINE_NAME = 'E2E Codex Account Cutover';
const OLD_ACCOUNT = 'old-account@example.test';
const NEW_ACCOUNT = 'new-account@example.test';

async function registerAuthScenario(key, account) {
  const response = await fetch(`${DEFAULT_MOCK_BASE_URL}/__mock/state`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      key,
      scenario: { authUsage: { codex: { account } } },
    }),
  });
  if (!response.ok) {
    throw new Error(
      `Failed to register Codex auth scenario: ${response.status}`,
    );
  }
}

async function clearAuthScenario(key) {
  await fetch(
    `${DEFAULT_MOCK_BASE_URL}/__mock/state/${encodeURIComponent(key)}`,
    { method: 'DELETE' },
  ).catch(() => undefined);
}

async function selectChat(app, window) {
  await expect(async () => {
    await app.selectWorktree(WORKTREE_ID);
    await expect(
      window.locator('[data-testid="panel-content-chat"]:visible').first(),
    ).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 30_000 });
}

async function sendAndExpectReply(window, prompt, reply) {
  const activePanel = window
    .locator('[data-testid="panel-content-chat"]:visible')
    .first();
  await expect(activePanel).toBeVisible({ timeout: 30_000 });
  const composer = activePanel.getByRole('textbox').first();
  const sendButton = activePanel.getByRole('button', { name: 'Send message' });
  await expect(composer).toBeVisible();
  await expect(composer).toBeEditable();
  await expect(
    activePanel.getByTestId('chat-model-change-pending'),
  ).toHaveCount(0);
  await composer.fill(prompt);
  await expect(sendButton).toBeEnabled();
  await sendButton.click();
  await expect(window.getByText(prompt, { exact: true }).last()).toBeVisible({
    timeout: 30_000,
  });
  await expect(window.getByText(reply, { exact: true }).last()).toBeVisible({
    timeout: 60_000,
  });
}

test.describe('Codex account cutover', () => {
  for (const outcome of [
    'success',
    'cancelled',
    'failed',
    'verification-failed',
    'cancelled-after-commit',
  ]) {
    test(`warns before pausing Codex work and offers manual resume after ${outcome}`, async () => {
      test.setTimeout(180_000);
      const userDataDir = mkdtempSync(
        path.join(os.tmpdir(), 'canopy-electron-codex-account-cutover-'),
      );
      seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
      seedPreferences(userDataDir);
      seedWorktreeChat({
        userDataDir,
        workspaceId: WORKSPACE_ID,
        worktreeId: WORKTREE_ID,
        providerType: 'codex',
        tabs: [
          {
            id: 'account-cutover-chat',
            title: 'Account cutover chat',
            blocks: [
              { type: 'text', text: 'Ready to check the Codex account.' },
            ],
          },
        ],
      });
      seedStoredPipeline({
        userDataDir,
        id: 'e2e-codex-account-cutover',
        name: PIPELINE_NAME,
        yaml: pipelineYaml(PIPELINE_NAME),
      });

      const fixture = createFixture('account-cutover');
      const accountPath = path.join(fixture.runtimeDir, 'account.txt');
      const accountReadFailurePath = path.join(
        fixture.runtimeDir,
        'account-read-failure',
      );
      writeFileSync(accountPath, `${OLD_ACCOUNT}\n`, 'utf8');
      const {
        CANOPY_E2E_CODEX_REPLY: _fixtureReply,
        ...accountAwareFixtureEnv
      } = fixture.env;
      const { electronApp } = await launchCanopy({
        userDataDir,
        env: {
          ...accountAwareFixtureEnv,
          CANOPY_E2E_CODEX_ACCOUNT_PATH: accountPath,
          CANOPY_E2E_CODEX_LOGIN_ACCOUNT: NEW_ACCOUNT,
          CANOPY_E2E_CODEX_LOGIN_RESULT_PATH: path.join(
            fixture.runtimeDir,
            'login-result',
          ),
          CANOPY_E2E_CODEX_ACCOUNT_READ_FAILURE_PATH: accountReadFailurePath,
        },
      });

      try {
        const window = await electronApp.firstWindow();
        const app = new CanopyAppDriver(window);
        await app.waitForShell({ timeout: 30_000 });
        await app.openChatPage();
        await selectChat(app, window);
        await sendAndExpectReply(
          window,
          'Which Codex account started this worker?',
          `Reply from Codex account ${OLD_ACCOUNT}`,
        );

        const pipelineCard = await openWorkspaceAndRun(window, PIPELINE_NAME);
        await expect(pipelineCard).toContainText('running', {
          timeout: 30_000,
        });
        await app.openSettings();
        await app.openSettingsSection('account');
        const codexPanel = window.getByTestId('auth-panel-codex');
        await expect(codexPanel).toBeVisible();
        await codexPanel.getByTestId('auth-panel-codex-connect').click();
        const loginModal = window.getByTestId('auth-login-modal');
        await expect(loginModal).toBeVisible();
        await expect(loginModal).toContainText('work will pause');
        await loginModal.getByTestId('auth-login-cancel').click();
        await expect(loginModal).toBeHidden();
        expect(
          protocolRequests(fixture.logPath).some(
            (request) => request.method === 'account/login/start',
          ),
        ).toBe(false);
        await codexPanel.getByTestId('auth-panel-codex-connect').click();
        await expect(loginModal).toContainText('work will pause');
        expect(readFileSync(accountPath, 'utf8').trim()).toBe(OLD_ACCOUNT);
        await loginModal
          .getByRole('button', { name: 'Pause work and sign in' })
          .click();
        await expect(loginModal).toContainText('Finish signing in');
        if (outcome === 'cancelled-after-commit')
          writeFileSync(accountPath, NEW_ACCOUNT);
        if (outcome === 'cancelled' || outcome === 'cancelled-after-commit')
          await loginModal.getByTestId('auth-login-cancel').click();
        else if (outcome === 'verification-failed') {
          writeFileSync(accountReadFailurePath, 'fail');
          writeFileSync(
            path.join(fixture.runtimeDir, 'login-result'),
            'success',
          );
        } else
          writeFileSync(path.join(fixture.runtimeDir, 'login-result'), outcome);
        const expectedAccount =
          outcome === 'success' ||
          outcome === 'verification-failed' ||
          outcome === 'cancelled-after-commit'
            ? NEW_ACCOUNT
            : OLD_ACCOUNT;
        await expect
          .poll(
            () =>
              existsSync(accountPath)
                ? readFileSync(accountPath, 'utf8').trim()
                : null,
            { timeout: 30_000 },
          )
          .toBe(expectedAccount);
        await expect(loginModal).toBeHidden({ timeout: 60_000 });
        const resume = window.getByTestId('usage-limit-resume-modal');
        await expect(resume).toBeVisible();
        await expect(resume).toContainText(PIPELINE_NAME);
        const executionDir = path.join(userDataDir, 'pipeline-executions');
        const executionPath = readdirSync(executionDir).find((name) =>
          name.endsWith('.json'),
        );
        expect(executionPath).toBeTruthy();
        const readExecution = () =>
          JSON.parse(
            readFileSync(path.join(executionDir, executionPath), 'utf8'),
          );
        expect(readExecution().status).toBe('paused');
        if (outcome === 'success') {
          writeFileSync(fixture.releasePath, 'release');
          await resume.getByTestId('usage-limit-resume-confirm').click();
          await expect(resume).toBeHidden();
          await expect
            .poll(() => readExecution().status, { timeout: 60_000 })
            .toBe('success');
          const resumeQueue = window.getByTestId('resume-queue-modal');
          await expect(
            resumeQueue.getByTestId('resume-queue-status'),
          ).toHaveText('Started');
          await window.keyboard.press('Escape');
          await expect(resumeQueue).toBeHidden();
        } else {
          await resume.getByTestId('usage-limit-resume-cancel').click();
          expect(readExecution().status).toBe('paused');
        }

        await app.closeSettings();
        await app.openChatPage();
        await selectChat(app, window);
        await sendAndExpectReply(
          window,
          'Which Codex account owns the replacement worker?',
          `Reply from Codex account ${expectedAccount}`,
        );
      } finally {
        await closeFixture(electronApp, userDataDir, fixture.runtimeDir);
      }
    });
  }
});

test('offers device-code fallback without a terminal or an empty resume prompt', async () => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'codex-login-device-'),
  );
  seedPreferences(userDataDir);
  const fixture = createFixture('normal');
  const { electronApp } = await launchCanopy({ userDataDir, env: fixture.env });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await app.openSettings();
    await app.openSettingsSection('account');
    await window.getByTestId('auth-panel-codex-connect').click();
    const modal = window.getByTestId('auth-login-modal');
    await expect(modal).toContainText('Finish signing in');
    await expect(window.getByTestId('auth-login-terminal')).toHaveCount(0);
    await modal.getByRole('button', { name: 'Use a device code' }).click();
    await expect(modal.getByTestId('codex-login-device-code')).toHaveText(
      'TEST-1234',
    );
    await modal.getByTestId('auth-login-cancel').click();
    await expect(modal).toBeHidden();
    await expect(window.getByTestId('usage-limit-resume-modal')).toHaveCount(0);
    await window.getByTestId('auth-panel-codex-connect').click();
    await expect(modal).toContainText('Finish signing in');
    await modal.getByTestId('auth-login-cancel').click();
    await expect(modal).toBeHidden();
  } finally {
    await closeFixture(electronApp, userDataDir, fixture.runtimeDir);
  }
});

test('immediate dismissal retires the pending managed sign-in before reopening', async () => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'codex-login-immediate-dismiss-'),
  );
  seedPreferences(userDataDir);
  const fixture = createFixture('normal');
  const holdPath = path.join(fixture.runtimeDir, 'hold-initialize');
  const { electronApp } = await launchCanopy({
    userDataDir,
    env: { ...fixture.env, CANOPY_E2E_CODEX_INITIALIZE_HOLD_PATH: holdPath },
  });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await app.openSettings();
    await app.openSettingsSection('account');
    // Hold the sign-in connection's handshake so the dismissal lands while the
    // sign-in is still pending, however fast the host starts the app-server.
    // Unheld, a slow click lets `account/login/start` go out first.
    writeFileSync(holdPath, 'hold');
    const initializesBefore = protocolRequests(fixture.logPath).filter(
      (request) => request.method === 'initialize',
    ).length;
    await window.getByTestId('auth-panel-codex-connect').click();
    const modal = window.getByTestId('auth-login-modal');
    await expect
      .poll(
        () =>
          protocolRequests(fixture.logPath).filter(
            (request) => request.method === 'initialize',
          ).length,
      )
      .toBeGreaterThan(initializesBefore);
    await modal.getByTestId('auth-login-cancel').click();
    rmSync(holdPath, { force: true });
    await expect(modal).toBeHidden();
    await expect
      .poll(
        () =>
          protocolRequests(fixture.logPath).filter(
            (request) => request.method === 'account/read',
          ).length,
      )
      .toBe(1);
    expect(
      protocolRequests(fixture.logPath).filter(
        (request) => request.method === 'account/login/start',
      ),
    ).toHaveLength(0);

    await window.getByTestId('auth-panel-codex-connect').click();
    await expect(modal).toContainText('Finish signing in');
    await expect
      .poll(
        () =>
          protocolRequests(fixture.logPath).filter(
            (request) => request.method === 'account/login/start',
          ).length,
      )
      .toBe(1);
    await modal.getByTestId('auth-login-cancel').click();
    await expect(modal).toBeHidden();
  } finally {
    await closeFixture(electronApp, userDataDir, fixture.runtimeDir);
  }
});

test('pauses a running chat and resumes it once after cancelled sign-in', async () => {
  test.setTimeout(150_000);
  const authScenarioKey = `codex-active-login-${test.info().workerIndex}`;
  await registerAuthScenario(authScenarioKey, { type: 'apiKey' });
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'codex-login-active-chat-'),
  );
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedPreferences(userDataDir);
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    providerType: 'codex',
    tabs: [
      {
        id: 'active-login-chat',
        title: 'Active login chat',
        blocks: [{ type: 'text', text: 'Ready for sign-in testing.' }],
      },
    ],
  });
  const fixture = createFixture('account-cutover');
  const { electronApp } = await launchCanopy({
    userDataDir,
    env: { ...fixture.env, CANOPY_MOCK_API_KEY: authScenarioKey },
  });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await app.openChatPage();
    await selectChat(app, window);
    const panel = window
      .locator('[data-testid="panel-content-chat"]:visible')
      .first();
    await panel
      .getByRole('textbox')
      .first()
      .fill('Hold this chat for Codex sign-in.');
    await panel.getByRole('button', { name: 'Send message' }).click();
    await expect(
      window.getByText('E2E_CODEX_STREAM_007', { exact: true }).last(),
    ).toBeVisible();
    await app.openSettings();
    await app.openSettingsSection('account');
    await window.getByTestId('auth-panel-codex-connect').click();
    const modal = window.getByTestId('auth-login-modal');
    await expect(modal).toContainText('work will pause');
    await modal.getByTestId('auth-login-submit').click();
    await expect(modal).toContainText('Finish signing in');
    const turnsBeforeResume = conversationRequests(fixture.logPath).filter(
      (request) => request.method === 'turn/start',
    ).length;
    await modal.getByTestId('auth-login-cancel').click();
    const resume = window.getByTestId('usage-limit-resume-modal');
    await expect(resume).toBeVisible();
    await expect(resume).toContainText('Active login chat');
    expect(
      conversationRequests(fixture.logPath).filter(
        (request) => request.method === 'turn/start',
      ),
    ).toHaveLength(turnsBeforeResume);
    writeFileSync(fixture.releasePath, 'release');
    await resume.getByTestId('usage-limit-resume-confirm').click();
    await expect(resume).toBeHidden();
    // One confirmed chat opens directly instead of the queue dialog, behind
    // the Settings page the sign-in started from.
    await expect(window.getByTestId('resume-queue-modal')).toBeHidden();
    await app.closeSettings();
    await expect(
      window.locator('[data-panel-id="panel-chat-active-login-chat"]'),
    ).toBeVisible();
    await expect
      .poll(
        () =>
          conversationRequests(fixture.logPath).filter(
            (request) => request.method === 'turn/start',
          ).length,
      )
      .toBe(turnsBeforeResume + 1);
  } finally {
    await closeFixture(electronApp, userDataDir, fixture.runtimeDir);
    await clearAuthScenario(authScenarioKey);
  }
});

test('pauses a running chat when Codex acknowledges interruption without completing it', async () => {
  test.setTimeout(150_000);
  const authScenarioKey = `codex-active-login-${test.info().workerIndex}`;
  await registerAuthScenario(authScenarioKey, { type: 'apiKey' });
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'codex-login-active-chat-'),
  );
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedPreferences(userDataDir);
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    providerType: 'codex',
    tabs: [
      {
        id: 'active-login-chat',
        title: 'Active login chat',
        blocks: [{ type: 'text', text: 'Ready for sign-in testing.' }],
      },
    ],
  });
  const fixture = createFixture('account-cutover');
  const { electronApp } = await launchCanopy({
    userDataDir,
    env: {
      ...fixture.env,
      CANOPY_MOCK_API_KEY: authScenarioKey,
      CANOPY_E2E_CODEX_OMIT_INTERRUPT_COMPLETION: '1',
    },
  });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await app.openChatPage();
    await selectChat(app, window);
    const panel = window
      .locator('[data-testid="panel-content-chat"]:visible')
      .first();
    await panel
      .getByRole('textbox')
      .first()
      .fill('Hold this chat for Codex sign-in.');
    await panel.getByRole('button', { name: 'Send message' }).click();
    await expect(
      window.getByText('E2E_CODEX_STREAM_007', { exact: true }).last(),
    ).toBeVisible();
    await app.openSettings();
    await app.openSettingsSection('account');
    await window.getByTestId('auth-panel-codex-connect').click();
    const modal = window.getByTestId('auth-login-modal');
    await expect(modal).toContainText('work will pause');
    await modal.getByTestId('auth-login-submit').click();
    await expect(modal).toContainText('Finish signing in', { timeout: 20_000 });
    const turnsBeforeResume = conversationRequests(fixture.logPath).filter(
      (request) => request.method === 'turn/start',
    ).length;
    await modal.getByTestId('auth-login-cancel').click();
    const resume = window.getByTestId('usage-limit-resume-modal');
    await expect(resume).toBeVisible();
    await expect(resume).toContainText('Active login chat');
    expect(
      conversationRequests(fixture.logPath).filter(
        (request) => request.method === 'turn/start',
      ),
    ).toHaveLength(turnsBeforeResume);
    await resume.getByTestId('usage-limit-resume-cancel').click();
  } finally {
    writeFileSync(fixture.releasePath, 'release');
    await closeFixture(electronApp, userDataDir, fixture.runtimeDir);
    await clearAuthScenario(authScenarioKey);
  }
});

test('does not resume a chat re-interrupted by a newer sign-in attempt', async () => {
  test.setTimeout(150_000);
  const authScenarioKey = `codex-stale-resume-${test.info().workerIndex}`;
  await registerAuthScenario(authScenarioKey, { type: 'apiKey' });
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'codex-login-stale-resume-'),
  );
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedPreferences(userDataDir);
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    providerType: 'codex',
    tabs: [
      {
        id: 'stale-resume-chat',
        title: 'Stale resume chat',
        blocks: [{ type: 'text', text: 'Ready for sign-in testing.' }],
      },
    ],
  });
  const fixture = createFixture('account-cutover');
  const { electronApp } = await launchCanopy({
    userDataDir,
    env: { ...fixture.env, CANOPY_MOCK_API_KEY: authScenarioKey },
  });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await app.openChatPage();
    await selectChat(app, window);
    const panel = window
      .locator('[data-testid="panel-content-chat"]:visible')
      .first();
    await panel
      .getByRole('textbox')
      .first()
      .fill('Hold this chat for Codex sign-in.');
    await panel.getByRole('button', { name: 'Send message' }).click();
    await expect(
      window.getByText('E2E_CODEX_STREAM_007', { exact: true }).last(),
    ).toBeVisible();
    await app.openSettings();
    await app.openSettingsSection('account');
    await window.getByTestId('auth-panel-codex-connect').click();
    const login = window.getByTestId('auth-login-modal');
    await login.getByTestId('auth-login-submit').click();
    await expect(login).toContainText('Finish signing in');
    await login.getByTestId('auth-login-cancel').click();
    const resume = window.getByTestId('usage-limit-resume-modal');
    await expect(resume).toContainText('Stale resume chat');
    const turnsBeforeConfirm = conversationRequests(fixture.logPath).filter(
      (request) => request.method === 'turn/start',
    ).length;
    const registryPath = path.join(userDataDir, 'usage-limited-chats.json');
    const registry = JSON.parse(readFileSync(registryPath, 'utf8'));
    registry.entries = registry.entries.map((entry) => ({
      ...entry,
      detectedAt: entry.detectedAt + 1,
      authenticationAttemptId: 'newer-attempt',
    }));
    writeFileSync(registryPath, JSON.stringify(registry, null, 2));

    writeFileSync(fixture.releasePath, 'release');
    await resume.getByTestId('usage-limit-resume-confirm').click();
    await expect(resume).toBeHidden();
    await expect(window.getByTestId('resume-queue-modal')).toBeVisible();
    await expect
      .poll(
        () =>
          conversationRequests(fixture.logPath).filter(
            (request) => request.method === 'turn/start',
          ).length,
        { timeout: 3_000 },
      )
      .toBe(turnsBeforeConfirm);
  } finally {
    await closeFixture(electronApp, userDataDir, fixture.runtimeDir);
    await clearAuthScenario(authScenarioKey);
  }
});

test('cancels a stalled account verification and permits another sign-in', async () => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'codex-verification-cancel-'),
  );
  seedPreferences(userDataDir);
  const fixture = createFixture('normal');
  const holdPath = path.join(fixture.runtimeDir, 'hold-account-read');
  const { electronApp } = await launchCanopy({
    userDataDir,
    env: { ...fixture.env, CANOPY_E2E_CODEX_ACCOUNT_READ_HOLD_PATH: holdPath },
  });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await app.openSettings();
    await app.openSettingsSection('account');
    await window.getByTestId('auth-panel-codex-connect').click();
    const modal = window.getByTestId('auth-login-modal');
    await expect(modal).toContainText('Finish signing in');
    const readsBefore = protocolRequests(fixture.logPath).filter(
      (r) => r.method === 'account/read',
    ).length;
    writeFileSync(holdPath, 'hold');
    await modal.getByTestId('auth-login-cancel').click();
    await expect(modal).toContainText('Verifying your current Codex account');
    await expect
      .poll(
        () =>
          protocolRequests(fixture.logPath).filter(
            (r) => r.method === 'account/read',
          ).length,
      )
      .toBeGreaterThan(readsBefore);
    await modal.getByTestId('auth-login-cancel').click();
    await expect(modal).toBeHidden({ timeout: 10_000 });
    await window.getByTestId('auth-panel-codex-connect').click();
    await expect(modal).toContainText('Finish signing in');
  } finally {
    await closeFixture(electronApp, userDataDir, fixture.runtimeDir);
  }
});
