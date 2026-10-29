import {
  parseSettingsRoutePath,
  settingsRouteToPath,
  type SettingsRoute,
} from '@canopy/protocol/settings';

/**
 * Where the desktop Settings overlay is in hosted account and organization
 * settings: a validated route plus the page-owned URL state the web keeps in
 * its address bar (Statistics filters, memory `?source=`, `?joined=1`, the
 * fragment). The route is the destination; `search` and `hash` belong to the
 * page that reads them through `useSettingsSearchParams`.
 */
export interface HostedSettingsLocation {
  readonly route: SettingsRoute;
  /** Query string without the leading `?`. May repeat the route's `tab`. */
  readonly search: string;
  /** Fragment without the leading `#`. */
  readonly hash: string;
  /**
   * Shown above the Organizations list after a deep link named an
   * organization the viewer is not a member of.
   */
  readonly notice?: 'access-lost';
}

export interface HostedSettingsLocationOptions {
  readonly search?: string;
  readonly hash?: string;
  readonly notice?: 'access-lost';
}

function stripPrefix(value: string | undefined, prefix: string): string {
  if (value === undefined) return '';
  return value.startsWith(prefix) ? value.slice(prefix.length) : value;
}

export function hostedSettingsLocation(
  route: SettingsRoute,
  options: HostedSettingsLocationOptions = {},
): HostedSettingsLocation {
  return {
    route,
    search: stripPrefix(options.search, '?'),
    hash: stripPrefix(options.hash, '#'),
    ...(options.notice === undefined ? {} : { notice: options.notice }),
  };
}

/** The route's web path without its query (`/organization/<id>/settings`). */
export function hostedSettingsPathname(route: SettingsRoute): string {
  return settingsRouteToPath(route).split('?', 1)[0] ?? '';
}

/** Stable identity of a location's route (its canonical web path). */
export function hostedSettingsRouteKey(route: SettingsRoute): string {
  return settingsRouteToPath(route);
}

export function sameHostedSettingsLocation(
  left: HostedSettingsLocation | null,
  right: HostedSettingsLocation | null,
): boolean {
  if (left === null || right === null) return left === right;
  return (
    hostedSettingsRouteKey(left.route) ===
      hostedSettingsRouteKey(right.route) &&
    left.search === right.search &&
    left.hash === right.hash &&
    left.notice === right.notice
  );
}

/**
 * The query a page reads: the route's own query (the Settings `tab`) first,
 * then the page-owned parameters, without repeating a route parameter.
 */
export function hostedSettingsSearchParams(
  location: HostedSettingsLocation | null,
): URLSearchParams {
  if (location === null) return new URLSearchParams();
  const routeQuery = settingsRouteToPath(location.route).split('?')[1] ?? '';
  const params = new URLSearchParams(routeQuery);
  const routeKeys = new Set(params.keys());
  new URLSearchParams(location.search).forEach((value, key) => {
    if (!routeKeys.has(key)) params.append(key, value);
  });
  return params;
}

/** How the desktop host follows a link a shared settings page renders. */
export type HostedSettingsLinkTarget =
  | { readonly kind: 'settings'; readonly location: HostedSettingsLocation }
  | { readonly kind: 'external'; readonly url: string }
  | { readonly kind: 'none' };

/**
 * Placeholder origin for resolving relative links before the configured web
 * origin is known. Never opened: a link that resolves to it and is not a
 * settings route is dropped.
 */
const UNRESOLVED_ORIGIN = 'https://settings.invalid';

const EXTERNAL_PROTOCOLS: ReadonlySet<string> = new Set([
  'https:',
  'http:',
  'mailto:',
]);

function parseUrl(href: string, base: string): URL | null {
  try {
    return new URL(href, base);
  } catch {
    return null;
  }
}

function trimOrigin(origin: string): string {
  return origin.replace(/\/+$/, '');
}

/**
 * Resolve an `href` from shared settings UI. Web settings paths (relative or
 * on the web origin) stay inside the Settings overlay, keeping their query and
 * fragment as page state. Any other web path opens on the web origin, and
 * absolute `http(s)` and `mailto` URLs open externally. Everything else
 * (`javascript:`, `file:`, unresolvable input) does nothing.
 *
 * `currentPath` resolves relative links (`?tab=usage`, `#members`) against
 * the page on screen.
 */
export function resolveHostedSettingsHref(
  href: string,
  webOrigin: string,
  currentPath: string,
): HostedSettingsLinkTarget {
  const origin = trimOrigin(webOrigin);
  const base = origin === '' ? UNRESOLVED_ORIGIN : origin;
  const baseUrl = parseUrl(currentPath || '/', base);
  const url = baseUrl === null ? null : parseUrl(href, baseUrl.href);
  if (url === null) return { kind: 'none' };
  const baseOrigin = parseUrl(base, base)?.origin ?? '';
  if (url.origin === baseOrigin) {
    const route = parseSettingsRoutePath(url.pathname, url.search);
    if (route !== null)
      return {
        kind: 'settings',
        location: hostedSettingsLocation(route, {
          search: url.search,
          hash: url.hash,
        }),
      };
    if (origin === '') return { kind: 'none' };
    return { kind: 'external', url: url.href };
  }
  if (!EXTERNAL_PROTOCOLS.has(url.protocol)) return { kind: 'none' };
  return { kind: 'external', url: url.href };
}

/**
 * Hosted settings history while Settings is open: Back returns to the
 * previous hosted destination. Bounded so a long session cannot grow it.
 */
export const HOSTED_SETTINGS_HISTORY_LIMIT = 50;

export function pushHostedSettingsHistory(
  history: readonly HostedSettingsLocation[],
  current: HostedSettingsLocation | null,
  next: HostedSettingsLocation,
): readonly HostedSettingsLocation[] {
  if (current === null || sameHostedSettingsLocation(current, next))
    return history;
  const pushed = [...history, current];
  return pushed.length > HOSTED_SETTINGS_HISTORY_LIMIT
    ? pushed.slice(pushed.length - HOSTED_SETTINGS_HISTORY_LIMIT)
    : pushed;
}

/** The Organizations list, where Back lands without hosted history. */
export const ORGANIZATIONS_LIST_LOCATION: HostedSettingsLocation =
  hostedSettingsLocation({ scope: 'organizations' });
