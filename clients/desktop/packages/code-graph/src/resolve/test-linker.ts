import { edgeRowId } from '../ids';
import type {
  CodeGraphEdgeRecord,
  CodeGraphFileRecord,
  CodeGraphSymbolRecord,
} from '../types/code-graph';
import type { ResolutionProjectionStore } from './resolution-projection';
import {
  listEdgesForSourceFiles,
  resolutionDependencyKey,
  type ResolutionDependencyCapture,
} from './resolution-dependency-capture';

/** Storage timestamps are not inputs to test ownership or link resolution. */
function testFileDependency(
  file: CodeGraphFileRecord | null,
): Omit<CodeGraphFileRecord, 'updatedAt' | 'mtimeNs'> | null {
  if (file === null) return null;
  return {
    id: file.id,
    repositoryId: file.repositoryId,
    relativePath: file.relativePath,
    absolutePath: file.absolutePath,
    language: file.language,
    contentHash: file.contentHash,
    sizeBytes: file.sizeBytes,
    lineCount: file.lineCount,
    grammarId: file.grammarId,
    grammarAbi: file.grammarAbi,
    parseStatus: file.parseStatus,
    hasErrors: file.hasErrors,
  };
}

export function linkTests(input: {
  store: ResolutionProjectionStore;
  repoId: string;
  capture?: ResolutionDependencyCapture;
  sourceFileIds?: readonly string[];
}): number {
  // This lookup MUST stay on the same reset/proposal overlay as every pass.
  // Inspect all rows honestly; only selected source owners are generated below.
  const allTargets = input.store.listTestCallTargets(input.repoId);
  const selectedSources =
    input.sourceFileIds === undefined ? null : new Set(input.sourceFileIds);
  const selectedTargets =
    selectedSources === null
      ? allTargets
      : allTargets.filter((target): boolean =>
          selectedSources.has(target.sourceFileId),
        );
  if (input.capture !== undefined) {
    const calls = listEdgesForSourceFiles(
      input.store,
      { kind: 'CALLS', repoId: input.repoId },
      input.sourceFileIds,
    );
    const wantedTargetIds = new Set(
      calls.flatMap((edge): string[] =>
        edge.targetSymbolId === null ? [] : [edge.targetSymbolId],
      ),
    );
    const targetsById = new Map<string, CodeGraphSymbolRecord>();
    // Frozen port has no symbol-by-ID method. Localize exact target IDs from
    // immutable facts, not guesses from targetRef, old destinations or names.
    // Keep only requested targets, not a graph-wide symbol/edge map. These
    // setup reads are outside source scopes; later scoped reads capture each
    // actually used target-file membership. Inspect cost remains unqualified.
    if (wantedTargetIds.size > 0) {
      for (const file of input.store.listFiles(input.repoId)) {
        for (const symbol of input.store.listSymbolsForFile(file.id)) {
          if (wantedTargetIds.has(symbol.id)) {
            targetsById.set(symbol.id, symbol);
            wantedTargetIds.delete(symbol.id);
          }
        }
        if (wantedTargetIds.size === 0) break;
      }
    }
    for (const edge of calls) {
      const endSource = input.capture.beginSource({
        sourceFileId: edge.sourceFileId,
        sourceEdgeId: edge.id,
      });
      try {
        input.capture.observeUnknown(
          resolutionDependencyKey.sourceLexical(edge.sourceFileId, edge.id),
          edge,
        );
        const sourceSymbols = input.store.listSymbolsForFile(edge.sourceFileId);
        const source =
          sourceSymbols.find(
            (symbol): boolean => symbol.id === edge.sourceSymbolId,
          ) ?? null;
        const target =
          edge.targetSymbolId === null
            ? null
            : (targetsById.get(edge.targetSymbolId) ?? null);
        if (target !== null) input.store.listSymbolsForFile(target.fileId);
        if (edge.sourceSymbolId !== null && source === null)
          input.capture.markIncompleteForCurrent(
            'test-source-symbol-not-localizable',
          );
        if (edge.targetSymbolId !== null && target === null)
          input.capture.markIncompleteForCurrent(
            'test-target-symbol-not-localizable',
          );
        input.capture.observeUnknown(
          resolutionDependencyKey.testCallCandidate(edge.sourceFileId, edge.id),
          {
            sourceSymbolId: edge.sourceSymbolId,
            sourceIsTest: source?.isTest ?? null,
            targetSymbolId: edge.targetSymbolId,
            targetIsTest: target?.isTest ?? null,
            sourcePath:
              input.store.getFileById(edge.sourceFileId)?.relativePath ?? null,
            targetPath:
              target === null
                ? null
                : (input.store.getFileById(target.fileId)?.relativePath ??
                  null),
            matchedTargets: allTargets.filter(
              (candidate): boolean =>
                candidate.sourceFileId === edge.sourceFileId &&
                candidate.targetSymbolId === edge.targetSymbolId,
            ),
          },
        );
      } finally {
        endSource();
      }
    }
    const sourceFileIds =
      input.sourceFileIds ??
      input.store.listFiles(input.repoId).map((file): string => file.id);
    for (const sourceFileId of sourceFileIds) {
      if (input.store.getFileById(sourceFileId) === null) continue;
      const endSource = input.capture.beginSource({
        sourceFileId,
        sourceEdgeId: '',
      });
      try {
        const symbols = input.store.listSymbolsForFile(sourceFileId);
        input.capture.observeUnknown(
          resolutionDependencyKey.testCallCandidate(
            sourceFileId,
            'tested-by-projection',
          ),
          {
            file: testFileDependency(input.store.getFileById(sourceFileId)),
            fileSymbols: symbols.filter(
              (symbol): boolean => symbol.kind === 'file',
            ),
            testMembership: symbols.map(
              (symbol): { id: string; isTest: boolean } => ({
                id: symbol.id,
                isTest: symbol.isTest,
              }),
            ),
            targets: allTargets.filter(
              (target): boolean => target.sourceFileId === sourceFileId,
            ),
          },
        );
      } finally {
        endSource();
      }
    }
  }
  const testedBy: CodeGraphEdgeRecord[] = [];
  for (const edge of selectedTargets) {
    testedBy.push({
      id: edgeRowId({
        repoId: input.repoId,
        kind: 'TESTED_BY',
        sourceId: edge.targetSymbolId,
        target: edge.testFileSymbolId,
        line: null,
      }),
      repositoryId: input.repoId,
      kind: 'TESTED_BY',
      sourceSymbolId: edge.targetSymbolId,
      targetSymbolId: edge.testFileSymbolId,
      sourceFileId: edge.sourceFileId,
      targetRef: null,
      line: null,
      confidenceTier: 'INFERRED',
      confidenceScore: 0.8,
      resolverId: 'test-linker',
      evidence: {},
    });
  }
  input.store.insertEdges(testedBy);
  return testedBy.length;
}
