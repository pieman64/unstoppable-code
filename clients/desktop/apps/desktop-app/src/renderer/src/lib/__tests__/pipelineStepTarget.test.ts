import type { PipelineRunTarget } from '@canopy/desktop-shared/types/pipeline';
import {
  buildStepTargetFromForm,
  readStepTargetForm,
  type StepTargetFormState,
} from '../pipelineStepTarget';

describe('readStepTargetForm', () => {
  it('reads a missing target as inherit', () => {
    expect(readStepTargetForm(undefined).scope).toBe('inherit');
  });

  it('reads a directory target with a path', () => {
    const form = readStepTargetForm({ scope: 'directory', path: './child' });
    expect(form.scope).toBe('directory');
    expect(form.path).toBe('./child');
  });

  it('reads an existing-worktree target', () => {
    const form = readStepTargetForm({
      scope: 'worktree',
      workspace_id: 'ws',
      worktree: { id: 'wt' },
    });
    expect(form.scope).toBe('worktree');
    expect(form.workspaceId).toBe('ws');
    expect(form.worktreeId).toBe('wt');
  });
});

function form(overrides: Partial<StepTargetFormState>): StepTargetFormState {
  return {
    scope: 'inherit',
    path: '',
    workspaceId: '',
    worktreeId: '',
    ...overrides,
  };
}

describe('buildStepTargetFromForm', () => {
  it('builds inherit and global targets', () => {
    expect(buildStepTargetFromForm(form({ scope: 'inherit' }))).toEqual({
      scope: 'inherit',
    });
    expect(buildStepTargetFromForm(form({ scope: 'global' }))).toEqual({
      scope: 'global',
    });
  });

  it('omits an empty directory path', () => {
    expect(buildStepTargetFromForm(form({ scope: 'directory' }))).toEqual({
      scope: 'directory',
    });
    expect(
      buildStepTargetFromForm(form({ scope: 'directory', path: './c' })),
    ).toEqual({ scope: 'directory', path: './c' });
  });

  it('builds an existing-worktree target', () => {
    expect(
      buildStepTargetFromForm(
        form({
          scope: 'worktree',
          workspaceId: 'ws',
          worktreeId: 'wt',
        }),
      ),
    ).toEqual({
      scope: 'worktree',
      workspace_id: 'ws',
      worktree: { id: 'wt' },
    });
  });

  it('round-trips every scope through read -> build', () => {
    const targets: PipelineRunTarget[] = [
      { scope: 'inherit' },
      { scope: 'global' },
      { scope: 'directory', path: './child' },
      { scope: 'worktree', workspace_id: 'ws', worktree: { id: 'wt' } },
    ];
    for (const target of targets) {
      expect(buildStepTargetFromForm(readStepTargetForm(target))).toEqual(
        target,
      );
    }
  });

  it('never produces undefined — editing a field cannot drop the target', () => {
    // Whatever scope is selected, the editor always rebuilds a concrete target
    // object, so an edit to one field can never silently remove `target`.
    for (const scope of [
      'inherit',
      'global',
      'directory',
      'worktree',
    ] as const) {
      expect(buildStepTargetFromForm(form({ scope }))).toBeDefined();
    }
  });
});
