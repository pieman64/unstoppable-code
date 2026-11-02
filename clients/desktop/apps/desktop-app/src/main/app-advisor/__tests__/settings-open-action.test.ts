import type { ScriptActionsSnapshot } from '@canopy/protocol/script-actions';
import type * as AgentActionsModule from '@canopy/agent-actions';
import type * as DesktopHostModule from '../../agent-actions/desktop-host';
import type * as AccountStoreModule from '../../lib/canopy-cloud-account-store';
import type {
  CanopyCloudAccountEntry,
  CanopyCloudAccountReadResult,
} from '../../lib/canopy-cloud-account-store';

jest.mock('../../services/script-actions-host', () => ({
  scriptActionsService: {
    list: jest.fn(() => Promise.resolve(mockScriptSnapshot)),
    rescan: jest.fn(() => Promise.resolve(mockScriptSnapshot)),
    setPinned: jest.fn(() => Promise.resolve(mockScriptSnapshot)),
    setShortcut: jest.fn(() => Promise.resolve(mockScriptSnapshot)),
  },
}));
const mockScriptSnapshot: ScriptActionsSnapshot = {
  actions: [
    {
      id: 'build',
      name: 'build',
      kind: 'detected',
      command: 'PRIVATE COMMAND',
      multiline: false,
      repoId: 'r',
      repoName: 'Repo',
      packagePath: null,
      target: { kind: 'repository', repoId: 'r' },
      source: {
        kind: 'package-json',
        file: 'package.json',
        entry: 'build',
        line: null,
      },
      revision: 'v1',
      status: 'approved',
      shortcut: null,
      pinned: false,
    },
  ],
  pendingCount: 0,
  shellAliasScanEnabled: false,
  scanStatus: 'complete',
  scannedAt: null,
  diagnostics: [],
};

jest.mock('electron', () => ({
  BrowserWindow: { getAllWindows: (): [] => [] },
  ipcMain: { on: jest.fn(), removeHandler: jest.fn(), handle: jest.fn() },
}));

let mockRead: () => Promise<CanopyCloudAccountReadResult>;
jest.mock('../../lib/canopy-cloud-account-store', (): object => ({
  ...jest.requireActual<typeof AccountStoreModule>(
    '../../lib/canopy-cloud-account-store',
  ),
  readCanopyCloudAccountWithStatus: (): Promise<CanopyCloudAccountReadResult> =>
    mockRead(),
}));

// The hosted settings rollout is on; `settings.open` checks it in main.
jest.mock('../../feature-flags', (): object => ({
  getFeatureFlagService: (): object => ({
    getSnapshot: (): object => ({ values: {} }),
    isEnabled: (key: string): boolean =>
      key === 'canopy-desktop-hosted-settings',
  }),
}));

// Ports the settings action does not use; `settings` is left out so the
// family binds the real desktop settings port.
jest.mock('../../agent-actions/desktop-host', (): object => {
  const actual = jest.requireActual<typeof DesktopHostModule>(
    '../../agent-actions/desktop-host',
  );
  const packageActual = jest.requireActual<typeof AgentActionsModule>(
    '@canopy/agent-actions',
  );
  return {
    ...actual,
    desktopAgentActionPorts: (): object => ({
      environment: {},
      limits: packageActual.createInMemoryAgentActionLimits(),
      chatWatchers: {},
      split: {},
      receipts: packageActual.createInMemoryAgentActionReceipts(),
    }),
  };
});

import {
  APP_ADVISOR_PROJECT_ID,
  APP_ADVISOR_WORKTREE_ID,
  IPC_CHANNELS,
} from '@canopy/desktop-shared/types';
import type { SendableBrowserWindow } from '../../lib/window-send';
import { createAppAdvisorToolRuntime } from '../runtime';
import { executeAppAdvisorTool } from '../tool-executor';

const entry: CanopyCloudAccountEntry = {
  apiKey: 'key',
  capabilities: [],
  account: {
    id: 'acct-1',
    name: 'User',
    email: 'user@example.com',
    role: 'DEVELOPER',
  },
  organizations: [
    {
      id: 'org-member',
      name: 'Member org',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
  ],
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

interface Sent {
  channel: string;
  payload: unknown;
}

function setup(): {
  sent: Sent[];
  rendererDispatches: unknown[];
  run(action: unknown): ReturnType<typeof executeAppAdvisorTool>;
  search(actionType: string): ReturnType<typeof executeAppAdvisorTool>;
} {
  const sent: Sent[] = [];
  const mainWindow: SendableBrowserWindow = {
    isDestroyed: (): boolean => false,
    webContents: {
      isDestroyed: (): boolean => false,
      isCrashed: (): boolean => false,
      mainFrame: { detached: false, isDestroyed: (): boolean => false },
      send: (channel: string, payload: unknown): void => {
        sent.push({ channel, payload });
      },
    },
  };
  const rendererDispatches: unknown[] = [];
  const created = createAppAdvisorToolRuntime(
    {
      getMainWindow: () => null,
      getAppAdvisorWindow: () => null,
      openAppAdvisorWindow: () =>
        Promise.resolve({ open: true, focused: true }),
      ensureAppAdvisorWindow: () =>
        Promise.resolve({ open: true, focused: true }),
    },
    {
      projectId: APP_ADVISOR_PROJECT_ID,
      worktreeId: APP_ADVISOR_WORKTREE_ID,
      chatId: 'advisor-chat',
    },
  );
  const runtime = {
    ...created,
    // A window double for the main window `settingsWindow` resolves to; the
    // wiring itself is covered below.
    settingsWindow: (): SendableBrowserWindow => mainWindow,
    requestUiState: (): ReturnType<typeof created.requestUiState> =>
      Promise.reject(new Error('Renderer unavailable.')),
    dispatchRendererAction: (
      action: Parameters<typeof created.dispatchRendererAction>[0],
    ): ReturnType<typeof created.dispatchRendererAction> => {
      rendererDispatches.push(action);
      return Promise.resolve({ requestId: 'renderer', ok: true });
    },
  };
  return {
    sent,
    rendererDispatches,
    run: (action) =>
      executeAppAdvisorTool('dispatch_action', { action }, runtime, {
        toolUseId: 'settings-tool',
      }),
    search: (actionType) =>
      executeAppAdvisorTool('search_actions', { actionType }, runtime),
  };
}

function parse(text: string): unknown {
  return JSON.parse(text);
}

describe('App Advisor settings.open', () => {
  beforeEach(() => {
    mockRead = (): Promise<CanopyCloudAccountReadResult> =>
      Promise.resolve({ status: 'ok', entry });
  });

  it('dispatches an account route through the shared engine to the main window', async () => {
    const h = setup();
    const destination = { scope: 'account', page: 'security' };
    const result = await h.run({ type: 'settings.open', destination });
    expect(result.isError).not.toBe(true);
    expect(parse(result.text)).toMatchObject({
      ok: true,
      result: { status: 'opened', destination },
    });
    expect(h.sent).toEqual([
      {
        channel: IPC_CHANNELS.accountOrganizationSettingsOpen,
        payload: destination,
      },
    ]);
    expect(h.rendererDispatches).toEqual([]);
  });

  it('opens a member organization route', async () => {
    const h = setup();
    const destination = {
      scope: 'organization',
      organizationId: 'org-member',
      page: 'settings',
      subtab: 'billing',
    };
    const result = await h.run({ type: 'settings.open', destination });
    expect(result.isError).not.toBe(true);
    expect(h.sent).toEqual([
      {
        channel: IPC_CHANNELS.accountOrganizationSettingsOpen,
        payload: destination,
      },
    ]);
  });

  it.each([
    ['an unknown page', { scope: 'account', page: 'not-a-page' }],
    [
      'an organization route without an organization',
      { scope: 'organization', page: 'members' },
    ],
    ['a URL instead of a route', 'https://example.com/settings'],
  ])('rejects %s without opening anything', async (_label, destination) => {
    const h = setup();
    const result = await h.run({ type: 'settings.open', destination });
    expect(result.isError).toBe(true);
    expect(result.text).toContain('Invalid arguments for DispatchAction.');
    expect(h.sent).toEqual([]);
    expect(h.rendererDispatches).toEqual([]);
  });

  it('refuses an organization outside the account memberships', async () => {
    const h = setup();
    const result = await h.run({
      type: 'settings.open',
      destination: {
        scope: 'organization',
        organizationId: 'org-other',
        page: 'members',
      },
    });
    expect(result.isError).toBe(true);
    expect(parse(result.text)).toMatchObject({
      ok: false,
      error: { code: 'invalid_target' },
      result: { status: 'rejected', reason: 'organization_not_member' },
    });
    expect(h.sent).toEqual([]);
    expect(h.rendererDispatches).toEqual([]);
  });

  it('opens settings in the main window, not the Advisor window', () => {
    const getMainWindow = jest.fn(() => null);
    const getAppAdvisorWindow = jest.fn(() => null);
    const runtime = createAppAdvisorToolRuntime(
      {
        getMainWindow,
        getAppAdvisorWindow,
        openAppAdvisorWindow: () =>
          Promise.resolve({ open: true, focused: true }),
        ensureAppAdvisorWindow: () =>
          Promise.resolve({ open: true, focused: true }),
      },
      {
        projectId: APP_ADVISOR_PROJECT_ID,
        worktreeId: APP_ADVISOR_WORKTREE_ID,
        chatId: 'advisor-chat',
      },
    );
    expect(runtime.settingsWindow?.()).toBeNull();
    expect(getMainWindow).toHaveBeenCalledTimes(1);
    expect(getAppAdvisorWindow).not.toHaveBeenCalled();
  });

  it('finds settings.open by exact action type', async () => {
    const h = setup();
    const result = await h.search('settings.open');
    expect(result.isError).not.toBe(true);
    const parsed = parse(result.text);
    const actions =
      typeof parsed === 'object' && parsed !== null && 'actions' in parsed
        ? parsed.actions
        : [];
    const types = Array.isArray(actions)
      ? actions.map((action: unknown) =>
          typeof action === 'object' && action !== null && 'type' in action
            ? action.type
            : null,
        )
      : [];
    expect(types).toContain('settings.open');
  });
});

describe('script preference App Advisor wiring', () => {
  it('searches and dispatches the shared list through the service without command contents', async () => {
    const h = setup();
    expect((await h.search('script_actions.list')).text).toContain(
      'script_actions.list',
    );
    const result = await h.run({
      type: 'script_actions.list',
      workspaceId: 'p',
      inWorktreeId: 'w',
    });
    expect(result.isError).not.toBe(true);
    expect(result.text).toContain('build');
    expect(result.text).not.toContain('PRIVATE COMMAND');
  });
  it.each(['approve', 'review', 'run', 'enable_shell_alias_scan'])(
    'rejects human-only script operation %s',
    async (operation) => {
      expect(
        (
          await setup().run({
            type: `script_actions.${operation}`,
            workspaceId: 'p',
            inWorktreeId: 'w',
          })
        ).isError,
      ).toBe(true);
    },
  );
});
