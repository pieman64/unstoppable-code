/** @jest-environment jsdom */
import { useChatStore } from '@/stores/chatStore';
import { useNavigationStore } from '@/stores/navigationStore';
import { usePipelineRunsStore } from '@/stores/pipelineRunsStore';
import { buildCurrentUiStateSnapshot } from '../buildCurrentUiStateSnapshot';
import {
  PIPELINE_DETAIL_MODAL_UI_STATE_KEY,
  pipelineDetailPanelUiStateKey,
} from '../pipelineDetailUiState';

function panelSlice(
  executionId: string,
  panelId: string,
  options: {
    ownerKey?: string;
    active?: boolean;
    auxiliaryWindow?: boolean;
    status?: string;
    selectedJobId?: string;
  } = {},
): Record<string, string | boolean | never[]> {
  return {
    executionId,
    pipelineId: `pipeline-${executionId}`,
    status: options.status ?? 'running',
    selectedJobId: options.selectedJobId ?? '',
    inputRequired: false,
    resumable: false,
    resumableStatusReasons: [],
    host: 'panel',
    ownerKey: options.ownerKey ?? 'project-1/worktree-1',
    panelId,
    active: options.active ?? false,
    auxiliaryWindow: options.auxiliaryWindow ?? false,
  };
}

function key(ownerKey: string, panelId: string): string {
  return pipelineDetailPanelUiStateKey(`${ownerKey}::${panelId}`);
}

beforeEach(() => {
  useNavigationStore.setState({ activePage: 'main' });
  useChatStore.setState({ selectedWorktree: null });
  usePipelineRunsStore.setState({
    summaries: [],
    statesById: {},
    currentProjectId: null,
    currentWorktreeId: null,
  });
});

describe('buildCurrentUiStateSnapshot pipeline run details', () => {
  it('lists every shown run panel and marks the active main-window one focused', () => {
    const snapshot = buildCurrentUiStateSnapshot({
      [key('project-1/worktree-1', 'panel-pipeline-run-a')]: panelSlice(
        'run-a',
        'panel-pipeline-run-a',
        { selectedJobId: 'build' },
      ),
      [key('project-1/worktree-1', 'panel-pipeline-run-b')]: panelSlice(
        'run-b',
        'panel-pipeline-run-b',
        { active: true, status: 'paused' },
      ),
      [key('project-1/worktree-1', 'panel-pipeline-run-c')]: panelSlice(
        'run-c',
        'panel-pipeline-run-c',
        { active: true, auxiliaryWindow: true },
      ),
    });

    expect(snapshot.pipelineRunDetails).toEqual([
      {
        host: 'panel',
        executionId: 'run-a',
        pipelineId: 'pipeline-run-a',
        status: 'running',
        selectedJobId: 'build',
        ownerKey: 'project-1/worktree-1',
        panelId: 'panel-pipeline-run-a',
        focused: false,
      },
      {
        host: 'panel',
        executionId: 'run-b',
        pipelineId: 'pipeline-run-b',
        status: 'paused',
        ownerKey: 'project-1/worktree-1',
        panelId: 'panel-pipeline-run-b',
        focused: true,
      },
      {
        host: 'panel',
        executionId: 'run-c',
        pipelineId: 'pipeline-run-c',
        status: 'running',
        ownerKey: 'project-1/worktree-1',
        panelId: 'panel-pipeline-run-c',
        auxiliaryWindow: true,
        focused: false,
      },
    ]);
    expect(snapshot.activePipelineRun).toMatchObject({
      executionId: 'run-b',
      status: 'paused',
    });
  });

  it('focuses the active popped-out panel when no main-window panel is active', () => {
    const snapshot = buildCurrentUiStateSnapshot({
      [key('project-1/worktree-1', 'panel-a')]: panelSlice('run-a', 'panel-a'),
      [key('project-2/worktree-9', 'panel-b')]: panelSlice('run-b', 'panel-b', {
        ownerKey: 'project-2/worktree-9',
        active: true,
        auxiliaryWindow: true,
      }),
    });

    expect(
      snapshot.pipelineRunDetails?.map((entry) => [
        entry.executionId,
        entry.focused,
      ]),
    ).toEqual([
      ['run-a', false],
      ['run-b', true],
    ]);
    expect(snapshot.activePipelineRun?.executionId).toBe('run-b');
  });

  it('puts the covering compatibility view first and focuses it', () => {
    const snapshot = buildCurrentUiStateSnapshot({
      [PIPELINE_DETAIL_MODAL_UI_STATE_KEY]: {
        executionId: 'run-ownerless',
        pipelineId: 'pipeline-x',
        status: 'failure',
        selectedJobId: '',
        resumableStatusReasons: [],
      },
      [key('project-1/worktree-1', 'panel-a')]: panelSlice('run-a', 'panel-a', {
        active: true,
      }),
    });

    expect(snapshot.pipelineRunDetails).toEqual([
      {
        host: 'compatibility',
        executionId: 'run-ownerless',
        pipelineId: 'pipeline-x',
        status: 'failure',
        focused: true,
      },
      expect.objectContaining({ executionId: 'run-a', focused: false }),
    ]);
    expect(snapshot.activePipelineRun?.executionId).toBe('run-ownerless');
  });

  it('reports no run details when no panel is shown (hidden panels report nothing)', () => {
    const snapshot = buildCurrentUiStateSnapshot({
      'pipelineRuns.debugProgress': {
        executionId: 'run-debugging',
        status: 'debugging',
      },
    });

    expect(snapshot.pipelineRunDetails).toBeUndefined();
    // Without a focused detail the debug slice still drives the active run.
    expect(snapshot.activePipelineRun).toEqual({
      executionId: 'run-debugging',
      status: 'debugging',
    });
  });

  it('shown but unfocused panels do not replace the active-run fallback', () => {
    const snapshot = buildCurrentUiStateSnapshot({
      [key('project-1/worktree-1', 'panel-a')]: panelSlice('run-a', 'panel-a'),
      'pipelineRuns.debugProgress': {
        executionId: 'run-debugging',
        status: 'debugging',
      },
    });

    expect(snapshot.pipelineRunDetails).toHaveLength(1);
    expect(snapshot.activePipelineRun?.executionId).toBe('run-debugging');
  });
});
