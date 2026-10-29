/**
 * The collapsible job list of a pipeline run panel: the toolbar toggle and
 * the list itself, docked as a rail while expanded or shown as a preview
 * overlay while collapsed. State lives in the panel's
 * {@link PipelineNavPreviewController} (transient preview) and its session
 * store (the expanded preference), so only this region re-renders when the
 * preview opens or closes.
 *
 * The compatibility modal passes no navigation and keeps its static rail.
 */
import {
  useCallback,
  useSyncExternalStore,
  type JSX,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
} from 'react';
import { RailIconButton, useOverlayEscape } from '@canopy/ui-shared';
import { SidebarHiddenLeftWideIcon } from '@canopy/ui-shared/icons/AppIcons';
import type { PipelineNavPreviewController } from './pipelineNavPreviewController';

/** A panel's collapsible job-list wiring, passed to the detail. */
export interface PipelineDetailNavigation {
  readonly controller: PipelineNavPreviewController;
  /** Whether the list is pinned open (the panel's session preference). */
  readonly expanded: boolean;
  /** The document of the window showing the panel, for Escape handling. */
  readonly ownerDocument?: Document;
}

function usePreviewOpen(controller: PipelineNavPreviewController): boolean {
  const snapshot = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  );
  return snapshot.previewOpen;
}

/** Touch has no hover: a touch "enter" is the start of a tap. */
function isHoverPointer(event: PointerEvent<HTMLElement>): boolean {
  return event.pointerType !== 'touch';
}

/**
 * The toggle's full-height toolbar cell. The cell, not only the button, is
 * the hover trigger: it reaches the toolbar's bottom edge (including its own
 * part of the bottom rule), where the preview overlay starts, so the pointer
 * path from toggle to list is continuous.
 */
export function PipelineNavToggleZone({
  navigation,
  navId,
}: {
  navigation: PipelineDetailNavigation;
  navId: string;
}): JSX.Element {
  const { controller, expanded } = navigation;
  const previewOpen = usePreviewOpen(controller);
  const label = expanded ? 'Hide jobs' : 'Show jobs';
  return (
    <div
      ref={controller.setTriggerElement}
      // Draws its own part of the toolbar's bottom rule, so the zone reaches
      // the row the preview opens in with no gap between them.
      className="flex shrink-0 items-center self-stretch border-b py-1.5 pl-3 pr-1"
      data-testid="pipeline-panel-nav-trigger"
      onPointerEnter={(event): void => {
        if (isHoverPointer(event)) controller.pointerEnterTrigger();
      }}
      onPointerLeave={(event): void => {
        if (isHoverPointer(event)) {
          controller.pointerLeave('trigger', event.relatedTarget);
        }
      }}
      onFocus={(event): void => controller.focusTrigger(event.target)}
      onBlur={(event): void => controller.focusLeave(event.relatedTarget)}
      onKeyDown={(event: KeyboardEvent<HTMLDivElement>): void => {
        if (event.defaultPrevented) return;
        if (event.key === 'Escape') {
          if (controller.escape()) event.preventDefault();
          return;
        }
        // The list follows the toolbar in document order, so step into it
        // explicitly rather than through every toolbar action first.
        if (
          (event.key === 'Tab' && !event.shiftKey) ||
          event.key === 'ArrowDown'
        ) {
          if (controller.focusFirstPreviewItem()) event.preventDefault();
        }
      }}
    >
      <RailIconButton
        ref={controller.setToggleElement}
        icon={SidebarHiddenLeftWideIcon}
        hoverSurface
        aria-label={label}
        aria-expanded={expanded || previewOpen}
        aria-controls={expanded || previewOpen ? navId : undefined}
        // No visual tooltip (the app sidebar toggle's rule): collapsed,
        // hovering reveals the list itself and a label would float over it.
        // Kept off in both states, since toggling it would remount the
        // button and drop keyboard focus. `aria-label` carries the state.
        tooltipLabel=""
        data-testid="pipeline-panel-nav-toggle"
        data-nav-state={
          expanded ? 'expanded' : previewOpen ? 'preview' : 'collapsed'
        }
        onClick={controller.toggleClick}
      />
    </div>
  );
}

/**
 * The job list as a docked rail (expanded), a preview overlay over the body
 * (collapsed and previewing), or nothing (collapsed). The same element serves
 * the rail and the overlay, so pinning a preview keeps the list in place
 * instead of replaying its entry.
 */
export function PipelineCollapsibleNav({
  navigation,
  children,
}: {
  navigation: PipelineDetailNavigation;
  children: ReactNode;
}): JSX.Element | null {
  const { controller, expanded, ownerDocument } = navigation;
  const previewOpen = usePreviewOpen(controller);
  const previewing = !expanded && previewOpen;
  // Escape anywhere in the panel's window closes the preview while it is
  // the topmost overlay there; keys inside the list are handled below first.
  useOverlayEscape(previewing, controller.escape, ownerDocument);

  const overlayRef = useCallback(
    (element: HTMLDivElement | null): void => {
      controller.setOverlayElement(element);
    },
    [controller],
  );

  if (!expanded && !previewOpen) return null;
  return (
    <div
      ref={previewing ? overlayRef : undefined}
      data-testid={
        previewing ? 'pipeline-panel-nav-preview' : 'pipeline-panel-nav'
      }
      className={
        previewing
          ? // Over the body, never beside it: the body keeps its geometry.
            // Its top edge meets the toggle cell's bottom edge, so the
            // pointer path from the toggle never crosses a gap.
            'absolute inset-y-0 left-0 z-10 flex min-h-0 shadow-xl transition-[opacity,translate] duration-150 ease-out starting:-translate-x-2 starting:opacity-0 motion-reduce:transition-none'
          : 'flex min-h-0 shrink-0'
      }
      onPointerEnter={
        previewing
          ? (event): void => {
              if (isHoverPointer(event)) controller.pointerEnterOverlay();
            }
          : undefined
      }
      onPointerLeave={
        previewing
          ? (event): void => {
              if (isHoverPointer(event)) {
                controller.pointerLeave('overlay', event.relatedTarget);
              }
            }
          : undefined
      }
      onBlur={
        previewing
          ? (event): void => controller.focusLeave(event.relatedTarget)
          : undefined
      }
      onKeyDown={
        previewing
          ? (event: KeyboardEvent<HTMLDivElement>): void => {
              if (event.defaultPrevented) return;
              if (event.key === 'Escape') {
                if (controller.escape()) event.preventDefault();
                return;
              }
              if (
                event.key === 'Tab' &&
                event.shiftKey &&
                controller.isFirstPreviewItem(event.target)
              ) {
                event.preventDefault();
                controller.focusToggle();
              }
            }
          : undefined
      }
    >
      {children}
    </div>
  );
}
