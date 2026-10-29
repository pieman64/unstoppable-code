import {
  classifyInAppBrowserInput,
  type InAppBrowserInputVerdict,
} from '@canopy/desktop-shared/lib/browser-url-policy';

// ---------------------------------------------------------------------------
// In-app browser URL policy (renderer entry point)
// ---------------------------------------------------------------------------
//
// The policy itself lives in `@canopy/desktop-shared/lib/browser-url-policy`
// and is shared verbatim with the main process, so the Browser bar's inline
// feedback and the authoritative gate can never drift. This module only adds
// the renderer-only pieces: the user-facing copy and the
// `string | null` shape existing callers expect.

export {
  classifyInAppBrowserInput,
  isAllowedInAppBrowserUrl,
  isFileBrowserUrl,
  isSafeExternalBrowserUrl,
  normalizeBrowserUrlInput,
  sameBrowserUrl,
  type InAppBrowserInputVerdict,
} from '@canopy/desktop-shared/lib/browser-url-policy';

/**
 * Field validation shown in the Browser bar when the typed value is not
 * something the in-app browser can open.
 */
export const IN_APP_BROWSER_INVALID_URL_MESSAGE =
  'Enter an http or https URL, or the full path to a local file.';

/**
 * Field validation shown when local-only browsing is on and the typed value is
 * a remote http(s) URL. Local files still open in this mode, so the copy must
 * not claim otherwise.
 */
export const IN_APP_BROWSER_LOCAL_ONLY_URL_MESSAGE =
  'Enter a localhost URL or the full path to a local file while local-only browsing is on.';

/**
 * Field validation for a network share path (`\\\\server\\share\\page.html` or
 * `file://server/...`). Reading another host is a network fetch, not a local
 * file, so the in-app browser refuses it in both modes.
 */
export const IN_APP_BROWSER_NETWORK_PATH_URL_MESSAGE =
  'Enter a path on this computer, not a network share.';

/** Placeholder shown in the Browser bar URL input. */
export const IN_APP_BROWSER_URL_PLACEHOLDER = 'http://localhost:3000/';

/**
 * The user-facing message for a refused Browser-bar value. `ok` verdicts have
 * no message, so callers narrow before reaching here.
 */
export function inAppBrowserInputMessage(
  verdict: Exclude<InAppBrowserInputVerdict, { kind: 'ok' }>,
): string {
  switch (verdict.kind) {
    case 'blocked-by-local-only':
      return IN_APP_BROWSER_LOCAL_ONLY_URL_MESSAGE;
    case 'network-path':
      return IN_APP_BROWSER_NETWORK_PATH_URL_MESSAGE;
    default:
      return IN_APP_BROWSER_INVALID_URL_MESSAGE;
  }
}

/**
 * Normalize a user-typed Browser-bar value into a loadable URL, or return
 * `null` when it cannot be opened in-app. A missing scheme is treated as
 * `http://` so users can type `localhost:3000`; an absolute filesystem path
 * becomes a `file:` URL rather than being sent to a DNS resolver.
 */
export function normalizeInAppBrowserInput(
  raw: string,
  localServersOnly: boolean,
): string | null {
  const verdict = classifyInAppBrowserInput(raw, localServersOnly);
  return verdict.kind === 'ok' ? verdict.url : null;
}

/**
 * Where a page is, in a word: the host for web pages, the file name for
 * local files, and nothing for a blank tab. The address bar shows it at rest.
 */
export function browserAddressSummary(url: string): string {
  if (url.length === 0 || url === 'about:blank') {
    return '';
  }
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'file:') {
      const name = parsed.pathname.split('/').filter(Boolean).pop();
      if (name !== undefined) {
        return decodeURIComponent(name);
      }
    } else if (parsed.host.length > 0) {
      return parsed.host;
    }
  } catch {
    // Not a parseable URL; fall through to the raw value.
  }
  return url;
}

/**
 * Visible status beside the opening/first-load spinner, naming what is
 * loading: the host for web pages, the file name for local files.
 */
export function browserLoadingLabel(url: string): string {
  const summary = browserAddressSummary(url);
  return summary.length === 0 ? 'Opening Browser…' : `Loading ${summary}…`;
}
