/**
 * CAN-5037: `file-index:get` searches pass the Files route's eligibility
 * check and are journaled and counted once per root and page. CAN-5509 gives
 * them a daemon path and CAN-5556 selects them: with the Files reads
 * experiment on, a window's index walks through the daemon on macOS; off, it
 * stays direct.
 */
import { CanopyClientError } from '@canopy/core-client';
import {
  resetWorkCounters,
  snapshotFilesWorkCounters,
} from '@canopy/desktop-shared/node/work-counters';
import type { WorkerFilesystemSearchResult } from '@canopy/protocol/canopy-core';
import type {
  DaemonFilesRoute,
  DaemonFilesSearchWalk,
} from '../daemon-files-route';
import { markUnreachable } from '../electron-daemon-connection';
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

it.each([
  [true, 'daemon'],
  [false, 'direct'],
] as const)(
  'serves a window index, one counted search per root, with the experiment %s, through the %s reader',
  async (flag, backend) => {
    h = await createRouteHarness({ flag, platform: 'darwin' });
    if (backend === 'direct') {
      // Any daemon contact fails the index.
      h.connectionsFactory.mockImplementation(() => {
        throw new Error('connections() must not be called for the index.');
      });
      h.hostContext.mockImplementation(() => {
        throw new Error('hostContext() must not be called for the index.');
      });
    }
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
    if (backend === 'direct') expectNoDaemonContact();
    else
      expect(h.daemon.names()).toEqual([
        'worker.filesystem.search',
        'worker.filesystem.search',
      ]);
    // The worktree and its attachments: two roots, one page each.
    const started = { ...STARTED, backend };
    const success = { ...SUCCESS, backend };
    expect(searchEntries(before)).toEqual([started, started, success, success]);
    const counters = snapshotFilesWorkCounters();
    expect(counters.route[`files.search.${backend}`]).toBe(2);
    expect(
      counters.route[
        `files.search.${backend === 'daemon' ? 'direct' : 'daemon'}`
      ],
    ).toBe(0);
  },
);

it('discards a direct index whose page finishes after the experiment turns on, without contact', async () => {
  const searchStarted = deferred();
  const releaseSearch = deferred();
  h = await createRouteHarness({
    flag: false,
    platform: 'darwin',
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
  const index = rejection(
    h.runtime.queryFileIndexForLegacyIpc(
      INDEX,
      { caller: localCaller(local) },
      { sender: local },
    ),
  );
  try {
    await untilReached(searchStarted.promise, index);
    h.flag.set(true);
  } finally {
    releaseSearch.resolve();
  }
  expect(await index).toMatchObject({
    kind: 'cancelled',
    retry: { kind: 'after_refresh' },
  });
  expect(
    snapshotFilesWorkCounters().route['files.search.direct.discarded'],
  ).toBeGreaterThan(0);
  expectNoDaemonContact();
});

it('does not discard a remote-bridge search when the experiment flips mid-index', async () => {
  const searchStarted = deferred();
  const releaseSearch = deferred();
  h = await createRouteHarness({
    flag: true,
    platform: 'darwin',
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
  const bridge = sender();
  const before = cursor();
  const index = h.runtime.queryFileIndexForLegacyIpc(
    INDEX,
    { caller: bridgeCaller(bridge, 'controller-1') },
    { sender: bridge },
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
  h = await createRouteHarness({ flag: true, platform: 'darwin' });
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
  h = await createRouteHarness({ flag: true, platform: 'darwin' });
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

function failDaemonStart(): void {
  harness().connections.fail = (): Error => {
    const failure = markUnreachable(
      new CanopyClientError({
        kind: 'failed_precondition',
        message: 'Core launch failed.',
        retry: { kind: 'never' },
      }),
      'start_failed',
    );
    if (!(failure instanceof Error)) throw new Error('Expected an Error.');
    return failure;
  };
}

/** One page of `walk` at the route, with a stand-in direct reader. */
function routePage(
  local: FakeSender,
  walk: DaemonFilesSearchWalk,
  direct: () => Promise<WorkerFilesystemSearchResult>,
): Promise<WorkerFilesystemSearchResult> {
  return harness().route.search(
    { scope: SINGLE, fileRootId: 'single', query: 'readme', mode: 'name' },
    {
      requestId: 'search',
      caller: localCaller(local),
      metadata: {},
      signal: new AbortController().signal,
    },
    { sender: local },
    { direct, capture: jest.fn(), walk },
  );
}

const EMPTY_PAGE: WorkerFilesystemSearchResult = {
  matches: [],
  nextCursor: null,
  truncated: false,
};

it('keeps an unlatched daemon walk typed and reads a walk that starts latched directly (CAN-5541, q-6)', async () => {
  h = await createRouteHarness({ flag: true, platform: 'darwin' });
  const local = sender();
  const walkFor = (): DaemonFilesSearchWalk =>
    harness().route.searchWalk(SINGLE, localCaller(local), { sender: local });
  const direct = jest.fn(() =>
    Promise.reject(new Error('A daemon walk never reads directly.')),
  );
  failDaemonStart();
  // Not latched yet: the daemon walk's failure stays typed.
  await expect(
    rejection(routePage(local, walkFor(), direct)),
  ).resolves.toMatchObject({
    kind: 'failed_precondition',
    message: 'Core launch failed.',
  });
  expect(h.connections.gets).toHaveLength(1);
  expect(direct).not.toHaveBeenCalled();

  // Latched: a new index reads in-process with no daemon contact.
  h.health.observe({ kind: 'unreachable', reason: 'start_failed' });
  resetWorkCounters();
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
  expect(h.connections.gets).toHaveLength(1);
  expect(h.daemon.queries).toHaveLength(0);
  const started = { operation: 'search', backend: 'daemon', phase: 'started' };
  const fellBack = { ...started, phase: 'fallback' };
  expect(searchEntries(before)).toEqual([started, started, fellBack, fellBack]);
  const counters = snapshotFilesWorkCounters().route;
  expect(counters['files.search.daemon']).toBe(2);
  expect(counters['files.search.daemon.bypassed']).toBe(2);
  expect(counters['files.search.direct']).toBe(0);
  expect(counters['files.search.daemon.queries']).toBe(0);
});

it('keeps each walk on the backend it started with when the latch changes', async () => {
  h = await createRouteHarness({ flag: true, platform: 'darwin' });
  const local = sender();
  const walkFor = (): DaemonFilesSearchWalk =>
    harness().route.searchWalk(SINGLE, localCaller(local), { sender: local });

  // Started on the daemon, then latched: its next page still asks the daemon.
  const daemonWalk = walkFor();
  expect(daemonWalk.backend).toBe('daemon');
  h.health.observe({ kind: 'unreachable', reason: 'start_failed' });
  const never = jest.fn(() =>
    Promise.reject(new Error('A daemon walk never reads directly.')),
  );
  await expect(routePage(local, daemonWalk, never)).resolves.toMatchObject({
    matches: [{ path: 'README.md' }],
  });
  expect(never).not.toHaveBeenCalled();
  expect(h.daemon.names()).toEqual(['worker.filesystem.search']);

  // Started latched, then reached: its next page still reads directly.
  const bypassedWalk = walkFor();
  expect(bypassedWalk.backend).toBe('direct');
  h.health.observe({ kind: 'reached' });
  const direct = jest.fn(() => Promise.resolve(EMPTY_PAGE));
  await expect(routePage(local, bypassedWalk, direct)).resolves.toBe(
    EMPTY_PAGE,
  );
  expect(direct).toHaveBeenCalledTimes(1);
  expect(h.daemon.names()).toEqual(['worker.filesystem.search']);
  expect(walkFor().backend).toBe('daemon');
});
