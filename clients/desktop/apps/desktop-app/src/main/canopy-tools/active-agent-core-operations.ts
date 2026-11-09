import { getActiveDesktopRuntime } from '../canopy-runtime/desktop-runtime';
import {
  agentCoreOperations,
  type AgentCoreOperationDispatcher,
  type AgentToolFamily,
} from './agent-core-operations';

/**
 * `agentCoreOperations(family, getActiveDesktopRuntime)`, resolved per call.
 * The only agent tool module that reaches the runtime (CAN-4125); kept apart
 * from the table so the Ledger tools, which Summary publication loads, do not
 * import the desktop runtime.
 */
export function activeAgentCoreOperations(
  family: AgentToolFamily,
): AgentCoreOperationDispatcher {
  return agentCoreOperations(family, getActiveDesktopRuntime);
}
