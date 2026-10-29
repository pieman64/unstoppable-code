/**
 * GitHub owner avatars for GitHub-backed projects.
 *
 * Pure parsers shared by the Electron main process, which projects the avatar
 * onto the session snapshot's workspace rows for the shared sidebar rail and
 * the web portal, and the desktop renderer's `ProjectIcon`, which resolves it
 * over IPC for the surfaces that are not snapshot-driven.
 */

/** Returns the GitHub account that owns a standard HTTPS, SSH, or scp remote. */
export function getGitHubRemoteOwner(remoteUrl: string): string | null {
  const trimmed = remoteUrl.trim();
  const scpMatch = trimmed.match(
    /^(?:[^@/\s]+@)?github\.com:([^/\s]+)\/[^/\s]+(?:\.git)?$/i,
  );
  const urlMatch = trimmed.match(
    /^(?:https?|ssh|git):\/\/(?:[^@/\s]+@)?(?:www\.)?github\.com\/([^/\s]+)\/[^/\s]+(?:\.git)?(?:[/?#].*)?$/i,
  );
  const owner = (scpMatch?.[1] ?? urlMatch?.[1])?.trim();
  return owner && /^[a-z\d](?:[a-z\d-]{0,38})$/i.test(owner) ? owner : null;
}

/** The owner's avatar at 2x the 16px project badge, or null for non-GitHub remotes. */
export function getGitHubOwnerAvatarUrl(remoteUrl: string): string | null {
  const owner = getGitHubRemoteOwner(remoteUrl);
  return owner
    ? `https://github.com/${encodeURIComponent(owner)}.png?size=32`
    : null;
}
