import {
  AgentPortError,
  type AgentInstalledItemsPort,
} from '@canopy/agent-actions';
import type { CanopyInjectedToolRuntime } from '../canopy-tools/core';

export const desktopInstalledItemsPort: AgentInstalledItemsPort<CanopyInjectedToolRuntime> =
  {
    async listStatus() {
      const { installedItemService } =
        await import('../installed-items/installed-item-service');
      return installedItemService.listStatus();
    },
    async setStatus(request) {
      const { installedItemService } =
        await import('../installed-items/installed-item-service');
      return installedItemService.setStatus(request);
    },
    async uninstall(request, call) {
      if (call.host.authorizeInstalledItemUninstall) {
        const allowed = await call.host.authorizeInstalledItemUninstall(
          request,
          { toolUseId: call.toolUseId, signal: call.signal },
        );
        if (!allowed || call.signal?.aborted)
          throw new AgentPortError(
            'authorization_conflict',
            'Uninstall was not approved.',
          );
        const { installedItemService } =
          await import('../installed-items/installed-item-service');
        return installedItemService.uninstall(request);
      }
      const runtime = call.host.worktreeActionRuntime;
      if (!runtime || !call.scope || call.signal?.aborted)
        throw new AgentPortError(
          'surface_unavailable',
          'Uninstall requires a live calling chat and an approval surface.',
        );
      const { createApprovalSession } =
        await import('../approvals/approval-service');
      const { getDataDir } = await import('../lib/paths');
      const approval = createApprovalSession({
        sessionKey: `installed-item-uninstall:${call.toolUseId ?? call.scope.chatId}`,
        projectId: call.scope.workspaceId,
        worktreeId: call.scope.worktreeId,
        chatId: call.scope.chatId,
        provider: 'claude',
        workspaceRoot:
          'cwd' in runtime && typeof runtime.cwd === 'string'
            ? runtime.cwd
            : getDataDir(),
        // Hosts without a current session handle cannot inherit a broader workspace mode.
        mode: 'ask',
        sessionRules: [],
        getWindow: runtime.getWindow,
      });
      const cancel = (): void => approval.dispose();
      call.signal?.addEventListener('abort', cancel, { once: true });
      try {
        const decision = await approval.check(
          { kind: 'tool', toolName: 'installed_items.uninstall' },
          {
            title: 'Uninstall installed item',
            description:
              request.target.kind === 'account-mcp'
                ? 'Remove this account connection and its sign-in for the account.'
                : request.target.kind === 'mcp-server'
                  ? 'Remove this device server, all its configurations and their sign-ins.'
                  : 'Remove this installed item and its saved selections.',
            details: {
              kind: 'tool',
              toolName: 'installed_items.uninstall',
              inputSummary: JSON.stringify(request.target),
            },
            toolUseId: call.toolUseId,
          },
        );
        if (decision.decision !== 'allow' || call.signal?.aborted)
          throw new AgentPortError(
            'authorization_conflict',
            'Uninstall was not approved.',
          );
        const { installedItemService } =
          await import('../installed-items/installed-item-service');
        return installedItemService.uninstall(request);
      } finally {
        call.signal?.removeEventListener('abort', cancel);
        approval.dispose();
      }
    },
  };
