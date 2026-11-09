import {
  clearCodexAccountModels,
  setCodexAccountModels,
} from '@canopy/desktop-shared/types';
import type { CodexSpeedCatalog } from '@canopy/execution-engine/types/codex-speed-capabilities';
import { subscribeCodexSpeedCatalog } from './codex-account-models';

/**
 * Keep main's registry of account-only Codex models (`CODEX_ACCOUNT_MODELS`)
 * in step with the signed-in account's `model/list` (CAN-4716).
 *
 * A `ready` catalog registers the account's off-catalog models; an `unknown`
 * one (every invalidation: account change, auth transition, runtime
 * replacement, reset) clears them, so they are scoped to the current sign-in
 * generation and vanish on sign-out. The renderer applies the same mapping
 * from its mirrored catalog, so both registries agree.
 */
export function applyCodexAccountModelCatalog(
  catalog: CodexSpeedCatalog,
): void {
  // A truncated list is unknown here too, as it is for eligibility.
  if (catalog.status === 'ready' && !catalog.truncated) {
    setCodexAccountModels(catalog.models);
  } else {
    clearCodexAccountModels();
  }
}

let disposeRegistrySync: (() => void) | null = null;

/** Subscribe once; re-registration (hot reload, tests) replaces the listener. */
export function registerCodexAccountModelRegistrySync(): void {
  disposeRegistrySync?.();
  disposeRegistrySync = subscribeCodexSpeedCatalog(
    applyCodexAccountModelCatalog,
  );
}
