/**
 * Largest document the browser preview pipeline will fetch into memory.
 *
 * Cloud attachments are capped at 10 MiB during upload, so they never reach
 * this boundary. Sandbox files from 25–100 MiB remain downloadable through the
 * larger sandbox download route but render a size-limit placeholder instead.
 */
export const CLOUD_DOCUMENT_PREVIEW_MAX_BYTES = 25 * 1024 * 1024;

/** Desktop and cloud document previews share the same in-memory budget. */
export const DOCUMENT_PREVIEW_MAX_BYTES = CLOUD_DOCUMENT_PREVIEW_MAX_BYTES;

/** Containers Chromium plays natively; other video formats stay download-only. */
export const VIDEO_PREVIEW_EXTENSIONS: ReadonlySet<string> = new Set([
  'mp4',
  'm4v',
  'webm',
]);

/**
 * Videos only become a Blob for the native player (no parsing), so they get
 * the sandbox download route's 100 MiB cap instead of the document budget.
 */
export const VIDEO_PREVIEW_MAX_BYTES = 100 * 1024 * 1024;

const VIDEO_PREVIEW_MEDIA_TYPES: ReadonlySet<string> = new Set([
  'video/mp4',
  'video/webm',
]);

/**
 * The in-memory preview budget for a file, chosen by its extension or, when a
 * host knows it, its authoritative media type. Paths are real file paths, so
 * `?` and `#` stay part of the name.
 */
export function documentPreviewMaxBytes(
  path: string,
  mediaType?: string,
): number {
  const extension = /\.([^./\\]+)$/.exec(path)?.[1]?.toLowerCase();
  const video =
    (extension !== undefined && VIDEO_PREVIEW_EXTENSIONS.has(extension)) ||
    (mediaType !== undefined &&
      // Same normalization the viewers use to pick the render kind.
      VIDEO_PREVIEW_MEDIA_TYPES.has(
        mediaType.split(';')[0].trim().toLowerCase(),
      ));
  return video ? VIDEO_PREVIEW_MAX_BYTES : DOCUMENT_PREVIEW_MAX_BYTES;
}
