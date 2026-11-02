import type * as monaco from 'monaco-editor';

const BASE_EDITOR_OPTIONS: monaco.editor.IStandaloneEditorConstructionOptions =
  {
    automaticLayout: true,
    fontSize: 12,
    fontFamily:
      'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
    lineNumbers: 'on',
    glyphMargin: true,
    minimap: { enabled: false },
    scrollBeyondLastLine: false,
    renderWhitespace: 'selection',
    detectIndentation: true,
    tabSize: 2,
    insertSpaces: true,
    contextmenu: true,
    stickyScroll: { enabled: false },
  };

/**
 * Prose-heavy sources, including LaTeX and BibTeX, wrap long lines and don't
 * flag ordinary typographic punctuation (en/em dashes, curly quotes) as
 * ambiguous. Every other language derives from the file classification, so
 * plaintext mappings such as `.log`, `.env`, and `.toml` wrap too.
 */
const PROSE_LANGUAGES: ReadonlySet<string> = new Set([
  'markdown',
  'mdx',
  'plaintext',
  'latex',
  'bibtex',
]);

const PROSE_EDITOR_OPTIONS: monaco.editor.IStandaloneEditorConstructionOptions =
  {
    ...BASE_EDITOR_OPTIONS,
    wordWrap: 'on',
    unicodeHighlight: { ambiguousCharacters: false },
  };

// Monaco merges option updates, so a reused editor switching from a prose
// model must be told to restore the code policy rather than omit it.
const CODE_EDITOR_OPTIONS: monaco.editor.IStandaloneEditorConstructionOptions =
  {
    ...BASE_EDITOR_OPTIONS,
    wordWrap: 'off',
    unicodeHighlight: { ambiguousCharacters: true },
  };

const UNICODE_CODE_LANGUAGES: ReadonlySet<string> = new Set(['lean']);

// Lean uses Unicode notation while retaining the no-wrap code policy.
const UNICODE_CODE_EDITOR_OPTIONS: monaco.editor.IStandaloneEditorConstructionOptions =
  {
    ...BASE_EDITOR_OPTIONS,
    wordWrap: 'off',
    unicodeHighlight: { ambiguousCharacters: false },
  };

/** Editor options for a model in `language`; stable per language kind. */
export function resolveMonacoEditorOptions(
  language: string,
): monaco.editor.IStandaloneEditorConstructionOptions {
  if (PROSE_LANGUAGES.has(language)) return PROSE_EDITOR_OPTIONS;
  if (UNICODE_CODE_LANGUAGES.has(language)) return UNICODE_CODE_EDITOR_OPTIONS;
  return CODE_EDITOR_OPTIONS;
}
