export function toInternalReleaseIndicator(version: string): string | null {
  const counterOnlyMatch = /^internal-([1-9]\d*)$/i.exec(version);
  if (counterOnlyMatch) {
    return `internal-${counterOnlyMatch[1]}`;
  }

  const updaterVersionMatch = /^9999\.0\.0-internal\.([1-9]\d*)$/i.exec(
    version,
  );
  if (updaterVersionMatch) {
    return `internal-${updaterVersionMatch[1]}`;
  }

  const legacyVersionMatch =
    /^\d+\.\d+\.\d+-internal\.([1-9]\d*)(?:\+sha\.[0-9a-f]{7,40})?$/i.exec(
      version,
    );
  if (legacyVersionMatch) {
    return `internal-${legacyVersionMatch[1]}`;
  }

  return null;
}

export function getInternalReleaseIndicatorForDisplay(version: string): string {
  if (
    typeof __CANOPY_INTERNAL_RELEASE_INDICATOR__ === 'string' &&
    __CANOPY_INTERNAL_RELEASE_INDICATOR__.trim().length > 0
  ) {
    return __CANOPY_INTERNAL_RELEASE_INDICATOR__.trim();
  }

  return toInternalReleaseIndicator(version) ?? version;
}
