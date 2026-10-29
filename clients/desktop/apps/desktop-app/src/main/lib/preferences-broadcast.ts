import { BrowserWindow } from 'electron';
import {
  IPC_CHANNELS,
  type PreferencesData,
  type PreferencesSaveResult,
} from '@canopy/desktop-shared/types';
import { sendToWindow } from './window-send';

/**
 * Pushes the canonical preferences to every open window.
 *
 * Deliberately a leaf module rather than living in `ipc/preferences.ts`.
 * Importing it from there closed a real cycle, entirely through STATIC
 * imports --
 * `ipc/os-notifications -> ipc/preferences -> mcp/http-proxy-service ->
 * app-advisor/runtime -> services/pipelines-service ->
 * pipelines/execution-runtime -> pipelines/execution-runtime-hooks ->
 * ipc/os-notifications` -- which was runtime-safe only because the function
 * is hoisted and called late. It also dragged the whole preferences IPC
 * graph into every importer of `showOsNotification`, so any suite touching
 * those had to start mocking `../ipc/preferences`.
 *
 * (A second path through `canopy-tools/worktree-actions` exists but hops via
 * a dynamic `await import()`, so it is not the one to trace when re-checking
 * this: the static chain above is what a bundler and a cycle linter see.)
 *
 * This module depends on nothing but Electron and the shared types, so it
 * cannot participate in a cycle. Nothing enforces that automatically --
 * there is no `import/no-cycle` rule configured for `src/main` -- so keep it
 * a leaf.
 *
 * Secondary windows (e.g. the App Advisor window) use this to re-apply
 * display settings -- theme, color mode, UI scale -- immediately, matching
 * the main window's live-update UX. The main window applies display changes
 * optimistically in `DisplayTab`, so re-applying the same values there is a
 * harmless no-op.
 */
export function broadcastPreferencesSynced(
  preferences: PreferencesData | PreferencesSaveResult,
  projectForRuntime?: (preferences: PreferencesData) => PreferencesData,
): void {
  const normalized = projectForRuntime
    ? projectForRuntime(preferences)
    : preferences;
  for (const window of BrowserWindow.getAllWindows()) {
    sendToWindow(window, IPC_CHANNELS.preferencesSynced, normalized);
  }
}

export function broadcastPreferencesChanged(): void {
  for (const window of BrowserWindow.getAllWindows()) {
    sendToWindow(window, IPC_CHANNELS.preferencesChanged);
  }
}
