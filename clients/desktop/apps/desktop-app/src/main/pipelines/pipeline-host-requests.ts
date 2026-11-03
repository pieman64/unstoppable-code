import {
  WORKER_PIPELINE_HOST_PATH_OUTPUTS,
  WorkerPipelineChatSendRecordSchema,
  WorkerPipelineHostActionRequestSchema,
  WorkerPipelineHostResultSchema,
  type WorkerPipelineHostActionRequest,
  type WorkerPipelineHostRequest,
  type WorkerPipelineHostResult,
} from '@canopy/protocol/canopy-core';
import { parseWorkspaceContext } from '@canopy/protocol/workspace-context';
import type {
  PipelineHostActionCaller,
  PipelineHostActionControls,
  PipelineHostActionRequest,
  PipelineHostActionResult,
  PipelineHostActions,
} from '@canopy/desktop-shared/node/pipelines/executor/types';
import { PIPELINE_NEEDS_DESKTOP_MESSAGE } from '@canopy/desktop-shared/pipelines/host-actions';
import type { PipelineChatSendRecord } from '@canopy/desktop-shared/types/pipeline';
import { peekDesktopCanopyRuntime } from '../canopy-runtime/desktop-runtime-access';

/*
 * Host steps cross the local worker boundary as worker-to-core requests
 * (CAN-4140, CAN-5077). The executor's port raises every host step on
 * `worker.pipeline.hostRequests` with the run's owner; core
 * settles each with `worker.pipeline.hostRequest.respond`. What doesn't
 * cross yet stays in process, keyed by request id: the full caller (core
 * applies the request's own action, inputs and owner), the step's abort
 * signal, the executor's controls (artifacts directory, timeout finalizer),
 * the desktop host that applies the policy, the host's own unexpected
 * error, `send-agent-message`'s attachment paths and the host-path outputs
 * the boundary refuses (CAN-5086).
 */

interface InProcessHostCall {
  readonly host: PipelineHostActions;
  readonly caller: PipelineHostActionCaller;
  readonly controls: PipelineHostActionControls | undefined;
  /** The step's own signal: the executor withdrawing the call stops the host. */
  readonly signal: AbortSignal;
  /** `send-agent-message`'s contained attachment paths. */
  readonly attachments: readonly string[] | undefined;
  error?: unknown;
  pathOutputs?: Record<string, string>;
  /** A send record the boundary refuses; the executor reports it as invalid. */
  invalidChatSend?: PipelineChatSendRecord;
}

const calls = new Map<string, InProcessHostCall>();

const UNPORTABLE: PipelineHostActionResult = {
  status: 'failure',
  failureReason: 'validation_failed',
  error: 'This host step has an input the pipeline host doesn’t accept.',
  outputs: {},
};

function isPathOutput(key: string): boolean {
  return WORKER_PIPELINE_HOST_PATH_OUTPUTS.some((pathKey) => pathKey === key);
}

/** Split a host result into its portable form and what stays on this host. */
function toPortableResult(result: PipelineHostActionResult): {
  portable: WorkerPipelineHostResult;
  pathOutputs: Record<string, string>;
  invalidChatSend?: PipelineChatSendRecord;
} {
  const outputs: Record<string, string> = {};
  const pathOutputs: Record<string, string> = {};
  for (const [key, value] of Object.entries(result.outputs))
    (isPathOutput(key) ? pathOutputs : outputs)[key] = value;
  const chatSend =
    result.chatSend === undefined
      ? undefined
      : WorkerPipelineChatSendRecordSchema.safeParse(result.chatSend);
  const sent = chatSend?.success ? { chatSend: chatSend.data } : {};
  const portable = WorkerPipelineHostResultSchema.parse(
    result.status === 'success'
      ? { status: 'success', outputs, ...sent }
      : {
          status: 'failure',
          failureReason: result.failureReason,
          message: result.error || 'The host step failed.',
          outputs,
          ...sent,
        },
  );
  return chatSend === undefined || chatSend.success
    ? { portable, pathOutputs }
    : { portable, pathOutputs, invalidChatSend: result.chatSend };
}

/**
 * The run's owner as it crosses, resolved as the host's owner policy
 * resolves it: a run without one is Personal, and an owner that isn't a
 * workspace context is `null`, whose project targets core refuses.
 */
function portableOwner(executionContext: string | undefined): string | null {
  const owner = executionContext ?? 'personal';
  return parseWorkspaceContext(owner) !== null ? owner : null;
}

/** The request's portable inputs; attachment paths stay on this host. */
function portableInputs(request: PipelineHostActionRequest): object {
  if (request.action !== 'send-agent-message') return request.inputs;
  const { attachments, ...inputs } = request.inputs;
  return attachments === undefined || attachments.length === 0
    ? inputs
    : { ...inputs, attachmentCount: attachments.length };
}

function attachmentsOf(
  request: PipelineHostActionRequest,
): readonly string[] | undefined {
  return request.action === 'send-agent-message'
    ? request.inputs.attachments
    : undefined;
}

/**
 * The executor's host port on the local worker: raise the request for core
 * and return its settlement. Without a core settling requests the step fails
 * as it does without a desktop.
 */
export function createWorkerPipelineHostActions(
  host: PipelineHostActions,
): PipelineHostActions {
  return {
    async run(
      request,
      caller,
      signal,
      controls,
    ): Promise<PipelineHostActionResult> {
      const portable = WorkerPipelineHostActionRequestSchema.safeParse({
        action: request.action,
        ...portableInputs(request),
      });
      if (!portable.success) return UNPORTABLE;
      const broker = peekDesktopCanopyRuntime()?.pipelineHostRequests;
      if (!broker?.settled)
        return {
          status: 'failure',
          failureReason: 'needs_desktop',
          error: PIPELINE_NEEDS_DESKTOP_MESSAGE,
          outputs: {},
        };
      const requestId = caller.idempotencyKey;
      const call: InProcessHostCall = {
        host,
        caller,
        controls,
        signal,
        attachments: attachmentsOf(request),
      };
      calls.set(requestId, call);
      try {
        const result = await broker.raise(
          {
            requestId,
            executionId: caller.executionId,
            jobId: caller.jobId,
            stepId: caller.stepId,
            childExecutionId: caller.childId ?? null,
            attempt: caller.attempt,
            iteration: caller.iteration,
            owner: portableOwner(caller.executionContext),
            deadlineAt: new Date(
              controls?.deadlineAt ?? Date.now(),
            ).toISOString(),
            request: portable.data,
          },
          signal,
        );
        const outputs = { ...result.outputs, ...call.pathOutputs };
        // A record the boundary refused reaches the executor, which reports
        // it as an invalid receipt, as before.
        const chatSend = result.chatSend ?? call.invalidChatSend;
        const sent = chatSend === undefined ? {} : { chatSend };
        if (result.status === 'success')
          return { status: 'success', outputs, ...sent };
        // An unexpected host error keeps its own message in process.
        if (result.failureReason === null)
          throw call.error instanceof Error
            ? call.error
            : new Error(result.message);
        return {
          status: 'failure',
          failureReason: result.failureReason,
          error: result.message,
          outputs,
          ...sent,
        };
      } finally {
        if (calls.get(requestId) === call) calls.delete(requestId);
      }
    },
  };
}

function toHostRequest(
  request: WorkerPipelineHostActionRequest,
  call: InProcessHostCall,
): PipelineHostActionRequest | null {
  switch (request.action) {
    case 'move-to-group': {
      const { action, ...inputs } = request;
      return { action, inputs };
    }
    case 'create-worktree': {
      const { action, ...inputs } = request;
      return { action, inputs };
    }
    case 'create-project-entry': {
      const { action, ...inputs } = request;
      return { action, inputs };
    }
    case 'create-bot-entry': {
      const { action, ...inputs } = request;
      return { action, inputs };
    }
    case 'send-agent-message': {
      const { action, attachmentCount, ...inputs } = request;
      // The paths the worker contained, for the count the request names.
      if ((call.attachments?.length ?? 0) !== (attachmentCount ?? 0))
        return null;
      return {
        action,
        inputs: {
          ...inputs,
          // An explicit empty list stays: the host fingerprints it.
          ...(call.attachments !== undefined
            ? { attachments: [...call.attachments] }
            : {}),
        },
      };
    }
    case 'wait-for-agent-reply': {
      const { action, ...inputs } = request;
      return { action, inputs };
    }
  }
}

const NOT_WAITING: WorkerPipelineHostResult = {
  status: 'failure',
  failureReason: 'not_found',
  message: 'This host request is no longer waiting.',
  outputs: {},
};

/**
 * Core's settlement of one host request: the desktop host applies its
 * policy for the call this request belongs to.
 */
export async function applyPipelineHostRequest(
  request: WorkerPipelineHostRequest,
  signal: AbortSignal,
): Promise<WorkerPipelineHostResult> {
  const call = calls.get(request.requestId);
  if (
    call?.caller.executionId !== request.executionId ||
    portableOwner(call.caller.executionContext) !== request.owner
  )
    return NOT_WAITING;
  const hostRequest = toHostRequest(request.request, call);
  if (hostRequest === null) return NOT_WAITING;
  try {
    const { portable, pathOutputs, invalidChatSend } = toPortableResult(
      await call.host.run(
        hostRequest,
        call.caller,
        AbortSignal.any([signal, call.signal]),
        call.controls,
      ),
    );
    call.pathOutputs = pathOutputs;
    if (invalidChatSend !== undefined) call.invalidChatSend = invalidChatSend;
    return portable;
  } catch (error) {
    call.error = error;
    throw error;
  }
}
