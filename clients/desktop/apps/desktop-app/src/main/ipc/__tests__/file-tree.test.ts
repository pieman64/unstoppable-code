import { CanopyOperationError } from '@canopy/core-runtime';
import { filesystemScopeError } from '@canopy/core-runtime/node';
import type {
  CanopyCallerDescriptor,
  WorkerFilesystemDirectoryListResult,
  WorkerFilesystemRootsListResult,
} from '@canopy/protocol/canopy-core';
import {
  IPC_CHANNELS,
  type FileTreeDirectoryResponse,
  type FileTreeRootsResponse,
} from '@canopy/desktop-shared/types';
import {
  createDesktopRuntime,
  type DesktopCanopyDispatcher,
} from '../../canopy-runtime/desktop-runtime';
import type {
  DaemonFilesRoute,
  DaemonFilesRouteRequest,
} from '../../canopy-runtime/daemon-files-route';
import { LOCAL_DESKTOP_AUTHORITY_ID } from '../../canopy-runtime/desktop-runtime-identity';
import { registerFileTreeHandlers } from '../file-tree';

type Handler = (event: unknown, request: unknown) => Promise<unknown>;
const handlers = new Map<string, Handler>();
jest.mock('../register', () => ({
  registerIpcHandler: (channel: string, handler: Handler): void => {
    handlers.set(channel, handler);
  },
}));
jest.mock('../../services/file-tree-watch-service', () => ({
  startFileTreeWatch: jest.fn(),
  stopAllFileTreeWatches: jest.fn(),
  stopFileTreeWatch: jest.fn(),
}));

const ROOTS: FileTreeRootsResponse = {
  roots: [
    {
      repoId: 'single',
      repoName: 'single',
      absolutePath: '/data/workspaces/single/worktrees/task',
      rootKind: 'git-repo',
    },
  ],
};
const DIRECTORY: FileTreeDirectoryResponse = {
  entries: [
    {
      name: 'README.md',
      relativePath: 'README.md',
      absolutePath: '/data/workspaces/single/worktrees/task/README.md',
      kind: 'file',
      isIgnored: false,
      isIndexExcluded: false,
      isSymlink: false,
      hasChildren: false,
    },
  ],
};

function caller(id: number, prefix: string): CanopyCallerDescriptor {
  return {
    principalId: prefix === 'remote-bridge' ? 'remote-device:x' : 'local',
    clientInstanceId: `${prefix}:${id}`,
    authorityId: LOCAL_DESKTOP_AUTHORITY_ID,
    interfaceKind: 'desktop',
    grants: ['worker.filesystem.read'],
  };
}

/** A route that records the trusted request and serves fixed results. */
function recordingRoute(
  failure?: (operation: 'roots' | 'directory') => CanopyOperationError,
): {
  route: DaemonFilesRoute;
  requests: DaemonFilesRouteRequest[];
} {
  const requests: DaemonFilesRouteRequest[] = [];
  return {
    requests,
    route: {
      roots: (
        _params,
        _context,
        request,
        run,
      ): Promise<WorkerFilesystemRootsListResult> => {
        requests.push(request);
        if (failure) return Promise.reject(failure('roots'));
        run.capture(ROOTS);
        return Promise.resolve({
          catalogRevision: 'r1',
          roots: [{ fileRootId: 'single', name: 'single', kind: 'git-repo' }],
        });
      },
      directory: (
        _params,
        _context,
        request,
        run,
      ): Promise<WorkerFilesystemDirectoryListResult> => {
        requests.push(request);
        if (failure) return Promise.reject(failure('directory'));
        run.capture(DIRECTORY);
        return Promise.resolve({
          catalogRevision: 'r1',
          entries: DIRECTORY.entries.map((entry) => ({
            name: entry.name,
            relativePath: entry.relativePath,
            kind: entry.kind,
            isIgnored: entry.isIgnored,
            isIndexExcluded: entry.isIndexExcluded,
            isSymlink: entry.isSymlink,
            hasChildren: entry.hasChildren,
          })),
        });
      },
      dispose: () => undefined,
    },
  };
}

let runtime: DesktopCanopyDispatcher | undefined;

function register(route: DaemonFilesRoute): {
  roots: Handler;
  directory: Handler;
} {
  handlers.clear();
  runtime = createDesktopRuntime({
    services: {
      listFileTreeRoots: jest.fn(() => Promise.resolve(ROOTS)),
      listFileTreeDirectory: jest.fn(() => Promise.resolve(DIRECTORY)),
    },
    daemonFilesRoute: () => route,
    shutdownTimeoutMs: 1_000,
  });
  const callers = new Map<unknown, CanopyCallerDescriptor>();
  registerFileTreeHandlers(runtime, (event) => {
    const resolved = callers.get(event.sender);
    if (!resolved) throw new Error('Unknown sender.');
    return resolved;
  });
  const roots = handlers.get(IPC_CHANNELS.fileTreeRoots);
  const directory = handlers.get(IPC_CHANNELS.fileTreeDirectory);
  if (!roots || !directory) throw new Error('Missing file-tree handlers.');
  const bind =
    (handler: Handler): Handler =>
    (event, request) => {
      if (typeof event === 'object' && event !== null && 'sender' in event) {
        const { sender } = event;
        if (
          typeof sender === 'object' &&
          sender !== null &&
          'id' in sender &&
          typeof sender.id === 'number' &&
          'prefix' in sender &&
          typeof sender.prefix === 'string'
        )
          callers.set(sender, caller(sender.id, sender.prefix));
      }
      return handler(event, request);
    };
  return { roots: bind(roots), directory: bind(directory) };
}

afterEach(async () => {
  await runtime?.shutdown();
  runtime = undefined;
});

describe('file-tree IPC daemon route plumbing', () => {
  it.each(['electron-web-contents', 'remote-bridge'])(
    'passes the trusted %s sender object to the route for both reads',
    async (prefix) => {
      const { route, requests } = recordingRoute();
      const { roots, directory } = register(route);
      const sender = { id: 7, prefix };
      await expect(
        roots({ sender }, { projectId: 'single', worktreeId: 'task' }),
      ).resolves.toEqual(ROOTS);
      await expect(
        directory(
          { sender },
          {
            projectId: 'single',
            worktreeId: 'task',
            repoId: 'single',
            relativeDir: '',
          },
        ),
      ).resolves.toEqual(DIRECTORY);
      expect(requests).toHaveLength(2);
      for (const request of requests) expect(request.sender).toBe(sender);
    },
  );

  it.each([
    [
      'conflict',
      (operation: 'roots' | 'directory'): CanopyOperationError =>
        filesystemScopeError(operation, 'revisionConflict'),
    ],
    [
      'lease refusal',
      (): CanopyOperationError =>
        new CanopyOperationError({
          kind: 'not_found',
          message:
            'This operation requires a live client lease on this connection.',
          retry: { kind: 'never' },
        }),
    ],
  ])(
    'translates a routed %s into the same plain error as the direct path',
    async (_label, failure) => {
      const { route } = recordingRoute(failure);
      const { roots, directory } = register(route);
      const sender = { id: 8, prefix: 'electron-web-contents' };
      for (const read of [
        (): Promise<unknown> =>
          roots({ sender }, { projectId: 'single', worktreeId: 'task' }),
        (): Promise<unknown> =>
          directory(
            { sender },
            {
              projectId: 'single',
              worktreeId: 'task',
              repoId: 'single',
              relativeDir: '',
            },
          ),
      ]) {
        const error: unknown = await read().then(
          () => null,
          (rejected: unknown) => rejected,
        );
        expect(error).toBeInstanceOf(Error);
        expect(error).not.toBeInstanceOf(CanopyOperationError);
        expect(error).toHaveProperty(
          'message',
          failure('roots').payload.message,
        );
      }
    },
  );
});
