import type { CanopyCloudAccountPublicState } from '@canopy/desktop-shared/types';
import { resolveMobileAppPromo } from '../mobile-app-promo';
import { getBrandMobileApps } from '../brand';

jest.mock('../brand', () => ({
  brandText: { appName: 'Canopy' },
  getBrandMobileApps: jest.fn(),
}));

const mockGetBrandMobileApps = jest.mocked(getBrandMobileApps);

const NOW = Date.parse('2026-08-18T12:00:00.000Z');

function account(
  overrides: Partial<CanopyCloudAccountPublicState> = {},
): CanopyCloudAccountPublicState {
  return {
    hasApiKey: true,
    authMode: 'api_key',
    credentialSource: 'manual',
    capabilities: [],
    account: {
      id: 'account-1',
      name: 'Developer',
      email: 'dev@example.com',
      role: 'DEVELOPER',
    },
    storageAvailable: true,
    ...overrides,
  };
}

describe('resolveMobileAppPromo', () => {
  beforeEach(() => {
    mockGetBrandMobileApps.mockReturnValue({
      appStoreUrl: 'https://apps.apple.com/app/id1',
      playStoreUrl: 'https://play.google.com/store/apps/details?id=x',
    });
  });

  afterEach(() => {
    jest.resetAllMocks();
  });

  it('maps both declared listings onto badge links with data URIs', () => {
    const state = resolveMobileAppPromo({
      account: account(),
      activated: false,
      now: NOW,
    });
    expect(state.links.map((link) => link.store)).toEqual([
      'apple-app-store',
      'google-play',
    ]);
    expect(
      state.links[0]?.badgeSrc.startsWith('data:image/svg+xml;base64,'),
    ).toBe(true);
    expect(state.links[1]?.badgeSrc.startsWith('data:image/png;base64,')).toBe(
      true,
    );
  });

  it('hides everything when the brand declares no mobile apps', () => {
    // The default `canopy` brand declares none, so this is the CI default.
    mockGetBrandMobileApps.mockReturnValue(null);
    const state = resolveMobileAppPromo({
      account: account(),
      activated: false,
      now: NOW,
    });
    expect(state.links).toEqual([]);
    expect(state.showPermanent).toBe(false);
    expect(state.showPromotional).toBe(false);
  });

  it('shows both surfaces for a signed-in, non-activated user', () => {
    const state = resolveMobileAppPromo({
      account: account(),
      activated: false,
      now: NOW,
    });
    expect(state.signedIn).toBe(true);
    expect(state.showPermanent).toBe(true);
    expect(state.showPromotional).toBe(true);
  });

  it('suppresses only the promotional surfaces once activated', () => {
    const state = resolveMobileAppPromo({
      account: account(),
      activated: true,
      now: NOW,
    });
    expect(state.activated).toBe(true);
    // The Remote Control modal section is a deliberate download surface.
    expect(state.showPermanent).toBe(true);
    expect(state.showPromotional).toBe(false);
  });

  it('suppresses the promotional surfaces until the activation probe resolves', () => {
    // `activated` defaults to false and the account load settles before the
    // probe does, so without this gate an already-activated user would render
    // the card and cue for the gap and then have them vanish.
    const state = resolveMobileAppPromo({
      account: account(),
      activated: false,
      activationResolved: false,
      now: NOW,
    });
    expect(state.signedIn).toBe(true);
    expect(state.showPromotional).toBe(false);
    // The deliberate download surface does not wait on the probe.
    expect(state.showPermanent).toBe(true);
  });

  it('shows the promotional surfaces once an unresolved probe answers', () => {
    const state = resolveMobileAppPromo({
      account: account(),
      activated: false,
      activationResolved: true,
      now: NOW,
    });
    expect(state.showPromotional).toBe(true);
  });

  it('suppresses every surface for a signed-out user', () => {
    const state = resolveMobileAppPromo({
      account: null,
      activated: false,
      now: NOW,
    });
    expect(state.signedIn).toBe(false);
    expect(state.showPromotional).toBe(false);
    // The modal's ask in this state is "sign in"; store badges under it are a
    // competing CTA for an account that cannot pair a phone yet.
    expect(state.showPermanent).toBe(false);
  });

  it('suppresses every surface for a device-scoped guest', () => {
    // Mutually exclusive with GuestUpgradeNudge, which gates on guest.
    const state = resolveMobileAppPromo({
      account: account({ authMode: 'guest', credentialSource: 'guest' }),
      activated: false,
      now: NOW,
    });
    expect(state.signedIn).toBe(false);
    expect(state.showPromotional).toBe(false);
    // A guest sees the create-account CTA alone. The mobile app is named in the
    // modal subtitle instead, so the story is not lost.
    expect(state.showPermanent).toBe(false);
  });

  it('honors an unexpired snooze and ignores an expired one', () => {
    const snoozed = resolveMobileAppPromo({
      account: account(),
      activated: false,
      snoozedUntil: new Date(NOW + 60_000).toISOString(),
      now: NOW,
    });
    expect(snoozed.showPromotional).toBe(false);

    const lapsed = resolveMobileAppPromo({
      account: account(),
      activated: false,
      snoozedUntil: new Date(NOW - 60_000).toISOString(),
      now: NOW,
    });
    expect(lapsed.showPromotional).toBe(true);
  });

  it('treats an unparseable snooze deadline as not snoozed', () => {
    const state = resolveMobileAppPromo({
      account: account(),
      activated: false,
      snoozedUntil: 'not-a-date',
      now: NOW,
    });
    expect(state.showPromotional).toBe(true);
  });
});
