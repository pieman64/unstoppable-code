import type { JSX } from 'react';
import { Tooltip } from '../Tooltip';

export interface MessageImageAttachment {
  /** Stable React key (e.g. the attachment's path or id). */
  readonly key: string;
  /** Image URL; `null` while it loads or when it cannot be shown. */
  readonly src: string | null;
  /** Accessible name: the file name. */
  readonly alt: string;
  /** Opens the full image. Without it the thumbnail is not interactive. */
  readonly onOpen?: () => void;
}

export interface MessageImageAttachmentsProps {
  readonly images: readonly MessageImageAttachment[];
}

/**
 * The edge every attachment tile draws: 1px of the primary ink (black in
 * light, white in dark) at 16%, so a dark or pale tile still ends on a line.
 * One strength for every tile in a row, so a file beside an image does not
 * read as fainter. A file, a video or a code selection draws it on the tile
 * itself: its content is text and an icon, which leave the edge bare.
 */
export const ATTACHMENT_TILE_EDGE_CLASS = 'inset-ring inset-ring-fg-primary/16';

/**
 * A picture draws that edge on a layer over itself: an inset ring on the
 * tile would sit under the picture. This is the composer's 120px tile, with
 * its 8px corner.
 */
export const IMAGE_THUMBNAIL_EDGE_CLASS = `pointer-events-none absolute inset-0 rounded-lg ${ATTACHMENT_TILE_EDGE_CLASS}`;

/** The same layer for a sent message's 64px thumbnail and its 6px corner. */
const IMAGE_EDGE_CLASS = `pointer-events-none absolute inset-0 rounded-md ${ATTACHMENT_TILE_EDGE_CLASS}`;

/**
 * A 64px square, with the corner of the bubble's 12px radius 6px in, so the
 * picture's corner follows the bubble's.
 */
const TILE_CLASS =
  'relative block h-16 w-16 shrink-0 overflow-hidden rounded-md bg-secondary';

/**
 * The images sent with a chat message, shown as the pictures themselves
 * inside its bubble: 64px square thumbnails. The bubble pads 12px across and
 * 6px down; the row reaches 6px into the side padding, so the pictures sit
 * 6px from the bubble's top and sides, and 6px above the text. Pure display;
 * hosts resolve each image's URL.
 */
export function MessageImageAttachments({
  images,
}: MessageImageAttachmentsProps): JSX.Element | null {
  if (images.length === 0) return null;
  return (
    <div
      className="-mx-1.5 mb-1.5 flex flex-wrap gap-1.5"
      data-testid="message-image-attachments"
    >
      {images.map((image) => {
        const picture = (
          <>
            {image.src !== null ? (
              <img
                src={image.src}
                alt={image.alt}
                draggable={false}
                className="h-full w-full object-cover"
              />
            ) : null}
            <span aria-hidden className={IMAGE_EDGE_CLASS} />
          </>
        );
        return image.onOpen ? (
          <Tooltip
            key={image.key}
            label={image.alt}
            contentClassName="max-w-96 break-all"
            replayBlock
          >
            <button
              type="button"
              onClick={image.onOpen}
              aria-label={`Open ${image.alt}`}
              data-testid="message-image-attachment"
              className={`focus-ring ${TILE_CLASS}`}
            >
              {picture}
            </button>
          </Tooltip>
        ) : (
          <span
            key={image.key}
            title={image.alt}
            data-testid="message-image-attachment"
            className={TILE_CLASS}
          >
            {picture}
          </span>
        );
      })}
    </div>
  );
}
