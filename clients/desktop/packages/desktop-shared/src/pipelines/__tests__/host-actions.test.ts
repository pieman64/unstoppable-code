import {
  buildPipelineHostIdempotencyKey,
  emptyMoveToGroupOutputs,
  isPipelineHostActionId,
  parseMoveToGroupInputs,
  PipelineHostRefusal,
} from '../host-actions';

function parseError(inputs: Record<string, string | undefined>): string {
  const result = parseMoveToGroupInputs(inputs);
  if (result.ok) {
    throw new Error('expected a parse error');
  }
  return result.message;
}

describe('parseMoveToGroupInputs', () => {
  it('parses a project task with a group name and color', () => {
    expect(
      parseMoveToGroupInputs({
        project_id: ' ws-1 ',
        task_id: 'wt-1',
        group: ' Reviews ',
        color: 'categorical-2',
      }),
    ).toEqual({
      ok: true,
      value: {
        task: { kind: 'project', projectId: 'ws-1', taskId: 'wt-1' },
        target: { kind: 'name', name: 'Reviews', color: 'categorical-2' },
      },
    });
  });

  it('parses a bot task with a group id', () => {
    expect(
      parseMoveToGroupInputs({
        bot_id: 'app_advisor',
        task_id: 'entry-1',
        group_id: 'grp-abc',
      }),
    ).toEqual({
      ok: true,
      value: {
        task: { kind: 'bot', botId: 'app_advisor', taskId: 'entry-1' },
        target: { kind: 'id', groupId: 'grp-abc' },
      },
    });
  });

  it.each(['none', ' NONE '])('treats group %p as removal', (group) => {
    expect(
      parseMoveToGroupInputs({ project_id: 'ws-1', task_id: 'wt-1', group }),
    ).toEqual({
      ok: true,
      value: {
        task: { kind: 'project', projectId: 'ws-1', taskId: 'wt-1' },
        target: { kind: 'remove' },
      },
    });
  });

  it('requires exactly one owner id', () => {
    const message =
      'move-to-group requires exactly one of "project_id" or "bot_id"';
    expect(
      parseError({
        project_id: 'ws-1',
        bot_id: 'app_advisor',
        task_id: 't',
        group: 'A',
      }),
    ).toBe(message);
    expect(parseError({ task_id: 't', group: 'A' })).toBe(message);
  });

  it('requires a task id', () => {
    expect(parseError({ project_id: 'ws-1', group: 'A' })).toBe(
      'move-to-group requires "task_id"',
    );
  });

  it('requires exactly one group target', () => {
    const message =
      'move-to-group requires exactly one of "group" or "group_id"';
    expect(
      parseError({
        project_id: 'ws-1',
        task_id: 't',
        group: 'A',
        group_id: 'grp-a',
      }),
    ).toBe(message);
    expect(parseError({ project_id: 'ws-1', task_id: 't' })).toBe(message);
    expect(parseError({ project_id: 'ws-1', task_id: 't', group: '   ' })).toBe(
      message,
    );
  });

  it('rejects an unknown color', () => {
    expect(
      parseError({
        project_id: 'ws-1',
        task_id: 't',
        group: 'A',
        color: 'purple',
      }),
    ).toMatch(/^move-to-group "color" must be one of: /);
  });

  it('rejects color without a group name', () => {
    const message =
      'move-to-group "color" applies only when "group" names a group';
    expect(
      parseError({
        project_id: 'ws-1',
        task_id: 't',
        group_id: 'grp-a',
        color: 'categorical-2',
      }),
    ).toBe(message);
    expect(
      parseError({
        project_id: 'ws-1',
        task_id: 't',
        group: 'none',
        color: 'categorical-2',
      }),
    ).toBe(message);
  });

  it('rejects unsafe ids', () => {
    expect(
      parseError({ project_id: 'ws-1', task_id: '../x', group: 'A' }),
    ).toBe(
      'move-to-group "task_id" must be lowercase alphanumeric with hyphens',
    );
    expect(parseError({ project_id: 'WS-1', task_id: 't', group: 'A' })).toBe(
      'move-to-group "project_id" must be lowercase alphanumeric with hyphens',
    );
    expect(
      parseError({ bot_id: 'app/advisor', task_id: 't', group: 'A' }),
    ).toBe(
      'move-to-group "bot_id" must be lowercase alphanumeric with hyphens or underscores',
    );
  });

  it.each(['abc', 'grp-', 'grp-../x'])('rejects group id %p', (groupId) => {
    expect(
      parseError({ project_id: 'ws-1', task_id: 't', group_id: groupId }),
    ).toBe('move-to-group "group_id" must be an existing group id (grp-...)');
  });

  it('never echoes the group name in errors', () => {
    const group = 'Secret Group Name';
    const messages = [
      parseError({
        project_id: 'ws-1',
        task_id: 't',
        group,
        group_id: 'grp-a',
      }),
      parseError({ project_id: 'ws-1', task_id: 't', group, color: 'purple' }),
      parseError({
        project_id: 'ws-1',
        bot_id: 'app_advisor',
        task_id: 't',
        group,
      }),
    ];
    for (const message of messages) {
      expect(message).not.toContain(group);
    }
  });
});

describe('emptyMoveToGroupOutputs', () => {
  it('returns every move-to-group output with grouped false', () => {
    expect(emptyMoveToGroupOutputs()).toEqual({
      group_id: '',
      group_name: '',
      group_created: '',
      grouped: 'false',
      not_grouped_reason: '',
    });
  });
});

describe('buildPipelineHostIdempotencyKey', () => {
  it('composes execution, job, child, step, attempt and iteration', () => {
    expect(
      buildPipelineHostIdempotencyKey({
        executionId: 'exec-1',
        jobId: 'job-a',
        stepId: 'step-1',
        attempt: 1,
        iteration: 1,
      }),
    ).toBe('pipeline-host:exec-1:job-a::step-1:1:1');
    expect(
      buildPipelineHostIdempotencyKey({
        executionId: 'exec-1',
        jobId: 'job-a',
        childId: 'child-2',
        stepId: 'step-1',
        attempt: 2,
        iteration: 3,
      }),
    ).toBe('pipeline-host:exec-1:job-a:child-2:step-1:2:3');
  });
});

describe('PipelineHostRefusal', () => {
  it('is an Error carrying the failure reason', () => {
    const refusal = new PipelineHostRefusal('not_found', 'x');
    expect(refusal).toBeInstanceOf(Error);
    expect(refusal.failureReason).toBe('not_found');
    expect(refusal.message).toBe('x');
  });
});

describe('isPipelineHostActionId', () => {
  it('accepts only known host actions', () => {
    expect(isPipelineHostActionId('move-to-group')).toBe(true);
    expect(isPipelineHostActionId('create-worktree')).toBe(false);
  });
});
