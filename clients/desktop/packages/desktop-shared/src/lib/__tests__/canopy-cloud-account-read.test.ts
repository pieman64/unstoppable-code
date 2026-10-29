import type { CanopyServerAccountInfo } from '../../types';
import {
  canopyCloudAccountIdentity,
  isConclusiveAccountRead,
} from '../canopy-cloud-account-read';

describe('isConclusiveAccountRead', () => {
  it('treats an explicit ok read as authoritative', () => {
    expect(isConclusiveAccountRead({ read: 'ok' })).toBe(true);
  });

  it.each(['unavailable', 'error'] as const)(
    'treats a %s read as inconclusive',
    (read) => {
      expect(isConclusiveAccountRead({ read })).toBe(false);
    },
  );

  // Snapshots produced before `read` existed must keep their prior behavior
  // rather than silently becoming "hold forever".
  it('treats a missing read field as conclusive', () => {
    expect(isConclusiveAccountRead({})).toBe(true);
    expect(isConclusiveAccountRead({ read: undefined })).toBe(true);
  });
});

describe('canopyCloudAccountIdentity', () => {
  const account: CanopyServerAccountInfo = {
    id: 'account-1',
    name: 'Someone',
    email: 'someone@example.com',
    role: 'DEVELOPER',
  };

  it('names the signed-in account, and nobody when signed out', () => {
    const signedIn = canopyCloudAccountIdentity({
      hasApiKey: true,
      authMode: 'oauth',
      credentialSource: 'oauth_desktop',
      account,
    });
    expect(signedIn).not.toBeNull();
    expect(
      canopyCloudAccountIdentity({
        hasApiKey: true,
        authMode: 'oauth',
        credentialSource: 'oauth_desktop',
        account: { ...account, id: 'account-2' },
      }),
    ).not.toBe(signedIn);
    expect(
      canopyCloudAccountIdentity({
        hasApiKey: false,
        authMode: null,
        credentialSource: null,
        account,
      }),
    ).toBeNull();
  });

  it('tells a guest from a real account with the same ID', () => {
    expect(
      canopyCloudAccountIdentity({
        hasApiKey: true,
        authMode: 'guest',
        credentialSource: 'guest',
        account,
      }),
    ).not.toBe(
      canopyCloudAccountIdentity({
        hasApiKey: true,
        authMode: 'oauth',
        credentialSource: 'oauth_desktop',
        account,
      }),
    );
  });

  it('falls back to the API key, then the sign-in method, before the account is known', () => {
    expect(
      canopyCloudAccountIdentity({
        hasApiKey: true,
        authMode: 'api_key',
        credentialSource: 'manual',
        serverApiKeyId: 'key-1',
      }),
    ).toBe(JSON.stringify(['key-1', false]));
    expect(
      canopyCloudAccountIdentity({
        hasApiKey: true,
        authMode: 'api_key',
        credentialSource: 'manual',
      }),
    ).toBe(JSON.stringify(['api_key', false]));
  });
});
