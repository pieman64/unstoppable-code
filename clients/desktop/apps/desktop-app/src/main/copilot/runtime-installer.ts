import type { CopilotRuntimeArtifact } from '@canopy/desktop-shared/node/copilot/runtime-metadata';
import { ManagedRuntimeInstaller } from '../lib/managed-runtime-installer';

export class CopilotRuntimeInstaller extends ManagedRuntimeInstaller {
  constructor(options: {
    root: string;
    artifact: CopilotRuntimeArtifact;
    executableName: 'copilot' | 'copilot.exe';
    fetchArchive?: typeof fetch;
    allowLoopback?: boolean;
  }) {
    super({ ...options, label: 'Copilot' });
  }
}
