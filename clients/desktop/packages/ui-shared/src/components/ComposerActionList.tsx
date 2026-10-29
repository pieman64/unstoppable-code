'use client';

import { OverlayScrollArea } from './OverlayScrollArea';
import {
  useId,
  useState,
  type JSX,
  type ReactNode,
  type RefObject,
} from 'react';
import {
  CheckIcon,
  ChevronLeftMediumIcon,
  ChevronRightMediumIcon,
} from '../icons/AppIcons';
import { REPLAY_BLOCK_CLASS } from '../lib/replay-privacy';

export interface ComposerActionRow {
  id: string;
  label: string;
  description?: string;
  icon: ReactNode;
  group: string;
  value?: string;
  opensMenu?: boolean;
  popupRole?: 'menu' | 'dialog';
  disabled?: boolean;
  selected?: boolean;
  /** Toggle rows (plan mode, plugins) expose their state as `aria-pressed`. */
  ariaChecked?: boolean;
  /**
   * Makes the row one choice of a single-select picker: it renders as
   * `role="radio"` with `aria-checked` and a trailing checkmark instead of a
   * pressed toggle or a persistent highlight. A group whose rows all set this
   * becomes a `radiogroup`. Leave it undefined for action and toggle rows.
   */
  checked?: boolean;
  dataTestId?: string;
  /** A typeahead suggestion that Tab may complete (files, plugins, commands). */
  completion?: boolean;
  onSelect: () => void;
}

function isRadioRow(row: ComposerActionRow): boolean {
  return row.checked !== undefined;
}

/** Shared presentation for composer action catalogs; the host owns execution. */
export function ComposerActionList({
  rows,
  menuRef,
  activeId,
  onActiveIdChange,
  onHoveredIdChange,
  onBack,
  scope,
  loading,
  dataTestIdPrefix,
  blockRowsFromReplay = false,
}: {
  rows: ComposerActionRow[];
  menuRef?: RefObject<HTMLDivElement | null>;
  activeId?: string | null;
  onActiveIdChange?: (id: string | null) => void;
  /** Reports the enabled row under the pointer (`null` when none). */
  onHoveredIdChange?: (id: string | null) => void;
  onBack?: () => void;
  scope?: string;
  loading?: boolean;
  dataTestIdPrefix: string;
  /**
   * Mark each group's rows (not its heading) with the session-replay block
   * class, so a recorder keeps a same-size placeholder instead of serializing
   * a large catalog when the menu opens.
   */
  blockRowsFromReplay?: boolean;
}): JSX.Element {
  const listId = useId();
  const [localActiveId, setLocalActiveId] = useState<string | null>(null);
  const highlightedId = activeId === undefined ? localActiveId : activeId;
  const setHighlightedId = onActiveIdChange ?? setLocalActiveId;
  const groups = Array.from(new Set(rows.map((row) => row.group)));
  return (
    <div
      ref={menuRef}
      id={listId}
      className="flex min-h-0 flex-col"
      onPointerMove={(event) => {
        // A real pointer move hands the menu back to the mouse: the keyboard
        // highlight clears so the hovered row's hover style shows, and the
        // host activates that hovered row on Enter (`onHoveredIdChange`).
        // Layout/scroll events under a stationary pointer must not override
        // the keyboard.
        if (event.movementX !== 0 || event.movementY !== 0)
          setHighlightedId(null);
      }}
      onKeyDown={(event) => {
        if (
          !['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight'].includes(
            event.key,
          )
        )
          return;
        const radioGroup =
          event.target instanceof Element
            ? event.target.closest('[role="radiogroup"]')
            : null;
        if (!radioGroup && ['ArrowLeft', 'ArrowRight'].includes(event.key))
          return;
        const buttons = Array.from(
          (
            radioGroup ?? event.currentTarget
          ).querySelectorAll<HTMLButtonElement>(
            '[data-action-row]:not(:disabled)',
          ),
        );
        if (!buttons.length) return;
        event.preventDefault();
        if (radioGroup) event.stopPropagation();
        const forward = event.key === 'ArrowDown' || event.key === 'ArrowRight';
        const index =
          event.target instanceof HTMLButtonElement
            ? buttons.indexOf(event.target)
            : -1;
        const next =
          index < 0
            ? forward
              ? 0
              : buttons.length - 1
            : (index + (forward ? 1 : -1) + buttons.length) % buttons.length;
        setHighlightedId(buttons[next].id);
        buttons[next].focus();
        buttons[next].scrollIntoView?.({ block: 'nearest' });
        if (radioGroup) buttons[next].click();
      }}
    >
      {onBack && (
        <div
          className="flex shrink-0 items-center gap-2 px-2 py-1"
          onMouseDown={(event) => event.preventDefault()}
        >
          <button
            type="button"
            onClick={onBack}
            className="focus-ring inline-flex shrink-0 items-center gap-1 rounded px-1 py-1 text-xs fg-tertiary"
            aria-label="Back to all actions"
          >
            <ChevronLeftMediumIcon aria-hidden className="h-4 w-4 shrink-0" />
            {scope}
          </button>
        </div>
      )}
      <OverlayScrollArea
        className="min-h-0 flex-1"
        viewport="menu"
        contentClassName="min-w-0 py-1"
        railClassName="-right-1"
        thumbEndInset={20}
        edgeFadeSize={8}
        viewportProps={{ 'data-testid': `${dataTestIdPrefix}-menu-scroll` }}
      >
        {groups.map((group) => {
          const groupRows = rows.filter((row) => row.group === group);
          const radioGroup = groupRows.every(isRadioRow);
          const tabStop = radioGroup
            ? (groupRows.find((row) => row.checked && !row.disabled) ??
              groupRows.find((row) => !row.disabled))
            : undefined;
          return (
            <div
              key={group}
              role={radioGroup ? 'radiogroup' : 'group'}
              aria-label={group}
              data-testid={`${dataTestIdPrefix}-plus-${group === 'Current settings' ? 'settings' : group.toLowerCase().replace(/ /g, '-')}`}
              className="mb-1.5 last:mb-0"
            >
              <div className="px-2 pb-0.5 pt-2 text-xs fg-tertiary">
                {group}
              </div>
              {/* Rows sit in their own wrapper so replay can block them while
                the group heading above stays recorded. */}
              <div
                className={blockRowsFromReplay ? REPLAY_BLOCK_CLASS : undefined}
              >
                {groupRows.map((row) => (
                  <button
                    key={row.id}
                    id={`${listId}-${encodeURIComponent(row.id)}`}
                    type="button"
                    data-action-row
                    data-completion-row={row.completion || undefined}
                    data-testid={row.dataTestId}
                    disabled={row.disabled}
                    role={isRadioRow(row) ? 'radio' : undefined}
                    tabIndex={
                      radioGroup ? (row === tabStop ? 0 : -1) : undefined
                    }
                    aria-checked={row.checked}
                    aria-pressed={isRadioRow(row) ? undefined : row.ariaChecked}
                    aria-haspopup={row.popupRole}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={row.onSelect}
                    onPointerEnter={(event) =>
                      onHoveredIdChange?.(
                        row.disabled ? null : event.currentTarget.id,
                      )
                    }
                    onPointerLeave={() => onHoveredIdChange?.(null)}
                    className={`focus-ring flex min-h-8 w-full items-center gap-2 rounded-xl px-2 py-1 text-left text-xs fg-primary disabled:opacity-50 ${highlightedId ? (highlightedId === `${listId}-${encodeURIComponent(row.id)}` ? 'bg-subtle' : '') : row.selected ? 'bg-subtle' : 'hover:bg-subtle'}`}
                  >
                    <span className="flex h-4 w-4 shrink-0 items-center justify-center fg-tertiary [&>svg]:!h-4 [&>svg]:!w-4">
                      {row.icon}
                    </span>
                    <span className="flex min-w-0 flex-1 items-baseline gap-2 overflow-hidden">
                      <span className="max-w-full shrink-0 truncate">
                        {row.label}
                      </span>
                      {row.description && (
                        <span
                          data-action-description
                          className="min-w-0 truncate text-xs fg-tertiary"
                          title={row.description}
                        >
                          {row.description}
                        </span>
                      )}
                    </span>
                    {(row.value !== undefined || row.opensMenu) && (
                      <span
                        data-menu-trailing
                        className="ml-auto flex max-w-2/5 shrink-0 items-center gap-1 fg-tertiary"
                      >
                        {row.value !== undefined && (
                          <span
                            data-menu-value
                            className="min-w-0 truncate text-right text-xs fg-tertiary"
                            title={row.value}
                          >
                            {row.value}
                          </span>
                        )}
                        {row.opensMenu && (
                          <ChevronRightMediumIcon
                            data-menu-chevron
                            aria-hidden
                            className="h-4 w-4 shrink-0 fg-tertiary"
                          />
                        )}
                      </span>
                    )}
                    {isRadioRow(row) && (
                      // A fixed check column keeps every choice aligned; the
                      // glyph, not a background, marks the selected choice.
                      <span
                        aria-hidden
                        className="ml-auto flex h-4 w-4 shrink-0 items-center justify-center fg-primary"
                      >
                        {row.checked && (
                          <CheckIcon
                            data-radio-check
                            data-menu-check
                            width={16}
                            height={16}
                          />
                        )}
                      </span>
                    )}
                  </button>
                ))}
              </div>
            </div>
          );
        })}
        {rows.length === 0 && (
          <p className="px-3 py-5 text-xs fg-tertiary">
            {loading
              ? 'Discovering skills and commands…'
              : 'No matching actions, skills, or plugins'}
          </p>
        )}
      </OverlayScrollArea>
    </div>
  );
}
