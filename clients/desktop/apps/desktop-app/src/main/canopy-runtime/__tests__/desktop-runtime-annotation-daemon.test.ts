/**
 * CAN-4104: with no enablement, Electron makes zero daemon contact for
 * core.annotation.*. Every operation runs on the desktop runtime as main
 * wires it in production (the opt-in Files route included), with each
 * Electron daemon seam observed, and no core.annotation operation can be
 * selected for the daemon route.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type * as NetModule from 'node:net';
import type * as CoreClientNode from '@canopy/core-client/node';
import type * as WorkCountersModule from '@canopy/desktop-shared/node/work-counters';
import type * as PathsModule from '../../lib/paths';
import {
  CANOPY_INSTRUCTION_DEFINITIONS,
  CANOPY_QUERY_DEFINITIONS,
  CANOPY_STREAM_DEFINITIONS,
  type CanopyCallerDescriptor,
} from '@canopy/protocol/canopy-core';
import { IPC_CHANNELS } from '@canopy/desktop-shared/types';

const tempDir = mkdtempSync(join(tmpdir(), 'annotation-daemon-contact-'));

/** Every call into an Electron daemon seam, by module and export. */
const mockDaemonContact: string[] = [];

function mockObserve(module: string, actual: object): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(actual).map(([name, value]: [string, unknown]) => [
      name,
      typeof value === 'function'
        ? (...args: unknown[]): unknown => {
            mockDaemonContact.push(`${module}.${name}`);
            return Reflect.apply(value, undefined, args);
          }
        : value,
    ]),
  );
}

// The daemon transport itself: any socket or pipe the client opens.
jest.mock('node:net', () => {
  const actual = jest.requireActual<typeof NetModule>('node:net');
  return {
    ...actual,
    ...mockObserve('node:net', {
      connect: actual.connect,
      createConnection: actual.createConnection,
    }),
  };
});
// The opt-in Files route records each request it selects for a backend.
jest.mock('@canopy/desktop-shared/node/work-counters', () => {
  const actual = jest.requireActual<typeof WorkCountersModule>(
    '@canopy/desktop-shared/node/work-counters',
  );
  return {
    ...actual,
    ...mockObserve('work-counters', {
      recordFilesRouteSelected: actual.recordFilesRouteSelected,
      recordFilesRouteOutcome: actual.recordFilesRouteOutcome,
    }),
  };
});
jest.mock('@canopy/core-client/node', () => {
  const actual = jest.requireActual<typeof CoreClientNode>(
    '@canopy/core-client/node',
  );
  return {
    ...actual,
    ...mockObserve('core-client/node', {
      attachOrStartCanopyDaemon: actual.attachOrStartCanopyDaemon,
      connectCanopyClient: actual.connectCanopyClient,
    }),
  };
});
jest.mock('../electron-daemon-access', () =>
  mockObserve(
    'electron-daemon-access',
    jest.requireActual<object>('../electron-daemon-access'),
  ),
);
jest.mock('../electron-daemon-connection', () =>
  mockObserve(
    'electron-daemon-connection',
    jest.requireActual<object>('../electron-daemon-connection'),
  ),
);
jest.mock('../electron-daemon-caller-lifetime', () =>
  mockObserve(
    'electron-daemon-caller-lifetime',
    jest.requireActual<object>('../electron-daemon-caller-lifetime'),
  ),
);
jest.mock('../electron-daemon-host', () =>
  mockObserve(
    'electron-daemon-host',
    jest.requireActual<object>('../electron-daemon-host'),
  ),
);
jest.mock('../electron-daemon-files-access', () =>
  mockObserve(
    'electron-daemon-files-access',
    jest.requireActual<object>('../electron-daemon-files-access'),
  ),
);

jest.mock('../../lib/paths', () => ({
  ...jest.requireActual<typeof PathsModule>('../../lib/paths'),
  getFileAnnotationsStateFilePath: (
    projectId: string,
    worktreeId: string,
  ): string => join(tempDir, `${projectId}-${worktreeId}.json`),
}));
jest.mock('../../lib/file-browser-roots', () => ({
  getFileBrowserRoots: (): Promise<never> =>
    Promise.reject(new Error('No file roots.')),
}));
jest.mock('../../lib/window-send', () => ({
  sendToWindow: jest.fn(),
  sendToAllWindows: jest.fn(),
}));
jest.mock('../../ipc/register', () => ({ registerIpcHandler: jest.fn() }));

import { registerIpcHandler } from '../../ipc/register';
import { registerFileAnnotationsHandlers } from '../../ipc/file-annotations';
import { createDesktopRuntime } from '../desktop-runtime';
import { getDesktopDaemonFilesRoute } from '../electron-daemon-files-access';
import { ELECTRON_DAEMON_DEFINITIONS } from '../electron-daemon-host';
import { getElectronDaemonCallerLifetime } from '../electron-daemon-access';
import { connectCanopyClient } from '@canopy/core-client/node';

const caller = (
  grants: CanopyCallerDescriptor['grants'],
): CanopyCallerDescriptor => ({
  principalId: 'local-desktop-user',
  clientInstanceId: 'electron-web-contents:1',
  authorityId: 'desktop-local',
  interfaceKind: 'desktop',
  grants,
});

const ANNOTATION_DEFINITIONS = [
  ...Object.entries(CANOPY_QUERY_DEFINITIONS),
  ...Object.entries(CANOPY_INSTRUCTION_DEFINITIONS),
  ...Object.entries(CANOPY_STREAM_DEFINITIONS),
].filter(([name]) => name.startsWith('core.annotation.'));
const ANNOTATION_OPERATIONS = ANNOTATION_DEFINITIONS.map(([name]) => name);

afterAll(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe('core.annotation.* daemon contact without enablement', () => {
  it('names the seven annotation operations, none in the Electron daemon client', () => {
    expect(new Set(ANNOTATION_OPERATIONS)).toEqual(
      new Set([
        'core.annotation.document.get',
        'core.annotation.thread.get',
        'core.annotation.thread.list',
        'core.annotation.document.save',
        'core.annotation.document.append',
        'core.annotation.document.dismiss',
        'core.annotation.thread.reply',
      ]),
    );
    // The daemon client can only call what these definitions name.
    const daemonOperations = [
      ...Object.keys(ELECTRON_DAEMON_DEFINITIONS.queries),
      ...Object.keys(ELECTRON_DAEMON_DEFINITIONS.instructions),
      ...Object.keys(ELECTRON_DAEMON_DEFINITIONS.streams),
    ];
    expect(
      daemonOperations.filter((name) => name.startsWith('core.annotation.')),
    ).toEqual([]);
    for (const [, definition] of ANNOTATION_DEFINITIONS)
      expect(definition.placement).toBe('core-only');
  });

  it('serves every operation in process, with zero daemon contact', async () => {
    const runtime = createDesktopRuntime({
      shutdownTimeoutMs: 25,
      // As main wires it: the Files route is the runtime's only daemon seam.
      daemonFilesRoute: getDesktopDaemonFilesRoute,
    });
    registerFileAnnotationsHandlers(
      () => [null],
      runtime,
      () => caller([]),
    );
    const ipc = (channel: string, request: unknown): Promise<unknown> => {
      const registered = jest
        .mocked(registerIpcHandler)
        .mock.calls.find(([name]) => name === channel);
      const handler: unknown = registered?.[1];
      if (typeof handler !== 'function') throw new Error('No handler.');
      return Promise.resolve(
        Reflect.apply(handler, undefined, [{ sender: {} }, request]),
      );
    };
    const scope = { projectId: 'p1', worktreeId: 'w1' };
    const read = { caller: caller(['core.annotation.read']) };
    const write = { caller: caller(['core.annotation.write']) };
    const queries = jest.spyOn(runtime, 'query');
    const instructions = jest.spyOn(runtime, 'instruction');
    try {
      const filePath = join(tempDir, 'a.ts');
      const thread = {
        id: 'thread-1',
        status: 'open',
        createdAt: '2026-10-01T00:00:00.000Z',
        anchorState: 'matched',
        anchor: {
          source: 'code',
          repoId: 'repo',
          filePath,
          side: 'new',
          lineStart: 1,
          lineEnd: 1,
          quote: 'one',
        },
        comments: [
          {
            id: 'comment-1',
            author: 'user',
            body: 'Please look.',
            createdAt: '2026-10-01T00:00:00.000Z',
            staged: false,
          },
        ],
      };
      // The IPC projection, as the renderer and remote bridge reach it.
      await ipc(IPC_CHANNELS.fileAnnotationsAppend, {
        ...scope,
        filePath,
        annotations: [],
        commentThreads: [thread],
      });
      const saved = await ipc(IPC_CHANNELS.fileAnnotationsSave, {
        ...scope,
        document: { filePath, annotations: [], commentThreads: [thread] },
        baseCommentThreadIds: [thread.id],
      });
      await ipc(IPC_CHANNELS.fileAnnotationsDismiss, {
        ...scope,
        filePath,
        annotationId: 'missing',
      });
      await ipc(IPC_CHANNELS.fileAnnotationsGet, { ...scope, filePath });
      expect(saved).toMatchObject({ filePath });

      // Direct dispatcher callers: agent tools and the renderer relay.
      const { threads } = await runtime.query(
        'core.annotation.thread.list',
        { scope },
        read,
      );
      expect(threads).toHaveLength(1);
      await runtime.query(
        'core.annotation.thread.get',
        { scope, threadId: thread.id },
        read,
      );
      await runtime.instruction(
        'core.annotation.thread.reply',
        { scope, threadId: thread.id, body: 'Done.', resolve: true },
        write,
      );
      await runtime.query(
        'core.annotation.document.get',
        { scope, file: threads[0].file },
        read,
      );

      const served = [...queries.mock.calls, ...instructions.mock.calls].map(
        ([name]) => name,
      );
      expect(new Set(served)).toEqual(new Set(ANNOTATION_OPERATIONS));
      expect(mockDaemonContact).toEqual([]);
    } finally {
      await runtime.shutdown();
    }
    expect(mockDaemonContact).toEqual([]);
  });

  it('observes the daemon seams (control)', () => {
    mockDaemonContact.length = 0;
    // A seam call that never opens a daemon session, to prove the observer is live.
    getElectronDaemonCallerLifetime();
    expect(mockDaemonContact).toEqual([
      'electron-daemon-access.getElectronDaemonCallerLifetime',
      'electron-daemon-caller-lifetime.createElectronDaemonCallerLifetime',
    ]);
  });

  it('observes a daemon socket connect (control)', async () => {
    mockDaemonContact.length = 0;
    // No daemon listens here: the attempt fails, but its socket is recorded.
    await expect(
      connectCanopyClient({
        clientName: 'desktop-runtime-test',
        clientVersion: '1.0.0',
        definitions: ELECTRON_DAEMON_DEFINITIONS,
        endpoint:
          process.platform === 'win32'
            ? {
                kind: 'pipe',
                path: '\\\\.\\pipe\\canopy-annotation-daemon-contact-control',
                auth: { secret: 'unused', dataRootHash: 'unused' },
              }
            : {
                kind: 'socket',
                path: join(tempDir, 'no-daemon.sock'),
                auth: { secret: 'unused', dataRootHash: 'unused' },
              },
        timeoutMs: 2_000,
      }),
    ).rejects.toThrow();
    expect(mockDaemonContact).toEqual([
      'core-client/node.connectCanopyClient',
      'node:net.createConnection',
    ]);
  });
});
