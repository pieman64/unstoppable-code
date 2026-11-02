import { create } from 'zustand';

interface SidebarPageHandoffStore {
  /** A secondary full-window page is temporarily replacing main sidebar content. */
  active: boolean;
  /**
   * The secondary page also covers the main shell, as project settings does:
   * the shell under it hides and stops taking input, as it does for Settings.
   */
  coversMainShell: boolean;
  setActive: (active: boolean, options?: { coversMainShell?: boolean }) => void;
}

/** Coordinates secondary page sidebars with the persistent app sidebar shell. */
export const useSidebarPageHandoffStore = create<SidebarPageHandoffStore>(
  (set) => ({
    active: false,
    coversMainShell: false,
    setActive: (active, options): void =>
      set({
        active,
        coversMainShell: active && options?.coversMainShell === true,
      }),
  }),
);
