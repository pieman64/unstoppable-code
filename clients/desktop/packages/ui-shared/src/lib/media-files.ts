/**
 * Video file names: a sent or queued message shows them as a tile with a
 * play mark. Desktop's preview handler draws a first frame for these
 * (`VIDEO_EXTENSIONS` in `main/ipc/file-preview.ts`); hosts that only know a
 * file by its name (a desktop chat projected to the Portal) recognize a video
 * by it.
 */
export const VIDEO_FILENAME = /\.(mp4|m4v|mov|webm|mkv|avi)$/i;
