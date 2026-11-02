import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import type * as WebTreeSitterModule from 'web-tree-sitter';
import { getDefaultCodeGraphResourcesDir } from '../resources';
import { loadRequiredNodeModule } from '../node-module-loader';
import {
  CODE_GRAPH_GRAMMARS,
  CODE_GRAPH_MARKDOWN_GRAMMARS,
  type CodeGraphGrammarDefinition,
} from '../grammars/registry';

// `web-tree-sitter` MUST stay an esbuild `external` in the SEA CLI build
// (see scripts/build-cli.mjs) — bundling it breaks its Emscripten env
// detection (`createRequire(undefined)`), confirmed empirically during the
// Phase 1 final review. But a plain static import/`require('web-tree-sitter')`
// compiles to a bare `require()` call, and a Node single-executable
// application's main-script `require()` is restricted to Node built-ins —
// calling it with any other bare specifier throws
// `ERR_UNKNOWN_BUILTIN_MODULE`, confirmed empirically against a built SEA
// binary, regardless of whether a real `node_modules/web-tree-sitter`
// directory is staged next to it.
//
// `createRequire(__filename)` (what `loadRequiredNodeModule` uses
// internally) does not have this restriction: Node resolves `__filename`
// inside a SEA main script to `process.execPath` (also confirmed
// empirically), so `createRequire` walks real node_modules resolution
// starting from the binary's own directory — exactly where
// `scripts/build-cli.mjs` stages a real `node_modules/web-tree-sitter`
// alongside every built CLI binary. This is unchanged in Electron
// main/Jest/tsx dev, where `__filename` is this file's real on-disk path and
// `createRequire` resolution walks up to the real workspace `node_modules`.
type Language = InstanceType<typeof WebTreeSitterModule.Language>;
type Parser = InstanceType<typeof WebTreeSitterModule.Parser>;
type Query = InstanceType<typeof WebTreeSitterModule.Query>;
type Tree = InstanceType<typeof WebTreeSitterModule.Tree>;

// Re-exported so callers (the markdown extractor, tests) can build
// `includedRanges` entries from tree-node fields without importing
// `web-tree-sitter` directly.
export type Range = WebTreeSitterModule.Range;
export type ParseOptions = WebTreeSitterModule.ParseOptions;

function isWebTreeSitterModule(
  value: unknown,
): value is typeof WebTreeSitterModule {
  return (
    typeof value === 'object' &&
    value !== null &&
    'Language' in value &&
    'Parser' in value &&
    'Query' in value
  );
}

interface WebTreeSitterRuntime {
  Language: typeof WebTreeSitterModule.Language;
  Parser: typeof WebTreeSitterModule.Parser;
  Query: typeof WebTreeSitterModule.Query;
}

// Loaded lazily on first parser use (not at module evaluation) so importing
// this module — and, transitively, the code-graph engine/service from Electron
// main's boot path — never pulls the web-tree-sitter WASM runtime into memory
// until a graph is actually built or queried. Memoized after the first load.
let cachedWebTreeSitter: WebTreeSitterRuntime | null = null;

function getWebTreeSitter(): WebTreeSitterRuntime {
  if (cachedWebTreeSitter === null) {
    const mod = loadRequiredNodeModule<typeof WebTreeSitterModule>({
      moduleId: 'web-tree-sitter',
      requireFrom: __filename,
      validate: isWebTreeSitterModule,
    });
    cachedWebTreeSitter = {
      Language: mod.Language,
      Parser: mod.Parser,
      Query: mod.Query,
    };
  }
  return cachedWebTreeSitter;
}

export interface LoadedCodeGraphGrammar {
  definition: CodeGraphGrammarDefinition;
  language: Language;
  tagsQuery: Query;
  abiVersion: number;
}

// Markdown grammars have no tags.scm — doc structure/links are extracted by
// walking the parsed trees directly — so this intentionally omits `tagsQuery`.
export interface LoadedMarkdownGrammar {
  language: Language;
  abiVersion: number;
}

// web-tree-sitter's WASM runtime is a process-global singleton: `Parser.init`
// bakes the `locateFile` resolver (and therefore the resources dir) in for the
// life of the process. We remember the dir the first successful init used and
// reject any later attempt to reinitialize with a *different* dir.
let parserInitPromise: Promise<void> | null = null;
let parserInitResourcesDir: string | null = null;

function ensureParserInit(resourcesDir: string): Promise<void> {
  if (parserInitPromise !== null) {
    if (
      parserInitResourcesDir !== null &&
      parserInitResourcesDir !== resourcesDir
    ) {
      throw new Error(
        `CodeGraphParserRuntime is already initialized with resourcesDir "${parserInitResourcesDir}"; ` +
          `cannot reinitialize with a different dir "${resourcesDir}" (web-tree-sitter's WASM runtime is a process-global singleton).`,
      );
    }
    return parserInitPromise;
  }
  parserInitResourcesDir = resourcesDir;
  const { Parser } = getWebTreeSitter();
  const initPromise = Parser.init({
    locateFile: (scriptName: string): string =>
      path.join(resourcesDir, 'runtime', scriptName),
  }).catch((error: unknown) => {
    // A rejected init must not be cached forever, or every later create() would
    // replay the same failure. Clear the cache so the next call retries.
    parserInitPromise = null;
    parserInitResourcesDir = null;
    throw error instanceof Error ? error : new Error(String(error));
  });
  parserInitPromise = initPromise;
  return initPromise;
}

export class CodeGraphParserRuntime {
  // Keyed by `loadTagsGrammar`'s composite cache key -- grammar id + ABSOLUTE
  // wasm path + absolute tags paths, plus a content fingerprint for custom
  // assets -- NOT by grammar id alone. Id-only
  // keying was safe while the only grammars were the global built-ins, but
  // this runtime can be shared (injected) across engines for DIFFERENT
  // worktrees (see engine.ts's `parserRuntime` option and
  // impact/before-graph.ts's process-wide shared runtime), and two worktrees
  // may define custom grammars with the same id backed by different wasm
  // files. Absolute-path keying keeps those distinct, and keeps a custom
  // grammar from ever colliding with a bundled one.
  private readonly grammars = new Map<string, LoadedCodeGraphGrammar>();
  private readonly activeCustomGrammars = new Map<
    string,
    LoadedCodeGraphGrammar
  >();
  private markdownGrammars: {
    block: LoadedMarkdownGrammar;
    inline: LoadedMarkdownGrammar;
  } | null = null;

  private constructor(private readonly resourcesDir: string) {}

  public static async create(
    resourcesDir: string = getDefaultCodeGraphResourcesDir(),
  ): Promise<CodeGraphParserRuntime> {
    await ensureParserInit(resourcesDir);
    return new CodeGraphParserRuntime(resourcesDir);
  }

  public async getGrammar(id: string): Promise<LoadedCodeGraphGrammar> {
    const definition = CODE_GRAPH_GRAMMARS.find((grammar) => grammar.id === id);
    if (definition === undefined) {
      throw new Error(`Unknown code-graph grammar id: ${id}`);
    }
    return this.loadTagsGrammar({
      definition,
      wasmPath: path.join(this.resourcesDir, definition.wasmFile),
      tagsPaths: definition.tagsFiles.map((tagsFile) =>
        path.join(this.resourcesDir, tagsFile),
      ),
      // Bundled tags files are trusted repo resources -- a compile failure
      // there is a Canopy bug, not user input, so no per-file probe pass.
      probeTagsFilesIndividually: false,
      contentSensitiveCacheKey: false,
    });
  }

  /**
   * Loads a CUSTOM grammar definition (Phase 6 Task 8) whose `wasmFile` and
   * `tagsFiles` are ABSOLUTE paths (resolved against the worktree config's
   * own directory by languages/custom-config.ts -- never resourcesDir-
   * relative). Shares the composite cache with the built-ins, so
   * validating an entry and later extracting with it loads its wasm exactly
   * once per runtime. Unlike bundled grammars, every tags file is first
   * probe-compiled INDIVIDUALLY (each probe Query deleted in `finally`) so a
   * compile failure names the offending file in its diagnostic.
   */
  public async getCustomGrammar(
    definition: CodeGraphGrammarDefinition,
    captured?: { wasmBytes: Buffer; tagsSources: readonly string[] },
  ): Promise<LoadedCodeGraphGrammar> {
    const definitionKey = [
      definition.id,
      definition.wasmFile,
      ...definition.tagsFiles,
    ].join('\n');
    const loaded = await this.loadTagsGrammar({
      definition,
      wasmPath: definition.wasmFile,
      tagsPaths: [...definition.tagsFiles],
      probeTagsFilesIndividually: true,
      // Custom assets can change in place. Include their bytes in the cache
      // identity so the fingerprint-triggered reparse uses the new grammar,
      // even when an in-process CLI engine retains this runtime.
      contentSensitiveCacheKey: true,
      captured,
    });
    this.activeCustomGrammars.set(definitionKey, loaded);
    return loaded;
  }

  public async getResolvedCustomGrammar(
    definition: CodeGraphGrammarDefinition,
  ): Promise<LoadedCodeGraphGrammar> {
    const definitionKey = [
      definition.id,
      definition.wasmFile,
      ...definition.tagsFiles,
    ].join('\n');
    return (
      this.activeCustomGrammars.get(definitionKey) ??
      this.getCustomGrammar(definition)
    );
  }

  private async loadTagsGrammar(input: {
    definition: CodeGraphGrammarDefinition;
    wasmPath: string;
    tagsPaths: string[];
    probeTagsFilesIndividually: boolean;
    contentSensitiveCacheKey: boolean;
    captured?: { wasmBytes: Buffer; tagsSources: readonly string[] };
  }): Promise<LoadedCodeGraphGrammar> {
    const { definition, wasmPath, tagsPaths } = input;
    // Id participates in the key so two definitions sharing wasm+tags but
    // carrying different ids never alias one cache entry (the cached value
    // embeds its definition, and `definition.id` becomes the stored file
    // `language`/`grammarId`). Newline-joined: absolute paths cannot contain
    // newlines on the platforms Canopy supports. Custom assets add their
    // content hash because those user-controlled files may change in place.
    let wasmBytes: Buffer | undefined = input.captured?.wasmBytes;
    let tagsSources: string[] | undefined = input.captured?.tagsSources.slice();
    let contentFingerprint: string | undefined;
    if (input.contentSensitiveCacheKey) {
      wasmBytes ??= readFileSync(wasmPath);
      tagsSources ??= tagsPaths.map((tagsPath) =>
        readFileSync(tagsPath, 'utf8'),
      );
      const hash = createHash('sha256');
      hash.update(wasmBytes);
      for (let i = 0; i < tagsPaths.length; i += 1) {
        hash.update('\0');
        hash.update(tagsPaths[i]);
        hash.update('\0');
        hash.update(tagsSources[i]);
      }
      contentFingerprint = hash.digest('hex');
    }
    const cacheKey = [
      definition.id,
      wasmPath,
      ...tagsPaths,
      ...(contentFingerprint === undefined ? [] : [contentFingerprint]),
    ].join('\n');
    const cached = this.grammars.get(cacheKey);
    if (cached !== undefined) {
      return cached;
    }
    const { Language, Query } = getWebTreeSitter();
    let language: Language;
    try {
      // Pass the wasm bytes directly (not a path string): web-tree-sitter's
      // path-string branch does a dynamic `import('fs/promises')` internally,
      // which Jest's vm-based module execution rejects with
      // ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING_FLAG. Reading the buffer
      // ourselves takes the Uint8Array branch instead and sidesteps that.
      wasmBytes ??= readFileSync(wasmPath);
      language = await Language.load(wasmBytes);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      // web-tree-sitter's own ABI-mismatch error message carries the wasm's
      // language version and the supported range, so `reason` already
      // surfaces the ABI number in the one case where it is knowable (the
      // failed load never yields a `Language` to read `abiVersion` from).
      throw new Error(
        `Failed to load grammar wasm for "${definition.id}" (${definition.wasmFile}); check grammar ABI compatibility: ${reason}`,
      );
    }
    tagsSources ??= tagsPaths.map((tagsPath) => readFileSync(tagsPath, 'utf8'));
    if (input.probeTagsFilesIndividually) {
      for (let i = 0; i < tagsPaths.length; i += 1) {
        // Compile-and-dispose: each probe Query is deleted in `finally`
        // (Tree/Query/Parser have `.delete()`; Language does not). Only the
        // joined query below is retained in the cache.
        let probe: Query | undefined;
        try {
          probe = new Query(language, tagsSources[i]);
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          throw new Error(
            `tags query "${definition.tagsFiles[i]}" failed to compile against grammar "${definition.id}" (abi ${language.abiVersion}): ${reason}`,
          );
        } finally {
          if (probe !== undefined) {
            probe.delete();
          }
        }
      }
    }
    const querySource = tagsSources
      .concat(
        definition.inlineQuerySuffix === ''
          ? []
          : [definition.inlineQuerySuffix],
      )
      .join('\n');
    const loaded: LoadedCodeGraphGrammar = {
      definition,
      language,
      tagsQuery: new Query(language, querySource),
      abiVersion: language.abiVersion,
    };
    this.grammars.set(cacheKey, loaded);
    return loaded;
  }

  // Loads both markdown grammars (no tags query — see `LoadedMarkdownGrammar`)
  // and caches the pair for the life of this runtime, mirroring `getGrammar`'s
  // cache-after-first-load shape.
  public async getMarkdownGrammars(): Promise<{
    block: LoadedMarkdownGrammar;
    inline: LoadedMarkdownGrammar;
  }> {
    if (this.markdownGrammars !== null) {
      return this.markdownGrammars;
    }
    const { Language } = getWebTreeSitter();
    const loadOne = async (
      id: 'block' | 'inline',
      wasmFile: string,
    ): Promise<LoadedMarkdownGrammar> => {
      try {
        // See the matching comment in `getGrammar`: pass wasm bytes directly
        // so web-tree-sitter takes the Uint8Array branch, not the path-string
        // branch (which does a Jest-hostile dynamic `import('fs/promises')`).
        const wasmBytes = readFileSync(path.join(this.resourcesDir, wasmFile));
        const language = await Language.load(wasmBytes);
        return { language, abiVersion: language.abiVersion };
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        throw new Error(
          `Failed to load markdown "${id}" grammar wasm (${wasmFile}); check grammar ABI compatibility: ${reason}`,
        );
      }
    };
    const [block, inline] = await Promise.all([
      loadOne('block', CODE_GRAPH_MARKDOWN_GRAMMARS.block),
      loadOne('inline', CODE_GRAPH_MARKDOWN_GRAMMARS.inline),
    ]);
    const loaded = { block, inline };
    this.markdownGrammars = loaded;
    return loaded;
  }

  public withParser<T>(
    grammar: LoadedCodeGraphGrammar,
    fn: (parser: Parser) => T,
  ): T {
    return this.withParserForLanguage(grammar.language, fn);
  }

  // Lower-level primitive underlying `withParser`: takes a raw `Language`
  // (rather than a `LoadedCodeGraphGrammar`) so it also composes with
  // `LoadedMarkdownGrammar`, which has no tags query to bundle a grammar
  // wrapper around.
  public withParserForLanguage<T>(
    language: Language,
    fn: (parser: Parser) => T,
  ): T {
    const { Parser } = getWebTreeSitter();
    const parser = new Parser();
    try {
      parser.setLanguage(language);
      return fn(parser);
    } finally {
      parser.delete();
    }
  }

  public withTree<T>(
    parser: Parser,
    source: string,
    fn: (tree: Tree | null) => T,
  ): T {
    return this.withTreeOptions(parser, source, undefined, fn);
  }

  // Lower-level primitive underlying `withTree`: accepts `ParseOptions` so the
  // markdown inline pass can pass `{ includedRanges }` (the dual-parse
  // contract confirmed in the spike — `parser.setIncludedRanges()` does not
  // exist in web-tree-sitter 0.26; ranges are only accepted as parse options).
  public withTreeOptions<T>(
    parser: Parser,
    source: string,
    options: ParseOptions | undefined,
    fn: (tree: Tree | null) => T,
  ): T {
    const tree = parser.parse(source, null, options);
    try {
      return fn(tree);
    } finally {
      if (tree !== null) {
        tree.delete();
      }
    }
  }

  public dispose(): void {
    for (const grammar of Array.from(this.grammars.values())) {
      grammar.tagsQuery.delete();
    }
    this.grammars.clear();
    this.activeCustomGrammars.clear();
    // `Language` instances have no `.delete()` in web-tree-sitter (only
    // `Tree`/`Query`/`Parser` do); dropping the cache reference is sufficient.
    this.markdownGrammars = null;
  }
}
