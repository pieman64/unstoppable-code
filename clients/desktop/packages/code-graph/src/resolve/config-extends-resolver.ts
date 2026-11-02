import * as path from 'node:path';
import { canonicalRelativePath } from '../ids';
import {
  resolutionDependencyKey,
  type ResolutionDependencyCapture,
} from './resolution-dependency-capture';
import type { ResolutionProjectionStore } from './resolution-projection';

/** Only explicit relative extends targets already indexed as configs can bind. */
export function resolveConfigExtendsEdges(input: {
  store: ResolutionProjectionStore;
  capture?: ResolutionDependencyCapture;
  sourceFileIds?: readonly string[];
  repoId: string;
  rootPath: string;
}): number {
  let resolved = 0;
  const selected =
    input.sourceFileIds === undefined ? null : new Set(input.sourceFileIds);
  const edges =
    input.capture === undefined
      ? input.store.listConfigExtendsEdges(input.repoId)
      : input.store
          .listEdges({ repoId: input.repoId, kind: 'REFERENCES' })
          .filter(
            (edge): boolean =>
              edge.evidence.configExtends === true &&
              input.store.getFileById(edge.sourceFileId)?.language ===
                'tsconfig',
          );
  for (const edge of edges) {
    if (selected !== null && !selected.has(edge.sourceFileId)) continue;

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
        continue;
      }
      if (edge.evidence.configExtends !== true || edge.targetRef === null)
        continue;
      const file = input.store.getFileById(edge.sourceFileId);
      if (file === null) continue;
      const absolute = path.resolve(
        path.dirname(file.absolutePath),
        edge.targetRef,
      );
      const relative = path.relative(input.rootPath, absolute);
      if (
        relative === '..' ||
        relative.startsWith(`..${path.sep}`) ||
        path.isAbsolute(relative)
      )
        continue;
      const candidates = [relative, `${relative}.json`];
      for (const candidate of candidates) {
        const resolvedPath = canonicalRelativePath(candidate);
        const target = input.store.getSymbolByQualifiedName(
          `${resolvedPath}::config`,
          input.repoId,
        );
        input.capture?.observeUnknown(
          resolutionDependencyKey.configTarget(resolvedPath),
          target,
        );
        if (target?.kind !== 'config') continue;
        input.store.updateEdgeResolution(edge.id, {
          targetSymbolId: target.id,
          confidenceTier: 'RESOLVED',
          confidenceScore: 1,
          resolverId: 'config-extends',
          evidence: { ...edge.evidence, resolvedPath },
        });
        resolved += 1;
        break;
      }
    } finally {
      endSource?.();
    }
  }
  return resolved;
}
