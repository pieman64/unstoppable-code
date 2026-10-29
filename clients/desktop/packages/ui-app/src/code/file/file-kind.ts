import type { PortalFilePreview } from '@canopy/protocol/portal';
import {
  DOCX_MEDIA_TYPE,
  XLSX_MEDIA_TYPE,
} from '@canopy/protocol/cloud-attachments';

/**
 * How the shared {@link import('./FileViewer').FileViewer} should render a
 * file's text content. `image`/binary are out of scope for the neutral
 * text-only {@link PortalFilePreview} (its `content` is always a string), so a
 * non-previewable file falls through to `code`. `pdf`/`docx`/`xlsx`/`pptx`
 * are rich-document kinds served by the host-injected byte resolver; hosts opt
 * in per kind through `supportedDocumentKinds`.
 */
export type FileRenderKind =
  | 'markdown'
  | 'html'
  | 'image'
  | 'pdf'
  | 'docx'
  | 'xlsx'
  | 'pptx'
  | 'code';

/** Kinds routed through `resolveDocumentBytes` + `renderRichDocument`. */
export type RichDocumentRenderKind = Extract<
  FileRenderKind,
  'pdf' | 'docx' | 'xlsx' | 'pptx'
>;

const MARKDOWN_EXTENSIONS: ReadonlySet<string> = new Set([
  'md',
  'markdown',
  'mdx',
]);
const HTML_EXTENSIONS: ReadonlySet<string> = new Set(['html', 'htm']);
const IMAGE_EXTENSIONS: ReadonlySet<string> = new Set([
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'svg',
  'bmp',
]);
const PDF_EXTENSIONS: ReadonlySet<string> = new Set(['pdf']);
// Macro-enabled variants (.docm/.xlsm/.pptm) carry different media types and
// stay download-only; REG-2903 owns legacy binary formats.
const DOCX_EXTENSIONS: ReadonlySet<string> = new Set(['docx']);
const XLSX_EXTENSIONS: ReadonlySet<string> = new Set(['xlsx']);
const PPTX_EXTENSIONS: ReadonlySet<string> = new Set(['pptx']);

const RICH_DOCUMENT_KINDS: ReadonlySet<FileRenderKind> =
  new Set<FileRenderKind>(['pdf', 'docx', 'xlsx', 'pptx']);

const MEDIA_TYPE_RENDER_KINDS: ReadonlyMap<string, RichDocumentRenderKind> =
  new Map([
    ['application/pdf', 'pdf'],
    [DOCX_MEDIA_TYPE, 'docx'],
    [XLSX_MEDIA_TYPE, 'xlsx'],
    [
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      'pptx',
    ],
  ]);

/** Lower-cased extension (without the dot), or `''` for an extensionless path. */
export function fileExtension(path: string): string {
  const queryIndex = path.search(/[?#]/);
  const clean = queryIndex === -1 ? path : path.slice(0, queryIndex);
  const base = clean.slice(clean.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
}

export function isRichDocumentRenderKind(
  kind: FileRenderKind,
): kind is RichDocumentRenderKind {
  return RICH_DOCUMENT_KINDS.has(kind);
}

/**
 * Render kind for an attachment whose MIME type is authoritative (hosts pass
 * it as `requestRenderKind`); `undefined` for anything without a rich renderer.
 */
export function fileRenderKindForMediaType(
  mediaType: string | undefined,
): RichDocumentRenderKind | undefined {
  return mediaType === undefined
    ? undefined
    : MEDIA_TYPE_RENDER_KINDS.get(mediaType);
}

/**
 * Pick the render kind from the preview's path extension, falling back to the
 * server's `language` hint. Extension wins because a host may not populate
 * `language` for every file.
 */
export function resolveFileRenderKind(
  preview: Pick<PortalFilePreview, 'path' | 'language'>,
): FileRenderKind {
  const extension = fileExtension(preview.path);
  if (MARKDOWN_EXTENSIONS.has(extension) || preview.language === 'markdown') {
    return 'markdown';
  }
  if (HTML_EXTENSIONS.has(extension) || preview.language === 'html') {
    return 'html';
  }
  if (IMAGE_EXTENSIONS.has(extension)) {
    return 'image';
  }
  if (PDF_EXTENSIONS.has(extension)) {
    return 'pdf';
  }
  if (DOCX_EXTENSIONS.has(extension)) {
    return 'docx';
  }
  if (XLSX_EXTENSIONS.has(extension)) {
    return 'xlsx';
  }
  if (PPTX_EXTENSIONS.has(extension)) {
    return 'pptx';
  }
  return 'code';
}
