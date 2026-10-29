import {
  PIPELINE_EXECUTION_SCOPES,
  type PipelineExecutionScope,
} from '@canopy/protocol/pipelines';

/**
 * Shared, pure scope/capability helpers for pipeline + action execution
 * scopes. These have no Node/fs dependency, and are shared by desktop execution and hosted pipeline catalog validation. The
 * normalization/derivation semantics defined here are the agreed contract
 * that both the backend (normalization, validation, executor, runtime gating)
 * and the frontend (editor validation, scope filter helper) consume.
 */

/** Default scopes for a pipeline that declares no `scope`. */
export const DEFAULT_PIPELINE_SCOPES: PipelineExecutionScope[] = ['directory'];

/** Every execution scope — the default for an action that declares no `scope`. */
export const ALL_PIPELINE_EXECUTION_SCOPES: PipelineExecutionScope[] = [
  'global',
  'directory',
  'worktree',
];

function supportedScopesSuffix(): string {
  return `Supported values: ${PIPELINE_EXECUTION_SCOPES.join(', ')}`;
}

/** Type guard for a single valid execution-scope string. */
export function isPipelineExecutionScope(
  value: unknown,
): value is PipelineExecutionScope {
  if (typeof value !== 'string') {
    return false;
  }
  for (const scope of PIPELINE_EXECUTION_SCOPES) {
    if (value === scope) {
      return true;
    }
  }
  return false;
}

export interface NormalizePipelineScopeConfigOptions {
  /** Scopes to return when the value is undefined/null. */
  defaultScopes: readonly PipelineExecutionScope[];
  /**
   * Human-readable prefix for validation messages, e.g. `Pipeline` or
   * `Action "/abs/path/action.yml"`. Messages are formatted as
   * `${location} scope ...`.
   */
  location: string;
}

/**
 * Normalize a raw `scope` declaration (string | string[] | undefined) into a
 * deduplicated array of valid execution scopes.
 *
 * - Undefined/null returns `options.defaultScopes` (copied).
 * - A string must be one of `global`/`directory`/`worktree`.
 * - An array must be non-empty and contain only unique valid scope strings.
 * - Duplicate values fail validation.
 * - Any unsupported value fails with a location-specific message.
 */
export function normalizePipelineScopeConfig(
  value: unknown,
  options: NormalizePipelineScopeConfigOptions,
): PipelineExecutionScope[] {
  const { defaultScopes, location } = options;

  if (value === undefined || value === null) {
    return [...defaultScopes];
  }

  if (typeof value === 'string') {
    if (!isPipelineExecutionScope(value)) {
      throw new Error(
        `${location} scope "${value}" is not supported. ${supportedScopesSuffix()}`,
      );
    }
    return [value];
  }

  if (Array.isArray(value)) {
    if (value.length === 0) {
      throw new Error(`${location} scope must contain at least one scope`);
    }

    const result: PipelineExecutionScope[] = [];
    for (const entry of value) {
      if (!isPipelineExecutionScope(entry)) {
        throw new Error(
          `${location} scope "${String(entry)}" is not supported. ${supportedScopesSuffix()}`,
        );
      }
      if (result.includes(entry)) {
        throw new Error(
          `${location} scope contains duplicate value "${entry}"`,
        );
      }
      result.push(entry);
    }
    return result;
  }

  throw new Error(`${location} scope must be a string or string array`);
}

/**
 * Normalize a pipeline `scope` declaration. Missing scope defaults to
 * `['directory']`.
 */
export function normalizePipelineScopes(
  value: unknown,
  location: string,
): PipelineExecutionScope[] {
  return normalizePipelineScopeConfig(value, {
    defaultScopes: DEFAULT_PIPELINE_SCOPES,
    location,
  });
}

/**
 * Normalize an action `scope` declaration. Missing scope defaults to all
 * scopes (`global`/`directory`/`worktree`).
 */
export function normalizeActionScopes(
  value: unknown,
  location: string,
): PipelineExecutionScope[] {
  return normalizePipelineScopeConfig(value, {
    defaultScopes: ALL_PIPELINE_EXECUTION_SCOPES,
    location,
  });
}

/**
 * Capability check for ONE actual execution context. A worktree context also
 * provides a plain directory cwd, so it satisfies `directory` requirements;
 * `directory` and `global` contexts do not provide a worktree. This is the
 * authoritative single-context gate used for top-level run gating, the
 * per-step action gate, child `run-pipeline` target validation, and UI
 * visibility.
 */
export function executionContextSatisfies(
  declaredScopes: readonly PipelineExecutionScope[],
  contextScope: PipelineExecutionScope,
): boolean {
  return (
    declaredScopes.includes(contextScope) ||
    (contextScope === 'worktree' && declaredScopes.includes('directory'))
  );
}

/**
 * Expand a declared scope set to the execution contexts it can actually run
 * in, applying the worktree ⊇ directory rule:
 *   ['directory'] -> ['directory','worktree']
 *   ['worktree']  -> ['worktree']
 *   ['global']    -> ['global']
 */
export function reachableExecutionContexts(
  declaredScopes: readonly PipelineExecutionScope[],
): PipelineExecutionScope[] {
  return PIPELINE_EXECUTION_SCOPES.filter((context) =>
    executionContextSatisfies(declaredScopes, context),
  );
}

/**
 * Set intersection over EXECUTION CONTEXTS (after expansion via
 * `reachableExecutionContexts`). Static-compatibility primitive: a pipeline
 * and an action are statically compatible iff their reachable contexts
 * overlap, and an `inherit` child is statically valid iff parent and child
 * reachable contexts overlap. It is NOT applied to raw declared scopes — doing
 * so would reject backwards-compatible pairs such as a `directory` pipeline
 * using a `worktree` action, which both run fine in a worktree context.
 */
export function scopesOverlap(
  left: readonly PipelineExecutionScope[],
  right: readonly PipelineExecutionScope[],
): boolean {
  const rightContexts = reachableExecutionContexts(right);
  return reachableExecutionContexts(left).some((context) =>
    rightContexts.includes(context),
  );
}
