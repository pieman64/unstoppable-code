/**
 * CAN-5501: the Files route reads the shared read-route table for its host.
 * Production selects every Files read (CAN-5556). Roots and directory keep
 * their reach on every platform; file, search and link reach the daemon on
 * macOS (CAN-5509) and Linux (CAN-5547), and stay direct on Windows
 * (CAN-4732) and an unknown host.
 */
import { join } from 'node:path';
import type {
  CanopyCallerDescriptor,
  CanopyWorkspaceScope,
} from '@canopy/protocol/canopy-core';
import {
  resetWorkCounters,
  snapshotFilesWorkCounters,
} from '@canopy/desktop-shared/node/work-counters';
import {
  DAEMON_FILES_EXCLUDED_WORKSPACE_IDS,
  type DaemonFilesOperation,
  type DaemonFilesRouteSender,
} from '../daemon-files-route';
import { registerWorkspaceTypes } from '../../lib/workspace-registry';
import type { ReadRoutePlatform } from '../daemon-read-route-guard';
import {
  bridgeCaller,
  createRouteHarness,
  FakeSender,
  FIXTURE_TYPES,
  localCaller,
  type RouteHarness,
} from './daemon-files-route-harness';

const SINGLE = { workspaceId: 'single', worktreeId: 'task' };
/** The reads whose daemon reach the table limits to macOS and Linux. */
type LaterOperation = Exclude<DaemonFilesOperation, 'roots' | 'directory'>;
const LATER_OPERATIONS: readonly LaterOperation[] = ['file', 'search', 'link'];
const DAEMON_QUERY: Readonly<Record<LaterOperation, string>> = {
  file: 'worker.filesystem.file.read',
  search: 'worker.filesystem.search',
  link: 'worker.filesystem.link.resolve',
};

let h: RouteHarness | undefined;
let senderIds = 1_200;
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

function worktreePath(...segments: string[]): string {
  return join(
    harness().displayRoot,
    'workspaces',
    'single',
    'worktrees',
    'task',
    ...segments,
  );
}

/** One IPC read of `operation`, as its legacy handler issues it. */
function read(
  operation: LaterOperation,
  who: FakeSender,
  caller: CanopyCallerDescriptor = localCaller(who),
  scope: { workspaceId: string; worktreeId: string } = SINGLE,
): Promise<unknown> {
  const { runtime } = harness();
  if (operation === 'file')
    return runtime.queryFileContentForLegacyIpc(
      { scope, absolutePath: worktreePath('README.md') },
      { caller },
      { sender: who },
    );
  if (operation === 'search')
    return runtime.queryFileIndexForLegacyIpc(
      { projectId: scope.workspaceId, worktreeId: scope.worktreeId },
      { caller },
      { sender: who },
    );
  return runtime.queryLinkResolveForLegacyIpc(
    {
      scope,
      mode: 'markdown',
      href: './README.md#top',
      baseFilePath: worktreePath('NOTES.md'),
    },
    { caller },
    { sender: who },
  );
}

/**
 * One read straight at the route, as its runtime handler issues it, with a
 * direct reader that serves a fixed result.
 */
function routeRead(
  operation: LaterOperation,
  scope: CanopyWorkspaceScope,
  caller: CanopyCallerDescriptor,
  who: DaemonFilesRouteSender,
  direct: jest.Mock<Promise<unknown>, []>,
): Promise<unknown> {
  const { route } = harness();
  const context = {
    requestId: `route-${caller.clientInstanceId}`,
    caller,
    metadata: {},
    signal: new AbortController().signal,
  };
  const request = { sender: who };
  const capture = (): void => undefined;
  if (operation === 'file')
    return route.file(
      { scope, fileRootId: 'single', relativePath: 'README.md', maxBytes: 64 },
      context,
      request,
      {
        capture,
        direct: async () => {
          await direct();
          return {
            fileRootId: 'single',
            relativePath: 'README.md',
            name: 'README.md',
            contentKind: 'markdown',
            encoding: 'utf8',
            content: 'single',
            sizeBytes: 6,
            returnedBytes: 6,
            truncated: false,
            modifiedAt: new Date(0).toISOString(),
            version: '6:0',
          };
        },
      },
    );
  if (operation === 'search')
    return route.search(
      { scope, fileRootId: 'single', query: '', mode: 'name' },
      context,
      request,
      {
        capture,
        walk: route.searchWalk(scope, caller, request),
        direct: async () => {
          await direct();
          return { matches: [], nextCursor: null, truncated: false };
        },
      },
    );
  return route.link(
    { scope, mode: 'transcript', href: 'README.md' },
    context,
    request,
    {
      capture,
      hostBase: false,
      direct: async () => {
        await direct();
        return {
          fileRootId: 'single',
          relativePath: 'README.md',
          name: 'README.md',
          kind: 'file',
        };
      },
    },
  );
}

describe.each<ReadRoutePlatform>(['darwin', 'win32', 'linux'])(
  'roots and directory on %s',
  (platform) => {
    it('stay selectable and served by the daemon', async () => {
      h = await createRouteHarness({ platform });
      const local = sender();
      await h.roots(SINGLE, local);
      await h.directory(SINGLE, 'single', '', local);
      expect(h.daemon.names()).toEqual([
        'worker.filesystem.roots.list',
        'worker.filesystem.directory.list',
      ]);
      expect(h.direct.roots).not.toHaveBeenCalled();
      expect(h.direct.directory).not.toHaveBeenCalled();
    });
  },
);

it('keeps roots and directory direct on an unknown host', async () => {
  h = await createRouteHarness({ platform: null });
  resetWorkCounters();
  const local = sender();
  await h.roots(SINGLE, local);
  await h.directory(SINGLE, 'single', '', local);
  for (const operation of LATER_OPERATIONS) await read(operation, local);
  expectNoDaemonContact();
  expect(h.direct.roots).toHaveBeenCalledTimes(1);
  expect(h.direct.directory).toHaveBeenCalledTimes(1);
  expect(snapshotFilesWorkCounters().route['files.roots.direct']).toBe(1);
});

describe('file, search and link on Windows', () => {
  it.each(LATER_OPERATIONS)(
    'serves %s directly under the production selection',
    async (operation) => {
      h = await createRouteHarness({ platform: 'win32' });
      resetWorkCounters();
      await expect(read(operation, sender())).resolves.toBeDefined();
      expectNoDaemonContact();
      const counters = snapshotFilesWorkCounters().route;
      expect(counters[`files.${operation}.direct`]).toBeGreaterThan(0);
      expect(counters[`files.${operation}.daemon`]).toBe(0);
    },
  );
});

describe.each<ReadRoutePlatform>(['darwin', 'linux'])(
  'file, search and link on %s',
  (platform) => {
    it.each(LATER_OPERATIONS)(
      'serves %s through the daemon under the production selection',
      async (operation) => {
        h = await createRouteHarness({ platform, flag: true });
        resetWorkCounters();
        await expect(read(operation, sender())).resolves.toBeDefined();
        expect(h.daemon.names()).toContain(DAEMON_QUERY[operation]);
        const counters = snapshotFilesWorkCounters().route;
        expect(counters[`files.${operation}.daemon`]).toBeGreaterThan(0);
        expect(counters[`files.${operation}.direct`]).toBe(0);
      },
    );

    it.each(LATER_OPERATIONS)(
      'keeps %s direct for every excluded caller and scope',
      async (operation) => {
        h = await createRouteHarness({ platform });
        // Registered under the same ids, the exclusion still applies first.
        registerWorkspaceTypes(
          new Map([
            ...FIXTURE_TYPES,
            ...[...DAEMON_FILES_EXCLUDED_WORKSPACE_IDS].map(
              (id) => [id, 'single-repo'] as const,
            ),
          ]),
        );
        const who = sender();
        const excluded: Array<
          [CanopyCallerDescriptor, { workspaceId: string; worktreeId: string }]
        > = [
          [bridgeCaller(who, 'controller-1'), SINGLE],
          [
            {
              ...localCaller(who),
              interfaceKind: 'portal',
              clientInstanceId: `portal-session:${who.id}`,
            },
            SINGLE,
          ],
          [localCaller({ id: who.id + 1 }), SINGLE],
          // App Advisor, the shared viewer, plan-explore and code review.
          ...[...DAEMON_FILES_EXCLUDED_WORKSPACE_IDS].map(
            (workspaceId) =>
              [localCaller(who), { workspaceId, worktreeId: 'task' }] as [
                CanopyCallerDescriptor,
                { workspaceId: string; worktreeId: string },
              ],
          ),
        ];
        for (const [caller, scope] of excluded) {
          // At the route, so no runtime pre-check (the file read's root
          // lookup refuses an excluded path) can stand in for the guard.
          const direct = jest.fn(() => Promise.resolve());
          await expect(
            routeRead(operation, scope, caller, who, direct),
          ).resolves.toBeDefined();
          expect(direct).toHaveBeenCalledTimes(1);
        }
        // And end to end for the callers, whose reads reach the route.
        resetWorkCounters();
        for (const [caller] of excluded.slice(0, 3))
          await expect(read(operation, who, caller)).resolves.toBeDefined();
        expectNoDaemonContact();
        const counters = snapshotFilesWorkCounters().route;
        expect(counters[`files.${operation}.direct`]).toBeGreaterThanOrEqual(3);
        expect(counters[`files.${operation}.daemon`]).toBe(0);
      },
    );

    it('keeps a foreign selector and a read without an IPC sender direct', async () => {
      h = await createRouteHarness({ platform });
      const local = sender();
      // File, search and link requests cannot carry one; roots can.
      await h.roots({ ...SINGLE, repoId: 'single' }, local);
      expect(h.direct.roots).toHaveBeenCalledTimes(1);
      await expect(
        h.runtime.queryFileContentForLegacyIpc(
          { scope: SINGLE, absolutePath: worktreePath('README.md') },
          { caller: localCaller(local) },
        ),
      ).resolves.toMatchObject({ legacyResult: { kind: 'markdown' } });
      expectNoDaemonContact();
    });
  },
);
