import { CANOPY_TS_SUPPLEMENTAL_QUERY } from '../extract/supplemental-queries';

export interface CodeGraphGrammarDefinition {
  id: string;
  extensions: readonly string[];
  wasmFile: string;
  tagsFiles: readonly string[];
  inlineQuerySuffix: string;
}

// Spike finding (spike-results.md): the TS tags.scm alone has no
// @reference.call and no arrow-function definitions; the JS tags query
// compiles against the TS grammars and must come first.
const TS_TAGS_FILES: readonly string[] = [
  'queries/javascript.tags.scm',
  'queries/typescript.tags.scm',
];

export const CODE_GRAPH_GRAMMARS: readonly CodeGraphGrammarDefinition[] = [
  {
    id: 'swift',
    extensions: ['.swift'],
    wasmFile: 'grammars/tree-sitter-swift.wasm',
    tagsFiles: ['queries/swift.tags.scm'],
    inlineQuerySuffix: '',
  },
  {
    id: 'typescript',
    extensions: ['.ts', '.mts', '.cts'],
    wasmFile: 'grammars/tree-sitter-typescript.wasm',
    tagsFiles: TS_TAGS_FILES,
    inlineQuerySuffix: CANOPY_TS_SUPPLEMENTAL_QUERY,
  },
  {
    id: 'tsx',
    extensions: ['.tsx'],
    wasmFile: 'grammars/tree-sitter-tsx.wasm',
    tagsFiles: TS_TAGS_FILES,
    inlineQuerySuffix: CANOPY_TS_SUPPLEMENTAL_QUERY,
  },
  {
    id: 'javascript',
    extensions: ['.js', '.jsx', '.mjs', '.cjs'],
    wasmFile: 'grammars/tree-sitter-javascript.wasm',
    tagsFiles: ['queries/javascript.tags.scm'],
    inlineQuerySuffix: '',
  },
];

export const CODE_GRAPH_SOURCE_EXTENSIONS: readonly string[] =
  CODE_GRAPH_GRAMMARS.flatMap((grammar) => grammar.extensions);

// Markdown is deliberately NOT a `CODE_GRAPH_GRAMMARS` entry: those grammars
// are tags.scm-driven (one grammar, one compiled tags query), while markdown
// requires a two-pass block+inline parse with no tags query at all (doc
// structure/links are extracted by walking the trees directly). Keep it as a
// separate, explicitly-shaped constant instead of overloading the tags-scm
// registry with an entry whose `tagsFiles`/`inlineQuerySuffix` fields would be
// meaningless.
export const CODE_GRAPH_MARKDOWN_GRAMMARS = {
  block: 'grammars/tree-sitter-markdown.wasm',
  inline: 'grammars/tree-sitter-markdown-inline.wasm',
} as const;

export function grammarForPath(
  relativePath: string,
): CodeGraphGrammarDefinition | undefined {
  const lower = relativePath.toLowerCase();
  return CODE_GRAPH_GRAMMARS.find((grammar) =>
    grammar.extensions.some((extension) => lower.endsWith(extension)),
  );
}

// --- Per-engine effective grammar list (Phase 6 Task 8) ----------------------
//
// The built-ins above stay a global const; validated CUSTOM grammars from a
// worktree's `.canopy/code-graph/languages.json` are merged into a per-ENGINE
// effective list at build time. Custom definitions carry ABSOLUTE
// wasmFile/tagsFiles paths (see languages/custom-config.ts) and are loaded
// through `CodeGraphParserRuntime.getCustomGrammar`, never `getGrammar`.

export interface CodeGraphEffectiveGrammar {
  definition: CodeGraphGrammarDefinition;
  origin: 'builtin' | 'custom';
}

/** Built-ins first, then customs in config order. Custom entries can never
 * shadow a built-in extension (validation rejects that), so the order is
 * defensive rather than load-bearing. */
export function mergeEffectiveGrammars(
  customGrammars: readonly CodeGraphGrammarDefinition[],
): CodeGraphEffectiveGrammar[] {
  const effective: CodeGraphEffectiveGrammar[] = CODE_GRAPH_GRAMMARS.map(
    (definition) => ({ definition, origin: 'builtin' }),
  );
  for (const definition of customGrammars) {
    effective.push({ definition, origin: 'custom' });
  }
  return effective;
}

/** Per-engine variant of {@link grammarForPath}: consults the engine's
 * effective list (built-ins + validated customs) instead of the global
 * built-in const. */
export function effectiveGrammarForPath(
  effective: readonly CodeGraphEffectiveGrammar[],
  relativePath: string,
): CodeGraphEffectiveGrammar | undefined {
  const lower = relativePath.toLowerCase();
  return effective.find((grammar) =>
    grammar.definition.extensions.some((extension) =>
      lower.endsWith(extension),
    ),
  );
}
