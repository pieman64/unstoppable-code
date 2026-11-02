import { useEffect, useMemo, useState } from 'react';
import { PREVIEWABLE_IMAGE_FILENAME } from '@/lib/file-type';

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
  /** Data URL; `null` while the preview loads. */
  readonly src: string | null;
}

export interface SentAttachments {
  /** Shown inside the bubble as the pictures themselves. */
  readonly images: readonly SentImage[];
  /** Shown as file chips under the bubble. */
  readonly filePaths: readonly string[];
}

/**
 * Splits a message's attachments into images shown in its bubble and files
 * shown as chips. Only images the preview handler can draw go in the bubble;
 * one whose preview does not come back as an image (too large, unreadable)
 * falls back to its chip. Without `enabled` every attachment is a chip.
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
  const previews = useImagePreviews(candidates);
  return useMemo((): SentAttachments => {
    const paths = attachmentPaths ?? [];
    if (candidates.length === 0) return { images: [], filePaths: paths };
    const shown = new Set(
      candidates.filter((path) => previews.get(path) !== null),
    );
    return {
      images: candidates
        .filter((path) => shown.has(path))
        .map((absolutePath) => ({
          absolutePath,
          src: previews.get(absolutePath) ?? null,
        })),
      filePaths: paths.filter((path) => !shown.has(path)),
    };
  }, [attachmentPaths, candidates, previews]);
}
