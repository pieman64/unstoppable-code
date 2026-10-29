/**
 * Adapted from https://github.com/vercel-labs/skills
 * Original source: MIT License
 * https://github.com/vercel-labs/skills/blob/main/src/skill-lock.ts
 */

import * as fs from 'fs';
import * as path from 'path';
import type {
  SkillLockFile,
  SkillLockEntry,
  SourceMetadata,
} from '@canopy/desktop-shared/types/skills';
import {
  getSkillsLockFilePath,
  getSkillsRootDir,
  getSourceDir,
  getSourceMetadataPath,
  getSkillDir,
  deriveSourceId,
} from './paths';
import { fetchGitHubTree, getGitHubToken } from './skill-discovery';

const LOCK_VERSION = 2;

function defaultLockFile(): SkillLockFile {
  return { version: LOCK_VERSION, skills: {} };
}

// ---------------------------------------------------------------------------
// Composite lock-key helpers
// ---------------------------------------------------------------------------

export function getLockKey(sourceId: string, skillName: string): string {
  return `${sourceId}/${skillName}`;
}

export function parseLockKey(key: string): {
  sourceId: string;
  skillName: string;
} {
  const lastSlash = key.lastIndexOf('/');
  if (lastSlash === -1) {
    throw new Error(`Invalid lock key (no separator): ${key}`);
  }
  return {
    sourceId: key.substring(0, lastSlash),
    skillName: key.substring(lastSlash + 1),
  };
}

// ---------------------------------------------------------------------------
// v1 → v2 migration
// ---------------------------------------------------------------------------

function writeSourceMetadata(sourceId: string, metadata: SourceMetadata): void {
  const dir = getSourceDir(sourceId);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const filePath = getSourceMetadataPath(sourceId);
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, JSON.stringify(metadata, null, 2), 'utf-8');
  }
}

function migrateSkillDirectories(
  v1Lock: SkillLockFile,
): Record<string, SkillLockEntry> {
  const rootDir = getSkillsRootDir();
  const newSkills: Record<string, SkillLockEntry> = {};

  // Group entries by sourceId so we write source.json once per source
  const sourcesSeen = new Set<string>();

  for (const [skillName, entry] of Object.entries(v1Lock.skills)) {
    // Reject skill names with path separators or traversal segments
    if (
      skillName.includes('/') ||
      skillName.includes('\\') ||
      skillName === '..' ||
      skillName.includes('..' + path.sep)
    ) {
      continue;
    }

    const sourceId = deriveSourceId(entry.sourceType, entry.source);
    const newKey = getLockKey(sourceId, skillName);

    // Move skill directory from flat to nested
    const oldDir = path.join(rootDir, skillName);
    const newDir = getSkillDir(sourceId, skillName);

    if (fs.existsSync(oldDir) && !fs.existsSync(newDir)) {
      const sourceDir = getSourceDir(sourceId);
      if (!fs.existsSync(sourceDir)) {
        fs.mkdirSync(sourceDir, { recursive: true });
      }
      fs.renameSync(oldDir, newDir);
    }

    // Write source.json once per source
    if (!sourcesSeen.has(sourceId)) {
      sourcesSeen.add(sourceId);
      const metadata: SourceMetadata = {
        type: entry.sourceType,
        sourceId,
        url: entry.sourceUrl,
      };
      if (entry.sourceType === 'github') {
        const [owner, repo] = entry.source.split('/');
        metadata.owner = owner;
        metadata.repo = repo;
      }
      writeSourceMetadata(sourceId, metadata);
    }

    newSkills[newKey] = { ...entry, sourceId };
  }

  return newSkills;
}

// ---------------------------------------------------------------------------
// Read / Write
// ---------------------------------------------------------------------------

export function readLockFile(): SkillLockFile {
  const filePath = getSkillsLockFilePath();
  try {
    if (!fs.existsSync(filePath)) return defaultLockFile();
    const raw = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw) as SkillLockFile;
    if (typeof parsed.skills !== 'object') return defaultLockFile();

    // Auto-migrate v1 → v2
    if (parsed.version === 1) {
      const newSkills = migrateSkillDirectories(parsed);
      const migrated: SkillLockFile = {
        version: LOCK_VERSION,
        skills: newSkills,
      };
      writeLockFile(migrated);
      return migrated;
    }

    if (parsed.version !== LOCK_VERSION) return defaultLockFile();
    return parsed;
  } catch {
    return defaultLockFile();
  }
}

export function writeLockFile(lock: SkillLockFile): void {
  const filePath = getSkillsLockFilePath();
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  // Sort skills alphabetically for clean diffs
  const sorted: Record<string, SkillLockEntry> = {};
  for (const key of Object.keys(lock.skills).sort()) {
    sorted[key] = lock.skills[key];
  }
  const output: SkillLockFile = { version: lock.version, skills: sorted };
  // Atomic write: write to temp file then rename (atomic on POSIX same-filesystem)
  const tmpPath = filePath + '.tmp';
  fs.writeFileSync(tmpPath, JSON.stringify(output, null, 2) + '\n', 'utf-8');
  fs.renameSync(tmpPath, filePath);
}

// ---------------------------------------------------------------------------
// Entry management
// ---------------------------------------------------------------------------

export function addLockEntry(
  sourceId: string,
  skillName: string,
  entry: SkillLockEntry,
): void {
  const lock = readLockFile();
  lock.skills[getLockKey(sourceId, skillName)] = entry;
  writeLockFile(lock);
}

export function removeLockEntry(sourceId: string, skillName: string): void {
  const lock = readLockFile();
  delete lock.skills[getLockKey(sourceId, skillName)];
  writeLockFile(lock);
}

// ---------------------------------------------------------------------------
// GitHub tree SHA helpers
// ---------------------------------------------------------------------------

/**
 * Fetch the current tree SHA for a skill's folder from GitHub.
 * Returns null if the folder cannot be found.
 */
export async function fetchSkillFolderHash(
  owner: string,
  repo: string,
  skillPath: string,
  branch?: string,
): Promise<string | null> {
  try {
    const token = await getGitHubToken();
    const { tree, treeSha } = await fetchGitHubTree(owner, repo, token, branch);

    // Root-level skills ('.' or '') use the root tree SHA
    if (!skillPath || skillPath === '.') {
      return treeSha ?? null;
    }

    // Look for the tree entry matching the skill folder path
    const entry = tree.find((e) => e.type === 'tree' && e.path === skillPath);

    return entry?.sha ?? null;
  } catch {
    return null;
  }
}

/**
 * Check whether a specific installed skill has an available update
 * by comparing the stored hash against the current GitHub tree SHA.
 */
export async function checkForUpdate(
  _skillName: string,
  entry: SkillLockEntry,
): Promise<boolean> {
  const [owner, repo] = entry.source.split('/');
  if (!owner || !repo) return false;

  const currentHash = await fetchSkillFolderHash(owner, repo, entry.skillPath);

  if (!currentHash) return false;
  return currentHash !== entry.skillFolderHash;
}

// ---------------------------------------------------------------------------
// Directory scanning
// ---------------------------------------------------------------------------

/**
 * Get the list of installed skill directories, scanning source subdirectories.
 */
export function getInstalledSkillDirs(): Array<{
  sourceId: string;
  skillName: string;
  fullPath: string;
}> {
  const rootDir = getSkillsRootDir();
  if (!fs.existsSync(rootDir)) return [];

  try {
    const results: Array<{
      sourceId: string;
      skillName: string;
      fullPath: string;
    }> = [];

    const sourceDirs = fs
      .readdirSync(rootDir, { withFileTypes: true })
      .filter((d) => d.isDirectory());

    for (const sourceDir of sourceDirs) {
      const sourceId = sourceDir.name;
      const sourcePath = path.join(rootDir, sourceId);
      const skillDirs = fs
        .readdirSync(sourcePath, { withFileTypes: true })
        .filter((d) => d.isDirectory());

      for (const skillDir of skillDirs) {
        results.push({
          sourceId,
          skillName: skillDir.name,
          fullPath: path.join(sourcePath, skillDir.name),
        });
      }
    }

    return results;
  } catch {
    return [];
  }
}
