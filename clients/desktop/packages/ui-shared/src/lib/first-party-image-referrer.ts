/**
 * Referrer policy for a remote logo `<img>`.
 *
 * Third-party logos get `no-referrer`: the visitor's page must not leak to a
 * catalog author's host. First-party catalog logos are the exception. The web
 * backend resolves their brand from the requesting page, and an `<img>`
 * request carries no `Origin`, so on the cross-origin gateway the page's
 * `Referer` origin is the only brand signal; without it the logo route
 * answers 404. `origin` sends exactly that and never the path or query.
 */
export type ImageReferrerPolicy = 'origin' | 'no-referrer';

/**
 * The first-party catalog plugin logo route, wherever it is hosted. Matching
 * the path shape (not a host) keeps this correct for brand hosts and for the
 * gateway, whose hostnames this display package must not know. The `/api` and
 * `/agent` prefixes are the local and gateway backend bases.
 */
const CATALOG_PLUGIN_LOGO_PATH =
  /^\/(?:api|agent)\/v1\/marketplace\/plugins\/[^/]+\/[^/]+\/logo$/;

// Resolution base for telling a relative reference from an absolute one.
const RELATIVE_BASE = 'http://relative.invalid';

export function imageReferrerPolicyFor(
  src: string | undefined,
): ImageReferrerPolicy {
  if (!src) return 'no-referrer';
  let url: URL;
  try {
    url = new URL(src, RELATIVE_BASE);
  } catch {
    return 'no-referrer';
  }
  // Resolving against the sentinel base keeps origin === RELATIVE_BASE only
  // for a same-origin reference (`/x`, `x`); `//host/x` and `https://...`
  // resolve elsewhere, and `data:`/`blob:` are not http(s) at all.
  if (url.origin === RELATIVE_BASE) return 'origin';
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return 'no-referrer';
  }
  return CATALOG_PLUGIN_LOGO_PATH.test(url.pathname) ? 'origin' : 'no-referrer';
}
