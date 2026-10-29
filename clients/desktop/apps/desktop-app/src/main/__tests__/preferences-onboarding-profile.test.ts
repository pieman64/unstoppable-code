import { normalizePreferences } from '../lib/preferences-store';

describe('normalizePreferences — onboarding profile (CAN-1009)', () => {
  test('keeps an explicit empty answer across reloads and clears the legacy role and detail', () => {
    const cleared = normalizePreferences({
      profileRole: 'other',
      profileRoles: [],
      profileRoleDetail: 'Writer',
    });
    expect(cleared.profileRole).toBeUndefined();
    expect(cleared.profileRoleDetail).toBeUndefined();
    expect(cleared.profileRoles).toEqual([]);
    const reloaded = normalizePreferences(
      JSON.parse(JSON.stringify(cleared)) as Record<string, unknown>,
    );
    expect(reloaded.profileRoles).toEqual([]);
    expect(reloaded.profileRole).toBeUndefined();
  });

  test('preserves Marketing and Sales as independent selections', () => {
    expect(
      normalizePreferences({ profileRole: 'sales', profileRoles: ['sales'] }),
    ).toMatchObject({
      profileRole: 'sales',
      profileRoles: ['sales'],
    });
    expect(
      normalizePreferences({
        profileRole: 'marketing',
        profileRoles: ['marketing', 'sales'],
      }),
    ).toMatchObject({
      profileRole: 'marketing',
      profileRoles: ['marketing', 'sales'],
    });
  });

  test.each([
    { profileRole: 'marketing-sales' },
    { profileRole: 'marketing-sales', profileRoles: ['marketing-sales'] },
  ])(
    'expands an existing combined answer without losing either role (%j)',
    (preferences) => {
      expect(normalizePreferences(preferences)).toMatchObject({
        profileRole: 'marketing',
        profileRoles: ['marketing', 'sales'],
      });
    },
  );

  test.each([
    { profileRole: 'operations-support' },
    {
      profileRole: 'operations-support',
      profileRoles: ['operations-support'],
    },
  ])(
    'expands an existing Operations or Support answer without losing either role (%j)',
    (preferences) => {
      expect(normalizePreferences(preferences)).toMatchObject({
        profileRole: 'operations',
        profileRoles: ['operations', 'support'],
      });
    },
  );

  test('does not restore a deselected role from a stale combined primary', () => {
    expect(
      normalizePreferences({
        profileRole: 'marketing-sales',
        profileRoles: ['sales'],
      }),
    ).toMatchObject({
      profileRole: 'sales',
      profileRoles: ['sales'],
    });
  });

  test('all profile fields stay absent when omitted', () => {
    const result = normalizePreferences({});
    expect(result.attributionSource).toBeUndefined();
    expect(result.attributionSourceDetail).toBeUndefined();
    expect(result.profileRole).toBeUndefined();
    expect(result.profileRoleDetail).toBeUndefined();
    expect(result.profileIntent).toBeUndefined();
  });

  test('round-trips valid enum ids', () => {
    const result = normalizePreferences({
      attributionSource: 'friend-coworker',
      profileRole: 'product-manager',
    });
    expect(result.attributionSource).toBe('friend-coworker');
    expect(result.profileRole).toBe('product-manager');
  });

  test('drops unknown enum ids', () => {
    const rawPreferences: Record<string, unknown> = {
      attributionSource: 'carrier-pigeon',
      profileRole: 42,
    };
    const result = normalizePreferences(rawPreferences);
    expect(result.attributionSource).toBeUndefined();
    expect(result.profileRole).toBeUndefined();
  });

  test('trims free-text fields and keeps non-empty values', () => {
    const result = normalizePreferences({
      attributionSource: 'other',
      attributionSourceDetail: '  a podcast  ',
      profileRole: 'other',
      profileRoleDetail: ' QA lead ',
      profileIntent: '  automate my release notes  ',
    });
    expect(result.attributionSourceDetail).toBe('a podcast');
    expect(result.profileRoleDetail).toBe('QA lead');
    expect(result.profileIntent).toBe('automate my release notes');
  });

  test('keeps role detail for any selected work role', () => {
    const result = normalizePreferences({
      profileRole: 'sales',
      profileRoles: ['sales'],
      profileRoleDetail: '  Enterprise account planning  ',
    });
    expect(result.profileRoleDetail).toBe('Enterprise account planning');
  });

  test('keeps Other detail when Other is a secondary selected role', () => {
    const result = normalizePreferences({
      profileRole: 'software-engineer',
      profileRoles: ['software-engineer', 'other'],
      profileRoleDetail: '  Technical writer  ',
    });
    expect(result.profileRoleDetail).toBe('Technical writer');
  });

  test('drops empty or non-string free-text fields', () => {
    const rawPreferences: Record<string, unknown> = {
      attributionSource: 'other',
      attributionSourceDetail: '   ',
      profileRole: 'other',
      profileRoleDetail: 7,
      profileIntent: null,
    };
    const result = normalizePreferences(rawPreferences);
    expect(result.attributionSourceDetail).toBeUndefined();
    expect(result.profileRoleDetail).toBeUndefined();
    expect(result.profileIntent).toBeUndefined();
  });

  test('clamps detail fields to 256 chars and intent to 2000 chars', () => {
    const result = normalizePreferences({
      attributionSource: 'other',
      attributionSourceDetail: 'x'.repeat(300),
      profileRole: 'other',
      profileRoleDetail: 'y'.repeat(300),
      profileIntent: 'z'.repeat(2500),
    });
    expect(result.attributionSourceDetail).toHaveLength(256);
    expect(result.profileRoleDetail).toHaveLength(256);
    expect(result.profileIntent).toHaveLength(2000);
  });

  test('drops stale attribution detail but keeps general role detail', () => {
    const result = normalizePreferences({
      attributionSource: 'search',
      attributionSourceDetail: 'stale attribution detail',
      profileRole: 'designer',
      profileRoleDetail: 'stale role detail',
    });

    expect(result.attributionSourceDetail).toBeUndefined();
    expect(result.profileRoleDetail).toBe('stale role detail');
  });
});
