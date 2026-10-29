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
