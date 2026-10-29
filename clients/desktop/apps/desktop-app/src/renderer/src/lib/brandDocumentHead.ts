/**
 * Brand-aware document head bootstrap.
 *
 * Sets `document.title` and injects a favicon `<link>` reflecting the active
 * desktop brand. Called from `main.tsx` before React mounts so the initial
 * paint shows the correct brand chrome.
 *
 * The favicon is derived from the brand's inline SVG markup as a base64 data
 * URI. The Electron renderer is served from a file:// origin and cannot reach
 * the absolute filesystem `.cache/brand/.../web-icon.png` path directly; the
 * inline SVG works universally, scales for any DPI, and avoids depending on
 * the renderer protocol setup.
 */
import type { DesktopBrandRuntime } from '@canopy/protocol/brand';

const FAVICON_LINK_ID = 'brand-favicon';

function buildSvgFaviconHref(svgContent: string): string {
  // Encoding via Base64 keeps the data URI clean and avoids accidental
  // breakage on characters like `#` (which become URL fragments otherwise).
  if (typeof window !== 'undefined' && typeof window.btoa === 'function') {
    return `data:image/svg+xml;base64,${window.btoa(unescape(encodeURIComponent(svgContent)))}`;
  }
  return `data:image/svg+xml;utf8,${encodeURIComponent(svgContent)}`;
}

export function applyBrandDocumentHead(brand: DesktopBrandRuntime): void {
  if (typeof document === 'undefined') return;

  document.title = brand.web.title || brand.displayName;

  const head = document.head;
  if (!head) return;

  let link = document.getElementById(FAVICON_LINK_ID) as HTMLLinkElement | null;
  if (!link) {
    link = document.createElement('link');
    link.id = FAVICON_LINK_ID;
    link.rel = 'icon';
    head.appendChild(link);
  }

  const svgContent = brand.assets.logoSvg;
  if (svgContent && svgContent.includes('<svg')) {
    link.type = 'image/svg+xml';
    link.href = buildSvgFaviconHref(svgContent);
  }
}
