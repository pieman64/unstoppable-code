import type {
  PipelineExecutionScope,
  PipelineInfo,
  PipelineScopeConfig,
} from '@canopy/desktop-shared/types/pipeline';
import {
  DEFAULT_PIPELINE_SCOPES,
  executionContextSatisfies,
  isPipelineExecutionScope,
} from '@canopy/desktop-shared/pipelines/scope';

/**
 * Renderer-side scope-filter helper shared by every trigger surface.
 *
 * Visibility uses the SAME capability relation as the runtime gate
 * (`executionContextSatisfies`) — NOT strict membership. A `worktree` surface
 * therefore still lists `directory`-only and legacy no-`scope` pipelines (a
 * worktree provides a directory cwd), while a pure `directory`/`global`
 * surface hides `worktree`-only pipelines.
 *
 * A pipeline with no/unknown `scopes` is treated as `['directory']` so older
 * server responses and legacy YAML stay visible exactly as before.
 */
export function pipelineSupportsExecutionScope(
  info: Pick<PipelineInfo, 'scopes'>,
  scope: PipelineExecutionScope,
): boolean {
  return executionContextSatisfies(
    info.scopes ?? DEFAULT_PIPELINE_SCOPES,
    scope,
  );
}

/**
 * Return the scopes to display for a pipeline summary. Missing/legacy
 * `PipelineInfo.scopes` means the implicit `directory` scope.
 */
export function readPipelineInfoScopes(
  info: Pick<PipelineInfo, 'scopes'>,
): PipelineExecutionScope[] {
  return info.scopes ?? [...DEFAULT_PIPELINE_SCOPES];
}

/**
 * Read the declared scope set off a pipeline's `scope` config for the settings
 * editor. A missing declaration is rendered as the implicit `['directory']`
 * default, and any unexpected value (legacy/malformed) also falls back to the
 * default so the editor never shows an empty, un-saveable selection.
 */
export function readPipelineScopeSelection(
  scope: unknown,
): PipelineExecutionScope[] {
  if (scope === undefined || scope === null) {
    return [...DEFAULT_PIPELINE_SCOPES];
  }
  const raw = Array.isArray(scope) ? scope : [scope];
  const result: PipelineExecutionScope[] = [];
  for (const entry of raw) {
    if (isPipelineExecutionScope(entry) && !result.includes(entry)) {
      result.push(entry);
    }
  }
  return result.length > 0 ? result : [...DEFAULT_PIPELINE_SCOPES];
}

/**
 * Serialize a selected scope set back into a `Pipeline.scope` value: a single
 * scope writes a bare string (cleaner YAML), multiple scopes write an array.
 * The selection is ordered canonically (`global`, `directory`, `worktree`) so
 * the emitted YAML is stable regardless of toggle order.
 */
export function toPipelineScopeValue(
  scopes: readonly PipelineExecutionScope[],
): PipelineScopeConfig {
  const ordered: PipelineExecutionScope[] = (
    ['global', 'directory', 'worktree'] as const
  ).filter((scope) => scopes.includes(scope));
  if (ordered.length === 1) {
    return ordered[0];
  }
  return ordered;
}
