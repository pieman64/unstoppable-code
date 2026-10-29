import { posix, win32 } from 'node:path';

import { createCatalogRevision } from '../catalog-revision';
import {
  createFilesystemRoot,
  createFilesystemRootCatalog,
} from '../root-catalog';

const first = createFilesystemRoot({
  id: 'repo',
  name: 'Repository',
  kind: 'git-repo',
  absolutePath: '/work/repo',
  gitAware: true,
  excludedDescendantRoots: ['/work/repo/private'],
});
const second = createFilesystemRoot({
  id: 'notes',
  name: 'Notes',
  kind: 'standalone',
  absolutePath: '/work/notes',
});

describe('createCatalogRevision', () => {
  it('is stable across independent readers and does not expose private paths', async () => {
    const catalog = createFilesystemRootCatalog([first, second]);
    const rootIdentity = jest.fn((path: string) =>
      Promise.resolve(`native:${path}`),
    );
    const dependencies = { paths: posix, rootIdentity };

    const revision = await createCatalogRevision(
      catalog,
      dependencies,
      'scope',
    );
    const independentlyRead = await createCatalogRevision(
      createFilesystemRootCatalog([{ ...first }, { ...second }]),
      dependencies,
      'scope',
    );

    expect(revision).toMatch(/^[a-f0-9]{64}$/);
    expect(independentlyRead).toBe(revision);
    expect(revision).not.toContain('/work');
    expect(new Set(rootIdentity.mock.calls.map(([path]) => path))).toEqual(
      new Set(['/work/repo', '/work/repo/private', '/work/notes']),
    );
  });

  it('changes for scope, order, mapping, metadata, exclusions and native replacement', async () => {
    const catalog = createFilesystemRootCatalog([first, second]);
    const identities = new Map<string, string>();
    const rootIdentity = (path: string): Promise<string> =>
      Promise.resolve(identities.get(path) ?? `native:${path}`);
    const revision = (
      roots: typeof catalog.roots,
      scope = 'scope',
    ): Promise<string> =>
      createCatalogRevision(
        createFilesystemRootCatalog(roots),
        { paths: posix, rootIdentity },
        scope,
      );
    const original = await revision(catalog.roots);

    expect(await revision(catalog.roots, 'other')).not.toBe(original);
    const variants = [
      [second, first],
      [{ ...first, name: 'Renamed' }, second],
      [{ ...first, id: 'other' }, second],
      [{ ...first, kind: 'standalone' as const }, second],
      [{ ...first, gitAware: false }, second],
      [{ ...first, excludedDescendantRoots: ['/other'] }, second],
    ];
    for (const roots of variants)
      expect(await revision(roots)).not.toBe(original);
    identities.set('/work/repo', 'replacement-inode');
    expect(await revision(catalog.roots)).not.toBe(original);
    identities.delete('/work/repo');
    identities.set('/work/repo/private', 'replacement-exclusion');
    expect(await revision(catalog.roots)).not.toBe(original);
  });

  it('hashes duplicate ordered roots and the last-wins lookup mapping', async () => {
    const duplicate = { ...first, name: 'Later' };
    const dependencies = {
      paths: posix,
      rootIdentity: (path: string): Promise<string> => Promise.resolve(path),
    };
    const catalog = createFilesystemRootCatalog([first, duplicate]);
    const original = await createCatalogRevision(
      catalog,
      dependencies,
      'scope',
    );
    expect(
      await createCatalogRevision(
        createFilesystemRootCatalog([duplicate, first]),
        dependencies,
        'scope',
      ),
    ).not.toBe(original);
    expect(
      await createCatalogRevision(
        { roots: catalog.roots, byId: new Map([['repo', first]]) },
        dependencies,
        'scope',
      ),
    ).not.toBe(original);
  });

  it('canonicalizes Windows drives and slashes but preserves POSIX case', async () => {
    const rootIdentity = jest.fn((path: string) =>
      Promise.resolve(`id:${path}`),
    );
    const windows = (absolutePath: string, excluded: string): Promise<string> =>
      createCatalogRevision(
        createFilesystemRootCatalog([
          {
            ...first,
            absolutePath,
            excludedDescendantRoots: [excluded],
          },
        ]),
        { paths: win32, rootIdentity },
        'scope',
      );
    expect(await windows('C:\\Work\\Repo', 'C:\\Work\\Repo\\Private')).toBe(
      await windows('c:/work/./REPO', 'c:/WORK/repo/private'),
    );
    expect(rootIdentity).toHaveBeenCalledWith('c:\\work\\repo');
    expect(rootIdentity).toHaveBeenCalledWith('c:\\work\\repo\\private');

    const posixRevision = (absolutePath: string): Promise<string> =>
      createCatalogRevision(
        createFilesystemRootCatalog([{ ...second, absolutePath }]),
        { paths: posix, rootIdentity },
        'scope',
      );
    expect(await posixRevision('/Work/Notes')).not.toBe(
      await posixRevision('/work/notes'),
    );
  });

  it('uses the host-provided stable absent identity for missing managed roots', async () => {
    const rootIdentity = jest.fn((path: string) =>
      Promise.resolve(path.endsWith('/private') ? 'absent' : `present:${path}`),
    );
    const catalog = createFilesystemRootCatalog([first]);
    const dependencies = { paths: posix, rootIdentity };
    expect(await createCatalogRevision(catalog, dependencies, 'scope')).toBe(
      await createCatalogRevision(catalog, dependencies, 'scope'),
    );
    expect(rootIdentity).toHaveBeenCalledWith('/work/repo/private');
  });
});
