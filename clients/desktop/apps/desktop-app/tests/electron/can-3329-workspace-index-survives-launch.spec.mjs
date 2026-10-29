// CAN-3329 — every project vanished from the sidebar after launching a new
// build: default "Chats" provisioning rewrote the workspace index from a
// mid-write read and dropped every other entry.
//
// This walks the incident's launch path: an existing profile whose index has
// projects but no default Chats entry, so the app provisions it on startup
// alongside its own sidebar saves. The mid-write read itself is a timing race
// with no UI seam; it is reproduced deterministically by
// `src/main/__tests__/workspace-index-integrity.test.ts`.
//
// Determinism: seeded cowork projects, no live agents, no network.

import { mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { seedCoworkWorkspace } from './seeders/index.mjs';
import { writeJson } from './seeders/fsHelpers.mjs';

const DEFAULT_COWORK_WORKSPACE_ID = 'cowork-default';
const PROJECTS = [
  { id: 'can3329-alpha', name: 'Alpha Research' },
  { id: 'can3329-beta', name: 'Beta Notes' },
  { id: 'can3329-gamma', name: 'Gamma Plans' },
];

function seedProjectsWithoutDefaultChats(userDataDir) {
  writeJson(path.join(userDataDir, 'preferences.json'), {
    version: 1,
    preferences: { onboardingCompleted: ['v1'] },
  });
  for (const project of PROJECTS) {
    seedCoworkWorkspace({
      userDataDir,
      workspaceId: project.id,
      name: project.name,
      chatId: `${project.id}-chat`,
      chatTitle: `${project.name} chat`,
    });
  }
  // Each seeder call writes a one-entry index; publish all three together.
  writeJson(path.join(userDataDir, 'workspaces', 'index.json'), {
    version: 1,
    workspaces: PROJECTS.map((project, order) => ({
      id: project.id,
      name: project.name,
      type: 'cowork',
      color: '#7C9B6D',
      collapsed: true,
      order,
    })),
  });
}

function readIndexIds(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf8')).workspaces.map(
    (entry) => entry.id,
  );
}

test('launching with projects but no Chats entry keeps every project in the sidebar', async () => {
  test.setTimeout(120_000);
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'canopy-can-3329-'));
  seedProjectsWithoutDefaultChats(userDataDir);

  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });

    await expect(
      window.getByTestId(
        `sidebar-cowork-project-${DEFAULT_COWORK_WORKSPACE_ID}`,
      ),
    ).toHaveCount(1);
    for (const project of PROJECTS) {
      await expect(
        window.getByTestId(`sidebar-cowork-project-${project.id}`),
      ).toBeVisible();
    }

    const indexPath = path.join(userDataDir, 'workspaces', 'index.json');
    await expect
      .poll(() => readIndexIds(indexPath))
      .toEqual(
        expect.arrayContaining([
          ...PROJECTS.map((project) => project.id),
          DEFAULT_COWORK_WORKSPACE_ID,
        ]),
      );
    // Provisioning rewrote the index, so the pre-launch index is the backup.
    expect(readIndexIds(`${indexPath}.bak`)).toEqual(
      expect.arrayContaining(PROJECTS.map((project) => project.id)),
    );
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
