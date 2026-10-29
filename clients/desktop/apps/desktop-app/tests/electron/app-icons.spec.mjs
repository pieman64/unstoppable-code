import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { seedOrgContextScoping } from './seeders/seedOrgContextScoping.mjs';
import { seedCoworkWorkspace } from './seeders/seedCoworkWorkspace.mjs';
import {
  expectCoworkProjectFolder,
  expectCompactProjectFolder,
  expectAppIconContract,
} from './helpers/app-icon-contract.mjs';

test('Lucide keeps the shared size and stroke contract across navigation and Settings', async () => {
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'single-repo-icon-'));
  seedOrgContextScoping(userDataDir);
  const { electronApp } = await launchCanopy({
    userDataDir,
    seedDemoWorkspaces: false,
  });
  try {
    const page = await electronApp.firstWindow();
    const app = new CanopyAppDriver(page);
    await app.waitForShell();
    await app.showSidebar();
    await expectCompactProjectFolder(page);
    await expectAppIconContract(page);
    await app.openSettings();
    await expectAppIconContract(page);
    await app.closeSettings();
    await expectAppIconContract(page);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('project folders stay compact and filled on desktop', async () => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-project-folder-'),
  );
  seedCoworkWorkspace({
    userDataDir,
    workspaceId: 'icon-cowork',
    name: 'Local project',
    collapsed: false,
    seedMessage: false,
  });
  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const page = await electronApp.firstWindow();
    const app = new CanopyAppDriver(page);
    await app.waitForShell();
    await app.showSidebar();
    await app.openMainPage();
    await expectCoworkProjectFolder(page);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
