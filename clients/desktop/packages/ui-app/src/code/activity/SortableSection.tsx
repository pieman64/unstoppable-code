'use client';

import type {
  ButtonHTMLAttributes,
  CSSProperties,
  JSX,
  KeyboardEventHandler,
  PointerEventHandler,
  ReactNode,
} from 'react';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
  PanelSection,
  type CollapsedIconColor,
} from '@canopy/ui-shared/components';

/**
 * One draggable activity section: a `@dnd-kit` sortable wrapper around the
 * shared {@link PanelSection}. Pointer activation is passed through
 * `PanelSection.headerProps` (its opaque bag) so the shared display component
 * never imports dnd-kit. Keyboard activation uses a separate focus-revealed
 * handle instead of wrapping the disclosure/action buttons in a sortable role.
 */
export interface SortableSectionProps {
  readonly id: string;
  readonly hiddenWhileMounted?: boolean;
  readonly title: ReactNode;
  readonly icon: ReactNode;
  readonly subtitle?: ReactNode;
  readonly subtitleInline?: boolean;
  readonly headerAction?: ReactNode;
  readonly collapsedIconColor?: CollapsedIconColor;
  readonly defaultCollapsed?: boolean;
  readonly collapsible?: boolean;
  readonly keepBodyMountedWhenCollapsed?: boolean;
  /** Each new value expands the collapsed section (a host reveal). */
  readonly expandRequest?: number;
  readonly actionCard?: boolean;
  readonly dataTestId?: string;
  readonly children?: ReactNode;
}

function isPointerDragListener(
  listener: unknown,
): listener is PointerEventHandler<HTMLDivElement> {
  return typeof listener === 'function';
}

function isKeyboardDragListener(
  listener: unknown,
): listener is KeyboardEventHandler<HTMLButtonElement> {
  return typeof listener === 'function';
}

export function SortableSection({
  id,
  hiddenWhileMounted = false,
  title,
  icon,
  subtitle,
  subtitleInline,
  headerAction,
  collapsedIconColor,
  defaultCollapsed,
  collapsible,
  keepBodyMountedWhenCollapsed,
  expandRequest,
  actionCard = false,
  dataTestId,
  children,
}: SortableSectionProps): JSX.Element {
  const {
    attributes,
    listeners,
    setActivatorNodeRef,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id,
    disabled: { draggable: hiddenWhileMounted, droppable: hiddenWhileMounted },
  });

  const style: CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
  };
  // Action cards contain a real full-card button. Keep pointer dragging on the
  // wrapper, but do not add dnd-kit's keyboard button semantics around that
  // button: nested interactive roles make Space/Enter ambiguous between the
  // action and sortable keyboard activation.
  const sortablePointerDown = listeners?.onPointerDown;
  const pointerDragListener: {
    readonly onPointerDown?: PointerEventHandler<HTMLDivElement>;
  } = isPointerDragListener(sortablePointerDown)
    ? {
        onPointerDown: (event): void => {
          sortablePointerDown(event);
        },
      }
    : {};
  const sortableKeyDown = listeners?.onKeyDown;
  const onKeyDown: KeyboardEventHandler<HTMLButtonElement> | undefined =
    isKeyboardDragListener(sortableKeyDown)
      ? (event): void => {
          sortableKeyDown(event);
        }
      : undefined;
  const keyboardDragHandleProps: ButtonHTMLAttributes<HTMLButtonElement> = {
    ...attributes,
    'aria-label': `Reorder ${id} section`,
    children: `Reorder ${id}`,
    onKeyDown,
  };

  return (
    <div
      ref={setNodeRef}
      hidden={hiddenWhileMounted}
      style={style}
      className="relative"
      data-activity-action-card={actionCard ? 'true' : undefined}
      data-testid={dataTestId ?? `activity-section-${id}`}
      {...(actionCard ? pointerDragListener : {})}
    >
      {actionCard ? (
        <>
          <button
            ref={setActivatorNodeRef}
            type="button"
            className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-20 focus:rounded-sm focus:bg-quaternary focus:px-2 focus:py-1 focus:text-2xs focus:font-normal focus:fg-primary focus:shadow-sm"
            {...keyboardDragHandleProps}
          />
          {children}
        </>
      ) : (
        <PanelSection
          icon={icon}
          title={title}
          subtitle={subtitle}
          subtitleInline={subtitleInline}
          headerAction={headerAction}
          collapsedIconColor={collapsedIconColor}
          defaultCollapsed={defaultCollapsed}
          collapsible={collapsible}
          keepBodyMountedWhenCollapsed={keepBodyMountedWhenCollapsed}
          expandRequest={expandRequest}
          headerProps={pointerDragListener}
          keyboardDragHandleProps={keyboardDragHandleProps}
          keyboardDragHandleRef={setActivatorNodeRef}
        >
          {children}
        </PanelSection>
      )}
    </div>
  );
}
