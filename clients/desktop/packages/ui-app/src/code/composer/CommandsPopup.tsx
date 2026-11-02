'use client';

/**
 * The composer's Commands popup: the `/`-command list opened from the
 * composer's commands button, as opposed to the inline `/` typeahead the
 * editor owns.
 *
 * Extracted from `apps/web`'s `chat-input.tsx` unchanged (web chat parity,
 * slice 3) so the shared composer can render the same list.
 */
import {
  Fragment,
  useCallback,
  useEffect,
  useRef,
  useState,
  type JSX,
  type KeyboardEvent,
} from 'react';
import { focusMenuRow } from '@canopy/ui-shared/lib';
import { Button } from '@canopy/ui-shared/components';
import {
  DropdownMenuSurface,
  SlashCommandAvailableDivider,
  SlashCommandLoadingIcon,
} from '@canopy/ui-shared';
import type { SlashCommandOption } from '@canopy/ui-rich/types';
import { RefreshIcon as AppCatalogRefreshIcon } from '@canopy/ui-shared/icons/AppIcons';

export interface CommandsPopupProps {
  align?: 'start' | 'end';
  commands: SlashCommandOption[];
  isRefreshing: boolean;
  onSelect: (cmd: SlashCommandOption) => void;
  onRefresh: () => void;
  /** Command whose host-side preparation (enable) is still in flight. */
  pendingCommand?: SlashCommandOption | null;
}

/**
 * Discovered-commands popup anchored above the Commands button. Pixel-mirrors
 * the desktop `CommandsPopup` (fixed width, refresh header, `/name` rows), and
 * implements the ARIA `menu` keyboard contract we opt into via `role="menu"`:
 * ArrowUp/ArrowDown (with wrap) and Home/End move focus across the rows via a
 * roving `tabIndex`, Enter/Space activate the focused row, and Escape closes
 * the menu (handled by the trigger's document listener). Rows also insert on
 * `mousedown` (with `preventDefault`) so a mouse click keeps the editor's caret.
 */
export function CommandsPopup({
  align = 'end',
  commands,
  isRefreshing,
  onSelect,
  onRefresh,
  pendingCommand,
}: CommandsPopupProps): JSX.Element {
  const [activeIndex, setActiveIndex] = useState(0);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const count = commands.length;
  const activeItem = count === 0 ? -1 : Math.min(activeIndex, count - 1);
  const firstAvailableIndex = commands.findIndex(
    (command) => command.section === 'available',
  );

  // Roving tabindex: move DOM focus onto the active row when it changes (also
  // moves focus into the menu when the rows first arrive). `pendingCommand` is
  // a dependency so focus is re-asserted onto the active row when a pending
  // enablement resolves — if focus was lost while the row was busy, the menu's
  // keydown handler would otherwise stop receiving keyboard events.
  // A click open leaves the row unpainted until the first arrow; see
  // `focusMenuRow`.
  useEffect(() => {
    const row = activeItem >= 0 ? itemRefs.current[activeItem] : null;
    if (row) focusMenuRow(row);
  }, [activeItem, count, pendingCommand]);

  const onMenuKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>): void => {
      if (count === 0) return;
      switch (event.key) {
        case 'ArrowDown':
          event.preventDefault();
          setActiveIndex((index) => (index + 1) % count);
          break;
        case 'ArrowUp':
          event.preventDefault();
          setActiveIndex((index) => (index - 1 + count) % count);
          break;
        case 'Home':
          event.preventDefault();
          setActiveIndex(0);
          break;
        case 'End':
          event.preventDefault();
          setActiveIndex(count - 1);
          break;
        case 'Enter':
        case ' ': {
          event.preventDefault();
          const cmd = commands[activeItem];
          // A row whose enablement is still in flight must not re-activate.
          if (cmd && cmd !== pendingCommand) onSelect(cmd);
          break;
        }
        default:
          break;
      }
    },
    [commands, count, activeItem, onSelect, pendingCommand],
  );

  return (
    <DropdownMenuSurface
      data-canopy-browser-native-overlay="true"
      data-testid="portal-chat-commands-popup"
      aria-label="Commands"
      aria-orientation="vertical"
      onKeyDown={onMenuKeyDown}
      className={`absolute bottom-full z-20 mb-2 w-72 ${align === 'start' ? 'left-0' : 'right-0'}`}
    >
      <div className="flex items-center justify-between border-b px-3 py-2">
        <span className="text-xs font-medium fg-secondary">Commands</span>
        <Button
          variant="ghost"
          size="compact"
          tabIndex={-1}
          onMouseDown={(event): void => event.preventDefault()}
          onClick={onRefresh}
          disabled={isRefreshing}
        >
          <RefreshGlyph spinning={isRefreshing} />
          Refresh
        </Button>
      </div>

      <div className="max-h-60 overflow-y-auto py-1">
        {isRefreshing && commands.length === 0 ? (
          <div className="px-3 py-3 text-s fg-secondary">
            Discovering commands…
          </div>
        ) : commands.length === 0 ? (
          <p className="px-3 py-3 text-s fg-secondary">No commands available</p>
        ) : (
          commands.map((cmd, index) => {
            const pending = cmd === pendingCommand;
            return (
              <Fragment
                key={`${cmd.section ?? 'promoted'}:${cmd.name}:${index}`}
              >
                {index === firstAvailableIndex && (
                  <SlashCommandAvailableDivider testId="portal-chat-command-available-divider" />
                )}
                <button
                  ref={(el): void => {
                    itemRefs.current[index] = el;
                  }}
                  type="button"
                  role="menuitem"
                  tabIndex={index === activeItem ? 0 : -1}
                  // `aria-disabled` (not native `disabled`): this row can be
                  // the DOM-focused element via the roving tabindex, and
                  // natively disabling a focused button blurs it to `body`,
                  // leaving the menu's keydown handler keyboard-dead after a
                  // gate-false resolution. Activation is guarded in the
                  // handlers instead.
                  aria-disabled={
                    pending || cmd.disabledReason !== undefined || undefined
                  }
                  aria-busy={pending || undefined}
                  data-testid="portal-chat-command-option"
                  onMouseEnter={(): void => setActiveIndex(index)}
                  onMouseDown={(event): void => {
                    event.preventDefault();
                    if (pending || cmd.disabledReason !== undefined) return;
                    onSelect(cmd);
                  }}
                  className="flex min-h-11 w-full items-center gap-3 px-3 py-2 text-left transition-colors hover:bg-fg-primary/[0.06] focus-visible:bg-fg-primary/[0.08] focus:outline-none lg:min-h-0 lg:items-start"
                >
                  <span className="shrink-0 text-s font-medium fg-primary">
                    {cmd.displayName ?? `/${cmd.name}`}
                  </span>
                  {(pending || cmd.disabledReason || cmd.description) && (
                    <span className="truncate text-s fg-secondary">
                      {pending
                        ? 'Enabling…'
                        : (cmd.disabledReason ?? cmd.description)}
                    </span>
                  )}
                  {pending && <SlashCommandLoadingIcon />}
                </button>
              </Fragment>
            );
          })
        )}
      </div>
    </DropdownMenuSurface>
  );
}

function RefreshGlyph({ spinning }: { spinning: boolean }): JSX.Element {
  return (
    <AppCatalogRefreshIcon
      aria-hidden="true"
      width="12"
      height="12"
      className={spinning ? 'animate-spin' : undefined}
    />
  );
}
