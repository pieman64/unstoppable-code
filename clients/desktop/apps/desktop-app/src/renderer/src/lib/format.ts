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
