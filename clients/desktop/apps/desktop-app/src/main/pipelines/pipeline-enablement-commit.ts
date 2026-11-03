import { AsyncLocalStorage } from 'node:async_hooks';
import type { PreferencesData } from '@canopy/desktop-shared/types';
import { updatePreferencesFile } from '../lib/preferences-store';

const commits = new AsyncLocalStorage<{ committed?: PreferencesData }>();

/**
 * Records an enabled state in the `disabledPipelineIds` preference, for the
 * core enablement port. A caller inside {@link withPipelineEnablementCommit}
 * receives the preferences this write committed.
 */
export async function recordPipelineEnabled(
  definitionId: string,
  enabled: boolean,
): Promise<void> {
  const committed = await updatePreferencesFile((preferences) => {
    const ids = new Set(preferences.disabledPipelineIds);
    if (enabled) ids.delete(definitionId);
    else ids.add(definitionId);
    return { disabledPipelineIds: Array.from(ids) };
  });
  const slot = commits.getStore();
  if (slot) slot.committed = committed;
}

/**
 * Runs a core enablement call and answers with the preferences its write
 * committed, or `undefined` when it wrote nothing, such as a replay.
 */
export async function withPipelineEnablementCommit(
  run: () => Promise<void>,
): Promise<PreferencesData | undefined> {
  const slot: { committed?: PreferencesData } = {};
  await commits.run(slot, run);
  return slot.committed;
}
