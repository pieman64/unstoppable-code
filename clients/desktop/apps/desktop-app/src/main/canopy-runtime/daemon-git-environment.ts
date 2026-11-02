import { withGitRequestContextEnv } from '@canopy/desktop-shared/node/git-request-context';
import { getEnhancedEnv } from '@canopy/desktop-shared/pipelines/config-paths';
import {
  CanopyHostExecutionSchema,
  type CanopyHostExecution,
} from '@canopy/protocol/canopy-core';

/**
 * Operation families whose daemon-served Git runs with an environment
 * Electron forwards per request (CAN-5496). Only the token-free
 * repository-read family exists. Commit and push have none until CAN-4108;
 * their token comes from the daemon vault (CAN-4415), never from here.
 */
export type DaemonGitEnvironmentFamily = 'repository-read';

const FAMILY_ENVIRONMENTS: Record<
  DaemonGitEnvironmentFamily,
  () => NodeJS.ProcessEnv
> = {
  // V1, as main's runGit: Electron's environment and the managed PATH,
  // without Canopy secrets or user variables (q-8 option a).
  'repository-read': () =>
    withGitRequestContextEnv(
      getEnhancedEnv({ includeCanopySecrets: false, environment: false }),
    ),
};

/** Fixed text: never names a variable or value. */
export class DaemonGitEnvironmentError extends Error {
  constructor() {
    super('The Git environment exceeds the host execution limits.');
    this.name = 'DaemonGitEnvironmentError';
  }
}

function holdable(key: string, value: string): boolean {
  return (
    key !== '' &&
    !key.includes('=') &&
    !key.includes('\0') &&
    !value.includes('\0')
  );
}

/**
 * The `_execution` input for one daemon-served Git request of `family`.
 * Build it inside the request's async context, once per request, and pass it
 * straight to the client call option: never cache, persist or log it.
 * Entries a child environment cannot hold (Windows drive-cwd keys such as
 * `=C:`) are dropped; the non-interactive switches are always set.
 */
export function daemonGitRequestExecution(
  family: DaemonGitEnvironmentFamily,
): CanopyHostExecution {
  const childEnvironment: Record<string, string> = {};
  for (const [key, value] of Object.entries(FAMILY_ENVIRONMENTS[family]()))
    if (typeof value === 'string' && holdable(key, value))
      childEnvironment[key] = value;
  childEnvironment.GIT_TERMINAL_PROMPT = '0';
  childEnvironment.GCM_INTERACTIVE = 'never';
  const parsed = CanopyHostExecutionSchema.safeParse({ childEnvironment });
  if (!parsed.success) throw new DaemonGitEnvironmentError();
  return parsed.data;
}
