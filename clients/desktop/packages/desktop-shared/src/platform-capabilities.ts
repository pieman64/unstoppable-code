/**
 * Pure platform-capability helpers shared across the renderer and the main
 * process.
 *
 * Each helper takes a `NodeJS.Platform` so it can be invoked from either side
 * of the IPC boundary without branching on `process.platform`. Renderer
 * callers obtain the platform value from `window.platform`, which the preload
 * bridge exposes; main-process callers use `hostPlatformOperatingSystem()`.
 *
 * This module MUST stay browser-safe: it cannot import Node-only modules or
 * reference `process`, `__dirname`, `require`, or `node:*` modules.
 */

/**
 * Voice dictation is currently a macOS-only feature. The voice IPC handlers
 * remain registered on every platform so the renderer can call them safely,
 * but they short-circuit to unsupported responses on non-`darwin` hosts.
 */
export const UNSUPPORTED_VOICE_DICTATION_MESSAGE =
  'Voice dictation is only available on macOS.';

export const UNSUPPORTED_VOICE_DICTATION_RESPONSE = {
  supported: false,
  reason: UNSUPPORTED_VOICE_DICTATION_MESSAGE,
} as const;

export function isVoiceDictationPlatform(platform: NodeJS.Platform): boolean {
  return platform === 'darwin';
}

/**
 * The desktop app manages a Canopy CLI PATH entry on macOS (via a symlink in
 * `/usr/local/bin`) and on Windows (via a managed directory inserted into
 * `HKCU\Environment\Path`). On Linux and other platforms no PATH management
 * is performed.
 */
export function isCliPathManagementPlatform(
  platform: NodeJS.Platform,
): boolean {
  return platform === 'darwin' || platform === 'win32';
}

/**
 * Single shared source of truth for whether Ollama is supported on the current
 * platform/build. Main, preload, and renderer all import this helper so all
 * three agree, instead of each reading the raw compile-time
 * `__CANOPY_OLLAMA_ENABLED__` global.
 *
 * This merely wraps that global — whose per-build default (darwin **or** win32
 * enabled; other desktop platforms disabled, with the `CANOPY_OLLAMA_ENABLED`
 * env override winning) is set by the build gate in `electron.vite.config.ts`.
 * The `typeof` guard keeps the helper safe in contexts where the define was not
 * injected (e.g. unit tests that never set the global), defaulting to enabled.
 */
export function isOllamaSupportedOnPlatform(): boolean {
  return typeof __CANOPY_OLLAMA_ENABLED__ === 'boolean'
    ? __CANOPY_OLLAMA_ENABLED__
    : true;
}

/**
 * Electron sleep inhibition, shared by the main service and its renderer indicator.
 * Linux uses the same prevent-app-suspension blocker as macOS and Windows.
 */
export function isWakeLockSupportedPlatform(
  platform: NodeJS.Platform,
): boolean {
  return platform === 'darwin' || platform === 'win32' || platform === 'linux';
}
