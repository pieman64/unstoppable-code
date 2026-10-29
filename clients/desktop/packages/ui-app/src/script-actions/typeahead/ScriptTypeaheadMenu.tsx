'use client';

import {
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
  type RefObject,
} from 'react';
import {
  ComposerActionList,
  FloatingMenu,
  type ComposerActionRow,
} from '@canopy/ui-shared';
import { TaskIcon, TerminalIcon } from '@canopy/ui-shared/icons/AppIcons';
import { reviewScriptsLabel } from './script-suggestions';
import type { ScriptTypeaheadController } from './use-script-typeahead';

/** Heading of the review row's group. */
export const SCRIPT_REVIEW_GROUP = 'Not yet approved';

const REVIEW_ROW_ID = 'script-actions:review';
const ROW_SELECTOR = '[data-action-row]:not(:disabled)';

export interface ScriptTypeaheadMenuProps {
  readonly typeahead: ScriptTypeaheadController;
  /**
   * A non-interactive element spanning the composer box; the menu sits above
   * it at its width. It must not contain the editor (FloatingMenu opens on
   * ArrowDown/ArrowUp pressed inside its anchor).
   */
  readonly anchorRef: RefObject<HTMLElement | null>;
  /** The editor surface: presses there do not dismiss the menu. */
  readonly boundaryRef?: RefObject<HTMLElement | null>;
  /** Where focus returns on Escape; defaults to the anchor. */
  readonly returnFocusRef?: RefObject<HTMLElement | null>;
  readonly dataTestIdPrefix?: string;
}

/**
 * The `!` typeahead's rows above the composer: runnable scripts grouped by
 * repository/package and Personal aliases, plus a separate review row while
 * detected definitions wait for approval. The editor keeps focus; the
 * typeahead controller owns the keyboard.
 */
export function ScriptTypeaheadMenu({
  typeahead,
  anchorRef,
  boundaryRef,
  returnFocusRef,
  dataTestIdPrefix = 'script-typeahead',
}: ScriptTypeaheadMenuProps): JSX.Element {
  const listRef = useRef<HTMLDivElement | null>(null);
  const { suggestions, reviewCount, select, openReview } = typeahead;
  const rows = useMemo((): ComposerActionRow[] => {
    const next: ComposerActionRow[] = suggestions.map((suggestion) => ({
      id: suggestion.action.id,
      label: suggestion.action.name,
      description: suggestion.preview,
      ...(suggestion.detail === null ? {} : { value: suggestion.detail }),
      icon: <TerminalIcon aria-hidden />,
      group: suggestion.group,
      completion: true,
      dataTestId: `${dataTestIdPrefix}-row`,
      onSelect: () => select(suggestion),
    }));
    if (reviewCount > 0)
      next.push({
        id: REVIEW_ROW_ID,
        label: reviewScriptsLabel(reviewCount),
        icon: <TaskIcon aria-hidden />,
        group: SCRIPT_REVIEW_GROUP,
        popupRole: 'dialog',
        dataTestId: `${dataTestIdPrefix}-review`,
        onSelect: openReview,
      });
    return next;
  }, [dataTestIdPrefix, openReview, reviewCount, select, suggestions]);

  // The list keys its highlight by DOM id; the controller by row index. Rows
  // render in the controller's (group-contiguous) order.
  const [activeDomId, setActiveDomId] = useState<string | null>(null);
  const { activeIndex, open } = typeahead;
  useLayoutEffect(() => {
    const buttons =
      listRef.current?.querySelectorAll<HTMLButtonElement>(ROW_SELECTOR);
    const button = open && activeIndex >= 0 ? buttons?.[activeIndex] : null;
    setActiveDomId(button?.id ?? null);
    button?.scrollIntoView?.({ block: 'nearest' });
  }, [activeIndex, open, rows]);

  const indexOf = useCallback((id: string | null): number | null => {
    if (id === null) return null;
    const buttons = Array.from(
      listRef.current?.querySelectorAll<HTMLButtonElement>(ROW_SELECTOR) ?? [],
    );
    const index = buttons.findIndex((button) => button.id === id);
    return index < 0 ? null : index;
  }, []);

  const { setActiveIndex, setHoveredIndex, dismiss } = typeahead;
  return (
    <FloatingMenu
      open={open}
      onOpenChange={(next) => {
        if (!next) dismiss();
      }}
      anchorRef={anchorRef}
      {...(boundaryRef ? { outsidePressBoundaryRef: boundaryRef } : {})}
      {...(returnFocusRef ? { returnFocusRef } : {})}
      placement="top-left"
      interaction="manual"
      role="dialog"
      aria-label="Scripts"
      data-testid={`${dataTestIdPrefix}-menu`}
      data-chat-cancel-shortcut-ignore
      motion="none"
      className="flex w-[var(--floating-menu-anchor-width)] flex-col overflow-hidden"
      // Composer-attached, like the + menu: the composer's 20px corners.
      style={{ borderRadius: 'var(--radius-2xl)', paddingBlock: 0 }}
      heightLimit={280}
    >
      <ComposerActionList
        rows={rows}
        menuRef={listRef}
        activeId={activeDomId}
        onActiveIdChange={(id) => setActiveIndex(indexOf(id) ?? -1)}
        onHoveredIdChange={(id) => setHoveredIndex(indexOf(id))}
        dataTestIdPrefix={dataTestIdPrefix}
        blockRowsFromReplay
      />
    </FloatingMenu>
  );
}
