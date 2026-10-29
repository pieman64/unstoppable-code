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

export function assertPipelinePackageMatchesYaml(
  manifest: PipelinePackageManifestV1,
  rawPipeline: string,
): void {
  if (manifest.pipelineContentHash !== hashPipelinePackageYaml(rawPipeline)) {
    throw new Error(
      'Pipeline package content hash does not match the pipeline YAML',
    );
  }
}
