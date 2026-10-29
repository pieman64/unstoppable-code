import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type {
  PipelinePackageCapabilityOverlay,
  PipelinePackageExecutionSnapshot,
} from '../../types/pipeline';
import type { PipelinePackageManifestV1 } from '@canopy/protocol/pipelines';
import {
  CAPABILITY_PACKAGE_SUBJECT_BINDING_KEY,
  capabilityPackageBindingKey,
  capabilityPackageStepBindingKey,
} from '@canopy/protocol/pipelines';
import { assertPipelinePackageMatchesYaml } from './package-contract';
import { verifyCachedPipelinePackage } from './package-cache';

export function buildPipelinePackageOverlay(
  packageDigest: string,
  packagePath: string,
  manifest: PipelinePackageManifestV1,
): PipelinePackageCapabilityOverlay {
  return {
    packageDigest,
    resources: manifest.resources.flatMap((resource) =>
      resource.trees.map((tree) => ({
        ...(resource.installedItemRef
          ? { installedItemRef: resource.installedItemRef }
          : {}),
        virtualSourceId: `pipeline-package:${packageDigest}/${resource.id}`,
        resourceId: resource.id,
        provider: tree.provider,
        rootPath: path.join(
          packagePath,
          'materialized',
          resource.id,
          tree.provider,
          tree.rootName,
        ),
        kind: resource.kind,
        displayName: resource.displayName,
        invocationKeys: resource.invocationKeys,
      })),
    ),
  };
}

export async function snapshotPipelinePackageForExecution(input: {
  digest: string;
  rawPipeline: string;
  manifest: PipelinePackageManifestV1;
  cachedPackagePath: string;
  executionDirectory: string;
}): Promise<PipelinePackageExecutionSnapshot> {
  assertPipelinePackageMatchesYaml(input.manifest, input.rawPipeline);
  const destination = path.join(input.executionDirectory, 'pipeline-package');
  await fs.cp(input.cachedPackagePath, destination, {
    recursive: true,
    force: false,
    errorOnExist: true,
  });
  return {
    digest: input.digest,
    pipelineContentHash: input.manifest.pipelineContentHash,
    cachedPackagePath: destination,
    bindings: input.manifest.bindings,
    capturedAt: new Date().toISOString(),
  };
}

export async function loadPipelinePackageExecutionOverlay(
  snapshot: PipelinePackageExecutionSnapshot | undefined,
): Promise<PipelinePackageCapabilityOverlay | undefined> {
  if (!snapshot) return undefined;
  const manifest = await verifyCachedPipelinePackage(
    snapshot.cachedPackagePath,
    snapshot.digest,
  );
  if (
    !manifest ||
    manifest.pipelineContentHash !== snapshot.pipelineContentHash ||
    JSON.stringify(manifest.bindings) !== JSON.stringify(snapshot.bindings)
  ) {
    throw new Error('Pipeline package execution snapshot is invalid');
  }
  return buildPipelinePackageOverlay(
    snapshot.digest,
    snapshot.cachedPackagePath,
    manifest,
  );
}

export async function copyPipelinePackageExecutionSnapshot(input: {
  snapshot: PipelinePackageExecutionSnapshot;
  executionDirectory: string;
}): Promise<PipelinePackageExecutionSnapshot> {
  await loadPipelinePackageExecutionOverlay(input.snapshot);
  const destination = path.join(input.executionDirectory, 'pipeline-package');
  await fs.cp(input.snapshot.cachedPackagePath, destination, {
    recursive: true,
    force: false,
    errorOnExist: true,
  });
  return {
    ...input.snapshot,
    cachedPackagePath: destination,
    capturedAt: new Date().toISOString(),
  };
}

export function resourceIdsForPipelineStep(
  manifest: PipelinePackageManifestV1,
  jobId: string,
  stepId: string,
): string[] {
  return resourceIdsForBindingKey(
    manifest,
    capabilityPackageStepBindingKey(jobId, stepId),
  );
}

/** Resources a step-less subject (a skill, Agent, Collection, Blueprint) binds. */
export function resourceIdsForPackageSubject(
  manifest: PipelinePackageManifestV1,
): string[] {
  return resourceIdsForBindingKey(
    manifest,
    CAPABILITY_PACKAGE_SUBJECT_BINDING_KEY,
  );
}

export function resourceIdsForBindingKey(
  manifest: PipelinePackageManifestV1,
  bindingKey: string,
): string[] {
  return (
    manifest.bindings.find(
      (binding) => capabilityPackageBindingKey(binding) === bindingKey,
    )?.resourceIds ?? []
  );
}

export function filterPipelinePackageOverlayForStep(
  overlay: PipelinePackageCapabilityOverlay,
  bindings: PipelinePackageManifestV1['bindings'],
  jobId: string,
  stepId: string,
): PipelinePackageCapabilityOverlay | undefined {
  return filterPackageOverlayForBindingKey(
    overlay,
    bindings,
    capabilityPackageStepBindingKey(jobId, stepId),
  );
}

/** Overlay a step-less subject sees: everything its whole-share binding named. */
export function filterPackageOverlayForSubject(
  overlay: PipelinePackageCapabilityOverlay,
  bindings: PipelinePackageManifestV1['bindings'],
): PipelinePackageCapabilityOverlay | undefined {
  return filterPackageOverlayForBindingKey(
    overlay,
    bindings,
    CAPABILITY_PACKAGE_SUBJECT_BINDING_KEY,
  );
}

export function filterPackageOverlayForBindingKey(
  overlay: PipelinePackageCapabilityOverlay,
  bindings: PipelinePackageManifestV1['bindings'],
  bindingKey: string,
): PipelinePackageCapabilityOverlay | undefined {
  const resourceIds = new Set(
    bindings.find(
      (binding) => capabilityPackageBindingKey(binding) === bindingKey,
    )?.resourceIds ?? [],
  );
  const resources = overlay.resources.filter((resource) =>
    resourceIds.has(resource.resourceId),
  );
  return resources.length > 0
    ? { packageDigest: overlay.packageDigest, resources }
    : undefined;
}
