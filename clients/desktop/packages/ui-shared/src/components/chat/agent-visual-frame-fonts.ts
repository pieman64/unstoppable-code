import {
  AGENT_VISUAL_FONT_FAMILY_HOOKS,
  AGENT_VISUAL_FONT_MAX_BYTES,
  AGENT_VISUAL_FONT_MAX_FACES,
  AGENT_VISUAL_FONT_VARIABLES,
  normalizeFontFamilyName,
  parseFontFaceSourceUrl,
  parseFontFamilyList,
  sanitizeAgentVisualFontFaces,
  type AgentVisualFontDescriptors,
  type AgentVisualFontFace,
} from '../../lib/agent-visual-fonts';
import type { AgentVisualTheme } from '../../lib/agent-visual-html';

type DeclaredFace = AgentVisualFontDescriptors & { url: string };

type FontCache = {
  /** Font bytes by absolute URL; a failed fetch is forgotten and retried. */
  bytes: Map<string, Promise<ArrayBuffer | null>>;
  declared: { sheetCount: number; faces: DeclaredFace[] } | null;
};

const caches = new WeakMap<Document, FontCache>();

function getCache(ownerDocument: Document): FontCache {
  let cache = caches.get(ownerDocument);
  if (!cache) {
    cache = { bytes: new Map(), declared: null };
    caches.set(ownerDocument, cache);
  }
  return cache;
}

/** The range of a face that declares none: every code point. */
const FULL_UNICODE_RANGE = 'U+0-10FFFF';

function descriptor(
  style: CSSStyleDeclaration,
  name: string,
  fallback: string,
): string {
  const value = style.getPropertyValue(name).trim();
  return value.length > 0 ? value.replace(/\s+/g, ' ') : fallback;
}

function isGroupingRule(
  rule: CSSRule,
): rule is CSSRule & { cssRules: CSSRuleList } {
  return 'cssRules' in rule;
}

/** Structural, so a rule from any realm or CSSOM implementation qualifies. */
function isFontFaceRule(rule: CSSRule): rule is CSSFontFaceRule {
  return (
    'style' in rule &&
    rule.cssText.trimStart().toLowerCase().startsWith('@font-face')
  );
}

function collectFontFaceRules(
  rules: CSSRuleList,
  found: CSSFontFaceRule[],
): void {
  for (const rule of Array.from(rules)) {
    if (isFontFaceRule(rule)) found.push(rule);
    else if (isGroupingRule(rule)) collectFontFaceRules(rule.cssRules, found);
  }
}

/** Every `@font-face` rule the document's own stylesheets declare with a URL. */
function readDeclaredFaces(ownerDocument: Document): DeclaredFace[] {
  const cache = getCache(ownerDocument);
  const sheetCount = ownerDocument.styleSheets.length;
  if (cache.declared?.sheetCount === sheetCount) return cache.declared.faces;
  const faces: DeclaredFace[] = [];
  for (const sheet of Array.from(ownerDocument.styleSheets)) {
    const rules: CSSFontFaceRule[] = [];
    try {
      collectFontFaceRules(sheet.cssRules, rules);
    } catch {
      // A cross-origin stylesheet does not expose its rules.
      continue;
    }
    for (const rule of rules) {
      const source = parseFontFaceSourceUrl(rule.style.getPropertyValue('src'));
      const family = normalizeFontFamilyName(
        rule.style.getPropertyValue('font-family'),
      );
      if (!source || family.length === 0) continue;
      let url: string;
      try {
        url = new URL(
          source,
          rule.parentStyleSheet?.href ?? ownerDocument.baseURI,
        ).href;
      } catch {
        continue;
      }
      faces.push({
        family,
        style: descriptor(rule.style, 'font-style', 'normal'),
        weight: descriptor(rule.style, 'font-weight', 'normal'),
        stretch: descriptor(rule.style, 'font-stretch', 'normal'),
        unicodeRange: descriptor(
          rule.style,
          'unicode-range',
          FULL_UNICODE_RANGE,
        ),
        url,
      });
    }
  }
  cache.declared = { sheetCount, faces };
  return faces;
}

/**
 * A `unicode-range` in one spelling, so a declared rule and its loaded face
 * compare equal however each serializes it (`U+0000-00FF` and `U+0-FF`, in
 * either order).
 */
function normalizeUnicodeRange(value: string): string {
  return value
    .split(',')
    .map((part) => {
      const token = part.trim().toUpperCase();
      const match = /^U\+([0-9A-F?]{1,6})(?:-([0-9A-F]{1,6}))?$/.exec(token);
      if (match === null) return token;
      const [, start = '', end] = match;
      const low = Number.parseInt(start.replace(/\?/g, '0'), 16);
      const high = Number.parseInt(end ?? start.replace(/\?/g, 'F'), 16);
      return low === high
        ? `U+${low.toString(16)}`
        : `U+${low.toString(16)}-${high.toString(16)}`;
    })
    .sort()
    .join(',');
}

/**
 * One face by family, style, weight, and range. The range tells apart the
 * subsets a host splits one family into, so only a loaded subset matches.
 */
function loadedFaceKey(
  family: string,
  style: string,
  weight: string,
  unicodeRange: string,
): string {
  return [
    normalizeFontFamilyName(family).toLowerCase(),
    style.trim().toLowerCase(),
    weight.trim().replace(/\s+/g, ' ').toLowerCase(),
    normalizeUnicodeRange(unicodeRange || FULL_UNICODE_RANGE),
  ].join('|');
}

/** The faces the document has finished loading, by family, style, weight, and range. */
function readLoadedFaceKeys(ownerDocument: Document): Set<string> {
  const keys = new Set<string>();
  const fonts: unknown = Reflect.get(ownerDocument, 'fonts');
  if (
    typeof fonts !== 'object' ||
    fonts === null ||
    !(Symbol.iterator in fonts)
  )
    return keys;
  for (const face of Array.from(ownerDocument.fonts)) {
    if (face.status === 'loaded')
      keys.add(
        loadedFaceKey(face.family, face.style, face.weight, face.unicodeRange),
      );
  }
  return keys;
}

function fetchFontBytes(
  ownerDocument: Document,
  url: string,
): Promise<ArrayBuffer | null> {
  const cache = getCache(ownerDocument);
  const cached = cache.bytes.get(url);
  if (cached) return cached;
  const view = ownerDocument.defaultView;
  const request =
    view && typeof view.fetch === 'function'
      ? view
          .fetch(url)
          .then((response) => (response.ok ? response.arrayBuffer() : null))
          .then((bytes) =>
            bytes &&
            bytes.byteLength > 0 &&
            bytes.byteLength <= AGENT_VISUAL_FONT_MAX_BYTES
              ? bytes
              : null,
          )
          .catch((): null => null)
      : Promise.resolve(null);
  cache.bytes.set(url, request);
  void request.then((bytes): void => {
    if (bytes === null && cache.bytes.get(url) === request)
      cache.bytes.delete(url);
  });
  return request;
}

/**
 * The family the theme asks for, by the lower-cased name the host declares its
 * faces under. A family the theme names stands for itself. Where the host
 * points a tokens hook at a name its bundler generated, that name stands for
 * the first family of the hook's variable.
 */
function readThemeFamilies(
  ownerDocument: Document,
  theme: AgentVisualTheme,
): Map<string, string> {
  const families = new Map<string, string>();
  // The hooks are set where the app's text is, which can be below the root.
  const scope = ownerDocument.body ?? ownerDocument.documentElement;
  const hostStyle = ownerDocument.defaultView?.getComputedStyle(scope);
  for (const variable of AGENT_VISUAL_FONT_VARIABLES) {
    const named = parseFontFamilyList(theme.variables[variable] ?? '');
    for (const family of named) {
      if (!families.has(family.toLowerCase()))
        families.set(family.toLowerCase(), family);
    }
    const [first] = named;
    const [hostFamily] = parseFontFamilyList(
      hostStyle?.getPropertyValue(AGENT_VISUAL_FONT_FAMILY_HOOKS[variable]) ??
        '',
    );
    if (first !== undefined && hostFamily !== undefined)
      families.set(hostFamily.toLowerCase(), first);
  }
  return families;
}

/**
 * The font faces the host has loaded for the families its theme names, as
 * bytes a frame can register under those names. Faces the app has not loaded
 * are left out, so a visual never costs a download the app did not already
 * make.
 */
export async function loadAgentVisualFonts(
  ownerDocument: Document,
  theme: AgentVisualTheme,
): Promise<AgentVisualFontFace[]> {
  const families = readThemeFamilies(ownerDocument, theme);
  if (families.size === 0) return [];
  const loaded = readLoadedFaceKeys(ownerDocument);
  const wanted: DeclaredFace[] = [];
  for (const face of readDeclaredFaces(ownerDocument)) {
    if (wanted.length >= AGENT_VISUAL_FONT_MAX_FACES) break;
    const family = families.get(face.family.toLowerCase());
    if (
      family !== undefined &&
      loaded.has(
        loadedFaceKey(face.family, face.style, face.weight, face.unicodeRange),
      )
    )
      wanted.push({ ...face, family });
  }
  const faces = await Promise.all(
    wanted.map(async ({ url, ...descriptors }) => {
      const data = await fetchFontBytes(ownerDocument, url);
      return data ? { ...descriptors, data } : null;
    }),
  );
  return sanitizeAgentVisualFontFaces(faces.filter((face) => face !== null));
}

function isFontLoadSource(value: unknown): value is EventTarget & {
  ready?: Promise<unknown>;
} {
  return (
    typeof value === 'object' &&
    value !== null &&
    'addEventListener' in value &&
    'removeEventListener' in value
  );
}

/**
 * Calls `listener` whenever the document finishes loading font faces, and once
 * its pending loads settle. {@link loadAgentVisualFonts} leaves out a face the
 * app has not loaded yet, so a frame that became ready while the app's fonts
 * were still loading asks again then. Returns the unsubscribe.
 */
export function watchAgentVisualFontLoads(
  ownerDocument: Document,
  listener: () => void,
): () => void {
  const fonts: unknown = Reflect.get(ownerDocument, 'fonts');
  if (!isFontLoadSource(fonts)) return (): void => {};
  let watching = true;
  const onLoaded = (): void => {
    if (watching) listener();
  };
  fonts.addEventListener('loadingdone', onLoaded);
  void fonts.ready?.then(onLoaded, (): void => {});
  return (): void => {
    watching = false;
    fonts.removeEventListener('loadingdone', onLoaded);
  };
}

/** Test-only: forget what was read from a document. */
export function resetAgentVisualFontsForTests(ownerDocument: Document): void {
  caches.delete(ownerDocument);
}
