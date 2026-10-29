import { useMemo, type JSX } from 'react';
import {
  MessageImageAttachments,
  type MessageImageAttachment,
} from '@canopy/ui-shared/components';
import { getFilenameFromPath } from '@/lib/file-type';
import type { SentImage } from '@/hooks/useSentAttachments';
import { useGitHubStore } from '@/stores/githubStore';

/**
 * Early access: the images sent with a user message, shown inside its
 * bubble as the pictures themselves. Clicking one opens it in the system's
 * default app.
 */
export function MessageImages({
  images,
}: {
  readonly images: readonly SentImage[];
}): JSX.Element | null {
  const addToast = useGitHubStore((state) => state.addToast);
  const attachments = useMemo(
    (): MessageImageAttachment[] =>
      images.map(({ absolutePath, src }) => {
        const filename = getFilenameFromPath(absolutePath);
        return {
          key: absolutePath,
          src,
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
  return <MessageImageAttachments images={attachments} />;
}
