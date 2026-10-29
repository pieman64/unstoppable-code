import { parseGitHubRepo } from '../github-repo';

/**
 * The parser moved here from `@canopy/desktop-shared` so the web portal's
 * add-marketplace form validates with the same code as the desktop UI and the
 * `portal.marketplace.add` adapter. These cases pin the contract all three
 * now share.
 */
describe('parseGitHubRepo', () => {
  it('accepts owner/repo shorthand', () => {
    expect(parseGitHubRepo('acme/plugins')).toBe('acme/plugins');
    expect(parseGitHubRepo('  acme/plugins  ')).toBe('acme/plugins');
  });

  it('accepts GitHub URLs, with or without scheme extras', () => {
    expect(parseGitHubRepo('https://github.com/acme/plugins')).toBe(
      'acme/plugins',
    );
    expect(parseGitHubRepo('http://github.com/acme/plugins')).toBe(
      'acme/plugins',
    );
    expect(parseGitHubRepo('https://www.github.com/acme/plugins')).toBe(
      'acme/plugins',
    );
    expect(parseGitHubRepo('https://GitHub.com/acme/plugins')).toBe(
      'acme/plugins',
    );
  });

  it('strips a .git suffix and trailing path segments', () => {
    expect(parseGitHubRepo('https://github.com/acme/plugins.git')).toBe(
      'acme/plugins',
    );
    expect(parseGitHubRepo('https://github.com/acme/plugins/tree/main')).toBe(
      'acme/plugins',
    );
  });

  it('rejects anything that is not a repo reference', () => {
    expect(parseGitHubRepo('')).toBeNull();
    expect(parseGitHubRepo('   ')).toBeNull();
    expect(parseGitHubRepo('acme')).toBeNull();
    expect(parseGitHubRepo('acme/plugins/extra')).toBeNull();
    expect(parseGitHubRepo('not a repo')).toBeNull();
    expect(parseGitHubRepo('https://gitlab.com/acme/plugins')).toBeNull();
  });
});
