/** Normalizes a version for display, never inventing one that is absent. */
export function displayVersion(version: string | undefined): string | null {
  const trimmed = version?.trim().replace(/^v/i, '') ?? '';
  return trimmed === '' ? null : `v${trimmed}`;
}

/** `Update available: v1.3.0` when the version is known. */
export function updateMarkerLabel(latestVersion?: string): string {
  const latest = displayVersion(latestVersion);
  return latest ? `Update available: ${latest}` : 'Update available';
}
