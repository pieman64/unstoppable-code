import { watchDelegatesCompatibilityResult } from '../watch-delegates-tombstone';
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import type * as NodeCrypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import type {
  AgentDelegationEvent,
  AgentDelegationSnapshot,
  DelegationApplyFailure,
} from '@canopy/protocol/delegation';
import {
  DelegationApplyError,
  type AgentDelegationBrokerOptions,
} from '../broker';
import type { AgentDelegationBroker, StoredDelegationLegacy } from '../broker';
import { FileDelegationStorage } from '../storage';
import type { DelegationParentContext } from '../types';
import {
  baseTask,
  createBrokerHarness,
  flushBroker,
  rootParent,
  type BrokerHarness,
} from './broker-harness';
import { routeFixture } from './fixtures';

const FIXTURE_DIRECTORY = path.join(__dirname, 'fixtures/legacy-record-golden');
const FIXTURE_PATH = path.join(FIXTURE_DIRECTORY, 'legacy-record-golden.json');
const ADDITIONS_FIXTURE_PATH = path.join(
  FIXTURE_DIRECTORY,
  'legacy-record-golden-review-round-1.json',
);
const CAPTURE_GOLDENS =
  process.env.CANOPY_CAPTURE_LEGACY_RECORD_GOLDENS === '1';
const FIXED_NOW = 1_760_000_000_000;
const UUID_PREFIX = '00000000-0000-4000-8000-';
jest.setTimeout(60_000);

interface FileHarness {
  readonly broker: AgentDelegationBroker;
  readonly runner: BrokerHarness['runner'];
  readonly storage: FileDelegationStorage;
  readonly recordsDirectory: string;
}

interface SettledNotice {
  readonly parent: DelegationParentContext;
  readonly delegationId: string;
  readonly result: unknown;
}

interface CapacityReply {
  readonly cap: string;
  readonly reply: unknown;
}

interface LegacyRecordGoldens {
  readonly recordBytes: {
    readonly v1BeforeOwnedUpdate: string;
    readonly v1AfterOwnedUpdate: string;
    readonly v2AfterLaunch: string;
    readonly v2AfterCompletion: string;
    readonly v2AfterFollowUp: string;
    readonly v2AfterSteer: string;
    readonly v2AfterInterrupt: string;
    readonly v2AfterStopRequest: string;
    readonly v2AfterStopAliases: string;
    readonly v2AfterStopResolution: string;
    readonly v2AfterFailedStop: string;
    readonly v2AfterResume: string;
    readonly atHistory16Results17: string;
    readonly restartInFlightInterrupted: string;
    readonly restartNeverDispatched: string;
  };
  readonly snapshots: {
    readonly stopAccepted: AgentDelegationSnapshot;
    readonly stopCompleted: AgentDelegationSnapshot;
    readonly stopFailed: AgentDelegationSnapshot;
    readonly afterResume: AgentDelegationSnapshot;
  };
  readonly watches: {
    readonly pending: unknown;
    readonly settled: unknown;
    readonly historicalGeneration: unknown;
    readonly registrationResult: unknown;
    readonly settlementNotices: readonly SettledNotice[];
    readonly registrationCatchUpNotices: readonly SettledNotice[];
  };
  readonly replays: {
    readonly stopSameKey: unknown;
    readonly stopChangedTarget: unknown;
    readonly controlSameKey: unknown;
    readonly controlChangedArguments: unknown;
    readonly capacityReplies: readonly CapacityReply[];
  };
  readonly caps: {
    readonly historyCount: number;
    readonly resultCount: number;
  };
  readonly restarts: {
    readonly inFlightSnapshot: AgentDelegationSnapshot;
    readonly neverDispatchedSnapshot: AgentDelegationSnapshot;
    readonly relaunchedRunCount: number;
  };
}

interface StorageRejection {
  readonly case: string;
  readonly code: string;
  readonly message: string;
}

interface ApplyFailureReplay {
  readonly acceptedControl: unknown;
  readonly firstReply: unknown;
  readonly inProcessReplay: unknown;
  readonly restartReplay: unknown;
  readonly persistedControl: unknown;
  readonly causalErrors: readonly string[];
}

interface LegacyRecordGoldenAdditions {
  readonly guards: {
    readonly continuationCandidates: {
      readonly baseline: readonly unknown[];
      readonly historyAt16: readonly unknown[];
      readonly controlsAt64: readonly unknown[];
      readonly baselineHistoryCount: number;
      readonly historyAt16Count: number;
      readonly baselineControlsCount: number;
      readonly controlsAt64Count: number;
      readonly baselineCandidatePresent: boolean;
      readonly historyCapCandidateAbsent: boolean;
      readonly controlsCapCandidateAbsent: boolean;
    };
    readonly materializeAtHistory16: {
      readonly belowCapHistoryCount: number;
      readonly belowCapReply: unknown;
      readonly belowCapCausalErrors: readonly string[];
      readonly belowCapLaunchedRunCount: number;
      readonly inputControlCounts: number;
      readonly inputHistoryCount: number;
      readonly reply: unknown;
      readonly causalErrors: readonly string[];
      readonly storedControl: unknown;
      readonly launchedRunCount: number;
    };
    readonly hostMessageControlsAt64: {
      readonly belowCapReply: unknown;
      readonly atCapReply: unknown;
      readonly historyCount: number;
      readonly controlsAfterAtCapAttempt: number;
      readonly promptAfterAtCapAttempt: string;
    };
  };
  readonly replays: {
    readonly userFirstAcknowledgement: unknown;
    readonly userAcknowledgementReplay: unknown;
    readonly userAcknowledgementAfterRestart: unknown;
    readonly userFirstError: unknown;
    readonly userErrorReplay: unknown;
    readonly userErrorAfterRestart: unknown;
    readonly applyFailed: ApplyFailureReplay;
  };
  readonly v1Normalization: {
    readonly rawV1Bytes: string;
    readonly rawVersion: number;
    readonly hadResultsField: boolean;
    readonly historyCount: number;
    readonly resultCount: number;
    readonly historyResult: unknown;
    readonly currentStateResult: unknown;
  };
  readonly storageRejections: readonly StorageRejection[];
}

interface CaptureRun {
  readonly temporaryRoot: string;
  readonly actual: LegacyRecordGoldens;
  readonly additions: LegacyRecordGoldenAdditions;
}

let captureRun: CaptureRun | undefined;
let restoreClock: (() => void) | undefined;
let materializationBaselineRecord: StoredDelegationLegacy | undefined;

jest.mock('node:crypto', () => {
  const actual = jest.requireActual<typeof NodeCrypto>('node:crypto');
  let uuidIndex = 0;
  return {
    ...actual,
    randomUUID: (): string => {
      uuidIndex += 1;
      return `00000000-0000-4000-8000-${String(uuidIndex).padStart(12, '0')}`;
    },
  };
});

function fixedUuid(index: number): string {
  return `${UUID_PREFIX}${String(index).padStart(12, '0')}`;
}

function fixedHash(index: number): string {
  return index.toString(16).padStart(64, '0');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function capturedError(error: unknown): {
  readonly code: string;
  readonly message: string;
} {
  if (!isRecord(error)) throw new Error('Expected a validation error object');
  const message =
    typeof error.message === 'string' ? error.message : 'Missing error message';
  const issues = Array.isArray(error.issues) ? error.issues : [];
  const firstIssue = issues.find(isRecord);
  const code =
    firstIssue && typeof firstIssue.code === 'string'
      ? firstIssue.code
      : typeof error.code === 'string'
        ? error.code
        : 'missing-code';
  return { code, message };
}

async function captureStorageRejection(
  storage: FileDelegationStorage,
  caseName: string,
  malformedRecord: unknown,
): Promise<StorageRejection> {
  try {
    // @ts-expect-error Exercise the strict runtime codec with malformed stored data.
    await storage.commit(malformedRecord);
  } catch (error) {
    return { case: caseName, ...capturedError(error) };
  }
  throw new Error(`Expected storage rejection for ${caseName}`);
}

function resumableOptions(
  overrides: Partial<AgentDelegationBrokerOptions> = {},
): Partial<AgentDelegationBrokerOptions> {
  return {
    asyncAdmission: true,
    cwd: '/legacy-golden/worktree',
    resolveRoute: () =>
      Promise.resolve({
        ok: true,
        value: routeFixture({
          capabilities: ['read', 'progress', 'resume'],
        }),
      }),
    ...overrides,
  };
}

function createFileHarness(
  temporaryRoot: string,
  scenario: string,
  options: Partial<AgentDelegationBrokerOptions> = {},
): FileHarness {
  const recordsDirectory = path.join(temporaryRoot, scenario, 'records');
  const storage = new FileDelegationStorage(recordsDirectory);
  const harness = createBrokerHarness(
    { cwd: '/legacy-golden/worktree', ...options },
    storage,
  );
  return {
    broker: harness.broker,
    runner: harness.runner,
    storage,
    recordsDirectory,
  };
}

async function spawn(
  broker: AgentDelegationBroker,
  toolCallId: string,
): Promise<string> {
  const result = await broker.spawn({ ...rootParent, toolCallId }, baseTask);
  if (!result.ok) throw new Error(`Expected ${toolCallId} to be admitted`);
  return result.value.delegationId;
}

async function waitForGeneration(
  runner: FileHarness['runner'],
  delegationId: string,
  runGeneration: number,
): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (
      runner.starts.some(
        (request) =>
          request.delegationId === delegationId &&
          request.runGeneration === runGeneration,
      )
    )
      return;
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(
    `Expected generation ${runGeneration} to launch for ${delegationId}`,
  );
}

async function sendEvent(
  runner: FileHarness['runner'],
  delegationId: string,
  runGeneration: number,
  sequence: number,
  event: AgentDelegationEvent['event'],
): Promise<void> {
  const sink = runner.sinks.get(delegationId);
  if (!sink) throw new Error(`Expected an event sink for ${delegationId}`);
  await sink({
    delegationId,
    runGeneration,
    sequence,
    occurredAt: FIXED_NOW,
    event,
  });
}

async function recordBytes(
  recordsDirectory: string,
  delegationId: string,
): Promise<string> {
  return readFile(path.join(recordsDirectory, `${delegationId}.json`), 'utf8');
}

async function storedRecord(
  storage: FileDelegationStorage,
  delegationId: string,
): Promise<StoredDelegationLegacy> {
  const record = await storage.loadOne(delegationId);
  if (!record) throw new Error(`Expected a stored record for ${delegationId}`);
  if (record.version === 3) throw new Error();
  return record;
}

function snapshotOf(
  broker: AgentDelegationBroker,
  delegationId: string,
): AgentDelegationSnapshot {
  const snapshot = broker.inspect(rootParent, delegationId);
  if (!snapshot) throw new Error(`Expected a snapshot for ${delegationId}`);
  return snapshot;
}

async function waitForStatus(
  broker: AgentDelegationBroker,
  delegationId: string,
  status: AgentDelegationSnapshot['status'],
): Promise<AgentDelegationSnapshot> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const snapshot = broker.inspect(rootParent, delegationId);
    if (snapshot?.status === status) return snapshot;
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Expected ${delegationId} to reach ${status}`);
}

async function waitForControlStatus(
  broker: AgentDelegationBroker,
  delegationId: string,
  status: 'accepted' | 'completed' | 'failed',
): Promise<AgentDelegationSnapshot> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const snapshot = broker.inspect(rootParent, delegationId);
    if (snapshot?.control?.status === status) return snapshot;
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Expected the control for ${delegationId} to be ${status}`);
}

async function waitForStopStatus(
  broker: AgentDelegationBroker,
  delegationId: string,
  status: 'accepted' | 'completed' | 'failed',
): Promise<AgentDelegationSnapshot> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const snapshot = broker.inspect(rootParent, delegationId);
    if (snapshot?.stopRequested?.status === status) return snapshot;
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(
    `Expected the stop request for ${delegationId} to be ${status}`,
  );
}

function requireCapacityReply(
  result:
    | { readonly ok: true }
    | { readonly ok: false; readonly error: { readonly code: string } },
  cap: string,
): void {
  if (result.ok || result.error.code !== 'capacity_exceeded')
    throw new Error(`Expected cap ${cap} to return capacity_exceeded`);
}

function controlsAtLimit(
  count: number,
): NonNullable<StoredDelegationLegacy['controls']> {
  const controls: Array<
    NonNullable<StoredDelegationLegacy['controls']>[number]
  > = [];
  for (let index = 0; index < count; index += 1) {
    controls.push({
      operationId: fixedUuid(10_000 + index),
      key: fixedHash(10_000 + index),
      requestHash: fixedHash(20_000 + index),
      operation: 'interrupt',
      status: 'completed',
    });
  }
  return controls;
}

function stopRequestsAtLimit(
  count: number,
): NonNullable<StoredDelegationLegacy['stopRequests']> {
  const requests: Array<
    NonNullable<StoredDelegationLegacy['stopRequests']>[number]
  > = [];
  for (let index = 0; index < count; index += 1) {
    requests.push({
      operationId: fixedUuid(30_000 + index),
      key: fixedHash(30_000 + index),
      runGeneration: 1,
      status: 'completed',
    });
  }
  return requests;
}

function activeStopRequest(
  status: 'accepted' | 'failed',
): NonNullable<StoredDelegationLegacy['stopRequested']> {
  return {
    operationId: fixedUuid(40_000),
    key: fixedHash(40_000),
    runGeneration: 1,
    status,
  };
}

async function completedRecord(
  temporaryRoot: string,
  scenario: string,
): Promise<{ readonly harness: FileHarness; readonly delegationId: string }> {
  const harness = createFileHarness(
    temporaryRoot,
    scenario,
    resumableOptions(),
  );
  await harness.broker.initialize();
  const delegationId = await spawn(harness.broker, `${scenario}-spawn`);
  await waitForGeneration(harness.runner, delegationId, 1);
  await sendEvent(harness.runner, delegationId, 1, 1, {
    type: 'started',
    nativeSessionId: 'legacy-golden-native',
  });
  await sendEvent(harness.runner, delegationId, 1, 2, {
    type: 'terminal',
    status: 'completed',
    finalText: `${scenario} completed`,
  });
  return { harness, delegationId };
}

async function openStoredRecord(
  temporaryRoot: string,
  scenario: string,
  record: StoredDelegationLegacy,
  options: Partial<AgentDelegationBrokerOptions> = {},
): Promise<FileHarness> {
  const harness = createFileHarness(
    temporaryRoot,
    scenario,
    resumableOptions(options),
  );
  await harness.storage.commit(record);
  await harness.broker.initialize();
  return harness;
}

async function captureLegacyGoldens(
  temporaryRoot: string,
): Promise<LegacyRecordGoldens> {
  let v1BeforeOwnedUpdate = '';
  let v1AfterOwnedUpdate = '';

  const v1Harness = createFileHarness(
    temporaryRoot,
    'v1-owned-update',
    resumableOptions(),
  );
  await v1Harness.broker.initialize();
  const v1Id = await spawn(v1Harness.broker, 'v1-before-update');
  await waitForGeneration(v1Harness.runner, v1Id, 1);
  await sendEvent(v1Harness.runner, v1Id, 1, 1, {
    type: 'started',
    nativeSessionId: 'v1-native-session',
  });
  await sendEvent(v1Harness.runner, v1Id, 1, 2, {
    type: 'terminal',
    status: 'completed',
    finalText: 'v1 fixture result',
  });
  const v1Stored = await storedRecord(v1Harness.storage, v1Id);
  // Install the legacy fixture only after its previous owner is closed. A
  // live broker now rejects replacement files that mismatch its summary.
  await v1Harness.broker.close();
  await v1Harness.storage.commit({
    ...v1Stored,
    version: 1,
    state: { ...v1Stored.state, approvalPending: true },
  });
  v1BeforeOwnedUpdate = await recordBytes(v1Harness.recordsDirectory, v1Id);
  const v1Restarted = createFileHarness(
    temporaryRoot,
    'v1-owned-update',
    resumableOptions(),
  );
  await v1Restarted.broker.initialize();
  v1AfterOwnedUpdate = await recordBytes(v1Restarted.recordsDirectory, v1Id);
  await v1Restarted.broker.close();

  const notices: SettledNotice[] = [];
  const lifecycle = createFileHarness(
    temporaryRoot,
    'v2-lifecycle',
    resumableOptions({
      onSettled: (parent, delegationId, result) => {
        notices.push({ parent, delegationId, result });
        return Promise.resolve();
      },
    }),
  );
  let v2AfterLaunch = '';
  let v2AfterCompletion = '';
  let v2AfterFollowUp = '';
  let v2AfterSteer = '';
  let v2AfterInterrupt = '';
  await lifecycle.broker.initialize();
  const lifecycleId = await spawn(lifecycle.broker, 'v2-lifecycle-spawn');
  await waitForGeneration(lifecycle.runner, lifecycleId, 1);
  v2AfterLaunch = await recordBytes(lifecycle.recordsDirectory, lifecycleId);

  const pendingWatch = await lifecycle.broker.watchTargetStates([
    { delegationId: lifecycleId, runGeneration: 1 },
  ]);
  await sendEvent(lifecycle.runner, lifecycleId, 1, 1, {
    type: 'started',
    nativeSessionId: 'v2-lifecycle-native',
  });
  await sendEvent(lifecycle.runner, lifecycleId, 1, 2, {
    type: 'terminal',
    status: 'completed',
    finalText: 'first v2 result',
  });
  v2AfterCompletion = await recordBytes(
    lifecycle.recordsDirectory,
    lifecycleId,
  );

  const settledWatch = await lifecycle.broker.watchTargetStates([
    { delegationId: lifecycleId, runGeneration: 1 },
  ]);
  const settlementNotices = notices.slice();
  const noticeCountBeforeCatchUp = notices.length;
  const registrationResult = watchDelegatesCompatibilityResult({
    delegationIds: [lifecycleId],
    mode: 'all',
    timeoutMs: 60_000,
  });
  const registrationCatchUpNotices = notices.slice(noticeCountBeforeCatchUp);

  const followUp = await lifecycle.broker.manage(
    { ...rootParent, toolCallId: 'v2-lifecycle-follow-up' },
    {
      delegationId: lifecycleId,
      operation: 'follow_up',
      message: 'Continue the legacy golden run.',
    },
  );
  if (!followUp.ok) throw new Error('Expected the legacy follow-up');
  await waitForGeneration(lifecycle.runner, lifecycleId, 2);
  await sendEvent(lifecycle.runner, lifecycleId, 2, 1, {
    type: 'started',
    nativeSessionId: 'v2-lifecycle-native',
  });
  v2AfterFollowUp = await recordBytes(lifecycle.recordsDirectory, lifecycleId);

  const historicalWatch = await lifecycle.broker.watchTargetStates([
    { delegationId: lifecycleId, runGeneration: 1 },
  ]);

  const steerCaller = { ...rootParent, toolCallId: 'v2-lifecycle-steer' };
  const steerInput = {
    delegationId: lifecycleId,
    operation: 'steer',
    message: 'Check one more file.',
  };
  const steerResult = await lifecycle.broker.manage(steerCaller, steerInput);
  if (!steerResult.ok) throw new Error('Expected the legacy steer');
  await waitForControlStatus(lifecycle.broker, lifecycleId, 'completed');
  const controlSameKey = await lifecycle.broker.manage(steerCaller, steerInput);
  const controlChangedArguments = await lifecycle.broker.manage(steerCaller, {
    ...steerInput,
    message: 'Changed arguments must not replay.',
  });
  v2AfterSteer = await recordBytes(lifecycle.recordsDirectory, lifecycleId);

  const interrupt = await lifecycle.broker.manage(
    { ...rootParent, toolCallId: 'v2-lifecycle-interrupt' },
    { delegationId: lifecycleId, operation: 'interrupt' },
  );
  if (!interrupt.ok) throw new Error('Expected the legacy interrupt');
  await waitForStatus(lifecycle.broker, lifecycleId, 'interrupted');
  // The interrupt control resolves in a later commit; capture after it.
  await waitForControlStatus(lifecycle.broker, lifecycleId, 'completed');
  v2AfterInterrupt = await recordBytes(lifecycle.recordsDirectory, lifecycleId);
  await lifecycle.broker.close();

  const stopHarness = createFileHarness(
    temporaryRoot,
    'v2-stop-and-replay',
    resumableOptions(),
  );
  await stopHarness.broker.initialize();
  const stoppedId = await spawn(stopHarness.broker, 'v2-stop-spawn');
  const otherId = await spawn(stopHarness.broker, 'v2-stop-other-spawn');
  await waitForGeneration(stopHarness.runner, stoppedId, 1);
  await waitForGeneration(stopHarness.runner, otherId, 1);
  await sendEvent(stopHarness.runner, stoppedId, 1, 1, {
    type: 'started',
    nativeSessionId: 'v2-stop-native',
  });
  await sendEvent(stopHarness.runner, otherId, 1, 1, {
    type: 'started',
    nativeSessionId: 'v2-other-native',
  });
  let releaseStop: () => void = () => undefined;
  const stopGate = new Promise<void>((resolve) => {
    releaseStop = resolve;
  });
  const stopSpy = jest
    .spyOn(stopHarness.runner, 'stop')
    .mockImplementation(async () => {
      await stopGate;
      return { stopped: true };
    });
  let stopAccepted = snapshotOf(stopHarness.broker, stoppedId);
  let stopCompleted = stopAccepted;
  let afterResume = stopAccepted;
  let stopSameKey: unknown;
  let stopChangedTarget: unknown;
  let v2AfterStopRequest = '';
  let v2AfterStopAliases = '';
  let v2AfterStopResolution = '';
  let v2AfterFailedStop = '';
  let v2AfterResume = '';
  try {
    const stopCaller = { ...rootParent, toolCallId: 'legacy-stop-main' };
    const initialStop = await stopHarness.broker.requestStop(
      stopCaller,
      stoppedId,
    );
    if (!initialStop.ok) throw new Error('Expected the accepted stop');
    await flushBroker();
    stopAccepted = await waitForStopStatus(
      stopHarness.broker,
      stoppedId,
      'accepted',
    );
    v2AfterStopRequest = await recordBytes(
      stopHarness.recordsDirectory,
      stoppedId,
    );
    stopSameKey = await stopHarness.broker.requestStop(stopCaller, stoppedId);
    stopChangedTarget = await stopHarness.broker.requestStop(
      stopCaller,
      otherId,
    );
    const alias = await stopHarness.broker.requestStop(
      { ...stopCaller, toolCallId: 'legacy-stop-alias' },
      stoppedId,
    );
    if (!alias.ok) throw new Error('Expected the stop alias to coalesce');
    v2AfterStopAliases = await recordBytes(
      stopHarness.recordsDirectory,
      stoppedId,
    );
    releaseStop();
    stopSpy.mockRestore();
    stopCompleted = await waitForStopStatus(
      stopHarness.broker,
      stoppedId,
      'completed',
    );
    v2AfterStopResolution = await recordBytes(
      stopHarness.recordsDirectory,
      stoppedId,
    );
    const resumed = await stopHarness.broker.manage(
      { ...rootParent, toolCallId: 'legacy-stop-resume' },
      {
        delegationId: stoppedId,
        operation: 'resume',
        message: 'Resume after the legacy stop.',
      },
    );
    if (!resumed.ok) throw new Error('Expected explicit stop resume');
    await waitForGeneration(stopHarness.runner, stoppedId, 2);
    afterResume = snapshotOf(stopHarness.broker, stoppedId);
    v2AfterResume = await recordBytes(stopHarness.recordsDirectory, stoppedId);
  } finally {
    releaseStop();
    stopSpy.mockRestore();
    await stopHarness.broker.close();
  }

  const failedStopHarness = createFileHarness(
    temporaryRoot,
    'v2-failed-stop',
    resumableOptions(),
  );
  await failedStopHarness.broker.initialize();
  const failedStopId = await spawn(
    failedStopHarness.broker,
    'v2-failed-stop-spawn',
  );
  await waitForGeneration(failedStopHarness.runner, failedStopId, 1);
  await sendEvent(failedStopHarness.runner, failedStopId, 1, 1, {
    type: 'started',
    nativeSessionId: 'v2-failed-stop-native',
  });
  const failedStopSpy = jest
    .spyOn(failedStopHarness.runner, 'stop')
    .mockRejectedValue(new Error('fixed legacy stop failure'));
  const failedStopRequest = await failedStopHarness.broker.requestStop(
    { ...rootParent, toolCallId: 'legacy-failed-stop' },
    failedStopId,
  );
  if (!failedStopRequest.ok) throw new Error('Expected a failed stop attempt');
  const stopFailed = await waitForStopStatus(
    failedStopHarness.broker,
    failedStopId,
    'failed',
  );
  v2AfterFailedStop = await recordBytes(
    failedStopHarness.recordsDirectory,
    failedStopId,
  );
  failedStopSpy.mockRestore();
  await failedStopHarness.broker.close();

  const capHarness = createFileHarness(
    temporaryRoot,
    'history-results-cap',
    resumableOptions(),
  );
  await capHarness.broker.initialize();
  const capId = await spawn(capHarness.broker, 'history-results-cap-spawn');
  let v2AtHistory16Results17 = '';
  let historyCount = 0;
  let resultCount = 0;
  for (let generation = 1; generation <= 17; generation += 1) {
    await waitForGeneration(capHarness.runner, capId, generation);
    await sendEvent(capHarness.runner, capId, generation, 1, {
      type: 'started',
      nativeSessionId: 'history-results-native',
    });
    await sendEvent(capHarness.runner, capId, generation, 2, {
      type: 'terminal',
      status: 'completed',
      finalText: `generation ${generation} result`,
    });
    if (generation === 16)
      materializationBaselineRecord = await storedRecord(
        capHarness.storage,
        capId,
      );
    if (generation < 17) {
      const continuation = await capHarness.broker.manage(
        { ...rootParent, toolCallId: `history-results-follow-${generation}` },
        {
          delegationId: capId,
          operation: 'follow_up',
          message: `Continue generation ${generation}.`,
        },
      );
      if (!continuation.ok)
        throw new Error(`Expected generation ${generation + 1} to continue`);
    }
  }
  const cappedRecord = await storedRecord(capHarness.storage, capId);
  historyCount = cappedRecord.history?.length ?? 0;
  resultCount = cappedRecord.results?.length ?? 0;
  if (historyCount !== 16 || resultCount !== 17)
    throw new Error('Expected the legacy history and results codec caps');
  v2AtHistory16Results17 = await recordBytes(
    capHarness.recordsDirectory,
    capId,
  );
  const cap1Reply = await capHarness.broker.deliverHostMessage(
    capId,
    'Host delivery at the retained history cap.',
    fixedUuid(50_001),
  );
  requireCapacityReply(cap1Reply, '1');
  await capHarness.broker.close();

  const queuedHarness = createFileHarness(
    temporaryRoot,
    'queued-control-capacity',
    resumableOptions({ capacity: 1 }),
  );
  await queuedHarness.broker.initialize();
  const queuedId = await spawn(queuedHarness.broker, 'queued-target-spawn');
  await waitForGeneration(queuedHarness.runner, queuedId, 1);
  await sendEvent(queuedHarness.runner, queuedId, 1, 1, {
    type: 'started',
    nativeSessionId: 'queued-capacity-native',
  });
  await sendEvent(queuedHarness.runner, queuedId, 1, 2, {
    type: 'terminal',
    status: 'completed',
    finalText: 'queued target completed',
  });
  const blockerId = await spawn(queuedHarness.broker, 'queued-blocker-spawn');
  await waitForGeneration(queuedHarness.runner, blockerId, 1);
  await sendEvent(queuedHarness.runner, blockerId, 1, 1, {
    type: 'started',
    nativeSessionId: 'queued-blocker-native',
  });
  const queuedFollowUp = await queuedHarness.broker.manage(
    { ...rootParent, toolCallId: 'queued-target-follow-up' },
    {
      delegationId: queuedId,
      operation: 'follow_up',
      message: 'Queue the next target generation.',
    },
  );
  if (!queuedFollowUp.ok)
    throw new Error('Expected queued follow-up admission');
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (queuedHarness.broker.inspect(rootParent, queuedId)?.phase === 'queued')
      break;
    await flushBroker();
  }
  if (queuedHarness.broker.inspect(rootParent, queuedId)?.phase !== 'queued')
    throw new Error('Expected the follow-up to remain queued');
  for (let index = 0; index < 64; index += 1) {
    const coalesced = await queuedHarness.broker.deliverHostMessage(
      queuedId,
      `Coalesced host message ${index}.`,
      fixedUuid(51_000 + index),
    );
    if (!coalesced.ok)
      throw new Error('Expected the within-cap host message to coalesce');
  }
  const cap2Reply = await queuedHarness.broker.deliverHostMessage(
    queuedId,
    'Host coalescing at the retained command cap.',
    fixedUuid(52_000),
  );
  requireCapacityReply(cap2Reply, '2');
  const cap4Reply = await queuedHarness.broker.manage(
    { ...rootParent, toolCallId: 'control-at-cap' },
    { delegationId: queuedId, operation: 'interrupt' },
  );
  requireCapacityReply(cap4Reply, '4');
  await queuedHarness.broker.close();

  const seed = await completedRecord(temporaryRoot, 'stop-cap-seed');
  await seed.harness.broker.close();
  const seedRecord = await storedRecord(
    seed.harness.storage,
    seed.delegationId,
  );

  const cap5Harness = await openStoredRecord(temporaryRoot, 'stop-cap-5', {
    ...seedRecord,
    stopRequested: activeStopRequest('accepted'),
    stopRequests: stopRequestsAtLimit(64),
  });
  const cap5Reply = await cap5Harness.broker.manage(
    { ...rootParent, toolCallId: 'resume-stop-cap' },
    {
      delegationId: seed.delegationId,
      operation: 'resume',
      message: 'Resume at the stop receipt cap.',
    },
  );
  requireCapacityReply(cap5Reply, '5');
  await cap5Harness.broker.close();

  const cap7Harness = await openStoredRecord(temporaryRoot, 'stop-cap-7', {
    ...seedRecord,
    stopRequested: activeStopRequest('failed'),
    stopRequests: stopRequestsAtLimit(64),
  });
  const cap7Reply = await cap7Harness.broker.requestStop(
    { ...rootParent, toolCallId: 'failed-stop-rollover-cap' },
    seed.delegationId,
  );
  requireCapacityReply(cap7Reply, '7');
  await cap7Harness.broker.close();

  const cap8Harness = await openStoredRecord(temporaryRoot, 'stop-cap-8', {
    ...seedRecord,
    stopRequested: activeStopRequest('accepted'),
    stopRequests: stopRequestsAtLimit(63),
  });
  const cap8Reply = await cap8Harness.broker.requestStop(
    { ...rootParent, toolCallId: 'stop-alias-cap' },
    seed.delegationId,
  );
  requireCapacityReply(cap8Reply, '8');
  await cap8Harness.broker.close();

  const cap9Harness = await openStoredRecord(temporaryRoot, 'stop-cap-9', {
    ...seedRecord,
    stopRequests: stopRequestsAtLimit(64),
  });
  const cap9Reply = await cap9Harness.broker.requestStop(
    { ...rootParent, toolCallId: 'new-stop-at-cap' },
    seed.delegationId,
  );
  requireCapacityReply(cap9Reply, '9');
  await cap9Harness.broker.close();

  const cap4Seed = await completedRecord(temporaryRoot, 'control-cap-seed');
  await cap4Seed.harness.broker.close();
  const cap4SeedRecord = await storedRecord(
    cap4Seed.harness.storage,
    cap4Seed.delegationId,
  );
  const cap4ArrayHarness = await openStoredRecord(
    temporaryRoot,
    'control-cap-4-array',
    { ...cap4SeedRecord, controls: controlsAtLimit(64) },
  );
  const cap4ArrayReply = await cap4ArrayHarness.broker.manage(
    { ...rootParent, toolCallId: 'retained-control-cap' },
    { delegationId: cap4Seed.delegationId, operation: 'interrupt' },
  );
  requireCapacityReply(cap4ArrayReply, '4');
  await cap4ArrayHarness.broker.close();

  const restartInitial = createFileHarness(
    temporaryRoot,
    'restart-records',
    resumableOptions({ capacity: 1 }),
  );
  await restartInitial.broker.initialize();
  const inFlightId = await spawn(restartInitial.broker, 'restart-in-flight');
  await waitForGeneration(restartInitial.runner, inFlightId, 1);
  await sendEvent(restartInitial.runner, inFlightId, 1, 1, {
    type: 'started',
    nativeSessionId: 'restart-native-session',
  });
  const neverDispatchedId = await spawn(
    restartInitial.broker,
    'restart-never-dispatched',
  );
  const inFlightInitialBytes = await recordBytes(
    restartInitial.recordsDirectory,
    inFlightId,
  );
  const restart = createFileHarness(
    temporaryRoot,
    'restart-recovered-records',
    resumableOptions({ capacity: 1 }),
  );
  // A crash leaves the old process unable to write. Give recovery an exact
  // durable snapshot without letting the still-live fixture broker later
  // overwrite the recovered generation during its own cleanup.
  await restart.storage.prepareDirectory();
  for (const record of await restartInitial.storage.load())
    await writeFile(
      path.join(restart.recordsDirectory, `${record.state.delegationId}.json`),
      await recordBytes(
        restartInitial.recordsDirectory,
        record.state.delegationId,
      ),
      { mode: 0o600 },
    );
  await restart.broker.initialize();
  const inFlightSnapshot = snapshotOf(restart.broker, inFlightId);
  const neverDispatchedSnapshot = snapshotOf(restart.broker, neverDispatchedId);
  const restartInFlightBytes = await recordBytes(
    restart.recordsDirectory,
    inFlightId,
  );
  const restartNeverDispatchedBytes = await recordBytes(
    restart.recordsDirectory,
    neverDispatchedId,
  );
  const relaunchedRunCount = restart.runner.starts.length;
  if (inFlightInitialBytes.length === 0)
    throw new Error('Expected the in-flight record before restart');
  if (relaunchedRunCount !== 0)
    throw new Error('Restart must not relaunch a legacy run');
  await restartInitial.broker.close();
  await restart.broker.close();

  return {
    recordBytes: {
      v1BeforeOwnedUpdate,
      v1AfterOwnedUpdate,
      v2AfterLaunch,
      v2AfterCompletion,
      v2AfterFollowUp,
      v2AfterSteer,
      v2AfterInterrupt,
      v2AfterStopRequest,
      v2AfterStopAliases,
      v2AfterStopResolution,
      v2AfterFailedStop,
      v2AfterResume,
      atHistory16Results17: v2AtHistory16Results17,
      restartInFlightInterrupted: restartInFlightBytes,
      restartNeverDispatched: restartNeverDispatchedBytes,
    },
    snapshots: {
      stopAccepted,
      stopCompleted,
      stopFailed,
      afterResume,
    },
    watches: {
      pending: pendingWatch,
      settled: settledWatch,
      historicalGeneration: historicalWatch,
      registrationResult,
      settlementNotices,
      registrationCatchUpNotices,
    },
    replays: {
      stopSameKey,
      stopChangedTarget,
      controlSameKey,
      controlChangedArguments,
      capacityReplies: [
        { cap: '1', reply: cap1Reply },
        { cap: '2', reply: cap2Reply },
        { cap: '4', reply: cap4ArrayReply },
        { cap: '5', reply: cap5Reply },
        { cap: '7', reply: cap7Reply },
        { cap: '8', reply: cap8Reply },
        { cap: '9', reply: cap9Reply },
      ],
    },
    caps: { historyCount, resultCount },
    restarts: {
      inFlightSnapshot,
      neverDispatchedSnapshot,
      relaunchedRunCount,
    },
  };
}

async function captureLegacyAdditions(
  temporaryRoot: string,
): Promise<LegacyRecordGoldenAdditions> {
  const capStorage = new FileDelegationStorage(
    path.join(temporaryRoot, 'history-results-cap', 'records'),
  );
  const capRecords = await capStorage.load();
  const capRecord = capRecords.find(
    (record) => record.state.runGeneration === 17,
  );
  if (!capRecord) throw new Error('Expected the retained history-cap record');
  if (capRecord.version === 3) throw new Error();
  const baselineRecord = materializationBaselineRecord;
  if (!baselineRecord)
    throw new Error('Expected the retained below-cap materialization record');

  const candidateSeed = await completedRecord(
    temporaryRoot,
    'continuation-candidate-seed',
  );
  const candidateSeedRecord = await storedRecord(
    candidateSeed.harness.storage,
    candidateSeed.delegationId,
  );
  const scope = { projectId: 'project', worktreeId: 'worktree' };
  const baselineCandidates =
    candidateSeed.harness.broker.continuationCandidates(scope);
  await candidateSeed.harness.broker.close();

  const historyCapHarness = await openStoredRecord(
    temporaryRoot,
    'continuation-candidate-history-cap',
    capRecord,
  );
  const historyCapCandidates =
    historyCapHarness.broker.continuationCandidates(scope);
  await historyCapHarness.broker.close();

  const controlsCapRecord: StoredDelegationLegacy = {
    ...candidateSeedRecord,
    controls: controlsAtLimit(64),
  };
  const controlsCapHarness = await openStoredRecord(
    temporaryRoot,
    'continuation-candidate-controls-cap',
    controlsCapRecord,
  );
  const controlsCapCandidates =
    controlsCapHarness.broker.continuationCandidates(scope);
  await controlsCapHarness.broker.close();

  const belowCapHistoryCount = baselineRecord.history?.length ?? 0;
  const belowCapCausalErrors: string[] = [];
  const belowCapHarness = await openStoredRecord(
    temporaryRoot,
    'materialize-below-history-cap',
    baselineRecord,
    {
      onError: (error: unknown): void => {
        belowCapCausalErrors.push(
          error instanceof Error ? error.message : String(error),
        );
      },
    },
  );
  const continuationMessage = 'Continue at the retained-history boundary.';
  const belowCapParent: DelegationParentContext = {
    ...rootParent,
    controlAuthor: 'user',
    toolCallId: 'materialize-below-history-cap',
  };
  const belowCapInput = {
    delegationId: baselineRecord.state.delegationId,
    operation: 'follow_up',
    message: continuationMessage,
  };
  const belowCapReply = await belowCapHarness.broker.message(
    belowCapParent,
    belowCapInput,
    fixedUuid(70_001),
  );
  await waitForGeneration(
    belowCapHarness.runner,
    baselineRecord.state.delegationId,
    baselineRecord.state.runGeneration + 1,
  );
  const belowCapLaunchCount = belowCapHarness.runner.starts.length;
  const belowCapErrors = belowCapCausalErrors.slice();
  await belowCapHarness.broker.close();

  const materializationErrors: string[] = [];
  const materializationHarness = await openStoredRecord(
    temporaryRoot,
    'materialize-at-history-cap',
    capRecord,
    {
      onError: (error: unknown): void => {
        materializationErrors.push(
          error instanceof Error ? error.message : String(error),
        );
      },
    },
  );
  const materializationParent: DelegationParentContext = {
    ...rootParent,
    controlAuthor: 'user',
    toolCallId: 'materialize-at-history-cap',
  };
  const materializationInput = {
    delegationId: capRecord.state.delegationId,
    operation: 'follow_up',
    message: continuationMessage,
  };
  const materializationOperationId = fixedUuid(70_002);
  const materializationReply = await materializationHarness.broker.message(
    materializationParent,
    materializationInput,
    materializationOperationId,
  );
  const userErrorReplay = await materializationHarness.broker.message(
    materializationParent,
    materializationInput,
    materializationOperationId,
  );
  const materializationAfter = await storedRecord(
    materializationHarness.storage,
    capRecord.state.delegationId,
  );
  const materializationControl = materializationAfter.control;
  if (materializationControl?.status !== 'failed')
    throw new Error('Expected the cap-rejected command to persist as failed');
  const materializationErrorsAtRefusal = materializationErrors.slice();
  const launchedRunCount = materializationHarness.runner.starts.length;
  await materializationHarness.broker.close();

  const materializationRestart = createFileHarness(
    temporaryRoot,
    'materialize-at-history-cap',
    resumableOptions(),
  );
  await materializationRestart.broker.initialize();
  const userErrorAfterRestart = await materializationRestart.broker.message(
    materializationParent,
    materializationInput,
    materializationOperationId,
  );
  await materializationRestart.broker.close();

  const hostMessageBelowCapHarness = await openStoredRecord(
    temporaryRoot,
    'host-message-controls-below-cap',
    { ...candidateSeedRecord, controls: controlsAtLimit(63) },
  );
  const hostMessageBelowCapReply =
    await hostMessageBelowCapHarness.broker.deliverHostMessage(
      candidateSeedRecord.state.delegationId,
      'Host control predicate below the cap.',
      fixedUuid(71_001),
    );
  await hostMessageBelowCapHarness.broker.close();

  const hostMessageAtCapHarness = await openStoredRecord(
    temporaryRoot,
    'host-message-controls-at-cap',
    { ...candidateSeedRecord, controls: controlsAtLimit(64) },
  );
  const hostMessageAtCapReply =
    await hostMessageAtCapHarness.broker.deliverHostMessage(
      candidateSeedRecord.state.delegationId,
      'Host control predicate at the cap.',
      fixedUuid(71_002),
    );
  const hostMessageAtCapRecord = await storedRecord(
    hostMessageAtCapHarness.storage,
    candidateSeedRecord.state.delegationId,
  );
  const hostMessageControlsAfterAttempt =
    hostMessageAtCapRecord.controls?.length ?? 0;
  const hostMessagePromptAfterAttempt = hostMessageAtCapRecord.task.prompt;
  const hostMessageHistoryCount = hostMessageAtCapRecord.history?.length ?? 0;
  await hostMessageAtCapHarness.broker.close();

  const acknowledgementHarness = await openStoredRecord(
    temporaryRoot,
    'user-first-acknowledgement',
    candidateSeedRecord,
  );
  const acknowledgementParent: DelegationParentContext = {
    ...rootParent,
    controlAuthor: 'user',
    toolCallId: 'user-first-acknowledgement',
  };
  const acknowledgementInput = {
    delegationId: candidateSeedRecord.state.delegationId,
    operation: 'follow_up',
    message: 'Replay the first user acknowledgement.',
  };
  const acknowledgementOperationId = fixedUuid(72_001);
  const userFirstAcknowledgement = await acknowledgementHarness.broker.message(
    acknowledgementParent,
    acknowledgementInput,
    acknowledgementOperationId,
  );
  await waitForGeneration(
    acknowledgementHarness.runner,
    candidateSeedRecord.state.delegationId,
    candidateSeedRecord.state.runGeneration + 1,
  );
  const userAcknowledgementReplay = await acknowledgementHarness.broker.message(
    acknowledgementParent,
    acknowledgementInput,
    acknowledgementOperationId,
  );
  await acknowledgementHarness.broker.close();
  const acknowledgementRestart = createFileHarness(
    temporaryRoot,
    'user-first-acknowledgement',
    resumableOptions(),
  );
  await acknowledgementRestart.broker.initialize();
  const userAcknowledgementAfterRestart =
    await acknowledgementRestart.broker.message(
      acknowledgementParent,
      acknowledgementInput,
      acknowledgementOperationId,
    );
  await acknowledgementRestart.broker.close();

  const applyFailureMessage =
    'Nothing was applied: src/a.ts changed after the delegate copied it.';
  const applyFailure: DelegationApplyFailure = {
    reason: 'conflict',
    issues: [
      {
        path: 'src/a.ts',
        reason: 'parent_changed',
        parentDiff: '--- delegate/src/a.ts\n+++ parent/src/a.ts\n',
      },
    ],
    guidance: 'Send the delegate a follow_up, then apply again.',
  };
  const applyError = new DelegationApplyError(
    applyFailureMessage,
    applyFailure,
    [
      {
        path: 'src/a.ts',
        parent: fixedHash(73_001),
        delegate: fixedHash(73_002),
      },
    ],
  );
  let markApplyStarted: () => void = () => undefined;
  const applyStarted = new Promise<void>((resolve) => {
    markApplyStarted = resolve;
  });
  let releaseApply: () => void = () => undefined;
  const applyGate = new Promise<void>((resolve) => {
    releaseApply = resolve;
  });
  const applyCausalErrors: string[] = [];
  const applyHarness = createFileHarness(
    temporaryRoot,
    'apply-failed-replay',
    resumableOptions({
      asyncAdmission: true,
      resolveRoute: (): ReturnType<
        AgentDelegationBrokerOptions['resolveRoute']
      > =>
        Promise.resolve({
          ok: true,
          value: routeFixture({
            capabilities: ['read', 'write', 'worktree', 'resume'],
          }),
        }),
      prepareWorkspace: (): Promise<{ cwd: string; revision: string }> =>
        Promise.resolve({
          cwd: '/legacy-golden/worktree/apply-child',
          revision: 'a'.repeat(40),
        }),
      manageWorkspace: async (): Promise<void> => {
        markApplyStarted();
        await applyGate;
        applyCausalErrors.push(applyFailureMessage);
        throw applyError;
      },
    }),
  );
  await applyHarness.broker.initialize();
  const applySpawn = await applyHarness.broker.spawn(rootParent, {
    ...baseTask,
    isolation: 'worktree',
    permissions: { writePaths: ['src'] },
  });
  if (!applySpawn.ok) throw new Error('Expected isolated apply replay setup');
  const applyDelegationId = applySpawn.value.delegationId;
  await waitForGeneration(applyHarness.runner, applyDelegationId, 1);
  await sendEvent(applyHarness.runner, applyDelegationId, 1, 1, {
    type: 'started',
    nativeSessionId: 'apply-replay-native',
  });
  await sendEvent(applyHarness.runner, applyDelegationId, 1, 2, {
    type: 'terminal',
    status: 'completed',
    finalText: 'Ready to apply.',
  });
  await waitForStatus(applyHarness.broker, applyDelegationId, 'completed');
  const applyParent: DelegationParentContext = {
    ...rootParent,
    toolCallId: 'apply-failed-replay',
  };
  const applyInput = { delegationId: applyDelegationId, operation: 'apply' };
  const firstApplyReply = applyHarness.broker.manage(applyParent, applyInput);
  await applyStarted;
  const acceptedControl =
    snapshotOf(applyHarness.broker, applyDelegationId).control ?? null;
  const firstApplyAcknowledgement = await firstApplyReply;
  releaseApply();
  await waitForControlStatus(applyHarness.broker, applyDelegationId, 'failed');
  await flushBroker();
  const applyRecordAfterFailure = await storedRecord(
    applyHarness.storage,
    applyDelegationId,
  );
  const applyPersistedControl = applyRecordAfterFailure.control ?? null;
  const applyFailureReplay = await applyHarness.broker.manage(
    applyParent,
    applyInput,
  );
  const causalApplyErrors = applyCausalErrors.slice();
  await applyHarness.broker.close();

  const applyRestart = createFileHarness(
    temporaryRoot,
    'apply-failed-replay',
    resumableOptions(),
  );
  await applyRestart.broker.initialize();
  const applyFailureAfterRestart = await applyRestart.broker.manage(
    applyParent,
    applyInput,
  );
  await applyRestart.broker.close();

  const rawV1Record: StoredDelegationLegacy = {
    version: 1,
    ...(capRecord.depth === undefined ? {} : { depth: capRecord.depth }),
    ...(capRecord.parentDelegationId === undefined
      ? {}
      : { parentDelegationId: capRecord.parentDelegationId }),
    ...(capRecord.parentRunGeneration === undefined
      ? {}
      : { parentRunGeneration: capRecord.parentRunGeneration }),
    ...(capRecord.parentDescription === undefined
      ? {}
      : { parentDescription: capRecord.parentDescription }),
    ...(capRecord.resumeSessionId === undefined
      ? {}
      : { resumeSessionId: capRecord.resumeSessionId }),
    ...(capRecord.history === undefined ? {} : { history: capRecord.history }),
    parent: capRecord.parent,
    task: capRecord.task,
    ...(capRecord.route === undefined ? {} : { route: capRecord.route }),
    callKey: capRecord.callKey,
    requestHash: capRecord.requestHash,
    createdAt: capRecord.createdAt,
    state: capRecord.state,
    launch: capRecord.launch,
    delivery: capRecord.delivery,
  };
  const rawV1Bytes = JSON.stringify(rawV1Record);
  const v1Harness = createFileHarness(
    temporaryRoot,
    'v1-missing-results',
    resumableOptions(),
  );
  await v1Harness.storage.load();
  await writeFile(
    path.join(
      v1Harness.recordsDirectory,
      `${rawV1Record.state.delegationId}.json`,
    ),
    rawV1Bytes,
    { mode: 0o600 },
  );
  const rawReadBack = await recordBytes(
    v1Harness.recordsDirectory,
    rawV1Record.state.delegationId,
  );
  if (rawReadBack !== rawV1Bytes)
    throw new Error('Expected the captured raw v1 bytes to match the fixture');
  await v1Harness.broker.initialize();
  const historyCount = rawV1Record.history?.length ?? 0;
  const resultCount = historyCount + 1;
  const historyResult = await v1Harness.broker.getOutput(rootParent, {
    delegationId: rawV1Record.state.delegationId,
    resultIndex: 1,
  });
  const currentStateResult = await v1Harness.broker.getOutput(rootParent, {
    delegationId: rawV1Record.state.delegationId,
    resultIndex: resultCount,
  });
  if (
    !historyResult.ok ||
    historyResult.value.result?.runGeneration !== 1 ||
    !currentStateResult.ok ||
    currentStateResult.value.result?.runGeneration !==
      rawV1Record.state.runGeneration
  )
    throw new Error(
      'Expected v1 normalization from history and terminal state',
    );
  const rawParsed: unknown = JSON.parse(rawV1Bytes);
  const hadResultsField =
    isRecord(rawParsed) && Object.hasOwn(rawParsed, 'results');
  await v1Harness.broker.close();

  const history = capRecord.history ?? [];
  const lastHistory = history[history.length - 1];
  const results = capRecord.results ?? [];
  const lastResult = results[results.length - 1];
  const firstResult = results.find((result) => result.resultIndex === 1);
  const secondResult = results.find((result) => result.resultIndex === 2);
  if (!lastHistory || !lastResult || !firstResult || !secondResult)
    throw new Error('Expected a complete history/results cap fixture');
  const nextResult: NonNullable<StoredDelegationLegacy['results']>[number] = {
    ...lastResult,
    resultIndex: results.length + 1,
    runGeneration: lastResult.runGeneration + 1,
  };
  const outOfOrderResults = [
    secondResult,
    firstResult,
    ...results.filter((result) => result.resultIndex > 2),
  ];
  const storageRejections = [
    await captureStorageRejection(capStorage, 'unknown_fields', {
      ...capRecord,
      unknownLegacyGoldenField: true,
    }),
    await captureStorageRejection(capStorage, 'history_over_16', {
      ...capRecord,
      history: [...history, lastHistory],
    }),
    await captureStorageRejection(capStorage, 'results_over_17', {
      ...capRecord,
      results: [...results, nextResult],
    }),
    await captureStorageRejection(capStorage, 'out_of_order_result_indexes', {
      ...capRecord,
      results: outOfOrderResults,
    }),
  ];

  return {
    guards: {
      continuationCandidates: {
        baseline: baselineCandidates,
        historyAt16: historyCapCandidates,
        controlsAt64: controlsCapCandidates,
        baselineHistoryCount: candidateSeedRecord.history?.length ?? 0,
        historyAt16Count: capRecord.history?.length ?? 0,
        baselineControlsCount: candidateSeedRecord.controls?.length ?? 0,
        controlsAt64Count: controlsCapRecord.controls?.length ?? 0,
        baselineCandidatePresent: baselineCandidates.length === 1,
        historyCapCandidateAbsent: historyCapCandidates.length === 0,
        controlsCapCandidateAbsent: controlsCapCandidates.length === 0,
      },
      materializeAtHistory16: {
        belowCapHistoryCount,
        belowCapReply,
        belowCapCausalErrors: belowCapErrors,
        belowCapLaunchedRunCount: belowCapLaunchCount,
        inputControlCounts: capRecord.controls?.length ?? 0,
        inputHistoryCount: capRecord.history?.length ?? 0,
        reply: materializationReply,
        causalErrors: materializationErrorsAtRefusal,
        storedControl: materializationControl,
        launchedRunCount,
      },
      hostMessageControlsAt64: {
        belowCapReply: hostMessageBelowCapReply,
        atCapReply: hostMessageAtCapReply,
        historyCount: hostMessageHistoryCount,
        controlsAfterAtCapAttempt: hostMessageControlsAfterAttempt,
        promptAfterAtCapAttempt: hostMessagePromptAfterAttempt,
      },
    },
    replays: {
      userFirstAcknowledgement,
      userAcknowledgementReplay,
      userAcknowledgementAfterRestart,
      userFirstError: materializationReply,
      userErrorReplay,
      userErrorAfterRestart,
      applyFailed: {
        acceptedControl,
        firstReply: firstApplyAcknowledgement,
        inProcessReplay: applyFailureReplay,
        restartReplay: applyFailureAfterRestart,
        persistedControl: applyPersistedControl,
        causalErrors: causalApplyErrors,
      },
    },
    v1Normalization: {
      rawV1Bytes,
      rawVersion: rawV1Record.version,
      hadResultsField,
      historyCount,
      resultCount,
      historyResult,
      currentStateResult,
    },
    storageRejections,
  };
}

/** Replace only the mkdtemp root; IDs, clock values, and all other paths stay literal. */
function normalizeTemporaryRoot(
  value: unknown,
  temporaryRoot: string,
): unknown {
  const serialized = JSON.stringify(value);
  if (typeof serialized !== 'string')
    throw new Error('Expected a JSON-compatible golden output');
  const normalizedText = serialized.replaceAll(temporaryRoot, '<TEMP_ROOT>');
  return JSON.parse(normalizedText);
}

function withoutWatchRegistration(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value), (key: string, entry: unknown) =>
    key === 'registrationResult' || key === 'registrationCatchUpNotices'
      ? undefined
      : entry,
  );
}

function compareGolden(actual: unknown, expected: unknown): void {
  expect(actual).toEqual(expected);
  expect(JSON.stringify(actual)).toBe(JSON.stringify(expected));
}

beforeAll(async (): Promise<void> => {
  const clock = jest.spyOn(Date, 'now').mockReturnValue(FIXED_NOW);
  restoreClock = (): void => clock.mockRestore();
  const temporaryRoot = await mkdtemp(
    path.join(os.tmpdir(), 'legacy-record-golden-'),
  );
  const actual = await captureLegacyGoldens(temporaryRoot);
  const additions = await captureLegacyAdditions(temporaryRoot);
  captureRun = { temporaryRoot, actual, additions };
});

afterAll(async (): Promise<void> => {
  if (restoreClock) restoreClock();
  if (captureRun)
    await rm(captureRun.temporaryRoot, { recursive: true, force: true });
  jest.restoreAllMocks();
});

describe('legacy v1/v2 broker and storage record goldens', () => {
  it('matches literal private-record bytes and broker projections', () => {
    if (!captureRun) throw new Error('Expected captured broker scenarios');
    const actual = normalizeTemporaryRoot(
      captureRun.actual,
      captureRun.temporaryRoot,
    );
    if (CAPTURE_GOLDENS)
      throw new Error('Golden capture is disabled: these fixtures are frozen.');
    // Watch Delegates is now a no-op; the frozen fixture keeps the legacy
    // registration projection, so compare everything else against it.
    expect(captureRun.actual.watches.registrationResult).toMatchObject({
      ok: true,
      value: { targets: [] },
    });
    expect(captureRun.actual.watches.registrationCatchUpNotices).toEqual([]);
    const expectedText = readFileSync(FIXTURE_PATH, 'utf8');
    const expected: unknown = JSON.parse(expectedText);
    compareGolden(
      withoutWatchRegistration(actual),
      withoutWatchRegistration(expected),
    );
  });

  it('rejects a mutated persisted-record byte string', () => {
    if (CAPTURE_GOLDENS) return;
    if (!captureRun) throw new Error('Expected captured broker scenarios');
    const temporaryRoot = captureRun.temporaryRoot;
    const expectedText = readFileSync(FIXTURE_PATH, 'utf8');
    const expected: unknown = JSON.parse(expectedText);
    const mutated: LegacyRecordGoldens = {
      ...captureRun.actual,
      recordBytes: {
        ...captureRun.actual.recordBytes,
        v2AfterCompletion: `${captureRun.actual.recordBytes.v2AfterCompletion} `,
      },
    };
    expect(() =>
      compareGolden(
        withoutWatchRegistration(
          normalizeTemporaryRoot(mutated, temporaryRoot),
        ),
        withoutWatchRegistration(expected),
      ),
    ).toThrow();
  });

  it('matches the review round 1 legacy branch and replay additions', () => {
    if (!captureRun) throw new Error('Expected captured broker scenarios');
    const actual = normalizeTemporaryRoot(
      captureRun.additions,
      captureRun.temporaryRoot,
    );
    if (CAPTURE_GOLDENS)
      throw new Error(
        'Review-round-1 golden capture is disabled: this fixture is frozen.',
      );
    const expectedText = readFileSync(ADDITIONS_FIXTURE_PATH, 'utf8');
    const expected: unknown = JSON.parse(expectedText);
    compareGolden(actual, expected);
  });
});
