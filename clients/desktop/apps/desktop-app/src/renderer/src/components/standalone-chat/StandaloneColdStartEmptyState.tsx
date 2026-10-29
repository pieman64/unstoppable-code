import type { JSX } from 'react';
import { CHAT_UNIT_LABEL, CHAT_UNIT_LABEL_PLURAL } from '@canopy/protocol';
import { PlusIcon as AppCatalogPlusIcon } from '@canopy/ui-shared/icons/AppIcons';

interface StandaloneColdStartEmptyStateProps {
  onNewChat: () => void;
}

/**
 * Full-area cold-start empty state for the Cowork tab shown when the user has
 * no chat activity yet (no message has been sent). An empty chat tab is
 * auto-provisioned on first load, so the gate keys on activity rather than on
 * chats literally not existing — see the cold-start gate in `StandaloneChatPage`.
 * Replaces the entire split layout (conversation pane, workspace panel) with
 * a single centered CTA so a brand-new user sees no sidebar or other visual
 * noise.
 *
 * Distinct from the grid's empty chat state, which handles the "chats exist but none
 * is selected" case inside the conversation pane and still keeps the sidebar.
 */
export function StandaloneColdStartEmptyState({
  onNewChat,
}: StandaloneColdStartEmptyStateProps): JSX.Element {
  return (
    <div
      data-testid="cowork-empty-state"
      className="flex h-full flex-1 flex-col"
    >
      {/* Preserve a draggable title-bar strip — the conversation header (which
          normally owns it) is not rendered in the cold-start view. */}
      <div className="electron-drag h-10 shrink-0" />
      <div className="flex flex-1 flex-col items-center justify-center p-8">
        <div className="max-w-md text-center">
          <h2 className="text-lg font-medium fg-primary">
            No {CHAT_UNIT_LABEL_PLURAL.toLowerCase()} yet
          </h2>
          <p className="mt-1 text-s fg-secondary">
            Start a new {CHAT_UNIT_LABEL.toLowerCase()} to get started.
          </p>
          <button
            type="button"
            onClick={onNewChat}
            data-testid="empty-new-chat"
            className="focus-ring mt-5 inline-flex items-center gap-2 rounded-md border border-line-accent bg-transparent px-3.5 py-2 text-s font-medium fg-accent transition-colors hover:bg-accent-subtle"
          >
            <AppCatalogPlusIcon width="14" height="14" aria-hidden="true" />
            New {CHAT_UNIT_LABEL}
          </button>
        </div>
      </div>
    </div>
  );
}
