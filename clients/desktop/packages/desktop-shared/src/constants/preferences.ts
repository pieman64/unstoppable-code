import { DEFAULT_SIDEBAR_WIDTH_PX } from '@canopy/protocol';
import type { ActivationQuietHours, ChatEnrichmentMode } from '../types';

export const DEFAULT_LINEAR_CHAT_ENRICHMENT_MODE: ChatEnrichmentMode =
  'replace';
export const DEFAULT_GITHUB_CHAT_ENRICHMENT_MODE: ChatEnrichmentMode = 'hover';

export const DEFAULT_VOICE_DICTATION_ENABLED = true;
/** OS focus shortcut is opt-in: the checklist or Settings turns it on (CAN-1963). */
export const DEFAULT_GLOBAL_FOCUS_SHORTCUT_ENABLED = false;
export const DEFAULT_MAX_ACTIVE_CHAT_TURNS = 10;
export const DEFAULT_CLAUDE_MAX_TURNS = 500;
export const CLAUDE_MAX_TURNS_MIN = 1;
export const CLAUDE_MAX_TURNS_MAX = 9999;

/** Missing or invalid values retain the default; null explicitly removes the cap. */
export function normalizeClaudeMaxTurns(value: unknown): number | null {
  if (value === null) return null;
  return typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= CLAUDE_MAX_TURNS_MIN &&
    value <= CLAUDE_MAX_TURNS_MAX
    ? value
    : DEFAULT_CLAUDE_MAX_TURNS;
}
export const DEFAULT_MAX_ACTIVE_PIPELINE_EXECUTIONS = 5;
export const BYTES_PER_GIB = 1024 * 1024 * 1024;
export const DEFAULT_MEMORY_PRESSURE_GUARD_ENABLED = false;
export const DEFAULT_MEMORY_DIAGNOSTICS_ENABLED = false;
export const DEFAULT_BYPASS_CODEX_APP_SERVER_IDLE_TIMEOUT_UNDER_CRITICAL_PRESSURE = true;
export const DEFAULT_MEMORY_PRESSURE_WARNING_THRESHOLD_BYTES =
  2 * BYTES_PER_GIB;
export const DEFAULT_MEMORY_PRESSURE_CRITICAL_THRESHOLD_BYTES =
  4 * BYTES_PER_GIB;

/**
 * Unified sidebar width bounds, shared by the main-process preference
 * normalizer and the renderer store so the two cannot drift.
 *
 * `DEFAULT_SIDEBAR_WIDTH` was previously an alias for `SIDEBAR_MIN_WIDTH`,
 * which opened every new install at the narrowest supported width. It is now
 * deliberately clear of the floor. Raising it only affects installs with no
 * persisted `sidebarWidth`; 220 remains a legal width that users can drag back
 * to, so layout must still work there.
 */
export const SIDEBAR_MIN_WIDTH = 220;
export const SIDEBAR_MAX_WIDTH = 480;
// Shared with the web rail through the protocol package so the two cannot drift.
export const DEFAULT_SIDEBAR_WIDTH = DEFAULT_SIDEBAR_WIDTH_PX;

export const DEFAULT_ACTIVATION_QUIET_HOURS: ActivationQuietHours = {
  enabled: true,
  startHour: 22,
  endHour: 8,
};
