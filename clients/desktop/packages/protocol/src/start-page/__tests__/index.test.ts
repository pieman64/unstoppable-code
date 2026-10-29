import { isProjectStartPage } from '..';

describe('project start page contract', () => {
  it.each([
    { kind: 'file', path: 'README.md' },
    { kind: 'file', repoId: '__workspace_root__', path: 'site/index.html' },
    { kind: 'url', url: 'https://example.com/start' },
    { kind: 'url', url: 'http://localhost:3000/' },
  ])('accepts portable target %#', (target) => {
    expect(isProjectStartPage(target)).toBe(true);
  });

  it.each([
    null,
    { kind: 'file', path: '' },
    { kind: 'file', path: '../README.md' },
    { kind: 'file', path: '/README.md' },
    { kind: 'file', path: 'docs\\README.md' },
    { kind: 'file', repoId: '', path: 'README.md' },
    { kind: 'file', repoId: 'repo/id', path: 'README.md' },
    { kind: 'url', url: 'file:///tmp/index.html' },
    { kind: 'url', url: 'javascript:alert(1)' },
    { kind: 'url', url: 'https://example.com', extra: true },
    { kind: 'unknown', url: 'https://example.com' },
  ])('rejects unsafe target %#', (target) => {
    expect(isProjectStartPage(target)).toBe(false);
  });
});
