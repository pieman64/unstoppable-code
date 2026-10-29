export const REG2902_DOCX_HEADING: 'REG-2902 heading one';
export const REG2902_DOCX_BULLET: 'REG-2902 bullet item';
export const REG2902_DOCX_TABLE_CELL: 'REG-2902 table cell';
export const REG2902_DOCX_INSERTED_TEXT: 'REG-2902 inserted by review';
export const REG2902_DOCX_DELETED_TEXT: 'REG-2902 deleted by review';
export const REG2902_DOCX_SCRIPT_TEXT: '<script>window.__reg2902Injected = true</script>';
export const REG2902_DOCX_LINK_TEXT: 'REG-2902 hostile link';
export const REG2902_XLSX_SHEET_NAMES: readonly ['Summary', 'Data'];
export const REG2902_XLSX_LARGE_ROWS: 5020;
export const REG2902_DOCX_DENSE_PARAGRAPHS: 30000;
export const REG2902_DOCX_DENSE_TABLE_ROWS: 2000;
export const REG2902_DOCX_DENSE_LAST_TEXT: 'REG-2902 dense end';

export function buildStoredZip(
  entries: ReadonlyArray<{ name: string; data: string | Uint8Array }>,
): Uint8Array;
export const ONE_PIXEL_PNG_BASE64: string;
export function buildReg2902DocxFixture(options?: {
  imageBytes?: Uint8Array;
}): Uint8Array;
export function buildReg2902XlsxFixture(options?: {
  largeRows?: number;
  cellTextChars?: number;
  targetBytes?: number;
}): Uint8Array;
export function buildReg2902DenseDocxFixture(options?: {
  paragraphs?: number;
  tableRows?: number;
}): Uint8Array;
export function buildReg2902ElementBudgetDocxFixture(options?: {
  paragraphs?: number;
}): Uint8Array;

export function buildReg2902DeflatedDocxFixture(options?: {
  declaredDocumentBytes?: number;
}): Uint8Array;

export const PPTX_TITLE: 'Quarterly support review';
export const PPTX_BULLETS: readonly ['Tickets down 12%', 'CSAT steady at 94%'];
export const PPTX_NOTES: 'Mention the holiday staffing plan.';
export const PPTX_TABLE_CELL: 'Urgent bugs';
export const PPTX_GROUP_TEXT: 'Grouped callout';
export const PPTX_MASTER_FILL: '#2563eb';
export const PPTX_HIDDEN_BACKGROUND: '#fef3c7';
/** Two-slide deck (title + detail) plus `extraSlides` simple title slides. */
export function buildPptxFixture(options?: {
  extraSlides?: number;
  imageBytes?: Uint8Array;
  /** Picture shapes on the title slide that reference the same image part. */
  imageReferences?: number;
  macro?: boolean;
  /** Extra paragraph in the matching layout title placeholder. */
  layoutTitleParagraph?: string;
  /** Remove one package part to exercise malformed-deck handling. */
  omitPart?: string;
  omitSlideRelationship?: boolean;
}): Uint8Array;
