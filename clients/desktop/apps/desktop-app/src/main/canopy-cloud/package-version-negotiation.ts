import { PIPELINE_PACKAGE_CLIENT_VERSION } from '@canopy/protocol/pipelines';
import { CanopyCloudClientError } from './client';

/**
 * The older version a server is asking us to speak, or `null` when the error
 * is not a downgrade request. See the matching helper in
 * `pipelines/canopy-server-client.ts`: a server older than this client reports
 * its own maximum, which is not necessarily 1.
 */
function legacyPackageVersionRequired(error: unknown): number | null {
  if (
    !(error instanceof CanopyCloudClientError) ||
    error.code !== 'http-error' ||
    error.status !== 426 ||
    error.serverCode !== 'pipeline_package_client_upgrade_required'
  ) {
    return null;
  }
  const required = error.requiredPackageVersion;
  return typeof required === 'number' &&
    Number.isInteger(required) &&
    required >= 1 &&
    required < PIPELINE_PACKAGE_CLIENT_VERSION
    ? required
    : null;
}

/**
 * Send a package-versioned read, downgrading once when the server says
 * it speaks an older version than this client.
 *
 * Every package-versioned read must go
 * through this. Sending the header bare turns ordinary deploy-ordering skew —
 * desktop shipping ahead of web — into a terminal 426 the user reads as
 * "Update the desktop app", on a link that would otherwise resolve fine.
 */
export async function withPackageVersionNegotiation<T>(
  send: (version: number) => Promise<T>,
): Promise<T> {
  try {
    return await send(PIPELINE_PACKAGE_CLIENT_VERSION);
  } catch (error) {
    const required = legacyPackageVersionRequired(error);
    if (required === null) throw error;
    return await send(required);
  }
}
