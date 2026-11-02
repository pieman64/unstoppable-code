import {
  automationTargetBindingChanged,
  resolveLocalAutomationTargetRequirement,
} from '../automation-target';
import type { AutomationAction } from '../../types';

describe('local automation target adapter', () => {
  it.each([
    ['cowork', 'cowork'],
    ['single-repo', 'worktree'],
    ['multi-repo', 'worktree'],
    ['app_advisor', 'app_advisor'],
  ])('resolves session prompts in %s', (kind, context) => {
    const action: AutomationAction = {
      type: 'worktree_session_prompt',
      workspaceId: 'project',
      worktreeId: 'entry',
      chatId: 'chat',
      prompt: 'Run',
    };
    expect(resolveLocalAutomationTargetRequirement(action, kind)).toEqual({
      status: 'resolved',
      contexts: [context],
    });
    expect(
      resolveLocalAutomationTargetRequirement(action, kind, {
        contexts: ['cowork'],
      }).status,
    ).toBe(context === 'cowork' ? 'resolved' : 'error');
  });
  it('rejects unknown session project kinds', () => {
    expect(
      resolveLocalAutomationTargetRequirement(
        {
          type: 'worktree_session_prompt',
          workspaceId: 'missing',
          worktreeId: 'entry',
          chatId: 'chat',
          prompt: 'Run',
        },
        undefined,
      ),
    ).toMatchObject({ status: 'error' });
  });
});

describe('pipeline destination bindings', () => {
  const legacy: AutomationAction = {
    type: 'worktree_pipeline',
    workspaceId: 'ws-1',
    pipelineId: 'p-1',
  };

  it('treats a retarget as a binding change', () => {
    for (const target of [
      { kind: 'new_worktree' as const },
      { kind: 'project' as const },
      { kind: 'task' as const, taskId: 'wt-1' },
      { kind: 'global' as const },
    ])
      expect(
        automationTargetBindingChanged(legacy, { ...legacy, target }),
      ).toBe(true);
    expect(
      automationTargetBindingChanged(
        { ...legacy, target: { kind: 'task', taskId: 'wt-1' } },
        { ...legacy, target: { kind: 'task', taskId: 'wt-2' } },
      ),
    ).toBe(true);
  });

  it('ignores the inert workspaceId of a global destination', () => {
    expect(
      automationTargetBindingChanged(
        { ...legacy, target: { kind: 'global' } },
        { ...legacy, workspaceId: 'ws-2', target: { kind: 'global' } },
      ),
    ).toBe(false);
    const withoutWorkspace: AutomationAction = {
      type: 'worktree_pipeline',
      pipelineId: 'p-1',
      target: { kind: 'global' },
    };
    expect(
      automationTargetBindingChanged(withoutWorkspace, {
        ...legacy,
        target: { kind: 'global' },
      }),
    ).toBe(false);
  });

  it('checks a project folder run against directory scopes on a code project', () => {
    const action: AutomationAction = { ...legacy, target: { kind: 'project' } };
    expect(
      resolveLocalAutomationTargetRequirement(
        action,
        'single-repo',
        undefined,
        {
          status: 'resolved',
          scopes: 'worktree',
        },
      ),
    ).toMatchObject({ status: 'error' });
    expect(
      resolveLocalAutomationTargetRequirement(
        action,
        'single-repo',
        undefined,
        {
          status: 'resolved',
          scopes: 'directory',
        },
      ),
    ).toEqual({ status: 'resolved', contexts: ['cowork', 'worktree'] });
  });

  it('resolves a global pipeline with no contexts', () => {
    expect(
      resolveLocalAutomationTargetRequirement(
        { ...legacy, target: { kind: 'global' } },
        undefined,
        undefined,
        { status: 'resolved', scopes: 'global' },
      ),
    ).toEqual({ status: 'resolved', contexts: [] });
  });
});
