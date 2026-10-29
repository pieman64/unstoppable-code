import * as path from 'node:path';
import { canonicalRelativePath, fileQualifiedName, symbolRowId } from '../ids';
import {
  listEdgesForSourceFiles,
  resolutionDependencyKey,
  type ResolutionDependencyCapture,
} from './resolution-dependency-capture';
import type { ResolutionProjectionStore } from './resolution-projection';

import type { TsModuleResolver } from './ts-module-resolver';

export function resolveImportEdges(input: {
  store: ResolutionProjectionStore;
  capture?: ResolutionDependencyCapture;
  sourceFileIds?: readonly string[];
  resolver: TsModuleResolver;
  repoId: string;
  rootPath: string;
}): number {
  let upgraded = 0;
  const edges = listEdgesForSourceFiles(
    input.store,
    {
      kind: 'IMPORTS_FROM',
      unresolvedOnly: input.capture === undefined ? true : undefined,
      repoId: input.repoId,
    },
    input.sourceFileIds,
  );
  for (const edge of edges) {
    const endSource = input.capture?.beginSource({
      sourceFileId: edge.sourceFileId,
      sourceEdgeId: edge.id,
    });
    try {
      input.capture?.observeUnknown(
        resolutionDependencyKey.sourceLexical(edge.sourceFileId, edge.id),
        edge,
      );
      if (edge.targetSymbolId !== null) {
        input.store.getFileById(edge.sourceFileId);
        input.store.listSymbolsForFile(edge.sourceFileId);
        // Parser-owned binding has no resolver lookup to recapture. Its source
        // facts and every changed destination ID still seed affected closure.
        continue;
      }
      if (edge.targetRef === null) {
        continue;
      }
      const sourceFile = input.store.getFileById(edge.sourceFileId);
      if (sourceFile === null) {
        continue;
      }
      const resolution = input.resolver.resolveSpecifierWithKind(
        edge.targetRef,
        sourceFile.absolutePath,
        edge.sourceFileId,
      );
      if (resolution.kind === 'external') {
        input.store.updateEdgeEvidence(edge.id, {
          ...edge.evidence,
          external: true,
        });
        continue;
      }
      if (resolution.kind === 'unresolved') {
        if (edge.evidence.external === true) {
          const evidence = { ...edge.evidence };
          delete evidence.external;
          input.store.updateEdgeEvidence(edge.id, evidence);
        }
        continue;
      }
      const resolvedAbsolute = resolution.absolutePath;
      const localEvidence = { ...edge.evidence };
      delete localEvidence.external;
      const relative = path.relative(input.rootPath, resolvedAbsolute);
      if (relative.startsWith('..') || path.isAbsolute(relative)) {
        if (edge.evidence.external === true) {
          input.store.updateEdgeEvidence(edge.id, localEvidence);
        }
        continue; // resolved outside this repository root
      }
      const canonical = canonicalRelativePath(relative);
      input.capture?.observeUnknown(
        resolutionDependencyKey.moduleCandidate(canonical),
        input.store.getSymbolByQualifiedName(
          fileQualifiedName(canonical),
          input.repoId,
        ),
      );
      const targetSymbolId = symbolRowId(
        input.repoId,
        fileQualifiedName(canonical),
      );
      if (
        input.store.getSymbolByQualifiedName(
          fileQualifiedName(canonical),
          input.repoId,
        ) === null
      ) {
        if (edge.evidence.external === true) {
          input.store.updateEdgeEvidence(edge.id, localEvidence);
        }
        continue; // target file not in graph (e.g. .d.ts or unparsed); stay honest, leave unresolved
      }
      input.store.updateEdgeResolution(edge.id, {
        targetSymbolId,
        confidenceTier: 'RESOLVED',
        confidenceScore: 0.95,
        resolverId: 'ts-module-resolution',
        evidence: {
          ...localEvidence,
          resolvedPath: canonical,
        },
      });
      upgraded += 1;
    } finally {
      endSource?.();
    }
  }
  return upgraded;
}
