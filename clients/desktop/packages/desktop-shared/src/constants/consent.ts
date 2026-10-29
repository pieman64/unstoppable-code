/**
 * Guest-consent versioning (CAN-934 / CAN-936).
 *
 * `CONSENT_TOS_VERSION` is a genuine version marker recorded alongside the
 * guest consent (`PreferencesData.guestConsentTosVersion`). Bump it whenever the
 * Terms of Service / telemetry-disclosure copy shown on the first-run legal
 * consent gate changes materially, so a future revision can re-prompt only the
 * users who agreed to an older version.
 *
 * This module is intentionally copy-free (only the version marker lives here);
 * the user-visible legal text lives in the renderer's `LegalConsentGate`
 * component and must come from the brand runtime per the branding rules. Guests
 * are minted silently against that accepted legal consent (CAN-936), so there is
 * no separate guest-consent screen.
 */
export const CONSENT_TOS_VERSION = '2026-07-06';

/**
 * Consent payload recorded when a guest session is minted. The desktop persists
 * this locally (in preferences); the web guest-mint endpoint does not receive
 * the consent record.
 */
export interface CanopyGuestConsent {
  /** ISO-8601 timestamp of when the user accepted consent. */
  acceptedAt: string;
  /** The `CONSENT_TOS_VERSION` the user agreed to. */
  tosVersion: string;
}
