// CAN-6008: the window's Canopy Cloud Settings handlers and App Advisor call
// the same owners. Real encrypted account-store I/O, as in the CAN-3686
// golden; HTTP, the browser sign-in and unrelated enforcement are injected.
import { IPC_CHANNELS } from '@canopy/desktop-shared/types';
import { registerIpcHandler } from '../../ipc/register';
import {
  cancelCanopyCloudOAuthLoginForWindow,
  registerSettingsHandlers,
  saveCanopyCloudApiKeyForWindow,
  startCanopyCloudOAuthLoginForWindow,
  validateCanopyCloudApiKeyForWindow,
} from '../../ipc/settings';
import {
  clearCanopyCloudAccount,
  loadCanopyCloudAccountPublicState,
} from '../../lib/canopy-cloud-account-store';

jest.mock('../../ipc/register', () => ({ registerIpcHandler: jest.fn() }));
jest.mock('../../lib/github-pat-env', () => ({
  initializeGitHubPatEnvRuntime: jest.fn(),
}));
jest.mock('../../canopy-cloud/config', () => ({
  getCanopyCloudBaseUrl: (): string => 'https://cloud.example.test',
}));
jest.mock('../../services/org-enforced-settings', () => ({
  applyEnforcedSettings: jest.fn(),
}));
jest.mock('../../shared-containers/organization-snapshot-transition', () => ({
  organizationSnapshotTransition:
    (): ((persist: () => Promise<unknown>) => Promise<unknown>) =>
    (persist: () => Promise<unknown>): Promise<unknown> =>
      persist(),
}));
jest.mock('../../shared-containers/reconciliation-service', () => ({
  getSharedContainerReconciliationService: (): object => ({
    withReplicaPurgeFence: (
      persist: () => Promise<unknown>,
    ): Promise<unknown> => persist(),
  }),
}));
const mockSignIns: unknown[] = [];
let mockCancels = 0;
jest.mock('../../canopy-cloud/oauth-login', () => ({
  startCanopyCloudOAuthLogin: (request: unknown): Promise<object> => {
    mockSignIns.push(request);
    return Promise.resolve({
      status: { authenticated: true },
      account: { hasApiKey: true },
    });
  },
  cancelCanopyCloudOAuthLogin: (): void => {
    mockCancels += 1;
  },
}));
jest.mock('../../canopy-cloud/guest-auth', () => ({
  pauseGuestMintsForRealSignIn: (): object => ({
    release: (): void => undefined,
    activeGuestMint: undefined,
  }),
  requestGuestLinkTicket: (): Promise<null> => Promise.resolve(null),
}));

const CANDIDATE = 'sk-candidate-0123456789abcdef';
const capabilities = [
  'pipelines-crud-v1',
  'account-v1',
  'organizations-v1',
  'teams-v1',
];
const account = {
  id: 'account-one',
  name: 'Test account',
  email: 'test@example.test',
  role: 'DEVELOPER',
};

function handler(channel: string): (...args: unknown[]) => Promise<unknown> {
  const call = jest
    .mocked(registerIpcHandler)
    .mock.calls.find(([name]) => name === channel);
  if (!call) throw new Error(`Missing settings handler ${channel}`);
  return (...args) =>
    Promise.resolve(Reflect.apply(call[1], undefined, [{}, ...args]));
}

function respond(authenticated: boolean): jest.SpyInstance {
  return jest.spyOn(globalThis, 'fetch').mockImplementation(
    (url): Promise<Response> =>
      Promise.resolve(
        typeof url === 'string' && url.includes('/.well-known/')
          ? Response.json({ capabilities })
          : authenticated
            ? Response.json({
                account,
                capabilities,
                organizations: [],
                teams: [],
              })
            : new Response('Rejected', { status: 401 }),
      ),
  );
}

beforeEach(async () => {
  jest.mocked(registerIpcHandler).mockClear();
  registerSettingsHandlers({
    dispatcher: {
      query: (): Promise<never> =>
        Promise.reject(new Error('Unexpected dispatch')),
      instruction: (): Promise<never> =>
        Promise.reject(new Error('Unexpected dispatch')),
    },
    resolveCaller: () => {
      throw new Error('Unexpected caller');
    },
  });
  await clearCanopyCloudAccount();
  mockSignIns.length = 0;
  mockCancels = 0;
});

it('settings:validate-canopy-cloud-api-key and the shared owner answer alike, without the key', async () => {
  const fetchMock = respond(false);
  try {
    const viaWindow = await handler(
      IPC_CHANNELS.settingsValidateCanopyCloudApiKey,
    )({ apiKey: CANDIDATE });
    const viaAdvisor = await validateCanopyCloudApiKeyForWindow({
      apiKey: CANDIDATE,
    });
    expect(viaAdvisor).toEqual(viaWindow);
    expect(viaAdvisor).toMatchObject({ authenticated: false });
    expect(JSON.stringify([viaWindow, viaAdvisor])).not.toContain(CANDIDATE);
  } finally {
    fetchMock.mockRestore();
  }
});

it('settings:save-canopy-cloud-api-key and the shared owner store the key and answer only its public state', async () => {
  const fetchMock = respond(true);
  try {
    const viaWindow = await handler(IPC_CHANNELS.settingsSaveCanopyCloudApiKey)(
      { apiKey: CANDIDATE },
    );
    await clearCanopyCloudAccount();
    const viaAdvisor = await saveCanopyCloudApiKeyForWindow({
      apiKey: CANDIDATE,
    });
    for (const saved of [viaWindow, viaAdvisor])
      expect(saved).toMatchObject({
        status: { authenticated: true },
        account: { hasApiKey: true, account: { id: 'account-one' } },
      });
    expect(JSON.stringify([viaWindow, viaAdvisor])).not.toContain(CANDIDATE);
    expect(await loadCanopyCloudAccountPublicState()).toMatchObject({
      hasApiKey: true,
    });
  } finally {
    fetchMock.mockRestore();
  }
});

it('settings:start-canopy-cloud-oauth-login and settings:cancel-canopy-cloud-oauth-login share their owners', async () => {
  const viaWindow = await handler(
    IPC_CHANNELS.settingsStartCanopyCloudOAuthLogin,
  )();
  const viaAdvisor = await startCanopyCloudOAuthLoginForWindow();
  expect(viaAdvisor).toEqual(viaWindow);
  expect(mockSignIns).toEqual([
    { guestLinkTicket: null },
    { guestLinkTicket: null },
  ]);

  await handler(IPC_CHANNELS.settingsCancelCanopyCloudOAuthLogin)();
  await cancelCanopyCloudOAuthLoginForWindow();
  expect(mockCancels).toBe(2);
});
