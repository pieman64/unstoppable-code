const FONT_LONGHANDS = [
  'fontFamily',
  'fontSize',
  'fontStyle',
  'fontWeight',
  'letterSpacing',
] as const;

function computedStyleOf(element: HTMLElement): CSSStyleDeclaration {
  const view = element.ownerDocument.defaultView;
  return view ? view.getComputedStyle(element) : getComputedStyle(element);
}

/** Width `text` would take in `reference`'s font, measured off-screen. */
export function measureTextWidth(reference: HTMLElement, text: string): number {
  const probe = reference.ownerDocument.createElement('span');
  probe.textContent = text;
  probe.style.position = 'absolute';
  probe.style.visibility = 'hidden';
  probe.style.whiteSpace = 'nowrap';
  const style = computedStyleOf(reference);
  // `font` shorthand reads back empty in Chromium; copy the longhands.
  for (const property of FONT_LONGHANDS) {
    probe.style[property] = style[property];
  }
  reference.ownerDocument.body.append(probe);
  try {
    return probe.getBoundingClientRect().width;
  } finally {
    probe.remove();
  }
}

const ellipsisWidths = new Map<string, number>();

/** Width of "…" in `reference`'s font, cached per font. */
export function measureEllipsisWidth(reference: HTMLElement): number {
  const style = computedStyleOf(reference);
  const font = FONT_LONGHANDS.map((property) => style[property]).join('|');
  const cached = ellipsisWidths.get(font);
  if (cached !== undefined) return cached;
  const width = measureTextWidth(reference, '…');
  ellipsisWidths.set(font, width);
  return width;
}
