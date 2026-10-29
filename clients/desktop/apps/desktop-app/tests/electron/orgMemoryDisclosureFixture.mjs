// CAN-2840: exercise real memory retrieval and provider dispatch, not a seeded
// memory-used event. The provider only returns this reply when the hidden
// memory marker reaches its input; the visible user prompt omits that marker.
//
// CAN-3457: org memory searches only the org that owns the chat's project, so
// the demo workspace is seeded as owned by the mock account's memory org
// unless `owned: false` asks for a Personal project (which must not search).
//
// CAN-3477: a Cowork workspace follows its saved owner, so `surface: 'cowork'`
// runs the same turn in a seeded Cowork chat whose `workspace.json` owner is
// the memory org (or Personal when `owned: false`).
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import {
  registerScenario,
  seedCoworkWorkspace,
  seedWorktreeChat,
  DEFAULT_MOCK_BASE_URL,
} from './seeders/index.mjs';

/** The mock account's memory-eligible org (`mock-server/routes/cloud.mjs`). */
export const MEMORY_ORGANIZATION_ID = '33333333-3333-4333-8333-333333333333';
export const MEMORY_ORGANIZATION_NAME = 'Acme Memory';
export const MEMORY_CLOUD_API_KEY = 'csk_memory_feedback_e2e';
/** Same account on its own key, so its search counters are spec-private. */
export const MEMORY_OWNER_CLOUD_API_KEY = 'csk_memory_owner_e2e';

/**
 * Marks a seeded workspace as owned by the memory org, the persisted owner
 * authority org memory resolves the searched org from.
 * @param {string} userDataDir
 * @param {string} workspaceId
 */
export function markWorkspaceOwnedByMemoryOrganization(
  userDataDir,
  workspaceId,
) {
  const configPath = path.join(
    userDataDir,
    'workspaces',
    workspaceId,
    'workspace.json',
  );
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  writeFileSync(
    configPath,
    `${JSON.stringify(
      {
        ...config,
        owner: {
          type: 'organization',
          organizationId: MEMORY_ORGANIZATION_ID,
          projectId: '44444444-4444-4444-8444-444444444441',
          instanceId: '55555555-5555-4555-8555-555555555551',
          bindingGeneration: 0,
        },
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
}

const MEMORY_REPLY_TEXT = 'The injected release memory reached this answer.';

/** The seeded Cowork workspace and its Work Entry (whose id is its chat id). */
export const MEMORY_COWORK_WORKSPACE_ID = 'memory-cowork';
export const MEMORY_COWORK_ENTRY_ID = 'memory-cowork-chat';

/**
 * Seeds a Cowork workspace with one existing Claude chat, since the memory
 * scenario drives the Claude mock. A neutral history message keeps the chat
 * visible in the sidebar, which intentionally hides unopened empty tasks.
 * @param {string} userDataDir
 */
function seedMemoryCoworkWorkspace(userDataDir) {
  seedCoworkWorkspace({
    userDataDir,
    workspaceId: MEMORY_COWORK_WORKSPACE_ID,
    name: 'Chats',
    chatId: MEMORY_COWORK_ENTRY_ID,
    chatTitle: 'Memory delivery',
    collapsed: false,
    providerType: 'claude',
    defaultModel: null,
    seedMessage: true,
  });
}

/**
 * Opens the seeded Cowork Work Entry from the sidebar.
 * @param {import('@playwright/test').Page} window
 */
async function openMemoryCoworkChat(window) {
  const toggle = window.getByTestId(
    `sidebar-cowork-project-${MEMORY_COWORK_WORKSPACE_ID}-toggle`,
  );
  await expect(toggle).toBeVisible({ timeout: 15_000 });
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') {
    await toggle.click();
  }
  await window
    .getByTestId(`sidebar-work-entry-${MEMORY_COWORK_ENTRY_ID}`)
    .click();
}

/**
 * Sends one real turn. An owned project waits for the reply the provider gives
 * only when the memory marker reached its input; a Personal project waits for
 * the turn to complete, since no memory (and so no marker) is expected.
 * `surface: 'cowork'` sends it from a Cowork chat instead of a project.
 * @param {{ owned?: boolean, apiKey?: string, surface?: 'project' | 'cowork' }} [options]
 */
export async function startOrgMemoryDisclosureChat({
  owned = true,
  apiKey = MEMORY_CLOUD_API_KEY,
  surface = 'project',
} = {}) {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-memory-disclosure-'),
  );
  if (surface === 'cowork') {
    seedMemoryCoworkWorkspace(userDataDir);
    if (owned) {
      markWorkspaceOwnedByMemoryOrganization(
        userDataDir,
        MEMORY_COWORK_WORKSPACE_ID,
      );
    }
  } else {
    seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
    if (owned) {
      markWorkspaceOwnedByMemoryOrganization(userDataDir, 'demo-ts-pnpm-vite');
    }
    seedWorktreeChat({
      userDataDir,
      workspaceId: 'demo-ts-pnpm-vite',
      worktreeId: 'demo-main',
      providerType: 'claude',
      tabs: [{ id: 'memory-chat', title: 'Memory delivery' }],
    });
  }
  await registerScenario(DEFAULT_MOCK_BASE_URL, 'Canopy-CORGMEMORY', {
    llm: {
      steps: [
        {
          text: MEMORY_REPLY_TEXT,
          stopReason: 'end_turn',
        },
      ],
    },
  });
  const running = await launchCanopy({ userDataDir });
  try {
    const window = await running.electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    const saved = await window.evaluate(
      async (key) => window.api.saveCanopyCloudApiKey({ apiKey: key }),
      apiKey,
    );
    expect(saved.status).toMatchObject({
      authenticated: true,
      capabilities: expect.arrayContaining(['memorySearch']),
    });
    if (surface === 'cowork') {
      await openMemoryCoworkChat(window);
    } else {
      await app.selectWorktree('demo-main');
    }
    const panel = window
      .locator('[data-testid="panel-content-chat"]:visible')
      .first();
    await expect(panel).toBeVisible();
    const composerRoot = panel.locator('[data-chat-composer-root]');
    await composerRoot
      .getByRole('textbox')
      .first()
      .fill('What should I know before preparing the next release?');
    await composerRoot.getByRole('button', { name: 'Send message' }).click();
    if (owned) {
      await expect(panel.getByText(MEMORY_REPLY_TEXT).first()).toBeVisible({
        timeout: 90_000,
      });
    }
    await expect(panel.getByText(/Completed in/).first()).toBeVisible({
      timeout: 90_000,
    });
    return { ...running, window, panel };
  } catch (error) {
    await closeCanopy(running.electronApp, userDataDir);
    throw error;
  }
}
