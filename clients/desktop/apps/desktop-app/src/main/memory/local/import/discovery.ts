import { readdir, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import {
  claudeProjectDirCandidates,
  getClaudeCodeProjectsDir,
} from '../../../lib/claude-project-paths';
import { resolveCodexMemoryHome } from './codex-home';

export const CLAUDE_MEMORY_MAX_FILE_BYTES = 4 * 1024 * 1024;

export interface LocalMemorySourceFile {
  sourcePath: string;
  originalName: string;
  size: number;
  modifiedAt: Date;
}

export interface LocalMemoryDiscoveryResult {
  sourceDir: string | null;
  files: LocalMemorySourceFile[];
  oversizeFiles: string[];
}

export type ClaudeMemorySourceFile = LocalMemorySourceFile;
export type ClaudeMemoryDiscoveryResult = LocalMemoryDiscoveryResult;
export type CodexMemoryDiscoveryResult = LocalMemoryDiscoveryResult;

function isNodeError(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === code
  );
}

async function firstExistingMemoryDir(
  repoPath: string,
): Promise<string | null> {
  const projectsDir = getClaudeCodeProjectsDir();
  for (const candidate of await claudeProjectDirCandidates(repoPath)) {
    const memoryDir = join(projectsDir, candidate, 'memory');
    try {
      const info = await stat(memoryDir);
      if (info.isDirectory()) {
        return memoryDir;
      }
    } catch (error) {
      if (!isNodeError(error, 'ENOENT')) {
        throw error;
      }
    }
  }
  return null;
}

async function supportedSourcePaths(memoryDir: string): Promise<string[]> {
  const paths = [join(memoryDir, 'MEMORY.md')];
  const topicsDir = join(memoryDir, 'topics');
  try {
    const entries = await readdir(topicsDir, { withFileTypes: true });
    paths.push(
      ...entries
        .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
        .map((entry) => join(topicsDir, entry.name))
        .sort((left, right) => left.localeCompare(right)),
    );
  } catch (error) {
    if (!isNodeError(error, 'ENOENT')) {
      throw error;
    }
  }
  return paths;
}

async function discoverSupportedMemoryFiles(
  sourceDir: string,
  sourcePaths: readonly string[],
): Promise<LocalMemoryDiscoveryResult> {
  const files: LocalMemorySourceFile[] = [];
  const oversizeFiles: string[] = [];
  for (const sourcePath of sourcePaths) {
    let info;
    try {
      info = await stat(sourcePath);
    } catch (error) {
      if (isNodeError(error, 'ENOENT')) {
        continue;
      }
      throw error;
    }
    if (!info.isFile()) {
      continue;
    }
    if (info.size > CLAUDE_MEMORY_MAX_FILE_BYTES) {
      oversizeFiles.push(sourcePath);
      continue;
    }
    files.push({
      sourcePath,
      originalName: basename(sourcePath),
      size: info.size,
      modifiedAt: info.mtime,
    });
  }
  return { sourceDir, files, oversizeFiles };
}

export async function discoverClaudeMemoryFiles(
  repoPath: string,
): Promise<ClaudeMemoryDiscoveryResult> {
  const sourceDir = await firstExistingMemoryDir(repoPath);
  if (sourceDir === null) {
    return { sourceDir: null, files: [], oversizeFiles: [] };
  }

  return discoverSupportedMemoryFiles(
    sourceDir,
    await supportedSourcePaths(sourceDir),
  );
}

export async function discoverCodexMemoryFiles(
  codexHome?: string,
): Promise<CodexMemoryDiscoveryResult> {
  const sourceDir = join(
    codexHome ?? (await resolveCodexMemoryHome()),
    'memories',
  );
  try {
    const info = await stat(sourceDir);
    if (!info.isDirectory()) {
      return { sourceDir: null, files: [], oversizeFiles: [] };
    }
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) {
      return { sourceDir: null, files: [], oversizeFiles: [] };
    }
    throw error;
  }
  return discoverSupportedMemoryFiles(sourceDir, [
    join(sourceDir, 'MEMORY.md'),
    join(sourceDir, 'memory_summary.md'),
  ]);
}
