import {
  resolveAutomationComposerContext,
  resolveHookComposerContext,
} from '../configurationComposerTargets';

describe('configuration composer discovery targets', () => {
  it('uses the selected source worktree, but always uses baseline for local hooks', () => {
    expect(
      resolveHookComposerContext({
        workspaceId: 'p',
        mode: 'source',
        worktreeId: 'w',
        repoId: 'r',
      }),
    ).toEqual({
      kind: 'workspace',
      workspaceId: 'p',
      target: { kind: 'worktree', worktreeId: 'w', repoId: 'r' },
    });
    expect(
      resolveHookComposerContext({
        workspaceId: 'p',
        mode: 'local',
        worktreeId: 'w',
        repoId: 'r',
      }),
    ).toEqual({
      kind: 'workspace',
      workspaceId: 'p',
      target: { kind: 'baseline', repoId: 'r' },
    });
    expect(
      resolveHookComposerContext({ workspaceId: 'p', mode: 'source' }),
    ).toEqual({
      kind: 'workspace',
      workspaceId: 'p',
      target: { kind: 'baseline' },
    });
  });
  it('does not substitute the first worktree for an automation default', () => {
    expect(
      resolveAutomationComposerContext({
        actionType: 'worktree_prompt',
        workspaceId: 'p',
      }),
    ).toEqual({
      kind: 'workspace',
      workspaceId: 'p',
      target: { kind: 'baseline' },
    });
    expect(
      resolveAutomationComposerContext({
        actionType: 'worktree_prompt',
        workspaceId: 'p',
        baseWorktreeId: 'base',
      }),
    ).toEqual({
      kind: 'workspace',
      workspaceId: 'p',
      target: { kind: 'worktree', worktreeId: 'base' },
    });
  });
  it('uses the advisor context for App Advisor chats in any Work Entry', () => {
    expect(
      resolveAutomationComposerContext({
        actionType: 'worktree_session_prompt',
        workspaceId: 'app-advisor',
        sessionTarget: {
          workspaceId: 'app-advisor',
          worktreeId: 'entry-1',
          chatId: '',
        },
      }),
    ).toEqual({ kind: 'advisor' });
  });
  it('uses the existing chat scope and selected repo before any parked base target', () => {
    expect(
      resolveAutomationComposerContext({
        actionType: 'worktree_session_prompt',
        workspaceId: 'p',
        baseWorktreeId: 'base',
        sessionTarget: {
          workspaceId: 'p',
          worktreeId: 'chat-work',
          chatId: 'chat',
        },
        selectedRepoId: 'r',
        sessionReady: true,
      }),
    ).toEqual({
      kind: 'workspace',
      workspaceId: 'p',
      target: { kind: 'worktree', worktreeId: 'chat-work', repoId: 'r' },
    });
    expect(
      resolveAutomationComposerContext({
        actionType: 'worktree_session_prompt',
        workspaceId: 'p',
      }).kind,
    ).toBe('unresolved');
  });
  it('uses live cowork scope and retains Advisor identity', () => {
    expect(
      resolveAutomationComposerContext({
        actionType: 'worktree_session_prompt',
        isCowork: true,
        sessionReady: true,
        sessionTarget: {
          workspaceId: 'cowork',
          worktreeId: 'entry',
          chatId: 'chat',
        },
      }),
    ).toEqual({
      kind: 'workspace',
      workspaceId: 'cowork',
      target: { kind: 'cowork' },
    });
    expect(
      resolveAutomationComposerContext({
        actionType: 'standalone_prompt',
        workspaceId: 'cowork',
        isCowork: true,
      }),
    ).toEqual({
      kind: 'workspace',
      workspaceId: 'cowork',
      target: { kind: 'cowork' },
    });
    expect(
      resolveAutomationComposerContext({ actionType: 'app_advisor_prompt' }),
    ).toEqual({ kind: 'advisor' });
  });
});
