import { findRelationshipPath } from './relationship-path';
import {
  codeGraphDerivedState,
  type CodeGraphPathRequest,
  type CodeGraphPathResult,
} from '../../../types/code-graph-tools';
import type {
  CodeGraphCommunityRecord,
  CodeGraphFlowRecord,
  CodeGraphSearchResult,
} from '../../../types/code-graph';
import { canonicalQualifiedName, canonicalRelativePath } from '../ids';
import {
  optionalNumber,
  optionalString,
  requireNumber,
  requireRow,
  requireString,
  type CodeGraphDatabase,
} from '../store/database';
import { searchSymbolFts } from '../store/fts';
import {
  CodeGraphStore,
  type CodeGraphDerivedStats,
  type CodeGraphSymbolDegreeSummary,
} from '../store/graph-store';

interface SymbolLocation {
  qualifiedName: string;
  kind: string;
  filePath: string;
  line: number | null;
}

function locationFromRow(value: unknown): SymbolLocation {
  const row = requireRow(value);
  return {
    qualifiedName: requireString(row, 'qualified_name'),
    kind: requireString(row, 'kind'),
    filePath: requireString(row, 'relative_path'),
    line: optionalNumber(row, 'line'),
  };
}

export class CodeGraphQueryService {
  // Derived-analysis reads (Phase 6 Task 7: communities/flows/hubs query
  // modes, plus the risk formula's flow-participation/community-crossing
  // terms) delegate to `CodeGraphStore`'s own read methods rather than
  // duplicating their SQL here -- this mirrors `engine.ts`'s own pattern of
  // constructing an independent `CodeGraphStore` and `CodeGraphQueryService`
  // off the SAME db handle. No cycle: `store/graph-store.ts` never imports
  // from this module.
  private readonly derivedStore: CodeGraphStore;

  public constructor(private readonly db: CodeGraphDatabase) {
    this.derivedStore = new CodeGraphStore(db);
  }

  public getRelationshipPath(input: CodeGraphPathRequest): CodeGraphPathResult {
    return findRelationshipPath(this.db, input);
  }

  // Repository-scoped lookup mirrors listFileIndex's repositories join: when
  // repoId is provided, the join disambiguates symbols/files that collide
  // across repos (same qualified name / relative path in two repos hashes to
  // two distinct row ids, but an unscoped WHERE would match the first one
  // sqlite happens to return). Both SQL variants stay fully parameterized.
  private symbolIdFor(qualifiedName: string, repoId?: string): string | null {
    const row =
      repoId === undefined
        ? this.db
            .prepare('SELECT id FROM symbols WHERE qualified_name = ?')
            .get(qualifiedName)
        : this.db
            .prepare(
              `SELECT s.id FROM symbols s
               JOIN repositories r ON r.id = s.repository_id AND r.repo_id = ?
               WHERE s.qualified_name = ?`,
            )
            .get(repoId, qualifiedName);
    return row === undefined ? null : requireString(requireRow(row), 'id');
  }

  private fileIdFor(relativePath: string, repoId?: string): string | null {
    const row =
      repoId === undefined
        ? this.db
            .prepare('SELECT id FROM files WHERE relative_path = ?')
            .get(relativePath)
        : this.db
            .prepare(
              `SELECT f.id FROM files f
               JOIN repositories r ON r.id = f.repository_id AND r.repo_id = ?
               WHERE f.relative_path = ?`,
            )
            .get(repoId, relativePath);
    return row === undefined ? null : requireString(requireRow(row), 'id');
  }

  // Resolves `target` (a bare file path OR a `path::Member.name` symbol
  // qualified name) down to the id of its FILE's own symbol row — i.e. for a
  // symbol input, hops from the symbol to its file via `file_id`, then
  // re-resolves that file's canonical relative path back into ITS OWN symbol
  // row. This relies on the same duality `getImporters` documents: a file
  // symbol's `qualified_name` is exactly its canonical relative path. Used by
  // `getDocsFor`, which always needs the DOCUMENTED FILE's symbol id
  // (`DOCUMENTS` edges only ever target file symbols — see doc-link-resolver.ts)
  // regardless of whether the caller passed a file path or a symbol inside it.
  private fileSymbolIdForTarget(
    target: string,
    repoId?: string,
  ): string | null {
    if (!target.includes('::')) {
      return this.symbolIdFor(canonicalRelativePath(target), repoId);
    }
    const symbolId = this.symbolIdFor(canonicalQualifiedName(target), repoId);
    if (symbolId === null) {
      return null;
    }
    const row = this.db
      .prepare(
        `SELECT f.relative_path FROM symbols s
         JOIN files f ON f.id = s.file_id
         WHERE s.id = ?`,
      )
      .get(symbolId);
    if (row === undefined) {
      return null;
    }
    const relativePath = requireString(requireRow(row), 'relative_path');
    return this.symbolIdFor(canonicalRelativePath(relativePath), repoId);
  }

  public getCallers(qualifiedName: string, repoId?: string): SymbolLocation[] {
    const id = this.symbolIdFor(canonicalQualifiedName(qualifiedName), repoId);
    if (id === null) {
      return [];
    }
    return this.db
      .prepare(
        `SELECT s.qualified_name, s.kind, f.relative_path, e.line
         FROM edges e
         JOIN symbols s ON s.id = e.source_symbol_id
         JOIN files f ON f.id = s.file_id
         WHERE e.kind = 'CALLS' AND e.target_symbol_id = ?
         ORDER BY s.qualified_name`,
      )
      .all(id)
      .map(locationFromRow);
  }

  public getCallees(qualifiedName: string, repoId?: string): SymbolLocation[] {
    const id = this.symbolIdFor(canonicalQualifiedName(qualifiedName), repoId);
    if (id === null) {
      return [];
    }
    return this.db
      .prepare(
        `SELECT s.qualified_name, s.kind, f.relative_path, e.line
         FROM edges e
         JOIN symbols s ON s.id = e.target_symbol_id
         JOIN files f ON f.id = s.file_id
         WHERE e.kind = 'CALLS' AND e.source_symbol_id = ? AND e.target_symbol_id IS NOT NULL
         ORDER BY s.qualified_name`,
      )
      .all(id)
      .map(locationFromRow);
  }

  public getImporters(relativePath: string, repoId?: string): string[] {
    // File symbols' qualified_name is just their canonical relative path, so
    // this goes through the same symbols-table lookup as the qualifiedName
    // methods above.
    const id = this.symbolIdFor(canonicalRelativePath(relativePath), repoId);
    if (id === null) {
      return [];
    }
    return this.db
      .prepare(
        `SELECT DISTINCT f.relative_path
         FROM edges e
         JOIN files f ON f.id = e.source_file_id
         WHERE e.kind = 'IMPORTS_FROM' AND e.target_symbol_id = ?
         ORDER BY f.relative_path`,
      )
      .all(id)
      .map((value) => requireString(requireRow(value), 'relative_path'));
  }

  // Reverse of getImporters: what THIS file imports (resolved targets only —
  // an unresolved import only has a raw target_ref specifier, which is not a
  // graph symbol and is surfaced instead via getFileSummary's `imports` list).
  public getImports(relativePath: string, repoId?: string): SymbolLocation[] {
    const fileId = this.fileIdFor(canonicalRelativePath(relativePath), repoId);
    if (fileId === null) {
      return [];
    }
    return this.db
      .prepare(
        `SELECT DISTINCT s.qualified_name, s.kind, f.relative_path, e.line
         FROM edges e
         JOIN symbols s ON s.id = e.target_symbol_id
         JOIN files f ON f.id = s.file_id
         WHERE e.kind = 'IMPORTS_FROM' AND e.source_file_id = ? AND e.target_symbol_id IS NOT NULL
         ORDER BY s.qualified_name`,
      )
      .all(fileId)
      .map(locationFromRow);
  }

  // Direct children of a symbol (e.g. class/interface members), via
  // parent_symbol_id. Ordered by source position like listSymbolsForFile.
  public getChildren(qualifiedName: string, repoId?: string): SymbolLocation[] {
    const id = this.symbolIdFor(canonicalQualifiedName(qualifiedName), repoId);
    if (id === null) {
      return [];
    }
    return this.db
      .prepare(
        `SELECT s.qualified_name, s.kind, f.relative_path, s.line_start AS line
         FROM symbols s
         JOIN files f ON f.id = s.file_id
         WHERE s.parent_symbol_id = ?
         ORDER BY s.byte_start`,
      )
      .all(id)
      .map(locationFromRow);
  }

  // Full symbol detail for the explain tool — location + signature info that
  // the location-only SymbolLocation shape used by callers/callees doesn't
  // carry.
  public getSymbolDetail(
    qualifiedName: string,
    repoId?: string,
  ): {
    qualifiedName: string;
    kind: string;
    filePath: string;
    lineStart: number;
    lineEnd: number;
    signature: string | null;
    exported: boolean;
  } | null {
    const id = this.symbolIdFor(canonicalQualifiedName(qualifiedName), repoId);
    if (id === null) {
      return null;
    }
    const row = requireRow(
      this.db
        .prepare(
          `SELECT s.qualified_name, s.kind, f.relative_path, s.line_start, s.line_end, s.signature, s.exported
           FROM symbols s
           JOIN files f ON f.id = s.file_id
           WHERE s.id = ?`,
        )
        .get(id),
    );
    return {
      qualifiedName: requireString(row, 'qualified_name'),
      kind: requireString(row, 'kind'),
      filePath: requireString(row, 'relative_path'),
      lineStart: requireNumber(row, 'line_start'),
      lineEnd: requireNumber(row, 'line_end'),
      signature: optionalString(row, 'signature'),
      exported: requireNumber(row, 'exported') === 1,
    };
  }

  public getTestsFor(qualifiedName: string, repoId?: string): string[] {
    const id = this.symbolIdFor(canonicalQualifiedName(qualifiedName), repoId);
    if (id === null) {
      return [];
    }
    return this.db
      .prepare(
        `SELECT DISTINCT s.qualified_name
         FROM edges e JOIN symbols s ON s.id = e.target_symbol_id
         WHERE e.kind = 'TESTED_BY' AND e.source_symbol_id = ?
         ORDER BY s.qualified_name`,
      )
      .all(id)
      .map((value) => requireString(requireRow(value), 'qualified_name'));
  }

  public getFileSummary(
    relativePath: string,
    repoId?: string,
  ): {
    file: string;
    symbols: Array<{ qualifiedName: string; kind: string; exported: boolean }>;
    imports: string[];
    importerCount: number;
  } | null {
    const canonicalPath = canonicalRelativePath(relativePath);
    const fileId = this.fileIdFor(canonicalPath, repoId);
    if (fileId === null) {
      return null;
    }
    const symbols = this.db
      .prepare(
        `SELECT qualified_name, kind, exported FROM symbols WHERE file_id = ? AND kind != 'file' ORDER BY byte_start`,
      )
      .all(fileId)
      .map((value) => {
        const row = requireRow(value);
        return {
          qualifiedName: requireString(row, 'qualified_name'),
          kind: requireString(row, 'kind'),
          exported: requireNumber(row, 'exported') === 1,
        };
      });
    const imports = this.db
      .prepare(
        `SELECT target_ref FROM edges WHERE kind = 'IMPORTS_FROM' AND source_file_id = ? AND target_ref IS NOT NULL ORDER BY line`,
      )
      .all(fileId)
      .map((value) => requireString(requireRow(value), 'target_ref'));
    return {
      file: canonicalPath,
      symbols,
      imports,
      importerCount: this.getImporters(canonicalPath, repoId).length,
    };
  }

  public search(
    text: string,
    limit = 20,
    repoId?: string,
  ): CodeGraphSearchResult[] {
    return searchSymbolFts(this.db, text, limit, repoId);
  }

  // `target` may be a bare file path or a symbol qualified name; either way
  // this resolves down to the DOCUMENTED file's own symbol id (see
  // `fileSymbolIdForTarget`) and returns the doc_section/file symbols whose
  // RESOLVED `DOCUMENTS` edge targets it. Filtering on `confidence_tier =
  // 'RESOLVED'` is technically redundant with `target_symbol_id = ?` being
  // non-null (only `resolveDocLinkEdges` ever sets a DOCUMENTS target, and it
  // always pairs that with 'RESOLVED' — see doc-link-resolver.ts), but is kept
  // explicit so this query stays self-documenting about the contract.
  public getDocsFor(
    target: string,
    repoId?: string,
  ): Array<{ qualifiedName: string; filePath: string; line: number | null }> {
    const fileSymbolId = this.fileSymbolIdForTarget(target, repoId);
    if (fileSymbolId === null) {
      return [];
    }
    return this.db
      .prepare(
        `SELECT s.qualified_name, f.relative_path, e.line
         FROM edges e
         JOIN symbols s ON s.id = e.source_symbol_id
         JOIN files f ON f.id = s.file_id
         WHERE e.kind = 'DOCUMENTS' AND e.confidence_tier = 'RESOLVED' AND e.target_symbol_id = ?
         ORDER BY f.relative_path, e.line`,
      )
      .all(fileSymbolId)
      .map((value) => {
        const row = requireRow(value);
        return {
          qualifiedName: requireString(row, 'qualified_name'),
          filePath: requireString(row, 'relative_path'),
          line: optionalNumber(row, 'line'),
        };
      });
  }

  // `qualifiedName` may be a symbol qualified name or a bare file path — both
  // forms already resolve correctly through `symbolIdFor`/`canonicalQualifiedName`
  // (a file symbol's qualified_name is its own canonical relative path, same
  // duality `getImporters` relies on), so no per-branch handling is needed
  // here the way `getDocsFor` needs a symbol->file hop. RATIONALE_FOR edges
  // are always EXTRACTED (fully bound at parse time — see rationale.ts), so
  // unlike getDocsFor there is no confidence-tier gate to apply.
  public getRationaleFor(
    qualifiedName: string,
    repoId?: string,
  ): Array<{
    // The rationale symbol's own REAL qualified name
    // (`${path}::rationale.L${line}`) — surfaced so tool/CLI hit mappers can
    // emit a chainable identifier instead of fabricating display text.
    qualifiedName: string;
    marker: string;
    text: string | null;
    filePath: string;
    line: number | null;
  }> {
    const id = this.symbolIdFor(canonicalQualifiedName(qualifiedName), repoId);
    if (id === null) {
      return [];
    }
    return this.db
      .prepare(
        `SELECT s.qualified_name, s.name, s.signature, f.relative_path, e.line
         FROM edges e
         JOIN symbols s ON s.id = e.source_symbol_id
         JOIN files f ON f.id = s.file_id
         WHERE e.kind = 'RATIONALE_FOR' AND e.target_symbol_id = ?
         ORDER BY e.line`,
      )
      .all(id)
      .map((value) => {
        const row = requireRow(value);
        return {
          qualifiedName: requireString(row, 'qualified_name'),
          marker: requireString(row, 'name'),
          text: optionalString(row, 'signature'),
          filePath: requireString(row, 'relative_path'),
          line: optionalNumber(row, 'line'),
        };
      });
  }

  // Script symbols DECLARED by the manifest file at `relativePath` (via
  // DECLARES_SCRIPT edges sourced from the file's own symbol — see
  // manifest-extractors.ts). A non-manifest file simply has no such edges, so
  // this naturally returns `[]` without needing to special-case file type.
  public getScriptsForFile(
    relativePath: string,
    repoId?: string,
  ): Array<{ name: string; command: string | null }> {
    const fileSymbolId = this.symbolIdFor(
      canonicalRelativePath(relativePath),
      repoId,
    );
    if (fileSymbolId === null) {
      return [];
    }
    return this.db
      .prepare(
        `SELECT s.name, s.signature
         FROM edges e
         JOIN symbols s ON s.id = e.target_symbol_id
         WHERE e.kind = 'DECLARES_SCRIPT' AND e.source_symbol_id = ?
         ORDER BY s.name`,
      )
      .all(fileSymbolId)
      .map((value) => {
        const row = requireRow(value);
        return {
          name: requireString(row, 'name'),
          command: optionalString(row, 'signature'),
        };
      });
  }

  // Bare-key candidate lookup for `getIpcChannel`'s non-qualified-name input
  // path. Mirrors `symbolIdFor`'s repoId-scoped/unscoped SQL shape, but
  // returns EVERY matching id instead of assuming uniqueness -- an
  // `ipc_channel` symbol's `name` is the bare channel key and is not
  // guaranteed unique (see ipc-resolver.ts's own ambiguity handling), so the
  // caller decides what "more than one" means.
  private ipcChannelSymbolIdsForKey(key: string, repoId?: string): string[] {
    const rows =
      repoId === undefined
        ? this.db
            .prepare(
              `SELECT id FROM symbols WHERE kind = 'ipc_channel' AND name = ? ORDER BY qualified_name`,
            )
            .all(key)
        : this.db
            .prepare(
              `SELECT s.id FROM symbols s
               JOIN repositories r ON r.id = s.repository_id AND r.repo_id = ?
               WHERE s.kind = 'ipc_channel' AND s.name = ?
               ORDER BY s.qualified_name`,
            )
            .all(repoId, key);
    return rows.map((value) => requireString(requireRow(value), 'id'));
  }

  // Signature-value fallback for `getIpcChannel`'s non-qualified-name input
  // path, tried only when `ipcChannelSymbolIdsForKey` finds zero candidates.
  // An agent reading renderer/preload call sites most plausibly sees the
  // channel's STRING VALUE (its `signature`, e.g. `panel-layout:load`), not
  // its bare declaration KEY (its `name`, e.g. `panelLayoutLoad`) -- passing
  // that value through the key lookup alone would honestly (but unhelpfully)
  // report "not found". Channel signature values are unique in practice (each
  // channel declares exactly one string literal), so this is a safe secondary
  // exact-match lookup, not a guess; same row shape and same "caller decides
  // what more-than-one means" contract as the key lookup above.
  private ipcChannelSymbolIdsForSignature(
    signature: string,
    repoId?: string,
  ): string[] {
    const rows =
      repoId === undefined
        ? this.db
            .prepare(
              `SELECT id FROM symbols WHERE kind = 'ipc_channel' AND signature = ? ORDER BY qualified_name`,
            )
            .all(signature)
        : this.db
            .prepare(
              `SELECT s.id FROM symbols s
               JOIN repositories r ON r.id = s.repository_id AND r.repo_id = ?
               WHERE s.kind = 'ipc_channel' AND s.signature = ?
               ORDER BY s.qualified_name`,
            )
            .all(repoId, signature);
    return rows.map((value) => requireString(requireRow(value), 'id'));
  }

  // Counts unresolved IPC_HANDLES/IPC_INVOKES edges still carrying the raw
  // `ipc:<key>` targetRef for a resolved channel's own bare key. This is the
  // same-repo-duplicate aftermath resolve/ipc-resolver.ts leaves behind: when
  // more than one ipc_channel symbol shares `key` in a repo, the resolver
  // deliberately leaves every edge referencing that key unresolved rather than
  // guessing (see that module's "Ambiguous" branch). A caller who then
  // resolves ONE of the duplicate declarations directly by qualified name
  // (bypassing the bare-key ambiguity in `getIpcChannel` itself) would
  // otherwise see an empty handlers/invokers list and reasonably conclude
  // "this channel has no call sites" -- which is false; the call sites exist,
  // they are just stuck unresolved.
  //
  // Scoped by the RESOLVED channel symbol's own repository row id
  // (`symbols.repository_id`, already in hand at the call site) rather than
  // the caller's optional request repoId: the resolver never binds across
  // repositories, so a same-key unresolved edge in ANOTHER repo can never be
  // a call site of THIS channel -- counting it (as the previous
  // request-repoId scoping did whenever repoId was omitted) inflated the
  // count in multi-repo worktrees. Uses the same partial index
  // (`idx_edges_unresolved`) as `listEdges({ unresolvedOnly: true })`.
  private countUnresolvedIpcEdgesForKey(
    key: string,
    repositoryRowId: string,
  ): number {
    const targetRef = `ipc:${key}`;
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM edges
         WHERE kind IN ('IPC_HANDLES', 'IPC_INVOKES')
           AND repository_id = ?
           AND target_symbol_id IS NULL
           AND target_ref = ?`,
      )
      .get(repositoryRowId, targetRef);
    return requireNumber(requireRow(row), 'n');
  }

  // Resolves an IPC channel by either a bare channel key (e.g.
  // `panelLayoutLoad`, looked up via (kind='ipc_channel', name=key)), the
  // channel's string VALUE (its `signature`, tried as a fallback when the key
  // lookup finds nothing), or a `::`-qualified symbol name -- and returns the
  // channel's own location plus every IPC_HANDLES/IPC_INVOKES edge that
  // targets it (joined to their source symbols, mirroring getCallers' SQL
  // shape -- handler/invoker call sites are the edge SOURCE, the channel is
  // always the edge TARGET, same direction ipc-resolver.ts binds).
  //
  // Honesty over guessing: an ambiguous bare key or signature value (more
  // than one ipc_channel symbol sharing it within the resolved scope) returns
  // `channel: null` with empty handler/invoker lists and a nonzero
  // `ambiguousCount` instead of silently picking one match's handlers/
  // invokers -- callers (the tool runtime / CLI) surface that count in their
  // summary and point at a qualified-name-plus-repoId retry.
  // `ambiguousLookup` (present only alongside a nonzero `ambiguousCount`)
  // says WHICH lookup produced the multiple matches -- the bare-key lookup
  // or the signature (string-value) fallback -- so that summary copy can say
  // "value" when the value matched instead of always claiming "key". A
  // `::`-qualified input that resolves to a REAL symbol which is NOT an
  // ipc_channel also reports `channel: null` (not ambiguous) -- there IS no
  // channel at that location, so fabricating channel detail for an unrelated
  // symbol kind would be dishonest. `unresolvedCallSiteCount` is always 0
  // unless a channel actually resolved, and is scoped to the resolved
  // channel's OWN repository (see `countUnresolvedIpcEdgesForKey` above).
  public getIpcChannel(
    keyOrQualifiedName: string,
    repoId?: string,
  ): {
    channel: {
      qualifiedName: string;
      filePath: string;
      signature: string | null;
      line: number;
    } | null;
    handlers: SymbolLocation[];
    invokers: SymbolLocation[];
    ambiguousCount: number;
    ambiguousLookup?: 'key' | 'signature-value';
    unresolvedCallSiteCount: number;
  } {
    const empty = {
      channel: null,
      handlers: [],
      invokers: [],
      ambiguousCount: 0,
      unresolvedCallSiteCount: 0,
    };
    let channelId: string;
    if (keyOrQualifiedName.includes('::')) {
      const id = this.symbolIdFor(
        canonicalQualifiedName(keyOrQualifiedName),
        repoId,
      );
      if (id === null) {
        return empty;
      }
      channelId = id;
    } else {
      const keyCandidates = this.ipcChannelSymbolIdsForKey(
        keyOrQualifiedName,
        repoId,
      );
      if (keyCandidates.length > 1) {
        return {
          ...empty,
          ambiguousCount: keyCandidates.length,
          ambiguousLookup: 'key',
        };
      }
      if (keyCandidates.length === 1) {
        channelId = keyCandidates[0];
      } else {
        const signatureCandidates = this.ipcChannelSymbolIdsForSignature(
          keyOrQualifiedName,
          repoId,
        );
        if (signatureCandidates.length === 0) {
          return empty;
        }
        if (signatureCandidates.length > 1) {
          return {
            ...empty,
            ambiguousCount: signatureCandidates.length,
            ambiguousLookup: 'signature-value',
          };
        }
        channelId = signatureCandidates[0];
      }
    }

    const row = this.db
      .prepare(
        `SELECT s.qualified_name, s.name, s.repository_id, f.relative_path, s.signature, s.line_start
         FROM symbols s
         JOIN files f ON f.id = s.file_id
         WHERE s.id = ? AND s.kind = 'ipc_channel'`,
      )
      .get(channelId);
    if (row === undefined) {
      // Either the id doesn't exist (shouldn't happen -- it came from a
      // query against this same db), or (the qualified-name path only) it
      // resolved to a real symbol that isn't an ipc_channel.
      return empty;
    }
    const channelRow = requireRow(row);
    const channel = {
      qualifiedName: requireString(channelRow, 'qualified_name'),
      filePath: requireString(channelRow, 'relative_path'),
      signature: optionalString(channelRow, 'signature'),
      line: requireNumber(channelRow, 'line_start'),
    };
    const channelKey = requireString(channelRow, 'name');

    const handlers = this.db
      .prepare(
        `SELECT s.qualified_name, s.kind, f.relative_path, e.line
         FROM edges e
         JOIN symbols s ON s.id = e.source_symbol_id
         JOIN files f ON f.id = s.file_id
         WHERE e.kind = 'IPC_HANDLES' AND e.target_symbol_id = ?
         ORDER BY s.qualified_name`,
      )
      .all(channelId)
      .map(locationFromRow);

    const invokers = this.db
      .prepare(
        `SELECT s.qualified_name, s.kind, f.relative_path, e.line
         FROM edges e
         JOIN symbols s ON s.id = e.source_symbol_id
         JOIN files f ON f.id = s.file_id
         WHERE e.kind = 'IPC_INVOKES' AND e.target_symbol_id = ?
         ORDER BY s.qualified_name`,
      )
      .all(channelId)
      .map(locationFromRow);

    const unresolvedCallSiteCount = this.countUnresolvedIpcEdgesForKey(
      channelKey,
      // The channel's own repository row id -- NOT the optional request
      // repoId (see countUnresolvedIpcEdgesForKey's comment).
      requireString(channelRow, 'repository_id'),
    );

    return {
      channel,
      handlers,
      invokers,
      ambiguousCount: 0,
      unresolvedCallSiteCount,
    };
  }

  /**
   * Symbols that depend on `qualifiedName`, nearest first: a breadth-first
   * walk from the symbol and its direct children (depth 0) to the sources of
   * edges that target an already-reached symbol, up to `maxDepth`.
   *
   * Each reported symbol carries the length of the shortest walk of at least
   * one step that reaches it, so the symbol itself (or a child) appears when
   * a dependency cycle leads back to it. The walk stops after the first depth
   * that brings the result to `maxNodes`: every deeper symbol would sort
   * after it. Results are ordered by depth, qualified name, kind, then file
   * path; rows that agree on all four are reported once.
   */
  public getImpactRadius(
    qualifiedName: string,
    options?: { maxDepth?: number; maxNodes?: number },
    repoId?: string,
  ): Array<{
    qualifiedName: string;
    kind: string;
    filePath: string;
    depth: number;
  }> {
    const id = this.symbolIdFor(canonicalQualifiedName(qualifiedName), repoId);
    if (id === null) {
      return [];
    }
    const maxDepth = Math.max(1, Math.min(options?.maxDepth ?? 2, 5));
    const maxNodes = Math.max(1, Math.min(options?.maxNodes ?? 200, 1000));
    // Depth at which each id is expanded (its shortest distance from a seed).
    const expandedAt = new Map<string, number>([[id, 0]]);
    for (const value of this.db
      .prepare('SELECT id FROM symbols WHERE parent_symbol_id = ?')
      .all(id)) {
      expandedAt.set(requireString(requireRow(value), 'id'), 0);
    }
    // Shortest walk of at least one step to each reached id.
    const reachedAt = new Map<string, number>();
    const dependents = this.db.prepare(
      `SELECT DISTINCT e.source_symbol_id AS id
       FROM edges e
       WHERE e.target_symbol_id IN (SELECT value FROM json_each(?))
         AND e.source_symbol_id IS NOT NULL
         -- TESTED_BY is stored source=tested-symbol, target=test-file-symbol.
         -- Walking target→source here would pull sibling symbols of a shared
         -- test file into the impact set, so it is intentionally excluded.
         -- DOCUMENTS is included: a doc_section/file that documents a
         -- changed file IS impacted by that change (its content may now be
         -- stale), mirroring the code-reference kinds above.
         -- IPC_INVOKES is included: an invoker (a renderer/preload caller
         -- of window.api.<channel>) genuinely depends on the ipc_channel
         -- symbol's contract, so it IS impacted when that channel changes.
         -- USES_PIPELINE_ACTION is included: a workflow_job that
         -- references a pipeline action IS impacted when that action
         -- changes. Phase 6's resolve/workflow-action-resolver.ts resolves
         -- LOCAL 'uses: ./path' refs to a real action.yml or action.yaml
         -- file symbol, so this walk is LIVE for those edges; EXTERNAL refs
         -- (owner/repo@ref, docker://...) never resolve, so they never
         -- match here.
         -- IPC_HANDLES is deliberately EXCLUDED: the handler IS
         -- the channel's implementation, so its own edits already surface
         -- by running impact analysis starting from the handler symbol
         -- itself — walking channel -> handler here would treat the
         -- implementation as merely "impacted" by its own contract,
         -- inverting the real dependency direction.
         AND e.kind IN ('CALLS', 'IMPORTS_FROM', 'REFERENCES', 'DOCUMENTS', 'IPC_INVOKES', 'USES_PIPELINE_ACTION')`,
    );
    // Reached ids that name an existing symbol in an existing file, as the
    // distinct rows the result reports.
    const reportedRowCount = this.db.prepare(
      `SELECT COUNT(*) AS n FROM (
         SELECT DISTINCT s.qualified_name, s.kind, f.relative_path, j.value
         FROM json_each(?) j
         JOIN symbols s ON s.id = j.key
         JOIN files f ON f.id = s.file_id
       )`,
    );
    let frontier = Array.from(expandedAt.keys());
    for (let depth = 0; depth < maxDepth && frontier.length > 0; depth += 1) {
      const next: string[] = [];
      for (const value of dependents.all(JSON.stringify(frontier))) {
        const dependent = requireString(requireRow(value), 'id');
        if (!reachedAt.has(dependent)) reachedAt.set(dependent, depth + 1);
        if (!expandedAt.has(dependent)) {
          expandedAt.set(dependent, depth + 1);
          next.push(dependent);
        }
      }
      // Every id within depth + 1 is now known with its final depth.
      if (
        requireNumber(
          requireRow(
            reportedRowCount.get(JSON.stringify(Object.fromEntries(reachedAt))),
          ),
          'n',
        ) >= maxNodes
      ) {
        break;
      }
      frontier = next;
    }
    return this.db
      .prepare(
        `SELECT DISTINCT s.qualified_name, s.kind, f.relative_path, j.value AS depth
         FROM json_each(?) j
         JOIN symbols s ON s.id = j.key
         JOIN files f ON f.id = s.file_id
         ORDER BY depth, s.qualified_name, s.kind, f.relative_path
         LIMIT ?`,
      )
      .all(JSON.stringify(Object.fromEntries(reachedAt)), maxNodes)
      .map((value) => {
        const row = requireRow(value);
        return {
          qualifiedName: requireString(row, 'qualified_name'),
          kind: requireString(row, 'kind'),
          filePath: requireString(row, 'relative_path'),
          depth: requireNumber(row, 'depth'),
        };
      });
  }

  // --- Derived analyses (Phase 6 Task 7): communities + flows + hubs -------
  //
  // These back the 'communities'/'flows'/'hubs' QueryCodeGraph modes, the
  // ExplainCodeSymbol community/flow enrichment, and the change-impact risk
  // formula's flow-participation/community-crossing terms. All delegate to
  // `derivedStore` (see constructor) rather than re-implementing its SQL.

  /** Top communities by size (see `CodeGraphStore.listCommunities`). */
  public listCommunities(
    repoId?: string,
    limit?: number,
  ): CodeGraphCommunityRecord[] {
    return this.derivedStore.listCommunities(repoId, limit);
  }

  /** Top flows by criticality (see `CodeGraphStore.listFlows`). */
  public listFlows(repoId?: string, limit?: number): CodeGraphFlowRecord[] {
    return this.derivedStore.listFlows(repoId, limit);
  }

  /** Every flow containing `qualifiedName`, most-critical-first (see
   * `CodeGraphStore.listFlowsForSymbol`). Resolves the symbol id the same
   * way every other by-qualified-name method here does; an unresolved
   * qualifiedName honestly returns `[]` rather than erroring. */
  public listFlowsForSymbol(
    qualifiedName: string,
    repoId?: string,
    limit?: number,
  ): CodeGraphFlowRecord[] {
    const id = this.symbolIdFor(canonicalQualifiedName(qualifiedName), repoId);
    if (id === null) {
      return [];
    }
    return this.derivedStore.listFlowsForSymbol(id, limit);
  }

  /** Top symbols by total edge degree (see `CodeGraphStore.listTopDegreeSymbols`).
   * NOT a derived-analysis read — available whenever the graph has edges at
   * all, independent of whether the derived-analysis phase has ever run. */
  public listTopDegreeSymbols(
    repoId?: string,
    limit?: number,
  ): CodeGraphSymbolDegreeSummary[] {
    return this.derivedStore.listTopDegreeSymbols(repoId, limit);
  }

  /** The community `qualifiedName` belongs to, or null (no derived data for
   * this repo, or the symbol was never placed in a community). See
   * `CodeGraphStore.getCommunityForSymbol`. */
  public getCommunityForSymbol(
    qualifiedName: string,
    repoId?: string,
  ): CodeGraphCommunityRecord | null {
    const id = this.symbolIdFor(canonicalQualifiedName(qualifiedName), repoId);
    if (id === null) {
      return null;
    }
    return this.derivedStore.getCommunityForSymbol(id);
  }

  /** Distinct caller symbols of `qualifiedName` whose community differs from
   * its own (see `CodeGraphStore.countCrossCommunityCallers`) — the risk
   * formula's community-crossing term. Honestly 0 when the qualifiedName
   * doesn't resolve, same as every other by-qualified-name method here. */
  public countCrossCommunityCallers(
    qualifiedName: string,
    repoId?: string,
  ): number {
    const id = this.symbolIdFor(canonicalQualifiedName(qualifiedName), repoId);
    if (id === null) {
      return 0;
    }
    return this.derivedStore.countCrossCommunityCallers(id);
  }

  /** Repo-scoped (or graph-wide, repoId omitted) community/flow row counts —
   * see `CodeGraphStore.getDerivedStats`. Used to distinguish "this specific
   * query/symbol has none" from "derived analysis was never computed for
   * this repo at all", so callers can append an honest note in the latter
   * case instead of conflating the two. Carries `stale: true` while those
   * rows were computed for an earlier build than the latest published one. */
  public getDerivedStats(repoId?: string): CodeGraphDerivedStats {
    const stats = this.derivedStore.getDerivedStats(repoId);
    return codeGraphDerivedState({
      ...this.derivedStore.getDerivedFreshness(),
      ...stats,
    }) === 'stale'
      ? { ...stats, stale: true }
      : stats;
  }
}
