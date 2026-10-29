import { app as electronApp } from 'electron';
import type { LDContext } from 'launchdarkly-node-client-sdk';
import { getStableAnonymousKey } from '../lib/anonymous-id';
import {
  readCanopyServerTargetingInfo,
  readClaudeTargetingInfo,
  readCodexTargetingInfo,
  readGitHubTargetingInfo,
  type CanopyServerTargetingInfo,
  type GitHubTargetingInfo,
  type ProviderTargetingInfo,
} from './account-targeting';

export { getStableAnonymousKey };

export interface DesktopFeatureFlagContext {
  kind: 'user';
  key: string;
  anonymous: boolean;
  email?: string;
  operatingSystem: NodeJS.Platform;
  architecture: NodeJS.Architecture;
  appVersion: string;
  githubUserId: string | null;
  githubUsername: string | null;
  githubEmail: string | null;
  claudeEmail: string | null;
  codexEmail: string | null;
  canopyUserIds: string[];
  canopyUserEmails: string[];
  canopyOrganizationIds: string[];
  canopyTeamIds: string[];
}

function sortUnique(values: readonly string[]): string[] {
  return Array.from(
    new Set(values.filter((value) => value.trim().length > 0)),
  ).sort();
}

function normalizeFeatureFlagEmail(value: string): string {
  return value.trim().toLowerCase();
}

export function buildDesktopFeatureFlagContextFromTargeting(input: {
  anonymousKey: string;
  appVersion?: string;
  github: GitHubTargetingInfo;
  claude: ProviderTargetingInfo;
  codex: ProviderTargetingInfo;
  canopy: CanopyServerTargetingInfo;
}): DesktopFeatureFlagContext & LDContext {
  const canopyUserIds = sortUnique(input.canopy.userIds);
  const canopyUserEmails = sortUnique(input.canopy.emails);
  const canopyOrganizationIds = sortUnique(input.canopy.organizationIds);
  const canopyTeamIds = sortUnique(input.canopy.teamIds);
  // The signed-in account only: provider emails are unverified against it.
  const email = sortUnique(
    input.canopy.emails
      .map(normalizeFeatureFlagEmail)
      .filter((value) => value.length > 0),
  )[0];
  const key =
    canopyUserIds[0] ??
    input.github.id ??
    input.claude.email ??
    input.codex.email ??
    input.anonymousKey;

  return {
    kind: 'user',
    key,
    anonymous: key === input.anonymousKey,
    ...(email !== undefined ? { email } : {}),
    operatingSystem: process.platform,
    architecture: process.arch,
    appVersion: input.appVersion ?? '0.0.0',
    githubUserId: input.github.id,
    githubUsername: input.github.username,
    githubEmail: input.github.email,
    claudeEmail: input.claude.email,
    codexEmail: input.codex.email,
    canopyUserIds,
    canopyUserEmails,
    canopyOrganizationIds,
    canopyTeamIds,
  };
}

export async function buildDesktopFeatureFlagContext(): Promise<
  DesktopFeatureFlagContext & LDContext
> {
  const [anonymousKey, github, claude, codex, canopy] = await Promise.all([
    getStableAnonymousKey(),
    readGitHubTargetingInfo(),
    readClaudeTargetingInfo(),
    readCodexTargetingInfo(),
    readCanopyServerTargetingInfo(),
  ]);

  return buildDesktopFeatureFlagContextFromTargeting({
    anonymousKey,
    appVersion: electronApp.getVersion(),
    github,
    claude,
    codex,
    canopy,
  });
}
