import { createW5BoundaryFixture } from '../../../lib/__tests__/fixtures/w5-boundary-fixture';
// The real commit-log worker and files, as the W5 metadata registration suite.
import { EventEmitter } from 'node:events';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type * as TsxWorkerThreads from '../../../ledger/__tests__/fixtures/tsx-worker-threads';
jest.mock('node:worker_threads', () =>
  jest
    .requireActual<
      typeof TsxWorkerThreads
    >('../../../ledger/__tests__/fixtures/tsx-worker-threads')
    .createTsxWorkerThreads(),
);
jest.mock('../../../observability', () => ({
  getObservabilityService: jest.fn(() => ({
    recordAppDiagnostic: jest.fn(),
    recordUsageMetricEvent: jest.fn(),
  })),
}));
jest.mock('../../../portal/portal-structural-sync', () => ({
  schedulePortalStructuralSync: jest.fn(),
}));
jest.mock('../../../portal/portal-event-bus', () => ({
  notifyPortalStructureChanged: jest.fn(),
}));
jest.mock('../../../lib/desktop-telemetry', () => ({
  recordWorkspaceCrudTelemetry: jest.fn(),
}));

import { RENDERER_RELAY_GRANTS } from '../../../ipc/canopy-core-relay';
import { W5CommitLogHost } from '../../../w5-commit-log/commit-log-host';
import {
  createW5CommitLogFileStore,
  __setDesktopW5FileStoreForTests,
} from '../../../lib/w5-commit-log-file-store';
import { nodeW5FileStore } from '../../../lib/w5-file-store';
import { __resetSidebarItemsStateForTests } from '../../../lib/sidebar-items';
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
 * DM-1(a) (W7a, CAN-5523/CAN-5548): the seven `core.workspace.*` metadata
 * commands are in the interface set, so the main window's renderer relay
 * reaches them with its own `core.workspace.write` grant, and their receipts
 * name the relay principal, never `desktop-host:*`. App Advisor's narrowed
 * surface reaches none of them.
 */

jest.setTimeout(60_000);

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

const METADATA_COMMANDS = [
  'core.workspace.update',
  'core.workspace.reorder',
  'core.workspace.scripts.update',
  'core.workspace.planDetection.update',
  'core.workspace.privateMemory.update',
  'core.workspace.repository.add',
  'core.workspace.repository.remove',
];

const MAIN = 1;
const ADVISOR = 2;

let dir: string;
let root: string;
let host: W5CommitLogHost;
let runtime: DesktopCanopyDispatcher;
let relay: RendererRelay;
let originalDataDir: string | undefined;

function eventFor(senderId: number): RendererRelayEvent {
  const sender = new FakeSender(senderId);
  return { sender, senderFrame: sender.mainFrame };
}

function images(): string[] {
  return ['index.json', 'a/workspace.json', 'b/workspace.json'].map((file) =>
    readFileSync(join(root, file), 'utf8'),
  );
}

beforeEach(() => {
  ({ dir, root } = createW5BoundaryFixture(() => [], ['b']));
  originalDataDir = process.env.CANOPY_DATA_DIR;
  process.env.CANOPY_DATA_DIR = join(dir, 'data');
  host = new W5CommitLogHost({
    dbPath: join(dir, 'data', 'w5', 'commit-log.sqlite'),
    root,
    workerEntry: join(__dirname, '../../../w5-commit-log/commit-log-worker.ts'),
  });
  __setDesktopW5FileStoreForTests(createW5CommitLogFileStore(() => host));
  __resetSidebarItemsStateForTests();
  runtime = createDesktopRuntime();
  const surfaces = new Map<number, RendererRelaySurface>([
    [ADVISOR, 'app-advisor'],
  ]);
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
  __setDesktopW5FileStoreForTests(nodeW5FileStore);
  await host.shutdown();
  if (originalDataDir === undefined) delete process.env.CANOPY_DATA_DIR;
  else process.env.CANOPY_DATA_DIR = originalDataDir;
  rmSync(dir, { recursive: true, force: true });
  jest.restoreAllMocks();
});

/** One request per command, on workspace `workspaceId`, keyed `key`. */
function requests(
  workspaceId: string,
  key: string,
): Array<{ kind: 'request'; method: string; params: Record<string, unknown> }> {
  const _meta = { idempotencyKey: key };
  const calls: Array<[string, Record<string, unknown>]> = [
    ['core.workspace.update', { workspaceId, patch: { pinned: true } }],
    [
      'core.workspace.reorder',
      {
        visibleWorkspaceIds: [workspaceId, 'b'],
        activeWorkspaceId: workspaceId,
        overWorkspaceId: 'b',
      },
    ],
    [
      'core.workspace.scripts.update',
      {
        workspaceId,
        change: { kind: 'merge-commands', commands: { dev: 'x' } },
      },
    ],
    [
      'core.workspace.planDetection.update',
      { workspaceId, planDetection: { disabledRuleIds: ['x'] } },
    ],
    [
      'core.workspace.privateMemory.update',
      { workspaceId, privateMemory: true },
    ],
    [
      'core.workspace.repository.add',
      {
        workspaceId,
        repository: {
          selection: { kind: 'local_picker_selection', selectionId: 's' },
        },
      },
    ],
    ['core.workspace.repository.remove', { workspaceId, repoId: 'r' }],
  ];
  return calls.map(([method, params]) => ({
    kind: 'request' as const,
    method,
    params: { ...params, _meta },
  }));
}

it('lets the main surface decide #3 under its own principal, and replays it', async () => {
  expect(RENDERER_RELAY_GRANTS).toContain('core.workspace.write');
  const commits = jest.spyOn(host, 'commit');
  const [update] = requests('a', 'relay-update');
  if (!update) throw new Error('Expected #3');
  const first = await relay.invoke(eventFor(MAIN), update);
  expect(first).toMatchObject({
    ok: true,
    value: { workspaceId: 'a', pinned: true },
  });
  const receipts = commits.mock.calls.flatMap(([call]) =>
    call.receipt ? [call.receipt] : [],
  );
  expect(receipts).toEqual([
    expect.objectContaining({
      caller: 'daemon:local-desktop-renderer:main:workspace-metadata',
      operation: 'core.workspace.update',
    }),
  ]);
  const index: unknown = JSON.parse(images()[0] ?? '{}');
  expect(index).toMatchObject({
    workspaces: [{ id: 'a', pinned: true }, { id: 'b' }],
  });
  const count = commits.mock.calls.length;
  await expect(relay.invoke(eventFor(MAIN), update)).resolves.toEqual(first);
  expect(commits).toHaveBeenCalledTimes(count);
});

it('lets the main surface reorder under its own principal', async () => {
  const commits = jest.spyOn(host, 'commit');
  const reorder = requests('a', 'relay-reorder')[1];
  if (!reorder) throw new Error('Expected #4');
  await expect(relay.invoke(eventFor(MAIN), reorder)).resolves.toEqual({
    ok: true,
    value: { acknowledged: true },
  });
  const receipt = commits.mock.calls.find(([call]) => call.receipt)?.[0]
    .receipt;
  expect(receipt?.caller).toBe(
    'daemon:local-desktop-renderer:main:workspace-reorder',
  );
  expect(
    commits.mock.calls.some(([call]) =>
      call.receipt?.caller.startsWith('desktop-host:'),
    ),
  ).toBe(false);
});

it('reaches every handler from the main surface (RR5 refuses an unknown workspace)', async () => {
  const reserves = jest.spyOn(host, 'reserve');
  const before = images();
  const replies = [];
  for (const request of requests('missing', 'relay-missing'))
    replies.push(await relay.invoke(eventFor(MAIN), request));
  // Six handlers address the workspace; #13 refuses before any read.
  expect(replies.map((reply) => !reply.ok && reply.error.code)).toEqual([
    'core.workspace.notFound',
    'core.workspace.notFound',
    'core.workspace.configurationUnavailable',
    'core.workspace.configurationUnavailable',
    'core.workspace.notFound',
    undefined,
    'core.workspace.notFound',
  ]);
  expect(replies[5]).toMatchObject({
    ok: false,
    error: { kind: 'capability_unavailable', retry: { kind: 'never' } },
  });
  expect(replies[5]).not.toMatchObject({
    error: { message: 'core.workspace.repository.add is not available here.' },
  });
  expect(reserves).not.toHaveBeenCalled();
  expect(images()).toEqual(before);
});

it('refuses the App Advisor surface for all seven before any handler runs', async () => {
  const reserves = jest.spyOn(host, 'reserve');
  const commits = jest.spyOn(host, 'commit');
  const lookups = jest.spyOn(host, 'lookupReceipt');
  const before = images();
  const advisorRequests = requests('a', 'advisor');
  expect(advisorRequests.map((request) => request.method)).toEqual(
    METADATA_COMMANDS,
  );
  for (const request of advisorRequests) {
    await expect(
      relay.invoke(eventFor(ADVISOR), request),
    ).resolves.toMatchObject({
      ok: false,
      error: {
        kind: 'capability_unavailable',
        message: `${request.method} is not available here.`,
      },
    });
  }
  expect(lookups).not.toHaveBeenCalled();
  expect(reserves).not.toHaveBeenCalled();
  expect(commits).not.toHaveBeenCalled();
  expect(images()).toEqual(before);
});
