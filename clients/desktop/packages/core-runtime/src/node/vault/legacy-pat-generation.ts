import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { GitHubCredentialIdentity } from './github-credential-authority';

export function legacyPatCiphertextGeneration(ciphertext: Uint8Array): string {
  return createHash('sha256').update(ciphertext).digest('hex');
}

/** Never decrypts or mutates the source. Read errors stop lookup, not fall through. */
export function createLegacyPatGenerationReader(options: {
  readonly identity: GitHubCredentialIdentity;
  readonly paths: readonly string[];
}): (source: GitHubCredentialIdentity) => Promise<string | null> {
  const identity = { ...options.identity };
  const paths = [...options.paths];
  return async (source): Promise<string | null> => {
    if (
      !identity.brandId ||
      !identity.build ||
      source.brandId !== identity.brandId ||
      source.build !== identity.build
    )
      throw new Error('Legacy credential identity mismatch.');
    for (const path of paths) {
      try {
        return legacyPatCiphertextGeneration(await readFile(path));
      } catch (error) {
        if (
          typeof error !== 'object' ||
          error === null ||
          !('code' in error) ||
          error.code !== 'ENOENT'
        )
          throw new Error('Legacy generation unavailable.');
      }
    }
    return null;
  };
}
