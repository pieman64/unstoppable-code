import { IPC_CHANNELS } from '@canopy/desktop-shared/types';
import type { AuthenticatedPortalRequest } from '@canopy/desktop-shared/lib/authenticated-portal-request';
import { createAuthenticatedPortalApi } from '../api/authenticated-portal-api';

const request: AuthenticatedPortalRequest = {
  requireAuthentication: true,
  kind: 'payment',
  path: '/account/billing?b=2&a=1#credits',
  accountId: 'acct-1',
  webOrigin: 'http://localhost:3000',
};

it('forwards exactly one strict object and preserves the original destination', async () => {
  const invoke = jest.fn().mockResolvedValue({ ok: true });
  await expect(
    createAuthenticatedPortalApi({ invoke }).openAuthenticatedPortalPage(
      request,
    ),
  ).resolves.toEqual({ ok: true });
  expect(invoke.mock.calls).toEqual([
    [IPC_CHANNELS.settingsOpenAuthenticatedPortalPage, request],
  ]);
});

it.each(['unavailable', 'identity_changed', 'failed', 'browser_failed'])(
  'preserves typed failure %s without retry',
  async (reason) => {
    const invoke = jest.fn().mockResolvedValue({ ok: false, reason });
    await expect(
      createAuthenticatedPortalApi({ invoke }).openAuthenticatedPortalPage(
        request,
      ),
    ).resolves.toEqual({ ok: false, reason });
    expect(invoke).toHaveBeenCalledTimes(1);
  },
);

it.each([
  true,
  false,
  undefined,
  null,
  {},
  { ok: true, requestId: 'unexpected' },
  { ok: false, reason: 'unknown' },
])('fails closed on incompatible replies: %j', async (reply) => {
  const invoke = jest.fn().mockResolvedValue(reply);
  await expect(
    createAuthenticatedPortalApi({ invoke }).openAuthenticatedPortalPage(
      request,
    ),
  ).resolves.toEqual({ ok: false, reason: 'failed' });
  expect(invoke).toHaveBeenCalledTimes(1);
});

it('turns a rejected invoke or absent handler into a strict failure without fallback', async () => {
  const invoke = jest
    .fn()
    .mockRejectedValue(new Error('No handler registered'));
  await expect(
    createAuthenticatedPortalApi({ invoke }).openAuthenticatedPortalPage(
      request,
    ),
  ).resolves.toEqual({ ok: false, reason: 'failed' });
  expect(invoke).toHaveBeenCalledTimes(1);
});

it('rejects malformed objects before invoking', async () => {
  const invoke = jest.fn();
  const malformed = { ...request, extra: true };
  await expect(
    createAuthenticatedPortalApi({ invoke }).openAuthenticatedPortalPage(
      malformed,
    ),
  ).resolves.toEqual({ ok: false, reason: 'failed' });
  expect(invoke).not.toHaveBeenCalled();
});

it.each([true, false])(
  'retains the legacy string payload and boolean %j',
  async (reply) => {
    const invoke = jest.fn().mockResolvedValue(reply);
    await expect(
      createAuthenticatedPortalApi({ invoke }).openAuthenticatedPortalPage(
        '/account',
      ),
    ).resolves.toBe(reply);
    expect(invoke.mock.calls).toEqual([
      [IPC_CHANNELS.settingsOpenAuthenticatedPortalPage, '/account'],
    ]);
  },
);

it('retains legacy rejection behavior', async () => {
  const error = new Error('Invalid legacy path');
  const invoke = jest.fn().mockRejectedValue(error);
  await expect(
    createAuthenticatedPortalApi({ invoke }).openAuthenticatedPortalPage(
      '//invalid',
    ),
  ).rejects.toBe(error);
});
