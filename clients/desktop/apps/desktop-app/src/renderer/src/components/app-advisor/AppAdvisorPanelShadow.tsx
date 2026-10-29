import type { JSX } from 'react';
import { useAppAdvisorStore } from '@/stores/appAdvisorStore';

/**
 * Early access: the shadow under the floating App Advisor panel. The panel
 * is a native view the main process places over this window's bottom-right
 * corner (`floatingAppAdvisorBounds`: the panel's size, 16px from the edges,
 * capped to the window), and a native view casts no shadow of its own, so
 * the window draws it at the same spot and size, behind the panel.
 */
export function AppAdvisorPanelShadow(): JSX.Element | null {
  const floating = useAppAdvisorStore((s) => s.open && s.layout === 'floating');
  const size = useAppAdvisorStore((s) => s.floatingSize);
  if (!floating) return null;
  return (
    <div
      aria-hidden="true"
      data-testid="app-advisor-panel-shadow"
      style={{ width: size.width, height: size.height }}
      className="pointer-events-none fixed bottom-4 right-4 z-drawer max-h-[calc(100vh-32px)] max-w-[calc(100vw-32px)] rounded-2xl shadow-xl"
    />
  );
}
