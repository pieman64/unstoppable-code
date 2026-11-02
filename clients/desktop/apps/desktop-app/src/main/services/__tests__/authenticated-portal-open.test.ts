import { BRAND } from '@canopy/brand/current';
import type { AuthenticatedPortalRequest } from '@canopy/desktop-shared/lib/authenticated-portal-request';
import type { CanopyCloudAccountEntry } from '../../lib/canopy-cloud-account-store';
import type { CanopyCloudCredentialContext } from '../../canopy-cloud/client';

const mockLoadAccount = jest.fn();
const mockCredentials = jest.fn();
const mockMint = jest.fn();
const mockOpen = jest.fn();
const mockEnabled = jest.fn();
jest.mock('../../lib/canopy-cloud-account-store', () => ({
  loadCanopyCloudAccount: (): unknown => mockLoadAccount(),
  getCanopyCloudCredentials: (): unknown => mockCredentials(),
}));
jest.mock('../../canopy-cloud/client', () => ({
  requestCanopyCloudJson: (...args: unknown[]): unknown => mockMint(...args),
}));
jest.mock('../../canopy-cloud/config', () => ({
  getCanopyCloudBaseUrl: (): string => 'https://cloud.example.test',
}));
jest.mock('../../lib/open-external', () => ({
  openExternalGuarded: (...args: unknown[]): unknown => mockOpen(...args),
}));
jest.mock('../../feature-flags', () => ({
  getFeatureFlagService: (): { isEnabled: typeof mockEnabled } => ({
    isEnabled: mockEnabled,
  }),
}));

import * as portal from '../../canopy-cloud/authenticated-portal';
import { openAuthenticatedPortalRequest } from '../authenticated-portal-open';

const origin = 'https://cloud.example.test';
const consume = `${origin}/api/v1/${BRAND.web.apiNamespace}/auth-link/consume?code=test-only`;
const account: CanopyCloudAccountEntry = {
  apiKey: 'test-key',
  capabilities: [],
  account: {
    id: 'acct-1',
    email: 'person@example.test',
    name: 'Person',
    role: 'DEVELOPER',
  },
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};
const credentials: CanopyCloudCredentialContext = {
  baseUrl: origin,
  apiKey: account.apiKey,
  account: account.account,
};
const request: AuthenticatedPortalRequest = {
  requireAuthentication: true,
  kind: 'signed-in',
  path: '/account?b=2&a=1#profile',
  accountId: 'acct-1',
  webOrigin: origin,
};

beforeEach(() => {
  jest.resetAllMocks();
  mockLoadAccount.mockResolvedValue(account);
  mockCredentials.mockResolvedValue(credentials);
  mockEnabled.mockReturnValue(true);
  mockMint.mockResolvedValue({ url: consume });
  mockOpen.mockResolvedValue(undefined);
});
afterEach(() => jest.restoreAllMocks());

it('opens only the minted consume URL with the main-owned credential', async () => {
  const signedIn = jest.spyOn(portal, 'openAuthenticatedPortalPage');
  await expect(openAuthenticatedPortalRequest(request)).resolves.toEqual({
    ok: true,
  });
  expect(signedIn).toHaveBeenCalledWith(request.path, {
    requireAuthentication: true,
    credentialContext: credentials,
  });
  expect(mockMint).toHaveBeenCalledWith(expect.any(String), {
    method: 'POST',
    body: JSON.stringify({ redirectPath: request.path }),
    credentialContext: credentials,
  });
  expect(mockOpen.mock.calls).toEqual([[consume]]);
});

it('recomputes payment classification and uses the strict payment primitive', async () => {
  const payment = jest.spyOn(portal, 'openStrictAuthenticatedPortalPage');
  const signedIn = jest.spyOn(portal, 'openAuthenticatedPortalPage');
  const path = '/organization/org%3A1/settings?tab=general&tab=billing#credits';
  await expect(
    openAuthenticatedPortalRequest({ ...request, kind: 'payment', path }),
  ).resolves.toEqual({ ok: true });
  expect(payment).toHaveBeenCalledWith(path, credentials);
  expect(signedIn).not.toHaveBeenCalled();
  expect(mockOpen.mock.calls).toEqual([[consume]]);
});

it.each([
  null,
  [],
  true,
  1,
  {},
  { ...request, extra: true },
  { ...request, path: '//evil.test' },
])(
  'rejects invalid strict requests before reading credentials: %j',
  async (value) => {
    await expect(openAuthenticatedPortalRequest(value)).resolves.toEqual({
      ok: false,
      reason: 'failed',
    });
    expect(mockLoadAccount).not.toHaveBeenCalled();
    expect(mockMint).not.toHaveBeenCalled();
    expect(mockOpen).not.toHaveBeenCalled();
  },
);

it.each([
  null,
  { ...account, account: undefined },
  { ...account, apiKey: '' },
  { ...account, authMode: 'guest' },
  { ...account, credentialSource: 'guest' },
])('requires a real signed-in snapshot: %j', async (snapshot) => {
  mockLoadAccount.mockResolvedValue(snapshot);
  await expect(openAuthenticatedPortalRequest(request)).resolves.toEqual({
    ok: false,
    reason: 'unavailable',
  });
  expect(mockMint).not.toHaveBeenCalled();
  expect(mockOpen).not.toHaveBeenCalled();
});

it('fails closed when credentials are unreadable', async () => {
  mockCredentials.mockRejectedValue(new Error('Secure storage unavailable'));
  await expect(openAuthenticatedPortalRequest(request)).resolves.toEqual({
    ok: false,
    reason: 'unavailable',
  });
  expect(mockOpen).not.toHaveBeenCalled();
});

it.each([
  { ...credentials, account: { id: 'acct-2' } },
  { ...credentials, apiKey: 'different-key' },
  { ...credentials, baseUrl: 'https://other.test' },
])('rejects snapshot/credential changes before minting', async (value) => {
  mockCredentials.mockResolvedValue(value);
  await expect(openAuthenticatedPortalRequest(request)).resolves.toEqual({
    ok: false,
    reason: 'identity_changed',
  });
  expect(mockMint).not.toHaveBeenCalled();
  expect(mockOpen).not.toHaveBeenCalled();
});

it.each([
  { accountId: 'acct-2' },
  { webOrigin: 'https://cloud.example.test:444' },
  { kind: 'payment' },
])(
  'rejects stale assertions or incorrect classification: %j',
  async (fields) => {
    await expect(
      openAuthenticatedPortalRequest({ ...request, ...fields }),
    ).resolves.toEqual({
      ok: false,
      reason: 'kind' in fields ? 'failed' : 'identity_changed',
    });
    expect(mockMint).not.toHaveBeenCalled();
    expect(mockOpen).not.toHaveBeenCalled();
  },
);

it('compares normalized origins and supports HTTP development ports', async () => {
  mockCredentials.mockResolvedValue({
    ...credentials,
    baseUrl: 'http://localhost:3000/',
  });
  mockMint.mockResolvedValue({
    url: 'http://localhost:3000/consume?code=test-only',
  });
  await expect(
    openAuthenticatedPortalRequest({
      ...request,
      webOrigin: 'http://LOCALHOST:3000',
    }),
  ).resolves.toEqual({ ok: true });
});

it('preserves the portal availability gate', async () => {
  mockEnabled.mockReturnValue(false);
  await expect(openAuthenticatedPortalRequest(request)).resolves.toEqual({
    ok: false,
    reason: 'unavailable',
  });
  expect(mockMint).not.toHaveBeenCalled();
  expect(mockOpen).not.toHaveBeenCalled();
});

it('never falls back after a mint rejection', async () => {
  mockMint.mockRejectedValue(new Error('Offline'));
  await expect(openAuthenticatedPortalRequest(request)).resolves.toEqual({
    ok: false,
    reason: 'failed',
  });
  expect(mockMint).toHaveBeenCalledTimes(1);
  expect(mockOpen).not.toHaveBeenCalled();
});

it('never opens an untrusted consume URL', async () => {
  mockMint.mockResolvedValue({ url: 'https://evil.test/consume' });
  await expect(openAuthenticatedPortalRequest(request)).resolves.toEqual({
    ok: false,
    reason: 'failed',
  });
  expect(mockOpen).not.toHaveBeenCalled();
});

it('rechecks identity after minting', async () => {
  mockMint.mockImplementation(() => {
    mockCredentials.mockResolvedValue({
      ...credentials,
      account: { id: 'acct-2' },
    });
    return Promise.resolve({ url: consume });
  });
  await expect(openAuthenticatedPortalRequest(request)).resolves.toEqual({
    ok: false,
    reason: 'identity_changed',
  });
  expect(mockOpen).not.toHaveBeenCalled();
});

it('reports browser failure after one launch attempt, without fallback', async () => {
  mockOpen.mockRejectedValue(new Error('Browser failed'));
  await expect(openAuthenticatedPortalRequest(request)).resolves.toEqual({
    ok: false,
    reason: 'browser_failed',
  });
  expect(mockOpen.mock.calls).toEqual([[consume]]);
});

it('maps unexpected exceptions and malformed primitive results to failure', async () => {
  mockLoadAccount.mockRejectedValueOnce(new Error('Unexpected'));
  await expect(openAuthenticatedPortalRequest(request)).resolves.toEqual({
    ok: false,
    reason: 'failed',
  });
  jest.spyOn(portal, 'openAuthenticatedPortalPage').mockResolvedValueOnce(true);
  await expect(openAuthenticatedPortalRequest(request)).resolves.toEqual({
    ok: false,
    reason: 'failed',
  });
});
