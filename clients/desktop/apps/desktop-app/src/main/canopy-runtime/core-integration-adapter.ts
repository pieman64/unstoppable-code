import { AsyncLocalStorage } from 'node:async_hooks';
import type { GitHubCliStatus } from '@canopy/desktop-shared/types';
import {
  GITHUB_CLI_INTEGRATION_ID,
  type CoreIntegration,
  type CoreIntegrationGetParams,
  type CoreIntegrationListParams,
  type CoreIntegrationListResult,
  type CoreIntegrationSourceRepositoryStarParams,
  type CoreIntegrationSourceRepositoryStarResult,
} from '@canopy/protocol/canopy-core';
import { parseGitHubRepositoryUrl } from '@canopy/protocol/settings/github-repository-url';
import type {
  CanopyInstructionOptions,
  CanopyQueryOptions,
} from '@canopy/core-runtime';
import {
  createCoreIntegrationHandlers,
  createCoreIntegrationInstructionHandlers,
  type CoreIntegrationHandlers,
  type CoreIntegrationHost,
  type CoreIntegrationInstructionHandlers,
  type GitHubRepositoryTarget,
} from '@canopy/core-runtime/node/github';
import { BRAND } from '@canopy/brand/current';
import type { DesktopBrandRuntime } from '@canopy/protocol/brand';
import { desktopGitHubRequestHandle } from '../github/request-handle';
import { legacyGitHubCliStatus, observeGitHubCli } from '../lib/github-auth';
import { starGitHubRepositoryWithCli } from '../lib/github-cli-star';
import { LOCAL_DESKTOP_AUTHORITY_ID } from './desktop-runtime-identity';

/** The dispatcher surface the `core.integration.*` projections use. */
export interface CoreIntegrationDispatcher {
  query(
    name: 'core.integration.get',
    params: CoreIntegrationGetParams,
    options: CanopyQueryOptions,
  ): Promise<CoreIntegration>;
  query(
    name: 'core.integration.list',
    params: CoreIntegrationListParams,
    options: CanopyQueryOptions,
  ): Promise<CoreIntegrationListResult>;
  instruction(
    name: 'core.integration.sourceRepository.star',
    params: CoreIntegrationSourceRepositoryStarParams,
    options: CanopyInstructionOptions,
  ): Promise<CoreIntegrationSourceRepositoryStarResult>;
}

/** One projected call's capture of the legacy status its observation made. */
interface GitHubCliCapture {
  legacy?: GitHubCliStatus;
}

const gitHubCliCapture = new AsyncLocalStorage<GitHubCliCapture>();

// The annotated alias: the generated per-brand module infers a narrow `web`
// shape that omits `marketing` for brands that do not declare it.
const brand: DesktopBrandRuntime = BRAND;

/**
 * The github.com repository a brand's `sourceRepository` names, or `null`
 * when it declares none or the URL is not a github.com repository.
 */
export function resolveBrandSourceRepository(
  url: string | undefined,
): GitHubRepositoryTarget | null {
  if (url === undefined) return null;
  const parsed = parseGitHubRepositoryUrl(url);
  return parsed.ok ? { owner: parsed.owner, repo: parsed.repo } : null;
}

/**
 * The desktop host for `core.integration.*`: Canopy's credential through the
 * results-only request handle, and the bundled GitHub CLI's own status.
 * Inside the `settings:github-cli-status` projection it also captures the
 * legacy status computed from the same observation.
 */
export const desktopCoreIntegrationHost: CoreIntegrationHost = {
  // No enrolled targets: any explicit target is refused.
  authorityId: LOCAL_DESKTOP_AUTHORITY_ID,
  github: desktopGitHubRequestHandle,
  observeGitHubCli: async () => {
    const observation = await observeGitHubCli();
    const capture = gitHubCliCapture.getStore();
    if (capture) capture.legacy = legacyGitHubCliStatus(observation);
    return observation;
  },
  sourceRepository: resolveBrandSourceRepository(
    brand.web.marketing?.sourceRepository?.url,
  ),
  starRepository: starGitHubRepositoryWithCli,
};

/** `core.integration.*` handlers over the desktop host. */
export function createCoreIntegrationAdapter(
  host: CoreIntegrationHost = desktopCoreIntegrationHost,
): {
  queries: CoreIntegrationHandlers;
  instructions: CoreIntegrationInstructionHandlers;
} {
  return {
    queries: createCoreIntegrationHandlers(host),
    instructions: createCoreIntegrationInstructionHandlers(host),
  };
}

/**
 * Dispatches `core.integration.get` for `github-cli` in the projection
 * context and returns the legacy status the host computed, error message and
 * raw CLI token source included, for the IPC channel to return byte for
 * byte. Once the host has read the CLI, a canonical mapping or validation
 * failure answers `canonicalResult: null` instead of replacing it.
 */
export async function queryGitHubCliStatusForLegacyIpc(
  dispatcher: CoreIntegrationDispatcher,
  options: CanopyQueryOptions,
): Promise<{
  canonicalResult: CoreIntegration | null;
  legacyResult: GitHubCliStatus;
}> {
  const capture: GitHubCliCapture = {};
  try {
    const canonicalResult = await gitHubCliCapture.run(capture, () =>
      dispatcher.query(
        'core.integration.get',
        { integrationId: GITHUB_CLI_INTEGRATION_ID },
        options,
      ),
    );
    if (capture.legacy === undefined)
      throw new Error('GitHub CLI status projection was not captured.');
    return { canonicalResult, legacyResult: capture.legacy };
  } catch (error) {
    if (capture.legacy !== undefined)
      return { canonicalResult: null, legacyResult: capture.legacy };
    throw error;
  }
}
