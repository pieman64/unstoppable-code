import { lstat, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  CodexSelectedCapabilityRoot,
  SlashCommandData,
} from '@canopy/desktop-shared/types';
import type { DiscoveryResult } from './sdk-discovery';
import { parseSkillsListPayload } from '../codex/app-server-client';
import { parseFrontmatter } from '../lib/frontmatter';
import { getCodexRuntimeService } from '../codex/runtime-service';
import { resolveCodexRuntimeEnvironmentProfile } from '../lib/user-environment-runtime';

const DEFAULT_TIMEOUT_MS = 30_000;
const EMPTY_MCP_CONFIG_ARGS = ['-c', 'mcp_servers={}'];

interface CodexSkillFrontmatter {
  name?: unknown;
  description?: unknown;
  'user-invocable'?: unknown;
}

async function readSelectedRootSkills(
  root: CodexSelectedCapabilityRoot,
): Promise<SlashCommandData[]> {
  const rootPath = root.location.path.startsWith('file:')
    ? fileURLToPath(root.location.path)
    : root.location.path;
  const manifestPath = join(rootPath, '.codex-plugin', 'plugin.json');
  const manifestStat = await lstat(manifestPath);
  if (!manifestStat.isFile() || manifestStat.isSymbolicLink()) {
    return [];
  }
  const manifest: unknown = JSON.parse(await readFile(manifestPath, 'utf8'));
  const manifestName: unknown =
    typeof manifest === 'object' && manifest !== null
      ? Reflect.get(manifest, 'name')
      : undefined;
  const pluginName =
    typeof manifestName === 'string' ? manifestName.trim() : '';
  if (!pluginName) {
    return [];
  }

  const skillsPath = join(rootPath, 'skills');
  const skillsStat = await lstat(skillsPath);
  if (!skillsStat.isDirectory() || skillsStat.isSymbolicLink()) {
    return [];
  }

  const commands: SlashCommandData[] = [];
  const entries = await readdir(skillsPath, { withFileTypes: true });
  for (const entry of entries.sort((left, right) =>
    left.name.localeCompare(right.name),
  )) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      continue;
    }
    try {
      const skillPath = join(skillsPath, entry.name, 'SKILL.md');
      const skillStat = await lstat(skillPath);
      if (!skillStat.isFile() || skillStat.isSymbolicLink()) {
        continue;
      }
      const frontmatter = parseFrontmatter<CodexSkillFrontmatter>(
        await readFile(skillPath, 'utf8'),
      );
      if (frontmatter?.['user-invocable'] === false) {
        continue;
      }
      const skillName =
        typeof frontmatter?.name === 'string' && frontmatter.name.trim()
          ? frontmatter.name.trim()
          : entry.name;
      const qualifiedName = `${pluginName}:${skillName}`;
      commands.push({
        name: qualifiedName,
        description:
          typeof frontmatter?.description === 'string'
            ? frontmatter.description
            : '',
        displayName: `$${qualifiedName}`,
        insertText: `$${qualifiedName} `,
      });
    } catch {
      // A malformed skill must not hide the other selected capabilities.
    }
  }
  return commands;
}

/**
 * Selected capability roots are thread-scoped and intentionally are not
 * installed into the canonical Codex home. Read their immutable manifests
 * directly so the slash menu reflects the exact capabilities selected for the
 * tab, even when the global app-server skill catalog is unavailable.
 */
export async function discoverSelectedCodexCapabilityRootSkills(
  roots: CodexSelectedCapabilityRoot[],
): Promise<SlashCommandData[]> {
  const results = await Promise.all(
    roots.map((root) => readSelectedRootSkills(root).catch(() => [])),
  );
  const commands = new Map<string, SlashCommandData>();
  for (const command of results.flat()) {
    commands.set(command.name, command);
  }
  return Array.from(commands.values());
}

export async function discoverCodexWorktreeEnvironment(options: {
  cwd: string;
  projectId: string;
  worktreeId: string;
  chatId: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  extraEnv?: Record<string, string>;
  selectedCapabilityRoots?: CodexSelectedCapabilityRoot[];
  strictEmptyMcpConfig?: boolean;
  safeProjectDiscovery?: boolean;
}): Promise<DiscoveryResult> {
  const selectedSlashCommands = await discoverSelectedCodexCapabilityRootSkills(
    options.selectedCapabilityRoots ?? [],
  );
  const workspaceEnvironment = options.safeProjectDiscovery
    ? {
        environment: {},
        logicalWorkspaceEnvironmentId: 'safe-project-discovery',
      }
    : resolveCodexRuntimeEnvironmentProfile({
        runtime: 'agent',
        workspaceId: options.projectId,
      });
  const profile = {
    environment: {
      ...workspaceEnvironment.environment,
      ...(options.extraEnv ?? {}),
    },
    logicalWorkspaceEnvironmentId:
      workspaceEnvironment.logicalWorkspaceEnvironmentId,
    ...(workspaceEnvironment.secretVersionFingerprint
      ? {
          secretVersionFingerprint:
            workspaceEnvironment.secretVersionFingerprint,
        }
      : {}),
    ...(options.strictEmptyMcpConfig
      ? { configArgs: EMPTY_MCP_CONFIG_ARGS }
      : {}),
    ...(options.safeProjectDiscovery ? { includeCanopySecrets: false } : {}),
  };

  let abortListener: (() => void) | undefined;
  let timerId: ReturnType<typeof setTimeout> | undefined;
  try {
    const abortPromise = new Promise<never>((_, reject) => {
      if (options.signal?.aborted) {
        reject(new Error('Discovery aborted'));
        return;
      }

      abortListener = (): void => {
        reject(new Error('Discovery aborted'));
      };
      options.signal?.addEventListener('abort', abortListener, { once: true });
    });

    const timeoutPromise = new Promise<never>((_, reject) => {
      timerId = setTimeout(
        () => reject(new Error('Discovery timed out')),
        options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      );
    });

    let globalSlashCommands: SlashCommandData[];
    try {
      globalSlashCommands = await Promise.race([
        getCodexRuntimeService()
          .admin()
          .request(
            'skills/list',
            { cwds: [options.cwd], forceReload: true },
            profile,
          )
          .then((response) => {
            const parsed = parseSkillsListPayload(response);
            if (!parsed) {
              throw new Error(
                'Codex app-server returned an invalid skills payload',
              );
            }
            return parsed;
          }),
        abortPromise,
        timeoutPromise,
      ]);
    } catch (error) {
      if (selectedSlashCommands.length === 0 || options.signal?.aborted) {
        throw error;
      }
      globalSlashCommands = [];
    }

    const slashCommands = new Map<string, SlashCommandData>();
    for (const command of globalSlashCommands) {
      slashCommands.set(command.name, command);
    }
    for (const command of selectedSlashCommands) {
      slashCommands.set(command.name, command);
    }

    return {
      slashCommands: Array.from(slashCommands.values()),
      mcpServers: [],
    };
  } finally {
    if (abortListener) {
      options.signal?.removeEventListener('abort', abortListener);
    }
    if (timerId !== undefined) {
      clearTimeout(timerId);
    }
  }
}
