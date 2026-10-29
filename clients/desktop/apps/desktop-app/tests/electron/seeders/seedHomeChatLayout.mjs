import path from 'node:path';
import { writeJson } from './fsHelpers.mjs';

// The saved default has a dedicated chat host, but Changed files was active
// when it was saved. A fresh Home chat must never fall back into that group.
export function seedHomeChatLayout(userDataDir) {
  writeJson(path.join(userDataDir, 'preferences.json'), {
    version: 1,
    preferences: { workspaceDefaultLayoutMode: 'advanced' },
  });
  writeJson(path.join(userDataDir, 'default-panel-layout.json'), {
    version: 1,
    layout: {
      version: 1,
      grid: {
        orientation: 1,
        width: 1200,
        height: 800,
        root: {
          type: 'branch',
          size: 800,
          children: [
            {
              type: 'branch',
              size: 850,
              children: [
                {
                  type: 'leaf',
                  groupId: 'group-chat',
                  size: 752,
                  panels: [],
                  activePanelId: null,
                },
                {
                  type: 'leaf',
                  groupId: 'group-terminal',
                  size: 48,
                  panels: [{ panelId: 'panel-terminal', kind: 'terminal' }],
                  activePanelId: 'panel-terminal',
                  collapsed: { edge: 'bottom', expandedSize: 240 },
                },
              ],
            },
            {
              type: 'leaf',
              groupId: 'group-changed-files',
              size: 350,
              panels: [
                {
                  panelId: 'panel-changed-files',
                  kind: 'activity-card',
                  title: 'Changed files',
                  instance: { sectionId: 'changed-files' },
                },
              ],
              activePanelId: 'panel-changed-files',
            },
          ],
        },
      },
      activeGroupId: 'group-changed-files',
      mostRecentActiveGroupIds: [
        'group-changed-files',
        'group-chat',
        'group-terminal',
      ],
    },
  });
}

// Keep the initial canonical read behind the local optimistic starter. The
// real empty snapshot must replace it before canonical starter creation.
export async function delayHomeChatHydration(electronApp) {
  await electronApp.evaluate(({ ipcMain }) => {
    globalThis.__homeChatHydrationFinished = false;
    const getState = ipcMain._invokeHandlers.get('chat:get-state');
    ipcMain.removeHandler('chat:get-state');
    ipcMain.handle('chat:get-state', async (event, request) => {
      const snapshot = await getState(event, request);
      if (request.projectId === 'demo-ts-pnpm-vite') {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        globalThis.__homeChatHydrationFinished = true;
      }
      return snapshot;
    });
    const approval = ipcMain._invokeHandlers.get('approval:resolved-default');
    ipcMain.removeHandler('approval:resolved-default');
    ipcMain.handle('approval:resolved-default', async (event, request) => {
      await new Promise((resolve) => setTimeout(resolve, 250));
      return approval(event, request);
    });
  });
}
