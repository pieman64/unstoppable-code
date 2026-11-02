import { canonicalRelativePath } from '../ids';
import {
  resolutionDependencyKey,
  type ResolutionDependencyKey,
} from './resolution-dependency-capture';
import type {
  CodeGraphFileRecord,
  CodeGraphSymbolRecord,
  CodeGraphEdgeRecord,
} from '../types/code-graph';

export interface ResolutionFileFactImage {
  file: CodeGraphFileRecord | null;
  symbols: readonly CodeGraphSymbolRecord[];
  edges: readonly CodeGraphEdgeRecord[];
}

/** Tuple encoding is for closure queue identity only; captured keys use its factories. */
export function resolutionTuple(parts: readonly string[]): string {
  return JSON.stringify(parts);
}

function lexicalOrder(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Seed old AND new membership domains. Negative export-name consumers also
 * observe moduleSymbols/moduleImports at every visited module; alias closure
 * expands those keys for every newly affected source until a fixed point.
 * Host-only fingerprints/directory probes remain validated by resolution_inputs;
 * when they change without localizable indexed images, choose full repository.
 */
export function changedFileFactKeys(
  repoId: string,
  before: ResolutionFileFactImage,
  after: ResolutionFileFactImage,
): ResolutionDependencyKey[] {
  const result = new Map<string, ResolutionDependencyKey>();
  const put = (key: ResolutionDependencyKey): void => {
    result.set(resolutionTuple([key.dependencyKind, key.dependencyKey]), key);
  };
  for (const image of [before, after]) {
    const file = image.file;
    if (file !== null) {
      const relative = canonicalRelativePath(file.relativePath);
      put({ dependencyKind: 'store-file', dependencyKey: file.id });
      put(resolutionDependencyKey.qualifiedName(repoId, relative));
      put(resolutionDependencyKey.symbolsForFile(file.id));
      put(resolutionDependencyKey.moduleSymbols(file.id));
      put(resolutionDependencyKey.moduleImports(file.id));
      put(resolutionDependencyKey.moduleCandidate(relative));
      put(resolutionDependencyKey.configTarget(relative));
      put(resolutionDependencyKey.workflowManifest(relative));
      put(resolutionDependencyKey.tsReadInput(relative));
      put(resolutionDependencyKey.tsFileExists(relative));
      const segments = relative.split('/');
      segments.pop();
      for (let count = 0; count <= segments.length; count += 1) {
        const directory = segments.slice(0, count).join('/') || '.';
        put(resolutionDependencyKey.tsDirectoryExists(directory));
        put(resolutionDependencyKey.tsGetDirectories(directory));
      }
    }
    for (const symbol of image.symbols) {
      put(resolutionDependencyKey.qualifiedName(repoId, symbol.qualifiedName));
      put(
        resolutionDependencyKey.symbolsByKindAndName(
          repoId,
          symbol.kind,
          symbol.name,
        ),
      );
      put(resolutionDependencyKey.symbolsForFile(symbol.fileId));
      put(resolutionDependencyKey.moduleSymbols(symbol.fileId));
      if (file !== null)
        put(
          resolutionDependencyKey.exportedName(file.relativePath, symbol.name),
        );
      if (symbol.kind === 'ipc_channel') {
        // Instrumented IPC resolver observes the broad key namespace as well
        // as registry/value details; uniqueness changes can invalidate all IPC.
        put(resolutionDependencyKey.ipcNamespace('key', symbol.name));
        if (typeof symbol.extra.registry === 'string')
          put(
            resolutionDependencyKey.ipcNamespace(
              symbol.extra.registry,
              symbol.name,
            ),
          );
        if (symbol.signature !== null)
          put(resolutionDependencyKey.ipcNamespace('value', symbol.signature));
      }
    }
    for (const edge of image.edges) {
      put(resolutionDependencyKey.sourceLexical(edge.sourceFileId, edge.id));
      if (edge.kind === 'IMPORTS_FROM') {
        put(resolutionDependencyKey.moduleImports(edge.sourceFileId));
        if (edge.targetRef !== null)
          put(
            resolutionDependencyKey.moduleSpecifier(
              edge.sourceFileId,
              edge.targetRef,
            ),
          );
      }
      if (edge.kind === 'CALLS')
        put(
          resolutionDependencyKey.testCallCandidate(
            edge.sourceFileId,
            edge.targetRef ?? '',
          ),
        );
      if (edge.kind === 'USES_PIPELINE_ACTION' && edge.targetRef !== null)
        put(resolutionDependencyKey.workflowAction(edge.targetRef));
    }
  }
  return Array.from(result.values()).sort(
    (left, right): number =>
      lexicalOrder(left.dependencyKind, right.dependencyKind) ||
      lexicalOrder(left.dependencyKey, right.dependencyKey),
  );
}
