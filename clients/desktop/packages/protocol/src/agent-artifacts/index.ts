import type { PipelineRepairShareTarget } from '../capability-package-repair';
import type { UnifiedEntryRef } from '../unified-entry';
import type { PipelineExecutionScope } from '../pipelines';
import type { SkillShareScope } from '../skills';
import type {
  GitHubWorkflowDefinitionGraph,
  GitHubWorkflowJobSnapshot,
  GitHubWorkflowRunState,
} from '../github-workflows';

/**
 * Closed, presentation-safe destinations that an artifact receipt may expose.
 * These are data locators only: arbitrary renderer actions, routes, panels,
 * focus state, and callbacks are intentionally not representable.
 */
export type AgentArtifactNavigationRequest =
  | {
      kind: 'pipeline_editor';
      pipelineId: string;
      source: 'bundled' | 'user' | 'curated' | 'project' | 'shared';
      projectId?: string;
      worktreeId?: string;
      repoId?: string;
      sharedRemoteId?: string;
    }
  | {
      kind: 'pipeline_execution';
      executionId: string;
      /** The run's owner; a Cowork Work Entry fills `worktreeId`. */
      projectId: string;
      worktreeId: string;
      /** Job to select in the run's panel. Omitted opens the run Summary. */
      jobId?: string;
    }
  | {
      kind: 'installed_skill';
      sourceId: string;
      skillName: string;
      filePath?: string;
    }
  | { kind: 'shared_skill'; skillId: string }
  | {
      kind: 'automation_editor';
      activityId: string;
      section?: 'definition' | 'trigger' | 'runs';
      runId?: string;
    }
  | { kind: 'agent_editor'; agentId: string }
  | { kind: 'shared_agent'; agentId: string }
  | { kind: 'capability_entry'; entry: UnifiedEntryRef }
  | { kind: 'external_url'; url: string }
  | {
      /**
       * A GitHub Actions workflow run. It has no in-app destination: the
       * renderer opens GitHub's own `html_url` in the user's browser. The URL is
       * always the value GitHub returned for the run, never constructed.
       */
      kind: 'github_workflow_run';
      repository: string;
      runId: string;
      htmlUrl: string;
    };

/** Backward-compatible skill viewer deep link used by persisted navigation. */
export type SkillViewerDeepLink =
  | {
      kind: 'installed';
      sourceId: string;
      skillName: string;
      filePath?: string;
    }
  | { kind: 'shared'; skillId: string };

export type AgentResourceErrorCode =
  | 'read_only_source'
  | 'missing_capability'
  | 'authentication_failed'
  | 'authorization_conflict'
  | 'validation_failed'
  | 'stale_content_hash'
  | 'not_found'
  | 'navigation_failed'
  | 'advisor_access_disabled'
  | 'owner_context_unavailable';

/** Normalized, JSON-safe error returned by resource and navigation adapters. */
export interface NormalizedAgentResourceError {
  code: AgentResourceErrorCode;
  message: string;
  retryable: boolean;
}

/**
 * Retry behavior exposed alongside resource action contracts. This describes
 * what a caller must do after an ambiguous transport failure; it is not an
 * idempotency key and does not change App Advisor request-id caching.
 */
export type AgentResourceRetrySemantics =
  | 'idempotent'
  | 'reconcile_before_retry'
  | 'distinct_execution_on_success'
  | 'existing_delete_semantics'
  | 'not_specified';

export type NormalizedAgentArtifactNavigationError =
  NormalizedAgentResourceError;

/** `ok: true` confirms that the destination accepted the navigation dispatch. */
export type AgentArtifactNavigationResponse =
  | { ok: true }
  | { ok: false; error: NormalizedAgentArtifactNavigationError };

export interface BaseAgentArtifactReceiptV1 {
  version: 1;
  kind:
    | 'pipeline'
    | 'skill'
    | 'automation'
    | 'pipeline_run'
    | 'github_workflow_run'
    | 'automation_run'
    | 'agent'
    | 'capability_reference';
  operation: string;
  /** Stable, source-qualified identity used only to collapse duplicate cards. */
  dedupeKey: string;
  /** Previous/alternate source-qualified identities, e.g. before a skill rename. */
  aliases?: string[];
  createdAt: string;
  changedFields?: AgentArtifactChangedField[];
}

export interface PipelineArtifactReceiptV1 extends BaseAgentArtifactReceiptV1 {
  /** Optional for old receipts. Resolves the original saved item when Share is clicked. */
  shareTarget?: PipelineRepairShareTarget;
  kind: 'pipeline';
  source: 'bundled' | 'user' | 'curated' | 'project' | 'shared';
  /** Local identity, retained separately from the shared remote identity. */
  localId?: string;
  /** Canopy Cloud identity, never substituted for a local id. */
  sharedRemoteId?: string;
  name: string;
  description?: string;
  enabled: boolean;
  scopes: PipelineExecutionScope[];
  runModes: Array<'dispatch' | 'plan_ready' | 'task_ready'>;
  jobCount: number;
  stepCount: number;
  navigationTarget: Extract<
    AgentArtifactNavigationRequest,
    { kind: 'pipeline_editor' }
  >;
}

export interface SkillArtifactReceiptV1 extends BaseAgentArtifactReceiptV1 {
  kind: 'skill';
  source: 'installed' | 'shared';
  /** Installed source identity. Present only for installed/imported skills. */
  sourceId?: string;
  /** Installed directory/name identity. Present only for installed skills. */
  installedName?: string;
  /** Shared remote identity. Present only when a remote object exists. */
  sharedSkillId?: string;
  name: string;
  description?: string;
  shareScope?: SkillShareScope;
  /** Presentation-safe owner snapshot for shared skills. */
  owner?: {
    type: 'user' | 'team' | 'organization';
    id: string;
    name?: string;
  };
  canUpdate: boolean;
  navigationTarget: Extract<
    AgentArtifactNavigationRequest,
    { kind: 'installed_skill' | 'shared_skill' }
  >;
}

export interface AutomationArtifactReceiptV1 extends BaseAgentArtifactReceiptV1 {
  kind: 'automation';
  activityId: string;
  name: string;
  enabled: boolean;
  running: boolean;
  schedule: string;
  nextRunAt?: string;
  actionKind: string;
  /** Bounded, presentation-safe target label; never a raw command or prompt. */
  targetSummary: string;
  ifCommandConfigured: boolean;
  navigationTarget: Extract<
    AgentArtifactNavigationRequest,
    { kind: 'automation_editor' }
  >;
}

export interface PipelineRunArtifactReceiptV1 extends BaseAgentArtifactReceiptV1 {
  kind: 'pipeline_run';
  executionId: string;
  pipelineId: string;
  pipelineName: string;
  initialStatus: 'pending' | 'running' | 'paused';
  queuedAt: string;
  startedAt?: string;
  projectId: string;
  worktreeId: string;
  repoId?: string;
  navigationTarget: Extract<
    AgentArtifactNavigationRequest,
    { kind: 'pipeline_execution' }
  >;
}

/**
 * A GitHub Actions workflow run the chat is watching through a
 * `github_workflow_runs` watcher. Unlike pipeline runs, there is no local
 * execution record to read live state from, so the receipt embeds the last
 * observed run state and bounded job cursors; the renderer refreshes it from
 * the watcher's `githubProgress` projection while the watcher is alive and the
 * embedded snapshot remains the record once the watcher has fired.
 */
export interface GitHubWorkflowRunArtifactReceiptV1 extends BaseAgentArtifactReceiptV1 {
  kind: 'github_workflow_run';
  /** The watcher whose polling produced this snapshot. */
  watcherId: string;
  /** Validated `owner/repository`. */
  repository: string;
  /** Positive decimal string. */
  runId: string;
  runAttempt: number;
  workflowName?: string;
  runNumber?: number;
  /** GitHub-provided `html_url`; never constructed. */
  htmlUrl: string;
  state: GitHubWorkflowRunState;
  /** GitHub's `run_started_at`, when it was returned. */
  startedAt?: string;
  observedAt: string;
  /** Job cursors in GitHub's order; absent until the watcher's first jobs read. */
  jobs?: GitHubWorkflowJobSnapshot[];
  /** The run's declared job graph, once its workflow definition was read. */
  definition?: GitHubWorkflowDefinitionGraph;
  navigationTarget: Extract<
    AgentArtifactNavigationRequest,
    { kind: 'github_workflow_run' }
  >;
}

export type AgentArtifactReceiptV1 =
  | PipelineArtifactReceiptV1
  | SkillArtifactReceiptV1
  | AutomationArtifactReceiptV1
  | PipelineRunArtifactReceiptV1
  | GitHubWorkflowRunArtifactReceiptV1
  | AutomationRunArtifactReceiptV1
  | AgentDefinitionArtifactReceiptV1
  | CapabilityReferenceArtifactReceiptV1;

/**
 * Receipts a chat carries from turn to turn while it is watching them. Both
 * kinds describe work that another surface may have started; carrying them
 * keeps the Agent activity card attached to every later turn of the watching
 * chat.
 */
export type AgentArtifactCarryReceiptV1 =
  | PipelineRunArtifactReceiptV1
  | GitHubWorkflowRunArtifactReceiptV1;

/** Additive successful mutation result consumed by transport adapters. */
export type AgentArtifactSuccessResult<
  T extends Record<string, unknown> = Record<string, unknown>,
> = T & { agentArtifacts: AgentArtifactReceiptV1[] };

export type AgentArtifactSuccessResponse<
  T extends Record<string, unknown> = Record<string, unknown>,
> = { ok: true; result: AgentArtifactSuccessResult<T> };

export type AgentArtifactCarryByTurn = Record<
  string,
  AgentArtifactCarryReceiptV1[]
>;

export * from './validation';
export * from './collapse';
export * from './placement';

/** Existing scheduler enums, shared without depending on the desktop runtime. */
export type AutomationRunStatus =
  | 'running'
  | 'success'
  | 'failure'
  | 'skipped'
  | 'canceled'
  | 'missed';
export type AutomationRunTrigger = 'scheduled' | 'manual' | 'catch_up';
export type AutomationSkipReason =
  | 'if_command_exit'
  | 'idempotency'
  | 'already_running';
export const AGENT_ARTIFACT_CHANGED_FIELDS = [
  'name',
  'description',
  'enabled',
  'schedule',
  'action',
  'ifCommand',
  'instructions',
  'baseModel',
  'pluginSelections',
  'content',
  'shareScope',
] as const;
export type AgentArtifactChangedField =
  (typeof AGENT_ARTIFACT_CHANGED_FIELDS)[number];
export type CapabilityItemKind =
  | 'skill'
  | 'pipeline'
  | 'automation'
  | 'agent'
  | 'plugin'
  | 'mcp-server'
  | 'collection';

export interface AutomationRunArtifactReceiptV1 extends BaseAgentArtifactReceiptV1 {
  kind: 'automation_run';
  activityId: string;
  runId: string;
  name: string;
  status: AutomationRunStatus;
  trigger: AutomationRunTrigger;
  skipReason?: AutomationSkipReason;
  scheduledFor: string;
  startedAt: string;
  completedAt?: string;
  durationMs?: number;
  /** Identifiers only; raw errors, prompts and configuration are excluded. */
  executionId?: string;
  chatId?: string;
  navigationTarget: Extract<
    AgentArtifactNavigationRequest,
    { kind: 'automation_editor' }
  >;
}
export interface AgentDefinitionArtifactReceiptV1 extends BaseAgentArtifactReceiptV1 {
  kind: 'agent';
  source: 'local' | 'shared';
  agentId: string;
  name: string;
  description?: string;
  model?: string;
  navigationTarget: Extract<
    AgentArtifactNavigationRequest,
    { kind: 'agent_editor' | 'shared_agent' }
  >;
}
export interface CapabilityReferenceArtifactReceiptV1 extends BaseAgentArtifactReceiptV1 {
  kind: 'capability_reference';
  itemKind: CapabilityItemKind;
  source: string;
  sourceId: string;
  name: string;
  description?: string;
  sourceLabel: string;
  state: 'installed' | 'available' | 'needs-auth' | 'unknown';
  relation: 'found' | 'recommended';
  reason?: string;
  navigationTarget: AgentArtifactNavigationRequest;
}
