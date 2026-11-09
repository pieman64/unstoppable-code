'use client';

import { lazy, memo, Suspense, type JSX } from 'react';
import type {
  ClaudeModPluginDetailsTarget,
  ClaudeModsChatContext,
} from '@canopy/protocol/claude-mods';

const LazyClaudeModsSkippedPart = lazy(async () => {
  const module = await import('./ClaudeModsSkippedNotice');
  return { default: module.ClaudeModsSkippedPart };
});

export interface DeferredClaudeModsSkippedPartProps {
  /** A Portal `mods_skipped` part's untyped data. */
  readonly data: unknown;
  readonly context?: ClaudeModsChatContext;
  readonly onOpenDetails?: (details: ClaudeModPluginDetailsTarget) => void;
}

/**
 * The skipped-Mod notice for a Portal `mods_skipped` part, loaded when a
 * transcript first shows one. Only desktop sessions record skipped Mods, so
 * the web chat routes, whose first load is budgeted, render this instead of
 * carrying the notice.
 */
function DeferredClaudeModsSkippedPartComponent({
  data,
  context,
  onOpenDetails,
}: DeferredClaudeModsSkippedPartProps): JSX.Element {
  return (
    <Suspense fallback={null}>
      <LazyClaudeModsSkippedPart
        data={data}
        {...(context !== undefined ? { context } : {})}
        {...(onOpenDetails !== undefined ? { onOpenDetails } : {})}
      />
    </Suspense>
  );
}

export const DeferredClaudeModsSkippedPart = memo(
  DeferredClaudeModsSkippedPartComponent,
);
