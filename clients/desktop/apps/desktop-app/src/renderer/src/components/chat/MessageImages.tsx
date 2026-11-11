import { useMemo, type JSX } from 'react';
import {
  MessageMediaRow,
  MessageMediaTile,
  type MessageImageAttachment,
} from '@canopy/ui-shared/components';
import { getFilenameFromPath } from '@/lib/file-type';
import type { SentImage } from '@/hooks/useSentAttachments';
import { useGitHubStore } from '@/stores/githubStore';

/**
 * The images and videos sent with a user message, shown inside its bubble
 * in the shared media row the web also mounts, a video as its first frame
 * with a play mark. Clicking one opens it in the system's default app.
 */
export function MessageImages({
  images,
}: {
  readonly images: readonly SentImage[];
}): JSX.Element | null {
  const addToast = useGitHubStore((state) => state.addToast);
  const attachments = useMemo(
    (): MessageImageAttachment[] =>
      images.map(({ absolutePath, src, kind }) => {
        const filename = getFilenameFromPath(absolutePath);
        return {
          key: absolutePath,
          src,
          kind,
          alt: filename,
          onOpen: (): void => {
            void window.api.openExternalFile({ absolutePath }).catch(() => {
              addToast(`Couldn't open ${filename}.`, 'error', undefined, {
                forceInApp: true,
              });
            });
          },
        };
      }),
    [addToast, images],
  );
  if (images.length === 0) return null;
  return (
    <MessageMediaRow>
      {attachments.map((image) => (
        <MessageMediaTile key={image.key} image={image} />
      ))}
    </MessageMediaRow>
  );
}
