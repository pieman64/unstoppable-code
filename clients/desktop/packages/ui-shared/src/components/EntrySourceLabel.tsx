import type { JSX } from 'react';
import type { UnifiedPluginEntry } from '../lib/unified-plugin-entry';

/**
 * Where a plugin row comes from (`Claude · slackapi`, `Codex official`), as
 * routine plain-text metadata below its title. Plugins only: MCP rows and
 * pipelines render their sources elsewhere or not at all, a shared plugin
 * already names its audience, and a curated plugin's `Curated` is not a
 * source the copy documents (CAN-3653).
 */
/** Whether {@link EntrySourceLabel} renders anything for the entry. */
export function showsEntrySourceLabel(entry: UnifiedPluginEntry): boolean {
  return (
    entry.kind === 'plugin' &&
    entry.origin === 'marketplace' &&
    Boolean(entry.sourceLabel)
  );
}

export function EntrySourceLabel({
  entry,
  testId,
  shrinkable = false,
}: {
  entry: UnifiedPluginEntry;
  testId: string;
  /** Lets a one-line metadata row truncate the label. */
  shrinkable?: boolean;
}): JSX.Element | null {
  if (!showsEntrySourceLabel(entry)) return null;
  return (
    <span
      data-testid={testId}
      className={`${shrinkable ? 'min-w-0 shrink truncate' : 'shrink-0'} text-xs fg-tertiary`}
    >
      {entry.sourceLabel}
    </span>
  );
}
