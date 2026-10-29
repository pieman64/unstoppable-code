import type { JSX } from 'react';
import { ArchiveIcon } from '@canopy/ui-shared/icons';
import { ActionTooltip } from '@/components/shared/ActionTooltip';
import { DELEGATES_DEFER_AUTO_ARCHIVE_TOOLTIP } from '@/stores/chat/close-guard';
import {
  selectChatHasLiveDelegates,
  useDelegationActivityStore,
} from '@/stores/delegationActivityStore';

export interface AutoArchiveToggleButtonProps {
  enabled: boolean;
  onToggle: () => void;
  /**
   * The chat the toggle belongs to. While it has live managed delegates the
   * tooltip says archiving waits for them.
   */
  target?: { projectId: string; worktreeId: string; chatId: string };
}

export function AutoArchiveToggleButton({
  enabled,
  onToggle,
  target,
}: AutoArchiveToggleButtonProps): JSX.Element {
  const hasLiveDelegates = useDelegationActivityStore((state) =>
    target === undefined
      ? false
      : selectChatHasLiveDelegates(
          state,
          target.projectId,
          target.worktreeId,
          target.chatId,
        ),
  );
  const buttonClassName = enabled
    ? 'focus-ring flex h-6 w-6 items-center justify-center rounded-md border border-line-accent/40 bg-accent-subtle fg-accent transition hover:bg-accent-subtle/80'
    : 'focus-ring flex h-6 w-6 items-center justify-center rounded-md border bg-fg-primary/[0.04] fg-primary/80 transition hover:bg-fg-primary/[0.08] hover:fg-primary';

  const enabledDescription =
    'This chat will move to the archive when the current turn finishes. Click to keep it open.';

  return (
    <ActionTooltip
      title={enabled ? 'Auto-archive enabled' : 'Auto-archive disabled'}
      description={
        enabled
          ? hasLiveDelegates
            ? `${enabledDescription} ${DELEGATES_DEFER_AUTO_ARCHIVE_TOOLTIP}`
            : enabledDescription
          : 'This chat was marked for auto-archive, but will stay open unless you turn it back on before this turn finishes.'
      }
    >
      <button
        type="button"
        className={buttonClassName}
        onClick={onToggle}
        aria-pressed={enabled}
        aria-label={
          enabled
            ? 'Disable auto-archive for this turn'
            : 'Enable auto-archive for this turn'
        }
        data-testid="auto-archive-toggle"
        data-delegates-live={hasLiveDelegates ? 'true' : undefined}
      >
        <ArchiveIcon width="13" height="13" aria-hidden="true" />
      </button>
    </ActionTooltip>
  );
}
