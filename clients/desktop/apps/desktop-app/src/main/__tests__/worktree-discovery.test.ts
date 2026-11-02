import { mkdir } from 'node:fs/promises';
import type { BrowserWindow } from 'electron';
import {
  APP_ADVISOR_PROJECT_ID,
  IPC_CHANNELS,
  type WorktreeDiscoveryEvent,
} from '@canopy/desktop-shared/types';
import { registerIpcHandler } from '../ipc/register';
import { sendToWindow, type SendableBrowserWindow } from '../lib/window-send';
import { resolveWorktreeCwd } from '../lib/resolve-worktree';
import { ensureAppAdvisorHomeScaffold } from '../lib/app-advisor-workspace';
import { validateId } from '../lib/validation';
import { discoverWorktreeEnvironment } from '../agents/sdk-discovery';
import { discoverCodexWorktreeEnvironment } from '../agents/codex-discovery';
import { resolveEffectiveChatPluginContext } from '../plugins/global-plugin-overlay';
import {
  registerWorktreeDiscoveryHandlers,
  runProviderDiscovery,
} from '../ipc/worktree-discovery';

const fromWebContentsMock = jest.fn<SendableBrowserWindow | null, [unknown]>();

jest.mock('node:fs/promises');

jest.mock('electron', () => ({
  BrowserWindow: {
    fromWebContents: (webContents: unknown): SendableBrowserWindow | null =>
      fromWebContentsMock(webContents),
  },
}));

jest.mock('../ipc/register', () => ({
  registerIpcHandler: jest.fn(),
}));

jest.mock('../lib/window-send', () => ({
  sendToWindow: jest.fn(),
}));

jest.mock('../agents/sdk-discovery', () => ({
  discoverWorktreeEnvironment: jest.fn(() =>
    Promise.resolve({
      slashCommands: [{ name: 'enabled-skill', description: 'Enabled skill' }],
      mcpServers: [],
    }),
  ),
}));

jest.mock('../agents/codex-discovery', () => ({
  discoverCodexWorktreeEnvironment: jest.fn(() =>
    Promise.resolve({ slashCommands: [], mcpServers: [] }),
  ),
}));

jest.mock('../lib/resolve-worktree', () => ({
  resolveWorktreeCwd: jest.fn((projectId: string) =>
    projectId === 'app-advisor' ? '/tmp/app-advisor-home' : '/tmp/worktree',
  ),
}));

jest.mock('../lib/app-advisor-workspace', () => ({
  ensureAppAdvisorHomeScaffold: jest.fn(() => Promise.resolve()),
}));

jest.mock('../plugins/plugin-resolver', () => ({
  resolvePlugins: jest.fn(() =>
    Promise.resolve({
      sdkPlugins: [],
      selectedCapabilityRoots: [],
      codexProcessEnv: {},
      warnings: [],
    }),
  ),
}));
jest.mock('../plugins/global-plugin-overlay', () => ({
  resolveEffectiveChatPluginContext: jest.fn(
    (selections?: {
      collectionIds?: string[];
      skillRefs?: unknown[];
      pluginRefs?: unknown[];
      mcpServerRefs?: unknown[];
    }) =>
      Promise.resolve({
        selections: selections ?? {
          collectionIds: [],
          skillRefs: [],
          pluginRefs: [],
        },
      }),
  ),
}));

jest.mock('../lib/validation', () => ({
  validateId: jest.fn(),
}));

jest.mock('../ollama/claude-compatible', () => ({
  resolveClaudeCompatibleInvocation: jest.fn(),
}));

const mockedRegisterIpcHandler = jest.mocked(registerIpcHandler);
const mockedSendToWindow = jest.mocked(sendToWindow);
const mockedMkdir = jest.mocked(mkdir);
const mockedDiscoverWorktreeEnvironment = jest.mocked(
  discoverWorktreeEnvironment,
);
const mockedDiscoverCodexWorktreeEnvironment = jest.mocked(
  discoverCodexWorktreeEnvironment,
);
const mockedResolveWorktreeCwd = jest.mocked(resolveWorktreeCwd);
const mockedEnsureAppAdvisorHomeScaffold = jest.mocked(
  ensureAppAdvisorHomeScaffold,
);
const mockedValidateId = jest.mocked(validateId);

function invokeRegisteredHandler(...args: unknown[]): void {
  const call = mockedRegisterIpcHandler.mock.calls.find(
    ([channel]) => channel === IPC_CHANNELS.worktreeDiscover,
  );
  const handler = call?.[1];
  if (typeof handler !== 'function') {
    throw new Error('Expected worktree discovery handler to be registered');
  }
  Reflect.apply(handler, undefined, args);
}

function makeBrowserWindow(): BrowserWindow {
  const window: SendableBrowserWindow = {
    isDestroyed: jest.fn(() => false),
    webContents: {
      isDestroyed: jest.fn(() => false),
      isCrashed: jest.fn(() => false),
      send: jest.fn(),
      mainFrame: {
        detached: false,
        isDestroyed: jest.fn(() => false),
      },
    },
  };
  // These tests exercise only the IPC-safe window surface, not Electron APIs.
  return window as unknown as BrowserWindow;
}

function isWorktreeDiscoveryEvent(
  value: unknown,
): value is WorktreeDiscoveryEvent {
  return (
    typeof value === 'object' &&
    value !== null &&
    'projectId' in value &&
    'worktreeId' in value &&
    'discovery' in value
  );
}

function findCompletedDiscoveryEvent(
  window: SendableBrowserWindow,
): WorktreeDiscoveryEvent | undefined {
  for (const [calledWindow, channel, event] of mockedSendToWindow.mock.calls) {
    if (
      calledWindow === window &&
      channel === IPC_CHANNELS.worktreeDiscoveryEvent &&
      isWorktreeDiscoveryEvent(event) &&
      event.discovery?.slashCommands.some(
        (command) => command.name === 'enabled-skill',
      )
    ) {
      return event;
    }
  }
  return undefined;
}

async function flushDiscovery(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 10));
}

describe('runProviderDiscovery', () => {
  it.each([
    [true, true, { draft: true }],
    [true, false, true],
    [false, true, false],
  ] as const)(
    'resolves global defaults %s with a draft %s as %j',
    async (applyGlobalDefaults, draftPluginSelections, overlay) => {
      jest.mocked(resolveEffectiveChatPluginContext).mockClear();
      await runProviderDiscovery({
        cwd: '/tmp/home',
        providerType: 'claude',
        projectId: 'project-1',
        worktreeId: '__home__',
        chatId: '__home_discovery__',
        applyGlobalDefaults,
        draftPluginSelections,
        signal: new AbortController().signal,
      });
      expect(resolveEffectiveChatPluginContext).toHaveBeenCalledWith(
        undefined,
        {
          projectId: 'project-1',
          worktreeId: '__home__',
          chatId: '__home_discovery__',
        },
        overlay,
      );
    },
  );

  it('forwards safe project discovery controls to Claude metadata discovery', async () => {
    const signal = new AbortController().signal;

    await runProviderDiscovery({
      cwd: '/tmp/repo-shadow',
      providerType: 'claude',
      projectId: 'project-1',
      worktreeId: '__home__',
      chatId: '__home_discovery__',
      strictEmptyMcpConfig: true,
      safeProjectDiscovery: true,
      signal,
    });

    expect(mockedDiscoverWorktreeEnvironment).toHaveBeenCalledWith(
      '/tmp/repo-shadow',
      signal,
      undefined,
      undefined,
      undefined,
      'project-1',
      {
        strictEmptyMcpConfig: true,
        safeProjectDiscovery: true,
      },
    );
  });

  it('forwards safe project discovery controls to Codex metadata discovery', async () => {
    const signal = new AbortController().signal;

    await runProviderDiscovery({
      cwd: '/tmp/repo-shadow',
      providerType: 'codex',
      projectId: 'project-1',
      worktreeId: '__home__',
      chatId: '__home_discovery__',
      strictEmptyMcpConfig: true,
      safeProjectDiscovery: true,
      signal,
    });

    expect(mockedDiscoverCodexWorktreeEnvironment).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: '/tmp/repo-shadow',
        strictEmptyMcpConfig: true,
        safeProjectDiscovery: true,
        signal,
      }),
    );
  });
});

describe('worktree discovery IPC', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedMkdir.mockResolvedValue(undefined);
  });

  it('sends per-tab discovery events to the requesting window as well as the main window', async () => {
    const mainWindow = makeBrowserWindow();
    const appAdvisorWindow = makeBrowserWindow();
    const sender = { id: 'app-advisor-webcontents' };
    fromWebContentsMock.mockReturnValue(appAdvisorWindow);

    registerWorktreeDiscoveryHandlers(() => mainWindow);
    invokeRegisteredHandler(
      { sender },
      {
        projectId: APP_ADVISOR_PROJECT_ID,
        worktreeId: 'entry-app-advisor',
        chatId: 'chat-1',
        providerType: 'claude',
      },
    );
    await flushDiscovery();

    expect(fromWebContentsMock).toHaveBeenCalledWith(sender);
    expect(mockedValidateId).toHaveBeenCalledWith('chat-1', 'chatId');
    expect(mockedDiscoverWorktreeEnvironment).toHaveBeenCalled();
    expect(mockedSendToWindow).toHaveBeenCalledWith(
      mainWindow,
      IPC_CHANNELS.worktreeDiscoveryEvent,
      expect.objectContaining({
        projectId: APP_ADVISOR_PROJECT_ID,
        worktreeId: 'entry-app-advisor',
        chatId: 'chat-1',
        discovery: null,
      }),
    );
    expect(mockedSendToWindow).toHaveBeenCalledWith(
      appAdvisorWindow,
      IPC_CHANNELS.worktreeDiscoveryEvent,
      expect.objectContaining({
        projectId: APP_ADVISOR_PROJECT_ID,
        worktreeId: 'entry-app-advisor',
        chatId: 'chat-1',
        discovery: null,
      }),
    );
    const completedAppAdvisorEvent =
      findCompletedDiscoveryEvent(appAdvisorWindow);
    expect(completedAppAdvisorEvent).toMatchObject({
      projectId: APP_ADVISOR_PROJECT_ID,
      worktreeId: 'entry-app-advisor',
      chatId: 'chat-1',
    });
    expect(completedAppAdvisorEvent?.discovery?.slashCommands).toContainEqual({
      name: 'enabled-skill',
      description: 'Enabled skill',
    });
  });

  it('uses the App Advisor home directory for App Advisor Claude discovery', async () => {
    const mainWindow = makeBrowserWindow();
    const appAdvisorWindow = makeBrowserWindow();
    fromWebContentsMock.mockReturnValue(appAdvisorWindow);

    registerWorktreeDiscoveryHandlers(() => mainWindow);
    invokeRegisteredHandler(
      { sender: { id: 'app-advisor-webcontents' } },
      {
        projectId: APP_ADVISOR_PROJECT_ID,
        worktreeId: 'entry-app-advisor',
        chatId: 'chat-1',
        providerType: 'claude',
      },
    );
    await flushDiscovery();

    expect(mockedEnsureAppAdvisorHomeScaffold).toHaveBeenCalledTimes(1);
    expect(mockedResolveWorktreeCwd).toHaveBeenCalledWith(
      APP_ADVISOR_PROJECT_ID,
      'entry-app-advisor',
      undefined,
    );
    expect(mockedDiscoverWorktreeEnvironment).toHaveBeenCalledWith(
      '/tmp/app-advisor-home',
      expect.any(AbortSignal),
      undefined,
      undefined,
      undefined,
      APP_ADVISOR_PROJECT_ID,
      undefined,
    );
  });
});
