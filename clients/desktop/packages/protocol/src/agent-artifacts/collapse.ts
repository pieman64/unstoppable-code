import type {
  AgentArtifactNavigationRequest,
  AgentArtifactReceiptV1,
  PipelineRunArtifactReceiptV1,
} from './index';
import { mergeLatestAgentArtifacts } from './validation';

/**
 * How much a receipt says about the item it is about. Within one turn a
 * receipt yields to any receipt of the same item with a higher rank, so an
 * item the agent found and then ran shows once, as the run.
 */
export type AgentArtifactItemPrecedence =
  | 'found'
  | 'recommended'
  | 'mutation'
  | 'run';

export const AGENT_ARTIFACT_ITEM_PRECEDENCE: Readonly<
  Record<AgentArtifactItemPrecedence, number>
> = { found: 0, recommended: 1, mutation: 2, run: 3 };

const SHARED_PIPELINE_ID_PREFIX = 'shared:';
// Project pipeline ids are paths relative to their checkout, so they only
// identify an item together with the project and worktree.
const PROJECT_PIPELINE_ID_PREFIX = 'project--';

/** undefined for receipts that never collapse (github_workflow_run, references with an unknown relation). */
export function agentArtifactItemPrecedence(
  receipt: AgentArtifactReceiptV1,
): AgentArtifactItemPrecedence | undefined {
  switch (receipt.kind) {
    case 'pipeline_run':
    case 'automation_run':
      return 'run';
    // Created, updated and deleted receipts rank the same.
    case 'pipeline':
    case 'skill':
    case 'automation':
    case 'agent':
      return 'mutation';
    case 'capability_reference':
      if (receipt.relation === 'found') return 'found';
      if (receipt.relation === 'recommended') return 'recommended';
      return undefined;
    case 'github_workflow_run':
      return undefined;
  }
}

/**
 * Identity keys of the item a receipt is about; [] when it has none. Empty id
 * parts never produce a key.
 *
 * Identity comes from the receipt's own id fields or its navigation target;
 * names and `aliases` are never consulted, so a rename keeps both receipts.
 * Shared pipelines also key on their remote id, which ignores the remote
 * name: two remotes exposing the same remote id would collapse together.
 * Project pipelines key on their project and worktree as well and have no
 * identity when either is unknown. The repo is not part of the key because
 * references don't carry it.
 */
export function agentArtifactItemKeys(
  receipt: AgentArtifactReceiptV1,
): readonly string[] {
  switch (receipt.kind) {
    case 'pipeline_run':
      return pipelineRunKeys(receipt);
    case 'automation_run':
    case 'automation':
      return receipt.activityId ? [`automation:${receipt.activityId}`] : [];
    case 'pipeline':
    case 'skill':
    case 'agent':
    case 'capability_reference':
      return navigationTargetKeys(receipt.navigationTarget);
    case 'github_workflow_run':
      return [];
  }
}

/**
 * Drops every receipt whose item has a higher-precedence receipt in the same
 * list. Survivor order is preserved, equal ranks never drop, and receipts
 * without a precedence or identity never drop. Returns the input array when
 * nothing drops.
 */
export function collapseAgentArtifactsByItem<T extends AgentArtifactReceiptV1>(
  receipts: readonly T[],
): readonly T[] {
  const ranked = receipts.map((receipt) => {
    return {
      receipt,
      rank: itemRank(receipt),
      keys: agentArtifactItemKeys(receipt),
    };
  });
  const maxRankByKey = new Map<string, number>();
  for (const { rank, keys } of ranked) {
    if (rank === undefined) continue;
    for (const key of keys) {
      const current = maxRankByKey.get(key);
      if (current === undefined || rank > current) maxRankByKey.set(key, rank);
    }
  }
  const kept = ranked
    .filter(
      ({ rank, keys }) =>
        rank === undefined ||
        !keys.some((key) => (maxRankByKey.get(key) ?? rank) > rank),
    )
    .map(({ receipt }) => receipt);
  return kept.length === receipts.length ? receipts : kept;
}

/**
 * `mergeLatestAgentArtifacts`, except an incoming receipt never replaces a
 * same-key receipt of higher precedence. References to one item share a
 * dedupe key whatever their relation, so without this a Found that follows a
 * Recommended would erase the recommendation and its reason before
 * `collapseAgentArtifactsByItem` could rank them. Equal and unranked
 * receipts keep latest-wins.
 */
export function mergeAgentArtifactsByPrecedence(
  current: readonly AgentArtifactReceiptV1[],
  incoming: readonly AgentArtifactReceiptV1[],
): AgentArtifactReceiptV1[] {
  let result = [...current];
  for (const receipt of incoming) {
    const rank = itemRank(receipt);
    if (rank !== undefined) {
      const identities = new Set([
        receipt.dedupeKey,
        ...(receipt.aliases ?? []),
      ]);
      const outranked = result.some(
        (candidate) =>
          (itemRank(candidate) ?? -1) > rank &&
          [candidate.dedupeKey, ...(candidate.aliases ?? [])].some((identity) =>
            identities.has(identity),
          ),
      );
      if (outranked) continue;
    }
    result = mergeLatestAgentArtifacts(result, [receipt]);
  }
  return result;
}

function itemRank(receipt: AgentArtifactReceiptV1): number | undefined {
  const precedence = agentArtifactItemPrecedence(receipt);
  return precedence === undefined
    ? undefined
    : AGENT_ARTIFACT_ITEM_PRECEDENCE[precedence];
}

function pipelineKey(
  pipelineId: string,
  projectId: string | undefined,
  worktreeId: string | undefined,
): string | undefined {
  if (!pipelineId) return undefined;
  if (!pipelineId.startsWith(PROJECT_PIPELINE_ID_PREFIX)) {
    return `pipeline:${pipelineId}`;
  }
  return projectId && worktreeId
    ? `pipeline:${projectId}/${worktreeId}:${pipelineId}`
    : undefined;
}

function pipelineRunKeys({
  pipelineId,
  projectId,
  worktreeId,
}: PipelineRunArtifactReceiptV1): readonly string[] {
  const key = pipelineKey(pipelineId, projectId, worktreeId);
  if (key === undefined) return [];
  const keys = [key];
  if (pipelineId.startsWith(SHARED_PIPELINE_ID_PREFIX)) {
    const remoteId = pipelineId.split(':').slice(2).join(':');
    if (remoteId) keys.push(`pipeline:remote:${remoteId}`);
  }
  return keys;
}

function navigationTargetKeys(
  // Persisted receipts may predate the navigation target.
  target: AgentArtifactNavigationRequest | undefined,
): readonly string[] {
  if (target === undefined) return [];
  switch (target.kind) {
    case 'pipeline_editor': {
      const key = pipelineKey(
        target.pipelineId,
        target.projectId,
        target.worktreeId,
      );
      if (key === undefined) return [];
      const keys = [key];
      if (target.sharedRemoteId) {
        keys.push(`pipeline:remote:${target.sharedRemoteId}`);
      }
      return keys;
    }
    case 'automation_editor':
      return target.activityId ? [`automation:${target.activityId}`] : [];
    case 'installed_skill':
      return target.sourceId && target.skillName
        ? [`skill:installed:${target.sourceId}/${target.skillName}`]
        : [];
    case 'shared_skill':
      return target.skillId ? [`skill:shared:${target.skillId}`] : [];
    case 'agent_editor':
      return target.agentId ? [`agent:local:${target.agentId}`] : [];
    case 'shared_agent':
      return target.agentId ? [`agent:shared:${target.agentId}`] : [];
    case 'capability_entry':
    case 'external_url':
    case 'pipeline_execution':
    case 'github_workflow_run':
      return [];
  }
}
