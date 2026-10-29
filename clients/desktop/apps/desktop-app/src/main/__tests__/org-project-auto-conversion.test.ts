/** @jest-environment node */
import type { OrgProjectSummary } from '@canopy/protocol/org-projects';
import type {
  DesktopOrgProjectCatalogSnapshot,
  OrgProjectConversionResult,
  OrgProjectConvertMultiRepoWorkspaceRequest,
  OrgProjectConvertWorkspaceRequest,
  WorkspaceOwnerBinding,
  WorkspaceOwnershipTransfer,
} from '@canopy/desktop-shared/types';
import type { OrgProjectConversionOptions } from '../lib/org-project-materialization';
import type {
  OrgProjectMigrationPass,
  OrgProjectMigrationPassesFile,
  OrgProjectMigrationPassesRead,
  OrgProjectMigrationPassStore,
} from '../lib/org-project-migration-passes';
import type { WorkspaceOwnershipRead } from '../lib/workspace-persistence';
import {
  ORG_PROJECT_AUTO_CONVERSION_DEBOUNCE_MS,
  ORG_PROJECT_AUTO_CONVERSION_RETRY_BASE_MS,
  ORG_PROJECT_AUTO_CONVERSION_STARTUP_DELAY_MS,
  ORG_PROJECT_MIGRATION_PASS_MAX_MS,
  createOrgProjectAutoConversion,
  type OrgProjectAutoConversion,
  type OrgProjectAutoConversionDeps,
  type OrgProjectAutoConversionEvent,
  type OrgProjectAutoConversionWorkspace,
  type OrgProjectAutoConversionWorkspaces,
  type OrgProjectMigrationPassEvent,
} from '../services/org-project-auto-conversion';

const ORG_A = '11111111-1111-4111-8111-111111111111';
const ORG_B = '22222222-2222-4222-8222-222222222222';
const PROJECT_A = '33333333-3333-4333-8333-333333333331';
const PROJECT_B = '33333333-3333-4333-8333-333333333332';
const PROJECT_B_OTHER = '33333333-3333-4333-8333-333333333339';
const REMOTE = 'git@github.com:acme/repo.git';
const MULTI_PROJECT = '44444444-4444-4444-8444-444444444444';

function project(
  id: string,
  organizationId: string,
  name = 'repo',
  providerRepoId = '123',
): OrgProjectSummary {
  return {
    id,
    organizationId,
    name,
    description: null,
    kind: 'CODE',
    purpose: 'project',
    visibility: 'organization',
    memberOwned: false,
    location: 'LOCAL',
    repository: {
      provider: 'github',
      host: 'github.com',
      owner: 'acme',
      name,
      providerRepoId,
      defaultBranch: 'main',
      verification: 'VERIFIED',
    },
    state: 'ACTIVE',
    revision: 1,
    authorizationVersion: 1,
    defaultListed: true,
    preference: 'FOLLOW_DEFAULTS',
    // Listing is not required: a dismissed row keeps nothing Personal.
    listed: false,
    capabilities: { use: true, administer: false, manageCloud: false },
    instance: null,
  };
}

function snapshot(
  organizationId: string,
  projects: OrgProjectSummary[],
  overrides: Partial<DesktopOrgProjectCatalogSnapshot> = {},
): DesktopOrgProjectCatalogSnapshot {
  return {
    context: `org:${organizationId}`,
    revision: 'r1',
    projects,
    fetchedAt: '2026-09-27T00:00:00.000Z',
    stale: false,
    error: null,
    ...overrides,
  };
}

const bound: WorkspaceOwnerBinding = {
  type: 'organization',
  organizationId: ORG_A,
  projectId: PROJECT_A,
  instanceId: 'instance',
  bindingGeneration: 1,
};

let enabled: boolean;
let organizationIds: string[];
let capabilities: string[];
let catalogs: Map<string, DesktopOrgProjectCatalogSnapshot>;
let workspaces: OrgProjectAutoConversionWorkspace[];
let ownership: Map<string, WorkspaceOwnershipRead>;
let remotes: Map<string, string | null | Error>;
let clock: number;
let events: OrgProjectAutoConversionEvent[];
let failures: unknown[];
let convert: jest.Mock<
  Promise<OrgProjectConversionResult>,
  [OrgProjectConvertWorkspaceRequest, OrgProjectConversionOptions]
>;
type Access = Awaited<ReturnType<OrgProjectAutoConversionDeps['access']>>;
let access: jest.Mock<Promise<Access>, []>;
let convertMultiRepo: jest.Mock<
  Promise<OrgProjectConversionResult>,
  [OrgProjectConvertMultiRepoWorkspaceRequest, OrgProjectConversionOptions]
>;
let loadCatalog: jest.Mock<Promise<DesktopOrgProjectCatalogSnapshot>, [string]>;
let readWorkspaces: jest.Mock<Promise<OrgProjectAutoConversionWorkspaces>, []>;
/** Indexed workspaces the sidebar could not project this run. */
let unprojected: Set<string>;
/** Whether the workspace index read was authoritative. */
let indexAuthoritative: boolean;
let readOwnership: jest.Mock<Promise<WorkspaceOwnershipRead>, [string]>;
let readRemoteUrl: jest.Mock<Promise<string | null>, [string]>;
/** The in-memory pass ledger; `unreadable` stands for a corrupt file. */
let ledger: OrgProjectMigrationPassesFile | 'unreadable';
let ledgerWriteError: Error | null;
let updatePasses: jest.Mock<
  Promise<void>,
  [(file: OrgProjectMigrationPassesFile) => OrgProjectMigrationPassesFile]
>;
let passEvents: OrgProjectMigrationPassEvent[];
let service: OrgProjectAutoConversion;
let record: jest.Mock<void, [OrgProjectAutoConversionEvent]>;
let reportFailure: jest.Mock<void, [unknown]>;
let readPasses: jest.Mock<Promise<OrgProjectMigrationPassesRead>, []>;

function passOf(organizationId: string): OrgProjectMigrationPass | undefined {
  return ledger === 'unreadable'
    ? undefined
    : ledger.organizations[organizationId];
}

function at(time: number): string {
  return new Date(time).toISOString();
}

function converted(
  request: OrgProjectConvertWorkspaceRequest,
  type: 'single-repo' | 'multi-repo' = 'single-repo',
): OrgProjectConversionResult {
  const transfer: WorkspaceOwnershipTransfer = {
    version: 1,
    previousOwner: { type: 'personal' },
    organizationId: request.organizationId,
    projectId: request.projectId,
    convertedAt: '2026-09-27T00:00:00.000Z',
  };
  workspaces = workspaces.map((workspace) =>
    workspace.id === request.workspaceId
      ? {
          ...workspace,
          owner: {
            ...bound,
            organizationId: request.organizationId,
            projectId: request.projectId,
          },
        }
      : workspace,
  );
  ownership.set(request.workspaceId, {
    authority: 'ok',
    type,
    owner: {
      ...bound,
      organizationId: request.organizationId,
      projectId: request.projectId,
    },
    ownershipTransfer: transfer,
  });
  return {
    ok: true,
    workspaceId: request.workspaceId,
    owner: {
      ...bound,
      organizationId: request.organizationId,
      projectId: request.projectId,
    },
    ownershipTransfer: transfer,
  };
}

function personal(id: string, remote: string | null = REMOTE): void {
  workspaces.push({ id, repoPath: `/repos/${id}` });
  ownership.set(id, { authority: 'ok', type: 'single-repo' });
  remotes.set(`/repos/${id}`, remote);
}

beforeEach((): void => {
  enabled = true;
  organizationIds = [ORG_A, ORG_B];
  capabilities = ['org-projects-v1'];
  catalogs = new Map([
    [ORG_A, snapshot(ORG_A, [project(PROJECT_A, ORG_A)])],
    // Organization B holds a repository no checkout here matches, so its
    // pass can settle like A's.
    [
      ORG_B,
      snapshot(ORG_B, [project(PROJECT_B_OTHER, ORG_B, 'other-repo', '999')]),
    ],
  ]);
  workspaces = [];
  ownership = new Map();
  remotes = new Map();
  clock = Date.parse('2026-09-27T00:00:00.000Z');
  events = [];
  failures = [];
  convert = jest.fn(
    (request): Promise<OrgProjectConversionResult> =>
      Promise.resolve(converted(request)),
  );
  convertMultiRepo = jest.fn(
    (request): Promise<OrgProjectConversionResult> =>
      Promise.resolve(
        converted({ ...request, projectId: MULTI_PROJECT }, 'multi-repo'),
      ),
  );
  access = jest.fn(
    (): Promise<Access> =>
      Promise.resolve({ accountId: 'account', capabilities, organizationIds }),
  );
  loadCatalog = jest.fn(
    (organizationId: string): Promise<DesktopOrgProjectCatalogSnapshot> =>
      Promise.resolve(
        catalogs.get(organizationId) ??
          snapshot(organizationId, [], { revision: '', error: 'offline' }),
      ),
  );
  unprojected = new Set();
  indexAuthoritative = true;
  readWorkspaces = jest.fn(
    (): Promise<OrgProjectAutoConversionWorkspaces> =>
      Promise.resolve({
        items: workspaces.filter(
          (workspace): boolean => !unprojected.has(workspace.id),
        ),
        indexedIds: indexAuthoritative
          ? workspaces.map((workspace): string => workspace.id)
          : null,
      }),
  );
  readRemoteUrl = jest.fn((repoPath: string): Promise<string | null> => {
    const remote = remotes.get(repoPath) ?? null;
    return remote instanceof Error
      ? Promise.reject(remote)
      : Promise.resolve(remote);
  });
  ledger = { version: 1, organizations: {} };
  ledgerWriteError = null;
  passEvents = [];
  updatePasses = jest.fn((change): Promise<void> => {
    if (ledgerWriteError) return Promise.reject(ledgerWriteError);
    if (ledger === 'unreadable')
      return Promise.reject(new Error('migration-passes-unreadable'));
    ledger = change(ledger);
    return Promise.resolve();
  });
  readPasses = jest.fn(() =>
    Promise.resolve(
      ledger === 'unreadable'
        ? { status: 'unreadable' }
        : { status: 'ok', file: ledger },
    ),
  );
  const passes: OrgProjectMigrationPassStore = {
    read: readPasses,
    update: updatePasses,
  };
  readOwnership = jest.fn(
    (id): Promise<WorkspaceOwnershipRead> =>
      Promise.resolve(ownership.get(id) ?? { authority: 'absent' }),
  );
  record = jest.fn((event) => {
    events.push(event);
  });
  reportFailure = jest.fn((error) => {
    failures.push(error);
  });
  const deps: OrgProjectAutoConversionDeps = {
    enabled: (): boolean => enabled,
    access,
    loadCatalog,
    readWorkspaces,
    readOwnership,
    readRemoteUrl,
    convert,
    convertMultiRepo,
    record,
    reportFailure,
    passes,
    recordPass: (event): void => {
      passEvents.push(event);
    },
    now: (): number => clock,
  };
  service = createOrgProjectAutoConversion(deps);
});

afterEach((): void => {
  service.dispose();
  jest.useRealTimers();
});

it('a web-only promotion excludes this team and completes only its local pass', async () => {
  personal('personal-repo');
  catalogs.set(ORG_A, snapshot(ORG_A, [project(PROJECT_A, ORG_A)]));
  access.mockResolvedValue({
    accountId: 'account-a',
    capabilities: ['org-projects-v1'],
    organizationIds: [ORG_A, ORG_B],
    excludedOrganizationIds: [ORG_A],
  });
  await service.runNow();
  expect(convert).not.toHaveBeenCalled();
  expect(passOf(ORG_A)?.eligibleWorkspaceIds).toEqual([]);
  expect(passOf(ORG_A)?.completedAt).toEqual(expect.any(String));
  expect(passOf(ORG_B)).toBeDefined();
});

it('rechecks the exclusion when promotion commits during an in-flight pass', async () => {
  personal('personal-repo');
  catalogs.set(ORG_A, snapshot(ORG_A, [project(PROJECT_A, ORG_A)]));
  const before = {
    accountId: 'account-a',
    capabilities: ['org-projects-v1'],
    organizationIds: [ORG_A, ORG_B],
  };
  access
    .mockResolvedValueOnce(before)
    .mockResolvedValue({ ...before, excludedOrganizationIds: [ORG_A] });
  await service.runNow();
  expect(convert).not.toHaveBeenCalled();
});

it('converts a Personal checkout that matches an organization project, with no prompt', async (): Promise<void> => {
  personal('personal-repo');

  await service.runNow();

  expect(convert).toHaveBeenCalledTimes(1);
  expect(convert).toHaveBeenCalledWith(
    {
      workspaceId: 'personal-repo',
      organizationId: ORG_A,
      projectId: PROJECT_A,
    },
    { automatic: true },
  );
  expect(events).toEqual([
    {
      outcome: 'converted',
      workspaceId: 'personal-repo',
      organizationId: ORG_A,
      projectId: PROJECT_A,
    },
  ]);
  // Every organization the member belongs to is read, not only the selected one.
  expect(loadCatalog.mock.calls.map(([id]) => id)).toEqual([ORG_A, ORG_B]);
  expect(failures).toEqual([]);

  // At most once: the next run finds it bound and leaves it alone.
  await service.runNow();
  expect(convert).toHaveBeenCalledTimes(1);
});

it('does not auto-convert into a member-owned private project', async (): Promise<void> => {
  personal('personal-repo');
  catalogs.set(
    ORG_A,
    snapshot(ORG_A, [
      {
        ...project(PROJECT_A, ORG_A),
        visibility: 'private',
        memberOwned: true,
        capabilities: { use: true, administer: true, manageCloud: false },
      },
    ]),
  );

  await service.runNow();

  expect(convert).not.toHaveBeenCalled();
});

it('leaves a workspace that was moved back to Personal alone, and says so once', async (): Promise<void> => {
  personal('moved-back');
  ownership.set('moved-back', {
    authority: 'ok',
    type: 'single-repo',
    ownershipTransfer: {
      version: 1,
      previousOwner: { type: 'personal' },
      organizationId: ORG_A,
      projectId: PROJECT_A,
      convertedAt: '2026-09-01T00:00:00.000Z',
      movedBackAt: '2026-09-02T00:00:00.000Z',
    },
  });

  await service.runNow();
  await service.runNow();

  expect(convert).not.toHaveBeenCalled();
  expect(events).toEqual([
    { outcome: 'skipped', workspaceId: 'moved-back', reason: 'moved-back' },
  ]);
});

it('does nothing, and schedules nothing, with the flag off', async (): Promise<void> => {
  jest.useFakeTimers();
  enabled = false;
  personal('personal-repo');

  service.start();
  service.trigger();
  expect(jest.getTimerCount()).toBe(0);
  await service.runNow();

  expect(access).not.toHaveBeenCalled();
  expect(loadCatalog).not.toHaveBeenCalled();
  expect(readWorkspaces).not.toHaveBeenCalled();
  expect(convert).not.toHaveBeenCalled();
  expect(events).toEqual([]);
});

it('cancels a scheduled run when the flag turns off before it fires', async (): Promise<void> => {
  jest.useFakeTimers();
  personal('personal-repo');
  service.trigger();
  expect(jest.getTimerCount()).toBe(1);
  enabled = false;
  service.trigger();
  expect(jest.getTimerCount()).toBe(0);
  await jest.advanceTimersByTimeAsync(ORG_PROJECT_AUTO_CONVERSION_DEBOUNCE_MS);
  expect(convert).not.toHaveBeenCalled();
});

it('skips a checkout whose repository matches projects in more than one organization', async (): Promise<void> => {
  catalogs.set(ORG_B, snapshot(ORG_B, [project(PROJECT_B, ORG_B)]));
  personal('personal-repo');

  await service.runNow();
  await service.runNow();

  expect(convert).not.toHaveBeenCalled();
  expect(events).toEqual([
    {
      outcome: 'skipped',
      workspaceId: 'personal-repo',
      reason: 'ambiguous-organizations',
      organizationCount: 2,
    },
  ]);
});

it('skips a checkout matching several projects of one organization', async (): Promise<void> => {
  catalogs.set(
    ORG_A,
    snapshot(ORG_A, [project(PROJECT_A, ORG_A), project(PROJECT_B, ORG_A)]),
  );
  personal('personal-repo');

  await service.runNow();

  expect(convert).not.toHaveBeenCalled();
  expect(events).toEqual([
    {
      outcome: 'skipped',
      workspaceId: 'personal-repo',
      reason: 'ambiguous-projects',
      organizationId: ORG_A,
    },
  ]);
});

it('does not decide while another organization catalog is unknown', async (): Promise<void> => {
  catalogs.delete(ORG_B);
  personal('personal-repo');

  await service.runNow();
  expect(convert).not.toHaveBeenCalled();
  expect(events).toEqual([
    {
      outcome: 'skipped',
      workspaceId: 'personal-repo',
      reason: 'catalog-unavailable',
      organizationId: ORG_A,
      projectId: PROJECT_A,
    },
  ]);
  // The pass waits for the unknown catalog rather than completing.
  expect(passOf(ORG_A)?.completedAt).toBeUndefined();

  // An organization that refused the context has nothing to match.
  catalogs.set(ORG_B, snapshot(ORG_B, [], { error: 'access-changed' }));
  await service.runNow();
  expect(convert).toHaveBeenCalledTimes(1);
});

it('skips converted, bound and non-matching workspaces without converting them', async (): Promise<void> => {
  workspaces.push({ id: 'bound', repoPath: '/repos/bound', owner: bound });
  personal('converted-before');
  ownership.set('converted-before', {
    authority: 'ok',
    type: 'single-repo',
    owner: bound,
    ownershipTransfer: {
      version: 1,
      previousOwner: { type: 'personal' },
      organizationId: ORG_A,
      projectId: PROJECT_A,
      convertedAt: '2026-09-01T00:00:00.000Z',
    },
  });
  personal('other-repo', 'git@github.com:someone/else.git');
  personal('no-origin', null);
  workspaces.push({ id: 'multi', repoPath: null });

  await service.runNow();

  expect(convert).not.toHaveBeenCalled();
  expect(events).toEqual([]);
});

it('keeps a duplicate checkout of a project already bound on this device Personal', async (): Promise<void> => {
  workspaces.push({ id: 'bound', repoPath: '/repos/bound', owner: bound });
  personal('duplicate');

  await service.runNow();

  expect(convert).not.toHaveBeenCalled();
  expect(events).toEqual([
    {
      outcome: 'skipped',
      workspaceId: 'duplicate',
      reason: 'project-already-bound',
      organizationId: ORG_A,
      projectId: PROJECT_A,
    },
  ]);
});

it('retries a transient refusal on a later trigger, backing off between attempts', async (): Promise<void> => {
  personal('personal-repo');
  convert.mockResolvedValueOnce({ ok: false, code: 'offline' });

  await service.runNow();
  expect(events).toEqual([
    {
      outcome: 'failed',
      workspaceId: 'personal-repo',
      organizationId: ORG_A,
      projectId: PROJECT_A,
      reason: 'offline',
      retry: 'later',
    },
  ]);

  // The conversion's own catalog refresh re-triggers at once: not retried yet.
  await service.runNow();
  expect(convert).toHaveBeenCalledTimes(1);

  clock += ORG_PROJECT_AUTO_CONVERSION_RETRY_BASE_MS;
  await service.runNow();
  expect(convert).toHaveBeenCalledTimes(2);
  expect(events.at(-1)).toMatchObject({ outcome: 'converted' });
});

it('does not retry a refusal that cannot succeed', async (): Promise<void> => {
  personal('personal-repo');
  convert.mockResolvedValue({ ok: false, code: 'repository-mismatch' });

  await service.runNow();
  clock += 24 * 60 * 60_000;
  await service.runNow();
  await service.runNow();

  expect(convert).toHaveBeenCalledTimes(1);
  expect(events).toEqual([
    {
      outcome: 'failed',
      workspaceId: 'personal-repo',
      organizationId: ORG_A,
      projectId: PROJECT_A,
      reason: 'repository-mismatch',
      retry: 'never-this-session',
    },
  ]);
});

it('does not read any checkout when no organization has a project to match', async (): Promise<void> => {
  catalogs.set(ORG_A, snapshot(ORG_A, []));
  catalogs.set(ORG_B, snapshot(ORG_B, []));
  personal('personal-repo');

  await service.runNow();

  expect(readRemoteUrl).not.toHaveBeenCalled();
  expect(convert).not.toHaveBeenCalled();
  // Nothing to migrate yet: both passes stay open until a project is listed
  // (or their time cap), so a member who joined early still gets one.
  expect(passOf(ORG_A)?.completedAt).toBeUndefined();
  expect(passOf(ORG_B)?.completedAt).toBeUndefined();
});

it('stops when the account is missing or the server has no organization projects', async (): Promise<void> => {
  personal('personal-repo');
  capabilities = [];
  await service.runNow();
  expect(readWorkspaces).not.toHaveBeenCalled();
  expect(passOf(ORG_A)).toBeUndefined();
  catalogs.set(ORG_A, snapshot(ORG_A, [], { error: 'unavailable' }));
  capabilities = ['org-projects-v1'];
  await service.runNow();
  expect(readRemoteUrl).not.toHaveBeenCalled();
  expect(convert).not.toHaveBeenCalled();
  // The pass started at first sight, and nothing completes it yet.
  expect(passOf(ORG_A)).toEqual({
    startedAt: at(clock),
    eligibleWorkspaceIds: ['personal-repo'],
  });
});

it('waits for the startup delay, then debounces triggers into one serialized run', async (): Promise<void> => {
  jest.useFakeTimers();
  personal('personal-repo');
  service.start();
  await jest.advanceTimersByTimeAsync(
    ORG_PROJECT_AUTO_CONVERSION_STARTUP_DELAY_MS - 1,
  );
  expect(access).not.toHaveBeenCalled();
  service.trigger();
  service.trigger();
  await jest.advanceTimersByTimeAsync(ORG_PROJECT_AUTO_CONVERSION_DEBOUNCE_MS);
  expect(access).toHaveBeenCalledTimes(2);
  expect(convert).toHaveBeenCalledTimes(1);

  // A trigger that lands during a run is answered by one follow-up run.
  let release: () => void = (): void => {};
  access.mockImplementationOnce(
    (): Promise<Access> =>
      new Promise<Access>((resolve) => {
        release = (): void =>
          resolve({ accountId: 'account', capabilities, organizationIds });
      }),
  );
  service.trigger();
  await jest.advanceTimersByTimeAsync(ORG_PROJECT_AUTO_CONVERSION_DEBOUNCE_MS);
  expect(access).toHaveBeenCalledTimes(3);
  service.trigger();
  service.trigger();
  expect(jest.getTimerCount()).toBe(0);
  release();
  await jest.advanceTimersByTimeAsync(ORG_PROJECT_AUTO_CONVERSION_DEBOUNCE_MS);
  expect(access).toHaveBeenCalledTimes(4);
  await jest.advanceTimersByTimeAsync(
    ORG_PROJECT_AUTO_CONVERSION_DEBOUNCE_MS * 5,
  );
  expect(access).toHaveBeenCalledTimes(4);
});

it('reports a failed run without throwing into its caller', async (): Promise<void> => {
  access.mockRejectedValueOnce(new Error('account store unavailable'));
  await expect(service.runNow()).resolves.toBeUndefined();
  expect(failures).toHaveLength(1);
});

it('forgets refusals when another account signs in', async (): Promise<void> => {
  catalogs.set(
    ORG_A,
    snapshot(ORG_A, [
      project(PROJECT_A, ORG_A),
      project(PROJECT_B, ORG_A, 'other', '456'),
    ]),
  );
  personal('personal-repo');
  // A retryable refusal keeps the organization's pass open.
  personal('pending', 'git@github.com:acme/other.git');
  convert.mockImplementation(
    (request): Promise<OrgProjectConversionResult> =>
      Promise.resolve(
        request.workspaceId === 'personal-repo'
          ? { ok: false, code: 'project-already-bound' }
          : { ok: false, code: 'offline' },
      ),
  );
  const attempts = (): number =>
    convert.mock.calls.filter(
      ([request]): boolean => request.workspaceId === 'personal-repo',
    ).length;
  await service.runNow();
  await service.runNow();
  expect(attempts()).toBe(1);

  access.mockImplementation(
    (): Promise<Access> =>
      Promise.resolve({ accountId: 'other', capabilities, organizationIds }),
  );
  await service.runNow();
  expect(attempts()).toBe(2);
});

describe('one-time migration pass per organization (hybrid model)', (): void => {
  const BILLING = 'git@github.com:acme/billing.git';

  it('runs once per organization: converts what existed, then never reads a remote again', async (): Promise<void> => {
    personal('personal-repo');
    const startedAt = at(clock);

    await service.runNow();

    expect(convert).toHaveBeenCalledTimes(1);
    expect(passOf(ORG_A)).toEqual({
      startedAt,
      eligibleWorkspaceIds: ['personal-repo'],
      completedAt: startedAt,
    });
    expect(passOf(ORG_B)).toEqual({
      startedAt,
      eligibleWorkspaceIds: ['personal-repo'],
      completedAt: startedAt,
    });
    expect(passEvents).toEqual([
      { outcome: 'started', organizationId: ORG_A, workspaceCount: 1 },
      { outcome: 'started', organizationId: ORG_B, workspaceCount: 1 },
      { outcome: 'completed', organizationId: ORG_A, completion: 'settled' },
      { outcome: 'completed', organizationId: ORG_B, completion: 'settled' },
    ]);
    // Started before any conversion, completed in one more write.
    expect(updatePasses).toHaveBeenCalledTimes(2);

    readRemoteUrl.mockClear();
    loadCatalog.mockClear();
    clock += 24 * 60 * 60_000;
    await service.runNow();
    await service.runNow();

    expect(readRemoteUrl).not.toHaveBeenCalled();
    expect(loadCatalog).not.toHaveBeenCalled();
    expect(convert).toHaveBeenCalledTimes(1);
    expect(updatePasses).toHaveBeenCalledTimes(2);
    expect(passEvents).toHaveLength(4);
  });

  it('never auto-moves a project added after the pass completed', async (): Promise<void> => {
    jest.useFakeTimers();
    await service.runNow();
    expect(passOf(ORG_A)?.completedAt).toBe(at(clock));

    personal('added-later');
    service.trigger();
    await jest.advanceTimersByTimeAsync(
      ORG_PROJECT_AUTO_CONVERSION_DEBOUNCE_MS,
    );
    await service.runNow();

    expect(readRemoteUrl).not.toHaveBeenCalled();
    expect(convert).not.toHaveBeenCalled();
    expect(events).toEqual([]);
  });

  it('does not convert a project added while a pass is open, and retries the one that was eligible', async (): Promise<void> => {
    catalogs.set(
      ORG_A,
      snapshot(ORG_A, [
        project(PROJECT_A, ORG_A),
        project(PROJECT_B, ORG_A, 'other', '456'),
      ]),
    );
    personal('eligible');
    convert.mockResolvedValueOnce({ ok: false, code: 'offline' });
    await service.runNow();
    expect(passOf(ORG_A)).toEqual({
      startedAt: at(clock),
      eligibleWorkspaceIds: ['eligible'],
    });

    personal('added-later', 'git@github.com:acme/other.git');
    clock += ORG_PROJECT_AUTO_CONVERSION_RETRY_BASE_MS;
    await service.runNow();

    expect(convert).toHaveBeenCalledTimes(2);
    expect(
      convert.mock.calls.map(([request]): string => request.workspaceId),
    ).toEqual(['eligible', 'eligible']);
    expect(readRemoteUrl).not.toHaveBeenCalledWith('/repos/added-later');
    expect(passOf(ORG_A)?.completedAt).toBe(at(clock));
  });

  it('gives a newly joined organization its own pass over the projects that existed at first sight', async (): Promise<void> => {
    organizationIds = [ORG_A];
    catalogs.set(
      ORG_B,
      snapshot(ORG_B, [project(PROJECT_B, ORG_B, 'billing', '200')]),
    );
    await service.runNow();
    const firstPass = at(clock);
    expect(passOf(ORG_A)?.completedAt).toBe(firstPass);

    // Created after the first organization's pass, before joining the second.
    personal('before-join', BILLING);
    personal('first-org-repo');
    clock += 60 * 60_000;
    organizationIds = [ORG_A, ORG_B];
    // Joining fetches the new organization's catalog.
    catalogs.set(
      ORG_B,
      snapshot(ORG_B, [project(PROJECT_B, ORG_B, 'billing', '200')], {
        fetchedAt: at(clock),
      }),
    );
    await service.runNow();

    expect(convert).toHaveBeenCalledTimes(1);
    expect(convert).toHaveBeenCalledWith(
      {
        workspaceId: 'before-join',
        organizationId: ORG_B,
        projectId: PROJECT_B,
      },
      { automatic: true },
    );
    expect(passOf(ORG_A)?.completedAt).toBe(firstPass);
    expect(passOf(ORG_B)).toEqual({
      startedAt: at(clock),
      eligibleWorkspaceIds: ['before-join', 'first-org-repo'],
      completedAt: at(clock),
    });
    // Its repository is the first organization's, whose pass is over.
    expect(events).toContainEqual({
      outcome: 'skipped',
      workspaceId: 'first-org-repo',
      reason: 'outside-migration-pass',
      organizationId: ORG_A,
    });

    personal('after-join', BILLING);
    await service.runNow();
    expect(convert).toHaveBeenCalledTimes(1);
  });

  it('never re-converts a project moved back to Personal, even in a new pass', async (): Promise<void> => {
    ledger = {
      version: 1,
      organizations: {
        [ORG_A]: {
          startedAt: '2026-09-01T00:00:00.000Z',
          eligibleWorkspaceIds: [],
          completedAt: '2026-09-01T00:00:00.000Z',
        },
      },
    };
    catalogs.set(
      ORG_B,
      snapshot(ORG_B, [project(PROJECT_B, ORG_B, 'billing', '200')]),
    );
    personal('moved-back', BILLING);
    ownership.set('moved-back', {
      authority: 'ok',
      type: 'single-repo',
      ownershipTransfer: {
        version: 1,
        previousOwner: { type: 'personal' },
        organizationId: ORG_B,
        projectId: PROJECT_B,
        convertedAt: '2026-09-01T00:00:00.000Z',
        movedBackAt: '2026-09-02T00:00:00.000Z',
      },
    });

    await service.runNow();

    expect(passOf(ORG_B)?.eligibleWorkspaceIds).toEqual(['moved-back']);
    expect(convert).not.toHaveBeenCalled();
    expect(events).toEqual([
      { outcome: 'skipped', workspaceId: 'moved-back', reason: 'moved-back' },
    ]);
    expect(passOf(ORG_B)?.completedAt).toBe(at(clock));
  });

  it('keeps a pass open after a retryable refusal and completes it after a permanent one', async (): Promise<void> => {
    personal('personal-repo');
    convert.mockResolvedValueOnce({ ok: false, code: 'offline' });
    await service.runNow();
    expect(passOf(ORG_A)?.completedAt).toBeUndefined();
    // Nothing was pending for the other organization.
    expect(passOf(ORG_B)?.completedAt).toBe(at(clock));

    // A run inside the backoff still keeps it open.
    await service.runNow();
    expect(passOf(ORG_A)?.completedAt).toBeUndefined();

    clock += ORG_PROJECT_AUTO_CONVERSION_RETRY_BASE_MS;
    convert.mockResolvedValueOnce({ ok: false, code: 'repository-mismatch' });
    await service.runNow();
    expect(passOf(ORG_A)?.completedAt).toBe(at(clock));
    expect(passEvents.at(-1)).toEqual({
      outcome: 'completed',
      organizationId: ORG_A,
      completion: 'settled',
    });
  });

  it('keeps a pass open while Git cannot read an eligible checkout', async (): Promise<void> => {
    personal('personal-repo', null);
    remotes.set('/repos/personal-repo', new Error('git failed'));
    await service.runNow();
    expect(passOf(ORG_A)?.completedAt).toBeUndefined();
    expect(passOf(ORG_B)?.completedAt).toBeUndefined();

    remotes.set('/repos/personal-repo', REMOTE);
    await service.runNow();
    expect(convert).toHaveBeenCalledTimes(1);
    expect(passOf(ORG_A)?.completedAt).toBe(at(clock));
  });

  it('completes a pass with pending retries a week after it started', async (): Promise<void> => {
    personal('personal-repo');
    const startedAt = clock;
    convert.mockResolvedValue({ ok: false, code: 'offline' });
    await service.runNow();
    expect(passOf(ORG_A)?.completedAt).toBeUndefined();

    clock = startedAt + ORG_PROJECT_MIGRATION_PASS_MAX_MS - 1;
    await service.runNow();
    expect(passOf(ORG_A)?.completedAt).toBeUndefined();

    clock = startedAt + ORG_PROJECT_MIGRATION_PASS_MAX_MS;
    await service.runNow();
    const attempts = convert.mock.calls.length;
    expect(passOf(ORG_A)?.completedAt).toBe(at(clock));
    expect(passEvents.at(-1)).toEqual({
      outcome: 'completed',
      organizationId: ORG_A,
      completion: 'expired',
    });

    clock += ORG_PROJECT_AUTO_CONVERSION_RETRY_BASE_MS * 120;
    await service.runNow();
    expect(convert).toHaveBeenCalledTimes(attempts);
  });

  it('fails closed on an unreadable ledger and reports it once', async (): Promise<void> => {
    ledger = 'unreadable';
    personal('personal-repo');

    await service.runNow();
    await service.runNow();

    expect(readWorkspaces).not.toHaveBeenCalled();
    expect(readRemoteUrl).not.toHaveBeenCalled();
    expect(convert).not.toHaveBeenCalled();
    expect(updatePasses).not.toHaveBeenCalled();
    expect(failures).toEqual([new Error('migration-passes-unreadable')]);
    expect(passEvents).toEqual([]);
  });

  it('starts passes normally from an empty ledger', async (): Promise<void> => {
    personal('personal-repo');
    await service.runNow();
    expect(convert).toHaveBeenCalledTimes(1);
    expect(failures).toEqual([]);
  });

  it('converts nothing when the start of a pass cannot be persisted', async (): Promise<void> => {
    personal('personal-repo');
    ledgerWriteError = new Error('disk full');

    await service.runNow();

    expect(readRemoteUrl).not.toHaveBeenCalled();
    expect(convert).not.toHaveBeenCalled();
    expect(failures).toEqual([ledgerWriteError]);
    expect(passEvents).toEqual([]);

    // The same failure on later runs is reported once a session.
    await service.runNow();
    expect(failures).toHaveLength(1);

    ledgerWriteError = null;
    await service.runNow();
    expect(convert).toHaveBeenCalledTimes(1);
  });
});

describe('multi-repo projects (CAN-3532)', (): void => {
  const WEB_A = '55555555-5555-4555-8555-555555555551';
  const API_A = '55555555-5555-4555-8555-555555555552';
  const API_B = '55555555-5555-4555-8555-555555555553';

  function multiRepo(
    id: string,
    repos: Record<string, string | null | Error>,
  ): void {
    workspaces.push({ id, repoPath: null, repoPaths: Object.keys(repos) });
    ownership.set(id, { authority: 'ok', type: 'multi-repo' });
    for (const [path, remote] of Object.entries(repos))
      remotes.set(path, remote);
  }

  beforeEach((): void => {
    catalogs.set(
      ORG_A,
      snapshot(ORG_A, [
        project(PROJECT_A, ORG_A, 'root', '100'),
        project(WEB_A, ORG_A, 'web', '101'),
        project(API_A, ORG_A, 'api', '102'),
      ]),
    );
  });

  function setRetired(id: string, retired: boolean): void {
    workspaces = workspaces.map((workspace) =>
      workspace.id === id ? { ...workspace, retired } : workspace,
    );
  }

  it('silently settles a retired-only pass without ownership or remote reads', async () => {
    multiRepo('retired', { '/retired/web': 'https://github.com/acme/web' });
    setRetired('retired', true);
    await service.runNow();
    expect(readOwnership).not.toHaveBeenCalled();
    expect(readRemoteUrl).not.toHaveBeenCalled();
    expect(convert).not.toHaveBeenCalled();
    expect(convertMultiRepo).not.toHaveBeenCalled();
    expect(events).toEqual([]);
    expect(passOf(ORG_A)).toMatchObject({
      eligibleWorkspaceIds: ['retired'],
      completedAt: at(clock),
    });
    expect(passEvents).toContainEqual({
      outcome: 'completed',
      organizationId: ORG_A,
      completion: 'settled',
    });
  });

  it.each([false, undefined])(
    'converts eligible kept combinations with retired %s in a mixed pass',
    async (retired) => {
      multiRepo('disposable', {
        '/disposable/web': 'https://github.com/acme/web',
      });
      setRetired('disposable', true);
      multiRepo('kept', { '/kept/web': 'https://github.com/acme/web' });
      workspaces[1] = { ...workspaces[1], retired };
      await service.runNow();
      expect(readOwnership.mock.calls).toEqual([['kept']]);
      expect(readRemoteUrl.mock.calls).toEqual([['/kept/web']]);
      expect(convertMultiRepo.mock.calls).toEqual([
        [{ workspaceId: 'kept', organizationId: ORG_A }, { automatic: true }],
      ]);
      expect(events).toEqual([
        {
          outcome: 'converted',
          workspaceId: 'kept',
          organizationId: ORG_A,
          projectId: MULTI_PROJECT,
        },
      ]);
      expect(passOf(ORG_A)?.completedAt).toBe(at(clock));
    },
  );

  it('converts a revived combination on a later run while another retry keeps its pass open', async () => {
    multiRepo('revived', { '/revived/web': 'https://github.com/acme/web' });
    setRetired('revived', true);
    multiRepo('waiting', { '/waiting/web': new Error('Git unavailable') });
    await service.runNow();
    expect(passOf(ORG_A)?.eligibleWorkspaceIds).toEqual(['revived', 'waiting']);
    expect(passOf(ORG_A)?.completedAt).toBeUndefined();
    expect(convertMultiRepo).not.toHaveBeenCalled();
    expect(events).toEqual([
      {
        outcome: 'skipped',
        workspaceId: 'waiting',
        reason: 'repository-unavailable',
      },
    ]);
    setRetired('revived', false);
    await service.runNow();
    expect(convertMultiRepo).toHaveBeenCalledTimes(1);
    expect(convertMultiRepo).toHaveBeenCalledWith(
      { workspaceId: 'revived', organizationId: ORG_A },
      { automatic: true },
    );
  });

  it('does not reopen a settled pass when a combination revives', async () => {
    multiRepo('revived', { '/revived/web': 'https://github.com/acme/web' });
    setRetired('revived', true);
    await service.runNow();
    expect(passOf(ORG_A)?.completedAt).toBe(at(clock));
    setRetired('revived', false);
    await service.runNow();
    expect(convertMultiRepo).not.toHaveBeenCalled();
    expect(readRemoteUrl).not.toHaveBeenCalled();
    expect(events).toEqual([]);
  });

  it('caches a coordinator retirement refusal across revival while another retry holds the pass open', async () => {
    multiRepo('raced', { '/raced/web': 'https://github.com/acme/web' });
    multiRepo('waiting', { '/waiting/web': new Error('Git unavailable') });
    convertMultiRepo.mockImplementationOnce(() => {
      // The selector saw an eligible row; the coordinator fresh read retired it.
      setRetired('raced', true);
      return Promise.resolve({ ok: false, code: 'unsupported-workspace' });
    });
    await service.runNow();
    expect(events).toContainEqual({
      outcome: 'failed',
      workspaceId: 'raced',
      organizationId: ORG_A,
      reason: 'unsupported-workspace',
      retry: 'never-this-session',
    });
    expect(passOf(ORG_A)?.completedAt).toBeUndefined();
    setRetired('raced', false);
    clock += ORG_PROJECT_AUTO_CONVERSION_RETRY_BASE_MS;
    await service.runNow();
    expect(convertMultiRepo).toHaveBeenCalledTimes(1);
    remotes.set('/waiting/web', 'https://github.com/acme/web');
    await service.runNow();
    expect(convertMultiRepo).toHaveBeenCalledTimes(2);
    expect(convertMultiRepo.mock.calls[1]?.[0].workspaceId).toBe('waiting');
    expect(passOf(ORG_A)?.completedAt).toBe(at(clock));
    expect(
      events.filter((event) => event.workspaceId === 'raced'),
    ).toHaveLength(1);
  });

  it('settles a pass after a coordinator retirement refusal and never retries revival', async () => {
    multiRepo('raced', { '/raced/web': 'https://github.com/acme/web' });
    convertMultiRepo.mockResolvedValueOnce({
      ok: false,
      code: 'unsupported-workspace',
    });
    await service.runNow();
    expect(passOf(ORG_A)?.completedAt).toBe(at(clock));
    await service.runNow();
    expect(convertMultiRepo).toHaveBeenCalledTimes(1);
  });

  it('converts a project whose repositories only member-owned, organization-visible projects hold, before settling the pass', async (): Promise<void> => {
    const memberOwned = (
      id: string,
      name: string,
      repoId: string,
    ): OrgProjectSummary => ({
      ...project(id, ORG_A, name, repoId),
      memberOwned: true,
    });
    catalogs.set(
      ORG_A,
      snapshot(ORG_A, [
        memberOwned(WEB_A, 'web', '101'),
        memberOwned(API_A, 'api', '102'),
      ]),
    );
    // No organization has a project a single checkout could become.
    catalogs.set(ORG_B, snapshot(ORG_B, []));
    multiRepo('platform', {
      '/platform/web': 'https://github.com/acme/web',
      '/platform/api': 'https://github.com/acme/api.git',
    });

    await service.runNow();

    expect(convertMultiRepo).toHaveBeenCalledWith(
      { workspaceId: 'platform', organizationId: ORG_A },
      { automatic: true },
    );
  });

  it('converts a project whose every repository, its root included, belongs to one organization', async (): Promise<void> => {
    multiRepo('platform', {
      '/platform': 'git@github.com:acme/root.git',
      '/platform/web': 'https://github.com/acme/web',
      '/platform/api': 'https://github.com/acme/api.git',
    });

    await service.runNow();

    expect(convert).not.toHaveBeenCalled();
    expect(convertMultiRepo).toHaveBeenCalledTimes(1);
    expect(convertMultiRepo).toHaveBeenCalledWith(
      { workspaceId: 'platform', organizationId: ORG_A },
      { automatic: true },
    );
    expect(events).toEqual([
      {
        outcome: 'converted',
        workspaceId: 'platform',
        organizationId: ORG_A,
        projectId: MULTI_PROJECT,
      },
    ]);
    // Bound now: the next run leaves it alone.
    workspaces[0] = {
      ...workspaces[0],
      owner: { ...bound, projectId: MULTI_PROJECT },
    };
    await service.runNow();
    expect(convertMultiRepo).toHaveBeenCalledTimes(1);
  });

  it('ignores a remote-less root and converts when every child belongs to one organization', async (): Promise<void> => {
    multiRepo('platform', {
      '/platform': null,
      '/platform/web': 'https://github.com/acme/web',
      '/platform/api': 'https://github.com/acme/api.git',
    });

    await service.runNow();

    expect(convertMultiRepo).toHaveBeenCalledWith(
      { workspaceId: 'platform', organizationId: ORG_A },
      { automatic: true },
    );
    expect(events).toEqual([
      {
        outcome: 'converted',
        workspaceId: 'platform',
        organizationId: ORG_A,
        projectId: MULTI_PROJECT,
      },
    ]);
  });

  it('converts a mixed project when the root has no remote', async (): Promise<void> => {
    multiRepo('mixed', {
      '/mixed': null,
      '/mixed/web': 'https://github.com/acme/web',
      '/mixed/personal': 'https://github.com/me/side-project',
    });

    await service.runNow();

    expect(convertMultiRepo).toHaveBeenCalled();
    expect(events).toContainEqual({
      outcome: 'converted',
      workspaceId: 'mixed',
      organizationId: ORG_A,
      projectId: MULTI_PROJECT,
    });
  });

  it('leaves a project whose checkouts all have no remote alone', async (): Promise<void> => {
    multiRepo('remote-less', {
      '/remote-less': null,
      '/remote-less/web': null,
      '/remote-less/api': null,
    });

    await service.runNow();

    expect(convertMultiRepo).not.toHaveBeenCalled();
    expect(events).toEqual([]);
  });

  it('converts a mixed project with a held repository', async (): Promise<void> => {
    multiRepo('mixed', {
      '/mixed/web': 'https://github.com/acme/web',
      '/mixed/personal': 'https://github.com/me/side-project',
    });

    await service.runNow();
    await service.runNow();

    expect(convertMultiRepo).toHaveBeenCalled();
    expect(events).toContainEqual({
      outcome: 'converted',
      workspaceId: 'mixed',
      organizationId: ORG_A,
      projectId: MULTI_PROJECT,
    });
  });

  it('keeps a project whose repositories span organizations Personal', async (): Promise<void> => {
    catalogs.set(
      ORG_B,
      snapshot(ORG_B, [project(API_B, ORG_B, 'billing', '200')]),
    );
    multiRepo('spread', {
      '/spread/web': 'https://github.com/acme/web',
      '/spread/billing': 'https://github.com/acme/billing',
    });

    await service.runNow();

    expect(convertMultiRepo).not.toHaveBeenCalled();
    expect(events).toEqual([
      {
        outcome: 'skipped',
        workspaceId: 'spread',
        reason: 'repositories-span-organizations',
        organizationCount: 2,
      },
    ]);
  });

  it('never guesses between two organizations that both hold every repository', async (): Promise<void> => {
    catalogs.set(ORG_B, snapshot(ORG_B, [project(API_B, ORG_B, 'web', '101')]));
    multiRepo('both', { '/both/web': 'https://github.com/acme/web' });

    await service.runNow();

    expect(convertMultiRepo).not.toHaveBeenCalled();
    expect(events).toEqual([
      {
        outcome: 'skipped',
        workspaceId: 'both',
        reason: 'ambiguous-organizations',
        organizationCount: 2,
      },
    ]);
  });

  it('refuses even when one organization holds everything and another holds a subset', async () => {
    catalogs.set(ORG_B, snapshot(ORG_B, [project(API_B, ORG_B, 'web', '101')]));
    multiRepo('overlap', {
      '/web': 'https://github.com/acme/web',
      '/api': 'https://github.com/acme/api',
    });
    await service.runNow();
    expect(convertMultiRepo).not.toHaveBeenCalled();
    expect(events).toContainEqual({
      outcome: 'skipped',
      workspaceId: 'overlap',
      reason: 'ambiguous-organizations',
      organizationCount: 2,
    });
  });

  it('leaves a project with no repositories, or none of the organization, alone without a diagnostic', async (): Promise<void> => {
    multiRepo('empty', {});
    multiRepo('personal-only', {
      '/personal-only/a': 'https://github.com/me/a',
      '/personal-only/b': null,
    });

    await service.runNow();

    expect(convertMultiRepo).not.toHaveBeenCalled();
    expect(events).toEqual([]);
  });

  it('does not decide while another organization catalog is unknown', async (): Promise<void> => {
    catalogs.delete(ORG_B);
    multiRepo('platform', { '/platform/web': 'https://github.com/acme/web' });

    await service.runNow();

    expect(convertMultiRepo).not.toHaveBeenCalled();
    expect(events).toEqual([
      {
        outcome: 'skipped',
        workspaceId: 'platform',
        reason: 'catalog-unavailable',
      },
    ]);
  });

  it.each([
    { stale: true, error: 'offline' as const },
    { stale: true, error: null },
    { stale: false, error: 'offline' as const },
  ])(
    'does not infer unheld repositories from a cached incomplete catalog: %j',
    async (status) => {
      catalogs.set(ORG_B, snapshot(ORG_B, [], status));
      multiRepo('mixed-cached', {
        '/mixed-cached/web': 'https://github.com/acme/web',
        '/mixed-cached/billing': 'https://github.com/acme/billing',
      });

      await service.runNow();

      expect(convertMultiRepo).not.toHaveBeenCalled();
      expect(events).toContainEqual({
        outcome: 'skipped',
        workspaceId: 'mixed-cached',
        reason: 'catalog-unavailable',
      });
      catalogs.set(
        ORG_B,
        snapshot(ORG_B, [project(API_B, ORG_B, 'billing', '200')]),
      );
      await service.runNow();
      expect(convertMultiRepo).not.toHaveBeenCalled();
      expect(events).toContainEqual({
        outcome: 'skipped',
        workspaceId: 'mixed-cached',
        reason: 'repositories-span-organizations',
        organizationCount: 2,
      });
      catalogs.set(ORG_B, snapshot(ORG_B, []));
      await service.runNow();
      // The first complete decision closes the one-time pass. A later
      // catalog change cannot move the workspace automatically.
      expect(convertMultiRepo).not.toHaveBeenCalled();
    },
  );

  it('skips a project Git cannot read, and one moved back to Personal', async (): Promise<void> => {
    multiRepo('unreadable', {
      '/unreadable/web': 'https://github.com/acme/web',
      '/unreadable/api': new Error('git failed'),
    });
    multiRepo('moved-back', {
      '/moved-back/web': 'https://github.com/acme/web',
    });
    ownership.set('moved-back', {
      authority: 'ok',
      type: 'multi-repo',
      ownershipTransfer: {
        version: 1,
        previousOwner: { type: 'personal' },
        organizationId: ORG_A,
        projectId: MULTI_PROJECT,
        convertedAt: '2026-09-01T00:00:00.000Z',
        movedBackAt: '2026-09-02T00:00:00.000Z',
      },
    });

    await service.runNow();

    expect(convertMultiRepo).not.toHaveBeenCalled();
    expect(events).toEqual([
      {
        outcome: 'skipped',
        workspaceId: 'unreadable',
        reason: 'repository-unavailable',
      },
      { outcome: 'skipped', workspaceId: 'moved-back', reason: 'moved-back' },
    ]);
  });

  it('retries a transient refusal with backoff, and remembers one that cannot succeed', async (): Promise<void> => {
    multiRepo('platform', { '/platform/web': 'https://github.com/acme/web' });
    convertMultiRepo.mockResolvedValueOnce({
      ok: false,
      code: 'member-project-limit',
    });

    await service.runNow();
    expect(events).toEqual([
      {
        outcome: 'failed',
        workspaceId: 'platform',
        organizationId: ORG_A,
        reason: 'member-project-limit',
        retry: 'later',
      },
    ]);
    await service.runNow();
    expect(convertMultiRepo).toHaveBeenCalledTimes(1);

    clock += ORG_PROJECT_AUTO_CONVERSION_RETRY_BASE_MS;
    convertMultiRepo.mockResolvedValue({
      ok: false,
      code: 'repository-mismatch',
    });
    await service.runNow();
    clock += 24 * 60 * 60_000;
    await service.runNow();
    expect(convertMultiRepo).toHaveBeenCalledTimes(2);
    expect(events.at(-1)).toMatchObject({
      outcome: 'failed',
      reason: 'repository-mismatch',
      retry: 'never-this-session',
    });
  });

  it('never auto-moves a multi-repo project added after the pass completed', async (): Promise<void> => {
    await service.runNow();
    expect(passOf(ORG_A)?.completedAt).toBe(at(clock));

    multiRepo('platform', {
      '/platform/web': 'https://github.com/acme/web',
      '/platform/api': 'https://github.com/acme/api.git',
    });
    await service.runNow();

    expect(readRemoteUrl).not.toHaveBeenCalled();
    expect(convertMultiRepo).not.toHaveBeenCalled();
  });

  it('does not move a multi-repo project into an organization whose pass is over', async (): Promise<void> => {
    ledger = {
      version: 1,
      organizations: {
        [ORG_A]: {
          startedAt: '2026-09-01T00:00:00.000Z',
          eligibleWorkspaceIds: [],
          completedAt: '2026-09-01T00:00:00.000Z',
        },
      },
    };
    multiRepo('platform', { '/platform/web': 'https://github.com/acme/web' });

    await service.runNow();

    expect(passOf(ORG_B)?.eligibleWorkspaceIds).toEqual(['platform']);
    expect(convertMultiRepo).not.toHaveBeenCalled();
    expect(events).toEqual([
      {
        outcome: 'skipped',
        workspaceId: 'platform',
        reason: 'outside-migration-pass',
        organizationId: ORG_A,
      },
    ]);
  });

  it('keeps the pass open while a multi-repo conversion waits to be retried', async (): Promise<void> => {
    multiRepo('platform', { '/platform/web': 'https://github.com/acme/web' });
    convertMultiRepo.mockResolvedValueOnce({ ok: false, code: 'offline' });

    await service.runNow();
    expect(passOf(ORG_A)?.completedAt).toBeUndefined();

    clock += ORG_PROJECT_AUTO_CONVERSION_RETRY_BASE_MS;
    await service.runNow();
    expect(convertMultiRepo).toHaveBeenCalledTimes(2);
    expect(passOf(ORG_A)?.completedAt).toBe(at(clock));
  });

  it('matches no single-repo checkout to a multi-repo project that copies its repository', async (): Promise<void> => {
    catalogs.set(
      ORG_A,
      snapshot(ORG_A, [
        project(PROJECT_A, ORG_A),
        { ...project(MULTI_PROJECT, ORG_A), topology: 'multi-repo' },
      ]),
    );
    personal('personal-repo');

    await service.runNow();

    expect(convert).toHaveBeenCalledWith(
      {
        workspaceId: 'personal-repo',
        organizationId: ORG_A,
        projectId: PROJECT_A,
      },
      { automatic: true },
    );
  });
});

describe('migration pass eligibility comes from the authoritative workspace index', (): void => {
  it('does not start a pass while the workspace index cannot be read in full', async (): Promise<void> => {
    personal('personal-repo');
    indexAuthoritative = false;

    await service.runNow();

    expect(passOf(ORG_A)).toBeUndefined();
    expect(convert).not.toHaveBeenCalled();

    // The next run with an authoritative index starts it and converts.
    indexAuthoritative = true;
    await service.runNow();

    expect(passOf(ORG_A)?.eligibleWorkspaceIds).toEqual(['personal-repo']);
    expect(convert).toHaveBeenCalledTimes(1);
  });

  it('keeps a workspace the sidebar could not read eligible, and its pass open until it converts', async (): Promise<void> => {
    personal('personal-repo');
    unprojected.add('personal-repo');

    await service.runNow();

    expect(passOf(ORG_A)?.eligibleWorkspaceIds).toEqual(['personal-repo']);
    expect(passOf(ORG_A)?.completedAt).toBeUndefined();
    expect(convert).not.toHaveBeenCalled();

    // Readable again (and created long before a new workspace would be).
    unprojected.clear();
    await service.runNow();

    expect(convert).toHaveBeenCalledTimes(1);
    expect(passOf(ORG_A)?.completedAt).toBeDefined();
  });

  it('does not keep a pass open for an eligible workspace that was removed', async (): Promise<void> => {
    personal('removed-repo', 'git@github.com:somebody/else.git');
    unprojected.add('removed-repo');
    await service.runNow();
    expect(passOf(ORG_A)?.completedAt).toBeUndefined();

    workspaces = workspaces.filter(
      (workspace): boolean => workspace.id !== 'removed-repo',
    );
    await service.runNow();

    expect(passOf(ORG_A)?.completedAt).toBeDefined();
  });
});

describe('a migration pass completes only on evidence', (): void => {
  it('does not complete a pass from a catalog fetched before the pass started', async (): Promise<void> => {
    personal('elsewhere-repo', 'git@github.com:somebody/else.git');
    catalogs.set(
      ORG_A,
      snapshot(ORG_A, [project(PROJECT_A, ORG_A)], {
        fetchedAt: '2026-09-20T00:00:00.000Z',
      }),
    );

    await service.runNow();

    expect(passOf(ORG_A)).toBeDefined();
    expect(passOf(ORG_A)?.completedAt).toBeUndefined();

    // A refresh after the pass started settles it.
    clock += 60_000;
    catalogs.set(
      ORG_A,
      snapshot(ORG_A, [project(PROJECT_A, ORG_A)], { fetchedAt: at(clock) }),
    );
    await service.runNow();

    expect(passOf(ORG_A)?.completedAt).toBeDefined();
  });

  it('keeps the pass of an organization with no projects open, and converts once it has one', async (): Promise<void> => {
    personal('b-repo', 'git@github.com:acme/b-repo.git');
    catalogs.set(ORG_B, snapshot(ORG_B, []));

    await service.runNow();

    // Organization B lists nothing yet: its admin has not added projects.
    expect(passOf(ORG_B)?.completedAt).toBeUndefined();
    expect(convert).not.toHaveBeenCalled();

    clock += 60_000;
    catalogs.set(
      ORG_B,
      snapshot(ORG_B, [project(PROJECT_B, ORG_B, 'b-repo', '456')], {
        fetchedAt: at(clock),
      }),
    );
    await service.runNow();

    expect(convert).toHaveBeenCalledWith(
      { workspaceId: 'b-repo', organizationId: ORG_B, projectId: PROJECT_B },
      { automatic: true },
    );
    expect(passOf(ORG_B)?.completedAt).toBeDefined();
  });

  it('expires the pass of an organization that never lists a project', async (): Promise<void> => {
    catalogs.set(ORG_B, snapshot(ORG_B, []));
    await service.runNow();
    expect(passOf(ORG_B)?.completedAt).toBeUndefined();
    const startedAt = Date.parse(passOf(ORG_B)?.startedAt ?? '');

    clock = startedAt + ORG_PROJECT_MIGRATION_PASS_MAX_MS;
    catalogs.set(ORG_B, snapshot(ORG_B, [], { fetchedAt: at(clock) }));
    await service.runNow();

    expect(passOf(ORG_B)?.completedAt).toBeDefined();
  });

  it('leaves indexed ids the ledger cannot hold out of a pass instead of failing it', async (): Promise<void> => {
    personal('personal-repo');
    personal('Legacy_ID');
    unprojected.add('Legacy_ID');

    await service.runNow();

    expect(passOf(ORG_A)?.eligibleWorkspaceIds).toEqual(['personal-repo']);
    expect(convert).toHaveBeenCalledTimes(1);
    expect(failures).toEqual([]);
  });

  it('keeps a pass open while a workspace ownership read is unreadable', async (): Promise<void> => {
    personal('personal-repo');
    ownership.set('personal-repo', { authority: 'unreadable' });

    await service.runNow();

    expect(convert).not.toHaveBeenCalled();
    expect(passOf(ORG_A)?.completedAt).toBeUndefined();

    ownership.set('personal-repo', { authority: 'ok', type: 'single-repo' });
    await service.runNow();

    expect(convert).toHaveBeenCalledTimes(1);
  });
});

it('reports once, and converts nothing into, an organization id the ledger cannot hold', async (): Promise<void> => {
  organizationIds = [ORG_A, 'not an id'];
  catalogs.set('not an id', snapshot('not an id', []));
  personal('personal-repo');

  await service.runNow();
  await service.runNow();

  expect(passOf('not an id')).toBeUndefined();
  // The supported organization still gets its pass.
  expect(convert).toHaveBeenCalledTimes(1);
  expect(
    failures.filter(
      (failure): boolean =>
        failure instanceof Error &&
        failure.message === 'migration-pass-organization-id-unsupported',
    ),
  ).toHaveLength(1);
});

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function combination(id = 'combined'): void {
  workspaces.push({
    id,
    repoPath: null,
    temporary: true,
    repoPaths: [`/${id}/held`, `/${id}/unheld`],
  });
  ownership.set(id, { authority: 'ok', type: 'multi-repo' });
  remotes.set(`/${id}/held`, REMOTE);
  remotes.set(`/${id}/unheld`, 'https://github.com/me/unheld');
}

describe('CAN-3846 inline conversion', () => {
  it('returns the decision from the same selector, persists ownership, and the next scan leaves it alone', async () => {
    combination();
    await expect(service.convertNow('combined')).resolves.toEqual({
      outcome: 'converted',
      workspaceId: 'combined',
      organizationId: ORG_A,
      projectId: MULTI_PROJECT,
    });
    expect(ownership.get('combined')).toMatchObject({
      owner: { organizationId: ORG_A, projectId: MULTI_PROJECT },
    });
    await service.runNow();
    await expect(service.convertNow('combined')).resolves.toBeNull();
    expect(convertMultiRepo).toHaveBeenCalledTimes(1);
  });

  it('returns deduplicated cross-organization refusals without recording twice', async () => {
    combination();
    catalogs.set(
      ORG_B,
      snapshot(ORG_B, [project(PROJECT_B, ORG_B, 'other', '456')]),
    );
    remotes.set('/combined/unheld', 'https://github.com/acme/other');
    const expected = {
      outcome: 'skipped',
      workspaceId: 'combined',
      reason: 'repositories-span-organizations',
      organizationCount: 2,
    };
    await expect(service.convertNow('combined')).resolves.toEqual(expected);
    await expect(service.convertNow('combined')).resolves.toEqual(expected);
    expect(events).toEqual([expected]);
    expect(convertMultiRepo).not.toHaveBeenCalled();
  });

  it.each(['missing', 'stale', 'unreadable', 'no-convertible'] as const)(
    'preserves selector guards: %s',
    async (guard) => {
      combination();
      if (guard === 'missing') catalogs.delete(ORG_B);
      if (guard === 'stale')
        catalogs.set(ORG_B, snapshot(ORG_B, [], { stale: true }));
      if (guard === 'unreadable')
        remotes.set('/combined/unheld', new Error('remote read failed'));
      if (guard === 'no-convertible')
        catalogs.set(
          ORG_A,
          snapshot(ORG_A, [
            { ...project(PROJECT_A, ORG_A), state: 'ARCHIVED' },
          ]),
        );
      const event = await service.convertNow('combined');
      expect(convertMultiRepo).not.toHaveBeenCalled();
      if (guard === 'no-convertible') expect(event).toBeNull();
      else
        expect(event).toMatchObject({
          outcome: 'skipped',
          reason:
            guard === 'unreadable'
              ? 'repository-unavailable'
              : 'catalog-unavailable',
        });
    },
  );

  it.each([
    'disabled',
    'signed-out',
    'capability',
    'membership',
    'disposed',
    'missing',
    'owned',
    'single-repo',
  ] as const)('does no inline conversion for %s', async (guard) => {
    combination();
    if (guard === 'disabled') enabled = false;
    if (guard === 'signed-out')
      access.mockResolvedValue({
        accountId: null,
        capabilities,
        organizationIds,
      });
    if (guard === 'capability') capabilities = [];
    if (guard === 'membership') organizationIds = [];
    if (guard === 'disposed') service.dispose();
    if (guard === 'missing') workspaces = [];
    if (guard === 'owned')
      workspaces = workspaces.map((workspace) => ({
        ...workspace,
        owner: bound,
      }));
    if (guard === 'single-repo')
      workspaces = [{ id: 'combined', repoPath: '/combined/held' }];
    await expect(service.convertNow('combined')).resolves.toBeNull();
    expect(convertMultiRepo).not.toHaveBeenCalled();
    expect(convert).not.toHaveBeenCalled();
  });

  it.each(['member-project-limit', 'offline', 'busy'] as const)(
    'shares %s backoff with scans and retries after expiry',
    async (code) => {
      combination();
      convertMultiRepo.mockResolvedValueOnce({ ok: false, code });
      await expect(service.convertNow('combined')).resolves.toMatchObject({
        outcome: 'failed',
        reason: code,
        retry: 'later',
      });
      await service.runNow();
      await expect(service.convertNow('combined')).resolves.toBeNull();
      expect(convertMultiRepo).toHaveBeenCalledTimes(1);
      clock += ORG_PROJECT_AUTO_CONVERSION_RETRY_BASE_MS;
      await expect(service.convertNow('combined')).resolves.toMatchObject({
        outcome: 'converted',
      });
      expect(convertMultiRepo).toHaveBeenCalledTimes(2);
    },
  );

  it('preserves permanent refusals and resets them on an account change', async () => {
    combination();
    convertMultiRepo.mockResolvedValueOnce({
      ok: false,
      code: 'repository-mismatch',
    });
    await expect(service.convertNow('combined')).resolves.toMatchObject({
      outcome: 'failed',
      retry: 'never-this-session',
    });
    clock += 24 * 60 * 60_000;
    await service.runNow();
    await expect(service.convertNow('combined')).resolves.toBeNull();
    expect(convertMultiRepo).toHaveBeenCalledTimes(1);
    access.mockResolvedValue({
      accountId: 'other',
      capabilities,
      organizationIds,
    });
    await expect(service.convertNow('combined')).resolves.toMatchObject({
      outcome: 'converted',
    });
  });

  it.each([true, false])(
    'waits for a scan and reads fresh state after it (scan binds target: %s)',
    async (binds) => {
      combination();
      const started = deferred<void>();
      const blocked = deferred<OrgProjectConversionResult>();
      convertMultiRepo.mockImplementationOnce(() => {
        started.resolve();
        return blocked.promise;
      });
      const scan = service.runNow();
      await started.promise;
      const inline = service.convertNow('combined');
      expect(convertMultiRepo).toHaveBeenCalledTimes(1);
      blocked.resolve(
        binds
          ? converted(
              {
                workspaceId: 'combined',
                organizationId: ORG_A,
                projectId: MULTI_PROJECT,
              },
              'multi-repo',
            )
          : { ok: false, code: 'busy' },
      );
      await scan;
      await expect(inline).resolves.toBeNull();
      expect(readWorkspaces).toHaveBeenCalledTimes(2);
      expect(convertMultiRepo).toHaveBeenCalledTimes(1);
    },
  );

  it('serializes simultaneous inline calls without losing different destinations or duplicating the same one', async () => {
    combination('one');
    combination('two');
    const started = deferred<void>();
    const blocked = deferred<void>();
    convertMultiRepo.mockImplementationOnce(async (request) => {
      started.resolve();
      await blocked.promise;
      return converted({ ...request, projectId: MULTI_PROJECT }, 'multi-repo');
    });
    const first = service.convertNow('one');
    await started.promise;
    const second = service.convertNow('two');
    const duplicate = service.convertNow('one');
    expect(convertMultiRepo).toHaveBeenCalledTimes(1);
    blocked.resolve();
    const decisions = await Promise.all([first, second, duplicate]);
    expect(decisions.map((event) => event?.outcome ?? null)).toEqual([
      'converted',
      'converted',
      null,
    ]);
    expect(
      convertMultiRepo.mock.calls.map(([request]) => request.workspaceId),
    ).toEqual(['one', 'two']);
  });

  it('coalesces triggers and a timer during inline work into one later scan', async () => {
    jest.useFakeTimers();
    combination();
    service.start();
    const started = deferred<void>();
    const blocked = deferred<void>();
    convertMultiRepo.mockImplementationOnce(async (request) => {
      started.resolve();
      await blocked.promise;
      return converted({ ...request, projectId: MULTI_PROJECT }, 'multi-repo');
    });
    const inline = service.convertNow('combined');
    await started.promise;
    service.trigger();
    service.trigger();
    await jest.advanceTimersByTimeAsync(
      ORG_PROJECT_AUTO_CONVERSION_STARTUP_DELAY_MS,
    );
    expect(access).toHaveBeenCalledTimes(2);
    blocked.resolve();
    await inline;
    await jest.advanceTimersByTimeAsync(
      ORG_PROJECT_AUTO_CONVERSION_DEBOUNCE_MS,
    );
    expect(access).toHaveBeenCalledTimes(3);
    await jest.advanceTimersByTimeAsync(
      ORG_PROJECT_AUTO_CONVERSION_DEBOUNCE_MS * 3,
    );
    expect(access).toHaveBeenCalledTimes(3);
    expect(convertMultiRepo).toHaveBeenCalledTimes(1);
  });

  it('disposal prevents queued work and follow-up scans while preserving an already committed conversion', async () => {
    jest.useFakeTimers();
    combination('one');
    combination('two');
    const started = deferred<void>();
    const blocked = deferred<void>();
    convertMultiRepo.mockImplementationOnce(async (request) => {
      started.resolve();
      await blocked.promise;
      return converted({ ...request, projectId: MULTI_PROJECT }, 'multi-repo');
    });
    const first = service.convertNow('one');
    await started.promise;
    const queued = service.convertNow('two');
    service.trigger();
    service.dispose();
    blocked.resolve();
    await expect(first).resolves.toMatchObject({ outcome: 'converted' });
    await expect(queued).resolves.toBeNull();
    expect(convertMultiRepo).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('recovers from conversion, workspace-read, and diagnostic failures', async () => {
    combination();
    readWorkspaces.mockImplementationOnce(() => {
      throw new Error('workspace read');
    });
    reportFailure.mockImplementation(() => {
      throw new Error('diagnostic sink');
    });
    await expect(service.convertNow('combined')).resolves.toBeNull();
    convertMultiRepo.mockRejectedValueOnce(new Error('conversion failed'));
    await expect(service.convertNow('combined')).resolves.toMatchObject({
      outcome: 'failed',
      reason: 'conversion-failed',
    });
    clock += ORG_PROJECT_AUTO_CONVERSION_RETRY_BASE_MS;
    record.mockImplementation(() => {
      throw new Error('session sink');
    });
    await expect(service.convertNow('combined')).resolves.toMatchObject({
      outcome: 'converted',
    });
    await service.runNow();
    await expect(service.convertNow('combined')).resolves.toBeNull();
    expect(convertMultiRepo).toHaveBeenCalledTimes(2);
  });

  it('acquires serialization before synchronous work throws and releases it before settling', async () => {
    access.mockImplementationOnce(() => {
      throw new Error('synchronous access');
    });
    reportFailure.mockImplementation(() => {
      throw new Error('failure sink');
    });
    await expect(service.runNow()).resolves.toBeUndefined();
    combination();
    await expect(service.convertNow('combined')).resolves.toMatchObject({
      outcome: 'converted',
    });
    await service.runNow();
    expect(access).toHaveBeenCalledTimes(4);
  });
});

describe('inline binding isolated from migration passes', () => {
  it.each(['completed', 'open', 'unused', 'unreadable'] as const)(
    'does not read or mutate a %s pass ledger',
    async (state) => {
      if (state === 'completed' || state === 'open') {
        personal('prior');
        if (state === 'open')
          convert.mockResolvedValue({ ok: false, code: 'offline' });
        await service.runNow();
      }
      if (state === 'unreadable') ledger = 'unreadable';
      const before = JSON.stringify(ledger);
      combination();
      readPasses.mockClear();
      updatePasses.mockClear();
      if (state === 'completed') {
        await service.runNow();
        expect(convertMultiRepo).not.toHaveBeenCalled();
        readPasses.mockClear();
      }
      await expect(service.convertNow('combined')).resolves.toMatchObject({
        outcome: 'converted',
      });
      expect(readPasses).not.toHaveBeenCalled();
      expect(updatePasses).not.toHaveBeenCalled();
      expect(JSON.stringify(ledger)).toBe(before);
    },
  );

  it.each([true, false])(
    'ignores excluded holders (eligible holder present: %s)',
    async (eligible) => {
      combination();
      catalogs.set(ORG_B, snapshot(ORG_B, [project(PROJECT_B, ORG_B)]));
      if (!eligible) catalogs.set(ORG_A, snapshot(ORG_A, []));
      access.mockImplementation(() =>
        Promise.resolve({
          accountId: 'account',
          capabilities,
          organizationIds: [ORG_A, ORG_B, ORG_A.toUpperCase()],
          excludedOrganizationIds: [ORG_B.toUpperCase()],
        }),
      );
      const result = await service.convertNow('combined');
      if (eligible)
        expect(result).toMatchObject({
          outcome: 'converted',
          organizationId: ORG_A,
        });
      else expect(result).toBeNull();
      expect(loadCatalog.mock.calls).toEqual([[ORG_A]]);
      expect(convertMultiRepo).toHaveBeenCalledTimes(eligible ? 1 : 0);
    },
  );

  it.each([
    'retired',
    'permanent',
    'ownership-unreadable',
    'moved-back',
    'previously-converted',
    'unavailable',
  ] as const)('preserves the %s guard', async (guard) => {
    combination();
    if (guard === 'retired')
      workspaces = workspaces.map((item) => ({ ...item, retired: true }));
    if (guard === 'permanent')
      workspaces = workspaces.map((item) => ({ ...item, temporary: false }));
    if (guard === 'ownership-unreadable')
      ownership.set('combined', { authority: 'unreadable' });
    if (guard === 'moved-back' || guard === 'previously-converted')
      ownership.set('combined', {
        authority: 'ok',
        type: 'multi-repo',
        ownershipTransfer: {
          version: 1,
          previousOwner: { type: 'personal' },
          organizationId: ORG_A,
          projectId: MULTI_PROJECT,
          convertedAt: at(clock),
          ...(guard === 'moved-back' ? { movedBackAt: at(clock) } : {}),
        },
      });
    if (guard === 'unavailable')
      catalogs.set(ORG_A, snapshot(ORG_A, [], { error: 'unavailable' }));
    await service.convertNow('combined');
    expect(convertMultiRepo).not.toHaveBeenCalled();
    expect(updatePasses).not.toHaveBeenCalled();
  });

  it.each([
    'disposed',
    'disabled',
    'account',
    'membership',
    'capability',
    'excluded',
  ] as const)('rechecks %s after awaiting catalogs', async (change) => {
    combination();
    const entered = deferred<void>();
    const blocked = deferred<void>();
    loadCatalog.mockImplementationOnce(async () => {
      entered.resolve();
      await blocked.promise;
      return snapshot(ORG_A, [project(PROJECT_A, ORG_A)]);
    });
    const decision = service.convertNow('combined');
    await entered.promise;
    if (change === 'disposed') service.dispose();
    if (change === 'disabled') enabled = false;
    if (change === 'membership') organizationIds = [ORG_B];
    if (change === 'capability') capabilities = [];
    if (change === 'account' || change === 'excluded')
      access.mockResolvedValue({
        accountId: change === 'account' ? 'other' : 'account',
        capabilities,
        organizationIds,
        excludedOrganizationIds:
          change === 'excluded' ? [ORG_A.toUpperCase()] : [],
      });
    blocked.resolve();
    await decision;
    expect(convertMultiRepo).not.toHaveBeenCalled();
    expect(readPasses).not.toHaveBeenCalled();
  });

  it('queues inline access reads after a scan and uses changed membership', async () => {
    personal('prior');
    const entered = deferred<void>();
    const blocked = deferred<OrgProjectConversionResult>();
    convert.mockImplementationOnce(() => {
      entered.resolve();
      return blocked.promise;
    });
    const scan = service.runNow();
    await entered.promise;
    combination();
    const inline = service.convertNow('combined');
    const reads = access.mock.calls.length;
    organizationIds = [];
    blocked.resolve({ ok: false, code: 'busy' });
    await scan;
    await expect(inline).resolves.toBeNull();
    expect(access.mock.calls.length).toBeGreaterThan(reads);
    expect(convertMultiRepo).not.toHaveBeenCalled();
  });

  it('runs a coalesced scan after an inline decision releases the queue', async () => {
    jest.useFakeTimers();
    combination();
    personal('prior');
    const entered = deferred<void>();
    const blocked = deferred<void>();
    convertMultiRepo.mockImplementationOnce(async (request) => {
      entered.resolve();
      await blocked.promise;
      return converted({ ...request, projectId: MULTI_PROJECT }, 'multi-repo');
    });
    const inline = service.convertNow('combined');
    await entered.promise;
    const scan = service.runNow();
    service.trigger();
    expect(convert).not.toHaveBeenCalled();
    expect(readPasses).not.toHaveBeenCalled();
    blocked.resolve();
    await Promise.all([inline, scan]);
    await jest.advanceTimersByTimeAsync(
      ORG_PROJECT_AUTO_CONVERSION_DEBOUNCE_MS,
    );
    expect(convert).toHaveBeenCalledTimes(1);
  });
});

it('normalizes and deduplicates member and exclusion IDs before catalog and fresh authorization checks', async () => {
  const holder = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const excluded = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  combination();
  catalogs.set(holder, snapshot(holder, [project(PROJECT_A, holder)]));
  catalogs.set(excluded, snapshot(excluded, [project(PROJECT_B, excluded)]));
  access.mockResolvedValue({
    accountId: 'account',
    capabilities,
    organizationIds: [holder.toUpperCase(), holder, excluded.toUpperCase()],
    excludedOrganizationIds: [excluded.toUpperCase()],
  });
  await expect(service.convertNow('combined')).resolves.toMatchObject({
    outcome: 'converted',
    organizationId: holder,
  });
  expect(loadCatalog.mock.calls).toEqual([[holder]]);
  expect(convertMultiRepo).toHaveBeenCalledWith(
    { workspaceId: 'combined', organizationId: holder },
    { automatic: true },
  );
});

it('resets inline retry backoff and skip diagnostic deduplication on account change', async () => {
  combination();
  convertMultiRepo.mockResolvedValueOnce({ ok: false, code: 'offline' });
  await service.convertNow('combined');
  await expect(service.convertNow('combined')).resolves.toBeNull();
  access.mockResolvedValue({
    accountId: 'other',
    capabilities,
    organizationIds,
  });
  await expect(service.convertNow('combined')).resolves.toMatchObject({
    outcome: 'converted',
  });
  expect(convertMultiRepo).toHaveBeenCalledTimes(2);

  combination('cross');
  remotes.set('/cross/unheld', 'https://github.com/acme/other');
  catalogs.set(
    ORG_B,
    snapshot(ORG_B, [project(PROJECT_B, ORG_B, 'other', '456')]),
  );
  await service.convertNow('cross');
  await service.convertNow('cross');
  access.mockResolvedValue({
    accountId: 'third',
    capabilities,
    organizationIds,
  });
  await service.convertNow('cross');
  expect(events.filter((event) => event.workspaceId === 'cross')).toHaveLength(
    2,
  );
});

it('retains scan retries when capability changes before coordinator admission', async () => {
  combination();
  access.mockResolvedValueOnce({
    accountId: 'account',
    capabilities,
    organizationIds,
  });
  access.mockResolvedValueOnce({
    accountId: 'account',
    capabilities: [],
    organizationIds,
  });
  convertMultiRepo.mockResolvedValue({ ok: false, code: 'disabled' });
  await service.runNow();
  expect(convertMultiRepo).toHaveBeenCalledTimes(1);
  expect(events).toContainEqual(
    expect.objectContaining({
      outcome: 'failed',
      reason: 'disabled',
      retry: 'later',
    }),
  );
  expect(passOf(ORG_A)?.completedAt).toBeUndefined();
});
