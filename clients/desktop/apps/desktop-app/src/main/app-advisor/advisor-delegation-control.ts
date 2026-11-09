import type {
  AppAdvisorAction,
  AppAdvisorActionResponse,
} from '@canopy/desktop-shared/types';
import type {
  AgentDelegationResult,
  AgentDelegationSnapshot,
} from '@canopy/protocol/delegation';
import { validateId } from '../lib/validation';
import type { ManagedDelegationChatTarget } from '../agents/delegation/service';
import type {
  StopAllOutcome,
  StopAllRootStop,
} from '../agents/delegation/user-stop-all';

export const ADVISOR_DELEGATION_CONTROL_ACTION_TYPES = [
  'delegation.stop',
  'delegation.stop_all',
] as const;

export type AdvisorDelegationControlAction = Extract<
  AppAdvisorAction,
  { type: (typeof ADVISOR_DELEGATION_CONTROL_ACTION_TYPES)[number] }
>;

export function isAdvisorDelegationControlAction(
  action: AppAdvisorAction,
): action is AdvisorDelegationControlAction {
  return ADVISOR_DELEGATION_CONTROL_ACTION_TYPES.some(
    (type) => type === action.type,
  );
}

/** The main owners an App Advisor delegation stop uses (CAN-6000). */
export interface AdvisorDelegationControlHost {
  /** The chat's delegation as its broker reports it; null when the chat has none by that id. */
  inspect(
    target: ManagedDelegationChatTarget,
    delegationId: string,
  ): Promise<AgentDelegationResult<AgentDelegationSnapshot | null>>;
  /** The operation id of the live core.agent.subagent.run behind a delegation generation. */
  findLiveRun(delegationId: string, runGeneration: number): string | null;
  /** Whether the ledger records the operation as a core.agent.subagent.run. */
  isSubagentRun(operationId: string): Promise<boolean>;
  /** core.operation.cancel as the advisor chat, with only core.operation.cancel. */
  cancelOperation(operationId: string): Promise<void>;
  /** The broker's user stop, for a delegation with no live run. */
  stopWithoutRun(
    target: ManagedDelegationChatTarget,
    delegationId: string,
  ): Promise<AgentDelegationResult<unknown>>;
  /** The chat's fenced stop-all. */
  stopAll(
    target: ManagedDelegationChatTarget,
    stopRoot: StopAllRootStop,
  ): Promise<AgentDelegationResult<StopAllOutcome>>;
}

const NOT_SUBAGENT_RUN = 'Only a delegate run can be stopped this way.';

function refused(message: string): AgentDelegationResult<never> {
  return {
    ok: false,
    error: { code: 'invalid_request', message, retryable: false },
  };
}

/**
 * Cancels an operation only when the ledger records it as a
 * core.agent.subagent.run: the advisor's core.operation.cancel reaches no
 * other kind of operation, whichever id main resolved.
 */
export async function cancelSubagentRun(
  operationId: string,
  host: Pick<AdvisorDelegationControlHost, 'isSubagentRun' | 'cancelOperation'>,
): Promise<AgentDelegationResult<undefined>> {
  if (!(await host.isSubagentRun(operationId)))
    return refused(NOT_SUBAGENT_RUN);
  try {
    await host.cancelOperation(operationId);
  } catch {
    return {
      ok: false,
      error: {
        code: 'runtime_error',
        message: 'The delegated run could not be stopped.',
        retryable: true,
      },
    };
  }
  return { ok: true, value: undefined };
}

/** Stops a delegation through its live run's core.operation.cancel, or `fallback` with no live run. */
function stopDelegation(
  snapshot: Pick<AgentDelegationSnapshot, 'delegationId' | 'runGeneration'>,
  host: AdvisorDelegationControlHost,
  fallback: () => Promise<AgentDelegationResult<unknown>>,
): Promise<AgentDelegationResult<unknown>> {
  const operationId =
    snapshot.runGeneration === undefined
      ? null
      : host.findLiveRun(snapshot.delegationId, snapshot.runGeneration);
  return operationId === null
    ? fallback()
    : cancelSubagentRun(operationId, host);
}

function failure(
  error: Extract<AgentDelegationResult<never>, { ok: false }>['error'],
): Omit<AppAdvisorActionResponse, 'requestId'> {
  return {
    ok: false,
    error: {
      code:
        error.code === 'invalid_request'
          ? 'invalid_target'
          : error.code === 'parent_unavailable'
            ? 'not_found'
            : 'execution_failed',
      message: error.message,
      ...(error.retryable ? { retryable: true } : {}),
    },
  };
}

async function run(
  action: AdvisorDelegationControlAction,
  host: AdvisorDelegationControlHost,
): Promise<Omit<AppAdvisorActionResponse, 'requestId'>> {
  const target = {
    projectId: action.projectId,
    worktreeId: action.worktreeId,
    chatId: action.chatId,
  };
  try {
    validateId(target.projectId, 'projectId');
    validateId(target.worktreeId, 'worktreeId');
    validateId(target.chatId, 'chatId');
    if (action.type === 'delegation.stop')
      validateId(action.delegationId, 'delegationId');
  } catch {
    return {
      ok: false,
      error: { code: 'invalid_target', message: 'Invalid delegation target.' },
    };
  }
  if (action.type === 'delegation.stop_all') {
    const result = await host.stopAll(target, (snapshot, brokerStop) =>
      stopDelegation(snapshot, host, brokerStop),
    );
    return result.ok
      ? {
          ok: true,
          result: {
            stopped: result.value.stopped,
            delegationIds: [...result.value.delegationIds],
          },
        }
      : failure(result.error);
  }
  const inspected = await host.inspect(target, action.delegationId);
  if (!inspected.ok) return failure(inspected.error);
  if (!inspected.value)
    return {
      ok: false,
      error: {
        code: 'not_found',
        message: 'This chat has no delegation with that id.',
      },
    };
  const stopped = await stopDelegation(inspected.value, host, () =>
    host.stopWithoutRun(target, action.delegationId),
  );
  return stopped.ok
    ? {
        ok: true,
        result: { delegationId: action.delegationId, status: 'stopping' },
      }
    : failure(stopped.error);
}

/**
 * App Advisor's delegation stops in Electron main (CAN-6000): a delegate
 * with a live run is stopped by core.operation.cancel on its
 * core.agent.subagent.run, which stops it through the broker's bound user
 * stop; one with no live run (queued or idle) through that user stop
 * directly. Stop-all keeps the chat's fence and rounds, stopping each live
 * subtree's top delegation the same way.
 */
export async function dispatchAdvisorDelegationControl(
  action: AdvisorDelegationControlAction,
  host: AdvisorDelegationControlHost,
): Promise<Omit<AppAdvisorActionResponse, 'requestId'>> {
  try {
    return await run(action, host);
  } catch {
    return {
      ok: false,
      error: {
        code: 'execution_failed',
        message: "Couldn't stop the delegation.",
      },
    };
  }
}
