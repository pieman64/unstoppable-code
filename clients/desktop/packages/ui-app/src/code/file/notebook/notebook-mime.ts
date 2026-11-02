import type { NotebookMimeBundle } from './notebook-types';

export type NotebookOutputRendering =
  | {
      readonly kind: 'image';
      readonly mime: 'image/png' | 'image/jpeg' | 'image/svg+xml';
      readonly src: string;
    }
  | { readonly kind: 'latex'; readonly markdown: string }
  | { readonly kind: 'markdown'; readonly markdown: string }
  | { readonly kind: 'text'; readonly text: string };

const MAX_BASE64_IMAGE_CHARACTERS = 16 * 1024 * 1024;
const SVG_BASE64_CHUNK_SIZE = 0x6000;
const VALID_BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
const SAFE_CODE_LANGUAGE = /^[A-Za-z0-9_+#.-]+$/;
const SPECIAL_FENCE_LANGUAGES = new Set(['latex', 'tex', 'math', 'mermaid']);

function makeFence(source: string): string {
  let longestBacktickRun = 0;
  let currentBacktickRun = 0;
  for (let index = 0; index < source.length; index += 1) {
    if (source.charAt(index) === '`') {
      currentBacktickRun += 1;
      longestBacktickRun = Math.max(longestBacktickRun, currentBacktickRun);
    } else {
      currentBacktickRun = 0;
    }
  }
  return '`'.repeat(Math.max(3, longestBacktickRun + 1));
}

function hasContent(value: string | undefined): value is string {
  return value !== undefined && value.length > 0;
}

/** A fenced code block for the shared Markdown renderer, safe for any source. */
export function codeFenceMarkdown(
  source: string,
  language: string | null,
): string {
  const fence = makeFence(source);
  const safeLanguage =
    language !== null &&
    SAFE_CODE_LANGUAGE.test(language) &&
    !SPECIAL_FENCE_LANGUAGES.has(language.toLowerCase())
      ? language
      : '';
  return `${fence}${safeLanguage}\n${source}\n${fence}`;
}

/** text/latex output as display math for the shared Markdown renderer. */
export function latexOutputMarkdown(latex: string): string {
  let source = latex.trim();
  if (source.startsWith('$$') && source.endsWith('$$') && source.length >= 4) {
    source = source.slice(2, -2).trim();
  } else if (
    source.startsWith('$') &&
    source.endsWith('$') &&
    source.length >= 2
  ) {
    source = source.slice(1, -1).trim();
  } else if (
    source.startsWith('\\[') &&
    source.endsWith('\\]') &&
    source.length >= 4
  ) {
    source = source.slice(2, -2).trim();
  }
  if (source.length === 0) return '';

  const fence = makeFence(source);
  return `${fence}math\n${source}\n${fence}`;
}

/** Picks what to show for a MIME bundle; null when nothing is displayable. */
export function selectNotebookOutputRendering(
  data: NotebookMimeBundle,
): NotebookOutputRendering | null {
  const png = data['image/png'];
  if (hasContent(png)) {
    const src = base64ImageDataUrl('image/png', png);
    if (src !== null) return { kind: 'image', mime: 'image/png', src };
  }

  const jpeg = data['image/jpeg'];
  if (hasContent(jpeg)) {
    const src = base64ImageDataUrl('image/jpeg', jpeg);
    if (src !== null) return { kind: 'image', mime: 'image/jpeg', src };
  }

  const svg = data['image/svg+xml'];
  if (hasContent(svg)) {
    const src = svgImageDataUrl(svg);
    if (src !== null) return { kind: 'image', mime: 'image/svg+xml', src };
  }

  const latex = data['text/latex'];
  if (hasContent(latex)) {
    const markdown = latexOutputMarkdown(latex);
    if (markdown.length > 0) return { kind: 'latex', markdown };
  }

  const markdown = data['text/markdown'];
  if (hasContent(markdown)) return { kind: 'markdown', markdown };

  const text = data['text/plain'];
  if (hasContent(text)) return { kind: 'text', text };

  return null;
}

/** Returns a data URL for validated base64 PNG or JPEG image content. */
export function base64ImageDataUrl(
  mime: 'image/png' | 'image/jpeg',
  base64: string,
): string | null {
  const normalized = base64.replace(/\s/g, '');
  if (
    normalized.length === 0 ||
    normalized.length > MAX_BASE64_IMAGE_CHARACTERS ||
    normalized.length % 4 !== 0 ||
    !VALID_BASE64.test(normalized)
  ) {
    return null;
  }
  return `data:${mime};base64,${normalized}`;
}

/** Encodes SVG XML as a base64 data URL without placing SVG markup in the DOM. */
export function svgImageDataUrl(svg: string): string | null {
  if (svg.trim().length === 0) return null;

  try {
    const bytes = new TextEncoder().encode(svg);
    let base64 = '';
    for (
      let offset = 0;
      offset < bytes.length;
      offset += SVG_BASE64_CHUNK_SIZE
    ) {
      const end = Math.min(offset + SVG_BASE64_CHUNK_SIZE, bytes.length);
      const binary = String.fromCharCode(...bytes.subarray(offset, end));
      base64 += btoa(binary);
    }
    return `data:image/svg+xml;base64,${base64}`;
  } catch {
    return null;
  }
}
