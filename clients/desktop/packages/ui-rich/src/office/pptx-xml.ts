import { DOMParser } from '@xmldom/xmldom';

/**
 * Minimal DrawingML/PresentationML helpers for the PPTX preview parser. Web
 * Workers have no `DOMParser`, so parts are parsed with xmldom and navigated
 * by local name; prefixes are not significant for the structures read here.
 */

export const R_NS =
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

const ELEMENT_NODE = 1;
const HEX_COLOR = /^[0-9A-Fa-f]{6}$/;
const decoder = new TextDecoder('utf-8');

export const PPTX_MAX_STRUCTURE_MARKERS_PER_PART = 100_000;
export const PPTX_MAX_STRUCTURE_MARKERS = 200_000;
export const PPTX_MAX_XML_DEPTH = 128;

export interface PptxXmlBudget {
  structureMarkers: number;
}

/**
 * Like XLSX admission, count every literal '<' before the vendor parser can
 * allocate nodes. Include ignored structures, comments and attribute content;
 * this conservative bound does not trust namespaces or the XML grammar.
 */
function admitStructure(bytes: Uint8Array, budget: PptxXmlBudget): void {
  let markers = 0;
  for (const byte of bytes) {
    if (byte !== 0x3c) continue;
    markers += 1;
    budget.structureMarkers += 1;
    if (
      markers > PPTX_MAX_STRUCTURE_MARKERS_PER_PART ||
      budget.structureMarkers > PPTX_MAX_STRUCTURE_MARKERS
    ) {
      throw new Error('Presentation exceeds the source structure budget.');
    }
  }
}

function tagEnd(text: string, start: number): number {
  let quote: string | undefined;
  for (let index = start; index < text.length; index += 1) {
    const character = text[index];
    if (quote !== undefined) {
      if (character === quote) quote = undefined;
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (character === '>') {
      return index;
    }
  }
  throw new Error('Malformed presentation XML: unterminated tag.');
}

/** Bound recursive DOM navigation, respecting XML's non-element sections. */
function admitDepth(text: string): void {
  let depth = 0;
  let offset = 0;
  while (offset < text.length) {
    const start = text.indexOf('<', offset);
    if (start < 0) return;
    const terminator = text.startsWith('<!--', start)
      ? '-->'
      : text.startsWith('<![CDATA[', start)
        ? ']]>'
        : text.startsWith('<?', start)
          ? '?>'
          : undefined;
    if (terminator !== undefined) {
      const end = text.indexOf(terminator, start + 2);
      if (end < 0) {
        throw new Error('Malformed presentation XML: unterminated section.');
      }
      offset = end + terminator.length;
      continue;
    }
    const end = tagEnd(text, start + 1);
    if (text[start + 1] === '/') {
      depth = Math.max(0, depth - 1);
    } else if (text[start + 1] !== '!') {
      if (depth + 1 > PPTX_MAX_XML_DEPTH) {
        throw new Error('Presentation exceeds the XML depth budget.');
      }
      if (text[end - 1] !== '/') depth += 1;
    }
    offset = end + 1;
  }
}

function isElement(node: Node): node is Element {
  return node.nodeType === ELEMENT_NODE;
}

/** Parse one XML part, rejecting DTDs so no entity expansion can occur. */
export function parseXmlPart(
  bytes: Uint8Array,
  budget: PptxXmlBudget = { structureMarkers: 0 },
): Element {
  admitStructure(bytes, budget);
  const text = decoder.decode(bytes);
  if (/<!DOCTYPE/i.test(text)) {
    throw new Error('Presentation parts may not declare a DTD.');
  }
  admitDepth(text);
  const fail = (message: unknown): never => {
    throw new Error(`Malformed presentation XML: ${String(message)}`);
  };
  const document = new DOMParser({
    errorHandler: {
      warning: (): void => undefined,
      error: fail,
      fatalError: fail,
    },
  }).parseFromString(text, 'text/xml');
  const root = document.documentElement;
  if (!root) throw new Error('Presentation part has no root element.');
  return root;
}

export function childElements(node: Element | undefined): Element[] {
  if (!node) return [];
  const result: Element[] = [];
  for (let index = 0; index < node.childNodes.length; index += 1) {
    const childNode = node.childNodes[index];
    if (childNode && isElement(childNode)) result.push(childNode);
  }
  return result;
}

function localName(node: Element): string {
  return node.localName ?? node.nodeName;
}

export function child(
  node: Element | undefined,
  name: string,
): Element | undefined {
  return childElements(node).find((entry) => localName(entry) === name);
}

export function children(node: Element | undefined, name: string): Element[] {
  return childElements(node).filter((entry) => localName(entry) === name);
}

export function path(
  node: Element | undefined,
  ...names: readonly string[]
): Element | undefined {
  let current = node;
  for (const name of names) current = child(current, name);
  return current;
}

export function nameOf(node: Element): string {
  return localName(node);
}

export function attr(
  node: Element | undefined,
  name: string,
): string | undefined {
  return node?.hasAttribute(name) === true
    ? (node.getAttribute(name) ?? undefined)
    : undefined;
}

/** Relationship id attribute (`r:id`, `r:embed`), whatever its prefix. */
export function relAttr(
  node: Element | undefined,
  name: string,
): string | undefined {
  if (!node) return undefined;
  const namespaced = node.getAttributeNS(R_NS, name);
  return namespaced ? namespaced : attr(node, `r:${name}`);
}

export function intAttr(
  node: Element | undefined,
  name: string,
): number | undefined {
  const raw = attr(node, name);
  if (raw === undefined || !/^-?\d+$/.test(raw)) return undefined;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : undefined;
}

export function boolAttr(
  node: Element | undefined,
  name: string,
): boolean | undefined {
  const raw = attr(node, name);
  if (raw === undefined) return undefined;
  return raw === '1' || raw === 'true';
}

/** Concatenated text of every descendant `t` element. */
export function descendantText(node: Element): string {
  let text = '';
  for (const entry of childElements(node)) {
    text +=
      localName(entry) === 't'
        ? (entry.textContent ?? '')
        : descendantText(entry);
  }
  return text;
}

export interface PptxThemeContext {
  /** Scheme slot (`dk1`, `accent1`, …) to `RRGGBB`. */
  readonly scheme: ReadonlyMap<string, string>;
  /** Master colour map (`tx1` → `dk1`, …). */
  readonly colorMap: ReadonlyMap<string, string>;
  readonly majorFont?: string;
  readonly minorFont?: string;
}

const DEFAULT_COLOR_MAP: ReadonlyMap<string, string> = new Map([
  ['bg1', 'lt1'],
  ['tx1', 'dk1'],
  ['bg2', 'lt2'],
  ['tx2', 'dk2'],
]);

const PRESET_COLORS: ReadonlyMap<string, string> = new Map([
  ['black', '000000'],
  ['white', 'FFFFFF'],
  ['red', 'FF0000'],
  ['green', '008000'],
  ['blue', '0000FF'],
  ['yellow', 'FFFF00'],
  ['gray', '808080'],
  ['grey', '808080'],
  ['orange', 'FFA500'],
  ['purple', '800080'],
]);

const COLOR_ELEMENTS: ReadonlySet<string> = new Set([
  'srgbClr',
  'schemeClr',
  'sysClr',
  'prstClr',
]);

export const EMPTY_THEME: PptxThemeContext = {
  scheme: new Map(),
  colorMap: DEFAULT_COLOR_MAP,
};

export function readTheme(
  theme: Element | undefined,
  master: Element | undefined,
): PptxThemeContext {
  const scheme = new Map<string, string>();
  const colorScheme = path(theme, 'themeElements', 'clrScheme');
  for (const slot of childElements(colorScheme)) {
    const base = baseColor(childElements(slot)[0], EMPTY_THEME);
    if (base !== undefined) scheme.set(localName(slot), base);
  }
  const colorMap = new Map(DEFAULT_COLOR_MAP);
  const mapping = child(master, 'clrMap');
  if (mapping) {
    for (let index = 0; index < mapping.attributes.length; index += 1) {
      const attribute = mapping.attributes[index];
      if (attribute) colorMap.set(attribute.name, attribute.value);
    }
  }
  const fonts = path(theme, 'themeElements', 'fontScheme');
  return {
    scheme,
    colorMap,
    majorFont: attr(path(fonts, 'majorFont', 'latin'), 'typeface'),
    minorFont: attr(path(fonts, 'minorFont', 'latin'), 'typeface'),
  };
}

function baseColor(
  colorNode: Element | undefined,
  theme: PptxThemeContext,
): string | undefined {
  if (!colorNode) return undefined;
  switch (localName(colorNode)) {
    case 'srgbClr': {
      const value = attr(colorNode, 'val');
      return value !== undefined && HEX_COLOR.test(value) ? value : undefined;
    }
    case 'sysClr': {
      const last = attr(colorNode, 'lastClr');
      if (last !== undefined && HEX_COLOR.test(last)) return last;
      return attr(colorNode, 'val') === 'window' ? 'FFFFFF' : '000000';
    }
    case 'prstClr':
      return PRESET_COLORS.get(attr(colorNode, 'val') ?? '');
    case 'schemeClr': {
      const value = attr(colorNode, 'val') ?? '';
      return theme.scheme.get(theme.colorMap.get(value) ?? value);
    }
    default:
      return undefined;
  }
}

function clampByte(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value)));
}

function rgbToHsl(
  red: number,
  green: number,
  blue: number,
): [number, number, number] {
  const r = red / 255;
  const g = green / 255;
  const b = blue / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const lightness = (max + min) / 2;
  if (max === min) return [0, 0, lightness];
  const delta = max - min;
  const saturation =
    lightness > 0.5 ? delta / (2 - max - min) : delta / (max + min);
  const hue =
    max === r
      ? (g - b) / delta + (g < b ? 6 : 0)
      : max === g
        ? (b - r) / delta + 2
        : (r - g) / delta + 4;
  return [hue / 6, saturation, lightness];
}

function hslToRgb(
  hue: number,
  saturation: number,
  lightness: number,
): [number, number, number] {
  if (saturation === 0) {
    const grey = lightness * 255;
    return [grey, grey, grey];
  }
  const q =
    lightness < 0.5
      ? lightness * (1 + saturation)
      : lightness + saturation - lightness * saturation;
  const p = 2 * lightness - q;
  const channel = (offset: number): number => {
    let t = hue + offset;
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return (p + (q - p) * 6 * t) * 255;
    if (t < 1 / 2) return q * 255;
    if (t < 2 / 3) return (p + (q - p) * (2 / 3 - t) * 6) * 255;
    return p * 255;
  };
  return [channel(1 / 3), channel(0), channel(-1 / 3)];
}

function hexByte(value: number): string {
  return clampByte(value).toString(16).padStart(2, '0');
}

/**
 * Resolve the colour carried by a fill-like element (`a:solidFill`,
 * `a:fontRef`, a gradient stop, …) to a CSS colour, applying the common
 * luminance, tint, shade and alpha modifiers.
 */
export function resolveColor(
  container: Element | undefined,
  theme: PptxThemeContext,
): string | undefined {
  const colorNode = childElements(container).find((entry) =>
    COLOR_ELEMENTS.has(localName(entry)),
  );
  const base = baseColor(colorNode, theme);
  if (!colorNode || base === undefined) return undefined;
  let red = parseInt(base.slice(0, 2), 16);
  let green = parseInt(base.slice(2, 4), 16);
  let blue = parseInt(base.slice(4, 6), 16);
  let alpha = 1;
  let lumMod = 1;
  let lumOff = 0;
  for (const modifier of childElements(colorNode)) {
    const value = intAttr(modifier, 'val');
    if (value === undefined) continue;
    const fraction = value / 100_000;
    switch (localName(modifier)) {
      case 'lumMod':
        lumMod = fraction;
        break;
      case 'lumOff':
        lumOff = fraction;
        break;
      case 'shade':
        red *= fraction;
        green *= fraction;
        blue *= fraction;
        break;
      case 'tint':
        red += (255 - red) * (1 - fraction);
        green += (255 - green) * (1 - fraction);
        blue += (255 - blue) * (1 - fraction);
        break;
      case 'alpha':
        alpha = Math.max(0, Math.min(1, fraction));
        break;
      default:
        break;
    }
  }
  if (lumMod !== 1 || lumOff !== 0) {
    const [hue, saturation, lightness] = rgbToHsl(red, green, blue);
    [red, green, blue] = hslToRgb(
      hue,
      saturation,
      Math.max(0, Math.min(1, lightness * lumMod + lumOff)),
    );
  }
  if (alpha < 1) {
    return `rgba(${clampByte(red)}, ${clampByte(green)}, ${clampByte(blue)}, ${alpha.toFixed(3)})`;
  }
  return `#${hexByte(red)}${hexByte(green)}${hexByte(blue)}`;
}
