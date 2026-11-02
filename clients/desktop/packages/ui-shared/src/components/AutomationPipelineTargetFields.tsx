import { useId, type JSX } from 'react';
import { WORKTREE_UNIT_LABEL } from '@canopy/protocol';
import { Button } from './Button';
import { Radio } from './Choice';
import { Select, type SelectOption } from './Field';

/**
 * Where a pipeline automation on a project runs. A pipeline with no project
 * has no "Run in" choice, so `global` is not one of these.
 */
export type AutomationPipelineRunIn = 'new_worktree' | 'task' | 'project';

/** `code` covers single- and multi-repo projects. */
export type AutomationPipelineProjectKind = 'code' | 'cowork';

export interface AutomationPipelineTaskOption {
  readonly id: string;
  readonly label: string;
}

/** The host's task listing for the selected project. */
export type AutomationPipelineTaskList =
  | { readonly status: 'loading' }
  | { readonly status: 'error' }
  /** The host cannot list tasks here; `message` says why. */
  | { readonly status: 'unavailable'; readonly message: string }
  | {
      readonly status: 'ready';
      readonly options: readonly AutomationPipelineTaskOption[];
    };

export const AUTOMATION_PIPELINE_PROJECT_FOLDER_HELPER =
  'Runs in the project folder without creating a task.';
export const AUTOMATION_PIPELINE_TASK_LOADING = 'Loading tasks…';
export const AUTOMATION_PIPELINE_TASK_LOAD_ERROR =
  'Could not load tasks. Try again.';
export const AUTOMATION_PIPELINE_TASK_STALE =
  'This task is no longer available. Choose another task.';

const UNAVAILABLE_TASK_LABEL = 'Unavailable task';

/** The "Run in" choices a project kind offers, in display order. */
export function automationPipelineRunInOptions(
  projectKind: AutomationPipelineProjectKind,
): ReadonlyArray<{ value: AutomationPipelineRunIn; label: string }> {
  return projectKind === 'cowork'
    ? [
        { value: 'project', label: 'Project folder' },
        { value: 'task', label: 'Existing task' },
      ]
    : [
        { value: 'new_worktree', label: `New ${WORKTREE_UNIT_LABEL} each run` },
        { value: 'task', label: `Existing ${WORKTREE_UNIT_LABEL}` },
        { value: 'project', label: 'Project folder' },
      ];
}

/**
 * Whether a selected task is missing from a loaded listing. A stale task
 * stays selected so the user sees what to correct; nothing picks another.
 */
export function isAutomationPipelineTaskStale(
  taskId: string,
  tasks: AutomationPipelineTaskList,
): boolean {
  return (
    taskId !== '' &&
    tasks.status === 'ready' &&
    !tasks.options.some((option) => option.id === taskId)
  );
}

export interface AutomationPipelineTaskFieldProps {
  readonly projectKind: AutomationPipelineProjectKind;
  /** '' while no task is chosen. */
  readonly taskId: string;
  readonly tasks: AutomationPipelineTaskList;
  readonly onTaskChange: (taskId: string) => void;
  /** Reloads the task listing after an error. */
  readonly onRetryTasks?: () => void;
  readonly disabled?: boolean;
  /** Prefix for test ids, such as `automations-form`. */
  readonly testIdPrefix: string;
}

/**
 * The existing task a pipeline automation runs in, with loading, error,
 * unavailable, and stale-selection states. Mounted alone where the
 * destination kind is fixed, such as installing a shared automation.
 */
export function AutomationPipelineTaskField({
  projectKind,
  taskId,
  tasks,
  onTaskChange,
  onRetryTasks,
  disabled = false,
  testIdPrefix,
}: AutomationPipelineTaskFieldProps): JSX.Element {
  const taskLabelId = useId();
  const stale = isAutomationPipelineTaskStale(taskId, tasks);
  const taskOptions: SelectOption[] =
    tasks.status === 'ready'
      ? [
          ...tasks.options.map((option) => ({
            value: option.id,
            label: option.label,
            maskInReplay: true,
          })),
          ...(stale
            ? [{ value: taskId, label: UNAVAILABLE_TASK_LABEL, disabled: true }]
            : []),
        ]
      : [];
  return (
    <div className="flex flex-col gap-1 text-xs fg-secondary">
      <span id={taskLabelId}>
        {projectKind === 'cowork' ? 'Task' : WORKTREE_UNIT_LABEL}
      </span>
      {tasks.status === 'loading' && (
        <p
          className="text-xs fg-secondary"
          data-testid={`${testIdPrefix}-task-loading`}
        >
          {AUTOMATION_PIPELINE_TASK_LOADING}
        </p>
      )}
      {tasks.status === 'error' && (
        <div
          role="alert"
          className="flex flex-wrap items-center gap-2 text-xs fg-secondary"
          data-testid={`${testIdPrefix}-task-error`}
        >
          <span>{AUTOMATION_PIPELINE_TASK_LOAD_ERROR}</span>
          {onRetryTasks && (
            <Button
              variant="secondary"
              disabled={disabled}
              onClick={onRetryTasks}
              data-testid={`${testIdPrefix}-task-retry`}
            >
              Retry
            </Button>
          )}
        </div>
      )}
      {tasks.status === 'unavailable' && (
        <p
          className="text-xs fg-secondary"
          data-testid={`${testIdPrefix}-task-unavailable`}
        >
          {tasks.message}
        </p>
      )}
      {tasks.status === 'ready' && (
        <Select
          options={taskOptions}
          value={taskId === '' ? null : taskId}
          onValueChange={onTaskChange}
          placeholder={
            tasks.options.length === 0 ? 'No tasks available' : 'Select a task'
          }
          disabled={disabled || tasks.options.length === 0}
          aria-labelledby={taskLabelId}
          data-testid={`${testIdPrefix}-task`}
        />
      )}
      {stale && (
        <p
          role="alert"
          className="text-xs fg-destructive"
          data-testid={`${testIdPrefix}-task-stale`}
        >
          {AUTOMATION_PIPELINE_TASK_STALE}
        </p>
      )}
    </div>
  );
}

export interface AutomationPipelineTargetFieldsProps extends AutomationPipelineTaskFieldProps {
  readonly value: AutomationPipelineRunIn;
  readonly onChange: (next: AutomationPipelineRunIn) => void;
}

/**
 * "Run in" choice and task picker for a pipeline automation on a project.
 * Pure display: hosts supply the project kind, the task listing and its
 * state, and the callbacks. Validation and authorization stay with the host.
 */
export function AutomationPipelineTargetFields({
  value,
  onChange,
  ...taskField
}: AutomationPipelineTargetFieldsProps): JSX.Element {
  const { projectKind, disabled = false, testIdPrefix } = taskField;
  const runInLabelId = useId();
  const options = automationPipelineRunInOptions(projectKind);
  return (
    <div
      className="flex flex-col gap-3"
      data-testid={`${testIdPrefix}-pipeline-target`}
    >
      <div
        role="radiogroup"
        aria-labelledby={runInLabelId}
        className="flex flex-col gap-1.5 text-xs fg-secondary"
        data-testid={`${testIdPrefix}-pipeline-run-in`}
      >
        <span id={runInLabelId}>Run in</span>
        {options.map((option) => (
          <label
            key={option.value}
            className="flex cursor-pointer items-center gap-2 text-s fg-primary"
          >
            <Radio
              name={`${runInLabelId}-run-in`}
              value={option.value}
              checked={value === option.value}
              disabled={disabled}
              onChange={(): void => onChange(option.value)}
              data-testid={`${testIdPrefix}-pipeline-run-in-${option.value}`}
            />
            <span>{option.label}</span>
          </label>
        ))}
        {value === 'project' && (
          <p
            className="text-xs fg-secondary"
            data-testid={`${testIdPrefix}-pipeline-project-helper`}
          >
            {AUTOMATION_PIPELINE_PROJECT_FOLDER_HELPER}
          </p>
        )}
      </div>
      {value === 'task' && <AutomationPipelineTaskField {...taskField} />}
    </div>
  );
}
