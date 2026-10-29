import type { PipelineRunTarget } from './document';

/**
 * Normalizes a `builtin/run-pipeline` step `target` declaration into a
 * validated `PipelineRunTarget`.
 *
 * This is the agreed contract semantics consumed by both the backend
 * (normalization, validation, executor, runtime gating) and the frontend
 * (editor validation). YAML uses snake_case only — camelCase keys are
 * rejected as unexpected fields.
 *
 * Rules:
 * - Undefined/null returns undefined (caller defaults to `{ scope: 'inherit' }`).
 * - The value must be a plain object with a required `scope`.
 * - Only the allowed keys for each scope are accepted.
 * - `worktree` requires `workspace_id` and `worktree.id`.
 * - `directory.path` is optional; when omitted the child uses the parent's
 *   effective cwd.
 * - `global` and `inherit` cannot carry path/workspace/worktree fields.
 * - Worktree creation is intentionally not part of `run-pipeline`; use
 *   `builtin/create-worktree` first, then pass the returned id here.
 */

const TARGET_SCOPES = ['inherit', 'global', 'directory', 'worktree'] as const;
type TargetScope = (typeof TARGET_SCOPES)[number];

const REMOVED_WORKTREE_CREATION_KEYS = [
  'base_worktree_id',
  'branch',
  'base_branch',
  'repair',
  'restore_claude_md',
] as const;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertAllowedKeys(
  obj: Record<string, unknown>,
  allowed: readonly string[],
  location: string,
): void {
  const allowedSet = new Set(allowed);
  const extra = Object.keys(obj).filter((key) => !allowedSet.has(key));
  if (extra.length > 0) {
    throw new Error(
      `${location} has unexpected field(s): ${extra.join(', ')}. Allowed: ${allowed.join(', ')}`,
    );
  }
}

function requireString(value: unknown, fieldLocation: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${fieldLocation} must be a non-empty string`);
  }
  return value;
}

function optionalString(
  value: unknown,
  fieldLocation: string,
): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  return requireString(value, fieldLocation);
}

function isTargetScope(value: unknown): value is TargetScope {
  if (typeof value !== 'string') {
    return false;
  }
  for (const scope of TARGET_SCOPES) {
    if (value === scope) {
      return true;
    }
  }
  return false;
}

function normalizeDirectoryTarget(
  value: Record<string, unknown>,
  location: string,
): PipelineRunTarget {
  assertAllowedKeys(value, ['scope', 'path'], `${location} target`);
  const path = optionalString(value.path, `${location} target.path`);
  return path === undefined
    ? { scope: 'directory' }
    : { scope: 'directory', path };
}

function normalizeWorktreeTarget(
  value: Record<string, unknown>,
  location: string,
): PipelineRunTarget {
  const removedCreationFields = REMOVED_WORKTREE_CREATION_KEYS.filter(
    (key) => value[key] !== undefined,
  );
  if (removedCreationFields.length > 0) {
    throw new Error(
      `${location} target no longer supports worktree creation field(s): ${removedCreationFields.join(', ')}. Use builtin/create-worktree before builtin/run-pipeline.`,
    );
  }

  assertAllowedKeys(
    value,
    ['scope', 'workspace_id', 'worktree'],
    `${location} target`,
  );

  const workspaceId = requireString(
    value.workspace_id,
    `${location} target.workspace_id`,
  );

  const worktree = value.worktree;
  if (!isPlainObject(worktree)) {
    throw new Error(
      `${location} target.worktree must be an object with an "id" string`,
    );
  }
  if (worktree.new !== undefined) {
    throw new Error(
      `${location} target.worktree.new is no longer supported. Use builtin/create-worktree before builtin/run-pipeline.`,
    );
  }
  assertAllowedKeys(worktree, ['id'], `${location} target.worktree`);

  const id = requireString(worktree.id, `${location} target.worktree.id`);
  return { scope: 'worktree', workspace_id: workspaceId, worktree: { id } };
}

export function normalizePipelineRunTarget(
  value: unknown,
  location: string,
): PipelineRunTarget | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (!isPlainObject(value)) {
    throw new Error(`${location} target must be an object`);
  }

  const scope = value.scope;
  if (scope === undefined) {
    throw new Error(`${location} target.scope is required`);
  }
  if (!isTargetScope(scope)) {
    const scopeLabel =
      typeof scope === 'string' ? scope : JSON.stringify(scope);
    throw new Error(
      `${location} target.scope "${scopeLabel}" is not supported. Supported values: ${TARGET_SCOPES.join(', ')}`,
    );
  }

  switch (scope) {
    case 'inherit':
      assertAllowedKeys(value, ['scope'], `${location} target`);
      return { scope: 'inherit' };
    case 'global':
      assertAllowedKeys(value, ['scope'], `${location} target`);
      return { scope: 'global' };
    case 'directory':
      return normalizeDirectoryTarget(value, location);
    case 'worktree':
      return normalizeWorktreeTarget(value, location);
  }
}
