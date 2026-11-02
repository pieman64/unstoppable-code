import {
  ADVISORY_WORKSPACE_PROJECT_IDS,
  type TelemetryWorkspaceType,
} from '@canopy/protocol/telemetry';

/**
 * Workspace identity for chat surfaces that are NOT rows in
 * `workspaces/index.json`.
 *
 * App Advisor, plan-explore, code-review chat and the Pipeline Assistant run
 * under sentinel project ids. `readWorkspaceIndexEntry()` returns null for
 * them, so `resolveWorktreeMeta()` could derive neither a workspace name nor a
 * type and returned null — and every telemetry ingress path bails on a null
 * meta. The result was that none of these surfaces ever synced: their turns
 * were dropped on the client and never reached org statistics or the feed.
 *
 * That was an oversight rather than a policy. The wire protocol already carries
 * an `app_advisor` event type end to end, and the server's scoring rollups go
 * out of their way to exclude advisory turns from Agent turns and Work items —
 * an exclusion that only makes sense if the rows were expected to arrive.
 *
 * These surfaces are repo-less, so they report as `cowork`. They are counted as
 * activity (feed, usage, cost) but never as authored worktrees: the server
 * excludes the same id list from worktree counts.
 *
 * Deliberately limited to advisory surfaces. The cowork chat sentinels are not
 * listed: there is no evidence they are affected, and their entries represent
 * real delivered work rather than advice, so enabling them is a separate call.
 */
const DISPLAY_NAMES: Readonly<Record<string, string>> = {
  // Deliberately the former name, not ORCHESTRATOR_LABEL: server-side rows for
  // this sentinel workspace are keyed by this display name, and a second name
  // would split their history.
  'app-advisor': 'App Advisor',
  'plan-explore-chat': 'Plan Explore',
  'code-review-chat': 'Code Review Chat',
  'pipeline-editor': 'Pipeline Assistant',
};

const SENTINEL_TELEMETRY_WORKSPACES: ReadonlyMap<
  string,
  { name: string; type: TelemetryWorkspaceType }
> = new Map(
  ADVISORY_WORKSPACE_PROJECT_IDS.map((projectId) => [
    projectId,
    { name: DISPLAY_NAMES[projectId] ?? projectId, type: 'cowork' as const },
  ]),
);

/**
 * Telemetry workspace identity for a sentinel project id, or null when the id
 * is an ordinary workspace that `workspaces/index.json` already describes.
 *
 * Callers must prefer the index entry when one exists: a real workspace's
 * user-chosen name and type are authoritative, and this fallback must never
 * shadow it.
 */
export function getSentinelTelemetryWorkspace(
  projectId: string,
): { name: string; type: TelemetryWorkspaceType } | null {
  return SENTINEL_TELEMETRY_WORKSPACES.get(projectId) ?? null;
}
