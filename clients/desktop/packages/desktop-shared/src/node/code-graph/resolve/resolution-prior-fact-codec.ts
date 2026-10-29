import { fileFromRow, symbolFromRow, edgeFromRow } from '../store/graph-store';
import type { PriorResolutionSourceFacts } from '../store/resolution-prior-facts';
import type { ResolutionFileFactImage } from './resolution-change-keys';

/** Same internal row codecs as immutable store reads; no new fact semantics. */
export function priorResolutionFileImage(
  prior: PriorResolutionSourceFacts,
): ResolutionFileFactImage {
  return {
    file: prior.previousFile === null ? null : fileFromRow(prior.previousFile),
    symbols: prior.previousSymbols.map(symbolFromRow),
    edges: prior.previousEdges.map(edgeFromRow),
  };
}
