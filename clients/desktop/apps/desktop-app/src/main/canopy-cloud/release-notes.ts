import { createReleaseNotesReader } from '@canopy/app-core/release-notes';
import { CLIENT_FEATURE_FLAGS } from '@canopy/protocol/feature-flags';
import {
  RELEASE_NOTES_API_PATH,
  parseReleaseVersion,
  type ReleaseNotesEntry,
} from '@canopy/protocol/release-notes';
import { getFeatureFlagService } from '../feature-flags';
import { getCanopyCloudBaseUrl } from './config';
import {
  CanopyCloudClientError,
  resolveCanopyCloudCredentialContext,
} from './client';

async function readContext(): Promise<{
  baseUrl: string;
  apiKey: string | null;
}> {
  try {
    return await resolveCanopyCloudCredentialContext();
  } catch (error) {
    if (
      !(error instanceof CanopyCloudClientError) ||
      error.code !== 'missing-api-key'
    )
      throw error;
    return { baseUrl: getCanopyCloudBaseUrl(), apiKey: null };
  }
}

/** Credentials stay in main; the server independently evaluates this viewer. */
export async function loadCloudReleaseNotes(
  value: unknown,
): Promise<readonly ReleaseNotesEntry[] | null> {
  const enabled = (): boolean =>
    getFeatureFlagService().isEnabled(
      CLIENT_FEATURE_FLAGS.canopySharedReleaseNotesEnabled.key,
    );
  if (!enabled()) return [];
  const version = typeof value === 'string' ? parseReleaseVersion(value) : null;
  if (!version || version.rc !== null) return [];
  try {
    const context = await readContext();
    if (!enabled()) return [];
    const url = new URL(RELEASE_NOTES_API_PATH, context.baseUrl);
    url.searchParams.set('version', version.normalized);
    // A fresh bounded reader avoids sharing cached results across accounts.
    const read = createReleaseNotesReader({
      fetchImpl: (input, init) =>
        fetch(input, {
          ...init,
          headers: {
            ...init?.headers,
            ...(context.apiKey
              ? { Authorization: `Bearer ${context.apiKey}` }
              : {}),
          },
        }),
    });
    const feed = await read(url.href);
    const current = await readContext();
    if (
      !enabled() ||
      current.baseUrl !== context.baseUrl ||
      current.apiKey !== context.apiKey
    )
      return null;
    return feed?.entries ?? null;
  } catch {
    return null;
  }
}
