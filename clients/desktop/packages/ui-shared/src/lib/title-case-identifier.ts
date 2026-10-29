// NOTE: intentionally mirrored from
// @canopy/desktop-shared/lib/scoped-config-utils (neither package may depend
// on the other); keep both implementations in sync.
export function titleCaseIdentifier(value: string): string {
  return value
    .split(/[^A-Za-z0-9]+/)
    .filter((segment) => segment.length > 0)
    .map((segment) => segment[0].toUpperCase() + segment.slice(1))
    .join(' ');
}
