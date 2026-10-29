import {
  ROLE_PLUGIN_RECOMMENDATIONS,
  resolveRolePluginRecommendations,
} from '../role-plugin-recommendations';

describe('resolveRolePluginRecommendations', () => {
  it('uses the default onboarding role when no role is saved', () => {
    expect(
      resolveRolePluginRecommendations(null, [
        'snowflake',
        'figma',
        'bigquery',
      ]),
    ).toEqual(['bigquery', 'snowflake']);
  });

  it('keeps selected-role order, catalog availability, and de-duplication', () => {
    expect(
      resolveRolePluginRecommendations(
        ['product-manager', 'designer'],
        ['canva', 'figma', 'posthog', 'missing-from-shortlists'],
      ),
    ).toEqual(['posthog', 'figma', 'canva']);
  });

  it('falls back when none of the selected roles picks are in the catalog', () => {
    expect(
      resolveRolePluginRecommendations(
        ['support'],
        ['snowflake', 'bigquery', 'unrelated'],
      ),
    ).toEqual(['bigquery', 'snowflake']);
  });

  it('does not fall back merely because every available role pick is installed', () => {
    expect(
      resolveRolePluginRecommendations(
        ['designer'],
        ['figma', 'bigquery', 'snowflake'],
        ['figma'],
      ),
    ).toEqual([]);
  });

  it('normalizes catalog and installed names without changing canonical output', () => {
    expect(
      resolveRolePluginRecommendations(
        ['founder'],
        [' Stripe ', 'HUBSPOT'],
        ['hubSpot'],
      ),
    ).toEqual(['stripe']);
  });

  it('defines a shortlist for every profile role', () => {
    expect(Object.keys(ROLE_PLUGIN_RECOMMENDATIONS).sort()).toEqual(
      [
        'software-engineer',
        'engineering-leader',
        'product-manager',
        'designer',
        'founder',
        'data-analytics',
        'marketing-sales',
        'marketing',
        'sales',
        'operations',
        'support',
        'operations-support',
        'student',
        'other',
      ].sort(),
    );
  });
});
