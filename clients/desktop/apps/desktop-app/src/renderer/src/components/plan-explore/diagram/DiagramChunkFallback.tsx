import type { JSX } from 'react';

/**
 * Shown in place of a plan diagram for the moment its React Flow code is
 * loading: the diagram's empty frame, with no content of its own.
 */
export function DiagramChunkFallback(): JSX.Element {
  return <div className="flex min-h-0 flex-1 flex-col" />;
}
