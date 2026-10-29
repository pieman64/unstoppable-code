import type {
  AgentArtifactChangedField,
  AgentDefinitionArtifactReceiptV1,
  CapabilityReferenceArtifactReceiptV1,
  AutomationRunArtifactReceiptV1,
} from '../types/agent-artifacts';
import type { ScheduledActivity, ScheduledActivityRun } from '../types';
import type {
  AgentArtifactReceiptV1,
  AgentResourceRetrySemantics,
  AutomationArtifactReceiptV1,
  GitHubWorkflowRunArtifactReceiptV1,
  PipelineArtifactReceiptV1,
  PipelineRunArtifactReceiptV1,
  SkillArtifactReceiptV1,
} from '../types/agent-artifacts';
import {
  AGENT_ARTIFACT_TEXT_LIMITS,
  serializeAgentArtifactReceipt,
  serializeAgentArtifactReceipts,
} from '@canopy/protocol/agent-artifacts';
export * from '@canopy/protocol/agent-artifacts';

const RECEIPT_ELIGIBLE_ACTIONS = new Set([
  'capability_package.analyze',
  'pipeline.create',
  'pipeline.update',
  'pipeline.duplicate',
  'pipeline.share',
  'pipeline.update_shared',
  'pipeline.set_enabled',
  'pipeline.run',
  'pipeline.execution_retry',
  'pipeline.execution_resume',
  'skills.create_custom',
  'skills.update_custom',
  'skills.share_custom',
  'skills.import_shared',
  'skills.update_shared',
  'automation.create',
  'automation.run_now',
  'automation.get',
  'pipeline.get',
  'skills.read',
  'skills.read_shared',
  'agents.get',
  'agents.create',
  'agents.update',
  'agents.import_shared',
  'automation.update',
  'automation.disable',
  'automation.enable',
]);

const IDEMPOTENT_RESOURCE_ACTIONS = new Set([
  'pipeline.update',
  'pipeline.update_shared',
  'pipeline.set_enabled',
  'skills.update_custom',
  'skills.update_shared',
  'automation.update',
  'automation.enable',
  'automation.disable',
]);

const RECONCILE_BEFORE_RETRY_ACTIONS = new Set([
  'pipeline.create',
  'pipeline.duplicate',
  'pipeline.share',
  'skills.create_custom',
  'skills.share_custom',
  'skills.import_shared',
  'automation.create',
  'automation.run_now',
  'pipeline.execution_cancel',
  'pipeline.execution_retry',
  'pipeline.execution_chain',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function isIsoDate(value: string): boolean {
  return (
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(
      value,
    ) && Number.isFinite(Date.parse(value))
  );
}
function sourceQualifiedPart(value: string): string {
  return encodeURIComponent(value.trim());
}

/** Construct a stable internal key without depending on visible brand copy. */
export function createAgentArtifactDedupeKey(
  kind: AgentArtifactReceiptV1['kind'],
  source: string,
  ...identity: string[]
): string {
  return ['canopy', kind, source, ...identity]
    .map(sourceQualifiedPart)
    .join(':')
    .slice(
      0,
      kind === 'automation_run' ||
        kind === 'agent' ||
        kind === 'capability_reference'
        ? AGENT_ARTIFACT_TEXT_LIMITS.dedupeKey
        : AGENT_ARTIFACT_TEXT_LIMITS.identity,
    );
}

type ReceiptBaseInput = {
  operation: string;
  aliases?: string[];
  createdAt?: string;
};

/** Blank optional producer text is absent; the contract rejects empty strings. */
function optionalText(value: string | undefined): string | undefined {
  return value?.trim() ? value : undefined;
}

function createdAtForReceipt(value: string | undefined): string {
  return value && isIsoDate(value) ? value : new Date().toISOString();
}

/** Build a pipeline receipt from explicit, presentation-safe resource data. */
export function buildPipelineArtifactReceipt(
  input: ReceiptBaseInput &
    Omit<
      PipelineArtifactReceiptV1,
      'version' | 'kind' | 'operation' | 'dedupeKey' | 'aliases' | 'createdAt'
    >,
): PipelineArtifactReceiptV1 {
  const identity = input.sharedRemoteId ?? input.localId;
  if (!identity) throw new Error('A pipeline receipt requires an identity.');
  return {
    version: 1,
    kind: 'pipeline',
    operation: input.operation,
    dedupeKey: createAgentArtifactDedupeKey('pipeline', input.source, identity),
    ...(input.aliases?.length ? { aliases: input.aliases } : {}),
    createdAt: createdAtForReceipt(input.createdAt),
    source: input.source,
    ...(input.localId ? { localId: input.localId } : {}),
    ...(input.sharedRemoteId ? { sharedRemoteId: input.sharedRemoteId } : {}),
    name: input.name,
    ...(input.description ? { description: input.description } : {}),
    enabled: input.enabled,
    scopes: input.scopes,
    runModes: input.runModes,
    jobCount: input.jobCount,
    stepCount: input.stepCount,
    navigationTarget: input.navigationTarget,
    ...(input.shareTarget ? { shareTarget: input.shareTarget } : {}),
  };
}

/** Build a skill receipt without accepting raw skill content. */
export function buildSkillArtifactReceipt(
  input: ReceiptBaseInput &
    Omit<
      SkillArtifactReceiptV1,
      'version' | 'kind' | 'operation' | 'dedupeKey' | 'aliases' | 'createdAt'
    >,
): SkillArtifactReceiptV1 {
  const identity =
    input.source === 'installed'
      ? input.sourceId && input.installedName
        ? [input.sourceId, input.installedName]
        : null
      : input.sharedSkillId
        ? [input.sharedSkillId]
        : null;
  if (!identity) throw new Error('A skill receipt requires an identity.');
  return {
    version: 1,
    kind: 'skill',
    operation: input.operation,
    dedupeKey: createAgentArtifactDedupeKey('skill', input.source, ...identity),
    ...(input.aliases?.length ? { aliases: input.aliases } : {}),
    createdAt: createdAtForReceipt(input.createdAt),
    source: input.source,
    ...(input.sourceId ? { sourceId: input.sourceId } : {}),
    ...(input.installedName ? { installedName: input.installedName } : {}),
    ...(input.sharedSkillId ? { sharedSkillId: input.sharedSkillId } : {}),
    name: input.name,
    ...(input.description ? { description: input.description } : {}),
    ...(input.shareScope ? { shareScope: input.shareScope } : {}),
    ...(input.owner ? { owner: input.owner } : {}),
    canUpdate: input.canUpdate,
    navigationTarget: input.navigationTarget,
  };
}

/** Build an automation receipt from an explicit safe-field allowlist. */
export function buildAutomationArtifactReceipt(
  input: ReceiptBaseInput &
    Omit<
      AutomationArtifactReceiptV1,
      'version' | 'kind' | 'operation' | 'dedupeKey' | 'aliases' | 'createdAt'
    >,
): AutomationArtifactReceiptV1 {
  return {
    version: 1,
    kind: 'automation',
    operation: input.operation,
    dedupeKey: createAgentArtifactDedupeKey(
      'automation',
      'global',
      input.activityId,
    ),
    ...(input.aliases?.length ? { aliases: input.aliases } : {}),
    createdAt: createdAtForReceipt(input.createdAt),
    activityId: input.activityId,
    name: input.name,
    enabled: input.enabled,
    running: input.running,
    ...(input.changedFields?.length
      ? { changedFields: input.changedFields }
      : {}),
    schedule: input.schedule,
    ...(input.nextRunAt ? { nextRunAt: input.nextRunAt } : {}),
    actionKind: input.actionKind,
    targetSummary: input.targetSummary,
    ifCommandConfigured: input.ifCommandConfigured,
    navigationTarget: input.navigationTarget,
  };
}

/** Build a run receipt only after the execution has been persisted. */
export function buildPipelineRunArtifactReceipt(
  input: ReceiptBaseInput &
    Omit<
      PipelineRunArtifactReceiptV1,
      'version' | 'kind' | 'operation' | 'dedupeKey' | 'aliases' | 'createdAt'
    >,
): PipelineRunArtifactReceiptV1 {
  return {
    version: 1,
    kind: 'pipeline_run',
    operation: input.operation,
    dedupeKey: createAgentArtifactDedupeKey(
      'pipeline_run',
      'execution',
      input.executionId,
    ),
    ...(input.aliases?.length ? { aliases: input.aliases } : {}),
    createdAt: createdAtForReceipt(input.createdAt),
    executionId: input.executionId,
    pipelineId: input.pipelineId,
    pipelineName: input.pipelineName,
    initialStatus: input.initialStatus,
    queuedAt: input.queuedAt,
    ...(input.startedAt ? { startedAt: input.startedAt } : {}),
    projectId: input.projectId,
    worktreeId: input.worktreeId,
    ...(input.repoId ? { repoId: input.repoId } : {}),
    navigationTarget: input.navigationTarget,
  };
}

/**
 * Build a GitHub workflow-run receipt from a watcher's progress projection.
 * The identity is the run itself (`repository` + `runId`) so refreshed
 * snapshots of the same run collapse into one card.
 */
export function buildGitHubWorkflowRunArtifactReceipt(
  input: ReceiptBaseInput &
    Omit<
      GitHubWorkflowRunArtifactReceiptV1,
      'version' | 'kind' | 'operation' | 'dedupeKey' | 'aliases' | 'createdAt'
    >,
): GitHubWorkflowRunArtifactReceiptV1 {
  return {
    version: 1,
    kind: 'github_workflow_run',
    operation: input.operation,
    dedupeKey: createAgentArtifactDedupeKey(
      'github_workflow_run',
      input.repository,
      input.runId,
    ),
    ...(input.aliases?.length ? { aliases: input.aliases } : {}),
    createdAt: createdAtForReceipt(input.createdAt),
    watcherId: input.watcherId,
    repository: input.repository,
    runId: input.runId,
    runAttempt: input.runAttempt,
    ...(input.workflowName ? { workflowName: input.workflowName } : {}),
    ...(input.runNumber !== undefined ? { runNumber: input.runNumber } : {}),
    htmlUrl: input.htmlUrl,
    state: input.state,
    ...(input.startedAt ? { startedAt: input.startedAt } : {}),
    observedAt: input.observedAt,
    ...(input.jobs ? { jobs: input.jobs } : {}),
    ...(input.definition ? { definition: input.definition } : {}),
    navigationTarget: input.navigationTarget,
  };
}

/**
 * Identity used to collapse carried receipts for one turn. Pipeline runs keep
 * their execution-scoped identity (older receipts used other dedupe sources);
 * GitHub runs are identified by their run-scoped dedupe key.
 */
export function isAgentArtifactReceiptEligibleAction(
  actionType: string,
): boolean {
  return RECEIPT_ELIGIBLE_ACTIONS.has(actionType);
}

/** Describe retry requirements without introducing a second idempotency key. */
export function getAgentResourceRetrySemantics(
  actionType: string,
): AgentResourceRetrySemantics {
  if (actionType === 'capability_package.analyze') return 'idempotent';
  if (
    /\.(list|list_shared|get|read|read_file|read_shared)$/.test(actionType) ||
    /^pipeline\.execution_(list|list_for_worktree|get)$/.test(actionType)
  ) {
    return 'idempotent';
  }
  if (IDEMPOTENT_RESOURCE_ACTIONS.has(actionType)) {
    return 'idempotent';
  }
  if (actionType === 'pipeline.run') {
    return 'distinct_execution_on_success';
  }
  if (RECONCILE_BEFORE_RETRY_ACTIONS.has(actionType)) {
    return 'reconcile_before_retry';
  }
  if (/\.delete(?:_shared|_custom)?$/.test(actionType)) {
    return 'existing_delete_semantics';
  }
  return 'not_specified';
}

/**
 * Add validated receipts to a successful response without removing or
 * renaming any existing result field. Existing receipts keep their order.
 */
export function withAgentArtifacts<
  T extends { ok: true; result?: Record<string, unknown> },
>(
  response: T,
  receipts: readonly unknown[],
): T & {
  result: Record<string, unknown> & {
    agentArtifacts: AgentArtifactReceiptV1[];
  };
} {
  const result = isRecord(response.result) ? response.result : {};
  const existing = serializeAgentArtifactReceipts(result.agentArtifacts);
  const next = serializeAgentArtifactReceipts(receipts);
  const seen = new Set(
    existing.flatMap((receipt) => [
      receipt.dedupeKey,
      ...(receipt.aliases ?? []),
    ]),
  );
  const merged = [...existing];
  for (const receipt of next) {
    const identities = [receipt.dedupeKey, ...(receipt.aliases ?? [])];
    if (identities.some((identity) => seen.has(identity))) continue;
    for (const identity of identities) seen.add(identity);
    merged.push(receipt);
  }
  return {
    ...response,
    result: {
      ...result,
      agentArtifacts: serializeAgentArtifactReceipts(merged),
    },
  };
}

/** Build only the fields accepted by the portable receipt contract. */
export function buildAutomationRunArtifactReceipt(
  activity: ScheduledActivity,
  run: ScheduledActivityRun,
): AutomationRunArtifactReceiptV1 {
  const receipt = serializeAgentArtifactReceipt({
    version: 1,
    kind: 'automation_run',
    operation: 'automation.run_now',
    dedupeKey: createAgentArtifactDedupeKey(
      'automation_run',
      activity.id,
      run.id,
    ),
    createdAt: run.startedAt,
    activityId: activity.id,
    runId: run.id,
    name: activity.name,
    status: run.status,
    trigger: run.trigger ?? (run.manual ? 'manual' : 'scheduled'),
    scheduledFor: run.scheduledFor,
    startedAt: run.startedAt,
    completedAt: run.completedAt,
    durationMs: run.durationMs,
    skipReason: run.skipReason,
    executionId: run.result?.pipelineExecutionId,
    chatId:
      run.result?.chatId ??
      run.result?.standaloneChatId ??
      run.result?.appAdvisorChatId,
    navigationTarget: {
      kind: 'automation_editor',
      activityId: activity.id,
      section: 'runs',
      runId: run.id,
    },
  });
  if (run.activityId !== activity.id || receipt?.kind !== 'automation_run')
    throw new Error('Invalid automation run receipt.');
  return receipt;
}

export function buildAgentDefinitionArtifactReceipt(
  input: ReceiptBaseInput &
    Omit<
      AgentDefinitionArtifactReceiptV1,
      'version' | 'kind' | 'dedupeKey' | 'createdAt'
    >,
): AgentDefinitionArtifactReceiptV1 {
  const receipt = serializeAgentArtifactReceipt({
    version: 1,
    kind: 'agent',
    operation: input.operation,
    dedupeKey: createAgentArtifactDedupeKey(
      'agent',
      input.source,
      input.agentId,
    ),
    aliases: input.aliases,
    createdAt: createdAtForReceipt(input.createdAt),
    source: input.source,
    agentId: input.agentId,
    name: input.name,
    description: optionalText(input.description),
    model: optionalText(input.model),
    navigationTarget: input.navigationTarget,
  });
  if (receipt?.kind !== 'agent') throw new Error('Invalid agent receipt.');
  return receipt;
}

export function buildCapabilityReferenceArtifactReceipt(
  input: ReceiptBaseInput &
    Omit<
      CapabilityReferenceArtifactReceiptV1,
      'version' | 'kind' | 'dedupeKey' | 'createdAt'
    >,
): CapabilityReferenceArtifactReceiptV1 {
  const receipt = serializeAgentArtifactReceipt({
    version: 1,
    kind: 'capability_reference',
    operation: input.operation,
    dedupeKey: createAgentArtifactDedupeKey(
      'capability_reference',
      input.source,
      input.itemKind,
      input.sourceId,
    ),
    createdAt: createdAtForReceipt(input.createdAt),
    aliases: input.aliases,
    itemKind: input.itemKind,
    source: input.source,
    sourceId: input.sourceId,
    name: input.name,
    description: optionalText(input.description),
    sourceLabel: input.sourceLabel,
    state: input.state,
    relation: input.relation,
    reason: optionalText(input.reason),
    navigationTarget: input.navigationTarget,
  });
  if (receipt?.kind !== 'capability_reference')
    throw new Error('Invalid capability reference.');
  return receipt;
}

/** Compare effective saved values; keys and no-op patches never appear as changes. */
export function automationChangedFields(
  before: ScheduledActivity,
  after: ScheduledActivity,
): AgentArtifactChangedField[] {
  const equal = (left: unknown, right: unknown): boolean => {
    if (left === right) return true;
    if (Array.isArray(left) && Array.isArray(right))
      return (
        left.length === right.length &&
        left.every((item, i) => equal(item, right[i]))
      );
    if (!isRecord(left) || !isRecord(right)) return false;
    const keys = Object.keys(left).filter((key) => left[key] !== undefined);
    return (
      keys.length ===
        Object.keys(right).filter((key) => right[key] !== undefined).length &&
      keys.every((key) => equal(left[key], right[key]))
    );
  };
  return (
    ['name', 'enabled', 'schedule', 'action', 'ifCommand'] as const
  ).filter((key) => !equal(before[key], after[key]));
}

/** Enrich successful App Advisor responses using actual saved/read identities only. */
export function agentArtifactsForActionResult<TAction extends { type: string }>(
  rawAction: TAction,
  result: unknown,
): AgentArtifactReceiptV1[] {
  const action = rawAction as { type: string; [key: string]: unknown };
  if (!isRecord(result)) return [];
  if (
    [
      'agents.get',
      'agents.create',
      'agents.update',
      'agents.import_shared',
    ].includes(action.type)
  ) {
    const agent = isRecord(result.agent) ? result.agent : result;
    if (typeof agent.id !== 'string' || typeof agent.name !== 'string')
      return [];
    const target = { kind: 'agent_editor' as const, agentId: agent.id };
    if (action.type === 'agents.get')
      return [
        buildCapabilityReferenceArtifactReceipt({
          operation: action.type,
          itemKind: 'agent',
          source: 'local',
          sourceId: agent.id,
          name: agent.name,
          sourceLabel: 'Local',
          state: 'installed',
          relation: 'found',
          navigationTarget: target,
        }),
      ];
    const aliases =
      action.type === 'agents.import_shared' &&
      typeof action.agentId === 'string' &&
      agent.importedFromRemoteId === action.agentId
        ? [createAgentArtifactDedupeKey('agent', 'shared', action.agentId)]
        : undefined;
    return [
      buildAgentDefinitionArtifactReceipt({
        operation: action.type,
        source: 'local',
        agentId: agent.id,
        name: agent.name,
        model:
          typeof agent.baseModel === 'string' ? agent.baseModel : undefined,
        aliases,
        navigationTarget: target,
      }),
    ];
  }
  if (
    action.type === 'skills.read' &&
    typeof result.sourceId === 'string' &&
    typeof result.skillName === 'string'
  ) {
    return [
      buildCapabilityReferenceArtifactReceipt({
        operation: action.type,
        itemKind: 'skill',
        source: 'installed',
        sourceId: `${result.sourceId}/${result.skillName}`,
        name: result.skillName,
        sourceLabel: 'Installed',
        state: 'installed',
        relation: 'found',
        navigationTarget: {
          kind: 'installed_skill',
          sourceId: result.sourceId,
          skillName: result.skillName,
        },
      }),
    ];
  }
  if (action.type === 'skills.read_shared') {
    const skill = isRecord(result.skill) ? result.skill : result;
    if (typeof skill.id !== 'string' || typeof skill.name !== 'string')
      return [];
    return [
      buildCapabilityReferenceArtifactReceipt({
        operation: action.type,
        itemKind: 'skill',
        source: 'shared',
        sourceId: skill.id,
        name: skill.name,
        sourceLabel: 'Shared',
        state: 'available',
        relation: 'found',
        navigationTarget: { kind: 'shared_skill', skillId: skill.id },
      }),
    ];
  }
  if (action.type === 'pipeline.get' && isRecord(result.pipeline)) {
    const pipeline = result.pipeline;
    if (
      typeof pipeline.id !== 'string' ||
      typeof pipeline.name !== 'string' ||
      !['bundled', 'user', 'curated', 'project', 'shared'].includes(
        String(pipeline.source),
      )
    )
      return [];
    const source = pipeline.source as PipelineArtifactReceiptV1['source'];
    // Shared ids use the existing dispatch locator format. Never treat a local id as remote.
    const remoteId =
      source === 'shared' && pipeline.id.startsWith('shared:')
        ? pipeline.id.split(':').slice(2).join(':')
        : undefined;
    if (source === 'shared' && !remoteId) return [];
    if (
      source === 'project' &&
      (typeof action.projectId !== 'string' ||
        typeof action.worktreeId !== 'string')
    )
      return [];
    return [
      buildCapabilityReferenceArtifactReceipt({
        operation: action.type,
        itemKind: 'pipeline',
        source,
        sourceId: remoteId ?? pipeline.id,
        name: pipeline.name,
        sourceLabel: source === 'shared' ? 'Shared' : 'Local',
        state: source === 'shared' ? 'available' : 'installed',
        relation: 'found',
        navigationTarget: {
          kind: 'pipeline_editor',
          pipelineId: pipeline.id,
          source,
          ...(remoteId ? { sharedRemoteId: remoteId } : {}),
          ...(source === 'project'
            ? {
                projectId: action.projectId as string,
                worktreeId: action.worktreeId as string,
              }
            : {}),
        },
      }),
    ];
  }
  return [];
}
