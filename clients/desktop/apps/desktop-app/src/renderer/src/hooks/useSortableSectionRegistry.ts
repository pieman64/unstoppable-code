import { useCallback, useMemo, useState, type JSX } from 'react';
import {
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
  type SensorDescriptor,
  type SensorOptions,
} from '@dnd-kit/core';
import { arrayMove, sortableKeyboardCoordinates } from '@dnd-kit/sortable';

export interface SortableSectionRegistryEntry<TId extends string> {
  id: TId;
  /** Display title used by the drag overlay. */
  title: string;
  render: () => JSX.Element;
}

interface UseSortableSectionRegistryOptions<TId extends string> {
  /** Persisted section order — drives the rendered sequence and the
   * registry-resolved drop targets. */
  sectionOrder: readonly TId[];
  /** Section registry. Each entry maps an id to its display title and
   * `render` callback. */
  registry: readonly SortableSectionRegistryEntry<TId>[];
  /** Type guard isolating the union string id from arbitrary DnD ids. Each
   * panel exposes its own narrow guard (e.g. `isActivitySectionId`) so we
   * keep the strong typing without forcing a shared union here. */
  isSectionId: (value: string) => value is TId;
  /** Persistence callback invoked with the new ordered section ids whenever
   * a successful drag completes. */
  onReorder: (newOrder: TId[]) => void;
}

interface UseSortableSectionRegistryResult<TId extends string> {
  sensors: SensorDescriptor<SensorOptions>[];
  activeDragId: TId | null;
  /** Title for the currently dragged section, or empty string when no drag
   * is active. Used as the drag-overlay caption. */
  activeDragTitle: string;
  /** Sections in persisted display order, filtered to ids the registry can
   * render. */
  orderedSections: SortableSectionRegistryEntry<TId>[];
  handleDragStart: (event: DragStartEvent) => void;
  handleDragEnd: (event: DragEndEvent) => void;
  handleDragCancel: () => void;
}

/**
 * Shared sortable-section state for the activity panel and standalone
 * workspace panel. Owns DnD sensor setup, drag tracking, registry lookup,
 * and the persisted-order → rendered-sequence resolution that both panels
 * previously hand-rolled.
 *
 * Persistence behavior matches the original inline implementations:
 * - PointerSensor activation distance: `6`.
 * - KeyboardSensor uses `sortableKeyboardCoordinates`.
 * - Drops with no `over`, identical ids, invalid active or over ids, or
 *   unknown indexes are ignored — `onReorder` is not invoked in those
 *   cases.
 * - Reordering uses `arrayMove(sectionOrder, oldIndex, newIndex)`.
 */
export function useSortableSectionRegistry<TId extends string>({
  sectionOrder,
  registry,
  isSectionId,
  onReorder,
}: UseSortableSectionRegistryOptions<TId>): UseSortableSectionRegistryResult<TId> {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  const [activeDragId, setActiveDragId] = useState<TId | null>(null);

  const handleDragStart = useCallback(
    (event: DragStartEvent): void => {
      const id = String(event.active.id);
      if (isSectionId(id)) {
        setActiveDragId(id);
      }
    },
    [isSectionId],
  );

  const handleDragEnd = useCallback(
    (event: DragEndEvent): void => {
      setActiveDragId(null);

      const { active, over } = event;
      if (!over || active.id === over.id) return;

      const activeId = String(active.id);
      const overId = String(over.id);
      if (!isSectionId(activeId) || !isSectionId(overId)) return;

      const oldIndex = sectionOrder.indexOf(activeId);
      const newIndex = sectionOrder.indexOf(overId);
      if (oldIndex < 0 || newIndex < 0) return;

      const newOrder = arrayMove([...sectionOrder], oldIndex, newIndex);
      onReorder(newOrder);
    },
    [isSectionId, sectionOrder, onReorder],
  );

  const handleDragCancel = useCallback((): void => {
    setActiveDragId(null);
  }, []);

  const orderedSections = useMemo((): SortableSectionRegistryEntry<TId>[] => {
    const registryMap = new Map(registry.map((entry) => [entry.id, entry]));
    return sectionOrder
      .map((id) => registryMap.get(id))
      .filter(
        (entry): entry is SortableSectionRegistryEntry<TId> =>
          entry !== undefined,
      );
  }, [sectionOrder, registry]);

  const activeDragTitle = useMemo((): string => {
    if (!activeDragId) return '';
    return registry.find((entry) => entry.id === activeDragId)?.title ?? '';
  }, [activeDragId, registry]);

  return {
    sensors,
    activeDragId,
    activeDragTitle,
    orderedSections,
    handleDragStart,
    handleDragEnd,
    handleDragCancel,
  };
}
