import { existsSync } from 'node:fs';
import path from 'node:path';
import {
  getBundledBinDir,
  listMissingBundledBinaries,
  type BundledBinaryMember,
} from '@canopy/desktop-shared/pipelines/config-paths';

export function getBundledDelegationFileBrokerPath(): string {
  const binDir = getBundledBinDir();
  const executable = `canopy-file-broker${process.platform === 'win32' ? '.exe' : ''}`;
  return binDir ? path.join(binDir, executable) : executable;
}

/** Shared promised members plus the desktop-only delegation file broker. */
export type DesktopBundledBinaryMember =
  | BundledBinaryMember
  | 'canopy-file-broker';

export interface MissingDesktopBundledBinary {
  member: DesktopBundledBinaryMember;
  path: string;
}

/** Promised desktop bundle members whose staged file is absent. */
export function listMissingDesktopBundledBinaries(): MissingDesktopBundledBinary[] {
  const missing: MissingDesktopBundledBinary[] =
    listMissingBundledBinaries().map(({ member, path: expectedPath }) => ({
      member,
      path: expectedPath,
    }));
  const fileBrokerPath = getBundledDelegationFileBrokerPath();
  if (getBundledBinDir() && !existsSync(fileBrokerPath)) {
    missing.push({ member: 'canopy-file-broker', path: fileBrokerPath });
  }
  return missing;
}

export {
  getBundledActionsDir,
  getBundledBinDir,
  getBundledCanopyCliPath,
  getBundledClaudeBinaryPath,
  getBundledClaudePluginMarketplaceManifestPath,
  getBundledCodexPluginMarketplaceManifestPath,
  getBundledCodexBinaryPath,
  getBundledCodexCodeModeHostPath,
  getBundledGhBinaryPath,
  getBundledPluginsDir,
  getBundledRtkBinaryPath,
  getBundledRgBinaryPath,
  getBundledPipelinesDir,
  getBundledSkillDir,
  getBundledSkillsDir,
  getEnhancedEnv,
  getLoginShellPath,
  getProjectActionsDir,
  getProjectActionsDirCandidates,
  getProjectPipelinesDir,
  getProjectPipelinesDirCandidates,
  getRtkDataDir,
  getRtkDbPath,
  getRtkManagedEnv,
  getRtkTeeDir,
  getUserPipelineIndexPath,
  getUserPipelinesDir,
  hasBundledPlugins,
  registerSecretsEnvInjector,
  registerUserEnvironmentInjector,
  resetLoginShellPathCache,
} from '@canopy/desktop-shared/pipelines/config-paths';
