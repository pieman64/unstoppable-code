import type { JSX } from 'react';
import {
  getModelDisplayName,
  type ArchivedChatSummary,
} from '@canopy/desktop-shared/types';
import { CHAT_UNIT_LABEL } from '@canopy/protocol';
import { Tooltip } from '@canopy/ui-shared';
import { SummaryIcon, UnarchiveIcon } from '@canopy/ui-shared/icons/AppIcons';
import { AgentProviderIcon } from '@/lib/providerUi';
import { getArchivedChatDisplayLabel } from '@/components/standalone-chat/chat-label';
import { LoadingSpinner } from '../shared/loading/spinners/LoadingSpinner';
import { POSTHOG_REPLAY_MASK_CLASS } from '@canopy/desktop-instrumentation/posthog-replay-privacy';

export interface ArchivedChatRowProps {
  summary: ArchivedChatSummary;
  /** Open the full read-only transcript viewer for this archived chat. */
  onOpen: () => void;
  /** Restore the archived chat into the live tabs. */
  onRestore: () => void;
  /** Summarize the archived chat into a fresh tab draft. */
  onSummarize: () => void;
  /** True while this row's Summarize request is in flight. */
  summarizing?: boolean;
  /** True while this row's Restore request is in flight. */
  restoring?: boolean;
  /** Stable testid hook for automation on the outer wrapper. */
  dataTestId?: string;
}

const actionBaseClass =
  'flex h-7 w-7 shrink-0 items-center justify-center rounded-md transition-colors disabled:cursor-not-allowed disabled:opacity-50';

/**
 * One archived-chat list row, shared by the hover popover and the full modal.
 * Renders the provider icon, the chat's display label + a model/turn-count
 * sub-line, and the Restore / Summarize actions. The label leads with the
 * agent-generated title (`description`) and drops the raw `title` entirely
 * when one exists, so the row reads the way the live chat tab did. Restore is
 * only shown while the chat is still `restorable` (within the backend's 7-day
 * window); otherwise only Summarize is offered. Layout modelled after
 * `StandaloneChatRow`.
 */
export function ArchivedChatRow({
  summary,
  onOpen,
  onRestore,
  onSummarize,
  summarizing = false,
  restoring = false,
  dataTestId,
}: ArchivedChatRowProps): JSX.Element {
  const busy = summarizing || restoring;
  const turnLabel = `${summary.turnCount} ${
    summary.turnCount === 1 ? 'turn' : 'turns'
  }`;
  const modelLabel = summary.model
    ? getModelDisplayName(summary.model)
    : undefined;
  const label = getArchivedChatDisplayLabel(summary);
  // The generated title is promoted to the primary line above, so the sub-line
  // carries only the metadata that is not already shown there.
  const subLine = [modelLabel, turnLabel]
    .filter((part): part is string => Boolean(part))
    .join(' · ');

  return (
    <div
      data-testid={dataTestId}
      data-archived-chat-id={summary.chatId}
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e): void => {
        if (e.currentTarget !== e.target) {
          return;
        }
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onOpen();
        }
      }}
      className="group flex w-full cursor-pointer items-center gap-2 rounded-md px-3 py-2 text-left text-sm fg-secondary transition hover:bg-fg-primary/[0.04] focus:outline-none focus-visible:ring-1 focus-visible:ring-line-focus"
    >
      <span
        data-unread={summary.unread ? 'true' : undefined}
        className={`shrink-0 ${summary.unread ? 'text-amber-400' : 'fg-secondary'}`}
      >
        {summary.providerType ? (
          <AgentProviderIcon
            provider={summary.providerType}
            width={14}
            height={14}
          />
        ) : (
          <span
            aria-hidden="true"
            className={`inline-block h-2 w-2 rounded-full ${
              summary.unread ? 'bg-amber-400' : 'bg-fg-secondary/60'
            }`}
          />
        )}
      </span>
      <div className="min-w-0 flex-1">
        <p
          className={`${POSTHOG_REPLAY_MASK_CLASS} truncate text-xs font-medium leading-snug fg-primary/80`}
          title={label}
        >
          {label}
        </p>
        {subLine && <p className="truncate text-3xs fg-secondary">{subLine}</p>}
      </div>
      {summary.restorable && (
        <Tooltip label={`Restore ${CHAT_UNIT_LABEL}`}>
          <button
            type="button"
            onClick={(e): void => {
              e.stopPropagation();
              onRestore();
            }}
            disabled={busy}
            aria-label={`Restore ${CHAT_UNIT_LABEL}`}
            data-testid="archived-chat-restore"
            className={`${actionBaseClass} fg-accent enabled:hover:bg-accent-subtle`}
          >
            {restoring ? <LoadingSpinner /> : <UnarchiveIcon size={16} />}
          </button>
        </Tooltip>
      )}
      <Tooltip label="Summarize">
        <button
          type="button"
          onClick={(e): void => {
            e.stopPropagation();
            onSummarize();
          }}
          disabled={busy}
          aria-label="Summarize"
          data-testid="archived-chat-summarize"
          className={`${actionBaseClass} fg-secondary enabled:hover:bg-subtle enabled:hover:fg-primary`}
        >
          {summarizing ? <LoadingSpinner /> : <SummaryIcon size={16} />}
        </button>
      </Tooltip>
    </div>
  );
}
