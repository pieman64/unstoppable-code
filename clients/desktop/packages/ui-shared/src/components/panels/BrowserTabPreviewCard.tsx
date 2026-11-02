import { useState, type JSX, type ReactNode } from 'react';
import { GlobeIcon } from '../../icons/AppIcons';
import { REPLAY_BLOCK_CLASS } from '../../lib/replay-privacy';

export interface BrowserTabPreviewCardProps {
  /** The page title, as the tab resolves it. */
  title: string;
  /** The page URL; empty leaves the location row out. */
  url: string;
  /** The last capture of the page, or `null` while there is none. */
  previewSrc: string | null;
  /** Drawn in the preview's place without a capture; defaults to the globe. */
  fallbackIcon?: ReactNode;
}

/**
 * The location row's text: host and path for web pages, with the scheme and
 * a bare root slash dropped; any other URL as it is.
 */
export function browserTabPreviewLocation(url: string): string {
  const match = /^https?:\/\/(.+)$/.exec(url);
  if (!match) return url;
  const rest = match[1];
  return rest.endsWith('/') && rest.indexOf('/') === rest.length - 1
    ? rest.slice(0, -1)
    : rest;
}

/**
 * Pure display card that previews a background browser tab from its tab, on
 * the {@link ChatTabPreviewCard}'s surface and width: the page title, its
 * host and path in the quiet ink under it, then the last capture of the
 * page. Without a capture (or when it fails to
 * load) the preview keeps its 16:9 space and shows the site's icon. Mount it
 * on the same hover surface as the chat card.
 */
export function BrowserTabPreviewCard({
  title,
  url,
  previewSrc,
  fallbackIcon,
}: BrowserTabPreviewCardProps): JSX.Element {
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const showImage = previewSrc !== null && previewSrc !== failedSrc;
  return (
    // The title and location sit 12px in from the surface's top and sides,
    // like the chat card's text. The preview sits 4px in from the left,
    // right and bottom edges, so its 8px corners nest in the surface's 12px.
    <div
      className="-mx-1 flex flex-col gap-2.5 pt-2 text-xs"
      data-testid="browser-tab-preview"
    >
      <div className="flex min-w-0 flex-col gap-0.5 px-2">
        <span
          className={`truncate fg-primary ${REPLAY_BLOCK_CLASS}`}
          data-testid="browser-tab-preview-title"
        >
          {title}
        </span>
        {url.length > 0 ? (
          <span
            className={`truncate fg-tertiary ${REPLAY_BLOCK_CLASS}`}
            data-testid="browser-tab-preview-url"
          >
            {browserTabPreviewLocation(url)}
          </span>
        ) : null}
      </div>
      <div
        className={`aspect-video overflow-hidden rounded-md bg-secondary ${REPLAY_BLOCK_CLASS}`}
        data-testid="browser-tab-preview-frame"
      >
        {showImage ? (
          <img
            src={previewSrc}
            alt=""
            draggable={false}
            className="block size-full object-cover object-top"
            data-testid="browser-tab-preview-image"
            onError={(): void => setFailedSrc(previewSrc)}
          />
        ) : (
          <div
            className="flex size-full items-center justify-center fg-quaternary"
            data-testid="browser-tab-preview-placeholder"
          >
            {fallbackIcon ?? <GlobeIcon size={20} aria-hidden />}
          </div>
        )}
      </div>
    </div>
  );
}
