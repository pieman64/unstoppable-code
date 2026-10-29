import type { JSX, ReactNode } from 'react';
import type { DataSharingOptInFeature } from '@canopy/protocol/canopy-server';
import { DataSharingOptInCta } from '@canopy/ui-shared/components/DataSharingOptInCta';
import { brandText } from '@/lib/brand';
import { optInOrganizationName } from './dataSharingOptIn';
import { useDataSharingOptIn } from './useDataSharingOptIn';

export interface DesktopDataSharingOptInProps {
  feature: DataSharingOptInFeature;
  /** The organization that owns the work, never inferred from list order. */
  organizationId: string | null;
  /** Called once per successful save, e.g. to refresh invite eligibility. */
  onEnabled?: () => void;
  /**
   * Passive hints may be dismissed and honor a saved dismissal. Blocking
   * recovery flows pass `false` so the only way forward cannot be hidden.
   */
  dismissible?: boolean;
  /**
   * Rendered instead when authoritative state is unavailable or the offer no
   * longer applies, so a blocked flow keeps its Privacy settings recovery.
   */
  fallback?: ReactNode;
  className?: string;
}

/**
 * The desktop's sole inline adapter for {@link DataSharingOptInCta}: it
 * resolves the viewer's state from authoritative preferences and policy,
 * shows the disclosure, and saves through the narrow main-owned writer.
 */
export function DesktopDataSharingOptIn({
  feature,
  organizationId,
  onEnabled,
  dismissible = true,
  fallback = null,
  className,
}: DesktopDataSharingOptInProps): JSX.Element | null {
  const { resolution, phase, enable, dismiss } = useDataSharingOptIn({
    feature,
    organizationId,
    passive: dismissible,
    onEnabled,
  });
  const productName = brandText.appName;

  // The acknowledgment outlives the preference broadcast that follows it.
  // Personal work (no organization) acknowledges the personal audience.
  if (phase.kind === 'saved') {
    if (organizationId === null) {
      return (
        <DataSharingOptInCta
          feature={feature}
          audience="personal"
          productName={productName}
          state="enabled"
          className={className}
        />
      );
    }
    return (
      <DataSharingOptInCta
        feature={feature}
        organizationName={optInOrganizationName(resolution)}
        productName={productName}
        state="enabled"
        className={className}
      />
    );
  }

  switch (resolution.kind) {
    case 'loading':
    case 'dismissed':
      return null;
    case 'unavailable':
    case 'shared':
      return <>{fallback}</>;
    case 'managed':
      return (
        <DataSharingOptInCta
          feature={feature}
          organizationName={resolution.organizationName}
          productName={productName}
          state="managed"
          className={className}
        />
      );
    case 'needs-opt-in': {
      const action = {
        kind: 'desktop' as const,
        busy: phase.kind === 'saving',
        error: phase.kind === 'error' ? phase.error : null,
        onEnable: (): void => {
          void enable();
        },
      };
      const onDismiss = dismissible
        ? (): void => {
            void dismiss();
          }
        : undefined;
      if (resolution.audience === 'personal') {
        return (
          <DataSharingOptInCta
            feature={feature}
            audience="personal"
            productName={productName}
            state="offer"
            className={className}
            summary={{ allowedScopes: resolution.allowedScopes }}
            action={action}
            onDismiss={onDismiss}
          />
        );
      }
      return (
        <DataSharingOptInCta
          feature={feature}
          organizationName={resolution.organizationName}
          productName={productName}
          state="offer"
          className={className}
          summary={{
            allowedScopes: resolution.allowedScopes,
            skippedScopes: resolution.skippedScopes,
            additionalScopes: resolution.additionalScopes,
          }}
          action={action}
          onDismiss={onDismiss}
        />
      );
    }
  }
}
