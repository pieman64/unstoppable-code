import { isGitHubTreeUrl } from '../github-tree-url';

describe('isGitHubTreeUrl', () => {
  it('accepts only the https GitHub shape the server builds', () => {
    expect(
      isGitHubTreeUrl(
        'https://github.com/openai/plugins/tree/5fd93af4cd0c623e020d0cc7e9ce178b4ac1f70f/plugins/game-studio',
      ),
    ).toBe(true);
    expect(isGitHubTreeUrl('https://github.com/anthropics/skills')).toBe(true);
  });

  it.each([
    'https://evil.example/tree/abc',
    'http://github.com/openai/plugins',
    'https://github.com.evil.test/x',
    'javascript:alert(1)',
    '',
    undefined,
    null,
    { href: 'https://github.com/openai/plugins' },
    ['https://github.com/openai/plugins'],
  ])('rejects %p', (value) => {
    expect(isGitHubTreeUrl(value)).toBe(false);
  });
});
