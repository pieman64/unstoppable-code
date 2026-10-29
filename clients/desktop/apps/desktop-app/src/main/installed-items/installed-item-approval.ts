import type { UninstallInstalledItemRequest } from '@canopy/protocol/installed-items';
import type { ApprovalSessionHandle } from '../approvals/approval-service';

export async function authorizeInstalledItemUninstall(
  approval: ApprovalSessionHandle | undefined,
  request: UninstallInstalledItemRequest,
  context?: { toolUseId?: string; signal?: AbortSignal },
): Promise<boolean> {
  if (!approval || context?.signal?.aborted) return false;
  const cancel = (): void => approval.invalidatePending?.();
  context?.signal?.addEventListener('abort', cancel, { once: true });
  try {
    const result = await approval.check(
      { kind: 'tool', toolName: 'installed_items.uninstall' },
      {
        title: 'Uninstall installed item',
        description:
          request.target.kind === 'account-mcp'
            ? 'Remove this connection and its sign-in from the account.'
            : request.target.kind === 'mcp-server'
              ? 'Remove this device server, all its configurations and their sign-ins.'
              : 'Remove this installed item and its saved selections.',
        details: {
          kind: 'tool',
          toolName: 'installed_items.uninstall',
          inputSummary: JSON.stringify(request.target),
        },
        toolUseId: context?.toolUseId,
      },
    );
    return result.decision === 'allow' && !context?.signal?.aborted;
  } finally {
    context?.signal?.removeEventListener('abort', cancel);
  }
}
