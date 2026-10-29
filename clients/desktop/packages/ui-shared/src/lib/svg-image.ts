import DOMPurify from 'dompurify';

/** Largest SVG document accepted for an inline image preview. */
export const SVG_IMAGE_MAX_BYTES = 5 * 1024 * 1024;

const SVG_MEDIA_TYPE = 'image/svg+xml';
const XLINK_NAMESPACE = 'http://www.w3.org/1999/xlink';
const LOCAL_FRAGMENT = /^#[^\s#]+$/;

/** Media type without parameters, lower-cased (`IMAGE/SVG+XML; x` → `image/svg+xml`). */
function essence(mediaType: string): string {
  return mediaType.split(';')[0].trim().toLowerCase();
}

export function isSvgImageMediaType(mediaType: string | undefined): boolean {
  return mediaType !== undefined && essence(mediaType) === SVG_MEDIA_TYPE;
}

/**
 * Keep `<use>` only when it points at an element in the same document.
 * Icon sprites and design-tool exports draw from `<defs>` this way; any other
 * reference (external file, `data:`, `javascript:`) is removed.
 */
function dropNonLocalUseElements(root: Element): void {
  for (const use of Array.from(root.getElementsByTagName('use'))) {
    const reference =
      use.getAttribute('href') ?? use.getAttributeNS(XLINK_NAMESPACE, 'href');
    if (reference === null || !LOCAL_FRAGMENT.test(reference.trim())) {
      use.remove();
    }
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

/**
 * Sanitized `data:` URL for untrusted SVG bytes, or null when the bytes are
 * not a well-formed SVG document or sanitizing is unavailable.
 *
 * Callers must render the result only through `<img>`. A `blob:` URL for SVG
 * stays navigable as a same-origin active document, so SVG never reaches
 * Blob creation; a `data:` document has an opaque origin, and the sanitizer
 * strips script, event handlers, and embedded HTML before encoding.
 */
export function svgImageDataUrl(bytes: ArrayBuffer): string | null {
  if (bytes.byteLength === 0 || bytes.byteLength > SVG_IMAGE_MAX_BYTES) {
    return null;
  }
  // Without a DOM, DOMPurify returns its input unchanged. Fail closed.
  if (!DOMPurify.isSupported) return null;
  let source: string;
  try {
    source = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
  const fragment = DOMPurify.sanitize(source, {
    USE_PROFILES: { svg: true, svgFilters: true },
    ADD_TAGS: ['use'],
    FORBID_TAGS: ['foreignObject', 'script', 'a'],
    RETURN_DOM_FRAGMENT: true,
  });
  const roots = Array.from(fragment.children);
  const root = roots[0];
  if (
    roots.length !== 1 ||
    root === undefined ||
    root.namespaceURI !== 'http://www.w3.org/2000/svg' ||
    root.localName !== 'svg'
  ) {
    return null;
  }
  dropNonLocalUseElements(root);
  // The element keeps its SVG namespace, so the serializer writes `xmlns`
  // even when the source omitted it or the sanitizer dropped the attribute.
  return `data:${SVG_MEDIA_TYPE};base64,${base64(
    new XMLSerializer().serializeToString(root),
  )}`;
}
