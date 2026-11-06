import { z } from 'zod';
import {
  defineCanopyInstruction,
  defineCanopyInstructionRegistry,
} from '../definitions';
import {
  CanopyErrorPayloadSchema,
  CanopyKeyedRetryDirectiveSchema,
} from '../errors';
import { WORKER_AGENT_GRANTS } from './agent-helpers';
import { WorkerCodeGraphJsonValueSchema } from './code-graph-reads';

/*
 * `worker.agent.turn.run` and `worker.agent.subagent.run` (CAN-4115): one chat
 * turn, or one managed subagent run generation, executed on a worker as the
 * child dispatch of a `core.chat.turn.run` or `core.agent.subagent.run`
 * operation. Params carry ids only; the owning core's host stages the request
 * until worker-owned provider runtimes make it portable (CAN-4116 to CAN-4120).
 */
export const WORKER_AGENT_RUN_ERROR_CODES = [
  'worker.agent.runLaunchUnavailable',
  'worker.agent.idempotencyKeyReused',
] as const;
export const WORKER_AGENT_TURN_FAILED_CODE = 'worker.agent.turnFailed';
export const WORKER_AGENT_TURN_FAILED_MESSAGE =
  'The chat turn ended with an error.';
export const WORKER_AGENT_SUBAGENT_FAILED_CODE = 'worker.agent.subagentFailed';
export const WORKER_AGENT_SUBAGENT_FAILED_MESSAGE =
  'The subagent run ended with an error.';
export const WORKER_AGENT_TURN_PAYLOAD_FORMAT = 'canopy.chat-event.v1';
export const WORKER_AGENT_TURN_PAYLOAD_MAX_BYTES = 1_048_576;
export const WORKER_AGENT_TURN_OUTCOMES = [
  'completed',
  'failed',
  'cancelled',
] as const;
export type WorkerAgentTurnOutcome =
  (typeof WORKER_AGENT_TURN_OUTCOMES)[number];
export const WORKER_AGENT_TURN_WAIT_KINDS = [
  'approval',
  'question',
  'deferred_tools',
  'plan_review',
] as const;
export type WorkerAgentTurnWaitKind =
  (typeof WORKER_AGENT_TURN_WAIT_KINDS)[number];
export const WORKER_AGENT_TURN_WAIT_RESOLUTIONS = [
  'answered',
  'cancelled',
  'expired',
] as const;
export type WorkerAgentTurnWaitResolution =
  (typeof WORKER_AGENT_TURN_WAIT_RESOLUTIONS)[number];

const id = z.string().min(1).max(512);
const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const utf8 = new TextEncoder();

export const WorkerAgentTurnScopeSchema = z.strictObject({
  workspaceId: id,
  worktreeId: id,
  chatId: id,
});
export type WorkerAgentTurnScope = z.output<typeof WorkerAgentTurnScopeSchema>;

export const WorkerAgentTurnRunParamsSchema = z.strictObject({
  turnRunId: id,
  scope: WorkerAgentTurnScopeSchema,
  /** The turn's user message id, the id `core.chat.turn.cancel` takes. */
  turnId: id,
  /** `providerEventSequenceNamespace`, or 'initial'. */
  eventNamespace: z.string().min(1).max(256),
  providerId: z.string().min(1).max(64),
  model: z.string().min(1).max(256).nullable(),
  /** Reserved for CAN-4123 materializations; always null in CAN-4115. */
  materializationId: id.nullable(),
});
export type WorkerAgentTurnRunParams = z.output<
  typeof WorkerAgentTurnRunParamsSchema
>;

const turnBase = { turnRunId: id, eventCount: count };
export const WorkerAgentTurnRunResultSchema = z.discriminatedUnion('status', [
  z.strictObject({ ...turnBase, status: z.literal('completed') }),
  z.strictObject({
    ...turnBase,
    status: z.literal('failed'),
    error: z.strictObject({
      code: z.literal(WORKER_AGENT_TURN_FAILED_CODE),
      message: z.string().min(1).max(1_024),
    }),
  }),
  z.strictObject({ ...turnBase, status: z.literal('cancelled') }),
]);
export type WorkerAgentTurnRunResult = z.output<
  typeof WorkerAgentTurnRunResultSchema
>;

// Chat-event frames routinely exceed the bounded error-details JSON limit, so
// the payload is JSON of any shape, bounded only by its serialized size.
function fitsTranscriptPayload(value: unknown): boolean {
  try {
    return (
      utf8.encode(JSON.stringify(value) ?? 'null').byteLength <=
      WORKER_AGENT_TURN_PAYLOAD_MAX_BYTES
    );
  } catch {
    return false;
  }
}
const transcriptPayload = WorkerCodeGraphJsonValueSchema.refine(
  fitsTranscriptPayload,
  { message: 'The transcript payload is too large.' },
);

const eventBase = { turnRunId: id, sequence: count };
export const WorkerAgentTurnEventSchema = z.discriminatedUnion('kind', [
  z.strictObject({ ...eventBase, kind: z.literal('accepted') }),
  z.strictObject({
    ...eventBase,
    kind: z.literal('transcript'),
    format: z.literal(WORKER_AGENT_TURN_PAYLOAD_FORMAT),
    /** The worker's root-terminal classification of this frame. */
    terminal: z.boolean(),
    payload: transcriptPayload,
  }),
  z.strictObject({
    ...eventBase,
    kind: z.literal('wait_opened'),
    waitId: id,
    waitKind: z.enum(WORKER_AGENT_TURN_WAIT_KINDS),
  }),
  z.strictObject({
    ...eventBase,
    kind: z.literal('wait_resolved'),
    waitId: id,
    resolution: z.enum(WORKER_AGENT_TURN_WAIT_RESOLUTIONS),
  }),
  z.strictObject({
    ...eventBase,
    kind: z.literal('terminal'),
    outcome: z.enum(WORKER_AGENT_TURN_OUTCOMES),
  }),
]);
export type WorkerAgentTurnEvent = z.output<typeof WorkerAgentTurnEventSchema>;
export type WorkerAgentTurnEventKind = WorkerAgentTurnEvent['kind'];

export const WorkerAgentSubagentRunParamsSchema = z.strictObject({
  subagentRunId: id,
  delegationId: id,
  runGeneration: count,
  harnessId: z.string().min(1).max(64),
  scope: WorkerAgentTurnScopeSchema,
});
export type WorkerAgentSubagentRunParams = z.output<
  typeof WorkerAgentSubagentRunParamsSchema
>;

export const WorkerAgentSubagentRunResultSchema = z.discriminatedUnion(
  'status',
  [
    z.strictObject({ subagentRunId: id, status: z.literal('completed') }),
    z.strictObject({
      subagentRunId: id,
      status: z.literal('failed'),
      error: z.strictObject({
        code: z.literal(WORKER_AGENT_SUBAGENT_FAILED_CODE),
        message: z.string().min(1).max(1_024),
      }),
    }),
    z.strictObject({ subagentRunId: id, status: z.literal('cancelled') }),
  ],
);
export type WorkerAgentSubagentRunResult = z.output<
  typeof WorkerAgentSubagentRunResultSchema
>;

export const WorkerAgentRunErrorSchema = CanopyErrorPayloadSchema.extend({
  code: z.enum(WORKER_AGENT_RUN_ERROR_CODES).optional(),
  retry: CanopyKeyedRetryDirectiveSchema,
});

export const WORKER_AGENT_RUN_INSTRUCTION_DEFINITIONS =
  defineCanopyInstructionRegistry('worker', {
    'worker.agent.subagent.run': defineCanopyInstruction({
      plane: 'worker',
      domain: 'agent',
      version: 1,
      placement: 'target-selectable',
      idempotency: 'keyed',
      requiredGrants: [WORKER_AGENT_GRANTS.execute],
      params: WorkerAgentSubagentRunParamsSchema,
      result: WorkerAgentSubagentRunResultSchema,
      error: WorkerAgentRunErrorSchema,
    }),
    'worker.agent.turn.run': defineCanopyInstruction({
      plane: 'worker',
      domain: 'agent',
      version: 1,
      placement: 'target-selectable',
      idempotency: 'keyed',
      requiredGrants: [WORKER_AGENT_GRANTS.execute],
      params: WorkerAgentTurnRunParamsSchema,
      result: WorkerAgentTurnRunResultSchema,
      error: WorkerAgentRunErrorSchema,
    }),
  });
