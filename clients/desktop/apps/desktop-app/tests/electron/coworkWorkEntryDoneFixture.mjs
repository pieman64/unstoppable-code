/**
 * Shared seed + navigation helpers for the Cowork Work Entry "Done" specs
 * (`cowork-work-entry-done.spec.mjs` and its capture sibling).
 *
 * Lives outside `*.spec.mjs` on purpose: importing a spec file would re-register
 * its `test()` calls under the importing file, so both specs would run twice.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect } from '@playwright/test';

const NOW = new Date().toISOString();

export const WORKSPACE_ID = 'delivery-cowork';
export const ENTRY_ID = 'entry-refunds';

function writeJson(filePath, value) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

/**
 * Seeds a Cowork workspace holding one renamed (ticket-linked) Work Entry with
 * a single chat, which is the exact shape the Impact delivery track scores.
 * Returns the workspace directory so callers can read `work-entries.json` back.
 */
export function seedDeliveryCoworkWorkspace(userDataDir) {
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
        cowork: { createdAt: NOW, archiveRetentionDays: 7 },
      },
    ],
  });
  writeJson(path.join(workspaceDir, 'workspace.json'), {
    version: 1,
    type: 'cowork',
    repos: [],
    cowork: { createdAt: NOW, archiveRetentionDays: 7 },
  });
  writeJson(path.join(workspaceDir, 'work-entries.json'), {
    version: 1,
    entries: [{ id: ENTRY_ID, title: 'SUP-1234 Refund flow', createdAt: NOW }],
  });
  writeJson(path.join(workspaceDir, 'chats', `${ENTRY_ID}.json`), {
    version: 1,
    activeTabId: 'chat-refunds',
    tabs: [
      {
        id: 'chat-refunds',
        title: 'SUP-1234 Refund flow',
        kind: 'chat',
        providerType: 'claude',
        createdAt: NOW,
        messages: [
          {
            id: 'chat-refunds-message',
            role: 'user',
            blocks: [{ type: 'text', text: 'Draft the refund policy doc.' }],
            timestamp: Date.parse(NOW),
          },
        ],
      },
    ],
  });
  return workspaceDir;
}

export async function expandCoworkWorkspace(window, workspaceId) {
  const toggle = window.getByTestId(
    `sidebar-cowork-project-${workspaceId}-toggle`,
  );
  await expect(toggle).toBeVisible({ timeout: 15_000 });
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') {
    await toggle.click();
  }
}

/**
 * Opens the entry row's "…" menu. The action rail is `pointer-events-none`
 * until the row is hovered, so hover first — otherwise the title `<p>` wins
 * the hit test and the click retries until it times out.
 */
export async function openWorkEntryMenu(window, entryId) {
  await window.getByTestId(`sidebar-work-entry-${entryId}`).hover();
  await window
    .getByTestId(`sidebar-work-entry-${entryId}-menu`)
    .click({ force: true });
}

/** Persisted status for the seeded entry (`undefined` when active/unset). */
export function readEntryStatus(workspaceDir, entryId = ENTRY_ID) {
  const file = JSON.parse(
    readFileSync(path.join(workspaceDir, 'work-entries.json'), 'utf8'),
  );
  return file.entries.find((entry) => entry.id === entryId)?.status;
}
