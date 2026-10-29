import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { seedDemoWorkspaces } from '../demoWorkspaces.mjs';
import { launchCanopy } from '../launchCanopy.mjs';
import { seedWorktreeChat, writeJson } from '../seeders/index.mjs';

const WORKSPACE_ID = 'demo-ts-pnpm-vite';
const WORKTREE_ID = 'demo-main';

/** Local discovery response fixture; the renderer request and event path stay real. */
export async function launchOllamaDiscoveryFixture(harness, options = {}) {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'ollama-discovery-harness-'),
  );
  seedDemoWorkspaces({
    userDataDir,
    apps: ['ts-pnpm-vite'],
    checkRuntimes: false,
  });
  const executable = path.join(userDataDir, 'ollama');
  writeFileSync(executable, "#!/bin/sh\necho 'ollama version 0.14.0'\n");
  chmodSync(executable, 0o755);
  writeJson(path.join(userDataDir, 'preferences.json'), {
    version: 1,
    preferences: { ollamaExecutablePath: executable },
  });
  writeJson(path.join(userDataDir, 'ollama-model-cache.json'), {
    version: 1,
    byPort: {
      11534: {
        refreshedAt: new Date().toISOString(),
        models: [
          {
            id: 'ollama-qwen3-coder',
            rawModelId: 'qwen3-coder',
            label: 'qwen3-coder',
            show: { capabilities: ['completion', 'tools'] },
          },
        ],
      },
    },
  });
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    tabs: [
      {
        id: 'ollama-discovery',
        title: 'Ollama discovery',
        model: 'ollama-qwen3-coder',
        providerType: 'ollama',
        ...(options.started
          ? {
              messages: [
                {
                  id: 'started-turn',
                  role: 'user',
                  timestamp: 1,
                  blocks: [
                    { type: 'text', text: 'Started Ollama conversation' },
                  ],
                },
              ],
            }
          : {}),
        ...(harness
          ? {
              executionHarness: harness,
              executionHarnessExplicitlyChosen: true,
            }
          : {}),
      },
    ],
  });
  options.seed?.(userDataDir);
  const { electronApp } = await launchCanopy({ userDataDir, env: options.env });

  // Keep the real renderer request, event reducer, and composer filtering;
  // replace only the provider's external discovery response.
  await electronApp.evaluate(({ ipcMain }) => {
    globalThis.harnessDiscoveryRequests = [];
    ipcMain.removeHandler('worktree:discover');
    ipcMain.handle('worktree:discover', (_event, request) => {
      globalThis.harnessDiscoveryRequests.push(request);
    });
  });
  return { electronApp, userDataDir };
}

/** Release the provider response after the selected chat has finished hydration. */
export async function respondToOllamaDiscovery(electronApp) {
  await electronApp.evaluate(({ BrowserWindow }) => {
    const request = globalThis.harnessDiscoveryRequests.findLast(
      (entry) => entry.chatId === 'ollama-discovery',
    );
    if (!request) throw new Error('Expected a tab-scoped discovery request');
    for (const window of BrowserWindow.getAllWindows()) {
      window.webContents.send('worktree:discovery-event', {
        projectId: request.projectId,
        worktreeId: request.worktreeId,
        chatId: request.chatId,
        discovery: {
          providerType: request.providerType,
          discoveredAt: new Date().toISOString(),
          mcpServers: [],
          slashCommands: [
            {
              name: 'local-review',
              description: 'Review with the local model',
            },
          ],
        },
      });
    }
  });
}
