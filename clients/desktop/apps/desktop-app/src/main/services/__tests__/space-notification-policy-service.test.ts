import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type * as AtomicFileModule from '../../lib/atomic-file';

const schedulePortalStructuralSync = jest.fn<void, []>();
jest.mock('../../portal/portal-structural-sync', () => ({
  schedulePortalStructuralSync: (): void => schedulePortalStructuralSync(),
}));
jest.mock('../../lib/sidebar-items', () => ({
  readAllSidebarItems: jest.fn(),
}));
jest.mock('../../lib/cowork-work-entries', () => ({
  listWorkEntryIds: jest.fn(),
}));
jest.mock('../../lib/paths', () => ({
  getSpaceNotificationPolicyDir: jest.fn(),
}));
jest.mock('../../canopy-cloud/oauth-login', () => ({
  getDesktopOAuthClientDeviceId: jest.fn(),
}));
jest.mock('../../lib/canopy-cloud-account-store', () => ({
  loadCanopyCloudAccount: jest.fn(),
  subscribeCanopyCloudAccountChanges: jest.fn(),
}));
/** When set, the next policy-file write that `when` matches waits for
 * `hold` before writing. */
const mockAtomicWriteGate: {
  hold: Promise<void> | null;
  when: (path: string, contents: string) => boolean;
  /** Called when the matched write reaches the gate, and once it lands. */
  reached: () => void;
  landed: () => void;
} = { hold: null, when: () => false, reached: () => {}, landed: () => {} };
jest.mock('../../lib/atomic-file', () => {
  const actual = jest.requireActual<typeof AtomicFileModule>(
    '../../lib/atomic-file',
  );
  return {
    ...actual,
    writeFileAtomically: async (
      ...args: Parameters<typeof actual.writeFileAtomically>
    ): Promise<void> => {
      const hold = mockAtomicWriteGate.hold;
      if (hold && mockAtomicWriteGate.when(String(args[0]), String(args[1]))) {
        mockAtomicWriteGate.hold = null;
        mockAtomicWriteGate.reached();
        await hold;
        await actual.writeFileAtomically(...args);
        mockAtomicWriteGate.landed();
        return;
      }
      await actual.writeFileAtomically(...args);
    },
  };
});
jest.mock('../../lib/main-process-logging', () => ({
  logMainProcessWarn: jest.fn(),
}));
jest.mock('../../canopy-cloud/client', () => {
  class CanopyCloudClientError extends Error {
    constructor(
      readonly code: string,
      message: string,
      readonly status?: number,
    ) {
      super(message);
    }
  }
  return { CanopyCloudClientError, requestCanopyCloudJson: jest.fn() };
});

import type { SpaceNotificationTransition } from '@canopy/protocol/space-notifications';
import type { CanopyCloudAccountEntry } from '../../lib/canopy-cloud-account-store';
import { CanopyCloudClientError } from '../../canopy-cloud/client';
import { isSpaceNotificationDeliverable } from '../../lib/space-notification-gate';
import { spaceNotificationSourceRef } from '../../lib/space-notification-ref';
import { listWorkEntryIds } from '../../lib/cowork-work-entries';
import { readAllSidebarItems } from '../../lib/sidebar-items';
import {
  SpaceNotificationPolicyService,
  listLocalNotificationSources,
  type SpaceNotificationPolicyServiceDeps,
} from '../space-notification-policy-service';

const SCOPE = { projectId: 'project-1', worktreeId: 'worktree-1' };
const SERVER_TIME = '2026-10-04T12:00:00.000Z';

function account(id: string): CanopyCloudAccountEntry {
  return {
    apiKey: 'key',
    capabilities: [],
    account: {
      id,
      name: 'Test',
      email: `${id}@example.test`,
      role: 'DEVELOPER',
    },
    createdAt: SERVER_TIME,
    updatedAt: SERVER_TIME,
  };
}

interface ServerSpace {
  spaceId: string;
  revision: number;
  override: 'all' | 'attention' | 'mute' | null;
  transitions: SpaceNotificationTransition[];
}

/** The server answers with the keyed references the desktop sent. */
function syncBody(
  spaces: Array<{ workspaceId: string; spaceId: string; policy: ServerSpace }>,
  writesEnabled = true,
): unknown {
  return {
    serverTime: SERVER_TIME,
    transitionsSince: '2026-10-03T12:00:00.000Z',
    writesEnabled,
    spaces: spaces.map(({ policy, ...source }) => ({
      ...spaceNotificationSourceRef('device-1', source),
      policy,
    })),
  };
}

const MUTED: ServerSpace = {
  spaceId: 'space-1',
  revision: 1,
  override: 'mute',
  transitions: [
    {
      revision: 1,
      effectiveAt: '2026-10-04T11:00:00.000Z',
      priorOverride: null,
      nextOverride: 'mute',
    },
  ],
};

let dir: string;
let accountListener: ((entry: CanopyCloudAccountEntry | null) => void) | null;
let request: jest.Mock<Promise<unknown>, [string, RequestInit | undefined]>;

function deps(
  overrides: Partial<SpaceNotificationPolicyServiceDeps> = {},
): SpaceNotificationPolicyServiceDeps {
  return {
    loadAccount: () => Promise.resolve(account('user-1')),
    subscribeAccount: (listener) => {
      accountListener = listener;
      return () => {
        accountListener = null;
      };
    },
    producerId: () => Promise.resolve('device-1'),
    listSources: () =>
      Promise.resolve({
        sources: [{ workspaceId: 'project-1', spaceId: 'worktree-1' }],
        complete: true,
      }),
    request: <T>(path: string, init?: RequestInit): Promise<T> =>
      request(path, init).then((value) => value as T),
    dir: () => dir,
    now: () => Date.parse(SERVER_TIME),
    ...overrides,
  };
}

async function settle(service: SpaceNotificationPolicyService): Promise<void> {
  await service.sync();
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'space-notifications-'));
  accountListener = null;
  request = jest.fn<Promise<unknown>, [string, RequestInit | undefined]>();
  schedulePortalStructuralSync.mockClear();
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true, maxRetries: 5 });
});

it('registers local spaces, gates delivery, and survives a restart offline', async () => {
  request.mockResolvedValue(
    syncBody([
      { workspaceId: 'project-1', spaceId: 'worktree-1', policy: MUTED },
    ]),
  );
  const service = new SpaceNotificationPolicyService(deps());
  await service.start();
  await settle(service);
  service.stop();

  expect(request).toHaveBeenCalledWith(
    '/api/v1/notification-spaces/producers/device-1',
    expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({
        spaces: [
          spaceNotificationSourceRef('device-1', {
            workspaceId: 'project-1',
            spaceId: 'worktree-1',
          }),
        ],
      }),
    }),
  );
  expect(service.getSnapshot().spaces).toEqual({
    'project-1\u001fworktree-1': {
      notificationSpaceId: 'space-1',
      revision: 1,
      override: 'mute',
      transitions: MUTED.transitions,
    },
  });
  expect(isSpaceNotificationDeliverable(SCOPE, 'attention')).toBe(false);
  expect(
    isSpaceNotificationDeliverable(
      { ...SCOPE, worktreeId: 'other' },
      'routine',
    ),
  ).toBe(true);
  expect(schedulePortalStructuralSync).toHaveBeenCalledTimes(1);

  // Restart with the server unreachable: the saved choice is still enforced.
  request.mockRejectedValue(new Error('offline'));
  const restarted = new SpaceNotificationPolicyService(deps());
  await restarted.start();
  await settle(restarted);
  restarted.stop();
  expect(restarted.getSnapshot().spaces['project-1\u001fworktree-1']).toEqual(
    expect.objectContaining({ override: 'mute' }),
  );
  expect(isSpaceNotificationDeliverable(SCOPE, 'failure')).toBe(false);
});

it('reports a listing as incomplete when one Cowork project cannot be read', async () => {
  const cowork = (id: string) =>
    ({
      type: 'cowork',
      id,
      name: id,
      color: '',
      collapsed: false,
      order: 0,
    }) as const;
  jest.mocked(readAllSidebarItems).mockResolvedValue({
    version: 1,
    items: [cowork('cowork-ok'), cowork('cowork-broken')],
  });
  jest
    .mocked(listWorkEntryIds)
    .mockImplementation((id: string) =>
      id === 'cowork-broken'
        ? Promise.reject(new Error('unreadable'))
        : Promise.resolve(['entry-1']),
    );
  await expect(listLocalNotificationSources()).resolves.toEqual({
    sources: [{ workspaceId: 'cowork-ok', spaceId: 'entry-1' }],
    complete: false,
  });
});

it('forgets spaces deleted locally after a full sync, but not on a failed listing', async () => {
  const OTHER = { workspaceId: 'project-1', spaceId: 'worktree-2' };
  const sources = [{ workspaceId: 'project-1', spaceId: 'worktree-1' }, OTHER];
  request.mockResolvedValue(
    syncBody([
      { workspaceId: 'project-1', spaceId: 'worktree-1', policy: MUTED },
      { ...OTHER, policy: { ...MUTED, spaceId: 'space-2' } },
    ]),
  );
  let complete = true;
  const service = new SpaceNotificationPolicyService(
    deps({ listSources: () => Promise.resolve({ sources, complete }) }),
  );
  await service.start();
  await settle(service);
  expect(Object.keys(service.getSnapshot().spaces)).toHaveLength(2);

  // Listing nothing is indistinguishable from a failed listing; keep both.
  sources.length = 0;
  await settle(service);
  expect(Object.keys(service.getSnapshot().spaces)).toHaveLength(2);

  // A partial listing (one project's spaces could not be read) still names
  // other spaces, but must not forget the unread project's saved choices.
  sources.push({ workspaceId: 'project-1', spaceId: 'worktree-1' });
  complete = false;
  await settle(service);
  expect(Object.keys(service.getSnapshot().spaces)).toHaveLength(2);
  complete = true;

  // worktree-2 was deleted locally.
  request.mockResolvedValue(
    syncBody([
      { workspaceId: 'project-1', spaceId: 'worktree-1', policy: MUTED },
    ]),
  );
  await settle(service);
  service.stop();
  expect(Object.keys(service.getSnapshot().spaces)).toEqual([
    'project-1\u001fworktree-1',
  ]);
  const restarted = new SpaceNotificationPolicyService(
    deps({
      listSources: () => Promise.resolve({ sources: [], complete: true }),
    }),
  );
  await restarted.start();
  await settle(restarted);
  restarted.stop();
  expect(Object.keys(restarted.getSnapshot().spaces)).toEqual([
    'project-1\u001fworktree-1',
  ]);
});

it('clears choices on sign-out and discards a response from the previous account', async () => {
  let resolveFirst: (value: unknown) => void = () => {};
  request.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        resolveFirst = resolve;
      }),
  );
  const service = new SpaceNotificationPolicyService(deps());
  await service.start();
  // The first account's sync is still in flight when the account changes.
  accountListener?.(account('user-2'));
  await new Promise((resolve) => setImmediate(resolve));
  resolveFirst(
    syncBody([
      { workspaceId: 'project-1', spaceId: 'worktree-1', policy: MUTED },
    ]),
  );
  request.mockResolvedValue(syncBody([]));
  await settle(service);
  expect(service.getSnapshot()).toMatchObject({
    accountKey: 'user-2',
    spaces: {},
  });
  accountListener?.(null);
  await new Promise((resolve) => setImmediate(resolve));
  expect(service.getSnapshot()).toMatchObject({ accountKey: null, spaces: {} });
  expect(isSpaceNotificationDeliverable(SCOPE, 'routine')).toBe(true);
  service.stop();
});

it('saves a choice, reports conflicts, and reconciles a lost response', async () => {
  const unset: ServerSpace = {
    spaceId: 'space-1',
    revision: 0,
    override: null,
    transitions: [],
  };
  request.mockResolvedValue(
    syncBody([
      { workspaceId: 'project-1', spaceId: 'worktree-1', policy: unset },
    ]),
  );
  const service = new SpaceNotificationPolicyService(deps());
  await service.start();
  await settle(service);

  request.mockResolvedValueOnce({ ...MUTED, writesEnabled: true });
  await expect(
    service.set({ ...SCOPE, override: 'mute', expectedRevision: 0 }),
  ).resolves.toMatchObject({ status: 'saved' });
  expect(request).toHaveBeenLastCalledWith(
    '/api/v1/notification-spaces/space-1',
    expect.objectContaining({
      method: 'PATCH',
      body: JSON.stringify({ expectedRevision: 0, override: 'mute' }),
    }),
  );

  // Another device changed it first: the authoritative choice is shown.
  const elsewhere: ServerSpace = { ...MUTED, revision: 2, override: 'all' };
  request
    .mockRejectedValueOnce(new CanopyCloudClientError('http', 'conflict', 409))
    .mockResolvedValueOnce(
      syncBody([
        { workspaceId: 'project-1', spaceId: 'worktree-1', policy: elsewhere },
      ]),
    );
  await expect(
    service.set({ ...SCOPE, override: null, expectedRevision: 1 }),
  ).resolves.toMatchObject({ status: 'conflict' });
  expect(service.getSnapshot().spaces['project-1\u001fworktree-1']).toEqual(
    expect.objectContaining({ revision: 2, override: 'all' }),
  );

  // A notification is being delivered for this space: try again shortly.
  request
    .mockRejectedValueOnce(new CanopyCloudClientError('http', 'busy', 423))
    .mockResolvedValueOnce(
      syncBody([
        { workspaceId: 'project-1', spaceId: 'worktree-1', policy: elsewhere },
      ]),
    );
  await expect(
    service.set({ ...SCOPE, override: null, expectedRevision: 2 }),
  ).resolves.toMatchObject({ status: 'busy' });

  // The write committed but the response was lost.
  const committed: ServerSpace = {
    ...MUTED,
    revision: 3,
    override: 'attention',
  };
  request
    .mockRejectedValueOnce(new Error('socket hang up'))
    .mockResolvedValueOnce(
      syncBody([
        { workspaceId: 'project-1', spaceId: 'worktree-1', policy: committed },
      ]),
    );
  await expect(
    service.set({ ...SCOPE, override: 'attention', expectedRevision: 2 }),
  ).resolves.toMatchObject({ status: 'saved' });
  service.stop();
});

it('treats an All activity save as clearing the override', async () => {
  request.mockResolvedValue(
    syncBody([
      { workspaceId: 'project-1', spaceId: 'worktree-1', policy: MUTED },
    ]),
  );
  const service = new SpaceNotificationPolicyService(deps());
  await service.start();
  await settle(service);
  // The server stores All activity as no override and returns `null`.
  request.mockResolvedValueOnce({
    ...MUTED,
    revision: 2,
    override: null,
    writesEnabled: true,
  });
  await expect(
    service.set({ ...SCOPE, override: 'all', expectedRevision: 1 }),
  ).resolves.toMatchObject({ status: 'saved' });
  expect(request).toHaveBeenLastCalledWith(
    '/api/v1/notification-spaces/space-1',
    expect.objectContaining({
      body: JSON.stringify({ expectedRevision: 1, override: null }),
    }),
  );
  service.stop();
});

it('persists the newest choice when an older policy-file write finishes last', async () => {
  const unset: ServerSpace = {
    spaceId: 'space-1',
    revision: 0,
    override: null,
    transitions: [],
  };
  request.mockResolvedValue(
    syncBody([
      { workspaceId: 'project-1', spaceId: 'worktree-1', policy: unset },
    ]),
  );
  const service = new SpaceNotificationPolicyService(deps());
  await service.start();
  await settle(service);

  // The Mute save's write stalls; the later reset's write runs meanwhile.
  let release: () => void = () => {};
  mockAtomicWriteGate.hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  // Only this test's Mute write; earlier tests' writes may still land.
  const testDir = dir;
  mockAtomicWriteGate.when = (path, contents): boolean =>
    path.startsWith(testDir) && contents.includes('"override":"mute"');
  const reached = new Promise<void>((resolve) => {
    mockAtomicWriteGate.reached = resolve;
  });
  const landed = new Promise<void>((resolve) => {
    mockAtomicWriteGate.landed = resolve;
  });
  request.mockResolvedValueOnce({ ...MUTED, writesEnabled: true });
  await service.set({ ...SCOPE, override: 'mute', expectedRevision: 0 });
  // The Mute write has captured its snapshot and is stalled.
  await reached;
  request.mockResolvedValueOnce({
    ...MUTED,
    revision: 2,
    override: null,
    writesEnabled: true,
  });
  await service.set({ ...SCOPE, override: null, expectedRevision: 1 });
  // Let the reset's write run (or queue) before the stalled Mute write lands.
  await new Promise((resolve) => setTimeout(resolve, 50));
  release();
  await landed;
  // Any write queued behind the Mute write runs next.
  await new Promise((resolve) => setTimeout(resolve, 50));
  service.stop();

  // Restart offline: the newest choice (no override) is what was kept.
  request.mockRejectedValue(new Error('offline'));
  const restarted = new SpaceNotificationPolicyService(deps());
  await restarted.start();
  await settle(restarted);
  restarted.stop();
  expect(restarted.getSnapshot().spaces['project-1\u001fworktree-1']).toEqual(
    expect.objectContaining({ revision: 2, override: null }),
  );
});

it('never rolls a space back to an older revision and reports disabled writes', async () => {
  request.mockResolvedValueOnce(
    syncBody([
      {
        workspaceId: 'project-1',
        spaceId: 'worktree-1',
        policy: { ...MUTED, revision: 4 },
      },
    ]),
  );
  const service = new SpaceNotificationPolicyService(deps());
  await service.start();
  await settle(service);
  request.mockResolvedValueOnce(
    syncBody(
      [
        {
          workspaceId: 'project-1',
          spaceId: 'worktree-1',
          policy: { ...MUTED, revision: 3, override: null },
        },
      ],
      false,
    ),
  );
  await service.refresh(SCOPE);
  expect(service.getSnapshot().spaces['project-1\u001fworktree-1']).toEqual(
    expect.objectContaining({ revision: 4, override: 'mute' }),
  );
  await expect(
    service.set({ ...SCOPE, override: null, expectedRevision: 4 }),
  ).resolves.toMatchObject({ status: 'disabled' });
  // A recreated space (new id, revision 0) always replaces the old entry.
  request.mockResolvedValueOnce(
    syncBody([
      {
        workspaceId: 'project-1',
        spaceId: 'worktree-1',
        policy: { ...MUTED, spaceId: 'space-2', revision: 0, override: null },
      },
    ]),
  );
  await service.refresh(SCOPE);
  expect(service.getSnapshot().spaces['project-1\u001fworktree-1']).toEqual(
    expect.objectContaining({ notificationSpaceId: 'space-2', revision: 0 }),
  );
  service.stop();
});

it('treats signed-out and guest sessions as having no saved choices', async () => {
  const service = new SpaceNotificationPolicyService(
    deps({
      loadAccount: () =>
        Promise.resolve({ ...account('guest'), authMode: 'guest' }),
    }),
  );
  await service.start();
  expect(service.getSnapshot().accountKey).toBeNull();
  await expect(
    service.set({ ...SCOPE, override: 'mute', expectedRevision: 0 }),
  ).resolves.toMatchObject({ status: 'unavailable' });
  expect(request).not.toHaveBeenCalled();
  service.stop();
});
