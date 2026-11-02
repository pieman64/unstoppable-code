import { z } from 'zod';
import { externalAgentSenderSchema } from '../portal/external-agent-sender';

/** Portable task, project and file contracts. Normative source: docs/planning/2026-10-12-web-mcp-server/contracts/portable-tasks.md. */

const UUID = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
const IsoDateTime = z.iso.datetime();
const ReadSource = z.enum(['cached', 'live']);
const ObservationKind = z.enum([
  'authority',
  'server_held',
  'desktop_rebuilt',
  'desktop_rpc',
  'desktop_cache',
  'relay_registry',
]);

export const readMetadataShape = {
  source: ReadSource,
  observationKind: ObservationKind,
  observedAt: IsoDateTime.nullable(),
  repliedAt: IsoDateTime.nullable(),
};

export const taskStatusSchema = z.enum([
  'queued',
  'running',
  'waiting_for_input',
  'waiting_for_approval',
  'idle',
  'failed',
  'stopped',
  'archived',
]);
export type TaskStatus = z.infer<typeof taskStatusSchema>;

export const taskTurnStatusSchema = z.enum([
  'queued',
  'running',
  'waiting_for_input',
  'waiting_for_approval',
  'complete',
  'failed',
  'cancelled',
]);
export type TaskTurnStatus = z.infer<typeof taskTurnStatusSchema>;

export const taskOriginSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('user'), userId: UUID }),
  externalAgentSenderSchema,
  z.strictObject({
    kind: z.literal('automation'),
    name: z.string().min(1).max(64),
  }),
]);
export type TaskOrigin = z.infer<typeof taskOriginSchema>;

export const taskEnvironmentSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('cloud_sandbox'),
    sandboxId: UUID.nullable(),
  }),
  z.strictObject({
    kind: z.literal('remote_worktree'),
    remoteId: UUID,
    worktreeId: UUID,
    branch: z.string().max(255).nullable(),
  }),
  z.strictObject({ kind: z.literal('remote_no_repository'), remoteId: UUID }),
]);

export const taskLinksSchema = z.strictObject({
  taskUrl: z.string().max(2048).startsWith('https://').nullable(),
  projectId: UUID,
  remoteId: UUID.nullable(),
  worktreeId: UUID.nullable(),
});

export const taskQuestionSchema = z
  .strictObject({
    questionId: UUID,
    prompt: z.string().min(1).max(8000),
    options: z
      .array(
        z.strictObject({
          optionIndex: z.number().int().min(0).max(99),
          label: z.string().min(1).max(500),
        }),
      )
      .max(100),
    allowOther: z.boolean(),
    multiSelect: z.boolean(),
  })
  .refine(
    ({ options }) =>
      new Set(options.map(({ optionIndex }) => optionIndex)).size ===
      options.length,
    { path: ['options'], message: 'optionIndex values must be unique' },
  );

export const taskTurnSummarySchema = z.strictObject({
  turnId: UUID,
  status: taskTurnStatusSchema,
  startedAt: IsoDateTime.nullable(),
  finalMessageSummary: z.string().max(2000).nullable(),
  outcome: z.enum(['complete', 'failed', 'cancelled']).nullable(),
  endedAt: IsoDateTime.nullable(),
  environment: taskEnvironmentSchema.nullable(),
});
export type TaskTurnSummary = z.infer<typeof taskTurnSummarySchema>;

export const taskSummarySchema = z
  .strictObject({
    taskId: UUID,
    projectId: UUID,
    // Null only for a remote task whose desktop project has no owner organization.
    organizationId: UUID.nullable(),
    remoteId: UUID.nullable(),
    title: z.string().min(1).max(256),
    status: taskStatusSchema,
    stopRequested: z.boolean(),
    pendingQuestion: taskQuestionSchema.nullable(),
    lastTurn: taskTurnSummarySchema.nullable(),
    origin: taskOriginSchema,
    environmentMode: z.enum(['cloud', 'remote']),
    environment: taskEnvironmentSchema,
    observedAt: IsoDateTime.nullable(),
    links: taskLinksSchema,
    source: ReadSource,
    observationKind: ObservationKind,
  })
  .refine(
    ({ remoteId, environmentMode }) =>
      (remoteId !== null) === (environmentMode === 'remote'),
    {
      path: ['remoteId'],
      message: 'remoteId must be present exactly for remote tasks',
    },
  )
  .refine(
    ({ remoteId, organizationId }) =>
      remoteId !== null || organizationId !== null,
    {
      path: ['organizationId'],
      message: 'organizationId is required for cloud tasks',
    },
  );
export type TaskSummary = z.infer<typeof taskSummarySchema>;

export const taskPageSchema = z.strictObject({
  items: z.array(taskSummarySchema).max(100),
  nextCursor: UUID.nullable(),
  ...readMetadataShape,
});

export const taskGetResultSchema = z.strictObject({
  task: taskSummarySchema,
  ...readMetadataShape,
});

export const taskMessageSchema = z
  .strictObject({
    kind: z.enum(['message', 'tool_call']),
    messageId: UUID,
    // Null only for a desktop message whose cached history does not record its turn.
    turnId: UUID.nullable(),
    role: z.enum(['user', 'agent']),
    text: z.string().max(20000),
    createdAt: IsoDateTime.nullable(),
    toolCall: z
      .strictObject({
        name: z.string().min(1).max(128),
        status: z.enum(['running', 'complete', 'failed']),
        argumentsSummary: z.string().max(2000).nullable(),
        resultSummary: z.string().max(2000).nullable(),
      })
      .nullable(),
    truncated: z.boolean(),
    // Trusted external-agent sender marker on a message an MCP agent sent.
    provenance: externalAgentSenderSchema.nullable(),
  })
  .refine(
    ({ kind, toolCall }) => (kind === 'tool_call') === (toolCall !== null),
    {
      path: ['toolCall'],
      message: 'toolCall must be present exactly for tool_call messages',
    },
  );
export type TaskMessage = z.infer<typeof taskMessageSchema>;

export const taskMessagesPageSchema = z.strictObject({
  items: z.array(taskMessageSchema).max(100),
  nextCursor: UUID.nullable(),
  ...readMetadataShape,
});

export const taskWaitResultSchema = z.strictObject({
  task: taskSummarySchema,
  changed: z.boolean(),
  timedOut: z.boolean(),
  ...readMetadataShape,
});

export const projectSummarySchema = z
  .strictObject({
    projectId: UUID,
    // Null only for a remote project with no owner organization.
    organizationId: UUID.nullable(),
    remoteId: UUID.nullable(),
    name: z.string().min(1).max(160),
    status: z.enum(['active', 'archived']).nullable(),
    /**
     * Whether tasks run in repository worktrees or with no repository; null
     * when unknown. It decides which task environments a project accepts.
     * Results stored before the field existed parse as null.
     */
    kind: z.enum(['repository', 'no_repository']).nullable().default(null),
    observedAt: IsoDateTime.nullable(),
    source: ReadSource,
  })
  .refine(
    ({ remoteId, organizationId }) =>
      remoteId !== null || organizationId !== null,
    {
      path: ['organizationId'],
      message: 'organizationId is required for cloud projects',
    },
  );
export type ProjectSummary = z.infer<typeof projectSummarySchema>;

export const projectPageSchema = z.strictObject({
  items: z.array(projectSummarySchema).max(100),
  nextCursor: UUID.nullable(),
  ...readMetadataShape,
});

export const projectGetResultSchema = z.strictObject({
  project: projectSummarySchema,
  ...readMetadataShape,
});

export const remoteConnectionSchema = z.enum([
  'active',
  'reconnecting',
  'inactive',
]);
export type RemoteConnection = z.infer<typeof remoteConnectionSchema>;

export const remoteSummarySchema = z.strictObject({
  remoteId: UUID,
  /** Omitted unless the person lets this agent see device names. */
  name: z.string().min(1).max(120).optional(),
  /** Omitted unless the person lets this agent see device names. */
  hostname: z.string().max(255).nullable().optional(),
  appVersion: z.string().max(64).nullable(),
  connection: remoteConnectionSchema,
  observedAt: IsoDateTime.nullable(),
  lastSeenAt: IsoDateTime.nullable(),
  capabilities: z.array(z.string().min(1).max(64)).max(64),
  writable: z.boolean(),
});
export type RemoteSummary = z.infer<typeof remoteSummarySchema>;

export const remotePageSchema = z.strictObject({
  items: z.array(remoteSummarySchema).max(100),
  nextCursor: UUID.nullable(),
  ...readMetadataShape,
});
export type RemotePage = z.infer<typeof remotePageSchema>;

export const remoteGetResultSchema = z.strictObject({
  remote: remoteSummarySchema,
  ...readMetadataShape,
});
export type RemoteGetResult = z.infer<typeof remoteGetResultSchema>;

export const fileSummarySchema = z.strictObject({
  fileId: UUID,
  name: z.string().min(1).max(255),
  kind: z.enum(['file', 'directory']),
  sizeBytes: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable(),
  observedAt: IsoDateTime.nullable(),
});
export type FileSummary = z.infer<typeof fileSummarySchema>;

export const filePageSchema = z.strictObject({
  items: z.array(fileSummarySchema).max(100),
  nextCursor: UUID.nullable(),
  ...readMetadataShape,
});

export const fileReadResultSchema = z
  .strictObject({
    fileId: UUID,
    content: z.string(),
    truncated: z.boolean(),
    ...readMetadataShape,
  })
  .refine(({ content }) => new TextEncoder().encode(content).length <= 49152, {
    path: ['content'],
    message: 'content must be at most 49152 UTF-8 bytes',
  });

export const idempotencyKeySchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[\x20-\x7e]+$/);
export type IdempotencyKey = z.infer<typeof idempotencyKeySchema>;

export const environmentChoiceSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('new_default_base') }),
  z.strictObject({
    kind: z.literal('new_branch'),
    branch: z.string().min(1).max(255),
  }),
  z.strictObject({ kind: z.literal('existing_worktree'), worktreeId: UUID }),
  z.strictObject({ kind: z.literal('no_repository') }),
]);
export type EnvironmentChoice = z.infer<typeof environmentChoiceSchema>;

const portableErrorSchema = z.strictObject({
  code: z.string().min(1).max(64),
  message: z.string().min(1).max(500),
});

export const taskReceiptSchema = z.strictObject({
  receiptId: UUID,
  // project_update and archive extend the contract operation enum.
  operation: z.enum([
    'project_create',
    'project_update',
    'create',
    'send',
    'respond',
    'cancel',
    'archive',
  ]),
  projectId: UUID.nullable(),
  taskId: UUID.nullable(),
  messageId: UUID.nullable(),
  turnId: UUID.nullable(),
  status: z.enum(['accepted', 'completed', 'failed']),
  /** How the source accepted a sent message; present on send receipts. */
  delivery: z.enum(['accepted', 'queued', 'steering']).optional(),
  createdAt: IsoDateTime,
  observedAt: IsoDateTime.nullable(),
  error: portableErrorSchema.nullable(),
});
export type TaskReceipt = z.infer<typeof taskReceiptSchema>;

export const projectCreateInputSchema = z.strictObject({
  organizationId: UUID,
  name: z.string().min(1).max(160),
  idempotencyKey: idempotencyKeySchema,
  repositoryId: UUID.optional(),
  baseBranch: z.string().min(1).max(255).optional(),
});
export type ProjectCreateInput = z.infer<typeof projectCreateInputSchema>;

export const projectCreateResultSchema = z.strictObject({
  project: projectSummarySchema,
  receipt: taskReceiptSchema,
  ...readMetadataShape,
});
export type ProjectCreateResult = z.infer<typeof projectCreateResultSchema>;

export const projectUpdateInputSchema = z
  .strictObject({
    organizationId: UUID,
    projectId: UUID,
    name: z.string().min(1).max(160).optional(),
    description: z.string().max(2000).nullable().optional(),
  })
  .refine(
    ({ name, description }) => name !== undefined || description !== undefined,
    {
      message: 'at least one project field must be provided',
    },
  );
export type ProjectUpdateInput = z.infer<typeof projectUpdateInputSchema>;

export const projectUpdateResultSchema = z.strictObject({
  project: projectSummarySchema,
  receipt: taskReceiptSchema,
});
export type ProjectUpdateResult = z.infer<typeof projectUpdateResultSchema>;

export const taskCreateInputSchema = z.strictObject({
  organizationId: UUID,
  projectId: UUID,
  prompt: z.string().min(1).max(20000),
  environment: environmentChoiceSchema,
  idempotencyKey: idempotencyKeySchema,
  title: z.string().min(1).max(256).optional(),
  model: z.string().min(1).max(128).optional(),
  mode: z.enum(['plan', 'build']).optional(),
});
export type TaskCreateInput = z.infer<typeof taskCreateInputSchema>;

export const taskCreateResultSchema = z.strictObject({
  taskId: UUID,
  turnId: UUID.nullable(),
  status: taskStatusSchema,
  receipt: taskReceiptSchema,
});
export type TaskCreateResult = z.infer<typeof taskCreateResultSchema>;

export const taskSendInputSchema = z.strictObject({
  organizationId: UUID,
  taskId: UUID,
  text: z.string().min(1).max(20000),
  idempotencyKey: idempotencyKeySchema,
  delivery: z.enum(['auto', 'queue', 'steer']).optional(),
});
export type TaskSendInput = z.infer<typeof taskSendInputSchema>;

export const taskSendResultSchema = z.strictObject({
  receipt: taskReceiptSchema,
  delivery: z.enum(['accepted', 'queued', 'steering']),
});
export type TaskSendResult = z.infer<typeof taskSendResultSchema>;

export const taskCancelInputSchema = z.strictObject({
  organizationId: UUID,
  taskId: UUID,
  turnId: UUID,
});
export type TaskCancelInput = z.infer<typeof taskCancelInputSchema>;

export const taskCancelResultSchema = z.strictObject({
  outcome: z.enum(['stop_requested', 'turn_not_active']),
  stopRequested: z.boolean(),
  turnStatus: taskStatusSchema,
  receipt: taskReceiptSchema,
});
export type TaskCancelResult = z.infer<typeof taskCancelResultSchema>;

/** Remote task writes: `remoteId` selects the desktop; no organization input. */
export const remoteTaskCreateInputSchema = z.strictObject({
  remoteId: UUID,
  projectId: UUID,
  prompt: z.string().min(1).max(20000),
  environment: environmentChoiceSchema,
  idempotencyKey: idempotencyKeySchema,
  title: z.string().min(1).max(256).optional(),
  model: z.string().min(1).max(128).optional(),
  mode: z.enum(['plan', 'build']).optional(),
});
export type RemoteTaskCreateInput = z.infer<typeof remoteTaskCreateInputSchema>;

export const remoteTaskSendInputSchema = z.strictObject({
  remoteId: UUID,
  taskId: UUID,
  text: z.string().min(1).max(20000),
  idempotencyKey: idempotencyKeySchema,
  delivery: z.enum(['auto', 'queue', 'steer']).optional(),
});
export type RemoteTaskSendInput = z.infer<typeof remoteTaskSendInputSchema>;

export const remoteTaskRespondInputSchema = z.strictObject({
  remoteId: UUID,
  taskId: UUID,
  questionId: UUID,
  selectedOptionIndexes: z
    .array(z.number().int().min(0).max(99))
    .max(100)
    .refine((indexes) => new Set(indexes).size === indexes.length, {
      message: 'selectedOptionIndexes must be distinct',
    }),
  freeformText: z.string().max(8000).nullable(),
});
export type RemoteTaskRespondInput = z.infer<
  typeof remoteTaskRespondInputSchema
>;

export const taskRespondResultSchema = z.strictObject({
  receipt: taskReceiptSchema,
});
export type TaskRespondResult = z.infer<typeof taskRespondResultSchema>;

export const remoteTaskCancelInputSchema = z.strictObject({
  remoteId: UUID,
  taskId: UUID,
  turnId: UUID,
});
export type RemoteTaskCancelInput = z.infer<typeof remoteTaskCancelInputSchema>;

export const taskArchiveInputSchema = z.strictObject({
  organizationId: UUID,
  taskId: UUID,
});
export type TaskArchiveInput = z.infer<typeof taskArchiveInputSchema>;

export const taskArchiveResultSchema = z.strictObject({
  taskId: UUID,
  archived: z.literal(true),
  receipt: taskReceiptSchema,
});
export type TaskArchiveResult = z.infer<typeof taskArchiveResultSchema>;

// Remote extended reads (phase 18). Content fields are untrusted desktop data.

function withinUtf8Bytes(limit: number) {
  return (value: string): boolean =>
    new TextEncoder().encode(value).length <= limit;
}

export const planSummarySchema = z.strictObject({
  planId: UUID,
  projectId: UUID,
  worktreeId: UUID,
  title: z.string().min(1).max(300),
  status: z.string().min(1).max(64),
  reviewStatus: z.string().min(1).max(64).nullable(),
  updatedAt: IsoDateTime.nullable(),
});
export type PlanSummary = z.infer<typeof planSummarySchema>;

export const planPageSchema = z.strictObject({
  items: z.array(planSummarySchema).max(100),
  nextCursor: UUID.nullable(),
  ...readMetadataShape,
});

export const planDetailSchema = planSummarySchema.extend({
  content: z.string().refine(withinUtf8Bytes(49152), {
    message: 'content must be at most 49152 UTF-8 bytes',
  }),
  truncated: z.boolean(),
  revisionNumber: z.number().int().min(0).nullable(),
  approvedAt: IsoDateTime.nullable(),
  dismissedAt: IsoDateTime.nullable(),
});
export type PlanDetail = z.infer<typeof planDetailSchema>;

export const planGetResultSchema = z.strictObject({
  plan: planDetailSchema,
  ...readMetadataShape,
});

export const diffSourceSchema = z.enum([
  'uncommitted',
  'committed',
  'combined',
]);
export type DiffSource = z.infer<typeof diffSourceSchema>;

export const diffFileSchema = z.strictObject({
  path: z.string().min(1).max(1024),
  previousPath: z.string().min(1).max(1024).nullable(),
  status: z.string().min(1).max(32),
  insertions: z.number().int().min(0).nullable(),
  deletions: z.number().int().min(0).nullable(),
});
export type DiffFile = z.infer<typeof diffFileSchema>;

export const diffResultSchema = z.strictObject({
  projectId: UUID,
  worktreeId: UUID,
  diffSource: diffSourceSchema,
  files: z.array(diffFileSchema).max(200),
  filesTruncated: z.boolean(),
  patch: z.string().refine(withinUtf8Bytes(32768), {
    message: 'patch must be at most 32768 UTF-8 bytes',
  }),
  patchTruncated: z.boolean(),
  rangeLabel: z.string().max(255).nullable(),
  ...readMetadataShape,
});
export type DiffResult = z.infer<typeof diffResultSchema>;

export const pullRequestSummarySchema = z.strictObject({
  number: z.number().int().positive().nullable(),
  url: z.url().max(2048).nullable(),
  title: z.string().max(300).nullable(),
  state: z.string().max(32).nullable(),
  baseBranch: z.string().max(255).nullable(),
  headBranch: z.string().max(255).nullable(),
  checkStatus: z
    .enum(['passing', 'failing', 'pending', 'neutral', 'none'])
    .nullable(),
  reviewStatus: z
    .enum(['approved', 'changes-requested', 'pending', 'none'])
    .nullable(),
  hasConflicts: z.boolean().nullable(),
  mergeReady: z.boolean().nullable(),
  commentCount: z.number().int().min(0).nullable(),
  updatedAt: IsoDateTime.nullable(),
});
export type PullRequestSummary = z.infer<typeof pullRequestSummarySchema>;

export const pullRequestResultSchema = z.strictObject({
  projectId: UUID,
  worktreeId: UUID,
  // Null when the worktree has no pull request.
  pullRequest: pullRequestSummarySchema.nullable(),
  ...readMetadataShape,
});
export type PullRequestResult = z.infer<typeof pullRequestResultSchema>;

export const pipelineRunRefSchema = z.strictObject({
  runId: UUID,
  status: z.string().min(1).max(32),
  startedAt: IsoDateTime.nullable(),
  finishedAt: IsoDateTime.nullable(),
});
export type PipelineRunRef = z.infer<typeof pipelineRunRefSchema>;

export const pipelineSummarySchema = z.strictObject({
  pipelineId: UUID,
  projectId: UUID,
  // The worktree the desktop listed from, even when the caller named none.
  worktreeId: UUID,
  name: z.string().min(1).max(200),
  description: z.string().max(1000).nullable(),
  origin: z.enum(['bundled', 'user', 'project', 'shared']).nullable(),
  triggerTypes: z
    .array(z.enum(['dispatch', 'plan_ready', 'task_ready']))
    .max(3),
  // Only known when the call names a worktree.
  latestRun: pipelineRunRefSchema.nullable(),
});
export type PipelineSummary = z.infer<typeof pipelineSummarySchema>;

export const pipelinePageSchema = z.strictObject({
  items: z.array(pipelineSummarySchema).max(100),
  nextCursor: UUID.nullable(),
  ...readMetadataShape,
});

export const pipelineRunSchema = z.strictObject({
  runId: UUID,
  pipelineId: UUID,
  projectId: UUID,
  worktreeId: UUID,
  pipelineName: z.string().min(1).max(200).nullable(),
  status: z.string().min(1).max(32),
  startedAt: IsoDateTime.nullable(),
  finishedAt: IsoDateTime.nullable(),
  progress: z
    .strictObject({
      completedSteps: z.number().int().min(0),
      totalSteps: z.number().int().min(0),
    })
    .nullable(),
  outputTail: z
    .string()
    .refine(withinUtf8Bytes(8192), {
      message: 'outputTail must be at most 8192 UTF-8 bytes',
    })
    .nullable(),
  outputTruncated: z.boolean(),
});
export type PipelineRun = z.infer<typeof pipelineRunSchema>;

export const pipelineRunGetResultSchema = z.strictObject({
  run: pipelineRunSchema,
  ...readMetadataShape,
});

export const remoteInventoryKindSchema = z.enum([
  'plugin',
  'skill',
  'collection',
  'mcp_server',
]);
export type RemoteInventoryKind = z.infer<typeof remoteInventoryKindSchema>;

export const remoteInventoryItemSchema = z.strictObject({
  itemId: UUID,
  kind: remoteInventoryKindSchema,
  name: z.string().min(1).max(255),
  version: z.string().max(128).nullable(),
});
export type RemoteInventoryItem = z.infer<typeof remoteInventoryItemSchema>;

export const remoteInventoryResultSchema = z.strictObject({
  items: z.array(remoteInventoryItemSchema).max(100),
  nextCursor: UUID.nullable(),
  ...readMetadataShape,
});
export type RemoteInventoryResult = z.infer<typeof remoteInventoryResultSchema>;
