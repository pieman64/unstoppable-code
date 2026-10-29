/**
 * The app's own font faces, mirrored into an agent visual.
 *
 * A visual runs in a sandboxed frame with an opaque origin and a policy that
 * loads fonts only from the allowed CDNs, so it cannot fetch the faces the
 * app bundles. The host therefore posts the bytes of the faces it has loaded,
 * and the bridge registers them under the family names the theme asks for.
 * `--font-sans` and `--font-mono` then resolve in the frame to the app's own
 * faces.
 */

export const AGENT_VISUAL_FONTS_METHOD = 'canopy/visual/fonts';

/**
 * Set on the frame's root, to the number of registered faces, once they have
 * loaded. A page that redraws when the root's style changes, as the guide's
 * theme kit does, then redraws its canvas text in the app font.
 */
export const AGENT_VISUAL_FONT_FACES_PROPERTY = '--visual-font-faces';

/** The theme variables whose families are mirrored. */
export const AGENT_VISUAL_FONT_VARIABLES = [
  '--font-sans',
  '--font-mono',
] as const;

/**
 * The hook each variable takes its first family from in the shared tokens
 * (`--font-sans: var(--font-inter, 'Inter'), …`). A host whose bundler names
 * its faces itself, as `next/font` does, points the hook at that name.
 */
export const AGENT_VISUAL_FONT_FAMILY_HOOKS: Record<
  (typeof AGENT_VISUAL_FONT_VARIABLES)[number],
  string
> = {
  '--font-sans': '--font-inter',
  '--font-mono': '--font-jetbrains-mono',
};

/** Upright and italic for a text face and a code face, with room to spare. */
export const AGENT_VISUAL_FONT_MAX_FACES = 8;
export const AGENT_VISUAL_FONT_MAX_BYTES = 2 * 1024 * 1024;
export const AGENT_VISUAL_FONT_DESCRIPTOR_MAX_LENGTH = 256;
/**
 * A subset face lists its code points, which a browser serializes with a
 * space after each comma: a latin subset alone runs to about a thousand
 * characters, past the plain descriptor limit.
 */
export const AGENT_VISUAL_FONT_UNICODE_RANGE_MAX_LENGTH = 4096;
/**
 * A `unicode-range` value: comma-separated code points, spans, and wildcard
 * ranges. Nothing else, so the value can carry no other CSS.
 */
const UNICODE_RANGE_SOURCE =
  '^ *[Uu]\\+[0-9A-Fa-f?]{1,6}(?:-[0-9A-Fa-f]{1,6})?(?: *, *[Uu]\\+[0-9A-Fa-f?]{1,6}(?:-[0-9A-Fa-f]{1,6})?)* *$';
const UNICODE_RANGE_PATTERN = new RegExp(UNICODE_RANGE_SOURCE);

export type AgentVisualFontDescriptors = {
  family: string;
  style: string;
  weight: string;
  stretch: string;
  unicodeRange: string;
};

export type AgentVisualFontFace = AgentVisualFontDescriptors & {
  data: ArrayBuffer;
};

const DESCRIPTOR_KEYS = [
  'family',
  'style',
  'weight',
  'stretch',
  'unicodeRange',
] as const;

/** Characters no descriptor may carry; none of them occur in a real one. */
export const AGENT_VISUAL_FONT_FORBIDDEN_CHARACTERS: readonly string[] = [
  '<',
  '>',
  '{',
  '}',
  ';',
  '\\',
  '"',
  "'",
  '(',
  ')',
  '\r',
  '\n',
];

/** Families a browser resolves by itself; no face is ever mirrored for them. */
const GENERIC_FAMILIES: ReadonlySet<string> = new Set([
  'serif',
  'sans-serif',
  'monospace',
  'cursive',
  'fantasy',
  'system-ui',
  'ui-serif',
  'ui-sans-serif',
  'ui-monospace',
  'ui-rounded',
  'emoji',
  'math',
  'fangsong',
  '-apple-system',
  'blinkmacsystemfont',
  'inherit',
  'initial',
  'unset',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Collapse whitespace and drop the quotes around a family name. */
export function normalizeFontFamilyName(value: string): string {
  const trimmed = value.trim();
  const unquoted =
    trimmed.length >= 2 &&
    (trimmed.startsWith('"') || trimmed.startsWith("'")) &&
    trimmed.endsWith(trimmed.charAt(0))
      ? trimmed.slice(1, -1)
      : trimmed;
  return unquoted.replace(/\s+/g, ' ').trim();
}

/**
 * The named families of a `font-family` value, in order, without generic
 * keywords. Commas inside quotes belong to the name.
 */
export function parseFontFamilyList(value: string): string[] {
  const families: string[] = [];
  let current = '';
  let quote: string | null = null;
  for (const character of value) {
    if (quote) {
      if (character === quote) quote = null;
      current += character;
    } else if (character === '"' || character === "'") {
      quote = character;
      current += character;
    } else if (character === ',') {
      families.push(current);
      current = '';
    } else current += character;
  }
  families.push(current);
  const names: string[] = [];
  for (const family of families) {
    const name = normalizeFontFamilyName(family);
    if (
      name.length > 0 &&
      !GENERIC_FAMILIES.has(name.toLowerCase()) &&
      !names.includes(name)
    )
      names.push(name);
  }
  return names;
}

/** The first `url()` of an `@font-face` `src`, or null when it names none. */
export function parseFontFaceSourceUrl(source: string): string | null {
  const match = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)\s]*))\s*\)/i.exec(source);
  const url = match?.[1] ?? match?.[2] ?? match?.[3];
  return url && url.length > 0 ? url : null;
}

/** True for an ArrayBuffer from any realm, such as a pop-out window's. */
function isArrayBuffer(value: unknown): value is ArrayBuffer {
  return Object.prototype.toString.call(value) === '[object ArrayBuffer]';
}

function isDescriptorSafe(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= AGENT_VISUAL_FONT_DESCRIPTOR_MAX_LENGTH &&
    !AGENT_VISUAL_FONT_FORBIDDEN_CHARACTERS.some((character) =>
      value.includes(character),
    )
  );
}

function isUnicodeRangeSafe(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= AGENT_VISUAL_FONT_UNICODE_RANGE_MAX_LENGTH &&
    UNICODE_RANGE_PATTERN.test(value)
  );
}

/**
 * Keep the faces a frame may register: bounded in count and size, with plain
 * descriptor strings and a non-empty family.
 */
export function sanitizeAgentVisualFontFaces(
  input: unknown,
): AgentVisualFontFace[] {
  if (!Array.isArray(input)) return [];
  const faces: AgentVisualFontFace[] = [];
  for (const candidate of input) {
    if (faces.length >= AGENT_VISUAL_FONT_MAX_FACES) break;
    if (!isRecord(candidate)) continue;
    const { family, style, weight, stretch, unicodeRange, data } = candidate;
    if (
      !isDescriptorSafe(family) ||
      family.trim().length === 0 ||
      !isDescriptorSafe(style) ||
      !isDescriptorSafe(weight) ||
      !isDescriptorSafe(stretch) ||
      !isUnicodeRangeSafe(unicodeRange) ||
      !isArrayBuffer(data) ||
      data.byteLength === 0 ||
      data.byteLength > AGENT_VISUAL_FONT_MAX_BYTES
    )
      continue;
    faces.push({ family, style, weight, stretch, unicodeRange, data });
  }
  return faces;
}

/** Identifies one face, so a frame registers it once. */
export function agentVisualFontFaceKey(
  face: AgentVisualFontDescriptors,
): string {
  return DESCRIPTOR_KEYS.map((key) => face[key]).join('|');
}

export function buildAgentVisualFontsMessage(
  faces: readonly AgentVisualFontFace[],
): {
  jsonrpc: '2.0';
  method: typeof AGENT_VISUAL_FONTS_METHOD;
  params: { faces: AgentVisualFontFace[] };
} {
  return {
    jsonrpc: '2.0',
    method: AGENT_VISUAL_FONTS_METHOD,
    params: { faces: sanitizeAgentVisualFontFaces(faces) },
  };
}

/**
 * The frame-side twin of {@link sanitizeAgentVisualFontFaces}, as source. The
 * relay and the bridge both evaluate it, so neither trusts the other's check.
 * It expects an `isRecord` helper in scope.
 */
export const AGENT_VISUAL_FONT_FACES_SOURCE = `
  const FONT_LIMITS = ${JSON.stringify({
    faces: AGENT_VISUAL_FONT_MAX_FACES,
    bytes: AGENT_VISUAL_FONT_MAX_BYTES,
    text: AGENT_VISUAL_FONT_DESCRIPTOR_MAX_LENGTH,
    range: AGENT_VISUAL_FONT_UNICODE_RANGE_MAX_LENGTH,
  })};
  const FONT_RANGE = new RegExp(${JSON.stringify(UNICODE_RANGE_SOURCE)});
  const FONT_FORBIDDEN = ${JSON.stringify(AGENT_VISUAL_FONT_FORBIDDEN_CHARACTERS)};

  function fontText(value){
    if (typeof value !== 'string' || value.length > FONT_LIMITS.text) return false;
    for (let index = 0; index < FONT_FORBIDDEN.length; index += 1) {
      if (value.includes(FONT_FORBIDDEN[index])) return false;
    }
    return true;
  }

  function fontRange(value){
    return typeof value === 'string' && value.length <= FONT_LIMITS.range && FONT_RANGE.test(value);
  }

  function cleanFontFaces(value){
    const faces = [];
    if (!Array.isArray(value)) return faces;
    for (let index = 0; index < value.length && faces.length < FONT_LIMITS.faces; index += 1) {
      const face = value[index];
      if (!isRecord(face)) continue;
      if (!fontText(face.family) || face.family.trim().length === 0 || !fontText(face.style) || !fontText(face.weight) || !fontText(face.stretch) || !fontRange(face.unicodeRange)) continue;
      const data = face.data;
      if (Object.prototype.toString.call(data) !== '[object ArrayBuffer]' || data.byteLength === 0 || data.byteLength > FONT_LIMITS.bytes) continue;
      faces.push({family:face.family, style:face.style, weight:face.weight, stretch:face.stretch, unicodeRange:face.unicodeRange, data:data});
    }
    return faces;
  }
`;
