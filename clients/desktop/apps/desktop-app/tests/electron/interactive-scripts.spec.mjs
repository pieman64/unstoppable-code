// interactive-scripts: schema/settings/activity/PTY regression coverage for
// interactive workspace scripts, plus agent-run scripts.
// The first test walks Activity → Run → confirmation → terminal input →
// monitored completion. The second drives DispatchAction over the worktree
// chat's authenticated MCP route, as an agent's tool call would: it lists the
// configured scripts, is refused an interactive script, starts one run, is
// refused a duplicate, waits for another, and checks each run in Scripts.
// Determinism: all workspace state is seeded locally; the commands use only
// the platform shell, and the only input is typed by the test.

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { openProjectSettingsPage } from './projectSettingsDriver.mjs';

const WORKSPACE_ID = 'demo-ts-pnpm-vite';
const WORKSPACE_NAME = 'TypeScript pnpm Vite';
const WORKTREE_ID = 'demo-main';
const COMMAND = `printf 'Name: '; read name; printf '\\nreceived:%s\\n' "$name"`;
const AGENT_CHECK_OUTPUT = 'agent-check-ok';
// Long enough to observe the running card and a refused duplicate.
const AGENT_SLOW_COMMAND =
  "printf 'agent-slow-started\\n'; sleep 8; printf 'agent-slow-done\\n'";

function seedInteractiveScript(userDataDir, { layoutMode = 'minimal' } = {}) {
  seedDemoWorkspaces({
    userDataDir,
    apps: ['ts-pnpm-vite'],
    checkRuntimes: false,
  });
  const configPath = path.join(
    userDataDir,
    'workspaces',
    WORKSPACE_ID,
    'workspace.json',
  );
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  config.scripts.wizard = {
    command: COMMAND,
    interactive: true,
    timeoutSeconds: 30,
  };
  config.scripts.teardown = {
    command: "printf 'teardown output\\n'",
    interactive: true,
    timeoutSeconds: 30,
  };
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  const worktreeDataDir = path.join(
    userDataDir,
    'workspaces',
    WORKSPACE_ID,
    'worktree-data',
    WORKTREE_ID,
  );
  mkdirSync(worktreeDataDir, { recursive: true });
  writeFileSync(
    path.join(worktreeDataDir, 'panel-layout-mode.json'),
    JSON.stringify({ version: 1, mode: layoutMode }),
    'utf8',
  );
  // Preserve an existing Activity rail for script execution coverage.
  writeFileSync(
    path.join(worktreeDataDir, 'panel-layout.json'),
    JSON.stringify({
      version: 1,
      grid: {
        orientation: 0,
        width: 1280,
        height: 800,
        root: {
          type: 'branch',
          size: 800,
          children: [
            {
              type: 'branch',
              size: 600,
              children: [
                {
                  type: 'leaf',
                  groupId: 'group-chat',
                  size: 960,
                  panels: [],
                  activePanelId: null,
                },
                {
                  type: 'leaf',
                  groupId: 'group-extras',
                  size: 320,
                  panels: [
                    {
                      panelId: 'panel-activity',
                      kind: 'activity-section',
                    },
                  ],
                  activePanelId: 'panel-activity',
                  collapsed: { edge: 'right', expandedSize: 320, auto: true },
                },
              ],
            },
            {
              type: 'leaf',
              groupId: 'group-terminal',
              size: 200,
              panels: [{ panelId: 'panel-terminal', kind: 'terminal' }],
              activePanelId: 'panel-terminal',
              collapsed: { edge: 'bottom', expandedSize: 200 },
            },
          ],
        },
      },
      activeGroupId: 'group-chat',
      mostRecentActiveGroupIds: ['group-chat'],
    }),
  );
}

function seedAgentScripts(userDataDir) {
  seedInteractiveScript(userDataDir);
  const configPath = path.join(
    userDataDir,
    'workspaces',
    WORKSPACE_ID,
    'workspace.json',
  );
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  config.scripts['agent-check'] = {
    command: `printf '${AGENT_CHECK_OUTPUT}\\n'`,
    timeoutSeconds: 30,
  };
  config.scripts['agent-slow'] = {
    command: AGENT_SLOW_COMMAND,
    timeoutSeconds: 30,
  };
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
}

// Calls DispatchAction exactly as an agent's MCP tool call does, over the
// authenticated worktree route for WORKSPACE_ID/WORKTREE_ID.
async function dispatchAsAgent(route, action) {
  const response = await fetch(route.url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${route.authToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: `agent-scripts-${action.type}`,
      method: 'tools/call',
      params: { name: 'DispatchAction', arguments: { action } },
    }),
    signal: AbortSignal.timeout(60_000),
  });
  expect(response.status).toBe(200);
  const envelope = await response.json();
  expect(envelope.error).toBeUndefined();
  const text = envelope.result?.content?.find(
    (item) => item.type === 'text',
  )?.text;
  if (typeof text !== 'string' || !text.startsWith('{')) {
    throw new Error(`DispatchAction was rejected: ${text}`);
  }
  return JSON.parse(text);
}

async function scriptsSection(window) {
  const title = window.getByRole('heading', { name: 'Scripts', exact: true });
  await expect(title).toBeVisible({ timeout: 45_000 });
  const section = title.locator('xpath=ancestor::section[1]');
  const expand = section.locator('[aria-label="Expand section"]');
  if (await expand.count()) await expand.first().click();
  return section;
}

test('script source info preserves fine-pointer reveal and activates on a coarse pointer', async () => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-electron-source-info-pointer-'),
  );
  // Scripts lives in the advanced Activity rail. Minimal starts with an
  // empty Side Panel, so merely opening that panel does not mount Scripts.
  seedInteractiveScript(userDataDir, { layoutMode: 'advanced' });
  const { electronApp } = await launchCanopy({ userDataDir });
  let cdp;

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_ID);
    const section = await scriptsSection(window);
    const row = section
      .getByTestId('activity-scripts-entry')
      .filter({ hasText: 'Wizard' });
    const info = row.getByRole('button', { name: 'Source info for Wizard' });

    await window.mouse.move(0, 0);
    await window.evaluate(() => document.activeElement?.blur());
    expect(
      await window.evaluate(() => matchMedia('(pointer: fine)').matches),
    ).toBe(true);
    await expect(info).toHaveCSS('opacity', '0');
    await row.hover();
    await expect(info).toHaveCSS('opacity', '1');
    await window.mouse.move(0, 0);
    await info.focus();
    await expect(info).toHaveCSS('opacity', '1');
    await info.blur();
    await expect(info).toHaveCSS('opacity', '0');

    cdp = await window.context().newCDPSession(window);
    await cdp.send('Emulation.setTouchEmulationEnabled', {
      enabled: true,
      maxTouchPoints: 1,
    });
    await expect
      .poll(() =>
        window.evaluate(() => matchMedia('(pointer: coarse)').matches),
      )
      .toBe(true);
    await expect(info).toHaveCSS('opacity', '1');
    const bounds = await info.boundingBox();
    expect(bounds).not.toBeNull();
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [
        { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 },
      ],
    });
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchEnd',
      touchPoints: [],
    });
    const dialog = window.getByRole('dialog', { name: 'Wizard', exact: true });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('Interactive terminal');
    await expect(window.getByTestId('terminal-pane')).toHaveCount(0);
  } finally {
    try {
      if (cdp) {
        await cdp.send('Emulation.setTouchEmulationEnabled', {
          enabled: false,
        });
        await cdp.detach();
      }
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  }
});

test('interactive script settings, activity affordance, and terminal execution', async () => {
  test.setTimeout(150_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-electron-interactive-scripts-'),
  );
  seedInteractiveScript(userDataDir);
  const { electronApp } = await launchCanopy({ userDataDir });

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_ID);

    const sidePanelToggle = window.getByTestId(
      'workspace-layout-side-panel-toggle',
    );
    await expect(sidePanelToggle).toBeVisible();
    if ((await sidePanelToggle.getAttribute('aria-pressed')) !== 'true') {
      await sidePanelToggle.click();
    }
    const section = await scriptsSection(window);
    const row = section
      .getByText('Wizard', { exact: true })
      .locator('xpath=ancestor::div[@data-testid="activity-scripts-entry"][1]');
    await expect(row).toBeVisible();
    // Scripts omits secondaryContent: its label and both actions retain
    // the original single-line shared-row layout.
    await expect
      .poll(() =>
        row.evaluate((element) => {
          const label = element.firstElementChild;
          if (!label) return false;
          const name = label.getBoundingClientRect();
          const bounds = element.getBoundingClientRect();
          return (
            getComputedStyle(element).display === 'flex' &&
            Array.from(element.querySelectorAll('button')).every((button) => {
              const action = button.getBoundingClientRect();
              return (
                action.top < name.bottom &&
                name.top < action.bottom &&
                action.right <= bounds.right + 1
              );
            })
          );
        }),
      )
      .toBe(true);
    const run = row.getByTestId('activity-scripts-run');
    await expect(run.getByTestId('interactive-script-icon')).toBeVisible();
    await expect(run).toHaveAttribute('aria-label', 'Run Wizard in terminal');
    const teardownRow = section
      .getByText('Teardown', { exact: true })
      .locator('xpath=ancestor::div[@data-testid="activity-scripts-entry"][1]');
    const teardownRun = teardownRow.getByTestId('activity-scripts-run');
    await expect(teardownRun.getByTestId('default-script-icon')).toBeVisible();
    await expect(
      teardownRun.getByTestId('interactive-script-icon'),
    ).toHaveCount(0);
    await expect(teardownRun).toContainText('Run');

    await row.getByRole('button', { name: 'Source info for Wizard' }).click();
    const infoDialog = window.getByRole('dialog', { name: 'Wizard' });
    await expect(infoDialog).toBeVisible();
    await expect(infoDialog).toContainText('Interactive terminal');
    await infoDialog.getByRole('button', { name: 'Close' }).click();

    await app.workspaceHeaderLabel(WORKSPACE_NAME).hover();
    await app.workspaceSettingsButton(WORKSPACE_NAME).click();
    const settings = window.getByRole('dialog', { name: WORKSPACE_NAME });
    await expect(settings).toBeVisible();
    // Each script opens its editor in place from its row.
    await openProjectSettingsPage(app, 'scripts');
    await settings.getByTestId('project-settings-script-edit-wizard').click();
    const wizardTextarea = settings.locator('textarea');
    const wizardIndex = await wizardTextarea.evaluateAll(
      (nodes, command) => nodes.findIndex((node) => node.value === command),
      COMMAND,
    );
    expect(wizardIndex).toBeGreaterThanOrEqual(0);
    const editor = wizardTextarea
      .nth(wizardIndex)
      .locator('xpath=ancestor::div[contains(@class,"space-y-2")][1]');
    const runtimeMode = editor.getByTestId('script-runtime-mode');
    await expect(runtimeMode).toBeVisible();
    await expect(
      runtimeMode.getByTestId('script-runtime-mode-interactive'),
    ).toHaveAttribute('aria-checked', 'true');
    await expect(
      runtimeMode.getByTestId('script-runtime-mode-background'),
    ).toHaveAttribute('aria-checked', 'false');
    // The timeout control is a Background-only affordance.
    await expect(editor.getByText('Timeout', { exact: true })).toHaveCount(0);

    await settings.getByTestId('project-settings-script-edit-teardown').click();
    const teardownIndex = await wizardTextarea.evaluateAll((nodes) =>
      nodes.findIndex((node) => node.value === "printf 'teardown output\\n'"),
    );
    expect(teardownIndex).toBeGreaterThanOrEqual(0);
    const teardownEditor = wizardTextarea
      .nth(teardownIndex)
      .locator('xpath=ancestor::div[contains(@class,"space-y-2")][1]');
    // Teardown seeds `interactive: true`, but the runner always forces
    // background for teardown phases, so the picker is locked to Background
    // and the timeout stays visible.
    const teardownRuntimeMode = teardownEditor.getByTestId(
      'script-runtime-mode',
    );
    await expect(teardownRuntimeMode).toBeVisible();
    await expect(
      teardownRuntimeMode.getByTestId('script-runtime-mode-background'),
    ).toHaveAttribute('aria-checked', 'true');
    await expect(
      teardownRuntimeMode.getByTestId('script-runtime-mode-interactive'),
    ).toHaveAttribute('aria-checked', 'false');
    await expect(
      teardownRuntimeMode.getByTestId('script-runtime-mode-interactive'),
    ).toBeDisabled();
    await expect(
      teardownEditor.getByText('Timeout', { exact: true }),
    ).toBeVisible();
    // Hovering the locked picker explains why it cannot be changed.
    await teardownRuntimeMode.hover();
    const lockedTooltip = window.getByTestId('script-runtime-mode-tooltip');
    await expect(lockedTooltip).toBeVisible();
    await expect(lockedTooltip).toHaveText(
      'Teardown scripts can only be run as background commands.',
    );
    await settings.getByTestId('project-settings-back').click();

    await run.click();
    await section.getByRole('button', { name: 'Confirm' }).click();
    const terminal = window.getByTestId('terminal-pane');
    await expect(terminal).toBeVisible({ timeout: 20_000 });
    await expect(
      window.getByTestId('panel-group-group-terminal'),
    ).toBeVisible();
    await expect(
      window.getByTestId('workspace-layout-terminal-toggle'),
    ).toHaveAttribute('aria-pressed', 'true');
    await expect
      .poll(() => terminal.innerText(), { timeout: 20_000 })
      .toContain('Name:');
    await terminal.click();
    await window.keyboard.type('Ada');
    await window.keyboard.press('Enter');
    await expect
      .poll(() => terminal.innerText(), { timeout: 20_000 })
      .toContain('received:Ada');
    await expect(row.getByTestId('activity-scripts-run')).toBeVisible({
      timeout: 20_000,
    });
    await expect(section.getByText(/Completed \(1\)/)).toBeVisible();
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('an agent lists and runs configured scripts and Scripts shows each run', async () => {
  test.setTimeout(150_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-electron-agent-scripts-'),
  );
  seedAgentScripts(userDataDir);
  const { electronApp } = await launchCanopy({ userDataDir });
  let route = null;

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_ID);

    const sidePanelToggle = window.getByTestId(
      'workspace-layout-side-panel-toggle',
    );
    await expect(sidePanelToggle).toBeVisible();
    if ((await sidePanelToggle.getAttribute('aria-pressed')) !== 'true') {
      await sidePanelToggle.click();
    }
    const section = await scriptsSection(window);
    await expect(
      section.getByText('Agent Check', { exact: true }),
    ).toBeVisible();

    route = await electronApp.evaluate(() =>
      globalThis.__CANOPY_E2E_BROWSER_MCP_ROUTE__({ kind: 'create' }),
    );

    const listed = await dispatchAsAgent(route, {
      type: 'worktree.list_scripts',
    });
    expect(listed.ok).toBe(true);
    const scripts = new Map(
      listed.result.scripts.map((script) => [script.scriptKey, script]),
    );
    expect(scripts.get('project:agent-check')).toMatchObject({
      label: 'Agent Check',
      lifecycle: 'custom',
      agentRunnable: true,
      running: false,
      lastRun: null,
    });
    expect(scripts.get('project:wizard')).toMatchObject({
      interactive: true,
      agentRunnable: false,
    });
    expect(scripts.get('project:teardown')).toMatchObject({
      agentRunnable: false,
    });
    // Commands stay out of the agent-facing listing.
    expect(JSON.stringify(listed)).not.toContain('printf');

    const interactive = await dispatchAsAgent(route, {
      type: 'worktree.run_script',
      scriptId: 'wizard',
    });
    expect(interactive).toMatchObject({
      ok: false,
      error: { code: 'invalid_target' },
    });
    await expect(window.getByTestId('terminal-pane')).toHaveCount(0);

    const started = await dispatchAsAgent(route, {
      type: 'worktree.run_script',
      scriptId: 'agent-slow',
    });
    expect(started).toMatchObject({
      ok: true,
      result: {
        scriptKey: 'project:agent-slow',
        started: true,
        finished: false,
        status: 'running',
      },
    });
    const duplicate = await dispatchAsAgent(route, {
      type: 'worktree.run_script',
      scriptId: 'agent-slow',
    });
    expect(duplicate).toMatchObject({
      ok: false,
      error: { code: 'invalid_target', retryable: true },
    });
    const runningCard = section
      .getByTestId('activity-scripts-entry')
      .filter({ hasText: 'Agent Slow' });
    await expect(
      runningCard.getByTestId('activity-scripts-stop'),
    ).toBeVisible();
    await expect(section.getByText(/Completed \(1\)/)).toBeVisible({
      timeout: 30_000,
    });

    const finished = await dispatchAsAgent(route, {
      type: 'worktree.run_script',
      scriptId: 'agent-check',
      waitSeconds: 30,
    });
    expect(finished).toMatchObject({
      ok: true,
      result: {
        scriptKey: 'project:agent-check',
        started: true,
        finished: true,
        status: 'succeeded',
        success: true,
        exitCode: 0,
      },
    });
    expect(finished.result.outputTail).toContain(AGENT_CHECK_OUTPUT);
    await expect(section.getByText(/Completed \(2\)/)).toBeVisible({
      timeout: 20_000,
    });
    await section.getByTestId('activity-scripts-completed-toggle').click();
    await expect(section.getByText(/^Success · \d+s$/)).toHaveCount(2);

    const relisted = await dispatchAsAgent(route, {
      type: 'worktree.list_scripts',
    });
    expect(
      relisted.result.scripts.find(
        (script) => script.scriptKey === 'project:agent-check',
      ),
    ).toMatchObject({
      running: false,
      lastRun: { status: 'succeeded', exitCode: 0 },
    });
  } finally {
    if (route) {
      await electronApp
        .evaluate(
          (_electron, sessionKey) =>
            globalThis.__CANOPY_E2E_BROWSER_MCP_ROUTE__({
              kind: 'delete',
              sessionKey,
            }),
          route.sessionKey,
        )
        .catch(() => {});
    }
    await closeCanopy(electronApp, userDataDir);
  }
});
