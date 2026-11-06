import { mkdir, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { daemonCredentialRoute } from '../canopy-runtime/daemon-credential-route';
import { legacyPatCiphertextGeneration } from '@canopy/core-runtime/node/vault';
import { getGitHubPatFilePath, getLegacyGitHubPatFilePath } from './paths';
import { getSecretStoragePolicy } from './secure-storage-policy';
import { isMissingFileError } from './fs-utils';
import { writeFileAtomically } from './atomic-file';

export async function saveGitHubPat(token: string): Promise<void> {
  const filePath = getGitHubPatFilePath();

  if (!token) {
    await rm(getLegacyGitHubPatFilePath(), { force: true }).catch(
      (error: unknown) => {
        if (!isMissingFileError(error)) throw error;
      },
    );
    try {
      await rm(filePath);
    } catch (error) {
      if (!isMissingFileError(error)) throw error;
    }
    void daemonCredentialRoute.writeThrough('');
    return;
  }

  const encrypted = getSecretStoragePolicy().encrypt(token);
  await mkdir(dirname(filePath), { recursive: true });
  getSecretStoragePolicy().assertCanWrite();
  await writeFileAtomically(filePath, encrypted, { mode: 0o600 });
  const generation = legacyPatCiphertextGeneration(encrypted);
  await rm(getLegacyGitHubPatFilePath(), { force: true }).catch(
    () => undefined,
  );
  void daemonCredentialRoute.writeThrough(token, generation);
}
