'use client';

import { useMemo, type JSX, type ReactNode } from 'react';
import { useOptionalCanopyClient } from '@canopy/app-state';
import {
  MERMAID_IMAGE_CLIPBOARD_UNAVAILABLE,
  MermaidExportProvider,
  type MermaidExportNotify,
  type MermaidImageClipboard,
  type MermaidSaveDestination,
} from '@canopy/ui-shared/components';

export const MERMAID_IMAGE_CLIPBOARD_UNSUPPORTED =
  'This browser can’t copy pictures. Use Save as picture… instead.';

interface ImageClipboardWindow {
  readonly ClipboardItem: typeof ClipboardItem;
  readonly isSecureContext: boolean;
  readonly navigator: Navigator;
}

function hasClipboardItem(view: Window): view is Window & ImageClipboardWindow {
  return typeof Reflect.get(view, 'ClipboardItem') === 'function';
}

/** The browser can write one PNG + HTML item from this window. */
function supportsImageClipboard(
  view: Window,
): view is Window & ImageClipboardWindow {
  if (!view.isSecureContext || !hasClipboardItem(view)) return false;
  if (typeof view.navigator.clipboard?.write !== 'function') return false;
  // Older engines lack `supports`; the write itself then reports a refusal.
  const supports = Reflect.get(view.ClipboardItem, 'supports');
  if (typeof supports !== 'function') return true;
  return ['image/png', 'text/html'].every(
    (type) => Reflect.apply(supports, view.ClipboardItem, [type]) === true,
  );
}

/**
 * The page's async clipboard as the diagram clipboard port. The host grants
 * it through `imageClipboard`; the browser must also support it here.
 */
export function browserImageClipboard(
  enabled: boolean,
  view: Window | undefined,
): MermaidImageClipboard {
  if (!enabled) {
    return {
      status: 'unavailable',
      reason: MERMAID_IMAGE_CLIPBOARD_UNAVAILABLE,
    };
  }
  if (!view || !supportsImageClipboard(view)) {
    return {
      status: 'unavailable',
      reason: MERMAID_IMAGE_CLIPBOARD_UNSUPPORTED,
    };
  }
  return {
    status: 'available',
    write(image, ownerDocument): Promise<void> {
      // A pulled-out window writes through its own clipboard and realm.
      const target = ownerDocument.defaultView ?? view;
      if (!supportsImageClipboard(target)) {
        return Promise.reject(new Error(MERMAID_IMAGE_CLIPBOARD_UNSUPPORTED));
      }
      const item = new target.ClipboardItem({
        'image/png': image.png,
        'text/html': image.html,
      });
      return target.navigator.clipboard.write([item]);
    },
  };
}

const DOWNLOAD_DESTINATION: MermaidSaveDestination = { kind: 'download' };

/**
 * Diagram export services for a host root: the capability-gated browser
 * clipboard, downloads for diagrams that do not belong to a document, and the
 * host's toast stack when it has one at the root. File previews nest their
 * own destination inside it; a host whose toast stack sits lower nests its
 * `notify` there instead.
 */
export function HostMermaidExportProvider({
  notify,
  children,
}: {
  readonly notify?: MermaidExportNotify;
  readonly children: ReactNode;
}): JSX.Element {
  const enabled =
    useOptionalCanopyClient()?.capabilities.imageClipboard === true;
  const clipboard = useMemo(
    () =>
      browserImageClipboard(
        enabled,
        typeof window === 'undefined' ? undefined : window,
      ),
    [enabled],
  );
  return (
    <MermaidExportProvider
      clipboard={clipboard}
      destination={DOWNLOAD_DESTINATION}
      {...(notify ? { notify } : {})}
    >
      {children}
    </MermaidExportProvider>
  );
}
