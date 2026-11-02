/**
 * CAN-5038: under the production selection, `file-reference:resolve` links
 * pass the Files route's eligibility check, are journaled and counted as
 * `direct`, and never reach the daemon, whatever the Files reads experiment
 * says. CAN-5509 gives them a daemon path; CAN-4729 selects them.
 */
import { join } from 'node:path';
import {
  resetWorkCounters,
  snapshotFilesWorkCounters,
} from '@canopy/desktop-shared/node/work-counters';
import type { DaemonFilesRoute } from '../daemon-files-route';
import {
  bridgeCaller,
  createRouteHarness,
  deferred,
  FakeSender,
  localCaller,
  type RouteHarness,
  untilReached,
} from './daemon-files-route-harness';

const SINGLE = { workspaceId: 'single', worktreeId: 'task' };

let h: RouteHarness | undefined;
let senderIds = 950;
const sender = (): FakeSender => new FakeSender((senderIds += 1));

afterEach(async () => {
  await h?.close();
  h = undefined;
});

function harness(): RouteHarness {
  if (!h) throw new Error('No route harness.');
  return h;
}

function home(): string {
  return join(
    harness().displayRoot,
    'workspaces',
    'single',
    'worktrees',
    'task',
  );
}

function markdownRequest(): Parameters<
  RouteHarness['runtime']['queryLinkResolveForLegacyIpc']
>[0] {
  return {
    scope: SINGLE,
    mode: 'markdown',
    href: './README.md#top',
    baseFilePath: join(home(), 'NOTES.md'),
  };
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

function linkEntries(
  after: Cursor,
): Array<{ operation: string; backend: string; phase: string }> {
  const snapshot = harness().route.observe(after);
  expect(snapshot.complete).toBe(true);
  return snapshot.entries
    .filter((entry) => entry.operation === 'link')
    .map(({ operation, backend, phase }) => ({ operation, backend, phase }));
}

it.each([true, false])(
  'resolves a window link directly and counts it with the experiment %s',
  async (flag) => {
    h = await createRouteHarness({ flag });
    // Any daemon contact fails the resolution.
    h.connectionsFactory.mockImplementation(() => {
      throw new Error('connections() must not be called for links.');
    });
    h.hostContext.mockImplementation(() => {
      throw new Error('hostContext() must not be called for links.');
    });
    resetWorkCounters();
    const local = sender();
    const before = cursor();
    const { canonicalResult, legacyResult } =
      await h.runtime.queryLinkResolveForLegacyIpc(
        markdownRequest(),
        { caller: localCaller(local) },
        { sender: local },
      );
    expect(legacyResult).toEqual({
      absolutePath: join(home(), 'README.md'),
      filename: 'README.md',
      kind: 'file',
    });
    expect(canonicalResult).toEqual({
      fileRootId: 'single',
      relativePath: 'README.md',
      name: 'README.md',
      kind: 'file',
    });
    await expect(
      h.runtime.queryLinkResolveForLegacyIpc(
        { scope: SINGLE, mode: 'transcript', href: 'README.md' },
        { caller: localCaller(local) },
        { sender: local },
      ),
    ).resolves.toMatchObject({
      canonicalResult: { fileRootId: 'single', relativePath: 'README.md' },
    });
    // A typed failure projects to null and is still a direct read.
    await expect(
      h.runtime.queryLinkResolveForLegacyIpc(
        { scope: SINGLE, mode: 'transcript', href: '../README.md' },
        { caller: localCaller(local) },
        { sender: local },
      ),
    ).resolves.toEqual({ canonicalResult: null, legacyResult: null });
    expectNoDaemonContact();
    expect(linkEntries(before)).toEqual([
      { operation: 'link', backend: 'direct', phase: 'started' },
      { operation: 'link', backend: 'direct', phase: 'success' },
      { operation: 'link', backend: 'direct', phase: 'started' },
      { operation: 'link', backend: 'direct', phase: 'success' },
      { operation: 'link', backend: 'direct', phase: 'started' },
      { operation: 'link', backend: 'direct', phase: 'failed' },
    ]);
    const counters = snapshotFilesWorkCounters();
    expect(counters.route['files.link.direct']).toBe(3);
    expect(counters.route['files.link.daemon']).toBe(0);
  },
);

it('does not discard a direct resolution when the experiment flips mid-read', async () => {
  const directStarted = deferred();
  const releaseDirect = deferred();
  h = await createRouteHarness({
    flag: true,
    wrapRoute: (route) => {
      const holding: DaemonFilesRoute = {
        ...route,
        link: (params, context, request, run) =>
          route.link(params, context, request, {
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
  const before = cursor();
  const read = h.runtime.queryLinkResolveForLegacyIpc(
    markdownRequest(),
    { caller: localCaller(local) },
    { sender: local },
  );
  try {
    await untilReached(directStarted.promise, read);
    h.flag.set(false);
    h.flag.set(true);
    expect(h.route.observe().generation).toBe(2);
  } finally {
    releaseDirect.resolve();
  }
  await expect(read).resolves.toMatchObject({
    legacyResult: { filename: 'README.md', kind: 'file' },
  });
  expect(linkEntries(before)).toEqual([
    { operation: 'link', backend: 'direct', phase: 'started' },
    { operation: 'link', backend: 'direct', phase: 'success' },
  ]);
  const counters = snapshotFilesWorkCounters();
  expect(counters.route['files.link.direct']).toBe(1);
  expect(counters.route['files.link.direct.discarded']).toBe(0);
  expectNoDaemonContact();
});

it('counts a remote-bridge resolution as direct after it fails eligibility', async () => {
  h = await createRouteHarness({ flag: true });
  resetWorkCounters();
  const bridge = sender();
  await h.runtime.queryLinkResolveForLegacyIpc(
    markdownRequest(),
    { caller: bridgeCaller(bridge, 'controller-1') },
    { sender: bridge },
  );
  expectNoDaemonContact();
  expect(snapshotFilesWorkCounters().route['files.link.direct']).toBe(1);
});

it('leaves resolutions without an IPC sender unjournaled and uncounted', async () => {
  h = await createRouteHarness({ flag: true });
  resetWorkCounters();
  const local = sender();
  const before = cursor();
  await expect(
    h.runtime.queryLinkResolveForLegacyIpc(markdownRequest(), {
      caller: localCaller(local),
    }),
  ).resolves.toMatchObject({ legacyResult: { filename: 'README.md' } });
  await expect(
    h.runtime.query(
      'worker.filesystem.link.resolve',
      { scope: SINGLE, mode: 'transcript', href: 'README.md' },
      { caller: localCaller(local) },
    ),
  ).resolves.toMatchObject({ relativePath: 'README.md' });
  expect(linkEntries(before)).toEqual([]);
  expect(snapshotFilesWorkCounters().route['files.link.direct']).toBe(0);
  expectNoDaemonContact();
});
