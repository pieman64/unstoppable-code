import type { ChildPipelineAuthorization } from '@canopy/desktop-shared/node/pipelines/executor/child-pipeline-resolver';
import {
  backgroundExecutionDeniedMessage,
  backgroundExecutionRetryMessage,
} from '@canopy/desktop-shared/node/background-execution-context';
import {
  pipelineContextResources,
  localPipelineContextResources,
} from '@canopy/desktop-shared/node/background-execution-context';
import {
  authorizeBackgroundExecution,
  backgroundExecutionContextEnabled,
} from '../services/background-execution-context';
import { publishForeignPipelineQueueActivity } from '../services/foreign-activity-sources';
import { stat } from 'node:fs/promises';
import * as path from 'node:path';
import type { BrowserWindow } from 'electron';
import {
  interpolateHookTemplate,
  pipelineHookUnsupportedSpeedError,
  type PipelineHookAction,
} from '@canopy/desktop-shared/hooks';
import {
  DEFAULT_CODEX_SPEED,
  readCodexSpeedRecord,
  withCodexSpeed,
} from '@canopy/desktop-shared/lib/codex-speed';
import type { AgentModelConfig } from '@canopy/desktop-shared/types';
import { PIPELINE_CHANNELS } from '@canopy/desktop-shared/constants/ipc-channels';
import { normalizePipeline } from '@canopy/desktop-shared/pipelines/normalize-pipeline';
import {
  getTriggerTypes,
  type Pipeline,
  type PipelineData,
  type PipelineInputDef,
  type PipelinePreferenceLocator,
} from '@canopy/desktop-shared/types/pipeline';
import { sendToWindow } from './window-send';
import {
  createPipelineExecutionId,
  getNormalizedTriggerInputDefs,
  resolvePipelineInputs,
  type ExecutePipelineRequestOptions,
  type PipelineTriggerSource,
} from '@canopy/desktop-shared/node/pipelines/executor';
import { getProjectPipelinesDirCandidates } from '../pipelines/config-paths';
import { getStoredPipelineBySource } from '../pipelines/pipeline-service';
import {
  getCreatedAt,
  getProjectPipelineId,
  loadProjectPipelineFromDisk,
} from '../pipelines/project-pipeline-discovery';
import {
  startPipelineExecutionFromMain,
  validateProjectPipelineAccess,
} from '../pipelines/pipeline-handlers';
import { readPreferencesFile } from './preferences-store';
import {
  hasActivePipelineExecutions,
  releaseExecutionReservation,
  reserveExecution,
  subscribeToActiveCountChange,
} from '../pipelines/pipeline-execution-registry';

export type HookPipelineLaunchResult =
  | { status: 'started'; pipelineName: string; executionId: string }
  | { status: 'queued'; pipelineName: string; queueId: string };

interface ResolvedHookPipeline {
  pipeline: PipelineData;
  pipelineId: string;
  pipelineFilePath?: string;
  repoPath: string;
  pipelinePreferenceLocator?: PipelinePreferenceLocator;
  pipelineName: string;
}

interface QueuedHookPipelineInvocation {
  queueId: string;
  projectId: string;
  worktreeId: string;
  pipelineId: string;
  pipelineName: string;
  pipeline: Pipeline;
  options: ExecutePipelineRequestOptions & { executionId: string };
  triggerSource: PipelineTriggerSource;
  getWindow: () => BrowserWindow | null;
  enqueuedAt: string;
  cancelled: boolean;
  contextResources: ReturnType<typeof pipelineContextResources>;
  executionContext?: string;
}

const queuedHookPipelines: QueuedHookPipelineInvocation[] = [];
let drainChain = Promise.resolve();
const CANOPY_TEMPLATE_TOKEN_PATTERN = /\{\{CANOPY_[A-Z0-9_]+\}\}/g;

function isSafeProjectPipelineRelativePath(relativePath: string): boolean {
  if (
    path.posix.isAbsolute(relativePath) ||
    path.win32.isAbsolute(relativePath)
  ) {
    return false;
  }

  const segments = relativePath.split(/[\\/]/);
  if (
    segments.some(
      (segment) => segment.length === 0 || segment === '.' || segment === '..',
    )
  ) {
    return false;
  }

  const extension = path.posix
    .extname(relativePath.replace(/\\/g, '/'))
    .toLowerCase();
  return extension === '.yml' || extension === '.yaml';
}

function getStoredPipelineSource(
  source: PipelineHookAction['source'],
): 'bundled' | 'user' {
  return source === 'bundled' ? 'bundled' : 'user';
}

async function resolveHookPipeline(args: {
  action: PipelineHookAction;
  cwd: string;
}): Promise<ResolvedHookPipeline> {
  const id = args.action.id.trim();
  if (!id) {
    throw new Error('Pipeline hook action id must not be empty');
  }

  if (args.action.source === 'curated') {
    const { getManagedCuratedPipeline } =
      await import('../pipelines/curated-pipeline-catalog');
    const pipeline = await getManagedCuratedPipeline(id);
    return {
      pipeline,
      pipelineId: id,
      repoPath: args.cwd,
      pipelinePreferenceLocator: {
        type: 'stored',
        source: 'curated',
        value: id,
        ...(pipeline.info.curatedContentHash
          ? { contentHash: pipeline.info.curatedContentHash }
          : {}),
      },
      pipelineName: pipeline.content.name ?? id,
    };
  }

  if (args.action.source !== 'project') {
    const result = getStoredPipelineBySource(
      getStoredPipelineSource(args.action.source),
      id,
    );
    if (!result.success || !result.data) {
      throw new Error(result.error || `Pipeline not found: ${id}`);
    }
    return {
      pipeline: result.data,
      pipelineId: id,
      repoPath: args.cwd,
      pipelinePreferenceLocator: {
        type: 'stored',
        source: getStoredPipelineSource(args.action.source),
        value: id,
      },
      pipelineName: result.data.content.name ?? id,
    };
  }

  if (!isSafeProjectPipelineRelativePath(id)) {
    throw new Error(
      'Project pipeline hook id must be a safe relative .yml or .yaml path',
    );
  }

  const normalizedRelativePath = id.replace(/\\/g, '/');
  const pipelineId = getProjectPipelineId(normalizedRelativePath);
  let validated:
    | Awaited<ReturnType<typeof validateProjectPipelineAccess>>
    | undefined;

  for (const rootDir of getProjectPipelinesDirCandidates(args.cwd)) {
    const normalizedFilePath = path.resolve(rootDir, normalizedRelativePath);
    const candidate = await validateProjectPipelineAccess({
      id: pipelineId,
      cwd: args.cwd,
      filePath: normalizedFilePath,
    });
    if (!candidate.success) {
      validated ??= candidate;
      continue;
    }
    try {
      await stat(candidate.data.filePath);
      validated = candidate;
      break;
    } catch {
      validated ??= candidate;
    }
  }

  if (!validated?.success) {
    throw new Error(
      validated?.error ?? 'Project pipeline could not be resolved',
    );
  }

  const [content, fileStats] = await Promise.all([
    loadProjectPipelineFromDisk(validated.data.filePath),
    stat(validated.data.filePath),
  ]);
  const relativeFilePath = path
    .relative(validated.data.rootDir, validated.data.filePath)
    .split(path.sep)
    .join('/');

  return {
    pipeline: {
      info: {
        id: pipelineId,
        name: content.name,
        description: content.description ?? '',
        icon: content.icon ?? '',
        filename: relativeFilePath,
        createdAt: getCreatedAt(fileStats),
        updatedAt: fileStats.mtime.toISOString(),
        source: 'project',
        readonly: true,
        filePath: validated.data.filePath,
      },
      content,
    },
    pipelineId,
    pipelineFilePath: validated.data.filePath,
    repoPath: args.cwd,
    pipelinePreferenceLocator: {
      type: 'file',
      value: validated.data.filePath,
    },
    pipelineName: content.name ?? id,
  };
}

function isCanopyPlaceholderOnlyTemplate(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return false;
  }

  const remainder = trimmed.replace(CANOPY_TEMPLATE_TOKEN_PATTERN, '');
  return remainder.trim().length === 0;
}

function interpolateAndNormalizeInputs(args: {
  inputs: Record<string, string> | undefined;
  env: Record<string, string | undefined>;
  definitions: Record<string, PipelineInputDef> | undefined;
}): Record<string, string> | undefined {
  if (!args.inputs) {
    return undefined;
  }

  const nextInputs: Record<string, string> = {};
  for (const [key, rawValue] of Object.entries(args.inputs)) {
    const interpolatedValue = interpolateHookTemplate(rawValue, args.env);
    const definition = args.definitions?.[key];
    const shouldDropBlankOptionalInput =
      interpolatedValue.length === 0 &&
      definition !== undefined &&
      definition.required !== true;
    const shouldDropMissingRequiredPlaceholderInput =
      interpolatedValue.length === 0 &&
      definition?.required === true &&
      isCanopyPlaceholderOnlyTemplate(rawValue);
    if (
      shouldDropBlankOptionalInput ||
      shouldDropMissingRequiredPlaceholderInput
    ) {
      continue;
    }
    nextInputs[key] = interpolatedValue;
  }

  return Object.keys(nextInputs).length > 0 ? nextInputs : undefined;
}

function getDispatchInputDefinitions(args: {
  pipeline: Pipeline;
  label: string;
}): Record<string, PipelineInputDef> | undefined {
  if (!getTriggerTypes(args.pipeline.on).includes('dispatch')) {
    throw new Error(
      `Pipeline "${args.label}" does not define a dispatch trigger`,
    );
  }

  const normalized = normalizePipeline(args.pipeline);
  return getNormalizedTriggerInputDefs(normalized, 'dispatch');
}

function assertDispatchPipeline(args: {
  inputDefinitions: Record<string, PipelineInputDef> | undefined;
  inputs: Record<string, string> | undefined;
}): void {
  resolvePipelineInputs(args.inputDefinitions, args.inputs);
}

function hasWaitingQueuedPipeline(): boolean {
  return queuedHookPipelines.some((entry) => !entry.cancelled);
}

function toQueuedEntry(invocation: QueuedHookPipelineInvocation): {
  queueId: string;
  executionId: string;
  projectId: string;
  worktreeId: string;
  pipelineId: string;
  pipelineName: string;
  reason: 'pipeline-concurrency';
  reasonLabel: string;
  enqueuedAt: string;
  trigger_source: PipelineTriggerSource;
} {
  return {
    queueId: invocation.queueId,
    executionId: invocation.options.executionId,
    projectId: invocation.projectId,
    worktreeId: invocation.worktreeId,
    pipelineId: invocation.pipelineId,
    pipelineName: invocation.pipelineName,
    reason: 'pipeline-concurrency',
    reasonLabel: 'Waiting for active pipeline runs to finish',
    enqueuedAt: invocation.enqueuedAt,
    trigger_source: invocation.triggerSource,
  };
}

function emitQueueEvent(
  invocation: QueuedHookPipelineInvocation,
  event:
    | { type: 'queued'; entry: ReturnType<typeof toQueuedEntry> }
    | { type: 'started'; queueId: string }
    | { type: 'cancelled'; queueId: string }
    | {
        type: 'failed';
        queueId: string;
        entry: ReturnType<typeof toQueuedEntry>;
        error: string;
      },
): void {
  publishForeignPipelineQueueActivity({
    type: event.type,
    executionId: invocation.options.executionId,
    projectId: invocation.projectId,
    worktreeId: invocation.worktreeId,
  });
  sendToWindow(
    invocation.getWindow(),
    PIPELINE_CHANNELS.PIPELINE_QUEUE_EVENT,
    event,
  );
}

async function startReservedInvocation(
  invocation: QueuedHookPipelineInvocation,
): Promise<{ success: true } | { success: false; error: string }> {
  const authorizations: ChildPipelineAuthorization[] | undefined =
    backgroundExecutionContextEnabled() ? [] : undefined;
  const decision = await authorizeBackgroundExecution(
    invocation.executionContext,
    invocation.contextResources,
    { projectId: invocation.projectId, worktreeId: invocation.worktreeId },
    authorizations,
  );
  if (!decision.allow) {
    releaseExecutionReservation(invocation.options.executionId);
    return {
      success: false,
      error: decision.transient
        ? backgroundExecutionRetryMessage('run')
        : backgroundExecutionDeniedMessage(decision.reason, {
            ...(decision.subject ? { subject: decision.subject } : {}),
          }),
    };
  }
  const result = await startPipelineExecutionFromMain({
    pipeline: invocation.pipeline,
    options: {
      ...invocation.options,
      ...(authorizations === undefined
        ? {}
        : { childPipelineAuthorizations: authorizations }),
      executionId: invocation.options.executionId,
      triggerSource: invocation.triggerSource,
    },
    getWindow: invocation.getWindow,
    executionReservationClaimed: true,
  });

  if (!result.success) {
    releaseExecutionReservation(invocation.options.executionId);
    return { success: false, error: result.error };
  }

  return { success: true };
}

async function drainOnce(): Promise<void> {
  if (hasActivePipelineExecutions()) {
    return;
  }

  while (!hasActivePipelineExecutions()) {
    const invocation = queuedHookPipelines.shift();
    if (!invocation) {
      return;
    }

    if (invocation.cancelled) {
      continue;
    }

    reserveExecution(invocation.options.executionId);
    const started = await startReservedInvocation(invocation);
    if (started.success) {
      emitQueueEvent(invocation, {
        type: 'started',
        queueId: invocation.queueId,
      });
      return;
    }

    emitQueueEvent(invocation, {
      type: 'failed',
      queueId: invocation.queueId,
      entry: toQueuedEntry(invocation),
      error: started.error,
    });
  }
}

function scheduleDrain(): void {
  drainChain = drainChain.then(drainOnce, drainOnce).catch((): void => {});
}

subscribeToActiveCountChange((count): void => {
  if (count === 0) {
    scheduleDrain();
  }
});

/**
 * Resolve the exact Codex speed for a hook-launched run. The hook's own
 * boolean (or its deprecated alias) wins; only without one does the run
 * inherit the Codex default. Pipelines cannot run Ultra fast, so an Ultra fast
 * hook or inherited default is rejected here — before the pipeline is
 * resolved, an execution id is minted, or anything is queued or started —
 * instead of silently running another speed.
 */
async function resolveHookPipelineModelConfig(
  action: PipelineHookAction,
): Promise<AgentModelConfig> {
  const actionError = pipelineHookUnsupportedSpeedError(action);
  if (actionError) {
    throw new Error(actionError);
  }
  const actionSpeed = readCodexSpeedRecord(
    action.modelConfig,
    action.codexFastMode,
  );
  if (actionSpeed !== undefined) {
    return withCodexSpeed(undefined, actionSpeed);
  }
  const prefs = await readPreferencesFile();
  const defaultSpeed =
    readCodexSpeedRecord(
      prefs.providerModelConfigDefaults?.codex,
      prefs.codexFastModeDefaultEnabled,
    ) ?? DEFAULT_CODEX_SPEED;
  if (defaultSpeed === 'ultrafast') {
    throw new Error(
      'Pipeline hooks do not support Ultra fast. Choose Regular or Fast for this hook, or change the Codex default speed.',
    );
  }
  return withCodexSpeed(undefined, defaultSpeed);
}

export async function launchHookPipeline(args: {
  action: PipelineHookAction;
  cwd: string;
  projectId: string;
  worktreeId: string;
  env: Record<string, string | undefined>;
  triggerSource: PipelineTriggerSource;
  getWindow: () => BrowserWindow | null;
}): Promise<HookPipelineLaunchResult> {
  const modelConfig = await resolveHookPipelineModelConfig(args.action);
  const resolved = await resolveHookPipeline({
    action: args.action,
    cwd: args.cwd,
  });
  const inputDefinitions = getDispatchInputDefinitions({
    pipeline: resolved.pipeline.content,
    label: resolved.pipelineName,
  });
  const inputs = interpolateAndNormalizeInputs({
    inputs: args.action.inputs,
    env: args.env,
    definitions: inputDefinitions,
  });
  assertDispatchPipeline({
    inputDefinitions,
    inputs,
  });

  const executionId = createPipelineExecutionId();
  const options: ExecutePipelineRequestOptions & { executionId: string } = {
    cwd: args.cwd,
    pipelineId: resolved.pipelineId,
    repoPath: resolved.repoPath,
    eventName: 'dispatch',
    projectId: args.projectId,
    worktreeId: args.worktreeId,
    triggerSource: args.triggerSource,
    // A hook launch has no user present at execution time. `triggerSource` and
    // `initiationSource` are independent fields, and until now only the former
    // was set here — so `pipeline-usage-events.ts` had to derive hook
    // attribution from `trigger_source.kind`, and any consumer reading
    // `initiation_source` (such as the step-runner's AI Credits attendedness
    // check) saw `undefined` and treated a hook run as interactive. Set it at
    // the source so both agree (ECW-9091 review round 8).
    initiationSource: 'hook',
    initiator: { kind: 'hook' },
    ...(args.action.executionContext === undefined
      ? {}
      : { executionContext: args.action.executionContext }),
    modelConfig,
    executionId,
  };
  if (inputs !== undefined) {
    options.inputs = inputs;
  }
  if (resolved.pipelinePreferenceLocator !== undefined) {
    options.pipelinePreferenceLocator = resolved.pipelinePreferenceLocator;
  }
  if (resolved.pipelineFilePath !== undefined) {
    options.pipelineFilePath = resolved.pipelineFilePath;
  }

  if (
    args.action.allowPipelineConcurrency !== true &&
    (hasActivePipelineExecutions() || hasWaitingQueuedPipeline())
  ) {
    const invocation: QueuedHookPipelineInvocation = {
      queueId: `queued-pipeline-${createPipelineExecutionId()}`,
      projectId: args.projectId,
      worktreeId: args.worktreeId,
      pipelineId: resolved.pipelineId,
      pipelineName: resolved.pipelineName,
      pipeline: resolved.pipeline.content,
      options,
      triggerSource: args.triggerSource,
      getWindow: args.getWindow,
      enqueuedAt: new Date().toISOString(),
      cancelled: false,
      contextResources: resolved.pipelineFilePath
        ? localPipelineContextResources(resolved.pipeline.content, {
            cwd: options.cwd,
            pipelineFileDir: path.dirname(resolved.pipelineFilePath),
            pipelinePreferenceLocator: resolved.pipelinePreferenceLocator,
          })
        : pipelineContextResources(
            resolved.pipeline.content,
            resolved.pipeline.info.owner ??
              (resolved.pipeline.info.source === 'bundled'
                ? { type: 'system' }
                : resolved.pipeline.info.source === 'user'
                  ? { shareScope: 'private' }
                  : undefined),
            {
              cwd: options.cwd,
              repoPath: options.repoPath,
              getProjectPipelinesDirCandidates,
              pipelineId: resolved.pipeline.info.id,
              pipelinePreferenceLocator: resolved.pipelinePreferenceLocator,
            },
            resolved.pipeline.info.remoteId ?? resolved.pipeline.info.id,
          ),
      executionContext: args.action.executionContext,
    };
    queuedHookPipelines.push(invocation);
    emitQueueEvent(invocation, {
      type: 'queued',
      entry: toQueuedEntry(invocation),
    });
    return {
      status: 'queued',
      pipelineName: resolved.pipelineName,
      queueId: invocation.queueId,
    };
  }

  const invocation: QueuedHookPipelineInvocation = {
    queueId: `queued-pipeline-${createPipelineExecutionId()}`,
    projectId: args.projectId,
    worktreeId: args.worktreeId,
    pipelineId: resolved.pipelineId,
    pipelineName: resolved.pipelineName,
    pipeline: resolved.pipeline.content,
    options,
    triggerSource: args.triggerSource,
    getWindow: args.getWindow,
    enqueuedAt: new Date().toISOString(),
    cancelled: false,
    contextResources: resolved.pipelineFilePath
      ? localPipelineContextResources(resolved.pipeline.content, {
          cwd: options.cwd,
          pipelineFileDir: path.dirname(resolved.pipelineFilePath),
          pipelinePreferenceLocator: resolved.pipelinePreferenceLocator,
        })
      : pipelineContextResources(
          resolved.pipeline.content,
          resolved.pipeline.info.owner ??
            (resolved.pipeline.info.source === 'bundled'
              ? { type: 'system' }
              : resolved.pipeline.info.source === 'user'
                ? { shareScope: 'private' }
                : undefined),
          {
            cwd: options.cwd,
            repoPath: options.repoPath,
            getProjectPipelinesDirCandidates,
            pipelineId: resolved.pipeline.info.id,
            pipelinePreferenceLocator: resolved.pipelinePreferenceLocator,
          },
          resolved.pipeline.info.remoteId ?? resolved.pipeline.info.id,
        ),
    executionContext: args.action.executionContext,
  };
  reserveExecution(executionId);
  const started = await startReservedInvocation(invocation);
  if (!started.success) {
    throw new Error(started.error);
  }

  return {
    status: 'started',
    pipelineName: resolved.pipelineName,
    executionId,
  };
}

export function cancelQueuedHookPipeline(queueId: string): void {
  const index = queuedHookPipelines.findIndex(
    (entry) => entry.queueId === queueId,
  );
  if (index < 0) {
    return;
  }

  const invocation = queuedHookPipelines[index];
  if (!invocation || invocation.cancelled) {
    return;
  }

  queuedHookPipelines.splice(index, 1);
  invocation.cancelled = true;
  emitQueueEvent(invocation, {
    type: 'cancelled',
    queueId,
  });
}

export function listQueuedHookPipelines(): ReturnType<typeof toQueuedEntry>[] {
  return queuedHookPipelines
    .filter((entry) => !entry.cancelled)
    .map((entry) => toQueuedEntry(entry));
}

export const hookPipelineTestExports: {
  resetQueueForTests: () => void;
  scheduleDrain: () => void;
} = {
  resetQueueForTests: (): void => {
    queuedHookPipelines.splice(0, queuedHookPipelines.length);
    drainChain = Promise.resolve();
  },
  scheduleDrain,
};
