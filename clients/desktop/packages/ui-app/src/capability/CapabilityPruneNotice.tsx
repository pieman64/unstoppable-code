import type { JSX } from 'react';
import { Notice, NoticeButton } from '@canopy/ui-shared/components';
import type { CapabilityUnavailable } from '@canopy/protocol/capability-bundle';

/** A capability removed from a chat because it is gone for good (REG-3042). */
export interface CapabilityPrune {
  readonly kind: CapabilityUnavailable['ref']['kind'];
  readonly displayName?: string;
  readonly ref?: CapabilityUnavailable['ref'];
}

const UNNAMED: Record<CapabilityPrune['kind'], string> = {
  skill: 'A skill',
  plugin: 'A plugin',
  mcpServer: 'An MCP server',
};

/**
 * "Dropbox was removed from this chat because it's no longer available.",
 * naming at most two capabilities and counting the rest. A capability whose
 * name the server could not recover reads by its kind, never by its key.
 */
export function capabilityPruneNoticeMessage(
  pruned: readonly CapabilityPrune[],
): string {
  const named = pruned.flatMap((entry) =>
    entry.displayName === undefined ? [] : [entry.displayName],
  );
  const unnamed = pruned.length - named.length;
  let subject: string;
  if (pruned.length === 1) {
    subject = named[0] ?? UNNAMED[pruned[0].kind];
  } else if (named.length === 0) {
    subject = `${String(pruned.length)} plugins, skills, or MCP servers`;
  } else if (named.length === 2 && unnamed === 0) {
    subject = `${named[0]} and ${named[1]}`;
  } else {
    const shown = named.slice(0, 2);
    const more = pruned.length - shown.length;
    subject =
      shown.length === 1
        ? `${shown[0]} and ${String(more)} more`
        : `${shown.join(', ')}, and ${String(more)} more`;
  }
  return pruned.length === 1
    ? `${subject} was removed from this chat because it's no longer available.`
    : `${subject} were removed from this chat because they're no longer available.`;
}

/**
 * The one-time notice for capabilities a save or a turn removed from a chat
 * because they are gone for good. It takes the shape of the notice stack it
 * is rendered in; the host decides when it shows and what Dismiss clears.
 */
export function CapabilityPruneNotice({
  pruned,
  onDismiss,
}: {
  readonly pruned: readonly CapabilityPrune[];
  readonly onDismiss: () => void;
}): JSX.Element | null {
  if (pruned.length === 0) return null;
  return (
    <Notice
      icon={null}
      data-testid="chat-capability-prune-notice"
      actions={<NoticeButton onClick={onDismiss}>Dismiss</NoticeButton>}
    >
      {capabilityPruneNoticeMessage(pruned)}
    </Notice>
  );
}
