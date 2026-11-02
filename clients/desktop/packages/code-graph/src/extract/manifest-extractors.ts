import type * as TsModule from 'typescript';
import { loadRequiredNodeModule } from '../node-module-loader';
import type {
  CodeGraphEdgeKind,
  CodeGraphEdgeRecord,
  CodeGraphFileFacts,
  CodeGraphFileRecord,
  CodeGraphSymbolKind,
  CodeGraphSymbolRecord,
} from '../types/code-graph';
import {
  edgeRowId,
  fileQualifiedName,
  fileRowId,
  symbolQualifiedName,
  symbolRowId,
} from '../ids';
import { isRecord } from '../store/database';
import type { NonCodeExtractorInput } from './extractor-registry';
import { isTestFilePath } from './tags-extractor';

type ConfigParser = Pick<
  typeof TsModule,
  'parseConfigFileTextToJson' | 'flattenDiagnosticMessageText'
>;
let configParser: ConfigParser | undefined;

function getConfigParser(): ConfigParser {
  // Importing the engine (including a verified no-op update) must not load the
  // compiler. Use the packaged loader so the CLI's SEA runtime works too.
  configParser ??= loadRequiredNodeModule<ConfigParser>({
    moduleId: 'typescript',
    requireFrom: __filename,
    validate: (value): value is ConfigParser =>
      isRecord(value) &&
      typeof value.parseConfigFileTextToJson === 'function' &&
      typeof value.flattenDiagnosticMessageText === 'function',
  });
  return configParser;
}

// Real (Task 5) extractors for the three JSON manifest kinds routed by
// `extractor-registry.ts`: package.json, tsconfig*.json, and .mcp.json/
// mcp.json. All three share the same shape of work: parse the JSON body
// (throwing on syntax errors so the engine's existing failed-file path takes
// over — see `buildFailedNonCodeFileFacts` in `../engine.ts`), narrow the
// parsed value with `isRecord` (never a cast), and emit a small number of
// cheap-but-honest child symbols/edges. None of these extractors touch
// `input.runtime` — they never need web-tree-sitter.

function basenameOf(relativePath: string): string {
  return relativePath.split('/').pop() ?? relativePath;
}

// `isRecord` deliberately passes arrays (`typeof [] === 'object'`), but every
// manifest block these extractors walk with Object.entries/Object.keys —
// scripts, dependency groups, mcpServers, a server's env, compilerOptions,
// paths — is only meaningful as a plain key→value object. An array there is
// nonsense input whose numeric indices would otherwise be extracted as entry
// names, so reject arrays explicitly.
function isNonArrayRecord(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && !Array.isArray(value);
}

function lineCountOf(source: string): number {
  return Math.max(1, source.split('\n').length);
}

// Every manifest extractor throws a real `Error` (never a literal) on a JSON
// syntax error. The engine's non-code processing path (Task 3) already
// catches extractor throws and persists a `parseStatus: 'failed'` file
// record + failure count, so this is the ONLY error-signaling contract these
// extractors need to honor.
function parseJsonOrThrow(source: string, relativePath: string): unknown {
  try {
    return JSON.parse(source);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to parse JSON in "${relativePath}": ${message}`);
  }
}

function buildFileSymbol(input: NonCodeExtractorInput): CodeGraphSymbolRecord {
  const fileId = fileRowId(input.repoId, input.relativePath);
  const qualifiedName = fileQualifiedName(input.relativePath);
  return {
    id: symbolRowId(input.repoId, qualifiedName),
    repositoryId: input.repoId,
    fileId,
    kind: 'file',
    name: basenameOf(input.relativePath),
    qualifiedName,
    parentSymbolId: null,
    lineStart: 1,
    lineEnd: lineCountOf(input.source),
    byteStart: 0,
    byteEnd: input.sizeBytes,
    signature: null,
    exported: false,
    isTest: isTestFilePath(input.relativePath),
    extra: {},
  };
}

function buildFileRecord(
  extractorId: string,
  input: NonCodeExtractorInput,
): CodeGraphFileRecord {
  return {
    id: fileRowId(input.repoId, input.relativePath),
    repositoryId: input.repoId,
    relativePath: input.relativePath,
    absolutePath: input.absolutePath,
    language: extractorId,
    contentHash: input.contentHash,
    sizeBytes: input.sizeBytes,
    mtimeNs: input.mtimeNs,
    lineCount: lineCountOf(input.source),
    grammarId: extractorId,
    grammarAbi: null,
    parseStatus: 'parsed',
    hasErrors: false,
    updatedAt: Date.now(),
  };
}

function countNewlinesBefore(source: string, index: number): number {
  let count = 0;
  for (let i = 0; i < index; i += 1) {
    if (source.charCodeAt(i) === 10) {
      count += 1;
    }
  }
  return count;
}

// Cheap and honest line-number recovery: find the group key's own first
// occurrence in the raw source, then find the first occurrence of the
// entry's own quoted text AT OR AFTER that point, and count newlines before
// it. This is O(source length) per call and is documented as approximate —
// it can mis-locate a line only in pathological cases (e.g. a value string
// that happens to collide with an unrelated earlier occurrence of the same
// quoted text), which is an accepted trade-off for not re-parsing the JSON
// with a location-aware parser.
function approximateLineNumber(
  source: string,
  groupKey: string,
  needleText: string,
): number {
  const groupIndex = source.indexOf(`"${groupKey}"`);
  const searchStart = groupIndex === -1 ? 0 : groupIndex;
  const needleIndex = source.indexOf(`"${needleText}"`, searchStart);
  if (needleIndex === -1) {
    return 1;
  }
  return countNewlinesBefore(source, needleIndex) + 1;
}

function structuralEdge(input: {
  repoId: string;
  kind: CodeGraphEdgeKind;
  sourceFileId: string;
  sourceSymbolId: string;
  targetSymbolId: string;
  line: number | null;
}): CodeGraphEdgeRecord {
  return {
    id: edgeRowId({
      repoId: input.repoId,
      kind: input.kind,
      sourceId: input.sourceSymbolId,
      target: input.targetSymbolId,
      line: input.line,
    }),
    repositoryId: input.repoId,
    kind: input.kind,
    sourceSymbolId: input.sourceSymbolId,
    targetSymbolId: input.targetSymbolId,
    sourceFileId: input.sourceFileId,
    targetRef: null,
    line: input.line,
    confidenceTier: 'EXTRACTED',
    confidenceScore: 1.0,
    resolverId: null,
    evidence: {},
  };
}

// ---------------------------------------------------------------------------
// package.json
// ---------------------------------------------------------------------------

const MAX_PACKAGE_ENTRIES = 500;
const MAX_SCRIPT_SIGNATURE_LENGTH = 200;
const DEPENDENCY_GROUPS = [
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
] as const;

// One declaration edge to emit for a pending child symbol. A symbol may own
// more than one (a dependency listed in multiple groups), so the edge specs
// live on the pending entry rather than being derived one-per-symbol.
interface PendingEdgeSpec {
  kind: CodeGraphEdgeKind;
  line: number;
  evidence: Record<string, unknown>;
  // Extra id-hash input. Two DECLARES_DEPENDENCY edges from the same file
  // symbol to the same merged dependency symbol (one per group) can land on
  // the SAME approximate line (e.g. a single-line manifest), and `edgeRowId`
  // does not hash evidence — so without a discriminator their ids would
  // collide and INSERT OR REPLACE would silently drop one. `null` keeps the
  // plain `target = symbol.id` hash input (scripts, unchanged ids).
  idDiscriminator: string | null;
}

interface PendingChildSymbol {
  kind: CodeGraphSymbolKind;
  name: string;
  qualifiedName: string;
  signature: string | null;
  extra: Record<string, unknown>;
  line: number;
  edges: PendingEdgeSpec[];
}

function collectScriptEntries(
  relativePath: string,
  source: string,
  scriptsValue: unknown,
): PendingChildSymbol[] {
  if (!isNonArrayRecord(scriptsValue)) {
    return [];
  }
  const pending: PendingChildSymbol[] = [];
  for (const [name, value] of Object.entries(scriptsValue)) {
    if (typeof value !== 'string') {
      continue; // malformed script entry; not extractable as a command string
    }
    const line = approximateLineNumber(source, 'scripts', name);
    pending.push({
      kind: 'script',
      name,
      qualifiedName: symbolQualifiedName(relativePath, ['scripts'], name),
      signature: value.slice(0, MAX_SCRIPT_SIGNATURE_LENGTH),
      extra: {},
      line,
      edges: [
        { kind: 'DECLARES_SCRIPT', line, evidence: {}, idDiscriminator: null },
      ],
    });
  }
  return pending;
}

interface DependencyGroupOccurrence {
  group: string;
  range: string;
}

interface MergedDependency {
  name: string;
  qualifiedName: string;
  firstLine: number;
  groups: DependencyGroupOccurrence[];
  edges: PendingEdgeSpec[];
}

// The same package may legitimately appear in more than one dependency group
// (dependencies + devDependencies, peerDependencies + devDependencies for
// library authors, ...). The qualifiedName is `${rel}::deps.${name}`
// regardless of group, so emitting one symbol per (group, name) pair would
// produce id-colliding rows and the store's INSERT OR REPLACE would silently
// keep only the LAST group's metadata. Merge deliberately instead: ONE
// dependency symbol per package name whose `extra.groups` accumulates every
// group occurrence in DEPENDENCY_GROUPS order, plus one DECLARES_DEPENDENCY
// edge per group occurrence carrying `evidence.group`.
function collectDependencyEntries(
  relativePath: string,
  source: string,
  root: Record<string, unknown>,
): PendingChildSymbol[] {
  const merged = new Map<string, MergedDependency>();
  for (const group of DEPENDENCY_GROUPS) {
    const groupValue = root[group];
    if (!isNonArrayRecord(groupValue)) {
      continue;
    }
    for (const [name, value] of Object.entries(groupValue)) {
      if (typeof value !== 'string') {
        continue; // malformed dependency range; not extractable
      }
      const line = approximateLineNumber(source, group, name);
      const edge: PendingEdgeSpec = {
        kind: 'DECLARES_DEPENDENCY',
        line,
        evidence: { group },
        idDiscriminator: group,
      };
      const existing = merged.get(name);
      if (existing !== undefined) {
        existing.groups.push({ group, range: value });
        existing.edges.push(edge);
        continue;
      }
      merged.set(name, {
        name,
        qualifiedName: symbolQualifiedName(relativePath, ['deps'], name),
        firstLine: line,
        groups: [{ group, range: value }],
        edges: [edge],
      });
    }
  }
  return Array.from(merged.values()).map(
    (dependency): PendingChildSymbol => ({
      kind: 'dependency',
      name: dependency.name,
      qualifiedName: dependency.qualifiedName,
      signature: null,
      extra: { groups: dependency.groups },
      line: dependency.firstLine,
      edges: dependency.edges,
    }),
  );
}

// Root-level manifest children get parentSymbolId: null, exactly like
// top-level markdown doc_sections — the file relationship is carried by the
// DECLARES_SCRIPT/DECLARES_DEPENDENCY edge, not this field.
function buildPendingSymbolsAndEdges(
  repoId: string,
  fileId: string,
  fileSymbolId: string,
  pending: readonly PendingChildSymbol[],
): { symbols: CodeGraphSymbolRecord[]; edges: CodeGraphEdgeRecord[] } {
  const symbols: CodeGraphSymbolRecord[] = [];
  const edges: CodeGraphEdgeRecord[] = [];
  for (const item of pending) {
    const symbol: CodeGraphSymbolRecord = {
      id: symbolRowId(repoId, item.qualifiedName),
      repositoryId: repoId,
      fileId,
      kind: item.kind,
      name: item.name,
      qualifiedName: item.qualifiedName,
      parentSymbolId: null,
      lineStart: item.line,
      lineEnd: item.line,
      byteStart: 0,
      byteEnd: 0,
      signature: item.signature,
      exported: false,
      isTest: false,
      extra: item.extra,
    };
    symbols.push(symbol);
    for (const edgeSpec of item.edges) {
      const idTarget =
        edgeSpec.idDiscriminator === null
          ? symbol.id
          : `${symbol.id}#${edgeSpec.idDiscriminator}`;
      edges.push({
        id: edgeRowId({
          repoId,
          kind: edgeSpec.kind,
          sourceId: fileSymbolId,
          target: idTarget,
          line: edgeSpec.line,
        }),
        repositoryId: repoId,
        kind: edgeSpec.kind,
        sourceSymbolId: fileSymbolId,
        targetSymbolId: symbol.id,
        sourceFileId: fileId,
        targetRef: null,
        line: edgeSpec.line,
        confidenceTier: 'EXTRACTED',
        confidenceScore: 1.0,
        resolverId: null,
        evidence: edgeSpec.evidence,
      });
    }
  }
  return { symbols, edges };
}

export function extractPackageJsonFacts(
  input: NonCodeExtractorInput,
): CodeGraphFileFacts {
  const fileId = fileRowId(input.repoId, input.relativePath);
  const fileSymbol = buildFileSymbol(input);
  const parsed = parseJsonOrThrow(input.source, input.relativePath);
  const root: Record<string, unknown> = isNonArrayRecord(parsed) ? parsed : {};

  const pending = [
    ...collectScriptEntries(input.relativePath, input.source, root.scripts),
    ...collectDependencyEntries(input.relativePath, input.source, root),
  ];

  const truncatedFacts = Math.max(0, pending.length - MAX_PACKAGE_ENTRIES);
  const retained = pending.slice(0, MAX_PACKAGE_ENTRIES);
  if (truncatedFacts > 0) {
    fileSymbol.extra = { ...fileSymbol.extra, truncatedFacts };
  }

  const { symbols, edges } = buildPendingSymbolsAndEdges(
    input.repoId,
    fileId,
    fileSymbol.id,
    retained,
  );

  return {
    file: buildFileRecord('package-json', input),
    symbols: [fileSymbol, ...symbols],
    edges,
  };
}

// ---------------------------------------------------------------------------
// tsconfig*.json
// ---------------------------------------------------------------------------

function isRelativeExtendsPath(value: string): boolean {
  return value.startsWith('./') || value.startsWith('../');
}

// extra_json records `compilerOptions.paths` alias KEYS only (never the
// resolved glob arrays) and `references[].path` values.
function buildTsconfigExtra(
  root: Record<string, unknown>,
): Record<string, unknown> {
  const extra: Record<string, unknown> = {};

  const compilerOptionsValue = root.compilerOptions;
  if (isNonArrayRecord(compilerOptionsValue)) {
    const pathsValue = compilerOptionsValue.paths;
    if (isNonArrayRecord(pathsValue)) {
      const aliasKeys = Object.keys(pathsValue);
      if (aliasKeys.length > 0) {
        extra.pathsAliases = aliasKeys;
      }
    }
  }

  const referencesValue = root.references;
  if (Array.isArray(referencesValue)) {
    const referencePaths: string[] = [];
    for (const reference of referencesValue) {
      if (isNonArrayRecord(reference) && typeof reference.path === 'string') {
        referencePaths.push(reference.path);
      }
    }
    if (referencePaths.length > 0) {
      extra.references = referencePaths;
    }
  }

  return extra;
}

// Relative config inheritance is resolved after all repository facts are indexed.
function buildExtendsReferenceEdge(input: {
  repoId: string;
  fileId: string;
  configSymbolId: string;
  source: string;
  extendsValue: unknown;
}): CodeGraphEdgeRecord | null {
  const { extendsValue } = input;
  if (
    typeof extendsValue !== 'string' ||
    !isRelativeExtendsPath(extendsValue)
  ) {
    return null;
  }
  const line = approximateLineNumber(input.source, 'extends', extendsValue);
  return {
    id: edgeRowId({
      repoId: input.repoId,
      kind: 'REFERENCES',
      sourceId: input.configSymbolId,
      target: extendsValue,
      line,
    }),
    repositoryId: input.repoId,
    kind: 'REFERENCES',
    sourceSymbolId: input.configSymbolId,
    targetSymbolId: null,
    sourceFileId: input.fileId,
    targetRef: extendsValue,
    line,
    confidenceTier: 'EXTRACTED',
    confidenceScore: 1.0,
    resolverId: null,
    evidence: { raw: extendsValue, configExtends: true },
  };
}

export function extractTsconfigFacts(
  input: NonCodeExtractorInput,
): CodeGraphFileFacts {
  const fileId = fileRowId(input.repoId, input.relativePath);
  const fileSymbol = buildFileSymbol(input);
  const ts = getConfigParser();
  const parsedConfig = ts.parseConfigFileTextToJson(
    input.relativePath,
    input.source,
  );
  if (parsedConfig.error !== undefined)
    throw new Error(
      ts.flattenDiagnosticMessageText(parsedConfig.error.messageText, '\n'),
    );
  const parsed: unknown = parsedConfig.config;
  const root: Record<string, unknown> = isNonArrayRecord(parsed) ? parsed : {};

  const configQualifiedName = symbolQualifiedName(
    input.relativePath,
    [],
    'config',
  );
  const configSymbol: CodeGraphSymbolRecord = {
    id: symbolRowId(input.repoId, configQualifiedName),
    repositoryId: input.repoId,
    fileId,
    kind: 'config',
    name: basenameOf(input.relativePath),
    qualifiedName: configQualifiedName,
    parentSymbolId: null,
    lineStart: 1,
    lineEnd: fileSymbol.lineEnd,
    byteStart: 0,
    byteEnd: input.sizeBytes,
    signature: null,
    exported: false,
    isTest: false,
    extra: buildTsconfigExtra(root),
  };

  const edges: CodeGraphEdgeRecord[] = [
    structuralEdge({
      repoId: input.repoId,
      kind: 'CONFIGURES',
      sourceFileId: fileId,
      sourceSymbolId: fileSymbol.id,
      targetSymbolId: configSymbol.id,
      line: null,
    }),
  ];
  for (const extendsValue of Array.isArray(root.extends)
    ? root.extends
    : [root.extends]) {
    const extendsEdge = buildExtendsReferenceEdge({
      repoId: input.repoId,
      fileId,
      configSymbolId: configSymbol.id,
      source: input.source,
      extendsValue,
    });
    if (extendsEdge !== null) edges.push(extendsEdge);
  }

  return {
    file: buildFileRecord('tsconfig', input),
    symbols: [fileSymbol, configSymbol],
    edges,
  };
}

// ---------------------------------------------------------------------------
// .mcp.json / mcp.json
// ---------------------------------------------------------------------------

export function extractMcpConfigFacts(
  input: NonCodeExtractorInput,
): CodeGraphFileFacts {
  const fileId = fileRowId(input.repoId, input.relativePath);
  const fileSymbol = buildFileSymbol(input);
  const parsed = parseJsonOrThrow(input.source, input.relativePath);
  const root: Record<string, unknown> = isNonArrayRecord(parsed) ? parsed : {};

  const symbols: CodeGraphSymbolRecord[] = [fileSymbol];
  const edges: CodeGraphEdgeRecord[] = [];

  const serversValue = root.mcpServers;
  if (isNonArrayRecord(serversValue)) {
    for (const [name, value] of Object.entries(serversValue)) {
      if (!isNonArrayRecord(value)) {
        continue;
      }
      const qualifiedName = symbolQualifiedName(
        input.relativePath,
        ['servers'],
        name,
      );
      const line = approximateLineNumber(input.source, 'mcpServers', name);

      // Env var NAMES ONLY — never values. This is a hard rule: secrets in
      // `.mcp.json` `env` blocks (API keys, tokens) must never be persisted
      // into the graph store, even indirectly via `extra_json`.
      let envNames: string[] = [];
      const envValue = value.env;
      if (isNonArrayRecord(envValue)) {
        envNames = Object.keys(envValue);
      }
      const extra: Record<string, unknown> = { envNames };
      const commandValue = value.command;
      if (typeof commandValue === 'string') {
        extra.command = commandValue;
      }

      const symbol: CodeGraphSymbolRecord = {
        id: symbolRowId(input.repoId, qualifiedName),
        repositoryId: input.repoId,
        fileId,
        kind: 'config',
        name,
        qualifiedName,
        parentSymbolId: null,
        lineStart: line,
        lineEnd: line,
        byteStart: 0,
        byteEnd: 0,
        signature: null,
        exported: false,
        isTest: false,
        extra,
      };
      symbols.push(symbol);
      edges.push(
        structuralEdge({
          repoId: input.repoId,
          kind: 'CONFIGURES',
          sourceFileId: fileId,
          sourceSymbolId: fileSymbol.id,
          targetSymbolId: symbol.id,
          line,
        }),
      );
    }
  }

  return {
    file: buildFileRecord('mcp-config', input),
    symbols,
    edges,
  };
}
