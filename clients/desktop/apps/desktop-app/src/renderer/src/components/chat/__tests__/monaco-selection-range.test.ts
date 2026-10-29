import { normalizeMonacoSelectionEndLine } from '../monaco-selection-range';

describe('normalizeMonacoSelectionEndLine', () => {
  it('excludes the next line when a multiline selection ends at column one', () => {
    expect(normalizeMonacoSelectionEndLine(3, 5, 1)).toBe(4);
  });

  it('preserves single-line and non-column-one selection ends', () => {
    expect(normalizeMonacoSelectionEndLine(3, 3, 1)).toBe(3);
    expect(normalizeMonacoSelectionEndLine(3, 5, 2)).toBe(5);
  });
});
