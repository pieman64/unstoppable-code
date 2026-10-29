import type { Node, Tree } from 'web-tree-sitter';
import type {
  CodeGraphEdgeRecord,
  CodeGraphSymbolRecord,
} from '../../../types/code-graph';
import { edgeRowId, fileQualifiedName, symbolRowId } from '../ids';

// Extracts Canopy-specific structural facts that generic tags-query
// extraction (tags-extractor.ts) can't see: the IPC contract surface
// (channel-registry declarations -- IPC_CHANNELS plus the whole `*_CHANNELS`
// constants family -- and handler/invoker call sites) and the Canopy-injected
// MCP tool registry. Rides the same `onTree` hook rationale.ts uses (see the
// comment on `ExtractFileInput.onTree` in tags-extractor.ts) so it reuses the
// SAME parse and the SAME in-progress definitions list -- no reparse, no
// second pass over the file.

export interface ExtractCanopyPatternsInput {
  tree: Tree;
  source: string;
  repoId: string;
  relativePath: string;
  fileId: string;
  fileSymbolId: string;
  // Definitions extracted so far for this file (same shape/contract as
  // ExtractRationaleInput.definitions -- see tags-extractor.ts).
  definitions: readonly CodeGraphSymbolRecord[];
}

export interface ExtractCanopyPatternsResult {
  symbols: CodeGraphSymbolRecord[];
  edges: CodeGraphEdgeRecord[];
  // Count of IPC_CHANNELS properties dropped beyond IPC_CHANNEL_MAX_PER_FILE,
  // in source order. Zero when under the cap. There is no cap on handler /
  // invoker edges or on tool-registry entries -- see the comments at each
  // extraction pass below for why.
  truncatedFacts: number;
}

// A file's combined channel-registry declarations are capped at this many
// entries; any surplus (in registry-scan-then-source order) is dropped and
// reported via `truncatedFacts`, mirroring RATIONALE_MAX_PER_FILE /
// MAX_PACKAGE_ENTRIES in rationale.ts / manifest-extractors.ts. The real
// IPC_CHANNELS object today has a few hundred entries and the secondary
// registries a couple dozen combined, so this is generous headroom, not a
// realistic limit.
export const IPC_CHANNEL_MAX_PER_FILE = 1000;

// Channel-registry declaration gate (P6, generalized from the single literal
// `IPC_CHANNELS`): any top-level `export const <NAME> = {...}` whose <NAME>
// matches CHANNEL_REGISTRY_NAME_PATTERN is a channel registry. This covers
// Canopy's whole `*_CHANNELS` family (IPC_CHANNELS in types.ts plus
// SKILLS_CHANNELS / PLUGINS_CHANNELS / PIPELINE_CHANNELS / ... in
// packages/desktop-shared/src/constants/), each declared in exactly one file
// -- the per-name ownership invariant this module enforces. The SCAN regex is
// the content-level pre-check run before any AST walk: names it captures are
// then verified against the real declarator by `namedObjectDeclarationValue`,
// so a match inside a comment or string is harmless (it finds no declarator
// and extracts nothing), exactly like the old substring gate. A file whose
// source never spells `export const <NAME>_CHANNELS` literally cannot
// contain such a top-level declarator either, so every other file in a build
// skips the AST search entirely.
const CHANNEL_REGISTRY_NAME_PATTERN = /^[A-Z][A-Z0-9_]*_CHANNELS$/;
// Cheap substring pre-check for BOTH the declaration scan and the
// handler/invoker member-expression pass: every registry name ends in this.
const CHANNEL_REGISTRY_MARKER = '_CHANNELS';

// `CANOPY_INJECTED_TOOL_REGISTRY` is declared in exactly one file across the
// whole corpus (same ownership invariant), so its pre-check stays a plain
// substring gate.
const TOOL_REGISTRY_DECLARATION_MARKER = 'CANOPY_INJECTED_TOOL_REGISTRY';
const TOOL_REGISTRY_OBJECT_NAME = 'CANOPY_INJECTED_TOOL_REGISTRY';

// Registry constant names declared in `source`, deduped, in first-appearance
// order. Captured names satisfy CHANNEL_REGISTRY_NAME_PATTERN by
// construction (the scan regex's capture group is the same character class
// plus suffix). The /g regex is function-local because `exec` looping is
// stateful (lastIndex); a shared module-level instance would break under
// reentrancy.
function channelRegistryNamesIn(source: string): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  const scan = /export const ([A-Z][A-Z0-9_]*_CHANNELS)\b/g;
  let match = scan.exec(source);
  while (match !== null) {
    const name: string | undefined = match[1];
    if (name !== undefined && !seen.has(name)) {
      seen.add(name);
      names.push(name);
    }
    match = scan.exec(source);
  }
  return names;
}

// Unwraps `expr as const` / `expr as T` / `expr satisfies T` down to the
// wrapped expression. The REAL IPC_CHANNELS declaration ends with
// `} as const;`, which makes the declarator's `value` field an
// `as_expression` whose first named child is the object literal (verified by
// live parse against the vendored typescript grammar) -- checking
// `value.type === 'object'` directly would silently extract zero channels
// from the real file. `satisfies_expression` is included for the same
// unwrap-to-the-real-expression reason, even though no current declaration
// uses it.
function unwrapTypeAssertions(node: Node): Node {
  let current = node;
  while (
    current.type === 'as_expression' ||
    current.type === 'satisfies_expression'
  ) {
    const inner: Node | undefined = current.namedChildren[0];
    if (inner === undefined) {
      return current;
    }
    current = inner;
  }
  return current;
}

// Wrapper node types a top-level `const <name> = {...}` declarator sits
// inside on its way up to the Program root: the declaration itself
// (`lexical_declaration` for `const`/`let`, `variable_declaration` for `var`)
// and, when exported, the enclosing `export_statement`. Any OTHER ancestor
// type encountered before reaching the root (e.g. `statement_block`,
// `function_declaration`) means the declarator is nested inside a function/
// block -- a shadowing local, not the module-level declaration this module's
// ownership invariant assumes.
const TOP_LEVEL_DECLARATOR_WRAPPER_TYPES = new Set([
  'lexical_declaration',
  'variable_declaration',
  'export_statement',
]);

// True when `declarator`'s ancestor chain reaches the tree's Program root
// through ONLY the wrapper types above -- i.e. it is a top-level (optionally
// exported) declaration, not a local shadowing the same name inside a
// function/block. `descendantsOfType` walks the WHOLE tree in document
// order, so without this guard a function-scoped `const IPC_CHANNELS = {...}`
// that happens to appear earlier in the file than the real top-level
// declaration would be picked up instead (or as well as) the real one.
function isTopLevelDeclarator(declarator: Node, root: Node): boolean {
  let current: Node | null = declarator.parent;
  while (current !== null && !current.equals(root)) {
    if (!TOP_LEVEL_DECLARATOR_WRAPPER_TYPES.has(current.type)) {
      return false;
    }
    current = current.parent;
  }
  return current !== null;
}

// Finds a top-level (optionally exported) `const <name> = { ... }` and
// returns the object literal (the declarator's `value` field, unwrapped
// through `as const` / `satisfies` assertions), or null if no such
// declarator exists or its value isn't an object literal. A type annotation
// on the declarator (`const <name>: Record<...> = { ... }`, the real
// tool-registry shape) sits in the declarator's separate `type` field and
// never affects the `value` lookup. A same-named declarator nested inside a
// function/block (a shadowing local) is rejected by `isTopLevelDeclarator`
// regardless of where it falls in document order. Only the first
// (document-order) top-level match is returned -- both patterns this module
// cares about are declared exactly once per file in the real codebase, and
// the caller has already gated on a source-text pre-check before calling
// this.
function namedObjectDeclarationValue(tree: Tree, name: string): Node | null {
  for (const declarator of tree.rootNode.descendantsOfType(
    'variable_declarator',
  )) {
    const nameNode = declarator.childForFieldName('name');
    if (nameNode === null || nameNode.text !== name) {
      continue;
    }
    if (!isTopLevelDeclarator(declarator, tree.rootNode)) {
      continue;
    }
    const valueNode = declarator.childForFieldName('value');
    if (valueNode === null) {
      continue;
    }
    const unwrapped = unwrapTypeAssertions(valueNode);
    if (unwrapped.type === 'object') {
      return unwrapped;
    }
  }
  return null;
}

// A string-literal property value's unquoted text, e.g. `'foo:bar'` ->
// `foo:bar`. Mirrors imports.ts's `sourceSpecifier` use of `string_fragment`.
function stringFragmentText(node: Node): string | null {
  const fragment = node.descendantsOfType('string_fragment')[0];
  return fragment === undefined ? null : fragment.text;
}

interface RawChannelDeclaration {
  key: string;
  line: number;
  byteStart: number;
  byteEnd: number;
  signature: string | null;
}

// Every `pair` child of a channel-registry object literal whose value is a
// string literal. Interleaved `comment` nodes (a JSDoc block above an
// individual channel, as in the real IPC_CHANNELS file; section-divider
// comments, as in the real skill-channels.ts) and any non-`pair` child are
// skipped by the type check alone -- no separate filter needed.
function collectChannelDeclarations(objectNode: Node): RawChannelDeclaration[] {
  const results: RawChannelDeclaration[] = [];
  for (const pair of objectNode.namedChildren) {
    if (pair.type !== 'pair') {
      continue;
    }
    const keyNode = pair.childForFieldName('key');
    const valueNode = pair.childForFieldName('value');
    if (keyNode === null || valueNode === null || valueNode.type !== 'string') {
      continue; // every real IPC_CHANNELS entry is `key: 'string-literal'`
    }
    results.push({
      key: keyNode.text,
      // `line` is the property's own (key) line, matching the contract even
      // when the string value wraps onto the following line (as
      // `activityReadWorkflowAgentTranscript` does in the real file).
      line: pair.startPosition.row + 1,
      byteStart: pair.startIndex,
      byteEnd: pair.endIndex,
      signature: stringFragmentText(valueNode),
    });
  }
  return results;
}

function extractChannelDeclarations(input: {
  tree: Tree;
  source: string;
  repoId: string;
  relativePath: string;
  fileId: string;
}): { symbols: CodeGraphSymbolRecord[]; truncatedFacts: number } {
  const collected: Array<RawChannelDeclaration & { registry: string }> = [];
  const seenKeys = new Set<string>();
  for (const registry of channelRegistryNamesIn(input.source)) {
    const objectNode = namedObjectDeclarationValue(input.tree, registry);
    if (objectNode === null) {
      continue; // scan hit a comment/string, or the value isn't an object literal
    }
    for (const channel of collectChannelDeclarations(objectNode)) {
      // Same-file duplicate keys (across registries, or repeated within one)
      // would share the qualified name `${rel}::ipc.<key>` and therefore the
      // same symbol row id -- keep the FIRST in declaration-scan order
      // rather than letting the store's INSERT OR REPLACE silently keep
      // whichever landed last. Cross-FILE duplicates are a different story:
      // they produce distinct symbols and resolve/ipc-resolver.ts treats
      // them as an honest ambiguity.
      if (seenKeys.has(channel.key)) {
        continue;
      }
      seenKeys.add(channel.key);
      collected.push({ ...channel, registry });
    }
  }
  const truncatedFacts = Math.max(
    0,
    collected.length - IPC_CHANNEL_MAX_PER_FILE,
  );
  const retained = collected.slice(0, IPC_CHANNEL_MAX_PER_FILE);
  const symbols: CodeGraphSymbolRecord[] = retained.map((channel) => {
    const qualifiedName = `${fileQualifiedName(input.relativePath)}::ipc.${channel.key}`;
    return {
      id: symbolRowId(input.repoId, qualifiedName),
      repositoryId: input.repoId,
      fileId: input.fileId,
      kind: 'ipc_channel',
      name: channel.key,
      qualifiedName,
      parentSymbolId: null,
      lineStart: channel.line,
      lineEnd: channel.line,
      byteStart: channel.byteStart,
      byteEnd: channel.byteEnd,
      signature: channel.signature,
      exported: false,
      isTest: false,
      // Which registry constant declared this channel -- the symbol shape is
      // otherwise registry-agnostic (kind/qualifiedName do not encode it).
      extra: { registry: channel.registry },
    };
  });
  return { symbols, truncatedFacts };
}

interface RawToolRegistryEntry {
  key: string;
  line: number;
  byteStart: number;
  byteEnd: number;
  displayName: string | null;
}

// Reads the `displayName` field out of a single registry entry's nested
// object literal, e.g. `{ canonicalKey: '...', displayName: 'AskUserQuestion', ... }`.
function displayNameOf(entryObject: Node): string | null {
  for (const pair of entryObject.namedChildren) {
    if (pair.type !== 'pair') {
      continue;
    }
    const keyNode = pair.childForFieldName('key');
    if (keyNode === null || keyNode.text !== 'displayName') {
      continue;
    }
    const valueNode = pair.childForFieldName('value');
    if (valueNode === null || valueNode.type !== 'string') {
      return null;
    }
    return stringFragmentText(valueNode);
  }
  return null;
}

function collectToolRegistryEntries(objectNode: Node): RawToolRegistryEntry[] {
  const results: RawToolRegistryEntry[] = [];
  for (const pair of objectNode.namedChildren) {
    if (pair.type !== 'pair') {
      continue;
    }
    const keyNode = pair.childForFieldName('key');
    const valueNode = pair.childForFieldName('value');
    if (keyNode === null || valueNode === null || valueNode.type !== 'object') {
      continue; // every real registry entry is `key: { ... }`
    }
    results.push({
      key: keyNode.text,
      line: pair.startPosition.row + 1,
      byteStart: pair.startIndex,
      byteEnd: pair.endIndex,
      displayName: displayNameOf(valueNode),
    });
  }
  return results;
}

// No cap here, unlike channel declarations: the contract's cap-1000 rule is
// scoped to the "Channel declarations" pattern only.
// CANOPY_INJECTED_TOOL_REGISTRY is a small, hand-maintained, source-bounded
// map (under twenty entries as of this writing) with no realistic path to
// unbounded growth the way a generated/aggregated fact list would have, so
// no truncation bookkeeping is needed for it.
function extractToolRegistryDeclarations(input: {
  tree: Tree;
  repoId: string;
  relativePath: string;
  fileId: string;
  fileSymbolId: string;
}): { symbols: CodeGraphSymbolRecord[]; edges: CodeGraphEdgeRecord[] } {
  const objectNode = namedObjectDeclarationValue(
    input.tree,
    TOOL_REGISTRY_OBJECT_NAME,
  );
  if (objectNode === null) {
    return { symbols: [], edges: [] };
  }
  const entries = collectToolRegistryEntries(objectNode);
  const symbols: CodeGraphSymbolRecord[] = [];
  const edges: CodeGraphEdgeRecord[] = [];
  for (const entry of entries) {
    const qualifiedName = `${fileQualifiedName(input.relativePath)}::tool.${entry.key}`;
    const symbol: CodeGraphSymbolRecord = {
      id: symbolRowId(input.repoId, qualifiedName),
      repositoryId: input.repoId,
      fileId: input.fileId,
      kind: 'mcp_tool',
      name: entry.key,
      qualifiedName,
      parentSymbolId: null,
      lineStart: entry.line,
      lineEnd: entry.line,
      byteStart: entry.byteStart,
      byteEnd: entry.byteEnd,
      signature: entry.displayName,
      exported: false,
      isTest: false,
      extra: {},
    };
    symbols.push(symbol);
    // Structural: the file symbol always declares its own registry entries,
    // fully known at extraction time -- same shape as CONTAINS or
    // DECLARES_SCRIPT/DECLARES_DEPENDENCY, not a name reference that needs a
    // later resolver pass.
    edges.push({
      id: edgeRowId({
        repoId: input.repoId,
        kind: 'DECLARES_MCP_TOOL',
        sourceId: input.fileSymbolId,
        target: symbol.id,
        line: entry.line,
      }),
      repositoryId: input.repoId,
      kind: 'DECLARES_MCP_TOOL',
      sourceSymbolId: input.fileSymbolId,
      targetSymbolId: symbol.id,
      sourceFileId: input.fileId,
      targetRef: null,
      line: entry.line,
      confidenceTier: 'EXTRACTED',
      confidenceScore: 1.0,
      resolverId: null,
      evidence: {},
    });
  }
  return { symbols, edges };
}

// ---- handler / invoker call-site edges (any file, no source-contains gate) ----

function isHandlerCalleeText(text: string): boolean {
  return text === 'registerIpcHandler' || text.endsWith('ipcMain.handle');
}

function isInvokerCalleeText(text: string): boolean {
  return (
    text.endsWith('ipcRenderer.invoke') ||
    text.endsWith('ipcRenderer.send') ||
    text.endsWith('ipcRenderer.on')
  );
}

// Mirrors tags-extractor.ts's `enclosingSymbolForLine` / rationale.ts's
// containment branch of `resolveTargetSymbolId`: the innermost definition
// whose line range contains `line` (largest byteStart wins the tie-break for
// nested definitions), or the file symbol when nothing contains it. Unlike
// rationale's "nearest following definition" fallback, call/reference sites
// only need containment -- a call expression is always textually inside
// whatever function/method/class encloses it, never merely adjacent to one.
function enclosingSymbolId(
  definitions: readonly CodeGraphSymbolRecord[],
  fileSymbolId: string,
  line: number,
): string {
  let containing: CodeGraphSymbolRecord | null = null;
  for (const definition of definitions) {
    if (definition.lineStart <= line && line <= definition.lineEnd) {
      if (containing === null || definition.byteStart >= containing.byteStart) {
        containing = definition;
      }
    }
  }
  return containing === null ? fileSymbolId : containing.id;
}

// The `<key>` and registry name in `<NAME>_CHANNELS.<key>` when `node` is
// exactly that member-expression shape (object = a bare identifier matching
// CHANNEL_REGISTRY_NAME_PATTERN), or null otherwise. A
// `subscript_expression` (computed access, `<NAME>_CHANNELS[expr]`) is a
// different tree-sitter node type entirely, so it falls through this type
// check without any special case -- this IS the "computed access is skipped"
// rule from the contract, enforced structurally rather than by an explicit
// branch.
function channelRegistryMemberKey(
  node: Node,
): { key: string; registry: string } | null {
  if (node.type !== 'member_expression') {
    return null;
  }
  const object = node.childForFieldName('object');
  const property = node.childForFieldName('property');
  if (object === null || property === null) {
    return null;
  }
  if (!CHANNEL_REGISTRY_NAME_PATTERN.test(object.text)) {
    return null;
  }
  return { key: property.text, registry: object.text };
}

function extractHandlerAndInvokerEdges(input: {
  tree: Tree;
  source: string;
  repoId: string;
  fileId: string;
  fileSymbolId: string;
  definitions: readonly CodeGraphSymbolRecord[];
}): CodeGraphEdgeRecord[] {
  // Cheap pre-check: every channel-registry name ends in the literal
  // substring "_CHANNELS", so a file without it cannot contain a
  // member_expression whose object matches CHANNEL_REGISTRY_NAME_PATTERN --
  // walking every call_expression in the tree would find zero matches
  // anyway. This is a pure performance short-circuit (same outcome as
  // walking and finding nothing) -- unlike the declaration gates above, this
  // pattern itself is NOT scoped to registry-owning files; it deliberately
  // runs in ANY file per the contract ("Skip rules: none beyond the
  // source-contains gates" applies only to the symbol-producing passes
  // above).
  if (!input.source.includes(CHANNEL_REGISTRY_MARKER)) {
    return [];
  }
  const edges: CodeGraphEdgeRecord[] = [];
  for (const call of input.tree.rootNode.descendantsOfType('call_expression')) {
    const calleeNode = call.childForFieldName('function');
    if (calleeNode === null) {
      continue;
    }
    const calleeText = calleeNode.text;
    let kind: 'IPC_HANDLES' | 'IPC_INVOKES' | null = null;
    if (isHandlerCalleeText(calleeText)) {
      kind = 'IPC_HANDLES';
    } else if (isInvokerCalleeText(calleeText)) {
      kind = 'IPC_INVOKES';
    }
    if (kind === null) {
      continue;
    }
    const argumentsNode = call.childForFieldName('arguments');
    const firstArg = argumentsNode?.namedChildren[0] ?? null;
    if (firstArg === null) {
      continue;
    }
    const member = channelRegistryMemberKey(firstArg);
    if (member === null) {
      continue; // computed access (<NAME>_CHANNELS[expr]) or unrelated first arg
    }
    const line = call.startPosition.row + 1;
    const sourceSymbolId = enclosingSymbolId(
      input.definitions,
      input.fileSymbolId,
      line,
    );
    // Registry-agnostic keying (`ipc:<key>`, not `ipc:<registry>.<key>`):
    // resolve/ipc-resolver.ts binds by bare key, so a key collision ACROSS
    // registries in one repo is honestly ambiguous there, same as a
    // same-registry duplicate. The registry the call site actually
    // referenced is preserved in evidence.
    const targetRef = `ipc:${member.key}`;
    edges.push({
      id: edgeRowId({
        repoId: input.repoId,
        kind,
        sourceId: sourceSymbolId,
        target: targetRef,
        line,
      }),
      repositoryId: input.repoId,
      kind,
      sourceSymbolId,
      targetSymbolId: null,
      sourceFileId: input.fileId,
      targetRef,
      line,
      confidenceTier: 'EXTRACTED',
      confidenceScore: 1.0,
      resolverId: null,
      evidence: { callee: calleeText, registry: member.registry },
    });
  }
  return edges;
}

export function extractCanopyPatterns(
  input: ExtractCanopyPatternsInput,
): ExtractCanopyPatternsResult {
  const symbols: CodeGraphSymbolRecord[] = [];
  const edges: CodeGraphEdgeRecord[] = [];
  let truncatedFacts = 0;

  if (input.source.includes(CHANNEL_REGISTRY_MARKER)) {
    const channels = extractChannelDeclarations({
      tree: input.tree,
      source: input.source,
      repoId: input.repoId,
      relativePath: input.relativePath,
      fileId: input.fileId,
    });
    symbols.push(...channels.symbols);
    truncatedFacts += channels.truncatedFacts;
  }

  if (input.source.includes(TOOL_REGISTRY_DECLARATION_MARKER)) {
    const tools = extractToolRegistryDeclarations({
      tree: input.tree,
      repoId: input.repoId,
      relativePath: input.relativePath,
      fileId: input.fileId,
      fileSymbolId: input.fileSymbolId,
    });
    symbols.push(...tools.symbols);
    edges.push(...tools.edges);
  }

  edges.push(
    ...extractHandlerAndInvokerEdges({
      tree: input.tree,
      source: input.source,
      repoId: input.repoId,
      fileId: input.fileId,
      fileSymbolId: input.fileSymbolId,
      definitions: input.definitions,
    }),
  );

  return { symbols, edges, truncatedFacts };
}
