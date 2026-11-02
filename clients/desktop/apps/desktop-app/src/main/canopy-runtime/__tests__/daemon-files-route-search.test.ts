/**
 * CAN-5037: under the production selection, `file-index:get` searches pass
 * the Files route's eligibility check, are journaled and counted as `direct`
 * once per root and page, and never reach the daemon, whatever the Files
 * reads experiment says. CAN-5509 gives them a daemon path; CAN-4729 selects
 * them.
 */
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
const INDEX = { projectId: 'single', worktreeId: 'task' };

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

function searchEntries(
  after: Cursor,
): Array<{ operation: string; backend: string; phase: string }> {
  const snapshot = harness().route.observe(after);
  expect(snapshot.complete).toBe(true);
  return snapshot.entries
    .filter((entry) => entry.operation === 'search')
    .map(({ operation, backend, phase }) => ({ operation, backend, phase }));
}

const STARTED = { operation: 'search', backend: 'direct', phase: 'started' };
const SUCCESS = { operation: 'search', backend: 'direct', phase: 'success' };

it.each([true, false])(
  'serves a window index directly, one counted search per root, with the experiment %s',
  async (flag) => {
    h = await createRouteHarness({ flag });
    // Any daemon contact fails the index.
    h.connectionsFactory.mockImplementation(() => {
      throw new Error('connections() must not be called for the index.');
    });
    h.hostContext.mockImplementation(() => {
      throw new Error('hostContext() must not be called for the index.');
    });
    resetWorkCounters();
    const local = sender();
    const before = cursor();
    const index = await h.runtime.queryFileIndexForLegacyIpc(
      INDEX,
      { caller: localCaller(local) },
      { sender: local },
    );
    expect(index.repos.map((repo) => repo.repoId)).toEqual([
      'single',
      'attachments',
    ]);
    expect(index.repos[0]?.files.map((file) => file.relativePath)).toContain(
      'README.md',
    );
    expectNoDaemonContact();
    // The worktree and its attachments: two roots, one page each.
    expect(searchEntries(before)).toEqual([STARTED, STARTED, SUCCESS, SUCCESS]);
    const counters = snapshotFilesWorkCounters();
    expect(counters.route['files.search.direct']).toBe(2);
    expect(counters.route['files.search.daemon']).toBe(0);
  },
);

it('does not discard a direct search when the experiment flips mid-index', async () => {
  const searchStarted = deferred();
  const releaseSearch = deferred();
  h = await createRouteHarness({
    flag: true,
    wrapRoute: (route) => {
      const holding: DaemonFilesRoute = {
        ...route,
        search: (params, context, request, run) =>
          route.search(params, context, request, {
            ...run,
            direct: async () => {
              searchStarted.resolve();
              await releaseSearch.promise;
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
  const index = h.runtime.queryFileIndexForLegacyIpc(
    INDEX,
    { caller: localCaller(local) },
    { sender: local },
  );
  try {
    await untilReached(searchStarted.promise, index);
    h.flag.set(false);
    h.flag.set(true);
    expect(h.route.observe().generation).toBe(2);
  } finally {
    releaseSearch.resolve();
  }
  await expect(index).resolves.toMatchObject({
    repos: [{ repoId: 'single' }, { repoId: 'attachments' }],
  });
  expect(
    searchEntries(before).filter((entry) => entry.phase === 'success'),
  ).toHaveLength(2);
  const counters = snapshotFilesWorkCounters();
  expect(counters.route['files.search.direct']).toBe(2);
  expect(counters.route['files.search.direct.discarded']).toBe(0);
  expectNoDaemonContact();
});

it('counts a remote-bridge index as direct after it fails eligibility', async () => {
  h = await createRouteHarness({ flag: true });
  resetWorkCounters();
  const bridge = sender();
  await h.runtime.queryFileIndexForLegacyIpc(
    INDEX,
    { caller: bridgeCaller(bridge, 'controller-1') },
    { sender: bridge },
  );
  expectNoDaemonContact();
  expect(snapshotFilesWorkCounters().route['files.search.direct']).toBe(2);
});

it('leaves searches without an IPC sender unjournaled and uncounted', async () => {
  h = await createRouteHarness({ flag: true });
  resetWorkCounters();
  const local = sender();
  const before = cursor();
  await expect(
    h.runtime.queryFileIndexForLegacyIpc(INDEX, {
      caller: localCaller(local),
    }),
  ).resolves.toMatchObject({ repos: [{ repoId: 'single' }, {}] });
  await expect(
    h.runtime.query(
      'worker.filesystem.search',
      { scope: SINGLE, fileRootId: 'single', query: 'readme', mode: 'name' },
      { caller: localCaller(local) },
    ),
  ).resolves.toMatchObject({
    matches: [{ path: 'README.md' }],
    nextCursor: null,
  });
  expect(searchEntries(before)).toEqual([]);
  expect(snapshotFilesWorkCounters().route['files.search.direct']).toBe(0);
  expectNoDaemonContact();
});
