import { app as electronApp } from 'electron';
import type { LDContext } from 'launchdarkly-node-client-sdk';
import { getStableAnonymousKey } from '../lib/anonymous-id';
import { getEffectiveUsageDataPolicy } from '../lib/usage-data-policy';
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
  // Identity fields are omitted in the reduced (anonymous) context.
  githubUserId?: string | null;
  githubUsername?: string | null;
  githubEmail?: string | null;
  claudeEmail?: string | null;
  codexEmail?: string | null;
  canopyUserIds?: string[];
  canopyUserEmails?: string[];
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

type FeatureFlagIdentity = Omit<
  DesktopFeatureFlagContext,
  | 'kind'
  | 'operatingSystem'
  | 'architecture'
  | 'appVersion'
  | 'canopyOrganizationIds'
  | 'canopyTeamIds'
>;

function personFeatureFlagIdentity(input: {
  anonymousKey: string;
  github: GitHubTargetingInfo;
  claude: ProviderTargetingInfo;
  codex: ProviderTargetingInfo;
  canopy: CanopyServerTargetingInfo;
}): FeatureFlagIdentity {
  const canopyUserIds = sortUnique(input.canopy.userIds);
  const canopyUserEmails = sortUnique(input.canopy.emails);
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
    key,
    anonymous: key === input.anonymousKey,
    ...(email !== undefined ? { email } : {}),
    githubUserId: input.github.id,
    githubUsername: input.github.username,
    githubEmail: input.github.email,
    claudeEmail: input.claude.email,
    codexEmail: input.codex.email,
    canopyUserIds,
    canopyUserEmails,
  };
}

/**
 * `reduced` is the anonymous mode behind Personalized feature rollouts: the
 * install's flag key, platform facts, and organization and team ids (so
 * org-targeted rollouts keep working), with every person identifier omitted.
 */
export function buildDesktopFeatureFlagContextFromTargeting(input: {
  anonymousKey: string;
  appVersion?: string;
  github: GitHubTargetingInfo;
  claude: ProviderTargetingInfo;
  codex: ProviderTargetingInfo;
  canopy: CanopyServerTargetingInfo;
  reduced?: boolean;
}): DesktopFeatureFlagContext & LDContext {
  return {
    kind: 'user',
    ...(input.reduced === true
      ? { key: input.anonymousKey, anonymous: true }
      : personFeatureFlagIdentity(input)),
    operatingSystem: process.platform,
    architecture: process.arch,
    appVersion: input.appVersion ?? '0.0.0',
    canopyOrganizationIds: sortUnique(input.canopy.organizationIds),
    canopyTeamIds: sortUnique(input.canopy.teamIds),
  };
}

let lastBuiltFeatureFlagIdentity: boolean | null = null;

/**
 * The Personalized feature rollouts choice the latest context was built with,
 * or null before the first build. Built, not necessarily identified: a failed
 * identify is retried with a fresh build.
 */
export function getLastBuiltFeatureFlagIdentity(): boolean | null {
  return lastBuiltFeatureFlagIdentity;
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
  const identity = getEffectiveUsageDataPolicy().featureFlagIdentity;
  lastBuiltFeatureFlagIdentity = identity;

  return buildDesktopFeatureFlagContextFromTargeting({
    anonymousKey,
    appVersion: electronApp.getVersion(),
    github,
    claude,
    codex,
    canopy,
    // The flag key comes from `feature-flags-context.json`, never the PostHog
    // identity file, so anonymous mode works with PostHog fully off.
    reduced: !identity,
  });
}
