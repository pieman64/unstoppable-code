import { Fragment, useEffect, useRef, type JSX, type ReactNode } from 'react';
import {
  SlashCommandAvailableDivider,
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
  /** Command whose host-side preparation is still in flight. */
  pendingCommand?: TCommand | null;
  /** Optional refresh button rendered in the header. */
  onRefresh?: () => void;
  /** Replaces the default loading spinner. */
  loadingIcon?: ReactNode;
  /** Replaces the default refresh-icon button. */
  refreshIcon?: ReactNode;
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
  pendingCommand,
  onRefresh,
  loadingIcon,
  refreshIcon,
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
    // Query the option rows directly so non-option separators (the
    // "Available to enable" divider) never throw off the selection index.
    const options = container.querySelectorAll<HTMLElement>('[role="option"]');
    options[selectedIndex]?.scrollIntoView({ block: 'nearest' });
  }, [selectedIndex]);

  const spinner = loadingIcon ?? <SlashCommandLoadingIcon />;
  const refresh = refreshIcon ?? <DefaultRefreshIcon />;
  const firstAvailableIndex = commands.findIndex(
    (cmd) => cmd.section === 'available',
  );

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
              <button
                type="button"
                aria-label="Back to all commands"
                onMouseDown={(event) => event.preventDefault()}
                onClick={onBack}
                className="rounded px-2 py-1 hover:bg-subtle"
              >
                All commands
              </button>
              <span aria-hidden="true">/</span>
              <span className="truncate">{namespace}</span>
            </>
          ) : (
            <span>{title}</span>
          )}
        </div>
        {onRefresh && (
          <button
            type="button"
            onMouseDown={(e): void => {
              e.preventDefault();
            }}
            onClick={onRefresh}
            disabled={isDiscovering}
            className="flex items-center gap-1.5 rounded-md px-2 py-1 text-xs fg-secondary transition hover:bg-fg-primary/[0.06] hover:fg-primary/80 disabled:opacity-50"
          >
            {isDiscovering ? spinner : refresh}
            Refresh
          </button>
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
          {/* Rows arrive flat and pre-ordered (discovered first, then
              available). The divider renders once, before the first
              `available` row; it is not an option, so keyboard navigation
              steps straight across it. */}
          {commands.map((cmd, index) => {
            const pending = cmd === pendingCommand;
            return (
              <Fragment
                key={`${cmd.section ?? 'discovered'}:${cmd.name}:${index}`}
              >
                {cmd.menuGroup &&
                  cmd.section !== 'available' &&
                  cmd.menuGroup !== commands[index - 1]?.menuGroup && (
                    <div
                      role="presentation"
                      className="px-3 pb-1 pt-2 text-xs font-medium fg-secondary"
                    >
                      {cmd.menuGroup}
                    </div>
                  )}
                {index === firstAvailableIndex && (
                  <SlashCommandAvailableDivider />
                )}
                <button
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
                  {pending && spinner}
                  {cmd.browseNamespace && <span aria-hidden="true">›</span>}
                  {cmd.category && (
                    <span className="shrink-0 text-xs fg-secondary/70">
                      {cmd.category}
                    </span>
                  )}
                </button>
              </Fragment>
            );
          })}
        </div>
      )}
    </div>
  );
}
