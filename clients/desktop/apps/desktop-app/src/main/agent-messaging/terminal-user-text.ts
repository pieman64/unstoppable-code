import { stripTerminalPresentationMarker } from '@canopy/desktop-shared/lib/terminal-presentation';

const CLAUDE_IMAGE_MARKER_PATTERN = /\[Image #\d+\]\s*/g;
const CLAUDE_IMAGE_SOURCE_LINE_PATTERN = /^\[Image: source: .*\]$/;

/**
 * Clean TUI attachment artifacts out of an imported user prompt so the
 * Canopy transcript matches a native send (one bubble of the user's own
 * words, attachments as pills): the Claude Code composer rewrites pasted
 * image paths into `[Image #N]` markers, appends `[Image: source: …]`
 * reference lines for pasted images, and older Canopy sends carried an
 * "Attached context paths:" block listing the pasted paths.
 */
export function sanitizeImportedUserText(
  text: string,
  convertedImagePaths: readonly string[] = [],
): string {
  // Only main-retained attachment-path lines are candidates for the TUI image
  // conversion. Do not reinterpret body text or infer authority from a marker.
  const imagePaths = new Set(
    convertedImagePaths.filter((filePath) => {
      const extension = filePath
        .slice(filePath.lastIndexOf('.') + 1)
        .toLowerCase();
      return IMAGE_EXTENSIONS.has(extension);
    }),
  );
  const unmarked = stripTerminalPresentationMarker(text);
  const converted =
    imagePaths.size > 0
      ? unmarked
          .split('\n')
          .map((line) => (imagePaths.has(line.trim()) ? '[Image #1]' : line))
          .join('\n')
      : unmarked;
  const withoutMarkers = converted.replace(CLAUDE_IMAGE_MARKER_PATTERN, '');
  const kept: string[] = [];
  let inAttachedPathsBlock = false;
  for (const line of withoutMarkers.split('\n')) {
    const trimmed = line.trim();
    if (/^Attached context paths:$/i.test(trimmed)) {
      inAttachedPathsBlock = true;
      continue;
    }
    if (inAttachedPathsBlock) {
      if (trimmed === '' || trimmed === '-' || trimmed.startsWith('- ')) {
        continue;
      }
      inAttachedPathsBlock = false;
    }
    if (CLAUDE_IMAGE_SOURCE_LINE_PATTERN.test(trimmed)) {
      continue;
    }
    kept.push(line);
  }
  return kept.join('\n').trim();
}

export const ATTACHMENT_MEDIA_TYPE_EXTENSIONS: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'application/pdf': 'pdf',
};

const IMAGE_EXTENSIONS = new Set([
  ...Object.entries(ATTACHMENT_MEDIA_TYPE_EXTENSIONS)
    .filter(([mediaType]) => mediaType.startsWith('image/'))
    .map(([, extension]) => extension),
  'jpeg',
]);
