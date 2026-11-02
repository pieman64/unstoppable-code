import type {
  DesktopInventoryManifestResponse,
  DesktopInventorySyncRequest,
  DesktopInventorySyncResponse,
} from '@canopy/protocol/desktop-inventory';

interface CloudRequestInit {
  method?: string;
  body?: string;
  credentialContext?: unknown;
}

type CloudResponse =
  | DesktopInventorySyncResponse
  | DesktopInventoryManifestResponse;

const mockRequestCanopyCloudJson = jest.fn<
  Promise<CloudResponse>,
  [string, CloudRequestInit?]
>();
const mockGetCanopyCloudCredentials = jest.fn<Promise<unknown>, []>();
const mockSubscribeAccountChanges = jest.fn<() => void, [() => void]>();
const mockSubscribeInvocableInventoryChanges = jest.fn<
  () => void,
  [() => void]
>();
const mockReadPortalStateStore = jest.fn<
  Promise<{ clientDeviceId: string }>,
  []
>();
const mockLogMainProcessError = jest.fn<void, [string, unknown]>();

jest.mock('../../canopy-cloud/client', () => {
  class CanopyCloudClientError extends Error {
    constructor(
      readonly code: string,
      message: string,
      readonly status?: number,
      readonly serverCode?: string,
      readonly serverScope?: string,
      readonly isValidatedServerError = false,
      readonly retryAfterMs?: number,
    ) {
      super(message);
      this.name = 'CanopyCloudClientError';
    }
  }
  return {
    CanopyCloudClientError,
    get requestCanopyCloudJson(): typeof mockRequestCanopyCloudJson {
      return mockRequestCanopyCloudJson;
    },
  };
});
jest.mock('../../lib/canopy-cloud-account-store', () => ({
  get getCanopyCloudCredentials(): typeof mockGetCanopyCloudCredentials {
    return mockGetCanopyCloudCredentials;
  },
  get subscribeCanopyCloudAccountChanges(): typeof mockSubscribeAccountChanges {
    return mockSubscribeAccountChanges;
  },
}));
jest.mock('../../lib/main-process-logging', () => ({
  get logMainProcessError(): typeof mockLogMainProcessError {
    return mockLogMainProcessError;
  },
}));
jest.mock('../../plugins/invocable-inventory-service', () => ({
  get subscribeInvocableInventoryChanges(): typeof mockSubscribeInvocableInventoryChanges {
    return mockSubscribeInvocableInventoryChanges;
  },
}));
jest.mock('../../portal/portal-state-store', () => ({
  get readPortalStateStore(): typeof mockReadPortalStateStore {
    return mockReadPortalStateStore;
  },
}));
jest.mock('../desktop-inventory-pipeline-documents', () => ({
  listWorktreePipelineInventoryDocuments: jest.fn(),
}));
jest.mock('../plugin-catalog-service', () => ({
  listPortalMarketplaces: jest
    .fn()
    .mockResolvedValue({ marketplaces: [], lastRefreshed: '' }),
  listPortalSkills: jest.fn(),
  listPersonalPortalSkills: jest.fn(),
  listPortalMcpServers: jest.fn().mockResolvedValue({ servers: [] }),
  listPortalCollections: jest.fn(),
  listPersonalPortalCollections: jest.fn(),
}));
jest.mock('@canopy/brand/current', () => ({
  BRAND: { displayName: 'Canopy', web: { apiNamespace: 'desktop-app' } },
}));

import {
  MAX_DESKTOP_INVENTORY_DOCUMENTS_PER_REQUEST,
  MAX_DESKTOP_INVENTORY_REMOVALS_PER_REQUEST,
  MAX_DESKTOP_INVENTORY_REQUEST_BYTES,
} from '@canopy/protocol/desktop-inventory';
import { CanopyCloudClientError } from '../../canopy-cloud/client';
import { notifyDesktopInventoryChanged } from '../desktop-inventory-sync-signals';
import {
  DESKTOP_INVENTORY_SYNC_DEBOUNCE_MS,
  DESKTOP_INVENTORY_SYNC_RECONCILE_INTERVAL_MS,
  DESKTOP_INVENTORY_SYNC_RETRY_MS,
  DesktopInventorySyncService,
  hashDesktopInventoryPayload,
  type DesktopInventorySyncServiceOptions,
} from '../desktop-inventory-sync-service';
import {
  listPersonalPortalCollections,
  listPersonalPortalSkills,
  listPortalCollections,
  listPortalSkills,
} from '../plugin-catalog-service';
import { listWorktreePipelineInventoryDocuments } from '../desktop-inventory-pipeline-documents';

const mockDefaultPipelineReader = jest.mocked(
  listWorktreePipelineInventoryDocuments,
);
const mockListPortalSkills = jest.mocked(listPortalSkills);
const mockListPortalCollections = jest.mocked(listPortalCollections);
const mockListPersonalPortalSkills = jest.mocked(listPersonalPortalSkills);
const mockListPersonalPortalCollections = jest.mocked(
  listPersonalPortalCollections,
);

type Readers = NonNullable<DesktopInventorySyncServiceOptions['readers']>;

const NOW = new Date('2026-09-06T14:00:00.000Z');
const CREDENTIALS = { baseUrl: 'https://cloud.test', apiKey: 'key' };
const SYNC_PATH = '/api/v1/desktop-app/desktop-inventory/documents';
const MANIFEST_PATH = `${SYNC_PATH}?clientDeviceId=device-1`;

function isSyncRequest(value: unknown): value is DesktopInventorySyncRequest {
  return (
    typeof value === 'object' &&
    value !== null &&
    'documents' in value &&
    Array.isArray(value.documents)
  );
}

function parseRequest(body: string): DesktopInventorySyncRequest {
  const value: unknown = JSON.parse(body);
  if (!isSyncRequest(value)) throw new Error('unexpected request body');
  return value;
}

/** Only the PUT uploads; the manifest GET is a separate concern. */
function putRequests(): DesktopInventorySyncRequest[] {
  return mockRequestCanopyCloudJson.mock.calls
    .filter(([, init]) => init?.method === 'PUT')
    .map(([, init]) => parseRequest(init?.body ?? ''));
}

function manifestCalls(): number {
  return mockRequestCanopyCloudJson.mock.calls.filter(
    ([path, init]) => path === MANIFEST_PATH && init?.method === undefined,
  ).length;
}

function lastRequest(): DesktopInventorySyncRequest {
  const requests = putRequests();
  const last = requests[requests.length - 1];
  if (!last) throw new Error('no cloud upload was made');
  return last;
}

function acceptAll(
  request: DesktopInventorySyncRequest,
): DesktopInventorySyncResponse {
  return {
    accepted: request.documents.map((document) => ({
      kind: document.kind,
      scopeKey: document.scopeKey,
      contentHash: document.contentHash,
      unchanged: false,
    })),
    removed: request.removals?.length ?? 0,
  };
}

let manifest: DesktopInventoryManifestResponse;

function defaultCloud(
  path: string,
  init?: CloudRequestInit,
): Promise<CloudResponse> {
  if (init?.method === 'PUT') {
    return Promise.resolve(acceptAll(parseRequest(init.body ?? '')));
  }
  if (path === MANIFEST_PATH) return Promise.resolve(manifest);
  return Promise.reject(new Error(`unexpected request ${path}`));
}

async function drainDebounce(): Promise<void> {
  await jest.advanceTimersByTimeAsync(DESKTOP_INVENTORY_SYNC_DEBOUNCE_MS);
}

describe('DesktopInventorySyncService', () => {
  let service: DesktopInventorySyncService;
  let accountListener: (() => void) | undefined;
  let inventoryListener: (() => void) | undefined;

  function create(readers: Partial<Readers> = {}): {
    skills: jest.Mock;
    collections: jest.Mock;
    pipelines: jest.Mock;
  } {
    const skills = jest.fn().mockResolvedValue({ skills: [] });
    const collections = jest.fn().mockResolvedValue({ collections: [] });
    const pipelines = jest.fn().mockResolvedValue({
      documents: [],
      complete: true,
      nonPersonalWorkspaceIds: [],
    });
    service = new DesktopInventorySyncService({
      readers: {
        marketplaces: jest
          .fn()
          .mockResolvedValue({ marketplaces: [], lastRefreshed: '' }),
        skills,
        mcp_servers: jest.fn().mockResolvedValue({ servers: [] }),
        collections,
        pipelines,
        ...readers,
      },
      clientName: (): string => 'sergii-macbook',
      now: (): Date => NOW,
    });
    return { skills, collections, pipelines };
  }

  function startEnabled(): void {
    service.setFeatureFlagEnabled(true);
    service.start();
  }

  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    manifest = { clientDeviceId: 'device-1', documents: [] };
    mockGetCanopyCloudCredentials.mockResolvedValue(CREDENTIALS);
    mockReadPortalStateStore.mockResolvedValue({ clientDeviceId: 'device-1' });
    mockSubscribeAccountChanges.mockImplementation((listener) => {
      accountListener = listener;
      return jest.fn();
    });
    mockSubscribeInvocableInventoryChanges.mockImplementation((listener) => {
      inventoryListener = listener;
      return jest.fn();
    });
    mockRequestCanopyCloudJson.mockImplementation(defaultCloud);
    mockDefaultPipelineReader.mockResolvedValue({
      documents: [],
      complete: true,
      nonPersonalWorkspaceIds: [],
    });
    mockListPersonalPortalSkills.mockResolvedValue({ skills: [] });
    mockListPersonalPortalCollections.mockResolvedValue({ collections: [] });
  });

  it('uses the Personal skills and Collections readers by default', async () => {
    service = new DesktopInventorySyncService({
      clientName: (): string => 'sergii-macbook',
      now: (): Date => NOW,
    });
    startEnabled();
    await drainDebounce();

    expect(mockListPersonalPortalSkills).toHaveBeenCalled();
    expect(mockListPersonalPortalCollections).toHaveBeenCalled();
    expect(mockListPortalSkills).not.toHaveBeenCalled();
    expect(mockListPortalCollections).not.toHaveBeenCalled();
  });

  afterEach(() => {
    service.dispose();
    jest.useRealTimers();
  });

  it('uploads device MCP rows only', async (): Promise<void> => {
    create({
      mcp_servers: jest.fn().mockResolvedValue({
        providerConnectors: [
          {
            provider: 'codex',
            connectors: [{ displayName: 'Drive', connected: true }],
          },
        ],
        servers: [
          { id: 'device', scope: 'device', urlHost: 'mcp.example.test' },
          { id: 'legacy' },
          {
            id: 'account',
            scope: 'account',
            authHandler: 'account',
            accountConnectionId: 'a1111111-1111-4111-8111-111111111111',
          },
          {
            id: 'curated-account',
            scope: 'account',
            authHandler: 'account',
            curatedKey: 'github',
          },
        ],
      }),
    });
    startEnabled();
    await drainDebounce();
    const document = lastRequest().documents.find(
      (entry): boolean => entry.kind === 'mcp_servers',
    );
    expect(document?.payload).toEqual({
      providerConnectors: [
        {
          provider: 'codex',
          connectors: [{ displayName: 'Drive', connected: true }],
        },
      ],
      servers: [
        { id: 'device', scope: 'device', urlHost: 'mcp.example.test' },
        { id: 'legacy' },
      ],
    });
  });

  it('excludes an inherited account binding from device inventory', async (): Promise<void> => {
    // The index writer resolves the global default even when the definition
    // has no per-server HTTP auth handler.
    create({
      mcp_servers: jest.fn().mockResolvedValue({
        servers: [
          { id: 'device', scope: 'device' },
          {
            id: 'inherited-account',
            type: 'http',
            scope: 'account',
            authHandler: 'account',
            accountConnectionId: 'a1111111-1111-4111-8111-111111111111',
          },
        ],
      }),
    });
    startEnabled();
    await drainDebounce();
    const document = lastRequest().documents.find(
      (entry): boolean => entry.kind === 'mcp_servers',
    );
    expect(document?.payload).toEqual({
      servers: [{ id: 'device', scope: 'device' }],
    });
  });

  it('drops a custom HTTP row once it is promoted to an account connection', async (): Promise<void> => {
    const local = {
      id: 'custom',
      type: 'http',
      scope: 'device',
      urlHost: 'mcp.example.test',
    };
    const servers = jest
      .fn()
      .mockResolvedValueOnce({ servers: [local] })
      .mockResolvedValue({
        servers: [
          {
            ...local,
            scope: 'account',
            authHandler: 'account',
            accountConnectionId: 'b2222222-2222-4222-8222-222222222222',
          },
        ],
      });
    create({ mcp_servers: servers });
    startEnabled();
    await drainDebounce();
    expect(
      lastRequest().documents.find(
        (entry): boolean => entry.kind === 'mcp_servers',
      )?.payload,
    ).toEqual({ servers: [local] });
    inventoryListener?.();
    await drainDebounce();
    expect(
      lastRequest().documents.find(
        (entry): boolean => entry.kind === 'mcp_servers',
      )?.payload,
    ).toEqual({ servers: [] });
  });

  it('reads the manifest once, then pushes every device-level kind on start', async () => {
    create();
    startEnabled();
    expect(mockRequestCanopyCloudJson).not.toHaveBeenCalled();
    await drainDebounce();

    expect(manifestCalls()).toBe(1);
    expect(putRequests()).toHaveLength(1);
    const [path, init] = mockRequestCanopyCloudJson.mock.calls[1] ?? [];
    expect(path).toBe(SYNC_PATH);
    expect(init?.method).toBe('PUT');
    const request = lastRequest();
    expect(request.clientDeviceId).toBe('device-1');
    expect(request.clientName).toBe('sergii-macbook');
    expect(request.documents.map((document) => document.kind)).toEqual([
      'marketplaces',
      'skills',
      'mcp_servers',
      'collections',
    ]);
    for (const document of request.documents) {
      expect(document.scopeKey).toBe('');
      expect(document.capturedAt).toBe(NOW.toISOString());
      expect(document.contentHash).toBe(
        hashDesktopInventoryPayload(document.payload),
      );
    }
  });

  it('does nothing while the feature flag is off', async () => {
    create();
    service.start();
    await drainDebounce();
    expect(mockRequestCanopyCloudJson).not.toHaveBeenCalled();

    service.setFeatureFlagEnabled(true);
    await drainDebounce();
    expect(putRequests()).toHaveLength(1);
  });

  it('keeps the push pending until cloud credentials exist', async () => {
    mockGetCanopyCloudCredentials.mockRejectedValue(new Error('no key'));
    create();
    startEnabled();
    await drainDebounce();
    expect(mockRequestCanopyCloudJson).not.toHaveBeenCalled();
    // No polling loop: the missing credential is probed once and the push
    // waits for the identity-change subscription.
    await drainDebounce();
    await drainDebounce();
    expect(mockGetCanopyCloudCredentials).toHaveBeenCalledTimes(1);

    mockGetCanopyCloudCredentials.mockResolvedValue(CREDENTIALS);
    accountListener?.();
    await drainDebounce();
    expect(putRequests()).toHaveLength(1);
    expect(lastRequest().documents).toHaveLength(4);
  });

  it('skips documents whose accepted hash has not changed', async () => {
    const { skills } = create();
    skills.mockResolvedValue({ skills: [{ name: 'a' }] });
    startEnabled();
    await drainDebounce();
    expect(putRequests()).toHaveLength(1);

    inventoryListener?.();
    await drainDebounce();
    // Nothing changed: no second upload at all.
    expect(putRequests()).toHaveLength(1);

    skills.mockResolvedValue({ skills: [{ name: 'a' }, { name: 'b' }] });
    inventoryListener?.();
    await drainDebounce();
    expect(putRequests()).toHaveLength(2);
    expect(lastRequest().documents.map((document) => document.kind)).toEqual([
      'skills',
    ]);
  });

  it('pushes only the kinds a persistence signal names', async () => {
    const { collections } = create();
    startEnabled();
    await drainDebounce();
    collections.mockResolvedValue({
      collections: [{ id: 'c1', name: 'One' }],
    });

    notifyDesktopInventoryChanged(['collections']);
    await drainDebounce();
    expect(putRequests()).toHaveLength(2);
    expect(lastRequest().documents.map((document) => document.kind)).toEqual([
      'collections',
    ]);
  });

  it('coalesces a burst of triggers into one request', async () => {
    create();
    startEnabled();
    inventoryListener?.();
    notifyDesktopInventoryChanged(['collections']);
    await jest.advanceTimersByTimeAsync(DESKTOP_INVENTORY_SYNC_DEBOUNCE_MS / 2);
    inventoryListener?.();
    await drainDebounce();
    expect(putRequests()).toHaveLength(1);
  });

  it('skips a kind whose reader fails and still pushes the rest', async () => {
    create({ skills: jest.fn().mockRejectedValue(new Error('boom')) });
    startEnabled();
    await drainDebounce();
    expect(mockLogMainProcessError).toHaveBeenCalledWith(
      'Desktop inventory read failed (skills)',
      expect.any(Error),
    );
    expect(lastRequest().documents.map((document) => document.kind)).toEqual([
      'marketplaces',
      'mcp_servers',
      'collections',
    ]);
  });

  it('suspends after a validated 403 until the identity changes', async () => {
    mockRequestCanopyCloudJson.mockImplementation((path, init) =>
      init?.method === 'PUT'
        ? Promise.reject(
            new CanopyCloudClientError(
              'http-error',
              'forbidden',
              403,
              undefined,
              undefined,
              true,
            ),
          )
        : defaultCloud(path, init),
    );
    create();
    startEnabled();
    await drainDebounce();
    expect(putRequests()).toHaveLength(1);

    inventoryListener?.();
    await jest.advanceTimersByTimeAsync(DESKTOP_INVENTORY_SYNC_RETRY_MS[2] * 2);
    expect(putRequests()).toHaveLength(1);

    mockRequestCanopyCloudJson.mockImplementation(defaultCloud);
    accountListener?.();
    await drainDebounce();
    expect(putRequests()).toHaveLength(2);
    expect(lastRequest().documents).toHaveLength(4);
  });

  it('treats an unvalidated 403 (gateway, captive portal) as transient', async () => {
    mockRequestCanopyCloudJson.mockImplementationOnce(defaultCloud);
    mockRequestCanopyCloudJson.mockImplementationOnce(() =>
      Promise.reject(
        new CanopyCloudClientError('http-error', 'forbidden', 403),
      ),
    );
    create();
    startEnabled();
    await drainDebounce();
    expect(putRequests()).toHaveLength(1);
    await jest.advanceTimersByTimeAsync(DESKTOP_INVENTORY_SYNC_RETRY_MS[0]);
    expect(putRequests()).toHaveLength(2);
  });

  it('binds every request of a flush to the credentials resolved at its start', async () => {
    create();
    startEnabled();
    await drainDebounce();
    expect(manifestCalls()).toBe(1);
    expect(putRequests()).toHaveLength(1);
    for (const [, init] of mockRequestCanopyCloudJson.mock.calls) {
      expect(init?.credentialContext).toBe(CREDENTIALS);
    }
  });

  it('suspends on a validated 403 manifest read', async () => {
    mockRequestCanopyCloudJson.mockImplementation((path, init) =>
      path === MANIFEST_PATH && init?.method === undefined
        ? Promise.reject(
            new CanopyCloudClientError(
              'http-error',
              'forbidden',
              403,
              undefined,
              undefined,
              true,
            ),
          )
        : defaultCloud(path, init),
    );
    create();
    startEnabled();
    await drainDebounce();
    expect(putRequests()).toHaveLength(0);
    inventoryListener?.();
    await drainDebounce();
    expect(manifestCalls()).toBe(1);
    expect(putRequests()).toHaveLength(0);
  });

  it('treats an unvalidated 403 manifest read as transient', async () => {
    mockRequestCanopyCloudJson.mockImplementationOnce(() =>
      Promise.reject(
        new CanopyCloudClientError('http-error', 'forbidden', 403),
      ),
    );
    create();
    startEnabled();
    await drainDebounce();
    // The flush went on without removals; the next flush reads it again.
    expect(putRequests()).toHaveLength(1);
    inventoryListener?.();
    await drainDebounce();
    expect(manifestCalls()).toBe(2);
    expect(putRequests()).toHaveLength(2);
  });

  it('does not start an upload once the flag turned off mid-flush', async () => {
    let releaseCredentials: (() => void) | undefined;
    mockGetCanopyCloudCredentials.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseCredentials = (): void => resolve({ apiKey: 'key' });
        }),
    );
    create();
    startEnabled();
    await drainDebounce();
    service.setFeatureFlagEnabled(false);
    releaseCredentials?.();
    await drainDebounce();
    expect(putRequests()).toHaveLength(0);
  });

  it('clears a debounce armed during a failed upload so backoff owns the retry', async () => {
    let rejectFirst: ((error: Error) => void) | undefined;
    mockRequestCanopyCloudJson.mockImplementation((path, init) =>
      init?.method === 'PUT'
        ? new Promise<CloudResponse>((_, reject) => {
            rejectFirst = reject;
          })
        : defaultCloud(path, init),
    );
    const { skills } = create();
    startEnabled();
    await drainDebounce();
    expect(putRequests()).toHaveLength(1);

    mockRequestCanopyCloudJson.mockImplementation(defaultCloud);
    skills.mockResolvedValue({ skills: [{ name: 'late' }] });
    inventoryListener?.();
    rejectFirst?.(new CanopyCloudClientError('network-error', 'offline'));
    await drainDebounce();
    await drainDebounce();
    // The armed debounce did not fire an early retry.
    expect(putRequests()).toHaveLength(1);
    await jest.advanceTimersByTimeAsync(DESKTOP_INVENTORY_SYNC_RETRY_MS[0]);
    expect(putRequests()).toHaveLength(2);
  });

  it('retries a transient failure on the retry ladder', async () => {
    mockRequestCanopyCloudJson.mockImplementationOnce(defaultCloud);
    mockRequestCanopyCloudJson.mockImplementationOnce(() =>
      Promise.reject(new CanopyCloudClientError('network-error', 'offline')),
    );
    create();
    startEnabled();
    await drainDebounce();
    expect(putRequests()).toHaveLength(1);

    await jest.advanceTimersByTimeAsync(DESKTOP_INVENTORY_SYNC_RETRY_MS[0] - 1);
    expect(putRequests()).toHaveLength(1);
    await jest.advanceTimersByTimeAsync(1);
    expect(putRequests()).toHaveLength(2);
    expect(lastRequest().documents).toHaveLength(4);
  });

  it('drops a validation rejection instead of retrying it', async () => {
    mockRequestCanopyCloudJson.mockImplementationOnce(defaultCloud);
    mockRequestCanopyCloudJson.mockImplementationOnce(() =>
      Promise.reject(
        new CanopyCloudClientError(
          'http-error',
          'bad',
          400,
          undefined,
          undefined,
          true,
        ),
      ),
    );
    create();
    startEnabled();
    await drainDebounce();
    await jest.advanceTimersByTimeAsync(DESKTOP_INVENTORY_SYNC_RETRY_MS[2] * 2);
    expect(putRequests()).toHaveLength(1);
    expect(mockLogMainProcessError).toHaveBeenCalledWith(
      'Desktop inventory sync rejected',
      expect.any(Error),
    );
  });

  it('pushes a change that arrives during a flush after that flush settles', async () => {
    let resolveFirst: ((value: CloudResponse) => void) | undefined;
    mockRequestCanopyCloudJson.mockImplementation((path, init) =>
      init?.method === 'PUT'
        ? new Promise<CloudResponse>((resolve) => {
            resolveFirst = resolve;
          })
        : defaultCloud(path, init),
    );
    const { skills } = create();
    startEnabled();
    await drainDebounce();
    expect(putRequests()).toHaveLength(1);

    skills.mockResolvedValue({ skills: [{ name: 'late' }] });
    inventoryListener?.();
    await drainDebounce();
    expect(putRequests()).toHaveLength(1);

    mockRequestCanopyCloudJson.mockImplementation(defaultCloud);
    resolveFirst?.(acceptAll(lastRequest()));
    await drainDebounce();
    await drainDebounce();
    expect(putRequests()).toHaveLength(2);
    expect(lastRequest().documents.map((document) => document.kind)).toEqual([
      'skills',
    ]);
  });

  it('ignores a response that lands after the identity changed', async () => {
    let resolveFirst: ((value: CloudResponse) => void) | undefined;
    mockRequestCanopyCloudJson.mockImplementation((path, init) =>
      init?.method === 'PUT'
        ? new Promise<CloudResponse>((resolve) => {
            resolveFirst = resolve;
          })
        : defaultCloud(path, init),
    );
    create();
    startEnabled();
    await drainDebounce();
    expect(putRequests()).toHaveLength(1);
    const stale = lastRequest();

    // Sign-out/sign-in while the first upload is in flight.
    mockRequestCanopyCloudJson.mockImplementation(defaultCloud);
    accountListener?.();
    resolveFirst?.(acceptAll(stale));
    await drainDebounce();
    // The new identity re-reads the manifest and pushes everything again:
    // the stale acceptance did not mark its documents as accepted.
    expect(manifestCalls()).toBe(2);
    expect(putRequests()).toHaveLength(2);
    expect(lastRequest().documents).toHaveLength(4);
  });

  it('re-sends unchanged documents on the periodic reconcile', async () => {
    create();
    startEnabled();
    await drainDebounce();
    expect(putRequests()).toHaveLength(1);

    await jest.advanceTimersByTimeAsync(
      DESKTOP_INVENTORY_SYNC_RECONCILE_INTERVAL_MS +
        DESKTOP_INVENTORY_SYNC_DEBOUNCE_MS,
    );
    expect(putRequests()).toHaveLength(2);
    expect(lastRequest().documents).toHaveLength(4);
  });

  it('accumulates changes during a transient-failure backoff instead of re-arming', async () => {
    mockRequestCanopyCloudJson.mockImplementationOnce(defaultCloud);
    mockRequestCanopyCloudJson.mockImplementationOnce(() =>
      Promise.reject(new CanopyCloudClientError('network-error', 'offline')),
    );
    const { collections } = create();
    startEnabled();
    await drainDebounce();
    expect(putRequests()).toHaveLength(1);

    collections.mockResolvedValue({ collections: [{ id: 'c1', name: 'C' }] });
    notifyDesktopInventoryChanged(['collections']);
    await drainDebounce();
    // Still inside the 15 s backoff: nothing was sent.
    expect(putRequests()).toHaveLength(1);

    await jest.advanceTimersByTimeAsync(DESKTOP_INVENTORY_SYNC_RETRY_MS[0]);
    expect(putRequests()).toHaveLength(2);
    expect(lastRequest().documents).toHaveLength(4);
  });

  describe('pipelines', () => {
    it('removes accepted organization workspace documents even when another read is incomplete', async () => {
      manifest = {
        clientDeviceId: 'device-1',
        documents: [
          { kind: 'pipelines', scopeKey: 'org-ws:wt-a', contentHash: 'a' },
          { kind: 'pipelines', scopeKey: 'org-ws:wt-b', contentHash: 'b' },
          { kind: 'pipelines', scopeKey: 'personal-ws:wt-a', contentHash: 'c' },
        ],
      };
      const { pipelines } = create();
      pipelines.mockResolvedValue({
        documents: [],
        complete: false,
        nonPersonalWorkspaceIds: ['org-ws'],
      });

      startEnabled();
      await drainDebounce();

      expect(
        putRequests().flatMap((request) => request.removals ?? []),
      ).toEqual([
        { kind: 'pipelines', scopeKey: 'org-ws:wt-a' },
        { kind: 'pipelines', scopeKey: 'org-ws:wt-b' },
      ]);
    });
    it('pushes one document per worktree and removes worktrees the cloud holds but the desktop lost', async () => {
      const { pipelines } = create();
      pipelines.mockResolvedValue({
        documents: [
          { scopeKey: 'ws-1:wt-a', payload: { pipelines: [] } },
          { scopeKey: 'ws-1:wt-b', payload: { pipelines: [] } },
        ],
        complete: true,
      });
      startEnabled();
      await drainDebounce();
      const first = lastRequest();
      expect(
        first.documents
          .filter((document) => document.kind === 'pipelines')
          .map((document) => document.scopeKey),
      ).toEqual(['ws-1:wt-a', 'ws-1:wt-b']);
      expect(first.removals).toBeUndefined();

      pipelines.mockResolvedValue({
        documents: [{ scopeKey: 'ws-1:wt-a', payload: { pipelines: [] } }],
        complete: true,
      });
      notifyDesktopInventoryChanged(['pipelines']);
      await drainDebounce();
      expect(putRequests()).toHaveLength(2);
      const second = lastRequest();
      expect(second.documents).toEqual([]);
      expect(second.removals).toEqual([
        { kind: 'pipelines', scopeKey: 'ws-1:wt-b' },
      ]);

      // The removal is forgotten once accepted: no third upload for it.
      notifyDesktopInventoryChanged(['pipelines']);
      await drainDebounce();
      expect(putRequests()).toHaveLength(2);
    });

    it('uploads every document on the first flush after the manifest loads', async () => {
      // The manifest already holds the current skills hash; the first flush
      // still sends it so syncedAt reflects this session.
      const skillsPayload = { skills: [{ name: 'a' }] };
      manifest = {
        clientDeviceId: 'device-1',
        documents: [
          {
            kind: 'skills',
            scopeKey: '',
            contentHash: hashDesktopInventoryPayload(skillsPayload),
          },
        ],
      };
      const { skills } = create();
      skills.mockResolvedValue(skillsPayload);
      startEnabled();
      await drainDebounce();
      expect(
        lastRequest().documents.map((document) => document.kind),
      ).toContain('skills');

      // Afterwards the manifest hash does its job: unchanged skills skip.
      inventoryListener?.();
      await drainDebounce();
      expect(putRequests()).toHaveLength(1);
    });

    it('sends removals in their own requests before any documents', async () => {
      manifest = {
        clientDeviceId: 'device-1',
        documents: [
          {
            kind: 'pipelines',
            scopeKey: 'ws-1:wt-gone',
            contentHash: 'a'.repeat(64),
          },
        ],
      };
      const { pipelines } = create();
      pipelines.mockResolvedValue({
        documents: [{ scopeKey: 'ws-1:wt-new', payload: { pipelines: [] } }],
        complete: true,
      });
      startEnabled();
      await drainDebounce();
      const requests = putRequests();
      expect(requests).toHaveLength(2);
      expect(requests[0]?.documents).toEqual([]);
      expect(requests[0]?.removals).toEqual([
        { kind: 'pipelines', scopeKey: 'ws-1:wt-gone' },
      ]);
      expect(requests[1]?.removals).toBeUndefined();
      expect(
        requests[1]?.documents.map((document) => document.scopeKey),
      ).toContain('ws-1:wt-new');
    });

    it('removes a worktree the cloud manifest holds after a restart', async () => {
      // Fresh process: nothing in memory, but the cloud still has wt-gone.
      manifest = {
        clientDeviceId: 'device-1',
        documents: [
          {
            kind: 'pipelines',
            scopeKey: 'ws-1:wt-gone',
            contentHash: 'a'.repeat(64),
          },
        ],
      };
      const { pipelines } = create();
      pipelines.mockResolvedValue({
        documents: [{ scopeKey: 'ws-1:wt-a', payload: { pipelines: [] } }],
        complete: true,
      });
      startEnabled();
      await drainDebounce();
      const requests = putRequests();
      expect(requests[0]?.removals).toEqual([
        { kind: 'pipelines', scopeKey: 'ws-1:wt-gone' },
      ]);
      expect(
        requests.flatMap((request) => request.documents).map((d) => d.scopeKey),
      ).toContain('ws-1:wt-a');
    });

    it('never removes while the manifest is unknown', async () => {
      mockRequestCanopyCloudJson.mockImplementation((path, init) =>
        path === MANIFEST_PATH && init?.method === undefined
          ? Promise.reject(new CanopyCloudClientError('network-error', 'off'))
          : defaultCloud(path, init),
      );
      const { pipelines } = create();
      pipelines.mockResolvedValue({
        documents: [{ scopeKey: 'ws-1:wt-a', payload: { pipelines: [] } }],
        complete: true,
      });
      startEnabled();
      await drainDebounce();
      // Documents still push; no removal can be proven without the manifest.
      expect(putRequests()).toHaveLength(1);
      expect(lastRequest().removals).toBeUndefined();
      expect(mockLogMainProcessError).toHaveBeenCalledWith(
        'Desktop inventory manifest read failed',
        expect.any(Error),
      );

      // The next flush retries the manifest.
      mockRequestCanopyCloudJson.mockImplementation(defaultCloud);
      notifyDesktopInventoryChanged(['pipelines']);
      await drainDebounce();
      expect(manifestCalls()).toBe(2);
    });

    it('never turns an incomplete read into removals', async () => {
      const { pipelines } = create();
      pipelines.mockResolvedValue({
        documents: [
          { scopeKey: 'ws-1:wt-a', payload: { pipelines: [] } },
          { scopeKey: 'ws-1:wt-b', payload: { pipelines: [] } },
        ],
        complete: true,
      });
      startEnabled();
      await drainDebounce();
      expect(putRequests()).toHaveLength(1);

      // wt-b's discovery failed: it is absent from the read but not proven
      // gone, so wt-a still pushes when it changes and nothing is removed.
      pipelines.mockResolvedValue({
        documents: [
          {
            scopeKey: 'ws-1:wt-a',
            payload: { pipelines: [], truncated: true },
          },
        ],
        complete: false,
      });
      notifyDesktopInventoryChanged(['pipelines']);
      await drainDebounce();
      expect(putRequests()).toHaveLength(2);
      expect(
        lastRequest().documents.map((document) => document.scopeKey),
      ).toEqual(['ws-1:wt-a']);
      expect(lastRequest().removals).toBeUndefined();
    });

    it('never turns a failed read into documents or removals', async () => {
      const { pipelines } = create();
      pipelines.mockResolvedValue({
        documents: [{ scopeKey: 'ws-1:wt-a', payload: { pipelines: [] } }],
        complete: true,
      });
      startEnabled();
      await drainDebounce();
      expect(putRequests()).toHaveLength(1);

      pipelines.mockRejectedValue(new Error('disk'));
      notifyDesktopInventoryChanged(['pipelines']);
      await drainDebounce();
      expect(putRequests()).toHaveLength(1);
      expect(mockLogMainProcessError).toHaveBeenCalledWith(
        'Desktop inventory read failed (pipelines)',
        expect.any(Error),
      );
    });

    it('splits a large push into requests that respect the count limits', async () => {
      const { pipelines } = create();
      const count = MAX_DESKTOP_INVENTORY_DOCUMENTS_PER_REQUEST + 4;
      pipelines.mockResolvedValue({
        documents: Array.from({ length: count }, (_, index) => ({
          scopeKey: `ws:wt-${index}`,
          payload: { pipelines: [] },
        })),
        complete: true,
      });
      startEnabled();
      await drainDebounce();
      const sizes = putRequests().map((request) => request.documents.length);
      // 4 device-level documents ride in the first request alongside pipelines.
      expect(sizes).toEqual([
        MAX_DESKTOP_INVENTORY_DOCUMENTS_PER_REQUEST,
        count + 4 - MAX_DESKTOP_INVENTORY_DOCUMENTS_PER_REQUEST,
      ]);

      pipelines.mockResolvedValue({ documents: [], complete: true });
      notifyDesktopInventoryChanged(['pipelines']);
      await drainDebounce();
      const removalSizes = putRequests()
        .slice(2)
        .map((request) => request.removals?.length ?? 0);
      expect(removalSizes.reduce((sum, size) => sum + size, 0)).toBe(count);
      for (const size of removalSizes) {
        expect(size).toBeLessThanOrEqual(
          MAX_DESKTOP_INVENTORY_REMOVALS_PER_REQUEST,
        );
      }
    });

    function manyWorktrees(): void {
      const { pipelines } = create();
      pipelines.mockResolvedValue({
        documents: Array.from(
          { length: MAX_DESKTOP_INVENTORY_DOCUMENTS_PER_REQUEST + 4 },
          (_, index) => ({
            scopeKey: `ws:wt-${index}`,
            payload: { pipelines: [] },
          }),
        ),
        complete: true,
      });
    }

    function holdFirstPut(): () => void {
      let release: (() => void) | undefined;
      mockRequestCanopyCloudJson.mockImplementation((path, init) => {
        if (init?.method === 'PUT' && release === undefined) {
          return new Promise((resolve) => {
            release = (): void =>
              resolve(acceptAll(parseRequest(init.body ?? '')));
          });
        }
        return defaultCloud(path, init);
      });
      return (): void => release?.();
    }

    it('stops between batches when the flag turns off mid-flush', async () => {
      manyWorktrees();
      const release = holdFirstPut();
      startEnabled();
      await drainDebounce();
      expect(putRequests()).toHaveLength(1);
      service.setFeatureFlagEnabled(false);
      release();
      await drainDebounce();
      expect(putRequests()).toHaveLength(1);
    });

    it('stops between batches when the identity changes mid-flush', async () => {
      manyWorktrees();
      const release = holdFirstPut();
      startEnabled();
      await drainDebounce();
      expect(putRequests()).toHaveLength(1);
      accountListener?.();
      release();
      await Promise.resolve();
      await Promise.resolve();
      // The second batch of the old flush never goes out; the new identity
      // starts over with its own manifest read.
      expect(putRequests()).toHaveLength(1);
      await drainDebounce();
      expect(manifestCalls()).toBe(2);
    });

    it('splits by serialized size so no request exceeds the byte cap', async () => {
      const { pipelines } = create();
      // Six documents of ~700 KiB each would be ~4.2 MiB in one request.
      const bigDescription = 'x'.repeat(700 * 1024);
      pipelines.mockResolvedValue({
        documents: Array.from({ length: 6 }, (_, index) => ({
          scopeKey: `ws:wt-${index}`,
          payload: {
            pipelines: [
              {
                workspaceLocalId: 'ws',
                worktreeLocalId: `wt-${index}`,
                pipelineId: 'big',
                name: 'big',
                description: bigDescription,
              },
            ],
          },
        })),
        complete: true,
      });
      startEnabled();
      await drainDebounce();
      const requests = putRequests();
      expect(requests.length).toBeGreaterThan(1);
      for (const request of requests) {
        expect(Buffer.byteLength(JSON.stringify(request), 'utf8')).toBeLessThan(
          MAX_DESKTOP_INVENTORY_REQUEST_BYTES,
        );
      }
      expect(
        requests
          .flatMap((request) => request.documents)
          .filter((document) => document.kind === 'pipelines'),
      ).toHaveLength(6);
    });
  });

  it('stops every timer on dispose', async () => {
    create();
    startEnabled();
    service.dispose();
    await drainDebounce();
    expect(mockRequestCanopyCloudJson).not.toHaveBeenCalled();
  });
});
