// Reads and checks the word-boundary clamp `WordBoundaryTruncatedText`
// writes on a single-line title (CAN-3889).
import { expect } from '@playwright/test';

/**
 * The clamp state of `title`, plus the rendered widths of its visible prefix
 * and of "…" in its font, measured the same way the clamp is.
 */
export function readTruncation(title) {
  return title.evaluate((element) => {
    const end = Number(element.dataset.visibleLength);
    const text = element.firstChild;
    let prefix = null;
    if (text && Number.isInteger(end)) {
      const range = document.createRange();
      range.setStart(text, 0);
      range.setEnd(text, end);
      prefix = range.getBoundingClientRect().width;
    }
    const style = getComputedStyle(element);
    const probe = document.createElement('span');
    probe.textContent = '…';
    probe.style.position = 'absolute';
    probe.style.visibility = 'hidden';
    probe.style.whiteSpace = 'nowrap';
    for (const property of [
      'fontFamily',
      'fontSize',
      'fontStyle',
      'fontWeight',
      'letterSpacing',
    ]) {
      probe.style[property] = style[property];
    }
    document.body.append(probe);
    const ellipsis = probe.getBoundingClientRect().width;
    probe.remove();
    return {
      truncated: element.dataset.truncated ?? null,
      visibleLength: Number.isInteger(end) ? end : null,
      maxWidth: element.style.maxWidth,
      title: element.getAttribute('title'),
      text: element.textContent,
      childNodes: element.childNodes.length,
      prefix,
      ellipsis,
      width: element.getBoundingClientRect().width,
      overflows: element.scrollWidth > element.clientWidth,
    };
  });
}

/** `state` is cut after a whole word of `fullText`, by exactly `prefix…`. */
export function expectWordCut(state, fullText) {
  expect(state.truncated).toBe('word');
  expect(state.text).toBe(fullText);
  expect(state.childNodes).toBe(1);
  const end = state.visibleLength;
  expect(end).toBeGreaterThan(0);
  expect(fullText[end]).toBe(' ');
  expect(fullText[end - 1]).not.toBe(' ');
  const maxWidth = Number.parseFloat(state.maxWidth);
  expect(maxWidth).toBeGreaterThanOrEqual(state.prefix + state.ellipsis + 1);
  expect(maxWidth).toBeLessThanOrEqual(state.prefix + state.ellipsis + 2);
  expect(state.width).toBeLessThanOrEqual(maxWidth + 0.5);
}

/** `state` is a title with no whole word that fits: native mid-word cut. */
export function expectCharCut(state, fullText) {
  expect(state.truncated).toBe('char');
  expect(state.maxWidth).toBe('');
  expect(state.text).toBe(fullText);
  expect(state.childNodes).toBe(1);
  expect(state.overflows).toBe(true);
}
