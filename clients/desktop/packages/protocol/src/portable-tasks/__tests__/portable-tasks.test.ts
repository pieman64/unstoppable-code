import { z } from 'zod';
import {
  environmentChoiceSchema,
  filePageSchema,
  fileReadResultSchema,
  fileSummarySchema,
  idempotencyKeySchema,
  projectGetResultSchema,
  projectPageSchema,
  projectCreateInputSchema,
  projectCreateResultSchema,
  projectSummarySchema,
  projectUpdateInputSchema,
  projectUpdateResultSchema,
  readMetadataShape,
  remoteGetResultSchema,
  remoteTaskCancelInputSchema,
  remoteTaskCreateInputSchema,
  remoteTaskRespondInputSchema,
  remoteTaskSendInputSchema,
  taskRespondResultSchema,
  remotePageSchema,
  remoteSummarySchema,
  taskArchiveInputSchema,
  taskArchiveResultSchema,
  taskCancelInputSchema,
  taskCancelResultSchema,
  taskCreateInputSchema,
  taskCreateResultSchema,
  taskEnvironmentSchema,
  taskGetResultSchema,
  taskLinksSchema,
  taskMessageSchema,
  taskMessagesPageSchema,
  taskOriginSchema,
  taskReceiptSchema,
  taskSendInputSchema,
  taskSendResultSchema,
  taskPageSchema,
  taskQuestionSchema,
  taskStatusSchema,
  taskSummarySchema,
  taskTurnStatusSchema,
  taskTurnSummarySchema,
  taskWaitResultSchema,
} from '../index';

const uuid = '123e4567-e89b-12d3-a456-426614174000';
const otherUuid = '223e4567-e89b-12d3-a456-426614174001';
const thirdUuid = '323e4567-e89b-12d3-a456-426614174002';
const timestamp = '2026-10-16T09:00:00Z';

const metadata = {
  source: 'live',
  observationKind: 'authority',
  observedAt: timestamp,
  repliedAt: null,
};

const question = {
  questionId: uuid,
  prompt: 'Choose a direction',
  options: [
    { optionIndex: 0, label: 'Continue' },
    { optionIndex: 1, label: 'Stop' },
  ],
  allowOther: false,
  multiSelect: false,
};

const cloudEnvironment = { kind: 'cloud_sandbox', sandboxId: otherUuid };
const remoteWorktreeEnvironment = {
  kind: 'remote_worktree',
  remoteId: otherUuid,
  worktreeId: thirdUuid,
  branch: 'feature/portable-tasks',
};
const remoteNoRepositoryEnvironment = {
  kind: 'remote_no_repository',
  remoteId: otherUuid,
};

const taskLinks = {
  taskUrl: `https://canopy.example/tasks/${uuid}`,
  projectId: otherUuid,
  remoteId: null,
  worktreeId: null,
};

const turn = {
  turnId: thirdUuid,
  status: 'complete',
  startedAt: timestamp,
  finalMessageSummary: 'Finished the task.',
  outcome: 'complete',
  endedAt: timestamp,
  environment: cloudEnvironment,
};

const task = {
  taskId: uuid,
  projectId: otherUuid,
  organizationId: thirdUuid,
  remoteId: null,
  title: 'Portable read contracts',
  status: 'idle',
  stopRequested: false,
  pendingQuestion: question,
  lastTurn: turn,
  origin: {
    kind: 'external_agent',
    connectionId: uuid,
    clientName: 'Review helper',
    verified: true,
    userId: otherUuid,
  },
  environmentMode: 'cloud',
  environment: cloudEnvironment,
  observedAt: timestamp,
  links: taskLinks,
  source: 'live',
  observationKind: 'authority',
};

const taskMessage = {
  kind: 'message',
  messageId: uuid,
  turnId: thirdUuid,
  role: 'agent',
  text: 'Task update.',
  createdAt: timestamp,
  toolCall: null,
  truncated: false,
  provenance: null,
};

const toolCall = {
  name: 'search_files',
  status: 'complete',
  argumentsSummary: 'pattern: *.ts',
  resultSummary: 'Three files found.',
};

const project = {
  projectId: otherUuid,
  organizationId: thirdUuid,
  remoteId: null,
  name: 'Example project',
  status: 'active',
  kind: 'repository',
  observedAt: timestamp,
  source: 'live',
};

const file = {
  fileId: uuid,
  name: 'README.md',
  kind: 'file',
  sizeBytes: 24,
  observedAt: timestamp,
};

const fileRead = {
  fileId: uuid,
  content: 'Portable task contracts.\n',
  truncated: false,
  ...metadata,
};

const receipt = {
  receiptId: uuid,
  operation: 'project_create',
  projectId: otherUuid,
  taskId: null,
  messageId: null,
  turnId: null,
  status: 'completed',
  createdAt: timestamp,
  observedAt: timestamp,
  error: null,
};

type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };
type PathSegment = string | number;

type SchemaExample = {
  name: string;
  schema: z.ZodType;
  value: JsonValue;
};

const schemaExamples: SchemaExample[] = [
  { name: 'idempotency key', schema: idempotencyKeySchema, value: 'write-1' },
  {
    name: 'environment choice',
    schema: environmentChoiceSchema,
    value: { kind: 'new_default_base' },
  },
  { name: 'task receipt', schema: taskReceiptSchema, value: receipt },
  {
    name: 'project create input',
    schema: projectCreateInputSchema,
    value: {
      organizationId: thirdUuid,
      name: 'New project',
      idempotencyKey: 'project-create-1',
      repositoryId: otherUuid,
      baseBranch: 'main',
    },
  },
  {
    name: 'project create result',
    schema: projectCreateResultSchema,
    value: { project, receipt, ...metadata },
  },
  {
    name: 'project update input',
    schema: projectUpdateInputSchema,
    value: {
      organizationId: thirdUuid,
      projectId: otherUuid,
      description: null,
    },
  },
  {
    name: 'project update result',
    schema: projectUpdateResultSchema,
    value: { project, receipt: { ...receipt, operation: 'project_update' } },
  },
  {
    name: 'task create input',
    schema: taskCreateInputSchema,
    value: {
      organizationId: thirdUuid,
      projectId: otherUuid,
      prompt: 'Build this feature.',
      environment: { kind: 'new_default_base' },
      idempotencyKey: 'task-create-1',
      title: 'Feature task',
      model: 'model-name',
      mode: 'build',
    },
  },
  {
    name: 'task create result',
    schema: taskCreateResultSchema,
    value: {
      taskId: uuid,
      turnId: otherUuid,
      status: 'queued',
      receipt: {
        ...receipt,
        operation: 'create',
        taskId: uuid,
        turnId: otherUuid,
      },
    },
  },
  {
    name: 'task send input',
    schema: taskSendInputSchema,
    value: {
      organizationId: thirdUuid,
      taskId: uuid,
      text: 'Continue this task.',
      idempotencyKey: 'task-send-1',
      delivery: 'auto',
    },
  },
  {
    name: 'task send result',
    schema: taskSendResultSchema,
    value: {
      receipt: { ...receipt, operation: 'send', taskId: uuid },
      delivery: 'accepted',
    },
  },
  {
    name: 'task cancel input',
    schema: taskCancelInputSchema,
    value: { organizationId: thirdUuid, taskId: uuid, turnId: otherUuid },
  },
  {
    name: 'task cancel result',
    schema: taskCancelResultSchema,
    value: {
      outcome: 'stop_requested',
      stopRequested: true,
      turnStatus: 'running',
      receipt: {
        ...receipt,
        operation: 'cancel',
        taskId: uuid,
        turnId: otherUuid,
        status: 'accepted',
        observedAt: null,
      },
    },
  },
  {
    name: 'task archive input',
    schema: taskArchiveInputSchema,
    value: { organizationId: thirdUuid, taskId: uuid },
  },
  {
    name: 'task archive result',
    schema: taskArchiveResultSchema,
    value: {
      taskId: uuid,
      archived: true,
      receipt: { ...receipt, operation: 'archive', taskId: uuid },
    },
  },
  { name: 'task status', schema: taskStatusSchema, value: 'queued' },
  { name: 'task turn status', schema: taskTurnStatusSchema, value: 'running' },
  { name: 'task origin', schema: taskOriginSchema, value: task.origin },
  {
    name: 'task environment',
    schema: taskEnvironmentSchema,
    value: cloudEnvironment,
  },
  { name: 'task links', schema: taskLinksSchema, value: taskLinks },
  { name: 'task question', schema: taskQuestionSchema, value: question },
  { name: 'task turn summary', schema: taskTurnSummarySchema, value: turn },
  { name: 'task summary', schema: taskSummarySchema, value: task },
  {
    name: 'task page',
    schema: taskPageSchema,
    value: { items: [task], nextCursor: null, ...metadata },
  },
  {
    name: 'task get result',
    schema: taskGetResultSchema,
    value: { task, ...metadata },
  },
  { name: 'task message', schema: taskMessageSchema, value: taskMessage },
  {
    name: 'task messages page',
    schema: taskMessagesPageSchema,
    value: { items: [taskMessage], nextCursor: null, ...metadata },
  },
  {
    name: 'task wait result',
    schema: taskWaitResultSchema,
    value: { task, changed: true, timedOut: false, ...metadata },
  },
  { name: 'project summary', schema: projectSummarySchema, value: project },
  {
    name: 'project page',
    schema: projectPageSchema,
    value: { items: [project], nextCursor: null, ...metadata },
  },
  {
    name: 'project get result',
    schema: projectGetResultSchema,
    value: { project, ...metadata },
  },
  { name: 'file summary', schema: fileSummarySchema, value: file },
  {
    name: 'file page',
    schema: filePageSchema,
    value: { items: [file], nextCursor: null, ...metadata },
  },
  { name: 'file read result', schema: fileReadResultSchema, value: fileRead },
];

const schemaVariants: SchemaExample[] = [
  {
    name: 'new branch environment choice',
    schema: environmentChoiceSchema,
    value: { kind: 'new_branch', branch: 'feature/portable-tasks' },
  },
  {
    name: 'existing worktree environment choice',
    schema: environmentChoiceSchema,
    value: { kind: 'existing_worktree', worktreeId: otherUuid },
  },
  {
    name: 'no-repository environment choice',
    schema: environmentChoiceSchema,
    value: { kind: 'no_repository' },
  },
  {
    name: 'user task origin',
    schema: taskOriginSchema,
    value: { kind: 'user', userId: uuid },
  },
  {
    name: 'automation task origin',
    schema: taskOriginSchema,
    value: { kind: 'automation', name: 'Nightly review' },
  },
  {
    name: 'remote worktree environment',
    schema: taskEnvironmentSchema,
    value: remoteWorktreeEnvironment,
  },
  {
    name: 'remote no-repository environment',
    schema: taskEnvironmentSchema,
    value: remoteNoRepositoryEnvironment,
  },
  {
    name: 'tool-call message',
    schema: taskMessageSchema,
    value: { ...taskMessage, kind: 'tool_call', toolCall },
  },
];

const allSchemaExamples = [...schemaExamples, ...schemaVariants];

function objectPaths(
  value: JsonValue,
  path: PathSegment[] = [],
): PathSegment[][] {
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => objectPaths(item, [...path, index]));
  }
  if (value !== null && typeof value === 'object') {
    return [
      path,
      ...Object.entries(value).flatMap(([key, child]) =>
        objectPaths(child, [...path, key]),
      ),
    ];
  }
  return [];
}

function injectUnknownKey(value: JsonValue, path: PathSegment[]): JsonValue {
  if (path.length === 0) {
    if (value === null || Array.isArray(value) || typeof value !== 'object') {
      throw new Error('The selected path must point to an object');
    }
    return { ...value, unknownKey: true };
  }

  const [segment, ...remainingPath] = path;
  if (segment === undefined) {
    throw new Error('The selected path is empty');
  }
  if (typeof segment === 'number') {
    if (!Array.isArray(value)) {
      throw new Error('The selected path expected an array');
    }
    return value.map((item, index) =>
      index === segment ? injectUnknownKey(item, remainingPath) : item,
    );
  }
  if (value === null || Array.isArray(value) || typeof value !== 'object') {
    throw new Error('The selected path expected an object');
  }
  const child = value[segment];
  if (child === undefined) {
    throw new Error('The selected property does not exist');
  }
  return { ...value, [segment]: injectUnknownKey(child, remainingPath) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function expectClosedObjectSchemas(value: unknown): void {
  if (Array.isArray(value)) {
    value.forEach(expectClosedObjectSchemas);
    return;
  }
  if (!isRecord(value)) {
    return;
  }
  if (value.type === 'object') {
    expect(value.additionalProperties).toBe(false);
  }
  Object.values(value).forEach(expectClosedObjectSchemas);
}

describe('portable task contracts', () => {
  it.each(schemaExamples)('parses a valid $name', ({ schema, value }) => {
    expect(schema.parse(value)).toEqual(value);
  });

  it.each(schemaVariants)('parses the $name variant', ({ schema, value }) => {
    expect(schema.parse(value)).toEqual(value);
  });

  it.each(allSchemaExamples)(
    'rejects unknown keys at every object level in $name',
    ({ schema, value }) => {
      for (const path of objectPaths(value)) {
        expect(schema.safeParse(injectUnknownKey(value, path)).success).toBe(
          false,
        );
      }
    },
  );

  it('declares the exact lifecycle and read-metadata enum values', () => {
    expect(taskStatusSchema.options).toEqual([
      'queued',
      'running',
      'waiting_for_input',
      'waiting_for_approval',
      'idle',
      'failed',
      'stopped',
      'archived',
    ]);
    expect(taskTurnStatusSchema.options).toEqual([
      'queued',
      'running',
      'waiting_for_input',
      'waiting_for_approval',
      'complete',
      'failed',
      'cancelled',
    ]);
    expect(readMetadataShape.source.options).toEqual(['cached', 'live']);
    expect(readMetadataShape.observationKind.options).toEqual([
      'authority',
      'server_held',
      'desktop_rebuilt',
      'desktop_rpc',
      'desktop_cache',
      'relay_registry',
    ]);
  });

  it('enforces task bounds, option indexes, and canonical identifiers', () => {
    expect(taskSummarySchema.safeParse({ ...task, title: '' }).success).toBe(
      false,
    );
    expect(
      taskSummarySchema.safeParse({ ...task, title: 't'.repeat(257) }).success,
    ).toBe(false);
    expect(
      taskMessageSchema.safeParse({ ...taskMessage, text: 'x'.repeat(20001) })
        .success,
    ).toBe(false);
    expect(
      taskQuestionSchema.safeParse({
        ...question,
        options: Array.from({ length: 101 }, (_, optionIndex) => ({
          optionIndex,
          label: 'Choice',
        })),
      }).success,
    ).toBe(false);
    expect(
      taskQuestionSchema.safeParse({
        ...question,
        options: [
          { optionIndex: 1, label: 'First' },
          { optionIndex: 1, label: 'Second' },
        ],
      }).success,
    ).toBe(false);
    expect(
      taskOriginSchema.safeParse({
        kind: 'user',
        userId: '123E4567-E89B-12D3-A456-426614174000',
      }).success,
    ).toBe(false);
    expect(
      taskLinksSchema.safeParse({ ...taskLinks, taskUrl: 'http://example.com' })
        .success,
    ).toBe(false);
  });

  it('enforces write bounds and printable ASCII idempotency keys', () => {
    expect(idempotencyKeySchema.safeParse(' ').success).toBe(true);
    expect(idempotencyKeySchema.safeParse('k'.repeat(128)).success).toBe(true);
    for (const invalidKey of [
      '',
      'k'.repeat(129),
      'contains\nnewline',
      'contains\u007fdelete',
      'café',
    ]) {
      expect(idempotencyKeySchema.safeParse(invalidKey).success).toBe(false);
    }
    expect(
      environmentChoiceSchema.safeParse({
        kind: 'new_branch',
        branch: 'b'.repeat(256),
      }).success,
    ).toBe(false);
    expect(
      projectCreateInputSchema.safeParse({
        organizationId: uuid,
        name: '',
        idempotencyKey: 'k',
      }).success,
    ).toBe(false);
    expect(
      taskCreateInputSchema.safeParse({
        organizationId: uuid,
        projectId: otherUuid,
        prompt: 'p'.repeat(20001),
        environment: { kind: 'no_repository' },
        idempotencyKey: 'k',
      }).success,
    ).toBe(false);
    expect(
      taskReceiptSchema.safeParse({
        ...receipt,
        error: { code: 'e'.repeat(65), message: 'failure' },
      }).success,
    ).toBe(false);
  });

  it('requires at least one project update field while allowing description clearing', () => {
    expect(
      projectUpdateInputSchema.safeParse({
        organizationId: uuid,
        projectId: otherUuid,
      }).success,
    ).toBe(false);
    expect(
      projectUpdateInputSchema.safeParse({
        organizationId: uuid,
        projectId: otherUuid,
        description: null,
      }).success,
    ).toBe(true);
    expect(
      projectUpdateInputSchema.safeParse({
        organizationId: uuid,
        projectId: otherUuid,
        description: 'd'.repeat(2001),
      }).success,
    ).toBe(false);
  });

  it('requires task remote identity and mode to agree', () => {
    expect(
      taskSummarySchema.safeParse({
        ...task,
        environmentMode: 'remote',
        remoteId: otherUuid,
        environment: remoteNoRepositoryEnvironment,
        links: { ...taskLinks, remoteId: otherUuid },
      }).success,
    ).toBe(true);
    expect(
      taskSummarySchema.safeParse({ ...task, environmentMode: 'remote' })
        .success,
    ).toBe(false);
    expect(
      taskSummarySchema.safeParse({ ...task, remoteId: otherUuid }).success,
    ).toBe(false);
  });

  it('requires tool-call summaries exactly for tool_call messages', () => {
    expect(
      taskMessageSchema.safeParse({
        ...taskMessage,
        kind: 'tool_call',
        toolCall,
      }).success,
    ).toBe(true);
    expect(
      taskMessageSchema.safeParse({ ...taskMessage, toolCall }).success,
    ).toBe(false);
    expect(
      taskMessageSchema.safeParse({ ...taskMessage, kind: 'tool_call' })
        .success,
    ).toBe(false);
  });

  it('limits file content by UTF-8 bytes, including multibyte text', () => {
    const content = `${'é'.repeat(24576)}a`;
    expect(new TextEncoder().encode(content).length).toBe(49153);
    expect(
      fileReadResultSchema.safeParse({ ...fileRead, content }).success,
    ).toBe(false);
  });

  it.each(allSchemaExamples)(
    'converts $name to a closed draft 2020-12 input schema',
    ({ schema }) => {
      const jsonSchema = z.toJSONSchema(schema, {
        target: 'draft-2020-12',
        io: 'input',
      });
      expectClosedObjectSchemas(jsonSchema);
    },
  );

  it('requires organizationId for cloud rows and allows null only for remote rows', () => {
    expect(
      projectSummarySchema.safeParse({ ...project, organizationId: null })
        .success,
    ).toBe(false);
    expect(
      projectSummarySchema.safeParse({
        ...project,
        organizationId: null,
        remoteId: uuid,
      }).success,
    ).toBe(true);
    expect(
      taskSummarySchema.safeParse({ ...task, organizationId: null }).success,
    ).toBe(false);
  });

  it('bounds remote summaries and pages', () => {
    const remote = {
      remoteId: uuid,
      name: 'Studio Mac',
      hostname: null,
      appVersion: '1.2.3',
      connection: 'reconnecting',
      observedAt: null,
      lastSeenAt: timestamp,
      capabilities: ['state.refresh'],
      writable: false,
    };
    expect(remoteSummarySchema.safeParse(remote).success).toBe(true);
    expect(
      remoteSummarySchema.safeParse({ ...remote, connection: 'pending' })
        .success,
    ).toBe(false);
    expect(remoteSummarySchema.safeParse({ ...remote, name: '' }).success).toBe(
      false,
    );
    const metadata = {
      source: 'cached',
      observationKind: 'relay_registry',
      observedAt: null,
      repliedAt: null,
    };
    expect(
      remotePageSchema.safeParse({
        items: [remote],
        nextCursor: null,
        ...metadata,
      }).success,
    ).toBe(true);
    expect(
      remoteGetResultSchema.safeParse({ remote, ...metadata, extra: true })
        .success,
    ).toBe(false);
  });
});

describe('remote task write contracts', () => {
  const sender = {
    kind: 'external_agent',
    connectionId: uuid,
    clientName: 'Cursor',
    verified: false,
    userId: otherUuid,
  };

  it('accepts an external-agent provenance marker on task messages', () => {
    expect(
      taskMessageSchema.safeParse({ ...taskMessage, provenance: sender })
        .success,
    ).toBe(true);
    expect(
      taskMessageSchema.safeParse({
        ...taskMessage,
        provenance: { ...sender, kind: 'user' },
      }).success,
    ).toBe(false);
  });

  it('records respond receipts and send delivery', () => {
    expect(
      taskReceiptSchema.safeParse({ ...receipt, operation: 'respond' }).success,
    ).toBe(true);
    expect(
      taskReceiptSchema.safeParse({ ...receipt, delivery: 'queued' }).success,
    ).toBe(true);
    expect(
      taskRespondResultSchema.safeParse({
        receipt: { ...receipt, operation: 'respond' },
      }).success,
    ).toBe(true);
  });

  it('keys remote writes by remoteId instead of an organization', () => {
    const create = {
      remoteId: uuid,
      projectId: otherUuid,
      prompt: 'Fix the build.',
      environment: { kind: 'new_default_base' },
      idempotencyKey: 'create-1',
    };
    expect(remoteTaskCreateInputSchema.safeParse(create).success).toBe(true);
    expect(
      remoteTaskCreateInputSchema.safeParse({
        ...create,
        organizationId: uuid,
      }).success,
    ).toBe(false);
    expect(
      remoteTaskSendInputSchema.safeParse({
        remoteId: uuid,
        taskId: otherUuid,
        text: 'Continue.',
        idempotencyKey: 'send-1',
      }).success,
    ).toBe(true);
    expect(
      remoteTaskCancelInputSchema.safeParse({
        remoteId: uuid,
        taskId: otherUuid,
        turnId: thirdUuid,
      }).success,
    ).toBe(true);
  });

  it('bounds respond answers and rejects an idempotency key', () => {
    const respond = {
      remoteId: uuid,
      taskId: otherUuid,
      questionId: thirdUuid,
      selectedOptionIndexes: [0, 2],
      freeformText: null,
    };
    expect(remoteTaskRespondInputSchema.safeParse(respond).success).toBe(true);
    for (const invalid of [
      { ...respond, selectedOptionIndexes: [1, 1] },
      { ...respond, selectedOptionIndexes: [100] },
      { ...respond, freeformText: 'x'.repeat(8001) },
      { ...respond, idempotencyKey: 'respond-1' },
    ]) {
      expect(remoteTaskRespondInputSchema.safeParse(invalid).success).toBe(
        false,
      );
    }
  });
});
