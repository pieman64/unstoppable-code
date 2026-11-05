import type { ReactNode } from 'react';
import type { Pipeline } from '@canopy/desktop-shared/types/pipeline';
import type { PipelineEditorSelection } from '@/lib/pipelineEditor';
import {
  BugReportIcon,
  GitPullRequestIcon,
  InfoIcon,
  PencilIcon,
  PlusIcon,
  QuestionMarkIcon,
  ScheduleIcon,
  TasksIcon,
  WarningIcon,
} from '@canopy/ui-shared/icons/AppIcons';

export interface PipelineAssistantSuggestion {
  readonly id: string;
  readonly label: string;
  /**
   * Put in the composer, never sent. A prompt that ends mid-sentence is for
   * the person to finish.
   */
  readonly prompt: string;
  readonly icon: ReactNode;
}

/** What the flow has selected, for a suggestion about it. */
export interface PipelineAssistantSelection {
  readonly kind: 'job' | 'step';
  /** The step or job as the flow names it. */
  readonly label: string;
  /** The job a step is in; the job itself for a job. */
  readonly jobLabel: string;
}

/**
 * The flow's selection, named as the flow names it: a job by its name or
 * id, a step by its name, its id, or its place in the job.
 */
export function pipelineAssistantSelection(
  pipeline: Pipeline | null,
  selection: PipelineEditorSelection,
): PipelineAssistantSelection | null {
  if (pipeline === null || selection.type === 'none') return null;
  const job = pipeline.jobs[selection.jobId];
  if (job === undefined) return null;
  const jobLabel = job.name || selection.jobId;
  if (selection.type === 'job') {
    return { kind: 'job', label: jobLabel, jobLabel };
  }
  const step = job.steps[selection.stepIndex];
  if (step === undefined) return null;
  return {
    kind: 'step',
    label: step.name || step.id || `Step ${selection.stepIndex + 1}`,
    jobLabel,
  };
}

/**
 * The open saved workflow, as its edit shell has it, for the assistant's
 * empty chat (CAN-4319). A new workflow has none.
 */
export interface PipelineAssistantContext {
  readonly name: string;
  readonly readOnly: boolean;
  readonly jobCount: number;
  readonly validationIssueCount: number;
  readonly selection: PipelineAssistantSelection | null;
  /** Makes an editable copy, for a read-only workflow that offers one. */
  readonly duplicate?: () => void;
}

/** How many suggestions an empty chat shows. */
const SUGGESTION_LIMIT = 3;

/**
 * Examples for a new workflow. Each asks the assistant to interview the
 * person about outcome, tools, schedule, output and review points before it
 * builds anything (CAN-4315).
 */
export const PIPELINE_STARTERS: readonly PipelineAssistantSuggestion[] = [
  {
    id: 'daily-todo-roundup',
    label: 'Daily todo roundup',
    prompt:
      'Help me build a workflow that rounds up my todos every morning: open review requests, assigned tickets, and anything I was mentioned in. Interview me about where to look, when it should run, and where the summary should go before you build it.',
    icon: <TasksIcon aria-hidden="true" />,
  },
  {
    id: 'investigate-new-bug-tickets',
    label: 'Investigate new bug tickets',
    prompt:
      'Help me build a workflow that investigates new bug tickets: read the report, look for the relevant code, try to reproduce it, and suggest a likely cause. Interview me about which tickets count, which repository to use, and what the output should be.',
    icon: <BugReportIcon aria-hidden="true" />,
  },
  {
    id: 'multi-agent-pr-review',
    label: 'Multi-agent PR review',
    prompt:
      'Help me build a workflow that reviews a pull request with several agents in parallel (correctness, tests, security) and merges their findings into one report. Interview me about which models to use, how strict to be, and where findings should be posted.',
    icon: <GitPullRequestIcon aria-hidden="true" />,
  },
];

const EXPLAIN: PipelineAssistantSuggestion = {
  id: 'explain',
  label: 'Explain this workflow',
  prompt: 'Explain what this workflow does, step by step.',
  icon: <InfoIcon aria-hidden="true" />,
};

/**
 * What the assistant can do for a read-only workflow: explain it. It cannot
 * change it, so nothing here asks it to.
 */
const READ_ONLY_SUGGESTIONS: readonly PipelineAssistantSuggestion[] = [
  {
    ...EXPLAIN,
    label: 'Explain what this workflow does, step by step',
  },
  {
    id: 'when-and-needs',
    label: 'When does this run, and what does it need?',
    prompt:
      'When does this workflow start, and what does it need to run: inputs, a project or a worktree?',
    icon: <QuestionMarkIcon aria-hidden="true" />,
  },
  {
    id: 'what-would-i-change',
    label: 'What would I change to make it…',
    prompt: 'What would I change in this workflow to make it ',
    icon: <PencilIcon aria-hidden="true" />,
  },
];

function selectionSuggestion(
  selection: PipelineAssistantSelection,
): PipelineAssistantSuggestion {
  return {
    id: 'change-selection',
    label: `Change ${selection.label}…`,
    prompt:
      selection.kind === 'job'
        ? `In the job "${selection.label}", `
        : `In the step "${selection.label}" of the job "${selection.jobLabel}", `,
    icon: <PencilIcon aria-hidden="true" />,
  };
}

/**
 * The suggestions an empty assistant chat offers for an open workflow, most
 * relevant first: a read-only workflow's questions, or for an editable one
 * its validation issues, the flow's selection, then the usual changes. An
 * editable workflow with no jobs yet gets the new-workflow examples. Only
 * what the assistant's tools can do: it reads and changes the definition,
 * not runs or schedules.
 */
export function pipelineAssistantSuggestions(
  context: PipelineAssistantContext,
): readonly PipelineAssistantSuggestion[] {
  if (context.readOnly) return READ_ONLY_SUGGESTIONS;
  if (context.jobCount === 0) return PIPELINE_STARTERS;
  const issues = context.validationIssueCount;
  const suggestions: PipelineAssistantSuggestion[] = [
    ...(issues > 0
      ? [
          {
            id: 'fix-validation',
            label:
              issues === 1
                ? 'Fix the validation issue'
                : `Fix the ${issues} validation issues`,
            prompt: 'Fix the validation issues in this workflow.',
            icon: <WarningIcon aria-hidden="true" />,
          },
        ]
      : []),
    ...(context.selection ? [selectionSuggestion(context.selection)] : []),
    {
      id: 'add-step',
      label: 'Add a step that…',
      prompt: 'Add a step that ',
      icon: <PlusIcon aria-hidden="true" />,
    },
    {
      id: 'change-start',
      label: 'Change when it starts',
      prompt:
        'Change when this workflow starts. Ask me which start I want before you change it.',
      icon: <ScheduleIcon aria-hidden="true" />,
    },
    EXPLAIN,
  ];
  return suggestions.slice(0, SUGGESTION_LIMIT);
}
