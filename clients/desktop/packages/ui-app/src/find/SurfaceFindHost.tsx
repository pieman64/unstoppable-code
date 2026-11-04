'use client';

import { lazy, Suspense, useMemo, useRef, type JSX } from 'react';
import type { FindScopeOption } from '@canopy/ui-shared/components/FindInSurfaceBar';
import {
  EMPTY_FIND_CONTROLLER_STATE,
  findControllerKey,
  getActiveFindController,
  getAvailableFindModes,
  getFindScopes,
  useSurfaceFindStore,
  type FindSurfaceMode,
} from './surface-find-store';

const FindInSurfaceBar = lazy(() =>
  import('@canopy/ui-shared/components/FindInSurfaceBar').then((m) => ({
    default: m.FindInSurfaceBar,
  })),
);

/**
 * Mounts the floating find bar (CAN-3048) for the active find controller.
 * Renders nothing while closed; the bar portals into the searched surface's
 * own document so a popped-out panel window gets it in that window.
 */
export function SurfaceFindHost(): JSX.Element | null {
  const controller = useSurfaceFindStore(getActiveFindController);
  const controllerState = useSurfaceFindStore((s) => {
    const active = getActiveFindController(s);
    return active
      ? s.controllerStates[findControllerKey(active.mode, active.scopeKey)]
      : undefined;
  });
  const controllers = useSurfaceFindStore((s) => s.controllers);
  const query = useSurfaceFindStore((s) => s.query);
  const focusNonce = useSurfaceFindStore((s) => s.focusNonce);
  const dialog =
    controller?.anchor.closest<HTMLElement>(
      '[role="dialog"], [aria-modal="true"]',
    ) ?? null;
  // Recomputed per open and switch too: page visibility (the hidden main
  // page) can change without the registry changing.
  const { availableModes, scopes } = useMemo(() => {
    const doc = controller?.anchor.ownerDocument;
    const localControllers = Object.fromEntries(
      Object.entries(controllers).filter(
        ([, entry]) =>
          entry.controller.anchor.closest(
            '[role="dialog"], [aria-modal="true"]',
          ) === dialog,
      ),
    );
    const modes = getAvailableFindModes(localControllers, doc);
    const byMode: Partial<Record<FindSurfaceMode, FindScopeOption[]>> = {};
    for (const mode of modes) {
      byMode[mode] = getFindScopes(localControllers, mode, doc);
    }
    return { availableModes: modes, scopes: byMode };
  }, [controllers, controller, dialog]);
  const inputRef = useRef<HTMLInputElement>(null);

  if (controller === null) return null;

  const store = useSurfaceFindStore.getState();
  const state = controllerState ?? EMPTY_FIND_CONTROLLER_STATE;
  const retry = controller.retry;
  return (
    <Suspense fallback={null}>
      <FindInSurfaceBar
        mode={controller.mode}
        availableModes={availableModes}
        scopes={scopes}
        activeScopeKey={controller.scopeKey}
        onModeChange={(mode, scopeKey): void => {
          const options = scopes[mode] ?? [];
          const remembered = store.activeScope[mode];
          const selected =
            scopeKey ??
            options.find((option) => option.key === remembered)?.key ??
            options[0]?.key;
          if (selected && options.some((option) => option.key === selected))
            store.switchMode(mode, selected);
        }}
        query={query}
        onQueryChange={store.setQuery}
        currentIndex={state.currentIndex}
        totalCount={state.totalCount}
        error={
          state.error === null
            ? null
            : {
                message: state.error,
                onRetry: retry ? (): void => retry() : undefined,
              }
        }
        onNext={store.next}
        onPrevious={store.previous}
        onClose={store.close}
        inputRef={inputRef}
        focusNonce={focusNonce}
        portalContainer={dialog ?? controller.anchor.ownerDocument.body}
      />
    </Suspense>
  );
}
