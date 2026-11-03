import {
  CanopyOperationError,
  createCanopyDispatcher,
  type CanopyHandlerContext,
  type CanopyStreamFrame,
} from '@canopy/core-runtime';
import {
  filesystemScopeError,
  type FilesystemNativeWatchHandle,
} from '@canopy/core-runtime/node';
import { WORKER_STREAM_DEFINITIONS } from '@canopy/protocol/canopy-core';
import {
  SHARED_CONTAINER_VIEWER_PROJECT_ID,
  WORKSPACE_ROOT_REPO_ID,
} from '@canopy/desktop-shared/types';
import type { FileBrowserRoot } from '../../lib/file-browser-roots';
import { logMainProcessWarn } from '../../lib/main-process-logging';
import { warnWatchUnavailableOnce } from '../../lib/worktree-watch-recovery';
import { LOCAL_DESKTOP_AUTHORITY_ID } from '../desktop-runtime-identity';
import {
  createWorkerFilesystemWatchAdapter,
  createWorkerFilesystemWatchPort,
  type WorkerFilesystemWatchServices,
} from '../worker-filesystem-watch-adapter';

jest.mock('../../lib/main-process-logging', () => ({
  logMainProcessInfo: jest.fn(),
  logMainProcessWarn: jest.fn(),
}));
// The real CAN-3190 classifier; only its session dialog is observed.
jest.mock('../../lib/worktree-watch-recovery', () => ({
  ...jest.requireActual<object>('../../lib/worktree-watch-recovery'),
  warnWatchUnavailableOnce: jest.fn(),
}));

const context: CanopyHandlerContext = {
  requestId: 'request-1',
  caller: {
    principalId: 'local',
    clientInstanceId: 'test',
    authorityId: LOCAL_DESKTOP_AUTHORITY_ID,
    interfaceKind: 'desktop',
    grants: ['worker.filesystem.read'],
  },
  metadata: {},
  signal: new AbortController().signal,
};

function root(
  repoId: string,
  absolutePath: string,
  rootKind: FileBrowserRoot['rootKind'],
): FileBrowserRoot {
  return {
    repoId,
    repoName: repoId,
    absolutePath,
    rootKind,
    gitAware: rootKind === 'git-repo',
    excludedDescendantRoots: [],
  };
}

function services(
  roots: FileBrowserRoot[],
  supplemental: string[],
  repoDirectoryNames: readonly string[] = [],
): WorkerFilesystemWatchServices & {
  getFileBrowserRoots: jest.Mock;
  getGitHeadPath: jest.Mock;
  isGitCheckout: jest.Mock;
} {
  return {
    getFileBrowserRoots: jest.fn(() =>
      Promise.resolve({
        roots,
        rootMap: new Map(roots.map((entry) => [entry.repoId, entry])),
      }),
    ),
    getSupplementalWatchPaths: () => supplemental,
    getGitHeadPath: jest.fn((repoPath: string) =>
      Promise.resolve(`${repoPath}/.git/HEAD`),
    ),
    isGitCheckout: jest.fn(() => Promise.resolve(false)),
    findRepositoryCheckoutPath: (_projectId, worktreeId, name) =>
      Promise.resolve(
        repoDirectoryNames.includes(name)
          ? `/w/${worktreeId}/repos/${name}`
          : null,
      ),
  };
}

const scope = { workspaceId: 'project-1', worktreeId: 'wt-1' };

async function failure(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error instanceof CanopyOperationError ? error.payload : error;
  }
  throw new Error('Expected a failure.');
}

describe('createWorkerFilesystemWatchPort', () => {
  it('resolves a visible root with every scope watch path', async () => {
    const port = createWorkerFilesystemWatchPort(
      services(
        [
          root(WORKSPACE_ROOT_REPO_ID, '/w', 'workspace-root'),
          root('a', '/w/repos/a', 'git-repo'),
        ],
        ['/data/attachments/wt-1'],
      ),
    );
    await expect(
      port.resolveWatchTarget(
        { scope, fileRootId: 'a', subject: 'tree' },
        context,
      ),
    ).resolves.toEqual({
      kind: 'tree',
      rootPath: '/w/repos/a',
      rootMayBeAbsent: false,
      scopePaths: [
        { path: '/w', mayBeAbsent: false },
        { path: '/w/repos/a', mayBeAbsent: false },
        { path: '/data/attachments/wt-1', mayBeAbsent: true },
      ],
    });
  });

  it('resolves the hidden attachments root by its allocated id', async () => {
    const port = createWorkerFilesystemWatchPort(
      services(
        [root('attachments', '/repo', 'git-repo')],
        ['/data/attachments/wt-1'],
      ),
    );
    await expect(
      port.resolveWatchTarget(
        { scope, fileRootId: 'canopy-attachments', subject: 'tree' },
        context,
      ),
    ).resolves.toMatchObject({
      kind: 'tree',
      rootPath: '/data/attachments/wt-1',
      rootMayBeAbsent: true,
    });
  });

  it('has no attachments root without an attachments directory', async () => {
    const port = createWorkerFilesystemWatchPort(
      services([root('project-1', '/home', 'standalone')], []),
    );
    await expect(
      failure(
        port.resolveWatchTarget(
          { scope, fileRootId: 'attachments', subject: 'tree' },
          context,
        ),
      ),
    ).resolves.toMatchObject({
      kind: 'not_found',
      code: 'worker.filesystem.watch.notFound',
    });
  });

  it('keeps the shared-container viewer inert without reading roots', async () => {
    const injected = services([], []);
    const port = createWorkerFilesystemWatchPort(injected);
    await expect(
      port.resolveWatchTarget(
        {
          scope: {
            workspaceId: SHARED_CONTAINER_VIEWER_PROJECT_ID,
            worktreeId: 'container-1',
          },
          fileRootId: 'replica',
          subject: 'tree',
        },
        context,
      ),
    ).resolves.toEqual({ kind: 'inert' });
    expect(injected.getFileBrowserRoots).not.toHaveBeenCalled();
  });

  it('resolves gitHead only for Git-aware roots', async () => {
    const injected = services(
      [
        root('project-1', '/repo', 'git-repo'),
        root('notes', '/notes', 'standalone'),
      ],
      [],
    );
    const port = createWorkerFilesystemWatchPort(injected);
    await expect(
      port.resolveWatchTarget(
        { scope, fileRootId: 'project-1', subject: 'gitHead' },
        context,
      ),
    ).resolves.toEqual({ kind: 'gitHead', headPath: '/repo/.git/HEAD' });
    await expect(
      failure(
        port.resolveWatchTarget(
          { scope, fileRootId: 'notes', subject: 'gitHead' },
          context,
        ),
      ),
    ).resolves.toMatchObject({
      kind: 'failed_precondition',
      code: 'worker.filesystem.watch.invalidState',
    });
    injected.getGitHeadPath.mockRejectedValueOnce(new Error('no .git'));
    await expect(
      failure(
        port.resolveWatchTarget(
          { scope, fileRootId: 'project-1', subject: 'gitHead' },
          context,
        ),
      ),
    ).resolves.toMatchObject({
      code: 'worker.filesystem.watch.invalidState',
    });
  });

  it('serves gitHead for multi-repo checkouts the catalog does not mark Git-aware', async () => {
    const injected = services(
      [
        root(WORKSPACE_ROOT_REPO_ID, '/w/wt-1', 'workspace-root'),
        root('api', '/w/wt-1/repos/api', 'git-repo'),
      ],
      [],
      ['api', 'old', 'Old Checkout', 'notes'],
    );
    injected.isGitCheckout.mockImplementation((path: string) =>
      Promise.resolve(
        path === '/w/wt-1' ||
          path === '/w/wt-1/repos/old' ||
          path === '/w/wt-1/repos/Old Checkout',
      ),
    );
    const port = createWorkerFilesystemWatchPort(injected);
    const open = (
      fileRootId: string,
      subject: 'gitHead' | 'tree',
    ): ReturnType<typeof port.resolveWatchTarget> =>
      port.resolveWatchTarget({ scope, fileRootId, subject }, context);

    // A pre-source-backing root that is a Git checkout (e1381d0b6f).
    await expect(open(WORKSPACE_ROOT_REPO_ID, 'gitHead')).resolves.toEqual({
      kind: 'gitHead',
      headPath: '/w/wt-1/.git/HEAD',
    });
    // A checkout left behind by workspace:remove-repo.
    await expect(open('old', 'gitHead')).resolves.toEqual({
      kind: 'gitHead',
      headPath: '/w/wt-1/repos/old/.git/HEAD',
    });
    // Any listed directory name, as the base watcher's repo entries had it.
    await expect(open('Old Checkout', 'gitHead')).resolves.toEqual({
      kind: 'gitHead',
      headPath: '/w/wt-1/repos/Old Checkout/.git/HEAD',
    });
    // The tree subject still resolves only catalog roots.
    await expect(failure(open('old', 'tree'))).resolves.toMatchObject({
      code: 'worker.filesystem.watch.notFound',
    });
    // Unlisted names, a listed directory that is not a checkout, and a path.
    for (const fileRootId of ['missing', 'notes', '../escape'])
      await expect(failure(open(fileRootId, 'gitHead'))).resolves.toMatchObject(
        { code: 'worker.filesystem.watch.notFound' },
      );
    expect(injected.isGitCheckout).not.toHaveBeenCalledWith(
      expect.stringContaining('escape'),
    );

    injected.isGitCheckout.mockResolvedValue(false);
    await expect(
      failure(open(WORKSPACE_ROOT_REPO_ID, 'gitHead')),
    ).resolves.toMatchObject({
      kind: 'failed_precondition',
      code: 'worker.filesystem.watch.invalidState',
    });
  });

  it('serves gitHead for a retained checkout whose name an attachments root also takes', async () => {
    const workspaceRoot = root(
      WORKSPACE_ROOT_REPO_ID,
      '/w/wt-1',
      'workspace-root',
    );
    const visible = services(
      [
        workspaceRoot,
        root('attachments', '/data/attachments/wt-1', 'attachments'),
      ],
      [],
      ['attachments'],
    );
    // No visible attachments root: the hidden one takes the allocated id.
    const hidden = services(
      [workspaceRoot],
      ['/data/attachments/wt-1'],
      ['attachments'],
    );
    for (const injected of [visible, hidden]) {
      injected.isGitCheckout.mockImplementation((path: string) =>
        Promise.resolve(path === '/w/wt-1/repos/attachments'),
      );
      const port = createWorkerFilesystemWatchPort(injected);
      const open = (
        subject: 'gitHead' | 'tree',
      ): ReturnType<typeof port.resolveWatchTarget> =>
        port.resolveWatchTarget(
          { scope, fileRootId: 'attachments', subject },
          context,
        );

      await expect(open('gitHead')).resolves.toEqual({
        kind: 'gitHead',
        headPath: '/w/wt-1/repos/attachments/.git/HEAD',
      });
      // The tree subject keeps the attachments root.
      await expect(open('tree')).resolves.toMatchObject({
        kind: 'tree',
        rootPath: '/data/attachments/wt-1',
        rootMayBeAbsent: true,
      });
      // Without a checkout of that name, the attachments root has no HEAD.
      injected.isGitCheckout.mockResolvedValue(false);
      await expect(failure(open('gitHead'))).resolves.toMatchObject({
        kind: 'failed_precondition',
        code: 'worker.filesystem.watch.invalidState',
      });
    }
  });

  it('keeps single-repo gitHead to catalog roots', async () => {
    const injected = services(
      [
        root('project-1', '/repo', 'git-repo'),
        root('attachments', '/repo/.canopy/attachments', 'attachments'),
      ],
      [],
    );
    injected.isGitCheckout.mockResolvedValue(true);
    const port = createWorkerFilesystemWatchPort(injected);
    await expect(
      failure(
        port.resolveWatchTarget(
          { scope, fileRootId: 'attachments', subject: 'gitHead' },
          context,
        ),
      ),
    ).resolves.toMatchObject({ code: 'worker.filesystem.watch.invalidState' });
    await expect(
      failure(
        port.resolveWatchTarget(
          { scope, fileRootId: 'other', subject: 'gitHead' },
          context,
        ),
      ),
    ).resolves.toMatchObject({ code: 'worker.filesystem.watch.notFound' });
    expect(injected.isGitCheckout).not.toHaveBeenCalled();
  });

  it('refuses remote targets, foreign authorities and invalid ids', async () => {
    const port = createWorkerFilesystemWatchPort(services([], []));
    await expect(
      failure(
        port.resolveWatchTarget(
          {
            scope: { ...scope, targetId: 'remote' },
            fileRootId: 'a',
            subject: 'tree',
          },
          context,
        ),
      ),
    ).resolves.toMatchObject({ kind: 'capability_unavailable' });
    await expect(
      failure(
        port.resolveWatchTarget(
          {
            scope: { ...scope, authorityId: 'elsewhere' },
            fileRootId: 'a',
            subject: 'tree',
          },
          context,
        ),
      ),
    ).resolves.toMatchObject({ kind: 'capability_unavailable' });
    await expect(
      failure(
        port.resolveWatchTarget(
          {
            scope: { workspaceId: 'project-1' },
            fileRootId: 'a',
            subject: 'tree',
          },
          context,
        ),
      ),
    ).resolves.toMatchObject({ kind: 'invalid_argument' });
    await expect(
      failure(
        port.resolveWatchTarget(
          {
            scope: { ...scope, worktreeId: '../x' },
            fileRootId: 'a',
            subject: 'tree',
          },
          context,
        ),
      ),
    ).resolves.toMatchObject({ kind: 'invalid_argument' });
  });

  it('shares one roots read between concurrent opens of a scope', async () => {
    const injected = services([root('project-1', '/repo', 'git-repo')], []);
    const port = createWorkerFilesystemWatchPort(injected);
    await Promise.all([
      port.resolveWatchTarget(
        { scope, fileRootId: 'project-1', subject: 'tree' },
        context,
      ),
      port.resolveWatchTarget(
        { scope, fileRootId: 'project-1', subject: 'tree' },
        context,
      ),
    ]);
    expect(injected.getFileBrowserRoots).toHaveBeenCalledTimes(1);
    await port.resolveWatchTarget(
      { scope, fileRootId: 'project-1', subject: 'tree' },
      context,
    );
    expect(injected.getFileBrowserRoots).toHaveBeenCalledTimes(2);
  });
});

describe('createWorkerFilesystemWatchAdapter', () => {
  const tree = { path: '/w', recursive: true, release: 'close' } as const;
  const coded = (code: string): Error =>
    Object.assign(new Error(code), { code });

  beforeEach(() => {
    jest.mocked(warnWatchUnavailableOnce).mockClear();
    jest.mocked(logMainProcessWarn).mockClear();
  });

  it.each(['ENOSPC', 'EMFILE', 'ENFILE', 'EACCES', 'EPERM'])(
    'sends a %s attach failure to the shared watch warning',
    (code) => {
      const error = coded(code);
      const { registry } = createWorkerFilesystemWatchAdapter({
        watch: () => {
          throw error;
        },
      });
      expect(() => registry.acquire(tree, () => undefined)).toThrow(error);
      expect(warnWatchUnavailableOnce).toHaveBeenCalledTimes(1);
      expect(warnWatchUnavailableOnce).toHaveBeenCalledWith(error, 'file-tree');
      expect(logMainProcessWarn).toHaveBeenCalledWith(
        'File-tree watch unavailable',
        { error: String(error) },
      );
    },
  );

  it('names the branch observer in the warning for a HEAD watch', () => {
    const error = coded('ENOSPC');
    const { registry } = createWorkerFilesystemWatchAdapter({
      watch: () => {
        throw error;
      },
    });
    expect(() =>
      registry.acquire(
        { path: '/w/.git', recursive: false, release: 'retain' },
        () => undefined,
      ),
    ).toThrow(error);
    expect(warnWatchUnavailableOnce).toHaveBeenCalledWith(error, 'worktree');
    expect(logMainProcessWarn).toHaveBeenCalledWith(
      'Worktree branch watch unavailable',
      { error: String(error) },
    );
  });

  it.each([
    {
      reason: 'notFound',
      kind: 'not_found',
      code: 'worker.filesystem.watch.notFound',
    },
    {
      reason: 'invalidState',
      kind: 'failed_precondition',
      code: 'worker.filesystem.watch.invalidState',
    },
  ] as const)(
    'ends the stream with $code when the scope roots are $reason',
    async ({ reason, kind, code }) => {
      const rootsError = filesystemScopeError('roots', reason);
      const failures: unknown[] = [];
      const injected = services([], []);
      injected.getFileBrowserRoots.mockRejectedValueOnce(rootsError);
      const { handlers } = createWorkerFilesystemWatchAdapter({
        services: injected,
        watch: () => {
          throw new Error('No native watch expected.');
        },
        onAttachFailed: (_context, error) => failures.push(error),
      });
      const dispatcher = createCanopyDispatcher({
        profile: 'worker',
        definitions: {
          queries: {},
          instructions: {},
          streams: {
            'worker.filesystem.watch':
              WORKER_STREAM_DEFINITIONS['worker.filesystem.watch'],
          },
        },
        handlers: { queries: {}, instructions: {}, streams: handlers },
        shutdownTimeoutMs: 100,
      });
      const frames: Array<CanopyStreamFrame<unknown, unknown>> = [];
      const ended = new Promise<void>((resolve) => {
        void dispatcher.openStream(
          'worker.filesystem.watch',
          { scope, fileRootId: 'gone' },
          {
            caller: context.caller,
            onFrame: (frame) => {
              frames.push(frame);
              if (frame.kind === 'end') resolve();
            },
          },
        );
      });
      await ended;
      // Shut down before asserting so a failed expectation leaks nothing.
      await dispatcher.shutdown();
      expect(frames).toEqual([
        expect.objectContaining({
          kind: 'end',
          outcome: 'error',
          error: {
            kind,
            code,
            message: rootsError.payload.message,
            retry: { kind: 'never' },
          },
        }),
      ]);
      // The legacy projection still sees the roots read's own failure.
      expect(failures).toEqual([rootsError]);
    },
  );

  it('leaves other native errors to the stream backoff', () => {
    const { registry } = createWorkerFilesystemWatchAdapter({
      watch: () => {
        throw coded('ENOENT');
      },
    });
    expect(() => registry.acquire(tree, () => undefined)).toThrow('ENOENT');
    expect(warnWatchUnavailableOnce).not.toHaveBeenCalled();
    expect(logMainProcessWarn).not.toHaveBeenCalled();
  });

  it('warns for a watch-limit error after attach and keeps retrying', () => {
    jest.useFakeTimers();
    try {
      const listeners: Array<(error: unknown) => void> = [];
      const close = jest.fn();
      const { registry } = createWorkerFilesystemWatchAdapter({
        watch: () => {
          const handle: FilesystemNativeWatchHandle = {
            close,
            on: (_event, listener): FilesystemNativeWatchHandle => {
              listeners.push(listener);
              return handle;
            },
          };
          return handle;
        },
      });
      const subscription = registry.acquire(tree, () => undefined);
      const error = coded('ENOSPC');
      for (const listener of listeners) listener(error);
      expect(warnWatchUnavailableOnce).toHaveBeenCalledWith(error, 'file-tree');
      expect(registry.snapshot()).toMatchObject({ attached: 0, retrying: 1 });
      subscription.release();
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });
});
