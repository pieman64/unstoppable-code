import { WORKSPACE_ROOT_REPO_ID } from '@canopy/desktop-shared/types';
import { mapProjectStartPageForPublication } from '../shared-containers/publish/start-page';

const roots = [
  {
    repoId: 'repo-1',
    absolutePath: '/repo',
    publishedPaths: new Set(['README.md']),
  },
];

describe('mapProjectStartPageForPublication', () => {
  it('maps included files and URLs', () => {
    expect(
      mapProjectStartPageForPublication(
        { kind: 'file', path: 'README.md' },
        roots,
      ),
    ).toEqual({ kind: 'file', repoId: 'repo-1', relativePath: 'README.md' });
    expect(
      mapProjectStartPageForPublication(
        { kind: 'url', url: 'https://example.com/start' },
        roots,
      ),
    ).toEqual({ kind: 'url', url: 'https://example.com/start' });
  });

  it('drops withheld files and ambiguous repo-less targets', () => {
    expect(
      mapProjectStartPageForPublication(
        { kind: 'file', path: 'private.txt' },
        roots,
      ),
    ).toBeNull();
    expect(
      mapProjectStartPageForPublication({ kind: 'file', path: 'README.md' }, [
        ...roots,
        { ...roots[0], repoId: 'repo-2' },
      ]),
    ).toBeNull();
  });

  it('resolves repo-less multi-repo targets against the workspace root, like the renderer', () => {
    // A multi-repo workspace-root canopy.json naturally omits repoId; the
    // renderer opens it from the workspace root, so it must also publish.
    expect(
      mapProjectStartPageForPublication({ kind: 'file', path: 'README.md' }, [
        { ...roots[0], repoId: 'repo-2' },
        { ...roots[0], repoId: WORKSPACE_ROOT_REPO_ID },
      ]),
    ).toEqual({
      kind: 'file',
      repoId: WORKSPACE_ROOT_REPO_ID,
      relativePath: 'README.md',
    });
  });
});
