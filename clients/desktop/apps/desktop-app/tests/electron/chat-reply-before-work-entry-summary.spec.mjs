// CAN-5250: a durable chat reply must render while the Work Entry registry
// lock is busy. The E2E summary gate (`CANOPY_E2E_WORK_ENTRY_SUMMARY_GATE_DIR`)
// holds the registry lock inside the real summary write; the reply streams from
// the mock provider and must appear before the summary reaches
// work-entries.json, which then catches up once the lock is released.

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { withBundledBinaryOverridesScrubbed } from './seeders/bundledBinaryOverrides.mjs';
import { writeJson } from './seeders/fsHelpers.mjs';
import { DEFAULT_MOCK_BASE_URL, registerScenario } from './seeders/index.mjs';

const WORKSPACE_ID = 'summary-lock-cowork';
const ENTRY_ID = 'summary-lock-entry';
const CHAT_ID = 'summary-lock-chat';
const MARKER = 'Canopy-CSUMMARYLOCK';
const REPLY = 'The reply rendered while the Work Entry registry was busy';
const SEEDED_AT = '2026-10-01T10:00:00.000Z';

function seedCoworkEntry(userDataDir) {
  writeJson(path.join(userDataDir, 'preferences.json'), {
    version: 1,
    preferences: { onboardingCompleted: ['v1'] },
  });
  const workspaceDir = path.join(userDataDir, 'workspaces', WORKSPACE_ID);
  writeJson(path.join(userDataDir, 'workspaces', 'index.json'), {
    version: 1,
    workspaces: [
      {
        id: WORKSPACE_ID,
        name: 'Support',
        type: 'cowork',
        color: '#7C9B6D',
        collapsed: false,
        order: 0,
        cowork: { createdAt: SEEDED_AT, archiveRetentionDays: null },
      },
    ],
  });
  mkdirSync(path.join(workspaceDir, 'home'), { recursive: true });
  writeJson(path.join(workspaceDir, 'workspace.json'), {
    version: 1,
    type: 'cowork',
    cowork: {
      createdAt: SEEDED_AT,
      defaultModel: 'claude-sonnet-4-6',
      searchIndexingEnabled: false,
      archiveRetentionDays: null,
    },
  });
  writeJson(path.join(workspaceDir, 'work-entries.json'), {
    version: 1,
    entries: [{ id: ENTRY_ID, createdAt: SEEDED_AT }],
  });
  writeJson(path.join(workspaceDir, 'chats', `${ENTRY_ID}.json`), {
    version: 1,
    activeTabId: CHAT_ID,
    tabs: [
      {
        id: CHAT_ID,
        title: 'Summary lock',
        createdAt: SEEDED_AT,
        kind: 'chat',
        providerType: 'claude',
        model: 'claude-sonnet-4-6',
        approvalMode: 'full-access',
        messages: [
          {
            id: 'summary-lock-seed-user',
            role: 'user',
            blocks: [{ type: 'text', text: 'Start the support notes.' }],
            timestamp: Date.parse(SEEDED_AT),
          },
        ],
      },
    ],
  });
  return workspaceDir;
}

function readPersistedChatSummary(workspaceDir) {
  const file = JSON.parse(
    readFileSync(path.join(workspaceDir, 'work-entries.json'), 'utf8'),
  );
  return file.entries
    .find((entry) => entry.id === ENTRY_ID)
    ?.summary?.chats?.find((chat) => chat.id === CHAT_ID);
}

test('a Cowork reply renders while its Work Entry summary waits on the registry lock', async () => {
  test.setTimeout(240_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-reply-before-summary-'),
  );
  const gateDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-e2e-work-entry-summary-gate-'),
  );
  const hold = path.join(gateDir, 'hold');
  const workspaceDir = seedCoworkEntry(userDataDir);
  await registerScenario(DEFAULT_MOCK_BASE_URL, MARKER, {
    llm: { steps: [{ text: REPLY, stopReason: 'end_turn' }] },
  });
  const { electronApp } = await withBundledBinaryOverridesScrubbed(() =>
    launchCanopy({
      userDataDir,
      env: { CANOPY_E2E_WORK_ENTRY_SUMMARY_GATE_DIR: gateDir },
    }),
  );
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    const toggle = window.getByTestId(
      `sidebar-cowork-project-${WORKSPACE_ID}-toggle`,
    );
    if (
      (await toggle.isVisible()) &&
      (await toggle.getAttribute('aria-expanded')) !== 'true'
    )
      await toggle.click();
    await window.getByTestId(`sidebar-work-entry-${ENTRY_ID}`).click();
    const panel = window.locator(
      `[data-testid="panel-content-chat"][data-panel-id="panel-chat-${CHAT_ID}"]`,
    );
    await expect(panel).toBeVisible({ timeout: 30_000 });
    await expect(panel.getByText('Start the support notes.')).toBeVisible();

    await writeFile(hold, '1', 'utf8');
    const prompt = `[${MARKER}] Summarize the refund policy.`;
    const composer = panel.getByRole('textbox').first();
    await composer.fill(prompt);
    const sentAt = Date.now();
    await panel.getByRole('button', { name: 'Send message' }).click();

    // A summary write in this scope now holds the registry lock, so every
    // later summary write for this turn waits behind it.
    await expect
      .poll(() => existsSync(path.join(gateDir, 'entered')), {
        timeout: 30_000,
      })
      .toBe(true);
    await expect(panel.getByText(prompt).first()).toBeVisible({
      timeout: 30_000,
    });
    await expect(panel.getByText(REPLY).first()).toBeVisible({
      timeout: 60_000,
    });
    await expect(
      window.getByRole('button', { name: 'Stop generation', exact: true }),
    ).toHaveCount(0, { timeout: 30_000 });
    // The gate never let go (it gives up after 120s), so the reply above
    // rendered while the registry lock was held.
    expect(existsSync(path.join(gateDir, 'left'))).toBe(false);
    expect(readPersistedChatSummary(workspaceDir)?.lastMessageRole).not.toBe(
      'assistant',
    );

    rmSync(hold, { force: true });
    await expect
      .poll(() => readPersistedChatSummary(workspaceDir)?.lastMessageRole, {
        timeout: 30_000,
      })
      .toBe('assistant');
    // The marker works, so its absence above meant the lock was still held.
    expect(existsSync(path.join(gateDir, 'left'))).toBe(true);
    // Same host clock as the app; the slack absorbs millisecond rounding.
    expect(
      Date.parse(readPersistedChatSummary(workspaceDir).lastMessageAt),
    ).toBeGreaterThanOrEqual(sentAt - 1_000);
  } finally {
    rmSync(hold, { force: true });
    await closeCanopy(electronApp, userDataDir);
    rmSync(gateDir, { recursive: true, force: true });
  }
});
