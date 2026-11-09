import { existsSync } from 'node:fs';
import { resolveWindowsGitBash as resolveGitBash } from '@canopy/core-platform/windows-shells';

export function resolveWindowsGitBash(
  environment: NodeJS.ProcessEnv = process.env,
  fileExists: (filePath: string) => boolean = existsSync,
): string | null {
  return resolveGitBash(environment, fileExists);
}
