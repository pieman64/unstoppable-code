import { createHash, randomUUID } from 'node:crypto';
import { seedCoworkWorkspace } from './seeders/seedCoworkWorkspace.mjs';
import { openWorkspaceAndRun } from './codexPipelineRuntime.mjs';
import { seedStoredPipeline } from './seeders/seedStoredPipeline.mjs';
import { seedMcpServers } from './seeders/index.mjs';
import {
  chmodSync,
  existsSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  rmSync,
  mkdirSync,
  utimesSync,
} from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { launchCanopy, closeCanopy } from './launchCanopy.mjs';
import { launchCopilotSelectionFixture } from './fixtures/copilot-selection.mjs';
import {
  copilotProcessAlive,
  copilotReceiptEvidence,
  priorCopilotReceipts,
  readCopilotReceipts,
} from './fixtures/copilot-receipts.mjs';
import { chooseSettingsOption } from './helpers/settingsSelect.mjs';

test('Copilot rollout defaults off and rejects direct setup', async () => {
  const launched = await launchCanopy();
  try {
    const window = await launched.electronApp.firstWindow();
    const driver = new CanopyAppDriver(window);
    await driver.waitForShell();
    await driver.openSettings();
    await driver.openSettingsSection('experiments');
    await expect(window.getByTestId('copilot-connection')).toHaveCount(0);
    expect(
      await window.evaluate(async () => {
        try {
          await window.api.copilotConnection.connect();
          return 'allowed';
        } catch (error) {
          return String(error);
        }
      }),
    ).toContain('GitHub Copilot is unavailable');
  } finally {
    await closeCanopy(launched.electronApp, launched.userDataDir);
  }
});

test('Copilot release moves setup live from Labs to Accounts and keeps the account', async () => {
  const f = await launchCopilotSelectionFixture();
  try {
    const setReleased = async (released) => {
      await f.app.evaluate((_, value) => {
        const flags = JSON.parse(process.env.CANOPY_E2E_CLIENT_FEATURE_FLAGS);
        flags['canopy-desktop-copilot-harness-released'] = value;
        process.env.CANOPY_E2E_CLIENT_FEATURE_FLAGS = JSON.stringify(flags);
      }, released);
      await f.window.evaluate(() => window.api.featureFlags.refreshContext());
    };
    await f.driver.openSettings();
    await f.driver.openSettingsSection('experiments');
    await expect(f.window.getByTestId('copilot-connection')).toBeVisible();

    await setReleased(true);
    await expect(f.window.getByTestId('copilot-connection')).toHaveCount(0);
    await f.driver.openSettingsSection('account');
    // A provider row beside Claude and Codex: name and status dot in the
    // label, the account actions on its trailing edge.
    const row = f.window.getByTestId('copilot-connection');
    await expect(row).toContainText('GitHub Copilot');
    await expect(row.getByTestId('copilot-connection-status-dot')).toHaveClass(
      /bg-destructive/,
    );
    await row.getByTestId('copilot-connect').click();
    await f.approveDeviceCode();
    await expect(row.getByTestId('copilot-connection-status-dot')).toHaveClass(
      /bg-success/,
    );
    await expect(row.getByTestId('copilot-connection-account')).toHaveText(
      'Signed in as copilot-fixture',
    );

    // Turning the release off returns setup to Labs without signing out.
    await setReleased(false);
    await expect(f.window.getByTestId('copilot-connection')).toHaveCount(0);
    await f.driver.openSettingsSection('experiments');
    await expect(f.window.getByTestId('copilot-connection-account')).toHaveText(
      'Signed in as copilot-fixture',
    );
  } finally {
    await f.close();
  }
});

test('Copilot managed setup, discovered model, burst streaming and resume survive reload', async () => {
  const f = await launchCopilotSelectionFixture();
  try {
    await f.connect();
    await f.select();
    await f.send('Hello Copilot');
    await expect(
      f.panel.getByText('Copilot fixture reply 1.', { exact: true }),
    ).toBeVisible();
    await expect(f.panel.getByTestId('chat-stop-generation')).toBeHidden();
    await f.panel.getByTestId('usage-indicator').click();
    const usage = f.window.getByTestId('usage-indicator-popover');
    // The account follows the plan name, in brackets.
    await expect(
      usage.getByText('(copilot-fixture)', { exact: true }),
    ).toBeVisible();
    await expect(
      usage.getByText('Premium requests', { exact: true }),
    ).toBeVisible();
    await expect(usage).toContainText('25%');
    await f.panel.getByTestId('usage-indicator').click();
    const before = await f.tab();
    expect(before).toMatchObject({
      providerType: 'copilot',
      model: 'copilot:fixture-model',
    });
    expect(before.sdkSessionId).toBeTruthy();
    expect(before.aiCreditsRouting).toBeUndefined();
    await f.restart();
    await f.openChat();
    await expect(
      f.panel.getByText('Copilot fixture reply 1.', { exact: true }),
    ).toBeVisible();
    await f.send('Continue Copilot');
    await expect(
      f.panel.getByText('Copilot fixture reply 2.', { exact: true }),
    ).toBeVisible();
    expect((await f.tab()).sdkSessionId).toBe(before.sdkSessionId);
  } finally {
    await f.close();
  }
});

for (const decision of ['deny', 'allow'])
  test(`Copilot native write respects ${decision}`, async () => {
    const f = await launchCopilotSelectionFixture();
    try {
      await f.connect();
      await f.select();
      await f.send('COPILOT_WRITE');
      const card = f.window.getByTestId('tool-approval-card');
      await expect(card).toBeVisible();
      const sentinel = path.join(f.worktreePath, 'copilot-sentinel.txt');
      expect(existsSync(sentinel)).toBe(false);
      await card.getByTestId(`tool-approval-${decision}`).click();
      await expect(
        f.panel.getByText(
          `Copilot write ${decision === 'allow' ? 'allowed' : 'denied'}.`,
          { exact: true },
        ),
      ).toBeVisible();
      expect(existsSync(sentinel)).toBe(decision === 'allow');
    } finally {
      await f.close();
    }
  });

test('Copilot continues when a selected MCP server cannot connect and names it', async () => {
  const now = new Date().toISOString();
  const f = await launchCopilotSelectionFixture({
    seedBeforeLaunch: ({ userDataDir }) =>
      seedMcpServers({
        userDataDir,
        servers: [
          {
            definition: {
              id: 'unreachable',
              name: 'Unreachable',
              description: 'A server whose process exits at once',
              type: 'command',
              command: '/usr/bin/false',
              args: [],
              createdAt: now,
              updatedAt: now,
            },
            configs: [
              {
                id: 'unreachable-default',
                name: 'Default',
                description: '',
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
      }),
    pluginSelections: {
      collectionIds: [],
      skillRefs: [],
      pluginRefs: [],
      mcpServerRefs: [
        { serverId: 'unreachable', configId: 'unreachable-default' },
      ],
    },
  });
  try {
    await f.connect();
    await f.select();
    await f.send('Hello Copilot');
    // The turn names the server that sat out and still completes, instead
    // of failing the whole send the way it did before.
    await expect(f.panel).toContainText("Couldn't connect to the MCP server");
    await expect(f.panel).toContainText(/unreachable/i);
    await expect(f.panel).toContainText(
      'Copilot is continuing without its tools.',
    );
    await expect(
      f.panel.getByText('Copilot fixture reply 1.', { exact: true }),
    ).toBeVisible();
    await expect(f.panel.getByTestId('chat-stop-generation')).toBeHidden();
    await expect(f.panel).not.toContainText(
      'could not connect to every selected MCP server',
    );
  } finally {
    await f.close();
  }
});

test('Copilot stop reaps the turn and permits a follow-up', async () => {
  const f = await launchCopilotSelectionFixture();
  try {
    await f.connect();
    await f.select();
    await f.send('COPILOT_HOLD');
    await expect(
      f.panel.getByText('Waiting for Stop.', { exact: true }),
    ).toBeVisible();
    await f.panel.getByTestId('chat-stop-generation').click();
    await expect(f.panel.getByTestId('chat-stop-generation')).toBeHidden();
    await f.send('Continue after Stop');
    await expect(
      f.panel.getByText('Copilot fixture reply 2.', { exact: true }),
    ).toBeVisible();
  } finally {
    await f.close();
  }
});

test('Copilot recovers a missing interactive profile with a visible context notice', async () => {
  const f = await launchCopilotSelectionFixture();
  try {
    await f.connect();
    await f.select();
    await f.send('First conversation');
    await expect(
      f.panel.getByText('Copilot fixture reply 1.', { exact: true }),
    ).toBeVisible();
    await expect(f.panel.getByTestId('chat-stop-generation')).toBeHidden();
    const before = await f.tab();
    const binding = readdirSync(f.userDataDir, { recursive: true }).find(
      (name) =>
        name.endsWith('host-session.json') && name.includes('copilot-sessions'),
    );
    expect(binding).toBeTruthy();
    await f.restartWith({
      seed: () =>
        rmSync(path.dirname(path.join(f.userDataDir, binding)), {
          recursive: true,
        }),
    });
    await f.openChat();
    await f.send('Continue after profile loss');
    await expect(f.panel.getByText(/previous conversation/)).toBeVisible();
    await expect(f.panel.getByTestId('chat-stop-generation')).toBeHidden();
    expect((await f.tab()).sdkSessionId).not.toBe(before.sdkSessionId);
  } finally {
    await f.close();
  }
});

test('Copilot stops a tool completion that bypassed host authorization', async () => {
  const f = await launchCopilotSelectionFixture();
  try {
    await f.connect();
    await f.select();
    await f.send('COPILOT_UNAUTHORIZED_COMPLETION');
    await expect(
      f.panel.getByText(/completed a tool without authorization/),
    ).toBeVisible();
    await expect(f.panel.getByTestId('chat-stop-generation')).toBeHidden();
    await expect(
      f.panel.getByText('Unauthorized completion accepted.', { exact: true }),
    ).toHaveCount(0);
    await f.send('Continue after rejected completion');
    await expect(
      f.panel.getByText('Copilot fixture reply 2.', { exact: true }),
    ).toBeVisible();
  } finally {
    await f.close();
  }
});

test('Copilot worktree tools expose Code Graph through the authenticated route', async () => {
  const f = await launchCopilotSelectionFixture({
    approvalMode: 'full-access',
  });
  try {
    await f.connect();
    await f.select();
    await f.send('COPILOT_CODE_GRAPH');
    await expect(
      f.panel.getByText('Copilot inspected the code graph.', { exact: true }),
    ).toBeVisible();
    await expect(f.panel.getByTestId('chat-stop-generation')).toBeHidden();
  } finally {
    await f.close();
  }
});

test('Copilot native questions return the selected answer and continue', async () => {
  const f = await launchCopilotSelectionFixture();
  try {
    await f.connect();
    await f.select();
    await f.send('COPILOT_ASK');
    // The composer asks; a choice answers as soon as it is clicked.
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

test('Copilot MCP questions return the selected answer and continue', async () => {
  const f = await launchCopilotSelectionFixture({
    approvalMode: 'full-access',
  });
  try {
    await f.connect();
    await f.select();
    await f.send('COPILOT_MCP_ASK');
    // The composer asks; a choice answers as soon as it is clicked.
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

test('Copilot account switching uses the selected identity and rejects the previous conversation', async () => {
  const f = await launchCopilotSelectionFixture();
  try {
    await f.connect();
    await f.select();
    await f.send('Start with original account');
    await expect(
      f.panel.getByText('Copilot fixture reply 1.', { exact: true }),
    ).toBeVisible();
    await f.driver.openSettings();
    await f.driver.openSettingsSection('experiments');
    await f.window.getByTestId('copilot-change-account').click();
    await f.approveDeviceCode('copilot-alternate');
    await expect(f.window.getByTestId('copilot-connection')).toContainText(
      'Signed in as copilot-alternate',
    );
    await expect(f.window.getByTestId('copilot-connection-account')).toHaveText(
      'Signed in as copilot-alternate',
    );
    await expect(f.window.getByTestId('copilot-connection-error')).toHaveCount(
      0,
    );
    await f.driver.closeSettings();
    await f.openChat();
    await f.send('Resume with different account');
    await expect(
      f.panel.getByText(/another Copilot account|another account/),
    ).toBeVisible();
    await expect(
      f.panel.getByText('Copilot fixture reply 2.', { exact: true }),
    ).toHaveCount(0);
    await f.driver.openSettings();
    await f.driver.openSettingsSection('experiments');
    await f.window.getByTestId('copilot-connect').click();
    await expect(f.window.getByTestId('copilot-connection-status')).toHaveText(
      'Ready to connect',
    );
    await expect(
      f.window.getByTestId('copilot-connection-account'),
    ).toHaveCount(0);
    await expect(f.window.getByTestId('copilot-connection-error')).toHaveCount(
      0,
    );
  } finally {
    await f.close();
  }
});

for (const mode of ['corrupt', 'slow'])
  test(`Copilot setup recovers after ${mode === 'slow' ? 'cancellation' : 'a corrupt download'}`, async () => {
    const f = await launchCopilotSelectionFixture();
    try {
      f.managed.state.mode = mode;
      await f.driver.openSettings();
      await f.driver.openSettingsSection('experiments');
      await f.window.getByTestId('copilot-connect').click();
      if (mode === 'slow') {
        await expect(
          f.window.getByTestId('copilot-connection-status'),
        ).toHaveText(/Downloading/);
        await f.window.getByTestId('copilot-cancel').click();
        // Cancelling is the user's choice, not a failure to report.
        await expect(
          f.window.getByTestId('copilot-connection-status'),
        ).toHaveText('Ready to connect');
        await expect(
          f.window.getByTestId('copilot-connection-error'),
        ).toHaveCount(0);
      } else {
        await expect(
          f.window.getByTestId('copilot-connection-error'),
        ).toBeVisible();
      }
      await expect(f.window.getByTestId('copilot-connect')).toBeEnabled();
      expect(
        await f.window.evaluate(() => window.api.copilotConnection.status()),
      ).toMatchObject({ enabled: false, installed: false });
      f.managed.state.mode = 'normal';
      await f.window.getByTestId('copilot-connect').click();
      await f.approveDeviceCode();
      await expect(
        f.window.getByTestId('copilot-connection-status'),
      ).toHaveText('Copilot connected');
    } finally {
      await f.close();
    }
  });

test('Copilot selected app MCP tools execute through the shared proxy and render their result', async () => {
  const f = await launchCopilotSelectionFixture();
  try {
    await f.connect();
    await f.select();
    await f.send('COPILOT_APP_TOOL');
    await expect(f.panel.getByTestId('tool-approval-card')).toContainText(
      'GetGitPreferences',
    );
    await f.panel
      .getByRole('button', { name: 'Allow once', exact: true })
      .click();
    await expect(f.panel).toContainText('Copilot app tool completed.');
    await expect(
      f.panel.getByText('Copilot app tool completed.', { exact: true }),
    ).toBeVisible();
    await expect(f.panel.getByTestId('chat-stop-generation')).toBeHidden();
  } finally {
    await f.close();
  }
});

test('Copilot delegates to a managed Copilot child and integrates its result after the completion watch', async () => {
  test.setTimeout(150_000);
  const f = await launchCopilotSelectionFixture({
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
      'COPILOT_CHILD_EVIDENCE',
    );
    await f.send('Please delegate this review. COPILOT_DELEGATION_PARENT');
    await expect(
      f.panel.getByTestId('chat-delegated-agent').first(),
    ).toBeVisible({ timeout: 60_000 });
    await expect(
      f.panel.getByText(/Integrated Copilot child:.*COPILOT_CHILD_EVIDENCE/),
    ).toBeVisible({ timeout: 90_000 });
    await expect(f.panel.getByTestId('chat-stop-generation')).toBeHidden();
  } finally {
    await f.close();
  }
});

for (const preset of ['read_only', 'dangerous_all'])
  test(`Copilot desktop pipelines enforce ${preset} without an approval prompt`, async () => {
    test.setTimeout(120_000);
    const f = await launchCopilotSelectionFixture();
    try {
      const name = `E2E Copilot ${preset}`;
      seedStoredPipeline({
        userDataDir: f.userDataDir,
        id: `copilot-${preset}`,
        name,
        yaml: [
          `name: ${name}`,
          'on: dispatch',
          'jobs:',
          '  verify:',
          '    steps:',
          '      - id: copilot',
          '        name: Copilot write',
          '        uses: builtin/agent-prompt',
          '        timeout_minutes: 1',
          '        with:',
          '          model: copilot:fixture-model',
          `          permission_preset: ${preset}`,
          '          prompt: COPILOT_WRITE',
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
      expect(state.jobs.verify.steps.copilot.status).toBe('success');
      expect(
        existsSync(path.join(f.worktreePath, 'copilot-sentinel.txt')),
      ).toBe(preset === 'dangerous_all');

      await f.driver.openAuditPage();
      await f.window.getByPlaceholder('Search').fill('copilot:fixture-model');
      const auditRow = f.window
        .getByTestId('audit-entry-list')
        .locator('[data-testid^="audit-entry-"]');
      await expect(auditRow).toHaveCount(1);
      await expect(
        auditRow.getByText('copilot', { exact: true }),
      ).toBeVisible();
      await expect(auditRow.getByText('claude', { exact: true })).toHaveCount(
        0,
      );
    } finally {
      await f.close();
    }
  });

// A Copilot chat reads the user's own home-folder skills every turn, the way
// a Cursor chat does: a skill under the user's Claude configuration reaches
// the managed runtime's skill root without being selected in the app.
test("Copilot chat inherits a skill from the user's Claude skills folder", async () => {
  test.setTimeout(120_000);
  const f = await launchCopilotSelectionFixture({
    approvalMode: 'full-access',
    seedBeforeLaunch: ({ userDataDir }) => {
      // The harness relocates CLAUDE_CONFIG_DIR under provider-state.
      const skill = path.join(
        userDataDir,
        'provider-state',
        'claude',
        'skills',
        'home-review',
      );
      mkdirSync(skill, { recursive: true });
      writeFileSync(
        path.join(skill, 'SKILL.md'),
        '---\nname: home-review\ndescription: Inherited from home\n---\nCOPILOT_PIPELINE_SKILL_SENTINEL\n',
      );
      utimesSync(
        path.join(skill, 'SKILL.md'),
        new Date('2020-01-01'),
        new Date('2020-01-01'),
      );
    },
  });
  try {
    await f.connect();
    await f.select();
    await f.send('COPILOT_SELECTED_SKILL');
    await expect(
      f.panel.getByText('Copilot loaded its selected pipeline skill.', {
        exact: true,
      }),
    ).toBeVisible();
    await expect(f.panel.getByTestId('chat-stop-generation')).toBeHidden();
    const file = path.join(
      f.userDataDir,
      'provider-state',
      'claude',
      'skills',
      'home-review',
      'SKILL.md',
    );
    const before = readFileSync(file, 'utf8');
    const after = before.replace(
      'COPILOT_PIPELINE_SKILL_SENTINEL',
      'COPILOT_CHANGED_SKILL_SENTINEL_',
    );
    expect(after.length).toBe(before.length);
    writeFileSync(file, after);
    utimesSync(file, new Date('2020-01-01'), new Date('2020-01-01'));
    await f.send('COPILOT_SELECTED_SKILL_UPDATED');
    await expect(
      f.panel.getByText('Copilot loaded its selected pipeline skill.', {
        exact: true,
      }),
    ).toHaveCount(2);
    await expect(f.panel.getByTestId('chat-stop-generation')).toBeHidden();
  } finally {
    await f.close();
  }
});

test('Copilot loads an executable home skill under a restrictive umask', async () => {
  test.skip(process.platform === 'win32', 'POSIX executable permissions');
  const f = await launchCopilotSelectionFixture({
    approvalMode: 'full-access',
    seedBeforeLaunch: ({ userDataDir }) => {
      const skill = path.join(
        userDataDir,
        'provider-state',
        'claude',
        'skills',
        'executable-review',
      );
      mkdirSync(skill, { recursive: true });
      writeFileSync(
        path.join(skill, 'SKILL.md'),
        '---\nname: executable-review\ndescription: Executable home skill\n---\nCOPILOT_PIPELINE_SKILL_SENTINEL\n',
      );
      const script = path.join(skill, 'run.sh');
      writeFileSync(script, '#!/bin/sh\necho ok\n');
      chmodSync(script, 0o755);
    },
  });
  let previousMask;
  try {
    await f.connect();
    previousMask = await f.app.evaluate(() => process.umask(0o077));
    await f.select();
    await f.send('COPILOT_SELECTED_SKILL');
    await expect(
      f.panel.getByText('Copilot loaded its selected pipeline skill.', {
        exact: true,
      }),
    ).toBeVisible();
    await expect(f.panel.getByTestId('chat-stop-generation')).toBeHidden();
  } finally {
    if (previousMask !== undefined)
      await f.app.evaluate((_, mask) => process.umask(mask), previousMask);
    await f.close();
  }
});

test('Copilot desktop pipeline receives its selected skill', async () => {
  test.setTimeout(120_000);
  const f = await launchCopilotSelectionFixture();
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
      '---\nname: pipeline-review\ndescription: Pipeline fixture\n---\nCOPILOT_PIPELINE_SKILL_SENTINEL\n',
    );
    writeFileSync(
      path.join(f.userDataDir, 'pipeline-plugin-preferences.json'),
      JSON.stringify({
        version: 2,
        entries: {
          'stored:user:copilot-selected': {
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
    const name = 'E2E Copilot selected skill';
    seedStoredPipeline({
      userDataDir: f.userDataDir,
      id: 'copilot-selected',
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
        '      - id: copilot',
        '        uses: builtin/agent-prompt',
        '        timeout_minutes: 1',
        '        with:',
        '          model: copilot:fixture-model',
        '          permission_preset: read_only',
        '          plugin_collection_id: selected',
        '          prompt: COPILOT_SELECTED_SKILL',
        '',
      ].join('\n'),
    });
    await f.restart();
    await f.connect();
    const card = await openWorkspaceAndRun(f.window, name);
    await expect(card).toContainText('success', { timeout: 60_000 });
  } finally {
    await f.close();
  }
});

test('Copilot desktop pipeline receives a package-only skill', async ({}, testInfo) => {
  test.setTimeout(120_000);
  const f = await launchCopilotSelectionFixture();
  try {
    const id = 'copilot-packaged';
    const name = 'E2E Copilot packaged skill';
    const yaml = [
      `name: ${name}`,
      'on: dispatch',
      'jobs:',
      '  verify:',
      '    steps:',
      '      - id: copilot',
      '        uses: builtin/agent-prompt',
      '        timeout_minutes: 1',
      '        with:',
      '          model: copilot:fixture-model',
      '          permission_preset: read_only',
      '          prompt: COPILOT_SELECTED_SKILL',
      '',
    ].join('\n');
    seedStoredPipeline({ userDataDir: f.userDataDir, id, name, yaml });
    const skill = Buffer.from(
      '---\nname: pipeline-review\ndescription: Packaged fixture\n---\nCOPILOT_PIPELINE_SKILL_SENTINEL\n',
    );
    const sha256 = createHash('sha256').update(skill).digest('hex');
    const pipelineContentHash = createHash('sha256').update(yaml).digest('hex');
    // Canonical manifest order, matching the package-share fixture. No ambient
    // skill directory or pipeline plugin preferences are seeded for this case.
    const manifest = {
      version: 1,
      pipelineContentHash,
      resources: [
        {
          id: 'review',
          kind: 'standalone_skill',
          displayName: 'Review',
          sourceLabel: 'Fixture',
          sourceVisibility: 'private',
          invocationKeys: ['pipeline-review'],
          dependencyResourceIds: [],
          trees: [
            {
              provider: 'claude',
              runtimeKind: 'standalone_skill',
              rootName: 'pipeline-review',
              entries: [
                {
                  path: 'SKILL.md',
                  sha256,
                  size: skill.byteLength,
                  mode: 'read',
                },
              ],
            },
          ],
        },
      ],
      bindings: [
        { jobId: 'verify', stepId: 'copilot', resourceIds: ['review'] },
      ],
      environmentRequirements: [],
      totalFiles: 1,
      totalBytes: skill.byteLength,
    };
    const digest = `pp:v1:${createHash('sha256').update(JSON.stringify(manifest)).digest('base64url')}`;
    const root = path.join(
      f.userDataDir,
      'pipeline-packages',
      'v1',
      'packages',
      digest.slice(6),
    );
    const skillRoot = path.join(
      root,
      'materialized',
      'review',
      'claude',
      'pipeline-review',
    );
    mkdirSync(skillRoot, { recursive: true });
    mkdirSync(path.join(root, 'blobs'), { recursive: true });
    writeFileSync(path.join(root, 'blobs', sha256), skill);
    writeFileSync(path.join(skillRoot, 'SKILL.md'), skill);
    writeFileSync(path.join(root, 'manifest.json'), JSON.stringify(manifest));
    writeFileSync(path.join(root, '.pipeline-package-digest'), digest);
    writeFileSync(
      path.join(f.userDataDir, 'pipeline-package-installs.json'),
      JSON.stringify({
        version: 1,
        records: [
          {
            owner: { kind: 'pipeline', localPipelineId: id },
            pipelineContentHash,
            packageDigest: digest,
            installedAt: '2026-10-01T00:00:00.000Z',
          },
        ],
      }),
    );
    await f.restart();
    await f.connect();
    const card = await openWorkspaceAndRun(f.window, name);
    await expect(card).toContainText(/success|failure/, { timeout: 60_000 });
    const dir = path.join(f.userDataDir, 'pipeline-executions');
    for (const entry of readdirSync(dir).filter((name) =>
      name.endsWith('.json'),
    )) {
      await testInfo.attach(`pipeline-${entry}`, {
        body: readFileSync(path.join(dir, entry)),
        contentType: 'application/json',
      });
    }
    await expect(card).toContainText('success');
  } finally {
    await f.close();
  }
});

test('Home sends a Copilot task into a Cowork Work Entry', async () => {
  const f = await launchCopilotSelectionFixture({
    seedBeforeLaunch: ({ userDataDir }) => {
      const file = path.join(userDataDir, 'workspaces/index.json');
      const code = JSON.parse(readFileSync(file, 'utf8'));
      seedCoworkWorkspace({
        userDataDir,
        collapsed: false,
        externalPath: path.join(userDataDir, 'workspaces/demo-ts-pnpm-vite'),
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
    await f.connect();
    await f.window.getByTestId('sidebar-create-task').click();
    const home = f.window.getByTestId('page-home');
    await home.getByTestId('home-workspace-select').click();
    await f.window.getByTestId('home-workspace-option-seeded-cowork').click();
    await home.getByTestId('chat-model-picker').click();
    await f.window.getByTestId('chat-model-harness-tab-copilot').click();
    await f.window
      .getByTestId('chat-model-option-copilot:fixture-model')
      .click();
    await home
      .getByTestId('home-composer-editor')
      .fill('Hello Copilot in Cowork');
    await home.getByTestId('home-send-button').click();
    await expect(home).toHaveCount(0);
    await expect(
      f.window
        .getByTestId('panel-content-chat')
        .getByText('Copilot fixture reply 1.', { exact: true }),
    ).toBeVisible({ timeout: 60000 });
  } finally {
    await f.close();
  }
});

test('App Advisor uses Copilot and its app tools through shared approval', async () => {
  const f = await launchCopilotSelectionFixture();
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
    await advisor.getByTestId('chat-model-harness-tab-copilot').click();
    await advisor
      .getByTestId('chat-model-option-copilot:fixture-model')
      .click();
    await advisor
      .getByTestId('approval-mode-picker')
      .filter({ visible: true })
      .first()
      .click();
    await advisor.getByTestId('approval-mode-option-ask').click();
    await composer.fill('COPILOT_ADVISOR');
    await advisor
      .getByRole('button', { name: 'Send message', exact: true })
      .click();
    const card = advisor.getByTestId('tool-approval-card');
    await expect(card).toContainText('Copilot wants to use GetCurrentUiState');
    await card.getByTestId('tool-approval-allow').click();
    await expect(
      advisor.getByText('Copilot Advisor inspected the app.', { exact: true }),
    ).toBeVisible();
    await expect(card).toHaveCount(0);
    await composer.fill('COPILOT_GRAPH_ACTION');
    await advisor
      .getByRole('button', { name: 'Send message', exact: true })
      .click();
    await expect(card).toContainText('DispatchAction');
    await card.getByTestId('tool-approval-allow').click();
    await expect(
      advisor.getByText('Copilot Advisor inspected the worktree graph.', {
        exact: true,
      }),
    ).toBeVisible();
  } finally {
    await f.close();
  }
});

test('Copilot connect can be cancelled while the code is shown and saves nothing', async () => {
  const f = await launchCopilotSelectionFixture();
  try {
    await f.driver.openSettings();
    await f.driver.openSettingsSection('experiments');
    await f.window.getByTestId('copilot-connect').click();
    await expect(f.window.getByTestId('copilot-device-code')).toBeVisible();
    await f.window.getByTestId('copilot-open-github').click();
    await f.window.getByTestId('copilot-cancel').click();
    await expect(f.window.getByTestId('copilot-connection-status')).toHaveText(
      'Ready to connect',
    );
    await expect(f.window.getByTestId('copilot-connection-error')).toHaveCount(
      0,
    );
    expect(
      await f.window.evaluate(() => window.api.copilotConnection.status()),
    ).toMatchObject({ enabled: false });
    expect(
      existsSync(path.join(`${f.userDataDir}-secure`, 'copilot-account.enc')),
    ).toBe(false);
    const opened = await (
      await fetch(`${f.managed.mockBaseUrl}/__mock/github/external-open`)
    ).json();
    expect(opened.urls).toContain(`${f.managed.mockBaseUrl}/login/device`);
  } finally {
    await f.close();
  }
});

test('Copilot connect reports a declined GitHub sign-in', async () => {
  const f = await launchCopilotSelectionFixture();
  try {
    await f.driver.openSettings();
    await f.driver.openSettingsSection('experiments');
    await f.window.getByTestId('copilot-connect').click();
    await expect(f.window.getByTestId('copilot-device-code')).toBeVisible();
    await f.denyDeviceCode();
    await expect(f.window.getByTestId('copilot-connection-error')).toHaveText(
      'GitHub sign-in was declined.',
    );
    await expect(f.window.getByTestId('copilot-connect')).toBeEnabled();
  } finally {
    await f.close();
  }
});

test('Copilot connect names an organization policy that blocks Copilot CLI', async () => {
  const f = await launchCopilotSelectionFixture();
  try {
    await f.driver.openSettings();
    await f.driver.openSettingsSection('experiments');
    await f.window.getByTestId('copilot-connect').click();
    await expect(f.window.getByTestId('copilot-device-code')).toBeVisible();
    // The fixture runtime answers this login's model request with the
    // service's policy 403, the way a seat under a disabled Copilot CLI
    // policy is answered in production.
    await f.approveDeviceCode('policy-blocked');
    await expect(f.window.getByTestId('copilot-connection-error')).toHaveText(
      "An organization policy blocks Copilot CLI for this GitHub account. Ask an organization owner to enable Copilot CLI in the organization's Copilot policies, then connect again.",
    );
    await expect(f.window.getByTestId('copilot-connect')).toBeEnabled();
  } finally {
    await f.close();
  }
});

test('Copilot disconnect signs out and removes the credential', async () => {
  const f = await launchCopilotSelectionFixture();
  try {
    await f.connect();
    expect(
      existsSync(path.join(`${f.userDataDir}-secure`, 'copilot-account.enc')),
    ).toBe(true);
    await f.driver.openSettings();
    await f.driver.openSettingsSection('experiments');
    // The same control reads "Disconnect Copilot" while connected.
    await f.window.getByTestId('copilot-connect').click();
    await expect(f.window.getByTestId('copilot-connection-status')).toHaveText(
      'Ready to connect',
    );
    expect(
      existsSync(path.join(`${f.userDataDir}-secure`, 'copilot-account.enc')),
    ).toBe(false);
    expect(
      await f.window.evaluate(() => window.api.copilotConnection.listModels()),
    ).toEqual([]);
  } finally {
    await f.close();
  }
});

test('Copilot reports an expired sign-in when GitHub rejects the refresh token', async () => {
  const f = await launchCopilotSelectionFixture();
  try {
    await f.managed.registerAccount('copilot-fixture');
    await f.restartWith({
      seed: (userDataDir) => f.managed.seedConnected(userDataDir),
      env: f.managed.credentialEnv('copilot-fixture', {
        accessTokenExpiresAt: new Date(Date.now() - 60_000).toISOString(),
        refreshToken: 'ghr_bad',
      }),
    });
    expect(
      await f.window.evaluate(async () => {
        try {
          await window.api.copilotConnection.listModels();
          return 'listed';
        } catch (error) {
          return String(error);
        }
      }),
    ).toContain('Copilot sign-in expired. Reconnect Copilot in Settings.');
    await f.driver.openSettings();
    await f.driver.openSettingsSection('experiments');
    await expect(f.window.getByTestId('copilot-connection-status')).toHaveText(
      'Ready to connect',
    );
  } finally {
    await f.close();
  }
});

for (const scenario of [
  {
    name: 'unchanged',
    preset: 'read_only',
    instructions: 'Read evidence',
    status: 'success',
  },
  {
    name: 'changed permissions',
    preset: 'dangerous_all',
    instructions: 'Read evidence',
    status: 'failure',
  },
  {
    name: 'changed instructions',
    preset: 'read_only',
    instructions: 'Different instructions',
    status: 'failure',
  },
]) {
  test(`Copilot pipeline resume with ${scenario.name}`, async () => {
    test.setTimeout(120_000);
    const f = await launchCopilotSelectionFixture();
    try {
      const name = `Copilot resume ${scenario.name}`;
      seedStoredPipeline({
        userDataDir: f.userDataDir,
        id: `copilot-resume-${scenario.name.replaceAll(' ', '-')}`,
        name,
        yaml: [
          `name: ${name}`,
          'on: dispatch',
          'jobs:',
          '  verify:',
          '    steps:',
          '      - id: initial',
          '        uses: builtin/agent-prompt',
          '        timeout_minutes: 1',
          '        with:',
          '          model: copilot:fixture-model',
          '          permission_preset: read_only',
          '          system_prompt: Read evidence',
          '          prompt: Hello Copilot',
          '      - id: resumed',
          '        uses: builtin/agent-resume',
          '        timeout_minutes: 1',
          '        with:',
          '          model: copilot:fixture-model',
          '          session_id: ${{ steps.initial.outputs.session_id }}',
          `          permission_preset: ${scenario.preset}`,
          `          system_prompt: ${scenario.instructions}`,
          '          prompt: COPILOT_WRITE',
          '',
        ].join('\n'),
      });
      await f.restart();
      await f.connect();
      const card = await openWorkspaceAndRun(f.window, name);
      await expect(card).toContainText(/success|failure/, { timeout: 60_000 });
      const directory = path.join(f.userDataDir, 'pipeline-executions');
      const entry = readdirSync(directory).find((file) =>
        file.endsWith('.json'),
      );
      expect(entry).toBeTruthy();
      const state = JSON.parse(
        readFileSync(path.join(directory, entry), 'utf8'),
      );
      expect(state.jobs.verify.steps.initial.status).toBe('success');
      expect(state.jobs.verify.steps.resumed.status).toBe(scenario.status);
      if (scenario.status === 'failure') {
        expect(JSON.stringify(state.jobs.verify.steps.resumed)).toMatch(
          /capabilit|configuration/i,
        );
      }
      expect(
        existsSync(path.join(f.worktreePath, 'copilot-sentinel.txt')),
      ).toBe(false);
      await expect(f.window.getByTestId('tool-approval-card')).toHaveCount(0);
    } finally {
      await f.close();
    }
  });
}

for (const termination of ['quit', 'SIGTERM', 'SIGINT', 'SIGKILL']) {
  const outcomes =
    termination === 'SIGKILL'
      ? ['lost response']
      : ['received successor', 'lost response'];
  for (const outcome of outcomes) {
    test(`Copilot lifecycle ${termination} with rotation in flight: ${outcome}`, async () => {
      test.setTimeout(120_000);
      test.skip(
        process.platform === 'win32' && termination !== 'quit',
        'POSIX signals; Windows real-process qualification is separate',
      );
      const f = await launchCopilotSelectionFixture();
      const receiptEvidence = {};
      const login = `lifecycle-${randomUUID()}`;
      const key = `ghu_e2e_${login}`;
      const originalGrant = `ghr_e2e_${key}`;
      const credentialPath = path.join(
        `${f.userDataDir}-secure`,
        'copilot-account.enc',
      );
      const attemptPath = path.join(
        `${f.userDataDir}-secure`,
        'copilot-rotation-attempt.json',
      );
      const control = `${f.managed.mockBaseUrl}/__mock/github/refresh/${key}`;
      const refreshState = async () => {
        const response = await fetch(control, {
          signal: AbortSignal.timeout(5000),
        });
        expect(response.ok).toBe(true);
        return response.json();
      };
      const holdRefresh = async (held) => {
        const response = await fetch(control, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ held }),
          signal: AbortSignal.timeout(5000),
        });
        expect(response.ok).toBe(true);
      };
      try {
        await f.managed.registerAccount(login);
        await holdRefresh(true);
        // Seed an expired grant through the existing startup fixture, not a clock
        // override or production refresh hook. The next real consumer must rotate.
        await f.restartWith({
          seed: (userDataDir) => {
            f.managed.seedConnected(userDataDir, login);
          },
          env: f.managed.credentialEnv(login, {
            accessTokenExpiresAt: new Date(Date.now() - 60_000).toISOString(),
          }),
        });
        // Start an actual model consumer; startup discovery may already have joined it.
        const demand = f.window
          .evaluate(async () => {
            try {
              await window.api.copilotConnection.listModels();
            } catch {
              /* The renderer is deliberately terminated with this pending. */
            }
          })
          .catch(() => undefined);
        await expect.poll(async () => (await refreshState()).waiting).toBe(1);
        expect(await refreshState()).toMatchObject({
          presentations: [originalGrant],
          delivered: 0,
        });
        const record = readFileSync(attemptPath, 'utf8');
        const attempt = JSON.parse(record);
        expect(attempt).toEqual({
          version: 1,
          attemptId: expect.any(String),
          bootId: expect.any(String),
          accountEpoch: {
            host: 'https://github.com',
            id: '4242',
            entryId: expect.any(String),
          },
          fromDigest: createHash('sha256').update(originalGrant).digest('hex'),
        });
        for (const secret of [
          key,
          originalGrant,
          'ghu_',
          'ghr_',
          'accessToken',
          'refreshToken',
        ])
          expect(record).not.toContain(secret);
        const logPath = path.join(f.userDataDir, 'logs', 'main.log');
        const logOffset = readFileSync(logPath, 'utf8').length;
        const beforeExit = readCopilotReceipts(f.userDataDir);
        receiptEvidence.beforeExit = copilotReceiptEvidence(beforeExit);
        const pid = await f.app.evaluate(() => process.pid);
        const closed = f.app.waitForEvent('close');
        const terminatedAt = Date.now();
        const quit =
          termination === 'quit'
            ? f.app.evaluate(({ app }) => app.quit()).catch(() => undefined)
            : Promise.resolve(process.kill(pid, termination));
        if (outcome === 'received successor') {
          // Release only after cleanup has started, while the D30 drain is pending.
          await expect
            .poll(() => readFileSync(logPath, 'utf8').slice(logOffset))
            .toContain('runtime_cleanup_stage');
          expect(Date.now() - terminatedAt).toBeLessThan(2000);
          await holdRefresh(false);
        }
        await closed;
        await quit;
        await demand;
        const afterExitReceipts = readCopilotReceipts(f.userDataDir);
        receiptEvidence.afterExit = copilotReceiptEvidence(afterExitReceipts);
        const priorReceipts = [...beforeExit, ...afterExitReceipts];
        const afterExit = await refreshState();
        expect(afterExit.presentations).toEqual([originalGrant]);
        if (outcome === 'received successor') {
          expect(afterExit.delivered).toBe(1);
          expect(existsSync(attemptPath)).toBe(false);
        } else {
          // The retired grant remains stored, not cleared on an ambiguous exit.
          await expect.poll(async () => (await refreshState()).waiting).toBe(0);
          expect(afterExit.delivered).toBe(0);
          expect(existsSync(credentialPath)).toBe(true);
          expect(readFileSync(attemptPath, 'utf8')).toBe(record);
          await holdRefresh(false);
        }
        await f.restartAfterExit();
        receiptEvidence.afterRestart = copilotReceiptEvidence(
          readCopilotReceipts(f.userDataDir),
        );
        await expect
          .poll(() =>
            priorReceipts.some((receipt) =>
              receipt.processes.some((row) => copilotProcessAlive(row.pid)),
            ),
          )
          .toBe(false);
        await expect
          .poll(() =>
            priorCopilotReceipts(
              priorReceipts,
              readCopilotReceipts(f.userDataDir),
            ),
          )
          .toEqual([]);
        // Recovery alone cannot infer an authentication outcome from the record.
        // Demand (including startup discovery) presents the stored grant once.
        await f.window
          .evaluate(() => window.api.copilotConnection.listModels())
          .catch(() => undefined);
        if (outcome === 'lost response') {
          await expect
            .poll(async () => (await refreshState()).presentations)
            .toEqual([originalGrant, originalGrant]);
          await expect.poll(() => existsSync(credentialPath)).toBe(false);
          await expect.poll(() => existsSync(attemptPath)).toBe(false);
          await f.driver.openSettings();
          await f.driver.openSettingsSection('experiments');
          await expect(
            f.window.getByTestId('copilot-connection-status'),
          ).toHaveText('Ready to connect');
          expect((await refreshState()).delivered).toBe(0);
          // Rejection is terminal: repeated demand cannot present the retired grant again.
          await f.window
            .evaluate(() => window.api.copilotConnection.listModels())
            .catch(() => undefined);
          expect((await refreshState()).presentations).toEqual([
            originalGrant,
            originalGrant,
          ]);
          await f.driver.closeSettings();
          await f.connect({ login });
        } else {
          expect((await refreshState()).presentations).toEqual([originalGrant]);
          expect(existsSync(credentialPath)).toBe(true);
        }
        await f.select();
        await f.send('Hello after rotation recovery');
        await expect(
          f.panel.getByText('Copilot fixture reply 1.', { exact: true }),
        ).toBeVisible();
      } finally {
        try {
          receiptEvidence.final = copilotReceiptEvidence(
            readCopilotReceipts(f.userDataDir),
          );
          await test.info().attach('rotation-lifecycle-receipts', {
            body: JSON.stringify(receiptEvidence, null, 2),
            contentType: 'application/json',
          });
        } finally {
          try {
            await holdRefresh(false);
          } finally {
            await f.close();
          }
        }
      }
    });
  }
}

for (const termination of ['quit', 'SIGTERM', 'SIGINT', 'SIGKILL']) {
  test(`Copilot ${termination} recovers receipts and resumes a consumer on next boot`, async () => {
    test.setTimeout(120_000);
    test.skip(
      process.platform === 'win32' && termination !== 'quit',
      'POSIX signals; Windows real-process qualification is separate',
    );
    const f = await launchCopilotSelectionFixture();
    const readReceipts = () => readCopilotReceipts(f.userDataDir);
    const receiptEvidence = {};
    try {
      await f.connect();
      await f.select();
      await f.send('Hello before termination');
      await expect(
        f.panel.getByText('Copilot fixture reply 1.', { exact: true }),
      ).toBeVisible();
      // Completed turns close their runtime. Keep a second turn active so the
      // receipt names a live process when teardown begins.
      await expect(f.panel.getByTestId('chat-stop-generation')).toBeHidden();
      await f.send('COPILOT_HOLD');
      await expect(
        f.panel.getByText('Waiting for Stop.', { exact: true }),
      ).toBeVisible();
      await expect
        .poll(async () => (await f.managed.readHeldTurn())?.turns)
        .toBe(2);
      const oldHeldTurn = await f.managed.readHeldTurn();
      await expect
        .poll(() =>
          readReceipts().some((receipt) =>
            receipt.processes.some((row) => row.pid === oldHeldTurn.pid),
          ),
        )
        .toBe(true);
      const beforeExit = readReceipts();
      const heldReceipt = beforeExit.find((receipt) =>
        receipt.processes.some((row) => row.pid === oldHeldTurn.pid),
      );
      expect(copilotProcessAlive(oldHeldTurn.pid)).toBe(true);
      receiptEvidence.beforeExit = copilotReceiptEvidence(beforeExit);
      receiptEvidence.oldHeldTurn = oldHeldTurn;
      const pid = await f.app.evaluate(() => process.pid);
      const closed = f.app.waitForEvent('close');
      if (termination === 'quit')
        await f.app.evaluate(({ app }) => app.quit()).catch(() => undefined);
      else process.kill(pid, termination);
      await closed;
      const afterExit = readReceipts();
      receiptEvidence.afterExit = copilotReceiptEvidence(afterExit);
      // Include receipts created during teardown as well as the held consumer.
      const priorReceipts = [...beforeExit, ...afterExit];
      if (termination === 'SIGKILL') {
        // The supervisor also reaps descendants; this flow proves receipt recovery,
        // not which owner killed them. The real-orphan Jest case isolates the reaper.
        expect(afterExit.map((receipt) => receipt.name)).toContain(
          heldReceipt.name,
        );
      }
      await f.restartAfterExit();
      receiptEvidence.afterRestart = copilotReceiptEvidence(readReceipts());
      // Make current-boot admission overlap the recovery assertions deliberately.
      // Startup discovery may also own a receipt; neither is prior-boot residue.
      await f.openChat();
      await expect(f.panel.getByTestId('chat-stop-generation')).toBeHidden();
      await f.send('COPILOT_HOLD');
      await expect
        .poll(async () => (await f.managed.readHeldTurn())?.turns)
        .toBe(3);
      await expect(f.panel.getByTestId('chat-stop-generation')).toBeVisible();
      const currentHeldTurn = await f.managed.readHeldTurn();
      receiptEvidence.currentHeldTurn = currentHeldTurn;
      // Admission proves recovery finished: every old identity and named receipt
      // must already be absent, even though this new consumer's receipt is live.
      expect(
        priorReceipts.some((receipt) =>
          receipt.processes.some((row) => copilotProcessAlive(row.pid)),
        ),
      ).toBe(false);
      expect(priorCopilotReceipts(priorReceipts, readReceipts())).toEqual([]);
      await expect
        .poll(() =>
          readReceipts().some((receipt) =>
            receipt.processes.some((row) => row.pid === currentHeldTurn.pid),
          ),
        )
        .toBe(true);
      const currentReceipts = readReceipts();
      receiptEvidence.currentConsumer = copilotReceiptEvidence(currentReceipts);
      const currentReceipt = currentReceipts.find((receipt) =>
        receipt.processes.some((row) => row.pid === currentHeldTurn.pid),
      );
      expect(currentReceipt).toBeTruthy();
      expect(copilotProcessAlive(currentHeldTurn.pid)).toBe(true);
      expect(priorReceipts.map((receipt) => receipt.name)).not.toContain(
        currentReceipt.name,
      );
      // Concurrent demands must not re-run successful recovery against the
      // already-admitted current consumer.
      await f.window.evaluate(() =>
        Promise.all([
          window.api.copilotConnection.listModels(),
          window.api.copilotConnection.listModels(),
        ]),
      );
      expect(copilotProcessAlive(currentHeldTurn.pid)).toBe(true);
      expect(readReceipts().map((receipt) => receipt.name)).toContain(
        currentReceipt.name,
      );
      receiptEvidence.afterConcurrentDemand =
        copilotReceiptEvidence(readReceipts());
      await f.panel.getByTestId('chat-stop-generation').click();
      await expect(f.panel.getByTestId('chat-stop-generation')).toBeHidden();
      await expect
        .poll(() => copilotProcessAlive(currentHeldTurn.pid))
        .toBe(false);
      await expect
        .poll(() => priorCopilotReceipts([currentReceipt], readReceipts()))
        .toEqual([]);
      await f.send('Continue after recovery');
      await expect(
        f.panel.getByText('Copilot fixture reply 4.', { exact: true }),
      ).toBeVisible();
    } finally {
      try {
        receiptEvidence.final = copilotReceiptEvidence(readReceipts());
        await test.info().attach('receipt-boot-identities', {
          body: JSON.stringify(receiptEvidence, null, 2),
          contentType: 'application/json',
        });
      } finally {
        await f.close();
      }
    }
  });
}
