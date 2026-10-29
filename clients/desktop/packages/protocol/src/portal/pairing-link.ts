/**
 * Remote Control pairing link (CAN-2938).
 *
 * The desktop renders this URL as a QR code next to its 6-digit pairing code.
 * A phone's camera opens it in the browser, where the web app reads the code
 * and redeems it through the same `POST .../portal/browser/connect` call the
 * manual code form uses — so every existing protection (account binding,
 * desktop-side validation, single use, the 10-minute expiry, and the
 * per-account failure rate limit) still applies unchanged.
 *
 * The code rides in the URL FRAGMENT on purpose. Browsers never send a
 * fragment to the server, in a `Referer` header, or through redirects' server
 * logs, so the code reaches only the page script that redeems it.
 */

/**
 * Pattern used by `POST /api/portal/connect` to validate the user-supplied
 * pairing code before any DB / fan-out work occurs. The browser route handler,
 * shared validation helpers, and any UI input mask MUST all use this exact
 * pattern so the rules match.
 */
export const PORTAL_PAIRING_CODE_PATTERN = /^\d{6}$/;

/** Web page a scanned pairing QR code opens. */
export const REMOTE_CONTROL_PAIRING_PATH = '/portal/pair';

/** Fragment parameter carrying the pairing code. */
const PAIRING_CODE_FRAGMENT_PARAM = 'code';

/**
 * Builds the pairing URL for `code` on the origin of `cloudBaseUrl`.
 *
 * Returns `null` for a malformed code or a base URL that is not an
 * http(s) URL, so callers render no QR code rather than a dead one. Any
 * path, query, or fragment on the base URL is discarded: only its origin is
 * meaningful.
 */
export function buildRemoteControlPairingUrl(
  cloudBaseUrl: string,
  code: string,
): string | null {
  if (!PORTAL_PAIRING_CODE_PATTERN.test(code)) return null;
  let base: URL;
  try {
    base = new URL(cloudBaseUrl);
  } catch {
    return null;
  }
  if (base.protocol !== 'https:' && base.protocol !== 'http:') return null;
  const fragment = new URLSearchParams({ [PAIRING_CODE_FRAGMENT_PARAM]: code });
  return `${base.origin}${REMOTE_CONTROL_PAIRING_PATH}#${fragment.toString()}`;
}

/**
 * Reads the pairing code from a pairing URL's fragment (`location.hash`,
 * with or without its leading `#`). Returns `null` unless the fragment holds
 * exactly one well-formed code.
 */
export function readRemoteControlPairingCode(fragment: string): string | null {
  const params = new URLSearchParams(
    fragment.startsWith('#') ? fragment.slice(1) : fragment,
  );
  const codes = params.getAll(PAIRING_CODE_FRAGMENT_PARAM);
  if (codes.length !== 1) return null;
  const [code] = codes;
  return code !== undefined && PORTAL_PAIRING_CODE_PATTERN.test(code)
    ? code
    : null;
}
