jest.mock('electron', () => ({
  app: { isPackaged: false, getPath: (): string => '/tmp' },
  BrowserWindow: { getAllWindows: (): [] => [] },
  ipcMain: { on: jest.fn(), removeHandler: jest.fn(), handle: jest.fn() },
}));

const mockInstructions: Array<{
  name: string;
  params: unknown;
  options: unknown;
}> = [];
jest.mock('../../canopy-runtime/desktop-runtime', () => ({
  getActiveDesktopRuntime: (): object => ({
    instruction: (name: string, params: unknown, options: unknown): object => {
      mockInstructions.push({ name, params, options });
      return Promise.resolve({
        commandId: 'k',
        revision: 4,
        outcome: 'applied',
      });
    },
  }),
}));

let mockRestartFails = false;
const mockRestarts: unknown[] = [];
jest.mock('../../integration/claude-terminal-session-service', () => ({
  getClaudeTerminalSessionService: (): object => ({
    restartForSettingsChange: (target: unknown): Promise<void> => {
      mockRestarts.push(target);
      return mockRestartFails
        ? Promise.reject(new Error('terminal gone'))
        : Promise.resolve();
    },
  }),
}));
jest.mock('../../lib/main-process-logging', () => ({
  logMainProcessWarn: (): void => undefined,
}));
jest.mock('../advisor-chat-read-host', () => ({
  mainAdvisorChatReadHost: (): object => ({
    readUiState: (): Promise<null> => Promise.resolve(null),
    readTabs: (): Promise<null> => Promise.resolve(null),
    locateCoworkChat: (): Promise<object> =>
      Promise.resolve({ entryId: null, archivedInEntryId: null }),
  }),
}));

let mockLiveFails = false;
const mockLiveUpdates: unknown[] = [];
jest.mock('../../ipc/chat', () => ({
  applyChatPluginSelectionsUpdate: (
    request: unknown,
    options: unknown,
  ): Promise<object> => {
    mockLiveUpdates.push({ request, options });
    return mockLiveFails
      ? Promise.reject(new Error('Wait for queued Codex messages'))
      : Promise.resolve({});
  },
}));

import { mainAdvisorChatSettingsHost } from '../advisor-chat-settings-host';

function host(): ReturnType<typeof mainAdvisorChatSettingsHost> {
  return mainAdvisorChatSettingsHost({
    chatId: 'advisor-chat',
    readUiState: () => Promise.resolve(null),
    getMainWindow: () => null,
    hasPresentationLease: () => Promise.resolve(false),
    presentInMainWindow: () =>
      Promise.resolve({ requestId: 'r', ok: true, result: {} }),
  });
}

beforeEach(() => {
  mockInstructions.length = 0;
  mockRestarts.length = 0;
  mockRestartFails = false;
  mockLiveFails = false;
  mockLiveUpdates.length = 0;
});

describe('App Advisor chat settings host (CAN-5999 part 2)', () => {
  it('sends one keyed core.chat.update as the Advisor chat with only core.chat.write', async () => {
    const result = await host().updateChat({
      projectId: 'proj',
      worktreeId: 'wt',
      action: {
        type: 'chat.patch_tab_settings',
        tabId: 'chat-1',
        patch: { planMode: true },
      },
      idempotencyKey: 'app-advisor-action:advisor-chat:toolu_1:settings',
    });

    expect(result).toEqual({ outcome: 'applied' });
    expect(mockInstructions).toEqual([
      {
        name: 'core.chat.update',
        params: {
          projectId: 'proj',
          worktreeId: 'wt',
          commandId: 'app-advisor-action:advisor-chat:toolu_1:settings',
          origin: 'desktop',
          action: {
            type: 'chat.patch_tab_settings',
            tabId: 'chat-1',
            patch: { planMode: true },
          },
          _meta: {
            idempotencyKey: 'app-advisor-action:advisor-chat:toolu_1:settings',
          },
        },
        options: {
          caller: {
            principalId: 'local-desktop-user',
            clientInstanceId: 'agent-action:advisor-chat',
            authorityId: 'local-desktop',
            interfaceKind: 'mcp',
            grants: ['core.chat.write'],
          },
          metadata: {
            idempotencyKey: 'app-advisor-action:advisor-chat:toolu_1:settings',
          },
        },
      },
    ]);
  });

  it('restarts the Claude terminal after a change, and a failed restart never fails the change', async () => {
    const target = { projectId: 'proj', worktreeId: 'wt', chatId: 'chat-1' };
    await host().restartTerminal(target);
    mockRestartFails = true;
    await expect(host().restartTerminal(target)).resolves.toBeUndefined();

    expect(mockRestarts).toEqual([target, target]);
  });

  it('reports whether the main window is open', () => {
    expect(host().isMainWindowOpen()).toBe(false);
  });

  it('applies plugin selections to the live session through applyChatPluginSelectionsUpdate, and reports when it cannot', async () => {
    const request = {
      projectId: 'proj',
      worktreeId: 'wt',
      chatId: 'chat-1',
      pluginSelections: { collectionIds: [], skillRefs: [], pluginRefs: [] },
    };
    await expect(host().applyLivePluginSelections(request)).resolves.toBe(true);
    mockLiveFails = true;
    await expect(host().applyLivePluginSelections(request)).resolves.toBe(
      false,
    );

    // Already committed through core.chat.update: the live update never writes.
    expect(mockLiveUpdates).toEqual([
      { request, options: { committed: true } },
      { request, options: { committed: true } },
    ]);
  });
});
