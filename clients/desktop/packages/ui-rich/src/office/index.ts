// Lazy subpath only. Never export Office from the root ui-rich barrel.
export { DocxPreview, type DocxPreviewProps } from './DocxPreview';
export { XlsxPreview, type XlsxPreviewProps } from './XlsxPreview';
export { PptxPreview, type PptxPreviewProps } from './PptxPreview';
export {
  OfficePreviewBanner,
  OFFICE_PREVIEW_BANNER_TEXT,
  type OfficePreviewBannerProps,
} from './OfficePreviewBanner';
export {
  DEFAULT_OFFICE_PREVIEW_COPY,
  type OfficePreviewCopy,
  type OfficePreviewRenderFailure,
} from './office-preview-copy';
export type {
  DocxParseResult,
  OfficeParseRequest,
  OfficeParseResponse,
  OfficeParseResult,
  XlsxMerge,
  XlsxParseResult,
  XlsxSheetModel,
} from './office-parse';
export type {
  PptxElement,
  PptxParagraph,
  PptxParseResult,
  PptxSlideModel,
  PptxTextBody,
  PptxTextRun,
} from './pptx-parse';
