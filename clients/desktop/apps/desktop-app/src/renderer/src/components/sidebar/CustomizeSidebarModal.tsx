import { type JSX, type ReactNode, useMemo, useState } from 'react';
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
  arrayMove,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
  DEFAULT_SIDEBAR_NAV_LAYOUT,
  isSidebarNavKeyVisible,
  type SidebarNavVisibilityOptions,
} from '@canopy/desktop-shared/lib/sidebar-nav-layout';
import { DragHandleIcon } from '@canopy/ui-shared/icons/AppIcons';
import { Button, DialogModal } from '@canopy/ui-shared/components';
import { useCurrentUiStateReporter } from '@/hooks/useCurrentUiStateReporter';
import { useSidebarStore } from '@/stores/sidebarStore';
import { getSidebarNavItemDefs } from './sidebar-nav-items';
import {
  SIDEBAR_NAV_ICON_CLASSNAME,
  SIDEBAR_NAV_ITEM_CLASSNAME,
} from './sidebar-styles';
import {
  MORE_DIVIDER_ID,
  buildLayoutFromEntries,
  toEntries,
} from './customize-sidebar-layout';

export interface CustomizeSidebarModalProps {
  onClose: () => void;
  workersVisible: boolean;
  /** `canopy-ledger-enabled`: the Feed shows only while it is on. */
  ledgerEnabled?: boolean;
  /** Nav keys owned by Labs experiments that are off. */
  experimentHiddenKeys?: readonly string[];
}

/**
 * Filter the flat entry list down to what the editor should show: the divider
 * sentinel plus every nav key except entries hidden by rollout flags,
 * availability gates, or experiments that are off (their stored positions are
 * preserved on Save).
 */
function visibleEntries(
  entries: string[],
  visibility: SidebarNavVisibilityOptions,
): string[] {
  return entries.filter(
    (id) => id === MORE_DIVIDER_ID || isSidebarNavKeyVisible(id, visibility),
  );
}

/**
 * One draggable entry. The More heading is an entry too (its position sets
 * where the More menu starts) but it is not dragged itself: rows move across
 * it, so `fixed` keeps it a drop target without making the heading a handle.
 */
function SortableRow({
  id,
  fixed = false,
  children,
}: {
  id: string;
  fixed?: boolean;
  children: (dragging: boolean) => ReactNode;
}): JSX.Element {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id, disabled: fixed });
  return (
    <div
      ref={setNodeRef}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
      }}
      {...(fixed ? {} : attributes)}
      {...(fixed ? {} : listeners)}
      // dnd-kit puts the keyboard handle (tabindex, role) on this wrapper, so
      // the focus ring belongs here, shaped like the row inside it.
      className={
        fixed
          ? undefined
          : `focus-ring rounded-row${isDragging ? ' relative z-10' : ''}`
      }
    >
      {children(isDragging)}
    </div>
  );
}

const NO_HIDDEN_KEYS: readonly string[] = [];

const GROUP_HEADING_CLASSNAME = 'px-2 pb-1 text-xs font-normal fg-tertiary';

export function CustomizeSidebarModal({
  onClose,
  workersVisible,
  ledgerEnabled = false,
  experimentHiddenKeys = NO_HIDDEN_KEYS,
}: CustomizeSidebarModalProps): JSX.Element {
  const storedLayout = useSidebarStore((s) => s.sidebarNavLayout);
  const setSidebarNavLayout = useSidebarStore((s) => s.setSidebarNavLayout);
  const defs = useMemo(() => getSidebarNavItemDefs(), []);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  // Keep edits for hidden entries so a gate flip never resets the draft.
  // Project visibility at render time, including entries enabled since mount.
  const [editableEntries, setEditableEntries] = useState(() =>
    toEntries(storedLayout.order, storedLayout.moreStartIndex),
  );
  const entries = useMemo(
    () =>
      visibleEntries(editableEntries, {
        workersVisible,
        ledgerEnabled,
        experimentHiddenKeys,
      }),
    [editableEntries, workersVisible, ledgerEnabled, experimentHiddenKeys],
  );

  const [hiddenEntryBaseline, setHiddenEntryBaseline] = useState(storedLayout);
  useCurrentUiStateReporter('sidebar.customizeModal', {
    open: true,
    itemCount: entries.filter((id) => id !== MORE_DIVIDER_ID).length,
  });

  const handleDragEnd = (event: DragEndEvent): void => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    setEditableEntries((current) => {
      const from = current.indexOf(String(active.id));
      const to = current.indexOf(String(over.id));
      if (from === -1 || to === -1) return current;
      return arrayMove(current, from, to);
    });
  };

  const handleSave = (): void => {
    setSidebarNavLayout(
      buildLayoutFromEntries(editableEntries, hiddenEntryBaseline),
    );
    onClose();
  };

  const handleReset = (): void => {
    setHiddenEntryBaseline(DEFAULT_SIDEBAR_NAV_LAYOUT);
    setEditableEntries(
      toEntries(
        DEFAULT_SIDEBAR_NAV_LAYOUT.order,
        DEFAULT_SIDEBAR_NAV_LAYOUT.moreStartIndex,
      ),
    );
  };

  const moreStart = entries.indexOf(MORE_DIVIDER_ID);
  const moreMenuEmpty = moreStart === entries.length - 1;

  return (
    <DialogModal
      onClose={onClose}
      title="Customize sidebar"
      subtitle="Drag items to reorder them or to move them into the More menu."
      maxWidth="sm"
      headerBorder={false}
      headerSpacing="tight"
      scrollableBody={false}
      dataTestId="customize-sidebar-modal"
    >
      {/* The rows are drawn as the sidebar draws them, so the editor previews
          the result; headings, not a dashed placeholder, mark the groups. */}
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 pb-2 pt-1">
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragEnd={handleDragEnd}
        >
          <SortableContext
            items={entries}
            strategy={verticalListSortingStrategy}
          >
            <p
              data-testid="customize-sidebar-group-sidebar"
              className={GROUP_HEADING_CLASSNAME}
            >
              Sidebar
            </p>
            <div className="flex flex-col">
              {entries.map((id) => {
                if (id === MORE_DIVIDER_ID) {
                  return (
                    <SortableRow key={id} id={id} fixed>
                      {() => (
                        <p
                          data-testid="customize-sidebar-more-divider"
                          className={`${GROUP_HEADING_CLASSNAME} pt-4`}
                        >
                          More menu
                        </p>
                      )}
                    </SortableRow>
                  );
                }
                const def = defs[id];
                if (!def) return null;
                return (
                  <SortableRow key={id} id={id}>
                    {(dragging) => (
                      <div
                        data-testid={`customize-sidebar-row-${id}`}
                        className={`${SIDEBAR_NAV_ITEM_CLASSNAME} cursor-default fg-primary ${
                          dragging ? 'bg-card shadow-md' : 'hover:bg-subtle'
                        }`}
                      >
                        <span className={SIDEBAR_NAV_ICON_CLASSNAME}>
                          {def.icon}
                        </span>
                        <span className="min-w-0 flex-1 truncate">
                          {def.label}
                        </span>
                        <span
                          aria-hidden="true"
                          data-testid={`customize-sidebar-row-${id}-handle`}
                          className="inline-flex h-4 w-4 shrink-0 items-center justify-center fg-quaternary"
                        >
                          <DragHandleIcon size={16} />
                        </span>
                      </div>
                    )}
                  </SortableRow>
                );
              })}
            </div>
            {moreMenuEmpty && (
              <p
                data-testid="customize-sidebar-more-empty"
                className="px-2 py-1.5 text-s fg-quaternary"
              >
                Drag an item here to keep it in the More menu.
              </p>
            )}
          </SortableContext>
        </DndContext>
      </div>
      <div className="flex items-center justify-between gap-2 px-5 pb-5 pt-3">
        <Button
          variant="ghost"
          size="compact"
          onClick={handleReset}
          data-testid="customize-sidebar-reset"
        >
          Reset to default
        </Button>
        <div className="flex items-center gap-2">
          <Button
            variant="secondary"
            size="compact"
            onClick={onClose}
            data-testid="customize-sidebar-cancel"
          >
            Cancel
          </Button>
          <Button
            variant="primary"
            size="compact"
            onClick={handleSave}
            data-testid="customize-sidebar-save"
          >
            Save
          </Button>
        </div>
      </div>
    </DialogModal>
  );
}
