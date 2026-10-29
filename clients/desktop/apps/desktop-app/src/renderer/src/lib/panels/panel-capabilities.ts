import type { PanelKind } from '@canopy/protocol';

/**
 * Native browser content is bound to its owning Electron window. Every other
 * panel kind is React-rendered and can move into an auxiliary window.
 */
export function canPanelKindPopOut(kind: PanelKind): boolean {
  return kind !== 'browser';
}
