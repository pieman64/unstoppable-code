import { createFakeClient } from '../../__tests__/fake-org-projects-client';
import {
  CLIENT_STORE_ACTIVATE,
  CLIENT_STORE_DISPOSE,
} from '../../client-store-lifecycle';
import type { SharedMultiRepoClient } from '@canopy/app-core/client';
import type {
  CreateSharedMultiRepoParams,
  PreparedSharedMultiRepo,
  SharedMultiRepoCreationStatus,
} from '@canopy/protocol/org-projects';
import {
  createSharedMultiRepoStore,
  createSharedMultiRepoSessions,
} from '../create-shared-multi-repo-store';

const preview: PreparedSharedMultiRepo = {
  organizationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  sourceProjects: [
    { projectId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', expectedRevision: 2 },
  ],
  repositories: [
    {
      provider: 'github',
      host: 'github.com',
      owner: 'org',
      name: 'one',
      providerRepoId: '1',
      defaultBranch: 'main',
      verification: 'VERIFIED',
    },
  ],
  lockedProjectIds: [],
  suggestedName: 'One + repositories',
  canCreate: true,
};
const status: SharedMultiRepoCreationStatus = {
  creationKey: 'same-key',
  organizationId: preview.organizationId,
  deviceId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  state: 'create-unconfirmed',
  updatedAt: '2026-10-26T19:00:00.000Z',
};
const selection = {
  mode: 'convert' as const,
  selections: [{ kind: 'workspace' as const, id: 'source' }],
};
function harness(): {
  client: SharedMultiRepoClient;
  create: jest.Mock<
    Promise<SharedMultiRepoCreationStatus>,
    [CreateSharedMultiRepoParams]
  >;
  prepare: jest.Mock;
  read: jest.Mock;
  list: jest.Mock;
  store: ReturnType<typeof createSharedMultiRepoStore>;
} {
  const create = jest
    .fn<Promise<SharedMultiRepoCreationStatus>, [CreateSharedMultiRepoParams]>()
    .mockResolvedValue(status);
  const prepare = jest.fn().mockResolvedValue(preview);
  const read = jest.fn().mockResolvedValue(status);
  const list = jest.fn().mockResolvedValue([status]);
  const client: SharedMultiRepoClient = {
    create,
    prepare,
    getCreation: read,
    listCreations: list,
    catalog: jest.fn(),
    cancelSetup: jest.fn(),
  };
  return {
    client,
    create,
    prepare,
    read,
    list,
    store: createSharedMultiRepoStore(client, () => 'same-key'),
  };
}

test('preparation and draft cancellation are read-only', async () => {
  const { store, create } = harness();
  await store.getState().discover();
  await store.getState().prepare(selection);
  expect(store.getState().name).toBe(preview.suggestedName);
  expect(create).not.toHaveBeenCalled();
});
test('double submission joins once and an uncertain retry retains every submitted field', async () => {
  const { store, create } = harness();
  await store.getState().discover();
  await store.getState().prepare(selection);
  let reject: (error: Error) => void = () => {};
  create.mockImplementationOnce(
    () =>
      new Promise((_resolve, fail) => {
        reject = fail;
      }),
  );
  const first = store.getState().submit();
  await store.getState().submit();
  store.getState().setName('Changed after submission');
  await store.getState().prepare({
    ...selection,
    selections: [{ kind: 'workspace', id: 'other' }],
  });
  reject(new Error('lost response'));
  await first;
  expect(create).toHaveBeenCalledTimes(1);
  await store.getState().submit();
  expect(create).toHaveBeenCalledTimes(2);
  expect(create.mock.calls[1][0]).toEqual(create.mock.calls[0][0]);
  expect(create.mock.calls[1][0].request.name).toBe(preview.suggestedName);
});
test('polling and recovery discovery cannot create a project or start setup', async () => {
  const { store, create, read, list } = harness();
  await store.getState().discover();
  store.getState().observe(status);
  await store.getState().refresh();
  await store.getState().submit();
  expect(list).toHaveBeenCalledTimes(1);
  expect(read).toHaveBeenCalledWith('same-key');
  expect(create).not.toHaveBeenCalled();
});
test('stale preparation cannot overwrite the newest preview and a safe draft name survives refresh', async () => {
  const { store, prepare } = harness();
  let finish: (value: PreparedSharedMultiRepo) => void = () => {};
  prepare.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const first = store.getState().prepare(selection);
  store.getState().setName('My chosen name');
  await store.getState().prepare({
    mode: 'combine',
    selections: [{ kind: 'workspace', id: 'newer' }],
  });
  finish({ ...preview, suggestedName: 'stale', organizationId: 'old-org' });
  await first;
  expect(store.getState().preview?.organizationId).toBe(preview.organizationId);
  expect(store.getState().name).toBe('My chosen name');
});
test('permissions and normalized name bounds fail closed before mutation', async () => {
  const { store, prepare, create } = harness();
  prepare.mockResolvedValueOnce({ ...preview, canCreate: false });
  await store.getState().discover();
  await store.getState().prepare(selection);
  await store.getState().submit();
  expect(create).not.toHaveBeenCalled();
  await store.getState().discover();
  await store.getState().prepare(selection);
  store.getState().setName(' ');
  await store.getState().submit();
  expect(store.getState().error).toBe('Enter a project name.');
  expect(create).not.toHaveBeenCalled();
});
test('setup cancellation targets only the confirmed destination', async () => {
  const { store, client, create } = harness();
  await store.getState().cancelSetup();
  expect(client.cancelSetup).not.toHaveBeenCalled();
  store
    .getState()
    .observe({ ...status, projectId: 'new-project', state: 'setting-up' });
  await store.getState().cancelSetup();
  expect(client.cancelSetup).toHaveBeenCalledWith(
    preview.organizationId,
    'new-project',
  );
  expect(create).not.toHaveBeenCalled();
});

test('dialog reopen keeps the same attempt, while peer/account changes isolate it', async () => {
  const fake = createFakeClient();
  const { client } = harness();
  const registry = createSharedMultiRepoSessions(fake.client);
  registry[CLIENT_STORE_ACTIVATE]?.();
  const first = registry.getState().session(client, 'convert:source');
  await first.getState().prepare(selection);
  await first.getState().submit();
  expect(registry.getState().session(client, 'convert:source')).toBe(first);
  expect(registry.getState().session({ ...client }, 'convert:source')).not.toBe(
    first,
  );
  fake.emit('workspace-context.changed', {
    occurredAt: '2026-10-26T19:00:00.000Z',
    reason: 'account-change',
    state: { context: { kind: 'personal' }, revision: 0, organizations: [] },
  });
  const next = registry.getState().session(client, 'convert:source');
  expect(next).not.toBe(first);
  expect(next.getState().submitted).toBeNull();
  registry[CLIENT_STORE_DISPOSE]?.();
  expect(fake.unsubscribed).toContain('workspace-context.changed');
});

test('a delayed status read cannot roll readiness back after a successful retry', async () => {
  const { store, create, read } = harness();
  await store.getState().discover();
  await store.getState().prepare(selection);
  await store.getState().submit();
  let finish: (value: SharedMultiRepoCreationStatus) => void = () => {};
  read.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const pending = store.getState().refresh();
  create.mockResolvedValueOnce({
    ...status,
    state: 'ready',
    updatedAt: '2026-10-26T19:01:00.000Z',
  });
  await store.getState().submit();
  finish(status);
  await pending;
  expect(store.getState().status?.state).toBe('ready');
});

test('failed attempt discovery cannot authorize another creation', async () => {
  const { store, list, create } = harness();
  list.mockRejectedValue(new Error('receipt projection unavailable'));
  await store.getState().prepare(selection);
  await store.getState().submit();
  expect(store.getState().recoveryChecked).toBe(false);
  expect(store.getState().recoveryError).toContain(
    'receipt projection unavailable',
  );
  expect(create).not.toHaveBeenCalled();
});
test('an explicit retry of discovered progress resumes only its saved key after UI state loss', async () => {
  const { client, store, create, prepare } = harness();
  const resume = jest
    .fn()
    .mockResolvedValue({ ...status, state: 'setting-up' });
  Object.assign(client, { resume });
  await store.getState().discover();
  store.getState().observe(status);
  expect(resume).not.toHaveBeenCalled();
  await store.getState().submit();
  expect(resume).toHaveBeenCalledWith(status.creationKey);
  expect(create).not.toHaveBeenCalled();
  expect(prepare).not.toHaveBeenCalled();
  expect(store.getState().submitted).toBeNull();
  expect(store.getState().status?.state).toBe('setting-up');
});
test('a recovered definitive rejection can refresh the current selection without reusing its request', async () => {
  const { store, create, prepare } = harness();
  await store.getState().prepare(selection);
  store
    .getState()
    .observe({ ...status, state: 'rejected', errorCode: 'stale_selection' });
  await store.getState().revise();
  expect(store.getState().status).toBeNull();
  expect(store.getState().submitted).toBeNull();
  expect(prepare).toHaveBeenCalledTimes(2);
  expect(create).not.toHaveBeenCalled();
});
