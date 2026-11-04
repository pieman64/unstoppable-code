import { z } from 'zod';

import { CanopyQueryRequestMetadataSchema } from '../common';
import {
  CanopyStreamEndSchema,
  defineCanopyInstruction,
  defineCanopyInstructionRegistry,
  defineCanopyQuery,
  defineCanopyQueryRegistry,
  defineCanopyStream,
  defineCanopyStreamRegistry,
} from '../definitions';
import {
  CanopyErrorPayloadSchema,
  CanopyKeyedRetryDirectiveSchema,
  CanopyQueryRetryDirectiveSchema,
} from '../errors';
import { SIDEBAR_ITEM_GROUP_COLORS } from '../sidebar-values';
import {
  PIPELINE_DEFINITION_SOURCES,
  PipelineRunOwnerSchema,
} from '../pipeline-values';
import {
  WORKER_PIPELINE_HOST_TEXT_MAX,
  WorkerPipelineChatAddressSchema,
  WorkerPipelineChatSendRecordSchema,
  WorkerPipelinePromptReferenceSchema,
  WorkerPipelineSendSettingsSchema,
} from './pipeline-host-values';

/*
 * `worker.pipeline.execution.*` (CAN-4140): start, status, cancel and bounded
 * events for one pipeline execution on a worker. Core resolves the
 * definition, the run's owner and its authorization before it dispatches a
 * start; the worker runs the snapshot core admitted and never treats a
 * client path as definition authority. Host paths never cross this boundary.
 */

export const WORKER_PIPELINE_GRANTS = {
  read: 'worker.pipeline.read',
  write: 'worker.pipeline.write',
  /**
   * Settles host-step requests. Only the owning core holds it: no interface
   * surface lists the host request operations, so the renderer relay never
   * passes it on.
   */
  host: 'worker.pipeline.host',
} as const;

const id = z.string().min(1).max(512);
const timestamp = z.iso.datetime({ offset: true });

export const WORKER_PIPELINE_EXECUTION_STATUSES = [
  'pending',
  'running',
  'paused',
  'success',
  'failure',
  'cancelled',
] as const;

export const WORKER_PIPELINE_TERMINAL_STATUSES = [
  'success',
  'failure',
  'cancelled',
] as const;

export const WORKER_PIPELINE_RUN_SCOPES = [
  'global',
  'directory',
  'worktree',
] as const;

/** Where a run's definition came from; `inline` has no stored identity. */
export const WORKER_PIPELINE_DEFINITION_SOURCES = [
  ...PIPELINE_DEFINITION_SOURCES,
  'inline',
] as const;

/** What started a run, as the usage records name it. */
export const WORKER_PIPELINE_INITIATION_SOURCES = [
  'user',
  'hook',
  'automation',
  'app_advisor',
  'portal',
  'unknown',
] as const;

/** The longest error message an execution projection carries. */
export const WORKER_PIPELINE_ERROR_MAX_LENGTH = 4096;
/** The most output text one events item carries. */
export const WORKER_PIPELINE_OUTPUT_ITEM_MAX_LENGTH = 16_384;

export const WorkerPipelineExecutionSchema = z.strictObject({
  executionId: id,
  pipelineId: id,
  name: z.string().max(512),
  status: z.enum(WORKER_PIPELINE_EXECUTION_STATUSES),
  runScope: z.enum(WORKER_PIPELINE_RUN_SCOPES),
  definitionSource: z.enum(WORKER_PIPELINE_DEFINITION_SOURCES),
  /** The run's owner; older runs may have none. */
  owner: PipelineRunOwnerSchema.nullable(),
  workspaceId: id.nullable(),
  worktreeId: id.nullable(),
  parentExecutionId: id.nullable(),
  startedAt: timestamp,
  completedAt: timestamp.nullable(),
  /** Pause checkpoints a resume may answer. */
  pendingPauseCount: z.number().int().min(0),
  error: z.string().max(WORKER_PIPELINE_ERROR_MAX_LENGTH).nullable(),
});

export const WorkerPipelineExecutionStartParamsSchema = z.strictObject({
  executionId: id,
  pipelineId: id,
  definitionSource: z.enum(WORKER_PIPELINE_DEFINITION_SOURCES),
  runScope: z.enum(WORKER_PIPELINE_RUN_SCOPES),
  workspaceId: id.nullable(),
  worktreeId: id.nullable(),
  /** The owner core resolved and authorized the run for. */
  owner: PipelineRunOwnerSchema,
  initiationSource: z.enum(WORKER_PIPELINE_INITIATION_SOURCES),
});

export const WorkerPipelineExecutionResultSchema = z.strictObject({
  execution: WorkerPipelineExecutionSchema,
});

export const WorkerPipelineExecutionGetParamsSchema = z.strictObject({
  executionId: id,
  _meta: CanopyQueryRequestMetadataSchema.optional(),
});

export const WORKER_PIPELINE_CANCEL_MODES = ['finalize', 'drain'] as const;

export const WorkerPipelineExecutionCancelParamsSchema = z.strictObject({
  executionId: id,
  /**
   * `finalize` (the default) settles a run that ignores its cancel after a
   * bounded window. `drain` stops its live processes within a bounded wait
   * and never writes a terminal state itself, so a run still stopping keeps
   * its cancel request and running state (archive teardown).
   */
  mode: z.enum(WORKER_PIPELINE_CANCEL_MODES).optional(),
});

export const WorkerPipelineExecutionEventsParamsSchema = z.strictObject({
  executionId: id,
  /** The stream doesn't resume; every subscription starts from a snapshot. */
  cursor: z.null().optional(),
  _meta: CanopyQueryRequestMetadataSchema.optional(),
});

export const WorkerPipelineExecutionEventsOpenResultSchema = z.strictObject({
  subscriptionId: id,
  acceptedCursor: z.null(),
});

/**
 * One events item. Lifecycle items are never dropped. Output is budgeted:
 * text past an item's limit is cut, and output past the stream's budget is
 * dropped and reported by the next `gap` item, so output pressure never
 * crowds out a lifecycle or terminal item.
 */
export const WorkerPipelineExecutionEventsItemSchema = z.discriminatedUnion(
  'kind',
  [
    z.strictObject({
      kind: z.literal('execution'),
      event: z.string().min(1).max(128),
      execution: WorkerPipelineExecutionSchema,
    }),
    z.strictObject({
      kind: z.literal('output'),
      jobId: id,
      stepId: id,
      stream: z.enum(['stdout', 'stderr']),
      text: z.string().max(WORKER_PIPELINE_OUTPUT_ITEM_MAX_LENGTH),
      truncated: z.boolean(),
    }),
    z.strictObject({
      kind: z.literal('gap'),
      droppedOutputItems: z.number().int().min(1),
    }),
  ],
);

export const WorkerPipelineExecutionErrorSchema =
  CanopyErrorPayloadSchema.extend({
    code: z
      .enum([
        'worker.pipeline.executionNotFound',
        'worker.pipeline.launchUnavailable',
        'worker.pipeline.startFailed',
      ])
      .optional(),
    retry: CanopyKeyedRetryDirectiveSchema,
  });

export const WorkerPipelineExecutionCancelErrorSchema =
  CanopyErrorPayloadSchema.extend({
    code: z
      .enum([
        'worker.pipeline.executionNotFound',
        'worker.pipeline.drainTimedOut',
      ])
      .optional(),
    retry: CanopyKeyedRetryDirectiveSchema,
  });

export const WorkerPipelineExecutionQueryErrorSchema =
  CanopyErrorPayloadSchema.extend({
    code: z.enum(['worker.pipeline.executionNotFound']).optional(),
    retry: CanopyQueryRetryDirectiveSchema,
  });

export const WorkerPipelineExecutionEventsEndSchema =
  CanopyStreamEndSchema.extend({
    error: WorkerPipelineExecutionQueryErrorSchema.nullable(),
  });

/*
 * Recovery controls (CAN-4141): resume, retry, start over and the matrix
 * controls act on an execution the worker holds. Core records each as a
 * `core.pipeline.control` operation receipted by `requestId`, so a
 * redelivered or unanswered control is never sent again.
 */

/** The idempotency key of one control; a Portal command id when it has one. */
const requestId = id;
const statusReasonId = z
  .string()
  .regex(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
  );

/**
 * The longest text one pause answer carries. The executor never capped
 * answers, and a multiline input may take pasted logs or a spec, so the
 * boundary only rules out unbounded payloads.
 */
export const WORKER_PIPELINE_PAUSE_ANSWER_MAX_LENGTH = 1_000_000;

/** An answer to one pending input request, the run's pending-input command. */
export const WorkerPipelinePauseResponseSchema = z.strictObject({
  /** The exact pause it answers, so a stale answer can't reach a newer one. */
  checkpointId: id.optional(),
  jobId: id,
  stepId: id,
  answers: z
    .record(
      z.string().min(1).max(256),
      z.union([
        z.string().max(WORKER_PIPELINE_PAUSE_ANSWER_MAX_LENGTH),
        z.number(),
        z.boolean(),
      ]),
    )
    .refine(
      (answers) => Object.keys(answers).length <= 256,
      'Too many answers.',
    )
    .optional(),
});

/** Who asked for a control; usage records keep the run's own source. */
export const WORKER_PIPELINE_CONTROL_SOURCES = [
  'user',
  'automation',
  'portal',
] as const;

export const WorkerPipelineExecutionResumeParamsSchema = z.strictObject({
  requestId,
  executionId: id,
  /** The pauses to resume; every recoverable one when absent. */
  statusReasonIds: z.array(statusReasonId).min(1).max(256).optional(),
  pauseResponses: z
    .array(WorkerPipelinePauseResponseSchema)
    .min(1)
    .max(256)
    .optional(),
  /** Answer `stale_noop` when none of the named pauses is current. */
  allowStaleNoop: z.boolean().optional(),
  initiationSource: z.enum(WORKER_PIPELINE_CONTROL_SOURCES),
  /** Attribute the rest of the run to `initiationSource`. */
  persistInitiationSource: z.boolean().optional(),
});

export const WORKER_PIPELINE_RETRY_MODES = [
  'failed_only',
  'from_start',
] as const;

export const WorkerPipelineExecutionRetryParamsSchema = z.strictObject({
  requestId,
  executionId: id,
  /**
   * `failed_only` reruns the execution's failed work in place. `from_start` runs
   * its snapshot again as `newExecutionId`.
   */
  mode: z.enum(WORKER_PIPELINE_RETRY_MODES),
  newExecutionId: id.optional(),
  initiationSource: z.enum(WORKER_PIPELINE_CONTROL_SOURCES).optional(),
});

export const WORKER_PIPELINE_MATRIX_RETRY_MODES = [
  'all',
  'failed',
  'variants',
  'expansion',
] as const;

export const WorkerPipelineMatrixJobRetryParamsSchema = z.strictObject({
  requestId,
  executionId: id,
  jobId: id,
  mode: z.enum(WORKER_PIPELINE_MATRIX_RETRY_MODES),
  variantJobIds: z.array(id).min(1).max(1024).optional(),
});

export const WorkerPipelineMatrixVariantCancelParamsSchema = z.strictObject({
  requestId,
  executionId: id,
  jobId: id,
  variantJobId: id,
});

/**
 * What a control did. `started` runs the execution (for `from_start`, the
 * new one); `updated` changed it without running anything; `already_running`
 * and `stale_noop` changed nothing.
 */
export const WORKER_PIPELINE_CONTROL_OUTCOMES = [
  'started',
  'updated',
  'already_running',
  'stale_noop',
] as const;

export const WorkerPipelineControlResultSchema = z.strictObject({
  outcome: z.enum(WORKER_PIPELINE_CONTROL_OUTCOMES),
  execution: WorkerPipelineExecutionSchema,
});

export const WorkerPipelineControlErrorSchema = CanopyErrorPayloadSchema.extend(
  {
    code: z
      .enum([
        'worker.pipeline.executionNotFound',
        'worker.pipeline.launchUnavailable',
        'worker.pipeline.controlFailed',
      ])
      .optional(),
    retry: CanopyKeyedRetryDirectiveSchema,
  },
);

/*
 * Startup and shutdown recovery (CAN-4141): the orphan sweep pauses the
 * executions a process left running when it exited, so they can resume, and
 * the shutdown checkpoint pauses every live execution before the worker
 * stops. Messages stay on the host; results carry ids and counts only.
 */

/** The most executions one startup sweep looks at. */
export const WORKER_PIPELINE_SWEEP_MAX = 10_000;

export const WorkerPipelineRecoverySweepParamsSchema = z.strictObject({
  requestId,
  /** The executions the startup scan found; only orphaned ones change. */
  executionIds: z.array(id).max(WORKER_PIPELINE_SWEEP_MAX),
});

export const WorkerPipelineRecoverySweepResultSchema = z.strictObject({
  /** Executions the sweep could not recover; a later startup retries them. */
  failureCount: z.number().int().min(0),
});

export const WorkerPipelineRecoveryCheckpointParamsSchema = z.strictObject({
  requestId,
});

export const WorkerPipelineRecoveryCheckpointResultSchema = z.strictObject({
  /** Live executions the worker paused at a checkpoint. */
  checkpointedCount: z.number().int().min(0),
});

export const WorkerPipelineRecoveryErrorSchema =
  CanopyErrorPayloadSchema.extend({
    code: z.enum(['worker.pipeline.checkpointFailed']).optional(),
    retry: CanopyKeyedRetryDirectiveSchema,
  });

/** Every host step crosses as a request (CAN-4140, CAN-5077). */
export const WORKER_PIPELINE_HOST_ACTIONS = [
  'move-to-group',
  'create-worktree',
  'create-project-entry',
  'create-bot-entry',
  'send-agent-message',
  'wait-for-agent-reply',
] as const;

export const WORKER_PIPELINE_HOST_FAILURE_REASONS = [
  'not_found',
  'advisor_access_disabled',
  'owner_context_unavailable',
  'validation_failed',
  'target_not_ready',
  'unsupported_action',
  'authorization_conflict',
  'needs_desktop',
  'setup_failed',
  'setup_timed_out',
  'reply_timed_out',
] as const;

/** Outputs that are host paths; the worker derives them on its own host. */
export const WORKER_PIPELINE_HOST_PATH_OUTPUTS = [
  'path',
  'setup_log_file',
  'setup_results_file',
  'reply_file',
] as const;

const hostRequestId = z.string().min(1).max(3072);
/**
 * A name a step's inputs carry, such as a group or branch name. The step
 * parsers don't bound them, so the boundary bounds them only as it bounds
 * output values; the host applies its own limits as it always has.
 */
const name = z.string().min(1).max(20_000);

const hostOutputs = z
  .record(
    z
      .string()
      .min(1)
      .max(128)
      .regex(/^(?!(?:path|setup_log_file|setup_results_file|reply_file)$)/, {
        message: 'Host paths never cross this boundary.',
      }),
    z.string().max(20_000),
  )
  .refine((outputs) => Object.keys(outputs).length <= 64, 'Too many outputs.');

export const WorkerPipelineHostActionRequestSchema = z.discriminatedUnion(
  'action',
  [
    z.strictObject({
      action: z.literal('move-to-group'),
      task: z.discriminatedUnion('kind', [
        z.strictObject({
          kind: z.literal('project'),
          projectId: id,
          taskId: id,
        }),
        z.strictObject({ kind: z.literal('bot'), botId: id, taskId: id }),
      ]),
      target: z.discriminatedUnion('kind', [
        z.strictObject({
          kind: z.literal('name'),
          name,
          color: z.enum(SIDEBAR_ITEM_GROUP_COLORS).optional(),
        }),
        z.strictObject({ kind: z.literal('id'), groupId: id }),
        z.strictObject({ kind: z.literal('remove') }),
      ]),
    }),
    z.strictObject({
      action: z.literal('create-worktree'),
      projectId: id,
      branch: z.discriminatedUnion('kind', [
        z.strictObject({ kind: z.literal('default') }),
        z.strictObject({ kind: z.literal('new'), name }),
        z.strictObject({ kind: z.literal('existing'), name }),
      ]),
      baseBranch: name.optional(),
      baseTaskId: id.optional(),
      repair: z.boolean(),
      restoreClaudeMd: z.boolean().optional(),
      setup: z.enum(['skip', 'run', 'run_and_wait']),
      group: name.optional(),
    }),
    z.strictObject({
      action: z.literal('create-project-entry'),
      projectId: id,
      title: z.string().min(1).max(200).optional(),
      group: name.optional(),
    }),
    z.strictObject({
      action: z.literal('create-bot-entry'),
      botId: id,
      title: z.string().min(1).max(200).optional(),
      group: name.optional(),
    }),
    z.strictObject({
      action: z.literal('send-agent-message'),
      target: z.discriminatedUnion('kind', [
        z.strictObject({
          kind: z.literal('project'),
          projectId: id,
          taskId: id,
          chatId: id.optional(),
        }),
        z.strictObject({
          kind: z.literal('bot'),
          botId: id,
          taskId: id,
          chatId: id.optional(),
        }),
      ]),
      /** The text to send, `text_file` already read. */
      text: z.string().min(1).max(WORKER_PIPELINE_HOST_TEXT_MAX),
      mode: z.enum(['queue', 'steer']),
      settings: WorkerPipelineSendSettingsSchema,
      textReferences: z
        .array(WorkerPipelinePromptReferenceSchema)
        .max(1024)
        .optional(),
      /**
       * How many attachments the step sends. Their paths are host paths: the
       * worker contained them in the step's working folder, and they stay
       * on its host.
       */
      attachmentCount: z.number().int().min(1).max(1024).optional(),
      literalText: z.literal(true).optional(),
      replaceEmptyChat: z.literal(true).optional(),
      newChat: z.literal(true).optional(),
    }),
    z.strictObject({
      action: z.literal('wait-for-agent-reply'),
      chat: WorkerPipelineChatAddressSchema,
      messageId: id.optional(),
      replyTimeoutMinutes: z.number().positive().max(720),
    }),
  ],
);

/**
 * One host step the worker raises for core to settle (`runs.using: host`).
 * `requestId` is the step's idempotency key; core keys its effects by it.
 */
export const WorkerPipelineHostRequestSchema = z.strictObject({
  requestId: hostRequestId,
  executionId: id,
  jobId: id,
  stepId: id,
  childExecutionId: id.nullable(),
  attempt: z.number().int().min(0),
  iteration: z.number().int().min(0),
  /**
   * The run's owner; core checks every target against it. A run without one
   * is `personal`; `null` is an owner that isn't a workspace context, whose
   * project targets core refuses.
   */
  owner: PipelineRunOwnerSchema.nullable(),
  /** When the executor withdraws the call. */
  deadlineAt: timestamp,
  /** The inputs the executor parsed; absent optional inputs stay absent. */
  request: WorkerPipelineHostActionRequestSchema,
});

export const WorkerPipelineHostResultSchema = z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('success'),
    outputs: hostOutputs,
    chatSend: WorkerPipelineChatSendRecordSchema.optional(),
  }),
  z.strictObject({
    status: z.literal('failure'),
    /** `null` for an unexpected host error, whose message is redacted. */
    failureReason: z.enum(WORKER_PIPELINE_HOST_FAILURE_REASONS).nullable(),
    message: z.string().min(1).max(WORKER_PIPELINE_ERROR_MAX_LENGTH),
    outputs: hostOutputs,
    /** A message the step sent before it failed, such as a refused steer. */
    chatSend: WorkerPipelineChatSendRecordSchema.optional(),
  }),
]);

export const WorkerPipelineHostRequestsParamsSchema = z.strictObject({
  /** The stream doesn't resume; a new subscriber gets every pending request. */
  cursor: z.null().optional(),
  _meta: CanopyQueryRequestMetadataSchema.optional(),
});

export const WorkerPipelineHostRequestsOpenResultSchema =
  WorkerPipelineExecutionEventsOpenResultSchema;

export const WorkerPipelineHostRequestRespondParamsSchema = z.strictObject({
  executionId: id,
  requestId: hostRequestId,
  result: WorkerPipelineHostResultSchema,
});

export const WorkerPipelineHostRequestRespondResultSchema = z.strictObject({
  executionId: id,
  requestId: hostRequestId,
  /** `already_settled` when the step settled first, from a response or its timeout. */
  outcome: z.enum(['applied', 'already_settled']),
  settledAt: timestamp,
});

export const WorkerPipelineHostRequestErrorSchema =
  CanopyErrorPayloadSchema.extend({
    code: z.enum(['worker.pipeline.hostRequestNotFound']).optional(),
    retry: CanopyQueryRetryDirectiveSchema,
  });

export const WorkerPipelineHostRequestsEndSchema = CanopyStreamEndSchema.extend(
  { error: WorkerPipelineExecutionQueryErrorSchema.nullable() },
);

export type WorkerPipelineCancelMode =
  (typeof WORKER_PIPELINE_CANCEL_MODES)[number];
export type WorkerPipelineHostActionRequest = z.output<
  typeof WorkerPipelineHostActionRequestSchema
>;
export type WorkerPipelineHostRequest = z.output<
  typeof WorkerPipelineHostRequestSchema
>;
export type WorkerPipelineHostResult = z.output<
  typeof WorkerPipelineHostResultSchema
>;
export type WorkerPipelineHostRespondResult = z.output<
  typeof WorkerPipelineHostRequestRespondResultSchema
>;

export type WorkerPipelineExecution = z.output<
  typeof WorkerPipelineExecutionSchema
>;
export type WorkerPipelineExecutionStartParams = z.output<
  typeof WorkerPipelineExecutionStartParamsSchema
>;
export type WorkerPipelineExecutionResult = z.output<
  typeof WorkerPipelineExecutionResultSchema
>;
export type WorkerPipelineExecutionGetParams = z.output<
  typeof WorkerPipelineExecutionGetParamsSchema
>;
export type WorkerPipelineExecutionCancelParams = z.output<
  typeof WorkerPipelineExecutionCancelParamsSchema
>;
export type WorkerPipelineExecutionEventsParams = z.output<
  typeof WorkerPipelineExecutionEventsParamsSchema
>;
export type WorkerPipelineExecutionEventsItem = z.output<
  typeof WorkerPipelineExecutionEventsItemSchema
>;
export type WorkerPipelinePauseResponse = z.output<
  typeof WorkerPipelinePauseResponseSchema
>;
export type WorkerPipelineExecutionResumeParams = z.output<
  typeof WorkerPipelineExecutionResumeParamsSchema
>;
export type WorkerPipelineExecutionRetryParams = z.output<
  typeof WorkerPipelineExecutionRetryParamsSchema
>;
export type WorkerPipelineMatrixJobRetryParams = z.output<
  typeof WorkerPipelineMatrixJobRetryParamsSchema
>;
export type WorkerPipelineMatrixVariantCancelParams = z.output<
  typeof WorkerPipelineMatrixVariantCancelParamsSchema
>;
export type WorkerPipelineControlOutcome =
  (typeof WORKER_PIPELINE_CONTROL_OUTCOMES)[number];
export type WorkerPipelineControlResult = z.output<
  typeof WorkerPipelineControlResultSchema
>;
export type WorkerPipelineRecoverySweepParams = z.output<
  typeof WorkerPipelineRecoverySweepParamsSchema
>;
export type WorkerPipelineRecoverySweepResult = z.output<
  typeof WorkerPipelineRecoverySweepResultSchema
>;
export type WorkerPipelineRecoveryCheckpointResult = z.output<
  typeof WorkerPipelineRecoveryCheckpointResultSchema
>;
export type WorkerPipelineExecutionStatus =
  (typeof WORKER_PIPELINE_EXECUTION_STATUSES)[number];

export const WORKER_PIPELINE_QUERY_DEFINITIONS = defineCanopyQueryRegistry(
  'worker',
  {
    'worker.pipeline.execution.get': defineCanopyQuery({
      plane: 'worker',
      domain: 'pipeline',
      version: 1,
      placement: 'target-selectable',
      params: WorkerPipelineExecutionGetParamsSchema,
      result: WorkerPipelineExecutionResultSchema,
      error: WorkerPipelineExecutionQueryErrorSchema,
      idempotency: 'inherent',
      requiredGrants: [WORKER_PIPELINE_GRANTS.read],
    }),
  },
);

export const WORKER_PIPELINE_INSTRUCTION_DEFINITIONS =
  defineCanopyInstructionRegistry('worker', {
    'worker.pipeline.execution.start': defineCanopyInstruction({
      plane: 'worker',
      domain: 'pipeline',
      version: 1,
      placement: 'target-selectable',
      params: WorkerPipelineExecutionStartParamsSchema,
      result: WorkerPipelineExecutionResultSchema,
      error: WorkerPipelineExecutionErrorSchema,
      idempotency: 'keyed',
      requiredGrants: [WORKER_PIPELINE_GRANTS.write],
    }),
    'worker.pipeline.hostRequest.respond': defineCanopyInstruction({
      plane: 'worker',
      domain: 'pipeline',
      version: 1,
      placement: 'target-selectable',
      params: WorkerPipelineHostRequestRespondParamsSchema,
      result: WorkerPipelineHostRequestRespondResultSchema,
      error: WorkerPipelineHostRequestErrorSchema,
      idempotency: 'inherent',
      requiredGrants: [WORKER_PIPELINE_GRANTS.host],
    }),
    'worker.pipeline.execution.resume': defineCanopyInstruction({
      plane: 'worker',
      domain: 'pipeline',
      version: 1,
      placement: 'target-selectable',
      params: WorkerPipelineExecutionResumeParamsSchema,
      result: WorkerPipelineControlResultSchema,
      error: WorkerPipelineControlErrorSchema,
      idempotency: 'keyed',
      requiredGrants: [WORKER_PIPELINE_GRANTS.write],
    }),
    'worker.pipeline.execution.retry': defineCanopyInstruction({
      plane: 'worker',
      domain: 'pipeline',
      version: 1,
      placement: 'target-selectable',
      params: WorkerPipelineExecutionRetryParamsSchema,
      result: WorkerPipelineControlResultSchema,
      error: WorkerPipelineControlErrorSchema,
      idempotency: 'keyed',
      requiredGrants: [WORKER_PIPELINE_GRANTS.write],
    }),
    'worker.pipeline.matrixJob.retry': defineCanopyInstruction({
      plane: 'worker',
      domain: 'pipeline',
      version: 1,
      placement: 'target-selectable',
      params: WorkerPipelineMatrixJobRetryParamsSchema,
      result: WorkerPipelineControlResultSchema,
      error: WorkerPipelineControlErrorSchema,
      idempotency: 'keyed',
      requiredGrants: [WORKER_PIPELINE_GRANTS.write],
    }),
    'worker.pipeline.matrixVariant.cancel': defineCanopyInstruction({
      plane: 'worker',
      domain: 'pipeline',
      version: 1,
      placement: 'target-selectable',
      params: WorkerPipelineMatrixVariantCancelParamsSchema,
      result: WorkerPipelineControlResultSchema,
      error: WorkerPipelineControlErrorSchema,
      idempotency: 'keyed',
      requiredGrants: [WORKER_PIPELINE_GRANTS.write],
    }),
    'worker.pipeline.recovery.sweep': defineCanopyInstruction({
      plane: 'worker',
      domain: 'pipeline',
      version: 1,
      placement: 'target-selectable',
      params: WorkerPipelineRecoverySweepParamsSchema,
      result: WorkerPipelineRecoverySweepResultSchema,
      error: WorkerPipelineRecoveryErrorSchema,
      idempotency: 'keyed',
      requiredGrants: [WORKER_PIPELINE_GRANTS.write],
    }),
    'worker.pipeline.recovery.checkpoint': defineCanopyInstruction({
      plane: 'worker',
      domain: 'pipeline',
      version: 1,
      placement: 'target-selectable',
      params: WorkerPipelineRecoveryCheckpointParamsSchema,
      result: WorkerPipelineRecoveryCheckpointResultSchema,
      error: WorkerPipelineRecoveryErrorSchema,
      idempotency: 'keyed',
      requiredGrants: [WORKER_PIPELINE_GRANTS.write],
    }),
    'worker.pipeline.execution.cancel': defineCanopyInstruction({
      plane: 'worker',
      domain: 'pipeline',
      version: 1,
      placement: 'target-selectable',
      params: WorkerPipelineExecutionCancelParamsSchema,
      result: WorkerPipelineExecutionResultSchema,
      error: WorkerPipelineExecutionCancelErrorSchema,
      idempotency: 'keyed',
      requiredGrants: [WORKER_PIPELINE_GRANTS.write],
    }),
  });

export const WORKER_PIPELINE_STREAM_DEFINITIONS = defineCanopyStreamRegistry(
  'worker',
  {
    'worker.pipeline.execution.events': defineCanopyStream({
      plane: 'worker',
      domain: 'pipeline',
      version: 1,
      placement: 'target-selectable',
      idempotency: 'inherent',
      requiredGrants: [WORKER_PIPELINE_GRANTS.read],
      params: WorkerPipelineExecutionEventsParamsSchema,
      openResult: WorkerPipelineExecutionEventsOpenResultSchema,
      item: WorkerPipelineExecutionEventsItemSchema,
      end: WorkerPipelineExecutionEventsEndSchema,
      error: WorkerPipelineExecutionQueryErrorSchema,
    }),
    'worker.pipeline.hostRequests': defineCanopyStream({
      plane: 'worker',
      domain: 'pipeline',
      version: 1,
      placement: 'target-selectable',
      idempotency: 'inherent',
      requiredGrants: [WORKER_PIPELINE_GRANTS.host],
      params: WorkerPipelineHostRequestsParamsSchema,
      openResult: WorkerPipelineHostRequestsOpenResultSchema,
      item: WorkerPipelineHostRequestSchema,
      end: WorkerPipelineHostRequestsEndSchema,
      error: WorkerPipelineExecutionQueryErrorSchema,
    }),
  },
);
