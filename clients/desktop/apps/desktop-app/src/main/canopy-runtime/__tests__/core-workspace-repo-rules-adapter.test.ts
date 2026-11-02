import type { IpcMainInvokeEvent } from 'electron';
import type { CanopyCallerDescriptor } from '@canopy/protocol/canopy-core';
import { IPC_CHANNELS } from '@canopy/desktop-shared/types';
import type {
  CoreWorkspaceRepoRulesBinding,
  CoreWorkspaceRepoRulesHost,
} from '@canopy/core-runtime/node/workspace/workspace-repo-rules';
import {
  RepoRulesPolicy,
  type RepoRuleCheckout,
  type RepoRulesPolicyRead,
  type RepoRulesRead,
} from '@canopy/core-runtime/node/workspace/repo-rules';
import {
  createDesktopRuntime,
  type DesktopCanopyDispatcher,
} from '../desktop-runtime';
import { desktopRepoRulesHost } from '../core-workspace-repo-rules-adapter';
import { registerRepoRulesHandlers } from '../../ipc/repo-rules';
import { repoRulesService } from '../../repo-rules/host';
import { repoRulesStoreErrorCode } from '../../repo-rules/state';

jest.mock('../../services/files-service', () => ({
  listFileTreeRoots: jest.fn(),
  listFileTreeDirectory: jest.fn(),
}));
const mockHandlers = new Map<
  string,
  (event: unknown, request: unknown) => Promise<unknown>
>();
jest.mock('../../ipc/register', () => ({
  registerIpcHandler: (
    channel: string,
    handler: (event: unknown, request: unknown) => Promise<unknown>,
  ): void => {
    mockHandlers.set(channel, handler);
  },
}));

function caller(
  overrides: Partial<CanopyCallerDescriptor> = {},
): CanopyCallerDescriptor {
  return {
    principalId: 'local-desktop-user',
    clientInstanceId: 'electron-web-contents:1',
    authorityId: 'local-desktop',
    interfaceKind: 'desktop',
    grants: [
      'worker.filesystem.read',
      'core.workspace.read',
      'core.chat.read',
      'core.chat.write',
      'core.worktree.read',
    ],
    ...overrides,
  };
}

function emptyPolicy(): RepoRulesPolicyRead {
  return {
    version: 1,
    enabled: false,
    revision: 0,
    disabledRuleIds: [],
    reviewed: {},
    nestedDirectories: {},
  };
}

interface FakeHost {
  host: CoreWorkspaceRepoRulesHost;
  status: jest.Mock<Promise<RepoRulesPolicyRead>, [string]>;
  apply: jest.Mock<Promise<RepoRulesPolicyRead>, [string, unknown]>;
}

function fakeHost(): FakeHost {
  const empty = (): Promise<RepoRulesRead> =>
    Promise.resolve({ rules: [], skipped: [], nestedDirectories: {} });
  const read = jest.fn<Promise<RepoRulesPolicyRead>, [string]>(() =>
    Promise.resolve(emptyPolicy()),
  );
  const update = jest.fn<Promise<RepoRulesPolicyRead>, [string, unknown]>();
  const policy = new RepoRulesPolicy({
    store: {
      read: (workspaceId): Promise<RepoRulesPolicyRead> => read(workspaceId),
      update: (workspaceId, operation): Promise<RepoRulesPolicyRead> =>
        update(workspaceId, operation),
    },
    resolve: (): Promise<RepoRuleCheckout[]> => Promise.resolve([]),
    worker: { scan: empty, readSession: empty },
  });
  return {
    host: {
      load: (): Promise<CoreWorkspaceRepoRulesBinding> =>
        Promise.resolve({ policy }),
    },
    status: read,
    apply: update,
  };
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('Expected a rejection.');
}

let runtime: DesktopCanopyDispatcher | undefined;
afterEach(async () => {
  await runtime?.shutdown();
  runtime = undefined;
});

describe('core.workspace.repoRules on the desktop dispatcher', () => {
  it('binds the policy that session composition uses and the store writer codes', async () => {
    const binding = await desktopRepoRulesHost.load();
    expect(binding.policy).toBe(repoRulesService);
    expect(binding.errorCode).toBe(repoRulesStoreErrorCode);
  });

  it('serves the family in process and holds the interface grants to reads', async () => {
    const fake = fakeHost();
    runtime = createDesktopRuntime({ repoRulesHost: fake.host });
    await expect(
      runtime.query(
        'core.workspace.repoRules.status',
        { workspaceId: 'ws-1' },
        { caller: caller() },
      ),
    ).resolves.toEqual({ enabled: false, disabledRuleIds: [], revision: 0 });
    // The desktop interface grants carry no write; the IPC projection grants
    // core.workspace.write per apply call.
    await expect(
      runtime.instruction(
        'core.workspace.repoRules.apply',
        { workspaceId: 'ws-1', enabled: false },
        { caller: caller() },
      ),
    ).rejects.toMatchObject({ payload: { kind: 'permission_denied' } });
    expect(fake.apply).not.toHaveBeenCalled();
  });

  it.each([
    ['a remote device', { principalId: 'remote-device:controller-1' }],
    [
      'a renderer relay surface',
      { principalId: 'local-desktop-renderer:main' },
    ],
    ['a Portal session', { interfaceKind: 'portal' as const }],
  ])('refuses %s holding every grant', async (_name, overrides) => {
    const fake = fakeHost();
    runtime = createDesktopRuntime({ repoRulesHost: fake.host });
    const options = {
      caller: caller({
        ...overrides,
        grants: ['core.workspace.read', 'core.workspace.write'],
      }),
    };
    for (const call of [
      runtime.query(
        'core.workspace.repoRules.status',
        { workspaceId: 'ws-1' },
        options,
      ),
      runtime.instruction(
        'core.workspace.repoRules.apply',
        { workspaceId: 'ws-1', enabled: false },
        options,
      ),
    ])
      await expect(call).rejects.toMatchObject({
        payload: {
          kind: 'permission_denied',
          code: 'core.workspace.repoRules.localOnly',
        },
      });
    expect(fake.status).not.toHaveBeenCalled();
    expect(fake.apply).not.toHaveBeenCalled();
  });

  it('refuses apply while shutdown waits for an in-flight call', async () => {
    // Accepted change: once shutdown starts, an apply racing app quit fails
    // as unavailable instead of writing; calls already admitted complete.
    const fake = fakeHost();
    const draining = createDesktopRuntime({ repoRulesHost: fake.host });
    let release: () => void = () => undefined;
    fake.status.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = (): void => resolve(emptyPolicy());
        }),
    );
    const inFlight = draining.query(
      'core.workspace.repoRules.status',
      { workspaceId: 'ws-1' },
      { caller: caller() },
    );
    for (let turn = 0; turn < 20 && !fake.status.mock.calls.length; turn += 1)
      await new Promise((resolve) => setImmediate(resolve));
    expect(fake.status).toHaveBeenCalledTimes(1);
    const stopping = draining.shutdown();
    for (let turn = 0; turn < 20 && draining.state === 'accepting'; turn += 1)
      await new Promise((resolve) => setImmediate(resolve));
    expect(draining.state).not.toBe('accepting');
    await expect(
      draining.instruction(
        'core.workspace.repoRules.apply',
        { workspaceId: 'ws-1', enabled: false },
        { caller: caller({ grants: ['core.workspace.write'] }) },
      ),
    ).rejects.toMatchObject({ payload: { kind: 'unavailable' } });
    release();
    await expect(inFlight).resolves.toMatchObject({ enabled: false });
    await stopping;
    expect(fake.apply).not.toHaveBeenCalled();
  });

  it('refuses apply once dispatcher shutdown starts', async () => {
    // Accepted change: an apply racing app quit fails as unavailable instead
    // of writing, and the IPC projection surfaces that error.
    const fake = fakeHost();
    const stopped = createDesktopRuntime({ repoRulesHost: fake.host });
    await stopped.shutdown();
    registerRepoRulesHandlers(stopped, () => caller());
    const handler = mockHandlers.get(IPC_CHANNELS.repoRulesApply);
    if (!handler) throw new Error('repo-rules:apply was not registered');
    const event: Partial<IpcMainInvokeEvent> = {};
    // Authorization reads fail first once the runtime has closed.
    expect(
      await rejection(handler(event, { workspaceId: 'ws-1', enabled: false })),
    ).toMatchObject({ payload: { kind: 'unavailable' } });
    await expect(
      stopped.instruction(
        'core.workspace.repoRules.apply',
        { workspaceId: 'ws-1', enabled: false },
        { caller: caller({ grants: ['core.workspace.write'] }) },
      ),
    ).rejects.toMatchObject({ payload: { kind: 'unavailable' } });
    expect(fake.apply).not.toHaveBeenCalled();
  });
});
