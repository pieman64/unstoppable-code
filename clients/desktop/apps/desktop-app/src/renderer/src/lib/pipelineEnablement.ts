// ---------------------------------------------------------------------------
// Pipeline enable/disable state.
//
// Disabled pipelines still appear on the Pipelines management page (so they can
// be re-enabled) but are excluded from every pipeline run picker. The state is
// a global, user-local denylist of `PipelineInfo.id`s persisted in
// `preferences.disabledPipelineIds`, so it works for read-only sources
// (bundled, shared) that cannot carry their own `enabled` flag. Absence means
// enabled — everything is enabled by default.
// ---------------------------------------------------------------------------

/**
 * Load the set of disabled pipeline ids from preferences.
 */
export async function loadDisabledPipelineIds(): Promise<Set<string>> {
  const preferences = await window.api.loadPreferences();
  return new Set(preferences.disabledPipelineIds ?? []);
}

/**
 * Load disabled pipeline ids when enablement is a non-critical filter.
 *
 * A preferences read failure should not block pipeline picker/listing surfaces
 * from rendering pipelines that are otherwise available.
 */
export async function loadDisabledPipelineIdsBestEffort(): Promise<
  Set<string>
> {
  try {
    return await loadDisabledPipelineIds();
  } catch {
    return new Set();
  }
}

/**
 * Persist a new enabled/disabled state for a single pipeline.
 *
 * Applies the change in the main process so concurrent row toggles are merged
 * against the latest queued preferences write instead of a stale renderer
 * snapshot. Returns the updated set so callers can optimistically update local
 * state without a second round-trip.
 */
export async function setPipelineDisabled(
  id: string,
  disabled: boolean,
): Promise<Set<string>> {
  const preferences = await window.api.setPipelineDisabledPreference({
    id,
    disabled,
  });
  return new Set(preferences.disabledPipelineIds ?? []);
}
