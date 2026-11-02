/**
 * Shared contract for the provider pipeline harness (test-only).
 *
 * The harness drives scripted provider streams through the real main-process
 * pipeline and records one ordered trace. Scripts record provider frames; the
 * harness records committed revisions, transcript evidence, queue updates,
 * effects and checkpoints; the invariant checker reads only this trace.
 *
 * Clocks: `at` is real monotonic time (`performance.now()`), for opt-in timing
 * targets only. `logicalAt` is the harness clock injected into the queue and
 * chat state (`now`/`schedule`); deadline rules use it.
 */
import type {
  ChatJournalRecord,
  ChatQueueUpdatedEvent,
  ChatRuntimeState,
  PersistedChatMessage,
  PersistedChatTab,
} from '@canopy/desktop-shared/types';
import type { ChatTurnLifecycleEvent } from '@canopy/protocol/canopy-core';
import type { SessionDiagnosticRecord } from '../../observability/service';
import type { ChatEventDrop } from '../../lib/chat-event-drop-diagnostics';

export type PipelineProvider = 'claude' | 'codex';
export type PipelineHost = 'worktree' | 'cowork' | 'app-advisor';

/** Test ingress only; never changes the production host identity. */
export interface PipelineHostOptions {
  coworkDispatch?: 'service' | 'desktop-ipc';
  /** Leave the persisted tab absent to exercise first-send creation. */
  createInitialChat?: boolean;
}

export interface PipelineChatTarget {
  projectId: string;
  worktreeId: string;
  chatId: string;
}

interface TraceEventBase {
  /** Global order across every event kind, assigned by the recorder. */
  seq: number;
  /** Real monotonic time when recorded, assigned by the recorder. */
  at: number;
  /** Harness logical clock when recorded, assigned by the recorder. */
  logicalAt: number;
}

/** One registered chat at one committed revision. */
export interface RevisionChatView {
  runtime: ChatRuntimeState | undefined;
  /**
   * Rows of the committed state when this commit selected the chat's
   * transcript (a bounded window for large chats). `undefined` when the
   * commit did not select it or the chat was registered without row capture:
   * absence is not "unchanged".
   */
  rows: readonly PersistedChatMessage[] | undefined;
  /** The tab's input-delivery ledger; always captured (it is small). */
  inputDelivery: PersistedChatTab['inputDelivery'];
}

/**
 * One committed revision, captured at the repository commit listener before
 * the service's own publication runs. `at` is that listener's time: after the
 * durable write, not the write itself.
 */
export interface RevisionTraceEvent extends TraceEventBase {
  kind: 'revision';
  projectId: string;
  worktreeId: string;
  revision: number;
  baseRevision: number;
  source: ChatJournalRecord['source'];
  /** Deep-frozen clones, keyed by chat id, for registered chats only. */
  chats: Readonly<Record<string, RevisionChatView>>;
}

/**
 * Append-only evidence for a chat's committed transcript bytes on disk,
 * captured at checkpoints (or after each revision when configured).
 */
export interface TranscriptTraceEvent extends TraceEventBase {
  kind: 'transcript';
  target: PipelineChatTarget;
  committedBytes: number;
  sha256: string;
  /** The previous capture for this chat; absent on the first. */
  previous?: {
    committedBytes: number;
    sha256: string;
    /** sha256 of this capture's first `previous.committedBytes` bytes. */
    prefixSha256: string;
  };
}

export interface QueueTraceEvent extends TraceEventBase {
  kind: 'queue';
  event: ChatQueueUpdatedEvent;
  /** `ChatQueueService.isTurnActive(target)` sampled at the broadcast. */
  turnActive: boolean | undefined;
  /** Canonical admission (`evaluateTurnAdmission`) would hold an ordinary send. */
  admissionBlocked?: boolean;
}

/** Provider-side correlation ids; set whichever the frame carries. */
export interface ProviderFrameIds {
  messageUuid?: string;
  callId?: string;
  requestId?: string;
  taskId?: string;
  toolUseId?: string;
}

export interface ProviderTraceEvent extends TraceEventBase {
  kind: 'provider';
  provider: PipelineProvider;
  target: PipelineChatTarget;
  /** `to-canopy`: a frame the script emitted. `to-provider`: what Canopy sent. */
  direction: 'to-canopy' | 'to-provider';
  /**
   * Stable frame label. Claude: `sdk:<message type>[:<subtype>]` for emitted
   * frames; `prompt`, `steer`, `interrupt`, `cancel-async`, `control:<name>`
   * for frames Canopy sent. Codex: `notification:<method>`,
   * `request:<method>` (server request), `response:<method>` for emitted
   * frames; `client:<method>` for requests Canopy sent and
   * `client-response:<method>` for its answers to server requests.
   */
  type: string;
  /** The script's own provider turn key, when the frame belongs to a turn. */
  turnKey?: string;
  ids?: ProviderFrameIds;
  /** Text Canopy sent (prompt or steer), for correlation with queued rows. */
  text?: string;
  /** Native command completion payload observed at scripted stdio, not ingress. */
  commandCompletion?: {
    itemId: string;
    threadId: string;
    turnId: string;
    aggregateOutput: string;
  };
  /** Native child terminal observed at scripted stdio, not ingress. */
  agentTerminal?: { threadId: string; status: string };
  /** Content-free projection of the actual replay envelope at the transport. */
  replayFrame?: LifecycleFrameObservation;
}

/** One content-free chat lifecycle event delivered to the service observer. */
export interface TurnLifecycleTraceEvent extends TraceEventBase {
  kind: 'turn-lifecycle';
  target: PipelineChatTarget;
  event: ChatTurnLifecycleEvent;
}

/** Observed effects, with the identities the invariant rules correlate. */
export type PipelineEffect =
  | { name: 'session-created'; sessionKey: string }
  | { name: 'session-destroyed'; sessionKey: string }
  | { name: 'native-task-live'; taskId: string; toolUseId?: string }
  | { name: 'native-task-ended'; taskId: string }
  | { name: 'wake-lock-acquire'; holder: string }
  | { name: 'wake-lock-release'; holder: string }
  /** A real side effect performed for a provider tool call (not its handler start). */
  | { name: 'tool-side-effect'; callId: string; effect: string }
  /** A watcher registration, with the natural key production deduplicates on. */
  | {
      name: 'watcher-registered';
      callId: string;
      naturalKey: string;
      watcherId: string;
      created: boolean;
    }
  /** Canopy processed the provider's answer to a steer (its submit settled). */
  | {
      name: 'steer-settled';
      text: string;
      outcome: 'accepted' | 'refused' | 'unknown';
    }
  | { name: 'transcript-rewrite'; reason: string }
  /** Calls into external terminal leaves, not fabricated provider events. */
  | {
      name: 'terminal-effect';
      effect: 'turn-diff' | 'code-review';
      identity: string;
      /** The turn a turn-diff capture ends, as its production caller names it. */
      turn?: { userMessageId: string; wakeTurnId?: string };
    }
  /** A turn-diff start baseline, so this chat session captures turn diffs. */
  | { name: 'turn-diff-baseline'; identity: string }
  | { name: 'commits-held' }
  | { name: 'commits-released' }
  /**
   * The watcher service reported a chat's completion (phase 36a), with the
   * turn stamp its once-per-turn claim uses.
   */
  | { name: 'chat-completion-reported'; stamp: string }
  /**
   * A reported completion the watcher modal deferred mid-report; its replay
   * when the modal closes is the report that goes out.
   */
  | { name: 'chat-completion-deferred'; stamp: string };

export interface EffectTraceEvent extends TraceEventBase {
  kind: 'effect';
  target?: PipelineChatTarget;
  effect: PipelineEffect;
}

/**
 * An explicit barrier with sampled state. Label conventions:
 * `drained` (after `host.drain()`), `delivery-eligible` (the first moment a
 * queued delivery may run: barrier released, prior terminal durable),
 * `deadline` (a logical-clock deadline passed with no further revision),
 * `user-stop`, `settings-changed`.
 */
export interface CheckpointTraceEvent extends TraceEventBase {
  kind: 'checkpoint';
  label: string;
  target?: PipelineChatTarget;
  /** `getChatSessionLiveness` at the checkpoint. */
  liveness?: { foreground: boolean; background: boolean };
  /** The session's `turnActive` from `getActiveSessionInfos`. */
  sessionTurnActive?: boolean;
  /** `ChatQueueService.isTurnActive(target)`. */
  queueTurnActive?: boolean;
  /** Canonical admission (`evaluateTurnAdmission`) would hold an ordinary send. */
  admissionBlocked?: boolean;
  /** True when the user explicitly chose this action (Stop, drop, restart). */
  userInitiated?: boolean;
}

export type PipelineTraceEvent =
  | RevisionTraceEvent
  | TranscriptTraceEvent
  | QueueTraceEvent
  | ProviderTraceEvent
  | TurnLifecycleTraceEvent
  | EffectTraceEvent
  | CheckpointTraceEvent;

type WithoutStamp<T> = T extends TraceEventBase
  ? Omit<T, 'seq' | 'at' | 'logicalAt'>
  : never;
export type PipelineTraceInput = WithoutStamp<PipelineTraceEvent>;

/** Shared by the harness and the scripts; assigns `seq`, `at`, `logicalAt`. */
export interface PipelineTraceRecorder {
  record(event: PipelineTraceInput): void;
  readonly events: readonly PipelineTraceEvent[];
}

// ---------------------------------------------------------------------------
// Scripted providers (implemented by scripted-claude.ts / scripted-codex.ts)
// ---------------------------------------------------------------------------

export interface ScriptedSteer {
  readonly text: string;
  readonly ids: ProviderFrameIds;
  acknowledge(): Promise<void>;
  refuse(): Promise<void>;
  /** Acknowledge only after `delayMs` of real time. */
  acknowledgeLate(delayMs: number): Promise<void>;
  /** Codex: the native `userMessage` item that consumes this steer in its turn. */
  pickUp?(): Promise<void>;
}

export interface ScriptedProviderTurn {
  readonly turnKey: string;
  /** The root prompt text Canopy sent; empty for a self-started turn. */
  readonly prompt: string;
  emitText(text: string): Promise<void>;
  emitToolCall(call: {
    callId: string;
    name: string;
    input?: Readonly<Record<string, unknown>>;
    /** A child call made inside another call (sub-agent). */
    parentCallId?: string;
  }): Promise<void>;
  emitToolResult(callId: string, output?: string): Promise<void>;
  /** Native background work (Claude task events; Codex collab items). */
  startNativeTask(task: {
    taskId: string;
    toolUseId: string;
    kind: 'agent' | 'shell' | 'monitor' | 'workflow';
  }): Promise<void>;
  endNativeTask(
    taskId: string,
    status?: 'completed' | 'stopped' | 'failed',
  ): Promise<void>;
  /** Waits for the next steer Canopy sends during this turn. */
  nextSteer(options?: { timeoutMs?: number }): Promise<ScriptedSteer>;
  /** Holds every later frame of this turn until `release()`. */
  hold(): void;
  release(): Promise<void>;
  /** The root terminal (Claude result; Codex `turn/completed`). */
  complete(result?: { isError?: boolean }): Promise<void>;
  /** Claude: the root result an interrupted foreground turn ends with (`aborted_streaming`). */
  emitAbortedStreamingResult?(): Promise<void>;
  /** Codex: send a native app-server error notification for this turn. */
  emitError?(error: { message: string; willRetry: boolean }): Promise<void>;
  /** Codex: change the root or latest scripted child thread's status. */
  emitThreadStatus?(status: {
    status: 'active' | 'waitingOnApproval' | 'idle';
    child?: boolean;
  }): Promise<void>;
}

export interface ScriptedCodexResumeConfiguration {
  /** Status of the last turn reported by `thread/resume`. */
  status: 'inProgress' | 'completed';
  /** Reuse this turn id on the next actual `turn/start`; defaults to the live or next scripted id. */
  turnId?: string;
  /** Ordering of the next `turn/start` response and `turn/started` notification. */
  startOrder: 'response-first' | 'started-first';
}

/** Codex's JSON-safe `thread/backgroundTerminals/list` view in scripted tests. */
export interface ScriptedCodexBackgroundTerminal {
  itemId: string;
  processId: string;
  command: string;
  cwd: string;
  osPid: number | null;
  cpuPercent: number | null;
  rssKb: number | null;
}

/** One explicit test page, selected by the request's cursor (`null` is first). */
export interface ScriptedCodexBackgroundTerminalsPage {
  cursor: string | null;
  data: readonly ScriptedCodexBackgroundTerminal[];
  nextCursor: string | null;
}

/** Optional scripted/replayed background terminal view and failure behavior. */
export interface ScriptedCodexBackgroundTerminalsConfiguration {
  /** Used only for replayed command items that do not carry a process id. */
  syntheticProcessId?: string;
  /** Scope list overrides and replay process ids to one thread when supplied. */
  threadId?: string;
  /** Explicit pages replace the default fake-view snapshot. */
  listPages?: readonly ScriptedCodexBackgroundTerminalsPage[];
  /** When scoped to this thread, this takes precedence over `listPages`. */
  listFailure?: { code: number; message: string };
}

export interface ScriptedProviderDriver {
  readonly provider: PipelineProvider;
  /** Opt-in, before the first query/spawn; normal scripting is unchanged. */
  enableReplay?(fixture: LifecycleFixture): LifecycleReplayDriver;
  /** Raw transport launch inputs, for test-only product-profile projection. */
  getLaunchInputs?(): readonly unknown[];
  /** Waits for the next turn Canopy starts (prompt consumed / `turn/start`). */
  nextTurn(options?: { timeoutMs?: number }): Promise<ScriptedProviderTurn>;
  /** A turn the provider starts by itself (wake or autonomous turn). */
  startTurnByItself(options?: { text?: string }): Promise<ScriptedProviderTurn>;
  /** Waits for Canopy's interrupt (Stop). */
  nextInterrupt(options?: { timeoutMs?: number }): Promise<void>;
  /** Codex: a server request (approval or dynamic tool call). */
  sendServerRequest?(request: {
    method: string;
    callId: string;
    params?: Readonly<Record<string, unknown>>;
  }): Promise<void>;
  /** Codex: `serverRequest/resolved` for that call (provider-side cancel). */
  resolveServerRequest?(callId: string): Promise<void>;
  /** Codex: configure the next `thread/resume` response and matching `turn/start`. */
  configureNextResume?(configuration: ScriptedCodexResumeConfiguration): void;
  dispose(): Promise<void>;
}

// Content-free C2 v2 lifecycle contract (schemaVersion remains 1).
export type LifecycleScalar = string | number | boolean;
export type LifecycleIds = Partial<
  Record<
    | 'session'
    | 'message'
    | 'turn'
    | 'thread'
    | 'item'
    | 'task'
    | 'call'
    | 'request'
    | 'toolUse'
    | 'agentThread',
    string
  >
>;
export type LifecycleFields = Record<
  string,
  LifecycleScalar | LifecycleScalar[] | null
>;
export interface LifecycleFrameObservation {
  lane: 'root' | `child:${string}`;
  type: string;
  shape?: string[];
  ids?: LifecycleIds;
  consumed?: string[];
  fields?: LifecycleFields;
}
export interface LifecycleFrame extends LifecycleFrameObservation {
  kind: 'frame';
  template: string;
}
export interface LifecycleControl {
  kind: 'control';
  action:
    | 'send'
    | 'steer'
    | 'interrupt'
    | 'stop-task'
    | 'permission-allow'
    | 'permission-deny'
    | 'approve'
    | 'deny'
    | 'answer-tool'
    | 'release'
    | 'start-turn';
  ids?: LifecycleIds;
  barrier?: string;
}
export type LifecycleEvidenceRole = 'root' | 'child' | 'sibling';
export type LifecycleEvidenceIds = { thread: string; turn: string };
export type LifecycleEvidence =
  | {
      kind: 'evidence';
      event: 'admitted';
      role: LifecycleEvidenceRole;
      ids: LifecycleEvidenceIds;
      barrier: string;
      stepId: string;
    }
  | {
      kind: 'evidence';
      event: 'interrupt-sent';
      role: 'root' | 'child';
      ids: LifecycleEvidenceIds;
    }
  | {
      kind: 'evidence';
      event: 'interrupt-ack';
      role: 'root' | 'child';
      ids: LifecycleEvidenceIds;
      outcome: 'success' | 'error';
    }
  | {
      kind: 'evidence';
      event: 'window-closed';
      outcome: 'observed' | 'inconclusive';
    }
  | {
      kind: 'evidence';
      event: 'release';
      role: LifecycleEvidenceRole;
      ids: LifecycleEvidenceIds;
      barrier: string;
    };
export interface LifecycleGroup {
  kind: 'group';
  lanes: LifecycleStep[][];
}
export type LifecycleStep =
  | LifecycleFrame
  | LifecycleControl
  | LifecycleEvidence
  | LifecycleGroup;
export interface LifecycleFixture {
  schemaVersion: 1;
  scenario: string;
  provider: PipelineProvider;
  tier: 'fast' | 'slow';
  profile: string;
  provenance: { binaryVersion: string; sdkVersion?: string };
  semantics: string[];
  steps: LifecycleStep[];
}
export interface LifecycleReplayDriver {
  /** Build and emit one envelope; never synthesize adjacent frames. */
  emit(frame: LifecycleFrame): Promise<void>;
  /** Match the next client operation and bind its live ids to aliases. */
  acceptControl(control: LifecycleControl): Promise<void>;
  /** Resolve a fixture alias at a host-control boundary (never a raw fixture id). */
  liveId?: (kind: keyof LifecycleIds, alias: string) => string | undefined;
  /** Read-only test observation immediately before a materialized envelope is written. */
  observeBeforeFrameWrite?(
    observer: (
      frame: LifecycleFrame,
      envelope: Readonly<Record<string, unknown>>,
    ) => void,
  ): () => void;
}
export interface LifecycleLaunchProfile {
  profile: string;
  provider: PipelineProvider;
  productProjection: Record<string, unknown>;
  contractOverrides: {
    setting: string;
    reason: string;
    value?: unknown;
    scenarios?: string[];
  }[];
}

// ---------------------------------------------------------------------------
// Harness and hosts (implemented by harness.ts / hosts.ts)
// ---------------------------------------------------------------------------

export interface PipelineSendInput {
  text: string;
  /** Reattach using canonical persisted dispatch options, as a restored composer does. */
  resume?: boolean;
  /** Explicit user message id where the host supports one. */
  userMessageId?: string;
}

/** A generated message, delivered through the host's production path. */
export interface PipelineGeneratedInput {
  kind: 'watcher' | 'delegation-notice';
  text: string;
  /** Provider-only payload; scenarios register it as a secret. */
  hiddenContextText?: string;
  watcherId?: string;
  deliveryId: string;
}

export interface PipelineSettingsPatch {
  model?: string;
  planMode?: boolean;
}

/** One host surface the scenarios run through. */
export interface PipelineHostAdapter {
  readonly host: PipelineHost;
  readonly provider: PipelineProvider;
  readonly target: PipelineChatTarget;
  /** A user message through the host's production entry point. */
  send(input: PipelineSendInput): Promise<{ userMessageId: string }>;
  deliverGenerated(input: PipelineGeneratedInput): Promise<void>;
  changeSettings(patch: PipelineSettingsPatch): Promise<void>;
  /** The user's Stop for the current turn. */
  stop(): Promise<void>;
  /** Waits until routed provider events and queued commits have drained. */
  drain(): Promise<void>;
}

export interface PipelineChatRegistration {
  captureRows: boolean;
  captureTranscript: 'revision' | 'checkpoint' | 'off';
}

export interface PipelineHarness {
  readonly recorder: PipelineTraceRecorder;
  /** Durable journal records appended by this harness, in transaction order. */
  readonly storageTransactions: readonly ChatJournalRecord[];
  /** Every repository transaction attempt, including unapplied/no-op attempts. */
  getStorageTransactionCount(): number;
  /** Real drop-gate calls, before the best-effort external sink. */
  readonly dropDiagnosticCalls: readonly ChatEventDrop[];
  /** Drop records delivered to observability or the canonical service sink. */
  readonly dropDiagnostics: readonly SessionDiagnosticRecord[];
  registerChat(
    target: PipelineChatTarget,
    registration: PipelineChatRegistration,
  ): void;
  host(
    kind: PipelineHost,
    provider: PipelineProvider,
    target: PipelineChatTarget,
    options?: PipelineHostOptions,
  ): Promise<PipelineHostAdapter>;
  checkpoint(
    label: string,
    target?: PipelineChatTarget,
    extra?: { userInitiated?: boolean },
  ): Promise<void>;
  /** Holds durable commit publication (existing repository test hook). */
  holdCommits(): void;
  releaseCommits(): void;
  /** Holds the queue's provider-event drain barrier for one chat. */
  holdDrainBarrier(target: PipelineChatTarget): void;
  releaseDrainBarrier(target: PipelineChatTarget): void;
  /** Advances the logical clock and runs due scheduled work. */
  advanceLogicalClock(ms: number): Promise<void>;
  /** Rejects if any tap failed; always tears everything down. */
  dispose(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Invariant checker (implemented by invariants.ts / invariant-staging.ts)
// ---------------------------------------------------------------------------

/** Context a scenario gives the checker beyond the trace. */
export interface InvariantContext {
  /** Text that must never appear in a queue broadcast or provider-bound frame. */
  secrets: readonly string[];
  /** Queued-delivery bound after a `delivery-eligible` checkpoint (logical ms). */
  deliveryBoundMs: number;
  /** Bound on an armed gate after a `drained` checkpoint (logical ms). */
  gateBoundMs: number;
  /** Enforce absolute timing targets (invariants 11 and 16). Opt-in. */
  absoluteTiming: boolean;
  /**
   * Check the full turn-state claims, on by default as real traces carry
   * canonical turn authority. Synthetic partial-claim fixtures turn it off.
   */
  fullTurnStateClaims?: boolean;
}

/** Explicit, test-only full-claim audit; staging and ordinary checks ignore it. */
export interface DormantInvariantOptions {
  /** Matching full-history execution for the bounded-window differential. */
  fullTranscriptTrace?: readonly PipelineTraceEvent[];
}

export interface DormantInvariantResult {
  violations: readonly InvariantViolation[];
  activation: Readonly<Partial<Record<InvariantId, number>>>;
}

export type InvariantId =
  | 1
  | 2
  | 3
  | 4
  | 5
  | 6
  | 7
  | 8
  | 9
  | 10
  | 11
  | 12
  | 13
  | 14
  | 15
  | 16
  | 17
  | 18
  | 19
  | 20
  | 21;

/**
 * `enabled`: the checker enforces the whole invariant. `partial`: it enforces
 * only `subclaims`. `deferred`: a later phase makes it true. `external`: only
 * Electron or web flows can check it.
 */
export type InvariantStatus = 'enabled' | 'partial' | 'deferred' | 'external';

export interface InvariantStagingEntry {
  status: InvariantStatus;
  /** Phase ids (as in the plan README) that made the enforced part true. */
  introducedBy: readonly string[];
  /**
   * The phase whose landing must enable more of it. Required unless enabled,
   * or unless `coveredBy` names where the rest is checked.
   */
  enableAfter?: string;
  /**
   * Repository-relative specs that check the part the harness cannot: the
   * Electron and web flows, or the opt-in real-time runs (turn-state 43i).
   */
  coveredBy?: readonly string[];
  /** What `partial` enforces; empty otherwise. */
  subclaims: readonly string[];
  /** Why it is staged this way, and where else it is covered. */
  reason: string;
}

export interface InvariantViolation {
  id: InvariantId;
  message: string;
  /** Trace `seq` values of the events that show the violation. */
  seqs: readonly number[];
}

/**
 * Phases shipped on this branch. A test keeps this equal to the `shipped`
 * rows of the plan README, so marking a phase shipped forces a staging review.
 */
export const SHIPPED_PHASES: readonly string[] = [
  '00',
  '01',
  '02a',
  '02b',
  '02c',
  '02d',
  '02e',
  '02f',
  '03',
  '04',
  '05',
  '06',
  '07',
  '08',
  '09',
  '10',
  '11a',
  '11b',
  '11c',
  '12',
  '13a',
  '13b',
  '14',
  '15a',
  '15b',
  '15c',
  '16',
  '17',
  '18',
  '19a',
  '19b',
  '19c',
  '19d',
  '20',
  '21',
  '22',
  '23a',
  '23b',
  '23c',
  '23d',
  '24a',
  '24b',
  '25',
  '26',
  '27',
  '28',
  '29',
  '30',
  '31',
  '32',
  '33a',
  '33b',
  '33c',
  '33d',
  '34',
  '35a',
  '35b',
  '35c',
  '35c2',
  '35c2b',
  '35c3',
  '35c4a',
  '35c4b',
  '35c4c',
  '35c4d',
  '35c4',
  '35c5a',
  '35c5b',
  '35c5c',
  '35c5d',
  '35c5',
  '35c6a',
  '35c6b',
  '35c6c',
  '35c6d',
  '35c6e',
  '35c6f',
  '35c6',
  '35d1',
  '35d2',
  '35d',
  '36a',
  '36b',
  '36c',
  '36d',
  '36e',
  '36',
  '37',
  '38a',
  '38b',
  '38c',
  '38',
  '39a',
  '39b',
  '39',
  '40a',
  '40b',
  '40c',
  '40d',
  '40e',
  '40f',
  '40',
  '41a',
  '41b',
  '41c',
  '41d',
  '41e',
  '41f',
  '41g',
  '41',
  '42a',
  '42b',
  '42c',
  '42d',
  '42e',
  '42f',
  '42g',
  '42h',
  '42',
  '43a',
  '43b',
  '43c',
  '43d',
  '43e',
  '43f',
  '43g',
  '43h',
  '43i',
  '43',
];
