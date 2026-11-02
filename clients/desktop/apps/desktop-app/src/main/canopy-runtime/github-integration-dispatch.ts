import type { GitHubCliStatus } from '@canopy/desktop-shared/types';
import {
  CORE_INTEGRATION_GRANTS,
  type CanopyCallerDescriptor,
} from '@canopy/protocol/canopy-core';
import {
  queryGitHubCliStatusForLegacyIpc,
  type CoreIntegrationDispatcher,
} from './core-integration-adapter';
import { preserveRuntimeCauseError } from './runtime-cause-error';

/*
 * The `core.integration.*` projection behind `settings:github-cli-status`.
 * Each call holds only `core.integration.read`.
 */

/** `settings:github-cli-status`: the legacy GitHub CLI status, byte for byte. */
export async function getGitHubCliStatus(
  dispatcher: CoreIntegrationDispatcher,
  caller: CanopyCallerDescriptor,
): Promise<GitHubCliStatus> {
  const { legacyResult } = await preserveRuntimeCauseError(
    queryGitHubCliStatusForLegacyIpc(dispatcher, {
      caller: { ...caller, grants: [CORE_INTEGRATION_GRANTS.read] },
    }),
  );
  return legacyResult;
}
