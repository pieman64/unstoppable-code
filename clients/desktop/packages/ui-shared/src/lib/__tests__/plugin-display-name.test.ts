import {
  marketplaceTitleCase,
  pluginDisplayName,
} from '../plugin-display-name';

describe('marketplaceTitleCase', () => {
  it.each([
    ['adobe-for-creativity', 'Adobe for Creativity'],
    ['SEO & AI search analytics', 'SEO & AI Search Analytics'],
    ['build macOS apps', 'Build macOS Apps'],
    ['Apollo.io', 'Apollo.io'],
    ['AirOps', 'AirOps'],
    ['GPT-5.6 Sol', 'GPT-5.6 Sol'],
  ])('formats the Marketplace name %s as %s', (source, expected): void => {
    expect(marketplaceTitleCase(source)).toBe(expected);
  });

  it.each([
    ['claude-security', 'Claude Security'],
    ['crowdstrike-falcon-foundry', 'CrowdStrike Falcon Foundry'],
    ['mcp-oauth', 'MCP OAuth'],
    ['github', 'GitHub'],
    ['postgresql', 'PostgreSQL'],
  ])('humanizes %s', (name, expected): void => {
    expect(marketplaceTitleCase(name)).toBe(expected);
    expect(pluginDisplayName({ name })).toBe(expected);
  });
});

describe('pluginDisplayName', () => {
  it.each([
    ['dbt labs', 'dbt labs'],
    ['  New Relic ', 'New Relic'],
    ['', 'Claude Security'],
    ['   ', 'Claude Security'],
    [null, 'Claude Security'],
    [undefined, 'Claude Security'],
  ])(
    'prefers a non-empty manifest name %s verbatim',
    (displayName, expected): void => {
      expect(pluginDisplayName({ name: 'claude-security', displayName })).toBe(
        expected,
      );
    },
  );
});
