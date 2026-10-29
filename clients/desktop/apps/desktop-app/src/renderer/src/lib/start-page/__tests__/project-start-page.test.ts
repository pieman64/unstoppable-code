import type { FileTreeRoot } from '@canopy/desktop-shared/types';
import { WORKSPACE_ROOT_REPO_ID } from '@canopy/desktop-shared/types';
import {
  fileUrlToAbsolutePath,
  isHtmlStartPagePath,
  isHttpStartPageUrl,
  resolveStartPageAbsolutePath,
  startPageFromAbsolutePath,
  startPageFromBrowserUrl,
  startPageLabel,
  startPagesEqual,
} from '../project-start-page';

function root(repoId: string, absolutePath: string): FileTreeRoot {
  return { repoId, repoName: repoId, absolutePath, rootKind: 'repo' };
}

describe('project start page helpers', () => {
  it('labels files by name and URLs without their scheme', () => {
    expect(startPageLabel({ kind: 'file', path: 'docs/README.md' })).toBe(
      'README.md',
    );
    expect(
      startPageLabel({ kind: 'url', url: 'https://example.com/guide?x=1' }),
    ).toBe('example.com/guide?x=1');
    expect(startPageLabel({ kind: 'url', url: 'https://example.com/' })).toBe(
      'example.com',
    );
  });

  it('detects HTML paths and http(s) URLs', () => {
    expect(isHtmlStartPagePath('site/index.HTML')).toBe(true);
    expect(isHtmlStartPagePath('page.htm')).toBe(true);
    expect(isHtmlStartPagePath('README.md')).toBe(false);
    expect(isHttpStartPageUrl('https://example.com')).toBe(true);
    expect(isHttpStartPageUrl(' http://localhost:3000 ')).toBe(true);
    expect(isHttpStartPageUrl('file:///etc/passwd')).toBe(false);
    expect(isHttpStartPageUrl('not a url')).toBe(false);
  });

  it('compares start pages structurally', () => {
    expect(startPagesEqual(null, undefined)).toBe(true);
    expect(startPagesEqual(null, { kind: 'file', path: 'a.md' })).toBe(false);
    expect(
      startPagesEqual(
        { kind: 'file', repoId: 'r1', path: 'a.md' },
        { kind: 'file', repoId: 'r1', path: 'a.md' },
      ),
    ).toBe(true);
    expect(
      startPagesEqual(
        { kind: 'file', repoId: 'r1', path: 'a.md' },
        { kind: 'file', repoId: 'r2', path: 'a.md' },
      ),
    ).toBe(false);
    expect(
      startPagesEqual(
        { kind: 'url', url: 'https://a.test' },
        { kind: 'file', path: 'https://a.test' },
      ),
    ).toBe(false);
  });

  it('resolves single-root and multi-repo file start pages', () => {
    const single = [root('repo', '/work/app')];
    expect(
      resolveStartPageAbsolutePath(
        { kind: 'file', path: 'docs/README.md' },
        single,
      ),
    ).toBe('/work/app/docs/README.md');

    const multi = [
      root(WORKSPACE_ROOT_REPO_ID, '/work/ws'),
      root('api', '/work/ws/api'),
    ];
    expect(
      resolveStartPageAbsolutePath(
        { kind: 'file', repoId: 'api', path: 'README.md' },
        multi,
      ),
    ).toBe('/work/ws/api/README.md');
    expect(
      resolveStartPageAbsolutePath({ kind: 'file', path: 'index.html' }, multi),
    ).toBe('/work/ws/index.html');
    expect(
      resolveStartPageAbsolutePath(
        { kind: 'file', repoId: 'missing', path: 'README.md' },
        multi,
      ),
    ).toBeNull();
    expect(
      resolveStartPageAbsolutePath(
        { kind: 'url', url: 'https://a.test' },
        single,
      ),
    ).toBeNull();
  });

  it('maps absolute paths back to portable start pages', () => {
    const multi = [
      root(WORKSPACE_ROOT_REPO_ID, '/work/ws'),
      root('api', '/work/ws/api'),
    ];
    expect(
      startPageFromAbsolutePath('/work/ws/api/docs/a.md', multi, 'multi-repo'),
    ).toEqual({ kind: 'file', repoId: 'api', path: 'docs/a.md' });
    expect(
      startPageFromAbsolutePath(
        '/work/app/README.md',
        [root('repo', '/work/app')],
        'single-repo',
      ),
    ).toEqual({ kind: 'file', path: 'README.md' });
    expect(
      startPageFromAbsolutePath(
        '/elsewhere/a.md',
        [root('repo', '/work/app')],
        'cowork',
      ),
    ).toBeNull();
  });

  it('reads absolute paths from file URLs only', () => {
    expect(fileUrlToAbsolutePath('file:///work/app/My%20Page.html')).toBe(
      '/work/app/My Page.html',
    );
    expect(fileUrlToAbsolutePath('file:///C:/work/index.html')).toBe(
      'C:/work/index.html',
    );
    expect(fileUrlToAbsolutePath('https://example.com')).toBeNull();
  });

  it('maps only supported browser URLs to start pages', () => {
    const roots = [root('repo', '/work/app')];
    expect(
      startPageFromBrowserUrl(
        'file:///work/app/docs/index.html',
        roots,
        'single-repo',
      ),
    ).toEqual({ kind: 'file', path: 'docs/index.html' });
    expect(
      startPageFromBrowserUrl('https://example.com/guide', roots, 'cowork'),
    ).toEqual({ kind: 'url', url: 'https://example.com/guide' });
    expect(
      startPageFromBrowserUrl('about:blank', roots, 'single-repo'),
    ).toBeNull();
  });
});
