import type { SettingsNavigationPort } from './settings-navigation';

/**
 * Account-scoped persistence for the organization a viewer last browsed in
 * settings. Keys always include the account id, and every restored value is
 * validated against the current bootstrap membership before use.
 */
export interface SettingsSelectionStorage {
  readOrganizationId(accountId: string): string | null;
  writeOrganizationId(accountId: string, organizationId: string | null): void;
}

/**
 * Session-replay privacy class names. Desktop supplies its replay tool's
 * block and mask classes; web supplies empty strings.
 */
export interface SettingsReplayPrivacy {
  /** Applied to names, emails, avatars, transcripts and secrets. */
  readonly blockClassName: string;
  /** Applied to text inputs whose values must be masked. */
  readonly maskClassName: string;
}

/**
 * Framework-neutral host ports for shared settings UI. The UI package extends
 * this with its rendering ports (link and image components, the scroll
 * container and brand helpers), which need React types this package does not
 * import.
 */
export interface SettingsHostPorts {
  readonly navigation: SettingsNavigationPort;
  readonly storage: SettingsSelectionStorage;
  readonly privacy: SettingsReplayPrivacy;
  /**
   * Whether this host can open an authenticated payment handoff right now.
   * Hosts with inline checkout report `false`; payment UI then uses inline
   * checkout instead. When `false` on a host without inline checkout, payment
   * CTAs render disabled with the unavailable state up front.
   */
  readonly paymentHandoffAvailable: boolean;
}
