import type {
  PortalPipelineSummary,
  PortalScriptSummary,
} from '@canopy/protocol/portal';
import { pipelineToPortalEntity } from '../pipelines-service';
import { scriptToPortalEntity } from '../scripts-service';
import { hookToPortalEntity } from '../hooks-service';
import { planToPortalEntity } from '../plans-service';
import { terminalSessionToPortalEntity } from '../terminal-service';

describe('portal descriptor identity', () => {
  it('namespaces duplicate executable ids by worktree without changing the payload ids', () => {
    const script = {
      workspaceLocalId: 'workspace-1',
      scriptId: 'launch',
      scriptKey: 'launch',
      scriptName: 'launch',
      name: 'Launch',
      target: 'project',
    } satisfies Omit<PortalScriptSummary, 'worktreeLocalId'>;
    const pipeline = {
      workspaceLocalId: 'workspace-1',
      pipelineId: 'build',
      name: 'Build',
    } satisfies Omit<PortalPipelineSummary, 'worktreeLocalId'>;

    const scriptEntities = ['worktree-1', 'worktree-2'].map((worktreeLocalId) =>
      scriptToPortalEntity({ ...script, worktreeLocalId }),
    );
    const pipelineEntities = ['worktree-1', 'worktree-2'].map(
      (worktreeLocalId) =>
        pipelineToPortalEntity({ ...pipeline, worktreeLocalId }),
    );

    expect(scriptEntities.map((entity) => entity.localId)).toEqual([
      'worktree-1:launch',
      'worktree-2:launch',
    ]);
    expect(pipelineEntities.map((entity) => entity.localId)).toEqual([
      'worktree-1:build',
      'worktree-2:build',
    ]);
    expect(scriptEntities.map((entity) => entity.parentLocalId)).toEqual([
      'workspace-1:worktree-1',
      'workspace-1:worktree-2',
    ]);
    expect(pipelineEntities.map((entity) => entity.parentLocalId)).toEqual([
      'workspace-1:worktree-1',
      'workspace-1:worktree-2',
    ]);
    expect(scriptEntities.map((entity) => entity.payload)).toEqual([
      expect.objectContaining({ scriptId: 'launch', scriptKey: 'launch' }),
      expect.objectContaining({ scriptId: 'launch', scriptKey: 'launch' }),
    ]);
    expect(pipelineEntities.map((entity) => entity.payload)).toEqual([
      expect.objectContaining({ pipelineId: 'build' }),
      expect.objectContaining({ pipelineId: 'build' }),
    ]);
  });

  it('uses workspace-scoped parents for other worktree children', () => {
    const hookInput: Parameters<typeof hookToPortalEntity>[0] = {
      workspaceLocalId: 'workspace-1',
      worktreeLocalId: 'worktree-1',
      hookId: 'pre-commit',
      hookKey: 'pre-commit',
      name: 'Pre-commit',
      triggerName: 'pre-commit',
      target: 'project',
    };
    const planInput: Parameters<typeof planToPortalEntity>[0] = {
      workspaceLocalId: 'workspace-1',
      worktreeLocalId: 'worktree-1',
      planId: 'plan-1',
      title: 'Plan 1',
      status: 'active',
    };
    const terminalInput: Parameters<typeof terminalSessionToPortalEntity>[0] = {
      id: 'terminal-1',
      projectId: 'workspace-1',
      worktreeId: 'worktree-1',
      cwd: '/tmp/worktree-1',
      shell: '/bin/zsh',
      shellBasename: 'zsh',
      createdAt: 0,
    };
    const hook = hookToPortalEntity(hookInput);
    const plan = planToPortalEntity(planInput);
    const terminal = terminalSessionToPortalEntity(terminalInput);

    expect(
      [hook, plan, terminal].map((entity) => entity.parentLocalId),
    ).toEqual([
      'workspace-1:worktree-1',
      'workspace-1:worktree-1',
      'workspace-1:worktree-1',
    ]);
  });
});
