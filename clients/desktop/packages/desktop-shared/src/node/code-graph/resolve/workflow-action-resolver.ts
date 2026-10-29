import { fileQualifiedName } from '../ids';
import {
  listEdgesForSourceFiles,
  resolutionDependencyKey,
  type ResolutionDependencyCapture,
} from './resolution-dependency-capture';
import type { ResolutionProjectionStore } from './resolution-projection';

// Post-processing pass for the `USES_PIPELINE_ACTION` edges emitted by
// extract/workflow-extractor.ts (`extractWorkflowFacts`): every such edge
// starts with a NULL target and the raw `uses:` string as its `targetRef`,
// since the referenced action's location is not known at extraction time.
//
// GitHub Actions' own `uses:` syntax already fully distinguishes LOCAL from
// EXTERNAL refs by a `./` prefix alone -- no extractor evidence change was
// needed to support this resolver:
//   - LOCAL:    `./path/to/action-dir`         -- resolvable (this resolver).
//   - EXTERNAL: `owner/repo@ref`,
//               `owner/repo/path@ref`,
//               `docker://image[:tag]`          -- never resolvable; there is
//               no local symbol such a ref could ever point to, so it stays
//               unresolved (tier EXTRACTED) FOREVER by design -- the same
//               honesty contract as an IMPORTS_FROM specifier resolving
//               outside the repository (see resolve/import-edge-resolver.ts).
//
// A local ref is a directory path relative to the checked-out repository
// ROOT -- NOT relative to the referencing workflow file's own directory:
// workflows live under `.github/workflows/`, while local actions are
// conventionally checked out elsewhere (e.g. `.github/actions/<name>/`, or
// even the repository root for `uses: ./`), and GitHub resolves the ref
// against $GITHUB_WORKSPACE regardless of where the calling workflow file
// lives. The referenced directory must contain an `action.yml` or
// `action.yaml` manifest. Binding therefore reduces to a plain qualified-name
// lookup for each candidate manifest filename, scoped to the SAME repo -- no
// cross-repo binding, mirroring every other resolver in this package.
//
// Manifest file symbols only exist in the graph because of
// extract/extractor-registry.ts's `github-action-manifest` matcher (a Phase 6
// addition alongside this resolver, routed to `extractActionManifestFacts` in
// workflow-extractor.ts) -- without that matcher these files are invisible to
// the scanner (no grammar, and the `github-workflow` matcher only covers
// `.github/workflows/*.ya?ml`), so this resolver could never bind anything
// DURABLY: `CodeGraphStore.nullDanglingEdgeTargets()` runs before every
// resolver pass and would erase a "resolution" that pointed at a symbol id
// with no matching row in `symbols` on the very next build.
const ACTION_MANIFEST_BASENAMES = ['action.yml', 'action.yaml'] as const;

// Normalizes a `uses:` ref into the repo-root-relative directory GitHub
// resolves it against, or null when the ref is not local at all, or when it
// canonicalizes to a path that escapes the repository root (`..`/`../...`) --
// never a valid action directory. An empty result (`''`) is a VALID directory
// meaning the repository root itself (`uses: ./`).
function localActionDirectory(targetRef: string): string | null {
  if (!targetRef.startsWith('./')) {
    return null;
  }
  const canonical = fileQualifiedName(targetRef).replace(/\/+$/, '');
  if (canonical === '..' || canonical.startsWith('../')) {
    return null;
  }
  return canonical;
}

function joinRepoRelative(directory: string, basename: string): string {
  return directory === '' ? basename : `${directory}/${basename}`;
}

export function resolveWorkflowActionEdges(input: {
  store: ResolutionProjectionStore;
  capture?: ResolutionDependencyCapture;
  sourceFileIds?: readonly string[];
  repoId: string;
}): number {
  let resolved = 0;
  for (const edge of listEdgesForSourceFiles(
    input.store,
    {
      kind: 'USES_PIPELINE_ACTION',
      unresolvedOnly: input.capture === undefined ? true : undefined,
      repoId: input.repoId,
    },
    input.sourceFileIds,
  )) {
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
      const directory = localActionDirectory(edge.targetRef);
      input.capture?.observe(
        resolutionDependencyKey.workflowAction(edge.targetRef),
        { local: directory !== null, directory },
      );
      if (directory === null) {
        continue; // external ref (or a path escaping the repo root) -- stay honestly unresolved
      }
      const candidates: Array<{ id: string; resolvedPath: string }> = [];
      for (const basename of ACTION_MANIFEST_BASENAMES) {
        const candidatePath = joinRepoRelative(directory, basename);
        const symbol = input.store.getSymbolByQualifiedName(
          fileQualifiedName(candidatePath),
          input.repoId,
        );
        input.capture?.observeUnknown(
          resolutionDependencyKey.workflowManifest(candidatePath),
          symbol,
        );
        if (symbol !== null) {
          candidates.push({ id: symbol.id, resolvedPath: candidatePath });
        }
      }
      if (candidates.length === 0) {
        continue; // manifest not in the graph (untracked, unscanned, or missing) -- stay honest
      }
      if (candidates.length > 1) {
        // Both `action.yml` AND `action.yaml` exist for the same directory --
        // an invalid/ambiguous repo state GitHub itself would never accept at
        // runtime, but this resolver stays honest rather than guessing which
        // one wins, exactly like resolve/ipc-resolver.ts's same-key-in-two-
        // files branch.
        input.store.updateEdgeEvidence(edge.id, {
          ...edge.evidence,
          candidates: candidates.length,
        });
        continue;
      }
      const [match] = candidates;
      input.store.updateEdgeResolution(edge.id, {
        targetSymbolId: match.id,
        confidenceTier: 'RESOLVED',
        confidenceScore: 0.95,
        resolverId: 'workflow-action',
        evidence: { ...edge.evidence, resolvedPath: match.resolvedPath },
      });
      resolved += 1;
    } finally {
      endSource?.();
    }
  }
  return resolved;
}
