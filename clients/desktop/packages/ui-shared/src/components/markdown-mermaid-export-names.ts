/**
 * Accessible names and file names for exported Mermaid diagrams. Kept free of
 * rasterization code so ordinary Markdown never loads the export helper.
 */

/** Marks the element that bounds heading lookup and diagram numbering. */
export const MARKDOWN_ROOT_ATTRIBUTE = 'data-markdown-root';

/** Spread onto the element that owns one Markdown document or message. */
export const MARKDOWN_ROOT_PROPS: Readonly<Record<string, string>> = {
  [MARKDOWN_ROOT_ATTRIBUTE]: '',
};

const DIAGRAM_SELECTOR = '[data-testid="markdown-mermaid"]';
const HEADING_SELECTOR = 'h1, h2, h3, h4, h5, h6';

const FAMILY_LABELS: ReadonlyArray<readonly [RegExp, string]> = [
  [/^(flowchart|graph)\b/i, 'Flow diagram'],
  [/^sequenceDiagram\b/i, 'Sequence diagram'],
  [/^classDiagram(-v2)?\b/i, 'Class diagram'],
  [/^stateDiagram(-v2)?\b/i, 'State diagram'],
  [/^erDiagram\b/i, 'Entity relationship diagram'],
  [/^gantt\b/i, 'Gantt chart'],
];

/**
 * The diagram family's label from its first declaration line, skipping
 * frontmatter, `%%` comments and `%%{init}%%` directives.
 */
export function mermaidFamilyLabel(source: string): string {
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  let index = 0;
  while (index < lines.length && lines[index].trim() === '') index += 1;
  if (lines[index]?.trim() === '---') {
    const end = lines.findIndex(
      (line, position) => position > index && line.trim() === '---',
    );
    if (end === -1) return 'Diagram';
    index = end + 1;
  }
  for (; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (line.startsWith('%%{') && !line.includes('}%%')) {
      while (index < lines.length && !lines[index].includes('}%%')) index += 1;
      continue;
    }
    if (line === '' || line.startsWith('%%')) continue;
    return (
      FAMILY_LABELS.find(([pattern]) => pattern.test(line))?.[1] ?? 'Diagram'
    );
  }
  return 'Diagram';
}

export interface MermaidDiagramContext {
  /** Nearest preceding heading inside the same Markdown root. */
  readonly heading: string | null;
  /** One-based position among the diagrams in the same Markdown root. */
  readonly index: number;
}

/**
 * Heading and position of a diagram within its explicit Markdown root. A
 * diagram outside a marked root has no heading and is numbered 1, so it never
 * borrows a heading from another message or preview.
 */
export function mermaidDiagramContext(element: Element): MermaidDiagramContext {
  const root = element.closest(`[${MARKDOWN_ROOT_ATTRIBUTE}]`);
  if (!root) return { heading: null, index: 1 };
  const diagrams = Array.from(root.querySelectorAll(DIAGRAM_SELECTOR)).filter(
    (diagram) => diagram.closest(`[${MARKDOWN_ROOT_ATTRIBUTE}]`) === root,
  );
  const index = Math.max(1, diagrams.indexOf(element) + 1);
  let heading: string | null = null;
  for (const candidate of Array.from(root.querySelectorAll(HEADING_SELECTOR))) {
    if (candidate.closest(`[${MARKDOWN_ROOT_ATTRIBUTE}]`) !== root) continue;
    if (
      !(
        candidate.compareDocumentPosition(element) &
        Node.DOCUMENT_POSITION_FOLLOWING
      )
    ) {
      break;
    }
    const text = candidate.textContent?.replace(/\s+/g, ' ').trim();
    if (text) heading = text;
  }
  return { heading, index };
}

/** `accTitle` wins; otherwise `<family>: <heading>`, or the family alone. */
export function mermaidAccessibleName(
  authoredTitle: string | undefined,
  family: string,
  heading: string | null,
): string {
  if (authoredTitle) return authoredTitle;
  return heading ? `${family}: ${heading}` : family;
}

const MAX_SLUG_LENGTH = 60;
const MAX_DOCUMENT_STEM_LENGTH = 80;
const RESERVED_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;

function boundUtf8(text: string, maxBytes: number): string {
  let result = '';
  let bytes = 0;
  for (const character of text) {
    const point = character.codePointAt(0) ?? 0;
    bytes += point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4;
    if (bytes > maxBytes) break;
    result += character;
  }
  return result;
}
export const MAX_DIAGRAM_NAME_ATTEMPTS = 20;

function slugify(text: string, maxLength: number): string {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxLength)
    .replace(/-+$/g, '');
}

/** A document's name without its extension, safe on every platform. */
function documentStem(documentName: string): string {
  const base = documentName.split(/[\\/]/).pop() ?? '';
  const withoutExtension = base.replace(/\.[^.]*$/, '') || base;
  return withoutExtension
    .replace(/[<>:"/\\|?*\p{Cc}]+/gu, '-')
    .replace(/^[\s.-]+|[\s.]+$/g, '')
    .slice(0, MAX_DOCUMENT_STEM_LENGTH)
    .replace(/[\s.]+$/g, '');
}

/**
 * The file name stem: `<document>-<heading slug>`, or `diagram-<n>` in place
 * of an empty heading slug. Downloads without a document drop the prefix.
 */
export function mermaidExportStem({
  documentName,
  heading,
  index,
}: {
  readonly documentName?: string;
  readonly heading: string | null;
  readonly index: number;
}): string {
  const slug =
    (heading ? slugify(heading, MAX_SLUG_LENGTH) : '') || `diagram-${index}`;
  const document = documentName ? documentStem(documentName) : '';
  const stem = document ? `${document}-${slug}` : slug;
  const safe = RESERVED_NAMES.test(stem)
    ? stem.includes('.')
      ? `diagram-${stem}`
      : `${stem}-diagram`
    : stem;
  return boundUtf8(safe, 240).replace(/[ .-]+$/g, '');
}

/** The base name followed by `-2` through `-20`: twenty attempts in total. */
export function mermaidExportFilenames(
  stem: string,
  extension: 'png' | 'svg',
): string[] {
  return Array.from({ length: MAX_DIAGRAM_NAME_ATTEMPTS }, (_, attempt) =>
    attempt === 0
      ? `${stem}.${extension}`
      : `${stem}-${attempt + 1}.${extension}`,
  );
}
