import type { PreferencesData } from '@canopy/desktop-shared/types';

/**
 * Claude Workers is only a real destination when the user has opted into a
 * terminal-backed worker mode. Shared by AppSidebar (nav-item gating +
 * CustomizeSidebarModal filtering) so a single copy decides visibility.
 */
export function hasClaudeWorkerTerminalMode(
  prefs: Pick<
    PreferencesData,
    'canopyBackgroundProcessesMode' | 'pipelinesMode'
  >,
): boolean {
  return (
    prefs.canopyBackgroundProcessesMode === 'terminal' ||
    prefs.pipelinesMode === 'terminal'
  );
}
