/**
 * Adapted from https://github.com/vercel-labs/skills
 * Original source: MIT License
 * https://github.com/vercel-labs/skills/blob/main/src/installer.ts
 */

import * as fs from 'fs';
import * as path from 'path';
import type { AvailableSkill } from '@canopy/desktop-shared/types/skills';
import { httpsGetBuffer } from '../lib/http';
import { isPathInside } from '../lib/path-safety';

/** Files excluded during installation */
const EXCLUDE_FILES = new Set(['metadata.json']);

/**
 * Sanitize a skill name for use as a directory name.
 * Lowercases, replaces non-safe characters with hyphens, and caps at 255 chars.
 */
export function sanitizeName(name: string): string {
  const sanitized = name
    .toLowerCase()
    .replace(/[^a-z0-9._]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[.\-]+|[.\-]+$/g, '');
  return sanitized.substring(0, 255) || 'unnamed-skill';
}

function isExcluded(name: string, isDirectory: boolean): boolean {
  return (
    EXCLUDE_FILES.has(name) ||
    name.startsWith('_') ||
    (isDirectory && name === '.git')
  );
}

interface TreeEntry {
  path: string;
  type: string;
}

/**
 * Install a skill by downloading its files from GitHub and writing them
 * to `{outputDir}/{sanitizedName}/`.
 *
 * @param owner - GitHub repo owner
 * @param repo - GitHub repo name
 * @param branch - Branch to fetch from
 * @param skill - The skill to install (with sourcePath from discovery)
 * @param treeEntries - Full tree listing from the GitHub Trees API
 * @param sourceDir - Source-specific directory (e.g. {userData}/skills/{sourceId}/)
 * @param token - GitHub auth token (optional)
 */
export async function installSkill(
  owner: string,
  repo: string,
  branch: string,
  skill: AvailableSkill,
  treeEntries: TreeEntry[],
  sourceDir: string,
  token: string | null,
): Promise<void> {
  const sanitized = sanitizeName(skill.name);
  const skillDir = path.join(sourceDir, sanitized);

  if (!isPathInside(sourceDir, skillDir)) {
    throw new Error(`Unsafe skill directory path: ${skillDir}`);
  }

  // Clean existing directory if present, then create fresh
  if (fs.existsSync(skillDir)) {
    fs.rmSync(skillDir, { recursive: true, force: true });
  }
  fs.mkdirSync(skillDir, { recursive: true });

  // Find all files under this skill's source path
  const prefix = skill.sourcePath === '.' ? '' : skill.sourcePath + '/';
  const skillFiles = treeEntries.filter((entry) => {
    if (entry.type !== 'blob') return false;
    if (prefix && !entry.path.startsWith(prefix)) return false;
    if (!prefix && entry.path.includes('/')) {
      // When sourcePath is root, include all files — file-level exclusion
      // checks below (isExcluded, isPathInside) handle .git, underscored dirs, etc.
      return true;
    }
    return true;
  });

  const headers: Record<string, string> = {};
  if (token) headers['Authorization'] = `Bearer ${token}`;

  for (const fileEntry of skillFiles) {
    // Compute relative path within the skill directory
    const relativePath = prefix
      ? fileEntry.path.substring(prefix.length)
      : fileEntry.path;

    // Check exclusions
    const fileName = path.basename(relativePath);
    const dirName = path.dirname(relativePath);
    if (isExcluded(fileName, false)) continue;
    if (dirName.split('/').some((segment) => isExcluded(segment, true))) {
      continue;
    }

    const targetPath = path.join(skillDir, relativePath);
    if (!isPathInside(skillDir, targetPath)) continue;

    // Ensure parent directory exists
    const parentDir = path.dirname(targetPath);
    fs.mkdirSync(parentDir, { recursive: true });

    // Download and write file
    const rawUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${fileEntry.path}`;
    const content = await httpsGetBuffer(rawUrl, { headers });
    fs.writeFileSync(targetPath, content);
  }
}
