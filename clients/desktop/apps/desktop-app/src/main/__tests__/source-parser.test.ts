import { parseGitHubSource } from '../skills/source-parser';

describe('parseGitHubSource', () => {
  describe('returns null for invalid inputs', () => {
    it('empty string', () => {
      expect(parseGitHubSource('')).toBeNull();
    });

    it('whitespace-only string', () => {
      expect(parseGitHubSource('   ')).toBeNull();
    });

    it('single word', () => {
      expect(parseGitHubSource('foobar')).toBeNull();
    });

    it('just "github.com"', () => {
      expect(parseGitHubSource('github.com')).toBeNull();
    });

    it('random non-GitHub URL', () => {
      expect(parseGitHubSource('https://gitlab.com/owner/repo')).toBeNull();
    });

    it('GitHub URL with only owner (no repo)', () => {
      expect(parseGitHubSource('https://github.com/owner')).toBeNull();
    });

    it('input with spaces', () => {
      expect(parseGitHubSource('owner / repo')).toBeNull();
    });
  });

  describe('full HTTPS URL', () => {
    it('owner/repo', () => {
      expect(parseGitHubSource('https://github.com/acme/widgets')).toEqual({
        owner: 'acme',
        repo: 'widgets',
        branch: undefined,
        subPath: undefined,
      });
    });

    it('owner/repo with .git suffix', () => {
      expect(parseGitHubSource('https://github.com/acme/widgets.git')).toEqual({
        owner: 'acme',
        repo: 'widgets',
        branch: undefined,
        subPath: undefined,
      });
    });

    it('owner/repo with trailing slash', () => {
      expect(parseGitHubSource('https://github.com/acme/widgets/')).toEqual({
        owner: 'acme',
        repo: 'widgets',
        branch: undefined,
        subPath: undefined,
      });
    });

    it('owner/repo with branch', () => {
      expect(
        parseGitHubSource('https://github.com/acme/widgets/tree/main'),
      ).toEqual({
        owner: 'acme',
        repo: 'widgets',
        branch: 'main',
        subPath: undefined,
      });
    });

    it('owner/repo with branch and subPath', () => {
      expect(
        parseGitHubSource(
          'https://github.com/acme/widgets/tree/main/src/components',
        ),
      ).toEqual({
        owner: 'acme',
        repo: 'widgets',
        branch: 'main',
        subPath: 'src/components',
      });
    });

    it('owner/repo with branch, subPath, and trailing slash', () => {
      expect(
        parseGitHubSource(
          'https://github.com/acme/widgets/tree/develop/packages/core/',
        ),
      ).toEqual({
        owner: 'acme',
        repo: 'widgets',
        branch: 'develop',
        subPath: 'packages/core/',
      });
    });

    it('HTTP URL (not HTTPS)', () => {
      expect(parseGitHubSource('http://github.com/acme/widgets')).toEqual({
        owner: 'acme',
        repo: 'widgets',
        branch: undefined,
        subPath: undefined,
      });
    });

    it('www.github.com URL', () => {
      expect(parseGitHubSource('https://www.github.com/acme/widgets')).toEqual({
        owner: 'acme',
        repo: 'widgets',
        branch: undefined,
        subPath: undefined,
      });
    });

    it('trims leading and trailing whitespace', () => {
      expect(parseGitHubSource('  https://github.com/acme/widgets  ')).toEqual({
        owner: 'acme',
        repo: 'widgets',
        branch: undefined,
        subPath: undefined,
      });
    });
  });

  describe('no-protocol github.com URL', () => {
    it('github.com/owner/repo', () => {
      expect(parseGitHubSource('github.com/acme/widgets')).toEqual({
        owner: 'acme',
        repo: 'widgets',
      });
    });

    it('github.com/owner/repo.git', () => {
      expect(parseGitHubSource('github.com/acme/widgets.git')).toEqual({
        owner: 'acme',
        repo: 'widgets',
      });
    });

    it('github.com/owner/repo with trailing slash', () => {
      expect(parseGitHubSource('github.com/acme/widgets/')).toEqual({
        owner: 'acme',
        repo: 'widgets',
      });
    });

    it('www.github.com/owner/repo', () => {
      expect(parseGitHubSource('www.github.com/acme/widgets')).toEqual({
        owner: 'acme',
        repo: 'widgets',
      });
    });
  });

  describe('owner/repo shorthand', () => {
    it('owner/repo', () => {
      expect(parseGitHubSource('acme/widgets')).toEqual({
        owner: 'acme',
        repo: 'widgets',
      });
    });

    it('owner/repo with @ suffix stripped', () => {
      expect(parseGitHubSource('acme/widgets@my-skill')).toEqual({
        owner: 'acme',
        repo: 'widgets',
      });
    });

    it('owner/repo with complex @ suffix', () => {
      expect(parseGitHubSource('org-name/repo-name@some-skill-v2')).toEqual({
        owner: 'org-name',
        repo: 'repo-name',
      });
    });

    it('trims whitespace around shorthand', () => {
      expect(parseGitHubSource('  acme/widgets  ')).toEqual({
        owner: 'acme',
        repo: 'widgets',
      });
    });
  });
});
