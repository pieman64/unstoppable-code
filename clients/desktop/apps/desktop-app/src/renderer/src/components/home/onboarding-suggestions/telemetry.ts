import {
  startClientOperation,
  succeedClientOperation,
} from '@canopy/desktop-instrumentation/client';
import { HOME_ONBOARDING_BLUEPRINT_SUGGESTION_PREFIX } from '@canopy/desktop-shared/types';
import type { ProfileRoleId } from '@canopy/protocol/plugin-catalog';

const OPERATION_NAME = 'canopy.home_onboarding_suggestions';

/**
 * Funnel events for the dynamic Home onboarding suggestions module (the
 * merged successor of the CAN-2411 card). Context stays bounded and
 * low-cardinality: an action id, the queue entry, and the entry's step kind.
 * No account labels, tokens, or free text.
 */
function emit(
  context: Record<string, string | number | boolean | null | undefined>,
): void {
  startClientOperation(OPERATION_NAME, { context });
  succeedClientOperation(OPERATION_NAME, { context });
}

let impressionEmitted = false;

/**
 * Entry ids tailored to a project template embed the chat project id, a
 * plugin name and a starter-prompt id (`blueprint:<project>:plugin:<name>`,
 * CAN-3032), none of which belong in telemetry. They collapse to the
 * bounded kind; every other id is already a curated or bounded catalog id.
 */
export function telemetryEntryId(entryId: string): string {
  if (!entryId.startsWith(HOME_ONBOARDING_BLUEPRINT_SUGGESTION_PREFIX)) {
    return entryId;
  }
  const kind = entryId.split(':')[2];
  return `${HOME_ONBOARDING_BLUEPRINT_SUGGESTION_PREFIX}${kind === 'prompt' ? 'prompt' : 'plugin'}`;
}

/** The module became visible on the Home landing. Once per launch. */
export function trackOnboardingSuggestionsImpression(): void {
  if (impressionEmitted) {
    return;
  }
  impressionEmitted = true;
  emit({ action: 'impression' });
}

/** Test-only: clears the once-per-launch impression dedupe. */
export function resetOnboardingSuggestionsImpressionForTests(): void {
  impressionEmitted = false;
}

/**
 * An entry's primary CTA was clicked while showing the given step. Entry ids
 * are the curated queue ids plus bounded `plugin:<curated-key>` ids — no
 * free text.
 */
export function trackOnboardingSuggestionCtaClick(
  entryId: string,
  step: string,
): void {
  emit({ action: 'cta_click', entry: telemetryEntryId(entryId), step });
}

/** An entry was dismissed via its checkbox (permanent for the install). */
export function trackOnboardingSuggestionDismiss(entryId: string): void {
  emit({ action: 'dismiss', entry: telemetryEntryId(entryId) });
}

/**
 * An entry finished its final step. `reason` is a bounded id for entries
 * that complete on more than one exit (the import entry completes when a
 * project lands and when the user passes on it), so the funnel can still
 * tell those apart.
 */
export function trackOnboardingSuggestionCompleted(
  entryId: string,
  reason?: string,
): void {
  emit({
    action: 'completed',
    entry: telemetryEntryId(entryId),
    ...(reason === undefined ? {} : { reason }),
  });
}

/**
 * One category tile on the tools step was toggled. The roles step and its
 * once-per-submission `roles_submitted` action were retired with it; this
 * action fires per toggle instead, so the two are never compared as one
 * series. It carries the toggled role, whether it is now selected, and the
 * resulting count — never the full multi-select, which stays a profile
 * attribute rather than telemetry.
 */
export function trackOnboardingCategoryToggle(
  role: ProfileRoleId,
  isSelected: boolean,
  count: number,
): void {
  emit({ action: 'category_toggle', role, is_selected: isSelected, count });
}
