import { createHash } from 'node:crypto';
import {
  canonicalizePipelinePackageManifest,
  isPipelinePackageDigest,
  validatePipelinePackageManifest,
  type PipelinePackageManifestV1,
} from '@canopy/protocol/pipelines';

export function hashPipelinePackageYaml(rawPipeline: string): string {
  return createHash('sha256').update(rawPipeline).digest('hex');
}

export function computePipelinePackageDigestSync(
  manifest: PipelinePackageManifestV1,
): string {
  const digest = createHash('sha256')
    .update(canonicalizePipelinePackageManifest(manifest))
    .digest('base64url');
  return `pp:v1:${digest}`;
}

export function assertValidPipelinePackage(
  manifestValue: unknown,
  expectedDigest?: string,
): asserts manifestValue is PipelinePackageManifestV1 {
  const validation = validatePipelinePackageManifest(manifestValue);
  if (!validation.ok) {
    throw new Error(
      `Invalid pipeline package: ${validation.errors.join('; ')}`,
    );
  }
  const manifest = manifestValue as PipelinePackageManifestV1;
  const digest = computePipelinePackageDigestSync(manifest);
  if (
    expectedDigest !== undefined &&
    (!isPipelinePackageDigest(expectedDigest) || expectedDigest !== digest)
  ) {
    throw new Error('Pipeline package digest mismatch');
  }
}

/**
 * The package carries this pipeline: it is keyed to its YAML, or (an
 * automation package) it holds the YAML as an `automation_pipeline` resource.
 * A dependency pipeline an automation install materialized runs under the
 * automation's package, whose top-level hash is the automation's own.
 */
export function pipelinePackageCarriesPipeline(
  manifest: PipelinePackageManifestV1,
  pipelineContentHash: string,
): boolean {
  return (
    manifest.pipelineContentHash === pipelineContentHash ||
    manifest.resources.some(
      (resource) =>
        resource.kind === 'automation_pipeline' &&
        resource.pipelineContentHash === pipelineContentHash,
    )
  );
}

export function assertPipelinePackageMatchesYaml(
  manifest: PipelinePackageManifestV1,
  rawPipeline: string,
): void {
  if (
    !pipelinePackageCarriesPipeline(
      manifest,
      hashPipelinePackageYaml(rawPipeline),
    )
  ) {
    throw new Error(
      'Pipeline package content hash does not match the pipeline YAML',
    );
  }
}
