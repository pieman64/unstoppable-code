/** @jest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { WORKTREE_UNIT_LABEL } from '@canopy/protocol';
import { REPLAY_MASK_CLASS } from '../../lib/replay-privacy';
import {
  AUTOMATION_PIPELINE_PROJECT_FOLDER_HELPER,
  AUTOMATION_PIPELINE_TASK_LOAD_ERROR,
  AUTOMATION_PIPELINE_TASK_LOADING,
  AUTOMATION_PIPELINE_TASK_STALE,
  AutomationPipelineTargetFields,
  automationPipelineRunInOptions,
  isAutomationPipelineTaskStale,
  type AutomationPipelineTargetFieldsProps,
} from '../AutomationPipelineTargetFields';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

let container: HTMLDivElement;
let root: Root;

beforeEach((): void => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach((): void => {
  act(() => root.unmount());
  container.remove();
});

function render(
  overrides: Partial<AutomationPipelineTargetFieldsProps> = {},
): void {
  act(() =>
    root.render(
      <AutomationPipelineTargetFields
        projectKind="code"
        value="new_worktree"
        onChange={jest.fn()}
        taskId=""
        tasks={{ status: 'ready', options: [] }}
        onTaskChange={jest.fn()}
        testIdPrefix="t"
        {...overrides}
      />,
    ),
  );
}

function byTestId(id: string): HTMLElement | null {
  return container.querySelector(`[data-testid="${id}"]`);
}

describe('automationPipelineRunInOptions', (): void => {
  it('offers a new worktree, an existing worktree, and the project folder on code projects', (): void => {
    expect(automationPipelineRunInOptions('code')).toEqual([
      { value: 'new_worktree', label: `New ${WORKTREE_UNIT_LABEL} each run` },
      { value: 'task', label: `Existing ${WORKTREE_UNIT_LABEL}` },
      { value: 'project', label: 'Project folder' },
    ]);
  });

  it('never offers a new worktree on cowork projects', (): void => {
    expect(
      automationPipelineRunInOptions('cowork').map((option) => option.value),
    ).toEqual(['project', 'task']);
  });
});

describe('isAutomationPipelineTaskStale', (): void => {
  it('is stale only when a loaded listing lacks the selected task', (): void => {
    const ready = { status: 'ready', options: [{ id: 'a', label: 'A' }] };
    expect(
      isAutomationPipelineTaskStale('b', { ...ready, status: 'ready' }),
    ).toBe(true);
    expect(
      isAutomationPipelineTaskStale('a', { ...ready, status: 'ready' }),
    ).toBe(false);
    expect(
      isAutomationPipelineTaskStale('', { ...ready, status: 'ready' }),
    ).toBe(false);
    expect(isAutomationPipelineTaskStale('b', { status: 'loading' })).toBe(
      false,
    );
    expect(isAutomationPipelineTaskStale('b', { status: 'error' })).toBe(false);
  });
});

describe('AutomationPipelineTargetFields', (): void => {
  it('reports the chosen Run in option', (): void => {
    const onChange = jest.fn();
    render({ onChange });
    const radio = byTestId('t-pipeline-run-in-project');
    expect(radio).toBeInstanceOf(HTMLInputElement);
    act(() => radio?.click());
    expect(onChange).toHaveBeenCalledWith('project');
  });

  it('explains that a project-folder run creates no task', (): void => {
    render({ value: 'project' });
    expect(byTestId('t-pipeline-project-helper')?.textContent).toBe(
      AUTOMATION_PIPELINE_PROJECT_FOLDER_HELPER,
    );
    expect(byTestId('t-task')).toBeNull();
  });

  it('shows the task picker only for task runs', (): void => {
    render({ value: 'new_worktree' });
    expect(byTestId('t-task')).toBeNull();
    render({
      value: 'task',
      tasks: { status: 'ready', options: [{ id: 'w1', label: 'feature' }] },
    });
    expect(byTestId('t-task')?.textContent).toContain('Select a task');
  });

  it('never auto-selects the first task and reports a picked one', (): void => {
    const onTaskChange = jest.fn();
    render({
      value: 'task',
      onTaskChange,
      tasks: {
        status: 'ready',
        options: [
          { id: 'w1', label: 'first' },
          { id: 'w2', label: 'second' },
        ],
      },
    });
    expect(onTaskChange).not.toHaveBeenCalled();
    act(() => byTestId('t-task')?.click());
    const option = Array.from(
      document.querySelectorAll<HTMLElement>('[role="option"]'),
    ).find((candidate) => candidate.textContent?.includes('second'));
    act(() => option?.click());
    expect(onTaskChange).toHaveBeenCalledWith('w2');
  });

  it('renders loading, error with Retry, and unavailable states', (): void => {
    render({ value: 'task', tasks: { status: 'loading' } });
    expect(byTestId('t-task-loading')?.textContent).toBe(
      AUTOMATION_PIPELINE_TASK_LOADING,
    );

    const onRetryTasks = jest.fn();
    render({ value: 'task', tasks: { status: 'error' }, onRetryTasks });
    expect(byTestId('t-task-error')?.textContent).toContain(
      AUTOMATION_PIPELINE_TASK_LOAD_ERROR,
    );
    act(() => byTestId('t-task-retry')?.click());
    expect(onRetryTasks).toHaveBeenCalledTimes(1);

    render({
      value: 'task',
      tasks: { status: 'unavailable', message: 'Not here.' },
    });
    expect(byTestId('t-task-unavailable')?.textContent).toBe('Not here.');
    expect(byTestId('t-task')).toBeNull();
  });

  it('masks user-authored task titles for session replay', (): void => {
    render({
      value: 'task',
      taskId: 'w1',
      tasks: {
        status: 'ready',
        options: [
          { id: 'w1', label: 'first' },
          { id: 'w2', label: 'second' },
        ],
      },
    });
    const trigger = byTestId('t-task');
    const chosen = Array.from(trigger?.querySelectorAll('span') ?? []).find(
      (span) => span.textContent === 'first',
    );
    expect(chosen?.classList.contains(REPLAY_MASK_CLASS)).toBe(true);
    act(() => trigger?.click());
    const labels = Array.from(
      document.querySelectorAll<HTMLElement>('[role="option"] span'),
    ).filter((span) => span.textContent === 'second');
    expect(labels).not.toHaveLength(0);
    expect(
      labels.some((span) => span.classList.contains(REPLAY_MASK_CLASS)),
    ).toBe(true);
  });

  it('keeps the task placeholder and unavailable label unmasked', (): void => {
    render({
      value: 'task',
      taskId: 'gone',
      tasks: { status: 'ready', options: [{ id: 'w1', label: 'first' }] },
    });
    expect(
      byTestId('t-task')?.querySelector(`.${REPLAY_MASK_CLASS}`),
    ).toBeNull();
  });

  it('keeps a stale task visible with a correction message', (): void => {
    render({
      value: 'task',
      taskId: 'gone',
      tasks: { status: 'ready', options: [{ id: 'w1', label: 'first' }] },
    });
    expect(byTestId('t-task')?.textContent).toContain('Unavailable task');
    expect(byTestId('t-task-stale')?.textContent).toBe(
      AUTOMATION_PIPELINE_TASK_STALE,
    );
  });
});
