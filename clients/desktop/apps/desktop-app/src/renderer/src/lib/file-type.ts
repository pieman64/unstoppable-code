export function getFilenameFromPath(filePath: string): string {
  const slashIndex = Math.max(
    filePath.lastIndexOf('/'),
    filePath.lastIndexOf('\\'),
  );
  return slashIndex === -1 ? filePath : filePath.slice(slashIndex + 1);
}

/**
 * File names that are images. Shapes a thumbnail before its preview loads;
 * the preview's kind has the final say.
 */
export const IMAGE_FILENAME =
  /\.(png|jpe?g|gif|webp|bmp|svg|avif|heic|heif|tiff?)$/i;

/**
 * Image file names the preview handler can draw (mirrors `IMAGE_EXTENSIONS`
 * in `main/ipc/file-preview.ts`). Other image types (HEIC, AVIF, TIFF) come
 * back `unsupported`, so they stay file chips.
 */
export const PREVIEWABLE_IMAGE_FILENAME = /\.(png|jpe?g|gif|webp|bmp|svg)$/i;
