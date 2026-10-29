import type { ActivationQuietHours } from '@canopy/desktop-shared/types';

/**
 * Quiet hours for activation campaigns (CAN-2438 phase 5).
 *
 * Scoped to lifecycle campaigns, deliberately not to all OS notifications.
 * Applying it globally would start suppressing agent-completion notifications,
 * which is a behavior change nobody asked for — a user waiting on a long agent
 * run at 23:00 wants that ping. Marketing nudges are a different interruption
 * budget.
 *
 * Hours are local wall-clock, matching the user's expectation of "don't wake
 * me at night" regardless of where the machine's clock is set.
 */

export const DEFAULT_ACTIVATION_QUIET_HOURS: ActivationQuietHours = {
  enabled: true,
  startHour: 22,
  endHour: 8,
};

function isValidHour(value: number): boolean {
  return Number.isInteger(value) && value >= 0 && value <= 23;
}

/**
 * Whether `now` falls inside the quiet window. Windows wrap across midnight
 * (22 → 8 is the default and the common case), so a naive
 * `start <= hour < end` comparison would be wrong for every overnight setting.
 *
 * A window whose start equals its end is treated as "no quiet time" rather
 * than "always quiet": silently muting a campaign forever is the worse failure.
 */
export function isWithinQuietHours(
  now: Date,
  quietHours: ActivationQuietHours,
): boolean {
  if (!quietHours.enabled) return false;
  const { startHour, endHour } = quietHours;
  if (!isValidHour(startHour) || !isValidHour(endHour)) return false;
  if (startHour === endHour) return false;
  const hour = now.getHours();
  if (startHour < endHour) {
    return hour >= startHour && hour < endHour;
  }
  // Overnight window, e.g. 22:00–08:00.
  return hour >= startHour || hour < endHour;
}
