import { z } from 'zod';

import {
  CanopyQueryRequestMetadataSchema,
  CanopyRequestMetadataSchema,
  CanopyWorkspaceScopeSchema,
} from '../common';
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
  CanopyJsonValueSchema,
  CanopyKeyedRetryDirectiveSchema,
  CanopyQueryRetryDirectiveSchema,
  CanopyRetryDirectiveSchema,
} from '../errors';

const ID = z.string().min(1).max(512);

export const WORKER_TERMINAL_GRANTS = {
  read: 'worker.terminal.read',
  write: 'worker.terminal.write',
} as const;

export const WORKER_TERMINAL_STATES = [
  'starting',
  'running',
  'exited',
  'killed',
  'released',
] as const;

export type WorkerTerminalState = (typeof WORKER_TERMINAL_STATES)[number];

export const WORKER_TERMINAL_PROFILE_IDS = [
  'default',
  'zsh',
  'bash',
  'cmd',
  'powershell',
  'git-bash',
] as const;

export const WORKER_TERMINAL_ERROR_CODES = [
  'worker.terminal.invalidState',
  'worker.terminal.revisionConflict',
  'worker.terminal.notFound',
] as const;

export type WorkerTerminalErrorCode =
  (typeof WORKER_TERMINAL_ERROR_CODES)[number];

const PROFILE_ID = z.enum(WORKER_TERMINAL_PROFILE_IDS).nullable();
const INITIAL_COMMAND = z.string().min(1).max(4000).nullable();

/** A terminal as `get`, `list`, `kill` and `resize` describe it. */
const TerminalFields = {
  terminalId: ID,
  scope: CanopyWorkspaceScopeSchema,
  state: z.enum(WORKER_TERMINAL_STATES),
  cwdRootId: ID,
  cwdRelativePath: z.string(),
  cols: z.number().int().min(1),
  rows: z.number().int().min(1),
  exitCode: z.number().int().nullable(),
  signal: z.string().nullable(),
  outputOffset: z.number().int().min(0),
};

export const WorkerTerminalSchema = z
  .object(TerminalFields)
  .catchall(CanopyJsonValueSchema);

export type WorkerTerminal = z.output<typeof WorkerTerminalSchema>;

export const WorkerTerminalCreateParamsSchema = z.strictObject({
  scope: CanopyWorkspaceScopeSchema,
  cwdRootId: ID,
  cwdRelativePath: z.string(),
  shell: z.string().nullable().optional(),
  args: z.array(z.string()).optional(),
  env: z.object({}).catchall(CanopyJsonValueSchema).optional(),
  cols: z.number().int().min(1).max(1000),
  rows: z.number().int().min(1).max(1000),
  kind: z.enum(['interactive', 'auth', 'managed', 'preset']),
  _meta: CanopyRequestMetadataSchema.extend({ idempotencyKey: ID }),
  profileId: PROFILE_ID.optional(),
  initialCommand: INITIAL_COMMAND.optional(),
});

export type WorkerTerminalCreateParams = z.output<
  typeof WorkerTerminalCreateParamsSchema
>;

export const WorkerTerminalCreateResultSchema = z
  .object({
    ...TerminalFields,
    profileId: PROFILE_ID,
    initialCommand: INITIAL_COMMAND,
  })
  .catchall(CanopyJsonValueSchema);

export type WorkerTerminalCreateResult = z.output<
  typeof WorkerTerminalCreateResultSchema
>;

/** The params of the operations that name one terminal. */
const TerminalTarget = {
  scope: CanopyWorkspaceScopeSchema.optional(),
  terminalId: ID,
};

export const WorkerTerminalGetParamsSchema = z.strictObject({
  ...TerminalTarget,
});

export type WorkerTerminalGetParams = z.output<
  typeof WorkerTerminalGetParamsSchema
>;

export const WorkerTerminalListParamsSchema = z.strictObject({
  scope: CanopyWorkspaceScopeSchema.optional(),
  states: z.array(z.enum(WORKER_TERMINAL_STATES)).max(32).optional(),
  cursor: z.string().min(1).max(2048).optional(),
  pageSize: z.number().int().min(1).max(500).default(100),
});

export type WorkerTerminalListParams = z.output<
  typeof WorkerTerminalListParamsSchema
>;

export const WorkerTerminalListResultSchema = z
  .object({
    items: z.array(WorkerTerminalSchema),
    nextCursor: z.string().max(2048).nullable(),
    revision: z.number().int().min(0),
  })
  .catchall(CanopyJsonValueSchema);

export type WorkerTerminalListResult = z.output<
  typeof WorkerTerminalListResultSchema
>;

export const WorkerTerminalKillParamsSchema = z.strictObject({
  ...TerminalTarget,
  signal: z
    .string()
    .regex(/^SIG[A-Z0-9]+$/)
    .optional(),
  graceMs: z.number().int().min(0).max(60_000).optional(),
});

export type WorkerTerminalKillParams = z.output<
  typeof WorkerTerminalKillParamsSchema
>;

export const WorkerTerminalReleaseParamsSchema = z.strictObject({
  ...TerminalTarget,
});

export type WorkerTerminalReleaseParams = z.output<
  typeof WorkerTerminalReleaseParamsSchema
>;

export const WorkerTerminalReleaseResultSchema = z
  .object({ released: z.boolean() })
  .catchall(CanopyJsonValueSchema);

export type WorkerTerminalReleaseResult = z.output<
  typeof WorkerTerminalReleaseResultSchema
>;

export const WORKER_TERMINAL_ENCODINGS = ['utf8', 'base64'] as const;

export type WorkerTerminalEncoding = (typeof WORKER_TERMINAL_ENCODINGS)[number];

/**
 * The exit signal a terminal reports when the process hosting it ended
 * under it (CAN-5088). The terminal is gone; restoring it recreates its
 * shell from its persisted record. It is the shared `connection-lost`
 * signal (`TERMINAL_CONNECTION_LOST_SIGNAL`), so every client already
 * explains it and offers a restart.
 */
export const WORKER_TERMINAL_LOST_SIGNAL = 'connection-lost';

/** The largest input one `worker.terminal.write` carries, before encoding. */
export const WORKER_TERMINAL_WRITE_MAX_BYTES = 1024 * 1024;

export const WorkerTerminalAttachParamsSchema = z.strictObject({
  ...TerminalTarget,
  fromOffset: z.number().int().min(0),
  maxReplayBytes: z.number().int().min(0).max(1_048_576).optional(),
  cursor: CanopyStreamCursorSchema.nullable().optional(),
  _meta: CanopyQueryRequestMetadataSchema.optional(),
});

export type WorkerTerminalAttachParams = z.output<
  typeof WorkerTerminalAttachParamsSchema
>;

export const WorkerTerminalAttachOpenResultSchema = z
  .object({
    subscriptionId: ID,
    acceptedCursor: CanopyStreamCursorSchema.nullable(),
  })
  .catchall(CanopyJsonValueSchema);

export const WorkerTerminalExitSchema = z
  .object({
    code: z.number().int().nullable(),
    signal: z.string().max(256).nullable(),
  })
  .catchall(CanopyJsonValueSchema);

export type WorkerTerminalExit = z.output<typeof WorkerTerminalExitSchema>;

/**
 * One delivery: output bytes from `fromOffset` to `toOffset`, a change of
 * the foreground process (`running`, with no output; local workers only), or,
 * last and on its own, the terminal's `exit` after every byte it wrote.
 */
export const WorkerTerminalAttachItemSchema = z
  .object({
    terminalId: ID,
    fromOffset: z.number().int().min(0),
    toOffset: z.number().int().min(0),
    data: z.string(),
    encoding: z.enum(WORKER_TERMINAL_ENCODINGS),
    truncatedBefore: z.boolean(),
    exit: WorkerTerminalExitSchema.nullable(),
    running: z
      .strictObject({
        running: z.boolean(),
        processName: z.string().max(4096).nullable(),
        /** The command became idle because its user interrupted it. */
        interruptedByUser: z.boolean().optional(),
      })
      .optional(),
  })
  .catchall(CanopyJsonValueSchema);

export type WorkerTerminalAttachItem = z.output<
  typeof WorkerTerminalAttachItemSchema
>;

export const WorkerTerminalAttachErrorSchema = CanopyErrorPayloadSchema.extend({
  code: z
    .enum([...WORKER_TERMINAL_ERROR_CODES, 'worker.terminal.snapshotRequired'])
    .optional(),
  retry: CanopyQueryRetryDirectiveSchema,
});

export const WorkerTerminalAttachEndSchema = CanopyStreamEndSchema.extend({
  error: WorkerTerminalAttachErrorSchema.nullable(),
});

export const WorkerTerminalWriteParamsSchema = z.strictObject({
  ...TerminalTarget,
  input: z.string().max(WORKER_TERMINAL_WRITE_MAX_BYTES),
  encoding: z.enum(WORKER_TERMINAL_ENCODINGS),
});

export type WorkerTerminalWriteParams = z.output<
  typeof WorkerTerminalWriteParamsSchema
>;

export const WorkerTerminalWriteResultSchema = z
  .object({
    acceptedBytes: z.number().int().min(0),
    outputOffset: z.number().int().min(0),
  })
  .catchall(CanopyJsonValueSchema);

export type WorkerTerminalWriteResult = z.output<
  typeof WorkerTerminalWriteResultSchema
>;

export const WorkerTerminalResizeParamsSchema = z.strictObject({
  ...TerminalTarget,
  cols: z.number().int().min(1).max(1000),
  rows: z.number().int().min(1).max(1000),
});

export type WorkerTerminalResizeParams = z.output<
  typeof WorkerTerminalResizeParamsSchema
>;

/**
 * The persisted record a client supplies to recreate a terminal that is no
 * longer live on this worker. Terminal state stays with its current writer
 * until CAN-5092 places it, so the worker keeps no record of its own; the
 * worker resolves `cwdRootId` and `cwdRelativePath` itself and falls back to
 * the root when the directory is gone.
 */
export const WorkerTerminalRestoreSnapshotSchema = z.strictObject({
  cwdRootId: ID,
  cwdRelativePath: z.string().max(4096),
  /**
   * The launch inputs `worker.terminal.create` already takes from its client:
   * the shell executable, its arguments and the whole environment, resolved
   * by the trusted host adapter for the machine this worker runs on (the
   * user's shell setting lives with the client). They are launch inputs for
   * this one start, never stored by the worker or returned by it; the
   * directory, the only path the worker uses as state, is resolved by the
   * worker from `cwdRootId`.
   */
  shell: z.string().min(1).max(4096),
  args: z.array(z.string().max(4096)).max(64),
  initialCommand: INITIAL_COMMAND.optional(),
  env: z.object({}).catchall(CanopyJsonValueSchema),
  /** The terminal's persisted output, replayed before the restore marker. */
  scrollback: z.string().max(WORKER_TERMINAL_WRITE_MAX_BYTES),
});

export type WorkerTerminalRestoreSnapshot = z.output<
  typeof WorkerTerminalRestoreSnapshotSchema
>;

export const WorkerTerminalRestoreParamsSchema = z.strictObject({
  ...TerminalTarget,
  restoreMode: z.enum(['reattach_if_live', 'recreate_if_exited']),
  cols: z.number().int().min(1).max(1000),
  rows: z.number().int().min(1).max(1000),
  _meta: CanopyRequestMetadataSchema.extend({ idempotencyKey: ID }),
  snapshot: WorkerTerminalRestoreSnapshotSchema.optional(),
});

export type WorkerTerminalRestoreParams = z.output<
  typeof WorkerTerminalRestoreParamsSchema
>;

export const WorkerTerminalRestoreResultSchema = z
  .object({
    terminalId: ID,
    state: z.enum(['running', 'exited']),
    restored: z.boolean(),
    recreated: z.boolean(),
    outputOffset: z.number().int().min(0),
  })
  .catchall(CanopyJsonValueSchema);

export type WorkerTerminalRestoreResult = z.output<
  typeof WorkerTerminalRestoreResultSchema
>;

const CODE = z.enum(WORKER_TERMINAL_ERROR_CODES).optional();

export const WorkerTerminalErrorSchema = CanopyErrorPayloadSchema.extend({
  code: CODE,
  retry: CanopyQueryRetryDirectiveSchema,
});

// Write is idempotency `none`: an unknown outcome is never replayed blindly.
export const WorkerTerminalWriteErrorSchema = CanopyErrorPayloadSchema.extend({
  code: CODE,
  retry: z.discriminatedUnion('kind', [
    CanopyRetryDirectiveSchema.options[0],
    CanopyRetryDirectiveSchema.options[3],
  ]),
});

export const WorkerTerminalCreateErrorSchema = CanopyErrorPayloadSchema.extend({
  code: CODE,
  retry: CanopyKeyedRetryDirectiveSchema,
});

const BASE = {
  plane: 'worker',
  domain: 'terminal',
  version: 1,
  placement: 'target-selectable',
} as const;

// Served by the web core (CAN-4160) over a cloud chat's durable sandbox
// terminals, and by the daemon's terminal module (CAN-5088) on macOS and
// Linux. Kept out of the composed worker registries: the desktop dispatcher
// does not serve them, and the daemon composes them only with its terminal
// module.
export const WORKER_TERMINAL_QUERY_DEFINITIONS = defineCanopyQueryRegistry(
  'worker',
  {
    'worker.terminal.get': defineCanopyQuery({
      ...BASE,
      params: WorkerTerminalGetParamsSchema,
      result: WorkerTerminalSchema,
      error: WorkerTerminalErrorSchema,
      idempotency: 'inherent',
      requiredGrants: [WORKER_TERMINAL_GRANTS.read],
    }),
    'worker.terminal.list': defineCanopyQuery({
      ...BASE,
      params: WorkerTerminalListParamsSchema,
      result: WorkerTerminalListResultSchema,
      error: WorkerTerminalErrorSchema,
      idempotency: 'inherent',
      requiredGrants: [WORKER_TERMINAL_GRANTS.read],
    }),
  },
);

export const WORKER_TERMINAL_INSTRUCTION_DEFINITIONS =
  defineCanopyInstructionRegistry('worker', {
    'worker.terminal.create': defineCanopyInstruction({
      ...BASE,
      params: WorkerTerminalCreateParamsSchema,
      result: WorkerTerminalCreateResultSchema,
      error: WorkerTerminalCreateErrorSchema,
      idempotency: 'keyed',
      requiredGrants: [WORKER_TERMINAL_GRANTS.write],
    }),
    'worker.terminal.kill': defineCanopyInstruction({
      ...BASE,
      params: WorkerTerminalKillParamsSchema,
      result: WorkerTerminalSchema,
      error: WorkerTerminalErrorSchema,
      idempotency: 'inherent',
      requiredGrants: [WORKER_TERMINAL_GRANTS.write],
    }),
    'worker.terminal.release': defineCanopyInstruction({
      ...BASE,
      params: WorkerTerminalReleaseParamsSchema,
      result: WorkerTerminalReleaseResultSchema,
      error: WorkerTerminalErrorSchema,
      idempotency: 'inherent',
      requiredGrants: [WORKER_TERMINAL_GRANTS.write],
    }),
    'worker.terminal.write': defineCanopyInstruction({
      ...BASE,
      params: WorkerTerminalWriteParamsSchema,
      result: WorkerTerminalWriteResultSchema,
      error: WorkerTerminalWriteErrorSchema,
      idempotency: 'none',
      requiredGrants: [WORKER_TERMINAL_GRANTS.write],
    }),
    'worker.terminal.resize': defineCanopyInstruction({
      ...BASE,
      params: WorkerTerminalResizeParamsSchema,
      result: WorkerTerminalSchema,
      error: WorkerTerminalErrorSchema,
      idempotency: 'inherent',
      requiredGrants: [WORKER_TERMINAL_GRANTS.write],
    }),
  });

/**
 * Recreates a terminal that is no longer live on this worker (CAN-5088).
 * Only a local worker serves it, so it stays out of the web core's
 * definitions above.
 */
export const WORKER_TERMINAL_SESSION_INSTRUCTION_DEFINITIONS =
  defineCanopyInstructionRegistry('worker', {
    'worker.terminal.restore': defineCanopyInstruction({
      ...BASE,
      params: WorkerTerminalRestoreParamsSchema,
      result: WorkerTerminalRestoreResultSchema,
      error: WorkerTerminalCreateErrorSchema,
      idempotency: 'keyed',
      requiredGrants: [WORKER_TERMINAL_GRANTS.write],
    }),
  });

export const WORKER_TERMINAL_STREAM_DEFINITIONS = defineCanopyStreamRegistry(
  'worker',
  {
    'worker.terminal.attach': defineCanopyStream({
      ...BASE,
      idempotency: 'inherent',
      requiredGrants: [WORKER_TERMINAL_GRANTS.read],
      params: WorkerTerminalAttachParamsSchema,
      openResult: WorkerTerminalAttachOpenResultSchema,
      item: WorkerTerminalAttachItemSchema,
      end: WorkerTerminalAttachEndSchema,
      error: WorkerTerminalAttachErrorSchema,
    }),
  },
);
