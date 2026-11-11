import type { JSX, ReactNode } from 'react';
import { PlayIcon } from '../../icons/AppIcons';
import { Tooltip } from '../Tooltip';

export interface MessageImageAttachment {
  /** Stable React key (e.g. the attachment's path or id). */
  readonly key: string;
  /**
   * Image URL (a video's first frame); `null` while it loads or when it
   * cannot be shown. A video without a frame keeps its tile and play mark.
   */
  readonly src: string | null;
  /** A video draws a play mark over its frame. Defaults to `image`. */
  readonly kind?: 'image' | 'video';
  /** Accessible name: the file name. */
  readonly alt: string;
  /** Opens the full image. Without it the thumbnail is not interactive. */
  readonly onOpen?: () => void;
  /** The picture failed to load; the host may show the file another way. */
  readonly onError?: () => void;
  /** What `onOpen` does, for the tile's accessible name. Defaults to `Open`. */
  readonly actionLabel?: 'Open' | 'Download';
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
 * The play mark over a video's tile: the tooltip's inverse pair, which keeps
 * its contrast over any frame, in both color modes.
 */
const PLAY_MARK_CLASS =
  'pointer-events-none absolute inset-0 m-auto flex size-6 items-center justify-center rounded-full bg-tooltip-inverse fg-tooltip-inverse';

/**
 * The row of a message's sent media inside its bubble. The bubble pads 12px
 * across and 6px down; the row reaches 6px into the side padding, so the
 * pictures sit 6px from the bubble's top and sides, and 6px above the text.
 */
export function MessageMediaRow({
  children,
}: {
  readonly children: ReactNode;
}): JSX.Element {
  return (
    <div
      className="-mx-1.5 mb-1.5 flex flex-wrap gap-1.5"
      data-testid="message-image-attachments"
    >
      {children}
    </div>
  );
}

/**
 * One sent image or video: a 64px square of the picture itself, a video as
 * its first frame with a play mark. Opens the file when the host can.
 */
export function MessageMediaTile({
  image,
}: {
  readonly image: MessageImageAttachment;
}): JSX.Element {
  const picture = (
    <>
      {image.src !== null ? (
        <img
          src={image.src}
          alt={image.alt}
          draggable={false}
          // A transcript can hold many full-size pictures; load each as it
          // nears the view. The tile's fixed size keeps the layout still.
          loading="lazy"
          decoding="async"
          onError={image.onError}
          className="h-full w-full object-cover"
        />
      ) : null}
      {image.kind === 'video' ? (
        <span aria-hidden className={PLAY_MARK_CLASS}>
          <PlayIcon size="xs" />
        </span>
      ) : null}
      <span aria-hidden className={IMAGE_EDGE_CLASS} />
    </>
  );
  const name = image.kind === 'video' ? `video ${image.alt}` : image.alt;
  return image.onOpen ? (
    <Tooltip
      label={image.alt}
      contentClassName="max-w-96 break-all"
      replayBlock
    >
      <button
        type="button"
        onClick={image.onOpen}
        aria-label={`${image.actionLabel ?? 'Open'} ${name}`}
        data-testid="message-image-attachment"
        data-kind={image.kind ?? 'image'}
        className={`focus-ring ${TILE_CLASS}`}
      >
        {picture}
      </button>
    </Tooltip>
  ) : (
    <span
      title={image.alt}
      role="img"
      aria-label={name}
      data-testid="message-image-attachment"
      data-kind={image.kind ?? 'image'}
      className={TILE_CLASS}
    >
      {picture}
    </span>
  );
}

/**
 * The images and videos sent with a chat message, shown as the pictures
 * themselves inside its bubble, in attach order. Pure display; hosts resolve
 * each image's URL. A host that resolves each picture on its own composes
 * `MessageMediaRow` and `MessageMediaTile` instead.
 */
export function MessageImageAttachments({
  images,
}: MessageImageAttachmentsProps): JSX.Element | null {
  if (images.length === 0) return null;
  return (
    <MessageMediaRow>
      {images.map((image) => (
        <MessageMediaTile key={image.key} image={image} />
      ))}
    </MessageMediaRow>
  );
}
