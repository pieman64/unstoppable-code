/**
 * The local id a shared (cloud) pipeline is addressed by everywhere inside
 * Canopy: `shared:<serverId>:<remoteId>`.
 *
 * A shared pipeline has no file on disk, so this composite string is its only
 * stable handle — it is what the trigger modal selects by, what the App
 * Advisor dispatcher resolves, what the portal inventory document carries, and
 * what `runPipeline` parses back apart. The construction was open-coded in
 * four places before CAN-3021; this module is the single source of truth for
 * the shape so the producers and the parsers cannot drift.
 *
 * Pure and dependency-free by design: the parser reports whichever server id
 * it found rather than hard-coding Canopy Cloud, so callers that only accept
 * `CANOPY_CLOUD_SERVER_ID` compare it themselves.
 */

const SHARED_PIPELINE_ID_PREFIX = 'shared:';

export function buildSharedPipelineId(
  serverId: string,
  remoteId: string,
): string {
  return `${SHARED_PIPELINE_ID_PREFIX}${serverId}:${remoteId}`;
}

export interface ParsedSharedPipelineLocalId {
  serverId: string;
  remoteId: string;
}

/**
 * Splits a `shared:<serverId>:<remoteId>` id, or returns `null` for anything
 * else (a project, bundled, or user pipeline id included). Exactly three
 * colon-delimited segments are required, and neither id segment may be empty
 * or itself contain a colon, so the split is unambiguous in both directions.
 */
export function parseSharedPipelineLocalId(
  pipelineId: string,
): ParsedSharedPipelineLocalId | null {
  const match = /^shared:([^:]+):([^:]+)$/.exec(pipelineId);
  if (!match) return null;
  return { serverId: match[1], remoteId: match[2] };
}

/** Whether an id is addressed at a shared/cloud pipeline at all. */
export function isSharedPipelineLocalId(pipelineId: string): boolean {
  return pipelineId.startsWith(SHARED_PIPELINE_ID_PREFIX);
}

/**
 * Charset and length a shared pipeline's `remoteId` must satisfy to be
 * addressable as a local id.
 *
 * Deliberately narrower than whatever the server happens to mint today. The
 * composite id is parsed back apart on every hop, so a `remoteId` containing a
 * colon would be ambiguous; and the id is interpolated into a cloud request
 * path, so it is held to a traversal-free charset here rather than trusted
 * because it arrived over the portal. The length bound exists so an id can
 * never be the thing that overruns a payload budget.
 */
const SHARED_REMOTE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SHARED_REMOTE_ID_MAX_LENGTH = 128;

/**
 * Whether a cloud `remoteId` can be addressed as `shared:<serverId>:<remoteId>`.
 *
 * Exported so the PRODUCER of shared rows can apply the same rule the
 * validator enforces. Listing a row whose id the validator will later reject
 * offers the user something that can never be honored: both hydration and Run
 * fail it as `invalid_payload`. Dropping such a row at production time is
 * consistent with how this list already bounds itself (truncation past the row
 * limit is silent and intentional).
 */
export function isAddressableSharedPipelineRemoteId(remoteId: string): boolean {
  return (
    remoteId.length <= SHARED_REMOTE_ID_MAX_LENGTH &&
    SHARED_REMOTE_ID_RE.test(remoteId)
  );
}

/**
 * Whether a pipeline row is a shared (cloud) pipeline, testing the id as well
 * as `origin`.
 *
 * `origin` is the intended signal but it is droppable: the portal metadata
 * projector omits an origin it does not recognize, so a consumer older than
 * the release that introduced `'shared'` — or one rolled back after a desktop
 * release ships — sees `undefined` and would fall through to its project
 * default. The `shared:<serverId>:<remoteId>` id is never projected away, so
 * checking both keeps the classification correct across a version skew in
 * either direction.
 *
 * Structural parameter so the desktop descriptor shape, the portal summary
 * shape, and anything else carrying the same two fields share one rule.
 */
export function isSharedPipelineRow(row: {
  origin?: string;
  pipelineId?: string;
}): boolean {
  if (row.origin === 'shared') return true;
  return (
    row.pipelineId !== undefined && isSharedPipelineLocalId(row.pipelineId)
  );
}
