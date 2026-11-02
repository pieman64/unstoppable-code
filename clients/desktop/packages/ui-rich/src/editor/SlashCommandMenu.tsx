import { useEffect, useRef, type JSX, type ReactNode } from 'react';
import {
  Button,
  SlashCommandAvailabilityTag,
  SlashCommandLoadingIcon,
} from '@canopy/ui-shared';
import type { SlashCommandOption } from '../types';

export interface SlashCommandMenuProps<
  TCommand extends SlashCommandOption = SlashCommandOption,
> {
  commands: TCommand[];
  namespace?: string | null;
  onBack?: () => void;
  onDismiss?: () => void;
  selectedIndex: number;
  isDiscovering: boolean;
  itemLabel: string;
  title: string;
  onSelect: (cmd: TCommand) => void;
  /** Moves selection to the row under a moving pointer, including Show all. */
  onHover?: (index: number) => void;
  /** Command whose host-side preparation is still in flight. */
  pendingCommand?: TCommand | null;
  /** Optional refresh button rendered in the header. */
  onRefresh?: () => void;
  /** Replaces the default loading spinner. */
  loadingIcon?: ReactNode;
  /** Replaces the default refresh-icon button. */
  refreshIcon?: ReactNode;
  /** Ranked rows hidden by the typed-search cap; 0 hides Show all. */
  hiddenCount?: number;
  /** Total ranked rows, shown in the `Show all N` label. */
  totalCount?: number;
  /** Expands the capped list without inserting a command. */
  onShowAll?: () => void;
}

function DefaultRefreshIcon(): JSX.Element {
  return (
    <svg
      aria-hidden="true"
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M3 12a9 9 0 0 1 15-6.7L21 8" />
      <path d="M21 3v5h-5" />
      <path d="M21 12a9 9 0 0 1-15 6.7L3 16" />
      <path d="M3 21v-5h5" />
    </svg>
  );
}

export function SlashCommandMenu<
  TCommand extends SlashCommandOption = SlashCommandOption,
>({
  commands,
  namespace,
  onBack,
  onDismiss,
  selectedIndex,
  isDiscovering,
  itemLabel,
  title,
  onSelect,
  onHover,
  pendingCommand,
  onRefresh,
  loadingIcon,
  refreshIcon,
  hiddenCount = 0,
  totalCount = commands.length,
  onShowAll,
}: SlashCommandMenuProps<TCommand>): JSX.Element {
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!onDismiss) return;
    const handlePointerDown = (event: PointerEvent): void => {
      if (
        event.target instanceof Node &&
        !menuRef.current?.contains(event.target)
      )
        onDismiss();
    };
    document.addEventListener('pointerdown', handlePointerDown);
    return (): void =>
      document.removeEventListener('pointerdown', handlePointerDown);
  }, [onDismiss]);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = listRef.current;
    if (!container) return;
    // Show all follows the command rows in the same flat keyboard order.
    const options = container.querySelectorAll<HTMLElement>('[role="option"]');
    options[selectedIndex]?.scrollIntoView({ block: 'nearest' });
  }, [selectedIndex]);

  const spinner = loadingIcon ?? <SlashCommandLoadingIcon />;
  const refresh = refreshIcon ?? <DefaultRefreshIcon />;
  const showAllVisible = hiddenCount > 0 && onShowAll !== undefined;

  return (
    <div
      ref={menuRef}
      data-testid="slash-command-menu"
      data-canopy-browser-native-overlay="true"
      className="absolute bottom-full left-0 right-0 z-10 mb-1 overflow-hidden rounded-lg bg-popover shadow-lg"
    >
      <div className="flex items-center justify-between border-b px-3 py-2">
        <div className="flex min-w-0 items-center gap-2 text-xs font-medium fg-secondary">
          {namespace && onBack ? (
            <>
              <Button
                variant="ghost"
                size="compact"
                aria-label="Back to all commands"
                onMouseDown={(event) => event.preventDefault()}
                onClick={onBack}
              >
                All commands
              </Button>
              <span aria-hidden="true">/</span>
              <span className="truncate">{namespace}</span>
            </>
          ) : (
            <span>{title}</span>
          )}
        </div>
        {onRefresh && (
          <Button
            variant="ghost"
            size="compact"
            onMouseDown={(e): void => {
              e.preventDefault();
            }}
            onClick={onRefresh}
            disabled={isDiscovering}
          >
            {isDiscovering ? spinner : refresh}
            Refresh
          </Button>
        )}
      </div>

      {isDiscovering && commands.length === 0 ? (
        <div className="flex items-center gap-2 px-3 py-3 text-s fg-secondary">
          {spinner}
          {`Discovering ${itemLabel}...`}
        </div>
      ) : commands.length === 0 ? (
        <p className="px-3 py-3 text-s fg-secondary">{`No matching ${itemLabel}`}</p>
      ) : (
        <div
          ref={listRef}
          role="listbox"
          aria-label={namespace ? `${namespace} commands` : title}
          className="max-h-60 overflow-y-auto py-1"
        >
          {commands.map((cmd, index) => {
            const pending = cmd === pendingCommand;
            return (
              <button
                key={`${cmd.section ?? 'discovered'}:${cmd.name}:${index}`}
                type="button"
                role="option"
                disabled={pending || cmd.disabledReason !== undefined}
                aria-busy={pending || undefined}
                data-testid={
                  cmd.section === 'available'
                    ? 'slash-command-option-available'
                    : 'slash-command-option-discovered'
                }
                aria-selected={index === selectedIndex}
                onMouseDown={(e): void => e.preventDefault()}
                onMouseMove={(): void => onHover?.(index)}
                onClick={(): void => onSelect(cmd)}
                className={`flex w-full items-start gap-3 px-3 py-2 text-left transition-colors ${
                  index === selectedIndex
                    ? 'bg-fg-primary/[0.08]'
                    : 'hover:bg-fg-primary/[0.04]'
                }`}
              >
                <span className="min-w-0 max-w-9/20 break-words text-s font-medium fg-primary">
                  {cmd.displayName ?? `/${cmd.name}`}
                </span>
                <span className="min-w-0 flex-1 whitespace-normal break-words text-s fg-secondary">
                  {pending
                    ? 'Enabling…'
                    : (cmd.disabledReason ?? cmd.description)}
                </span>
                {cmd.section === 'available' && <SlashCommandAvailabilityTag />}
                {pending && spinner}
                {cmd.browseNamespace && <span aria-hidden="true">›</span>}
                {cmd.category && (
                  <span className="shrink-0 text-xs fg-secondary/70">
                    {cmd.category}
                  </span>
                )}
              </button>
            );
          })}
          {showAllVisible && (
            <button
              type="button"
              role="option"
              data-testid="slash-command-show-all"
              aria-selected={selectedIndex === commands.length}
              onMouseDown={(e): void => e.preventDefault()}
              onMouseMove={(): void => onHover?.(commands.length)}
              onClick={onShowAll}
              className={`flex w-full items-center px-3 py-2 text-left text-s fg-secondary transition-colors ${
                selectedIndex === commands.length
                  ? 'bg-fg-primary/[0.08]'
                  : 'hover:bg-fg-primary/[0.04]'
              }`}
            >
              {`Show all ${totalCount}`}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
