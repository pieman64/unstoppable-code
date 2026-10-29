import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { seedWorktreeChat } from './seeders/index.mjs';
import { launchCanopy } from './launchCanopy.mjs';

export const AUTH_RECOVERY_SCOPE = {
  projectId: 'demo-ts-pnpm-vite',
  worktreeId: 'demo-main',
  chatId: 'auth-resume',
};
export async function launchAuthRecoveryFixture({
  worked = false,
  toolFailure = false,
  failFirstSend = false,
} = {}) {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-auth-resume-'),
  );
  const { projectId, worktreeId, chatId } = AUTH_RECOVERY_SCOPE;
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  const failure = {
    dependencyClass: 'mcp',
    dependencyId: 'datadog:default',
    displayName: 'Datadog',
    failureClass: 'expired',
    recovery: { kind: 'mcp_oauth', serverId: 'datadog', configId: 'default' },
  };
  seedWorktreeChat({
    userDataDir,
    workspaceId: projectId,
    worktreeId,
    providerType: 'claude',
    activeTabId: chatId,
    tabs: [
      {
        id: chatId,
        title: 'Recover connection',
        providerType: 'claude',
        messages: [
          {
            id: 'original-user',
            role: 'user',
            timestamp: 1000,
            blocks: [{ type: 'text', text: 'Investigate the Datadog errors.' }],
          },
          ...(worked
            ? [
                {
                  id: 'work',
                  role: 'assistant',
                  timestamp: 1100,
                  blocks: [
                    ...(toolFailure
                      ? [
                          {
                            type: 'tool_use',
                            toolUseId: 'lookup',
                            toolName: 'mcp__datadog__query',
                            input: '{}',
                          },
                        ]
                      : [
                          {
                            type: 'text',
                            text: 'I found the affected service.',
                          },
                        ]),
                  ],
                },
              ]
            : []),
          {
            id: 'failure',
            role: 'system',
            timestamp: 1200,
            blocks: toolFailure
              ? [
                  {
                    type: 'tool_result',
                    toolUseId: 'lookup',
                    toolName: 'mcp__datadog__query',
                    output: 'Reconnect Datadog.',
                    isError: true,
                    authFailures: [failure],
                  },
                ]
              : [
                  {
                    type: 'text',
                    text: 'Reconnect Datadog.',
                    authFailures: [failure],
                  },
                ],
          },
          {
            id: 'timer',
            role: 'system',
            timestamp: 1000,
            blocks: [
              { type: 'turn_timer', startedAt: 1000, completedAt: 1200 },
            ],
          },
        ],
      },
    ],
  });
  const { electronApp } = await launchCanopy({ userDataDir });
  await electronApp.evaluate(({ ipcMain }, failFirstSend) => {
    globalThis.__authRecoveryFixture = {
      connected: false,
      sends: [],
      oauthStarts: 0,
    };
    const replace = (channel, handler) => {
      ipcMain.removeHandler(channel);
      ipcMain.handle(channel, handler);
    };
    replace('mcp-servers:list-status', () => [
      {
        serverId: 'datadog',
        transport: 'http',
        connectionStatus: globalThis.__authRecoveryFixture.connected
          ? 'connected'
          : 'auth_required',
        reachability: 'reachable',
        configs: [
          {
            configId: 'default',
            authStatus: globalThis.__authRecoveryFixture.connected
              ? 'connected'
              : 'not_connected',
          },
        ],
      },
    ]);
    replace('mcp-servers:check-health', () => ({ status: 'healthy' }));
    replace('mcp-servers:start-oauth-login', () => {
      globalThis.__authRecoveryFixture.oauthStarts++;
      globalThis.__authRecoveryFixture.connected = true;
      return { status: 'completed' };
    });
    const send = ipcMain._invokeHandlers.get('chat:send-message');
    replace('chat:send-message', (event, request) => {
      globalThis.__authRecoveryFixture.sends.push(request);
      if (failFirstSend && globalThis.__authRecoveryFixture.sends.length === 1)
        throw new Error('Dispatch refused by the fixture.');
      return send(event, request);
    });
  }, failFirstSend);
  const window = await electronApp.firstWindow();
  const app = new CanopyAppDriver(window);
  await app.waitForShell();
  await app.openMainPage();
  await app.selectWorktree(worktreeId);
  const panel = window.locator(
    `[data-testid="panel-content-chat"][data-panel-id="panel-chat-${chatId}"]`,
  );
  return { electronApp, window, app, panel, userDataDir };
}

export async function connectAuthRecoveryElsewhere(electronApp) {
  await electronApp.evaluate(({ BrowserWindow }) => {
    globalThis.__authRecoveryFixture.connected = true;
    for (const window of BrowserWindow.getAllWindows())
      window.webContents.send('mcp-servers:auth-changed');
  });
}
