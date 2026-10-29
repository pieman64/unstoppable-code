import {
  useLayoutEffect,
  useRef,
  useState,
  type JSX,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import type { OverlayLayerSlot as OverlayLayerSlotType } from '@canopy/desktop-shared/types';
import type { InAppNotificationPlacement } from '@canopy/ui-shared';
import { OverlayLayerSlotController } from './overlayLayerSlotController';

export interface OverlayLayerSlotProps {
  slot: OverlayLayerSlotType;
  placement: InAppNotificationPlacement;
  children: ReactNode;
}

/**
 * Keeps the toast subtree mounted in one opener-created element while moving
 * that element between the main document and its transparent native layer.
 */
export function OverlayLayerSlot({
  slot,
  placement,
  children,
}: OverlayLayerSlotProps): JSX.Element {
  const [content] = useState(() => document.createElement('div'));
  const placeholderRef = useRef<HTMLDivElement>(null);
  const controllerRef = useRef<OverlayLayerSlotController | null>(null);
  const placementRef = useRef(placement);
  placementRef.current = placement;

  useLayoutEffect(() => {
    const placeholder = placeholderRef.current;
    if (!placeholder) {
      return;
    }

    const controller = new OverlayLayerSlotController(
      placeholder,
      content,
      slot,
      placementRef.current,
    );
    controllerRef.current = controller;
    controller.start();

    return (): void => {
      controller.dispose();
      if (controllerRef.current === controller) {
        controllerRef.current = null;
      }
    };
  }, [content, slot]);

  useLayoutEffect(() => {
    controllerRef.current?.updatePlacement(placement);
  }, [placement]);

  return (
    <>
      <div
        ref={placeholderRef}
        data-testid="overlay-layer-placeholder"
        data-overlay-layer-slot={slot}
      />
      {createPortal(children, content)}
    </>
  );
}
