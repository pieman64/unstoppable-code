import { useEffect, useRef, useState } from 'react';
import type { PipelinePackageReadiness } from '@canopy/execution-engine/types/pipeline';
import type { SkillDependencyRef } from '@canopy/desktop-shared/types/skills';
import { skillDependenciesToEnvironmentRequirements } from '@canopy/protocol/skills';

/**
 * Whether this machine has what a shared skill names, for the landing a
 * recipient sees before installing it. `null` while the check runs, and when
 * the skill names nothing.
 *
 * A check that fails still lists every requirement, as `unknown`, rather than
 * hiding the list: the recipient must always see what the skill uses.
 */
export function useSkillDependencyReadiness(
  dependencies: readonly SkillDependencyRef[] | null,
): PipelinePackageReadiness | null {
  const [readiness, setReadiness] = useState<PipelinePackageReadiness | null>(
    null,
  );
  // The snapshot hands over a fresh array on every render; key the effect on
  // its content so the check runs once per share, not once per render.
  const key = dependencies === null ? null : JSON.stringify(dependencies);
  const latest = useRef(dependencies);
  latest.current = dependencies;

  useEffect(() => {
    setReadiness(null);
    const requested = latest.current === null ? [] : [...latest.current];
    if (key === null || requested.length === 0) return undefined;
    let cancelled = false;
    const unknown = (): PipelinePackageReadiness => ({
      status: 'ready',
      requirements: skillDependenciesToEnvironmentRequirements(requested).map(
        (requirement) => ({ ...requirement, status: 'unknown' }),
      ),
    });
    window.skills.getDependencyReadiness({ dependencies: requested }).then(
      (result) => {
        if (!cancelled) setReadiness(result);
      },
      () => {
        if (!cancelled) setReadiness(unknown());
      },
    );
    return (): void => {
      cancelled = true;
    };
  }, [key]);

  return readiness;
}
