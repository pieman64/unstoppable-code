export {
  LINUX_SYSTEM_GIT_PATH,
  MAC_COMMAND_LINE_TOOLS_GIT_PATH,
  MAC_HOMEBREW_GIT_PATHS,
  getLinuxGitCandidates,
  getMacGitCandidates,
  getWindowsGitCandidates,
  isMacGitShim,
  parseGitVersion,
  parseWhereExeOutput,
  type GitCandidatePaths,
  type LinuxGitCandidate,
} from '@canopy/protocol/git-executable';

export function getGitExecutableCommand(
  environment: Readonly<Record<string, string | undefined>>,
): string {
  return environment.CANOPY_GIT_EXECUTABLE?.trim() || 'git';
}
