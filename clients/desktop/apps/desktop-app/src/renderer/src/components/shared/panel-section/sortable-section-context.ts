import { createContext, useContext } from 'react';
import type { useSortable } from '@dnd-kit/sortable';

type UseSortableReturn = ReturnType<typeof useSortable>;

export interface DragHandleContextValue {
  attributes: UseSortableReturn['attributes'];
  listeners: UseSortableReturn['listeners'];
}

export const DragHandleContext = createContext<DragHandleContextValue | null>(
  null,
);

export function useSortableDragHandle(): DragHandleContextValue | null {
  return useContext(DragHandleContext);
}
