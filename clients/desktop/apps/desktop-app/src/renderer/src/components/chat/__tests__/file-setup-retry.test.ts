import {
  WORKSPACE_ROOT_REPO_ID,
  type SidebarItem,
} from '@canopy/desktop-shared/types';
import type { ScriptRunState } from '@/stores/scriptsStore';
import {
  resolveFileSetupRetryPlan,
  resolveFileSetupRetryState,
} from '../file-setup-retry';

function run(status: ScriptRunState['status']): ScriptRunState {
  return {
    label: 'Setup',
    scriptName: 'setup',
    lifecycle: 'setup',
    command: 'npm install',
    target: 'project',
    status,
    outputLines: [],
    exitCode: null,
    timedOut: false,
    durationMs: 0,
    startedAt: 1,
    devServerHits: [],
  };
}

describe('file setup retry planning', () => {
  it('waits for a single-repo effective setup script', () => {
    const project = {
      id: 'project',
      name: 'Project',
      type: 'single-repo',
      repoPath: '/repo',
      color: 'blue',
      worktrees: [],
      collapsed: false,
      order: 0,
      worktreeEffective: {
        task: { effectiveScripts: { setup: 'npm install' } },
      },
    } satisfies SidebarItem;

    expect(resolveFileSetupRetryPlan(project, 'task', 'repo')).toEqual({
      completionScriptKey: 'project:setup',
    });
  });

  it('uses the final project stage and short-circuits if before-setup fails', () => {
    const project = {
      id: 'workspace',
      name: 'Workspace',
      type: 'multi-repo',
      color: 'blue',
      repos: [
        {
          id: 'repo-a',
          name: 'Repo A',
          repoPath: '/repo-a',
          effectiveScripts: { setup: 'npm install' },
        },
      ],
      worktrees: [],
      collapsed: false,
      order: 0,
      effectiveScripts: {
        'before-setup': 'prepare',
        'after-setup': 'generate files',
      },
    } satisfies SidebarItem;
    const plan = resolveFileSetupRetryPlan(project, 'task', 'repo-a');

    expect(plan).toEqual({
      completionScriptKey: 'workspace-root:after-setup',
      prerequisiteScriptKey: 'workspace-root:before-setup',
    });
    expect(resolveFileSetupRetryState(plan, undefined)).toBe('waiting');
    expect(resolveFileSetupRetryPlan(project, 'task', undefined)).toBeNull();
    expect(
      resolveFileSetupRetryPlan(project, 'task', WORKSPACE_ROOT_REPO_ID),
    ).toEqual({
      completionScriptKey: 'workspace-root:after-setup',
      prerequisiteScriptKey: 'workspace-root:before-setup',
    });
    expect(
      resolveFileSetupRetryState(plan, {
        'workspace-root:before-setup': run('failed'),
      }),
    ).toBe('finished');
    expect(
      resolveFileSetupRetryState(plan, {
        'workspace-root:before-setup': run('success'),
        'workspace-root:after-setup': run('success'),
      }),
    ).toBe('finished');
  });

  it('targets the matching repo setup when there is no later root stage', () => {
    const project = {
      id: 'workspace',
      name: 'Workspace',
      type: 'multi-repo',
      color: 'blue',
      repos: [
        {
          id: 'repo-a',
          name: 'Repo A',
          repoPath: '/repo-a',
          effectiveScripts: { setup: 'npm install' },
        },
      ],
      worktrees: [],
      collapsed: false,
      order: 0,
    } satisfies SidebarItem;

    expect(resolveFileSetupRetryPlan(project, 'task', 'repo-a')).toEqual({
      completionScriptKey: 'workspace-repo:repo-a:setup',
    });
    expect(resolveFileSetupRetryPlan(project, 'task', 'repo-b')).toBeNull();
  });
});
