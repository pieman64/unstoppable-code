/** Where the desktop's account proxy accounts are fixed, as chat errors name it. */
export const ACCOUNT_PROXY_SETTINGS_REFERENCE =
  'Settings > Multi-account proxy';

/**
 * Whether a chat error row is the desktop's own "the account proxy has no
 * account that can run this" failure, which only proxy settings can fix.
 * The desktop writes that message with the reference above, so the match is
 * on Canopy's copy, never on provider text.
 */
export function isAccountProxySettingsFailure(text: string): boolean {
  return (
    text.includes('account proxy') &&
    text.includes(ACCOUNT_PROXY_SETTINGS_REFERENCE)
  );
}
