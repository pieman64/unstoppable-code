import type { PipelineDistributionMode } from './package';
import { isAddressableSharedPipelineRemoteId } from './shared-pipeline-id';

/**
 * The remote id a public pipeline share installs from through
 * `core.pipeline.definition.import`: `public-share:<externalId>`. A share
 * link addresses the share by its external id, which may resolve to a Public
 * share or to the team or organization pipeline it links to.
 */

const PUBLIC_PIPELINE_SHARE_ID_PREFIX = 'public-share:';

export function buildPublicPipelineShareId(externalId: string): string {
  return `${PUBLIC_PIPELINE_SHARE_ID_PREFIX}${externalId}`;
}

/** The external id of a `public-share:` id, or `null` for anything else. */
export function parsePublicPipelineShareId(id: string): string | null {
  if (!id.startsWith(PUBLIC_PIPELINE_SHARE_ID_PREFIX)) return null;
  const externalId = id.slice(PUBLIC_PIPELINE_SHARE_ID_PREFIX.length);
  return isAddressableSharedPipelineRemoteId(externalId) ? externalId : null;
}

/** What the share page reviewed and an install pins. */
export interface PublicPipelineShareRevision {
  pipelineContentHash: string;
  distributionMode: PipelineDistributionMode;
  /** The package a `package` revision ships with. */
  packageDigest?: string;
}

/**
 * The remote version of a public share revision:
 * `<distributionMode>:<pipelineContentHash>[:<packageDigest>]`, so a pin
 * holds the document, how it is distributed and its package together.
 */
export function publicPipelineShareVersion(
  revision: PublicPipelineShareRevision,
): string {
  return [
    revision.distributionMode,
    revision.pipelineContentHash,
    ...(revision.packageDigest === undefined ? [] : [revision.packageDigest]),
  ].join(':');
}

/** The revision a public share version names, or `null` for another value. */
export function parsePublicPipelineShareVersion(
  version: string,
): PublicPipelineShareRevision | null {
  const match = /^(package|definition_only):([a-f0-9]{64})(?::(.+))?$/.exec(
    version,
  );
  if (!match) return null;
  const distributionMode =
    match[1] === 'package' ? 'package' : 'definition_only';
  return {
    distributionMode,
    pipelineContentHash: match[2],
    ...(match[3] === undefined ? {} : { packageDigest: match[3] }),
  };
}
