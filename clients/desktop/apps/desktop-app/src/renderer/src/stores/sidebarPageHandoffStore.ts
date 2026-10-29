import { create } from 'zustand';

interface SidebarPageHandoffStore {
  /** A secondary full-window page is temporarily replacing main sidebar content. */
  active: boolean;
  setActive: (active: boolean) => void;
}

/** Coordinates secondary page sidebars with the persistent app sidebar shell. */
export const useSidebarPageHandoffStore = create<SidebarPageHandoffStore>(
  (set) => ({
    active: false,
    setActive: (active): void => set({ active }),
  }),
);
