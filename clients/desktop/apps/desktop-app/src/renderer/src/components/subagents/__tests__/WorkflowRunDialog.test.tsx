/** @jest-environment jsdom */
import { act, type JSX, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { WorkflowRunDialog } from '../WorkflowRunDialog';
import { useWorkflowRun } from '@/hooks/useWorkflowRun';
import { BACKGROUND_PROCESSES_UI_STATE_KEY } from '@/lib/current-ui-state/backgroundProcessesUiState';
import { useCurrentUiStateStore } from '@/stores/currentUiStateStore';

const SCOPE = { projectId: 'project-1', worktreeId: 'worktree-1' };

jest.mock('@/hooks/useWorkflowRun', () => ({
  useWorkflowRun: jest.fn((): { run: null; loading: boolean } => ({
    run: null,
    loading: true,
  })),
}));
jest.mock('@/components/activity/WorkflowRunView', () => ({
  WorkflowRunView: (): JSX.Element => <div data-testid="workflow-run-view" />,
}));
jest.mock('@/components/shared/DialogModal', () => ({
  DialogModal: ({
    children,
    title,
    dataTestId,
  }: {
    readonly children: ReactNode;
    readonly title: ReactNode;
    readonly dataTestId?: string;
  }): JSX.Element => (
    <div data-testid={dataTestId}>
      {title}
      {children}
    </div>
  ),
}));

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

describe('WorkflowRunDialog', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    jest.clearAllMocks();
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('renders the activity workflow view for the selected run', () => {
    act(() => {
      root.render(
        <WorkflowRunDialog
          scope={SCOPE}
          target={{
            runId: 'wf_1',
            transcriptDir: '/tmp/workflow',
            title: 'Report review',
          }}
          onClose={(): void => undefined}
        />,
      );
    });

    expect(
      container.querySelector('[data-testid="subagent-workflow-dialog"]'),
    ).not.toBeNull();
    expect(container.textContent).toContain('Report review');
    expect(
      container.querySelector('[data-testid="workflow-run-view"]'),
    ).not.toBeNull();
    expect(useWorkflowRun).toHaveBeenCalledWith('/tmp/workflow', 'wf_1', false);
  });

  it('reports the open run to App Advisor as the selected background task', () => {
    const slice = (): unknown =>
      useCurrentUiStateStore.getState().slices[
        BACKGROUND_PROCESSES_UI_STATE_KEY
      ];
    const render = (taskId: string | null): void =>
      act(() => {
        root.render(
          <WorkflowRunDialog
            scope={SCOPE}
            target={
              taskId
                ? {
                    runId: 'wf_1',
                    transcriptDir: '/tmp/workflow',
                    title: 'Report review',
                    taskId,
                  }
                : null
            }
            onClose={(): void => undefined}
          />,
        );
      });

    render('task-1');
    expect(slice()).toMatchObject({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      detailModalOpen: true,
      selectedTaskId: 'task-1',
    });

    render(null);
    expect(slice()).toMatchObject({ detailModalOpen: false });
  });

  it('renders nothing without a selected target', () => {
    act(() => {
      root.render(
        <WorkflowRunDialog
          scope={SCOPE}
          target={null}
          onClose={(): void => undefined}
        />,
      );
    });

    expect(container.textContent).toBe('');
    expect(
      container.querySelector('[data-testid="subagent-workflow-dialog"]'),
    ).toBeNull();
    expect(useWorkflowRun).toHaveBeenCalledWith(undefined, undefined, false);
  });
});
