/**
 * Standard browser tab previews.
 * Resting on a background browser tab opens the shared
 * `BrowserTabPreviewCard` under it: the page title, the last capture of the
 * page and its host and path, on the chat tab card's surface and layout.
 *
 * The capture costs nothing extra: a visible `BrowserPane` already takes
 * freeze frames (after a page loads, and when the pointer heads for the
 * app's controls, the tab strip included, so leaving a tab refreshes it).
 * Each frame is scaled down here to the card's size and kept in renderer
 * memory, one per browser and only for the page it shows. A preview of an
 * earlier page is never shown under a new URL; until the new page is
 * captured the card shows the site's icon.
 */
/* eslint-disable react-refresh/only-export-components */
import { useSyncExternalStore, type JSX, type ReactNode } from 'react';
import type { PanelTabModel } from '@canopy/ui-shared/panels';
import { BrowserTabPreviewCard } from '@canopy/ui-shared/components/panels';
import { useBrowserStore } from '@/stores/browserStore';
import {
  BrowserPanelTabIcon,
  boundBrowserId,
  selectBrowserSnapshotById,
  useBrowserLabel,
} from './tab-display';

/** The card's preview at 2x: the chat card's 272px chip width, 16:9. */
export const BROWSER_TAB_PREVIEW_WIDTH = 544;
export const BROWSER_TAB_PREVIEW_HEIGHT = 306;
const BROWSER_TAB_PREVIEW_JPEG_QUALITY = 0.8;
/** A newer frame of the same page within this window is skipped. */
const BROWSER_TAB_PREVIEW_MIN_INTERVAL_MS = 1000;
/** Browsers whose previews are kept; the least recently captured go first. */
const BROWSER_TAB_PREVIEW_LIMIT = 24;

export interface BrowserTabPreview {
  /** The page the capture shows. */
  readonly url: string;
  /** A JPEG data URL at the card's 2x size. */
  readonly src: string;
  /** `performance.now()` when the capture was recorded. */
  readonly capturedAt: number;
}

/** Scales a decoded frame to the preview's top-left 16:9 crop. */
export type BrowserTabPreviewScaler = (
  image: HTMLImageElement,
) => string | null;

/**
 * The part of a frame the preview shows: its top-left 16:9, as large as the
 * frame allows. A taller page loses its bottom and a wider one its right
 * side, so the picture always fills the preview with no empty band.
 */
export function browserTabPreviewSourceRect(
  width: number,
  height: number,
): { width: number; height: number } {
  const ratio = BROWSER_TAB_PREVIEW_WIDTH / BROWSER_TAB_PREVIEW_HEIGHT;
  return {
    width: Math.min(width, Math.round(height * ratio)),
    height: Math.min(height, Math.round(width / ratio)),
  };
}

function scaleToPreview(image: HTMLImageElement): string | null {
  const width = image.naturalWidth;
  const height = image.naturalHeight;
  if (width <= 0 || height <= 0) return null;
  const canvas = document.createElement('canvas');
  canvas.width = BROWSER_TAB_PREVIEW_WIDTH;
  canvas.height = BROWSER_TAB_PREVIEW_HEIGHT;
  const context = canvas.getContext('2d');
  if (!context) return null;
  const source = browserTabPreviewSourceRect(width, height);
  context.drawImage(
    image,
    0,
    0,
    source.width,
    source.height,
    0,
    0,
    BROWSER_TAB_PREVIEW_WIDTH,
    BROWSER_TAB_PREVIEW_HEIGHT,
  );
  return canvas.toDataURL('image/jpeg', BROWSER_TAB_PREVIEW_JPEG_QUALITY);
}

const previews = new Map<string, BrowserTabPreview>();
const listeners = new Set<() => void>();
let scaler: BrowserTabPreviewScaler = scaleToPreview;

function notify(): void {
  listeners.forEach((listener) => listener());
}

/**
 * Records a freeze frame a visible pane just decoded as its browser's
 * preview. Called by `BrowserPane` for every frame it takes; frames of the
 * same page closer together than a second are skipped, so a burst of
 * captures scales once.
 */
export function recordBrowserTabPreview(
  browserId: string,
  url: string,
  image: HTMLImageElement,
  now: number = performance.now(),
): void {
  if (url.length === 0) return;
  const current = previews.get(browserId);
  if (
    current !== undefined &&
    current.url === url &&
    now - current.capturedAt < BROWSER_TAB_PREVIEW_MIN_INTERVAL_MS
  ) {
    return;
  }
  const src = scaler(image);
  if (src === null) return;
  previews.delete(browserId);
  previews.set(browserId, { url, src, capturedAt: now });
  if (previews.size > BROWSER_TAB_PREVIEW_LIMIT) {
    const oldest = previews.keys().next().value;
    if (oldest !== undefined) previews.delete(oldest);
  }
  notify();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return (): void => {
    listeners.delete(listener);
  };
}

/** The browser's last preview, or `undefined`. */
export function useBrowserTabPreview(
  browserId: string,
): BrowserTabPreview | undefined {
  return useSyncExternalStore(subscribe, () => previews.get(browserId));
}

/** Test seam: swap the canvas scaler (jsdom has no canvas) and clear state. */
export function resetBrowserTabPreviewsForTests(
  nextScaler: BrowserTabPreviewScaler = scaleToPreview,
): void {
  previews.clear();
  scaler = nextScaler;
  notify();
}

function DesktopBrowserTabPreview({
  browserId,
}: {
  browserId: string;
}): JSX.Element {
  const title = useBrowserLabel(browserId);
  const url = useBrowserStore(
    (s) => selectBrowserSnapshotById(s.worktrees, browserId)?.url ?? '',
  );
  const preview = useBrowserTabPreview(browserId);
  return (
    <BrowserTabPreviewCard
      title={title}
      url={url === 'about:blank' ? '' : url}
      previewSrc={
        preview !== undefined && preview.url === url ? preview.src : null
      }
      fallbackIcon={<BrowserPanelTabIcon browserId={browserId} />}
    />
  );
}

/**
 * The browser half of the panel tab bar's `renderTabHoverCard`: a preview
 * card for browser tabs, `null` for every other kind.
 */
export function renderBrowserTabHoverCard(
  tab: PanelTabModel,
): ReactNode | null {
  const browserId = boundBrowserId(tab);
  if (browserId === null) return null;
  return <DesktopBrowserTabPreview browserId={browserId} />;
}
