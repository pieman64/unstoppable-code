/**
 * Picture export for rendered Mermaid diagrams. Loaded only when a person
 * copies or saves a diagram, after the renderer chunk is already loaded.
 */
import { sanitizeMermaidSvg } from './markdown-mermaid-renderer';

/** Longest intrinsic side accepted for a PNG, and the canvas side limit. */
export const MERMAID_EXPORT_MAX_SIDE = 4096;
/** Canvas pixel budget, well below browser canvas area limits. */
export const MERMAID_EXPORT_MAX_PIXELS = 16_777_216;
const MAX_PIXEL_RATIO = 3;

export const MERMAID_EXPORT_TOO_LARGE =
  'This diagram is too large to export as a picture';
export const MERMAID_EXPORT_FAILED = 'Couldn’t export this diagram';

/** A failure whose message is safe to show as-is. */
export class MermaidExportError extends Error {
  override readonly name = 'MermaidExportError';
}

export interface StandaloneMermaidSvg {
  /** Sanitized, standalone SVG document text. */
  readonly svg: string;
  readonly width: number;
  readonly height: number;
}

const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';
const GENERIC_FONT =
  /(^|,)\s*(sans-serif|serif|monospace|cursive|fantasy)\s*$/i;
const FONT_FALLBACK =
  'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';

/**
 * App web fonts are unavailable once the SVG stands alone or loads as an
 * image, so every family list ends in system fonts instead of a serif default.
 */
function withFontFallback(css: string): string {
  return css.replace(
    /(font-family\s*:\s*)([^;"}]+)/gi,
    (declaration: string, property: string, families: string) => {
      const list = families.replace(/\s*!important\s*$/i, '').trim();
      if (GENERIC_FONT.test(list)) return declaration;
      return `${property}${list}, ${FONT_FALLBACK}${families.slice(families.indexOf(list) + list.length)}`;
    },
  );
}

function positive(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

function lengthAttribute(value: string | null): number {
  if (value === null) return Number.NaN;
  const match = /^\s*([0-9]*\.?[0-9]+)\s*(px)?\s*$/.exec(value);
  return match ? Number(match[1]) : Number.NaN;
}

/**
 * Turns the rendered diagram into a standalone SVG document: sanitized with
 * the renderer's policy, explicit finite dimensions, preserved viewBox, and
 * an opaque background so it stays legible outside the app.
 */
export function standaloneMermaidSvg(
  renderedSvg: string,
  background: string,
): StandaloneMermaidSvg {
  let clean: string;
  try {
    clean = sanitizeMermaidSvg(renderedSvg);
  } catch {
    throw new MermaidExportError(MERMAID_EXPORT_FAILED);
  }
  const parsed = new DOMParser().parseFromString(clean, 'image/svg+xml');
  const root = parsed.documentElement;
  if (
    parsed.querySelector('parsererror') ||
    root.localName !== 'svg' ||
    root.namespaceURI !== SVG_NAMESPACE
  ) {
    throw new MermaidExportError(MERMAID_EXPORT_FAILED);
  }

  const viewBox = (root.getAttribute('viewBox') ?? '')
    .trim()
    .split(/[\s,]+/)
    .map(Number);
  let x = 0;
  let y = 0;
  let width: number;
  let height: number;
  if (
    viewBox.length === 4 &&
    viewBox.every(Number.isFinite) &&
    positive(viewBox[2]) &&
    positive(viewBox[3])
  ) {
    [x, y, width, height] = viewBox;
  } else {
    // Without a usable viewBox, fall back to explicit pixel dimensions.
    width = lengthAttribute(root.getAttribute('width'));
    height = lengthAttribute(root.getAttribute('height'));
    if (!positive(width) || !positive(height)) {
      throw new MermaidExportError(MERMAID_EXPORT_FAILED);
    }
    root.setAttribute('viewBox', `0 0 ${width} ${height}`);
  }

  // The in-app copy is a decorative child of an accessible wrapper and is
  // sized by app CSS. The exported document stands alone.
  root.removeAttribute('aria-hidden');
  root.removeAttribute('focusable');
  root.removeAttribute('style');
  for (const element of [root, ...Array.from(root.querySelectorAll('*'))]) {
    const style = element.getAttribute('style');
    if (style) element.setAttribute('style', withFontFallback(style));
    const family = element.getAttribute('font-family');
    if (family && !GENERIC_FONT.test(family.trim())) {
      element.setAttribute('font-family', `${family}, ${FONT_FALLBACK}`);
    }
    if (element.localName === 'style' && element.textContent) {
      element.textContent = withFontFallback(element.textContent);
    }
  }
  root.setAttribute('font-family', FONT_FALLBACK);
  root.setAttribute('width', String(width));
  root.setAttribute('height', String(height));
  if (!root.hasAttribute('preserveAspectRatio'))
    root.setAttribute('preserveAspectRatio', 'xMidYMid meet');

  const backdrop = parsed.createElementNS(SVG_NAMESPACE, 'rect');
  backdrop.setAttribute('x', String(x));
  backdrop.setAttribute('y', String(y));
  backdrop.setAttribute('width', String(width));
  backdrop.setAttribute('height', String(height));
  backdrop.setAttribute('fill', background);
  root.insertBefore(backdrop, root.firstChild);

  return {
    svg: new XMLSerializer().serializeToString(root),
    width,
    height,
  };
}

/**
 * The color as sRGB hex. Engines may report wide-gamut surfaces such as
 * `color(display-p3 …)`, which external SVG viewers do not all understand.
 */
export function srgbHexColor(
  colors: string | readonly string[],
  ownerDocument: Document,
): string {
  const layers = typeof colors === 'string' ? [colors] : colors;
  const fallback = layers.at(-1) || '#ffffff';
  const canvas = ownerDocument.createElement('canvas');
  canvas.width = canvas.height = 1;
  try {
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) return fallback;
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, 1, 1);
    for (const color of layers) {
      if (!color) continue;
      context.fillStyle = color;
      context.fillRect(0, 0, 1, 1);
    }
    const pixel = context.getImageData(0, 0, 1, 1).data;
    return `#${Array.from(pixel.subarray(0, 3), (value) =>
      value.toString(16).padStart(2, '0'),
    ).join('')}`;
  } catch {
    return fallback;
  } finally {
    canvas.width = canvas.height = 0;
  }
}

function base64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
}

/** Loaded through `<img>` only; never an SVG blob URL. See `svg-image.ts`. */
export function svgDataUrl(svg: string): string {
  return `data:image/svg+xml;base64,${base64(svg)}`;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** Clipboard HTML: a single image whose source is the sanitized SVG. */
export function mermaidClipboardHtml(
  diagram: StandaloneMermaidSvg,
  alt: string,
): string {
  return `<img src="${svgDataUrl(diagram.svg)}" alt="${escapeHtml(alt)}" width="${diagram.width}" height="${diagram.height}">`;
}

/** Canvas scale for a diagram, or an error when it cannot become a PNG. */
export function mermaidRasterScale(
  width: number,
  height: number,
  pixelRatio: number,
): number {
  if (!positive(width) || !positive(height)) {
    throw new MermaidExportError(MERMAID_EXPORT_FAILED);
  }
  if (Math.max(width, height) > MERMAID_EXPORT_MAX_SIDE) {
    throw new MermaidExportError(MERMAID_EXPORT_TOO_LARGE);
  }
  const requested = positive(pixelRatio)
    ? Math.min(pixelRatio, MAX_PIXEL_RATIO)
    : 1;
  const scale = Math.min(
    requested,
    MERMAID_EXPORT_MAX_SIDE / width,
    MERMAID_EXPORT_MAX_SIDE / height,
    Math.sqrt(MERMAID_EXPORT_MAX_PIXELS / (width * height)),
  );
  if (!positive(scale)) throw new MermaidExportError(MERMAID_EXPORT_FAILED);
  return scale;
}

/** Rasterizes a standalone diagram to a PNG at a bounded device scale. */
export async function rasterizeMermaidSvg(
  diagram: StandaloneMermaidSvg,
  ownerDocument: Document,
): Promise<Blob> {
  const view = ownerDocument.defaultView;
  if (!view) throw new MermaidExportError(MERMAID_EXPORT_FAILED);
  const scale = mermaidRasterScale(
    diagram.width,
    diagram.height,
    view.devicePixelRatio,
  );
  await ownerDocument.fonts?.ready;
  const image = new view.Image();
  const canvas = ownerDocument.createElement('canvas');
  try {
    image.src = svgDataUrl(diagram.svg);
    try {
      await image.decode();
    } catch {
      throw new MermaidExportError(MERMAID_EXPORT_FAILED);
    }
    canvas.width = Math.max(1, Math.round(diagram.width * scale));
    canvas.height = Math.max(1, Math.round(diagram.height * scale));
    const context = canvas.getContext('2d');
    if (!context) throw new MermaidExportError(MERMAID_EXPORT_FAILED);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    let blob: Blob | null;
    try {
      blob = await new Promise<Blob | null>((resolve) =>
        canvas.toBlob(resolve, 'image/png'),
      );
    } catch {
      // A tainted canvas throws a SecurityError here.
      throw new MermaidExportError(MERMAID_EXPORT_FAILED);
    }
    if (!blob) throw new MermaidExportError(MERMAID_EXPORT_FAILED);
    return blob;
  } finally {
    image.removeAttribute('src');
    canvas.width = 0;
    canvas.height = 0;
  }
}

export function svgBlob(diagram: StandaloneMermaidSvg): Blob {
  return new Blob([diagram.svg], { type: 'image/svg+xml' });
}
