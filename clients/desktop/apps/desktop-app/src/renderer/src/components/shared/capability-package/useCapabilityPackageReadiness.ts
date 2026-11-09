import { useEffect, useState } from 'react';
import type {
  PipelineLookupRequest,
  PipelinePackageReadiness as PipelinePackageReadinessData,
} from '@canopy/execution-engine/types/pipeline';
import type { PipelinePackageRef } from '@canopy/protocol/pipelines';
import { isPipelinePackageRunBlocked } from '@canopy/desktop-shared/pipelines/package-readiness';

/**
 * Local readiness of a pipeline's packaged content, plus the pure Run-gating
 * predicate derived from it. The predicate itself now lives in
 * `@canopy/desktop-shared` so Electron main can apply the identical rule when
 * Remote Control dispatches a pipeline the renderer never opened (CAN-3021);
 * it is re-exported here because this is where every renderer caller looks.
 */
export { isPipelinePackageRunBlocked };

export type CapabilityPackageReadinessOwner =
  | { kind: 'pipeline'; pipeline: PipelineLookupRequest }
  | {
      kind: 'automation';
      remoteId: string;
      packageRef: PipelinePackageRef;
      /** Where the automation came from; absent means a team share. */
      source?: 'shared' | 'public' | 'curated';
      /** @deprecated Use `source: 'public'`. */
      publicShare?: boolean;
    };

/**
 * Loads readiness for the selected pipeline. Resolves to `null` whenever the
 * running app has no readiness IPC or the pipeline has no package, so callers
 * degrade to today's unblocked behavior instead of a false "setup required".
 */
export function useCapabilityPackageReadiness(
  owner: CapabilityPackageReadinessOwner | null,
): { readiness: PipelinePackageReadinessData | null; loading: boolean } {
  const [readiness, setReadiness] =
    useState<PipelinePackageReadinessData | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!owner) {
      setReadiness(null);
      setLoading(false);
      return undefined;
    }
    let cancelled = false;
    setLoading(true);
    let operation: Promise<PipelinePackageReadinessData | null>;
    if (owner.kind === 'pipeline') {
      const getPackageReadiness = window.pipelines.getPackageReadiness?.bind(
        window.pipelines,
      );
      if (!getPackageReadiness) {
        setReadiness(null);
        setLoading(false);
        return undefined;
      }
      operation = getPackageReadiness({ pipeline: owner.pipeline }).then(
        (result) => (result.success && result.data ? result.data : null),
      );
    } else {
      const getPackageReadiness =
        window.api.automations.getCapabilityPackageReadiness?.bind(
          window.api.automations,
        );
      if (!getPackageReadiness) {
        setReadiness({ status: 'invalid', requirements: [] });
        setLoading(false);
        return undefined;
      }
      operation = getPackageReadiness({
        remoteId: owner.remoteId,
        packageRef: owner.packageRef,
        ...(owner.source !== undefined ? { source: owner.source } : {}),
        ...(owner.publicShare ? { publicShare: true } : {}),
      });
    }
    void operation
      .then((result) => {
        if (cancelled) return;
        setReadiness(result);
      })
      .catch(() => {
        if (!cancelled) {
          setReadiness(
            owner.kind === 'automation'
              ? { status: 'invalid', requirements: [] }
              : null,
          );
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return (): void => {
      cancelled = true;
    };
  }, [owner]);

  return { readiness, loading };
}
