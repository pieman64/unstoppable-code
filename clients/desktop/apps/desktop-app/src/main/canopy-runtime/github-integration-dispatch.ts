import type { GitHubCliStatus } from '@canopy/desktop-shared/types';
import {
  CORE_INTEGRATION_GRANTS,
  CORE_INTEGRATION_SOURCE_REPOSITORY_STAR_ERROR_CODES,
  type CanopyCallerDescriptor,
  type CoreIntegrationSourceRepositoryStarErrorCode,
} from '@canopy/protocol/canopy-core';
import type {
  StarSourceRepositoryFailureReason,
  StarSourceRepositoryResult,
} from '@canopy/protocol/onboarding';
import { CanopyOperationError } from '@canopy/core-runtime';
import {
  queryGitHubCliStatusForLegacyIpc,
  type CoreIntegrationDispatcher,
} from './core-integration-adapter';
import { preserveRuntimeCauseError } from './runtime-cause-error';

/*
 * The `core.integration.*` projections behind `settings:github-cli-status`
 * and `settings:star-source-repository`. Each call holds only its own grant.
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

const STAR_FAILURE_REASONS: Record<
  CoreIntegrationSourceRepositoryStarErrorCode,
  StarSourceRepositoryFailureReason
> = {
  'core.integration.sourceRepository.unavailable': 'unavailable',
  'core.integration.githubCli.notInstalled': 'not_installed',
  'core.integration.notAuthenticated': 'not_authenticated',
  'core.integration.sourceRepository.star.failed': 'failed',
};

function isStarErrorCode(
  code: string | undefined,
): code is CoreIntegrationSourceRepositoryStarErrorCode {
  return CORE_INTEGRATION_SOURCE_REPOSITORY_STAR_ERROR_CODES.some(
    (candidate) => candidate === code,
  );
}

function starFailureReason(
  error: unknown,
): StarSourceRepositoryFailureReason | null {
  if (!(error instanceof CanopyOperationError)) return null;
  const { code } = error.payload;
  return isStarErrorCode(code) ? STAR_FAILURE_REASONS[code] : null;
}

/**
 * `settings:star-source-repository`: stars the brand's repository with the
 * GitHub CLI. Typed failures become reasons, so the renderer never parses a
 * message; anything else rethrows as the host error.
 */
export async function starSourceRepository(
  dispatcher: CoreIntegrationDispatcher,
  caller: CanopyCallerDescriptor,
): Promise<StarSourceRepositoryResult> {
  return preserveRuntimeCauseError(
    dispatcher
      .instruction(
        'core.integration.sourceRepository.star',
        {},
        { caller: { ...caller, grants: [CORE_INTEGRATION_GRANTS.star] } },
      )
      .then(
        (): StarSourceRepositoryResult => ({ starred: true }),
        (error: unknown): StarSourceRepositoryResult => {
          const reason = starFailureReason(error);
          if (reason === null) throw error;
          return { starred: false, reason };
        },
      ),
  );
}
