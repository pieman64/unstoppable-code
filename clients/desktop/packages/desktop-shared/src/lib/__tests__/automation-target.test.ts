import { resolveLocalAutomationTargetRequirement } from '../automation-target';
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
