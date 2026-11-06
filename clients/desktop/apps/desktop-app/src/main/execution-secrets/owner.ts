import { ExecutionSecretGrants } from '@canopy/core-runtime/node/execution-secrets';
import { desktopExecutionSecretReader } from './reader';

let grants: ExecutionSecretGrants | null = null;

/** The desktop's execution secret grants; Electron main is the owner until V6. */
export function getDesktopExecutionSecrets(): ExecutionSecretGrants {
  return (grants ??= new ExecutionSecretGrants({
    reader: desktopExecutionSecretReader,
  }));
}

export function resetDesktopExecutionSecretsForTests(): void {
  if (process.env.NODE_ENV !== 'test')
    throw new Error('Only tests may reset execution secrets.');
  grants?.revokeAll();
  grants = null;
}
