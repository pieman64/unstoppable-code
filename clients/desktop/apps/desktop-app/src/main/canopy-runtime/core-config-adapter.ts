import { CanopyOperationError } from '@canopy/core-runtime';
import { catalogContentRevision } from '@canopy/core-runtime/node/catalog';
import {
  CONFIG_GIT_NAMESPACE,
  ConfigGitValueSchema,
  type ConfigGitValue,
} from '@canopy/protocol/canopy-core';
import { resolvePrContentInstructions } from '@canopy/protocol/pull-requests';
import { resolveCommitMessageInstructions } from '@canopy/desktop-shared/lib/commit-message-generator';
import type { PreferencesData } from '@canopy/desktop-shared/types';
import type { DesktopDomainAdapter } from './desktop-runtime';

/** The reads behind `core.config.get`, one per served namespace; tests inject them. */
export interface CoreConfigHost {
  readGit(): Promise<ConfigGitValue>;
}

function sanitizeBranchPrefix(raw: string): string {
  return raw
    .trim()
    .replace(/\/+$/g, '')
    .replace(/[^A-Za-z0-9._-]/g, '');
}

/** The `git` namespace over Electron main's preferences and the GitHub CLI login. */
export async function projectGitPreferences(
  preferences: PreferencesData,
  githubUsername: () => Promise<string | null>,
): Promise<ConfigGitValue> {
  const prefixMode = preferences.branchNamePrefixMode;
  const sanitized =
    prefixMode === 'github'
      ? sanitizeBranchPrefix((await githubUsername()) ?? '')
      : prefixMode === 'custom'
        ? sanitizeBranchPrefix(preferences.branchNameCustomPrefix)
        : '';
  return {
    branchName: {
      instructions: preferences.branchNamingInstructions.trim(),
      prefixMode,
      prefix: sanitized.length > 0 ? `${sanitized}/` : null,
    },
    pullRequest: {
      instructions: resolvePrContentInstructions({
        instructions: preferences.prInstructions.trim(),
        instructionMode: preferences.prInstructionMode,
      }),
    },
    commitMessage: {
      instructions: resolveCommitMessageInstructions({
        instructions: preferences.commitInstructions.trim(),
        instructionMode: preferences.commitInstructionMode,
      }),
    },
  };
}

const desktopConfigHost: CoreConfigHost = {
  readGit: async () => {
    const { readPreferencesFile } = await import('../lib/preferences-store');
    return projectGitPreferences(
      await readPreferencesFile(),
      async () =>
        (await (await import('../lib/github-auth')).checkGitHubCliStatus())
          .username ?? null,
    );
  },
};

const notServed = (namespace: string): CanopyOperationError =>
  new CanopyOperationError({
    kind: 'not_found',
    message: `The ${namespace} namespace is not served.`,
    code: 'core.config.notFound',
    retry: { kind: 'never' },
  });

/** `core.config.get` on the desktop dispatcher (CAN-5992): read-only namespaces, global scope only. */
export function createCoreConfigAdapter(
  host: CoreConfigHost = desktopConfigHost,
): DesktopDomainAdapter {
  return {
    queries: {
      'core.config.get': async (params) => {
        if (params.namespace !== CONFIG_GIT_NAMESPACE)
          throw notServed(params.namespace);
        if (
          params.scope &&
          Object.values(params.scope).some((value) => value !== undefined)
        )
          throw new CanopyOperationError({
            kind: 'invalid_argument',
            message: 'Git preferences have no scope here.',
            retry: { kind: 'never' },
          });
        const value = ConfigGitValueSchema.parse(await host.readGit());
        return {
          namespace: CONFIG_GIT_NAMESPACE,
          scope: {},
          revision: catalogContentRevision(value),
          value,
          enforcedPaths: [],
        };
      },
    },
  };
}
