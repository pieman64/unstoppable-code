import {
  hostedSettingsLocation,
  hostedSettingsSearchParams,
  HOSTED_SETTINGS_HISTORY_LIMIT,
  pushHostedSettingsHistory,
  resolveHostedSettingsHref,
} from '../hosted-settings-location';

const WEB = 'https://app.example.test';
const ORG = 'a0000000-0000-4000-8000-000000000002';

describe('resolveHostedSettingsHref', () => {
  it('keeps a relative settings path inside Settings with its query and hash', () => {
    expect(
      resolveHostedSettingsHref(
        `/organization/${ORG}/statistics?range=7d#members`,
        WEB,
        '/account',
      ),
    ).toEqual({
      kind: 'settings',
      location: {
        route: {
          scope: 'organization',
          organizationId: ORG,
          page: 'statistics',
        },
        search: 'range=7d',
        hash: 'members',
      },
    });
  });

  it('keeps the Settings subtab in the route and the query', () => {
    const target = resolveHostedSettingsHref(
      `/organization/${ORG}/settings?tab=billing`,
      WEB,
      '/',
    );
    expect(target).toEqual({
      kind: 'settings',
      location: {
        route: {
          scope: 'organization',
          organizationId: ORG,
          page: 'settings',
          subtab: 'billing',
        },
        search: 'tab=billing',
        hash: '',
      },
    });
  });

  it('resolves a query-only link against the page on screen', () => {
    const target = resolveHostedSettingsHref(
      '?tab=usage',
      WEB,
      `/organization/${ORG}/settings`,
    );
    expect(target.kind).toBe('settings');
    if (target.kind !== 'settings') return;
    expect(target.location.route).toEqual({
      scope: 'organization',
      organizationId: ORG,
      page: 'settings',
      subtab: 'usage',
    });
  });

  it('keeps an absolute settings URL on the web origin inside Settings', () => {
    const target = resolveHostedSettingsHref(
      `${WEB}/account/security`,
      WEB,
      '/',
    );
    expect(target).toEqual({
      kind: 'settings',
      location: {
        route: { scope: 'account', page: 'security' },
        search: '',
        hash: '',
      },
    });
  });

  it('opens any other web path on the web origin', () => {
    expect(resolveHostedSettingsHref('/pricing?plan=pro', WEB, '/')).toEqual({
      kind: 'external',
      url: `${WEB}/pricing?plan=pro`,
    });
    expect(
      resolveHostedSettingsHref('/u/someone', `${WEB}/`, '/account/profile'),
    ).toEqual({ kind: 'external', url: `${WEB}/u/someone` });
  });

  it('opens absolute third-party and mail links externally', () => {
    expect(
      resolveHostedSettingsHref('https://github.com/settings', WEB, '/'),
    ).toEqual({ kind: 'external', url: 'https://github.com/settings' });
    expect(
      resolveHostedSettingsHref('mailto:a@example.test', WEB, '/'),
    ).toEqual({ kind: 'external', url: 'mailto:a@example.test' });
  });

  it('opens nothing for scripts, files, or web paths before the origin is known', () => {
    expect(resolveHostedSettingsHref('javascript:alert(1)', WEB, '/')).toEqual({
      kind: 'none',
    });
    expect(resolveHostedSettingsHref('file:///etc/passwd', WEB, '/')).toEqual({
      kind: 'none',
    });
    expect(resolveHostedSettingsHref('/pricing', '', '/')).toEqual({
      kind: 'none',
    });
    // Settings paths still resolve without the origin.
    expect(resolveHostedSettingsHref('/organization', '', '/').kind).toBe(
      'settings',
    );
  });

  it('does not treat an unknown settings sub-route as a settings page', () => {
    expect(resolveHostedSettingsHref('/account/unknown', WEB, '/')).toEqual({
      kind: 'external',
      url: `${WEB}/account/unknown`,
    });
  });
});

describe('hostedSettingsSearchParams', () => {
  it('merges the route query with page-owned state without repeating it', () => {
    const params = hostedSettingsSearchParams(
      hostedSettingsLocation(
        {
          scope: 'organization',
          organizationId: ORG,
          page: 'settings',
          subtab: 'usage',
        },
        { search: '?tab=usage&joined=1' },
      ),
    );
    expect(params.getAll('tab')).toEqual(['usage']);
    expect(params.get('joined')).toBe('1');
  });

  it('is empty without a hosted destination', () => {
    expect(hostedSettingsSearchParams(null).toString()).toBe('');
  });
});

describe('pushHostedSettingsHistory', () => {
  const account = hostedSettingsLocation({ scope: 'account', page: 'account' });
  const list = hostedSettingsLocation({ scope: 'organizations' });

  it('records the location being left', () => {
    expect(pushHostedSettingsHistory([], account, list)).toEqual([account]);
  });

  it('records nothing when no hosted page was showing or nothing changed', () => {
    expect(pushHostedSettingsHistory([], null, list)).toEqual([]);
    expect(pushHostedSettingsHistory([], list, { ...list })).toEqual([]);
  });

  it('stays bounded', () => {
    let history = pushHostedSettingsHistory([], account, list);
    for (let index = 0; index < HOSTED_SETTINGS_HISTORY_LIMIT + 5; index += 1)
      history = pushHostedSettingsHistory(
        history,
        index % 2 === 0 ? account : list,
        index % 2 === 0 ? list : account,
      );
    expect(history).toHaveLength(HOSTED_SETTINGS_HISTORY_LIMIT);
  });
});
