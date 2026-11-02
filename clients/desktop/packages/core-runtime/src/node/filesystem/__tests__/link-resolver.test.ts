import { execFileSync } from 'node:child_process';
import {
  lstat,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as paths from 'node:path';
import { pathToFileURL } from 'node:url';
import { WorkerFilesystemLinkResolveResultSchema } from '@canopy/protocol/canopy-core';
import { CanopyOperationError } from '../../../runtime/errors';
import { readNativeRootIdentity } from '../catalog-revision';
import {
  decodeTranscriptLink,
  markdownLinkCandidatePath,
  resolveFilesystemLink,
  type FilesystemLinkIo,
  type FilesystemLinkResolveInput,
  type FilesystemLinkRoot,
} from '../link-resolver';
import { resolveFilesystemScopeLink } from '../scope-queries';
import type { FilesystemScopeDependencies } from '../scope-reader';
import { inventory } from './no-write-proof';

const posix = process.platform === 'win32' ? describe.skip : describe;

let tempRoot = '';
let home = '';
let api = '';
let attachments = '';
let outside = '';

/** A multi-repository shape: the workspace root contains the child checkout. */
function roots(): FilesystemLinkRoot[] {
  return [
    { id: '__workspace_root__', name: 'Project root', absolutePath: home },
    { id: 'api-id', name: 'api', absolutePath: api },
    { id: 'attachments', name: 'attachments', absolutePath: attachments },
  ];
}

async function put(path: string, content = 'x'): Promise<void> {
  await mkdir(paths.dirname(path), { recursive: true });
  await writeFile(path, content);
}

beforeEach(async () => {
  tempRoot = execFileSync('realpath', [
    await mkdtemp(paths.join(tmpdir(), 'link-resolver-')),
  ])
    .toString()
    .trim();
  home = paths.join(tempRoot, 'home');
  api = paths.join(home, 'repos', 'api-id');
  attachments = paths.join(tempRoot, 'attachments');
  outside = paths.join(tempRoot, 'outside');
  await put(paths.join(home, 'README.md'));
  await put(paths.join(home, '.git', 'HEAD'));
  await put(paths.join(api, 'docs', 'guide.md'));
  await put(paths.join(api, 'docs', 'space file.md'));
  await put(paths.join(api, 'shared.md'));
  await put(paths.join(attachments, 'shared.md'));
  await put(paths.join(attachments, 'image.png'));
  await put(paths.join(outside, 'secret.md'));
});

afterEach(async () => {
  await rm(tempRoot, { recursive: true, force: true });
});

async function failure(
  promise: Promise<unknown>,
): Promise<CanopyOperationError['payload']> {
  const error: unknown = await promise.then(
    () => undefined,
    (cause: unknown) => cause,
  );
  if (!(error instanceof CanopyOperationError))
    throw new Error(`Expected a typed failure, got ${String(error)}`);
  return error.payload;
}

function resolve(
  input: Omit<FilesystemLinkResolveInput, 'roots'>,
): ReturnType<typeof resolveFilesystemLink> {
  return resolveFilesystemLink({ roots: roots(), ...input });
}

function markdown(
  href: string,
  base = { fileRootId: 'api-id', relativePath: 'docs/guide.md' },
): ReturnType<typeof resolveFilesystemLink> {
  return resolve({ mode: 'markdown', href, base: { kind: 'root', ...base } });
}

function transcript(href: string): ReturnType<typeof resolveFilesystemLink> {
  return resolve({ mode: 'transcript', href });
}

const code = (reason: string, kind = 'not_found'): Record<string, unknown> => ({
  kind,
  code: `worker.filesystem.link.${reason}`,
  retry: { kind: 'never' },
});

posix('markdown mode', () => {
  it('resolves relative to the base file through the first containing root', async () => {
    const resolved = await markdown('space%20file.md?raw=1#top');
    // The workspace root comes first and contains the child checkout.
    expect(resolved.result).toEqual({
      fileRootId: '__workspace_root__',
      relativePath: 'repos/api-id/docs/space file.md',
      name: 'space file.md',
      kind: 'file',
    });
    expect(resolved.rootAbsolutePath).toBe(home);
    expect(
      WorkerFilesystemLinkResolveResultSchema.safeParse(resolved.result)
        .success,
    ).toBe(true);
  });

  it('resolves the root-name and root-id shortcut and directories', async () => {
    await expect(markdown('api/docs/guide.md')).resolves.toMatchObject({
      result: { relativePath: 'repos/api-id/docs/guide.md', kind: 'file' },
    });
    await expect(markdown('attachments/image.png')).resolves.toMatchObject({
      result: {
        fileRootId: 'attachments',
        relativePath: 'image.png',
        kind: 'file',
      },
    });
    await expect(markdown('attachments/')).resolves.toMatchObject({
      result: {
        fileRootId: 'attachments',
        relativePath: '',
        name: 'attachments',
        kind: 'directory',
      },
    });
    await expect(markdown('..')).resolves.toMatchObject({
      result: { relativePath: 'repos/api-id', kind: 'directory' },
    });
  });

  it('accepts a trusted host base in process', async () => {
    await expect(
      resolve({
        mode: 'markdown',
        href: '../home/README.md',
        base: { kind: 'host', absolutePath: paths.join(outside, 'note.md') },
      }),
    ).resolves.toMatchObject({
      result: { fileRootId: '__workspace_root__', relativePath: 'README.md' },
    });
  });

  it('accepts a root base up to the path limit, which need not exist', async () => {
    const deep = 'd/'.repeat(16_381) + 'x.md';
    expect(deep).toHaveLength(32_766);
    await expect(
      markdown(`${'../'.repeat(16_381)}shared.md`, {
        fileRootId: 'api-id',
        relativePath: deep,
      }),
    ).resolves.toMatchObject({
      result: { relativePath: 'repos/api-id/shared.md' },
    });
    await expect(
      failure(
        markdown('shared.md', {
          fileRootId: 'api-id',
          relativePath: `${deep}xy`,
        }),
      ),
    ).resolves.toMatchObject(code('unsupported', 'invalid_argument'));
  });

  it('refuses traversal outside every root as outsideRoots', async () => {
    await expect(
      failure(markdown('../../../../outside/secret.md')),
    ).resolves.toMatchObject(code('outsideRoots'));
    await expect(
      failure(markdown(paths.join(outside, 'secret.md'))),
    ).resolves.toMatchObject(code('outsideRoots'));
    await expect(
      failure(markdown('api/../../../outside/secret.md')),
    ).resolves.toMatchObject(code('outsideRoots'));
  });

  it('answers traversal to a missing target as outsideRoots, not notFound', async () => {
    // Existence outside the roots is never observable through this read.
    for (const href of [
      '../../../../outside/missing.md',
      '../../../../no-such-dir/missing.md',
      paths.join(outside, 'missing.md'),
      pathToFileURL(paths.join(outside, 'missing.md')).href,
    ])
      await expect(failure(markdown(href))).resolves.toMatchObject(
        code('outsideRoots'),
      );
  });

  it('refuses a symlink that leaves every root as symlinkEscape', async () => {
    await symlink(
      paths.join(outside, 'secret.md'),
      paths.join(api, 'escape.md'),
    );
    await expect(failure(markdown('../escape.md'))).resolves.toMatchObject(
      code('symlinkEscape'),
    );
    await symlink(outside, paths.join(api, 'escape-dir'));
    await expect(
      failure(markdown('../escape-dir/secret.md')),
    ).resolves.toMatchObject(code('symlinkEscape'));
  });

  it('answers present and missing targets through an escaping symlinked directory alike', async () => {
    // Otherwise the failure would reveal whether a path outside the roots exists.
    await symlink(outside, paths.join(api, 'escape-dir'));
    for (const name of [
      'secret.md',
      'missing.md',
      'no-dir/missing.md',
      'secret.md/below',
    ]) {
      const absolute = paths.join(api, 'escape-dir', name);
      for (const href of [
        `../escape-dir/${name}`,
        `api/escape-dir/${name}`,
        absolute,
        pathToFileURL(absolute).href,
      ])
        await expect(failure(markdown(href))).resolves.toMatchObject(
          code('symlinkEscape'),
        );
    }
  });

  it('answers a symlink whose outside target is present or missing alike', async () => {
    // A dangling symlink must not reveal that its outside target is missing.
    await symlink(
      paths.join(outside, 'secret.md'),
      paths.join(api, 'to-present'),
    );
    await symlink(
      paths.join(outside, 'missing.md'),
      paths.join(api, 'to-missing'),
    );
    await symlink(outside, paths.join(api, 'to-dir'));
    await symlink(paths.join(outside, 'no-dir'), paths.join(api, 'to-no-dir'));
    for (const href of [
      '../to-present',
      '../to-missing',
      '../to-dir/x.md',
      '../to-no-dir/x.md',
      'api/to-missing',
      paths.join(api, 'to-no-dir', 'x.md'),
    ])
      await expect(failure(markdown(href))).resolves.toMatchObject(
        code('symlinkEscape'),
      );
  });

  it('does not reveal a .git target reached through a symlink outside the roots', async () => {
    await mkdir(paths.join(tempRoot, 'other', '.git'), { recursive: true });
    await symlink(outside, paths.join(api, 'escape-dir'));
    await symlink(
      paths.join(tempRoot, 'other', '.git'),
      paths.join(outside, 'git-link'),
    );
    for (const href of [
      '../escape-dir/git-link/HEAD',
      '../escape-dir/no-link/HEAD',
    ])
      await expect(failure(markdown(href))).resolves.toMatchObject(
        code('symlinkEscape'),
      );
  });

  it('answers present and missing targets through a symlink into .git alike', async () => {
    await symlink(paths.join(home, '.git'), paths.join(api, 'git-dir'));
    for (const href of ['../git-dir/HEAD', '../git-dir/missing'])
      await expect(failure(markdown(href))).resolves.toMatchObject(
        code('outsideRoots'),
      );
  });

  it('finds the deepest existing ancestor in logarithmically many realpath calls', async () => {
    const calls: string[] = [];
    const io: FilesystemLinkIo = {
      realpath: (path: string): Promise<string> => {
        calls.push(path);
        return realpath(path);
      },
      stat,
      lstat,
    };
    const href = `${'missing/'.repeat(40_000)}x.md`;
    await expect(
      failure(
        resolve({
          mode: 'markdown',
          href,
          base: { kind: 'root', fileRootId: 'api-id', relativePath: 'a.md' },
          io,
        }),
      ),
    ).resolves.toMatchObject(code('notFound'));
    // Three roots, the candidate, then a binary search over 40,001 ancestors.
    expect(calls.length).toBeLessThan(30);
    calls.length = 0;
    await symlink(outside, paths.join(api, 'escape-dir'));
    await expect(
      failure(
        resolve({
          mode: 'transcript',
          // Within transcript mode's 4,096-character limit.
          href: `escape-dir/${'m/'.repeat(2_000)}x.md`,
          io,
        }),
      ),
    ).resolves.toMatchObject(code('symlinkEscape'));
    expect(calls.length).toBeLessThan(80);
  });

  it('keeps a missing target under a root that cannot be resolved notFound', async () => {
    const gone = paths.join(tempRoot, 'gone-root');
    await expect(
      failure(
        resolveFilesystemLink({
          roots: [...roots(), { id: 'gone', name: 'gone', absolutePath: gone }],
          mode: 'markdown',
          href: paths.join(gone, 'a.md'),
          base: { kind: 'root', fileRootId: 'api-id', relativePath: 'x.md' },
        }),
      ),
    ).resolves.toMatchObject(code('notFound'));
  });

  it('follows a symlink into another root and answers the target', async () => {
    await symlink(
      paths.join(attachments, 'image.png'),
      paths.join(api, 'to-image.png'),
    );
    await expect(markdown('../to-image.png')).resolves.toMatchObject({
      result: {
        fileRootId: 'attachments',
        relativePath: 'image.png',
        name: 'image.png',
      },
    });
  });

  it('refuses .git by spelling and by resolved path', async () => {
    await expect(
      failure(markdown('../../../.git/HEAD')),
    ).resolves.toMatchObject(code('outsideRoots'));
    await symlink(paths.join(home, '.git', 'HEAD'), paths.join(api, 'head'));
    await expect(failure(markdown('../head'))).resolves.toMatchObject(
      code('outsideRoots'),
    );
  });

  it('types missing targets, non-file links and bad requests', async () => {
    await expect(failure(markdown('missing.md'))).resolves.toMatchObject(
      code('notFound'),
    );
    for (const href of [
      '',
      '#top',
      '//host/x',
      'https://x.test/a',
      'a%E0%A4%A',
    ])
      await expect(failure(markdown(href))).resolves.toMatchObject(
        code('unsupported', 'invalid_argument'),
      );
    execFileSync('mkfifo', [paths.join(api, 'docs', 'pipe')]);
    await expect(failure(markdown('pipe'))).resolves.toMatchObject(
      code('unsupported', 'invalid_argument'),
    );
    await expect(
      failure(resolve({ mode: 'markdown', href: 'guide.md' })),
    ).resolves.toMatchObject(code('unsupported', 'invalid_argument'));
    for (const relativePath of ['../x.md', 'docs/./guide.md', '/docs/x.md'])
      await expect(
        failure(markdown('guide.md', { fileRootId: 'api-id', relativePath })),
      ).resolves.toMatchObject(code('unsupported', 'invalid_argument'));
    await expect(
      failure(
        markdown('guide.md', { fileRootId: 'gone', relativePath: 'a.md' }),
      ),
    ).resolves.toMatchObject(code('notFound'));
  });
});

posix('transcript mode', () => {
  it('resolves a unique relative link and keeps .git', async () => {
    await expect(transcript('docs/guide.md#L3')).resolves.toMatchObject({
      result: {
        fileRootId: 'api-id',
        relativePath: 'docs/guide.md',
        name: 'guide.md',
        kind: 'file',
      },
      rootAbsolutePath: api,
    });
    await expect(transcript('.git/HEAD')).resolves.toMatchObject({
      result: { fileRootId: '__workspace_root__', relativePath: '.git/HEAD' },
    });
  });

  it('resolves absolute host text and file URLs in one root', async () => {
    const image = paths.join(attachments, 'image.png');
    for (const href of [image, pathToFileURL(image).href, `${image}?raw=1`])
      await expect(transcript(href)).resolves.toMatchObject({
        result: { fileRootId: 'attachments', relativePath: 'image.png' },
      });
  });

  it('refuses overlapping roots and duplicate relative paths as ambiguous', async () => {
    const ambiguous = code('ambiguous', 'failed_precondition');
    await expect(
      failure(transcript(paths.join(api, 'docs', 'guide.md'))),
    ).resolves.toMatchObject(ambiguous);
    await expect(failure(transcript('shared.md'))).resolves.toMatchObject(
      ambiguous,
    );
  });

  it('refuses traversal and absolute paths outside every root', async () => {
    await expect(
      failure(transcript('docs/../docs/guide.md')),
    ).resolves.toMatchObject(code('outsideRoots'));
    await expect(
      failure(transcript(paths.join(outside, 'secret.md'))),
    ).resolves.toMatchObject(code('outsideRoots'));
    // Existence outside the roots is never observable through this read.
    for (const href of [
      paths.join(outside, 'missing.md'),
      pathToFileURL(paths.join(tempRoot, 'no-such-dir', 'missing.md')).href,
    ])
      await expect(failure(transcript(href))).resolves.toMatchObject(
        code('outsideRoots'),
      );
  });

  it('refuses symlink escapes, including into a sibling root', async () => {
    await symlink(
      paths.join(outside, 'secret.md'),
      paths.join(api, 'escape.md'),
    );
    await expect(failure(transcript('escape.md'))).resolves.toMatchObject(
      code('symlinkEscape'),
    );
    await expect(
      failure(transcript(paths.join(api, 'escape.md'))),
    ).resolves.toMatchObject(code('symlinkEscape'));
    await symlink(
      paths.join(attachments, 'image.png'),
      paths.join(api, 'to-image.png'),
    );
    await expect(failure(transcript('to-image.png'))).resolves.toMatchObject(
      code('symlinkEscape'),
    );
  });

  it('answers present and missing targets through an escaping symlinked directory alike', async () => {
    // Otherwise the failure would reveal whether a path outside the roots exists.
    await symlink(outside, paths.join(api, 'escape-dir'));
    await symlink(attachments, paths.join(api, 'to-attachments'));
    for (const name of [
      'secret.md',
      'missing.md',
      'no-dir/missing.md',
      'secret.md/below',
    ]) {
      const absolute = paths.join(api, 'escape-dir', name);
      for (const href of [
        `escape-dir/${name}`,
        absolute,
        pathToFileURL(absolute).href,
      ])
        await expect(failure(transcript(href))).resolves.toMatchObject(
          code('symlinkEscape'),
        );
    }
    // A relative link stays in its root, present target or not.
    for (const href of ['to-attachments/image.png', 'to-attachments/none.png'])
      await expect(failure(transcript(href))).resolves.toMatchObject(
        code('symlinkEscape'),
      );
  });

  it('answers a symlink whose outside target is present or missing alike', async () => {
    await symlink(
      paths.join(outside, 'secret.md'),
      paths.join(api, 'to-present'),
    );
    await symlink(
      paths.join(outside, 'missing.md'),
      paths.join(api, 'to-missing'),
    );
    await symlink(paths.join(outside, 'no-dir'), paths.join(api, 'to-no-dir'));
    for (const target of ['to-present', 'to-missing', 'to-no-dir/x.md'])
      for (const href of [
        target,
        paths.join(api, target),
        pathToFileURL(paths.join(api, target)).href,
      ])
        await expect(failure(transcript(href))).resolves.toMatchObject(
          code('symlinkEscape'),
        );
  });

  it('keeps a missing absolute target under a root that cannot be resolved notFound', async () => {
    const gone = paths.join(tempRoot, 'gone-root');
    await expect(
      failure(
        resolveFilesystemLink({
          roots: [...roots(), { id: 'gone', name: 'gone', absolutePath: gone }],
          mode: 'transcript',
          href: paths.join(gone, 'a.md'),
        }),
      ),
    ).resolves.toMatchObject(code('notFound'));
  });

  it('types missing, directory and unsupported links', async () => {
    await expect(failure(transcript('docs/missing.md'))).resolves.toMatchObject(
      code('notFound'),
    );
    await expect(failure(transcript('docs'))).resolves.toMatchObject(
      code('unsupported', 'invalid_argument'),
    );
    for (const href of [
      '',
      'https://x.test/a',
      `file://other${paths.join(api, 'shared.md')}`,
      '//server/share',
      'a\u0001b',
    ])
      await expect(failure(transcript(href))).resolves.toMatchObject(
        code('unsupported', 'invalid_argument'),
      );
    await expect(
      failure(
        resolve({
          mode: 'transcript',
          href: 'docs/guide.md',
          base: { kind: 'root', fileRootId: 'api-id', relativePath: 'a.md' },
        }),
      ),
    ).resolves.toMatchObject(code('unsupported', 'invalid_argument'));
  });
});

describe('pure link decoding', () => {
  it('decodes transcript links and reports traversal separately', () => {
    expect(decodeTranscriptLink('./src//a%20b.ts?x#y')).toEqual({
      ok: true,
      absolute: false,
      path: 'src/a b.ts',
    });
    expect(decodeTranscriptLink('src/../a.ts')).toEqual({
      ok: false,
      reason: 'outsideRoots',
    });
    expect(decodeTranscriptLink('c:relative')).toEqual({
      ok: false,
      reason: 'unsupported',
    });
    expect(decodeTranscriptLink('.')).toEqual({
      ok: false,
      reason: 'unsupported',
    });
  });

  it('keeps a UNC base spelling for markdown URL resolution', () => {
    expect(
      markdownLinkCandidatePath('//server/share/repo/a.md', 'b.md', []),
    ).toBe('//server/share/repo/b.md');
    expect(markdownLinkCandidatePath('/repo/a.md', 'C:/x.md', [])).toBeNull();
  });
});

describe('resolveFilesystemScopeLink', () => {
  let dataRoot = '';
  let dependencies: FilesystemScopeDependencies;
  const scope = { workspaceId: 'project', worktreeId: 'task' };

  async function json(relative: string, document: unknown): Promise<void> {
    await put(paths.join(dataRoot, relative), JSON.stringify(document));
  }

  beforeEach(async () => {
    dataRoot = paths.join(tempRoot, 'data');
    dependencies = {
      dataRoot,
      authorityId: 'local',
      targetId: 'worker',
      paths,
      coworkManagedDirName: '.canopy',
      rootIdentity: readNativeRootIdentity,
    };
    await json('workspaces/index.json', {
      version: 1,
      workspaces: [
        { id: 'project', name: 'Project', type: 'single-repo', color: '#fff' },
      ],
    });
    await json('workspaces/project/workspace.json', {
      version: 1,
      type: 'single-repo',
      repos: [],
    });
    await json('workspaces/project/worktrees.json', {
      version: 1,
      worktrees: [{ id: 'task', branchName: 'topic', createdAt: 'now' }],
    });
    await put(
      paths.join(dataRoot, 'workspaces/project/worktrees/task/docs/notes.md'),
      '# Notes\n',
    );
  });

  const params = {
    scope,
    mode: 'markdown' as const,
    href: 'notes.md',
    base: { fileRootId: 'project', relativePath: 'docs/index.md' },
  };

  it('resolves through the trusted catalog with its revision, without writing', async () => {
    const before = await inventory(dataRoot);
    const result = await resolveFilesystemScopeLink(params, dependencies);
    expect(result).toMatchObject({
      fileRootId: 'project',
      relativePath: 'docs/notes.md',
      name: 'notes.md',
      kind: 'file',
    });
    expect(result.catalogRevision).toEqual(expect.any(String));
    await expect(
      resolveFilesystemScopeLink(
        { ...params, catalogRevision: result.catalogRevision },
        dependencies,
      ),
    ).resolves.toMatchObject({ relativePath: 'docs/notes.md' });
    await expect(
      resolveFilesystemScopeLink(
        { scope, mode: 'transcript', href: 'docs/notes.md' },
        dependencies,
      ),
    ).resolves.toMatchObject({ fileRootId: 'project' });
    expect(await inventory(dataRoot)).toEqual(before);
  });

  it('refuses a stale catalog revision', async () => {
    await expect(
      failure(
        resolveFilesystemScopeLink(
          { ...params, catalogRevision: 'stale' },
          dependencies,
        ),
      ),
    ).resolves.toMatchObject({
      kind: 'conflict',
      code: 'worker.filesystem.link.revisionConflict',
      retry: { kind: 'after_refresh', resource: 'filesystem-roots' },
    });
  });

  it('answers an unknown worktree with the link namespace', async () => {
    await expect(
      failure(
        resolveFilesystemScopeLink(
          { ...params, scope: { ...scope, worktreeId: 'gone' } },
          dependencies,
        ),
      ),
    ).resolves.toMatchObject({ code: 'worker.filesystem.link.notFound' });
  });
});
