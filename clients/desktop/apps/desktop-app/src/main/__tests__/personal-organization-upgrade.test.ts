import {
  createPersonalOrganizationUpgradeService,
  type PersonalOrganizationUpgradeDeps,
  type UpgradeWorkspace,
} from '../services/personal-organization-upgrade';
import type { PersonalProjectOperation } from '@canopy/protocol/organizations';

const organizationId = '11111111-1111-4111-8111-111111111111';
const operationId = '22222222-2222-4222-8222-222222222222';
const projectId = '33333333-3333-4333-8333-333333333333';
let epoch: number;
let workspaces: UpgradeWorkspace[];
let operations: PersonalProjectOperation[];
let deps: PersonalOrganizationUpgradeDeps;
let service: ReturnType<typeof createPersonalOrganizationUpgradeService>;
let events: string[];
beforeEach(() => {
  epoch = 1;
  workspaces = [
    { workspaceId: 'single', name: 'Repo', kind: 'single-repo', path: '/repo' },
    { workspaceId: 'multi', name: 'Multi', kind: 'multi-repo', path: '/multi' },
    {
      workspaceId: 'unticked',
      name: 'Unticked',
      kind: 'single-repo',
      path: '/unticked',
    },
  ];
  operations = [];
  events = [];
  deps = {
    identity: (): ReturnType<PersonalOrganizationUpgradeDeps['identity']> =>
      Promise.resolve({
        accountId: 'account',
        epoch,
        credentials: { baseUrl: 'https://example.com', apiKey: 'original-key' },
      }),
    sessionCurrent: (): boolean => true,
    destination: (): ReturnType<
      PersonalOrganizationUpgradeDeps['destination']
    > => Promise.resolve(true),
    workspaces: (): ReturnType<PersonalOrganizationUpgradeDeps['workspaces']> =>
      Promise.resolve(workspaces),
    promote: (
      request,
    ): ReturnType<PersonalOrganizationUpgradeDeps['promote']> =>
      Promise.resolve({
        ...request,
        personalOrganizationId: projectId,
        alreadyUpgraded: false,
        warnings: [],
      }),
    suppress: (): Promise<void> => {
      events.push('suppress');
      return Promise.resolve();
    },
    refreshAccount: (
      identity,
    ): ReturnType<PersonalOrganizationUpgradeDeps['refreshAccount']> =>
      Promise.resolve(identity),
    switchContext: (): ReturnType<
      PersonalOrganizationUpgradeDeps['switchContext']
    > => Promise.resolve(),
    invite: (): ReturnType<PersonalOrganizationUpgradeDeps['invite']> =>
      Promise.resolve({ status: 'sent', inviteId: projectId }),
    inviteStatus: (): ReturnType<
      PersonalOrganizationUpgradeDeps['inviteStatus']
    > => Promise.resolve({ status: 'sent', inviteId: projectId }),
    createSingle: jest.fn(
      async (workspace, destination, _key, _id, options) => {
        events.push(`create:${workspace.workspaceId}`);
        await options.beforeMutation?.();
        await options.onMemberCreated?.(projectId);
        workspace.owner = { organizationId: destination, projectId };
        return {
          ok: true as const,
          organizationProjectId: projectId,
          localWorkspaceId: workspace.workspaceId,
        };
      },
    ),
    createMulti: jest.fn(async (workspace, destination, options) => {
      events.push(`create:${workspace.workspaceId}`);
      await options.beforeMutation?.();
      await options.onMemberCreated?.(projectId);
      workspace.owner = { organizationId: destination, projectId };
      return {
        ok: true as const,
        organizationProjectId: projectId,
        localWorkspaceId: workspace.workspaceId,
      };
    }),
    share: jest.fn((): Promise<void> => {
      events.push('share');
      return Promise.resolve();
    }),
    refreshCatalog: jest.fn((): Promise<void> => {
      events.push('catalog');
      return Promise.resolve();
    }),
    journal: {
      read: (): Promise<PersonalProjectOperation[]> =>
        Promise.resolve(structuredClone(operations)),
      update: (operation): Promise<void> => {
        operations = [
          ...operations.filter(
            (entry) => entry.operationId !== operation.operationId,
          ),
          structuredClone(operation),
        ];
        return Promise.resolve();
      },
    },
    now: (): string => '2026-10-08T00:00:00.000Z',
  };
  service = createPersonalOrganizationUpgradeService(deps);
});
const request = {
  organizationId,
  operationId,
  workspaceIds: ['multi', 'single', 'single'],
};
it('does not resume an operation under an account selected during journal loading', async () => {
  const pendingOperation: PersonalProjectOperation = {
    operationId,
    organizationId,
    accountId: 'account',
    selection: ['single'],
    projects: [{ workspaceId: 'single', stage: 'queued', outcome: 'pending' }],
    updatedAt: deps.now(),
  };
  operations = [pendingOperation];
  let accountId = 'account';
  deps.identity = (): ReturnType<PersonalOrganizationUpgradeDeps['identity']> =>
    Promise.resolve({
      accountId,
      epoch,
      credentials: { baseUrl: 'https://example.com', apiKey: accountId },
    });
  deps.journal.read = (): Promise<PersonalProjectOperation[]> => {
    accountId = 'other-account';
    epoch += 1;
    return Promise.resolve(structuredClone(operations));
  };
  await expect(service.resume()).rejects.toThrow('account-changed');
  expect(deps.createSingle).not.toHaveBeenCalled();
  expect(deps.share).not.toHaveBeenCalled();
  expect(operations).toEqual([pendingOperation]);
});
it('does not automatically resume a definite creation refusal', async () => {
  deps.createSingle = jest.fn(() =>
    Promise.resolve({
      ok: false,
      code: 'create-failed',
    }),
  );
  const result = await service.convert({
    ...request,
    workspaceIds: ['single'],
  });
  expect(result.projects[0]?.outcome).toBe('failed');
  await service.resume();
  expect(deps.createSingle).toHaveBeenCalledTimes(1);
});

it('retains the original creation name when reconciling a lost creation response', async () => {
  deps.createSingle = jest.fn().mockRejectedValue(new Error('response lost'));
  await service.convert({ ...request, workspaceIds: ['single'] });
  workspaces[0].name = 'Renamed while pending';
  await service.convert({ ...request, workspaceIds: ['single'] });
  expect(jest.mocked(deps.createSingle).mock.calls[1]?.[0].name).toBe('Repo');
});
it('persists the deduplicated selection and completes singles before dependent multi projects', async () => {
  const result = await service.convert(request);
  expect(result.selection).toEqual(['multi', 'single']);
  expect(result.projects.every((project) => project.outcome === 'moved')).toBe(
    true,
  );
  expect(events.indexOf('create:single')).toBeLessThan(
    events.indexOf('create:multi'),
  );
  expect(events.slice(0, 3)).toEqual(['create:single', 'share', 'catalog']);
  expect(
    workspaces.find((workspace) => workspace.workspaceId === 'unticked')?.owner,
  ).toBeUndefined();
  await service.convert(request);
  expect(deps.createSingle).toHaveBeenCalledTimes(1);
  expect(deps.createMulti).toHaveBeenCalledTimes(1);
});
it('a converted-private retry completes sharing without creating or transferring again', async () => {
  deps.share = jest
    .fn()
    .mockRejectedValueOnce(new Error('offline'))
    .mockResolvedValue(undefined);
  const first = await service.convert({ ...request, workspaceIds: ['single'] });
  expect(first.projects[0]?.outcome).toBe('converted-private');
  const retry = await service.convert({ ...request, workspaceIds: ['single'] });
  expect(retry.projects[0]?.outcome).toBe('moved');
  expect(deps.createSingle).toHaveBeenCalledTimes(1);
});
it('accounts changing during an await stop every subsequent mutation', async () => {
  deps.createSingle = jest.fn(() => {
    epoch += 1;
    return Promise.resolve({
      ok: false as const,
      code: 'create-failed' as const,
    });
  });
  const result = await service.convert(request);
  expect(
    result.projects.every((project) => project.outcome === 'account-changed'),
  ).toBe(true);
  expect(deps.createMulti).not.toHaveBeenCalled();
  expect(deps.share).not.toHaveBeenCalled();
});
it('a post-share refresh failure is a warning and suspends dependent multi conversion', async () => {
  deps.refreshCatalog = jest
    .fn()
    .mockRejectedValue(new Error('catalog offline'));
  const result = await service.convert(request);
  expect(result.projects.find((p) => p.workspaceId === 'single')).toMatchObject(
    { outcome: 'moved', refreshWarning: true },
  );
  expect(result.projects.find((p) => p.workspaceId === 'multi')?.outcome).toBe(
    'pending',
  );
  expect(deps.createMulti).not.toHaveBeenCalled();
});
it('retries only catalog refresh for a moved project with a warning', async () => {
  deps.refreshCatalog = jest
    .fn()
    .mockRejectedValueOnce(new Error('offline'))
    .mockResolvedValue(undefined);
  const selection = { ...request, workspaceIds: ['single'] };
  await service.convert(selection);
  const result = await service.convert({
    ...selection,
    retryWorkspaceIds: ['single'],
  });
  expect(result.projects[0]).toMatchObject({
    outcome: 'moved',
    refreshWarning: false,
  });
  expect(deps.createSingle).toHaveBeenCalledTimes(1);
  expect(deps.share).toHaveBeenCalledTimes(1);
  expect(deps.refreshCatalog).toHaveBeenCalledTimes(2);
});
it('serializes overlapping deliveries without duplicate creation', async () => {
  await Promise.all([service.convert(request), service.convert(request)]);
  expect(deps.createSingle).toHaveBeenCalledTimes(1);
});
it('refuses changed selections and another desktop session for an existing operation', async () => {
  await service.convert(
    { ...request, workspaceIds: ['single'], workspaceId: 'single' },
    'session-a',
  );
  await expect(
    service.convert(
      { ...request, workspaceIds: ['single'], workspaceId: 'single' },
      'session-b',
    ),
  ).rejects.toThrow('session changed');
  expect(await service.status(operationId, 'session-b')).toBeNull();
  await expect(service.convert(request, 'session-a')).rejects.toThrow(
    'payload changed',
  );
});
it('missing and stale non-Personal selections are explicit outcomes', async () => {
  const single = workspaces.find(
    (workspace) => workspace.workspaceId === 'single',
  );
  if (!single) throw new Error('Missing fixture');
  single.owner = { organizationId, projectId };
  const result = await service.convert({
    ...request,
    workspaceIds: ['missing', 'single'],
  });
  expect(result.projects.map((p) => p.outcome)).toEqual([
    'workspace-not-found',
    'not-personal',
  ]);
  expect(deps.share).not.toHaveBeenCalled();
});
it('committed promotion survives context and account refresh failures', async () => {
  deps.refreshAccount = jest.fn().mockRejectedValue(new Error('offline'));
  deps.switchContext = jest
    .fn()
    .mockRejectedValue(new Error('context unavailable'));
  const result = await service.promote({
    organizationId,
    operationId,
    name: 'Team',
  });
  expect(result).toMatchObject({
    promotion: { organizationId },
    contextSwitched: false,
    warnings: ['account-refresh-failed', 'context-switch-failed'],
  });
  expect(events).toEqual(['suppress']);
});
it('retains a committed share when the account changes and stops untouched projects', async (): Promise<void> => {
  deps.share = jest.fn((): Promise<void> => {
    epoch += 1;
    return Promise.resolve();
  });
  const result = await service.convert(request);
  expect(result.projects.find((p) => p.workspaceId === 'single')?.outcome).toBe(
    'moved',
  );
  expect(result.projects.find((p) => p.workspaceId === 'multi')?.outcome).toBe(
    'account-changed',
  );
});
it('records an account change during initial refresh without starting a project', async (): Promise<void> => {
  deps.refreshAccount = (): ReturnType<
    PersonalOrganizationUpgradeDeps['refreshAccount']
  > => {
    epoch += 1;
    return Promise.reject(new Error('account-changed'));
  };
  const result = await service.convert(request);
  expect(
    result.projects.every((project) => project.outcome === 'account-changed'),
  ).toBe(true);
  expect(deps.createSingle).not.toHaveBeenCalled();
});
it('does not capture a new account for a conversion queued by the previous account', async (): Promise<void> => {
  let release = (): void => {
    throw new Error('Share has not started');
  };
  let entered = (): void => {};
  const sharing = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let calls = 0;
  deps.share = (): Promise<void> =>
    ++calls === 1
      ? new Promise<void>((resolve) => {
          release = resolve;
          entered();
        })
      : Promise.resolve();
  const first = service.convert({ ...request, workspaceIds: ['single'] });
  await sharing;
  const queued = service.convert({
    ...request,
    operationId: projectId,
    workspaceIds: ['unticked'],
  });
  const checked = expect(queued).rejects.toThrow('account-changed');
  epoch += 1;
  release();
  await first;
  await checked;
  expect(
    workspaces.find((workspace) => workspace.workspaceId === 'unticked')?.owner,
  ).toBeUndefined();
});
it('does not create under a new operation while the same workspace has an unknown creation outcome', async (): Promise<void> => {
  const recover = deps.createSingle;
  deps.createSingle = jest.fn().mockRejectedValue(new Error('response lost'));
  await service.convert({ ...request, workspaceIds: ['single'] });
  const next = await service.convert({
    ...request,
    operationId: projectId,
    workspaceIds: ['single'],
  });
  expect(next.projects[0]?.outcome).toBe('pending');
  expect(deps.createSingle).toHaveBeenCalledTimes(1);
  deps.createSingle = recover;
  const recovered = await service.convert({
    ...request,
    workspaceIds: ['single'],
  });
  expect(recovered.projects[0]?.outcome).toBe('moved');
});

it.each(['queued', 'member-created', 'converted', 'shared', 'complete'])(
  'recovers a crash after the %s journal write without duplicate creation, transfer or sharing',
  async (stage) => {
    let created = false;
    let transferred = false;
    let shared = false;
    let creations = 0;
    let transfers = 0;
    let shares = 0;
    deps.createSingle = jest.fn(
      async (workspace, destination, _key, recoveredId, options) => {
        await options.beforeMutation?.();
        if (!created) {
          created = true;
          creations += 1;
        }
        if (recoveredId) expect(recoveredId).toBe(projectId);
        await options.onMemberCreated?.(projectId);
        if (!transferred) {
          await options.beforeMutation?.();
          workspace.owner = { organizationId: destination, projectId };
          transferred = true;
          transfers += 1;
        }
        return {
          ok: true,
          organizationProjectId: projectId,
          localWorkspaceId: workspace.workspaceId,
        };
      },
    );
    deps.share = jest.fn((): Promise<void> => {
      if (!shared) {
        shared = true;
        shares += 1;
      }
      return Promise.resolve();
    });
    const update = deps.journal.update.bind(deps.journal);
    let crashed = false;
    deps.journal.update = async (operation): Promise<void> => {
      if (crashed) throw new Error('process crashed');
      await update(operation);
      if (operation.projects[0]?.stage === stage) {
        crashed = true;
        throw new Error('process crashed');
      }
    };
    await expect(
      service.convert({ ...request, workspaceIds: ['single'] }),
    ).rejects.toThrow('process crashed');
    deps.journal.update = update;
    const restarted = createPersonalOrganizationUpgradeService(deps);
    await restarted.resume();
    expect((await restarted.status(operationId))?.projects[0]?.outcome).toBe(
      'moved',
    );
    expect({ creations, transfers, shares }).toEqual({
      creations: 1,
      transfers: 1,
      shares: 1,
    });
    expect(
      workspaces.find((workspace) => workspace.workspaceId === 'unticked')
        ?.owner,
    ).toBeUndefined();
  },
);

it('records cap exhaustion and continues independent selected projects without automatically retrying refusals', async () => {
  const create = deps.createSingle;
  deps.createSingle = jest.fn(async (...args) =>
    args[0].workspaceId === 'single'
      ? { ok: false, code: 'limit-reached' }
      : create(...args),
  );
  const result = await service.convert({
    ...request,
    workspaceIds: ['single', 'unticked'],
  });
  expect(result.projects.map((project) => project.outcome)).toEqual([
    'limit-reached',
    'moved',
  ]);
  await service.resume();
  expect(deps.createSingle).toHaveBeenCalledTimes(2);
});
