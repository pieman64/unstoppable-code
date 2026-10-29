'use client';

import type { JSX, ReactNode } from 'react';
import {
  useGitHubCloudConnection,
  type GitHubCloudConnectionController,
} from './use-github-cloud-connection';

// ---------------------------------------------------------------------------
// The one place a surface creates its GitHub for cloud controller (REG-3021).
//
// Everything below receives the controller as a value: the Connect step, the
// Add project repository sources, and (REG-3022) the repo-backed composer's
// reauth notice. A surface mounts exactly one scope, keyed by the signed-in
// user, so switching between the views it hosts never starts a second read,
// live check or callback claim. To share one controller between two surfaces
// (the composer and the Add project dialog on `/chat`), lift this scope to
// their common parent and pass the controller down instead of mounting a
// second scope; mind the callback ordering documented in
// `use-add-workspace-entry.ts` (a scope mounted before the page consumed
// `addProject` cannot claim a GitHub callback for that page).
// ---------------------------------------------------------------------------

export interface GitHubCloudConnectionScopeProps {
  /** The signed-in account's stable key; a change starts the controller over. */
  readonly userId: string;
  /** In-app path the GitHub round-trip returns to; re-read on every render. */
  readonly returnTo?: string;
  readonly children: (controller: GitHubCloudConnectionController) => ReactNode;
}

export function GitHubCloudConnectionScope({
  userId,
  returnTo,
  children,
}: GitHubCloudConnectionScopeProps): JSX.Element {
  const controller = useGitHubCloudConnection({ userId, returnTo });
  return <>{children(controller)}</>;
}
