import { z } from 'zod';

import {
  CanopyJsonValueSchema,
  canopyJsonValueSchemaWithin,
  type CanopyJsonValue,
} from './errors';

/**
 * The reserved request member that carries host execution input (CAN-5496).
 * It sits beside `_meta`, never inside it or the operation params, and is
 * accepted only by {@link CANOPY_HOST_EXECUTION_OPERATIONS}.
 */
export const CANOPY_HOST_EXECUTION_MEMBER = '_execution';

/**
 * The operations whose request envelope admits `_execution`: the
 * `worker.git.*` operations whose Git children run with the forwarded
 * environment. `worker.git.executable.get` is absent because executable
 * selection keeps the daemon's own environment. `worker.git.diff.get` is
 * absent too: its change-set reads keep the daemon's own environment,
 * recorded debt (CAN-4729). The branch writes are idempotency `none`, so no
 * receipt or replay can run them again with a stale environment (CAN-4108,
 * CAN-5516). `worker.script.execute` takes the run's complete environment
 * (CAN-5087).
 */
export const CANOPY_HOST_EXECUTION_OPERATIONS: ReadonlySet<string> = new Set([
  'worker.git.branch.list',
  'worker.git.remote.get',
  'worker.git.worktree.health.get',
  'worker.git.checkout',
  'worker.git.branch.create',
  'worker.git.branch.rename',
  'worker.git.branch.delete',
  // CAN-5517: idempotency none, as the branch writes.
  'worker.git.fetch',
  'worker.git.pull',
  // CAN-5882: keyed without retention until CAN-4733; no credentials forwarded.
  'worker.git.commit',
  'worker.git.push',
  'worker.git.merge',
  // CAN-5087: keyed, but `_execution` is outside params, so a keyed repeat joins the running execution and never runs it with another environment.
  'worker.script.execute',
  // CAN-5086: a pipeline start carries its launch in pipelineLaunch; keyed, but a keyed replay never runs a launch again.
  'worker.pipeline.execution.start',
  // CAN-5095: an owner request's answer carries its capabilities in pipelineOwnerValues.
  'worker.pipeline.hostRequest.respond',
]);

/** Bounds well below one 8 MiB frame and macOS `ARG_MAX`. */
export const CANOPY_HOST_EXECUTION_LIMITS = Object.freeze({
  entries: 1_024,
  bytes: 256 * 1024,
});

/**
 * UTF-8 bytes of `text`, counting an unpaired surrogate as U+FFFD (three
 * bytes), as `TextEncoder` and Node's spawn encode it. Counted directly
 * because the renderer's jsdom tests import this module and lack
 * `TextEncoder`.
 */
function utf8ByteLength(text: string): number {
  let bytes = 0;
  for (let index = 0; index < text.length; index += 1) {
    const unit = text.charCodeAt(index);
    if (unit < 0x80) {
      bytes += 1;
    } else if (unit < 0x800) {
      bytes += 2;
    } else if (
      unit >= 0xd800 &&
      unit <= 0xdbff &&
      index + 1 < text.length &&
      text.charCodeAt(index + 1) >= 0xdc00 &&
      text.charCodeAt(index + 1) <= 0xdfff
    ) {
      bytes += 4;
      index += 1;
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

function withinLimits(environment: Readonly<Record<string, string>>): boolean {
  const entries = Object.entries(environment);
  if (entries.length > CANOPY_HOST_EXECUTION_LIMITS.entries) return false;
  let bytes = 0;
  for (const [key, value] of entries) {
    // `KEY=value` plus its terminator, as the child's environment block holds it.
    bytes += utf8ByteLength(key) + utf8ByteLength(value) + 2;
    if (bytes > CANOPY_HOST_EXECUTION_LIMITS.bytes) return false;
  }
  return true;
}

const EnvironmentKeySchema = z
  .string()
  .min(1)
  .refine((key) => !key.includes('\0') && !key.includes('='));
const EnvironmentValueSchema = z
  .string()
  .refine((value) => !value.includes('\0'));

/**
 * The complete environment a host-local child runs with. It replaces the
 * executing host's own environment for that child; it is never merged.
 * For a pipeline start it is the run's base environment, which replaces the
 * worker's own for every step; the executor layers `pipelineLaunch.env` and
 * `secretEnv` over it as it layers them over its own (CAN-5086).
 */
export const CanopyChildEnvironmentSchema = z
  .record(EnvironmentKeySchema, EnvironmentValueSchema)
  .refine(withinLimits, 'The child environment exceeds its limits.');

/** The operation whose `_execution` may carry a pipeline launch (CAN-5086). */
export const CANOPY_PIPELINE_LAUNCH_OPERATION =
  'worker.pipeline.execution.start';

/** The longest admitted pipeline snapshot, as UTF-8 JSON. */
export const WORKER_PIPELINE_LAUNCH_SNAPSHOT_MAX_BYTES = 2 * 1024 * 1024;

/** Deeper than any workflow document nests; it bounds the check below. */
const WORKER_PIPELINE_LAUNCH_SNAPSHOT_MAX_DEPTH = 64;

/**
 * JSON data with no per-value size bound: the snapshot is bounded as a whole
 * by {@link WORKER_PIPELINE_LAUNCH_SNAPSHOT_MAX_BYTES}, unlike error details.
 */
function isSnapshotValue(
  value: unknown,
  depth: number,
  ancestors: Set<object>,
): value is CanopyJsonValue {
  if (value === null || typeof value === 'string') return true;
  if (typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object') return false;
  if (depth >= WORKER_PIPELINE_LAUNCH_SNAPSHOT_MAX_DEPTH) return false;
  if (ancestors.has(value)) return false;
  ancestors.add(value);
  try {
    if (Array.isArray(value))
      return value.every((entry) =>
        isSnapshotValue(entry, depth + 1, ancestors),
      );
    const prototype: unknown = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return false;
    if (Object.getOwnPropertySymbols(value).length > 0) return false;
    return Object.values(value).every((entry) =>
      isSnapshotValue(entry, depth + 1, ancestors),
    );
  } finally {
    ancestors.delete(value);
  }
}

/** A POSIX absolute host path; the daemon serves pipelines on macOS and Linux only. */
const HostPathSchema = z
  .string()
  .min(2)
  .max(4096)
  .refine((value) => value.startsWith('/') && !value.includes('\0'));

/**
 * What a pipeline start runs, host-local (CAN-5086): the snapshot core
 * admitted, its resolved paths, its launch environment and the secret
 * environment its core redeemed. It never enters params, records or logs.
 */
export const WorkerPipelineHostLaunchSchema = z.strictObject({
  pipeline: z
    .record(z.string(), z.unknown())
    .refine(
      (pipeline) =>
        Object.values(pipeline).every((value) =>
          isSnapshotValue(value, 1, new Set()),
        ),
      // Abort, so the size check below never serializes a cycle.
      { message: 'Expected JSON-safe data.', abort: true },
    )
    .refine(
      (pipeline) =>
        utf8ByteLength(JSON.stringify(pipeline)) <=
        WORKER_PIPELINE_LAUNCH_SNAPSHOT_MAX_BYTES,
      'The pipeline snapshot exceeds its limit.',
    ),
  cwd: HostPathSchema,
  /** The core's own built bundled actions (`getBundledActionsDir()`), so both hosts run one copy. */
  bundledActionsDir: HostPathSchema,
  repoPath: HostPathSchema.optional(),
  pipelineFileDir: HostPathSchema.optional(),
  pipelineDataDir: HostPathSchema.optional(),
  assetsDir: HostPathSchema.optional(),
  assetPaths: z
    .record(z.string().min(1).max(256), HostPathSchema)
    .refine((paths) => Object.keys(paths).length <= 64)
    .optional(),
  executionCheckoutRoot: HostPathSchema.nullable().optional(),
  /** `ExecutionOptions.env`: layered over the base environment by the executor. */
  env: CanopyChildEnvironmentSchema,
  /** `ExecutionOptions.secretEnv`: masked in step output. */
  secretEnv: CanopyChildEnvironmentSchema,
  inputs: z
    .record(z.string().min(1).max(256), z.string().max(65_536))
    .refine((inputs) => Object.keys(inputs).length <= 256)
    .optional(),
  target: CanopyJsonValueSchema.optional(),
  pipelinePreferenceLocator: CanopyJsonValueSchema.optional(),
  sharedPipelineSource: CanopyJsonValueSchema.optional(),
  curatedPipelineSource: CanopyJsonValueSchema.optional(),
  initiator: CanopyJsonValueSchema.optional(),
  agentOrigin: CanopyJsonValueSchema.optional(),
  /** How `node` steps and actions start (Electron's binary as Node). */
  nodeProcess: z
    .strictObject({
      command: HostPathSchema,
      env: z
        .record(z.string().min(1).max(256), z.string().max(4096))
        .optional(),
    })
    .optional(),
});
export type WorkerPipelineHostLaunch = z.output<
  typeof WorkerPipelineHostLaunchSchema
>;

/** The operation whose `_execution` may carry pipeline owner values (CAN-5095). */
export const CANOPY_PIPELINE_OWNER_VALUES_OPERATION =
  'worker.pipeline.hostRequest.respond';

/** The largest Codex provider block or MCP server map that crosses, as UTF-8 JSON. */
export const WORKER_PIPELINE_OWNER_VALUES_JSON_MAX_BYTES = 256 * 1024;

const ownerValueJson = canopyJsonValueSchemaWithin(
  WORKER_PIPELINE_OWNER_VALUES_JSON_MAX_BYTES,
);

/**
 * Capabilities core hands a model step host-locally (CAN-5095): a route's
 * provider environment and Codex provider block, or a Ledger route. They
 * never enter params, results, records or logs.
 */
export const WorkerPipelineOwnerValuesSchema = z.strictObject({
  /** The owner request these answer; the respond's own requestId. */
  requestId: z.string().min(1).max(3072),
  env: CanopyChildEnvironmentSchema.optional(),
  codexConfig: z
    .record(z.string(), ownerValueJson)
    .refine(
      (value) =>
        utf8ByteLength(JSON.stringify(value)) <=
        WORKER_PIPELINE_OWNER_VALUES_JSON_MAX_BYTES,
      'The Codex provider block exceeds its limit.',
    )
    .optional(),
  ledgerSubprocessTools: z
    .strictObject({
      mcpServers: z
        .record(z.string().min(1).max(256), ownerValueJson)
        .refine((value) => Object.keys(value).length <= 64)
        .refine(
          (value) =>
            utf8ByteLength(JSON.stringify(value)) <=
            WORKER_PIPELINE_OWNER_VALUES_JSON_MAX_BYTES,
        ),
      allowedTools: z.array(z.string().min(1).max(512)).max(256),
      secretValues: z.array(z.string().min(1).max(4096)).max(64),
    })
    .optional(),
});
export type WorkerPipelineOwnerValues = z.output<
  typeof WorkerPipelineOwnerValuesSchema
>;

export const CanopyHostExecutionSchema = z.strictObject({
  childEnvironment: CanopyChildEnvironmentSchema,
  /** Only {@link CANOPY_PIPELINE_LAUNCH_OPERATION} accepts it. */
  pipelineLaunch: WorkerPipelineHostLaunchSchema.optional(),
  /** Only {@link CANOPY_PIPELINE_OWNER_VALUES_OPERATION} accepts it. */
  pipelineOwnerValues: WorkerPipelineOwnerValuesSchema.optional(),
});

export type CanopyHostExecution = z.output<typeof CanopyHostExecutionSchema>;

export function canopyOperationAcceptsHostExecution(name: string): boolean {
  return CANOPY_HOST_EXECUTION_OPERATIONS.has(name);
}
