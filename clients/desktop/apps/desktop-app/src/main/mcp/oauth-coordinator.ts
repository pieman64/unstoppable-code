import type { StartMcpOAuthLoginResponse } from '@canopy/execution-engine/types/mcp-servers';
import {
  cancelMcpOAuthFlow,
  handleMcpOAuthCallback,
  startMcpOAuthFlow,
  type StartMcpOAuthFlowInput,
} from './oauth-client';

/** How the coordinator sees CAN-4131's desktop interface leases. */
export interface McpSignInPresenterLeases {
  /** The live interface lease id of this WebContents, or null. */
  leaseFor(webContentsId: number): string | null;
  isLive(leaseId: string): boolean;
}

export interface StartMcpSignInInput extends Omit<
  StartMcpOAuthFlowInput,
  'presentation'
> {
  /** The requesting WebContents (`event.sender.id`); used only for an embedded sign-in. */
  presenterWebContentsId?: number;
}

/** The MCP OAuth coordinator (CAN-4126): the only path from clients and the integration server to sign-in flow state. */
export interface McpOAuthCoordinator {
  start(input: StartMcpSignInInput): Promise<StartMcpOAuthLoginResponse>;
  cancel(flowId: string): Promise<void>;
  completeCallback(url: URL): Promise<{ success: boolean; message: string }>;
}

export const EMBEDDED_SIGN_IN_NEEDS_LEASE_MESSAGE =
  'Open this sign-in from the main window.';

let installedLeases: McpSignInPresenterLeases | null = null;

export function createMcpOAuthCoordinator(
  deps: {
    startFlow?: typeof startMcpOAuthFlow;
    cancelFlow?: typeof cancelMcpOAuthFlow;
    completeFlow?: typeof handleMcpOAuthCallback;
    /** Read at each use; default: the leases set by setMcpSignInPresenterLeases. */
    leases?: () => McpSignInPresenterLeases | null;
  } = {},
): McpOAuthCoordinator {
  const startFlow = deps.startFlow ?? startMcpOAuthFlow;
  const cancelFlow = deps.cancelFlow ?? cancelMcpOAuthFlow;
  const completeFlow = deps.completeFlow ?? handleMcpOAuthCallback;
  const leases =
    deps.leases ?? ((): McpSignInPresenterLeases | null => installedLeases);
  return {
    start: (input): Promise<StartMcpOAuthLoginResponse> => {
      const { presenterWebContentsId, ...rest } = input;
      if (input.browser !== 'embedded') return startFlow(rest);
      const leaseId =
        presenterWebContentsId === undefined
          ? null
          : (leases()?.leaseFor(presenterWebContentsId) ?? null);
      if (leaseId === null)
        return Promise.reject(new Error(EMBEDDED_SIGN_IN_NEEDS_LEASE_MESSAGE));
      return startFlow({
        ...rest,
        presentation: { isLive: () => leases()?.isLive(leaseId) === true },
      });
    },
    cancel: (flowId): Promise<void> => cancelFlow(flowId),
    completeCallback: (url): Promise<{ success: boolean; message: string }> =>
      completeFlow(url),
  };
}

let coordinator: McpOAuthCoordinator | null = null;

/** The process-wide coordinator over the real token client. */
export function getMcpOAuthCoordinator(): McpOAuthCoordinator {
  return (coordinator ??= createMcpOAuthCoordinator());
}

/** Composition only (the renderer relay host): installs or clears the desktop interface leases. */
export function setMcpSignInPresenterLeases(
  leases: McpSignInPresenterLeases | null,
): void {
  installedLeases = leases;
}
