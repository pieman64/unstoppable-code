import type { JSX } from 'react';

export interface PlanProvenanceProps {
  /** The plan's source (`imported`, `claude`, `detected`, …). */
  readonly source: string | undefined;
  /** Repo-relative file an imported plan was copied from. */
  readonly sourceFilePath: string | undefined;
}

/** Whether {@link PlanProvenance} renders for this plan. */
export function hasPlanProvenance(
  source: string | undefined,
  sourceFilePath: string | undefined,
): boolean {
  return source === 'imported' && (sourceFilePath ?? '').trim().length > 0;
}

/**
 * The "Imported · <path>" line on a plan card footer, naming the file an
 * imported plan was copied from. Long paths truncate; the full path is the
 * hover title. Renders nothing for other sources or a missing path.
 */
export function PlanProvenance({
  source,
  sourceFilePath,
}: PlanProvenanceProps): JSX.Element | null {
  if (!hasPlanProvenance(source, sourceFilePath)) return null;
  return (
    <span
      data-testid="plan-provenance"
      title={sourceFilePath}
      className="min-w-0 truncate"
    >
      {`Imported · ${sourceFilePath ?? ''}`}
    </span>
  );
}
