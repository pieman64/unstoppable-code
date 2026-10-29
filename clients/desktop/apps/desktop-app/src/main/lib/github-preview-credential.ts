import { createHash } from 'node:crypto';
import {
  readCanopyCloudAccountWithStatus,
  subscribeCanopyCloudAccountChanges,
  type CanopyCloudAccountEntry,
} from './canopy-cloud-account-store';
import { resolveGitHubTokenWithSource } from './github-auth';

function accountIdentity(entry: CanopyCloudAccountEntry | null): string | null {
  return entry
    ? `${entry.account?.id ?? ''}\0${entry.createdAt}\0${entry.apiKey}`
    : null;
}

export function githubPreviewAccountIdentity(
  entry: CanopyCloudAccountEntry | null,
): string {
  return entry
    ? `${entry.account?.id ?? ''}\0${entry.createdAt}\0${entry.apiKey}`
    : '';
}

// `undefined` until an account event or successful read proves an identity:
// the store's peek is `null` both on a cold cache and after sign-out, so the
// first proof is adopted rather than fenced as a replacement.
let cloudIdentity: string | null | undefined;
let cloudIdentityGeneration = 0;
function observeCloudIdentity(entry: CanopyCloudAccountEntry | null): void {
  const next = accountIdentity(entry);
  if (cloudIdentity !== undefined && next !== cloudIdentity) {
    cloudIdentityGeneration += 1;
  }
  cloudIdentity = next;
}
subscribeCanopyCloudAccountChanges(observeCloudIdentity);

export function getCloudAccountIdentityGeneration(): number {
  return cloudIdentityGeneration;
}

export function githubPreviewCredentialScope(
  accountId: string,
  token: string,
): string {
  return createHash('sha256')
    .update(`github-reference-preview\0${accountId}\0${token}`)
    .digest('base64url')
    .slice(0, 24);
}

/**
 * The account identity that scopes GitHub previews; `''` when confirmed signed
 * out. Throws when the account cannot be read, which is unknown rather than a
 * sign-out, so callers keep what they show and change no generation.
 */
export async function readGitHubPreviewAccountIdentity(): Promise<string> {
  const read = await readCanopyCloudAccountWithStatus();
  if (read.status !== 'ok') {
    throw new Error('Cloud account state is unavailable.');
  }
  observeCloudIdentity(read.entry);
  return githubPreviewAccountIdentity(read.entry);
}

export function githubTrackingCredentialScope(token: string): string {
  return createHash('sha256')
    .update(`github-pr-tracking\0${token}`)
    .digest('base64url')
    .slice(0, 24);
}

/** Tracking needs GitHub authentication; preview provenance is optional. */
export async function readGitHubTrackingCredential(): Promise<{
  token: string;
  authenticationScope: string;
  scope: string | undefined;
} | null> {
  const token = (await resolveGitHubTokenWithSource().catch(() => null))?.token;
  if (!token) return null;
  const accountId = await readGitHubPreviewAccountIdentity().catch(() => null);
  return {
    token,
    authenticationScope: githubTrackingCredentialScope(token),
    scope:
      accountId === null
        ? undefined
        : githubPreviewCredentialScope(accountId, token),
  };
}

/** `null` when there is no GitHub token or the account state is unknown. */
export async function readGitHubPreviewCredential(): Promise<{
  token: string;
  scope: string;
} | null> {
  const credential = await readGitHubTrackingCredential();
  return credential?.scope
    ? { token: credential.token, scope: credential.scope }
    : null;
}
