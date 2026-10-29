// CAN-3562: the Private memory toggle in project settings and Add project.
// Covers the real dialogs over the real main-process write path: the value
// lands in `workspace.json`, survives a relaunch for code and Cowork projects,
// an organization-managed value is read-only, and a project added with the
// toggle on is already private when it first opens.
import { expect, test } from '@playwright/test';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CanopyAppDriver } from './canopyApp.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { seedCoworkWorkspace } from './seeders/index.mjs';
import {
  DEFAULT_MOCK_BASE_URL,
  getScenarioActivity,
  registerScenario,
  seedWorktreeChat,
} from './seeders/index.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { withBundledBinaryOverridesScrubbed } from './seeders/bundledBinaryOverrides.mjs';
import { markWorkspaceOwnedByMemoryOrganization } from './orgMemoryDisclosureFixture.mjs';

const EXPLANATION =
  "Agents won't use memory from other projects or your organization. New memories stay here.";
const CODE_PROJECT = 'TypeScript pnpm Vite';

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

function workspaceConfigPath(userDataDir, workspaceId) {
  return path.join(userDataDir, 'workspaces', workspaceId, 'workspace.json');
}

function workspaceIdByName(userDataDir, name) {
  const index = readJson(path.join(userDataDir, 'workspaces', 'index.json'));
  return index.workspaces.find((entry) => entry.name === name)?.id;
}

async function openShell(electronApp) {
  const window = await electronApp.firstWindow();
  const app = new CanopyAppDriver(window);
  await app.waitForShell({ timeout: 30_000 });
  return { window, app };
}

async function openCodeSettings(window, app) {
  await app.selectWorktree('demo-main');
  await app.workspaceHeaderLabel(CODE_PROJECT).hover();
  await app.workspaceSettingsButton(CODE_PROJECT).click();
  const dialog = window
    .locator('[role="dialog"]')
    .filter({ has: window.locator('#project-settings-title') });
  await expect(dialog).toBeVisible();
  return dialog;
}

async function openCoworkSettings(window, app, workspaceId) {
  await app.openChatPage();
  const rowTestId = `sidebar-cowork-project-${workspaceId}`;
  await window.getByTestId(`${rowTestId}-header`).hover();
  await window.getByTestId(`${rowTestId}-settings`).click();
  const dialog = window
    .locator('[role="dialog"]')
    .filter({ has: window.locator('#chat-project-settings-title') });
  await expect(dialog).toBeVisible();
  return dialog;
}

test('a code project keeps Private memory across a relaunch', async () => {
  const first = await launchCanopy({
    seedDemoWorkspaces: true,
    demoWorkspaceApps: ['ts-pnpm-vite'],
  });
  const { userDataDir } = first;
  let electronApp = first.electronApp;
  let keepUserData = true;
  try {
    let { window, app } = await openShell(electronApp);
    let dialog = await openCodeSettings(window, app);
    const card = dialog.getByTestId('project-settings-private-memory');
    await expect(card).toContainText('Private memory');
    await expect(card).toContainText(EXPLANATION);
    let toggle = dialog.getByTestId('project-settings-private-memory-toggle');
    await expect(toggle).toHaveAttribute('aria-checked', 'false');
    // Untouched, there is nothing to save.
    await expect(
      dialog.getByRole('button', { name: 'Save local', exact: true }),
    ).toHaveCount(0);

    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-checked', 'true');
    await dialog
      .getByRole('button', { name: 'Save local', exact: true })
      .click();
    await expect(dialog).toBeHidden();

    const workspaceId = workspaceIdByName(userDataDir, CODE_PROJECT);
    expect(workspaceId).toBeTruthy();
    const configPath = workspaceConfigPath(userDataDir, workspaceId);
    await expect.poll(() => readJson(configPath).privateMemory).toBe(true);
    // A personal project's value is never marked as organization-managed.
    expect(readJson(configPath).privateMemoryManagedBy).toBeUndefined();

    await closeCanopy(electronApp, userDataDir, { keepUserData: true });
    electronApp = (await launchCanopy({ userDataDir })).electronApp;
    ({ window, app } = await openShell(electronApp));
    dialog = await openCodeSettings(window, app);
    toggle = dialog.getByTestId('project-settings-private-memory-toggle');
    await expect(toggle).toHaveAttribute('aria-checked', 'true');
    await expect(toggle).toBeEnabled();

    // Off is saved as an explicit value, and the rows refresh in place.
    await toggle.click();
    await dialog
      .getByRole('button', { name: 'Save local', exact: true })
      .click();
    await expect(dialog).toBeHidden();
    await expect.poll(() => readJson(configPath).privateMemory).toBe(false);
    dialog = await openCodeSettings(window, app);
    await expect(
      dialog.getByTestId('project-settings-private-memory-toggle'),
    ).toHaveAttribute('aria-checked', 'false');
    keepUserData = false;
  } finally {
    await closeCanopy(electronApp, userDataDir, { keepUserData });
    if (keepUserData) await closeCanopy(electronApp, userDataDir);
  }
});

test('a Cowork project keeps Private memory across a relaunch', async () => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-private-memory-cowork-'),
  );
  const workspaceId = 'private-memory-cowork';
  seedCoworkWorkspace({
    userDataDir,
    workspaceId,
    name: 'Research notes',
    collapsed: false,
  });
  const configPath = workspaceConfigPath(userDataDir, workspaceId);
  // A project from before the setting existed has no field at all.
  expect(readJson(configPath).privateMemory).toBeUndefined();

  let electronApp = (await launchCanopy({ userDataDir })).electronApp;
  try {
    let { window, app } = await openShell(electronApp);
    let dialog = await openCoworkSettings(window, app, workspaceId);
    const card = dialog.getByTestId('chat-project-settings-private-memory');
    await expect(card).toContainText(EXPLANATION);
    let toggle = dialog.getByTestId(
      'chat-project-settings-private-memory-toggle',
    );
    await expect(toggle).toHaveAttribute('aria-checked', 'false');
    await toggle.click();
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect.poll(() => readJson(configPath).privateMemory).toBe(true);

    // The refreshed row seeds the next open without a relaunch.
    dialog = await openCoworkSettings(window, app, workspaceId);
    await expect(
      dialog.getByTestId('chat-project-settings-private-memory-toggle'),
    ).toHaveAttribute('aria-checked', 'true');

    await closeCanopy(electronApp, userDataDir, { keepUserData: true });
    electronApp = (await launchCanopy({ userDataDir })).electronApp;
    ({ window, app } = await openShell(electronApp));
    dialog = await openCoworkSettings(window, app, workspaceId);
    toggle = dialog.getByTestId('chat-project-settings-private-memory-toggle');
    await expect(toggle).toHaveAttribute('aria-checked', 'true');
    await expect(toggle).toBeEnabled();
    expect(readJson(configPath).privateMemory).toBe(true);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('an organization-managed value is shown locked and cannot be changed', async () => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-private-memory-managed-'),
  );
  const workspaceId = 'private-memory-managed';
  seedCoworkWorkspace({
    userDataDir,
    workspaceId,
    name: 'Managed research',
    collapsed: false,
  });
  const configPath = workspaceConfigPath(userDataDir, workspaceId);
  // The marker only holds on an organization-owned project: main clears it
  // from a project with no owner, as it does when one is detached. The
  // materialization writer stamps the value and its marker together.
  markWorkspaceOwnedByMemoryOrganization(userDataDir, workspaceId);
  writeFileSync(
    configPath,
    JSON.stringify(
      {
        ...readJson(configPath),
        privateMemory: true,
        privateMemoryManagedBy: 'organization',
      },
      null,
      2,
    ),
    'utf8',
  );

  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const { window, app } = await openShell(electronApp);
    const dialog = await openCoworkSettings(window, app, workspaceId);
    const toggle = dialog.getByTestId(
      'chat-project-settings-private-memory-toggle',
    );
    await expect(toggle).toHaveAttribute('aria-checked', 'true');
    await expect(toggle).toBeDisabled();
    await expect(
      dialog.getByTestId('chat-project-settings-private-memory-managed'),
    ).toHaveText('Managed by your organization');
    await expect(
      dialog.getByTestId('chat-project-settings-private-memory'),
    ).toContainText(EXPLANATION);

    // A stale renderer cannot bypass the lock: main refuses the write.
    const refusal = await window.evaluate(
      (id) =>
        window.api
          .setWorkspacePrivateMemory({ workspaceId: id, privateMemory: false })
          .then(
            () => null,
            (error) => String(error?.message ?? error),
          ),
      workspaceId,
    );
    expect(refusal).toContain('Private memory is managed by your organization');
    expect(readJson(configPath).privateMemory).toBe(true);
    expect(readJson(configPath).privateMemoryManagedBy).toBe('organization');
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('Add project applies Private memory before a new project first opens', async () => {
  test.setTimeout(180_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-private-memory-first-open-'),
  );
  writeFileSync(
    path.join(userDataDir, 'preferences.json'),
    JSON.stringify({ version: 1, preferences: { localMemoryEnabled: true } }),
    'utf8',
  );
  const userMarker = 'Canopy-C3562FIRSTUSER';
  const projectMarker = 'Canopy-C3562FIRSTPROJECT';
  const userMemoryDir = path.join(userDataDir, 'memory');
  mkdirSync(userMemoryDir, { recursive: true });
  writeFileSync(
    path.join(userMemoryDir, 'MEMORY.md'),
    `# Memory Index\n- [${userMarker}] User-only answer.\n`,
    'utf8',
  );
  await registerScenario(DEFAULT_MOCK_BASE_URL, userMarker, {
    llm: { steps: [{ text: 'User memory leaked', stopReason: 'end_turn' }] },
  });
  await registerScenario(DEFAULT_MOCK_BASE_URL, projectMarker, {
    llm: {
      steps: [{ text: 'First project memory used', stopReason: 'end_turn' }],
    },
  });
  const { electronApp } = await withBundledBinaryOverridesScrubbed(() =>
    launchCanopy({ userDataDir }),
  );
  try {
    const { window, app } = await openShell(electronApp);
    await app.openMainPage();

    async function addCoworkProject(name, { privateMemory }) {
      // The add button is hover-revealed; the keyboard path avoids pointer flake.
      await window.getByTestId('sidebar-section-code-add').focus();
      await window.getByTestId('sidebar-section-code-add').press('Enter');
      const dialog = window.getByTestId('add-workspace-modal');
      await expect(dialog).toBeVisible();
      await dialog.getByTestId('add-workspace-mode-create').click();
      await dialog.getByTestId('add-workspace-type-cowork').click();
      // A compact switch beside the create button (CAN-3909).
      const toggle = dialog.getByTestId('add-workspace-private-memory-toggle');
      // Every Personal create starts with the toggle off.
      await expect(toggle).toHaveAttribute('aria-checked', 'false');
      // The explanation is the info button's tooltip.
      await dialog.getByTestId('add-workspace-private-memory-info').hover();
      await expect(window.getByRole('tooltip')).toContainText(EXPLANATION);
      if (privateMemory) {
        await toggle.click();
        await expect(toggle).toHaveAttribute('aria-checked', 'true');
      }
      await dialog.getByTestId('add-workspace-name-input').fill(name);
      await dialog.getByTestId('add-workspace-create-submit').click();
      await expect(dialog).toBeHidden();
      await expect
        .poll(() => workspaceIdByName(userDataDir, name))
        .toBeTruthy();
      return workspaceIdByName(userDataDir, name);
    }

    const privateId = await addCoworkProject('Private notes', {
      privateMemory: true,
    });
    // The dialog only closes once the project is opened, and it is opened
    // only after the value is saved: the first chat starts private.
    expect(
      readJson(workspaceConfigPath(userDataDir, privateId)).privateMemory,
    ).toBe(true);
    const projectMemoryDir = path.join(
      userDataDir,
      'workspaces',
      privateId,
      'memory',
    );
    mkdirSync(projectMemoryDir, { recursive: true });
    writeFileSync(
      path.join(projectMemoryDir, 'MEMORY.md'),
      `# Memory Index\n- [${projectMarker}] Project-only answer.\n`,
      'utf8',
    );
    await expect(window.getByTestId('cowork-top-bar')).toBeVisible();
    const composer = window.getByRole('textbox').first();
    await composer.click();
    await composer.fill('Which memory answer applies to this new project?');
    await window.getByRole('button', { name: 'Send message' }).click();
    await expect(
      window
        .getByTestId('panel-content-chat')
        .getByText('First project memory used'),
    ).toBeVisible({ timeout: 90_000 });
    expect(
      (await getScenarioActivity(DEFAULT_MOCK_BASE_URL, userMarker)).activity
        .llmRequests ?? 0,
    ).toBe(0);
    const privateSettings = await openCoworkSettings(window, app, privateId);
    await expect(
      privateSettings.getByTestId(
        'chat-project-settings-private-memory-toggle',
      ),
    ).toHaveAttribute('aria-checked', 'true');
    await window.keyboard.press('Escape');
    await expect(privateSettings).toBeHidden();

    await app.openMainPage();
    const sharedId = await addCoworkProject('Shared notes', {
      privateMemory: false,
    });
    // Off writes nothing: the project keeps today's shared-memory behavior
    // and its config stays free of an explicit value.
    expect(
      readJson(workspaceConfigPath(userDataDir, sharedId)).privateMemory,
    ).toBeUndefined();
    // The earlier choice never leaks onto another project.
    expect(
      readJson(workspaceConfigPath(userDataDir, privateId)).privateMemory,
    ).toBe(true);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('a private project injects its own memory without user memory', async () => {
  test.setTimeout(180_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-private-memory-injection-'),
  );
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite', 'ts-npm-next'] });
  const workspaceId = 'demo-ts-pnpm-vite';
  const configPath = workspaceConfigPath(userDataDir, workspaceId);
  writeFileSync(
    configPath,
    JSON.stringify({ ...readJson(configPath), privateMemory: true }),
    'utf8',
  );
  seedWorktreeChat({
    userDataDir,
    workspaceId,
    worktreeId: 'demo-main',
    providerType: 'claude',
    tabs: [{ id: 't1', title: 'Chat' }],
  });
  seedWorktreeChat({
    userDataDir,
    workspaceId: 'demo-ts-npm-next',
    worktreeId: 'demo-main',
    providerType: 'claude',
    tabs: [{ id: 't2', title: 'Chat' }],
  });
  writeFileSync(
    path.join(userDataDir, 'preferences.json'),
    JSON.stringify({ version: 1, preferences: { localMemoryEnabled: true } }),
    'utf8',
  );
  const userMarker = 'Canopy-C3562USER';
  const projectMarker = 'Canopy-C3562PROJECT';
  const userMemoryDir = path.join(userDataDir, 'memory');
  const projectMemoryDir = path.join(
    userDataDir,
    'workspaces',
    workspaceId,
    'memory',
  );
  mkdirSync(userMemoryDir, { recursive: true });
  mkdirSync(projectMemoryDir, { recursive: true });
  writeFileSync(
    path.join(userMemoryDir, 'MEMORY.md'),
    `# Memory Index\n- [${userMarker}] User-only answer.\n`,
    'utf8',
  );
  writeFileSync(
    path.join(projectMemoryDir, 'MEMORY.md'),
    `# Memory Index\n- [${projectMarker}] Project-only answer.\n`,
    'utf8',
  );
  await registerScenario(DEFAULT_MOCK_BASE_URL, userMarker, {
    llm: { steps: [{ text: 'User memory leaked', stopReason: 'end_turn' }] },
  });
  await registerScenario(DEFAULT_MOCK_BASE_URL, projectMarker, {
    llm: { steps: [{ text: 'Project memory used', stopReason: 'end_turn' }] },
  });

  const { electronApp } = await withBundledBinaryOverridesScrubbed(() =>
    launchCanopy({ userDataDir }),
  );
  try {
    const { window, app } = await openShell(electronApp);
    await app.openMainPage();
    const privateRow = window.locator(
      '[data-sidebar-workspace-id="demo-ts-pnpm-vite"] [data-testid="worktree-row"]',
    );
    await expect(privateRow).toBeVisible();
    await privateRow.evaluate((element) => element.click());
    await expect(window.getByTestId('panel-content-chat')).toBeVisible();
    const composer = window.getByRole('textbox').first();
    await composer.click();
    await composer.fill('Which memory answer applies to this project?');
    await window.getByRole('button', { name: 'Send message' }).click();
    await expect(
      window.getByTestId('panel-content-chat').getByText('Project memory used'),
    ).toBeVisible({ timeout: 90_000 });
    expect(
      (await getScenarioActivity(DEFAULT_MOCK_BASE_URL, userMarker)).activity
        .llmRequests ?? 0,
    ).toBe(0);
    const privateRequestsBefore =
      (await getScenarioActivity(DEFAULT_MOCK_BASE_URL, projectMarker)).activity
        .llmRequests ?? 0;
    expect(privateRequestsBefore).toBeGreaterThan(0);

    // Remove the user note so a different project's next turn has no memory
    // source of its own. The private project's marker must stay at one request.
    rmSync(path.join(userMemoryDir, 'MEMORY.md'));
    const otherRow = window.locator(
      '[data-sidebar-workspace-id="demo-ts-npm-next"] [data-testid="worktree-row"]',
    );
    await expect(otherRow).toBeVisible();
    await otherRow.evaluate((element) => element.click());
    await expect(window.getByTestId('panel-content-chat')).toBeVisible();
    const otherComposer = window.getByRole('textbox').first();
    await otherComposer.click();
    await otherComposer.fill(
      'Which memory answer applies to this other project?',
    );
    await window.getByRole('button', { name: 'Send message' }).click();
    await expect(
      window
        .getByTestId('panel-content-chat')
        .getByText('Mock response from the Canopy UI-automation LLM surface.'),
    ).toBeVisible({ timeout: 90_000 });
    expect(
      (await getScenarioActivity(DEFAULT_MOCK_BASE_URL, projectMarker)).activity
        .llmRequests,
    ).toBe(privateRequestsBefore);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
