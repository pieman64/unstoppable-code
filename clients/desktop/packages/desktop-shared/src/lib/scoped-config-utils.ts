export function compareIndexedNames(
  left: string,
  right: string,
  getIndex: (value: string) => number,
): number {
  const leftIndex = getIndex(left);
  const rightIndex = getIndex(right);

  if (leftIndex >= 0 && rightIndex >= 0) {
    return leftIndex - rightIndex;
  }
  if (leftIndex >= 0) {
    return -1;
  }
  if (rightIndex >= 0) {
    return 1;
  }

  return left.localeCompare(right);
}

// NOTE: intentionally mirrored in @canopy/ui-shared/lib/title-case-identifier
// (neither package may depend on the other); keep both implementations in
// sync.
export function titleCaseIdentifier(value: string): string {
  return value
    .split(/[^A-Za-z0-9]+/)
    .filter((segment) => segment.length > 0)
    .map((segment) => segment[0].toUpperCase() + segment.slice(1))
    .join(' ');
}

export function parseWorkspaceRepoScopedValue(
  value: string,
  prefix: string,
): { repoId: string; scopedValue: string } | null {
  const remainder = value.slice(prefix.length);
  const separatorIndex = remainder.indexOf(':');
  if (separatorIndex <= 0 || separatorIndex === remainder.length - 1) {
    return null;
  }

  return {
    repoId: remainder.slice(0, separatorIndex),
    scopedValue: remainder.slice(separatorIndex + 1),
  };
}
