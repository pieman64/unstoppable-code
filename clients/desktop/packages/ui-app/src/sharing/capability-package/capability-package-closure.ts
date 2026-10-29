import type {
  PipelinePackageManifestV1,
  PipelinePackageResource,
} from '@canopy/protocol/pipelines';

/**
 * Pure derivations over a package manifest, used by the publisher's dependency
 * review to decide which rows are locked on and to explain why a private file
 * is being copied. Kept out of the component file so both stay pure and
 * independently testable.
 */

/**
 * A resource is locked on when a step binding requires it directly or
 * transitively; anything else is publisher-optional. Derived from the manifest
 * rather than a server flag so the checkbox state always matches the closure
 * actually being packaged.
 */
export function computeRequiredResourceIds(
  manifest: PipelinePackageManifestV1,
): Set<string> {
  return computeResourceClosureIds(
    manifest,
    manifest.bindings.flatMap((binding) => binding.resourceIds),
  );
}

/** Expand selected roots to the exact transitive member closure packaged. */
export function computeResourceClosureIds(
  manifest: PipelinePackageManifestV1,
  rootResourceIds: readonly string[],
): Set<string> {
  const byId = new Map<string, PipelinePackageResource>(
    manifest.resources.map((resource) => [resource.id, resource]),
  );
  const included = new Set<string>();
  const queue = [...rootResourceIds];
  while (queue.length > 0) {
    const next = queue.pop();
    if (next === undefined || included.has(next)) continue;
    const resource = byId.get(next);
    if (!resource) continue;
    included.add(next);
    queue.push(...resource.dependencyResourceIds);
  }
  return included;
}

/**
 * `Required by /review-loop → review-multi` — the shortest chain from a bound
 * invocation down to this resource, so the publisher can see *why* a private
 * file is being copied. Returns null for directly bound resources.
 */
export function describeDependencyReason(
  manifest: PipelinePackageManifestV1,
  resourceId: string,
): string | null {
  const byId = new Map<string, PipelinePackageResource>(
    manifest.resources.map((resource) => [resource.id, resource]),
  );
  const boundIds = new Set(
    manifest.bindings.flatMap((binding) => binding.resourceIds),
  );
  if (boundIds.has(resourceId)) return null;

  // Breadth-first from every directly bound resource so the reported chain is
  // the shortest explanation rather than an arbitrary walk.
  const queue: string[][] = Array.from(boundIds, (id) => [id]);
  const seen = new Set<string>(boundIds);
  while (queue.length > 0) {
    const path = queue.shift();
    if (!path) break;
    const tailId = path[path.length - 1];
    if (tailId === undefined) continue;
    const tail = byId.get(tailId);
    if (!tail) continue;
    for (const dependencyId of tail.dependencyResourceIds) {
      const nextPath = [...path, dependencyId];
      if (dependencyId === resourceId) {
        const labels = nextPath.map(
          (id) =>
            byId.get(id)?.invocationKeys[0] ?? byId.get(id)?.displayName ?? id,
        );
        return `Required by ${labels.join(' → ')}`;
      }
      if (seen.has(dependencyId)) continue;
      seen.add(dependencyId);
      queue.push(nextPath);
    }
  }
  return null;
}
