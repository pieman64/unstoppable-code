jest.mock('../canopy-cloud/personal-organization-upgrade', () => ({
  readPersonalProjectConversionPolicy: (): Promise<{
    accountId: string;
    organizationIds: string[];
    excludedOrganizationIds: string[];
  }> =>
    Promise.resolve({
      accountId: 'account',
      organizationIds: [ORG],
      excludedOrganizationIds: [],
    }),
}));
/** @jest-environment node */
import type {
  DesktopOrgProjectCatalogSnapshot,
  MultiRepoSidebarItem,
  OrgProjectConversionResult,
  OrgProjectConvertMultiRepoWorkspaceRequest,
  WorkspaceOwnerBinding,
} from '@canopy/desktop-shared/types';
import type {
  OrgProjectMigrationPassesFile,
  OrgProjectMigrationPassesRead,
  OrgProjectMigrationPassStore,
} from '../lib/org-project-migration-passes';

const ORG = '11111111-1111-4111-8111-111111111111';
const PROJECT = '33333333-3333-4333-8333-333333333331';

const mockFlag = jest.fn((): boolean => true);
const flagListeners: Array<() => void> = [];
const catalogListeners: Array<
  (snapshot: DesktopOrgProjectCatalogSnapshot) => void
> = [];
const contextListeners: Array<(state: { reason: string }) => void> = [];
const mockSessionDiagnostic = jest.fn<void, [Record<string, unknown>]>();
const mockAppDiagnostic = jest.fn<void, [Record<string, unknown>]>();
const mockConvert = jest.fn();
const mockConvertMultiRepo = jest.fn();
const mockList = jest.fn();
let mockItems: Array<Record<string, unknown> & { id: string }> = [];
const mockOwnershipType = jest.fn((): string => 'single-repo');
/** The in-memory pass ledger the production store is swapped for. */
let mockLedger: OrgProjectMigrationPassesFile | null = null;
const mockReadPasses = jest.fn();
const mockUpdatePasses = jest.fn();
let mockLedgerFilePath: (() => string) | null = null;

jest.mock('../feature-flags', () => ({
  getFeatureFlagService: (): object => ({
    isEnabled: mockFlag,
    onSnapshotChanged: (listener: () => void): (() => void) => {
      flagListeners.push(listener);
      return (): void => {};
    },
  }),
}));
jest.mock('../observability', () => ({
  getObservabilityService: (): object => ({
    recordSessionDiagnostic: mockSessionDiagnostic,
    recordAppDiagnostic: mockAppDiagnostic,
  }),
}));
jest.mock('../lib/canopy-cloud-account-store', () => ({
  getCanopyCloudCredentials: (): Promise<object> =>
    Promise.resolve({
      account: { id: 'account' },
      capabilities: ['org-projects-v1'],
    }),
}));
jest.mock('../lib/git', () => ({
  getRemoteUrlStrict: (): Promise<string> =>
    Promise.resolve('https://github.com/acme/repo.git'),
}));
jest.mock('../lib/org-project-materialization', () => ({
  getOrgProjectMaterialization: (): object => ({
    convertWorkspace: mockConvert,
    convertMultiRepoWorkspace: mockConvertMultiRepo,
  }),
}));
jest.mock('../lib/sidebar-items', () => ({
  readAllSidebarItemsSnapshot: (): Promise<object> =>
    Promise.resolve({
      file: { version: 1, items: mockItems },
      authority: 'ok',
      indexAuthority: 'ok',
      indexedWorkspaceIds: mockItems.map((item: { id: string }) => item.id),
    }),
}));
jest.mock('../lib/workspace-context-service', () => ({
  getWorkspaceContextService: (): object => ({
    getState: (): object => ({ organizations: [{ id: ORG }] }),
    subscribe: (
      listener: (state: { reason: string }) => void,
    ): (() => void) => {
      contextListeners.push(listener);
      return (): void => {};
    },
  }),
}));
jest.mock('../lib/workspace-persistence', () => ({
  readWorkspaceOwnership: (): Promise<object> =>
    Promise.resolve({ authority: 'ok', type: mockOwnershipType() }),
}));
jest.mock('../lib/org-project-migration-passes', () => ({
  ORG_PROJECT_MIGRATION_PASSES_UNREADABLE: 'migration-passes-unreadable',
  isMigrationPassOrganizationId: (organizationId: string): boolean =>
    /^[a-z0-9][a-z0-9-]*$/.test(organizationId),
  isMigrationPassWorkspaceId: (workspaceId: string): boolean =>
    /^[a-z0-9][a-z0-9-]*$/.test(workspaceId),
  createOrgProjectMigrationPassStore: (
    filePath: () => string,
  ): OrgProjectMigrationPassStore => {
    mockLedgerFilePath = filePath;
    return {
      read: (): Promise<OrgProjectMigrationPassesRead> => {
        mockReadPasses();
        return Promise.resolve(
          mockLedger === null
            ? { status: 'unreadable' }
            : { status: 'ok', file: mockLedger },
        );
      },
      update: (change): Promise<void> => {
        mockUpdatePasses();
        if (mockLedger === null)
          return Promise.reject(new Error('migration-passes-unreadable'));
        mockLedger = change(mockLedger);
        return Promise.resolve();
      },
    };
  },
}));
jest.mock('../services/org-project-catalog-service', () => ({
  getOrgProjectCatalogService: (): object => ({
    list: mockList,
    subscribe: (
      listener: (snapshot: DesktopOrgProjectCatalogSnapshot) => void,
    ): (() => void) => {
      catalogListeners.push(listener);
      return (): void => {};
    },
  }),
}));

import {
  reportOrgProjectAutoConversionFailure,
  convertOrgProjectCombinationNow,
  startOrgProjectAutoConversion,
  requestOrgProjectAutoConversion,
  stopOrgProjectAutoConversionForTests,
} from '../services/org-project-auto-conversion-host';
import {
  ORG_PROJECT_AUTO_CONVERSION_DEBOUNCE_MS,
  ORG_PROJECT_AUTO_CONVERSION_STARTUP_DELAY_MS,
} from '../services/org-project-auto-conversion';
import { getOrgProjectMigrationPassesFilePath } from '../lib/paths';
import * as AutoConversionService from '../services/org-project-auto-conversion';

beforeEach((): void => {
  jest.useFakeTimers();
  mockFlag.mockReturnValue(true);
  flagListeners.length = 0;
  catalogListeners.length = 0;
  contextListeners.length = 0;
  mockList.mockReset();
  // Answered as fetched just now, as a live refresh would be.
  mockList.mockImplementation(() =>
    Promise.resolve({
      context: `org:${ORG}`,
      revision: 'r1',
      fetchedAt: new Date().toISOString(),
      stale: false,
      error: null,
      projects: [
        {
          id: PROJECT,
          organizationId: ORG,
          name: 'repo',
          description: null,
          kind: 'CODE',
          location: 'LOCAL',
          repository: {
            provider: 'github',
            host: 'github.com',
            owner: 'acme',
            name: 'repo',
            providerRepoId: '1',
            defaultBranch: 'main',
            verification: 'VERIFIED',
          },
          state: 'ACTIVE',
          revision: 1,
          authorizationVersion: 1,
          defaultListed: true,
          preference: 'FOLLOW_DEFAULTS',
          listed: true,
          capabilities: { use: true, administer: false, manageCloud: false },
          instance: null,
        },
      ],
    }),
  );
  mockConvert.mockReset();
  mockConvertMultiRepo.mockReset();
  mockOwnershipType.mockReturnValue('single-repo');
  mockItems = [{ id: 'personal', type: 'single-repo', repoPath: '/repos/p' }];
  mockSessionDiagnostic.mockReset();
  mockAppDiagnostic.mockReset();
  mockLedger = { version: 1, organizations: {} };
  mockLedgerFilePath = null;
  mockReadPasses.mockClear();
  mockUpdatePasses.mockClear();
});

afterEach((): void => {
  stopOrgProjectAutoConversionForTests();
  jest.useRealTimers();
});

it('writes a session diagnostic for the workspace it converted, never a workspace id in app events', async (): Promise<void> => {
  mockConvert.mockResolvedValue({ ok: true });
  startOrgProjectAutoConversion();
  await jest.advanceTimersByTimeAsync(
    ORG_PROJECT_AUTO_CONVERSION_STARTUP_DELAY_MS,
  );

  expect(mockConvert).toHaveBeenCalledWith(
    { workspaceId: 'personal', organizationId: ORG, projectId: PROJECT },
    { automatic: true },
  );
  expect(mockSessionDiagnostic).toHaveBeenCalledTimes(1);
  expect(mockSessionDiagnostic.mock.calls[0]?.[0]).toMatchObject({
    version: 1,
    kind: 'org_project_auto_conversion',
    sessionKey: 'org-project-auto-conversion',
    projectId: 'personal',
    worktreeId: '',
    chatId: '',
    providerType: 'unknown',
    orgProjectAutoConversionOutcome: 'converted',
    orgProjectAutoConversionOrganizationId: ORG,
    orgProjectAutoConversionProjectId: PROJECT,
  });
  // Only the organization's pass lifecycle is app-level.
  for (const [event] of mockAppDiagnostic.mock.calls) {
    expect(event).toMatchObject({ kind: 'org_project_migration_pass' });
    expect(JSON.stringify(event)).not.toContain('personal');
  }
});

it('keeps the pass ledger in the data directory and records its lifecycle per organization', async (): Promise<void> => {
  mockConvert.mockResolvedValue({ ok: true });
  startOrgProjectAutoConversion();
  expect(mockLedgerFilePath).toBe(getOrgProjectMigrationPassesFilePath);
  await jest.advanceTimersByTimeAsync(
    ORG_PROJECT_AUTO_CONVERSION_STARTUP_DELAY_MS,
  );

  expect(mockLedger?.organizations[ORG]).toMatchObject({
    eligibleWorkspaceIds: ['personal'],
  });
  expect(mockLedger?.organizations[ORG]?.completedAt).toEqual(
    expect.any(String),
  );
  // One app-level record per lifecycle step, keyed by the organization only.
  expect(mockAppDiagnostic.mock.calls.map(([event]) => event)).toMatchObject([
    {
      version: 1,
      kind: 'org_project_migration_pass',
      orgProjectMigrationPassOutcome: 'started',
      orgProjectMigrationPassOrganizationId: ORG,
      orgProjectMigrationPassWorkspaceCount: 1,
    },
    {
      version: 1,
      kind: 'org_project_migration_pass',
      orgProjectMigrationPassOutcome: 'completed',
      orgProjectMigrationPassOrganizationId: ORG,
      orgProjectMigrationPassCompletion: 'settled',
    },
  ]);
});

it('converts nothing and reports once when the pass ledger is unreadable', async (): Promise<void> => {
  mockConvert.mockResolvedValue({ ok: true });
  mockLedger = null;
  startOrgProjectAutoConversion();
  await jest.advanceTimersByTimeAsync(
    ORG_PROJECT_AUTO_CONVERSION_STARTUP_DELAY_MS,
  );
  contextListeners.forEach((listener): void => {
    listener({ reason: 'organizations' });
  });
  await jest.advanceTimersByTimeAsync(ORG_PROJECT_AUTO_CONVERSION_DEBOUNCE_MS);

  expect(mockConvert).not.toHaveBeenCalled();
  expect(mockSessionDiagnostic).not.toHaveBeenCalled();
  expect(mockAppDiagnostic).toHaveBeenCalledTimes(1);
  expect(mockAppDiagnostic.mock.calls[0]?.[0]).toMatchObject({
    kind: 'startup_background_task_failed',
    reason: 'org_project_auto_conversion',
    error: 'migration-passes-unreadable',
  });
});

it('records the refusal code and whether it is retried', async (): Promise<void> => {
  mockConvert.mockResolvedValue({ ok: false, code: 'offline' });
  startOrgProjectAutoConversion();
  await jest.advanceTimersByTimeAsync(
    ORG_PROJECT_AUTO_CONVERSION_STARTUP_DELAY_MS,
  );
  expect(mockSessionDiagnostic.mock.calls[0]?.[0]).toMatchObject({
    kind: 'org_project_auto_conversion',
    projectId: 'personal',
    orgProjectAutoConversionOutcome: 'failed',
    orgProjectAutoConversionReason: 'offline',
    orgProjectAutoConversionRetry: 'later',
  });
});

it('schedules nothing with the flag off, and runs once it turns on', async (): Promise<void> => {
  mockConvert.mockResolvedValue({ ok: true });
  mockFlag.mockReturnValue(false);
  startOrgProjectAutoConversion();
  catalogListeners.forEach((listener): void => {
    listener({
      context: `org:${ORG}`,
      revision: 'r1',
      projects: [],
      fetchedAt: '2026-09-27T00:00:00.000Z',
      stale: false,
      error: null,
    });
  });
  contextListeners.forEach((listener): void => {
    listener({ reason: 'organizations' });
  });
  expect(jest.getTimerCount()).toBe(0);
  await jest.advanceTimersByTimeAsync(60_000);
  expect(mockList).not.toHaveBeenCalled();
  expect(mockConvert).not.toHaveBeenCalled();

  mockFlag.mockReturnValue(true);
  flagListeners.forEach((listener): void => {
    listener();
  });
  await jest.advanceTimersByTimeAsync(ORG_PROJECT_AUTO_CONVERSION_DEBOUNCE_MS);
  expect(mockConvert).toHaveBeenCalledTimes(1);
});

it('ignores Personal catalog refreshes and plain context switches', async (): Promise<void> => {
  mockFlag.mockReturnValue(true);
  startOrgProjectAutoConversion();
  await jest.advanceTimersByTimeAsync(
    ORG_PROJECT_AUTO_CONVERSION_STARTUP_DELAY_MS,
  );
  mockList.mockClear();
  catalogListeners.forEach((listener): void => {
    listener({
      context: 'personal',
      revision: 'r1',
      projects: [],
      fetchedAt: '2026-09-27T00:00:00.000Z',
      stale: false,
      error: null,
    });
  });
  contextListeners.forEach((listener): void => {
    listener({ reason: 'switch' });
  });
  expect(jest.getTimerCount()).toBe(0);
  contextListeners.forEach((listener): void => {
    listener({ reason: 'account-change' });
  });
  await jest.advanceTimersByTimeAsync(ORG_PROJECT_AUTO_CONVERSION_DEBOUNCE_MS);
  expect(mockList).toHaveBeenCalledTimes(1);
});

it('hands a Personal multi-repo project, root first, to the multi-repo conversion (CAN-3532)', async (): Promise<void> => {
  mockOwnershipType.mockReturnValue('multi-repo');
  mockItems = [
    {
      id: 'platform',
      type: 'multi-repo',
      sourceRepoPath: '/repos/platform',
      worktrees: [],
      repos: [{ id: 'web', name: 'web', repoPath: '/repos/platform/web' }],
    },
    // Temporary combinations are projects too.
    {
      id: 'combined',
      type: 'multi-repo',
      temporary: true,
      alwaysShow: true,
      worktrees: [],
      repos: [{ id: 'web', name: 'web', repoPath: '/repos/platform/web' }],
    },
  ];
  mockConvertMultiRepo.mockResolvedValue({
    ok: true,
    owner: { type: 'organization', organizationId: ORG, projectId: 'multi' },
  });
  startOrgProjectAutoConversion();
  await jest.advanceTimersByTimeAsync(
    ORG_PROJECT_AUTO_CONVERSION_STARTUP_DELAY_MS,
  );

  expect(mockConvertMultiRepo).toHaveBeenCalledTimes(2);
  expect(mockConvertMultiRepo).toHaveBeenCalledWith(
    { workspaceId: 'platform', organizationId: ORG },
    { automatic: true },
  );
  expect(mockConvert).not.toHaveBeenCalled();
  expect(mockSessionDiagnostic.mock.calls[0]?.[0]).toMatchObject({
    projectId: 'platform',
    orgProjectAutoConversionOutcome: 'converted',
    orgProjectAutoConversionProjectId: 'multi',
  });
});

it('maps retirement from fresh raw rows before Always show serialization loses explicit true', async () => {
  mockOwnershipType.mockReturnValue('multi-repo');
  const base = {
    type: 'multi-repo',
    temporary: true,
    repos: [{ id: 'repo', name: 'Repo', repoPath: '/repos/repo' }],
    worktrees: [],
    archivedContainerCount: 0,
  };
  mockItems = [
    { ...base, id: 'kept', alwaysShow: true },
    { ...base, id: 'disposable', alwaysShow: false },
    { ...base, id: 'absent' },
    {
      ...base,
      id: 'active',
      alwaysShow: false,
      worktrees: [
        { id: 'wt', branchName: 'main', createdAt: '2026-10-08T00:00:00Z' },
      ],
    },
    { ...base, id: 'archived', alwaysShow: false, archivedContainerCount: 1 },
  ];
  // Keep the pass open so a later raw snapshot can revive a listed row.
  mockConvertMultiRepo.mockResolvedValue({ ok: false, code: 'offline' });
  startOrgProjectAutoConversion();
  await jest.advanceTimersByTimeAsync(
    ORG_PROJECT_AUTO_CONVERSION_STARTUP_DELAY_MS,
  );
  expect(mockConvertMultiRepo).toHaveBeenCalledTimes(3);
  ['kept', 'active', 'archived'].forEach((workspaceId, index) => {
    expect(mockConvertMultiRepo).toHaveBeenNthCalledWith(
      index + 1,
      { workspaceId, organizationId: ORG },
      { automatic: true },
    );
  });
  expect(mockLedger?.organizations[ORG]?.eligibleWorkspaceIds).toEqual([
    'kept',
    'disposable',
    'absent',
    'active',
    'archived',
  ]);
  expect(
    mockSessionDiagnostic.mock.calls.map(([event]) => event.projectId),
  ).toEqual(['kept', 'active', 'archived']);
  mockItems = mockItems.map((item) =>
    item.id === 'disposable' ? { ...item, alwaysShow: true } : item,
  );
  requestOrgProjectAutoConversion();
  await jest.advanceTimersByTimeAsync(ORG_PROJECT_AUTO_CONVERSION_DEBOUNCE_MS);
  expect(mockConvertMultiRepo).toHaveBeenCalledTimes(4);
  expect(mockConvertMultiRepo).toHaveBeenNthCalledWith(
    4,
    { workspaceId: 'disposable', organizationId: ORG },
    { automatic: true },
  );
});

it('requests before start and with the flag disabled are no-ops', async () => {
  requestOrgProjectAutoConversion();
  expect(jest.getTimerCount()).toBe(0);
  mockFlag.mockReturnValue(false);
  startOrgProjectAutoConversion();
  requestOrgProjectAutoConversion();
  await jest.advanceTimersByTimeAsync(60_000);
  expect(mockList).not.toHaveBeenCalled();
});

it('debounces a mutation burst without converting a workspace added after the pass started', async () => {
  let finish: (value: { ok: boolean }) => void = (): void => {};
  mockConvert.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  startOrgProjectAutoConversion();
  await jest.advanceTimersByTimeAsync(
    ORG_PROJECT_AUTO_CONVERSION_STARTUP_DELAY_MS,
  );
  expect(mockConvert).toHaveBeenCalledTimes(1);
  mockItems.push({ id: 'new', type: 'single-repo', repoPath: '/repos/new' });
  for (let i = 0; i < 5; i++) requestOrgProjectAutoConversion();
  await jest.advanceTimersByTimeAsync(ORG_PROJECT_AUTO_CONVERSION_DEBOUNCE_MS);
  expect(mockList).toHaveBeenCalledTimes(1);
  finish({ ok: true });
  await jest.advanceTimersByTimeAsync(0);
  mockItems = mockItems.slice(1);
  mockConvert.mockResolvedValue({ ok: true });
  await jest.advanceTimersByTimeAsync(ORG_PROJECT_AUTO_CONVERSION_DEBOUNCE_MS);
  expect(mockList).toHaveBeenCalledTimes(1);
  expect(mockConvert).toHaveBeenCalledTimes(1);
  for (let i = 0; i < 5; i++) requestOrgProjectAutoConversion();
  await jest.advanceTimersByTimeAsync(ORG_PROJECT_AUTO_CONVERSION_DEBOUNCE_MS);
  expect(mockList).toHaveBeenCalledTimes(1);
});

it('a scheduling failure does not escape into a successful mutation', () => {
  startOrgProjectAutoConversion();
  mockFlag.mockImplementationOnce(() => {
    throw new Error('flag unavailable');
  });
  expect(() => requestOrgProjectAutoConversion()).not.toThrow();
  expect(mockAppDiagnostic).toHaveBeenCalledWith(
    expect.objectContaining({
      reason: 'org_project_auto_conversion',
      error: 'flag unavailable',
    }),
  );
});

describe('CAN-3846 inline host', () => {
  function combination(): void {
    mockOwnershipType.mockReturnValue('multi-repo');
    const combined: MultiRepoSidebarItem = {
      id: 'combined',
      type: 'multi-repo',
      name: 'Combined',
      color: '#000000',
      collapsed: false,
      order: 0,
      worktrees: [],
      temporary: true,
      alwaysShow: true,
      repos: [{ id: 'repo', name: 'Repo', repoPath: '/repos/p' }],
    };
    mockItems = [{ ...combined }];
    mockConvertMultiRepo.mockImplementation(
      (
        request: OrgProjectConvertMultiRepoWorkspaceRequest,
      ): Promise<OrgProjectConversionResult> => {
        const owner: WorkspaceOwnerBinding = {
          type: 'organization',
          organizationId: ORG,
          projectId: 'multi',
          instanceId: 'instance',
          bindingGeneration: 1,
        };
        mockItems = mockItems.map((item) =>
          item.id === request.workspaceId ? { ...item, owner } : item,
        );
        return Promise.resolve({
          ok: true,
          workspaceId: request.workspaceId,
          owner,
          ownershipTransfer: {
            version: 1,
            previousOwner: { type: 'personal' },
            organizationId: ORG,
            projectId: 'multi',
            convertedAt: '2026-10-08T00:00:00Z',
          },
        });
      },
    );
  }

  it('binds after a precompleted pass without touching its ledger', async () => {
    combination();
    mockLedger = {
      version: 1,
      organizations: {
        [ORG]: {
          startedAt: '2026-10-01T00:00:00Z',
          completedAt: '2026-10-01T00:01:00Z',
          eligibleWorkspaceIds: [],
        },
      },
    };
    const before = JSON.stringify(mockLedger);
    startOrgProjectAutoConversion();
    await expect(
      convertOrgProjectCombinationNow('combined'),
    ).resolves.toMatchObject({ outcome: 'converted', organizationId: ORG });
    expect(mockReadPasses).not.toHaveBeenCalled();
    expect(mockUpdatePasses).not.toHaveBeenCalled();
    expect(JSON.stringify(mockLedger)).toBe(before);
    expect(mockSessionDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({ orgProjectAutoConversionOutcome: 'converted' }),
    );
  });

  it('only delegates through the started service', async () => {
    combination();
    await expect(
      convertOrgProjectCombinationNow('combined'),
    ).resolves.toBeNull();
    startOrgProjectAutoConversion();
    await expect(
      convertOrgProjectCombinationNow('combined'),
    ).resolves.toMatchObject({ outcome: 'converted', organizationId: ORG });
    // The next inline request reads the durable owner and creates no duplicate.
    await expect(
      convertOrgProjectCombinationNow('combined'),
    ).resolves.toBeNull();
    stopOrgProjectAutoConversionForTests();
    await expect(
      convertOrgProjectCombinationNow('combined'),
    ).resolves.toBeNull();
    expect(mockConvertMultiRepo).toHaveBeenCalledTimes(1);
  });

  it('respects the rollout flag and E2E disable override', async () => {
    combination();
    startOrgProjectAutoConversion();
    mockFlag.mockReturnValue(false);
    await expect(
      convertOrgProjectCombinationNow('combined'),
    ).resolves.toBeNull();
    mockFlag.mockReturnValue(true);
    const previous = process.env.CANOPY_E2E_ORG_PROJECT_AUTO_CONVERT;
    const descriptor = Object.getOwnPropertyDescriptor(
      globalThis,
      '__CANOPY_E2E__',
    );
    Object.defineProperty(globalThis, '__CANOPY_E2E__', {
      value: true,
      configurable: true,
    });
    process.env.CANOPY_E2E_ORG_PROJECT_AUTO_CONVERT = 'off';
    try {
      await expect(
        convertOrgProjectCombinationNow('combined'),
      ).resolves.toBeNull();
    } finally {
      if (previous === undefined)
        delete process.env.CANOPY_E2E_ORG_PROJECT_AUTO_CONVERT;
      else process.env.CANOPY_E2E_ORG_PROJECT_AUTO_CONVERT = previous;
      if (descriptor)
        Object.defineProperty(globalThis, '__CANOPY_E2E__', descriptor);
      else Reflect.deleteProperty(globalThis, '__CANOPY_E2E__');
    }
    expect(mockConvertMultiRepo).not.toHaveBeenCalled();
  });

  it('returns a coordinator refusal', async () => {
    combination();
    mockConvertMultiRepo.mockResolvedValue({
      ok: false,
      code: 'member-project-limit',
    });
    startOrgProjectAutoConversion();
    await expect(
      convertOrgProjectCombinationNow('combined'),
    ).resolves.toMatchObject({
      outcome: 'failed',
      reason: 'member-project-limit',
    });
  });

  it('never rejects on an unexpected failure, even if diagnostics fail, and later calls recover', async () => {
    combination();
    mockList.mockRejectedValueOnce(new Error('catalog'));
    mockAppDiagnostic.mockImplementation(() => {
      throw new Error('diagnostic');
    });
    startOrgProjectAutoConversion();
    await expect(
      convertOrgProjectCombinationNow('combined'),
    ).resolves.toBeNull();
    mockSessionDiagnostic.mockImplementation(() => {
      throw new Error('session diagnostic');
    });
    await expect(
      convertOrgProjectCombinationNow('combined'),
    ).resolves.toMatchObject({ outcome: 'converted' });
    expect(mockConvertMultiRepo).toHaveBeenCalledTimes(1);
  });
});

it('catches an unexpected service rejection even with throwing diagnostics', async () => {
  const create = AutoConversionService.createOrgProjectAutoConversion;
  const spy = jest
    .spyOn(AutoConversionService, 'createOrgProjectAutoConversion')
    .mockImplementationOnce((deps) => {
      const current = create(deps);
      jest
        .spyOn(current, 'convertNow')
        .mockRejectedValue(new Error('unexpected service rejection'));
      return current;
    });
  try {
    startOrgProjectAutoConversion();
    mockAppDiagnostic.mockImplementation(() => {
      throw new Error('diagnostics');
    });
    await expect(
      convertOrgProjectCombinationNow('combined'),
    ).resolves.toBeNull();
    expect(mockAppDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'startup_background_task_failed',
        reason: 'org_project_auto_conversion',
        error: 'unexpected service rejection',
      }),
    );
    expect(() =>
      reportOrgProjectAutoConversionFailure(new Error('direct')),
    ).not.toThrow();
  } finally {
    spy.mockRestore();
  }
});
