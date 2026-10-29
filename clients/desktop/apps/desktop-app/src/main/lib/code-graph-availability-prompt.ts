import { getCodeGraphWorktreeService } from '@canopy/desktop-shared/node/code-graph/service';
import { isCodeGraphAvailableForWorkspace } from './code-graph-availability';
import { isCoworkWorkspace } from './workspace-registry';

/**
 * One-line system-prompt nudge toward the code-graph tools, appended
 * alongside the injected-tool prompt for worktree chats. Synchronous and
 * cheap (an `existsSync` check via `CodeGraphWorktreeService.hasGraph`) so it
 * can run inline on every worktree chat turn without adding I/O latency.
 *
 * Returns `undefined` for cowork workspaces, when the feature or workspace
 * preference disables code graphs, when the live tool surface is unavailable,
 * and when no graph has been built yet for this worktree. This check is the
 * shared gate for prompts and Claude hooks, so a stale graph database or stale
 * capability snapshot cannot activate graph-first steering.
 */
export function buildCodeGraphAvailabilityPrompt(
  projectId: string,
  worktreeId: string,
  availability?: { liveAvailable: boolean; toolsAdvertised: boolean },
): string | undefined {
  if (isCoworkWorkspace(projectId)) {
    return undefined;
  }
  if (!isCodeGraphAvailableForWorkspace(projectId)) {
    return undefined;
  }
  if (
    availability !== undefined &&
    (!availability.liveAvailable || !availability.toolsAdvertised)
  ) {
    return undefined;
  }
  if (!getCodeGraphWorktreeService().hasGraph(projectId, worktreeId)) {
    return undefined;
  }
  return 'A code graph exists for this worktree. Use GetCodeGraphContext, then QueryCodeGraph or SearchCodeGraph before broad source exploration, including in subagents.';
}
