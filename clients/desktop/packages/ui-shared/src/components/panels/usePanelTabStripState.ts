'use client';

import { useEffect, useState, type RefObject } from 'react';

/** Marker an app-supplied tab glyph sets while its tab is unread. */
export const PANEL_TAB_UNREAD_ATTRIBUTE = 'data-unread';

/** How long an unread tab must stay out of (or in) view before ⌄ follows. */
export const UNREAD_DOT_DELAY_MS = 400;

/** Fill tabs' resting width when they all fit (panels.css). */
const DEFAULT_TAB_WIDTH_PX = 224;
/** Fill strip gap between tabs and its padding on each end (panels.css). */
const TAB_GAP_PX = 4;
const STRIP_PADDING_PX = 4;

export interface PanelTabStripState {
  /**
   * The tabs no longer all fit at their resting width: they are squeezed or
   * the strip scrolls. The ⌄ list shows only then.
   */
  readonly crowded: boolean;
  /**
   * An unread tab has stayed (partly) scrolled out of view for
   * {@link UNREAD_DOT_DELAY_MS}; it clears once every unread tab has been in
   * view for as long, so scrolling past one never flicks the ⌄ dot.
   */
  readonly unreadOutOfView: boolean;
}

/**
 * Measures a fill tab strip for the ⌄ list. `crowded` compares the tabs'
 * resting widths with the room the strip has, counting the ⌄ itself as room
 * while it shows, so showing it can never make the tabs fit again (no
 * flicker at the threshold). `listRoot` is the ⌄ root, beside the strip.
 */
export function usePanelTabStripState(
  stripRef: RefObject<HTMLElement | null>,
  pinnedStripRef: RefObject<HTMLElement | null>,
  listRootRef: RefObject<HTMLElement | null>,
  enabled: boolean,
  /** Re-measures when the pinned strip mounts or unmounts. */
  hasPinnedStrip: boolean,
): PanelTabStripState {
  const [crowded, setCrowded] = useState(false);
  const [unreadOutOfView, setUnreadOutOfView] = useState(false);

  useEffect(() => {
    const strip = stripRef.current;
    if (!enabled || !strip) return undefined;
    const view = strip.ownerDocument.defaultView;
    if (!view) return undefined;
    let pending: boolean | null = null;
    let timer: number | null = null;

    const measure = (): void => {
      const tabs = Array.from(
        strip.querySelectorAll<HTMLElement>('.canopy-panel-tab'),
      );
      const width =
        Number.parseFloat(
          view
            .getComputedStyle(strip)
            .getPropertyValue('--canopy-panel-tab-width'),
        ) || DEFAULT_TAB_WIDTH_PX;
      const needed =
        tabs.length * width +
        Math.max(0, tabs.length - 1) * TAB_GAP_PX +
        STRIP_PADDING_PX * 2;
      const listWidth = listRootRef.current?.offsetWidth ?? 0;
      // Pinned tiles keep their square and scroll inside their own capped
      // strip; once that strip overflows, ⌄ is how to reach them.
      const pinned = pinnedStripRef.current;
      const pinnedOverflows =
        pinned !== null && pinned.scrollWidth - pinned.clientWidth > 1;
      setCrowded(
        pinnedOverflows || needed > strip.clientWidth + listWidth + 0.5,
      );

      const unreadOutOf = (container: HTMLElement): boolean => {
        const box = container.getBoundingClientRect();
        return Array.from(
          container.querySelectorAll<HTMLElement>('.canopy-panel-tab'),
        ).some((tab) => {
          if (tab.dataset.active === 'true') return false;
          if (!tab.querySelector(`[${PANEL_TAB_UNREAD_ATTRIBUTE}]`)) {
            return false;
          }
          const rect = tab.getBoundingClientRect();
          return rect.left < box.left - 0.5 || rect.right > box.right + 0.5;
        });
      };
      const hidden =
        unreadOutOf(strip) || (pinned !== null && unreadOutOf(pinned));
      if (hidden === pending) return;
      pending = hidden;
      if (timer !== null) view.clearTimeout(timer);
      timer = view.setTimeout(() => {
        timer = null;
        setUnreadOutOfView(hidden);
      }, UNREAD_DOT_DELAY_MS);
    };

    const strips = [strip, pinnedStripRef.current].filter(
      (element): element is HTMLElement => element !== null,
    );
    const resize =
      'ResizeObserver' in view ? new view.ResizeObserver(measure) : null;
    const mutation = new view.MutationObserver(measure);
    for (const element of strips) {
      resize?.observe(element);
      mutation.observe(element, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: [PANEL_TAB_UNREAD_ATTRIBUTE, 'data-active'],
      });
      element.addEventListener('scroll', measure, { passive: true });
    }
    measure();
    return (): void => {
      if (timer !== null) view.clearTimeout(timer);
      resize?.disconnect();
      mutation.disconnect();
      for (const element of strips) {
        element.removeEventListener('scroll', measure);
      }
    };
  }, [stripRef, pinnedStripRef, listRootRef, enabled, hasPinnedStrip]);

  return { crowded, unreadOutOfView };
}
