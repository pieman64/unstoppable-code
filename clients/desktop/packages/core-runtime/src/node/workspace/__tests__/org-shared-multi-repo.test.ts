import {
  mkdtemp,
  realpath,
  readFile,
  readdir,
  rm,
  writeFile,
  rename,
  symlink,
} from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { CanopyCallerDescriptor } from '@canopy/protocol/canopy-core';
import type {
  CreateSharedMultiRepoParams,
  OrgProjectSummary,
  SharedMultiRepoCreationStatus,
} from '@canopy/protocol/org-projects';
import {
  createSharedMultiRepoCoordinator,
  SharedMultiRepoSelectionError,
  type SharedMultiRepoPorts,
} from '../org-shared-multi-repo';
import { createSharedMultiRepoJournalStore } from '../shared-multi-repo-journal';

const org = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const device = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const project = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const caller: CanopyCallerDescriptor = {
  principalId: 'local-desktop-user',
  authorityId: 'local-desktop',
  clientInstanceId: 'test',
  interfaceKind: 'desktop',
  grants: ['core.workspace.read', 'core.workspace.write'],
};
const params: CreateSharedMultiRepoParams = {
  mode: 'convert',
  selections: [{ kind: 'workspace', id: 'source' }],
  request: {
    organizationId: org,
    creationKey: 'key',
    name: 'New',
    sourceProjects: [{ projectId: project, expectedRevision: 1 }],
  },
};
let root: string;
let ports: SharedMultiRepoPorts;
let service: ReturnType<typeof createSharedMultiRepoCoordinator>;
const created: OrgProjectSummary = {
  id: project,
  organizationId: org,
  name: 'New',
  description: null,
  kind: 'CODE',
  purpose: 'project',
  visibility: 'organization',
  memberOwned: false,
  location: 'LOCAL',
  repository: null,
  topology: 'multi-repo',
  state: 'ACTIVE',
  revision: 1,
  authorizationVersion: 1,
  defaultListed: true,
  preference: 'ADDED',
  listed: true,
  capabilities: { use: true, administer: true, manageCloud: false },
  instance: null,
};
async function settle(state: string): Promise<SharedMultiRepoCreationStatus> {
  for (let index = 0; index < 100; index++) {
    const current = await service.getCreation(caller, 'key');
    if (current?.state === state) return current;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`did not reach ${state}`);
}
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'shared-creation-')));
  ports = {
    identity: jest.fn(
      (): ReturnType<SharedMultiRepoPorts['identity']> =>
        Promise.resolve({ accountId: 'account', deviceId: device }),
    ),
    authorize: jest.fn((): Promise<void> => Promise.resolve()),
    inspect: jest.fn(
      (): ReturnType<SharedMultiRepoPorts['inspect']> =>
        Promise.resolve({
          organizationId: org,
          sourceProjects: params.request.sourceProjects,
          repositories: [],
          lockedProjectIds: [],
          suggestedName: 'New',
          canCreate: true,
        }),
    ),
    create: jest.fn(
      async (_caller, journal): ReturnType<SharedMultiRepoPorts['create']> => {
        const saved = await ports.journal.read('account', 'key');
        expect(saved?.params.request).toEqual(journal.params.request);
        return { creationKey: 'key', project: created };
      },
    ),
    setup: jest.fn(
      (): ReturnType<SharedMultiRepoPorts['setup']> =>
        Promise.resolve({ state: 'ready' }),
    ),
    refresh: jest.fn((): Promise<void> => Promise.resolve()),
    journal: createSharedMultiRepoJournalStore({
      rootDir: () => root,
      writeAtomic: async (path, content) => {
        await writeFile(path + '.tmp', content);
        await rename(path + '.tmp', path);
      },
    }),
    now: (): string => new Date().toISOString(),
    reportError: jest.fn(),
  };
  service = createSharedMultiRepoCoordinator(ports);
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

it('persists before POST, joins duplicate starts, and reads/listings never replay mutations', async () => {
  await Promise.all([
    service.create(caller, params),
    service.create(caller, params),
  ]);
  await settle('ready');
  expect(ports.create).toHaveBeenCalledTimes(1);
  expect(ports.setup).toHaveBeenCalledTimes(1);
  expect(await service.listCreations(caller)).toMatchObject([
    { creationKey: 'key', state: 'ready' },
  ]);
  await service.getCreation(caller, 'key');
  await expect(
    service.create(caller, {
      ...params,
      request: { ...params.request, name: 'Changed' },
    }),
  ).rejects.toThrow('immutable');
  expect(ports.create).toHaveBeenCalledTimes(1);
});
it('retries the same project while the failed run is finishing its refresh', async () => {
  let release: () => void = () => {};
  const refresh = new Promise<void>((resolve) => {
    release = resolve;
  });
  jest
    .mocked(ports.refresh)
    .mockResolvedValueOnce(undefined)
    .mockReturnValueOnce(refresh);
  jest.mocked(ports.setup).mockResolvedValueOnce({ state: 'setup-failed' });
  await service.create(caller, params);
  await settle('setup-failed');
  const retry = service.create(caller, params);
  // Let acceptance observe the terminal journal while the old run is active.
  await new Promise((resolve) => setTimeout(resolve, 20));
  release();
  await retry;
  await settle('ready');
  expect(ports.create).toHaveBeenCalledTimes(1);
  expect(ports.setup).toHaveBeenCalledTimes(2);
});
it('recovers an uncertain request after restart with the identical key and body', async () => {
  ports.create = jest.fn(
    (): ReturnType<SharedMultiRepoPorts['create']> =>
      Promise.reject(new Error('response lost')),
  );
  await service.create(caller, params);
  await settle('create-unconfirmed');
  service = createSharedMultiRepoCoordinator(ports);
  expect(await service.listCreations(caller)).toMatchObject([
    { state: 'create-unconfirmed' },
  ]);
  expect(ports.create).toHaveBeenCalledTimes(1);
  ports.create = jest.fn(
    (_caller, journal): ReturnType<SharedMultiRepoPorts['create']> =>
      Promise.resolve({
        creationKey: journal.params.request.creationKey,
        project: created,
      }),
  );
  await service.create(caller, params);
  await settle('ready');
  expect(ports.create).toHaveBeenCalledTimes(1);
});
it('resumes a saved attempt by key after the observer loses its request without inspecting a new selection', async () => {
  ports.create = jest.fn(() => Promise.reject(new Error('response lost')));
  await service.create(caller, params);
  await settle('create-unconfirmed');
  service = createSharedMultiRepoCoordinator(ports);
  ports.create = jest.fn(
    (_caller, journal): ReturnType<SharedMultiRepoPorts['create']> =>
      Promise.resolve({
        creationKey: journal.params.request.creationKey,
        project: created,
      }),
  );
  jest.mocked(ports.inspect).mockClear();
  await service.create(caller, { creationKey: 'key' });
  await settle('ready');
  expect(ports.inspect).not.toHaveBeenCalled();
  expect(jest.mocked(ports.create).mock.calls[0]?.[1].params.request).toEqual({
    ...params.request,
    privateMemory: false,
  });
});
it('returns a durable definitive rejection when preparation changed before acceptance', async () => {
  jest.mocked(ports.inspect).mockResolvedValue({
    organizationId: org,
    sourceProjects: [{ projectId: project, expectedRevision: 2 }],
    repositories: [],
    lockedProjectIds: [],
    suggestedName: 'New',
    canCreate: true,
  });
  await expect(service.create(caller, params)).resolves.toMatchObject({
    state: 'rejected',
    errorCode: 'stale_selection',
  });
  expect(await service.getCreation(caller, 'key')).toMatchObject({
    state: 'rejected',
  });
  expect(ports.create).not.toHaveBeenCalled();
});
it('records a typed source refusal without sending POST, while transport failures stay ambiguous', async () => {
  jest
    .mocked(ports.inspect)
    .mockRejectedValueOnce(
      new SharedMultiRepoSelectionError(
        'stale_selection',
        'Source unavailable',
      ),
    );
  expect(await service.create(caller, params)).toMatchObject({
    state: 'rejected',
    errorCode: 'stale_selection',
  });
  expect(ports.create).not.toHaveBeenCalled();
  jest
    .mocked(ports.inspect)
    .mockRejectedValueOnce(new Error('Catalog offline'));
  await expect(
    service.create(caller, {
      ...params,
      request: { ...params.request, creationKey: 'other' },
    }),
  ).rejects.toThrow('Catalog offline');
  expect(await service.getCreation(caller, 'other')).toBeNull();
});
it('never allocates a request when a resume key is unknown', async () => {
  await expect(
    service.create(caller, { creationKey: 'missing' }),
  ).rejects.toThrow();
  expect(await service.listCreations(caller)).toEqual([]);
  expect(ports.create).not.toHaveBeenCalled();
});
it.each([
  { status: 408 },
  { status: 429 },
  { status: 503 },
  { status: 409, isValidatedServerError: false },
])(
  'keeps transient or unvalidated creation failures uncertain (%j)',
  async (detail) => {
    ports.create = jest.fn(() =>
      Promise.reject(
        Object.assign(new Error('Request was not confirmed'), detail),
      ),
    );
    await service.create(caller, params);
    await settle('create-unconfirmed');
    await expect(
      service.create(caller, {
        ...params,
        request: { ...params.request, creationKey: 'replacement' },
      }),
    ).rejects.toThrow('unconfirmed request');
    expect(ports.create).toHaveBeenCalledTimes(1);
  },
);
it('serializes different keys and refuses an edited replacement while creation is unconfirmed', async () => {
  ports.create = jest.fn(
    (): ReturnType<SharedMultiRepoPorts['create']> =>
      Promise.reject(new Error('response lost')),
  );
  const replacement: CreateSharedMultiRepoParams = {
    ...params,
    mode: 'combine',
    request: {
      ...params.request,
      creationKey: 'replacement',
      name: 'Edited name',
    },
  };
  const outcomes = await Promise.allSettled([
    service.create(caller, params),
    service.create(caller, replacement),
  ]);
  expect(outcomes.map((outcome) => outcome.status)).toEqual([
    'fulfilled',
    'rejected',
  ]);
  await settle('create-unconfirmed');
  await expect(service.create(caller, replacement)).rejects.toThrow(
    'original creation key',
  );
  expect(ports.create).toHaveBeenCalledTimes(1);
});
it.each([
  { status: 409, serverCode: 'stale_selection', state: 'rejected' },
  { status: 409, serverCode: 'creation_retired', state: 'retired' },
  { status: 403, serverCode: 'forbidden', state: 'access-blocked' },
])(
  'preserves authoritative hosted refusals ($serverCode)',
  async ({ state, ...detail }) => {
    ports.create = jest.fn(() =>
      Promise.reject(
        Object.assign(new Error('Hosted refusal'), {
          ...detail,
          isValidatedServerError: true,
        }),
      ),
    );
    await service.create(caller, params);
    expect(await settle(state)).toMatchObject({
      state,
      errorCode: detail.serverCode,
    });
    expect(ports.setup).not.toHaveBeenCalled();
  },
);
it('never sends POST when durable acceptance fails', async () => {
  ports.journal.write = (): Promise<void> =>
    Promise.reject(new Error('disk full'));
  await expect(service.create(caller, params)).rejects.toThrow('disk full');
  expect(ports.create).not.toHaveBeenCalled();
});
it('retries setup of the committed definition without another POST', async () => {
  ports.setup = jest.fn(
    (): ReturnType<SharedMultiRepoPorts['setup']> =>
      Promise.resolve({
        state: 'completion-pending' as const,
        errorCode: 'completion-pending',
      }),
  );
  await service.create(caller, params);
  await settle('completion-pending');
  ports.setup = jest.fn(
    (): ReturnType<SharedMultiRepoPorts['setup']> =>
      Promise.resolve({ state: 'ready' as const }),
  );
  service = createSharedMultiRepoCoordinator(ports);
  await service.create(caller, params);
  await settle('ready');
  expect(ports.create).toHaveBeenCalledTimes(1);
});
it('isolates accounts and refuses a changed device rather than replacing its attempt', async () => {
  await service.create(caller, params);
  await settle('ready');
  ports.identity = (): ReturnType<SharedMultiRepoPorts['identity']> =>
    Promise.resolve({
      accountId: 'another-account',
      deviceId: device,
    });
  expect(await service.getCreation(caller, 'key')).toBeNull();
  expect(await service.listCreations(caller)).toEqual([]);
  ports.identity = (): ReturnType<SharedMultiRepoPorts['identity']> =>
    Promise.resolve({ accountId: 'account', deviceId: org });
  await expect(service.create(caller, params)).rejects.toThrow(
    'another desktop',
  );
  expect(ports.create).toHaveBeenCalledTimes(1);
});
it('quarantines unknown/corrupt journal versions without allocating replacement work', async () => {
  await service.create(caller, params);
  await settle('ready');
  const [accountDir] = await readdir(root);
  if (!accountDir) throw new Error('missing account');
  const [name] = await readdir(join(root, accountDir));
  if (!name) throw new Error('missing journal');
  const path = join(root, accountDir, name);
  const record: unknown = JSON.parse(await readFile(path, 'utf8'));
  if (typeof record !== 'object' || record === null)
    throw new Error('invalid fixture');
  await writeFile(path, JSON.stringify({ ...record, version: 99 }));
  await expect(service.listCreations(caller)).rejects.toThrow(
    'Unknown or corrupt',
  );
  await expect(
    service.create(caller, {
      ...params,
      request: { ...params.request, creationKey: 'new-key' },
    }),
  ).rejects.toThrow('Unknown or corrupt');
  expect(ports.create).toHaveBeenCalledTimes(1);
});

it('uses a trusted aliased data root without treating it as a changed account directory', async () => {
  const alias = root + '-alias';
  await symlink(root, alias, 'dir');
  ports.journal = createSharedMultiRepoJournalStore({
    rootDir: () => alias,
    writeAtomic: async (path, content) => {
      await writeFile(path + '.tmp', content);
      await rename(path + '.tmp', path);
    },
  });
  service = createSharedMultiRepoCoordinator(ports);
  try {
    await service.create(caller, params);
    expect(await settle('ready')).toMatchObject({ projectId: project });
    expect(await service.listCreations(caller)).toHaveLength(1);
  } finally {
    await rm(alias);
  }
});

it('refuses an account directory replaced by a symlink during discovery', async () => {
  await service.create(caller, params);
  await settle('ready');
  const [accountDirectory] = await readdir(root);
  if (!accountDirectory) throw new Error('missing account directory');
  const original = join(root, accountDirectory);
  const moved = join(root, 'moved-account');
  await rename(original, moved);
  await symlink(moved, original, 'dir');
  await expect(service.listCreations(caller)).rejects.toThrow(
    'Shared creation journal directory changed',
  );
  expect(ports.create).toHaveBeenCalledTimes(1);
});
