import type { Plugin, UserConfig } from 'vite';

export const workspaceCommonjsOptions: NonNullable<
  NonNullable<UserConfig['build']>['commonjsOptions']
>;

export function assertNoWorkspaceImports(
  code: string,
  fileName: string,
  parse: (code: string) => unknown,
): void;

export function workspaceBundleGuardPlugin(): Plugin;
