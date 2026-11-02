import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { seedCoworkWorkspace } from './seeders/seedCoworkWorkspace.mjs';
import { launchOpenCodeSelectionFixture } from './fixtures/opencode-selection.mjs';

for (const kind of ['fork', 'branch']) {
  test(`OpenCode ${kind} resumes a distinct native session with hidden context`, async ({}, testInfo) => {
    test.setTimeout(180_000);
    let setupGate;
    const f = await launchOpenCodeSelectionFixture({
      approvalMode: 'full-access',
      env: { OPENCODE_FIXTURE_NATIVE_FORK: '1' },
      seedBeforeLaunch({ userDataDir }) {
        if (kind !== 'branch') return;
        setupGate = path.join(userDataDir, 'fork-setup');
        const scriptFile = path.join(userDataDir, 'fork-setup.mjs');
        writeFileSync(
          scriptFile,
          `import { existsSync, writeFileSync } from 'node:fs';
const gate = process.argv[2];
writeFileSync(gate + '-started', 'started');
const deadline = setTimeout(() => {
  writeFileSync(gate + '-timed-out', 'timed out');
  process.exit(1);
}, 90000);
const interval = setInterval(() => {
  if (!existsSync(gate + '-release')) return;
  writeFileSync(gate + '-finished', 'finished');
  clearTimeout(deadline);
  clearInterval(interval);
}, 20);
`,
        );
        const workspaceFile = path.join(
          userDataDir,
          'workspaces',
          'demo-ts-pnpm-vite',
          'workspace.json',
        );
        const workspace = JSON.parse(readFileSync(workspaceFile, 'utf8'));
        const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";
        // Hold the user setup script after Git setup is ready. Chats may start
        // during this phase; queueForSetup only waits for Git setup.
        workspace.scripts.setup = [process.execPath, scriptFile, setupGate]
          .map(quote)
          .join(' ');
        writeFileSync(workspaceFile, JSON.stringify(workspace));
      },
    });
    try {
      await f.connect();
      await f.select();
      await f.send(
        kind === 'fork'
          ? 'OPENCODE_NATIVE_FORK: start an independent child.'
          : 'OPENCODE_NATIVE_BRANCH: start an independent child branch.',
      );
      const receiptFile = path.join(
        f.worktreePath,
        '.opencode-native-fork-result',
      );
      const errorFile = path.join(
        f.worktreePath,
        '.opencode-native-fixture-error',
      );
      await expect
        .poll(() => existsSync(receiptFile) || existsSync(errorFile), {
          timeout: 90_000,
        })
        .toBe(true);
      if (existsSync(errorFile))
        throw new Error(readFileSync(errorFile, 'utf8'));
      const receipt = JSON.parse(readFileSync(receiptFile, 'utf8'));
      expect(receipt.ok).toBe(true);
      expect(receipt.independent).toBe(true);
      expect(receipt.chatId).not.toBe(f.target.chatId);
      expect(receipt.worktreeId === f.target.worktreeId).toBe(kind === 'fork');
      const childTarget = {
        ...f.target,
        chatId: receipt.chatId,
        worktreeId: receipt.worktreeId,
      };
      const child = async () =>
        (
          await f.window.evaluate(async (target) => {
            const file = await window.api.chat.loadTabs(target);
            const transcript = await window.api.chat.getTranscriptPage(target);
            return {
              ...file,
              tabs: file.tabs.map((tab) =>
                tab.id === target.chatId
                  ? { ...tab, messages: transcript.messages }
                  : tab,
              ),
            };
          }, childTarget)
        ).tabs.find((tab) => tab.id === childTarget.chatId);
      if (setupGate) {
        await expect.poll(() => existsSync(setupGate + '-started')).toBe(true);
      }
      await expect
        .poll(async () => JSON.stringify((await child())?.messages), {
          timeout: 60_000,
        })
        .toContain('OpenCode child retained native-only context.');
      const copied = await child();
      if (setupGate) {
        expect(existsSync(setupGate + '-timed-out')).toBe(false);
        expect(existsSync(setupGate + '-finished')).toBe(false);
        // While setup is held, the loaded child chat shows its transcript
        // and no setup annotation (CAN-4981).
        const childHost = f.window.locator(
          `[data-panel-content-host="panel-chat-${receipt.chatId}"]`,
        );
        await expect(
          childHost
            .getByText('OpenCode child retained native-only context.', {
              exact: false,
            })
            .first(),
        ).toBeVisible();
        await expect(
          childHost.getByText('Chat initiated before project setup', {
            exact: false,
          }),
        ).toHaveCount(0);
        writeFileSync(setupGate + '-release', 'continue');
        await expect.poll(() => existsSync(setupGate + '-finished')).toBe(true);
      }
      expect(copied.sdkSessionId).toBeTruthy();
      expect(copied.forkedFrom?.modelContext).toBeUndefined();
      expect(copied.sdkSessionId).not.toBe(receipt.sourceSessionId);
      expect((await f.tab()).sdkSessionId).toBe(receipt.sourceSessionId);
      expect(JSON.stringify(copied.messages)).not.toContain(
        'NATIVE_FORK_ONLY_CONTEXT',
      );
      await f.restart();
      expect((await child()).sdkSessionId).toBe(copied.sdkSessionId);
      expect((await f.tab()).sdkSessionId).toBe(receipt.sourceSessionId);
    } catch (error) {
      writeFileSync(
        testInfo.outputPath(`electron-${kind}-failure.json`),
        JSON.stringify(
          {
            tab: await f.tab(),
            page: await f.window.locator('body').innerText(),
          },
          null,
          2,
        ),
      );
      throw error;
    } finally {
      await f.close();
    }
  });
}

for (const surface of ['Cowork', 'App Advisor']) {
  test(`OpenCode preserves native context in an independent fork from ${surface}`, async () => {
    test.setTimeout(120_000);
    let reportFile;
    const env = { OPENCODE_FIXTURE_NATIVE_FORK: '1' };
    const f = await launchOpenCodeSelectionFixture({
      env,
      seedBeforeLaunch({ userDataDir }) {
        reportFile = path.join(userDataDir, 'native-child-proof.json');
        env.OPENCODE_FIXTURE_NATIVE_FORK_REPORT = reportFile;
        if (surface === 'Cowork')
          seedCoworkWorkspace({
            userDataDir,
            mergeIndex: true,
            collapsed: false,
            externalPath: path.join(
              userDataDir,
              'workspaces/demo-ts-pnpm-vite',
            ),
          });
      },
    });
    try {
      await f.connect();
      let win = f.window;
      let composer;
      let controls;
      let send;
      if (surface === 'Cowork') {
        await win.getByTestId('sidebar-create-task').click();
        const home = win.getByTestId('page-home');
        await home.getByTestId('home-workspace-select').click();
        await win.getByTestId('home-workspace-option-seeded-cowork').click();
        controls = home;
        composer = home.getByTestId('home-composer-editor');
        send = home.getByTestId('home-send-button');
      } else {
        win = await f.driver.openAppAdvisorWindow(f.app);
        await win.setViewportSize({ width: 1200, height: 800 });
        controls = win;
        composer = win.getByRole('textbox').first();
        send = win.getByRole('button', { name: 'Send message', exact: true });
      }
      await controls
        .getByTestId('chat-model-picker')
        .filter({ visible: true })
        .first()
        .click();
      await win.getByTestId('chat-model-harness-tab-opencode').click();
      await win
        .getByTestId('chat-model-option-opencode:fixture%2Fmodel')
        .click();
      await controls
        .getByTestId('approval-mode-picker')
        .filter({ visible: true })
        .first()
        .click();
      await win.getByTestId('approval-mode-option-full-access').click();
      await composer.fill(
        'OPENCODE_NATIVE_FORK: start a separate chat using native context.',
      );
      await send.click();
      await expect
        .poll(() => existsSync(reportFile), { timeout: 60_000 })
        .toBe(true);
      expect(JSON.parse(readFileSync(reportFile, 'utf8'))).toMatchObject({
        hiddenContextPreserved: true,
      });
    } finally {
      await f.close();
    }
  });
}

test('OpenCode native fork does not inherit its source plan review', async () => {
  test.setTimeout(180_000);
  const f = await launchOpenCodeSelectionFixture({
    planMode: true,
    approvalMode: 'full-access',
    env: { OPENCODE_FIXTURE_NATIVE_FORK: '1', OPENCODE_FIXTURE_PLAN: '1' },
  });
  try {
    await f.connect();
    await f.select();
    await f.send('OPENCODE_PROPOSE_PLAN');
    await expect(f.panel.getByTestId('chat-plan-approval')).toBeVisible();
    const source = await f.tab();
    expect(source.trackedPlanReviewStatus).toBe('pending');
    // Dismiss the proposal and leave plan mode before starting another task.
    await f.panel.getByTestId('chat-plan-approval-close').click();
    await f.panel.getByTestId('chat-input-plus-button').click();
    await f.window.getByTestId('chat-input-plan-mode-button').click();
    await expect.poll(async () => (await f.tab()).planMode).toBe(false);
    expect((await f.tab()).trackedPlanReviewStatus).toBe('dismissed');
    await f.send('OPENCODE_NATIVE_FORK: start an independent child.');
    const receiptFile = path.join(
      f.worktreePath,
      '.opencode-native-fork-result',
    );
    const errorFile = path.join(
      f.worktreePath,
      '.opencode-native-fixture-error',
    );
    await expect
      .poll(() => existsSync(receiptFile) || existsSync(errorFile), {
        timeout: 90_000,
      })
      .toBe(true);
    if (existsSync(errorFile)) throw new Error(readFileSync(errorFile, 'utf8'));
    const receipt = JSON.parse(readFileSync(receiptFile, 'utf8'));
    expect(receipt.ok).toBe(true);
    const childTarget = { ...f.target, chatId: receipt.chatId };
    await f.window
      .getByTestId(`panel-tab-panel-chat-${receipt.chatId}`)
      .click();
    const childPanel = f.window
      .getByTestId('panel-content-chat')
      .filter({ visible: true })
      .first();
    await expect(childPanel).toContainText(
      'OpenCode child retained native-only context.',
      { timeout: 60_000 },
    );
    await expect(childPanel.getByTestId('chat-plan-approval')).toHaveCount(0);
    const tabs = await f.window.evaluate(
      (target) => window.api.chat.loadTabs(target),
      childTarget,
    );
    const copied = tabs.tabs.find((tab) => tab.id === receipt.chatId);
    expect(copied.trackedPlanId).toBeUndefined();
    expect(copied.pendingPlanExitRequestId).toBeUndefined();
    const parent = tabs.tabs.find((tab) => tab.id === f.target.chatId);
    expect(parent.trackedPlanId).toBe(source.trackedPlanId);
    expect(parent.trackedPlanReviewStatus).toBe('dismissed');
  } finally {
    await f.close();
  }
});
