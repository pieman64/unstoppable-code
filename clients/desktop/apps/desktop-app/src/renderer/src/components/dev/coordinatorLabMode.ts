// Dark by default; the coordinator lab's header switch picks light, dark or the
// system's mode, through the app's own color-mode helper.
export type CoordinatorMode = 'dark' | 'light' | 'system';

export const COORDINATOR_MODE_KEY = 'coordinator.mode';

export function savedCoordinatorMode(): CoordinatorMode {
  const v = localStorage.getItem(COORDINATOR_MODE_KEY);
  return v === 'light' || v === 'system' ? v : 'dark';
}
