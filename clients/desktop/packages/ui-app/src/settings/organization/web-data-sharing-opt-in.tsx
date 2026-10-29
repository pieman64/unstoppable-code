'use client';

import { useState, type JSX } from 'react';
import {
  buildDesktopPrivacyOptInDeepLink,
  buildDesktopPrivacySettingsDeepLink,
  type DataSharingOptInFeature,
  type ViewerDataSharingStatus,
} from '@canopy/protocol';
import { DataSharingOptInCta } from '@canopy/ui-shared/components/DataSharingOptInCta';
import {
  DATA_SHARING_OPT_IN_SCOPES,
  type DataSharingScopeKey,
} from '@canopy/ui-shared/lib/data-sharing-features';
import { useSettingsBrand } from '../host';
import { useOrganizationSettingsSlots } from './organization-settings-slots';
import {
  useDataSharingOptInDismissal,
  type DataSharingOptInDismissalStore,
} from './data-sharing-opt-in-dismissal';
import type { ViewerDataSharingLoadState } from './use-viewer-data-sharing';

/**
 * What the web can say about one feature from viewer-only evidence.
 *
 * - `managed`: the organization prohibits metadata, which every feature needs.
 * - `offer`: an allowed required scope is not `shared`. That covers positive
 *   `private` evidence and `unknown` (no evidence, for example a viewer whose
 *   sharing is still Off, which is the default on every plan). The offer copy
 *   describes the desktop review without claiming what the viewer shares.
 * - `none`: every allowed required scope is already `shared`, or policy alone
 *   explains the gap (no required scope is allowed). A policy gap never
 *   produces an enable action.
 *
 * Loading and fetch errors never reach this resolver: they are separate
 * {@link ViewerDataSharingLoadState} states and render nothing.
 */
export type WebDataSharingOptInResolution =
  | { kind: 'none' }
  | { kind: 'managed' }
  | {
      kind: 'offer';
      allowedScopes: readonly DataSharingScopeKey[];
      skippedScopes: readonly DataSharingScopeKey[];
    };

export function resolveWebDataSharingOptIn(
  feature: DataSharingOptInFeature,
  status: ViewerDataSharingStatus,
): WebDataSharingOptInResolution {
  if (status.scopes.metadata === 'prohibited') {
    return { kind: 'managed' };
  }
  const required = DATA_SHARING_OPT_IN_SCOPES[feature];
  const allowedScopes = required.filter(
    (scope) => status.scopes[scope] !== 'prohibited',
  );
  const skippedScopes = required.filter(
    (scope) => status.scopes[scope] === 'prohibited',
  );
  const hasUnsharedScope = allowedScopes.some(
    (scope) => status.scopes[scope] !== 'shared',
  );
  if (!hasUnsharedScope) {
    return { kind: 'none' };
  }
  return { kind: 'offer', allowedScopes, skippedScopes };
}

interface DeepLinks {
  href: string;
  fallbackHref: string;
}

/** `null` when the scheme or organization id cannot form a valid link. */
function buildDeepLinks(
  scheme: string,
  feature: DataSharingOptInFeature,
  organizationId: string,
): DeepLinks | null {
  try {
    return {
      href: buildDesktopPrivacyOptInDeepLink(scheme, {
        feature,
        organizationId,
      }),
      fallbackHref: buildDesktopPrivacySettingsDeepLink(scheme),
    };
  } catch {
    return null;
  }
}

export interface WebDataSharingOptInProps {
  feature: DataSharingOptInFeature;
  /** Organization external UUID. */
  orgId: string;
  organizationName: string;
  /** Server-derived from the request user agent. */
  mobileBrowser: boolean;
  /** The host's single {@link useViewerDataSharing} result; never refetched. */
  sharing: ViewerDataSharingLoadState;
  className?: string;
  /** Test seam; defaults to the page-wide localStorage store. */
  dismissalStore?: DataSharingOptInDismissalStore;
}

/**
 * The web adapter for {@link DataSharingOptInCta}. Hosts call
 * `useViewerDataSharing` once and pass its state here; this component only
 * resolves that state, wires the desktop link, and persists dismissals.
 * Idle, loading, and error states render nothing; only a settled status
 * (including `unknown` evidence) can produce a hint.
 */
export function WebDataSharingOptIn({
  sharing,
  feature,
  ...rest
}: WebDataSharingOptInProps): JSX.Element | null {
  if (sharing.state !== 'ready') {
    return null;
  }
  const resolution = resolveWebDataSharingOptIn(feature, sharing.status);
  if (resolution.kind === 'none') {
    return null;
  }
  if (resolution.kind === 'managed') {
    return <ManagedHint feature={feature} {...rest} />;
  }
  return (
    <OfferHint
      // A new viewer, organization, or feature is a new hint: remounting
      // drops any awaiting-desktop state that belonged to the old identity.
      key={`${sharing.status.viewerUserId}:${rest.orgId}:${feature}`}
      feature={feature}
      viewerUserId={sharing.status.viewerUserId}
      allowedScopes={resolution.allowedScopes}
      skippedScopes={resolution.skippedScopes}
      {...rest}
    />
  );
}

/**
 * The opt-in hint the shared organization pages mount: the host's inline
 * opt-in when it supplies one, otherwise the web's desktop handoff.
 */
export function OrganizationDataSharingOptIn(
  props: WebDataSharingOptInProps,
): JSX.Element | null {
  const { DataSharingOptIn } = useOrganizationSettingsSlots();
  if (DataSharingOptIn === undefined) {
    return <WebDataSharingOptIn {...props} />;
  }
  return (
    <DataSharingOptIn
      feature={props.feature}
      organizationId={props.orgId}
      className={props.className}
    />
  );
}

type HintProps = Omit<WebDataSharingOptInProps, 'sharing'>;

function ManagedHint({
  feature,
  organizationName,
  className,
}: HintProps): JSX.Element {
  const brand = useSettingsBrand();
  return (
    <DataSharingOptInCta
      state="managed"
      feature={feature}
      organizationName={organizationName}
      productName={brand.displayName}
      className={className}
    />
  );
}

interface OfferHintProps extends HintProps {
  viewerUserId: string;
  allowedScopes: readonly DataSharingScopeKey[];
  skippedScopes: readonly DataSharingScopeKey[];
}

function OfferHint({
  feature,
  orgId,
  organizationName,
  mobileBrowser,
  className,
  dismissalStore,
  viewerUserId,
  allowedScopes,
  skippedScopes,
}: OfferHintProps): JSX.Element | null {
  const brand = useSettingsBrand();
  const { dismissed, dismiss } = useDataSharingOptInDismissal(
    { viewerUserId, organizationId: orgId, feature },
    dismissalStore,
  );
  // Set only by following the desktop link. It never means the desktop saved
  // anything: the web has no way to know, so it keeps the fallback in view.
  const [awaitingDesktop, setAwaitingDesktop] = useState(false);
  const links = mobileBrowser
    ? null
    : buildDeepLinks(brand.internalName, feature, orgId);

  if (awaitingDesktop && links !== null) {
    return (
      <DataSharingOptInCta
        state="awaiting-desktop"
        feature={feature}
        organizationName={organizationName}
        productName={brand.displayName}
        fallbackHref={links.fallbackHref}
        className={className}
      />
    );
  }
  if (dismissed || (!mobileBrowser && links === null)) {
    return null;
  }
  return (
    <DataSharingOptInCta
      state="offer"
      feature={feature}
      organizationName={organizationName}
      productName={brand.displayName}
      className={className}
      summary={{ allowedScopes, skippedScopes }}
      action={
        links === null
          ? { kind: 'mobile' }
          : {
              kind: 'web',
              href: links.href,
              fallbackHref: links.fallbackHref,
              onActivate: (): void => setAwaitingDesktop(true),
            }
      }
      onDismiss={dismiss}
    />
  );
}
