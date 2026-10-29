/**
 * Adapted from https://github.com/vercel-labs/skills
 * Original source: MIT License
 * https://github.com/vercel-labs/skills/blob/main/src/skills.ts
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { AvailableSkill } from '@canopy/desktop-shared/types/skills';
import { httpsGet } from '../lib/http';
import { parseFrontmatter } from '../lib/frontmatter';
import {
  getBundledGhBinaryPath,
  getEnhancedEnv,
} from '../pipelines/config-paths';

const execFileAsync = promisify(execFile);

interface GitHubTreeEntry {
  path: string;
  mode: string;
  type: string;
  sha: string;
  size?: number;
}

interface GitHubTreeResponse {
  sha: string;
  tree: GitHubTreeEntry[];
  truncated: boolean;
}

interface SkillFrontmatter {
  name?: string;
  description?: string;
  metadata?: Record<string, unknown>;
}

export async function getGitHubToken(): Promise<string | null> {
  // Check environment first
  const envToken = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (envToken) return envToken;

  try {
    const { stdout } = await execFileAsync(
      getBundledGhBinaryPath(),
      ['auth', 'token'],
      {
        timeout: 5000,
        env: getEnhancedEnv({
          includeCanopySecrets: false,
          environment: false,
        }),
        windowsHide: process.platform === 'win32',
      },
    );
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Fetch the full tree listing for a GitHub repo at a specific branch.
 * Tries the given branch, then falls back to `main` and `master`.
 */
export async function fetchGitHubTree(
  owner: string,
  repo: string,
  token: string | null,
  branch?: string,
): Promise<{
  tree: GitHubTreeEntry[];
  resolvedBranch: string;
  treeSha: string;
}> {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
  };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const branches = branch ? [branch] : ['main', 'master'];
  let lastError: Error | null = null;

  for (const b of branches) {
    try {
      const url = `https://api.github.com/repos/${owner}/${repo}/git/trees/${b}?recursive=1`;
      const body = await httpsGet(url, { headers });
      const data = JSON.parse(body) as GitHubTreeResponse;
      return { tree: data.tree, resolvedBranch: b, treeSha: data.sha };
    } catch (err) {
      lastError = err as Error;
    }
  }

  throw lastError || new Error(`Could not fetch tree for ${owner}/${repo}`);
}

/**
 * Discover available skills from a GitHub repository by fetching its
 * file tree and reading SKILL.md frontmatter.
 */
export async function discoverSkillsFromGitHub(
  owner: string,
  repo: string,
  branch?: string,
  subPath?: string,
): Promise<{
  skills: AvailableSkill[];
  resolvedBranch: string;
  hasMarketplace: boolean;
}> {
  const token = await getGitHubToken();
  const { tree, resolvedBranch } = await fetchGitHubTree(
    owner,
    repo,
    token,
    branch,
  );

  // Check if the repo uses marketplace format
  const hasMarketplace = tree.some((entry) => {
    if (entry.type !== 'blob') return false;
    return (
      entry.path === '.claude-plugin/marketplace.json' ||
      entry.path.endsWith('/.claude-plugin/marketplace.json')
    );
  });

  // Find all SKILL.md files in the tree
  const skillMdEntries = tree.filter((entry) => {
    if (entry.type !== 'blob') return false;
    const name = entry.path.split('/').pop();
    if (name !== 'SKILL.md') return false;
    if (subPath && !entry.path.startsWith(subPath + '/')) return false;
    return true;
  });

  const rawHeaders: Record<string, string> = {};
  if (token) rawHeaders['Authorization'] = `Bearer ${token}`;

  // Fetch and parse each SKILL.md
  const skills: AvailableSkill[] = [];
  const seenNames = new Set<string>();

  for (const entry of skillMdEntries) {
    try {
      const rawUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${resolvedBranch}/${entry.path}`;
      const content = await httpsGet(rawUrl, { headers: rawHeaders });
      const frontmatter = parseFrontmatter<SkillFrontmatter>(content);

      if (!frontmatter?.name || !frontmatter?.description) continue;

      // Filter internal skills
      if (
        frontmatter.metadata &&
        frontmatter.metadata['internal'] === true &&
        !process.env.INSTALL_INTERNAL_SKILLS
      ) {
        continue;
      }

      // Deduplicate by name
      const name = frontmatter.name;
      if (seenNames.has(name)) continue;
      seenNames.add(name);

      // sourcePath is the directory containing SKILL.md
      const parts = entry.path.split('/');
      parts.pop(); // remove SKILL.md
      const sourcePath = parts.join('/') || '.';

      skills.push({
        name,
        description: frontmatter.description,
        sourcePath,
      });
    } catch {
      // Skip skills that fail to fetch/parse
    }
  }

  return { skills, resolvedBranch, hasMarketplace };
}
