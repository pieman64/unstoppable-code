import {
  CREATE_WORKTREE_OUTPUTS,
  emptyCreateWorktreeOutputs,
  parseCreateWorktreeInputs,
} from '../host-create-worktree';

function parseError(inputs: Record<string, string | undefined>): string {
  const result = parseCreateWorktreeInputs(inputs);
  if (result.ok) {
    throw new Error('expected a parse error');
  }
  return result.message;
}

describe('parseCreateWorktreeInputs', () => {
  it('defaults everything but the project', () => {
    expect(parseCreateWorktreeInputs({ project_id: 'ws-1' })).toEqual({
      ok: true,
      value: {
        projectId: 'ws-1',
        branch: { kind: 'default' },
        repair: false,
        setup: 'skip',
      },
    });
  });

  it('accepts workspace_id as an alias and matching aliases together', () => {
    expect(parseCreateWorktreeInputs({ workspace_id: ' ws-1 ' })).toMatchObject(
      { ok: true, value: { projectId: 'ws-1' } },
    );
    expect(
      parseCreateWorktreeInputs({ project_id: 'ws-1', workspace_id: 'ws-1 ' }),
    ).toMatchObject({ ok: true, value: { projectId: 'ws-1' } });
  });

  it('requires a project and refuses mismatched or unsafe ids', () => {
    expect(parseError({ project_id: '  ', workspace_id: '' })).toBe(
      'create-worktree requires "project_id" or "workspace_id"',
    );
    expect(parseError({ project_id: 'ws-1', workspace_id: 'ws-2' })).toBe(
      'create-worktree "project_id" and "workspace_id" must match',
    );
    expect(parseError({ workspace_id: '../ws' })).toBe(
      'create-worktree "workspace_id" must be lowercase alphanumeric with hyphens',
    );
    expect(parseError({ project_id: 'WS' })).toBe(
      'create-worktree "project_id" must be lowercase alphanumeric with hyphens',
    );
  });

  it('parses base task aliases', () => {
    expect(
      parseCreateWorktreeInputs({
        project_id: 'ws-1',
        base_worktree_id: ' wt-1 ',
        branch: ' Feature/X ',
      }),
    ).toEqual({
      ok: true,
      value: {
        projectId: 'ws-1',
        branch: { kind: 'new', name: 'Feature/X' },
        baseTaskId: 'wt-1',
        repair: false,
        setup: 'skip',
      },
    });
    expect(
      parseError({
        project_id: 'ws-1',
        base_task_id: 'wt-1',
        base_worktree_id: 'wt-2',
      }),
    ).toBe('create-worktree "base_task_id" and "base_worktree_id" must match');
    expect(parseError({ project_id: 'ws-1', base_task_id: 'wt/1' })).toBe(
      'create-worktree "base_task_id" must be lowercase alphanumeric with hyphens',
    );
  });

  it('parses an existing branch, preserving case', () => {
    expect(
      parseCreateWorktreeInputs({
        project_id: 'ws-1',
        existing_branch: ' Release/1.2 ',
      }),
    ).toMatchObject({
      ok: true,
      value: { branch: { kind: 'existing', name: 'Release/1.2' } },
    });
  });

  it('refuses an existing branch with any branch selection', () => {
    expect(
      parseError({ project_id: 'ws-1', existing_branch: 'a', branch: 'b' }),
    ).toBe(
      'create-worktree "existing_branch" can\'t be combined with "branch"',
    );
    expect(
      parseError({
        project_id: 'ws-1',
        existing_branch: 'a',
        base_branch: 'main',
      }),
    ).toBe(
      'create-worktree "existing_branch" can\'t be combined with "base_branch"',
    );
    expect(
      parseError({
        project_id: 'ws-1',
        existing_branch: 'a',
        base_worktree_id: 'wt-1',
      }),
    ).toBe(
      'create-worktree "existing_branch" can\'t be combined with "base_worktree_id"',
    );
  });

  it('refuses a base branch with a base task', () => {
    expect(
      parseError({
        project_id: 'ws-1',
        base_task_id: 'wt-1',
        base_branch: 'main',
      }),
    ).toBe(
      'create-worktree "base_branch" can\'t be combined with "base_task_id"',
    );
  });

  it('treats blank branch and group as omitted', () => {
    expect(
      parseCreateWorktreeInputs({
        project_id: 'ws-1',
        branch: '   ',
        group: ' ',
        base_branch: ' main ',
      }),
    ).toEqual({
      ok: true,
      value: {
        projectId: 'ws-1',
        branch: { kind: 'default' },
        baseBranch: 'main',
        repair: false,
        setup: 'skip',
      },
    });
  });

  it('parses booleans and keeps omitted restore_claude_md apart from false', () => {
    expect(
      parseCreateWorktreeInputs({
        project_id: 'ws-1',
        repair: ' TRUE ',
        restore_claude_md: 'False',
      }),
    ).toMatchObject({
      ok: true,
      value: { repair: true, restoreClaudeMd: false },
    });
    const omitted = parseCreateWorktreeInputs({ project_id: 'ws-1' });
    expect(omitted.ok && 'restoreClaudeMd' in omitted.value).toBe(false);
    expect(parseError({ project_id: 'ws-1', repair: 'yes' })).toBe(
      'create-worktree input "repair" must be true or false',
    );
    expect(parseError({ project_id: 'ws-1', restore_claude_md: '1' })).toBe(
      'create-worktree input "restore_claude_md" must be true or false',
    );
  });

  it('normalizes the setup mode and refuses unknown modes', () => {
    expect(
      parseCreateWorktreeInputs({
        project_id: 'ws-1',
        worktree_setup: ' Run_And_Wait ',
      }),
    ).toMatchObject({ ok: true, value: { setup: 'run_and_wait' } });
    expect(
      parseCreateWorktreeInputs({ project_id: 'ws-1', worktree_setup: '' }),
    ).toMatchObject({ ok: true, value: { setup: 'skip' } });
    expect(parseError({ project_id: 'ws-1', worktree_setup: 'later' })).toBe(
      'create-worktree "worktree_setup" must be one of: skip, run, run_and_wait',
    );
  });

  it('parses a group name and refuses none', () => {
    expect(
      parseCreateWorktreeInputs({ project_id: 'ws-1', group: ' Reviews ' }),
    ).toMatchObject({ ok: true, value: { group: 'Reviews' } });
    expect(parseError({ project_id: 'ws-1', group: 'NONE' })).toBe(
      'create-worktree "group" can\'t be none; leave it out to skip grouping',
    );
  });

  it('reports the first failure in input order', () => {
    expect(
      parseError({
        project_id: 'ws-1',
        workspace_id: 'ws-2',
        base_task_id: 'x/y',
        worktree_setup: 'nope',
        group: 'none',
      }),
    ).toBe('create-worktree "project_id" and "workspace_id" must match');
    expect(
      parseError({
        project_id: 'ws-1',
        repair: 'maybe',
        worktree_setup: 'nope',
        group: 'none',
      }),
    ).toBe('create-worktree input "repair" must be true or false');
    expect(
      parseError({ project_id: 'ws-1', worktree_setup: 'nope', group: 'none' }),
    ).toBe(
      'create-worktree "worktree_setup" must be one of: skip, run, run_and_wait',
    );
  });
});

describe('emptyCreateWorktreeOutputs', () => {
  it('declares every output empty with false booleans', () => {
    const outputs = emptyCreateWorktreeOutputs();
    expect(Object.keys(outputs).sort()).toEqual(
      [...CREATE_WORKTREE_OUTPUTS].sort(),
    );
    expect(outputs.grouped).toBe('false');
    expect(outputs.group_created).toBe('false');
    for (const name of CREATE_WORKTREE_OUTPUTS) {
      if (name !== 'grouped' && name !== 'group_created') {
        expect(outputs[name]).toBe('');
      }
    }
  });
});
