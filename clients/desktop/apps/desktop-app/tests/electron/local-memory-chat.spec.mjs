import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import {
  getScenarioActivity,
  registerScenario,
  seedWorktreeChat,
  DEFAULT_MOCK_BASE_URL,
} from './seeders/index.mjs';
import { withBundledBinaryOverridesScrubbed } from './seeders/bundledBinaryOverrides.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';

const WORKSPACE_ID = 'demo-ts-pnpm-vite';
const WORKTREE_ID = 'demo-main';
const WORKSPACE_NAME = 'TypeScript pnpm Vite';
const CONVERSATION_MARKER = 'Canopy-CLOCALMEMORY';
const ASSISTANT_REPLY = 'The next turn received the saved local memory';

test('a saved local memory note is injected into the next submitted turn', async () => {
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'local-memory-chat-'));
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    providerType: 'claude',
    tabs: [{ id: 't1', title: 'Chat' }],
  });

  // Seed the preference explicitly so this injection fixture remains
  // independent of the application default it is not intended to test.
  writeFileSync(
    path.join(userDataDir, 'preferences.json'),
    JSON.stringify(
      {
        version: 1,
        preferences: { localMemoryEnabled: true },
      },
      null,
      2,
    ),
    'utf8',
  );

  // The mock provider selects a scripted response only when this marker is in
  // submitted user text. The visible prompt below deliberately omits it, so
  // receiving ASSISTANT_REPLY proves the saved inbox note reached the provider.
  const inboxDir = path.join(userDataDir, 'memory', 'inbox');
  mkdirSync(inboxDir, { recursive: true });
  writeFileSync(
    path.join(inboxDir, '2026-08-05T12-00-00-saved-e2e-memory.md'),
    `---
source:
  provider: "e2e"
  chatId: "seed"
created: "2026-08-05T12:00:00.000Z"
modified: "2026-08-05T12:00:00.000Z"
type: inbox
---

[${CONVERSATION_MARKER}] The release verification command is npm run verify.
`,
    'utf8',
  );
  await registerScenario(DEFAULT_MOCK_BASE_URL, CONVERSATION_MARKER, {
    llm: { steps: [{ text: ASSISTANT_REPLY, stopReason: 'end_turn' }] },
  });

  const { electronApp } = await withBundledBinaryOverridesScrubbed(() =>
    launchCanopy({ userDataDir }),
  );
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    await expect(app.workspaceHeaderLabel(WORKSPACE_NAME)).toBeVisible();
    await app.selectWorktree(WORKTREE_ID);

    const panel = window.getByTestId('panel-content-chat');
    const composer = window.getByRole('textbox').first();
    const visiblePrompt =
      'What command should I run before preparing the next release?';
    await composer.click();
    await composer.fill(visiblePrompt);
    await window.getByRole('button', { name: 'Send message' }).click();

    await expect(panel.getByText(visiblePrompt).first()).toBeVisible({
      timeout: 30_000,
    });
    await expect(panel.getByText(ASSISTANT_REPLY).first()).toBeVisible({
      timeout: 90_000,
    });
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('a near-cap user index leaves project memory and recent notes injected', async () => {
  // Two full app launches run in this file and the scripted-reply wait alone
  // is allowed 90s; the 60s default budget flakes at the boundary.
  test.setTimeout(180_000);
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'local-memory-chat-'));
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    providerType: 'claude',
    tabs: [{ id: 't1', title: 'Chat' }],
  });
  writeFileSync(
    path.join(userDataDir, 'preferences.json'),
    JSON.stringify(
      { version: 1, preferences: { localMemoryEnabled: true } },
      null,
      2,
    ),
    'utf8',
  );

  // Only the scenario key may use the [Canopy-C...] form: the mock server
  // routes on the FIRST such marker in submitted text, so the user/note
  // sentinels are plain strings asserted via recorded activity instead.
  const USER_MARKER = 'FLOORS-USER-PIN-SENTINEL';
  const WORKSPACE_MARKER = 'Canopy-CFLOORSWS';
  const NOTE_MARKER = 'FLOORS-NOTE-SENTINEL';
  const workspaceReply = 'Project memory survived the fat user index';

  // Near-cap user index (~24KB over 200 lines). Before the per-section
  // floors, this consumed the entire 6KiB injection budget first-wins and
  // evicted the workspace index and recent notes; the scenario below keys on
  // the WORKSPACE marker, so this test fails on the pre-floors renderer.
  const userMemoryDir = path.join(userDataDir, 'memory');
  mkdirSync(userMemoryDir, { recursive: true });
  const fillerLines = Array.from(
    { length: 198 },
    (_, index) => `- filler entry ${index} ${'u'.repeat(110)}`,
  );
  writeFileSync(
    path.join(userMemoryDir, 'MEMORY.md'),
    `# Memory Index\n- ${USER_MARKER} pinned user fact\n${fillerLines.join('\n')}\n`,
    'utf8',
  );
  const workspaceMemoryDir = path.join(
    userDataDir,
    'workspaces',
    WORKSPACE_ID,
    'memory',
  );
  mkdirSync(workspaceMemoryDir, { recursive: true });
  writeFileSync(
    path.join(workspaceMemoryDir, 'MEMORY.md'),
    `# Memory Index\n- [${WORKSPACE_MARKER}] the staging port is 4788\n`,
    'utf8',
  );
  const inboxDir = path.join(userMemoryDir, 'inbox');
  mkdirSync(inboxDir, { recursive: true });
  writeFileSync(
    path.join(inboxDir, '2026-08-31T12-00-00-floors-note.md'),
    `---
source:
  provider: "e2e"
  chatId: "seed"
created: "2026-08-31T12:00:00.000Z"
modified: "2026-08-31T12:00:00.000Z"
type: inbox
---

${NOTE_MARKER} Recent note that must survive the fat user index.
`,
    'utf8',
  );

  await registerScenario(DEFAULT_MOCK_BASE_URL, WORKSPACE_MARKER, {
    llm: { steps: [{ text: workspaceReply, stopReason: 'end_turn' }] },
  });

  const { electronApp } = await withBundledBinaryOverridesScrubbed(() =>
    launchCanopy({ userDataDir }),
  );
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_ID);

    const panel = window.getByTestId('panel-content-chat');
    const composer = window.getByRole('textbox').first();
    const visiblePrompt = 'Which port does staging use?';
    await composer.click();
    await composer.fill(visiblePrompt);
    await window.getByRole('button', { name: 'Send message' }).click();

    await expect(panel.getByText(workspaceReply).first()).toBeVisible({
      timeout: 90_000,
    });

    // The scripted reply proves the workspace marker survived the near-cap
    // user index (the pre-floors renderer evicted it, so this wait times out
    // there). Activity counters confirm the scenario actually served it.
    const activity = await getScenarioActivity(
      DEFAULT_MOCK_BASE_URL,
      WORKSPACE_MARKER,
    );
    expect(activity.activity.llmRequests).toBeGreaterThanOrEqual(1);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
