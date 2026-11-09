import { AsyncLocalStorage } from 'node:async_hooks';
import type { CanopyCallerDescriptor } from '@canopy/protocol/canopy-core';

interface SelfFilteringMark {
  readonly caller: CanopyCallerDescriptor;
  consumed: boolean;
}

const reads = new AsyncLocalStorage<SelfFilteringMark>();

/**
 * Runs `dispatch`, one core dispatch as `caller`, as one of main's shared
 * agent resource-action reads, which apply the CAN-4551 owned-pipeline rule
 * themselves (CAN-5991). The mark lives only in this in-process call chain,
 * so no caller arriving over a relay, a socket or the daemon can claim it.
 */
export function withSelfFilteringAgentRead<Result>(
  caller: CanopyCallerDescriptor,
  dispatch: () => Promise<Result>,
): Promise<Result> {
  return reads.run({ caller, consumed: false }, dispatch);
}

/**
 * Whether the handler serving `caller` runs that marked dispatch. The mark
 * answers once, and only for the caller it was set for, so another dispatch
 * started inside the marked one, or by another caller, never inherits it.
 */
export function consumeSelfFilteringAgentRead(
  caller: CanopyCallerDescriptor,
): boolean {
  const mark = reads.getStore();
  if (
    mark === undefined ||
    mark.consumed ||
    mark.caller.principalId !== caller.principalId ||
    mark.caller.clientInstanceId !== caller.clientInstanceId ||
    mark.caller.authorityId !== caller.authorityId ||
    mark.caller.interfaceKind !== caller.interfaceKind
  )
    return false;
  mark.consumed = true;
  return true;
}
