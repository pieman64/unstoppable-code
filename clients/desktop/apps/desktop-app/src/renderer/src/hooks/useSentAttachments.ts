import { useEffect, useMemo, useState } from 'react';
import { PREVIEWABLE_IMAGE_FILENAME, VIDEO_FILENAME } from '@/lib/file-type';

/**
 * Reads each image's preview (a data URL) once per path. A path whose read
 * fails or is not an image (too large, unreadable) maps to `null`; a path
 * still loading has no entry. With `videoFrame`, a video's preview is its
 * first frame, where the OS can draw one.
 */
export function useImagePreviews(
  paths: readonly string[],
  { videoFrame = false }: { readonly videoFrame?: boolean } = {},
): ReadonlyMap<string, string | null> {
  const key = paths.join('\n');
  const [previews, setPreviews] = useState<ReadonlyMap<string, string | null>>(
    () => new Map(),
  );
  useEffect(() => {
    let cancelled = false;
    const wanted = key === '' ? [] : key.split('\n');
    void Promise.all(
      wanted.map((absolutePath) =>
        window.api
          .readFilePreview(
            videoFrame ? { absolutePath, videoFrame } : { absolutePath },
          )
          .then((preview): [string, string | null] => [
            absolutePath,
            preview.kind === 'image' ? preview.content : null,
          ])
          .catch((): [string, string | null] => [absolutePath, null]),
      ),
    ).then((entries) => {
      if (!cancelled) setPreviews(new Map(entries));
    });
    return (): void => {
      cancelled = true;
    };
  }, [key, videoFrame]);
  return previews;
}

export interface SentImage {
  readonly absolutePath: string;
  /**
   * Data URL: an image's picture, or a video's first frame. `null` while it
   * loads, and for a video whose frame the OS cannot draw.
   */
  readonly src: string | null;
  /** A video's tile carries a play mark over its frame. */
  readonly kind: 'image' | 'video';
}

export interface SentAttachments {
  /** Shown inside the bubble as the pictures themselves, in attached order. */
  readonly images: readonly SentImage[];
  /** Shown as file chips under the bubble. */
  readonly filePaths: readonly string[];
}

/**
 * Splits a message's attachments into media shown in its bubble and files
 * shown as chips. Only images the preview handler can draw go in the bubble;
 * one whose preview does not come back as an image (too large, unreadable)
 * falls back to its chip. A video always goes in the bubble, as its first
 * frame, or as an empty tile with its play mark where the OS draws none, the
 * way a queued message shows it. Without `enabled` every attachment is a
 * chip.
 */
export function useSentAttachments(
  attachmentPaths: readonly string[] | undefined,
  enabled: boolean,
): SentAttachments {
  const candidates = useMemo(
    () =>
      enabled
        ? (attachmentPaths ?? []).filter((path) =>
            PREVIEWABLE_IMAGE_FILENAME.test(path),
          )
        : [],
    [attachmentPaths, enabled],
  );
  const videos = useMemo(
    () =>
      enabled
        ? (attachmentPaths ?? []).filter((path) => VIDEO_FILENAME.test(path))
        : [],
    [attachmentPaths, enabled],
  );
  const previews = useImagePreviews(candidates);
  const frames = useImagePreviews(videos, { videoFrame: true });
  return useMemo((): SentAttachments => {
    const paths = attachmentPaths ?? [];
    if (candidates.length === 0 && videos.length === 0) {
      return { images: [], filePaths: paths };
    }
    const shownImages = new Set(
      candidates.filter((path) => previews.get(path) !== null),
    );
    const isVideo = new Set(videos);
    const media: SentImage[] = [];
    for (const absolutePath of paths) {
      if (isVideo.has(absolutePath)) {
        media.push({
          absolutePath,
          src: frames.get(absolutePath) ?? null,
          kind: 'video',
        });
      } else if (shownImages.has(absolutePath)) {
        media.push({
          absolutePath,
          src: previews.get(absolutePath) ?? null,
          kind: 'image',
        });
      }
    }
    return {
      images: media,
      filePaths: paths.filter(
        (path) => !shownImages.has(path) && !isVideo.has(path),
      ),
    };
  }, [attachmentPaths, candidates, videos, previews, frames]);
}
