import { DIFF_STYLES } from '../DiffContentView';

// DESIGN.md: code, diffs, and paths render in JetBrains Mono through the
// shared `--font-mono` token. `react-diff-viewer-continued` styles its
// `contentText` and `lineNumber` spans with a generic `monospace` underneath
// the `line` / `gutter` overrides, so every font-bearing key the library
// exposes must be overridden or the diff text silently falls back.
describe('DIFF_STYLES', () => {
  it.each(['line', 'gutter', 'codeFold', 'contentText', 'lineNumber'] as const)(
    'reads the shared mono token for %s',
    (key) => {
      const styles: Record<string, { fontFamily?: string } | undefined> =
        DIFF_STYLES;
      expect(styles[key]?.fontFamily).toBe('var(--font-mono)');
    },
  );
});
