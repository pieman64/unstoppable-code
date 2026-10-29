import { createContext } from 'react';
import type { useSortable } from '@dnd-kit/sortable';

/**
 * The dnd-kit sortable state a wrapper shares with the handles and header
 * copies rendered beneath it (through portals too). Lives apart from the
 * sortable wrapper so the sections can read it without importing the
 * component that imports them.
 */
export interface SortableHandleState {
  readonly attributes: ReturnType<typeof useSortable>['attributes'];
  readonly listeners: ReturnType<typeof useSortable>['listeners'];
  /** This item is the active drag source. */
  readonly isDragging: boolean;
}

export const WorkspaceSortableStateContext =
  createContext<SortableHandleState | null>(null);
export const WorktreeSortableStateContext =
  createContext<SortableHandleState | null>(null);

/**
 * Where a project drag would land: the project under the pointer and the edge
 * of it the dragged project would take. Provided by the sortable list, read by
 * the section it marks, so the line is seated inside that project.
 */
export interface WorkspaceDropIndicatorState {
  readonly workspaceLocalId: string;
  readonly position: 'before' | 'after';
}

export const WorkspaceDropIndicatorContext =
  createContext<WorkspaceDropIndicatorState | null>(null);
