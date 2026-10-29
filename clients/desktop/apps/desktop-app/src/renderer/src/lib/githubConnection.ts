import { invalidateGitHubCliStatusCache } from '@/hooks/useGitHubCliStatus';
import { notifyGitHubConnectionChanged } from '@/lib/integrationConnectionEvents';

/**
 * `unknown` means a lookup failed without the other source confirming a
 * connection: it is neither a confirmed disconnection nor a successful login.
 */
export type GitHubConnectionProbe = 'connected' | 'disconnected' | 'unknown';

/**
 * A saved PAT or a signed-in `gh` CLI counts as connected. Credential
 * presence is a hint: it does not prove access to a given repository.
 */
export async function probeGitHubConnected(): Promise<GitHubConnectionProbe> {
  const [pat, cliStatus] = await Promise.all([
    window.api.loadGitHubPat().catch(() => null),
    window.api.getGitHubCliStatus().catch(() => null),
  ]);
  if (typeof pat === 'string' && pat.trim().length > 0) return 'connected';
  if (cliStatus?.authenticated === true) return 'connected';
  return typeof pat === 'string' && cliStatus !== null
    ? 'disconnected'
    : 'unknown';
}

/**
 * After a GitHub sign-in closes: refresh main-side credentials (which also
 * resumes agent turns stopped on GitHub auth), drop the renderer CLI cache,
 * tell connection subscribers, then probe again. Never rejects.
 */
export async function settleGitHubLogin(): Promise<GitHubConnectionProbe> {
  try {
    await window.api.refreshGitHubCredentials();
  } catch {
    // Best-effort refresh; the probe below still reflects the CLI's state.
  }
  invalidateGitHubCliStatusCache();
  notifyGitHubConnectionChanged();
  return probeGitHubConnected();
}
