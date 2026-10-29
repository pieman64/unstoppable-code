import type {
  SettingsPaymentHandoffIntent,
  SettingsPaymentHandoffResult,
  SettingsPaymentOwner,
  SettingsRoute,
} from '@canopy/protocol/settings';

/** Providers whose sign-in linking leaves the settings surface. */
export type SettingsOAuthProvider = 'github' | 'google';

/**
 * How shared settings UI moves between pages and leaves the surface. Web
 * implements it over the Next router; desktop over its navigation store and
 * preload bridge. Shared components never inspect which host they run in.
 */
export interface SettingsNavigationPort {
  /** Push a settings destination. */
  navigate(route: SettingsRoute): void;
  /** Replace the current destination without a history entry (subtabs). */
  replaceQuery(route: SettingsRoute): void;
  /** Contextual return, for detail pages. */
  back(): void;
  /** A link target for the route, used for anchors and copy-link actions. */
  href(route: SettingsRoute): string;
  /** Open a guarded external URL (public profiles, third parties). */
  openExternal(url: string): void;
  /** Start a provider sign-in or link flow in the browser. */
  openOAuth(provider: SettingsOAuthProvider): void;
  /**
   * Open the owner's web billing page with the intended modal already open.
   * Only hosts without inline checkout implement a real handoff.
   */
  openPaymentHandoff(
    owner: SettingsPaymentOwner,
    intent: SettingsPaymentHandoffIntent,
  ): Promise<SettingsPaymentHandoffResult>;
}
