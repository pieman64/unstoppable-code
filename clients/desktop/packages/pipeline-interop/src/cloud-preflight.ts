import type { Pipeline, ShellType, Step } from './document';
import { normalizePipelineScopes } from './scope';

/*
 * Cloud run preflight (CAN-6169, plan CP-18): every step a cloud run cannot
 * execute, found in the definition before the run is recorded, so no sandbox
 * starts for a run that would be refused.
 *
 * Two sources, both in `docs/pipelines-cloud-parity.md`:
 *
 * - The pipeline host gaps. The cloud runner is the daemon pipeline host,
 *   which refuses these at start (`classifyDaemonPipeline`, run with model
 *   steps and owner-settled host steps admitted). Preflight refuses the same
 *   steps for the same reason until a ticket closes each gap.
 * - The parity matrix refusals (R4, R5, R7, R8, R11), which the host would
 *   run but the cloud must not.
 *
 * Unlike the host, preflight lists every refused step, not the first. Model
 * and harness checks against the cloud catalog (R1 to R3, R9) are CP-26's.
 */

export const CLOUD_RUN_REFUSAL_REASONS = [
  // Pipeline host gaps, named as `DAEMON_PIPELINE_REFUSAL_REASONS` names them.
  'tsx_runtime',
  'child_pipeline',
  'model_action',
  'dynamic_action',
  'dynamic_model',
  'model_alias',
  'plugin_collections',
  'host_paths',
  'host_inputs',
  'unresolved_action',
  // Parity matrix refusals and the cloud run scope.
  'action_scope',
  'orchestrator',
  'desktop_path',
  'windows_shell',
  'local_state',
  'run_scope',
] as const;

export type CloudRunRefusalReason = (typeof CLOUD_RUN_REFUSAL_REASONS)[number];

/** One refused item: the step that holds it, or the whole definition. */
export interface CloudRunRefusal {
  readonly reason: CloudRunRefusalReason;
  /**
   * The parity matrix row (`R4`), pipeline host gap (`G1`) or plan ticket
   * (`CP-29`) that explains the refusal and its alternative.
   */
  readonly parityId: string;
  readonly message: string;
  /** Absent for a refusal of the whole definition. */
  readonly jobId?: string;
  readonly stepIndex?: number;
  readonly uses?: string;
}

/**
 * What the pipeline host decides for a step that runs a bundled action with
 * no inputs: `portable`, or the host's refusal reason. Taken from
 * `classifyDaemonPipeline` over the bundled manifests; the
 * `cloud-preflight-host-parity` golden fails when the two disagree or a
 * bundled action is missing here. Composite actions pass their model through
 * an expression, which the host refuses as `dynamic_model` (G4).
 */
export const CLOUD_RUN_BUNDLED_ACTIONS: Readonly<
  Record<string, 'portable' | CloudRunRefusalReason>
> = {
  'agent-loop': 'portable',
  'agent-prompt': 'portable',
  'agent-resume': 'portable',
  coder: 'dynamic_model',
  'comms-setup': 'portable',
  'complexity-assessor': 'dynamic_model',
  condenser: 'portable',
  'context-discovery': 'dynamic_model',
  'create-bot-entry': 'portable',
  'create-project-entry': 'portable',
  'create-worktree': 'portable',
  'discover-review-tracks': 'portable',
  discovery: 'dynamic_model',
  'gather-linear-context': 'portable',
  'git-commit-push': 'model_action',
  'git-workspace-details': 'portable',
  'github-create-pr': 'model_action',
  'github-fetch-branch-pr': 'portable',
  'github-post-review-comment': 'portable',
  'greenfield-detection': 'dynamic_model',
  'hello-world-js': 'portable',
  'hello-world-py': 'portable',
  'hello-world-ts': 'tsx_runtime',
  'historical-context': 'dynamic_model',
  'http-request': 'portable',
  memory: 'portable',
  'memory-read': 'portable',
  'memory-write': 'portable',
  'move-to-group': 'portable',
  notify: 'portable',
  'parallel-agents': 'model_action',
  'phase-compaction': 'dynamic_model',
  'pipeline-report': 'portable',
  'plan-path-validation': 'portable',
  'plan-validation': 'dynamic_model',
  'plan-with-review': 'portable',
  planner: 'dynamic_model',
  'qa-fixer': 'dynamic_model',
  'qa-reviewer': 'dynamic_model',
  'quality-gate': 'portable',
  'read-linear-ticket': 'portable',
  'request-input': 'portable',
  'requirements-from-task': 'dynamic_model',
  'requirements-interactive': 'dynamic_model',
  router: 'portable',
  'run-pipeline': 'child_pipeline',
  'send-agent-message': 'portable',
  'spec-critic': 'dynamic_model',
  'spec-gatherer': 'dynamic_model',
  'spec-quick': 'dynamic_model',
  'spec-researcher': 'dynamic_model',
  'spec-validation': 'dynamic_model',
  'spec-writer': 'dynamic_model',
  'wait-for-agent-reply': 'portable',
};

/**
 * The bundled model actions the host runs (`DAEMON_PORTABLE_MODEL_ACTIONS`).
 * Their step inputs are checked as the host checks them.
 */
export const CLOUD_RUN_PORTABLE_MODEL_ACTIONS: ReadonlySet<string> = new Set([
  'agent-prompt',
  'agent-resume',
  'agent-loop',
  'plan-with-review',
  'quality-gate',
  'router',
  'condenser',
]);

/** The bundled host actions (`runs.using: host`) the owner settles. */
export const CLOUD_RUN_HOST_ACTIONS: ReadonlySet<string> = new Set([
  'create-bot-entry',
  'create-project-entry',
  'create-worktree',
  'move-to-group',
  'send-agent-message',
  'wait-for-agent-reply',
]);

/**
 * Bundled actions whose manifest `scope` leaves out `global`, which the
 * executor refuses in a global run. The host parity golden reads the scopes
 * from the manifests.
 */
export const CLOUD_RUN_BUNDLED_ACTIONS_OUTSIDE_GLOBAL: ReadonlySet<string> =
  new Set([
    'discover-review-tracks',
    'git-commit-push',
    'git-workspace-details',
    'github-create-pr',
    'github-fetch-branch-pr',
    'github-post-review-comment',
  ]);

/** Host actions that reach the Orchestrator when they name a `bot_id` (R4). */
const BOT_TARGET_ACTIONS: ReadonlySet<string> = new Set([
  'move-to-group',
  'send-agent-message',
  'wait-for-agent-reply',
]);

/** `send-agent-message` inputs naming desktop task files (R11). */
const SEND_DESKTOP_FILE_INPUTS = [
  'attachment_paths',
  'attachment_prompt_contexts',
  'file_references',
] as const;

/** `send-agent-message` inputs only the app's executor resolves. */
const SEND_APP_RESOLVED_INPUTS = ['model', 'plugin_collection_id'] as const;

const WINDOWS_SHELLS: ReadonlySet<ShellType> = new Set([
  'pwsh',
  'powershell',
  'cmd',
]);

const MESSAGES: Readonly<Record<CloudRunRefusalReason, string>> = {
  tsx_runtime: "Cloud runs can't run TypeScript (tsx) steps yet.",
  child_pipeline: "Cloud runs can't start child workflows yet.",
  model_action: "Cloud runs can't run this agent action yet.",
  dynamic_action: "Cloud runs can't run an action chosen by an expression yet.",
  dynamic_model: "Cloud runs can't use a model chosen by an expression yet.",
  model_alias: "Cloud runs can't use this workflow's model aliases yet.",
  plugin_collections: "Cloud runs can't use plugin collections yet.",
  host_paths: 'This message attaches files from your computer.',
  host_inputs:
    "Cloud runs can't send a message with its own model or plugin collection yet.",
  unresolved_action: "Cloud runs can't find this action.",
  action_scope:
    'This action runs only in a folder or worktree, and cloud runs are global for now.',
  orchestrator: 'The Orchestrator only runs in the desktop app.',
  desktop_path: 'This step uses a folder on your computer.',
  windows_shell: "Cloud runs use Linux, which doesn't have this shell.",
  local_state:
    'Files listed in local_state stay on the computer that owns them.',
  run_scope:
    "This workflow doesn't run as a global workflow, which cloud runs need for now.",
};

const BUILTIN_PREFIX = 'builtin/';

function isExpression(value: unknown): boolean {
  return typeof value === 'string' && value.includes('${{');
}

/**
 * The bundled action a `builtin/` reference names, normalized as the
 * resolver normalizes it (`builtin/./run-pipeline` is `run-pipeline`), or
 * null when it leaves the bundled actions folder. Case is kept: the runner's
 * Linux file system resolves names exactly.
 */
function bundledActionName(uses: string): string | null {
  const segments = uses
    .slice(BUILTIN_PREFIX.length)
    .split('/')
    .filter((segment) => segment !== '' && segment !== '.');
  if (segments.length === 0 || segments.includes('..')) return null;
  return segments.join('/');
}

/** A folder that names a place on the computer, not one inside the checkout. */
function isDesktopPath(value: unknown): boolean {
  if (typeof value !== 'string' || isExpression(value)) return false;
  const path = value.trim().replace(/\\/g, '/');
  return (
    path.startsWith('/') ||
    path.startsWith('~') ||
    /^[A-Za-z]:/.test(path) ||
    escapesItsFolder(path)
  );
}

/** Whether a relative path's `..` segments climb above the folder it starts in. */
function escapesItsFolder(path: string): boolean {
  let depth = 0;
  for (const segment of path.split('/')) {
    if (segment === '..') depth -= 1;
    else if (segment !== '' && segment !== '.') depth += 1;
    if (depth < 0) return true;
  }
  return false;
}

interface StepAt {
  readonly jobId: string;
  readonly stepIndex: number;
  readonly step: Step;
}

/** Where a refused item is: a step, a whole job, or the whole definition. */
type At = StepAt | { readonly jobId: string };

type Refuse = (
  reason: CloudRunRefusalReason,
  parityId: string,
  at?: At,
) => void;

function checkHostAction(name: string, at: StepAt, refuse: Refuse): void {
  const input = at.step.with ?? {};
  if (name === 'create-bot-entry') refuse('orchestrator', 'R4', at);
  if (BOT_TARGET_ACTIONS.has(name) && input.bot_id !== undefined)
    refuse('orchestrator', 'R4', at);
  if (name !== 'send-agent-message') return;
  if (SEND_DESKTOP_FILE_INPUTS.some((key) => input[key] !== undefined))
    refuse('host_paths', 'R11', at);
  else if (input.attachments !== undefined) refuse('host_paths', 'G6', at);
  if (SEND_APP_RESOLVED_INPUTS.some((key) => input[key] !== undefined))
    refuse('host_inputs', 'CP-24', at);
}

function checkModelAction(
  pipeline: Pipeline,
  at: StepAt,
  refuse: Refuse,
): void {
  const input = at.step.with ?? {};
  if (
    (pipeline.plugin_collections?.length ?? 0) > 0 ||
    input.plugin_collection_id !== undefined
  ) {
    refuse('plugin_collections', 'CP-25', at);
    return;
  }
  const model = input.model === undefined ? '' : String(input.model);
  if (isExpression(model)) refuse('dynamic_model', 'G4', at);
  else if (pipeline.model_aliases?.some((alias) => alias.id === model.trim()))
    refuse('model_alias', 'CP-24', at);
}

function checkStep(
  pipeline: Pipeline,
  at: StepAt,
  inheritedShell: ShellType | undefined,
  refuse: Refuse,
): void {
  const { step } = at;
  const shell = step.shell ?? inheritedShell;
  if (shell !== undefined && WINDOWS_SHELLS.has(shell))
    refuse('windows_shell', 'R7', at);
  if (isDesktopPath(step.working_directory) || isDesktopPath(step.with?.cwd))
    refuse('desktop_path', 'R5', at);
  const uses = step.uses;
  if (uses === undefined) {
    if (step.log_format_hint === 'agent') refuse('model_action', 'G3', at);
    else if (shell === 'tsx') refuse('tsx_runtime', 'G1', at);
    return;
  }
  if (isExpression(uses)) {
    refuse('dynamic_action', 'G4', at);
    return;
  }
  // Project and marketplace actions resolve in a checkout (CP-29).
  const name = uses.startsWith(BUILTIN_PREFIX) ? bundledActionName(uses) : null;
  const verdict =
    name !== null &&
    Object.prototype.hasOwnProperty.call(CLOUD_RUN_BUNDLED_ACTIONS, name)
      ? CLOUD_RUN_BUNDLED_ACTIONS[name]
      : undefined;
  if (name === null || verdict === undefined) {
    refuse('unresolved_action', 'CP-29', at);
    return;
  }
  if (verdict !== 'portable') {
    refuse(verdict, parityIdOf(verdict), at);
    return;
  }
  if (CLOUD_RUN_BUNDLED_ACTIONS_OUTSIDE_GLOBAL.has(name)) {
    refuse('action_scope', 'CP-29', at);
    return;
  }
  if (CLOUD_RUN_HOST_ACTIONS.has(name)) checkHostAction(name, at, refuse);
  else if (CLOUD_RUN_PORTABLE_MODEL_ACTIONS.has(name))
    checkModelAction(pipeline, at, refuse);
  else if (step.log_format_hint === 'agent') refuse('model_action', 'G3', at);
}

function parityIdOf(reason: CloudRunRefusalReason): string {
  switch (reason) {
    case 'tsx_runtime':
      return 'G1';
    case 'child_pipeline':
      return 'G2';
    case 'model_action':
      return 'G3';
    case 'dynamic_action':
    case 'dynamic_model':
      return 'G4';
    default:
      return 'CP-29';
  }
}

/**
 * Every item of `pipeline` a global cloud run refuses, in document order;
 * empty when it may run. Throws only when the definition's `scope` is
 * invalid, as normalization does.
 */
export function preflightCloudRun(
  pipeline: Pipeline,
): readonly CloudRunRefusal[] {
  const refusals: CloudRunRefusal[] = [];
  const refuse: Refuse = (reason, parityId, at) => {
    refusals.push({
      reason,
      parityId,
      message: MESSAGES[reason],
      ...(at === undefined ? {} : { jobId: at.jobId }),
      ...(at === undefined || !('step' in at)
        ? {}
        : {
            stepIndex: at.stepIndex,
            ...(at.step.uses === undefined ? {} : { uses: at.step.uses }),
          }),
    });
  };
  if (!normalizePipelineScopes(pipeline.scope, 'scope').includes('global'))
    refuse('run_scope', 'CP-29');
  if ((pipeline.local_state?.length ?? 0) > 0) refuse('local_state', 'R8');
  if (isDesktopPath(pipeline.defaults?.run?.working_directory))
    refuse('desktop_path', 'R5');
  for (const [jobId, job] of Object.entries(pipeline.jobs)) {
    const shell = job.defaults?.run?.shell ?? pipeline.defaults?.run?.shell;
    if (isDesktopPath(job.defaults?.run?.working_directory))
      refuse('desktop_path', 'R5', { jobId });
    // Raw text is parsed, not normalized, so a job may lack its steps.
    if (!Array.isArray(job.steps)) continue;
    for (const [stepIndex, step] of job.steps.entries())
      checkStep(pipeline, { jobId, stepIndex, step }, shell, refuse);
  }
  return refusals;
}
