/**
 * CAN-4099: scoped `file:read-content` reads pass the Files route's
 * eligibility check and are journaled and counted. CAN-5509 gives them a
 * daemon path and CAN-5556 selects them: with the Files reads experiment on,
 * a window's read reaches the daemon on macOS; off, it stays direct.
 */
import { join } from 'node:path';
import {
  resetWorkCounters,
  snapshotFilesWorkCounters,
} from '@canopy/desktop-shared/node/work-counters';
import { WORKER_QUERY_DEFINITIONS } from '@canopy/protocol/canopy-core';
import {
  DAEMON_FILES_PRODUCTION_SELECTION,
  type DaemonFilesQueryClient,
  type DaemonFilesRoute,
} from '../daemon-files-route';
import { ELECTRON_DAEMON_DEFINITIONS } from '../electron-daemon-host';
import {
  bridgeCaller,
  createRouteHarness,
  deferred,
  FakeSender,
  localCaller,
  rejection,
  type RouteHarness,
  untilReached,
} from './daemon-files-route-harness';

const SINGLE = { workspaceId: 'single', worktreeId: 'task' };

let h: RouteHarness | undefined;
let senderIds = 900;
const sender = (): FakeSender => new FakeSender((senderIds += 1));

afterEach(async () => {
  await h?.close();
  h = undefined;
});

function harness(): RouteHarness {
  if (!h) throw new Error('No route harness.');
  return h;
}

function readme(): string {
  return join(
    harness().displayRoot,
    'workspaces',
    'single',
    'worktrees',
    'task',
    'README.md',
  );
}

function expectNoDaemonContact(): void {
  expect(harness().connectionsFactory).not.toHaveBeenCalled();
  expect(harness().hostContext).not.toHaveBeenCalled();
  expect(harness().connections.gets).toHaveLength(0);
  expect(harness().daemon.queries).toHaveLength(0);
}

type Cursor = ReturnType<RouteHarness['route']['observe']>['cursor'];

function cursor(): Cursor {
  return harness().route.observe().cursor;
}

function fileEntries(
  after: Cursor,
): Array<{ operation: string; backend: string; phase: string }> {
  const snapshot = harness().route.observe(after);
  expect(snapshot.complete).toBe(true);
  return snapshot.entries
    .filter((entry) => entry.operation === 'file')
    .map(({ operation, backend, phase }) => ({ operation, backend, phase }));
}

it.each([
  [true, 'daemon'],
  [false, 'direct'],
] as const)(
  'serves a window read and counts it with the experiment %s, through the %s reader',
  async (flag, backend) => {
    h = await createRouteHarness({ flag, platform: 'darwin' });
    if (backend === 'direct') {
      // Any daemon contact fails the read.
      h.connectionsFactory.mockImplementation(() => {
        throw new Error('connections() must not be called for file reads.');
      });
      h.hostContext.mockImplementation(() => {
        throw new Error('hostContext() must not be called for file reads.');
      });
    }
    resetWorkCounters();
    const local = sender();
    const before = cursor();
    const { canonicalResult, legacyResult } =
      await h.runtime.queryFileContentForLegacyIpc(
        { scope: SINGLE, absolutePath: readme() },
        { caller: localCaller(local) },
        { sender: local },
      );
    expect(legacyResult).toMatchObject({
      kind: 'markdown',
      content: 'single',
      filename: 'README.md',
    });
    expect(canonicalResult).toMatchObject({
      fileRootId: 'single',
      relativePath: 'README.md',
      contentKind: 'markdown',
    });
    if (backend === 'direct') expectNoDaemonContact();
    else expect(h.daemon.names()).toEqual(['worker.filesystem.file.read']);
    expect(fileEntries(before)).toEqual([
      { operation: 'file', backend, phase: 'started' },
      { operation: 'file', backend, phase: 'success' },
    ]);
    const counters = snapshotFilesWorkCounters();
    expect(counters.route[`files.file.${backend}`]).toBe(1);
    expect(
      counters.route[
        `files.file.${backend === 'daemon' ? 'direct' : 'daemon'}`
      ],
    ).toBe(0);
  },
);

it('discards a direct read that finishes after the experiment turns on, without contact', async () => {
  const directStarted = deferred();
  const releaseDirect = deferred();
  h = await createRouteHarness({
    flag: false,
    platform: 'darwin',
    wrapRoute: (route) => {
      const holding: DaemonFilesRoute = {
        ...route,
        file: (params, context, request, run) =>
          route.file(params, context, request, {
            ...run,
            direct: async () => {
              directStarted.resolve();
              await releaseDirect.promise;
              return run.direct();
            },
          }),
      };
      return holding;
    },
  });
  resetWorkCounters();
  const local = sender();
  const read = rejection(
    h.runtime.queryFileContentForLegacyIpc(
      { scope: SINGLE, absolutePath: readme() },
      { caller: localCaller(local) },
      { sender: local },
    ),
  );
  try {
    await untilReached(directStarted.promise, read);
    h.flag.set(true);
  } finally {
    releaseDirect.resolve();
  }
  expect(await read).toMatchObject({
    kind: 'cancelled',
    retry: { kind: 'after_refresh' },
  });
  expect(snapshotFilesWorkCounters().route['files.file.direct.discarded']).toBe(
    1,
  );
  expectNoDaemonContact();
});

it('does not discard a remote-bridge read when the experiment flips mid-read', async () => {
  const directStarted = deferred();
  const releaseDirect = deferred();
  // Holds the direct read the real route runs, after its journal entry, so
  // both flips land while the read is in flight.
  h = await createRouteHarness({
    flag: true,
    platform: 'darwin',
    wrapRoute: (route) => {
      const holding: DaemonFilesRoute = {
        ...route,
        file: (params, context, request, run) =>
          route.file(params, context, request, {
            ...run,
            direct: async () => {
              directStarted.resolve();
              await releaseDirect.promise;
              return run.direct();
            },
          }),
      };
      return holding;
    },
  });
  resetWorkCounters();
  const bridge = sender();
  const before = cursor();
  const read = h.runtime.queryFileContentForLegacyIpc(
    { scope: SINGLE, absolutePath: readme() },
    { caller: bridgeCaller(bridge, 'controller-1') },
    { sender: bridge },
  );
  try {
    await untilReached(directStarted.promise, read);
    expect(fileEntries(before)).toEqual([
      { operation: 'file', backend: 'direct', phase: 'started' },
    ]);
    h.flag.set(false);
    h.flag.set(true);
    expect(h.route.observe().generation).toBe(2);
  } finally {
    // A failed assertion must not leave the read held through teardown.
    releaseDirect.resolve();
  }
  await expect(read).resolves.toMatchObject({
    legacyResult: { kind: 'markdown', content: 'single' },
    canonicalResult: { fileRootId: 'single', relativePath: 'README.md' },
  });
  expect(fileEntries(before)).toEqual([
    { operation: 'file', backend: 'direct', phase: 'started' },
    { operation: 'file', backend: 'direct', phase: 'success' },
  ]);
  const counters = snapshotFilesWorkCounters();
  expect(counters.route['files.file.direct']).toBe(1);
  expect(counters.route['files.file.direct.discarded']).toBe(0);
  expectNoDaemonContact();
});

it('counts a remote-bridge read as direct after it fails eligibility', async () => {
  h = await createRouteHarness({ flag: true, platform: 'darwin' });
  resetWorkCounters();
  const bridge = sender();
  await h.runtime.queryFileContentForLegacyIpc(
    { scope: SINGLE, absolutePath: readme() },
    { caller: bridgeCaller(bridge, 'controller-1') },
    { sender: bridge },
  );
  expectNoDaemonContact();
  expect(snapshotFilesWorkCounters().route['files.file.direct']).toBe(1);
});

it('leaves reads without an IPC sender unjournaled and uncounted', async () => {
  h = await createRouteHarness({ flag: true, platform: 'darwin' });
  resetWorkCounters();
  const local = sender();
  const before = cursor();
  await expect(
    h.runtime.queryFileContentForLegacyIpc(
      { scope: SINGLE, absolutePath: readme() },
      { caller: localCaller(local) },
    ),
  ).resolves.toMatchObject({ legacyResult: { kind: 'markdown' } });
  await expect(
    h.runtime.query(
      'worker.filesystem.file.read',
      {
        scope: SINGLE,
        fileRootId: 'single',
        relativePath: 'README.md',
        maxBytes: 1024,
      },
      { caller: localCaller(local) },
    ),
  ).resolves.toMatchObject({ content: 'single' });
  expect(fileEntries(before)).toEqual([]);
  expect(snapshotFilesWorkCounters().route['files.file.direct']).toBe(0);
  expectNoDaemonContact();
});

it('gives the Electron daemon client the five Files reads with a daemon path, and selects all five', () => {
  expect(
    Object.keys(ELECTRON_DAEMON_DEFINITIONS.queries).filter((name) =>
      name.startsWith('worker.'),
    ),
  ).toEqual([
    'worker.filesystem.roots.list',
    'worker.filesystem.directory.list',
    'worker.filesystem.file.read',
    'worker.filesystem.search',
    'worker.filesystem.link.resolve',
  ]);
  for (const name of Object.keys(ELECTRON_DAEMON_DEFINITIONS.queries))
    if (name.startsWith('worker.'))
      expect(Object.keys(WORKER_QUERY_DEFINITIONS)).toContain(name);
  // CAN-5556: production selects every Files read with a daemon path; the
  // read-route table still decides each host.
  expect([...DAEMON_FILES_PRODUCTION_SELECTION]).toEqual([
    'roots',
    'directory',
    'file',
    'search',
    'link',
  ]);
});

// Type-level pin (tsc -p tsconfig.test.desktop-main.json; CI's typecheck
// skips tests): the daemon Files client carries only the five Files reads.
// The ELECTRON_DAEMON_DEFINITIONS test above is the executed pin.
function pinDaemonFilesQueryClient(client: DaemonFilesQueryClient): void {
  void client.query('worker.filesystem.file.read', {
    scope: SINGLE,
    fileRootId: 'single',
    relativePath: 'README.md',
    maxBytes: 1,
  });
  // @ts-expect-error worker.git.branch.list has no Files daemon path.
  void client.query('worker.git.branch.list', { scope: SINGLE });
}
void pinDaemonFilesQueryClient;
