import type { AgentActionCall } from '@canopy/agent-actions';
import { IPC_CHANNELS } from '@canopy/desktop-shared/types';
import type { SettingsRoute } from '@canopy/protocol/settings';
import type { CanopyInjectedToolRuntime } from '../../canopy-tools/core';
import type {
  CanopyCloudAccountEntry,
  CanopyCloudAccountReadResult,
} from '../../lib/canopy-cloud-account-store';
import type { SendableBrowserWindow } from '../../lib/window-send';
import {
  createDesktopSettingsPort,
  readDesktopSettingsAccount,
  type DesktopSettingsAccount,
} from '../desktop-settings-port';

let mockRead: () => Promise<CanopyCloudAccountReadResult>;
jest.mock('../../lib/canopy-cloud-account-store', (): object => ({
  readCanopyCloudAccountWithStatus: (): Promise<CanopyCloudAccountReadResult> =>
    mockRead(),
}));

const call: AgentActionCall<CanopyInjectedToolRuntime> = {
  host: {
    requestUserAnswers: (): ReturnType<
      CanopyInjectedToolRuntime['requestUserAnswers']
    > => Promise.resolve([]),
    loadScriptOutput: (): ReturnType<
      CanopyInjectedToolRuntime['loadScriptOutput']
    > => Promise.reject(new Error('Unused')),
  },
  actorKey: 'test',
};

const accountRoute: SettingsRoute = { scope: 'account', page: 'profile' };
const memberRoute: SettingsRoute = {
  scope: 'organization',
  organizationId: 'org-member',
  page: 'members',
};
const outsideRoute: SettingsRoute = {
  scope: 'organization',
  organizationId: 'org-other',
  page: 'settings',
  subtab: 'billing',
};

function fakeWindow(options: { destroyed?: boolean } = {}): {
  window: SendableBrowserWindow;
  sent: { channel: string; route: unknown }[];
} {
  const sent: { channel: string; route: unknown }[] = [];
  return {
    sent,
    window: {
      isDestroyed: (): boolean => options.destroyed === true,
      webContents: {
        isDestroyed: (): boolean => false,
        isCrashed: (): boolean => false,
        mainFrame: { detached: false, isDestroyed: (): boolean => false },
        send: (channel: string, route: unknown): void => {
          sent.push({ channel, route });
        },
      },
    },
  };
}

function port(
  account: DesktopSettingsAccount | Error,
  window = fakeWindow(),
  hostedSettingsEnabled = true,
): {
  open(
    route: SettingsRoute,
  ): ReturnType<ReturnType<typeof createDesktopSettingsPort>['open']>;
  sent: { channel: string; route: unknown }[];
} {
  const settings = createDesktopSettingsPort({
    readAccount: () =>
      account instanceof Error
        ? Promise.reject(account)
        : Promise.resolve(account),
    getWindow: () => window.window,
    hostedSettingsEnabled: () => hostedSettingsEnabled,
  });
  return {
    open: (route) => settings.open(route, call),
    sent: window.sent,
  };
}

const signedIn: DesktopSettingsAccount = {
  status: 'signed_in',
  organizationIds: ['org-member'],
};

describe('desktop settings port', () => {
  it('asks the main window to open account and member organization routes', async () => {
    const h = port(signedIn);
    await expect(h.open(accountRoute)).resolves.toEqual({ status: 'opened' });
    await expect(h.open(memberRoute)).resolves.toEqual({ status: 'opened' });
    expect(h.sent).toEqual([
      {
        channel: IPC_CHANNELS.accountOrganizationSettingsOpen,
        route: accountRoute,
      },
      {
        channel: IPC_CHANNELS.accountOrganizationSettingsOpen,
        route: memberRoute,
      },
    ]);
  });

  it('refuses every route while the hosted settings flag is off', async () => {
    const h = port(signedIn, fakeWindow(), false);
    await expect(h.open(accountRoute)).resolves.toEqual({
      status: 'rejected',
      reason: 'unavailable',
    });
    expect(h.sent).toEqual([]);
  });

  it('refuses an organization outside the current memberships', async () => {
    const h = port(signedIn);
    await expect(h.open(outsideRoute)).resolves.toEqual({
      status: 'rejected',
      reason: 'organization_not_member',
    });
    expect(h.sent).toEqual([]);
  });

  it('refuses every route while signed out', async () => {
    const h = port({ status: 'signed_out' });
    await expect(h.open(accountRoute)).resolves.toEqual({
      status: 'rejected',
      reason: 'signed_out',
    });
    expect(h.sent).toEqual([]);
  });

  it.each<[string, DesktopSettingsAccount | Error, SettingsRoute]>([
    ['the account cannot be read', { status: 'unavailable' }, accountRoute],
    ['the account read throws', new Error('keychain locked'), accountRoute],
    [
      'the account has no membership list',
      { status: 'signed_in', organizationIds: null },
      memberRoute,
    ],
  ])('fails closed when %s', async (_label, account, route) => {
    const h = port(account);
    await expect(h.open(route)).resolves.toEqual({
      status: 'rejected',
      reason: 'unavailable',
    });
    expect(h.sent).toEqual([]);
  });

  it('opens the organization list without a membership list', async () => {
    const h = port({ status: 'signed_in', organizationIds: null });
    await expect(h.open({ scope: 'organizations' })).resolves.toEqual({
      status: 'opened',
    });
  });

  it('reports unavailable when the window is gone', async () => {
    const h = port(signedIn, fakeWindow({ destroyed: true }));
    await expect(h.open(accountRoute)).resolves.toEqual({
      status: 'rejected',
      reason: 'unavailable',
    });
    expect(h.sent).toEqual([]);
  });
});

describe('readDesktopSettingsAccount', () => {
  const entry: CanopyCloudAccountEntry = {
    apiKey: 'key',
    capabilities: [],
    account: {
      id: 'acct-1',
      name: 'Test User',
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

  it('reads memberships from the cached account', async () => {
    mockRead = (): Promise<CanopyCloudAccountReadResult> =>
      Promise.resolve({ status: 'ok', entry });
    await expect(readDesktopSettingsAccount()).resolves.toEqual({
      status: 'signed_in',
      organizationIds: ['org-member'],
    });
  });

  it('includes the personal organization, which /account lists apart', async () => {
    mockRead = (): Promise<CanopyCloudAccountReadResult> =>
      Promise.resolve({
        status: 'ok',
        entry: { ...entry, personalOrganizationId: 'org-personal' },
      });
    await expect(readDesktopSettingsAccount()).resolves.toEqual({
      status: 'signed_in',
      organizationIds: ['org-member', 'org-personal'],
    });
  });

  it('keeps an absent membership list unknown', async () => {
    const { organizations: _organizations, ...withoutOrganizations } = entry;
    void _organizations;
    mockRead = (): Promise<CanopyCloudAccountReadResult> =>
      Promise.resolve({ status: 'ok', entry: withoutOrganizations });
    await expect(readDesktopSettingsAccount()).resolves.toEqual({
      status: 'signed_in',
      organizationIds: null,
    });
  });

  it.each([
    ['no account', null],
    ['a guest account', { ...entry, authMode: 'guest' as const }],
    ['an account without an id', { ...entry, account: undefined }],
  ])('treats %s as signed out', async (_label, value) => {
    mockRead = (): Promise<CanopyCloudAccountReadResult> =>
      Promise.resolve({ status: 'ok', entry: value });
    await expect(readDesktopSettingsAccount()).resolves.toEqual({
      status: 'signed_out',
    });
  });

  it('treats unreadable secure storage as unavailable', async () => {
    mockRead = (): Promise<CanopyCloudAccountReadResult> =>
      Promise.resolve({ status: 'error', error: new Error('corrupt') });
    await expect(readDesktopSettingsAccount()).resolves.toEqual({
      status: 'unavailable',
    });
  });
});
