import { z } from 'zod';

import { CanopyQueryRequestMetadataSchema } from '../common';
import {
  CanopyStreamCursorSchema,
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

/*
 * `worker.codeGraph.build`, `worker.codeGraph.buildQueue.*` and
 * `worker.codeGraph.build.cancel` (CAN-4149): builds and the status, reorder
 * and cancel controls of one worker's code-graph build queue. Worktree and workspace-base builds share that queue
 * with its priority classes, first-build aging and concurrency lanes; the
 * worker keeps that policy. Items name their graph by workspace and worktree
 * or repository IDs, never by a host path.
 */

export const WORKER_CODE_GRAPH_GRANTS = {
  read: 'worker.codeGraph.read',
  write: 'worker.codeGraph.write',
} as const;

const id = z.string().min(1).max(512);
const timestamp = z.iso.datetime({ offset: true });
const label = z.string().max(512);

/** The most items one queue snapshot or reorder carries. */
export const WORKER_CODE_GRAPH_QUEUE_MAX_ITEMS = 1_000;

export const WORKER_CODE_GRAPH_BUILD_PRIORITIES = [
  'agent',
  'first-build',
  'worktree',
  'maintenance',
] as const;

export const WorkerCodeGraphQueueItemSchema = z.strictObject({
  queueItemId: id,
  /** A worktree's graph, or a workspace base graph shared by its owners. */
  graphScope: z.enum(['worktree', 'workspace_base']),
  /** Every workspace that needs this graph. */
  workspaceIds: z.array(id).max(WORKER_CODE_GRAPH_QUEUE_MAX_ITEMS),
  worktreeId: id.nullable(),
  repositoryId: id.nullable(),
  /** Display labels; never paths. */
  workspaceLabel: label.nullable(),
  label: label.nullable(),
  /** Why the build was requested. */
  trigger: z.string().min(1).max(128),
  priority: z.enum(WORKER_CODE_GRAPH_BUILD_PRIORITIES),
  state: z.enum(['queued', 'running']),
  /** Running items keep their slot; only queued items can be reordered. */
  reorderable: z.boolean(),
  enqueuedAt: timestamp,
  startedAt: timestamp.nullable(),
  /** Diagnostic timing when the snapshot was taken. */
  timing: z.strictObject({
    /** Time spent queued: until the build started, or until now. */
    queueWaitMs: z.number().int().min(0),
    /** Time spent running so far; null while queued. */
    runningMs: z.number().int().min(0).nullable(),
  }),
});

/**
 * The queue in dispatch order: running items first, then queued items in the
 * order they will start. `revision` changes on every queue change.
 */
export const WorkerCodeGraphBuildQueueSchema = z.strictObject({
  revision: z.number().int().min(0),
  items: z
    .array(WorkerCodeGraphQueueItemSchema)
    .max(WORKER_CODE_GRAPH_QUEUE_MAX_ITEMS),
});

export const WorkerCodeGraphBuildQueueGetParamsSchema = z.strictObject({
  _meta: CanopyQueryRequestMetadataSchema.optional(),
});

export const WorkerCodeGraphBuildQueueUpdateParamsSchema = z.strictObject({
  /** The revision the caller last read; another revision is refused. */
  expectedRevision: z.number().int().min(0),
  /** Every queued item, exactly once, in the order to start them. */
  orderedQueueItemIds: z.array(id).max(WORKER_CODE_GRAPH_QUEUE_MAX_ITEMS),
});

export const WorkerCodeGraphBuildCancelParamsSchema = z.strictObject({
  queueItemId: id,
});

export const WorkerCodeGraphBuildCancelResultSchema = z.strictObject({
  queueItemId: id,
  /** The state the item was in when it was canceled. */
  canceledState: z.enum(['queued', 'running']),
});

export const WorkerCodeGraphBuildQueueQueryErrorSchema =
  CanopyErrorPayloadSchema.extend({
    code: z.enum(['worker.codeGraph.queueUnavailable']).optional(),
    retry: CanopyQueryRetryDirectiveSchema,
  });

export const WorkerCodeGraphBuildQueueUpdateErrorSchema =
  CanopyErrorPayloadSchema.extend({
    code: z
      .enum([
        'worker.codeGraph.queueChanged',
        'worker.codeGraph.queueOrderInvalid',
        'worker.codeGraph.queueUnavailable',
        'worker.codeGraph.idempotencyKeyReused',
      ])
      .optional(),
    retry: CanopyKeyedRetryDirectiveSchema,
  });

export const WorkerCodeGraphBuildCancelErrorSchema =
  CanopyErrorPayloadSchema.extend({
    code: z
      .enum([
        'worker.codeGraph.queueItemNotFound',
        'worker.codeGraph.queueUnavailable',
        'worker.codeGraph.idempotencyKeyReused',
      ])
      .optional(),
    retry: CanopyKeyedRetryDirectiveSchema,
  });

/** Every build of one worktree: queued, running, or still preparing. */
export const WorkerCodeGraphBuildsCancelParamsSchema = z.strictObject({
  workspaceId: id,
  worktreeId: id,
});

export const WorkerCodeGraphBuildsCancelResultSchema = z.strictObject({
  /** Builds canceled; each one's host had exited before this answer. */
  canceled: z.number().int().min(0),
});

export const WorkerCodeGraphBuildsCancelErrorSchema =
  CanopyErrorPayloadSchema.extend({
    code: z
      .enum([
        'worker.codeGraph.queueUnavailable',
        'worker.codeGraph.idempotencyKeyReused',
      ])
      .optional(),
    retry: CanopyKeyedRetryDirectiveSchema,
  });

export const WORKER_CODE_GRAPH_BUILD_MODES = [
  'incremental',
  'verified',
  'full',
] as const;

/** Why a scheduler started a background build. */
export const WORKER_CODE_GRAPH_BACKGROUND_TRIGGERS = [
  'worktree-created',
  'refresh',
] as const;

export const WorkerCodeGraphBackgroundBuildSchema = z.strictObject({
  trigger: z.enum(WORKER_CODE_GRAPH_BACKGROUND_TRIGGERS),
  /**
   * The worktree fingerprint the scheduler read just before asking, and how
   * long that read took. The build starts from it instead of reading again.
   */
  observedFingerprint: z
    .strictObject({
      value: z.string().min(1).max(512),
      observedMs: z.number().int().min(0),
    })
    .optional(),
});

/**
 * A workspace base build the app started on its own: the periodic maintenance
 * of every base (CAN-5619), or the repair of one repository's base whose
 * summary is pending (CAN-5621).
 */
export const WorkerCodeGraphBaseMaintenanceSchema = z.discriminatedUnion(
  'trigger',
  [
    z.strictObject({ trigger: z.literal('maintenance') }),
    z.strictObject({ trigger: z.literal('summary-repair'), repoId: id }),
  ],
);

export const WorkerCodeGraphBuildParamsSchema = z.strictObject({
  graphScope: z.discriminatedUnion('kind', [
    z
      .strictObject({
        kind: z.literal('worktree'),
        workspaceId: id,
        worktreeId: id,
        /**
         * `incremental` trusts file fingerprints, `verified` rereads content
         * whose fingerprint matched, and `full` reparses every file.
         */
        mode: z.enum(WORKER_CODE_GRAPH_BUILD_MODES),
        /**
         * Who asked for the build: `agent` for an agent's build tool, `user`
         * (the default) for a person. Both run in the agent queue class.
         */
        requestedBy: z.enum(['user', 'agent']).optional(),
        /**
         * Present for a build a scheduler started on its own: it runs in the
         * background class (`worktree`, or `first-build` while the worktree
         * has no completed graph) instead of the agent class.
         */
        background: WorkerCodeGraphBackgroundBuildSchema.optional(),
      })
      .refine(
        (scope) =>
          scope.background === undefined || scope.requestedBy === undefined,
        {
          message: 'A background build is not requested by a person or agent.',
          path: ['background'],
        },
      ),
    /** Refreshes every workspace base graph the workspace needs. */
    z.strictObject({
      kind: z.literal('workspace_base'),
      workspaceId: id,
      /**
       * Present for a build the app started on its own, in the
       * `maintenance` class. Periodic maintenance rebuilds each base only
       * when its shadow moved, one at a time; a summary repair rebuilds the
       * one repository's base. Absent, every base refreshes now in the
       * agent class.
       */
      background: WorkerCodeGraphBaseMaintenanceSchema.optional(),
    }),
  ]),
});

const count = z.number().int().min(0);

const milliseconds = z.number().min(0);

export const WORKER_CODE_GRAPH_GENERATION_TRIGGERS = [
  'worktree-created',
  'refresh',
  'tool-request',
  'manual',
] as const;

/** The generation stage a failed generation is attributed to. */
export const WORKER_CODE_GRAPH_GENERATION_STAGES = [
  'preflight',
  'seed-preparation',
  'worker-build',
] as const;

/** The telemetry classification of a failed generation. */
export const WORKER_CODE_GRAPH_GENERATION_FAILURE_REASONS = [
  'timeout',
  'canceled',
  'unavailable',
  'worker-exit',
  'spawn-failed',
  'post-failed',
  'malformed-response',
  'worker-response',
  'unknown',
] as const;

/** The local diagnostic's classification, which also names read failures. */
export const WORKER_CODE_GRAPH_GENERATION_DIAGNOSTIC_FAILURE_REASONS = [
  ...WORKER_CODE_GRAPH_GENERATION_FAILURE_REASONS,
  'queue-timeout',
  'execution-timeout',
  'busy',
  'invalid-response',
  'database-error',
] as const;

export const WorkerCodeGraphResolverTimingsSchema = z.strictObject({
  resetMs: milliseconds,
  importsMs: milliseconds,
  configExtendsMs: milliseconds,
  docLinksMs: milliseconds,
  ipcMs: milliseconds,
  workflowActionsMs: milliseconds,
  callsMs: milliseconds,
  testsMs: milliseconds,
});

/** Where one build's time went, as the build host measured it. */
export const WorkerCodeGraphBuildTimingsSchema = z.strictObject({
  queueWaitMs: milliseconds.optional(),
  fingerprintMs: milliseconds.optional(),
  seedCopyMs: milliseconds.optional(),
  fusionMs: milliseconds.optional(),
  prepareMs: milliseconds,
  scanMs: milliseconds,
  hashMs: milliseconds,
  parseMs: milliseconds,
  resolveMs: WorkerCodeGraphResolverTimingsSchema.optional(),
  ftsMs: milliseconds.optional(),
  derivedMs: milliseconds.optional(),
  diagnosticsMs: milliseconds,
  commitMs: milliseconds,
  finalizeMs: milliseconds.optional(),
  rowsWritten: count,
  walStartBytes: count.optional(),
  peakWalBytes: count.optional(),
  peakRssBytes: count.optional(),
  timeToFirstGraphMs: milliseconds.optional(),
});

/** Flat, privacy-bounded telemetry values: counts, flags and enums. */
const telemetryValue = z.union([z.string().max(128), z.number(), z.boolean()]);

/**
 * The `core.runtime.initialize` client capability that asks for generation
 * reports. A client that does not announce it gets build results and
 * refusals without them, as before CAN-5627.
 */
export const WORKER_CODE_GRAPH_GENERATION_REPORT_CAPABILITY =
  'worker.codeGraph.generationReport';

/**
 * One worktree generation as the worker measured it (CAN-5627): the context
 * of its telemetry operation and its local build diagnostic. The requesting
 * interface records both with its own consent and bundled telemetry
 * configuration, so each generation is recorded once, by the client that
 * asked for it. It names no path, label or worker message.
 */
export const WorkerCodeGraphGenerationReportSchema = z.strictObject({
  trigger: z.enum(WORKER_CODE_GRAPH_GENERATION_TRIGGERS),
  outcome: z.enum(['success', 'failure']),
  repositoryCount: count.nullable(),
  /** The generation's wall time, from request to settlement. */
  totalMs: milliseconds,
  /** Result counts the telemetry operation reports on success. */
  telemetry: z
    .record(z.string().regex(/^[a-z][a-z_]{0,63}$/), telemetryValue)
    .refine((context) => Object.keys(context).length <= 64, {
      message: 'At most 64 telemetry values.',
    }),
  failure: z
    .strictObject({
      stage: z.enum(WORKER_CODE_GRAPH_GENERATION_STAGES),
      reason: z.enum(WORKER_CODE_GRAPH_GENERATION_FAILURE_REASONS),
    })
    .nullable(),
  /** The local build diagnostic, a session event for this worktree. */
  diagnostic: z.strictObject({
    outcome: z.enum(['success', 'failure', 'deferred']),
    failureStage: z.enum(WORKER_CODE_GRAPH_GENERATION_STAGES).optional(),
    failureReason: z
      .enum(WORKER_CODE_GRAPH_GENERATION_DIAGNOSTIC_FAILURE_REASONS)
      .optional(),
    attemptId: z
      .string()
      .regex(/^[a-zA-Z0-9_-]{1,64}$/)
      .optional(),
    queuePriority: z.enum(['agent', 'first-build', 'worktree']).optional(),
    totalMs: milliseconds,
    filesScanned: count.optional(),
    filesParsed: count.optional(),
    factsChanged: z.boolean().optional(),
    queueWaitMs: milliseconds.optional(),
    timings: WorkerCodeGraphBuildTimingsSchema.optional(),
    endFingerprintMs: milliseconds.optional(),
    fingerprintPersistMs: milliseconds.optional(),
    fingerprintPersistOutcome: z
      .enum(['persisted', 'unstable', 'busy', 'error'])
      .optional(),
  }),
});

/** Bounds on the build warnings a result carries; hosts clip to them. */
export const WORKER_CODE_GRAPH_BUILD_WARNING_LIMITS = {
  diagnostics: 1_024,
  derivedWarnings: 1_000,
  entryIdLength: 512,
  messageLength: 4_096,
} as const;

export const WorkerCodeGraphBuildResultSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('worktree'),
    filesScanned: count,
    filesParsed: count,
    filesUnchanged: count,
    filesSkipped: count,
    filesRemoved: count,
    parseFailures: count,
    symbolCount: count,
    edgeCount: count,
    durationMs: count,
    lastBuildAt: timestamp.nullable(),
    /** The graph is published and derived analysis is still running. */
    derivedPending: z.boolean(),
    /**
     * The custom-language entries this build skipped or could not load, or
     * null when the worktree has no custom-language configuration.
     */
    customLanguageDiagnostics: z
      .array(
        z.strictObject({
          entryId: z
            .string()
            .max(WORKER_CODE_GRAPH_BUILD_WARNING_LIMITS.entryIdLength)
            .nullable(),
          message: z
            .string()
            .max(WORKER_CODE_GRAPH_BUILD_WARNING_LIMITS.messageLength),
        }),
      )
      .max(WORKER_CODE_GRAPH_BUILD_WARNING_LIMITS.diagnostics)
      .nullable(),
    /**
     * Derived-analysis warnings, each naming its repository, or null when
     * the build ran no derived analysis.
     */
    derivedWarnings: z
      .array(
        z.string().max(WORKER_CODE_GRAPH_BUILD_WARNING_LIMITS.messageLength),
      )
      .max(WORKER_CODE_GRAPH_BUILD_WARNING_LIMITS.derivedWarnings)
      .nullable(),
    /** How the generation went, for the requester's telemetry (CAN-5627). */
    generation: WorkerCodeGraphGenerationReportSchema.optional(),
  }),
  z.strictObject({
    kind: z.literal('workspace_base'),
    repositories: z
      .array(
        z.strictObject({
          repositoryId: id,
          outcome: z.enum(['built', 'failed', 'timed_out', 'unavailable']),
        }),
      )
      .max(WORKER_CODE_GRAPH_QUEUE_MAX_ITEMS),
  }),
]);

/**
 * Why a build failed, on `worker.codeGraph.buildFailed`: the build host
 * exited, could not start, could not take the request or answered malformed;
 * the build itself reported a failure (`build_error`); or something else
 * failed (`internal`). The host's own message stays with the worker.
 */
export const WORKER_CODE_GRAPH_BUILD_FAILURES = [
  'worker_exit',
  'spawn_failed',
  'post_failed',
  'malformed_response',
  'build_error',
  'internal',
] as const;

export const WorkerCodeGraphBuildFailureDetailsSchema = z.strictObject({
  /** Present on `worker.codeGraph.buildFailed`. */
  failure: z.enum(WORKER_CODE_GRAPH_BUILD_FAILURES).optional(),
  /** How a worktree generation went before it failed (CAN-5627). */
  generation: WorkerCodeGraphGenerationReportSchema.optional(),
});

export const WorkerCodeGraphBuildErrorSchema = CanopyErrorPayloadSchema.extend({
  code: z
    .enum([
      'worker.codeGraph.unavailable',
      'worker.codeGraph.graphScopeNotFound',
      'worker.codeGraph.queueUnavailable',
      'worker.codeGraph.buildFailed',
      'worker.codeGraph.buildTimedOut',
      'worker.codeGraph.buildCanceled',
      'worker.codeGraph.idempotencyKeyReused',
    ])
    .optional(),
  details: WorkerCodeGraphBuildFailureDetailsSchema.optional(),
  retry: CanopyKeyedRetryDirectiveSchema,
});

export type WorkerCodeGraphBuildParams = z.output<
  typeof WorkerCodeGraphBuildParamsSchema
>;
export type WorkerCodeGraphGenerationReport = z.output<
  typeof WorkerCodeGraphGenerationReportSchema
>;
export type WorkerCodeGraphBuildResult = z.output<
  typeof WorkerCodeGraphBuildResultSchema
>;
export type WorkerCodeGraphBackgroundBuild = z.output<
  typeof WorkerCodeGraphBackgroundBuildSchema
>;
export type WorkerCodeGraphBaseMaintenance = z.output<
  typeof WorkerCodeGraphBaseMaintenanceSchema
>;
export type WorkerCodeGraphBuildFailure =
  (typeof WORKER_CODE_GRAPH_BUILD_FAILURES)[number];

export type WorkerCodeGraphQueueItem = z.output<
  typeof WorkerCodeGraphQueueItemSchema
>;
export type WorkerCodeGraphBuildQueue = z.output<
  typeof WorkerCodeGraphBuildQueueSchema
>;
export type WorkerCodeGraphBuildQueueGetParams = z.output<
  typeof WorkerCodeGraphBuildQueueGetParamsSchema
>;
export type WorkerCodeGraphBuildQueueUpdateParams = z.output<
  typeof WorkerCodeGraphBuildQueueUpdateParamsSchema
>;
export type WorkerCodeGraphBuildCancelParams = z.output<
  typeof WorkerCodeGraphBuildCancelParamsSchema
>;
export type WorkerCodeGraphBuildCancelResult = z.output<
  typeof WorkerCodeGraphBuildCancelResultSchema
>;
export type WorkerCodeGraphBuildsCancelParams = z.output<
  typeof WorkerCodeGraphBuildsCancelParamsSchema
>;
export type WorkerCodeGraphBuildsCancelResult = z.output<
  typeof WorkerCodeGraphBuildsCancelResultSchema
>;
export type WorkerCodeGraphBuildPriority =
  (typeof WORKER_CODE_GRAPH_BUILD_PRIORITIES)[number];

export const WORKER_CODE_GRAPH_QUERY_DEFINITIONS = defineCanopyQueryRegistry(
  'worker',
  {
    'worker.codeGraph.buildQueue.get': defineCanopyQuery({
      plane: 'worker',
      domain: 'codeGraph',
      version: 1,
      placement: 'target-selectable',
      params: WorkerCodeGraphBuildQueueGetParamsSchema,
      result: WorkerCodeGraphBuildQueueSchema,
      error: WorkerCodeGraphBuildQueueQueryErrorSchema,
      idempotency: 'inherent',
      requiredGrants: [WORKER_CODE_GRAPH_GRANTS.read],
    }),
  },
);

export const WORKER_CODE_GRAPH_INSTRUCTION_DEFINITIONS =
  defineCanopyInstructionRegistry('worker', {
    'worker.codeGraph.buildQueue.update': defineCanopyInstruction({
      plane: 'worker',
      domain: 'codeGraph',
      version: 1,
      placement: 'target-selectable',
      params: WorkerCodeGraphBuildQueueUpdateParamsSchema,
      result: WorkerCodeGraphBuildQueueSchema,
      error: WorkerCodeGraphBuildQueueUpdateErrorSchema,
      idempotency: 'keyed',
      requiredGrants: [WORKER_CODE_GRAPH_GRANTS.write],
    }),
    'worker.codeGraph.build': defineCanopyInstruction({
      plane: 'worker',
      domain: 'codeGraph',
      version: 1,
      placement: 'target-selectable',
      params: WorkerCodeGraphBuildParamsSchema,
      result: WorkerCodeGraphBuildResultSchema,
      error: WorkerCodeGraphBuildErrorSchema,
      idempotency: 'keyed',
      requiredGrants: [WORKER_CODE_GRAPH_GRANTS.write],
    }),
    'worker.codeGraph.build.cancel': defineCanopyInstruction({
      plane: 'worker',
      domain: 'codeGraph',
      version: 1,
      placement: 'target-selectable',
      params: WorkerCodeGraphBuildCancelParamsSchema,
      result: WorkerCodeGraphBuildCancelResultSchema,
      error: WorkerCodeGraphBuildCancelErrorSchema,
      idempotency: 'keyed',
      requiredGrants: [WORKER_CODE_GRAPH_GRANTS.write],
    }),
    // CAN-5089: worktree cleanup ends a worktree's graph work before it
    // removes the graph, including builds no queue item names yet.
    'worker.codeGraph.builds.cancel': defineCanopyInstruction({
      plane: 'worker',
      domain: 'codeGraph',
      version: 1,
      placement: 'target-selectable',
      params: WorkerCodeGraphBuildsCancelParamsSchema,
      result: WorkerCodeGraphBuildsCancelResultSchema,
      error: WorkerCodeGraphBuildsCancelErrorSchema,
      idempotency: 'keyed',
      requiredGrants: [WORKER_CODE_GRAPH_GRANTS.write],
    }),
  });

/*
 * `worker.codeGraph.buildQueue.events` (CAN-5628): the build queue after
 * each change, and the current queue when the stream opens. Each item is
 * the whole queue, so a reopened stream starts from the current queue and
 * nothing is replayed; a cursor only continues numbering.
 */
export const WorkerCodeGraphBuildQueueEventsParamsSchema = z.strictObject({
  cursor: CanopyStreamCursorSchema.nullable().optional(),
});
export const WorkerCodeGraphBuildQueueEventsOpenResultSchema = z.strictObject({
  subscriptionId: id,
  acceptedCursor: CanopyStreamCursorSchema.nullable(),
});
export const WorkerCodeGraphBuildQueueEventsItemSchema = z.strictObject({
  queue: WorkerCodeGraphBuildQueueSchema,
});
export const WorkerCodeGraphBuildQueueEventsEndSchema =
  CanopyStreamEndSchema.extend({
    error: WorkerCodeGraphBuildQueueQueryErrorSchema.nullable(),
  });
export type WorkerCodeGraphBuildQueueEventsItem = z.output<
  typeof WorkerCodeGraphBuildQueueEventsItemSchema
>;

/** Composed only where served: the core daemon (CAN-5628). */
export const WORKER_CODE_GRAPH_STREAM_DEFINITIONS = defineCanopyStreamRegistry(
  'worker',
  {
    'worker.codeGraph.buildQueue.events': defineCanopyStream({
      plane: 'worker',
      domain: 'codeGraph',
      version: 1,
      placement: 'target-selectable',
      idempotency: 'inherent',
      requiredGrants: [WORKER_CODE_GRAPH_GRANTS.read],
      params: WorkerCodeGraphBuildQueueEventsParamsSchema,
      openResult: WorkerCodeGraphBuildQueueEventsOpenResultSchema,
      item: WorkerCodeGraphBuildQueueEventsItemSchema,
      end: WorkerCodeGraphBuildQueueEventsEndSchema,
      error: WorkerCodeGraphBuildQueueQueryErrorSchema,
    }),
  },
);
