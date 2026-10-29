import type { ScriptDescriptor } from '@canopy/desktop-shared/types';
import type { ScriptEntry } from '@/components/activity/script-utils';
import type { ScriptRunState } from '@/stores/scriptsStore';
import {
  indexActiveScriptRuns,
  isWorktreeLaunchActive,
  isWorktreeLaunchActiveInIndex,
  worktreesWithActiveRun,
} from '../worktree-launch';
import { shallow } from 'zustand/shallow';

function descriptor(
  scriptKey: string,
  lifecycle: ScriptDescriptor['lifecycle'],
): ScriptDescriptor {
  return {
    scriptKey,
    scriptName: scriptKey,
    label: scriptKey,
    command: `run ${scriptKey}`,
    lifecycle,
    target: 'project',
  };
}

function run(
  lifecycle: ScriptRunState['lifecycle'],
  status: ScriptRunState['status'],
): ScriptRunState {
  return {
    label: 'Script',
    scriptName: 'script',
    lifecycle,
    command: 'run script',
    target: 'project',
    status,
    outputLines: ['a line of output'],
    exitCode: null,
    timedOut: false,
    durationMs: 0,
    startedAt: 0,
    devServerHits: [],
  };
}

const projectLaunch: ScriptEntry = {
  script: descriptor('launch', 'launch'),
  request: {
    projectId: 'code-1',
    worktreeId: 'wt-1',
    scriptName: 'launch',
  },
};
const workspaceLaunch: ScriptEntry = {
  script: descriptor('workspace-launch', 'launch'),
  onRun: () => Promise.resolve(),
};

// Both sidebar rails decide Launch from the same rule; the shared rail reads
// it from an output-free index so printing does not re-render the rail.
describe('worktree launch state', () => {
  const runs: Record<string, Record<string, ScriptRunState>> = {
    'code-1/wt-1': {
      launch: run('launch', 'running'),
      setup: run('setup', 'success'),
    },
    'code-1/wt-2': { 'repo-launch': run('launch', 'stopping') },
    'code-2/wt-1': { launch: run('launch', 'failed') },
  };

  it('indexes only active runs, without their output', () => {
    expect(indexActiveScriptRuns(runs)).toEqual({
      'code-1/wt-1\u0000launch': 'launch',
      'code-1/wt-2\u0000repo-launch': 'launch',
    });
  });

  it.each([
    ['a running project launch', projectLaunch, 'code-1/wt-1', true],
    ['a finished project launch', projectLaunch, 'code-2/wt-1', false],
    [
      'a workspace launch with any launch run',
      workspaceLaunch,
      'code-1/wt-2',
      true,
    ],
    ['a worktree with no runs', workspaceLaunch, 'code-9/wt-9', false],
  ] as const)(
    'agrees with the legacy rule for %s',
    (_name, entry, worktreeKey, active) => {
      expect(isWorktreeLaunchActive(entry, runs[worktreeKey])).toBe(active);
      expect(
        isWorktreeLaunchActiveInIndex(
          entry,
          indexActiveScriptRuns(runs),
          worktreeKey,
        ),
      ).toBe(active);
    },
  );

  it('reports no launch without a launch script', () => {
    expect(isWorktreeLaunchActive(undefined, runs['code-1/wt-1'])).toBe(false);
    expect(
      isWorktreeLaunchActiveInIndex(
        undefined,
        indexActiveScriptRuns(runs),
        'code-1/wt-1',
      ),
    ).toBe(false);
  });

  // The sidebar model subscribes to this index with `useShallow`: output
  // arriving on a running script must leave it shallow-equal, so the rail does
  // not re-render as a script prints.
  it('is shallow-equal after a running script prints', () => {
    const printed: Record<string, Record<string, ScriptRunState>> = {
      ...runs,
      'code-1/wt-1': {
        ...runs['code-1/wt-1'],
        launch: {
          ...run('launch', 'running'),
          outputLines: ['a line of output', 'another line'],
        },
      },
    };
    expect(
      shallow(indexActiveScriptRuns(runs), indexActiveScriptRuns(printed)),
    ).toBe(true);
  });

  it('lists the worktrees with an active run of a lifecycle', () => {
    const index = indexActiveScriptRuns({
      ...runs,
      'code-3/wt-1': { setup: run('setup', 'running') },
    });
    expect([...worktreesWithActiveRun(index, 'launch')].sort()).toEqual([
      'code-1/wt-1',
      'code-1/wt-2',
    ]);
    expect([...worktreesWithActiveRun(index, 'setup')]).toEqual([
      'code-3/wt-1',
    ]);
  });
});
