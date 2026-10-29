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

export function mermaidSourceIssue(source: string): string | null {
  if (!source.trim()) return 'Add diagram source to see a preview.';
  if (
    source.length > MAX_MERMAID_SOURCE_LENGTH ||
    source.split(/[;\r\n\u0085\u2028\u2029]/).length > 200
  ) {
    return 'This diagram is too large to preview. Its source is shown below.';
  }
  // Config/CSS, HTML, resources, interactive links, and nested math are not
  // part of this display-only dialect. Never pass document-controlled options
  // to Mermaid. Keep the original text untouched for source/copy/save.
  const canonical = canonicalizeMermaidEscapes(source);
  const prepared = prepareMermaidSource(source);
  if (prepared.length > MAX_MERMAID_SOURCE_LENGTH) {
    return 'This diagram is too large to preview. Its source is shown below.';
  }
  const usesUnavailableDirective = (value: string): boolean =>
    /(?:^|[;\r\n\u0085\u2028\u2029])\s*(?:click|links?|details|style|classDef|cssClass|linkStyle|todayMarker)\b/i.test(
      value,
    );
  if (
    /%%\s*\{|^\s*---|@\s*\{|["']?\b(?:img|icon|links?)\b["']?\s*:|\$\$/i.test(
      canonical,
    ) ||
    /<\s*[a-z/!?]/i.test(
      prepared === source ? canonical : canonicalizeMermaidEscapes(prepared),
    ) ||
    usesUnavailableDirective(source) ||
    usesUnavailableDirective(canonical) ||
    hasMermaidExternalCssResource(canonical)
  ) {
    return 'This diagram uses features unavailable in preview. Its source is shown below.';
  }
  const declaration = source.replace(/^\s*%%[^\n]*(?:\n|$)/gm, '').trimStart();
  if (
    !/^(?:flowchart|graph|sequenceDiagram|classDiagram|stateDiagram(?:-v2)?|erDiagram|gantt)\b/.test(
      declaration,
    )
  ) {
    return 'Diagram could not be rendered. Its source is shown below.';
  }
  if (
    /^sequenceDiagram\b/.test(declaration) &&
    [source, canonical].some((value) =>
      /(?:^|[;\r\n\u0085\u2028\u2029])\s*(?:rect|box)\b/i.test(value),
    )
  ) {
    return 'This diagram uses features unavailable in preview. Its source is shown below.';
  }
  return null;
}
