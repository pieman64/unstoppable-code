import type { JSX } from 'react';
import {
  dataSharingFeatureCaption,
  getDataSharingFeatures,
  type DataSharingScopeKey,
} from '../lib/data-sharing-features';

export interface DataSharingFeaturePillsProps {
  /** Which scope's feature list to render. */
  scope: DataSharingScopeKey;
  /**
   * Whether this scope's data is currently being shared. Drives the whole
   * treatment: `true` reads "Powers <features>" in active pills, `false` reads
   * "Enables <features>" in muted pills, naming what sharing would add.
   */
  sharing: boolean;
  /**
   * Include features that only an org prohibition withholds. Pass `false` from
   * the member-side desktop surfaces so a member's own Transcripts-off does not
   * claim sharing enables `Shared runs`: their own run share bypasses the
   * ambient gate regardless.
   */
  includeEnforcementOnly?: boolean;
  /** Test ID hook; the caption and each pill derive their own ids from it. */
  dataTestId?: string;
  className?: string;
}

/**
 * The "what this powers / what sharing enables" pill row rendered beneath a
 * data-sharing scope. Shared verbatim by the web org Settings card and the
 * desktop Privacy tab / Cloud sync modal so the admin deciding a policy and the
 * member living with it read the same consequences.
 *
 * Pure display: it derives everything from {@link getDataSharingFeatures} and
 * the `sharing` flag, and never fetches or reads a store.
 */
export function DataSharingFeaturePills({
  scope,
  sharing,
  includeEnforcementOnly = true,
  dataTestId,
  className,
}: DataSharingFeaturePillsProps): JSX.Element | null {
  const features = getDataSharingFeatures(scope, { includeEnforcementOnly });
  if (features.length === 0) {
    return null;
  }

  const caption = dataSharingFeatureCaption(sharing);

  return (
    <div
      className={`flex flex-wrap items-center gap-1.5 ${className ?? ''}`}
      data-testid={dataTestId}
      data-sharing={sharing ? 'true' : 'false'}
    >
      <span className="text-3xs font-medium fg-secondary">{caption}</span>
      {/*
        A bare `span` rather than `StatusBadge`: these pills carry the ACCENT
        palette (muted in the off state), not the operational
        status palette, so every one of `StatusBadge`'s variants would be
        overridden by the `className` it needs anyway — leaving `variant` and
        `muted` as props that look like they drive the styling and do not.
      */}
      {features.map((entry) => (
        <span
          key={entry.id}
          data-testid={
            dataTestId ? `${dataTestId}-pill-${entry.id}` : undefined
          }
          className={`inline-flex shrink-0 rounded-full px-2 py-0.5 text-3xs font-medium ${
            sharing
              ? 'bg-accent-subtle fg-accent'
              : 'bg-secondary/60 fg-secondary'
          }`}
        >
          {entry.label}
        </span>
      ))}
    </div>
  );
}
