import type {
  AgentDelegationTranscriptItem,
  DelegationNestingState,
} from './transcript';
import {
  DELEGATION_CAPABILITY_ID_PATTERN,
  DELEGATION_CAPABILITY_LIMITS,
  type DelegationCapabilitySummary,
} from './capabilities';
export * from './capabilities';
export * from './queues';
export * from './transcript';
import { isThinkingLevel, type ThinkingLevel } from '../thinking';
import type { ChatInputAdmission } from '../portal/input-delivery';
import {
  DELEGATION_IF_BUSY_VALUES,
  type AgentDelegationPhase,
  type AgentDelegationQueueState,
  type DelegationIfBusy,
} from './queues';

/** Stable lifecycle contract; harness identifiers are host-resolved open strings. */
export type AgentDelegationStatus =
  | 'pending'
  | 'running'
  | 'interrupted'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'deadline_exceeded';

export type AgentDelegationTerminalStatus = Extract<
  AgentDelegationStatus,
  'completed' | 'failed' | 'cancelled' | 'deadline_exceeded'
>;

export type DelegateSettledStatus = Extract<
  AgentDelegationStatus,
  'completed' | 'failed' | 'cancelled' | 'deadline_exceeded' | 'interrupted'
>;

export type DelegationStopReason =
  | 'parent_cancelled'
  | 'user_cancelled'
  | 'deadline_exceeded'
  | 'shutdown'
  | 'policy_revoked'
  /** An agent (the root chat's agent or a delegate) stopped this delegation. */
  | 'stopped_by_parent'
  /** An ancestor of this delegation was stopped, by the user or an agent. */
  | 'ancestor_stopped';

export const DELEGATION_STOP_REASONS = [
  'parent_cancelled',
  'user_cancelled',
  'deadline_exceeded',
  'shutdown',
  'policy_revoked',
  'stopped_by_parent',
  'ancestor_stopped',
] as const satisfies readonly DelegationStopReason[];

export function isDelegationStopReason(
  value: unknown,
): value is DelegationStopReason {
  return (
    typeof value === 'string' &&
    DELEGATION_STOP_REASONS.some((reason) => reason === value)
  );
}

/** Who stopped a delegation: the user, or an agent at a given depth. */
export type DelegationStoppedBy =
  | { readonly kind: 'user' }
  | {
      readonly kind: 'agent';
      /** 0 for the root chat's agent. */
      readonly depth: number;
      /** Absent for the root chat's agent. */
      readonly delegationId?: string;
      readonly description?: string;
    };

/** Direct child IDs reported on one Inspect or List entry, most recent last. */
export const DELEGATION_CHILD_ID_LIMIT = 64;

export type AgentDelegationErrorCode =
  | 'invalid_request'
  | 'capability_unavailable'
  | 'route_unavailable'
  | 'auth_required'
  | 'interaction_required'
  | 'policy_blocked'
  | 'capacity_exceeded'
  | 'parent_unavailable'
  | 'launch_uncertain'
  | 'runtime_error'
  /** An isolated apply changed nothing; `apply` says why and what to do. */
  | 'apply_failed'
  /** An agent stopped this delegation or one of its ancestors. */
  | 'terminated_by_parent';

export interface AgentDelegationError {
  readonly code: AgentDelegationErrorCode;
  /** Safe display text; never a raw transport/configuration error. */
  readonly message: string;
  readonly retryable: boolean;
  /** Present with `apply_failed`. */
  readonly apply?: DelegationApplyFailure;
}

/**
 * The one denial every delegation tool (Inspect, Get Delegate Output, Stop,
 * Message, Watch, List) returns for a delegation outside the caller's subtree.
 * Distinct from `invalid_request`, which means the request itself is malformed.
 */
export const DELEGATION_NOT_DESCENDANT_ERROR: AgentDelegationError =
  Object.freeze({
    code: 'parent_unavailable',
    message: 'That delegation is not one of your descendants.',
    retryable: false,
  });

export type AgentDelegationResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: AgentDelegationError };

export interface AgentDelegationSpawnRequest {
  readonly modelId: string;
  readonly description: string;
  readonly prompt: string;
  readonly executionMode: 'background' | 'foreground';
  readonly contextPolicy: 'task_only';
  readonly isolation: 'shared_worktree' | 'worktree';
  readonly permissions?: { readonly writePaths: readonly string[] };
  readonly thinkingLevel?: ThinkingLevel;
  readonly fastMode?: boolean;
  /** Explicit per-child opt-in; omission never grants delegation authority. */
  readonly allowNestedDelegation?: boolean;
  /** Omitted means inherit; only false changes the default behavior. */
  readonly inheritCapabilities?: boolean;
  /**
   * Opaque catalog IDs from List Delegates { includeCapabilities } or Search
   * Deferred Tools.
   */
  readonly capabilities?: readonly string[];
  /** Omitted means use the caller's own discovery permission at spawn. */
  readonly allowCapabilityDiscovery?: boolean;
  /** Queue until a slot is free, or fail fast with capacity_exceeded. */
  readonly ifBusy?: DelegationIfBusy;
  readonly name?: string;
}

export interface AgentDelegationWaitRequest {
  readonly delegationIds: readonly string[];
  readonly timeoutMs: number;
}

export interface ManageDelegateWorktreeRequest {
  readonly delegationId: string;
  readonly operation: 'apply' | 'discard';
}

export type MessageDelegateRequest =
  | {
      readonly delegationId: string;
      readonly operation: 'follow_up';
      readonly message: string;
      readonly permissions?: { readonly writePaths: readonly string[] };
      readonly ifBusy?: DelegationIfBusy;
    }
  | {
      readonly delegationId: string;
      readonly operation: 'steer';
      readonly message: string;
      readonly ifBusy?: DelegationIfBusy;
    }
  | {
      readonly delegationId: string;
      readonly operation: 'interrupt';
    };

/** List Delegates `{ underDelegationId }`: only that delegation's descendants. */
export interface DelegationListFilter {
  readonly underDelegationId?: string;
}

export interface GetDelegateOutputRequest {
  readonly delegationId: string;
  readonly resultIndex?: number;
}

export interface WatchDelegatesRequest {
  readonly delegationIds: readonly string[];
  readonly mode: 'any' | 'all';
  readonly timeoutMs: number;
}

export interface RequestSteeringRequest {
  readonly message: string;
}

export interface DelegateOutput {
  readonly resultIndex: number;
  readonly runGeneration: number;
  readonly status: DelegateSettledStatus;
  readonly finalText?: string;
  readonly partialText?: string;
  readonly outputTruncated: boolean;
  readonly error?: AgentDelegationError;
  readonly usage?: AgentDelegationUsage;
}

export interface GetDelegateOutputValue {
  readonly delegationId: string;
  readonly currentRunGeneration: number;
  readonly currentStatus: AgentDelegationStatus;
  readonly latestResultIndex: number | null;
  readonly result: DelegateOutput | null;
  readonly currentPhase?: AgentDelegationPhase;
  readonly queue?: AgentDelegationQueueState;
}

export interface DelegateWatchTarget {
  readonly delegationId: string;
  readonly runGeneration: number;
}

export interface WatchDelegatesValue {
  readonly watcherId: string;
  readonly mode: 'any' | 'all';
  readonly deadlineAt: number;
  readonly targets: readonly DelegateWatchTarget[];
}

export interface DelegateWatchEvent {
  readonly watcherId: string;
  readonly outcome: 'completed' | 'timeout';
  readonly mode: 'any' | 'all';
  readonly deadlineAt: number;
  readonly targets: readonly {
    readonly delegationId: string;
    readonly runGeneration: number;
    readonly status: AgentDelegationStatus;
    readonly resultIndex: number | null;
    readonly phase?: AgentDelegationPhase;
    /** Why a stopped run settled. A content-free code, never output. */
    readonly exitReason?: DelegationStopReason;
  }[];
}

export interface PersistedAgentOverlaySummary {
  readonly agentDefinitionId: string;
  readonly agentDefinitionRevision: string;
  readonly agentDefinitionHash: string;
  readonly pluginProjectionHash: string;
}

/** Explicit public allowlist. Private execution snapshots are a separate type. */
export interface PersistedAgentRouteSnapshot {
  readonly selectedModelId: string;
  readonly selectedModelLabel?: string;
  readonly runtimeModelLabel?: string;
  readonly runtimeModelId: string;
  readonly harnessId: string;
  readonly runtimeKind: string;
  readonly runnerRegistrationId: string;
  readonly runtimeVersion: string;
  readonly adapterVersion: string;
  readonly modelSource: string;
  readonly providerType: string;
  readonly assignmentRevision: string;
  readonly routeId?: string;
  readonly billingAuthority: string;
  readonly aiCreditsRouted: boolean;
  readonly requestedThinkingLevel?: ThinkingLevel;
  readonly effectiveThinkingLevel?: ThinkingLevel;
  /** Unknown extensions may survive history but do not grant authority. */
  readonly capabilities: readonly string[];
  readonly supportedThinkingLevels: readonly ThinkingLevel[];
  readonly capabilitySnapshotHash: string;
  readonly capabilityGeneration: number;
  readonly policyRevision: string;
  readonly agentOverlay?: PersistedAgentOverlaySummary;
}

/** Cumulative totals for this child run, never deltas to add repeatedly. */
export interface AgentDelegationUsage {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cachedInputTokens?: number;
  readonly cacheCreationInputTokens?: number;
  readonly costUsd?: number;
}

/**
 * A file an isolated delegate's worktree differs on from its starting commit,
 * as Git reports it. Read on request for display; never retained.
 */
export interface DelegationWorkspaceChange {
  /** `/`-separated, relative to the worktree root. */
  readonly path: string;
  readonly change: 'added' | 'modified' | 'deleted';
  /** Unified diff from the delegate's starting copy, bounded for display.
   * Absent for a file that is protected, not text, or over 32 MiB. */
  readonly diff?: string;
  readonly diffTruncated?: boolean;
}

export interface DelegationWorkspaceChanges {
  readonly files: readonly DelegationWorkspaceChange[];
  /** Changed files beyond those listed. */
  readonly omittedFiles?: number;
}

/**
 * Why one delegated file could not be applied to the parent checkout:
 * - `parent_changed`: the parent's file differs from the copy the delegate
 *   edited (changed, created, or deleted in the parent).
 * - `too_large`: a parent, delegate or starting copy exceeds the 32 MiB
 *   per-file apply limit.
 * - `not_text`: a parent, delegate or starting copy is binary or not UTF-8
 *   text.
 * - `not_regular_file`: the parent's or delegate's path is a directory, a
 *   link, a submodule, or a hard-linked file.
 * - `protected_path`: a protected path such as `.env`, `.git` or a key file.
 * - `outside_write_grant`: outside the delegate's current write grants.
 * - `unreconciled`: reported by earlier versions for a recorded edit that did
 *   not match the delegate's worktree. Apply now reads the worktree itself.
 * - `approval_denied`: the parent's approval policy or the user declined it.
 * - `write_failed`: the write failed; every file the apply wrote was restored.
 * - `not_restored`: written by the apply and not put back. Either it changed
 *   again afterwards and keeps that newer content, or restoring it failed and
 *   is retried when the parent applies again or the app restarts.
 */
export const DELEGATION_APPLY_ISSUE_REASONS = [
  'parent_changed',
  'too_large',
  'not_text',
  'not_regular_file',
  'protected_path',
  'outside_write_grant',
  'unreconciled',
  'approval_denied',
  'write_failed',
  'not_restored',
] as const;
export type DelegationApplyIssueReason =
  (typeof DELEGATION_APPLY_ISSUE_REASONS)[number];

export interface DelegationApplyIssue {
  /** `/`-separated, relative to the parent checkout. */
  readonly path: string;
  readonly reason: DelegationApplyIssueReason;
  /** For `parent_changed`: unified diff from the delegate's starting copy
   * (`---`) to the parent's current file (`+++`). */
  readonly parentDiff?: string;
  /** The diff was shortened or omitted to stay within its bound. */
  readonly parentDiffTruncated?: boolean;
}

/**
 * - `conflict`: one or more files cannot be applied as captured; see issues.
 * - `interrupted`: the app stopped mid-apply; its writes were restored.
 * - `unavailable`: the parent cannot apply now, for example in plan mode.
 */
export const DELEGATION_APPLY_FAILURE_REASONS = [
  'conflict',
  'approval_denied',
  'write_failed',
  'cancelled',
  'interrupted',
  'unavailable',
] as const;
export type DelegationApplyFailureReason =
  (typeof DELEGATION_APPLY_FAILURE_REASONS)[number];

/** A failed apply changes nothing in the parent checkout (apart from files
 * reported as `not_restored`) and leaves the delegate and its worktree as
 * they were, so the delegate can correct its work and the parent can retry. */
export interface DelegationApplyFailure {
  readonly reason: DelegationApplyFailureReason;
  /** In first-change order, bounded by `DELEGATION_APPLY_FAILURE_LIMITS`. */
  readonly issues: readonly DelegationApplyIssue[];
  /** Issues left out to stay within the bound. */
  readonly omittedIssues?: number;
  /** Concrete next steps for the parent. */
  readonly guidance: string;
}

export const DELEGATION_APPLY_FAILURE_LIMITS = Object.freeze({
  issues: 64,
  /** UTF-8 bytes of one `parentDiff`. */
  diffBytes: 4_096,
  /** UTF-8 bytes of every `parentDiff` in one failure. */
  totalDiffBytes: 16_384,
  guidanceCharacters: 1_024,
});

export interface AgentDelegationEvent {
  readonly delegationId: string;
  readonly runGeneration: number;
  readonly sequence: number;
  readonly occurredAt: number;
  readonly event:
    | { readonly type: 'started'; readonly nativeSessionId?: string }
    | {
        readonly type: 'progress';
        readonly text: string;
        readonly truncated?: boolean;
      }
    | {
        readonly type: 'transcript';
        readonly items: readonly AgentDelegationTranscriptItem[];
        readonly truncated?: boolean;
      }
    | { readonly type: 'usage'; readonly usage: AgentDelegationUsage }
    | { readonly type: 'approval'; readonly pending: boolean }
    | {
        readonly type: 'terminal';
        readonly status: AgentDelegationTerminalStatus;
        readonly finalText?: string;
        readonly error?: AgentDelegationError;
        readonly usage?: AgentDelegationUsage;
      };
}

/** Launch-time observation only. Reads can observe later parent edits. */
export interface AgentDelegationWorkspaceObservation {
  readonly consistency: 'live_shared_worktree';
  readonly headRevision: string | null;
  /** Null means Git state could not be established within the bounded probe. */
  readonly dirty: boolean | null;
  readonly observedAt: number;
}

export interface AgentDelegationSnapshot {
  readonly depth?: number;
  /** Whether this delegate may start its own delegates, and if not, why. */
  readonly nestedDelegation?: DelegationNestingState;
  readonly parentDelegationId?: string;
  readonly parentDescription?: string;
  readonly permissions?: { readonly writePaths: readonly string[] };
  readonly workspaceDiscarded?: boolean;
  readonly runGeneration?: number;
  /** Stable one-based index for this settled run, when published. */
  readonly resultIndex?: number;
  readonly delegationId: string;
  readonly status: AgentDelegationStatus;
  readonly routeSnapshot?: PersistedAgentRouteSnapshot;
  /** Known before asynchronous route preparation has completed. */
  readonly requestedModelId?: string;
  readonly control?: {
    readonly operationId: string;
    readonly operation:
      | 'follow_up'
      | 'resume'
      | 'steer'
      | 'interrupt'
      | 'apply'
      | 'discard';
    readonly status: 'accepted' | 'completed' | 'failed';
    readonly steeringDelivery?: ChatInputAdmission;
    readonly error?: string;
    /** Why a failed `apply` changed nothing, and how to recover. */
    readonly applyFailure?: DelegationApplyFailure;
  };
  readonly isolatedWorkspace?: {
    readonly revision: string;
    readonly dirtyParentChangesIncluded: false;
  };
  readonly stopRequested?: {
    readonly operationId: string;
    readonly status: 'accepted' | 'completed' | 'failed';
  };
  readonly approvalPending?: boolean;
  readonly workspaceObservation?: AgentDelegationWorkspaceObservation;
  readonly nativeSessionId?: string;
  readonly partialText?: string;
  readonly finalText?: string;
  readonly outputTruncated: boolean;
  readonly error?: AgentDelegationError;
  readonly usage?: AgentDelegationUsage;
  readonly stopReason?: DelegationStopReason;
  /** True only when the user stopped this delegation itself. */
  readonly cancelledByUser?: boolean;
  /** Who stopped this delegation (or the ancestor whose stop reached it). */
  readonly stoppedBy?: DelegationStoppedBy;
  /**
   * Direct children, in creation order and bounded by
   * `DELEGATION_CHILD_ID_LIMIT` (the most recent are kept). Present on
   * Inspect and List entries when the delegation has started children.
   */
  readonly childDelegationIds?: readonly string[];
  readonly capabilities?: DelegationCapabilitySummary;
  readonly phase?: AgentDelegationPhase;
  readonly queue?: AgentDelegationQueueState;
}

export interface AgentDelegationWaitResult {
  readonly timedOut: boolean;
  readonly snapshots: readonly AgentDelegationSnapshot[];
}

export const AGENT_DELEGATION_INPUT_LIMITS = Object.freeze({
  idCharacters: 256,
  descriptionCharacters: 200,
  promptCharacters: 32_768,
  nameCharacters: 128,
  waitIds: 16,
  /** Thirty minutes: long enough for a planner to sleep until its children
   * settle instead of re-arming a watch every minute. */
  waitTimeoutMs: 1_800_000,
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isDelegationIfBusy(value: unknown): value is DelegationIfBusy {
  return (
    typeof value === 'string' &&
    DELEGATION_IF_BUSY_VALUES.some((entry) => entry === value)
  );
}

function boundedText(value: unknown, limit: number): value is string {
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    value.length <= limit &&
    !value.includes('\0')
  );
}

function isId(value: unknown): value is string {
  return (
    boundedText(value, AGENT_DELEGATION_INPUT_LIMITS.idCharacters) &&
    !/[\r\n]/.test(value) &&
    value === value.trim()
  );
}

function invalidRequest(
  message = 'Invalid delegation request.',
): AgentDelegationResult<never> {
  return {
    ok: false,
    error: {
      code: 'invalid_request',
      message,
      retryable: false,
    },
  };
}

export function parseAgentDelegationSpawnRequest(
  input: unknown,
): AgentDelegationResult<AgentDelegationSpawnRequest> {
  if (!isRecord(input)) return invalidRequest();
  const fields = [
    'modelId',
    'description',
    'prompt',
    'executionMode',
    'contextPolicy',
    'isolation',
    'thinkingLevel',
    'fastMode',
    'allowNestedDelegation',
    'inheritCapabilities',
    'capabilities',
    'allowCapabilityDiscovery',
    'ifBusy',
    'name',
    'permissions',
  ];
  if (Object.keys(input).some((key) => !fields.includes(key)))
    return invalidRequest();
  if (
    !isId(input.modelId) ||
    !boundedText(
      input.description,
      AGENT_DELEGATION_INPUT_LIMITS.descriptionCharacters,
    ) ||
    !boundedText(input.prompt, AGENT_DELEGATION_INPUT_LIMITS.promptCharacters)
  )
    return invalidRequest();
  if (input.fastMode !== undefined && typeof input.fastMode !== 'boolean')
    return invalidRequest();
  if (
    input.allowNestedDelegation !== undefined &&
    typeof input.allowNestedDelegation !== 'boolean'
  )
    return invalidRequest();
  if (
    input.inheritCapabilities !== undefined &&
    typeof input.inheritCapabilities !== 'boolean'
  )
    return invalidRequest();
  if (
    input.allowCapabilityDiscovery !== undefined &&
    typeof input.allowCapabilityDiscovery !== 'boolean'
  )
    return invalidRequest();
  let parsedCapabilities: string[] | undefined;
  if (input.capabilities !== undefined) {
    const rawCapabilities = input.capabilities;
    if (
      !Array.isArray(rawCapabilities) ||
      rawCapabilities.length > DELEGATION_CAPABILITY_LIMITS.explicit
    )
      return invalidRequest();
    const capabilityValues: unknown[] = rawCapabilities;
    const seenCapabilities = new Set<string>();
    const capabilities: string[] = [];
    for (const capability of capabilityValues) {
      if (
        typeof capability !== 'string' ||
        !DELEGATION_CAPABILITY_ID_PATTERN.test(capability) ||
        seenCapabilities.has(capability)
      )
        return invalidRequest();
      seenCapabilities.add(capability);
      capabilities.push(capability);
    }
    if (capabilities.length > 0) parsedCapabilities = capabilities;
  }
  let parsedIfBusy: DelegationIfBusy | undefined;
  if (input.ifBusy !== undefined) {
    if (!isDelegationIfBusy(input.ifBusy)) return invalidRequest();
    parsedIfBusy = input.ifBusy;
  }
  if (
    input.thinkingLevel !== undefined &&
    !isThinkingLevel(input.thinkingLevel)
  )
    return invalidRequest();
  if (
    input.name !== undefined &&
    !boundedText(input.name, AGENT_DELEGATION_INPUT_LIMITS.nameCharacters)
  )
    return invalidRequest();
  let parsedPermissions:
    | NonNullable<AgentDelegationSpawnRequest['permissions']>
    | undefined;
  if (input.permissions !== undefined) {
    const rawPermissions = input.permissions;
    if (
      !isRecord(rawPermissions) ||
      Object.keys(rawPermissions).some((key) => key !== 'writePaths') ||
      !Array.isArray(rawPermissions.writePaths)
    )
      return invalidRequest('permissions must contain a writePaths array.');
    if (rawPermissions.writePaths.length > 64)
      return invalidRequest(
        'permissions.writePaths must contain at most 64 paths.',
      );
    const writePaths: string[] = [];
    const entries: unknown[] = rawPermissions.writePaths;
    for (let index = 0; index < entries.length; index++) {
      const entry = entries[index];
      const path = typeof entry === 'string' ? entry.replace(/\/+$/, '') : '';
      if (
        typeof entry !== 'string' ||
        entry.length === 0 ||
        entry.length >= 4096 ||
        (entry !== '.' &&
          !path
            .split('/')
            .every(
              (part) =>
                part.length > 0 &&
                part !== '.' &&
                part !== '..' &&
                !/[\\:*?]/.test(part) &&
                Array.from(part).every(
                  (character) => character.charCodeAt(0) >= 32,
                ),
            ))
      )
        return invalidRequest(
          `permissions.writePaths[${index}] must be a relative path without empty, dot, or parent segments, or "." for the project root.`,
        );
      writePaths.push(path);
    }
    parsedPermissions = { writePaths };
  }
  const executionMode =
    input.executionMode === undefined ? 'background' : input.executionMode;
  if (executionMode !== 'background' && executionMode !== 'foreground')
    return invalidRequest();
  if (
    (input.contextPolicy !== undefined &&
      input.contextPolicy !== 'task_only') ||
    (input.isolation !== undefined &&
      input.isolation !== 'shared_worktree' &&
      input.isolation !== 'worktree')
  ) {
    return {
      ok: false,
      error: {
        code: 'capability_unavailable',
        message:
          'The requested delegation context or isolation mode is unavailable.',
        retryable: false,
      },
    };
  }
  return {
    ok: true,
    value: {
      modelId: input.modelId,
      description: input.description,
      prompt: input.prompt,
      executionMode,
      contextPolicy: 'task_only',
      isolation:
        input.isolation === 'worktree' ? 'worktree' : 'shared_worktree',
      ...(parsedPermissions ? { permissions: parsedPermissions } : {}),
      ...(input.fastMode !== undefined ? { fastMode: input.fastMode } : {}),
      ...(input.allowNestedDelegation !== undefined
        ? { allowNestedDelegation: input.allowNestedDelegation }
        : {}),
      ...(input.inheritCapabilities !== undefined
        ? { inheritCapabilities: input.inheritCapabilities }
        : {}),
      ...(parsedCapabilities ? { capabilities: parsedCapabilities } : {}),
      ...(input.allowCapabilityDiscovery !== undefined
        ? { allowCapabilityDiscovery: input.allowCapabilityDiscovery }
        : {}),
      ...(parsedIfBusy !== undefined ? { ifBusy: parsedIfBusy } : {}),
      ...(input.thinkingLevel !== undefined
        ? { thinkingLevel: input.thinkingLevel }
        : {}),
      ...(input.name !== undefined ? { name: input.name } : {}),
    },
  };
}

export function parseAgentDelegationWaitRequest(
  input: unknown,
): AgentDelegationResult<AgentDelegationWaitRequest> {
  if (
    !isRecord(input) ||
    Object.keys(input).some(
      (key) => key !== 'delegationIds' && key !== 'timeoutMs',
    )
  )
    return invalidRequest();
  const ids: unknown = input.delegationIds;
  if (
    !Array.isArray(ids) ||
    ids.length === 0 ||
    ids.length > AGENT_DELEGATION_INPUT_LIMITS.waitIds ||
    !ids.every(isId) ||
    new Set(ids).size !== ids.length
  )
    return invalidRequest();
  const timeoutMs = input.timeoutMs;
  if (
    typeof timeoutMs !== 'number' ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 0 ||
    timeoutMs > AGENT_DELEGATION_INPUT_LIMITS.waitTimeoutMs
  )
    return invalidRequest();
  return { ok: true, value: { delegationIds: [...ids], timeoutMs } };
}

export function parseManageDelegateWorktreeRequest(
  input: unknown,
): AgentDelegationResult<ManageDelegateWorktreeRequest> {
  if (
    !isRecord(input) ||
    Object.keys(input).some(
      (key) => key !== 'delegationId' && key !== 'operation',
    ) ||
    !isId(input.delegationId) ||
    (input.operation !== 'apply' && input.operation !== 'discard')
  )
    return invalidRequest();
  return {
    ok: true,
    value: { delegationId: input.delegationId, operation: input.operation },
  };
}

/**
 * The tool spells it `if_busy`; a parsed request carries `ifBusy`, and the
 * broker parses that request again. Both spellings at once is invalid.
 */
function messageIfBusy(
  input: Record<string, unknown>,
): AgentDelegationResult<DelegationIfBusy | undefined> {
  if (input.if_busy !== undefined && input.ifBusy !== undefined)
    return invalidRequest();
  const value = input.if_busy ?? input.ifBusy;
  if (value !== undefined && !isDelegationIfBusy(value))
    return invalidRequest();
  return { ok: true, value };
}

export function parseMessageDelegateRequest(
  input: unknown,
): AgentDelegationResult<MessageDelegateRequest> {
  if (!isRecord(input) || !isId(input.delegationId)) return invalidRequest();
  if (input.operation === 'interrupt') {
    if (
      Object.keys(input).some(
        (key) => key !== 'delegationId' && key !== 'operation',
      )
    )
      return invalidRequest();
    return {
      ok: true,
      value: { delegationId: input.delegationId, operation: 'interrupt' },
    };
  }
  const ifBusy = messageIfBusy(input);
  if (!ifBusy.ok) return ifBusy;
  if (input.operation === 'steer') {
    if (
      Object.keys(input).some(
        (key) =>
          key !== 'delegationId' &&
          key !== 'operation' &&
          key !== 'message' &&
          key !== 'if_busy' &&
          key !== 'ifBusy',
      ) ||
      !boundedText(
        input.message,
        AGENT_DELEGATION_INPUT_LIMITS.promptCharacters,
      )
    )
      return invalidRequest();
    return {
      ok: true,
      value: {
        delegationId: input.delegationId,
        operation: 'steer',
        message: input.message,
        ...(ifBusy.value !== undefined ? { ifBusy: ifBusy.value } : {}),
      },
    };
  }
  if (input.operation !== 'follow_up') return invalidRequest();
  if (
    Object.keys(input).some(
      (key) =>
        key !== 'delegationId' &&
        key !== 'operation' &&
        key !== 'message' &&
        key !== 'permissions' &&
        key !== 'if_busy' &&
        key !== 'ifBusy',
    ) ||
    !boundedText(input.message, AGENT_DELEGATION_INPUT_LIMITS.promptCharacters)
  )
    return invalidRequest();
  let permissions: AgentDelegationSpawnRequest['permissions'];
  if (input.permissions !== undefined) {
    const parsed = parseAgentDelegationSpawnRequest({
      modelId: 'message-delegate-validation',
      description: 'Validate delegate message',
      prompt: input.message,
      permissions: input.permissions,
    });
    if (!parsed.ok) return parsed;
    if (!parsed.value.permissions) return invalidRequest();
    permissions = parsed.value.permissions;
  }
  return {
    ok: true,
    value: {
      delegationId: input.delegationId,
      operation: 'follow_up',
      message: input.message,
      ...(permissions ? { permissions } : {}),
      ...(ifBusy.value !== undefined ? { ifBusy: ifBusy.value } : {}),
    },
  };
}

export function parseGetDelegateOutputRequest(
  input: unknown,
): AgentDelegationResult<GetDelegateOutputRequest> {
  if (
    !isRecord(input) ||
    Object.keys(input).some(
      (key) => key !== 'delegationId' && key !== 'resultIndex',
    ) ||
    !isId(input.delegationId) ||
    (input.resultIndex !== undefined &&
      (typeof input.resultIndex !== 'number' ||
        !Number.isSafeInteger(input.resultIndex) ||
        input.resultIndex < 1))
  )
    return invalidRequest();
  return {
    ok: true,
    value: {
      delegationId: input.delegationId,
      ...(input.resultIndex !== undefined
        ? { resultIndex: input.resultIndex }
        : {}),
    },
  };
}

export function parseWatchDelegatesRequest(
  input: unknown,
): AgentDelegationResult<WatchDelegatesRequest> {
  if (
    !isRecord(input) ||
    Object.keys(input).some(
      (key) => key !== 'delegationIds' && key !== 'mode' && key !== 'timeoutMs',
    ) ||
    (input.mode !== 'any' && input.mode !== 'all')
  )
    return invalidRequest();
  const parsed = parseAgentDelegationWaitRequest({
    delegationIds: input.delegationIds,
    timeoutMs: input.timeoutMs,
  });
  return parsed.ok
    ? {
        ok: true,
        value: { ...parsed.value, mode: input.mode },
      }
    : parsed;
}

export function parseRequestSteeringRequest(
  input: unknown,
): AgentDelegationResult<RequestSteeringRequest> {
  if (
    !isRecord(input) ||
    Object.keys(input).some((key) => key !== 'message') ||
    !boundedText(input.message, AGENT_DELEGATION_INPUT_LIMITS.promptCharacters)
  )
    return invalidRequest();
  return { ok: true, value: { message: input.message } };
}

export * from './user-operations';
