export function normalizeMonacoSelectionEndLine(
  startLine: number,
  endLine: number,
  endColumn: number,
): number {
  return endLine > startLine && endColumn === 1 ? endLine - 1 : endLine;
}
