import {
  isPipelinePackageDigest,
  isPipelinePackageIdentifier,
} from './package';

/**
 * The remote id of a pipeline a capability package carries, which an
 * automation install brings in through `core.pipeline.definition.import`:
 * `package-pipeline:<packageDigest>/<pipelineKey>`. The digest names the
 * verified package and the key its `automation_pipeline` resource.
 */

const PACKAGED_PIPELINE_ID_PREFIX = 'package-pipeline:';

export interface PackagedPipelineRef {
  packageDigest: string;
  pipelineKey: string;
}

export function buildPackagedPipelineId(ref: PackagedPipelineRef): string {
  return `${PACKAGED_PIPELINE_ID_PREFIX}${ref.packageDigest}/${ref.pipelineKey}`;
}

/** The package and key a `package-pipeline:` id names, or `null`. */
export function parsePackagedPipelineId(
  id: string,
): PackagedPipelineRef | null {
  if (!id.startsWith(PACKAGED_PIPELINE_ID_PREFIX)) return null;
  const rest = id.slice(PACKAGED_PIPELINE_ID_PREFIX.length);
  const separator = rest.lastIndexOf('/');
  if (separator < 0) return null;
  const packageDigest = rest.slice(0, separator);
  const pipelineKey = rest.slice(separator + 1);
  return isPipelinePackageDigest(packageDigest) &&
    isPipelinePackageIdentifier(pipelineKey)
    ? { packageDigest, pipelineKey }
    : null;
}
