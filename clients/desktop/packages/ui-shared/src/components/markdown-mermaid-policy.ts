/** Conservative admission limits for DOM-based layout on the renderer thread. */
export const MAX_MERMAID_SOURCE_LENGTH = 8_000;
export const MAX_MERMAID_BLOCKS = 20;

/** A render-only copy; authored Markdown remains authoritative. */
export function prepareMermaidSource(source: string): string {
  if (
    !source.includes('<') ||
    !/^sequenceDiagram\b/.test(
      source.replace(/^\s*%%[^\n]*(?:\n|$)/gm, '').trimStart(),
    )
  ) {
    return source;
  }
  // Only ordinary, single-statement messages with simple actor identifiers.
  // Leave other grammar and HTML (attributes, closing tags, etc.) to admission.
  // Mermaid's entity codes stay inert through layout and decode in the SVG.
  return source.replace(
    /^([ \t]*[A-Za-z_][\w-]*[ \t]*-{1,2}>{1,2}[+-]?[ \t]*[A-Za-z_][\w-]*[ \t]*:)([^;\r\n\u0085\u2028\u2029]*)$/gm,
    (_message, prefix: string, label: string): string =>
      prefix + label.replace(/<([A-Za-z_][\w-]*)>/g, '#60;$1#62;'),
  );
}

function escapedCodePoint(hex: string): string {
  const value = Number.parseInt(hex, 16);
  return value === 0 || value > 0x10ffff
    ? '\ufffd'
    : String.fromCodePoint(value);
}

/** Normalize escape spellings before checking resource-bearing grammar. */
export function canonicalizeMermaidEscapes(value: string): string {
  let canonical = value;
  // A small fixed point also catches an escaped backslash followed by an
  // encoded token without turning this into a general-purpose parser.
  for (let pass = 0; pass < 4; pass += 1) {
    const next = canonical
      .replace(/\\U([0-9a-f]{8})/gi, (_match, hex: string) =>
        escapedCodePoint(hex),
      )
      .replace(/\\u([0-9a-f]{4})/gi, (_match, hex: string) =>
        escapedCodePoint(hex),
      )
      .replace(/\\x([0-9a-f]{2})/gi, (_match, hex: string) =>
        escapedCodePoint(hex),
      )
      .replace(
        /\\([0-9a-f]{1,6})([ \t\r\n\f])?|\\([^\r\n\f])/gi,
        (
          _match,
          hex: string | undefined,
          whitespace: string | undefined,
          escaped: string | undefined,
        ) =>
          hex
            ? escapedCodePoint(hex) +
              (whitespace && /[\r\n\f]/.test(whitespace) ? whitespace : '')
            : (escaped ?? ''),
      );
    if (next === canonical) break;
    canonical = next;
  }
  return canonical;
}

/** Detect CSS constructs that may resolve a document-controlled resource. */
export function hasMermaidExternalCssResource(value: string): boolean {
  const canonical = canonicalizeMermaidEscapes(value);
  if (
    /@import/i.test(canonical) ||
    /(?:^|[^\w-])(?:(?:-webkit-)?(?:image-set|cross-fade)|element|image)\s*\(/i.test(
      canonical,
    )
  ) {
    return true;
  }
  return Array.from(canonical.matchAll(/url\s*\(([^)]*)\)/gi)).some(
    (match) =>
      !match[1]
        .trim()
        .replace(/^['"]|['"]$/g, '')
        .startsWith('#'),
  );
}

const EMPTY_ISSUE = 'Add diagram code to see it drawn.';
const SIZE_ISSUE = 'This diagram is too large to draw here.';
const UNSUPPORTED_ISSUE =
  "This diagram uses features that can't be drawn here.";
/** Shown for an unknown diagram family and for a Mermaid render failure. */
export const MERMAID_RENDER_FAILURE = "This diagram couldn't be drawn.";
export const MERMAID_DROPPED_STYLING_NOTE =
  "Some highlighting couldn't be shown here.";

/**
 * How a settled Mermaid block may be drawn. The authored source remains the
 * authority for display and copying; `prepared` is render input only and is
 * empty whenever `issue` is set.
 */
export interface MermaidRenderPlan {
  readonly issue: string | null;
  readonly prepared: string;
  readonly droppedStyling: boolean;
}

const UNAVAILABLE_DIRECTIVE =
  /(?:^|[;\r\n\u0085\u2028\u2029])\s*(?:click|links?|details|cssClass|todayMarker)\b/i;
const UNICODE_SEPARATOR = /[\u0085\u2028\u2029]/;
const STYLING_WORD = /classDef|style|linkStyle/i;
const STYLING_KEYWORD = /^\s*(?:classDef|style|linkStyle)\b/i;
const STYLING_IN_LINE = /(?:^|;)\s*(?:classDef|style|linkStyle)\b/i;

/** Config/CSS, HTML, resources, interactive links, and nested math. */
function usesRefusedFeature(source: string): boolean {
  const canonical = canonicalizeMermaidEscapes(source);
  const prepared = prepareMermaidSource(source);
  return (
    /%%\s*\{|^\s*---|@\s*\{|["']?\b(?:img|icon|links?)\b["']?\s*:|\$\$/i.test(
      canonical,
    ) ||
    /<\s*[a-z/!?]/i.test(
      prepared === source ? canonical : canonicalizeMermaidEscapes(prepared),
    ) ||
    UNAVAILABLE_DIRECTIVE.test(source) ||
    UNAVAILABLE_DIRECTIVE.test(canonical) ||
    hasMermaidExternalCssResource(canonical)
  );
}

const NAMED_COLORS = new Set(
  (
    'aliceblue antiquewhite aqua aquamarine azure beige bisque black ' +
    'blanchedalmond blue blueviolet brown burlywood cadetblue chartreuse ' +
    'chocolate coral cornflowerblue cornsilk crimson cyan darkblue darkcyan ' +
    'darkgoldenrod darkgray darkgreen darkgrey darkkhaki darkmagenta ' +
    'darkolivegreen darkorange darkorchid darkred darksalmon darkseagreen ' +
    'darkslateblue darkslategray darkslategrey darkturquoise darkviolet ' +
    'deeppink deepskyblue dimgray dimgrey dodgerblue firebrick floralwhite ' +
    'forestgreen fuchsia gainsboro ghostwhite gold goldenrod gray green ' +
    'greenyellow grey honeydew hotpink indianred indigo ivory khaki lavender ' +
    'lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan ' +
    'lightgoldenrodyellow lightgray lightgreen lightgrey lightpink ' +
    'lightsalmon lightseagreen lightskyblue lightslategray lightslategrey ' +
    'lightsteelblue lightyellow lime limegreen linen magenta maroon ' +
    'mediumaquamarine mediumblue mediumorchid mediumpurple mediumseagreen ' +
    'mediumslateblue mediumspringgreen mediumturquoise mediumvioletred ' +
    'midnightblue mintcream mistyrose moccasin navajowhite navy oldlace olive ' +
    'olivedrab orange orangered orchid palegoldenrod palegreen ' +
    'paleturquoise palevioletred papayawhip peachpuff peru pink plum ' +
    'powderblue purple rebeccapurple red rosybrown royalblue saddlebrown ' +
    'salmon sandybrown seagreen seashell sienna silver skyblue slateblue ' +
    'slategray slategrey snow springgreen steelblue tan teal thistle tomato ' +
    'turquoise violet wheat white whitesmoke yellow yellowgreen ' +
    'none transparent currentcolor'
  ).split(' '),
);

/** A finite, nonnegative decimal within `max`, optionally followed by `unit`. */
function isNumber(value: string, max: number, unit = ''): boolean {
  if (!value.toLowerCase().endsWith(unit)) return false;
  const digits = value.slice(0, value.length - unit.length);
  return (
    digits.length <= 12 &&
    /^(?:\d+(?:\.\d+)?|\.\d+)$/.test(digits) &&
    Number(digits) <= max
  );
}

const isChannel = (value: string): boolean =>
  isNumber(value, 100, '%') || isNumber(value, 255);
const isAlpha = (value: string): boolean =>
  isNumber(value, 100, '%') || isNumber(value, 1);

/**
 * `rgb()`/`rgba()` with legacy comma channels and optional comma alpha, or
 * space channels and optional slash alpha. Separators never mix.
 */
function isRgb(value: string): boolean {
  const inner = /^rgba?\(([^()]*)\)$/i.exec(value)?.[1].trim();
  if (inner === undefined) return false;
  if (inner.includes(',')) {
    const parts = inner.split(',').map((part) => part.trim());
    const channels = parts.slice(0, 3);
    return (
      !inner.includes('/') &&
      (parts.length === 3 || parts.length === 4) &&
      // Legacy syntax keeps all three channels in one unit.
      new Set(channels.map((channel) => channel.endsWith('%'))).size === 1 &&
      channels.every(isChannel) &&
      (parts.length === 3 || isAlpha(parts[3]))
    );
  }
  const [main, alpha, ...extra] = inner.split('/');
  const channels = main.trim().split(/[ \t]+/);
  return (
    extra.length === 0 &&
    channels.length === 3 &&
    channels.every(isChannel) &&
    (alpha === undefined || isAlpha(alpha.trim()))
  );
}

function isColor(value: string): boolean {
  return (
    /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(value) ||
    NAMED_COLORS.has(value.toLowerCase()) ||
    isRgb(value)
  );
}

const DECLARATION = /^[ \t]*([A-Za-z-]+)[ \t]*:[ \t]*(.*?)[ \t]*$/;

const isDashLength = (value: string): boolean => isNumber(value, 10_000);
const isDashPattern = (value: string): boolean =>
  value.split(/[ \t]+/).every(isDashLength);

/** The resource-free styling Mermaid diagrams may carry into rendering. */
function isAllowedDeclaration(declaration: string): boolean {
  const match = DECLARATION.exec(declaration);
  if (!match) return false;
  const [, property, value] = match;
  switch (property.toLowerCase()) {
    case 'fill':
    case 'stroke':
    case 'color':
      return isColor(value);
    case 'stroke-width':
      return isNumber(value, 10_000, 'px') || isNumber(value, 10_000);
    case 'stroke-dasharray':
      return value.toLowerCase() === 'none' || isDashPattern(value);
    case 'font-weight':
      return /^(?:normal|bold|bolder|lighter|[1-9]00)$/i.test(value);
    default:
      return false;
  }
}

/** Split at top-level commas; `null` when parentheses do not balance. */
function splitDeclarations(text: string): string[] | null {
  const declarations: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === '(') depth += 1;
    else if (character === ')') {
      depth -= 1;
      if (depth < 0) return null;
    } else if (character === ',' && depth === 0) {
      declarations.push(text.slice(start, index));
      start = index + 1;
    }
  }
  if (depth !== 0) return null;
  declarations.push(text.slice(start));
  return declarations;
}

/**
 * Respell a valid numeric dash pattern split at commas (`stroke-dasharray:5,5`)
 * with spaces. Merging stops at the first fragment that is not a dash length,
 * which the filter then removes together with the pattern it follows.
 */
function joinDashPatterns(declarations: readonly string[]): string[] {
  const joined: string[] = [];
  for (let index = 0; index < declarations.length; index += 1) {
    let declaration = declarations[index];
    const match = DECLARATION.exec(declaration);
    if (
      match &&
      match[1].toLowerCase() === 'stroke-dasharray' &&
      isDashPattern(match[2])
    ) {
      while (index + 1 < declarations.length) {
        // A property, blank or non-length fragment ends the pattern.
        const next = declarations[index + 1].trim();
        if (!isDashLength(next)) break;
        declaration = `${declaration.replace(/[ \t]+$/, '')} ${next}`;
        index += 1;
      }
    }
    joined.push(declaration);
  }
  return joined;
}

const STYLING_TARGET: Readonly<Record<string, RegExp>> = {
  classdef: /^[A-Za-z_][\w-]*(?:,[A-Za-z_][\w-]*)*$/,
  style: /^[A-Za-z0-9_][\w-]*$/,
  linkstyle: /^(?:default|\d{1,4}(?:,\d{1,4})*)$/,
};

interface FilteredText {
  readonly text: string;
  readonly dropped: boolean;
}

/**
 * One styling statement, which Mermaid reads to the end of its line. Returns
 * `null` when its boundary or spelling is ambiguous, so the diagram is refused.
 */
function filterStylingStatement(statement: string): FilteredText | null {
  const terminator = /[ \t]*(?:;[ \t]*)?$/.exec(statement)?.[0] ?? '';
  const body = statement.slice(0, statement.length - terminator.length);
  // Quotes, brackets, escapes, comments, and further statements change how
  // each family's lexer bounds the declarations; never guess.
  if (/["'`[\]{}\;]|%%/.test(body)) return null;
  const match =
    /^([ \t]*)([A-Za-z]+)(?:([ \t]+)([^ \t]+)(?:([ \t]+)(.*))?)?$/.exec(body);
  if (!match) return null;
  const [, indent, keyword, beforeTarget, target, beforeStyles, styles] = match;
  const targetPattern = STYLING_TARGET[keyword.toLowerCase()];
  if (!targetPattern) return null;
  const fragments =
    target !== undefined && styles && targetPattern.test(target)
      ? splitDeclarations(styles)
      : null;
  const declarations = fragments && joinDashPatterns(fragments);
  // A fragment without a property continues the previous value (for example
  // `stroke-width:2,5`), so neither half is kept.
  const kept =
    declarations?.filter((declaration, index) => {
      const next = declarations[index + 1];
      return (
        isAllowedDeclaration(declaration) &&
        (next === undefined || next.includes(':') || !next.trim())
      );
    }) ?? [];
  const dropped = !declarations || kept.length !== declarations.length;
  if (!dropped && kept.length === fragments?.length) {
    return { text: statement, dropped: false };
  }
  if (kept.length === 0) return { text: '', dropped: true };
  return {
    text: `${indent}${keyword}${beforeTarget}${target}${beforeStyles}${kept.join(',')}${terminator}`,
    dropped,
  };
}

/** Label syntax that hides semicolons from a family's statement lexer. */
interface LabelSyntax {
  /** Double-quoted labels (not sequence messages or Gantt tasks). */
  readonly quoted: boolean;
  /** Flowchart `|edge label|` text; class arrows such as `<|--` also use pipes. */
  readonly piped: boolean;
  /** Multiline state notes contain literal text through `end note`. */
  readonly stateDiagram: boolean;
}

const FLOW_LINK = /^(?:--+[-xo>]|==+[=xo>]|-?\.+-[xo>]?|~~~+)/;
const FLOW_LINK_END: Readonly<Record<string, RegExp>> = {
  '--': /^--+[-xo>]/,
  '==': /^==+[=xo>]/,
  '-.': /^-?\.+-[xo>]?/,
};

interface LabelState {
  quoted: boolean;
  accessibilityDescription: boolean;
  stateNote: boolean;
  piped: boolean;
  depth: number;
  edgeEnd: RegExp | null;
}

/**
 * Locate the line's styling statement, if any. A statement begins at the line
 * start or after a top-level semicolon; label and shape text are not statements.
 */
function filterStylingLine(
  line: string,
  labels: LabelSyntax,
  state: LabelState,
): FilteredText | null {
  // Only flowchart shape/edge delimiters carry label context across lines.
  if (!labels.piped) {
    state.piped = false;
    state.depth = 0;
    state.edgeEnd = null;
  }
  // Mermaid strips full-line comments before every family's lexer runs.
  if (/^\s*%%/.test(line)) return { text: line, dropped: false };
  if (state.stateNote) {
    if (/^\s*end note\b/i.test(line)) {
      if (!/^\s*end note\s*$/i.test(line)) return null;
      state.stateNote = false;
    }
    return { text: line, dropped: false };
  }
  if (state.accessibilityDescription) {
    // Mermaid's accessibility block is literal text, including quotes and
    // directive-looking lines. Only its closing brace ends that lexer mode.
    const end = line.indexOf('}');
    if (end >= 0 && line.slice(end + 1).trim()) return null;
    state.accessibilityDescription = end < 0;
    return { text: line, dropped: false };
  }
  if (
    !state.quoted &&
    state.depth === 0 &&
    !state.piped &&
    !state.edgeEnd &&
    (line.includes('"') || (labels.piped && /[[({|>]/.test(line))) &&
    ((labels.stateDiagram &&
      /direction\s+(?:TB|BT|RL|LR)|\[\[(?:fork|join|choice)\]\]/i.test(line)) ||
      (labels.piped && /direction\s+(?:TB|BT|RL|LR|TD)/.test(line)))
  ) {
    // Family lexers consume these markers and trailing text before label grammar.
    return null;
  }
  let start = 0;
  for (let index = 0; index <= line.length; index += 1) {
    if (
      index === start &&
      !state.quoted &&
      !state.piped &&
      !state.edgeEnd &&
      state.depth === 0
    ) {
      const candidate = line.slice(start);
      if (
        labels.stateDiagram &&
        /^\s*note\s+(?:left|right)\s+of\b/i.test(candidate) &&
        !candidate.includes(':')
      ) {
        if (!/^\s*note\s+(?:left|right)\s+of\s+[\w-]+\s*$/i.test(candidate))
          return null;
        state.stateNote = true;
        return { text: line, dropped: false };
      }
      const descriptionStart = /^\s*accDescr\s*\{/i.exec(candidate);
      if (descriptionStart) {
        const end = candidate.indexOf('}', descriptionStart[0].length);
        if (end >= 0 && candidate.slice(end + 1).trim()) return null;
        state.accessibilityDescription = end < 0;
        return { text: line, dropped: false };
      }
      if (/^\s*acc(?:Title|Descr)\s*:/i.test(candidate)) {
        return { text: line, dropped: false };
      }
      // A block opening split across statements cannot be bounded here.
      if (/^\s*accDescr\b/i.test(candidate)) return null;
      const canonical = canonicalizeMermaidEscapes(candidate);
      if (canonical !== candidate && STYLING_KEYWORD.test(canonical))
        return null;
      if (STYLING_KEYWORD.test(candidate)) {
        const statement = filterStylingStatement(candidate);
        return (
          statement && {
            text: line.slice(0, start) + statement.text,
            dropped: statement.dropped,
          }
        );
      }
    }
    const character = line[index];
    if (!labels.quoted) {
      if (character === ';') start = index + 1;
      continue;
    }
    if (character === '"') {
      // Metadata and unquoted descriptions consume literal text to EOL.
      // A quote there must not turn subsequent statements into label text.
      const prefix = line.slice(0, index);
      if (
        !state.quoted &&
        (/^\s*acc(?:Title|Descr)\s*:/i.test(prefix) ||
          (!labels.piped && prefix.includes(':')))
      ) {
        continue;
      }
      if (
        !state.quoted &&
        !line.includes('"', index + 1) &&
        !(labels.piped && (state.depth > 0 || state.piped || state.edgeEnd)) &&
        !(labels.stateDiagram && /^[ \t]*state[ \t]+$/i.test(prefix))
      ) {
        // Do not carry an unknown quote context across statement boundaries.
        return null;
      }
      state.quoted = !state.quoted;
    }
    if (state.quoted) continue;
    if (
      character === '%' &&
      line[index + 1] === '%' &&
      state.depth === 0 &&
      !state.piped &&
      !state.edgeEnd
    ) {
      // A trailing comment: Mermaid's handling varies, so refuse styling in it.
      return STYLING_IN_LINE.test(line.slice(index + 2))
        ? null
        : { text: line, dropped: false };
    }
    if (state.edgeEnd) {
      const end = '-=.'.includes(character)
        ? state.edgeEnd.exec(line.slice(index))
        : null;
      if (end) {
        state.edgeEnd = null;
        index += end[0].length - 1;
      }
      continue;
    }
    if (
      labels.piped &&
      !state.piped &&
      state.depth === 0 &&
      '-=.~'.includes(character)
    ) {
      const remaining = line.slice(index);
      const link = FLOW_LINK.exec(remaining);
      if (link) {
        index += link[0].length - 1;
        continue;
      }
      const opener = /^(?:--|==|-\.)/.exec(remaining);
      if (opener) {
        state.edgeEnd = FLOW_LINK_END[opener[0]] ?? null;
        index += opener[0].length - 1;
        continue;
      }
    }
    if (
      labels.piped &&
      !state.piped &&
      state.depth === 0 &&
      character === '>'
    ) {
      const prefix = line.slice(start, index).trim();
      if (prefix && !/^(?:flowchart(?:-elk)?|graph)$/.test(prefix))
        state.depth += 1;
    }
    if (labels.piped && character === '|' && state.depth === 0)
      state.piped = !state.piped;
    else if (!state.piped && '[({'.includes(character)) state.depth += 1;
    else if (!state.piped && '])}'.includes(character))
      state.depth = Math.max(0, state.depth - 1);
    else if (character === ';') {
      if (state.depth === 0 && !state.piped) start = index + 1;
      // Shape and edge-label text is not a statement, but never guess.
      else if (STYLING_KEYWORD.test(line.slice(index + 1))) return null;
    }
  }
  return { text: line, dropped: false };
}

/**
 * Drop unsupported resource-free styling and respell comma dash patterns;
 * `null` refuses the diagram.
 */
function filterMermaidStyling(
  source: string,
  labels: LabelSyntax,
): FilteredText | null {
  const parts = source.split(/(\r\n|\r|\n)/);
  // Mermaid quoted labels may span lines. Their text must not be interpreted
  // as styling just because a line starts with a directive keyword.
  const state: LabelState = {
    quoted: false,
    accessibilityDescription: false,
    stateNote: false,
    piped: false,
    depth: 0,
    edgeEnd: null,
  };
  let dropped = false;
  let changed = false;
  for (let index = 0; index < parts.length; index += 2) {
    const line = filterStylingLine(parts[index], labels, state);
    if (!line) return null;
    changed ||= line.text !== parts[index];
    parts[index] = line.text;
    dropped ||= line.dropped;
  }
  return state.edgeEnd
    ? null
    : { text: changed ? parts.join('') : source, dropped };
}

export function planMermaidRender(source: string): MermaidRenderPlan {
  const refuse = (issue: string): MermaidRenderPlan => ({
    issue,
    prepared: '',
    droppedStyling: false,
  });
  if (!source.trim()) return refuse(EMPTY_ISSUE);
  if (
    source.length > MAX_MERMAID_SOURCE_LENGTH ||
    source.split(/[;\r\n\u0085\u2028\u2029]/).length > 200 ||
    prepareMermaidSource(source).length > MAX_MERMAID_SOURCE_LENGTH
  ) {
    return refuse(SIZE_ISSUE);
  }
  // Never pass document-controlled options to Mermaid, and refuse before
  // filtering so that removing styling cannot hide a forbidden construct.
  const canonical = canonicalizeMermaidEscapes(source);
  if (usesRefusedFeature(source)) return refuse(UNSUPPORTED_ISSUE);
  // Some lexers miss these line separators, so a styling directive beside one
  // cannot be bounded reliably. This also refuses some legitimate diagrams.
  if (
    [source, canonical].some(
      (value) => UNICODE_SEPARATOR.test(value) && STYLING_WORD.test(value),
    )
  ) {
    return refuse(UNSUPPORTED_ISSUE);
  }
  const declaration = source.replace(/^\s*%%[^\n]*(?:\n|$)/gm, '').trimStart();
  const family =
    /^(?:flowchart|graph|sequenceDiagram|classDiagram|stateDiagram(?:-v2)?|erDiagram|gantt)\b/.exec(
      declaration,
    )?.[0];
  if (!family) return refuse(MERMAID_RENDER_FAILURE);
  if (
    family === 'sequenceDiagram' &&
    [source, canonical].some((value) =>
      /(?:^|[;\r\n\u0085\u2028\u2029])\s*(?:rect|box)\b/i.test(value),
    )
  ) {
    return refuse(UNSUPPORTED_ISSUE);
  }
  // Sequence and Gantt text is not quote-delimited; every semicolon splits.
  const styled = filterMermaidStyling(source, {
    quoted: family !== 'sequenceDiagram' && family !== 'gantt',
    piped: family === 'flowchart' || family === 'graph',
    stateDiagram: family === 'stateDiagram' || family === 'stateDiagram-v2',
  });
  if (!styled || (styled.text !== source && usesRefusedFeature(styled.text))) {
    return refuse(UNSUPPORTED_ISSUE);
  }
  const prepared = prepareMermaidSource(styled.text);
  if (prepared.length > MAX_MERMAID_SOURCE_LENGTH) return refuse(SIZE_ISSUE);
  return { issue: null, prepared, droppedStyling: styled.dropped };
}

export function mermaidSourceIssue(source: string): string | null {
  return planMermaidRender(source).issue;
}
