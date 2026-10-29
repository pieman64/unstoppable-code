import type { BrowserWindow } from 'electron';
import {
  IPC_CHANNELS,
  getExecutionHarnessForModel,
  resolveProviderModelConfig,
  type AgentModelConfig,
  type ChatModel,
  type DataModelDiffDiagram,
  type LogicDiffDiagram,
  type ParsedPlanGraph,
  type PlanDiagramArtifact,
  type ThinkingLevel,
  type TrackedPlanData,
  type TrackedPlansUpdatedEvent,
} from '@canopy/desktop-shared/types';
import {
  getTrackedPlan,
  removePlanDiagramArtifact,
  setPlanDiagramArtifact,
} from './plan-persistence';
import { resolveWorktreeCwd } from './resolve-worktree';
import { readPreferencesFile } from './preferences-store';
import { sendToWindow } from './window-send';
import {
  finalizeObservedHelperTask,
  startObservedHelperTask,
} from './helper-observed-task';
import {
  generateDataModelDiffDiagram,
  generateLogicDiffDiagram,
  generateSequenceDiagram,
} from './plan-diagram-generator';
import { createHelperTranscriptObserver } from './helper-transcript-observer';

const DEBOUNCE_MS = 2500;
const DATA_MODEL_PLAN_HINT_PATTERN =
  /\b(data model|database|schema|migration|migrate|table|column|entity|relationship|prisma|drizzle|sequelize|typeorm|postgres|mysql|sqlite|mongodb|sql|ddl|orm|foreign key|primary key)\b/i;

const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
const inFlight = new Set<string>();
const pending = new Set<string>();
/**
 * Attendedness of the call(s) that queued a pending rerun, keyed the same way as
 * `pending`. Tracked separately from the in-flight run because a user click and
 * a debounced content change can interleave either way: replaying the in-flight
 * call's flag would let a background regeneration inherit permission to spend
 * AI Credits, and would downgrade a user's explicit Generate into a silent
 * no-op. Sticky-true, mirroring `upgradeRefreshMode` in
 * `worktree-summary-scheduler.ts` (ECW-9091 review round 9).
 */
const pendingUserInitiated = new Set<string>();

interface PlanRef {
  projectId: string;
  worktreeId: string;
  planId: string;
}

function planKey(ref: PlanRef): string {
  return `${ref.projectId}/${ref.worktreeId}/${ref.planId}`;
}

export function schedulePlanDiagramGeneration(
  plan: TrackedPlanData,
  getWindow: () => BrowserWindow | null,
  options: { immediate?: boolean } = {},
): void {
  const ref: PlanRef = {
    projectId: plan.projectId,
    worktreeId: plan.worktreeId,
    planId: plan.id,
  };
  const key = planKey(ref);

  const existingTimer = debounceTimers.get(key);
  if (existingTimer) {
    clearTimeout(existingTimer);
    debounceTimers.delete(key);
  }

  // User-initiated generate/refresh runs right away; background triggers
  // (content changes) debounce so a flurry of edits coalesces into one run.
  if (options.immediate) {
    void runPlanDiagramGeneration(ref, getWindow, true);
    return;
  }

  const timer = setTimeout(() => {
    debounceTimers.delete(key);
    void runPlanDiagramGeneration(ref, getWindow);
  }, DEBOUNCE_MS);
  debounceTimers.set(key, timer);
}

function emitPlanUpdated(
  plan: TrackedPlanData,
  getWindow: () => BrowserWindow | null,
): void {
  const event: TrackedPlansUpdatedEvent = {
    projectId: plan.projectId,
    worktreeId: plan.worktreeId,
    plan,
  };
  sendToWindow(getWindow(), IPC_CHANNELS.trackedPlansUpdated, event);
}

interface DiagramRunContext {
  ref: PlanRef;
  plan: TrackedPlanData;
  model: ChatModel;
  modelConfig: AgentModelConfig;
  thinkingLevel: ThinkingLevel;
  repoPath: string;
  getWindow: () => BrowserWindow | null;
  /**
   * True for the `immediate` (user clicked Generate/Refresh) path, false for the
   * debounced content-change trigger. Gates AI Credits fallback (ECW-9091).
   */
  userInitiated: boolean;
}

async function runPlanDiagramGeneration(
  ref: PlanRef,
  getWindow: () => BrowserWindow | null,
  userInitiated = false,
): Promise<void> {
  const key = planKey(ref);

  if (inFlight.has(key)) {
    pending.add(key);
    // Record THIS caller's intent, not the in-flight run's.
    if (userInitiated) {
      pendingUserInitiated.add(key);
    }
    return;
  }

  inFlight.add(key);

  try {
    const plan = await getTrackedPlan(
      ref.projectId,
      ref.worktreeId,
      ref.planId,
    );
    if (!plan) {
      return;
    }

    const preferences = await readPreferencesFile();
    const model = preferences.planDiagramModel;
    const thinkingLevel = preferences.planDiagramThinkingLevel;
    const executionHarness = getExecutionHarnessForModel(model);
    if (!executionHarness) {
      throw new Error(
        `No execution harness is available for diagram model "${model}".`,
      );
    }
    const modelConfig = resolveProviderModelConfig(
      executionHarness,
      { thinkingLevel },
      preferences.providerModelConfigDefaults,
    );
    const repoPath = resolveWorktreeCwd(ref.projectId, ref.worktreeId);

    const context: DiagramRunContext = {
      ref,
      plan,
      model,
      modelConfig,
      thinkingLevel,
      repoPath,
      getWindow,
      userInitiated,
    };

    // Diagram family generations are independent: a failure in one must not
    // affect the others. Run them concurrently and never let one reject the
    // combined run.
    const shouldRunDataModelDiff =
      Boolean(plan.diagrams?.dataModelDiff) ||
      DATA_MODEL_PLAN_HINT_PATTERN.test(plan.content);
    const generations: Array<Promise<void>> = [
      runSequenceArtifact(context),
      runLogicDiffArtifact(context),
    ];
    if (shouldRunDataModelDiff) {
      generations.push(runDataModelDiffArtifact(context));
    }

    await Promise.allSettled(generations);
  } finally {
    inFlight.delete(key);
    if (pending.has(key)) {
      pending.delete(key);
      const queuedUserInitiated = pendingUserInitiated.delete(key);
      void runPlanDiagramGeneration(ref, getWindow, queuedUserInitiated);
    }
  }
}

async function runDataModelDiffArtifact(
  context: DiagramRunContext,
): Promise<void> {
  const { ref, plan, model, modelConfig, thinkingLevel, repoPath, getWindow } =
    context;
  const previousArtifact = plan.diagrams?.dataModelDiff;

  if (previousArtifact) {
    const generating: PlanDiagramArtifact<DataModelDiffDiagram> = {
      data: previousArtifact.data,
      derivedFromRevision: previousArtifact.derivedFromRevision,
      status: 'generating',
      ...(previousArtifact.generatedAt
        ? { generatedAt: previousArtifact.generatedAt }
        : {}),
    };
    await persistArtifact(ref, 'dataModelDiff', generating, getWindow);
  }

  const taskKey = `helper:plan-data-model-diagram:${ref.projectId}/${ref.worktreeId}/${ref.planId}:${plan.latestRevisionNumber}`;

  startObservedHelperTask({
    taskKey,
    eventType: 'worktree_plan_diagram',
    label: 'Plan Data Model Diagram',
    model,
    modelConfig,
    auditContext: {
      projectId: ref.projectId,
      worktreeId: ref.worktreeId,
      planId: ref.planId,
    },
  });

  try {
    const transcriptObserver = createHelperTranscriptObserver(taskKey);
    const { value, usage } = await generateDataModelDiffDiagram({
      userInitiated: context.userInitiated,
      planText: plan.content,
      repoPath,
      projectId: ref.projectId,
      model,
      modelConfig,
      thinkingLevel,
      transcriptObserver,
    });

    if (value?.applicable === true && value.diagram) {
      const ready: PlanDiagramArtifact<DataModelDiffDiagram> = {
        data: value.diagram,
        derivedFromRevision: plan.latestRevisionNumber,
        status: 'ready',
        generatedAt: new Date().toISOString(),
      };
      await persistArtifact(ref, 'dataModelDiff', ready, getWindow);
      finalizeObservedHelperTask(taskKey, 'success', undefined, usage);
      return;
    }

    if (value?.applicable === false) {
      if (previousArtifact) {
        const updated = await removePlanDiagramArtifact(
          ref.projectId,
          ref.worktreeId,
          ref.planId,
          'dataModelDiff',
          plan.latestRevisionNumber,
        );
        if (updated) {
          emitPlanUpdated(updated, getWindow);
        }
      }
      finalizeObservedHelperTask(taskKey, 'success', undefined, usage);
      return;
    }

    const message =
      value?.applicable === true
        ? 'Data model diagram generation returned no diagram'
        : 'Data model diagram generation returned no result';
    if (previousArtifact) {
      await persistArtifact(
        ref,
        'dataModelDiff',
        buildErrorArtifact(plan, previousArtifact, message),
        getWindow,
      );
    }
    finalizeObservedHelperTask(taskKey, 'failure', message, usage);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (previousArtifact) {
      await persistArtifact(
        ref,
        'dataModelDiff',
        buildErrorArtifact(plan, previousArtifact, message),
        getWindow,
      );
    }
    finalizeObservedHelperTask(taskKey, 'failure', message);
  }
}

async function runSequenceArtifact(context: DiagramRunContext): Promise<void> {
  const { ref, plan, model, modelConfig, thinkingLevel, repoPath, getWindow } =
    context;
  const previousArtifact = plan.diagrams?.sequence;

  // Mark the artifact 'generating' up front, preserving any prior data and
  // revision. With no prior data the renderer shows a loading state; with prior
  // data it shows the existing diagram under an "updating" indicator. This
  // makes both initial generation and a manual refresh show feedback.
  const generating: PlanDiagramArtifact<ParsedPlanGraph> = {
    data: previousArtifact?.data ?? null,
    derivedFromRevision:
      previousArtifact?.derivedFromRevision ?? plan.latestRevisionNumber,
    status: 'generating',
    ...(previousArtifact?.generatedAt
      ? { generatedAt: previousArtifact.generatedAt }
      : {}),
  };
  await persistArtifact(ref, 'sequence', generating, getWindow);

  const taskKey = `helper:plan-sequence-diagram:${ref.projectId}/${ref.worktreeId}/${ref.planId}:${plan.latestRevisionNumber}`;

  startObservedHelperTask({
    taskKey,
    eventType: 'worktree_plan_diagram',
    label: 'Plan Sequence Diagram',
    model,
    modelConfig,
    auditContext: {
      projectId: ref.projectId,
      worktreeId: ref.worktreeId,
      planId: ref.planId,
    },
  });

  try {
    const transcriptObserver = createHelperTranscriptObserver(taskKey);
    const { value, usage } = await generateSequenceDiagram({
      userInitiated: context.userInitiated,
      planText: plan.content,
      repoPath,
      projectId: ref.projectId,
      model,
      modelConfig,
      thinkingLevel,
      transcriptObserver,
    });

    if (value) {
      const ready: PlanDiagramArtifact<ParsedPlanGraph> = {
        data: value,
        derivedFromRevision: plan.latestRevisionNumber,
        status: 'ready',
        generatedAt: new Date().toISOString(),
      };
      await persistArtifact(ref, 'sequence', ready, getWindow);
      finalizeObservedHelperTask(taskKey, 'success', undefined, usage);
    } else {
      const message = 'Diagram generation returned no graph';
      await persistArtifact(
        ref,
        'sequence',
        buildErrorArtifact(plan, previousArtifact, message),
        getWindow,
      );
      finalizeObservedHelperTask(taskKey, 'failure', message, usage);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await persistArtifact(
      ref,
      'sequence',
      buildErrorArtifact(plan, previousArtifact, message),
      getWindow,
    );
    finalizeObservedHelperTask(taskKey, 'failure', message);
  }
}

async function runLogicDiffArtifact(context: DiagramRunContext): Promise<void> {
  const { ref, plan, model, modelConfig, thinkingLevel, repoPath, getWindow } =
    context;
  const previousArtifact = plan.diagrams?.logicDiff;

  // Mark 'generating' up front, preserving prior data/revision so a refresh of
  // an existing diagram shows the "updating" indicator over the old render.
  const generating: PlanDiagramArtifact<LogicDiffDiagram> = {
    data: previousArtifact?.data ?? null,
    derivedFromRevision:
      previousArtifact?.derivedFromRevision ?? plan.latestRevisionNumber,
    status: 'generating',
    ...(previousArtifact?.generatedAt
      ? { generatedAt: previousArtifact.generatedAt }
      : {}),
  };
  await persistArtifact(ref, 'logicDiff', generating, getWindow);

  const taskKey = `helper:plan-logic-diagram:${ref.projectId}/${ref.worktreeId}/${ref.planId}:${plan.latestRevisionNumber}`;

  startObservedHelperTask({
    taskKey,
    eventType: 'worktree_plan_diagram',
    label: 'Plan Logic Diagram',
    model,
    modelConfig,
    auditContext: {
      projectId: ref.projectId,
      worktreeId: ref.worktreeId,
      planId: ref.planId,
    },
  });

  try {
    const transcriptObserver = createHelperTranscriptObserver(taskKey);
    const { value, usage } = await generateLogicDiffDiagram({
      userInitiated: context.userInitiated,
      planText: plan.content,
      repoPath,
      projectId: ref.projectId,
      model,
      modelConfig,
      thinkingLevel,
      transcriptObserver,
    });

    if (value) {
      const ready: PlanDiagramArtifact<LogicDiffDiagram> = {
        data: value,
        derivedFromRevision: plan.latestRevisionNumber,
        status: 'ready',
        generatedAt: new Date().toISOString(),
      };
      await persistArtifact(ref, 'logicDiff', ready, getWindow);
      finalizeObservedHelperTask(taskKey, 'success', undefined, usage);
    } else {
      const message = 'Diagram generation returned no graph';
      await persistArtifact(
        ref,
        'logicDiff',
        buildErrorArtifact(plan, previousArtifact, message),
        getWindow,
      );
      finalizeObservedHelperTask(taskKey, 'failure', message, usage);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await persistArtifact(
      ref,
      'logicDiff',
      buildErrorArtifact(plan, previousArtifact, message),
      getWindow,
    );
    finalizeObservedHelperTask(taskKey, 'failure', message);
  }
}

function buildErrorArtifact<T>(
  plan: TrackedPlanData,
  previousArtifact: PlanDiagramArtifact<T> | undefined,
  error: string,
): PlanDiagramArtifact<T> {
  return {
    data: previousArtifact?.data ?? null,
    derivedFromRevision: plan.latestRevisionNumber,
    status: 'error',
    error,
    ...(previousArtifact?.generatedAt
      ? { generatedAt: previousArtifact.generatedAt }
      : {}),
  };
}

async function persistArtifact(
  ref: PlanRef,
  kind: 'sequence' | 'logicDiff' | 'dataModelDiff',
  artifact:
    | PlanDiagramArtifact<ParsedPlanGraph>
    | PlanDiagramArtifact<LogicDiffDiagram>
    | PlanDiagramArtifact<DataModelDiffDiagram>,
  getWindow: () => BrowserWindow | null,
): Promise<void> {
  const updated = await setPlanDiagramArtifact(
    ref.projectId,
    ref.worktreeId,
    ref.planId,
    kind,
    artifact,
  );
  if (updated) {
    emitPlanUpdated(updated, getWindow);
  }
}
