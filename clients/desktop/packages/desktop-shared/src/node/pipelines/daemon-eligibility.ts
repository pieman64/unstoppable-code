import * as path from 'node:path';
import { resolveActionRuntime } from './action-resolver';
import type { ResolvedActionRuntime } from './action-resolver';
import type { ExecutionRuntime } from './executor/types';
import {
  getExecutionHarnessForModel,
  getModelSource,
} from '@canopy/desktop-shared/types';
import type {
  ActionDefinition,
  Pipeline,
  ShellType,
  Step,
} from '@canopy/desktop-shared/types/pipeline';

export const DAEMON_PIPELINE_REFUSAL_REASONS = [
  'model_step',
  'host_step',
  'child_pipeline',
  'tsx_runtime',
  'dynamic_action',
  'unresolved_action',
  'too_deep',
  'unknown_runtime',
  // CAN-5095: when model steps are admitted, a model step the daemon cannot run.
  'model_provider',
  'model_action',
  'dynamic_model',
  'model_alias',
  'plugin_collections',
] as const;
export type DaemonPipelineRefusalReason =
  (typeof DAEMON_PIPELINE_REFUSAL_REASONS)[number];

/**
 * Bundled actions that call a model (CAN-5086). Every bundled action that
 * declares `log_format_hint: agent` is refused by that hint as well; these
 * names also cover the actions that reach the Claude SDK without it.
 */
export const DAEMON_MODEL_BUILTIN_ACTIONS: ReadonlySet<string> = new Set([
  'agent-loop',
  'agent-prompt',
  'agent-resume',
  'condenser',
  'git-commit-push',
  'github-create-pr',
  'parallel-agents',
  'plan-with-review',
  'quality-gate',
  'router',
]);

/** The harness a daemon model step runs on (CAN-5095). */
export type DaemonModelHarness = 'claude' | 'codex';

/**
 * Bundled model actions the daemon runs when model steps are admitted, and
 * the harnesses each may use (CAN-5095 D2). Every other model action stays
 * in process.
 */
export const DAEMON_PORTABLE_MODEL_ACTIONS: ReadonlyMap<
  string,
  readonly DaemonModelHarness[]
> = new Map([
  ['agent-prompt', ['claude', 'codex']],
  ['agent-resume', ['claude', 'codex']],
  ['agent-loop', ['claude']],
  ['plan-with-review', ['claude']],
  ['quality-gate', ['claude']],
  ['router', ['claude']],
  ['condenser', ['claude']],
]);

/** How deep composite actions may nest before a pipeline is refused. */
export const DAEMON_PIPELINE_MAX_COMPOSITE_DEPTH = 8;

export interface DaemonPipelineClassifierOptions {
  /** `'refuse'` (default): any model step is `model_step`. */
  readonly modelSteps?: 'refuse' | 'claude_codex';
}

export type DaemonPipelineClassification =
  | {
      readonly eligible: true;
      /** Admitted model steps, composite steps included (0 under `'refuse'`). */
      readonly modelSteps: number;
      /** The harnesses those steps run on, sorted, without repeats. */
      readonly modelHarnesses: readonly DaemonModelHarness[];
    }
  | {
      readonly eligible: false;
      readonly reason: DaemonPipelineRefusalReason;
      /** The top-level job and step index that holds the refused step. */
      readonly jobId: string;
      readonly stepIndex: number;
      readonly uses?: string;
    };

export interface DaemonPipelineClassifierContext {
  readonly runtime: Pick<
    ExecutionRuntime,
    | 'bundledActionsDir'
    | 'getProjectActionsDir'
    | 'getProjectActionsDirCandidates'
  >;
  /** The repository project actions resolve in; the run's `repoPath` or `cwd`. */
  readonly repoPath?: string;
}

const BUILTIN_ACTION_PREFIX = 'builtin/';

function resolveOrNull(
  uses: string,
  context: DaemonPipelineClassifierContext,
): ResolvedActionRuntime | null {
  try {
    return resolveActionRuntime(uses, context.runtime, context.repoPath);
  } catch {
    return null;
  }
}

/** The bundled action a `builtin/` reference resolves to, normalized as the resolver does. */
function builtinActionName(
  uses: string,
  resolved: ResolvedActionRuntime,
  context: DaemonPipelineClassifierContext,
): string | null {
  if (!uses.startsWith(BUILTIN_ACTION_PREFIX)) return null;
  return path.relative(
    path.resolve(context.runtime.bundledActionsDir),
    resolved.actionDir,
  );
}

/**
 * `inheritedShell` is the shell a step without its own runs with, as the
 * executor resolves it: the job's or pipeline's run default, or a composite
 * parent step's shell.
 */
function classifyStep(
  step: Step,
  context: DaemonPipelineClassifierContext,
  depth: number,
  inheritedShell: ShellType | undefined,
): DaemonPipelineRefusalReason | null {
  if (step.log_format_hint === 'agent') return 'model_step';
  const shell = step.shell ?? inheritedShell;
  const uses = step.uses;
  if (uses === undefined) {
    return shell === 'tsx' ? 'tsx_runtime' : null;
  }
  if (uses.includes('${{')) return 'dynamic_action';
  const resolved = resolveOrNull(uses, context);
  if (!resolved) return 'unresolved_action';
  const definition = resolved.definition;
  if (definition.log_format_hint === 'agent') return 'model_step';
  const builtin = builtinActionName(uses, resolved, context);
  // Case-insensitive volumes resolve `builtin/Condenser` to `condenser`.
  if (
    builtin !== null &&
    DAEMON_MODEL_BUILTIN_ACTIONS.has(builtin.toLowerCase())
  ) {
    return 'model_step';
  }
  switch (definition.runs.using) {
    case 'host':
      return 'host_step';
    case 'pipeline':
      return 'child_pipeline';
    case 'tsx':
      return 'tsx_runtime';
    case 'node':
    case 'python':
      return null;
    case 'composite':
      return classifySteps(definition.runs.steps, context, depth + 1, shell);
    default:
      return 'unknown_runtime';
  }
}

function classifySteps(
  steps: readonly Step[],
  context: DaemonPipelineClassifierContext,
  depth: number,
  inheritedShell: ShellType | undefined,
): DaemonPipelineRefusalReason | null {
  if (depth > DAEMON_PIPELINE_MAX_COMPOSITE_DEPTH) return 'too_deep';
  for (const step of steps) {
    const reason = classifyStep(step, context, depth, inheritedShell);
    if (reason) return reason;
  }
  return null;
}

/** Admitted model steps found while walking a pipeline (CAN-5095). */
interface ModelStepTally {
  count: number;
  readonly harnesses: Set<DaemonModelHarness>;
}

function stepModelValue(step: Step, definition: ActionDefinition): string {
  const value = step.with?.model;
  if (value !== undefined) return String(value);
  const fallback = definition.inputs?.model?.default;
  return typeof fallback === 'string' ? fallback : '';
}

/** The model checks for a step of portable model action `name` (CAN-5095 D5a). */
function classifyModelStep(
  pipeline: Pipeline,
  step: Step,
  definition: ActionDefinition,
  name: string,
  tally: ModelStepTally,
): DaemonPipelineRefusalReason | null {
  if (pipeline.model_aliases?.length) return 'model_alias';
  if (
    pipeline.plugin_collections?.length ||
    step.with?.plugin_collection_id !== undefined
  ) {
    return 'plugin_collections';
  }
  const value = stepModelValue(step, definition);
  if (value.includes('${{')) return 'dynamic_model';
  const model = value.trim();
  let harness: DaemonModelHarness;
  if (model.length === 0) {
    harness = 'claude';
  } else {
    if (getModelSource(model) === 'ollama') return 'model_provider';
    const resolved = getExecutionHarnessForModel(model);
    const allowed = DAEMON_PORTABLE_MODEL_ACTIONS.get(name) ?? [];
    const admitted = allowed.find((candidate) => candidate === resolved);
    if (admitted === undefined) return 'model_provider';
    harness = admitted;
  }
  tally.count += 1;
  tally.harnesses.add(harness);
  return null;
}

function classifyStepAdmittingModels(
  pipeline: Pipeline,
  step: Step,
  context: DaemonPipelineClassifierContext,
  depth: number,
  inheritedShell: ShellType | undefined,
  tally: ModelStepTally,
): DaemonPipelineRefusalReason | null {
  const shell = step.shell ?? inheritedShell;
  const uses = step.uses;
  if (uses === undefined) {
    if (step.log_format_hint === 'agent') return 'model_action';
    return shell === 'tsx' ? 'tsx_runtime' : null;
  }
  if (uses.includes('${{')) return 'dynamic_action';
  const resolved = resolveOrNull(uses, context);
  if (!resolved) return 'unresolved_action';
  const definition = resolved.definition;
  switch (definition.runs.using) {
    case 'composite':
      return classifyStepsAdmittingModels(
        pipeline,
        definition.runs.steps,
        context,
        depth + 1,
        shell,
        tally,
      );
    case 'host':
      return 'host_step';
    case 'pipeline':
      return 'child_pipeline';
    case 'tsx':
      return 'tsx_runtime';
    case 'node':
    case 'python': {
      // Case-insensitive volumes resolve `builtin/Condenser` to `condenser`.
      const name = builtinActionName(uses, resolved, context)?.toLowerCase();
      if (name !== undefined && DAEMON_PORTABLE_MODEL_ACTIONS.has(name)) {
        return classifyModelStep(pipeline, step, definition, name, tally);
      }
      if (
        step.log_format_hint === 'agent' ||
        definition.log_format_hint === 'agent' ||
        (name !== undefined && DAEMON_MODEL_BUILTIN_ACTIONS.has(name))
      ) {
        return 'model_action';
      }
      return null;
    }
    default:
      return 'unknown_runtime';
  }
}

function classifyStepsAdmittingModels(
  pipeline: Pipeline,
  steps: readonly Step[],
  context: DaemonPipelineClassifierContext,
  depth: number,
  inheritedShell: ShellType | undefined,
  tally: ModelStepTally,
): DaemonPipelineRefusalReason | null {
  if (depth > DAEMON_PIPELINE_MAX_COMPOSITE_DEPTH) return 'too_deep';
  for (const step of steps) {
    const reason = classifyStepAdmittingModels(
      pipeline,
      step,
      context,
      depth,
      inheritedShell,
      tally,
    );
    if (reason) return reason;
  }
  return null;
}

/**
 * Whether every step of `pipeline` can run in the daemon (CAN-5086). By
 * default a step that calls a model refuses the run; with
 * `modelSteps: 'claude_codex'` the Claude and Codex steps CAN-5095 D2 admits
 * are counted instead. Fails closed on anything unknown.
 */
export function classifyDaemonPipeline(
  pipeline: Pipeline,
  context: DaemonPipelineClassifierContext,
  options?: DaemonPipelineClassifierOptions,
): DaemonPipelineClassification {
  const admitModels = options?.modelSteps === 'claude_codex';
  const tally: ModelStepTally = { count: 0, harnesses: new Set() };
  for (const [jobId, job] of Object.entries(pipeline.jobs)) {
    const jobShell = job.defaults?.run?.shell ?? pipeline.defaults?.run?.shell;
    for (const [stepIndex, step] of job.steps.entries()) {
      const reason = admitModels
        ? classifyStepAdmittingModels(
            pipeline,
            step,
            context,
            0,
            jobShell,
            tally,
          )
        : classifyStep(step, context, 0, jobShell);
      if (reason) {
        return {
          eligible: false,
          reason,
          jobId,
          stepIndex,
          ...(step.uses !== undefined ? { uses: step.uses } : {}),
        };
      }
    }
  }
  return {
    eligible: true,
    modelSteps: tally.count,
    modelHarnesses: [...tally.harnesses].sort(),
  };
}
