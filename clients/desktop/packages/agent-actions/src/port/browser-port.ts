import type { BrowserDispatchAction } from '../families/browser';
import type {
  AgentActionCall,
  AgentActionDispatchOutput,
} from '../surface/family';

/**
 * Runs one validated browser action against the host's in-app browser. The
 * host resolves the browser and runtime from the trusted call scope.
 */
export interface AgentBrowserPort<H> {
  dispatch(
    action: BrowserDispatchAction,
    call: AgentActionCall<H>,
  ): Promise<AgentActionDispatchOutput>;
}
