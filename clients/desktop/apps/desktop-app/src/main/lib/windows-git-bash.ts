import path from 'node:path';
import { existsSync } from 'node:fs';

type FileExists = (filePath: string) => boolean;

function firstExistingFile(
  candidates: Array<string | null | undefined>,
  fileExists: FileExists,
): string | null {
  for (const candidate of candidates) {
    if (!candidate) continue;
    if (fileExists(candidate)) {
      return candidate;
    }
  }
  return null;
}

export function getCommonWindowsGitBashPaths(
  environment: NodeJS.ProcessEnv = process.env,
): string[] {
  const programFiles = environment.ProgramFiles;
  const programFilesX86 = environment['ProgramFiles(x86)'];
  const localAppData = environment.LOCALAPPDATA;
  return [programFiles, programFilesX86, localAppData]
    .filter(
      (value): value is string => typeof value === 'string' && value.length > 0,
    )
    .flatMap((base) => [
      path.win32.join(base, 'Git', 'bin', 'bash.exe'),
      path.win32.join(base, 'Programs', 'Git', 'bin', 'bash.exe'),
    ]);
}

export function resolveGitBashFromGitExecutable(
  gitExecutable: string,
  fileExists: FileExists = existsSync,
): string | null {
  const normalized = path.win32.normalize(gitExecutable);
  const parent = path.win32
    .basename(path.win32.dirname(normalized))
    .toLowerCase();
  if (parent !== 'cmd' && parent !== 'bin') {
    return null;
  }
  const gitRoot = path.win32.dirname(path.win32.dirname(normalized));
  return firstExistingFile(
    [path.win32.join(gitRoot, 'bin', 'bash.exe')],
    fileExists,
  );
}

export function resolveWindowsGitBash(
  environment: NodeJS.ProcessEnv = process.env,
  fileExists: FileExists = existsSync,
): string | null {
  const gitExecutable = environment.CANOPY_GIT_EXECUTABLE?.trim();
  return (
    (gitExecutable
      ? resolveGitBashFromGitExecutable(gitExecutable, fileExists)
      : null) ??
    firstExistingFile(getCommonWindowsGitBashPaths(environment), fileExists)
  );
}
