/**
 * Draft for packages/code-graph/src/resolve/resolution-dependency-capture.ts
 *
 * Capture-only W3 module. It decorates the frozen W2 projection port without
 * changing its eleven methods, streams one source scope at a time to the
 * existing CodeGraphDatabase writer, and never keeps a repo-wide edge map.
 */
import type {
  CodeGraphConfidenceTier,
  CodeGraphEdgeKind,
  CodeGraphEdgeRecord,
  CodeGraphFileRecord,
  CodeGraphSymbolKind,
  CodeGraphSymbolRecord,
} from '../types/code-graph';
import type { ResolutionProjectionStore } from './resolution-projection';
import { canonicalRelativePath } from '../ids';

export type ResolutionDependencyJson =
  | null
  | boolean
  | number
  | string
  | readonly ResolutionDependencyJson[]
  | { readonly [key: string]: ResolutionDependencyJson };

export const RESOLUTION_CAPTURE_SCHEMA_VERSION = 5;
export const RESOLUTION_CAPTURE_FORMAT_VERSION = 1;
export const RESOLUTION_CAPTURE_MAX_SOURCE_FILE_IDS = 10_000;

export type ResolutionCaptureResolver =
  | 'ts-module-resolution'
  | 'config-extends'
  | 'doc-link'
  | 'ipc-channel'
  | 'workflow-action'
  | 'call-resolution'
  | 'test-linker';

export const RESOLUTION_CAPTURE_RESOLVERS: readonly ResolutionCaptureResolver[] =
  [
    'ts-module-resolution',
    'config-extends',
    'doc-link',
    'ipc-channel',
    'workflow-action',
    'call-resolution',
    'test-linker',
  ];

/** Increment only when the resolver's dependency meaning or coverage changes. */
export const RESOLUTION_CAPTURE_ALGORITHM_VERSIONS: Readonly<
  Record<ResolutionCaptureResolver, number>
> = {
  'ts-module-resolution': 1,
  'config-extends': 1,
  'doc-link': 1,
  'ipc-channel': 1,
  'workflow-action': 1,
  'call-resolution': 1,
  'test-linker': 1,
};

export type ResolutionDependencyKind =
  | 'ts-read-input'
  | 'ts-file-exists'
  | 'ts-directory-exists'
  | 'ts-read-directory'
  | 'ts-get-directories'
  | 'ts-realpath'
  | 'ts-current-directory'
  | 'ts-executing-file'
  | 'compiler-options'
  | 'source-lexical-facts'
  | 'module-specifier'
  | 'module-candidate'
  | 'module-import-set'
  | 'module-symbol-set'
  | 'export-candidate-set'
  | 'config-target'
  | 'doc-path-fragment'
  | 'ipc-channel-candidate-set'
  | 'workflow-action-disposition'
  | 'workflow-manifest-candidate-set'
  | 'test-call-candidate-set'
  | 'store-edge-query'
  | 'store-file'
  | 'store-symbol-qualified-name'
  | 'store-symbols-for-file'
  | 'store-symbols-by-kind-name'
  | 'store-test-call-targets'
  | 'capture-source-coverage';

export interface ResolutionDependencyKey {
  dependencyKind: ResolutionDependencyKind;
  dependencyKey: string;
}

export interface ResolutionDependencyObservation extends ResolutionDependencyKey {
  /** A JSON value; persistence serializes it with stable object-key ordering. */
  dependencyValue: ResolutionDependencyJson;
}

export interface ResolutionDependencySource {
  resolver: ResolutionCaptureResolver;
  sourceFileId: string;
  /** Empty for dependencies owned by a whole file rather than one edge. */
  sourceEdgeId: string;
}

export interface ResolutionDependencyRecord extends ResolutionDependencySource {
  /** Opaque repositories.id / repositoryRowId, never the public repo_id. */
  repositoryId: string;
  dependencyKind: ResolutionDependencyKind;
  dependencyKey: string;
  dependencyValue: ResolutionDependencyJson;
}

export interface ResolutionDependencyCaptureMetadata {
  schemaVersion: 5;
  captureVersion: 1;
  /** Exact configured repository root; copied roots invalidate the capture. */
  rootPath: string;
  complete: boolean;
  algorithmVersions: Readonly<Record<ResolutionCaptureResolver, number>>;
  incompleteResolvers: readonly ResolutionCaptureResolver[];
  reasonsByResolver: Readonly<
    Partial<Record<ResolutionCaptureResolver, readonly string[]>>
  >;
  dependencyCoverage: Readonly<
    Record<ResolutionCaptureResolver, ResolutionDependencyCoverage>
  >;
}

export interface ResolutionDependencyCoverage {
  rowCount: number;
  sourceCount: number;
  sha256: string;
}

export type ResolutionDependencyCaptureMetadataInput = Omit<
  ResolutionDependencyCaptureMetadata,
  'dependencyCoverage'
>;

/** Public repo_id is used only for graph_metadata; rows use repositoryRowId. */
export function resolutionDependencyCaptureMetadataKey(repoId: string): string {
  return `resolution_dependency_capture:${repoId}`;
}

export interface ResolutionDependencyWriter {
  beginResolver(
    repoId: string,
    resolver: ResolutionCaptureResolver,
    sourceFileIds: readonly string[] | undefined,
  ): void;
  replaceSource(
    repoId: string,
    source: ResolutionDependencySource,
    observations: readonly ResolutionDependencyObservation[],
  ): void;
  finishResolver(
    repoId: string,
    resolver: ResolutionCaptureResolver,
    sourceFileIds: readonly string[] | undefined,
  ): void;
  writeMetadata(
    repoId: string,
    metadata: ResolutionDependencyCaptureMetadataInput,
  ): ResolutionDependencyCaptureMetadata;
}

function keyPart(value: string): string {
  return encodeURIComponent(value);
}

function compareCodeUnits(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function keyParts(values: readonly string[]): string {
  return values.map(keyPart).join('/');
}

function relativePathPart(value: string): string {
  return canonicalRelativePath(value);
}

function address(
  dependencyKind: ResolutionDependencyKind,
  dependencyKey: string,
): ResolutionDependencyKey {
  return { dependencyKind, dependencyKey };
}

/**
 * Shared capture/invalidation key constructors. The closure producer must use
 * these same constructors for both old and new facts (including absent facts).
 */
export const resolutionDependencyKey = {
  tsReadInput(relativePath: string): ResolutionDependencyKey {
    return address('ts-read-input', relativePathPart(relativePath));
  },
  tsFileExists(relativePath: string): ResolutionDependencyKey {
    return address('ts-file-exists', relativePathPart(relativePath));
  },
  tsDirectoryExists(relativePath: string): ResolutionDependencyKey {
    return address('ts-directory-exists', relativePathPart(relativePath));
  },
  tsReadDirectory(input: {
    root: string;
    extensions: readonly string[] | null;
    excludes: readonly string[] | null;
    includes: readonly string[] | null;
    depth: number | null;
  }): ResolutionDependencyKey {
    return address(
      'ts-read-directory',
      keyParts([
        relativePathPart(input.root),
        JSON.stringify(input.extensions),
        JSON.stringify(input.excludes),
        JSON.stringify(input.includes),
        input.depth === null ? '' : String(input.depth),
      ]),
    );
  },
  tsGetDirectories(relativePath: string): ResolutionDependencyKey {
    return address('ts-get-directories', relativePathPart(relativePath));
  },
  tsRealpath(relativePath: string): ResolutionDependencyKey {
    return address('ts-realpath', relativePathPart(relativePath));
  },
  tsCurrentDirectory(): ResolutionDependencyKey {
    return address('ts-current-directory', 'cwd');
  },
  tsExecutingFile(): ResolutionDependencyKey {
    return address('ts-executing-file', 'compiler');
  },
  compilerOptions(configPath: string): ResolutionDependencyKey {
    return address('compiler-options', relativePathPart(configPath));
  },
  sourceLexical(
    sourceFileId: string,
    sourceEdgeId: string,
  ): ResolutionDependencyKey {
    return address(
      'source-lexical-facts',
      keyParts([sourceFileId, sourceEdgeId]),
    );
  },
  moduleSpecifier(
    sourceFileId: string,
    specifier: string,
  ): ResolutionDependencyKey {
    return address('module-specifier', keyParts([sourceFileId, specifier]));
  },
  moduleCandidate(relativePath: string): ResolutionDependencyKey {
    return address('module-candidate', relativePathPart(relativePath));
  },
  moduleImports(sourceFileId: string): ResolutionDependencyKey {
    return address('module-import-set', sourceFileId);
  },
  moduleSymbols(sourceFileId: string): ResolutionDependencyKey {
    return address('module-symbol-set', sourceFileId);
  },
  exportedName(
    relativePath: string,
    exportedName: string,
  ): ResolutionDependencyKey {
    return address(
      'export-candidate-set',
      keyParts([relativePathPart(relativePath), exportedName]),
    );
  },
  configTarget(relativePath: string): ResolutionDependencyKey {
    return address('config-target', relativePathPart(relativePath));
  },
  docPathFragment(
    relativePath: string,
    fragment: string,
  ): ResolutionDependencyKey {
    return address(
      'doc-path-fragment',
      keyParts([relativePathPart(relativePath), fragment]),
    );
  },
  ipcNamespace(namespace: string, key: string): ResolutionDependencyKey {
    return address('ipc-channel-candidate-set', keyParts([namespace, key]));
  },
  workflowAction(reference: string): ResolutionDependencyKey {
    return address('workflow-action-disposition', reference);
  },
  workflowManifest(relativePath: string): ResolutionDependencyKey {
    return address(
      'workflow-manifest-candidate-set',
      relativePathPart(relativePath),
    );
  },
  testCallCandidate(
    sourceFileId: string,
    targetName: string,
  ): ResolutionDependencyKey {
    return address(
      'test-call-candidate-set',
      keyParts([sourceFileId, targetName]),
    );
  },
  edgeQuery(input: {
    kind?: CodeGraphEdgeKind;
    unresolvedOnly?: boolean;
    sourceFileId?: string;
    repoId?: string;
  }): ResolutionDependencyKey {
    return address(
      'store-edge-query',
      keyParts([
        input.repoId ?? '',
        input.kind ?? '',
        input.unresolvedOnly === true ? 'unresolved' : 'all',
        input.sourceFileId ?? '',
      ]),
    );
  },
  qualifiedName(
    repoId: string,
    qualifiedName: string,
  ): ResolutionDependencyKey {
    return address(
      'store-symbol-qualified-name',
      keyParts([repoId, qualifiedName]),
    );
  },
  symbolsForFile(fileId: string): ResolutionDependencyKey {
    return address('store-symbols-for-file', fileId);
  },
  symbolsByKindAndName(
    repoId: string,
    kind: CodeGraphSymbolKind,
    name: string,
  ): ResolutionDependencyKey {
    return address(
      'store-symbols-by-kind-name',
      keyParts([repoId, kind, name]),
    );
  },
};

function isResolutionDependencyArray(
  value: ResolutionDependencyJson,
): value is readonly ResolutionDependencyJson[] {
  return Array.isArray(value);
}

function stableStringify(value: ResolutionDependencyJson): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (isResolutionDependencyArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(',')}]`;
  }
  const fields = Object.keys(value).sort();
  return `{${fields
    .map((field) => `${JSON.stringify(field)}:${stableStringify(value[field])}`)
    .join(',')}}`;
}

export function canonicalResolutionDependencyJson(
  value: ResolutionDependencyJson,
): string {
  return stableStringify(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isUnknownArray(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}

function normalizeUnknown(
  value: unknown,
): { complete: true; value: ResolutionDependencyJson } | { complete: false } {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean'
  ) {
    return { complete: true, value };
  }
  if (typeof value === 'number') {
    return Number.isFinite(value)
      ? { complete: true, value }
      : { complete: false };
  }
  if (isUnknownArray(value)) {
    const entries: ResolutionDependencyJson[] = [];
    for (const entry of value) {
      const normalized = normalizeUnknown(entry);
      if (!normalized.complete) return { complete: false };
      entries.push(normalized.value);
    }
    return { complete: true, value: entries };
  }
  if (!isRecord(value)) return { complete: false };
  const normalized: Record<string, ResolutionDependencyJson> = {};
  for (const field of Object.keys(value).sort()) {
    const raw = value[field];
    if (raw === undefined) continue;
    const fieldValue = normalizeUnknown(raw);
    if (!fieldValue.complete) return { complete: false };
    normalized[field] = fieldValue.value;
  }
  return { complete: true, value: normalized };
}

function edgeValue(edge: CodeGraphEdgeRecord): unknown {
  return {
    id: edge.id,
    repositoryId: edge.repositoryId,
    kind: edge.kind,
    sourceSymbolId: edge.sourceSymbolId,
    targetSymbolId: edge.targetSymbolId,
    sourceFileId: edge.sourceFileId,
    targetRef: edge.targetRef,
    line: edge.line,
    confidenceTier: edge.confidenceTier,
    confidenceScore: edge.confidenceScore,
    resolverId: edge.resolverId,
    evidence: edge.evidence,
  };
}

function fileValue(file: CodeGraphFileRecord | null): unknown {
  if (file === null) return null;
  return {
    id: file.id,
    repositoryId: file.repositoryId,
    relativePath: file.relativePath,
    absolutePath: file.absolutePath,
  };
}

function symbolValue(symbol: CodeGraphSymbolRecord | null): unknown {
  if (symbol === null) return null;
  return {
    id: symbol.id,
    repositoryId: symbol.repositoryId,
    fileId: symbol.fileId,
    kind: symbol.kind,
    name: symbol.name,
    qualifiedName: symbol.qualifiedName,
    parentSymbolId: symbol.parentSymbolId,
    exported: symbol.exported,
    isTest: symbol.isTest,
    extra: symbol.extra,
  };
}

function symbolsValue(symbols: readonly CodeGraphSymbolRecord[]): unknown {
  return symbols.map((symbol) => symbolValue(symbol));
}

function edgesValue(edges: readonly CodeGraphEdgeRecord[]): unknown {
  return edges.map((edge) => edgeValue(edge));
}

export interface ResolutionDependencyCaptureSnapshot {
  metadata: ResolutionDependencyCaptureMetadata;
  dependencyRows: number;
}

/**
 * Incremental coverage is trusted only when the orchestrator obtained this
 * metadata from the existing database and checked schema/root/algorithm
 * compatibility before beginning the facts writer. `closureComplete` is a
 * separate proof that the changed-key reverse closure was not capped or
 * otherwise truncated. Callers must not synthesize this object from an
 * unknown or incomplete marker.
 */
export interface TrustedResolutionDependencyPrior {
  metadata: ResolutionDependencyCaptureMetadata;
  closureComplete: boolean;
}

interface ActiveResolutionDependencySource {
  scope: ResolutionDependencySource;
  observations: Map<string, ResolutionDependencyObservation>;
  observationLog: ResolutionDependencyObservation[];
}

export class ResolutionDependencyCapture {
  private readonly resolverReasons = new Map<
    ResolutionCaptureResolver,
    Set<string>
  >();
  private readonly finishedResolvers = new Set<ResolutionCaptureResolver>();
  private readonly fullResolvers = new Set<ResolutionCaptureResolver>();
  private activeResolver: ResolutionCaptureResolver | null = null;
  private currentSource: ActiveResolutionDependencySource | null = null;
  private dependencyRows = 0;

  public constructor(
    private readonly repoId: string,
    private readonly rootPath: string,
    private readonly writer: ResolutionDependencyWriter,
    private readonly trustedPrior?: TrustedResolutionDependencyPrior,
  ) {}

  public beginResolver(
    resolver: ResolutionCaptureResolver,
    sourceFileIds?: readonly string[],
  ): void {
    if (this.currentSource !== null) {
      throw new Error('Cannot begin a resolver while a source is active');
    }
    if (this.activeResolver !== null) {
      throw new Error('Previous resolver was not finished');
    }
    if (
      sourceFileIds !== undefined &&
      new Set(sourceFileIds).size > RESOLUTION_CAPTURE_MAX_SOURCE_FILE_IDS
    ) {
      throw new Error(
        `Capture selection exceeds ${RESOLUTION_CAPTURE_MAX_SOURCE_FILE_IDS} source files`,
      );
    }
    const selected =
      sourceFileIds === undefined
        ? undefined
        : Array.from(new Set(sourceFileIds)).sort((left, right) =>
            compareCodeUnits(left, right),
          );
    this.writer.beginResolver(this.repoId, resolver, selected);
    this.activeResolver = resolver;
  }

  public beginSource(
    source: Omit<ResolutionDependencySource, 'resolver'>,
  ): () => void {
    const resolver = this.activeResolver;
    if (resolver === null) {
      throw new Error('Cannot capture a source outside a resolver pass');
    }
    if (this.currentSource !== null) {
      throw new Error('Resolution dependency source scopes cannot be nested');
    }
    const scope: ResolutionDependencySource = {
      resolver,
      sourceFileId: source.sourceFileId,
      sourceEdgeId: source.sourceEdgeId,
    };
    const current: ActiveResolutionDependencySource = {
      scope,
      observations: new Map<string, ResolutionDependencyObservation>(),
      observationLog: [],
    };
    this.currentSource = current;
    this.observe(
      address(
        'capture-source-coverage',
        keyParts([resolver, source.sourceFileId, source.sourceEdgeId]),
      ),
      true,
    );
    let ended = false;
    return (): void => {
      if (ended) return;
      ended = true;
      if (this.currentSource !== current) {
        this.markIncomplete(resolver, 'source-scope-mismatch');
        this.currentSource = null;
        return;
      }
      const observations = Array.from(current.observations.values()).sort(
        (left, right) =>
          compareCodeUnits(left.dependencyKind, right.dependencyKind) ||
          compareCodeUnits(left.dependencyKey, right.dependencyKey),
      );
      try {
        this.writer.replaceSource(this.repoId, scope, observations);
        this.dependencyRows += observations.length;
      } finally {
        this.currentSource = null;
      }
    };
  }

  public observe(
    key: ResolutionDependencyKey,
    value: ResolutionDependencyJson,
  ): void {
    const current = this.currentSource;
    if (current === null) {
      const resolver = this.activeResolver;
      if (resolver !== null) {
        this.markIncomplete(resolver, 'observation-without-source-context');
      }
      return;
    }
    const identity = `${key.dependencyKind}\u0000${key.dependencyKey}`;
    const prior = current.observations.get(identity);
    if (
      prior !== undefined &&
      stableStringify(prior.dependencyValue) !== stableStringify(value)
    ) {
      this.markIncomplete(current.scope.resolver, 'conflicting-observation');
      return;
    }
    current.observations.set(identity, {
      dependencyKind: key.dependencyKind,
      dependencyKey: key.dependencyKey,
      dependencyValue: value,
    });
    current.observationLog.push({
      dependencyKind: key.dependencyKind,
      dependencyKey: key.dependencyKey,
      dependencyValue: value,
    });
  }

  public observeUnknown(key: ResolutionDependencyKey, value: unknown): void {
    const normalized = normalizeUnknown(value);
    if (!normalized.complete) {
      this.markIncompleteForCurrent('unrepresentable-observation');
      return;
    }
    this.observe(key, normalized.value);
  }

  /** Query wrappers may see intentional repo-wide setup reads outside a scope. */
  public observeIfScoped(key: ResolutionDependencyKey, value: unknown): void {
    if (this.currentSource === null) return;
    this.observeUnknown(key, value);
  }

  public markIncompleteForCurrent(reason: string): void {
    const resolver = this.currentSource?.scope.resolver ?? this.activeResolver;
    if (resolver !== null && resolver !== undefined) {
      this.markIncomplete(resolver, reason);
    }
  }

  public markIncomplete(
    resolver: ResolutionCaptureResolver,
    reason: string,
  ): void {
    const reasons = this.resolverReasons.get(resolver) ?? new Set<string>();
    reasons.add(reason);
    this.resolverReasons.set(resolver, reasons);
  }

  public checkpoint(): number {
    const current = this.currentSource;
    if (current === null) {
      this.markIncompleteForCurrent('cache-checkpoint-without-source');
      return 0;
    }
    return current.observationLog.length;
  }

  public observationsSince(
    checkpoint: number,
  ): readonly ResolutionDependencyObservation[] {
    const current = this.currentSource;
    if (current === null) {
      this.markIncompleteForCurrent('cache-snapshot-without-source');
      return [];
    }
    return current.observationLog.slice(checkpoint);
  }

  /** Replays cached reads under the current caller's source scope. */
  public replay(
    observations: readonly ResolutionDependencyObservation[],
  ): void {
    for (const observation of observations) {
      if (observation.dependencyKind === 'capture-source-coverage') continue;
      this.observe(
        {
          dependencyKind: observation.dependencyKind,
          dependencyKey: observation.dependencyKey,
        },
        observation.dependencyValue,
      );
    }
  }

  public finishResolver(
    resolver: ResolutionCaptureResolver,
    sourceFileIds?: readonly string[],
  ): void {
    if (this.currentSource !== null) {
      throw new Error('Cannot finish a resolver with an active source');
    }
    if (this.activeResolver !== resolver) {
      throw new Error('Resolver finish does not match active resolver');
    }
    const selected =
      sourceFileIds === undefined
        ? undefined
        : Array.from(new Set(sourceFileIds)).sort((left, right) =>
            compareCodeUnits(left, right),
          );
    this.writer.finishResolver(this.repoId, resolver, selected);
    this.finishedResolvers.add(resolver);
    if (selected === undefined) this.fullResolvers.add(resolver);
    this.activeResolver = null;
  }

  public finishRepository(): ResolutionDependencyCaptureSnapshot {
    if (this.currentSource !== null || this.activeResolver !== null) {
      throw new Error('Cannot finish repository with active capture work');
    }
    const priorCanCoverPartialPasses =
      this.trustedPrior !== undefined &&
      this.trustedPrior.closureComplete &&
      this.trustedPrior.metadata.complete &&
      this.trustedPrior.metadata.incompleteResolvers.length === 0 &&
      this.trustedPrior.metadata.schemaVersion ===
        RESOLUTION_CAPTURE_SCHEMA_VERSION &&
      this.trustedPrior.metadata.captureVersion ===
        RESOLUTION_CAPTURE_FORMAT_VERSION &&
      this.trustedPrior.metadata.rootPath === this.rootPath &&
      RESOLUTION_CAPTURE_RESOLVERS.every(
        (resolver) =>
          this.trustedPrior?.metadata.algorithmVersions[resolver] ===
          RESOLUTION_CAPTURE_ALGORITHM_VERSIONS[resolver],
      );
    const allResolverPassesFinished = RESOLUTION_CAPTURE_RESOLVERS.every(
      (resolver) => this.finishedResolvers.has(resolver),
    );
    const partialCoverageIsProven =
      priorCanCoverPartialPasses && allResolverPassesFinished;
    if (!partialCoverageIsProven) {
      for (const resolver of RESOLUTION_CAPTURE_RESOLVERS) {
        if (this.fullResolvers.has(resolver)) continue;
        this.markIncomplete(
          resolver,
          this.finishedResolvers.has(resolver)
            ? 'partial-resolver-capture-without-complete-prior'
            : 'resolver-pass-not-captured',
        );
      }
    }
    const incompleteResolvers = RESOLUTION_CAPTURE_RESOLVERS.filter(
      (resolver) => (this.resolverReasons.get(resolver)?.size ?? 0) > 0,
    );
    const reasonsByResolver: Partial<
      Record<ResolutionCaptureResolver, readonly string[]>
    > = {};
    for (const resolver of RESOLUTION_CAPTURE_RESOLVERS) {
      const reasons = this.resolverReasons.get(resolver);
      if (reasons !== undefined) {
        reasonsByResolver[resolver] = Array.from(reasons).sort((a, b) =>
          compareCodeUnits(a, b),
        );
      }
    }
    const metadata: ResolutionDependencyCaptureMetadataInput = {
      schemaVersion: RESOLUTION_CAPTURE_SCHEMA_VERSION,
      captureVersion: RESOLUTION_CAPTURE_FORMAT_VERSION,
      rootPath: this.rootPath,
      complete: incompleteResolvers.length === 0,
      algorithmVersions: RESOLUTION_CAPTURE_ALGORITHM_VERSIONS,
      incompleteResolvers,
      reasonsByResolver,
    };
    const persistedMetadata = this.writer.writeMetadata(this.repoId, metadata);
    return { metadata: persistedMetadata, dependencyRows: this.dependencyRows };
  }
}

/**
 * Strict exact-port decorator. It adds no port member and forwards writes in
 * order. Semantic cache hits must still be explicitly replayed by resolver
 * helpers; unscoped whole-repo setup reads are intentionally not attributed.
 */
export class CapturedResolutionProjectionStore implements ResolutionProjectionStore {
  public constructor(
    private readonly inner: ResolutionProjectionStore,
    private readonly capture: ResolutionDependencyCapture,
  ) {}

  public listEdges(filter: {
    kind?: CodeGraphEdgeKind;
    unresolvedOnly?: boolean;
    sourceFileId?: string;
    repoId?: string;
  }): CodeGraphEdgeRecord[] {
    const rows = this.inner.listEdges(filter);
    this.capture.observeIfScoped(
      resolutionDependencyKey.edgeQuery(filter),
      edgesValue(rows),
    );
    return rows;
  }

  public listConfigExtendsEdges(repoId: string): CodeGraphEdgeRecord[] {
    const rows = this.inner.listConfigExtendsEdges(repoId);
    this.capture.observeIfScoped(
      address('store-edge-query', keyParts([repoId, 'CONFIG_EXTENDS'])),
      edgesValue(rows),
    );
    return rows;
  }

  public listTestCallTargets(repoId: string): Array<{
    sourceFileId: string;
    targetSymbolId: string;
    testFileSymbolId: string;
  }> {
    const rows = this.inner.listTestCallTargets(repoId);
    this.capture.observeIfScoped(
      address('store-test-call-targets', repoId),
      rows.map((row) => ({
        sourceFileId: row.sourceFileId,
        targetSymbolId: row.targetSymbolId,
        testFileSymbolId: row.testFileSymbolId,
      })),
    );
    return rows;
  }

  public getFileById(fileId: string): CodeGraphFileRecord | null {
    const file = this.inner.getFileById(fileId);
    this.capture.observeIfScoped(
      address('store-file', fileId),
      fileValue(file),
    );
    return file;
  }

  public listFiles(repoId: string): CodeGraphFileRecord[] {
    const rows = this.inner.listFiles(repoId);
    this.capture.observeIfScoped(
      address('store-file', `repo:${keyPart(repoId)}`),
      rows.map((file) => fileValue(file)),
    );
    return rows;
  }

  public getSymbolByQualifiedName(
    qualifiedName: string,
    repoId: string,
  ): CodeGraphSymbolRecord | null {
    const symbol = this.inner.getSymbolByQualifiedName(qualifiedName, repoId);
    this.capture.observeIfScoped(
      resolutionDependencyKey.qualifiedName(repoId, qualifiedName),
      symbolValue(symbol),
    );
    return symbol;
  }

  public listSymbolsForFile(fileId: string): CodeGraphSymbolRecord[] {
    const rows = this.inner.listSymbolsForFile(fileId);
    this.capture.observeIfScoped(
      resolutionDependencyKey.symbolsForFile(fileId),
      symbolsValue(rows),
    );
    return rows;
  }

  public listSymbolsByKindAndName(
    kind: CodeGraphSymbolKind,
    name: string,
    repoId: string,
  ): CodeGraphSymbolRecord[] {
    const rows = this.inner.listSymbolsByKindAndName(kind, name, repoId);
    this.capture.observeIfScoped(
      resolutionDependencyKey.symbolsByKindAndName(repoId, kind, name),
      symbolsValue(rows),
    );
    return rows;
  }

  public updateEdgeResolution(
    edgeId: string,
    update: {
      targetSymbolId: string;
      confidenceTier: CodeGraphConfidenceTier;
      confidenceScore: number;
      resolverId: string;
      evidence: Record<string, unknown>;
    },
  ): void {
    this.inner.updateEdgeResolution(edgeId, update);
  }

  public updateEdgeEvidence(
    edgeId: string,
    evidence: Record<string, unknown>,
  ): void {
    this.inner.updateEdgeEvidence(edgeId, evidence);
  }

  public insertEdges(edges: readonly CodeGraphEdgeRecord[]): void {
    this.inner.insertEdges(edges);
  }
}

/** Existing-port-only source selection; undefined means full, [] means none. */
export function listEdgesForSourceFiles(
  store: ResolutionProjectionStore,
  filter: {
    kind?: CodeGraphEdgeKind;
    unresolvedOnly?: boolean;
    repoId?: string;
  },
  sourceFileIds?: readonly string[],
): CodeGraphEdgeRecord[] {
  if (sourceFileIds === undefined) return store.listEdges(filter);
  const uniqueSourceFileIds = Array.from(new Set(sourceFileIds)).sort(
    (left, right) => compareCodeUnits(left, right),
  );
  if (uniqueSourceFileIds.length > RESOLUTION_CAPTURE_MAX_SOURCE_FILE_IDS) {
    throw new Error(
      'Source iteration exceeds distinct-file bound; full repository required',
    );
  }
  const edges: CodeGraphEdgeRecord[] = [];
  for (const sourceFileId of uniqueSourceFileIds) {
    edges.push(...store.listEdges({ ...filter, sourceFileId }));
  }
  return edges.sort((left, right) => compareCodeUnits(left.id, right.id));
}
