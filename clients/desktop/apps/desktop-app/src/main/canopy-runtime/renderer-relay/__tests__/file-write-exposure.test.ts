import { EventEmitter } from 'node:events';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FileBrowserRoot } from '../../../lib/file-browser-roots';

jest.mock('../../../lib/file-browser-roots', () => ({
  getFileBrowserRoots: jest.fn(),
}));
jest.mock('../../../lib/resolve-worktree', () => ({
  resolveWorktreeCwd: jest.fn(),
  resolveWorktreeTargetIds: jest.fn(
    (projectId: string, worktreeId: string) => ({ projectId, worktreeId }),
  ),
}));
jest.mock('../../../lib/workspace-activity', () => ({
  touchWorkspaceTarget: jest.fn(() => Promise.resolve()),
}));

import { getFileBrowserRoots } from '../../../lib/file-browser-roots';
import { touchWorkspaceTarget } from '../../../lib/workspace-activity';
import { RENDERER_RELAY_GRANTS } from '../../../ipc/canopy-core-relay';
import {
  createDesktopRuntime,
  type DesktopCanopyDispatcher,
} from '../../desktop-runtime';
import { LOCAL_DESKTOP_AUTHORITY_ID } from '../../desktop-runtime-identity';
import { createInterimInMemoryBindingProvider } from '../interim-in-memory-binding';
import {
  createRendererRelay,
  type RendererRelay,
  type RendererRelayEvent,
} from '../relay';
import type { RendererRelaySurface } from '../surface-allowlist';

/**
 * CAN-4100: `worker.filesystem.file.write` and `.directory.create` join the
 * interface set, so the main window's renderer relay reaches them with the
 * relay's own grants; App Advisor's narrowed surface does not. `file.write`'s
 * params are a union whose branches both declare `_meta`, so the relay must
 * keep `_meta` in params for it as it does for object params.
 */

const URL = 'file:///app/renderer/index.html';

class FakeSender extends EventEmitter {
  readonly mainFrame = {
    url: URL,
    detached: false,
    isDestroyed: (): boolean => false,
  };
  constructor(readonly id: number) {
    super();
  }
  getURL(): string {
    return URL;
  }
  isDestroyed(): boolean {
    return false;
  }
}

let tempRoot = '';
let repo = '';
let runtime: DesktopCanopyDispatcher;
let relay: RendererRelay;

function eventFor(sender: FakeSender): RendererRelayEvent {
  return { sender, senderFrame: sender.mainFrame };
}

const scope = { workspaceId: 'project-1', worktreeId: 'wt-1' };
let keySequence = 0;

function nextMeta(): { idempotencyKey: string } {
  keySequence += 1;
  return { idempotencyKey: `relay-write-key-${keySequence}` };
}

function writeRequest(params: Record<string, unknown>): {
  kind: 'request';
  method: string;
  params: Record<string, unknown>;
} {
  return {
    kind: 'request',
    method: 'worker.filesystem.file.write',
    params: {
      scope,
      fileRootId: 'project-1',
      _meta: nextMeta(),
      ...params,
    },
  };
}

function directoryRequest(
  relativePath: string,
  meta: Record<string, unknown> = nextMeta(),
): { kind: 'request'; method: string; params: Record<string, unknown> } {
  return {
    kind: 'request',
    method: 'worker.filesystem.directory.create',
    params: {
      scope,
      fileRootId: 'project-1',
      relativePath,
      createParents: true,
      expectedAbsent: true,
      _meta: meta,
    },
  };
}

async function versionOf(path: string): Promise<string> {
  const stats = await stat(path);
  return `${stats.size}:${Math.round(stats.mtimeMs)}`;
}

beforeEach(async () => {
  jest.mocked(touchWorkspaceTarget).mockClear();
  tempRoot = await realpath(await mkdtemp(join(tmpdir(), 'file-write-relay-')));
  repo = join(tempRoot, 'repo');
  await mkdir(join(repo, 'src'), { recursive: true });
  await writeFile(join(repo, 'src', 'index.ts'), 'export {};\n');
  const root: FileBrowserRoot = {
    repoId: 'project-1',
    repoName: 'project-1',
    absolutePath: repo,
    rootKind: 'git-repo',
    gitAware: true,
    excludedDescendantRoots: [],
  };
  jest.mocked(getFileBrowserRoots).mockResolvedValue({
    roots: [root],
    rootMap: new Map([[root.repoId, root]]),
  });
  runtime = createDesktopRuntime({
    shutdownTimeoutMs: 250,
    platform: { os: process.platform === 'win32' ? 'win32' : 'darwin' },
  });
  const surfaces = new Map<number, RendererRelaySurface>([[2, 'app-advisor']]);
  relay = createRendererRelay({
    bindingProvider: createInterimInMemoryBindingProvider(runtime),
    resolveSurface: (event) => {
      const surface = surfaces.get(event.sender.id) ?? 'main';
      return {
        surface,
        caller: {
          principalId: `local-desktop-renderer:${surface}`,
          clientInstanceId: `electron-web-contents:${event.sender.id}`,
          authorityId: LOCAL_DESKTOP_AUTHORITY_ID,
          interfaceKind: 'desktop',
          grants: [...RENDERER_RELAY_GRANTS],
        },
      };
    },
  });
});

afterEach(async () => {
  relay.dispose();
  await runtime.shutdown();
  await rm(tempRoot, { recursive: true, force: true });
});

it('lets the main surface replace a file under its version', async () => {
  const file = join(repo, 'src', 'index.ts');
  const reply = await relay.invoke(
    eventFor(new FakeSender(1)),
    writeRequest({
      relativePath: 'src/index.ts',
      content: 'export const a = 1;\n',
      createOnly: false,
      expectedVersion: await versionOf(file),
    }),
  );
  expect(reply).toMatchObject({
    ok: true,
    value: {
      relativePath: 'src/index.ts',
      sizeBytes: 20,
      version: await versionOf(file),
    },
  });
  expect(await readFile(file, 'utf8')).toBe('export const a = 1;\n');
  expect(touchWorkspaceTarget).toHaveBeenCalledWith('project-1', 'wt-1');
});

it('lets the main surface create a file and nested folders', async () => {
  const main = eventFor(new FakeSender(1));
  await expect(
    relay.invoke(main, directoryRequest('docs/guide')),
  ).resolves.toMatchObject({
    ok: true,
    value: {
      fileRootId: 'project-1',
      relativePath: 'docs/guide',
      createdParentPaths: ['docs'],
    },
  });
  await expect(
    relay.invoke(
      main,
      writeRequest({
        relativePath: 'docs/guide/new.md',
        content: '# New\n',
        createOnly: true,
      }),
    ),
  ).resolves.toMatchObject({
    ok: true,
    value: { relativePath: 'docs/guide/new.md', sizeBytes: 6 },
  });
  expect(await readFile(join(repo, 'docs', 'guide', 'new.md'), 'utf8')).toBe(
    '# New\n',
  );
  expect(touchWorkspaceTarget).not.toHaveBeenCalled();
});

it('refuses a stale version with a conflict and writes nothing', async () => {
  const reply = await relay.invoke(
    eventFor(new FakeSender(1)),
    writeRequest({
      relativePath: 'src/index.ts',
      content: 'changed\n',
      createOnly: false,
      expectedVersion: '1:1',
    }),
  );
  expect(reply).toMatchObject({
    ok: false,
    error: {
      kind: 'conflict',
      code: 'worker.filesystem.file.revisionConflict',
      retry: { kind: 'after_refresh' },
    },
  });
  expect(await readFile(join(repo, 'src', 'index.ts'), 'utf8')).toBe(
    'export {};\n',
  );
});

it('refuses the App Advisor surface before either instruction runs', async () => {
  const advisor = eventFor(new FakeSender(2));
  for (const request of [
    writeRequest({ relativePath: 'new.ts', content: 'x', createOnly: true }),
    directoryRequest('advisor-dir'),
  ]) {
    await expect(relay.invoke(advisor, request)).resolves.toMatchObject({
      ok: false,
      error: {
        kind: 'capability_unavailable',
        message: `${request.method} is not available here.`,
      },
    });
  }
  expect((await readdir(repo)).sort()).toEqual(['src']);
});

it('requires the relay caller to supply its own idempotency key', async () => {
  for (const meta of [{}, { idempotencyKey: '' }]) {
    const reply = await relay.invoke(eventFor(new FakeSender(1)), {
      ...writeRequest({ relativePath: 'k.ts', content: 'x', createOnly: true }),
      params: {
        scope,
        fileRootId: 'project-1',
        relativePath: 'k.ts',
        content: 'x',
        createOnly: true,
        _meta: meta,
      },
    });
    expect(reply).toMatchObject({
      ok: false,
      error: { kind: 'invalid_argument' },
    });
  }
  expect(await readdir(repo)).toEqual(['src']);
});

it('keeps the guards for relay callers', async () => {
  const main = eventFor(new FakeSender(3));
  await expect(
    relay.invoke(
      main,
      writeRequest({
        relativePath: '../out.ts',
        content: 'x',
        createOnly: true,
      }),
    ),
  ).resolves.toMatchObject({
    ok: false,
    error: {
      kind: 'invalid_argument',
      code: 'worker.filesystem.path.invalid',
    },
  });
  await expect(
    relay.invoke(
      main,
      writeRequest({
        relativePath: 'src/index.ts',
        content: 'x',
        createOnly: true,
      }),
    ),
  ).resolves.toMatchObject({ ok: false, error: { kind: 'already_exists' } });
  await expect(
    relay.invoke(main, directoryRequest('src')),
  ).resolves.toMatchObject({
    ok: false,
    error: { kind: 'already_exists', code: 'worker.filesystem.entry.exists' },
  });
  await expect(
    relay.invoke(
      main,
      writeRequest({
        relativePath: 'src/index.ts',
        content: 'x',
        createOnly: false,
        expectedVersion: '0:0',
        executable: true,
      }),
    ),
  ).resolves.toEqual({
    ok: false,
    // The relay never forwards `details`; the message names the option.
    error: {
      kind: 'capability_unavailable',
      message:
        "This host can't set the executable bit; omit it or send false. Nothing was written.",
      retry: { kind: 'never' },
    },
  });
  expect(await readdir(tempRoot)).toEqual(['repo']);
  expect(await readFile(join(repo, 'src', 'index.ts'), 'utf8')).toBe(
    'export {};\n',
  );
});

it('never directs a same-key replay of either instruction (CAN-4733)', async () => {
  const elapsed = new Date(Date.now() - 1_000).toISOString();
  for (const request of [
    writeRequest({ relativePath: 'late.ts', content: 'x', createOnly: true }),
    directoryRequest('late-dir'),
  ]) {
    const reply = await relay.invoke(eventFor(new FakeSender(1)), {
      ...request,
      params: {
        ...request.params,
        _meta: {
          idempotencyKey: `elapsed-${request.method}`,
          deadlineAt: elapsed,
        },
      },
    });
    expect(reply).toMatchObject({
      ok: false,
      error: { kind: 'deadline_exceeded', retry: { kind: 'never' } },
    });
  }
  expect(await readdir(repo)).toEqual(['src']);
});
