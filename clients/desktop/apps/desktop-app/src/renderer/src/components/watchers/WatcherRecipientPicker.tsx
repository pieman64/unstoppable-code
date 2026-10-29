// Grouped recipient picker for choosing the chat a watcher posts to when it
// fires (the watcher's `destination`). Shared by the chat-surface watcher
// modal's "Add" action (App Advisor recipients only) and the pipeline-run
// modal's watcher toggle (App Advisor recipients plus the current worktree's
// chats). Renders a rich dropdown with inline group headers and a separator
// between groups; each group header (and the selected recipient on the trigger)
// is prefixed with its group icon — the App Advisor glyph for App Advisor chats
// and a chat bubble for the current worktree's chats.
//
// The open menu is portaled to `document.body` and positioned with `fixed`
// coordinates derived from the trigger's bounding rect, so it is never clipped
// by an ancestor's `overflow-hidden` (e.g. the pipeline-run dialog modal).

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { JSX, KeyboardEvent, SVGProps } from 'react';
import { createPortal } from 'react-dom';
import type { AppAdvisorWatcherDestination } from '@canopy/desktop-shared/types';
import { AppAdvisorIcon, ChatIcon } from '@canopy/ui-shared/icons';
import {
  ChevronDownMediumIcon as AppCatalogChevronDownMediumIcon,
  CheckIcon as AppCatalogCheckIcon,
} from '@canopy/ui-shared/icons/AppIcons';

const MENU_GAP = 4;
const VIEWPORT_PADDING = 8;

type RecipientGroupKey = 'app-advisor' | 'worktree';

/**
 * Icon for a recipient group, keyed by group: the App Advisor glyph for App
 * Advisor chats and a chat bubble for the current worktree's chats. Reused for
 * both the group headers and the selected-recipient display on the trigger so
 * the picker reads consistently in the pipeline-run modal and the chat watcher
 * management modal.
 */
function RecipientGroupIcon({
  groupKey,
  ...props
}: { groupKey: RecipientGroupKey } & SVGProps<SVGSVGElement>): JSX.Element {
  const Icon = groupKey === 'app-advisor' ? AppAdvisorIcon : ChatIcon;
  return <Icon {...props} />;
}

export interface WatcherRecipientOption {
  /** Destination chat the fired watcher posts to. */
  destination: AppAdvisorWatcherDestination;
  /** Display label (chat title). */
  label: string;
  /**
   * When true this option is the preferred default selection (e.g. the active
   * chat in the relevant worktree). Consumers that auto-select a recipient
   * should prefer it over list order.
   */
  preferredDefault?: boolean;
}

export interface WatcherRecipientGroup {
  key: RecipientGroupKey;
  /** Inline header label for this group. */
  label: string;
  options: WatcherRecipientOption[];
}

export interface WatcherRecipientPickerProps {
  groups: WatcherRecipientGroup[];
  value: AppAdvisorWatcherDestination | null;
  onChange: (destination: AppAdvisorWatcherDestination) => void;
  placeholder?: string;
  disabled?: boolean;
  /** Open above (`top`) or below (`bottom`) the trigger. Defaults to bottom. */
  placement?: 'top' | 'bottom';
  dataTestId?: string;
}

function destinationsEqual(
  a: AppAdvisorWatcherDestination | null,
  b: AppAdvisorWatcherDestination,
): boolean {
  return (
    a !== null &&
    a.projectId === b.projectId &&
    a.worktreeId === b.worktreeId &&
    a.chatId === b.chatId
  );
}

export function WatcherRecipientPicker({
  groups,
  value,
  onChange,
  placeholder = 'Select a chat…',
  disabled = false,
  placement = 'bottom',
  dataTestId = 'watcher-recipient-picker',
}: WatcherRecipientPickerProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{
    top: number;
    left: number;
  } | null>(null);

  const totalOptions = useMemo(
    () => groups.reduce((count, group) => count + group.options.length, 0),
    [groups],
  );

  const selected = useMemo((): {
    label: string;
    groupKey: RecipientGroupKey;
  } | null => {
    for (const group of groups) {
      for (const option of group.options) {
        if (destinationsEqual(value, option.destination)) {
          return { label: option.label, groupKey: group.key };
        }
      }
    }
    return null;
  }, [groups, value]);

  useEffect(() => {
    if (!open) return undefined;
    const handler = (event: MouseEvent): void => {
      if (!(event.target instanceof Node)) return;
      // The menu is portaled outside `containerRef`, so a click inside it must
      // not be treated as an outside click.
      if (containerRef.current?.contains(event.target)) return;
      if (menuRef.current?.contains(event.target)) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return (): void => document.removeEventListener('mousedown', handler);
  }, [open]);

  // Position the portaled menu against the trigger, aligning its right edge to
  // the trigger's right edge and honoring the requested placement, flipping and
  // clamping to keep it within the viewport.
  const updatePosition = useCallback((): void => {
    const trigger = triggerRef.current;
    const menu = menuRef.current;
    if (!trigger || !menu) return;

    const rect = trigger.getBoundingClientRect();
    const menuWidth = menu.offsetWidth;
    const menuHeight = menu.offsetHeight;
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;

    const above = rect.top - MENU_GAP - menuHeight;
    const below = rect.bottom + MENU_GAP;
    let top: number;
    if (placement === 'top') {
      top = above >= VIEWPORT_PADDING ? above : below;
    } else {
      top =
        below + menuHeight <= viewportHeight - VIEWPORT_PADDING ? below : above;
    }
    top = Math.min(
      Math.max(VIEWPORT_PADDING, top),
      Math.max(
        VIEWPORT_PADDING,
        viewportHeight - menuHeight - VIEWPORT_PADDING,
      ),
    );

    const left = Math.min(
      Math.max(VIEWPORT_PADDING, rect.right - menuWidth),
      Math.max(VIEWPORT_PADDING, viewportWidth - menuWidth - VIEWPORT_PADDING),
    );

    setPosition((previous) => {
      if (previous && previous.top === top && previous.left === left) {
        return previous;
      }
      return { top, left };
    });
  }, [placement]);

  useLayoutEffect((): void => {
    if (!open) {
      setPosition(null);
      return;
    }
    updatePosition();
  }, [open, updatePosition]);

  useEffect((): (() => void) | undefined => {
    if (!open) return undefined;
    let frame: number | null = null;
    const schedule = (): void => {
      if (frame !== null) return;
      frame = window.requestAnimationFrame((): void => {
        frame = null;
        updatePosition();
      });
    };
    window.addEventListener('resize', schedule);
    window.addEventListener('scroll', schedule, {
      capture: true,
      passive: true,
    });
    return (): void => {
      window.removeEventListener('resize', schedule);
      window.removeEventListener('scroll', schedule, { capture: true });
      if (frame !== null) window.cancelAnimationFrame(frame);
    };
  }, [open, updatePosition]);

  const handleSelect = useCallback(
    (destination: AppAdvisorWatcherDestination): void => {
      onChange(destination);
      setOpen(false);
    },
    [onChange],
  );

  const handleTriggerKeyDown = useCallback(
    (event: KeyboardEvent<HTMLButtonElement>): void => {
      if (event.key === 'Escape' && open) {
        event.preventDefault();
        setOpen(false);
      }
    },
    [open],
  );

  const isDisabled = disabled || totalOptions === 0;
  const triggerLabel =
    selected?.label ??
    (totalOptions === 0 ? 'No chats available' : placeholder);

  return (
    <div ref={containerRef} className="electron-no-drag relative">
      <button
        ref={triggerRef}
        type="button"
        disabled={isDisabled}
        onClick={(): void => setOpen((prev) => !prev)}
        onKeyDown={handleTriggerKeyDown}
        aria-haspopup="listbox"
        aria-expanded={open}
        data-testid={`${dataTestId}-trigger`}
        className="focus-ring inline-flex h-7 min-w-48 max-w-72 items-center justify-between gap-2 rounded-lg border bg-popover px-2 text-xs fg-primary transition hover:bg-fg-primary/[0.06] disabled:cursor-not-allowed disabled:opacity-50"
      >
        <span className="flex min-w-0 items-center gap-1.5">
          {selected && (
            <RecipientGroupIcon
              groupKey={selected.groupKey}
              width={12}
              height={12}
              aria-hidden="true"
              className="shrink-0 fg-secondary"
            />
          )}
          <span
            className={`truncate ${selected ? 'fg-primary' : 'fg-secondary'}`}
          >
            {triggerLabel}
          </span>
        </span>
        <AppCatalogChevronDownMediumIcon
          width="12"
          height="12"
          aria-hidden="true"
          className="shrink-0 fg-secondary"
        />
      </button>

      {open &&
        typeof document !== 'undefined' &&
        createPortal(
          <div
            ref={menuRef}
            role="listbox"
            aria-label="Watcher recipient"
            data-testid={`${dataTestId}-menu`}
            className="electron-no-drag fixed z-dropdown max-h-64 w-72 overflow-auto rounded-lg bg-popover p-1 shadow-lg"
            style={
              position
                ? { top: position.top, left: position.left }
                : { visibility: 'hidden', top: 0, left: 0 }
            }
          >
            {groups.map((group, groupIndex) => {
              if (group.options.length === 0) return null;
              return (
                <div key={group.key}>
                  {groupIndex > 0 && (
                    <div
                      role="separator"
                      className="my-1 h-px bg-line-base"
                      aria-hidden="true"
                    />
                  )}
                  <div className="flex items-center gap-1.5 px-2 py-1 text-3xs font-semibold fg-secondary">
                    <RecipientGroupIcon
                      groupKey={group.key}
                      width={12}
                      height={12}
                      aria-hidden="true"
                      className="shrink-0"
                    />
                    <span>{group.label}</span>
                  </div>
                  {group.options.map((option) => {
                    const isSelected = destinationsEqual(
                      value,
                      option.destination,
                    );
                    return (
                      <button
                        key={option.destination.chatId}
                        type="button"
                        role="option"
                        aria-selected={isSelected}
                        onClick={(): void => handleSelect(option.destination)}
                        data-testid={`${dataTestId}-option-${option.destination.chatId}`}
                        className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition hover:bg-fg-primary/[0.06] ${
                          isSelected ? 'bg-info-subtle fg-info' : 'fg-primary'
                        }`}
                      >
                        <span className="min-w-0 flex-1 truncate">
                          {option.label}
                        </span>
                        {isSelected && (
                          <AppCatalogCheckIcon
                            width="12"
                            height="12"
                            aria-hidden="true"
                            className="shrink-0"
                          />
                        )}
                      </button>
                    );
                  })}
                </div>
              );
            })}
          </div>,
          document.body,
        )}
    </div>
  );
}
