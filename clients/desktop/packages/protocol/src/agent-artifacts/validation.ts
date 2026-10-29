import { pipelineRepairShareTargetSchema } from '../capability-package-repair';
import type { UnifiedEntryRef } from '../unified-entry';
import { AGENT_ARTIFACT_CHANGED_FIELDS } from './index';
import type {
  AutomationRunArtifactReceiptV1,
  AgentDefinitionArtifactReceiptV1,
  CapabilityReferenceArtifactReceiptV1,
  AgentArtifactChangedField,
} from './index';
import type {
  AgentArtifactCarryByTurn,
  AgentArtifactCarryReceiptV1,
  AgentArtifactNavigationRequest,
  AgentArtifactReceiptV1,
  AgentResourceErrorCode,
  AutomationArtifactReceiptV1,
  GitHubWorkflowRunArtifactReceiptV1,
  NormalizedAgentArtifactNavigationError,
  NormalizedAgentResourceError,
  PipelineArtifactReceiptV1,
  PipelineRunArtifactReceiptV1,
  SkillArtifactReceiptV1,
  SkillViewerDeepLink,
} from './index';
import {
  GITHUB_WORKFLOW_JOB_CONCLUSIONS,
  GITHUB_WORKFLOW_RUN_CONCLUSIONS,
  GITHUB_WORKFLOW_RUN_INTERMEDIATE_STATUSES,
  type GitHubWorkflowDefinitionGraph,
  type GitHubWorkflowGraphJob,
  type GitHubWorkflowJobSnapshot,
  type GitHubWorkflowRunState,
} from '../github-workflows';

export const AGENT_ARTIFACT_TEXT_LIMITS = {
  operation: 100,
  identity: 512,
  dedupeKey: 8192,
  name: 200,
  description: 1_000,
  schedule: 300,
  actionKind: 100,
  targetSummary: 500,
  aliases: 20,
  /** GitHub job status strings are short; bound them in case GitHub grows one. */
  githubJobStatus: 40,
} as const;

/**
 * Upper bound on embedded GitHub job cursors. Matches the broker's own
 * 500-job limit so a receipt never has to truncate a run the watcher can
 * observe, while a malformed record cannot balloon the chat file.
 */
export const MAX_GITHUB_WORKFLOW_RECEIPT_JOBS = 500;
/** Bounds for an embedded workflow definition graph; larger ones are dropped. */
export const MAX_GITHUB_WORKFLOW_RECEIPT_GRAPH_JOBS = 200;
export const MAX_GITHUB_WORKFLOW_RECEIPT_GRAPH_NAMES = 500;
/**
 * Aggregate persistence budget for carried run snapshots. The revisioned chat
 * command envelope is capped at 1 MiB, so carry uses at most half of it and
 * leaves room for command metadata plus future tab-setting fields.
 */
export const MAX_AGENT_ARTIFACT_CARRY_BYTES = 512 * 1024;

const RESOURCE_ERROR_CODES: ReadonlySet<string> = new Set([
  'read_only_source',
  'missing_capability',
  'authentication_failed',
  'authorization_conflict',
  'validation_failed',
  'stale_content_hash',
  'not_found',
  'navigation_failed',
  'advisor_access_disabled',
  'owner_context_unavailable',
]);

const NAVIGATION_ERROR_CODES: ReadonlySet<string> = new Set([
  'read_only_source',
  'missing_capability',
  'authentication_failed',
  'authorization_conflict',
  'validation_failed',
  'stale_content_hash',
  'not_found',
  'navigation_failed',
]);

const ISO_DATE_TIME_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function boundedString(
  value: unknown,
  maxLength: number,
  options: { allowEmpty?: boolean } = {},
): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  if (!options.allowEmpty && normalized.length === 0) return undefined;
  const slice = normalized.slice(0, maxLength);
  const last = slice.charCodeAt(slice.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? slice.slice(0, -1) : slice;
}

function optionalBoundedString(
  value: unknown,
  maxLength: number,
): string | undefined | null {
  if (value === undefined) return undefined;
  return boundedString(value, maxLength) ?? null;
}

function isIsoDate(value: string): boolean {
  if (!ISO_DATE_TIME_PATTERN.test(value) || !Number.isFinite(Date.parse(value)))
    return false;
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return month >= 1 && month <= 12 && day >= 1 && day <= (days[month - 1] ?? 0);
}

function isoDate(value: unknown): string | undefined {
  const normalized = boundedString(value, 64);
  return normalized && isIsoDate(normalized) ? normalized : undefined;
}

function nonNegativeInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

function boundedAliases(
  value: unknown,
  kind: AgentArtifactReceiptV1['kind'],
): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) return undefined;
  const aliases: string[] = [];
  const seen = new Set<string>();
  for (const candidate of value.slice(0, AGENT_ARTIFACT_TEXT_LIMITS.aliases)) {
    const alias = boundedString(
      candidate,
      AGENT_ARTIFACT_TEXT_LIMITS.dedupeKey,
    );
    if (!alias || !isSourceQualifiedDedupeKey(alias, kind) || seen.has(alias)) {
      continue;
    }
    seen.add(alias);
    aliases.push(alias);
  }
  return aliases.length > 0 ? aliases : undefined;
}

export function agentArtifactCarryIdentity(
  receipt: AgentArtifactCarryReceiptV1,
): string {
  return receipt.kind === 'pipeline_run'
    ? `pipeline_run:${receipt.executionId}`
    : receipt.dedupeKey;
}

/**
 * True when two carry receipts describe the same observed state, so a
 * re-record can be skipped. Pipeline runs read live state from the execution
 * store, so their identity plus creation time is enough; GitHub runs embed
 * their snapshot, so any observed change counts.
 */
export function isSameAgentArtifactCarryReceipt(
  current: AgentArtifactCarryReceiptV1,
  next: AgentArtifactCarryReceiptV1,
): boolean {
  if (current.kind !== next.kind || current.dedupeKey !== next.dedupeKey) {
    return false;
  }
  if (current.kind === 'pipeline_run' || next.kind === 'pipeline_run') {
    return current.createdAt === next.createdAt;
  }
  return (
    current.watcherId === next.watcherId &&
    current.runAttempt === next.runAttempt &&
    current.observedAt === next.observedAt &&
    current.htmlUrl === next.htmlUrl &&
    current.workflowName === next.workflowName &&
    current.runNumber === next.runNumber &&
    current.startedAt === next.startedAt &&
    JSON.stringify(current.state) === JSON.stringify(next.state) &&
    JSON.stringify(current.jobs ?? null) ===
      JSON.stringify(next.jobs ?? null) &&
    (current.definition?.sha ?? null) === (next.definition?.sha ?? null)
  );
}

const GITHUB_REPOSITORY_PATTERN =
  /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const GITHUB_RUN_ID_PATTERN = /^[1-9]\d{0,19}$/;

function githubRepository(value: unknown): string | undefined {
  const normalized = boundedString(value, AGENT_ARTIFACT_TEXT_LIMITS.identity);
  return normalized && GITHUB_REPOSITORY_PATTERN.test(normalized)
    ? normalized
    : undefined;
}

function githubRunId(value: unknown): string | undefined {
  const normalized = boundedString(value, AGENT_ARTIFACT_TEXT_LIMITS.identity);
  return normalized && GITHUB_RUN_ID_PATTERN.test(normalized)
    ? normalized
    : undefined;
}

/** Only GitHub.com `https` page URLs are safe to hand to the OS browser. */
function githubHtmlUrl(value: unknown): string | undefined {
  const normalized = boundedString(value, AGENT_ARTIFACT_TEXT_LIMITS.identity);
  if (!normalized) return undefined;
  try {
    const parsed = new URL(normalized);
    if (
      parsed.protocol !== 'https:' ||
      !['github.com', 'www.github.com'].includes(
        parsed.hostname.toLowerCase(),
      ) ||
      parsed.username.length > 0 ||
      parsed.password.length > 0 ||
      parsed.port.length > 0
    ) {
      return undefined;
    }
    return parsed.toString();
  } catch {
    return undefined;
  }
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
    ? value
    : undefined;
}

function normalizeGitHubRunState(
  value: unknown,
): GitHubWorkflowRunState | null {
  if (!isRecord(value)) return null;
  if (value.kind === 'intermediate') {
    const status = GITHUB_WORKFLOW_RUN_INTERMEDIATE_STATUSES.find(
      (candidate) => candidate === value.status,
    );
    return status ? { kind: 'intermediate', status } : null;
  }
  if (value.kind === 'terminal') {
    const conclusion = GITHUB_WORKFLOW_RUN_CONCLUSIONS.find(
      (candidate) => candidate === value.conclusion,
    );
    return conclusion ? { kind: 'terminal', conclusion } : null;
  }
  if (value.kind === 'unsupported') {
    const status =
      value.status === null
        ? null
        : boundedString(value.status, AGENT_ARTIFACT_TEXT_LIMITS.operation);
    const conclusion =
      value.conclusion === null
        ? null
        : boundedString(value.conclusion, AGENT_ARTIFACT_TEXT_LIMITS.operation);
    if (
      status === undefined ||
      conclusion === undefined ||
      typeof value.terminal !== 'boolean'
    ) {
      return null;
    }
    return {
      kind: 'unsupported',
      status,
      conclusion,
      terminal: value.terminal,
    };
  }
  return null;
}

function normalizeGitHubJobSnapshot(
  value: unknown,
): GitHubWorkflowJobSnapshot | null {
  if (!isRecord(value)) return null;
  const jobId = githubRunId(value.jobId);
  const name = boundedString(value.name, AGENT_ARTIFACT_TEXT_LIMITS.name);
  const status = boundedString(
    value.status,
    AGENT_ARTIFACT_TEXT_LIMITS.githubJobStatus,
  );
  const conclusion =
    value.conclusion === null
      ? null
      : GITHUB_WORKFLOW_JOB_CONCLUSIONS.find(
          (candidate) => candidate === value.conclusion,
        );
  const htmlUrl = githubHtmlUrl(value.htmlUrl);
  const observedAt = isoDate(value.observedAt);
  const createdAt =
    value.createdAt === undefined ? undefined : isoDate(value.createdAt);
  const startedAt =
    value.startedAt === undefined ? undefined : isoDate(value.startedAt);
  const completedAt =
    value.completedAt === undefined ? undefined : isoDate(value.completedAt);
  if (
    !jobId ||
    !name ||
    !status ||
    conclusion === undefined ||
    !htmlUrl ||
    !observedAt ||
    (value.createdAt !== undefined && !createdAt) ||
    (value.startedAt !== undefined && !startedAt) ||
    (value.completedAt !== undefined && !completedAt)
  ) {
    return null;
  }
  return {
    jobId,
    name,
    status,
    conclusion,
    htmlUrl,
    ...(createdAt ? { createdAt } : {}),
    ...(startedAt ? { startedAt } : {}),
    ...(completedAt ? { completedAt } : {}),
    observedAt,
  };
}

function isSourceQualifiedDedupeKey(
  value: string,
  kind: AgentArtifactReceiptV1['kind'],
): boolean {
  const parts = value.split(':');
  return (
    value.startsWith(`canopy:${kind}:`) &&
    parts.length >= 4 &&
    parts.slice(2).every((part) => part.length > 0)
  );
}

export function normalizeAgentArtifactNavigationRequest(
  value: unknown,
): AgentArtifactNavigationRequest | null {
  if (!isRecord(value)) return null;
  switch (value.kind) {
    case 'pipeline_editor': {
      const pipelineId = navigationString(
        value.pipelineId,
        AGENT_ARTIFACT_TEXT_LIMITS.identity,
      );
      if (
        !pipelineId ||
        (value.source !== 'bundled' &&
          value.source !== 'user' &&
          value.source !== 'curated' &&
          value.source !== 'project' &&
          value.source !== 'shared')
      ) {
        return null;
      }
      const projectId = optionalNavigationString(
        value.projectId,
        AGENT_ARTIFACT_TEXT_LIMITS.identity,
      );
      const worktreeId = optionalNavigationString(
        value.worktreeId,
        AGENT_ARTIFACT_TEXT_LIMITS.identity,
      );
      const sharedRemoteId = optionalNavigationString(
        value.sharedRemoteId,
        AGENT_ARTIFACT_TEXT_LIMITS.identity,
      );
      const repoId = optionalNavigationString(
        value.repoId,
        AGENT_ARTIFACT_TEXT_LIMITS.identity,
      );
      if (
        projectId === null ||
        worktreeId === null ||
        repoId === null ||
        sharedRemoteId === null ||
        (projectId === undefined) !== (worktreeId === undefined) ||
        (value.source === 'project' && projectId === undefined) ||
        (repoId !== undefined && value.source !== 'project') ||
        (value.source === 'shared' && sharedRemoteId === undefined)
      ) {
        return null;
      }
      return {
        kind: 'pipeline_editor',
        pipelineId,
        source: value.source,
        ...(projectId ? { projectId } : {}),
        ...(worktreeId ? { worktreeId } : {}),
        ...(repoId ? { repoId } : {}),
        ...(sharedRemoteId ? { sharedRemoteId } : {}),
      };
    }
    case 'pipeline_execution': {
      const executionId = navigationString(
        value.executionId,
        AGENT_ARTIFACT_TEXT_LIMITS.identity,
      );
      const projectId = navigationString(
        value.projectId,
        AGENT_ARTIFACT_TEXT_LIMITS.identity,
      );
      const worktreeId = navigationString(
        value.worktreeId,
        AGENT_ARTIFACT_TEXT_LIMITS.identity,
      );
      const jobId = optionalNavigationString(
        value.jobId,
        AGENT_ARTIFACT_TEXT_LIMITS.identity,
      );
      return executionId && projectId && worktreeId && jobId !== null
        ? {
            kind: 'pipeline_execution',
            executionId,
            projectId,
            worktreeId,
            ...(jobId ? { jobId } : {}),
          }
        : null;
    }
    case 'installed_skill': {
      const sourceId = navigationString(
        value.sourceId,
        AGENT_ARTIFACT_TEXT_LIMITS.identity,
      );
      const skillName = navigationString(
        value.skillName,
        AGENT_ARTIFACT_TEXT_LIMITS.name,
      );
      const filePath = optionalNavigationString(
        value.filePath,
        AGENT_ARTIFACT_TEXT_LIMITS.identity,
      );
      return sourceId && skillName && filePath !== null
        ? {
            kind: 'installed_skill',
            sourceId,
            skillName,
            ...(filePath ? { filePath } : {}),
          }
        : null;
    }
    case 'shared_skill': {
      const skillId = navigationString(
        value.skillId,
        AGENT_ARTIFACT_TEXT_LIMITS.identity,
      );
      return skillId ? { kind: 'shared_skill', skillId } : null;
    }
    case 'external_url': {
      const url = normalizeCapabilityHttpsUrl(value.url);
      return url ? { kind: 'external_url', url } : null;
    }
    case 'agent_editor':
    case 'shared_agent': {
      const agentId = navigationString(
        value.agentId,
        AGENT_ARTIFACT_TEXT_LIMITS.identity,
      );
      return agentId ? { kind: value.kind, agentId } : null;
    }
    case 'capability_entry': {
      const entry = normalizeCapabilityEntry(value.entry);
      return entry ? { kind: 'capability_entry', entry } : null;
    }
    case 'automation_editor': {
      const activityId = navigationString(
        value.activityId,
        AGENT_ARTIFACT_TEXT_LIMITS.identity,
      );
      const section = value.section;
      const runId = optionalNavigationString(
        value.runId,
        AGENT_ARTIFACT_TEXT_LIMITS.identity,
      );
      if (
        !activityId ||
        runId === null ||
        (section !== undefined &&
          section !== 'definition' &&
          section !== 'trigger' &&
          section !== 'runs') ||
        (runId && section !== 'runs')
      )
        return null;
      return {
        kind: 'automation_editor',
        activityId,
        ...(section ? { section } : {}),
        ...(runId ? { runId } : {}),
      };
    }
    case 'github_workflow_run': {
      const repository = githubRepository(value.repository);
      const runId = githubRunId(value.runId);
      const htmlUrl = githubHtmlUrl(value.htmlUrl);
      return repository && runId && htmlUrl
        ? { kind: 'github_workflow_run', repository, runId, htmlUrl }
        : null;
    }
    default:
      return null;
  }
}

/** Accept current tagged links and the legacy untagged installed-skill shape. */
export function normalizeSkillViewerDeepLink(
  value: unknown,
): SkillViewerDeepLink | null {
  if (!isRecord(value)) return null;
  if (value.kind === 'shared') {
    const skillId = boundedString(
      value.skillId,
      AGENT_ARTIFACT_TEXT_LIMITS.identity,
    );
    return skillId ? { kind: 'shared', skillId } : null;
  }
  if (value.kind !== undefined && value.kind !== 'installed') return null;
  const sourceId = boundedString(
    value.sourceId,
    AGENT_ARTIFACT_TEXT_LIMITS.identity,
  );
  const skillName = boundedString(
    value.skillName,
    AGENT_ARTIFACT_TEXT_LIMITS.name,
  );
  const filePath = optionalBoundedString(
    value.filePath,
    AGENT_ARTIFACT_TEXT_LIMITS.identity,
  );
  return sourceId && skillName && filePath !== null
    ? {
        kind: 'installed',
        sourceId,
        skillName,
        ...(filePath ? { filePath } : {}),
      }
    : null;
}

function receiptBase(
  value: Record<string, unknown>,
  kind: AgentArtifactReceiptV1['kind'],
): Pick<
  AgentArtifactReceiptV1,
  'version' | 'kind' | 'operation' | 'dedupeKey' | 'createdAt' | 'aliases'
> | null {
  const operation = boundedString(
    value.operation,
    AGENT_ARTIFACT_TEXT_LIMITS.operation,
  );
  const dedupeKey = boundedString(
    value.dedupeKey,
    AGENT_ARTIFACT_TEXT_LIMITS.dedupeKey,
  );
  const createdAt = isoDate(value.createdAt);
  if (
    value.version !== 1 ||
    value.kind !== kind ||
    !operation ||
    !dedupeKey ||
    !isSourceQualifiedDedupeKey(dedupeKey, kind) ||
    !createdAt
  ) {
    return null;
  }
  const aliases = boundedAliases(value.aliases, kind)?.filter(
    (alias) => alias !== dedupeKey,
  );
  return {
    version: 1,
    kind,
    operation,
    dedupeKey,
    createdAt,
    ...(aliases ? { aliases } : {}),
    ...(normalizeChangedFields(value.changedFields)?.length
      ? { changedFields: normalizeChangedFields(value.changedFields) }
      : {}),
  };
}

function serializePipelineReceipt(
  value: Record<string, unknown>,
): PipelineArtifactReceiptV1 | null {
  const base = receiptBase(value, 'pipeline');
  const name = boundedString(value.name, AGENT_ARTIFACT_TEXT_LIMITS.name);
  const description = optionalBoundedString(
    value.description,
    AGENT_ARTIFACT_TEXT_LIMITS.description,
  );
  const localId = optionalBoundedString(
    value.localId,
    AGENT_ARTIFACT_TEXT_LIMITS.identity,
  );
  const sharedRemoteId = optionalBoundedString(
    value.sharedRemoteId,
    AGENT_ARTIFACT_TEXT_LIMITS.identity,
  );
  const navigationTarget = normalizeAgentArtifactNavigationRequest(
    value.navigationTarget,
  );
  const shareTarget =
    value.shareTarget === undefined
      ? undefined
      : pipelineRepairShareTargetSchema.safeParse(value.shareTarget);
  if (
    shareTarget &&
    (!shareTarget.success ||
      navigationTarget?.kind !== 'pipeline_editor' ||
      shareTarget.data.pipelineId !== localId ||
      (shareTarget.data.source === 'stored'
        ? value.source !== 'user'
        : value.source !== 'project' ||
          shareTarget.data.projectId !== navigationTarget.projectId ||
          shareTarget.data.worktreeId !== navigationTarget.worktreeId ||
          shareTarget.data.repoId !== navigationTarget.repoId))
  )
    return null;
  const rawScopes = Array.isArray(value.scopes) ? value.scopes : null;
  const scopes = rawScopes
    ? rawScopes
        .slice(0, 8)
        .filter(
          (scope): scope is PipelineArtifactReceiptV1['scopes'][number] =>
            scope === 'global' || scope === 'directory' || scope === 'worktree',
        )
    : null;
  const rawRunModes = Array.isArray(value.runModes) ? value.runModes : null;
  const runModes = rawRunModes
    ? rawRunModes
        .slice(0, 8)
        .filter(
          (mode): mode is PipelineArtifactReceiptV1['runModes'][number] =>
            mode === 'dispatch' ||
            mode === 'plan_ready' ||
            mode === 'task_ready',
        )
    : null;
  const jobCount = nonNegativeInteger(value.jobCount);
  const stepCount = nonNegativeInteger(value.stepCount);
  const hasMatchingNavigationIdentity =
    navigationTarget?.kind === 'pipeline_editor' &&
    navigationTarget.source === value.source &&
    (value.source === 'shared'
      ? Boolean(
          sharedRemoteId && navigationTarget.sharedRemoteId === sharedRemoteId,
        )
      : Boolean(localId && navigationTarget.pipelineId === localId));
  if (
    !base ||
    !name ||
    description === null ||
    localId === null ||
    sharedRemoteId === null ||
    (!localId && !sharedRemoteId) ||
    (value.source !== 'bundled' &&
      value.source !== 'user' &&
      value.source !== 'curated' &&
      value.source !== 'project' &&
      value.source !== 'shared') ||
    typeof value.enabled !== 'boolean' ||
    !scopes ||
    scopes.length !== rawScopes?.length ||
    !runModes ||
    runModes.length !== rawRunModes?.length ||
    jobCount === undefined ||
    stepCount === undefined ||
    !hasMatchingNavigationIdentity
  ) {
    return null;
  }
  return {
    ...base,
    kind: 'pipeline',
    source: value.source,
    ...(shareTarget?.success ? { shareTarget: shareTarget.data } : {}),
    ...(localId ? { localId } : {}),
    ...(sharedRemoteId ? { sharedRemoteId } : {}),
    name,
    ...(description ? { description } : {}),
    enabled: value.enabled,
    scopes,
    runModes,
    jobCount,
    stepCount,
    navigationTarget,
  };
}

function serializeSkillOwner(
  value: unknown,
): SkillArtifactReceiptV1['owner'] | null {
  if (value === undefined) return undefined;
  if (!isRecord(value)) return null;
  const type = value.type;
  const id = boundedString(value.id, AGENT_ARTIFACT_TEXT_LIMITS.identity);
  const name = optionalBoundedString(
    value.name,
    AGENT_ARTIFACT_TEXT_LIMITS.name,
  );
  if (
    (type !== 'user' && type !== 'team' && type !== 'organization') ||
    !id ||
    name === null
  ) {
    return null;
  }
  return { type, id, ...(name ? { name } : {}) };
}

function serializeSkillReceipt(
  value: Record<string, unknown>,
): SkillArtifactReceiptV1 | null {
  const base = receiptBase(value, 'skill');
  const name = boundedString(value.name, AGENT_ARTIFACT_TEXT_LIMITS.name);
  const description = optionalBoundedString(
    value.description,
    AGENT_ARTIFACT_TEXT_LIMITS.description,
  );
  const sourceId = optionalBoundedString(
    value.sourceId,
    AGENT_ARTIFACT_TEXT_LIMITS.identity,
  );
  const installedName = optionalBoundedString(
    value.installedName,
    AGENT_ARTIFACT_TEXT_LIMITS.name,
  );
  const sharedSkillId = optionalBoundedString(
    value.sharedSkillId,
    AGENT_ARTIFACT_TEXT_LIMITS.identity,
  );
  const owner = serializeSkillOwner(value.owner);
  const navigationTarget = normalizeAgentArtifactNavigationRequest(
    value.navigationTarget,
  );
  if (
    !base ||
    !name ||
    description === null ||
    sourceId === null ||
    installedName === null ||
    sharedSkillId === null ||
    owner === null ||
    (value.source !== 'installed' && value.source !== 'shared') ||
    (value.source === 'installed' &&
      (!sourceId ||
        !installedName ||
        navigationTarget?.kind !== 'installed_skill' ||
        navigationTarget.sourceId !== sourceId ||
        navigationTarget.skillName !== installedName)) ||
    (value.source === 'shared' &&
      (!sharedSkillId ||
        navigationTarget?.kind !== 'shared_skill' ||
        navigationTarget.skillId !== sharedSkillId)) ||
    (value.shareScope !== undefined &&
      value.shareScope !== 'private' &&
      value.shareScope !== 'team' &&
      value.shareScope !== 'organization') ||
    typeof value.canUpdate !== 'boolean'
  ) {
    return null;
  }
  if (
    navigationTarget?.kind !== 'installed_skill' &&
    navigationTarget?.kind !== 'shared_skill'
  ) {
    return null;
  }
  return {
    ...base,
    kind: 'skill',
    source: value.source,
    ...(sourceId ? { sourceId } : {}),
    ...(installedName ? { installedName } : {}),
    ...(sharedSkillId ? { sharedSkillId } : {}),
    name,
    ...(description ? { description } : {}),
    ...(value.shareScope ? { shareScope: value.shareScope } : {}),
    ...(owner
      ? {
          owner,
        }
      : {}),
    canUpdate: value.canUpdate,
    navigationTarget,
  };
}

function serializeAutomationReceipt(
  value: Record<string, unknown>,
): AutomationArtifactReceiptV1 | null {
  const base = receiptBase(value, 'automation');
  const activityId = boundedString(
    value.activityId,
    AGENT_ARTIFACT_TEXT_LIMITS.identity,
  );
  const name = boundedString(value.name, AGENT_ARTIFACT_TEXT_LIMITS.name);
  const schedule = boundedString(
    value.schedule,
    AGENT_ARTIFACT_TEXT_LIMITS.schedule,
  );
  const nextRunAt =
    value.nextRunAt === undefined ? undefined : isoDate(value.nextRunAt);
  const actionKind = boundedString(
    value.actionKind,
    AGENT_ARTIFACT_TEXT_LIMITS.actionKind,
  );
  const targetSummary = boundedString(
    value.targetSummary,
    AGENT_ARTIFACT_TEXT_LIMITS.targetSummary,
  );
  const navigationTarget = normalizeAgentArtifactNavigationRequest(
    value.navigationTarget,
  );
  if (
    !base ||
    !activityId ||
    !name ||
    typeof value.enabled !== 'boolean' ||
    typeof value.running !== 'boolean' ||
    !schedule ||
    (value.nextRunAt !== undefined && !nextRunAt) ||
    !actionKind ||
    !targetSummary ||
    typeof value.ifCommandConfigured !== 'boolean' ||
    navigationTarget?.kind !== 'automation_editor' ||
    navigationTarget.activityId !== activityId
  ) {
    return null;
  }
  return {
    ...base,
    kind: 'automation',
    activityId,
    name,
    enabled: value.enabled,
    running: value.running,
    schedule,
    ...(nextRunAt ? { nextRunAt } : {}),
    actionKind,
    targetSummary,
    ifCommandConfigured: value.ifCommandConfigured,
    navigationTarget,
  };
}

function serializePipelineRunReceipt(
  value: Record<string, unknown>,
): PipelineRunArtifactReceiptV1 | null {
  const base = receiptBase(value, 'pipeline_run');
  const executionId = boundedString(
    value.executionId,
    AGENT_ARTIFACT_TEXT_LIMITS.identity,
  );
  const pipelineId = boundedString(
    value.pipelineId,
    AGENT_ARTIFACT_TEXT_LIMITS.identity,
  );
  const pipelineName = boundedString(
    value.pipelineName,
    AGENT_ARTIFACT_TEXT_LIMITS.name,
  );
  const queuedAt = isoDate(value.queuedAt);
  const startedAt =
    value.startedAt === undefined ? undefined : isoDate(value.startedAt);
  const projectId = boundedString(
    value.projectId,
    AGENT_ARTIFACT_TEXT_LIMITS.identity,
  );
  const worktreeId = boundedString(
    value.worktreeId,
    AGENT_ARTIFACT_TEXT_LIMITS.identity,
  );
  const repoId = optionalBoundedString(
    value.repoId,
    AGENT_ARTIFACT_TEXT_LIMITS.identity,
  );
  const navigationTarget = normalizeAgentArtifactNavigationRequest(
    value.navigationTarget,
  );
  if (
    !base ||
    !executionId ||
    !pipelineId ||
    !pipelineName ||
    (value.initialStatus !== 'pending' &&
      value.initialStatus !== 'running' &&
      value.initialStatus !== 'paused') ||
    !queuedAt ||
    (value.startedAt !== undefined && !startedAt) ||
    !projectId ||
    !worktreeId ||
    repoId === null ||
    navigationTarget?.kind !== 'pipeline_execution' ||
    navigationTarget.executionId !== executionId ||
    navigationTarget.projectId !== projectId ||
    navigationTarget.worktreeId !== worktreeId
  ) {
    return null;
  }
  return {
    ...base,
    kind: 'pipeline_run',
    executionId,
    pipelineId,
    pipelineName,
    initialStatus: value.initialStatus,
    queuedAt,
    ...(startedAt ? { startedAt } : {}),
    projectId,
    worktreeId,
    ...(repoId ? { repoId } : {}),
    navigationTarget,
  };
}

/**
 * Validate an embedded definition graph. Returns undefined when absent, null
 * when malformed or oversized (the receipt then omits it rather than failing,
 * since the graph is display-only).
 */
function normalizeGitHubDefinitionGraph(
  value: unknown,
): GitHubWorkflowDefinitionGraph | null | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value) || !Array.isArray(value.jobs)) return null;
  const sha = boundedString(value.sha, AGENT_ARTIFACT_TEXT_LIMITS.identity);
  const observedAt = isoDate(value.observedAt);
  if (
    !sha ||
    !observedAt ||
    value.jobs.length > MAX_GITHUB_WORKFLOW_RECEIPT_GRAPH_JOBS
  ) {
    return null;
  }
  const jobs: GitHubWorkflowGraphJob[] = [];
  let names = 0;
  for (const raw of value.jobs) {
    if (
      !isRecord(raw) ||
      !Array.isArray(raw.names) ||
      !Array.isArray(raw.needs)
    ) {
      return null;
    }
    const id = boundedString(raw.id, AGENT_ARTIFACT_TEXT_LIMITS.identity);
    const template = boundedString(
      raw.template,
      AGENT_ARTIFACT_TEXT_LIMITS.name,
    );
    if (!id || !template || typeof raw.dynamic !== 'boolean') return null;
    const jobNames: string[] = [];
    for (const name of raw.names) {
      const bounded = boundedString(name, AGENT_ARTIFACT_TEXT_LIMITS.name);
      if (!bounded) return null;
      jobNames.push(bounded);
    }
    const needs: string[] = [];
    for (const need of raw.needs) {
      const bounded = boundedString(need, AGENT_ARTIFACT_TEXT_LIMITS.identity);
      if (!bounded) return null;
      needs.push(bounded);
    }
    names += jobNames.length;
    if (names > MAX_GITHUB_WORKFLOW_RECEIPT_GRAPH_NAMES) return null;
    jobs.push({ id, template, names: jobNames, needs, dynamic: raw.dynamic });
  }
  return { sha, jobs, observedAt };
}

function serializeGitHubWorkflowRunReceipt(
  value: Record<string, unknown>,
): GitHubWorkflowRunArtifactReceiptV1 | null {
  const base = receiptBase(value, 'github_workflow_run');
  const watcherId = boundedString(
    value.watcherId,
    AGENT_ARTIFACT_TEXT_LIMITS.identity,
  );
  const repository = githubRepository(value.repository);
  const runId = githubRunId(value.runId);
  const runAttempt = positiveInteger(value.runAttempt);
  const workflowName = optionalBoundedString(
    value.workflowName,
    AGENT_ARTIFACT_TEXT_LIMITS.name,
  );
  const runNumber =
    value.runNumber === undefined
      ? undefined
      : positiveInteger(value.runNumber);
  const htmlUrl = githubHtmlUrl(value.htmlUrl);
  const state = normalizeGitHubRunState(value.state);
  const startedAt =
    value.startedAt === undefined ? undefined : isoDate(value.startedAt);
  const observedAt = isoDate(value.observedAt);
  const rawJobs =
    value.jobs === undefined
      ? undefined
      : Array.isArray(value.jobs)
        ? value.jobs
        : null;
  const jobs = rawJobs
    ? rawJobs
        .slice(0, MAX_GITHUB_WORKFLOW_RECEIPT_JOBS)
        .map(normalizeGitHubJobSnapshot)
    : rawJobs;
  const definition = normalizeGitHubDefinitionGraph(value.definition);
  const navigationTarget = normalizeAgentArtifactNavigationRequest(
    value.navigationTarget,
  );
  if (
    !base ||
    !watcherId ||
    !repository ||
    !runId ||
    runAttempt === undefined ||
    workflowName === null ||
    (value.runNumber !== undefined && runNumber === undefined) ||
    !htmlUrl ||
    !state ||
    (value.startedAt !== undefined && !startedAt) ||
    !observedAt ||
    jobs === null ||
    (jobs && jobs.some((job) => job === null)) ||
    navigationTarget?.kind !== 'github_workflow_run' ||
    navigationTarget.repository !== repository ||
    navigationTarget.runId !== runId ||
    navigationTarget.htmlUrl !== htmlUrl
  ) {
    return null;
  }
  const validJobs = jobs?.filter(
    (job): job is GitHubWorkflowJobSnapshot => job !== null,
  );
  return {
    ...base,
    kind: 'github_workflow_run',
    watcherId,
    repository,
    runId,
    runAttempt,
    ...(workflowName ? { workflowName } : {}),
    ...(runNumber !== undefined ? { runNumber } : {}),
    htmlUrl,
    state,
    ...(startedAt ? { startedAt } : {}),
    observedAt,
    ...(validJobs ? { jobs: validJobs } : {}),
    ...(definition ? { definition } : {}),
    navigationTarget,
  };
}

/** Validate and serialize only known receipt versions/kinds and safe fields. */
export function serializeAgentArtifactReceipt(
  value: unknown,
): AgentArtifactReceiptV1 | null {
  if (!isRecord(value) || value.version !== 1) return null;
  switch (value.kind) {
    case 'automation_run':
      return serializeAutomationRunReceipt(value);
    case 'agent':
      return serializeAgentDefinitionReceipt(value);
    case 'capability_reference':
      return serializeCapabilityReferenceReceipt(value);
    case 'pipeline':
      return serializePipelineReceipt(value);
    case 'skill':
      return serializeSkillReceipt(value);
    case 'automation':
      return serializeAutomationReceipt(value);
    case 'pipeline_run':
      return serializePipelineRunReceipt(value);
    case 'github_workflow_run':
      return serializeGitHubWorkflowRunReceipt(value);
    default:
      return null;
  }
}

export function isAgentArtifactReceiptV1(
  value: unknown,
): value is AgentArtifactReceiptV1 {
  const normalized = serializeAgentArtifactReceipt(value);
  if (!normalized || !isRecord(value)) return false;
  // A normalizer may drop malformed array entries. A type guard must not
  // assert that the original, unnormalized arrays already have that shape.
  if (
    value.aliases !== undefined &&
    (!Array.isArray(value.aliases) ||
      !value.aliases.every((alias) => typeof alias === 'string'))
  )
    return false;
  if (
    value.changedFields !== undefined &&
    (!Array.isArray(value.changedFields) ||
      !value.changedFields.every(
        (field) =>
          typeof field === 'string' &&
          (AGENT_ARTIFACT_CHANGED_FIELDS as readonly string[]).includes(field),
      ))
  )
    return false;
  try {
    return Object.entries(normalized).every(
      ([key, field]) => JSON.stringify(field) === JSON.stringify(value[key]),
    );
  } catch {
    return false;
  }
}

/** True for the receipt kinds a chat may carry from turn to turn. */
export function isAgentArtifactCarryReceiptV1(
  value: unknown,
): value is AgentArtifactCarryReceiptV1 {
  const receipt = serializeAgentArtifactReceipt(value);
  return (
    receipt !== null &&
    (receipt.kind === 'pipeline_run' || receipt.kind === 'github_workflow_run')
  );
}

export function serializeAgentArtifactReceipts(
  value: unknown,
): AgentArtifactReceiptV1[] {
  if (!Array.isArray(value)) return [];
  const receipts: AgentArtifactReceiptV1[] = [];
  let bytes = 0;
  for (const candidate of value.slice(0, MAX_AGENT_ARTIFACT_RECEIPTS)) {
    const receipt = serializeAgentArtifactReceipt(candidate);
    if (!receipt) continue;
    const size = new TextEncoder().encode(JSON.stringify(receipt)).byteLength;
    if (bytes + size > MAX_AGENT_ARTIFACT_METADATA_BYTES) continue;
    bytes += size;
    receipts.push(receipt);
  }
  return receipts;
}

function agentArtifactCarryByteLength(value: AgentArtifactCarryByTurn): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function githubCarrySummary(
  receipt: GitHubWorkflowRunArtifactReceiptV1,
): GitHubWorkflowRunArtifactReceiptV1 {
  const summary = { ...receipt };
  delete summary.jobs;
  delete summary.definition;
  return summary;
}

function githubCarryWithoutDefinition(
  receipt: GitHubWorkflowRunArtifactReceiptV1,
): GitHubWorkflowRunArtifactReceiptV1 {
  const withoutDefinition = { ...receipt };
  delete withoutDefinition.definition;
  return withoutDefinition;
}

function githubCarryWithoutJobs(
  receipt: GitHubWorkflowRunArtifactReceiptV1,
): GitHubWorkflowRunArtifactReceiptV1 {
  const withoutJobs = { ...receipt };
  delete withoutJobs.jobs;
  return withoutJobs;
}

/**
 * Hydrate optional carry metadata, dropping malformed receipts, unknown
 * versions, duplicate executions or runs, and keys outside the copied
 * transcript. Newer turns win the aggregate persistence budget. GitHub run
 * summaries are retained first, then upgraded with jobs and definition graphs
 * while space remains, so trimming never removes the run card merely because
 * its display-only snapshot is large.
 */
export function normalizeAgentArtifactCarryByTurn(
  value: unknown,
  owningUserMessageIds?: ReadonlySet<string>,
): AgentArtifactCarryByTurn | undefined {
  if (!isRecord(value)) return undefined;
  const normalizedEntries: Array<
    readonly [string, AgentArtifactCarryReceiptV1[]]
  > = [];
  for (const [turnId, rawReceipts] of Object.entries(value)) {
    const normalizedTurnId = boundedString(
      turnId,
      AGENT_ARTIFACT_TEXT_LIMITS.identity,
    );
    if (
      !normalizedTurnId ||
      normalizedTurnId !== turnId ||
      (owningUserMessageIds && !owningUserMessageIds.has(normalizedTurnId))
    ) {
      continue;
    }
    const seenIdentities = new Set<string>();
    const receipts = serializeAgentArtifactReceipts(rawReceipts).filter(
      (receipt): receipt is AgentArtifactCarryReceiptV1 => {
        if (
          receipt.kind !== 'pipeline_run' &&
          receipt.kind !== 'github_workflow_run'
        ) {
          return false;
        }
        const identity = agentArtifactCarryIdentity(receipt);
        if (seenIdentities.has(identity)) return false;
        seenIdentities.add(identity);
        return true;
      },
    );
    if (receipts.length > 0)
      normalizedEntries.push([normalizedTurnId, receipts]);
  }
  if (normalizedEntries.length === 0) return undefined;

  const selected = new Map<string, AgentArtifactCarryReceiptV1[]>();
  const materializeSelected = (): AgentArtifactCarryByTurn => {
    const result: AgentArtifactCarryByTurn = {};
    for (const [turnId] of normalizedEntries) {
      const receipts = selected.get(turnId);
      if (receipts?.length) result[turnId] = receipts;
    }
    return result;
  };
  const selectedFits = (): boolean =>
    agentArtifactCarryByteLength(materializeSelected()) <=
    MAX_AGENT_ARTIFACT_CARRY_BYTES;
  const githubUpgrades: Array<{
    turnId: string;
    summary: GitHubWorkflowRunArtifactReceiptV1;
    full: GitHubWorkflowRunArtifactReceiptV1;
  }> = [];

  // Preserve compact run cards for as many recent turns as possible first.
  for (let index = normalizedEntries.length - 1; index >= 0; index -= 1) {
    const [turnId, receipts] = normalizedEntries[index];
    const selectedReceipts: AgentArtifactCarryReceiptV1[] = [];
    selected.set(turnId, selectedReceipts);
    for (const receipt of receipts) {
      const summary =
        receipt.kind === 'github_workflow_run'
          ? githubCarrySummary(receipt)
          : undefined;
      const compact = summary ?? receipt;
      selectedReceipts.push(compact);
      if (!selectedFits()) {
        selectedReceipts.pop();
        continue;
      }
      if (receipt.kind === 'github_workflow_run' && summary) {
        githubUpgrades.push({ turnId, summary, full: receipt });
      }
    }
    if (selectedReceipts.length === 0) selected.delete(turnId);
  }

  // Spend remaining space on the richest snapshots from the newest turns.
  for (const { turnId, summary, full } of githubUpgrades) {
    const selectedReceipts = selected.get(turnId);
    const receiptIndex = selectedReceipts?.indexOf(summary) ?? -1;
    if (!selectedReceipts || receiptIndex < 0) continue;
    const variants = [
      full,
      githubCarryWithoutDefinition(full),
      githubCarryWithoutJobs(full),
    ];
    for (const variant of variants) {
      if (JSON.stringify(variant) === JSON.stringify(summary)) continue;
      selectedReceipts[receiptIndex] = variant;
      if (selectedFits()) break;
      selectedReceipts[receiptIndex] = summary;
    }
  }

  const result = materializeSelected();
  return Object.keys(result).length > 0 ? result : undefined;
}

export function normalizeAgentArtifactNavigationError(
  value: unknown,
): NormalizedAgentArtifactNavigationError {
  if (!isRecord(value)) {
    return {
      code: 'navigation_failed',
      message: 'Artifact navigation failed.',
      retryable: false,
    };
  }
  const code = isAgentArtifactNavigationErrorCode(value.code)
    ? value.code
    : 'navigation_failed';
  const message =
    boundedString(value.message, AGENT_ARTIFACT_TEXT_LIMITS.description) ??
    'Artifact navigation failed.';
  return {
    code,
    message,
    retryable: value.retryable === true,
  };
}

/** Normalize any resource-layer failure to the closed, JSON-safe error model. */
export function normalizeAgentResourceError(
  value: unknown,
  fallbackCode: AgentResourceErrorCode = 'validation_failed',
): NormalizedAgentResourceError {
  if (!isRecord(value)) {
    return {
      code: fallbackCode,
      message: 'Resource action failed.',
      retryable: false,
    };
  }
  return {
    code: isAgentResourceErrorCode(value.code) ? value.code : fallbackCode,
    message:
      boundedString(value.message, AGENT_ARTIFACT_TEXT_LIMITS.description) ??
      'Resource action failed.',
    retryable: value.retryable === true,
  };
}

export function isAgentResourceErrorCode(
  value: unknown,
): value is AgentResourceErrorCode {
  return typeof value === 'string' && RESOURCE_ERROR_CODES.has(value);
}

function isAgentArtifactNavigationErrorCode(
  value: unknown,
): value is NormalizedAgentArtifactNavigationError['code'] {
  return typeof value === 'string' && NAVIGATION_ERROR_CODES.has(value);
}

export function mergeLatestAgentArtifacts(
  current: readonly AgentArtifactReceiptV1[],
  incoming: readonly AgentArtifactReceiptV1[],
): AgentArtifactReceiptV1[] {
  const result = [...current];
  for (const receipt of incoming) {
    const identities = new Set([receipt.dedupeKey, ...(receipt.aliases ?? [])]);
    const matchingIndexes: number[] = [];
    result.forEach((candidate, index) => {
      const candidateIdentities = [
        candidate.dedupeKey,
        ...(candidate.aliases ?? []),
      ];
      if (candidateIdentities.some((identity) => identities.has(identity))) {
        matchingIndexes.push(index);
      }
    });
    // Latest mutation wins and takes the item's last-seen position.
    for (let index = matchingIndexes.length - 1; index >= 0; index -= 1) {
      const matchingIndex = matchingIndexes[index];
      if (matchingIndex !== undefined) result.splice(matchingIndex, 1);
    }
    result.push(receipt);
  }
  return result;
}

export const MAX_AGENT_ARTIFACT_RECEIPTS = 64;
export const MAX_AGENT_ARTIFACT_METADATA_BYTES = 512 * 1024;
export const MAX_AGENT_ARTIFACT_OUTPUT_CHARS = 2 * 1024 * 1024;

export function normalizeChangedFields(
  value: unknown,
): AgentArtifactChangedField[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return Array.from(
    new Set(
      value
        .slice(0, 12)
        .filter(
          (field): field is AgentArtifactChangedField =>
            typeof field === 'string' &&
            (AGENT_ARTIFACT_CHANGED_FIELDS as readonly string[]).includes(
              field,
            ),
        ),
    ),
  );
}

/** No network access: validates only the supplied locator. */
export function normalizeCapabilityHttpsUrl(value: unknown): string | null {
  if (
    typeof value !== 'string' ||
    value.length > AGENT_ARTIFACT_TEXT_LIMITS.identity ||
    hasControlCharacters(value)
  )
    return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      url.href.length <= AGENT_ARTIFACT_TEXT_LIMITS.identity
      ? url.href
      : null;
  } catch {
    return null;
  }
}

function normalizeCapabilityEntry(value: unknown): UnifiedEntryRef | null {
  if (!isRecord(value) || typeof value.type !== 'string') return null;
  // Copy the documented locator fields only; never accept routes or renderer actions.
  const fields: Record<string, readonly string[]> = {
    'curated-plugin': ['key'],
    'curated-pipeline': ['key'],
    'curated-mcp': ['key'],
    'marketplace-plugin': ['marketplaceId', 'pluginName'],
    'local-mcp': ['serverId'],
    'mcp-server': ['serverId', 'configId'],
    skill: ['sourceId', 'skillName'],
    'shared-skill': ['skillId'],
    'local-collection': ['collectionId'],
    'shared-collection': ['collectionId'],
    'shared-agent': ['agentId'],
    'shared-plugin': ['pluginId'],
    automation: ['activityId'],
    'shared-automation': ['automationId'],
    'curated-automation': ['key'],
  };
  const keys = fields[value.type];
  if (!keys) return null;
  const result: Record<string, string> = { type: value.type };
  for (const key of keys) {
    const field = navigationString(
      value[key],
      AGENT_ARTIFACT_TEXT_LIMITS.identity,
    );
    if (!field) return null;
    result[key] = field;
  }
  if (value.type === 'local-mcp' && value.configId !== undefined) {
    const id = navigationString(
      value.configId,
      AGENT_ARTIFACT_TEXT_LIMITS.identity,
    );
    if (!id) return null;
    result.configId = id;
  }
  return result as unknown as UnifiedEntryRef;
}

function serializeAutomationRunReceipt(
  value: Record<string, unknown>,
): AutomationRunArtifactReceiptV1 | null {
  const base = receiptBase(value, 'automation_run');
  const activityId = boundedString(value.activityId, 512);
  const runId = boundedString(value.runId, 512);
  const name = boundedString(value.name, 200);
  const scheduledFor = isoDate(value.scheduledFor);
  const startedAt = isoDate(value.startedAt);
  const completedAt =
    value.completedAt === undefined ? undefined : isoDate(value.completedAt);
  const nav = normalizeAgentArtifactNavigationRequest(value.navigationTarget);
  if (
    !base ||
    !activityId ||
    !runId ||
    !name ||
    !scheduledFor ||
    !startedAt ||
    (value.completedAt !== undefined && !completedAt) ||
    (value.durationMs !== undefined &&
      (typeof value.durationMs !== 'number' ||
        !Number.isFinite(value.durationMs) ||
        value.durationMs < 0)) ||
    ![
      'running',
      'success',
      'failure',
      'skipped',
      'canceled',
      'missed',
    ].includes(String(value.status)) ||
    !['scheduled', 'manual', 'catch_up'].includes(String(value.trigger)) ||
    (value.skipReason !== undefined &&
      !['if_command_exit', 'idempotency', 'already_running'].includes(
        typeof value.skipReason === 'string' ? value.skipReason : '',
      )) ||
    nav?.kind !== 'automation_editor' ||
    nav.activityId !== activityId ||
    nav.section !== 'runs' ||
    nav.runId !== runId
  )
    return null;
  const executionId = optionalBoundedString(value.executionId, 512);
  const chatId = optionalBoundedString(value.chatId, 512);
  if (executionId === null || chatId === null) return null;
  return {
    ...base,
    kind: 'automation_run',
    activityId,
    runId,
    name,
    status: value.status as AutomationRunArtifactReceiptV1['status'],
    trigger: value.trigger as AutomationRunArtifactReceiptV1['trigger'],
    ...(value.skipReason
      ? {
          skipReason:
            value.skipReason as AutomationRunArtifactReceiptV1['skipReason'],
        }
      : {}),
    scheduledFor,
    startedAt,
    ...(completedAt ? { completedAt } : {}),
    ...(typeof value.durationMs === 'number'
      ? { durationMs: value.durationMs }
      : {}),
    ...(executionId ? { executionId } : {}),
    ...(chatId ? { chatId } : {}),
    navigationTarget: nav,
  };
}
function serializeAgentDefinitionReceipt(
  value: Record<string, unknown>,
): AgentDefinitionArtifactReceiptV1 | null {
  const base = receiptBase(value, 'agent');
  const agentId = boundedString(value.agentId, 512);
  const name = boundedString(value.name, 200);
  const description = optionalBoundedString(value.description, 1000);
  const model = optionalBoundedString(value.model, 200);
  const nav = normalizeAgentArtifactNavigationRequest(value.navigationTarget);
  if (
    !base ||
    !agentId ||
    !name ||
    description === null ||
    model === null ||
    (value.source !== 'local' && value.source !== 'shared') ||
    nav?.kind !==
      (value.source === 'local' ? 'agent_editor' : 'shared_agent') ||
    !('agentId' in nav) ||
    nav.agentId !== agentId
  )
    return null;
  return {
    ...base,
    kind: 'agent',
    source: value.source,
    agentId,
    name,
    ...(description ? { description } : {}),
    ...(model ? { model } : {}),
    navigationTarget: nav,
  };
}
function serializeCapabilityReferenceReceipt(
  value: Record<string, unknown>,
): CapabilityReferenceArtifactReceiptV1 | null {
  const base = receiptBase(value, 'capability_reference');
  const name = boundedString(value.name, 200);
  const source = boundedString(value.source, 100);
  const sourceId = boundedString(value.sourceId, 512);
  const sourceLabel = boundedString(value.sourceLabel, 200);
  const description = optionalBoundedString(value.description, 1000);
  const reason = optionalBoundedString(value.reason, 1000);
  const nav = normalizeAgentArtifactNavigationRequest(value.navigationTarget);
  const allowed: Record<string, readonly string[]> = {
    skill: ['installed_skill', 'shared_skill'],
    pipeline: ['pipeline_editor'],
    automation: ['automation_editor'],
    agent: ['agent_editor', 'shared_agent'],
    plugin: [],
    'mcp-server': [],
    collection: [],
  };
  const itemKind = typeof value.itemKind === 'string' ? value.itemKind : '';
  if (
    !base ||
    !name ||
    !source ||
    !sourceId ||
    !sourceLabel ||
    !nav ||
    description === null ||
    reason === null ||
    !Object.prototype.hasOwnProperty.call(allowed, itemKind) ||
    !['installed', 'available', 'needs-auth', 'unknown'].includes(
      String(value.state),
    ) ||
    (value.relation !== 'found' && value.relation !== 'recommended') ||
    (nav.kind !== 'external_url' &&
      nav.kind !== 'capability_entry' &&
      !allowed[itemKind]?.includes(nav.kind)) ||
    (source === 'external' &&
      (nav.kind !== 'external_url' ||
        sourceId !== nav.url ||
        value.state !== 'unknown'))
  )
    return null;
  if (!referenceNavigationMatches(itemKind, sourceId, source, nav)) return null;
  return {
    ...base,
    kind: 'capability_reference',
    itemKind: itemKind as CapabilityReferenceArtifactReceiptV1['itemKind'],
    source,
    sourceId,
    sourceLabel,
    name,
    ...(description ? { description } : {}),
    ...(reason ? { reason } : {}),
    state: value.state as CapabilityReferenceArtifactReceiptV1['state'],
    relation: value.relation,
    navigationTarget: nav,
  };
}

/** Canonical success envelopes only; legacy input inference stays desktop-only. */
export function extractCanonicalAgentArtifacts(
  output: string,
): AgentArtifactReceiptV1[] {
  if (output.length > MAX_AGENT_ARTIFACT_OUTPUT_CHARS) return [];
  try {
    const value: unknown = JSON.parse(output);
    return isRecord(value) && value.ok === true && isRecord(value.result)
      ? serializeAgentArtifactReceipts(value.result.agentArtifacts)
      : [];
  } catch {
    return [];
  }
}

function navigationString(
  value: unknown,
  maxLength: number,
): string | undefined {
  return typeof value === 'string' &&
    value.trim().length > 0 &&
    value.length <= maxLength &&
    !hasControlCharacters(value)
    ? value.trim()
    : undefined;
}
function optionalNavigationString(
  value: unknown,
  maxLength: number,
): string | undefined | null {
  return value === undefined
    ? undefined
    : (navigationString(value, maxLength) ?? null);
}

function referenceNavigationMatches(
  kind: string,
  identity: string,
  source: string,
  nav: AgentArtifactNavigationRequest,
): boolean {
  switch (nav.kind) {
    case 'external_url':
      return source === 'external' && identity === nav.url;
    case 'installed_skill':
      return identity === `${nav.sourceId}/${nav.skillName}`;
    case 'shared_skill':
      return identity === nav.skillId;
    case 'agent_editor':
    case 'shared_agent':
      return identity === nav.agentId;
    case 'automation_editor':
      return identity === nav.activityId;
    case 'pipeline_editor':
      return (
        source === nav.source &&
        identity ===
          (nav.source === 'shared' ? nav.sharedRemoteId : nav.pipelineId)
      );
    case 'capability_entry': {
      const entry = nav.entry;
      switch (entry.type) {
        case 'marketplace-plugin': {
          const parent = `${entry.marketplaceId}/${entry.pluginName}`;
          return (
            (kind === 'plugin' && identity === parent) ||
            (kind === 'skill' &&
              identity.startsWith(`${parent}:`) &&
              identity.length > parent.length + 1)
          );
        }
        case 'curated-plugin':
          return kind === 'plugin' && identity === entry.key;
        case 'shared-plugin':
          return kind === 'plugin' && identity === entry.pluginId;
        case 'local-mcp':
        case 'mcp-server':
          return kind === 'mcp-server' && identity === entry.serverId;
        case 'curated-mcp':
          return kind === 'mcp-server' && identity === entry.key;
        case 'local-collection':
        case 'shared-collection':
          return kind === 'collection' && identity === entry.collectionId;
        case 'skill':
          return (
            kind === 'skill' &&
            identity === `${entry.sourceId}/${entry.skillName}`
          );
        case 'shared-skill':
          return kind === 'skill' && identity === entry.skillId;
        case 'shared-agent':
          return kind === 'agent' && identity === entry.agentId;
        case 'automation':
          return kind === 'automation' && identity === entry.activityId;
        case 'shared-automation':
          return kind === 'automation' && identity === entry.automationId;
        case 'curated-automation':
          return kind === 'automation' && identity === entry.key;
        default:
          return false;
      }
    }
    default:
      return false;
  }
}

function hasControlCharacters(value: string): boolean {
  return Array.from(value).some(
    (character) =>
      character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
  );
}
