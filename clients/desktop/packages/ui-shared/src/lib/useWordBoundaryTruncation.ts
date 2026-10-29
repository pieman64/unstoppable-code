'use client';

import { useLayoutEffect, type RefObject } from 'react';
import {
  fitTextAtWordBoundary,
  wordLimitEnd,
} from './fit-text-at-word-boundary';
import { measureEllipsisWidth } from './measure-text-width';

// Room past `prefix + …` so rounding never pushes the ellipsis onto a new
// glyph; narrower than any space, so the next word's space never shows.
const CLAMP_SLACK_PX = 1;
// Sub-pixel layout can report a fitting text a fraction wider than its box.
const FIT_TOLERANCE_PX = 0.5;

export interface WordBoundaryTruncationOptions {
  /** Expose the whole text as a native tooltip while it is cut. */
  readonly hoverTitle?: boolean;
  /**
   * End after this many words, even when more would fit; a narrower width
   * still cuts sooner. Omit for a width-only cut.
   */
  readonly maxWords?: number;
}

/** Nearest ancestor whose width does not follow the clamped text's width. */
function layoutAncestor(element: HTMLElement, view: Window): HTMLElement {
  for (
    let node = element.parentElement;
    node !== null;
    node = node.parentElement
  ) {
    const display = view.getComputedStyle(node).display;
    if (!display.startsWith('inline') && display !== 'contents') return node;
  }
  return element.ownerDocument.body;
}

function writeAttribute(
  element: HTMLElement,
  name: string,
  value: string | null,
): void {
  if (value === null) {
    if (element.hasAttribute(name)) element.removeAttribute(name);
  } else if (element.getAttribute(name) !== value) {
    element.setAttribute(name, value);
  }
}

/**
 * Cut a single-line `truncate` element's text after the last whole word that
 * fits, instead of mid-word. The text node stays whole, so selection, copy,
 * and the accessible name keep the full text; only an inline `max-width`
 * moves the native ellipsis to a word boundary. When no whole word fits, the
 * native mid-word cut stands. With `maxWords`, the cut also comes no later than
 * the end of that word, whatever the width. Writes `data-truncated` (`word`
 * or `char`) and `data-visible-length` while cut. Does nothing without
 * `ResizeObserver` or `Range` layout, leaving the CSS clip. Re-measures only when the nearest
 * block ancestor's width or the font size changes, so the element's available
 * width must follow that ancestor's (not be a flex item itself), and the
 * element must have no padding or border.
 */
export function useWordBoundaryTruncation(
  ref: RefObject<HTMLElement | null>,
  text: string,
  { hoverTitle = false, maxWords }: WordBoundaryTruncationOptions = {},
): void {
  useLayoutEffect(() => {
    const element = ref.current;
    const view = element?.ownerDocument.defaultView;
    if (
      !element ||
      !view ||
      !('ResizeObserver' in view) ||
      !('getBoundingClientRect' in view.Range.prototype)
    ) {
      return undefined;
    }
    const range = element.ownerDocument.createRange();
    const widthTo = (node: Text, end: number): number => {
      range.setStart(node, 0);
      range.setEnd(node, end);
      return range.getBoundingClientRect().width;
    };
    // The hook owns `title` only while it set one.
    let titled = false;
    const apply = (
      maxWidth: string,
      truncated: 'word' | 'char' | null,
      visibleLength: number | null,
    ): void => {
      if (element.style.maxWidth !== maxWidth) {
        element.style.maxWidth = maxWidth;
      }
      writeAttribute(element, 'data-truncated', truncated);
      writeAttribute(
        element,
        'data-visible-length',
        visibleLength === null ? null : String(visibleLength),
      );
      if (hoverTitle && truncated !== null) {
        writeAttribute(element, 'title', text);
        titled = true;
      } else if (titled) {
        element.removeAttribute('title');
        titled = false;
      }
    };
    const measure = (): void => {
      // Unclamp first: the element's own width is the space available to it.
      element.style.maxWidth = '';
      const node = element.firstChild;
      if (!(node instanceof view.Text) || node.data.length === 0) {
        apply('', null, null);
        return;
      }
      const available = element.getBoundingClientRect().width;
      const limit =
        maxWords === undefined ? null : wordLimitEnd(node.data, maxWords);
      const clampAt = (end: number, ellipsis: number): number =>
        Math.ceil(widthTo(node, end) + ellipsis + CLAMP_SLACK_PX);
      const fullWidth = widthTo(node, node.data.length);
      if (fullWidth <= available + FIT_TOLERANCE_PX) {
        if (limit === null) {
          apply('', null, null);
          return;
        }
        const clamp = clampAt(limit, measureEllipsisWidth(element));
        // The words past the limit are narrower than "…": show them instead.
        if (clamp >= fullWidth) {
          apply('', null, null);
          return;
        }
        apply(`${clamp}px`, 'word', limit);
        return;
      }
      const ellipsis = measureEllipsisWidth(element);
      const fitted = fitTextAtWordBoundary(
        node.data,
        available - ellipsis - CLAMP_SLACK_PX,
        (candidate) => widthTo(node, candidate),
      );
      if (fitted === null) {
        apply('', 'char', null);
        return;
      }
      const end = limit === null ? fitted : Math.min(fitted, limit);
      apply(`${clampAt(end, ellipsis)}px`, 'word', end);
    };
    // Streaming prose only grows its paragraph's height; measure again only
    // when the width or the font size (UI scale) changes.
    let measuredFor: string | null = null;
    const observer = new view.ResizeObserver((entries) => {
      const entry = entries[entries.length - 1];
      if (!entry) return;
      const signature = `${entry.contentRect.width}|${view.getComputedStyle(element).fontSize}`;
      if (signature === measuredFor) return;
      measuredFor = signature;
      measure();
    });
    // Never observe the clamped element: resizing an observed element inside
    // its own callback loops.
    observer.observe(layoutAncestor(element, view));
    return (): void => {
      observer.disconnect();
      element.style.maxWidth = '';
      element.removeAttribute('data-truncated');
      element.removeAttribute('data-visible-length');
      if (titled) element.removeAttribute('title');
    };
  }, [hoverTitle, maxWords, ref, text]);
}
