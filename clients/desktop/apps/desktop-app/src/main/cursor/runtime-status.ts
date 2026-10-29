import { assertCursorHarnessEnabled } from './feature-flag';
import type { CursorConnectionStatus } from '@canopy/desktop-shared/types';
import { cursorRuntimeInstalled } from '@canopy/desktop-shared/node/cursor/runtime-status';
import { getCursorRuntimeArtifact } from '@canopy/desktop-shared/node/cursor/runtime-metadata';
import { readPreferencesFile } from '../lib/preferences-store';

/** Cheap availability check: no installer, authentication process, hashing, or downloads. */
export async function cursorConnectionStatus(): Promise<CursorConnectionStatus> {
  assertCursorHarnessEnabled();
  const artifact = getCursorRuntimeArtifact();
  const state = await cursorRuntimeInstalled();
  const supported = Boolean(artifact) && state.supported;
  const enabled = Boolean((await readPreferencesFile()).cursorEnabled);
  const installed = supported && state.installed;
  return {
    supported,
    installed,
    enabled,
    version: state.version,
    phase: enabled && installed ? 'connected' : 'idle',
    ...(artifact ? { archiveBytes: artifact.archiveBytes } : {}),
  };
}

// `isCursorRuntimeAvailable` deliberately does NOT live here. Two concurrent
// branches extracted the same helper into different modules and the merge kept
// both, leaving two definitions with split callers: the cached, generation-
// guarded one in `runtime-availability.ts` (which feeds the Portal's
// `providerAvailability.cursor` projection) and an uncached copy here. Every
// caller now uses the canonical one, so an automation or pipeline readiness
// probe refreshes that cache instead of silently bypassing it, and there is
// one definition of what "available" means again.
