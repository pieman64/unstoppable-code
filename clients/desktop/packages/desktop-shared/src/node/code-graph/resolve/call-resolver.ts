import { isRecord } from '../store/database';
import type {
  CodeGraphEdgeRecord,
  CodeGraphSymbolRecord,
} from '../../../types/code-graph';
import {
  listEdgesForSourceFiles,
  resolutionDependencyKey,
} from './resolution-dependency-capture';
import type {
  ResolutionDependencyCapture,
  ResolutionDependencyObservation,
} from './resolution-dependency-capture';
import type { ResolutionProjectionStore } from './resolution-projection';

interface ImportBinding {
  local: string;
  imported: string;
  resolvedPath: string;
  namespace?: boolean;
}

function isUnknownArray(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}

export function resolveCallEdges(input: {
  store: ResolutionProjectionStore;
  repoId: string;
  capture?: ResolutionDependencyCapture;
  sourceFileIds?: readonly string[];
}): number {
  const { store, repoId, capture } = input;
  const symbolsByFile = new Map<string, CodeGraphSymbolRecord[]>();
  const symbolObservationsByFile = new Map<
    string,
    readonly ResolutionDependencyObservation[]
  >();
  // Build this adjacency once. Per-file SQL reads can choose the repo/kind
  // index and scan every import for each file, turning resolution quadratic.
  const importsByFile = new Map<string, CodeGraphEdgeRecord[]>();
  for (const edge of store.listEdges({ repoId, kind: 'IMPORTS_FROM' })) {
    const edges = importsByFile.get(edge.sourceFileId) ?? [];
    edges.push(edge);
    importsByFile.set(edge.sourceFileId, edges);
  }
  const files = store.listFiles(repoId);
  const filesByPath = new Map(
    files.map((file) => [file.relativePath, file.id]),
  );
  const relativePathByFile = new Map(
    files.map((file) => [file.id, file.relativePath]),
  );
  const symbols = (fileId: string): CodeGraphSymbolRecord[] => {
    let found = symbolsByFile.get(fileId);
    if (found === undefined) {
      const checkpoint = capture?.checkpoint();
      found = store.listSymbolsForFile(fileId);
      symbolsByFile.set(fileId, found);
      if (capture !== undefined && checkpoint !== undefined) {
        symbolObservationsByFile.set(
          fileId,
          capture.observationsSince(checkpoint),
        );
      }
    } else if (capture !== undefined) {
      const observations = symbolObservationsByFile.get(fileId);
      if (observations === undefined) {
        capture.markIncompleteForCurrent(
          'call-symbol-cache-without-observations',
        );
      } else {
        capture.replay(observations);
      }
    }
    return found;
  };
  const imports = (fileId: string): CodeGraphEdgeRecord[] =>
    importsByFile.get(fileId) ?? [];
  const names = (
    edge: CodeGraphEdgeRecord,
  ): Array<{ imported: string; local: string }> => {
    const value = edge.evidence.names;
    if (!isUnknownArray(value)) {
      capture?.markIncompleteForCurrent('call-import-names-not-an-array');
      return [];
    }
    const output: Array<{ imported: string; local: string }> = [];
    for (const entry of value) {
      if (
        isRecord(entry) &&
        typeof entry.imported === 'string' &&
        typeof entry.local === 'string'
      ) {
        output.push({ imported: entry.imported, local: entry.local });
      } else {
        capture?.markIncompleteForCurrent('call-import-name-not-localizable');
      }
    }
    return output;
  };
  const recordImports = (fileId: string): CodeGraphEdgeRecord[] => {
    const found = imports(fileId);
    capture?.observeUnknown(
      resolutionDependencyKey.moduleImports(fileId),
      found,
    );
    for (const edge of found) {
      const booleanFlags: readonly ('isReExport' | 'exportAll')[] = [
        'isReExport',
        'exportAll',
      ];
      for (const flag of booleanFlags) {
        const value = edge.evidence[flag];
        if (value !== undefined && typeof value !== 'boolean') {
          capture?.markIncompleteForCurrent('call-import-flag-not-boolean');
        }
      }
      const defaultLocal = edge.evidence.defaultLocal;
      const namespaceLocal = edge.evidence.namespaceLocal;
      if (
        (defaultLocal !== undefined &&
          defaultLocal !== null &&
          typeof defaultLocal !== 'string') ||
        (namespaceLocal !== undefined &&
          namespaceLocal !== null &&
          typeof namespaceLocal !== 'string')
      ) {
        capture?.markIncompleteForCurrent('call-import-local-not-string');
      }
      const resolvedPath = edge.evidence.resolvedPath;
      if (resolvedPath !== undefined && typeof resolvedPath !== 'string') {
        capture?.markIncompleteForCurrent(
          'call-import-resolved-path-not-string',
        );
      }
      if (typeof resolvedPath !== 'string') continue;
      capture?.observe(resolutionDependencyKey.moduleCandidate(resolvedPath), {
        fileId: filesByPath.get(resolvedPath) ?? null,
      });
    }
    return found;
  };
  const bindings = (fileId: string): ImportBinding[] =>
    recordImports(fileId).flatMap((edge) => {
      const resolvedPath = edge.evidence.resolvedPath;
      if (edge.evidence.isReExport === true || typeof resolvedPath !== 'string')
        return [];
      const result: ImportBinding[] = names(edge).map((name) => ({
        ...name,
        resolvedPath,
      }));
      if (typeof edge.evidence.defaultLocal === 'string')
        result.push({
          local: edge.evidence.defaultLocal,
          imported: 'default',
          resolvedPath,
        });
      if (typeof edge.evidence.namespaceLocal === 'string')
        result.push({
          local: edge.evidence.namespaceLocal,
          imported: '*',
          resolvedPath,
          namespace: true,
        });
      return result;
    });
  const exported = (
    fileId: string,
    name: string,
    visiting: Set<string>,
    budget: { remaining: number },
  ): CodeGraphSymbolRecord[] => {
    const key = `${fileId}:${name}`;
    if (visiting.has(key) || --budget.remaining < 0) return [];
    visiting.add(key);
    try {
      const fileSymbols = symbols(fileId);
      const direct = fileSymbols.filter(
        (symbol) =>
          symbol.kind !== 'file' &&
          symbol.parentSymbolId === null &&
          symbol.name === name &&
          symbol.exported &&
          symbol.extra.defaultExport !== true,
      );
      const explicit = [...direct];
      let explicitDeclared = direct.length > 0;
      const fileSymbol = fileSymbols.find((symbol) => symbol.kind === 'file');
      const localExports = fileSymbol?.extra.localExports;
      if (localExports !== undefined && !isUnknownArray(localExports)) {
        capture?.markIncompleteForCurrent('call-local-exports-not-an-array');
      }
      if (isUnknownArray(localExports)) {
        for (const entry of localExports) {
          if (
            !isRecord(entry) ||
            entry.exported !== name ||
            typeof entry.local !== 'string'
          ) {
            if (
              !isRecord(entry) ||
              typeof entry.exported !== 'string' ||
              typeof entry.local !== 'string'
            ) {
              capture?.markIncompleteForCurrent(
                'call-local-export-not-localizable',
              );
            }
            continue;
          }
          explicitDeclared = true;
          explicit.push(
            ...fileSymbols.filter(
              (symbol) =>
                symbol.kind !== 'file' &&
                symbol.parentSymbolId === null &&
                symbol.name === entry.local,
            ),
          );
          for (const binding of bindings(fileId).filter(
            (binding) => binding.local === entry.local && !binding.namespace,
          )) {
            const targetFile = filesByPath.get(binding.resolvedPath);
            if (targetFile !== undefined)
              explicit.push(
                ...exported(targetFile, binding.imported, visiting, budget),
              );
          }
        }
      }
      const stars: CodeGraphSymbolRecord[] = [];
      for (const edge of recordImports(fileId)) {
        if (edge.evidence.isReExport !== true) continue;
        if (names(edge).some((binding) => binding.local === name))
          explicitDeclared = true;
        if (typeof edge.evidence.resolvedPath !== 'string') continue;
        const targetFile = filesByPath.get(edge.evidence.resolvedPath);
        if (targetFile === undefined) continue;
        for (const binding of names(edge)) {
          if (binding.local === name)
            explicit.push(
              ...exported(targetFile, binding.imported, visiting, budget),
            );
        }
        if (name !== 'default' && edge.evidence.exportAll === true)
          stars.push(...exported(targetFile, name, visiting, budget));
      }
      const result = Array.from(
        new Map(
          (explicitDeclared ? explicit : stars).map((symbol) => [
            symbol.id,
            symbol,
          ]),
        ).values(),
      );
      const relativePath = relativePathByFile.get(fileId);
      if (relativePath === undefined) {
        capture?.markIncompleteForCurrent('call-export-file-not-localizable');
      } else {
        capture?.observeUnknown(
          resolutionDependencyKey.exportedName(relativePath, name),
          result,
        );
      }
      return result;
    } finally {
      visiting.delete(key);
    }
  };
  const exportCache = new Map<
    string,
    {
      symbols: CodeGraphSymbolRecord[];
      observations: readonly ResolutionDependencyObservation[];
    }
  >();
  const resolveExport = (
    relativePath: string,
    name: string,
  ): CodeGraphSymbolRecord[] => {
    const key = `${relativePath}:${name}`;
    const cached = exportCache.get(key);
    if (cached !== undefined) {
      capture?.replay(cached.observations);
      return cached.symbols;
    }
    const checkpoint = capture?.checkpoint();
    const fileId = filesByPath.get(relativePath);
    capture?.observe(
      resolutionDependencyKey.moduleCandidate(relativePath),
      fileId === undefined ? null : { fileId },
    );
    if (fileId === undefined) {
      capture?.observe(
        resolutionDependencyKey.exportedName(relativePath, name),
        [],
      );
    }
    const budget = { remaining: 256 };
    let result =
      fileId === undefined ? [] : exported(fileId, name, new Set(), budget);
    // A truncated traversal cannot prove uniqueness.
    if (budget.remaining < 0) {
      capture?.markIncompleteForCurrent(
        'call-export-traversal-budget-exhausted',
      );
      result = [];
    }
    const observations =
      capture !== undefined && checkpoint !== undefined
        ? capture.observationsSince(checkpoint)
        : [];
    exportCache.set(key, { symbols: result, observations });
    return result;
  };
  let upgraded = 0;
  const resolutionKinds: readonly CodeGraphEdgeRecord['kind'][] = [
    'CALLS',
    'REFERENCES',
  ];
  for (const kind of resolutionKinds) {
    const filter =
      capture === undefined
        ? { kind, unresolvedOnly: true, repoId }
        : { kind, repoId };
    const edges = listEdgesForSourceFiles(store, filter, input.sourceFileIds);
    for (const edge of edges) {
      if (edge.evidence.configExtends === true) continue;
      const endSource = capture?.beginSource({
        sourceFileId: edge.sourceFileId,
        sourceEdgeId: edge.id,
      });
      try {
        capture?.observeUnknown(
          resolutionDependencyKey.sourceLexical(edge.sourceFileId, edge.id),
          edge,
        );
        recordImports(edge.sourceFileId);
        const locals = symbols(edge.sourceFileId);
        capture?.observeUnknown(
          resolutionDependencyKey.moduleSymbols(edge.sourceFileId),
          locals,
        );
        // Capture mode records the source facts for already-bound parser-owned
        // rows as well. Their existing resolution is not recomputed or rewritten.
        if (edge.targetSymbolId !== null) continue;
        if (edge.targetRef === null || edge.evidence.shadowed === true)
          continue;
        const eligible = (symbol: CodeGraphSymbolRecord): boolean =>
          kind !== 'CALLS' || ['function', 'method'].includes(symbol.kind);
        let targets: CodeGraphSymbolRecord[] = [];
        let resolverId = 'local-scope';
        let via: string | undefined;
        if (
          edge.evidence.unsupportedLanguageResolution === true ||
          edge.evidence.syntax === 'prisma'
        ) {
          capture?.markIncompleteForCurrent(
            'unsupported-call-language-resolution',
          );
          continue;
        }
        if (typeof edge.evidence.lexicalTarget === 'string') {
          targets = locals.filter(
            (symbol) =>
              symbol.qualifiedName === edge.evidence.lexicalTarget &&
              eligible(symbol),
          );
        } else if (
          edge.evidence.lexicalScope !== true &&
          edge.evidence.memberCall !== true
        ) {
          // Legacy/custom facts without lexical evidence: walk declaration owners,
          // never collapse all same-name symbols into a file-wide last-wins map.
          let owner = locals.find(
            (symbol) => symbol.id === edge.sourceSymbolId,
          );
          let parent: string | null = owner?.id ?? null;
          while (true) {
            targets = locals.filter(
              (symbol) =>
                symbol.kind !== 'file' &&
                symbol.name === edge.targetRef &&
                symbol.parentSymbolId === parent &&
                eligible(symbol),
            );
            if (targets.length > 0 || parent === null) break;
            parent = owner?.parentSymbolId ?? null;
            owner = locals.find((symbol) => symbol.id === parent);
          }
        }
        if (
          targets.length === 0 &&
          typeof edge.evidence.lexicalTarget !== 'string'
        ) {
          const imported = bindings(edge.sourceFileId).filter((binding) =>
            edge.evidence.memberCall === true
              ? binding.namespace && binding.local === edge.evidence.receiver
              : !binding.namespace && binding.local === edge.targetRef,
          );
          for (const binding of imported) {
            const name = binding.namespace ? edge.targetRef : binding.imported;
            targets.push(
              ...resolveExport(binding.resolvedPath, name).filter(eligible),
            );
            via = binding.resolvedPath;
          }
          resolverId = 'import-binding';
        }
        targets = Array.from(
          new Map(targets.map((target) => [target.id, target])).values(),
        );
        if (targets.length !== 1) {
          if (targets.length > 1)
            store.updateEdgeEvidence(edge.id, {
              ...edge.evidence,
              candidates: targets.length,
            });
          continue;
        }
        store.updateEdgeResolution(edge.id, {
          targetSymbolId: targets[0].id,
          confidenceTier: 'RESOLVED',
          confidenceScore: 0.9,
          resolverId,
          evidence:
            via === undefined
              ? { ...edge.evidence }
              : { ...edge.evidence, via },
        });
        upgraded++;
      } finally {
        endSource?.();
      }
    }
  }
  return upgraded;
}
