import {
  listEdgesForSourceFiles,
  resolutionDependencyKey,
  type ResolutionDependencyCapture,
} from './resolution-dependency-capture';
import type { ResolutionProjectionStore } from './resolution-projection';

// Post-processing pass for the `IPC_HANDLES` / `IPC_INVOKES` edges emitted by
// extract/canopy-patterns.ts (see that module's
// `extractHandlerAndInvokerEdges`): every such edge starts with a NULL target
// and a synthetic `ipc:<key>` targetRef, since the channel declaration site
// is not known at extraction time.
//
// Channel symbols are deterministic by construction
// (extractChannelDeclarations): an `ipc_channel` symbol's `name` is always
// the bare channel key -- regardless of WHICH `*_CHANNELS` registry constant
// declared it (P6 generalization; the registry name lives in the symbol's
// `extra.registry`, not in its name/kind) -- and its `kind` is always
// `ipc_channel`. So binding reduces to a plain (kind, name) lookup scoped to
// the SAME repo -- no cross-repo binding, mirroring every other resolver in
// this package. A key declared by TWO different registries in one repo hits
// the same more-than-one-candidate branch as a same-registry duplicate:
// binding to either declaration would be a guess, so the edge honestly stays
// unresolved with `candidates` evidence.
const IPC_TARGET_REF_PREFIX = 'ipc:';

export function resolveIpcEdges(input: {
  store: ResolutionProjectionStore;
  capture?: ResolutionDependencyCapture;
  sourceFileIds?: readonly string[];
  repoId: string;
}): number {
  let resolved = 0;
  const kinds = ['IPC_HANDLES', 'IPC_INVOKES'] as const;
  for (const kind of kinds) {
    for (const edge of listEdgesForSourceFiles(
      input.store,
      {
        kind,
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
        if (
          edge.targetRef === null ||
          !edge.targetRef.startsWith(IPC_TARGET_REF_PREFIX)
        ) {
          continue;
        }
        const key = edge.targetRef.slice(IPC_TARGET_REF_PREFIX.length);
        const candidates = input.store.listSymbolsByKindAndName(
          'ipc_channel',
          key,
          input.repoId,
        );
        input.capture?.observeUnknown(
          resolutionDependencyKey.ipcNamespace('key', key),
          candidates,
        );
        if (candidates.length === 0) {
          continue; // unknown/typo'd channel key -- stay honest, leave unresolved
        }
        if (candidates.length > 1) {
          // Ambiguous: two (or more) files declare the same channel key in
          // this repo. `updateEdgeResolution` always writes a resolution
          // (target symbol + confidence + resolver id), which would be
          // dishonest here since the edge is NOT actually resolved -- so this
          // uses the narrower `updateEdgeEvidence` to record the candidate
          // count without touching the resolution fields.
          input.store.updateEdgeEvidence(edge.id, {
            ...edge.evidence,
            candidates: candidates.length,
          });
          continue;
        }
        const channel = candidates[0];
        const channelFile = input.store.getFileById(channel.fileId);
        if (channelFile === null) {
          continue; // shouldn't happen -- the symbol's own file record must exist
        }
        input.store.updateEdgeResolution(edge.id, {
          targetSymbolId: channel.id,
          confidenceTier: 'RESOLVED',
          confidenceScore: 0.95,
          resolverId: 'ipc-channel',
          evidence: {
            ...edge.evidence,
            resolvedPath: channelFile.relativePath,
          },
        });
        resolved += 1;
      } finally {
        endSource?.();
      }
    }
  }
  return resolved;
}
