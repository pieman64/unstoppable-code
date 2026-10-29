import {
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type JSX,
  type KeyboardEvent,
} from 'react';
import type { CoworkWorkEntryMeta } from '@canopy/desktop-shared/types';
import { DEFAULT_ARCHIVE_RETENTION_DAYS } from '@canopy/desktop-shared/lib/archive-retention';
import {
  ArchiveIcon,
  ChatIcon,
  CheckIcon,
  MoreHorizontalIcon,
  PencilIcon,
  PinIcon,
  TrashIcon,
} from '@canopy/ui-shared/icons/AppIcons';
import {
  ActionMenuItems,
  ActionMenuRowStyle,
  RailIconButton,
  SidebarPinnedBadge,
  ThinkingSpinner,
  type ActionMenuItem,
} from '@canopy/ui-shared/components';
import { OPERATIONAL_STATUS_COLORS } from '@canopy/ui-shared/lib';
import { WorktreeSortableStateContext } from '@canopy/ui-app/sidebar';
import type { WorktreeMenuItem } from '@canopy/ui-shared/components';
import { AnchoredMenu } from '../shared/AnchoredMenu';
import { InlineDeleteConfirm } from '../activity/workspace-items-shared';
import { POSTHOG_REPLAY_MASK_CLASS } from '@canopy/desktop-instrumentation/posthog-replay-privacy';

/** Which retained state a Work Entry removal lands in. */
export type WorkEntryRemovalMode = 'delete' | 'archive';

export interface WorkEntryRemovalOptions {
  mode: WorkEntryRemovalMode;
}

export interface WorkEntryListItemProps {
  groupMenu?: readonly WorktreeMenuItem[];
  entry: CoworkWorkEntryMeta;
  selected: boolean;
  onSelect: () => void;
  onRename: (title: string | null) => void;
  /**
   * Remove the entry into the workspace's retained containers: `delete`
   * keeps it for the retention window, `archive` keeps it until deleted.
   */
  onDelete: (options: WorkEntryRemovalOptions) => void;
  deleting: boolean;
  /**
   * Pins or unpins the entry to the top of its list. Supplying it adds
   * Pin to top / Unpin as the menu's first item, as every sidebar item menu
   * leads with it; a pinned entry shows the shared pin mark at rest.
   */
  onSetPinned?: (pinned: boolean) => void;
  /**
   * Test-id prefix for the row and its interactive children. Defaults to the
   * unified sidebar's original `sidebar-work-entry` contract so existing
   * Electron selectors keep resolving; other surfaces (e.g. the App Advisor
   * nav) pass their own prefix.
   */
  testIdPrefix?: string;
  /**
   * Effective deletion-retention window in days (via
   * `resolveArchiveRetentionDays`): how long a deleted entry is kept before
   * it is removed. Drives the Delete tooltip / confirmation copy.
   */
  effectiveRetentionDays?: number;
}

/** Tooltip for the Delete affordance: how long the deleted chat is kept. */
// eslint-disable-next-line react-refresh/only-export-components -- tiny label helper shared with the sidebar's inline entry row
export function deleteRetentionTooltip(days: number): string {
  return `Kept for ${days} ${days === 1 ? 'day' : 'days'}, then removed`;
}

/** Tooltip for the Archive affordance. */
export const ARCHIVE_TOOLTIP = 'Kept until you delete it';

/**
 * The row's "…" menu: Pin first, then the group organizer, Rename, and
 * Archive and Delete in their own last group, as every sidebar row menu.
 */
function workEntryListItemMenuItems({
  pinned,
  testIdBase,
  groupMenu,
  archiveTitle,
  deleteTitle,
  onTogglePin,
  onRename,
  onRemove,
}: {
  pinned: boolean;
  testIdBase: string;
  groupMenu?: readonly WorktreeMenuItem[];
  archiveTitle: string;
  deleteTitle: string;
  onTogglePin?: (pinned: boolean) => void;
  onRename: () => void;
  onRemove: (mode: WorkEntryRemovalMode) => void;
}): ActionMenuItem[] {
  const items: ActionMenuItem[] = [];
  if (onTogglePin) {
    items.push({
      key: 'toggle-pin',
      label: pinned ? 'Unpin' : 'Pin to top',
      icon: <PinIcon />,
      onSelect: (): void => onTogglePin(!pinned),
      testId: `${testIdBase}-toggle-pin`,
    });
  }
  items.push(...(groupMenu ?? []), {
    key: 'rename',
    label: 'Rename',
    icon: <PencilIcon />,
    onSelect: onRename,
    testId: `${testIdBase}-rename`,
  });
  items.push(
    {
      key: 'archive',
      label: 'Archive',
      icon: <ArchiveIcon />,
      tooltip: archiveTitle,
      onSelect: (): void => onRemove('archive'),
      separatorBefore: true,
      testId: `${testIdBase}-archive`,
    },
    {
      key: 'delete',
      label: 'Delete',
      icon: <TrashIcon />,
      tooltip: deleteTitle,
      onSelect: (): void => onRemove('delete'),
      testId: `${testIdBase}-delete`,
    },
  );
  return items;
}

/**
 * One Work Entry row: leading status slot (thinking spinner / unread glyph,
 * meta-derived) + title with a hover "…" menu offering Rename (inline text
 * input; Enter saves, Esc cancels), Delete (two-step inline confirm; kept
 * for the retention window), and Archive (two-step inline confirm; kept
 * until deleted).
 *
 * Presentation matches the unified sidebar's inline entry row (which itself
 * mirrors the code-workspace worktree rows) so the App Advisor nav and the
 * main sidebar read as one system; this variant stays presentational (no
 * chat-store subscriptions, no drag) for non-sortable hosts.
 */
export function WorkEntryListItem({
  entry,
  groupMenu,
  selected,
  onSelect,
  onRename,
  onDelete,
  deleting,
  onSetPinned,
  testIdPrefix = 'sidebar-work-entry',
  effectiveRetentionDays = DEFAULT_ARCHIVE_RETENTION_DAYS,
}: WorkEntryListItemProps): JSX.Element {
  const drag = useContext(WorktreeSortableStateContext);
  const deleteTitle = deleteRetentionTooltip(effectiveRetentionDays);
  const [menuOpen, setMenuOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState(entry.title);
  const [confirmingRemoval, setConfirmingRemoval] =
    useState<WorkEntryRemovalMode | null>(null);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (renaming) {
      renameInputRef.current?.focus();
      renameInputRef.current?.select();
    }
  }, [renaming]);

  const isThinking = entry.hasActiveChat ?? false;
  const hasUnread = !isThinking && (entry.unreadChats?.length ?? 0) > 0;
  // Mirrors `computeWorktreeUiStatus`: done outranks every other state so a
  // finished Cowork entry reads the same as a done code worktree.
  const isDone = entry.status === 'done';
  const statusContent = isDone ? (
    // `merged`, not `success`: `WorktreeStatusIndicator` / `WorktreeRow` paint
    // the code-worktree done state with the merged (purple) token, and Cowork
    // must read as the same state rather than a second green "success" color.
    <span
      className={`flex h-3.5 w-3.5 shrink-0 items-center justify-center ${OPERATIONAL_STATUS_COLORS.merged.foreground}`}
      role="img"
      title="Done"
      aria-label="Done"
      data-testid={`${testIdPrefix}-${entry.id}-done`}
    >
      <CheckIcon width={14} height={14} aria-hidden="true" />
    </span>
  ) : isThinking ? (
    <span
      className="flex h-3.5 w-3.5 shrink-0 items-center justify-center"
      data-testid={`${testIdPrefix}-${entry.id}-thinking`}
    >
      <ThinkingSpinner tone="active" />
    </span>
  ) : hasUnread ? (
    <span
      className={`flex h-3.5 w-3.5 shrink-0 items-center justify-center ${OPERATIONAL_STATUS_COLORS.unread.foreground}`}
      role="img"
      aria-label="Unread messages"
      data-testid={`${testIdPrefix}-${entry.id}-unread`}
    >
      <ChatIcon width={14} height={14} aria-hidden="true" />
    </span>
  ) : null;
  const leadingSlot = (
    <span
      className="inline-flex h-5 w-5 shrink-0 items-center justify-center"
      aria-hidden={statusContent === null ? 'true' : undefined}
      data-testid={`${testIdPrefix}-${entry.id}-status-slot`}
    >
      {statusContent}
    </span>
  );

  const commitRename = useCallback((): void => {
    const trimmed = renameValue.trim();
    setRenaming(false);
    if (trimmed === entry.title) {
      return;
    }
    // An emptied title clears the rename override (falls back to the
    // chat-derived title).
    onRename(trimmed.length > 0 ? trimmed : null);
  }, [renameValue, entry.title, onRename]);

  const handleRenameKeyDown = useCallback(
    (event: KeyboardEvent<HTMLInputElement>): void => {
      if (event.key === 'Enter') {
        event.preventDefault();
        commitRename();
      } else if (event.key === 'Escape') {
        event.preventDefault();
        setRenaming(false);
      }
    },
    [commitRename],
  );

  if (renaming) {
    return (
      <div
        className="flex h-8 w-full items-center gap-1.5 rounded-row px-1.5"
        data-testid={`${testIdPrefix}-${entry.id}`}
      >
        {leadingSlot}
        <input
          ref={renameInputRef}
          type="text"
          value={renameValue}
          onChange={(e) => setRenameValue(e.target.value)}
          onKeyDown={handleRenameKeyDown}
          onBlur={() => setRenaming(false)}
          data-testid={`${testIdPrefix}-${entry.id}-rename-input`}
          className="w-full min-w-0 flex-1 rounded-md border bg-fg-primary/[0.03] px-2 py-1 text-s fg-primary focus:border-fg-primary/20 focus:outline-none"
          aria-label="Rename work entry"
        />
      </div>
    );
  }

  return (
    <div
      {...drag?.attributes}
      role="button"
      tabIndex={0}
      data-testid={`${testIdPrefix}-${entry.id}`}
      data-standalone-chat-id={entry.id}
      data-entry-selected={selected ? 'true' : 'false'}
      data-entry-status={isDone ? 'done' : 'active'}
      onClick={(event): void => {
        if (!event.defaultPrevented) onSelect();
      }}
      onKeyDown={(event) => {
        if (
          !event.defaultPrevented &&
          (event.key === 'Enter' || event.key === ' ')
        ) {
          event.preventDefault();
          onSelect();
        }
      }}
      className={`group group/sidebar-item flex h-8 w-full cursor-pointer select-none items-center gap-1.5 rounded-row py-0 pl-1.5 pr-1 text-left text-s transition ${
        selected ? 'bg-muted fg-primary' : 'fg-secondary hover:bg-subtle'
      } ${deleting ? 'pointer-events-none opacity-50' : ''}`}
    >
      {leadingSlot}
      <p
        className={`${POSTHOG_REPLAY_MASK_CLASS} min-w-0 flex-1 truncate text-s font-normal leading-snug ${
          isDone ? 'opacity-70' : ''
        }`}
        title={entry.title}
      >
        {entry.title}
      </p>
      {confirmingRemoval !== null ? (
        <span
          className="flex shrink-0 items-center"
          title={
            confirmingRemoval === 'archive' ? ARCHIVE_TOOLTIP : deleteTitle
          }
        >
          <InlineDeleteConfirm
            onConfirm={() => {
              const mode = confirmingRemoval;
              setConfirmingRemoval(null);
              onDelete({ mode });
            }}
            onCancel={() => setConfirmingRemoval(null)}
            deleting={deleting}
            confirmLabel={
              confirmingRemoval === 'archive' ? 'Archive?' : undefined
            }
          />
        </span>
      ) : (
        <span className="relative flex shrink-0 items-center">
          {entry.pinned === true && (
            // At rest the pin holds the spot the hover "…" reveals into, and
            // fades as the "…" appears, as it does on the main sidebar's rows.
            <SidebarPinnedBadge
              testId={`${testIdPrefix}-${entry.id}-pinned`}
              className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 pointer-coarse:hidden"
            />
          )}
          <RailIconButton
            ref={menuButtonRef}
            icon={MoreHorizontalIcon}
            iconSize={12}
            revealOnItemHover
            coarsePointerTarget
            onClick={(e) => {
              e.stopPropagation();
              setMenuOpen((open) => !open);
            }}
            aria-label="Work entry options"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            data-testid={`${testIdPrefix}-${entry.id}-menu`}
          />
          <AnchoredMenu
            open={menuOpen}
            onClose={() => setMenuOpen(false)}
            anchorRef={menuButtonRef}
            placement="below-start"
            portal
            testId={`${testIdPrefix}-${entry.id}-menu-popover`}
            className="sidebar-instant-interactions w-36"
          >
            <ActionMenuRowStyle>
              <ActionMenuItems
                items={workEntryListItemMenuItems({
                  pinned: entry.pinned === true,
                  testIdBase: `${testIdPrefix}-${entry.id}`,
                  groupMenu,
                  archiveTitle: ARCHIVE_TOOLTIP,
                  deleteTitle,
                  onTogglePin: onSetPinned,
                  onRename: (): void => {
                    setRenameValue(entry.title);
                    setRenaming(true);
                  },
                  onRemove: setConfirmingRemoval,
                })}
                onSelect={(action): void => {
                  if (action.disabled || !action.onSelect) return;
                  setMenuOpen(false);
                  action.onSelect();
                }}
              />
            </ActionMenuRowStyle>
          </AnchoredMenu>
        </span>
      )}
    </div>
  );
}
