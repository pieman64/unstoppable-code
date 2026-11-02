import {
  listPullRequestsByViewer,
  listReconcilableRepos,
} from '../lib/github-pr-reconcile';
import {
  reconcilePullRequests,
  type PullRequestRecord,
  type ReconcilableRepo,
} from '../services/pr-telemetry-reconciler';
import type {
  AgentAuditEntry,
  AgentAuditToolCounts,
  AgentObservabilityUpdateEvent,
} from '@canopy/desktop-shared/types/observability';
import type {
  TrackedPlanData,
  WorkspaceContext,
  TelemetrySyncStatus,
  WorktreeSummaryData,
  WorkspaceConfigFile,
} from '@canopy/desktop-shared/types';
import {
  MAX_TELEMETRY_INGEST_BATCH_BYTES,
  MAX_TELEMETRY_PULL_REQUESTS_PER_WORKTREE,
} from '@canopy/protocol';
import type { OrgTelemetryEnforcement } from '@canopy/desktop-shared/lib/telemetry-enforcement';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { CloudSyncStatus } from '@/components/settings/CloudSyncStatus';
import { TelemetrySyncPauseMonitor } from '../services/telemetry-sync-pause';
import { TELEMETRY_OWNER_SCOPE_CONFLICT_CODE } from '@canopy/protocol/telemetry';
import type {
  TelemetryIngestRequest,
  TelemetryIngestResponse,
  TelemetryPlanPayload,
  TelemetryTurnPayload,
  TelemetryWorktreePayload,
} from '@canopy/protocol';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

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
const getDesktopOAuthClientDeviceIdMock = jest.fn();
jest.mock('../lib/code-review-registry', () => ({
  getCodeReviewTarget: (scopeKey: string): Promise<unknown> =>
    Promise.resolve(
      scopeKey === 'review-scope'
        ? { projectId: 'proj-1', worktreeId: 'wt-1' }
        : null,
    ),
}));
jest.mock('../canopy-cloud/oauth-login', () => ({
  getDesktopOAuthClientDeviceId: (): unknown =>
    getDesktopOAuthClientDeviceIdMock(),
}));
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
  Promise<TelemetryIngestResponse>,
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
jest.mock('../lib/preferences-store', () => ({
  get readPreferencesFile(): typeof readPreferencesFileMock {
    return readPreferencesFileMock;
  },
  get updatePreferencesFile(): typeof updatePreferencesFileMock {
    return updatePreferencesFileMock;
  },
  peekPreferencesLoadError: (): null => null,
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
const resolveLocalMemoryPolicyMock = jest.fn();
jest.mock('../memory/local/policy', () => ({
  resolveLocalMemoryPolicy: (options: unknown): unknown =>
    resolveLocalMemoryPolicyMock(options),
}));
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

jest.mock('../lib/github-pr-reconcile', () => ({
  listReconcilableRepos: jest.fn(() => Promise.resolve([])),
  listPullRequestsByViewer: jest.fn(() => Promise.resolve([])),
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
    tools: { namespace: 'canopy' },
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

import { createHash } from 'node:crypto';
import {
  RUN_SHARE_ID_SUFFIX,
  TELEMETRY_PERMANENT_WRITE_ERROR_CODE,
} from '@canopy/protocol/telemetry';
import {
  TelemetrySyncService,
  MAX_TELEMETRY_CONSECUTIVE_SERVER_REJECTIONS,
  TELEMETRY_SYNC_DEBOUNCE_MS,
  TELEMETRY_SYNC_RETRY_DELAYS_MS,
} from '../services/telemetry-sync-service';
import {
  addPlanContentChangeListener,
  listTrackedPlans,
  removePlanContentChangeListener,
  removePlanShareChangeListener,
} from '../lib/plan-persistence';
import {
  addWorktreePrStatusChangeListener,
  removeWorktreePrStatusChangeListener,
} from '../lib/pr-status-change-emitter';
import type { TelemetryPullRequestPayload } from '@canopy/protocol/telemetry';
import type { WorktreePrStatus } from '@canopy/desktop-shared/types';
import {
  addWorktreeSummaryChangeListener,
  removeWorktreeSummaryChangeListener,
} from '../lib/worktree-summary-persistence';
import {
  spaceNotificationProducerId,
  spaceNotificationSourceRef,
} from '../lib/space-notification-ref';
// Load after mock initialization, outside the individual test's timeout.
import * as workspaceTarget from '../services/workspace-target';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function zeroToolCounts(): AgentAuditToolCounts {
  return {
    thinking: 0,
    bash: 0,
    read: 0,
    readLines: 0,
    writeEdit: 0,
    plan: 0,
    fileEdit: 0,
    fileAdd: 0,
    fileDelete: 0,
    search: 0,
    grep: 0,
    web: 0,
    agent: 0,
    graph: 0,
    workflow: 0,
    tasks: 0,
    taskStop: 0,
    skills: 0,
    monitor: 0,
    claude: 0,
    scheduleWakeup: 0,
    askUser: 0,
    scriptOutput: 0,
    watcher: 0,
    canopy: 0,
    appAdvisor: 0,
    pipelineEditor: 0,
    mcp: 0,
    other: 0,
  };
}

/**
 * Build a uniform `telemetrySharing` preference where all four data types use
 * the same visibility. The common opt-in path (and the "all team"/"all org"
 * bulk control) sets every type to one scope, which collapses to a single
 * ingest request — the behavior these tests assert.
 */
function uniformSharing(
  visibility: 'off' | 'private' | 'team' | 'organization',
): {
  telemetrySharing: Record<
    'transcripts' | 'plans' | 'metadata' | 'summaries',
    string
  >;
} {
  return {
    telemetrySharing: {
      transcripts: visibility,
      plans: visibility,
      metadata: visibility,
      summaries: visibility,
    },
  };
}

const NO_SCOPES = {
  transcripts: false,
  plans: false,
  metadata: false,
  summaries: false,
};
const ORG_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ORG_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

/** Org enforcement fixture: nothing required, nothing prohibited. */
function noEnforcement(): ReadonlyMap<string, OrgTelemetryEnforcement> {
  return new Map();
}

/** Org enforcement fixture: one org prohibiting `scope`. */
function prohibiting(
  scope: 'transcripts' | 'plans' | 'metadata' | 'summaries',
  organizationName = 'Acme',
  organizationId = ORG_A,
): ReadonlyMap<string, OrgTelemetryEnforcement> {
  return new Map([
    [
      organizationId,
      {
        organizationName,
        enforcement: {
          required: { ...NO_SCOPES },
          prohibited: { ...NO_SCOPES, [scope]: true },
        },
      },
    ],
  ]);
}

function requiring(
  scopes: Partial<typeof NO_SCOPES>,
  organizationId = ORG_A,
  organizationName = 'Acme',
): ReadonlyMap<string, OrgTelemetryEnforcement> {
  return new Map([
    [
      organizationId,
      {
        organizationName,
        enforcement: {
          required: { ...NO_SCOPES, ...scopes },
          prohibited: { ...NO_SCOPES },
        },
      },
    ],
  ]);
}

function governWorkspaceBy(organizationId: string): void {
  readWorkspaceConfigDetailedMock.mockResolvedValue({
    config: {
      ...personalConfig,
      owner: {
        type: 'organization',
        organizationId,
        projectId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        instanceId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
        bindingGeneration: 1,
      },
    },
    authority: 'ok',
    ownerMalformed: false,
  });
  getWorkspaceContextStateMock.mockReturnValue({
    context: { kind: 'organization', organizationId },
  });
  getCanopyCloudCredentialsMock.mockResolvedValue({
    baseUrl: 'https://cloud.example',
    apiKey: 'key',
    capabilities: [],
    teams: [{ id: 'team-a', organization: { id: organizationId } }],
    organizations: [{ id: organizationId }],
  });
}

/**
 * Set the default workspace's saved owner without touching the selected
 * context or credentials. Since CAN-3515 the owner alone decides where
 * activity counts, so tests of organization delivery own the work by an org.
 */
function ownWorkspaceBy(organizationId: string | null): void {
  readWorkspaceConfigDetailedMock.mockResolvedValue({
    config:
      organizationId === null
        ? personalConfig
        : {
            ...personalConfig,
            owner: {
              type: 'organization',
              organizationId,
              projectId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
              instanceId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
              bindingGeneration: 1,
            },
          },
    authority: 'ok',
    ownerMalformed: false,
  });
}

function makeEntry(overrides: Partial<AgentAuditEntry> = {}): AgentAuditEntry {
  return {
    id: 'turn-1',
    eventType: 'worktree_chat',
    status: 'success',
    provider: 'claude',
    label: 'Worktree chat',
    startedAt: '2026-06-16T00:00:00.000Z',
    completedAt: '2026-06-16T00:00:05.000Z',
    durationMs: 5000,
    model: 'claude-sonnet-4-6',
    totalCostUsd: 0.1,
    tokens: {
      input: 10,
      output: 5,
      cacheReadInputTokens: 1,
      cacheCreationInputTokens: 0,
    },
    messageCount: 2,
    assistantMessageCount: 1,
    toolUseCount: 1,
    subAgentCount: 0,
    toolCounts: zeroToolCounts(),
    hasTranscript: true,
    projectId: 'proj-1',
    worktreeId: 'wt-1',
    ...overrides,
  };
}

function getCapturedListener(): ObsListener {
  const calls = subscribeMock.mock.calls;
  return calls[calls.length - 1][0];
}

interface PersistedQueueLineShape {
  version: number;
  projectId: string;
  worktreeId: string;
  consecutiveServerRejections?: number;
  firstRejectionAt?: string;
}

/** Parse the most recent durable queue-file write this test produced. */
function lastQueueWrite(): PersistedQueueLineShape | null {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- jest mock call records this test produced.
  const calls: unknown[][] = writeFileMock.mock.calls;
  const queueWrites = calls.filter(
    (call) => call[0] === '/tmp/telemetry/queue.jsonl',
  );
  for (let index = queueWrites.length - 1; index >= 0; index -= 1) {
    const body = String(queueWrites[index][1]).trim();
    if (body.length === 0) {
      continue;
    }
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- parsing the queue line this service itself wrote.
    const parsed: PersistedQueueLineShape = JSON.parse(body.split('\n')[0]);
    return parsed;
  }
  return null;
}

function lastRequest(): TelemetryIngestRequest {
  const calls = requestCanopyCloudJsonMock.mock.calls;
  const init = calls[calls.length - 1][1];
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- parsing a request body this test itself produced.
  const parsed: TelemetryIngestRequest = JSON.parse(init.body);
  return parsed;
}

/**
 * Build the ingest response the server would return for a given request,
 * echoing client ids back as deterministic external ids. Shared by the default
 * mock and tests that need to interleave a failure between fan-out targets.
 */
function buildIngestSuccessResponse(init: {
  body: string;
}): TelemetryIngestResponse {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- parsing a request body this test itself produced.
  const request: TelemetryIngestRequest = JSON.parse(init.body);
  const wt = request.workspace.worktrees?.[0];
  return {
    workspace: {
      clientLocalId: request.workspace.clientLocalId,
      externalId: 'ws-ext',
      worktrees: [
        {
          clientLocalId: wt?.clientLocalId ?? '',
          externalId: 'wt-ext',
          turns: (wt?.turns ?? []).map((t) => ({
            clientTurnId: t.clientTurnId,
            externalId: `turn-ext-${t.clientTurnId}`,
          })),
          plans: (wt?.plans ?? []).map((p) => ({
            clientPlanId: p.clientPlanId,
            externalId: `plan-ext-${p.clientPlanId}`,
          })),
          pullRequests: (wt?.pullRequests ?? []).map((pr) => ({
            repoId: pr.repoId,
            prNumber: pr.prNumber,
            externalId: `pr-ext-${pr.repoId}`,
          })),
          pipelineRuns: (wt?.pipelineRuns ?? []).map((run) => ({
            clientPipelineRunId: run.clientPipelineRunId,
            externalId: `pipeline-run-ext-${run.clientPipelineRunId}`,
          })),
          summaries: (wt?.summaries ?? []).map((snapshot) => ({
            clientSnapshotId: snapshot.clientSnapshotId,
            externalId: `summary-ext-${snapshot.clientSnapshotId}`,
          })),
        },
      ],
    },
  };
}

async function tick(): Promise<void> {
  await jest.advanceTimersByTimeAsync(0);
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.useFakeTimers();
  getWorkspaceContextStateMock.mockReturnValue({
    context: { kind: 'organization', organizationId: 'org-1' },
  });
  readWorkspaceConfigDetailedMock.mockResolvedValue({
    config: personalConfig,
    authority: 'ok',
    ownerMalformed: false,
  });
  resolveLocalMemoryPolicyMock.mockResolvedValue({
    kind: 'scoped',
    workspaceId: 'proj-1',
    privateMemory: false,
  });

  subscribeMock.mockReturnValue(() => undefined);
  loadTranscriptMock.mockResolvedValue({
    type: 'success',
    lines: ['hello transcript'],
    truncation: {},
    injectedPrompts: [],
  });
  readPreferencesFileMock.mockResolvedValue(uniformSharing('private'));
  updatePreferencesFileMock.mockImplementation(
    async (updater: PreferencesUpdaterForTest) => {
      const existing: unknown = await readPreferencesFileMock();
      const existingPreferences = existing as Record<string, unknown>;
      return { ...existingPreferences, ...updater(existingPreferences) };
    },
  );
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
      createdAt: '2026-06-15T00:00:00.000Z',
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
  requestCanopyCloudJsonMock.mockImplementation(
    (_path: string, init: { body: string }) =>
      Promise.resolve(buildIngestSuccessResponse(init)),
  );
  loadStoredTelemetryEnforcementByOrganizationMock.mockResolvedValue(
    noEnforcement(),
  );
  // Default: the probe succeeds and refreshes per-org billing state.
  reprobeEnforcedSettingsMock.mockResolvedValue(true);
  writeFileMock.mockResolvedValue(undefined);
  mkdirMock.mockResolvedValue(undefined);
  const enoent = Object.assign(new Error('not found'), { code: 'ENOENT' });
  readFileMock.mockRejectedValue(enoent);
});

afterEach(() => {
  jest.useRealTimers();
});

async function startService(): Promise<TelemetrySyncService> {
  const service = new TelemetrySyncService();
  await service.start();
  return service;
}

function emitTurn(entry: AgentAuditEntry = makeEntry()): void {
  getCapturedListener()({ type: 'entries', entries: [entry] });
}

// Emit `count` distinct turns in a single `entries` event, mirroring how a long
// agent session accumulates many turns for one worktree before a flush.
function emitTurns(count: number, idPrefix = 'turn'): void {
  const entries = Array.from({ length: count }, (_unused, index) =>
    makeEntry({ id: `${idPrefix}-${index + 1}` }),
  );
  getCapturedListener()({ type: 'entries', entries });
}

// Each queued turn is handled by an independently-awaited `void handleTurn()`
// chain, so flush the microtask queue a few times before advancing the debounce
// timer to guarantee every turn has landed in the pending entry.
async function drainQueuedTurns(): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    await tick();
  }
}

// Parse every ingest request body this test produced, oldest call first.
function allRequests(): TelemetryIngestRequest[] {
  return requestCanopyCloudJsonMock.mock.calls.map((call) => {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- parsing a request body this test itself produced.
    const parsed: TelemetryIngestRequest = JSON.parse(call[1].body);
    return parsed;
  });
}

// The per-request turn payloads for the ingest call at `index` (oldest first).
function turnsForCall(index: number): TelemetryTurnPayload[] {
  return allRequests()[index]?.workspace.worktrees?.[0]?.turns ?? [];
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('TelemetrySyncService has no subscription floor', () => {
  it('keeps a free account at Off and uploads nothing', async () => {
    // A free or guest account holds no `data_sync_control`; that no longer
    // matters, so its stored Off stands.
    getCanopyCloudCredentialsMock.mockResolvedValue({
      baseUrl: 'https://cloud.example',
      apiKey: 'guest-key',
      capabilities: [],
      teams: [],
      organizations: [],
    });
    readPreferencesFileMock.mockResolvedValue(uniformSharing('off'));
    const service = await startService();

    emitTurn();
    await tick();
    await jest.advanceTimersByTimeAsync(TELEMETRY_SYNC_DEBOUNCE_MS);

    expect(service.getStatus()).toMatchObject({ sharingActive: false });
    expect(requestCanopyCloudJsonMock).not.toHaveBeenCalled();
    expect(writeFileMock).not.toHaveBeenCalled();
    await service.dispose();
  });

  it('never rewrites stored sharing or announces a plan change', async () => {
    readPreferencesFileMock.mockResolvedValue({
      ...uniformSharing('off'),
      // A legacy marker from an older build is read and ignored.
      telemetrySharingTier: 'paid',
    });
    const service = await startService();

    // A plan change (paid -> free or back) only re-reads preferences now.
    await service.refreshScopeFromPreferences();
    await service.refreshScopeFromPreferences();

    expect(updatePreferencesFileMock).not.toHaveBeenCalled();
    expect(sendToAllWindowsMock).not.toHaveBeenCalledWith(
      'telemetry-sharing:notice',
      expect.anything(),
    );
    expect(sendToAllWindowsMock).not.toHaveBeenCalledWith(
      'preferences:changed',
    );
    emitTurn();
    await tick();
    await jest.advanceTimersByTimeAsync(TELEMETRY_SYNC_DEBOUNCE_MS);
    expect(requestCanopyCloudJsonMock).not.toHaveBeenCalled();
    await service.dispose();
  });

  it('uploads only the Just me scopes a user picked alongside Off', async () => {
    readPreferencesFileMock.mockResolvedValue({
      telemetrySharing: {
        transcripts: 'off',
        plans: 'off',
        metadata: 'private',
        summaries: 'off',
      },
    });
    const service = await startService();

    emitTurn();
    await tick();
    await jest.advanceTimersByTimeAsync(TELEMETRY_SYNC_DEBOUNCE_MS);

    expect(requestCanopyCloudJsonMock).toHaveBeenCalledTimes(1);
    expect(lastRequest().shareScope).toBe('private');
    expect(turnsForCall(0)[0]).not.toHaveProperty('transcript');
    await service.dispose();
  });

  it('still uploads metadata an organization requires over a stored Off', async () => {
    governWorkspaceBy(ORG_A);
    readPreferencesFileMock.mockResolvedValue(uniformSharing('off'));
    loadStoredTelemetryEnforcementByOrganizationMock.mockResolvedValue(
      requiring({ metadata: true }),
    );
    const service = await startService();

    emitTurn();
    await tick();
    await service.flushAll();

    expect(lastRequest()).toMatchObject({
      shareScope: 'organization',
      organizationId: ORG_A,
    });
    await service.dispose();
  });
});

describe('TelemetrySyncService gate', () => {
  it('uploads nothing when scope is off (hard short-circuit)', async () => {
    readPreferencesFileMock.mockResolvedValue(uniformSharing('off'));
    await startService();

    emitTurn();
    await tick();
    await jest.advanceTimersByTimeAsync(TELEMETRY_SYNC_DEBOUNCE_MS);

    expect(requestCanopyCloudJsonMock).not.toHaveBeenCalled();
    expect(writeFileMock).not.toHaveBeenCalled();
  });

  it('drops persisted pending items loaded while every scope is off', async () => {
    const queuedTurn = {
      clientTurnId: 'queued-turn',
      eventType: 'worktree_chat',
      status: 'success',
      provider: 'claude',
      label: 'Queued turn',
      startedAt: '2026-06-16T00:00:00.000Z',
      body: 'queued body',
      contentHash: 'queued-hash',
    };
    const queuedWorktree = {
      version: 2,
      projectId: 'proj-1',
      worktreeId: 'wt-1',
      workspaceName: 'My workspace',
      workspaceType: 'single-repo',
      branchName: 'feature/telemetry',
      turns: [queuedTurn],
      plans: [],
      pullRequests: [],
    };
    const enoent = Object.assign(new Error('not found'), { code: 'ENOENT' });
    readFileMock.mockImplementation((filePath: string) => {
      if (filePath === '/tmp/telemetry/queue.jsonl') {
        return Promise.resolve(`${JSON.stringify(queuedWorktree)}\n`);
      }
      return Promise.reject(enoent);
    });
    readPreferencesFileMock.mockResolvedValueOnce({
      ...uniformSharing('off'),
    });
    const service = await startService();

    await jest.advanceTimersByTimeAsync(TELEMETRY_SYNC_DEBOUNCE_MS);
    expect(requestCanopyCloudJsonMock).not.toHaveBeenCalled();

    readPreferencesFileMock.mockResolvedValueOnce({
      ...uniformSharing('private'),
    });
    await service.refreshScopeFromPreferences();
    expect(requestCanopyCloudJsonMock).not.toHaveBeenCalled();

    // A queue resumed while sharing is declined is terminal (an older build
    // may have captured it under the retired subscription floor), so turning
    // sharing on later uploads nothing from it.
    await jest.advanceTimersByTimeAsync(TELEMETRY_SYNC_DEBOUNCE_MS);

    expect(requestCanopyCloudJsonMock).not.toHaveBeenCalled();
    expect(service.getStatus().pendingCount).toBe(0);
  });

  it('drops queued plans when plans are disabled at delivery time', async () => {
    const queuedWorktree = {
      version: 2,
      projectId: 'proj-1',
      worktreeId: 'wt-1',
      workspaceName: 'My workspace',
      workspaceType: 'single-repo',
      branchName: 'feature/telemetry',
      turns: [],
      plans: [{ clientPlanId: 'queued-plan', title: 'Queued plan' }],
      pullRequests: [],
    };
    const enoent = Object.assign(new Error('not found'), { code: 'ENOENT' });
    readFileMock.mockImplementation((filePath: string) => {
      if (filePath === '/tmp/telemetry/queue.jsonl') {
        return Promise.resolve(`${JSON.stringify(queuedWorktree)}\n`);
      }
      return Promise.reject(enoent);
    });
    const plansOff = {
      telemetrySharing: {
        ...uniformSharing('private').telemetrySharing,
        plans: 'off',
      },
    };
    readPreferencesFileMock.mockResolvedValue(plansOff);
    const service = await startService();
    await jest.advanceTimersByTimeAsync(TELEMETRY_SYNC_DEBOUNCE_MS);

    expect(requestCanopyCloudJsonMock).not.toHaveBeenCalled();
    expect(service.getStatus().pendingCount).toBe(0);
    expect(jest.getTimerCount()).toBe(0);

    readPreferencesFileMock.mockResolvedValue(uniformSharing('private'));
    await service.refreshScopeFromPreferences();
    expect(jest.getTimerCount()).toBe(0);
    expect(requestCanopyCloudJsonMock).not.toHaveBeenCalled();
    expect(service.getStatus().pendingCount).toBe(0);
    expect(jest.getTimerCount()).toBe(0);
    await service.dispose();
  });

  it('skips corrupt persisted queue lines without a worktree id', async () => {
    const corruptQueuedWorktree = {
      version: 2,
      projectId: 'proj-1',
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
          startedAt: '2026-06-16T00:00:00.000Z',
        },
      ],
      plans: [],
      pullRequests: [],
    };
    const enoent = Object.assign(new Error('not found'), { code: 'ENOENT' });
    readFileMock.mockImplementation((filePath: string) => {
      if (filePath === '/tmp/telemetry/queue.jsonl') {
        return Promise.resolve(`${JSON.stringify(corruptQueuedWorktree)}\n`);
      }
      return Promise.reject(enoent);
    });

    await startService();
    await jest.advanceTimersByTimeAsync(TELEMETRY_SYNC_DEBOUNCE_MS);

    expect(requestCanopyCloudJsonMock).not.toHaveBeenCalled();
  });
});

describe('TelemetrySyncService debounce + upload', () => {
  it('uploads private and shared source turns in separate memory envelopes', async () => {
    await startService();
    resolveLocalMemoryPolicyMock.mockResolvedValueOnce({
      kind: 'scoped',
      workspaceId: 'proj-1',
      privateMemory: true,
    });
    emitTurn(makeEntry({ id: 'private-turn' }));
    await drainQueuedTurns();
    emitTurn(makeEntry({ id: 'shared-turn' }));
    await drainQueuedTurns();
    await jest.advanceTimersByTimeAsync(TELEMETRY_SYNC_DEBOUNCE_MS);
    await tick();

    const envelopes = allRequests()
      .filter((request) => request.workspace.worktrees?.[0]?.turns?.length)
      .map((request) => ({
        memoryExcluded: request.workspace.memoryExcluded,
        ids: request.workspace.worktrees?.[0]?.turns?.map(
          (turn) => turn.clientTurnId,
        ),
      }));
    expect(envelopes).toEqual([
      { memoryExcluded: undefined, ids: ['shared-turn'] },
      { memoryExcluded: true, ids: ['private-turn'] },
    ]);
  });

  it('keeps the source privacy flag through a toggle-off and retry while uploading telemetry', async () => {
    requestCanopyCloudJsonMock
      .mockImplementationOnce(() => {
        throw new MockCanopyCloudClientError('http-error', 'server error', 500);
      })
      .mockImplementation((_path: string, init: { body: string }) =>
        Promise.resolve(buildIngestSuccessResponse(init)),
      );
    const service = await startService();
    resolveLocalMemoryPolicyMock.mockResolvedValueOnce({
      kind: 'scoped',
      workspaceId: 'proj-1',
      privateMemory: true,
    });
    emitTurn(makeEntry({ id: 'private-turn' }));
    await drainQueuedTurns();
    expect(resolveLocalMemoryPolicyMock).toHaveBeenCalledTimes(1);
    await expect(
      resolveLocalMemoryPolicyMock.mock.results[0]?.value,
    ).resolves.toMatchObject({
      privateMemory: true,
    });
    expect(service.getStatus().pendingCount).toBe(1);
    resolveLocalMemoryPolicyMock.mockResolvedValue({
      kind: 'scoped',
      workspaceId: 'proj-1',
      privateMemory: false,
    });

    await jest.advanceTimersByTimeAsync(TELEMETRY_SYNC_DEBOUNCE_MS);
    await tick();
    expect(
      allRequests()
        .filter((request) =>
          request.workspace.worktrees?.some((worktree) =>
            worktree.turns?.some(
              (turn) => turn.clientTurnId === 'private-turn',
            ),
          ),
        )
        .map((request) => request.workspace.memoryExcluded),
    ).toEqual([true]);
    expect(service.getStatus().pendingCount).toBe(1);

    await jest.advanceTimersByTimeAsync(TELEMETRY_SYNC_DEBOUNCE_MS);
    await tick();
    expect(
      allRequests()
        .filter((request) =>
          request.workspace.worktrees?.some((worktree) =>
            worktree.turns?.some(
              (turn) => turn.clientTurnId === 'private-turn',
            ),
          ),
        )
        .map((request) => request.workspace.memoryExcluded),
    ).toEqual([true, true]);
    expect(service.getStatus().pendingCount).toBe(0);
  });

  it('uploads only after the debounce window and redacts the body', async () => {
    await startService();

    emitTurn(makeEntry({ id: 'turn-secret' }));
    loadTranscriptMock.mockResolvedValueOnce({
      type: 'success',
      lines: ['Authorization: Bearer supersecrettoken123'],
      truncation: {},
      injectedPrompts: [],
    });
    await tick();

    expect(requestCanopyCloudJsonMock).not.toHaveBeenCalled();

    await jest.advanceTimersByTimeAsync(TELEMETRY_SYNC_DEBOUNCE_MS);

    expect(requestCanopyCloudJsonMock).toHaveBeenCalledTimes(1);
    const request = lastRequest();
    expect(request.shareScope).toBe('private');
    expect(request.workspace.clientLocalId).toBe('proj-1');
    const turn = request.workspace.worktrees?.[0]?.turns?.[0];
    expect(turn?.clientTurnId).toBe('turn-secret');
    expect(turn?.body).toBeDefined();
    expect(turn?.body).not.toContain('supersecrettoken123');
    expect(turn?.contentHash).toBeDefined();
  });

  // The usefulness judge (CAN-2253) joins delivered memory injections to
  // uploaded turn bodies by finding the org_memory `canopy_injected_prompt`
  // record in the body. `loadTranscript` strips injected prompts out of
  // `lines`, so the upload body builder must re-serialize the org_memory ones
  // (and only those) back into the body, PREPENDED so the head-keeping byte
  // clamp can never drop the anchor.
  it('re-includes org_memory injected prompts as parseable anchor lines prepended to the body', async () => {
    await startService();

    const orgMemoryBlock =
      '<org_memory>\n• staging uses port 5433\n</org_memory>';
    loadTranscriptMock.mockResolvedValue({
      type: 'success',
      lines: ['{"type":"canopy_user_prompt","original_text":"hi"}'],
      truncation: {},
      injectedPrompts: [
        {
          kind: 'system_prompt_append',
          provider: 'claude',
          applicationCondition: 'claude_system_prompt_append_each_turn',
          text: 'SYSTEM-APPEND-BOILERPLATE',
        },
        {
          kind: 'org_memory',
          provider: 'claude',
          applicationCondition: 'org_memory_enabled_for_turn',
          text: orgMemoryBlock,
        },
      ],
    });
    emitTurn(makeEntry({ id: 'turn-anchored' }));
    await tick();
    await jest.advanceTimersByTimeAsync(TELEMETRY_SYNC_DEBOUNCE_MS);

    const turn = lastRequest().workspace.worktrees?.[0]?.turns?.[0];
    const body = turn?.body ?? '';
    const lines = body.split('\n');
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- parsing a JSONL line this test's own mock produced.
    const anchor = JSON.parse(lines[0]);
    expect(anchor).toEqual({
      type: 'canopy_injected_prompt',
      kind: 'org_memory',
      provider: 'claude',
      application_condition: 'org_memory_enabled_for_turn',
      text: orgMemoryBlock,
    });
    expect(body).toContain('"original_text":"hi"');
    // Only org_memory prompts ride along; system/plan-mode boilerplate stays
    // local (larger, and no server consumer needs it).
    expect(body).not.toContain('SYSTEM-APPEND-BOILERPLATE');
  });

  it('leaves turn bodies without an org_memory injected prompt unchanged', async () => {
    await startService();

    loadTranscriptMock.mockResolvedValue({
      type: 'success',
      lines: ['plain transcript line'],
      truncation: {},
      injectedPrompts: [
        {
          kind: 'system_prompt_append',
          provider: 'claude',
          applicationCondition: 'claude_system_prompt_append_each_turn',
          text: 'SYSTEM-APPEND-BOILERPLATE',
        },
      ],
    });
    emitTurn(makeEntry({ id: 'turn-plain' }));
    await tick();
    await jest.advanceTimersByTimeAsync(TELEMETRY_SYNC_DEBOUNCE_MS);

    const turn = lastRequest().workspace.worktrees?.[0]?.turns?.[0];
    expect(turn?.body).toBe('plain transcript line');
  });

  it('keeps the org_memory anchor through the byte clamp on an over-cap body', async () => {
    await startService();

    const orgMemoryBlock =
      '<org_memory>\n• the clamp keeps the head\n</org_memory>';
    // Two transcript lines whose combined size exceeds the 1 MiB ambient body
    // cap; the line-aware clamp keeps the head, so the prepended anchor line
    // and the first transcript line survive while the oversized tail is cut.
    loadTranscriptMock.mockResolvedValue({
      type: 'success',
      lines: [
        JSON.stringify({ type: 'assistant', text: 'kept head line' }),
        JSON.stringify({ type: 'assistant', text: 'x'.repeat(1024 * 1024) }),
      ],
      truncation: {},
      injectedPrompts: [
        {
          kind: 'org_memory',
          provider: 'claude',
          applicationCondition: 'org_memory_enabled_for_turn',
          text: orgMemoryBlock,
        },
      ],
    });
    emitTurn(makeEntry({ id: 'turn-overcap' }));
    await tick();
    await jest.advanceTimersByTimeAsync(TELEMETRY_SYNC_DEBOUNCE_MS);

    const turn = lastRequest().workspace.worktrees?.[0]?.turns?.[0];
    const body = turn?.body ?? '';
    expect(Buffer.byteLength(body, 'utf8')).toBeLessThanOrEqual(1024 * 1024);
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- parsing a JSONL line this test's own mock produced.
    const anchor = JSON.parse(body.split('\n')[0]);
    expect(anchor).toMatchObject({
      type: 'canopy_injected_prompt',
      kind: 'org_memory',
      text: orgMemoryBlock,
    });
    expect(body).toContain('kept head line');
    expect(body).not.toContain('x'.repeat(1024));
  });

  it('retries a queued upload after transient failure', async () => {
    await startService();
    requestCanopyCloudJsonMock.mockRejectedValueOnce(new Error('offline'));

    emitTurn();
    await tick();
    await jest.advanceTimersByTimeAsync(TELEMETRY_SYNC_DEBOUNCE_MS);

    expect(requestCanopyCloudJsonMock).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(TELEMETRY_SYNC_DEBOUNCE_MS);

    expect(requestCanopyCloudJsonMock).toHaveBeenCalledTimes(2);
    expect(
      lastRequest().workspace.worktrees?.[0]?.turns?.[0]?.clientTurnId,
    ).toBe('turn-1');
  });

  it('drops the rejected group and records a diagnostic on a permanent 400', async () => {
    await startService();
    requestCanopyCloudJsonMock.mockRejectedValueOnce(
      new MockCanopyCloudClientError(
        'http-error',
        'clientTurnId too long',
        400,
      ),
    );

    emitTurn();
    await tick();
    await jest.advanceTimersByTimeAsync(TELEMETRY_SYNC_DEBOUNCE_MS);

    expect(requestCanopyCloudJsonMock).toHaveBeenCalledTimes(1);
    expect(recordAppDiagnosticMock).toHaveBeenCalledTimes(1);
    const diagnostic = recordAppDiagnosticMock.mock.calls[0][0];
    expect(diagnostic).toMatchObject({
      kind: 'telemetry_upload_failed',
      telemetryUploadStatus: 400,
      telemetryShareScope: 'private',
    });
    expect(diagnostic.error).toContain('clientTurnId too long');

    // The poison batch is dropped, so a later flush window does NOT re-upload.
    await jest.advanceTimersByTimeAsync(TELEMETRY_SYNC_DEBOUNCE_MS);
    expect(requestCanopyCloudJsonMock).toHaveBeenCalledTimes(1);
  });

  it('drops the rejected group on a 413 (over-cap piece is permanent, not transient)', async () => {
    // A 413 can only escape when byte-aware chunking is forced to emit a lone
    // item that is itself over the server byte cap — a piece that can never
    // shrink on retry — so it must be treated as poison (drop), NOT deferred
    // (retry forever).
    await startService();
    requestCanopyCloudJsonMock.mockRejectedValueOnce(
      new MockCanopyCloudClientError(
        'http-error',
        'request entity too large',
        413,
      ),
    );

    emitTurn();
    await tick();
    await jest.advanceTimersByTimeAsync(TELEMETRY_SYNC_DEBOUNCE_MS);

    expect(requestCanopyCloudJsonMock).toHaveBeenCalledTimes(1);
    expect(recordAppDiagnosticMock).toHaveBeenCalledTimes(1);
    expect(recordAppDiagnosticMock.mock.calls[0][0]).toMatchObject({
      kind: 'telemetry_upload_failed',
      telemetryUploadStatus: 413,
    });

    // Poison → dropped, so a later flush window does NOT re-upload.
    await jest.advanceTimersByTimeAsync(TELEMETRY_SYNC_DEBOUNCE_MS);
    expect(requestCanopyCloudJsonMock).toHaveBeenCalledTimes(1);
  });

  // CAN-3106 seam: an unpersistable payload now surfaces as a 422 carrying
  // `telemetry_permanent_write_error` instead of the bare 500 that this outbox
  // read as transient and replayed forever. Already-shipped clients need no
  // update because this branch keys on the STATUS, but the pairing is what ends
  // the incident, so it is pinned here.
  it('poisons and drops the group on a permanent-write 422 from the server', async () => {
    await startService();
    requestCanopyCloudJsonMock.mockRejectedValueOnce(
      new MockCanopyCloudClientError(
        'http-error',
        '422 Unprocessable Entity',
        422,
        TELEMETRY_PERMANENT_WRITE_ERROR_CODE,
      ),
    );

    emitTurn();
    await tick();
    await jest.advanceTimersByTimeAsync(TELEMETRY_SYNC_DEBOUNCE_MS);

    expect(requestCanopyCloudJsonMock).toHaveBeenCalledTimes(1);
    expect(recordAppDiagnosticMock).toHaveBeenCalledTimes(1);
    expect(recordAppDiagnosticMock.mock.calls[0][0]).toMatchObject({
      kind: 'telemetry_upload_failed',
      telemetryUploadStatus: 422,
    });

    // Poison → dropped. The 5xx rejection ladder must NOT engage: this is a
    // terminal payload refusal, not a run of server rejections to back off from.
    await jest.advanceTimersByTimeAsync(TELEMETRY_SYNC_DEBOUNCE_MS * 5);
    expect(requestCanopyCloudJsonMock).toHaveBeenCalledTimes(1);
    expect(
      recordAppDiagnosticMock.mock.calls.some(
        ([diagnostic]) => diagnostic.kind === 'telemetry_upload_abandoned',
      ),
    ).toBe(false);
  });

  it('keeps the group queued on a transient 500 and records a diagnostic', async () => {
    await startService();
    requestCanopyCloudJsonMock.mockRejectedValueOnce(
      new MockCanopyCloudClientError('http-error', 'server error', 500),
    );

    emitTurn();
    await tick();
    await jest.advanceTimersByTimeAsync(TELEMETRY_SYNC_DEBOUNCE_MS);

    expect(requestCanopyCloudJsonMock).toHaveBeenCalledTimes(1);
    expect(recordAppDiagnosticMock).toHaveBeenCalledTimes(1);
    expect(recordAppDiagnosticMock.mock.calls[0][0]).toMatchObject({
      kind: 'telemetry_upload_failed',
      telemetryUploadStatus: 500,
    });

    // Transient failure → the group stays queued and retries on the next window.
    await jest.advanceTimersByTimeAsync(TELEMETRY_SYNC_DEBOUNCE_MS);
    expect(requestCanopyCloudJsonMock).toHaveBeenCalledTimes(2);
    expect(
      lastRequest().workspace.worktrees?.[0]?.turns?.[0]?.clientTurnId,
    ).toBe('turn-1');
  });

  // CAN-3106: before the escalating ladder, a 5xx re-armed the same 60s timer
  // forever — 52-59 identical failures an hour, all day, in staging.
  it('escalates the retry delay after consecutive server rejections', async () => {
    await startService();
    requestCanopyCloudJsonMock.mockRejectedValue(
      new MockCanopyCloudClientError('http-error', 'server error', 500),
    );

    emitTurn();
    await tick();
    await jest.advanceTimersByTimeAsync(TELEMETRY_SYNC_DEBOUNCE_MS);
    expect(requestCanopyCloudJsonMock).toHaveBeenCalledTimes(1);

    // One rejection keeps the normal cadence, so a single blip is not punished.
    await jest.advanceTimersByTimeAsync(TELEMETRY_SYNC_RETRY_DELAYS_MS[0]);
    expect(requestCanopyCloudJsonMock).toHaveBeenCalledTimes(2);

    // Two rejections double the window: nothing at 60s...
    await jest.advanceTimersByTimeAsync(TELEMETRY_SYNC_RETRY_DELAYS_MS[0]);
    expect(requestCanopyCloudJsonMock).toHaveBeenCalledTimes(2);
    // ...and exactly one attempt once the 120s rung elapses.
    await jest.advanceTimersByTimeAsync(TELEMETRY_SYNC_RETRY_DELAYS_MS[0]);
    expect(requestCanopyCloudJsonMock).toHaveBeenCalledTimes(3);
  });

  it('persists the rejection run so a restart resumes the escalated cadence', async () => {
    const service = await startService();
    requestCanopyCloudJsonMock.mockRejectedValue(
      new MockCanopyCloudClientError('http-error', 'server error', 500),
    );

    emitTurn();
    await tick();
    await jest.advanceTimersByTimeAsync(TELEMETRY_SYNC_DEBOUNCE_MS);
    await jest.advanceTimersByTimeAsync(TELEMETRY_SYNC_RETRY_DELAYS_MS[0]);
    expect(requestCanopyCloudJsonMock).toHaveBeenCalledTimes(2);

    const queued = lastQueueWrite();
    expect(queued).toMatchObject({ consecutiveServerRejections: 2 });
    expect(queued?.firstRejectionAt).toEqual(expect.any(String));

    // Restart on that queue file: the run survives, so the outage is not
    // re-probed every 60 seconds just because the app relaunched.
    await service.dispose();
    jest.clearAllMocks();
    requestCanopyCloudJsonMock.mockRejectedValue(
      new MockCanopyCloudClientError('http-error', 'server error', 500),
    );
    const enoent = Object.assign(new Error('not found'), { code: 'ENOENT' });
    readFileMock.mockImplementation((filePath: string) => {
      if (filePath === '/tmp/telemetry/queue.jsonl') {
        return Promise.resolve(`${JSON.stringify(queued)}\n`);
      }
      return Promise.reject(enoent);
    });

    await startService();
    await jest.advanceTimersByTimeAsync(TELEMETRY_SYNC_RETRY_DELAYS_MS[0]);
    expect(requestCanopyCloudJsonMock).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(TELEMETRY_SYNC_RETRY_DELAYS_MS[0]);
    expect(requestCanopyCloudJsonMock).toHaveBeenCalledTimes(1);
  });

  it('abandons the batch after ten consecutive server rejections', async () => {
    await startService();
    requestCanopyCloudJsonMock.mockRejectedValue(
      new MockCanopyCloudClientError('http-error', 'server error', 500),
    );

    emitTurn();
    await tick();
    const maxDelay =
      TELEMETRY_SYNC_RETRY_DELAYS_MS[TELEMETRY_SYNC_RETRY_DELAYS_MS.length - 1];
    for (
      let attempt = 0;
      attempt < MAX_TELEMETRY_CONSECUTIVE_SERVER_REJECTIONS;
      attempt += 1
    ) {
      await jest.advanceTimersByTimeAsync(maxDelay);
    }

    expect(requestCanopyCloudJsonMock).toHaveBeenCalledTimes(
      MAX_TELEMETRY_CONSECUTIVE_SERVER_REJECTIONS,
    );
    const abandoned = recordAppDiagnosticMock.mock.calls
      .map(([diagnostic]) => diagnostic)
      .find((diagnostic) => diagnostic.kind === 'telemetry_upload_abandoned');
    expect(abandoned).toMatchObject({
      kind: 'telemetry_upload_abandoned',
      telemetryUploadStatus: 500,
      telemetryShareScope: 'private',
      telemetryConsecutiveServerRejections:
        MAX_TELEMETRY_CONSECUTIVE_SERVER_REJECTIONS,
    });
    expect(abandoned?.telemetryFirstRejectionAt).toEqual(expect.any(String));

    // The batch is dropped, so the queue stops replaying it forever.
    await jest.advanceTimersByTimeAsync(maxDelay * 3);
    expect(requestCanopyCloudJsonMock).toHaveBeenCalledTimes(
      MAX_TELEMETRY_CONSECUTIVE_SERVER_REJECTIONS,
    );
  });

  it('never escalates or abandons while the server is unreachable', async () => {
    // A laptop offline for an hour must not lose its queued telemetry: an
    // absent status means no response ever arrived, so there is nothing for the
    // server to have rejected.
    await startService();
    requestCanopyCloudJsonMock.mockRejectedValue(
      new MockCanopyCloudClientError('network-error', 'offline'),
    );

    emitTurn();
    await tick();
    const attempts = MAX_TELEMETRY_CONSECUTIVE_SERVER_REJECTIONS + 5;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      await jest.advanceTimersByTimeAsync(TELEMETRY_SYNC_DEBOUNCE_MS);
    }

    // Still the flat 60s cadence, and nothing was abandoned.
    expect(requestCanopyCloudJsonMock).toHaveBeenCalledTimes(attempts);
    expect(
      recordAppDiagnosticMock.mock.calls.some(
        ([diagnostic]) => diagnostic.kind === 'telemetry_upload_abandoned',
      ),
    ).toBe(false);

    // And the turn is still queued: it uploads as soon as the network returns.
    requestCanopyCloudJsonMock.mockImplementation(
      (_path: string, init: { body: string }) =>
        Promise.resolve(buildIngestSuccessResponse(init)),
    );
    await jest.advanceTimersByTimeAsync(TELEMETRY_SYNC_DEBOUNCE_MS);
    expect(
      lastRequest().workspace.worktrees?.[0]?.turns?.[0]?.clientTurnId,
    ).toBe('turn-1');
  });

  it('loads queue lines written before the rejection counters existed', async () => {
    // `loadQueue` discards any line whose version does not match, so the new
    // fields were added WITHOUT bumping `QUEUE_LINE_VERSION`; bumping it would
    // have deleted every user's un-flushed telemetry on upgrade.
    const legacyLine = {
      version: 2,
      projectId: 'proj-1',
      worktreeId: 'wt-1',
      workspaceName: 'My workspace',
      workspaceType: 'single-repo',
      branchName: 'feature/telemetry',
      turns: [
        {
          clientTurnId: 'legacy-turn',
          eventType: 'worktree_chat',
          status: 'success',
          provider: 'claude',
          label: 'Legacy turn',
          startedAt: '2026-06-16T00:00:00.000Z',
          body: 'legacy body',
        },
      ],
      plans: [],
      pullRequests: [],
    };
    const enoent = Object.assign(new Error('not found'), { code: 'ENOENT' });
    readFileMock.mockImplementation((filePath: string) => {
      if (filePath === '/tmp/telemetry/queue.jsonl') {
        return Promise.resolve(`${JSON.stringify(legacyLine)}\n`);
      }
      return Promise.reject(enoent);
    });

    await startService();
    await jest.advanceTimersByTimeAsync(TELEMETRY_SYNC_DEBOUNCE_MS);
    await tick();

    expect(requestCanopyCloudJsonMock).toHaveBeenCalledTimes(1);
    expect(
      lastRequest().workspace.worktrees?.[0]?.turns?.[0]?.clientTurnId,
    ).toBe('legacy-turn');
  });

  it('byte-aware splits 250 turns into 100/100/50 pieces; a later piece may carry the plan', async () => {
    // Preload the queue with 250 turns plus one plan so the run has real
    // non-turn content whose placement across byte-aware pieces can be asserted.
    const queuedTurns = Array.from({ length: 250 }, (_unused, index) => ({
      clientTurnId: `turn-${index + 1}`,
      eventType: 'worktree_chat',
      status: 'success',
      provider: 'claude',
      label: `Turn ${index + 1}`,
      startedAt: '2026-06-16T00:00:00.000Z',
      body: `body ${index + 1}`,
    }));
    const queuedWorktree = {
      version: 2,
      projectId: 'proj-1',
      worktreeId: 'wt-1',
      workspaceName: 'My workspace',
      workspaceType: 'single-repo',
      branchName: 'feature/telemetry',
      turns: queuedTurns,
      plans: [
        {
          clientPlanId: 'batch-plan',
          title: 'Rides the first batch only',
          reviewStatus: 'approved',
          planVersion: 1,
          planTextBytes: 11,
          planLineCount: 1,
          body: 'plan body',
        },
      ],
      pullRequests: [],
    };
    const enoent = Object.assign(new Error('not found'), { code: 'ENOENT' });
    readFileMock.mockImplementation((filePath: string) => {
      if (filePath === '/tmp/telemetry/queue.jsonl') {
        return Promise.resolve(`${JSON.stringify(queuedWorktree)}\n`);
      }
      return Promise.reject(enoent);
    });

    const service = await startService();
    await jest.advanceTimersByTimeAsync(TELEMETRY_SYNC_DEBOUNCE_MS);
    await tick();

    // With a generous byte budget the count cap governs: three pieces at the
    // server's hard 100-turn cap (100 + 100 + 50 = 250).
    expect(requestCanopyCloudJsonMock).toHaveBeenCalledTimes(3);
    expect(turnsForCall(0)).toHaveLength(100);
    expect(turnsForCall(1)).toHaveLength(100);
    expect(turnsForCall(2)).toHaveLength(50);

    // Every queued turn is uploaded exactly once — no truncation past 100.
    const uploadedIds = new Set(
      allRequests().flatMap((request) =>
        (request.workspace.worktrees?.[0]?.turns ?? []).map(
          (turn) => turn.clientTurnId,
        ),
      ),
    );
    const expectedIds = new Set(
      Array.from({ length: 250 }, (_unused, index) => `turn-${index + 1}`),
    );
    expect(uploadedIds).toEqual(expectedIds);

    // Non-turn content is no longer pinned to the first batch: the plan rides
    // exactly one piece, and byte-aware packing (turns first) places it on a
    // LATER piece rather than the first.
    const planCounts = allRequests().map(
      (request) => request.workspace.worktrees?.[0]?.plans?.length ?? 0,
    );
    expect(planCounts.reduce((sum, count) => sum + count, 0)).toBe(1);
    expect(planCounts[0]).toBe(0);
    expect(planCounts[planCounts.length - 1]).toBe(1);

    // Every POST stays within the client chunk budget.
    for (const request of allRequests()) {
      expect(
        Buffer.byteLength(JSON.stringify(request), 'utf8'),
      ).toBeLessThanOrEqual(MAX_TELEMETRY_INGEST_BATCH_BYTES);
    }

    expect(service.getStatus().pendingCount).toBe(0);
    expect(service.getStatus().lastError).toBeNull();
  });

  it('sends exactly one batch for exactly 100 turns (no empty second batch)', async () => {
    await startService();

    emitTurns(100);
    await drainQueuedTurns();
    await jest.advanceTimersByTimeAsync(TELEMETRY_SYNC_DEBOUNCE_MS);
    await tick();

    expect(requestCanopyCloudJsonMock).toHaveBeenCalledTimes(1);
    expect(turnsForCall(0)).toHaveLength(100);
  });

  it('re-queues a group when a later batch fails, then re-sends cheaply', async () => {
    let callCount = 0;
    requestCanopyCloudJsonMock.mockImplementation(
      (_path: string, init: { body: string }) => {
        callCount += 1;
        // Fail the SECOND batch (turns 101-200) of the first flush only.
        if (callCount === 2) {
          throw new MockCanopyCloudClientError(
            'http-error',
            'server error',
            500,
          );
        }
        return Promise.resolve(buildIngestSuccessResponse(init));
      },
    );
    const service = await startService();

    emitTurns(250);
    await drainQueuedTurns();
    await jest.advanceTimersByTimeAsync(TELEMETRY_SYNC_DEBOUNCE_MS);
    await tick();

    // Batch 0 succeeded, batch 1 failed and stopped batching this target, so
    // batch 2 was never attempted. The whole group stays queued — pendingCount
    // counts retained items, so all 250 turns remain.
    expect(requestCanopyCloudJsonMock).toHaveBeenCalledTimes(2);
    expect(service.getStatus().pendingCount).toBe(250);
    expect(service.getStatus().lastError).toBe('upload-failed');

    // Next window re-sends all three batches. Batch 0's turns were recorded on
    // the first attempt, so their bodies short-circuit to undefined; the server
    // upserts idempotently by clientTurnId.
    await jest.advanceTimersByTimeAsync(TELEMETRY_SYNC_DEBOUNCE_MS);
    await tick();

    expect(requestCanopyCloudJsonMock).toHaveBeenCalledTimes(5);
    const retryBatch0 = turnsForCall(2);
    expect(retryBatch0).toHaveLength(100);
    expect(retryBatch0.every((turn) => turn.body === undefined)).toBe(true);
    // Batch 1's turns were never stored, so their bodies are re-sent in full.
    expect(turnsForCall(3).some((turn) => turn.body !== undefined)).toBe(true);

    expect(service.getStatus().pendingCount).toBe(0);
    expect(service.getStatus().lastError).toBeNull();
  });

  it('abandons after ten later-piece rejections even when an earlier piece succeeds', async () => {
    let callCount = 0;
    requestCanopyCloudJsonMock.mockImplementation(
      (_path: string, init: { body: string }) => {
        callCount += 1;
        // Every flush accepts piece 1, then rejects piece 2. A piece-level
        // success must not reset the worktree's rejection run before the later
        // failure is observed, or this batch retries every minute forever.
        if (callCount % 2 === 0) {
          throw new MockCanopyCloudClientError(
            'http-error',
            'server error',
            500,
          );
        }
        return Promise.resolve(buildIngestSuccessResponse(init));
      },
    );
    const service = await startService();

    emitTurns(250);
    await drainQueuedTurns();

    for (
      let attempt = 0;
      attempt < MAX_TELEMETRY_CONSECUTIVE_SERVER_REJECTIONS;
      attempt += 1
    ) {
      const delay =
        attempt === 0
          ? TELEMETRY_SYNC_DEBOUNCE_MS
          : TELEMETRY_SYNC_RETRY_DELAYS_MS[
              Math.min(attempt - 1, TELEMETRY_SYNC_RETRY_DELAYS_MS.length - 1)
            ];
      await jest.advanceTimersByTimeAsync(delay);
      await tick();
    }

    expect(requestCanopyCloudJsonMock).toHaveBeenCalledTimes(
      MAX_TELEMETRY_CONSECUTIVE_SERVER_REJECTIONS * 2,
    );
    expect(service.getStatus().pendingCount).toBe(0);
    expect(
      recordAppDiagnosticMock.mock.calls
        .map(([diagnostic]) => diagnostic)
        .find((diagnostic) => diagnostic.kind === 'telemetry_upload_abandoned'),
    ).toMatchObject({
      telemetryConsecutiveServerRejections:
        MAX_TELEMETRY_CONSECUTIVE_SERVER_REJECTIONS,
    });
  });

  it('drops the whole group when a mid-upload batch is rejected with a 400', async () => {
    let callCount = 0;
    requestCanopyCloudJsonMock.mockImplementation(
      (_path: string, init: { body: string }) => {
        callCount += 1;
        if (callCount === 2) {
          throw new MockCanopyCloudClientError(
            'http-error',
            'clientTurnId too long',
            400,
          );
        }
        return Promise.resolve(buildIngestSuccessResponse(init));
      },
    );
    const service = await startService();

    emitTurns(250);
    await drainQueuedTurns();
    await jest.advanceTimersByTimeAsync(TELEMETRY_SYNC_DEBOUNCE_MS);
    await tick();

    // Batch 0 ok, batch 1 poisoned (400) → stop batching, group dropped.
    expect(requestCanopyCloudJsonMock).toHaveBeenCalledTimes(2);
    expect(recordAppDiagnosticMock).toHaveBeenCalledTimes(1);
    expect(recordAppDiagnosticMock.mock.calls[0][0]).toMatchObject({
      kind: 'telemetry_upload_failed',
      telemetryUploadStatus: 400,
    });
    expect(service.getStatus().pendingCount).toBe(0);

    // Poison drop is permanent: the next window does NOT re-upload.
    await jest.advanceTimersByTimeAsync(TELEMETRY_SYNC_DEBOUNCE_MS);
    expect(requestCanopyCloudJsonMock).toHaveBeenCalledTimes(2);
  });

  it('sends a single request for a group with plans but no turns', async () => {
    const queuedWorktree = {
      version: 2,
      projectId: 'proj-1',
      worktreeId: 'wt-1',
      workspaceName: 'My workspace',
      workspaceType: 'single-repo',
      branchName: 'feature/telemetry',
      turns: [],
      plans: [
        {
          clientPlanId: 'lonely-plan',
          title: 'A plan with no turns',
          reviewStatus: 'approved',
          planVersion: 1,
          planTextBytes: 11,
          planLineCount: 1,
          body: 'plan body',
        },
      ],
      pullRequests: [],
    };
    const enoent = Object.assign(new Error('not found'), { code: 'ENOENT' });
    readFileMock.mockImplementation((filePath: string) => {
      if (filePath === '/tmp/telemetry/queue.jsonl') {
        return Promise.resolve(`${JSON.stringify(queuedWorktree)}\n`);
      }
      return Promise.reject(enoent);
    });

    const service = await startService();
    await jest.advanceTimersByTimeAsync(TELEMETRY_SYNC_DEBOUNCE_MS);
    await tick();

    // max(1, ceil(0/100)) === 1: the empty-turns group still sends exactly one
    // request carrying the plan, with the `turns` key omitted.
    expect(requestCanopyCloudJsonMock).toHaveBeenCalledTimes(1);
    const worktree = lastRequest().workspace.worktrees?.[0];
    expect(worktree?.turns).toBeUndefined();
    const plans: TelemetryPlanPayload[] = worktree?.plans ?? [];
    expect(plans).toHaveLength(1);
    expect(plans[0]?.clientPlanId).toBe('lonely-plan');
    expect(service.getStatus().pendingCount).toBe(0);
  });
});

describe('TelemetrySyncService owner scope (CAN-3515)', () => {
  const OWNER_A = {
    type: 'organization' as const,
    organizationId: ORG_A,
    projectId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    instanceId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    bindingGeneration: 1,
  };

  function select(organizationId: string | null): void {
    getWorkspaceContextStateMock.mockReturnValue({
      context:
        organizationId === null
          ? { kind: 'personal' }
          : { kind: 'organization', organizationId },
    });
  }

  beforeEach(() => {
    readPreferencesFileMock.mockResolvedValue(uniformSharing('organization'));
    getCanopyCloudCredentialsMock.mockResolvedValue({
      baseUrl: 'https://cloud.example',
      apiKey: 'key',
      capabilities: [],
      teams: [
        { id: 'team-a', organization: { id: ORG_A } },
        { id: 'team-b', organization: { id: ORG_B } },
      ],
      organizations: [{ id: ORG_A }, { id: ORG_B }],
    });
  });

  function persistedQueue(): string {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- mock calls produced by the service under test.
    const calls: unknown[][] = writeFileMock.mock.calls;
    const queue = calls
      .filter((call) => call[0] === '/tmp/telemetry/queue.jsonl')
      .at(-1)?.[1];
    if (typeof queue !== 'string')
      throw new Error('Expected a persisted queue');
    return queue;
  }

  function destinations(): string[] {
    return allRequests().map((request) =>
      request.shareScope === 'private'
        ? 'private'
        : `${request.shareScope}:${request.organizationId ?? request.teamId}`,
    );
  }

  function mergedPr(prNumber: number): TelemetryPullRequestPayload {
    return {
      repoId: 'canopy',
      repoName: 'canopy',
      prNumber,
      prUrl: `https://github.com/o/canopy/pull/${prNumber}`,
      title: `PR ${prNumber}`,
      state: 'merged',
      checkStatus: 'none',
      reviewStatus: 'none',
      hasConflicts: false,
      commentCount: 0,
      openedAt: '2026-09-20T00:00:00.000Z',
      mergedAt: '2026-09-22T00:00:00.000Z',
      prUpdatedAt: '2026-09-22T00:00:00.000Z',
    };
  }

  function restoreQueue(lines: unknown[]): void {
    const queue = lines.map((line) => JSON.stringify(line)).join('\n');
    readFileMock.mockImplementation((path: string) =>
      path === '/tmp/telemetry/queue.jsonl'
        ? Promise.resolve(`${queue}\n`)
        : Promise.reject(new Error('missing')),
    );
  }

  it('counts turns and PRs of org-owned work for the owner while Personal is selected', async () => {
    ownWorkspaceBy(ORG_A);
    select(null);
    const service = await startService();
    emitTurn();
    await service.enqueueReconciledPullRequests('proj-1', [mergedPr(3515)]);
    await drainQueuedTurns();
    await service.flushAll();

    expect(destinations()).toEqual([
      `organization:${ORG_A}`,
      `organization:${ORG_A}`,
    ]);
    const sent = allRequests().flatMap(
      (request) => request.workspace.worktrees ?? [],
    );
    expect(sent.flatMap((worktree) => worktree.turns ?? [])).toEqual([
      expect.objectContaining({ clientTurnId: 'turn-1' }),
    ]);
    expect(sent.flatMap((worktree) => worktree.pullRequests ?? [])).toEqual([
      expect.objectContaining({ prNumber: 3515 }),
    ]);
    for (const request of allRequests()) {
      expect(request.workspace).toMatchObject({
        sourceProjectId: OWNER_A.projectId,
        sourceOrganizationId: ORG_A,
      });
    }
    expect(service.getStatus().pendingCount).toBe(0);
  });

  it.each(['organization', 'team'] as const)(
    'keeps Personal work private at %s scope while an organization is selected',
    async (scope) => {
      readPreferencesFileMock.mockResolvedValue(uniformSharing(scope));
      ownWorkspaceBy(null);
      select(ORG_A);
      const service = await startService();
      emitTurn();
      await service.enqueueReconciledPullRequests('proj-1', [mergedPr(3516)]);
      await drainQueuedTurns();
      await service.flushAll();

      expect(destinations()).toEqual(['private', 'private']);
      for (const request of allRequests()) {
        expect(request.organizationId).toBeUndefined();
        expect(request.teamId).toBeUndefined();
        expect(request.workspace.sourceProjectId).toBeUndefined();
      }
      expect(service.getStatus().pendingCount).toBe(0);
    },
  );

  it('keeps transcript bodies and summaries of Personal work shared at organization scope', async () => {
    select(ORG_A);
    const service = await startService();
    emitTurn();
    jest
      .mocked(addWorktreeSummaryChangeListener)
      .mock.calls.at(-1)?.[0]({
        projectId: 'proj-1',
        worktreeId: 'wt-1',
        summary: {
          title: 'Private recap',
          description: 'Personal work stays Personal',
          highlights: ['Private'],
          generatedAt: '2026-09-22T12:00:00.000Z',
          turnCountAtGeneration: 1,
          lastFullRefreshAt: '2026-09-22T12:00:00.000Z',
          lastFullRefreshTurnCount: 1,
        },
        snapshotId: 'personal-summary',
        isNewSnapshot: true,
      });
    await drainQueuedTurns();
    await service.flushAll();

    expect(allRequests()).toHaveLength(1);
    expect(lastRequest()).toMatchObject({ shareScope: 'private' });
    const worktree = lastRequest().workspace.worktrees?.[0];
    expect(worktree?.turns?.[0]?.body).toBeDefined();
    expect(worktree?.summary).toContain('Private recap');
    expect(worktree?.summaries?.[0]?.clientSnapshotId).toBe('personal-summary');
  });

  it('does not let a context switch between capture and flush move queued work', async () => {
    ownWorkspaceBy(ORG_A);
    select(ORG_A);
    const service = await startService();
    emitTurn(makeEntry({ id: 'captured-in-owner' }));
    await drainQueuedTurns();
    select(null);
    emitTurn(makeEntry({ id: 'captured-in-personal' }));
    await drainQueuedTurns();
    select(ORG_B);
    emitTurn(makeEntry({ id: 'captured-in-other-org' }));
    await drainQueuedTurns();
    await service.flushAll();

    expect(destinations()).toEqual([`organization:${ORG_A}`]);
    expect(
      lastRequest().workspace.worktrees?.[0]?.turns?.map(
        (turn) => turn.clientTurnId,
      ),
    ).toEqual([
      'captured-in-owner',
      'captured-in-personal',
      'captured-in-other-org',
    ]);
    expect(recordSessionDiagnosticMock).not.toHaveBeenCalled();
  });

  it('re-evaluates work queued before a restart by its owner, not the selection at either time', async () => {
    ownWorkspaceBy(ORG_A);
    select(null);
    const service = await startService();
    emitTurn(makeEntry({ id: 'queued-before-restart' }));
    await drainQueuedTurns();
    // The queue as the previous session left it on disk, read before dispose
    // drains it. The restarted session below is the one under test.
    const queue = persistedQueue();
    expect(queue).not.toContain('selectedOrganizationId');
    await service.dispose();
    requestCanopyCloudJsonMock.mockClear();
    restoreQueue(
      queue
        .trim()
        .split('\n')
        .map((line): unknown => JSON.parse(line)),
    );
    select(ORG_B);

    const restarted = await startService();
    await restarted.flushAll();
    expect(destinations()).toEqual([`organization:${ORG_A}`]);
    expect(
      lastRequest().workspace.worktrees?.[0]?.turns?.[0]?.clientTurnId,
    ).toBe('queued-before-restart');
  });

  const LEGACY_TURN = {
    clientTurnId: 'legacy-turn',
    startedAt: '2026-09-22T00:00:00.000Z',
    status: 'SUCCESS',
    eventType: 'WORKTREE_CHAT',
  };
  const LEGACY_META = {
    workspaceName: 'My workspace',
    workspaceType: 'single-repo',
    branchName: 'legacy',
  };

  it.each([
    [
      'a pre-CAN-3278 unstamped line',
      ORG_A,
      {
        version: 2,
        projectId: 'proj-1',
        worktreeId: 'wt-1',
        ...LEGACY_META,
        turns: [LEGACY_TURN],
        plans: [],
        pullRequests: [],
        pipelineRuns: [],
      },
      [`organization:${ORG_A}`],
    ],
    [
      'a line stamped Personal for org-owned work',
      ORG_A,
      {
        version: 2,
        selectedOrganizationId: null,
        projectId: 'proj-1',
        worktreeId: 'wt-1',
        ...LEGACY_META,
        turns: [],
        plans: [],
        pullRequests: [],
        pipelineRuns: [],
        items: {
          turns: [
            {
              id: 'legacy-turn',
              selectedOrganizationId: null,
              value: LEGACY_TURN,
            },
          ],
          plans: [],
          pullRequests: [],
          pipelineRuns: [],
          summaries: [],
          summarySnapshots: [],
          metadata: [
            {
              id: 'metadata',
              selectedOrganizationId: null,
              value: LEGACY_META,
            },
          ],
        },
      },
      [`organization:${ORG_A}`],
    ],
    [
      'items stamped with another organization for Personal work',
      null,
      {
        version: 2,
        projectId: 'proj-1',
        worktreeId: 'wt-1',
        ...LEGACY_META,
        turns: [],
        plans: [],
        pullRequests: [],
        pipelineRuns: [],
        items: {
          turns: [
            {
              id: 'legacy-turn',
              selectedOrganizationId: ORG_B,
              value: LEGACY_TURN,
            },
          ],
          plans: [],
          pullRequests: [],
          pipelineRuns: [],
          summaries: [],
          summarySnapshots: [],
          metadata: [
            {
              id: 'metadata',
              selectedOrganizationId: ORG_B,
              value: LEGACY_META,
            },
          ],
        },
      },
      ['private'],
    ],
  ])(
    'delivers %s where the work belongs',
    async (_label, owner, line, expected) => {
      ownWorkspaceBy(owner);
      select(owner === null ? ORG_A : null);
      restoreQueue([line]);
      const restarted = await startService();
      await restarted.flushAll();

      expect(destinations()).toEqual(expected);
      expect(
        lastRequest().workspace.worktrees?.[0]?.turns?.[0]?.clientTurnId,
      ).toBe('legacy-turn');
      expect(restarted.getStatus().pendingCount).toBe(0);
    },
  );

  it('delivers duplicates of one legacy item captured under two stamps once, at its owner', async () => {
    ownWorkspaceBy(ORG_A);
    select(null);
    const older = { ...LEGACY_TURN, totalCostUsd: 0.1 };
    const newer = { ...LEGACY_TURN, totalCostUsd: 0.2 };
    restoreQueue([
      {
        version: 2,
        projectId: 'proj-1',
        worktreeId: 'wt-1',
        ...LEGACY_META,
        turns: [],
        plans: [],
        pullRequests: [],
        pipelineRuns: [],
        items: {
          turns: [
            { id: 'legacy-turn', selectedOrganizationId: null, value: older },
            { id: 'legacy-turn', selectedOrganizationId: ORG_A, value: newer },
          ],
          plans: [],
          pullRequests: [],
          pipelineRuns: [],
          summaries: [],
          summarySnapshots: [],
          metadata: [
            {
              id: 'metadata',
              selectedOrganizationId: null,
              value: LEGACY_META,
            },
          ],
        },
      },
    ]);
    const restarted = await startService();
    await restarted.flushAll();

    expect(destinations()).toEqual([`organization:${ORG_A}`]);
    expect(lastRequest().workspace.worktrees?.[0]?.turns).toEqual([
      expect.objectContaining({
        clientTurnId: 'legacy-turn',
        totalCostUsd: 0.2,
      }),
    ]);
  });

  it('keeps linked Personal work private even when the matching organization is selected', async () => {
    const targetSpy = jest
      .spyOn(workspaceTarget, 'resolveWorkspaceTarget')
      .mockResolvedValue({
        workspaceOwner: { kind: 'personal' },
        linkedOrganizationIds: [ORG_A],
      });
    ownWorkspaceBy(null);
    select(ORG_A);
    const service = await startService();
    emitTurn(makeEntry({ id: 'linked-personal' }));
    await drainQueuedTurns();
    await service.flushAll();

    expect(destinations()).toEqual(['private']);
    targetSpy.mockRestore();
  });

  it('registers an explicitly chosen shared-container organization without counting Personal activity there', async () => {
    ownWorkspaceBy(null);
    select(ORG_A);
    const service = await startService();
    service.recordUserActivity('proj-1', 'wt-1', '2026-09-22T10:00:00.000Z');
    emitTurn();
    await drainQueuedTurns();
    await service.refreshWorktreeMetadata('proj-1', 'wt-1', ORG_B);
    await drainQueuedTurns();
    await service.flushAll();

    expect(destinations().sort()).toEqual([`organization:${ORG_B}`, 'private']);
    const anchor = allRequests().find(
      (request) => request.shareScope === 'organization',
    );
    const anchorWorktree = anchor?.workspace.worktrees?.[0];
    expect(anchorWorktree?.turns).toBeUndefined();
    expect(anchorWorktree?.userActiveAt).toBeUndefined();
    const personal = allRequests().find(
      (request) => request.shareScope === 'private',
    );
    expect(personal?.workspace.worktrees?.[0]?.turns).toHaveLength(1);
    expect(personal?.workspace.worktrees?.[0]?.userActiveAt).toBe(
      '2026-09-22T10:00:00.000Z',
    );
    expect(
      service.resolveServerWorktreeExternalId('proj-1', 'wt-1', ORG_B),
    ).toBe('wt-ext');
  });

  it.each([
    ['private', undefined],
    ['organization', '2026-09-22T10:00:00.000Z'],
  ] as const)(
    'attaches presence to an organization plan upload only when metadata is shared there (metadata %s)',
    async (metadata, expectedPresence) => {
      readPreferencesFileMock.mockResolvedValue({
        telemetrySharing: {
          metadata,
          transcripts: metadata,
          plans: 'organization',
          summaries: metadata,
        },
      });
      ownWorkspaceBy(ORG_A);
      select(ORG_A);
      const service = await startService();
      service.recordUserActivity('proj-1', 'wt-1', '2026-09-22T10:00:00.000Z');
      jest.mocked(addPlanContentChangeListener).mock.calls.at(-1)?.[0]({
        id: 'org-plan',
        projectId: 'proj-1',
        worktreeId: 'wt-1',
        source: 'claude',
        title: 'Org plan',
        content: 'Org plan',
        reviewStatus: 'pending',
        createdAt: '2026-09-22T00:00:00.000Z',
        updatedAt: '2026-09-22T00:00:00.000Z',
        latestRevisionNumber: 1,
        revisions: [],
        linkedExecutionIds: [],
      });
      await drainQueuedTurns();
      await service.flushAll();

      const organizationRequest = allRequests().find(
        (request) => request.shareScope === 'organization',
      );
      const worktree = organizationRequest?.workspace.worktrees?.[0];
      expect(worktree?.plans?.map((plan) => plan.clientPlanId)).toEqual([
        'org-plan',
      ]);
      expect(worktree?.userActiveAt).toBe(expectedPresence);
      if (metadata === 'private') {
        // Presence still reaches the destination metadata is shared with.
        const privateRequest = allRequests().find(
          (request) => request.shareScope === 'private',
        );
        expect(privateRequest?.workspace.worktrees?.[0]?.userActiveAt).toBe(
          '2026-09-22T10:00:00.000Z',
        );
      }
    },
  );

  it('attaches presence to the owner route whichever context reported it', async () => {
    ownWorkspaceBy(ORG_A);
    select(ORG_A);
    const service = await startService();
    service.recordUserActivity('proj-1', 'wt-1', '2026-09-22T10:00:00.000Z');
    await drainQueuedTurns();
    select(null);
    service.recordUserActivity('proj-1', 'wt-1', '2026-09-22T11:00:00.000Z');
    await drainQueuedTurns();
    await service.flushAll();

    expect(destinations()).toEqual([`organization:${ORG_A}`]);
    expect(lastRequest().workspace.worktrees?.[0]?.userActiveAt).toBe(
      '2026-09-22T11:00:00.000Z',
    );
  });

  it('does not retarget org-owned work to another membership after the member leaves the owner', async () => {
    ownWorkspaceBy(ORG_A);
    select(ORG_B);
    const service = await startService();
    emitTurn();
    await drainQueuedTurns();
    getCanopyCloudCredentialsMock.mockResolvedValue({
      baseUrl: 'https://cloud.example',
      apiKey: 'key',
      capabilities: [],
      teams: [],
      organizations: [{ id: ORG_B }],
    });
    await service.flushAll();
    expect(allRequests()).toEqual([]);
    expect(service.getStatus().pendingCount).toBe(1);
  });

  it.each(['flush', 'delete'] as const)(
    'drains org-owned work captured across contexts to its owner on worktree %s',
    async (operation) => {
      ownWorkspaceBy(ORG_A);
      select(ORG_A);
      const service = await startService();
      emitTurn(makeEntry({ id: 'owner-context' }));
      await drainQueuedTurns();
      select(null);
      emitTurn(makeEntry({ id: 'personal-context' }));
      await drainQueuedTurns();
      if (operation === 'delete') {
        await service.drainWorktreeForDeletion('proj-1', 'wt-1');
      } else {
        await service.flushWorktreeNow('proj-1', 'wt-1');
      }
      expect(destinations()).toEqual([`organization:${ORG_A}`]);
      expect(service.getStatus().pendingCount).toBe(0);
      const attempts = allRequests().length;
      await jest.advanceTimersByTimeAsync(TELEMETRY_SYNC_DEBOUNCE_MS);
      expect(allRequests()).toHaveLength(attempts);
    },
  );

  it('keeps the newer private records when an older upload retries after they succeed', async () => {
    readPreferencesFileMock.mockResolvedValue(uniformSharing('private'));
    const stored = new Map<string, TelemetryWorktreePayload>();
    const writes: string[] = [];
    let rejectOlder = true;
    requestCanopyCloudJsonMock.mockImplementation((_path, init) => {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- request produced by the service under test.
      const request: TelemetryIngestRequest = JSON.parse(init.body);
      for (const worktree of request.workspace.worktrees ?? []) {
        if (worktree.branchName === 'older' && rejectOlder) {
          throw new Error('older upload offline');
        }
        stored.set(worktree.clientLocalId, {
          ...stored.get(worktree.clientLocalId),
          ...worktree,
        });
        writes.push(worktree.branchName);
      }
      return Promise.resolve(buildIngestSuccessResponse(init));
    });
    const service = await startService();
    async function enqueueVersion(
      label: string,
      hour: string,
      cost: number,
    ): Promise<void> {
      readWorkspaceWorktreesMock.mockResolvedValue([
        {
          id: 'wt-1',
          branchName: label,
          status: label === 'older' ? 'active' : 'done',
        },
      ]);
      jest.mocked(addPlanContentChangeListener).mock.calls.at(-1)?.[0]({
        id: 'same-plan',
        projectId: 'proj-1',
        worktreeId: 'wt-1',
        source: 'claude',
        title: label,
        content: label,
        reviewStatus: 'pending',
        createdAt: '2026-09-22T00:00:00.000Z',
        updatedAt: '2026-09-22T00:00:00.000Z',
        latestRevisionNumber: 1,
        revisions: [],
        linkedExecutionIds: [],
      });
      emitTurn(makeEntry({ totalCostUsd: cost }));
      jest
        .mocked(addWorktreeSummaryChangeListener)
        .mock.calls.at(-1)?.[0]({
          projectId: 'proj-1',
          worktreeId: 'wt-1',
          summary: {
            title: label,
            description: label,
            highlights: [],
            generatedAt: `2026-09-22T${hour}:00:00.000Z`,
            turnCountAtGeneration: 1,
            lastFullRefreshAt: `2026-09-22T${hour}:00:00.000Z`,
            lastFullRefreshTurnCount: 1,
          },
          snapshotId: label,
          isNewSnapshot: true,
        });
      service.recordUserActivity(
        'proj-1',
        'wt-1',
        `2026-09-22T${hour}:00:00.000Z`,
      );
      await drainQueuedTurns();
    }
    await enqueueVersion('older', '10', 0.1);
    await service.flushAll();
    expect(stored.size).toBe(0);
    expect(service.getStatus().lastError).toBe('upload-failed');

    select(ORG_B);
    await enqueueVersion('newer', '11', 0.2);
    await service.flushAll();
    function expectNewerRecords(): void {
      const worktree = stored.get('wt-1');
      expect(worktree).toMatchObject({
        branchName: 'newer',
        status: 'done',
        userActiveAt: '2026-09-22T11:00:00.000Z',
      });
      expect(worktree?.summary).toContain('newer');
      expect(worktree?.plans).toMatchObject([
        { clientPlanId: 'same-plan', title: 'newer', body: 'newer' },
      ]);
      expect(
        worktree?.turns?.find((turn) => turn.clientTurnId === 'turn-1')
          ?.totalCostUsd,
      ).toBe(0.2);
    }

    expectNewerRecords();
    rejectOlder = false;
    await jest.advanceTimersByTimeAsync(TELEMETRY_SYNC_DEBOUNCE_MS);
    await service.flushAll();
    expectNewerRecords();
    expect(writes).toEqual(['newer']);
    expect(service.getStatus().pendingCount).toBe(0);
  });

  it('retries a Personal private upload when a legacy org row owns the bare id', async () => {
    select(null);
    let callCount = 0;
    requestCanopyCloudJsonMock.mockImplementation(
      (_path: string, init: { body: string }) => {
        callCount += 1;
        if (callCount === 1) {
          throw new MockCanopyCloudClientError(
            'http-error',
            'Telemetry record owner scope cannot change on re-sync',
            409,
            TELEMETRY_OWNER_SCOPE_CONFLICT_CODE,
          );
        }
        return Promise.resolve(buildIngestSuccessResponse(init));
      },
    );
    const service = await startService();
    emitTurn();
    await drainQueuedTurns();
    await service.flushAll();

    expect(allRequests()).toHaveLength(2);
    expect(allRequests()[0]).toMatchObject({ shareScope: 'private' });
    expect(allRequests()[1]).toMatchObject({ shareScope: 'private' });
    expect(allRequests()[1]?.workspace.clientLocalId).not.toBe(
      allRequests()[0]?.workspace.clientLocalId,
    );
    expect(allRequests()[1]?.workspace.worktrees?.[0]?.clientLocalId).not.toBe(
      allRequests()[0]?.workspace.worktrees?.[0]?.clientLocalId,
    );
    // The exact ids the server recomputes to find these Personal rows
    // (CAN-3601): `${baseId}-${sha256('private-owner-conflict-v1')[0..16]}`.
    const variantSuffix = createHash('sha256')
      .update('private-owner-conflict-v1', 'utf8')
      .digest('hex')
      .slice(0, 16);
    expect(allRequests()[1]?.workspace.clientLocalId).toBe(
      `${allRequests()[0]?.workspace.clientLocalId}-${variantSuffix}`,
    );
    expect(allRequests()[1]?.workspace.worktrees?.[0]?.clientLocalId).toBe(
      `${allRequests()[0]?.workspace.worktrees?.[0]?.clientLocalId}-${variantSuffix}`,
    );
    expect(service.getStatus().pendingCount).toBe(0);
    expect(lastSyncMapWrite()).toMatchObject({
      workspaces: {
        'proj-1': {
          worktrees: {
            'wt-1': {
              targets: {
                private: {
                  clientIdVariant: 'private-owner-conflict-v1',
                },
              },
            },
          },
        },
      },
    });

    readPreferencesFileMock.mockResolvedValue(uniformSharing('private'));
    await service.refreshScopeFromPreferences();
    emitTurn(makeEntry({ id: 'after-fallback' }));
    await drainQueuedTurns();
    await service.flushAll();

    expect(allRequests()).toHaveLength(3);
    expect(allRequests()[2]?.workspace.clientLocalId).toBe(
      allRequests()[1]?.workspace.clientLocalId,
    );
    expect(allRequests()[2]?.workspace.worktrees?.[0]?.clientLocalId).toBe(
      allRequests()[1]?.workspace.worktrees?.[0]?.clientLocalId,
    );
  });

  it('does not apply the private-id fallback to another kind of 409', async () => {
    select(null);
    requestCanopyCloudJsonMock.mockRejectedValueOnce(
      new MockCanopyCloudClientError(
        'http-error',
        'Telemetry workspace is already bound to another source project',
        409,
        'source-project-conflict',
      ),
    );
    const service = await startService();
    emitTurn();
    await drainQueuedTurns();
    await service.flushAll();

    expect(requestCanopyCloudJsonMock).toHaveBeenCalledTimes(1);
    expect(service.getStatus().pendingCount).toBe(0);
    expect(lastSyncMapWrite()).toBeNull();
  });
});

describe('TelemetrySyncService scope mapping', () => {
  // Organization delivery requires org-owned work (CAN-3515); the selected
  // context from the suite default no longer matters.
  beforeEach(() => {
    ownWorkspaceBy('org-1');
  });

  it('resolves only the team id for team scope (server rejects organizationId here)', async () => {
    readPreferencesFileMock.mockResolvedValue(uniformSharing('team'));
    await startService();

    emitTurn();
    await tick();
    await jest.advanceTimersByTimeAsync(TELEMETRY_SYNC_DEBOUNCE_MS);

    const request = lastRequest();
    expect(request.shareScope).toBe('team');
    expect(request.teamId).toBe('team-1');
    expect(request.organizationId).toBeUndefined();
  });

  it('resolves organization id for organization scope', async () => {
    readPreferencesFileMock.mockResolvedValue({
      ...uniformSharing('organization'),
    });
    await startService();

    emitTurn();
    await tick();
    await jest.advanceTimersByTimeAsync(TELEMETRY_SYNC_DEBOUNCE_MS);

    const request = lastRequest();
    expect(request.shareScope).toBe('organization');
    expect(request.organizationId).toBe('org-1');
    expect(request.teamId).toBeUndefined();
  });

  describe('tracked-source target filtering (CAN-2948)', (): void => {
    const OWNER = {
      type: 'organization' as const,
      organizationId: 'org-1',
      projectId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      instanceId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      bindingGeneration: 1,
    };

    beforeEach((): void => {
      getCanopyCloudCredentialsMock.mockResolvedValue({
        baseUrl: 'https://cloud.example',
        apiKey: 'key',
        capabilities: [],
        teams: [
          { id: 'team-a', organization: { id: 'org-1' } },
          { id: 'team-b', organization: { id: 'org-2' } },
        ],
        organizations: [{ id: 'org-1' }, { id: 'org-2' }],
      });
    });

    it.each(['organization', 'team'] as const)(
      'delivers private and owner %s targets with provenance, never another organization',
      async (scope): Promise<void> => {
        readWorkspaceConfigDetailedMock.mockResolvedValue({
          config: { ...personalConfig, owner: OWNER },
          authority: 'ok',
          ownerMalformed: false,
        });
        readPreferencesFileMock.mockResolvedValue({
          telemetrySharing: {
            metadata: 'private',
            transcripts: 'private',
            plans: scope,
            summaries: 'private',
          },
        });
        const service = await startService();
        emitTurn();
        jest.mocked(addPlanContentChangeListener).mock.calls.at(-1)?.[0]({
          id: 'owner-plan',
          projectId: 'proj-1',
          worktreeId: 'wt-1',
          source: 'claude',
          title: 'Owner plan',
          content: 'Plan content',
          reviewStatus: 'pending',
          createdAt: '2026-09-22T00:00:00.000Z',
          updatedAt: '2026-09-22T00:00:00.000Z',
          latestRevisionNumber: 1,
          revisions: [],
          linkedExecutionIds: [],
        });
        await drainQueuedTurns();
        await service.flushAll();

        expect(allRequests()).toHaveLength(2);
        expect(allRequests()).toEqual([
          expect.objectContaining({ shareScope: 'private' }),
          expect.objectContaining(
            scope === 'organization'
              ? { shareScope: scope, organizationId: 'org-1' }
              : { shareScope: scope, teamId: 'team-a' },
          ),
        ]);
        for (const request of allRequests()) {
          expect(request.workspace).toMatchObject({
            sourceProjectId: OWNER.projectId,
            sourceOrganizationId: OWNER.organizationId,
          });
        }
        expect(recordSessionDiagnosticMock).not.toHaveBeenCalled();
        expect(service.getStatus().pendingCount).toBe(0);
      },
    );

    it('attributes a bound default Chats Cowork workspace to its organization definition', async (): Promise<void> => {
      readWorkspaceIndexEntryMock.mockResolvedValue({
        id: 'cowork-org-org-1',
        name: 'Chats',
        type: 'cowork',
      });
      readWorkspaceConfigDetailedMock.mockResolvedValue({
        config: { version: 1, type: 'cowork', repos: [], owner: OWNER },
        authority: 'ok',
        ownerMalformed: false,
      });
      readPreferencesFileMock.mockResolvedValue(uniformSharing('organization'));
      const service = await startService();

      emitTurn();
      await drainQueuedTurns();
      await service.flushAll();

      expect(lastRequest()).toMatchObject({
        shareScope: 'organization',
        organizationId: OWNER.organizationId,
        workspace: {
          workspaceType: 'cowork',
          sourceProjectId: OWNER.projectId,
          sourceOrganizationId: OWNER.organizationId,
        },
      });
    });

    it.each(['organization', 'team'] as const)(
      'delivers owner %s targets even when another organization is selected',
      async (scope): Promise<void> => {
        readWorkspaceConfigDetailedMock.mockResolvedValue({
          config: { ...personalConfig, owner: OWNER },
          authority: 'ok',
          ownerMalformed: false,
        });
        getWorkspaceContextStateMock.mockReturnValue({
          context: { kind: 'organization', organizationId: 'org-2' },
        });
        readPreferencesFileMock.mockResolvedValue(uniformSharing(scope));
        const service = await startService();
        emitTurn();
        await drainQueuedTurns();
        await service.flushAll();
        expect(allRequests()).toEqual([
          expect.objectContaining(
            scope === 'organization'
              ? { shareScope: scope, organizationId: 'org-1' }
              : { shareScope: scope, teamId: 'team-a' },
          ),
        ]);
        expect(recordSessionDiagnosticMock).not.toHaveBeenCalled();
        expect(service.getStatus().pendingCount).toBe(0);
      },
    );

    it.each(['organization', 'team'] as const)(
      'delivers owner %s targets for work captured while Personal was selected',
      async (scope): Promise<void> => {
        readWorkspaceConfigDetailedMock.mockResolvedValue({
          config: { ...personalConfig, owner: OWNER },
          authority: 'ok',
          ownerMalformed: false,
        });
        readPreferencesFileMock.mockResolvedValue(uniformSharing(scope));
        getWorkspaceContextStateMock.mockReturnValue({
          context: { kind: 'personal' },
        });
        const service = await startService();
        emitTurn();
        await drainQueuedTurns();
        await service.flushAll();
        expect(allRequests()).toHaveLength(1);
        expect(lastRequest()).toMatchObject(
          scope === 'organization'
            ? { shareScope: scope, organizationId: 'org-1' }
            : { shareScope: scope, teamId: 'team-a' },
        );
        expect(lastRequest().workspace).toMatchObject({
          sourceProjectId: OWNER.projectId,
          sourceOrganizationId: OWNER.organizationId,
        });
        expect(recordSessionDiagnosticMock).not.toHaveBeenCalled();
        expect(service.getStatus().pendingCount).toBe(0);
      },
    );

    it('drops a shared-container anchor that names another organization terminally, even signed out', async (): Promise<void> => {
      readWorkspaceConfigDetailedMock.mockResolvedValue({
        config: { ...personalConfig, owner: OWNER },
        authority: 'ok',
        ownerMalformed: false,
      });
      getCanopyCloudCredentialsMock.mockRejectedValue(new Error('signed out'));
      readPreferencesFileMock.mockResolvedValue(uniformSharing('organization'));
      const service = await startService();
      await service.refreshWorktreeMetadata('proj-1', 'wt-1', 'org-2');
      await service.flushAll();

      expect(allRequests()).toHaveLength(0);
      expect(recordSessionDiagnosticMock).toHaveBeenCalledWith(
        expect.objectContaining({ kind: 'telemetry_target_dropped_cross_org' }),
      );
      await jest.advanceTimersByTimeAsync(60_000);
      expect(allRequests()).toHaveLength(0);
    });

    it.each(['reject', 'unreadable', 'absent'] as const)(
      'drops every target and records a diagnostic when workspace ownership cannot be read (%s)',
      async (failure): Promise<void> => {
        if (failure === 'reject') {
          readWorkspaceConfigDetailedMock.mockRejectedValue(
            new Error('read failed'),
          );
        } else {
          // Malformed JSON/config is reported by persistence as unreadable.
          readWorkspaceConfigDetailedMock.mockResolvedValue({
            config: personalConfig,
            authority: failure,
            ownerMalformed: false,
          });
        }
        readPreferencesFileMock.mockResolvedValue(
          uniformSharing('organization'),
        );
        const service = await startService();
        emitTurn();
        await tick();
        await jest.advanceTimersByTimeAsync(TELEMETRY_SYNC_DEBOUNCE_MS);

        expect(allRequests()).toHaveLength(0);
        expect(service.getStatus().pendingCount).toBe(0);
        await service.dispose();
        readPreferencesFileMock.mockResolvedValue(uniformSharing('private'));
        const privateService = await startService();
        emitTurn();
        await tick();
        await jest.advanceTimersByTimeAsync(TELEMETRY_SYNC_DEBOUNCE_MS);
        expect(allRequests()).toHaveLength(0);
        expect(recordSessionDiagnosticMock).not.toHaveBeenCalled();
        expect(service.getStatus().pendingCount).toBe(0);
        expect(privateService.getStatus().pendingCount).toBe(0);
        await jest.advanceTimersByTimeAsync(60_000);
        expect(allRequests()).toHaveLength(0);
      },
    );

    it.each<'organization' | 'team'>(['organization', 'team'])(
      'drops every target and records unknown ownership for a malformed owner (%s)',
      async (scope): Promise<void> => {
        readWorkspaceConfigDetailedMock.mockResolvedValue({
          config: personalConfig,
          authority: 'ok',
          ownerMalformed: true,
        });
        readPreferencesFileMock.mockResolvedValue(uniformSharing(scope));
        const service = await startService();
        emitTurn();
        await tick();
        await jest.advanceTimersByTimeAsync(TELEMETRY_SYNC_DEBOUNCE_MS);

        expect(allRequests()).toHaveLength(0);
        expect(service.getStatus().pendingCount).toBe(0);
        await service.dispose();
        readPreferencesFileMock.mockResolvedValue(uniformSharing('private'));
        const privateService = await startService();
        emitTurn();
        await tick();
        await jest.advanceTimersByTimeAsync(TELEMETRY_SYNC_DEBOUNCE_MS);
        expect(allRequests()).toHaveLength(0);
        expect(recordSessionDiagnosticMock).not.toHaveBeenCalled();
        expect(service.getStatus().pendingCount).toBe(0);
        expect(privateService.getStatus().pendingCount).toBe(0);
        await jest.advanceTimersByTimeAsync(60_000);
        expect(allRequests()).toHaveLength(0);
      },
    );

    // The bound cross-organization case is only reachable through an explicit
    // shared-container anchor now; see the anchor test above.
    it.each([['unknown', personalConfig, true]] as const)(
      'drops an ownership-excluded group terminally even when scope targets cannot be resolved (%s)',
      async (_label, config, ownerMalformed): Promise<void> => {
        readWorkspaceConfigDetailedMock.mockResolvedValue({
          config,
          authority: 'ok',
          ownerMalformed,
        });
        // Signed out / offline: credentials cannot be read, so scope resolution
        // is unavailable. Ownership policy must still drop the group instead of
        // leaving organization telemetry queued until the account comes back.
        getCanopyCloudCredentialsMock.mockRejectedValue(
          new Error('signed out'),
        );
        readPreferencesFileMock.mockResolvedValue(
          uniformSharing('organization'),
        );
        const service = await startService();
        emitTurn();
        await tick();
        await jest.advanceTimersByTimeAsync(TELEMETRY_SYNC_DEBOUNCE_MS);

        expect(allRequests()).toHaveLength(0);
        expect(service.getStatus().pendingCount).toBe(0);
        expect(recordSessionDiagnosticMock).not.toHaveBeenCalled();
        await jest.advanceTimersByTimeAsync(60_000);
        expect(allRequests()).toHaveLength(0);
        expect(service.getStatus().pendingCount).toBe(0);
      },
    );

    it('delivers an authoritatively Personal checkout only privately, whatever is selected', async (): Promise<void> => {
      ownWorkspaceBy(null);
      readPreferencesFileMock.mockResolvedValue(uniformSharing('organization'));
      await startService();
      emitTurn();
      await tick();
      await jest.advanceTimersByTimeAsync(TELEMETRY_SYNC_DEBOUNCE_MS);

      expect(
        allRequests().map((request): string => request.shareScope ?? ''),
      ).toEqual(['private']);
      for (const request of allRequests()) {
        expect(request.workspace.sourceProjectId).toBeUndefined();
        expect(request.workspace.sourceOrganizationId).toBeUndefined();
      }
      expect(recordSessionDiagnosticMock).not.toHaveBeenCalled();
    });

    it('treats the tracked-source-organization-target refusal as terminal', async (): Promise<void> => {
      readPreferencesFileMock.mockResolvedValue(uniformSharing('organization'));
      requestCanopyCloudJsonMock.mockImplementation(
        (_path, options): Promise<TelemetryIngestResponse> => {
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- parsing the test transport request.
          const request: TelemetryIngestRequest = JSON.parse(options.body);
          if (request.organizationId === 'org-1') {
            throw new MockCanopyCloudClientError(
              'http-error',
              'Organization project activity can only be uploaded to private scope',
              403,
              'tracked-source-organization-target',
            );
          }
          return Promise.resolve(buildIngestSuccessResponse(options));
        },
      );
      const service = await startService();
      emitTurn();
      await tick();
      await jest.advanceTimersByTimeAsync(TELEMETRY_SYNC_DEBOUNCE_MS);

      expect(
        allRequests().map(
          (request): string | undefined => request.organizationId,
        ),
      ).toEqual(['org-1']);
      expect(service.getStatus().pendingCount).toBe(0);
      expect(recordAppDiagnosticMock).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: 'telemetry_upload_failed',
          telemetryUploadStatus: 403,
          reason: 'tracked-source-organization-target',
        }),
      );
      expect(reprobeEnforcedSettingsMock).not.toHaveBeenCalled();
      await jest.advanceTimersByTimeAsync(60_000);
      expect(allRequests()).toHaveLength(1);
    });
  });

  it('keeps distinct server identities for private rows and each shared-container anchor', async () => {
    ownWorkspaceBy(null);
    readPreferencesFileMock.mockResolvedValue(uniformSharing('organization'));
    getCanopyCloudCredentialsMock.mockResolvedValue({
      baseUrl: 'https://cloud.example',
      apiKey: 'key',
      capabilities: [],
      teams: [],
      organizations: [{ id: 'org-1' }, { id: 'org-2' }],
    });
    const service = await startService();

    emitTurn();
    await drainQueuedTurns();
    await service.refreshWorktreeMetadata('proj-1', 'wt-1', 'org-1');
    await service.refreshWorktreeMetadata('proj-1', 'wt-1', 'org-2');
    await service.flushAll();

    // Personal work lands privately; each anchor registers its own envelope.
    expect(
      allRequests().map((request) => request.organizationId ?? 'private'),
    ).toEqual(['private', 'org-1', 'org-2']);
    const wsIds = new Set<string>();
    const wtIds = new Set<string>();
    const sourceWtIds = new Set<string>();
    for (const request of allRequests()) {
      wsIds.add(request.workspace.clientLocalId);
      const worktree = request.workspace.worktrees?.[0];
      if (worktree !== undefined) wtIds.add(worktree.clientLocalId);
      if (worktree?.sourceClientLocalId !== undefined)
        sourceWtIds.add(worktree.sourceClientLocalId);
      if (request.shareScope === 'organization') {
        expect(worktree?.turns).toBeUndefined();
      }
    }
    // Each owner gets its OWN namespaced workspace/worktree clientLocalId so the
    // server keys them as distinct rows instead of 409-ing on the second org.
    expect(wsIds.size).toBe(3);
    expect(wtIds.size).toBe(3);
    // Policy identity remains producer-global even though storage identity is
    // namespaced for each owner replica.
    expect(sourceWtIds.size).toBe(1);
  });

  // -------------------------------------------------------------------------
  // Per-org billing gate (CAN-2311). A lapsed org is dropped from the owner
  // scope fan-out, and ONLY that org — this must never become an account-wide
  // switch that silently stops every upload.
  // -------------------------------------------------------------------------
  it('ignores an unrelated lapsed organization when the owning organization is healthy', async () => {
    ownWorkspaceBy('org-healthy');
    readPreferencesFileMock.mockResolvedValue(uniformSharing('organization'));
    getCanopyCloudCredentialsMock.mockResolvedValue({
      baseUrl: 'https://cloud.example',
      apiKey: 'key',
      capabilities: [],
      teams: [],
      organizations: [{ id: 'org-lapsed' }, { id: 'org-healthy' }],
    });
    loadStoredOrgBillingStatesMock.mockResolvedValue([
      {
        organizationId: 'org-lapsed',
        organizationName: 'Lapsed Co',
        teamsEntitled: false,
      },
      {
        organizationId: 'org-healthy',
        organizationName: 'Healthy Co',
        teamsEntitled: true,
      },
    ]);
    await startService();

    emitTurn();
    await tick();
    await jest.advanceTimersByTimeAsync(TELEMETRY_SYNC_DEBOUNCE_MS);

    expect(requestCanopyCloudJsonMock).toHaveBeenCalledTimes(1);
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- parsing a request body this test produced.
    const request: TelemetryIngestRequest = JSON.parse(
      requestCanopyCloudJsonMock.mock.calls[0][1].body,
    );
    expect(request.organizationId).toBe('org-healthy');
  });

  it('gates a team target by its OWNING org, leaving other teams syncing', async () => {
    readPreferencesFileMock.mockResolvedValue(uniformSharing('team'));
    getCanopyCloudCredentialsMock.mockResolvedValue({
      baseUrl: 'https://cloud.example',
      apiKey: 'key',
      capabilities: [],
      teams: [
        { id: 'team-lapsed', organization: { id: 'org-lapsed' } },
        { id: 'team-healthy', organization: { id: 'org-healthy' } },
      ],
      organizations: [],
    });
    loadStoredOrgBillingStatesMock.mockResolvedValue([
      {
        organizationId: 'org-lapsed',
        organizationName: 'Lapsed Co',
        teamsEntitled: false,
      },
    ]);
    await startService();

    ownWorkspaceBy('org-lapsed');
    emitTurn();
    await tick();
    await jest.advanceTimersByTimeAsync(TELEMETRY_SYNC_DEBOUNCE_MS);
    expect(requestCanopyCloudJsonMock).not.toHaveBeenCalled();
    expect(reprobeEnforcedSettingsMock).toHaveBeenCalled();

    ownWorkspaceBy('org-healthy');
    emitTurn();
    await tick();
    await jest.advanceTimersByTimeAsync(TELEMETRY_SYNC_DEBOUNCE_MS);

    expect(requestCanopyCloudJsonMock).toHaveBeenCalledTimes(1);
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- parsing a request body this test produced.
    const request: TelemetryIngestRequest = JSON.parse(
      requestCanopyCloudJsonMock.mock.calls[0][1].body,
    );
    expect(request.teamId).toBe('team-healthy');
  });

  it('drops an all-lapsed scope only after a probe that CONFIRMS the lapse', async () => {
    ownWorkspaceBy('org-lapsed');
    // CAN-2311. The lapse verdict comes from the persisted snapshot, refreshed
    // only every ~20 minutes, so deleting off it would unrecoverably destroy
    // telemetry for a window in which the org had already paid.
    readPreferencesFileMock.mockResolvedValue(uniformSharing('organization'));
    getCanopyCloudCredentialsMock.mockResolvedValue({
      baseUrl: 'https://cloud.example',
      apiKey: 'key',
      capabilities: [],
      teams: [],
      organizations: [{ id: 'org-lapsed' }],
    });
    loadStoredOrgBillingStatesMock.mockResolvedValue([
      {
        organizationId: 'org-lapsed',
        organizationName: 'Lapsed Co',
        teamsEntitled: false,
      },
    ]);
    const service = await startService();

    emitTurn();
    await tick();
    await jest.advanceTimersByTimeAsync(TELEMETRY_SYNC_DEBOUNCE_MS);
    await tick();

    // Probe ran, confirmed the lapse against a refreshed snapshot, and only
    // then dropped. Nothing was uploaded.
    expect(reprobeEnforcedSettingsMock).toHaveBeenCalled();
    expect(requestCanopyCloudJsonMock).not.toHaveBeenCalled();
    expect(service.getStatus().pendingCount).toBe(0);

    await service.dispose();
  });

  it('KEEPS the data when the probe could not refresh billing state', async () => {
    ownWorkspaceBy('org-lapsed');
    // The critical case: "attempted a probe" is not confirmation. The probe
    // no-ops (leaving `orgBillingStates` untouched) with no API key, when it
    // throws because the client is offline, when the response is
    // unauthenticated, and when the response omits the field. Deleting in any
    // of those is deletion off the same stale snapshot.
    readPreferencesFileMock.mockResolvedValue(uniformSharing('organization'));
    getCanopyCloudCredentialsMock.mockResolvedValue({
      baseUrl: 'https://cloud.example',
      apiKey: 'key',
      capabilities: [],
      teams: [],
      organizations: [{ id: 'org-lapsed' }],
    });
    loadStoredOrgBillingStatesMock.mockResolvedValue([
      {
        organizationId: 'org-lapsed',
        organizationName: 'Lapsed Co',
        teamsEntitled: false,
      },
    ]);
    reprobeEnforcedSettingsMock.mockResolvedValue(false);
    const service = await startService();

    emitTurn();
    await tick();
    await jest.advanceTimersByTimeAsync(TELEMETRY_SYNC_DEBOUNCE_MS);
    await tick();

    expect(service.getStatus().pendingCount).toBeGreaterThan(0);

    // Still refuses to delete on a later flush while the probe keeps failing:
    // an unconfirmable lapse defers indefinitely rather than degrading into a
    // delete.
    await jest.advanceTimersByTimeAsync(TELEMETRY_SYNC_DEBOUNCE_MS);
    await tick();
    expect(service.getStatus().pendingCount).toBeGreaterThan(0);

    await service.dispose();
  });

  it('confirms the owning organization lapse even with a healthy unrelated membership', async () => {
    ownWorkspaceBy('org-lapsed');
    // Work owned by the lapsed org must not fall through to the unrelated
    // healthy membership. Deletion still needs a freshly confirmed billing snapshot.
    readPreferencesFileMock.mockResolvedValue(uniformSharing('organization'));
    getCanopyCloudCredentialsMock.mockResolvedValue({
      baseUrl: 'https://cloud.example',
      apiKey: 'key',
      capabilities: [],
      teams: [],
      organizations: [{ id: 'org-lapsed' }, { id: 'org-healthy' }],
    });
    loadStoredOrgBillingStatesMock.mockResolvedValue([
      {
        organizationId: 'org-lapsed',
        organizationName: 'Lapsed Co',
        teamsEntitled: false,
      },
      {
        organizationId: 'org-healthy',
        organizationName: 'Healthy Co',
        teamsEntitled: true,
      },
    ]);
    // The probe cannot refresh, so the lapse is unconfirmable.
    reprobeEnforcedSettingsMock.mockResolvedValue(false);
    const service = await startService();

    emitTurn();
    await tick();
    await jest.advanceTimersByTimeAsync(TELEMETRY_SYNC_DEBOUNCE_MS);
    await tick();

    // A confirmation was attempted for the owning organization...
    expect(reprobeEnforcedSettingsMock).toHaveBeenCalled();
    // ...and because it failed, nothing was delivered and nothing was dropped.
    // The unrelated healthy organization receives nothing.
    expect(requestCanopyCloudJsonMock).not.toHaveBeenCalled();
    expect(service.getStatus().pendingCount).toBeGreaterThan(0);

    await service.dispose();
  });

  it('delivers to the healthy owning organization without confirming an unrelated lapse', async () => {
    ownWorkspaceBy('org-healthy');
    readPreferencesFileMock.mockResolvedValue(uniformSharing('organization'));
    getCanopyCloudCredentialsMock.mockResolvedValue({
      baseUrl: 'https://cloud.example',
      apiKey: 'key',
      capabilities: [],
      teams: [],
      organizations: [{ id: 'org-lapsed' }, { id: 'org-healthy' }],
    });
    loadStoredOrgBillingStatesMock.mockResolvedValue([
      {
        organizationId: 'org-lapsed',
        organizationName: 'Lapsed Co',
        teamsEntitled: false,
      },
      {
        organizationId: 'org-healthy',
        organizationName: 'Healthy Co',
        teamsEntitled: true,
      },
    ]);
    reprobeEnforcedSettingsMock.mockResolvedValue(true);
    const service = await startService();

    emitTurn();
    await tick();
    await jest.advanceTimersByTimeAsync(TELEMETRY_SYNC_DEBOUNCE_MS);
    await tick();

    // The healthy owning organization receives its data; an unrelated
    // lapse does not trigger a confirmation or affect delivery.
    expect(reprobeEnforcedSettingsMock).not.toHaveBeenCalled();
    expect(requestCanopyCloudJsonMock).toHaveBeenCalledTimes(1);
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- parsing a request body this test produced.
    const request: TelemetryIngestRequest = JSON.parse(
      requestCanopyCloudJsonMock.mock.calls[0][1].body,
    );
    expect(request.organizationId).toBe('org-healthy');

    await service.dispose();
  });

  // The per-flush cache is the guard on an IRREVERSIBLE delete. This pins the
  // SAFETY-CRITICAL direction: hoisting the cache to a per-service field —
  // restoring exactly the cross-flush memoization that let a renewal between
  // flushes still lose data — otherwise passes the whole suite.
  //
  // The opposite direction (one probe per flush, SHARED across that flush's
  // groups) is deliberately not asserted here: driving two scopes through a
  // single flush needs summary-listener plumbing this describe does not have,
  // and a test that cannot fail is worse than none. That direction is a cost
  // property, not a correctness one — over-probing is wasteful, never unsafe.
  it('re-confirms on EVERY flush, so deletion authority never outlives one flush', async () => {
    ownWorkspaceBy('org-lapsed');
    // A cached `true` proves the account was refreshed recently, not that its
    // lapse verdict is still current — an org renewing between flushes would
    // otherwise have newly queued telemetry deleted off the stale verdict.
    readPreferencesFileMock.mockResolvedValue(uniformSharing('organization'));
    getCanopyCloudCredentialsMock.mockResolvedValue({
      baseUrl: 'https://cloud.example',
      apiKey: 'key',
      capabilities: [],
      teams: [],
      organizations: [{ id: 'org-lapsed' }],
    });
    loadStoredOrgBillingStatesMock.mockResolvedValue([
      {
        organizationId: 'org-lapsed',
        organizationName: 'Lapsed Co',
        teamsEntitled: false,
      },
    ]);
    reprobeEnforcedSettingsMock.mockResolvedValue(true);
    const service = await startService();

    emitTurn();
    await tick();
    await jest.advanceTimersByTimeAsync(TELEMETRY_SYNC_DEBOUNCE_MS);
    await tick();
    expect(reprobeEnforcedSettingsMock).toHaveBeenCalledTimes(1);

    // A second flush must earn its own confirmation.
    emitTurn();
    await tick();
    await jest.advanceTimersByTimeAsync(TELEMETRY_SYNC_DEBOUNCE_MS);
    await tick();
    expect(reprobeEnforcedSettingsMock).toHaveBeenCalledTimes(2);

    await service.dispose();
  });

  it('does not credit an in-flight confirmation to a DIFFERENT account', async () => {
    ownWorkspaceBy('org-lapsed');
    // The confirmation promise is shared and the service is a process-lifetime
    // singleton that survives sign-out, so a probe started for account A can
    // resolve after account B is signed in. Crediting that answer to B would
    // authorize an irreversible delete off B's own (possibly stale) snapshot —
    // the exact loss this confirmation path exists to prevent.
    readPreferencesFileMock.mockResolvedValue(uniformSharing('organization'));
    getCanopyCloudCredentialsMock.mockResolvedValue({
      baseUrl: 'https://cloud.example',
      apiKey: 'key-account-a',
      capabilities: [],
      teams: [],
      organizations: [{ id: 'org-lapsed' }],
    });
    loadStoredOrgBillingStatesMock.mockResolvedValue([
      {
        organizationId: 'org-lapsed',
        organizationName: 'Lapsed Co',
        teamsEntitled: false,
      },
    ]);
    // The probe succeeds, but the signed-in account is swapped out while it is
    // still outstanding.
    reprobeEnforcedSettingsMock.mockImplementation(() => {
      getCanopyCloudCredentialsMock.mockResolvedValue({
        baseUrl: 'https://cloud.example',
        apiKey: 'key-account-b',
        capabilities: [],
        teams: [],
        organizations: [{ id: 'org-lapsed' }],
      });
      return Promise.resolve(true);
    });
    const service = await startService();

    emitTurn();
    await tick();
    await jest.advanceTimersByTimeAsync(TELEMETRY_SYNC_DEBOUNCE_MS);
    await tick();

    // The probe ran and returned `true`, but for the wrong account — so the
    // group is DEFERRED rather than dropped.
    expect(reprobeEnforcedSettingsMock).toHaveBeenCalled();
    expect(service.getStatus().pendingCount).toBeGreaterThan(0);

    await service.dispose();
  });

  it('does not drop when the refreshed snapshot shows the org actually paid', async () => {
    // The case the confirmation exists for: the snapshot was stale, the org is
    // entitled, and the queued data must survive and upload.
    readPreferencesFileMock.mockResolvedValue(uniformSharing('organization'));
    getCanopyCloudCredentialsMock.mockResolvedValue({
      baseUrl: 'https://cloud.example',
      apiKey: 'key',
      capabilities: [],
      teams: [],
      organizations: [{ id: 'org-1' }],
    });
    loadStoredOrgBillingStatesMock.mockResolvedValue([
      {
        organizationId: 'org-1',
        organizationName: 'Acme',
        teamsEntitled: false,
      },
    ]);
    // The probe refreshes the snapshot: the org is entitled after all. The
    // verdict is re-resolved against the REFRESHED snapshot, not the stale one
    // that reached the branch.
    reprobeEnforcedSettingsMock.mockImplementation(() => {
      loadStoredOrgBillingStatesMock.mockResolvedValue([
        {
          organizationId: 'org-1',
          organizationName: 'Acme',
          teamsEntitled: true,
        },
      ]);
      return Promise.resolve(true);
    });
    const service = await startService();

    emitTurn();
    await tick();
    await jest.advanceTimersByTimeAsync(TELEMETRY_SYNC_DEBOUNCE_MS);
    await tick();

    // Uploaded, not deleted, and in the SAME flush -- no deferral needed.
    expect(requestCanopyCloudJsonMock).toHaveBeenCalled();
    expect(service.getStatus().pendingCount).toBe(0);

    await service.dispose();
  });

  it('skips a target permanently on a 409 owner-scope conflict without looping', async () => {
    readPreferencesFileMock.mockResolvedValue(uniformSharing('organization'));
    getCanopyCloudCredentialsMock.mockResolvedValue({
      baseUrl: 'https://cloud.example',
      apiKey: 'key',
      capabilities: [],
      teams: [],
      organizations: [{ id: 'org-1' }, { id: 'org-2' }],
    });
    // The owning organization hits a terminal 409 conflict.
    let callCount = 0;
    requestCanopyCloudJsonMock.mockImplementation(
      (_path: string, init: { body: string }) => {
        callCount += 1;
        if (callCount === 1) {
          throw new MockCanopyCloudClientError(
            'http-error',
            'Telemetry record owner scope cannot change on re-sync',
            409,
          );
        }
        return Promise.resolve(buildIngestSuccessResponse(init));
      },
    );
    const service = await startService();

    emitTurn();
    await tick();
    await jest.advanceTimersByTimeAsync(TELEMETRY_SYNC_DEBOUNCE_MS);
    await tick();

    // A diagnostic was recorded for the conflict, the conflicting target is
    // skipped, and the group drains — no re-queue or unrelated delivery.
    expect(recordAppDiagnosticMock).toHaveBeenCalledTimes(1);
    expect(recordAppDiagnosticMock.mock.calls[0][0]).toMatchObject({
      kind: 'telemetry_upload_failed',
      telemetryUploadStatus: 409,
    });
    expect(service.getStatus().pendingCount).toBe(0);

    // The next window does NOT retry the 409 target (nothing left queued).
    await jest.advanceTimersByTimeAsync(TELEMETRY_SYNC_DEBOUNCE_MS);
    expect(requestCanopyCloudJsonMock).toHaveBeenCalledTimes(1);
  });

  it('retries only the failed route after a partial failure', async () => {
    ownWorkspaceBy(null);
    readPreferencesFileMock.mockResolvedValue(uniformSharing('organization'));
    // The private route succeeds; the shared-container anchor fails
    // transiently in the same flush. Retries fall back to success.
    let callCount = 0;
    requestCanopyCloudJsonMock.mockImplementation(
      (_path: string, init: { body: string }) => {
        callCount += 1;
        if (callCount === 2) {
          throw new MockCanopyCloudClientError(
            'http-error',
            'server error',
            500,
          );
        }
        return Promise.resolve(buildIngestSuccessResponse(init));
      },
    );
    const service = await startService();

    emitTurn();
    await drainQueuedTurns();
    await service.refreshWorktreeMetadata('proj-1', 'wt-1', 'org-1');
    await jest.advanceTimersByTimeAsync(TELEMETRY_SYNC_DEBOUNCE_MS);

    expect(
      allRequests().map((request) => request.organizationId ?? 'private'),
    ).toEqual(['private', 'org-1']);
    expect(service.getStatus().lastError).toBe('upload-failed');

    // Next window retries only the failed anchor.
    await jest.advanceTimersByTimeAsync(TELEMETRY_SYNC_DEBOUNCE_MS);
    await tick();
    expect(
      allRequests().map((request) => request.organizationId ?? 'private'),
    ).toEqual(['private', 'org-1', 'org-1']);
    expect(service.getStatus().lastError).toBeNull();
  });

  it('delivers legacy team scope only within the owning organization', async () => {
    readPreferencesFileMock.mockResolvedValue(uniformSharing('team'));
    getCanopyCloudCredentialsMock.mockResolvedValue({
      baseUrl: 'https://cloud.example',
      apiKey: 'key',
      capabilities: [],
      teams: [
        { id: 'team-1', organization: { id: 'org-1' } },
        { id: 'team-2', organization: { id: 'org-1' } },
        { id: 'unrelated-team', organization: { id: 'org-2' } },
      ],
      organizations: [],
    });
    await startService();

    emitTurn();
    await tick();
    await jest.advanceTimersByTimeAsync(TELEMETRY_SYNC_DEBOUNCE_MS);

    // One ingest request per associated team, each carrying only teamId (never
    // organizationId) and the full turn body (each team is a first-time target).
    expect(requestCanopyCloudJsonMock).toHaveBeenCalledTimes(2);
    const teamIds = requestCanopyCloudJsonMock.mock.calls.map((call) => {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- parsing a request body this test produced.
      const request: TelemetryIngestRequest = JSON.parse(call[1].body);
      expect(request.shareScope).toBe('team');
      expect(request.organizationId).toBeUndefined();
      expect(request.workspace.worktrees?.[0]?.turns?.[0]?.body).toBeDefined();
      return request.teamId;
    });
    expect(teamIds.sort()).toEqual(['team-1', 'team-2']);
  });

  it('keeps items queued when team cannot be resolved', async () => {
    readPreferencesFileMock.mockResolvedValue(uniformSharing('team'));
    getCanopyCloudCredentialsMock.mockResolvedValue({
      baseUrl: 'https://cloud.example',
      apiKey: 'key',
      capabilities: [],
      teams: [],
      organizations: [],
    });
    await startService();

    emitTurn();
    await tick();
    await jest.advanceTimersByTimeAsync(TELEMETRY_SYNC_DEBOUNCE_MS);

    expect(requestCanopyCloudJsonMock).not.toHaveBeenCalled();
  });
});

describe('TelemetrySyncService amend', () => {
  it('drops an unchanged body on re-send via the sync-map round trip', async () => {
    const service = await startService();

    emitTurn();
    await tick();
    await jest.advanceTimersByTimeAsync(TELEMETRY_SYNC_DEBOUNCE_MS);
    expect(requestCanopyCloudJsonMock).toHaveBeenCalledTimes(1);
    expect(
      lastRequest().workspace.worktrees?.[0]?.turns?.[0]?.body,
    ).toBeDefined();

    // Re-emit the identical turn — same content hash should short-circuit body.
    emitTurn();
    await tick();
    await jest.advanceTimersByTimeAsync(TELEMETRY_SYNC_DEBOUNCE_MS);

    expect(requestCanopyCloudJsonMock).toHaveBeenCalledTimes(2);
    const turn = lastRequest().workspace.worktrees?.[0]?.turns?.[0];
    expect(turn?.clientTurnId).toBe('turn-1');
    expect(turn?.body).toBeUndefined();
    expect(turn?.contentHash).toBeDefined();

    await service.dispose();
  });
});

describe('TelemetrySyncService teardown flush', () => {
  it('flushWorktreeNow drains immediately, bypassing the debounce', async () => {
    const service = await startService();

    emitTurn();
    await tick();
    expect(requestCanopyCloudJsonMock).not.toHaveBeenCalled();

    await service.flushWorktreeNow('proj-1', 'wt-1');
    expect(requestCanopyCloudJsonMock).toHaveBeenCalledTimes(1);
  });

  it('drainWorktreeForDeletion flushes then clears the worktree', async () => {
    const service = await startService();

    emitTurn();
    await tick();

    await service.drainWorktreeForDeletion('proj-1', 'wt-1');
    expect(requestCanopyCloudJsonMock).toHaveBeenCalledTimes(1);

    // Nothing left to send.
    requestCanopyCloudJsonMock.mockClear();
    await service.flushAll();
    expect(requestCanopyCloudJsonMock).not.toHaveBeenCalled();
  });

  it('dispose unregisters every change listener it added', async () => {
    const service = await startService();

    await service.dispose();

    expect(removePlanContentChangeListener).toHaveBeenCalledTimes(1);
    expect(removePlanShareChangeListener).toHaveBeenCalledTimes(1);
    expect(removeWorktreeSummaryChangeListener).toHaveBeenCalledTimes(1);
    expect(removeWorktreePrStatusChangeListener).toHaveBeenCalledTimes(1);
  });
});

describe('TelemetrySyncService free-text redaction', () => {
  it('redacts secrets out of the project name and branch name', async () => {
    readWorkspaceIndexEntryMock.mockResolvedValue({
      id: 'proj-1',
      name: 'workspace token=supersecretvalue123',
      type: 'single-repo',
    });
    readWorkspaceWorktreesMock.mockResolvedValue([
      {
        id: 'wt-1',
        branchName: 'fix/AKIAIOSFODNN7EXAMPLE',
        status: 'active',
        createdAt: '2026-06-15T00:00:00.000Z',
      },
    ]);
    await startService();

    emitTurn();
    await tick();
    await jest.advanceTimersByTimeAsync(TELEMETRY_SYNC_DEBOUNCE_MS);

    const request = lastRequest();
    expect(request.workspace.name).not.toContain('supersecretvalue123');
    const branchName = request.workspace.worktrees?.[0]?.branchName;
    expect(branchName).toBeDefined();
    expect(branchName).not.toContain('AKIAIOSFODNN7EXAMPLE');
  });
});

// ---------------------------------------------------------------------------
// Status surface (renderer sidebar account menu cloud-sync row)
// ---------------------------------------------------------------------------

function lastSyncMapWrite(): TelemetrySyncMapFileShape | null {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- jest mock call records this test produced.
  const calls: unknown[][] = writeFileMock.mock.calls;
  const mapWrites = calls.filter(
    (call) => call[0] === '/tmp/telemetry/sync-map.json',
  );
  if (mapWrites.length === 0) {
    return null;
  }
  const body = mapWrites[mapWrites.length - 1][1];
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- parsing the sync-map this service itself wrote.
  const parsed: TelemetrySyncMapFileShape = JSON.parse(String(body));
  return parsed;
}

interface TelemetrySyncMapFileShape {
  version: number;
  workspaces: Record<string, unknown>;
  lastSyncedAt?: string;
  lastErrorAt?: string;
  lastError?: 'upload-failed';
}

describe('TelemetrySyncService status surface', () => {
  it('derives pendingCount from queued content', async () => {
    const service = await startService();

    emitTurn();
    await tick();

    // Before the debounce fires nothing has uploaded, so the turn is pending.
    expect(service.getStatus().pendingCount).toBe(1);
    expect(service.getStatus().sharingActive).toBe(true);
  });

  it('emits the current snapshot immediately on subscribe', async () => {
    const service = await startService();
    const seen: TelemetrySyncStatus[] = [];

    service.subscribeStatus((status) => {
      seen.push(status);
    });

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      isSyncing: false,
      pendingCount: 0,
      sharingActive: true,
      lastError: null,
    });
  });

  it('emits an updated snapshot when content is enqueued', async () => {
    const service = await startService();
    const seen: TelemetrySyncStatus[] = [];
    service.subscribeStatus((status) => {
      seen.push(status);
    });
    const initialEmits = seen.length;

    emitTurn();
    await tick();

    expect(seen.length).toBeGreaterThan(initialEmits);
    expect(seen[seen.length - 1].pendingCount).toBe(1);
  });

  it('reports isSyncing true during a flush and false after it commits', async () => {
    // Hold the upload open so we can observe the in-flight transition.
    let resolveUpload: (value: TelemetryIngestResponse) => void = () => {
      // overwritten synchronously below
    };
    const uploadResponse: TelemetryIngestResponse = {
      workspace: {
        clientLocalId: 'proj-1',
        externalId: 'ws-ext',
        worktrees: [
          {
            clientLocalId: 'wt-1',
            externalId: 'wt-ext',
            turns: [{ clientTurnId: 'turn-1', externalId: 'turn-ext-turn-1' }],
            plans: [],
            pullRequests: [],
            pipelineRuns: [],
          },
        ],
      },
    };
    requestCanopyCloudJsonMock.mockReturnValue(
      new Promise<TelemetryIngestResponse>((resolve) => {
        resolveUpload = resolve;
      }),
    );

    const service = await startService();
    const seen: TelemetrySyncStatus[] = [];
    service.subscribeStatus((status) => {
      seen.push(status);
    });

    emitTurn();
    await tick();
    await jest.advanceTimersByTimeAsync(TELEMETRY_SYNC_DEBOUNCE_MS);

    // Upload is in flight (still awaiting the held promise).
    expect(service.getStatus().isSyncing).toBe(true);

    resolveUpload(uploadResponse);
    await tick();
    await tick();

    expect(service.getStatus().isSyncing).toBe(false);
    expect(seen.some((status) => status.isSyncing)).toBe(true);
  });

  it('sets lastSyncedAt on a successful flush and persists it for restart', async () => {
    const service = await startService();

    emitTurn();
    await tick();
    await jest.advanceTimersByTimeAsync(TELEMETRY_SYNC_DEBOUNCE_MS);
    await tick();

    const status = service.getStatus();
    expect(status.lastSyncedAt).not.toBeNull();
    expect(status.lastError).toBeNull();

    const persisted = lastSyncMapWrite();
    expect(persisted?.lastSyncedAt).toBe(status.lastSyncedAt);

    // Simulate a restart: a fresh service hydrates lastSyncedAt from the map.
    const enoent = Object.assign(new Error('not found'), { code: 'ENOENT' });
    readFileMock.mockImplementation((filePath: string) => {
      if (filePath === '/tmp/telemetry/sync-map.json') {
        return Promise.resolve(
          JSON.stringify({
            version: 2,
            workspaces: {},
            lastSyncedAt: status.lastSyncedAt,
          }),
        );
      }
      return Promise.reject(enoent);
    });
    const restarted = await startService();
    expect(restarted.getStatus().lastSyncedAt).toBe(status.lastSyncedAt);
  });

  it('ignores invalid persisted lastError values', async () => {
    const enoent = Object.assign(new Error('not found'), { code: 'ENOENT' });
    readFileMock.mockImplementation((filePath: string) => {
      if (filePath === '/tmp/telemetry/sync-map.json') {
        return Promise.resolve(
          JSON.stringify({
            version: 2,
            workspaces: {},
            lastErrorAt: '2026-06-16T00:00:00.000Z',
            lastError: 'unexpected-error',
          }),
        );
      }
      return Promise.reject(enoent);
    });

    const service = await startService();

    expect(service.getStatus().lastError).toBeNull();
    expect(service.getStatus().lastErrorAt).toBeNull();
  });

  it('sets lastError on upload failure and clears it on the next success', async () => {
    requestCanopyCloudJsonMock.mockImplementationOnce(() => {
      throw new Error('network down');
    });
    const service = await startService();

    emitTurn();
    await tick();
    await jest.advanceTimersByTimeAsync(TELEMETRY_SYNC_DEBOUNCE_MS);
    await tick();

    const failed = service.getStatus();
    expect(failed.lastError).toBe('upload-failed');
    expect(failed.lastErrorAt).not.toBeNull();
    expect(failed.pendingCount).toBeGreaterThan(0);

    // The failed group was re-armed; the retry succeeds with the default mock.
    await jest.advanceTimersByTimeAsync(TELEMETRY_SYNC_DEBOUNCE_MS);
    await tick();

    const recovered = service.getStatus();
    expect(recovered.lastError).toBeNull();
    expect(recovered.lastErrorAt).toBeNull();
    expect(recovered.lastSyncedAt).not.toBeNull();
  });

  it('keeps lastError when one scope fails before another scope succeeds in the same flush', async () => {
    ownWorkspaceBy('org-1');
    readPreferencesFileMock.mockResolvedValue({
      telemetrySharing: {
        metadata: 'private',
        transcripts: 'private',
        plans: 'team',
        summaries: 'private',
      },
    });
    const queuedWorktree = {
      version: 2,
      selectedOrganizationId: 'org-1',
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
          startedAt: '2026-06-16T00:00:00.000Z',
          body: 'queued body',
        },
      ],
      plans: [
        {
          clientPlanId: 'queued-plan',
          title: 'Queued plan',
          reviewStatus: 'approved',
          planVersion: 1,
          planTextBytes: 11,
          planLineCount: 1,
          body: 'queued plan',
        },
      ],
      pullRequests: [],
    };
    const enoent = Object.assign(new Error('not found'), { code: 'ENOENT' });
    readFileMock.mockImplementation((filePath: string) => {
      if (filePath === '/tmp/telemetry/queue.jsonl') {
        return Promise.resolve(`${JSON.stringify(queuedWorktree)}\n`);
      }
      return Promise.reject(enoent);
    });
    requestCanopyCloudJsonMock.mockImplementationOnce(() => {
      throw new Error('network down');
    });

    const service = await startService();

    await jest.advanceTimersByTimeAsync(TELEMETRY_SYNC_DEBOUNCE_MS);

    expect(requestCanopyCloudJsonMock).toHaveBeenCalledTimes(2);
    expect(service.getStatus().lastError).toBe('upload-failed');
    expect(service.getStatus().lastErrorAt).not.toBeNull();
    expect(service.getStatus().lastSyncedAt).not.toBeNull();
    expect(service.getStatus().pendingCount).toBe(1);
  });
});

describe('TelemetrySyncService summary history snapshots', () => {
  type SummaryListener = (event: {
    projectId: string;
    worktreeId: string;
    summary: WorktreeSummaryData;
    snapshotId: string;
    isNewSnapshot: boolean;
  }) => void;

  function summaryListener(): SummaryListener {
    const calls = jest.mocked(addWorktreeSummaryChangeListener).mock.calls;
    if (calls.length === 0) {
      throw new Error('summary change listener was not registered');
    }
    return calls[calls.length - 1][0];
  }

  function makeSummaryData(
    overrides: Partial<WorktreeSummaryData> = {},
  ): WorktreeSummaryData {
    return {
      title: 'Summary title',
      description: 'Did some work',
      highlights: ['One'],
      generatedAt: '2026-06-16T00:00:00.000Z',
      turnCountAtGeneration: 3,
      lastFullRefreshAt: '2026-06-16T00:00:00.000Z',
      lastFullRefreshTurnCount: 3,
      ...overrides,
    };
  }

  it('enqueues a new snapshot and includes it in the ingest request', async () => {
    await startService();
    summaryListener()({
      projectId: 'proj-1',
      worktreeId: 'wt-1',
      summary: makeSummaryData(),
      snapshotId: 'snap-1',
      isNewSnapshot: true,
    });
    await tick();
    await jest.advanceTimersByTimeAsync(TELEMETRY_SYNC_DEBOUNCE_MS);
    await tick();

    const wt = lastRequest().workspace.worktrees?.[0];
    expect(wt?.summary).toBeDefined();
    expect(wt?.summaries).toHaveLength(1);
    expect(wt?.summaries?.[0]?.clientSnapshotId).toBe('snap-1');
    expect(wt?.summaries?.[0]?.generatedAt).toBe('2026-06-16T00:00:00.000Z');
    // Summary provenance (the helper's details) stays on the device.
    expect(JSON.stringify(lastRequest())).not.toContain('provenance');
  });

  it('drops an undeliverable recap when metadata is off so the queue cannot grow forever', async () => {
    // The recap's INGRESS gate is `summaries`, but DELIVERY needs `metadata` to
    // resolve a scope for the worktree envelope it rides on. So `metadata: off`
    // with `summaries: private` enqueues recaps that can never be sent — a
    // pairing the Privacy tab allows directly, and that an org prohibiting
    // `metadata` but not `summaries` produces on its own.
    //
    // Without the undeliverable-recap drop, nothing ever clears these: each
    // change appends another entry to `summarySnapshots`, the queue file is
    // rewritten larger every time, and the Cloud-sync pending count climbs and
    // never drains for the life of the install.
    readPreferencesFileMock.mockResolvedValue({
      telemetrySharing: {
        transcripts: 'off',
        plans: 'off',
        metadata: 'off',
        summaries: 'private',
      },
    });
    const service = await startService();

    for (const snapshotId of ['snap-1', 'snap-2', 'snap-3']) {
      summaryListener()({
        projectId: 'proj-1',
        worktreeId: 'wt-1',
        summary: makeSummaryData(),
        snapshotId,
        isNewSnapshot: true,
      });
      await tick();
      await jest.advanceTimersByTimeAsync(TELEMETRY_SYNC_DEBOUNCE_MS);
      await tick();
    }

    // Nothing was uploadable, so nothing should still be held.
    expect(service.getStatus().pendingCount).toBe(0);
  });

  it('refreshes only the latest pointer when the snapshot is unchanged', async () => {
    await startService();
    summaryListener()({
      projectId: 'proj-1',
      worktreeId: 'wt-1',
      summary: makeSummaryData(),
      snapshotId: 'snap-1',
      isNewSnapshot: false,
    });
    await tick();
    await jest.advanceTimersByTimeAsync(TELEMETRY_SYNC_DEBOUNCE_MS);
    await tick();

    const wt = lastRequest().workspace.worktrees?.[0];
    expect(wt?.summary).toBeDefined();
    expect(wt?.summaries).toBeUndefined();
  });

  it('does not re-send a snapshot already recorded in the sync map', async () => {
    await startService();
    const listener = summaryListener();
    listener({
      projectId: 'proj-1',
      worktreeId: 'wt-1',
      summary: makeSummaryData(),
      snapshotId: 'snap-1',
      isNewSnapshot: true,
    });
    await tick();
    await jest.advanceTimersByTimeAsync(TELEMETRY_SYNC_DEBOUNCE_MS);
    await tick();
    expect(requestCanopyCloudJsonMock).toHaveBeenCalledTimes(1);
    expect(lastRequest().workspace.worktrees?.[0]?.summaries).toHaveLength(1);

    // Re-emit the SAME snapshot id (idempotency): it was already delivered, so
    // the next flush carries the latest pointer but no summary snapshots.
    listener({
      projectId: 'proj-1',
      worktreeId: 'wt-1',
      summary: makeSummaryData({ generatedAt: '2026-06-16T01:00:00.000Z' }),
      snapshotId: 'snap-1',
      isNewSnapshot: true,
    });
    await tick();
    await jest.advanceTimersByTimeAsync(TELEMETRY_SYNC_DEBOUNCE_MS);
    await tick();

    expect(requestCanopyCloudJsonMock).toHaveBeenCalledTimes(2);
    expect(lastRequest().workspace.worktrees?.[0]?.summaries).toBeUndefined();
  });
});

describe('TelemetrySyncService.ingestSessionForShare (CAN-395)', () => {
  it('maps a server-side scope-prohibited 403 to the typed refusal instead of a generic failure', async () => {
    // The local pre-check reads the CACHED policy, which lags the server by up
    // to one re-probe interval. An admin who prohibits a scope inside that
    // window leaves the server's 403 as the only place the refusal appears —
    // and letting it propagate would surface "Failed to share session." while
    // never refreshing the stale policy, so every retry failed identically.
    readPreferencesFileMock.mockResolvedValue(uniformSharing('private'));
    loadHistoryMock.mockResolvedValue({
      entries: [
        makeEntry({
          id: 'turn-1',
          chatId: 'chat-1',
          status: 'success',
          hasTranscript: true,
        }),
      ],
      nextCursor: undefined,
    });
    requestCanopyCloudJsonMock.mockImplementation(() => {
      throw new MockCanopyCloudClientError(
        'http-error',
        'Your organization prohibits sharing transcripts',
        403,
        'telemetry_scope_prohibited',
        'transcripts',
      );
    });

    const service = await startService();
    const result = await service.ingestSessionForShare(
      'proj-1',
      'wt-1',
      'chat-1',
    );

    // Typed refusal, with the scope taken from the SERVER's own body rather
    // than a re-read of the local snapshot that just proved itself stale.
    expect(result).toMatchObject({
      status: 'blocked-by-org-policy',
      scope: 'transcripts',
    });
  });

  it('still propagates a non-prohibition upload failure', async () => {
    // Only the scope-prohibited 403 is translated; everything else must keep
    // surfacing as a real error so a transient failure is not misreported as an
    // org policy block.
    readPreferencesFileMock.mockResolvedValue(uniformSharing('private'));
    loadHistoryMock.mockResolvedValue({
      entries: [
        makeEntry({
          id: 'turn-1',
          chatId: 'chat-1',
          status: 'success',
          hasTranscript: true,
        }),
      ],
      nextCursor: undefined,
    });
    requestCanopyCloudJsonMock.mockImplementation(() => {
      throw new MockCanopyCloudClientError('http-error', 'boom', 500);
    });

    const service = await startService();
    await expect(
      service.ingestSessionForShare('proj-1', 'wt-1', 'chat-1'),
    ).rejects.toThrow('boom');
  });

  it('ingests a finished chat on demand even when ambient sharing is Off, at USER/private scope, and redacts free text', async () => {
    // Ambient sync fully Off — the explicit share must still ingest.
    readPreferencesFileMock.mockResolvedValue(uniformSharing('off'));
    loadHistoryMock.mockResolvedValue({
      entries: [
        makeEntry({
          id: 'turn-1',
          chatId: 'chat-1',
          status: 'success',
          hasTranscript: true,
        }),
      ],
      nextCursor: undefined,
    });
    // Transcript body carries a GitHub PAT that must be scrubbed before upload.
    loadTranscriptMock.mockResolvedValue({
      type: 'success',
      lines: ['token ghp_abcdefghijklmnopqrstuvwxyz0123456789'],
      truncation: {},
      injectedPrompts: [],
    });

    const service = await startService();
    const result = await service.ingestSessionForShare(
      'proj-1',
      'wt-1',
      'chat-1',
    );

    // The ambient gate never fired an upload; the explicit ingest is the only
    // request.
    expect(requestCanopyCloudJsonMock).toHaveBeenCalledTimes(1);

    const request = lastRequest();
    // Corpus rows land at USER/private owner scope — never derived from prefs.
    expect(request.shareScope).toBe('private');
    // Written under a dedicated, collision-proof share namespace (not the bare
    // id), and the returned ids match exactly what was written so the grant can
    // reference those rows.
    const wsClientLocalId = request.workspace.clientLocalId;
    const wtClientLocalId = request.workspace.worktrees?.[0]?.clientLocalId;
    expect(wsClientLocalId).toMatch(/^proj-1-.+/);
    expect(wtClientLocalId).toMatch(/^wt-1-.+/);
    expect(result).toEqual({
      status: 'ok',
      workspaceLocalId: wsClientLocalId,
      worktreeLocalId: wtClientLocalId,
    });

    const body = request.workspace.worktrees?.[0]?.turns?.[0]?.body ?? '';
    expect(body).toContain('<redacted-token>');
    expect(body).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz0123456789');

    await service.dispose();
  });

  it('byte-aware splits a >100-turn, large-body session into multiple sub-budget POSTs', async () => {
    readPreferencesFileMock.mockResolvedValue(uniformSharing('off'));
    // 130 finished turns for chat-1, each with a ~100 KiB transcript body. The
    // first 100 turns alone (10+ MiB) exceed the 8 MiB client chunk target, so
    // the split is driven by the BYTE budget, not the 100-turn count cap.
    const entries = Array.from({ length: 130 }, (_unused, index) =>
      makeEntry({
        id: `share-turn-${index + 1}`,
        chatId: 'chat-1',
        status: 'success',
        hasTranscript: true,
      }),
    );
    loadHistoryMock.mockResolvedValue({ entries, nextCursor: undefined });
    const largeBody = 'x'.repeat(100 * 1024);
    loadTranscriptMock.mockResolvedValue({
      type: 'success',
      lines: [largeBody],
      truncation: {},
      injectedPrompts: [],
    });

    const service = await startService();
    const result = await service.ingestSessionForShare(
      'proj-1',
      'wt-1',
      'chat-1',
    );
    expect(result.status).toBe('ok');

    const requests = allRequests();
    // Multiple pieces, and every POST is under the client chunk budget.
    expect(requests.length).toBeGreaterThan(1);
    for (const request of requests) {
      expect(
        Buffer.byteLength(JSON.stringify(request), 'utf8'),
      ).toBeLessThanOrEqual(MAX_TELEMETRY_INGEST_BATCH_BYTES);
    }

    // Byte-driven, not count-driven: the first piece seals below the 100-turn
    // cap because the byte budget filled first.
    expect(turnsForCall(0).length).toBeLessThan(100);

    // Every finished turn is uploaded exactly once, order preserved, no dups.
    const uploadedIds = requests.flatMap((request) =>
      (request.workspace.worktrees?.[0]?.turns ?? []).map(
        (turn) => turn.clientTurnId,
      ),
    );
    const expectedIds = entries.map((entry) => entry.id);
    expect(new Set(uploadedIds).size).toBe(uploadedIds.length);
    expect(new Set(uploadedIds)).toEqual(new Set(expectedIds));

    await service.dispose();
  });

  it('returns a typed no-activity refusal when the chat has no finished (non-running) turns', async () => {
    readPreferencesFileMock.mockResolvedValue(uniformSharing('off'));
    loadHistoryMock.mockResolvedValue({
      entries: [
        makeEntry({ id: 'turn-1', chatId: 'chat-1', status: 'running' }),
        makeEntry({ id: 'turn-2', chatId: 'other-chat', status: 'success' }),
      ],
      nextCursor: undefined,
    });

    const service = await startService();
    const worktreeRef = await service.ingestSessionForShare(
      'proj-1',
      'wt-1',
      'chat-1',
    );

    expect(worktreeRef).toEqual({ status: 'no-activity' });
    expect(requestCanopyCloudJsonMock).not.toHaveBeenCalled();

    await service.dispose();
  });
});

// ---------------------------------------------------------------------------
// Cowork Work Entry metadata (Impact delivery track prerequisites)
// ---------------------------------------------------------------------------

describe('TelemetrySyncService cowork work-entry metadata', () => {
  const coworkWorkspace = {
    id: 'proj-1',
    name: 'Support',
    type: 'cowork' as const,
  };

  it('resolves branchName/status/createdAt from work-entries.json for a cowork entry', async () => {
    readWorkspaceIndexEntryMock.mockResolvedValue(coworkWorkspace);
    // The entry is absent from worktrees.json — that file only holds git
    // worktrees.
    readWorkspaceWorktreesMock.mockResolvedValue([]);
    readWorkEntriesFileMock.mockResolvedValue({
      version: 1,
      entries: [
        {
          id: 'wt-1',
          title: 'SUP-412 Refund flow',
          createdAt: '2026-06-14T00:00:00.000Z',
          status: 'done',
        },
      ],
    });

    await startService();
    emitTurn();
    await tick();
    await jest.advanceTimersByTimeAsync(TELEMETRY_SYNC_DEBOUNCE_MS);

    const worktree = lastRequest().workspace.worktrees?.[0];
    expect(worktree).toMatchObject({
      branchName: 'SUP-412 Refund flow',
      status: 'done',
      clientCreatedAt: '2026-06-14T00:00:00.000Z',
    });
  });

  it('falls back to the entry id when the registry has no rename override', async () => {
    readWorkspaceIndexEntryMock.mockResolvedValue(coworkWorkspace);
    readWorkspaceWorktreesMock.mockResolvedValue([]);
    readWorkEntriesFileMock.mockResolvedValue({
      version: 1,
      entries: [{ id: 'wt-1', createdAt: '2026-06-14T00:00:00.000Z' }],
    });

    await startService();
    emitTurn();
    await tick();
    await jest.advanceTimersByTimeAsync(TELEMETRY_SYNC_DEBOUNCE_MS);

    const worktree = lastRequest().workspace.worktrees?.[0];
    expect(worktree?.branchName).toBe('wt-1');
    expect(worktree?.status).toBeUndefined();
  });

  it('redacts and clamps the registry title like every other free-text field', async () => {
    readWorkspaceIndexEntryMock.mockResolvedValue(coworkWorkspace);
    readWorkspaceWorktreesMock.mockResolvedValue([]);
    readWorkEntriesFileMock.mockResolvedValue({
      version: 1,
      entries: [
        {
          id: 'wt-1',
          title: 'refunds AKIAIOSFODNN7EXAMPLE',
          createdAt: '2026-06-14T00:00:00.000Z',
        },
      ],
    });

    await startService();
    emitTurn();
    await tick();
    await jest.advanceTimersByTimeAsync(TELEMETRY_SYNC_DEBOUNCE_MS);

    const branchName = lastRequest().workspace.worktrees?.[0]?.branchName;
    expect(branchName).toBeDefined();
    expect(branchName).not.toContain('AKIAIOSFODNN7EXAMPLE');
  });

  it('never reads work-entries.json for a non-cowork project', async () => {
    // Default index entry is `single-repo` and wt-1 resolves from
    // worktrees.json, so the registry read must not be attempted.
    await startService();
    emitTurn();
    await tick();
    await jest.advanceTimersByTimeAsync(TELEMETRY_SYNC_DEBOUNCE_MS);

    expect(readWorkEntriesFileMock).not.toHaveBeenCalled();
    expect(lastRequest().workspace.worktrees?.[0]?.branchName).toBe(
      'feature/telemetry',
    );
  });

  it('prefers worktrees.json when a cowork id resolves there', async () => {
    readWorkspaceIndexEntryMock.mockResolvedValue(coworkWorkspace);
    await startService();
    emitTurn();
    await tick();
    await jest.advanceTimersByTimeAsync(TELEMETRY_SYNC_DEBOUNCE_MS);

    expect(readWorkEntriesFileMock).not.toHaveBeenCalled();
    expect(lastRequest().workspace.worktrees?.[0]?.branchName).toBe(
      'feature/telemetry',
    );
  });
});

describe('TelemetrySyncService metadata-only refresh', () => {
  const coworkWorkspace = {
    id: 'proj-1',
    name: 'Support',
    type: 'cowork' as const,
  };

  const seedEntry = (
    entry: Record<string, unknown>,
  ): { version: number; entries: Record<string, unknown>[] } => {
    const file = { version: 1, entries: [entry] };
    readWorkspaceIndexEntryMock.mockResolvedValue(coworkWorkspace);
    readWorkspaceWorktreesMock.mockResolvedValue([]);
    readWorkEntriesFileMock.mockResolvedValue(file);
    return file;
  };

  it('uploads a done status with no accompanying turn', async () => {
    // Marking a Work Entry done is the LAST action on it, so nothing else will
    // ever carry the status to the server. Without an envelope-only flush the
    // Impact delivery track's done bonus is unreachable.
    seedEntry({
      id: 'wt-1',
      title: 'SUP-412 Refund flow',
      createdAt: '2026-06-14T00:00:00.000Z',
      status: 'done',
    });
    const service = await startService();

    await service.refreshWorktreeMetadata('proj-1', 'wt-1');
    await tick();
    await jest.advanceTimersByTimeAsync(TELEMETRY_SYNC_DEBOUNCE_MS);

    expect(requestCanopyCloudJsonMock).toHaveBeenCalled();
    const worktree = lastRequest().workspace.worktrees?.[0];
    expect(worktree).toMatchObject({
      branchName: 'SUP-412 Refund flow',
      status: 'done',
    });
    // Envelope-only: no fabricated content rides along with the metadata.
    expect(worktree?.turns ?? []).toHaveLength(0);

    await service.dispose();
  });

  it('uploads a rename with no accompanying turn so the linkage bonus can fire', async () => {
    seedEntry({
      id: 'wt-1',
      title: 'SUP-999 Chargeback triage',
      createdAt: '2026-06-14T00:00:00.000Z',
    });
    const service = await startService();

    await service.refreshWorktreeMetadata('proj-1', 'wt-1');
    await tick();
    await jest.advanceTimersByTimeAsync(TELEMETRY_SYNC_DEBOUNCE_MS);

    expect(lastRequest().workspace.worktrees?.[0]?.branchName).toBe(
      'SUP-999 Chargeback triage',
    );

    await service.dispose();
  });

  it('does not upload anything when metadata sharing is off', async () => {
    seedEntry({ id: 'wt-1', title: 'SUP-1 x', status: 'done' });
    readPreferencesFileMock.mockResolvedValue(uniformSharing('off'));
    const service = await startService();

    await service.refreshWorktreeMetadata('proj-1', 'wt-1');
    await tick();
    await jest.advanceTimersByTimeAsync(TELEMETRY_SYNC_DEBOUNCE_MS);

    expect(requestCanopyCloudJsonMock).not.toHaveBeenCalled();

    await service.dispose();
  });

  it('survives metadata sharing flipping off mid-flight and delivers once it is back on', async () => {
    // Regression: the `groups.size === 0` early-return used to delete the
    // pending entry without consulting `metaDirty`, permanently discarding a
    // queued rename / mark-done. Reachable when metadata sharing goes off after
    // the refresh is queued while another data type stays on, so the
    // whole-service `isOff()` gate does not short-circuit first.
    seedEntry({ id: 'wt-1', title: 'SUP-412 Refund flow', status: 'done' });
    const service = await startService();

    await service.refreshWorktreeMetadata('proj-1', 'wt-1');

    readPreferencesFileMock.mockResolvedValue({
      telemetrySharing: {
        transcripts: 'private',
        plans: 'private',
        metadata: 'off',
        summaries: 'off',
      },
    });
    await service.refreshScopeFromPreferences();
    await tick();
    await jest.advanceTimersByTimeAsync(TELEMETRY_SYNC_DEBOUNCE_MS);

    // Nothing could be uploaded while metadata sharing was off...
    expect(requestCanopyCloudJsonMock).not.toHaveBeenCalled();

    // Disabled metadata must lie dormant, without another debounce or disk write.
    expect(jest.getTimerCount()).toBe(0);
    writeFileMock.mockClear();
    await jest.advanceTimersByTimeAsync(TELEMETRY_SYNC_DEBOUNCE_MS * 3);
    expect(writeFileMock).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);

    // Delivery-time routing is authoritative, so the disabled envelope was
    // dropped rather than retained for a later preference change.
    readPreferencesFileMock.mockResolvedValue(uniformSharing('private'));
    await service.refreshScopeFromPreferences();
    await tick();
    await jest.advanceTimersByTimeAsync(TELEMETRY_SYNC_DEBOUNCE_MS);

    expect(requestCanopyCloudJsonMock).not.toHaveBeenCalled();

    await service.dispose();
  });

  it('waits for queue hydration before writing, so a startup mark-done cannot truncate the durable queue', async () => {
    // `refreshWorktreeMetadata` is reachable from IPC before `start()` finishes.
    // Without the `queueReady` gate it would `ensurePending` + `persistQueue()`
    // against an unhydrated map, rewriting queue.jsonl with only its own entry
    // and destroying the previous session's queued telemetry.
    seedEntry({ id: 'wt-1', title: 'SUP-412 Refund flow', status: 'done' });

    // A previous session left a queued turn on a DIFFERENT worktree.
    const priorLine = JSON.stringify({
      version: 2,
      projectId: 'proj-1',
      worktreeId: 'wt-prior',
      workspaceName: 'Support',
      workspaceType: 'cowork',
      branchName: 'prior work',
      turns: [
        {
          clientTurnId: 'turn-prior',
          startedAt: '2026-06-01T00:00:00.000Z',
          status: 'SUCCESS',
          eventType: 'STANDALONE_CHAT',
        },
      ],
      plans: [],
      pullRequests: [],
      pipelineRuns: [],
      summarySnapshots: [],
    });

    // Hold the queue read open so the refresh lands mid-hydration.
    let releaseQueueRead = (): void => undefined;
    const queueReadGate = new Promise<void>((resolve) => {
      releaseQueueRead = resolve;
    });
    readFileMock.mockImplementation(async (filePath: string) => {
      if (filePath === '/tmp/telemetry/queue.jsonl') {
        await queueReadGate;
        return `${priorLine}\n`;
      }
      const enoent: NodeJS.ErrnoException = new Error('ENOENT');
      enoent.code = 'ENOENT';
      throw enoent;
    });

    const service = new TelemetrySyncService();
    const starting = service.start();
    await tick();

    // Fire the refresh while hydration is still blocked.
    const refreshing = service.refreshWorktreeMetadata('proj-1', 'wt-1');
    await tick();

    const queueWriteBodies = (): string[] => {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- jest mock call records this test produced.
      const calls: unknown[][] = writeFileMock.mock.calls;
      return calls
        .filter((call) => call[0] === '/tmp/telemetry/queue.jsonl')
        .map((call) => String(call[1]));
    };

    // It must NOT have written anything yet — that write would be the truncation.
    expect(queueWriteBodies()).toHaveLength(0);

    releaseQueueRead();
    await starting;
    await refreshing;
    await tick();

    // The prior session's worktree survived hydration. Asserted across all queue
    // writes rather than the last one, because once hydrated it is free to flush
    // and drain normally — the defect being guarded is that it never appears at
    // all, having been overwritten before it was ever read.
    const allWrites = queueWriteBodies();
    expect(allWrites.length).toBeGreaterThan(0);
    expect(allWrites.some((body) => body.includes('wt-prior'))).toBe(true);
    expect(allWrites.some((body) => body.includes('wt-1'))).toBe(true);

    await service.dispose();
  });

  it('refuses to write when hydration failed, rather than persisting a half-read queue', async () => {
    // `queueReady` settles in a `finally` so nothing dangles, which means it
    // also opens on a FAILED hydration. Writing then would drop the queue lines
    // that were never read — the exact loss the gate exists to prevent.
    seedEntry({ id: 'wt-1', title: 'SUP-412 Refund flow', status: 'done' });
    readFileMock.mockImplementation((filePath: string) => {
      if (filePath === '/tmp/telemetry/queue.jsonl') {
        // JSON-valid line whose `turns` is not an array: throws out of `.map`,
        // past loadQueue's per-line JSON.parse guard.
        return Promise.resolve(
          `${JSON.stringify({
            version: 2,
            projectId: 'proj-1',
            worktreeId: 'wt-prior',
            workspaceName: 'Support',
            workspaceType: 'cowork',
            branchName: 'prior',
            turns: 'not-an-array',
          })}\n`,
        );
      }
      const enoent: NodeJS.ErrnoException = new Error('ENOENT');
      enoent.code = 'ENOENT';
      return Promise.reject(enoent);
    });

    const service = new TelemetrySyncService();
    await service.start().catch(() => undefined);

    writeFileMock.mockClear();
    await service.refreshWorktreeMetadata('proj-1', 'wt-1');
    await tick();

    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- jest mock call records this test produced.
    const calls: unknown[][] = writeFileMock.mock.calls;
    expect(
      calls.filter((call) => call[0] === '/tmp/telemetry/queue.jsonl'),
    ).toHaveLength(0);

    await service.dispose();
  });

  it('does not park forever when the service is disposed without ever starting', async () => {
    seedEntry({ id: 'wt-1', title: 'SUP-412 Refund flow', status: 'done' });
    const service = new TelemetrySyncService();

    // Never started, so the hydration gate was never opened by `start()`.
    await service.dispose();

    // Must resolve rather than hang on the unsettled gate.
    await expect(
      service.refreshWorktreeMetadata('proj-1', 'wt-1'),
    ).resolves.toBeUndefined();
  });

  it('stops forcing envelope-only flushes once the refresh is delivered', async () => {
    seedEntry({ id: 'wt-1', title: 'SUP-412 Refund flow', status: 'done' });
    const service = await startService();

    await service.refreshWorktreeMetadata('proj-1', 'wt-1');
    await tick();
    await jest.advanceTimersByTimeAsync(TELEMETRY_SYNC_DEBOUNCE_MS);
    const afterFirst = requestCanopyCloudJsonMock.mock.calls.length;
    expect(afterFirst).toBeGreaterThan(0);

    // A later debounce window must not re-send the same envelope forever.
    await jest.advanceTimersByTimeAsync(TELEMETRY_SYNC_DEBOUNCE_MS * 4);
    expect(requestCanopyCloudJsonMock).toHaveBeenCalledTimes(afterFirst);

    await service.dispose();
  });
});

// ---------------------------------------------------------------------------
// `summaries` scope split + two-way org enforcement (Data sharing).
// ---------------------------------------------------------------------------

describe('TelemetrySyncService summaries scope split', () => {
  type SummaryListener = (event: {
    projectId: string;
    worktreeId: string;
    summary: WorktreeSummaryData;
    snapshotId: string;
    isNewSnapshot: boolean;
  }) => void;

  function summaryListener(): SummaryListener {
    const calls = jest.mocked(addWorktreeSummaryChangeListener).mock.calls;
    return calls[calls.length - 1][0];
  }

  function summaryData(): WorktreeSummaryData {
    return {
      title: 'Summary title',
      description: 'Did some work',
      highlights: ['One'],
      generatedAt: '2026-06-16T00:00:00.000Z',
      turnCountAtGeneration: 3,
      lastFullRefreshAt: '2026-06-16T00:00:00.000Z',
      lastFullRefreshTurnCount: 3,
    };
  }

  function emitSummary(): void {
    summaryListener()({
      projectId: 'proj-1',
      worktreeId: 'wt-1',
      summary: summaryData(),
      snapshotId: 'snap-1',
      isNewSnapshot: true,
    });
  }

  // The ingress gate moved off `metadata` and onto `summaries`. Summaries are
  // AI-written prose derived from the conversation, so leaving them on the
  // counters-and-identifiers `metadata` scope made a transcripts prohibition a
  // false promise.
  it('does NOT enqueue a summary when summaries is off but metadata is on', async () => {
    readPreferencesFileMock.mockResolvedValue({
      telemetrySharing: {
        transcripts: 'private',
        plans: 'private',
        metadata: 'private',
        summaries: 'off',
      },
    });
    const service = await startService();

    emitSummary();
    await tick();
    await jest.advanceTimersByTimeAsync(TELEMETRY_SYNC_DEBOUNCE_MS);
    await tick();

    expect(requestCanopyCloudJsonMock).not.toHaveBeenCalled();

    await service.dispose();
  });

  it('DOES enqueue a summary when summaries is on but metadata is off (gate reads summaries)', async () => {
    readPreferencesFileMock.mockResolvedValue({
      telemetrySharing: {
        transcripts: 'off',
        plans: 'private',
        metadata: 'off',
        summaries: 'private',
      },
    });
    const service = await startService();

    emitSummary();
    await tick();

    // The summary was accepted by the ingress gate (pendingCount moved), even
    // though `metadata` is a hard prerequisite at flush time.
    expect(service.getStatus().pendingCount).toBeGreaterThan(0);

    await service.dispose();
  });

  it('attaches the summary when summaries resolves to the same scope as metadata', async () => {
    readPreferencesFileMock.mockResolvedValue(uniformSharing('private'));
    const service = await startService();

    emitSummary();
    await tick();
    await jest.advanceTimersByTimeAsync(TELEMETRY_SYNC_DEBOUNCE_MS);
    await tick();

    const wt = lastRequest().workspace.worktrees?.[0];
    expect(wt?.summary).toBeDefined();
    expect(wt?.summaries).toHaveLength(1);

    await service.dispose();
  });

  // Mirrors `includeBody`: the recap rides the worktree ENVELOPE, so it can
  // only attach to a worktree row that exists at the same owner scope.
  it('strips the summary when summaries resolves to a DIFFERENT scope than metadata', async () => {
    readPreferencesFileMock.mockResolvedValue({
      telemetrySharing: {
        transcripts: 'off',
        plans: 'off',
        metadata: 'private',
        summaries: 'team',
      },
    });
    const service = await startService();

    emitSummary();
    await tick();
    // A turn keeps the metadata group non-empty so the flush actually uploads.
    emitTurn();
    await tick();
    await jest.advanceTimersByTimeAsync(TELEMETRY_SYNC_DEBOUNCE_MS);
    await tick();

    const requests = allRequests();
    expect(requests.length).toBeGreaterThan(0);
    for (const request of requests) {
      const wt = request.workspace.worktrees?.[0];
      expect(wt?.summary).toBeUndefined();
      expect(wt?.summaries ?? []).toHaveLength(0);
    }

    await service.dispose();
  });

  // The envelope-only refresh path (`metaDirty`) must still deliver a
  // rename/mark-done while summaries are stripped.
  it('still delivers a metaDirty envelope refresh while the summary is stripped', async () => {
    readWorkspaceIndexEntryMock.mockResolvedValue({
      id: 'proj-1',
      name: 'Support',
      type: 'cowork',
    });
    readWorkspaceWorktreesMock.mockResolvedValue([]);
    readWorkEntriesFileMock.mockResolvedValue({
      version: 1,
      entries: [
        {
          id: 'wt-1',
          title: 'SUP-412 Refund flow',
          createdAt: '2026-06-14T00:00:00.000Z',
          status: 'done',
        },
      ],
    });
    readPreferencesFileMock.mockResolvedValue({
      telemetrySharing: {
        transcripts: 'off',
        plans: 'off',
        metadata: 'private',
        summaries: 'team',
      },
    });
    const service = await startService();

    emitSummary();
    await tick();
    await service.refreshWorktreeMetadata('proj-1', 'wt-1');
    await tick();
    await jest.advanceTimersByTimeAsync(TELEMETRY_SYNC_DEBOUNCE_MS);
    await tick();

    const wt = lastRequest().workspace.worktrees?.[0];
    expect(wt).toMatchObject({
      branchName: 'SUP-412 Refund flow',
      status: 'done',
    });
    expect(wt?.summary).toBeUndefined();

    await service.dispose();
  });
});

describe('TelemetrySyncService org-enforced prohibitions', () => {
  it('applies requirements only to the governing organization', async () => {
    governWorkspaceBy(ORG_A);
    loadStoredTelemetryEnforcementByOrganizationMock.mockResolvedValue(
      requiring({ transcripts: true }),
    );
    readPreferencesFileMock.mockResolvedValue(uniformSharing('private'));
    const service = await startService();

    emitTurn();
    await tick();
    await service.flushAll();
    expect(lastRequest()).toMatchObject({
      shareScope: 'organization',
      organizationId: ORG_A,
    });
    expect(lastRequest().workspace.worktrees?.[0]?.turns?.[0]?.body).toBe(
      'hello transcript',
    );

    await service.dispose();

    requestCanopyCloudJsonMock.mockClear();
    governWorkspaceBy(ORG_B);
    const bService = await startService();
    emitTurn(makeEntry({ id: 'turn-b' }));
    await tick();
    await bService.flushAll();
    expect(lastRequest()).toMatchObject({ shareScope: 'private' });
    await bService.dispose();
  });

  it('does not apply a matching org requirement to linked Personal work in any context', async () => {
    const workspaceTarget = await import('../services/workspace-target');
    const targetSpy = jest
      .spyOn(workspaceTarget, 'resolveWorkspaceTarget')
      .mockResolvedValue({
        workspaceOwner: { kind: 'personal' },
        linkedOrganizationIds: [ORG_A],
      });
    getWorkspaceContextStateMock.mockReturnValue({
      context: { kind: 'organization', organizationId: ORG_A },
    });
    getCanopyCloudCredentialsMock.mockResolvedValue({
      baseUrl: 'https://cloud.example',
      apiKey: 'key',
      capabilities: [],
      teams: [],
      organizations: [{ id: ORG_A }],
    });
    readPreferencesFileMock.mockResolvedValue(uniformSharing('private'));
    loadStoredTelemetryEnforcementByOrganizationMock.mockResolvedValue(
      requiring({ transcripts: true }),
    );
    const service = await startService();

    emitTurn(makeEntry({ id: 'linked-org' }));
    await drainQueuedTurns();
    await service.flushAll();
    expect(lastRequest()).toMatchObject({ shareScope: 'private' });
    expect(lastRequest().organizationId).toBeUndefined();

    requestCanopyCloudJsonMock.mockClear();
    getWorkspaceContextStateMock.mockReturnValue({
      context: { kind: 'personal' },
    });
    emitTurn(makeEntry({ id: 'linked-personal' }));
    await drainQueuedTurns();
    await service.flushAll();
    expect(lastRequest()).toMatchObject({ shareScope: 'private' });

    targetSpy.mockRestore();
    await service.dispose();
  });

  it('delivers linked Personal work privately even while enforcement is unavailable', async () => {
    const workspaceTarget = await import('../services/workspace-target');
    const targetSpy = jest
      .spyOn(workspaceTarget, 'resolveWorkspaceTarget')
      .mockResolvedValue({
        workspaceOwner: { kind: 'personal' },
        linkedOrganizationIds: [ORG_A],
      });
    getWorkspaceContextStateMock.mockReturnValue({
      context: { kind: 'organization', organizationId: ORG_A },
    });
    readPreferencesFileMock.mockResolvedValue(uniformSharing('organization'));
    loadStoredTelemetryEnforcementByOrganizationMock.mockRejectedValue(
      new Error('safeStorage unavailable'),
    );
    const service = await startService();

    emitTurn(makeEntry({ id: 'linked-unavailable' }));
    await drainQueuedTurns();
    await service.flushAll();

    // Personal work has no governing organization, so no org policy is
    // needed to send it, and it never reaches an organization.
    expect(allRequests()).toEqual([
      expect.objectContaining({ shareScope: 'private' }),
    ]);
    expect(lastRequest().organizationId).toBeUndefined();
    targetSpy.mockRestore();
    await service.dispose();
  });

  it('does not apply a selected org requirement to unlinked Personal work', async () => {
    readWorkspaceConfigDetailedMock.mockResolvedValue({
      config: { ...personalConfig, type: 'multi-repo' },
      authority: 'ok',
      ownerMalformed: false,
    });
    getWorkspaceContextStateMock.mockReturnValue({
      context: { kind: 'organization', organizationId: ORG_A },
    });
    readPreferencesFileMock.mockResolvedValue(uniformSharing('private'));
    loadStoredTelemetryEnforcementByOrganizationMock.mockResolvedValue(
      requiring({ transcripts: true }),
    );
    const service = await startService();

    emitTurn(makeEntry({ id: 'unlinked-personal' }));
    await drainQueuedTurns();
    await service.flushAll();

    expect(lastRequest()).toMatchObject({ shareScope: 'private' });
    expect(lastRequest().organizationId).toBeUndefined();
    await service.dispose();
  });

  it('uses the bound owner policy rather than the captured context policy', async () => {
    governWorkspaceBy(ORG_A);
    getWorkspaceContextStateMock.mockReturnValue({
      context: { kind: 'organization', organizationId: ORG_B },
    });
    readPreferencesFileMock.mockResolvedValue(uniformSharing('private'));
    loadStoredTelemetryEnforcementByOrganizationMock.mockResolvedValue(
      prohibiting('metadata', 'Blocked B', ORG_B),
    );
    const service = await startService();

    emitTurn(makeEntry({ id: 'owned-by-a-captured-in-b' }));
    await drainQueuedTurns();
    await service.flushAll();

    expect(lastRequest()).toMatchObject({ shareScope: 'private' });
    await service.dispose();
  });

  it('drops bound-owner turns, plans, and PRs even when captured in another org', async () => {
    governWorkspaceBy(ORG_B);
    getWorkspaceContextStateMock.mockReturnValue({
      context: { kind: 'organization', organizationId: ORG_A },
    });
    readPreferencesFileMock.mockResolvedValue(uniformSharing('private'));
    loadStoredTelemetryEnforcementByOrganizationMock.mockResolvedValue(
      prohibiting('metadata', 'Blocked B', ORG_B),
    );
    const service = await startService();

    emitTurn(makeEntry({ id: 'blocked-turn' }));
    jest.mocked(addPlanContentChangeListener).mock.calls.at(-1)?.[0]({
      id: 'blocked-plan',
      projectId: 'proj-1',
      worktreeId: 'wt-1',
      source: 'claude',
      title: 'Blocked plan',
      content: 'Blocked plan',
      reviewStatus: 'pending',
      createdAt: '2026-09-22T00:00:00.000Z',
      updatedAt: '2026-09-22T00:00:00.000Z',
      latestRevisionNumber: 1,
      revisions: [],
      linkedExecutionIds: [],
    });
    await service.enqueueReconciledPullRequests('proj-1', [
      {
        repoId: 'canopy',
        repoName: 'canopy',
        prNumber: 3459,
        prUrl: 'https://github.com/o/canopy/pull/3459',
        title: 'Blocked PR',
        state: 'merged',
        checkStatus: 'none',
        reviewStatus: 'none',
        hasConflicts: false,
        commentCount: 0,
        openedAt: '2026-09-20T00:00:00.000Z',
        mergedAt: '2026-09-22T00:00:00.000Z',
        prUpdatedAt: '2026-09-22T00:00:00.000Z',
      },
    ]);
    await drainQueuedTurns();
    await service.flushAll();

    expect(requestCanopyCloudJsonMock).not.toHaveBeenCalled();
    expect(service.getStatus().pendingCount).toBe(0);
    await service.dispose();
  });

  it('flushes required org work when every user preference is off', async () => {
    governWorkspaceBy(ORG_A);
    readPreferencesFileMock.mockResolvedValue(uniformSharing('off'));
    loadStoredTelemetryEnforcementByOrganizationMock.mockResolvedValue(
      requiring({ metadata: true, transcripts: true }),
    );
    const service = await startService();

    emitTurn();
    await tick();
    await service.flushAll();

    expect(lastRequest()).toMatchObject({
      shareScope: 'organization',
      organizationId: ORG_A,
    });
    await service.dispose();
  });

  it('resumes persisted required org work when every user preference is off', async () => {
    governWorkspaceBy(ORG_A);
    readPreferencesFileMock.mockResolvedValue(uniformSharing('off'));
    loadStoredTelemetryEnforcementByOrganizationMock.mockResolvedValue(
      requiring({ metadata: true, transcripts: true }),
    );
    const queuedWorktree = {
      version: 2,
      selectedOrganizationId: ORG_A,
      projectId: 'proj-1',
      worktreeId: 'wt-1',
      workspaceName: 'My workspace',
      workspaceType: 'single-repo',
      branchName: 'feature/telemetry',
      turns: [
        {
          clientTurnId: 'queued-required-turn',
          eventType: 'worktree_chat',
          status: 'success',
          provider: 'claude',
          label: 'Queued required turn',
          startedAt: '2026-06-16T00:00:00.000Z',
          body: 'queued required body',
        },
      ],
      plans: [],
      pullRequests: [],
    };
    const enoent = Object.assign(new Error('not found'), { code: 'ENOENT' });
    readFileMock.mockImplementation((filePath: string) =>
      filePath === '/tmp/telemetry/queue.jsonl'
        ? Promise.resolve(`${JSON.stringify(queuedWorktree)}\n`)
        : Promise.reject(enoent),
    );

    const service = await startService();
    await jest.advanceTimersByTimeAsync(TELEMETRY_SYNC_DEBOUNCE_MS);

    expect(lastRequest()).toMatchObject({
      shareScope: 'organization',
      organizationId: ORG_A,
    });
    expect(
      lastRequest().workspace.worktrees?.[0]?.turns?.[0]?.clientTurnId,
    ).toBe('queued-required-turn');
    await service.dispose();
  });

  it('resumes persisted required org work after start', async () => {
    governWorkspaceBy(ORG_A);
    readPreferencesFileMock.mockResolvedValue(uniformSharing('off'));
    loadStoredTelemetryEnforcementByOrganizationMock.mockResolvedValue(
      requiring({ metadata: true, transcripts: true }),
    );
    const queuedWorktree = {
      version: 2,
      selectedOrganizationId: ORG_A,
      projectId: 'proj-1',
      worktreeId: 'wt-1',
      workspaceName: 'My workspace',
      workspaceType: 'single-repo',
      branchName: 'feature/telemetry',
      turns: [
        {
          clientTurnId: 'queued-before-start',
          eventType: 'worktree_chat',
          status: 'success',
          provider: 'claude',
          label: 'Queued before start',
          startedAt: '2026-06-16T00:00:00.000Z',
          body: 'queued required body',
        },
      ],
      plans: [],
      pullRequests: [],
    };
    const enoent = Object.assign(new Error('not found'), { code: 'ENOENT' });
    readFileMock.mockImplementation((filePath: string) =>
      filePath === '/tmp/telemetry/queue.jsonl'
        ? Promise.resolve(`${JSON.stringify(queuedWorktree)}\n`)
        : Promise.reject(enoent),
    );

    const service = new TelemetrySyncService();
    await service.start();
    expect(service.getStatus().sharingActive).toBe(true);
    await jest.advanceTimersByTimeAsync(TELEMETRY_SYNC_DEBOUNCE_MS);

    expect(
      lastRequest().workspace.worktrees?.[0]?.turns?.[0]?.clientTurnId,
    ).toBe('queued-before-start');
    await service.dispose();
  });

  it('re-routes queued work when the governing policy changes before flush', async () => {
    governWorkspaceBy(ORG_A);
    readPreferencesFileMock.mockResolvedValue(uniformSharing('private'));
    const service = await startService();

    emitTurn();
    await tick();
    service.setTelemetryEnforcementByOrganization(
      requiring({ metadata: true, transcripts: true }),
    );
    await service.flushAll();

    expect(lastRequest()).toMatchObject({
      shareScope: 'organization',
      organizationId: ORG_A,
    });
    await service.dispose();
  });

  it('does not apply a selected org prohibition to linked Personal work', async () => {
    const workspaceTarget = await import('../services/workspace-target');
    const targetSpy = jest
      .spyOn(workspaceTarget, 'resolveWorkspaceTarget')
      .mockResolvedValue({
        workspaceOwner: { kind: 'personal' },
        linkedOrganizationIds: [ORG_A],
      });
    readPreferencesFileMock.mockResolvedValue({
      telemetrySharing: {
        metadata: 'off',
        transcripts: 'off',
        plans: 'private',
        summaries: 'off',
      },
    });
    loadStoredTelemetryEnforcementByOrganizationMock.mockResolvedValue(
      prohibiting('metadata'),
    );
    getWorkspaceContextStateMock.mockReturnValue({
      context: { kind: 'personal' },
    });
    const service = await startService();
    const planListener = jest
      .mocked(addPlanContentChangeListener)
      .mock.calls.at(-1)?.[0];
    const plan = (id: string): TrackedPlanData => ({
      id,
      projectId: 'proj-1',
      worktreeId: 'wt-1',
      source: 'claude',
      title: id,
      content: id,
      reviewStatus: 'pending',
      createdAt: '2026-09-22T00:00:00.000Z',
      updatedAt: '2026-09-22T00:00:00.000Z',
      latestRevisionNumber: 1,
      revisions: [],
      linkedExecutionIds: [],
    });

    planListener?.(plan('captured-in-personal'));
    await drainQueuedTurns();
    getWorkspaceContextStateMock.mockReturnValue({
      context: { kind: 'organization', organizationId: ORG_A },
    });
    planListener?.(plan('captured-in-org-a'));
    await drainQueuedTurns();
    await service.flushAll();

    expect(allRequests()).toHaveLength(1);
    expect(lastRequest()).toMatchObject({ shareScope: 'private' });
    expect(
      lastRequest().workspace.worktrees?.[0]?.plans?.map(
        (entry) => entry.clientPlanId,
      ),
    ).toEqual(['captured-in-personal', 'captured-in-org-a']);

    targetSpy.mockRestore();
    await service.dispose();
  });

  it('never enqueues a prohibited scope, even for a stored organization value', async () => {
    governWorkspaceBy(ORG_A);
    readPreferencesFileMock.mockResolvedValue(uniformSharing('organization'));
    loadStoredTelemetryEnforcementByOrganizationMock.mockResolvedValue(
      prohibiting('metadata'),
    );
    const service = await startService();

    emitTurn();
    await tick();
    await jest.advanceTimersByTimeAsync(TELEMETRY_SYNC_DEBOUNCE_MS);
    await tick();

    // `metadata` owns the turn row, so nothing is enqueued at all.
    expect(service.getStatus().pendingCount).toBe(0);
    expect(requestCanopyCloudJsonMock).not.toHaveBeenCalled();

    await service.dispose();
  });

  it('keeps a prohibited scope off for an account without data_sync_control', async () => {
    governWorkspaceBy(ORG_A);
    readPreferencesFileMock.mockResolvedValue(uniformSharing('off'));
    loadStoredTelemetryEnforcementByOrganizationMock.mockResolvedValue(
      prohibiting('metadata'),
    );
    const service = await startService();

    emitTurn();
    await tick();
    await jest.advanceTimersByTimeAsync(TELEMETRY_SYNC_DEBOUNCE_MS);
    await tick();

    expect(requestCanopyCloudJsonMock).not.toHaveBeenCalled();

    await service.dispose();
  });

  it('applies an enforcement map pushed in after start', async () => {
    governWorkspaceBy(ORG_A);
    readPreferencesFileMock.mockResolvedValue(uniformSharing('organization'));
    const service = await startService();

    service.setTelemetryEnforcementByOrganization(prohibiting('metadata'));

    emitTurn();
    await tick();
    await jest.advanceTimersByTimeAsync(TELEMETRY_SYNC_DEBOUNCE_MS);
    await tick();

    expect(requestCanopyCloudJsonMock).not.toHaveBeenCalled();

    await service.dispose();
  });

  it('releases runtime enforcement when the map is cleared', async () => {
    governWorkspaceBy(ORG_A);
    readPreferencesFileMock.mockResolvedValue(uniformSharing('organization'));
    loadStoredTelemetryEnforcementByOrganizationMock.mockResolvedValue(
      prohibiting('metadata'),
    );
    const service = await startService();

    service.setTelemetryEnforcementByOrganization(new Map());

    emitTurn();
    await tick();
    await jest.advanceTimersByTimeAsync(TELEMETRY_SYNC_DEBOUNCE_MS);
    await tick();

    expect(requestCanopyCloudJsonMock).toHaveBeenCalled();

    await service.dispose();
  });

  it('refuses ingestSessionForShare under a transcripts prohibition', async () => {
    governWorkspaceBy(ORG_A);
    readPreferencesFileMock.mockResolvedValue(uniformSharing('off'));
    loadStoredTelemetryEnforcementByOrganizationMock.mockResolvedValue(
      prohibiting('transcripts', 'Globex'),
    );
    loadHistoryMock.mockResolvedValue({
      entries: [makeEntry({ id: 'turn-1', chatId: 'chat-1' })],
      nextCursor: undefined,
    });
    const service = await startService();

    const result = await service.ingestSessionForShare(
      'proj-1',
      'wt-1',
      'chat-1',
    );

    expect(result).toEqual({
      status: 'blocked-by-org-policy',
      scope: 'transcripts',
      organizationNames: ['Globex'],
    });
    expect(requestCanopyCloudJsonMock).not.toHaveBeenCalled();

    await service.dispose();
  });

  it('refuses ingestSessionForShare under a metadata prohibition', async () => {
    governWorkspaceBy(ORG_A);
    readPreferencesFileMock.mockResolvedValue(uniformSharing('off'));
    loadStoredTelemetryEnforcementByOrganizationMock.mockResolvedValue(
      prohibiting('metadata'),
    );
    loadHistoryMock.mockResolvedValue({
      entries: [makeEntry({ id: 'turn-1', chatId: 'chat-1' })],
      nextCursor: undefined,
    });
    const service = await startService();

    const result = await service.ingestSessionForShare(
      'proj-1',
      'wt-1',
      'chat-1',
    );

    expect(result).toEqual({
      status: 'blocked-by-org-policy',
      scope: 'metadata',
      organizationNames: ['Acme'],
    });

    await service.dispose();
  });

  it('refuses an org-owned run share when enforcement is unavailable', async () => {
    governWorkspaceBy(ORG_A);
    loadStoredTelemetryEnforcementByOrganizationMock
      .mockResolvedValueOnce(noEnforcement())
      .mockRejectedValueOnce(new Error('safeStorage unavailable'));
    const service = await startService();

    await expect(
      service.ingestSessionForShare('proj-1', 'wt-1', 'chat-1'),
    ).resolves.toEqual({
      status: 'blocked-by-org-policy',
      scope: 'metadata',
      organizationNames: [],
    });
    expect(requestCanopyCloudJsonMock).not.toHaveBeenCalled();
    await service.dispose();
  });

  it('STRIPS plans (rather than refusing) under a plans prohibition', async () => {
    governWorkspaceBy(ORG_A);
    readPreferencesFileMock.mockResolvedValue(uniformSharing('off'));
    loadStoredTelemetryEnforcementByOrganizationMock.mockResolvedValue(
      prohibiting('plans'),
    );
    loadHistoryMock.mockResolvedValue({
      entries: [makeEntry({ id: 'turn-1', chatId: 'chat-1' })],
      nextCursor: undefined,
    });
    const service = await startService();

    const result = await service.ingestSessionForShare(
      'proj-1',
      'wt-1',
      'chat-1',
    );

    expect(result).toMatchObject({ status: 'ok' });
    // The run still shares; only its plans collection is withheld.
    for (const request of allRequests()) {
      expect(request.workspace.worktrees?.[0]?.plans ?? []).toHaveLength(0);
    }
    expect(listTrackedPlans).not.toHaveBeenCalled();

    await service.dispose();
  });

  it('does not apply an org prohibition to a Personal run share', async () => {
    readPreferencesFileMock.mockResolvedValue(uniformSharing('off'));
    loadStoredTelemetryEnforcementByOrganizationMock.mockResolvedValue(
      prohibiting('transcripts'),
    );
    loadHistoryMock.mockResolvedValue({
      entries: [makeEntry({ id: 'turn-1', chatId: 'chat-1' })],
      nextCursor: undefined,
    });
    const service = await startService();

    await expect(
      service.ingestSessionForShare('proj-1', 'wt-1', 'chat-1'),
    ).resolves.toMatchObject({ status: 'ok' });

    await service.dispose();
  });

  it('blocks an org-owned run share in Personal and names only its owner', async () => {
    governWorkspaceBy(ORG_A);
    loadStoredTelemetryEnforcementByOrganizationMock.mockResolvedValue(
      prohibiting('transcripts', 'Owner A'),
    );
    const service = await startService();

    await expect(
      service.ingestSessionForShare('proj-1', 'wt-1', 'chat-1', {
        kind: 'personal',
      }),
    ).resolves.toEqual({
      status: 'blocked-by-org-policy',
      scope: 'transcripts',
      organizationNames: ['Owner A'],
    });
    await service.dispose();
  });

  it('blocks a run share when ownership is unknown', async () => {
    readWorkspaceConfigDetailedMock.mockResolvedValue({
      config: personalConfig,
      authority: 'unreadable',
      ownerMalformed: false,
    });
    const service = await startService();

    await expect(
      service.ingestSessionForShare('proj-1', 'wt-1', 'chat-1', {
        kind: 'personal',
      }),
    ).resolves.toEqual({
      status: 'blocked-by-org-policy',
      scope: 'metadata',
      organizationNames: [],
    });
    expect(requestCanopyCloudJsonMock).not.toHaveBeenCalled();
    await service.dispose();
  });

  // Without this branch a 403 falls into the transient case and retries
  // forever, growing the queue file with a batch the server will never accept.
  it('drops a single-target scope-prohibited group and re-probes', async () => {
    readPreferencesFileMock.mockResolvedValue(uniformSharing('private'));
    requestCanopyCloudJsonMock.mockImplementation(() => {
      // The server's human-readable `error` string is prose and deliberately
      // does NOT contain the code — the branch must key off `serverCode`, which
      // the transport lifts off the JSON body. Asserting against this exact
      // shape is what stops a substring match from creeping back in.
      throw new MockCanopyCloudClientError(
        'http-error',
        'Your organization prohibits sharing transcripts',
        403,
        'telemetry_scope_prohibited',
      );
    });
    const service = await startService();

    emitTurn();
    await tick();
    await jest.advanceTimersByTimeAsync(TELEMETRY_SYNC_DEBOUNCE_MS);
    await tick();

    expect(reprobeEnforcedSettingsMock).toHaveBeenCalled();
    // Dropped, not requeued.
    expect(service.getStatus().pendingCount).toBe(0);

    await service.dispose();
  });

  it('refuses only the REFUSED target, still delivering to the healthy one', async () => {
    // A scope refusal names ONE target. The fan-out sends the same group to
    // every team in the owning org, so treating it as group poison would `break` the target
    // loop and `dropGroupItems` — deleting data a healthy org ordered AFTER the
    // refused one never received. Since CAN-2311 a billing lapse emits this same
    // code, so the ordering that triggers it is ordinary, not exotic.
    ownWorkspaceBy('org-1');
    readPreferencesFileMock.mockResolvedValue(uniformSharing('team'));
    getCanopyCloudCredentialsMock.mockResolvedValue({
      baseUrl: 'https://cloud.example',
      apiKey: 'key',
      capabilities: [],
      teams: [
        { id: 'org-refused', organization: { id: 'org-1' } },
        { id: 'org-healthy', organization: { id: 'org-1' } },
      ],
      // Refused org FIRST, so a group-wide poison would break before the
      // healthy one is ever attempted.
      organizations: [{ id: 'org-refused' }, { id: 'org-healthy' }],
    });
    // Both orgs look entitled locally, so nothing is filtered client-side and
    // the refusal can only come from the server.
    loadStoredOrgBillingStatesMock.mockResolvedValue([]);

    const attempted: string[] = [];
    requestCanopyCloudJsonMock.mockImplementation(
      (_path: string, init: { body: string }) => {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- parsing a request body this test produced.
        const parsed: { teamId?: string } = JSON.parse(init.body);
        const orgId = parsed.teamId ?? '';
        attempted.push(orgId);
        if (orgId === 'org-refused') {
          throw new MockCanopyCloudClientError(
            'http-error',
            'Your organization is on hold',
            403,
            'telemetry_scope_prohibited',
          );
        }
        return Promise.resolve(buildIngestSuccessResponse(init));
      },
    );
    const service = await startService();

    emitTurn();
    await tick();
    await jest.advanceTimersByTimeAsync(TELEMETRY_SYNC_DEBOUNCE_MS);
    await tick();

    // The healthy org was still attempted after the refusal...
    expect(attempted).toContain('org-refused');
    expect(attempted).toContain('org-healthy');
    // ...and the refusal is permanent, so nothing re-queues forever.
    expect(service.getStatus().pendingCount).toBe(0);
    expect(reprobeEnforcedSettingsMock).toHaveBeenCalled();

    await service.dispose();
  });

  it('still DEFERS a plain 403 that is not a policy rejection', async () => {
    readPreferencesFileMock.mockResolvedValue(uniformSharing('private'));
    requestCanopyCloudJsonMock.mockImplementation(() => {
      throw new MockCanopyCloudClientError('request-failed', 'Forbidden', 403);
    });
    const service = await startService();

    emitTurn();
    await tick();
    await jest.advanceTimersByTimeAsync(TELEMETRY_SYNC_DEBOUNCE_MS);
    await tick();

    expect(reprobeEnforcedSettingsMock).not.toHaveBeenCalled();
    expect(service.getStatus().pendingCount).toBeGreaterThan(0);

    await service.dispose();
  });
});

describe('TelemetrySyncService summaries sharing for the Agent Ledger', () => {
  it('reports the stored summaries sharing with any organization prohibition, and each change', async () => {
    readPreferencesFileMock.mockResolvedValue(uniformSharing('off'));
    const service = await startService();
    const changes: string[] = [];
    const unsubscribe = service.subscribeSummariesSharing((): void => {
      const sharing = service.getSummariesSharing();
      changes.push(`${sharing.visibility}:${String(sharing.prohibited)}`);
    });

    // No subscription floor applies: `off` stays off.
    expect(service.getSummariesSharing()).toEqual({
      visibility: 'off',
      prohibited: false,
    });

    // Any organization's prohibition holds the whole account.
    service.setTelemetryEnforcementByOrganization(
      prohibiting('summaries', 'Beta', ORG_B),
    );
    // Another scope's enforcement changes nothing the Ledger follows.
    service.setTelemetryEnforcementByOrganization(
      new Map([
        ...prohibiting('summaries', 'Beta', ORG_B),
        ...prohibiting('metadata'),
      ]),
    );
    // A requirement applies only to the work its organization owns, so it
    // does not raise the account's choice.
    service.setTelemetryEnforcementByOrganization(
      requiring({ summaries: true }),
    );
    unsubscribe();
    service.setTelemetryEnforcementByOrganization(noEnforcement());

    expect(changes).toEqual(['off:true', 'off:false']);
    expect(service.getSummariesSharing()).toEqual({
      visibility: 'off',
      prohibited: false,
    });

    await service.dispose();
  });

  it("holds summaries while the organizations' policy cannot be read", async () => {
    readPreferencesFileMock.mockResolvedValue(uniformSharing('private'));
    loadStoredTelemetryEnforcementByOrganizationMock.mockRejectedValue(
      new Error('policy unreadable'),
    );
    const service = await startService();

    expect(service.getSummariesSharing()).toEqual({
      visibility: 'private',
      prohibited: true,
    });

    service.setTelemetryEnforcementByOrganization(noEnforcement());
    expect(service.getSummariesSharing().prohibited).toBe(false);

    await service.dispose();
  });
});

describe('TelemetrySyncService.buildLocalWorktreeIndexByServerExternalId', () => {
  function serviceWithAnchors(
    workspaces: Record<
      string,
      Record<string, { anchors?: Record<string, string> }>
    >,
  ): TelemetrySyncService {
    const service = new TelemetrySyncService();
    const writable = service as unknown as {
      syncMap: { version: number; workspaces: Record<string, unknown> };
    };
    writable.syncMap = {
      version: 2,
      workspaces: Object.fromEntries(
        Object.entries(workspaces).map(([projectId, worktrees]) => [
          projectId,
          {
            externalIds: {},
            worktrees: Object.fromEntries(
              Object.entries(worktrees).map(([worktreeId, worktree]) => [
                worktreeId,
                {
                  targets: {},
                  ...(worktree.anchors
                    ? { sharedContainerAnchors: worktree.anchors }
                    : {}),
                },
              ]),
            ),
          },
        ]),
      ),
    };
    return service;
  }

  it('maps an anchored server worktree back to its local identity', () => {
    const service = serviceWithAnchors({
      'project-1': { 'worktree-1': { anchors: { 'org-1': 'server-a' } } },
      'project-2': { 'worktree-2': { anchors: { 'org-1': 'server-b' } } },
    });
    expect(
      service
        .buildLocalWorktreeIndexByServerExternalId('org-1')
        .get('server-b'),
    ).toEqual({ projectId: 'project-2', worktreeId: 'worktree-2' });
  });

  it('scopes the reverse lookup to the requested organization', () => {
    const service = serviceWithAnchors({
      'project-1': { 'worktree-1': { anchors: { 'org-2': 'server-a' } } },
    });
    expect(
      service
        .buildLocalWorktreeIndexByServerExternalId('org-1')
        .get('server-a'),
    ).toBeUndefined();
    expect(
      service
        .buildLocalWorktreeIndexByServerExternalId('org-2')
        .get('server-a'),
    ).toEqual({ projectId: 'project-1', worktreeId: 'worktree-1' });
  });

  it('ignores unanchored targets so scope churn cannot claim a container', () => {
    const service = new TelemetrySyncService();
    const writable = service as unknown as {
      syncMap: { version: number; workspaces: Record<string, unknown> };
    };
    writable.syncMap = {
      version: 2,
      workspaces: {
        'project-1': {
          externalIds: {},
          worktrees: {
            'worktree-1': {
              targets: { 'org:org-1': { externalId: 'server-a' } },
            },
          },
        },
      },
    };
    expect([
      ...service.buildLocalWorktreeIndexByServerExternalId('org-1').entries(),
    ]).toEqual([]);
  });

  it('omits a server worktree nothing anchored', () => {
    expect(
      serviceWithAnchors({})
        .buildLocalWorktreeIndexByServerExternalId('org-1')
        .get('server-a'),
    ).toBeUndefined();
  });

  it('indexes only the requested organization, in one pass', () => {
    // The owned-target listing resolves a whole page of server containers per
    // organization on the Electron main thread, so it builds this index once
    // instead of scanning every workspace x worktree per container. Anchors
    // belonging to other organizations must not leak into it, and an
    // unanchored worktree must contribute nothing.
    const service = serviceWithAnchors({
      'project-1': {
        'worktree-1': { anchors: { 'org-1': 'server-a', 'org-2': 'server-c' } },
        'worktree-2': { anchors: { 'org-1': 'server-b' } },
      },
      'project-2': {
        'worktree-3': { anchors: { 'org-2': 'server-d' } },
        // Unanchored: only frozen anchors may claim a container, never targets.
        'worktree-4': {},
      },
    });

    const index = service.buildLocalWorktreeIndexByServerExternalId('org-1');
    expect([...index.entries()]).toEqual([
      ['server-a', { projectId: 'project-1', worktreeId: 'worktree-1' }],
      ['server-b', { projectId: 'project-1', worktreeId: 'worktree-2' }],
    ]);
    for (const otherOrganizationExternalId of ['server-c', 'server-d']) {
      expect(index.get(otherOrganizationExternalId)).toBeUndefined();
    }
  });

  it('breaks a duplicate anchor tie the same way the linear scan did', () => {
    // Only reachable through stale state, but the index must not silently pick
    // a different worktree than a first-match scan over the same object graph:
    // the first entry in workspace-then-worktree insertion order wins, and a
    // later duplicate never overwrites it.
    const service = serviceWithAnchors({
      'project-1': { 'worktree-1': { anchors: { 'org-1': 'server-a' } } },
      'project-2': { 'worktree-2': { anchors: { 'org-1': 'server-a' } } },
    });

    const index = service.buildLocalWorktreeIndexByServerExternalId('org-1');
    expect(index.get('server-a')).toEqual({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
    });
    expect(index.size).toBe(1);
  });

  it('builds an empty index when no worktree anchored anything for the org', () => {
    const service = serviceWithAnchors({
      'project-1': { 'worktree-1': { anchors: { 'org-2': 'server-a' } } },
    });
    expect(
      service.buildLocalWorktreeIndexByServerExternalId('org-1').size,
    ).toBe(0);
  });
});

describe('TelemetrySyncService.resolveServerWorktreeExternalId', () => {
  function serviceWithTargets(
    targets: Record<string, { externalId: string }>,
  ): TelemetrySyncService {
    const service = new TelemetrySyncService();
    const writable = service as unknown as {
      syncMap: {
        version: number;
        workspaces: Record<string, unknown>;
      };
    };
    writable.syncMap = {
      version: 2,
      workspaces: {
        'project-1': {
          externalIds: {},
          worktrees: { 'worktree-1': { targets } },
        },
      },
    };
    return service;
  }

  function addTarget(
    service: TelemetrySyncService,
    key: string,
    externalId: string,
  ): void {
    const writable = service as unknown as {
      syncMap: {
        workspaces: Record<
          string,
          {
            worktrees: Record<
              string,
              { targets: Record<string, { externalId: string }> }
            >;
          }
        >;
      };
    };
    const worktree =
      writable.syncMap.workspaces['project-1']?.worktrees['worktree-1'];
    if (!worktree) throw new Error('missing test worktree');
    worktree.targets[key] = { externalId };
  }

  it('prefers the selected organization target and stays stable', () => {
    const service = serviceWithTargets({
      private: { externalId: 'private-external' },
      'org:org-1': { externalId: 'org-external' },
    });
    expect(
      service.resolveServerWorktreeExternalId(
        'project-1',
        'worktree-1',
        'org-1',
      ),
    ).toBe('org-external');
    expect(
      service.resolveServerWorktreeExternalId(
        'project-1',
        'worktree-1',
        'org-1',
      ),
    ).toBe('org-external');
  });

  it('falls back to private and returns null when neither target exists', () => {
    expect(
      serviceWithTargets({
        private: { externalId: 'private-external' },
      }).resolveServerWorktreeExternalId('project-1', 'worktree-1', 'org-1'),
    ).toBe('private-external');
    expect(
      serviceWithTargets({}).resolveServerWorktreeExternalId(
        'project-1',
        'worktree-1',
        'org-1',
      ),
    ).toBeNull();
  });

  it('falls back to a team target owned by the selected organization', () => {
    expect(
      serviceWithTargets({
        private: { externalId: 'private-external' },
        'team:team-other': { externalId: 'other-team-external' },
        'team:team-selected': { externalId: 'selected-team-external' },
      }).resolveServerWorktreeExternalId('project-1', 'worktree-1', 'org-1', [
        'team-selected',
      ]),
    ).toBe('selected-team-external');
  });

  it('does not freeze a fallback anchor during a read-only eligibility probe', async () => {
    const service = serviceWithTargets({
      private: { externalId: 'private-external' },
    });
    expect(
      await Promise.resolve(
        service.resolveServerWorktreeExternalId(
          'project-1',
          'worktree-1',
          'org-1',
        ),
      ),
    ).toBe('private-external');

    addTarget(service, 'org:org-1', 'org-external');

    expect(
      await Promise.resolve(
        service.resolveServerWorktreeExternalId(
          'project-1',
          'worktree-1',
          'org-1',
        ),
      ),
    ).toBe('org-external');
  });

  it('keeps a durable anchor reservation when sync targets later change', async () => {
    const service = serviceWithTargets({
      private: { externalId: 'private-external' },
    });
    await expect(
      service.reserveSharedContainerAnchor(
        'project-1',
        'worktree-1',
        'org-1',
        'private-external',
      ),
    ).resolves.toBe(true);

    addTarget(service, 'org:org-1', 'org-external');

    expect(
      service.resolveServerWorktreeExternalId(
        'project-1',
        'worktree-1',
        'org-1',
      ),
    ).toBe('private-external');
  });

  it('does not offer an anchor already reserved by another organization', async () => {
    const service = serviceWithTargets({
      private: { externalId: 'private-external' },
    });
    await service.reserveSharedContainerAnchor(
      'project-1',
      'worktree-1',
      'org-1',
      'private-external',
    );

    expect(
      service.resolveServerWorktreeExternalId(
        'project-1',
        'worktree-1',
        'org-2',
      ),
    ).toBeNull();
    expect(
      service.resolveSharedContainerAnchorConflictOrganizationId(
        'project-1',
        'worktree-1',
        'org-2',
      ),
    ).toBe('org-1');

    addTarget(service, 'org:org-2', 'org-2-external');
    expect(
      service.resolveServerWorktreeExternalId(
        'project-1',
        'worktree-1',
        'org-2',
      ),
    ).toBe('org-2-external');
    expect(
      service.resolveSharedContainerAnchorConflictOrganizationId(
        'project-1',
        'worktree-1',
        'org-2',
      ),
    ).toBeNull();
  });

  it('rolls back an in-memory anchor when durable persistence fails', async () => {
    const service = serviceWithTargets({
      private: { externalId: 'private-external' },
    });
    const writable = service as unknown as {
      saveSyncMap: () => Promise<void>;
    };
    writable.saveSyncMap = jest
      .fn<Promise<void>, []>()
      .mockRejectedValue(new Error('sync map write failed'));

    await expect(
      service.reserveSharedContainerAnchor(
        'project-1',
        'worktree-1',
        'org-1',
        'private-external',
      ),
    ).rejects.toThrow('sync map write failed');

    addTarget(service, 'org:org-1', 'org-external');
    expect(
      service.resolveServerWorktreeExternalId(
        'project-1',
        'worktree-1',
        'org-1',
      ),
    ).toBe('org-external');
  });

  it('retries a concurrent reservation after the first durable write fails', async () => {
    const service = serviceWithTargets({
      private: { externalId: 'private-external' },
    });
    const writable = service as unknown as {
      saveSyncMap: () => Promise<void>;
    };
    let rejectFirstWrite: ((error: Error) => void) | undefined;
    writable.saveSyncMap = jest
      .fn<Promise<void>, []>()
      .mockImplementationOnce(
        () =>
          new Promise<void>((_resolve, reject) => {
            rejectFirstWrite = reject;
          }),
      )
      .mockResolvedValueOnce();

    const firstReservation = service.reserveSharedContainerAnchor(
      'project-1',
      'worktree-1',
      'org-1',
      'private-external',
    );
    const firstFailure = expect(firstReservation).rejects.toThrow(
      'sync map write failed',
    );
    const secondReservation = service.reserveSharedContainerAnchor(
      'project-1',
      'worktree-1',
      'org-1',
      'private-external',
    );

    rejectFirstWrite?.(new Error('sync map write failed'));

    await firstFailure;
    await expect(secondReservation).resolves.toBe(true);
    expect(writable.saveSyncMap).toHaveBeenCalledTimes(2);
  });

  it('releases only the matching anchor reservation after a known remote failure', async () => {
    const service = serviceWithTargets({
      private: { externalId: 'private-external' },
      'org:org-1': { externalId: 'org-external' },
    });
    await service.reserveSharedContainerAnchor(
      'project-1',
      'worktree-1',
      'org-1',
      'private-external',
    );

    await service.releaseSharedContainerAnchor(
      'project-1',
      'worktree-1',
      'org-1',
      'private-external',
    );

    expect(
      service.resolveServerWorktreeExternalId(
        'project-1',
        'worktree-1',
        'org-1',
      ),
    ).toBe('org-external');
  });

  it('resolves and anchors a personal container to the user-owned private target', async () => {
    const service = serviceWithTargets({
      private: { externalId: 'private-external' },
      'org:org-1': { externalId: 'org-external' },
      'team:team-1': { externalId: 'team-external' },
    });

    // A personal container must live on a user-owned server worktree, so only
    // the private target is a candidate, never an org or team target.
    expect(
      service.resolveServerWorktreeExternalId(
        'project-1',
        'worktree-1',
        undefined,
        ['team-1'],
      ),
    ).toBe('private-external');
    expect(
      serviceWithTargets({
        'org:org-1': { externalId: 'org-external' },
      }).resolveServerWorktreeExternalId('project-1', 'worktree-1', undefined),
    ).toBeNull();

    await expect(
      service.reserveSharedContainerAnchor(
        'project-1',
        'worktree-1',
        undefined,
        'private-external',
      ),
    ).resolves.toBe(true);
    expect(
      service.listSharedContainerAnchorKeys('project-1', 'worktree-1'),
    ).toEqual(['personal']);
    expect(
      service
        .buildLocalWorktreeIndexByServerExternalId(undefined)
        .get('private-external'),
    ).toEqual({ projectId: 'project-1', worktreeId: 'worktree-1' });
    expect(
      service.buildLocalWorktreeIndexByServerExternalId('org-1').size,
    ).toBe(0);

    // The frozen personal anchor wins over later target churn and is not
    // offered to an organization.
    addTarget(service, 'private', 'private-external-2');
    expect(
      service.resolveServerWorktreeExternalId(
        'project-1',
        'worktree-1',
        undefined,
      ),
    ).toBe('private-external');
    expect(
      service.resolveServerWorktreeExternalId(
        'project-1',
        'worktree-1',
        'org-2',
      ),
    ).toBe('private-external-2');

    await service.releaseSharedContainerAnchor(
      'project-1',
      'worktree-1',
      undefined,
      'private-external',
    );
    expect(
      service.listSharedContainerAnchorKeys('project-1', 'worktree-1'),
    ).toEqual([]);
  });

  it('reports an organization that holds the only candidate for a personal container', async () => {
    const service = serviceWithTargets({
      private: { externalId: 'private-external' },
    });
    await service.reserveSharedContainerAnchor(
      'project-1',
      'worktree-1',
      'org-1',
      'private-external',
    );

    expect(
      service.resolveServerWorktreeExternalId(
        'project-1',
        'worktree-1',
        undefined,
      ),
    ).toBeNull();
    expect(
      service.resolveSharedContainerAnchorConflictOrganizationId(
        'project-1',
        'worktree-1',
        undefined,
      ),
    ).toBe('org-1');
  });
});

describe('RUN_SHARE_ID_SUFFIX', () => {
  it('still equals sha256("canopy-run-share-v1").slice(0, 16)', () => {
    // The suffix is already persisted in the database, so it can never be
    // recomputed differently. This pins the frozen protocol constant to the
    // derivation it was originally produced by.
    expect(RUN_SHARE_ID_SUFFIX).toBe(
      createHash('sha256')
        .update('canopy-run-share-v1', 'utf8')
        .digest('hex')
        .slice(0, 16),
    );
  });
});

describe('TelemetrySyncService PR ownership claim', () => {
  // The poller and the reconciliation sweep are independent writers whose rows
  // do not converge server-side: `(worktreeId, repoId, prNumber)` is a storage
  // key, so one PR written against two worktrees yields two rows that BOTH
  // count. These cover the concurrent interleaving in both directions.
  const PR_URL = 'https://github.com/o/canopy/pull/2427';

  function prStatus(repoId: string): WorktreePrStatus {
    return {
      lastCheckedAt: '2026-08-28T12:00:00.000Z',
      repos: [
        {
          repoId,
          repoName: 'canopy',
          status: {
            prNumber: 2427,
            prUrl: PR_URL,
            title: 'fix: something',
            state: 'merged',
            checkStatus: 'passing',
            checkDetails: [],
            reviewStatus: 'approved',
            reviewers: [],
            hasConflicts: false,
            commentCount: 0,
            updatedAt: '2026-08-28T11:00:00.000Z',
            mergedAt: '2026-08-27T10:00:00.000Z',
            openedAt: '2026-08-26T10:00:00.000Z',
          },
        },
      ],
    };
  }

  function reconciledPayload(): TelemetryPullRequestPayload {
    return {
      repoId: 'canopy',
      repoName: 'canopy',
      prNumber: 2427,
      prUrl: PR_URL,
      title: 'fix: something',
      state: 'merged',
      checkStatus: 'none',
      reviewStatus: 'none',
      hasConflicts: false,
      commentCount: 0,
      openedAt: '2026-08-26T10:00:00.000Z',
      mergedAt: '2026-08-27T10:00:00.000Z',
    };
  }

  /** Every PR payload across every ingest request, oldest first. */
  function allPrPayloads(): TelemetryPullRequestPayload[] {
    return allRequests().flatMap(
      (request) =>
        request.workspace.worktrees?.flatMap(
          (worktree) => worktree.pullRequests ?? [],
        ) ?? [],
    );
  }

  it.each([null, 'org-1'])(
    'returns logical pending PR ids for reconciliation with captured organization %s',
    async (organizationId) => {
      getWorkspaceContextStateMock.mockReturnValue({
        context:
          organizationId === null
            ? { kind: 'personal' }
            : { kind: 'organization', organizationId },
      });
      const service = await startService();
      await service.enqueueReconciledPullRequests('canopy', [
        reconciledPayload(),
      ]);

      // The sweep consumes logical ids, independent of the captured target.
      expect([...service.getSyncedPullRequestKeys('canopy')]).toEqual([
        'canopy#2427',
      ]);
      expect([
        ...service.getSyncedPullRequestKeys('another-workspace'),
      ]).toEqual([]);
      const recoveredIds: string[] = [];
      await reconcilePullRequests({
        listRepos: () =>
          Promise.resolve([
            {
              projectId: 'canopy',
              repoId: 'canopy',
              repoName: 'canopy',
              owner: 'o',
              repo: 'canopy',
              dedupeByPrNumberOnly: false,
              ownedPrNumbers: new Set<number>(),
              unresolvedLiveBranches: new Set<string>(),
              liveBranches: new Set<string>(),
            },
          ]),
        listPullRequestsByViewer: () =>
          Promise.resolve([
            {
              prNumber: 2427,
              prUrl: PR_URL,
              title: 'fix: something',
              state: 'merged',
              openedAt: '2026-08-26T10:00:00.000Z',
              mergedAt: '2026-08-27T10:00:00.000Z',
              headRefName: 'finished',
            },
          ]),
        getSyncedPrKeys: (projectId) =>
          Promise.resolve(service.getSyncedPullRequestKeys(projectId)),
        // Model a sweep whose URL snapshot predates the pending enqueue.
        getSyncedPrUrls: () => Promise.resolve(new Set<string>()),
        getSyncedPrStates: () =>
          Promise.resolve(service.getSyncedPullRequestStates()),
        enqueue: (_projectId, payloads) => {
          recoveredIds.push(
            ...payloads.map((pr) => `${pr.repoId}#${pr.prNumber}`),
          );
          return Promise.resolve(new Set(payloads.map((pr) => pr.prUrl)));
        },
        enqueueStateUpdates: (_projectId, payloads) => {
          recoveredIds.push(
            ...payloads.map((pr) => `${pr.repoId}#${pr.prNumber}`),
          );
          return Promise.resolve(new Set(payloads.map((pr) => pr.prUrl)));
        },
      });
      expect(recoveredIds).toEqual([]);

      await service.dispose();
    },
  );

  it.each(['all-lapsed', 'ownership'] as const)(
    'drops all capped PRs after a terminal %s decision without rearming',
    async (reason) => {
      readPreferencesFileMock.mockResolvedValue(uniformSharing('organization'));
      if (reason === 'all-lapsed') {
        ownWorkspaceBy('org-1');
        loadStoredOrgBillingStatesMock.mockResolvedValue([
          { organizationId: 'org-1', teamsEntitled: false },
        ]);
      } else {
        readWorkspaceConfigDetailedMock.mockResolvedValue({
          config: personalConfig,
          authority: 'absent',
          ownerMalformed: false,
        });
      }
      const service = await startService();
      const idleTimers = jest.getTimerCount();
      await service.enqueueReconciledPullRequests(
        'canopy',
        Array.from(
          { length: MAX_TELEMETRY_PULL_REQUESTS_PER_WORKTREE + 1 },
          (_, index) => ({
            ...reconciledPayload(),
            prNumber: index + 1,
            prUrl: `https://github.com/o/canopy/pull/${index + 1}`,
          }),
        ),
      );
      await jest.advanceTimersByTimeAsync(TELEMETRY_SYNC_DEBOUNCE_MS);
      expect(service.getStatus().pendingCount).toBe(0);
      expect([...service.getSyncedPullRequestKeys('canopy')]).toEqual([]);
      expect(allRequests()).toHaveLength(0);
      if (reason === 'all-lapsed') {
        expect(writeFileMock).toHaveBeenLastCalledWith(
          '/tmp/telemetry/queue.jsonl',
          '',
          'utf8',
        );
      } else {
        expect(writeFileMock).not.toHaveBeenCalled();
      }
      expect(jest.getTimerCount()).toBe(idleTimers);
      await service.dispose();
    },
  );

  it('delivers every capped PR to a healthy owner while a lapsed organization is selected', async () => {
    ownWorkspaceBy('org-2');
    getCanopyCloudCredentialsMock.mockResolvedValue({
      baseUrl: 'https://cloud.example',
      apiKey: 'key',
      capabilities: [],
      teams: [],
      organizations: [{ id: 'org-1' }, { id: 'org-2' }],
    });
    readPreferencesFileMock.mockResolvedValue(uniformSharing('organization'));
    loadStoredOrgBillingStatesMock.mockResolvedValue([
      { organizationId: 'org-1', teamsEntitled: false },
    ]);
    const service = await startService();
    const payloads = Array.from(
      { length: MAX_TELEMETRY_PULL_REQUESTS_PER_WORKTREE + 1 },
      (_, index) => ({
        ...reconciledPayload(),
        prNumber: index + 1,
        prUrl: `https://github.com/o/canopy/pull/${index + 1}`,
      }),
    );
    await service.enqueueReconciledPullRequests('canopy', payloads);
    await jest.advanceTimersByTimeAsync(TELEMETRY_SYNC_DEBOUNCE_MS);
    expect(service.getStatus().pendingCount).toBe(1);
    await jest.advanceTimersByTimeAsync(TELEMETRY_SYNC_DEBOUNCE_MS);
    expect(
      allRequests().every((request) => request.organizationId === 'org-2'),
    ).toBe(true);
    expect(allPrPayloads().map((pr) => pr.prNumber)).toEqual(
      payloads.map((pr) => pr.prNumber),
    );
    expect(service.getStatus().pendingCount).toBe(0);
    await service.dispose();
  });

  it('defers PRs beyond the per-flush cap until the next debounce', async () => {
    const service = await startService();
    const payloads = Array.from(
      { length: MAX_TELEMETRY_PULL_REQUESTS_PER_WORKTREE + 1 },
      (_, index) => ({
        ...reconciledPayload(),
        prNumber: index + 1,
        prUrl: `https://github.com/o/canopy/pull/${index + 1}`,
      }),
    );
    await service.enqueueReconciledPullRequests('canopy', payloads);
    await jest.advanceTimersByTimeAsync(TELEMETRY_SYNC_DEBOUNCE_MS * 2);
    expect(allPrPayloads().map((pr) => pr.prNumber)).toEqual(
      payloads.map((pr) => pr.prNumber),
    );
    await service.dispose();
  });

  it('uploads a PR a tracked worktree lists but never sent (#3994)', async () => {
    // tapir's `lastKnownPrStatus` lists #3994 (so the repo reports it as
    // owned), yet nothing in the sync map or queue records it: the poller
    // never delivered it. The sweep must upload it rather than wait forever.
    const service = await startService();
    const url = 'https://github.com/o/canopy/pull/3994';
    await reconcilePullRequests({
      listRepos: () =>
        Promise.resolve([
          {
            projectId: 'canopy',
            repoId: 'canopy',
            repoName: 'canopy',
            owner: 'o',
            repo: 'canopy',
            dedupeByPrNumberOnly: true,
            ownedPrNumbers: new Set<number>([3994]),
            unresolvedLiveBranches: new Set<string>(),
            liveBranches: new Set<string>(),
          },
        ]),
      listPullRequestsByViewer: () =>
        Promise.resolve([
          {
            prNumber: 3994,
            prUrl: url,
            title: 'feat: tapir pipeline chain',
            state: 'merged',
            openedAt: '2026-09-22T10:00:00.000Z',
            mergedAt: '2026-09-23T10:00:00.000Z',
            headRefName: 'tapir/pipeline-chain',
          },
        ]),
      getSyncedPrKeys: (projectId) =>
        Promise.resolve(service.getSyncedPullRequestKeys(projectId)),
      getSyncedPrUrls: () =>
        Promise.resolve(service.getSyncedPullRequestUrls()),
      getSyncedPrStates: () =>
        Promise.resolve(service.getSyncedPullRequestStates()),
      enqueue: (projectId, payloads) =>
        service.enqueueReconciledPullRequests(projectId, payloads),
      enqueueStateUpdates: (projectId, payloads) =>
        service.enqueueReconciledPullRequests(projectId, payloads, {
          stateUpdate: true,
        }),
    });
    await service.flushAll();

    const uploaded = allRequests().flatMap(
      (request) =>
        request.workspace.worktrees?.flatMap((worktree) =>
          (worktree.pullRequests ?? []).map((pr) => ({
            worktree: worktree.clientLocalId,
            prUrl: pr.prUrl,
            state: pr.state,
          })),
        ) ?? [],
    );
    expect(uploaded).toEqual([
      { worktree: 'pr-reconciliation', prUrl: url, state: 'merged' },
    ]);
    await service.dispose();
  });

  describe('merge state for PRs first sent while open (CAN-3513)', () => {
    const OPEN_URL = 'https://github.com/o/canopy/pull/3854';

    function tapirRepo(ownedPrNumbers: number[]): ReconcilableRepo {
      return {
        projectId: 'canopy',
        repoId: 'canopy',
        repoName: 'canopy',
        owner: 'o',
        repo: 'canopy',
        dedupeByPrNumberOnly: true,
        ownedPrNumbers: new Set(ownedPrNumbers),
        unresolvedLiveBranches: new Set<string>(),
        liveBranches: new Set<string>(),
      };
    }

    function mergedOnGitHub(): PullRequestRecord {
      return {
        prNumber: 3854,
        prUrl: OPEN_URL,
        title: 'feat: tapir pipeline chain',
        state: 'merged',
        openedAt: '2026-09-21T10:00:00.000Z',
        mergedAt: '2026-09-24T10:00:00.000Z',
        headRefName: 'tapir/pipeline-chain',
        checkStatus: 'passing',
        reviewStatus: 'approved',
      };
    }

    function openStatus(): WorktreePrStatus {
      return {
        lastCheckedAt: '2026-09-21T12:00:00.000Z',
        repos: [
          {
            repoId: 'tapir',
            repoName: 'canopy',
            status: {
              prNumber: 3854,
              prUrl: OPEN_URL,
              title: 'feat: tapir pipeline chain',
              state: 'open',
              checkStatus: 'passing',
              checkDetails: [],
              reviewStatus: 'approved',
              reviewers: [],
              hasConflicts: false,
              commentCount: 0,
              updatedAt: '2026-09-21T11:00:00.000Z',
              openedAt: '2026-09-21T10:00:00.000Z',
            },
          },
        ],
      };
    }

    function sentStatesFor(url: string): string[] {
      return allPrPayloads()
        .filter((pr) => pr.prUrl === url)
        .map((pr) => pr.state);
    }

    beforeEach(() => {
      jest.mocked(listReconcilableRepos).mockResolvedValue([tapirRepo([3900])]);
      jest
        .mocked(listPullRequestsByViewer)
        .mockResolvedValue([mergedOnGitHub()]);
    });

    it('sends the merge within one sweep after the worktree moved on', async () => {
      const service = await startService();
      const listener = jest.mocked(addWorktreePrStatusChangeListener).mock
        .calls[0][0];
      // tapir sends #3854 while it is open...
      listener({
        projectId: 'canopy',
        worktreeId: 'tapir',
        status: openStatus(),
      });
      await drainQueuedTurns();
      await service.flushAll();
      expect(sentStatesFor(OPEN_URL)).toEqual(['open']);

      // ...then checks out #3900, so the poller never sees #3854 merge.
      const result = await service.runPullRequestReconciliation();
      await service.flushAll();

      expect(result?.prsStateUpdated).toBe(1);
      expect(sentStatesFor(OPEN_URL)).toEqual(['open', 'merged']);
      const merged = allPrPayloads().filter(
        (pr) => pr.prUrl === OPEN_URL && pr.state === 'merged',
      );
      // The update keeps the outcomes GitHub reports instead of erasing them.
      expect(merged[0]).toMatchObject({
        checkStatus: 'passing',
        reviewStatus: 'approved',
        mergedAt: '2026-09-24T10:00:00.000Z',
      });

      // Once the merged state is recorded, later sweeps send nothing more.
      await service.runPullRequestReconciliation();
      await service.flushAll();
      expect(sentStatesFor(OPEN_URL)).toEqual(['open', 'merged']);
      await service.dispose();
    });

    it('sends the merge through a workspace that can sync it', async () => {
      // `stale-copy` lists the same repo first but has no index entry, so the
      // service cannot queue anything for it. The merge must not be dropped.
      const service = await startService();
      const listener = jest.mocked(addWorktreePrStatusChangeListener).mock
        .calls[0][0];
      listener({
        projectId: 'canopy',
        worktreeId: 'tapir',
        status: openStatus(),
      });
      await drainQueuedTurns();
      await service.flushAll();
      readWorkspaceIndexEntryMock.mockImplementation((projectId: unknown) =>
        Promise.resolve(
          projectId === 'stale-copy'
            ? null
            : { id: 'canopy', name: 'My workspace', type: 'single-repo' },
        ),
      );
      jest
        .mocked(listReconcilableRepos)
        .mockResolvedValue([
          { ...tapirRepo([3900]), projectId: 'stale-copy' },
          tapirRepo([3900]),
        ]);

      const result = await service.runPullRequestReconciliation();
      await service.flushAll();

      expect(result?.prsStateUpdated).toBe(1);
      expect(sentStatesFor(OPEN_URL)).toEqual(['open', 'merged']);
      await service.dispose();
    });

    it('reports which PRs it queued', async () => {
      const service = await startService();
      // A state update only updates a row the owner route already holds.
      jest.mocked(addWorktreePrStatusChangeListener).mock.calls[0][0]({
        projectId: 'canopy',
        worktreeId: 'tapir',
        status: openStatus(),
      });
      await drainQueuedTurns();
      await service.flushAll();
      const payload: TelemetryPullRequestPayload = {
        repoId: 'canopy',
        repoName: 'canopy',
        prNumber: 3854,
        prUrl: OPEN_URL,
        title: 'feat: tapir pipeline chain',
        state: 'merged',
        checkStatus: 'none',
        reviewStatus: 'none',
        hasConflicts: false,
        commentCount: 0,
      };

      const queued = await service.enqueueReconciledPullRequests(
        'canopy',
        [payload],
        { stateUpdate: true },
      );
      // A workspace with no resolvable metadata queues nothing.
      readWorkspaceIndexEntryMock.mockResolvedValue(null);
      const refused = await service.enqueueReconciledPullRequests(
        'stale-copy',
        [{ ...payload, prNumber: 3855, prUrl: `${OPEN_URL}5` }],
        { stateUpdate: true },
      );

      expect([...queued]).toEqual([OPEN_URL]);
      expect([...refused]).toEqual([]);
      await service.dispose();
    });

    function seedPrTargets(targets: Record<string, string>): void {
      const target = (state: string): Record<string, unknown> => ({
        externalId: `wt-${state}`,
        turns: {},
        plans: {},
        pullRequests: {
          'tapir#3854': { externalId: `pr-${state}`, prUrl: OPEN_URL, state },
        },
        pipelineRuns: {},
      });
      const syncMap = JSON.stringify({
        version: 2,
        workspaces: {
          canopy: {
            externalIds: {},
            worktrees: {
              tapir: {
                targets: Object.fromEntries(
                  Object.entries(targets).map(([key, state]) => [
                    key,
                    target(state),
                  ]),
                ),
              },
            },
          },
        },
      });
      readFileMock.mockImplementation((path: unknown) =>
        String(path).endsWith('sync-map.json')
          ? Promise.resolve(syncMap)
          : Promise.reject(
              Object.assign(new Error('not found'), { code: 'ENOENT' }),
            ),
      );
    }

    function sentForUrl(): Array<Record<string, unknown>> {
      return allRequests().flatMap(
        (request) =>
          request.workspace.worktrees?.flatMap((worktree) =>
            (worktree.pullRequests ?? [])
              .filter((pr) => pr.prUrl === OPEN_URL)
              .map((pr) => ({
                shareScope: request.shareScope,
                organizationId: request.organizationId,
                state: pr.state,
              })),
          ) ?? [],
      );
    }

    it('updates the owner-scope target the work belongs to, never a misfiled one (CAN-3515)', async () => {
      // Org-owned work with two stale OPEN rows: the owning org's row, and a
      // private row misfiled before owner scoping. Only the owner's row is
      // updated, and later sweeps do not keep retrying the misfiled one.
      ownWorkspaceBy('org-1');
      readPreferencesFileMock.mockResolvedValue(uniformSharing('organization'));
      getWorkspaceContextStateMock.mockReturnValue({
        context: { kind: 'personal' },
      });
      seedPrTargets({ private: 'open', 'org:org-1': 'open' });
      const service = await startService();

      const result = await service.runPullRequestReconciliation();
      await service.flushAll();

      expect(result?.prsStateUpdated).toBe(1);
      expect(sentForUrl()).toEqual([
        {
          shareScope: 'organization',
          organizationId: 'org-1',
          state: 'merged',
        },
      ]);

      const again = await service.runPullRequestReconciliation();
      await service.flushAll();
      expect(again?.prsStateUpdated).toBe(0);
      expect(sentForUrl()).toHaveLength(1);
      await service.dispose();
    });

    it.each([
      ['team-a', 0],
      ['team-b', 1],
    ] as const)(
      'updates a legacy team row only when it is one of the owner’s current teams (recorded %s)',
      async (recordedTeam, expectedUpdates) => {
        // Org-owned work shared at legacy team scope. The member is now only
        // in team-b; a row recorded for team-a is stale and must not trigger
        // an update that would land (and create a row) in team-b.
        ownWorkspaceBy('org-1');
        readPreferencesFileMock.mockResolvedValue(uniformSharing('team'));
        getCanopyCloudCredentialsMock.mockResolvedValue({
          baseUrl: 'https://cloud.example',
          apiKey: 'key',
          capabilities: [],
          teams: [{ id: 'team-b', organization: { id: 'org-1' } }],
          organizations: [{ id: 'org-1' }],
        });
        seedPrTargets({ [`team:${recordedTeam}`]: 'open' });
        const service = await startService();

        const result = await service.runPullRequestReconciliation();
        await service.flushAll();

        expect(result?.prsStateUpdated).toBe(expectedUpdates);
        const sent = allRequests().flatMap(
          (request) =>
            request.workspace.worktrees?.flatMap((worktree) =>
              (worktree.pullRequests ?? [])
                .filter((pr) => pr.prUrl === OPEN_URL)
                .map((pr) => ({ teamId: request.teamId, state: pr.state })),
            ) ?? [],
        );
        expect(sent).toEqual(
          expectedUpdates === 0 ? [] : [{ teamId: 'team-b', state: 'merged' }],
        );
        await service.dispose();
      },
    );

    it('never updates an organization row for Personal work, whatever is selected (CAN-3515)', async () => {
      // Personal work whose private row already reads MERGED, with an OPEN
      // row an organization received before owner scoping. That org row is
      // not the work's; nothing is sent.
      readPreferencesFileMock.mockResolvedValue(uniformSharing('organization'));
      seedPrTargets({ private: 'merged', 'org:org-1': 'open' });
      const service = await startService();

      const result = await service.runPullRequestReconciliation();
      await service.flushAll();

      expect(result?.prsStateUpdated).toBe(0);
      expect(sentForUrl()).toEqual([]);
      await service.dispose();
    });

    it('backfills a PR the sync map recorded before sent states existed', async () => {
      // A sync map written before CAN-3513: the entry has a URL, no state.
      const legacySyncMap = JSON.stringify({
        version: 2,
        workspaces: {
          canopy: {
            externalIds: { private: 'ws-ext' },
            worktrees: {
              tapir: {
                targets: {
                  private: {
                    externalId: 'wt-ext',
                    turns: {},
                    plans: {},
                    pullRequests: {
                      'tapir#3854': { externalId: 'pr-ext', prUrl: OPEN_URL },
                    },
                    pipelineRuns: {},
                  },
                },
              },
            },
          },
        },
      });
      readFileMock.mockImplementation((path: unknown) =>
        String(path).endsWith('sync-map.json')
          ? Promise.resolve(legacySyncMap)
          : Promise.reject(
              Object.assign(new Error('not found'), { code: 'ENOENT' }),
            ),
      );
      const service = await startService();
      expect(service.getSyncedPullRequestUrls()).toContain(OPEN_URL);

      await service.runPullRequestReconciliation();
      await service.flushAll();
      expect(sentStatesFor(OPEN_URL)).toEqual(['merged']);

      await service.runPullRequestReconciliation();
      await service.flushAll();
      expect(sentStatesFor(OPEN_URL)).toEqual(['merged']);
      await service.dispose();
    });
  });

  describe('open and closed PRs from untracked worktrees (CAN-3516)', () => {
    const SIDE_URL = 'https://github.com/o/canopy/pull/4031';

    function sideRepo(): ReconcilableRepo {
      return {
        projectId: 'canopy',
        repoId: 'canopy',
        repoName: 'canopy',
        owner: 'o',
        repo: 'canopy',
        dedupeByPrNumberOnly: true,
        ownedPrNumbers: new Set<number>(),
        unresolvedLiveBranches: new Set<string>(),
        liveBranches: new Set<string>(['main']),
      };
    }

    function sidePr(overrides: Partial<PullRequestRecord>): PullRequestRecord {
      return {
        prNumber: 4031,
        prUrl: SIDE_URL,
        title: 'fix: side-worktree change',
        state: 'open',
        openedAt: '2026-09-23T10:00:00.000Z',
        headRefName: 'agent/side-worktree',
        ...overrides,
      };
    }

    function sentFor(url: string): { worktree: string; state: string }[] {
      return allRequests().flatMap(
        (request) =>
          request.workspace.worktrees?.flatMap((worktree) =>
            (worktree.pullRequests ?? [])
              .filter((pr) => pr.prUrl === url)
              .map((pr) => ({
                worktree: worktree.clientLocalId,
                state: pr.state,
              })),
          ) ?? [],
      );
    }

    it('uploads an opened PR as recovered, then its merge', async () => {
      jest.mocked(listReconcilableRepos).mockResolvedValue([sideRepo()]);
      const listPrs = jest.mocked(listPullRequestsByViewer);
      listPrs.mockResolvedValue([sidePr({})]);
      const service = await startService();

      const first = await service.runPullRequestReconciliation();
      await service.flushAll();
      expect(first?.prsRecovered).toBe(1);
      // Recovered like a merged PR: under the synthetic worktree, no turns.
      expect(sentFor(SIDE_URL)).toEqual([
        { worktree: 'pr-reconciliation', state: 'open' },
      ]);

      listPrs.mockResolvedValue([
        sidePr({ state: 'merged', mergedAt: '2026-09-25T10:00:00.000Z' }),
      ]);
      const second = await service.runPullRequestReconciliation();
      await service.flushAll();
      expect(second?.prsStateUpdated).toBe(1);
      expect(sentFor(SIDE_URL)).toEqual([
        { worktree: 'pr-reconciliation', state: 'open' },
        { worktree: 'pr-reconciliation', state: 'merged' },
      ]);
      await service.dispose();
    });

    it('sends the close of a PR sent while open after its worktree moved on', async () => {
      // tapir sends #3854 while open, then checks out #3900; #3854 is later
      // closed without merging. The sweep must send `closed`, not `merged`.
      const url = 'https://github.com/o/canopy/pull/3854';
      const service = await startService();
      const listener = jest.mocked(addWorktreePrStatusChangeListener).mock
        .calls[0][0];
      listener({
        projectId: 'canopy',
        worktreeId: 'tapir',
        status: {
          lastCheckedAt: '2026-09-21T12:00:00.000Z',
          repos: [
            {
              repoId: 'tapir',
              repoName: 'canopy',
              status: {
                prNumber: 3854,
                prUrl: url,
                title: 'feat: tapir pipeline chain',
                state: 'open',
                checkStatus: 'passing',
                checkDetails: [],
                reviewStatus: 'none',
                reviewers: [],
                hasConflicts: false,
                commentCount: 0,
                updatedAt: '2026-09-21T11:00:00.000Z',
                openedAt: '2026-09-21T10:00:00.000Z',
              },
            },
          ],
        },
      });
      await drainQueuedTurns();
      await service.flushAll();
      jest.mocked(listReconcilableRepos).mockResolvedValue([
        {
          ...sideRepo(),
          ownedPrNumbers: new Set([3900]),
          liveBranches: new Set(['tapir/next']),
        },
      ]);
      jest.mocked(listPullRequestsByViewer).mockResolvedValue([
        sidePr({
          prNumber: 3854,
          prUrl: url,
          state: 'closed',
          headRefName: 'tapir/pipeline-chain',
        }),
      ]);

      const result = await service.runPullRequestReconciliation();
      await service.flushAll();

      expect(result?.prsStateUpdated).toBe(1);
      expect(sentFor(url).map((sent) => sent.state)).toEqual([
        'open',
        'closed',
      ]);
      await service.dispose();
    });

    it('leaves an open PR on a checked-out branch to the poller', async () => {
      jest
        .mocked(listReconcilableRepos)
        .mockResolvedValue([
          { ...sideRepo(), liveBranches: new Set(['agent/side-worktree']) },
        ]);
      jest.mocked(listPullRequestsByViewer).mockResolvedValue([sidePr({})]);
      const service = await startService();

      const result = await service.runPullRequestReconciliation();
      await service.flushAll();

      expect(result?.prsLeftToPoller).toBe(1);
      expect(sentFor(SIDE_URL)).toEqual([]);
      await service.dispose();
    });
  });

  it('drops the sweep copy when the poller claimed the PR first', async () => {
    const service = await startService();
    const listener = jest.mocked(addWorktreePrStatusChangeListener).mock
      .calls[0][0];

    listener({
      projectId: 'canopy',
      worktreeId: 'alligator',
      status: prStatus('alligator'),
    });
    await drainQueuedTurns();
    await service.enqueueReconciledPullRequests('canopy', [
      reconciledPayload(),
    ]);
    await service.flushAll();

    const written = allPrPayloads().filter((pr) => pr.prUrl === PR_URL);
    expect(written).toHaveLength(1);
    await service.dispose();
  });

  it('lets the poller keep reporting a PR after a state update for it', async () => {
    // A state update (CAN-3513) re-sends a PR's merge without taking over its
    // URL. A key-only legacy entry has no restored claim, so an update that
    // claimed the URL would make the poller's later report fail its check.
    const service = await startService();
    const listener = jest.mocked(addWorktreePrStatusChangeListener).mock
      .calls[0][0];

    await service.enqueueReconciledPullRequests(
      'canopy',
      [reconciledPayload()],
      { stateUpdate: true },
    );
    listener({
      projectId: 'canopy',
      worktreeId: 'alligator',
      status: prStatus('alligator'),
    });
    await drainQueuedTurns();
    await service.flushAll();

    const worktrees = allRequests().flatMap(
      (request) =>
        request.workspace.worktrees
          ?.filter((worktree) =>
            (worktree.pullRequests ?? []).some((pr) => pr.prUrl === PR_URL),
          )
          .map((worktree) => worktree.clientLocalId) ?? [],
    );
    expect(worktrees).toContain('alligator');
    await service.dispose();
  });

  it('drops the poller copy when the sweep claimed the PR first', async () => {
    const service = await startService();
    const listener = jest.mocked(addWorktreePrStatusChangeListener).mock
      .calls[0][0];

    await service.enqueueReconciledPullRequests('canopy', [
      reconciledPayload(),
    ]);
    listener({
      projectId: 'canopy',
      worktreeId: 'alligator',
      status: prStatus('alligator'),
    });
    await drainQueuedTurns();
    await service.flushAll();

    const written = allPrPayloads().filter((pr) => pr.prUrl === PR_URL);
    expect(written).toHaveLength(1);
    await service.dispose();
  });

  it('keeps PR ownership across a restart after the row was flushed', async () => {
    // A flushed PR leaves the pending queue, so ownership has to come from the
    // durable sync map. Without it a restart would let the poller create a
    // second server row for a PR the sweep already reported.
    const first = await startService();
    await first.enqueueReconciledPullRequests('canopy', [reconciledPayload()]);
    await first.flushAll();
    expect(first.getSyncedPullRequestUrls()).toContain(PR_URL);
    await first.dispose();

    const persisted = (
      writeFileMock.mock.calls as ReadonlyArray<readonly unknown[]>
    )
      .map((call) => ({ path: String(call[0]), body: String(call[1]) }))
      .filter((call) => call.path.endsWith('sync-map.json'));
    expect(persisted.length).toBeGreaterThan(0);
    const syncMapJson = persisted[persisted.length - 1].body;
    expect(syncMapJson).toContain(PR_URL);

    requestCanopyCloudJsonMock.mockClear();
    readFileMock.mockImplementation((path: unknown) =>
      String(path).endsWith('sync-map.json')
        ? Promise.resolve(syncMapJson)
        : Promise.reject(
            Object.assign(new Error('not found'), { code: 'ENOENT' }),
          ),
    );

    const second = await startService();
    expect(second.getSyncedPullRequestUrls()).toContain(PR_URL);
    const listener = jest.mocked(addWorktreePrStatusChangeListener).mock
      .calls[1][0];
    listener({
      projectId: 'canopy',
      worktreeId: 'alligator',
      status: prStatus('alligator'),
    });
    await drainQueuedTurns();
    await second.flushAll();

    expect(allPrPayloads().filter((pr) => pr.prUrl === PR_URL)).toHaveLength(0);
    await second.dispose();
  });

  it('lets the owning worktree keep amending its own PR row', async () => {
    // open -> merged for the same PR from the same worktree must not be
    // refused by the claim; only a DIFFERENT writer is refused.
    const service = await startService();
    const listener = jest.mocked(addWorktreePrStatusChangeListener).mock
      .calls[0][0];

    listener({
      projectId: 'canopy',
      worktreeId: 'alligator',
      status: prStatus('alligator'),
    });
    await drainQueuedTurns();
    await service.flushAll();
    listener({
      projectId: 'canopy',
      worktreeId: 'alligator',
      status: prStatus('alligator'),
    });
    await drainQueuedTurns();
    await service.flushAll();

    expect(
      allPrPayloads().filter((pr) => pr.prUrl === PR_URL).length,
    ).toBeGreaterThanOrEqual(1);
    await service.dispose();
  });
});

describe('TelemetrySyncService sentinel chat surfaces', () => {
  // App Advisor runs under a sentinel project id with no `workspaces/index.json`
  // row. Before the sentinel fallback, `resolveWorktreeMeta()` returned null for
  // it and every ingress path bailed, so advisor turns never synced at all --
  // they were absent from org statistics and from the activity feed.
  const ADVISOR_ENTRY: Partial<AgentAuditEntry> = {
    id: 'advisor-turn-1',
    eventType: 'app_advisor',
    label: 'App Advisor',
    projectId: 'app-advisor',
    worktreeId: 'work-entry-1',
  };

  it('syncs App Advisor turns even with no project index entry', async () => {
    readWorkspaceIndexEntryMock.mockResolvedValue(null);
    readWorkspaceWorktreesMock.mockResolvedValue([]);
    const service = await startService();

    emitTurn(makeEntry(ADVISOR_ENTRY));
    await drainQueuedTurns();
    await service.flushAll();

    const requests = allRequests();
    expect(requests.length).toBeGreaterThan(0);
    const workspace = requests[0].workspace;
    expect(workspace.name).toBe('App Advisor');
    expect(workspace.workspaceType).toBe('cowork');
    expect(workspace.worktrees?.[0]?.turns?.length).toBe(1);
    await service.dispose();
  });

  it('drops nothing for an ordinary project that has an index entry', async () => {
    // Regression guard: the sentinel fallback must never shadow a real
    // workspace's user-chosen name and type.
    const service = await startService();

    emitTurn();
    await drainQueuedTurns();
    await service.flushAll();

    const workspace = allRequests()[0].workspace;
    expect(workspace.name).toBe('My workspace');
    expect(workspace.workspaceType).toBe('single-repo');
    await service.dispose();
  });
});

// ---------------------------------------------------------------------------
// Attention + presence (CAN-3195)
//
// The attention signal is the reason a push can mean "you are the blocker"
// instead of "something ended". These tests pin the three properties the
// server depends on: the state reaches the wire at all, `detail` obeys the same
// scope rule as an encrypted transcript body, and presence rides the envelope.
// ---------------------------------------------------------------------------
describe('attention and presence', () => {
  it('uploads an attention transition on its own, with no other content', async () => {
    // A blocked chat has by definition produced no new turn — the turn is
    // parked. If attention could not carry an otherwise-empty flush, the
    // signal would only ever arrive alongside unrelated content.
    const service = await startService();

    await service.recordAttention(
      'proj-1',
      'wt-1',
      'chat-1',
      'needs_input',
      'tool_approval',
      { since: '2026-09-19T21:00:00.000Z', detail: 'git push --force' },
    );
    await service.flushAll();

    const request = lastRequest();
    expect(request.attention).toEqual([
      {
        clientChatId: 'chat-1',
        clientWorktreeId: 'wt-1',
        state: 'needs_input',
        reason: 'tool_approval',
        since: '2026-09-19T21:00:00.000Z',
        detail: 'git push --force',
      },
    ]);
    // The attention entry must reference the worktree the envelope carries or
    // the server rejects the whole request.
    expect(request.workspace.worktrees?.[0]?.clientLocalId).toBe('wt-1');
    expect(request.workspace.worktrees?.[0]?.sourceClientLocalId).toBe('wt-1');
    await service.dispose();
  });

  it('names the originating space so phone push honors its notification choice', async () => {
    getDesktopOAuthClientDeviceIdMock.mockResolvedValue('device-1');
    const service = await startService();
    await service.recordAttention(
      'proj-1',
      'wt-1',
      'chat-1',
      'needs_input',
      'tool_approval',
      { since: '2026-09-19T21:00:00.000Z' },
    );
    await service.flushAll();

    // The OAuth device id never leaves the desktop; only its one-way,
    // feature-scoped derivation does.
    const producerId = spaceNotificationProducerId('device-1');
    expect(producerId).not.toContain('device-1');
    expect(lastRequest().workspace.worktrees?.[0]?.notificationSpace).toEqual({
      version: 1,
      producerId,
      ...spaceNotificationSourceRef(producerId, {
        workspaceId: 'proj-1',
        spaceId: 'wt-1',
      }),
      enforcementVersion: 1,
    });
    await service.dispose();
  });

  it.each([
    [
      'code-review-chat',
      'review-scope',
      { workspaceId: 'proj-1', spaceId: 'wt-1' },
    ],
    ['app-advisor', 'advisor-worktree', undefined],
  ] as const)(
    'names the real space for a %s chat, or none',
    async (projectId, worktreeId, expected) => {
      getDesktopOAuthClientDeviceIdMock.mockResolvedValue('device-1');
      const service = await startService();
      await service.recordAttention(
        projectId,
        worktreeId,
        'chat-1',
        'needs_input',
        'tool_approval',
        { since: '2026-09-19T21:00:00.000Z' },
      );
      await service.flushAll();
      expect(lastRequest().workspace.worktrees?.[0]?.notificationSpace).toEqual(
        expected === undefined
          ? undefined
          : {
              version: 1,
              producerId: spaceNotificationProducerId('device-1'),
              ...spaceNotificationSourceRef(
                spaceNotificationProducerId('device-1'),
                expected,
              ),
              enforcementVersion: 1,
            },
      );
      await service.dispose();
    },
  );

  it('drops detail when transcripts do not share the metadata scope', async () => {
    // `detail` is free text (a command, a question), so it mirrors the
    // encrypted-body rule exactly rather than inventing an exception to it.
    // The block itself still notifies; the body is just the branch name.
    readPreferencesFileMock.mockResolvedValue({
      telemetrySharing: {
        transcripts: 'off',
        plans: 'private',
        metadata: 'private',
        summaries: 'private',
      },
    });
    const service = await startService();

    await service.recordAttention(
      'proj-1',
      'wt-1',
      'chat-1',
      'needs_input',
      'ask_user',
      { detail: 'Which database should I migrate?' },
    );
    await service.flushAll();

    const entry = lastRequest().attention?.[0];
    expect(entry?.state).toBe('needs_input');
    expect(entry?.reason).toBe('ask_user');
    expect(entry).not.toHaveProperty('detail');
    await service.dispose();
  });

  it('uploads nothing when metadata sharing is off', async () => {
    // The attention state is envelope-shaped, so it rides `metadata`. Off means
    // no attention push at all, which is the correct reading of the preference.
    readPreferencesFileMock.mockResolvedValue(uniformSharing('off'));
    const service = await startService();

    await service.recordAttention(
      'proj-1',
      'wt-1',
      'chat-1',
      'blocked',
      'usage_limit',
    );
    await service.flushAll();

    expect(requestCanopyCloudJsonMock).not.toHaveBeenCalled();
    await service.dispose();
  });

  it('keeps one live state per chat: a clear supersedes an undelivered block', async () => {
    const service = await startService();

    await service.recordAttention(
      'proj-1',
      'wt-1',
      'chat-1',
      'needs_input',
      'tool_approval',
    );
    await service.recordAttention(
      'proj-1',
      'wt-1',
      'chat-1',
      'clear',
      'tool_approval',
    );
    await service.flushAll();

    const attention = lastRequest().attention;
    expect(attention).toHaveLength(1);
    expect(attention?.[0]?.state).toBe('clear');
    await service.dispose();
  });

  it('does not re-send a delivered transition on the next flush', async () => {
    const service = await startService();

    await service.recordAttention(
      'proj-1',
      'wt-1',
      'chat-1',
      'needs_input',
      'plan_review',
    );
    await service.flushAll();
    expect(lastRequest().attention).toHaveLength(1);

    emitTurn();
    await drainQueuedTurns();
    await service.flushAll();

    expect(lastRequest().attention).toBeUndefined();
    await service.dispose();
  });

  it('drops a queued transition when metadata sharing alone flips off', async () => {
    // Reachable whenever `metadata` goes off while another scope stays on, so
    // `isOff()` does not short-circuit the flush: an org that prohibits
    // metadata but not plans, or the Privacy tab, which sets the four scopes
    // independently.
    //
    // Attention is an envelope field with no group of its own, and the
    // end-of-flush cleanup keeps the pending entry alive while it is non-empty.
    // An undeliverable transition would therefore re-arm the debounce forever
    // and grow the queue file on every rewrite. Dropping is also the honest
    // behavior: metadata sharing off must not deliver a block later.
    const service = await startService();

    await service.recordAttention(
      'proj-1',
      'wt-1',
      'chat-1',
      'needs_input',
      'tool_approval',
    );
    readPreferencesFileMock.mockResolvedValueOnce({
      telemetrySharing: {
        transcripts: 'off',
        plans: 'private',
        metadata: 'off',
        summaries: 'off',
      },
    });
    await service.refreshScopeFromPreferences();
    await service.flushAll();
    requestCanopyCloudJsonMock.mockClear();

    // Re-enable metadata and flush again: the dropped transition must not
    // resurface.
    readPreferencesFileMock.mockResolvedValueOnce({
      ...uniformSharing('private'),
    });
    await service.refreshScopeFromPreferences();
    await service.flushAll();

    expect(requestCanopyCloudJsonMock).not.toHaveBeenCalled();
    await service.dispose();
  });

  it('uploads presence after the telemetry queue has already drained', async () => {
    const service = await startService();

    service.recordUserActivity('proj-1', 'wt-1', '2026-09-19T21:05:00.000Z');
    await jest.advanceTimersByTimeAsync(0);
    await jest.advanceTimersByTimeAsync(TELEMETRY_SYNC_DEBOUNCE_MS);
    await service.flushAll();

    expect(requestCanopyCloudJsonMock).toHaveBeenCalledTimes(1);
    expect(lastRequest().workspace.worktrees?.[0]?.userActiveAt).toBe(
      '2026-09-19T21:05:00.000Z',
    );
    await service.dispose();
  });

  it('preserves newer presence recorded while an older envelope is uploading', async () => {
    let resolveFirstUpload: (value: TelemetryIngestResponse) => void = () => {
      // overwritten synchronously below
    };
    requestCanopyCloudJsonMock.mockImplementationOnce(
      () =>
        new Promise<TelemetryIngestResponse>((resolve) => {
          resolveFirstUpload = resolve;
        }),
    );
    const service = await startService();

    service.recordUserActivity('proj-1', 'wt-1', '2026-09-19T21:05:00.000Z');
    await tick();
    const firstFlush = service.flushWorktreeNow('proj-1', 'wt-1');
    await tick();
    expect(requestCanopyCloudJsonMock).toHaveBeenCalledTimes(1);

    service.recordUserActivity('proj-1', 'wt-1', '2026-09-19T21:06:00.000Z');
    await tick();
    const firstInit = requestCanopyCloudJsonMock.mock.calls[0][1];
    resolveFirstUpload(buildIngestSuccessResponse(firstInit));
    await firstFlush;
    await service.flushAll();

    expect(requestCanopyCloudJsonMock).toHaveBeenCalledTimes(2);
    expect(lastRequest().workspace.worktrees?.[0]?.userActiveAt).toBe(
      '2026-09-19T21:06:00.000Z',
    );
    await service.dispose();
  });

  it('never moves presence backwards', async () => {
    const service = await startService();

    service.recordUserActivity('proj-1', 'wt-1', '2026-09-19T21:05:00.000Z');
    service.recordUserActivity('proj-1', 'wt-1', '2026-09-19T20:00:00.000Z');

    emitTurn();
    await drainQueuedTurns();
    await service.flushAll();

    expect(lastRequest().workspace.worktrees?.[0]?.userActiveAt).toBe(
      '2026-09-19T21:05:00.000Z',
    );
    await service.dispose();
  });
});

describe('TelemetrySyncService health snapshot (CAN-3512)', () => {
  it('reports the queued content waiting to upload', async () => {
    const service = await startService();
    emitTurn(
      makeEntry({
        startedAt: '2026-09-27T09:00:00.000Z',
        completedAt: '2026-09-27T09:05:00.000Z',
      }),
    );
    await drainQueuedTurns();

    expect(service.getHealthSnapshot()).toEqual({
      sharingWanted: true,
      pendingCount: 1,
      oldestPendingAt: '2026-09-27T09:05:00.000Z',
      lastSyncedAt: null,
    });
    await service.dispose();
  });

  function restoreRunOnlyQueue(): void {
    // A queue restored with only a pipeline run (CAN-3512 review).
    const queue = JSON.stringify({
      version: 2,
      projectId: 'proj-1',
      worktreeId: 'wt-1',
      workspaceName: 'My workspace',
      workspaceType: 'single-repo',
      branchName: 'feature/telemetry',
      turns: [],
      plans: [],
      pullRequests: [],
      pipelineRuns: [
        {
          clientPipelineRunId: 'run-1',
          pipelineId: 'pipeline-1',
          pipelineName: 'Build',
          status: 'SUCCESS',
          startedAt: '2026-09-27T07:00:00.000Z',
          completedAt: '2026-09-27T08:00:00.000Z',
        },
      ],
    });
    readFileMock.mockImplementation((path: string) =>
      path === '/tmp/telemetry/queue.jsonl'
        ? Promise.resolve(queue)
        : Promise.reject(new Error('missing')),
    );
  }

  it('counts queued pipeline runs, which the stall detector dates', async () => {
    restoreRunOnlyQueue();
    const service = await startService();

    expect(service.getHealthSnapshot()).toMatchObject({
      pendingCount: 1,
      oldestPendingAt: '2026-09-27T08:00:00.000Z',
    });
    // One count everywhere: the published status, the snapshot and the
    // diagnostic all read the same number.
    expect(service.getStatus().pendingCount).toBe(1);
    await service.dispose();
  });

  it('shows Sync paused · 1 pending on the Privacy line for a run-only stalled queue', async () => {
    restoreRunOnlyQueue();
    // A day after the run finished, with nothing uploaded since.
    jest.setSystemTime(Date.parse('2026-09-28T09:00:00.000Z'));
    const service = await startService();
    const monitor = new TelemetrySyncPauseMonitor({
      service,
      recordDiagnostic: (): void => undefined,
      confirmationMs: 1,
    });
    monitor.start();
    await jest.advanceTimersByTimeAsync(1);
    const status = monitor.getStatus();

    expect(status.pausedReason).toBe('queue-stalled');
    expect(
      renderToStaticMarkup(
        createElement(CloudSyncStatus, { status, cloudConnected: true }),
      ).replace(/<[^>]+>/g, ''),
    ).toBe('Sync paused · 1 pending');
    monitor.dispose();
    await service.dispose();
  });

  it('does not want sharing when every scope is off and nothing is required', async () => {
    readPreferencesFileMock.mockResolvedValue(uniformSharing('off'));
    const service = await startService();

    expect(service.getHealthSnapshot()).toMatchObject({
      sharingWanted: false,
      pendingCount: 0,
      oldestPendingAt: null,
    });
    await service.dispose();
  });

  it('wants sharing when an organization requires a scope the member turned off', async () => {
    readPreferencesFileMock.mockResolvedValue(uniformSharing('off'));
    loadStoredTelemetryEnforcementByOrganizationMock.mockResolvedValue(
      requiring({ metadata: true }),
    );
    const service = await startService();

    expect(service.getHealthSnapshot().sharingWanted).toBe(true);
    await service.dispose();
  });
});

describe('feature opt-in historical delivery (CAN-3383)', () => {
  it.each([
    ['historical', '2026-08-01T00:00:00.000Z', 'private'],
    ['unknown age', undefined, 'private'],
    ['future work', '2026-10-05T12:00:00.000Z', 'organization'],
  ])(
    'keeps rediscovered PRs with %s behind the consent boundary',
    async (_label, openedAt, expectedScope) => {
      governWorkspaceBy(ORG_A);
      jest.setSystemTime(new Date('2026-10-05T12:00:00.000Z'));
      readPreferencesFileMock.mockResolvedValue({
        ...uniformSharing('organization'),
        dataSharingOptInHistory: [
          {
            enabledAt: '2026-09-01T00:00:00.000Z',
            sharing: uniformSharing('private').telemetrySharing,
          },
        ],
      });
      const service = await startService();
      try {
        await service.enqueueReconciledPullRequests('proj-1', [
          {
            repoId: 'canopy',
            repoName: 'canopy',
            prNumber: 3383,
            prUrl: 'https://github.com/o/canopy/pull/3383',
            title: 'Rediscovered PR',
            state: 'merged',
            checkStatus: 'none',
            reviewStatus: 'none',
            hasConflicts: false,
            commentCount: 0,
            ...(openedAt ? { openedAt } : {}),
          },
        ]);
        await service.flushAll();
        const request = allRequests().find((item) =>
          item.workspace.worktrees?.some((worktree) =>
            worktree.pullRequests?.some((pr) => pr.prNumber === 3383),
          ),
        );
        expect(request).toBeDefined();
        expect(request?.shareScope).toBe(expectedScope);
      } finally {
        await service.dispose();
      }
    },
  );

  it('keeps queued private turns private, while future org work uses new consent', async () => {
    governWorkspaceBy(ORG_A);
    const service = await startService();
    emitTurn(makeEntry({ id: 'before-consent' }));
    await drainQueuedTurns();
    readPreferencesFileMock.mockResolvedValue({
      ...uniformSharing('organization'),
      dataSharingOptInHistory: [
        {
          enabledAt: '2026-09-01T00:00:00.000Z',
          sharing: uniformSharing('private').telemetrySharing,
        },
      ],
    });
    await service.refreshScopeFromPreferences();
    await service.flushAll();
    const historical = allRequests().find((request) =>
      request.workspace.worktrees?.[0]?.turns?.some(
        (turn) => turn.clientTurnId === 'before-consent',
      ),
    );
    expect(historical?.shareScope).toBe('private');
    requestCanopyCloudJsonMock.mockClear();
    jest.setSystemTime(new Date('2026-10-05T12:00:00.000Z'));
    emitTurn(
      makeEntry({ id: 'after-consent', startedAt: '2026-10-05T12:00:00.000Z' }),
    );
    await drainQueuedTurns();
    await service.flushAll();
    expect(lastRequest().shareScope).toBe('organization');
    expect(lastRequest().organizationId).toBe(ORG_A);
    await service.dispose();
  });
});
