import { selectModelOption } from './model-selection-fixture.mjs';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import {
  clearScenario,
  DEFAULT_MOCK_BASE_URL,
  registerScenario,
  writeJson,
} from './seeders/index.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { composerIdleAction } from './composerIdleAction.mjs';

const CUSTOM_SOURCE_ID = 'custom:app';
const CODEX_MODEL = 'gpt-6.1-sol';
const CLAUDE_MODEL = 'opus[1m]';
const AVAILABLE_SKILL = 'e2e-app-advisor-available';

function pickEphemeralMcpProxyPort() {
  return 20000 + Math.floor(Math.random() * 15000);
}

const PROVIDERS = [
  {
    provider: 'codex',
    model: CODEX_MODEL,
    selectedSkill: 'e2e-app-advisor-codex-skill',
    selectedDiscoveryText: /e2e-app-advisor-codex-skill/,
  },
  {
    provider: 'claude',
    model: CLAUDE_MODEL,
    selectedSkill: 'e2e-app-advisor-claude-skill',
    selectedDiscoveryText: /e2e-app-advisor-claude-skill/,
  },
];

function makeUserDataDir(provider) {
  return mkdtempSync(
    path.join(os.tmpdir(), `canopy-app-advisor-plugin-slash-${provider}-`),
  );
}

function emptyPluginSelections() {
  return {
    collectionIds: [],
    skillRefs: [],
    pluginRefs: [],
    mcpServerRefs: [],
  };
}

function skillSelections(skillName) {
  return {
    ...emptyPluginSelections(),
    skillRefs: [{ sourceId: CUSTOM_SOURCE_ID, skillName }],
  };
}

function seedPreferences(userDataDir, { model, pluginSelections }) {
  mkdirSync(userDataDir, { recursive: true });
  writeJson(path.join(userDataDir, 'preferences.json'), {
    version: 1,
    preferences: {
      onboardingCompleted: ['v1'],
      appAdvisorModel: model,
      appAdvisorThinkingLevel: 'high',
      defaultChatProvider: model === CODEX_MODEL ? 'codex' : 'claude',
      defaultWorktreeProvider: model === CODEX_MODEL ? 'codex' : 'claude',
      defaultChatModelByProvider: {
        [model === CODEX_MODEL ? 'codex' : 'claude']: {
          model,
          thinkingLevel: 'high',
        },
      },
      defaultWorktreeModelByProvider: {
        [model === CODEX_MODEL ? 'codex' : 'claude']: {
          model,
          thinkingLevel: 'high',
        },
      },
      appAdvisorPluginSelections: pluginSelections ?? emptyPluginSelections(),
      defaultAppAdvisorInterfaceMode: 'canopy',
      mcpProxyPort: pickEphemeralMcpProxyPort(),
      providerModelConfigDefaults: {
        codex: { thinkingLevel: 'high' },
        claude: { thinkingLevel: 'high' },
      },
    },
  });
}

function seedCustomSkill(userDataDir, skillName, description) {
  const skillDir = path.join(
    userDataDir,
    'skills',
    CUSTOM_SOURCE_ID,
    skillName,
  );
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(
    path.join(skillDir, 'SKILL.md'),
    [
      '---',
      `name: ${skillName}`,
      `description: ${description}`,
      'user-invocable: true',
      '---',
      '',
      `This is the ${skillName} App Advisor UI automation fixture.`,
      '',
    ].join('\n'),
    'utf8',
  );
}

function seedSkills(userDataDir, providerConfig) {
  seedCustomSkill(
    userDataDir,
    providerConfig.selectedSkill,
    `Selected ${providerConfig.provider} App Advisor fixture`,
  );
  seedCustomSkill(
    userDataDir,
    AVAILABLE_SKILL,
    'Available App Advisor fixture',
  );
}

function seedInventoryCache(userDataDir, providerConfig) {
  const trigger = providerConfig.provider === 'codex' ? '$' : '/';
  const providerPrefix =
    providerConfig.provider === 'codex' ? 'builtin-app-plugin:' : '';
  const entryForSkill = (skillName) => {
    const displayName = `${trigger}${providerPrefix}${skillName}`;
    return {
      id: [
        providerConfig.provider,
        'skill',
        encodeURIComponent(CUSTOM_SOURCE_ID),
        encodeURIComponent(skillName),
      ].join(':'),
      provider: providerConfig.provider,
      kind: 'skill',
      name: skillName,
      displayName,
      description: `Inventory row for ${skillName}`,
      insertText: `${displayName} `,
      invocationKey: displayName,
      enableRef: {
        kind: 'skill',
        sourceId: CUSTOM_SOURCE_ID,
        skillName,
      },
      sourceLabel: 'Custom',
    };
  };

  writeJson(path.join(userDataDir, 'invocable-inventory-cache.json'), {
    version: 3,
    builtAt: '2026-07-07T00:00:00.000Z',
    entries: [
      entryForSkill(providerConfig.selectedSkill),
      entryForSkill(AVAILABLE_SKILL),
    ],
  });
}

async function openAdvisor(userDataDir) {
  const { electronApp } = await launchCanopy({ userDataDir });
  const window = await electronApp.firstWindow();
  const app = new CanopyAppDriver(window);
  await app.waitForShell({ timeout: 30_000 });
  const advisor = await app.openAppAdvisorWindow(electronApp);
  // Keep the full composer toolbar mounted so the fixture can explicitly pin
  // and verify its provider through the real model picker. The production
  // popout restores its last size, which otherwise makes this test depend on
  // whatever compact width the isolated profile initially receives.
  await advisor.setViewportSize({ width: 1_200, height: 800 });
  await expect(
    advisor.getByTestId('app-advisor-workspace-surface'),
  ).toBeVisible();
  await expect(advisor.getByRole('textbox').first()).toBeVisible({
    timeout: 30_000,
  });
  return { electronApp, advisor };
}

async function selectAndExpectAdvisorProvider(advisor, providerConfig) {
  const picker = advisor
    .locator('[data-testid="chat-model-picker"]:visible')
    .first();
  await expect(picker).toBeVisible();
  await picker.click();
  await selectModelOption(advisor, providerConfig.model);
  await expect(
    picker.getByTestId('chat-model-picker-provider-icon'),
  ).toHaveAttribute('data-provider', providerConfig.provider);
}

async function sendAdvisorMessageAndExpectReply(advisor, { marker, reply }) {
  const message = `[${marker}] Confirm App Advisor can answer.`;
  const composer = advisor.getByRole('textbox').first();
  await expect(composer).toBeVisible();
  await composer.click();
  await composer.fill(message);
  await advisor.getByRole('button', { name: 'Send message' }).click();

  const transcript = advisor.getByTestId('app-advisor-workspace-surface');
  await expect(transcript.getByText(message).first()).toBeVisible({
    timeout: 30_000,
  });
  await expect(transcript.getByText(reply).first()).toBeVisible({
    timeout: 120_000,
  });
  // Codex can render its final assistant item immediately before the
  // terminal turn event reaches the renderer. Capability changes are valid
  // only once the chat is idle, so use the composer's state transition as
  // the durability boundary rather than treating visible text as completion.
  await expect(composerIdleAction(advisor)).toBeVisible({
    timeout: 30_000,
  });
}

async function enableSelectedSkill(advisor, skillName) {
  await advisor.getByTestId('chat-input-plus-button').click();
  await advisor.getByTestId('chat-plugins-button').click();

  const dialog = advisor
    .locator('[role="dialog"]')
    .filter({ hasText: 'Plugins' });
  await expect(dialog).toBeVisible();
  await dialog.getByPlaceholder('Search by name…').fill(skillName);
  await dialog
    .getByRole('combobox', { name: 'Kind filter' })
    .selectOption('skill');

  const checkbox = dialog.getByRole('checkbox', {
    name: `Select ${skillName}`,
  });
  await expect(checkbox).toBeVisible();
  await checkbox.check();
  await expect(checkbox).toBeChecked();
  await expect(dialog.getByTestId('unified-table-selected-count')).toHaveText(
    '1',
  );

  // Saving mid-chat on Codex runs `chat:update-plugins`, whose
  // `materializeCodexThread` path reads the PERSISTED chat-tabs file and
  // rejects with "Chat tab was not found while updating tools"
  // (`main/ipc/chat.ts` — `readChatTabsFile` before
  // `materializeCodexCapabilityTransition`) when the renderer's debounced
  // tab write has not flushed yet. The modal then stays open showing
  // "Couldn't update tools. Your current session and selections were kept."
  // — the state a real user recovers from by pressing Save again (flaked
  // exactly here in Internal Release run 32456587191 attempts 1 and 3;
  // reproduced locally with the main-process error above). Retry the
  // user-visible remedy until the persist flushes; the app-side race is
  // reported in CAN-2436 rather than papered over silently.
  const saveButton = dialog.getByRole('button', { name: 'Save' });
  await expect(async () => {
    // Skip the click when a previous attempt already closed the dialog, and
    // fail fast (instead of Playwright's 30s default) when the button is
    // mid-"Saving…" so the outer retry re-evaluates promptly.
    if ((await dialog.count()) > 0) {
      await saveButton.click({ timeout: 5_000 });
    }
    await expect(dialog).toHaveCount(0, { timeout: 15_000 });
  }).toPass({ timeout: 60_000 });
}

async function openSlashMenu(advisor) {
  const composer = advisor.getByRole('textbox').first();
  await expect(composer).toBeVisible();
  await composer.click();
  await composer.fill('/');
  const menu = advisor.getByTestId('chat-input-plus-menu');
  await expect(menu).toBeVisible({
    timeout: 45_000,
  });
  await expect(menu).toHaveAttribute('data-menu-variant', 'commands');
  return { composer, menu };
}

async function expectDiscoveredAndAvailableRows(menu, providerConfig) {
  const selectedRow = menu
    .getByRole('group', { name: 'Skills and commands' })
    .locator('[data-testid^="chat-input-capability-"]')
    .filter({ hasText: providerConfig.selectedDiscoveryText })
    .first();
  await expect(selectedRow).toBeVisible({ timeout: 45_000 });
  const selectedLabel = selectedRow
    .locator('[data-action-description]')
    .locator('xpath=preceding-sibling::span[1]');
  await expect(selectedLabel).toHaveText(providerConfig.selectedDiscoveryText);

  await expect(
    menu.getByRole('group', { name: 'Available to enable' }),
  ).toBeVisible();
  const availableRow = menu.getByTestId(
    `chat-input-capability-${AVAILABLE_SKILL}`,
  );
  await expect(availableRow).toBeVisible();
  return availableRow;
}

async function expectSlashMenuAndSelectAvailable(advisor, providerConfig) {
  const { composer, menu } = await openSlashMenu(advisor);
  const availableRow = await expectDiscoveredAndAvailableRows(
    menu,
    providerConfig,
  );

  await availableRow.click();
  await expect(menu).toHaveCount(0);
  await expect(composer).toContainText(AVAILABLE_SKILL);
}

async function expectDefaultSkillSelections(advisor, providerConfig) {
  await advisor.getByTestId('chat-input-plus-button').click();
  await advisor.getByTestId('chat-plugins-button').click();

  const dialog = advisor
    .locator('[role="dialog"]')
    .filter({ hasText: 'Plugins' });
  await expect(dialog).toBeVisible();
  await dialog
    .getByRole('combobox', { name: 'Kind filter' })
    .selectOption('skill');

  const selectedSkill = dialog.getByRole('checkbox', {
    name: `Select ${providerConfig.selectedSkill}`,
  });
  const availableSkill = dialog.getByRole('checkbox', {
    name: `Select ${AVAILABLE_SKILL}`,
  });
  await expect(selectedSkill).toBeChecked();
  await expect(availableSkill).not.toBeChecked();
  await dialog.getByRole('button', { name: 'Close' }).click();
  await expect(dialog).toHaveCount(0);
}

async function runWithAdvisor(providerConfig, options, fn) {
  const userDataDir = makeUserDataDir(providerConfig.provider);
  seedSkills(userDataDir, providerConfig);
  seedInventoryCache(userDataDir, providerConfig);
  seedPreferences(userDataDir, {
    model: providerConfig.model,
    pluginSelections: options.defaultPluginSelections,
  });

  const { electronApp, advisor } = await openAdvisor(userDataDir);
  try {
    // App Advisor defaults are lane-aware and may migrate a persisted model
    // when the harness has no matching authenticated billing lane. Select the
    // provider through the same picker a user sees, then assert it before the
    // provider-specific discovery cache is exercised.
    await selectAndExpectAdvisorProvider(advisor, providerConfig);
    await fn({ advisor, userDataDir });
  } finally {
    await closeCanopy(electronApp, userDataDir);
    if (options.scenarioKey) {
      await clearScenario(DEFAULT_MOCK_BASE_URL, options.scenarioKey).catch(
        () => undefined,
      );
    }
  }
}

test.describe('App Advisor plugin slash menu', () => {
  for (const providerConfig of PROVIDERS) {
    test(`${providerConfig.provider}: fresh chat with no plugins gets an agent response`, async () => {
      test.setTimeout(180_000);
      const marker = `Canopy-CAPP-ADVISOR-NO-PLUGIN-${providerConfig.provider.toUpperCase()}`;
      const reply = `${providerConfig.provider} App Advisor no-plugin reply`;
      await registerScenario(DEFAULT_MOCK_BASE_URL, marker, {
        llm: { steps: [{ text: reply, stopReason: 'end_turn' }] },
      });

      await runWithAdvisor(
        providerConfig,
        { scenarioKey: marker },
        async ({ advisor }) => {
          await sendAdvisorMessageAndExpectReply(advisor, { marker, reply });
        },
      );
    });

    test(`${providerConfig.provider}: enabling a skill after an existing turn exposes actionable slash rows`, async () => {
      test.setTimeout(210_000);
      const marker = `Canopy-CAPP-ADVISOR-EXISTING-${providerConfig.provider.toUpperCase()}`;
      const reply = `${providerConfig.provider} App Advisor existing-chat reply`;
      await registerScenario(DEFAULT_MOCK_BASE_URL, marker, {
        llm: { steps: [{ text: reply, stopReason: 'end_turn' }] },
      });

      await runWithAdvisor(
        providerConfig,
        { scenarioKey: marker },
        async ({ advisor }) => {
          await sendAdvisorMessageAndExpectReply(advisor, { marker, reply });
          await enableSelectedSkill(advisor, providerConfig.selectedSkill);
          await expectSlashMenuAndSelectAvailable(advisor, providerConfig);
        },
      );
    });

    test(`${providerConfig.provider}: fresh chat exposes default skill selections before sending`, async () => {
      test.setTimeout(210_000);
      const marker = `Canopy-CAPP-ADVISOR-DEFAULT-SKILL-${providerConfig.provider.toUpperCase()}`;
      const reply = `${providerConfig.provider} App Advisor default-skill reply`;
      await registerScenario(DEFAULT_MOCK_BASE_URL, marker, {
        llm: { steps: [{ text: reply, stopReason: 'end_turn' }] },
      });

      await runWithAdvisor(
        providerConfig,
        {
          scenarioKey: marker,
          defaultPluginSelections: skillSelections(
            providerConfig.selectedSkill,
          ),
        },
        async ({ advisor }) => {
          // A fresh provider thread has no live discovery result yet. The
          // unified `/` menu therefore shows composer commands only; default
          // skill state remains user-visible and actionable in Plugins.
          await expectDefaultSkillSelections(advisor, providerConfig);
          await sendAdvisorMessageAndExpectReply(advisor, { marker, reply });
        },
      );
    });
  }
});
