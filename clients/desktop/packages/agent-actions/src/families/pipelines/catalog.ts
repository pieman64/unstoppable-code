import type {
  AgentActionCatalogEntry,
  AgentActionField,
} from '../../catalog/types';
import type { AgentActionFamilyJsonSchema } from '../../surface/family';
import { PIPELINE_RUN_MAX_WATCHERS } from './actions';

const PIPELINE_RUN_FIELDS: readonly AgentActionField[] = [
  {
    name: 'pipelineId',
    type: 'string',
    required: true,
    description: 'Pipeline id to run, from pipeline.list.',
  },
  {
    name: 'scope',
    type: "'global'",
    required: false,
    description:
      'Set "global" to run with no project, for a pipeline whose scopes include global. Omit it to run in this chat\'s task or folder.',
  },
  {
    name: 'inputs',
    type: 'Record<string,string>',
    required: false,
    description: 'Pipeline input values.',
  },
  {
    name: 'runMode',
    type: "'dispatch' | 'plan_ready' | 'task_ready'",
    required: false,
    description:
      'Run mode to use. Defaults to dispatch. A global run supports only dispatch.',
  },
  {
    name: 'planPath',
    type: 'string',
    required: false,
    description:
      'Plan file path, required for plan_ready and optional for task_ready. Not for global runs.',
  },
  {
    name: 'taskPath',
    type: 'string',
    required: false,
    description:
      'Task file path, required for task_ready. Not for global runs.',
  },
  {
    name: 'planId',
    type: 'string',
    required: false,
    description: 'Optional tracked plan id. Not for global runs.',
  },
  {
    name: 'repoId',
    type: 'string',
    required: false,
    description:
      'Optional repository of a multi-repository project to run in. Not for global runs.',
  },
  {
    name: 'watchers',
    type: 'InlineWatcherSetup[]',
    required: false,
    description: `Up to ${PIPELINE_RUN_MAX_WATCHERS} completion watchers to arm as soon as the run starts. Do not include destination ids. Not available for global runs.`,
  },
];

const PIPELINE_RUN_KEYWORDS: readonly string[] = [
  'pipeline',
  'run',
  'execute',
  'start',
  'dispatch',
  'global',
  'no project',
  'plan_ready',
  'task_ready',
];

const PIPELINE_RUN_NOTES: readonly string[] = [
  "A global run belongs to the owner of the chat that started it and appears under No project in that owner's Runs list. The chat that started it can list, read, and control it.",
  'Each new tool call starts a new run; repeating the same tool call returns its recorded result.',
];

export function pipelinesActionCatalog(): readonly AgentActionCatalogEntry[] {
  return [
    {
      type: 'pipeline.run',
      category: 'pipeline',
      summary:
        'Run a pipeline in this chat\'s task or folder, or with scope "global" in a scratch folder with no project.',
      fields: PIPELINE_RUN_FIELDS,
      example: {
        type: 'pipeline.run',
        pipelineId: 'build',
        inputs: { target: 'test' },
        watchers: [
          { target: { terminalStatuses: ['success', 'failure', 'cancelled'] } },
        ],
      },
      additionalExamples: [
        { type: 'pipeline.run', pipelineId: 'weekly-digest', scope: 'global' },
      ],
      keywords: PIPELINE_RUN_KEYWORDS,
      notes: PIPELINE_RUN_NOTES,
    },
  ];
}

/**
 * App Advisor's `pipeline.run` row: it has no task of its own, so a run in a
 * task names it with `projectId` and `worktreeId`.
 */
export function appAdvisorPipelinesActionCatalog(): readonly AgentActionCatalogEntry[] {
  return [
    {
      type: 'pipeline.run',
      category: 'pipeline',
      summary:
        'Run a pipeline in a task (worktree), or with scope "global" in a scratch folder with no project.',
      fields: [
        PIPELINE_RUN_FIELDS[0],
        {
          name: 'projectId',
          type: 'string',
          required: false,
          description:
            'Project of the task to run in. Required unless scope is "global"; omit it for a global run.',
        },
        {
          name: 'worktreeId',
          type: 'string',
          required: false,
          description:
            'Task (worktree) to run in. Required unless scope is "global"; omit it for a global run.',
        },
        ...PIPELINE_RUN_FIELDS.slice(1),
      ],
      example: {
        type: 'pipeline.run',
        pipelineId: 'build',
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        inputs: { target: 'test' },
        watchers: [{ terminalStatuses: ['success', 'failure', 'cancelled'] }],
      },
      additionalExamples: [
        { type: 'pipeline.run', pipelineId: 'weekly-digest', scope: 'global' },
      ],
      keywords: PIPELINE_RUN_KEYWORDS,
      notes: [
        "A global run from Orchestrator belongs to the selected owner and appears under No project in that owner's Runs list.",
        PIPELINE_RUN_NOTES[1],
      ],
    },
  ];
}

/**
 * Only `scope` is advertised; the other pipeline.run fields come from
 * SearchActions, as the desktop's legacy pipeline actions always have.
 */
export const pipelinesDispatchJsonSchema: AgentActionFamilyJsonSchema = {
  properties: {
    scope: {
      type: 'string',
      enum: ['global'],
      description:
        'For pipeline.run, "global" runs with no project. Omit it to run in this chat\'s task or folder.',
    },
  },
  allOf: [
    {
      if: {
        properties: { type: { const: 'pipeline.run' } },
        required: ['type'],
      },
      then: { required: ['pipelineId'] },
    },
  ],
};
