import {
  parseSettingsRoutePath,
  type SettingsRoute,
} from '@canopy/protocol/settings';

/**
 * Split a pathname into its non-empty segments, ignoring any query or hash a
 * caller left on it. Matching on whole segments keeps `/accounting` from
 * borrowing `/account`'s rows.
 */
export function pathSegments(pathname: string | null | undefined): string[] {
  if (!pathname) return [];
  const path = pathname.split(/[?#]/, 1)[0] ?? '';
  return path.split('/').filter((segment) => segment !== '');
}

/**
 * The settings route a pathname (optionally carrying its query) names, or
 * `null` outside account and organization settings.
 */
export function parseSettingsPathname(
  pathname: string | null | undefined,
): SettingsRoute | null {
  if (!pathname) return null;
  const [path = '', ...rest] = pathname.split('?');
  const search = rest.join('?').split('#', 1)[0] ?? '';
  return parseSettingsRoutePath(path.split('#', 1)[0] ?? '', search);
}
