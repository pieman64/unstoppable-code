/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/unbound-method */
import type {
  ClaimOrgProjectInstanceRequest,
  ClaimOrgProjectInstanceResponse,
  CompleteOrgProjectInstanceRequest,
  EnsureOrgDefaultChatsResponse,
} from '@canopy/protocol/org-projects';
import type { WorkspaceOwnerBinding } from '@canopy/desktop-shared/types';
import {
  createOrgCoworkBinding,
  type OrgCoworkBindingDeps,
} from '../lib/org-cowork-binding';

const organizationId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const projectId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const instanceId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function fixture(overrides: Partial<OrgCoworkBindingDeps> = {}): {
  binding: ReturnType<typeof createOrgCoworkBinding>;
  deps: OrgCoworkBindingDeps;
  createLocal: jest.Mock<Promise<void>, [WorkspaceOwnerBinding]>;
  publishLocal: jest.Mock<Promise<void>, [WorkspaceOwnerBinding]>;
} {
  const claim: ClaimOrgProjectInstanceResponse = {
    instanceId,
    operationId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    fencingGeneration: 4,
    state: 'CLAIMED',
  };
  const deps: OrgCoworkBindingDeps = {
    cloud: {
      ensureDefaultChats: jest.fn<
        Promise<EnsureOrgDefaultChatsResponse>,
        [string]
      >(() =>
        Promise.resolve({ id: projectId } as EnsureOrgDefaultChatsResponse),
      ),
      claim: jest.fn<
        Promise<ClaimOrgProjectInstanceResponse>,
        [string, ClaimOrgProjectInstanceRequest]
      >(() => Promise.resolve(claim)),
      complete: jest.fn<
        Promise<void>,
        [string, CompleteOrgProjectInstanceRequest]
      >(() => Promise.resolve()),
    },
    readOwnership: jest.fn(() => Promise.resolve({ authority: 'absent' })),
    resolveDeviceId: jest.fn(() => Promise.resolve('device-1')),
    readInstallationGeneration: jest.fn(() => Promise.resolve(3)),
    isClaimConflict: jest.fn(() => false),
    ...overrides,
  };
  const createLocal = jest.fn<Promise<void>, [WorkspaceOwnerBinding]>(() =>
    Promise.resolve(),
  );
  const publishLocal = jest.fn<Promise<void>, [WorkspaceOwnerBinding]>(() =>
    Promise.resolve(),
  );
  return {
    binding: createOrgCoworkBinding(deps),
    deps,
    createLocal,
    publishLocal,
  };
}

describe('createOrgCoworkBinding', () => {
  it('binds any local Cowork id with the real owner and completes ready', async () => {
    const { binding, deps, createLocal, publishLocal } = fixture();

    await binding.bindOrgCoworkWorkspace({
      organizationId,
      projectId,
      localWorkspaceId: 'team-notes',
      createLocal,
      publishLocal,
    });

    expect(deps.cloud.claim).toHaveBeenCalledWith(
      projectId,
      expect.objectContaining({
        deviceId: 'device-1',
        installationGeneration: 3,
        localWorkspaceId: 'team-notes',
        idempotencyKey: expect.stringMatching(/^[0-9a-f]{64}$/),
      }),
    );
    expect(createLocal).toHaveBeenCalledWith({
      type: 'organization',
      organizationId,
      projectId,
      instanceId,
      bindingGeneration: 4,
    });
    expect(deps.cloud.complete).toHaveBeenCalledWith(instanceId, {
      operationId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      fencingGeneration: 4,
      outcome: 'ready',
    });
    expect(
      jest.mocked(deps.cloud.complete).mock.invocationCallOrder[0],
    ).toBeLessThan(publishLocal.mock.invocationCallOrder[0] ?? 0);
  });

  it('serializes attempts for the same project', async () => {
    const gate = deferred<ClaimOrgProjectInstanceResponse>();
    const { binding, deps, createLocal, publishLocal } = fixture();
    jest.mocked(deps.cloud.claim).mockImplementationOnce(() => gate.promise);

    const first = binding.bindOrgCoworkWorkspace({
      organizationId,
      projectId,
      localWorkspaceId: 'team-notes',
      createLocal,
      publishLocal,
    });
    const second = binding.bindOrgCoworkWorkspace({
      organizationId,
      projectId,
      localWorkspaceId: 'team-notes',
      createLocal,
      publishLocal,
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(deps.cloud.claim).toHaveBeenCalledTimes(1);

    gate.resolve({
      instanceId,
      operationId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      fencingGeneration: 4,
      state: 'CLAIMED',
    });
    await Promise.all([first, second]);
    expect(deps.cloud.claim).toHaveBeenCalledTimes(2);
  });

  it('replays the stable claim after completion fails and skips duplicate local creation', async () => {
    const { binding, deps, createLocal, publishLocal } = fixture();
    jest
      .mocked(deps.cloud.complete)
      .mockRejectedValueOnce(new Error('offline'));
    jest
      .mocked(deps.readOwnership)
      .mockResolvedValueOnce({ authority: 'absent' })
      .mockResolvedValueOnce({
        authority: 'ok',
        type: 'cowork',
        owner: {
          type: 'organization',
          organizationId,
          projectId,
          instanceId,
          bindingGeneration: 4,
        },
      });

    await expect(
      binding.bindOrgCoworkWorkspace({
        organizationId,
        projectId,
        localWorkspaceId: 'team-notes',
        createLocal,
        publishLocal,
      }),
    ).rejects.toThrow('offline');
    await binding.bindOrgCoworkWorkspace({
      organizationId,
      projectId,
      localWorkspaceId: 'team-notes',
      createLocal,
      publishLocal,
    });

    const claims = jest.mocked(deps.cloud.claim).mock.calls;
    expect(claims[0]?.[1].idempotencyKey).toBe(claims[1]?.[1].idempotencyKey);
    expect(createLocal).toHaveBeenCalledTimes(1);
    expect(deps.cloud.complete).toHaveBeenCalledTimes(2);
    expect(publishLocal).toHaveBeenCalledTimes(1);
  });

  it('reconciles an existing same-project owner when the claim changes', async () => {
    const nextInstanceId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
    const { binding, deps, createLocal, publishLocal } = fixture({
      readOwnership: jest.fn(() =>
        Promise.resolve({
          authority: 'ok' as const,
          type: 'cowork' as const,
          owner: {
            type: 'organization' as const,
            organizationId,
            projectId,
            instanceId,
            bindingGeneration: 4,
          },
        }),
      ),
    });
    jest.mocked(deps.cloud.claim).mockResolvedValue({
      instanceId: nextInstanceId,
      operationId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
      fencingGeneration: 5,
      state: 'CLAIMED',
    });

    await binding.bindOrgCoworkWorkspace({
      organizationId,
      projectId,
      localWorkspaceId: 'team-notes',
      createLocal,
      publishLocal,
    });

    expect(createLocal).toHaveBeenCalledWith({
      type: 'organization',
      organizationId,
      projectId,
      instanceId: nextInstanceId,
      bindingGeneration: 5,
    });
    expect(createLocal.mock.invocationCallOrder[0]).toBeLessThan(
      jest.mocked(deps.cloud.complete).mock.invocationCallOrder[0] ?? 0,
    );
  });

  it('creates nothing locally when the cloud claim fails', async () => {
    const { binding, deps, createLocal, publishLocal } = fixture();
    jest.mocked(deps.cloud.claim).mockRejectedValue(new Error('offline'));

    await expect(
      binding.bindOrgCoworkWorkspace({
        organizationId,
        projectId,
        localWorkspaceId: 'team-notes',
        createLocal,
        publishLocal,
      }),
    ).rejects.toThrow('offline');
    expect(createLocal).not.toHaveBeenCalled();
    expect(deps.cloud.complete).not.toHaveBeenCalled();
    expect(publishLocal).not.toHaveBeenCalled();
  });

  it('rotates a member-project claim key once after a claim conflict', async () => {
    const conflict = new Error('conflict');
    const { binding, deps, createLocal, publishLocal } = fixture({
      isClaimConflict: jest.fn((error) => error === conflict),
    });
    jest
      .mocked(deps.cloud.claim)
      .mockRejectedValueOnce(conflict)
      .mockResolvedValueOnce({
        instanceId,
        operationId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
        fencingGeneration: 4,
        state: 'CLAIMED',
      });

    await binding.bindOrgCoworkWorkspace({
      organizationId,
      projectId,
      localWorkspaceId: 'team-notes',
      createLocal,
      publishLocal,
      rotateClaimKeyOnConflict: true,
    });

    const claims = jest.mocked(deps.cloud.claim).mock.calls;
    expect(claims).toHaveLength(2);
    expect(claims[1]?.[1].idempotencyKey).not.toBe(
      claims[0]?.[1].idempotencyKey,
    );
  });

  it('ensures and binds the deterministic organization default', async () => {
    const { binding, deps, createLocal, publishLocal } = fixture();

    await binding.ensureOrgDefaultCoworkWorkspace(
      organizationId,
      createLocal,
      publishLocal,
    );

    expect(deps.cloud.ensureDefaultChats).toHaveBeenCalledWith(organizationId);
    expect(deps.cloud.claim).toHaveBeenCalledWith(
      projectId,
      expect.objectContaining({
        localWorkspaceId: `cowork-org-${organizationId}`,
      }),
    );
  });
});
