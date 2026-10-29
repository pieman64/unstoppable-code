import { type CSSProperties, type JSX, type ReactNode } from 'react';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { DragHandleContext } from './sortable-section-context';

interface SortablePanelSectionProps {
  id: string;
  children: ReactNode;
}

export function SortablePanelSection({
  id,
  children,
}: SortablePanelSectionProps): JSX.Element {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id });

  const style: CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
  };

  return (
    <DragHandleContext.Provider value={{ attributes, listeners }}>
      <div ref={setNodeRef} style={style}>
        {children}
      </div>
    </DragHandleContext.Provider>
  );
}
