import { assertOfficeArchive, type OfficeArchiveEntry } from './office-archive';
import { expandOfficeArchiveEntry } from './office-expansion';
import {
  attr,
  boolAttr,
  child,
  childElements,
  children,
  descendantText,
  EMPTY_THEME,
  intAttr,
  nameOf,
  parseXmlPart,
  path,
  readTheme,
  relAttr,
  resolveColor,
  type PptxThemeContext,
  type PptxXmlBudget,
} from './pptx-xml';

export const PPTX_PREVIEW_MAX_SLIDES = 300;
export const PPTX_PREVIEW_MAX_ELEMENTS_PER_SLIDE = 2_000;
export const PPTX_PREVIEW_MAX_IMAGE_BYTES = 16 * 1024 * 1024;
export const PPTX_PREVIEW_MAX_XML_PART_BYTES = 8 * 1024 * 1024;
export const PPTX_PREVIEW_MAX_OUTPUT_BYTES = 32 * 1024 * 1024;
export const PPTX_PREVIEW_MAX_NODES_PER_SLIDE = 5_000;
export const PPTX_PREVIEW_MAX_NODES = 20_000;
export const PPTX_PREVIEW_MAX_TEXT_BYTES = 8 * 1024 * 1024;
const MAX_GROUP_DEPTH = 16;
const MAX_NUMBERING_VALUE = 32_767;

/** 16:9 default used when `p:sldSz` is missing or implausible. */
const DEFAULT_SLIDE_WIDTH = 12_192_000;
const DEFAULT_SLIDE_HEIGHT = 6_858_000;
const MAX_SLIDE_EMU = 51_206_400;
const DEFAULT_FONT_SIZE_PT = 18;
const DEFAULT_TABLE_FONT_SIZE_PT = 18;
const DEFAULT_INSET_X = 91_440;
const DEFAULT_INSET_Y = 45_720;
const DEFAULT_LINE_WIDTH = 12_700;

const IMAGE_MEDIA_TYPES: ReadonlyMap<string, string> = new Map([
  ['png', 'image/png'],
  ['jpg', 'image/jpeg'],
  ['jpeg', 'image/jpeg'],
  ['gif', 'image/gif'],
  ['webp', 'image/webp'],
]);

export interface PptxTextRun {
  readonly text: string;
  readonly sizePt: number;
  readonly bold: boolean;
  readonly italic: boolean;
  readonly underline: boolean;
  readonly strike: boolean;
  readonly color?: string;
  readonly fontFamily?: string;
}

export type PptxTextAlign = 'left' | 'center' | 'right' | 'justify';

export interface PptxParagraph {
  readonly runs: readonly PptxTextRun[];
  readonly align: PptxTextAlign;
  /** Left margin in EMU. */
  readonly indent: number;
  readonly bullet?: string;
  readonly lineSpacing?: number;
  readonly spaceBeforePt: number;
  readonly spaceAfterPt: number;
  /** Font size used for the line height of an empty paragraph. */
  readonly emptySizePt: number;
}

export interface PptxTextBody {
  readonly paragraphs: readonly PptxParagraph[];
  readonly anchor: 'top' | 'middle' | 'bottom';
  /** Insets in EMU: left, top, right, bottom. */
  readonly insets: readonly [number, number, number, number];
  readonly wrap: boolean;
}

/** Position and size in EMU relative to the slide's top-left corner. */
export interface PptxBox {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly rotation: number;
}

export interface PptxStroke {
  readonly color: string;
  readonly width: number;
}

export interface PptxTableCell {
  readonly text?: PptxTextBody;
  readonly fill?: string;
  readonly colSpan: number;
  readonly rowSpan: number;
}

export type PptxElement =
  | {
      readonly kind: 'shape';
      readonly box: PptxBox;
      readonly geometry: 'rect' | 'roundRect' | 'ellipse';
      readonly fill?: string;
      readonly stroke?: PptxStroke;
      readonly text?: PptxTextBody;
    }
  | {
      readonly kind: 'image';
      readonly box: PptxBox;
      readonly alt: string;
      readonly src?: string;
    }
  | {
      readonly kind: 'line';
      readonly x1: number;
      readonly y1: number;
      readonly x2: number;
      readonly y2: number;
      readonly stroke: PptxStroke;
    }
  | {
      readonly kind: 'table';
      readonly box: PptxBox;
      readonly columnWidths: readonly number[];
      readonly rows: readonly {
        readonly height: number;
        readonly cells: readonly (PptxTableCell | null)[];
      }[];
    }
  | {
      readonly kind: 'unsupported';
      readonly box: PptxBox;
      readonly label: string;
    };

export interface PptxSlideModel {
  readonly number: number;
  readonly hidden: boolean;
  readonly background?: string;
  readonly backgroundImage?: string;
  readonly elements: readonly PptxElement[];
  readonly elementsTruncated: boolean;
  readonly notes: readonly string[];
}

export interface PptxParseResult {
  readonly kind: 'pptx';
  readonly slideWidth: number;
  readonly slideHeight: number;
  readonly slideCount: number;
  readonly slides: readonly PptxSlideModel[];
}

interface Relationship {
  readonly type: string;
  readonly target: string;
}

function relationshipType(type: string): string {
  return type.slice(type.lastIndexOf('/') + 1);
}

function directoryOf(partPath: string): string {
  return partPath.slice(0, partPath.lastIndexOf('/') + 1);
}

function resolvePartPath(base: string, target: string): string {
  const joined = target.startsWith('/')
    ? target.slice(1)
    : `${directoryOf(base)}${target}`;
  const segments: string[] = [];
  for (const segment of joined.split('/')) {
    if (segment === '..') segments.pop();
    else if (segment !== '.' && segment !== '') segments.push(segment);
  }
  return segments.join('/');
}

function relsPathFor(partPath: string): string {
  const slash = partPath.lastIndexOf('/');
  return `${partPath.slice(0, slash + 1)}_rels/${partPath.slice(slash + 1)}.rels`;
}

/** Lazily expanded, parsed parts of an admitted presentation package. */
class PresentationPackage {
  private readonly entries: Map<string, OfficeArchiveEntry>;
  private readonly xmlCache = new Map<string, Element | undefined>();
  private readonly relsCache = new Map<string, Map<string, Relationship>>();
  private imageBytes = 0;
  private readonly xmlBudget: PptxXmlBudget = { structureMarkers: 0 };

  constructor(entries: readonly OfficeArchiveEntry[]) {
    this.entries = new Map(entries.map((entry) => [entry.name, entry]));
  }

  xml(partPath: string | undefined): Element | undefined {
    if (partPath === undefined) return undefined;
    if (this.xmlCache.has(partPath)) return this.xmlCache.get(partPath);
    const entry = this.entries.get(partPath);
    if (entry && entry.expandedSize > PPTX_PREVIEW_MAX_XML_PART_BYTES) {
      throw new Error('Presentation part exceeds its preview budget.');
    }
    const root = entry
      ? parseXmlPart(expandOfficeArchiveEntry(entry), this.xmlBudget)
      : undefined;
    this.xmlCache.set(partPath, root);
    return root;
  }

  rels(partPath: string): Map<string, Relationship> {
    const cached = this.relsCache.get(partPath);
    if (cached) return cached;
    const result = new Map<string, Relationship>();
    for (const relationship of children(
      this.xml(relsPathFor(partPath)),
      'Relationship',
    )) {
      const id = attr(relationship, 'Id');
      const target = attr(relationship, 'Target');
      if (
        id === undefined ||
        target === undefined ||
        attr(relationship, 'TargetMode') === 'External'
      ) {
        continue;
      }
      result.set(id, {
        type: relationshipType(attr(relationship, 'Type') ?? ''),
        target: resolvePartPath(partPath, target),
      });
    }
    this.relsCache.set(partPath, result);
    return result;
  }

  related(partPath: string, type: string): string | undefined {
    for (const relationship of this.rels(partPath).values()) {
      if (relationship.type === type) return relationship.target;
    }
    return undefined;
  }

  /** Data URL for a supported raster image within the shared image budget. */
  imageDataUrl(partPath: string | undefined): string | undefined {
    if (partPath === undefined) return undefined;
    const extension = partPath
      .slice(partPath.lastIndexOf('.') + 1)
      .toLowerCase();
    const mediaType = IMAGE_MEDIA_TYPES.get(extension);
    const entry = this.entries.get(partPath);
    if (!mediaType || !entry || entry.expandedSize === 0) return undefined;
    if (this.imageBytes + entry.expandedSize > PPTX_PREVIEW_MAX_IMAGE_BYTES) {
      return undefined;
    }
    this.imageBytes += entry.expandedSize;
    return `data:${mediaType};base64,${base64(expandOfficeArchiveEntry(entry))}`;
  }
}

const BASE64_ALPHABET =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function base64(bytes: Uint8Array): string {
  const parts: string[] = [];
  let chunk = '';
  for (let index = 0; index < bytes.length; index += 3) {
    const a = bytes[index] ?? 0;
    const b = bytes[index + 1] ?? 0;
    const c = bytes[index + 2] ?? 0;
    const triple = (a << 16) | (b << 8) | c;
    chunk +=
      BASE64_ALPHABET.charAt((triple >> 18) & 63) +
      BASE64_ALPHABET.charAt((triple >> 12) & 63) +
      (index + 1 < bytes.length
        ? BASE64_ALPHABET.charAt((triple >> 6) & 63)
        : '=') +
      (index + 2 < bytes.length ? BASE64_ALPHABET.charAt(triple & 63) : '=');
    if (chunk.length >= 65_536) {
      parts.push(chunk);
      chunk = '';
    }
  }
  parts.push(chunk);
  return parts.join('');
}

/** Maps a group's child coordinate space into slide EMU. */
interface Transform {
  readonly offsetX: number;
  readonly offsetY: number;
  readonly scaleX: number;
  readonly scaleY: number;
}

const IDENTITY: Transform = { offsetX: 0, offsetY: 0, scaleX: 1, scaleY: 1 };

interface RawXfrm {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly rotation: number;
  readonly flipH: boolean;
  readonly flipV: boolean;
}

function readXfrm(xfrm: Element | undefined): RawXfrm | undefined {
  const offset = child(xfrm, 'off');
  const extent = child(xfrm, 'ext');
  const x = intAttr(offset, 'x');
  const y = intAttr(offset, 'y');
  const width = intAttr(extent, 'cx');
  const height = intAttr(extent, 'cy');
  if (
    x === undefined ||
    y === undefined ||
    width === undefined ||
    height === undefined
  ) {
    return undefined;
  }
  return {
    x,
    y,
    width: Math.max(0, width),
    height: Math.max(0, height),
    rotation: (intAttr(xfrm, 'rot') ?? 0) / 60_000,
    flipH: boolAttr(xfrm, 'flipH') === true,
    flipV: boolAttr(xfrm, 'flipV') === true,
  };
}

function applyTransform(raw: RawXfrm, transform: Transform): PptxBox {
  return {
    x: transform.offsetX + raw.x * transform.scaleX,
    y: transform.offsetY + raw.y * transform.scaleY,
    width: raw.width * transform.scaleX,
    height: raw.height * transform.scaleY,
    rotation: raw.rotation,
  };
}

function groupTransform(
  groupXfrm: Element | undefined,
  parent: Transform,
): Transform {
  const raw = readXfrm(groupXfrm);
  const childOffset = child(groupXfrm, 'chOff');
  const childExtent = child(groupXfrm, 'chExt');
  const childX = intAttr(childOffset, 'x') ?? raw?.x ?? 0;
  const childY = intAttr(childOffset, 'y') ?? raw?.y ?? 0;
  const childWidth = intAttr(childExtent, 'cx') ?? 0;
  const childHeight = intAttr(childExtent, 'cy') ?? 0;
  if (!raw) return parent;
  const scaleX = childWidth > 0 ? raw.width / childWidth : 1;
  const scaleY = childHeight > 0 ? raw.height / childHeight : 1;
  return {
    offsetX: parent.offsetX + parent.scaleX * (raw.x - childX * scaleX),
    offsetY: parent.offsetY + parent.scaleY * (raw.y - childY * scaleY),
    scaleX: parent.scaleX * scaleX,
    scaleY: parent.scaleY * scaleY,
  };
}

interface Placeholder {
  readonly type: string;
  readonly index?: number;
}

interface PlaceholderShape {
  readonly placeholder: Placeholder;
  readonly shape: Element;
}

/** Master/layout context shared by every slide that uses a layout. */
interface LayoutContext {
  readonly theme: PptxThemeContext;
  readonly layout?: Element;
  readonly layoutPath?: string;
  readonly master?: Element;
  readonly masterPath?: string;
  readonly layoutPlaceholders: readonly PlaceholderShape[];
  readonly masterPlaceholders: readonly PlaceholderShape[];
}

/** One part whose shapes are being walked, for relationship lookups. */
interface PartContext {
  readonly partPath: string;
  readonly isSlide: boolean;
}

function readPlaceholder(shape: Element): Placeholder | undefined {
  const placeholder =
    path(shape, 'nvSpPr', 'nvPr', 'ph') ??
    path(shape, 'nvPicPr', 'nvPr', 'ph') ??
    path(shape, 'nvGraphicFramePr', 'nvPr', 'ph');
  if (!placeholder) return undefined;
  return {
    type: attr(placeholder, 'type') ?? 'obj',
    index: intAttr(placeholder, 'idx'),
  };
}

function placeholderShapes(root: Element | undefined): PlaceholderShape[] {
  const result: PlaceholderShape[] = [];
  for (const shape of childElements(path(root, 'cSld', 'spTree'))) {
    const placeholder = readPlaceholder(shape);
    if (placeholder) result.push({ placeholder, shape });
  }
  return result;
}

function masterPlaceholderType(type: string): string {
  if (type === 'ctrTitle') return 'title';
  if (type === 'subTitle' || type === 'obj') return 'body';
  return type;
}

function findLayoutPlaceholder(
  placeholder: Placeholder,
  candidates: readonly PlaceholderShape[],
): Element | undefined {
  if (placeholder.index !== undefined) {
    const byIndex = candidates.find(
      (candidate) => candidate.placeholder.index === placeholder.index,
    );
    if (byIndex) return byIndex.shape;
  }
  return candidates.find(
    (candidate) => candidate.placeholder.type === placeholder.type,
  )?.shape;
}

function findMasterPlaceholder(
  placeholder: Placeholder,
  candidates: readonly PlaceholderShape[],
): Element | undefined {
  const type = masterPlaceholderType(placeholder.type);
  return candidates.find(
    (candidate) => masterPlaceholderType(candidate.placeholder.type) === type,
  )?.shape;
}

function placeholderTextStyle(
  type: string,
  master: Element | undefined,
): Element | undefined {
  const styles = child(master, 'txStyles');
  if (type === 'title' || type === 'ctrTitle')
    return child(styles, 'titleStyle');
  if (type === 'body' || type === 'subTitle' || type === 'obj')
    return child(styles, 'bodyStyle');
  return child(styles, 'otherStyle');
}

/** Ordered text-style sources for a shape, most specific first. */
interface TextStyleSources {
  readonly listStyles: readonly (Element | undefined)[];
  readonly layoutPlaceholder?: Element;
  readonly masterPlaceholder?: Element;
  readonly fontColor?: string;
}

function levelProperties(
  listStyle: Element | undefined,
  level: number,
): Element | undefined {
  return child(listStyle, `lvl${level + 1}pPr`);
}

function placeholderParagraphProperties(
  shape: Element | undefined,
  level: number,
): Element | undefined {
  return children(path(shape, 'txBody'), 'p')
    .map((paragraph) => child(paragraph, 'pPr'))
    .find(
      (properties) =>
        properties !== undefined && (intAttr(properties, 'lvl') ?? 0) === level,
    );
}

function firstAttr(
  candidates: readonly (Element | undefined)[],
  name: string,
): string | undefined {
  for (const candidate of candidates) {
    const value = attr(candidate, name);
    if (value !== undefined) return value;
  }
  return undefined;
}

function firstChild(
  candidates: readonly (Element | undefined)[],
  name: string,
): Element | undefined {
  for (const candidate of candidates) {
    const found = child(candidate, name);
    if (found) return found;
  }
  return undefined;
}

const ALIGNMENTS: ReadonlyMap<string, PptxTextAlign> = new Map([
  ['l', 'left'],
  ['ctr', 'center'],
  ['r', 'right'],
  ['just', 'justify'],
  ['dist', 'justify'],
]);

function romanNumeral(value: number): string {
  const numerals: readonly [number, string][] = [
    [1000, 'm'],
    [900, 'cm'],
    [500, 'd'],
    [400, 'cd'],
    [100, 'c'],
    [90, 'xc'],
    [50, 'l'],
    [40, 'xl'],
    [10, 'x'],
    [9, 'ix'],
    [5, 'v'],
    [4, 'iv'],
    [1, 'i'],
  ];
  let remaining = value;
  let result = '';
  for (const [amount, symbol] of numerals) {
    while (remaining >= amount) {
      result += symbol;
      remaining -= amount;
    }
  }
  return result;
}

function autoNumber(scheme: string, value: number): string {
  if (
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > MAX_NUMBERING_VALUE
  ) {
    throw new Error('Presentation numbering exceeds its preview budget.');
  }
  const alpha = String.fromCharCode(97 + ((value - 1) % 26));
  const base = scheme.startsWith('alphaLc')
    ? alpha
    : scheme.startsWith('alphaUc')
      ? alpha.toUpperCase()
      : scheme.startsWith('romanLc')
        ? romanNumeral(value)
        : scheme.startsWith('romanUc')
          ? romanNumeral(value).toUpperCase()
          : String(value);
  if (scheme.endsWith('ParenBoth')) return `(${base})`;
  if (scheme.endsWith('ParenR')) return `${base})`;
  if (scheme.endsWith('Plain')) return base;
  return `${base}.`;
}

function typeface(
  value: string | undefined,
  theme: PptxThemeContext,
): string | undefined {
  const resolved =
    value === '+mj-lt'
      ? theme.majorFont
      : value === '+mn-lt'
        ? theme.minorFont
        : value;
  if (resolved === undefined || resolved.startsWith('+')) return undefined;
  const safe = resolved.replace(/[^A-Za-z0-9 _-]/g, '').trim();
  return safe === '' ? undefined : safe;
}

function readTextBody(
  body: Element | undefined,
  sources: TextStyleSources,
  theme: PptxThemeContext,
  defaultSizePt: number,
  budget: SlideBudget,
  inheritedBodyProperties: readonly (Element | undefined)[] = [],
): PptxTextBody | undefined {
  if (!body) return undefined;
  budget.retain();
  const bodyProperties = [child(body, 'bodyPr'), ...inheritedBodyProperties];
  const autofit = firstChild(bodyProperties, 'normAutofit');
  const fontScale = (intAttr(autofit, 'fontScale') ?? 100_000) / 100_000;
  const spacingReduction = (intAttr(autofit, 'lnSpcReduction') ?? 0) / 100_000;
  const ownListStyle = child(body, 'lstStyle');
  const autoNumberCounters = new Map<number, number>();
  const paragraphs: PptxParagraph[] = [];
  for (const paragraph of children(body, 'p')) {
    budget.retain();
    const ownProperties = child(paragraph, 'pPr');
    const level = Math.max(0, Math.min(8, intAttr(ownProperties, 'lvl') ?? 0));
    const paragraphSources = [
      ownProperties,
      levelProperties(ownListStyle, level),
      placeholderParagraphProperties(sources.layoutPlaceholder, level),
      levelProperties(sources.listStyles[0], level),
      placeholderParagraphProperties(sources.masterPlaceholder, level),
      ...sources.listStyles
        .slice(1)
        .map((style) => levelProperties(style, level)),
    ];
    const runDefaults = paragraphSources.map((source) =>
      child(source, 'defRPr'),
    );
    const resolveSize = (runProperties: Element | undefined): number => {
      const size = firstAttr([runProperties, ...runDefaults], 'sz');
      return Math.max(
        1,
        (size !== undefined && /^\d+$/.test(size)
          ? Number(size) / 100
          : defaultSizePt) * fontScale,
      );
    };
    const resolveRun = (
      runProperties: Element | undefined,
      text: string,
    ): PptxTextRun => {
      const chain = [runProperties, ...runDefaults];
      const fill = chain
        .map((candidate) => child(candidate, 'solidFill'))
        .find((candidate) => candidate !== undefined);
      const underline = firstAttr(chain, 'u');
      const strike = firstAttr(chain, 'strike');
      return {
        text,
        sizePt: resolveSize(runProperties),
        bold: firstAttr(chain, 'b') === '1' || firstAttr(chain, 'b') === 'true',
        italic:
          firstAttr(chain, 'i') === '1' || firstAttr(chain, 'i') === 'true',
        underline: underline !== undefined && underline !== 'none',
        strike: strike !== undefined && strike !== 'noStrike',
        color: resolveColor(fill, theme) ?? sources.fontColor,
        fontFamily: typeface(
          attr(firstChild(chain, 'latin'), 'typeface'),
          theme,
        ),
      };
    };
    const runs: PptxTextRun[] = [];
    for (const part of childElements(paragraph)) {
      const kind = nameOf(part);
      if (kind === 'r' || kind === 'fld' || kind === 'br') {
        budget.retain();
        const run = resolveRun(
          child(part, 'rPr'),
          kind === 'br' ? '\n' : descendantText(part),
        );
        budget.text(run.text);
        budget.text(run.fontFamily);
        runs.push(run);
      }
    }
    // Empty paragraphs retain only their line-height size. Resolving an unused
    // font family here would repeatedly scan large inherited typeface strings.
    const emptySizePt = resolveSize(child(paragraph, 'endParaRPr'));
    const align =
      ALIGNMENTS.get(firstAttr(paragraphSources, 'algn') ?? 'l') ?? 'left';
    const hasText = runs.some((run) => run.text.trim() !== '');
    let bullet: string | undefined;
    const bulletSource = paragraphSources.find(
      (source) =>
        child(source, 'buNone') ??
        child(source, 'buChar') ??
        child(source, 'buAutoNum'),
    );
    const autoNumbering = child(bulletSource, 'buAutoNum');
    if (hasText && autoNumbering) {
      const start = intAttr(autoNumbering, 'startAt') ?? 1;
      const current = autoNumberCounters.get(level) ?? start;
      autoNumberCounters.set(level, current + 1);
      bullet = autoNumber(
        attr(autoNumbering, 'type') ?? 'arabicPeriod',
        current,
      );
    } else {
      autoNumberCounters.delete(level);
      const character = attr(child(bulletSource, 'buChar'), 'char');
      if (hasText && character !== undefined) bullet = character.slice(0, 2);
    }
    const lineSpacing = intAttr(
      firstChild(
        paragraphSources.map((source) => child(source, 'lnSpc')),
        'spcPct',
      ),
      'val',
    );
    const spacing = (name: string): number =>
      (intAttr(
        firstChild(
          paragraphSources.map((source) => child(source, name)),
          'spcPts',
        ),
        'val',
      ) ?? 0) / 100;
    paragraphs.push({
      runs,
      align,
      indent: Math.max(
        0,
        Number(firstAttr(paragraphSources, 'marL') ?? 0) || 0,
      ),
      bullet,
      lineSpacing:
        lineSpacing === undefined
          ? undefined
          : Math.max(0.5, lineSpacing / 100_000 - spacingReduction),
      spaceBeforePt: spacing('spcBef'),
      spaceAfterPt: spacing('spcAft'),
      emptySizePt,
    });
  }
  if (!paragraphs.some((paragraph) => paragraph.runs.length > 0)) {
    return undefined;
  }
  const anchorValue = firstAttr(bodyProperties, 'anchor');
  const inset = (name: string, fallback: number): number =>
    Math.max(0, Number(firstAttr(bodyProperties, name) ?? fallback) || 0);
  return {
    paragraphs,
    anchor:
      anchorValue === 'ctr' ? 'middle' : anchorValue === 'b' ? 'bottom' : 'top',
    insets: [
      inset('lIns', DEFAULT_INSET_X),
      inset('tIns', DEFAULT_INSET_Y),
      inset('rIns', DEFAULT_INSET_X),
      inset('bIns', DEFAULT_INSET_Y),
    ],
    wrap: firstAttr(bodyProperties, 'wrap') !== 'none',
  };
}

const FILL_ELEMENTS: ReadonlySet<string> = new Set([
  'noFill',
  'solidFill',
  'gradFill',
  'blipFill',
  'pattFill',
  'grpFill',
]);

/** Solid colour for a shape property list, `null` for an explicit no-fill. */
function readFill(
  properties: Element | undefined,
  theme: PptxThemeContext,
): string | null | undefined {
  const fill = childElements(properties).find((entry) =>
    FILL_ELEMENTS.has(nameOf(entry)),
  );
  if (!fill) return undefined;
  switch (nameOf(fill)) {
    case 'solidFill':
      return resolveColor(fill, theme) ?? null;
    case 'gradFill':
      return resolveColor(path(fill, 'gsLst', 'gs'), theme) ?? null;
    case 'pattFill':
      return resolveColor(child(fill, 'bgClr'), theme) ?? null;
    default:
      return null;
  }
}

function readStroke(
  properties: Element | undefined,
  style: Element | undefined,
  theme: PptxThemeContext,
): PptxStroke | undefined {
  const line = child(properties, 'ln');
  if (child(line, 'noFill')) return undefined;
  const width = intAttr(line, 'w');
  const explicit = resolveColor(child(line, 'solidFill'), theme);
  if (explicit !== undefined) {
    return { color: explicit, width: width ?? DEFAULT_LINE_WIDTH };
  }
  const reference = child(style, 'lnRef');
  if ((intAttr(reference, 'idx') ?? 0) > 0) {
    const color = resolveColor(reference, theme);
    if (color !== undefined) {
      return { color, width: width ?? DEFAULT_LINE_WIDTH };
    }
  }
  return undefined;
}

function geometryOf(
  properties: Element | undefined,
): 'rect' | 'roundRect' | 'ellipse' {
  const preset = attr(child(properties, 'prstGeom'), 'prst');
  if (preset === 'ellipse') return 'ellipse';
  if (preset === 'roundRect' || preset === 'flowChartAlternateProcess')
    return 'roundRect';
  return 'rect';
}

interface WalkState {
  readonly elements: PptxElement[];
  truncated: boolean;
}

interface PresentationBudget {
  nodes: number;
  textBytes: number;
}

/** Charge nested content before it is appended, including inherited copies. */
class SlideBudget {
  private nodes = 0;

  constructor(private readonly presentation: PresentationBudget) {}

  retain(count = 1): void {
    this.nodes += count;
    this.presentation.nodes += count;
    if (
      this.nodes > PPTX_PREVIEW_MAX_NODES_PER_SLIDE ||
      this.presentation.nodes > PPTX_PREVIEW_MAX_NODES
    ) {
      throw new Error('Presentation exceeds its preview node budget.');
    }
  }

  text(value: string | undefined): void {
    if (value === undefined) return;
    this.presentation.textBytes += encoder.encode(value).byteLength;
    if (this.presentation.textBytes > PPTX_PREVIEW_MAX_TEXT_BYTES) {
      throw new Error('Presentation preview text exceeds its budget.');
    }
  }
}

class SlideWalker {
  constructor(
    private readonly presentation: PresentationPackage,
    private readonly context: LayoutContext,
    private readonly defaultTextStyle: Element | undefined,
    private readonly state: WalkState,
    private readonly budget: SlideBudget,
  ) {}

  private push(element: PptxElement): boolean {
    if (this.state.elements.length >= PPTX_PREVIEW_MAX_ELEMENTS_PER_SLIDE) {
      this.state.truncated = true;
      return false;
    }
    this.budget.retain();
    this.state.elements.push(element);
    return true;
  }

  walk(
    tree: Element | undefined,
    part: PartContext,
    transform: Transform,
    depth = 0,
  ): void {
    if (depth > MAX_GROUP_DEPTH) return;
    for (const node of childElements(tree)) {
      if (this.state.truncated) return;
      switch (nameOf(node)) {
        case 'sp':
          this.shape(node, part, transform);
          break;
        case 'pic':
          this.picture(node, part, transform);
          break;
        case 'cxnSp':
          this.connector(node, transform);
          break;
        case 'graphicFrame':
          this.graphicFrame(node, transform);
          break;
        case 'grpSp':
          this.walk(
            node,
            part,
            groupTransform(path(node, 'grpSpPr', 'xfrm'), transform),
            depth + 1,
          );
          break;
        case 'AlternateContent':
          this.walk(child(node, 'Fallback'), part, transform, depth + 1);
          break;
        default:
          break;
      }
    }
  }

  private inherited(placeholder: Placeholder | undefined): {
    readonly layout?: Element;
    readonly master?: Element;
  } {
    if (!placeholder) return {};
    return {
      layout: findLayoutPlaceholder(
        placeholder,
        this.context.layoutPlaceholders,
      ),
      master: findMasterPlaceholder(
        placeholder,
        this.context.masterPlaceholders,
      ),
    };
  }

  private shape(node: Element, part: PartContext, transform: Transform): void {
    const placeholder = readPlaceholder(node);
    // Layout and master placeholders are authoring prompts, not content.
    if (placeholder && !part.isSlide) return;
    const { theme } = this.context;
    const inherited = this.inherited(placeholder);
    const properties = child(node, 'spPr');
    const raw =
      readXfrm(child(properties, 'xfrm')) ??
      readXfrm(path(inherited.layout, 'spPr', 'xfrm')) ??
      readXfrm(path(inherited.master, 'spPr', 'xfrm'));
    if (!raw) return;
    const style = child(node, 'style');
    let fill = readFill(properties, theme);
    if (fill === undefined) {
      fill = readFill(child(inherited.layout, 'spPr'), theme);
    }
    if (fill === undefined) {
      fill = readFill(child(inherited.master, 'spPr'), theme);
    }
    if (fill === undefined && !placeholder) {
      const reference = child(style, 'fillRef');
      fill =
        (intAttr(reference, 'idx') ?? 0) > 0
          ? resolveColor(reference, theme)
          : undefined;
    }
    const sources: TextStyleSources = placeholder
      ? {
          listStyles: [
            path(inherited.layout, 'txBody', 'lstStyle'),
            path(inherited.master, 'txBody', 'lstStyle'),
            placeholderTextStyle(placeholder.type, this.context.master),
            this.defaultTextStyle,
          ],
          layoutPlaceholder: inherited.layout,
          masterPlaceholder: inherited.master,
        }
      : {
          listStyles: [
            this.defaultTextStyle,
            path(this.context.master, 'txStyles', 'otherStyle'),
          ],
          fontColor: resolveColor(child(style, 'fontRef'), theme),
        };
    const text = readTextBody(
      child(node, 'txBody'),
      sources,
      theme,
      DEFAULT_FONT_SIZE_PT,
      this.budget,
      [
        path(inherited.layout, 'txBody', 'bodyPr'),
        path(inherited.master, 'txBody', 'bodyPr'),
      ],
    );
    const stroke = readStroke(properties, style, theme);
    if ((fill === null || fill === undefined) && !stroke && !text) return;
    this.push({
      kind: 'shape',
      box: applyTransform(raw, transform),
      geometry: geometryOf(properties),
      fill: fill ?? undefined,
      stroke,
      text,
    });
  }

  private picture(
    node: Element,
    part: PartContext,
    transform: Transform,
  ): void {
    const placeholder = readPlaceholder(node);
    if (placeholder && !part.isSlide) return;
    const inherited = this.inherited(placeholder);
    const raw =
      readXfrm(path(node, 'spPr', 'xfrm')) ??
      readXfrm(path(inherited.layout, 'spPr', 'xfrm')) ??
      readXfrm(path(inherited.master, 'spPr', 'xfrm'));
    if (!raw) return;
    const description = path(node, 'nvPicPr', 'cNvPr');
    const alt = attr(description, 'descr') || attr(description, 'name') || '';
    this.budget.text(alt);
    const relationshipId = relAttr(path(node, 'blipFill', 'blip'), 'embed');
    const target =
      relationshipId === undefined
        ? undefined
        : this.presentation.rels(part.partPath).get(relationshipId)?.target;
    this.push({
      kind: 'image',
      box: applyTransform(raw, transform),
      alt,
      src: this.presentation.imageDataUrl(target),
    });
  }

  private connector(node: Element, transform: Transform): void {
    const properties = child(node, 'spPr');
    const raw = readXfrm(child(properties, 'xfrm'));
    const stroke = readStroke(
      properties,
      child(node, 'style'),
      this.context.theme,
    );
    if (!raw || !stroke) return;
    const box = applyTransform(raw, transform);
    const [x1, x2] = raw.flipH
      ? [box.x + box.width, box.x]
      : [box.x, box.x + box.width];
    const [y1, y2] = raw.flipV
      ? [box.y + box.height, box.y]
      : [box.y, box.y + box.height];
    this.push({ kind: 'line', x1, y1, x2, y2, stroke });
  }

  private graphicFrame(node: Element, transform: Transform): void {
    const raw = readXfrm(child(node, 'xfrm'));
    if (!raw) return;
    const box = applyTransform(raw, transform);
    const data = path(node, 'graphic', 'graphicData');
    const uri = attr(data, 'uri') ?? '';
    const table = child(data, 'tbl');
    if (table) {
      this.table(table, box);
      return;
    }
    this.push({
      kind: 'unsupported',
      box,
      label: uri.endsWith('/chart')
        ? 'Chart'
        : uri.endsWith('/diagram')
          ? 'SmartArt diagram'
          : 'Embedded content',
    });
  }

  private table(table: Element, box: PptxBox): void {
    const { theme } = this.context;
    const columnWidths = children(child(table, 'tblGrid'), 'gridCol').map(
      (column) => {
        this.budget.retain();
        return Math.max(0, intAttr(column, 'w') ?? 0);
      },
    );
    const rows = children(table, 'tr').map((row) => {
      this.budget.retain();
      return {
        height: Math.max(0, intAttr(row, 'h') ?? 0),
        cells: children(row, 'tc').map((cell): PptxTableCell | null => {
          this.budget.retain();
          if (
            boolAttr(cell, 'hMerge') === true ||
            boolAttr(cell, 'vMerge') === true
          ) {
            return null;
          }
          const cellProperties = child(cell, 'tcPr');
          return {
            text: readTextBody(
              child(cell, 'txBody'),
              { listStyles: [this.defaultTextStyle] },
              theme,
              DEFAULT_TABLE_FONT_SIZE_PT,
              this.budget,
            ),
            fill: readFill(cellProperties, theme) ?? undefined,
            colSpan: Math.max(1, intAttr(cell, 'gridSpan') ?? 1),
            rowSpan: Math.max(1, intAttr(cell, 'rowSpan') ?? 1),
          };
        }),
      };
    });
    this.push({ kind: 'table', box, columnWidths, rows });
  }
}

interface Background {
  readonly color?: string;
  readonly image?: string;
}

function readBackground(
  presentation: PresentationPackage,
  sources: readonly { readonly root?: Element; readonly partPath?: string }[],
  theme: PptxThemeContext,
): Background {
  for (const source of sources) {
    const background = path(source.root, 'cSld', 'bg');
    if (!background) continue;
    const properties = child(background, 'bgPr');
    if (properties) {
      const blip = path(properties, 'blipFill', 'blip');
      const relationshipId = relAttr(blip, 'embed');
      if (relationshipId !== undefined && source.partPath !== undefined) {
        const image = presentation.imageDataUrl(
          presentation.rels(source.partPath).get(relationshipId)?.target,
        );
        if (image !== undefined) return { image };
      }
      const color = readFill(properties, theme);
      return color ? { color } : {};
    }
    const reference = child(background, 'bgRef');
    const color = resolveColor(reference, theme);
    return color ? { color } : {};
  }
  return {};
}

function readNotes(
  presentation: PresentationPackage,
  slidePath: string,
  budget: SlideBudget,
): string[] {
  const notes = presentation.xml(presentation.related(slidePath, 'notesSlide'));
  const body = childElements(path(notes, 'cSld', 'spTree')).find(
    (shape) => readPlaceholder(shape)?.type === 'body',
  );
  const lines: string[] = [];
  for (const paragraph of children(child(body, 'txBody'), 'p')) {
    const line = descendantText(paragraph).trim();
    if (line === '') continue;
    budget.retain();
    budget.text(line);
    lines.push(line);
  }
  return lines;
}

function slideDimension(value: number | undefined, fallback: number): number {
  return value !== undefined && value > 0 && value <= MAX_SLIDE_EMU
    ? value
    : fallback;
}

const encoder = new TextEncoder();

export function parsePptxPresentation(bytes: ArrayBuffer): PptxParseResult {
  // Parts are expanded lazily; each expansion re-verifies its declared size.
  const presentation = new PresentationPackage(
    assertOfficeArchive(bytes, 'pptx'),
  );
  const presentationPath = 'ppt/presentation.xml';
  const root = presentation.xml(presentationPath);
  if (!root || nameOf(root) !== 'presentation') {
    throw new Error('Archive is not a PPTX package.');
  }
  const slideSize = child(root, 'sldSz');
  const slideWidth = slideDimension(
    intAttr(slideSize, 'cx'),
    DEFAULT_SLIDE_WIDTH,
  );
  const slideHeight = slideDimension(
    intAttr(slideSize, 'cy'),
    DEFAULT_SLIDE_HEIGHT,
  );
  const defaultTextStyle = child(root, 'defaultTextStyle');
  const relationships = presentation.rels(presentationPath);
  const slidePaths = children(child(root, 'sldIdLst'), 'sldId').map(
    (slideId) => {
      const relationship = relationships.get(relAttr(slideId, 'id') ?? '');
      if (relationship?.type !== 'slide') {
        throw new Error('Presentation has an unresolved slide relationship.');
      }
      return relationship.target;
    },
  );

  const layoutContexts = new Map<string, LayoutContext>();
  const layoutContext = (layoutPath: string | undefined): LayoutContext => {
    const key = layoutPath ?? '';
    const cached = layoutContexts.get(key);
    if (cached) return cached;
    const layout = presentation.xml(layoutPath);
    const masterPath =
      layoutPath === undefined
        ? undefined
        : presentation.related(layoutPath, 'slideMaster');
    const master = presentation.xml(masterPath);
    const theme =
      masterPath === undefined
        ? EMPTY_THEME
        : readTheme(
            presentation.xml(presentation.related(masterPath, 'theme')),
            master,
          );
    const context: LayoutContext = {
      theme,
      layout,
      layoutPath,
      master,
      masterPath,
      layoutPlaceholders: placeholderShapes(layout),
      masterPlaceholders: placeholderShapes(master),
    };
    layoutContexts.set(key, context);
    return context;
  };

  const slides: PptxSlideModel[] = [];
  const budget: PresentationBudget = { nodes: 0, textBytes: 0 };
  let outputBytes = 0;
  for (const [index, slidePath] of slidePaths
    .slice(0, PPTX_PREVIEW_MAX_SLIDES)
    .entries()) {
    const slide = presentation.xml(slidePath);
    if (!slide) throw new Error('Presentation is missing a referenced slide.');
    const context = layoutContext(
      presentation.related(slidePath, 'slideLayout'),
    );
    const state: WalkState = { elements: [], truncated: false };
    const slideBudget = new SlideBudget(budget);
    const walker = new SlideWalker(
      presentation,
      context,
      defaultTextStyle,
      state,
      slideBudget,
    );
    const showMasterShapes = boolAttr(slide, 'showMasterSp') !== false;
    if (
      showMasterShapes &&
      boolAttr(context.layout, 'showMasterSp') !== false &&
      context.masterPath !== undefined
    ) {
      walker.walk(
        path(context.master, 'cSld', 'spTree'),
        { partPath: context.masterPath, isSlide: false },
        IDENTITY,
      );
    }
    if (showMasterShapes && context.layoutPath !== undefined) {
      walker.walk(
        path(context.layout, 'cSld', 'spTree'),
        { partPath: context.layoutPath, isSlide: false },
        IDENTITY,
      );
    }
    walker.walk(
      path(slide, 'cSld', 'spTree'),
      { partPath: slidePath, isSlide: true },
      IDENTITY,
    );
    const background = readBackground(
      presentation,
      [
        { root: slide, partPath: slidePath },
        { root: context.layout, partPath: context.layoutPath },
        { root: context.master, partPath: context.masterPath },
      ],
      context.theme,
    );
    const model: PptxSlideModel = {
      number: index + 1,
      hidden: boolAttr(slide, 'show') === false,
      background: background.color,
      backgroundImage: background.image,
      elements: state.elements,
      elementsTruncated: state.truncated,
      notes: readNotes(presentation, slidePath, slideBudget),
    };
    outputBytes += encoder.encode(JSON.stringify(model)).byteLength;
    if (outputBytes > PPTX_PREVIEW_MAX_OUTPUT_BYTES) {
      throw new Error('Preview output exceeds its budget.');
    }
    slides.push(model);
  }
  return {
    kind: 'pptx',
    slideWidth,
    slideHeight,
    slideCount: slidePaths.length,
    slides,
  };
}
