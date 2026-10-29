import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import {
  closeFixture,
  createFixture,
  seedPreferences,
} from './codexPipelineRuntime.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { writeJson } from './seeders/fsHelpers.mjs';
import { launchCanopy } from './launchCanopy.mjs';

// Real composer/provider tool ingress, disposable canonical storage, and a
// held fake Codex turn allow deterministic interaction with the turn controls.
export async function openAutoArchiveSurface(surface) {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-archive-surface-'),
  );
  const fixture = createFixture(
    'auto-archive-held',
    'Auto archive surface finished.',
  );
  seedPreferences(userDataDir);
  const preferencesPath = path.join(userDataDir, 'preferences.json');
  const preferences = JSON.parse(readFileSync(preferencesPath, 'utf8'));
  Object.assign(preferences.preferences, {
    appAdvisorModel: 'gpt-6-sol',
    appAdvisorThinkingLevel: 'high',
    defaultAppAdvisorInterfaceMode: 'canopy',
  });
  writeJson(preferencesPath, preferences);
  const projectId = surface === 'advisor' ? 'app-advisor' : 'archive-cowork';
  const worktreeId = 'archive-entry';
  const chatId = 'archive-surface-chat';
  const root =
    surface === 'advisor'
      ? path.join(userDataDir, 'app-workspaces', projectId)
      : path.join(userDataDir, 'workspaces', projectId);
  if (surface === 'cowork') {
    seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
    const indexPath = path.join(userDataDir, 'workspaces', 'index.json');
    const index = JSON.parse(readFileSync(indexPath, 'utf8'));
    const items = index.items ?? index.workspaces;
    items.push({
      id: 'cowork-default',
      name: 'Personal',
      type: 'cowork',
      color: '#7C9B6D',
      collapsed: false,
      order: items.length,
      cowork: { createdAt: '2026-10-04T12:00:00.000Z' },
    });
    writeJson(
      path.join(userDataDir, 'workspaces', 'cowork-default', 'workspace.json'),
      {
        version: 1,
        type: 'cowork',
        cowork: { createdAt: '2026-10-04T12:00:00.000Z' },
      },
    );
    items.push({
      id: projectId,
      name: 'Archive Cowork',
      type: 'cowork',
      color: '#7C9B6D',
      collapsed: false,
      order: items.length,
      cowork: { createdAt: '2026-10-04T12:00:00.000Z' },
    });
    writeJson(indexPath, index);
    writeJson(path.join(root, 'workspace.json'), {
      version: 1,
      type: 'cowork',
      cowork: {
        createdAt: '2026-10-04T12:00:00.000Z',
        defaultModel: 'gpt-6-sol',
        searchIndexingEnabled: false,
      },
    });
  }
  mkdirSync(path.join(root, 'home'), { recursive: true });
  writeJson(path.join(root, 'work-entries.json'), {
    version: 1,
    entries: [{ id: worktreeId, createdAt: '2026-10-04T12:00:00.000Z' }],
  });
  writeJson(path.join(root, 'chats', `${worktreeId}.json`), {
    version: 1,
    activeTabId: chatId,
    tabs: [chatId, 'archive-keeper'].map((id) => ({
      id,
      kind: 'chat',
      title: id === chatId ? 'Auto archive chat' : 'Keeper chat',
      createdAt: '2026-10-04T12:00:00.000Z',
      providerType: 'codex',
      model: 'gpt-6-sol',
      approvalMode: 'full-access',
      messages:
        surface === 'advisor'
          ? []
          : [
              {
                id: `${id}-seed-user`,
                role: 'user',
                timestamp: Date.parse('2026-10-04T12:00:00Z'),
                blocks: [
                  { type: 'text', text: 'Keep this conversation available.' },
                ],
              },
              {
                id: `${id}-seed-reply`,
                role: 'assistant',
                timestamp: Date.parse('2026-10-04T12:00:01Z'),
                blocks: [{ type: 'text', text: 'Ready for the next request.' }],
              },
              {
                id: `${id}-seed-timer`,
                role: 'system',
                timestamp: Date.parse('2026-10-04T12:00:02Z'),
                blocks: [
                  {
                    type: 'turn_timer',
                    startedAt: Date.parse('2026-10-04T12:00:00Z'),
                    completedAt: Date.parse('2026-10-04T12:00:02Z'),
                  },
                ],
              },
            ],
    })),
  });
  const launched = await launchCanopy({
    userDataDir,
    env: fixture.env,
  });
  try {
    const mainWindow = await launched.electronApp.firstWindow();
    const app = new CanopyAppDriver(mainWindow);
    await app.waitForShell();
    let window = mainWindow;
    if (surface === 'advisor') {
      window = await app.openAppAdvisorWindow(launched.electronApp);
      await window.getByTestId(`app-advisor-nav-entry-${worktreeId}`).click();
    } else {
      await app.openMainPage();
      const toggle = window.getByTestId(
        `sidebar-cowork-project-${projectId}-toggle`,
      );
      if ((await toggle.getAttribute('aria-expanded')) !== 'true')
        await toggle.click();
      await window.getByTestId(`sidebar-work-entry-${worktreeId}`).click();
    }
    const panel = window.locator(
      `[data-testid="panel-content-chat"][data-panel-id="panel-chat-${chatId}"]`,
    );
    await expect(panel).toBeVisible();
    const scope = { projectId, worktreeId };
    return { ...launched, userDataDir, fixture, window, panel, chatId, scope };
  } catch (error) {
    await closeFixture(launched.electronApp, userDataDir, fixture.runtimeDir);
    throw error;
  }
}

export async function sendAutoArchiveRequest(
  context,
  text = 'Enable auto archive.',
) {
  await context.panel.getByRole('textbox').first().fill(text);
  await context.panel.getByRole('button', { name: 'Send message' }).click();
}

export async function readAutoArchiveState(context) {
  return context.window.evaluate(
    (scope) => window.api.chat.getState(scope),
    context.scope,
  );
}
