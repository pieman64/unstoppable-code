import * as path from 'node:path';
import { canonicalRelativePath, fileQualifiedName } from '../ids';
import {
  listEdgesForSourceFiles,
  resolutionDependencyKey,
  type ResolutionDependencyCapture,
} from './resolution-dependency-capture';
import type { ResolutionProjectionStore } from './resolution-projection';

interface ResolvedDocTarget {
  symbolId: string;
  resolvedPath: string;
}

// Tries a single candidate absolute path: it must stay inside the repository
// root and match an existing file symbol's qualified name (the canonical
// relative path) to count as a bind.
function tryCandidate(
  store: ResolutionProjectionStore,
  repoId: string,
  rootPath: string,
  candidateAbsolute: string,
  capture?: ResolutionDependencyCapture,
  fragment = '',
): ResolvedDocTarget | null {
  const relative = path.relative(rootPath, candidateAbsolute);
  // The standard "is this relative path outside the root" idiom: a bare
  // `startsWith('..')` also (mis)matches an in-repo path that merely starts
  // with two literal dots (e.g. a file named `..weird.md`), rejecting a
  // legitimate candidate.
  if (
    relative === '..' ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    return null; // resolved outside this repository root
  }
  const resolvedPath = canonicalRelativePath(relative);
  const symbol = store.getSymbolByQualifiedName(
    fileQualifiedName(resolvedPath),
    repoId,
  );
  capture?.observeUnknown(
    resolutionDependencyKey.docPathFragment(resolvedPath, fragment),
    symbol,
  );
  return symbol === null ? null : { symbolId: symbol.id, resolvedPath };
}

// Markdown links are written three ways in the wild — relative to the
// DOCUMENTING file's own directory ("./other.md"), relative to the repository
// root ("docs/other.md"), and GitHub-style repo-root-ABSOLUTE ("/docs/x.md")
// — so each unresolved target is tried dir-relative first, then
// repo-root-relative, unless the target is root-absolute (leading `/`).
//
// A leading slash makes `path.resolve(rootPath, targetRef)` treat the target
// as FILESYSTEM-absolute (ignoring `rootPath` entirely), so it must be
// stripped and joined onto `rootPath` explicitly rather than falling through
// to the normal relative-candidate flow below. A root-absolute target is
// unambiguous by construction, so there is no dir-relative candidate worth
// also trying.
//
// Percent-encoded targets are not decoded before matching.
function resolveTarget(
  store: ResolutionProjectionStore,
  repoId: string,
  rootPath: string,
  containingDir: string,
  targetRef: string,
  capture?: ResolutionDependencyCapture,
): ResolvedDocTarget | null {
  const fragment = targetRef.includes('#')
    ? targetRef.slice(targetRef.indexOf('#') + 1)
    : '';
  if (targetRef.startsWith('/')) {
    return tryCandidate(
      store,
      repoId,
      rootPath,
      path.resolve(rootPath, targetRef.slice(1)),
      capture,
      fragment,
    );
  }
  const dirRelative = tryCandidate(
    store,
    repoId,
    rootPath,
    path.resolve(containingDir, targetRef),
    capture,
    fragment,
  );
  if (dirRelative !== null) {
    return dirRelative;
  }
  return tryCandidate(
    store,
    repoId,
    rootPath,
    path.resolve(rootPath, targetRef),
    capture,
    fragment,
  );
}

// Post-processing pass for `DOCUMENTS` edges emitted by the markdown
// extractor. There are no directory symbols in the graph, so a link that
// resolves to a directory (rather than a tracked file) never binds — that is
// the correct, honest outcome, not a bug.
export function resolveDocLinkEdges(input: {
  store: ResolutionProjectionStore;
  capture?: ResolutionDependencyCapture;
  sourceFileIds?: readonly string[];
  repoId: string;
  rootPath: string;
}): number {
  let resolved = 0;
  const edges = listEdgesForSourceFiles(
    input.store,
    {
      kind: 'DOCUMENTS',
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
      const bound = resolveTarget(
        input.store,
        input.repoId,
        input.rootPath,
        path.dirname(sourceFile.absolutePath),
        edge.targetRef,
        input.capture,
      );
      if (bound === null) {
        continue; // target file not in graph (or a directory) — stay honest, leave unresolved
      }
      input.store.updateEdgeResolution(edge.id, {
        targetSymbolId: bound.symbolId,
        confidenceTier: 'RESOLVED',
        confidenceScore: 0.95,
        resolverId: 'doc-link',
        evidence: { ...edge.evidence, resolvedPath: bound.resolvedPath },
      });
      resolved += 1;
    } finally {
      endSource?.();
    }
  }
  return resolved;
}
