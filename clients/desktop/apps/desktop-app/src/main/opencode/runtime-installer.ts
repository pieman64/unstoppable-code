import type { OpenCodeRuntimeArtifact } from '@canopy/desktop-shared/node/opencode/runtime-metadata';
import { ManagedRuntimeInstaller } from '../lib/managed-runtime-installer';

export class OpenCodeRuntimeInstaller extends ManagedRuntimeInstaller {
  constructor(options: {
    root: string;
    artifact: OpenCodeRuntimeArtifact;
    executableName: 'opencode' | 'opencode.exe';
    fetchArchive?: typeof fetch;
    allowLoopback?: boolean;
  }) {
    super({
      ...options,
      label: 'OpenCode',
      archivePath: `package/bin/${options.executableName}`,
    });
  }
}
