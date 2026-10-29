// Hoisted to desktop-shared so the main-process portal marketplace adapter
// validates repos with the SAME parser this renderer path uses.
export { parseGitHubRepo } from '@canopy/desktop-shared/lib/github-repo';

export { formatDate, formatDateOrEmpty } from '@canopy/ui-shared/lib';

// Usage formatting moved verbatim to @canopy/ui-shared so the composer usage
// meter renders identically on the desktop renderer and the web portal.
export {
  formatTokenCount,
  formatCost,
  formatDuration,
} from '@canopy/ui-shared/lib';

// Relative-time formatting moved verbatim to @canopy/ui-shared so shared
// activity bodies and the desktop renderer format identically. Accepts either
// an ISO string or an epoch-ms number (the unified command palette carries
// entity timestamps as epoch ms).
export { formatRelativeTime } from '@canopy/ui-shared/lib';

export function getBaseName(filePath: string): string {
  const slashIndex = Math.max(
    filePath.lastIndexOf('/'),
    filePath.lastIndexOf('\\'),
  );
  return slashIndex >= 0 ? filePath.slice(slashIndex + 1) : filePath;
}

const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB'] as const;

/**
 * Human-readable byte size (`0 B`, `12 KB`, `1.4 MB`). Whole numbers below
 * 10 keep one decimal so small archives do not all collapse to `1 MB`.
 */
export function formatByteSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) {
    return '0 B';
  }
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < BYTE_UNITS.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  const unit = BYTE_UNITS[unitIndex];
  if (unitIndex === 0) {
    return `${Math.round(value)} ${unit}`;
  }
  const rounded = value < 10 ? Math.round(value * 10) / 10 : Math.round(value);
  return `${rounded} ${unit}`;
}
