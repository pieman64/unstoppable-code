import { connectMockCloudAccount } from './seeders/connectMockCloudAccount.mjs';
import { seedWorktreeChat } from './seeders/index.mjs';
import { seedCoworkWorkspace } from './seeders/seedCoworkWorkspace.mjs';
import { openWorkspaceAndRun } from './codexPipelineRuntime.mjs';
import { seedStoredPipeline } from './seeders/seedStoredPipeline.mjs';
import {
  existsSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
} from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { expect, test } from '@playwright/test';
import { launchOpenCodeSelectionFixture } from './fixtures/opencode-selection.mjs';
import { chooseSettingsOption } from './helpers/settingsSelect.mjs';

test('OpenCode release moves setup live from Labs to Accounts and keeps the connection', async () => {
  const f = await launchOpenCodeSelectionFixture({
    env: {
      CANOPY_E2E_CLIENT_FEATURE_FLAGS: JSON.stringify({
        'canopy-desktop-opencode-harness': true,
        'canopy-desktop-opencode-harness-released': false,
      }),
    },
  });
  try {
    const setReleased = async (released) => {
      await f.app.evaluate((_, value) => {
        const flags = JSON.parse(process.env.CANOPY_E2E_CLIENT_FEATURE_FLAGS);
        flags['canopy-desktop-opencode-harness-released'] = value;
        process.env.CANOPY_E2E_CLIENT_FEATURE_FLAGS = JSON.stringify(flags);
      }, released);
      await f.window.evaluate(() => window.api.featureFlags.refreshContext());
    };
    await f.driver.openSettings();
    await f.driver.openSettingsSection('experiments');
    await expect(f.window.getByTestId('opencode-connection')).toBeVisible();

    await setReleased(true);
    await expect(f.window.getByTestId('opencode-connection')).toHaveCount(0);
    await f.driver.openSettingsSection('account');
    // A provider row beside Claude and Codex, named by its label.
    const row = f.window.getByTestId('opencode-connection');
    await expect(row).toContainText('OpenCode');
    await row.getByTestId('opencode-connect').click();
    await expect(row.getByTestId('opencode-connection-status')).toHaveText(
      'OpenCode connected',
    );

    // Turning the release off returns setup to Labs, still connected.
    await setReleased(false);
    await expect(f.window.getByTestId('opencode-connection')).toHaveCount(0);
    await f.driver.openSettingsSection('experiments');
    await expect(f.window.getByTestId('opencode-connection-status')).toHaveText(
      'OpenCode connected',
    );
  } finally {
    await f.close();
  }
});

test('OpenCode managed setup, discovered model, streaming and resume survive reload', async () => {
  const f = await launchOpenCodeSelectionFixture();
  try {
    await f.connect();
    await f.select();
    await f.send('Hello OpenCode');
    await expect(
      f.panel.getByText('OpenCode fixture reply 1.', { exact: true }),
    ).toBeVisible();
    await expect(f.panel.getByTestId('chat-stop-generation')).toBeHidden();
    const before = await f.tab();
    expect(before).toMatchObject({
      providerType: 'opencode',
      model: 'opencode:fixture%2Fmodel',
    });
    expect(before.sdkSessionId).toBeTruthy();
    expect(before.aiCreditsRouting).toBeUndefined();
    await f.restart();
    await f.openChat();
    await expect(
      f.panel.getByText('OpenCode fixture reply 1.', { exact: true }),
    ).toBeVisible();
    await f.send('Continue OpenCode');
    await expect(
      f.panel.getByText('OpenCode fixture reply 2.', { exact: true }),
    ).toBeVisible();
    expect((await f.tab()).sdkSessionId).toBe(before.sdkSessionId);
  } finally {
    await f.close();
  }
});

test('an empty terminal chat can choose OpenCode before its first turn', async () => {
  const f = await launchOpenCodeSelectionFixture({
    seedBeforeLaunch: ({ userDataDir }) =>
      seedWorktreeChat({
        userDataDir,
        workspaceId: 'demo-ts-pnpm-vite',
        worktreeId: 'demo-main',
        providerType: 'claude',
        tabs: [
          {
            id: 'opencode-selection',
            title: 'Empty terminal chat',
            model: 'sonnet',
            executionHarness: 'claude',
            interfaceMode: 'auto',
            sdkSessionId: '12345678-1234-4234-8234-123456789abc',
            claudeTerminal: { turnState: 'idle' },
            messages: [],
          },
        ],
      }),
  });
  try {
    await f.connect();
    await f.openChat();
    expect((await f.tab()).messages).toEqual([]);
    await f.select();
    expect((await f.tab()).sdkSessionId).toBeUndefined();
    await f.send('Hello from an empty terminal chat');
    await expect(
      f.panel.getByText('OpenCode fixture reply 1.', { exact: true }),
    ).toBeVisible();
  } finally {
    await f.close();
  }
});

test('OpenCode plan mode denies writes without an approval prompt', async () => {
  const f = await launchOpenCodeSelectionFixture({ planMode: true });
  try {
    await f.connect();
    await f.select();
    const readOnly = f.panel.getByTestId('chat-input-plan-mode-inline-button');
    await expect(readOnly).toHaveAttribute('aria-pressed', 'true');
    await expect(readOnly).toContainText('Plan');
    await f.send('OPENCODE_WRITE');
    await expect(
      f.panel.getByText('OpenCode write denied.', { exact: true }),
    ).toBeVisible();
    await expect(f.window.getByTestId('tool-approval-card')).toBeHidden();
    expect(existsSync(path.join(f.worktreePath, 'opencode-sentinel.txt'))).toBe(
      false,
    );
    await expect(f.panel.getByTestId('chat-stop-generation')).toBeHidden();
    await readOnly.click();
    await expect(readOnly).toBeHidden();
    expect((await f.tab()).planMode).toBe(false);
    await f.panel.getByTestId('chat-input-plus-button').click();
    await expect(
      f.window.getByTestId('chat-input-schedule-button'),
    ).toBeVisible();
    await f.window.getByTestId('chat-plugins-button').click();
    const plugins = f.window.getByRole('dialog').filter({ hasText: 'Plugins' });
    await expect(plugins).toBeVisible();
    await expect(
      plugins.getByTestId('chat-plugins-deferred-tools-toggle'),
    ).toBeVisible();
    await plugins.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(plugins).toBeHidden();
  } finally {
    await f.close();
  }
});

for (const decision of ['deny', 'allow'])
  test(`OpenCode native write respects ${decision}`, async () => {
    const f = await launchOpenCodeSelectionFixture();
    try {
      await f.connect();
      await f.select();
      await f.send('OPENCODE_WRITE');
      const card = f.window.getByTestId('tool-approval-card');
      await expect(card).toBeVisible();
      const sentinel = path.join(f.worktreePath, 'opencode-sentinel.txt');
      expect(existsSync(sentinel)).toBe(false);
      await card.getByTestId(`tool-approval-${decision}`).click();
      await expect(
        f.panel.getByText(
          `OpenCode write ${decision === 'allow' ? 'allowed' : 'denied'}.`,
          { exact: true },
        ),
      ).toBeVisible();
      expect(existsSync(sentinel)).toBe(decision === 'allow');
    } finally {
      await f.close();
    }
  });

test('OpenCode stop reaps the turn and permits a follow-up', async () => {
  const f = await launchOpenCodeSelectionFixture();
  try {
    await f.connect();
    await f.select();
    await f.send('OPENCODE_HOLD');
    await expect(
      f.panel.getByText('Waiting for Stop.', { exact: true }),
    ).toBeVisible();
    await f.panel.getByTestId('chat-stop-generation').click();
    await expect(f.panel.getByTestId('chat-stop-generation')).toBeHidden();
    await f.send('Continue after Stop');
    await expect(
      f.panel.getByText('OpenCode fixture reply 2.', { exact: true }),
    ).toBeVisible();
  } finally {
    await f.close();
  }
});

test('OpenCode disconnect removes models and refuses new turns', async () => {
  const f = await launchOpenCodeSelectionFixture();
  try {
    await f.connect();
    await f.select();
    await f.send('Hello');
    await expect(
      f.panel.getByText('OpenCode fixture reply 1.', { exact: true }),
    ).toBeVisible();
    await f.driver.openSettings();
    await f.driver.openSettingsSection('experiments');
    await f.window.getByTestId('opencode-connect').click();
    await expect(f.window.getByTestId('opencode-connection-status')).toHaveText(
      'Ready to connect',
    );
    await expect(f.window.getByTestId('opencode-provider-login')).toHaveText(
      'Sign in to a provider',
    );
    expect(
      await f.window.evaluate(() => window.api.opencodeConnection.listModels()),
    ).toEqual([]);
    expect(
      await f.window.evaluate(() => window.api.loadPreferences()),
    ).toMatchObject({ opencodeEnabled: false });
  } finally {
    await f.close();
  }
});

test('OpenCode selected app MCP tools execute through the shared proxy and render their result', async () => {
  const f = await launchOpenCodeSelectionFixture();
  try {
    await f.connect();
    await f.select();
    await f.send('OPENCODE_APP_TOOL');
    await expect(f.panel.getByTestId('tool-approval-card')).toContainText(
      'GetGitPreferences',
    );
    await f.panel
      .getByRole('button', { name: 'Allow once', exact: true })
      .click();
    await expect(f.panel).toContainText('OpenCode app tool completed.');
    await expect(
      f.panel.getByText('OpenCode app tool completed.', { exact: true }),
    ).toBeVisible();
    await expect(f.panel.getByTestId('chat-stop-generation')).toBeHidden();
  } finally {
    await f.close();
  }
});

test('OpenCode delegates to a managed OpenCode child and integrates its result after the completion watch', async () => {
  test.setTimeout(150_000);
  const f = await launchOpenCodeSelectionFixture({
    approvalMode: 'full-access',
  });
  try {
    await f.connect();
    await f.driver.openSettings();
    await f.driver.openSettingsSection('experiments');
    await chooseSettingsOption(
      f.window.getByTestId('settings-managed-delegation-mode'),
      'explicit-only',
    );
    await f.driver.closeSettings();
    await f.select();
    writeFileSync(
      path.join(f.worktreePath, 'delegation-evidence.txt'),
      'OPENCODE_CHILD_EVIDENCE',
    );
    await f.send('Please delegate this review. OPENCODE_DELEGATION_PARENT');
    await expect(
      f.panel.getByText(/Integrated OpenCode child:.*OPENCODE_CHILD_EVIDENCE/),
    ).toBeVisible({ timeout: 90_000 });
    const parentTurn = f.panel
      .locator('[data-chat-turn-group]')
      .filter({ hasText: 'Waiting for delegated evidence.' });
    await expect(parentTurn).toBeVisible();
    const collapsedSteps = parentTurn.getByRole('button', {
      name: /^Agent steps:/,
      expanded: false,
    });
    if (await collapsedSteps.count()) await collapsedSteps.first().click();
    await expect(
      parentTurn.getByTestId('chat-delegated-agent').first(),
    ).toBeVisible();
    await expect(f.panel.getByTestId('chat-stop-generation')).toBeHidden();
    // Completed turns collapse their tool cards behind the Agent steps summary.
    const steps = f.panel.getByRole('button', {
      name: /^Agent steps:/,
      expanded: false,
    });
    if (await steps.count()) await steps.first().click();
    await expect(
      f.panel.getByTestId('chat-delegated-agent').first(),
    ).toBeVisible();
  } finally {
    await f.close();
  }
});

test('OpenCode pipeline discovers a model from its own provider environment', async ({}, testInfo) => {
  test.setTimeout(120_000);
  const f = await launchOpenCodeSelectionFixture();
  try {
    const configuration = path.join(f.userDataDir, 'pipeline-provider-config');
    mkdirSync(path.join(configuration, 'opencode'), { recursive: true });
    writeFileSync(
      path.join(configuration, 'opencode/opencode.json'),
      JSON.stringify({
        provider: {
          pipeline: { models: { only: { name: 'Pipeline-only model' } } },
        },
      }),
    );
    const name = 'E2E OpenCode scoped provider';
    seedStoredPipeline({
      userDataDir: f.userDataDir,
      id: 'opencode-scoped-provider',
      name,
      yaml: [
        `name: ${name}`,
        'on: dispatch',
        'jobs:',
        '  verify:',
        '    env:',
        `      XDG_CONFIG_HOME: ${JSON.stringify(configuration)}`,
        '    steps:',
        '      - id: opencode',
        '        uses: builtin/agent-prompt',
        '        timeout_minutes: 1',
        '        with:',
        '          model: opencode:pipeline%2Fonly',
        '          thinking_level: high',
        '          permission_preset: dangerous_all',
        '          prompt: OPENCODE_WRITE',
        '',
      ].join('\n'),
    });
    await f.restart();
    await f.connect();
    const card = await openWorkspaceAndRun(f.window, name);
    await expect(card).toContainText(/success|failure/, { timeout: 60_000 });
    const dir = path.join(f.userDataDir, 'pipeline-executions');
    const entry = readdirSync(dir).find((file) => file.endsWith('.json'));
    const state = JSON.parse(readFileSync(path.join(dir, entry), 'utf8'));
    await testInfo.attach('pipeline-execution', {
      body: JSON.stringify(state),
      contentType: 'application/json',
    });
    expect(state.jobs.verify.steps.opencode.status).toBe('success');
    expect(existsSync(path.join(f.worktreePath, 'opencode-sentinel.txt'))).toBe(
      true,
    );
    await expect(f.window.getByTestId('tool-approval-card')).toHaveCount(0);
  } finally {
    await f.close();
  }
});

for (const preset of ['read_only', 'dangerous_all'])
  test(`OpenCode desktop pipelines enforce ${preset} without an approval prompt`, async () => {
    test.setTimeout(120_000);
    const f = await launchOpenCodeSelectionFixture();
    try {
      const name = `E2E OpenCode ${preset}`;
      seedStoredPipeline({
        userDataDir: f.userDataDir,
        id: `opencode-${preset}`,
        name,
        yaml: [
          `name: ${name}`,
          'on: dispatch',
          'jobs:',
          '  verify:',
          '    steps:',
          '      - id: opencode',
          '        name: OpenCode write',
          '        uses: builtin/agent-prompt',
          '        timeout_minutes: 1',
          '        with:',
          '          model: opencode:fixture%2Fmodel',
          `          permission_preset: ${preset}`,
          '          prompt: OPENCODE_WRITE',
          '',
        ].join('\n'),
      });
      await f.restart();
      await f.connect();
      const card = await openWorkspaceAndRun(f.window, name);
      await expect(card).toContainText('success', { timeout: 60_000 });
      await expect(f.window.getByTestId('tool-approval-card')).toHaveCount(0);
      const dir = path.join(f.userDataDir, 'pipeline-executions');
      const entry = readdirSync(dir).find((name) => name.endsWith('.json'));
      const state = JSON.parse(readFileSync(path.join(dir, entry), 'utf8'));
      expect(state.jobs.verify.steps.opencode.status).toBe('success');
      expect(
        existsSync(path.join(f.worktreePath, 'opencode-sentinel.txt')),
      ).toBe(preset === 'dangerous_all');
    } finally {
      await f.close();
    }
  });

for (const scenario of ['plain', 'image', 'action-contract'])
  test(
    scenario === 'action-contract'
      ? 'Home OpenCode Cowork advertises only supported chat placements'
      : scenario === 'image'
        ? 'Home delivers a pasted image to OpenCode in Cowork'
        : 'Home sends an OpenCode task into a Cowork Work Entry',
    async ({}, testInfo) => {
      test.setTimeout(120_000);
      const f = await launchOpenCodeSelectionFixture({
        seedBeforeLaunch: ({ userDataDir }) => {
          const file = path.join(userDataDir, 'workspaces/index.json');
          const code = JSON.parse(readFileSync(file, 'utf8'));
          seedCoworkWorkspace({
            userDataDir,
            collapsed: false,
            externalPath: path.join(
              userDataDir,
              'workspaces/demo-ts-pnpm-vite',
            ),
          });
          const cowork = JSON.parse(readFileSync(file, 'utf8'));
          writeFileSync(
            file,
            JSON.stringify({
              ...code,
              workspaces: [...code.workspaces, ...cowork.workspaces],
            }),
          );
        },
      });
      try {
        if (scenario === 'image') {
          await connectMockCloudAccount(
            f.window,
            'csk_opencode_attachments_e2e',
          );
        }
        await f.connect();
        await f.window.getByTestId('sidebar-create-task').click();
        const home = f.window.getByTestId('page-home');
        await home.getByTestId('home-workspace-select').click();
        await f.window
          .getByTestId('home-workspace-option-seeded-cowork')
          .click();
        await home.getByTestId('chat-model-picker').click();
        await f.window.getByTestId('chat-model-harness-tab-opencode').click();
        await f.window
          .getByTestId('chat-model-option-opencode:fixture%2Fmodel')
          .click();
        const editor = home.getByTestId('home-composer-editor');
        if (scenario === 'image') {
          await editor.click();
          await editor.evaluate((element) => {
            const bytes = Uint8Array.from(
              atob(
                'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jk1sAAAAASUVORK5CYII=',
              ),
              (value) => value.charCodeAt(0),
            );
            const clipboardData = new DataTransfer();
            clipboardData.items.add(
              new File([bytes], 'cowork-image.png', { type: 'image/png' }),
            );
            element.dispatchEvent(
              new ClipboardEvent('paste', {
                clipboardData,
                bubbles: true,
                cancelable: true,
              }),
            );
          });
          await expect(
            home.locator('[title="cowork-image.png"]'),
          ).toBeVisible();
        }
        await editor.fill(
          scenario === 'action-contract'
            ? 'OPENCODE_COWORK_ACTION_CONTRACT'
            : scenario === 'image'
              ? 'OPENCODE_COWORK_IMAGE'
              : 'Hello OpenCode in Cowork',
        );
        await home.getByTestId('home-send-button').click();
        await expect(home).toHaveCount(0);
        await expect(
          f.window
            .getByTestId('panel-content-chat')
            .getByText(
              scenario === 'action-contract'
                ? 'OpenCode Cowork offers only current chat placement.'
                : scenario === 'image'
                  ? 'OpenCode received the Cowork image.'
                  : 'OpenCode fixture reply 1.',
              { exact: true },
            ),
        ).toBeVisible({ timeout: 30_000 });
      } catch (error) {
        writeFileSync(
          testInfo.outputPath('cowork-attachment-state.txt'),
          await f.window.locator('body').innerText(),
        );
        throw error;
      } finally {
        await f.close();
      }
    },
  );

test('OpenCode host questions return the selected answer and continue', async () => {
  const f = await launchOpenCodeSelectionFixture();
  try {
    await f.connect();
    await f.select();
    await f.send('OPENCODE_MCP_ASK');
    const approval = f.window.getByTestId('tool-approval-card');
    await expect(approval).toContainText('AskUserQuestion');
    await approval.getByTestId('tool-approval-allow').click();
    // Composer prompts answer a single-choice question on selection.
    const card = f.window.getByTestId('chat-question-prompt');
    await expect(card).toBeVisible();
    await card.getByRole('button', { name: 'Green', exact: true }).click();
    await expect(
      f.panel.getByText('Selected Green.', { exact: true }),
    ).toBeVisible();
    await expect(f.panel.getByTestId('chat-stop-generation')).toBeHidden();
  } finally {
    await f.close();
  }
});

test('OpenCode provider sign-in uses the managed runtime terminal', async () => {
  const f = await launchOpenCodeSelectionFixture();
  try {
    await f.connect();
    await f.driver.openSettings();
    await f.driver.openSettingsSection('experiments');
    const providerAction = f.window.getByTestId('opencode-provider-login');
    await expect(providerAction).toHaveText('Manage providers');
    const actionBounds = await providerAction.boundingBox();
    const connectionBounds = await f.window
      .getByTestId('opencode-connect')
      .boundingBox();
    expect(actionBounds).not.toBeNull();
    expect(connectionBounds).not.toBeNull();
    expect(Math.abs(actionBounds.y - connectionBounds.y)).toBeLessThan(1);
    expect(actionBounds.height).toBe(connectionBounds.height);
    await providerAction.click();
    await expect(f.window.getByTestId('auth-login-status')).toContainText(
      'Choose a provider',
    );
    await expect(f.window.locator('.xterm')).toContainText(
      'Press Enter to finish.',
    );
    const terminal = f.window.getByTestId('auth-login-terminal');
    await terminal.click();
    await f.window.keyboard.type('continue');
    await expect(terminal).toContainText('continue');
    await f.window.keyboard.press('Enter');
    await expect(f.window.locator('.xterm')).toBeHidden();
    await expect(providerAction).toHaveText('Manage providers');
  } finally {
    await f.close();
  }
});

for (const mode of ['corrupt', 'slow'])
  test(`OpenCode setup recovers after ${mode === 'slow' ? 'cancellation' : 'a corrupt download'}`, async () => {
    const f = await launchOpenCodeSelectionFixture();
    try {
      f.managed.state.mode = mode;
      await f.driver.openSettings();
      await f.driver.openSettingsSection('experiments');
      await f.window.getByTestId('opencode-connect').click();
      if (mode === 'slow') {
        await expect(
          f.window.getByTestId('opencode-connection-status'),
        ).toHaveText(/Downloading/);
        await f.window.getByTestId('opencode-cancel').click();
      }
      await expect(
        f.window.getByTestId('opencode-connection-error'),
      ).toBeVisible();
      await expect(f.window.getByTestId('opencode-connect')).toBeEnabled();
      expect(
        await f.window.evaluate(() => window.api.opencodeConnection.status()),
      ).toMatchObject({ enabled: false, installed: false });
      f.managed.state.mode = 'normal';
      await f.window.getByTestId('opencode-connect').click();
      await expect(
        f.window.getByTestId('opencode-connection-status'),
      ).toHaveText('OpenCode connected');
    } finally {
      await f.close();
    }
  });

test('App Advisor uses OpenCode and its app tools through shared approval', async () => {
  const f = await launchOpenCodeSelectionFixture();
  try {
    await f.connect();
    const advisor = await f.driver.openAppAdvisorWindow(f.app);
    await advisor.setViewportSize({ width: 1200, height: 800 });
    const composer = advisor.getByRole('textbox').first();
    await expect(composer).toBeVisible();
    await advisor
      .getByTestId('chat-model-picker')
      .filter({ visible: true })
      .first()
      .click();
    await advisor.getByTestId('chat-model-harness-tab-opencode').click();
    await advisor
      .getByTestId('chat-model-option-opencode:fixture%2Fmodel')
      .click();
    await advisor
      .getByTestId('approval-mode-picker')
      .filter({ visible: true })
      .first()
      .click();
    await advisor.getByTestId('approval-mode-option-ask').click();
    await composer.fill('OPENCODE_ADVISOR');
    await advisor
      .getByRole('button', { name: 'Send message', exact: true })
      .click();
    const card = advisor.getByTestId('tool-approval-card');
    await expect(card).toContainText('OpenCode wants to use GetCurrentUiState');
    await card.getByTestId('tool-approval-allow').click();
    await expect(
      advisor.getByText('OpenCode Advisor inspected the app.', { exact: true }),
    ).toBeVisible();
    await expect(card).toHaveCount(0);
  } finally {
    await f.close();
  }
});

test('OpenCode rollout revokes a live turn, hides setup and models, and preserves connection and history', async () => {
  const f = await launchOpenCodeSelectionFixture();
  try {
    await f.connect();
    await f.select();
    await f.send('Hello before rollout change');
    await expect(
      f.panel.getByText('OpenCode fixture reply 1.', { exact: true }),
    ).toBeVisible();
    await expect(f.panel.getByTestId('chat-stop-generation')).toBeHidden();
    await f.send('OPENCODE_HOLD');
    await expect(
      f.panel.getByText('Waiting for Stop.', { exact: true }),
    ).toBeVisible();
    await f.app.evaluate(() => {
      const values = JSON.parse(
        process.env.CANOPY_E2E_CLIENT_FEATURE_FLAGS ?? '{}',
      );
      values['canopy-desktop-opencode-harness'] = false;
      process.env.CANOPY_E2E_CLIENT_FEATURE_FLAGS = JSON.stringify(values);
    });
    await f.window.evaluate(() => window.api.featureFlags.refreshContext());
    await expect(f.panel.getByTestId('chat-stop-generation')).toBeHidden();
    await expect(
      f.panel.getByText('OpenCode fixture reply 1.', { exact: true }),
    ).toBeVisible();
    expect(
      (await f.window.evaluate(() => window.api.loadPreferences()))
        .opencodeEnabled,
    ).toBe(true);
    expect(
      await f.window.evaluate(() => window.api.opencodeConnection.listModels()),
    ).toEqual([]);
    expect(
      (await f.window.evaluate(() => window.api.opencodeConnection.status()))
        .enabled,
    ).toBe(false);
    await f.panel.getByTestId('chat-model-picker').click();
    await expect(
      f.window.getByTestId('chat-model-harness-tab-opencode'),
    ).toHaveCount(0);
    await f.window.keyboard.press('Escape');
    await f.driver.openSettings();
    await f.driver.openSettingsSection('experiments');
    await expect(f.window.getByTestId('opencode-connection')).toHaveCount(0);
    await f.app.evaluate(() => {
      const values = JSON.parse(
        process.env.CANOPY_E2E_CLIENT_FEATURE_FLAGS ?? '{}',
      );
      values['canopy-desktop-opencode-harness'] = true;
      process.env.CANOPY_E2E_CLIENT_FEATURE_FLAGS = JSON.stringify(values);
    });
    await f.window.evaluate(() => window.api.featureFlags.refreshContext());
    await expect(f.window.getByTestId('opencode-connection-status')).toHaveText(
      'OpenCode connected',
    );
    await f.driver.closeSettings();
    await f.select();
    await f.send('Continue after rollout');
    await expect(
      f.panel.getByText('OpenCode fixture reply 3.', { exact: true }),
    ).toBeVisible();
  } finally {
    await f.close();
  }
});

test('OpenCode refuses a mismatched thinking acknowledgement before running tools', async () => {
  const f = await launchOpenCodeSelectionFixture({
    approvalMode: 'full-access',
  });
  try {
    await f.connect();
    await f.select();
    const effort = f.panel.getByTestId('chat-input-thinking-level-button');
    await expect(effort).toBeVisible();
    if ((await effort.getAttribute('data-thinking-level')) !== 'high')
      await effort.click();
    await expect(effort).toHaveAttribute('data-thinking-level', 'high');
    writeFileSync(path.join(f.worktreePath, '.fixture-effort-mismatch'), '1');
    await f.send('OPENCODE_WRITE');
    await expect(
      f.panel.getByText(
        'OpenCode could not apply this thinking level. Choose another level and try again.',
        { exact: false },
      ),
    ).toBeVisible();
    expect(existsSync(path.join(f.worktreePath, 'opencode-sentinel.txt'))).toBe(
      false,
    );
    await expect(f.panel.getByTestId('chat-stop-generation')).toBeHidden();
  } finally {
    await f.close();
  }
});

test('OpenCode announces lost context and keeps the chat usable after recovery', async () => {
  const f = await launchOpenCodeSelectionFixture();
  try {
    await f.connect();
    await f.select();
    await f.send('Hello');
    await expect(
      f.panel.getByText('OpenCode fixture reply 1.', { exact: true }),
    ).toBeVisible();
    await expect(f.panel.getByTestId('chat-stop-generation')).toBeHidden();
    const before = await f.tab();
    writeFileSync(path.join(f.worktreePath, '.fixture-session-missing'), '1');
    await f.restart();
    await f.openChat();
    await f.send('Continue');
    await expect(
      f.panel.getByText(
        'Started a new OpenCode session because the previous session is unavailable. Earlier messages remain in this chat, but OpenCode no longer has their context.',
        { exact: true },
      ),
    ).toBeVisible();
    await expect(
      f.panel.getByText('OpenCode fixture reply 2.', { exact: true }),
    ).toBeVisible();
    expect((await f.tab()).sdkSessionId).not.toBe(before.sdkSessionId);
  } finally {
    await f.close();
  }
});

test('OpenCode announces an effective provider file change when resuming a chat', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'opencode-provider-change-'));
  mkdirSync(path.join(root, 'opencode'));
  const endpoint = path.join(root, 'opencode', 'endpoint.txt');
  writeFileSync(endpoint, 'https://first.invalid');
  writeFileSync(
    path.join(root, 'opencode', 'opencode.json'),
    JSON.stringify({
      provider: { fixture: { options: { baseURL: '{file:./endpoint.txt}' } } },
    }),
  );
  let f;
  try {
    f = await launchOpenCodeSelectionFixture({
      env: { XDG_CONFIG_HOME: root },
    });
    await f.connect();
    await f.select();
    await f.send('Hello before provider change');
    await expect(
      f.panel.getByText('OpenCode fixture reply 1.', { exact: true }),
    ).toBeVisible();
    await expect(f.panel.getByTestId('chat-stop-generation')).toBeHidden();
    const before = await f.tab();
    writeFileSync(endpoint, 'https://second.invalid');
    await f.send('Continue after provider change');
    await expect(
      f.panel.getByText('OpenCode fixture reply 2.', { exact: true }),
    ).toBeVisible();
    await expect(f.panel).toContainText('OpenCode capabilities changed.');
    expect((await f.tab()).sdkSessionId).toBe(before.sdkSessionId);
  } finally {
    await f?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('OpenCode desktop pipeline receives its selected skill', async ({}, testInfo) => {
  test.setTimeout(120_000);
  const f = await launchOpenCodeSelectionFixture();
  try {
    const skill = path.join(
      f.userDataDir,
      'skills',
      'custom:app',
      'pipeline-review',
    );
    mkdirSync(skill, { recursive: true });
    writeFileSync(
      path.join(skill, 'SKILL.md'),
      '---\nname: pipeline-review\ndescription: Pipeline fixture\n---\nOPENCODE_PIPELINE_SKILL_SENTINEL\n',
    );
    writeFileSync(
      path.join(f.userDataDir, 'pipeline-plugin-preferences.json'),
      JSON.stringify({
        version: 2,
        entries: {
          'stored:user:opencode-selected': {
            plugin_collections: {
              selected: {
                extraSelections: {
                  collectionIds: [],
                  pluginRefs: [],
                  skillRefs: [
                    { sourceId: 'custom:app', skillName: 'pipeline-review' },
                  ],
                },
              },
            },
          },
        },
      }),
    );
    const name = 'E2E OpenCode selected skill';
    seedStoredPipeline({
      userDataDir: f.userDataDir,
      id: 'opencode-selected',
      name,
      yaml: [
        `name: ${name}`,
        'on: dispatch',
        'plugin_collections:',
        '  - id: selected',
        '    name: Selected skill',
        '    defaults: []',
        'jobs:',
        '  verify:',
        '    steps:',
        '      - id: opencode',
        '        uses: builtin/agent-prompt',
        '        timeout_minutes: 1',
        '        with:',
        '          model: opencode:fixture%2Fmodel',
        '          permission_preset: read_only',
        '          plugin_collection_id: selected',
        '          prompt: OPENCODE_SELECTED_SKILL',
        '',
      ].join('\n'),
    });
    await f.restart();
    await f.connect();
    const card = await openWorkspaceAndRun(f.window, name);
    await expect(card).toContainText(/success|failure/, { timeout: 60_000 });
    const dir = path.join(f.userDataDir, 'pipeline-executions');
    const entry = readdirSync(dir).find((file) => file.endsWith('.json'));
    const state = JSON.parse(readFileSync(path.join(dir, entry), 'utf8'));
    await testInfo.attach('pipeline-execution', {
      body: JSON.stringify(state),
      contentType: 'application/json',
    });
    expect(state.jobs.verify.steps.opencode.status).toBe('success');
  } finally {
    await f.close();
  }
});

test('OpenCode worktree tools expose Code Graph through the authenticated route', async () => {
  const f = await launchOpenCodeSelectionFixture({
    approvalMode: 'full-access',
  });
  try {
    await f.connect();
    await f.select();
    await f.send('OPENCODE_CODE_GRAPH');
    await expect(
      f.panel.getByText('OpenCode inspected the code graph.', { exact: true }),
    ).toBeVisible();
    await expect(f.panel.getByTestId('chat-stop-generation')).toBeHidden();
  } finally {
    await f.close();
  }
});

for (const supported of [true, false])
  test(`OpenCode attachment delivery honors ACP support (${supported})`, async () => {
    const f = await launchOpenCodeSelectionFixture({
      env: {
        OPENCODE_FIXTURE_PROMPT_CONTENT: supported ? 'enabled' : 'disabled',
      },
    });
    try {
      await f.connect();
      await f.select();
      const dir = path.join(
        f.userDataDir,
        'workspaces',
        f.target.projectId,
        'attachments',
        f.target.worktreeId,
      );
      mkdirSync(dir, { recursive: true });
      const photo = path.join(dir, 'attachment.png');
      const document = path.join(dir, 'attachment.txt');
      writeFileSync(
        photo,
        Buffer.from(
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jk1sAAAAASUVORK5CYII=',
          'base64',
        ),
      );
      writeFileSync(document, 'Attachment content sentinel.');
      await f.window.evaluate(
        (request) => window.api.chat.sendMessage(request),
        {
          ...f.target,
          model: 'opencode:fixture%2Fmodel',
          userMessageId: 'opencode-attachments',
          text: 'OPENCODE_ATTACHMENTS',
          attachmentPaths: [photo, document],
        },
      );
      await expect(f.panel).toContainText(
        supported
          ? 'OpenCode received the image and document contents.'
          : 'OpenCode does not support these attachments.',
      );
      expect(
        existsSync(path.join(f.worktreePath, '.opencode-content-prompted')),
      ).toBe(supported);
    } finally {
      await f.close();
    }
  });

test('OpenCode unknown updates fail explicitly without exposing payloads', async () => {
  const f = await launchOpenCodeSelectionFixture();
  try {
    await f.connect();
    await f.select();
    await f.send('OPENCODE_UNKNOWN_UPDATE');
    await expect(f.panel).toContainText(
      'Unsupported or invalid ACP session update',
    );
    await expect(f.panel.getByTestId('chat-stop-generation')).toBeHidden();
    await expect(f.panel).not.toContainText('PRIVATE_VENDOR_PAYLOAD');
    await f.send('Retry normally');
    await expect(f.panel).toContainText('OpenCode fixture reply 2.');
  } finally {
    await f.close();
  }
});

test('OpenCode ignored updates persist bounded payload-free diagnostics', async () => {
  const f = await launchOpenCodeSelectionFixture();
  try {
    await f.connect();
    await f.select();
    await f.send('OPENCODE_IGNORED_UPDATES');
    await expect(f.panel).toContainText('OpenCode fixture reply 1.');
    const directory = path.join(
      f.userDataDir,
      'agent-observability',
      'diagnostics',
      'session-events',
    );
    let record;
    await expect
      .poll(() => {
        if (!existsSync(directory)) return false;
        for (const name of readdirSync(directory)) {
          if (!name.endsWith('.jsonl')) continue;
          for (const line of readFileSync(
            path.join(directory, name),
            'utf8',
          ).split('\n')) {
            if (!line.includes('opencode_ignored_updates')) continue;
            const candidate = JSON.parse(line);
            if (
              candidate.projectId === f.target.projectId &&
              candidate.chatId === f.target.chatId
            )
              record = candidate;
          }
        }
        return !!record;
      })
      .toBe(true);
    expect(record.opencodeUpdates).toEqual({
      ignoredUpdates: { available_commands_update: 80 },
      ignoredContent: {},
    });
    expect(JSON.stringify(record)).not.toContain('PRIVATE_');
  } finally {
    await f.close();
  }
});
