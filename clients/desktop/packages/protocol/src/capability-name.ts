/**
 * Reduce a server name to something comparable with a catalog display name.
 *
 * Takes the last colon-delimited segment, since providers namespace plugin
 * servers (`plugin:slack:slack`), then strips case and punctuation. Kept
 * deliberately strict — a loose match would claim a user already has a
 * capability they do not, which is worse than offering a redundant connect.
 *
 * Shared rather than duplicated: it is half of the `ProviderAlternateRoute`
 * wire contract, produced in the main process and compared in the renderer, so
 * two copies that drift silently stop matching. Browser-safe by construction —
 * a pure string function with no imports.
 */
export function normalizeCapabilityName(name: string): string {
  const segments = name.split(':');
  const last = segments[segments.length - 1] ?? name;
  return last.toLowerCase().replace(/[^a-z0-9]/g, '');
}
