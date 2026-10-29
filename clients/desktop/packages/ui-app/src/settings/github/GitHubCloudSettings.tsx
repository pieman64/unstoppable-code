'use client';

import type { JSX } from 'react';
import { GitHubCloudConnectionCard } from './GitHubCloudConnectionCard';
import { useGitHubCloudConnection } from './use-github-cloud-connection';

interface GitHubCloudSettingsProps {
  /** The signed-in session user; a change drops all pending work and reloads. */
  readonly userId: string;
}

/**
 * The Integrations tab's client body. It mounts the one "GitHub for cloud"
 * controller for the page and hands it to the Settings card: the controller
 * owns loading, the live check, Connect and Disconnect, so nothing below it
 * mounts a second one (a second controller would double the callback
 * continuation and the live check).
 */
export function GitHubCloudSettings({
  userId,
}: GitHubCloudSettingsProps): JSX.Element {
  const controller = useGitHubCloudConnection({ userId });
  return <GitHubCloudConnectionCard controller={controller} />;
}
