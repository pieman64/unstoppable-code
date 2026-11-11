/**
 * CAN-5038 golden: `file-reference:resolve` (markdown link resolution)
 * pinned at the IPC boundary on real temporary filesystems. Captured on the
 * resolver that ran in `ipc/file-preview.ts`, before the handler became a
 * projection over `worker.filesystem.link.resolve`. Every failure answers
 * `null`; a hit answers the root-aligned absolute path, the resolved name and
 * whether it is a file or a directory.
 */
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  IPC_CHANNELS,
  type FileReferenceResolveResponse,
} from '@canopy/desktop-shared/types';
import type { FileBrowserRoot } from '../../lib/file-browser-roots';

type Handler = (event: unknown, request: unknown) => unknown;
const handlers = new Map<string, Handler>();
jest.mock('../register', () => ({
  registerIpcHandler: (channel: string, handler: Handler): void => {
    handlers.set(channel, handler);
  },
}));

jest.mock('electron', () => ({
  nativeImage: { createThumbnailFromPath: jest.fn() },
  shell: { openExternal: jest.fn(), showItemInFolder: jest.fn() },
}));

jest.mock('../../lib/file-browser-roots', () => ({
  getFileBrowserRoots: jest.fn(),
  getFileBrowserSupplementalWatchPaths: jest.fn(() => []),
}));

import { getFileBrowserRoots } from '../../lib/file-browser-roots';
import {
  createDesktopRuntime,
  type DesktopCanopyDispatcher,
} from '../../canopy-runtime/desktop-runtime';
import { LOCAL_DESKTOP_AUTHORITY_ID } from '../../canopy-runtime/desktop-runtime-identity';
import { registerFilePreviewHandlers } from '../file-preview';

const mockedGetFileBrowserRoots = jest.mocked(getFileBrowserRoots);
const posix = process.platform === 'win32' ? describe.skip : describe;
const invokeEvent = { sender: { id: 43 } };

let runtime: DesktopCanopyDispatcher | undefined;

/** The only part of this file that follows the handler's registration. */
function registerHandlers(): void {
  runtime = createDesktopRuntime({ shutdownTimeoutMs: 1_000 });
  registerFilePreviewHandlers(runtime, (event) => ({
    principalId: 'local',
    clientInstanceId: `electron-web-contents:${event.sender.id}`,
    authorityId: LOCAL_DESKTOP_AUTHORITY_ID,
    interfaceKind: 'desktop',
    grants: ['worker.filesystem.read'],
  }));
}

function resolveReference(
  baseFilePath: string,
  href: string,
  mode?: 'transcript',
): Promise<FileReferenceResolveResponse> {
  const handler = handlers.get(IPC_CHANNELS.fileReferenceResolve);
  if (!handler) throw new Error('file-reference:resolve is not registered.');
  return Promise.resolve(
    handler(invokeEvent, {
      projectId: 'project-1',
      worktreeId: 'wt-1',
      baseFilePath,
      href,
      ...(mode ? { mode } : {}),
    }),
  ).then((value) => value as FileReferenceResolveResponse);
}

function root(
  repoId: string,
  repoName: string,
  absolutePath: string,
  rootKind: FileBrowserRoot['rootKind'],
): FileBrowserRoot {
  return {
    repoId,
    repoName,
    absolutePath,
    rootKind,
    gitAware: rootKind === 'git-repo',
    excludedDescendantRoots: [],
  };
}

function setRoots(roots: FileBrowserRoot[]): void {
  mockedGetFileBrowserRoots.mockImplementation(() =>
    Promise.resolve({
      roots,
      rootMap: new Map(roots.map((entry) => [entry.repoId, entry])),
    }),
  );
}

async function put(path: string, content = 'x'): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, content);
}

const file = (
  absolutePath: string,
  filename: string,
): FileReferenceResolveResponse => ({ absolutePath, filename, kind: 'file' });
const directory = (
  absolutePath: string,
  filename: string,
): FileReferenceResolveResponse => ({
  absolutePath,
  filename,
  kind: 'directory',
});

let tempRoot = '';

beforeEach(async () => {
  // Real paths, so expectations match the resolver's realpath spellings.
  tempRoot = await mkdtemp(join(tmpdir(), 'file-reference-golden-'));
  tempRoot = execFileSync('realpath', [tempRoot], { encoding: 'utf8' }).trim();
  handlers.clear();
  mockedGetFileBrowserRoots.mockReset();
  registerHandlers();
});

afterEach(async () => {
  await runtime?.shutdown();
  runtime = undefined;
  await rm(tempRoot, { recursive: true, force: true });
});

posix('single-repository worktree', () => {
  let repo = '';
  let attachments = '';
  let outside = '';
  let base = '';

  beforeEach(async () => {
    repo = join(tempRoot, 'repo');
    attachments = join(tempRoot, 'attachments');
    outside = join(tempRoot, 'outside');
    base = join(repo, 'docs', 'readme.md');
    await put(base, '# Readme');
    await put(join(repo, 'README.md'));
    await put(join(repo, 'docs', 'guide.md'));
    await put(join(repo, 'docs', 'space file.md'));
    await mkdir(join(repo, 'docs', 'sub'), { recursive: true });
    await put(join(repo, '.git', 'config'));
    await put(join(attachments, 'image.png'));
    await put(join(outside, 'secret.md'));
    setRoots([
      root('project-1', 'project-1', repo, 'git-repo'),
      root('attachments', 'attachments', attachments, 'attachments'),
    ]);
  });

  it.each([
    '日本語 🌲.ts',
    "space and apostrophe's.ts",
    'literal\\name.ts',
    'report:12.ts',
  ])(
    'preserves encoded filesystem identity across markdown and transcript dispatch: %s',
    async (name) => {
      await put(join(repo, 'docs', name), name);
      // A directory spelling must never win over a literal POSIX backslash.
      await put(join(repo, 'docs', 'literal', 'name.ts'), 'decoy');
      await expect(
        resolveReference(base, encodeURIComponent(name)),
      ).resolves.toEqual(file(join(repo, 'docs', name), name));
      await expect(
        resolveReference(join(repo, 'docs', name), encodeURIComponent(name)),
      ).resolves.toEqual(file(join(repo, 'docs', name), name));
      await expect(
        resolveReference(
          base,
          `docs/${encodeURIComponent(name)}`,
          'transcript',
        ),
      ).resolves.toEqual({
        ...file(join(repo, 'docs', name), name),
        canonical: {
          fileRootId: 'project-1',
          relativePath: `docs/${name}`,
          name,
          kind: 'file',
        },
      });
    },
  );

  it('resolves links relative to the base file', async () => {
    await expect(resolveReference(base, 'guide.md')).resolves.toEqual(
      file(join(repo, 'docs', 'guide.md'), 'guide.md'),
    );
    await expect(resolveReference(base, './guide.md')).resolves.toEqual(
      file(join(repo, 'docs', 'guide.md'), 'guide.md'),
    );
    await expect(resolveReference(base, '../README.md')).resolves.toEqual(
      file(join(repo, 'README.md'), 'README.md'),
    );
    // URL resolution treats backslashes as separators.
    await expect(resolveReference(base, '..\\README.md')).resolves.toEqual(
      file(join(repo, 'README.md'), 'README.md'),
    );
  });

  it('percent-decodes and drops the query and fragment', async () => {
    await expect(resolveReference(base, 'space%20file.md')).resolves.toEqual(
      file(join(repo, 'docs', 'space file.md'), 'space file.md'),
    );
    await expect(resolveReference(base, 'guide.md?raw=1#L2')).resolves.toEqual(
      file(join(repo, 'docs', 'guide.md'), 'guide.md'),
    );
  });

  it('resolves directories, including the root itself', async () => {
    await expect(resolveReference(base, './sub')).resolves.toEqual(
      directory(join(repo, 'docs', 'sub'), 'sub'),
    );
    await expect(resolveReference(base, './')).resolves.toEqual(
      directory(join(repo, 'docs'), 'docs'),
    );
    await expect(resolveReference(base, '..')).resolves.toEqual(
      directory(repo, 'repo'),
    );
  });

  it('resolves absolute paths and file URLs inside a root', async () => {
    const guide = join(repo, 'docs', 'guide.md');
    await expect(resolveReference(base, guide)).resolves.toEqual(
      file(guide, 'guide.md'),
    );
    await expect(
      resolveReference(base, pathToFileURL(guide).href),
    ).resolves.toEqual(file(guide, 'guide.md'));
    await expect(
      resolveReference(base, join(attachments, 'image.png')),
    ).resolves.toEqual(file(join(attachments, 'image.png'), 'image.png'));
  });

  it.each([
    ['an empty link', ''],
    ['a fragment', '#section'],
    ['a protocol-relative link', '//host/share/file.md'],
    ['a remote URL', 'https://example.com/guide.md'],
    ['a mailto link', 'mailto:someone@example.com'],
    ['a drive-letter path', 'C:/repo/docs/guide.md'],
    ['malformed percent-encoding', 'guide%E0%A4%A.md'],
    ['a missing file', 'missing.md'],
  ])('returns null for %s', async (_label, href) => {
    await expect(resolveReference(base, href)).resolves.toBeNull();
  });

  it('returns null for traversal and absolute paths outside every root', async () => {
    await expect(
      resolveReference(base, '../../outside/secret.md'),
    ).resolves.toBeNull();
    await expect(
      resolveReference(base, join(outside, 'secret.md')),
    ).resolves.toBeNull();
    await expect(
      resolveReference(base, pathToFileURL(join(outside, 'secret.md')).href),
    ).resolves.toBeNull();
  });

  it('refuses .git paths, by link text and by resolved path', async () => {
    await expect(resolveReference(base, '../.git/config')).resolves.toBeNull();
    await expect(resolveReference(base, '../.git')).resolves.toBeNull();
    await symlink(join(repo, '.git', 'config'), join(repo, 'git-config'));
    await expect(resolveReference(base, '../git-config')).resolves.toBeNull();
  });

  it('follows symlinks inside the roots and refuses symlink escapes', async () => {
    await symlink(join(repo, 'docs', 'guide.md'), join(repo, 'alias.md'));
    await expect(resolveReference(base, '../alias.md')).resolves.toEqual(
      file(join(repo, 'docs', 'guide.md'), 'guide.md'),
    );
    // A link into another root of the same worktree resolves there.
    await symlink(join(attachments, 'image.png'), join(repo, 'to-image.png'));
    await expect(resolveReference(base, '../to-image.png')).resolves.toEqual(
      file(join(attachments, 'image.png'), 'image.png'),
    );
    await symlink(join(outside, 'secret.md'), join(repo, 'escape.md'));
    await expect(resolveReference(base, '../escape.md')).resolves.toBeNull();
    await symlink(outside, join(repo, 'escape-dir'));
    await expect(
      resolveReference(base, '../escape-dir/secret.md'),
    ).resolves.toBeNull();
  });

  it('returns null for a target that is neither a file nor a directory', async () => {
    execFileSync('mkfifo', [join(repo, 'docs', 'pipe')]);
    await expect(resolveReference(base, 'pipe')).resolves.toBeNull();
  });

  it('resolves against a base outside every root', async () => {
    const outsideBase = join(outside, 'notes', 'note.md');
    await put(outsideBase);
    await expect(
      resolveReference(outsideBase, '../../repo/docs/guide.md'),
    ).resolves.toEqual(file(join(repo, 'docs', 'guide.md'), 'guide.md'));
    await expect(
      resolveReference(outsideBase, join(repo, 'README.md')),
    ).resolves.toEqual(file(join(repo, 'README.md'), 'README.md'));
    await expect(
      resolveReference(outsideBase, '../secret.md'),
    ).resolves.toBeNull();
    // A base that names a root-relative directory with a trailing slash.
    await expect(
      resolveReference(`${join(repo, 'docs')}/`, 'guide.md'),
    ).resolves.toEqual(file(join(repo, 'docs', 'guide.md'), 'guide.md'));
    // A root itself as the base resolves against its parent directory.
    await expect(resolveReference(repo, 'repo/README.md')).resolves.toEqual(
      file(join(repo, 'README.md'), 'README.md'),
    );
  });
});

posix('a root advertised through a symlink', () => {
  let real = '';
  let link = '';

  beforeEach(async () => {
    real = join(tempRoot, 'real-repo');
    link = join(tempRoot, 'linked-repo');
    await put(join(real, 'docs', 'readme.md'));
    await put(join(real, 'docs', 'guide.md'));
    await symlink(real, link);
    setRoots([root('project-1', 'project-1', link, 'git-repo')]);
  });

  it('answers paths through the advertised root spelling', async () => {
    const base = join(link, 'docs', 'readme.md');
    await expect(resolveReference(base, 'guide.md')).resolves.toEqual(
      file(join(link, 'docs', 'guide.md'), 'guide.md'),
    );
    await expect(
      resolveReference(base, join(real, 'docs', 'guide.md')),
    ).resolves.toEqual(file(join(link, 'docs', 'guide.md'), 'guide.md'));
    await expect(resolveReference(base, '..')).resolves.toEqual(
      directory(link, 'real-repo'),
    );
  });
});

posix('multi-repository worktree', () => {
  let home = '';
  let api = '';
  let app = '';
  let base = '';

  beforeEach(async () => {
    home = join(tempRoot, 'home');
    api = join(home, 'repos', 'api-id');
    app = join(home, 'repos', 'app-id');
    base = join(app, 'README.md');
    await put(join(home, 'NOTES.md'));
    await put(base);
    await put(join(app, 'docs', 'local.md'));
    await put(join(api, 'docs', 'space file.md'));
    await put(join(api, 'docs', 'routes.md'));
    await put(join(tempRoot, 'outside.md'));
    setRoots([
      root('__workspace_root__', 'Project root', home, 'workspace-root'),
      root('api-id', 'api', api, 'git-repo'),
      root('app-id', 'app', app, 'git-repo'),
    ]);
  });

  it('resolves the first path segment as a root name or id', async () => {
    const routes = join(api, 'docs', 'routes.md');
    // The workspace root comes first and contains every child checkout.
    await expect(resolveReference(base, 'api/docs/routes.md')).resolves.toEqual(
      file(routes, 'routes.md'),
    );
    await expect(
      resolveReference(base, 'api-id/docs/routes.md#section'),
    ).resolves.toEqual(file(routes, 'routes.md'));
    await expect(
      resolveReference(base, 'api\\docs\\routes.md'),
    ).resolves.toEqual(file(routes, 'routes.md'));
    await expect(
      resolveReference(base, 'api/docs/space%20file.md?raw=1'),
    ).resolves.toEqual(
      file(join(api, 'docs', 'space file.md'), 'space file.md'),
    );
    await expect(resolveReference(base, 'api/docs')).resolves.toEqual(
      directory(join(api, 'docs'), 'docs'),
    );
    await expect(resolveReference(base, 'api/')).resolves.toEqual(
      directory(api, 'api-id'),
    );
  });

  it('keeps the shortcut for links with one segment, a colon or a leading slash', async () => {
    // One segment is relative to the base, not a root.
    await expect(resolveReference(base, 'api')).resolves.toBeNull();
    await expect(
      resolveReference(base, '/api/docs/routes.md'),
    ).resolves.toBeNull();
    await expect(
      resolveReference(base, 'api:/docs/routes.md'),
    ).resolves.toBeNull();
  });

  it('contains shortcut traversal by the resolved path', async () => {
    await expect(
      resolveReference(base, 'api/../app-id/docs/local.md'),
    ).resolves.toEqual(file(join(app, 'docs', 'local.md'), 'local.md'));
    await expect(
      resolveReference(base, 'api/../../../outside.md'),
    ).resolves.toBeNull();
  });

  it('answers overlapping roots through the first root in catalog order', async () => {
    await expect(resolveReference(base, 'docs/local.md')).resolves.toEqual(
      file(join(app, 'docs', 'local.md'), 'local.md'),
    );
    await expect(resolveReference(base, '../../NOTES.md')).resolves.toEqual(
      file(join(home, 'NOTES.md'), 'NOTES.md'),
    );
  });
});
