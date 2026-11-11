/**
 * Browser-safe contract for the `create-worktree` host step.
 *
 * The executor parses inputs with {@link parseCreateWorktreeInputs}; desktop
 * main creates the worktree through its canonical creation boundary. The CLI
 * injects a routed creation host when W5 ownership selects it, and otherwise
 * keeps the Node fallback. Both CLI paths refuse desktop-only inputs.
 */
import { presentInput, SAFE_ID_RE, type HostInputParse } from './host-actions';

export const WORKTREE_SETUP_MODES = ['skip', 'run', 'run_and_wait'] as const;

export type WorktreeSetupMode = (typeof WORKTREE_SETUP_MODES)[number];

/** `setup_state` values; the output stays `''` before setup is admitted. */
export type WorktreeSetupState =
  | 'skipped'
  | 'started'
  | 'succeeded'
  | 'failed'
  | 'timed_out'
  | 'none_configured';

export type CreateWorktreeBranch =
  | { kind: 'default' }
  | { kind: 'new'; name: string }
  | { kind: 'existing'; name: string };

export interface CreateWorktreeInputs {
  projectId: string;
  branch: CreateWorktreeBranch;
  baseBranch?: string;
  baseTaskId?: string;
  repair: boolean;
  /** Absent when omitted, so the boundary keeps its own default. */
  restoreClaudeMd?: boolean;
  setup: WorktreeSetupMode;
  /** A group name; creation never removes or addresses a group by id. */
  group?: string;
}

/**
 * Every output the action declares except `failure_reason`, which the
 * executor (or the CLI fallback) adds.
 */
export const CREATE_WORKTREE_OUTPUTS = [
  'project_id',
  'task_id',
  'workspace_id',
  'worktree_id',
  'path',
  'branch_name',
  'created_at',
  'setup_state',
  'setup_exit_code',
  'setup_log_file',
  'setup_results_file',
  'group_id',
  'group_created',
  'grouped',
  'not_grouped_reason',
] as const;

export type CreateWorktreeOutputName = (typeof CREATE_WORKTREE_OUTPUTS)[number];

/** Every output `''` except `grouped`/`group_created: 'false'`. */
export function emptyCreateWorktreeOutputs(): Record<string, string> {
  const outputs: Record<string, string> = {};
  for (const name of CREATE_WORKTREE_OUTPUTS) {
    outputs[name] = '';
  }
  outputs.grouped = 'false';
  outputs.group_created = 'false';
  return outputs;
}

/** Both identifier pairs, so YAML written against either name keeps working. */
export function createWorktreeIdentifierOutputs(
  projectId: string,
  taskId: string,
): Record<string, string> {
  return {
    project_id: projectId,
    workspace_id: projectId,
    task_id: taskId,
    worktree_id: taskId,
  };
}

const ACTION = 'create-worktree';

function unsafeIdMessage(input: string): string {
  return `${ACTION} "${input}" must be lowercase alphanumeric with hyphens`;
}

function conflictMessage(input: string, other: string): string {
  return `${ACTION} "${input}" can't be combined with "${other}"`;
}

/** Two alias inputs: either may be set; both must agree after trimming. */
function parseAliasedId(
  inputs: Record<string, string | undefined>,
  primary: string,
  alias: string,
): HostInputParse<{ id: string; input: string } | undefined> {
  const primaryValue = presentInput(inputs, primary);
  const aliasValue = presentInput(inputs, alias);
  if (
    primaryValue !== undefined &&
    aliasValue !== undefined &&
    primaryValue !== aliasValue
  ) {
    return {
      ok: false,
      message: `${ACTION} "${primary}" and "${alias}" must match`,
    };
  }
  if (primaryValue !== undefined) {
    return SAFE_ID_RE.test(primaryValue)
      ? { ok: true, value: { id: primaryValue, input: primary } }
      : { ok: false, message: unsafeIdMessage(primary) };
  }
  if (aliasValue !== undefined) {
    return SAFE_ID_RE.test(aliasValue)
      ? { ok: true, value: { id: aliasValue, input: alias } }
      : { ok: false, message: unsafeIdMessage(alias) };
  }
  return { ok: true, value: undefined };
}

function parseBoolean(
  inputs: Record<string, string | undefined>,
  name: string,
): HostInputParse<boolean | undefined> {
  const value = presentInput(inputs, name)?.toLowerCase();
  if (value === undefined) return { ok: true, value: undefined };
  if (value === 'true') return { ok: true, value: true };
  if (value === 'false') return { ok: true, value: false };
  return {
    ok: false,
    message: `${ACTION} input "${name}" must be true or false`,
  };
}

function parseSetupMode(
  inputs: Record<string, string | undefined>,
): HostInputParse<WorktreeSetupMode> {
  const value = presentInput(inputs, 'worktree_setup')?.toLowerCase();
  if (value === undefined) return { ok: true, value: 'skip' };
  const mode = WORKTREE_SETUP_MODES.find((candidate) => candidate === value);
  return mode === undefined
    ? {
        ok: false,
        message: `${ACTION} "worktree_setup" must be one of: ${WORKTREE_SETUP_MODES.join(', ')}`,
      }
    : { ok: true, value: mode };
}

interface BranchSelection {
  branch: CreateWorktreeBranch;
  baseBranch?: string;
  baseTaskId?: string;
}

function parseBranchSelection(
  inputs: Record<string, string | undefined>,
): HostInputParse<BranchSelection> {
  const baseTask = parseAliasedId(inputs, 'base_task_id', 'base_worktree_id');
  if (!baseTask.ok) return baseTask;
  const existingBranch = presentInput(inputs, 'existing_branch');
  const branch = presentInput(inputs, 'branch');
  const baseBranch = presentInput(inputs, 'base_branch');
  if (existingBranch !== undefined) {
    const conflict =
      branch !== undefined
        ? 'branch'
        : baseBranch !== undefined
          ? 'base_branch'
          : baseTask.value?.input;
    return conflict === undefined
      ? {
          ok: true,
          value: { branch: { kind: 'existing', name: existingBranch } },
        }
      : { ok: false, message: conflictMessage('existing_branch', conflict) };
  }
  if (baseBranch !== undefined && baseTask.value !== undefined) {
    return {
      ok: false,
      message: conflictMessage('base_branch', baseTask.value.input),
    };
  }
  return {
    ok: true,
    value: {
      branch:
        branch === undefined
          ? { kind: 'default' }
          : { kind: 'new', name: branch },
      ...(baseBranch !== undefined ? { baseBranch } : {}),
      ...(baseTask.value !== undefined
        ? { baseTaskId: baseTask.value.id }
        : {}),
    },
  };
}

/**
 * Validates in input order so the first failure is deterministic. Branch-name
 * validity (Git ref rules, collisions) is left to the creation boundary.
 */
export function parseCreateWorktreeInputs(
  inputs: Record<string, string | undefined>,
): HostInputParse<CreateWorktreeInputs> {
  const project = parseAliasedId(inputs, 'project_id', 'workspace_id');
  if (!project.ok) return project;
  if (project.value === undefined) {
    return {
      ok: false,
      message: `${ACTION} requires "project_id" or "workspace_id"`,
    };
  }
  const selection = parseBranchSelection(inputs);
  if (!selection.ok) return selection;
  const repair = parseBoolean(inputs, 'repair');
  if (!repair.ok) return repair;
  const restoreClaudeMd = parseBoolean(inputs, 'restore_claude_md');
  if (!restoreClaudeMd.ok) return restoreClaudeMd;
  const setup = parseSetupMode(inputs);
  if (!setup.ok) return setup;
  // Creating never removes a group: `none` is a name to join here, and means
  // "remove" only to move-to-group (CAN-5479).
  const group = presentInput(inputs, 'group');
  return {
    ok: true,
    value: {
      projectId: project.value.id,
      ...selection.value,
      repair: repair.value === true,
      ...(restoreClaudeMd.value !== undefined
        ? { restoreClaudeMd: restoreClaudeMd.value }
        : {}),
      setup: setup.value,
      ...(group !== undefined ? { group } : {}),
    },
  };
}
