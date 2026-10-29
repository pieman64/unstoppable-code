import type { PipelineRunTarget } from '@canopy/desktop-shared/types/pipeline';

/**
 * Pure read/build helpers for a `builtin/run-pipeline` step `target`. The
 * structured step editor edits the flattened {@link StepTargetFormState}, and
 * these functions translate to/from the snake_case {@link PipelineRunTarget}
 * stored on the step. Keeping them pure (and out of the component file) lets
 * them round-trip in tests and keeps fast-refresh happy.
 */

export type StepTargetScope = 'inherit' | 'global' | 'directory' | 'worktree';

/** Flattened, editable representation of a {@link PipelineRunTarget}. */
export interface StepTargetFormState {
  scope: StepTargetScope;
  path: string;
  workspaceId: string;
  worktreeId: string;
}

export const EMPTY_TARGET_FORM: StepTargetFormState = {
  scope: 'inherit',
  path: '',
  workspaceId: '',
  worktreeId: '',
};

/**
 * Read a `target` into editable form fields. A missing target reads as
 * `inherit` (the documented default for a `run-pipeline` step).
 */
export function readStepTargetForm(
  target: PipelineRunTarget | undefined,
): StepTargetFormState {
  if (!target) {
    return { ...EMPTY_TARGET_FORM };
  }
  switch (target.scope) {
    case 'inherit':
      return { ...EMPTY_TARGET_FORM, scope: 'inherit' };
    case 'global':
      return { ...EMPTY_TARGET_FORM, scope: 'global' };
    case 'directory':
      return {
        ...EMPTY_TARGET_FORM,
        scope: 'directory',
        path: target.path ?? '',
      };
    case 'worktree': {
      return {
        ...EMPTY_TARGET_FORM,
        scope: 'worktree',
        workspaceId: target.workspace_id,
        worktreeId: target.worktree.id,
      };
    }
  }
}

/**
 * Build a snake_case {@link PipelineRunTarget} from the editor's form state.
 * Empty optional fields are omitted (never emitted as empty strings), and
 * camelCase keys are never produced — the structured editor emits snake_case
 * only.
 */
export function buildStepTargetFromForm(
  form: StepTargetFormState,
): PipelineRunTarget {
  switch (form.scope) {
    case 'inherit':
      return { scope: 'inherit' };
    case 'global':
      return { scope: 'global' };
    case 'directory':
      return form.path !== ''
        ? { scope: 'directory', path: form.path }
        : { scope: 'directory' };
    case 'worktree':
      return {
        scope: 'worktree',
        workspace_id: form.workspaceId,
        worktree: { id: form.worktreeId },
      };
  }
}
