import { isAbsolute, relative, sep } from 'node:path';
import type * as atomicFile from '../lib/atomic-file';
import type {
  CanopyCloudAccountEntry,
  CanopyCloudAccountReadResult,
} from '../lib/canopy-cloud-account-store';
import type { WorkspaceContext } from '@canopy/protocol/workspace-context';
import type { OrgProjectSummary } from '@canopy/protocol/org-projects';
import { IPC_CHANNELS } from '@canopy/desktop-shared/types';
import type { SecureStorageFailure } from '@canopy/desktop-shared/types/secure-storage';

const mockReadFile = jest.fn<Promise<string>, [string, string]>();
const mockWriteFileAtomically = jest.fn<
  Promise<void>,
  [string, string | Uint8Array, unknown?]
>();
const mockMkdir = jest.fn<Promise<void>, [string, { recursive: boolean }]>();
const mockRm = jest.fn<Promise<void>, [string, unknown]>();
const mockOpen = jest.fn<Promise<unknown>, []>();
const mockRename = jest.fn<Promise<void>, [string, string]>();
const mockLoadAccount = jest.fn<Promise<CanopyCloudAccountEntry | null>, []>();
const mockReadAccount = jest.fn<Promise<CanopyCloudAccountReadResult>, []>();
const mockGetCredentials = jest.fn<Promise<unknown>, []>();
const mockConditional = jest.fn<
  Promise<unknown>,
  [string, { etag: string | null; credentialContext?: unknown }]
>();
const mockRequestJson = jest.fn<
  Promise<unknown>,
  [
    string,
    {
      method?: string;
      body?: string;
      credentialContext?: unknown;
      timeoutMs?: number;
    }?,
  ]
>();
const mockReadAllSidebarItems = jest.fn();
const mockRecordOrganizationPrivateMemory = jest.fn();
const mockSendToAllWindows = jest.fn();
let accountListener: ((entry: CanopyCloudAccountEntry | null) => void) | null =
  null;
let contextListener: ((state: { context: unknown }) => void) | null = null;
let currentContext:
  | { kind: 'personal' }
  | { kind: 'organization'; organizationId: string } = {
  kind: 'personal',
};

let mockRolloutEnabled = true;
let flagListener: (() => void) | null = null;
jest.mock('../feature-flags', () => ({
  getFeatureFlagService: (): object => ({
    isEnabled: (): boolean => mockRolloutEnabled,
    onSnapshotChanged: (listener: () => void): (() => void) => {
      flagListener = listener;
      return (): void => {
        flagListener = null;
      };
    },
  }),
}));

jest.mock('node:fs/promises', () => ({
  open: (): Promise<unknown> => mockOpen(),
  rename: (source: string, target: string): Promise<void> =>
    mockRename(source, target),
  readFile: (path: string, encoding: string): Promise<string> =>
    mockReadFile(path, encoding),
  mkdir: (path: string, options: { recursive: boolean }): Promise<void> =>
    mockMkdir(path, options),
  rm: (path: string, options: unknown): Promise<void> => mockRm(path, options),
}));
jest.mock('../lib/atomic-file', () => ({
  writeFileAtomically: (
    path: string,
    data: string | Uint8Array,
    options?: unknown,
  ): Promise<void> => mockWriteFileAtomically(path, data, options),
}));
jest.mock('../lib/paths', () => ({
  getOrgProjectCatalogDir: (): string => '/mock/data-dir/org-project-catalog',
}));
jest.mock('../lib/sidebar-items', () => ({
  readAllSidebarItems: (): unknown => mockReadAllSidebarItems(),
}));
jest.mock('../lib/workspace-private-memory', () => ({
  recordOrganizationPrivateMemory: (input: unknown): unknown =>
    mockRecordOrganizationPrivateMemory(input),
}));
jest.mock('../lib/window-send', () => ({
  sendToAllWindows: (...args: unknown[]): void => {
    mockSendToAllWindows(...args);
  },
}));
jest.mock('../lib/canopy-cloud-account-store', () => ({
  loadCanopyCloudAccount: (): Promise<CanopyCloudAccountEntry | null> =>
    mockLoadAccount(),
  readCanopyCloudAccountWithStatus: (): Promise<CanopyCloudAccountReadResult> =>
    mockReadAccount(),
  getCanopyCloudCredentials: (): Promise<unknown> => mockGetCredentials(),
  subscribeCanopyCloudAccountChanges: (
    listener: (entry: CanopyCloudAccountEntry | null) => void,
  ): (() => void) => {
    accountListener = listener;
    return (): void => {
      accountListener = null;
    };
  },
}));
jest.mock('../lib/workspace-context-service', () => ({
  getWorkspaceContextService: (): unknown => ({
    getState: (): unknown => ({
      context: currentContext,
      revision: 1,
      organizations: [],
    }),
    subscribe: (
      listener: (state: { context: unknown }) => void,
    ): (() => void) => {
      contextListener = listener;
      return (): void => {
        contextListener = null;
      };
    },
  }),
}));
jest.mock('../portal/portal-state-store', () => ({
  readPortalStateStore: (): Promise<{ clientDeviceId: string }> =>
    Promise.resolve({ clientDeviceId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' }),
}));
jest.mock('../canopy-cloud/client', () => {
  class MockCloudError extends Error {
    constructor(
      readonly code: string,
      message: string,
      readonly status?: number,
    ) {
      super(message);
    }
  }
  return {
    CanopyCloudClientError: MockCloudError,
    requestCanopyCloudJsonConditional: (
      path: string,
      options: { etag: string | null; credentialContext?: unknown },
    ): Promise<unknown> => mockConditional(path, options),
    requestCanopyCloudJson: (
      path: string,
      init?: {
        method?: string;
        body?: string;
        credentialContext?: unknown;
        timeoutMs?: number;
      },
    ): Promise<unknown> => mockRequestJson(path, init),
  };
});

import {
  ORG_PROJECT_CATALOG_MAX_AGE_MS,
  contextFileName,
  createOrgProjectCatalogService,
} from '../services/org-project-catalog-service';
import { CanopyCloudClientError } from '../canopy-cloud/client';

const ORG_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ACME: WorkspaceContext = { kind: 'organization', organizationId: ORG_A };

function project(id: string): OrgProjectSummary {
  return {
    id,
    organizationId: ORG_A,
    name: id,
    description: null,
    kind: 'CODE',
    purpose: 'project',
    visibility: 'organization',
    memberOwned: false,
    location: 'LOCAL',
    repository: null,
    state: 'ACTIVE',
    revision: 1,
    authorizationVersion: 1,
    defaultListed: true,
    preference: 'FOLLOW_DEFAULTS',
    listed: true,
    capabilities: { administer: false, manageCloud: false, use: true },
    instance: null,
  };
}

function account(id: string): CanopyCloudAccountEntry {
  return {
    apiKey: `csk_${id}`,
    capabilities: ['org-projects-v1'],
    account: { id, name: id, email: `${id}@example.test`, role: 'DEVELOPER' },
    organizations: [],
    teams: [],
    createdAt: '2026-09-10T00:00:00.000Z',
    updatedAt: '2026-09-10T00:00:00.000Z',
  };
}

function page(
  projects: OrgProjectSummary[],
  revision = 'r1',
  nextCursor: string | null = null,
): unknown {
  return { data: projects, revision, nextCursor };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 6; i += 1) await Promise.resolve();
}

describe('OrgProjectCatalogService', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    mockRolloutEnabled = true;
    flagListener = null;
    currentContext = { kind: 'personal' };
    mockReadFile.mockRejectedValue(
      Object.assign(new Error('ENOENT'), { code: 'ENOENT' }),
    );
    mockWriteFileAtomically.mockResolvedValue(undefined);
    mockMkdir.mockResolvedValue(undefined);
    mockRm.mockResolvedValue(undefined);
    mockReadAllSidebarItems.mockResolvedValue({ items: [] });
    mockRecordOrganizationPrivateMemory.mockResolvedValue(undefined);
    mockLoadAccount.mockResolvedValue(account('acct'));
    mockReadAccount.mockImplementation(
      async (): Promise<CanopyCloudAccountReadResult> => ({
        status: 'ok',
        entry: await mockLoadAccount(),
      }),
    );
    mockGetCredentials.mockResolvedValue({
      baseUrl: 'https://cloud.example',
      apiKey: 'csk_acct',
      capabilities: ['org-projects-v1'],
    });
    mockConditional.mockResolvedValue({
      status: 'fresh',
      body: page([project('p1')]),
      etag: '"r1"',
    });
  });

  it('applies managed true and false, but leaves older summaries without the field untouched', async (): Promise<void> => {
    const owner = {
      type: 'organization',
      organizationId: ORG_A,
      projectId: 'p1',
    };
    let privateMemory: boolean | undefined;
    mockReadAllSidebarItems.mockResolvedValue({
      items: [{ id: 'local-p1', owner }],
    });
    mockRecordOrganizationPrivateMemory.mockImplementation(
      (input: { privateMemory: boolean }): Promise<boolean> => {
        privateMemory = input.privateMemory;
        return Promise.resolve(true);
      },
    );
    const service = createOrgProjectCatalogService();
    try {
      await service.initialize();
      mockConditional.mockResolvedValueOnce({
        status: 'fresh',
        body: page([{ ...project('p1'), privateMemory: true }], 'r1'),
        etag: '"r1"',
      });
      await service.refresh(ACME);
      expect(privateMemory).toBe(true);
      expect(mockSendToAllWindows).toHaveBeenCalledWith(
        IPC_CHANNELS.workspacePrivateMemoryChanged,
        'local-p1',
      );

      mockSendToAllWindows.mockClear();

      mockConditional.mockResolvedValueOnce({
        status: 'fresh',
        body: page([{ ...project('p1'), privateMemory: false }], 'r2'),
        etag: '"r2"',
      });
      await service.refresh(ACME, { force: true });
      expect(privateMemory).toBe(false);
      expect(mockSendToAllWindows).toHaveBeenCalledWith(
        IPC_CHANNELS.workspacePrivateMemoryChanged,
        'local-p1',
      );

      mockSendToAllWindows.mockClear();

      mockConditional.mockResolvedValueOnce({
        status: 'fresh',
        body: page([project('p1')], 'r3'),
        etag: '"r3"',
      });
      await service.refresh(ACME, { force: true });
      expect(privateMemory).toBe(false);
      expect(mockRecordOrganizationPrivateMemory).toHaveBeenCalledTimes(2);
      expect(mockSendToAllWindows).not.toHaveBeenCalled();
    } finally {
      service.dispose();
    }
  });

  it('continues reconciling when one local project config cannot be written', async (): Promise<void> => {
    mockReadAllSidebarItems.mockResolvedValue({
      items: ['first', 'second'].map((id) => ({
        id,
        owner: { type: 'organization', organizationId: ORG_A, projectId: 'p1' },
      })),
    });
    mockRecordOrganizationPrivateMemory
      .mockRejectedValueOnce(new Error('unreadable'))
      .mockResolvedValue(undefined);
    const service = createOrgProjectCatalogService();
    try {
      await service.initialize();
      mockConditional.mockResolvedValueOnce({
        status: 'fresh',
        body: page([{ ...project('p1'), privateMemory: true }]),
        etag: '"r1"',
      });
      await service.refresh(ACME);
      expect(mockRecordOrganizationPrivateMemory).toHaveBeenCalledTimes(2);
    } finally {
      service.dispose();
    }
  });

  it('reconciles a disable during initialization so re-enable resumes polling and fences old writes', async (): Promise<void> => {
    jest.useFakeTimers();
    let releaseAccount: (
      entry: CanopyCloudAccountEntry,
    ) => void = (): void => {};
    let started: () => void = (): void => {};
    const reading = new Promise<void>((resolve): void => {
      started = resolve;
    });
    mockLoadAccount.mockImplementationOnce(
      (): Promise<CanopyCloudAccountEntry> => {
        started();
        return new Promise((resolve): void => {
          releaseAccount = resolve;
        });
      },
    );
    let releaseCredentials: (value: unknown) => void = (): void => {};
    mockGetCredentials.mockImplementationOnce(
      (): Promise<unknown> =>
        new Promise((resolve): void => {
          releaseCredentials = resolve;
        }),
    );
    const service = createOrgProjectCatalogService();
    try {
      const initializing = service.initialize();
      await reading;
      expect(flagListener).toBeNull();
      const pending = service.setPreference(ACME, 'p1', 'ADDED');
      mockRolloutEnabled = false;
      releaseAccount(account('acct'));
      await initializing;
      expect(jest.getTimerCount()).toBe(0);
      mockRolloutEnabled = true;
      flagListener?.();
      releaseCredentials({ capabilities: ['org-projects-v1'] });
      await expect(pending).resolves.toMatchObject({
        projects: [],
        error: 'unavailable',
      });
      expect(mockRequestJson).not.toHaveBeenCalled();
      expect(jest.getTimerCount()).toBe(1);
      await jest.advanceTimersByTimeAsync(10 * 60 * 1000);
      expect(mockConditional).toHaveBeenCalledTimes(1);
    } finally {
      service.dispose();
      jest.useRealTimers();
    }
  });

  it('suspends polling, reads and preference writes immediately on disable and resumes on re-enable', async (): Promise<void> => {
    jest.useFakeTimers();
    const service = createOrgProjectCatalogService();
    try {
      await service.initialize();
      await service.refresh(ACME);
      expect(jest.getTimerCount()).toBe(1);
      mockRolloutEnabled = false;
      flagListener?.();
      expect(jest.getTimerCount()).toBe(0);
      mockConditional.mockClear();
      mockGetCredentials.mockClear();
      mockReadFile.mockClear();
      mockWriteFileAtomically.mockClear();
      for (const result of [
        await service.list(ACME),
        await service.refresh(ACME),
        await service.setPreference(ACME, 'p1', 'ADDED'),
      ]) {
        expect(result).toMatchObject({ projects: [], error: 'unavailable' });
      }
      expect(service.peek(ACME)?.projects ?? []).toEqual([]);
      contextListener?.({ context: ACME });
      await jest.advanceTimersByTimeAsync(20 * 60 * 1000);
      expect(mockConditional).not.toHaveBeenCalled();
      expect(mockRequestJson).not.toHaveBeenCalled();
      expect(mockGetCredentials).not.toHaveBeenCalled();
      expect(mockReadFile).not.toHaveBeenCalled();
      expect(mockWriteFileAtomically).not.toHaveBeenCalled();
      mockRolloutEnabled = true;
      flagListener?.();
      expect(jest.getTimerCount()).toBe(1);
      await service.refresh(ACME);
      expect((await service.list(ACME)).projects).toEqual([project('p1')]);
      mockConditional.mockClear();
      await jest.advanceTimersByTimeAsync(10 * 60 * 1000);
      expect(mockConditional).toHaveBeenCalled();
    } finally {
      service.dispose();
      expect(flagListener).toBeNull();
      expect(jest.getTimerCount()).toBe(0);
      jest.useRealTimers();
    }
  });

  it('starts disabled without polling and fences a pending preference credential read', async (): Promise<void> => {
    jest.useFakeTimers();
    mockRolloutEnabled = false;
    const service = createOrgProjectCatalogService();
    try {
      await service.initialize();
      expect(jest.getTimerCount()).toBe(0);
      mockRolloutEnabled = true;
      flagListener?.();
      let release: (value: unknown) => void = (): void => {};
      mockGetCredentials.mockImplementationOnce(
        (): Promise<unknown> =>
          new Promise((resolve): void => {
            release = resolve;
          }),
      );
      const pending = service.setPreference(ACME, 'p1', 'ADDED');
      mockRolloutEnabled = false;
      flagListener?.();
      release({ capabilities: ['org-projects-v1'] });
      await expect(pending).resolves.toMatchObject({
        projects: [],
        error: 'unavailable',
      });
      expect(mockRequestJson).not.toHaveBeenCalled();
    } finally {
      service.dispose();
      jest.useRealTimers();
    }
  });

  it('discards a catalog response that completes after disable', async (): Promise<void> => {
    const service = createOrgProjectCatalogService();
    let release: (value: unknown) => void = (): void => {};
    mockConditional.mockImplementationOnce(
      (): Promise<unknown> =>
        new Promise((resolve): void => {
          release = resolve;
        }),
    );
    try {
      await service.initialize();
      const pending = service.refresh(ACME);
      await flush();
      mockRolloutEnabled = false;
      flagListener?.();
      release({ status: 'fresh', body: page([project('p1')]), etag: 'r1' });
      await expect(pending).resolves.toMatchObject({
        projects: [],
        error: 'unavailable',
      });
      expect(mockWriteFileAtomically).not.toHaveBeenCalled();
    } finally {
      service.dispose();
    }
  });

  const secureStorageFailure: SecureStorageFailure = {
    version: 1,
    code: 'SECURE_STORAGE_READ_UNAVAILABLE',
    operation: 'read',
    state: 'unavailable',
    backend: null,
    retryable: true,
  };
  const startupReads: Array<{
    status: string;
    read: CanopyCloudAccountReadResult;
  }> = [
    {
      status: 'unavailable',
      read: {
        status: 'unavailable',
        error: new Error('Secure storage unavailable'),
        secureStorageFailure,
      },
    },
    {
      status: 'error',
      read: { status: 'error', error: new Error('Decryption failed') },
    },
  ];
  it.each(startupReads)(
    'recovers from a $status startup account read on refresh',
    async ({ read }): Promise<void> => {
      mockLoadAccount.mockResolvedValue(null);
      mockReadAccount.mockResolvedValue(read);
      const service = createOrgProjectCatalogService();
      try {
        await service.initialize();
        expect((await service.refresh(ACME)).error).toBe('unavailable');
        expect(mockConditional).not.toHaveBeenCalled();

        mockLoadAccount.mockResolvedValue(account('acct'));
        mockReadAccount.mockResolvedValue({
          status: 'ok',
          entry: account('acct'),
        });
        const snapshot = await service.refresh(ACME);
        expect(snapshot.error).toBeNull();
        expect(snapshot.projects).toEqual([project('p1')]);
        expect(mockConditional).toHaveBeenCalled();

        accountListener?.(null);
        await flush();
        mockReadAccount.mockClear();
        mockLoadAccount.mockClear();
        mockConditional.mockClear();
        expect((await service.refresh(ACME)).error).toBe('unavailable');
        expect(mockReadAccount).not.toHaveBeenCalled();
        expect(mockLoadAccount).not.toHaveBeenCalled();
        expect(mockConditional).not.toHaveBeenCalled();
      } finally {
        service.dispose();
      }
    },
  );

  it('does not retry a genuine signed-out startup account read', async (): Promise<void> => {
    mockLoadAccount.mockResolvedValue(null);
    const service = createOrgProjectCatalogService();
    try {
      await service.initialize();
      mockReadAccount.mockClear();
      mockLoadAccount.mockClear();
      expect((await service.refresh(ACME)).error).toBe('unavailable');
      expect((await service.refresh(ACME)).error).toBe('unavailable');
      expect(mockReadAccount).not.toHaveBeenCalled();
      expect(mockLoadAccount).not.toHaveBeenCalled();
      expect(mockConditional).not.toHaveBeenCalled();
    } finally {
      service.dispose();
    }
  });

  it('names cache files without the colon of the serialized context', () => {
    expect(contextFileName({ kind: 'personal' })).toBe('personal');
    expect(contextFileName(ACME)).toBe(`organization-${ORG_A}`);
  });

  it('fetches a context on first read, persists it per account, and sends the device id', async () => {
    const service = createOrgProjectCatalogService();
    await service.initialize();
    const snapshot = await service.list(ACME);
    expect(snapshot.projects.map((row) => row.id)).toEqual(['p1']);
    expect(snapshot.stale).toBe(false);
    const firstCall = mockConditional.mock.calls[0];
    expect(firstCall?.[0]).toContain(`context=org%3A${ORG_A}`);
    expect(firstCall?.[0]).toContain(
      'deviceId=dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    );
    expect(firstCall?.[1].etag).toBeNull();
    expect(mockWriteFileAtomically).toHaveBeenCalledWith(
      `/mock/data-dir/org-project-catalog/acct/organization-${ORG_A}.json`,
      expect.stringContaining('"revision": "r1"'),
      expect.anything(),
    );
    service.dispose();
  });

  // CAN-3388: the switch into an organization starts its first fetch before
  // anything reads the catalog. That in-flight entry used to hold an empty,
  // non-stale stand-in, which `peek` handed to the same-repository resolver
  // as a real catalog ("nothing is linked") and `list` handed to the sidebar.
  it('never passes off an unfetched context as an empty catalog', async (): Promise<void> => {
    let release: (value: unknown) => void = (): void => {};
    mockConditional.mockImplementationOnce(
      (): Promise<unknown> =>
        new Promise((resolve): void => {
          release = resolve;
        }),
    );
    const service = createOrgProjectCatalogService();
    try {
      await service.initialize();
      const broadcast = jest.fn();
      service.subscribe(broadcast);
      contextListener?.({ context: ACME });
      await flush();
      expect(mockConditional).toHaveBeenCalledTimes(1);
      expect(service.peek(ACME)).toBeNull();
      const listed = service.list(ACME);
      await flush();
      expect(service.peek(ACME)).toBeNull();
      release({ status: 'fresh', body: page([project('p1')]), etag: '"r1"' });
      await expect(listed).resolves.toMatchObject({
        projects: [project('p1')],
        stale: false,
        error: null,
      });
      expect(service.peek(ACME)?.projects).toEqual([project('p1')]);
      expect(mockConditional).toHaveBeenCalledTimes(1);
      for (const [snapshot] of broadcast.mock.calls) {
        expect(snapshot).toMatchObject({ projects: [project('p1')] });
      }
    } finally {
      service.dispose();
    }
  });

  it('serves the disk cache while the first fetch of a context is in flight', async (): Promise<void> => {
    let release: (value: unknown) => void = (): void => {};
    mockConditional.mockImplementationOnce(
      (): Promise<unknown> =>
        new Promise((resolve): void => {
          release = resolve;
        }),
    );
    mockReadFile.mockResolvedValue(
      JSON.stringify({
        version: 1,
        revision: 'cached',
        projects: [project('cached')],
        fetchedAt: new Date().toISOString(),
        etag: '"cached"',
      }),
    );
    const service = createOrgProjectCatalogService();
    try {
      await service.initialize();
      contextListener?.({ context: ACME });
      await flush();
      const listed = await service.list(ACME);
      expect(listed.projects).toEqual([project('cached')]);
      expect(service.peek(ACME)?.projects).toEqual([project('cached')]);
      release({ status: 'fresh', body: page([project('p1')]), etag: '"r1"' });
      await flush();
      await flush();
      expect(service.peek(ACME)?.projects).toEqual([project('p1')]);
    } finally {
      service.dispose();
    }
  });

  it('keeps a disk cache loaded during the first fetch when that fetch fails', async (): Promise<void> => {
    let fail: (error: unknown) => void = (): void => {};
    mockConditional.mockImplementationOnce(
      (): Promise<unknown> =>
        new Promise((_resolve, reject): void => {
          fail = reject;
        }),
    );
    mockReadFile.mockResolvedValue(
      JSON.stringify({
        version: 1,
        revision: 'cached',
        projects: [project('cached')],
        fetchedAt: new Date().toISOString(),
        etag: '"cached"',
      }),
    );
    const service = createOrgProjectCatalogService();
    try {
      await service.initialize();
      contextListener?.({ context: ACME });
      await flush();
      expect((await service.list(ACME)).projects).toEqual([project('cached')]);
      fail(new CanopyCloudClientError('network-error', 'offline'));
      await flush();
      await flush();
      expect(service.peek(ACME)).toMatchObject({
        projects: [project('cached')],
        stale: true,
        error: 'offline',
      });
    } finally {
      service.dispose();
    }
  });

  it('serves the cached file with its revision as the ETag and keeps it on 304', async () => {
    mockReadFile.mockResolvedValue(
      JSON.stringify({
        version: 1,
        revision: 'r7',
        etag: '"r7"',
        projects: [project('cached')],
        fetchedAt: new Date().toISOString(),
      }),
    );
    const service = createOrgProjectCatalogService();
    await service.initialize();
    const first = await service.list(ACME);
    expect(first.projects.map((row) => row.id)).toEqual(['cached']);
    expect(mockConditional).not.toHaveBeenCalled();

    mockConditional.mockResolvedValueOnce({ status: 'not-modified' });
    const refreshed = await service.refresh(ACME);
    expect(mockConditional.mock.calls[0]?.[1]).toMatchObject({ etag: '"r7"' });
    expect(refreshed.projects.map((row) => row.id)).toEqual(['cached']);
    expect(refreshed.stale).toBe(false);
    service.dispose();
  });

  it.each(['fresh', 'unavailable'])(
    'discards an older overlapping refresh completing with %s',
    async (completion): Promise<void> => {
      const service = createOrgProjectCatalogService();
      await service.initialize();
      const broadcast = jest.fn();
      service.subscribe(broadcast);
      let finish: (value: unknown) => void = (): void => {};
      let fail: (error: Error) => void = (): void => {};
      mockConditional.mockImplementationOnce(
        (): Promise<unknown> =>
          new Promise((resolve, reject): void => {
            finish = resolve;
            fail = reject;
          }),
      );
      const older = service.refresh(ACME);
      await flush();
      mockConditional.mockResolvedValueOnce({
        status: 'fresh',
        body: page([project('newer')], 'newer'),
        etag: '"newer"',
      });
      const newer = await service.refresh(ACME, { force: true });
      if (completion === 'fresh') {
        finish({
          status: 'fresh',
          body: page([project('older')], 'older'),
          etag: '"older"',
        });
      } else {
        fail(
          new CanopyCloudClientError('unsupported-capability', 'unavailable'),
        );
      }
      await older;
      expect(await service.list(ACME)).toEqual(newer);
      expect(mockWriteFileAtomically).toHaveBeenCalledTimes(1);
      expect(mockWriteFileAtomically.mock.calls[0]?.[1]).toContain('"newer"');
      expect(mockRm).not.toHaveBeenCalled();
      expect(broadcast.mock.calls).toEqual([[newer]]);
      service.dispose();
    },
  );

  it.each(['fresh', 'not-modified'])(
    'keeps the newer disk cache and return value when older %s persistence is delayed',
    async (kind): Promise<void> => {
      const service = createOrgProjectCatalogService();
      await service.initialize();
      await service.refresh(ACME);
      let releaseWrite: () => void = (): void => {};
      const delayedWrite = new Promise<void>((resolve): void => {
        releaseWrite = resolve;
      });
      let disk = '';
      mockWriteFileAtomically.mockImplementation(
        async (_path, data): Promise<void> => {
          if (String(data).includes('"revision": "r1"')) await delayedWrite;
          disk = String(data);
        },
      );
      mockConditional.mockResolvedValueOnce(
        kind === 'not-modified'
          ? { status: 'not-modified' }
          : { status: 'fresh', body: page([project('older')]), etag: '"r1"' },
      );
      const older = service.refresh(ACME);
      await flush();
      expect(mockWriteFileAtomically).toHaveBeenCalledTimes(2);
      mockConditional.mockResolvedValueOnce({
        status: 'fresh',
        body: page([project('newer')], 'newer'),
        etag: '"newer"',
      });
      const newer = service.refresh(ACME, { force: true });
      await flush();
      releaseWrite();
      const [olderSnapshot, newerSnapshot] = await Promise.all([older, newer]);
      const persisted: unknown = JSON.parse(disk);
      expect({ disk: persisted, returned: olderSnapshot }).toMatchObject({
        disk: { revision: 'newer', projects: [project('newer')] },
        returned: newerSnapshot,
      });
      expect(await service.list(ACME)).toEqual(newerSnapshot);
      service.dispose();
    },
  );

  it('preserves a synchronously remembered snapshot while refresh is in flight', async (): Promise<void> => {
    mockLoadAccount.mockResolvedValue(null);
    const now = jest.spyOn(Date, 'now').mockReturnValue(0);
    const service = createOrgProjectCatalogService();
    try {
      await service.initialize();
      // Seed the existing signed-out entry through its returned snapshot.
      await service.refresh(ACME);
      const old = await service.list(ACME);
      old.revision = 'old';
      old.projects = [project('old')];
      const broadcast = jest.fn();
      service.subscribe(broadcast);

      const refreshing = service.refresh(ACME);
      const immediate = service.list(ACME);
      const [listed, refreshed] = await Promise.all([immediate, refreshing]);
      expect(broadcast).toHaveBeenCalledWith(refreshed);
      expect(listed).toEqual(refreshed);
      expect(listed).toMatchObject({
        projects: [],
        revision: '',
        error: 'unavailable',
      });
    } finally {
      now.mockRestore();
      service.dispose();
    }
  });

  it('finishes the old account purge before persisting a re-adopted account', async (): Promise<void> => {
    currentContext = ACME;
    const service = createOrgProjectCatalogService();
    const directory = '/mock/data-dir/org-project-catalog/acct';
    const target = `${directory}/organization-${ORG_A}.json`;
    const disk = new Map<string, string>();
    const events: string[] = [];
    let releasePurge: () => void = (): void => {};
    const delayedPurge = new Promise<void>((resolve): void => {
      releasePurge = resolve;
    });
    mockWriteFileAtomically.mockImplementation((path, data): Promise<void> => {
      disk.set(path, String(data));
      events.push(`write:${path}`);
      return Promise.resolve();
    });
    mockRm.mockImplementation(async (path): Promise<void> => {
      if (path === directory) await delayedPurge;
      disk.forEach((_data, file): void => {
        if (file.startsWith(`${path}/`)) disk.delete(file);
      });
      events.push(`purge:${path}`);
    });
    try {
      await service.initialize();
      await service.refresh(ACME);
      events.length = 0;
      accountListener?.(account('other'));
      await flush();
      expect(mockRm).toHaveBeenCalledWith(directory, {
        recursive: true,
        force: true,
      });
      accountListener?.(account('acct'));
      await new Promise<void>((resolve): void => {
        setImmediate(resolve);
      });
      releasePurge();
      await new Promise<void>((resolve): void => {
        setImmediate(resolve);
      });

      expect(disk.has(target)).toBe(true);
      expect(events.indexOf(`write:${target}`)).toBeGreaterThan(
        events.indexOf(`purge:${directory}`),
      );
      expect(mockRm.mock.calls.map(([path]): string => path)).toEqual([
        directory,
        '/mock/data-dir/org-project-catalog/other',
      ]);
      expect(await service.list(ACME)).toMatchObject({
        projects: [project('p1')],
        stale: false,
      });
    } finally {
      releasePurge();
      service.dispose();
    }
  });

  it('clears the populated snapshot and disk cache on capability loss', async (): Promise<void> => {
    const service = createOrgProjectCatalogService();
    await service.initialize();
    await service.refresh(ACME);
    mockConditional.mockRejectedValueOnce(
      new CanopyCloudClientError('unsupported-capability', 'unavailable'),
    );
    const snapshot = await service.refresh(ACME, { force: true });
    expect(snapshot).toMatchObject({
      projects: [],
      revision: '',
      error: 'unavailable',
    });
    expect(mockRm).toHaveBeenCalledWith(
      `/mock/data-dir/org-project-catalog/acct/organization-${ORG_A}.json`,
      { force: true },
    );
    mockGetCredentials.mockResolvedValue({ capabilities: [] });
    expect(await service.list(ACME)).toEqual(snapshot);
    service.dispose();
  });

  it('announces a repeated unavailable result once, and peeks without refreshing', async (): Promise<void> => {
    // The session snapshot subscribes to this broadcast and rebuilds itself on
    // it. If every repeated read re-announced the same unavailable snapshot,
    // the rebuild would read the catalog again and the two would never settle.
    const service = createOrgProjectCatalogService();
    await service.initialize();
    await service.refresh(ACME);
    const broadcast = jest.fn();
    service.subscribe(broadcast);
    mockGetCredentials.mockResolvedValue({ capabilities: [] });
    const first = await service.list(ACME);
    expect(first).toMatchObject({ projects: [], error: 'unavailable' });
    expect(broadcast).toHaveBeenCalledTimes(1);
    await service.list(ACME);
    await service.list(ACME);
    expect(broadcast).toHaveBeenCalledTimes(1);

    // And `peek` is a plain cache read: no credential check, no refresh, no
    // clear, so it can never announce anything.
    const conditionalCalls = mockConditional.mock.calls.length;
    expect(service.peek(ACME)).toEqual(first);
    expect(mockConditional.mock.calls.length).toBe(conditionalCalls);
    expect(broadcast).toHaveBeenCalledTimes(1);
    service.dispose();
  });

  it('keeps the cache absent when capability loss overlaps an atomic rename', async (): Promise<void> => {
    const service = createOrgProjectCatalogService();
    const disk = new Map<string, string>();
    const target = `/mock/data-dir/org-project-catalog/acct/organization-${ORG_A}.json`;
    let releaseRename: () => void = (): void => {};
    const delayedRename = new Promise<void>((resolve): void => {
      releaseRename = resolve;
    });
    let startRename: () => void = (): void => {};
    const renameStarted = new Promise<void>((resolve): void => {
      startRename = resolve;
    });
    let written = '';
    mockOpen.mockResolvedValue({
      writeFile: (data: string): Promise<void> => {
        written = data;
        return Promise.resolve();
      },
      chmod: async (): Promise<void> => {},
      close: async (): Promise<void> => {},
    });
    mockRename.mockImplementation(async (_source, path): Promise<void> => {
      startRename();
      await delayedRename;
      disk.set(path, written);
    });
    mockRm.mockImplementation((path): Promise<void> => {
      disk.delete(path);
      return Promise.resolve();
    });
    const atomic = jest.requireActual<typeof atomicFile>('../lib/atomic-file');
    mockWriteFileAtomically.mockImplementation(
      (path, data): Promise<void> =>
        atomic.writeFileAtomically(path, data, { mode: 0o600 }),
    );
    try {
      await service.initialize();
      const refreshing = service.refresh(ACME);
      await renameStarted;
      mockGetCredentials.mockResolvedValue({ capabilities: [] });
      const unavailable = service.list(ACME);
      await flush();
      releaseRename();
      const snapshots = await Promise.all([refreshing, unavailable]);
      expect(mockRename).toHaveBeenCalledTimes(1);
      expect(disk.has(target)).toBe(false);
      for (const snapshot of snapshots) {
        expect(snapshot).toMatchObject({ projects: [], error: 'unavailable' });
      }
      expect(await service.list(ACME)).toMatchObject({ error: 'unavailable' });
    } finally {
      releaseRename();
      service.dispose();
    }
  });

  it('does not serve a fresh disk cache when capability is unavailable', async (): Promise<void> => {
    mockReadFile.mockResolvedValue(
      JSON.stringify({
        version: 1,
        revision: 'cached',
        projects: [project('cached')],
        fetchedAt: new Date().toISOString(),
      }),
    );
    mockGetCredentials.mockResolvedValue({ capabilities: [] });
    const service = createOrgProjectCatalogService();
    await service.initialize();
    expect(await service.list(ACME)).toMatchObject({
      projects: [],
      revision: '',
      error: 'unavailable',
    });
    expect(mockRm).toHaveBeenCalledWith(
      `/mock/data-dir/org-project-catalog/acct/organization-${ORG_A}.json`,
      { force: true },
    );
    expect(mockConditional).not.toHaveBeenCalled();
    service.dispose();
  });

  it('walks every page of a 25-page catalog', async (): Promise<void> => {
    mockConditional.mockResolvedValueOnce({
      status: 'fresh',
      body: page([project('p1')], 'r1', 'cursor-2'),
      etag: '"r1"',
    });
    for (let index = 2; index <= 25; index += 1) {
      mockRequestJson.mockResolvedValueOnce(
        page(
          [project(`p${index}`)],
          'r1',
          index === 25 ? null : `cursor-${index + 1}`,
        ),
      );
    }
    const service = createOrgProjectCatalogService();
    await service.initialize();
    const snapshot = await service.refresh(ACME);
    expect(snapshot.projects.map((row) => row.id)).toEqual(
      Array.from({ length: 25 }, (_, index): string => `p${index + 1}`),
    );
    expect(snapshot.stale).toBe(false);
    expect(mockRequestJson).toHaveBeenCalledTimes(24);
    expect(String(mockRequestJson.mock.calls[0]?.[0])).toContain(
      'cursor=cursor-2',
    );
    service.dispose();
  });

  it('discards a refresh that completes after switching accounts', async () => {
    const service = createOrgProjectCatalogService();
    await service.initialize();
    let finish: (value: unknown) => void = (): void => {};
    mockConditional.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const late = service.refresh(ACME);
    await flush();
    currentContext = ACME;
    accountListener?.(account('other'));
    await flush();
    await service.refresh(ACME);
    const broadcast = jest.fn();
    service.subscribe(broadcast);
    mockWriteFileAtomically.mockClear();
    finish({ status: 'fresh', body: page([project('secret')]), etag: '"old"' });
    await late;
    expect(broadcast).not.toHaveBeenCalled();
    expect(mockWriteFileAtomically).not.toHaveBeenCalled();
    expect((await service.list(ACME)).projects.map((row) => row.id)).toEqual([
      'p1',
    ]);
    service.dispose();
  });

  it.each(['invalid page', 'cursor cycle'])(
    'keeps the last good snapshot on %s',
    async (failure): Promise<void> => {
      const service = createOrgProjectCatalogService();
      await service.initialize();
      await service.refresh(ACME);
      mockConditional.mockResolvedValueOnce({
        status: 'fresh',
        body: page([project('prefix')], 'new', 'cursor-1'),
        etag: '"new"',
      });
      mockRequestJson.mockImplementation((): Promise<unknown> => {
        if (failure === 'invalid page')
          return Promise.resolve({ data: 'invalid' });
        return Promise.resolve(page([project('prefix')], 'new', 'cursor-1'));
      });
      const result = await service.refresh(ACME);
      expect(result).toMatchObject({
        projects: [project('p1')],
        stale: true,
        error: 'offline',
      });
      expect(mockWriteFileAtomically).toHaveBeenCalledTimes(1);
      expect(mockRequestJson).toHaveBeenCalledTimes(1);
      service.dispose();
    },
  );

  it('fetches page two again even when the first page ETag is unchanged', async () => {
    const service = createOrgProjectCatalogService();
    await service.initialize();
    mockConditional.mockImplementation(
      (_path, options): Promise<unknown> =>
        Promise.resolve(
          options.etag
            ? { status: 'not-modified' }
            : {
                status: 'fresh',
                body: page([project('p1')], 'r1', 'cursor-2'),
                etag: '"r1"',
              },
        ),
    );
    mockRequestJson.mockResolvedValueOnce(page([project('p2')]));
    await service.refresh(ACME);
    mockRequestJson.mockResolvedValueOnce(page([project('updated-p2')]));
    expect((await service.refresh(ACME)).projects.map((row) => row.id)).toEqual(
      ['p1', 'updated-p2'],
    );
    service.dispose();
  });

  it('keeps the last good snapshot, marked stale, when a refresh fails', async () => {
    const service = createOrgProjectCatalogService();
    await service.initialize();
    await service.refresh(ACME);
    mockConditional.mockRejectedValueOnce(
      new CanopyCloudClientError('network-error', 'offline'),
    );
    const stale = await service.refresh(ACME, { force: true });
    expect(stale.projects.map((row) => row.id)).toEqual(['p1']);
    expect(stale).toMatchObject({ stale: true, error: 'offline' });

    mockConditional.mockRejectedValueOnce(
      new CanopyCloudClientError('http-error', 'forbidden', 403),
    );
    expect(await service.refresh(ACME, { force: true })).toMatchObject({
      error: 'access-changed',
    });
    service.dispose();
  });

  it('reports unavailable without the server capability and does not call the catalog', async () => {
    mockGetCredentials.mockResolvedValue({
      baseUrl: 'https://cloud.example',
      apiKey: 'csk_acct',
      capabilities: [],
    });
    const service = createOrgProjectCatalogService();
    await service.initialize();
    const snapshot = await service.list(ACME);
    expect(snapshot).toMatchObject({ projects: [], error: 'unavailable' });
    expect(mockConditional).not.toHaveBeenCalled();
    service.dispose();
  });

  it('purges the account directory and refetches on an account change', async () => {
    const service = createOrgProjectCatalogService();
    await service.initialize();
    await service.list(ACME);
    accountListener?.(account('other'));
    await flush();
    expect(mockRm).toHaveBeenCalledWith(
      '/mock/data-dir/org-project-catalog/acct',
      expect.objectContaining({ recursive: true }),
    );
    // Sign-out purges too and answers unavailable from then on.
    accountListener?.(null);
    await flush();
    expect(mockRm).toHaveBeenCalledWith(
      '/mock/data-dir/org-project-catalog/other',
      expect.objectContaining({ recursive: true }),
    );
    expect(await service.list(ACME)).toMatchObject({ error: 'unavailable' });
    service.dispose();
  });

  it.each(['../../escape', 'nested/account', 'nested\\account', '.', '..'])(
    'treats unsafe account id %s as unavailable without filesystem access',
    async (id): Promise<void> => {
      mockLoadAccount.mockResolvedValue(account(id));
      const service = createOrgProjectCatalogService();
      try {
        await service.initialize();
        const initial = await service.list(ACME);
        accountListener?.(null);
        await flush();
        const signedOut = await service.list(ACME);
        accountListener?.(account(id));
        await flush();
        const changed = await service.refresh(ACME);
        accountListener?.(null);
        await flush();
        for (const [path] of [
          ...mockRm.mock.calls,
          ...mockMkdir.mock.calls,
          ...mockWriteFileAtomically.mock.calls,
        ]) {
          const withinRoot = relative(
            '/mock/data-dir/org-project-catalog',
            path,
          );
          expect(
            withinRoot !== '' &&
              withinRoot !== '..' &&
              !withinRoot.startsWith(`..${sep}`) &&
              !isAbsolute(withinRoot),
          ).toBe(true);
        }
        expect(mockRm).not.toHaveBeenCalled();
        expect(mockReadFile).not.toHaveBeenCalled();
        expect(mockMkdir).not.toHaveBeenCalled();
        expect(mockWriteFileAtomically).not.toHaveBeenCalled();
        for (const snapshot of [initial, signedOut, changed]) {
          expect(snapshot).toMatchObject({
            projects: [],
            error: 'unavailable',
          });
        }
      } finally {
        service.dispose();
      }
    },
  );

  it('refreshes the switched-to context and re-reads a cache older than the max age', async () => {
    const service = createOrgProjectCatalogService();
    await service.initialize();
    contextListener?.({ context: ACME });
    await flush();
    expect(mockConditional).toHaveBeenCalledTimes(1);

    mockReadFile.mockResolvedValue(
      JSON.stringify({
        version: 1,
        revision: 'old',
        projects: [project('old')],
        fetchedAt: new Date(
          Date.now() - ORG_PROJECT_CATALOG_MAX_AGE_MS - 1,
        ).toISOString(),
      }),
    );
    const other = createOrgProjectCatalogService();
    await other.initialize();
    const listed = await other.list({ kind: 'personal' });
    expect(listed.projects.map((row) => row.id)).toEqual(['old']);
    await flush();
    expect(mockConditional.mock.calls.length).toBeGreaterThanOrEqual(2);
    other.dispose();
    service.dispose();
  });

  it('writes a preference through the bearer route and refreshes unconditionally', async () => {
    mockRequestJson.mockResolvedValue({});
    const service = createOrgProjectCatalogService();
    await service.initialize();
    await service.list(ACME);
    await service.setPreference(ACME, 'p1', 'DISMISSED');
    const write = mockRequestJson.mock.calls[0];
    expect(write?.[0]).toBe(`/api/v1/projects/p1/preference`);
    expect(write?.[1]?.method).toBe('PUT');
    expect(JSON.parse(write?.[1]?.body ?? '{}')).toMatchObject({
      preference: 'DISMISSED',
    });
    const lastFetch =
      mockConditional.mock.calls[mockConditional.mock.calls.length - 1];
    expect(lastFetch?.[1].etag).toBeNull();
    service.dispose();
  });
  describe('refreshing repositories from GitHub (CAN-3489)', () => {
    it('asks the server to re-read GitHub, then fetches the catalog unconditionally', async (): Promise<void> => {
      const calls: string[] = [];
      mockRequestJson.mockImplementation((path): Promise<unknown> => {
        calls.push(path);
        return Promise.resolve({ status: 'refreshed' });
      });
      mockConditional.mockImplementation((path, options): Promise<unknown> => {
        calls.push(`${path} etag=${String(options.etag)}`);
        return Promise.resolve({
          status: 'fresh',
          body: page([project('p1'), project('new')]),
          etag: '"r2"',
        });
      });
      const service = createOrgProjectCatalogService();
      await service.initialize();

      const snapshot = await service.refresh(ACME, { repositories: true });

      expect(calls[0]).toBe('/api/v1/projects/repositories/refresh');
      expect(calls[1]).toContain('/api/v1/projects/catalog?');
      expect(calls[1]).toContain('etag=null');
      const refresh = mockRequestJson.mock.calls[0]?.[1];
      expect(refresh?.method).toBe('POST');
      expect(JSON.parse(refresh?.body ?? '{}')).toEqual({
        organizationId: ORG_A,
      });
      expect(snapshot.projects.map((row) => row.id)).toEqual(['p1', 'new']);
      expect(snapshot).not.toHaveProperty('repositoriesRefresh');
      service.dispose();
    });

    it.each([
      [
        'GitHub failed',
        (): Promise<unknown> => Promise.resolve({ status: 'failed' }),
      ],
      [
        'the refresh ran past its time box',
        (): Promise<unknown> => Promise.resolve({ status: 'timed-out' }),
      ],
      [
        'the refresh request failed',
        (): Promise<unknown> =>
          Promise.reject(
            new CanopyCloudClientError('network-error', 'offline'),
          ),
      ],
      [
        'the answer was not understood',
        (): Promise<unknown> => Promise.resolve({ status: 'done' }),
      ],
      [
        'the answer was malformed',
        (): Promise<unknown> => Promise.resolve(null),
      ],
      [
        'the server rejected the request',
        (): Promise<unknown> =>
          Promise.reject(
            new CanopyCloudClientError('http-error', 'denied', 403),
          ),
      ],
    ])(
      'still serves the catalog, marked, when %s',
      async (_label, answer): Promise<void> => {
        mockRequestJson.mockImplementation(answer);
        const service = createOrgProjectCatalogService();
        await service.initialize();

        const snapshot = await service.refresh(ACME, { repositories: true });

        expect(snapshot.projects.map((row) => row.id)).toEqual(['p1']);
        expect(snapshot).toMatchObject({
          stale: false,
          error: null,
          repositoriesRefresh: 'failed',
        });
        // The mark belongs to that open: a later refresh drops it.
        mockConditional.mockResolvedValueOnce({ status: 'not-modified' });
        expect(await service.refresh(ACME)).not.toHaveProperty(
          'repositoriesRefresh',
        );
        service.dispose();
      },
    );

    it.each([['refreshed'], ['recent']])(
      'marks nothing when the server answers %s',
      async (status): Promise<void> => {
        mockRequestJson.mockResolvedValue({ status });
        const service = createOrgProjectCatalogService();
        await service.initialize();

        expect(
          await service.refresh(ACME, { repositories: true }),
        ).not.toHaveProperty('repositoriesRefresh');
        service.dispose();
      },
    );

    it.each(['failed', 'not-connected'])(
      'publishes %s without persisting it and clears it on a catalog-only refresh',
      async (status): Promise<void> => {
        mockRequestJson.mockResolvedValue({ status });
        const service = createOrgProjectCatalogService();
        try {
          await service.initialize();
          const listener = jest.fn();
          service.subscribe(listener);

          const snapshot = await service.refresh(ACME, { repositories: true });

          expect(snapshot).toMatchObject({
            stale: false,
            error: null,
            repositoriesRefresh: status,
          });
          expect(service.peek(ACME)).toEqual(snapshot);
          expect(listener).toHaveBeenLastCalledWith(snapshot);
          expect(mockWriteFileAtomically).toHaveBeenCalled();
          for (const [, contents] of mockWriteFileAtomically.mock.calls) {
            expect(JSON.parse(String(contents))).not.toHaveProperty(
              'repositoriesRefresh',
            );
          }

          mockConditional.mockResolvedValueOnce({ status: 'not-modified' });
          expect(await service.refresh(ACME)).not.toHaveProperty(
            'repositoriesRefresh',
          );
          expect(service.peek(ACME)).not.toHaveProperty('repositoriesRefresh');
        } finally {
          service.dispose();
        }
      },
    );

    it.each(['refreshed', 'recent', '404'])(
      'clears an earlier transient mark when the repository refresh returns %s',
      async (status): Promise<void> => {
        const service = createOrgProjectCatalogService();
        try {
          await service.initialize();
          mockRequestJson.mockResolvedValueOnce({ status: 'failed' });
          expect(
            await service.refresh(ACME, { repositories: true }),
          ).toHaveProperty('repositoriesRefresh', 'failed');

          if (status === '404') {
            mockRequestJson.mockRejectedValueOnce(
              new CanopyCloudClientError('http-error', 'not found', 404),
            );
          } else {
            mockRequestJson.mockResolvedValueOnce({ status });
          }
          expect(
            await service.refresh(ACME, { repositories: true }),
          ).not.toHaveProperty('repositoriesRefresh');
        } finally {
          service.dispose();
        }
      },
    );

    it('does not ask GitHub when the server capability is unavailable', async (): Promise<void> => {
      mockGetCredentials.mockResolvedValue({ capabilities: [] });
      const service = createOrgProjectCatalogService();
      try {
        await service.initialize();
        expect(
          await service.refresh(ACME, { repositories: true }),
        ).toMatchObject({ error: 'unavailable' });
        expect(service.peek(ACME)).not.toHaveProperty('repositoriesRefresh');
        expect(mockRequestJson).not.toHaveBeenCalled();
      } finally {
        service.dispose();
      }
    });

    it('drops the connection mark when the catalog fetch fails', async (): Promise<void> => {
      mockRequestJson.mockResolvedValue({ status: 'not-connected' });
      const service = createOrgProjectCatalogService();
      try {
        await service.initialize();
        await service.refresh(ACME, { repositories: true });
        mockConditional.mockRejectedValueOnce(new Error('offline'));

        const snapshot = await service.refresh(ACME, { repositories: true });

        expect(snapshot).toMatchObject({ stale: true, error: 'offline' });
        expect(snapshot).not.toHaveProperty('repositoriesRefresh');
      } finally {
        service.dispose();
      }
    });

    it('never asks GitHub for the Personal catalog', async (): Promise<void> => {
      const service = createOrgProjectCatalogService();
      await service.initialize();

      await service.refresh({ kind: 'personal' }, { repositories: true });

      expect(mockRequestJson).not.toHaveBeenCalled();
      expect(mockConditional).toHaveBeenCalled();
      service.dispose();
    });
  });
});
