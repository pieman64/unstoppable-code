// Renderer mirror of the OS focus shortcut status (CAN-1963). The main
// process owns registration; this store hydrates from
// `window.api.globalFocusShortcut.getStatus()` and follows the
// `global-focus-shortcut:status-changed` pushes so Settings and the Getting
// started checklist read one shared snapshot.

import { useEffect } from 'react';
import { create } from 'zustand';
import type {
  GlobalFocusShortcutApi,
  GlobalFocusShortcutStatus,
  GlobalFocusShortcutUpdateRequest,
  GlobalFocusShortcutUpdateResponse,
} from '@canopy/desktop-shared/types';
import {
  formatAcceleratorForDisplay,
  GLOBAL_FOCUS_SHORTCUT_DEFAULT_ACCELERATOR,
} from '@canopy/desktop-shared/lib/global-shortcut-accelerator';
import { rendererShortcutPlatform } from '@/lib/globalFocusShortcut';

export interface GlobalFocusShortcutStore {
  status: GlobalFocusShortcutStatus | null;
  hydrated: boolean;
  /** True while an update round trip is in flight. */
  busy: boolean;
  /** Attach the status-push subscription; returns the detach function. */
  subscribeBridge: () => () => void;
  hydrate: () => Promise<void>;
  /**
   * Try a config change. Resolves with main's answer (`null` without a
   * bridge). On `ok: false` the returned status is the restored saved state,
   * which is what the store keeps.
   */
  update: (
    request: GlobalFocusShortcutUpdateRequest,
  ) => Promise<GlobalFocusShortcutUpdateResponse | null>;
}

function getApi(): GlobalFocusShortcutApi | undefined {
  return typeof window !== 'undefined'
    ? window.api?.globalFocusShortcut
    : undefined;
}

export const useGlobalFocusShortcutStore = create<GlobalFocusShortcutStore>(
  (set) => {
    // Pushes received so far. `hydrate()` must not overwrite a push that
    // landed while its `getStatus` invoke was in flight with the older
    // snapshot that invoke captured.
    let pushCount = 0;
    return {
      status: null,
      hydrated: false,
      busy: false,
      subscribeBridge: (): (() => void) => {
        const api = getApi();
        if (!api?.onStatusChanged) {
          return (): void => undefined;
        }
        return api.onStatusChanged((status) => {
          pushCount += 1;
          set({ status, hydrated: true });
        });
      },
      hydrate: async (): Promise<void> => {
        const api = getApi();
        if (!api?.getStatus) {
          // Mounted without the preload bridge (unit tests): stop waiting.
          set({ hydrated: true });
          return;
        }
        const pushesBefore = pushCount;
        try {
          const status = await api.getStatus();
          if (pushCount === pushesBefore) {
            set({ status, hydrated: true });
          } else {
            set({ hydrated: true });
          }
        } catch {
          set({ hydrated: true });
        }
      },
      update: async (
        request,
      ): Promise<GlobalFocusShortcutUpdateResponse | null> => {
        const api = getApi();
        if (!api?.update) return null;
        set({ busy: true });
        // Same guard as hydrate(): a proof push that lands during the round
        // trip (the chord pressed right after toggling) is newer than the
        // snapshot main captured at registration time.
        const pushesBefore = pushCount;
        try {
          const response = await api.update(request);
          if (pushCount === pushesBefore) {
            set({ status: response.status, hydrated: true });
          } else {
            set({ hydrated: true });
          }
          return response;
        } finally {
          set({ busy: false });
        }
      },
    };
  },
);

/** Hydrates once and follows pushes for the lifetime of the caller. */
export function useGlobalFocusShortcutStatus(): {
  status: GlobalFocusShortcutStatus | null;
  hydrated: boolean;
  busy: boolean;
} {
  const status = useGlobalFocusShortcutStore((state) => state.status);
  const hydrated = useGlobalFocusShortcutStore((state) => state.hydrated);
  const busy = useGlobalFocusShortcutStore((state) => state.busy);
  useEffect(() => {
    const store = useGlobalFocusShortcutStore.getState();
    const unsubscribe = store.subscribeBridge();
    void store.hydrate();
    return unsubscribe;
  }, []);
  return { status, hydrated, busy };
}

/**
 * Display string for the saved chord (`⌘⇧O` / `Ctrl Shift O`). Before the
 * status has loaded it shows the default chord for the renderer's platform,
 * which is what the checklist row and Settings need to say on first paint.
 */
export function formatGlobalFocusShortcutForDisplay(
  status: GlobalFocusShortcutStatus | null,
): string {
  return formatAcceleratorForDisplay(
    status?.accelerator ?? GLOBAL_FOCUS_SHORTCUT_DEFAULT_ACCELERATOR,
    status?.platform ?? rendererShortcutPlatform(),
  );
}
