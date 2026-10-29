import { parseSettingsRoutePath } from '@canopy/protocol/settings';

/**
 * Returns the settings path (with query and fragment) for a link to a web
 * account or organization settings page on the configured web origin, or
 * `null` for any other link. The main-process twin of the renderer's
 * `resolveHostedSettingsHref` origin check; the route grammar stays owned by
 * `parseSettingsRoutePath`.
 */
export function resolveWebSettingsLink(
  url: string,
  webOrigin: string,
): string | null {
  let link: URL;
  let origin: URL;
  try {
    link = new URL(url);
    origin = new URL(webOrigin);
  } catch {
    return null;
  }
  if (link.protocol !== 'http:' && link.protocol !== 'https:') return null;
  if (link.origin !== origin.origin) return null;
  if (parseSettingsRoutePath(link.pathname, link.search) === null) return null;
  return `${link.pathname}${link.search}${link.hash}`;
}
