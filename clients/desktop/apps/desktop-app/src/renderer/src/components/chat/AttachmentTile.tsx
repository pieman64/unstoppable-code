import type { JSX, ReactNode } from 'react';
import { BUBBLE_BADGE_CHROME } from '@canopy/ui-shared';
import {
  ATTACHMENT_TILE_EDGE_CLASS,
  IMAGE_THUMBNAIL_EDGE_CLASS,
} from '@canopy/ui-shared/components';
import { CloseIcon } from '@canopy/ui-shared/icons/AppIcons';
import { POSTHOG_REPLAY_BLOCK_CLASS } from '@canopy/desktop-instrumentation/posthog-replay-privacy';

/**
 * The corner remove button every tile in the composer's attachment strip
 * shares, in the chat bubbles' corner-badge chrome. It shows while its tile
 * is hovered or focused (the tile is the `group`).
 */
export function AttachmentTileRemoveButton({
  label,
  onRemove,
  testId,
}: {
  /** What is removed, for the accessible name (`Remove <label>`). */
  readonly label: string;
  readonly onRemove: () => void;
  readonly testId?: string;
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onRemove}
      data-testid={testId}
      aria-label={`Remove ${label}`}
      className={`${BUBBLE_BADGE_CHROME} absolute -right-1.5 -top-1.5 z-10 h-5 w-5 opacity-0 transition-opacity hover:fg-primary focus-visible:opacity-100 group-focus-within:opacity-100 group-hover:opacity-100 pointer-coarse:opacity-100`}
    >
      <CloseIcon size="sm" />
    </button>
  );
}

/** An image attachment: a square thumbnail, blocked from session replay. */
export function AttachmentImageTile({
  children,
}: {
  /** The thumbnail, once it has loaded. */
  readonly children?: ReactNode;
}): JSX.Element {
  return (
    <span
      data-attachment-kind="image"
      className={`${POSTHOG_REPLAY_BLOCK_CLASS} relative block h-30 w-30 overflow-hidden rounded-lg bg-secondary`}
    >
      {children}
      <span
        aria-hidden
        data-testid="attachment-image-edge"
        className={IMAGE_THUMBNAIL_EDGE_CLASS}
      />
    </span>
  );
}

/**
 * Any other attachment (a file, a code selection): a card with a glimpse of
 * its content above its name.
 */
export function AttachmentCardTile({
  kind,
  preview,
  icon,
  name,
  badge,
}: {
  /** `file` or `selection`, for automation and styling hooks. */
  readonly kind: 'file' | 'selection';
  /** Its first lines, its type's icon, or nothing while it loads. */
  readonly preview: ReactNode;
  readonly icon: ReactNode;
  readonly name: string;
  /** A short state beside the name (`stale`, `unsaved`). */
  readonly badge?: ReactNode;
}): JSX.Element {
  return (
    // Spans, so a tile can also be the face of a button (a code selection).
    // The edge matches the image tiles' beside it. The 12px corner is the
    // composer box's 20px less the strip's 8px inset, so the arcs nest.
    <span
      data-attachment-kind={kind}
      className={`flex h-30 w-40 flex-col overflow-hidden rounded-lg bg-secondary text-left ${ATTACHMENT_TILE_EDGE_CLASS}`}
    >
      <span className="flex min-h-0 flex-1 items-center justify-center overflow-hidden">
        {preview}
      </span>
      <span className="flex h-8 shrink-0 items-center gap-1.5 px-2.5 text-xs fg-primary">
        {icon}
        <span className="min-w-0 truncate">{name}</span>
        {badge}
      </span>
    </span>
  );
}

/** A text glimpse for a card: its first lines, in the code face, blocked from
 * session replay. */
export function AttachmentTextPreview({
  text,
}: {
  readonly text: string;
}): JSX.Element {
  return (
    <span
      className={`${POSTHOG_REPLAY_BLOCK_CLASS} block h-full w-full overflow-hidden whitespace-pre-wrap break-all px-2.5 pt-2 font-mono text-3xs leading-snug fg-tertiary`}
    >
      {text}
    </span>
  );
}
