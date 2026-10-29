/** Small ZIPs with dense nested content to exercise PPTX preview admission. */
export function buildPptxBudgetFixture(options?: {
  slideCount?: number;
  tableCells?: number;
  tableRows?: number;
  tableColumns?: number;
  mergedCells?: boolean;
  paragraphs?: number;
  runsPerParagraph?: number;
  notesParagraphs?: number;
  inertNodes?: number;
  masterParagraphs?: number;
  textChars?: number;
  numberingStartAt?: number;
  fontFamilyChars?: number;
  lineBreaks?: number;
}): Uint8Array;
