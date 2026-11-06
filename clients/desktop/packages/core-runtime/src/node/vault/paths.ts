import { isAbsolute, join } from 'node:path';

/** The host supplies its build-specific secure root. */
export function resolveDaemonVaultFolder(secureDataRoot: string): string {
  if (!isAbsolute(secureDataRoot))
    throw new TypeError('The vault secure root must be absolute.');
  return join(secureDataRoot, 'vault');
}
