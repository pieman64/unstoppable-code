/* eslint-disable @typescript-eslint/explicit-function-return-type, @typescript-eslint/no-unsafe-assignment */
import { EventEmitter } from 'node:events';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import {
  classifyProviderRunEvent,
  getProviderRunDescriptor,
} from '../lib/provider-run-reconciliation';
import type * as NodeChildProcess from 'node:child_process';
import type * as NodeCrypto from 'node:crypto';

const spawnMock = jest.fn();
const createPendingRequestMock = jest.fn();
const rejectAllForSessionMock = jest.fn();
const rejectRequestMock = jest.fn();
const upsertPendingQuestionMock = jest.fn(() => Promise.resolve());
const consumePendingQuestionMock = jest.fn(() => Promise.resolve());
const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(
  process,
  'platform',
);

jest.mock('node:child_process', () => ({
  ...jest.requireActual<typeof NodeChildProcess>('node:child_process'),
  get spawn() {
    return spawnMock;
  },
}));

// Terminate fake children directly so their PIDs never reach the host's kill path.
jest.mock('@canopy/desktop-shared/node/lib/process-kill', () => ({
  killChildProcessGroup: (
    child: NodeChildProcess.ChildProcess,
    signal: NodeJS.Signals,
  ): void => {
    child.kill(signal);
  },
}));

jest.mock('node:crypto', () => ({
  ...jest.requireActual<typeof NodeCrypto>('node:crypto'),
  randomUUID: jest.fn(),
}));

jest.mock('@canopy/desktop-shared/pipelines/config-paths', () => ({
  getBundledCodexBinaryPath: jest.fn(() => '/mock/codex'),
  getEnhancedEnv: jest.fn(() => ({ ...process.env })),
}));

jest.mock('../mcp/pending-requests', () => ({
  get createPendingRequest() {
    return createPendingRequestMock;
  },
  get rejectAllForSession() {
    return rejectAllForSessionMock;
  },
  get rejectRequest() {
    return rejectRequestMock;
  },
}));

jest.mock('../services/chat-state-service', () => ({
  getChatStateService: () => ({
    get upsertPendingQuestion() {
      return upsertPendingQuestionMock;
    },
    get consumePendingQuestion() {
      return consumePendingQuestionMock;
    },
  }),
}));

jest.mock('../lib/main-process-logging', () => ({
  logMainProcessError: jest.fn(),
  logMainProcessWarn: jest.fn(),
}));

jest.mock('electron', () => ({
  app: { getVersion: (): string => '0.0.0-test' },
}));

import {
  IPC_CHANNELS,
  initAiGatewayModels,
  initCodexModels,
  type AgentModelConfig,
  type ApprovalCheck,
  type ThinkingLevel,
} from '@canopy/desktop-shared/types';
import {
  ASK_USER_HTTP_TIMEOUT_MS,
  CANOPY_MCP_TOOL_TIMEOUT_MS,
  CANOPY_INJECTED_TOOL_REGISTRY,
} from '@canopy/desktop-shared/lib/canopy-injected-tools';
import { APP_ADVISOR_TOOL_REGISTRY } from '@canopy/desktop-shared/lib/app-advisor-tools';
import { PIPELINE_EDITOR_TOOL_REGISTRY } from '@canopy/desktop-shared/lib/pipeline-editor-tools';
import { getEnhancedEnv } from '@canopy/desktop-shared/pipelines/config-paths';
import { CodexSpeedUnsupportedError } from '@canopy/desktop-shared/lib/codex-speed';
import {
  CodexAppServerClient,
  parseGetAccountResponsePayload,
  codexThreadProviderRouteIdentity,
} from '../codex/app-server-client';
import { CodexTurnLifecycleTracker } from '../agents/codex-turn-lifecycle';
import {
  getTurnLifecycleProducer,
  releaseTurnLifecycleProducer,
  setTurnLifecycleSink,
} from '../agents/provider-turn-lifecycle';
import type { ChatTurnLifecycleEvent } from '@canopy/protocol/canopy-core';
import { readCodexDeliveryHistory } from '../codex/delivery-history';
import {
  buildCodexAppServerPoolKey,
  CodexAppServerConnection,
  CodexRecoverableProcessExitError,
  type CodexAppServerConnectionOwner,
  type CodexIngestionLagChange,
  type CodexIngestionLagSample,
  type CodexIngestionLagSnapshot,
  type CodexAppServerPoolResourceSnapshot,
} from '@canopy/desktop-shared/node/codex-runtime/connection';
import { createCodexCapabilitySnapshotId } from '@canopy/desktop-shared/node/codex-runtime/capability-fingerprint';
import { dynamicToolSetId } from '@canopy/desktop-shared/node/codex-runtime/dynamic-tool-fingerprint';
import type { DynamicToolSpec } from '@canopy/desktop-shared/node/codex-runtime/generated/v2/DynamicToolSpec';
import { resolveCodexSpawnProfile } from '@canopy/desktop-shared/node/codex-runtime/profile';
import {
  getCodexRuntimeService,
  resetCodexRuntimeServiceForTests,
} from '../codex/runtime-service';
import {
  buildCanopyDynamicToolSpecs,
  handleCanopyDynamicToolCall,
} from '../codex/canopy-dynamic-tools';
import {
  buildCodexPlanModeDeveloperInstructions,
  DEFAULT_MODE_DEVELOPER_INSTRUCTIONS,
  PLAN_MODE_DEVELOPER_INSTRUCTIONS,
} from '../codex/plan-mode-instructions';
import { buildLedgerPlanModeInstruction } from '../canopy-tools/prompting';
import { requestAnswersFromRenderer } from '../canopy-tools/session-runtime';
import type {
  ApprovalCheckDisplay,
  ApprovalOutcome,
  ApprovalSessionHandle,
} from '../approvals/approval-service';
import type { CanopyInjectedToolRuntime } from '../canopy-tools/core';
import type { SendableBrowserWindow } from '../lib/window-send';
import { deferredToolsReloadCoordinator } from '../deferred-tools/reload-coordinator';
import * as mainProcessLogging from '../lib/main-process-logging';
import { ChatEventOutputDelivery } from '../ipc/chat-event-output';
import {
  sendToWebContents,
  setRendererMessageEncoder,
} from '../lib/web-contents-send';
import {
  ChatEventOutputDecoder,
  type ChatEventMessage,
} from '@canopy/desktop-shared/lib/chat-event-output';
import { runtimeChatEventToPortalMessage } from '@canopy/desktop-shared/portal/runtime-chat-projection';
import {
  applyCodexTranscriptEvent,
  createEmptyTranscriptReducerState,
  type TranscriptReducerState,
} from '@canopy/agent-transcript';
import type { ChatEvent } from '@canopy/desktop-shared/types';
import {
  chatInputDeliveryFailure,
  chatInputRefusal,
  type ChatInputDeliveryFailureCode,
  type ChatInputRefusalCode,
} from '@canopy/protocol/portal/input-delivery';
import {
  CODEX_PROJECT_DOC_THREAD_CONFIG,
  CodexCapabilityStore,
  resetCanonicalCodexHomeForTests,
  type CodexCapabilityLeaseStore,
} from '@canopy/desktop-shared/node/codex-runtime';
const mockLogMainProcessWarn = jest.mocked(
  mainProcessLogging.logMainProcessWarn,
);

const randomUUIDMock = jest.mocked(
  jest.requireMock<typeof NodeCrypto>('node:crypto').randomUUID,
);

/** The literal Codex keys, so a drifted shared constant fails here too. */
const PROJECT_DOC_THREAD_CONFIG = {
  project_doc_max_bytes: 131_072,
  project_doc_fallback_filenames: ['CLAUDE.md'],
};

/**
 * Write a canonical Codex rollout for `threadId` into a throwaway CODEX_HOME.
 *
 * Reconstruction behaves differently depending on which source produced the
 * seed items — the rollout retains the failed turn's own user input, while the
 * renderer fallback already excluded it — so specs that assert on that
 * difference must go through a real rollout rather than `fallbackSeedItems`.
 */
async function writeRolloutCodexHome(
  threadId: string,
  items: readonly unknown[],
): Promise<string> {
  const codexHome = await mkdtemp(join(tmpdir(), 'codex-client-rollout-'));
  const sessions = join(codexHome, 'sessions', '2026', '08', '21');
  await mkdir(sessions, { recursive: true });
  await writeFile(
    join(sessions, `rollout-2026-08-21-${threadId}.jsonl`),
    `${items
      .map((payload) => JSON.stringify({ type: 'response_item', payload }))
      .join('\n')}\n`,
    'utf8',
  );
  return codexHome;
}

/**
 * Test double for the capability lease/pin surface.
 *
 * Every member is a `jest.Mock` so specs can assert on calls, while the type
 * stays structurally checked against `CodexCapabilityLeaseStore` — no
 * `as unknown as` double assertion, which the repository forbids and which
 * would disable checking exactly where these specs pin the contract.
 */
type CapabilityStoreMock = {
  [K in keyof CodexCapabilityLeaseStore]: jest.Mock;
};

function createCapabilityStoreMock(
  overrides: Partial<CapabilityStoreMock> = {},
): CapabilityStoreMock {
  return {
    readLease: jest.fn().mockResolvedValue(null),
    writeLease: jest.fn().mockResolvedValue(undefined),
    releaseLease: jest.fn().mockResolvedValue(undefined),
    acquireOperationPin: jest.fn().mockResolvedValue({
      pinId: 'pin-default',
      rootContentIds: [],
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    }),
    refreshOperationPin: jest.fn().mockResolvedValue(undefined),
    releaseOperationPin: jest.fn().mockResolvedValue(undefined),
    promotePinToLease: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

const defaultLoadDeferredToolsName =
  CANOPY_INJECTED_TOOL_REGISTRY.load_deferred_tools.codexToolName;

class MockChildProcess extends EventEmitter {
  pid = 4242;
  stdout = new PassThrough();
  stderr = new PassThrough();
  // A real app-server reads its stdin as it arrives; this one is read only
  // when a test collects messages. One thread/start that carries the Canopy
  // tool specs is larger than the default 64 KiB buffer, and every write
  // behind it would wait for the next read.
  stdin = new PassThrough({ highWaterMark: 16 * 1024 * 1024 });
  killed = false;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  autoExitSignals = new Set<NodeJS.Signals>(['SIGTERM', 'SIGKILL']);

  /** Canonical MCP table returned by the automatic `config/read` answer. */
  ambientMcpServers: Record<string, unknown> = {};
  readonly configReads: Array<Record<string, unknown>> = [];

  constructor() {
    super();
    // The runtime reads the effective config before every thread start/resume
    // to disable ambient MCP servers. These specs predate that read and assert
    // exact request sequences and ids, so the mock answers it, hides it, and
    // renumbers later client request ids in both directions. Request ids
    // continue across worker restarts, so the renumbering is per spec.
    const toClient = this.stdout.write.bind(this.stdout);
    const fromClient = this.stdin.write.bind(this.stdin);
    this.stdin.write = ((chunk: unknown, ...rest: unknown[]): boolean => {
      const kept = String(chunk)
        .split('\n')
        .flatMap((line): string[] => {
          const message = parseJsonLine(line);
          if (!message || typeof message.id !== 'number' || !message.method) {
            return [line];
          }
          if (message.method === 'initialize' && message.id === 1) {
            // A new connection numbers its requests from 1 again.
            hiddenConfigReads.count = 0;
            hiddenConfigReads.realIdsByVisibleId.clear();
          }
          if (message.method === 'config/read') {
            hiddenConfigReads.count += 1;
            this.configReads.push(message);
            toClient(
              `${JSON.stringify({
                id: message.id,
                result: { config: { mcp_servers: this.ambientMcpServers } },
              })}\n`,
            );
            return [];
          }
          const visibleId = message.id - hiddenConfigReads.count;
          hiddenConfigReads.realIdsByVisibleId.set(visibleId, message.id);
          return [JSON.stringify({ ...message, id: visibleId })];
        })
        .join('\n');
      if (kept.trim()) return fromClient(kept, ...(rest as []));
      const callback = rest.find(
        (arg): arg is () => void => typeof arg === 'function',
      );
      callback?.();
      return true;
    }) as typeof this.stdin.write;
    this.stdout.write = ((chunk: unknown, ...rest: unknown[]): boolean => {
      const text = String(chunk);
      const translated = text
        .split('\n')
        .map((line) => {
          const message = parseJsonLine(line);
          if (!message || typeof message.id !== 'number' || message.method) {
            return line;
          }
          const realId =
            hiddenConfigReads.realIdsByVisibleId.get(message.id) ??
            message.id + hiddenConfigReads.count;
          return JSON.stringify({ ...message, id: realId });
        })
        .join('\n');
      return toClient(translated, ...(rest as []));
    }) as typeof this.stdout.write;
  }

  kill = jest.fn().mockImplementation((signal?: NodeJS.Signals): boolean => {
    const nextSignal = signal ?? 'SIGTERM';
    this.killed = true;
    if (!this.autoExitSignals.has(nextSignal)) {
      return true;
    }

    this.signalCode = nextSignal;
    this.emit('exit', null, nextSignal);
    return true;
  });
}

const hiddenConfigReads = {
  count: 0,
  realIdsByVisibleId: new Map<number, number>(),
};

function parseJsonLine(
  line: string,
): (Record<string, unknown> & { id?: unknown; method?: unknown }) | null {
  if (!line.trim()) return null;
  try {
    const value: unknown = JSON.parse(line);
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function dispatchIngestionLagSample(
  client: CodexAppServerClient,
  sample: CodexIngestionLagSample,
): boolean {
  const report: unknown = Reflect.get(client, 'handleIngestionLagSample');
  if (typeof report !== 'function') return false;
  Reflect.apply(report, client, [sample]);
  return true;
}

function getCodexAppServerPoolResourceSnapshots(): CodexAppServerPoolResourceSnapshot[] {
  return getCodexRuntimeService().admin().getResourceSnapshots();
}

function suspendIdleCodexAppServerPoolConnectionsForMemoryPressure(): number {
  return getCodexRuntimeService().admin().suspendIdleWorkersForMemoryPressure();
}

function updateCodexAppServerPoolIdleTimeoutMinutes(minutes: number): void {
  getCodexRuntimeService().admin().updateIdleTimeoutMinutes(minutes);
}

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', {
    configurable: true,
    value: platform,
  });
}

function emitServerMessage(proc: MockChildProcess, payload: unknown): void {
  proc.stdout.write(`${JSON.stringify(payload)}\n`);
}

function collectClientMessages(
  proc: MockChildProcess,
): Array<Record<string, unknown>> {
  const raw: unknown = proc.stdin.read();
  const chunks: string =
    typeof raw === 'string'
      ? raw
      : raw instanceof Buffer
        ? raw.toString('utf8')
        : '';
  if (!chunks) return [];
  return chunks
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

// The elapsed-time budget is the primary guard, but callers under
// `jest.useFakeTimers({ doNotFake: ['setImmediate'] })` freeze `Date.now()`
// while `flush()` keeps running on a real `setImmediate`. The attempt bound is
// what guarantees termination there — without it a missing request spins until
// the Jest global timeout instead of failing fast, and the caller's `finally`
// never restores real timers.
async function waitForClientRequest(
  proc: MockChildProcess,
  method: string,
  deadline = Date.now() + 2_000,
  remainingAttempts = 10_000,
): Promise<Record<string, unknown>> {
  const request = collectClientMessages(proc).find(
    (message) => message.method === method,
  );
  if (request) return request;
  if (Date.now() >= deadline || remainingAttempts <= 0) {
    throw new Error(`Expected ${method} request`);
  }
  await flush();
  return waitForClientRequest(proc, method, deadline, remainingAttempts - 1);
}

// The full CI suite runs more than 26,000 tests concurrently, so a short
// wall-clock deadline can expire while the event loop is merely starved. These
// readiness cases care about ordering rather than elapsed time; bound them by
// scheduler turns and let the enclosing Jest timeout catch a genuine hang.
function waitForClientRequestUnderLoad(
  proc: MockChildProcess,
  method: string,
): Promise<Record<string, unknown>> {
  return waitForClientRequest(proc, method, Number.POSITIVE_INFINITY, 100_000);
}

/**
 * Same wait as `waitForClientRequest`, but every polled message is appended to
 * `sink` instead of discarded, so a spec can assert on what the client sent
 * *instead* of the expected method — and so the failure message names it.
 */
async function waitForClientRequestRecording(
  proc: MockChildProcess,
  method: string,
  sink: Array<Record<string, unknown>>,
  deadline = Date.now() + 2_000,
  remainingAttempts = 10_000,
): Promise<Record<string, unknown>> {
  const messages = collectClientMessages(proc);
  sink.push(...messages);
  const request = messages.find((message) => message.method === method);
  if (request) return request;
  if (Date.now() >= deadline || remainingAttempts <= 0) {
    throw new Error(
      `Expected ${method} request; saw ${sink
        .map((message) => String(message.method))
        .join(', ')}`,
    );
  }
  await flush();
  return waitForClientRequestRecording(
    proc,
    method,
    sink,
    deadline,
    remainingAttempts - 1,
  );
}

// A large thread/start can fill the mock PassThrough. Reading releases queued
// writes on a later scheduler turn; flush() alone cannot make them readable.
async function waitForClientResponse(
  proc: MockChildProcess,
  id: string,
): Promise<Array<Record<string, unknown>>> {
  const messages: Array<Record<string, unknown>> = [];
  const deadline = Date.now() + 2_000;
  for (let attempt = 0; attempt < 10_000; attempt += 1) {
    messages.push(...collectClientMessages(proc));
    if (messages.some((message) => message.id === id)) return messages;
    if (Date.now() >= deadline) break;
    await flush();
  }
  throw new Error(`Expected client response to ${id}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Builds a fake `ApprovalSessionHandle` (Task 5/6) that resolves `check()`
 * with a fixed outcome instead of exercising the real rule engine / renderer
 * prompt bridge. Standing in for a session-rule allow, an engine deny, etc.
 */
function createFakeApprovalSession(
  outcome: ApprovalOutcome,
): ApprovalSessionHandle & {
  check: jest.Mock<
    Promise<ApprovalOutcome>,
    [ApprovalCheck, ApprovalCheckDisplay]
  >;
} {
  return {
    check: jest.fn<
      Promise<ApprovalOutcome>,
      [ApprovalCheck, ApprovalCheckDisplay]
    >(() => Promise.resolve(outcome)),
    setMode: jest.fn(),
    reevaluatePendingApprovals: jest.fn<Promise<void>, []>(() =>
      Promise.resolve(),
    ),
    dispose: jest.fn(),
  };
}

function createConnectionOwner(
  overrides: Partial<CodexAppServerConnectionOwner> = {},
): CodexAppServerConnectionOwner {
  return {
    hasActiveTurn: jest.fn(() => false),
    getActiveTurnInterruptTarget: jest.fn(() => null),
    cancelPendingTurnStart: jest.fn(),
    rejectActiveTurn: jest.fn(),
    markProcessSuspended: jest.fn(),
    markProcessFailed: jest.fn(),
    handleConnectionNotification: jest.fn(),
    handleRequestUserInput: jest.fn(async () => {}),
    handleDynamicToolCall: jest.fn(async () => {}),
    handleApprovalRequest: jest.fn(async () => {}),
    handleMcpElicitation: jest.fn(async () => {}),
    ...overrides,
  };
}

function findCodexCommandOutput(
  events: unknown[],
  eventType: string,
  itemId: string,
): string {
  for (const candidate of events) {
    if (!isRecord(candidate) || candidate.type !== 'codex') {
      continue;
    }
    if (!isRecord(candidate.event) || candidate.event.type !== eventType) {
      continue;
    }
    if (!isRecord(candidate.event.item) || candidate.event.item.id !== itemId) {
      continue;
    }

    const output = candidate.event.item.aggregated_output;
    if (typeof output === 'string') {
      return output;
    }
  }

  throw new Error(`Expected ${eventType} command output for ${itemId}`);
}

function getRequestParams(
  message: Record<string, unknown>,
): Record<string, unknown> {
  if (!isRecord(message.params)) {
    throw new Error('Expected request params');
  }

  return message.params;
}

function makeThreadResult(
  threadId: string,
  turns: Record<string, unknown>[] = [],
): Record<string, unknown> {
  return {
    thread: {
      id: threadId,
      preview: '',
      ephemeral: false,
      modelProvider: 'openai',
      createdAt: 1,
      updatedAt: 1,
      status: { type: 'idle' },
      path: null,
      cwd: '/tmp/repo',
      cliVersion: '0.114.0',
      source: 'vscode',
      agentNickname: null,
      agentRole: null,
      gitInfo: null,
      name: null,
      turns,
    },
    model: 'gpt-6-sol',
    modelProvider: 'openai',
    serviceTier: null,
    cwd: '/tmp/repo',
    approvalPolicy: 'never',
    sandbox: { type: 'dangerFullAccess' },
    reasoningEffort: 'high',
  };
}

function createClient(
  events: unknown[] = [],
  approvalSession?: ApprovalSessionHandle,
): CodexAppServerClient {
  return new CodexAppServerClient({
    cwd: '/tmp/repo',
    projectId: 'project',
    worktreeId: 'worktree',
    chatId: 'chat',
    sessionKey: 'project/worktree/chat',
    onEvent: (event): void => {
      events.push(event);
    },
    getWindow: (): null => null,
    approvalSession,
  });
}

interface ClientBackgroundTestApi {
  hasLiveBackgroundWork?: () => boolean;
  getBackgroundSnapshot?: () => unknown;
  subscribeBackgroundWork?: (
    listener: (snapshot: unknown) => void,
  ) => () => void;
}

function readClientBackgroundApi(
  client: CodexAppServerClient,
): ClientBackgroundTestApi {
  const hasLiveBackgroundWork = Reflect.get(client, 'hasLiveBackgroundWork');
  const getBackgroundSnapshot = Reflect.get(client, 'getBackgroundSnapshot');
  const subscribeBackgroundWork = Reflect.get(
    client,
    'subscribeBackgroundWork',
  );
  return {
    ...(typeof hasLiveBackgroundWork === 'function'
      ? {
          hasLiveBackgroundWork: (): boolean => {
            const result: unknown = Reflect.apply(
              hasLiveBackgroundWork,
              client,
              [],
            );
            return result === true;
          },
        }
      : {}),
    ...(typeof getBackgroundSnapshot === 'function'
      ? {
          getBackgroundSnapshot: (): unknown =>
            Reflect.apply(getBackgroundSnapshot, client, []),
        }
      : {}),
    ...(typeof subscribeBackgroundWork === 'function'
      ? {
          subscribeBackgroundWork: (
            listener: (snapshot: unknown) => void,
          ): (() => void) => {
            const result: unknown = Reflect.apply(
              subscribeBackgroundWork,
              client,
              [listener],
            );
            return (): void => {
              if (typeof result === 'function')
                Reflect.apply(result, undefined, []);
            };
          },
        }
      : {}),
  };
}

function readBackgroundWork(snapshot: unknown): Array<Record<string, unknown>> {
  if (!isRecord(snapshot) || !Array.isArray(snapshot.work)) return [];
  return snapshot.work.filter(isRecord);
}

async function collectClientMessagesUntil(
  proc: MockChildProcess,
  predicate: (messages: readonly Record<string, unknown>[]) => boolean,
): Promise<Array<Record<string, unknown>>> {
  const messages: Array<Record<string, unknown>> = [];
  for (let attempt = 0; attempt < 100; attempt += 1) {
    messages.push(...collectClientMessages(proc));
    if (predicate(messages)) return messages;
    await flush();
  }
  messages.push(...collectClientMessages(proc));
  return messages;
}

async function startActiveTurn(
  client: CodexAppServerClient,
  proc: MockChildProcess,
  mcpServerNames: readonly string[] = [],
  executionUserMessageId?: string,
  submissionId?: string,
  clientUserMessageId?: string,
  userMessageId?: string,
  nativeTurnStart?: NativeTurnStartFixture,
): Promise<{ turnPromise: Promise<CodexTurnTestResult> }> {
  const turnOptions: TurnStartOptionsWithShadowIds = {
    text: 'Run',
    cwd: '/tmp/repo',
    model: 'gpt-6-sol',
    thinkingLevel: 'high',
    planMode: false,
    ...(executionUserMessageId ? { executionUserMessageId } : {}),
    ...(submissionId ? { submissionId } : {}),
    ...(clientUserMessageId ? { clientUserMessageId } : {}),
    ...(userMessageId ? { userMessageId } : {}),
  };
  const turnPromise = client.startTurn(turnOptions);

  await flush();
  emitServerMessage(proc, {
    id: 1,
    result: { userAgent: 'ua', codexHome: '/tmp/.codex' },
  });
  await flush();
  emitServerMessage(proc, { id: 2, result: makeThreadResult('thread-1') });
  await flush();
  for (const name of mcpServerNames) {
    emitServerMessage(proc, {
      method: 'mcpServer/startupStatus/updated',
      params: {
        threadId: 'thread-1',
        name,
        status: 'ready',
        error: null,
        failureReason: null,
      },
    });
  }
  if (mcpServerNames.length > 0) {
    await new Promise((resolve) => setTimeout(resolve, 125));
  } else {
    await flush();
  }
  const turnStartMessages =
    mcpServerNames.length > 0
      ? collectClientMessages(proc).filter(
          (message) => message.method === 'turn/start',
        )
      : [];
  const turnStart =
    mcpServerNames.length > 0
      ? turnStartMessages[turnStartMessages.length - 1]
      : { id: 3 };
  if (!turnStart) throw new Error('Expected initial turn/start request');
  if (
    nativeTurnStart?.notificationFirst === true &&
    nativeTurnStart.notificationTurn
  ) {
    emitServerMessage(proc, {
      method: 'turn/started',
      params: {
        threadId: 'thread-1',
        turn: nativeTurnStart.notificationTurn,
      },
    });
    await flush();
  }
  emitServerMessage(proc, {
    id: turnStart?.id,
    result: {
      turn: nativeTurnStart?.responseTurn ?? {
        id: 'turn-1',
        items: [],
        status: 'inProgress',
        error: null,
      },
    },
  });
  await flush();
  if (
    nativeTurnStart?.notificationFirst !== true &&
    nativeTurnStart?.notificationTurn
  ) {
    emitServerMessage(proc, {
      method: 'turn/started',
      params: {
        threadId: 'thread-1',
        turn: nativeTurnStart.notificationTurn,
      },
    });
    await flush();
  }

  return { turnPromise };
}

async function completeImmediateTurnRestartTool(
  proc: MockChildProcess,
  callId: string,
): Promise<void> {
  emitServerMessage(proc, {
    id: `server-req-${callId}`,
    method: 'item/tool/call',
    params: {
      threadId: 'thread-1',
      turnId: 'turn-1',
      callId,
      namespace: null,
      tool: 'canopy_immediate_turn_restart',
      arguments: {},
    },
  });
  await flush();
  emitServerMessage(proc, {
    method: 'item/completed',
    params: {
      threadId: 'thread-1',
      turnId: 'turn-1',
      item: {
        id: callId,
        type: 'dynamicToolCall',
        namespace: null,
        tool: 'canopy_immediate_turn_restart',
        arguments: {},
        status: 'completed',
        contentItems: [
          {
            type: 'inputText',
            text: 'Restarting this turn with refreshed MCP connections.',
          },
        ],
        success: true,
      },
    },
  });
  await flush();
}

function completeRootTurn(
  proc: MockChildProcess,
  turnId = 'turn-1',
  nativeTiming?: {
    completedAt?: number | null;
    durationMs?: number | null;
  },
): void {
  emitServerMessage(proc, {
    method: 'turn/completed',
    params: {
      threadId: 'thread-1',
      turn: {
        id: turnId,
        items: [],
        status: 'completed',
        error: null,
        ...nativeTiming,
      },
    },
  });
}

async function startObservedRootRun(
  client: CodexAppServerClient,
  turnId: string,
  threadId = 'thread-1',
  items: readonly Record<string, unknown>[] = [],
): Promise<void> {
  await client.handleConnectionNotification('turn/started', {
    params: {
      threadId,
      turn: { id: turnId, items, status: 'inProgress' },
    },
  });
}

async function completeObservedRootRun(
  client: CodexAppServerClient,
  turnId: string,
  status: 'completed' | 'interrupted' = 'completed',
  threadId = 'thread-1',
): Promise<void> {
  await client.handleConnectionNotification('turn/completed', {
    params: {
      threadId,
      turn: { id: turnId, items: [], status, error: null },
    },
  });
}

interface CodexTurnTestResult {
  status: string;
  usage?: unknown;
  error?: string;
  proposedPlanText?: string;
}

interface NativeTurnStartFixture {
  responseTurn: Record<string, unknown>;
  notificationTurn?: Record<string, unknown>;
  notificationFirst?: boolean;
}

type TurnLifecycleObservation =
  | {
      type: 'turn-started';
      threadId: string;
      turnId: string;
      origin: 'user' | 'autonomous' | 'restart';
      submissionId?: string;
      userMessageId?: string;
      merged?: boolean;
    }
  | {
      type: 'input-bound';
      threadId: string;
      turnId: string;
      submissionId?: string;
      userMessageId?: string;
    }
  | {
      type: 'turn-completed';
      threadId: string;
      turnId: string;
      status: 'completed' | 'failed' | 'interrupted';
      error?: string;
    }
  | {
      type: 'session-state';
      threadId: string;
      turnId?: string;
      state: 'running' | 'requires_action' | 'idle' | 'reconnecting';
    };

type TurnStartOptionsWithShadowIds = Parameters<
  CodexAppServerClient['startTurn']
>[0] & {
  submissionId?: string;
  userMessageId?: string;
  clientUserMessageId?: string;
};

async function startTurnUntilThreadRequest(
  client: CodexAppServerClient,
  proc: MockChildProcess,
  options: TurnStartOptionsWithShadowIds = {
    text: 'Run',
    cwd: '/tmp/repo',
    model: 'gpt-6-sol',
    thinkingLevel: 'high',
    planMode: false,
  },
): Promise<{
  turnPromise: Promise<unknown>;
  threadRequest: Record<string, unknown>;
}> {
  const turnPromise = client.startTurn(options);

  await flush();
  emitServerMessage(proc, {
    id: 1,
    result: { userAgent: 'ua', codexHome: '/tmp/.codex' },
  });
  await flush();

  const messages = collectClientMessages(proc);
  const threadRequest = messages.find(
    (message): boolean =>
      message.method === 'thread/start' || message.method === 'thread/resume',
  );
  if (!threadRequest) {
    throw new Error('Expected thread start or resume request');
  }

  return { turnPromise, threadRequest };
}

// Same provider tool name and description; only the advertised action enum changes.
function dispatchActionTools(actionTypes: string[]): DynamicToolSpec[] {
  return [
    {
      type: 'function',
      name: 'canopy_dispatch_action',
      description: 'Dispatch a Canopy action',
      inputSchema: {
        type: 'object',
        required: ['action'],
        properties: {
          action: {
            type: 'object',
            required: ['type'],
            properties: { type: { type: 'string', enum: actionTypes } },
          },
        },
      },
    },
  ];
}

describe('CodexAppServerClient', () => {
  let proc: MockChildProcess;

  beforeEach(() => {
    jest.clearAllMocks();
    createPendingRequestMock.mockReset();
    // The observed canonical CODEX_HOME is process-global and rejects a second,
    // different value, so specs that point the client at a real rollout
    // directory need a clean slate.
    resetCanonicalCodexHomeForTests();
    hiddenConfigReads.count = 0;
    hiddenConfigReads.realIdsByVisibleId.clear();
    deferredToolsReloadCoordinator.resetForTests();
    setPlatform('darwin');
    // Keep the stable synthetic id asserted by legacy ask-user tests at this mock boundary.
    randomUUIDMock.mockReturnValue(
      'generated-request-id' as ReturnType<typeof NodeCrypto.randomUUID>,
    );
    proc = new MockChildProcess();
    spawnMock.mockReturnValue(proc);
  });

  afterEach(async () => {
    // Safety net: a test that fails or times out inside a fake-timer block
    // never reaches its own `finally`, which would leak fake timers into every
    // subsequent test in this file.
    jest.useRealTimers();
    CANOPY_INJECTED_TOOL_REGISTRY.load_deferred_tools.codexToolName =
      defaultLoadDeferredToolsName;
    deferredToolsReloadCoordinator.resetForTests();
    await resetCodexRuntimeServiceForTests();
    if (originalPlatformDescriptor) {
      Object.defineProperty(process, 'platform', originalPlatformDescriptor);
    }
  });

  it('forwards ingestion lag changes to the optional client callback', () => {
    const change: CodexIngestionLagChange = {
      outcome: 'entered',
      lagMs: 5_001,
      peakLagMs: 5_250,
      episodeMs: 250,
      thresholdMs: 5_000,
      source: 'receipt',
    };
    const onIngestionLagChange = jest.fn();
    const client = new CodexAppServerClient({
      cwd: '/tmp/repo',
      projectId: 'project',
      worktreeId: 'worktree',
      chatId: 'chat',
      sessionKey: 'project/worktree/chat',
      onEvent: jest.fn(),
      getWindow: () => null,
      onIngestionLagChange,
    });

    try {
      client.handleIngestionLagChange(change);
      expect(onIngestionLagChange).toHaveBeenCalledWith(change);
    } finally {
      client.dispose();
    }
  });

  it('forwards ingestion lag samples to the optional client callback only', () => {
    const sample: CodexIngestionLagSample = {
      lagMs: 5_100,
      source: 'receipt',
      sampledAtMs: Date.now(),
      catchingUp: true,
    };
    const onEvent = jest.fn();
    const onIngestionLagSample = jest.fn();
    const clientOptions = {
      cwd: '/tmp/repo',
      projectId: 'project',
      worktreeId: 'worktree',
      chatId: 'chat',
      sessionKey: 'project/worktree/chat',
      onEvent,
      getWindow: () => null,
      onIngestionLagSample,
    };
    const client = new CodexAppServerClient(clientOptions);

    try {
      expect(dispatchIngestionLagSample(client, sample)).toBe(true);
      expect(onIngestionLagSample).toHaveBeenCalledWith(sample);
      expect(onEvent).not.toHaveBeenCalled();
    } finally {
      client.dispose();
    }
  });

  it('isolates throwing and rejecting ingestion lag sample callbacks', async () => {
    const sample: CodexIngestionLagSample = {
      lagMs: 5_100,
      source: 'provider',
      sampledAtMs: Date.now(),
      catchingUp: true,
    };
    let callbackCount = 0;
    const onIngestionLagSample = jest.fn((): void | Promise<void> => {
      callbackCount += 1;
      if (callbackCount === 1) throw new Error('synchronous observer failure');
      return Promise.reject(new Error('asynchronous observer failure'));
    });
    const clientOptions = {
      cwd: '/tmp/repo',
      projectId: 'project',
      worktreeId: 'worktree',
      chatId: 'chat',
      sessionKey: 'project/worktree/chat',
      onEvent: jest.fn(),
      getWindow: () => null,
      onIngestionLagSample,
    };
    const client = new CodexAppServerClient(clientOptions);

    try {
      expect(dispatchIngestionLagSample(client, sample)).toBe(true);
      expect(
        dispatchIngestionLagSample(client, {
          ...sample,
          sampledAtMs: sample.sampledAtMs + 1,
        }),
      ).toBe(true);
      await flush();
      expect(onIngestionLagSample).toHaveBeenCalledTimes(2);
    } finally {
      client.dispose();
    }
  });

  it('returns the connection ingestion lag snapshot', () => {
    const snapshot: CodexIngestionLagSnapshot = {
      lagMs: 5_001,
      catchingUp: true,
      source: 'provider',
    };
    const ingestionLag = jest
      .spyOn(CodexAppServerConnection.prototype, 'ingestionLag')
      .mockReturnValue(snapshot);
    const client = new CodexAppServerClient({
      cwd: '/tmp/repo',
      projectId: 'project',
      worktreeId: 'worktree',
      chatId: 'chat',
      sessionKey: 'project/worktree/chat',
      onEvent: jest.fn(),
      getWindow: () => null,
    });

    try {
      expect(client.getIngestionLag()).toEqual(snapshot);
      expect(ingestionLag).toHaveBeenCalledWith(client);
    } finally {
      client.dispose();
      ingestionLag.mockRestore();
    }
  });

  it('isolates a throwing ingestion lag callback from the connection owner', () => {
    const client = new CodexAppServerClient({
      cwd: '/tmp/repo',
      projectId: 'project',
      worktreeId: 'worktree',
      chatId: 'chat',
      sessionKey: 'project/worktree/chat',
      onEvent: jest.fn(),
      getWindow: () => null,
      onIngestionLagChange: () => {
        throw new Error('observer failure');
      },
    });

    try {
      expect(() =>
        client.handleIngestionLagChange({
          outcome: 'drained',
          lagMs: 0,
          peakLagMs: 5_250,
          episodeMs: 1_500,
          thresholdMs: 5_000,
          source: 'provider',
        }),
      ).not.toThrow();
    } finally {
      client.dispose();
    }
  });

  describe('dynamic call leases', () => {
    async function fixture() {
      const signals = new Map<string, AbortSignal | undefined>();
      const releases = new Map<
        string,
        (value: { success: boolean; contentItems: [] }) => void
      >();
      let state = createEmptyTranscriptReducerState();
      const client = new CodexAppServerClient({
        cwd: '/tmp/repo',
        projectId: 'project',
        worktreeId: 'worktree',
        chatId: 'chat',
        sessionKey: 'project/worktree/chat',
        getWindow: () => null,
        onEvent: (event) => {
          if (!isRecord(event) || event.type !== 'codex') return;
          const payload: unknown = event.event;
          if (isRecord(payload))
            state = applyCodexTranscriptEvent(state, payload, {
              now: Date.now(),
              createMessageId: () => 'message',
              childToolLiveness: { kind: 'unknown' },
            });
        },
        dynamicToolCallHandler: (call, options) => {
          signals.set(call.callId, options?.signal);
          return new Promise((resolve) => {
            releases.set(call.callId, resolve);
          });
        },
      });
      const { turnPromise } = await startActiveTurn(client, proc);
      collectClientMessages(proc);
      function call(
        id = 'call',
        threadId = 'thread-1',
        turnId = 'turn-1',
        tool = 'canopy_dispatch_action',
      ) {
        const params = {
          threadId,
          turnId,
          callId: id,
          namespace: null,
          tool,
          arguments: {},
        };
        emitServerMessage(proc, {
          method: 'item/started',
          params: {
            threadId,
            turnId,
            item: {
              ...params,
              id,
              type: 'dynamicToolCall',
              status: 'inProgress',
              contentItems: [],
              success: null,
            },
          },
        });
        emitServerMessage(proc, { id, method: 'item/tool/call', params });
      }
      return {
        client,
        turnPromise,
        signals,
        releases,
        call,
        state: () => state,
      };
    }

    it('aborts a provider-resolved call without replying', async () => {
      const f = await fixture();
      f.call();
      await flush();
      emitServerMessage(proc, {
        method: 'serverRequest/resolved',
        params: { threadId: 'thread-1', requestId: 'call' },
      });
      await flush();
      try {
        expect(f.signals.get('call')?.aborted).toBe(true);
        f.releases.get('call')?.({ success: true, contentItems: [] });
        await flush();
        expect(
          collectClientMessages(proc).filter((m) => m.id === 'call'),
        ).toEqual([]);
      } finally {
        f.releases.get('call')?.({ success: true, contentItems: [] });
        completeRootTurn(proc);
        await f.turnPromise;
        f.client.dispose();
      }
    });

    it.each([
      'canopy_dispatch_action',
      'canopy_ask_user_question',
      APP_ADVISOR_TOOL_REGISTRY.ask_user_question.codexToolName,
    ])(
      'fails %s at its budget once and projects provider failure onto the row',
      async (tool) => {
        const f = await fixture();
        jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
        try {
          f.call('call', 'thread-1', 'turn-1', tool);
          await flush();
          const budget =
            tool === 'canopy_ask_user_question' ||
            tool === APP_ADVISOR_TOOL_REGISTRY.ask_user_question.codexToolName
              ? ASK_USER_HTTP_TIMEOUT_MS
              : CANOPY_MCP_TOOL_TIMEOUT_MS;
          await jest.advanceTimersByTimeAsync(budget - 1);
          expect(f.signals.get('call')?.aborted).toBe(false);
          expect(
            collectClientMessages(proc).filter((m) => m.id === 'call'),
          ).toEqual([]);
          await jest.advanceTimersByTimeAsync(1);
          expect(f.signals.get('call')?.aborted).toBe(true);
          const replies = collectClientMessages(proc).filter(
            (m) => m.id === 'call',
          );
          expect(replies).toMatchObject([
            {
              result: {
                success: false,
                contentItems: [
                  {
                    text: expect.stringMatching(
                      /time limit.*effects may be incomplete/i,
                    ),
                  },
                ],
              },
            },
          ]);
          expect(replies).toHaveLength(1);
          f.releases.get('call')?.({ success: true, contentItems: [] });
          await flush();
          expect(
            collectClientMessages(proc).filter((m) => m.id === 'call'),
          ).toEqual([]);
          // The normal provider acknowledgement, not a synthetic replacement.
          emitServerMessage(proc, {
            method: 'item/completed',
            params: {
              threadId: 'thread-1',
              turnId: 'turn-1',
              item: {
                type: 'dynamicToolCall',
                id: 'call',
                namespace: null,
                tool,
                arguments: {},
                status: 'completed',
                ...(replies[0]?.result as object),
              },
            },
          });
          await flush();
          expect(f.state().messages.flatMap((m) => m.blocks)).toContainEqual(
            expect.objectContaining({
              type: 'tool_result',
              toolUseId: 'codex-call',
              isError: true,
            }),
          );
        } finally {
          jest.useRealTimers();
          f.releases.get('call')?.({ success: true, contentItems: [] });
          completeRootTurn(proc);
          await f.turnPromise;
          f.client.dispose();
        }
      },
    );

    it.each(['root', 'child', 'fatal-error'])(
      'aborts only the matching %s terminal thread at read before transcript drain',
      async (control) => {
        const f = await fixture();
        emitServerMessage(proc, {
          method: 'thread/started',
          params: {
            thread: {
              id: 'child',
              source: {
                subAgent: { thread_spawn: { parent_thread_id: 'thread-1' } },
              },
            },
          },
        });
        await flush();
        f.call();
        f.call('child-call', 'child', 'child-turn');
        await flush();
        let release: () => void = () => undefined;
        const drain = new Promise<void>((resolve) => {
          release = resolve;
        });
        void f.turnPromise.catch(() => undefined);
        const targetThread = control === 'child' ? 'child' : 'thread-1';
        const targetTurn = control === 'child' ? 'child-turn' : 'turn-1';
        const terminal = f.client.handleConnectionNotification(
          control === 'fatal-error' ? 'error' : 'turn/completed',
          {
            params: {
              threadId: targetThread,
              ...(control === 'fatal-error'
                ? {
                    turnId: targetTurn,
                    willRetry: false,
                    error: { message: 'failed' },
                  }
                : {
                    turn: {
                      id: targetTurn,
                      items: [],
                      status: 'completed',
                      error: null,
                    },
                  }),
            },
          },
          drain,
        );
        try {
          expect(f.signals.get('call')?.aborted).toBe(control !== 'child');
          expect(f.signals.get('child-call')?.aborted).toBe(
            control === 'child',
          );
          release();
          await terminal;
          const cancelledId = control === 'child' ? 'child-call' : 'call';
          expect(f.state().messages.flatMap((m) => m.blocks)).toContainEqual(
            expect.objectContaining({
              type: 'tool_result',
              toolUseId: `codex-${cancelledId}`,
              isError: true,
            }),
          );
          // No provider completion arrived before the terminal. A stale later
          // provider success must not replace the synthetic open-row failure.
          emitServerMessage(proc, {
            method: 'item/completed',
            params: {
              threadId: targetThread,
              turnId: targetTurn,
              item: {
                type: 'dynamicToolCall',
                id: cancelledId,
                namespace: null,
                tool: 'canopy_dispatch_action',
                arguments: {},
                status: 'completed',
                success: true,
                contentItems: [],
              },
            },
          });
          await flush();
          expect(f.state().messages.flatMap((m) => m.blocks)).toContainEqual(
            expect.objectContaining({
              type: 'tool_result',
              toolUseId: `codex-${cancelledId}`,
              isError: true,
            }),
          );
        } finally {
          release();
          await terminal;
          if (control !== 'root') completeRootTurn(proc);
          await f.turnPromise.catch(() => undefined);
          f.releases.forEach((resolve) =>
            resolve({ success: true, contentItems: [] }),
          );
          await flush();
          f.client.dispose();
        }
      },
    );
  });

  it('builds pool keys exclusively from immutable spawn profiles', () => {
    const first = buildCodexAppServerPoolKey({
      profileKey: 'profile-a',
    });
    const second = buildCodexAppServerPoolKey({
      profileKey: 'profile-a',
    });

    expect(first).toBe(second);
    expect(first).toBe('profile:profile-a');
  });

  it('identifies only the selected provider and its exact URL', () => {
    const identity = codexThreadProviderRouteIdentity;
    const route = {
      model_provider: 'proxy',
      'model_providers.proxy': { base_url: 'http://127.0.0.1:1/a' },
    };
    expect(identity(route)).toBe(
      identity({
        ...route,
        model: 'other',
        mcp_servers: {},
        'model_providers.inactive': { base_url: 'elsewhere' },
      }),
    );
    expect(identity(route)).toBe(
      identity({
        model_provider: 'proxy',
        'model_providers.proxy.base_url': 'http://127.0.0.1:1/a',
      }),
    );
    const identities = [
      identity(undefined),
      identity({ model_provider: 'proxy' }),
      identity(route),
      identity({
        model_provider: 'other',
        'model_providers.other': { base_url: 'http://127.0.0.1:1/a' },
      }),
      identity({
        model_provider: 'proxy',
        'model_providers.proxy': { base_url: 'http://127.0.0.1:2/a' },
      }),
      identity({
        model_provider: 'proxy',
        'model_providers.proxy': { base_url: 'http://127.0.0.1:1/b' },
      }),
      identity({
        model_provider: 'proxy',
        'model_providers.proxy': { base_url: '' },
      }),
    ];
    expect(new Set(identities).size).toBe(identities.length);
  });

  it('leaves unknown plain-resume route state unknown', async () => {
    const observer = getCodexRuntimeService().attachInteractiveClient({
      owner: createConnectionOwner(),
    });
    const client = new CodexAppServerClient({
      cwd: '/tmp/repo',
      projectId: 'project',
      worktreeId: 'worktree',
      chatId: 'chat',
      sessionKey: 'project/worktree/chat',
      initialThreadId: 'thread-existing',
      threadConfig: { model_provider: 'proxy' },
      onEvent: jest.fn(),
      getWindow: () => null,
    });
    const { turnPromise, threadRequest } = await startTurnUntilThreadRequest(
      client,
      proc,
    );
    try {
      expect(threadRequest.method).toBe('thread/resume');
      emitServerMessage(proc, {
        id: threadRequest.id,
        result: makeThreadResult('thread-existing'),
      });
      await waitForClientRequest(proc, 'turn/start');
      expect(
        observer.loadedThreadProviderRoute('thread-existing'),
      ).toBeUndefined();
    } finally {
      client.dispose();
      observer.release();
      await expect(turnPromise).rejects.toThrow('session_destroyed');
    }
  });

  it.each(['cancel', 'dispose', 'close', 'replace-worker'] as const)(
    'does not record route readiness when setup is interrupted: %s',
    async (interruption) => {
      let releaseLease: (() => void) | undefined;
      const leaseWrite = new Promise<void>((resolve) => {
        releaseLease = resolve;
      });
      const observer = getCodexRuntimeService().attachInteractiveClient({
        owner: createConnectionOwner(),
      });
      const client = new CodexAppServerClient({
        cwd: '/tmp/repo',
        projectId: 'project',
        worktreeId: 'worktree',
        chatId: 'chat',
        sessionKey: 'project/worktree/chat',
        onEvent: jest.fn(),
        getWindow: () => null,
        capabilityStore: createCapabilityStoreMock({
          writeLease: jest.fn(() => leaseWrite),
        }),
      });
      const { turnPromise, threadRequest } = await startTurnUntilThreadRequest(
        client,
        proc,
      );
      void turnPromise.catch(() => {});
      emitServerMessage(proc, {
        id: threadRequest.id,
        result: makeThreadResult('actual-thread'),
      });
      await flush();
      expect(
        observer.loadedThreadProviderRoute('actual-thread'),
      ).toBeUndefined();
      if (interruption === 'cancel')
        client.cancelPendingTurnStart(new Error('turn_cancelled'));
      if (interruption === 'dispose') client.dispose();
      if (interruption === 'close')
        emitServerMessage(proc, {
          method: 'thread/closed',
          params: { threadId: 'actual-thread' },
        });
      if (interruption === 'replace-worker') {
        proc.emit('error', new Error('test worker replacement'));
        const newProc = new MockChildProcess();
        spawnMock.mockReturnValue(newProc);
        const initialization = observer.ensureInitialized();
        const initialize = await waitForClientRequest(newProc, 'initialize');
        emitServerMessage(newProc, {
          id: initialize.id,
          result: { userAgent: 'ua', codexHome: '/tmp/.codex' },
        });
        await initialization;
        observer.recordLoadedThreadProviderRoute(
          'replacement-thread',
          'replacement-route',
        );
      }
      releaseLease?.();
      if (interruption === 'cancel' || interruption === 'dispose') {
        const deletion = await waitForClientRequest(proc, 'thread/delete');
        emitServerMessage(proc, { id: deletion.id, result: {} });
      }
      try {
        await expect(turnPromise).rejects.toThrow(
          interruption === 'dispose'
            ? 'session_destroyed'
            : interruption === 'cancel'
              ? 'turn_cancelled'
              : 'closed',
        );
        expect(
          observer.loadedThreadProviderRoute('actual-thread'),
        ).toBeUndefined();
        if (interruption === 'replace-worker') {
          emitServerMessage(proc, {
            method: 'thread/closed',
            params: { threadId: 'replacement-thread' },
          });
          await flush();
          expect(observer.loadedThreadProviderRoute('replacement-thread')).toBe(
            'replacement-route',
          );
        }
      } finally {
        client.dispose();
        observer.release();
      }
    },
  );

  it.each([
    ['same route', 'http://127.0.0.1:3000/a', 'http://127.0.0.1:3000/a', false],
    [
      'route path change',
      'http://127.0.0.1:3000/a',
      'http://127.0.0.1:3000/b',
      true,
    ],
    [
      'route port change',
      'http://127.0.0.1:3000/a',
      'http://127.0.0.1:4000/a',
      true,
    ],
    ['proxy to native', 'http://127.0.0.1:3000/a', undefined, true],
    ['native to proxy', undefined, 'http://127.0.0.1:3000/a', true],
  ] as const)(
    'uses loaded configuration on owner handoff: %s',
    async (_label, from, to, rebuild) => {
      const config = (url: string | undefined) =>
        url
          ? {
              model_provider: 'proxy',
              'model_providers.proxy': { base_url: url },
            }
          : undefined;
      const options = {
        cwd: '/tmp/repo',
        projectId: 'project',
        worktreeId: 'worktree',
        chatId: 'chat',
        sessionKey: 'project/worktree/chat',
        onEvent: jest.fn(),
        getWindow: (): null => null,
      };
      const observer = getCodexRuntimeService().attachInteractiveClient({
        owner: createConnectionOwner(),
      });
      const original = new CodexAppServerClient({
        ...options,
        threadConfig: config(from),
      });
      const { turnPromise: first, threadRequest } =
        await startTurnUntilThreadRequest(original, proc);
      emitServerMessage(proc, {
        id: threadRequest.id,
        result: makeThreadResult('thread-1'),
      });
      const firstTurn = await waitForClientRequest(proc, 'turn/start');
      emitServerMessage(proc, {
        id: firstTurn.id,
        result: {
          turn: { id: 'turn-1', status: 'inProgress', items: [], error: null },
        },
      });
      await flush();
      completeRootTurn(proc);
      await first;
      expect(observer.loadedThreadProviderRoute('thread-1')).toBe(
        codexThreadProviderRouteIdentity(config(from)),
      );
      const replacement = new CodexAppServerClient({
        ...options,
        initialThreadId: 'thread-1',
        threadConfig: config(to),
        fallbackSeedItems: [
          {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'Run' }],
          },
        ],
      });
      original.dispose();
      expect(observer.loadedThreadProviderRoute('thread-1')).toBe(
        codexThreadProviderRouteIdentity(config(from)),
      );
      collectClientMessages(proc);
      const second = replacement.startTurn({
        text: 'Run',
        cwd: '/tmp/repo',
        model: 'gpt-6-sol',
        thinkingLevel: 'medium',
        planMode: false,
      });
      // Observe rejection even when the behavioral assertion below is red.
      void second.catch(() => {});
      try {
        // A rebuild first scans the observed CODEX_HOME for the source rollout
        // on the real filesystem, so a fixed number of ticks is not enough
        // when that directory exists on the host.
        let setup: Record<string, unknown> | undefined;
        const deadline = Date.now() + 2_000;
        while (!setup && Date.now() < deadline) {
          setup = collectClientMessages(proc).find(
            (request) =>
              request.method === 'thread/start' ||
              request.method === 'thread/resume',
          );
          if (!setup) await flush();
        }
        expect(setup?.method).toBe(rebuild ? 'thread/start' : 'thread/resume');
        if (rebuild && setup) {
          emitServerMessage(proc, {
            id: setup.id,
            result: makeThreadResult('replacement'),
          });
          const inject = await waitForClientRequest(
            proc,
            'thread/inject_items',
          );
          expect(getRequestParams(inject)).toMatchObject({
            threadId: 'replacement',
            items: [
              {
                type: 'message',
                role: 'user',
                content: [{ type: 'input_text', text: 'Run' }],
              },
            ],
          });
          expect(
            observer.loadedThreadProviderRoute('replacement'),
          ).toBeUndefined();
          emitServerMessage(proc, { id: inject.id, result: {} });
          await waitForClientRequest(proc, 'turn/start');
          expect(observer.loadedThreadProviderRoute('replacement')).toBe(
            codexThreadProviderRouteIdentity(config(to)),
          );
          expect(observer.loadedThreadProviderRoute('thread-1')).toBe(
            codexThreadProviderRouteIdentity(config(from)),
          );
        }
      } finally {
        replacement.dispose();
        observer.release();
      }
      // Outside `finally` so a failed assertion above is not masked.
      await expect(second).rejects.toThrow('session_destroyed');
    },
  );

  it('materializes history when the persisted capability snapshot differs', async () => {
    const capabilityStore = createCapabilityStoreMock({
      readLease: jest.fn().mockResolvedValue({
        version: 1,
        threadId: 'thread-existing',
        snapshotId: 'snapshot-old',
        rootContentIds: [],
        kind: 'persisted-chat',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }),
      writeLease: jest.fn().mockResolvedValue(undefined),
      releaseLease: jest.fn().mockResolvedValue(undefined),
    });
    const client = new CodexAppServerClient({
      cwd: '/tmp/repo',
      projectId: 'project',
      worktreeId: 'worktree',
      chatId: 'chat',
      sessionKey: 'project/worktree/chat',
      initialThreadId: 'thread-existing',
      onEvent: jest.fn(),
      getWindow: (): null => null,
      capabilityStore,
      capabilitySnapshotId: 'snapshot-new',
      fallbackSeedItems: [
        {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'prior context' }],
        },
      ],
    });

    const turnPromise = client.startTurn({
      text: 'Run',
      cwd: '/tmp/repo',
      model: 'gpt-6-sol',
      thinkingLevel: 'high',
      planMode: false,
    });
    const initializeRequest = await waitForClientRequest(proc, 'initialize');
    emitServerMessage(proc, {
      id: initializeRequest.id,
      result: { userAgent: 'ua', codexHome: '/tmp/.codex' },
    });
    const startRequest = await waitForClientRequest(proc, 'thread/start');
    emitServerMessage(proc, {
      id: startRequest.id,
      result: makeThreadResult('thread-materialized'),
    });
    const injectRequest = await waitForClientRequest(
      proc,
      'thread/inject_items',
    );
    expect(getRequestParams(injectRequest)).toEqual({
      threadId: 'thread-materialized',
      items: [
        {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'prior context' }],
        },
      ],
    });
    emitServerMessage(proc, { id: injectRequest.id, result: {} });
    await flush();
    expect(
      collectClientMessages(proc).some(
        (message) => message.method === 'thread/resume',
      ),
    ).toBe(false);
    client.dispose();
    await expect(turnPromise).rejects.toThrow('session_destroyed');
  });

  it('fingerprints DispatchAction enum changes and reconstructs recorded resumes with the current schema', async () => {
    const oldTools = dispatchActionTools(['worktree-chat.send_message']);
    const currentTools = dispatchActionTools([
      'projects.send_message',
      'bots.send_message',
    ]);
    expect(oldTools[0].name).toBe(currentTools[0].name);
    expect(dynamicToolSetId(oldTools)).not.toBe(dynamicToolSetId(currentTools));
    const oldSnapshotId = createCodexCapabilitySnapshotId({
      dynamicTools: oldTools,
    });
    const currentSnapshotId = createCodexCapabilitySnapshotId({
      dynamicTools: currentTools,
    });
    expect(oldSnapshotId).not.toBe(currentSnapshotId);

    const capabilityStore = createCapabilityStoreMock({
      readLease: jest.fn().mockResolvedValue({
        version: 1,
        threadId: 'thread-existing',
        snapshotId: oldSnapshotId,
        rootContentIds: [],
        kind: 'persisted-chat',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }),
    });
    const history = [
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'prior context' }],
      },
    ];
    const client = new CodexAppServerClient({
      cwd: '/tmp/repo',
      projectId: 'project',
      worktreeId: 'worktree',
      chatId: 'chat',
      sessionKey: 'project/worktree/chat',
      initialThreadId: 'thread-existing',
      onEvent: jest.fn(),
      getWindow: (): null => null,
      capabilityStore,
      dynamicTools: currentTools,
      fallbackSeedItems: history,
    });
    const turnPromise = client.startTurn({
      text: 'Run',
      cwd: '/tmp/repo',
      model: 'gpt-6-sol',
      thinkingLevel: 'high',
      planMode: false,
    });
    try {
      const requests: Array<Record<string, unknown>> = [];
      const initializeRequest = await waitForClientRequestRecording(
        proc,
        'initialize',
        requests,
      );
      emitServerMessage(proc, {
        id: initializeRequest.id,
        result: { userAgent: 'ua', codexHome: '/tmp/.codex' },
      });
      const threadRequest = await waitForClientRequestRecording(
        proc,
        'thread/start',
        requests,
      );
      expect(threadRequest.method).toBe('thread/start');
      expect(getRequestParams(threadRequest).dynamicTools).toEqual(
        currentTools,
      );
      expect(capabilityStore.readLease).toHaveBeenCalledWith('thread-existing');
      emitServerMessage(proc, {
        id: threadRequest.id,
        result: makeThreadResult('thread-materialized'),
      });
      const injectRequest = await waitForClientRequestRecording(
        proc,
        'thread/inject_items',
        requests,
      );
      expect(getRequestParams(injectRequest)).toEqual({
        threadId: 'thread-materialized',
        items: history,
      });
      emitServerMessage(proc, { id: injectRequest.id, result: {} });
      const turnRequest = await waitForClientRequestRecording(
        proc,
        'turn/start',
        requests,
      );
      expect(getRequestParams(turnRequest)).toMatchObject({
        threadId: 'thread-materialized',
        input: [{ type: 'text', text: 'Run' }],
      });
      expect(
        requests.filter((message) => message.method === 'turn/start'),
      ).toHaveLength(1);
      expect(
        requests.some((message) => message.method === 'thread/resume'),
      ).toBe(false);
    } finally {
      client.dispose();
      await expect(turnPromise).rejects.toThrow('session_destroyed');
    }
  });

  it('documents the oldest unrecorded-thread limitation: no roots or MCP means plain resume with the frozen schema', async () => {
    const currentTools = dispatchActionTools([
      'projects.send_message',
      'bots.send_message',
    ]);
    const capabilityStore = createCapabilityStoreMock();
    const client = new CodexAppServerClient({
      cwd: '/tmp/repo',
      projectId: 'project',
      worktreeId: 'worktree',
      chatId: 'chat',
      sessionKey: 'project/worktree/chat',
      initialThreadId: 'thread-oldest',
      onEvent: jest.fn(),
      getWindow: (): null => null,
      capabilityStore,
      dynamicTools: currentTools,
      selectedCapabilityRoots: [],
      mcpServersConfig: {},
    });
    const turnPromise = client.startTurn({
      text: 'Run',
      cwd: '/tmp/repo',
      model: 'gpt-6-sol',
      thinkingLevel: 'high',
      planMode: false,
    });
    try {
      const requests: Array<Record<string, unknown>> = [];
      const initializeRequest = await waitForClientRequestRecording(
        proc,
        'initialize',
        requests,
      );
      emitServerMessage(proc, {
        id: initializeRequest.id,
        result: { userAgent: 'ua', codexHome: '/tmp/.codex' },
      });
      const threadRequest = await waitForClientRequestRecording(
        proc,
        'thread/resume',
        requests,
      );
      expect(capabilityStore.readLease).toHaveBeenCalledWith('thread-oldest');
      expect(threadRequest.method).toBe('thread/resume');
      expect(getRequestParams(threadRequest)).toMatchObject({
        threadId: 'thread-oldest',
      });
      // Resume has no dynamicTools field: the server keeps whatever schema this
      // unrecorded thread started with, even though the client has current tools.
      expect(getRequestParams(threadRequest)).not.toHaveProperty(
        'dynamicTools',
      );
      emitServerMessage(proc, {
        id: threadRequest.id,
        result: makeThreadResult('thread-oldest'),
      });
      const turnRequest = await waitForClientRequestRecording(
        proc,
        'turn/start',
        requests,
      );
      expect(getRequestParams(turnRequest).threadId).toBe('thread-oldest');
      expect(
        requests.some(
          (message) =>
            message.method === 'thread/start' ||
            message.method === 'thread/inject_items',
        ),
      ).toBe(false);
    } finally {
      client.dispose();
      await expect(turnPromise).rejects.toThrow('session_destroyed');
    }
  });

  it('materializes sanitized history when the reasoning route family changes', async () => {
    const capabilityStore = createCapabilityStoreMock({
      readLease: jest.fn().mockResolvedValue({
        version: 1,
        threadId: 'thread-existing',
        snapshotId: 'snapshot-current',
        rootContentIds: [],
        kind: 'persisted-chat',
        reasoningRouteFamily: 'gateway:deepseek',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }),
      writeLease: jest.fn().mockResolvedValue(undefined),
      releaseLease: jest.fn().mockResolvedValue(undefined),
    });
    const client = new CodexAppServerClient({
      cwd: '/tmp/repo',
      projectId: 'project',
      worktreeId: 'worktree',
      chatId: 'chat',
      sessionKey: 'project/worktree/chat',
      initialThreadId: 'thread-existing',
      onEvent: jest.fn(),
      getWindow: (): null => null,
      capabilityStore,
      capabilitySnapshotId: 'snapshot-current',
      reasoningRouteFamily: 'native',
      fallbackSeedItems: [
        {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'prior context' }],
        },
        {
          type: 'reasoning',
          summary: [],
          content: [{ type: 'reasoning_text', text: 'private' }],
          encrypted_content: null,
        },
      ],
    });

    const turnPromise = client.startTurn({
      text: 'Run',
      cwd: '/tmp/repo',
      model: 'gpt-5.6-sol',
      thinkingLevel: 'high',
      planMode: false,
    });
    const initializeRequest = await waitForClientRequest(proc, 'initialize');
    emitServerMessage(proc, {
      id: initializeRequest.id,
      result: { userAgent: 'ua', codexHome: '/tmp/.codex' },
    });
    const startRequest = await waitForClientRequest(proc, 'thread/start');
    emitServerMessage(proc, {
      id: startRequest.id,
      result: makeThreadResult('thread-materialized'),
    });
    const injectRequest = await waitForClientRequest(
      proc,
      'thread/inject_items',
    );
    expect(getRequestParams(injectRequest).items).toEqual([
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'prior context' }],
      },
    ]);
    expect(
      collectClientMessages(proc).some(
        (message) => message.method === 'thread/resume',
      ),
    ).toBe(false);
    client.dispose();
    await expect(turnPromise).rejects.toThrow('session_destroyed');
  });

  it('keeps a trailing user message that matches the pending turn on a proactive rebuild', async () => {
    // Proactive reconstruction (route-family mismatch) runs BEFORE turn/start,
    // so the pending input has not been persisted and there is nothing to
    // de-duplicate. A history that legitimately ends with the same text must
    // survive. `Continue` is a realistic collision — it is exactly what the
    // usage-limit resume prompt sends.
    const trailingUserMessage = {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: 'Continue' }],
    };
    const capabilityStore = createCapabilityStoreMock({
      readLease: jest.fn().mockResolvedValue({
        version: 1,
        threadId: 'thread-existing',
        snapshotId: 'snapshot-current',
        rootContentIds: [],
        kind: 'persisted-chat',
        reasoningRouteFamily: 'gateway:deepseek',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }),
    });
    const client = new CodexAppServerClient({
      cwd: '/tmp/repo',
      projectId: 'project',
      worktreeId: 'worktree',
      chatId: 'chat',
      sessionKey: 'project/worktree/chat',
      initialThreadId: 'thread-existing',
      onEvent: jest.fn(),
      getWindow: (): null => null,
      capabilityStore,
      capabilitySnapshotId: 'snapshot-current',
      reasoningRouteFamily: 'native',
      fallbackSeedItems: [
        {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'prior reply' }],
        },
        trailingUserMessage,
      ],
    });

    const turnPromise = client.startTurn({
      text: 'Continue',
      cwd: '/tmp/repo',
      model: 'gpt-5.6-sol',
      thinkingLevel: 'high',
      planMode: false,
    });
    const initializeRequest = await waitForClientRequest(proc, 'initialize');
    emitServerMessage(proc, {
      id: initializeRequest.id,
      result: { userAgent: 'ua', codexHome: '/tmp/.codex' },
    });
    const startRequest = await waitForClientRequest(proc, 'thread/start');
    emitServerMessage(proc, {
      id: startRequest.id,
      result: makeThreadResult('thread-materialized'),
    });
    const injectRequest = await waitForClientRequest(
      proc,
      'thread/inject_items',
    );
    const injectedItems = getRequestParams(injectRequest).items;
    emitServerMessage(proc, { id: injectRequest.id, result: {} });
    await flush();
    client.dispose();
    await expect(turnPromise).rejects.toThrow('session_destroyed');
    expect(injectedItems).toEqual([
      {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'prior reply' }],
      },
      trailingUserMessage,
    ]);
  });

  it('drops the persisted failed input on a forced retry rebuild', async () => {
    // The retry rebuild runs AFTER a turn already failed, so the rollout does
    // contain that input and the caller is about to re-send it. Exactly one
    // copy is removed. This must be driven through a real rollout: the trim is
    // rollout-only, because the renderer fallback already excluded the pending
    // message by id.
    const codexHome = await writeRolloutCodexHome('thread-existing', [
      {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'prior reply' }],
      },
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'Continue' }],
      },
    ]);
    const capabilityStore = createCapabilityStoreMock({
      readLease: jest.fn().mockResolvedValue(null),
    });
    const client = new CodexAppServerClient({
      cwd: '/tmp/repo',
      projectId: 'project',
      worktreeId: 'worktree',
      chatId: 'chat',
      sessionKey: 'project/worktree/chat',
      initialThreadId: 'thread-existing',
      onEvent: jest.fn(),
      getWindow: (): null => null,
      capabilityStore,
      capabilitySnapshotId: 'snapshot-current',
      reasoningRouteFamily: 'native',
      forceMaterializeOnResume: true,
      fallbackSeedItems: [],
    });

    const turnPromise = client.startTurn({
      text: 'Continue',
      cwd: '/tmp/repo',
      model: 'gpt-5.6-sol',
      thinkingLevel: 'high',
      planMode: false,
    });
    // thread/start goes out only after the client reads the rollout from disk,
    // which can take longer than a wall-clock deadline in the full suite. If a
    // wait still fails, dispose and let the turn settle so it cannot outlive
    // this spec and reject while a later spec runs.
    void turnPromise.catch(() => undefined);
    let injectedItems: unknown;
    try {
      const initializeRequest = await waitForClientRequestUnderLoad(
        proc,
        'initialize',
      );
      emitServerMessage(proc, {
        id: initializeRequest.id,
        result: { userAgent: 'ua', codexHome },
      });
      const startRequest = await waitForClientRequestUnderLoad(
        proc,
        'thread/start',
      );
      emitServerMessage(proc, {
        id: startRequest.id,
        result: makeThreadResult('thread-materialized'),
      });
      const injectRequest = await waitForClientRequestUnderLoad(
        proc,
        'thread/inject_items',
      );
      injectedItems = getRequestParams(injectRequest).items;
      emitServerMessage(proc, { id: injectRequest.id, result: {} });
      await flush();
    } finally {
      client.dispose();
      await turnPromise.catch(() => undefined);
    }
    await expect(turnPromise).rejects.toThrow('session_destroyed');
    expect(injectedItems).toEqual([
      {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'prior reply' }],
      },
    ]);
  });

  it.each([
    'thread not found: 019f8b17-16cf-7671-9f73-4cfe05d355c9',
    'no rollout found for thread id 019f8b17-16cf-7671-9f73-4cfe05d355c9',
  ])('reconstructs a missing persisted thread after %s', async (message) => {
    const priorReply = {
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: 'prior reply' }],
    };
    const client = new CodexAppServerClient({
      cwd: '/tmp/repo',
      projectId: 'project',
      worktreeId: 'worktree',
      chatId: 'chat',
      sessionKey: 'project/worktree/chat',
      initialThreadId: '019f8b17-16cf-7671-9f73-4cfe05d355c9',
      onEvent: jest.fn(),
      getWindow: (): null => null,
      fallbackSeedItems: [priorReply],
    });
    const { turnPromise, threadRequest } = await startTurnUntilThreadRequest(
      client,
      proc,
    );
    void turnPromise.catch(() => undefined);
    try {
      expect(threadRequest.method).toBe('thread/resume');
      emitServerMessage(proc, {
        id: threadRequest.id,
        error: { code: -32001, message },
      });
      const start = await waitForClientRequest(proc, 'thread/start');
      emitServerMessage(proc, {
        id: start.id,
        result: makeThreadResult('thread-recovered'),
      });
      const inject = await waitForClientRequest(proc, 'thread/inject_items');
      expect(getRequestParams(inject).items).toEqual([priorReply]);
      emitServerMessage(proc, { id: inject.id, result: {} });
      await waitForClientRequest(proc, 'turn/start');
    } finally {
      client.dispose();
      await turnPromise.catch(() => undefined);
    }
  });

  it('does not reconstruct after an unrelated resume failure', async () => {
    const client = new CodexAppServerClient({
      cwd: '/tmp/repo',
      projectId: 'project',
      worktreeId: 'worktree',
      chatId: 'chat',
      sessionKey: 'project/worktree/chat',
      initialThreadId: '019f8b17-16cf-7671-9f73-4cfe05d355c9',
      onEvent: jest.fn(),
      getWindow: (): null => null,
    });
    const { turnPromise, threadRequest } = await startTurnUntilThreadRequest(
      client,
      proc,
    );
    const failure = expect(turnPromise).rejects.toThrow(
      'authentication required',
    );
    emitServerMessage(proc, {
      id: threadRequest.id,
      error: { code: -32001, message: 'authentication required' },
    });
    await failure;
    expect(
      collectClientMessages(proc).some(
        (request) => request.method === 'thread/start',
      ),
    ).toBe(false);
    client.dispose();
  });

  it('retries a resume rejected while the thread is closing without rebuilding it', async () => {
    const threadId = '019f8b17-16cf-7671-9f73-4cfe05d355c9';
    const client = new CodexAppServerClient({
      cwd: '/tmp/repo',
      projectId: 'project',
      worktreeId: 'worktree',
      chatId: 'chat',
      sessionKey: 'project/worktree/chat',
      initialThreadId: threadId,
      onEvent: jest.fn(),
      getWindow: (): null => null,
    });
    const { turnPromise, threadRequest } = await startTurnUntilThreadRequest(
      client,
      proc,
    );
    expect(threadRequest.method).toBe('thread/resume');
    const sent: Array<Record<string, unknown>> = [];

    emitServerMessage(proc, {
      id: threadRequest.id,
      error: {
        code: -32600,
        message: `thread ${threadId} is closing; retry thread/resume after the thread is closed`,
      },
    });
    await flush();
    emitServerMessage(proc, {
      method: 'thread/closed',
      params: { threadId },
    });
    const retriedResume = await waitForClientRequestRecording(
      proc,
      'thread/resume',
      sent,
    );
    emitServerMessage(proc, {
      id: retriedResume.id,
      result: makeThreadResult(threadId),
    });
    const turnStart = await waitForClientRequestRecording(
      proc,
      'turn/start',
      sent,
    );
    emitServerMessage(proc, {
      id: turnStart.id,
      result: {
        turn: { id: 'turn-1', items: [], status: 'inProgress', error: null },
      },
    });
    await flush();
    emitServerMessage(proc, {
      method: 'turn/completed',
      params: {
        threadId,
        turn: { id: 'turn-1', items: [], status: 'completed', error: null },
      },
    });

    await expect(turnPromise).resolves.toMatchObject({ status: 'completed' });
    // The closing rejection must never reach the "rebuild from history"
    // fallback, which would fork the conversation onto a new thread.
    expect(sent.map((message) => message.method)).not.toContain('thread/start');
    expect(
      sent.filter((message) => message.method === 'turn/start'),
    ).toHaveLength(1);
    client.dispose();
  });

  it('surfaces a persistent closing rejection without rebuilding the thread', async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate'] });
    try {
      const threadId = '019f8b17-16cf-7671-9f73-4cfe05d355c9';
      const closingMessage = `thread ${threadId} is closing; retry thread/resume after the thread is closed`;
      const client = new CodexAppServerClient({
        cwd: '/tmp/repo',
        projectId: 'project',
        worktreeId: 'worktree',
        chatId: 'chat',
        sessionKey: 'project/worktree/chat',
        initialThreadId: threadId,
        onEvent: jest.fn(),
        getWindow: (): null => null,
      });
      const { turnPromise, threadRequest } = await startTurnUntilThreadRequest(
        client,
        proc,
      );
      const failure = expect(turnPromise).rejects.toThrow(closingMessage);
      const sent: Array<Record<string, unknown>> = [];
      let pendingResume: Record<string, unknown> | undefined = threadRequest;
      for (let step = 0; step < 40; step += 1) {
        if (pendingResume) {
          emitServerMessage(proc, {
            id: pendingResume.id,
            error: { code: -32600, message: closingMessage },
          });
          pendingResume = undefined;
        }
        await flush();
        await jest.advanceTimersByTimeAsync(4_000);
        await flush();
        const messages = collectClientMessages(proc);
        sent.push(...messages);
        pendingResume = messages.find(
          (message) => message.method === 'thread/resume',
        );
      }

      await failure;
      expect(
        sent.filter((message) => message.method === 'thread/resume').length,
      ).toBeGreaterThan(0);
      expect(sent.map((message) => message.method)).not.toContain(
        'thread/start',
      );
      expect(sent.map((message) => message.method)).not.toContain('turn/start');
      client.dispose();
    } finally {
      jest.useRealTimers();
    }
  });

  it.each([
    ['thread/resume', '019f8b17-16cf-7671-9f73-4cfe05d355c9'],
    ['thread/start', undefined],
  ])(
    'recycles an idle worker and retries once after a %s timeout',
    async (method, initialThreadId) => {
      jest.useFakeTimers({ doNotFake: ['setImmediate'] });
      try {
        const firstProc = new MockChildProcess();
        const secondProc = new MockChildProcess();
        spawnMock
          .mockReset()
          .mockReturnValueOnce(firstProc)
          .mockReturnValueOnce(secondProc);
        const client = new CodexAppServerClient({
          cwd: '/tmp/repo',
          projectId: 'project',
          worktreeId: 'worktree',
          chatId: 'chat',
          sessionKey: 'project/worktree/chat',
          ...(initialThreadId ? { initialThreadId } : {}),
          onEvent: jest.fn(),
          getWindow: (): null => null,
        });
        const { turnPromise, threadRequest } =
          await startTurnUntilThreadRequest(client, firstProc);
        expect(threadRequest.method).toBe(method);

        await jest.advanceTimersByTimeAsync(2 * 60_000);
        await flush();

        expect(firstProc.kill).toHaveBeenCalledWith('SIGTERM');
        const initialize = await waitForClientRequest(secondProc, 'initialize');
        emitServerMessage(secondProc, {
          id: initialize.id,
          result: { userAgent: 'ua', codexHome: '/tmp/.codex' },
        });
        const sent: Array<Record<string, unknown>> = [];
        const retried = await waitForClientRequestRecording(
          secondProc,
          method,
          sent,
        );
        const threadId = initialThreadId ?? 'thread-1';
        emitServerMessage(secondProc, {
          id: retried.id,
          result: makeThreadResult(threadId),
        });
        const turnStart = await waitForClientRequestRecording(
          secondProc,
          'turn/start',
          sent,
        );
        emitServerMessage(secondProc, {
          id: turnStart.id,
          result: {
            turn: {
              id: 'turn-1',
              items: [],
              status: 'inProgress',
              error: null,
            },
          },
        });
        await flush();
        emitServerMessage(secondProc, {
          method: 'turn/completed',
          params: {
            threadId,
            turn: { id: 'turn-1', items: [], status: 'completed', error: null },
          },
        });

        await expect(turnPromise).resolves.toMatchObject({
          status: 'completed',
        });
        expect(
          sent.filter((message) => message.method === 'turn/start'),
        ).toHaveLength(1);
        client.dispose();
      } finally {
        jest.useRealTimers();
      }
    },
  );

  it('surfaces a second thread/resume timeout instead of recycling again', async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate'] });
    try {
      const firstProc = new MockChildProcess();
      const secondProc = new MockChildProcess();
      spawnMock
        .mockReset()
        .mockReturnValueOnce(firstProc)
        .mockReturnValueOnce(secondProc);
      const client = new CodexAppServerClient({
        cwd: '/tmp/repo',
        projectId: 'project',
        worktreeId: 'worktree',
        chatId: 'chat',
        sessionKey: 'project/worktree/chat',
        initialThreadId: '019f8b17-16cf-7671-9f73-4cfe05d355c9',
        onEvent: jest.fn(),
        getWindow: (): null => null,
      });
      const { turnPromise } = await startTurnUntilThreadRequest(
        client,
        firstProc,
      );
      const failure = expect(turnPromise).rejects.toThrow(
        'Codex app-server did not respond to thread/resume within 120s',
      );

      await jest.advanceTimersByTimeAsync(2 * 60_000);
      await flush();
      const initialize = await waitForClientRequest(secondProc, 'initialize');
      emitServerMessage(secondProc, {
        id: initialize.id,
        result: { userAgent: 'ua', codexHome: '/tmp/.codex' },
      });
      await waitForClientRequest(secondProc, 'thread/resume');
      await jest.advanceTimersByTimeAsync(2 * 60_000);
      await flush();

      await failure;
      expect(spawnMock).toHaveBeenCalledTimes(2);
      expect(secondProc.kill).not.toHaveBeenCalled();
      client.dispose();
    } finally {
      jest.useRealTimers();
    }
  });

  it('does not recycle the worker after a thread/resume timeout while another chat is running', async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate'] });
    try {
      const busy = createClient();
      const { turnPromise: busyTurn } = await startActiveTurn(busy, proc);
      collectClientMessages(proc);
      const client = new CodexAppServerClient({
        cwd: '/tmp/repo',
        projectId: 'project',
        worktreeId: 'worktree',
        chatId: 'slow',
        sessionKey: 'project/worktree/slow',
        initialThreadId: '019f8b17-16cf-7671-9f73-4cfe05d355c9',
        onEvent: jest.fn(),
        getWindow: (): null => null,
      });
      const turnPromise = client.startTurn({
        text: 'Run',
        cwd: '/tmp/repo',
        model: 'gpt-6-sol',
        thinkingLevel: 'high',
        planMode: false,
      });
      const failure = expect(turnPromise).rejects.toThrow(
        'Codex app-server did not respond to thread/resume within 120s',
      );
      await waitForClientRequest(proc, 'thread/resume');

      await jest.advanceTimersByTimeAsync(2 * 60_000);
      await flush();

      await failure;
      expect(proc.kill).not.toHaveBeenCalled();
      completeRootTurn(proc);
      await expect(busyTurn).resolves.toMatchObject({ status: 'completed' });
      client.dispose();
      busy.dispose();
    } finally {
      jest.useRealTimers();
    }
  });

  describe('a thread another spawn profile released', () => {
    const handoffThreadId = '019f8b17-16cf-7671-9f73-4cfe05d355c9';
    let attachSpy: jest.SpyInstance | undefined;

    function markReleasedByAnotherProfile(released: boolean): void {
      const service = getCodexRuntimeService();
      const attach = service.attachInteractiveClient.bind(service);
      attachSpy = jest
        .spyOn(service, 'attachInteractiveClient')
        .mockImplementation((request) => ({
          ...attach(request),
          requiresThreadMaterialization: (): boolean => released,
        }));
    }

    function createHandoffClient(): CodexAppServerClient {
      return new CodexAppServerClient({
        cwd: '/tmp/repo',
        projectId: 'project',
        worktreeId: 'worktree',
        chatId: 'chat',
        sessionKey: 'project/worktree/chat',
        initialThreadId: handoffThreadId,
        onEvent: jest.fn(),
        getWindow: (): null => null,
        fallbackSeedItems: [
          {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'prior context' }],
          },
        ],
      });
    }

    async function completeTurn(
      sent: Array<Record<string, unknown>>,
      threadId: string,
    ): Promise<void> {
      const turnStart = await waitForClientRequestRecording(
        proc,
        'turn/start',
        sent,
      );
      expect(getRequestParams(turnStart).threadId).toBe(threadId);
      emitServerMessage(proc, {
        id: turnStart.id,
        result: {
          turn: { id: 'turn-1', items: [], status: 'inProgress', error: null },
        },
      });
      await flush();
      emitServerMessage(proc, {
        method: 'turn/completed',
        params: {
          threadId,
          turn: { id: 'turn-1', items: [], status: 'completed', error: null },
        },
      });
    }

    afterEach(() => {
      attachSpy?.mockRestore();
      attachSpy = undefined;
    });

    it('resumes the same thread instead of rebuilding it', async () => {
      markReleasedByAnotherProfile(true);
      const client = createHandoffClient();
      const { turnPromise, threadRequest } = await startTurnUntilThreadRequest(
        client,
        proc,
      );
      const sent: Array<Record<string, unknown>> = [threadRequest];

      expect(threadRequest.method).toBe('thread/resume');
      emitServerMessage(proc, {
        id: threadRequest.id,
        result: makeThreadResult(handoffThreadId),
      });
      await completeTurn(sent, handoffThreadId);

      await expect(turnPromise).resolves.toMatchObject({
        status: 'completed',
      });
      expect(sent.map((message) => message.method)).not.toContain(
        'thread/start',
      );
      client.dispose();
    });

    it('rebuilds from history when the old worker still holds the writer', async () => {
      markReleasedByAnotherProfile(true);
      const client = createHandoffClient();
      const { turnPromise, threadRequest } = await startTurnUntilThreadRequest(
        client,
        proc,
      );
      const sent: Array<Record<string, unknown>> = [];

      emitServerMessage(proc, {
        id: threadRequest.id,
        error: {
          code: -32600,
          message: `thread ${handoffThreadId} already has an active writer`,
        },
      });
      const start = await waitForClientRequestRecording(
        proc,
        'thread/start',
        sent,
      );
      emitServerMessage(proc, {
        id: start.id,
        result: makeThreadResult('thread-rebuilt'),
      });
      const inject = await waitForClientRequestRecording(
        proc,
        'thread/inject_items',
        sent,
      );
      expect(JSON.stringify(getRequestParams(inject).items)).toContain(
        'prior context',
      );
      emitServerMessage(proc, { id: inject.id, result: {} });
      await completeTurn(sent, 'thread-rebuilt');

      await expect(turnPromise).resolves.toMatchObject({
        status: 'completed',
      });
      expect(
        sent.filter((message) => message.method === 'turn/start'),
      ).toHaveLength(1);
      client.dispose();
    });

    it('surfaces a writer conflict with no evidence of a local handoff', async () => {
      markReleasedByAnotherProfile(false);
      const client = createHandoffClient();
      const { turnPromise, threadRequest } = await startTurnUntilThreadRequest(
        client,
        proc,
      );
      const failure = expect(turnPromise).rejects.toThrow(
        'already has an active writer',
      );

      emitServerMessage(proc, {
        id: threadRequest.id,
        error: {
          code: -32600,
          message: `thread ${handoffThreadId} already has an active writer`,
        },
      });

      await failure;
      expect(
        collectClientMessages(proc).map((message) => message.method),
      ).not.toContain('thread/start');
      client.dispose();
    });
  });

  it('starts the replacement thread without injection when trimming empties the history', async () => {
    // Self-heal retry on a thread whose entire usable history is the failed
    // turn's own input: sanitization drops the foreign reasoning and the
    // trailing-input trim removes the rest. There is nothing left to inject,
    // but the live turn still carries the prompt, so this must start a clean
    // thread instead of hard-failing the user's turn with an internal
    // "no persisted history was found" error the retry latch cannot recover
    // from.
    const codexHome = await writeRolloutCodexHome('thread-existing', [
      {
        type: 'reasoning',
        id: 'rs_foreign_1',
        summary: [],
        encrypted_content: 'gAAAAAB-foreign-blob',
      },
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'Continue' }],
      },
    ]);
    const capabilityStore = createCapabilityStoreMock({
      readLease: jest.fn().mockResolvedValue(null),
    });
    const client = new CodexAppServerClient({
      cwd: '/tmp/repo',
      projectId: 'project',
      worktreeId: 'worktree',
      chatId: 'chat',
      sessionKey: 'project/worktree/chat',
      initialThreadId: 'thread-existing',
      onEvent: jest.fn(),
      getWindow: (): null => null,
      capabilityStore,
      capabilitySnapshotId: 'snapshot-current',
      reasoningRouteFamily: 'native',
      forceMaterializeOnResume: true,
      fallbackSeedItems: [],
    });

    const turnPromise = client.startTurn({
      text: 'Continue',
      cwd: '/tmp/repo',
      model: 'gpt-5.6-sol',
      thinkingLevel: 'high',
      planMode: false,
    });
    const initializeRequest = await waitForClientRequest(proc, 'initialize');
    emitServerMessage(proc, {
      id: initializeRequest.id,
      result: { userAgent: 'ua', codexHome },
    });
    const startRequest = await waitForClientRequest(proc, 'thread/start');
    emitServerMessage(proc, {
      id: startRequest.id,
      result: makeThreadResult('thread-materialized'),
    });
    await waitForClientRequest(proc, 'turn/start');
    expect(
      collectClientMessages(proc).some(
        (message) => message.method === 'thread/inject_items',
      ),
    ).toBe(false);
    client.dispose();
    await expect(turnPromise).rejects.toThrow('session_destroyed');
  });

  it('keeps a duplicate trailing message when the seed came from the renderer fallback', async () => {
    // No rollout exists for this thread, so reconstruction falls back to the
    // persisted renderer transcript — which `loadPersistedCodexFallbackSeedItems`
    // already built with `excludeMessageId`, so the pending turn's input is not
    // in it. The trailing item is therefore a genuine EARLIER message, and a
    // user who sent `Continue` twice in a row (the usage-limit resume prompt
    // does exactly that) would silently lose one of them to the rollout-only
    // de-duplication trim.
    const earlierContinue = {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: 'Continue' }],
    };
    const capabilityStore = createCapabilityStoreMock({
      readLease: jest.fn().mockResolvedValue(null),
    });
    const client = new CodexAppServerClient({
      cwd: '/tmp/repo',
      projectId: 'project',
      worktreeId: 'worktree',
      chatId: 'chat',
      sessionKey: 'project/worktree/chat',
      initialThreadId: 'thread-existing',
      onEvent: jest.fn(),
      getWindow: (): null => null,
      capabilityStore,
      capabilitySnapshotId: 'snapshot-current',
      reasoningRouteFamily: 'native',
      forceMaterializeOnResume: true,
      fallbackSeedItems: [
        {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'prior reply' }],
        },
        earlierContinue,
      ],
    });

    const turnPromise = client.startTurn({
      text: 'Continue',
      cwd: '/tmp/repo',
      model: 'gpt-5.6-sol',
      thinkingLevel: 'high',
      planMode: false,
    });
    const initializeRequest = await waitForClientRequest(proc, 'initialize');
    emitServerMessage(proc, {
      id: initializeRequest.id,
      result: { userAgent: 'ua', codexHome: '/tmp/.codex-missing-rollout' },
    });
    const startRequest = await waitForClientRequest(proc, 'thread/start');
    emitServerMessage(proc, {
      id: startRequest.id,
      result: makeThreadResult('thread-materialized'),
    });
    const injectRequest = await waitForClientRequest(
      proc,
      'thread/inject_items',
    );
    const injectedItems = getRequestParams(injectRequest).items;
    emitServerMessage(proc, { id: injectRequest.id, result: {} });
    await flush();
    client.dispose();
    await expect(turnPromise).rejects.toThrow('session_destroyed');
    expect(injectedItems).toEqual([
      {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'prior reply' }],
      },
      earlierContinue,
    ]);
  });

  it('starts the replacement thread when the whole history was provider-private reasoning', async () => {
    // "Nothing was ever loaded" is measured before sanitization. A history
    // whose entire surviving content is reasoning the target route cannot
    // decode sanitizes to empty, but history genuinely existed — throwing the
    // internal "no persisted history was found" there hard-fails the user's
    // turn on the one path whose retry latch is already spent.
    const capabilityStore = createCapabilityStoreMock({
      readLease: jest.fn().mockResolvedValue(null),
    });
    const client = new CodexAppServerClient({
      cwd: '/tmp/repo',
      projectId: 'project',
      worktreeId: 'worktree',
      chatId: 'chat',
      sessionKey: 'project/worktree/chat',
      initialThreadId: 'thread-existing',
      onEvent: jest.fn(),
      getWindow: (): null => null,
      capabilityStore,
      capabilitySnapshotId: 'snapshot-current',
      reasoningRouteFamily: 'native',
      forceMaterializeOnResume: true,
      fallbackSeedItems: [
        {
          type: 'reasoning',
          id: 'rs_foreign_only',
          summary: [],
          content: [],
          encrypted_content: null,
          internal_chat_message_metadata_passthrough: { turn_id: 'turn-1' },
        },
      ],
    });

    const turnPromise = client.startTurn({
      text: 'Continue',
      cwd: '/tmp/repo',
      model: 'gpt-5.6-sol',
      thinkingLevel: 'high',
      planMode: false,
    });
    const initializeRequest = await waitForClientRequest(proc, 'initialize');
    emitServerMessage(proc, {
      id: initializeRequest.id,
      result: { userAgent: 'ua', codexHome: '/tmp/.codex' },
    });
    const startRequest = await waitForClientRequest(proc, 'thread/start');
    emitServerMessage(proc, {
      id: startRequest.id,
      result: makeThreadResult('thread-materialized'),
    });
    await waitForClientRequest(proc, 'turn/start');
    expect(
      collectClientMessages(proc).some(
        (message) => message.method === 'thread/inject_items',
      ),
    ).toBe(false);
    client.dispose();
    await expect(turnPromise).rejects.toThrow('session_destroyed');
  });

  it('keeps the force-materialize latch when the rebuilt thread is discarded', async () => {
    // The rebuild succeeded, but the turn was cancelled before `this.threadId`
    // was committed, so the next `ensureThread` falls back to the original
    // poisoned `initialThreadId` — whose lease family still matches the
    // session's, making `capabilityChanged` false. Consuming the latch above
    // the cancellation checks therefore left that thread with no self-heal at
    // all; it must survive a rebuild whose result was thrown away.
    const capabilityStore = createCapabilityStoreMock({
      readLease: jest.fn().mockResolvedValue({
        version: 1,
        threadId: 'thread-existing',
        snapshotId: 'snapshot-current',
        rootContentIds: [],
        kind: 'persisted-chat',
        reasoningRouteFamily: 'native',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }),
    });
    const client = new CodexAppServerClient({
      cwd: '/tmp/repo',
      projectId: 'project',
      worktreeId: 'worktree',
      chatId: 'chat',
      sessionKey: 'project/worktree/chat',
      initialThreadId: 'thread-existing',
      onEvent: jest.fn(),
      getWindow: (): null => null,
      capabilityStore,
      // Snapshot and family both match the lease, so ONLY the latch can make
      // this resume rebuild. That is what makes the second attempt meaningful.
      capabilitySnapshotId: 'snapshot-current',
      reasoningRouteFamily: 'native',
      forceMaterializeOnResume: true,
      fallbackSeedItems: [
        {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'prior reply' }],
        },
      ],
    });

    const firstTurn = client.startTurn({
      text: 'Continue',
      cwd: '/tmp/repo',
      model: 'gpt-5.6-sol',
      thinkingLevel: 'high',
      planMode: false,
    });
    const initializeRequest = await waitForClientRequest(proc, 'initialize');
    emitServerMessage(proc, {
      id: initializeRequest.id,
      result: { userAgent: 'ua', codexHome: '/tmp/.codex' },
    });
    const firstStart = await waitForClientRequest(proc, 'thread/start');
    emitServerMessage(proc, {
      id: firstStart.id,
      result: makeThreadResult('thread-rebuilt-discarded'),
    });
    const injectRequest = await waitForClientRequest(
      proc,
      'thread/inject_items',
    );
    // Cancel while the rebuild's injection is still in flight: the rebuild
    // completes, then `assertTurnStartNotCancelled` discards its result.
    client.cancelPendingTurnStart(new Error('turn_start_cancelled'));
    emitServerMessage(proc, { id: injectRequest.id, result: {} });
    await expect(firstTurn).rejects.toThrow('turn_start_cancelled');

    const secondTurn = client.startTurn({
      text: 'Continue',
      cwd: '/tmp/repo',
      model: 'gpt-5.6-sol',
      thinkingLevel: 'high',
      planMode: false,
    });
    const observed: Array<Record<string, unknown>> = [];
    const secondStart = await waitForClientRequestRecording(
      proc,
      'thread/start',
      observed,
    );
    expect(observed.map((message) => message.method)).not.toContain(
      'thread/resume',
    );
    emitServerMessage(proc, {
      id: secondStart.id,
      result: makeThreadResult('thread-rebuilt-committed'),
    });
    const secondInject = await waitForClientRequest(
      proc,
      'thread/inject_items',
    );
    emitServerMessage(proc, { id: secondInject.id, result: {} });
    await waitForClientRequest(proc, 'turn/start');
    client.dispose();
    await expect(secondTurn).rejects.toThrow('session_destroyed');
  });

  it('commits a rebuilt thread and starts the turn even when its MCP fails', async () => {
    const capabilityStore = createCapabilityStoreMock({
      readLease: jest.fn().mockResolvedValue({
        version: 1,
        threadId: 'thread-existing',
        snapshotId: 'snapshot-current',
        rootContentIds: [],
        kind: 'persisted-chat',
        reasoningRouteFamily: 'native',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }),
    });
    const client = new CodexAppServerClient({
      cwd: '/tmp/repo',
      projectId: 'project',
      worktreeId: 'worktree',
      chatId: 'chat',
      sessionKey: 'project/worktree/chat',
      initialThreadId: 'thread-existing',
      onEvent: jest.fn(),
      getWindow: (): null => null,
      capabilityStore,
      // Snapshot and family both match the lease, so ONLY the latch can make
      // this resume rebuild.
      capabilitySnapshotId: 'snapshot-current',
      reasoningRouteFamily: 'native',
      forceMaterializeOnResume: true,
      mcpServersConfig: {
        linear: { url: 'http://127.0.0.1:37646/mcp/linear' },
      },
      fallbackSeedItems: [
        {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'prior reply' }],
        },
      ],
    });

    const firstTurn = client.startTurn({
      text: 'Continue',
      cwd: '/tmp/repo',
      model: 'gpt-5.6-sol',
      thinkingLevel: 'high',
      planMode: false,
    });
    void firstTurn.catch(() => {});
    const initializeRequest = await waitForClientRequest(proc, 'initialize');
    emitServerMessage(proc, {
      id: initializeRequest.id,
      result: { userAgent: 'ua', codexHome: '/tmp/.codex' },
    });
    const firstStart = await waitForClientRequest(proc, 'thread/start');
    emitServerMessage(proc, {
      id: firstStart.id,
      result: makeThreadResult('thread-rebuilt-uncommitted'),
    });
    const injectRequest = await waitForClientRequest(
      proc,
      'thread/inject_items',
    );
    emitServerMessage(proc, { id: injectRequest.id, result: {} });
    await flush();
    emitServerMessage(proc, {
      method: 'mcpServer/startupStatus/updated',
      params: {
        threadId: 'thread-rebuilt-uncommitted',
        name: 'linear',
        status: 'failed',
        error: 'linear exited during startup',
        failureReason: null,
      },
    });
    const turnStart = await waitForClientRequestUnderLoad(proc, 'turn/start');
    expect(getRequestParams(turnStart).threadId).toBe(
      'thread-rebuilt-uncommitted',
    );
    emitServerMessage(proc, {
      id: turnStart.id,
      result: {
        turn: { id: 'turn-1', items: [], status: 'inProgress', error: null },
      },
    });
    emitServerMessage(proc, {
      method: 'turn/completed',
      params: {
        threadId: 'thread-rebuilt-uncommitted',
        turn: { id: 'turn-1', items: [], status: 'completed', error: null },
      },
    });
    await expect(firstTurn).resolves.toMatchObject({ status: 'completed' });
    expect(client.getThreadId()).toBe('thread-rebuilt-uncommitted');
    client.dispose();
  });

  it('fails a reconstruction that never loaded any history', async () => {
    // The genuine error case is preserved: nothing was persisted at all, so
    // there is no conversation to carry forward and silently starting an empty
    // thread would hide the loss.
    const capabilityStore = createCapabilityStoreMock({
      readLease: jest.fn().mockResolvedValue(null),
    });
    const client = new CodexAppServerClient({
      cwd: '/tmp/repo',
      projectId: 'project',
      worktreeId: 'worktree',
      chatId: 'chat',
      sessionKey: 'project/worktree/chat',
      initialThreadId: 'thread-existing',
      onEvent: jest.fn(),
      getWindow: (): null => null,
      capabilityStore,
      capabilitySnapshotId: 'snapshot-current',
      reasoningRouteFamily: 'native',
      forceMaterializeOnResume: true,
      fallbackSeedItems: [],
    });

    const turnPromise = client.startTurn({
      text: 'Continue',
      cwd: '/tmp/repo',
      model: 'gpt-5.6-sol',
      thinkingLevel: 'high',
      planMode: false,
    });
    const initializeRequest = await waitForClientRequest(proc, 'initialize');
    emitServerMessage(proc, {
      id: initializeRequest.id,
      result: { userAgent: 'ua', codexHome: '/tmp/.codex' },
    });
    await expect(turnPromise).rejects.toThrow('no persisted history was found');
    expect(
      collectClientMessages(proc).some(
        (message) => message.method === 'thread/start',
      ),
    ).toBe(false);
    client.dispose();
  });

  it('resumes and backfills a legacy lease when the reasoning family is unchanged', async () => {
    const writeLeaseMock = jest.fn().mockResolvedValue(undefined);
    const legacyLease = {
      version: 1 as const,
      threadId: 'thread-existing',
      snapshotId: 'snapshot-current',
      rootContentIds: [],
      kind: 'persisted-chat' as const,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const capabilityStore = createCapabilityStoreMock({
      readLease: jest.fn().mockResolvedValue(legacyLease),
      writeLease: writeLeaseMock,
    });
    const client = new CodexAppServerClient({
      cwd: '/tmp/repo',
      projectId: 'project',
      worktreeId: 'worktree',
      chatId: 'chat',
      sessionKey: 'project/worktree/chat',
      initialThreadId: 'thread-existing',
      onEvent: jest.fn(),
      getWindow: (): null => null,
      capabilityStore,
      capabilitySnapshotId: 'snapshot-current',
      reasoningRouteFamily: 'native',
    });

    const { turnPromise, threadRequest } = await startTurnUntilThreadRequest(
      client,
      proc,
    );
    expect(threadRequest).toMatchObject({
      method: 'thread/resume',
      params: { threadId: 'thread-existing' },
    });
    emitServerMessage(proc, {
      id: threadRequest.id,
      result: makeThreadResult('thread-existing'),
    });
    await flush();
    // Staged, not written: resume alone does not verify provenance.
    expect(writeLeaseMock).not.toHaveBeenCalled();
    emitServerMessage(proc, {
      id: 3,
      result: {
        turn: { id: 'turn-1', items: [], status: 'inProgress', error: null },
      },
    });
    await flush();
    emitServerMessage(proc, {
      method: 'turn/completed',
      params: {
        threadId: 'thread-existing',
        turn: { id: 'turn-1', items: [], status: 'completed', error: null },
      },
    });
    await expect(turnPromise).resolves.toMatchObject({ status: 'completed' });
    expect(writeLeaseMock).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: legacyLease.threadId,
        snapshotId: legacyLease.snapshotId,
        rootContentIds: legacyLease.rootContentIds,
        kind: legacyLease.kind,
        reasoningRouteFamily: 'native',
      }),
    );
    client.dispose();
  });

  it('resumes when the recorded reasoning route family is unchanged', async () => {
    const writeLeaseMock = jest.fn().mockResolvedValue(undefined);
    const capabilityStore = createCapabilityStoreMock({
      readLease: jest.fn().mockResolvedValue({
        version: 1,
        threadId: 'thread-existing',
        snapshotId: 'snapshot-current',
        rootContentIds: [],
        kind: 'persisted-chat',
        reasoningRouteFamily: 'gateway:deepseek',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }),
      writeLease: writeLeaseMock,
    });
    const client = new CodexAppServerClient({
      cwd: '/tmp/repo',
      projectId: 'project',
      worktreeId: 'worktree',
      chatId: 'chat',
      sessionKey: 'project/worktree/chat',
      initialThreadId: 'thread-existing',
      onEvent: jest.fn(),
      getWindow: (): null => null,
      capabilityStore,
      capabilitySnapshotId: 'snapshot-current',
      reasoningRouteFamily: 'gateway:deepseek',
    });

    const { turnPromise, threadRequest } = await startTurnUntilThreadRequest(
      client,
      proc,
    );
    expect(threadRequest).toMatchObject({
      method: 'thread/resume',
      params: { threadId: 'thread-existing' },
    });
    expect(writeLeaseMock).not.toHaveBeenCalled();
    client.dispose();
    await expect(turnPromise).rejects.toThrow('session_destroyed');
  });

  it('injects a retained import seed before the first turn of a new thread', async () => {
    const client = new CodexAppServerClient({
      cwd: '/tmp/repo',
      projectId: 'project',
      worktreeId: 'worktree',
      chatId: 'chat',
      sessionKey: 'project/worktree/chat',
      onEvent: jest.fn(),
      getWindow: (): null => null,
      seedNewThreadFromFallback: true,
      fallbackSeedItemsLoader: jest.fn().mockResolvedValue([
        {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'imported context' }],
        },
      ]),
    });

    const turnPromise = client.startTurn({
      text: 'Continue',
      cwd: '/tmp/repo',
      model: 'gpt-6-sol',
      thinkingLevel: 'high',
      planMode: false,
    });
    const initializeRequest = await waitForClientRequest(proc, 'initialize');
    emitServerMessage(proc, {
      id: initializeRequest.id,
      result: { userAgent: 'ua', codexHome: '/tmp/.codex' },
    });
    const startRequest = await waitForClientRequest(proc, 'thread/start');
    emitServerMessage(proc, {
      id: startRequest.id,
      result: makeThreadResult('thread-imported'),
    });
    const injectRequest = await waitForClientRequest(
      proc,
      'thread/inject_items',
    );
    expect(getRequestParams(injectRequest)).toEqual({
      threadId: 'thread-imported',
      items: [
        {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'imported context' }],
        },
      ],
    });
    expect(
      collectClientMessages(proc).some(
        (message) => message.method === 'turn/start',
      ),
    ).toBe(false);
    emitServerMessage(proc, { id: injectRequest.id, result: {} });
    await flush();
    expect(
      collectClientMessages(proc).some(
        (message) => message.method === 'turn/start',
      ),
    ).toBe(true);
    client.dispose();
    await expect(turnPromise).rejects.toThrow('session_destroyed');
  });

  it('sanitizes a retained import seed of unknown provenance before injecting', async () => {
    const message = {
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: 'imported context' }],
    };
    const client = new CodexAppServerClient({
      cwd: '/tmp/repo',
      projectId: 'project',
      worktreeId: 'worktree',
      chatId: 'chat',
      sessionKey: 'project/worktree/chat',
      onEvent: jest.fn(),
      getWindow: (): null => null,
      seedNewThreadFromFallback: true,
      reasoningRouteFamily: 'native',
      // A reconstruction seed built from an imported Codex/Ollama rollout.
      // It carries no source-route provenance, so its reasoning may belong to
      // a different provider family.
      fallbackSeedItemsLoader: jest.fn().mockResolvedValue([
        {
          type: 'reasoning',
          id: 'rs_imported_1',
          summary: [],
          encrypted_content: 'gAAAAAB-foreign-blob',
        },
        message,
      ]),
    });

    const turnPromise = client.startTurn({
      text: 'Continue',
      cwd: '/tmp/repo',
      model: 'gpt-6-sol',
      thinkingLevel: 'high',
      planMode: false,
    });
    const initializeRequest = await waitForClientRequest(proc, 'initialize');
    emitServerMessage(proc, {
      id: initializeRequest.id,
      result: { userAgent: 'ua', codexHome: '/tmp/.codex' },
    });
    const startRequest = await waitForClientRequest(proc, 'thread/start');
    emitServerMessage(proc, {
      id: startRequest.id,
      result: makeThreadResult('thread-imported'),
    });
    const injectRequest = await waitForClientRequest(
      proc,
      'thread/inject_items',
    );
    const injectedParams = getRequestParams(injectRequest);
    // Unblock the client before asserting so a mismatch fails the expectation
    // cleanly instead of stranding the pending request and tearing down the
    // connection with an unhandled rejection.
    emitServerMessage(proc, { id: injectRequest.id, result: {} });
    await flush();
    client.dispose();
    await expect(turnPromise).rejects.toThrow('session_destroyed');
    // The foreign reasoning must not reach the new provider on the first turn.
    expect(injectedParams).toEqual({
      threadId: 'thread-imported',
      items: [message],
    });
  });

  it('records a lease after one successful legacy canonical resume', async () => {
    const writeLeaseMock = jest.fn().mockResolvedValue(undefined);
    const capabilityStore = createCapabilityStoreMock({
      readLease: jest.fn().mockResolvedValue(null),
      writeLease: writeLeaseMock,
    });
    const client = new CodexAppServerClient({
      cwd: '/tmp/repo',
      projectId: 'project',
      worktreeId: 'worktree',
      chatId: 'chat',
      sessionKey: 'project/worktree/chat',
      initialThreadId: 'thread-existing',
      onEvent: jest.fn(),
      getWindow: (): null => null,
      capabilityStore,
      capabilitySnapshotId: 'snapshot-current',
    });

    const { turnPromise, threadRequest } = await startTurnUntilThreadRequest(
      client,
      proc,
    );
    expect(threadRequest).toMatchObject({
      method: 'thread/resume',
      params: { threadId: 'thread-existing' },
    });
    emitServerMessage(proc, {
      id: 2,
      result: makeThreadResult('thread-existing'),
    });
    await flush();
    // A successful resume alone must NOT record provenance: the upstream
    // provider only rejects foreign reasoning once a turn replays it, so
    // stamping here would assert a family we have not verified.
    expect(writeLeaseMock).not.toHaveBeenCalled();
    emitServerMessage(proc, {
      id: 3,
      result: {
        turn: { id: 'turn-1', items: [], status: 'inProgress', error: null },
      },
    });
    await flush();
    expect(writeLeaseMock).not.toHaveBeenCalled();
    emitServerMessage(proc, {
      method: 'turn/completed',
      params: {
        threadId: 'thread-existing',
        turn: { id: 'turn-1', items: [], status: 'completed', error: null },
      },
    });
    await expect(turnPromise).resolves.toMatchObject({ status: 'completed' });
    // The turn replayed the resumed history without rejection, so the
    // route-family backfill is now verified and gets persisted.
    expect(writeLeaseMock).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: 'thread-existing',
        snapshotId: 'snapshot-current',
        rootContentIds: [],
        kind: 'persisted-chat',
      }),
    );
    client.dispose();
  });

  it('disables ambient Codex MCP servers the chat did not select', async () => {
    proc.ambientMcpServers = {
      telegram: { command: 'npx', args: ['telegram-mcp'] },
      linear: { url: 'http://127.0.0.1:9/global-linear' },
    };
    const client = new CodexAppServerClient({
      cwd: '/tmp/repo',
      projectId: 'project',
      worktreeId: 'worktree',
      chatId: 'chat',
      sessionKey: 'project/worktree/chat',
      onEvent: jest.fn(),
      getWindow: (): null => null,
      mcpServersConfig: {
        linear: { url: 'http://127.0.0.1:37646/mcp/linear' },
      },
    });
    const turnPromise = client.startTurn({
      text: 'Run',
      cwd: '/tmp/repo',
      model: 'gpt-6-sol',
      thinkingLevel: 'high',
      planMode: false,
    });
    void turnPromise.catch(() => {});
    try {
      const initializeRequest = await waitForClientRequest(proc, 'initialize');
      emitServerMessage(proc, {
        id: initializeRequest.id,
        result: { userAgent: 'ua', codexHome: '/tmp/.codex' },
      });
      const start = await waitForClientRequest(proc, 'thread/start');
      expect(proc.configReads.map((read) => read.params)).toEqual([
        { cwd: '/tmp/repo' },
      ]);
      const mcpServers = getRequestParams(start).config;
      expect(isRecord(mcpServers) ? mcpServers.mcp_servers : undefined).toEqual(
        {
          linear: {
            url: 'http://127.0.0.1:37646/mcp/linear',
            required: false,
          },
          telegram: { enabled: false },
        },
      );
    } finally {
      client.dispose();
    }
  });

  it('does not record route-family provenance when the resumed turn is interrupted', async () => {
    const writeLeaseMock = jest.fn().mockResolvedValue(undefined);
    const capabilityStore = createCapabilityStoreMock({
      readLease: jest.fn().mockResolvedValue(null),
      writeLease: writeLeaseMock,
    });
    const client = new CodexAppServerClient({
      cwd: '/tmp/repo',
      projectId: 'project',
      worktreeId: 'worktree',
      chatId: 'chat',
      sessionKey: 'project/worktree/chat',
      initialThreadId: 'thread-existing',
      onEvent: jest.fn(),
      getWindow: (): null => null,
      capabilityStore,
      capabilitySnapshotId: 'snapshot-current',
    });

    const { turnPromise } = await startTurnUntilThreadRequest(client, proc);
    emitServerMessage(proc, {
      id: 2,
      result: makeThreadResult('thread-existing'),
    });
    await flush();
    emitServerMessage(proc, {
      id: 3,
      result: {
        turn: { id: 'turn-1', items: [], status: 'inProgress', error: null },
      },
    });
    await flush();
    emitServerMessage(proc, {
      method: 'turn/completed',
      params: {
        threadId: 'thread-existing',
        turn: {
          id: 'turn-1',
          items: [],
          status: 'interrupted',
          error: null,
        },
      },
    });
    await expect(turnPromise).resolves.toMatchObject({
      status: 'interrupted',
    });
    // An interrupt can win before the upstream provider ever validated the
    // replayed reasoning, so it proves nothing about provenance. Only a
    // completed turn may certify the family.
    expect(writeLeaseMock).not.toHaveBeenCalled();
    client.dispose();
  });

  it('does not record route-family provenance when the resumed turn fails', async () => {
    const writeLeaseMock = jest.fn().mockResolvedValue(undefined);
    const capabilityStore = createCapabilityStoreMock({
      readLease: jest.fn().mockResolvedValue(null),
      writeLease: writeLeaseMock,
    });
    const client = new CodexAppServerClient({
      cwd: '/tmp/repo',
      projectId: 'project',
      worktreeId: 'worktree',
      chatId: 'chat',
      sessionKey: 'project/worktree/chat',
      initialThreadId: 'thread-existing',
      onEvent: jest.fn(),
      getWindow: (): null => null,
      capabilityStore,
      capabilitySnapshotId: 'snapshot-current',
    });

    const { turnPromise } = await startTurnUntilThreadRequest(client, proc);
    emitServerMessage(proc, {
      id: 2,
      result: makeThreadResult('thread-existing'),
    });
    await flush();
    emitServerMessage(proc, {
      id: 3,
      result: {
        turn: { id: 'turn-1', items: [], status: 'inProgress', error: null },
      },
    });
    await flush();
    emitServerMessage(proc, {
      method: 'turn/completed',
      params: {
        threadId: 'thread-existing',
        turn: {
          id: 'turn-1',
          items: [],
          status: 'failed',
          error: "Unknown parameter: 'input[0].encrypted_content'",
        },
      },
    });
    await expect(turnPromise).resolves.toMatchObject({ status: 'failed' });
    // The rejection is exactly the evidence that the persisted reasoning was
    // foreign, so the staged backfill must be discarded, leaving the lease
    // with unknown provenance so the next reconstruction sanitizes again.
    expect(writeLeaseMock).not.toHaveBeenCalled();
    client.dispose();
  });

  it('pins selected roots and promotes them to a persisted thread lease', async () => {
    const contentId = 'a'.repeat(64);
    const acquireOperationPinMock = jest
      .fn()
      .mockResolvedValue({ pinId: 'pin-1' });
    const promotePinToLeaseMock = jest.fn().mockResolvedValue(undefined);
    const capabilityStore = createCapabilityStoreMock({
      acquireOperationPin: acquireOperationPinMock,
      refreshOperationPin: jest.fn().mockResolvedValue(undefined),
      releaseOperationPin: jest.fn().mockResolvedValue(undefined),
      promotePinToLease: promotePinToLeaseMock,
      writeLease: jest.fn().mockResolvedValue(undefined),
    });
    const client = new CodexAppServerClient({
      cwd: '/tmp/repo',
      projectId: 'project',
      worktreeId: 'worktree',
      chatId: 'chat',
      sessionKey: 'project/worktree/chat',
      onEvent: jest.fn(),
      getWindow: (): null => null,
      capabilityStore,
      capabilitySnapshotId: 'snapshot-1',
      selectedCapabilityRoots: [
        {
          id: contentId,
          location: {
            type: 'environment',
            environmentId: 'local',
            path: `file:///tmp/${contentId}`,
          },
        },
      ],
    });

    const { turnPromise, threadRequest } = await startTurnUntilThreadRequest(
      client,
      proc,
    );
    expect(threadRequest).toMatchObject({
      method: 'thread/start',
      params: {
        selectedCapabilityRoots: [expect.objectContaining({ id: contentId })],
      },
    });
    expect(acquireOperationPinMock).toHaveBeenCalledWith([contentId]);

    emitServerMessage(proc, { id: 2, result: makeThreadResult('thread-1') });
    await flush();
    expect(promotePinToLeaseMock).toHaveBeenCalledWith(
      'pin-1',
      expect.objectContaining({
        threadId: 'thread-1',
        snapshotId: 'snapshot-1',
        rootContentIds: [contentId],
        kind: 'persisted-chat',
      }),
    );
    emitServerMessage(proc, {
      id: 3,
      result: {
        turn: { id: 'turn-1', items: [], status: 'inProgress', error: null },
      },
    });
    await flush();
    completeRootTurn(proc);
    await expect(turnPromise).resolves.toMatchObject({ status: 'completed' });
    client.dispose();
  });

  it('deletes a provisional thread when capability lease promotion fails', async () => {
    const unregisterThread = jest.spyOn(
      CodexAppServerConnection.prototype,
      'unregisterThread',
    );
    const contentId = 'b'.repeat(64);
    const releaseOperationPinMock = jest.fn().mockResolvedValue(undefined);
    const capabilityStore = createCapabilityStoreMock({
      acquireOperationPin: jest.fn().mockResolvedValue({ pinId: 'pin-2' }),
      refreshOperationPin: jest.fn().mockResolvedValue(undefined),
      releaseOperationPin: releaseOperationPinMock,
      promotePinToLease: jest
        .fn()
        .mockRejectedValue(new Error('lease write failed')),
      writeLease: jest.fn().mockResolvedValue(undefined),
    });
    const client = new CodexAppServerClient({
      cwd: '/tmp/repo',
      projectId: 'project',
      worktreeId: 'worktree',
      chatId: 'chat',
      sessionKey: 'project/worktree/chat',
      onEvent: jest.fn(),
      getWindow: (): null => null,
      capabilityStore,
      selectedCapabilityRoots: [
        {
          id: contentId,
          location: {
            type: 'environment',
            environmentId: 'local',
            path: `file:///tmp/${contentId}`,
          },
        },
      ],
    });

    const { turnPromise } = await startTurnUntilThreadRequest(client, proc);
    const turnRejection =
      expect(turnPromise).rejects.toThrow('lease write failed');
    emitServerMessage(proc, {
      id: 2,
      result: makeThreadResult('provisional-thread'),
    });
    await flush();
    const deleteRequest = collectClientMessages(proc).find(
      (message) => message.method === 'thread/delete',
    );
    expect(deleteRequest).toEqual(
      expect.objectContaining({
        method: 'thread/delete',
        params: { threadId: 'provisional-thread' },
      }),
    );
    emitServerMessage(proc, { id: deleteRequest?.id, result: {} });
    await flush();
    await turnRejection;
    expect(releaseOperationPinMock).toHaveBeenCalledWith('pin-2');
    expect(unregisterThread).toHaveBeenCalledWith(
      'provisional-thread',
      expect.anything(),
    );
    client.dispose();
    unregisterThread.mockRestore();
  });

  it('does not share pool keys across managed-secret boundaries', () => {
    const defaultProfile = resolveCodexSpawnProfile();
    const isolatedProfile = resolveCodexSpawnProfile({
      includeCanopySecrets: false,
    });
    const defaultKey = buildCodexAppServerPoolKey({
      profileKey: defaultProfile.id,
    });
    const isolatedKey = buildCodexAppServerPoolKey({
      profileKey: isolatedProfile.id,
    });

    expect(defaultKey).toMatch(/^profile:[a-f0-9]{64}$/);
    expect(isolatedKey).toMatch(/^profile:[a-f0-9]{64}$/);
    expect(isolatedKey).not.toBe(defaultKey);
  });

  it('quarantines only the restart owner until its turn is terminal', async () => {
    const connection = new CodexAppServerConnection('default');
    const restartOwnerCancelPendingTurnStart = jest.fn();
    const restartOwnerRejectActiveTurn = jest.fn();
    const restartOwnerMarkProcessFailed = jest.fn();
    const restartOwnerGetActiveTurnInterruptTarget = jest.fn(() => ({
      threadId: 'restart-thread',
      turnId: 'restart-turn',
    }));
    const activePeerRejectActiveTurn = jest.fn();
    const activePeerMarkProcessFailed = jest.fn();
    const restartOwner = createConnectionOwner({
      getActiveTurnInterruptTarget: restartOwnerGetActiveTurnInterruptTarget,
      cancelPendingTurnStart: restartOwnerCancelPendingTurnStart,
      rejectActiveTurn: restartOwnerRejectActiveTurn,
      markProcessFailed: restartOwnerMarkProcessFailed,
    });
    const activePeer = createConnectionOwner({
      hasActiveTurn: jest.fn(() => true),
      rejectActiveTurn: activePeerRejectActiveTurn,
      markProcessFailed: activePeerMarkProcessFailed,
    });
    const restartError = new Error('turn_cancelled');
    connection.registerOwner(restartOwner, {});
    connection.registerOwner(activePeer, {});
    connection.registerRootThread('restart-thread', restartOwner);
    const initializePromise = connection.ensureInitialized();
    await flush();
    emitServerMessage(proc, {
      id: 1,
      result: { userAgent: 'ua', codexHome: '/tmp/.codex' },
    });
    await initializePromise;
    collectClientMessages(proc);
    emitServerMessage(proc, {
      id: 'server-request',
      method: 'item/tool/requestUserInput',
      params: { threadId: 'restart-thread', itemId: 'restart-item' },
    });
    await flush();

    connection.triggerSharedRestart(restartOwner, restartError);

    expect(restartOwnerCancelPendingTurnStart).toHaveBeenCalledWith(
      restartError,
    );
    expect(restartOwnerRejectActiveTurn).not.toHaveBeenCalled();
    expect(restartOwnerMarkProcessFailed).not.toHaveBeenCalled();
    expect(connection.resolveOwnerForThread('restart-thread')).toBe(
      restartOwner,
    );
    expect(collectClientMessages(proc)).toContainEqual(
      expect.objectContaining({ id: 'server-request' }),
    );
    expect(activePeerRejectActiveTurn).not.toHaveBeenCalled();
    expect(activePeerMarkProcessFailed).not.toHaveBeenCalled();

    connection.unregisterOwner(restartOwner);
    expect(connection.resolveOwnerForThread('restart-thread')).toBe(
      restartOwner,
    );
    emitServerMessage(proc, {
      method: 'turn/completed',
      params: {
        threadId: 'restart-thread',
        turn: { id: 'restart-turn', status: 'interrupted' },
      },
    });
    await flush();

    expect(restartOwnerRejectActiveTurn).toHaveBeenCalledWith(restartError);
    expect(restartOwnerMarkProcessFailed).toHaveBeenCalledTimes(1);
    expect(connection.resolveOwnerForThread('restart-thread')).toBeNull();
    await connection.terminateForFinalRelease();
  });

  it('routes correlated MCP elicitations to the exact thread owner', async () => {
    const connection = new CodexAppServerConnection('default');
    const handleMcpElicitation = jest.fn((requestId: string) => {
      if (!connection.completePendingServerRequest(owner, requestId)) {
        return Promise.resolve();
      }
      connection.send({
        id: requestId,
        result: { action: 'accept', content: null, _meta: null },
      });
      return Promise.resolve();
    });
    const owner = createConnectionOwner({ handleMcpElicitation });
    connection.registerOwner(owner, {});
    connection.registerRootThread('thread-1', owner);
    const initializePromise = connection.ensureInitialized();
    await flush();
    emitServerMessage(proc, {
      id: 1,
      result: { userAgent: 'ua', codexHome: '/tmp/.codex' },
    });
    await initializePromise;
    collectClientMessages(proc);

    emitServerMessage(proc, {
      method: 'item/started',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        item: {
          type: 'mcpToolCall',
          id: 'mcp-call-1',
          server: 'github',
          tool: 'create_issue',
          status: 'inProgress',
          arguments: { labels: ['bug'], title: 'Retry safety' },
          result: null,
          error: null,
        },
      },
    });
    emitServerMessage(proc, {
      id: 'elicitation-1',
      method: 'mcpServer/elicitation/request',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        serverName: 'github',
        mode: 'form',
        message: 'Approve this MCP call?',
        requestedSchema: { type: 'object', properties: {} },
        _meta: {
          codex_approval_kind: 'mcp_tool_call',
          codex_mcp_tool_call_id: 'mcp-call-1',
        },
      },
    });
    await flush();

    expect(handleMcpElicitation).toHaveBeenCalledWith(
      'elicitation-1',
      expect.any(Object),
      {
        id: 'mcp-call-1',
        threadId: 'thread-1',
        turnId: 'turn-1',
        serverName: 'github',
        toolName: 'create_issue',
        arguments: { labels: ['bug'], title: 'Retry safety' },
        normalizedArguments: '{"labels":["bug"],"title":"Retry safety"}',
      },
      'mcp_tool_call',
      expect.any(AbortSignal),
    );
    expect(collectClientMessages(proc)).toContainEqual({
      id: 'elicitation-1',
      result: { action: 'accept', content: null, _meta: null },
    });
    await connection.terminateForFinalRelease();
  });

  it('accepts an exactly correlated MCP elicitation when interactive approval allows it', async () => {
    const client = createClient(
      [],
      createFakeApprovalSession({ decision: 'allow' }),
    );
    const { turnPromise } = await startActiveTurn(client, proc);
    collectClientMessages(proc);

    emitServerMessage(proc, {
      method: 'item/started',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        item: {
          type: 'mcpToolCall',
          id: 'mcp-call-1',
          server: 'github',
          tool: 'create_issue',
          status: 'inProgress',
          arguments: { title: 'Interactive acceptance' },
          result: null,
          error: null,
        },
      },
    });
    emitServerMessage(proc, {
      id: 'elicitation-1',
      method: 'mcpServer/elicitation/request',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        serverName: 'github',
        mode: 'form',
        message: 'Approve this MCP call?',
        requestedSchema: { type: 'object', properties: {} },
        _meta: {
          codex_approval_kind: 'mcp_tool_call',
          codex_mcp_tool_call_id: 'mcp-call-1',
        },
      },
    });
    await flush();

    expect(collectClientMessages(proc)).toContainEqual({
      id: 'elicitation-1',
      result: { action: 'accept', content: null, _meta: null },
    });

    emitServerMessage(proc, {
      method: 'turn/completed',
      params: {
        threadId: 'thread-1',
        turn: {
          id: 'turn-1',
          status: 'completed',
          items: [],
          error: null,
        },
      },
    });
    await turnPromise;
    client.dispose();
  });

  it('declines MCP elicitations without exact call correlation', async () => {
    const connection = new CodexAppServerConnection('default');
    const handleMcpElicitation = jest.fn(async () => {});
    const owner = createConnectionOwner({ handleMcpElicitation });
    connection.registerOwner(owner, {});
    connection.registerRootThread('thread-1', owner);
    const initializePromise = connection.ensureInitialized();
    await flush();
    emitServerMessage(proc, {
      id: 1,
      result: { userAgent: 'ua', codexHome: '/tmp/.codex' },
    });
    await initializePromise;
    collectClientMessages(proc);

    emitServerMessage(proc, {
      id: 'elicitation-1',
      method: 'mcpServer/elicitation/request',
      params: {
        threadId: 'thread-1',
        serverName: 'github',
        mode: 'form',
        message: 'Approve this MCP call?',
        requestedSchema: { type: 'object', properties: {} },
        _meta: {
          codex_approval_kind: 'mcp_tool_call',
          codex_mcp_tool_call_id: 'unknown-call',
        },
      },
    });
    await flush();

    expect(handleMcpElicitation).not.toHaveBeenCalled();
    expect(collectClientMessages(proc)).toContainEqual({
      id: 'elicitation-1',
      result: { action: 'decline', content: null, _meta: null },
    });
    await connection.terminateForFinalRelease();
  });

  it('declines MCP elicitations when the call belongs to another owner', async () => {
    const connection = new CodexAppServerConnection('default');
    const firstOwner = createConnectionOwner();
    const handleMcpElicitation = jest.fn(async () => {});
    const secondOwner = createConnectionOwner({ handleMcpElicitation });
    connection.registerOwner(firstOwner, {});
    connection.registerOwner(secondOwner, {});
    connection.registerRootThread('thread-1', firstOwner);
    connection.registerRootThread('thread-2', secondOwner);
    const initializePromise = connection.ensureInitialized();
    await flush();
    emitServerMessage(proc, {
      id: 1,
      result: { userAgent: 'ua', codexHome: '/tmp/.codex' },
    });
    await initializePromise;
    collectClientMessages(proc);

    emitServerMessage(proc, {
      method: 'item/started',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        item: {
          type: 'mcpToolCall',
          id: 'mcp-call-1',
          server: 'github',
          tool: 'create_issue',
          status: 'inProgress',
          arguments: { title: 'Owner isolation' },
          result: null,
          error: null,
        },
      },
    });
    emitServerMessage(proc, {
      id: 'elicitation-1',
      method: 'mcpServer/elicitation/request',
      params: {
        threadId: 'thread-2',
        turnId: 'turn-2',
        serverName: 'github',
        mode: 'form',
        message: 'Approve this MCP call?',
        requestedSchema: { type: 'object', properties: {} },
        _meta: {
          codex_approval_kind: 'mcp_tool_call',
          codex_mcp_tool_call_id: 'mcp-call-1',
        },
      },
    });
    await flush();

    expect(handleMcpElicitation).not.toHaveBeenCalled();
    expect(collectClientMessages(proc)).toContainEqual({
      id: 'elicitation-1',
      result: { action: 'decline', content: null, _meta: null },
    });
    await connection.terminateForFinalRelease();
  });

  it('preserves a pre-ID turn until it can be interrupted', async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate'] });
    try {
      const connection = new CodexAppServerConnection('default');
      const restartOwnerRejectActiveTurn = jest.fn();
      const restartOwnerMarkProcessFailed = jest.fn();
      const restartOwnerGetActiveTurnInterruptTarget = jest.fn<
        ReturnType<
          CodexAppServerConnectionOwner['getActiveTurnInterruptTarget']
        >,
        []
      >(() => ({
        threadId: 'restart-thread',
        turnId: null,
      }));
      const restartOwner = createConnectionOwner({
        getActiveTurnInterruptTarget: restartOwnerGetActiveTurnInterruptTarget,
        rejectActiveTurn: restartOwnerRejectActiveTurn,
        markProcessFailed: restartOwnerMarkProcessFailed,
      });
      const activePeer = createConnectionOwner({
        hasActiveTurn: jest.fn(() => true),
      });
      const restartError = new Error('turn_cancelled');
      connection.registerOwner(restartOwner, {});
      connection.registerOwner(activePeer, {});
      connection.registerRootThread('restart-thread', restartOwner);
      const initializePromise = connection.ensureInitialized();
      await flush();
      emitServerMessage(proc, {
        id: 1,
        result: { userAgent: 'ua', codexHome: '/tmp/.codex' },
      });
      await initializePromise;
      collectClientMessages(proc);

      let pendingOwnerRequestSettled = false;
      const pendingOwnerRequest = connection.request(
        'thread/read',
        {
          threadId: 'restart-thread',
          includeTurns: true,
        },
        { owner: restartOwner },
      );
      void pendingOwnerRequest.finally((): void => {
        pendingOwnerRequestSettled = true;
      });
      collectClientMessages(proc);

      connection.triggerSharedRestart(restartOwner, restartError);
      await flush();

      expect(pendingOwnerRequestSettled).toBe(false);
      expect(restartOwnerRejectActiveTurn).not.toHaveBeenCalled();
      expect(restartOwnerMarkProcessFailed).not.toHaveBeenCalled();
      expect(connection.resolveOwnerForThread('restart-thread')).toBe(
        restartOwner,
      );

      emitServerMessage(proc, {
        id: 2,
        result: makeThreadResult('restart-thread'),
      });
      await pendingOwnerRequest;
      restartOwnerGetActiveTurnInterruptTarget.mockReturnValue({
        threadId: 'restart-thread',
        turnId: 'restart-turn',
      });
      await jest.advanceTimersByTimeAsync(1_000);

      expect(collectClientMessages(proc)).toContainEqual(
        expect.objectContaining({
          method: 'turn/interrupt',
          params: {
            threadId: 'restart-thread',
            turnId: 'restart-turn',
          },
        }),
      );
      emitServerMessage(proc, { id: 3, result: {} });
      emitServerMessage(proc, {
        method: 'turn/completed',
        params: {
          threadId: 'restart-thread',
          turn: { id: 'restart-turn', status: 'interrupted' },
        },
      });
      await flush();

      expect(restartOwnerRejectActiveTurn).toHaveBeenCalledWith(restartError);
      expect(restartOwnerMarkProcessFailed).toHaveBeenCalledTimes(1);
      expect(connection.resolveOwnerForThread('restart-thread')).toBeNull();
      await connection.terminateForFinalRelease();
    } finally {
      jest.useRealTimers();
    }
  });

  it('captures a quarantined turn ID after its owner is disposed', async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate'] });
    try {
      const connection = new CodexAppServerConnection('default');
      const restartOwnerRejectActiveTurn = jest.fn();
      const restartOwnerMarkProcessFailed = jest.fn();
      const restartOwnerHandleConnectionNotification = jest.fn();
      const restartOwner = createConnectionOwner({
        getActiveTurnInterruptTarget: jest.fn(() => ({
          threadId: 'restart-thread',
          turnId: null,
        })),
        rejectActiveTurn: restartOwnerRejectActiveTurn,
        markProcessFailed: restartOwnerMarkProcessFailed,
        handleConnectionNotification: restartOwnerHandleConnectionNotification,
      });
      const activePeer = createConnectionOwner({
        hasActiveTurn: jest.fn(() => true),
      });
      const restartError = new Error('session_destroyed');
      connection.registerOwner(restartOwner, {});
      connection.registerOwner(activePeer, {});
      connection.registerRootThread('restart-thread', restartOwner);
      const initializePromise = connection.ensureInitialized();
      await flush();
      emitServerMessage(proc, {
        id: 1,
        result: { userAgent: 'ua', codexHome: '/tmp/.codex' },
      });
      await initializePromise;
      collectClientMessages(proc);

      connection.triggerSharedRestart(restartOwner, restartError);
      connection.unregisterOwner(restartOwner);
      emitServerMessage(proc, {
        method: 'turn/started',
        params: {
          threadId: 'restart-thread',
          turn: {
            id: 'restart-turn',
            items: [],
            status: 'inProgress',
            error: null,
          },
        },
      });
      await jest.advanceTimersByTimeAsync(1_000);

      expect(restartOwnerHandleConnectionNotification).not.toHaveBeenCalled();
      expect(collectClientMessages(proc)).toContainEqual(
        expect.objectContaining({
          method: 'turn/interrupt',
          params: {
            threadId: 'restart-thread',
            turnId: 'restart-turn',
          },
        }),
      );

      emitServerMessage(proc, { id: 2, result: {} });
      emitServerMessage(proc, {
        method: 'turn/completed',
        params: {
          threadId: 'restart-thread',
          turn: { id: 'restart-turn', status: 'interrupted' },
        },
      });
      await flush();

      expect(restartOwnerRejectActiveTurn).toHaveBeenCalledWith(restartError);
      expect(restartOwnerMarkProcessFailed).toHaveBeenCalledTimes(1);
      expect(connection.resolveOwnerForThread('restart-thread')).toBeNull();
      await connection.terminateForFinalRelease();
    } finally {
      jest.useRealTimers();
    }
  });

  it('retries a quarantined interrupt and restarts once peers are idle', async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate'] });
    try {
      const connection = new CodexAppServerConnection('default');
      const restartOwner = createConnectionOwner({
        getActiveTurnInterruptTarget: jest.fn(() => ({
          threadId: 'restart-thread',
          turnId: 'restart-turn',
        })),
      });
      const peerHasActiveTurn = jest.fn(() => true);
      const activePeer = createConnectionOwner({
        hasActiveTurn: peerHasActiveTurn,
      });
      connection.registerOwner(restartOwner, {});
      connection.registerOwner(activePeer, {});
      connection.registerRootThread('restart-thread', restartOwner);
      const initializePromise = connection.ensureInitialized();
      await flush();
      emitServerMessage(proc, {
        id: 1,
        result: { userAgent: 'ua', codexHome: '/tmp/.codex' },
      });
      await initializePromise;
      collectClientMessages(proc);

      connection.triggerSharedRestart(
        restartOwner,
        new Error('turn_cancelled'),
      );
      await jest.advanceTimersByTimeAsync(1_000);

      expect(collectClientMessages(proc)).toContainEqual(
        expect.objectContaining({
          method: 'turn/interrupt',
          params: {
            threadId: 'restart-thread',
            turnId: 'restart-turn',
          },
        }),
      );
      expect(proc.kill).not.toHaveBeenCalled();

      peerHasActiveTurn.mockReturnValue(false);
      await jest.advanceTimersByTimeAsync(3_500);

      expect(proc.kill).toHaveBeenCalledWith('SIGTERM');
    } finally {
      jest.useRealTimers();
    }
  });

  it('forces a shared restart when quarantine reaches its deadline', async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate'] });
    try {
      const connection = new CodexAppServerConnection('default');
      const restartOwner = createConnectionOwner({
        getActiveTurnInterruptTarget: jest.fn(() => ({
          threadId: 'restart-thread',
          turnId: 'restart-turn',
        })),
      });
      const activePeer = createConnectionOwner({
        hasActiveTurn: jest.fn(() => true),
      });
      connection.registerOwner(restartOwner, {});
      connection.registerOwner(activePeer, {});
      connection.registerRootThread('restart-thread', restartOwner);
      const initializePromise = connection.ensureInitialized();
      await flush();
      emitServerMessage(proc, {
        id: 1,
        result: { userAgent: 'ua', codexHome: '/tmp/.codex' },
      });
      await initializePromise;
      collectClientMessages(proc);

      connection.triggerSharedRestart(
        restartOwner,
        new Error('turn_cancelled'),
      );
      await jest.advanceTimersByTimeAsync(29_999);

      expect(proc.kill).not.toHaveBeenCalled();

      await jest.advanceTimersByTimeAsync(1);

      expect(proc.kill).toHaveBeenCalledWith('SIGTERM');
    } finally {
      jest.useRealTimers();
    }
  });

  it('restarts immediately after bounded turn interruption fails', async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate'] });
    try {
      const connection = new CodexAppServerConnection('default');
      const restartOwner = createConnectionOwner();
      const activePeer = createConnectionOwner({
        hasActiveTurn: jest.fn(() => true),
      });
      connection.registerOwner(restartOwner, {});
      connection.registerOwner(activePeer, {});
      connection.registerRootThread('restart-thread', restartOwner);
      const initializePromise = connection.ensureInitialized();
      await flush();
      emitServerMessage(proc, {
        id: 1,
        result: { userAgent: 'ua', codexHome: '/tmp/.codex' },
      });
      await initializePromise;
      collectClientMessages(proc);

      const interruptPromise = connection.interruptTurn(restartOwner, {
        threadId: 'restart-thread',
        turnId: 'restart-turn',
      });
      await jest.advanceTimersByTimeAsync(4_999);

      expect(proc.kill).not.toHaveBeenCalled();

      await jest.advanceTimersByTimeAsync(1);
      await interruptPromise;

      expect(proc.kill).toHaveBeenCalledWith('SIGTERM');
    } finally {
      jest.useRealTimers();
    }
  });

  it('restarts when only mutually quarantined owners remain busy', async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate'] });
    try {
      const connection = new CodexAppServerConnection('default');
      const firstQuarantinedOwner = createConnectionOwner({
        hasActiveTurn: jest.fn(() => true),
        getActiveTurnInterruptTarget: jest.fn(() => ({
          threadId: 'first-quarantined-thread',
          turnId: 'first-quarantined-turn',
        })),
      });
      const secondQuarantinedOwner = createConnectionOwner({
        hasActiveTurn: jest.fn(() => true),
        getActiveTurnInterruptTarget: jest.fn(() => ({
          threadId: 'second-quarantined-thread',
          turnId: 'second-quarantined-turn',
        })),
      });
      const protectedPeerHasActiveTurn = jest.fn(() => true);
      const protectedPeer = createConnectionOwner({
        hasActiveTurn: protectedPeerHasActiveTurn,
      });
      connection.registerOwner(firstQuarantinedOwner, {});
      connection.registerOwner(secondQuarantinedOwner, {});
      connection.registerOwner(protectedPeer, {});
      connection.registerRootThread(
        'first-quarantined-thread',
        firstQuarantinedOwner,
      );
      connection.registerRootThread(
        'second-quarantined-thread',
        secondQuarantinedOwner,
      );
      const initializePromise = connection.ensureInitialized();
      await flush();
      emitServerMessage(proc, {
        id: 1,
        result: { userAgent: 'ua', codexHome: '/tmp/.codex' },
      });
      await initializePromise;
      collectClientMessages(proc);

      connection.triggerSharedRestart(
        firstQuarantinedOwner,
        new Error('first_turn_cancelled'),
      );
      connection.triggerSharedRestart(
        secondQuarantinedOwner,
        new Error('second_turn_cancelled'),
      );

      protectedPeerHasActiveTurn.mockReturnValue(false);
      await jest.advanceTimersByTimeAsync(1_000);

      expect(proc.kill).toHaveBeenCalledWith('SIGTERM');
      expect(collectClientMessages(proc)).not.toContainEqual(
        expect.objectContaining({ method: 'turn/interrupt' }),
      );
    } finally {
      jest.useRealTimers();
    }
  });

  it('restarts immediately when a disposed turn interrupt times out', async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate'] });
    try {
      const connection = new CodexAppServerConnection('default');
      const disposedOwner = createConnectionOwner();
      const activePeer = createConnectionOwner({
        hasActiveTurn: jest.fn(() => true),
      });
      connection.registerOwner(disposedOwner, {});
      connection.registerOwner(activePeer, {});
      connection.registerRootThread('disposed-thread', disposedOwner);
      const initializePromise = connection.ensureInitialized();
      await flush();
      emitServerMessage(proc, {
        id: 1,
        result: { userAgent: 'ua', codexHome: '/tmp/.codex' },
      });
      await initializePromise;
      collectClientMessages(proc);

      connection.disposeOwnerActiveTurn(disposedOwner, {
        threadId: 'disposed-thread',
        turnId: 'disposed-turn',
      });
      connection.unregisterOwner(disposedOwner);

      expect(connection.resolveOwnerForThread('disposed-thread')).toBe(
        disposedOwner,
      );
      expect(collectClientMessages(proc)).toContainEqual(
        expect.objectContaining({
          id: 2,
          method: 'turn/interrupt',
          params: {
            threadId: 'disposed-thread',
            turnId: 'disposed-turn',
          },
        }),
      );

      await jest.advanceTimersByTimeAsync(4_999);

      expect(connection.resolveOwnerForThread('disposed-thread')).toBe(
        disposedOwner,
      );
      expect(proc.kill).not.toHaveBeenCalled();

      await jest.advanceTimersByTimeAsync(1);

      expect(proc.kill).toHaveBeenCalledWith('SIGTERM');
      expect(connection.resolveOwnerForThread('disposed-thread')).toBeNull();
    } finally {
      jest.useRealTimers();
    }
  });

  it('cleans up disposed turn routing when no terminal event arrives', async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate'] });
    try {
      const connection = new CodexAppServerConnection('default');
      const disposedOwner = createConnectionOwner();
      const peerHandleConnectionNotification = jest.fn();
      const activePeer = createConnectionOwner({
        hasActiveTurn: jest.fn(() => true),
        handleConnectionNotification: peerHandleConnectionNotification,
      });
      connection.registerOwner(disposedOwner, {});
      connection.registerOwner(activePeer, {});
      connection.registerRootThread('disposed-thread', disposedOwner);
      const initializePromise = connection.ensureInitialized();
      await flush();
      emitServerMessage(proc, {
        id: 1,
        result: { userAgent: 'ua', codexHome: '/tmp/.codex' },
      });
      await initializePromise;
      collectClientMessages(proc);

      connection.disposeOwnerActiveTurn(disposedOwner, {
        threadId: 'disposed-thread',
        turnId: 'disposed-turn',
      });
      connection.unregisterOwner(disposedOwner);
      emitServerMessage(proc, { id: 2, result: {} });
      await flush();

      await jest.advanceTimersByTimeAsync(4_999);
      expect(connection.resolveOwnerForThread('disposed-thread')).toBe(
        disposedOwner,
      );

      await jest.advanceTimersByTimeAsync(1);
      expect(connection.resolveOwnerForThread('disposed-thread')).toBeNull();
      expect(collectClientMessages(proc)).toContainEqual(
        expect.objectContaining({
          method: 'thread/unsubscribe',
          params: { threadId: 'disposed-thread' },
        }),
      );
      emitServerMessage(proc, {
        method: 'turn/completed',
        params: {
          threadId: 'disposed-thread',
          turn: { id: 'disposed-turn', status: 'interrupted' },
        },
      });
      await flush();

      expect(peerHandleConnectionNotification).not.toHaveBeenCalled();
      await connection.terminateForFinalRelease();
    } finally {
      jest.useRealTimers();
    }
  });

  it('preserves quarantine routing after a disposal interrupt succeeds', async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate'] });
    try {
      const connection = new CodexAppServerConnection('default');
      const disposedOwnerRejectActiveTurn = jest.fn();
      const disposedOwnerMarkProcessFailed = jest.fn();
      const disposedOwner = createConnectionOwner({
        getActiveTurnInterruptTarget: jest.fn(() => ({
          threadId: 'disposed-thread',
          turnId: 'disposed-turn',
        })),
        rejectActiveTurn: disposedOwnerRejectActiveTurn,
        markProcessFailed: disposedOwnerMarkProcessFailed,
      });
      const activePeer = createConnectionOwner({
        hasActiveTurn: jest.fn(() => true),
      });
      const restartError = new Error('session_destroyed');
      connection.registerOwner(disposedOwner, {});
      connection.registerOwner(activePeer, {});
      connection.registerRootThread('disposed-thread', disposedOwner);
      const initializePromise = connection.ensureInitialized();
      await flush();
      emitServerMessage(proc, {
        id: 1,
        result: { userAgent: 'ua', codexHome: '/tmp/.codex' },
      });
      await initializePromise;
      collectClientMessages(proc);

      connection.triggerSharedRestart(disposedOwner, restartError);
      connection.disposeOwnerActiveTurn(disposedOwner, {
        threadId: 'disposed-thread',
        turnId: 'disposed-turn',
      });
      connection.unregisterOwner(disposedOwner);
      expect(collectClientMessages(proc)).toContainEqual(
        expect.objectContaining({
          id: 2,
          method: 'turn/interrupt',
        }),
      );

      emitServerMessage(proc, { id: 2, result: {} });
      await flush();

      expect(connection.resolveOwnerForThread('disposed-thread')).toBe(
        disposedOwner,
      );
      await jest.advanceTimersByTimeAsync(5_000);
      expect(collectClientMessages(proc)).not.toContainEqual(
        expect.objectContaining({ method: 'thread/unsubscribe' }),
      );
      emitServerMessage(proc, {
        method: 'turn/completed',
        params: {
          threadId: 'disposed-thread',
          turn: { id: 'disposed-turn', status: 'interrupted' },
        },
      });
      await flush();

      expect(disposedOwnerRejectActiveTurn).toHaveBeenCalledWith(restartError);
      expect(disposedOwnerMarkProcessFailed).toHaveBeenCalledTimes(1);
      expect(connection.resolveOwnerForThread('disposed-thread')).toBeNull();
      expect(collectClientMessages(proc)).toContainEqual(
        expect.objectContaining({
          method: 'thread/unsubscribe',
          params: { threadId: 'disposed-thread' },
        }),
      );
      await jest.advanceTimersByTimeAsync(1_000);
      expect(collectClientMessages(proc)).not.toContainEqual(
        expect.objectContaining({ method: 'turn/interrupt' }),
      );
      await connection.terminateForFinalRelease();
    } finally {
      jest.useRealTimers();
    }
  });

  it('keeps quarantined child-thread notifications isolated from peers', async () => {
    const connection = new CodexAppServerConnection('default');
    const quarantinedOwnerHandleConnectionNotification = jest.fn();
    const peerHandleConnectionNotification = jest.fn();
    const quarantinedOwner = createConnectionOwner({
      getActiveTurnInterruptTarget: jest.fn(() => ({
        threadId: 'quarantined-thread',
        turnId: 'quarantined-turn',
      })),
      handleConnectionNotification:
        quarantinedOwnerHandleConnectionNotification,
    });
    const activePeer = createConnectionOwner({
      hasActiveTurn: jest.fn(() => true),
      handleConnectionNotification: peerHandleConnectionNotification,
    });
    connection.registerOwner(quarantinedOwner, {});
    connection.registerOwner(activePeer, {});
    connection.registerRootThread('quarantined-thread', quarantinedOwner);
    const initializePromise = connection.ensureInitialized();
    await flush();
    emitServerMessage(proc, {
      id: 1,
      result: { userAgent: 'ua', codexHome: '/tmp/.codex' },
    });
    await initializePromise;
    collectClientMessages(proc);

    connection.triggerSharedRestart(
      quarantinedOwner,
      new Error('session_destroyed'),
    );
    connection.unregisterOwner(quarantinedOwner);
    emitServerMessage(proc, {
      method: 'thread/started',
      params: {
        thread: {
          id: 'quarantined-child-thread',
          source: {
            subAgent: {
              parentThreadId: 'quarantined-thread',
            },
          },
        },
      },
    });
    emitServerMessage(proc, {
      method: 'item/commandExecution/outputDelta',
      params: {
        threadId: 'quarantined-child-thread',
        turnId: 'quarantined-child-turn',
        itemId: 'quarantined-child-item',
        delta: 'private output',
      },
    });
    await flush();

    expect(connection.resolveOwnerForThread('quarantined-child-thread')).toBe(
      quarantinedOwner,
    );
    expect(quarantinedOwnerHandleConnectionNotification).not.toHaveBeenCalled();
    expect(peerHandleConnectionNotification).not.toHaveBeenCalled();
    await connection.terminateForFinalRelease();
  });

  it('rejects dynamic tools while owner disposal interruption is pending', async () => {
    const connection = new CodexAppServerConnection('default');
    const disposedOwnerHandleDynamicToolCall = jest.fn(async () => {});
    const disposedOwner = createConnectionOwner({
      handleDynamicToolCall: disposedOwnerHandleDynamicToolCall,
    });
    const activePeer = createConnectionOwner({
      hasActiveTurn: jest.fn(() => true),
    });
    connection.registerOwner(disposedOwner, {});
    connection.registerOwner(activePeer, {});
    connection.registerRootThread('disposed-thread', disposedOwner);
    const initializePromise = connection.ensureInitialized();
    await flush();
    emitServerMessage(proc, {
      id: 1,
      result: { userAgent: 'ua', codexHome: '/tmp/.codex' },
    });
    await initializePromise;
    collectClientMessages(proc);

    connection.disposeOwnerActiveTurn(disposedOwner, {
      threadId: 'disposed-thread',
      turnId: 'disposed-turn',
    });
    connection.unregisterOwner(disposedOwner);
    collectClientMessages(proc);
    emitServerMessage(proc, {
      id: 'server-request',
      method: 'item/tool/call',
      params: {
        threadId: 'disposed-thread',
        turnId: 'disposed-turn',
        callId: 'late-call',
        tool: 'canopy_ask_user_question',
        arguments: {},
      },
    });
    await flush();

    expect(disposedOwnerHandleDynamicToolCall).not.toHaveBeenCalled();
    expect(collectClientMessages(proc)).toContainEqual({
      id: 'server-request',
      result: {
        contentItems: [
          {
            type: 'inputText',
            text: 'Canopy session is cancelling and cannot run dynamic tools',
          },
        ],
        success: false,
      },
    });
    await connection.terminateForFinalRelease();
  });

  it('does not continue a pending turn start after busy-peer recovery', async () => {
    const client = createClient();
    const activePeer = new CodexAppServerClient({
      cwd: '/tmp/repo',
      projectId: 'project',
      worktreeId: 'worktree',
      chatId: 'chat-b',
      sessionKey: 'project/worktree/chat-b',
      onEvent: jest.fn(),
      getWindow: (): null => null,
    });
    const peerTurnPromise = activePeer.startTurn({
      text: 'Keep the shared process busy',
      cwd: '/tmp/repo',
      model: 'gpt-6-sol',
      thinkingLevel: 'high',
      planMode: false,
    });
    void peerTurnPromise.catch(() => {});
    const turnPromise = client.startTurn({
      text: 'Do not start after cancellation',
      cwd: '/tmp/repo',
      model: 'gpt-6-sol',
      thinkingLevel: 'high',
      planMode: false,
    });
    void turnPromise.catch(() => {});
    await flush();

    await client.interruptTurn();

    emitServerMessage(proc, {
      id: 1,
      result: { userAgent: 'ua', codexHome: '/tmp/.codex' },
    });
    await flush();

    expect(
      collectClientMessages(proc).filter(
        (message) => message['method'] === 'thread/start',
      ),
    ).toHaveLength(1);
    await expect(turnPromise).rejects.toThrow('turn_cancelled');
    client.dispose();
    activePeer.dispose();
  });

  it('invalidates a pending turn start before a shared restart', async () => {
    const client = createClient();
    const turnPromise = client.startTurn({
      text: 'Do not start after cancellation',
      cwd: '/tmp/repo',
      model: 'gpt-6-sol',
      thinkingLevel: 'high',
      planMode: false,
    });
    void turnPromise.catch(() => {});
    await flush();

    await client.interruptTurn();

    expect(proc.kill).toHaveBeenCalledWith('SIGTERM');
    await expect(turnPromise).rejects.toThrow('turn_cancelled');
    client.dispose();
  });

  it('emits restored root context-window usage without an active turn', () => {
    const events: unknown[] = [];
    const client = new CodexAppServerClient({
      cwd: '/tmp/repo',
      projectId: 'project',
      worktreeId: 'worktree',
      chatId: 'chat',
      sessionKey: 'project/worktree/chat',
      initialThreadId: 'thread-1',
      onEvent: (event): void => {
        events.push(event);
      },
      getWindow: (): null => null,
    });

    void client.handleConnectionNotification('thread/tokenUsage/updated', {
      params: {
        threadId: 'thread-1',
        turnId: 'turn-before-resume',
        tokenUsage: {
          total: {
            totalTokens: 748_126,
            inputTokens: 700_000,
            cachedInputTokens: 40_000,
            outputTokens: 8_126,
            reasoningOutputTokens: 2_000,
          },
          last: {
            totalTokens: 81_659,
            inputTokens: 75_000,
            cachedInputTokens: 4_000,
            outputTokens: 2_659,
            reasoningOutputTokens: 1_000,
          },
          modelContextWindow: 258_400,
        },
      },
    });

    expect(events).toEqual([
      {
        type: 'codex',
        event: {
          type: 'thread.token_usage.updated',
          thread_id: 'thread-1',
          turn_id: 'turn-before-resume',
          usage: {
            context_tokens: 81_659,
            context_window: 258_400,
          },
        },
      },
    ]);
  });

  it('does not surface subagent context usage in the root composer', () => {
    const onEvent = jest.fn();
    const client = new CodexAppServerClient({
      cwd: '/tmp/repo',
      projectId: 'project',
      worktreeId: 'worktree',
      chatId: 'chat',
      sessionKey: 'project/worktree/chat',
      initialThreadId: 'thread-1',
      onEvent,
      getWindow: (): null => null,
    });

    void client.handleConnectionNotification('thread/tokenUsage/updated', {
      params: {
        threadId: 'subagent-thread',
        turnId: 'subagent-turn',
        tokenUsage: {
          total: { totalTokens: 20_000 },
          last: { totalTokens: 20_000 },
          modelContextWindow: 200_000,
        },
      },
    });

    expect(onEvent).not.toHaveBeenCalled();
  });

  it('prunes disposed item owner tombstones on terminal item notifications', () => {
    const connection = new CodexAppServerConnection('default');
    const internal = connection as unknown as {
      clients: Set<CodexAppServerConnectionOwner>;
      handleNotification: (
        method: string,
        notification: Record<string, unknown>,
      ) => void;
      itemOwners: Map<string, CodexAppServerConnectionOwner | null>;
    };
    const remainingHandleNotification = jest.fn();
    const remainingOwner = createConnectionOwner({
      handleConnectionNotification: remainingHandleNotification,
    });

    internal.clients.add(remainingOwner);
    internal.itemOwners.set('item-1', null);

    expect(internal.itemOwners.get('item-1')).toBeNull();

    internal.handleNotification('item/completed', {
      params: {
        item: {
          id: 'item-1',
          type: 'agentMessage',
          text: 'Done',
          phase: 'final_answer',
        },
      },
    });

    expect(internal.itemOwners.has('item-1')).toBe(false);
    expect(remainingHandleNotification).not.toHaveBeenCalled();
  });

  it('keeps released-owner handlers in the connection-wide recovery barrier', async () => {
    const connection = new CodexAppServerConnection('default');
    const owner = createConnectionOwner();
    let settleHandler: (() => void) | undefined;
    const handler = new Promise<void>((resolve) => {
      settleHandler = resolve;
    });
    const testSeam = connection.createTestSeam();

    testSeam.registerOwner(owner);
    const tracked = testSeam.trackPendingServerRequestHandler(owner, handler);
    connection.unregisterOwner(owner);

    expect(testSeam.pendingServerRequestHandlerCount(owner)).toBe(1);
    const barrier = testSeam.waitForPendingServerRequestHandlers();
    let barrierSettled = false;
    void barrier.settlement.then(() => {
      barrierSettled = true;
    });
    await flush();
    expect(barrierSettled).toBe(false);

    settleHandler?.();
    await tracked;
    await barrier.settlement;
    expect(barrierSettled).toBe(true);
    expect(testSeam.pendingServerRequestHandlerCount(owner)).toBe(0);
  });

  it('tombstones dynamic tool calls that arrive after their owner is unregistered', async () => {
    const connection = new CodexAppServerConnection('default');
    const sendMock = jest.spyOn(connection, 'send').mockImplementation();
    const internal = connection as unknown as {
      clients: Set<CodexAppServerConnectionOwner>;
      handleNotification: (
        method: string,
        notification: Record<string, unknown>,
      ) => void;
      itemOwners: Map<string, CodexAppServerConnectionOwner | null>;
      routeDynamicToolCall: (
        requestId: string,
        request: Record<string, unknown>,
      ) => Promise<void>;
    };
    const remainingHandleNotification = jest.fn();
    const remainingOwner = createConnectionOwner({
      handleConnectionNotification: remainingHandleNotification,
    });

    internal.clients.add(remainingOwner);

    await internal.routeDynamicToolCall('server-req-1', {
      params: {
        threadId: 'disposed-thread',
        turnId: 'turn-1',
        callId: 'late-call',
        tool: 'canopy_ask_user_question',
        arguments: {},
      },
    });

    expect(sendMock).toHaveBeenCalledTimes(1);
    const sentPayload: unknown = sendMock.mock.calls[0]?.[0];
    if (!isRecord(sentPayload) || !isRecord(sentPayload.result)) {
      throw new Error('Expected failed dynamic tool call response');
    }
    expect(sentPayload.id).toBe('server-req-1');
    expect(sentPayload.result.success).toBe(false);
    expect(internal.itemOwners.get('late-call')).toBeNull();

    internal.handleNotification('item/completed', {
      params: {
        item: {
          id: 'late-call',
          type: 'dynamicToolCall',
          tool: 'canopy_ask_user_question',
          status: 'failed',
          contentItems: [],
          success: false,
        },
      },
    });

    expect(internal.itemOwners.has('late-call')).toBe(false);
    expect(remainingHandleNotification).not.toHaveBeenCalled();
  });

  it('preserves missing ChatGPT account email as null', () => {
    expect(
      parseGetAccountResponsePayload({
        account: {
          type: 'chatgpt',
          planType: 'pro',
        },
        requiresOpenaiAuth: false,
      }),
    ).toEqual({
      account: {
        type: 'chatgpt',
        email: null,
        planType: 'pro',
      },
      requiresOpenaiAuth: false,
      workspaceRouting: null,
    });
  });

  it('shares one app-server process for two default-env clients', async () => {
    const eventsA: unknown[] = [];
    const eventsB: unknown[] = [];
    const clientA = createClient(eventsA);
    const clientB = new CodexAppServerClient({
      cwd: '/tmp/repo',
      projectId: 'project',
      worktreeId: 'worktree',
      chatId: 'chat-b',
      sessionKey: 'project/worktree/chat-b',
      onEvent: (event): void => {
        eventsB.push(event);
      },
      getWindow: (): null => null,
    });

    const turnA = clientA.startTurn({
      text: 'A',
      cwd: '/tmp/repo',
      model: 'gpt-6-sol',
      thinkingLevel: 'high',
      planMode: false,
    });
    const turnB = clientB.startTurn({
      text: 'B',
      cwd: '/tmp/repo',
      model: 'gpt-6-sol',
      thinkingLevel: 'high',
      planMode: false,
    });

    await flush();
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(spawnMock).toHaveBeenCalledWith(
      '/mock/codex',
      ['app-server'],
      expect.objectContaining({
        cwd: process.cwd(),
        detached: true,
        windowsHide: true,
      }),
    );
    emitServerMessage(proc, {
      id: 1,
      result: { userAgent: 'ua', codexHome: '/tmp/.codex' },
    });
    await flush();
    await flush();
    emitServerMessage(proc, { id: 2, result: makeThreadResult('thread-a') });
    emitServerMessage(proc, { id: 3, result: makeThreadResult('thread-b') });
    await flush();
    await flush();
    emitServerMessage(proc, {
      id: 4,
      result: {
        turn: { id: 'turn-a', items: [], status: 'inProgress', error: null },
      },
    });
    emitServerMessage(proc, {
      id: 5,
      result: {
        turn: { id: 'turn-b', items: [], status: 'inProgress', error: null },
      },
    });
    await flush();

    emitServerMessage(proc, {
      method: 'turn/completed',
      params: {
        threadId: 'thread-a',
        turn: { id: 'turn-a', items: [], status: 'completed', error: null },
      },
    });
    emitServerMessage(proc, {
      method: 'turn/completed',
      params: {
        threadId: 'thread-b',
        turn: { id: 'turn-b', items: [], status: 'completed', error: null },
      },
    });

    await expect(turnA).resolves.toMatchObject({ status: 'completed' });
    await expect(turnB).resolves.toMatchObject({ status: 'completed' });
  });

  it('completes a peer chat turn while another chat holds its notification admission', async () => {
    let releaseAdmission = (): void => undefined;
    const admission = new Promise<void>((resolve) => {
      releaseAdmission = resolve;
    });
    const clientA = new CodexAppServerClient({
      cwd: '/tmp/repo',
      projectId: 'project',
      worktreeId: 'worktree',
      chatId: 'chat',
      sessionKey: 'project/worktree/chat',
      onEvent: (event): void | Promise<void> => {
        if (
          typeof event === 'object' &&
          event !== null &&
          'event' in event &&
          typeof event.event === 'object' &&
          event.event !== null &&
          'type' in event.event &&
          event.event.type === 'turn.completed'
        ) {
          // Chat A's durable commit for its terminal event is slow.
          return admission;
        }
      },
      getWindow: (): null => null,
    });
    const clientB = new CodexAppServerClient({
      cwd: '/tmp/repo',
      projectId: 'project',
      worktreeId: 'worktree',
      chatId: 'chat-b',
      sessionKey: 'project/worktree/chat-b',
      onEvent: (): void => undefined,
      getWindow: (): null => null,
    });
    const { turnPromise: turnA } = await startActiveTurn(clientA, proc);
    let settledA = false;
    const outcomeA = turnA.then(
      (result) => {
        settledA = true;
        return result;
      },
      (error: unknown) => {
        settledA = true;
        throw error;
      },
    );
    try {
      completeRootTurn(proc);
      await flush();
      expect(settledA).toBe(false);
      // Discard chat A's requests so the waits below see only chat B's.
      collectClientMessages(proc);

      const turnB = clientB.startTurn({
        text: 'B',
        cwd: '/tmp/repo',
        model: 'gpt-6-sol',
        thinkingLevel: 'high',
        planMode: false,
      });
      // Disposal in `finally` rejects an unfinished turn; keep that observed.
      void turnB.catch(() => undefined);
      const threadStart = await waitForClientRequest(proc, 'thread/start');
      emitServerMessage(proc, {
        id: threadStart.id,
        result: makeThreadResult('thread-b'),
      });
      // Before per-owner admission, this reply stayed unread behind chat A's
      // held commit, so chat B never sent turn/start.
      const turnStart = await waitForClientRequest(proc, 'turn/start');
      emitServerMessage(proc, {
        id: turnStart.id,
        result: {
          turn: { id: 'turn-b', items: [], status: 'inProgress', error: null },
        },
      });
      await flush();
      emitServerMessage(proc, {
        method: 'turn/completed',
        params: {
          threadId: 'thread-b',
          turn: { id: 'turn-b', items: [], status: 'completed', error: null },
        },
      });
      await expect(turnB).resolves.toMatchObject({ status: 'completed' });
      expect(settledA).toBe(false);

      releaseAdmission();
      await expect(outcomeA).resolves.toMatchObject({ status: 'completed' });
    } finally {
      releaseAdmission();
      await outcomeA.catch(() => undefined);
      clientA.dispose();
      clientB.dispose();
    }
  });

  it('does not detach the app-server process on Windows', async () => {
    setPlatform('win32');
    const events: unknown[] = [];
    const client = createClient(events);

    const turnPromise = client.startTurn({
      text: 'hello',
      cwd: '/tmp/repo',
      model: 'gpt-6-sol',
      thinkingLevel: 'high',
      planMode: false,
    });

    await flush();
    expect(spawnMock).toHaveBeenCalledWith(
      '/mock/codex',
      ['app-server'],
      expect.objectContaining({
        cwd: process.cwd(),
        detached: false,
        windowsHide: true,
      }),
    );

    emitServerMessage(proc, {
      id: 1,
      result: { userAgent: 'ua', codexHome: '/tmp/.codex' },
    });
    await flush();
    await flush();
    emitServerMessage(proc, { id: 2, result: makeThreadResult('thread-win') });
    await flush();
    await flush();
    emitServerMessage(proc, {
      id: 3,
      result: {
        turn: { id: 'turn-win', items: [], status: 'inProgress', error: null },
      },
    });
    emitServerMessage(proc, {
      method: 'turn/completed',
      params: {
        threadId: 'thread-win',
        turn: { id: 'turn-win', items: [], status: 'completed', error: null },
      },
    });

    await expect(turnPromise).resolves.toMatchObject({ status: 'completed' });
  });

  it.each([
    [
      'state db backfill is still running',
      'state db backfill is running at /tmp/.codex; waiting up to 30s before retrying startup initialization\nError: timed out waiting for state db backfill at /tmp/.codex after 30s (status: running)\n',
    ],
    [
      'SQLite state runtime initialization fails',
      'Error: failed to initialize sqlite state runtime under /tmp/.codex: failed to initialize state runtime at /tmp/.codex\n',
    ],
  ])('retries startup when %s', async (_scenario, startupError) => {
    jest.useFakeTimers({ doNotFake: ['setImmediate'] });
    const firstProc = new MockChildProcess();
    const secondProc = new MockChildProcess();
    spawnMock
      .mockReset()
      .mockReturnValueOnce(firstProc)
      .mockReturnValueOnce(secondProc);
    const client = createClient();

    try {
      const turnPromise = client.startTurn({
        text: 'hello',
        cwd: '/tmp/repo',
        model: 'gpt-6-sol',
        thinkingLevel: 'high',
        planMode: false,
      });
      void turnPromise.catch(() => {});

      await flush();
      expect(spawnMock).toHaveBeenCalledTimes(1);
      firstProc.stderr.write(startupError);
      await flush();
      firstProc.emit('exit', 1, null);
      await flush();

      expect(spawnMock).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(5_000);
      await flush();

      expect(spawnMock).toHaveBeenCalledTimes(2);
      emitServerMessage(secondProc, {
        id: 2,
        result: { userAgent: 'ua', codexHome: '/tmp/.codex' },
      });
      await flush();
      await flush();
      emitServerMessage(secondProc, {
        id: 3,
        result: makeThreadResult('thread-retry'),
      });
      await flush();
      emitServerMessage(secondProc, {
        id: 4,
        result: {
          turn: {
            id: 'turn-retry',
            items: [],
            status: 'inProgress',
            error: null,
          },
        },
      });
      emitServerMessage(secondProc, {
        method: 'turn/completed',
        params: {
          threadId: 'thread-retry',
          turn: {
            id: 'turn-retry',
            items: [],
            status: 'completed',
            error: null,
          },
        },
      });

      await expect(turnPromise).resolves.toMatchObject({
        status: 'completed',
      });
    } finally {
      client.dispose();
      jest.useRealTimers();
    }
  });

  it.each([
    [
      'state db backfill',
      'state db backfill is running at /tmp/.codex; waiting up to 30s before retrying startup initialization\nError: timed out waiting for state db backfill at /tmp/.codex after 30s (status: running)\n',
    ],
    [
      'SQLite state runtime initialization',
      'Error: failed to initialize sqlite state runtime under /tmp/.codex: failed to initialize state runtime at /tmp/.codex\n',
    ],
  ])(
    'stops %s retries after the last client is released',
    async (_scenario, startupError) => {
      jest.useFakeTimers({ doNotFake: ['setImmediate'] });
      const firstProc = new MockChildProcess();
      spawnMock.mockReset().mockReturnValue(firstProc);
      const client = createClient();

      try {
        const turnPromise = client.startTurn({
          text: 'hello',
          cwd: '/tmp/repo',
          model: 'gpt-6-sol',
          thinkingLevel: 'high',
          planMode: false,
        });
        void turnPromise.catch(() => {});

        await flush();
        expect(spawnMock).toHaveBeenCalledTimes(1);
        firstProc.stderr.write(startupError);
        await flush();
        firstProc.emit('exit', 1, null);
        await flush();

        expect(spawnMock).toHaveBeenCalledTimes(1);
        client.dispose();
        await jest.advanceTimersByTimeAsync(5_000);
        await flush();

        expect(spawnMock).toHaveBeenCalledTimes(1);
        await expect(turnPromise).rejects.toThrow('Codex app-server exited');
      } finally {
        client.dispose();
        jest.useRealTimers();
      }
    },
  );

  it('cancels ownerless app-server startup by default', async () => {
    const connection = new CodexAppServerConnection('default');

    await expect(connection.ensureInitialized()).rejects.toThrow(
      'Codex app-server startup cancelled',
    );
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('allows explicitly ownerless one-shot app-server startup', async () => {
    const connection = new CodexAppServerConnection(
      'marketplace-one-shot',
      { CANOPY_TEST_PROFILE: 'marketplace-one-shot' },
      undefined,
      { allowOwnerlessStartup: true },
    );

    const initializePromise = connection.ensureInitialized();
    await flush();

    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(collectClientMessages(proc)).toEqual([
      expect.objectContaining({ id: 1, method: 'initialize' }),
    ]);

    emitServerMessage(proc, {
      id: 1,
      result: { userAgent: 'ua', codexHome: '/tmp/.codex' },
    });
    await expect(initializePromise).resolves.toBeUndefined();

    await connection.terminateForFinalRelease();
  });

  it('can start an isolated app-server without Canopy-managed secrets', async () => {
    const connection = new CodexAppServerConnection(
      'safe-discovery',
      undefined,
      undefined,
      {
        allowOwnerlessStartup: true,
        includeCanopySecrets: false,
      },
    );

    const initializePromise = connection.ensureInitialized();
    await flush();

    expect(getEnhancedEnv).toHaveBeenCalledWith({
      environment: false,
      includeCanopySecrets: false,
    });
    emitServerMessage(proc, {
      id: 1,
      result: { userAgent: 'ua', codexHome: '/tmp/.codex' },
    });
    await expect(initializePromise).resolves.toBeUndefined();

    await connection.terminateForFinalRelease();
  });

  it('routes interleaved notifications to the owning pooled client', async () => {
    const eventsA: unknown[] = [];
    const eventsB: unknown[] = [];
    const clientA = createClient(eventsA);
    const clientB = new CodexAppServerClient({
      cwd: '/tmp/repo',
      projectId: 'project',
      worktreeId: 'worktree',
      chatId: 'chat-b',
      sessionKey: 'project/worktree/chat-b',
      onEvent: (event): void => {
        eventsB.push(event);
      },
      getWindow: (): null => null,
    });

    const turnA = await startActiveTurn(clientA, proc);
    const turnBPromise = clientB.startTurn({
      text: 'B',
      cwd: '/tmp/repo',
      model: 'gpt-6-sol',
      thinkingLevel: 'high',
      planMode: false,
    });
    await flush();
    emitServerMessage(proc, { id: 4, result: makeThreadResult('thread-b') });
    await flush();
    emitServerMessage(proc, {
      id: 5,
      result: {
        turn: { id: 'turn-b', items: [], status: 'inProgress', error: null },
      },
    });
    await flush();

    emitServerMessage(proc, {
      method: 'item/agentMessage/delta',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        itemId: 'msg-a',
        delta: 'Message A',
      },
    });
    emitServerMessage(proc, {
      method: 'item/agentMessage/delta',
      params: {
        threadId: 'thread-b',
        turnId: 'turn-b',
        itemId: 'msg-b',
        delta: 'Message B',
      },
    });
    completeRootTurn(proc);
    emitServerMessage(proc, {
      method: 'turn/completed',
      params: {
        threadId: 'thread-b',
        turn: { id: 'turn-b', items: [], status: 'completed', error: null },
      },
    });

    await expect(turnA.turnPromise).resolves.toMatchObject({
      status: 'completed',
    });
    await expect(turnBPromise).resolves.toMatchObject({ status: 'completed' });
    expect(
      eventsA.some((event): boolean => {
        if (!isRecord(event) || !isRecord(event.event)) {
          return false;
        }
        return (
          event.event.type === 'item.completed' &&
          event.event.thread_id === 'thread-1'
        );
      }),
    ).toBe(true);
    expect(
      eventsB.some((event): boolean => {
        if (!isRecord(event) || !isRecord(event.event)) {
          return false;
        }
        return (
          event.event.type === 'item.completed' &&
          event.event.thread_id === 'thread-b'
        );
      }),
    ).toBe(true);
  });

  it('uses separate app-server processes for different env pool keys', async () => {
    const firstProc = new MockChildProcess();
    const secondProc = new MockChildProcess();
    secondProc.pid = 4243;
    spawnMock.mockReset();
    spawnMock.mockReturnValueOnce(firstProc).mockReturnValueOnce(secondProc);

    const clientA = new CodexAppServerClient({
      cwd: '/tmp/repo',
      projectId: 'project',
      worktreeId: 'worktree',
      chatId: 'chat-a',
      sessionKey: 'project/worktree/chat-a',
      onEvent: jest.fn(),
      getWindow: (): null => null,
      extraEnv: { CANOPY_TEST_PROFILE: 'profile-a' },
    });
    const clientB = new CodexAppServerClient({
      cwd: '/tmp/repo',
      projectId: 'project',
      worktreeId: 'worktree',
      chatId: 'chat-b',
      sessionKey: 'project/worktree/chat-b',
      onEvent: jest.fn(),
      getWindow: (): null => null,
      extraEnv: { CANOPY_TEST_PROFILE: 'profile-b' },
    });

    const accountA = clientA.readAccount(false);
    const accountB = clientB.readAccount(false);
    void accountA.catch(() => {});
    void accountB.catch(() => {});
    await flush();

    expect(spawnMock).toHaveBeenCalledTimes(2);
    clientA.dispose();
    clientB.dispose();
    await expect(accountA).rejects.toThrow('session_destroyed');
    await expect(accountB).rejects.toThrow('session_destroyed');
  });

  it('does not continue thread setup after disposal during shared initialization', async () => {
    const eventsA: unknown[] = [];
    const clientA = createClient(eventsA);
    const clientB = new CodexAppServerClient({
      cwd: '/tmp/repo',
      projectId: 'project',
      worktreeId: 'worktree',
      chatId: 'chat-b',
      sessionKey: 'project/worktree/chat-b',
      onEvent: jest.fn(),
      getWindow: (): null => null,
    });

    const turnPromise = clientA.startTurn({
      text: 'Run',
      cwd: '/tmp/repo',
      model: 'gpt-6-sol',
      thinkingLevel: 'high',
      planMode: false,
    });
    void turnPromise.catch(() => {});

    await flush();
    const initializeMessages = collectClientMessages(proc);
    expect(initializeMessages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 1, method: 'initialize' }),
      ]),
    );

    clientA.dispose();
    emitServerMessage(proc, {
      id: 1,
      result: { userAgent: 'ua', codexHome: '/tmp/.codex' },
    });
    await flush();

    const messagesAfterDispose = collectClientMessages(proc);
    expect(messagesAfterDispose).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ method: 'thread/start' }),
      ]),
    );
    expect(messagesAfterDispose).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ method: 'plugin/list' }),
      ]),
    );
    expect(eventsA).toEqual([]);
    await expect(turnPromise).rejects.toThrow('session_destroyed');

    clientB.dispose();
  });

  it('reports one resource snapshot for multiple default-pool clients', async () => {
    const clientA = createClient();
    const clientB = new CodexAppServerClient({
      cwd: '/tmp/repo',
      projectId: 'project',
      worktreeId: 'worktree',
      chatId: 'chat-b',
      sessionKey: 'project/worktree/chat-b',
      onEvent: jest.fn(),
      getWindow: (): null => null,
    });

    const accountPromise = clientA.readAccount(false);
    void accountPromise.catch(() => {});
    await flush();

    const snapshots = getCodexAppServerPoolResourceSnapshots();
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]?.poolKey).toMatch(/^profile:[a-f0-9]{64}$/);
    expect(snapshots[0]?.poolKeyLabel).toMatch(/^Profile [a-f0-9]{8}$/);
    expect(snapshots[0]).toMatchObject({
      pooled: true,
      pid: 4242,
      clientCount: 2,
      activeTurnCount: 0,
    });

    clientA.dispose();
    clientB.dispose();
    await expect(accountPromise).rejects.toThrow('session_destroyed');
  });

  it.each([false, true])(
    'hands an idle thread to a replacement without disturbing another owner (profile changed: %s)',
    async (changedProfile) => {
      const client = createClient();
      const other = createClient();
      const { turnPromise } = await startActiveTurn(client, proc);
      completeRootTurn(proc);
      await turnPromise;
      collectClientMessages(proc);
      const otherTurn = other.startTurn({
        text: 'Keep working independently',
        cwd: '/tmp/repo',
        model: 'gpt-6-sol',
        thinkingLevel: 'high',
        planMode: false,
      });
      void otherTurn.catch(() => undefined);
      const otherThreadRequest = await waitForClientRequest(
        proc,
        'thread/start',
      );
      emitServerMessage(proc, {
        id: otherThreadRequest.id,
        result: makeThreadResult('thread-other'),
      });
      const otherTurnRequest = await waitForClientRequest(proc, 'turn/start');
      emitServerMessage(proc, {
        id: otherTurnRequest.id,
        result: {
          turn: {
            id: 'other-turn',
            status: 'inProgress',
            items: [],
            error: null,
          },
        },
      });
      await flush();
      client.dispose();
      const unsubscribe = collectClientMessages(proc).find(
        (message) => message.method === 'thread/unsubscribe',
      );
      if (unsubscribe) {
        emitServerMessage(proc, {
          id: unsubscribe.id,
          result: { status: 'unsubscribed' },
        });
        await flush();
      }

      const replacementProc = changedProfile ? new MockChildProcess() : proc;
      if (changedProfile) spawnMock.mockReturnValue(replacementProc);
      const events: unknown[] = [];
      const replacement = new CodexAppServerClient({
        cwd: '/tmp/repo',
        projectId: 'project',
        worktreeId: 'worktree',
        chatId: 'chat',
        sessionKey: 'project/worktree/chat',
        initialThreadId: 'thread-1',
        onEvent: (event) => {
          events.push(event);
        },
        getWindow: (): null => null,
        ...(changedProfile
          ? { extraEnv: { CANOPY_TEST_PROFILE: 'replacement' } }
          : {}),
        fallbackSeedItems: [
          {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'Retained context' }],
          },
        ],
      });
      const pending = replacement.startTurn({
        text: 'Continue',
        cwd: '/tmp/repo',
        model: 'gpt-6-sol',
        thinkingLevel: 'high',
        planMode: false,
      });
      void pending.catch(() => undefined);
      try {
        if (changedProfile) {
          const initialize = await waitForClientRequest(
            replacementProc,
            'initialize',
          );
          emitServerMessage(replacementProc, {
            id: initialize.id,
            result: { userAgent: 'ua', codexHome: '/tmp/.codex' },
          });
        }
        if (changedProfile) {
          // The old worker still holds the idle thread's writer, and another
          // owner's turn keeps that worker busy, so it is not stopped: the
          // resume is refused and the thread is rebuilt from history.
          const resume = await waitForClientRequest(
            replacementProc,
            'thread/resume',
          );
          emitServerMessage(replacementProc, {
            id: resume.id,
            error: {
              code: -32600,
              message: 'thread thread-1 already has an active writer',
            },
          });
        }
        const thread = await waitForClientRequest(
          replacementProc,
          changedProfile ? 'thread/start' : 'thread/resume',
        );
        expect(thread?.method).toBe(
          changedProfile ? 'thread/start' : 'thread/resume',
        );
        if (!thread) throw new Error('Missing thread request');
        const targetId = changedProfile ? 'thread-migrated' : 'thread-1';
        emitServerMessage(replacementProc, {
          id: thread.id,
          result: makeThreadResult(targetId),
        });
        if (changedProfile) {
          const inject = await waitForClientRequest(
            replacementProc,
            'thread/inject_items',
          );
          expect(JSON.stringify(getRequestParams(inject).items)).toContain(
            'Retained context',
          );
          expect(JSON.stringify(getRequestParams(inject).items)).not.toContain(
            'Continue',
          );
          emitServerMessage(replacementProc, { id: inject.id, result: {} });
        }
        const turn = await waitForClientRequest(replacementProc, 'turn/start');
        expect(getRequestParams(turn).threadId).toBe(targetId);
        expect(events).toContainEqual(
          expect.objectContaining({
            type: 'system',
            subtype: 'init',
            session_id: targetId,
          }),
        );
        expect(proc.killed).toBe(false);
        expect(other.hasActiveTurn()).toBe(true);
        expect(
          collectClientMessages(proc).some(
            (request) => request.method === 'turn/interrupt',
          ),
        ).toBe(false);
      } finally {
        replacement.dispose();
        other.dispose();
        await pending.catch(() => undefined);
        await otherTurn.catch(() => undefined);
      }
    },
  );

  it('stops an idle old worker and resumes the same thread after a profile change', async () => {
    const client = createClient();
    const keepAlive = createClient();
    const { turnPromise } = await startActiveTurn(client, proc);
    completeRootTurn(proc);
    await turnPromise;
    client.dispose();
    const unsubscribe = await waitForClientRequest(proc, 'thread/unsubscribe');
    emitServerMessage(proc, {
      id: unsubscribe.id,
      result: { status: 'unsubscribed' },
    });
    await flush();

    const replacementProc = new MockChildProcess();
    spawnMock.mockReturnValue(replacementProc);
    const replacement = new CodexAppServerClient({
      cwd: '/tmp/repo',
      projectId: 'project',
      worktreeId: 'worktree',
      chatId: 'chat',
      sessionKey: 'project/worktree/chat',
      initialThreadId: 'thread-1',
      onEvent: jest.fn(),
      getWindow: (): null => null,
      extraEnv: { CANOPY_TEST_PROFILE: 'replacement' },
    });
    const pending = replacement.startTurn({
      text: 'Continue',
      cwd: '/tmp/repo',
      model: 'gpt-6-sol',
      thinkingLevel: 'high',
      planMode: false,
    });
    try {
      const initialize = await waitForClientRequest(
        replacementProc,
        'initialize',
      );
      emitServerMessage(replacementProc, {
        id: initialize.id,
        result: { userAgent: 'ua', codexHome: '/tmp/.codex' },
      });
      const sent: Array<Record<string, unknown>> = [];
      const resume = await waitForClientRequestRecording(
        replacementProc,
        'thread/resume',
        sent,
      );
      emitServerMessage(replacementProc, {
        id: resume.id,
        error: {
          code: -32600,
          message: 'thread thread-1 already has an active writer',
        },
      });
      const retried = await waitForClientRequestRecording(
        replacementProc,
        'thread/resume',
        sent,
      );
      expect(proc.kill).toHaveBeenCalledWith('SIGTERM');
      emitServerMessage(replacementProc, {
        id: retried.id,
        result: makeThreadResult('thread-1'),
      });
      const turn = await waitForClientRequestRecording(
        replacementProc,
        'turn/start',
        sent,
      );
      expect(getRequestParams(turn).threadId).toBe('thread-1');
      expect(sent.map((message) => message.method)).not.toContain(
        'thread/start',
      );
    } finally {
      replacement.dispose();
      keepAlive.dispose();
      await pending.catch(() => undefined);
    }
  });

  it('unsubscribes an idle disposed thread while the shared pool remains alive', async () => {
    const clientA = createClient();
    const clientB = new CodexAppServerClient({
      cwd: '/tmp/repo',
      projectId: 'project',
      worktreeId: 'worktree',
      chatId: 'chat-b',
      sessionKey: 'project/worktree/chat-b',
      onEvent: jest.fn(),
      getWindow: (): null => null,
    });

    const { turnPromise } = await startActiveTurn(clientA, proc);
    completeRootTurn(proc);
    await expect(turnPromise).resolves.toMatchObject({ status: 'completed' });
    collectClientMessages(proc);

    clientA.dispose();
    await flush();

    expect(collectClientMessages(proc)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          method: 'thread/unsubscribe',
          params: { threadId: 'thread-1' },
        }),
      ]),
    );
    expect(proc.killed).toBe(false);
    expect(getCodexAppServerPoolResourceSnapshots()[0]).toEqual(
      expect.objectContaining({
        activeTurnCount: 0,
        clientCount: 1,
        pid: 4242,
      }),
    );

    clientB.dispose();
  });

  it('still suspends the shared pool after an idle owner unsubscribes', async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate'] });
    try {
      updateCodexAppServerPoolIdleTimeoutMinutes(10);
      const clientA = createClient();
      const clientB = new CodexAppServerClient({
        cwd: '/tmp/repo',
        projectId: 'project',
        worktreeId: 'worktree',
        chatId: 'chat-b',
        sessionKey: 'project/worktree/chat-b',
        onEvent: jest.fn(),
        getWindow: (): null => null,
      });

      const { turnPromise } = await startActiveTurn(clientA, proc);
      completeRootTurn(proc);
      await expect(turnPromise).resolves.toMatchObject({ status: 'completed' });
      collectClientMessages(proc);

      clientA.dispose();
      const unsubscribeRequest = await waitForClientRequest(
        proc,
        'thread/unsubscribe',
      );
      emitServerMessage(proc, { id: unsubscribeRequest.id, result: {} });
      await flush();

      jest.advanceTimersByTime(599_999);
      expect(proc.killed).toBe(false);

      jest.advanceTimersByTime(1);
      expect(proc.killed).toBe(true);
      expect(getCodexAppServerPoolResourceSnapshots()[0]).toEqual(
        expect.objectContaining({
          activeTurnCount: 0,
          clientCount: 1,
          initialized: false,
          pid: undefined,
        }),
      );

      clientB.dispose();
    } finally {
      jest.useRealTimers();
    }
  });

  it('does not restart a shared process when an idle owner is interrupted while a peer turn is active', async () => {
    const idleClient = createClient();
    const activeClient = new CodexAppServerClient({
      cwd: '/tmp/repo',
      projectId: 'project',
      worktreeId: 'worktree',
      chatId: 'chat-b',
      sessionKey: 'project/worktree/chat-b',
      onEvent: jest.fn(),
      getWindow: (): null => null,
    });

    const { turnPromise } = await startActiveTurn(activeClient, proc);

    await idleClient.interruptTurn();

    expect(proc.kill).not.toHaveBeenCalled();
    expect(getCodexAppServerPoolResourceSnapshots()[0]).toEqual(
      expect.objectContaining({
        activeTurnCount: 1,
        clientCount: 2,
        pid: 4242,
      }),
    );

    completeRootTurn(proc);
    await expect(turnPromise).resolves.toMatchObject({ status: 'completed' });

    idleClient.dispose();
    activeClient.dispose();
  });

  it('unsubscribes an active disposed thread after interrupt in a shared pool', async () => {
    const clientA = createClient();
    const clientB = new CodexAppServerClient({
      cwd: '/tmp/repo',
      projectId: 'project',
      worktreeId: 'worktree',
      chatId: 'chat-b',
      sessionKey: 'project/worktree/chat-b',
      onEvent: jest.fn(),
      getWindow: (): null => null,
    });

    const { turnPromise } = await startActiveTurn(clientA, proc);
    collectClientMessages(proc);

    clientA.dispose();
    await expect(turnPromise).rejects.toThrow('session_destroyed');
    const interruptMessages = collectClientMessages(proc);
    const interruptRequest = interruptMessages.find(
      (message): boolean => message.method === 'turn/interrupt',
    );
    if (!interruptRequest) {
      throw new Error('Expected turn/interrupt request');
    }
    emitServerMessage(proc, { id: interruptRequest.id, result: {} });
    await flush();

    expect(collectClientMessages(proc)).not.toContainEqual(
      expect.objectContaining({ method: 'thread/unsubscribe' }),
    );

    emitServerMessage(proc, {
      method: 'turn/completed',
      params: {
        threadId: 'thread-1',
        turn: { id: 'turn-1', status: 'interrupted' },
      },
    });
    await flush();

    expect(collectClientMessages(proc)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          method: 'thread/unsubscribe',
          params: { threadId: 'thread-1' },
        }),
      ]),
    );
    expect(proc.killed).toBe(false);

    clientB.dispose();
  });

  it('updates resource snapshots as active turns start and finish', async () => {
    const client = createClient();
    const { turnPromise } = await startActiveTurn(client, proc);

    expect(getCodexAppServerPoolResourceSnapshots()[0]).toEqual(
      expect.objectContaining({
        activeTurnCount: 1,
        clientCount: 1,
      }),
    );

    completeRootTurn(proc);
    await expect(turnPromise).resolves.toMatchObject({ status: 'completed' });
    expect(getCodexAppServerPoolResourceSnapshots()[0]).toEqual(
      expect.objectContaining({
        activeTurnCount: 0,
        clientCount: 1,
      }),
    );

    client.dispose();
  });

  it('suspends each idle pool connection once for memory pressure', async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate'] });
    const firstProc = new MockChildProcess();
    const secondProc = new MockChildProcess();
    secondProc.pid = 4243;
    spawnMock.mockReset();
    spawnMock.mockReturnValueOnce(firstProc).mockReturnValueOnce(secondProc);

    try {
      const defaultClient = createClient();
      const envClient = new CodexAppServerClient({
        cwd: '/tmp/repo',
        projectId: 'project',
        worktreeId: 'worktree',
        chatId: 'chat-env',
        sessionKey: 'project/worktree/chat-env',
        onEvent: jest.fn(),
        getWindow: (): null => null,
        extraEnv: { CANOPY_TEST_ENV: '1' },
      });

      const defaultTurn = await startActiveTurn(defaultClient, firstProc);
      completeRootTurn(firstProc);
      await expect(defaultTurn.turnPromise).resolves.toMatchObject({
        status: 'completed',
      });

      const envTurn = await startActiveTurn(envClient, secondProc);
      completeRootTurn(secondProc);
      await expect(envTurn.turnPromise).resolves.toMatchObject({
        status: 'completed',
      });

      await jest.advanceTimersByTimeAsync(120_000);
      expect(suspendIdleCodexAppServerPoolConnectionsForMemoryPressure()).toBe(
        2,
      );
      expect(suspendIdleCodexAppServerPoolConnectionsForMemoryPressure()).toBe(
        0,
      );
      expect(firstProc.killed).toBe(true);
      expect(secondProc.killed).toBe(true);
      for (const snapshot of getCodexAppServerPoolResourceSnapshots()) {
        expect(snapshot.pid).toBeUndefined();
        expect(snapshot.initialized).toBe(false);
      }

      defaultClient.dispose();
      envClient.dispose();
    } finally {
      jest.useRealTimers();
    }
  });

  it('applies a pool-level idle timeout to connections created after the update', async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate'] });
    try {
      // Simulates the startup preference seeding: the update happens before
      // any connection exists, and must still govern connections created
      // later (each connection would otherwise run on the built-in default).
      updateCodexAppServerPoolIdleTimeoutMinutes(2);

      const client = createClient();
      const turn = await startActiveTurn(client, proc);
      completeRootTurn(proc);
      await expect(turn.turnPromise).resolves.toMatchObject({
        status: 'completed',
      });

      jest.advanceTimersByTime(60_000);
      expect(proc.killed).toBe(false);
      jest.advanceTimersByTime(61_000);
      expect(proc.killed).toBe(true);

      client.dispose();
    } finally {
      jest.useRealTimers();
    }
  });

  it('returns false when suspending before a process starts', () => {
    const client = new CodexAppServerClient({
      cwd: '/tmp/repo',
      projectId: 'project',
      worktreeId: 'worktree',
      chatId: 'chat',
      sessionKey: 'project/worktree/chat',
      onEvent: jest.fn(),
      getWindow: (): null => null,
    });

    expect(client.suspendIdleProcess()).toBe(false);
  });

  it('returns false when suspending while a turn is active', async () => {
    const client = new CodexAppServerClient({
      cwd: '/tmp/repo',
      projectId: 'project',
      worktreeId: 'worktree',
      chatId: 'chat',
      sessionKey: 'project/worktree/chat',
      onEvent: jest.fn(),
      getWindow: (): null => null,
    });

    const turnPromise = client.startTurn({
      text: 'Keep running',
      cwd: '/tmp/repo',
      model: 'gpt-6-sol',
      thinkingLevel: 'high',
      planMode: false,
    });

    await flush();
    emitServerMessage(proc, {
      id: 1,
      result: { userAgent: 'ua', codexHome: '/tmp/.codex' },
    });
    await flush();
    emitServerMessage(proc, { id: 2, result: makeThreadResult('thread-1') });
    await flush();
    emitServerMessage(proc, {
      id: 3,
      result: {
        turn: { id: 'turn-1', items: [], status: 'inProgress', error: null },
      },
    });
    await flush();

    expect(client.suspendIdleProcess()).toBe(false);

    emitServerMessage(proc, {
      method: 'turn/completed',
      params: {
        threadId: 'thread-1',
        turn: {
          id: 'turn-1',
          items: [
            {
              type: 'reasoning',
              id: 'reason-1',
              summary: [],
              content: [],
            },
          ],
          status: 'completed',
          error: null,
        },
      },
    });

    await expect(turnPromise).resolves.toMatchObject({ status: 'completed' });
  });

  it('returns false when a JSON-RPC request is pending', async () => {
    const client = new CodexAppServerClient({
      cwd: '/tmp/repo',
      projectId: 'project',
      worktreeId: 'worktree',
      chatId: 'chat',
      sessionKey: 'project/worktree/chat',
      onEvent: jest.fn(),
      getWindow: (): null => null,
    });

    const accountPromise = client.readAccount(false);

    await flush();
    expect(client.suspendIdleProcess()).toBe(false);

    emitServerMessage(proc, {
      id: 1,
      result: { userAgent: 'ua', codexHome: '/tmp/.codex' },
    });
    await flush();
    emitServerMessage(proc, {
      id: 2,
      result: {
        account: { type: 'apiKey' },
        requiresOpenaiAuth: false,
      },
    });

    await expect(accountPromise).resolves.toEqual({
      account: { type: 'apiKey' },
      requiresOpenaiAuth: false,
      workspaceRouting: null,
    });
  });

  it('returns false after dispose closes the session', async () => {
    const client = new CodexAppServerClient({
      cwd: '/tmp/repo',
      projectId: 'project',
      worktreeId: 'worktree',
      chatId: 'chat',
      sessionKey: 'project/worktree/chat',
      onEvent: jest.fn(),
      getWindow: (): null => null,
    });

    const accountPromise = client.readAccount(false);
    await flush();
    client.dispose();

    await expect(accountPromise).rejects.toThrow('session_destroyed');
    expect(client.suspendIdleProcess()).toBe(false);
  });

  it('preserves the source thread across suspension and a late fork notification', async () => {
    const firstProc = new MockChildProcess();
    const secondProc = new MockChildProcess();
    spawnMock.mockReset();
    spawnMock.mockReturnValueOnce(firstProc).mockReturnValueOnce(secondProc);
    proc = firstProc;

    const client = new CodexAppServerClient({
      cwd: '/tmp/repo',
      projectId: 'project',
      worktreeId: 'worktree',
      chatId: 'chat',
      sessionKey: 'project/worktree/chat',
      onEvent: jest.fn(),
      getWindow: (): null => null,
      initialThreadId: 'thread-1',
      extraEnv: {
        CANOPY_TEST_PROFILE: 'capability-fixture',
      },
    });

    const firstTurnPromise = client.startTurn({
      text: 'First turn',
      cwd: '/tmp/repo',
      model: 'gpt-6-sol',
      thinkingLevel: 'high',
      planMode: false,
    });

    await flush();
    emitServerMessage(firstProc, {
      id: 1,
      result: { userAgent: 'ua', codexHome: '/tmp/.codex' },
    });
    await flush();
    emitServerMessage(firstProc, {
      id: 2,
      result: makeThreadResult('thread-1'),
    });
    await flush();
    emitServerMessage(firstProc, {
      id: 3,
      result: {
        turn: { id: 'turn-1', items: [], status: 'inProgress', error: null },
      },
    });
    emitServerMessage(firstProc, {
      method: 'turn/completed',
      params: {
        threadId: 'thread-1',
        turn: { id: 'turn-1', items: [], status: 'completed', error: null },
      },
    });
    await expect(firstTurnPromise).resolves.toMatchObject({
      status: 'completed',
    });

    firstProc.stderr.write('diagnostic tail');
    expect(client.suspendIdleProcess()).toBe(true);
    expect(getCodexAppServerPoolResourceSnapshots()[0]).toEqual(
      expect.objectContaining({
        pid: undefined,
        clientCount: 1,
        activeTurnCount: 0,
      }),
    );
    expect(firstProc.kill).toHaveBeenCalledWith('SIGTERM');
    expect(client).toHaveProperty('threadReady', false);
    expect(client).toHaveProperty('threadId', 'thread-1');
    expect(client).toHaveProperty('initialThreadId', 'thread-1');

    // Regression: a one-shot fork used to share this connection. If its
    // thread.started notification arrived after the fork client disposed, the
    // pool's sole-owner fallback delivered it here. Because suspension made
    // threadReady false, the source client then adopted the forked thread and
    // sent its next turn to the forked chat.
    void client.handleConnectionNotification('thread/started', {
      params: {
        thread: {
          id: 'thread-forked',
          source: { custom: 'fork' },
        },
      },
    });
    expect(client).toHaveProperty('threadReady', false);
    expect(client).toHaveProperty('threadId', 'thread-1');

    firstProc.stdout.emit('close');
    firstProc.emit('error', new Error('late error after suspend'));
    firstProc.emit('exit', 1, null);

    const secondTurnPromise = client.startTurn({
      text: 'Second turn',
      cwd: '/tmp/repo',
      model: 'gpt-6-sol',
      thinkingLevel: 'high',
      planMode: false,
    });

    await flush();
    emitServerMessage(secondProc, {
      id: 4,
      result: { userAgent: 'ua', codexHome: '/tmp/.codex' },
    });
    await flush();

    const messages = collectClientMessages(secondProc);
    expect(messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 5, method: 'thread/resume' }),
      ]),
    );
    const resumeMessage = messages.find(
      (message): boolean => message.method === 'thread/resume',
    );
    expect(resumeMessage?.params).toEqual(
      expect.objectContaining({ threadId: 'thread-1' }),
    );
    expect(messages).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ method: 'thread/start' }),
      ]),
    );

    emitServerMessage(secondProc, {
      id: 5,
      result: makeThreadResult('thread-1'),
    });
    await flush();
    emitServerMessage(secondProc, {
      id: 6,
      result: {
        turn: { id: 'turn-2', items: [], status: 'inProgress', error: null },
      },
    });
    emitServerMessage(secondProc, {
      method: 'turn/completed',
      params: {
        threadId: 'thread-1',
        turn: { id: 'turn-2', items: [], status: 'completed', error: null },
      },
    });

    await expect(secondTurnPromise).resolves.toMatchObject({
      status: 'completed',
    });
    expect(getCodexAppServerPoolResourceSnapshots()[0]).toEqual(
      expect.objectContaining({
        pid: secondProc.pid,
        clientCount: 1,
        activeTurnCount: 0,
      }),
    );
  });

  it('clears pending server requests after process failure so restarted idle sessions can suspend', async () => {
    const firstProc = new MockChildProcess();
    const secondProc = new MockChildProcess();
    spawnMock.mockReset();
    spawnMock.mockReturnValueOnce(firstProc).mockReturnValueOnce(secondProc);

    createPendingRequestMock.mockReturnValue(new Promise(() => {}));

    const win: SendableBrowserWindow = {
      isDestroyed: (): boolean => false,
      webContents: {
        isCrashed: (): boolean => false,
        isDestroyed: (): boolean => false,
        mainFrame: {
          detached: false,
          isDestroyed: (): boolean => false,
        },
        send: jest.fn(),
      },
    };

    const client = new CodexAppServerClient({
      cwd: '/tmp/repo',
      projectId: 'project',
      worktreeId: 'worktree',
      chatId: 'chat',
      sessionKey: 'project/worktree/chat',
      onEvent: jest.fn(),
      getWindow: (): SendableBrowserWindow => win,
    });

    const firstTurnPromise = client.startTurn({
      text: 'Ask before crashing',
      cwd: '/tmp/repo',
      model: 'gpt-6-sol',
      thinkingLevel: 'high',
      planMode: false,
    });
    void firstTurnPromise.catch(() => {});

    await flush();
    emitServerMessage(firstProc, {
      id: 1,
      result: { userAgent: 'ua', codexHome: '/tmp/.codex' },
    });
    await flush();
    emitServerMessage(firstProc, {
      id: 2,
      result: makeThreadResult('thread-1'),
    });
    await flush();
    emitServerMessage(firstProc, {
      id: 3,
      result: {
        turn: { id: 'turn-1', items: [], status: 'inProgress', error: null },
      },
    });
    emitServerMessage(firstProc, {
      id: 'server-req-1',
      method: 'item/tool/requestUserInput',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        itemId: 'item-1',
        questions: [
          {
            id: 'q1',
            header: 'Choice',
            question: 'Pick one',
            isOther: false,
            isSecret: false,
            options: [{ label: 'Option A', description: 'First option' }],
          },
        ],
      },
    });
    await flush();

    firstProc.emit('exit', 1, null);
    await expect(firstTurnPromise).rejects.toThrow('Codex app-server exited');

    const secondTurnPromise = client.startTurn({
      text: 'Continue after restart',
      cwd: '/tmp/repo',
      model: 'gpt-6-sol',
      thinkingLevel: 'high',
      planMode: false,
    });

    await flush();
    emitServerMessage(secondProc, {
      id: 4,
      result: { userAgent: 'ua', codexHome: '/tmp/.codex' },
    });
    await flush();
    emitServerMessage(secondProc, {
      id: 5,
      result: makeThreadResult('thread-1'),
    });
    await flush();
    emitServerMessage(secondProc, {
      id: 6,
      result: {
        turn: { id: 'turn-2', items: [], status: 'inProgress', error: null },
      },
    });
    emitServerMessage(secondProc, {
      method: 'turn/completed',
      params: {
        threadId: 'thread-1',
        turn: { id: 'turn-2', items: [], status: 'completed', error: null },
      },
    });

    await expect(secondTurnPromise).resolves.toMatchObject({
      status: 'completed',
    });
    expect(client.suspendIdleProcess()).toBe(true);
  });

  describe('approval requests (Task 7)', () => {
    /**
     * Spins up a client wired with the given fake approval handle, drives it
     * through the initialize / thread-start / turn-start handshake so
     * `thread-1` is registered as owned by this client, and drains the
     * handshake frames so later assertions only see approval-request traffic.
     */
    async function startClientTurnForApproval(
      approvalSession: ApprovalSessionHandle,
      getWindow: () => SendableBrowserWindow | null = (): null => null,
      options: {
        planMode?: boolean;
        approvalMode?: 'ask' | 'auto' | 'full-access';
      } = {},
    ): Promise<CodexAppServerClient> {
      const client = new CodexAppServerClient({
        cwd: '/tmp/repo',
        projectId: 'project',
        worktreeId: 'worktree',
        chatId: 'chat',
        sessionKey: 'project/worktree/chat',
        onEvent: jest.fn(),
        getWindow,
        approvalSession,
        approvalMode: options.approvalMode,
      });

      const turnPromise = client.startTurn({
        text: 'Do something',
        cwd: '/tmp/repo',
        model: 'gpt-6-sol',
        thinkingLevel: 'high',
        planMode: options.planMode ?? false,
      });
      void turnPromise.catch(() => {});

      await flush();
      const initializeRequest = collectClientMessages(proc).find(
        (message) => message.method === 'initialize',
      );
      if (initializeRequest?.id === undefined) {
        throw new Error('Expected initialize request');
      }
      emitServerMessage(proc, {
        id: initializeRequest.id,
        result: { userAgent: 'ua', codexHome: '/tmp/.codex' },
      });
      await flush();
      const threadRequest = collectClientMessages(proc).find(
        (message) =>
          message.method === 'thread/start' ||
          message.method === 'thread/resume',
      );
      if (threadRequest?.id === undefined) {
        throw new Error('Expected thread start or resume request');
      }
      emitServerMessage(proc, {
        id: threadRequest.id,
        result: makeThreadResult('thread-1'),
      });
      await flush();
      const turnRequest = collectClientMessages(proc).find(
        (message) => message.method === 'turn/start',
      );
      if (turnRequest?.id === undefined) {
        throw new Error('Expected turn start request');
      }
      if (options.planMode) {
        const fullAccess = options.approvalMode === 'full-access';
        expect(getRequestParams(threadRequest).sandbox).toBe(
          fullAccess ? 'danger-full-access' : 'read-only',
        );
        expect(getRequestParams(turnRequest).sandboxPolicy).toEqual(
          fullAccess
            ? { type: 'dangerFullAccess' }
            : { type: 'readOnly', networkAccess: false },
        );
        expect(getRequestParams(turnRequest).collaborationMode).toMatchObject({
          mode: 'plan',
        });
      }
      emitServerMessage(proc, {
        id: turnRequest.id,
        result: {
          turn: { id: 'turn-1', items: [], status: 'inProgress', error: null },
        },
      });
      await flush();
      collectClientMessages(proc); // drain the handshake frames

      return client;
    }

    it('uses the originating approval method response when a session is disposed', async () => {
      const approvalSession: ApprovalSessionHandle = {
        check: jest.fn(() => new Promise(() => {})),
        setMode: jest.fn(),
        reevaluatePendingApprovals: jest.fn<Promise<void>, []>(() =>
          Promise.resolve(),
        ),
        dispose: jest.fn(),
      };
      const client = await startClientTurnForApproval(approvalSession);
      const peer = createClient();

      emitServerMessage(proc, {
        id: 'approval-disposed-permissions',
        method: 'item/permissions/requestApproval',
        params: {
          threadId: 'thread-1',
          turnId: 'turn-1',
          itemId: 'permissions-disposed',
          permissions: { network: { enabled: true } },
        },
      });
      await flush();

      client.dispose();
      await flush();

      expect(collectClientMessages(proc)).toContainEqual({
        id: 'approval-disposed-permissions',
        result: { permissions: {}, scope: 'turn' },
      });
      peer.dispose();
    });

    it('(a) accepts a command execution approval on a session-rule allow, without a renderer prompt', async () => {
      const approvalSession = createFakeApprovalSession({ decision: 'allow' });
      await startClientTurnForApproval(approvalSession);

      emitServerMessage(proc, {
        id: 'approval-1',
        method: 'item/commandExecution/requestApproval',
        params: {
          kind: 'command',
          threadId: 'thread-1',
          turnId: 'turn-1',
          itemId: 'item-1',
          startedAtMs: Date.now(),
          command: 'npm test',
          cwd: '/tmp/repo',
        },
      });
      await flush();

      expect(approvalSession.check).toHaveBeenCalledWith(
        { kind: 'command', command: 'npm test', cwd: '/tmp/repo' },
        expect.objectContaining({
          title: expect.any(String),
          toolUseId: 'codex-item-1',
        }),
      );
      // A session-rule allow resolves entirely inside `approvalSession.check`
      // (mocked here), so it never reaches the renderer ask-user bridge.
      expect(collectClientMessages(proc)).toContainEqual({
        id: 'approval-1',
        result: { decision: 'accept' },
      });
    });

    it('routes writeStdin approvals through a callback-specific non-command check', async () => {
      const approvalSession = createFakeApprovalSession({ decision: 'allow' });
      await startClientTurnForApproval(approvalSession);

      emitServerMessage(proc, {
        id: 'approval-write-stdin',
        method: 'item/commandExecution/requestApproval',
        params: {
          kind: 'writeStdin',
          threadId: 'thread-1',
          turnId: 'turn-1',
          itemId: 'terminal-item',
          approvalId: 'stdin-callback-1',
          command: 'npm test',
          cwd: '/tmp/repo',
          reason: 'Send input to the running test watcher',
        },
      });
      await flush();

      expect(approvalSession.check).toHaveBeenCalledTimes(1);
      expect(approvalSession.check).toHaveBeenCalledWith(
        {
          kind: 'tool',
          toolName: 'codex:write-stdin:stdin-callback-1',
        },
        {
          title: 'Terminal input approval',
          details: {
            kind: 'tool',
            toolName: 'Terminal input',
            inputSummary: 'Send input to the running test watcher',
          },
          toolUseId: 'codex-stdin-callback-1',
          signal: expect.any(AbortSignal),
        },
      );
      expect(collectClientMessages(proc)).toContainEqual({
        id: 'approval-write-stdin',
        result: { decision: 'accept' },
      });
    });

    it('declines writeStdin approvals without their distinct callback id', async () => {
      const approvalSession = createFakeApprovalSession({ decision: 'allow' });
      await startClientTurnForApproval(approvalSession);

      emitServerMessage(proc, {
        id: 'approval-write-stdin-missing-id',
        method: 'item/commandExecution/requestApproval',
        params: {
          kind: 'writeStdin',
          threadId: 'thread-1',
          turnId: 'turn-1',
          itemId: 'terminal-item',
          command: 'npm test',
        },
      });
      await flush();

      expect(approvalSession.check).not.toHaveBeenCalled();
      expect(collectClientMessages(proc)).toContainEqual({
        id: 'approval-write-stdin-missing-id',
        result: { decision: 'decline' },
      });
    });

    it('(b) declines a command execution approval on an engine deny', async () => {
      const approvalSession = createFakeApprovalSession({ decision: 'deny' });
      await startClientTurnForApproval(approvalSession);

      emitServerMessage(proc, {
        id: 'approval-2',
        method: 'item/commandExecution/requestApproval',
        params: {
          threadId: 'thread-1',
          turnId: 'turn-1',
          itemId: 'item-2',
          command: 'rm -rf /tmp/scratch',
        },
      });
      await flush();

      expect(collectClientMessages(proc)).toContainEqual({
        id: 'approval-2',
        result: { decision: 'decline' },
      });
    });

    it('keeps a native safety denial closed when the provider response has no denial-text field', async () => {
      const message =
        'Blocked by a safety rule (force-push). This call cannot be approved from a prompt. Do not retry or repackage the blocked operation. Choose a safe alternative or explain the block to the user.';
      const approvalSession = createFakeApprovalSession({
        decision: 'deny',
        message,
      });
      await startClientTurnForApproval(approvalSession);
      emitServerMessage(proc, {
        id: 'native-safety-denial',
        method: 'item/commandExecution/requestApproval',
        params: {
          threadId: 'thread-1',
          turnId: 'turn-1',
          itemId: 'force-push',
          command: 'git push --force origin HEAD',
        },
      });
      await flush();
      expect(approvalSession.check).toHaveBeenCalledWith(
        { kind: 'command', command: 'git push --force origin HEAD' },
        expect.objectContaining({ toolUseId: 'codex-force-push' }),
      );
      // The pinned native response contains only a decision. Do not invent a
      // message field or replace a denial with a JSON-RPC error/extra user turn.
      expect(collectClientMessages(proc)).toContainEqual({
        id: 'native-safety-denial',
        result: { decision: 'decline' },
      });
    });

    it('invalidates pending approvals before deny-and-stop interrupts sibling requests', async () => {
      const check = jest.fn(() =>
        Promise.resolve({ decision: 'deny' as const, stopTurn: true }),
      );
      const invalidatePending = jest.fn();
      const approvalSession: ApprovalSessionHandle = {
        check,
        setMode: jest.fn(),
        reevaluatePendingApprovals: jest.fn<Promise<void>, []>(() =>
          Promise.resolve(),
        ),
        invalidatePending,
        dispose: jest.fn(),
      };
      await startClientTurnForApproval(approvalSession);

      emitServerMessage(proc, {
        id: 'approval-stop',
        method: 'item/commandExecution/requestApproval',
        params: {
          threadId: 'thread-1',
          turnId: 'turn-1',
          itemId: 'item-stop',
          command: 'rm -rf /tmp/scratch',
        },
      });
      await flush();

      const stopMessages = collectClientMessages(proc);
      expect(stopMessages).toContainEqual({
        id: 'approval-stop',
        result: { decision: 'decline' },
      });
      expect(invalidatePending).toHaveBeenCalledTimes(1);
      const interruptRequest = stopMessages.find(
        (message) => message.method === 'turn/interrupt',
      );
      expect(interruptRequest).toEqual(
        expect.objectContaining({
          params: { threadId: 'thread-1', turnId: 'turn-1' },
        }),
      );

      emitServerMessage(proc, {
        id: 'approval-sibling',
        method: 'item/commandExecution/requestApproval',
        params: {
          threadId: 'thread-1',
          turnId: 'turn-1',
          itemId: 'item-sibling',
          command: 'npm test',
        },
      });
      await flush();

      expect(collectClientMessages(proc)).toContainEqual({
        id: 'approval-sibling',
        result: { decision: 'decline' },
      });
      expect(check).toHaveBeenCalledTimes(1);

      if (interruptRequest?.id !== undefined) {
        emitServerMessage(proc, { id: interruptRequest.id, result: {} });
      }
      emitServerMessage(proc, {
        method: 'turn/completed',
        params: {
          threadId: 'thread-1',
          turn: {
            id: 'turn-1',
            items: [],
            status: 'interrupted',
            error: null,
          },
        },
      });
      await flush();
    });

    it('evaluates every concrete v2 file-change path and correlates the prompt', async () => {
      const approvalSession = createFakeApprovalSession({ decision: 'allow' });
      await startClientTurnForApproval(approvalSession);

      emitServerMessage(proc, {
        method: 'item/started',
        params: {
          threadId: 'thread-1',
          turnId: 'turn-1',
          item: {
            type: 'fileChange',
            id: 'file-item-1',
            status: 'inProgress',
            changes: [
              {
                path: '/tmp/repo/src/a.ts',
                kind: {
                  type: 'update',
                  move_path: '/tmp/repo/protected/a.ts',
                },
              },
              { path: '/tmp/repo/.env', kind: { type: 'update' } },
            ],
          },
        },
      });
      emitServerMessage(proc, {
        id: 'approval-file-v2',
        method: 'item/fileChange/requestApproval',
        params: {
          threadId: 'thread-1',
          turnId: 'turn-1',
          itemId: 'file-item-1',
          grantRoot: '/tmp/repo',
          startedAtMs: Date.now(),
        },
      });
      await flush();

      expect(approvalSession.check).toHaveBeenNthCalledWith(
        1,
        { kind: 'file-write', path: '/tmp/repo/src/a.ts' },
        expect.objectContaining({ toolUseId: 'codex-file-item-1' }),
      );
      expect(approvalSession.check).toHaveBeenNthCalledWith(
        2,
        { kind: 'file-write', path: '/tmp/repo/protected/a.ts' },
        expect.objectContaining({ toolUseId: 'codex-file-item-1' }),
      );
      expect(approvalSession.check).toHaveBeenNthCalledWith(
        3,
        { kind: 'file-write', path: '/tmp/repo/.env' },
        expect.objectContaining({ toolUseId: 'codex-file-item-1' }),
      );
      expect(approvalSession.check).toHaveBeenNthCalledWith(
        4,
        { kind: 'file-write', path: '/tmp/repo', isGrant: true },
        expect.objectContaining({ toolUseId: 'codex-file-item-1' }),
      );
      expect(collectClientMessages(proc)).toContainEqual({
        id: 'approval-file-v2',
        result: { decision: 'accept' },
      });
    });

    it('evaluates the command and managed-network target together', async () => {
      const approvalSession = createFakeApprovalSession({ decision: 'allow' });
      await startClientTurnForApproval(approvalSession);

      emitServerMessage(proc, {
        id: 'approval-network',
        method: 'item/commandExecution/requestApproval',
        params: {
          threadId: 'thread-1',
          turnId: 'turn-1',
          itemId: 'item-network',
          command: 'curl https://api.example.com',
          networkApprovalContext: {
            host: 'api.example.com',
            protocol: 'https',
          },
        },
      });
      await flush();

      expect(approvalSession.check).toHaveBeenCalledTimes(2);
      expect(approvalSession.check).toHaveBeenNthCalledWith(
        1,
        { kind: 'command', command: 'curl https://api.example.com' },
        expect.objectContaining({
          suggestedTarget: {
            kind: 'command',
            pattern: 'curl https://api.example.com *',
          },
        }),
      );
      expect(approvalSession.check).toHaveBeenNthCalledWith(
        2,
        { kind: 'network', host: 'api.example.com' },
        expect.objectContaining({
          suggestedTarget: { kind: 'network', host: 'api.example.com' },
        }),
      );
      expect(collectClientMessages(proc)).toContainEqual({
        id: 'approval-network',
        result: { decision: 'accept' },
      });
    });

    it('does not create a wildcard command grant for network-only approvals', async () => {
      const approvalSession = createFakeApprovalSession({ decision: 'allow' });
      await startClientTurnForApproval(approvalSession);

      emitServerMessage(proc, {
        id: 'approval-network-only',
        method: 'item/commandExecution/requestApproval',
        params: {
          threadId: 'thread-1',
          turnId: 'turn-1',
          itemId: 'item-network-only',
          networkApprovalContext: {
            host: 'api.example.com',
            protocol: 'https',
          },
        },
      });
      await flush();

      expect(approvalSession.check).toHaveBeenCalledTimes(1);
      expect(approvalSession.check).toHaveBeenCalledWith(
        { kind: 'network', host: 'api.example.com' },
        expect.objectContaining({
          suggestedTarget: { kind: 'network', host: 'api.example.com' },
        }),
      );
      expect(collectClientMessages(proc)).toContainEqual({
        id: 'approval-network-only',
        result: { decision: 'accept' },
      });
    });

    it('declines command approvals with no command or permission context', async () => {
      const approvalSession = createFakeApprovalSession({ decision: 'allow' });
      await startClientTurnForApproval(approvalSession);

      emitServerMessage(proc, {
        id: 'approval-empty',
        method: 'item/commandExecution/requestApproval',
        params: {
          threadId: 'thread-1',
          turnId: 'turn-1',
          itemId: 'item-empty',
        },
      });
      await flush();

      expect(approvalSession.check).not.toHaveBeenCalled();
      expect(collectClientMessages(proc)).toContainEqual({
        id: 'approval-empty',
        result: { decision: 'decline' },
      });
    });

    it('requires every additional command permission overlay to pass', async () => {
      const approvalSession = createFakeApprovalSession({ decision: 'allow' });
      await startClientTurnForApproval(approvalSession);

      emitServerMessage(proc, {
        id: 'approval-overlays',
        method: 'item/commandExecution/requestApproval',
        params: {
          threadId: 'thread-1',
          turnId: 'turn-1',
          itemId: 'item-overlays',
          command: 'tool-with-extra-access',
          additionalPermissions: {
            network: { enabled: true },
            fileSystem: {
              read: ['/private/input'],
              write: ['/tmp/output'],
              entries: [],
            },
          },
        },
      });
      await flush();

      expect(approvalSession.check).toHaveBeenNthCalledWith(
        1,
        { kind: 'command', command: 'tool-with-extra-access' },
        expect.any(Object),
      );
      expect(approvalSession.check).toHaveBeenNthCalledWith(
        2,
        { kind: 'network', host: '*', isGrant: true },
        expect.any(Object),
      );
      expect(approvalSession.check).toHaveBeenNthCalledWith(
        3,
        { kind: 'tool', toolName: 'codex:filesystem-read:/private/input' },
        expect.any(Object),
      );
      expect(approvalSession.check).toHaveBeenNthCalledWith(
        4,
        { kind: 'file-write', path: '/tmp/output', isGrant: true },
        expect.any(Object),
      );
      expect(collectClientMessages(proc)).toContainEqual({
        id: 'approval-overlays',
        result: { decision: 'accept' },
      });
    });

    it('declines malformed command approval context instead of ignoring it', async () => {
      const approvalSession = createFakeApprovalSession({ decision: 'allow' });
      await startClientTurnForApproval(approvalSession);

      emitServerMessage(proc, {
        id: 'approval-malformed-overlay',
        method: 'item/commandExecution/requestApproval',
        params: {
          threadId: 'thread-1',
          turnId: 'turn-1',
          itemId: 'item-malformed-overlay',
          command: 'tool-with-extra-access',
          additionalPermissions: 'unparseable',
        },
      });
      await flush();

      expect(approvalSession.check).not.toHaveBeenCalled();
      expect(collectClientMessages(proc)).toContainEqual({
        id: 'approval-malformed-overlay',
        result: { decision: 'decline' },
      });
    });

    it('evaluates permission bundles without a generic remembered tool target', async () => {
      const approvalSession = createFakeApprovalSession({ decision: 'allow' });
      await startClientTurnForApproval(approvalSession);
      const permissions = {
        network: { enabled: true },
        fileSystem: {
          read: null,
          write: ['/tmp/output'],
          entries: [],
        },
      };

      emitServerMessage(proc, {
        id: 'approval-permissions',
        method: 'item/permissions/requestApproval',
        params: {
          threadId: 'thread-1',
          turnId: 'turn-1',
          itemId: 'item-permissions',
          permissions,
        },
      });
      await flush();

      expect(approvalSession.check).toHaveBeenNthCalledWith(
        1,
        { kind: 'network', host: '*', isGrant: true },
        expect.objectContaining({ toolUseId: 'codex-item-permissions' }),
      );
      expect(approvalSession.check).toHaveBeenNthCalledWith(
        2,
        { kind: 'file-write', path: '/tmp/output', isGrant: true },
        expect.objectContaining({ toolUseId: 'codex-item-permissions' }),
      );
      expect(approvalSession.check).not.toHaveBeenCalledWith(
        { kind: 'tool', toolName: 'request_permissions' },
        expect.anything(),
      );
      expect(collectClientMessages(proc)).toContainEqual({
        id: 'approval-permissions',
        result: { permissions, scope: 'turn' },
      });
    });

    it('denies malformed permission bundles instead of granting an empty bundle', async () => {
      const approvalSession = createFakeApprovalSession({ decision: 'allow' });
      await startClientTurnForApproval(approvalSession);

      emitServerMessage(proc, {
        id: 'approval-malformed-permissions',
        method: 'item/permissions/requestApproval',
        params: {
          threadId: 'thread-1',
          turnId: 'turn-1',
          itemId: 'item-malformed-permissions',
          permissions: 'unparseable',
        },
      });
      await flush();

      expect(approvalSession.check).not.toHaveBeenCalled();
      expect(collectClientMessages(proc)).toContainEqual({
        id: 'approval-malformed-permissions',
        result: { permissions: {}, scope: 'turn' },
      });
    });

    it.each([
      ['read', { read: '/private/input', write: [], entries: [] }],
      ['write', { read: [], write: '/tmp/output', entries: [] }],
      ['entries', { read: [], write: [], entries: { access: 'write' } }],
    ])('denies malformed nested %s permissions', async (_field, fileSystem) => {
      const approvalSession = createFakeApprovalSession({
        decision: 'allow',
      });
      await startClientTurnForApproval(approvalSession);

      emitServerMessage(proc, {
        id: `approval-malformed-${_field}`,
        method: 'item/permissions/requestApproval',
        params: {
          threadId: 'thread-1',
          turnId: 'turn-1',
          itemId: `item-malformed-${_field}`,
          permissions: {
            network: null,
            fileSystem,
          },
        },
      });
      await flush();

      expect(approvalSession.check).not.toHaveBeenCalled();
      expect(collectClientMessages(proc)).toContainEqual({
        id: `approval-malformed-${_field}`,
        result: { permissions: {}, scope: 'turn' },
      });
    });

    it('echoes only normalized fields from an approved permission grant', async () => {
      const approvalSession = createFakeApprovalSession({ decision: 'allow' });
      await startClientTurnForApproval(approvalSession);

      emitServerMessage(proc, {
        id: 'approval-normalized-permissions',
        method: 'item/permissions/requestApproval',
        params: {
          threadId: 'thread-1',
          turnId: 'turn-1',
          itemId: 'item-normalized-permissions',
          permissions: {
            network: { enabled: true, ignored: 'value' },
            fileSystem: {
              read: null,
              write: ['/tmp/output'],
              entries: [],
              ignored: 'value',
            },
            ignored: 'value',
          },
        },
      });
      await flush();

      expect(collectClientMessages(proc)).toContainEqual({
        id: 'approval-normalized-permissions',
        result: {
          permissions: {
            network: { enabled: true },
            fileSystem: {
              read: null,
              write: ['/tmp/output'],
              entries: [],
            },
          },
          scope: 'turn',
        },
      });
    });

    it('replies fail-closed decline when the approval check rejects instead of hanging the request', async () => {
      const approvalSession: ApprovalSessionHandle = {
        check: jest.fn(() =>
          Promise.reject(new Error('rules file unreadable')),
        ),
        setMode: jest.fn(),
        reevaluatePendingApprovals: jest.fn<Promise<void>, []>(() =>
          Promise.resolve(),
        ),
        dispose: jest.fn(),
      };
      await startClientTurnForApproval(approvalSession);

      emitServerMessage(proc, {
        id: 'approval-reject',
        method: 'item/commandExecution/requestApproval',
        params: {
          threadId: 'thread-1',
          turnId: 'turn-1',
          itemId: 'item-reject',
          command: 'npm test',
        },
      });
      await flush();

      expect(collectClientMessages(proc)).toContainEqual({
        id: 'approval-reject',
        result: { decision: 'decline' },
      });
    });

    it('(c) denies a legacy execCommandApproval on an engine deny', async () => {
      const approvalSession = createFakeApprovalSession({ decision: 'deny' });
      await startClientTurnForApproval(approvalSession);

      emitServerMessage(proc, {
        id: 'approval-3',
        method: 'execCommandApproval',
        params: {
          // Legacy params carry the thread under `conversationId`, not
          // `threadId` — exercises the pool's fallback lookup.
          conversationId: 'thread-1',
          callId: 'call-1',
          approvalId: null,
          command: ['npm', 'test'],
          cwd: '/tmp/repo',
          reason: null,
          parsedCmd: [],
        },
      });
      await flush();

      expect(approvalSession.check).toHaveBeenCalledWith(
        { kind: 'command', command: 'npm test', cwd: '/tmp/repo' },
        expect.objectContaining({
          title: 'Codex wants to run a command',
          suggestedTarget: { kind: 'command', pattern: 'npm test' },
        }),
      );
      expect(collectClientMessages(proc)).toContainEqual({
        id: 'approval-3',
        result: { decision: 'denied' },
      });
    });

    it('preserves argv boundaries in legacy exec approval identities', async () => {
      const approvalSession = createFakeApprovalSession({ decision: 'allow' });
      await startClientTurnForApproval(approvalSession);

      emitServerMessage(proc, {
        id: 'approval-argv-spaced-argument',
        method: 'execCommandApproval',
        params: {
          conversationId: 'thread-1',
          command: ['printf', 'a b'],
        },
      });
      await flush();
      emitServerMessage(proc, {
        id: 'approval-argv-spaced-executable',
        method: 'execCommandApproval',
        params: {
          conversationId: 'thread-1',
          command: ['printf a', 'b'],
        },
      });
      await flush();

      expect(approvalSession.check).toHaveBeenNthCalledWith(
        1,
        { kind: 'command', command: "printf 'a b'" },
        expect.objectContaining({
          suggestedTarget: { kind: 'command', pattern: "printf 'a b'" },
        }),
      );
      expect(approvalSession.check).toHaveBeenNthCalledWith(
        2,
        { kind: 'command', command: "'printf a' b" },
        expect.objectContaining({
          suggestedTarget: { kind: 'command', pattern: "'printf a' b" },
        }),
      );
    });

    it.each([
      ['ask', 'allow', 'accept'],
      ['ask', 'deny', 'decline'],
      ['auto', 'allow', 'accept'],
      ['auto', 'deny', 'decline'],
      ['full-access', 'allow', 'accept'],
    ] as const)(
      'honors %s policy %s decisions in plan mode',
      async (approvalMode, decision, response) => {
        const approvalSession = createFakeApprovalSession({ decision });
        await startClientTurnForApproval(approvalSession, (): null => null, {
          planMode: true,
          approvalMode,
        });

        emitServerMessage(proc, {
          id: 'approval-plan-command',
          method: 'item/commandExecution/requestApproval',
          params: {
            threadId: 'thread-1',
            turnId: 'turn-1',
            itemId: 'plan-command',
            command: 'touch planned-change.txt',
            cwd: '/tmp/repo',
          },
        });
        await flush();

        expect(approvalSession.check).toHaveBeenCalledWith(
          expect.objectContaining({
            kind: 'command',
            command: 'touch planned-change.txt',
          }),
          expect.any(Object),
        );
        expect(collectClientMessages(proc)).toContainEqual({
          id: 'approval-plan-command',
          result: { decision: response },
        });
      },
    );

    it('denies an empty legacy exec command without creating an approval prompt', async () => {
      const approvalSession = createFakeApprovalSession({ decision: 'allow' });
      await startClientTurnForApproval(approvalSession);

      emitServerMessage(proc, {
        id: 'approval-empty-command',
        method: 'execCommandApproval',
        params: {
          conversationId: 'thread-1',
          callId: 'call-empty',
          command: [' ', ''],
        },
      });
      await flush();

      expect(approvalSession.check).not.toHaveBeenCalled();
      expect(collectClientMessages(proc)).toContainEqual({
        id: 'approval-empty-command',
        result: { decision: 'denied' },
      });
    });

    it('evaluates every legacy patch path', async () => {
      const approvalSession = createFakeApprovalSession({ decision: 'allow' });
      await startClientTurnForApproval(approvalSession);

      emitServerMessage(proc, {
        id: 'approval-legacy-patch',
        method: 'applyPatchApproval',
        params: {
          conversationId: 'thread-1',
          callId: 'legacy-patch-1',
          fileChanges: {
            '/tmp/repo/src/a.ts': { type: 'add', content: 'a' },
            '/tmp/repo/.env': { type: 'delete', content: 'secret' },
          },
          reason: null,
          grantRoot: '/tmp/repo',
        },
      });
      await flush();

      expect(approvalSession.check).toHaveBeenNthCalledWith(
        1,
        { kind: 'file-write', path: '/tmp/repo/src/a.ts' },
        expect.objectContaining({ toolUseId: 'legacy-patch-1' }),
      );
      expect(approvalSession.check).toHaveBeenNthCalledWith(
        2,
        { kind: 'file-write', path: '/tmp/repo/.env' },
        expect.objectContaining({ toolUseId: 'legacy-patch-1' }),
      );
      expect(approvalSession.check).toHaveBeenNthCalledWith(
        3,
        { kind: 'file-write', path: '/tmp/repo', isGrant: true },
        expect.objectContaining({ toolUseId: 'legacy-patch-1' }),
      );
      expect(collectClientMessages(proc)).toContainEqual({
        id: 'approval-legacy-patch',
        result: { decision: 'approved' },
      });
    });

    it('routes request_user_input MCP approvals through the policy engine', async () => {
      const approvalSession = createFakeApprovalSession({ decision: 'allow' });
      await startClientTurnForApproval(approvalSession);

      emitServerMessage(proc, {
        method: 'item/started',
        params: {
          threadId: 'thread-1',
          turnId: 'turn-1',
          item: {
            type: 'mcpToolCall',
            id: 'mcp-call-1',
            server: 'github',
            tool: 'delete_issue',
            status: 'inProgress',
            arguments: {},
          },
        },
      });
      emitServerMessage(proc, {
        id: 'approval-mcp-fallback',
        method: 'item/tool/requestUserInput',
        params: {
          threadId: 'thread-1',
          turnId: 'turn-1',
          itemId: 'mcp-call-1',
          questions: [
            {
              id: 'mcp_tool_call_approval_mcp-call-1',
              header: 'Approve app tool call?',
              question: 'Allow GitHub to run tool "delete_issue"?',
              isOther: false,
              isSecret: false,
              options: [
                { label: 'Allow', description: 'Run the tool.' },
                { label: 'Cancel', description: 'Cancel the tool.' },
              ],
            },
          ],
        },
      });
      await flush();

      expect(approvalSession.check).toHaveBeenCalledWith(
        { kind: 'mcp', server: 'github', tool: 'delete_issue' },
        expect.objectContaining({ toolUseId: 'codex-mcp-call-1' }),
      );
      expect(collectClientMessages(proc)).toContainEqual({
        id: 'approval-mcp-fallback',
        result: {
          answers: {
            'mcp_tool_call_approval_mcp-call-1': {
              answers: ['Allow'],
            },
          },
        },
      });
    });

    it('(d) accepts an MCP tool-call approval elicitation on an engine allow', async () => {
      const approvalSession = createFakeApprovalSession({ decision: 'allow' });
      await startClientTurnForApproval(approvalSession);

      emitServerMessage(proc, {
        method: 'item/started',
        params: {
          threadId: 'thread-1',
          turnId: 'turn-1',
          item: {
            type: 'mcpToolCall',
            id: 'mcp-call-d',
            server: 'github',
            tool: 'create_issue',
            status: 'inProgress',
            arguments: { title: 'Bug' },
            result: null,
            error: null,
          },
        },
      });
      emitServerMessage(proc, {
        id: 'approval-4',
        method: 'mcpServer/elicitation/request',
        params: {
          threadId: 'thread-1',
          turnId: 'turn-1',
          serverName: 'github',
          mode: 'form',
          _meta: {
            codex_approval_kind: 'mcp_tool_call',
            codex_mcp_tool_call_id: 'mcp-call-d',
            tool_name: 'create_issue',
            tool_title: 'create_issue',
            tool_params_display: 'title: "Bug"',
          },
          message: 'Allow create_issue?',
          requestedSchema: {},
        },
      });
      await flush();

      expect(approvalSession.check).toHaveBeenCalledWith(
        { kind: 'mcp', server: 'github', tool: 'create_issue' },

        expect.objectContaining({ title: expect.any(String) }),
      );
      expect(collectClientMessages(proc)).toContainEqual({
        id: 'approval-4',
        result: { action: 'accept', content: null, _meta: null },
      });
    });

    it('keeps interactive MCP approvals pending beyond 30 seconds', async () => {
      const approvalSession: ApprovalSessionHandle = {
        check: jest.fn(() => new Promise(() => {})),
        setMode: jest.fn(),
        reevaluatePendingApprovals: jest.fn<Promise<void>, []>(() =>
          Promise.resolve(),
        ),
        dispose: jest.fn(),
      };
      const client = await startClientTurnForApproval(approvalSession);
      const peer = createClient();

      emitServerMessage(proc, {
        method: 'item/started',
        params: {
          threadId: 'thread-1',
          turnId: 'turn-1',
          item: {
            type: 'mcpToolCall',
            id: 'mcp-call-pending',
            server: 'github',
            tool: 'create_issue',
            status: 'inProgress',
            arguments: {},
            result: null,
            error: null,
          },
        },
      });
      emitServerMessage(proc, {
        id: 'approval-mcp-pending',
        method: 'mcpServer/elicitation/request',
        params: {
          threadId: 'thread-1',
          turnId: 'turn-1',
          serverName: 'github',
          mode: 'form',
          _meta: {
            codex_approval_kind: 'mcp_tool_call',
            codex_mcp_tool_call_id: 'mcp-call-pending',
            tool_name: 'create_issue',
          },
          message: 'Allow create_issue?',
          requestedSchema: {},
        },
      });
      await flush();

      jest.useFakeTimers();
      try {
        jest.advanceTimersByTime(31_000);
        await Promise.resolve();
        expect(
          collectClientMessages(proc).some(
            (message) => message.id === 'approval-mcp-pending',
          ),
        ).toBe(false);
      } finally {
        jest.useRealTimers();
      }

      client.dispose();
      await flush();
      expect(collectClientMessages(proc)).toContainEqual({
        id: 'approval-mcp-pending',
        result: { action: 'decline', content: null, _meta: null },
      });
      peer.dispose();
    });

    it.each([false, true])(
      '(d2) keys MCP approval by canonical tool name rather than display title (plan mode %s)',
      async (planMode) => {
        const approvalSession = createFakeApprovalSession({
          decision: 'allow',
        });
        await startClientTurnForApproval(approvalSession, () => null, {
          planMode,
          approvalMode: 'ask',
        });

        emitServerMessage(proc, {
          method: 'item/started',
          params: {
            threadId: 'thread-1',
            turnId: 'turn-1',
            item: {
              type: 'mcpToolCall',
              id: 'mcp-call-d2',
              server: 'github',
              tool: 'issues.create',
              status: 'inProgress',
              arguments: {},
              result: null,
              error: null,
            },
          },
        });
        emitServerMessage(proc, {
          id: 'approval-canonical-tool',
          method: 'mcpServer/elicitation/request',
          params: {
            threadId: 'thread-1',
            turnId: 'turn-1',
            serverName: 'github',
            mode: 'form',
            _meta: {
              codex_approval_kind: 'mcp_tool_call',
              codex_mcp_tool_call_id: 'mcp-call-d2',
              tool_name: 'issues.create',
              tool_title: 'Create item',
            },
            message: 'Allow Create item?',
            requestedSchema: {},
          },
        });
        await flush();

        expect(approvalSession.check).toHaveBeenCalledWith(
          { kind: 'mcp', server: 'github', tool: 'issues.create' },
          expect.objectContaining({
            title: 'Codex wants to use Create item',
            suggestedTarget: {
              kind: 'mcp',
              server: 'github',
              tool: 'issues.create',
            },
          }),
        );
      },
    );

    it('(d3) declines MCP approval when canonical tool identity is missing', async () => {
      const approvalSession = createFakeApprovalSession({ decision: 'allow' });
      await startClientTurnForApproval(approvalSession);

      emitServerMessage(proc, {
        id: 'approval-missing-tool',
        method: 'mcpServer/elicitation/request',
        params: {
          threadId: 'thread-1',
          turnId: 'turn-1',
          serverName: 'github',
          mode: 'form',
          _meta: {
            codex_approval_kind: 'mcp_tool_call',
            tool_title: 'Shared title',
          },
          message: 'Allow Shared title?',
          requestedSchema: {},
        },
      });
      await flush();

      expect(approvalSession.check).not.toHaveBeenCalled();
      expect(collectClientMessages(proc)).toContainEqual({
        id: 'approval-missing-tool',
        result: { action: 'decline', content: null, _meta: null },
      });
    });

    it('(e) declines a genuine url-mode elicitation without consulting the approval engine', async () => {
      const approvalSession = createFakeApprovalSession({ decision: 'allow' });
      await startClientTurnForApproval(approvalSession);

      emitServerMessage(proc, {
        id: 'approval-5',
        method: 'mcpServer/elicitation/request',
        params: {
          threadId: 'thread-1',
          turnId: 'turn-1',
          serverName: 'github',
          mode: 'url',
          _meta: null,
          message: 'Open this URL to continue',
          url: 'https://example.com/auth',
          elicitationId: 'elicit-1',
        },
      });
      await flush();

      expect(approvalSession.check).not.toHaveBeenCalled();
      expect(collectClientMessages(proc)).toContainEqual({
        id: 'approval-5',
        result: { action: 'decline', content: null, _meta: null },
      });
    });

    it('(e2) bridges a genuine form-mode elicitation without codex_approval_kind to the ask-user UI and accepts the renderer answer', async () => {
      // Every pre-existing `mode: 'form'` test in this suite also sets
      // `_meta.codex_approval_kind: 'mcp_tool_call'`, which is what masked
      // this routing gap: a genuine elicitation from the MCP tool itself
      // carries no `codex_approval_kind` at all.
      createPendingRequestMock.mockResolvedValue([
        {
          questionId: 'repository',
          question: 'Repository',
          selectedOptions: [],
          freeformText: 'canopy',
        },
        {
          questionId: 'retries',
          question: 'Retries',
          selectedOptions: [],
          freeformText: '3',
        },
        {
          questionId: 'private',
          question: 'Private',
          selectedOptions: ['Yes'],
        },
        {
          questionId: 'strategy',
          question: 'Strategy',
          selectedOptions: ['fast'],
        },
      ]);
      const win: SendableBrowserWindow = {
        isDestroyed: (): boolean => false,
        webContents: {
          isCrashed: (): boolean => false,
          isDestroyed: (): boolean => false,
          mainFrame: {
            detached: false,
            isDestroyed: (): boolean => false,
          },
          send: jest.fn(),
        },
      };
      const approvalSession = createFakeApprovalSession({ decision: 'allow' });
      await startClientTurnForApproval(
        approvalSession,
        (): SendableBrowserWindow => win,
      );

      emitServerMessage(proc, {
        id: 'approval-elicit-form',
        method: 'mcpServer/elicitation/request',
        params: {
          threadId: 'thread-1',
          turnId: 'turn-1',
          serverName: 'github',
          mode: 'form',
          _meta: null,
          message: 'Configure the repository.',
          requestedSchema: {
            type: 'object',
            properties: {
              repository: {
                type: 'string',
                title: 'Repository',
                minLength: 1,
              },
              retries: {
                type: 'integer',
                title: 'Retries',
                minimum: 0,
              },
              private: { type: 'boolean', title: 'Private' },
              strategy: {
                type: 'string',
                title: 'Strategy',
                enum: ['fast', 'safe'],
              },
            },
            required: ['repository', 'retries', 'private', 'strategy'],
          },
        },
      });
      await flush();

      // The policy engine is never consulted for a genuine elicitation —
      // only the ask-user bridge is.
      expect(approvalSession.check).not.toHaveBeenCalled();
      expect(collectClientMessages(proc)).toContainEqual({
        id: 'approval-elicit-form',
        result: {
          action: 'accept',
          content: {
            repository: 'canopy',
            retries: 3,
            private: true,
            strategy: 'fast',
          },
          _meta: null,
        },
      });
    });

    it('(e2b) declines form schemas the ask-user UI cannot represent', async () => {
      const approvalSession = createFakeApprovalSession({ decision: 'allow' });
      await startClientTurnForApproval(approvalSession);

      emitServerMessage(proc, {
        id: 'approval-elicit-form-unsupported',
        method: 'mcpServer/elicitation/request',
        params: {
          threadId: 'thread-1',
          turnId: 'turn-1',
          serverName: 'github',
          mode: 'form',
          _meta: null,
          message: 'Configure nested data.',
          requestedSchema: {
            type: 'object',
            properties: {
              nested: { type: 'object', properties: {} },
            },
            required: ['nested'],
          },
        },
      });
      await flush();

      expect(createPendingRequestMock).not.toHaveBeenCalled();
      expect(collectClientMessages(proc)).toContainEqual({
        id: 'approval-elicit-form-unsupported',
        result: { action: 'decline', content: null, _meta: null },
      });
    });

    it('(e2c) declines a renderer answer that arrives after turn cancellation', async () => {
      let resolveAnswers!: (
        answers: Array<{
          questionId: string;
          question: string;
          selectedOptions: string[];
          freeformText: string;
        }>,
      ) => void;
      createPendingRequestMock.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveAnswers = resolve;
          }),
      );
      const win: SendableBrowserWindow = {
        isDestroyed: (): boolean => false,
        webContents: {
          isCrashed: (): boolean => false,
          isDestroyed: (): boolean => false,
          mainFrame: {
            detached: false,
            isDestroyed: (): boolean => false,
          },
          send: jest.fn(),
        },
      };
      const approvalSession = createFakeApprovalSession({ decision: 'allow' });
      const client = await startClientTurnForApproval(
        approvalSession,
        (): SendableBrowserWindow => win,
      );

      emitServerMessage(proc, {
        id: 'approval-elicit-cancelled',
        method: 'mcpServer/elicitation/request',
        params: {
          threadId: 'thread-1',
          turnId: 'turn-1',
          serverName: 'github',
          mode: 'form',
          _meta: null,
          message: 'What repository should I use?',
          requestedSchema: {
            type: 'object',
            properties: {
              repository: { type: 'string', title: 'Repository' },
            },
            required: ['repository'],
          },
        },
      });
      await flush();

      const interruptPromise = client.interruptTurn();
      await flush();
      const interruptRequest = collectClientMessages(proc).find(
        (message) => message.method === 'turn/interrupt',
      );
      if (interruptRequest?.id === undefined) {
        throw new Error('Expected turn/interrupt request');
      }
      emitServerMessage(proc, { id: interruptRequest.id, result: {} });
      emitServerMessage(proc, {
        method: 'turn/completed',
        params: {
          threadId: 'thread-1',
          turn: {
            id: 'turn-1',
            items: [],
            status: 'interrupted',
            error: null,
          },
        },
      });
      await interruptPromise;
      expect(rejectAllForSessionMock).toHaveBeenCalledWith(
        'project/worktree/chat',
      );

      resolveAnswers([
        {
          questionId: 'repository',
          question: 'Repository',
          selectedOptions: [],
          freeformText: 'canopy',
        },
      ]);
      await flush();

      expect(collectClientMessages(proc)).toContainEqual({
        id: 'approval-elicit-cancelled',
        result: { action: 'decline', content: null, _meta: null },
      });
    });

    it('declines a genuine form elicitation that arrives after turn cancellation', async () => {
      const win: SendableBrowserWindow = {
        isDestroyed: (): boolean => false,
        webContents: {
          isCrashed: (): boolean => false,
          isDestroyed: (): boolean => false,
          mainFrame: {
            detached: false,
            isDestroyed: (): boolean => false,
          },
          send: jest.fn(),
        },
      };
      const approvalSession = createFakeApprovalSession({ decision: 'allow' });
      const client = await startClientTurnForApproval(
        approvalSession,
        (): SendableBrowserWindow => win,
      );

      const interruptPromise = client.interruptTurn();
      await flush();
      const interruptRequest = collectClientMessages(proc).find(
        (message) => message.method === 'turn/interrupt',
      );
      if (interruptRequest?.id === undefined) {
        throw new Error('Expected turn/interrupt request');
      }
      emitServerMessage(proc, { id: interruptRequest.id, result: {} });
      emitServerMessage(proc, {
        method: 'turn/completed',
        params: {
          threadId: 'thread-1',
          turn: {
            id: 'turn-1',
            items: [],
            status: 'interrupted',
            error: null,
          },
        },
      });
      await interruptPromise;
      collectClientMessages(proc);

      emitServerMessage(proc, {
        id: 'approval-elicit-after-cancel',
        method: 'mcpServer/elicitation/request',
        params: {
          threadId: 'thread-1',
          turnId: 'turn-1',
          serverName: 'github',
          mode: 'form',
          _meta: null,
          message: 'What repository should I use?',
          requestedSchema: {
            type: 'object',
            properties: {
              repository: { type: 'string', title: 'Repository' },
            },
            required: ['repository'],
          },
        },
      });
      await flush();

      expect(createPendingRequestMock).not.toHaveBeenCalled();
      expect(collectClientMessages(proc)).toContainEqual({
        id: 'approval-elicit-after-cancel',
        result: { action: 'decline', content: null, _meta: null },
      });
    });

    it('(e3) fails closed and declines a genuine form-mode elicitation when the ask-user bridge has no renderer to answer it', async () => {
      // No `getWindow` override — `startClientTurnForApproval` defaults to a
      // client with no renderer window, the same shape as a non-interactive
      // owner (e.g. a one-shot helper client with no approvalSession bridge).
      // `requestAnswersFromRenderer` throws when delivery fails, and the
      // form branch must turn that into a decline rather than an unhandled
      // rejection or a hang.
      const approvalSession = createFakeApprovalSession({ decision: 'allow' });
      await startClientTurnForApproval(approvalSession);

      emitServerMessage(proc, {
        id: 'approval-elicit-form-no-window',
        method: 'mcpServer/elicitation/request',
        params: {
          threadId: 'thread-1',
          turnId: 'turn-1',
          serverName: 'github',
          mode: 'form',
          _meta: null,
          message: 'What repository should I use?',
          requestedSchema: {
            type: 'object',
            properties: {
              repository: { type: 'string', title: 'Repository' },
            },
            required: ['repository'],
          },
        },
      });
      await flush();

      expect(approvalSession.check).not.toHaveBeenCalled();
      expect(collectClientMessages(proc)).toContainEqual({
        id: 'approval-elicit-form-no-window',
        result: { action: 'decline', content: null, _meta: null },
      });
    });

    it('(f) fails closed with deny-shaped responses when no owner is registered for the thread', async () => {
      const connection = new CodexAppServerConnection('default');
      const handleApprovalRequestMock = jest.fn(async () => {});
      const owner = createConnectionOwner({
        handleApprovalRequest: handleApprovalRequestMock,
      });
      connection.registerOwner(owner, {});
      // Intentionally do not register a root thread, so
      // resolveOwnerForThread returns null for every approval request below.
      const initializePromise = connection.ensureInitialized();
      await flush();
      emitServerMessage(proc, { id: 1, result: { userAgent: 'ua' } });
      await initializePromise;
      collectClientMessages(proc); // drain the initialize frame

      emitServerMessage(proc, {
        id: 'approval-6',
        method: 'item/commandExecution/requestApproval',
        params: { threadId: 'unknown-thread', command: 'npm test' },
      });
      await flush();
      emitServerMessage(proc, {
        id: 'approval-7',
        method: 'execCommandApproval',
        params: { conversationId: 'unknown-thread', command: ['npm', 'test'] },
      });
      await flush();

      expect(handleApprovalRequestMock).not.toHaveBeenCalled();
      const messages = collectClientMessages(proc);
      expect(messages).toContainEqual({
        id: 'approval-6',
        result: { decision: 'decline' },
      });
      expect(messages).toContainEqual({
        id: 'approval-7',
        result: { decision: 'denied' },
      });
    });

    it('(f2) declines a genuine elicitation with no deny-shaped error when no owner is registered for the thread', async () => {
      const connection = new CodexAppServerConnection('default');
      const handleApprovalRequestMock = jest.fn(async () => {});
      const owner = createConnectionOwner({
        handleApprovalRequest: handleApprovalRequestMock,
      });
      connection.registerOwner(owner, {});
      // Intentionally do not register a root thread, so
      // resolveOwnerForThread returns null for this genuine elicitation too.
      const initializePromise = connection.ensureInitialized();
      await flush();
      emitServerMessage(proc, { id: 1, result: { userAgent: 'ua' } });
      await initializePromise;
      collectClientMessages(proc); // drain the initialize frame

      emitServerMessage(proc, {
        id: 'approval-elicit-no-owner',
        method: 'mcpServer/elicitation/request',
        params: {
          threadId: 'unknown-thread',
          serverName: 'github',
          mode: 'form',
          _meta: null,
          message: 'What repository should I use?',
          requestedSchema: {},
        },
      });
      await flush();

      expect(handleApprovalRequestMock).not.toHaveBeenCalled();
      expect(collectClientMessages(proc)).toContainEqual({
        id: 'approval-elicit-no-owner',
        result: { action: 'decline', content: null, _meta: null },
      });
    });

    it('(g) attributes a command execution approval on a subagent thread with subagentId', async () => {
      const approvalSession = createFakeApprovalSession({ decision: 'allow' });
      await startClientTurnForApproval(approvalSession);

      // Register `sub-thread-1` as a subagent thread of this same owner the
      // way production does: a `thread/started` notification carrying a
      // `source.subAgent` marker (see "forwards subagent thread started
      // events without replacing the root thread id" above).
      emitServerMessage(proc, {
        method: 'thread/started',
        params: {
          thread: {
            id: 'sub-thread-1',
            preview: '',
            ephemeral: false,
            modelProvider: 'openai',
            createdAt: 1,
            updatedAt: 1,
            status: { type: 'idle' },
            path: null,
            cwd: '/tmp/repo',
            cliVersion: '0.114.0',
            source: {
              subAgent: {
                parentThreadId: 'thread-1',
                agentToolCallId: 'agent-call-1',
              },
            },
            agentNickname: 'Scout',
            agentRole: 'explorer',
            gitInfo: null,
            name: null,
            turns: [],
          },
        },
      });
      await flush();

      emitServerMessage(proc, {
        id: 'approval-subagent',
        method: 'item/commandExecution/requestApproval',
        params: {
          threadId: 'sub-thread-1',
          turnId: 'sub-turn-1',
          itemId: 'item-subagent',
          command: 'npm test',
          cwd: '/tmp/repo',
        },
      });
      await flush();

      expect(approvalSession.check).toHaveBeenCalledWith(
        { kind: 'command', command: 'npm test', cwd: '/tmp/repo' },
        expect.objectContaining({ subagentId: 'sub-thread-1' }),
      );
      // Routes to the same owner (this client) despite the non-root thread —
      // the reply lands on the same mock stdout as every other approval.
      expect(collectClientMessages(proc)).toContainEqual({
        id: 'approval-subagent',
        result: { decision: 'accept' },
      });
    });

    it('(h) carries no subagentId for a root-thread approval request', async () => {
      const approvalSession = createFakeApprovalSession({ decision: 'allow' });
      await startClientTurnForApproval(approvalSession);

      emitServerMessage(proc, {
        id: 'approval-root',
        method: 'item/commandExecution/requestApproval',
        params: {
          threadId: 'thread-1',
          turnId: 'turn-1',
          itemId: 'item-root',
          command: 'npm test',
          cwd: '/tmp/repo',
        },
      });
      await flush();

      expect(approvalSession.check).toHaveBeenCalledTimes(1);
      const [, display] = approvalSession.check.mock.calls[0];
      expect(display.subagentId).toBeUndefined();
      expect(collectClientMessages(proc)).toContainEqual({
        id: 'approval-root',
        result: { decision: 'accept' },
      });
    });

    it('(i) attributes a file-change approval on a subagent thread with subagentId', async () => {
      const approvalSession = createFakeApprovalSession({ decision: 'allow' });
      await startClientTurnForApproval(approvalSession);

      // Same subagent-thread registration as (g), reused here for a
      // different approval method to prove subagent attribution is not
      // command-execution-specific.
      emitServerMessage(proc, {
        method: 'thread/started',
        params: {
          thread: {
            id: 'sub-thread-2',
            preview: '',
            ephemeral: false,
            modelProvider: 'openai',
            createdAt: 1,
            updatedAt: 1,
            status: { type: 'idle' },
            path: null,
            cwd: '/tmp/repo',
            cliVersion: '0.114.0',
            source: {
              subAgent: {
                parentThreadId: 'thread-1',
                agentToolCallId: 'agent-call-2',
              },
            },
            agentNickname: 'Scout',
            agentRole: 'explorer',
            gitInfo: null,
            name: null,
            turns: [],
          },
        },
      });
      await flush();

      emitServerMessage(proc, {
        method: 'item/started',
        params: {
          threadId: 'sub-thread-2',
          turnId: 'sub-turn-2',
          item: {
            type: 'fileChange',
            id: 'file-item-subagent',
            status: 'inProgress',
            changes: [{ path: '/tmp/repo/src/b.ts', kind: { type: 'update' } }],
          },
        },
      });
      emitServerMessage(proc, {
        id: 'approval-file-subagent',
        method: 'item/fileChange/requestApproval',
        params: {
          threadId: 'sub-thread-2',
          turnId: 'sub-turn-2',
          itemId: 'file-item-subagent',
          startedAtMs: Date.now(),
        },
      });
      await flush();

      expect(approvalSession.check).toHaveBeenCalledWith(
        { kind: 'file-write', path: '/tmp/repo/src/b.ts' },
        expect.objectContaining({ subagentId: 'sub-thread-2' }),
      );
      expect(collectClientMessages(proc)).toContainEqual({
        id: 'approval-file-subagent',
        result: { decision: 'accept' },
      });
    });

    it('(j) attributes an MCP tool-call approval elicitation on a subagent thread with subagentId', async () => {
      const approvalSession = createFakeApprovalSession({ decision: 'allow' });
      await startClientTurnForApproval(approvalSession);

      emitServerMessage(proc, {
        method: 'thread/started',
        params: {
          thread: {
            id: 'sub-thread-3',
            preview: '',
            ephemeral: false,
            modelProvider: 'openai',
            createdAt: 1,
            updatedAt: 1,
            status: { type: 'idle' },
            path: null,
            cwd: '/tmp/repo',
            cliVersion: '0.114.0',
            source: {
              subAgent: {
                parentThreadId: 'thread-1',
                agentToolCallId: 'agent-call-3',
              },
            },
            agentNickname: 'Scout',
            agentRole: 'explorer',
            gitInfo: null,
            name: null,
            turns: [],
          },
        },
      });
      await flush();

      emitServerMessage(proc, {
        method: 'item/started',
        params: {
          threadId: 'sub-thread-3',
          turnId: 'sub-turn-3',
          item: {
            type: 'mcpToolCall',
            id: 'mcp-call-j',
            server: 'github',
            tool: 'create_issue',
            status: 'inProgress',
            arguments: { title: 'Bug' },
            result: null,
            error: null,
          },
        },
      });
      emitServerMessage(proc, {
        id: 'approval-mcp-subagent',
        method: 'mcpServer/elicitation/request',
        params: {
          threadId: 'sub-thread-3',
          turnId: 'sub-turn-3',
          serverName: 'github',
          mode: 'form',
          _meta: {
            codex_approval_kind: 'mcp_tool_call',
            codex_mcp_tool_call_id: 'mcp-call-j',
            tool_name: 'create_issue',
            tool_title: 'create_issue',
            tool_params_display: 'title: "Bug"',
          },
          message: 'Allow create_issue?',
          requestedSchema: {},
        },
      });
      await flush();

      expect(approvalSession.check).toHaveBeenCalledWith(
        { kind: 'mcp', server: 'github', tool: 'create_issue' },
        expect.objectContaining({ subagentId: 'sub-thread-3' }),
      );
      expect(collectClientMessages(proc)).toContainEqual({
        id: 'approval-mcp-subagent',
        result: { action: 'accept', content: null, _meta: null },
      });
    });
  });

  it('uses the shared plan mode developer instructions in turn/start requests', async () => {
    const client = new CodexAppServerClient({
      cwd: '/tmp/repo',
      projectId: 'project',
      worktreeId: 'worktree',
      chatId: 'chat',
      sessionKey: 'project/worktree/chat',
      onEvent: jest.fn(),
      getWindow: (): null => null,
      approvalMode: 'full-access',
    });

    const turnPromise = client.startTurn({
      text: 'Plan this change',
      cwd: '/tmp/repo',
      model: 'gpt-6-sol',
      thinkingLevel: 'max',
      planMode: true,
    });

    await flush();
    emitServerMessage(proc, {
      id: 1,
      result: { userAgent: 'ua', codexHome: '/tmp/.codex' },
    });
    await flush();
    emitServerMessage(proc, {
      id: 2,
      result: {
        thread: {
          id: 'thread-1',
          preview: '',
          ephemeral: false,
          modelProvider: 'openai',
          createdAt: 1,
          updatedAt: 1,
          status: { type: 'idle' },
          path: null,
          cwd: '/tmp/repo',
          cliVersion: '0.114.0',
          source: 'vscode',
          agentNickname: null,
          agentRole: null,
          gitInfo: null,
          name: null,
          turns: [],
        },
        model: 'gpt-6-sol',
        modelProvider: 'openai',
        serviceTier: null,
        cwd: '/tmp/repo',
        approvalPolicy: 'never',
        sandbox: { type: 'dangerFullAccess' },
        reasoningEffort: 'high',
      },
    });
    await flush();
    await flush();

    const messages = collectClientMessages(proc);
    const threadStartMessage = messages.find(
      (message) => message.method === 'thread/start',
    );
    if (!threadStartMessage || !isRecord(threadStartMessage.params)) {
      throw new Error('Expected thread/start params');
    }
    const turnStartMessage = messages.find(
      (message) => message.method === 'turn/start',
    );
    if (!turnStartMessage) {
      throw new Error('Expected a turn/start request');
    }
    if (!isRecord(turnStartMessage.params)) {
      throw new Error('Expected turn/start params');
    }
    expect(threadStartMessage.params.approvalPolicy).toBe('never');
    expect(threadStartMessage.params.sandbox).toBe('danger-full-access');
    expect(turnStartMessage.params.approvalPolicy).toBe('never');
    expect(turnStartMessage.params.sandboxPolicy).toEqual({
      type: 'dangerFullAccess',
    });
    const collaborationMode = turnStartMessage.params.collaborationMode;
    if (!isRecord(collaborationMode)) {
      throw new Error('Expected collaborationMode');
    }
    if (!isRecord(collaborationMode.settings)) {
      throw new Error('Expected collaborationMode settings');
    }
    expect(turnStartMessage.params.effort).toBe('xhigh');
    expect(collaborationMode.mode).toBe('plan');
    expect(collaborationMode.settings.reasoning_effort).toBe('xhigh');
    const devInstructions = collaborationMode.settings.developer_instructions;
    if (typeof devInstructions !== 'string') {
      throw new Error('Expected developer instructions to be a string');
    }
    expect(devInstructions).toContain(PLAN_MODE_DEVELOPER_INSTRUCTIONS);

    emitServerMessage(proc, {
      id: 3,
      result: {
        turn: { id: 'turn-1', items: [], status: 'inProgress', error: null },
      },
    });
    emitServerMessage(proc, {
      method: 'turn/completed',
      params: {
        threadId: 'thread-1',
        turn: { id: 'turn-1', items: [], status: 'completed', error: null },
      },
    });

    await expect(turnPromise).resolves.toMatchObject({
      status: 'completed',
    });
  });

  it('maps thinking levels to turn effort per model', async () => {
    initCodexModels([
      {
        id: 'gpt-5.6-sol',
        label: 'GPT 5.6 Sol',
        supportedThinkingLevels: [
          'low',
          'medium',
          'high',
          'xhigh',
          'max',
          'ultra',
        ],
      },
      {
        id: 'gpt-5.6-luna',
        label: 'GPT 5.6 Luna',
        supportedThinkingLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
      },
    ]);
    initAiGatewayModels(
      [],
      [
        {
          modelId: 'gpt-5.6-sol',
          gatewayId: 'openai/gpt-5.6-sol',
          recommendedHarness: 'codex',
          gatewayOnly: false,
          contextWindow: 200_000,
          supportsPromptCaching: false,
          family: 'gpt',
          supportedThinkingLevels: ['low', 'medium'],
          toolSchemaProfile: 'standard',
        },
      ],
    );
    try {
      const startTurnEffort = async (
        model: string,
        thinkingLevel: 'ultra' | 'max',
        capabilityModel?: string,
        aiCreditsRouted = false,
        supportedThinkingLevels?: readonly ThinkingLevel[],
      ): Promise<unknown> => {
        const localProc = new MockChildProcess();
        spawnMock.mockReturnValue(localProc);
        const events: unknown[] = [];
        const client = createClient(events);
        const turnPromise = client.startTurn({
          text: 'Run',
          cwd: '/tmp/repo',
          model,
          capabilityModel,
          aiCreditsRouted,
          ...(supportedThinkingLevels ? { supportedThinkingLevels } : {}),
          thinkingLevel,
          planMode: false,
        });
        void turnPromise.catch(() => undefined);

        await flush();
        emitServerMessage(localProc, {
          id: 1,
          result: { userAgent: 'ua', codexHome: '/tmp/.codex' },
        });
        await flush();
        emitServerMessage(localProc, {
          id: 2,
          result: makeThreadResult('thread-1'),
        });
        await flush();

        const messages = collectClientMessages(localProc);
        const turnStartMessage = messages.find(
          (message) => message.method === 'turn/start',
        );
        if (!turnStartMessage || !isRecord(turnStartMessage.params)) {
          throw new Error('Expected a turn/start request with params');
        }
        emitServerMessage(localProc, {
          id: 3,
          result: {
            turn: {
              id: 'turn-1',
              items: [],
              status: 'inProgress',
              error: null,
            },
          },
        });
        emitServerMessage(localProc, {
          method: 'turn/completed',
          params: {
            threadId: 'thread-1',
            turn: { id: 'turn-1', items: [], status: 'completed', error: null },
          },
        });
        await turnPromise;
        client.dispose();
        await resetCodexRuntimeServiceForTests();
        return turnStartMessage.params.effort;
      };

      // Ultra passes through only for models that declare it.
      expect(await startTurnEffort('gpt-5.6-sol', 'ultra')).toBe('ultra');
      // Models without an Ultra tier keep the max fallback when declared.
      expect(await startTurnEffort('gpt-5.6-luna', 'ultra')).toBe('max');
      expect(await startTurnEffort('gpt-5.6-sol', 'max')).toBe('max');
      expect(await startTurnEffort('gpt-5.6-luna', 'max')).toBe('max');
      // A routed turn sends the gateway ID while retaining the local model's
      // capability metadata for effort clamping.
      expect(
        await startTurnEffort(
          'openai/gpt-5.6-sol',
          'ultra',
          'gpt-5.6-sol',
          true,
        ),
      ).toBe('medium');
      // A route-scoped snapshot remains authoritative after the mutable model
      // registry no longer contains the active routed model.
      initCodexModels([]);
      expect(
        await startTurnEffort(
          'openai/gpt-5.6-sol',
          'max',
          'gpt-5.6-sol',
          true,
          [],
        ),
      ).toBe('none');
    } finally {
      initAiGatewayModels([], []);
      initCodexModels([]);
    }
  });

  it('appends the Plan mode exception after the Plan mode instructions on Plan mode turns only', async () => {
    const addendum = buildLedgerPlanModeInstruction('codex');
    const client = new CodexAppServerClient({
      cwd: '/tmp/repo',
      projectId: 'project',
      worktreeId: 'worktree',
      chatId: 'chat',
      sessionKey: 'project/worktree/chat',
      onEvent: jest.fn(),
      getWindow: (): null => null,
      developerInstructions: 'Stay inside the history folder.',
      planModeDeveloperInstructionsAddendum: addendum,
    });

    const planTurnPromise = client.startTurn({
      text: 'Plan this change',
      cwd: '/tmp/repo',
      model: 'gpt-5.4',
      thinkingLevel: 'high',
      planMode: true,
    });

    await flush();
    emitServerMessage(proc, {
      id: 1,
      result: { userAgent: 'ua', codexHome: '/tmp/.codex' },
    });
    await flush();
    emitServerMessage(proc, { id: 2, result: makeThreadResult('thread-1') });
    await flush();

    const planMessages = collectClientMessages(proc);
    const threadStartMessage = planMessages.find(
      (message) => message.method === 'thread/start',
    );
    if (!threadStartMessage) {
      throw new Error('Expected thread/start request');
    }
    // The thread-scoped instructions never carry the Plan mode exception.
    expect(getRequestParams(threadStartMessage).developerInstructions).toBe(
      'Stay inside the history folder.',
    );
    const planTurnStartMessage = planMessages.find(
      (message) => message.method === 'turn/start',
    );
    if (!planTurnStartMessage) {
      throw new Error('Expected plan turn/start request');
    }
    const planTurnStartId = planTurnStartMessage.id;
    if (
      typeof planTurnStartId !== 'number' &&
      typeof planTurnStartId !== 'string'
    ) {
      throw new Error('Expected plan turn/start request id');
    }
    const planCollaborationMode =
      getRequestParams(planTurnStartMessage).collaborationMode;
    if (
      !isRecord(planCollaborationMode) ||
      !isRecord(planCollaborationMode.settings)
    ) {
      throw new Error('Expected plan collaborationMode settings');
    }
    expect(planCollaborationMode.mode).toBe('plan');
    expect(planCollaborationMode.settings.developer_instructions).toBe(
      [
        'Stay inside the history folder.',
        buildCodexPlanModeDeveloperInstructions('optional'),
        addendum,
      ].join('\n\n'),
    );

    emitServerMessage(proc, {
      id: planTurnStartId,
      result: {
        turn: { id: 'turn-1', items: [], status: 'inProgress', error: null },
      },
    });
    emitServerMessage(proc, {
      method: 'turn/completed',
      params: {
        threadId: 'thread-1',
        turn: { id: 'turn-1', items: [], status: 'completed', error: null },
      },
    });
    await expect(planTurnPromise).resolves.toMatchObject({
      status: 'completed',
    });

    const defaultTurnPromise = client.startTurn({
      text: 'Implement the approved plan',
      cwd: '/tmp/repo',
      model: 'gpt-5.4',
      thinkingLevel: 'high',
      planMode: false,
    });
    await flush();

    const defaultTurnStartMessage = collectClientMessages(proc).find(
      (message) => message.method === 'turn/start',
    );
    if (!defaultTurnStartMessage) {
      throw new Error('Expected default turn/start request');
    }
    const defaultTurnStartId = defaultTurnStartMessage.id;
    if (
      typeof defaultTurnStartId !== 'number' &&
      typeof defaultTurnStartId !== 'string'
    ) {
      throw new Error('Expected default turn/start request id');
    }
    expect(getRequestParams(defaultTurnStartMessage).collaborationMode).toEqual(
      {
        mode: 'default',
        settings: {
          model: 'gpt-5.4',
          reasoning_effort: 'high',
          developer_instructions: DEFAULT_MODE_DEVELOPER_INSTRUCTIONS,
        },
      },
    );

    emitServerMessage(proc, {
      id: defaultTurnStartId,
      result: {
        turn: { id: 'turn-2', items: [], status: 'inProgress', error: null },
      },
    });
    emitServerMessage(proc, {
      method: 'turn/completed',
      params: {
        threadId: 'thread-1',
        turn: { id: 'turn-2', items: [], status: 'completed', error: null },
      },
    });
    await expect(defaultTurnPromise).resolves.toMatchObject({
      status: 'completed',
    });
  });

  it('keeps custom instructions thread-scoped when clearing plan collaboration mode', async () => {
    const client = new CodexAppServerClient({
      cwd: '/tmp/repo',
      projectId: 'project',
      worktreeId: 'worktree',
      chatId: 'chat',
      sessionKey: 'project/worktree/chat',
      onEvent: jest.fn(),
      getWindow: (): null => null,
      developerInstructions: 'Stay inside the history folder.',
    });

    const planTurnPromise = client.startTurn({
      text: 'Plan this change',
      cwd: '/tmp/repo',
      model: 'gpt-6-sol',
      thinkingLevel: 'max',
      planMode: true,
    });

    await flush();
    emitServerMessage(proc, {
      id: 1,
      result: { userAgent: 'ua', codexHome: '/tmp/.codex' },
    });
    await flush();
    emitServerMessage(proc, { id: 2, result: makeThreadResult('thread-1') });
    await flush();

    const planMessages = collectClientMessages(proc);
    const threadStartMessage = planMessages.find(
      (message) => message.method === 'thread/start',
    );
    if (!threadStartMessage) {
      throw new Error('Expected thread/start request');
    }
    expect(getRequestParams(threadStartMessage).developerInstructions).toBe(
      'Stay inside the history folder.',
    );
    const planTurnStartMessage = planMessages.find(
      (message) => message.method === 'turn/start',
    );
    if (!planTurnStartMessage) {
      throw new Error('Expected plan turn/start request');
    }
    const planTurnStartId = planTurnStartMessage.id;
    if (
      typeof planTurnStartId !== 'number' &&
      typeof planTurnStartId !== 'string'
    ) {
      throw new Error('Expected plan turn/start request id');
    }
    const planTurnStartParams = getRequestParams(planTurnStartMessage);
    expect(planTurnStartParams.collaborationMode).toEqual(
      expect.objectContaining({ mode: 'plan' }),
    );

    emitServerMessage(proc, {
      id: planTurnStartId,
      result: {
        turn: { id: 'turn-1', items: [], status: 'inProgress', error: null },
      },
    });
    emitServerMessage(proc, {
      method: 'turn/completed',
      params: {
        threadId: 'thread-1',
        turn: { id: 'turn-1', items: [], status: 'completed', error: null },
      },
    });

    await expect(planTurnPromise).resolves.toMatchObject({
      status: 'completed',
    });

    const implementationTurnPromise = client.startTurn({
      text: 'Implement the approved plan',
      cwd: '/tmp/repo',
      model: 'gpt-6-sol',
      thinkingLevel: 'high',
      planMode: false,
    });

    await flush();

    const implementationMessages = collectClientMessages(proc);
    const implementationTurnStartMessage = implementationMessages.find(
      (message) => message.method === 'turn/start',
    );
    if (!implementationTurnStartMessage) {
      throw new Error('Expected implementation turn/start request');
    }
    const implementationTurnStartId = implementationTurnStartMessage.id;
    if (
      typeof implementationTurnStartId !== 'number' &&
      typeof implementationTurnStartId !== 'string'
    ) {
      throw new Error('Expected implementation turn/start request id');
    }
    expect(
      getRequestParams(implementationTurnStartMessage).collaborationMode,
    ).toEqual({
      mode: 'default',
      settings: {
        model: 'gpt-6-sol',
        reasoning_effort: 'high',
        developer_instructions: DEFAULT_MODE_DEVELOPER_INSTRUCTIONS,
      },
    });

    emitServerMessage(proc, {
      id: implementationTurnStartId,
      result: {
        turn: { id: 'turn-2', items: [], status: 'inProgress', error: null },
      },
    });
    emitServerMessage(proc, {
      method: 'turn/completed',
      params: {
        threadId: 'thread-1',
        turn: { id: 'turn-2', items: [], status: 'completed', error: null },
      },
    });

    await expect(implementationTurnPromise).resolves.toMatchObject({
      status: 'completed',
    });

    const followUpTurnPromise = client.startTurn({
      text: 'Continue implementation',
      cwd: '/tmp/repo',
      model: 'gpt-6-sol',
      thinkingLevel: 'high',
      planMode: false,
    });

    await flush();

    const followUpMessages = collectClientMessages(proc);
    const followUpTurnStartMessage = followUpMessages.find(
      (message) => message.method === 'turn/start',
    );
    if (!followUpTurnStartMessage) {
      throw new Error('Expected follow-up turn/start request');
    }
    const followUpTurnStartId = followUpTurnStartMessage.id;
    if (
      typeof followUpTurnStartId !== 'number' &&
      typeof followUpTurnStartId !== 'string'
    ) {
      throw new Error('Expected follow-up turn/start request id');
    }
    expect(
      getRequestParams(followUpTurnStartMessage).collaborationMode,
    ).toBeUndefined();

    emitServerMessage(proc, {
      id: followUpTurnStartId,
      result: {
        turn: { id: 'turn-3', items: [], status: 'inProgress', error: null },
      },
    });
    emitServerMessage(proc, {
      method: 'turn/completed',
      params: {
        threadId: 'thread-1',
        turn: { id: 'turn-3', items: [], status: 'completed', error: null },
      },
    });

    await expect(followUpTurnPromise).resolves.toMatchObject({
      status: 'completed',
    });
  });

  it('revokes unknown plan instructions on the first implementation turn for resumed threads', async () => {
    const client = new CodexAppServerClient({
      cwd: '/tmp/repo',
      projectId: 'project',
      worktreeId: 'worktree',
      chatId: 'chat',
      sessionKey: 'project/worktree/chat',
      initialThreadId: 'thread-1',
      onEvent: jest.fn(),
      getWindow: (): null => null,
    });

    const implementationTurnPromise = client.startTurn({
      text: 'Implement the approved plan after restart',
      cwd: '/tmp/repo',
      model: 'gpt-6-sol',
      thinkingLevel: 'high',
      planMode: false,
    });

    await flush();
    emitServerMessage(proc, {
      id: 1,
      result: { userAgent: 'ua', codexHome: '/tmp/.codex' },
    });
    await flush();
    emitServerMessage(proc, { id: 2, result: makeThreadResult('thread-1') });
    await flush();

    const implementationMessages = collectClientMessages(proc);
    const implementationTurnStartMessage = implementationMessages.find(
      (message) => message.method === 'turn/start',
    );
    if (!implementationTurnStartMessage) {
      throw new Error('Expected implementation turn/start request');
    }
    const implementationTurnStartId = implementationTurnStartMessage.id;
    if (
      typeof implementationTurnStartId !== 'number' &&
      typeof implementationTurnStartId !== 'string'
    ) {
      throw new Error('Expected implementation turn/start request id');
    }
    expect(
      getRequestParams(implementationTurnStartMessage).collaborationMode,
    ).toEqual({
      mode: 'default',
      settings: {
        model: 'gpt-6-sol',
        reasoning_effort: 'high',
        developer_instructions: DEFAULT_MODE_DEVELOPER_INSTRUCTIONS,
      },
    });

    emitServerMessage(proc, {
      id: implementationTurnStartId,
      result: {
        turn: { id: 'turn-1', items: [], status: 'inProgress', error: null },
      },
    });
    emitServerMessage(proc, {
      method: 'turn/completed',
      params: {
        threadId: 'thread-1',
        turn: { id: 'turn-1', items: [], status: 'completed', error: null },
      },
    });

    await expect(implementationTurnPromise).resolves.toMatchObject({
      status: 'completed',
    });

    const followUpTurnPromise = client.startTurn({
      text: 'Continue implementation after the clear',
      cwd: '/tmp/repo',
      model: 'gpt-6-sol',
      thinkingLevel: 'high',
      planMode: false,
    });

    await flush();

    const followUpMessages = collectClientMessages(proc);
    const followUpTurnStartMessage = followUpMessages.find(
      (message) => message.method === 'turn/start',
    );
    if (!followUpTurnStartMessage) {
      throw new Error('Expected follow-up turn/start request');
    }
    const followUpTurnStartId = followUpTurnStartMessage.id;
    if (
      typeof followUpTurnStartId !== 'number' &&
      typeof followUpTurnStartId !== 'string'
    ) {
      throw new Error('Expected follow-up turn/start request id');
    }
    expect(
      getRequestParams(followUpTurnStartMessage).collaborationMode,
    ).toBeUndefined();

    emitServerMessage(proc, {
      id: followUpTurnStartId,
      result: {
        turn: { id: 'turn-2', items: [], status: 'inProgress', error: null },
      },
    });
    emitServerMessage(proc, {
      method: 'turn/completed',
      params: {
        threadId: 'thread-1',
        turn: { id: 'turn-2', items: [], status: 'completed', error: null },
      },
    });

    await expect(followUpTurnPromise).resolves.toMatchObject({
      status: 'completed',
    });
  });

  it('lists enabled skills using invocable Codex skill syntax', async () => {
    const client = new CodexAppServerClient({
      cwd: '/tmp/repo',
      projectId: 'project',
      worktreeId: 'worktree',
      chatId: 'chat',
      sessionKey: 'project/worktree/chat',
      onEvent: jest.fn(),
      getWindow: (): null => null,
    });

    const skillsPromise = client.listSkills('/tmp/repo');

    await flush();
    expect(collectClientMessages(proc)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 1, method: 'initialize' }),
      ]),
    );

    emitServerMessage(proc, {
      id: 1,
      result: { userAgent: 'ua', codexHome: '/tmp/.codex' },
    });
    await flush();

    expect(collectClientMessages(proc)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ method: 'initialized' }),
        expect.objectContaining({
          id: 2,
          method: 'skills/list',
          params: { cwds: ['/tmp/repo'], forceReload: true },
        }),
      ]),
    );

    emitServerMessage(proc, {
      id: 2,
      result: {
        data: [
          {
            cwd: '/tmp/repo',
            skills: [
              {
                name: 'ud-git:branch-naming',
                description: 'Generate a branch name',
                shortDescription: 'Branch naming',
                interface: {
                  displayName: 'Branch Naming',
                  shortDescription: 'Create a branch name',
                },
                path: '/tmp/repo/.codex/skills/ud-git/branch-naming/SKILL.md',
                scope: 'user',
                enabled: true,
              },
              {
                name: 'disabled-skill',
                description: 'Do not show',
                path: '/tmp/repo/.codex/skills/disabled/SKILL.md',
                scope: 'user',
                enabled: false,
              },
            ],
            errors: [],
          },
        ],
      },
    });

    await expect(skillsPromise).resolves.toEqual([
      {
        name: 'ud-git:branch-naming',
        description: 'Create a branch name',
        displayName: '$ud-git:branch-naming',
        insertText: '$ud-git:branch-naming ',
      },
    ]);
  });

  it('applies app-server config overrides while listing skills', async () => {
    const client = new CodexAppServerClient({
      cwd: '/tmp/repo',
      projectId: 'project',
      worktreeId: 'worktree',
      chatId: 'chat',
      sessionKey: 'project/worktree/chat',
      onEvent: jest.fn(),
      getWindow: (): null => null,
      configArgs: ['-c', 'mcp_servers={}'],
    });

    const skillsPromise = client.listSkills('/tmp/repo');

    await flush();
    expect(spawnMock).toHaveBeenCalledWith(
      '/mock/codex',
      ['app-server', '-c', 'mcp_servers={}'],
      expect.any(Object),
    );

    emitServerMessage(proc, {
      id: 1,
      result: { userAgent: 'ua', codexHome: '/tmp/.codex' },
    });
    await flush();
    emitServerMessage(proc, {
      id: 2,
      result: { data: [{ cwd: '/tmp/repo', skills: [], errors: [] }] },
    });

    await expect(skillsPromise).resolves.toEqual([]);
    client.dispose();
  });

  it('forks an existing thread by id and returns the new thread id', async () => {
    const client = new CodexAppServerClient({
      cwd: '/tmp/repo',
      projectId: 'project',
      worktreeId: 'worktree',
      chatId: 'chat',
      sessionKey: 'project/worktree/chat',
      onEvent: jest.fn(),
      getWindow: (): null => null,
    });

    const forkPromise = client.forkThread('thread-source');

    await flush();
    expect(collectClientMessages(proc)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 1, method: 'initialize' }),
      ]),
    );

    emitServerMessage(proc, {
      id: 1,
      result: { userAgent: 'ua', codexHome: '/tmp/.codex' },
    });
    await flush();

    const messages = collectClientMessages(proc);
    expect(messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ method: 'initialized' }),
        expect.objectContaining({
          id: 2,
          method: 'thread/fork',
          params: {
            threadId: 'thread-source',
            cwd: '/tmp/repo',
            // No `approvalMode` was passed to the constructor, so this
            // defaults to 'ask' and keeps every provider approval category
            // routed through the application rather than using Codex's
            // trusted-command short circuit.
            approvalPolicy: {
              granular: {
                sandbox_approval: true,
                rules: true,
                skill_approval: true,
                request_permissions: true,
                mcp_elicitations: true,
              },
            },
            sandbox: 'read-only',
            serviceTier: 'default',
          },
        }),
      ]),
    );

    emitServerMessage(proc, {
      id: 2,
      result: makeThreadResult('thread-forked'),
    });

    await expect(forkPromise).resolves.toBe('thread-forked');
  });

  it('includes multi-agent config on thread/fork', async () => {
    const client = new CodexAppServerClient({
      cwd: '/tmp/repo',
      projectId: 'project',
      worktreeId: 'worktree',
      chatId: 'chat',
      sessionKey: 'project/worktree/chat',
      onEvent: jest.fn(),
      getWindow: (): null => null,
      multiAgentEnabled: false,
    });

    const forkPromise = client.forkThread('thread-source');

    await flush();
    emitServerMessage(proc, {
      id: 1,
      result: { userAgent: 'ua', codexHome: '/tmp/.codex' },
    });
    await flush();

    const messages = collectClientMessages(proc);
    const forkRequest = messages.find(
      (message): boolean => message.method === 'thread/fork',
    );
    if (!forkRequest) {
      throw new Error('Expected thread/fork request');
    }
    const params = getRequestParams(forkRequest);
    expect(forkRequest.id).toBe(2);
    expect(params.threadId).toBe('thread-source');
    expect(params.config).toEqual({
      'features.multi_agent': false,
      'features.multi_agent_v2': false,
      'agents.enabled': false,
    });

    emitServerMessage(proc, {
      id: 2,
      result: makeThreadResult('thread-forked'),
    });

    await expect(forkPromise).resolves.toBe('thread-forked');
  });

  it.each([undefined, { thinkingLevel: 'medium' }] satisfies Array<
    AgentModelConfig | undefined
  >)(
    'sends priority service tier with legacy Fast and partial config %j',
    async (modelConfig) => {
      const client = createClient();
      const turnPromise = client.startTurn({
        text: 'Run',
        cwd: '/tmp/repo',
        model: 'gpt-6-sol',
        thinkingLevel: 'high',
        planMode: false,
        codexFastModeEnabled: true,
        modelConfig,
      });
      try {
        await flush();
        emitServerMessage(proc, {
          id: 1,
          result: { userAgent: 'ua', codexHome: '/tmp/.codex' },
        });
        await flush();

        const threadRequest = collectClientMessages(proc).find(
          (message): boolean => message.method === 'thread/start',
        );
        if (!threadRequest) {
          throw new Error('Expected thread/start request');
        }
        expect(getRequestParams(threadRequest).serviceTier).toBe('priority');

        emitServerMessage(proc, {
          id: 2,
          result: makeThreadResult('thread-1'),
        });
        await flush();

        const turnRequest = collectClientMessages(proc).find(
          (message): boolean => message.method === 'turn/start',
        );
        if (!turnRequest) {
          throw new Error('Expected turn/start request');
        }
        expect(getRequestParams(turnRequest).serviceTier).toBe('priority');
      } finally {
        client.dispose();
        await expect(turnPromise).rejects.toThrow('session_destroyed');
      }
    },
  );

  it('sends default service tier on thread/start and turn/start when fast mode is disabled', async () => {
    const client = createClient();
    const turnPromise = client.startTurn({
      text: 'Run',
      cwd: '/tmp/repo',
      model: 'gpt-6-sol',
      thinkingLevel: 'high',
      planMode: false,
      codexFastModeEnabled: false,
    });

    await flush();
    emitServerMessage(proc, {
      id: 1,
      result: { userAgent: 'ua', codexHome: '/tmp/.codex' },
    });
    await flush();

    const threadRequest = collectClientMessages(proc).find(
      (message): boolean => message.method === 'thread/start',
    );
    if (!threadRequest) {
      throw new Error('Expected thread/start request');
    }
    expect(getRequestParams(threadRequest).serviceTier).toBe('default');

    emitServerMessage(proc, { id: 2, result: makeThreadResult('thread-1') });
    await flush();

    const turnRequest = collectClientMessages(proc).find(
      (message): boolean => message.method === 'turn/start',
    );
    if (!turnRequest) {
      throw new Error('Expected turn/start request');
    }
    expect(getRequestParams(turnRequest).serviceTier).toBe('default');

    client.dispose();
    await expect(turnPromise).rejects.toThrow('session_destroyed');
  });

  it('sends service tier on thread/resume', async () => {
    const client = new CodexAppServerClient({
      cwd: '/tmp/repo',
      projectId: 'project',
      worktreeId: 'worktree',
      chatId: 'chat',
      sessionKey: 'project/worktree/chat',
      initialThreadId: 'thread-1',
      onEvent: jest.fn(),
      getWindow: (): null => null,
    });

    const { turnPromise, threadRequest } = await startTurnUntilThreadRequest(
      client,
      proc,
    );

    expect(threadRequest.method).toBe('thread/resume');
    expect(getRequestParams(threadRequest).serviceTier).toBe('default');

    client.dispose();
    await expect(turnPromise).rejects.toThrow('session_destroyed');
  });

  it('sends service tier on thread/fork', async () => {
    const client = new CodexAppServerClient({
      cwd: '/tmp/repo',
      projectId: 'project',
      worktreeId: 'worktree',
      chatId: 'chat',
      sessionKey: 'project/worktree/chat',
      onEvent: jest.fn(),
      getWindow: (): null => null,
      codexFastModeEnabled: (): boolean => true,
    });

    const forkPromise = client.forkThread('thread-source');

    await flush();
    emitServerMessage(proc, {
      id: 1,
      result: { userAgent: 'ua', codexHome: '/tmp/.codex' },
    });
    await flush();

    const forkRequest = collectClientMessages(proc).find(
      (message): boolean => message.method === 'thread/fork',
    );
    if (!forkRequest) {
      throw new Error('Expected thread/fork request');
    }
    expect(getRequestParams(forkRequest).serviceTier).toBe('priority');

    emitServerMessage(proc, {
      id: 2,
      result: makeThreadResult('thread-forked'),
    });
    await expect(forkPromise).resolves.toBe('thread-forked');
  });

  it('sends the exact admitted Ultra fast tier on turn/start and an explicit default on thread/start', async () => {
    const client = createClient();
    const turnPromise = client.startTurn({
      text: 'Run',
      cwd: '/tmp/repo',
      model: 'gpt-6-sol',
      thinkingLevel: 'high',
      planMode: false,
      modelConfig: { speed: 'ultrafast', fastMode: false },
      ultrafastAdmitted: true,
    });
    // Keep a failed assertion below from surfacing as an unhandled rejection.
    void turnPromise.catch(() => undefined);

    await flush();
    emitServerMessage(proc, {
      id: 1,
      result: { userAgent: 'ua', codexHome: '/tmp/.codex' },
    });
    await flush();

    const threadRequest = collectClientMessages(proc).find(
      (message): boolean => message.method === 'thread/start',
    );
    if (!threadRequest) {
      throw new Error('Expected thread/start request');
    }
    // Thread lifecycle metadata never carries an unadmitted Ultra fast tier.
    expect(getRequestParams(threadRequest).serviceTier).toBe('default');

    emitServerMessage(proc, { id: 2, result: makeThreadResult('thread-1') });
    await flush();

    const turnRequest = collectClientMessages(proc).find(
      (message): boolean => message.method === 'turn/start',
    );
    if (!turnRequest) {
      throw new Error('Expected turn/start request');
    }
    expect(getRequestParams(turnRequest).serviceTier).toBe('ultrafast');

    client.dispose();
    await expect(turnPromise).rejects.toThrow('session_destroyed');
  });

  it('refuses an unadmitted Ultra fast turn before any app-server request', async () => {
    const client = createClient();
    const turnPromise = client.startTurn({
      text: 'Run',
      cwd: '/tmp/repo',
      model: 'gpt-6-sol',
      thinkingLevel: 'high',
      planMode: false,
      modelConfig: { speed: 'ultrafast', fastMode: false },
    });
    void turnPromise.catch(() => undefined);
    await flush();
    emitServerMessage(proc, {
      id: 1,
      result: { userAgent: 'ua', codexHome: '/tmp/.codex' },
    });
    await flush();
    await expect(
      Promise.race([turnPromise, Promise.resolve('still pending')]),
    ).rejects.toBeInstanceOf(CodexSpeedUnsupportedError);
    expect(
      collectClientMessages(proc).filter(
        (message): boolean =>
          message.method === 'thread/start' ||
          message.method === 'thread/resume' ||
          message.method === 'turn/start',
      ),
    ).toEqual([]);
    client.dispose();
  });

  it('sends an explicit default tier on thread/resume for Ultra fast so an inherited tier is cleared', async () => {
    const client = new CodexAppServerClient({
      cwd: '/tmp/repo',
      projectId: 'project',
      worktreeId: 'worktree',
      chatId: 'chat',
      sessionKey: 'project/worktree/chat',
      initialThreadId: 'thread-1',
      onEvent: jest.fn(),
      getWindow: (): null => null,
    });

    const turnPromise = client.startTurn({
      text: 'Run',
      cwd: '/tmp/repo',
      model: 'gpt-6-sol',
      thinkingLevel: 'high',
      planMode: false,
      modelConfig: { speed: 'ultrafast', fastMode: false },
      ultrafastAdmitted: true,
    });
    // Keep a failed assertion below from surfacing as an unhandled rejection.
    void turnPromise.catch(() => undefined);
    await flush();
    emitServerMessage(proc, {
      id: 1,
      result: { userAgent: 'ua', codexHome: '/tmp/.codex' },
    });
    await flush();
    const resumeRequest = collectClientMessages(proc).find(
      (message): boolean => message.method === 'thread/resume',
    );
    if (!resumeRequest) {
      throw new Error('Expected thread/resume request');
    }
    expect(getRequestParams(resumeRequest).serviceTier).toBe('default');

    client.dispose();
    await expect(turnPromise).rejects.toThrow('session_destroyed');
  });

  it('sends an explicit default tier on thread/fork while Ultra fast is requested', async () => {
    const client = new CodexAppServerClient({
      cwd: '/tmp/repo',
      projectId: 'project',
      worktreeId: 'worktree',
      chatId: 'chat',
      sessionKey: 'project/worktree/chat',
      onEvent: jest.fn(),
      getWindow: (): null => null,
      modelConfig: (): AgentModelConfig => ({
        speed: 'ultrafast',
        fastMode: false,
      }),
    });

    const forkPromise = client.forkThread('thread-source');
    void forkPromise.catch(() => undefined);
    await flush();
    emitServerMessage(proc, {
      id: 1,
      result: { userAgent: 'ua', codexHome: '/tmp/.codex' },
    });
    await flush();
    const forkRequest = collectClientMessages(proc).find(
      (message): boolean => message.method === 'thread/fork',
    );
    if (!forkRequest) {
      throw new Error('Expected thread/fork request');
    }
    expect(getRequestParams(forkRequest).serviceTier).toBe('default');

    emitServerMessage(proc, {
      id: 2,
      result: makeThreadResult('thread-forked'),
    });
    await expect(forkPromise).resolves.toBe('thread-forked');
  });

  it('includes multi-agent config on thread/start when enabled', async () => {
    const client = new CodexAppServerClient({
      cwd: '/tmp/repo',
      projectId: 'project',
      worktreeId: 'worktree',
      chatId: 'chat',
      sessionKey: 'project/worktree/chat',
      onEvent: jest.fn(),
      getWindow: (): null => null,
      multiAgentEnabled: true,
    });

    const { turnPromise, threadRequest } = await startTurnUntilThreadRequest(
      client,
      proc,
    );

    expect(threadRequest.method).toBe('thread/start');
    expect(getRequestParams(threadRequest).config).toEqual({
      mcp_servers: {},
      'features.multi_agent': true,
      'features.multi_agent_v2': true,
      'agents.enabled': true,
    });

    client.dispose();
    await expect(turnPromise).rejects.toThrow('session_destroyed');
  });

  it('includes disabled multi-agent config on thread/start', async () => {
    const client = new CodexAppServerClient({
      cwd: '/tmp/repo',
      projectId: 'project',
      worktreeId: 'worktree',
      chatId: 'chat',
      sessionKey: 'project/worktree/chat',
      onEvent: jest.fn(),
      getWindow: (): null => null,
      multiAgentEnabled: false,
    });

    const { turnPromise, threadRequest } = await startTurnUntilThreadRequest(
      client,
      proc,
    );

    expect(threadRequest.method).toBe('thread/start');
    expect(getRequestParams(threadRequest).config).toEqual({
      mcp_servers: {},
      'features.multi_agent': false,
      'features.multi_agent_v2': false,
      'agents.enabled': false,
    });

    client.dispose();
    await expect(turnPromise).rejects.toThrow('session_destroyed');
  });

  it('clears canonical MCP servers when a new thread has no selected servers', async () => {
    const client = new CodexAppServerClient({
      cwd: '/tmp/repo',
      projectId: 'project',
      worktreeId: 'worktree',
      chatId: 'chat',
      sessionKey: 'project/worktree/chat',
      onEvent: jest.fn(),
      getWindow: (): null => null,
    });

    const { turnPromise, threadRequest } = await startTurnUntilThreadRequest(
      client,
      proc,
    );

    expect(getRequestParams(threadRequest).config).toEqual({
      mcp_servers: {},
    });

    client.dispose();
    await expect(turnPromise).rejects.toThrow('session_destroyed');
  });

  it('includes multi-agent config on thread/resume', async () => {
    const client = new CodexAppServerClient({
      cwd: '/tmp/repo',
      projectId: 'project',
      worktreeId: 'worktree',
      chatId: 'chat',
      sessionKey: 'project/worktree/chat',
      initialThreadId: 'thread-1',
      onEvent: jest.fn(),
      getWindow: (): null => null,
      multiAgentEnabled: true,
      maxConcurrentSubagents: 2,
    });

    const { turnPromise, threadRequest } = await startTurnUntilThreadRequest(
      client,
      proc,
    );

    const params = getRequestParams(threadRequest);
    expect(threadRequest.method).toBe('thread/resume');
    expect(params.threadId).toBe('thread-1');
    expect(params.config).toEqual({
      'features.multi_agent': true,
      'features.multi_agent_v2': true,
      'agents.enabled': true,
      'agents.max_concurrent_threads_per_session': 2,
    });

    client.dispose();
    await expect(turnPromise).rejects.toThrow('session_destroyed');
  });

  it.each([
    ['thread/start', undefined],
    ['thread/resume', 'thread-1'],
  ])('sends the project doc config on %s', async (method, initialThreadId) => {
    const client = new CodexAppServerClient({
      cwd: '/tmp/repo',
      projectId: 'project',
      worktreeId: 'worktree',
      chatId: 'chat',
      sessionKey: 'project/worktree/chat',
      ...(initialThreadId ? { initialThreadId } : {}),
      onEvent: jest.fn(),
      getWindow: (): null => null,
      threadConfig: { ...CODEX_PROJECT_DOC_THREAD_CONFIG },
    });

    const { turnPromise, threadRequest } = await startTurnUntilThreadRequest(
      client,
      proc,
    );

    expect(threadRequest.method).toBe(method);
    expect(getRequestParams(threadRequest).config).toMatchObject(
      PROJECT_DOC_THREAD_CONFIG,
    );

    client.dispose();
    await expect(turnPromise).rejects.toThrow('session_destroyed');
  });

  it('combines MCP server config and multi-agent config on thread/start', async () => {
    const client = new CodexAppServerClient({
      cwd: '/tmp/repo',
      projectId: 'project',
      worktreeId: 'worktree',
      chatId: 'chat',
      sessionKey: 'project/worktree/chat',
      onEvent: jest.fn(),
      getWindow: (): null => null,
      mcpServersConfig: {
        example: {},
      },
      multiAgentEnabled: true,
    });

    const { turnPromise, threadRequest } = await startTurnUntilThreadRequest(
      client,
      proc,
    );

    expect(threadRequest.method).toBe('thread/start');
    expect(getRequestParams(threadRequest).config).toEqual({
      mcp_servers: {
        example: { required: false },
      },
      'features.multi_agent': true,
      'features.multi_agent_v2': true,
      'agents.enabled': true,
    });

    client.dispose();
    await expect(turnPromise).rejects.toThrow('session_destroyed');
  });

  it('waits for the selected MCP server to become ready on the owning thread', async () => {
    const client = new CodexAppServerClient({
      cwd: '/tmp/repo',
      projectId: 'project',
      worktreeId: 'worktree',
      chatId: 'chat',
      sessionKey: 'project/worktree/chat',
      onEvent: jest.fn(),
      getWindow: (): null => null,
      mcpServersConfig: {
        linear: {
          url: 'http://127.0.0.1:37646/mcp/linear',
        },
      },
    });

    const turnPromise = client.startTurn({
      text: 'Triage the issue',
      cwd: '/tmp/repo',
      model: 'gpt-6-sol',
      thinkingLevel: 'high',
      planMode: false,
    });
    const initializeRequest = await waitForClientRequest(proc, 'initialize');
    emitServerMessage(proc, {
      id: initializeRequest.id,
      result: { userAgent: 'ua', codexHome: '/tmp/.codex' },
    });
    const startRequest = await waitForClientRequest(proc, 'thread/start');
    emitServerMessage(proc, {
      id: startRequest.id,
      result: makeThreadResult('thread-linear'),
    });
    emitServerMessage(proc, {
      method: 'mcpServer/startupStatus/updated',
      params: {
        threadId: 'thread-linear',
        name: 'linear',
        status: 'starting',
        error: null,
        failureReason: null,
      },
    });
    await flush();
    expect(
      collectClientMessages(proc).some(
        (message) => message.method === 'turn/start',
      ),
    ).toBe(false);

    emitServerMessage(proc, {
      method: 'mcpServer/startupStatus/updated',
      params: {
        threadId: 'thread-linear',
        name: 'linear',
        status: 'cancelled',
        error: null,
        failureReason: null,
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 125));
    expect(
      collectClientMessages(proc).some(
        (message) => message.method === 'turn/start',
      ),
    ).toBe(false);

    emitServerMessage(proc, {
      method: 'mcpServer/startupStatus/updated',
      params: {
        threadId: 'thread-linear',
        name: 'linear',
        status: 'starting',
        error: null,
        failureReason: null,
      },
    });
    emitServerMessage(proc, {
      method: 'mcpServer/startupStatus/updated',
      params: {
        threadId: 'thread-linear',
        name: 'linear',
        status: 'ready',
        error: null,
        failureReason: null,
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 125));
    expect(
      collectClientMessages(proc).some(
        (message) => message.method === 'turn/start',
      ),
    ).toBe(true);

    client.dispose();
    await expect(turnPromise).rejects.toThrow('session_destroyed');
  });

  it.each(['reauthenticationRequired', 'serverInitializationFailed'])(
    'reports MCP startup failure evidence before the prompt: %s',
    async (failureReason) => {
      const onMcpToolEvidence = jest.fn();
      const client = new CodexAppServerClient({
        cwd: '/tmp/repo',
        projectId: 'project',
        worktreeId: 'worktree',
        chatId: 'chat',
        sessionKey: 'project/worktree/chat',
        onEvent: jest.fn(),
        getWindow: (): null => null,
        mcpServersConfig: {
          linear: { url: 'http://127.0.0.1:37646/mcp/linear' },
        },
        onMcpToolEvidence,
      });
      const { turnPromise, threadRequest } = await startTurnUntilThreadRequest(
        client,
        proc,
      );
      emitServerMessage(proc, {
        id: threadRequest.id,
        result: makeThreadResult('thread-1'),
      });
      emitServerMessage(proc, {
        method: 'mcpServer/startupStatus/updated',
        params: {
          threadId: 'thread-1',
          name: 'linear',
          status: 'failed',
          error: 'MCP startup failed',
          failureReason,
        },
      });
      const turnStart = await waitForClientRequest(proc, 'turn/start');
      // Settle the turn before asserting so a regression cannot leak its pending promise.
      emitServerMessage(proc, {
        id: turnStart.id,
        result: {
          turn: { id: 'turn-1', items: [], status: 'inProgress', error: null },
        },
      });
      await flush();
      completeRootTurn(proc);
      await expect(turnPromise).resolves.toMatchObject({ status: 'completed' });
      expect(onMcpToolEvidence).toHaveBeenCalledWith([
        failureReason === 'reauthenticationRequired'
          ? { name: 'linear', kind: 'auth_required' }
          : { name: 'linear', kind: 'unavailable', reason: 'startup_failed' },
      ]);
    },
  );

  it('reapplies lease-validated MCP configuration on thread/resume', async () => {
    const capabilityStore = new CodexCapabilityStore(
      '/tmp/codex-capability-store-resume-test',
    );
    jest.spyOn(capabilityStore, 'readLease').mockResolvedValue({
      version: 1,
      threadId: 'thread-existing',
      snapshotId: 'snapshot-current',
      rootContentIds: [],
      kind: 'persisted-chat',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    const client = new CodexAppServerClient({
      cwd: '/tmp/repo',
      projectId: 'project',
      worktreeId: 'worktree',
      chatId: 'chat',
      sessionKey: 'project/worktree/chat',
      initialThreadId: 'thread-existing',
      onEvent: jest.fn(),
      getWindow: (): null => null,
      capabilityStore,
      capabilitySnapshotId: 'snapshot-current',
      mcpServersConfig: {
        'appproxy-hub': {
          url: 'http://127.0.0.1:37646/mcp/hub',
        },
      },
    });

    const { turnPromise, threadRequest } = await startTurnUntilThreadRequest(
      client,
      proc,
    );

    expect(threadRequest).toMatchObject({
      method: 'thread/resume',
      params: {
        threadId: 'thread-existing',
        config: {
          mcp_servers: {
            'appproxy-hub': {
              url: 'http://127.0.0.1:37646/mcp/hub',
            },
          },
        },
      },
    });

    client.dispose();
    await expect(turnPromise).rejects.toThrow('session_destroyed');
  });

  it('materializes a legacy thread when standalone MCP configuration has no lease', async () => {
    const capabilityStore = new CodexCapabilityStore(
      '/tmp/codex-capability-store-legacy-test',
    );
    jest.spyOn(capabilityStore, 'readLease').mockResolvedValue(null);
    jest.spyOn(capabilityStore, 'writeLease').mockResolvedValue(undefined);
    const client = new CodexAppServerClient({
      cwd: '/tmp/repo',
      projectId: 'project',
      worktreeId: 'worktree',
      chatId: 'chat',
      sessionKey: 'project/worktree/chat',
      initialThreadId: 'thread-existing',
      onEvent: jest.fn(),
      getWindow: (): null => null,
      capabilityStore,
      mcpServersConfig: {
        'appproxy-hub': {
          url: 'http://127.0.0.1:37646/mcp/hub',
        },
      },
      fallbackSeedItems: [
        {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'prior context' }],
        },
      ],
    });

    const turnPromise = client.startTurn({
      text: 'Continue',
      cwd: '/tmp/repo',
      model: 'gpt-6-sol',
      thinkingLevel: 'high',
      planMode: false,
    });
    const initializeRequest = await waitForClientRequest(proc, 'initialize');
    emitServerMessage(proc, {
      id: initializeRequest.id,
      result: { userAgent: 'ua', codexHome: '/tmp/.codex' },
    });
    const startRequest = await waitForClientRequest(proc, 'thread/start');
    expect(getRequestParams(startRequest).config).toEqual({
      mcp_servers: {
        'appproxy-hub': {
          url: 'http://127.0.0.1:37646/mcp/hub',
          required: false,
        },
      },
    });
    expect(
      collectClientMessages(proc).some(
        (message) => message.method === 'thread/resume',
      ),
    ).toBe(false);

    client.dispose();
    await expect(turnPromise).rejects.toThrow('session_destroyed');
  });

  it('throws when thread/fork returns a payload without a thread id', async () => {
    const client = new CodexAppServerClient({
      cwd: '/tmp/repo',
      projectId: 'project',
      worktreeId: 'worktree',
      chatId: 'chat',
      sessionKey: 'project/worktree/chat',
      onEvent: jest.fn(),
      getWindow: (): null => null,
    });

    const forkPromise = client.forkThread('thread-source');

    const initializeRequest = await waitForClientRequest(proc, 'initialize');
    emitServerMessage(proc, {
      id: initializeRequest.id,
      result: { userAgent: 'ua', codexHome: '/tmp/.codex' },
    });
    const forkRequest = await waitForClientRequest(proc, 'thread/fork');
    emitServerMessage(proc, { id: forkRequest.id, result: {} });

    await expect(forkPromise).rejects.toThrow(
      'Codex app-server returned a forked thread without an id',
    );
  });

  it('ignores pre-start usage while accumulating the active proposed-plan turn', async () => {
    const events: unknown[] = [];
    const client = new CodexAppServerClient({
      cwd: '/tmp/repo',
      projectId: 'project',
      worktreeId: 'worktree',
      chatId: 'chat',
      sessionKey: 'project/worktree/chat',
      onEvent: (event): void => {
        events.push(event);
      },
      getWindow: (): null => null,
    });

    const turnPromise = client.startTurn({
      text: 'Plan this change',
      cwd: '/tmp/repo',
      model: 'gpt-6-sol',
      thinkingLevel: 'high',
      planMode: true,
    });

    await flush();
    emitServerMessage(proc, {
      id: 1,
      result: { userAgent: 'ua', codexHome: '/tmp/.codex' },
    });
    await flush();
    emitServerMessage(proc, {
      id: 2,
      result: {
        thread: {
          id: 'thread-1',
          preview: '',
          ephemeral: false,
          modelProvider: 'openai',
          createdAt: 1,
          updatedAt: 1,
          status: { type: 'idle' },
          path: null,
          cwd: '/tmp/repo',
          cliVersion: '0.114.0',
          source: 'vscode',
          agentNickname: null,
          agentRole: null,
          gitInfo: null,
          name: null,
          turns: [],
        },
        model: 'gpt-6-sol',
        modelProvider: 'openai',
        serviceTier: null,
        cwd: '/tmp/repo',
        approvalPolicy: 'never',
        sandbox: { type: 'dangerFullAccess' },
        reasoningEffort: 'high',
      },
    });
    await flush();
    emitServerMessage(proc, {
      id: 3,
      result: {
        turn: { id: 'turn-1', items: [], status: 'inProgress', error: null },
      },
    });
    emitServerMessage(proc, {
      method: 'thread/tokenUsage/updated',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-before-resume',
        tokenUsage: {
          total: {
            totalTokens: 748_126,
            inputTokens: 700_000,
            cachedInputTokens: 40_000,
            outputTokens: 8_126,
            reasoningOutputTokens: 2_000,
          },
          last: {
            totalTokens: 81_659,
            inputTokens: 75_000,
            cachedInputTokens: 4_000,
            outputTokens: 2_659,
            reasoningOutputTokens: 1_000,
          },
          modelContextWindow: 258_400,
        },
      },
    });
    emitServerMessage(proc, {
      method: 'turn/started',
      params: {
        threadId: 'thread-1',
        turn: { id: 'turn-1', items: [], status: 'inProgress', error: null },
      },
    });
    emitServerMessage(proc, {
      method: 'item/started',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        item: {
          type: 'agentMessage',
          id: 'msg-1',
          text: '',
          phase: 'final_answer',
        },
      },
    });
    emitServerMessage(proc, {
      method: 'item/agentMessage/delta',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        itemId: 'msg-1',
        delta: '<proposed_plan>Ship it</proposed_plan>',
      },
    });
    emitServerMessage(proc, {
      method: 'thread/tokenUsage/updated',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        tokenUsage: {
          total: {
            totalTokens: 6,
            inputTokens: 4,
            cachedInputTokens: 1,
            outputTokens: 2,
            reasoningOutputTokens: 1,
          },
          last: {
            totalTokens: 6,
            inputTokens: 4,
            cachedInputTokens: 1,
            outputTokens: 2,
            reasoningOutputTokens: 1,
          },
          modelContextWindow: 200000,
        },
      },
    });
    emitServerMessage(proc, {
      method: 'thread/tokenUsage/updated',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        tokenUsage: {
          total: {
            totalTokens: 12,
            inputTokens: 10,
            cachedInputTokens: 2,
            outputTokens: 2,
            reasoningOutputTokens: 1,
          },
          last: {
            totalTokens: 6,
            inputTokens: 6,
            cachedInputTokens: 1,
            outputTokens: 0,
            reasoningOutputTokens: 0,
          },
          modelContextWindow: 200000,
        },
      },
    });
    emitServerMessage(proc, {
      method: 'turn/completed',
      params: {
        threadId: 'thread-1',
        turn: { id: 'turn-1', items: [], status: 'completed', error: null },
      },
    });

    const result = await turnPromise;

    expect(spawnMock).toHaveBeenCalledWith(
      '/mock/codex',
      ['app-server'],
      expect.objectContaining({
        cwd: process.cwd(),
        detached: true,
        windowsHide: true,
      }),
    );
    expect(result).toEqual({
      status: 'completed',
      usage: {
        input_tokens: 10,
        cached_input_tokens: 2,
        output_tokens: 2,
        reasoning_output_tokens: 1,
      },
      proposedPlanText: 'Ship it',
    });
    expect(events).toContainEqual({
      type: 'system',
      subtype: 'init',
      session_id: 'thread-1',
    });
    expect(events).toContainEqual({
      type: 'codex',
      event: {
        type: 'turn.completed',
        status: 'completed',
        thread_id: 'thread-1',
        turn_id: 'turn-1',
        usage: {
          input_tokens: 10,
          cached_input_tokens: 2,
          output_tokens: 2,
          reasoning_output_tokens: 1,
        },
      },
    });
    expect(events).toContainEqual({
      type: 'codex',
      event: {
        type: 'item.completed',
        thread_id: 'thread-1',
        turn_id: 'turn-1',
        item: {
          type: 'agent_message',
          id: 'msg-1',
          text: '<proposed_plan>Ship it</proposed_plan>',
          phase: 'final_answer',
        },
      },
    });
    expect(events).not.toContainEqual({
      type: 'codex',
      event: {
        type: 'item.started',
        thread_id: 'thread-1',
        turn_id: 'turn-1',
        item: {
          type: 'agent_message',
          id: 'msg-1',
          text: '',
          phase: 'final_answer',
        },
      },
    });
    expect(events).not.toContainEqual({
      type: 'codex',
      event: {
        type: 'item.updated',
        thread_id: 'thread-1',
        turn_id: 'turn-1',
        item: {
          type: 'agent_message',
          id: 'msg-1',
          text: '<proposed_plan>Ship it</proposed_plan>',
          phase: 'final_answer',
        },
      },
    });
  });

  it('falls back to native plan text when agent message lacks proposed_plan tags', async () => {
    const events: unknown[] = [];
    const client = new CodexAppServerClient({
      cwd: '/tmp/repo',
      projectId: 'project',
      worktreeId: 'worktree',
      chatId: 'chat',
      sessionKey: 'project/worktree/chat',
      onEvent: (event): void => {
        events.push(event);
      },
      getWindow: (): null => null,
    });

    const turnPromise = client.startTurn({
      text: 'Plan this change',
      cwd: '/tmp/repo',
      model: 'gpt-6-sol',
      thinkingLevel: 'high',
      planMode: true,
    });

    await flush();
    emitServerMessage(proc, {
      id: 1,
      result: { userAgent: 'ua', codexHome: '/tmp/.codex' },
    });
    await flush();
    emitServerMessage(proc, {
      id: 2,
      result: {
        thread: {
          id: 'thread-1',
          preview: '',
          ephemeral: false,
          modelProvider: 'openai',
          createdAt: 1,
          updatedAt: 1,
          status: { type: 'idle' },
          path: null,
          cwd: '/tmp/repo',
          cliVersion: '0.114.0',
          source: 'vscode',
          agentNickname: null,
          agentRole: null,
          gitInfo: null,
          name: null,
          turns: [],
        },
        model: 'gpt-6-sol',
        modelProvider: 'openai',
        serviceTier: null,
        cwd: '/tmp/repo',
        approvalPolicy: 'never',
        sandbox: { type: 'dangerFullAccess' },
        reasoningEffort: 'high',
      },
    });
    await flush();
    emitServerMessage(proc, {
      id: 3,
      result: {
        turn: { id: 'turn-1', items: [], status: 'inProgress', error: null },
      },
    });
    // Agent message without <proposed_plan> tags
    emitServerMessage(proc, {
      method: 'item/started',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        item: {
          type: 'agentMessage',
          id: 'msg-1',
          text: '',
          phase: 'final_answer',
        },
      },
    });
    emitServerMessage(proc, {
      method: 'item/agentMessage/delta',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        itemId: 'msg-1',
        delta: 'Here is my implementation plan.',
      },
    });
    // Plan arrives via native plan item instead of <proposed_plan> tags
    emitServerMessage(proc, {
      method: 'item/plan/delta',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        itemId: 'plan-1',
        delta: '# Refactor auth module\n\n## Phase 1\n1. Extract middleware',
      },
    });
    emitServerMessage(proc, {
      method: 'turn/completed',
      params: {
        threadId: 'thread-1',
        turn: { id: 'turn-1', items: [], status: 'completed', error: null },
      },
    });

    const result = await turnPromise;

    expect(result).toMatchObject({
      status: 'completed',
      proposedPlanText:
        '# Refactor auth module\n\n## Phase 1\n1. Extract middleware',
    });
  });

  it('sends structured markdown planning instructions in plan mode', async () => {
    const client = new CodexAppServerClient({
      cwd: '/tmp/repo',
      projectId: 'project',
      worktreeId: 'worktree',
      chatId: 'chat',
      sessionKey: 'project/worktree/chat',
      onEvent: jest.fn(),
      getWindow: (): null => null,
    });

    const turnPromise = client.startTurn({
      text: 'Plan this change',
      cwd: '/tmp/repo',
      model: 'gpt-6-sol',
      thinkingLevel: 'high',
      planMode: true,
      proposalMode: 'required',
    });

    await flush();
    emitServerMessage(proc, {
      id: 1,
      result: { userAgent: 'ua', codexHome: '/tmp/.codex' },
    });
    await flush();
    emitServerMessage(proc, {
      id: 2,
      result: {
        thread: {
          id: 'thread-1',
          preview: '',
          ephemeral: false,
          modelProvider: 'openai',
          createdAt: 1,
          updatedAt: 1,
          status: { type: 'idle' },
          path: null,
          cwd: '/tmp/repo',
          cliVersion: '0.114.0',
          source: 'vscode',
          agentNickname: null,
          agentRole: null,
          gitInfo: null,
          name: null,
          turns: [],
        },
        model: 'gpt-6-sol',
        modelProvider: 'openai',
        serviceTier: null,
        cwd: '/tmp/repo',
        approvalPolicy: 'never',
        sandbox: { type: 'dangerFullAccess' },
        reasoningEffort: 'high',
      },
    });
    await flush();

    const messages = collectClientMessages(proc);
    const turnStartMessage = messages.find(
      (message) => message['method'] === 'turn/start',
    );
    if (!turnStartMessage) {
      throw new Error('Expected turn/start request');
    }

    const params = turnStartMessage['params'];
    if (!isRecord(params)) {
      throw new Error('Expected turn/start params');
    }

    const collaborationMode = params['collaborationMode'];
    if (!isRecord(collaborationMode)) {
      throw new Error('Expected collaborationMode');
    }

    const settings = collaborationMode['settings'];
    if (!isRecord(settings)) {
      throw new Error('Expected collaborationMode settings');
    }

    const developerInstructions = settings['developer_instructions'];
    if (typeof developerInstructions !== 'string') {
      throw new Error('Expected developer instructions');
    }

    expect(collaborationMode['mode']).toBe('plan');
    expect(developerInstructions).toContain(
      'Markdown with a top-level title and proper section headers',
    );
    expect(developerInstructions).toContain(
      'treat it as the only artifact the implementation agent will receive',
    );
    expect(developerInstructions).toContain(
      'Do not assume the implementer has any context outside of the plan itself or access to the earlier planning conversation',
    );
    expect(developerInstructions).toContain(
      'Include every user-approved product and UX detail directly in the plan',
    );
    expect(developerInstructions).toContain(
      'visible copy, labels, headings, button text, helper text, empty states, loading states, error states, layout structure, interaction behavior',
    );
    expect(developerInstructions).toContain(
      'Never rely on phrases like "as discussed above" or "follow the agreed approach" without restating the actual decision',
    );
    expect(developerInstructions).toContain(
      'Do not leave placeholders or vague instructions where concrete implementation detail is required',
    );
    expect(developerInstructions).toContain('"## Key Decisions"');
    expect(developerInstructions).toContain('phases using clear phase headers');
    expect(developerInstructions).toContain(
      'Break each phase into sequential implementation steps using an ordered list.',
    );
    expect(developerInstructions).toContain(
      'what is sequential, what is parallelizable',
    );
    expect(developerInstructions).toContain(
      'specific files to update, create, or remove',
    );
    expect(developerInstructions).toContain('"## Verifications"');
    expect(developerInstructions).toContain(
      'automated tests the agent should run and manual checks a human should perform',
    );
    expect(developerInstructions).toContain('"## Risks"');
    expect(developerInstructions).toContain(
      'Your final response must include a complete updated implementation plan inside <proposed_plan>...</proposed_plan>.',
    );
    expect(developerInstructions).toContain(
      'That block must be fully implementation-ready and contain every detail needed to execute the work without referring back to the planning conversation.',
    );

    emitServerMessage(proc, {
      id: 3,
      result: {
        turn: { id: 'turn-1', items: [], status: 'inProgress', error: null },
      },
    });
    emitServerMessage(proc, {
      method: 'turn/completed',
      params: {
        threadId: 'thread-1',
        turn: { id: 'turn-1', items: [], status: 'completed', error: null },
      },
    });

    await expect(turnPromise).resolves.toMatchObject({
      status: 'completed',
    });
  });

  it('does not duplicate agent message completion events when the server sends item/completed', async () => {
    const events: unknown[] = [];
    const client = new CodexAppServerClient({
      cwd: '/tmp/repo',
      projectId: 'project',
      worktreeId: 'worktree',
      chatId: 'chat',
      sessionKey: 'project/worktree/chat',
      onEvent: (event): void => {
        events.push(event);
      },
      getWindow: (): null => null,
    });

    const turnPromise = client.startTurn({
      text: 'Respond once',
      cwd: '/tmp/repo',
      model: 'gpt-6-sol',
      thinkingLevel: 'high',
      planMode: false,
    });

    await flush();
    emitServerMessage(proc, {
      id: 1,
      result: { userAgent: 'ua', codexHome: '/tmp/.codex' },
    });
    await flush();
    emitServerMessage(proc, {
      id: 2,
      result: {
        thread: {
          id: 'thread-1',
          preview: '',
          ephemeral: false,
          modelProvider: 'openai',
          createdAt: 1,
          updatedAt: 1,
          status: { type: 'idle' },
          path: null,
          cwd: '/tmp/repo',
          cliVersion: '0.114.0',
          source: 'vscode',
          agentNickname: null,
          agentRole: null,
          gitInfo: null,
          name: null,
          turns: [],
        },
        model: 'gpt-6-sol',
        modelProvider: 'openai',
        serviceTier: null,
        cwd: '/tmp/repo',
        approvalPolicy: 'never',
        sandbox: { type: 'dangerFullAccess' },
        reasoningEffort: 'high',
      },
    });
    await flush();
    emitServerMessage(proc, {
      id: 3,
      result: {
        turn: { id: 'turn-1', items: [], status: 'inProgress', error: null },
      },
    });
    emitServerMessage(proc, {
      method: 'item/started',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        item: {
          type: 'agentMessage',
          id: 'msg-1',
          text: '',
          phase: 'final_answer',
        },
      },
    });
    emitServerMessage(proc, {
      method: 'item/agentMessage/delta',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        itemId: 'msg-1',
        delta: 'Final answer',
      },
    });
    emitServerMessage(proc, {
      method: 'item/completed',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        item: {
          type: 'agentMessage',
          id: 'msg-1',
          text: 'Final answer',
          phase: 'final_answer',
        },
      },
    });
    emitServerMessage(proc, {
      method: 'turn/completed',
      params: {
        threadId: 'thread-1',
        turn: {
          id: 'turn-1',
          items: [
            {
              type: 'agentMessage',
              id: 'msg-1',
              text: 'Final answer',
              phase: 'final_answer',
            },
          ],
          status: 'completed',
          error: null,
        },
      },
    });

    await turnPromise;

    const completionEvents = events.filter((event): boolean => {
      if (!isRecord(event)) {
        return false;
      }
      const outerType = event.type;
      if (outerType !== 'codex') {
        return false;
      }
      const inner = event.event;
      if (!isRecord(inner)) {
        return false;
      }
      return inner.type === 'item.completed';
    });

    expect(completionEvents).toHaveLength(1);
  });

  it('emits final assistant text carried only by turn completion items', async () => {
    const events: unknown[] = [];
    const client = createClient(events);
    const { turnPromise } = await startActiveTurn(client, proc);

    emitServerMessage(proc, {
      method: 'turn/completed',
      params: {
        threadId: 'thread-1',
        turn: {
          id: 'turn-1',
          items: [
            {
              type: 'agentMessage',
              id: 'msg-1',
              text: 'Visible answer',
              phase: 'final_answer',
            },
          ],
          status: 'completed',
          error: null,
        },
      },
    });

    await expect(turnPromise).resolves.toMatchObject({ status: 'completed' });

    const codexEvents: Record<string, unknown>[] = [];
    for (const event of events) {
      if (!isRecord(event) || event.type !== 'codex') {
        continue;
      }
      if (!isRecord(event.event)) {
        continue;
      }
      codexEvents.push(event.event);
    }

    const completionIndex = codexEvents.findIndex((event): boolean => {
      if (event.type !== 'item.completed') {
        return false;
      }
      if (!isRecord(event.item)) {
        return false;
      }
      return event.item.id === 'msg-1';
    });
    const turnCompletedIndex = codexEvents.findIndex(
      (event): boolean => event.type === 'turn.completed',
    );

    expect(completionIndex).toBeGreaterThanOrEqual(0);
    expect(turnCompletedIndex).toBeGreaterThan(completionIndex);
    expect(codexEvents[completionIndex]).toEqual({
      type: 'item.completed',
      thread_id: 'thread-1',
      turn_id: 'turn-1',
      item: {
        type: 'agent_message',
        id: 'msg-1',
        text: 'Visible answer',
        phase: 'final_answer',
      },
    });
  });

  it('buffers reasoning text until completion so empty thinking blocks are never emitted', async () => {
    const events: unknown[] = [];
    const client = new CodexAppServerClient({
      cwd: '/tmp/repo',
      projectId: 'project',
      worktreeId: 'worktree',
      chatId: 'chat',
      sessionKey: 'project/worktree/chat',
      onEvent: (event): void => {
        events.push(event);
      },
      getWindow: (): null => null,
    });

    const turnPromise = client.startTurn({
      text: 'Think first',
      cwd: '/tmp/repo',
      model: 'gpt-6-sol',
      thinkingLevel: 'high',
      planMode: false,
    });

    await flush();
    emitServerMessage(proc, {
      id: 1,
      result: { userAgent: 'ua', codexHome: '/tmp/.codex' },
    });
    await flush();
    emitServerMessage(proc, {
      id: 2,
      result: {
        thread: {
          id: 'thread-1',
          preview: '',
          ephemeral: false,
          modelProvider: 'openai',
          createdAt: 1,
          updatedAt: 1,
          status: { type: 'idle' },
          path: null,
          cwd: '/tmp/repo',
          cliVersion: '0.114.0',
          source: 'vscode',
          agentNickname: null,
          agentRole: null,
          gitInfo: null,
          name: null,
          turns: [],
        },
        model: 'gpt-6-sol',
        modelProvider: 'openai',
        serviceTier: null,
        cwd: '/tmp/repo',
        approvalPolicy: 'never',
        sandbox: { type: 'dangerFullAccess' },
        reasoningEffort: 'high',
      },
    });
    await flush();
    emitServerMessage(proc, {
      id: 3,
      result: {
        turn: { id: 'turn-1', items: [], status: 'inProgress', error: null },
      },
    });
    emitServerMessage(proc, {
      method: 'item/started',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        item: {
          type: 'reasoning',
          id: 'reason-1',
          summary: [],
          content: [],
        },
      },
    });
    emitServerMessage(proc, {
      method: 'item/reasoning/textDelta',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        itemId: 'reason-1',
        delta: 'Investigating the repo',
      },
    });
    emitServerMessage(proc, {
      method: 'turn/completed',
      params: {
        threadId: 'thread-1',
        turn: { id: 'turn-1', items: [], status: 'completed', error: null },
      },
    });

    await turnPromise;

    expect(events).toContainEqual({
      type: 'codex',
      event: {
        type: 'item.completed',
        thread_id: 'thread-1',
        turn_id: 'turn-1',
        item: {
          type: 'reasoning',
          id: 'reason-1',
          text: 'Investigating the repo',
        },
      },
    });
    expect(events).not.toContainEqual({
      type: 'codex',
      event: {
        type: 'item.started',
        thread_id: 'thread-1',
        turn_id: 'turn-1',
        item: {
          type: 'reasoning',
          id: 'reason-1',
          text: '',
        },
      },
    });
    expect(events).not.toContainEqual({
      type: 'codex',
      event: {
        type: 'item.updated',
        thread_id: 'thread-1',
        turn_id: 'turn-1',
        item: {
          type: 'reasoning',
          id: 'reason-1',
          text: 'Investigating the repo',
        },
      },
    });
  });

  it('drops explicitly completed reasoning items when they contain no text', async () => {
    const events: unknown[] = [];
    const client = createClient(events);
    const { turnPromise } = await startActiveTurn(client, proc);

    emitServerMessage(proc, {
      method: 'item/completed',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        item: {
          type: 'reasoning',
          id: 'reason-empty',
          summary: [],
          content: [],
        },
      },
    });
    completeRootTurn(proc);

    await expect(turnPromise).resolves.toMatchObject({ status: 'completed' });

    const emptyReasoningEvents = events.filter((event): boolean => {
      if (!isRecord(event) || event.type !== 'codex') {
        return false;
      }
      if (!isRecord(event.event) || event.event.type !== 'item.completed') {
        return false;
      }
      if (!isRecord(event.event.item)) {
        return false;
      }
      return event.event.item.id === 'reason-empty';
    });

    expect(emptyReasoningEvents).toHaveLength(0);
  });

  it('falls back to reasoning summary deltas when no full reasoning text arrives', async () => {
    const events: unknown[] = [];
    const client = new CodexAppServerClient({
      cwd: '/tmp/repo',
      projectId: 'project',
      worktreeId: 'worktree',
      chatId: 'chat',
      sessionKey: 'project/worktree/chat',
      onEvent: (event): void => {
        events.push(event);
      },
      getWindow: (): null => null,
    });

    const turnPromise = client.startTurn({
      text: 'Summarize your reasoning',
      cwd: '/tmp/repo',
      model: 'gpt-6-sol',
      thinkingLevel: 'high',
      planMode: false,
    });

    await flush();
    emitServerMessage(proc, {
      id: 1,
      result: {
        userAgent: 'ua',
        codexHome: '/tmp/.codex',
        platformFamily: 'unix',
        platformOs: 'macos',
      },
    });
    await flush();
    emitServerMessage(proc, {
      id: 2,
      result: {
        thread: {
          id: 'thread-1',
          preview: '',
          ephemeral: false,
          modelProvider: 'openai',
          createdAt: 1,
          updatedAt: 1,
          status: { type: 'idle' },
          path: null,
          cwd: '/tmp/repo',
          cliVersion: '0.116.0',
          source: 'vscode',
          agentNickname: null,
          agentRole: null,
          gitInfo: null,
          name: null,
          turns: [],
        },
        model: 'gpt-6-sol',
        modelProvider: 'openai',
        serviceTier: null,
        cwd: '/tmp/repo',
        approvalPolicy: 'never',
        approvalsReviewer: 'user',
        sandbox: { type: 'dangerFullAccess' },
        reasoningEffort: 'high',
      },
    });
    await flush();
    emitServerMessage(proc, {
      id: 3,
      result: {
        turn: { id: 'turn-1', items: [], status: 'inProgress', error: null },
      },
    });
    emitServerMessage(proc, {
      method: 'item/started',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        item: {
          type: 'reasoning',
          id: 'reason-1',
          summary: [],
          content: [],
        },
      },
    });
    emitServerMessage(proc, {
      method: 'item/reasoning/summaryTextDelta',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        itemId: 'reason-1',
        delta: 'Repo scan complete',
        summaryIndex: 0,
      },
    });
    emitServerMessage(proc, {
      method: 'item/completed',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        item: {
          type: 'reasoning',
          id: 'reason-1',
          summary: [],
          content: [],
        },
      },
    });
    emitServerMessage(proc, {
      method: 'turn/completed',
      params: {
        threadId: 'thread-1',
        turn: { id: 'turn-1', items: [], status: 'completed', error: null },
      },
    });

    await turnPromise;

    expect(events).toContainEqual({
      type: 'codex',
      event: {
        type: 'item.completed',
        thread_id: 'thread-1',
        turn_id: 'turn-1',
        item: {
          type: 'reasoning',
          id: 'reason-1',
          text: 'Repo scan complete',
        },
      },
    });
  });

  it('routes request_user_input through the existing ask-user UI and replies over JSON-RPC', async () => {
    createPendingRequestMock.mockResolvedValue([
      {
        questionId: 'q1',
        question: 'Pick one',
        selectedOptions: ['Option A'],
        freeformText: 'extra context',
      },
      {
        questionId: 'q2',
        question: 'Secret value',
        selectedOptions: [],
        freeformText: 'super-secret-token',
      },
    ]);

    const win: SendableBrowserWindow = {
      isDestroyed: (): boolean => false,
      webContents: {
        isCrashed: (): boolean => false,
        isDestroyed: (): boolean => false,
        mainFrame: {
          detached: false,
          isDestroyed: (): boolean => false,
        },
        send: jest.fn(),
      },
    };

    const events: unknown[] = [];
    const client = new CodexAppServerClient({
      cwd: '/tmp/repo',
      projectId: 'project',
      worktreeId: 'worktree',
      chatId: 'chat',
      sessionKey: 'project/worktree/chat',
      onEvent: (event): void => {
        events.push(event);
      },
      getWindow: (): SendableBrowserWindow => win,
    });

    const turnPromise = client.startTurn({
      text: 'Clarify this',
      cwd: '/tmp/repo',
      model: 'gpt-6-sol',
      thinkingLevel: 'high',
      planMode: true,
    });

    await flush();
    emitServerMessage(proc, {
      id: 1,
      result: { userAgent: 'ua', codexHome: '/tmp/.codex' },
    });
    await flush();
    emitServerMessage(proc, {
      id: 2,
      result: {
        thread: {
          id: 'thread-1',
          preview: '',
          ephemeral: false,
          modelProvider: 'openai',
          createdAt: 1,
          updatedAt: 1,
          status: { type: 'idle' },
          path: null,
          cwd: '/tmp/repo',
          cliVersion: '0.114.0',
          source: 'vscode',
          agentNickname: null,
          agentRole: null,
          gitInfo: null,
          name: null,
          turns: [],
        },
        model: 'gpt-6-sol',
        modelProvider: 'openai',
        serviceTier: null,
        cwd: '/tmp/repo',
        approvalPolicy: 'never',
        sandbox: { type: 'dangerFullAccess' },
        reasoningEffort: 'high',
      },
    });
    await flush();
    emitServerMessage(proc, {
      id: 3,
      result: {
        turn: { id: 'turn-1', items: [], status: 'inProgress', error: null },
      },
    });
    emitServerMessage(proc, {
      id: 'server-req-1',
      method: 'item/tool/requestUserInput',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        itemId: 'item-1',
        questions: [
          {
            id: 'q1',
            header: 'Choice',
            question: 'Pick one',
            isOther: true,
            isSecret: false,
            options: [
              { label: 'Option A', description: 'First option' },
              { label: 'Option B', description: 'Second option' },
            ],
          },
          {
            id: 'q2',
            header: 'Secret',
            question: 'Secret value',
            isOther: true,
            isSecret: true,
            options: null,
          },
        ],
      },
    });
    emitServerMessage(proc, {
      method: 'turn/completed',
      params: {
        threadId: 'thread-1',
        turn: { id: 'turn-1', items: [], status: 'completed', error: null },
      },
    });

    await turnPromise;
    await flush();

    expect(win.webContents.send).toHaveBeenCalledWith(
      IPC_CHANNELS.mcpAskUser,
      expect.objectContaining({
        projectId: 'project',
        worktreeId: 'worktree',
        chatId: 'chat',
        requestId: 'generated-request-id',
        toolUseId: 'codex-item-1',
        questions: [
          {
            id: 'q1',
            header: 'Choice',
            question: 'Pick one',
            options: ['Option A', 'Option B'],
            optionDescriptions: ['First option', 'Second option'],
            allowOther: true,
            secret: false,
          },
          {
            id: 'q2',
            header: 'Secret',
            question: 'Secret value',
            options: [],
            optionDescriptions: [],
            allowOther: true,
            secret: true,
          },
        ],
      }),
    );

    const messages = collectClientMessages(proc);
    expect(messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'server-req-1',
          result: {
            answers: {
              q1: {
                answers: ['Option A', 'extra context'],
              },
              q2: {
                answers: ['super-secret-token'],
              },
            },
          },
        }),
      ]),
    );
    expect(events).toEqual(
      expect.arrayContaining([
        {
          type: 'codex',
          event: {
            type: 'item.started',
            thread_id: 'thread-1',
            turn_id: 'turn-1',
            item: {
              type: 'dynamic_tool_call',
              id: 'item-1',
              namespace: null,
              tool: 'request_user_input',
              arguments: {
                questions: [
                  {
                    id: 'q1',
                    header: 'Choice',
                    question: 'Pick one',
                    isOther: true,
                    isSecret: false,
                    options: [
                      { label: 'Option A', description: 'First option' },
                      { label: 'Option B', description: 'Second option' },
                    ],
                  },
                  {
                    id: 'q2',
                    header: 'Secret',
                    question: 'Secret value',
                    isOther: true,
                    isSecret: true,
                    options: null,
                  },
                ],
              },
              status: 'in_progress',
              content_items: null,
              success: null,
            },
          },
        },
        {
          type: 'codex',
          event: {
            type: 'item.completed',
            thread_id: 'thread-1',
            turn_id: 'turn-1',
            item: {
              type: 'dynamic_tool_call',
              id: 'item-1',
              namespace: null,
              tool: 'request_user_input',
              arguments: {
                questions: [
                  {
                    id: 'q1',
                    header: 'Choice',
                    question: 'Pick one',
                    isOther: true,
                    isSecret: false,
                    options: [
                      { label: 'Option A', description: 'First option' },
                      { label: 'Option B', description: 'Second option' },
                    ],
                  },
                  {
                    id: 'q2',
                    header: 'Secret',
                    question: 'Secret value',
                    isOther: true,
                    isSecret: true,
                    options: null,
                  },
                ],
              },
              status: 'completed',
              content_items: [
                {
                  type: 'inputText',
                  text:
                    'Q: Pick one\nA: Option A\nAdditional: extra context\n\n' +
                    'Q: Secret value\nA: \nAdditional: [hidden]',
                },
              ],
              success: true,
            },
          },
        },
      ]),
    );
  });

  it('serves currentTime/read server requests with whole unix seconds', async () => {
    const nowMs = new Date('2026-06-23T12:34:56.789Z').getTime();
    const dateNowSpy = jest.spyOn(Date, 'now').mockReturnValue(nowMs);

    try {
      const client = new CodexAppServerClient({
        cwd: '/tmp/repo',
        projectId: 'project',
        worktreeId: 'worktree',
        chatId: 'chat',
        sessionKey: 'project/worktree/chat',
        onEvent: jest.fn(),
        getWindow: (): null => null,
      });

      const turnPromise = client.startTurn({
        text: 'Need the time',
        cwd: '/tmp/repo',
        model: 'gpt-6-sol',
        thinkingLevel: 'high',
        planMode: false,
      });

      await flush();
      emitServerMessage(proc, {
        id: 1,
        result: { userAgent: 'ua', codexHome: '/tmp/.codex' },
      });
      await flush();
      emitServerMessage(proc, {
        id: 2,
        result: makeThreadResult('thread-1'),
      });
      await flush();
      emitServerMessage(proc, {
        id: 3,
        result: {
          turn: { id: 'turn-1', items: [], status: 'inProgress', error: null },
        },
      });
      emitServerMessage(proc, {
        id: 'server-req-1',
        method: 'currentTime/read',
        params: { threadId: 'thread-1' },
      });
      await flush();

      const messages = collectClientMessages(proc);
      expect(messages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: 'server-req-1',
            result: { currentTimeAt: Math.floor(nowMs / 1000) },
          }),
        ]),
      );

      emitServerMessage(proc, {
        method: 'turn/completed',
        params: {
          threadId: 'thread-1',
          turn: { id: 'turn-1', items: [], status: 'completed', error: null },
        },
      });

      await expect(turnPromise).resolves.toMatchObject({
        status: 'completed',
      });
    } finally {
      dateNowSpy.mockRestore();
    }
  });

  it('includes dynamicTools on thread/start and serves dynamic ask-user calls', async () => {
    createPendingRequestMock.mockResolvedValue([
      {
        question: 'Pick one',
        selectedOptions: ['Option A'],
      },
    ]);

    const win: SendableBrowserWindow = {
      isDestroyed: (): boolean => false,
      webContents: {
        isCrashed: (): boolean => false,
        isDestroyed: (): boolean => false,
        mainFrame: {
          detached: false,
          isDestroyed: (): boolean => false,
        },
        send: jest.fn(),
      },
    };
    const events: unknown[] = [];
    const runtime: CanopyInjectedToolRuntime = {
      requestUserAnswers: (questions, options) =>
        requestAnswersFromRenderer({
          sessionKey: 'project/worktree/chat',
          projectId: 'project',
          worktreeId: 'worktree',
          chatId: 'chat',
          questions,
          getWindow: (): SendableBrowserWindow => win,
          toolUseId: options?.toolUseId,
        }),
      loadScriptOutput: jest.fn(),
    };

    const onNativeReceipt = jest.fn();
    const client = new CodexAppServerClient({
      cwd: '/tmp/repo',
      projectId: 'project',
      worktreeId: 'worktree',
      chatId: 'chat',
      sessionKey: 'project/worktree/chat',
      onEvent: (event): void => {
        events.push(event);
      },
      getWindow: (): SendableBrowserWindow => win,
      onDynamicToolResultAccepted: onNativeReceipt,
      dynamicTools: buildCanopyDynamicToolSpecs({ includeChatVisuals: false }),
      dynamicToolCallHandler: (
        params,
      ): ReturnType<typeof handleCanopyDynamicToolCall> =>
        handleCanopyDynamicToolCall(params, runtime),
    });

    const turnPromise = client.startTurn({
      text: 'Use a dynamic tool',
      cwd: '/tmp/repo',
      model: 'gpt-6-sol',
      thinkingLevel: 'high',
      planMode: false,
    });

    await flush();
    emitServerMessage(proc, {
      id: 1,
      result: { userAgent: 'ua', codexHome: '/tmp/.codex' },
    });
    await flush();
    let messages = collectClientMessages(proc);
    const threadStart = messages.find(
      (message) => message.method === 'thread/start',
    );
    if (!threadStart || !isRecord(threadStart.params)) {
      throw new Error('Expected thread/start with params');
    }
    expect(threadStart.params.dynamicTools).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'canopy_ask_user_question' }),
        expect.objectContaining({ name: 'canopy_get_script_output' }),
        expect.objectContaining({ name: 'canopy_read_pipeline_yaml' }),
        expect.objectContaining({ name: 'canopy_search_actions' }),
        expect.objectContaining({ name: 'canopy_dispatch_action' }),
        expect.objectContaining({ name: 'canopy_search_watchers' }),
        expect.objectContaining({ name: 'canopy_setup_watchers' }),
        expect.objectContaining({ name: 'canopy_set_auto_archive' }),
      ]),
    );

    emitServerMessage(proc, {
      id: 2,
      result: {
        thread: {
          id: 'thread-1',
          preview: '',
          ephemeral: false,
          modelProvider: 'openai',
          createdAt: 1,
          updatedAt: 1,
          status: { type: 'idle' },
          path: null,
          cwd: '/tmp/repo',
          cliVersion: '0.114.0',
          source: 'vscode',
          agentNickname: null,
          agentRole: null,
          gitInfo: null,
          name: null,
          turns: [],
        },
        model: 'gpt-6-sol',
        modelProvider: 'openai',
        serviceTier: null,
        cwd: '/tmp/repo',
        approvalPolicy: 'never',
        sandbox: { type: 'dangerFullAccess' },
        reasoningEffort: 'high',
      },
    });
    await flush();
    emitServerMessage(proc, {
      id: 3,
      result: {
        turn: { id: 'turn-1', items: [], status: 'inProgress', error: null },
      },
    });
    emitServerMessage(proc, {
      id: 'server-req-1',
      method: 'item/tool/call',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        callId: 'call-1',
        namespace: null,
        tool: 'canopy_ask_user_question',
        arguments: {
          questions: [{ question: 'Pick one', options: ['Option A'] }],
        },
      },
    });
    await flush();
    expect(onNativeReceipt).not.toHaveBeenCalled();
    for (const native of [
      { threadId: 'foreign-thread', turnId: 'turn-1' },
      { threadId: 'thread-1', turnId: 'stale-turn' },
    ])
      emitServerMessage(proc, {
        method: 'item/completed',
        params: {
          ...native,
          item: {
            type: 'dynamicToolCall',
            id: 'call-1',
            tool: 'canopy_ask_user_question',
            status: 'completed',
            success: true,
            contentItems: [],
          },
        },
      });
    expect(onNativeReceipt).not.toHaveBeenCalled();
    emitServerMessage(proc, {
      method: 'item/completed',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        item: {
          type: 'dynamicToolCall',
          id: 'call-1',
          namespace: null,
          tool: 'canopy_ask_user_question',
          arguments: {
            questions: [{ question: 'Pick one', options: ['Option A'] }],
          },
          status: 'completed',
          contentItems: [
            { type: 'inputText', text: 'Q: Pick one\nA: Option A' },
          ],
          success: true,
        },
      },
    });
    expect(onNativeReceipt).toHaveBeenCalledTimes(1);
    expect(onNativeReceipt).toHaveBeenCalledWith({
      callId: 'call-1',
      threadId: 'thread-1',
      turnId: 'turn-1',
    });
    emitServerMessage(proc, {
      method: 'turn/completed',
      params: {
        threadId: 'thread-1',
        turn: { id: 'turn-1', items: [], status: 'completed', error: null },
      },
    });

    await turnPromise;
    await flush();

    expect(win.webContents.send).toHaveBeenCalledWith(
      IPC_CHANNELS.mcpAskUser,
      expect.objectContaining({
        requestId: 'generated-request-id',
        toolUseId: 'codex-call-1',
      }),
    );
    messages = collectClientMessages(proc);
    expect(messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'server-req-1',
          result: {
            contentItems: [
              { type: 'inputText', text: 'Q: Pick one\nA: Option A' },
            ],
            success: true,
          },
        }),
      ]),
    );
    expect(events).toContainEqual({
      type: 'codex',
      event: {
        type: 'item.completed',
        thread_id: 'thread-1',
        turn_id: 'turn-1',
        item: {
          type: 'dynamic_tool_call',
          id: 'call-1',
          namespace: null,
          tool: 'canopy_ask_user_question',
          arguments: {
            questions: [{ question: 'Pick one', options: ['Option A'] }],
          },
          status: 'completed',
          content_items: [
            { type: 'inputText', text: 'Q: Pick one\nA: Option A' },
          ],
          success: true,
        },
      },
    });
  });

  it.each([
    {
      mode: 'the branded Canopy tool',
      loadDeferredToolsName: 'unstoppable-code_load_deferred_tools',
      overrideCanopyToolName: true,
    },
    {
      mode: 'App Advisor',
      loadDeferredToolsName:
        APP_ADVISOR_TOOL_REGISTRY.load_deferred_tools.codexToolName,
      overrideCanopyToolName: false,
    },
    {
      mode: 'Pipeline Editor',
      loadDeferredToolsName:
        PIPELINE_EDITOR_TOOL_REGISTRY.load_deferred_tools.codexToolName,
      overrideCanopyToolName: false,
    },
  ])(
    'waits for Codex to drain $mode deferred-tools result before reloading and interrupting',
    async ({ loadDeferredToolsName, overrideCanopyToolName }) => {
      if (overrideCanopyToolName) {
        CANOPY_INJECTED_TOOL_REGISTRY.load_deferred_tools.codexToolName =
          loadDeferredToolsName;
      }
      const markToolResultDelivered = jest.spyOn(
        deferredToolsReloadCoordinator,
        'markToolResultDelivered',
      );
      const dynamicToolCallHandler = jest.fn().mockResolvedValue({
        contentItems: [{ type: 'inputText', text: '{"status":"success"}' }],
        success: true,
      });
      const client = new CodexAppServerClient({
        cwd: '/tmp/repo',
        projectId: 'project',
        worktreeId: 'worktree',
        chatId: 'chat',
        sessionKey: 'project/worktree/chat',
        onEvent: jest.fn(),
        getWindow: (): null => null,
        dynamicTools: buildCanopyDynamicToolSpecs({
          includeChatVisuals: false,
        }),
        dynamicToolCallHandler,
      });
      const { turnPromise } = await startActiveTurn(client, proc);
      const intent = deferredToolsReloadCoordinator.createIntent({
        scope: {
          projectId: 'project',
          worktreeId: 'worktree',
          chatId: 'chat',
        },
        toolCallId: 'codex-call-reload',
        providerType: 'codex',
        interfaceMode: 'canopy',
        additions: {
          skillRefs: [{ sourceId: 'source', skillName: 'skill' }],
          pluginRefs: [],
          mcpServerRefs: [],
        },
        enabledResources: [
          {
            ref: 'deferred:v1:skill',
            kind: 'skill',
            name: 'skill',
          },
        ],
      });
      expect(intent.accepted).toBe(true);

      emitServerMessage(proc, {
        id: 'server-req-reload',
        method: 'item/tool/call',
        params: {
          threadId: 'thread-1',
          turnId: 'turn-1',
          callId: 'call-reload',
          namespace: null,
          tool: loadDeferredToolsName,
          arguments: { items: [{ ref: 'deferred:v1:skill' }] },
        },
      });
      const resultMessages = await waitForClientResponse(
        proc,
        'server-req-reload',
      );
      const resultIndex = resultMessages.findIndex(
        (message) => message.id === 'server-req-reload',
      );
      expect(resultIndex).toBeGreaterThanOrEqual(0);
      expect(
        resultMessages.some((message) => message.method === 'turn/interrupt'),
      ).toBe(false);
      expect(resultMessages[resultIndex]).toMatchObject({
        result: {
          contentItems: [{ type: 'inputText', text: '{"status":"success"}' }],
          success: true,
        },
      });
      expect(markToolResultDelivered).not.toHaveBeenCalled();

      emitServerMessage(proc, {
        method: 'item/completed',
        params: {
          threadId: 'thread-1',
          turnId: 'turn-1',
          item: {
            id: 'call-reload',
            type: 'dynamicToolCall',
            namespace: null,
            tool: loadDeferredToolsName,
            arguments: { items: [{ ref: 'deferred:v1:skill' }] },
            status: 'completed',
            contentItems: [{ type: 'inputText', text: '{"status":"success"}' }],
            success: true,
          },
        },
      });
      await flush();
      expect(markToolResultDelivered).not.toHaveBeenCalled();
      expect(
        collectClientMessages(proc).some(
          (message) => message.method === 'turn/interrupt',
        ),
      ).toBe(false);

      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(markToolResultDelivered).toHaveBeenCalledWith(
        {
          projectId: 'project',
          worktreeId: 'worktree',
          chatId: 'chat',
        },
        'codex-call-reload',
      );
      const interruptMessages = collectClientMessages(proc);
      const interruptMessage = interruptMessages.find(
        (message) => message.method === 'turn/interrupt',
      );
      expect(interruptMessage).toMatchObject({
        method: 'turn/interrupt',
        params: { threadId: 'thread-1', turnId: 'turn-1' },
      });

      emitServerMessage(proc, {
        id: interruptMessage?.id,
        result: {},
      });
      emitServerMessage(proc, {
        method: 'turn/completed',
        params: {
          threadId: 'thread-1',
          turn: {
            id: 'turn-1',
            items: [],
            status: 'interrupted',
            error: null,
          },
        },
      });
      await expect(turnPromise).resolves.toMatchObject({
        status: 'interrupted',
      });
    },
  );

  it('restarts an interrupted turn internally after ImmediateTurnRestart without emitting an intermediate completion', async () => {
    const events: unknown[] = [];
    const client = new CodexAppServerClient({
      cwd: '/tmp/repo',
      projectId: 'project',
      worktreeId: 'worktree',
      chatId: 'chat',
      sessionKey: 'project/worktree/chat',
      onEvent: (event): void => {
        events.push(event);
      },
      getWindow: (): null => null,
      dynamicTools: buildCanopyDynamicToolSpecs({ includeChatVisuals: false }),
      mcpServersConfig: {
        linear: { type: 'http', url: 'http://127.0.0.1/linear' },
      },
      dynamicToolCallHandler: (
        params,
      ): ReturnType<typeof handleCanopyDynamicToolCall> =>
        handleCanopyDynamicToolCall(params, {
          requestUserAnswers: jest.fn(),
          loadScriptOutput: jest.fn(),
        }),
    });
    const { turnPromise } = await startActiveTurn(client, proc, ['linear']);

    const reloadPromise = client.reloadMcpServers();
    const reload = await waitForClientRequest(proc, 'config/mcpServer/reload');
    emitServerMessage(proc, {
      method: 'mcpServer/startupStatus/updated',
      params: {
        threadId: 'thread-1',
        name: 'linear',
        status: 'starting',
        error: null,
        failureReason: null,
      },
    });
    emitServerMessage(proc, { id: reload.id, result: {} });
    emitServerMessage(proc, {
      method: 'mcpServer/startupStatus/updated',
      params: {
        threadId: 'thread-1',
        name: 'linear',
        status: 'ready',
        error: null,
        failureReason: null,
      },
    });
    await reloadPromise;

    const steerPromise = client.steerActiveTurn(
      'Linear is connected; restart if needed.',
    );
    const steer = await waitForClientRequest(proc, 'turn/steer');
    emitServerMessage(proc, { id: steer.id, result: {} });
    await expect(steerPromise).resolves.toBe(true);

    emitServerMessage(proc, {
      id: 'server-req-restart',
      method: 'item/tool/call',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        callId: 'call-restart',
        namespace: null,
        tool: 'canopy_immediate_turn_restart',
        arguments: {},
      },
    });
    await flush();
    emitServerMessage(proc, {
      method: 'item/completed',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        item: {
          id: 'call-restart',
          type: 'dynamicToolCall',
          namespace: null,
          tool: 'canopy_immediate_turn_restart',
          arguments: {},
          status: 'completed',
          contentItems: [
            {
              type: 'inputText',
              text: 'Restarting this turn with refreshed MCP connections.',
            },
          ],
          success: true,
        },
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 300));

    const interrupt = collectClientMessages(proc).find(
      (message) => message.method === 'turn/interrupt',
    );
    expect(interrupt).toMatchObject({
      params: { threadId: 'thread-1', turnId: 'turn-1' },
    });
    emitServerMessage(proc, { id: interrupt?.id, result: {} });
    emitServerMessage(proc, {
      method: 'turn/completed',
      params: {
        threadId: 'thread-1',
        turn: {
          id: 'turn-1',
          items: [],
          status: 'interrupted',
          error: null,
        },
      },
    });
    await flush();

    await new Promise((resolve) => setTimeout(resolve, 125));

    const restartMessages = collectClientMessages(proc).filter(
      (message) => message.method === 'turn/start',
    );
    const restart = restartMessages[restartMessages.length - 1];
    if (!restart) throw new Error('Expected replacement turn/start request');
    const restartParams = restart.params;
    if (!isRecord(restartParams)) {
      throw new Error('Expected replacement turn/start params');
    }
    expect(restartParams.threadId).toBe('thread-1');
    expect(JSON.stringify(restartParams.input)).toContain(
      'The requested MCP connection is refreshed',
    );
    expect(
      events.some((entry) => {
        if (!isRecord(entry) || !isRecord(entry.event)) return false;
        return (
          entry.event.type === 'turn.completed' &&
          entry.event.turn_id === 'turn-1'
        );
      }),
    ).toBe(false);

    emitServerMessage(proc, {
      id: restart.id,
      result: {
        turn: { id: 'turn-2', items: [], status: 'inProgress', error: null },
      },
    });
    emitServerMessage(proc, {
      method: 'turn/completed',
      params: {
        threadId: 'thread-1',
        turn: {
          id: 'turn-2',
          items: [],
          status: 'completed',
          error: null,
        },
      },
    });
    await expect(turnPromise).resolves.toMatchObject({ status: 'completed' });
  });

  it('ignores a delayed ImmediateTurnRestart callback after its originating turn completes', async () => {
    const client = new CodexAppServerClient({
      cwd: '/tmp/repo',
      projectId: 'project',
      worktreeId: 'worktree',
      chatId: 'chat',
      sessionKey: 'project/worktree/chat',
      onEvent: jest.fn(),
      getWindow: (): null => null,
      dynamicTools: buildCanopyDynamicToolSpecs({ includeChatVisuals: false }),
      dynamicToolCallHandler: (
        params,
      ): ReturnType<typeof handleCanopyDynamicToolCall> =>
        handleCanopyDynamicToolCall(params, {
          requestUserAnswers: jest.fn(),
          loadScriptOutput: jest.fn(),
        }),
    });
    const { turnPromise } = await startActiveTurn(client, proc);
    const steerPromise = client.steerActiveTurn('Restart if needed.');
    const steer = await waitForClientRequest(proc, 'turn/steer');
    emitServerMessage(proc, { id: steer.id, result: {} });
    await expect(steerPromise).resolves.toBe(true);
    await completeImmediateTurnRestartTool(proc, 'call-stale-restart');

    completeRootTurn(proc, 'turn-1');
    await expect(turnPromise).resolves.toMatchObject({ status: 'completed' });

    const nextTurnPromise = client.startTurn({
      text: 'A different request',
      cwd: '/tmp/repo',
      model: 'gpt-6-sol',
      thinkingLevel: 'high',
      planMode: false,
    });
    await flush();
    const turnStarts = collectClientMessages(proc).filter(
      (message) => message.method === 'turn/start',
    );
    const nextTurnStart = turnStarts[turnStarts.length - 1];
    if (!nextTurnStart) throw new Error('Expected next turn/start request');
    emitServerMessage(proc, {
      id: nextTurnStart.id,
      result: {
        turn: { id: 'turn-2', items: [], status: 'inProgress', error: null },
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 300));

    const interruptMessages = collectClientMessages(proc).filter(
      (message) => message.method === 'turn/interrupt',
    );
    client.dispose();
    await expect(nextTurnPromise).rejects.toThrow('session_destroyed');
    expect(interruptMessages).toHaveLength(0);
  });

  it('honors Stop while ImmediateTurnRestart waits for MCP readiness', async () => {
    const client = new CodexAppServerClient({
      cwd: '/tmp/repo',
      projectId: 'project',
      worktreeId: 'worktree',
      chatId: 'chat',
      sessionKey: 'project/worktree/chat',
      onEvent: jest.fn(),
      getWindow: (): null => null,
      dynamicTools: buildCanopyDynamicToolSpecs({ includeChatVisuals: false }),
      mcpServersConfig: {
        linear: { type: 'http', url: 'http://127.0.0.1/linear' },
      },
      dynamicToolCallHandler: (
        params,
      ): ReturnType<typeof handleCanopyDynamicToolCall> =>
        handleCanopyDynamicToolCall(params, {
          requestUserAnswers: jest.fn(),
          loadScriptOutput: jest.fn(),
        }),
    });
    const { turnPromise } = await startActiveTurn(client, proc, ['linear']);
    const steerPromise = client.steerActiveTurn('Restart if needed.');
    const steer = await waitForClientRequest(proc, 'turn/steer');
    emitServerMessage(proc, { id: steer.id, result: {} });
    await expect(steerPromise).resolves.toBe(true);
    await completeImmediateTurnRestartTool(proc, 'call-cancel-restart');
    await new Promise((resolve) => setTimeout(resolve, 300));

    const restartInterrupt = collectClientMessages(proc).find(
      (message) => message.method === 'turn/interrupt',
    );
    emitServerMessage(proc, { id: restartInterrupt?.id, result: {} });
    emitServerMessage(proc, {
      method: 'mcpServer/startupStatus/updated',
      params: {
        threadId: 'thread-1',
        name: 'linear',
        status: 'starting',
        error: null,
        failureReason: null,
      },
    });
    emitServerMessage(proc, {
      method: 'turn/completed',
      params: {
        threadId: 'thread-1',
        turn: {
          id: 'turn-1',
          items: [],
          status: 'interrupted',
          error: null,
        },
      },
    });
    await flush();

    await client.interruptTurn();
    emitServerMessage(proc, {
      method: 'mcpServer/startupStatus/updated',
      params: {
        threadId: 'thread-1',
        name: 'linear',
        status: 'ready',
        error: null,
        failureReason: null,
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 125));

    const restartMessages = collectClientMessages(proc).filter(
      (message) => message.method === 'turn/start',
    );
    const unexpectedRestart = restartMessages[restartMessages.length - 1];
    if (unexpectedRestart) {
      emitServerMessage(proc, {
        id: unexpectedRestart.id,
        result: {
          turn: { id: 'turn-2', items: [], status: 'inProgress', error: null },
        },
      });
      completeRootTurn(proc, 'turn-2');
    }
    const result = await turnPromise;
    expect(restartMessages).toHaveLength(0);
    expect(result).toMatchObject({ status: 'interrupted' });
  });

  it('bounds unresolved steering correlations and retains their eventual pickup', async () => {
    const onEvent = jest.fn();
    const client = new CodexAppServerClient({
      cwd: '/tmp/repo',
      projectId: 'project',
      worktreeId: 'worktree',
      chatId: 'chat',
      sessionKey: 'project/worktree/chat',
      onEvent,
      getWindow: (): null => null,
    });
    const { turnPromise } = await startActiveTurn(client, proc);
    for (let i = 0; i < 1024; i++) {
      const submission = client.submitSteeringInput('text', `input-${i}`);
      const request = await waitForClientRequest(proc, 'turn/steer');
      emitServerMessage(proc, { id: request.id, result: { turnId: 'turn-1' } });
      expect((await submission).kind).toBe('accepted');
    }
    const overflow = client.submitSteeringInput('overflow', 'overflow');
    await flush();
    for (const message of collectClientMessages(proc).filter(
      (message) => message.method === 'turn/steer',
    ))
      emitServerMessage(proc, { id: message.id, result: { turnId: 'turn-1' } });
    const receipt = await overflow;
    emitServerMessage(proc, {
      method: 'item/started',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        item: {
          id: 'item-0',
          type: 'userMessage',
          clientId: 'input-0',
          content: [],
        },
      },
    });
    await flush();
    completeRootTurn(proc, 'turn-1');
    await turnPromise;
    expect(receipt).toMatchObject({
      kind: 'rejected',
      fallback: 'ordinary',
      refusal: chatInputRefusal('delivery-backlog'),
    });
    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({ phase: 'picked-up', attemptId: 'input-0' }),
    );
  }, 30_000);

  it('accepts a user steer once even when completion precedes the RPC acknowledgement', async () => {
    const onEvent = jest.fn();
    const client = new CodexAppServerClient({
      cwd: '/tmp/repo',
      projectId: 'project',
      worktreeId: 'worktree',
      chatId: 'chat',
      sessionKey: 'project/worktree/chat',
      onEvent,
      getWindow: (): null => null,
    });
    const { turnPromise } = await startActiveTurn(client, proc);
    const answer = client.steerActiveTurn('Full scope', 'answer-message');
    const steer = await waitForClientRequest(proc, 'turn/steer');
    emitServerMessage(proc, {
      method: 'item/started',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        item: {
          id: 'user-item',
          type: 'userMessage',
          clientId: 'answer-message',
          content: [{ type: 'text', text: 'Full scope', text_elements: [] }],
        },
      },
    });
    await flush();
    completeRootTurn(proc, 'turn-1');
    await turnPromise;
    emitServerMessage(proc, { id: steer.id, result: { turnId: 'turn-1' } });
    await expect(answer).resolves.toBe(true);
    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'canopy_input_delivery',
        attemptId: 'answer-message',
        phase: 'picked-up',
        itemId: 'user-item',
      }),
    );
    expect(steer.params).toMatchObject({
      expectedTurnId: 'turn-1',
      clientUserMessageId: 'answer-message',
    });
    await expect(
      client.steerActiveTurn('Later answer', 'later-message'),
    ).resolves.toBe(false);
  });

  it('returns a steering target only for an active steerable root turn', async () => {
    const client = createSteeringClient();
    expect(client.getSteeringTarget()).toBeUndefined();

    await withActiveTurn(client, () => {
      expect(client.getSteeringTarget()).toEqual({
        sessionId: 'thread-1',
        turnId: 'turn-1',
      });
    });

    expect(client.getSteeringTarget()).toBeUndefined();
  });

  it.each([
    ['thread', { sessionId: 'thread-old', turnId: 'turn-1' }],
    ['turn', { sessionId: 'thread-1', turnId: 'turn-old' }],
  ] as const)(
    'refuses a steering target that drifted in its %s without sending a request',
    async (_kind, target) => {
      const onEvent = jest.fn();
      const client = createSteeringClient(onEvent);
      await withActiveTurn(client, async () => {
        await expect(
          client.submitSteeringInput('Full scope', 'drifted', target),
        ).resolves.toEqual({
          kind: 'rejected',
          attemptId: 'drifted',
          reason: 'The active turn no longer accepts steering',
          fallback: 'ordinary',
          refusal: chatInputRefusal('no-active-turn'),
        });
        expect(
          collectClientMessages(proc).filter(
            (message) => message.method === 'turn/steer',
          ),
        ).toEqual([]);
        expect(
          onEvent.mock.calls.filter(
            ([event]) =>
              isRecord(event) &&
              event.type === 'canopy_input_delivery' &&
              (event.phase === 'accepted' || event.phase === 'unknown'),
          ),
        ).toEqual([]);
      });
    },
  );

  it('steers when the captured target still matches the active root turn', async () => {
    const onEvent = jest.fn();
    const client = createSteeringClient(onEvent);
    await withActiveTurn(client, async () => {
      const target = client.getSteeringTarget();
      expect(target).toEqual({ sessionId: 'thread-1', turnId: 'turn-1' });
      const steering = client.submitSteeringInput(
        'Full scope',
        'unchanged',
        target,
      );
      const steer = await waitForClientRequest(proc, 'turn/steer');
      expect(steer.params).toMatchObject({
        threadId: 'thread-1',
        expectedTurnId: 'turn-1',
        clientUserMessageId: 'unchanged',
      });
      emitServerMessage(proc, { id: steer.id, result: { turnId: 'turn-1' } });
      await expect(steering).resolves.toMatchObject({ kind: 'accepted' });
      expect(
        onEvent.mock.calls.filter(
          ([event]) =>
            isRecord(event) &&
            event.type === 'canopy_input_delivery' &&
            event.phase === 'accepted' &&
            event.attemptId === 'unchanged',
        ),
      ).toHaveLength(1);
    });
  });

  it('does not project a malformed provider item id into delivery events', async () => {
    const onEvent = jest.fn<void, [unknown]>();
    const client = new CodexAppServerClient({
      cwd: '/tmp/repo',
      projectId: 'project',
      worktreeId: 'worktree',
      chatId: 'chat',
      sessionKey: 'project/worktree/chat',
      onEvent,
      getWindow: (): null => null,
    });
    const { turnPromise } = await startActiveTurn(client, proc);
    const answer = client.steerActiveTurn('Full scope', 'answer-message');
    const steer = await waitForClientRequest(proc, 'turn/steer');
    emitServerMessage(proc, {
      method: 'item/started',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        item: {
          id: 42,
          type: 'userMessage',
          clientId: 'answer-message',
          content: [],
        },
      },
    });
    await flush();
    emitServerMessage(proc, { id: steer.id, result: { turnId: 'turn-1' } });
    await expect(answer).resolves.toBe(true);
    completeRootTurn(proc, 'turn-1');
    await turnPromise;

    const pickup = onEvent.mock.calls.find(
      ([event]) =>
        isRecord(event) &&
        event.type === 'canopy_input_delivery' &&
        event.phase === 'picked-up' &&
        event.attemptId === 'answer-message',
    );
    expect(pickup?.[0]).not.toHaveProperty('itemId');
  });

  // Codex 0.159.0 `turn/steer` refusals; provenance in steer-refusal.ts.
  const steerRefusals: ReadonlyArray<[string, ChatInputRefusalCode]> = [
    ['no active turn to steer', 'no-active-turn'],
    ['expected active turn id `turn-1` but found `turn-2`', 'turn-id-mismatch'],
    ['cannot steer a compact turn', 'compact-turn'],
    ['cannot steer a review turn', 'review-turn'],
    ['active turn uses a different output schema', 'output-schema-mismatch'],
    ['expectedTurnId must not be empty', 'empty-expected-turn-id'],
    ['input must not be empty', 'empty-input'],
    ['Server is draining; retry after reconnecting', 'not-steerable'],
    ['thread not found: thread-1', 'not-steerable'],
  ];

  function createSteeringClient(
    onEvent: jest.Mock = jest.fn(),
  ): CodexAppServerClient {
    return new CodexAppServerClient({
      cwd: '/tmp/repo',
      projectId: 'project',
      worktreeId: 'worktree',
      chatId: 'chat',
      sessionKey: 'project/worktree/chat',
      onEvent,
      getWindow: (): null => null,
    });
  }

  function unknownDeliveryEvents(
    onEvent: jest.Mock,
  ): Array<Record<string, unknown>> {
    return onEvent.mock.calls
      .map(([event]: unknown[]) => event)
      .filter(
        (event): event is Record<string, unknown> =>
          isRecord(event) &&
          event.type === 'canopy_input_delivery' &&
          event.phase === 'unknown',
      );
  }

  /** Settles the root turn even when `body` fails, so no rejection leaks. */
  async function withActiveTurn(
    client: CodexAppServerClient,
    body: () => void | Promise<void>,
  ): Promise<void> {
    const { turnPromise } = await startActiveTurn(client, proc);
    try {
      await body();
    } finally {
      jest.useRealTimers();
      completeRootTurn(proc, 'turn-1');
      await turnPromise;
    }
  }

  it.each(steerRefusals)(
    'does not deliver a rejected user steer twice: %s',
    async (message) => {
      const client = createSteeringClient();
      const { turnPromise } = await startActiveTurn(client, proc);
      const answer = client.steerActiveTurn('Full scope', 'answer-message');
      const expectation = expect(answer).resolves.toBe(false);
      const steer = await waitForClientRequest(proc, 'turn/steer');
      emitServerMessage(proc, {
        id: steer.id,
        error: { code: -32600, message },
      });
      completeRootTurn(proc, 'turn-1');
      await turnPromise;
      await expectation;
    },
  );

  it.each(steerRefusals)(
    'rejects a refused steering submission for ordinary delivery: %s',
    async (message, code) => {
      const onEvent = jest.fn();
      const client = createSteeringClient(onEvent);
      await withActiveTurn(client, async () => {
        const steering = client.submitSteeringInput('Full scope', 'refused');
        const steer = await waitForClientRequest(proc, 'turn/steer');
        emitServerMessage(proc, {
          id: steer.id,
          error: { code: -32600, message },
        });
        await expect(steering).resolves.toEqual({
          kind: 'rejected',
          attemptId: 'refused',
          reason: 'The active turn no longer accepts steering',
          fallback: 'ordinary',
          refusal: chatInputRefusal(code),
        });
        expect(unknownDeliveryEvents(onEvent)).toEqual([]);

        // The correlation was released, so the identity can be steered again.
        const retry = client.submitSteeringInput('Full scope', 'refused');
        const retrySteer = await waitForClientRequest(proc, 'turn/steer');
        emitServerMessage(proc, {
          id: retrySteer.id,
          result: { turnId: 'turn-1' },
        });
        await expect(retry).resolves.toMatchObject({ kind: 'accepted' });
      });
    },
  );

  it('rejects a steering submission without an active turn as not steerable', async () => {
    const onEvent = jest.fn();
    const client = createSteeringClient(onEvent);
    await expect(
      client.submitSteeringInput('Full scope', 'idle'),
    ).resolves.toEqual({
      kind: 'rejected',
      attemptId: 'idle',
      reason: 'The active turn no longer accepts steering',
      fallback: 'ordinary',
      refusal: chatInputRefusal('not-steerable'),
    });
    expect(unknownDeliveryEvents(onEvent)).toEqual([]);
  });

  it('reports a reused steering identity as a duplicate attempt', async () => {
    const onEvent = jest.fn();
    const client = createSteeringClient(onEvent);
    await withActiveTurn(client, async () => {
      const first = client.submitSteeringInput('Full scope', 'reused');
      const steer = await waitForClientRequest(proc, 'turn/steer');
      emitServerMessage(proc, { id: steer.id, result: { turnId: 'turn-1' } });
      await expect(first).resolves.toMatchObject({ kind: 'accepted' });

      await expect(
        client.submitSteeringInput('Full scope', 'reused'),
      ).resolves.toEqual({
        kind: 'unknown',
        attemptId: 'reused',
        reason: 'This submission identity was already used',
        failure: chatInputDeliveryFailure('duplicate-attempt'),
      });
      // The original attempt is still pending; it must not be marked unknown.
      expect(unknownDeliveryEvents(onEvent)).toEqual([]);
    });
  });

  function expectUnconfirmedSteer(
    onEvent: jest.Mock,
    admission: unknown,
    attemptId: string,
    code: ChatInputDeliveryFailureCode,
  ): void {
    const failure = chatInputDeliveryFailure(code);
    expect(admission).toEqual({
      kind: 'unknown',
      attemptId,
      reason:
        'Delivery was not confirmed. This message will not be resent automatically.',
      failure,
    });
    expect(unknownDeliveryEvents(onEvent)).toEqual([
      expect.objectContaining({ attemptId, providerTurnId: 'turn-1', failure }),
    ]);
  }

  it('reports a novel steering error as an unconfirmed transport error', async () => {
    const onEvent = jest.fn();
    const client = createSteeringClient(onEvent);
    await withActiveTurn(client, async () => {
      const steering = client.submitSteeringInput('Full scope', 'novel');
      const steer = await waitForClientRequest(proc, 'turn/steer');
      emitServerMessage(proc, {
        id: steer.id,
        error: { code: -32603, message: 'failed to steer turn: agent died' },
      });
      expectUnconfirmedSteer(
        onEvent,
        await steering,
        'novel',
        'transport-error',
      );
    });
  });

  it('keeps a timed-out correlated steer pending without an unknown event', async () => {
    const onEvent = jest.fn();
    const client = createSteeringClient(onEvent);
    await withActiveTurn(client, async () => {
      jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
      const steering = client.submitSteeringInput('Full scope', 'slow');
      await waitForClientRequest(proc, 'turn/steer');
      await jest.advanceTimersByTimeAsync(30_000);
      const result = await steering;
      expect(result).toMatchObject({ kind: 'pending', attemptId: 'slow' });
      expect(unknownDeliveryEvents(onEvent)).toEqual([]);
      if (result.kind !== 'pending' || !result.settlement)
        throw new Error('Expected a pending steering settlement');
      expect(typeof result.settlement.then).toBe('function');
    });
  });

  it('settles a late steer refusal for ordinary delivery', async () => {
    const onEvent = jest.fn();
    const client = createSteeringClient(onEvent);
    await withActiveTurn(client, async () => {
      jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
      const steering = client.submitSteeringInput('Full scope', 'late-refusal');
      const steer = await waitForClientRequest(proc, 'turn/steer');
      await jest.advanceTimersByTimeAsync(30_000);
      const result = await steering;
      if (result.kind !== 'pending' || !result.settlement)
        throw new Error('Expected a pending steering settlement');
      expect(unknownDeliveryEvents(onEvent)).toEqual([]);

      emitServerMessage(proc, {
        id: steer.id,
        error: { code: -32600, message: 'no active turn to steer' },
      });
      await expect(result.settlement).resolves.toEqual({
        kind: 'rejected',
        attemptId: 'late-refusal',
        reason: 'The active turn no longer accepts steering',
        fallback: 'ordinary',
        refusal: chatInputRefusal('no-active-turn'),
      });
      expect(unknownDeliveryEvents(onEvent)).toEqual([]);
    });
  });

  it('settles late steer success as accepted and emits accepted delivery', async () => {
    const onEvent = jest.fn();
    const client = createSteeringClient(onEvent);
    await withActiveTurn(client, async () => {
      jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
      const steering = client.submitSteeringInput('Full scope', 'late-success');
      const steer = await waitForClientRequest(proc, 'turn/steer');
      await jest.advanceTimersByTimeAsync(30_000);
      const result = await steering;
      if (result.kind !== 'pending' || !result.settlement)
        throw new Error('Expected a pending steering settlement');
      expect(unknownDeliveryEvents(onEvent)).toEqual([]);

      emitServerMessage(proc, {
        id: steer.id,
        result: { turnId: 'turn-1' },
      });
      await expect(result.settlement).resolves.toEqual({
        kind: 'accepted',
        attemptId: 'late-success',
        providerTurnId: 'turn-1',
      });
      expect(
        onEvent.mock.calls.filter(
          ([event]) =>
            isRecord(event) &&
            event.type === 'canopy_input_delivery' &&
            event.phase === 'accepted' &&
            event.attemptId === 'late-success',
        ),
      ).toHaveLength(1);
      expect(unknownDeliveryEvents(onEvent)).toEqual([]);
    });
  });

  it('settles pickup before the late answer as accepted exactly once', async () => {
    const onEvent = jest.fn();
    const client = createSteeringClient(onEvent);
    await withActiveTurn(client, async () => {
      jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
      const steering = client.submitSteeringInput('Full scope', 'picked-up');
      const steer = await waitForClientRequest(proc, 'turn/steer');
      await jest.advanceTimersByTimeAsync(30_000);
      const result = await steering;
      if (result.kind !== 'pending' || !result.settlement)
        throw new Error('Expected a pending steering settlement');

      emitServerMessage(proc, {
        method: 'item/started',
        params: {
          threadId: 'thread-1',
          turnId: 'turn-1',
          item: {
            id: 'picked-up-item',
            type: 'userMessage',
            clientId: 'picked-up',
            content: [],
          },
        },
      });
      await flush();
      await expect(result.settlement).resolves.toEqual({
        kind: 'accepted',
        attemptId: 'picked-up',
        providerTurnId: 'turn-1',
      });
      emitServerMessage(proc, {
        id: steer.id,
        error: { code: -32600, message: 'no active turn to steer' },
      });
      await flush();
      expect(
        onEvent.mock.calls.filter(
          ([event]) =>
            isRecord(event) &&
            event.type === 'canopy_input_delivery' &&
            event.phase === 'accepted' &&
            event.attemptId === 'picked-up',
        ),
      ).toHaveLength(1);
      expect(unknownDeliveryEvents(onEvent)).toEqual([]);
    });
  });

  it('settles a retained steer timeout as an unconfirmed steer timeout', async () => {
    const onEvent = jest.fn();
    const client = createSteeringClient(onEvent);
    await withActiveTurn(client, async () => {
      jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
      const steering = client.submitSteeringInput('Full scope', 'expired');
      await waitForClientRequest(proc, 'turn/steer');
      await jest.advanceTimersByTimeAsync(30_000);
      const result = await steering;
      if (result.kind !== 'pending' || !result.settlement)
        throw new Error('Expected a pending steering settlement');
      expect(unknownDeliveryEvents(onEvent)).toEqual([]);

      await jest.advanceTimersByTimeAsync(600_000);
      expectUnconfirmedSteer(
        onEvent,
        await result.settlement,
        'expired',
        'steer-timeout',
      );
    });
  });

  it('keeps uncorrelated internal steers on the hard request deadline', async () => {
    const client = createSteeringClient();
    await withActiveTurn(client, async () => {
      jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
      const steering = client.steerActiveTurn('Internal MCP refresh');
      await waitForClientRequest(proc, 'turn/steer');
      const rejected = expect(steering).rejects.toMatchObject({
        name: 'CodexAppServerRequestTimeoutError',
      });
      await jest.advanceTimersByTimeAsync(30_000);
      await rejected;
    });
  });

  it('reports a process exit during steering as an unconfirmed process exit', async () => {
    const firstProc = new MockChildProcess();
    const secondProc = new MockChildProcess();
    spawnMock
      .mockReset()
      .mockReturnValueOnce(firstProc)
      .mockReturnValueOnce(secondProc);
    const onEvent = jest.fn();
    const client = createSteeringClient(onEvent);
    const { turnPromise } = await startActiveTurn(client, firstProc);
    // Teardown rejects the turn if an assertion below fails first.
    void turnPromise.catch(() => undefined);
    const steering = client.submitSteeringInput('Full scope', 'exited');
    await waitForClientRequest(firstProc, 'turn/steer');
    firstProc.emit('exit', 0, null);
    expectUnconfirmedSteer(onEvent, await steering, 'exited', 'process-exit');

    const initialize = await waitForClientRequest(secondProc, 'initialize');
    emitServerMessage(secondProc, {
      id: initialize.id,
      result: { userAgent: 'ua', codexHome: '/tmp/.codex' },
    });
    const resume = await waitForClientRequest(secondProc, 'thread/resume');
    emitServerMessage(secondProc, {
      id: resume.id,
      result: makeThreadResult('thread-1', [
        { id: 'turn-1', items: [], status: 'completed', error: null },
      ]),
    });
    await expect(turnPromise).resolves.toMatchObject({ status: 'completed' });
  });

  it('settles a timed-out steering submission as process-exit unknown', async () => {
    const firstProc = new MockChildProcess();
    const secondProc = new MockChildProcess();
    spawnMock
      .mockReset()
      .mockReturnValueOnce(firstProc)
      .mockReturnValueOnce(secondProc);
    const onEvent = jest.fn();
    const client = createSteeringClient(onEvent);
    const { turnPromise } = await startActiveTurn(client, firstProc);
    void turnPromise.catch(() => undefined);
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
    const steering = client.submitSteeringInput(
      'Full scope',
      'exit-after-timeout',
    );
    await waitForClientRequest(firstProc, 'turn/steer');
    await jest.advanceTimersByTimeAsync(30_000);
    const result = await steering;
    if (result.kind !== 'pending' || !result.settlement)
      throw new Error('Expected a pending steering settlement');
    expect(unknownDeliveryEvents(onEvent)).toEqual([]);

    firstProc.emit('exit', 0, null);
    expectUnconfirmedSteer(
      onEvent,
      await result.settlement,
      'exit-after-timeout',
      'process-exit',
    );

    jest.useRealTimers();
    const initialize = await waitForClientRequest(secondProc, 'initialize');
    emitServerMessage(secondProc, {
      id: initialize.id,
      result: { userAgent: 'ua', codexHome: '/tmp/.codex' },
    });
    const resume = await waitForClientRequest(secondProc, 'thread/resume');
    emitServerMessage(secondProc, {
      id: resume.id,
      result: makeThreadResult('thread-1', [
        { id: 'turn-1', items: [], status: 'completed', error: null },
      ]),
    });
    await expect(turnPromise).resolves.toMatchObject({ status: 'completed' });
  });

  it('queues MCP reload and steers the exact active root turn', async () => {
    const client = new CodexAppServerClient({
      cwd: '/tmp/repo',
      projectId: 'project',
      worktreeId: 'worktree',
      chatId: 'chat',
      sessionKey: 'project/worktree/chat',
      onEvent: jest.fn(),
      getWindow: (): null => null,
    });
    const { turnPromise } = await startActiveTurn(client, proc);

    const reloadPromise = client.reloadMcpServers();
    const reload = await waitForClientRequest(proc, 'config/mcpServer/reload');
    expect(reload.params).toBeUndefined();
    emitServerMessage(proc, { id: reload.id, result: {} });
    await reloadPromise;

    const steerPromise = client.steerActiveTurn('Linear is connected.');
    const steer = await waitForClientRequest(proc, 'turn/steer');
    expect(steer.params).toEqual({
      threadId: 'thread-1',
      expectedTurnId: 'turn-1',
      input: [
        {
          type: 'text',
          text: 'Linear is connected.',
          text_elements: [],
        },
      ],
    });
    emitServerMessage(proc, {
      id: steer.id,
      result: { turnId: 'turn-1' },
    });
    await expect(steerPromise).resolves.toBe(true);

    emitServerMessage(proc, {
      method: 'turn/completed',
      params: {
        threadId: 'thread-1',
        turn: {
          id: 'turn-1',
          items: [],
          status: 'completed',
          error: null,
        },
      },
    });
    await turnPromise;
  });

  it.each(['ready', 'failed'])(
    'starts the next turn after MCP reload settles as %s',
    async (status) => {
      const client = new CodexAppServerClient({
        cwd: '/tmp/repo',
        projectId: 'project',
        worktreeId: 'worktree',
        chatId: 'chat',
        sessionKey: 'project/worktree/chat',
        onEvent: jest.fn(),
        getWindow: (): null => null,
        mcpServersConfig: {
          linear: { url: 'http://127.0.0.1:37646/mcp/linear' },
        },
      });
      const { turnPromise } = await startActiveTurn(client, proc, ['linear']);
      completeRootTurn(proc);
      await turnPromise;

      const reloadPromise = client.reloadMcpServers();
      void reloadPromise.catch(() => {});
      const reload = await waitForClientRequest(
        proc,
        'config/mcpServer/reload',
      );
      emitServerMessage(proc, {
        method: 'mcpServer/startupStatus/updated',
        params: {
          threadId: 'thread-1',
          name: 'linear',
          status: 'starting',
          error: null,
          failureReason: null,
        },
      });
      emitServerMessage(proc, { id: reload.id, result: {} });
      await flush();

      const nextTurnPromise = client.startTurn({
        text: 'Use Linear',
        cwd: '/tmp/repo',
        model: 'gpt-6-sol',
        thinkingLevel: 'high',
        planMode: false,
      });
      await new Promise((resolve) => setTimeout(resolve, 125));
      expect(
        collectClientMessages(proc).filter(
          (message) => message.method === 'turn/start',
        ),
      ).toHaveLength(0);

      emitServerMessage(proc, {
        method: 'mcpServer/startupStatus/updated',
        params: {
          threadId: 'thread-1',
          name: 'linear',
          status,
          error: status === 'failed' ? 'HTTP 503' : null,
          failureReason: null,
        },
      });
      await reloadPromise;
      const nextTurn = await waitForClientRequest(proc, 'turn/start');
      emitServerMessage(proc, {
        id: nextTurn.id,
        result: {
          turn: { id: 'turn-2', items: [], status: 'inProgress', error: null },
        },
      });
      completeRootTurn(proc, 'turn-2');
      await expect(nextTurnPromise).resolves.toMatchObject({
        status: 'completed',
      });
    },
  );

  it('waits for replacement-process MCP readiness after retaining reload state', async () => {
    const firstProc = new MockChildProcess();
    const secondProc = new MockChildProcess();
    spawnMock
      .mockReset()
      .mockReturnValueOnce(firstProc)
      .mockReturnValueOnce(secondProc);
    const client = new CodexAppServerClient({
      cwd: '/tmp/repo',
      projectId: 'project',
      worktreeId: 'worktree',
      chatId: 'chat',
      sessionKey: 'project/worktree/chat',
      onEvent: jest.fn(),
      getWindow: (): null => null,
      mcpServersConfig: {
        linear: { url: 'http://127.0.0.1:37646/mcp/linear' },
      },
    });
    const { turnPromise } = await startActiveTurn(client, firstProc, [
      'linear',
    ]);

    const reloadPromise = client.reloadMcpServers();
    const reload = await waitForClientRequest(
      firstProc,
      'config/mcpServer/reload',
    );
    emitServerMessage(firstProc, {
      method: 'mcpServer/startupStatus/updated',
      params: {
        threadId: 'thread-1',
        name: 'linear',
        status: 'starting',
        error: null,
        failureReason: null,
      },
    });
    emitServerMessage(firstProc, { id: reload.id, result: {} });
    emitServerMessage(firstProc, {
      method: 'mcpServer/startupStatus/updated',
      params: {
        threadId: 'thread-1',
        name: 'linear',
        status: 'ready',
        error: null,
        failureReason: null,
      },
    });
    await reloadPromise;

    firstProc.emit('exit', 0, null);
    const initialize = await waitForClientRequest(secondProc, 'initialize');
    emitServerMessage(secondProc, {
      id: initialize.id,
      result: { userAgent: 'ua', codexHome: '/tmp/.codex' },
    });
    const resume = await waitForClientRequest(secondProc, 'thread/resume');
    emitServerMessage(secondProc, {
      id: resume.id,
      result: makeThreadResult('thread-1', [
        {
          id: 'turn-1',
          items: [],
          status: 'inProgress',
          error: null,
        },
      ]),
    });
    await new Promise((resolve) => setTimeout(resolve, 125));
    const earlyContinuation = collectClientMessages(secondProc).find(
      (message) => message.method === 'turn/start',
    );
    if (!earlyContinuation) {
      emitServerMessage(secondProc, {
        method: 'mcpServer/startupStatus/updated',
        params: {
          threadId: 'thread-1',
          name: 'linear',
          status: 'ready',
          error: null,
          failureReason: null,
        },
      });
    }
    const continuation =
      earlyContinuation ??
      (await waitForClientRequestUnderLoad(secondProc, 'turn/start'));
    emitServerMessage(secondProc, {
      id: continuation.id,
      result: {
        turn: { id: 'turn-2', items: [], status: 'inProgress', error: null },
      },
    });
    completeRootTurn(secondProc, 'turn-2');
    await expect(turnPromise).resolves.toMatchObject({ status: 'completed' });
    expect(earlyContinuation).toBeUndefined();
  }, 60_000);

  it('continues the next turn when the background MCP reload fails', async () => {
    const client = new CodexAppServerClient({
      cwd: '/tmp/repo',
      projectId: 'project',
      worktreeId: 'worktree',
      chatId: 'chat',
      sessionKey: 'project/worktree/chat',
      onEvent: jest.fn(),
      getWindow: (): null => null,
    });
    const { turnPromise } = await startActiveTurn(client, proc);
    completeRootTurn(proc);
    await turnPromise;

    const reloadPromise = client.reloadMcpServers();
    void reloadPromise.catch(() => {});
    const reload = await waitForClientRequest(proc, 'config/mcpServer/reload');
    const nextTurnPromise = client.startTurn({
      text: 'Continue without the optional MCP refresh',
      cwd: '/tmp/repo',
      model: 'gpt-6-sol',
      thinkingLevel: 'high',
      planMode: false,
    });
    emitServerMessage(proc, {
      id: reload.id,
      error: { code: -32000, message: 'reload failed' },
    });

    await expect(reloadPromise).rejects.toThrow('reload failed');
    const nextTurn = await waitForClientRequestUnderLoad(proc, 'turn/start');
    emitServerMessage(proc, {
      id: nextTurn.id,
      result: {
        turn: { id: 'turn-2', items: [], status: 'inProgress', error: null },
      },
    });
    completeRootTurn(proc, 'turn-2');
    await expect(nextTurnPromise).resolves.toMatchObject({
      status: 'completed',
    });
  }, 60_000);

  it('cancels the next turn while MCP reload readiness is still pending', async () => {
    const client = new CodexAppServerClient({
      cwd: '/tmp/repo',
      projectId: 'project',
      worktreeId: 'worktree',
      chatId: 'chat',
      sessionKey: 'project/worktree/chat',
      onEvent: jest.fn(),
      getWindow: (): null => null,
    });
    const { turnPromise } = await startActiveTurn(client, proc);
    completeRootTurn(proc);
    await turnPromise;

    const reloadPromise = client.reloadMcpServers();
    const reload = await waitForClientRequest(proc, 'config/mcpServer/reload');

    const nextTurnPromise = client.startTurn({
      text: 'Cancel while waiting',
      cwd: '/tmp/repo',
      model: 'gpt-6-sol',
      thinkingLevel: 'high',
      planMode: false,
    });
    void nextTurnPromise.catch(() => {});
    await flush();
    client.cancelPendingTurnStart(new Error('turn_cancelled'));

    await expect(nextTurnPromise).rejects.toThrow('turn_cancelled');
    expect(
      collectClientMessages(proc).filter(
        (message) => message.method === 'turn/start',
      ),
    ).toHaveLength(0);
    emitServerMessage(proc, { id: reload.id, result: {} });
    await reloadPromise;
  });

  it('does not route a disposed tab dynamic-tool completion to the remaining pooled tab', async () => {
    createPendingRequestMock.mockReturnValue(new Promise(() => {}));

    const win: SendableBrowserWindow = {
      isDestroyed: (): boolean => false,
      webContents: {
        isCrashed: (): boolean => false,
        isDestroyed: (): boolean => false,
        mainFrame: {
          detached: false,
          isDestroyed: (): boolean => false,
        },
        send: jest.fn(),
      },
    };
    const runtime: CanopyInjectedToolRuntime = {
      requestUserAnswers: (questions, options) =>
        requestAnswersFromRenderer({
          sessionKey: 'project/worktree/chat',
          projectId: 'project',
          worktreeId: 'worktree',
          chatId: 'chat',
          questions,
          getWindow: (): SendableBrowserWindow => win,
          toolUseId: options?.toolUseId,
        }),
      loadScriptOutput: jest.fn(),
    };
    const eventsA: unknown[] = [];
    const eventsB: unknown[] = [];
    const clientA = new CodexAppServerClient({
      cwd: '/tmp/repo',
      projectId: 'project',
      worktreeId: 'worktree',
      chatId: 'chat',
      sessionKey: 'project/worktree/chat',
      onEvent: (event): void => {
        eventsA.push(event);
      },
      getWindow: (): SendableBrowserWindow => win,
      dynamicTools: buildCanopyDynamicToolSpecs({ includeChatVisuals: false }),
      dynamicToolCallHandler: (
        params,
      ): ReturnType<typeof handleCanopyDynamicToolCall> =>
        handleCanopyDynamicToolCall(params, runtime),
    });
    const clientB = new CodexAppServerClient({
      cwd: '/tmp/repo',
      projectId: 'project',
      worktreeId: 'worktree',
      chatId: 'chat-b',
      sessionKey: 'project/worktree/chat-b',
      onEvent: (event): void => {
        eventsB.push(event);
      },
      getWindow: (): null => null,
    });

    const { turnPromise } = await startActiveTurn(clientA, proc);
    void turnPromise.catch(() => {});
    emitServerMessage(proc, {
      id: 'server-req-1',
      method: 'item/tool/call',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        callId: 'call-closed-tab',
        namespace: null,
        tool: 'canopy_ask_user_question',
        arguments: {
          questions: [{ question: 'Proceed?', options: ['Yes'] }],
        },
      },
    });
    await flush();

    clientA.dispose();
    const destroyedToolMessages = await waitForClientResponse(
      proc,
      'server-req-1',
    );
    const destroyedToolResponse = destroyedToolMessages.find(
      (message) => message.id === 'server-req-1',
    );
    expect(destroyedToolResponse).toBeDefined();
    expect(isRecord(destroyedToolResponse?.result)).toBe(true);
    expect(
      isRecord(destroyedToolResponse?.result) &&
        destroyedToolResponse.result.success,
    ).toBe(false);

    emitServerMessage(proc, {
      method: 'item/completed',
      params: {
        item: {
          type: 'dynamicToolCall',
          id: 'call-closed-tab',
          namespace: null,
          tool: 'canopy_ask_user_question',
          arguments: {
            questions: [{ question: 'Proceed?', options: ['Yes'] }],
          },
          status: 'failed',
          contentItems: [
            {
              type: 'inputText',
              text: 'Canopy session destroyed before dynamic tool call could complete',
            },
          ],
          success: false,
        },
      },
    });
    await flush();

    const routedToRemainingTab = eventsB.some((event) => {
      if (!isRecord(event) || event.type !== 'codex') return false;
      if (!isRecord(event.event) || event.event.type !== 'item.completed') {
        return false;
      }

      return (
        isRecord(event.event.item) && event.event.item.id === 'call-closed-tab'
      );
    });
    expect(routedToRemainingTab).toBe(false);
    await expect(turnPromise).rejects.toThrow('session_destroyed');
    clientB.dispose();
  });

  it('rejects malformed dynamic tool call payloads with JSON-RPC -32602', async () => {
    const client = new CodexAppServerClient({
      cwd: '/tmp/repo',
      projectId: 'project',
      worktreeId: 'worktree',
      chatId: 'chat',
      sessionKey: 'project/worktree/chat',
      onEvent: jest.fn(),
      getWindow: (): null => null,
      dynamicTools: buildCanopyDynamicToolSpecs({ includeChatVisuals: false }),
      dynamicToolCallHandler: jest.fn(),
    });

    const turnPromise = client.startTurn({
      text: 'Use a dynamic tool',
      cwd: '/tmp/repo',
      model: 'gpt-6-sol',
      thinkingLevel: 'high',
      planMode: false,
    });

    await flush();
    emitServerMessage(proc, {
      id: 1,
      result: { userAgent: 'ua', codexHome: '/tmp/.codex' },
    });
    await flush();
    emitServerMessage(proc, {
      id: 2,
      result: {
        thread: {
          id: 'thread-1',
          preview: '',
          ephemeral: false,
          modelProvider: 'openai',
          createdAt: 1,
          updatedAt: 1,
          status: { type: 'idle' },
          path: null,
          cwd: '/tmp/repo',
          cliVersion: '0.114.0',
          source: 'vscode',
          agentNickname: null,
          agentRole: null,
          gitInfo: null,
          name: null,
          turns: [],
        },
        model: 'gpt-6-sol',
        modelProvider: 'openai',
        serviceTier: null,
        cwd: '/tmp/repo',
        approvalPolicy: 'never',
        sandbox: { type: 'dangerFullAccess' },
        reasoningEffort: 'high',
      },
    });
    await flush();
    emitServerMessage(proc, {
      id: 3,
      result: {
        turn: { id: 'turn-1', items: [], status: 'inProgress', error: null },
      },
    });
    emitServerMessage(proc, {
      id: 'server-req-1',
      method: 'item/tool/call',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        tool: 'canopy_get_script_output',
        arguments: { scriptId: 'launch' },
      },
    });
    const messages = await waitForClientResponse(proc, 'server-req-1');
    expect(messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'server-req-1',
          error: {
            code: -32602,
            message: 'Invalid dynamic tool call payload',
          },
        }),
      ]),
    );

    emitServerMessage(proc, {
      method: 'turn/completed',
      params: {
        threadId: 'thread-1',
        turn: { id: 'turn-1', items: [], status: 'completed', error: null },
      },
    });

    await turnPromise;
  });

  it('answers a throwing dynamic tool handler without forwarding its error text', async () => {
    const handlerError = new Error(
      'EACCES: /Users/someone/.canopy/workspaces/ws_secret/approval-rules.json',
    );
    const logError = jest
      .spyOn(mainProcessLogging, 'logMainProcessError')
      .mockImplementation(() => undefined);
    const client = new CodexAppServerClient({
      cwd: '/tmp/repo',
      projectId: 'project',
      worktreeId: 'worktree',
      chatId: 'chat',
      sessionKey: 'project/worktree/chat',
      onEvent: jest.fn(),
      getWindow: (): null => null,
      dynamicTools: buildCanopyDynamicToolSpecs({ includeChatVisuals: false }),
      dynamicToolCallHandler: (): Promise<never> =>
        Promise.reject(handlerError),
    });

    const { turnPromise } = await startActiveTurn(client, proc);
    void turnPromise.catch(() => {});
    emitServerMessage(proc, {
      id: 'server-req-throws',
      method: 'item/tool/call',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        callId: 'call-throws',
        namespace: null,
        tool: 'canopy_get_script_output',
        arguments: { scriptId: 'launch' },
      },
    });

    const messages = await waitForClientResponse(proc, 'server-req-throws');
    const response = messages.find(
      (message) => message.id === 'server-req-throws',
    );
    expect(response?.result).toEqual({
      contentItems: [{ type: 'inputText', text: 'Dynamic tool call failed' }],
      success: false,
    });
    expect(JSON.stringify(response)).not.toContain('ws_secret');
    expect(logError).toHaveBeenCalledWith(expect.any(String), handlerError);
    logError.mockRestore();
    client.dispose();
  });

  it('rejects dynamic tool call payloads with a non-string namespace', async () => {
    const client = new CodexAppServerClient({
      cwd: '/tmp/repo',
      projectId: 'project',
      worktreeId: 'worktree',
      chatId: 'chat',
      sessionKey: 'project/worktree/chat',
      onEvent: jest.fn(),
      getWindow: (): null => null,
    });

    const turnPromise = client.startTurn({
      text: 'Prompt',
      cwd: '/tmp/repo',
      model: 'gpt-6-sol',
      thinkingLevel: 'high',
      planMode: false,
    });

    await flush();
    emitServerMessage(proc, {
      id: 1,
      result: { userAgent: 'ua', codexHome: '/tmp/.codex' },
    });
    await flush();
    emitServerMessage(proc, {
      id: 2,
      result: {
        thread: {
          id: 'thread-1',
          preview: '',
          ephemeral: false,
          modelProvider: 'openai',
          createdAt: 1,
          updatedAt: 1,
          status: { type: 'idle' },
          path: null,
          cwd: '/tmp/repo',
          cliVersion: '0.114.0',
          source: 'vscode',
          agentNickname: null,
          agentRole: null,
          gitInfo: null,
          name: null,
          turns: [],
        },
        model: 'gpt-6-sol',
        modelProvider: 'openai',
        serviceTier: null,
        cwd: '/tmp/repo',
        approvalPolicy: 'never',
        sandbox: { type: 'dangerFullAccess' },
        reasoningEffort: 'high',
      },
    });
    await flush();
    emitServerMessage(proc, {
      id: 3,
      result: {
        turn: { id: 'turn-1', items: [], status: 'inProgress', error: null },
      },
    });
    emitServerMessage(proc, {
      id: 'server-req-1',
      method: 'item/tool/call',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        callId: 'call-1',
        namespace: 42,
        tool: 'canopy_get_script_output',
        arguments: { scriptId: 'launch' },
      },
    });
    const messages = await waitForClientResponse(proc, 'server-req-1');
    expect(messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'server-req-1',
          error: {
            code: -32602,
            message: 'Invalid dynamic tool call payload',
          },
        }),
      ]),
    );

    emitServerMessage(proc, {
      method: 'turn/completed',
      params: {
        threadId: 'thread-1',
        turn: { id: 'turn-1', items: [], status: 'completed', error: null },
      },
    });

    await turnPromise;
  });

  it('cancels an in-flight turn before the app-server returns a turn id', async () => {
    const client = new CodexAppServerClient({
      cwd: '/tmp/repo',
      projectId: 'project',
      worktreeId: 'worktree',
      chatId: 'chat',
      sessionKey: 'project/worktree/chat',
      onEvent: jest.fn(),
      getWindow: (): null => null,
    });

    const turnPromise = client.startTurn({
      text: 'Start a slow turn',
      cwd: '/tmp/repo',
      model: 'gpt-6-sol',
      thinkingLevel: 'high',
      planMode: false,
    });

    await flush();
    emitServerMessage(proc, {
      id: 1,
      result: { userAgent: 'ua', codexHome: '/tmp/.codex' },
    });
    await flush();

    const interruptPromise = client.interruptTurn();
    await interruptPromise;

    await expect(turnPromise).rejects.toThrow('turn_cancelled');
  });

  it('does not restart the app-server when interrupting an idle client', async () => {
    const client = createClient();

    await client.interruptTurn();

    expect(spawnMock).not.toHaveBeenCalled();
    client.dispose();
  });

  it('interrupts an active Full Access turn before applying a safer mode', async () => {
    const client = new CodexAppServerClient({
      cwd: '/tmp/repo',
      projectId: 'project',
      worktreeId: 'worktree',
      chatId: 'chat',
      sessionKey: 'project/worktree/chat',
      onEvent: jest.fn(),
      getWindow: (): null => null,
      approvalMode: 'full-access',
    });
    const { turnPromise } = await startActiveTurn(client, proc);

    const modePromise = client.setApprovalMode('ask');
    await flush();
    const interruptRequest = collectClientMessages(proc).find(
      (message) => message.method === 'turn/interrupt',
    );
    expect(interruptRequest).toMatchObject({
      method: 'turn/interrupt',
      params: { threadId: 'thread-1', turnId: 'turn-1' },
    });

    emitServerMessage(proc, { id: interruptRequest?.id, result: {} });
    await modePromise;
    emitServerMessage(proc, {
      method: 'turn/completed',
      params: {
        threadId: 'thread-1',
        turn: {
          id: 'turn-1',
          items: [],
          status: 'interrupted',
          error: null,
        },
      },
    });
    await expect(turnPromise).resolves.toMatchObject({ status: 'interrupted' });
  });

  it('falls back to terminating the app-server when turn/interrupt hangs', async () => {
    const client = new CodexAppServerClient({
      cwd: '/tmp/repo',
      projectId: 'project',
      worktreeId: 'worktree',
      chatId: 'chat',
      sessionKey: 'project/worktree/chat',
      onEvent: jest.fn(),
      getWindow: (): null => null,
    });

    const turnPromise = client.startTurn({
      text: 'Cancel this turn',
      cwd: '/tmp/repo',
      model: 'gpt-6-sol',
      thinkingLevel: 'high',
      planMode: false,
    });
    void turnPromise.catch(() => {});

    await flush();
    emitServerMessage(proc, {
      id: 1,
      result: { userAgent: 'ua', codexHome: '/tmp/.codex' },
    });
    await flush();
    emitServerMessage(proc, {
      id: 2,
      result: {
        thread: {
          id: 'thread-1',
          preview: '',
          ephemeral: false,
          modelProvider: 'openai',
          createdAt: 1,
          updatedAt: 1,
          status: { type: 'idle' },
          path: null,
          cwd: '/tmp/repo',
          cliVersion: '0.114.0',
          source: 'vscode',
          agentNickname: null,
          agentRole: null,
          gitInfo: null,
          name: null,
          turns: [],
        },
        model: 'gpt-6-sol',
        modelProvider: 'openai',
        serviceTier: null,
        cwd: '/tmp/repo',
        approvalPolicy: 'never',
        sandbox: { type: 'dangerFullAccess' },
        reasoningEffort: 'high',
      },
    });
    await flush();
    emitServerMessage(proc, {
      id: 3,
      result: {
        turn: { id: 'turn-1', items: [], status: 'inProgress', error: null },
      },
    });
    await flush();

    jest.useFakeTimers();
    try {
      proc.autoExitSignals.delete('SIGTERM');

      const interruptPromise = client.interruptTurn();
      await jest.advanceTimersByTimeAsync(5_000);
      expect(
        collectClientMessages(proc).filter(
          (message) => message['method'] === 'turn/interrupt',
        ),
      ).toHaveLength(2);
      expect(proc.kill).toHaveBeenCalledWith('SIGTERM');
      await jest.advanceTimersByTimeAsync(1_000);
      expect(proc.kill).toHaveBeenCalledWith('SIGKILL');
      await interruptPromise;
      await expect(turnPromise).rejects.toThrow('turn_cancelled');
      await jest.advanceTimersByTimeAsync(5_000);
      expect(
        proc.kill.mock.calls.filter(([signal]) => signal === 'SIGKILL'),
      ).toHaveLength(1);
    } finally {
      jest.useRealTimers();
    }
  });

  it('preserves cancellation during the process-recovery retry delay', async () => {
    const firstProc = new MockChildProcess();
    const secondProc = new MockChildProcess();
    spawnMock
      .mockReset()
      .mockReturnValueOnce(firstProc)
      .mockReturnValueOnce(secondProc);
    const client = createClient();
    const turnPromise = client.startTurn({
      text: 'Do not retry after cancellation',
      cwd: '/tmp/repo',
      model: 'gpt-6-sol',
      thinkingLevel: 'high',
      planMode: false,
    });
    void turnPromise.catch(() => {});

    const initializeFirst = await waitForClientRequest(firstProc, 'initialize');
    emitServerMessage(firstProc, {
      id: initializeFirst.id,
      result: { userAgent: 'ua', codexHome: '/tmp/.codex' },
    });
    await waitForClientRequest(firstProc, 'thread/start');
    firstProc.emit('exit', 0, null);

    const initializeSecond = await waitForClientRequest(
      secondProc,
      'initialize',
    );
    emitServerMessage(secondProc, {
      id: initializeSecond.id,
      result: { userAgent: 'ua', codexHome: '/tmp/.codex' },
    });
    await client.interruptTurn();

    await expect(turnPromise).rejects.toThrow('turn_cancelled');
    expect(
      collectClientMessages(secondProc).filter(
        (message) => message.method === 'thread/start',
      ),
    ).toHaveLength(0);
  });

  it('waits for in-flight dynamic tools before recovering the owner', async () => {
    const firstProc = new MockChildProcess();
    const secondProc = new MockChildProcess();
    spawnMock
      .mockReset()
      .mockReturnValueOnce(firstProc)
      .mockReturnValueOnce(secondProc);
    let resolveDynamicTool:
      | ((value: {
          contentItems: Array<{ type: 'inputText'; text: string }>;
          success: boolean;
        }) => void)
      | undefined;
    const dynamicToolResult = new Promise<{
      contentItems: Array<{ type: 'inputText'; text: string }>;
      success: boolean;
    }>((resolve) => {
      resolveDynamicTool = resolve;
    });
    const client = new CodexAppServerClient({
      cwd: '/tmp/repo',
      projectId: 'project',
      worktreeId: 'worktree',
      chatId: 'chat',
      sessionKey: 'project/worktree/chat',
      onEvent: jest.fn(),
      getWindow: (): null => null,
      dynamicToolCallHandler: (): typeof dynamicToolResult => dynamicToolResult,
    });
    const peerClient = new CodexAppServerClient({
      cwd: '/tmp/repo',
      projectId: 'project',
      worktreeId: 'worktree',
      chatId: 'chat-b',
      sessionKey: 'project/worktree/chat-b',
      onEvent: jest.fn(),
      getWindow: (): null => null,
    });
    const { turnPromise } = await startActiveTurn(client, firstProc);

    emitServerMessage(firstProc, {
      id: 'server-tool-1',
      method: 'item/tool/call',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        callId: 'call-1',
        namespace: null,
        tool: 'test_tool',
        arguments: {},
      },
    });
    await flush();
    firstProc.emit('exit', 0, null);
    const peerRequest = peerClient.readAccount(false);
    void peerRequest.catch(() => {});
    await flush();

    expect(spawnMock).toHaveBeenCalledTimes(1);
    if (!resolveDynamicTool) {
      throw new Error('Expected dynamic tool resolver');
    }
    resolveDynamicTool({
      contentItems: [{ type: 'inputText', text: 'done' }],
      success: true,
    });

    const initializeSecond = await waitForClientRequest(
      secondProc,
      'initialize',
    );
    emitServerMessage(secondProc, {
      id: initializeSecond.id,
      result: { userAgent: 'ua', codexHome: '/tmp/.codex' },
    });
    const resume = await waitForClientRequest(secondProc, 'thread/resume');
    expect(getRequestParams(resume)).toMatchObject({
      approvalPolicy: {
        granular: {
          sandbox_approval: true,
          rules: true,
          skill_approval: true,
          request_permissions: true,
          mcp_elicitations: true,
        },
      },
      sandbox: 'read-only',
    });
    emitServerMessage(secondProc, {
      id: resume.id,
      result: makeThreadResult('thread-1', [
        {
          id: 'turn-1',
          items: [],
          status: 'completed',
          error: null,
        },
      ]),
    });

    await expect(turnPromise).resolves.toMatchObject({ status: 'completed' });
    peerClient.dispose();
  });

  it('expires a Canopy-injected AskUserQuestion before recovery', async () => {
    const firstProc = new MockChildProcess();
    const secondProc = new MockChildProcess();
    spawnMock
      .mockReset()
      .mockReturnValueOnce(firstProc)
      .mockReturnValueOnce(secondProc);
    let askUserSignal: AbortSignal | undefined;
    const runtime: CanopyInjectedToolRuntime = {
      requestUserAnswers: (_questions, options) => {
        askUserSignal = options?.signal;
        return new Promise((_, reject) => {
          options?.signal?.addEventListener(
            'abort',
            () => reject(new Error('ask_user_cancelled')),
            { once: true },
          );
        });
      },
      loadScriptOutput: jest.fn(),
    };
    const client = new CodexAppServerClient({
      cwd: '/tmp/repo',
      projectId: 'project',
      worktreeId: 'worktree',
      chatId: 'chat',
      sessionKey: 'project/worktree/chat',
      onEvent: jest.fn(),
      getWindow: (): null => null,
      dynamicTools: buildCanopyDynamicToolSpecs({ includeChatVisuals: false }),
      dynamicToolCallHandler: (
        params,
        options,
      ): ReturnType<typeof handleCanopyDynamicToolCall> =>
        handleCanopyDynamicToolCall(params, runtime, options),
    });
    const { turnPromise } = await startActiveTurn(client, firstProc);

    emitServerMessage(firstProc, {
      id: 'server-ask-user-1',
      method: 'item/tool/call',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        callId: 'call-1',
        namespace: null,
        tool: CANOPY_INJECTED_TOOL_REGISTRY.ask_user_question.codexToolName,
        arguments: {
          questions: [
            {
              question: 'Continue?',
              options: ['Yes', 'No'],
              multiSelect: false,
            },
          ],
        },
      },
    });
    await flush();
    expect(askUserSignal?.aborted).toBe(false);

    firstProc.emit('exit', 0, null);
    const initializeSecond = await waitForClientRequest(
      secondProc,
      'initialize',
    );
    expect(askUserSignal?.aborted).toBe(true);
    emitServerMessage(secondProc, {
      id: initializeSecond.id,
      result: { userAgent: 'ua', codexHome: '/tmp/.codex' },
    });
    const resume = await waitForClientRequest(secondProc, 'thread/resume');
    emitServerMessage(secondProc, {
      id: resume.id,
      result: makeThreadResult('thread-1', [
        {
          id: 'turn-1',
          items: [],
          status: 'completed',
          error: null,
        },
      ]),
    });

    await expect(turnPromise).resolves.toMatchObject({ status: 'completed' });
  });

  it('settles startTurn at the recovery deadline while recovery remains quiesced', async () => {
    const firstProc = new MockChildProcess();
    const secondProc = new MockChildProcess();
    spawnMock
      .mockReset()
      .mockReturnValueOnce(firstProc)
      .mockReturnValueOnce(secondProc);
    let resolveDynamicTool:
      | ((value: {
          contentItems: Array<{ type: 'inputText'; text: string }>;
          success: boolean;
        }) => void)
      | undefined;
    const dynamicToolResult = new Promise<{
      contentItems: Array<{ type: 'inputText'; text: string }>;
      success: boolean;
    }>((resolve) => {
      resolveDynamicTool = resolve;
    });
    const client = new CodexAppServerClient({
      cwd: '/tmp/repo',
      projectId: 'project',
      worktreeId: 'worktree',
      chatId: 'chat',
      sessionKey: 'project/worktree/chat',
      onEvent: jest.fn(),
      getWindow: (): null => null,
      dynamicToolCallHandler: (): typeof dynamicToolResult => dynamicToolResult,
    });
    const turnPromise = client.startTurn({
      text: 'Recover within the deadline',
      cwd: '/tmp/repo',
      model: 'gpt-6-sol',
      thinkingLevel: 'high',
      planMode: false,
    });
    void turnPromise.catch(() => {});
    const initializeFirst = await waitForClientRequest(firstProc, 'initialize');
    emitServerMessage(firstProc, {
      id: initializeFirst.id,
      result: { userAgent: 'ua', codexHome: '/tmp/.codex' },
    });
    const threadStart = await waitForClientRequest(firstProc, 'thread/start');
    emitServerMessage(firstProc, {
      id: threadStart.id,
      result: makeThreadResult('thread-1'),
    });
    await waitForClientRequest(firstProc, 'turn/start');
    emitServerMessage(firstProc, {
      id: 'server-tool-1',
      method: 'item/tool/call',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        callId: 'call-1',
        namespace: null,
        tool: 'test_tool',
        arguments: {},
      },
    });
    await flush();

    jest.useFakeTimers();
    try {
      firstProc.emit('exit', 0, null);
      await jest.advanceTimersByTimeAsync(30_000);
      await expect(turnPromise).rejects.toThrow(
        'host-side tool handlers did not settle within 30000ms',
      );
      expect(spawnMock).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
      resolveDynamicTool?.({
        contentItems: [{ type: 'inputText', text: 'done' }],
        success: true,
      });
      client.dispose();
    }
  });

  it('settles a setup retry at the recovery deadline while recovery remains quiesced', async () => {
    const firstProc = new MockChildProcess();
    const secondProc = new MockChildProcess();
    spawnMock
      .mockReset()
      .mockReturnValueOnce(firstProc)
      .mockReturnValueOnce(secondProc);
    let resolveDynamicTool:
      | ((value: {
          contentItems: Array<{ type: 'inputText'; text: string }>;
          success: boolean;
        }) => void)
      | undefined;
    const dynamicToolResult = new Promise<{
      contentItems: Array<{ type: 'inputText'; text: string }>;
      success: boolean;
    }>((resolve) => {
      resolveDynamicTool = resolve;
    });
    const client = new CodexAppServerClient({
      cwd: '/tmp/repo',
      projectId: 'project',
      worktreeId: 'worktree',
      chatId: 'chat',
      sessionKey: 'project/worktree/chat',
      onEvent: jest.fn(),
      getWindow: (): null => null,
      dynamicToolCallHandler: (): typeof dynamicToolResult => dynamicToolResult,
    });
    const peerClient = new CodexAppServerClient({
      cwd: '/tmp/repo',
      projectId: 'project',
      worktreeId: 'worktree',
      chatId: 'chat-b',
      sessionKey: 'project/worktree/chat-b',
      onEvent: jest.fn(),
      getWindow: (): null => null,
    });
    const { turnPromise } = await startActiveTurn(client, firstProc);

    emitServerMessage(firstProc, {
      id: 'server-tool-1',
      method: 'item/tool/call',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        callId: 'call-1',
        namespace: null,
        tool: 'test_tool',
        arguments: {},
      },
    });
    await flush();

    const peerTurnPromise = peerClient.startTurn({
      text: 'Start while the pooled worker is recovering',
      cwd: '/tmp/repo',
      model: 'gpt-6-sol',
      thinkingLevel: 'high',
      planMode: false,
    });
    void peerTurnPromise.catch(() => {});
    await waitForClientRequest(firstProc, 'thread/start');

    jest.useFakeTimers({ doNotFake: ['setImmediate'] });
    try {
      firstProc.emit('exit', 0, null);
      await jest.advanceTimersByTimeAsync(30_000);

      await expect(peerTurnPromise).rejects.toThrow(
        'host-side tool handlers did not settle within 30000ms',
      );
      await expect(turnPromise).rejects.toThrow(
        'host-side tool handlers did not settle within 30000ms',
      );
      expect(spawnMock).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
      resolveDynamicTool?.({
        contentItems: [{ type: 'inputText', text: 'done' }],
        success: true,
      });
      await flush();
      expect(spawnMock).toHaveBeenCalledTimes(1);
      peerClient.dispose();
      client.dispose();
    }
  });

  it('cancels pending turn starts when recovery quiescence times out', async () => {
    spawnMock.mockReset().mockReturnValue(proc);
    const connection = new CodexAppServerConnection('default');
    const cancelPendingTurnStart = jest.fn<void, [Error]>();
    const rejectActiveTurn = jest.fn<void, [Error]>();
    const onProcessRecovery = jest.fn();
    let settleDynamicTool: (() => void) | undefined;
    const dynamicToolResult = new Promise<void>((resolve) => {
      settleDynamicTool = resolve;
    });
    const owner = createConnectionOwner({
      hasActiveTurn: jest.fn(() => true),
      cancelPendingTurnStart,
      rejectActiveTurn,
      handleDynamicToolCall: jest.fn(() => dynamicToolResult),
    });
    connection.registerOwner(owner, { onProcessRecovery });
    connection.registerRootThread('thread-1', owner);
    const initializePromise = connection.ensureInitialized();
    await flush();
    emitServerMessage(proc, {
      id: 1,
      result: { userAgent: 'ua', codexHome: '/tmp/.codex' },
    });
    await initializePromise;
    emitServerMessage(proc, {
      id: 'server-tool-1',
      method: 'item/tool/call',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        callId: 'call-1',
        namespace: null,
        tool: 'test_tool',
        arguments: {},
      },
    });
    await flush();

    jest.useFakeTimers({ doNotFake: ['setImmediate'] });
    try {
      proc.emit('exit', 0, null);
      await jest.advanceTimersByTimeAsync(30_000);

      const recoveryError = cancelPendingTurnStart.mock.calls[0]?.[0];
      expect(recoveryError).toBeInstanceOf(Error);
      expect(recoveryError?.message).toBe(
        'Codex app-server background recovery failed: host-side tool handlers did not settle within 30000ms',
      );
      expect(rejectActiveTurn).toHaveBeenCalledWith(recoveryError);
      expect(cancelPendingTurnStart.mock.invocationCallOrder[0]).toBeLessThan(
        rejectActiveTurn.mock.invocationCallOrder[0],
      );
      expect(onProcessRecovery).toHaveBeenCalledWith({
        status: 'failed',
        error:
          'Codex app-server background recovery failed: host-side tool handlers did not settle within 30000ms',
      });
    } finally {
      jest.useRealTimers();
      settleDynamicTool?.();
      await flush();
      connection.unregisterOwner(owner);
    }
  });

  it('expires pending user input before recovering the owner', async () => {
    const firstProc = new MockChildProcess();
    const secondProc = new MockChildProcess();
    spawnMock
      .mockReset()
      .mockReturnValueOnce(firstProc)
      .mockReturnValueOnce(secondProc);
    let rejectPendingAnswers: ((error: Error) => void) | undefined;
    createPendingRequestMock.mockReturnValue(
      new Promise((_, reject) => {
        rejectPendingAnswers = reject;
      }),
    );
    rejectRequestMock.mockImplementation(
      (_requestId: string, reason: string): boolean => {
        if (!rejectPendingAnswers) {
          throw new Error('Expected pending answer rejector');
        }
        rejectPendingAnswers(new Error(reason));
        return true;
      },
    );
    const win: SendableBrowserWindow = {
      isDestroyed: (): boolean => false,
      webContents: {
        isCrashed: (): boolean => false,
        isDestroyed: (): boolean => false,
        mainFrame: {
          detached: false,
          isDestroyed: (): boolean => false,
        },
        send: jest.fn(),
      },
    };
    const onEvent = jest.fn();
    const client = new CodexAppServerClient({
      cwd: '/tmp/repo',
      projectId: 'project',
      worktreeId: 'worktree',
      chatId: 'chat',
      sessionKey: 'project/worktree/chat',
      onEvent,
      getWindow: (): SendableBrowserWindow => win,
    });
    const { turnPromise } = await startActiveTurn(client, firstProc);

    emitServerMessage(firstProc, {
      id: 'server-user-input-1',
      method: 'item/tool/requestUserInput',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        itemId: 'item-1',
        questions: [
          {
            id: 'q1',
            header: 'Choice',
            question: 'Pick one',
            isOther: false,
            isSecret: false,
            options: [{ label: 'Option A', description: 'First option' }],
          },
        ],
      },
    });
    await flush();
    firstProc.emit('exit', 0, null);

    const initializeSecond = await waitForClientRequest(
      secondProc,
      'initialize',
    );
    expect(win.webContents.send).toHaveBeenCalledWith(
      IPC_CHANNELS.mcpExpireAskUser,
      { requestId: 'generated-request-id' },
    );
    expect(rejectRequestMock).toHaveBeenCalledWith(
      'generated-request-id',
      'ask_user_cancelled',
    );
    expect(onEvent).toHaveBeenCalledWith({
      type: 'codex',
      event: {
        type: 'item.completed',
        thread_id: 'thread-1',
        turn_id: 'turn-1',
        item: {
          type: 'dynamic_tool_call',
          id: 'item-1',
          namespace: null,
          tool: 'request_user_input',
          arguments: {
            questions: [
              {
                id: 'q1',
                header: 'Choice',
                question: 'Pick one',
                isOther: false,
                isSecret: false,
                options: [{ label: 'Option A', description: 'First option' }],
              },
            ],
          },
          status: 'failed',
          content_items: [{ type: 'inputText', text: 'ask_user_cancelled' }],
          success: false,
        },
      },
    });
    emitServerMessage(secondProc, {
      id: initializeSecond.id,
      result: { userAgent: 'ua', codexHome: '/tmp/.codex' },
    });
    const resume = await waitForClientRequest(secondProc, 'thread/resume');
    emitServerMessage(secondProc, {
      id: resume.id,
      result: makeThreadResult('thread-1', [
        {
          id: 'turn-1',
          items: [],
          status: 'completed',
          error: null,
        },
      ]),
    });

    await expect(turnPromise).resolves.toMatchObject({ status: 'completed' });
  });

  it('fails recovery but keeps the pool blocked until late tool handlers settle', async () => {
    const firstProc = new MockChildProcess();
    const secondProc = new MockChildProcess();
    spawnMock
      .mockReset()
      .mockReturnValueOnce(firstProc)
      .mockReturnValueOnce(secondProc);
    const onProcessRecovery = jest.fn();
    let resolveDynamicTool:
      | ((value: {
          contentItems: Array<{ type: 'inputText'; text: string }>;
          success: boolean;
        }) => void)
      | undefined;
    const dynamicToolResult = new Promise<{
      contentItems: Array<{ type: 'inputText'; text: string }>;
      success: boolean;
    }>((resolve) => {
      resolveDynamicTool = resolve;
    });
    const client = new CodexAppServerClient({
      cwd: '/tmp/repo',
      projectId: 'project',
      worktreeId: 'worktree',
      chatId: 'chat',
      sessionKey: 'project/worktree/chat',
      onEvent: jest.fn(),
      getWindow: (): null => null,
      dynamicToolCallHandler: (): typeof dynamicToolResult => dynamicToolResult,
      onProcessRecovery,
    });
    const peerClient = new CodexAppServerClient({
      cwd: '/tmp/repo',
      projectId: 'project',
      worktreeId: 'worktree',
      chatId: 'chat-b',
      sessionKey: 'project/worktree/chat-b',
      onEvent: jest.fn(),
      getWindow: (): null => null,
    });
    const { turnPromise } = await startActiveTurn(client, firstProc);
    void turnPromise.catch(() => {});

    emitServerMessage(firstProc, {
      id: 'server-tool-1',
      method: 'item/tool/call',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        callId: 'call-1',
        namespace: null,
        tool: 'test_tool',
        arguments: {},
      },
    });
    await flush();

    jest.useFakeTimers();
    try {
      firstProc.emit('exit', 0, null);
      await jest.advanceTimersByTimeAsync(30_000);

      await expect(turnPromise).rejects.toThrow(
        'host-side tool handlers did not settle within 30000ms',
      );
      expect(spawnMock).toHaveBeenCalledTimes(1);
      expect(onProcessRecovery).toHaveBeenCalledWith({
        status: 'failed',
        error:
          'Codex app-server background recovery failed: host-side tool handlers did not settle within 30000ms',
      });

      jest.useRealTimers();
      const peerRequest = peerClient.readAccount(false);
      void peerRequest.catch(() => {});
      await flush();
      expect(spawnMock).toHaveBeenCalledTimes(1);

      if (!resolveDynamicTool) {
        throw new Error('Expected dynamic tool resolver');
      }
      resolveDynamicTool({
        contentItems: [{ type: 'inputText', text: 'done' }],
        success: true,
      });

      const initializeSecond = await waitForClientRequest(
        secondProc,
        'initialize',
      );
      emitServerMessage(secondProc, {
        id: initializeSecond.id,
        result: { userAgent: 'ua', codexHome: '/tmp/.codex' },
      });
      const accountRead = await waitForClientRequest(
        secondProc,
        'account/read',
      );
      emitServerMessage(secondProc, {
        id: accountRead.id,
        result: {
          account: { type: 'apiKey' },
          requiresOpenaiAuth: false,
        },
      });
      await expect(peerRequest).resolves.toEqual({
        account: { type: 'apiKey' },
        requiresOpenaiAuth: false,
        workspaceRouting: null,
      });
    } finally {
      jest.useRealTimers();
      peerClient.dispose();
    }
  });

  it('recovers an active turn when the app-server output stream closes unexpectedly', async () => {
    const firstProc = new MockChildProcess();
    const secondProc = new MockChildProcess();
    const exits: unknown[] = [];
    const onSteeringEligibilityChanged = jest.fn();
    const recoveries: unknown[] = [];
    spawnMock
      .mockReset()
      .mockReturnValueOnce(firstProc)
      .mockReturnValueOnce(secondProc);
    const client = new CodexAppServerClient({
      cwd: '/tmp/repo',
      projectId: 'project',
      worktreeId: 'worktree',
      chatId: 'chat',
      sessionKey: 'project/worktree/chat',
      onSteeringEligibilityChanged,
      onEvent: jest.fn(),
      getWindow: (): null => null,
      onProcessExit: (details): void => {
        exits.push(details);
      },
      onProcessRecovery: (details): void => {
        recoveries.push(details);
      },
    });

    const turnPromise = client.startTurn({
      text: 'Wait for output',
      cwd: '/tmp/repo',
      model: 'gpt-6-sol',
      thinkingLevel: 'high',
      planMode: false,
    });
    void turnPromise.catch(() => {});

    await flush();
    emitServerMessage(firstProc, {
      id: 1,
      result: { userAgent: 'ua', codexHome: '/tmp/.codex' },
    });
    await flush();
    emitServerMessage(firstProc, {
      id: 2,
      result: makeThreadResult('thread-1'),
    });
    await flush();
    emitServerMessage(firstProc, {
      id: 3,
      result: {
        turn: { id: 'turn-1', items: [], status: 'inProgress', error: null },
      },
    });
    await flush();

    const consoleWarn = jest
      .spyOn(console, 'warn')
      .mockImplementation(() => undefined);
    firstProc.stderr.write(
      `${'old diagnostic\n'.repeat(500)}latest diagnostic\n`,
    );
    await flush();
    consoleWarn.mockRestore();
    firstProc.stdout.destroy();
    await flush();

    expect(firstProc.kill).toHaveBeenCalledWith('SIGTERM');
    const initialize = await waitForClientRequest(secondProc, 'initialize');
    emitServerMessage(secondProc, {
      id: initialize.id,
      result: { userAgent: 'ua', codexHome: '/tmp/.codex' },
    });
    const resume = await waitForClientRequest(secondProc, 'thread/resume');
    onSteeringEligibilityChanged.mockClear();
    emitServerMessage(secondProc, {
      id: resume.id,
      result: makeThreadResult('thread-1', [
        {
          id: 'turn-1',
          items: [],
          status: 'completed',
          error: null,
        },
      ]),
    });

    await expect(turnPromise).resolves.toMatchObject({ status: 'completed' });
    // Recovered id assignment and active-record clearing each publish.
    expect(
      onSteeringEligibilityChanged.mock.calls.length,
    ).toBeGreaterThanOrEqual(2);
    expect(client.getSteeringCapabilities().steer).toBe(false);
    await flush();
    expect(exits).toEqual([
      expect.objectContaining({
        recoveryScheduled: true,
        activeTurnCount: 1,
        stderrTruncated: true,
      }),
    ]);
    expect(recoveries).toEqual([
      { status: 'succeeded', strategy: 'reconciled' },
    ]);
  });

  // CAN-1641 regression: crash recovery used to resume with hardcoded
  // `approvalPolicy: 'never'` + `danger-full-access`, silently escalating an
  // Ask/Auto chat to an unrestricted sandbox with no approval prompts for the
  // rest of the turn. Only `full-access` may combine those two settings.
  it.each([
    ['ask', false],
    ['auto', false],
    ['full-access', true],
  ] as const)(
    'resumes a recovered turn under the %s approval policy',
    async (approvalMode, expectsUnrestricted) => {
      const firstProc = new MockChildProcess();
      const secondProc = new MockChildProcess();
      spawnMock
        .mockReset()
        .mockReturnValueOnce(firstProc)
        .mockReturnValueOnce(secondProc);
      const client = new CodexAppServerClient({
        cwd: '/tmp/repo',
        projectId: 'project',
        worktreeId: 'worktree',
        chatId: 'chat',
        sessionKey: 'project/worktree/chat',
        onEvent: jest.fn(),
        getWindow: (): null => null,
        approvalMode,
      });

      const { turnPromise } = await startActiveTurn(client, firstProc);
      void turnPromise.catch(() => {});

      firstProc.emit('exit', 0, null);
      const initialize = await waitForClientRequest(secondProc, 'initialize');
      emitServerMessage(secondProc, {
        id: initialize.id,
        result: { userAgent: 'ua', codexHome: '/tmp/.codex' },
      });

      const resume = await waitForClientRequest(secondProc, 'thread/resume');
      const params = getRequestParams(resume);
      expect(params).toEqual(expect.objectContaining({ threadId: 'thread-1' }));
      if (expectsUnrestricted) {
        expect(params.approvalPolicy).toBe('never');
        expect(params.sandbox).toBe('danger-full-access');
      } else {
        expect(params.approvalPolicy).not.toBe('never');
        expect(params.sandbox).toBe('read-only');
      }

      emitServerMessage(secondProc, {
        id: resume.id,
        result: makeThreadResult('thread-1', [
          { id: 'turn-1', items: [], status: 'completed', error: null },
        ]),
      });
      await expect(turnPromise).resolves.toMatchObject({
        status: 'completed',
      });
    },
  );

  it('re-supplies the project doc config when resuming a recovered turn', async () => {
    const firstProc = new MockChildProcess();
    const secondProc = new MockChildProcess();
    spawnMock
      .mockReset()
      .mockReturnValueOnce(firstProc)
      .mockReturnValueOnce(secondProc);
    const client = new CodexAppServerClient({
      cwd: '/tmp/repo',
      projectId: 'project',
      worktreeId: 'worktree',
      chatId: 'chat',
      sessionKey: 'project/worktree/chat',
      onEvent: jest.fn(),
      getWindow: (): null => null,
      threadConfig: { ...CODEX_PROJECT_DOC_THREAD_CONFIG },
    });

    const { turnPromise } = await startActiveTurn(client, firstProc);
    void turnPromise.catch(() => {});

    firstProc.emit('exit', 0, null);
    const initialize = await waitForClientRequest(secondProc, 'initialize');
    emitServerMessage(secondProc, {
      id: initialize.id,
      result: { userAgent: 'ua', codexHome: '/tmp/.codex' },
    });

    const resume = await waitForClientRequest(secondProc, 'thread/resume');
    expect(getRequestParams(resume).config).toMatchObject(
      PROJECT_DOC_THREAD_CONFIG,
    );

    emitServerMessage(secondProc, {
      id: resume.id,
      result: makeThreadResult('thread-1', [
        { id: 'turn-1', items: [], status: 'completed', error: null },
      ]),
    });
    await expect(turnPromise).resolves.toMatchObject({ status: 'completed' });
  });

  it('reconciles a steering pickup from a recovered thread user message', async () => {
    const firstProc = new MockChildProcess();
    const secondProc = new MockChildProcess();
    spawnMock
      .mockReset()
      .mockReturnValueOnce(firstProc)
      .mockReturnValueOnce(secondProc);
    const onEvent = jest.fn();
    const client = new CodexAppServerClient({
      cwd: '/tmp/repo',
      projectId: 'project',
      worktreeId: 'worktree',
      chatId: 'chat',
      sessionKey: 'project/worktree/chat',
      onEvent,
      getWindow: (): null => null,
    });
    const { turnPromise } = await startActiveTurn(client, firstProc);
    const steering = client.submitSteeringInput(
      'Recovered steering input',
      'recovered-steer',
    );
    const steer = await waitForClientRequest(firstProc, 'turn/steer');
    emitServerMessage(firstProc, {
      id: steer.id,
      result: { turnId: 'turn-1' },
    });
    await expect(steering).resolves.toMatchObject({ kind: 'accepted' });

    firstProc.emit('exit', 0, null);
    const initialize = await waitForClientRequest(secondProc, 'initialize');
    emitServerMessage(secondProc, {
      id: initialize.id,
      result: { userAgent: 'ua', codexHome: '/tmp/.codex' },
    });
    const resume = await waitForClientRequest(secondProc, 'thread/resume');
    emitServerMessage(secondProc, {
      id: resume.id,
      result: makeThreadResult('thread-1', [
        {
          id: 'turn-1',
          items: [
            {
              id: 'recovered-user-item',
              type: 'userMessage',
              clientId: 'recovered-steer',
              content: [
                {
                  type: 'text',
                  text: 'Recovered steering input',
                  text_elements: [],
                },
              ],
            },
          ],
          status: 'completed',
          error: null,
        },
      ]),
    });

    await expect(turnPromise).resolves.toMatchObject({ status: 'completed' });
    expect(onEvent).toHaveBeenCalledWith({
      type: 'canopy_input_delivery',
      provider: 'codex',
      generation: expect.any(String),
      attemptId: 'recovered-steer',
      phase: 'picked-up',
      providerTurnId: 'turn-1',
      itemId: 'recovered-user-item',
    });
  });

  it.each(['ask', 'auto', 'full-access'] as const)(
    'resumes a recovered plan-mode turn with the %s session policy',
    async (approvalMode) => {
      const firstProc = new MockChildProcess();
      const secondProc = new MockChildProcess();
      spawnMock
        .mockReset()
        .mockReturnValueOnce(firstProc)
        .mockReturnValueOnce(secondProc);
      const client = new CodexAppServerClient({
        cwd: '/tmp/repo',
        projectId: 'project',
        worktreeId: 'worktree',
        chatId: 'chat',
        sessionKey: 'project/worktree/chat',
        onEvent: jest.fn(),
        getWindow: (): null => null,
        approvalMode,
      });

      const turnPromise = client.startTurn({
        text: 'Plan this change',
        cwd: '/tmp/repo',
        model: 'gpt-6-sol',
        thinkingLevel: 'high',
        planMode: true,
      });
      void turnPromise.catch(() => {});

      await flush();
      emitServerMessage(firstProc, {
        id: 1,
        result: { userAgent: 'ua', codexHome: '/tmp/.codex' },
      });
      await flush();
      emitServerMessage(firstProc, {
        id: 2,
        result: makeThreadResult('thread-1'),
      });
      await flush();
      emitServerMessage(firstProc, {
        id: 3,
        result: {
          turn: { id: 'turn-1', items: [], status: 'inProgress', error: null },
        },
      });
      await flush();

      firstProc.emit('exit', 0, null);
      const initialize = await waitForClientRequest(secondProc, 'initialize');
      emitServerMessage(secondProc, {
        id: initialize.id,
        result: { userAgent: 'ua', codexHome: '/tmp/.codex' },
      });

      const resume = await waitForClientRequest(secondProc, 'thread/resume');
      const params = getRequestParams(resume);
      if (approvalMode === 'full-access') {
        expect(params.approvalPolicy).toBe('never');
        expect(params.sandbox).toBe('danger-full-access');
      } else {
        expect(params.approvalPolicy).not.toBe('never');
        expect(params.sandbox).toBe('read-only');
      }

      emitServerMessage(secondProc, {
        id: resume.id,
        result: makeThreadResult('thread-1', [
          { id: 'turn-1', items: [], status: 'completed', error: null },
        ]),
      });
      await expect(turnPromise).resolves.toMatchObject({ status: 'completed' });
    },
  );

  it('reconciles a completed recovered turn despite MCP startup failure', async () => {
    const firstProc = new MockChildProcess();
    const secondProc = new MockChildProcess();
    spawnMock
      .mockReset()
      .mockReturnValueOnce(firstProc)
      .mockReturnValueOnce(secondProc);
    const onProcessRecovery = jest.fn();
    const client = new CodexAppServerClient({
      cwd: '/tmp/repo',
      projectId: 'project',
      worktreeId: 'worktree',
      chatId: 'chat',
      sessionKey: 'project/worktree/chat',
      onEvent: jest.fn(),
      getWindow: (): null => null,
      mcpServersConfig: {
        linear: {
          url: 'http://127.0.0.1:37646/mcp/linear',
        },
      },
      onProcessRecovery,
    });

    const turnPromise = client.startTurn({
      text: 'Complete before the transport exits',
      cwd: '/tmp/repo',
      model: 'gpt-6-sol',
      thinkingLevel: 'high',
      planMode: false,
    });
    const initializeFirst = await waitForClientRequest(firstProc, 'initialize');
    emitServerMessage(firstProc, {
      id: initializeFirst.id,
      result: { userAgent: 'ua', codexHome: '/tmp/.codex' },
    });
    const threadStart = await waitForClientRequest(firstProc, 'thread/start');
    emitServerMessage(firstProc, {
      id: threadStart.id,
      result: makeThreadResult('thread-1'),
    });
    emitServerMessage(firstProc, {
      method: 'mcpServer/startupStatus/updated',
      params: {
        threadId: 'thread-1',
        name: 'linear',
        status: 'ready',
        error: null,
        failureReason: null,
      },
    });
    const turnStart = await waitForClientRequest(firstProc, 'turn/start');
    emitServerMessage(firstProc, {
      id: turnStart.id,
      result: {
        turn: { id: 'turn-1', items: [], status: 'inProgress', error: null },
      },
    });
    await flush();

    firstProc.emit('exit', 0, null);
    const initializeSecond = await waitForClientRequest(
      secondProc,
      'initialize',
    );
    emitServerMessage(secondProc, {
      id: initializeSecond.id,
      result: { userAgent: 'ua', codexHome: '/tmp/.codex' },
    });
    const resume = await waitForClientRequest(secondProc, 'thread/resume');
    emitServerMessage(secondProc, {
      id: resume.id,
      result: makeThreadResult('thread-1', [
        {
          id: 'turn-1',
          items: [],
          status: 'completed',
          error: null,
        },
      ]),
    });
    emitServerMessage(secondProc, {
      method: 'mcpServer/startupStatus/updated',
      params: {
        threadId: 'thread-1',
        name: 'linear',
        status: 'failed',
        error: 'MCP handshake failed',
        failureReason: null,
      },
    });

    await expect(turnPromise).resolves.toMatchObject({ status: 'completed' });
    await flush();
    expect(onProcessRecovery).toHaveBeenCalledWith({
      status: 'succeeded',
      strategy: 'reconciled',
    });
  });

  it('does not replay a host-owned activation after the transport loses admission', async () => {
    const client = createClient();
    const turn = client.startTurn({
      text: 'Continue the interrupted request',
      cwd: '/tmp/repo',
      model: 'gpt-6-sol',
      thinkingLevel: 'high',
      planMode: false,
      beforeAdmission: async () => {},
    });
    void turn.catch(() => {});
    const initialize = await waitForClientRequest(proc, 'initialize');
    emitServerMessage(proc, {
      id: initialize.id,
      result: { userAgent: 'ua', codexHome: '/tmp/.codex' },
    });
    const thread = await waitForClientRequest(proc, 'thread/start');
    emitServerMessage(proc, {
      id: thread.id,
      result: makeThreadResult('thread-1'),
    });
    await waitForClientRequest(proc, 'turn/start');
    const recovery = client.recoverAfterUnexpectedProcessExit(
      new CodexRecoverableProcessExitError('lost admission'),
    );
    void recovery.catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 100));
    try {
      expect(
        collectClientMessages(proc).filter(
          (message) => message.method === 'thread/resume',
        ),
      ).toHaveLength(0);
    } finally {
      client.dispose();
    }
    await expect(recovery).rejects.toThrow('lost admission');
  });

  it('does not apply a stale recovery outcome or failure to a newer turn', async () => {
    const client = createClient();
    const { turnPromise: originalTurnPromise } = await startActiveTurn(
      client,
      proc,
    );
    const recovery = client.recoverAfterUnexpectedProcessExit(
      new CodexRecoverableProcessExitError('test recovery'),
    );
    const resume = await waitForClientRequest(proc, 'thread/resume');

    client.rejectActiveTurn(new Error('original turn cancelled'));
    await expect(originalTurnPromise).rejects.toThrow(
      'original turn cancelled',
    );

    const nextTurnPromise = client.startTurn({
      text: 'Run the newer turn',
      cwd: '/tmp/repo',
      model: 'gpt-6-sol',
      thinkingLevel: 'high',
      planMode: false,
    });
    const nextTurnStart = await waitForClientRequest(proc, 'turn/start');

    emitServerMessage(proc, {
      id: resume.id,
      result: makeThreadResult('thread-1', [
        {
          id: 'turn-1',
          items: [],
          status: 'completed',
          error: null,
        },
      ]),
    });
    await expect(recovery).rejects.toThrow(
      'Codex turn ended while process recovery was pending',
    );
    client.rejectActiveTurn(new Error('stale recovery failed'), recovery);

    emitServerMessage(proc, {
      id: nextTurnStart.id,
      result: {
        turn: { id: 'turn-2', items: [], status: 'inProgress', error: null },
      },
    });
    completeRootTurn(proc, 'turn-2');

    await expect(nextTurnPromise).resolves.toMatchObject({
      status: 'completed',
    });
  });

  it.each(['reauthenticationRequired', 'serverInitializationFailed'])(
    'continues process recovery when a selected MCP fails: %s',
    async (failureReason) => {
      const firstProc = new MockChildProcess();
      const secondProc = new MockChildProcess();
      spawnMock
        .mockReset()
        .mockReturnValueOnce(firstProc)
        .mockReturnValueOnce(secondProc);
      const onProcessRecovery = jest.fn();
      const events: unknown[] = [];
      const client = new CodexAppServerClient({
        cwd: '/tmp/repo',
        projectId: 'project',
        worktreeId: 'worktree',
        chatId: 'chat',
        sessionKey: 'project/worktree/chat',
        onEvent: (event): void => {
          events.push(event);
        },
        getWindow: (): null => null,
        mcpServersConfig: {
          linear: { url: 'http://127.0.0.1:37646/mcp/linear' },
        },
        onProcessRecovery,
      });

      const { turnPromise } = await startActiveTurn(client, firstProc, [
        'linear',
      ]);
      let turnSettled = false;
      void turnPromise.then(
        () => {
          turnSettled = true;
        },
        () => {
          turnSettled = true;
        },
      );
      firstProc.exitCode = 0;
      firstProc.emit('exit', 0, null);
      emitServerMessage(firstProc, {
        method: 'turn/completed',
        params: {
          threadId: 'thread-1',
          turn: { id: 'turn-1', items: [], status: 'completed', error: null },
        },
      });
      await flush();
      expect(turnSettled).toBe(false);

      const initialize = await waitForClientRequest(secondProc, 'initialize');
      emitServerMessage(secondProc, {
        id: initialize.id,
        result: { userAgent: 'ua', codexHome: '/tmp/.codex' },
      });
      const resume = await waitForClientRequest(secondProc, 'thread/resume');
      emitServerMessage(secondProc, {
        id: resume.id,
        result: makeThreadResult('thread-1', [
          {
            id: 'turn-1',
            items: [
              {
                type: 'agentMessage',
                id: 'persisted-msg-1',
                text: 'Persisted before the transport exited',
                phase: 'commentary',
              },
            ],
            status: 'inProgress',
            error: null,
          },
        ]),
      });
      emitServerMessage(secondProc, {
        method: 'mcpServer/startupStatus/updated',
        params: {
          threadId: 'thread-1',
          name: 'linear',
          status: 'failed',
          error:
            failureReason === 'reauthenticationRequired'
              ? 'Authentication is required'
              : 'HTTP 503: MCP authorization is temporarily unavailable',
          failureReason,
        },
      });
      const continuation = await waitForClientRequest(secondProc, 'turn/start');
      expect(events).toContainEqual({
        type: 'codex',
        event: {
          type: 'item.completed',
          thread_id: 'thread-1',
          turn_id: 'turn-1',
          item: {
            type: 'agent_message',
            id: 'persisted-msg-1',
            text: 'Persisted before the transport exited',
            phase: 'commentary',
          },
        },
      });
      const continuationParams = getRequestParams(continuation);
      const continuationInput = continuationParams.input;
      if (
        !Array.isArray(continuationInput) ||
        !isRecord(continuationInput[0])
      ) {
        throw new Error('Expected recovery continuation input');
      }
      expect(continuationInput[0].text).toEqual(
        expect.stringContaining('do not repeat any operation'),
      );
      emitServerMessage(secondProc, {
        id: continuation.id,
        result: {
          turn: { id: 'turn-2', items: [], status: 'inProgress', error: null },
        },
      });

      completeRootTurn(secondProc, 'turn-2');
      await expect(turnPromise).resolves.toMatchObject({ status: 'completed' });
      await flush();
      expect(onProcessRecovery).toHaveBeenCalledWith({
        status: 'succeeded',
        strategy: 'continued',
      });
    },
  );

  it('continues an interrupted persisted turn without replaying its original request', async () => {
    const firstProc = new MockChildProcess();
    const secondProc = new MockChildProcess();
    spawnMock
      .mockReset()
      .mockReturnValueOnce(firstProc)
      .mockReturnValueOnce(secondProc);
    const onProcessRecovery = jest.fn();
    const client = new CodexAppServerClient({
      cwd: '/tmp/repo',
      projectId: 'project',
      worktreeId: 'worktree',
      chatId: 'chat',
      sessionKey: 'project/worktree/chat',
      onEvent: jest.fn(),
      getWindow: (): null => null,
      onProcessRecovery,
    });

    const { turnPromise } = await startActiveTurn(
      client,
      firstProc,
      [],
      'host-message-original',
      'submission-original',
      'client-message-original',
    );
    try {
      firstProc.emit('exit', 0, null);
      const initialize = await waitForClientRequest(secondProc, 'initialize');
      emitServerMessage(secondProc, {
        id: initialize.id,
        result: { userAgent: 'ua', codexHome: '/tmp/.codex' },
      });
      const resume = await waitForClientRequest(secondProc, 'thread/resume');
      emitServerMessage(secondProc, {
        id: resume.id,
        result: makeThreadResult('thread-1', [
          {
            id: 'turn-1',
            items: [],
            status: 'interrupted',
            error: null,
          },
        ]),
      });
      const continuation = await waitForClientRequest(secondProc, 'turn/start');
      const continuationParams = getRequestParams(continuation);
      expect(continuationParams.clientUserMessageId).toEqual(
        expect.any(String),
      );
      expect(continuationParams.clientUserMessageId).not.toBe(
        'client-message-original',
      );
      const continuationInput = continuationParams.input;
      if (
        !Array.isArray(continuationInput) ||
        !isRecord(continuationInput[0])
      ) {
        throw new Error('Expected recovery continuation input');
      }
      expect(continuationInput[0].text).toEqual(
        expect.stringContaining('do not repeat any operation'),
      );
      expect(continuationInput[0].text).not.toBe('Run');
      emitServerMessage(secondProc, {
        method: 'turn/completed',
        params: {
          threadId: 'thread-1',
          turn: { id: 'turn-2', items: [], status: 'completed', error: null },
        },
      });
      await flush();
      emitServerMessage(secondProc, {
        id: continuation.id,
        result: {
          turn: { id: 'turn-2', items: [], status: 'inProgress', error: null },
        },
      });

      await expect(turnPromise).resolves.toMatchObject({ status: 'completed' });
      await flush();
      expect(onProcessRecovery).toHaveBeenCalledWith({
        status: 'succeeded',
        strategy: 'continued',
      });
    } finally {
      client.dispose();
      await turnPromise.catch(() => undefined);
    }
  });

  it('places a fresh restart execution at its retained anchor without binding it as input', async () => {
    const firstProc = new MockChildProcess();
    const secondProc = new MockChildProcess();
    spawnMock
      .mockReset()
      .mockReturnValueOnce(firstProc)
      .mockReturnValueOnce(secondProc);
    const events: unknown[] = [];
    const observations: TurnLifecycleObservation[] = [];
    const client = new CodexAppServerClient({
      cwd: '/tmp/repo',
      projectId: 'project',
      worktreeId: 'worktree',
      chatId: 'chat',
      sessionKey: 'project/worktree/chat',
      onTurnLifecycleObservation: (event): void => {
        observations.push(event);
      },
      onEvent: (event): void => {
        events.push(event);
      },
      getWindow: (): null => null,
    });
    const rootStarts = (): unknown[] =>
      events.flatMap((event) =>
        isRecord(event) &&
        isRecord(event.event) &&
        event.event.type === 'turn.started' &&
        event.event.thread_id === 'thread-1'
          ? [event.event.turn_id]
          : [],
      );

    const { turnPromise } = await startActiveTurn(
      client,
      firstProc,
      [],
      'msg-1',
    );
    void turnPromise.catch(() => undefined);
    emitServerMessage(firstProc, {
      method: 'turn/started',
      params: {
        threadId: 'thread-1',
        turn: { id: 'turn-1', items: [], status: 'inProgress', error: null },
      },
    });
    await flush();
    expect(rootStarts()).toEqual(['turn-1']);

    firstProc.emit('exit', 0, null);
    const initialize = await waitForClientRequest(secondProc, 'initialize');
    emitServerMessage(secondProc, {
      id: initialize.id,
      result: { userAgent: 'ua', codexHome: '/tmp/.codex' },
    });
    const resume = await waitForClientRequest(secondProc, 'thread/resume');
    emitServerMessage(secondProc, {
      id: resume.id,
      result: makeThreadResult('thread-1', [
        { id: 'turn-1', items: [], status: 'interrupted', error: null },
      ]),
    });
    const continuation = await waitForClientRequest(secondProc, 'turn/start');
    emitServerMessage(secondProc, {
      id: continuation.id,
      result: {
        turn: { id: 'turn-2', items: [], status: 'inProgress', error: null },
      },
    });
    emitServerMessage(secondProc, {
      method: 'turn/started',
      params: {
        threadId: 'thread-1',
        turn: { id: 'turn-2', items: [], status: 'inProgress', error: null },
      },
    });
    await flush();
    // Routers and the session manager learn the new native root only here.
    expect(rootStarts()).toEqual(['turn-1', 'turn-2']);
    const restartedStart = events.find(
      (event) =>
        isRecord(event) &&
        isRecord(event.event) &&
        event.event.type === 'turn.started' &&
        event.event.turn_id === 'turn-2',
    );
    expect(getProviderRunDescriptor(restartedStart)).toMatchObject({
      turnId: 'turn-2',
      executionUserMessageId: 'msg-1',
    });
    expect(observations).toContainEqual(
      expect.objectContaining({
        type: 'turn-started',
        turnId: 'turn-2',
        origin: 'restart',
      }),
    );
    const restartedLifecycle = observations.find(
      (event) => event.type === 'turn-started' && event.turnId === 'turn-2',
    );
    expect(restartedLifecycle).not.toHaveProperty('userMessageId');
    expect(restartedLifecycle).not.toHaveProperty('submissionId');

    emitServerMessage(secondProc, {
      method: 'turn/completed',
      params: {
        threadId: 'thread-1',
        turn: { id: 'turn-2', items: [], status: 'completed', error: null },
      },
    });
    await expect(turnPromise).resolves.toMatchObject({ status: 'completed' });
  });

  it('lets a turn continued by recovery after a terminal read be steered again', async () => {
    const firstProc = new MockChildProcess();
    const secondProc = new MockChildProcess();
    spawnMock
      .mockReset()
      .mockReturnValueOnce(firstProc)
      .mockReturnValueOnce(secondProc);
    const onSteeringEligibilityChanged = jest.fn();
    let release = (): void => undefined;
    const admission = new Promise<void>((resolve) => {
      release = resolve;
    });
    const client = new CodexAppServerClient({
      cwd: '/tmp/repo',
      projectId: 'project',
      worktreeId: 'worktree',
      chatId: 'chat',
      sessionKey: 'project/worktree/chat',
      onSteeringEligibilityChanged,
      onEvent: (event): Promise<void> | undefined =>
        typeof event === 'object' &&
        event !== null &&
        'event' in event &&
        typeof event.event === 'object' &&
        event.event !== null &&
        'type' in event.event &&
        event.event.type === 'item.started'
          ? admission
          : undefined,
      getWindow: (): null => null,
    });

    const { turnPromise } = await startActiveTurn(client, firstProc);
    try {
      onSteeringEligibilityChanged.mockClear();
      emitServerMessage(firstProc, {
        method: 'item/started',
        params: {
          threadId: 'thread-1',
          turnId: 'turn-1',
          item: {
            id: 'command',
            type: 'commandExecution',
            command: 'echo test',
            cwd: '/tmp/repo',
            status: 'inProgress',
            commandActions: [],
          },
        },
      });
      // The fatal error is read while the transcript before it is held, so
      // the turn's steering closes, and the worker is lost before it drains.
      emitServerMessage(firstProc, {
        method: 'error',
        params: {
          threadId: 'thread-1',
          turnId: 'turn-1',
          willRetry: false,
          error: { message: 'stream failed' },
        },
      });
      await flush();
      expect(client.getSteeringCapabilities().steer).toBe(false);
      expect(onSteeringEligibilityChanged).toHaveBeenCalled();
      onSteeringEligibilityChanged.mockClear();

      firstProc.emit('exit', 0, null);
      const initialize = await waitForClientRequest(secondProc, 'initialize');
      emitServerMessage(secondProc, {
        id: initialize.id,
        result: { userAgent: 'ua', codexHome: '/tmp/.codex' },
      });
      const resume = await waitForClientRequest(secondProc, 'thread/resume');
      emitServerMessage(secondProc, {
        id: resume.id,
        result: makeThreadResult('thread-1', [
          {
            id: 'turn-1',
            items: [],
            status: 'failed',
            error: { message: 'stream failed' },
          },
        ]),
      });
      const continuation = await waitForClientRequest(secondProc, 'turn/start');
      expect(client.getSteeringCapabilities().steer).toBe(false);
      expect(client.hasActiveTurn()).toBe(true);
      expect(onSteeringEligibilityChanged).toHaveBeenCalled();
      onSteeringEligibilityChanged.mockClear();
      emitServerMessage(secondProc, {
        id: continuation.id,
        result: {
          turn: { id: 'turn-2', items: [], status: 'inProgress', error: null },
        },
      });
      await flush();
      expect(client.getSteeringCapabilities().steer).toBe(true);
      expect(client.hasActiveTurn()).toBe(true);
      expect(onSteeringEligibilityChanged).toHaveBeenCalled();

      emitServerMessage(secondProc, {
        method: 'turn/completed',
        params: {
          threadId: 'thread-1',
          turn: { id: 'turn-2', items: [], status: 'completed', error: null },
        },
      });
      await expect(turnPromise).resolves.toMatchObject({
        status: 'completed',
      });
    } finally {
      release();
      client.dispose();
      await turnPromise.catch(() => undefined);
    }
  });

  it('holds a recovery continuation fatal error after the lost turn held one', async () => {
    const firstProc = new MockChildProcess();
    const secondProc = new MockChildProcess();
    spawnMock
      .mockReset()
      .mockReturnValueOnce(firstProc)
      .mockReturnValueOnce(secondProc);
    const client = new CodexAppServerClient({
      cwd: '/tmp/repo',
      projectId: 'project',
      worktreeId: 'worktree',
      chatId: 'chat',
      sessionKey: 'project/worktree/chat',
      onEvent: jest.fn(),
      getWindow: (): null => null,
    });

    const { turnPromise } = await startActiveTurn(client, firstProc);
    try {
      emitServerMessage(firstProc, {
        method: 'error',
        params: {
          threadId: 'thread-1',
          turnId: 'turn-1',
          willRetry: false,
          error: { message: 'first failure' },
        },
      });
      await flush();
      // The worker is lost before the lost turn's failed completion arrives.
      firstProc.emit('exit', 0, null);
      const initialize = await waitForClientRequest(secondProc, 'initialize');
      emitServerMessage(secondProc, {
        id: initialize.id,
        result: { userAgent: 'ua', codexHome: '/tmp/.codex' },
      });
      const resume = await waitForClientRequest(secondProc, 'thread/resume');
      emitServerMessage(secondProc, {
        id: resume.id,
        result: makeThreadResult('thread-1', [
          {
            id: 'turn-1',
            items: [],
            status: 'failed',
            error: { message: 'first failure' },
          },
        ]),
      });
      const continuation = await waitForClientRequest(secondProc, 'turn/start');
      emitServerMessage(secondProc, {
        id: continuation.id,
        result: {
          turn: { id: 'turn-2', items: [], status: 'inProgress', error: null },
        },
      });
      await flush();
      expect(client.getSteeringCapabilities().steer).toBe(true);

      emitServerMessage(secondProc, {
        method: 'error',
        params: {
          threadId: 'thread-1',
          turnId: 'turn-2',
          willRetry: false,
          error: { message: 'second failure' },
        },
      });
      await flush();
      expect(client.getSteeringCapabilities().steer).toBe(false);

      emitServerMessage(secondProc, {
        method: 'turn/completed',
        params: {
          threadId: 'thread-1',
          turn: { id: 'turn-2', items: [], status: 'failed', error: null },
        },
      });
      await expect(turnPromise).resolves.toMatchObject({
        status: 'failed',
        error: 'second failure',
      });
    } finally {
      client.dispose();
      await turnPromise.catch(() => undefined);
    }
  });

  it('recovers a bystander turn when another chat forces a shared restart', async () => {
    const firstProc = new MockChildProcess();
    const secondProc = new MockChildProcess();
    spawnMock
      .mockReset()
      .mockReturnValueOnce(firstProc)
      .mockReturnValueOnce(secondProc);
    const onProcessRecovery = jest.fn();
    const bystander = new CodexAppServerClient({
      cwd: '/tmp/repo',
      projectId: 'project',
      worktreeId: 'worktree',
      chatId: 'bystander',
      sessionKey: 'project/worktree/bystander',
      onEvent: jest.fn(),
      getWindow: (): null => null,
      onProcessRecovery,
    });
    const stopping = new CodexAppServerClient({
      cwd: '/tmp/repo',
      projectId: 'project',
      worktreeId: 'worktree',
      chatId: 'stopping',
      sessionKey: 'project/worktree/stopping',
      onEvent: jest.fn(),
      getWindow: (): null => null,
    });

    const { turnPromise: bystanderTurn } = await startActiveTurn(
      bystander,
      firstProc,
    );
    collectClientMessages(firstProc);
    const stoppingTurn = stopping.startTurn({
      text: 'Run elsewhere',
      cwd: '/tmp/repo',
      model: 'gpt-6-sol',
      thinkingLevel: 'high',
      planMode: false,
    });
    const stoppingFailure =
      expect(stoppingTurn).rejects.toThrow('turn_cancelled');
    const stoppingThread = await waitForClientRequest(
      firstProc,
      'thread/start',
    );
    emitServerMessage(firstProc, {
      id: stoppingThread.id,
      result: makeThreadResult('thread-2'),
    });
    const stoppingTurnStart = await waitForClientRequest(
      firstProc,
      'turn/start',
    );
    emitServerMessage(firstProc, {
      id: stoppingTurnStart.id,
      result: {
        turn: { id: 'turn-b', items: [], status: 'inProgress', error: null },
      },
    });
    await flush();

    // Both bounded interrupt attempts fail, so the shared process is stopped.
    const interruptPromise = stopping.interruptTurn();
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const interrupt = await waitForClientRequest(firstProc, 'turn/interrupt');
      emitServerMessage(firstProc, {
        id: interrupt.id,
        error: { code: -32000, message: 'interrupt unavailable' },
      });
    }
    await interruptPromise;
    expect(firstProc.kill).toHaveBeenCalledWith('SIGTERM');
    await stoppingFailure;

    const initialize = await waitForClientRequest(secondProc, 'initialize');
    emitServerMessage(secondProc, {
      id: initialize.id,
      result: { userAgent: 'ua', codexHome: '/tmp/.codex' },
    });
    const sent: Array<Record<string, unknown>> = [];
    const resume = await waitForClientRequestRecording(
      secondProc,
      'thread/resume',
      sent,
    );
    expect(getRequestParams(resume).threadId).toBe('thread-1');
    emitServerMessage(secondProc, {
      id: resume.id,
      result: makeThreadResult('thread-1', [
        { id: 'turn-1', items: [], status: 'interrupted', error: null },
      ]),
    });
    const continuation = await waitForClientRequestRecording(
      secondProc,
      'turn/start',
      sent,
    );
    const continuationInput = getRequestParams(continuation).input;
    if (!Array.isArray(continuationInput) || !isRecord(continuationInput[0])) {
      throw new Error('Expected recovery continuation input');
    }
    // The bystander continues from persisted state; its prompt is not resent.
    expect(continuationInput[0].text).not.toBe('Run');
    emitServerMessage(secondProc, {
      id: continuation.id,
      result: {
        turn: { id: 'turn-2', items: [], status: 'inProgress', error: null },
      },
    });
    emitServerMessage(secondProc, {
      method: 'turn/completed',
      params: {
        threadId: 'thread-1',
        turn: { id: 'turn-2', items: [], status: 'completed', error: null },
      },
    });

    await expect(bystanderTurn).resolves.toMatchObject({
      status: 'completed',
    });
    await flush();
    expect(onProcessRecovery).toHaveBeenCalledWith({
      status: 'succeeded',
      strategy: 'continued',
    });
    // The stopped chat's thread is never resumed on the replacement process.
    sent.push(...collectClientMessages(secondProc));
    expect(
      sent
        .filter((message) => message.method === 'thread/resume')
        .map((message) => getRequestParams(message).threadId),
    ).toEqual(['thread-1']);
    bystander.dispose();
    stopping.dispose();
  });

  it.each(['inProgress', 'failed', 'interrupted'])(
    'reconciles a user interrupt when recovery reports %s',
    async (recoveredStatus) => {
      const firstProc = new MockChildProcess();
      const secondProc = new MockChildProcess();
      spawnMock
        .mockReset()
        .mockReturnValueOnce(firstProc)
        .mockReturnValueOnce(secondProc);
      const onProcessRecovery = jest.fn();
      let finishInterrupt: (() => void) | undefined;
      const interruptSpy = jest
        .spyOn(CodexAppServerConnection.prototype, 'interruptTurn')
        .mockImplementation(
          (): Promise<void> =>
            new Promise((resolve) => {
              finishInterrupt = resolve;
            }),
        );
      const client = new CodexAppServerClient({
        cwd: '/tmp/repo',
        projectId: 'project',
        worktreeId: 'worktree',
        chatId: 'chat',
        sessionKey: 'project/worktree/chat',
        onEvent: jest.fn(),
        getWindow: (): null => null,
        onProcessRecovery,
      });

      const { turnPromise } = await startActiveTurn(client, firstProc);
      void turnPromise.catch(() => {});
      const interruptPromise = client.interruptTurn();
      await flush();
      expect(interruptSpy).toHaveBeenCalledTimes(1);

      firstProc.emit('exit', 0, null);
      const initialize = await waitForClientRequest(secondProc, 'initialize');
      emitServerMessage(secondProc, {
        id: initialize.id,
        result: { userAgent: 'ua', codexHome: '/tmp/.codex' },
      });
      const resume = await waitForClientRequest(secondProc, 'thread/resume');
      emitServerMessage(secondProc, {
        id: resume.id,
        result: makeThreadResult('thread-1', [
          {
            id: 'turn-1',
            items: [],
            status: recoveredStatus,
            error: null,
          },
        ]),
      });

      await expect(turnPromise).resolves.toMatchObject({
        status: 'interrupted',
      });
      if (!finishInterrupt) {
        throw new Error('Expected pending interrupt request');
      }
      finishInterrupt();
      await interruptPromise;
      interruptSpy.mockRestore();
      await flush();
      expect(collectClientMessages(secondProc)).not.toContainEqual(
        expect.objectContaining({ method: 'turn/start' }),
      );
      expect(onProcessRecovery).toHaveBeenCalledWith({
        status: 'succeeded',
        strategy: 'reconciled',
      });
    },
  );

  it('reconciles a user interrupt received during the MCP recovery wait', async () => {
    const firstProc = new MockChildProcess();
    const secondProc = new MockChildProcess();
    spawnMock
      .mockReset()
      .mockReturnValueOnce(firstProc)
      .mockReturnValueOnce(secondProc);
    let finishInterrupt: (() => void) | undefined;
    const interruptSpy = jest
      .spyOn(CodexAppServerConnection.prototype, 'interruptTurn')
      .mockImplementation(
        (): Promise<void> =>
          new Promise((resolve) => {
            finishInterrupt = resolve;
          }),
      );
    const client = new CodexAppServerClient({
      cwd: '/tmp/repo',
      projectId: 'project',
      worktreeId: 'worktree',
      chatId: 'chat',
      sessionKey: 'project/worktree/chat',
      onEvent: jest.fn(),
      getWindow: (): null => null,
      mcpServersConfig: {
        linear: {
          url: 'http://127.0.0.1:37646/mcp/linear',
        },
      },
    });

    const turnPromise = client.startTurn({
      text: 'Stop while recovery waits for MCP startup',
      cwd: '/tmp/repo',
      model: 'gpt-6-sol',
      thinkingLevel: 'high',
      planMode: false,
    });
    const initializeFirst = await waitForClientRequest(firstProc, 'initialize');
    emitServerMessage(firstProc, {
      id: initializeFirst.id,
      result: { userAgent: 'ua', codexHome: '/tmp/.codex' },
    });
    const threadStart = await waitForClientRequest(firstProc, 'thread/start');
    emitServerMessage(firstProc, {
      id: threadStart.id,
      result: makeThreadResult('thread-1'),
    });
    emitServerMessage(firstProc, {
      method: 'mcpServer/startupStatus/updated',
      params: {
        threadId: 'thread-1',
        name: 'linear',
        status: 'ready',
        error: null,
        failureReason: null,
      },
    });
    const turnStart = await waitForClientRequest(firstProc, 'turn/start');
    emitServerMessage(firstProc, {
      id: turnStart.id,
      result: {
        turn: { id: 'turn-1', items: [], status: 'inProgress', error: null },
      },
    });

    firstProc.emit('exit', 0, null);
    const initializeSecond = await waitForClientRequest(
      secondProc,
      'initialize',
    );
    emitServerMessage(secondProc, {
      id: initializeSecond.id,
      result: { userAgent: 'ua', codexHome: '/tmp/.codex' },
    });
    const resume = await waitForClientRequest(secondProc, 'thread/resume');
    emitServerMessage(secondProc, {
      id: resume.id,
      result: makeThreadResult('thread-1', [
        {
          id: 'turn-1',
          items: [],
          status: 'inProgress',
          error: null,
        },
      ]),
    });
    emitServerMessage(secondProc, {
      method: 'mcpServer/startupStatus/updated',
      params: {
        threadId: 'thread-1',
        name: 'linear',
        status: 'starting',
        error: null,
        failureReason: null,
      },
    });
    await flush();
    expect(
      collectClientMessages(secondProc).filter(
        (message) => message.method === 'turn/start',
      ),
    ).toHaveLength(0);

    const interruptPromise = client.interruptTurn();
    await flush();
    expect(interruptSpy).toHaveBeenCalledTimes(1);
    emitServerMessage(secondProc, {
      method: 'mcpServer/startupStatus/updated',
      params: {
        threadId: 'thread-1',
        name: 'linear',
        status: 'ready',
        error: null,
        failureReason: null,
      },
    });

    await expect(turnPromise).resolves.toMatchObject({
      status: 'interrupted',
    });
    expect(
      collectClientMessages(secondProc).filter(
        (message) => message.method === 'turn/start',
      ),
    ).toHaveLength(0);
    if (!finishInterrupt) {
      throw new Error('Expected pending interrupt request');
    }
    finishInterrupt();
    await interruptPromise;
    interruptSpy.mockRestore();
  });

  it('does not replay a user-interrupted turn whose id was never returned', async () => {
    const firstProc = new MockChildProcess();
    const secondProc = new MockChildProcess();
    spawnMock
      .mockReset()
      .mockReturnValueOnce(firstProc)
      .mockReturnValueOnce(secondProc);
    const onProcessRecovery = jest.fn();
    const restartSpy = jest
      .spyOn(CodexAppServerConnection.prototype, 'triggerSharedRestart')
      .mockImplementation(() => {});
    const client = new CodexAppServerClient({
      cwd: '/tmp/repo',
      projectId: 'project',
      worktreeId: 'worktree',
      chatId: 'chat',
      sessionKey: 'project/worktree/chat',
      onEvent: jest.fn(),
      getWindow: (): null => null,
      onProcessRecovery,
    });

    const turnPromise = client.startTurn({
      text: 'Do not replay after cancellation',
      cwd: '/tmp/repo',
      model: 'gpt-6-sol',
      thinkingLevel: 'high',
      planMode: false,
    });
    void turnPromise.catch(() => {});
    const initializeFirst = await waitForClientRequest(firstProc, 'initialize');
    emitServerMessage(firstProc, {
      id: initializeFirst.id,
      result: { userAgent: 'ua', codexHome: '/tmp/.codex' },
    });
    const threadStart = await waitForClientRequest(firstProc, 'thread/start');
    emitServerMessage(firstProc, {
      id: threadStart.id,
      result: makeThreadResult('thread-1'),
    });
    await waitForClientRequest(firstProc, 'turn/start');

    await client.interruptTurn();
    expect(restartSpy.mock.calls[0]?.[1]).toEqual(new Error('turn_cancelled'));
    firstProc.emit('exit', 0, null);

    const initializeSecond = await waitForClientRequest(
      secondProc,
      'initialize',
    );
    emitServerMessage(secondProc, {
      id: initializeSecond.id,
      result: { userAgent: 'ua', codexHome: '/tmp/.codex' },
    });
    const resume = await waitForClientRequest(secondProc, 'thread/resume');
    emitServerMessage(secondProc, {
      id: resume.id,
      result: makeThreadResult('thread-1'),
    });

    await expect(turnPromise).resolves.toMatchObject({
      status: 'interrupted',
    });
    await flush();
    expect(
      collectClientMessages(secondProc).filter(
        (message) => message.method === 'turn/start',
      ),
    ).toHaveLength(0);
    expect(onProcessRecovery).toHaveBeenCalledWith({
      status: 'succeeded',
      strategy: 'reconciled',
    });
    restartSpy.mockRestore();
  });

  it('applies acknowledged plan-interrupt collaboration state to the next turn', async () => {
    const firstProc = new MockChildProcess();
    const secondProc = new MockChildProcess();
    spawnMock
      .mockReset()
      .mockReturnValueOnce(firstProc)
      .mockReturnValueOnce(secondProc);
    let finishInterrupt: (() => void) | undefined;
    const interruptSpy = jest
      .spyOn(CodexAppServerConnection.prototype, 'interruptTurn')
      .mockImplementation(
        (): Promise<void> =>
          new Promise((resolve) => {
            finishInterrupt = resolve;
          }),
      );
    const client = new CodexAppServerClient({
      cwd: '/tmp/repo',
      projectId: 'project',
      worktreeId: 'worktree',
      chatId: 'chat',
      sessionKey: 'project/worktree/chat',
      onEvent: jest.fn(),
      getWindow: (): null => null,
    });

    const planTurnPromise = client.startTurn({
      text: 'Create a plan',
      cwd: '/tmp/repo',
      model: 'gpt-6-sol',
      thinkingLevel: 'high',
      planMode: true,
    });
    void planTurnPromise.catch(() => {});
    const initializeFirst = await waitForClientRequest(firstProc, 'initialize');
    emitServerMessage(firstProc, {
      id: initializeFirst.id,
      result: { userAgent: 'ua', codexHome: '/tmp/.codex' },
    });
    const threadStart = await waitForClientRequest(firstProc, 'thread/start');
    emitServerMessage(firstProc, {
      id: threadStart.id,
      result: makeThreadResult('thread-1'),
    });
    await waitForClientRequest(firstProc, 'turn/start');
    emitServerMessage(firstProc, {
      method: 'turn/started',
      params: {
        threadId: 'thread-1',
        turn: { id: 'turn-1', items: [], status: 'inProgress', error: null },
      },
    });
    const interruptPromise = client.interruptTurn();
    await flush();
    expect(interruptSpy).toHaveBeenCalledTimes(1);

    firstProc.emit('exit', 0, null);
    const initializeSecond = await waitForClientRequest(
      secondProc,
      'initialize',
    );
    emitServerMessage(secondProc, {
      id: initializeSecond.id,
      result: { userAgent: 'ua', codexHome: '/tmp/.codex' },
    });
    const resume = await waitForClientRequest(secondProc, 'thread/resume');
    emitServerMessage(secondProc, {
      id: resume.id,
      result: makeThreadResult('thread-1', [
        {
          id: 'turn-1',
          items: [],
          status: 'inProgress',
          error: null,
        },
      ]),
    });

    await expect(planTurnPromise).resolves.toMatchObject({
      status: 'interrupted',
    });
    collectClientMessages(secondProc);
    if (!finishInterrupt) {
      throw new Error('Expected pending interrupt request');
    }
    finishInterrupt();
    await interruptPromise;
    interruptSpy.mockRestore();

    const implementationTurnPromise = client.startTurn({
      text: 'Implement it',
      cwd: '/tmp/repo',
      model: 'gpt-6-sol',
      thinkingLevel: 'high',
      planMode: false,
    });
    const implementationStart = await waitForClientRequest(
      secondProc,
      'turn/start',
    );
    expect(getRequestParams(implementationStart).collaborationMode).toEqual(
      expect.objectContaining({ mode: 'default' }),
    );
    emitServerMessage(secondProc, {
      id: implementationStart.id,
      result: {
        turn: { id: 'turn-2', items: [], status: 'inProgress', error: null },
      },
    });
    completeRootTurn(secondProc, 'turn-2');
    await expect(implementationTurnPromise).resolves.toMatchObject({
      status: 'completed',
    });
  });

  it('replays continuation parameters when a continuation response is lost', async () => {
    const firstProc = new MockChildProcess();
    const secondProc = new MockChildProcess();
    const thirdProc = new MockChildProcess();
    spawnMock
      .mockReset()
      .mockReturnValueOnce(firstProc)
      .mockReturnValueOnce(secondProc)
      .mockReturnValueOnce(thirdProc);
    const client = new CodexAppServerClient({
      cwd: '/tmp/repo',
      projectId: 'project',
      worktreeId: 'worktree',
      chatId: 'chat',
      sessionKey: 'project/worktree/chat',
      onEvent: jest.fn(),
      getWindow: (): null => null,
    });

    const { turnPromise } = await startActiveTurn(
      client,
      firstProc,
      [],
      'host-message-original',
      'submission-original',
      'client-message-original',
    );
    try {
      firstProc.emit('exit', 0, null);
      const initializeSecond = await waitForClientRequest(
        secondProc,
        'initialize',
      );
      emitServerMessage(secondProc, {
        id: initializeSecond.id,
        result: { userAgent: 'ua', codexHome: '/tmp/.codex' },
      });
      const resumeSecond = await waitForClientRequest(
        secondProc,
        'thread/resume',
      );
      emitServerMessage(secondProc, {
        id: resumeSecond.id,
        result: makeThreadResult('thread-1', [
          {
            id: 'turn-1',
            items: [],
            status: 'interrupted',
            error: null,
          },
        ]),
      });
      const continuation = await waitForClientRequest(secondProc, 'turn/start');
      const continuationParams = getRequestParams(continuation);
      expect(continuationParams.clientUserMessageId).toEqual(
        expect.any(String),
      );
      expect(continuationParams.clientUserMessageId).not.toBe(
        'client-message-original',
      );
      const continuationInput = continuationParams.input;
      secondProc.emit('exit', 0, null);
      await new Promise((resolve) => setTimeout(resolve, 300));

      const initializeThird = await waitForClientRequest(
        thirdProc,
        'initialize',
      );
      emitServerMessage(thirdProc, {
        id: initializeThird.id,
        result: { userAgent: 'ua', codexHome: '/tmp/.codex' },
      });
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const resumeThird = await waitForClientRequest(
          thirdProc,
          'thread/resume',
        );
        emitServerMessage(thirdProc, {
          id: resumeThird.id,
          result: makeThreadResult('thread-1', [
            {
              id: 'turn-1',
              items: [],
              status: 'interrupted',
              error: null,
            },
          ]),
        });
        if (attempt < 2) {
          await new Promise((resolve) => setTimeout(resolve, 800));
        }
      }

      const replay = await waitForClientRequest(thirdProc, 'turn/start');
      const replayParams = getRequestParams(replay);
      expect(replayParams.clientUserMessageId).toEqual(
        continuationParams.clientUserMessageId,
      );
      expect(replayParams.input).toEqual(continuationInput);
      expect(replayParams.input).not.toEqual([
        { type: 'text', text: 'Run', text_elements: [] },
      ]);
      emitServerMessage(thirdProc, {
        id: replay.id,
        result: {
          turn: { id: 'turn-2', items: [], status: 'inProgress', error: null },
        },
      });
      completeRootTurn(thirdProc, 'turn-2');

      await expect(turnPromise).resolves.toMatchObject({ status: 'completed' });
    } finally {
      client.dispose();
      await turnPromise.catch(() => undefined);
    }
  });

  it('replays an unanswered turn/start only after persisted history confirms no turn was created', async () => {
    const firstProc = new MockChildProcess();
    const secondProc = new MockChildProcess();
    spawnMock
      .mockReset()
      .mockReturnValueOnce(firstProc)
      .mockReturnValueOnce(secondProc);
    const onProcessRecovery = jest.fn();
    const onSteeringEligibilityChanged = jest.fn();
    const client = new CodexAppServerClient({
      cwd: '/tmp/repo',
      projectId: 'project',
      worktreeId: 'worktree',
      chatId: 'chat',
      sessionKey: 'project/worktree/chat',
      onEvent: jest.fn(),
      getWindow: (): null => null,
      onProcessRecovery,
      onSteeringEligibilityChanged,
    });
    const startOptions: TurnStartOptionsWithShadowIds = {
      text: 'Run once',
      cwd: '/tmp/repo',
      model: 'gpt-6-sol',
      thinkingLevel: 'high',
      planMode: false,
      clientUserMessageId: 'client-message-replay-original',
    };
    const turnPromise = client.startTurn(startOptions);
    void turnPromise.catch(() => {});

    try {
      const initializeFirst = await waitForClientRequest(
        firstProc,
        'initialize',
      );
      emitServerMessage(firstProc, {
        id: initializeFirst.id,
        result: { userAgent: 'ua', codexHome: '/tmp/.codex' },
      });
      const threadStart = await waitForClientRequest(firstProc, 'thread/start');
      emitServerMessage(firstProc, {
        id: threadStart.id,
        result: makeThreadResult('thread-1'),
      });
      await waitForClientRequest(firstProc, 'turn/start');
      firstProc.emit('exit', 0, null);

      const initializeSecond = await waitForClientRequest(
        secondProc,
        'initialize',
      );
      emitServerMessage(secondProc, {
        id: initializeSecond.id,
        result: { userAgent: 'ua', codexHome: '/tmp/.codex' },
      });
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const resume = await waitForClientRequest(secondProc, 'thread/resume');
        emitServerMessage(secondProc, {
          id: resume.id,
          result: makeThreadResult('thread-1'),
        });
        if (attempt < 2) {
          await new Promise((resolve) =>
            setTimeout(resolve, attempt === 0 ? 300 : 800),
          );
        }
      }
      const replay = await waitForClientRequest(secondProc, 'turn/start');
      expect(getRequestParams(replay).clientUserMessageId).toBe(
        'client-message-replay-original',
      );
      expect(getRequestParams(replay).input).toEqual([
        { type: 'text', text: 'Run once', text_elements: [] },
      ]);
      emitServerMessage(secondProc, {
        method: 'turn/completed',
        params: {
          threadId: 'thread-1',
          turn: { id: 'turn-2', items: [], status: 'completed', error: null },
        },
      });
      await flush();
      expect(client.hasActiveTurn()).toBe(true);
      onSteeringEligibilityChanged.mockClear();
      emitServerMessage(secondProc, {
        id: replay.id,
        result: {
          turn: { id: 'turn-2', items: [], status: 'inProgress', error: null },
        },
      });
      await flush();
      expect(client.getSteeringCapabilities().steer).toBe(false);
      expect(client.hasActiveTurn()).toBe(false);
      expect(onSteeringEligibilityChanged).toHaveBeenCalled();

      await expect(turnPromise).resolves.toMatchObject({ status: 'completed' });
      await flush();
      expect(onProcessRecovery).toHaveBeenCalledWith({
        status: 'succeeded',
        strategy: 'replayed',
      });
    } finally {
      client.dispose();
      await turnPromise.catch(() => undefined);
    }
  });

  it('does not retry a known terminal persistence failure as a transport failure', async () => {
    const firstProc = new MockChildProcess();
    const secondProc = new MockChildProcess();
    spawnMock
      .mockReset()
      .mockReturnValueOnce(firstProc)
      .mockReturnValueOnce(secondProc);
    const client = createClient();
    const { turnPromise } = await startActiveTurn(client, firstProc);
    void turnPromise.catch(() => {});

    firstProc.emit('exit', 0, null);
    const initializeSecond = await waitForClientRequest(
      secondProc,
      'initialize',
    );
    emitServerMessage(secondProc, {
      id: initializeSecond.id,
      result: { userAgent: 'ua', codexHome: '/tmp/.codex' },
    });
    for (let confirmation = 0; confirmation < 3; confirmation += 1) {
      const resume = await waitForClientRequest(secondProc, 'thread/resume');
      emitServerMessage(secondProc, {
        id: resume.id,
        result: makeThreadResult('thread-1'),
      });
      if (confirmation < 2) {
        await new Promise((resolve) =>
          setTimeout(resolve, confirmation === 0 ? 300 : 800),
        );
      }
    }

    await expect(turnPromise).rejects.toThrow(
      'Cannot safely replay Codex turn turn-1 because its persisted outcome is unavailable',
    );
    await new Promise((resolve) => setTimeout(resolve, 800));
    expect(
      collectClientMessages(secondProc).filter(
        (message) => message.method === 'thread/resume',
      ),
    ).toHaveLength(0);
  });

  it('reconciles a replay after its transport response is lost', async () => {
    const firstProc = new MockChildProcess();
    const secondProc = new MockChildProcess();
    const thirdProc = new MockChildProcess();
    spawnMock
      .mockReset()
      .mockReturnValueOnce(firstProc)
      .mockReturnValueOnce(secondProc)
      .mockReturnValueOnce(thirdProc);
    const client = createClient();
    const turnPromise = client.startTurn({
      text: 'Run once across replay recovery',
      cwd: '/tmp/repo',
      model: 'gpt-6-sol',
      thinkingLevel: 'high',
      planMode: false,
    });
    void turnPromise.catch(() => {});

    const initializeFirst = await waitForClientRequest(firstProc, 'initialize');
    emitServerMessage(firstProc, {
      id: initializeFirst.id,
      result: { userAgent: 'ua', codexHome: '/tmp/.codex' },
    });
    const threadStart = await waitForClientRequest(firstProc, 'thread/start');
    emitServerMessage(firstProc, {
      id: threadStart.id,
      result: makeThreadResult('thread-1'),
    });
    await waitForClientRequest(firstProc, 'turn/start');
    firstProc.emit('exit', 0, null);

    const initializeSecond = await waitForClientRequest(
      secondProc,
      'initialize',
    );
    emitServerMessage(secondProc, {
      id: initializeSecond.id,
      result: { userAgent: 'ua', codexHome: '/tmp/.codex' },
    });
    for (let confirmation = 0; confirmation < 3; confirmation += 1) {
      const resume = await waitForClientRequest(secondProc, 'thread/resume');
      emitServerMessage(secondProc, {
        id: resume.id,
        result: makeThreadResult('thread-1'),
      });
      if (confirmation < 2) {
        await new Promise((resolve) =>
          setTimeout(resolve, confirmation === 0 ? 300 : 800),
        );
      }
    }

    await waitForClientRequest(secondProc, 'turn/start');
    secondProc.emit('exit', 0, null);
    await new Promise((resolve) => setTimeout(resolve, 800));

    const initializeThird = await waitForClientRequest(thirdProc, 'initialize');
    emitServerMessage(thirdProc, {
      id: initializeThird.id,
      result: { userAgent: 'ua', codexHome: '/tmp/.codex' },
    });
    const resumeThird = await waitForClientRequest(thirdProc, 'thread/resume');
    emitServerMessage(thirdProc, {
      id: resumeThird.id,
      result: makeThreadResult('thread-1', [
        {
          id: 'turn-2',
          items: [],
          status: 'completed',
          error: null,
        },
      ]),
    });

    await expect(turnPromise).resolves.toMatchObject({ status: 'completed' });
    expect(
      collectClientMessages(thirdProc).filter(
        (message) => message.method === 'turn/start',
      ),
    ).toHaveLength(0);
  });

  it('requires fresh empty-history confirmations after a replay response is lost', async () => {
    const firstProc = new MockChildProcess();
    const secondProc = new MockChildProcess();
    const thirdProc = new MockChildProcess();
    spawnMock
      .mockReset()
      .mockReturnValueOnce(firstProc)
      .mockReturnValueOnce(secondProc)
      .mockReturnValueOnce(thirdProc);
    const client = createClient();
    const turnPromise = client.startTurn({
      text: 'Run once after each durable confirmation set',
      cwd: '/tmp/repo',
      model: 'gpt-6-sol',
      thinkingLevel: 'high',
      planMode: false,
    });
    void turnPromise.catch(() => {});

    const initializeFirst = await waitForClientRequest(firstProc, 'initialize');
    emitServerMessage(firstProc, {
      id: initializeFirst.id,
      result: { userAgent: 'ua', codexHome: '/tmp/.codex' },
    });
    const threadStart = await waitForClientRequest(firstProc, 'thread/start');
    emitServerMessage(firstProc, {
      id: threadStart.id,
      result: makeThreadResult('thread-1'),
    });
    await waitForClientRequest(firstProc, 'turn/start');
    firstProc.emit('exit', 0, null);

    const initializeSecond = await waitForClientRequest(
      secondProc,
      'initialize',
    );
    emitServerMessage(secondProc, {
      id: initializeSecond.id,
      result: { userAgent: 'ua', codexHome: '/tmp/.codex' },
    });
    for (let confirmation = 0; confirmation < 3; confirmation += 1) {
      const resume = await waitForClientRequest(secondProc, 'thread/resume');
      emitServerMessage(secondProc, {
        id: resume.id,
        result: makeThreadResult('thread-1'),
      });
      if (confirmation < 2) {
        await new Promise((resolve) =>
          setTimeout(resolve, confirmation === 0 ? 300 : 800),
        );
      }
    }
    await waitForClientRequest(secondProc, 'turn/start');
    secondProc.emit('exit', 0, null);
    await new Promise((resolve) => setTimeout(resolve, 800));

    const initializeThird = await waitForClientRequest(thirdProc, 'initialize');
    emitServerMessage(thirdProc, {
      id: initializeThird.id,
      result: { userAgent: 'ua', codexHome: '/tmp/.codex' },
    });
    for (let confirmation = 0; confirmation < 3; confirmation += 1) {
      const resume = await waitForClientRequest(thirdProc, 'thread/resume');
      emitServerMessage(thirdProc, {
        id: resume.id,
        result: makeThreadResult('thread-1'),
      });
      if (confirmation < 2) {
        await flush();
        expect(
          collectClientMessages(thirdProc).filter(
            (message) => message.method === 'turn/start',
          ),
        ).toHaveLength(0);
        await new Promise((resolve) => setTimeout(resolve, 800));
      }
    }

    const replay = await waitForClientRequest(thirdProc, 'turn/start');
    emitServerMessage(thirdProc, {
      id: replay.id,
      result: {
        turn: { id: 'turn-1', items: [], status: 'inProgress', error: null },
      },
    });
    completeRootTurn(thirdProc);

    await expect(turnPromise).resolves.toMatchObject({ status: 'completed' });
  });

  it('does not count failed resumes as persistence confirmations', async () => {
    const firstProc = new MockChildProcess();
    const secondProc = new MockChildProcess();
    spawnMock
      .mockReset()
      .mockReturnValueOnce(firstProc)
      .mockReturnValueOnce(secondProc);
    const client = createClient();
    const turnPromise = client.startTurn({
      text: 'Run once after durable confirmation',
      cwd: '/tmp/repo',
      model: 'gpt-6-sol',
      thinkingLevel: 'high',
      planMode: false,
    });
    void turnPromise.catch(() => {});

    const initializeFirst = await waitForClientRequest(firstProc, 'initialize');
    emitServerMessage(firstProc, {
      id: initializeFirst.id,
      result: { userAgent: 'ua', codexHome: '/tmp/.codex' },
    });
    const threadStart = await waitForClientRequest(firstProc, 'thread/start');
    emitServerMessage(firstProc, {
      id: threadStart.id,
      result: makeThreadResult('thread-1'),
    });
    await waitForClientRequest(firstProc, 'turn/start');
    firstProc.emit('exit', 0, null);

    const initializeSecond = await waitForClientRequest(
      secondProc,
      'initialize',
    );
    emitServerMessage(secondProc, {
      id: initializeSecond.id,
      result: { userAgent: 'ua', codexHome: '/tmp/.codex' },
    });

    const failedResume = await waitForClientRequest(
      secondProc,
      'thread/resume',
    ).catch((error: unknown) => {
      throw new Error(`missing failed resume: ${String(error)}`);
    });
    emitServerMessage(secondProc, {
      id: failedResume.id,
      error: { code: -32000, message: 'temporary resume failure' },
    });
    await new Promise((resolve) => setTimeout(resolve, 300));

    for (let confirmation = 0; confirmation < 3; confirmation += 1) {
      const resume = await waitForClientRequest(
        secondProc,
        'thread/resume',
      ).catch((error: unknown) => {
        throw new Error(
          `missing confirmation ${String(confirmation + 1)}: ${String(error)}`,
        );
      });
      emitServerMessage(secondProc, {
        id: resume.id,
        result: makeThreadResult('thread-1'),
      });
      if (confirmation < 2) {
        await new Promise((resolve) => setTimeout(resolve, 800));
      }
    }

    const replay = await waitForClientRequest(secondProc, 'turn/start');
    emitServerMessage(secondProc, {
      id: replay.id,
      result: {
        turn: { id: 'turn-1', items: [], status: 'inProgress', error: null },
      },
    });
    completeRootTurn(secondProc);

    await expect(turnPromise).resolves.toMatchObject({ status: 'completed' });
  });

  it('applies recovered plan collaboration state to the next turn', async () => {
    const firstProc = new MockChildProcess();
    const secondProc = new MockChildProcess();
    spawnMock
      .mockReset()
      .mockReturnValueOnce(firstProc)
      .mockReturnValueOnce(secondProc);
    const client = createClient();
    const planTurnPromise = client.startTurn({
      text: 'Create a plan',
      cwd: '/tmp/repo',
      model: 'gpt-6-sol',
      thinkingLevel: 'high',
      planMode: true,
    });
    void planTurnPromise.catch(() => {});

    const initializeFirst = await waitForClientRequest(firstProc, 'initialize');
    emitServerMessage(firstProc, {
      id: initializeFirst.id,
      result: { userAgent: 'ua', codexHome: '/tmp/.codex' },
    });
    const threadStart = await waitForClientRequest(firstProc, 'thread/start');
    emitServerMessage(firstProc, {
      id: threadStart.id,
      result: makeThreadResult('thread-1'),
    });
    await waitForClientRequest(firstProc, 'turn/start');
    firstProc.emit('exit', 0, null);

    const initializeSecond = await waitForClientRequest(
      secondProc,
      'initialize',
    );
    emitServerMessage(secondProc, {
      id: initializeSecond.id,
      result: { userAgent: 'ua', codexHome: '/tmp/.codex' },
    });
    const resume = await waitForClientRequest(secondProc, 'thread/resume');
    emitServerMessage(secondProc, {
      id: resume.id,
      result: makeThreadResult('thread-1', [
        {
          id: 'turn-1',
          items: [],
          status: 'completed',
          error: null,
        },
      ]),
    });
    await expect(planTurnPromise).resolves.toMatchObject({
      status: 'completed',
    });
    collectClientMessages(secondProc);

    const implementationTurnPromise = client.startTurn({
      text: 'Implement it',
      cwd: '/tmp/repo',
      model: 'gpt-6-sol',
      thinkingLevel: 'high',
      planMode: false,
    });
    const implementationStart = await waitForClientRequest(
      secondProc,
      'turn/start',
    );
    expect(getRequestParams(implementationStart).collaborationMode).toEqual(
      expect.objectContaining({ mode: 'default' }),
    );
    emitServerMessage(secondProc, {
      id: implementationStart.id,
      result: {
        turn: { id: 'turn-2', items: [], status: 'inProgress', error: null },
      },
    });
    completeRootTurn(secondProc, 'turn-2');

    await expect(implementationTurnPromise).resolves.toMatchObject({
      status: 'completed',
    });
  });

  it('does not reconcile an unanswered turn/start with an older historical turn', async () => {
    const firstProc = new MockChildProcess();
    const secondProc = new MockChildProcess();
    spawnMock
      .mockReset()
      .mockReturnValueOnce(firstProc)
      .mockReturnValueOnce(secondProc);
    const onProcessRecovery = jest.fn();
    const client = new CodexAppServerClient({
      cwd: '/tmp/repo',
      projectId: 'project',
      worktreeId: 'worktree',
      chatId: 'chat',
      sessionKey: 'project/worktree/chat',
      onEvent: jest.fn(),
      getWindow: (): null => null,
      onProcessRecovery,
    });
    const turnPromise = client.startTurn({
      text: 'Run once',
      cwd: '/tmp/repo',
      model: 'gpt-6-sol',
      thinkingLevel: 'high',
      planMode: false,
    });
    void turnPromise.catch(() => {});

    const persistedTurns = [
      {
        id: 'turn-1',
        items: [],
        status: 'completed',
        error: null,
      },
      {
        id: 'turn-2',
        items: [],
        status: 'completed',
        error: null,
      },
    ];
    const initializeFirst = await waitForClientRequest(firstProc, 'initialize');
    emitServerMessage(firstProc, {
      id: initializeFirst.id,
      result: { userAgent: 'ua', codexHome: '/tmp/.codex' },
    });
    const threadStart = await waitForClientRequest(firstProc, 'thread/start');
    emitServerMessage(firstProc, {
      id: threadStart.id,
      result: makeThreadResult('thread-1', persistedTurns),
    });
    await waitForClientRequest(firstProc, 'turn/start');
    firstProc.emit('exit', 0, null);

    const initializeSecond = await waitForClientRequest(
      secondProc,
      'initialize',
    );
    emitServerMessage(secondProc, {
      id: initializeSecond.id,
      result: { userAgent: 'ua', codexHome: '/tmp/.codex' },
    });
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const resume = await waitForClientRequest(secondProc, 'thread/resume');
      emitServerMessage(secondProc, {
        id: resume.id,
        result: makeThreadResult('thread-1', persistedTurns),
      });
      if (attempt < 2) {
        await new Promise((resolve) =>
          setTimeout(resolve, attempt === 0 ? 300 : 800),
        );
      }
    }
    const replay = await waitForClientRequest(secondProc, 'turn/start');
    expect(getRequestParams(replay).input).toEqual([
      { type: 'text', text: 'Run once', text_elements: [] },
    ]);
    emitServerMessage(secondProc, {
      id: replay.id,
      result: {
        turn: { id: 'turn-3', items: [], status: 'inProgress', error: null },
      },
    });
    emitServerMessage(secondProc, {
      method: 'turn/completed',
      params: {
        threadId: 'thread-1',
        turn: { id: 'turn-3', items: [], status: 'completed', error: null },
      },
    });

    await expect(turnPromise).resolves.toMatchObject({ status: 'completed' });
    await flush();
    expect(onProcessRecovery).toHaveBeenCalledWith({
      status: 'succeeded',
      strategy: 'replayed',
    });
  });

  it('uses a terminal error turn as the recovery baseline for the next request', async () => {
    const firstProc = new MockChildProcess();
    const secondProc = new MockChildProcess();
    spawnMock
      .mockReset()
      .mockReturnValueOnce(firstProc)
      .mockReturnValueOnce(secondProc);
    const client = new CodexAppServerClient({
      cwd: '/tmp/repo',
      projectId: 'project',
      worktreeId: 'worktree',
      chatId: 'chat',
      sessionKey: 'project/worktree/chat',
      onEvent: jest.fn(),
      getWindow: (): null => null,
    });

    const { turnPromise: failedTurnPromise } = await startActiveTurn(
      client,
      firstProc,
    );
    emitServerMessage(firstProc, {
      method: 'error',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        willRetry: false,
        error: { message: 'Provider failed', codexErrorInfo: null },
      },
    });
    await flush();
    expect(client.hasActiveTurn()).toBe(true);
    emitServerMessage(firstProc, {
      method: 'turn/completed',
      params: {
        threadId: 'thread-1',
        turn: {
          id: 'turn-1',
          items: [],
          status: 'failed',
          error: { message: 'Provider failed' },
        },
      },
    });
    await expect(failedTurnPromise).resolves.toMatchObject({
      status: 'failed',
    });
    collectClientMessages(firstProc);

    const nextTurnPromise = client.startTurn({
      text: 'Run after failure',
      cwd: '/tmp/repo',
      model: 'gpt-6-sol',
      thinkingLevel: 'high',
      planMode: false,
    });
    void nextTurnPromise.catch(() => {});
    await waitForClientRequest(firstProc, 'turn/start');
    firstProc.emit('exit', 0, null);

    const initializeSecond = await waitForClientRequest(
      secondProc,
      'initialize',
    );
    emitServerMessage(secondProc, {
      id: initializeSecond.id,
      result: { userAgent: 'ua', codexHome: '/tmp/.codex' },
    });
    const persistedTurns = [
      {
        id: 'turn-1',
        items: [],
        status: 'failed',
        error: { message: 'Provider failed' },
      },
    ];
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const resume = await waitForClientRequest(secondProc, 'thread/resume');
      emitServerMessage(secondProc, {
        id: resume.id,
        result: makeThreadResult('thread-1', persistedTurns),
      });
      if (attempt < 2) {
        await new Promise((resolve) =>
          setTimeout(resolve, attempt === 0 ? 300 : 800),
        );
      }
    }
    const replay = await waitForClientRequest(secondProc, 'turn/start');
    expect(getRequestParams(replay).input).toEqual([
      { type: 'text', text: 'Run after failure', text_elements: [] },
    ]);
    emitServerMessage(secondProc, {
      id: replay.id,
      result: {
        turn: { id: 'turn-2', items: [], status: 'inProgress', error: null },
      },
    });
    completeRootTurn(secondProc, 'turn-2');

    await expect(nextTurnPromise).resolves.toMatchObject({
      status: 'completed',
    });
  });

  it('force-kills the app-server if graceful termination does not exit', async () => {
    const firstProc = new MockChildProcess();
    const secondProc = new MockChildProcess();
    spawnMock
      .mockReset()
      .mockReturnValueOnce(firstProc)
      .mockReturnValueOnce(secondProc);
    const client = new CodexAppServerClient({
      cwd: '/tmp/repo',
      projectId: 'project',
      worktreeId: 'worktree',
      chatId: 'chat',
      sessionKey: 'project/worktree/chat',
      onEvent: jest.fn(),
      getWindow: (): null => null,
    });

    const turnPromise = client.startTurn({
      text: 'Wait for output',
      cwd: '/tmp/repo',
      model: 'gpt-6-sol',
      thinkingLevel: 'high',
      planMode: false,
    });
    void turnPromise.catch(() => {});

    await flush();
    emitServerMessage(firstProc, {
      id: 1,
      result: { userAgent: 'ua', codexHome: '/tmp/.codex' },
    });
    await flush();

    jest.useFakeTimers();
    try {
      firstProc.autoExitSignals.delete('SIGTERM');
      firstProc.stdout.emit('close');

      expect(firstProc.kill).toHaveBeenCalledWith('SIGTERM');
      await jest.advanceTimersByTimeAsync(5_000);
      expect(firstProc.kill).toHaveBeenCalledWith('SIGKILL');
      client.dispose();
      await jest.advanceTimersByTimeAsync(1_000);
      await expect(turnPromise).rejects.toThrow('session_destroyed');
    } finally {
      jest.useRealTimers();
    }
  });

  it('clears the app-server force-kill fallback when the process exits', async () => {
    const firstProc = new MockChildProcess();
    const secondProc = new MockChildProcess();
    spawnMock
      .mockReset()
      .mockReturnValueOnce(firstProc)
      .mockReturnValueOnce(secondProc);
    const client = new CodexAppServerClient({
      cwd: '/tmp/repo',
      projectId: 'project',
      worktreeId: 'worktree',
      chatId: 'chat',
      sessionKey: 'project/worktree/chat',
      onEvent: jest.fn(),
      getWindow: (): null => null,
    });

    const turnPromise = client.startTurn({
      text: 'Wait for output',
      cwd: '/tmp/repo',
      model: 'gpt-6-sol',
      thinkingLevel: 'high',
      planMode: false,
    });
    void turnPromise.catch(() => {});

    await flush();
    emitServerMessage(firstProc, {
      id: 1,
      result: { userAgent: 'ua', codexHome: '/tmp/.codex' },
    });
    await flush();

    jest.useFakeTimers();
    try {
      firstProc.autoExitSignals.delete('SIGTERM');
      firstProc.stdout.emit('close');
      expect(firstProc.kill).toHaveBeenCalledWith('SIGTERM');

      firstProc.signalCode = 'SIGTERM';
      firstProc.emit('exit', null, 'SIGTERM');
      await jest.advanceTimersByTimeAsync(5_000);

      expect(
        firstProc.kill.mock.calls.filter(([signal]) => signal === 'SIGKILL'),
      ).toHaveLength(0);
    } finally {
      jest.useRealTimers();
    }

    client.dispose();
    await expect(turnPromise).rejects.toThrow('session_destroyed');
  });

  it('does not recover a non-clean exit after the output stream closes', async () => {
    const proc = new MockChildProcess();
    const exits: unknown[] = [];
    spawnMock.mockReset().mockReturnValue(proc);
    const client = new CodexAppServerClient({
      cwd: '/tmp/repo',
      projectId: 'project',
      worktreeId: 'worktree',
      chatId: 'chat',
      sessionKey: 'project/worktree/chat',
      onEvent: jest.fn(),
      getWindow: (): null => null,
      onProcessExit: (details): void => {
        exits.push(details);
      },
    });

    const { turnPromise } = await startActiveTurn(client, proc);
    proc.autoExitSignals.delete('SIGTERM');
    proc.stdout.emit('close');
    proc.exitCode = 1;
    proc.emit('exit', 1, null);

    await expect(turnPromise).rejects.toThrow(
      'Codex app-server output stream closed',
    );
    expect(exits).toEqual([
      expect.objectContaining({
        code: 1,
        signal: null,
        recoveryScheduled: false,
      }),
    ]);
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it('includes app-server exit details and stderr when the process exits unexpectedly', async () => {
    const client = new CodexAppServerClient({
      cwd: '/tmp/repo',
      projectId: 'project',
      worktreeId: 'worktree',
      chatId: 'chat',
      sessionKey: 'project/worktree/chat',
      onEvent: jest.fn(),
      getWindow: (): null => null,
    });

    const turnPromise = client.startTurn({
      text: 'Trigger a crash',
      cwd: '/tmp/repo',
      model: 'gpt-6-sol',
      thinkingLevel: 'high',
      planMode: false,
    });
    void turnPromise.catch(() => {});

    await flush();
    proc.stderr.write('  fatal app-server panic\n');
    await flush();
    proc.emit('exit', 1, null);

    await expect(turnPromise).rejects.toThrow(
      'Codex app-server exited (exit code 1)',
    );
    await expect(turnPromise).rejects.toThrow(
      'stderr:\n  fatal app-server panic',
    );
    client.dispose();
  });

  it('preserves the original process error as the failure cause', async () => {
    const client = new CodexAppServerClient({
      cwd: '/tmp/repo',
      projectId: 'project',
      worktreeId: 'worktree',
      chatId: 'chat',
      sessionKey: 'project/worktree/chat',
      onEvent: jest.fn(),
      getWindow: (): null => null,
    });

    const turnPromise = client.startTurn({
      text: 'Trigger a spawn error',
      cwd: '/tmp/repo',
      model: 'gpt-6-sol',
      thinkingLevel: 'high',
      planMode: false,
    });
    void turnPromise.catch(() => {});

    await flush();
    proc.stderr.write('spawn diagnostics\n');
    await flush();

    const spawnError = new Error('spawn ENOENT');
    proc.emit('error', spawnError);

    await expect(turnPromise).rejects.toThrow('spawn ENOENT');
    await expect(turnPromise).rejects.toThrow('spawn diagnostics');
    await expect(turnPromise).rejects.toMatchObject({ cause: spawnError });
    client.dispose();
  });

  it('holds a non-retryable root error until its matching failed terminal', async () => {
    const events: unknown[] = [];
    const client = createClient(events);
    const { turnPromise } = await startActiveTurn(client, proc);
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(1_000);
    let settled = false;
    void turnPromise.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );

    emitServerMessage(proc, {
      method: 'item/commandExecution/outputDelta',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        itemId: 'cmd-error',
        delta: 'before-error',
      },
    });
    emitServerMessage(proc, {
      method: 'item/commandExecution/outputDelta',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        itemId: 'cmd-error',
        delta: '-latest',
      },
    });
    emitServerMessage(proc, {
      method: 'error',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        willRetry: false,
        error: {
          message: 'Codex request failed',
          additionalDetails: 'HTTP 500 from provider',
          codexErrorInfo: null,
        },
      },
    });

    try {
      await flush();
      expect(settled).toBe(false);
      expect(client.hasActiveTurn()).toBe(true);
      expect(client.getSteeringCapabilities().steer).toBe(false);
      expect(
        events.some(
          (event) =>
            isRecord(event) &&
            event.type === 'codex' &&
            isRecord(event.event) &&
            event.event.type === 'error',
        ),
      ).toBe(false);

      emitServerMessage(proc, {
        method: 'turn/completed',
        params: {
          threadId: 'thread-1',
          turn: {
            id: 'turn-1',
            items: [],
            status: 'failed',
            error: { message: 'Codex request failed' },
          },
        },
      });
      await expect(turnPromise).resolves.toEqual({
        status: 'failed',
        usage: undefined,
        error: 'Codex request failed\nHTTP 500 from provider',
      });
      expect(events).toContainEqual({
        type: 'codex',
        event: {
          type: 'turn.failed',
          error: { message: 'Codex request failed\nHTTP 500 from provider' },
          thread_id: 'thread-1',
          turn_id: 'turn-1',
        },
      });
      expect(
        events.filter(
          (event) =>
            isRecord(event) &&
            event.type === 'codex' &&
            isRecord(event.event) &&
            event.event.type === 'turn.failed',
        ),
      ).toHaveLength(1);
      expect(
        events.some(
          (event) =>
            isRecord(event) &&
            event.type === 'codex' &&
            isRecord(event.event) &&
            event.event.type === 'error',
        ),
      ).toBe(false);
      const commandUpdates = events.filter((event): boolean => {
        if (!isRecord(event) || event.type !== 'codex') {
          return false;
        }
        const codexEvent = event.event;
        if (!isRecord(codexEvent) || codexEvent.type !== 'item.updated') {
          return false;
        }
        const item = codexEvent.item;
        return isRecord(item) && item.id === 'cmd-error';
      });
      const finalUpdate = commandUpdates[commandUpdates.length - 1];
      if (
        !isRecord(finalUpdate) ||
        !isRecord(finalUpdate.event) ||
        !isRecord(finalUpdate.event.item)
      ) {
        throw new Error('Expected final command output update item');
      }
      expect(finalUpdate.event.item.aggregated_output).toBe(
        'before-error-latest',
      );
    } finally {
      nowSpy.mockRestore();
      client.dispose();
    }
  });

  it('does not let an early wrong-id root terminal close control after start identity arrives', async () => {
    const observations: TurnLifecycleObservation[] = [];
    const lifecycleOptions = {
      onTurnLifecycleObservation: (
        observation: TurnLifecycleObservation,
      ): void => {
        observations.push(observation);
      },
    };
    const client = new CodexAppServerClient({
      cwd: '/tmp/repo',
      projectId: 'project',
      worktreeId: 'worktree',
      chatId: 'chat',
      sessionKey: 'project/worktree/chat',
      onEvent: jest.fn(),
      getWindow: (): null => null,
      ...lifecycleOptions,
    });
    const { turnPromise, threadRequest } = await startTurnUntilThreadRequest(
      client,
      proc,
      {
        text: 'Run',
        cwd: '/tmp/repo',
        model: 'gpt-6-sol',
        thinkingLevel: 'high',
        planMode: false,
        executionUserMessageId: 'host-message-1',
        submissionId: 'submission-1',
        clientUserMessageId: 'client-message-1',
      },
    );
    let settled = false;
    void turnPromise.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    try {
      emitServerMessage(proc, {
        id: threadRequest.id,
        result: makeThreadResult('thread-1'),
      });
      const start = await waitForClientRequest(proc, 'turn/start');
      emitServerMessage(proc, {
        method: 'turn/completed',
        params: {
          threadId: 'thread-1',
          turn: { id: 'wrong-early-id', items: [], status: 'completed' },
        },
      });
      await flush();
      expect(client.hasActiveTurn()).toBe(true);
      expect(settled).toBe(false);
      expect(
        observations.some(
          (observation) => observation.type === 'turn-completed',
        ),
      ).toBe(false);

      emitServerMessage(proc, {
        id: start.id,
        result: {
          turn: { id: 'turn-1', items: [], status: 'inProgress', error: null },
        },
      });
      await client.handleConnectionNotification('turn/started', {
        params: {
          threadId: 'thread-1',
          turn: { id: 'turn-1', items: [], status: 'inProgress' },
        },
      });
      await flush();
      expect(client.hasActiveTurn()).toBe(true);
      expect(client.getSteeringCapabilities().steer).toBe(true);
      expect(client.getActiveTurnInterruptTarget()).toEqual({
        threadId: 'thread-1',
        turnId: 'turn-1',
      });
      expect(settled).toBe(false);
      expect(observations).not.toContainEqual(
        expect.objectContaining({
          type: 'turn-completed',
          turnId: 'wrong-early-id',
        }),
      );

      completeRootTurn(proc, 'turn-1');
      await expect(turnPromise).resolves.toMatchObject({ status: 'completed' });
      expect(observations).toContainEqual({
        type: 'turn-completed',
        threadId: 'thread-1',
        turnId: 'turn-1',
        status: 'completed',
      });
    } finally {
      client.dispose();
      await turnPromise.catch(() => undefined);
    }
  });

  it('accepts a matching early terminal only after the start response identifies its turn', async () => {
    const observations: TurnLifecycleObservation[] = [];
    const lifecycleOptions = {
      onTurnLifecycleObservation: (
        observation: TurnLifecycleObservation,
      ): void => {
        observations.push(observation);
      },
    };
    const client = new CodexAppServerClient({
      cwd: '/tmp/repo',
      projectId: 'project',
      worktreeId: 'worktree',
      chatId: 'chat',
      sessionKey: 'project/worktree/chat',
      onEvent: jest.fn(),
      getWindow: (): null => null,
      ...lifecycleOptions,
    });
    const { turnPromise, threadRequest } = await startTurnUntilThreadRequest(
      client,
      proc,
    );
    let settled = false;
    void turnPromise.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    try {
      emitServerMessage(proc, {
        id: threadRequest.id,
        result: makeThreadResult('thread-1'),
      });
      const start = await waitForClientRequest(proc, 'turn/start');
      emitServerMessage(proc, {
        method: 'turn/completed',
        params: {
          threadId: 'thread-1',
          turn: { id: 'turn-early', items: [], status: 'completed' },
        },
      });
      await flush();
      expect(client.hasActiveTurn()).toBe(true);
      expect(settled).toBe(false);
      expect(observations).not.toContainEqual(
        expect.objectContaining({
          type: 'turn-completed',
          turnId: 'turn-early',
        }),
      );

      emitServerMessage(proc, {
        id: start.id,
        result: {
          turn: {
            id: 'turn-early',
            items: [],
            status: 'inProgress',
            error: null,
          },
        },
      });
      await expect(turnPromise).resolves.toMatchObject({ status: 'completed' });
      expect(
        observations.filter((entry) => entry.type === 'turn-started'),
      ).toEqual([
        {
          type: 'turn-started',
          threadId: 'thread-1',
          turnId: 'turn-early',
          origin: 'user',
        },
      ]);
      expect(
        observations.filter((entry) => entry.type === 'turn-completed'),
      ).toEqual([
        {
          type: 'turn-completed',
          threadId: 'thread-1',
          turnId: 'turn-early',
          status: 'completed',
        },
      ]);
    } finally {
      client.dispose();
      await turnPromise.catch(() => undefined);
    }
  });

  it('accepts a matching early terminal after turn/started establishes the native identity', async () => {
    const observations: TurnLifecycleObservation[] = [];
    const lifecycleOptions = {
      onTurnLifecycleObservation: (
        observation: TurnLifecycleObservation,
      ): void => {
        observations.push(observation);
      },
    };
    const client = new CodexAppServerClient({
      cwd: '/tmp/repo',
      projectId: 'project',
      worktreeId: 'worktree',
      chatId: 'chat',
      sessionKey: 'project/worktree/chat',
      onEvent: jest.fn(),
      getWindow: (): null => null,
      ...lifecycleOptions,
    });
    const { turnPromise, threadRequest } = await startTurnUntilThreadRequest(
      client,
      proc,
    );
    let settled = false;
    void turnPromise.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    try {
      emitServerMessage(proc, {
        id: threadRequest.id,
        result: makeThreadResult('thread-1'),
      });
      const start = await waitForClientRequest(proc, 'turn/start');
      emitServerMessage(proc, {
        method: 'turn/completed',
        params: {
          threadId: 'thread-1',
          turn: {
            id: 'turn-from-notification',
            items: [],
            status: 'completed',
          },
        },
      });
      await flush();
      expect(client.hasActiveTurn()).toBe(true);
      expect(settled).toBe(false);
      expect(observations).not.toContainEqual(
        expect.objectContaining({
          type: 'turn-completed',
          turnId: 'turn-from-notification',
        }),
      );

      emitServerMessage(proc, {
        method: 'turn/started',
        params: {
          threadId: 'thread-1',
          turn: {
            id: 'turn-from-notification',
            items: [],
            status: 'inProgress',
          },
        },
      });
      await flush();
      expect(
        observations.filter((entry) => entry.type === 'turn-started'),
      ).toEqual([
        {
          type: 'turn-started',
          threadId: 'thread-1',
          turnId: 'turn-from-notification',
          origin: 'user',
        },
      ]);
      expect(
        observations.filter((entry) => entry.type === 'turn-completed'),
      ).toEqual([
        {
          type: 'turn-completed',
          threadId: 'thread-1',
          turnId: 'turn-from-notification',
          status: 'completed',
        },
      ]);
      expect(client.hasActiveTurn()).toBe(false);
      expect(client.getSteeringCapabilities().steer).toBe(false);
      expect(settled).toBe(false);

      emitServerMessage(proc, {
        id: start.id,
        result: {
          turn: {
            id: 'turn-from-notification',
            items: [],
            status: 'inProgress',
            error: null,
          },
        },
      });
      await expect(turnPromise).resolves.toMatchObject({ status: 'completed' });
    } finally {
      client.dispose();
      await turnPromise.catch(() => undefined);
    }
  });

  it('keeps retryable app-server error notifications out of the chat transcript', async () => {
    const events: unknown[] = [];
    const client = createClient(events);

    const { turnPromise } = await startActiveTurn(client, proc);

    emitServerMessage(proc, {
      method: 'error',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        willRetry: true,
        error: {
          message: 'Reconnecting... 2/5 stream disconnected before completion',
          additionalDetails:
            'WebSocket protocol error: Connection reset without closing handshake',
          codexErrorInfo: null,
        },
      },
    });
    await flush();
    completeRootTurn(proc);

    await expect(turnPromise).resolves.toEqual({
      status: 'completed',
      usage: undefined,
      proposedPlanText: undefined,
    });
    const emittedErrorForTurn = events.some((event): boolean => {
      if (!isRecord(event) || event.type !== 'codex') {
        return false;
      }
      const codexEvent = isRecord(event.event) ? event.event : null;
      return (
        codexEvent?.type === 'error' &&
        codexEvent.thread_id === 'thread-1' &&
        codexEvent.turn_id === 'turn-1'
      );
    });
    expect(emittedErrorForTurn).toBe(false);
    expect(events).toContainEqual({
      type: 'codex',
      event: {
        type: 'turn.completed',
        status: 'completed',
        thread_id: 'thread-1',
        turn_id: 'turn-1',
      },
    });
    client.dispose();
  });

  it('keeps request_user_input alive when the renderer frame is disposed', async () => {
    createPendingRequestMock.mockResolvedValue([
      {
        questionId: 'q1',
        question: 'Pick one',
        selectedOptions: ['Option A'],
      },
    ]);
    const win: SendableBrowserWindow = {
      isDestroyed(): boolean {
        return false;
      },
      webContents: {
        isCrashed(): boolean {
          return false;
        },
        isDestroyed(): boolean {
          return false;
        },
        mainFrame: {
          detached: false,
          isDestroyed(): boolean {
            return false;
          },
        },
        send(): void {
          throw new Error(
            'Render frame was disposed before WebFrameMain could be accessed',
          );
        },
      },
    };

    const client = new CodexAppServerClient({
      cwd: '/tmp/repo',
      projectId: 'project',
      worktreeId: 'worktree',
      chatId: 'chat',
      sessionKey: 'project/worktree/chat',
      onEvent: jest.fn(),
      getWindow: (): SendableBrowserWindow => win,
    });

    const turnPromise = client.startTurn({
      text: 'Need input',
      cwd: '/tmp/repo',
      model: 'gpt-6-sol',
      thinkingLevel: 'high',
      planMode: false,
    });

    await flush();
    emitServerMessage(proc, {
      id: 1,
      result: { userAgent: 'ua', codexHome: '/tmp/.codex' },
    });
    await flush();
    emitServerMessage(proc, {
      id: 2,
      result: {
        thread: {
          id: 'thread-1',
          preview: '',
          ephemeral: false,
          modelProvider: 'openai',
          createdAt: 1,
          updatedAt: 1,
          status: { type: 'idle' },
          path: null,
          cwd: '/tmp/repo',
          cliVersion: '0.114.0',
          source: 'vscode',
          agentNickname: null,
          agentRole: null,
          gitInfo: null,
          name: null,
          turns: [],
        },
        model: 'gpt-6-sol',
        modelProvider: 'openai',
        serviceTier: null,
        cwd: '/tmp/repo',
        approvalPolicy: 'never',
        sandbox: { type: 'dangerFullAccess' },
        reasoningEffort: 'high',
      },
    });
    await flush();
    emitServerMessage(proc, {
      id: 3,
      result: {
        turn: { id: 'turn-1', items: [], status: 'inProgress', error: null },
      },
    });
    emitServerMessage(proc, {
      method: 'turn/started',
      params: {
        threadId: 'thread-1',
        turn: { id: 'turn-1', items: [], status: 'inProgress', error: null },
      },
    });
    emitServerMessage(proc, {
      id: 'server-req-1',
      method: 'item/tool/requestUserInput',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        itemId: 'item-1',
        questions: [
          {
            id: 'q1',
            header: 'Choice',
            question: 'Pick one',
            isOther: false,
            isSecret: false,
            options: [{ label: 'Option A', description: 'First option' }],
          },
        ],
      },
    });

    await flush();

    const messages = collectClientMessages(proc);
    const response = messages.find(
      (message) => message['id'] === 'server-req-1',
    );
    expect(response).toMatchObject({
      id: 'server-req-1',
      result: { answers: { q1: { answers: ['Option A'] } } },
    });
    expect(upsertPendingQuestionMock).toHaveBeenCalledWith(
      { projectId: 'project', worktreeId: 'worktree' },
      expect.objectContaining({ chatId: 'chat', questions: expect.any(Array) }),
    );

    emitServerMessage(proc, {
      method: 'turn/completed',
      params: {
        threadId: 'thread-1',
        turn: { id: 'turn-1', items: [], status: 'completed', error: null },
      },
    });

    await turnPromise;
  });

  it('restarts the app-server after a pre-turn cancel so later turns still work', async () => {
    const firstProc = new MockChildProcess();
    const secondProc = new MockChildProcess();
    spawnMock.mockReset();
    spawnMock.mockReturnValueOnce(firstProc).mockReturnValueOnce(secondProc);

    const client = new CodexAppServerClient({
      cwd: '/tmp/repo',
      projectId: 'project',
      worktreeId: 'worktree',
      chatId: 'chat',
      sessionKey: 'project/worktree/chat',
      onEvent: jest.fn(),
      getWindow: (): null => null,
    });

    const firstTurnPromise = client.startTurn({
      text: 'Start a slow turn',
      cwd: '/tmp/repo',
      model: 'gpt-6-sol',
      thinkingLevel: 'high',
      planMode: false,
    });

    await flush();
    emitServerMessage(firstProc, {
      id: 1,
      result: { userAgent: 'ua', codexHome: '/tmp/.codex' },
    });
    await flush();
    await client.interruptTurn();
    await expect(firstTurnPromise).rejects.toThrow('turn_cancelled');

    const secondTurnPromise = client.startTurn({
      text: 'Try again',
      cwd: '/tmp/repo',
      model: 'gpt-6-sol',
      thinkingLevel: 'high',
      planMode: false,
    });

    await flush();
    emitServerMessage(secondProc, {
      id: 3,
      result: { userAgent: 'ua', codexHome: '/tmp/.codex' },
    });
    await flush();
    emitServerMessage(secondProc, {
      id: 4,
      result: {
        thread: {
          id: 'thread-2',
          preview: '',
          ephemeral: false,
          modelProvider: 'openai',
          createdAt: 1,
          updatedAt: 1,
          status: { type: 'idle' },
          path: null,
          cwd: '/tmp/repo',
          cliVersion: '0.114.0',
          source: 'vscode',
          agentNickname: null,
          agentRole: null,
          gitInfo: null,
          name: null,
          turns: [],
        },
        model: 'gpt-6-sol',
        modelProvider: 'openai',
        serviceTier: null,
        cwd: '/tmp/repo',
        approvalPolicy: 'never',
        sandbox: { type: 'dangerFullAccess' },
        reasoningEffort: 'high',
      },
    });
    await flush();
    emitServerMessage(secondProc, {
      id: 5,
      result: {
        turn: { id: 'turn-2', items: [], status: 'inProgress', error: null },
      },
    });
    emitServerMessage(secondProc, {
      method: 'turn/completed',
      params: {
        threadId: 'thread-2',
        turn: { id: 'turn-2', items: [], status: 'completed', error: null },
      },
    });

    await expect(secondTurnPromise).resolves.toMatchObject({
      status: 'completed',
    });
    expect(spawnMock).toHaveBeenCalledTimes(2);
  });

  it('does not surface a proposed plan for interrupted turns', async () => {
    const client = new CodexAppServerClient({
      cwd: '/tmp/repo',
      projectId: 'project',
      worktreeId: 'worktree',
      chatId: 'chat',
      sessionKey: 'project/worktree/chat',
      onEvent: jest.fn(),
      getWindow: (): null => null,
    });

    const turnPromise = client.startTurn({
      text: 'Plan this change',
      cwd: '/tmp/repo',
      model: 'gpt-6-sol',
      thinkingLevel: 'high',
      planMode: true,
    });

    await flush();
    emitServerMessage(proc, {
      id: 1,
      result: { userAgent: 'ua', codexHome: '/tmp/.codex' },
    });
    await flush();
    emitServerMessage(proc, {
      id: 2,
      result: {
        thread: {
          id: 'thread-1',
          preview: '',
          ephemeral: false,
          modelProvider: 'openai',
          createdAt: 1,
          updatedAt: 1,
          status: { type: 'idle' },
          path: null,
          cwd: '/tmp/repo',
          cliVersion: '0.114.0',
          source: 'vscode',
          agentNickname: null,
          agentRole: null,
          gitInfo: null,
          name: null,
          turns: [],
        },
        model: 'gpt-6-sol',
        modelProvider: 'openai',
        serviceTier: null,
        cwd: '/tmp/repo',
        approvalPolicy: 'never',
        sandbox: { type: 'dangerFullAccess' },
        reasoningEffort: 'high',
      },
    });
    await flush();
    emitServerMessage(proc, {
      id: 3,
      result: {
        turn: { id: 'turn-1', items: [], status: 'inProgress', error: null },
      },
    });
    emitServerMessage(proc, {
      method: 'item/plan/delta',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        itemId: 'plan-1',
        delta: 'Draft implementation plan',
      },
    });
    emitServerMessage(proc, {
      method: 'turn/completed',
      params: {
        threadId: 'thread-1',
        turn: { id: 'turn-1', items: [], status: 'interrupted', error: null },
      },
    });

    await expect(turnPromise).resolves.toEqual({
      status: 'interrupted',
      usage: undefined,
      proposedPlanText: undefined,
    });
  });

  it('normalizes Codex MCP tool calls across started, progress, and completed events', async () => {
    const events: unknown[] = [];
    const client = createClient(events);
    const { turnPromise } = await startActiveTurn(client, proc);

    emitServerMessage(proc, {
      method: 'item/started',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        item: {
          type: 'mcpToolCall',
          id: 'mcp-call-1',
          server: 'github',
          tool: 'create_issue',
          status: 'inProgress',
          arguments: { title: 'Retry safety' },
          result: null,
          error: null,
        },
      },
    });
    emitServerMessage(proc, {
      method: 'item/mcpToolCall/progress',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        itemId: 'mcp-call-1',
        message: 'Creating issue',
      },
    });
    emitServerMessage(proc, {
      method: 'item/completed',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        item: {
          type: 'mcpToolCall',
          id: 'mcp-call-1',
          server: 'github',
          tool: 'create_issue',
          status: 'completed',
          arguments: { title: 'Retry safety' },
          result: { content: [{ type: 'text', text: 'Created' }] },
          error: null,
        },
      },
    });
    completeRootTurn(proc);

    await turnPromise;

    const mcpEvents = events.filter((event) => {
      if (!isRecord(event) || !isRecord(event.event)) return false;
      return isRecord(event.event.item) && event.event.item.id === 'mcp-call-1';
    });
    expect(mcpEvents).toHaveLength(3);
    expect(mcpEvents[0]).toMatchObject({
      type: 'codex',
      event: {
        type: 'item.started',
        item: {
          type: 'mcp_tool_call',
          id: 'mcp-call-1',
          status: 'inProgress',
        },
      },
    });
    expect(mcpEvents[1]).toMatchObject({
      type: 'codex',
      event: {
        type: 'item.updated',
        item: {
          type: 'mcp_tool_call',
          id: 'mcp-call-1',
          progress: 'Creating issue',
        },
      },
    });
    expect(mcpEvents[2]).toMatchObject({
      type: 'codex',
      event: {
        type: 'item.completed',
        item: {
          type: 'mcp_tool_call',
          id: 'mcp-call-1',
          status: 'completed',
          result: {
            content: [{ type: 'text', text: 'Created' }],
          },
        },
      },
    });
  });

  it('normalizes Codex collab agent tool call items with routing fields', async () => {
    const events: unknown[] = [];
    const client = createClient(events);
    const { turnPromise } = await startActiveTurn(client, proc);

    emitServerMessage(proc, {
      method: 'item/started',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        item: {
          type: 'collabAgentToolCall',
          id: 'agent-call-1',
          tool: 'spawnAgent',
          status: 'inProgress',
          senderThreadId: 'thread-1',
          receiverThreadIds: ['sub-thread-1'],
          prompt: null,
          model: 'gpt-6-sol',
          reasoningEffort: 'high',
          agentsStates: {
            'sub-thread-1': { status: 'running', message: null },
          },
        },
      },
    });
    emitServerMessage(proc, {
      method: 'item/completed',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        item: {
          type: 'collabAgentToolCall',
          id: 'agent-call-1',
          tool: 'spawnAgent',
          status: 'completed',
          senderThreadId: 'thread-1',
          receiverThreadIds: ['sub-thread-1'],
          prompt: 'Inspect the auth flow',
          model: 'gpt-6-sol',
          reasoningEffort: 'high',
          agentsStates: {
            'sub-thread-1': { status: 'completed', message: 'Done' },
          },
        },
      },
    });
    completeRootTurn(proc);

    await turnPromise;

    expect(events).toContainEqual({
      type: 'codex',
      event: {
        type: 'item.started',
        thread_id: 'thread-1',
        turn_id: 'turn-1',
        item: {
          type: 'collab_agent_tool_call',
          id: 'agent-call-1',
          tool: 'spawnAgent',
          status: 'inProgress',
          sender_thread_id: 'thread-1',
          receiver_thread_ids: ['sub-thread-1'],
          prompt: '',
          model: 'gpt-6-sol',
          reasoning_effort: 'high',
          agents_states: {
            'sub-thread-1': { status: 'running', message: null },
          },
        },
      },
    });
    expect(events).toContainEqual({
      type: 'codex',
      event: {
        type: 'item.completed',
        thread_id: 'thread-1',
        turn_id: 'turn-1',
        item: {
          type: 'collab_agent_tool_call',
          id: 'agent-call-1',
          tool: 'spawnAgent',
          status: 'completed',
          sender_thread_id: 'thread-1',
          receiver_thread_ids: ['sub-thread-1'],
          prompt: 'Inspect the auth flow',
          model: 'gpt-6-sol',
          reasoning_effort: 'high',
          agents_states: {
            'sub-thread-1': { status: 'completed', message: 'Done' },
          },
        },
      },
    });
  });

  it.each(['collab_agent_tool_call', 'sub_agent_activity'])(
    'hydrates subagent metadata for %s',
    async (itemType) => {
      const events: unknown[] = [];
      const client = createClient(events);
      const { turnPromise } = await startActiveTurn(client, proc);
      void turnPromise.catch(() => undefined);

      emitServerMessage(proc, {
        method: 'item/completed',
        params: {
          threadId: 'thread-1',
          turnId: 'turn-1',
          item: {
            type:
              itemType === 'sub_agent_activity'
                ? 'subAgentActivity'
                : 'collabAgentToolCall',
            kind: 'started',
            agentThreadId: 'sub-thread-named',
            agentPath: '/root/readme_review',
            id: 'agent-call-named',
            tool: 'spawnAgent',
            status: 'completed',
            senderThreadId: 'thread-1',
            receiverThreadIds: ['sub-thread-named'],
            prompt: 'Inspect workspace/package wiring',
            agentsStates: {
              'sub-thread-named': { status: 'completed', message: 'Done' },
            },
          },
        },
      });
      await flush();

      const threadReadRequest = await waitForClientRequest(proc, 'thread/read');

      expect(getRequestParams(threadReadRequest)).toEqual({
        threadId: 'sub-thread-named',
        includeTurns: false,
      });

      const threadReadRequestId = threadReadRequest.id;
      if (
        typeof threadReadRequestId !== 'string' &&
        typeof threadReadRequestId !== 'number'
      ) {
        throw new Error('Expected thread/read request id');
      }

      emitServerMessage(proc, {
        id: threadReadRequestId,
        result: {
          thread: {
            id: 'sub-thread-named',
            preview: '',
            ephemeral: false,
            modelProvider: 'openai',
            model: 'gpt-6-astra',
            reasoningEffort: 'high',
            parentThreadId: 'thread-1',
            createdAt: 1,
            updatedAt: 1,
            status: { type: 'idle' },
            path: null,
            cwd: '/tmp/repo',
            cliVersion: '0.114.0',
            source: {
              subagent: {
                thread_spawn: {
                  parent_thread_id: 'thread-1',
                  depth: 1,
                  agent_path: null,
                  agent_nickname: 'Scout',
                  agent_role: 'explorer',
                },
              },
            },
            agentNickname: null,
            agentRole: null,
            gitInfo: null,
            name: null,
            turns: [],
          },
        },
      });
      await flush();
      completeRootTurn(proc);

      await turnPromise;

      expect(events).toContainEqual({
        type: 'codex',
        event: {
          type: 'thread.started',
          thread_id: 'sub-thread-named',
          model: 'gpt-6-astra',
          reasoning_effort: 'high',
          parent_thread_id: 'thread-1',
          agent_nickname: 'Scout',
          agent_role: 'explorer',
          source: {
            subagent: {
              thread_spawn: {
                parent_thread_id: 'thread-1',
                depth: 1,
                agent_path: null,
                agent_nickname: 'Scout',
                agent_role: 'explorer',
              },
            },
          },
        },
      });
    },
  );

  it('hydrates subagent metadata when reasoning effort is the only display metadata', async () => {
    const events: unknown[] = [];
    const client = createClient(events);
    const { turnPromise } = await startActiveTurn(client, proc);
    void turnPromise.catch(() => undefined);

    emitServerMessage(proc, {
      method: 'item/completed',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        item: {
          type: 'subAgentActivity',
          kind: 'started',
          agentThreadId: 'sub-thread-effort-only',
          id: 'subagent-sub-thread-effort-only',
          status: 'inProgress',
        },
      },
    });
    await flush();

    const threadReadRequest = await waitForClientRequest(proc, 'thread/read');
    const threadReadRequestId = threadReadRequest.id;
    if (
      typeof threadReadRequestId !== 'string' &&
      typeof threadReadRequestId !== 'number'
    ) {
      throw new Error('Expected thread/read request id');
    }

    emitServerMessage(proc, {
      id: threadReadRequestId,
      result: {
        thread: {
          id: 'sub-thread-effort-only',
          reasoningEffort: 'xhigh',
        },
      },
    });
    await flush();
    completeRootTurn(proc);

    await turnPromise;

    expect(events).toContainEqual({
      type: 'codex',
      event: {
        type: 'thread.started',
        thread_id: 'sub-thread-effort-only',
        reasoning_effort: 'xhigh',
      },
    });
  });

  it('keeps deferred subagent agent messages attributed to the subagent thread', async () => {
    const events: unknown[] = [];
    const client = createClient(events);
    const { turnPromise } = await startActiveTurn(client, proc);

    emitServerMessage(proc, {
      method: 'item/agentMessage/delta',
      params: {
        threadId: 'sub-thread-1',
        turnId: 'sub-turn-1',
        itemId: 'msg-sub-1',
        delta: 'Subagent result',
      },
    });
    completeRootTurn(proc);

    await turnPromise;

    expect(events).toContainEqual({
      type: 'codex',
      event: {
        type: 'item.completed',
        thread_id: 'sub-thread-1',
        turn_id: 'sub-turn-1',
        item: {
          id: 'msg-sub-1',
          type: 'agent_message',
          text: 'Subagent result',
        },
      },
    });
  });

  it('forwards failed subagent turn completions as routed turn.failed events without resolving the root turn', async () => {
    const events: unknown[] = [];
    const client = createClient(events);
    const { turnPromise } = await startActiveTurn(client, proc);

    emitServerMessage(proc, {
      method: 'turn/completed',
      params: {
        threadId: 'sub-thread-1',
        turn: {
          id: 'sub-turn-1',
          items: [],
          status: 'failed',
          error: { message: 'Subagent failed' },
        },
      },
    });

    expect(events).toContainEqual({
      type: 'codex',
      event: {
        type: 'turn.failed',
        thread_id: 'sub-thread-1',
        turn_id: 'sub-turn-1',
        error: { message: 'Subagent failed' },
      },
    });

    completeRootTurn(proc);
    const result = await turnPromise;
    expect(result.status).toBe('completed');
  });

  it.each(['dispose', 'reject', 'error'] as const)(
    'notifies steering eligibility when an active client is closed by %s',
    async (action) => {
      const onSteeringEligibilityChanged = jest.fn();
      const client = new CodexAppServerClient({
        cwd: '/tmp/repo',
        projectId: 'project',
        worktreeId: 'worktree',
        chatId: 'chat',
        sessionKey: 'project/worktree/chat',
        getWindow: (): null => null,
        onEvent: jest.fn(),
        onSteeringEligibilityChanged,
      });
      const { turnPromise } = await startActiveTurn(client, proc);
      const outcome = turnPromise.catch(() => undefined);
      try {
        expect(client.getSteeringCapabilities().steer).toBe(true);
        onSteeringEligibilityChanged.mockClear();
        if (action === 'dispose') client.dispose();
        else if (action === 'reject')
          client.rejectActiveTurn(new Error('closed'));
        else {
          emitServerMessage(proc, {
            method: 'error',
            params: {
              threadId: 'thread-1',
              turnId: 'turn-1',
              willRetry: false,
              error: { message: 'closed' },
            },
          });
          await flush();
          expect(client.hasActiveTurn()).toBe(true);
          emitServerMessage(proc, {
            method: 'turn/completed',
            params: {
              threadId: 'thread-1',
              turn: {
                id: 'turn-1',
                items: [],
                status: 'failed',
                error: { message: 'closed' },
              },
            },
          });
          await flush();
        }
        expect(client.getSteeringCapabilities().steer).toBe(false);
        expect(client.hasActiveTurn()).toBe(false);
        expect(onSteeringEligibilityChanged).toHaveBeenCalled();
      } finally {
        client.dispose();
        await outcome;
      }
    },
  );

  it('notifies steering eligibility when the turn id arrives only in the start response', async () => {
    const onSteeringEligibilityChanged = jest.fn();
    const options = {
      cwd: '/tmp/repo',
      projectId: 'project',
      worktreeId: 'worktree',
      chatId: 'chat',
      sessionKey: 'project/worktree/chat',
      getWindow: (): null => null,
      onEvent: jest.fn(),
      onSteeringEligibilityChanged,
    };
    const client = new CodexAppServerClient(options);
    const turnPromise = client.startTurn({
      text: 'Run',
      cwd: '/tmp/repo',
      model: 'gpt-6-sol',
      thinkingLevel: 'high',
      planMode: false,
    });
    const outcome = turnPromise.catch(() => undefined);
    try {
      await flush();
      emitServerMessage(proc, {
        id: 1,
        result: { userAgent: 'ua', codexHome: '/tmp/.codex' },
      });
      await flush();
      emitServerMessage(proc, { id: 2, result: makeThreadResult('thread-1') });
      await flush();
      expect(client.getSteeringCapabilities().steer).toBe(false);
      onSteeringEligibilityChanged.mockClear();
      emitServerMessage(proc, {
        id: 3,
        result: {
          turn: { id: 'turn-1', items: [], status: 'inProgress', error: null },
        },
      });
      await flush();
      expect(client.getSteeringCapabilities().steer).toBe(true);
      expect(client.hasActiveTurn()).toBe(true);
      expect(onSteeringEligibilityChanged).toHaveBeenCalled();
      onSteeringEligibilityChanged.mockClear();
      completeRootTurn(proc);
      await turnPromise;
      expect(client.getSteeringCapabilities().steer).toBe(false);
      expect(onSteeringEligibilityChanged).toHaveBeenCalled();
    } finally {
      client.dispose();
      await outcome;
    }
  });

  it('updates turn lifecycle and steering immediately while transcript admission is held', async () => {
    const onSteeringEligibilityChanged = jest.fn();
    let release = (): void => undefined;
    const admission = new Promise<void>((resolve) => {
      release = resolve;
    });
    const events: unknown[] = [];
    const client = new CodexAppServerClient({
      cwd: '/tmp/repo',
      projectId: 'project',
      worktreeId: 'worktree',
      chatId: 'chat',
      sessionKey: 'project/worktree/chat',
      onSteeringEligibilityChanged,
      getWindow: (): null => null,
      onEvent: (event): Promise<void> | undefined => {
        events.push(event);
        return typeof event === 'object' &&
          event !== null &&
          'event' in event &&
          typeof event.event === 'object' &&
          event.event !== null &&
          'type' in event.event &&
          event.event.type === 'item.started'
          ? admission
          : undefined;
      },
    });
    const turnPromise = client.startTurn({
      text: 'Run',
      cwd: '/tmp/repo',
      model: 'gpt-6-sol',
      thinkingLevel: 'high',
      planMode: false,
    });
    const outcome = turnPromise.catch(() => undefined);
    try {
      await flush();
      emitServerMessage(proc, {
        id: 1,
        result: { userAgent: 'ua', codexHome: '/tmp/.codex' },
      });
      await flush();
      emitServerMessage(proc, { id: 2, result: makeThreadResult('thread-1') });
      await flush();
      emitServerMessage(proc, {
        method: 'item/started',
        params: {
          threadId: 'thread-1',
          turnId: 'turn-1',
          item: {
            id: 'command',
            type: 'commandExecution',
            command: 'echo test',
            cwd: '/tmp/repo',
            status: 'inProgress',
            commandActions: [],
          },
        },
      });
      await flush();
      expect(events).toContainEqual(
        expect.objectContaining({
          event: expect.objectContaining({ type: 'item.started' }),
        }),
      );
      expect(client.getSteeringCapabilities().steer).toBe(false);
      onSteeringEligibilityChanged.mockClear();
      const startedAt = Date.now();
      emitServerMessage(proc, {
        method: 'turn/started',
        params: {
          threadId: 'thread-1',
          turn: { id: 'turn-1', items: [], status: 'inProgress', error: null },
        },
      });
      await flush();
      expect(client.getActiveTurnInterruptTarget()).toEqual({
        threadId: 'thread-1',
        turnId: 'turn-1',
      });
      expect(client.getSteeringCapabilities().steer).toBe(true);
      expect(onSteeringEligibilityChanged).toHaveBeenCalled();
      expect(events).toContainEqual(
        expect.objectContaining({
          event: expect.objectContaining({ type: 'turn.started' }),
        }),
      );
      emitServerMessage(proc, {
        id: 3,
        result: {
          turn: { id: 'turn-1', items: [], status: 'inProgress', error: null },
        },
      });
      await flush();
      onSteeringEligibilityChanged.mockClear();
      completeRootTurn(proc);
      await flush();
      expect(client.getSteeringCapabilities().steer).toBe(false);
      expect(onSteeringEligibilityChanged).toHaveBeenCalled();
      // The turn keeps the worker pinned until its held transcript is
      // finalized: suspending or restarting it would drop those frames.
      expect(client.hasActiveTurn()).toBe(true);
      expect(client.hasDispatchedTurn()).toBe(true);
      expect(client.getActiveTurnInterruptTarget()).toEqual({
        threadId: 'thread-1',
        turnId: 'turn-1',
      });
      expect(Date.now() - startedAt).toBeLessThan(1000);
      onSteeringEligibilityChanged.mockClear();
      release();
      await turnPromise;
      expect(onSteeringEligibilityChanged).toHaveBeenCalled();
      expect(client.hasActiveTurn()).toBe(false);
      expect(client.getActiveTurnInterruptTarget()).toBeNull();
    } finally {
      release();
      client.dispose();
      await outcome;
    }
  });

  it('closes steering at completion read but drains older transcript content before finalizing the turn', async () => {
    let release = (): void => undefined;
    const admission = new Promise<void>((resolve) => {
      release = resolve;
    });
    const events: unknown[] = [];
    const client = new CodexAppServerClient({
      cwd: '/tmp/repo',
      projectId: 'project',
      worktreeId: 'worktree',
      chatId: 'chat',
      sessionKey: 'project/worktree/chat',
      getWindow: (): null => null,
      onEvent: (event): Promise<void> | undefined => {
        events.push(event);
        return typeof event === 'object' &&
          event !== null &&
          'event' in event &&
          typeof event.event === 'object' &&
          event.event !== null &&
          'type' in event.event &&
          event.event.type === 'item.started'
          ? admission
          : undefined;
      },
    });
    const { turnPromise } = await startActiveTurn(client, proc);
    let settled = false;
    void turnPromise.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    try {
      emitServerMessage(proc, {
        method: 'item/started',
        params: {
          threadId: 'thread-1',
          turnId: 'turn-1',
          item: {
            id: 'command',
            type: 'commandExecution',
            command: 'echo test',
            cwd: '/tmp/repo',
            status: 'inProgress',
            commandActions: [],
          },
        },
      });
      emitServerMessage(proc, {
        method: 'item/agentMessage/delta',
        params: {
          threadId: 'thread-1',
          turnId: 'turn-1',
          itemId: 'message',
          delta: 'Retained answer',
        },
      });
      completeRootTurn(proc);
      await flush();
      expect(client.hasActiveTurn()).toBe(true);
      expect(client.getSteeringCapabilities().steer).toBe(false);
      expect(await client.steerActiveTurn('Too late')).toBe(false);
      expect(settled).toBe(false);
      release();
      await turnPromise;
      expect(client.hasActiveTurn()).toBe(false);
      expect(events).toContainEqual(
        expect.objectContaining({
          event: expect.objectContaining({
            type: 'item.completed',
            item: expect.objectContaining({
              id: 'message',
              text: 'Retained answer',
            }),
          }),
        }),
      );
      expect(events).toContainEqual(
        expect.objectContaining({
          event: expect.objectContaining({ type: 'turn.completed' }),
        }),
      );
    } finally {
      release();
      client.dispose();
      await turnPromise.catch(() => undefined);
    }
  });

  it('delivers a subagent completion read after the root completion once the held transcript drains', async () => {
    let release = (): void => undefined;
    const admission = new Promise<void>((resolve) => {
      release = resolve;
    });
    const events: unknown[] = [];
    const client = new CodexAppServerClient({
      cwd: '/tmp/repo',
      projectId: 'project',
      worktreeId: 'worktree',
      chatId: 'chat',
      sessionKey: 'project/worktree/chat',
      getWindow: (): null => null,
      onEvent: (event): Promise<void> | undefined => {
        events.push(event);
        return typeof event === 'object' &&
          event !== null &&
          'event' in event &&
          typeof event.event === 'object' &&
          event.event !== null &&
          'type' in event.event &&
          event.event.type === 'item.started'
          ? admission
          : undefined;
      },
    });
    const { turnPromise } = await startActiveTurn(client, proc);
    try {
      emitServerMessage(proc, {
        method: 'item/started',
        params: {
          threadId: 'thread-1',
          turnId: 'turn-1',
          item: {
            id: 'command',
            type: 'commandExecution',
            command: 'echo test',
            cwd: '/tmp/repo',
            status: 'inProgress',
            commandActions: [],
          },
        },
      });
      completeRootTurn(proc);
      // Read after the root completion, while both wait for the same drain.
      emitServerMessage(proc, {
        method: 'turn/completed',
        params: {
          threadId: 'sub-thread-1',
          turn: {
            id: 'sub-turn-1',
            items: [],
            status: 'failed',
            error: { message: 'Late subagent failure' },
          },
        },
      });
      await flush();
      release();
      await expect(turnPromise).resolves.toMatchObject({
        status: 'completed',
      });
      await flush();
      expect(events).toContainEqual({
        type: 'codex',
        event: {
          type: 'turn.failed',
          thread_id: 'sub-thread-1',
          turn_id: 'sub-turn-1',
          error: { message: 'Late subagent failure' },
        },
      });
    } finally {
      release();
      client.dispose();
      await turnPromise.catch(() => undefined);
    }
  });

  it.each(['resolve', 'reject'] as const)(
    'keeps the root turn unsettled until a stopped tool fallback row admission %s',
    async (admissionOutcome) => {
      let finishFallbackAdmission = (): void => undefined;
      const fallbackAdmission = new Promise<void>((resolve, reject) => {
        finishFallbackAdmission = (): void => {
          if (admissionOutcome === 'reject') {
            reject(new Error('fallback row admission failed'));
          } else {
            resolve();
          }
        };
      });
      let fallbackAdmissionRequested = false;
      const client = new CodexAppServerClient({
        cwd: '/tmp/repo',
        projectId: 'project',
        worktreeId: 'worktree',
        chatId: 'chat',
        sessionKey: 'project/worktree/chat',
        onEvent: (event): void | Promise<void> => {
          if (
            typeof event === 'object' &&
            event !== null &&
            'event' in event &&
            typeof event.event === 'object' &&
            event.event !== null &&
            'type' in event.event &&
            event.event.type === 'item.completed' &&
            'item' in event.event &&
            typeof event.event.item === 'object' &&
            event.event.item !== null &&
            'id' in event.event.item &&
            event.event.item.id === 'call' &&
            'status' in event.event.item &&
            event.event.item.status === 'failed'
          ) {
            fallbackAdmissionRequested = true;
            return fallbackAdmission;
          }
        },
        dynamicToolCallHandler: () => new Promise<never>(() => undefined),
        getWindow: (): null => null,
      });
      const { turnPromise } = await startActiveTurn(client, proc);
      let settled = false;
      void turnPromise.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      try {
        const params = {
          threadId: 'thread-1',
          turnId: 'turn-1',
          callId: 'call',
          namespace: null,
          tool: 'canopy_dispatch_action',
          arguments: {},
        };
        emitServerMessage(proc, {
          method: 'item/started',
          params: {
            threadId: 'thread-1',
            turnId: 'turn-1',
            item: {
              ...params,
              id: 'call',
              type: 'dynamicToolCall',
              status: 'inProgress',
              contentItems: [],
              success: null,
            },
          },
        });
        emitServerMessage(proc, {
          id: 'call',
          method: 'item/tool/call',
          params,
        });
        await flush();
        emitServerMessage(proc, {
          method: 'serverRequest/resolved',
          params: { threadId: 'thread-1', requestId: 'call' },
        });
        await flush();

        completeRootTurn(proc);
        await flush();
        expect(fallbackAdmissionRequested).toBe(true);
        expect(settled).toBe(false);

        finishFallbackAdmission();
        if (admissionOutcome === 'reject') {
          await expect(turnPromise).rejects.toThrow(
            'fallback row admission failed',
          );
        } else {
          await expect(turnPromise).resolves.toMatchObject({
            status: 'completed',
          });
        }
        expect(settled).toBe(true);
      } finally {
        finishFallbackAdmission();
        client.dispose();
        await turnPromise.catch(() => undefined);
      }
    },
  );

  it('does not report a root turn complete when terminal route admission fails', async () => {
    let rejectAdmission: (error: Error) => void = () => undefined;
    const admission = new Promise<void>((_resolve, reject) => {
      rejectAdmission = reject;
    });
    const client = new CodexAppServerClient({
      cwd: '/tmp/repo',
      projectId: 'project',
      worktreeId: 'worktree',
      chatId: 'chat',
      sessionKey: 'project/worktree/chat',
      onEvent: (event): void | Promise<void> => {
        if (
          typeof event !== 'object' ||
          event === null ||
          !('event' in event)
        ) {
          return;
        }
        const detail = event.event;
        if (
          typeof detail === 'object' &&
          detail !== null &&
          'type' in detail &&
          detail.type === 'turn.completed'
        ) {
          return admission;
        }
      },
      getWindow: (): null => null,
    });
    const { turnPromise } = await startActiveTurn(client, proc);
    const outcome = turnPromise.then(
      () => 'resolved',
      () => 'rejected',
    );
    let settled = false;
    void outcome.then(() => {
      settled = true;
    });
    try {
      completeRootTurn(proc);
      await flush();
      expect(settled).toBe(false);
      rejectAdmission(new Error('terminal route admission failed'));
      expect(await outcome).toBe('rejected');
    } finally {
      rejectAdmission(new Error('test cleanup'));
      await outcome;
      client.dispose();
    }
  });

  it.each(['dispose', 'process-exit'] as const)(
    'settles a held terminal route admission when %s ends its owner',
    async (failure) => {
      let releaseAdmission = (): void => undefined;
      const admission = new Promise<void>((resolve) => {
        releaseAdmission = resolve;
      });
      const client = new CodexAppServerClient({
        cwd: '/tmp/repo',
        projectId: 'project',
        worktreeId: 'worktree',
        chatId: 'chat',
        sessionKey: 'project/worktree/chat',
        onEvent: (event): void | Promise<void> => {
          if (
            typeof event === 'object' &&
            event !== null &&
            'event' in event &&
            typeof event.event === 'object' &&
            event.event !== null &&
            'type' in event.event &&
            event.event.type === 'turn.completed'
          ) {
            return admission;
          }
        },
        getWindow: (): null => null,
      });
      const { turnPromise } = await startActiveTurn(client, proc);
      const outcome = turnPromise.then(
        () => 'resolved',
        () => 'rejected',
      );
      let settled = false;
      void outcome.then(() => {
        settled = true;
      });
      try {
        completeRootTurn(proc);
        await flush();
        expect(settled).toBe(false);
        if (failure === 'dispose') client.dispose();
        else proc.emit('exit', 1, null);
        await flush();
        await flush();
        expect(settled).toBe(true);
        expect(await outcome).toBe('rejected');
      } finally {
        client.dispose();
        releaseAdmission();
        await outcome;
      }
    },
  );

  it('does not reject a newer turn when an old setup event admission fails late', async () => {
    let rejectOldAdmission: (error: Error) => void = () => undefined;
    const oldAdmission = new Promise<void>((_resolve, reject) => {
      rejectOldAdmission = reject;
    });
    void oldAdmission.catch(() => undefined);
    const client = new CodexAppServerClient({
      cwd: '/tmp/repo',
      projectId: 'project',
      worktreeId: 'worktree',
      chatId: 'chat',
      sessionKey: 'project/worktree/chat',
      onEvent: (event): void | Promise<void> => {
        if (
          typeof event === 'object' &&
          event !== null &&
          'type' in event &&
          event.type === 'system' &&
          'subtype' in event &&
          event.subtype === 'init'
        ) {
          return oldAdmission;
        }
      },
      getWindow: (): null => null,
    });
    const { turnPromise: firstTurn } = await startActiveTurn(client, proc);
    try {
      completeRootTurn(proc);
      await expect(firstTurn).resolves.toMatchObject({ status: 'completed' });
      collectClientMessages(proc);

      const secondTurn = client.startTurn({
        text: 'Second turn',
        cwd: '/tmp/repo',
        model: 'gpt-6-sol',
        thinkingLevel: 'high',
        planMode: false,
      });
      const secondOutcome = secondTurn.then(
        (value) => ({ ok: true, value }),
        (error: unknown) => ({ ok: false, error }),
      );
      let start: Record<string, unknown> | undefined;
      for (let attempt = 0; attempt < 200; attempt += 1) {
        start = collectClientMessages(proc).find(
          (message) => message.method === 'turn/start',
        );
        if (start) break;
        await flush();
      }
      if (!start) throw new Error('expected second turn/start request');
      emitServerMessage(proc, {
        id: start.id,
        result: {
          turn: { id: 'turn-2', items: [], status: 'inProgress', error: null },
        },
      });
      await flush();
      rejectOldAdmission(new Error('old setup admission failed'));
      await flush();
      emitServerMessage(proc, {
        method: 'turn/completed',
        params: {
          threadId: 'thread-1',
          turn: { id: 'turn-2', items: [], status: 'completed', error: null },
        },
      });
      await expect(secondOutcome).resolves.toMatchObject({
        ok: true,
        value: { status: 'completed' },
      });
    } finally {
      rejectOldAdmission(new Error('test cleanup'));
      client.dispose();
    }
  });

  it('forwards clientUserMessageId on an ordinary turn/start request', async () => {
    const observations: TurnLifecycleObservation[] = [];
    const client = new CodexAppServerClient({
      cwd: '/tmp/repo',
      projectId: 'project',
      worktreeId: 'worktree',
      chatId: 'chat',
      sessionKey: 'project/worktree/chat',
      onEvent: jest.fn(),
      getWindow: (): null => null,
      onTurnLifecycleObservation: (observation): void => {
        observations.push(observation);
      },
    });
    const { turnPromise } = await startActiveTurn(
      client,
      proc,
      [],
      'host-message-ordinary',
      'submission-ordinary',
      'client-message-ordinary',
      'local-user-message-ordinary',
    );
    try {
      const start = collectClientMessages(proc).find(
        (message) => message.method === 'turn/start',
      );
      if (!start) throw new Error('Expected ordinary turn/start request');
      expect(getRequestParams(start).clientUserMessageId).toBe(
        'client-message-ordinary',
      );
      completeRootTurn(proc);
      await expect(turnPromise).resolves.toMatchObject({ status: 'completed' });
      expect(observations).toContainEqual({
        type: 'turn-started',
        threadId: 'thread-1',
        turnId: 'turn-1',
        origin: 'user',
        submissionId: 'submission-ordinary',
        userMessageId: 'local-user-message-ordinary',
      });
    } finally {
      client.dispose();
      await turnPromise.catch(() => undefined);
    }
  });

  it('does not infer a local user message id from the wire fallback submission id', async () => {
    const observations: TurnLifecycleObservation[] = [];
    const client = new CodexAppServerClient({
      cwd: '/tmp/repo',
      projectId: 'project',
      worktreeId: 'worktree',
      chatId: 'chat',
      sessionKey: 'project/worktree/chat',
      onEvent: jest.fn(),
      getWindow: (): null => null,
      onTurnLifecycleObservation: (observation): void => {
        observations.push(observation);
      },
    });
    const { turnPromise } = await startActiveTurn(
      client,
      proc,
      [],
      'host-message-without-local-id',
      'submission-without-local-id',
      'submission-without-local-id',
    );
    try {
      expect(observations).toContainEqual({
        type: 'turn-started',
        threadId: 'thread-1',
        turnId: 'turn-1',
        origin: 'user',
        submissionId: 'submission-without-local-id',
      });
      expect(observations).not.toContainEqual(
        expect.objectContaining({
          userMessageId: 'submission-without-local-id',
        }),
      );
      completeRootTurn(proc);
      await expect(turnPromise).resolves.toMatchObject({ status: 'completed' });
    } finally {
      client.dispose();
      await turnPromise.catch(() => undefined);
    }
  });

  it('binds a picked-up steering attempt to the local user message id', async () => {
    const observations: TurnLifecycleObservation[] = [];
    const lifecycleOptions = {
      onTurnLifecycleObservation: (
        observation: TurnLifecycleObservation,
      ): void => {
        observations.push(observation);
      },
    };
    const client = new CodexAppServerClient({
      cwd: '/tmp/repo',
      projectId: 'project',
      worktreeId: 'worktree',
      chatId: 'chat',
      sessionKey: 'project/worktree/chat',
      onEvent: jest.fn(),
      getWindow: (): null => null,
      ...lifecycleOptions,
    });
    const { turnPromise } = await startActiveTurn(client, proc);
    try {
      const submitted = client.submitSteeringInput(
        'Continue with this input',
        'submission-steer-1',
        undefined,
        'local-user-message-1',
      );
      const steer = await waitForClientRequest(proc, 'turn/steer');
      emitServerMessage(proc, { id: steer.id, result: {} });
      await expect(submitted).resolves.toMatchObject({ kind: 'accepted' });

      await client.handleConnectionNotification('item/started', {
        params: {
          threadId: 'thread-1',
          turnId: 'turn-1',
          item: {
            id: 'steering-user-item',
            type: 'userMessage',
            clientId: 'submission-steer-1',
          },
        },
      });
      expect(observations).toContainEqual({
        type: 'input-bound',
        threadId: 'thread-1',
        turnId: 'turn-1',
        submissionId: 'submission-steer-1',
        userMessageId: 'local-user-message-1',
      });
      completeRootTurn(proc);
      await expect(turnPromise).resolves.toMatchObject({ status: 'completed' });
    } finally {
      client.dispose();
      await turnPromise.catch(() => undefined);
    }
  });

  it('maps root thread status to shadow session state and ignores child and unrecognized statuses', async () => {
    const observations: TurnLifecycleObservation[] = [];
    const lifecycleOptions = {
      onTurnLifecycleObservation: (
        observation: TurnLifecycleObservation,
      ): void => {
        observations.push(observation);
      },
    };
    const client = new CodexAppServerClient({
      cwd: '/tmp/repo',
      projectId: 'project',
      worktreeId: 'worktree',
      chatId: 'chat',
      sessionKey: 'project/worktree/chat',
      onEvent: jest.fn(),
      getWindow: (): null => null,
      ...lifecycleOptions,
    });
    const { turnPromise } = await startActiveTurn(client, proc);
    try {
      await client.handleConnectionNotification('thread/status/changed', {
        params: {
          threadId: 'child-thread-1',
          status: { type: 'active', activeFlags: [] },
        },
      });
      await client.handleConnectionNotification('thread/status/changed', {
        params: {
          threadId: 'thread-1',
          status: { type: 'active', activeFlags: [] },
        },
      });
      await client.handleConnectionNotification('thread/status/changed', {
        params: {
          threadId: 'thread-1',
          status: { type: 'active', activeFlags: ['waitingOnApproval'] },
        },
      });
      await client.handleConnectionNotification('thread/status/changed', {
        params: {
          threadId: 'thread-1',
          status: { type: 'active', activeFlags: ['waitingOnUserInput'] },
        },
      });
      await client.handleConnectionNotification('thread/status/changed', {
        params: { threadId: 'thread-1', status: { type: 'idle' } },
      });
      await client.handleConnectionNotification('thread/status/changed', {
        params: { threadId: 'thread-1', status: { type: 'systemError' } },
      });
      await client.handleConnectionNotification('thread/status/changed', {
        params: { threadId: 'thread-1', status: { type: 'notLoaded' } },
      });
      expect(
        observations.filter((entry) => entry.type === 'session-state'),
      ).toEqual([
        {
          type: 'session-state',
          threadId: 'thread-1',
          turnId: 'turn-1',
          state: 'running',
        },
        {
          type: 'session-state',
          threadId: 'thread-1',
          turnId: 'turn-1',
          state: 'requires_action',
        },
        {
          type: 'session-state',
          threadId: 'thread-1',
          turnId: 'turn-1',
          state: 'requires_action',
        },
        {
          type: 'session-state',
          threadId: 'thread-1',
          turnId: 'turn-1',
          state: 'idle',
        },
      ]);
      expect(observations).not.toContainEqual(
        expect.objectContaining({ threadId: 'child-thread-1' }),
      );
      completeRootTurn(proc);
      await expect(turnPromise).resolves.toMatchObject({ status: 'completed' });
    } finally {
      client.dispose();
      await turnPromise.catch(() => undefined);
    }
  });

  it('maps a retryable root error to reconnecting without a terminal or error event', async () => {
    const observations: TurnLifecycleObservation[] = [];
    const events: unknown[] = [];
    const lifecycleOptions = {
      onTurnLifecycleObservation: (
        observation: TurnLifecycleObservation,
      ): void => {
        observations.push(observation);
      },
    };
    const client = new CodexAppServerClient({
      cwd: '/tmp/repo',
      projectId: 'project',
      worktreeId: 'worktree',
      chatId: 'chat',
      sessionKey: 'project/worktree/chat',
      onEvent: (event): void => {
        events.push(event);
      },
      getWindow: (): null => null,
      ...lifecycleOptions,
    });
    const { turnPromise } = await startActiveTurn(client, proc);
    let settled = false;
    void turnPromise.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    try {
      await client.handleConnectionNotification('error', {
        params: {
          threadId: 'thread-1',
          turnId: 'turn-1',
          willRetry: true,
          error: { message: 'reconnecting' },
        },
      });
      expect(
        observations.filter((entry) => entry.type === 'session-state'),
      ).toEqual([
        {
          type: 'session-state',
          threadId: 'thread-1',
          turnId: 'turn-1',
          state: 'reconnecting',
        },
      ]);
      expect(
        observations.some((entry) => entry.type === 'turn-completed'),
      ).toBe(false);
      expect(
        events.some(
          (event) =>
            isRecord(event) &&
            event.type === 'codex' &&
            isRecord(event.event) &&
            event.event.type === 'error',
        ),
      ).toBe(false);
      expect(settled).toBe(false);
      expect(client.hasActiveTurn()).toBe(true);
      expect(client.getSteeringCapabilities().steer).toBe(true);
      completeRootTurn(proc);
      await expect(turnPromise).resolves.toMatchObject({ status: 'completed' });
    } finally {
      client.dispose();
      await turnPromise.catch(() => undefined);
    }
  });

  it('does not forward a wrong-id fatal error into a later failed root completion', async () => {
    const events: unknown[] = [];
    const client = createClient(events);
    const { turnPromise } = await startActiveTurn(client, proc);
    try {
      emitServerMessage(proc, {
        method: 'error',
        params: {
          threadId: 'thread-1',
          turnId: 'stale-turn',
          willRetry: false,
          error: { message: 'stale failure detail' },
        },
      });
      await flush();
      expect(client.hasActiveTurn()).toBe(true);
      expect(
        events.some(
          (event) =>
            isRecord(event) &&
            isRecord(event.event) &&
            event.event.type === 'error',
        ),
      ).toBe(false);
      emitServerMessage(proc, {
        method: 'turn/completed',
        params: {
          threadId: 'thread-1',
          turn: {
            id: 'turn-1',
            items: [],
            status: 'failed',
            error: { message: 'authoritative failure' },
          },
        },
      });
      await expect(turnPromise).resolves.toMatchObject({
        status: 'failed',
        error: 'authoritative failure',
      });
      expect(JSON.stringify(events)).not.toContain('stale failure detail');
    } finally {
      client.dispose();
      await turnPromise.catch(() => undefined);
    }
  });

  it('attaches submission and client message identities to an ordinary root start observation', async () => {
    const observations: TurnLifecycleObservation[] = [];
    const lifecycleOptions = {
      onTurnLifecycleObservation: (
        observation: TurnLifecycleObservation,
      ): void => {
        observations.push(observation);
      },
    };
    const client = new CodexAppServerClient({
      cwd: '/tmp/repo',
      projectId: 'project',
      worktreeId: 'worktree',
      chatId: 'chat',
      sessionKey: 'project/worktree/chat',
      onEvent: jest.fn(),
      getWindow: (): null => null,
      ...lifecycleOptions,
    });
    const { turnPromise } = await startActiveTurn(
      client,
      proc,
      [],
      'host-message-ordinary-observation',
      'submission-ordinary-observation',
      'client-message-ordinary-observation',
    );
    try {
      expect(observations).toContainEqual({
        type: 'turn-started',
        threadId: 'thread-1',
        turnId: 'turn-1',
        origin: 'user',
        submissionId: 'submission-ordinary-observation',
        userMessageId: 'client-message-ordinary-observation',
      });
      completeRootTurn(proc);
      await expect(turnPromise).resolves.toMatchObject({ status: 'completed' });
    } finally {
      client.dispose();
      await turnPromise.catch(() => undefined);
    }
  });

  it.each([
    {
      label: 'turn/start response',
      notificationFirst: false,
      responseStartedAt: 1_700_000_000,
      notificationStartedAt: 1_700_000_001,
      expectedStartedAtMs: 1_700_000_000_000,
      chatId: 'native-timing-response-first',
    },
    {
      label: 'turn/started notification',
      notificationFirst: true,
      responseStartedAt: 1_700_000_002,
      notificationStartedAt: 1_700_000_003,
      expectedStartedAtMs: 1_700_000_003_000,
      chatId: 'native-timing-notification-first',
    },
  ])(
    'carries native timing from the first root start source ($label) through the tracker',
    async ({
      notificationFirst,
      responseStartedAt,
      notificationStartedAt,
      expectedStartedAtMs,
      chatId,
    }) => {
      const lifecycleScope = {
        projectId: 'project',
        worktreeId: 'worktree',
        chatId,
      };
      const lifecycleEvents: ChatTurnLifecycleEvent[] = [];
      const tracker = new CodexTurnLifecycleTracker(
        getTurnLifecycleProducer('codex', lifecycleScope),
      );
      setTurnLifecycleSink((event): void => {
        lifecycleEvents.push(event);
      });
      const client = new CodexAppServerClient({
        cwd: '/tmp/repo',
        projectId: lifecycleScope.projectId,
        worktreeId: lifecycleScope.worktreeId,
        chatId: lifecycleScope.chatId,
        sessionKey: `${lifecycleScope.projectId}/${lifecycleScope.worktreeId}/${lifecycleScope.chatId}`,
        onEvent: jest.fn(),
        getWindow: (): null => null,
        onTurnLifecycleObservation: (observation): void =>
          tracker.observe(observation),
      });
      let turnPromise: Promise<CodexTurnTestResult> | undefined;
      try {
        const started = await startActiveTurn(
          client,
          proc,
          [],
          'native-timing-execution-anchor',
          'native-timing-submission',
          'native-timing-user-message',
          undefined,
          {
            responseTurn: {
              id: 'turn-1',
              items: [],
              status: 'inProgress',
              error: null,
              startedAt: responseStartedAt,
              completedAt: null,
              durationMs: null,
            },
            notificationTurn: {
              id: 'turn-1',
              items: [],
              status: 'inProgress',
              error: null,
              startedAt: notificationStartedAt,
              completedAt: null,
              durationMs: null,
            },
            notificationFirst,
          },
        );
        turnPromise = started.turnPromise;

        expect(lifecycleEvents).toHaveLength(1);
        expect(lifecycleEvents[0]).toMatchObject({
          type: 'TurnStarted',
          provider: 'codex',
          chatId: lifecycleScope.chatId,
          providerSessionId: 'thread-1',
          turnId: 'turn-1',
          sequence: 1,
          startedAtMs: expectedStartedAtMs,
        });

        completeRootTurn(proc, 'turn-1', {
          completedAt: 1_700_000_010,
          durationMs: 9_876,
        });
        await expect(turnPromise).resolves.toMatchObject({
          status: 'completed',
        });
        expect(lifecycleEvents).toHaveLength(2);
        expect(lifecycleEvents[1]).toMatchObject({
          type: 'TurnEnded',
          provider: 'codex',
          chatId: lifecycleScope.chatId,
          providerSessionId: 'thread-1',
          turnId: 'turn-1',
          sequence: 2,
          endedAtMs: 1_700_000_010_000,
          durationMs: 9_876,
        });
      } finally {
        client.dispose();
        await turnPromise?.catch(() => undefined);
        setTurnLifecycleSink(null);
        releaseTurnLifecycleProducer('codex', lifecycleScope);
      }
    },
  );

  it.each([
    {
      label: 'null',
      nativeStartTiming: {
        startedAt: null,
        completedAt: null,
        durationMs: null,
      },
      nativeCompletionTiming: { completedAt: null, durationMs: null },
    },
    {
      label: 'missing',
      nativeStartTiming: {},
      nativeCompletionTiming: undefined,
    },
  ])(
    'falls back to the observation clock for $label native timings through the tracker',
    async ({ label, nativeStartTiming, nativeCompletionTiming }) => {
      let currentTimeMs = 1_000;
      const dateNow = jest
        .spyOn(Date, 'now')
        .mockImplementation(() => currentTimeMs);
      const lifecycleScope = {
        projectId: 'project',
        worktreeId: 'worktree',
        chatId: `native-timing-${label}`,
      };
      const lifecycleEvents: ChatTurnLifecycleEvent[] = [];
      const tracker = new CodexTurnLifecycleTracker(
        getTurnLifecycleProducer('codex', lifecycleScope),
      );
      setTurnLifecycleSink((event): void => {
        lifecycleEvents.push(event);
      });
      const client = new CodexAppServerClient({
        cwd: '/tmp/repo',
        projectId: lifecycleScope.projectId,
        worktreeId: lifecycleScope.worktreeId,
        chatId: lifecycleScope.chatId,
        sessionKey: `${lifecycleScope.projectId}/${lifecycleScope.worktreeId}/${lifecycleScope.chatId}`,
        onEvent: jest.fn(),
        getWindow: (): null => null,
        onTurnLifecycleObservation: (observation): void =>
          tracker.observe(observation),
      });
      let turnPromise: Promise<CodexTurnTestResult> | undefined;
      try {
        const started = await startActiveTurn(
          client,
          proc,
          [],
          'native-timing-null-anchor',
          'native-timing-null-submission',
          'native-timing-null-message',
          undefined,
          {
            responseTurn: {
              id: 'turn-1',
              items: [],
              status: 'inProgress',
              error: null,
              ...nativeStartTiming,
            },
            notificationTurn: {
              id: 'turn-1',
              items: [],
              status: 'inProgress',
              error: null,
              ...nativeStartTiming,
            },
          },
        );
        turnPromise = started.turnPromise;
        expect(lifecycleEvents[0]).toMatchObject({
          type: 'TurnStarted',
          startedAtMs: 1_000,
        });

        currentTimeMs = 4_000;
        completeRootTurn(proc, 'turn-1', nativeCompletionTiming);
        await expect(turnPromise).resolves.toMatchObject({
          status: 'completed',
        });
        expect(lifecycleEvents[1]).toMatchObject({
          type: 'TurnEnded',
          endedAtMs: 4_000,
        });
        // The reducer derives 3 000 ms from these times, net of any pause.
        expect(lifecycleEvents[1]).not.toHaveProperty('durationMs');
      } finally {
        client.dispose();
        await turnPromise?.catch(() => undefined);
        setTurnLifecycleSink(null);
        releaseTurnLifecycleProducer('codex', lifecycleScope);
        dateNow.mockRestore();
      }
    },
  );

  it('reports only root lifecycle and status observations, and ignores retryable errors as terminals', async () => {
    const events: unknown[] = [];
    const observations: TurnLifecycleObservation[] = [];
    const lifecycleOptions = {
      onTurnLifecycleObservation: (
        observation: TurnLifecycleObservation,
      ): void => {
        observations.push(observation);
      },
    };
    const client = new CodexAppServerClient({
      cwd: '/tmp/repo',
      projectId: 'project',
      worktreeId: 'worktree',
      chatId: 'chat',
      sessionKey: 'project/worktree/chat',
      onEvent: (event): void => {
        events.push(event);
      },
      getWindow: (): null => null,
      ...lifecycleOptions,
    });
    const { turnPromise } = await startActiveTurn(
      client,
      proc,
      [],
      'host-message-1',
      'submission-1',
      'client-message-1',
    );
    let settled = false;
    void turnPromise.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    try {
      const start = collectClientMessages(proc).find(
        (message) => message.method === 'turn/start',
      );
      if (!start) throw new Error('Expected ordinary turn/start request');
      expect(getRequestParams(start).clientUserMessageId).toBe(
        'client-message-1',
      );
      expect(observations).toContainEqual({
        type: 'turn-started',
        threadId: 'thread-1',
        turnId: 'turn-1',
        origin: 'user',
        submissionId: 'submission-1',
        userMessageId: 'client-message-1',
      });

      await client.handleConnectionNotification('turn/started', {
        params: {
          threadId: 'thread-1',
          turn: { id: 'turn-1', items: [], status: 'inProgress' },
        },
      });
      await client.handleConnectionNotification('thread/status/changed', {
        params: {
          threadId: 'child-thread-1',
          status: { type: 'active', activeFlags: [] },
        },
      });
      await client.handleConnectionNotification('thread/status/changed', {
        params: {
          threadId: 'thread-1',
          status: { type: 'active', activeFlags: [] },
        },
      });
      await client.handleConnectionNotification('thread/status/changed', {
        params: {
          threadId: 'thread-1',
          status: { type: 'active', activeFlags: ['waitingOnApproval'] },
        },
      });
      await client.handleConnectionNotification('thread/status/changed', {
        params: {
          threadId: 'thread-1',
          status: { type: 'active', activeFlags: ['waitingOnUserInput'] },
        },
      });
      await client.handleConnectionNotification('thread/status/changed', {
        params: { threadId: 'thread-1', status: { type: 'idle' } },
      });
      await client.handleConnectionNotification('thread/status/changed', {
        params: { threadId: 'thread-1', status: { type: 'systemError' } },
      });
      await client.handleConnectionNotification('thread/status/changed', {
        params: { threadId: 'thread-1', status: { type: 'notLoaded' } },
      });
      await client.handleConnectionNotification('turn/started', {
        params: {
          threadId: 'child-thread-1',
          turn: { id: 'child-turn-1', items: [], status: 'inProgress' },
        },
      });
      await client.handleConnectionNotification('error', {
        params: {
          threadId: 'thread-1',
          turnId: 'turn-1',
          willRetry: true,
          error: { message: 'retrying connection' },
        },
      });
      await client.handleConnectionNotification('error', {
        params: {
          threadId: 'child-thread-1',
          turnId: 'child-turn-1',
          willRetry: true,
          error: { message: 'child retry' },
        },
      });
      await flush();

      expect(
        observations.filter((entry) => entry.type === 'session-state'),
      ).toEqual([
        {
          type: 'session-state',
          threadId: 'thread-1',
          turnId: 'turn-1',
          state: 'running',
        },
        {
          type: 'session-state',
          threadId: 'thread-1',
          turnId: 'turn-1',
          state: 'requires_action',
        },
        {
          type: 'session-state',
          threadId: 'thread-1',
          turnId: 'turn-1',
          state: 'requires_action',
        },
        {
          type: 'session-state',
          threadId: 'thread-1',
          turnId: 'turn-1',
          state: 'idle',
        },
        {
          type: 'session-state',
          threadId: 'thread-1',
          turnId: 'turn-1',
          state: 'reconnecting',
        },
      ]);
      expect(
        observations.some(
          (entry) => 'threadId' in entry && entry.threadId === 'child-thread-1',
        ),
      ).toBe(false);
      expect(
        observations.some(
          (entry) =>
            entry.type === 'input-bound' || entry.type === 'turn-completed',
        ),
      ).toBe(false);
      expect(
        events.some(
          (event) =>
            isRecord(event) &&
            event.type === 'codex' &&
            isRecord(event.event) &&
            event.event.type === 'error',
        ),
      ).toBe(false);
      expect(settled).toBe(false);
      expect(client.hasActiveTurn()).toBe(true);
      expect(client.getSteeringCapabilities().steer).toBe(true);

      completeRootTurn(proc);
      await expect(turnPromise).resolves.toMatchObject({ status: 'completed' });
      expect(observations).toContainEqual({
        type: 'turn-completed',
        threadId: 'thread-1',
        turnId: 'turn-1',
        status: 'completed',
      });
    } finally {
      client.dispose();
      await turnPromise.catch(() => undefined);
    }
  });

  it('catches shadow lifecycle observer failures without changing turn delivery', async () => {
    const observations: TurnLifecycleObservation[] = [];
    const lifecycleOptions = {
      onTurnLifecycleObservation: (
        observation: TurnLifecycleObservation,
      ): void => {
        observations.push(observation);
        throw new Error('shadow sink unavailable');
      },
    };
    const client = new CodexAppServerClient({
      cwd: '/tmp/repo',
      projectId: 'project',
      worktreeId: 'worktree',
      chatId: 'chat',
      sessionKey: 'project/worktree/chat',
      onEvent: jest.fn(),
      getWindow: (): null => null,
      ...lifecycleOptions,
    });
    const { turnPromise } = await startActiveTurn(
      client,
      proc,
      [],
      'host-message-throw',
      'submission-throw',
      'client-message-throw',
    );
    try {
      completeRootTurn(proc);
      await expect(turnPromise).resolves.toMatchObject({ status: 'completed' });
      expect(observations).toContainEqual({
        type: 'turn-started',
        threadId: 'thread-1',
        turnId: 'turn-1',
        origin: 'user',
        submissionId: 'submission-throw',
        userMessageId: 'client-message-throw',
      });
      expect(observations).toContainEqual({
        type: 'turn-completed',
        threadId: 'thread-1',
        turnId: 'turn-1',
        status: 'completed',
      });
    } finally {
      client.dispose();
      await turnPromise.catch(() => undefined);
    }
  });

  it.each([
    { label: 'start response first', notificationFirst: false },
    { label: 'turn/started notification first', notificationFirst: true },
  ])(
    'merges a resumed live root start when $label',
    async ({ notificationFirst }) => {
      const events: unknown[] = [];
      const observations: TurnLifecycleObservation[] = [];
      const lifecycleOptions = {
        onTurnLifecycleObservation: (
          observation: TurnLifecycleObservation,
        ): void => {
          observations.push(observation);
        },
      };
      const client = new CodexAppServerClient({
        cwd: '/tmp/repo',
        projectId: 'project',
        worktreeId: 'worktree',
        chatId: 'chat',
        sessionKey: 'project/worktree/chat',
        initialThreadId: 'thread-1',
        initialExecutionUserMessageId: 'host-original-anchor',
        onEvent: (event): void => {
          events.push(event);
        },
        getWindow: (): null => null,
        ...lifecycleOptions,
      });
      const { turnPromise, threadRequest } = await startTurnUntilThreadRequest(
        client,
        proc,
        {
          text: 'Follow-up input',
          cwd: '/tmp/repo',
          model: 'gpt-6-sol',
          thinkingLevel: 'high',
          planMode: false,
          executionUserMessageId: 'host-follow-up',
          submissionId: 'submission-follow-up',
          clientUserMessageId: 'client-follow-up',
        },
      );
      try {
        expect(threadRequest.method).toBe('thread/resume');
        emitServerMessage(proc, {
          id: threadRequest.id,
          result: makeThreadResult('thread-1', [
            {
              id: 'native-live-turn',
              items: [
                {
                  id: 'original-user-item',
                  type: 'userMessage',
                  clientId: 'host-original-anchor',
                },
              ],
              status: 'inProgress',
              error: null,
            },
          ]),
        });
        const start = await waitForClientRequest(proc, 'turn/start');
        if (notificationFirst) {
          emitServerMessage(proc, {
            method: 'turn/started',
            params: {
              threadId: 'thread-1',
              turn: {
                id: 'native-live-turn',
                items: [],
                status: 'inProgress',
              },
            },
          });
          await flush();
        }
        emitServerMessage(proc, {
          id: start.id,
          result: {
            turn: {
              id: 'native-live-turn',
              items: [],
              status: 'inProgress',
              error: null,
            },
          },
        });
        if (!notificationFirst) {
          emitServerMessage(proc, {
            method: 'turn/started',
            params: {
              threadId: 'thread-1',
              turn: {
                id: 'native-live-turn',
                items: [],
                status: 'inProgress',
              },
            },
          });
        }
        await flush();

        const startedEvent = events.find(
          (event) =>
            isRecord(event) &&
            isRecord(event.event) &&
            event.event.type === 'turn.started' &&
            event.event.turn_id === 'native-live-turn',
        );
        expect(
          getProviderRunDescriptor(startedEvent)?.executionUserMessageId,
          // Events keep the dispatched anchor the host's turn owns; the merge
          // is reported to the shadow stream only (phase 35 re-anchors).
        ).toBe('host-follow-up');
        expect(
          observations.filter(
            (entry) => entry.type === 'turn-started' && entry.merged === true,
          ),
        ).toEqual([
          {
            type: 'turn-started',
            threadId: 'thread-1',
            turnId: 'native-live-turn',
            origin: 'user',
            submissionId: 'submission-follow-up',
            userMessageId: 'client-follow-up',
            merged: true,
          },
        ]);

        completeRootTurn(proc, 'native-live-turn');
        await expect(turnPromise).resolves.toMatchObject({
          status: 'completed',
        });
      } finally {
        client.dispose();
        await turnPromise.catch(() => undefined);
      }
    },
  );

  it('retains an exact live-turn anchor across client recreation when resume omits items', async () => {
    const firstClient = new CodexAppServerClient({
      cwd: '/tmp/repo',
      projectId: 'anchor-retention-project',
      worktreeId: 'anchor-retention-worktree',
      chatId: 'anchor-retention-chat',
      sessionKey:
        'anchor-retention-project/anchor-retention-worktree/anchor-retention-chat',
      initialThreadId: 'thread-1',
      onEvent: jest.fn(),
      getWindow: (): null => null,
    });
    const { turnPromise: firstTurnPromise } = await startActiveTurn(
      firstClient,
      proc,
      [],
      'host-original-across-recreation',
    );
    firstClient.dispose();
    await firstTurnPromise.catch(() => undefined);

    const events: unknown[] = [];
    const observations: TurnLifecycleObservation[] = [];
    const client = new CodexAppServerClient({
      cwd: '/tmp/repo',
      projectId: 'anchor-retention-project',
      worktreeId: 'anchor-retention-worktree',
      chatId: 'anchor-retention-chat',
      sessionKey:
        'anchor-retention-project/anchor-retention-worktree/anchor-retention-chat',
      initialThreadId: 'thread-1',
      onEvent: (event): void => {
        events.push(event);
      },
      getWindow: (): null => null,
      onTurnLifecycleObservation: (observation): void => {
        observations.push(observation);
      },
    });
    const { turnPromise, threadRequest } = await startTurnUntilThreadRequest(
      client,
      proc,
      {
        text: 'Follow-up input after client recreation',
        cwd: '/tmp/repo',
        model: 'gpt-6-sol',
        thinkingLevel: 'high',
        planMode: false,
        executionUserMessageId: 'host-follow-up-after-recreation',
        submissionId: 'submission-follow-up-after-recreation',
        clientUserMessageId: 'client-follow-up-after-recreation',
      },
    );
    try {
      expect(threadRequest.method).toBe('thread/resume');
      emitServerMessage(proc, {
        id: threadRequest.id,
        result: makeThreadResult('thread-1', [
          {
            id: 'turn-1',
            items: [],
            status: 'inProgress',
            error: null,
          },
        ]),
      });
      const start = await waitForClientRequest(proc, 'turn/start');
      emitServerMessage(proc, {
        id: start.id,
        result: {
          turn: { id: 'turn-1', items: [], status: 'inProgress', error: null },
        },
      });
      await client.handleConnectionNotification('turn/started', {
        params: {
          threadId: 'thread-1',
          turn: { id: 'turn-1', items: [], status: 'inProgress' },
        },
      });
      await flush();

      const startedEvent = events.find(
        (event) =>
          isRecord(event) &&
          isRecord(event.event) &&
          event.event.type === 'turn.started' &&
          event.event.turn_id === 'turn-1',
      );
      expect(
        getProviderRunDescriptor(startedEvent)?.executionUserMessageId,
      ).toBe('host-follow-up-after-recreation');
      expect(
        observations.filter(
          (entry) => entry.type === 'turn-started' && entry.merged === true,
        ),
      ).toContainEqual(
        expect.objectContaining({
          threadId: 'thread-1',
          turnId: 'turn-1',
          merged: true,
        }),
      );
      completeRootTurn(proc, 'turn-1');
      await expect(turnPromise).resolves.toMatchObject({ status: 'completed' });
    } finally {
      client.dispose();
      await turnPromise.catch(() => undefined);
    }
  });

  it('does not merge a start into a known completed resume turn', async () => {
    const observations: TurnLifecycleObservation[] = [];
    const lifecycleOptions = {
      onTurnLifecycleObservation: (
        observation: TurnLifecycleObservation,
      ): void => {
        observations.push(observation);
      },
    };
    const events: unknown[] = [];
    const client = new CodexAppServerClient({
      cwd: '/tmp/repo',
      projectId: 'project',
      worktreeId: 'worktree',
      chatId: 'chat',
      sessionKey: 'project/worktree/chat',
      initialThreadId: 'thread-1',
      initialExecutionUserMessageId: 'host-original-anchor',
      onEvent: (event): void => {
        events.push(event);
      },
      getWindow: (): null => null,
      ...lifecycleOptions,
    });
    const { turnPromise, threadRequest } = await startTurnUntilThreadRequest(
      client,
      proc,
      {
        text: 'New input',
        cwd: '/tmp/repo',
        model: 'gpt-6-sol',
        thinkingLevel: 'high',
        planMode: false,
        executionUserMessageId: 'host-new-message',
        submissionId: 'submission-new',
        clientUserMessageId: 'client-new-message',
      },
    );
    try {
      emitServerMessage(proc, {
        id: threadRequest.id,
        result: makeThreadResult('thread-1', [
          {
            id: 'already-completed',
            items: [],
            status: 'completed',
            error: null,
          },
        ]),
      });
      const start = await waitForClientRequest(proc, 'turn/start');
      emitServerMessage(proc, {
        id: start.id,
        result: {
          turn: {
            id: 'already-completed',
            items: [],
            status: 'inProgress',
            error: null,
          },
        },
      });
      await client.handleConnectionNotification('turn/started', {
        params: {
          threadId: 'thread-1',
          turn: { id: 'already-completed', items: [], status: 'inProgress' },
        },
      });
      const startedEvent = events.find(
        (event) =>
          isRecord(event) &&
          isRecord(event.event) &&
          event.event.type === 'turn.started' &&
          event.event.turn_id === 'already-completed',
      );
      expect(
        getProviderRunDescriptor(startedEvent)?.executionUserMessageId,
      ).toBe('host-new-message');
      await flush();
      expect(
        observations.filter(
          (entry) => entry.type === 'turn-started' && entry.merged === true,
        ),
      ).toEqual([]);
      expect(observations).not.toContainEqual(
        expect.objectContaining({ type: 'input-bound' }),
      );
      completeRootTurn(proc, 'already-completed');
      await expect(turnPromise).resolves.toMatchObject({ status: 'completed' });
    } finally {
      client.dispose();
      await turnPromise.catch(() => undefined);
    }
  });

  it('does not retain an unresolved resumed start as live-turn provenance', async () => {
    const observations: TurnLifecycleObservation[] = [];
    mockLogMainProcessWarn.mockClear();
    const lifecycleOptions = {
      onTurnLifecycleObservation: (
        observation: TurnLifecycleObservation,
      ): void => {
        observations.push(observation);
      },
    };
    const client = new CodexAppServerClient({
      cwd: '/tmp/repo',
      projectId: 'project',
      worktreeId: 'worktree',
      chatId: 'chat',
      sessionKey: 'project/worktree/chat',
      initialThreadId: 'thread-1',
      initialExecutionUserMessageId: 'unrelated-last-anchor',
      onEvent: jest.fn(),
      getWindow: (): null => null,
      ...lifecycleOptions,
    });
    const { turnPromise, threadRequest } = await startTurnUntilThreadRequest(
      client,
      proc,
      {
        text: 'Follow-up without an anchor',
        cwd: '/tmp/repo',
        model: 'gpt-6-sol',
        thinkingLevel: 'high',
        planMode: false,
        submissionId: 'submission-unresolved',
        clientUserMessageId: 'client-unresolved',
      },
    );
    let recreatedClient: CodexAppServerClient | undefined;
    let recreatedTurnPromise: Promise<unknown> | undefined;
    try {
      emitServerMessage(proc, {
        id: threadRequest.id,
        result: makeThreadResult('thread-1', [
          {
            id: 'native-live-unanchored',
            items: [],
            status: 'inProgress',
            error: null,
          },
        ]),
      });
      const start = await waitForClientRequest(proc, 'turn/start');
      emitServerMessage(proc, {
        id: start.id,
        result: {
          turn: {
            id: 'native-live-unanchored',
            items: [],
            status: 'inProgress',
            error: null,
          },
        },
      });
      await flush();
      expect(mockLogMainProcessWarn).toHaveBeenCalledWith(
        'Codex resumed start merge unresolved',
        {
          code: 'codex_start_merge_unresolved',
          threadId: 'thread-1',
          turnId: 'native-live-unanchored',
        },
      );
      expect(observations).not.toContainEqual(
        expect.objectContaining({ merged: true }),
      );
      expect(observations).not.toContainEqual(
        expect.objectContaining({ type: 'input-bound' }),
      );
      expect(client.hasActiveTurn()).toBe(true);
      client.dispose();
      await turnPromise.catch(() => undefined);

      const recreatedObservations: TurnLifecycleObservation[] = [];
      recreatedClient = new CodexAppServerClient({
        cwd: '/tmp/repo',
        projectId: 'project',
        worktreeId: 'worktree',
        chatId: 'chat',
        sessionKey: 'project/worktree/chat',
        initialThreadId: 'thread-1',
        onEvent: jest.fn(),
        getWindow: (): null => null,
        onTurnLifecycleObservation: (observation): void => {
          recreatedObservations.push(observation);
        },
      });
      const recreatedStart = await startTurnUntilThreadRequest(
        recreatedClient,
        proc,
        {
          text: 'Another follow-up without original-turn evidence',
          cwd: '/tmp/repo',
          model: 'gpt-6-sol',
          thinkingLevel: 'high',
          planMode: false,
          executionUserMessageId: 'next-message-anchor',
          submissionId: 'submission-next',
          clientUserMessageId: 'client-next',
        },
      );
      recreatedTurnPromise = recreatedStart.turnPromise;
      emitServerMessage(proc, {
        id: recreatedStart.threadRequest.id,
        result: makeThreadResult('thread-1', [
          {
            id: 'native-live-unanchored',
            items: [],
            status: 'inProgress',
            error: null,
          },
        ]),
      });
      const recreatedTurnStart = await waitForClientRequest(proc, 'turn/start');
      emitServerMessage(proc, {
        id: recreatedTurnStart.id,
        result: {
          turn: {
            id: 'native-live-unanchored',
            items: [],
            status: 'inProgress',
            error: null,
          },
        },
      });
      await flush();
      expect(mockLogMainProcessWarn).toHaveBeenCalledTimes(2);
      expect(recreatedObservations).not.toContainEqual(
        expect.objectContaining({ merged: true }),
      );
      completeRootTurn(proc, 'native-live-unanchored');
      await expect(recreatedTurnPromise).resolves.toMatchObject({
        status: 'completed',
      });
    } finally {
      client.dispose();
      await turnPromise.catch(() => undefined);
      recreatedClient?.dispose();
      await recreatedTurnPromise?.catch(() => undefined);
    }
  });

  it('keeps later starts serialized behind an adopted provider-owned root run', async () => {
    const client = createClient();
    const { turnPromise } = await startActiveTurn(
      client,
      proc,
      [],
      'retained-anchor',
    );
    completeRootTurn(proc);
    await expect(turnPromise).resolves.toMatchObject({ status: 'completed' });
    collectClientMessages(proc);
    await startObservedRootRun(client, 'provider-owned-live');

    const nextTurn = client.startTurn({
      text: 'Do not overlap the provider-owned run',
      cwd: '/tmp/repo',
      model: 'gpt-6-sol',
      thinkingLevel: 'high',
      planMode: false,
    });
    void nextTurn.catch(() => undefined);
    try {
      await flush();
      expect(client.hasProviderOwnedTurn()).toBe(true);
      expect(
        collectClientMessages(proc).filter(
          (message) => message.method === 'turn/start',
        ),
      ).toHaveLength(0);

      await completeObservedRootRun(client, 'provider-owned-live');
      const start = await waitForClientRequest(proc, 'turn/start');
      emitServerMessage(proc, {
        id: start.id,
        result: {
          turn: { id: 'turn-after-provider', items: [], status: 'inProgress' },
        },
      });
      completeRootTurn(proc, 'turn-after-provider');
      await expect(nextTurn).resolves.toMatchObject({ status: 'completed' });
    } finally {
      client.dispose();
      await nextTurn.catch(() => undefined);
    }
  });

  it('adopts and completes a provider-owned root run from the retained execution anchor', async () => {
    const events: unknown[] = [];
    const onProviderEventDropped = jest.fn();
    const client = new CodexAppServerClient({
      cwd: '/tmp/repo',
      projectId: 'project',
      worktreeId: 'worktree',
      chatId: 'chat',
      sessionKey: 'project/worktree/chat',
      onEvent: (event): void => {
        events.push(event);
      },
      onProviderEventDropped,
      getWindow: (): null => null,
    });

    try {
      const { turnPromise } = await startActiveTurn(
        client,
        proc,
        [],
        'msg-retained-anchor',
      );
      completeRootTurn(proc);
      await expect(turnPromise).resolves.toMatchObject({
        status: 'completed',
      });
      collectClientMessages(proc);
      events.length = 0;

      await client.handleConnectionNotification('turn/started', {
        params: {
          threadId: 'thread-1',
          turn: { id: 'provider-turn-1', items: [], status: 'inProgress' },
        },
      });
      await client.handleConnectionNotification('turn/completed', {
        params: {
          threadId: 'thread-1',
          turn: {
            id: 'provider-turn-1',
            items: [],
            status: 'completed',
            error: null,
          },
        },
      });

      expect(events).toContainEqual({
        type: 'codex',
        event: {
          type: 'turn.started',
          thread_id: 'thread-1',
          turn_id: 'provider-turn-1',
        },
      });
      expect(events).toContainEqual({
        type: 'codex',
        event: {
          type: 'turn.completed',
          status: 'completed',
          thread_id: 'thread-1',
          turn_id: 'provider-turn-1',
        },
      });
      expect(
        events.filter((candidate): boolean => {
          if (
            !isRecord(candidate) ||
            candidate.type !== 'codex' ||
            !isRecord(candidate.event)
          ) {
            return false;
          }
          return (
            candidate.event.type === 'turn.completed' &&
            candidate.event.turn_id === 'provider-turn-1'
          );
        }),
      ).toHaveLength(1);
      expect(onProviderEventDropped).not.toHaveBeenCalledWith(
        expect.objectContaining({
          gate: 'codex_root_completion_stale',
          providerTurnId: 'provider-turn-1',
        }),
      );
      expect(
        collectClientMessages(proc).filter(
          (message): boolean => message.method === 'turn/start',
        ),
      ).toHaveLength(0);
    } finally {
      client.dispose();
    }
  });

  it('preserves interrupted status on routed subagent turn completions', async () => {
    const events: unknown[] = [];
    const client = createClient(events);
    const { turnPromise } = await startActiveTurn(client, proc);

    emitServerMessage(proc, {
      method: 'turn/completed',
      params: {
        threadId: 'sub-thread-1',
        turn: {
          id: 'sub-turn-1',
          items: [],
          status: 'interrupted',
          error: null,
        },
      },
    });

    expect(events).toContainEqual({
      type: 'codex',
      event: {
        type: 'turn.completed',
        status: 'interrupted',
        thread_id: 'sub-thread-1',
        turn_id: 'sub-turn-1',
      },
    });

    completeRootTurn(proc);
    const result = await turnPromise;
    expect(result.status).toBe('completed');
  });

  it('exposes and observes native background work from raw child and terminal frames', async () => {
    const events: unknown[] = [];
    const client = createClient(events);
    const { turnPromise } = await startActiveTurn(
      client,
      proc,
      [],
      'background-work-anchor',
    );

    try {
      const api = readClientBackgroundApi(client);
      expect(api.hasLiveBackgroundWork).toEqual(expect.any(Function));
      expect(api.getBackgroundSnapshot).toEqual(expect.any(Function));
      expect(api.subscribeBackgroundWork).toEqual(expect.any(Function));
      if (!api.hasLiveBackgroundWork || !api.getBackgroundSnapshot) return;

      await client.handleConnectionNotification('item/started', {
        params: {
          threadId: 'thread-1',
          turnId: 'turn-1',
          item: {
            id: 'subagent-activity',
            type: 'subAgentActivity',
            agentThreadId: 'background-child',
          },
        },
      });
      await client.handleConnectionNotification('item/started', {
        params: {
          threadId: 'background-child',
          turnId: 'background-child-turn',
          item: {
            id: 'background-terminal',
            type: 'commandExecution',
            processId: 'background-process',
            command: 'private command text',
            cwd: '/private/worktree/path',
            status: 'inProgress',
          },
        },
      });

      const liveSnapshot = api.getBackgroundSnapshot();
      expect(api.hasLiveBackgroundWork()).toBe(true);
      expect(readBackgroundWork(liveSnapshot)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: 'child',
            threadId: 'background-child',
          }),
          expect.objectContaining({
            kind: 'terminal',
            threadId: 'background-child',
            processId: 'background-process',
          }),
        ]),
      );

      completeRootTurn(proc);
      await expect(turnPromise).resolves.toMatchObject({ status: 'completed' });
      await flush();

      await client.handleConnectionNotification('item/completed', {
        params: {
          threadId: 'background-child',
          turnId: 'background-child-turn',
          item: {
            id: 'background-terminal',
            type: 'commandExecution',
            processId: 'background-process',
            status: 'completed',
          },
        },
      });
      await client.handleConnectionNotification('thread/status/changed', {
        params: {
          threadId: 'background-child',
          status: { type: 'idle' },
        },
      });

      const terminalListRequests = collectClientMessages(proc).filter(
        (message) => message.method === 'thread/backgroundTerminals/list',
      );
      expect(terminalListRequests).toHaveLength(1);
      const terminalListRequest = terminalListRequests[0];
      if (!terminalListRequest) return;
      emitServerMessage(proc, {
        id: terminalListRequest.id,
        result: { data: [], nextCursor: null },
      });
      await flush();

      expect(api.hasLiveBackgroundWork()).toBe(false);
      expect(readBackgroundWork(api.getBackgroundSnapshot())).toEqual([]);
    } finally {
      client.dispose();
      await turnPromise.catch(() => undefined);
    }
  });

  it('reconciles root terminal pages asynchronously across every cursor', async () => {
    const events: unknown[] = [];
    const client = createClient(events);
    const { turnPromise } = await startActiveTurn(
      client,
      proc,
      [],
      'root-terminal-anchor',
    );
    const api = readClientBackgroundApi(client);

    try {
      await client.handleConnectionNotification('item/started', {
        params: {
          threadId: 'thread-1',
          turnId: 'turn-1',
          item: {
            id: 'root-terminal',
            type: 'commandExecution',
            processId: 'root-process',
            command: 'private command text',
            cwd: '/private/worktree/path',
            status: 'inProgress',
          },
        },
      });

      completeRootTurn(proc);
      await expect(turnPromise).resolves.toMatchObject({ status: 'completed' });
      // The first page is intentionally left unanswered until after the root
      // settles: reconciliation is observational and never owns the turn.
      const firstPageRequests = collectClientMessages(proc).filter(
        (message) => message.method === 'thread/backgroundTerminals/list',
      );
      expect(firstPageRequests).toHaveLength(1);
      const firstPage = firstPageRequests[0];
      if (!firstPage) return;
      expect(api.getBackgroundSnapshot).toEqual(expect.any(Function));
      if (!api.getBackgroundSnapshot) return;
      expect(getRequestParams(firstPage).threadId).toBe('thread-1');

      emitServerMessage(proc, {
        id: firstPage.id,
        result: {
          data: [{ itemId: 'terminal-page-one', processId: 'process-one' }],
          nextCursor: 'cursor-two',
        },
      });
      await flush();
      const secondPageRequests = collectClientMessages(proc).filter(
        (message) => message.method === 'thread/backgroundTerminals/list',
      );
      expect(secondPageRequests).toHaveLength(1);
      const secondPage = secondPageRequests[0];
      if (!secondPage) return;
      expect(getRequestParams(secondPage)).toMatchObject({
        threadId: 'thread-1',
        cursor: 'cursor-two',
      });
      emitServerMessage(proc, {
        id: secondPage.id,
        result: {
          data: [{ itemId: 'terminal-page-two', processId: 'process-two' }],
          nextCursor: null,
        },
      });
      await flush();
      expect(readBackgroundWork(api.getBackgroundSnapshot())).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ itemId: 'terminal-page-one' }),
          expect.objectContaining({ itemId: 'terminal-page-two' }),
        ]),
      );
    } finally {
      client.dispose();
      await turnPromise.catch(() => undefined);
    }
  });

  it('keeps a listed null-process terminal attributed to its originating turn past later roots', async () => {
    const events: unknown[] = [];
    let releaseLateAdmission = (): void => undefined;
    let lateAdmissionStarted = false;
    const lateAdmission = new Promise<void>((resolve) => {
      releaseLateAdmission = resolve;
    });
    const client = new CodexAppServerClient({
      cwd: '/tmp/repo',
      projectId: 'project',
      worktreeId: 'worktree',
      chatId: 'chat',
      sessionKey: 'project/worktree/chat',
      onEvent: (event): void | Promise<void> => {
        events.push(event);
        if (
          isRecord(event) &&
          isRecord(event.event) &&
          event.event.type === 'item.completed' &&
          isRecord(event.event.item) &&
          event.event.item.id === 'original-null-process-terminal'
        ) {
          lateAdmissionStarted = true;
          return lateAdmission;
        }
      },
      getWindow: (): null => null,
    });
    const { turnPromise } = await startActiveTurn(
      client,
      proc,
      [],
      'original-null-process-anchor',
    );
    const api = readClientBackgroundApi(client);

    try {
      await client.handleConnectionNotification('item/started', {
        params: {
          threadId: 'thread-1',
          turnId: 'turn-1',
          item: {
            id: 'original-null-process-terminal',
            type: 'commandExecution',
            processId: null,
            status: 'inProgress',
          },
        },
      });
      completeRootTurn(proc);
      await expect(turnPromise).resolves.toMatchObject({ status: 'completed' });

      await startObservedRootRun(client, 'terminal-list-trigger-turn');
      await client.handleConnectionNotification('item/started', {
        params: {
          threadId: 'thread-1',
          turnId: 'terminal-list-trigger-turn',
          item: {
            id: 'terminal-list-trigger',
            type: 'commandExecution',
            processId: 'terminal-list-trigger-process',
            status: 'inProgress',
          },
        },
      });
      await completeObservedRootRun(client, 'terminal-list-trigger-turn');

      const listMessages = await collectClientMessagesUntil(proc, (messages) =>
        messages.some(
          (message) => message.method === 'thread/backgroundTerminals/list',
        ),
      );
      const listRequest = listMessages.find(
        (message) => message.method === 'thread/backgroundTerminals/list',
      );
      expect(listRequest).toBeDefined();
      if (!listRequest) return;
      expect(api.getBackgroundSnapshot).toEqual(expect.any(Function));
      if (!api.getBackgroundSnapshot) return;
      emitServerMessage(proc, {
        id: listRequest.id,
        result: {
          data: [
            {
              itemId: 'original-null-process-terminal',
              processId: 'listed-original-process',
            },
          ],
          nextCursor: null,
        },
      });
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const snapshot = api.getBackgroundSnapshot();
        if (isRecord(snapshot) && snapshot.reconciling === false) break;
        await flush();
      }
      expect(readBackgroundWork(api.getBackgroundSnapshot())).toContainEqual(
        expect.objectContaining({
          itemId: 'original-null-process-terminal',
          processId: 'listed-original-process',
          spawnedByTurnId: 'turn-1',
        }),
      );

      for (let index = 0; index < 65; index += 1) {
        const turnId = `later-null-process-root-${index}`;
        await startObservedRootRun(client, turnId);
        await completeObservedRootRun(client, turnId);
      }
      const laterListRequests = collectClientMessages(proc).filter(
        (message) =>
          message.method === 'thread/backgroundTerminals/list' &&
          message.id !== listRequest.id,
      );
      for (const request of laterListRequests) {
        emitServerMessage(proc, {
          id: request.id,
          result: {
            data: [
              {
                itemId: 'original-null-process-terminal',
                processId: 'listed-original-process',
              },
            ],
            nextCursor: null,
          },
        });
      }
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const snapshot = api.getBackgroundSnapshot();
        if (isRecord(snapshot) && snapshot.reconciling === false) break;
        await flush();
      }

      const lateNotification = Promise.resolve(
        client.handleConnectionNotification('item/completed', {
          params: {
            threadId: 'thread-1',
            turnId: 'turn-1',
            item: {
              id: 'original-null-process-terminal',
              type: 'commandExecution',
              processId: 'listed-original-process',
              status: 'completed',
              aggregatedOutput: 'late original output',
            },
          },
        }),
      );
      for (
        let attempt = 0;
        attempt < 10 && !lateAdmissionStarted;
        attempt += 1
      ) {
        await flush();
      }
      expect(lateAdmissionStarted).toBe(true);
      const late = events.find(
        (event) => getProviderRunDescriptor(event)?.phase === 'late',
      );
      expect(getProviderRunDescriptor(late)?.executionUserMessageId).toBe(
        'original-null-process-anchor',
      );

      releaseLateAdmission();
      await lateNotification;
    } finally {
      releaseLateAdmission();
      client.dispose();
      await turnPromise.catch(() => undefined);
    }
  });

  it('does not request terminal pages for root completion without process evidence', async () => {
    const client = createClient();
    const { turnPromise } = await startActiveTurn(client, proc);
    try {
      completeRootTurn(proc);
      await expect(turnPromise).resolves.toMatchObject({ status: 'completed' });
      await flush();
      expect(
        collectClientMessages(proc).filter(
          (message) => message.method === 'thread/backgroundTerminals/list',
        ),
      ).toEqual([]);
    } finally {
      client.dispose();
      await turnPromise.catch(() => undefined);
    }
  });

  it('fails root terminal reconciliation without blocking turn settlement', async () => {
    const client = createClient();
    const { turnPromise } = await startActiveTurn(client, proc);
    const api = readClientBackgroundApi(client);

    try {
      await client.handleConnectionNotification('item/started', {
        params: {
          threadId: 'thread-1',
          turnId: 'turn-1',
          item: {
            id: 'root-terminal-failure',
            type: 'commandExecution',
            processId: 'root-process-failure',
            status: 'inProgress',
          },
        },
      });
      completeRootTurn(proc);
      await expect(turnPromise).resolves.toMatchObject({ status: 'completed' });
      const listRequest = collectClientMessages(proc).find(
        (message) => message.method === 'thread/backgroundTerminals/list',
      );
      expect(listRequest).toBeDefined();
      if (!listRequest) return;
      expect(api.getBackgroundSnapshot).toEqual(expect.any(Function));
      if (!api.getBackgroundSnapshot) return;
      emitServerMessage(proc, {
        id: listRequest.id,
        error: { message: 'terminal listing unavailable' },
      });
      await flush();
      const snapshot = api.getBackgroundSnapshot();
      expect(isRecord(snapshot) ? snapshot.reconciling : undefined).toBe(false);
      expect(readBackgroundWork(snapshot)).toContainEqual(
        expect.objectContaining({ itemId: 'root-terminal-failure' }),
      );
    } finally {
      client.dispose();
      await turnPromise.catch(() => undefined);
    }
  });

  it('reconciles terminal pages after a successful resume without waiting for them', async () => {
    const events: unknown[] = [];
    const client = new CodexAppServerClient({
      cwd: '/tmp/repo',
      projectId: 'project',
      worktreeId: 'worktree',
      chatId: 'chat',
      sessionKey: 'project/worktree/chat',
      initialThreadId: 'thread-1',
      initialExecutionUserMessageId: 'resume-anchor',
      onEvent: (event): void => {
        events.push(event);
      },
      getWindow: (): null => null,
    });
    const api = readClientBackgroundApi(client);

    const turnPromise = client.startTurn({
      text: 'Resume',
      cwd: '/tmp/repo',
      model: 'gpt-6-sol',
      thinkingLevel: 'high',
      planMode: false,
      executionUserMessageId: 'resume-anchor',
    });
    try {
      const initialize = await waitForClientRequest(proc, 'initialize');
      emitServerMessage(proc, {
        id: initialize.id,
        result: { userAgent: 'ua', codexHome: '/tmp/.codex' },
      });
      const resume = await waitForClientRequest(proc, 'thread/resume');
      emitServerMessage(proc, {
        id: resume.id,
        result: makeThreadResult('thread-1', [
          {
            id: 'old-turn',
            status: 'inProgress',
            items: [
              {
                id: 'resumed-terminal',
                type: 'commandExecution',
                processId: 'resumed-process',
                status: 'inProgress',
              },
            ],
          },
        ]),
      });
      const resumeRequests = await collectClientMessagesUntil(
        proc,
        (messages) =>
          messages.some(
            (message) => message.method === 'thread/backgroundTerminals/list',
          ) && messages.some((message) => message.method === 'turn/start'),
      );
      const firstPage = resumeRequests.find(
        (message) => message.method === 'thread/backgroundTerminals/list',
      );
      const turnStart = resumeRequests.find(
        (message) => message.method === 'turn/start',
      );
      expect(firstPage).toBeDefined();
      expect(turnStart).toBeDefined();
      if (!firstPage || !turnStart) return;
      expect(api.getBackgroundSnapshot).toEqual(expect.any(Function));
      if (!api.getBackgroundSnapshot) return;
      expect(getRequestParams(firstPage).threadId).toBe('thread-1');

      emitServerMessage(proc, {
        id: turnStart.id,
        result: {
          turn: { id: 'resumed-turn', items: [], status: 'inProgress' },
        },
      });
      completeRootTurn(proc, 'resumed-turn');
      await expect(turnPromise).resolves.toMatchObject({ status: 'completed' });

      emitServerMessage(proc, {
        id: firstPage.id,
        result: {
          data: [{ itemId: 'resume-page-one', processId: 'resume-one' }],
          nextCursor: 'resume-cursor-two',
        },
      });
      await flush();
      const secondPage = collectClientMessages(proc).find(
        (message) => message.method === 'thread/backgroundTerminals/list',
      );
      expect(secondPage).toBeDefined();
      if (!secondPage) return;
      expect(getRequestParams(secondPage).cursor).toBe('resume-cursor-two');
      emitServerMessage(proc, {
        id: secondPage.id,
        result: {
          data: [{ itemId: 'resume-page-two', processId: 'resume-two' }],
          nextCursor: null,
        },
      });
      await flush();
      expect(readBackgroundWork(api.getBackgroundSnapshot())).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ itemId: 'resume-page-one' }),
          expect.objectContaining({ itemId: 'resume-page-two' }),
        ]),
      );
    } finally {
      client.dispose();
      await turnPromise.catch(() => undefined);
    }
  });

  it('does not request terminal pages after resume without background evidence', async () => {
    const client = new CodexAppServerClient({
      cwd: '/tmp/repo',
      projectId: 'project',
      worktreeId: 'worktree',
      chatId: 'chat',
      sessionKey: 'project/worktree/chat',
      initialThreadId: 'thread-1',
      initialExecutionUserMessageId: 'resume-without-evidence-anchor',
      onEvent: jest.fn(),
      getWindow: (): null => null,
    });
    const turnPromise = client.startTurn({
      text: 'Resume without background work',
      cwd: '/tmp/repo',
      model: 'gpt-6-sol',
      thinkingLevel: 'high',
      planMode: false,
      executionUserMessageId: 'resume-without-evidence-anchor',
    });

    try {
      const initialize = await waitForClientRequest(proc, 'initialize');
      emitServerMessage(proc, {
        id: initialize.id,
        result: { userAgent: 'ua', codexHome: '/tmp/.codex' },
      });
      const resume = await waitForClientRequest(proc, 'thread/resume');
      emitServerMessage(proc, {
        id: resume.id,
        result: makeThreadResult('thread-1'),
      });
      const messages = await collectClientMessagesUntil(proc, (collected) =>
        collected.some((message) => message.method === 'turn/start'),
      );
      const turnStart = messages.find(
        (message) => message.method === 'turn/start',
      );
      expect(
        messages.filter(
          (message) => message.method === 'thread/backgroundTerminals/list',
        ),
      ).toEqual([]);
      expect(turnStart).toBeDefined();
      if (!turnStart) return;

      emitServerMessage(proc, {
        id: turnStart.id,
        result: {
          turn: {
            id: 'resume-without-evidence-turn',
            items: [],
            status: 'inProgress',
          },
        },
      });
      completeRootTurn(proc, 'resume-without-evidence-turn');
      await expect(turnPromise).resolves.toMatchObject({ status: 'completed' });
      expect(
        collectClientMessages(proc).filter(
          (message) => message.method === 'thread/backgroundTerminals/list',
        ),
      ).toEqual([]);
    } finally {
      client.dispose();
      await turnPromise.catch(() => undefined);
    }
  });

  it('clears failed resume reconciliation while retaining terminal evidence', async () => {
    const client = new CodexAppServerClient({
      cwd: '/tmp/repo',
      projectId: 'project',
      worktreeId: 'worktree',
      chatId: 'chat',
      sessionKey: 'project/worktree/chat',
      initialThreadId: 'thread-1',
      initialExecutionUserMessageId: 'resume-failure-anchor',
      onEvent: jest.fn(),
      getWindow: (): null => null,
    });
    const api = readClientBackgroundApi(client);

    const turnPromise = client.startTurn({
      text: 'Resume',
      cwd: '/tmp/repo',
      model: 'gpt-6-sol',
      thinkingLevel: 'high',
      planMode: false,
      executionUserMessageId: 'resume-failure-anchor',
    });
    try {
      const initialize = await waitForClientRequest(proc, 'initialize');
      emitServerMessage(proc, {
        id: initialize.id,
        result: { userAgent: 'ua', codexHome: '/tmp/.codex' },
      });
      const resume = await waitForClientRequest(proc, 'thread/resume');
      emitServerMessage(proc, {
        id: resume.id,
        result: makeThreadResult('thread-1', [
          {
            id: 'old-turn',
            status: 'inProgress',
            items: [
              {
                id: 'resumed-terminal-failure',
                type: 'commandExecution',
                processId: 'resumed-process-failure',
                status: 'inProgress',
              },
            ],
          },
        ]),
      });
      const resumeRequests = await collectClientMessagesUntil(
        proc,
        (messages) =>
          messages.some(
            (message) => message.method === 'thread/backgroundTerminals/list',
          ) && messages.some((message) => message.method === 'turn/start'),
      );
      const firstPage = resumeRequests.find(
        (message) => message.method === 'thread/backgroundTerminals/list',
      );
      const turnStart = resumeRequests.find(
        (message) => message.method === 'turn/start',
      );
      expect(firstPage).toBeDefined();
      expect(turnStart).toBeDefined();
      if (!firstPage || !turnStart) return;
      expect(api.getBackgroundSnapshot).toEqual(expect.any(Function));
      if (!api.getBackgroundSnapshot) return;
      emitServerMessage(proc, {
        id: turnStart.id,
        result: {
          turn: { id: 'resume-failed-turn', items: [], status: 'inProgress' },
        },
      });
      completeRootTurn(proc, 'resume-failed-turn');
      await expect(turnPromise).resolves.toMatchObject({ status: 'completed' });
      emitServerMessage(proc, {
        id: firstPage.id,
        error: { message: 'resume terminal listing unavailable' },
      });
      await flush();
      const snapshot = api.getBackgroundSnapshot();
      expect(isRecord(snapshot) ? snapshot.reconciling : undefined).toBe(false);
      expect(readBackgroundWork(snapshot)).toContainEqual(
        expect.objectContaining({ itemId: 'resumed-terminal-failure' }),
      );
    } finally {
      client.dispose();
      await turnPromise.catch(() => undefined);
    }
  });

  it('keeps a resumed terminal from a closed turn in the background when listing fails', async () => {
    const client = new CodexAppServerClient({
      cwd: '/tmp/repo',
      projectId: 'project',
      worktreeId: 'worktree',
      chatId: 'chat',
      sessionKey: 'project/worktree/chat',
      initialThreadId: 'thread-1',
      initialExecutionUserMessageId: 'resume-closed-anchor',
      onEvent: jest.fn(),
      getWindow: (): null => null,
    });
    const api = readClientBackgroundApi(client);

    const turnPromise = client.startTurn({
      text: 'Resume',
      cwd: '/tmp/repo',
      model: 'gpt-6-sol',
      thinkingLevel: 'high',
      planMode: false,
      executionUserMessageId: 'resume-closed-anchor',
    });
    try {
      const initialize = await waitForClientRequest(proc, 'initialize');
      emitServerMessage(proc, {
        id: initialize.id,
        result: { userAgent: 'ua', codexHome: '/tmp/.codex' },
      });
      const resume = await waitForClientRequest(proc, 'thread/resume');
      emitServerMessage(proc, {
        id: resume.id,
        result: makeThreadResult('thread-1', [
          {
            id: 'closed-turn',
            status: 'completed',
            items: [
              {
                id: 'resumed-closed-terminal',
                type: 'commandExecution',
                processId: 'resumed-closed-process',
                status: 'inProgress',
              },
            ],
          },
        ]),
      });
      const resumeRequests = await collectClientMessagesUntil(
        proc,
        (messages) =>
          messages.some(
            (message) => message.method === 'thread/backgroundTerminals/list',
          ) && messages.some((message) => message.method === 'turn/start'),
      );
      const firstPage = resumeRequests.find(
        (message) => message.method === 'thread/backgroundTerminals/list',
      );
      const turnStart = resumeRequests.find(
        (message) => message.method === 'turn/start',
      );
      expect(firstPage).toBeDefined();
      expect(turnStart).toBeDefined();
      if (!firstPage || !turnStart) return;
      expect(api.getBackgroundSnapshot).toEqual(expect.any(Function));
      if (!api.getBackgroundSnapshot) return;
      emitServerMessage(proc, {
        id: firstPage.id,
        error: { message: 'resume terminal listing unavailable' },
      });
      await flush();
      // The turn that started it already closed, so the command is background
      // work even before (or without) Codex listing it.
      const snapshot = api.getBackgroundSnapshot();
      expect(readBackgroundWork(snapshot)).toContainEqual(
        expect.objectContaining({ itemId: 'resumed-closed-terminal' }),
      );
      expect(readBackgroundWork(snapshot)).not.toContainEqual(
        expect.objectContaining({
          itemId: 'resumed-closed-terminal',
          foreground: true,
        }),
      );
      emitServerMessage(proc, {
        id: turnStart.id,
        result: {
          turn: {
            id: 'resume-closed-new-turn',
            items: [],
            status: 'inProgress',
          },
        },
      });
      completeRootTurn(proc, 'resume-closed-new-turn');
      await expect(turnPromise).resolves.toMatchObject({ status: 'completed' });
    } finally {
      client.dispose();
      await turnPromise.catch(() => undefined);
    }
  });

  it('retires background work on process failure with privacy-safe abandonment diagnostics', async () => {
    mockLogMainProcessWarn.mockClear();
    const client = new CodexAppServerClient({
      cwd: '/tmp/repo',
      projectId: 'project',
      worktreeId: 'worktree',
      chatId: 'chat',
      sessionKey: 'project/worktree/chat',
      initialThreadId: 'thread-1',
      onEvent: jest.fn(),
      getWindow: (): null => null,
    });
    const api = readClientBackgroundApi(client);
    expect(api.getBackgroundSnapshot).toEqual(expect.any(Function));
    if (!api.getBackgroundSnapshot) {
      client.dispose();
      return;
    }

    try {
      await client.handleConnectionNotification('item/started', {
        params: {
          threadId: 'thread-1',
          turnId: 'turn-1',
          item: {
            id: 'private-terminal',
            type: 'commandExecution',
            processId: 'private-process',
            command: 'secret command body',
            cwd: '/Users/private/path',
            status: 'inProgress',
          },
        },
      });
      const before = api.getBackgroundSnapshot();
      expect(readBackgroundWork(before)).toHaveLength(1);
      client.markProcessFailed();
      const after = api.getBackgroundSnapshot();
      expect(isRecord(before) ? before.epoch : undefined).not.toBe(
        isRecord(after) ? after.epoch : undefined,
      );
      expect(api.hasLiveBackgroundWork?.()).toBe(false);
      expect(readBackgroundWork(after)).toEqual([]);
      const diagnosticText = JSON.stringify(mockLogMainProcessWarn.mock.calls);
      expect(diagnosticText).toContain('codex_background_work_abandoned');
      expect(diagnosticText).not.toContain('secret command body');
      expect(diagnosticText).not.toContain('/Users/private/path');
    } finally {
      client.dispose();
    }
  });

  it('keeps an original terminal run anchored past 64 later roots until late output is admitted', async () => {
    const events: unknown[] = [];
    let releaseLateAdmission = (): void => undefined;
    let lateAdmissionStarted = false;
    const lateAdmission = new Promise<void>((resolve) => {
      releaseLateAdmission = resolve;
    });
    const client = new CodexAppServerClient({
      cwd: '/tmp/repo',
      projectId: 'project',
      worktreeId: 'worktree',
      chatId: 'chat',
      sessionKey: 'project/worktree/chat',
      onEvent: (event): void | Promise<void> => {
        events.push(event);
        if (
          isRecord(event) &&
          isRecord(event.event) &&
          event.event.type === 'item.completed' &&
          isRecord(event.event.item) &&
          event.event.item.id === 'original-background-terminal'
        ) {
          lateAdmissionStarted = true;
          return lateAdmission;
        }
      },
      getWindow: (): null => null,
    });
    const { turnPromise } = await startActiveTurn(
      client,
      proc,
      [],
      'original-background-anchor',
    );
    const api = readClientBackgroundApi(client);

    try {
      await client.handleConnectionNotification('item/started', {
        params: {
          threadId: 'thread-1',
          turnId: 'turn-1',
          item: {
            id: 'original-background-terminal',
            type: 'commandExecution',
            processId: 'original-background-process',
            command: 'private command text',
            cwd: '/private/worktree/path',
            status: 'inProgress',
          },
        },
      });
      completeRootTurn(proc);
      await expect(turnPromise).resolves.toMatchObject({ status: 'completed' });
      const terminalListRequest = collectClientMessages(proc).find(
        (message) => message.method === 'thread/backgroundTerminals/list',
      );
      expect(terminalListRequest).toBeDefined();
      if (!terminalListRequest) return;
      expect(api.getBackgroundSnapshot).toEqual(expect.any(Function));
      if (!api.getBackgroundSnapshot) return;
      emitServerMessage(proc, {
        id: terminalListRequest.id,
        result: {
          data: [
            {
              itemId: 'original-background-terminal',
              processId: 'original-background-process',
            },
          ],
          nextCursor: null,
        },
      });
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const snapshot = api.getBackgroundSnapshot();
        if (isRecord(snapshot) && snapshot.reconciling === false) break;
        await flush();
      }
      expect(readBackgroundWork(api.getBackgroundSnapshot())).toContainEqual(
        expect.objectContaining({
          itemId: 'original-background-terminal',
          processId: 'original-background-process',
        }),
      );
      const reconciledSnapshot = api.getBackgroundSnapshot();
      expect(
        isRecord(reconciledSnapshot)
          ? reconciledSnapshot.reconciling
          : undefined,
      ).toBe(false);

      for (let index = 0; index < 65; index += 1) {
        const turnId = `later-provider-root-${index}`;
        await startObservedRootRun(client, turnId);
        await completeObservedRootRun(client, turnId);
      }
      const laterTerminalListRequests = collectClientMessages(proc).filter(
        (message) => message.method === 'thread/backgroundTerminals/list',
      );
      for (const request of laterTerminalListRequests) {
        emitServerMessage(proc, {
          id: request.id,
          result: {
            data: [
              {
                itemId: 'original-background-terminal',
                processId: 'original-background-process',
              },
            ],
            nextCursor: null,
          },
        });
      }
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const snapshot = api.getBackgroundSnapshot();
        if (isRecord(snapshot) && snapshot.reconciling === false) break;
        await flush();
      }
      const lateNotification = Promise.resolve(
        client.handleConnectionNotification('item/completed', {
          params: {
            threadId: 'thread-1',
            turnId: 'turn-1',
            item: {
              id: 'original-background-terminal',
              type: 'commandExecution',
              processId: 'original-background-process',
              status: 'completed',
              aggregatedOutput: 'late original output',
            },
          },
        }),
      );
      for (
        let attempt = 0;
        attempt < 10 && !lateAdmissionStarted;
        attempt += 1
      ) {
        await flush();
      }
      expect(lateAdmissionStarted).toBe(true);
      expect(api.hasLiveBackgroundWork?.()).toBe(false);
      const late = events.find(
        (event) => getProviderRunDescriptor(event)?.phase === 'late',
      );
      expect(getProviderRunDescriptor(late)?.executionUserMessageId).toBe(
        'original-background-anchor',
      );
      expect(classifyProviderRunEvent(late).kind).toBe('transcript_only');

      releaseLateAdmission();
      await lateNotification;
      await flush();
      expect(classifyProviderRunEvent(late)).toEqual({
        kind: 'reject',
        reason: 'unknown_run',
      });
    } finally {
      releaseLateAdmission();
      client.dispose();
      await turnPromise.catch(() => undefined);
    }
  });

  it('keeps an unanchored provider wake descriptorless without swallowing its items', async () => {
    const events: unknown[] = [];
    const drops = jest.fn();
    const client = new CodexAppServerClient({
      cwd: '/tmp/repo',
      projectId: 'project',
      worktreeId: 'worktree',
      chatId: 'chat',
      sessionKey: 'project/worktree/chat',
      initialThreadId: 'thread-1',
      getWindow: () => null,
      onEvent: (event) => {
        events.push(event);
      },
      onProviderEventDropped: drops,
    });
    try {
      await startObservedRootRun(client, 'unanchored-wake');
      await client.handleConnectionNotification('item/completed', {
        params: {
          threadId: 'thread-1',
          turnId: 'unanchored-wake',
          item: {
            type: 'agentMessage',
            id: 'wake-text',
            text: 'legacy output',
          },
        },
      });
      expect(client.hasActiveTurn()).toBe(false);
      expect(JSON.stringify(events)).toContain('legacy output');
      expect(
        events.every((event) => getProviderRunDescriptor(event) === undefined),
      ).toBe(true);
      expect(drops).toHaveBeenCalledWith(
        expect.objectContaining({ reason: 'no_execution_anchor' }),
      );
    } finally {
      client.dispose();
    }
  });

  it('adopts a provider wake on a recreated client using its retained bound anchor', async () => {
    const events: unknown[] = [];
    const client = new CodexAppServerClient({
      cwd: '/tmp/repo',
      projectId: 'project',
      worktreeId: 'worktree',
      chatId: 'chat',
      sessionKey: 'project/worktree/chat',
      initialThreadId: 'thread-1',
      initialExecutionUserMessageId: 'retained-anchor',
      getWindow: () => null,
      onEvent: (event) => {
        events.push(event);
      },
    });
    try {
      await startObservedRootRun(client, 'recreated-wake');
      expect(client.hasProviderOwnedTurn()).toBe(true);
      expect(getProviderRunDescriptor(events[0])?.executionUserMessageId).toBe(
        'retained-anchor',
      );
      await completeObservedRootRun(client, 'recreated-wake');
      expect(client.hasActiveTurn()).toBe(false);
    } finally {
      client.dispose();
    }
  });

  it('accepts an anchored dispatched terminal read before its start response continuation', async () => {
    const events: unknown[] = [];
    const client = createClient(events);
    const result = client.startTurn({
      text: 'Run',
      cwd: '/tmp/repo',
      model: 'gpt-6-sol',
      thinkingLevel: 'high',
      planMode: false,
      executionUserMessageId: 'same-read-anchor',
    });
    try {
      const initialize = await waitForClientRequest(proc, 'initialize');
      emitServerMessage(proc, {
        id: initialize.id,
        result: { userAgent: 'ua', codexHome: '/tmp/.codex' },
      });
      const thread = await waitForClientRequest(proc, 'thread/start');
      emitServerMessage(proc, {
        id: thread.id,
        result: makeThreadResult('thread-1'),
      });
      const start = await waitForClientRequest(proc, 'turn/start');
      emitServerMessage(proc, {
        id: start.id,
        result: {
          turn: { id: 'same-read-turn', items: [], status: 'inProgress' },
        },
      });
      completeRootTurn(proc, 'same-read-turn');
      await expect(result).resolves.toMatchObject({ status: 'completed' });
      const terminal = events.find(
        (event) =>
          isRecord(event) &&
          isRecord(event.event) &&
          event.event.type === 'turn.completed',
      );
      const classified = classifyProviderRunEvent(terminal);
      expect(classified.kind).toBe('ordinary');
      if (classified.kind === 'ordinary')
        expect(classified.run?.executionUserMessageId).toBe('same-read-anchor');
    } finally {
      client.dispose();
      await result.catch(() => undefined);
    }
  });

  it('retires late reconciliation authority across transport replacement without settling its successor', async () => {
    const events: unknown[] = [];
    const client = new CodexAppServerClient({
      cwd: '/tmp/repo',
      projectId: 'project',
      worktreeId: 'worktree',
      chatId: 'chat',
      sessionKey: 'project/worktree/chat',
      initialThreadId: 'thread-1',
      initialExecutionUserMessageId: 'retained-anchor',
      getWindow: () => null,
      onEvent: (event) => {
        events.push(event);
      },
    });
    try {
      await startObservedRootRun(client, 'old-owned-run', 'thread-1', [
        {
          type: 'userMessage',
          clientId: 'retained-anchor',
        },
      ]);
      await client.handleConnectionNotification('item/started', {
        params: {
          threadId: 'thread-1',
          turnId: 'old-owned-run',
          item: {
            id: 'cmd',
            type: 'commandExecution',
            command: 'printf output',
            cwd: '/tmp/repo',
            status: 'inProgress',
            commandActions: [],
            aggregatedOutput: '',
            exitCode: null,
          },
        },
      });
      await completeObservedRootRun(client, 'old-owned-run');
      await client.handleConnectionNotification('item/completed', {
        params: {
          threadId: 'thread-1',
          turnId: 'old-owned-run',
          item: {
            id: 'cmd',
            type: 'commandExecution',
            command: 'printf output',
            cwd: '/tmp/repo',
            status: 'completed',
            commandActions: [],
            aggregatedOutput: 'exact output',
            exitCode: 0,
          },
        },
      });
      const late = events.find(
        (event) => getProviderRunDescriptor(event)?.phase === 'late',
      );
      expect(classifyProviderRunEvent(late).kind).toBe('transcript_only');
      client.markProcessSuspended();
      expect(classifyProviderRunEvent(late)).toEqual({
        kind: 'reject',
        reason: 'retired_generation',
      });
      await startObservedRootRun(client, 'successor');
      await completeObservedRootRun(client, 'old-owned-run');
      expect(client.hasProviderOwnedTurn()).toBe(true);
      await completeObservedRootRun(client, 'successor');
      expect(client.hasActiveTurn()).toBe(false);
    } finally {
      client.dispose();
    }
  });

  it('does not treat a duplicate provider-owned root start as a second run', async () => {
    const events: unknown[] = [];
    const client = createClient(events);
    const { turnPromise } = await startActiveTurn(
      client,
      proc,
      [],
      'msg-retained-anchor',
    );
    completeRootTurn(proc);
    await expect(turnPromise).resolves.toMatchObject({ status: 'completed' });
    collectClientMessages(proc);
    events.length = 0;

    try {
      await startObservedRootRun(client, 'provider-turn-2');
      await startObservedRootRun(client, 'provider-turn-2');

      expect(
        events.filter((candidate): boolean => {
          if (
            !isRecord(candidate) ||
            candidate.type !== 'codex' ||
            !isRecord(candidate.event)
          ) {
            return false;
          }
          return (
            candidate.event.type === 'turn.started' &&
            candidate.event.thread_id === 'thread-1' &&
            candidate.event.turn_id === 'provider-turn-2'
          );
        }),
      ).toHaveLength(1);
    } finally {
      client.dispose();
    }
  });

  it('consumes a provider-owned root terminal exactly once', async () => {
    const events: unknown[] = [];
    const client = createClient(events);
    const { turnPromise } = await startActiveTurn(
      client,
      proc,
      [],
      'msg-retained-anchor',
    );
    completeRootTurn(proc);
    await expect(turnPromise).resolves.toMatchObject({ status: 'completed' });
    collectClientMessages(proc);
    events.length = 0;

    try {
      await startObservedRootRun(client, 'provider-turn-2');
      await completeObservedRootRun(client, 'provider-turn-2');
      await completeObservedRootRun(client, 'provider-turn-2');

      expect(
        events.filter((candidate): boolean => {
          if (
            !isRecord(candidate) ||
            candidate.type !== 'codex' ||
            !isRecord(candidate.event)
          ) {
            return false;
          }
          return (
            candidate.event.type === 'turn.completed' &&
            candidate.event.thread_id === 'thread-1' &&
            candidate.event.turn_id === 'provider-turn-2'
          );
        }),
      ).toHaveLength(1);
    } finally {
      client.dispose();
    }
  });

  it('keeps child completions separate and ignores an old terminal while a newer root is active', async () => {
    const events: unknown[] = [];
    const client = createClient(events);
    const { turnPromise } = await startActiveTurn(
      client,
      proc,
      [],
      'msg-retained-anchor',
    );
    completeRootTurn(proc);
    await expect(turnPromise).resolves.toMatchObject({ status: 'completed' });
    collectClientMessages(proc);
    events.length = 0;

    try {
      await startObservedRootRun(client, 'provider-turn-2');
      await startObservedRootRun(client, 'child-turn-1', 'child-thread-1');
      await completeObservedRootRun(
        client,
        'child-turn-1',
        'completed',
        'child-thread-1',
      );
      await completeObservedRootRun(client, 'provider-turn-2');

      await startObservedRootRun(client, 'provider-turn-3');
      await completeObservedRootRun(client, 'provider-turn-2');
      expect(
        events.filter((candidate): boolean => {
          if (
            !isRecord(candidate) ||
            candidate.type !== 'codex' ||
            !isRecord(candidate.event)
          ) {
            return false;
          }
          return (
            candidate.event.type === 'turn.completed' &&
            candidate.event.thread_id === 'thread-1' &&
            candidate.event.turn_id === 'provider-turn-3'
          );
        }),
      ).toHaveLength(0);
      await completeObservedRootRun(client, 'provider-turn-3');

      expect(events).toContainEqual({
        type: 'codex',
        event: {
          type: 'turn.completed',
          status: 'completed',
          thread_id: 'child-thread-1',
          turn_id: 'child-turn-1',
        },
      });
      for (const turnId of ['provider-turn-2', 'provider-turn-3']) {
        expect(
          events.filter((candidate): boolean => {
            if (
              !isRecord(candidate) ||
              candidate.type !== 'codex' ||
              !isRecord(candidate.event)
            ) {
              return false;
            }
            return (
              candidate.event.type === 'turn.completed' &&
              candidate.event.thread_id === 'thread-1' &&
              candidate.event.turn_id === turnId
            );
          }),
        ).toHaveLength(1);
      }
    } finally {
      client.dispose();
    }
  });

  it('settles a matching interrupted provider-owned root once without canceling its successor', async () => {
    const events: unknown[] = [];
    const client = createClient(events);
    const { turnPromise } = await startActiveTurn(
      client,
      proc,
      [],
      'msg-retained-anchor',
    );
    completeRootTurn(proc);
    await expect(turnPromise).resolves.toMatchObject({ status: 'completed' });
    collectClientMessages(proc);
    events.length = 0;

    try {
      await startObservedRootRun(client, 'provider-turn-cancelled');
      await completeObservedRootRun(
        client,
        'provider-turn-cancelled',
        'interrupted',
      );
      await completeObservedRootRun(
        client,
        'provider-turn-cancelled',
        'interrupted',
      );
      await startObservedRootRun(client, 'provider-turn-successor');
      await completeObservedRootRun(
        client,
        'provider-turn-cancelled',
        'interrupted',
      );
      await completeObservedRootRun(client, 'provider-turn-successor');

      expect(events).toContainEqual({
        type: 'codex',
        event: {
          type: 'turn.completed',
          status: 'interrupted',
          thread_id: 'thread-1',
          turn_id: 'provider-turn-cancelled',
        },
      });
      for (const turnId of [
        'provider-turn-cancelled',
        'provider-turn-successor',
      ]) {
        expect(
          events.filter((candidate): boolean => {
            if (
              !isRecord(candidate) ||
              candidate.type !== 'codex' ||
              !isRecord(candidate.event)
            ) {
              return false;
            }
            return (
              candidate.event.type === 'turn.completed' &&
              candidate.event.thread_id === 'thread-1' &&
              candidate.event.turn_id === turnId
            );
          }),
        ).toHaveLength(1);
      }
    } finally {
      client.dispose();
    }
  });

  it('forwards late subagent turn completions after the root turn settles', async () => {
    const events: unknown[] = [];
    const client = createClient(events);
    const { turnPromise } = await startActiveTurn(client, proc);

    completeRootTurn(proc);
    const result = await turnPromise;
    expect(result.status).toBe('completed');

    emitServerMessage(proc, {
      method: 'turn/completed',
      params: {
        threadId: 'sub-thread-1',
        turn: {
          id: 'sub-turn-1',
          items: [],
          status: 'failed',
          error: { message: 'Late subagent failure' },
        },
      },
    });

    expect(events).toContainEqual({
      type: 'codex',
      event: {
        type: 'turn.failed',
        thread_id: 'sub-thread-1',
        turn_id: 'sub-turn-1',
        error: { message: 'Late subagent failure' },
      },
    });
  });

  it('forwards completion-only subagent items after the root turn settles', async () => {
    const events: unknown[] = [];
    const client = createClient(events);
    const { turnPromise } = await startActiveTurn(client, proc);

    emitServerMessage(proc, {
      method: 'item/completed',
      params: {
        threadId: 'sub-thread-1',
        turnId: 'sub-turn-1',
        item: {
          type: 'agentMessage',
          id: 'msg-sub-before-root',
          text: 'Already emitted subagent text',
          phase: 'commentary',
        },
      },
    });
    completeRootTurn(proc);
    await expect(turnPromise).resolves.toMatchObject({ status: 'completed' });

    emitServerMessage(proc, {
      method: 'turn/completed',
      params: {
        threadId: 'sub-thread-1',
        turn: {
          id: 'sub-turn-1',
          items: [
            {
              type: 'agentMessage',
              id: 'msg-sub-before-root',
              text: 'Already emitted subagent text',
              phase: 'commentary',
            },
            {
              type: 'agentMessage',
              id: 'msg-sub-late',
              text: 'Late subagent result',
              phase: 'final_answer',
            },
          ],
          status: 'completed',
          error: null,
        },
      },
    });

    expect(events).toContainEqual({
      type: 'codex',
      event: {
        type: 'item.completed',
        thread_id: 'sub-thread-1',
        turn_id: 'sub-turn-1',
        item: {
          type: 'agent_message',
          id: 'msg-sub-late',
          text: 'Late subagent result',
          phase: 'final_answer',
        },
      },
    });
    expect(
      events.filter((event): boolean => {
        if (!isRecord(event) || event.type !== 'codex') {
          return false;
        }
        const codexEvent = event.event;
        if (!isRecord(codexEvent) || codexEvent.type !== 'item.completed') {
          return false;
        }
        const item = codexEvent.item;
        return isRecord(item) && item.id === 'msg-sub-before-root';
      }),
    ).toHaveLength(1);
  });

  it('does not extract proposed plans from deferred subagent messages', async () => {
    const events: unknown[] = [];
    const client = createClient(events);
    const { turnPromise } = await startActiveTurn(client, proc);

    emitServerMessage(proc, {
      method: 'item/agentMessage/delta',
      params: {
        threadId: 'sub-thread-1',
        turnId: 'sub-turn-1',
        itemId: 'msg-sub-plan',
        delta: '<proposed_plan>Subagent-only plan</proposed_plan>',
      },
    });
    completeRootTurn(proc);

    const result = await turnPromise;

    expect(result.status).toBe('completed');
    expect(result.proposedPlanText).toBeUndefined();
    expect(events).toContainEqual({
      type: 'codex',
      event: {
        type: 'item.completed',
        thread_id: 'sub-thread-1',
        turn_id: 'sub-turn-1',
        item: {
          id: 'msg-sub-plan',
          type: 'agent_message',
          text: '<proposed_plan>Subagent-only plan</proposed_plan>',
        },
      },
    });
  });

  it('forwards subagent command output deltas with non-root turn ids while filtering stale root deltas', async () => {
    const events: unknown[] = [];
    const client = createClient(events);
    const { turnPromise } = await startActiveTurn(client, proc);

    emitServerMessage(proc, {
      method: 'item/commandExecution/outputDelta',
      params: {
        threadId: 'sub-thread-1',
        turnId: 'sub-turn-1',
        itemId: 'cmd-sub-1',
        delta: 'subagent output',
      },
    });
    emitServerMessage(proc, {
      method: 'item/commandExecution/outputDelta',
      params: {
        threadId: 'thread-1',
        turnId: 'stale-root-turn',
        itemId: 'cmd-root-stale',
        delta: 'stale root output',
      },
    });
    completeRootTurn(proc);

    await turnPromise;

    expect(events).toContainEqual({
      type: 'codex',
      event: {
        type: 'item.updated',
        thread_id: 'sub-thread-1',
        turn_id: 'sub-turn-1',
        item: {
          type: 'command_execution',
          id: 'cmd-sub-1',
          command: '',
          aggregated_output: 'subagent output',
          status: 'in_progress',
          exit_code: null,
        },
      },
    });
    const hasStaleRootUpdate = events.some((event): boolean => {
      if (!isRecord(event) || event.type !== 'codex') {
        return false;
      }
      const codexEvent = event.event;
      if (!isRecord(codexEvent) || codexEvent.type !== 'item.updated') {
        return false;
      }
      const item = codexEvent.item;
      return isRecord(item) && item.id === 'cmd-root-stale';
    });
    expect(hasStaleRootUpdate).toBe(false);
  });

  it('forwards subagent thread started events without replacing the root thread id', async () => {
    const events: unknown[] = [];
    const client = createClient(events);
    const { turnPromise } = await startActiveTurn(client, proc);

    emitServerMessage(proc, {
      method: 'thread/started',
      params: {
        thread: {
          id: 'sub-thread-1',
          preview: '',
          ephemeral: false,
          modelProvider: 'openai',
          createdAt: 1,
          updatedAt: 1,
          status: { type: 'idle' },
          path: null,
          cwd: '/tmp/repo',
          cliVersion: '0.114.0',
          source: {
            subAgent: {
              parentThreadId: 'thread-1',
              agentToolCallId: 'agent-call-1',
            },
          },
          agentNickname: 'Scout',
          agentRole: 'explorer',
          gitInfo: null,
          name: null,
          turns: [],
        },
      },
    });
    emitServerMessage(proc, {
      method: 'item/commandExecution/outputDelta',
      params: {
        threadId: 'sub-thread-1',
        turnId: 'sub-turn-1',
        itemId: 'cmd-sub-1',
        delta: 'still grouped as subagent',
      },
    });
    completeRootTurn(proc);

    await turnPromise;

    expect(events).toContainEqual({
      type: 'codex',
      event: {
        type: 'thread.started',
        thread_id: 'sub-thread-1',
        agent_nickname: 'Scout',
        agent_role: 'explorer',
        source: {
          subAgent: {
            parentThreadId: 'thread-1',
            agentToolCallId: 'agent-call-1',
          },
        },
      },
    });
    expect(events).toContainEqual({
      type: 'codex',
      event: {
        type: 'item.updated',
        thread_id: 'sub-thread-1',
        turn_id: 'sub-turn-1',
        item: {
          type: 'command_execution',
          id: 'cmd-sub-1',
          command: '',
          aggregated_output: 'still grouped as subagent',
          status: 'in_progress',
          exit_code: null,
        },
      },
    });
  });

  it('forwards subagent nicknames from nested thread source metadata', async () => {
    const events: unknown[] = [];
    const client = createClient(events);
    const { turnPromise } = await startActiveTurn(client, proc);

    emitServerMessage(proc, {
      method: 'thread/started',
      params: {
        thread: {
          id: 'sub-thread-2',
          preview: '',
          ephemeral: false,
          modelProvider: 'openai',
          createdAt: 1,
          updatedAt: 1,
          status: { type: 'idle' },
          path: null,
          cwd: '/tmp/repo',
          cliVersion: '0.114.0',
          source: {
            subAgent: {
              thread_spawn: {
                parent_thread_id: 'thread-1',
                depth: 1,
                agent_path: null,
                agent_nickname: 'Scout',
                agent_role: 'explorer',
              },
            },
          },
          agentNickname: null,
          agentRole: null,
          gitInfo: null,
          name: null,
          turns: [],
        },
      },
    });
    completeRootTurn(proc);

    await turnPromise;

    expect(events).toContainEqual({
      type: 'codex',
      event: {
        type: 'thread.started',
        thread_id: 'sub-thread-2',
        agent_nickname: 'Scout',
        agent_role: 'explorer',
        source: {
          subAgent: {
            thread_spawn: {
              parent_thread_id: 'thread-1',
              depth: 1,
              agent_path: null,
              agent_nickname: 'Scout',
              agent_role: 'explorer',
            },
          },
        },
      },
    });
  });

  it('streams command execution output deltas into item updates', async () => {
    const events: unknown[] = [];
    const client = new CodexAppServerClient({
      cwd: '/tmp/repo',
      projectId: 'project',
      worktreeId: 'worktree',
      chatId: 'chat',
      sessionKey: 'project/worktree/chat',
      onEvent: (event): void => {
        events.push(event);
      },
      getWindow: (): null => null,
    });

    const turnPromise = client.startTurn({
      text: 'Run a command',
      cwd: '/tmp/repo',
      model: 'gpt-6-sol',
      thinkingLevel: 'high',
      planMode: false,
    });

    await flush();
    emitServerMessage(proc, {
      id: 1,
      result: { userAgent: 'ua', codexHome: '/tmp/.codex' },
    });
    await flush();
    emitServerMessage(proc, {
      id: 2,
      result: {
        thread: {
          id: 'thread-1',
          preview: '',
          ephemeral: false,
          modelProvider: 'openai',
          createdAt: 1,
          updatedAt: 1,
          status: { type: 'idle' },
          path: null,
          cwd: '/tmp/repo',
          cliVersion: '0.114.0',
          source: 'vscode',
          agentNickname: null,
          agentRole: null,
          gitInfo: null,
          name: null,
          turns: [],
        },
        model: 'gpt-6-sol',
        modelProvider: 'openai',
        serviceTier: null,
        cwd: '/tmp/repo',
        approvalPolicy: 'never',
        sandbox: { type: 'dangerFullAccess' },
        reasoningEffort: 'high',
      },
    });
    await flush();
    emitServerMessage(proc, {
      id: 3,
      result: {
        turn: { id: 'turn-1', items: [], status: 'inProgress', error: null },
      },
    });
    emitServerMessage(proc, {
      method: 'item/started',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        item: {
          type: 'commandExecution',
          id: 'cmd-1',
          command: 'npm test',
          cwd: '/tmp/repo',
          processId: 'proc-1',
          status: 'inProgress',
          commandActions: [],
          aggregatedOutput: '',
          exitCode: null,
          durationMs: null,
        },
      },
    });
    emitServerMessage(proc, {
      method: 'item/commandExecution/outputDelta',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        itemId: 'cmd-1',
        delta: 'streamed output',
      },
    });
    emitServerMessage(proc, {
      method: 'turn/completed',
      params: {
        threadId: 'thread-1',
        turn: { id: 'turn-1', items: [], status: 'completed', error: null },
      },
    });

    await turnPromise;

    expect(events).toContainEqual({
      type: 'codex',
      event: {
        type: 'item.updated',
        thread_id: 'thread-1',
        turn_id: 'turn-1',
        item: {
          type: 'command_execution',
          id: 'cmd-1',
          command: 'npm test',
          aggregated_output: 'streamed output',
          status: 'inProgress',
          exit_code: null,
        },
      },
    });
  });

  it('coalesces rapid command output deltas and flushes the latest output on turn completion', async () => {
    const events: unknown[] = [];
    const client = createClient(events);
    const { turnPromise } = await startActiveTurn(client, proc);
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(1_000);

    try {
      for (const delta of ['one', '-two', '-three']) {
        emitServerMessage(proc, {
          method: 'item/commandExecution/outputDelta',
          params: {
            threadId: 'thread-1',
            turnId: 'turn-1',
            itemId: 'cmd-coalesced',
            delta,
          },
        });
      }

      completeRootTurn(proc);
      await turnPromise;
    } finally {
      nowSpy.mockRestore();
    }

    const updates = events.filter((event): boolean => {
      if (!isRecord(event) || event.type !== 'codex') {
        return false;
      }
      const codexEvent = event.event;
      if (!isRecord(codexEvent) || codexEvent.type !== 'item.updated') {
        return false;
      }
      const item = codexEvent.item;
      return isRecord(item) && item.id === 'cmd-coalesced';
    });

    expect(updates).toHaveLength(2);
    expect(
      findCodexCommandOutput(events, 'item.updated', 'cmd-coalesced'),
    ).toBe('one');

    const finalUpdate = updates[1];
    if (
      !isRecord(finalUpdate) ||
      !isRecord(finalUpdate.event) ||
      !isRecord(finalUpdate.event.item)
    ) {
      throw new Error('Expected final command output update item');
    }
    expect(finalUpdate.event.item.aggregated_output).toBe('one-two-three');
  });

  it('truncates streaming command output before storing item updates', async () => {
    const events: unknown[] = [];
    const client = createClient(events);
    const { turnPromise } = await startActiveTurn(client, proc);

    emitServerMessage(proc, {
      method: 'item/commandExecution/outputDelta',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        itemId: 'cmd-large',
        delta: `discarded-prefix\n${'x'.repeat(300 * 1024)}retained-tail`,
      },
    });
    completeRootTurn(proc);

    await turnPromise;

    const output = findCodexCommandOutput(events, 'item.updated', 'cmd-large');
    expect(output).toContain('Canopy truncated earlier command output');
    expect(output).not.toContain('discarded-prefix');
    expect(output.endsWith('retained-tail')).toBe(true);
    expect(output.length).toBeLessThan(270 * 1024);
  });

  describe('command output delivered to a page as appends', () => {
    /** Streams one long command whose output passes the 256 KB clamp. */
    async function streamLongCommand(): Promise<ChatEvent[]> {
      const events: unknown[] = [];
      const client = createClient(events);
      const { turnPromise } = await startActiveTurn(client, proc);
      let now = 10_000;
      const nowSpy = jest.spyOn(Date, 'now').mockImplementation(() => now);
      try {
        emitServerMessage(proc, {
          method: 'item/started',
          params: {
            threadId: 'thread-1',
            turnId: 'turn-1',
            item: {
              type: 'commandExecution',
              id: 'cmd-long',
              command: 'npm test',
              cwd: '/tmp/repo',
              processId: 'proc-1',
              status: 'inProgress',
              commandActions: [],
              aggregatedOutput: '',
              exitCode: null,
              durationMs: null,
            },
          },
        });
        let raw = '';
        for (let index = 0; index < 360; index += 1) {
          const delta = `line ${String(index).padStart(4, '0')} ${'o'.repeat(1_000)}\n`;
          raw += delta;
          // Past the 100 ms throttle: every delta is one update.
          now += 150;
          emitServerMessage(proc, {
            method: 'item/commandExecution/outputDelta',
            params: {
              threadId: 'thread-1',
              turnId: 'turn-1',
              itemId: 'cmd-long',
              delta,
            },
          });
          await flush();
        }
        emitServerMessage(proc, {
          method: 'item/completed',
          params: {
            threadId: 'thread-1',
            turnId: 'turn-1',
            item: {
              type: 'commandExecution',
              id: 'cmd-long',
              command: 'npm test',
              cwd: '/tmp/repo',
              processId: 'proc-1',
              status: 'completed',
              commandActions: [],
              aggregatedOutput: raw,
              exitCode: 0,
              durationMs: 54_000,
            },
          },
        });
        completeRootTurn(proc);
        await turnPromise;
      } finally {
        nowSpy.mockRestore();
      }
      return events.map((data) => ({
        projectId: 'project',
        worktreeId: 'worktree',
        chatId: 'chat',
        data,
      }));
    }

    function isCommandUpdate(event: ChatEvent): boolean {
      const data = event.data;
      return (
        isRecord(data) &&
        isRecord(data.event) &&
        data.event.type === 'item.updated' &&
        isRecord(data.event.item) &&
        data.event.item.id === 'cmd-long'
      );
    }

    /** A page: the preload's decoder behind a `WebContents` send. */
    function openPage(
      delivery: ChatEventOutputDelivery,
      target: { send: jest.Mock },
      epoch: string,
      options: { holdReset?: boolean } = {},
    ): { received: ChatEvent[]; answerReset(): void } {
      const received: ChatEvent[] = [];
      const pendingResets: string[] = [];
      const decoder = new ChatEventOutputDecoder({
        newEpoch: () => epoch,
        requestReset: (value) => {
          if (options.holdReset) pendingResets.push(value);
          else delivery.reset(target, value);
          return Promise.resolve();
        },
      });
      target.send.mockImplementation((channel: string, message: unknown) => {
        if (channel !== IPC_CHANNELS.chatEvent) return;
        // Structured clone, as IPC does.
        const cloned: ChatEventMessage = structuredClone(
          message as ChatEventMessage,
        );
        const event = decoder.decode(cloned);
        if (event) received.push(event);
      });
      return {
        received,
        answerReset: (): void => {
          for (const value of pendingResets.splice(0))
            delivery.reset(target, value);
        },
      };
    }

    function sentBytes(target: { send: jest.Mock }): number[] {
      return target.send.mock.calls.map(([, message]: [string, unknown]) =>
        Buffer.byteLength(JSON.stringify(message)),
      );
    }

    /** The shared chat store's projection of each event, in order. */
    function projectedStore(events: readonly ChatEvent[]): unknown[] {
      const messages = new Map<string, unknown>();
      const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(1);
      for (const event of events) {
        const message = runtimeChatEventToPortalMessage({
          scope: 'worktree',
          workspaceLocalId: event.projectId,
          worktreeLocalId: event.worktreeId,
          chatId: event.chatId,
          data: event.data,
        });
        if (message) messages.set(message.messageId, message);
      }
      nowSpy.mockRestore();
      return Array.from(messages.values());
    }

    let removeEncoder: (() => void) | undefined;
    afterEach(() => {
      removeEncoder?.();
      removeEncoder = undefined;
    });

    function installDelivery(): ChatEventOutputDelivery {
      const delivery = new ChatEventOutputDelivery();
      removeEncoder = setRendererMessageEncoder(IPC_CHANNELS.chatEvent, {
        encode: (target, message) => delivery.encode(target, message),
        discard: (target, message): void => {
          delivery.discard(target, message);
        },
      });
      return delivery;
    }

    it('rebuilds exactly the emitted events, with flat IPC bytes per update', async () => {
      const events = await streamLongCommand();
      const updates = events.filter(isCommandUpdate);
      expect(updates.length).toBeGreaterThan(300);

      const delivery = installDelivery();
      const target = { send: jest.fn() };
      const page = openPage(delivery, target, 'epoch-a');
      for (const event of events)
        sendToWebContents(target, IPC_CHANNELS.chatEvent, event);

      expect(page.received).toStrictEqual(events);
      expect(projectedStore(page.received)).toStrictEqual(
        projectedStore(events),
      );

      const bytes = sentBytes(target);
      const updateBytes = events
        .map((event, index) => (isCommandUpdate(event) ? bytes[index] : -1))
        .filter((value): value is number => value !== undefined && value >= 0);
      const fullBytes = updates.map((event) =>
        Buffer.byteLength(JSON.stringify(event)),
      );
      const sum = (values: number[]): number =>
        values.reduce((total, value) => total + value, 0);
      const earlyFull = sum(fullBytes.slice(1, 9));
      const lateFull = sum(fullBytes.slice(-8));
      const early = sum(updateBytes.slice(1, 9));
      const late = sum(updateBytes.slice(-8));
      // Full resends: the late updates carry the clamped 256 KB output.
      expect(lateFull / earlyFull).toBeGreaterThan(20);
      expect(late / early).toBeLessThan(1.1);
      expect(Math.max(...updateBytes.slice(-8))).toBeLessThan(4 * 1024);
    });

    it('recovers a reloaded page mid-command without showing a wrong output', async () => {
      const events = await streamLongCommand();
      const delivery = installDelivery();
      const target = { send: jest.fn() };
      const reloadAt = events.findIndex(
        (event, index) => index > 100 && isCommandUpdate(event),
      );
      const before = openPage(delivery, target, 'epoch-a');
      for (const event of events.slice(0, reloadAt))
        sendToWebContents(target, IPC_CHANNELS.chatEvent, event);
      expect(before.received).toStrictEqual(events.slice(0, reloadAt));

      // The new page asks to start over; main handles that after two more
      // updates were sent against the old page's outputs.
      const after = openPage(delivery, target, 'epoch-b', { holdReset: true });
      const rest = events.slice(reloadAt);
      rest
        .slice(0, 2)
        .forEach((event) =>
          sendToWebContents(target, IPC_CHANNELS.chatEvent, event),
        );
      expect(after.received).toEqual([]);
      after.answerReset();
      rest
        .slice(2)
        .forEach((event) =>
          sendToWebContents(target, IPC_CHANNELS.chatEvent, event),
        );

      // Everything after the reset arrives exactly; the store converges on
      // what full resends produce.
      expect(after.received).toStrictEqual(rest.slice(2));
      expect(projectedStore(after.received)).toStrictEqual(
        projectedStore(rest),
      );
    });

    it('commits no command output to chat state while the command runs', async () => {
      const events = await streamLongCommand();
      let state: TranscriptReducerState = {
        messages: [],
        status: 'streaming',
        error: null,
        planMode: false,
      };
      const committed: string[] = [];
      for (const event of events) {
        const data = event.data;
        if (!isRecord(data) || !isRecord(data.event)) continue;
        state = applyCodexTranscriptEvent(state, data.event, {
          now: 1,
          createMessageId: () => 'message',
          childToolLiveness: { kind: 'unknown' },
        });
        if (isCommandUpdate(event)) committed.push(JSON.stringify(state));
      }
      // Every running update leaves the committed transcript the same size:
      // `chat:state-changed` carries no growing output.
      expect(new Set(committed.map((value) => value.length)).size).toBe(1);
      expect(committed[0]).not.toContain('line 0000');
    });
  });

  it('truncates completed command execution output before emitting items', async () => {
    const events: unknown[] = [];
    const client = createClient(events);
    const { turnPromise } = await startActiveTurn(client, proc);

    emitServerMessage(proc, {
      method: 'item/completed',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        item: {
          type: 'commandExecution',
          id: 'cmd-completed-large',
          command: 'npm test',
          cwd: '/tmp/repo',
          processId: 'proc-1',
          status: 'completed',
          commandActions: [],
          aggregatedOutput: `discarded-prefix\n${'x'.repeat(300 * 1024)}retained-tail`,
          exitCode: 0,
          durationMs: 1000,
        },
      },
    });
    completeRootTurn(proc);

    await turnPromise;

    const output = findCodexCommandOutput(
      events,
      'item.completed',
      'cmd-completed-large',
    );
    expect(output).toContain('Canopy truncated earlier command output');
    expect(output).not.toContain('discarded-prefix');
    expect(output.endsWith('retained-tail')).toBe(true);
    expect(output.length).toBeLessThan(270 * 1024);
  });

  it('reads account state, reads rate limits, and forwards account notifications', async () => {
    const accountUpdated = jest.fn();
    const rateLimitsUpdated = jest.fn();
    const client = new CodexAppServerClient({
      cwd: '/tmp/repo',
      projectId: 'project',
      worktreeId: 'worktree',
      chatId: 'chat',
      sessionKey: 'project/worktree/chat',
      onEvent: jest.fn(),
      getWindow: (): null => null,
    });

    client.onAccountUpdated(accountUpdated);
    client.onRateLimitsUpdated(rateLimitsUpdated);

    const accountPromise = client.readAccount(false);

    await flush();
    emitServerMessage(proc, {
      id: 1,
      result: { userAgent: 'ua', codexHome: '/tmp/.codex' },
    });
    await flush();

    expect(collectClientMessages(proc)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 1, method: 'initialize' }),
        expect.objectContaining({
          id: 2,
          method: 'account/read',
          params: { refreshToken: false },
        }),
        expect.objectContaining({ method: 'initialized' }),
      ]),
    );

    emitServerMessage(proc, {
      id: 2,
      result: {
        account: {
          type: 'chatgpt',
          email: 'user@example.com',
          planType: 'pro',
        },
        requiresOpenaiAuth: false,
      },
    });

    await expect(accountPromise).resolves.toEqual({
      account: {
        type: 'chatgpt',
        email: 'user@example.com',
        planType: 'pro',
      },
      requiresOpenaiAuth: false,
      workspaceRouting: null,
    });

    emitServerMessage(proc, {
      method: 'account/updated',
      params: {
        authMode: 'chatgpt',
        planType: 'team',
      },
    });
    await flush();

    expect(accountUpdated).toHaveBeenCalledWith({
      authMode: 'chatgpt',
      planType: 'team',
    });

    const rateLimitsPromise = client.readRateLimits();

    await flush();
    expect(collectClientMessages(proc)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 3,
          method: 'account/rateLimits/read',
        }),
      ]),
    );

    emitServerMessage(proc, {
      id: 3,
      result: {
        ordinaryUsageAllowed: true,
        rateLimits: {
          limitId: 'default',
          limitName: 'Default',
          normalModelSlug: 'gpt-6-astra',
          planType: 'pro',
          primary: {
            usedPercent: 42,
            windowDurationMins: 60,
            resetsAt: 1_710_000_000_000,
          },
          secondary: null,
          credits: {
            hasCredits: true,
            unlimited: false,
            balance: '12.34',
          },
          spendControlReached: false,
        },
        rateLimitsByLimitId: {
          codex: {
            limitId: 'codex',
            limitName: 'Codex',
            normalModelSlug: 'gpt-6-sol',
            planType: 'team',
            primary: {
              usedPercent: 10,
              windowDurationMins: 5,
              resetsAt: 1_710_000_300_000,
            },
            secondary: {
              usedPercent: 55,
              windowDurationMins: 60,
              resetsAt: 1_710_003_600_000,
            },
            credits: null,
            spendControlReached: true,
            rateLimitReachedType: null,
          },
        },
        accountId: 'account-123',
        rateLimitUpsell: {
          message: 'Upgrade for more usage',
          action_url: 'https://example.com/upgrade',
        },
      },
    });

    await expect(rateLimitsPromise).resolves.toEqual({
      ordinaryUsageAllowed: true,
      rateLimitResetCredits: null,
      accountId: 'account-123',
      rateLimitUpsell: {
        message: 'Upgrade for more usage',
        action_url: 'https://example.com/upgrade',
      },
      rateLimits: {
        limitId: 'default',
        limitName: 'Default',
        normalModelSlug: 'gpt-6-astra',
        planType: 'pro',
        primary: {
          usedPercent: 42,
          windowDurationMins: 60,
          resetsAt: 1_710_000_000_000,
        },
        secondary: null,
        credits: {
          hasCredits: true,
          unlimited: false,
          balance: '12.34',
        },
        individualLimit: null,
        spendControlReached: false,
        rateLimitReachedType: null,
      },
      rateLimitsByLimitId: {
        codex: {
          limitId: 'codex',
          limitName: 'Codex',
          normalModelSlug: 'gpt-6-sol',
          planType: 'team',
          primary: {
            usedPercent: 10,
            windowDurationMins: 5,
            resetsAt: 1_710_000_300_000,
          },
          secondary: {
            usedPercent: 55,
            windowDurationMins: 60,
            resetsAt: 1_710_003_600_000,
          },
          credits: null,
          individualLimit: null,
          spendControlReached: true,
          rateLimitReachedType: null,
        },
      },
    });

    emitServerMessage(proc, {
      method: 'account/rateLimits/updated',
      params: {
        rateLimits: {
          limitId: 'codex',
          limitName: 'Codex',
          normalModelSlug: 'gpt-6-luna',
          planType: 'team',
          primary: {
            usedPercent: 12,
            windowDurationMins: 5,
            resetsAt: 1_710_000_300_000,
          },
          secondary: null,
          credits: null,
          spendControlReached: false,
        },
      },
    });
    await flush();

    expect(rateLimitsUpdated).toHaveBeenCalledWith({
      rateLimits: {
        limitId: 'codex',
        limitName: 'Codex',
        normalModelSlug: 'gpt-6-luna',
        planType: 'team',
        primary: {
          usedPercent: 12,
          windowDurationMins: 5,
          resetsAt: 1_710_000_300_000,
        },
        secondary: null,
        credits: null,
        individualLimit: null,
        spendControlReached: false,
        rateLimitReachedType: null,
      },
    });
  });

  it('proactively emits rate_limit.reached when the account reaches a usage limit', async () => {
    const emitted: unknown[] = [];
    const client = new CodexAppServerClient({
      cwd: '/tmp/repo',
      projectId: 'project',
      worktreeId: 'worktree',
      chatId: 'chat',
      sessionKey: 'project/worktree/chat',
      onEvent: (event: unknown): void => {
        emitted.push(event);
      },
      getWindow: (): null => null,
    });

    const countRateLimitReached = (): number =>
      emitted.filter(
        (event) =>
          isRecord(event) &&
          isRecord(event.event) &&
          event.event.type === 'rate_limit.reached',
      ).length;

    const accountPromise = client.readAccount(false);
    await flush();
    emitServerMessage(proc, {
      id: 1,
      result: { userAgent: 'ua', codexHome: '/tmp/.codex' },
    });
    await flush();
    emitServerMessage(proc, {
      id: 2,
      result: { account: null, requiresOpenaiAuth: true },
    });
    await accountPromise;

    // A snapshot that is not "reached" must not surface the fallback prompt.
    emitServerMessage(proc, {
      method: 'account/rateLimits/updated',
      params: {
        rateLimits: {
          limitId: 'codex',
          primary: { usedPercent: 40, resetsAt: 1_710_000_300_000 },
          rateLimitReachedType: null,
        },
      },
    });
    await flush();
    expect(countRateLimitReached()).toBe(0);

    // Reaching a limit surfaces the synthetic event once, carrying the soonest
    // reset time across the reported windows.
    emitServerMessage(proc, {
      method: 'account/rateLimits/updated',
      params: {
        rateLimits: {
          limitId: 'codex',
          primary: { usedPercent: 100, resetsAt: 1_710_003_600_000 },
          secondary: { usedPercent: 100, resetsAt: 1_710_000_300_000 },
          rateLimitReachedType: 'rate_limit_reached',
        },
      },
    });
    await flush();
    expect(countRateLimitReached()).toBe(1);
    const reached = emitted.find(
      (event) =>
        isRecord(event) &&
        isRecord(event.event) &&
        event.event.type === 'rate_limit.reached',
    );
    expect(reached).toMatchObject({
      type: 'codex',
      event: {
        type: 'rate_limit.reached',
        reachedType: 'rate_limit_reached',
        resetsAt: 1_710_000_300_000,
      },
    });

    // A repeat snapshot for the same reached window is de-duped.
    emitServerMessage(proc, {
      method: 'account/rateLimits/updated',
      params: {
        rateLimits: {
          limitId: 'codex',
          primary: { usedPercent: 100, resetsAt: 1_710_003_600_000 },
          secondary: { usedPercent: 100, resetsAt: 1_710_000_300_000 },
          rateLimitReachedType: 'rate_limit_reached',
        },
      },
    });
    await flush();
    expect(countRateLimitReached()).toBe(1);
  });

  describe('usage-limit failure reset time (CAN-4564)', () => {
    type FailureKind = 'root turn.failed' | 'subagent turn.failed' | 'error';

    async function startClient(): Promise<{ emitted: unknown[] }> {
      const emitted: unknown[] = [];
      const client = new CodexAppServerClient({
        cwd: '/tmp/repo',
        projectId: 'project',
        worktreeId: 'worktree',
        chatId: 'chat',
        sessionKey: 'project/worktree/chat',
        onEvent: (event: unknown): void => {
          emitted.push(event);
        },
        getWindow: (): null => null,
      });
      const { turnPromise } = await startActiveTurn(client, proc);
      // A subagent failure leaves the root turn open until teardown.
      void turnPromise.catch(() => {});
      return { emitted };
    }

    function emitRateLimits(
      rateLimitReachedType: string | null,
      resetsAt: number,
      windows: {
        primary?: { usedPercent: number; resetsAt: number };
        secondary?: { usedPercent: number; resetsAt: number };
      } = { primary: { usedPercent: 100, resetsAt } },
    ): void {
      emitServerMessage(proc, {
        method: 'account/rateLimits/updated',
        params: {
          rateLimits: {
            limitId: 'codex',
            ...windows,
            rateLimitReachedType,
          },
        },
      });
    }

    function emitFailure(kind: FailureKind, codexErrorInfo: string): void {
      const error = { message: 'Usage limit exceeded.', codexErrorInfo };
      if (kind === 'error') {
        // A root error only settles at its turn/completed (turn-state 33a);
        // a subagent's error is emitted as it arrives.
        emitServerMessage(proc, {
          method: 'error',
          params: {
            threadId: 'child-thread',
            turnId: 'child-turn',
            willRetry: false,
            error,
          },
        });
        return;
      }
      emitServerMessage(proc, {
        method: 'turn/completed',
        params: {
          threadId:
            kind === 'subagent turn.failed' ? 'child-thread' : 'thread-1',
          turn: {
            id: kind === 'subagent turn.failed' ? 'child-turn' : 'turn-1',
            items: [],
            status: 'failed',
            error,
          },
        },
      });
    }

    function failureResetsAt(
      emitted: unknown[],
      kind: FailureKind,
    ): number | undefined {
      const eventType = kind === 'error' ? 'error' : 'turn.failed';
      const failure = emitted.find(
        (event) =>
          isRecord(event) &&
          isRecord(event.event) &&
          event.event.type === eventType,
      );
      if (!isRecord(failure) || !isRecord(failure.event)) {
        throw new Error(`Expected an emitted ${eventType} event`);
      }
      const holder = kind === 'error' ? failure.event : failure.event.error;
      if (!isRecord(holder)) throw new Error('Expected a failure payload');
      return typeof holder.resetsAt === 'number' ? holder.resetsAt : undefined;
    }

    const kinds: FailureKind[] = [
      'root turn.failed',
      'subagent turn.failed',
      'error',
    ];

    it.each(kinds)(
      'attaches the reached reset time in ms to a usage-limit %s',
      async (kind) => {
        const { emitted } = await startClient();
        const resetsAtSeconds = Math.floor(Date.now() / 1000) + 3600;
        emitRateLimits('rate_limit_reached', resetsAtSeconds);
        emitFailure(kind, 'usageLimitExceeded');
        await flush();
        expect(failureResetsAt(emitted, kind)).toBe(resetsAtSeconds * 1000);
      },
    );

    it.each(kinds)(
      'attaches no reset time to a usage-limit %s without a reached snapshot',
      async (kind) => {
        const { emitted } = await startClient();
        emitFailure(kind, 'usageLimitExceeded');
        await flush();
        expect(failureResetsAt(emitted, kind)).toBeUndefined();
      },
    );

    it('attaches no reset time after a snapshot that is not reached', async () => {
      const { emitted } = await startClient();
      emitRateLimits(null, Math.floor(Date.now() / 1000) + 3600);
      emitFailure('root turn.failed', 'usageLimitExceeded');
      await flush();
      expect(failureResetsAt(emitted, 'root turn.failed')).toBeUndefined();
    });

    it('clears the reset time once a later snapshot is no longer reached', async () => {
      const { emitted } = await startClient();
      const resetsAtSeconds = Math.floor(Date.now() / 1000) + 3600;
      emitRateLimits('rate_limit_reached', resetsAtSeconds);
      emitRateLimits(null, resetsAtSeconds, {
        primary: { usedPercent: 5, resetsAt: resetsAtSeconds },
      });
      emitFailure('root turn.failed', 'usageLimitExceeded');
      await flush();
      expect(failureResetsAt(emitted, 'root turn.failed')).toBeUndefined();
    });

    it('keeps the reset time across a sparse update that omits the reached type', async () => {
      const { emitted } = await startClient();
      const resetsAtSeconds = Math.floor(Date.now() / 1000) + 3600;
      emitRateLimits('rate_limit_reached', resetsAtSeconds);
      // Rolling updates are sparse: a null reached type alone does not clear
      // a previously observed value while the window is still exhausted.
      emitRateLimits(null, resetsAtSeconds);
      emitFailure('root turn.failed', 'usageLimitExceeded');
      await flush();
      expect(failureResetsAt(emitted, 'root turn.failed')).toBe(
        resetsAtSeconds * 1000,
      );
    });

    it('attaches the reset time of the exhausted window', async () => {
      const { emitted } = await startClient();
      const nowSeconds = Math.floor(Date.now() / 1000);
      const weeklyResetsAtSeconds = nowSeconds + 4 * 24 * 3600;
      emitRateLimits('rate_limit_reached', nowSeconds + 7200, {
        primary: { usedPercent: 40, resetsAt: nowSeconds + 7200 },
        secondary: { usedPercent: 100, resetsAt: weeklyResetsAtSeconds },
      });
      emitFailure('root turn.failed', 'usageLimitExceeded');
      await flush();
      expect(failureResetsAt(emitted, 'root turn.failed')).toBe(
        weeklyResetsAtSeconds * 1000,
      );
    });

    it('attaches no reset time that is already in the past', async () => {
      const { emitted } = await startClient();
      emitRateLimits('rate_limit_reached', Math.floor(Date.now() / 1000) - 60);
      emitFailure('root turn.failed', 'usageLimitExceeded');
      await flush();
      expect(failureResetsAt(emitted, 'root turn.failed')).toBeUndefined();
    });

    it('attaches no reset time to a non-limit failure', async () => {
      const { emitted } = await startClient();
      emitRateLimits(
        'rate_limit_reached',
        Math.floor(Date.now() / 1000) + 3600,
      );
      emitFailure('root turn.failed', 'serverOverloaded');
      await flush();
      expect(failureResetsAt(emitted, 'root turn.failed')).toBeUndefined();
    });

    it('refreshes the reset time from a repeat reached snapshot', async () => {
      const { emitted } = await startClient();
      const nowSeconds = Math.floor(Date.now() / 1000);
      emitRateLimits('rate_limit_reached', nowSeconds + 3600);
      emitRateLimits('rate_limit_reached', nowSeconds + 7200);
      emitFailure('root turn.failed', 'usageLimitExceeded');
      await flush();
      expect(failureResetsAt(emitted, 'root turn.failed')).toBe(
        (nowSeconds + 7200) * 1000,
      );
    });
  });

  it('preserves custom developer instructions on thread start without overriding default turns', async () => {
    const client = new CodexAppServerClient({
      cwd: '/tmp/repo',
      projectId: 'project',
      worktreeId: 'worktree',
      chatId: 'chat',
      sessionKey: 'project/worktree/chat',
      onEvent: jest.fn(),
      getWindow: (): null => null,
      developerInstructions: 'Stay inside the history folder.',
    });

    const turnPromise = client.startTurn({
      text: 'Implement this',
      cwd: '/tmp/repo',
      model: 'gpt-6-sol',
      thinkingLevel: 'high',
      planMode: false,
    });

    await flush();
    emitServerMessage(proc, {
      id: 1,
      result: { userAgent: 'ua', codexHome: '/tmp/.codex' },
    });
    await flush();
    emitServerMessage(proc, {
      id: 2,
      result: {
        thread: {
          id: 'thread-1',
          preview: '',
          ephemeral: false,
          modelProvider: 'openai',
          createdAt: 1,
          updatedAt: 1,
          status: { type: 'idle' },
          path: null,
          cwd: '/tmp/repo',
          cliVersion: '0.114.0',
          source: 'vscode',
          agentNickname: null,
          agentRole: null,
          gitInfo: null,
          name: null,
          turns: [],
        },
        model: 'gpt-6-sol',
        modelProvider: 'openai',
        serviceTier: null,
        cwd: '/tmp/repo',
        approvalPolicy: 'never',
        sandbox: { type: 'dangerFullAccess' },
        reasoningEffort: 'high',
      },
    });
    await flush();

    const sentAfterThreadStart = collectClientMessages(proc);
    const threadStartMessage = sentAfterThreadStart.find(
      (message): boolean => message.method === 'thread/start',
    );
    const turnStartMessage = sentAfterThreadStart.find(
      (message): boolean => message.method === 'turn/start',
    );

    if (!threadStartMessage || !isRecord(threadStartMessage.params)) {
      throw new Error('Expected thread/start message');
    }
    if (!turnStartMessage || !isRecord(turnStartMessage.params)) {
      throw new Error('Expected turn/start message');
    }

    expect(threadStartMessage.params.developerInstructions).toBe(
      'Stay inside the history folder.',
    );
    expect(turnStartMessage.params.collaborationMode).toBeUndefined();

    emitServerMessage(proc, {
      id: 3,
      result: {
        turn: { id: 'turn-1', items: [], status: 'inProgress', error: null },
      },
    });
    emitServerMessage(proc, {
      method: 'turn/completed',
      params: {
        threadId: 'thread-1',
        turn: { id: 'turn-1', items: [], status: 'completed', error: null },
      },
    });

    await expect(turnPromise).resolves.toMatchObject({
      status: 'completed',
    });
  });
});

describe('readCodexDeliveryHistory', () => {
  const threadId = 'thread-history';
  const turnId = 'turn-history';
  const attemptId = 'attempt-history';
  const byteBudget = 64 * 1024 * 1024;
  let codexHome: string;

  beforeEach(() => {
    codexHome = mkdtempSync(join(tmpdir(), 'codex-delivery-history-'));
  });

  afterEach(() => {
    rmSync(codexHome, { recursive: true, force: true });
  });

  function rolloutPath(name = `rollout-test-${threadId}.jsonl`): string {
    const directory = join(codexHome, 'sessions', '2026', '10', '16');
    mkdirSync(directory, { recursive: true });
    return join(directory, name);
  }

  function writeRollout(records: unknown[], name?: string): string {
    const path = rolloutPath(name);
    writeFileSync(
      path,
      `${records.map((record) => JSON.stringify(record)).join('\n')}\n`,
    );
    return path;
  }

  function makeQuery(
    overrides: Partial<Parameters<typeof readCodexDeliveryHistory>[0]> = {},
  ): Parameters<typeof readCodexDeliveryHistory>[0] {
    return {
      threadId,
      turnId,
      attemptId,
      previousRun: true,
      codexHome,
      ...overrides,
    };
  }

  const sessionMeta = { type: 'session_meta', payload: { id: threadId } };
  const taskStarted = {
    type: 'event_msg',
    payload: { type: 'task_started', turn_id: turnId },
  };
  const completedItem = (clientId: string) => ({
    type: 'event_msg',
    payload: {
      type: 'item_completed',
      item: { type: 'userMessage', client_id: clientId },
    },
  });

  it('finds a matching item_completed record even on a later line', async () => {
    writeRollout([
      sessionMeta,
      taskStarted,
      completedItem('another-attempt'),
      completedItem(attemptId),
    ]);

    await expect(readCodexDeliveryHistory(makeQuery())).resolves.toBe('found');
  });

  it('reports not-found only for a previous run with a start record', async () => {
    writeRollout([sessionMeta, taskStarted, completedItem('another-attempt')]);

    await expect(readCodexDeliveryHistory(makeQuery())).resolves.toBe(
      'not-found',
    );
  });

  it('does not prove not-found for a live run', async () => {
    writeRollout([sessionMeta, taskStarted, completedItem('another-attempt')]);

    await expect(
      readCodexDeliveryHistory(makeQuery({ previousRun: false })),
    ).resolves.toBe('unreadable');
  });

  it('does not prove not-found without a turn id', async () => {
    writeRollout([sessionMeta, completedItem('another-attempt')]);

    await expect(
      readCodexDeliveryHistory(makeQuery({ turnId: undefined })),
    ).resolves.toBe('unreadable');
  });

  it('returns unreadable when the rollout is missing', async () => {
    await expect(readCodexDeliveryHistory(makeQuery())).resolves.toBe(
      'unreadable',
    );
  });

  it('returns unreadable when more than one rollout matches the thread', async () => {
    writeRollout([sessionMeta, taskStarted], `rollout-one-${threadId}.jsonl`);
    writeRollout([sessionMeta, taskStarted], `rollout-two-${threadId}.jsonl`);

    await expect(readCodexDeliveryHistory(makeQuery())).resolves.toBe(
      'unreadable',
    );
  });

  it('returns unreadable when the rollout scan is capped', async () => {
    const path = rolloutPath();
    writeFileSync(
      path,
      `${JSON.stringify(sessionMeta)}\n${JSON.stringify(taskStarted)}\n`,
    );
    const crowded = join(codexHome, 'sessions', 'crowded');
    mkdirSync(crowded, { recursive: true });
    for (let batch = 0; batch < 10_001; batch += 100) {
      const end = Math.min(batch + 100, 10_001);
      await Promise.all(
        Array.from({ length: end - batch }, (_, offset) =>
          writeFile(join(crowded, `entry-${batch + offset}`), ''),
        ),
      );
    }

    await expect(readCodexDeliveryHistory(makeQuery())).resolves.toBe(
      'unreadable',
    );
  }, 30_000);

  it.each([
    [
      'torn final line',
      `${JSON.stringify(sessionMeta)}\n${JSON.stringify(taskStarted)}\n{"type":"event_msg"`,
    ],
    ['invalid line', `${JSON.stringify(sessionMeta)}\nnot-json\n`],
  ])('returns unreadable for a %s', async (_label, contents) => {
    writeFileSync(rolloutPath(), contents);

    await expect(readCodexDeliveryHistory(makeQuery())).resolves.toBe(
      'unreadable',
    );
  });

  it('returns unreadable when a later torn line follows a matching attempt', async () => {
    writeRollout([sessionMeta, taskStarted, completedItem(attemptId)]);
    writeFileSync(rolloutPath(), '{"type":"event_msg"', { flag: 'a' });

    await expect(readCodexDeliveryHistory(makeQuery())).resolves.toBe(
      'unreadable',
    );
  });

  it('returns unreadable when the rollout exceeds the byte budget', async () => {
    const path = rolloutPath();
    writeFileSync(path, '');
    truncateSync(path, byteBudget + 1);

    await expect(readCodexDeliveryHistory(makeQuery())).resolves.toBe(
      'unreadable',
    );
  }, 30_000);

  it('returns unreadable when the rollout exceeds the line budget', async () => {
    writeFileSync(rolloutPath(), '{}\n'.repeat(200_001));

    await expect(readCodexDeliveryHistory(makeQuery())).resolves.toBe(
      'unreadable',
    );
  });

  it('returns unreadable when a previous-run rollout has no turn start record', async () => {
    writeRollout([sessionMeta, completedItem('another-attempt')]);

    await expect(readCodexDeliveryHistory(makeQuery())).resolves.toBe(
      'unreadable',
    );
  });

  it('returns unreadable when session_meta names a different thread', async () => {
    writeRollout([
      { type: 'session_meta', payload: { id: 'different-thread' } },
      taskStarted,
    ]);

    await expect(readCodexDeliveryHistory(makeQuery())).resolves.toBe(
      'unreadable',
    );
  });
});
