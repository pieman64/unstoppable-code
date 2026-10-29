import {
  dispatchScriptPreferencesAction,
  type ScriptPreferencesAction,
  type ScriptPreferencesPort,
} from '@canopy/agent-actions/families/settings/script-preferences';
import type { AgentActionResponse, AgentJson } from '@canopy/agent-actions';
import type { ScriptActionsSnapshot } from '@canopy/protocol/script-actions';
import { scriptActionsService } from '../services/script-actions-host';
import type { AppAdvisorToolRuntime } from '../app-advisor/runtime';

/** No commands, file contents or terminal output enter the advisor context. */
export function scriptPreferencesSummary(
  snapshot: ScriptActionsSnapshot,
): AgentJson {
  return {
    pendingCount: snapshot.pendingCount,
    scanStatus: snapshot.scanStatus,
    shellAliasScanEnabled: snapshot.shellAliasScanEnabled,
    totalActions: snapshot.actions.length,
    omittedActions: Math.max(0, snapshot.actions.length - 200),
    actions: snapshot.actions.slice(0, 200).map((action) => ({
      id: action.id,
      name: action.name,
      kind: action.kind,
      status: action.status,
      repoId: action.repoId,
      packagePath: action.packagePath,
      pinned: action.pinned,
      shortcut: action.shortcut,
      unavailable: action.unavailableReason !== undefined,
      shortcutConflict: action.shortcutConflict ?? null,
    })),
  };
}

/** App Advisor only; scoped chat families have no script-preference port. */
export function dispatchDesktopScriptPreferences(
  action: ScriptPreferencesAction,
  runtime: AppAdvisorToolRuntime,
  requestId?: string,
  expectedUiRevision?: number,
  signal?: AbortSignal,
): Promise<AgentActionResponse> {
  const port: ScriptPreferencesPort<AppAdvisorToolRuntime> = {
    execute: async (input, call) => {
      if (call.signal?.aborted)
        throw new Error('Script preference request was cancelled.');
      const context = {
        projectId: input.workspaceId,
        worktreeId: input.inWorktreeId,
      };
      if (input.type === 'script_actions.open_review') {
        // Resolve the authorized target before asking the presentation host to open it.
        await scriptActionsService.list(context);
        const result = await call.host.dispatchRendererAction(
          input,
          expectedUiRevision,
          requestId,
          call.signal,
        );
        if (!result.ok)
          throw new Error(
            result.error?.message ?? 'Script review could not be opened.',
          );
        return { status: 'opened' };
      }
      const snapshot =
        input.type === 'script_actions.list'
          ? await scriptActionsService.list({
              ...context,
              includeDismissed: true,
            })
          : input.type === 'script_actions.rescan'
            ? await scriptActionsService.rescan(context)
            : input.type === 'script_actions.set_pin'
              ? await scriptActionsService.setPinned({
                  ...context,
                  id: input.id,
                  pinned: input.pinned,
                })
              : await scriptActionsService.setShortcut({
                  ...context,
                  id: input.id,
                  accelerator: input.accelerator,
                });
      return scriptPreferencesSummary(snapshot);
    },
  };
  return dispatchScriptPreferencesAction(action, port, {
    host: runtime,
    signal,
    ...(requestId ? { toolUseId: requestId } : {}),
  });
}
