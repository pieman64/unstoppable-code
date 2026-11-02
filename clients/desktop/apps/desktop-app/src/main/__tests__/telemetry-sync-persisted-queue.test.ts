/**
 * A telemetry queue persisted by an earlier session must drain after launch
 * with nothing but `start()`: no feature flag gates the sync service, so no
 * later call resumes it. Drives the real service with only its I/O boundaries
 * mocked.
 */
import type { AgentObservabilityUpdateEvent } from '@canopy/desktop-shared/types/observability';
import type {
  WorkspaceContext,
  WorkspaceConfigFile,
} from '@canopy/desktop-shared/types';
import type {
  TelemetryIngestRequest,
  TelemetryIngestResponse,
} from '@canopy/protocol';

type ObsListener = (event: AgentObservabilityUpdateEvent) => void;
const subscribeMock = jest.fn<() => void, [ObsListener]>();
const loadTranscriptMock = jest.fn();
const loadHistoryMock = jest.fn();
interface RecordedAppDiagnostic {
  kind: string;
  reason?: string;
  error?: string;
  telemetryUploadStatus?: number | null;
  telemetryShareScope?: string;
  telemetryConsecutiveServerRejections?: number;
  telemetryFirstRejectionAt?: string;
}
const recordAppDiagnosticMock = jest.fn<void, [RecordedAppDiagnostic]>();
const recordSessionDiagnosticMock = jest.fn();
jest.mock('../observability', () => ({
  getObservabilityService: (): unknown => ({
    get subscribe(): typeof subscribeMock {
      return subscribeMock;
    },
    get loadTranscript(): typeof loadTranscriptMock {
      return loadTranscriptMock;
    },
    get loadHistory(): typeof loadHistoryMock {
      return loadHistoryMock;
    },
    get recordAppDiagnostic(): typeof recordAppDiagnosticMock {
      return recordAppDiagnosticMock;
    },
    get recordSessionDiagnostic(): typeof recordSessionDiagnosticMock {
      return recordSessionDiagnosticMock;
    },
  }),
}));

const requestCanopyCloudJsonMock = jest.fn<
  TelemetryIngestResponse,
  [string, { body: string }]
>();
// Minimal stand-in matching the real `CanopyCloudClientError` shape the service
// branches on (`.status`, `.message`). Defined inline so the service's
// `instanceof` check resolves against the same class the test throws.
class MockCanopyCloudClientError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status?: number,
    // Mirrors the real client: the server's machine-readable body `code`,
    // separate from the transport-level `code` above.
    readonly serverCode?: string,
    // Mirrors the real client: the scope the server named in its refusal.
    readonly serverScope?: string,
  ) {
    super(status === undefined ? message : `HTTP ${status}: ${message}`);
    this.name = 'CanopyCloudClientError';
  }
}
jest.mock('../canopy-cloud/client', () => ({
  get requestCanopyCloudJson(): typeof requestCanopyCloudJsonMock {
    return requestCanopyCloudJsonMock;
  },
  get CanopyCloudClientError(): typeof MockCanopyCloudClientError {
    return MockCanopyCloudClientError;
  },
}));

const getCanopyCloudCredentialsMock = jest.fn();
jest.mock('../lib/canopy-cloud-account-store', () => ({
  get getCanopyCloudCredentials(): typeof getCanopyCloudCredentialsMock {
    return getCanopyCloudCredentialsMock;
  },
}));

const getWorkspaceContextStateMock = jest.fn<
  { context: WorkspaceContext } | undefined,
  []
>();
jest.mock('../lib/workspace-context-service', () => ({
  getWorkspaceContextService: (): unknown => ({
    getState: (): unknown => ({
      revision: 1,
      organizations: [],
      ...getWorkspaceContextStateMock(),
    }),
    accountEpoch: (): number => 1,
  }),
}));

// Per-org billing state (CAN-2311). Defaults to an empty list (nothing lapsed)
// in `beforeEach`, so the bulk of the suite keeps its pre-gate fan-out.
const loadStoredOrgBillingStatesMock = jest.fn<Promise<unknown[]>, []>();
jest.mock('../lib/org-billing-state', () => ({
  loadStoredOrgBillingStates: (): Promise<unknown[]> =>
    loadStoredOrgBillingStatesMock(),
}));

const readPreferencesFileMock = jest.fn();
type PreferencesUpdaterForTest = (
  existing: Record<string, unknown>,
) => Record<string, unknown>;
const updatePreferencesFileMock = jest.fn<
  Promise<Record<string, unknown>>,
  [PreferencesUpdaterForTest]
>();
const peekPreferencesLoadErrorMock = jest.fn<object | null, []>(() => null);
jest.mock('../lib/preferences-store', () => ({
  get readPreferencesFile(): typeof readPreferencesFileMock {
    return readPreferencesFileMock;
  },
  get updatePreferencesFile(): typeof updatePreferencesFileMock {
    return updatePreferencesFileMock;
  },
  peekPreferencesLoadError: (): object | null => peekPreferencesLoadErrorMock(),
}));

const sendToAllWindowsMock = jest.fn();
jest.mock('../lib/window-send', () => ({
  sendToAllWindows: (...args: unknown[]): unknown =>
    sendToAllWindowsMock(...args),
}));

// Org-enforced telemetry policy, read off the persisted encrypted account.
const loadStoredTelemetryEnforcementByOrganizationMock = jest.fn();
jest.mock('../lib/telemetry-enforcement-state', () => ({
  loadStoredTelemetryEnforcementByOrganization: (): unknown =>
    loadStoredTelemetryEnforcementByOrganizationMock(),
  emptyTelemetryEnforcementByOrganization: (): unknown => new Map(),
  recordTelemetryEnforcementReadFailure: jest.fn(),
}));

// The policy-403 branch kicks an enforced-settings re-probe through a dynamic
// import (cycle break); mocked so the real settings module never loads.
// Resolves to whether PER-ORG BILLING STATE was actually refreshed. The
// all-lapsed drop is gated on that, so `false` (offline, no key, unauthenticated,
// or a response omitting the field) must keep the data queued.
const reprobeEnforcedSettingsMock = jest.fn<Promise<boolean>, []>();
jest.mock('../ipc/settings', () => ({
  reprobeAndApplyCanopyCloudEnforcedSettings: (): Promise<boolean> =>
    reprobeEnforcedSettingsMock(),
}));

const readWorkspaceIndexEntryMock = jest.fn();
jest.mock('../lib/sidebar-items', () => ({
  get readWorkspaceIndexEntry(): typeof readWorkspaceIndexEntryMock {
    return readWorkspaceIndexEntryMock;
  },
}));

const readWorkspaceWorktreesMock = jest.fn();
const personalConfig: WorkspaceConfigFile = {
  version: 1,
  type: 'single-repo',
  repos: [],
};
const readWorkspaceConfigDetailedMock = jest.fn<
  Promise<{
    config: WorkspaceConfigFile;
    authority: 'ok' | 'absent' | 'unreadable';
    ownerMalformed: boolean;
  }>,
  [string]
>();
jest.mock('../lib/workspace-persistence', () => ({
  get readWorkspaceWorktrees(): typeof readWorkspaceWorktreesMock {
    return readWorkspaceWorktreesMock;
  },
  get readWorkspaceConfigDetailed(): typeof readWorkspaceConfigDetailedMock {
    return readWorkspaceConfigDetailedMock;
  },
}));

jest.mock('../lib/plan-persistence', () => ({
  addPlanContentChangeListener: jest.fn(),
  addPlanShareChangeListener: jest.fn(),
  removePlanContentChangeListener: jest.fn(),
  removePlanShareChangeListener: jest.fn(),
  listTrackedPlans: jest.fn(() => Promise.resolve([])),
}));

jest.mock('../lib/pr-status-change-emitter', () => ({
  addWorktreePrStatusChangeListener: jest.fn(),
  removeWorktreePrStatusChangeListener: jest.fn(),
}));

jest.mock('../lib/pipeline-run-completion-emitter', () => ({
  addPipelineRunCompletionListener: jest.fn(),
  removePipelineRunCompletionListener: jest.fn(),
}));

jest.mock('../lib/worktree-summary-persistence', () => ({
  addWorktreeSummaryChangeListener: jest.fn(),
  removeWorktreeSummaryChangeListener: jest.fn(),
}));

jest.mock('../lib/paths', () => ({
  getTelemetrySyncQueueFilePath: (): string => '/tmp/telemetry/queue.jsonl',
  getTelemetrySyncMapFilePath: (): string => '/tmp/telemetry/sync-map.json',
  getWorkspaceWorkEntriesFilePath: (workspaceId: string): string =>
    `/tmp/workspaces/${workspaceId}/work-entries.json`,
}));

// Cowork Work Entries live in work-entries.json, not worktrees.json. Mocked at
// the leaf module the sync service reads through.
const readWorkEntriesFileMock = jest.fn();
jest.mock('../lib/cowork-work-entries-file', () => ({
  readWorkEntriesFile: (...args: unknown[]): unknown =>
    readWorkEntriesFileMock(...args),
}));

// `environment.prefixes` is needed because the service now imports
// `TELEMETRY_SHARING_SCOPES` from `@canopy/desktop-shared/types` as a VALUE,
// which pulls the brand runtime in at require time (types → hooks → scripts →
// brandEnvCandidates). A stub without it fails the whole suite at import.
jest.mock('@canopy/brand/current', () => ({
  BRAND: {
    web: { apiNamespace: 'canopy' },
    environment: { prefixes: ['CANOPY'] },
    storage: {
      dataDirNames: {
        prod: ['.canopy'],
        rc: ['.canopy-rc'],
        dev: ['.canopy-dev'],
      },
      secureDataDirNames: {
        prod: '.canopy-secure',
        rc: '.canopy-rc-secure',
        internal: '.canopy-internal-secure',
        dev: '.canopy-secure-dev',
      },
    },
  },
}));

const writeFileMock = jest.fn();
const readFileMock = jest.fn();
const mkdirMock = jest.fn();
jest.mock('node:fs/promises', () => ({
  writeFile: (...args: unknown[]): unknown => writeFileMock(...args),
  readFile: (...args: unknown[]): unknown => readFileMock(...args),
  mkdir: (...args: unknown[]): unknown => mkdirMock(...args),
}));

import {
  TelemetrySyncService,
  TELEMETRY_SYNC_DEBOUNCE_MS,
} from '../services/telemetry-sync-service';

function buildIngestSuccessResponse(init: {
  body: string;
}): TelemetryIngestResponse {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- parsing a request body this test itself produced.
  const request: TelemetryIngestRequest = JSON.parse(init.body);
  const worktree = request.workspace.worktrees?.[0];
  return {
    workspace: {
      clientLocalId: request.workspace.clientLocalId,
      externalId: 'ws-ext',
      worktrees: [
        {
          clientLocalId: worktree?.clientLocalId ?? '',
          externalId: 'wt-ext',
          turns: (worktree?.turns ?? []).map((turn) => ({
            clientTurnId: turn.clientTurnId,
            externalId: `turn-ext-${turn.clientTurnId}`,
          })),
          plans: [],
          pullRequests: [],
          pipelineRuns: [],
          summaries: [],
        },
      ],
    },
  };
}

const QUEUE_PATH = '/tmp/telemetry/queue.jsonl';
const queuedWorktree = {
  version: 2,
  projectId: 'proj-1',
  worktreeId: 'wt-1',
  workspaceName: 'My workspace',
  workspaceType: 'single-repo',
  branchName: 'feature/telemetry',
  turns: [
    {
      clientTurnId: 'queued-turn',
      eventType: 'worktree_chat',
      status: 'success',
      provider: 'claude',
      label: 'Queued turn',
      startedAt: '2026-09-27T07:00:00.000Z',
      body: 'queued body',
      contentHash: 'queued-hash',
    },
  ],
  plans: [],
  pullRequests: [],
};

describe('telemetry queue persisted across launches', () => {
  beforeEach(() => {
    peekPreferencesLoadErrorMock.mockReturnValue(null);
    jest.clearAllMocks();
    jest.useFakeTimers();
    const enoent = Object.assign(new Error('not found'), { code: 'ENOENT' });
    readFileMock.mockImplementation((filePath: string) =>
      filePath === QUEUE_PATH
        ? Promise.resolve(`${JSON.stringify(queuedWorktree)}\n`)
        : Promise.reject(enoent),
    );
    writeFileMock.mockResolvedValue(undefined);
    mkdirMock.mockResolvedValue(undefined);
    subscribeMock.mockReturnValue(() => undefined);
    readPreferencesFileMock.mockResolvedValue({
      telemetrySharing: {
        transcripts: 'private',
        plans: 'private',
        metadata: 'private',
        summaries: 'private',
      },
    });
    getWorkspaceContextStateMock.mockReturnValue({
      context: { kind: 'organization', organizationId: 'org-1' },
    });
    readWorkspaceConfigDetailedMock.mockResolvedValue({
      config: personalConfig,
      authority: 'ok',
      ownerMalformed: false,
    });
    readWorkspaceIndexEntryMock.mockResolvedValue({
      id: 'proj-1',
      name: 'My workspace',
      type: 'single-repo',
    });
    readWorkspaceWorktreesMock.mockResolvedValue([
      {
        id: 'wt-1',
        branchName: 'feature/telemetry',
        status: 'active',
        createdAt: '2026-09-27T00:00:00.000Z',
      },
    ]);
    readWorkEntriesFileMock.mockResolvedValue({ version: 1, entries: [] });
    getCanopyCloudCredentialsMock.mockResolvedValue({
      baseUrl: 'https://cloud.example',
      apiKey: 'key',
      capabilities: [],
      teams: [{ id: 'team-1', organization: { id: 'org-1' } }],
      organizations: [{ id: 'org-1' }],
    });
    loadStoredOrgBillingStatesMock.mockResolvedValue([]);
    loadStoredTelemetryEnforcementByOrganizationMock.mockResolvedValue(
      new Map(),
    );
    reprobeEnforcedSettingsMock.mockResolvedValue(true);
    requestCanopyCloudJsonMock.mockImplementation(
      (_path: string, init: { body: string }) =>
        buildIngestSuccessResponse(init),
    );
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('keeps legacy queued activity private after consent survives a restart', async () => {
    const org = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    readWorkspaceConfigDetailedMock.mockResolvedValue({
      config: {
        ...personalConfig,
        owner: {
          type: 'organization',
          organizationId: org,
          projectId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
          instanceId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
          bindingGeneration: 1,
        },
      },
      authority: 'ok',
      ownerMalformed: false,
    });
    getCanopyCloudCredentialsMock.mockResolvedValue({
      baseUrl: 'https://cloud.example',
      apiKey: 'key',
      organizations: [{ id: org }],
      teams: [],
      capabilities: [],
    });
    readPreferencesFileMock.mockResolvedValue({
      telemetrySharing: {
        metadata: 'organization',
        plans: 'organization',
        summaries: 'organization',
        transcripts: 'organization',
      },
      dataSharingOptInHistory: [
        {
          enabledAt: '2026-10-01T00:00:00.000Z',
          sharing: {
            metadata: 'private',
            plans: 'private',
            summaries: 'private',
            transcripts: 'private',
          },
        },
      ],
    });
    const service = new TelemetrySyncService();
    await service.start();
    await jest.advanceTimersByTimeAsync(TELEMETRY_SYNC_DEBOUNCE_MS);
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- parse this test's captured ingest request.
    const request: TelemetryIngestRequest = JSON.parse(
      requestCanopyCloudJsonMock.mock.calls[0]?.[1].body ?? '{}',
    );
    expect(request.shareScope).toBe('private');
    expect(request.workspace.worktrees?.[0]?.turns?.[0]?.clientTurnId).toBe(
      'queued-turn',
    );
    await service.dispose();
  });

  it.each([
    ['a signed-in free account', true],
    ['a cold-start account with no credentials', false],
  ])(
    'drops a persisted queue whose scopes are stored Off for %s',
    async (_label, signedIn) => {
      // Items captured while an older build floored Off to Just me must never
      // upload once the stored Off is honored.
      readPreferencesFileMock.mockResolvedValue({
        telemetrySharing: {
          transcripts: 'off',
          plans: 'off',
          metadata: 'off',
          summaries: 'off',
        },
      });
      if (!signedIn) getCanopyCloudCredentialsMock.mockResolvedValue(null);
      const telemetry = new TelemetrySyncService();

      await telemetry.start();
      await jest.advanceTimersByTimeAsync(TELEMETRY_SYNC_DEBOUNCE_MS * 4);

      expect(telemetry.getStatus()).toMatchObject({
        sharingActive: false,
        pendingCount: 0,
      });
      expect(writeFileMock).toHaveBeenCalledWith(QUEUE_PATH, '', 'utf8');
      expect(requestCanopyCloudJsonMock).not.toHaveBeenCalled();

      // Choosing Just me later must not resurrect the dropped items.
      readPreferencesFileMock.mockResolvedValue({
        telemetrySharing: {
          transcripts: 'private',
          plans: 'private',
          metadata: 'private',
          summaries: 'private',
        },
      });
      await telemetry.refreshScopeFromPreferences();
      await jest.advanceTimersByTimeAsync(TELEMETRY_SYNC_DEBOUNCE_MS * 4);
      expect(requestCanopyCloudJsonMock).not.toHaveBeenCalled();

      await telemetry.dispose();
    },
  );

  it.each([
    ['a preferences file that could not be read', 'load-error'],
    ['a preferences read that threw', 'throw'],
  ])(
    'keeps a persisted queue when Off comes from %s',
    async (_label, failure) => {
      // Defaults standing in for unreadable preferences are not the user's
      // choice, so they cannot authorize deleting queued work.
      if (failure === 'throw') {
        readPreferencesFileMock.mockRejectedValue(new Error('EACCES'));
      } else {
        readPreferencesFileMock.mockResolvedValue({
          telemetrySharing: {
            transcripts: 'off',
            plans: 'off',
            metadata: 'off',
            summaries: 'off',
          },
        });
        peekPreferencesLoadErrorMock.mockReturnValue({ reason: 'corrupt' });
      }
      const telemetry = new TelemetrySyncService();

      await telemetry.start();

      expect(telemetry.getStatus()).toMatchObject({
        sharingActive: false,
        pendingCount: 1,
      });
      expect(writeFileMock).not.toHaveBeenCalledWith(QUEUE_PATH, '', 'utf8');

      await telemetry.dispose();
    },
  );

  it.each([
    ['organization policy could not be read', 'enforcement-unreadable'],
    ['an organization requires a scope', 'org-required'],
  ])(
    'keeps a persisted queue stored Off when %s',
    async (_label, condition) => {
      readPreferencesFileMock.mockResolvedValue({
        telemetrySharing: {
          transcripts: 'off',
          plans: 'off',
          metadata: 'off',
          summaries: 'off',
        },
      });
      const none = {
        transcripts: false,
        plans: false,
        metadata: false,
        summaries: false,
      };
      if (condition === 'enforcement-unreadable') {
        // Unknown policy may still require a scope that routes this queue.
        loadStoredTelemetryEnforcementByOrganizationMock.mockRejectedValue(
          new Error('unreadable'),
        );
      } else {
        // A required scope means sharing is not declined: resume, not drop.
        loadStoredTelemetryEnforcementByOrganizationMock.mockResolvedValue(
          new Map([
            [
              'org-1',
              {
                organizationName: 'Acme',
                enforcement: {
                  required: { ...none, metadata: true },
                  prohibited: { ...none },
                },
              },
            ],
          ]),
        );
      }
      const telemetry = new TelemetrySyncService();

      await telemetry.start();

      expect(telemetry.getStatus().pendingCount).toBe(1);
      expect(writeFileMock).not.toHaveBeenCalledWith(QUEUE_PATH, '', 'utf8');

      await telemetry.dispose();
    },
  );

  it('finishes starting when the dropped queue cannot be written', async () => {
    readPreferencesFileMock.mockResolvedValue({
      telemetrySharing: {
        transcripts: 'off',
        plans: 'off',
        metadata: 'off',
        summaries: 'off',
      },
    });
    writeFileMock.mockImplementation((filePath: string, data: string) =>
      filePath === QUEUE_PATH && data === ''
        ? Promise.reject(new Error('ENOSPC'))
        : Promise.resolve(undefined),
    );
    const telemetry = new TelemetrySyncService();

    // The on-disk queue is retried next launch; startup must not abort.
    await expect(telemetry.start()).resolves.toBeUndefined();
    expect(telemetry.getStatus()).toMatchObject({
      sharingActive: false,
      pendingCount: 0,
    });

    await telemetry.dispose();
  });

  it('flushes a queue loaded from disk after start', async () => {
    const telemetry = new TelemetrySyncService();

    await telemetry.start();

    expect(telemetry.getStatus()).toMatchObject({
      sharingActive: true,
      pendingCount: 1,
    });
    expect(requestCanopyCloudJsonMock).not.toHaveBeenCalled();

    await jest.advanceTimersByTimeAsync(TELEMETRY_SYNC_DEBOUNCE_MS);

    expect(requestCanopyCloudJsonMock).toHaveBeenCalledTimes(1);
    const init = requestCanopyCloudJsonMock.mock.calls[0]?.[1];
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- parsing a request body this test itself produced.
    const request: TelemetryIngestRequest = JSON.parse(init?.body ?? '{}');
    expect(request.workspace.worktrees?.[0]?.turns?.[0]?.clientTurnId).toBe(
      'queued-turn',
    );
    expect(telemetry.getStatus().pendingCount).toBe(0);

    await telemetry.dispose();
  });
});
